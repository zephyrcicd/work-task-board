const {
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} = require("obsidian");

const VIEW_TYPE = "work-task-board-view";
const DASHBOARD_FILE = "总看板.md";
const DEFAULT_SETTINGS = {
  boardRoot: "工作日志/工作任务看板",
  inboxStatus: "Todo",
  doingStatus: "Doing",
  doneStatus: "Done",
  weekRule: "date-range",
  openWeeklyBoardAfterCreate: true,
};
const DEFAULT_STATUSES = ["Todo", "Doing", "Done"];
const ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 5.5h14M5 12h14M5 18.5h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4.5 3.75h15A1.75 1.75 0 0 1 21.25 5.5v13A1.75 1.75 0 0 1 19.5 20.25h-15A1.75 1.75 0 0 1 2.75 18.5v-13A1.75 1.75 0 0 1 4.5 3.75Z" stroke="currentColor" stroke-width="1.5"/></svg>`;

module.exports = class WorkTaskBoardPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.manualMarkdownUntil = new Map();
    require("obsidian").addIcon("work-task-board", ICON);

    this.registerView(VIEW_TYPE, (leaf) => new WorkTaskBoardView(leaf, this));
    this.registerEvent(this.app.workspace.on("file-open", (file) => window.setTimeout(() => this.autoOpenBoardFile(file), 0)));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.autoOpenActiveLeaf(leaf)));
    this.registerEvent(this.app.vault.on("create", (file) => this.refreshBoardViewsForFile(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.refreshBoardViewsForFile(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.refreshBoardViewsForFile(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.refreshBoardViewsForFile(file, oldPath)));
    this.addRibbonIcon("work-task-board", "Create work task", () => this.openTaskModal()).addClass("wtb-ribbon-action");
    this.addCommand({ id: "create-work-task", name: "Create work task", callback: () => this.openTaskModal() });
    this.addCommand({ id: "open-work-task-dashboard", name: "Open work task dashboard", callback: () => this.openDashboardView() });
    this.addCommand({
      id: "open-active-work-board",
      name: "Open active work board as kanban",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const canOpen = this.isBoardFile(file);
        if (checking) return canOpen;
        this.openBoardView(file);
      },
    });
    this.addSettingTab(new WorkTaskBoardSettingTab(this.app, this));
    await this.ensureDashboard();
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  openTaskModal(initial = {}) {
    new WorkTaskModal(this.app, this, initial).open();
  }

  openEditModal(task) {
    new WorkTaskModal(this.app, this, task).open();
  }

  async createTask(task) {
    const dueDate = parseDate(task.dueDate);
    if (!dueDate) return new Notice("Use a valid due date: YYYY-MM-DD");
    const route = this.getRoute(dueDate);
    const boardFile = await this.ensureWeeklyBoard(route);
    const targetStatus = task.status || this.settings.inboxStatus;
    await this.insertTaskIntoStatus(boardFile, targetStatus, this.formatTaskLine(this.withCompletionDate(null, task, targetStatus), targetStatus));
    await this.ensureDashboard();
    await this.refreshBoardViewsForFile(boardFile);
    const destination = `${route.monthName}/${route.weekName}.md`;
    const notice = new Notice(`Routed to ${destination}`, 7000);
    if (notice.noticeEl) {
      notice.noticeEl.addClass("wtb-route-notice");
      notice.noticeEl.setAttribute("role", "button");
      notice.noticeEl.setAttribute("tabindex", "0");
      notice.noticeEl.addEventListener("click", () => this.openBoardView(boardFile));
      notice.noticeEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.openBoardView(boardFile);
        }
      });
    }
    if (this.settings.openWeeklyBoardAfterCreate && !task.stayOnCurrentBoard) await this.openBoardView(boardFile);
  }

  async updateTask(task, values) {
    const dueDate = parseDate(values.dueDate);
    if (!dueDate) return new Notice("Use a valid due date: YYYY-MM-DD");

    const currentFile = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!currentFile) return new Notice("Original task file not found");

    const targetStatus = values.status || task.status;
    const nextLine = this.formatTaskLine(this.withCompletionDate(task, values, targetStatus), targetStatus, task.indent || 0);

    if ((task.depth || 1) > 1) {
      await this.replaceTaskLine(currentFile, task, nextLine);
      await this.ensureDashboard();
      return;
    }

    const targetRoute = this.getRoute(dueDate);
    const targetFile = await this.ensureWeeklyBoard(targetRoute);
    if (targetFile.path === task.filePath) {
      await this.replaceTaskLine(currentFile, task, nextLine);
    } else {
      const subtree = await this.removeTaskSubtree(currentFile, task);
      if (!subtree) return;
      subtree[0] = nextLine;
      await this.insertTaskIntoStatus(targetFile, targetStatus, subtree.join("\n"));
    }
    await this.ensureDashboard();
  }

  async createSubtask(parentTask, values) {
    if ((parentTask.depth || 1) >= 3) return new Notice("Nested tasks support up to three levels");
    const dueDate = parseDate(values.dueDate);
    if (!dueDate) return new Notice("Use a valid due date: YYYY-MM-DD");
    const file = this.app.vault.getAbstractFileByPath(parentTask.filePath);
    if (!file) return new Notice("Parent task file not found");
    const lines = (await this.app.vault.read(file)).split("\n");
    const line = this.resolveTaskLine(lines, parentTask);
    if (!line) return new Notice("Parent task moved or changed; reload the board and try again");
    const childStatus = values.status || this.settings.inboxStatus;
    const childLine = this.formatTaskLine(this.withCompletionDate(null, values, childStatus), childStatus, (parentTask.indent || 0) + 2);
    lines.splice(line.endIndex + 1, 0, childLine);
    await this.app.vault.modify(file, lines.join("\n"));
    await this.ensureDashboard();
  }

  withCompletionDate(task, values, status) {
    const done = status === this.settings.doneStatus;
    return Object.assign({}, values, { completionDate: done ? (values.completionDate || task?.completionDate || formatDate(new Date())) : "" });
  }

  async deleteTask(task) {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!file) return;
    await this.removeTaskSubtree(file, task);
  }

  async moveTask(task, targetStatus) {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!file || task.status === targetStatus) return;
    const content = ensureSections(await this.app.vault.read(file), this.statusNames());
    const lines = content.split("\n");
    const line = this.resolveTaskLine(lines, task);
    if (!line) return new Notice("Task moved or changed; reload the board and try again");
    const subtree = lines.splice(line.index, line.endIndex - line.index + 1);
    subtree[0] = convertTaskStatus(subtree[0], targetStatus, this.settings);
    const headingIndex = lines.findIndex((item) => item.trim() === `## ${targetStatus}`);
    lines.splice(headingIndex + 1, 0, ...subtree);
    await this.app.vault.modify(file, lines.join("\n"));
  }

  async replaceTaskLine(file, task, nextLine) {
    const lines = (await this.app.vault.read(file)).split("\n");
    const line = this.resolveTaskLine(lines, task);
    if (!line) return new Notice("Task moved or changed; reload the board and try again");
    lines[line.index] = nextLine;
    await this.app.vault.modify(file, lines.join("\n"));
  }

  async removeTaskLine(file, task) {
    const lines = (await this.app.vault.read(file)).split("\n");
    const line = this.resolveTaskLine(lines, task);
    if (!line) return new Notice("Task moved or changed; reload the board and try again");
    lines.splice(line.index, 1);
    await this.app.vault.modify(file, lines.join("\n"));
  }

  async removeTaskSubtree(file, task) {
    const lines = (await this.app.vault.read(file)).split("\n");
    const line = this.resolveTaskLine(lines, task);
    if (!line) {
      new Notice("Task moved or changed; reload the board and try again");
      return null;
    }
    const removed = lines.splice(line.index, line.endIndex - line.index + 1);
    await this.app.vault.modify(file, lines.join("\n"));
    return removed;
  }

  resolveTaskLine(lines, task) {
    const index = lines[task.lineIndex] === task.raw ? task.lineIndex : lines.findIndex((line) => line === task.raw);
    if (index < 0) return null;
    return { index, endIndex: findTaskSubtreeEnd(lines, index, task.indent || 0), value: lines[index] };
  }

  getRoute(date) {
    const monthName = formatMonth(date);
    const weekNumber = this.settings.weekRule === "calendar-week" ? weekOfMonthByCalendar(date) : weekOfMonthByDateRange(date);
    return this.getRouteByMonthWeek(monthName, weekNumber);
  }

  getRouteByMonthWeek(monthName, weekNumber) {
    const weekName = `第${weekNumber}周`;
    const monthPath = normalizePath(`${this.settings.boardRoot}/${monthName}`);
    return { monthName, weekNumber, weekName, monthPath, filePath: normalizePath(`${monthPath}/${weekName}.md`) };
  }

  getAdjacentRoute(filePath, delta) {
    const parsed = parseRouteFromPath(filePath, this.settings.boardRoot);
    if (!parsed) return null;
    let { year, month, week } = parsed;
    week += delta;
    while (week < 1) {
      month -= 1;
      if (month < 1) { year -= 1; month = 12; }
      week = weeksInMonth(year, month, this.settings.weekRule);
    }
    while (week > weeksInMonth(year, month, this.settings.weekRule)) {
      week = 1;
      month += 1;
      if (month > 12) { year += 1; month = 1; }
    }
    return this.getRouteByMonthWeek(`${year}-${String(month).padStart(2, "0")}`, week);
  }

  async ensureWeeklyBoard(route) {
    await this.ensureFolder(route.monthPath);
    const existing = this.app.vault.getAbstractFileByPath(route.filePath);
    if (existing) {
      await this.ensureBoardSections(existing);
      return existing;
    }
    const content = [
      `# ${route.monthName} ${route.weekName}工作看板`,
      "",
      `> Routed by Work Task Board. New tasks land in ${this.settings.inboxStatus} by due date.`,
      "",
      ...DEFAULT_STATUSES.flatMap((status) => [`## ${this.getStatusName(status)}`, ""]),
    ].join("\n");
    return this.app.vault.create(route.filePath, content);
  }

  async ensureBoardSections(file) {
    const content = await this.app.vault.read(file);
    const next = ensureSections(content, this.statusNames());
    if (next !== content) await this.app.vault.modify(file, next);
  }

  async insertTaskIntoStatus(file, status, taskLine) {
    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, insertUnderHeading(ensureSections(content, this.statusNames()), status, taskLine));
  }

  async getBoard(file) {
    await this.ensureBoardSections(file);
    return parseBoard(await this.app.vault.read(file), file, this.statusNames());
  }

  async getDashboardBoard() {
    const files = this.getBoardFiles();
    const board = { title: "工作任务总看板", mode: "dashboard", tasks: emptyTasks(this.statusNames()) };
    for (const file of files) {
      const parsed = parseBoard(await this.app.vault.read(file), file, this.statusNames());
      for (const status of this.statusNames()) board.tasks[status].push(...parsed.tasks[status]);
    }
    for (const status of this.statusNames()) board.tasks[status].sort(compareTasksByDueDate);
    return board;
  }

  getBoardFiles() {
    const root = normalizePath(this.settings.boardRoot);
    return this.app.vault.getMarkdownFiles()
      .filter((file) => this.isBoardFile(file) && file.path.startsWith(`${root}/`))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  isBoardFile(file) {
    return file instanceof TFile && file.extension === "md" && file.name !== DASHBOARD_FILE && file.path.startsWith(normalizePath(this.settings.boardRoot));
  }

  isDashboardFile(file) {
    return file instanceof TFile && file.extension === "md" && file.path === normalizePath(`${this.settings.boardRoot}/${DASHBOARD_FILE}`);
  }

  isManagedFile(file) {
    return this.isBoardFile(file) || this.isDashboardFile(file);
  }

  formatTaskLine(task, status, indent = 0) {
    const title = task.title.trim().replace(/\s+/g, " ");
    const note = encodeTaskNote(task.note || "");
    const noteText = note ? ` — ${note}` : "";
    const assigneeText = normalizeAssignees(task.assignees || task.assignee).map((assignee) => ` @${assignee}`).join("");
    const startText = task.startDate ? ` 🛫 ${task.startDate}` : "";
    const completionText = task.completionDate ? ` ✅ ${task.completionDate}` : "";
    return `${" ".repeat(indent)}- [${statusMark(status, this.settings)}] ${title}${noteText}${assigneeText}${startText}${completionText} 📅 ${task.dueDate}`;
  }

  async refreshBoardViewsForFile(file, oldPath = "") {
    const path = file?.path || oldPath;
    const isRelevant = this.isManagedFile(file) || (oldPath && oldPath.startsWith(normalizePath(this.settings.boardRoot)));
    if (!isRelevant) return;

    await Promise.all(this.app.workspace.getLeavesOfType(VIEW_TYPE).map((leaf) => {
      const state = leaf.view?.getState?.();
      if (state?.mode === "dashboard" || state?.file === path || state?.file === oldPath) return leaf.view.render();
      return Promise.resolve();
    }));
  }

  async autoOpenBoardFile(file) {
    if (this.shouldBypassAutoOpen(file)) return;
    const leaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
    await this.autoOpenLeafForFile(leaf, file);
  }

  async autoOpenActiveLeaf(leaf) {
    if (!leaf || leaf.view?.getViewType?.() !== "markdown") return;
    const file = leaf.view?.file;
    if (this.shouldBypassAutoOpen(file)) return;
    await this.autoOpenLeafForFile(leaf, file);
  }

  shouldBypassAutoOpen(file) {
    if (!this.isManagedFile(file)) return true;
    const expiresAt = this.manualMarkdownUntil.get(file.path);
    if (!expiresAt) return false;
    if (expiresAt > Date.now()) return true;
    this.manualMarkdownUntil.delete(file.path);
    return false;
  }

  async autoOpenLeafForFile(leaf, file) {
    if (!leaf || !this.isManagedFile(file)) return;
    if (leaf.view?.getViewType?.() === VIEW_TYPE) return;
    const existingLeaf = this.findBoardLeaf(file.path);
    if (existingLeaf && existingLeaf !== leaf) {
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      leaf.detach();
      return;
    }
    const state = this.isDashboardFile(file) ? { mode: "dashboard" } : { mode: "board", file: file.path };
    await leaf.setViewState({ type: VIEW_TYPE, state, active: true });
  }

  findBoardLeaf(filePath) {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).find((leaf) => {
      const state = leaf.view?.getState?.();
      if (filePath === normalizePath(`${this.settings.boardRoot}/${DASHBOARD_FILE}`)) return state?.mode === "dashboard";
      return state?.file === filePath;
    });
  }

  async openMarkdownFile(file) {
    this.manualMarkdownUntil.set(file.path, Date.now() + 1500);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async openBoardView(file) {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, state: { mode: "board", file: file.path }, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async openDashboardView() {
    await this.ensureDashboard();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, state: { mode: "dashboard" }, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async openDashboardMarkdown() {
    await this.ensureDashboard();
    const file = this.app.vault.getAbstractFileByPath(normalizePath(`${this.settings.boardRoot}/${DASHBOARD_FILE}`));
    if (file) await this.openMarkdownFile(file);
  }

  async openRoute(route) {
    const file = await this.ensureWeeklyBoard(route);
    await this.openBoardView(file);
  }

  async ensureDashboard() {
    await this.ensureFolder(this.settings.boardRoot);
    const path = normalizePath(`${this.settings.boardRoot}/${DASHBOARD_FILE}`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const content = this.dashboardContent();
    if (!existing) return this.app.vault.create(path, content);
    const oldContent = await this.app.vault.read(existing);
    if (!oldContent.includes("<!-- work-task-board:start -->")) return;
    const next = oldContent.replace(/<!-- work-task-board:start -->[\s\S]*<!-- work-task-board:end -->/, content.trim());
    if (next !== oldContent) await this.app.vault.modify(existing, next.endsWith("\n") ? next : `${next}\n`);
  }

  dashboardContent() {
    const root = this.settings.boardRoot;
    return `<!-- work-task-board:start -->\n# 工作任务总看板\n\n> Run the command \`Open work task dashboard\` for the native kanban view.\n\n## Todo\n\n\`\`\`tasks\nnot done\nstatus.name includes ${this.settings.inboxStatus}\npath includes ${root}\nsort by due\n\`\`\`\n\n## Doing\n\n\`\`\`tasks\nnot done\nstatus.name includes ${this.settings.doingStatus}\npath includes ${root}\nsort by due\n\`\`\`\n\n## Done\n\n\`\`\`tasks\ndone\npath includes ${root}\nsort by done reverse\n\`\`\`\n<!-- work-task-board:end -->\n`;
  }

  async ensureFolder(path) {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) await this.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`${current} exists and is not a folder`);
    }
  }

  statusNames() {
    return [this.settings.inboxStatus, this.settings.doingStatus, this.settings.doneStatus];
  }

  async getKnownAssignees() {
    const assignees = new Set();
    for (const file of this.getBoardFiles()) {
      const board = parseBoard(await this.app.vault.cachedRead(file), file, this.statusNames());
      for (const status of this.statusNames()) {
        for (const task of board.tasks[status]) {
          for (const assignee of task.assignees) assignees.add(assignee);
        }
      }
    }
    return Array.from(assignees).sort((a, b) => a.localeCompare(b));
  }

  getStatusName(status) {
    if (status === "Todo") return this.settings.inboxStatus;
    if (status === "Doing") return this.settings.doingStatus;
    if (status === "Done") return this.settings.doneStatus;
    return status;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.ensureDashboard();
  }
};

class WorkTaskBoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = "dashboard";
    this.filePath = "";
    this.search = "";
    this.filter = "all";
    this.selectedAssignees = [];
    this.renderSeq = 0;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() {
    return this.mode === "dashboard" ? "Work task dashboard" : `Board: ${formatBoardTabTitle(this.filePath)}`;
  }
  getIcon() { return "work-task-board"; }

  async setState(state, result) {
    await super.setState(state, result);
    this.mode = state.mode || (state.file ? "board" : "dashboard");
    this.filePath = state.file || "";
    await this.render();
  }

  getState() {
    return Object.assign({}, super.getState(), { mode: this.mode, file: this.filePath });
  }

  async onOpen() { await this.render(); }

  async render() {
    const seq = ++this.renderSeq;
    const container = this.containerEl.children[1];
    const board = await this.loadBoard();
    if (seq !== this.renderSeq) return;

    container.empty();
    container.addClass("wtb-board-view");
    if (!board) return container.createEl("p", { text: "Board file not found." });

    this.renderToolbar(container, board);
    this.renderFilters(container, board);
    this.renderColumns(container, board);
  }

  async rerenderColumns() {
    const container = this.containerEl.children[1];
    const oldColumns = container.querySelector(".wtb-board-columns");
    if (!oldColumns) return this.render();
    const board = await this.loadBoard();
    if (!board) return;
    oldColumns.remove();
    this.renderColumns(container, board);
  }

  async loadBoard() {
    if (this.mode === "dashboard") return this.plugin.getDashboardBoard();
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!file) return null;
    return this.plugin.getBoard(file);
  }

  renderToolbar(container, board) {
    const toolbar = container.createDiv({ cls: "wtb-board-toolbar" });
    const titleGroup = toolbar.createDiv();
    titleGroup.createEl("p", { cls: "wtb-kicker", text: this.mode === "dashboard" ? "Dashboard" : "Weekly board" });
    titleGroup.createEl("h2", { text: board.title });

    const actions = toolbar.createDiv({ cls: "wtb-board-actions" });
    actions.createEl("button", { text: "New task" }).addEventListener("click", () => this.plugin.openTaskModal(this.getNewTaskDefaults()));

    if (this.mode === "board") {
      actions.createEl("button", { text: "← Prev" }).addEventListener("click", () => this.openAdjacent(-1));
      actions.createEl("button", { text: "Next →" }).addEventListener("click", () => this.openAdjacent(1));
      actions.createEl("button", { text: "Dashboard" }).addEventListener("click", () => this.plugin.openDashboardView());
      actions.createEl("button", { text: "Markdown" }).addEventListener("click", async () => {
        const file = this.app.vault.getAbstractFileByPath(this.filePath);
        if (file) await this.plugin.openMarkdownFile(file);
      });
    } else {
      actions.createEl("button", { text: "Markdown" }).addEventListener("click", () => this.plugin.openDashboardMarkdown());
    }
  }

  renderFilters(container, board) {
    const filters = container.createDiv({ cls: "wtb-board-filters" });
    const search = filters.createEl("input", { attr: { type: "search", placeholder: "Search cards" } });
    search.value = this.search;
    search.addEventListener("input", async () => { this.search = search.value; await this.rerenderColumns(); });

    const select = filters.createEl("select");
    [
      ["open", "Open tasks"],
      ["all", "All tasks"],
      ["overdue", "Overdue"],
      ["this-week", "This week"],
    ].forEach(([value, label]) => select.createEl("option", { value, text: label }));
    select.value = this.filter;
    select.addEventListener("change", async () => { this.filter = select.value; await this.rerenderColumns(); });

    const assignees = boardAssignees(board, this.plugin.statusNames());
    if (assignees.length) {
      const assigneeFilter = filters.createDiv({ cls: "wtb-assignee-filter" });
      assigneeFilter.createSpan({ cls: "wtb-assignee-filter-label", text: "Assignees" });
      for (const assignee of assignees) {
        const selected = this.selectedAssignees.includes(assignee);
        const chip = assigneeFilter.createEl("button", { cls: selected ? "wtb-assignee-chip is-selected" : "wtb-assignee-chip", text: `@${assignee}` });
        chip.addEventListener("click", async () => {
          this.toggleAssigneeFilter(assignee);
          chip.classList.toggle("is-selected", this.selectedAssignees.includes(assignee));
          clearButton.disabled = this.selectedAssignees.length === 0;
          await this.rerenderColumns();
        });
      }
      const clearButton = assigneeFilter.createEl("button", { cls: "wtb-assignee-clear", text: "Clear" });
      clearButton.disabled = this.selectedAssignees.length === 0;
      clearButton.addEventListener("click", async () => {
        this.selectedAssignees = [];
        assigneeFilter.querySelectorAll(".wtb-assignee-chip").forEach((chip) => chip.classList.remove("is-selected"));
        clearButton.disabled = true;
        await this.rerenderColumns();
      });
    }
  }

  toggleAssigneeFilter(assignee) {
    this.selectedAssignees = this.selectedAssignees.includes(assignee)
      ? this.selectedAssignees.filter((item) => item !== assignee)
      : [...this.selectedAssignees, assignee];
  }

  renderColumns(container, board) {
    const columns = container.createDiv({ cls: "wtb-board-columns" });
    for (const status of this.plugin.statusNames()) {
      const tasks = board.tasks[status].filter((task) => this.shouldShowTaskTree(task));
      const column = columns.createDiv({ cls: "wtb-board-column", attr: { "data-status": status } });
      column.addEventListener("dragover", (event) => { event.preventDefault(); column.addClass("is-drag-over"); });
      column.addEventListener("dragleave", () => column.removeClass("is-drag-over"));
      column.addEventListener("drop", async (event) => {
        event.preventDefault();
        column.removeClass("is-drag-over");
        const task = JSON.parse(event.dataTransfer.getData("application/json"));
        await this.plugin.moveTask(task, status);
      });

      const header = column.createDiv({ cls: "wtb-column-header" });
      header.createEl("h3", { text: status });
      header.createSpan({ text: String(countVisibleLeafTasks(tasks, (task) => this.shouldShowTask(task))) });
      const stack = column.createDiv({ cls: "wtb-card-stack" });
      if (tasks.length === 0) stack.createDiv({ cls: "wtb-empty-column", text: "No cards" });
      for (const task of tasks) this.renderTaskCard(stack, task);
    }
  }

  renderTaskCard(container, task) {
    const card = container.createDiv({ cls: ["wtb-task-card", taskTimingClass(task)].filter(Boolean).join(" "), attr: { draggable: String((task.depth || 1) === 1) } });
    if ((task.depth || 1) === 1) {
      card.addEventListener("dragstart", (event) => {
        card.addClass("is-dragging");
        event.dataTransfer.setData("application/json", JSON.stringify(task));
        event.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => card.removeClass("is-dragging"));
    }
    this.renderTaskNode(card, task);
  }

  renderTaskNode(container, task) {
    const node = container.createDiv({ cls: ["wtb-task-node", `depth-${task.depth || 1}`, taskTimingClass(task)].filter(Boolean).join(" ") });
    node.addEventListener("click", (event) => { event.stopPropagation(); this.plugin.openEditModal(task); });

    const titleRow = node.createDiv({ cls: "wtb-task-title-row" });
    titleRow.createEl("p", { cls: "wtb-task-title", text: task.title });
    if ((task.depth || 1) < 3) {
      titleRow.createEl("button", { cls: "wtb-subtask-button", text: "+ Subtask" }).addEventListener("click", (event) => {
        event.stopPropagation();
        this.plugin.openTaskModal({
          parentTask: task,
          startDate: task.startDate || formatDate(new Date()),
          dueDate: task.dueDate || formatDate(new Date()),
          assignees: task.assignees,
          status: this.plugin.settings.inboxStatus,
        });
      });
    }
    if (task.note) node.createEl("p", { cls: "wtb-task-note", text: task.note });
    const meta = node.createDiv({ cls: "wtb-task-meta" });
    const showTaskDates = (task.depth || 1) === 1;
    if (showTaskDates && task.startDate) meta.createSpan({ text: `🛫 ${task.startDate}` });
    if (task.completionDate) meta.createSpan({ text: `✅ ${task.completionDate}` });
    if (showTaskDates) meta.createSpan({ text: `📅 ${task.dueDate || "No due date"}` });
    if (task.children.length) meta.createSpan({ text: `${countCompletedLeafTasks(task)}/${countLeafTasks(task)} done` });
    for (const assignee of task.assignees.slice(0, 3)) meta.createSpan({ text: `@${assignee}` });
    if (task.assignees.length > 3) meta.createSpan({ text: `+${task.assignees.length - 3}` });
    if (this.mode === "dashboard" && (task.depth || 1) === 1) meta.createSpan({ text: task.fileLabel });
    if (task.children.length) {
      const children = node.createDiv({ cls: "wtb-subtask-list" });
      for (const child of task.children.filter((item) => this.shouldShowTaskTree(item))) this.renderTaskNode(children, child);
    }
  }

  shouldShowTask(task) {
    const query = this.search.trim().toLowerCase();
    if (query && !`${task.title} ${task.note} ${task.assignees.join(" ")} ${task.fileLabel}`.toLowerCase().includes(query)) return false;
    if (this.selectedAssignees.length && !task.assignees.some((assignee) => this.selectedAssignees.includes(assignee))) return false;
    if (this.filter === "all") return true;
    if (this.filter === "open" && task.status === this.plugin.settings.doneStatus) return false;
    if (this.filter === "overdue") return task.dueDate && task.dueDate < formatDate(new Date()) && task.status !== this.plugin.settings.doneStatus;
    if (this.filter === "this-week") return isThisWeek(task.dueDate);
    return true;
  }

  shouldShowTaskTree(task) {
    return this.shouldShowTask(task) || task.children.some((child) => this.shouldShowTaskTree(child));
  }

  getNewTaskDefaults() {
    if (this.mode === "dashboard") return { stayOnCurrentBoard: true };
    return getDefaultDatesForBoard(this.filePath, this.plugin.settings.boardRoot, this.plugin.settings.weekRule);
  }

  async openAdjacent(delta) {
    const route = this.plugin.getAdjacentRoute(this.filePath, delta);
    if (route) await this.plugin.openRoute(route);
  }
}

class WorkTaskModal extends Modal {
  constructor(app, plugin, initial = {}) {
    super(app);
    this.plugin = plugin;
    this.task = initial.raw ? initial : null;
    this.parentTask = initial.parentTask || null;
    this.title = initial.title || "";
    this.startDate = initial.startDate || formatDate(new Date());
    this.dueDate = initial.dueDate || formatDate(new Date());
    this.assignees = normalizeAssignees(initial.assignees || initial.assignee);
    this.note = initial.note || "";
    this.status = initial.status || plugin.settings.inboxStatus;
    this.completionDate = initial.completionDate || "";
    this.stayOnCurrentBoard = Boolean(initial.stayOnCurrentBoard);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wtb-modal");
    const header = contentEl.createDiv({ cls: "wtb-modal-header" });
    header.createEl("p", { cls: "wtb-kicker", text: "Work Task Board" });
    header.createEl("h2", { text: this.task ? "Edit card" : (this.parentTask ? "Add subtask" : "Route a task") });
    header.createEl("p", { cls: "wtb-modal-copy", text: "Markdown stays as the source of truth; the board edits the task line." });

    new Setting(contentEl).setName("Task").setDesc("What needs to be done?").addText((text) => {
      text.setPlaceholder("Prepare release notes").setValue(this.title);
      text.onChange((value) => { this.title = value; });
      this.titleInput = text.inputEl;
    });
    new Setting(contentEl).setName("Start date").setDesc("Format: YYYY-MM-DD.").addText((text) => {
      text.setValue(this.startDate);
      text.inputEl.type = "date";
      text.onChange((value) => { this.startDate = value; });
    });
    new Setting(contentEl).setName("Due date").setDesc("Format: YYYY-MM-DD.").addText((text) => {
      text.setValue(this.dueDate);
      text.inputEl.type = "date";
      text.onChange((value) => { this.dueDate = value; });
    });
    new Setting(contentEl).setName("Assignees").setDesc("Separate multiple people with comma or space.").addText((text) => {
      text.setPlaceholder("张三, 李四").setValue(this.assignees.join(", "));
      text.onChange((value) => { this.assignees = normalizeAssignees(value); });
      this.assigneeInput = text.inputEl;
    });
    const assigneeSetting = new Setting(contentEl).setName("Quick add person").setDesc("People already used in existing cards.");
    assigneeSetting.addDropdown((dropdown) => {
      dropdown.addOption("", "Loading people...");
      dropdown.setDisabled(true);
      this.plugin.getKnownAssignees().then((knownAssignees) => {
        dropdown.selectEl.empty();
        dropdown.addOption("", knownAssignees.length ? "Select a person" : "No saved people");
        for (const assignee of knownAssignees) dropdown.addOption(assignee, assignee);
        dropdown.setDisabled(knownAssignees.length === 0);
      });
      dropdown.onChange((value) => {
        if (!value || this.assignees.includes(value)) return;
        this.assignees = [...this.assignees, value];
        this.assigneeInput.value = this.assignees.join(", ");
        dropdown.setValue("");
      });
    });
    new Setting(contentEl).setName("Status").setDesc("Changing status updates the Markdown checkbox mark.").addDropdown((dropdown) => {
      for (const status of this.plugin.statusNames()) dropdown.addOption(status, status);
      dropdown.setValue(this.status).onChange((value) => { this.status = value; });
    });
    new Setting(contentEl).setName("Completion date").setDesc("Set automatically when status is Done. Format: YYYY-MM-DD.").addText((text) => {
      text.setValue(this.completionDate);
      text.inputEl.type = "date";
      text.onChange((value) => { this.completionDate = value; });
    });
    new Setting(contentEl).setName("Note").setDesc("Optional context appended after an em dash.").addTextArea((text) => {
      text.setPlaceholder("Stakeholder, link, or acceptance note").setValue(this.note);
      text.onChange((value) => { this.note = value; });
    });

    const routePreview = contentEl.createDiv({ cls: "wtb-route-preview" });
    const updatePreview = () => {
      const dueDate = parseDate(this.dueDate);
      if (!dueDate) return routePreview.setText("Invalid date");
      if (this.parentTask) return routePreview.setText(`${this.parentTask.fileLabel} / subtask / ${this.status}`);
      routePreview.setText(`${this.plugin.getRoute(dueDate).monthName} / ${this.plugin.getRoute(dueDate).weekName} / ${this.status}`);
    };
    updatePreview();
    contentEl.querySelectorAll("input, select").forEach((input) => input.addEventListener("input", updatePreview));
    contentEl.querySelectorAll("select").forEach((select) => select.addEventListener("change", updatePreview));

    const footer = contentEl.createDiv({ cls: "wtb-modal-footer" });
    if (this.task) footer.createEl("button", { cls: "wtb-danger-button", text: "Delete" }).addEventListener("click", () => this.delete());
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { cls: "mod-cta wtb-primary-button", text: this.task ? "Save card" : "Create task" }).addEventListener("click", () => this.submit());
    contentEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.submit();
      }
    });
    setTimeout(() => this.titleInput.focus(), 30);
  }

  async submit() {
    if (!this.title.trim()) {
      new Notice("Task title is required");
      this.titleInput.focus();
      return;
    }
    const values = { title: this.title, startDate: this.startDate, dueDate: this.dueDate, assignees: this.assignees, note: this.note, status: this.status, completionDate: this.completionDate, stayOnCurrentBoard: this.stayOnCurrentBoard };
    if (this.task) await this.plugin.updateTask(this.task, values);
    else if (this.parentTask) await this.plugin.createSubtask(this.parentTask, values);
    else await this.plugin.createTask(values);
    this.close();
  }

  async delete() {
    if (!this.task) return;
    await this.plugin.deleteTask(this.task);
    this.close();
  }

  onClose() { this.contentEl.empty(); }
}

class WorkTaskBoardSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("wtb-settings");
    containerEl.createEl("h2", { text: "Work Task Board" });
    containerEl.createEl("p", { cls: "wtb-settings-copy", text: "Ink-ledger routing for Markdown task boards." });

    new Setting(containerEl).setName("Board root").setDesc("Monthly folders and the dashboard live here.").addText((text) => text.setValue(this.plugin.settings.boardRoot).onChange(async (value) => {
      this.plugin.settings.boardRoot = normalizePath(value.trim() || DEFAULT_SETTINGS.boardRoot);
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Week rule").setDesc("Date range is predictable: 1-7, 8-14, 15-21, 22-28, 29-31.").addDropdown((dropdown) => dropdown.addOption("date-range", "Date range inside month").addOption("calendar-week", "Calendar week inside month").setValue(this.plugin.settings.weekRule).onChange(async (value) => {
      this.plugin.settings.weekRule = value;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Open weekly board after creation").setDesc("The success notice still links to the target board when this is off.").addToggle((toggle) => toggle.setValue(this.plugin.settings.openWeeklyBoardAfterCreate).onChange(async (value) => {
      this.plugin.settings.openWeeklyBoardAfterCreate = value;
      await this.plugin.saveSettings();
    }));
    this.statusSetting("Todo status", "inboxStatus");
    this.statusSetting("Doing status", "doingStatus");
    this.statusSetting("Done status", "doneStatus");
  }

  statusSetting(name, key) {
    new Setting(this.containerEl).setName(name).setDesc("Used as both a Markdown heading and a Tasks query filter.").addText((text) => text.setValue(this.plugin.settings[key]).onChange(async (value) => {
      this.plugin.settings[key] = value.trim() || DEFAULT_SETTINGS[key];
      await this.plugin.saveSettings();
    }));
  }
}

function parseBoard(content, file, statuses) {
  const lines = content.split("\n");
  const board = { title: lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "") || file.basename, mode: "board", tasks: emptyTasks(statuses) };
  let current = "";
  let stack = [];
  lines.forEach((line, index) => {
    const heading = line.match(/^##\s+(.+)\s*$/);
    if (heading) {
      current = statuses.includes(heading[1]) ? heading[1] : "";
      stack = [];
      return;
    }
    const taskMatch = line.match(/^(\s*)- \[([ x/-])\]\s+/);
    if (!current || !taskMatch) return;
    const indent = taskMatch[1].length;
    const depth = Math.floor(indent / 2) + 1;
    if (depth > 3) return;
    const task = parseTask(line, index, current, file, statuses, indent, depth, taskMatch[2]);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(task);
    else board.tasks[current].push(task);
    stack.push(task);
  });
  return board;
}

function parseTask(line, lineIndex, sectionStatus, file, statuses, indent, depth, mark) {
  const withoutCheckbox = line.replace(/^\s*- \[[ x/-]\]\s*/, "");
  const dueDate = withoutCheckbox.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1] || "";
  const startDate = withoutCheckbox.match(/🛫\s*(\d{4}-\d{2}-\d{2})/)?.[1] || "";
  const completionDate = withoutCheckbox.match(/✅\s*(\d{4}-\d{2}-\d{2})/)?.[1] || "";
  const assignees = Array.from(withoutCheckbox.matchAll(/(?:^|\s)@([^\s@📅🛫✅]+)/g)).map((match) => match[1]);
  const withoutMeta = withoutCheckbox
    .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/, "")
    .replace(/\s*🛫\s*\d{4}-\d{2}-\d{2}/, "")
    .replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/, "")
    .replace(/(?:^|\s)@([^\s@📅🛫✅]+)/g, "")
    .trim();
  const [title, ...noteParts] = withoutMeta.split(" — ");
  return {
    raw: line,
    lineIndex,
    sectionStatus,
    status: statusFromMark(mark, statuses),
    done: mark === "x",
    title: title.trim(),
    note: decodeTaskNote(noteParts.join(" — ").trim()),
    assignees,
    startDate,
    completionDate,
    dueDate,
    indent,
    depth,
    children: [],
    filePath: file.path,
    fileLabel: file.path.split("/").slice(-2).join("/"),
  };
}

function encodeTaskNote(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n");
}

function decodeTaskNote(value) {
  return String(value || "").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

function emptyTasks(statuses) {
  return Object.fromEntries(statuses.map((status) => [status, []]));
}

function ensureSections(content, statuses) {
  let next = content.endsWith("\n") ? content : `${content}\n`;
  for (const status of statuses) if (!new RegExp(`^##\\s+${escapeRegExp(status)}\\s*$`, "m").test(next)) next += `\n## ${status}\n`;
  return next;
}

function insertUnderHeading(content, heading, line) {
  const match = content.match(new RegExp(`(^##\\s+${escapeRegExp(heading)}\\s*\n)`, "m"));
  if (!match) return `${content.trimEnd()}\n\n## ${heading}\n${line}\n`;
  const index = match.index + match[0].length;
  return `${content.slice(0, index)}${line}\n${content.slice(index)}`;
}

function convertTaskStatus(line, targetStatus, settings) {
  let next = line.replace(/^(\s*)- \[[ x/-]\]/, `$1- [${statusMark(targetStatus, settings)}]`);
  if (targetStatus === settings.doneStatus) {
    if (/✅\s*\d{4}-\d{2}-\d{2}/.test(next)) return next;
    return next.replace(/\s*📅\s*/, ` ✅ ${formatDate(new Date())} 📅 `);
  }
  return next.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/, "");
}

function statusMark(status, settings) {
  if (status === settings.doneStatus) return "x";
  if (status === settings.doingStatus) return "/";
  return " ";
}

function statusFromMark(mark, statuses) {
  if (mark === "x") return statuses[2];
  if (mark === "/") return statuses[1];
  return statuses[0];
}

function findTaskSubtreeEnd(lines, index, indent) {
  let end = index;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const match = lines[cursor].match(/^(\s*)- \[[ x/-]\]\s+/);
    if (match && match[1].length <= indent) break;
    if (/^##\s+/.test(lines[cursor])) break;
    end = cursor;
  }
  return end;
}

function countLeafTasks(task) {
  if (!task.children.length) return 1;
  return task.children.reduce((total, child) => total + countLeafTasks(child), 0);
}

function countCompletedLeafTasks(task) {
  if (!task.children.length) return task.done || task.completionDate ? 1 : 0;
  return task.children.reduce((total, child) => total + countCompletedLeafTasks(child), 0);
}

function countVisibleLeafTasks(tasks, predicate) {
  return tasks.reduce((total, task) => total + countVisibleLeafTasksForNode(task, predicate), 0);
}

function countVisibleLeafTasksForNode(task, predicate) {
  if (!task.children.length) return predicate(task) ? 1 : 0;
  return task.children.reduce((total, child) => total + countVisibleLeafTasksForNode(child, predicate), 0);
}

function compareTasksByDueDate(a, b) {
  return (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99") || a.filePath.localeCompare(b.filePath);
}

function weekOfMonthByDateRange(date) { return Math.ceil(date.getDate() / 7); }
function weekOfMonthByCalendar(date) { return Math.ceil((date.getDate() + new Date(date.getFullYear(), date.getMonth(), 1).getDay()) / 7); }
function weeksInMonth(year, month, rule) {
  const lastDay = new Date(year, month, 0);
  return rule === "calendar-week" ? weekOfMonthByCalendar(lastDay) : Math.ceil(lastDay.getDate() / 7);
}

function parseRouteFromPath(filePath, root) {
  const relative = normalizePath(filePath).replace(`${normalizePath(root)}/`, "");
  const match = relative.match(/^(\d{4})-(\d{2})\/第(\d+)周\.md$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), week: Number(match[3]) };
}

function boardAssignees(board, statuses) {
  const assignees = new Set();
  for (const status of statuses) for (const task of board.tasks[status]) collectTaskAssignees(task, assignees);
  return Array.from(assignees).sort((a, b) => a.localeCompare(b));
}

function collectTaskAssignees(task, assignees) {
  for (const assignee of task.assignees) assignees.add(assignee);
  for (const child of task.children) collectTaskAssignees(child, assignees);
}

function taskTimingClass(task) {
  if (task.done || task.completionDate || !task.dueDate) return "";
  const today = parseDate(formatDate(new Date()));
  const dueDate = parseDate(task.dueDate);
  const startDate = parseDate(task.startDate);
  if (!today || !dueDate) return "";
  if (dueDate < today) return "is-overdue";
  if (startDate && startDate > today) return "";
  const dueSoonEnd = new Date(today);
  dueSoonEnd.setDate(today.getDate() + 2);
  if (dueDate <= dueSoonEnd) return "is-due-soon";
  return "is-active-safe";
}

function isThisWeek(value) {
  const date = parseDate(value);
  if (!date) return false;
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return date >= start && date < end;
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatMonth(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getDefaultDatesForBoard(filePath, root, weekRule) {
  const workWeek = getWorkWeekForBoard(filePath, root, weekRule);
  if (!workWeek) return {};
  const today = parseDate(formatDate(new Date()));
  if (today >= workWeek.start && today <= workWeek.end) {
    const value = formatDate(today);
    return { startDate: value, dueDate: value };
  }
  return {
    startDate: formatDate(workWeek.start),
    dueDate: formatDate(workWeek.end),
  };
}

function getWorkWeekForBoard(filePath, root, weekRule) {
  const range = getBoardDateRange(filePath, root, weekRule);
  if (!range) return null;
  const anchor = getDateRangeMidpoint(range.start, range.end);
  const start = getWorkWeekStart(anchor);
  const end = new Date(start);
  end.setDate(start.getDate() + 4);
  return { start, end };
}

function getBoardDateRange(filePath, root, weekRule) {
  const parsed = parseRouteFromPath(filePath, root);
  if (!parsed) return null;
  if (weekRule === "calendar-week") {
    const first = new Date(parsed.year, parsed.month - 1, 1);
    const start = new Date(parsed.year, parsed.month - 1, 1 + ((parsed.week - 1) * 7) - first.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return clampRangeToMonth(start, end, parsed.year, parsed.month);
  }
  const startDay = ((parsed.week - 1) * 7) + 1;
  const endDay = Math.min(parsed.week * 7, new Date(parsed.year, parsed.month, 0).getDate());
  return { start: new Date(parsed.year, parsed.month - 1, startDay), end: new Date(parsed.year, parsed.month - 1, endDay) };
}

function clampRangeToMonth(start, end, year, month) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  return { start: start < monthStart ? monthStart : start, end: end > monthEnd ? monthEnd : end };
}

function getDateRangeMidpoint(start, end) {
  const midpoint = new Date(start);
  midpoint.setDate(start.getDate() + Math.floor((end.getDate() - start.getDate()) / 2));
  return midpoint;
}

function getWorkWeekStart(date) {
  const start = new Date(date);
  const day = start.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  start.setDate(start.getDate() - daysFromMonday);
  return start;
}

function findWeekdayInRange(start, end, weekday) {
  const cursor = new Date(start);
  while (cursor <= end) {
    if (cursor.getDay() === weekday) return new Date(cursor);
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
}

function normalizeAssignees(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeAssignees).filter(Boolean);
  return String(value || "")
    .split(/[，,\s]+/)
    .map((item) => item.trim().replace(/^@+/, ""))
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
}

function formatBoardTabTitle(filePath) {
  const parts = normalizePath(filePath).split("/");
  const month = parts.at(-2) || "";
  const week = (parts.at(-1) || "").replace(/\.md$/, "");
  const monthMatch = month.match(/^(\d{4})-(\d{2})$/);
  if (!monthMatch) return week;
  return `${monthMatch[1].slice(2)}/${monthMatch[2]} ${week}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
