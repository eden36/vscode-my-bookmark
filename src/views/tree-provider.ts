import * as vscode from 'vscode';
import type { BookmarkService } from '../bookmark-service';
import type { Bookmark, BookmarkColor, BookmarkFolder } from '../core/model';
import type { TreeNode } from '../core/tree';

export const BOOKMARK_TREE_VIEW_ID = 'myBookmark.tree';

export class BookmarkTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  private roots: TreeNode[] = [];
  private readonly parents = new Map<string, TreeNode>();
  private readonly nodes = new Map<string, TreeNode>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly service: BookmarkService) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  /** 按 id 找回当前树中的节点，供命令与 reveal 使用。 */
  findNode(id: string): TreeNode | undefined {
    return this.nodes.get(id);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element.kind === 'folder' ? this.folderItem(element.folder) : this.bookmarkItem(element.bookmark);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element === undefined) {
      this.roots = this.service.getTree();
      this.parents.clear();
      this.nodes.clear();
      this.index(this.roots, undefined);
      return this.roots;
    }
    return element.kind === 'folder' ? element.children : [];
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return this.parents.get(nodeId(element));
  }

  private index(nodes: readonly TreeNode[], parent: TreeNode | undefined): void {
    for (const node of nodes) {
      const id = nodeId(node);
      this.nodes.set(id, node);
      if (parent !== undefined) this.parents.set(id, parent);
      if (node.kind === 'folder') this.index(node.children, node);
    }
  }

  private folderItem(folder: BookmarkFolder): vscode.TreeItem {
    const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.Collapsed);
    // 树节点每次刷新都是新对象，稳定的 id 是 VS Code 记住展开状态的唯一依据。
    item.id = folder.id;
    item.contextValue = 'folder';
    item.iconPath = new vscode.ThemeIcon('folder', themeColor(folder.color));
    return item;
  }

  private bookmarkItem(bookmark: Bookmark): vscode.TreeItem {
    const line = this.service.getLine(bookmark);
    const uri = this.service.resolveUri(bookmark);
    const fileName = uri === undefined ? locationLabel(bookmark) : basename(uri.path);

    // 优先显示备注；没有备注时退回创建时记录的行内容，比只显示文件名有用得多。
    const label = bookmark.note?.trim() || bookmark.anchorText?.trim() || fileName;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = bookmark.id;
    item.contextValue = 'bookmark';
    item.description = `${fileName}:${line + 1}`;
    item.iconPath = new vscode.ThemeIcon(uri === undefined ? 'warning' : 'bookmark', themeColor(bookmark.color));
    item.tooltip = this.tooltip(bookmark, line, uri);
    if (uri !== undefined) {
      item.command = { command: 'myBookmark.open', title: '打开书签', arguments: [bookmark.id] };
    }
    return item;
  }

  private tooltip(bookmark: Bookmark, line: number, uri: vscode.Uri | undefined): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    if (bookmark.note) tooltip.appendMarkdown(`**${escapeMarkdown(bookmark.note)}**\n\n`);
    tooltip.appendMarkdown(`${escapeMarkdown(locationLabel(bookmark))}:${line + 1}\n\n`);
    if (bookmark.anchorText) tooltip.appendCodeblock(bookmark.anchorText.trim());
    // 工作区没打开时路径解析不出来，此时提示用户原因，而不是让书签看起来像坏了。
    if (uri === undefined) tooltip.appendMarkdown('\n\n所属工作区当前未打开，暂时无法跳转。');
    return tooltip;
  }
}

export function nodeId(node: TreeNode): string {
  return node.kind === 'folder' ? node.folder.id : node.bookmark.id;
}

function themeColor(color: BookmarkColor | undefined): vscode.ThemeColor {
  return new vscode.ThemeColor(`myBookmark.color.${color ?? 'default'}`);
}

function locationLabel(bookmark: Bookmark): string {
  return bookmark.location.kind === 'workspace'
    ? `${bookmark.location.folderName}/${bookmark.location.relativePath}`
    : bookmark.location.fsPath;
}

function basename(pathLike: string): string {
  const index = pathLike.lastIndexOf('/');
  return index < 0 ? pathLike : pathLike.slice(index + 1);
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}
