import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { resolveSharedStorageDirectory, SharedStateLockBusyError, StorageService } from '../src/storage';
import { bookmark, folder, resetFixtureCounter } from './fixtures';

const STATE_FILE = 'state-v1.json';
const LOCK_FILE = 'state.lock';

// 取一个当前确实不存在的进程号，用于模拟持有锁的窗口已崩溃退出。
function exitedProcessId(): number {
  for (let pid = 60_000; pid < 60_200; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('未找到已退出的进程号');
}

function fakeContext(values = new Map<string, unknown>()): any {
  return {
    globalState: {
      get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
      update: async (key: string, value: unknown) => { values.set(key, value); },
      setKeysForSync: () => undefined,
    },
  };
}

function isolatedStorage(
  directory: string,
  deviceId: string,
  options: { watch?: boolean; lockWaitMs?: number } = {},
): StorageService {
  return new StorageService(fakeContext(), {
    directory,
    deviceId,
    watch: options.watch ?? false,
    ...(options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs }),
  });
}

describe('StorageService', () => {
  let storage: StorageService;
  let directory: string;

  beforeEach(async () => {
    resetFixtureCounter();
    directory = await mkdtemp(path.join(os.tmpdir(), 'my-bookmark-storage-'));
    storage = isolatedStorage(directory, 'storage-test');
    await storage.initialize();
  });

  afterEach(async () => {
    storage.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it('初始化后创建状态文件并可读回写入的数据', async () => {
    await storage.mutate(() => ({ upsertBookmarks: [bookmark({ id: 'b1', note: '备注' })] }));

    const reopened = isolatedStorage(directory, 'other-device');
    await reopened.initialize();

    expect(reopened.getView().bookmarks.map((item) => item.note)).toEqual(['备注']);
    reopened.dispose();
  });

  it('删除书签时一并清理其位置记录', async () => {
    await storage.mutate(() => ({ upsertBookmarks: [bookmark({ id: 'b1' })] }));
    await storage.updatePositions([{ id: 'b1', line: 42 }]);
    expect(storage.getView().positions.get('b1')).toBe(42);

    await storage.mutate(() => ({ deleteBookmarks: ['b1'] }));

    expect(storage.getView().positions.has('b1')).toBe(false);
  });

  it('不给已删除的书签写入位置记录', async () => {
    await storage.updatePositions([{ id: 'never-existed', line: 3 }]);

    expect(storage.getView().positions.size).toBe(0);
  });

  it('变更计算发生在已与磁盘合并的视图上', async () => {
    const other = isolatedStorage(directory, 'other-device');
    await other.initialize();
    await other.mutate(() => ({ upsertFolders: [folder({ id: 'f1' })] }));

    // storage 的内存快照里还没有 f1，但 mutate 的回调必须能看见它。
    let seen: string[] = [];
    await storage.mutate((view) => {
      seen = view.folders.map((item) => item.id);
      return { upsertBookmarks: [bookmark({ id: 'b1', folderId: 'f1' })] };
    });

    expect(seen).toEqual(['f1']);
    other.dispose();
  });

  it('回调返回 undefined 时不写入', async () => {
    const before = await stat(path.join(directory, STATE_FILE));
    await storage.mutate(() => undefined);

    expect((await stat(path.join(directory, STATE_FILE))).mtimeMs).toBe(before.mtimeMs);
  });

  it('内容未变化时不重写文件、不重复通知', async () => {
    const entry = bookmark({ id: 'b1' });
    await storage.mutate(() => ({ upsertBookmarks: [entry] }));
    const before = await stat(path.join(directory, STATE_FILE));
    let notifications = 0;
    storage.onDidChange(() => { notifications += 1; });

    await storage.mutate(() => ({ upsertBookmarks: [entry] }));

    expect((await stat(path.join(directory, STATE_FILE))).mtimeMs).toBe(before.mtimeMs);
    expect(notifications).toBe(0);
  });

  it('并发写入串行执行，不会互相覆盖', async () => {
    await Promise.all([
      storage.mutate(() => ({ upsertBookmarks: [bookmark({ id: 'one' })] })),
      storage.mutate(() => ({ upsertBookmarks: [bookmark({ id: 'two' })] })),
    ]);

    expect(storage.getView().bookmarks.map((item) => item.id).sort()).toEqual(['one', 'two']);
  });

  it('多个窗口并发写入时所有记录都保留', async () => {
    const writers = ['w1', 'w2', 'w3', 'w4'].map((id) => isolatedStorage(directory, id));
    await Promise.all(writers.map((writer) => writer.initialize()));

    await Promise.all(writers.map((writer, index) => (
      writer.mutate(() => ({ upsertBookmarks: [bookmark({ id: `b${index}` })] }))
    )));

    const observer = isolatedStorage(directory, 'observer');
    await observer.initialize();
    expect(observer.getView().bookmarks.map((item) => item.id).sort()).toEqual(['b0', 'b1', 'b2', 'b3']);

    observer.dispose();
    for (const writer of writers) writer.dispose();
  });

  it('文件监听让其他窗口的写入自动传播过来', async () => {
    const watching = isolatedStorage(directory, 'watcher', { watch: true });
    await watching.initialize();

    await storage.mutate(() => ({ upsertBookmarks: [bookmark({ id: 'b1' })] }));

    await vi.waitFor(() => expect(watching.getView().bookmarks).toHaveLength(1), { timeout: 5_000 });
    watching.dispose();
  });

  it('锁被已退出的进程持有时立即接管', async () => {
    const lockPath = path.join(directory, LOCK_FILE);
    await writeFile(lockPath, `${Date.now()} ${exitedProcessId()}`, 'utf8');

    await storage.mutate(() => ({ upsertBookmarks: [bookmark({ id: 'b1' })] }));

    expect(storage.getView().bookmarks).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('锁被存活进程持有时报占用而不是无限等待', async () => {
    const lockPath = path.join(directory, LOCK_FILE);
    await writeFile(lockPath, `${Date.now()} ${process.pid}`, 'utf8');
    const busy = isolatedStorage(directory, 'busy', { lockWaitMs: 200 });
    await busy.initialize();

    await expect(busy.mutate(() => ({ upsertBookmarks: [bookmark()] })))
      .rejects.toThrow(SharedStateLockBusyError);

    busy.dispose();
    await rm(lockPath, { force: true });
  });

  it('原子写不留下临时文件', async () => {
    await storage.mutate(() => ({ upsertBookmarks: [bookmark({ id: 'b1' })] }));

    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('状态文件损坏时保留备份且仍可继续使用', async () => {
    await writeFile(path.join(directory, STATE_FILE), '{broken', 'utf8');
    const recovering = isolatedStorage(directory, 'recovering');
    await recovering.initialize();

    await recovering.mutate(() => ({ upsertBookmarks: [bookmark({ id: 'b1' })] }));

    expect(recovering.getView().bookmarks).toHaveLength(1);
    expect((await readdir(directory)).some((name) => name.includes('.corrupt-'))).toBe(true);
    recovering.dispose();
  });

  it('状态文件版本过高时只读降级且不破坏文件', async () => {
    const raw = '{"version":99,"clock":0,"syncGeneration":0,"bookmarks":{},"folders":{},"positions":{}}';
    await writeFile(path.join(directory, STATE_FILE), raw, 'utf8');
    const downgraded = isolatedStorage(directory, 'downgraded');
    await downgraded.initialize();

    expect(downgraded.isReadOnly()).toBe(true);
    expect(downgraded.getLastError()).toContain('请升级扩展');
    await expect(downgraded.mutate(() => ({ upsertBookmarks: [bookmark()] }))).rejects.toThrow('请升级扩展');
    expect(await readFile(path.join(directory, STATE_FILE), 'utf8')).toBe(raw);
    expect((await readdir(directory)).some((name) => name.includes('.corrupt-'))).toBe(false);
    downgraded.dispose();
  });

  it('记录数超过阈值时发出提醒', async () => {
    const warnings: string[] = [];
    const noisy = new StorageService(fakeContext(), {
      directory,
      deviceId: 'noisy',
      watch: false,
      onWarning: (message) => warnings.push(message),
    });
    await noisy.initialize();

    await noisy.mutate(() => ({
      upsertBookmarks: Array.from({ length: 20_001 }, (_, index) => bookmark({ id: `b${index}` })),
    }));

    expect(warnings[0]).toContain('20001');
    noisy.dispose();
  });

  it('数据写入不受锁文件影响的读取路径阻断', async () => {
    await storage.mutate(() => ({ upsertBookmarks: [bookmark({ id: 'b1' })] }));
    await writeFile(path.join(directory, LOCK_FILE), `${Date.now()} ${process.pid}`, 'utf8');

    const reader = isolatedStorage(directory, 'reader');
    await reader.initialize();

    expect(reader.getView().bookmarks).toHaveLength(1);
    reader.dispose();
    await rm(path.join(directory, LOCK_FILE), { force: true });
  });
});

describe('共享目录解析', () => {
  it('按平台给出用户级共享目录', () => {
    expect(resolveSharedStorageDirectory('Visual Studio Code', 'win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u'))
      .toBe(path.join('C:\\Users\\u\\AppData\\Roaming', 'My Bookmark', 'visual-studio-code'));
    expect(resolveSharedStorageDirectory('Visual Studio Code', 'darwin', {}, '/Users/u'))
      .toBe(path.join('/Users/u', 'Library', 'Application Support', 'My Bookmark', 'visual-studio-code'));
    expect(resolveSharedStorageDirectory('Code', 'linux', { XDG_CONFIG_HOME: '/home/u/.config' }, '/home/u'))
      .toBe(path.join('/home/u/.config', 'my-bookmark', 'code'));
  });

  it('不同的 VS Code 变体互相隔离', () => {
    const stable = resolveSharedStorageDirectory('Visual Studio Code', 'linux', {}, '/home/u');
    const insiders = resolveSharedStorageDirectory('Visual Studio Code - Insiders', 'linux', {}, '/home/u');

    expect(stable).not.toBe(insiders);
  });
});
