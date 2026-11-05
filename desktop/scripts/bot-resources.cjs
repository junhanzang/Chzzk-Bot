'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT_FILES = Object.freeze([
  'main.py', 'config.py', 'core_logic.py', 'response_pipeline.py', 'audio_buffer.py', 'audio_capture.py',
  'speech_recognition.py', 'llm_handler.py', 'chat_reader.py', 'chat_sender.py', 'requirements.txt',
  '.env.example', 'LICENSE', 'examples/bot-demo.json', 'examples/bot-quality.json'
]);

// Every FileSet names a single file. A repository-wide filter still makes
// electron-builder traverse unrelated caches before deciding what to copy.
function botSourceResources(sourceRoot = path.resolve(__dirname, '../..'), fileSystem = fs) {
  const root = path.resolve(sourceRoot);
  const names = [...ROOT_FILES];
  for (const directory of ['bot', 'memory']) {
    const folder = path.join(root, directory);
    if (!fileSystem.lstatSync(folder).isDirectory() || fileSystem.lstatSync(folder).isSymbolicLink()) throw new Error(`Invalid bot source directory: ${directory}`);
    for (const entry of fileSystem.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-z_]+\.py$/.test(entry.name)) names.push(`${directory}/${entry.name}`);
    }
  }
  for (const required of ['bot/__init__.py', 'bot/control.py', 'bot/model_transport.py', 'memory/__init__.py']) {
    if (!names.includes(required)) throw new Error(`Missing bot source: ${required}`);
  }
  return names.sort().map(name => {
    const from = path.join(root, name), stat = fileSystem.lstatSync(from);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid bot source file: ${name}`);
    return { from, to: `bot/${name}` };
  });
}

module.exports = { botSourceResources, ROOT_FILES };
