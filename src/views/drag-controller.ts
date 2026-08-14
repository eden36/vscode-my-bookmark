import * as vscode from 'vscode';
import type { BookmarkService } from '../bookmark-service';
import type { TreeNode } from '../core/tree';
import { nodeId } from './tree-provider';

const MIME_TYPE = 'application/vnd.code.tree.mybookmark.tree';

/**
 * 拖拽只负责「移动到某个文件夹」。
 *
 * 原生树视图的 drop 只告诉你落在哪个节点上，没有「两项之间」的插入位置，也没有插入指示线，
 * 因此同级的精确调序交给 Alt+↑/↓ 命令，而不是猜测用户想插到目标的前面还是后面。
 */
export class BookmarkDragController implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dropMimeTypes = [MIME_TYPE];
  readonly dragMimeTypes = [MIME_TYPE];

  constructor(
    private readonly service: BookmarkService,
    private readonly onError: (error: unknown) => void,
  ) {}

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem(source.map(nodeId)));
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const ids = readIds(dataTransfer.get(MIME_TYPE)?.value);
    if (ids.length === 0) return;
    // 落在书签上时按「移动到它所在的文件夹」处理——这是唯一没有歧义的解释。
    const targetFolderId = target === undefined
      ? undefined
      : target.kind === 'folder' ? target.folder.id : target.bookmark.folderId;

    try {
      await this.service.moveToFolder(ids, targetFolderId);
    } catch (error) {
      this.onError(error);
    }
  }
}

function readIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
