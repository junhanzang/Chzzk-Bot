'use strict';

const fs = require('node:fs');
const { promisify } = require('node:util');
const realpath = promisify(fs.realpath.native);

// MSIX can redirect AppData only inside the calling process. Shell apps must
// receive the physical path, not the virtual path that fs.access can still see.
async function openLocalPath(target, { kind, openPath }) {
  const folder = kind === 'directory';
  let physicalPath;
  try {
    physicalPath = await realpath(target);
    const stat = await fs.promises.stat(physicalPath);
    if (folder ? !stat.isDirectory() : !stat.isFile()) throw new Error('Unexpected file type');
  } catch {
    throw new Error(folder ? '보관 폴더가 없거나 접근할 수 없습니다.' : '클립 파일이 이동되거나 삭제되었거나 접근할 수 없습니다.');
  }
  const error = await openPath(physicalPath);
  if (error) throw new Error(folder ? '보관 폴더를 열지 못했습니다.' : '기본 동영상 앱에서 파일을 열지 못했습니다. 보관 폴더를 확인해 주세요.');
}

module.exports = { openLocalPath };
