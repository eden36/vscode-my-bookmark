import * as vscode from 'vscode';
import type { BookmarkService } from '../bookmark-service';
import type { TreeNode } from '../core/tree';
import { nodeId } from './tree-provider';

const MIME_TYPE = 'application/vnd.code.tree.mybookmark.tree';

/**
 * 书签或文件夹拖到书签上时，都会与其同级并排在其后；拖到文件夹或工作区分组节点上则移到其根级；
 * 拖到空白处则各自回到自己所属工作区的根级。
 *
 * 原生树视图的 drop 只告诉你落在哪个节点上，没有「两项之间」的插入位置，也没有插入指示线，
 * 因此拖拽落到书签上固定解释为「排在其后」。跨工作区的移动一律拒绝，由 `onError` 提示用户。
 */
export class BookmarkDragController implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dropMimeTypes = [MIME_TYPE];
  readonly dragMimeTypes = [MIME_TYPE];

  constructor(
    private readonly service: BookmarkService,
    private readonly onError: (error: unknown) => void,
  ) {}

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    // 工作区分组节点不对应任何记录，不能作为拖拽来源。
    const ids = source.filter((node) => node.kind !== 'workspace').map(nodeId);
    dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem(ids));
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const ids = readIds(dataTransfer.get(MIME_TYPE)?.value);
    if (ids.length === 0) return;

    try {
      if (target === undefined) await this.service.moveToOwnRoot(ids);
      else if (target.kind === 'bookmark') await this.service.moveAfterBookmark(ids, target.bookmark.id);
      else if (target.kind === 'folder') await this.service.moveToFolder(ids, target.folder.id, target.folder.workspace);
      else await this.service.moveToFolder(ids, undefined, target.workspace);
    } catch (error) {
      this.onError(error);
    }
  }
}

function readIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
