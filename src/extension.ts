import * as vscode from 'vscode';
import { BookmarkService } from './bookmark-service';
import { registerCommands } from './commands';
import { onDidChangeConfig, readConfig } from './config';
import type { LineEdit } from './core/tracker';
import { BookmarkDecorations } from './decorations';
import { registerFileEvents } from './file-events';
import { SharedStateLockBusyError, StorageService } from './storage';
import { startSyncPolling, SyncService } from './sync';
import { BookmarkDragController } from './views/drag-controller';
import { BOOKMARK_TREE_VIEW_ID, BookmarkTreeProvider } from './views/tree-provider';

const STARTUP_LOCK_RETRIES = 2;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('My Bookmark');
  const log = (message: string): void => output.appendLine(`[${new Date().toISOString()}] ${message}`);
  const logError = (scope: string, error: unknown): void => {
    log(`${scope} 类别=${error instanceof Error ? error.name : 'unknown'}`);
  };

  let config = readConfig();
  const storage = new StorageService(context, {
    ...(config.dataDirectory ? { directory: config.dataDirectory } : {}),
    onWarning: (message) => log(message),
  });
  const service = new BookmarkService(storage, log);
  const provider = new BookmarkTreeProvider(service);
  const decorations = new BookmarkDecorations(service, config.showNoteInEditor);

  // 先注册视图与命令、把初始化推到后台：多窗口下抢共享文件锁可能要等上几秒，
  // 期间用户至少能看到面板和日志入口，而不是一个没有反应的空侧边栏。
  const treeView = vscode.window.createTreeView(BOOKMARK_TREE_VIEW_ID, {
    treeDataProvider: provider,
    dragAndDropController: new BookmarkDragController(service, (error) => {
      logError('拖拽移动失败', error);
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : '移动失败');
    }),
    showCollapseAll: true,
    canSelectMany: true,
  });
  treeView.message = '正在加载书签…';

  context.subscriptions.push(
    output,
    storage,
    service,
    decorations,
    treeView,
    vscode.commands.registerCommand('myBookmark.showLogs', () => output.show()),
    ...registerCommands(service, provider, treeView, log),
    ...registerFileEvents(service, log),
  );

  const sync = config.syncEnabled ? new SyncService(storage, log) : undefined;
  if (sync !== undefined) {
    context.subscriptions.push(
      sync,
      startSyncPolling(
        () => sync.reconcile(),
        (error) => logError('定时同步失败', error),
        config.syncIntervalMinutes * 60_000,
      ),
    );
  }

  context.subscriptions.push(
    storage.onDidChange((change) => {
      log(`书签数据已更新 来源=${change.source}`);
      service.refreshFromStorage();
      // 本窗口的改动需要发布出去；其他来源的改动本身就来自同步，再推一次只会形成回声。
      if (change.source === 'local') sync?.schedulePublish();
      else if (change.source === 'external') void sync?.reconcile().catch((error: unknown) => logError('同步失败', error));
    }),
    service.onDidChange(() => {
      provider.refresh();
      decorations.refreshAll();
      updateMessage();
    }),
    onDidChangeConfig(() => {
      config = readConfig();
      decorations.setShowNote(config.showNoteInEditor);
      service.applyConfig(config);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const edits = toLineEdits(event.contentChanges);
      if (edits.length === 0) return;
      // 行号变化只重画装饰，绝不刷新整棵树：书签上千时每次击键重建一遍会拖垮编辑器。
      if (service.trackDocumentEdits(event.document.uri, edits)) decorations.refreshAll();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void service.flushDocument(document.uri).catch((error: unknown) => logError('保存书签行号失败', error));
    }),
    vscode.workspace.onDidCloseTextDocument((document) => service.discardDocument(document.uri)),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.scheme !== 'file') return;
      void service.reanchorDocument(document).catch((error: unknown) => logError('重新锚定书签失败', error));
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.refreshAll()),
  );

  function updateMessage(): void {
    const error = service.getLastError();
    if (error !== undefined) {
      treeView.message = service.isReadOnly() ? `书签数据当前只读：${error}` : undefined;
      return;
    }
    treeView.message = service.getTree().length === 0 ? '尚未添加书签。' : undefined;
  }

  void (async () => {
    const failures: string[] = [];
    await runStartupStep(failures, log, '初始化书签数据', () => service.initialize());
    if (sync !== undefined) await runStartupStep(failures, log, '同步书签', () => sync.reconcile());
    updateMessage();
    decorations.refreshAll();

    const diagnostics = service.getTreeDiagnostics();
    if (diagnostics.cycleBroken.length > 0) log(`已打破 ${diagnostics.cycleBroken.length} 处文件夹循环引用`);
    if (diagnostics.pendingOrphans.length > 0) log(`${diagnostics.pendingOrphans.length} 条书签的文件夹尚未同步到本机`);

    if (failures.length > 0) {
      // 只提示第一条：多个失败往往同源，逐条弹窗只会刷屏。
      void vscode.window.showWarningMessage(`My Bookmark 启动时出现问题：${failures[0]}`, '查看日志')
        .then((choice) => { if (choice === '查看日志') output.show(); });
    }
  })();
}

export function deactivate(): void {
  // 资源统一由 context.subscriptions 释放。
}

/**
 * 启动步骤只对锁冲突重试——那是其他窗口正在写入的可恢复状态；其余错误直接记账。
 * 任何失败都不向外抛，否则一个后台步骤就能让整个扩展激活失败。
 */
async function runStartupStep(
  failures: string[],
  log: (message: string) => void,
  label: string,
  step: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await step();
      return;
    } catch (error) {
      if (error instanceof SharedStateLockBusyError && attempt < STARTUP_LOCK_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      const message = error instanceof Error ? error.message : '未知错误';
      failures.push(`${label}失败（${message}）`);
      log(`${label}失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
      return;
    }
  }
}

function toLineEdits(changes: readonly vscode.TextDocumentContentChangeEvent[]): LineEdit[] {
  return changes.map((change) => ({
    startLine: change.range.start.line,
    // range 覆盖的整行数即被删除的行数：同一行内的编辑不会删除任何整行。
    endLineExclusive: change.range.end.line,
    insertedLineCount: countNewlines(change.text),
  }));
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') count += 1;
  }
  return count;
}
