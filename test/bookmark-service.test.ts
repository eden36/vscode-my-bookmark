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
import { compareOrder } from '../src/core/order';
import type { LineEdit } from '../src/core/tracker';
import type { BookmarkMutation, SharedStateView, StorageService } from '../src/storage';
import { bookmark, folder, resetFixtureCounter } from './fixtures';

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
    const folders = new Map(this.view.folders.map((item) => [item.id, item]));
    for (const bookmark of mutation.upsertBookmarks ?? []) bookmarks.set(bookmark.id, bookmark);
    for (const folder of mutation.upsertFolders ?? []) folders.set(folder.id, folder);
    for (const id of mutation.deleteBookmarks ?? []) bookmarks.delete(id);
    for (const id of mutation.deleteFolders ?? []) folders.delete(id);
    const positions = new Map(this.view.positions);
    for (const entry of mutation.setPositions ?? []) positions.set(entry.id, entry.line);
    for (const id of mutation.deleteBookmarks ?? []) positions.delete(id);
    this.view = { ...this.view, bookmarks: [...bookmarks.values()], folders: [...folders.values()], positions };
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

function setWorkspaceFolders(folders: { name: string; uri: { fsPath: string } }[] | undefined): void {
  (vscode.workspace as unknown as { workspaceFolders: typeof folders }).workspaceFolders = folders;
}

const uri = vscode.Uri.file('D:/proj/src/app.ts');
const otherUri = vscode.Uri.file('D:/proj/src/other.ts');
const lines = (...values: number[]): { line: number; lineText: string }[] => (
  values.map((line) => ({ line, lineText: `第 ${line} 行` }))
);
const insert = (startLine: number, count: number): LineEdit => (
  { startLine, endLineExclusive: startLine, insertedLineCount: count }
);

let context: ReturnType<typeof createService>;
beforeEach(async () => {
  resetFixtureCounter();
  setWorkspaceFolders(undefined);
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

describe('BookmarkService 拖拽排序', () => {
  it('拖到书签上后排在目标书签之后', async () => {
    const { service, storage } = context;
    await service.toggleLines(uri, lines(1, 2, 3));
    const [first, second, target] = service.getAllBookmarks();

    await service.moveAfterBookmark([first!.id], target!.id);

    const sorted = [...storage.view.bookmarks]
      .sort((left, right) => compareOrder(left.order, right.order))
      .map((item) => item.id);
    expect(sorted).toEqual([second!.id, target!.id, first!.id]);
  });

  it('拖到自身时不产生写入', async () => {
    const { service, storage } = context;
    await service.toggleLines(uri, lines(1));
    const bookmark = service.getAllBookmarks()[0]!;
    const before = storage.mutations.length;

    await service.moveAfterBookmark([bookmark.id], bookmark.id);

    expect(storage.mutations).toHaveLength(before);
  });

  it('多选包含目标时仍移动其余书签', async () => {
    const { service, storage } = context;
    await service.toggleLines(uri, lines(1, 2, 3));
    const [first, second, target] = service.getAllBookmarks();

    await service.moveAfterBookmark([first!.id, target!.id], target!.id);

    const sorted = [...storage.view.bookmarks]
      .sort((left, right) => compareOrder(left.order, right.order))
      .map((item) => item.id);
    expect(sorted).toEqual([second!.id, target!.id, first!.id]);
  });

  it('文件夹拖到书签上时排在该书签之后', async () => {
    const { service, storage } = context;
    storage.view = {
      bookmarks: [
        bookmark({ id: 'target', folderId: 'destination', order: 'a1' }),
        bookmark({ id: 'following', folderId: 'destination', order: 'a3' }),
      ],
      folders: [
        folder({ id: 'destination', order: 'a1' }),
        folder({ id: 'source', order: 'a2' }),
      ],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();

    await service.moveAfterBookmark(['source'], 'target');

    const source = storage.view.folders.find((item) => item.id === 'source')!;
    expect(source.parentId).toBe('destination');
    expect(compareOrder(source.order, 'a1')).toBeGreaterThan(0);
    expect(compareOrder(source.order, 'a3')).toBeLessThan(0);
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

describe('BookmarkService 工作区范围', () => {
  it('只保留包含当前工作区书签的目录及其父目录', () => {
    const { service, storage } = context;
    setWorkspaceFolders([{ name: '当前项目', uri: vscode.Uri.file('D:/current') }]);
    storage.view = {
      bookmarks: [
        bookmark({
          id: 'current-bookmark',
          location: { kind: 'workspace', folderName: '当前项目', relativePath: 'src/app.ts' },
          folderId: 'current-child',
          order: 'a1',
        }),
        bookmark({
          id: 'other-bookmark',
          location: { kind: 'workspace', folderName: '其他项目', relativePath: 'src/app.ts' },
          folderId: 'other-child',
          order: 'a1',
        }),
      ],
      folders: [
        folder({ id: 'current-parent', name: '当前父目录', order: 'a1' }),
        folder({ id: 'current-child', name: '当前子目录', parentId: 'current-parent', order: 'a1' }),
        folder({ id: 'other-parent', name: '其他父目录', order: 'a2' }),
        folder({ id: 'other-child', name: '其他子目录', parentId: 'other-parent', order: 'a1' }),
        folder({ id: 'empty', name: '空目录', order: 'a3' }),
      ],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();

    const root = service.getTree()[0]!;
    expect(root.kind).toBe('folder');
    if (root.kind !== 'folder') return;
    expect(root.folder.id).toBe('current-parent');
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toMatchObject({ kind: 'folder', folder: { id: 'current-child' } });
  });
});

describe('BookmarkService 编辑跟踪', () => {
  it('没有书签的文档编辑返回 false，不触发装饰刷新', async () => {
    const { service } = context;

    expect(service.trackDocumentEdits(otherUri, [insert(0, 2)])).toBe(false);
  });

  it('纯行内编辑不移动书签，返回 false', async () => {
    const { service } = context;
    await service.toggleLines(uri, lines(3, 10));

    expect(service.trackDocumentEdits(uri, [{ startLine: 0, endLineExclusive: 1, insertedLineCount: 1 }])).toBe(false);
  });

  it('行数不变的改写不移动书签，返回 false', async () => {
    const { service } = context;
    await service.toggleLines(uri, lines(10));

    expect(service.trackDocumentEdits(uri, [{ startLine: 0, endLineExclusive: 3, insertedLineCount: 3 }])).toBe(false);
  });

  it('上方插入行时书签下移，实时行号优先于磁盘位置', async () => {
    const { service } = context;
    await service.toggleLines(uri, lines(3));

    expect(service.trackDocumentEdits(uri, [insert(0, 2)])).toBe(true);

    expect(service.getLine(service.getAllBookmarks()[0]!)).toBe(5);
  });

  it('编辑只影响所在文档的书签', async () => {
    const { service } = context;
    await service.toggleLines(uri, lines(3));
    await service.toggleLines(otherUri, lines(3));

    service.trackDocumentEdits(uri, [insert(0, 2)]);

    expect(service.getLine(service.getBookmarksForDocument(uri)[0]!)).toBe(5);
    expect(service.getLine(service.getBookmarksForDocument(otherUri)[0]!)).toBe(3);
  });

  it('实时行号在文档丢弃后回到磁盘位置', async () => {
    const { service } = context;
    await service.toggleLines(uri, lines(3));

    service.trackDocumentEdits(uri, [insert(0, 2)]);
    service.discardDocument(uri);

    expect(service.getLine(service.getAllBookmarks()[0]!)).toBe(3);
  });
});
