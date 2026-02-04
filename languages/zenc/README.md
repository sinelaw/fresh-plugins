# Zen-C Language Support for Fresh

Syntax highlighting and LSP integration for [Zen-C](https://www.zenc-lang.org/) - a modern systems programming language that compiles to human-readable C.

## Installation

Use **Package: Install from URL** in the command palette and enter:
```
https://github.com/sinelaw/fresh-plugins#languages/zenc
```

## Requirements

**Zen-C Compiler** - Install from source:
```bash
git clone https://github.com/z-libs/Zen-C.git
cd Zen-C
make
sudo make install
```

Or on Arch Linux:
```bash
yay -S zenc-git
```

Ensure `zc` is in your PATH. The LSP server is built into the compiler.

## Features

- Syntax highlighting for `.zc` files
- LSP integration via `zc lsp` (Go-to-Definition, Hover, Completion, Diagnostics)
- Support for Zen-C specific features:
  - Type inference with `let` and `def`
  - Pattern matching with `match`
  - Traits and generics
  - String interpolation
  - Async/await
  - Attributes (`@derive`, `@inline`, etc.)

## Language Overview

Zen-C provides modern ergonomics while compiling to C:
- 100% C ABI compatible
- Zero overhead abstractions
- Memory safety with `defer`, `autofree`, and RAII
- Full generics and trait system

## Resources

- [Official Website](https://www.zenc-lang.org/)
- [GitHub Repository](https://github.com/z-libs/Zen-C)
- [Documentation](https://z-libs.github.io/Zen-C-Docs/)

## Credits

Grammar created for the Fresh editor based on the [Zen-C language specification](https://github.com/z-libs/Zen-C).
