import * as vscode from 'vscode';
import type { BookmarkService } from './bookmark-service';

/**
 * 让书签跟随文件的重命名与移动。
 *
 * 只能捕获在 VS Code 内发生的改动；在外部改名的文件由「重新锚定」与失效提示兜底。
 */
export function registerFileEvents(
  service: BookmarkService,
  log: (message: string) => void,
): vscode.Disposable[] {
  return [
    vscode.workspace.onDidRenameFiles((event) => {
      void service.relocate(event.files).catch((error: unknown) => {
        log(`更新重命名文件的书签失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
      });
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      // 刻意不删书签：文件可能是被 git 操作临时移走，删掉就再也回不来了。
      // 只打上失效标记，树里显示为警告态，由用户决定去留。
      service.markMissing(event.files);
      log(`已删除 ${event.files.length} 个文件，相关书签保留并标记为暂不可用`);
    }),
  ];
}
