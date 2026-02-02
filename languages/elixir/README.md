# Elixir Language Support for Fresh

Syntax highlighting and LSP integration for Elixir.

## Installation

Use **Package: Install from URL** in the command palette and enter:
```
https://github.com/sinelaw/fresh-plugins#languages/elixir
```

## Requirements

1. **Elixir** - [Official installation guide](https://elixir-lang.org/install.html)

2. **Expert LSP** - [Download from releases](https://github.com/elixir-lang/expert/releases) and place in your PATH as `elixir-ls`

The plugin will show installation help if the LSP server is not found.

## First Launch

Expert builds its analysis engine on first use (1-2 minutes). The plugin provides guidance if you see errors during this process.

For full LSP features, open a Mix project directory (containing `mix.exs`).

## Credits

Grammar from [elixir-editors/elixir-tmbundle](https://github.com/elixir-editors/elixir-tmbundle).
