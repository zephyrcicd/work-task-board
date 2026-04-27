# Work Task Board

Work Task Board is a Markdown-first Obsidian plugin for managing work tasks as weekly kanban boards and a cross-week dashboard.

The plugin renders native board views inside Obsidian, while keeping the underlying data as normal Markdown task lines.

## Features

- Create work tasks from a ribbon action, command, weekly board, or dashboard.
- Route tasks into monthly folders and weekly board files by due date.
- Open weekly Markdown files as native kanban boards.
- Open `总看板.md` as a dashboard that scans all weekly board files.
- Manage Todo, Doing, and Done columns.
- Drag top-level cards between columns.
- Add nested subtasks up to three levels deep.
- Track start date, due date, completion date, assignees, and notes.
- Filter cards by search, status, due date, and assignee chips.
- Preserve Markdown as the source of truth.

## Markdown data format

Weekly board files are plain Markdown files under the configured board root.

Example:

```markdown
# 2026-05 第4周工作看板

> Routed by Work Task Board. New tasks land in Todo by due date.

## Todo
- [ ] Prepare release notes — check stakeholder comments @Alice @Bob 🛫 2026-05-18 📅 2026-05-22
  - [ ] Confirm changelog @Alice 📅 2026-05-21

## Doing
- [/] Review dashboard behavior 📅 2026-05-27

## Done
- [x] Confirm weekly board routing ✅ 2026-05-28 📅 2026-05-28
```

Supported task states:

```text
- [ ] Todo
- [/] Doing
- [x] Done
```

Supported metadata:

- `@name`: assignee. A task can have multiple assignees.
- `🛫 YYYY-MM-DD`: start date.
- `📅 YYYY-MM-DD`: due date.
- `✅ YYYY-MM-DD`: completion date.

Notes are stored inline after an em dash (`—`). Multi-line notes are preserved by escaping line breaks in the task line and rendering them as line breaks in the board view.

## Default file structure

By default, board files are stored under:

```text
工作日志/工作任务看板/
  总看板.md
  2026-04/
    第4周.md
  2026-05/
    第1周.md
```

The board root folder can be changed in plugin settings.

## Week routing rule

The default week rule is date range inside the month:

```text
1-7    -> 第1周
8-14   -> 第2周
15-21  -> 第3周
22-28  -> 第4周
29-31  -> 第5周
```

For example:

```text
2026-04-26 -> 工作日志/工作任务看板/2026-04/第4周.md
2026-05-26 -> 工作日志/工作任务看板/2026-05/第4周.md
```

A calendar-week option is also available in settings.

## Board views

### Weekly board

Weekly Markdown files under the board root open automatically as kanban views.

Weekly boards support:

- Todo / Doing / Done columns
- top-level card drag between columns
- card editing
- task deletion
- nested subtasks up to three levels
- previous / next week navigation
- source Markdown access

### Dashboard

`总看板.md` opens automatically as a dashboard board.

The dashboard scans weekly Markdown files under the board root and combines tasks into one native board view. It does not copy tasks into the dashboard file.

Creating a task from the dashboard keeps you on the dashboard. Creating a task from the ribbon or command can still open the target weekly board, depending on settings.

## Search and filters

The board supports:

- search by title, note, assignee, and source weekly file
- All tasks
- Open tasks
- Overdue
- This week
- assignee chip multi-select filtering

Search rerenders only the card columns, so the search input should not lose focus while typing.

## Settings

Current settings:

- board root folder
- week rule
- open weekly board after task creation
- Todo status name
- Doing status name
- Done status name

Default settings:

```js
{
  boardRoot: "工作日志/工作任务看板",
  inboxStatus: "Todo",
  doingStatus: "Doing",
  doneStatus: "Done",
  weekRule: "date-range",
  openWeeklyBoardAfterCreate: true
}
```

## Commands

```text
Create work task
Open work task dashboard
Open active work board as kanban
```

## Installation

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from a release.
2. Create this folder in your vault:

   ```text
   .obsidian/plugins/work-task-board/
   ```

3. Place the downloaded files in that folder.
4. Reload Obsidian.
5. Enable Work Task Board in Community plugins.

## Development

This repository currently ships a no-build CommonJS plugin prototype.

```text
manifest.json
main.js
styles.css
README.md
versions.json
LICENSE
```

There is no package manager setup or build pipeline yet.

## License

MIT
