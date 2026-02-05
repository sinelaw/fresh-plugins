#!/bin/bash
# TypeScript type checker for Emmet plugin
# Usage: ./check-types.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/plugins"

echo "Checking TypeScript types for Emmet plugin..."

if npx -p typescript tsc \
  --noEmit \
  --target esnext \
  --moduleResolution node \
  --lib esnext,dom \
  --skipLibCheck \
  --allowImportingTsExtensions \
  emmet.ts 2>&1; then
  echo "✓ All type checks passed!"
  exit 0
else
  echo ""
  echo "✗ Type errors detected"
  exit 1
fi
