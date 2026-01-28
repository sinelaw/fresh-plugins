# Hare Language Pack for Fresh

Syntax highlighting and language support for the [Hare programming language](https://harelang.org/).

## Features

- Syntax highlighting for `.ha` files
- Line comments (`//`)
- LSP integration with `harepls`

## Installation

```
:pkg install https://github.com/sinelaw/fresh-plugins#languages/hare
```

Or via the package manager UI (`:pkg list`).

## LSP Setup

This package is configured to use `harepls`. Install it from:
- https://sr.ht/~tomleb/harepls/

Note: `harepls` is experimental and actively developed.

Alternative LSP servers:
- [hare-ls](https://sr.ht/~vladh/hare-project-library/#hare-lsp-servers) by ~jfreymuth

## Language Settings

- Tab size: 8 (Hare standard)
- Uses tabs for indentation
- Auto-indent enabled

## Grammar Attribution

The syntax grammar is derived from [hare-highlight](https://github.com/artursartamonovs/hare-highlight)
by Arturs Artamonovs, licensed under MIT. See `grammars/LICENSE` for details.

## License

MIT
