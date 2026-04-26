# AGENTS.md

This file defines the working rules for agents developing Work Task Board.

## Project purpose

Work Task Board is an Obsidian plugin for managing work tasks as monthly and weekly kanban boards.

The plugin is being prepared as a standalone repository named `work-task-board`.

Treat `work-task-board/` as the project root.

## Product principles

- Keep Markdown as the source of truth.
- Do not depend on the Obsidian Kanban community plugin.
- Render weekly board files and the dashboard with a native plugin view.
- Keep the plugin usable even if the user opens the underlying Markdown directly.
- Prefer a focused work-task flow over a full project management system.

## Current architecture

The plugin is currently a no-build CommonJS prototype:

```text
manifest.json
main.js
styles.css
README.md
AGENTS.md
CLAUDE.md
```

There is no TypeScript setup, package manager setup, build pipeline, test runner, or release workflow yet.

## Current data model

Weekly board files are plain Markdown files under the configured board root.

Default board root:

```text
工作日志/工作任务看板
```

Default structure:

```text
工作日志/工作任务看板/
  总看板.md
  2026-04/
    第4周.md
  2026-05/
    第1周.md
```

Task line format:

```markdown
- [ ] Task title — optional note @张三 @李四 🛫 2026-05-18 📅 2026-05-22
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

Cards show at most three assignees. Extra assignees are displayed as `+N`.

## Date and week rules

The default routing rule is month-internal date range:

```text
1-7    -> 第1周
8-14   -> 第2周
15-21  -> 第3周
22-28  -> 第4周
29-31  -> 第5周
```

Task routing is based on due date.

Weekly board `New task` defaults are based on the natural Monday-Friday work week associated with the board. The work-week mapping uses the midpoint of the board's month-internal date range, then maps that midpoint to Monday-Friday.

Examples:

```text
2026-04/第4周.md -> 2026-04-20 to 2026-04-24
2026-04/第5周.md -> 2026-04-27 to 2026-05-01
2026-05/第4周.md -> 2026-05-25 to 2026-05-29
```

Work-week defaults may cross month boundaries.

## Current behavior to preserve

- Clicking a weekly board Markdown file auto-opens the native weekly kanban view.
- Clicking `总看板.md` auto-opens the native dashboard kanban view.
- The `Markdown` button bypasses auto-open temporarily so the source file can be viewed.
- Existing board tabs are reused where possible to avoid duplicate tabs.
- The dashboard scans weekly Markdown files; it does not copy tasks into `总看板.md`.
- Open board views refresh when relevant vault files are created, modified, deleted, or renamed.
- Search should not rebuild the search input itself, otherwise it loses focus while typing.

## UI direction

The visual direction is Ink Ledger:

- dense workbench layout
- low decoration
- Obsidian-native surfaces
- monospace metadata
- Markdown-first behavior

Do not introduce generic purple-blue gradient UI, glassmorphism, or unrelated decorative surfaces.

## Development rules

- Prefer small targeted changes.
- Do not introduce dependencies unless the user explicitly approves.
- Do not add a framework before the plugin has been moved to a proper standalone repository and build setup.
- Keep data backward compatible with existing Markdown task lines.
- Preserve old tasks that only have `📅` and no assignee or start date.
- When editing parsing or formatting logic, test old and new task formats.
- When changing date logic, test these known regression cases:
  - `2026-04/第4周.md -> 2026-04-20 to 2026-04-24`
  - `2026-04/第5周.md -> 2026-04-27 to 2026-05-01`
  - `2026-05/第4周.md -> 2026-05-25 to 2026-05-29`
- When changing search/filter behavior, ensure the search input does not lose focus while typing.
- When changing auto-open behavior, ensure the Markdown source button still works.

## Validation expectations

At minimum, run:

```bash
node --check main.js
```

For feature changes, add a small targeted Node regression check when practical.

Manual Obsidian validation should cover:

1. Open weekly Markdown file from file tree and confirm it becomes a board.
2. Open `总看板.md` and confirm it becomes dashboard board.
3. Use `Markdown` button and confirm source Markdown stays open.
4. Create a task from ribbon/command.
5. Create a task from a weekly board.
6. Drag a card across columns.
7. Edit title, start date, due date, assignees, status, and note.
8. Confirm dashboard refreshes after task changes.

## Next development milestone

Convert this prototype into a real standalone Obsidian plugin repository:

1. Initialize Git in the plugin directory or move the plugin to a new repository.
2. Add `package.json`.
3. Add TypeScript and esbuild.
4. Split `main.js` into modules:
   - board parsing
   - Markdown writing
   - date routing
   - views
   - modals
   - settings
5. Add tests for parsing, formatting, date routing, and task movement.
6. Add `versions.json`.
7. Prepare release packaging.
8. Review Obsidian community plugin submission requirements.

## Files to keep updated

- `README.md`: user-facing project overview and behavior documentation.
- `AGENTS.md`: agent/developer rules and project context.
- `CLAUDE.md`: should point to `AGENTS.md`.
