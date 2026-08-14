import { beforeEach, describe, expect, it } from 'vitest';
import { buildTree, isSelfOrDescendant, MAX_TREE_DEPTH, type TreeNode } from '../src/core/tree';
import { bookmark, folder, resetFixtureCounter } from './fixtures';

beforeEach(() => resetFixtureCounter());

describe('树构建', () => {
  it('按 order 排序，文件夹与书签交错共存', () => {
    const first = folder({ id: 'f1', order: 'a1' });
    const second = bookmark({ id: 'b1', order: 'a0' });
    const third = bookmark({ id: 'b2', order: 'a2' });

    const { roots } = buildTree({ bookmarks: [third, second], folders: [first] });

    expect(roots.map(idOf)).toEqual(['b1', 'f1', 'b2']);
  });

  it('order 相同时用 id 做稳定裁决', () => {
    // 两台设备同时追加到末尾会算出相同的 order，没有次级键树序就会在设备之间抖动。
    const later = bookmark({ id: 'b-z', order: 'a5' });
    const earlier = bookmark({ id: 'b-a', order: 'a5' });

    const { roots } = buildTree({ bookmarks: [later, earlier], folders: [] });

    expect(roots.map(idOf)).toEqual(['b-a', 'b-z']);
  });

  it('嵌套文件夹按父子关系组装', () => {
    const parent = folder({ id: 'f1' });
    const child = folder({ id: 'f2', parentId: 'f1' });
    const leaf = bookmark({ id: 'b1', folderId: 'f2' });

    const { roots } = buildTree({ bookmarks: [leaf], folders: [parent, child] });

    expect(roots).toHaveLength(1);
    expect(childrenOf(roots[0]!).map(idOf)).toEqual(['f2']);
    expect(childrenOf(childrenOf(roots[0]!)[0]!).map(idOf)).toEqual(['b1']);
  });
});

describe('悬空引用', () => {
  it('文件夹确已删除时归为可修复孤儿', () => {
    const orphan = bookmark({ id: 'b1', folderId: 'gone' });

    const { roots, diagnostics } = buildTree({
      bookmarks: [orphan],
      folders: [],
      deletedFolderIds: new Set(['gone']),
    });

    expect(roots.map(idOf)).toEqual(['b1']);
    expect(diagnostics.resolvableOrphans).toEqual(['b1']);
    expect(diagnostics.pendingOrphans).toEqual([]);
  });

  it('文件夹记录完全不存在时归为待同步孤儿，不可写盘', () => {
    // 新设备首轮同步可能只拿到部分记录，此时清空 folderId 会永久破坏用户的分组。
    const orphan = bookmark({ id: 'b1', folderId: 'not-yet-synced' });

    const { roots, diagnostics } = buildTree({ bookmarks: [orphan], folders: [] });

    expect(roots.map(idOf)).toEqual(['b1']);
    expect(diagnostics.pendingOrphans).toEqual(['b1']);
    expect(diagnostics.resolvableOrphans).toEqual([]);
  });

  it('父文件夹不存在的文件夹提升到根级', () => {
    const orphan = folder({ id: 'f1', parentId: 'missing' });

    const { roots } = buildTree({ bookmarks: [], folders: [orphan] });

    expect(roots.map(idOf)).toEqual(['f1']);
  });

  it('自引用的文件夹视作根级', () => {
    const selfParent = folder({ id: 'f1', parentId: 'f1' });

    const { roots, diagnostics } = buildTree({ bookmarks: [], folders: [selfParent] });

    expect(roots.map(idOf)).toEqual(['f1']);
    expect(diagnostics.cycleBroken).toEqual([]);
  });
});

describe('环', () => {
  it('合并产生的环被确定性地打破', () => {
    const first = folder({ id: 'f-b', parentId: 'f-a' });
    const second = folder({ id: 'f-a', parentId: 'f-b' });

    const forward = buildTree({ bookmarks: [], folders: [first, second] });
    const reversed = buildTree({ bookmarks: [], folders: [second, first] });

    // 与输入顺序无关，各设备必须得到同一个结果，否则树的形状会互相打架。
    expect(forward.diagnostics.cycleBroken).toEqual(['f-a']);
    expect(reversed.diagnostics.cycleBroken).toEqual(['f-a']);
    expect(forward.roots.map(idOf)).toEqual(reversed.roots.map(idOf));
    expect(forward.roots.map(idOf)).toEqual(['f-a']);
  });

  it('三节点环同样只提升一个节点', () => {
    const a = folder({ id: 'f-a', parentId: 'f-c' });
    const b = folder({ id: 'f-b', parentId: 'f-a' });
    const c = folder({ id: 'f-c', parentId: 'f-b' });

    const { roots, diagnostics } = buildTree({ bookmarks: [], folders: [a, b, c] });

    expect(diagnostics.cycleBroken).toEqual(['f-a']);
    expect(roots.map(idOf)).toEqual(['f-a']);
  });

  it('可用自定义裁决依据决定破环对象', () => {
    const a = folder({ id: 'f-a', parentId: 'f-b' });
    const b = folder({ id: 'f-b', parentId: 'f-a' });

    const { diagnostics } = buildTree({
      bookmarks: [],
      folders: [a, b],
      rank: (id) => (id === 'f-b' ? '0' : '1'),
    });

    expect(diagnostics.cycleBroken).toEqual(['f-b']);
  });

  it('环不会让构建陷入死循环或丢失节点', () => {
    const a = folder({ id: 'f-a', parentId: 'f-b' });
    const b = folder({ id: 'f-b', parentId: 'f-a' });
    const inside = bookmark({ id: 'b1', folderId: 'f-b' });

    const { roots } = buildTree({ bookmarks: [inside], folders: [a, b] });

    expect(collectIds(roots).sort()).toEqual(['b1', 'f-a', 'f-b']);
  });
});

describe('深度上限', () => {
  it('超过上限的层级不再展开', () => {
    const folders = Array.from({ length: MAX_TREE_DEPTH + 5 }, (_, index) => folder({
      id: `f${index}`,
      ...(index === 0 ? {} : { parentId: `f${index - 1}` }),
    }));

    const { roots, diagnostics } = buildTree({ bookmarks: [], folders });

    // 到达上限即停止展开，更深的层级根本不会被访问到。
    expect(diagnostics.depthTruncated).toEqual(['f32']);
    expect(depthOf(roots)).toBe(MAX_TREE_DEPTH + 1);
  });
});

describe('移动校验', () => {
  const folders = [
    folder({ id: 'f1' }),
    folder({ id: 'f2', parentId: 'f1' }),
    folder({ id: 'f3', parentId: 'f2' }),
    folder({ id: 'f4' }),
  ];

  it('拒绝移动到自身或自身的后代', () => {
    expect(isSelfOrDescendant(folders, 'f1', 'f1')).toBe(true);
    expect(isSelfOrDescendant(folders, 'f1', 'f3')).toBe(true);
  });

  it('允许移动到无关的文件夹', () => {
    expect(isSelfOrDescendant(folders, 'f1', 'f4')).toBe(false);
    expect(isSelfOrDescendant(folders, 'f3', 'f1')).toBe(false);
  });

  it('数据已成环时校验本身不会死循环', () => {
    const cyclic = [folder({ id: 'x', parentId: 'y' }), folder({ id: 'y', parentId: 'x' })];

    expect(isSelfOrDescendant(cyclic, 'z', 'x')).toBe(false);
  });
});

function idOf(node: TreeNode): string {
  return node.kind === 'folder' ? node.folder.id : node.bookmark.id;
}

function childrenOf(node: TreeNode): TreeNode[] {
  return node.kind === 'folder' ? node.children : [];
}

function collectIds(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => [idOf(node), ...collectIds(childrenOf(node))]);
}

function depthOf(nodes: readonly TreeNode[]): number {
  return nodes.length === 0 ? 0 : 1 + Math.max(...nodes.map((node) => depthOf(childrenOf(node))));
}
