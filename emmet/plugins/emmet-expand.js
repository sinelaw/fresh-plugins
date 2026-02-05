#!/usr/bin/env node
/**
 * Emmet expansion wrapper for Fresh editor
 *
 * Usage:
 *   node emmet-expand.js "ul>li*3" html
 *   node emmet-expand.js "m10" css
 *
 * Requires: npm install -g @emmetio/expand-abbreviation
 */

const abbr = process.argv[2];
const type = process.argv[3] || 'html';

if (!abbr) {
  process.stderr.write('Error: No abbreviation provided\n');
  process.stderr.write('Usage: node emmet-expand.js <abbreviation> [html|css]\n');
  process.exit(1);
}

try {
  const { expand } = require('@emmetio/expand-abbreviation');
  const result = expand(abbr, { type });
  process.stdout.write(result);
} catch (error) {
  process.stderr.write(`Emmet expansion error: ${error.message}\n`);
  process.exit(1);
}
