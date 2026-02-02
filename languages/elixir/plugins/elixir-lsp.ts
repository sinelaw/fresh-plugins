/// <reference path="./lib/fresh.d.ts" />
const editor = getEditor();

/**
 * Elixir LSP Helper Plugin
 *
 * Provides user-friendly error handling for Elixir LSP server issues.
 * When Expert (elixir-ls) fails to start, this plugin shows an actionable
 * popup with installation instructions.
 *
 * Features:
 * - Detects Elixir LSP server errors (Expert/elixir-ls)
 * - Shows popup with install commands (brew, apt, pacman, manual)
 * - Explains first-launch build process
 * - Provides option to disable Elixir LSP
 */

interface LspServerErrorData {
  language: string;
  server_command: string;
  error_type: string;
  message: string;
}

interface LspStatusClickedData {
  language: string;
  has_error: boolean;
}

interface ActionPopupResultData {
  popup_id: string;
  action_id: string;
}

// Install commands for Elixir LSP server (Expert)
// See: https://github.com/elixir-lang/expert/releases
const INSTALL_COMMANDS = {
  brew: "brew install elixir-ls",
  apt: "sudo apt install elixir-ls",
  pacman: "sudo pacman -S elixir-ls",
  manual: `curl -L -o ~/.local/bin/elixir-ls \\
  https://github.com/elixir-lang/expert/releases/latest/download/expert_linux_amd64 \\
  && chmod +x ~/.local/bin/elixir-ls`,
};

// Languages handled by this plugin
const HANDLED_LANGUAGES = ["elixir"];

// Expert data directory (where engine is built)
const EXPERT_DATA_DIR = "~/.local/share/Expert";

// Track error state for Elixir LSP
let elixirLspError: {
  serverCommand: string;
  message: string;
  language: string;
  errorType: string;
} | null = null;

/**
 * Handle LSP server errors for Elixir
 */
globalThis.on_elixir_lsp_server_error = function (
  data: LspServerErrorData
): void {
  // Only handle Elixir language errors
  if (!HANDLED_LANGUAGES.includes(data.language)) {
    return;
  }

  editor.debug(`elixir-lsp: Server error - ${data.error_type}: ${data.message}`);

  // Store error state for later reference
  elixirLspError = {
    serverCommand: data.server_command,
    message: data.message,
    language: data.language,
    errorType: data.error_type,
  };

  // Show a status message for immediate feedback
  if (data.error_type === "not_found") {
    editor.setStatus(
      `Elixir LSP server '${data.server_command}' not found. Click status bar for help.`
    );
  } else if (data.message.includes("EOF") || data.message.includes("closed")) {
    // This often happens during first-launch build
    editor.setStatus(
      `Elixir LSP: Server closed. May be building engine - click status bar for help.`
    );
  } else {
    editor.setStatus(`Elixir LSP error: ${data.message}`);
  }
};

// Register hook for LSP server errors
editor.on("lsp_server_error", "on_elixir_lsp_server_error");

/**
 * Handle status bar click when there's an Elixir LSP error
 */
globalThis.on_elixir_lsp_status_clicked = function (
  data: LspStatusClickedData
): void {
  // Only handle Elixir language clicks when there's an error
  if (!HANDLED_LANGUAGES.includes(data.language) || !elixirLspError) {
    return;
  }

  editor.debug("elixir-lsp: Status clicked, showing help popup");

  // Customize message based on error type
  let message: string;
  let actions: Array<{ id: string; label: string }>;

  if (elixirLspError.errorType === "not_found") {
    message = `"${elixirLspError.serverCommand}" (Expert) provides code completion, diagnostics, and navigation for Elixir files.\n\nCopy a command below to install it for your platform.`;
    actions = [
      { id: "copy_brew", label: `Copy: ${INSTALL_COMMANDS.brew}` },
      { id: "copy_apt", label: `Copy: ${INSTALL_COMMANDS.apt}` },
      { id: "copy_pacman", label: `Copy: ${INSTALL_COMMANDS.pacman}` },
      { id: "copy_manual", label: "Copy: Manual install (Linux x86_64)" },
      { id: "disable", label: "Disable Elixir LSP" },
      { id: "dismiss", label: "Dismiss (ESC)" },
    ];
  } else {
    // Likely a build/startup issue
    message = `Expert (Elixir LSP) may be building its analysis engine. This happens on first launch and can take 1-2 minutes.\n\nCheck build progress: ls ${EXPERT_DATA_DIR}/\n\nRequirements:\n- Network access (downloads from hex.pm)\n- Run: mix local.hex --force && mix local.rebar --force`;
    actions = [
      { id: "copy_check_build", label: `Copy: ls ${EXPERT_DATA_DIR}/` },
      { id: "copy_hex_setup", label: "Copy: mix local.hex --force && mix local.rebar --force" },
      { id: "retry", label: "Retry LSP connection" },
      { id: "disable", label: "Disable Elixir LSP" },
      { id: "dismiss", label: "Dismiss (ESC)" },
    ];
  }

  // Show action popup with install/help options
  editor.showActionPopup({
    id: "elixir-lsp-help",
    title: elixirLspError.errorType === "not_found"
      ? "Elixir Language Server Not Found"
      : "Elixir Language Server Issue",
    message: message,
    actions: actions,
  });
};

// Register hook for status bar clicks
editor.on("lsp_status_clicked", "on_elixir_lsp_status_clicked");

/**
 * Handle action popup results for Elixir LSP help
 */
globalThis.on_elixir_lsp_action_result = function (
  data: ActionPopupResultData
): void {
  // Only handle our popup
  if (data.popup_id !== "elixir-lsp-help") {
    return;
  }

  editor.debug(`elixir-lsp: Action selected - ${data.action_id}`);

  switch (data.action_id) {
    case "copy_brew":
      editor.setClipboard(INSTALL_COMMANDS.brew);
      editor.setStatus("Copied: " + INSTALL_COMMANDS.brew);
      break;

    case "copy_apt":
      editor.setClipboard(INSTALL_COMMANDS.apt);
      editor.setStatus("Copied: " + INSTALL_COMMANDS.apt);
      break;

    case "copy_pacman":
      editor.setClipboard(INSTALL_COMMANDS.pacman);
      editor.setStatus("Copied: " + INSTALL_COMMANDS.pacman);
      break;

    case "copy_manual":
      editor.setClipboard(INSTALL_COMMANDS.manual);
      editor.setStatus("Copied manual install command");
      break;

    case "copy_check_build":
      editor.setClipboard(`ls ${EXPERT_DATA_DIR}/`);
      editor.setStatus("Copied: ls " + EXPERT_DATA_DIR + "/");
      break;

    case "copy_hex_setup":
      editor.setClipboard("mix local.hex --force && mix local.rebar --force");
      editor.setStatus("Copied hex/rebar setup command");
      break;

    case "retry":
      // Clear error state and let user try again
      elixirLspError = null;
      editor.setStatus("Cleared LSP error state. Open an Elixir file to retry.");
      break;

    case "disable":
      editor.disableLspForLanguage("elixir");
      editor.setStatus("Elixir LSP disabled");
      elixirLspError = null;
      break;

    case "dismiss":
    case "dismissed":
      // Just close the popup without action
      break;

    default:
      editor.debug(`elixir-lsp: Unknown action: ${data.action_id}`);
  }
};

// Register hook for action popup results
editor.on("action_popup_result", "on_elixir_lsp_action_result");

editor.debug("elixir-lsp: Plugin loaded");
