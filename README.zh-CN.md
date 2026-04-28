# Work Task Board

Work Task Board 是一个 Markdown 优先的 Obsidian 工作任务看板插件，用于把日常工作任务按截止日期自动路由到月度目录和周看板文件中，并提供跨周汇总看板。

插件会在 Obsidian 内渲染原生看板视图，但底层数据仍然是普通 Markdown 任务行，因此即使不使用插件，也可以直接阅读和编辑原始 Markdown 文件。

## 主要功能

- 从 ribbon、命令、周看板或总看板快速创建任务。
- 根据任务截止日期自动路由到对应月份和周文件。
- 将周 Markdown 文件自动打开为原生看板视图。
- 将 `总看板.md` 自动打开为跨周汇总看板。
- 支持 Todo、Doing、Done 三列。
- 支持拖拽顶层任务卡片切换状态。
- 支持最多三层嵌套子任务。
- 支持开始日期、截止日期、完成日期、负责人和备注。
- 支持搜索、状态过滤、逾期/本周过滤和负责人多选过滤。
- 保持 Markdown 作为唯一数据源。

## 数据格式

任务以 Markdown 任务列表保存：

```markdown
- [ ] 准备发布说明 — 检查相关反馈 @张三 @李四 🛫 2026-05-18 📅 2026-05-22
  - [ ] 确认变更日志 @张三 📅 2026-05-21
- [x] 确认周看板路由 ✅ 2026-05-28 📅 2026-05-28
```

支持的元数据：

- `@name`：负责人，可多个。
- `🛫 YYYY-MM-DD`：开始日期。
- `📅 YYYY-MM-DD`：截止日期。
- `✅ YYYY-MM-DD`：完成日期。

## 默认目录结构

```text
工作日志/工作任务看板/
  总看板.md
  2026-04/
    第4周.md
  2026-05/
    第1周.md
```

可以在插件设置中修改看板根目录。

## 安装方式

1. 从 GitHub Release 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 在 Obsidian vault 中创建目录：

   ```text
   .obsidian/plugins/work-task-board/
   ```

3. 将下载的文件放入该目录。
4. 重启 Obsidian。
5. 在 Community plugins 中启用 Work Task Board。

## 许可证

MIT
