import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function findVSCodeExecutable() {
  loadDebugEnv();
  const configured = process.env.MY_BOOKMARK_VSCODE_EXECUTABLE?.trim();
  if (configured) {
    if (!fs.existsSync(configured)) throw new Error(`找不到 VS Code 可执行文件：${configured}`);
    return configured;
  }
  const discovered = discoverFromPath();
  if (!discovered) throw new Error('找不到 VS Code。请安装 VS Code 或将路径写入 .vscode/debug.env 中的 MY_BOOKMARK_VSCODE_EXECUTABLE。');
  return discovered;
}

function loadDebugEnv() {
  const file = path.join(projectRoot, '.vscode', 'debug.env');
  try {
    const content = fs.readFileSync(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // debug.env 为可选本地配置。
  }
}

function discoverFromPath() {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const cli = execFileSync(command, ['code'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean);
    if (!cli) return undefined;
    if (process.platform === 'win32') {
      const executable = path.resolve(path.dirname(cli), '..', 'Code.exe');
      return fs.existsSync(executable) ? executable : undefined;
    }
    return fs.existsSync(cli) ? cli : undefined;
  } catch {
    return undefined;
  }
}
