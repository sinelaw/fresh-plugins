#!/bin/bash
# Validate Elixir plugin

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Validating Elixir plugin..."

# Check grammar file exists
if [ ! -f "$SCRIPT_DIR/grammars/Elixir.sublime-syntax" ]; then
    echo "ERROR: Elixir.sublime-syntax not found"
    exit 1
fi

# Check package.json exists
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
    echo "ERROR: package.json not found"
    exit 1
fi

echo "Elixir plugin validation passed!"
