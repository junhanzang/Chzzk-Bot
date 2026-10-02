'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP_DIRECTORY = 'Chzzk Desk';
const CODEX_PACKAGE = /^OpenAI\.Codex_[^\\/]+$/i;
const PROFILE_MARKERS = new Set(['settings.json', 'clips.json']);

function missing(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

// Inspect metadata only. In particular, never open or copy browser cookies.
// Empty directories created during Electron startup are not established profiles.
function profileState(directory, io) {
  try {
    if (!io.statSync(directory).isDirectory()) return 'missing';
    const entries = io.readdirSync(directory, { withFileTypes: true });
    // A known app marker is enough; do not inspect session directories unnecessarily.
    for (const marker of PROFILE_MARKERS) {
      if (entries.some(entry => entry.name === marker) && io.statSync(path.join(directory, marker)).isFile()) return 'data';
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      let metadata;
      try { metadata = io.statSync(child); }
      catch (error) { if (missing(error)) continue; return 'unreadable'; }
      if (metadata.isFile() && (PROFILE_MARKERS.has(entry.name) || metadata.size > 0)) return 'data';
      if (metadata.isDirectory() && io.readdirSync(child, { withFileTypes: true }).length > 0) return 'data';
    }
    return 'empty';
  } catch (error) {
    return missing(error) ? 'missing' : 'unreadable';
  }
}

function canonical(directory, io) {
  const absolute = path.resolve(directory);
  try {
    // native resolves the MSIX APPDATA redirection to a path Explorer can open.
    return io.realpathSync.native(absolute);
  } catch {
    // A new explicit/default profile may legitimately not exist yet.
    return absolute;
  }
}

/**
 * Choose userData before creating Electron sessions or requesting an instance lock.
 * No files are read or written; fsImpl is injectable for isolated metadata tests.
 * A supplied explicitPath always wins and suppresses package discovery entirely.
 */
function resolveProfilePath({ defaultPath, explicitPath, platform = process.platform,
  localAppData = process.env.LOCALAPPDATA } = {}, fsImpl = fs) {
  if (explicitPath !== undefined && explicitPath !== null && explicitPath !== '') {
    if (typeof explicitPath !== 'string') throw new TypeError('explicitPath must be a path string.');
    return canonical(explicitPath, fsImpl);
  }
  if (typeof defaultPath !== 'string' || !defaultPath) throw new TypeError('defaultPath must be a non-empty path string.');
  const fallback = path.resolve(defaultPath);
  const current = profileState(fallback, fsImpl);
  // Preserve established or inaccessible profiles rather than guessing another account.
  if (current === 'data' || current === 'unreadable') return canonical(fallback, fsImpl);
  if (platform !== 'win32' || typeof localAppData !== 'string' || !localAppData) return canonical(fallback, fsImpl);

  const packagesPath = path.join(path.resolve(localAppData), 'Packages');
  let packages;
  try { packages = fsImpl.readdirSync(packagesPath, { withFileTypes: true }); }
  catch { return canonical(fallback, fsImpl); }

  const candidates = [];
  for (const entry of packages) {
    if (!entry.isDirectory() || !CODEX_PACKAGE.test(entry.name)) continue;
    const candidate = path.join(packagesPath, entry.name, 'LocalCache', 'Roaming', APP_DIRECTORY);
    const candidateState = profileState(candidate, fsImpl);
    if (candidateState === 'unreadable') return canonical(fallback, fsImpl);
    if (candidateState !== 'data') continue;
    candidates.push(candidate);
    // No recency heuristics: two profiles could represent different accounts.
    if (candidates.length > 1) return canonical(fallback, fsImpl);
  }
  return canonical(candidates.length === 1 ? candidates[0] : fallback, fsImpl);
}

module.exports = { resolveProfilePath };
