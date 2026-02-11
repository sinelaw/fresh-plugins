/// <reference path="./lib/fresh.d.ts" />

/**
 * Claude Code Plugin for Fresh Editor
 *
 * Multi-session Claude Code integration with embedded terminals.
 * The editor becomes a passive build monitor: Claude does the coding,
 * the user watches and reviews.
 *
 * Layout:
 *   ┌─ 30% ─────────────┬─ 70% ──────────────────────────────┐
 *   │  SESSION LIST      │  EMBEDDED TERMINAL                  │
 *   │  (virtual buffer)  │  (Claude Code CLI)                  │
 *   │                    │                                     │
 *   │  > ● jwt-auth      │  $ claude                           │
 *   │    ● fix-pagination │  > add JWT authentication           │
 *   │    ⟳ test-suite     │  ...                                │
 *   └────────────────────┴─────────────────────────────────────┘
 *
 * Architecture:
 *   Fresh Plugin (this file)
 *     ├── Session Manager — tracks N concurrent Claude sessions
 *     ├── Sidebar — virtual buffer with session list + metadata
 *     ├── Terminal Bridge — creates/switches embedded terminals
 *     └── File Tracker — git-based change detection per worktree
 *
 * Editor API used:
 *   - editor.createTerminal(opts)        — spawn PTY in a buffer (implemented)
 *   - editor.sendTerminalInput(id, data) — write to terminal (implemented)
 *   - editor.closeTerminal(id)           — close terminal (implemented)
 *
 * Planned editor API additions (stubbed):
 *   - editor.addWorkspaceFolder(path)    — multi-root workspace
 *   - editor.removeWorkspaceFolder(path) — remove workspace root
 *   - editor.listWorkspaceFolders()      — list workspace roots
 */

const editor = getEditor();

// =============================================================================
// ANSI Helpers
// =============================================================================

const C = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  ITALIC: "\x1b[3m",
  WHITE: "\x1b[37m",
  CYAN: "\x1b[36m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  RED: "\x1b[31m",
  MAGENTA: "\x1b[35m",
  BRIGHT_GREEN: "\x1b[92m",
  BRIGHT_YELLOW: "\x1b[93m",
  BRIGHT_RED: "\x1b[91m",
  BRIGHT_CYAN: "\x1b[96m",
  BRIGHT_WHITE: "\x1b[97m",
  BG_BRIGHT_BLACK: "\x1b[100m",
  BG_BLUE: "\x1b[44m",
  INVERT: "\x1b[7m",
};

// =============================================================================
// Types
// =============================================================================

interface FileChange {
  path: string;        // relative to worktree
  additions: number;
  deletions: number;
  status: "modified" | "added" | "deleted" | "renamed";
}

interface Session {
  id: string;
  label: string;
  worktree: string;
  branch: string;
  prompt: string;
  terminalBufferId: number | null;
  terminalId: number | null;
  status: "working" | "done" | "error";
  fileChanges: FileChange[];
  createdAt: number;
  lastActivity: number;
}

// Actions available in the sidebar action bar, cycled with Tab
const SIDEBAR_ACTIONS = ["new", "close", "review", "open"] as const;
type SidebarAction = typeof SIDEBAR_ACTIONS[number];

interface PluginState {
  sessions: Map<string, Session>;
  sessionOrder: string[];            // ordered session IDs
  activeSessionId: string | null;    // focused in sidebar
  sidebarBufferId: number | null;
  sidebarSplitId: number | null;
  terminalSplitId: number | null;
  sidebarVisible: boolean;
  selectedIndex: number;             // cursor position in session list
  focusedAction: number;             // index into SIDEBAR_ACTIONS, -1 = session list
  pollActive: boolean;
  pendingWorktree: string | null;    // worktree path awaiting confirmation
  pendingGitRoot: string | null;     // git root for worktree creation
}

const state: PluginState = {
  sessions: new Map(),
  sessionOrder: [],
  activeSessionId: null,
  sidebarBufferId: null,
  sidebarSplitId: null,
  terminalSplitId: null,
  sidebarVisible: false,
  selectedIndex: 0,
  focusedAction: -1, // -1 = focus on session list, 0+ = action bar
  pollActive: false,
  pendingWorktree: null,
  pendingGitRoot: null,
};

// =============================================================================
// Utility
// =============================================================================

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

function rightPad(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return s + " ".repeat(len - s.length);
}

function shortenPath(path: string): string {
  const home = editor.getEnv("HOME") || "";
  if (home && path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

// =============================================================================
// Git Helpers
// =============================================================================

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const result = await editor.spawnProcess(
      "git", ["-C", cwd, "rev-parse", "--show-toplevel"]
    );
    if (result.exit_code === 0) {
      return result.stdout.trim();
    }
  } catch { /* ignore */ }
  return null;
}

async function getGitBranch(worktree: string): Promise<string> {
  try {
    const result = await editor.spawnProcess(
      "git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]
    );
    if (result.exit_code === 0) {
      return result.stdout.trim();
    }
  } catch { /* ignore */ }
  return "unknown";
}

async function getGitChanges(worktree: string): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  try {
    // Get both staged and unstaged changes
    const result = await editor.spawnProcess(
      "git", ["-C", worktree, "diff", "--numstat", "HEAD"]
    );
    if (result.exit_code !== 0) return changes;

    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("\t");
      if (parts.length < 3) continue;

      const additions = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
      const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
      const filePath = parts[2];

      changes.push({
        path: filePath,
        additions,
        deletions,
        status: "modified",
      });
    }

    // Also get untracked files
    const untrackedResult = await editor.spawnProcess(
      "git", ["-C", worktree, "ls-files", "--others", "--exclude-standard"]
    );
    if (untrackedResult.exit_code === 0) {
      for (const line of untrackedResult.stdout.split("\n")) {
        const filePath = line.trim();
        if (!filePath) continue;
        changes.push({
          path: filePath,
          additions: 0,
          deletions: 0,
          status: "added",
        });
      }
    }
  } catch { /* ignore */ }
  return changes;
}

// =============================================================================
// Terminal Stubs
// =============================================================================

/**
 * Create an embedded terminal for a Claude Code session.
 *
 * Spawns a real PTY-backed terminal using editor.createTerminal().
 * If the terminal split already exists, the terminal is created without
 * a new split (direction omitted) and placed in the existing terminal area.
 * Otherwise, the first terminal creates its own split.
 */
async function createSessionTerminal(
  session: Session
): Promise<number> {
  // If the terminal split already exists, focus it first so the new
  // terminal buffer is created there (no new split needed).
  if (state.terminalSplitId !== null) {
    editor.focusSplit(state.terminalSplitId);
  }

  const term: TerminalResult = await editor.createTerminal({
    cwd: session.worktree,
    // Only create a split for the very first terminal
    ...(state.terminalSplitId === null
      ? { direction: "vertical", ratio: 0.5 }
      : {}),
    focus: false,
  });

  // Store terminal ID for sending input later
  session.terminalId = term.terminalId;

  if (term.splitId !== null && state.terminalSplitId === null) {
    state.terminalSplitId = term.splitId;
  }

  // Launch Claude Code CLI in the terminal
  editor.sendTerminalInput(term.terminalId, "claude\n");

  return term.bufferId;
}

// =============================================================================
// Workspace Folder Stubs
// =============================================================================

/**
 * STUB: Add a workspace folder to the editor.
 *
 * Requires new editor API:
 *   editor.addWorkspaceFolder(path: string, label?: string): boolean
 *   editor.removeWorkspaceFolder(path: string): boolean
 *   editor.listWorkspaceFolders(): Array<{ path: string, label: string }>
 *
 * When implemented, calling addWorkspaceFolder will cause the file
 * explorer to show the worktree as an additional root, so all sessions'
 * files are visible simultaneously (VS Code-style multi-root workspace).
 */
function addWorkspaceFolder(path: string, _label?: string): void {
  // editor.addWorkspaceFolder(path, label);
  editor.debug(`[claude-code] STUB: addWorkspaceFolder(${path})`);
}

function removeWorkspaceFolder(path: string): void {
  // editor.removeWorkspaceFolder(path);
  editor.debug(`[claude-code] STUB: removeWorkspaceFolder(${path})`);
}

// =============================================================================
// Session Management
// =============================================================================

async function createSession(
  worktree: string,
  prompt: string,
  label?: string
): Promise<Session> {
  const id = generateId();
  const branch = await getGitBranch(worktree);

  // Auto-generate label from provided label or session ID
  const sessionLabel = label || `session-${id}`;

  const session: Session = {
    id,
    label: sessionLabel,
    worktree,
    branch,
    prompt,
    terminalBufferId: null,
    terminalId: null,
    status: "working",
    fileChanges: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  state.sessions.set(id, session);
  state.sessionOrder.push(id);

  // Add worktree to workspace folders
  addWorkspaceFolder(worktree, sessionLabel);

  // Create the terminal
  session.terminalBufferId = await createSessionTerminal(session);

  // Set as active if it's the first session
  if (state.activeSessionId === null) {
    state.activeSessionId = id;
    state.selectedIndex = 0;
  }

  // Update file explorer decorations
  updateFileExplorerDecorations();

  editor.setStatus(editor.t("status.session_created", { label: sessionLabel }));
  editor.debug(`[claude-code] Session created: ${id} (${sessionLabel})`);

  return session;
}

async function closeSession(sessionId: string): Promise<void> {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  // Close terminal (this also closes its buffer)
  if (session.terminalId !== null) {
    editor.closeTerminal(session.terminalId);
  } else if (session.terminalBufferId !== null) {
    editor.closeBuffer(session.terminalBufferId);
  }

  // Remove workspace folder
  removeWorkspaceFolder(session.worktree);

  // Remove from state
  state.sessions.delete(sessionId);
  const idx = state.sessionOrder.indexOf(sessionId);
  if (idx !== -1) state.sessionOrder.splice(idx, 1);

  // Update active session
  if (state.activeSessionId === sessionId) {
    if (state.sessionOrder.length > 0) {
      state.selectedIndex = Math.min(state.selectedIndex, state.sessionOrder.length - 1);
      state.activeSessionId = state.sessionOrder[state.selectedIndex];
      switchToSession(state.activeSessionId);
    } else {
      state.activeSessionId = null;
      state.selectedIndex = 0;
    }
  }

  // Update decorations and sidebar
  updateFileExplorerDecorations();
  updateSidebar();

  editor.setStatus(editor.t("status.session_closed", { label: session.label }));
}

function switchToSession(sessionId: string): void {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  state.activeSessionId = sessionId;

  // Switch the terminal split to show this session's terminal
  if (session.terminalBufferId !== null && state.terminalSplitId !== null) {
    editor.setSplitBuffer(state.terminalSplitId, session.terminalBufferId);
  }

  // Update file explorer decorations to highlight this session
  updateFileExplorerDecorations();

  editor.setStatus(editor.t("status.session_switched", { label: session.label }));
}

function getActiveSession(): Session | null {
  if (!state.activeSessionId) return null;
  return state.sessions.get(state.activeSessionId) || null;
}

// =============================================================================
// File Explorer Decorations
// =============================================================================

function updateFileExplorerDecorations(): void {
  const decorations: FileExplorerDecoration[] = [];

  for (const [, session] of state.sessions) {
    const isActive = session.id === state.activeSessionId;

    for (const change of session.fileChanges) {
      const fullPath = editor.pathJoin(session.worktree, change.path);

      let symbol: string;
      let color: [number, number, number];

      if (change.status === "added") {
        symbol = "A";
        color = [80, 200, 80];    // green
      } else if (change.status === "deleted") {
        symbol = "D";
        color = [200, 80, 80];    // red
      } else {
        symbol = "M";
        color = [200, 180, 60];   // yellow
      }

      // Dim decorations for non-active sessions
      if (!isActive) {
        color = [color[0] * 0.5, color[1] * 0.5, color[2] * 0.5] as [number, number, number];
      }

      decorations.push({
        path: fullPath,
        symbol,
        color,
        priority: isActive ? 10 : 5,
      });
    }
  }

  editor.setFileExplorerDecorations("claude-code", decorations);
}

// =============================================================================
// Sidebar Rendering
// =============================================================================

function renderSidebar(): TextPropertyEntry[] {
  const entries: TextPropertyEntry[] = [];
  const width = 34; // approximate sidebar width in chars
  const line = "─".repeat(width);

  // Header
  entries.push({
    text: `${C.BOLD}${C.CYAN} ${editor.t("sidebar.title")}${C.RESET}\n`,
  });
  entries.push({
    text: `${C.DIM}${C.CYAN} ${line}${C.RESET}\n`,
  });

  if (state.sessionOrder.length === 0) {
    // Empty state — guide the user to their first action
    entries.push({ text: "\n" });
    entries.push({
      text: `${C.DIM}  ${editor.t("sidebar.no_sessions")}${C.RESET}\n`,
    });
    entries.push({ text: "\n" });
    entries.push({
      text: `${C.DIM}  ${editor.t("sidebar.empty_hint")}${C.RESET}\n`,
    });
    entries.push({
      text: `${C.DIM}  or use ${C.BRIGHT_WHITE}M-n${C.DIM} to start a new session${C.RESET}\n`,
    });
    entries.push({ text: "\n" });
    // Fall through to render the action bar below
  }

  // Session list
  entries.push({ text: "\n" });
  for (let i = 0; i < state.sessionOrder.length; i++) {
    const sessionId = state.sessionOrder[i];
    const session = state.sessions.get(sessionId);
    if (!session) continue;

    const isSelected = i === state.selectedIndex;
    const isActive = sessionId === state.activeSessionId;

    // Status indicator
    let statusIcon: string;
    let statusColor: string;
    switch (session.status) {
      case "working":
        statusIcon = "⟳";
        statusColor = C.BRIGHT_YELLOW;
        break;
      case "done":
        statusIcon = "●";
        statusColor = C.BRIGHT_GREEN;
        break;
      case "error":
        statusIcon = "✕";
        statusColor = C.BRIGHT_RED;
        break;
    }

    // Selection highlight
    const pointer = isSelected ? ">" : " ";
    const labelStyle = isSelected
      ? `${C.BOLD}${C.INVERT}`
      : isActive
        ? C.BRIGHT_WHITE
        : C.WHITE;

    const label = truncate(session.label, width - 8);
    const branchShort = truncate(session.branch, 14);

    entries.push({
      text: ` ${C.BRIGHT_WHITE}${pointer}${C.RESET} ${statusColor}${statusIcon}${C.RESET} ${labelStyle}${label}${C.RESET}`,
      properties: { sessionId, sessionIndex: i },
    });

    // Branch name on the same line, right-aligned
    entries.push({
      text: `${C.DIM} [${branchShort}]${C.RESET}\n`,
    });
  }

  // Detail section for selected session
  entries.push({ text: "\n" });
  entries.push({
    text: `${C.DIM}${C.CYAN} ${line}${C.RESET}\n`,
  });

  const selected = state.sessionOrder[state.selectedIndex];
  const session = selected ? state.sessions.get(selected) : null;

  if (session) {
    const statusLabel = editor.t(`sidebar.status_${session.status}`);
    const statusColor = session.status === "working"
      ? C.BRIGHT_YELLOW
      : session.status === "done"
        ? C.BRIGHT_GREEN
        : C.BRIGHT_RED;

    entries.push({ text: "\n" });
    entries.push({
      text: ` ${C.BOLD}${C.BRIGHT_WHITE}${truncate(session.label, width - 2)}${C.RESET}\n`,
    });
    entries.push({
      text: ` ${statusColor}${statusLabel}${C.RESET}\n`,
    });
    entries.push({ text: "\n" });
    entries.push({
      text: ` ${C.CYAN}${editor.t("sidebar.branch")}${C.RESET} ${session.branch}\n`,
    });
    entries.push({
      text: ` ${C.CYAN}${editor.t("sidebar.worktree")}${C.RESET} ${shortenPath(session.worktree)}\n`,
    });

    // File changes
    entries.push({ text: "\n" });
    entries.push({
      text: ` ${C.CYAN}${editor.t("sidebar.files")}${C.RESET}\n`,
    });

    if (session.fileChanges.length === 0) {
      entries.push({
        text: `   ${C.DIM}${editor.t("sidebar.no_changes")}${C.RESET}\n`,
      });
    } else {
      for (const change of session.fileChanges) {
        const fileName = truncate(change.path, width - 14);
        let stats = "";
        if (change.status === "added") {
          stats = `${C.BRIGHT_GREEN}new${C.RESET}`;
        } else {
          const parts: string[] = [];
          if (change.additions > 0) parts.push(`${C.BRIGHT_GREEN}+${change.additions}${C.RESET}`);
          if (change.deletions > 0) parts.push(`${C.BRIGHT_RED}-${change.deletions}${C.RESET}`);
          stats = parts.join(" ");
        }
        entries.push({
          text: `   ${C.WHITE}${fileName}${C.RESET} ${stats}\n`,
          properties: {
            filePath: editor.pathJoin(session.worktree, change.path),
            sessionId: session.id,
          },
        });
      }
    }

    // Task/prompt
    if (session.prompt) {
      entries.push({ text: "\n" });
      entries.push({
        text: ` ${C.DIM}${C.ITALIC}"${truncate(session.prompt, width - 4)}"${C.RESET}\n`,
      });
    }
  }

  // Action bar — Tab cycles focus, Enter executes
  entries.push({ text: "\n" });
  entries.push({
    text: `${C.DIM}${C.CYAN} ${line}${C.RESET}\n`,
  });

  const actionButtons: Array<{ action: SidebarAction; label: string; accel: string }> = [
    { action: "new",    label: "New",       accel: "M-n" },
    { action: "close",  label: "Close",     accel: "M-c" },
    { action: "review", label: "Review",    accel: "M-r" },
    { action: "open",   label: "Open file", accel: "M-o" },
  ];

  let actionBar = " ";
  for (let i = 0; i < actionButtons.length; i++) {
    const btn = actionButtons[i];
    if (state.focusedAction === i) {
      // Highlighted button: inverted colors
      actionBar += `${C.INVERT}${C.BRIGHT_WHITE} ${btn.label} ${C.RESET} `;
    } else {
      // Normal button: show accelerator key underlined
      actionBar += `${C.DIM}[${C.RESET}${C.BRIGHT_WHITE}${btn.accel}${C.RESET}${C.DIM}] ${btn.label}${C.RESET} `;
    }
  }
  entries.push({ text: actionBar + "\n" });

  // Navigation hints
  entries.push({
    text: ` ${C.DIM}↑↓ navigate · Enter confirm · Tab cycle · Esc close${C.RESET}\n`,
  });

  return entries;
}

function updateSidebar(): void {
  if (state.sidebarBufferId === null) return;
  const entries = renderSidebar();
  editor.setVirtualBufferContent(state.sidebarBufferId, entries);
}

// =============================================================================
// Sidebar Interaction Handlers
// =============================================================================

globalThis.claude_sidebar_up = function (): void {
  if (state.focusedAction >= 0) {
    // Move focus from action bar back to session list
    state.focusedAction = -1;
  } else if (state.sessionOrder.length > 0) {
    state.selectedIndex = Math.max(0, state.selectedIndex - 1);
  }
  updateSidebar();
};

globalThis.claude_sidebar_down = function (): void {
  if (state.focusedAction >= 0) {
    // Already in action bar, nowhere to go down
    return;
  }
  if (state.sessionOrder.length === 0) {
    // No sessions — down arrow moves to action bar
    state.focusedAction = 0;
  } else if (state.selectedIndex >= state.sessionOrder.length - 1) {
    // At bottom of session list — move to action bar
    state.focusedAction = 0;
  } else {
    state.selectedIndex = Math.min(state.sessionOrder.length - 1, state.selectedIndex + 1);
  }
  updateSidebar();
};

globalThis.claude_sidebar_cycle_action = function (): void {
  // Tab cycles through action buttons
  state.focusedAction = (state.focusedAction + 1) % SIDEBAR_ACTIONS.length;
  updateSidebar();
};

globalThis.claude_sidebar_select = async function (): Promise<void> {
  if (state.focusedAction >= 0) {
    // Execute the focused action button
    const action = SIDEBAR_ACTIONS[state.focusedAction];
    switch (action) {
      case "new":
        await (globalThis.claude_sidebar_new as Function)();
        break;
      case "close":
        await (globalThis.claude_sidebar_close_session as Function)();
        break;
      case "review":
        await (globalThis.claude_sidebar_review as Function)();
        break;
      case "open":
        (globalThis.claude_sidebar_open_file as Function)();
        break;
    }
    return;
  }

  // Focus is on session list — switch to selected session
  if (state.sessionOrder.length === 0) return;
  const sessionId = state.sessionOrder[state.selectedIndex];
  if (!sessionId) return;
  switchToSession(sessionId);
  updateSidebar();

  // Focus the terminal split
  if (state.terminalSplitId !== null) {
    editor.focusSplit(state.terminalSplitId);
  }
};

globalThis.claude_sidebar_new = async function (): Promise<void> {
  // Generate a default worktree path based on the current project
  const cwd = editor.getCwd();
  const gitRoot = await getGitRoot(cwd);

  let defaultPath: string;
  if (gitRoot) {
    // Find next available session number
    const projectName = basename(gitRoot);
    const worktreeDir = `${gitRoot}/.worktrees`;
    let n = 1;
    while (editor.fileExists(`${worktreeDir}/${projectName}-${n}`)) {
      n++;
    }
    defaultPath = `${worktreeDir}/${projectName}-${n}`;
  } else {
    defaultPath = `${cwd}/worktree-1`;
  }

  // Prompt with the generated path — user can accept or modify
  const worktree = await editor.prompt(editor.t("prompt.worktree"), defaultPath);
  if (worktree === null || worktree.trim() === "") return;

  const path = worktree.trim();

  // Check if a session already exists on this worktree
  const existing = findSessionByWorktree(path);
  if (existing) {
    state.pendingWorktree = path;
    editor.showActionPopup({
      id: "claude-duplicate-worktree",
      title: "Session already exists",
      message: `"${existing.label}" is already running on this worktree. Start another session?`,
      actions: [
        { id: "start-anyway", label: "Start anyway" },
        { id: "switch", label: "Switch to existing" },
        { id: "cancel", label: "Cancel" },
      ],
    });
    return;
  }

  // If path already exists, use it directly
  if (editor.fileExists(path)) {
    await startSessionOnWorktree(path);
    return;
  }

  // Path doesn't exist — create a git worktree if we're in a git repo
  if (gitRoot) {
    state.pendingWorktree = path;
    state.pendingGitRoot = gitRoot;
    editor.showActionPopup({
      id: "claude-create-worktree",
      title: "Create git worktree",
      message: `Create a new git worktree at "${shortenPath(path)}"?`,
      actions: [
        { id: "create-worktree", label: "Create worktree" },
        { id: "cancel", label: "Cancel" },
      ],
    });
  } else {
    // Not a git repo — offer to create a plain directory
    state.pendingWorktree = path;
    state.pendingGitRoot = null;
    editor.showActionPopup({
      id: "claude-create-worktree",
      title: "Create directory",
      message: `"${shortenPath(path)}" does not exist. Create it?`,
      actions: [
        { id: "create-dir", label: "Create directory" },
        { id: "cancel", label: "Cancel" },
      ],
    });
  }
};

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** Find an existing session using the given worktree path */
function findSessionByWorktree(path: string): Session | null {
  for (const session of state.sessions.values()) {
    if (session.worktree === path) return session;
  }
  return null;
}

/** Start a new Claude session on a worktree and focus the terminal */
async function startSessionOnWorktree(path: string): Promise<void> {
  const label = basename(path);
  const session = await createSession(path, "", label);

  // Select and focus the new session
  state.selectedIndex = state.sessionOrder.indexOf(session.id);
  state.activeSessionId = session.id;
  updateSidebar();

  // Focus the terminal so the user can start interacting with Claude
  if (state.terminalSplitId !== null) {
    editor.focusSplit(state.terminalSplitId);
  }
}

globalThis.claude_sidebar_close_session = async function (): Promise<void> {
  if (state.sessionOrder.length === 0) return;
  const sessionId = state.sessionOrder[state.selectedIndex];
  if (!sessionId) return;

  const session = state.sessions.get(sessionId);
  if (!session) return;

  // Stronger warning for sessions that are still working (destructive action)
  const isRunning = session.status === "working";
  const title = isRunning
    ? `Close running session "${session.label}"?`
    : `Close "${session.label}"?`;
  const message = isRunning
    ? "Claude is still working. Closing will terminate the session and any unsaved progress will be lost."
    : "This will close the terminal and remove the session from the sidebar.";

  editor.showActionPopup({
    id: "claude-close-confirm",
    title,
    message,
    actions: [
      { id: "close", label: isRunning ? "Stop and close" : "Close session" },
      { id: "cancel", label: "Cancel" },
    ],
  });
};

globalThis.claude_sidebar_review = async function (): Promise<void> {
  if (state.sessionOrder.length === 0) {
    editor.setStatus("No sessions to review.");
    return;
  }
  const sessionId = state.sessionOrder[state.selectedIndex];
  if (!sessionId) return;
  await openReviewView(sessionId);
};

globalThis.claude_sidebar_open_file = function (): void {
  // Open the file listed in the selected session's file changes.
  // Uses text properties to find the file path at cursor position.
  if (state.sidebarBufferId === null) return;

  const props = editor.getTextPropertiesAtCursor(state.sidebarBufferId);
  if (props && props.length > 0) {
    for (const prop of props) {
      if (prop.filePath && typeof prop.filePath === "string") {
        if (state.terminalSplitId !== null) {
          editor.openFileInSplit(
            state.terminalSplitId,
            prop.filePath as string, 0, 0
          );
        } else {
          editor.openFile(prop.filePath as string, null, null);
        }
        return;
      }
    }
  }

  // No file under cursor — provide feedback
  editor.setStatus("No file selected. Navigate to a file in the changes list first.");
};

globalThis.claude_sidebar_quit = function (): void {
  closeSidebar();
};

// Handle action popup results
globalThis.claude_on_action_popup = function (data: {
  popup_id: string;
  action_id: string;
}): void {
  if (data.popup_id === "claude-close-confirm" && data.action_id === "close") {
    const sessionId = state.sessionOrder[state.selectedIndex];
    if (sessionId) {
      closeSession(sessionId);
      updateSidebar();
    }
  } else if (data.popup_id === "claude-create-worktree") {
    const path = state.pendingWorktree;
    const gitRoot = state.pendingGitRoot;
    state.pendingWorktree = null;
    state.pendingGitRoot = null;
    if (!path || data.action_id === "cancel") return;

    if (data.action_id === "create-worktree" && gitRoot) {
      // Create a git worktree
      editor.spawnProcess(
        "git", ["-C", gitRoot, "worktree", "add", path]
      ).then((result: SpawnResult) => {
        if (result.exit_code === 0) {
          startSessionOnWorktree(path);
        } else {
          editor.setStatus(`Failed to create worktree: ${result.stderr.trim()}`);
        }
      });
    } else if (data.action_id === "create-dir") {
      // Create a plain directory
      editor.spawnProcess("mkdir", ["-p", path]).then((result: SpawnResult) => {
        if (result.exit_code === 0) {
          startSessionOnWorktree(path);
        } else {
          editor.setStatus(`Failed to create directory: ${path}`);
        }
      });
    }
  } else if (data.popup_id === "claude-duplicate-worktree") {
    if (data.action_id === "start-anyway" && state.pendingWorktree) {
      const path = state.pendingWorktree;
      state.pendingWorktree = null;
      startSessionOnWorktree(path);
    } else if (data.action_id === "switch" && state.pendingWorktree) {
      const path = state.pendingWorktree;
      state.pendingWorktree = null;
      const existing = findSessionByWorktree(path);
      if (existing) {
        state.selectedIndex = state.sessionOrder.indexOf(existing.id);
        state.activeSessionId = existing.id;
        switchToSession(existing.id);
        updateSidebar();
      }
    } else {
      state.pendingWorktree = null;
    }
  }
};

// =============================================================================
// Review View
// =============================================================================

async function openReviewView(sessionId: string): Promise<void> {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  // Refresh file changes before showing review
  session.fileChanges = await getGitChanges(session.worktree);

  if (session.fileChanges.length === 0) {
    editor.setStatus("No changes to review");
    return;
  }

  // Build review content
  const entries: TextPropertyEntry[] = [];
  const width = 60;
  const line = "─".repeat(width);

  entries.push({
    text: `${C.BOLD}${C.CYAN} Review: ${session.label}${C.RESET}\n`,
  });
  entries.push({
    text: `${C.DIM} ${session.branch} · ${session.fileChanges.length} files changed${C.RESET}\n`,
  });
  entries.push({
    text: `${C.DIM}${C.CYAN} ${line}${C.RESET}\n`,
  });
  entries.push({ text: "\n" });

  for (const change of session.fileChanges) {
    const fullPath = editor.pathJoin(session.worktree, change.path);

    // File header
    entries.push({
      text: ` ${C.BOLD}${C.WHITE}${change.path}${C.RESET}`,
      properties: { filePath: fullPath },
    });

    let stats = "";
    if (change.status === "added") {
      stats = `${C.BRIGHT_GREEN}new file${C.RESET}`;
    } else {
      const parts: string[] = [];
      if (change.additions > 0) parts.push(`${C.BRIGHT_GREEN}+${change.additions}${C.RESET}`);
      if (change.deletions > 0) parts.push(`${C.BRIGHT_RED}-${change.deletions}${C.RESET}`);
      stats = parts.join(" ");
    }
    entries.push({ text: ` ${stats}\n` });

    // Show abbreviated diff
    try {
      const diffResult = await editor.spawnProcess(
        "git", ["-C", session.worktree, "diff", "HEAD", "--", change.path]
      );
      if (diffResult.exit_code === 0 && diffResult.stdout) {
        const diffLines = diffResult.stdout.split("\n");
        let shown = 0;
        const maxLines = 20;

        for (const diffLine of diffLines) {
          // Skip diff headers
          if (diffLine.startsWith("diff ") || diffLine.startsWith("index ") ||
              diffLine.startsWith("--- ") || diffLine.startsWith("+++ ")) continue;

          if (diffLine.startsWith("@@")) {
            entries.push({
              text: `   ${C.CYAN}${truncate(diffLine, width - 4)}${C.RESET}\n`,
            });
            shown++;
          } else if (diffLine.startsWith("+")) {
            entries.push({
              text: `   ${C.BRIGHT_GREEN}${truncate(diffLine, width - 4)}${C.RESET}\n`,
            });
            shown++;
          } else if (diffLine.startsWith("-")) {
            entries.push({
              text: `   ${C.BRIGHT_RED}${truncate(diffLine, width - 4)}${C.RESET}\n`,
            });
            shown++;
          }

          if (shown >= maxLines) {
            const remaining = diffLines.length - diffLines.indexOf(diffLine) - 1;
            if (remaining > 0) {
              entries.push({
                text: `   ${C.DIM}... ${remaining} more lines${C.RESET}\n`,
              });
            }
            break;
          }
        }
      }
    } catch { /* ignore diff errors */ }

    entries.push({ text: "\n" });
  }

  // Open review in the terminal split (or a new buffer)
  if (state.terminalSplitId !== null) {
    const result = await editor.createVirtualBufferInExistingSplit({
      name: `*Review: ${session.label}*`,
      splitId: state.terminalSplitId,
      readOnly: true,
      showLineNumbers: false,
      editingDisabled: true,
      lineWrap: true,
      entries,
    });
    // Focus it
    editor.focusSplit(state.terminalSplitId);
  } else {
    await editor.createVirtualBuffer({
      name: `*Review: ${session.label}*`,
      readOnly: true,
      showLineNumbers: false,
      editingDisabled: true,
      entries,
    });
  }
}

// =============================================================================
// Sidebar Lifecycle
// =============================================================================

async function openSidebar(): Promise<void> {
  if (state.sidebarVisible && state.sidebarBufferId !== null) {
    // Already open — focus it
    if (state.sidebarSplitId !== null) {
      editor.focusSplit(state.sidebarSplitId);
    }
    return;
  }

  // Define sidebar mode with keybindings.
  // Navigation: arrows, Enter, Tab. No bare letter keys.
  // Actions: Alt+letter accelerators for action buttons.
  editor.defineMode("claude-sidebar", "special", [
    ["Up", "claude_sidebar_up"],
    ["Down", "claude_sidebar_down"],
    ["Return", "claude_sidebar_select"],
    ["Tab", "claude_sidebar_cycle_action"],
    ["Escape", "claude_sidebar_quit"],
    ["M-n", "claude_sidebar_new"],
    ["M-c", "claude_sidebar_close_session"],
    ["M-r", "claude_sidebar_review"],
    ["M-o", "claude_sidebar_open_file"],
  ], true);

  // Register commands — all accessible via command palette regardless
  // of keybindings, so the user can always discover them.
  const sidebarCmds: [string, string, string][] = [
    ["claude_sidebar_up", "Claude: Previous session", "claude_sidebar_up"],
    ["claude_sidebar_down", "Claude: Next session", "claude_sidebar_down"],
    ["claude_sidebar_select", "Claude: Switch to session", "claude_sidebar_select"],
    ["claude_sidebar_cycle_action", "Claude: Cycle action", "claude_sidebar_cycle_action"],
    ["claude_sidebar_new", "Claude: New session", "claude_sidebar_new"],
    ["claude_sidebar_close_session", "Claude: Close session", "claude_sidebar_close_session"],
    ["claude_sidebar_review", "Claude: Review changes", "claude_sidebar_review"],
    ["claude_sidebar_open_file", "Claude: Open file at cursor", "claude_sidebar_open_file"],
    ["claude_sidebar_quit", "Claude: Close sidebar", "claude_sidebar_quit"],
  ];
  for (const [name, desc, handler] of sidebarCmds) {
    editor.registerCommand(name, desc, handler, "claude-sidebar");
  }

  // Create sidebar virtual buffer in a left split (30%)
  // before=true places the new buffer as the first (left) child.
  // ratio=0.3 gives 30% to the sidebar (first child) and 70% to the content (second child).
  const entries = renderSidebar();
  const result = await editor.createVirtualBufferInSplit({
    name: "*Claude Sessions*",
    mode: "claude-sidebar",
    readOnly: true,
    showLineNumbers: false,
    showCursors: false,
    editingDisabled: true,
    ratio: 0.3,
    direction: "vertical",
    before: true,
    entries,
  });

  state.sidebarBufferId = result.bufferId;
  state.sidebarSplitId = result.splitId;
  state.sidebarVisible = true;

  // The sidebar is now the first child (30%, left).
  // The original split (70%, right) is the terminal area.
  if (state.terminalSplitId === null) {
    const activeSplit = editor.getActiveSplitId();
    if (activeSplit !== result.splitId) {
      state.terminalSplitId = activeSplit;
    }
  }

  // Focus the sidebar so the user can navigate immediately
  if (state.sidebarSplitId !== null) {
    editor.focusSplit(state.sidebarSplitId);
  }

  // If there's an active session, show its terminal in the right pane
  const active = getActiveSession();
  if (active && active.terminalBufferId !== null && state.terminalSplitId !== null) {
    editor.setSplitBuffer(state.terminalSplitId, active.terminalBufferId);
  }

  editor.debug("[claude-code] Sidebar opened");
}

function closeSidebar(): void {
  if (state.sidebarBufferId !== null) {
    editor.closeBuffer(state.sidebarBufferId);
    state.sidebarBufferId = null;
  }
  if (state.sidebarSplitId !== null) {
    // Don't close the split directly — closing the buffer should handle it
    state.sidebarSplitId = null;
  }
  state.sidebarVisible = false;
  editor.setStatus(editor.t("status.sidebar_closed"));
}

function toggleSidebar(): void {
  if (state.sidebarVisible) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

// =============================================================================
// Background Polling
// =============================================================================

/**
 * Periodically refresh git status for all sessions.
 * This detects file changes made by Claude Code (which writes directly
 * to disk) and updates the sidebar and file explorer decorations.
 */
async function startPolling(): Promise<void> {
  state.pollActive = true;

  while (state.pollActive) {
    for (const [, session] of state.sessions) {
      if (session.status !== "working" && session.fileChanges.length > 0) continue;

      const changes = await getGitChanges(session.worktree);
      const changed = JSON.stringify(changes) !== JSON.stringify(session.fileChanges);

      if (changed) {
        session.fileChanges = changes;
        session.lastActivity = Date.now();
        updateFileExplorerDecorations();
        updateSidebar();
      }
    }

    await editor.delay(3000); // Poll every 3 seconds
  }
}

// =============================================================================
// Event Handlers
// =============================================================================

globalThis.claude_on_action_popup_result = function (data: unknown): void {
  const d = data as { popup_id?: string; action_id?: string };
  if (d && d.popup_id && d.action_id) {
    (globalThis.claude_on_action_popup as Function)(d);
  }
};

editor.on("action_popup_result", "claude_on_action_popup_result");

// =============================================================================
// Public Commands
// =============================================================================

globalThis.claude_open = async function (): Promise<void> {
  await openSidebar();
};

globalThis.claude_new_session = async function (): Promise<void> {
  // Ensure sidebar is open
  if (!state.sidebarVisible) {
    await openSidebar();
  }
  await (globalThis.claude_sidebar_new as Function)();
};

globalThis.claude_toggle = function (): void {
  toggleSidebar();
};

// =============================================================================
// Command Registration
// =============================================================================

editor.registerCommand(
  editor.t("%cmd.claude_open"), editor.t("%cmd.claude_open_desc"),
  "claude_open", null
);
editor.registerCommand(
  editor.t("%cmd.claude_new"), editor.t("%cmd.claude_new_desc"),
  "claude_new_session", null
);
editor.registerCommand(
  editor.t("%cmd.claude_close"), editor.t("%cmd.claude_close_desc"),
  "claude_close_session", null
);
editor.registerCommand(
  editor.t("%cmd.claude_toggle"), editor.t("%cmd.claude_toggle_desc"),
  "claude_toggle", null
);

// =============================================================================
// Initialization
// =============================================================================

(async () => {
  editor.debug("[claude-code] Plugin loaded");

  // Start background polling for git changes
  startPolling();
})();
