'use strict';

const { verifyPackage } = require('./scripts/verify-package.cjs');

module.exports = {
  appId: 'io.chzzkdesk.desktop',
  productName: 'Chzzk Desk',
  directories: { output: 'dist' },
  electronVersion: require('./package.json').devDependencies.electron,
  asar: true,
  npmRebuild: false,
  // Preserve desktop -> ../browser-extension/shared references without rewriting
  // the development sources. Only these application files belong in the bundle.
  extraMetadata: { main: 'desktop/main.cjs' },
  files: [
    'package.json', '!**/node_modules/**',
    { from: '.', to: 'desktop', filter: ['main.cjs', 'preload.cjs', 'lib/**/*.cjs', 'ui/*.mjs', 'ui/*.html', 'ui/*.css'] },
    { from: '../browser-extension/shared', to: 'browser-extension/shared',
      filter: ['channels.js', 'presentation.js', 'rewards.js', 'package.json', 'REWARDS-SOURCES.md', 'ui/*.mjs'] }
  ],
  // spawn() requires a real executable path, not a path within app.asar.
  extraResources: [
    { from: 'node_modules/ffmpeg-static', to: 'ffmpeg', filter: ['ffmpeg.exe', 'ffmpeg.exe.LICENSE', 'ffmpeg.exe.README'] },
    { from: '../LICENSE', to: 'LICENSE' }
  ],
  win: {
    target: [{ target: 'zip', arch: ['x64'] }, { target: 'nsis', arch: ['x64'] }],
    artifactName: 'Chzzk-Desk-${version}-win-${arch}.${ext}',
    signExecutable: false
  },
  nsis: {
    artifactName: 'Chzzk-Desk-${version}-Setup-${arch}.${ext}',
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false
  },
  publish: null,
  afterPack: context => verifyPackage(context.appOutDir)
};
