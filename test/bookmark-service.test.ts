import { beforeEach, describe, expect, it, vi } from 'vitest';

// mock 必须写在被测模块 import 之前：BookmarkService 在构造时就会读取配置。
vi.mock('vscode', () => {
  class EventEmitter<T> {
    private readonly listeners: ((value: T) => void)[] = [];
    readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };

    fire(value: T): void {
      for (const listener of [...this.listeners]) listener(value);
    }

    dispose(): void {
      this.listeners.length = 0;
    }
  }

  return {
    EventEmitter,
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        path: fsPath.replace(/\\/g, '/'),
        toString: () => `file://${fsPath.replace(/\\/g, '/')}`,
      }),
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    },
  };
});

import * as vscode from 'vscode';
import { BookmarkService } from '../src/bookmark-service';
import type { BookmarkMutation, SharedStateView, StorageService } from '../src/storage';

/** 只记录写入并把变更落回视图，不碰文件系统——本文件测的是应用层的决策，不是存储。 */
class FakeStorage {
  view: SharedStateView = { bookmarks: [], folders: [], positions: new Map(), deletedFolderIds: new Set() };
  mutations: BookmarkMutation[] = [];
  positionUpdates: { id: string; line: number }[][] = [];

  async initialize(): Promise<void> {}
  getView(): SharedStateView { return this.view; }
  isReadOnly(): boolean { return false; }
  getLastError(): string | undefined { return undefined; }

  async mutate(build: (view: SharedStateView) => BookmarkMutation | undefined): Promise<void> {
    const mutation = build(this.view);
    if (mutation === undefined) return;
    this.mutations.push(mutation);
    const bookmarks = new Map(this.view.bookmarks.map((item) => [item.id, item]));
    for (const bookmark of mutation.upsertBookmarks ?? []) bookmarks.set(bookmark.id, bookmark);
    for (const id of mutation.deleteBookmarks ?? []) bookmarks.delete(id);
    const positions = new Map(this.view.positions);
    for (const entry of mutation.setPositions ?? []) positions.set(entry.id, entry.line);
    for (const id of mutation.deleteBookmarks ?? []) positions.delete(id);
    this.view = { ...this.view, bookmarks: [...bookmarks.values()], positions };
  }

  async updatePositions(entries: readonly { id: string; line: number }[]): Promise<void> {
    this.positionUpdates.push([...entries]);
  }
}

function createService(): { service: BookmarkService; storage: FakeStorage } {
  const storage = new FakeStorage();
  const service = new BookmarkService(storage as unknown as StorageService);
  return { service, storage };
}

const uri = vscode.Uri.file('D:/proj/src/app.ts');
const otherUri = vscode.Uri.file('D:/proj/src/other.ts');
const lines = (...values: number[]): { line: number; lineText: string }[] => (
  values.map((line) => ({ line, lineText: `第 ${line} 行` }))
);

let context: ReturnType<typeof createService>;
beforeEach(async () => {
  context = createService();
  await context.service.initialize();
});

describe('BookmarkService 多光标切换', () => {
  it('在多行上一次性创建书签', async () => {
    const { service, storage } = context;

    await service.toggleLines(uri, lines(3, 10, 42));

    expect(storage.view.bookmarks).toHaveLength(3);
    expect(storage.view.bookmarks.map((item) => item.line).sort((a, b) => a - b)).toEqual([3, 10, 42]);
    // 多光标必须合并成一次写入，否则一次手势会连续抢好几轮文件锁。
    expect(storage.mutations).toHaveLength(1);
  });

  it('创建的多条书签排序键严格递增', async () => {
    const { service, storage } = context;

    await service.toggleLines(uri, lines(1, 2, 3, 4, 5));

    const orders = [...storage.view.bookmarks]
      .sort((left, right) => left.line - right.line)
      .map((item) => item.order);
    for (let index = 1; index < orders.length; index += 1) {
      expect(orders[index - 1]! < orders[index]!).toBe(true);
    }
  });

  it('选中行全部已有书签时整体删除', async () => {
    const { service, storage } = context;
    await service.toggleLines(uri, lines(3, 10));

    await service.toggleLines(uri, lines(3, 10));

    expect(storage.view.bookmarks).toHaveLength(0);
  });

  it('只有部分行有书签时只补齐缺的，不删已有的', async () => {
    const { service, storage } = context;
    await service.toggleLines(uri, lines(3));

    await service.toggleLines(uri, lines(3, 10));

    expect(storage.view.bookmarks.map((item) => item.line).sort((a, b) => a - b)).toEqual([3, 10]);
  });

  it('同一行上的多个光标只创建一条书签', async () => {
    const { service, storage } = context;

    await service.toggleLines(uri, [
      { line: 7, lineText: 'a' },
      { line: 7, lineText: 'a' },
    ]);

    expect(storage.view.bookmarks).toHaveLength(1);
  });

  it('带备注时既补齐缺的行，也更新已有书签的备注', async () => {
    const { service, storage } = context;
    await service.toggleLines(uri, lines(3));

    await service.toggleLines(uri, lines(3, 10), { note: '待办' });

    expect(storage.view.bookmarks).toHaveLength(2);
    expect(storage.view.bookmarks.every((item) => item.note === '待办')).toBe(true);
  });

  it('没有选中任何行时不产生写入', async () => {
    const { service, storage } = context;

    const result = await service.toggleLines(uri, []);

    expect(result).toBe('none');
    expect(storage.mutations).toHaveLength(0);
  });
});

describe('BookmarkService 失效标记', () => {
  it('文件被删除后书签标记为失效，重新打开即恢复', async () => {
    const { service } = context;
    await service.toggleLines(uri, lines(3));
    const bookmark = service.getAllBookmarks()[0]!;

    service.markMissing([uri]);
    expect(service.isMissing(bookmark)).toBe(true);

    service.markPresent(uri);
    expect(service.isMissing(bookmark)).toBe(false);
  });

  it('删除整个目录时其下的书签一并标记失效', async () => {
    const { service } = context;
    await service.toggleLines(uri, lines(3));
    const bookmark = service.getAllBookmarks()[0]!;

    service.markMissing([vscode.Uri.file('D:/proj/src')]);

    expect(service.isMissing(bookmark)).toBe(true);
  });

  it('前缀相同但不是子路径的目录不受影响', async () => {
    const { service } = context;
    await service.toggleLines(uri, lines(3));
    const bookmark = service.getAllBookmarks()[0]!;

    service.markMissing([vscode.Uri.file('D:/proj/src2')]);

    expect(service.isMissing(bookmark)).toBe(false);
  });

  it('失效标记不影响书签本身', async () => {
    const { service, storage } = context;
    await service.toggleLines(uri, lines(3));

    service.markMissing([uri]);

    expect(storage.view.bookmarks).toHaveLength(1);
  });
});

describe('BookmarkService 按文件清除', () => {
  it('只删除指定文件上的书签', async () => {
    const { service, storage } = context;
    await service.toggleLines(uri, lines(3, 10));
    await service.toggleLines(otherUri, lines(5));

    const removed = await service.removeForDocument(uri);

    expect(removed).toBe(2);
    expect(storage.view.bookmarks).toHaveLength(1);
    expect(storage.view.bookmarks[0]!.line).toBe(5);
  });

  it('文件没有书签时不产生写入', async () => {
    const { service, storage } = context;
    await service.toggleLines(uri, lines(3));
    const before = storage.mutations.length;

    const removed = await service.removeForDocument(otherUri);

    expect(removed).toBe(0);
    expect(storage.mutations).toHaveLength(before);
  });
});

describe('BookmarkService 全部书签', () => {
  it('getAllBookmarks 返回副本，调用方改动不会污染内部状态', async () => {
    const { service } = context;
    await service.toggleLines(uri, lines(3));

    service.getAllBookmarks().length = 0;

    expect(service.getAllBookmarks()).toHaveLength(1);
  });
});
