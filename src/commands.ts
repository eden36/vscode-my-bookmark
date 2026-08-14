import * as vscode from 'vscode';
import type { BookmarkService } from './bookmark-service';
import { readConfig, updateScope } from './config';
import { BOOKMARK_COLORS, type Bookmark, type BookmarkColor } from './core/model';
import type { TreeNode } from './core/tree';
import { nodeId, type BookmarkTreeProvider } from './views/tree-provider';

const COLOR_LABELS: Record<BookmarkColor, string> = {
  red: '红色',
  orange: '橙色',
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  purple: '紫色',
  gray: '灰色',
};

export function registerCommands(
  service: BookmarkService,
  provider: BookmarkTreeProvider,
  treeView: vscode.TreeView<TreeNode>,
  log: (message: string) => void,
): vscode.Disposable[] {
  const register = (command: string, handler: (...args: any[]) => unknown): vscode.Disposable => (
    vscode.commands.registerCommand(command, async (...args: unknown[]) => {
      try {
        await handler(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : '操作失败';
        log(`命令执行失败 命令=${command} 类别=${message}`);
        void vscode.window.showErrorMessage(message);
      }
    })
  );

  /** 树视图的命令既可能来自右键菜单（带节点），也可能来自快捷键（只有当前选中项）。 */
  const targets = (node: TreeNode | undefined, selection: readonly TreeNode[] | undefined): string[] => {
    const nodes = selection !== undefined && selection.length > 0 ? selection : node ? [node] : treeView.selection;
    return nodes.map(nodeId);
  };

  return [
    register('myBookmark.open', async (id: string) => {
      const bookmark = service.getBookmark(id);
      if (bookmark === undefined) return;
      await openBookmark(service, bookmark);
    }),

    register('myBookmark.toggle', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) return;
      const line = editor.selection.active.line;
      await service.toggle(editor.document.uri, line, { lineText: editor.document.lineAt(line).text });
    }),

    register('myBookmark.toggleWithNote', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) return;
      const line = editor.selection.active.line;
      const existing = service.getBookmarksForDocument(editor.document.uri)
        .find((item) => service.getLine(item) === line);
      const note = await vscode.window.showInputBox({
        title: '书签备注',
        value: existing?.note ?? '',
        prompt: '为这一行写一句说明',
      });
      if (note === undefined) return;
      await service.toggle(editor.document.uri, line, { note, lineText: editor.document.lineAt(line).text });
    }),

    register('myBookmark.jumpToNext', () => jumpTo(service, 1)),
    register('myBookmark.jumpToPrevious', () => jumpTo(service, -1)),

    register('myBookmark.listFromAll', async () => {
      const items = service.getTree().length === 0 ? [] : allBookmarks(service);
      if (items.length === 0) {
        void vscode.window.showInformationMessage('还没有任何书签。');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        items.map((bookmark) => ({
          label: bookmark.note?.trim() || bookmark.anchorText?.trim() || '（无备注）',
          description: `${locationLabel(bookmark)}:${service.getLine(bookmark) + 1}`,
          bookmark,
        })),
        { title: '搜索书签', matchOnDescription: true, placeHolder: '按备注或路径筛选' },
      );
      if (picked !== undefined) await openBookmark(service, picked.bookmark);
    }),

    register('myBookmark.editNote', async (node?: TreeNode) => {
      const id = targets(node, undefined)[0];
      const bookmark = id === undefined ? undefined : service.getBookmark(id);
      if (bookmark === undefined) return;
      const note = await vscode.window.showInputBox({
        title: '书签备注',
        value: bookmark.note ?? '',
        prompt: '留空可清除备注',
      });
      if (note === undefined) return;
      await service.setNote(bookmark.id, note.trim());
    }),

    register('myBookmark.setColor', async (node?: TreeNode, selection?: readonly TreeNode[]) => {
      const ids = targets(node, selection);
      if (ids.length === 0) return;
      const picked = await vscode.window.showQuickPick(
        [
          { label: '默认', color: undefined as BookmarkColor | undefined },
          ...BOOKMARK_COLORS.map((color) => ({ label: COLOR_LABELS[color], color })),
        ],
        { title: '书签颜色' },
      );
      if (picked === undefined) return;
      await service.setColor(ids, picked.color);
    }),

    register('myBookmark.newFolder', async (node?: TreeNode) => {
      const name = await vscode.window.showInputBox({ title: '新建文件夹', prompt: '文件夹名称' });
      if (name === undefined || name.trim().length === 0) return;
      const parentId = node?.kind === 'folder' ? node.folder.id : undefined;
      const created = await service.createFolder(name.trim(), parentId);
      const target = provider.findNode(created.id);
      if (target !== undefined) await treeView.reveal(target, { focus: true });
    }),

    register('myBookmark.renameFolder', async (node?: TreeNode) => {
      const id = targets(node, undefined)[0];
      const folder = id === undefined ? undefined : service.getFolder(id);
      if (folder === undefined) return;
      const name = await vscode.window.showInputBox({ title: '重命名文件夹', value: folder.name });
      if (name === undefined || name.trim().length === 0) return;
      await service.renameFolder(folder.id, name.trim());
    }),

    register('myBookmark.deleteFolder', async (node?: TreeNode) => {
      const id = targets(node, undefined)[0];
      const folder = id === undefined ? undefined : service.getFolder(id);
      if (folder === undefined) return;
      const count = countBookmarksUnder(service, folder.id);
      // 删除没有撤销，破坏性程度必须在确认框里说清楚。
      const choice = await vscode.window.showWarningMessage(
        `删除文件夹「${folder.name}」？`,
        { modal: true, detail: count === 0 ? '该文件夹中没有书签。' : `该文件夹及其子文件夹中共有 ${count} 条书签。` },
        '仅删除文件夹',
        '连同书签一起删除',
      );
      if (choice === undefined) return;
      await service.deleteFolder(folder.id, choice === '连同书签一起删除');
    }),

    register('myBookmark.moveUp', async (node?: TreeNode) => {
      const id = targets(node, undefined)[0];
      if (id !== undefined) await service.moveBy(id, -1);
    }),

    register('myBookmark.moveDown', async (node?: TreeNode) => {
      const id = targets(node, undefined)[0];
      if (id !== undefined) await service.moveBy(id, 1);
    }),

    register('myBookmark.remove', async (node?: TreeNode, selection?: readonly TreeNode[]) => {
      const ids = targets(node, selection).filter((id) => service.getBookmark(id) !== undefined);
      if (ids.length > 0) await service.remove(ids);
    }),

    register('myBookmark.removeAll', async () => {
      const total = allBookmarks(service).length;
      if (total === 0) return;
      const choice = await vscode.window.showWarningMessage(
        '删除全部书签？',
        { modal: true, detail: `将删除 ${total} 条书签及所有文件夹，此操作无法撤销。` },
        '全部删除',
      );
      if (choice !== '全部删除') return;
      await service.removeAll();
    }),

    register('myBookmark.toggleScope', async () => {
      const next = readConfig().scope === 'all' ? 'currentWorkspace' : 'all';
      await updateScope(next);
      void vscode.window.showInformationMessage(next === 'all' ? '显示全部工作区的书签。' : '仅显示当前工作区的书签。');
    }),

    register('myBookmark.reanchorAll', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在重新锚定书签…' },
        async () => {
          const uris = new Map<string, vscode.Uri>();
          for (const bookmark of allBookmarks(service)) {
            const uri = service.resolveUri(bookmark);
            if (uri !== undefined) uris.set(uri.toString(), uri);
          }
          let failed = 0;
          for (const uri of uris.values()) {
            try {
              // 必须走 workspace API 而不是 node:fs：扩展跑在 UI 侧，远程场景下本机根本没有这些文件。
              await service.reanchorDocument(await vscode.workspace.openTextDocument(uri));
            } catch {
              failed += 1;
            }
          }
          void vscode.window.showInformationMessage(
            failed === 0 ? '书签已重新锚定。' : `书签已重新锚定，其中 ${failed} 个文件无法读取。`,
          );
        },
      );
    }),

    register('myBookmark.repairTree', async () => {
      const repaired = await service.repairTree();
      void vscode.window.showInformationMessage(
        repaired === 0 ? '没有需要清理的孤立书签。' : `已把 ${repaired} 条孤立书签移到根目录。`,
      );
    }),

    register('myBookmark.rebalanceOrder', async () => {
      const rebalanced = await service.rebalanceOrder();
      void vscode.window.showInformationMessage(
        rebalanced === 0 ? '书签顺序无需重排。' : `已重排 ${rebalanced} 项的顺序。`,
      );
    }),
  ];
}

async function openBookmark(service: BookmarkService, bookmark: Bookmark): Promise<void> {
  const uri = service.resolveUri(bookmark);
  if (uri === undefined) throw new Error('书签所属的工作区当前未打开，无法跳转');
  const document = await vscode.workspace.openTextDocument(uri);
  const line = Math.min(service.getLine(bookmark), Math.max(0, document.lineCount - 1));
  const position = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(document, {
    selection: new vscode.Selection(position, position),
    preview: false,
  });
}

async function jumpTo(service: BookmarkService, direction: 1 | -1): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return;
  const lines = service.getBookmarksForDocument(editor.document.uri)
    .map((bookmark) => service.getLine(bookmark))
    .sort((left, right) => left - right);
  if (lines.length === 0) return;

  const current = editor.selection.active.line;
  const next = direction === 1
    ? lines.find((line) => line > current) ?? lines[0]!
    : [...lines].reverse().find((line) => line < current) ?? lines[lines.length - 1]!;
  const position = new vscode.Position(Math.min(next, Math.max(0, editor.document.lineCount - 1)), 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function allBookmarks(service: BookmarkService): Bookmark[] {
  const result: Bookmark[] = [];
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'bookmark') result.push(node.bookmark);
      else walk(node.children);
    }
  };
  walk(service.getTree());
  return result;
}

function countBookmarksUnder(service: BookmarkService, folderId: string): number {
  const walk = (nodes: readonly TreeNode[]): number => nodes.reduce(
    (total, node) => total + (node.kind === 'bookmark' ? 1 : walk(node.children)),
    0,
  );
  const find = (nodes: readonly TreeNode[]): TreeNode | undefined => {
    for (const node of nodes) {
      if (node.kind !== 'folder') continue;
      if (node.folder.id === folderId) return node;
      const found = find(node.children);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const target = find(service.getTree());
  return target === undefined || target.kind !== 'folder' ? 0 : walk(target.children);
}

function locationLabel(bookmark: Bookmark): string {
  return bookmark.location.kind === 'workspace'
    ? `${bookmark.location.folderName}/${bookmark.location.relativePath}`
    : bookmark.location.fsPath;
}
