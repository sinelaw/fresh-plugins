# Amp Plugin for Fresh Editor

Integrates Fresh with the [Amp CLI](https://ampcode.com) AI coding agent.

## Features

- **File tracking** — Amp sees which files you have open
- **Cursor tracking** — Amp knows your current file and cursor position
- **Read files** — Amp reads file contents through Fresh buffers (including unsaved changes)
- **Edit files** — Amp can edit files and update open buffers in real-time
- **Diagnostics** — Amp receives LSP diagnostics from Fresh
- **Open files** — Amp can open files in the editor
- **Send messages** — Send messages or file references to Amp from the editor

## Requirements

- Python 3.6+ (uses only stdlib)
- [Amp CLI](https://ampcode.com) installed

## Usage

The plugin auto-starts when `amp` is found in PATH. Then run `amp --ide` in a terminal from the same directory.

### Commands

| Command | Description |
|---------|-------------|
| `Amp: Start` | Start the integration server |
| `Amp: Stop` | Stop the integration server |
| `Amp: Status` | Show connection status |
| `Amp: Send Message` | Send a message to the Amp agent |
| `Amp: Send File Reference` | Add current file+line to Amp prompt |

## Architecture

```
Fresh Plugin (amp.ts)
  ↕ file-based IPC (cmd/resp files)
amp_server.py (background process)
  ↕ WebSocket (Amp IDE protocol)
Amp CLI (amp --ide)
```

The plugin spawns a Python WebSocket server that implements the same IDE protocol as [amp.nvim](https://github.com/sourcegraph/amp.nvim). Communication between the plugin and server uses file-based IPC since Fresh's plugin sandbox doesn't expose raw sockets.
