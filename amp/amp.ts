/// <reference path="./lib/fresh.d.ts" />

/**
 * Amp AI Coding Agent Plugin for Fresh Editor
 *
 * Integrates Fresh with the Amp CLI (https://ampcode.com) so that Amp can:
 * - See currently open/visible files
 * - Track cursor position and text selection
 * - Read and edit files through Fresh buffers
 * - Receive diagnostics from LSP
 * - Open files requested by the agent
 * - Receive messages sent by the user from the editor
 *
 * Architecture:
 *   Fresh Plugin (this file)
 *     ↕ file-based IPC (cmd/resp files)
 *   amp_server.py (background process)
 *     ↕ WebSocket (Amp IDE protocol)
 *   Amp CLI (`amp --ide`)
 *
 * Inspired by https://github.com/sourcegraph/amp.nvim
 */

const editor = getEditor();

// =============================================================================
// State
// =============================================================================

interface AmpState {
  serverPort: number | null;
  ipcDir: string | null;
  connected: boolean;
  lastSelection: SelectionState | null;
  lastVisibleFiles: string[];
}

interface SelectionState {
  uri: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
}

const ampState: AmpState = {
  serverPort: null,
  ipcDir: null,
  connected: false,
  lastSelection: null,
  lastVisibleFiles: [],
};

let serverProcess: ProcessHandle<BackgroundProcessResult> | null = null;
let pollActive = false;

// =============================================================================
// Path Helpers
// =============================================================================

function getPluginDir(): string {
  const configDir = editor.getConfigDir();
  const candidates = [
    editor.pathJoin(configDir, "plugins", "packages", "amp"),
    editor.pathJoin(configDir, "bundles", "packages", "amp"),
  ];

  const cwd = editor.getCwd();
  const parentDir = editor.pathDirname(cwd);
  candidates.push(editor.pathJoin(parentDir, "fresh-plugins", "amp"));
  candidates.push(editor.pathJoin(cwd, "fresh-plugins", "amp"));

  for (const dir of candidates) {
    if (editor.fileExists(editor.pathJoin(dir, "amp_server.py"))) {
      return dir;
    }
  }

  return editor.pathJoin(configDir, "plugins", "packages", "amp");
}

function getDataHome(): string {
  const override = editor.getEnv("AMP_DATA_HOME");
  if (override) return override;

  const home = editor.getEnv("HOME") || editor.getEnv("USERPROFILE") || "";
  const xdg = editor.getEnv("XDG_DATA_HOME");
  if (xdg) return xdg;

  return editor.pathJoin(home, ".local", "share");
}

// =============================================================================
// Server Lifecycle
// =============================================================================

function generateAuthToken(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let token = "";
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

async function cleanStaleLockfiles(lockDir: string): Promise<void> {
  if (!editor.fileExists(lockDir)) return;

  const entries = editor.readDir(lockDir);
  for (const entry of entries) {
    // Clean stale lockfiles
    if (entry.is_file && entry.name.endsWith(".json")) {
      const lockPath = editor.pathJoin(lockDir, entry.name);
      const content = editor.readFile(lockPath);
      if (!content) continue;
      try {
        const data = JSON.parse(content);
        if (data.ideName !== "fresh") continue;
        if (data.pid && editor.fileExists(`/proc/${data.pid}`)) continue;
        await editor.spawnProcess("rm", ["-f", lockPath]);
        editor.debug(`Amp: removed stale lockfile ${entry.name}`);
      } catch { /* ignore */ }
    }
    // Clean stale IPC dirs
    if (entry.is_dir && entry.name.startsWith("fresh-")) {
      const portStr = entry.name.replace("fresh-", "");
      const lockPath = editor.pathJoin(lockDir, `${portStr}.json`);
      if (!editor.fileExists(lockPath)) {
        await editor.spawnProcess("rm", ["-rf", editor.pathJoin(lockDir, entry.name)]);
        editor.debug(`Amp: removed stale IPC dir ${entry.name}`);
      }
    }
    // Clean stale .port files
    if (entry.is_file && entry.name.endsWith(".port")) {
      await editor.spawnProcess("rm", ["-f", editor.pathJoin(lockDir, entry.name)]);
    }
  }
}

async function startServer(): Promise<boolean> {
  if (ampState.serverPort !== null) {
    editor.setStatus("Amp server is already running");
    return false;
  }

  const authToken = generateAuthToken();
  const workspace = editor.getCwd();
  const pluginDir = getPluginDir();
  const serverScript = editor.pathJoin(pluginDir, "amp_server.py");

  if (!editor.fileExists(serverScript)) {
    editor.setStatus(`Amp: server script not found at ${serverScript}`);
    return false;
  }

  const dataHome = getDataHome();
  const lockDir = editor.pathJoin(dataHome, "amp", "ide");
  await editor.spawnProcess("mkdir", ["-p", lockDir]);

  // Kill any existing Fresh server for this workspace (e.g. from a previous plugin load)
  if (editor.fileExists(lockDir)) {
    const existing = editor.readDir(lockDir);
    for (const entry of existing) {
      if (!entry.is_file || !entry.name.endsWith(".json")) continue;
      const content = editor.readFile(editor.pathJoin(lockDir, entry.name));
      if (!content) continue;
      try {
        const data = JSON.parse(content);
        if (data.ideName === "fresh" &&
            data.workspaceFolders?.includes(workspace) &&
            data.pid && editor.fileExists(`/proc/${data.pid}`)) {
          editor.debug(`Amp: killing old server (pid=${data.pid})`);
          await editor.spawnProcess("kill", [String(data.pid)]);
        }
      } catch { /* ignore */ }
    }
    await editor.delay(500);
  }

  await cleanStaleLockfiles(lockDir);

  // Create a known port file that the server will write its port to
  const portFile = editor.pathJoin(lockDir, `fresh-starting-${Date.now()}.port`);

  editor.setStatus("Amp: starting server...");

  serverProcess = editor.spawnBackgroundProcess(
    "python3", [serverScript, authToken, workspace, portFile]
  );

  // Wait for the server to write its port to our known file
  let foundPort: number | null = null;

  for (let attempt = 0; attempt < 20; attempt++) {
    await editor.delay(250);

    const content = editor.readFile(portFile);
    if (content && content.trim()) {
      foundPort = parseInt(content.trim(), 10);
      if (!isNaN(foundPort)) break;
      foundPort = null;
    }
  }

  // Clean up the port file
  editor.writeFile(portFile, "");

  if (foundPort === null) {
    editor.setStatus("Amp: server failed to start");
    await stopServer();
    return false;
  }

  const ipcDir = editor.pathJoin(lockDir, `fresh-${foundPort}`);
  ampState.serverPort = foundPort;
  ampState.ipcDir = ipcDir;

  editor.setStatus(`Amp: server started on port ${foundPort}`);

  startEventTracking();
  startPolling();

  await editor.delay(200);
  broadcastVisibleFiles(true);
  broadcastSelection(true);
  broadcastPluginMetadata();

  return true;
}

async function stopServer(): Promise<void> {
  stopEventTracking();
  pollActive = false;

  if (serverProcess) {
    await serverProcess.kill();
    serverProcess = null;
  }

  ampState.serverPort = null;
  ampState.ipcDir = null;
  ampState.connected = false;
  ampState.lastSelection = null;
  ampState.lastVisibleFiles = [];

  editor.setStatus("Amp: server stopped");
}

// =============================================================================
// File-based IPC
// =============================================================================

function sendToServer(data: Record<string, unknown>): void {
  if (!ampState.ipcDir) return;
  const cmdFile = editor.pathJoin(ampState.ipcDir, "cmd");
  const line = JSON.stringify(data) + "\n";
  const existing = editor.readFile(cmdFile) || "";
  editor.writeFile(cmdFile, existing + line);
}

function readServerResponses(): string[] {
  if (!ampState.ipcDir) return [];
  const respFile = editor.pathJoin(ampState.ipcDir, "resp");
  const content = editor.readFile(respFile);
  if (!content) return [];
  editor.writeFile(respFile, "");
  return content.split("\n").filter(l => l.trim());
}

async function startPolling(): Promise<void> {
  pollActive = true;
  while (pollActive && ampState.ipcDir) {
    const lines = readServerResponses();
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        await handleServerRequest(msg);
      } catch { /* ignore */ }
    }
    await editor.delay(200);
  }
}

// =============================================================================
// Handle Requests from Server
// =============================================================================

async function handleServerRequest(msg: Record<string, unknown>): Promise<void> {
  const msgType = msg.type as string;
  const reqId = msg.id as string;

  if (msgType === "readFile") {
    await handleReadFile(reqId, msg.path as string);
  } else if (msgType === "editFile") {
    await handleEditFile(reqId, msg.path as string, msg.fullContent as string);
  } else if (msgType === "getDiagnostics") {
    handleGetDiagnostics(reqId, msg.path as string);
  } else if (msgType === "openURI") {
    handleOpenURI(reqId, msg.uri as string);
  } else if (msgType === "connected") {
    ampState.connected = true;
    editor.setStatus("● Connected to Amp CLI");
    broadcastVisibleFiles(true);
    broadcastSelection(true);
    broadcastPluginMetadata();
  } else if (msgType === "disconnected") {
    ampState.connected = false;
    editor.setStatus("Amp: disconnected");
  }
}

async function handleReadFile(reqId: string, path: string): Promise<void> {
  let content: string | null = null;
  const bufferId = editor.findBufferByPath(path);
  if (bufferId) {
    const length = editor.getBufferLength(bufferId);
    if (length > 0) {
      content = await editor.getBufferText(bufferId, 0, length);
    }
  }
  if (content === null) {
    content = editor.readFile(path);
  }

  sendToServer(content !== null
    ? { type: "fileResponse", id: reqId, data: { success: true, content, encoding: "utf-8" } }
    : { type: "fileResponse", id: reqId, data: { success: false, message: "File not found" } }
  );
}

async function handleEditFile(reqId: string, path: string, fullContent: string): Promise<void> {
  try {
    editor.writeFile(path, fullContent);

    const bufferId = editor.findBufferByPath(path);
    if (bufferId) {
      const length = editor.getBufferLength(bufferId);
      if (length > 0) {
        editor.deleteRange(bufferId, 0, length);
      }
      editor.insertText(bufferId, 0, fullContent);
    }

    sendToServer({
      type: "editFileResponse", id: reqId,
      data: { success: true, message: "Edit applied", appliedChanges: true },
    });
  } catch (e) {
    sendToServer({
      type: "editFileResponse", id: reqId,
      data: { success: false, message: String(e) },
    });
  }
}

function handleGetDiagnostics(reqId: string, path: string): void {
  const allDiags = editor.getAllDiagnostics();
  const entriesMap: Record<string, { uri: string; diagnostics: unknown[] }> = {};

  for (const diag of allDiags) {
    const diagPath = diag.uri.replace("file://", "");
    if (!diagPath.startsWith(path)) continue;

    if (!entriesMap[diag.uri]) {
      entriesMap[diag.uri] = { uri: diag.uri, diagnostics: [] };
    }

    entriesMap[diag.uri].diagnostics.push({
      range: {
        startLine: diag.range.start.line,
        startCharacter: diag.range.start.character,
        endLine: diag.range.end.line,
        endCharacter: diag.range.end.character,
      },
      severity: diag.severity === 1 ? "error"
        : diag.severity === 2 ? "warning"
        : diag.severity === 3 ? "info" : "hint",
      description: diag.message,
      lineContent: "",
      startOffset: diag.range.start.character,
      endOffset: diag.range.end.character,
    });
  }

  sendToServer({
    type: "diagnosticsResponse", id: reqId,
    data: { entries: Object.values(entriesMap) },
  });
}

function handleOpenURI(reqId: string, uri: string): void {
  if (!uri.startsWith("file://")) {
    sendToServer({
      type: "openURIResponse", id: reqId,
      data: { success: false, message: "Unsupported URI scheme: " + uri },
    });
    return;
  }

  const path = decodeURIComponent(uri.replace("file://", ""));
  if (!editor.fileExists(path)) {
    sendToServer({
      type: "openURIResponse", id: reqId,
      data: { success: false, message: "File not found: " + path },
    });
    return;
  }

  editor.openFile(path, null, null);
  sendToServer({
    type: "openURIResponse", id: reqId,
    data: { success: true, message: "Opened " + uri },
  });
}

// =============================================================================
// Editor State Broadcasting
// =============================================================================

function getVisibleFileUris(): string[] {
  const buffers = editor.listBuffers();
  const uris: string[] = [];
  const seen = new Set<string>();

  for (const buf of buffers) {
    if (buf.path && !seen.has(buf.path) && editor.fileExists(buf.path)) {
      seen.add(buf.path);
      uris.push("file://" + buf.path);
    }
  }
  return uris;
}

async function getCursorLineNumber(bufferId: number): Promise<number> {
  const cursorPos = editor.getCursorPosition();
  if (cursorPos <= 0) return 0;
  const textBefore = await editor.getBufferText(bufferId, 0, cursorPos);
  let count = 0;
  for (let i = 0; i < textBefore.length; i++) {
    if (textBefore.charCodeAt(i) === 10) count++;
  }
  return count;
}

async function getCurrentSelection(): Promise<SelectionState | null> {
  const bufferId = editor.getActiveBufferId();
  if (bufferId === null || bufferId === undefined) return null;

  const path = editor.getBufferPath(bufferId);
  if (!path) return null;

  const cursorLine = await getCursorLineNumber(bufferId);

  return {
    uri: "file://" + path,
    startLine: cursorLine,
    startCharacter: 0,
    endLine: cursorLine,
    endCharacter: 0,
    text: "",
  };
}

function selectionsEqual(a: SelectionState | null, b: SelectionState | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.uri === b.uri && a.startLine === b.startLine &&
    a.startCharacter === b.startCharacter && a.endLine === b.endLine &&
    a.endCharacter === b.endCharacter && a.text === b.text;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const item of b) {
    if (!setA.has(item)) return false;
  }
  return true;
}

async function broadcastSelection(force?: boolean): Promise<void> {
  const selection = await getCurrentSelection();
  if (!force && selectionsEqual(selection, ampState.lastSelection)) return;
  ampState.lastSelection = selection;
  if (!selection) return;

  sendToServer({
    type: "selectionDidChange",
    data: {
      uri: selection.uri,
      selections: [{
        range: {
          startLine: selection.startLine,
          startCharacter: selection.startCharacter,
          endLine: selection.endLine,
          endCharacter: selection.endCharacter,
        },
        content: selection.text,
      }],
    },
  });
}

function broadcastVisibleFiles(force?: boolean): void {
  const uris = getVisibleFileUris();
  if (!force && arraysEqual(uris, ampState.lastVisibleFiles)) return;
  ampState.lastVisibleFiles = uris;
  sendToServer({ type: "visibleFilesDidChange", data: { uris } });
}

function broadcastPluginMetadata(): void {
  sendToServer({
    type: "pluginMetadata",
    data: { version: "0.1.0", pluginDirectory: getPluginDir() },
  });
}

// =============================================================================
// Event Tracking
// =============================================================================

function startEventTracking(): void {
  editor.on("buffer_changed", "amp_on_buffer_event");
  editor.on("buffer_opened", "amp_on_buffer_event");
  editor.on("buffer_closed", "amp_on_buffer_event");
  editor.on("cursor_moved", "amp_on_cursor_moved");
}

function stopEventTracking(): void {
  editor.off("buffer_changed", "amp_on_buffer_event");
  editor.off("buffer_opened", "amp_on_buffer_event");
  editor.off("buffer_closed", "amp_on_buffer_event");
  editor.off("cursor_moved", "amp_on_cursor_moved");
}

globalThis.amp_on_buffer_event = function(): void {
  broadcastVisibleFiles();
};

globalThis.amp_on_cursor_moved = function(): void {
  broadcastSelection();
};

// =============================================================================
// User Commands
// =============================================================================

globalThis.amp_start = async function(): Promise<void> {
  await startServer();
};

globalThis.amp_stop = async function(): Promise<void> {
  await stopServer();
};

function getLogFilePath(): string {
  const cache = editor.getEnv("XDG_CACHE_HOME") ||
    editor.pathJoin(editor.getEnv("HOME") || "", ".cache");
  return editor.pathJoin(cache, "fresh", "amp-server.log");
}

globalThis.amp_status = function(): void {
  const logPath = getLogFilePath();
  if (ampState.serverPort !== null) {
    const status = ampState.connected ? "connected" : "waiting for Amp CLI";
    editor.setStatus(`Amp: port ${ampState.serverPort} (${status}) — log: ${logPath}`);
  } else {
    editor.setStatus(`Amp: not running — log: ${logPath}`);
  }
};

globalThis.amp_send_message = async function(): Promise<void> {
  if (ampState.serverPort === null) {
    editor.setStatus("Amp: server not running — use 'Amp: Start' first");
    return;
  }

  const message = await editor.prompt("Send to Amp:", "");
  if (message === null || message.trim() === "") return;

  sendToServer({ type: "userSentMessage", data: { message } });
  editor.setStatus("Message sent to Amp");
};

globalThis.amp_send_selection = async function(): Promise<void> {
  if (ampState.serverPort === null) {
    editor.setStatus("Amp: server not running — use 'Amp: Start' first");
    return;
  }

  const bufferId = editor.getActiveBufferId();
  if (bufferId === null || bufferId === undefined) return;

  const path = editor.getBufferPath(bufferId);
  if (!path) return;

  const line = await getCursorLineNumber(bufferId) + 1;

  const cwd = editor.getCwd();
  const relativePath = path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
  const ref = `@${relativePath}#L${line}`;

  sendToServer({ type: "appendToPrompt", data: { message: ref } });
  editor.setStatus(`Added ${ref} to Amp prompt`);
};

// =============================================================================
// Command Registration
// =============================================================================

editor.registerCommand("Amp: Start", "Start the Amp IDE integration server", "amp_start", null);
editor.registerCommand("Amp: Stop", "Stop the Amp IDE integration server", "amp_stop", null);
editor.registerCommand("Amp: Status", "Show Amp server connection status", "amp_status", null);
editor.registerCommand("Amp: Send Message", "Send a message to the Amp agent", "amp_send_message", null);
editor.registerCommand("Amp: Send File Reference", "Add current file+line to Amp prompt", "amp_send_selection", null);

// =============================================================================
// Auto-start
// =============================================================================

(async () => {
  editor.debug("Amp plugin loaded");

  const result = await editor.spawnProcess("which", ["amp"]);
  if (result.exit_code !== 0) {
    editor.debug("Amp CLI not found — auto-start skipped. Use 'Amp: Start' manually.");
    return;
  }

  await startServer();
})();
