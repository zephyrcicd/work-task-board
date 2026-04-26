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
    await this.insertTaskIntoStatus(boardFile, this.settings.inboxStatus, this.formatTaskLine(task, this.settings.inboxStatus));
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
    if (this.settings.openWeeklyBoardAfterCreate) await this.openBoardView(boardFile);
  }

  async updateTask(task, values) {
    const dueDate = parseDate(values.dueDate);
    if (!dueDate) return new Notice("Use a valid due date: YYYY-MM-DD");

    const currentFile = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!currentFile) return new Notice("Original task file not found");

    const targetRoute = this.getRoute(dueDate);
    const targetFile = await this.ensureWeeklyBoard(targetRoute);
    const targetStatus = values.status || task.status;
    const nextLine = this.formatTaskLine(values, targetStatus);

    if (targetFile.path === task.filePath) {
      await this.replaceTaskLine(currentFile, task, nextLine);
    } else {
      await this.removeTaskLine(currentFile, task);
      await this.insertTaskIntoStatus(targetFile, targetStatus, nextLine);
    }
    await this.ensureDashboard();
  }

  async deleteTask(task) {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!file) return;
    await this.removeTaskLine(file, task);
  }

  async moveTask(task, targetStatus) {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!file || task.status === targetStatus) return;
    const content = ensureSections(await this.app.vault.read(file), this.statusNames());
    const lines = content.split("\n");
    const line = this.resolveTaskLine(lines, task);
    if (!line) return new Notice("Task moved or changed; reload the board and try again");
    lines.splice(line.index, 1);
    const targetLine = convertTaskStatus(line.value, targetStatus, this.settings);
    const headingIndex = lines.findIndex((item) => item.trim() === `## ${targetStatus}`);
    lines.splice(headingIndex + 1, 0, targetLine);
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

  resolveTaskLine(lines, task) {
    if (lines[task.lineIndex] === task.raw) return { index: task.lineIndex, value: task.raw };
    const index = lines.findIndex((line) => line === task.raw);
    return index >= 0 ? { index, value: lines[index] } : null;
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

  formatTaskLine(task, status) {
    const title = task.title.trim().replace(/\s+/g, " ");
    const note = (task.note || "").trim().replace(/\s+/g, " ");
    const noteText = note ? ` — ${note}` : "";
    const assigneeText = normalizeAssignees(task.assignees || task.assignee).map((assignee) => ` @${assignee}`).join("");
    const startText = task.startDate ? ` 🛫 ${task.startDate}` : "";
    return `- [${statusMark(status, this.settings)}] ${title}${noteText}${assigneeText}${startText} 📅 ${task.dueDate}`;
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
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("wtb-board-view");

    const board = await this.loadBoard();
    if (!board) return container.createEl("p", { text: "Board file not found." });

    this.renderToolbar(container, board);
    this.renderFilters(container);
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

  renderFilters(container) {
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
  }

  renderColumns(container, board) {
    const columns = container.createDiv({ cls: "wtb-board-columns" });
    for (const status of this.plugin.statusNames()) {
      const tasks = board.tasks[status].filter((task) => this.shouldShowTask(task));
      const column = columns.createDiv({ cls: "wtb-board-column", attr: { "data-status": status } });
      column.addEventListener("dragover", (event) => { event.preventDefault(); column.addClass("is-drag-over"); });
      column.addEventListener("dragleave", () => column.removeClass("is-drag-over"));
      column.addEventListener("drop", async (event) => {
        event.preventDefault();
        column.removeClass("is-drag-over");
        const task = JSON.parse(event.dataTransfer.getData("application/json"));
        await this.plugin.moveTask(task, status);
        await this.render();
      });

      const header = column.createDiv({ cls: "wtb-column-header" });
      header.createEl("h3", { text: status });
      header.createSpan({ text: String(tasks.length) });
      const stack = column.createDiv({ cls: "wtb-card-stack" });
      if (tasks.length === 0) stack.createDiv({ cls: "wtb-empty-column", text: "No cards" });
      for (const task of tasks) this.renderTaskCard(stack, task);
    }
  }

  renderTaskCard(container, task) {
    const card = container.createDiv({ cls: "wtb-task-card", attr: { draggable: "true" } });
    card.addEventListener("dragstart", (event) => {
      card.addClass("is-dragging");
      event.dataTransfer.setData("application/json", JSON.stringify(task));
      event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => card.removeClass("is-dragging"));
    card.addEventListener("click", () => this.plugin.openEditModal(task));

    card.createEl("p", { cls: "wtb-task-title", text: task.title });
    if (task.note) card.createEl("p", { cls: "wtb-task-note", text: task.note });
    const meta = card.createDiv({ cls: "wtb-task-meta" });
    if (task.startDate) meta.createSpan({ text: `🛫 ${task.startDate}` });
    meta.createSpan({ text: `📅 ${task.dueDate || "No due date"}` });
    for (const assignee of task.assignees.slice(0, 3)) meta.createSpan({ text: `@${assignee}` });
    if (task.assignees.length > 3) meta.createSpan({ text: `+${task.assignees.length - 3}` });
    if (this.mode === "dashboard") meta.createSpan({ text: task.fileLabel });
  }

  shouldShowTask(task) {
    const query = this.search.trim().toLowerCase();
    if (query && !`${task.title} ${task.note} ${task.assignees.join(" ")} ${task.fileLabel}`.toLowerCase().includes(query)) return false;
    if (this.filter === "all") return true;
    if (this.filter === "open" && task.status === this.plugin.settings.doneStatus) return false;
    if (this.filter === "overdue") return task.dueDate && task.dueDate < formatDate(new Date()) && task.status !== this.plugin.settings.doneStatus;
    if (this.filter === "this-week") return isThisWeek(task.dueDate);
    return true;
  }

  getNewTaskDefaults() {
    if (this.mode !== "board") return {};
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
    this.title = initial.title || "";
    this.startDate = initial.startDate || formatDate(new Date());
    this.dueDate = initial.dueDate || formatDate(new Date());
    this.assignees = normalizeAssignees(initial.assignees || initial.assignee);
    this.note = initial.note || "";
    this.status = initial.status || plugin.settings.inboxStatus;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wtb-modal");
    const header = contentEl.createDiv({ cls: "wtb-modal-header" });
    header.createEl("p", { cls: "wtb-kicker", text: "Work Task Board" });
    header.createEl("h2", { text: this.task ? "Edit card" : "Route a task" });
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
    new Setting(contentEl).setName("Note").setDesc("Optional context appended after an em dash.").addTextArea((text) => {
      text.setPlaceholder("Stakeholder, link, or acceptance note").setValue(this.note);
      text.onChange((value) => { this.note = value; });
    });

    const routePreview = contentEl.createDiv({ cls: "wtb-route-preview" });
    const updatePreview = () => {
      const dueDate = parseDate(this.dueDate);
      routePreview.setText(dueDate ? `${this.plugin.getRoute(dueDate).monthName} / ${this.plugin.getRoute(dueDate).weekName} / ${this.status}` : "Invalid date");
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
    const values = { title: this.title, startDate: this.startDate, dueDate: this.dueDate, assignees: this.assignees, note: this.note, status: this.status };
    if (this.task) await this.plugin.updateTask(this.task, values);
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
  lines.forEach((line, index) => {
    const heading = line.match(/^##\s+(.+)\s*$/);
    if (heading) current = statuses.includes(heading[1]) ? heading[1] : "";
    if (current && /^- \[[ x/-]\]\s+/.test(line)) board.tasks[current].push(parseTask(line, index, current, file));
  });
  return board;
}

function parseTask(line, lineIndex, status, file) {
  const withoutCheckbox = line.replace(/^- \[[ x/-]\]\s*/, "");
  const dueDate = withoutCheckbox.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1] || "";
  const startDate = withoutCheckbox.match(/🛫\s*(\d{4}-\d{2}-\d{2})/)?.[1] || "";
  const assignees = Array.from(withoutCheckbox.matchAll(/(?:^|\s)@([^\s@📅🛫]+)/g)).map((match) => match[1]);
  const withoutMeta = withoutCheckbox
    .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/, "")
    .replace(/\s*🛫\s*\d{4}-\d{2}-\d{2}/, "")
    .replace(/(?:^|\s)@([^\s@📅🛫]+)/g, "")
    .trim();
  const [title, ...noteParts] = withoutMeta.split(" — ");
  return {
    raw: line,
    lineIndex,
    status,
    title: title.trim(),
    note: noteParts.join(" — ").trim(),
    assignees,
    startDate,
    dueDate,
    filePath: file.path,
    fileLabel: file.path.split("/").slice(-2).join("/"),
  };
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
  return line.replace(/^- \[[ x/-]\]/, `- [${statusMark(targetStatus, settings)}]`);
}

function statusMark(status, settings) {
  if (status === settings.doneStatus) return "x";
  if (status === settings.doingStatus) return "/";
  return " ";
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
