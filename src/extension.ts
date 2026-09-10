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
  const updateScopePresentation = (): void => {
    treeView.description = config.scope === 'all' ? '全部书签' : '当前工作区';
    void vscode.commands.executeCommand('setContext', 'myBookmark.scope', config.scope);
  };
  updateScopePresentation();

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

  // 同步开关与轮询间隔要能当场生效：关闭同步是隐私相关的操作，静默拖到下次重载才停不合适。
  let sync: SyncService | undefined;
  let syncPolling: vscode.Disposable | undefined;
  const applySyncConfig = (): void => {
    syncPolling?.dispose();
    syncPolling = undefined;
    sync?.dispose();
    sync = undefined;
    if (!config.syncEnabled) return;
    const created = new SyncService(storage, log);
    sync = created;
    syncPolling = startSyncPolling(
      () => created.reconcile(),
      (error) => logError('定时同步失败', error),
      config.syncIntervalMinutes * 60_000,
    );
  };
  applySyncConfig();
  context.subscriptions.push({
    dispose: () => {
      syncPolling?.dispose();
      sync?.dispose();
    },
  });

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
      const previous = config;
      config = readConfig();
      updateScopePresentation();
      decorations.setShowNote(config.showNoteInEditor);
      service.applyConfig(config);

      if (config.syncEnabled !== previous.syncEnabled || config.syncIntervalMinutes !== previous.syncIntervalMinutes) {
        applySyncConfig();
        log(`同步设置已更新 启用=${config.syncEnabled} 间隔=${config.syncIntervalMinutes}`);
        // 刚打开同步时立刻对一次账，不必让用户干等一个轮询周期。
        void sync?.reconcile().catch((error: unknown) => logError('同步失败', error));
      }
      // 数据目录换了要重开 StorageService 与文件监听，热切换的收益不值当，交给用户重载窗口。
      if (config.dataDirectory !== previous.dataDirectory) {
        void vscode.window.showInformationMessage('书签数据目录已修改，重新加载窗口后生效。', '重新加载窗口')
          .then((choice) => {
            if (choice === '重新加载窗口') void vscode.commands.executeCommand('workbench.action.reloadWindow');
          });
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const edits = toLineEdits(event.contentChanges);
      if (edits.length === 0) return;
      // 书签行号位移才重画装饰，且只刷发生编辑的那个编辑器：书签上千时每次击键
      // 全量重建所有可见编辑器的装饰会拖垮输入。
      if (!service.trackDocumentEdits(event.document.uri, edits)) return;
      const key = event.document.uri.toString();
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === key) decorations.refresh(editor);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void service.flushDocument(document.uri).catch((error: unknown) => logError('保存书签行号失败', error));
    }),
    vscode.workspace.onDidCloseTextDocument((document) => service.discardDocument(document.uri)),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.scheme !== 'file') return;
      void service.reanchorDocument(document).catch((error: unknown) => logError('重新锚定书签失败', error));
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      // 装订线装饰没有点击事件，只能从鼠标选中的行反查书签；键盘移动不应改变侧边栏选中项。
      if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
      // reveal 会主动显示不可见的视图；用户在编辑器中点击不应因此切走当前侧边栏。
      if (!treeView.visible) return;
      const line = event.textEditor.selection.active.line;
      const bookmark = service.getBookmarksForDocument(event.textEditor.document.uri)
        .find((item) => service.getLine(item) === line);
      if (bookmark === undefined) return;
      const node = provider.findNode(bookmark.id);
      if (node === undefined) return;
      void treeView.reveal(node, { expand: true, focus: false, select: true })
        .then(undefined, (error: unknown) => logError('定位侧边栏书签失败', error));
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.refreshAll()),
  );

  function updateMessage(): void {
    const error = service.getLastError();
    if (error !== undefined) {
      treeView.message = service.isReadOnly() ? `书签数据当前只读：${error}` : undefined;
      return;
    }
    if (service.getTree().length === 0) {
      treeView.message = config.scope === 'currentWorkspace' ? '当前工作区没有书签。' : '尚未添加书签。';
      return;
    }
    treeView.message = undefined;
  }

  void (async () => {
    const failures: string[] = [];
    await runStartupStep(failures, log, '初始化书签数据', () => service.initialize());
    // onDidOpenTextDocument 只对新打开的文档触发，窗口恢复出来的那些编辑器不会补发事件，
    // 切分支后重开 VS Code 时它们的书签行号会一直停在旧位置，只能在这里补一次。
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== 'file') continue;
      try {
        await service.reanchorDocument(document);
      } catch (error) {
        logError('重新锚定书签失败', error);
      }
    }
    const current = sync;
    if (current !== undefined) await runStartupStep(failures, log, '同步书签', () => current.reconcile());
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
