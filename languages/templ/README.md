# Templ Language Support for Fresh

Syntax highlighting and LSP integration for [templ](https://templ.guide/) - a language for writing HTML user interfaces in Go.

## Installation

Use **Package: Install from URL** in the command palette and enter:
```
https://github.com/sinelaw/fresh-plugins#languages/templ
```

## Requirements

1. **Go** - [Official installation guide](https://go.dev/doc/install)

2. **templ CLI** - Install via Go:
   ```
   go install github.com/a-h/templ/cmd/templ@latest
   ```

Ensure `templ` is in your PATH. The LSP server is built into the templ CLI.

## Features

- Syntax highlighting for `.templ` files
- LSP integration via `templ lsp`
- Code formatting via `templ fmt`
- Go code completion inside templ expressions
- HTML completion and validation

## Credits

Grammar based on [Sublime Text templ syntax](https://packagecontrol.io/packages/Templ%20%28go%29).
