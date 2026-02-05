/// <reference path="./lib/fresh.d.ts" />
const editor = getEditor();

/**
 * Emmet Plugin for Fresh Editor
 *
 * Expands Emmet abbreviations for HTML, CSS, JSX, and more.
 *
 * Features:
 * - HTML/XML tag expansion: div, div.class, div#id, input:text
 * - Nesting: div>p>span, ul>li*3
 * - Siblings: div+p+span
 * - Grouping: (div>p)+footer
 * - CSS abbreviations: m10, p10-20, w100p, fz16
 * - Keybinding: Tab to expand (when cursor follows an abbreviation)
 * - Command palette: "Emmet: Expand Abbreviation"
 *
 * Supported file types: HTML, CSS, JavaScript, TypeScript, JSX, TSX, Vue, Svelte
 */

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Check if Emmet expansion is supported for the current buffer
 */
function canExpandEmmet(): boolean {
  const bufferId = editor.getActiveBufferId();
  if (bufferId === 0) return false;

  const path = editor.getBufferPath(bufferId);
  if (!path) return true; // Allow in unsaved buffers

  const ext = editor.pathExtname(path).toLowerCase();
  const supportedExts = [
    ".html",
    ".htm",
    ".xml",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".vue",
    ".svelte",
  ];

  return supportedExts.includes(ext);
}

/**
 * Extract the abbreviation before cursor
 */
async function getAbbreviationBeforeCursor(): Promise<string | null> {
  const bufferId = editor.getActiveBufferId();
  if (bufferId === 0) return null;

  const cursorPos = editor.getCursorPosition();
  const lineNum = editor.getCursorLine();

  const lineStart = await editor.getLineStartPosition(lineNum);
  if (lineStart === null) return null;

  // Read text from line start to cursor
  const text = await editor.getBufferText(bufferId, lineStart, cursorPos);

  // Extract abbreviation (word-like characters before cursor)
  const match = text.match(/[\w.#:\-+>*\[\]{}()=\d]+$/);
  return match ? match[0] : null;
}

/**
 * Check if cursor is inside a <style> tag
 */
async function isInsideStyleTag(): Promise<boolean> {
  const bufferId = editor.getActiveBufferId();
  if (bufferId === 0) return false;

  const cursorPos = editor.getCursorPosition();

  // Read up to 5000 bytes before cursor to look for <style> tag
  const start = Math.max(0, cursorPos - 5000);
  const text = await editor.getBufferText(bufferId, start, cursorPos);

  // Look for last <style> tag before cursor
  const styleOpenMatch = text.lastIndexOf("<style");
  const styleCloseMatch = text.lastIndexOf("</style>");

  // If we found a <style> tag and no closing tag after it, we're inside
  return styleOpenMatch !== -1 && styleOpenMatch > styleCloseMatch;
}

/**
 * Expand abbreviation using external emmet-expand.js script
 */
async function expandUsingCLI(abbr: string, type: 'html' | 'css'): Promise<string | null> {
  // Get the directory where this plugin is located
  // Note: __pluginDir__ is provided by the plugin runtime
  const pluginDir = editor.getPluginDir();
  const scriptPath = editor.pathJoin(pluginDir, "emmet-expand.js");

  try {
    const result = await editor.spawnProcess("node", [scriptPath, abbr, type], pluginDir);

    if (result.exit_code === 0) {
      return result.stdout.trim();
    } else {
      editor.debug(`[emmet] Expansion failed: ${result.stderr}`);
      return null;
    }
  } catch (e) {
    editor.debug(`[emmet] Failed to spawn node: ${e}`);
    return null;
  }
}

/**
 * Expand Emmet abbreviation at cursor
 */
async function expandAbbreviation(): Promise<boolean> {
  if (!canExpandEmmet()) {
    return false;
  }

  const abbr = await getAbbreviationBeforeCursor();
  if (!abbr) {
    return false;
  }

  // Determine if it's CSS or HTML context
  const bufferId = editor.getActiveBufferId();
  const path = editor.getBufferPath(bufferId);
  const ext = path ? editor.pathExtname(path).toLowerCase() : "";
  const isCSSFile =
    ext === ".css" || ext === ".scss" || ext === ".sass" || ext === ".less";

  // Check if we're inside a <style> tag in an HTML file
  const insideStyleTag = !isCSSFile && await isInsideStyleTag();

  const isCSSContext = isCSSFile || insideStyleTag;
  const type = isCSSContext ? 'css' : 'html';

  // Expand using CLI
  let expanded = await expandUsingCLI(abbr, type);

  if (!expanded) {
    editor.setStatus(editor.t("status.could_not_expand", { abbr }));
    return false;
  }

  // Get current line's indentation to preserve it for multi-line expansions
  const lineNum = editor.getCursorLine();
  const lineStart = await editor.getLineStartPosition(lineNum);
  if (lineStart !== null) {
    const cursorPos = editor.getCursorPosition();
    const linePrefix = await editor.getBufferText(bufferId, lineStart, cursorPos - abbr.length);
    const indentMatch = linePrefix.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : "";

    // Apply indentation to all lines except the first
    if (indent && expanded.includes("\n")) {
      const lines = expanded.split("\n");
      expanded = lines.map((line, i) => (i === 0 ? line : indent + line)).join("\n");
    }
  }

  // Delete the abbreviation
  const cursorPos = editor.getCursorPosition();
  const startPos = cursorPos - abbr.length;
  editor.deleteRange(bufferId, startPos, cursorPos);

  // Insert expanded text
  editor.insertAtCursor(expanded);

  editor.setStatus(editor.t("status.expanded", { abbr }));
  return true;
}

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Command handler for manual expansion
 */
globalThis.emmet_expand_abbreviation = async function (): Promise<void> {
  const success = await expandAbbreviation();
  if (!success) {
    editor.setStatus(editor.t("status.no_abbreviation"));
  }
};

/**
 * Command handler for Tab key expansion
 */
globalThis.emmet_expand_or_pass = async function (): Promise<void> {
  const success = await expandAbbreviation();
  if (!success) {
    // Fall through to default Tab behavior
    editor.executeAction("insert_tab");
  }
};

/**
 * Command handler for prompt-based expansion
 * Opens a prompt asking for abbreviation, then expands and inserts it
 */
globalThis.emmet_expand_from_prompt = async function (): Promise<void> {
  const abbr = await editor.prompt("Emmet abbreviation:", "");

  if (!abbr) {
    return; // User cancelled
  }

  // Determine context
  const bufferId = editor.getActiveBufferId();
  const path = bufferId ? editor.getBufferPath(bufferId) : "";
  const ext = path ? editor.pathExtname(path).toLowerCase() : "";
  const isCSSContext =
    ext === ".css" || ext === ".scss" || ext === ".sass" || ext === ".less";

  const type = isCSSContext ? 'css' : 'html';
  const expanded = await expandUsingCLI(abbr, type);

  if (expanded) {
    editor.insertAtCursor(expanded);
    editor.setStatus(editor.t("status.expanded", { abbr }));
  } else {
    editor.setStatus(editor.t("status.could_not_expand", { abbr }));
  }
};

// Register commands
editor.registerCommand(
  "%cmd.expand_abbreviation",
  "%cmd.expand_abbreviation_desc",
  "emmet_expand_abbreviation",
  null
);

editor.registerCommand(
  "%cmd.expand_from_prompt",
  "%cmd.expand_from_prompt_desc",
  "emmet_expand_from_prompt",
  null
);

// Define emmet-html mode with Tab key bound to Emmet expansion
editor.defineMode("emmet-html", null, [
  ["Tab", "emmet_expand_or_pass"],
], false); // read_only = false to allow typing

// Define emmet-css mode with Tab key bound to Emmet expansion
editor.defineMode("emmet-css", null, [
  ["Tab", "emmet_expand_or_pass"],
], false);

/**
 * Activate appropriate Emmet mode based on file extension
 */
function activateEmmetModeForBuffer(): void {
  const bufferId = editor.getActiveBufferId();
  if (!bufferId) return;

  const path = editor.getBufferPath(bufferId);
  if (!path) return;

  const ext = editor.pathExtname(path).toLowerCase();

  // HTML and related formats
  if (ext === ".html" || ext === ".htm" || ext === ".xml" || ext === ".svg" ||
      ext === ".vue" || ext === ".jsx" || ext === ".tsx") {
    editor.setEditorMode("emmet-html");
    editor.debug(`[emmet] Activated emmet-html mode for ${ext} file`);
  }
  // CSS and related formats
  else if (ext === ".css" || ext === ".scss" || ext === ".sass" || ext === ".less") {
    editor.setEditorMode("emmet-css");
    editor.debug(`[emmet] Activated emmet-css mode for ${ext} file`);
  }
  // For other files, don't activate Emmet mode (will use default mode)
}

/**
 * Handler for buffer_activated event
 */
globalThis.emmet_on_buffer_activated = function (): void {
  activateEmmetModeForBuffer();
};

/**
 * Handler for after_file_open event
 */
globalThis.emmet_on_after_file_open = function (): void {
  activateEmmetModeForBuffer();
};

// Register event handlers
editor.on("buffer_activated", "emmet_on_buffer_activated");
editor.on("after_file_open", "emmet_on_after_file_open");

// Activate for current buffer on load
activateEmmetModeForBuffer();

/**
 * Check if Emmet dependencies are installed
 */
async function checkDependencies(): Promise<void> {
  try {
    // Check if node is available
    const nodeCheck = await editor.spawnProcess("node", ["--version"]);
    if (nodeCheck.exit_code !== 0) {
      showInstallPopup("Node.js not found");
      return;
    }

    // Check if @emmetio/expand-abbreviation is installed locally in plugin dir
    const pluginDir = editor.getPluginDir();
    const nodeModulesPath = editor.pathJoin(pluginDir, "node_modules", "@emmetio", "expand-abbreviation");

    if (!editor.fileExists(nodeModulesPath)) {
      showInstallPopup("Emmet library not found");
      return;
    }

    editor.debug("[emmet] Dependencies check passed");
  } catch (e) {
    editor.debug(`[emmet] Dependency check failed: ${e}`);
    showInstallPopup("Dependency check failed");
  }
}

/**
 * Show installation popup
 */
function showInstallPopup(reason: string): void {
  editor.showActionPopup({
    id: "emmet-install-help",
    title: "Emmet Dependencies Missing",
    message: `${reason}. The Emmet plugin requires Node.js and @emmetio/expand-abbreviation to expand abbreviations. The package will be installed in the plugin directory.`,
    actions: [
      { id: "auto_install", label: "Install now" },
      { id: "dismiss", label: "Dismiss (ESC)" },
    ],
  });
}

/**
 * Handle installation popup actions
 */
globalThis.emmet_on_install_action = function (data: any): void {
  if (data.popup_id !== "emmet-install-help") {
    return;
  }

  switch (data.action_id) {
    case "auto_install":
      const pluginDir = editor.getPluginDir();
      editor.setStatus("Installing @emmetio/expand-abbreviation...");
      editor.spawnProcess("npm", ["install", "@emmetio/expand-abbreviation"], pluginDir).then((result) => {
        if (result.exit_code === 0) {
          editor.setStatus("Emmet library installed successfully! Please restart Fresh.");
        } else {
          editor.setStatus(`Installation failed: ${result.stderr}`);
          editor.debug(`[emmet] Installation stderr: ${result.stderr}`);
        }
      });
      break;

    case "dismiss":
    case "dismissed":
      break;

    default:
      editor.debug(`[emmet] Unknown action: ${data.action_id}`);
  }
};

editor.on("action_popup_result", "emmet_on_install_action");

// Check dependencies on startup
checkDependencies();

editor.debug("Emmet plugin loaded with HTML/CSS Tab bindings");
editor.setStatus(editor.t("status.loaded"));
