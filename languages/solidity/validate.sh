#!/bin/bash
# Validate package.json against the official Fresh package schema
#
# Prerequisites:
#   pip install check-jsonschema
#   # or: npm install -g ajv-cli

set -e

SCHEMA_URL="https://raw.githubusercontent.com/sinelaw/fresh/main/crates/fresh-editor/plugins/schemas/package.schema.json"

if command -v check-jsonschema &> /dev/null; then
    echo "Validating package.json with check-jsonschema..."
    check-jsonschema --schemafile "$SCHEMA_URL" package.json
    echo "✓ package.json is valid"
elif command -v ajv &> /dev/null; then
    echo "Validating package.json with ajv..."
    ajv validate -s "$SCHEMA_URL" -d package.json
    echo "✓ package.json is valid"
else
    echo "No JSON schema validator found."
    echo ""
    echo "Install one of:"
    echo "  pip install check-jsonschema"
    echo "  npm install -g ajv-cli"
    echo ""
    echo "Or use an editor with JSON schema support (VS Code, etc.)"
    echo "The \$schema field in package.json enables automatic validation."
    exit 1
fi
