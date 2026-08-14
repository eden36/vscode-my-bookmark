import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findVSCodeExecutable } from './find-vscode-executable.mjs';

export const VSCODE_EXTENSION_INSPECT_PORT = 29333;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = findVSCodeExecutable();

spawn(executable, [
  `--extensionDevelopmentPath=${projectRoot}`,
  projectRoot,
  '--new-window',
  '--disable-extensions',
  `--inspect-extensions=${VSCODE_EXTENSION_INSPECT_PORT}`,
], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
}).unref();

// launch.json 以本脚本为 preLaunchTask，必须等端口可连接后调试器才能 attach。
await waitForPort(VSCODE_EXTENSION_INSPECT_PORT, 60_000);
console.log(`VS Code 扩展宿主已就绪（inspect :${VSCODE_EXTENSION_INSPECT_PORT}）：${executable}`);

function waitForPort(port, timeoutMs) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`等待 VS Code inspect 端口 ${port} 超时`));
          return;
        }
        setTimeout(tryConnect, 200);
      });
    };

    tryConnect();
  });
}
