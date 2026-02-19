#!/bin/bash
# Validate Vue plugin

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Validating Vue plugin..."

# Check grammar file exists
if [ ! -f "$SCRIPT_DIR/grammars/Vue.sublime-syntax" ]; then
    echo "ERROR: Vue.sublime-syntax not found"
    exit 1
fi

# Check package.json exists
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
    echo "ERROR: package.json not found"
    exit 1
fi

echo "Vue plugin validation passed!"
