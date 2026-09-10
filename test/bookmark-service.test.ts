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

  it('按原有顺序而非选中顺序分配新序键', async () => {
    const { service, storage } = context;
    await service.toggleLines(uri, lines(1, 2, 3, 4));
    const [first, second, third, target] = service.getAllBookmarks();

    // 选中顺序故意与树里的顺序相反：结果仍应保留 first、second、third 原有的相对次序。
    await service.moveAfterBookmark([third!.id, first!.id, second!.id], target!.id);

    const sorted = [...storage.view.bookmarks]
      .sort((left, right) => compareOrder(left.order, right.order))
      .map((item) => item.id);
    expect(sorted).toEqual([target!.id, first!.id, second!.id, third!.id]);
  });

  it('目标之后已存在相同 order 的同级项时仍能插入有效区间', async () => {
    const { service, storage } = context;
    storage.view = {
      bookmarks: [
        bookmark({ id: 'target', order: 'a1' }),
        // 两台设备并发追加会算出相同的 order；插入时不能因此产生非法区间。
        bookmark({ id: 'tie', order: 'a2' }),
        bookmark({ id: 'tie-2', order: 'a2' }),
      ],
      folders: [],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();

    await service.moveAfterBookmark(['tie-2'], 'target');

    expect(storage.view.bookmarks.find((item) => item.id === 'tie-2')!.order)
      .not.toBe(storage.view.bookmarks.find((item) => item.id === 'target')!.order);
  });

  it('跨工作区拖拽整体拒绝，不产生写入', async () => {
    const { service, storage } = context;
    storage.view = {
      bookmarks: [
        bookmark({ id: 'here', location: { kind: 'workspace', folderName: 'a', relativePath: 'x.ts' } }),
        bookmark({ id: 'there-target', location: { kind: 'workspace', folderName: 'b', relativePath: 'y.ts' } }),
      ],
      folders: [folder({ id: 'there-folder', workspace: 'b' })],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();
    const before = storage.mutations.length;

    await expect(service.moveAfterBookmark(['here'], 'there-target')).rejects.toThrow('不能移动到其他工作区');
    await expect(service.moveToFolder(['here'], 'there-folder', 'b')).rejects.toThrow('不能移动到其他工作区');
    expect(storage.mutations).toHaveLength(before);
  });

  it('拖到空白处：各项目回到自己所属工作区的根级，互不干扰排序', async () => {
    const { service, storage } = context;
    storage.view = {
      bookmarks: [
        bookmark({
          id: 'a-child',
          location: { kind: 'workspace', folderName: 'a', relativePath: 'x.ts' },
          folderId: 'a-folder',
        }),
        bookmark({
          id: 'b-child',
          location: { kind: 'workspace', folderName: 'b', relativePath: 'y.ts' },
          folderId: 'b-folder',
        }),
      ],
      folders: [folder({ id: 'a-folder', workspace: 'a' }), folder({ id: 'b-folder', workspace: 'b' })],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();

    await service.moveToOwnRoot(['a-child', 'b-child']);

    const aChild = storage.view.bookmarks.find((item) => item.id === 'a-child')!;
    const bChild = storage.view.bookmarks.find((item) => item.id === 'b-child')!;
    expect(aChild.folderId).toBeUndefined();
    expect(bChild.folderId).toBeUndefined();
  });

  it('拖到工作区分组节点上：移到该工作区根级，工作区外书签不受影响', async () => {
    const { service, storage } = context;
    storage.view = {
      bookmarks: [
        bookmark({
          id: 'child',
          location: { kind: 'workspace', folderName: 'a', relativePath: 'x.ts' },
          folderId: 'a-folder',
        }),
      ],
      folders: [folder({ id: 'a-folder', workspace: 'a' })],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();

    await service.moveToFolder(['child'], undefined, 'a');

    expect(storage.view.bookmarks.find((item) => item.id === 'child')!.folderId).toBeUndefined();
  });

  it('文件夹拖到自己的后代文件夹上会被拒绝', async () => {
    const { service, storage } = context;
    storage.view = {
      bookmarks: [],
      folders: [
        folder({ id: 'parent', workspace: 'demo' }),
        folder({ id: 'child', workspace: 'demo', parentId: 'parent' }),
      ],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();
    const before = storage.mutations.length;

    await service.moveToFolder(['parent'], 'child', 'demo');

    expect(storage.view.folders.find((item) => item.id === 'parent')!.parentId).toBeUndefined();
    expect(storage.mutations).toHaveLength(before);
  });
});

describe('BookmarkService 上移下移', () => {
  it('根级调序只在同一工作区内进行，不会跳到其他工作区的项目', async () => {
    const { service, storage } = context;
    storage.view = {
      bookmarks: [
        bookmark({ id: 'a1', location: { kind: 'workspace', folderName: 'a', relativePath: 'x.ts' }, order: 'a1' }),
        // b 工作区的项目排在 a1 与 a2 的 order 之间，但视觉上并不相邻，不应被当作 a1 的下一个兄弟。
        bookmark({ id: 'b1', location: { kind: 'workspace', folderName: 'b', relativePath: 'y.ts' }, order: 'a15' }),
        bookmark({ id: 'a2', location: { kind: 'workspace', folderName: 'a', relativePath: 'z.ts' }, order: 'a2' }),
      ],
      folders: [],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();

    await service.moveBy('a1', 1);

    const a1 = storage.view.bookmarks.find((item) => item.id === 'a1')!;
    const a2 = storage.view.bookmarks.find((item) => item.id === 'a2')!;
    const b1 = storage.view.bookmarks.find((item) => item.id === 'b1')!;
    expect(compareOrder(a2.order, a1.order)).toBeLessThan(0);
    expect(b1.order).toBe('a15');
  });
});

describe('BookmarkService 新建文件夹', () => {
  it('记录调用方给定的工作区', async () => {
    const { service, storage } = context;

    await service.createFolder('分组', undefined, '当前项目');

    expect(storage.view.folders[0]!.workspace).toBe('当前项目');
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
  it('只保留属于当前工作区的目录，与其中是否有书签无关', () => {
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
        folder({ id: 'current-parent', name: '当前父目录', workspace: '当前项目', order: 'a1' }),
        folder({ id: 'current-child', name: '当前子目录', workspace: '当前项目', parentId: 'current-parent', order: 'a1' }),
        folder({ id: 'other-parent', name: '其他父目录', workspace: '其他项目', order: 'a2' }),
        folder({ id: 'other-child', name: '其他子目录', workspace: '其他项目', parentId: 'other-parent', order: 'a1' }),
        // 空文件夹没有任何书签，但只要 workspace 属于当前工作区就该显示——这是文件夹归属
        // 工作区（而不是从其中的书签推导）之后才能保证的：空文件夹不再因为「摸不到书签」而消失。
        folder({ id: 'empty', name: '空目录', workspace: '当前项目', order: 'a3' }),
      ],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();

    const roots = service.getTree();
    expect(roots.map((node) => (node.kind === 'folder' ? node.folder.id : node.kind))).toEqual(['current-parent', 'empty']);
    const parent = roots[0]!;
    if (parent.kind !== 'folder') return;
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toMatchObject({ kind: 'folder', folder: { id: 'current-child' } });
  });

  it('打开多个工作区时按工作区分组显示，已打开的排在前面', () => {
    const { service, storage } = context;
    setWorkspaceFolders([
      { name: 'b项目', uri: vscode.Uri.file('D:/b') },
      { name: 'a项目', uri: vscode.Uri.file('D:/a') },
    ]);
    storage.view = {
      bookmarks: [
        bookmark({ location: { kind: 'workspace', folderName: 'a项目', relativePath: 'x.ts' } }),
        bookmark({ location: { kind: 'workspace', folderName: 'b项目', relativePath: 'x.ts' } }),
      ],
      folders: [],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();

    const roots = service.getTree();
    expect(roots).toHaveLength(2);
    expect(roots.map((node) => (node.kind === 'workspace' ? node.workspace : undefined))).toEqual(['b项目', 'a项目']);
  });

  it('单个工作区时不显示分组节点', () => {
    const { service, storage } = context;
    setWorkspaceFolders([{ name: '当前项目', uri: vscode.Uri.file('D:/current') }]);
    storage.view = {
      bookmarks: [bookmark({ location: { kind: 'workspace', folderName: '当前项目', relativePath: 'x.ts' } })],
      folders: [],
      positions: new Map(),
      deletedFolderIds: new Set(),
    };
    service.refreshFromStorage();

    expect(service.getTree()[0]!.kind).toBe('bookmark');
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
