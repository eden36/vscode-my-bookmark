import * as vscode from 'vscode';
import type { BookmarkService } from '../bookmark-service';
import type { TreeNode } from '../core/tree';
import { nodeId } from './tree-provider';

const MIME_TYPE = 'application/vnd.code.tree.mybookmark.tree';

/**
 * 书签或文件夹拖到书签上时，都会与其同级并排在其后。
 *
 * 原生树视图的 drop 只告诉你落在哪个节点上，没有「两项之间」的插入位置，也没有插入指示线，
 * 因此拖拽落到书签上固定解释为「排在其后」。
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

    try {
      if (target?.kind === 'bookmark') await this.service.moveAfterBookmark(ids, target.bookmark.id);
      else await this.service.moveToFolder(ids, target?.folder.id);
    } catch (error) {
      this.onError(error);
    }
  }
}

function readIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
