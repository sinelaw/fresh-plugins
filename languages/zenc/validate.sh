#!/bin/bash
# Validate Zen-C plugin

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Validating Zen-C plugin..."

# Check grammar file exists
if [ ! -f "$SCRIPT_DIR/grammars/ZenC.sublime-syntax" ]; then
    echo "ERROR: ZenC.sublime-syntax not found"
    exit 1
fi

# Check package.json exists
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
    echo "ERROR: package.json not found"
    exit 1
fi

echo "Zen-C plugin validation passed!"
