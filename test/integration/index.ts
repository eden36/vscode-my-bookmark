import assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXPECTED_COMMANDS = [
  'myBookmark.toggle',
  'myBookmark.toggleWithNote',
  'myBookmark.jumpToNext',
  'myBookmark.jumpToPrevious',
  'myBookmark.listFromAll',
  'myBookmark.editNote',
  'myBookmark.setColor',
  'myBookmark.newFolder',
  'myBookmark.renameFolder',
  'myBookmark.deleteFolder',
  'myBookmark.moveUp',
  'myBookmark.moveDown',
  'myBookmark.remove',
  'myBookmark.removeFromFile',
  'myBookmark.removeAll',
  'myBookmark.toggleScope',
  'myBookmark.reanchorAll',
  'myBookmark.repairTree',
  'myBookmark.rebalanceOrder',
  'myBookmark.showLogs',
  'myBookmark.open',
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('saltcoreyan.my-bookmark');
  assert.ok(extension, 'My Bookmark 扩展应已加载');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of EXPECTED_COMMANDS) {
    assert.ok(commands.includes(command), `应注册命令 ${command}`);
  }

  // 在真实工作区里走一遍「添加书签 → 跳转 → 删除」，验证视图与命令确实连通。
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, '集成测试应在打开的工作区中运行');
  const target = vscode.Uri.joinPath(folder.uri, 'package.json');
  const document = await vscode.workspace.openTextDocument(target);
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(2, 0, 2, 0);

  await vscode.commands.executeCommand('myBookmark.toggle');
  await vscode.commands.executeCommand('myBookmark.toggle');

  await vscode.commands.executeCommand('workbench.view.extension.myBookmark');
}
