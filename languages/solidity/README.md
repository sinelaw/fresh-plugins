# Solidity Language Pack for Fresh

Syntax highlighting and language support for Solidity smart contracts.

## Features

- Syntax highlighting for `.sol` files
- Line and block comments (`//`, `/* */`)
- NatSpec documentation support
- LSP integration with `solidity-ls`

## Installation

```
:pkg install https://github.com/sinelaw/fresh-plugins#languages/solidity
```

Or via the package manager UI (`:pkg list`).

## LSP Setup

This package is configured to use `solidity-ls`. Install it via npm:

```bash
npm install -g solidity-ls
```

Alternative LSP servers:
- [solc](https://docs.soliditylang.org/) - Official Solidity compiler with LSP
- [hardhat-vscode](https://github.com/NomicFoundation/hardhat-vscode) - Hardhat's language server

## Grammar Attribution

The TextMate grammar is derived from [vscode-solidity](https://github.com/juanfranblanco/vscode-solidity) by Juan Blanco, licensed under MIT. See `grammars/LICENSE` for details.

## License

MIT
