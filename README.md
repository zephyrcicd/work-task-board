# Work Task Board

Work Task Board is an Obsidian plugin for managing work tasks as weekly kanban boards.

The plugin keeps Markdown as the source of truth. It renders board files as a native kanban view, but the underlying data remains normal Markdown task lines.

## Goal

This plugin is built for a personal work dashboard in Obsidian.

It solves one specific workflow:

1. Create a task quickly from a ribbon button or command.
2. Use the task due date to route it into the right month and week.
3. Manage tasks in Todo, Doing, and Done columns.
4. Open a dashboard that shows tasks across all weekly boards.

## Current status

This is a local plugin prototype inside this vault.

Current plugin directory:

```text
work-task-board/
  manifest.json
  main.js
  styles.css
  README.md
  AGENTS.md
  CLAUDE.md
```

The plugin is currently written as a no-build CommonJS plugin. There is no package manager setup, build pipeline, release manifest, or published plugin repository yet.

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

The default root folder can be changed in plugin settings.

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

There is also a calendar-week option in settings.

## Markdown data format

Each weekly board is still a Markdown file.

Example:

```markdown
# 2026-05 第4周工作看板

> Routed by Work Task Board. New tasks land in Todo by due date.

## Todo
- [ ] Prepare release notes — check stakeholder comments @张三 @李四 🛫 2026-05-18 📅 2026-05-22

## Doing
- [/] Review dashboard behavior 📅 2026-05-27

## Done
- [x] Confirm weekly board routing 📅 2026-05-28
```

The plugin recognizes these checkbox states:

```text
- [ ] Todo
- [/] Doing
- [x] Done
```

The date markers use Tasks-style emoji fields:

```text
🛫 YYYY-MM-DD  start date
📅 YYYY-MM-DD  due date
```

Assignees are stored inline as `@name` markers:

```text
@张三 @李四
```

A task can have multiple assignees. Cards show at most three assignees; extra assignees are collapsed into a `+N` marker.

## Main features

### Quick task creation

Available entry points:

- Ribbon button
- Command: `Create work task`

The task modal supports:

- task title
- start date
- due date
- assignees
- status
- note

New tasks are routed by due date.

Default dates:

- From the ribbon button, command, or dashboard `New task`: start date and due date default to today.
- From a weekly board `New task`: if today belongs to that board's work week, start date and due date default to today.
- If today does not belong to that board's work week, start date defaults to that board's natural work-week Monday, and due date defaults to that work-week Friday.
- Work-week defaults can cross month boundaries. For example, `2026-04/第5周.md` defaults to `2026-04-27` through `2026-05-01`.
- Week-to-work-week mapping is based on the midpoint of the board's month-internal date range, then mapped to Monday-Friday.

### Weekly board view

Weekly Markdown files under the board root open automatically as kanban views.

The weekly board view supports:

- Todo / Doing / Done columns
- drag cards across columns
- click a card to edit it
- edit title, date, status, and note
- delete a card
- move to previous or next week
- open the source Markdown file

The tab title for weekly boards uses this format:

```text
Board: yy/MM 第x周
```

Example:

```text
Board: 26/05 第4周
```

### Dashboard board view

`总看板.md` also opens automatically as a native kanban dashboard.

The dashboard scans all weekly Markdown files under the board root and combines tasks into one board.

Dashboard cards show:

- due date
- start date
- up to three assignees
- source weekly file

Weekly board cards show date and assignee metadata, but not the source weekly file, because the week is already visible in the board title.

### Search and filters

The board has a search input and a filter dropdown.

Current filters:

- `All tasks`
- `Open tasks`
- `Overdue`
- `This week`

Search checks:

- task title
- task note
- assignees
- source weekly file

The search input only rerenders the card columns, not the full view, so it should not lose focus while typing.

### Auto-open behavior

Managed Markdown files automatically switch into kanban view:

- weekly board files become weekly kanban boards
- `总看板.md` becomes the dashboard kanban view

The `Markdown` button temporarily bypasses auto-open so the source file can be viewed.

The plugin also tries to reuse an existing board tab for the same file instead of creating duplicate tabs.

## Commands

Current commands:

```text
Create work task
Open work task dashboard
Open active work board as kanban
```

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

## Design direction

The visual direction is Ink Ledger:

- dense workbench layout
- low decoration
- Obsidian-native surfaces
- monospace metadata
- Markdown-first behavior

The plugin does not depend on the community Kanban plugin. It implements its own lightweight board view while keeping plain Markdown as storage.

## Known implementation notes

- The plugin listens to Obsidian vault `create`, `modify`, `delete`, and `rename` events to refresh open board views.
- The dashboard does not copy tasks into `总看板.md`; it scans weekly files each time the dashboard view renders.
- Dragging a card between columns updates the Markdown checkbox marker.
- Editing a task date can move the task to a different monthly folder and weekly board file.
- Weekly-board `New task` defaults are calculated from the board's natural Monday-Friday work week, not just the month-internal date range.
- Assignee suggestions are scanned from existing weekly board tasks.
- The source Markdown file is still readable and editable outside the plugin.

## Current limitations

- Dragging supports cross-column movement, not manual ordering inside the same column.
- The parser is designed around the plugin's task format. Complex handwritten task formats may not round-trip cleanly.
- There is no build setup yet.
- There are no automated unit tests yet.
- There is no release packaging for Obsidian community plugin submission yet.

## Suggested next steps before open sourcing

1. Initialize Git in the plugin directory or move the plugin to a standalone repository.
2. Add `package.json`, TypeScript, esbuild, and an Obsidian plugin build setup.
3. Split `main.js` into modules:
   - board parsing
   - Markdown writing
   - views
   - modals
   - settings
4. Add regression tests for parsing and task movement.
5. Add `versions.json`.
6. Add release notes.
7. Review Obsidian community plugin submission requirements.
