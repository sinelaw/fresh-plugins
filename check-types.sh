#!/bin/bash
# TypeScript type checker for Fresh plugins
# Usage: ./check-types.sh [files...]
# If no files specified, checks all plugin .ts files
#
# Each file is checked individually because plugins run in separate
# global scopes at runtime, so variables like `editor` don't conflict.
#
# Note: This requires the 'fresh' repo to be a sibling directory for
# the shared type definitions (lib/fresh.d.ts -> ../../fresh/...)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Verify the type definitions exist
if [ ! -f "lib/fresh.d.ts" ]; then
  echo "Error: lib/fresh.d.ts not found"
  echo "Make sure the 'fresh' repo is a sibling directory"
  exit 1
fi

# Default to all plugin .ts files if no arguments
if [ $# -eq 0 ]; then
  FILES=($(find . -name "*.ts" -not -path "*/lib/*" -not -path "*/node_modules/*" -type f))
else
  FILES=("$@")
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No TypeScript files found to check"
  exit 0
fi

echo "Checking TypeScript types for ${#FILES[@]} files..."

ERRORS=0
for file in "${FILES[@]}"; do
  echo "Checking: $file"
  if ! npx -p typescript tsc \
    --noEmit \
    --target esnext \
    --moduleResolution node \
    --lib esnext,dom \
    --skipLibCheck \
    --allowImportingTsExtensions \
    "$file" 2>&1; then
    ERRORS=$((ERRORS + 1))
  fi
done

echo ""
if [ $ERRORS -eq 0 ]; then
  echo "All type checks passed!"
else
  echo "$ERRORS file(s) had type errors"
  exit 1
fi
