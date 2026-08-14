# My Bookmark

支持文件夹分组、自定义备注与手动排序的 VS Code 书签插件。

## 特性

- **书签文件夹**：任意层级的逻辑分组，与文件系统目录无关。
- **自定义备注**：每条书签可写备注，侧边栏与编辑器行尾均可显示。
- **手动排序**：拖拽移动到文件夹，`Alt+↑/↓` 精确调整同级顺序。
- **全局书签**：不绑定单个项目，跨工作区、跨 Profile、多窗口实时共享同一份数据。
- **跨设备同步**：通过 VS Code 官方 Settings Sync 同步到其他设备。

## 数据与隐私

书签数据存放在本机用户目录下的共享文件中，同一台机器上的所有 VS Code 窗口与 Profile 共用同一份数据。

启用跨设备同步时，**书签备注与文件路径会随 VS Code Settings Sync 明文上传到你的账号**。如不希望如此，可将 `myBookmark.sync.enabled` 设为 `false`——关闭后仍保留本机跨窗口、跨 Profile 的共享能力。

## 开发

```bash
npm install
npm run check:unit     # 类型检查 + lint + 单测 + 构建
npm run check          # 追加集成测试（需要本机已安装 VS Code）
npm run dev:vscode     # 启动扩展开发宿主
```

按 F5 可附加调试器（详见 `.vscode/debug.env.example`）。

## License

MIT
