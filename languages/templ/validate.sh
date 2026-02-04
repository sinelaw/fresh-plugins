#!/bin/bash
# Validate Templ plugin

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Validating Templ plugin..."

# Check grammar file exists
if [ ! -f "$SCRIPT_DIR/grammars/Templ.sublime-syntax" ]; then
    echo "ERROR: Templ.sublime-syntax not found"
    exit 1
fi

# Check package.json exists
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
    echo "ERROR: package.json not found"
    exit 1
fi

echo "Templ plugin validation passed!"
