import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findVSCodeExecutable } from './find-vscode-executable.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = findVSCodeExecutable();

spawn(executable, [
  `--extensionDevelopmentPath=${projectRoot}`,
  projectRoot,
  '--new-window',
  '--disable-extensions',
], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
}).unref();

console.log(`已启动 VS Code 扩展开发宿主：${executable}`);
