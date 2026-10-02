'use strict';

const fs = require('node:fs/promises');
const { constants, createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function validFileName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240
    && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
    && /\.mp4$/i.test(value);
}

function absoluteDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError('클립 폴더는 절대 경로여야 합니다.');
  }
  return path.resolve(value);
}

async function digest(file) {
  const info = await fs.stat(file);
  if (!info.isFile()) throw Object.assign(new Error('일반 클립 파일이 아닙니다.'), { code: 'EINVAL' });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function matchingDestination(file, hash) {
  try {
    // Never treat a symlink or a directory as a migrated clip.
    if (!(await fs.lstat(file)).isFile()) return false;
    return await digest(file) === hash;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function copyExclusive(source, target, hash, copyFileImpl) {
  const temporary = path.join(path.dirname(target), `.migration-${randomUUID()}.partial`);
  try {
    await copyFileImpl(source, temporary, constants.COPYFILE_EXCL);
    if (await digest(temporary) !== hash) {
      throw Object.assign(new Error('복사 중 원본 클립이 변경되었습니다.'), { code: 'ESTALE' });
    }
    try {
      // The link publishes a complete file without ever replacing an existing target.
      await fs.link(temporary, target);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
      await copyFileImpl(temporary, target, constants.COPYFILE_EXCL);
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function migrateFile(source, clipsDir, fileName, hash, copyFileImpl) {
  const extension = path.extname(fileName);
  // Bound the component length even when importing a long legacy filename.
  const stem = path.basename(fileName, extension).slice(0, 180);
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = attempt === 0 ? fileName
      : `${stem}_${hash.slice(0, 16)}${attempt === 1 ? '' : `-${attempt}`}${extension}`;
    const target = path.join(clipsDir, name);
    if (await matchingDestination(target, hash)) return name;
    try {
      await copyExclusive(source, target, hash, copyFileImpl);
      return name;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Another initializer may have just published the same file.
      if (await matchingDestination(target, hash)) return name;
    }
  }
  throw Object.assign(new Error('클립 파일 이름 충돌을 해결하지 못했습니다.'), { code: 'EEXIST' });
}

/**
 * Copy indexed clips to preferredClipsDir; never move/delete originals or write indexes.
 * Put the current preferred index first in sources to retain its metadata on duplicates.
 * Persist only clip metadata after this completes; keep generated storagePath/status
 * in memory for opening unmigrated clips. ready=false means new saves are unavailable.
 */
async function prepareClipStorage({ preferredClipsDir, sources = [], copyFileImpl = fs.copyFile }) {
  const clipsDir = absoluteDirectory(preferredClipsDir);
  const inputs = sources.map(source => ({ clipsDir: absoluteDirectory(source.clipsDir), clips: source.clips || [] }));
  const clips = [], warnings = [], entries = [], identities = new Map(), usedIds = new Map();
  const logicalOrder = new Map(), recordWarnings = new WeakMap();
  let ready = true;
  try { await fs.mkdir(clipsDir, { recursive: true }); }
  catch (error) { ready = false; warnings.push({ code: 'destination_unavailable', cause: error.code || 'UNKNOWN' }); }

  for (const input of inputs) {
    for (const original of input.clips) {
      const record = { ...original };
      // Paths persisted in an index are not trusted. Only supplied source directories
      // and validated basenames may determine the file copied or exposed to the shell.
      delete record.storagePath;
      delete record.storageStatus;
      let source, hash, identity;
      if (!original || typeof original !== 'object' || !validFileName(record.fileName)) {
        delete record.storagePath;
        record.storageStatus = 'invalid';
        recordWarnings.set(record, { code: 'invalid_file_name' });
        identity = `invalid:${JSON.stringify(original)}`;
      } else {
        source = path.join(input.clipsDir, record.fileName);
        try {
          hash = await digest(source);
          if (!ready) throw Object.assign(new Error('저장 폴더를 만들지 못했습니다.'), { code: 'EDESTINATION' });
          record.fileName = await migrateFile(source, clipsDir, record.fileName, hash, copyFileImpl);
          delete record.storagePath;
          delete record.storageStatus;
          identity = `content:${hash}`;
        } catch (error) {
          record.storagePath = source;
          record.storageStatus = error.code === 'ENOENT' ? 'missing' : 'unmigrated';
          recordWarnings.set(record, { code: record.storageStatus, cause: error.code || 'UNKNOWN' });
          identity = hash ? `content:${hash}` : `source:${source}`;
        }
      }

      const originalId = typeof record.originalId === 'string' && record.originalId
        ? record.originalId : (typeof record.id === 'string' && record.id ? record.id : 'legacy');
      const logicalKey = `${originalId}\0${original?.fileName}`;
      if (!logicalOrder.has(logicalKey)) logicalOrder.set(logicalKey, logicalOrder.size);
      if (!hash && record.storageStatus === 'missing') identity = `missing:${logicalKey}`;
      entries.push({ record, hash, identity, originalId, logicalKey });
    }
  }

  // The preferred and legacy indexes may describe the same clip. A missing file
  // in one candidate directory must not create a second record beside a real file.
  const available = new Set(entries.filter(entry => entry.hash).map(entry => entry.logicalKey));
  entries.sort((a, b) => logicalOrder.get(a.logicalKey) - logicalOrder.get(b.logicalKey));
  for (const { record, hash, identity, originalId, logicalKey } of entries) {
    if (!hash && record.storageStatus === 'missing' && available.has(logicalKey)) continue;
    const key = `${originalId}\0${identity}`;
    const previous = identities.get(key);
    if (previous !== undefined) {
      // If a later source succeeds, keep its usable location with the first source's metadata.
      if (clips[previous].storageStatus && !record.storageStatus) {
        const replacement = { ...record, ...clips[previous], fileName: record.fileName };
        delete replacement.storagePath;
        delete replacement.storageStatus;
        clips[previous] = replacement;
      }
      continue;
    }
    if (usedIds.has(originalId) && usedIds.get(originalId) !== identity) {
      record.originalId ??= originalId;
      record.id = `${originalId}-import-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
    } else if (!record.id) {
      record.id = `legacy-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
    }
    usedIds.set(record.id, identity);
    // Track the original ID too so different legacy entries cannot silently collapse.
    if (!usedIds.has(originalId)) usedIds.set(originalId, identity);
    identities.set(key, clips.length);
    clips.push(record);
  }
  for (const record of clips) {
    const warning = recordWarnings.get(record);
    if (warning) warnings.push({ id: record.id, ...warning });
  }
  return { clipsDir, clips, warnings, ready };
}

module.exports = { prepareClipStorage, validFileName };
