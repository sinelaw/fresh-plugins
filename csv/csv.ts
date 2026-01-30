/// <reference path="./lib/fresh.d.ts" />

/**
 * CSV/TSV Spreadsheet Plugin for Fresh Editor
 *
 * Uses view_transform_request hook to render CSV files as spreadsheets
 * without loading the entire file into memory. Only the visible viewport
 * is processed and transformed.
 */

const editor = getEditor();

// Track which buffers have CSV view enabled
const csvBuffers = new Set<number>();

// Config per buffer
interface CsvConfig {
  delimiter: string;
  columnWidths: number[];
  numColumns: number;
}
const bufferConfigs = new Map<number, CsvConfig>();

// Constants
const MIN_COL_WIDTH = 6;
const MAX_COL_WIDTH = 24;
const ROW_NUM_WIDTH = 5;

/**
 * Check if a file path is a CSV/TSV file
 */
function isCsvPath(path: string | null): boolean {
  if (!path) return false;
  const ext = editor.pathExtname(path).toLowerCase();
  return ext === ".csv" || ext === ".tsv";
}

/**
 * Detect delimiter from content
 */
function detectDelimiter(content: string): string {
  const firstLine = content.split("\n")[0] || "";
  const counts: Record<string, number> = { "\t": 0, ",": 0, ";": 0, "|": 0 };

  let inQuotes = false;
  for (const char of firstLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char in counts) counts[char]++;
  }

  if (counts["\t"] > 0) return "\t";
  if (counts[","] > 0) return ",";
  if (counts[";"] > 0) return ";";
  if (counts["|"] > 0) return "|";
  return ",";
}

/**
 * Parse a CSV line into fields
 */
function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') inQuotes = true;
      else if (char === delimiter) {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Sample column widths from buffer content
 */
async function sampleColumnWidths(bufferId: number): Promise<CsvConfig> {
  const info = editor.getBufferInfo(bufferId);
  const sampleBytes = Math.min(info?.length || 0, 10000);
  const content = await editor.getBufferText(bufferId, 0, sampleBytes) || "";

  const delimiter = detectDelimiter(content);
  const lines = content.split("\n").slice(0, 50);

  let maxCols = 0;
  const parsedLines: string[][] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    const fields = parseCsvLine(line, delimiter);
    parsedLines.push(fields);
    maxCols = Math.max(maxCols, fields.length);
  }

  const widths: number[] = new Array(maxCols).fill(MIN_COL_WIDTH);
  for (const fields of parsedLines) {
    for (let col = 0; col < fields.length; col++) {
      widths[col] = Math.max(widths[col], Math.min(fields[col].length + 1, MAX_COL_WIDTH));
    }
  }

  return { delimiter, columnWidths: widths, numColumns: maxCols };
}

/**
 * Extract text from tokens (TypeScript format)
 */
function extractText(tokens: ViewTokenWire[]): string {
  let text = "";
  for (const token of tokens) {
    const kind = token.kind;
    if (kind === "Newline") text += "\n";
    else if (kind === "Space") text += " ";
    else if (typeof kind === "object" && "Text" in kind) text += kind.Text;
  }
  return text;
}

/**
 * Pad text to width, truncating with ellipsis if needed
 */
function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width - 1) + "…";
  return text + " ".repeat(width - text.length);
}

/**
 * Create a Rust-compatible token
 * Rust expects: {kind: "text"|"newline"|"space"|"break", text: "...", sourceOffset: N}
 */
function makeToken(kind: "text" | "newline" | "space" | "break", text: string, sourceOffset: number | null): Record<string, unknown> {
  return { kind, text, sourceOffset };
}

/**
 * Estimate line number at byte offset (approximate for large files)
 */
async function estimateLineNumber(bufferId: number, byteOffset: number): Promise<number> {
  if (byteOffset === 0) return 1;

  // Read text up to offset and count newlines
  // For large files, limit to first 100KB for performance
  const readLimit = Math.min(byteOffset, 100000);
  const text = await editor.getBufferText(bufferId, 0, readLimit);
  if (!text) return 1;

  let lineNum = 1;
  for (let i = 0; i < text.length && i < byteOffset; i++) {
    if (text[i] === '\n') lineNum++;
  }
  return lineNum;
}

// Cache for line numbers to avoid re-reading on every transform
const lineNumberCache = new Map<string, number>();

/**
 * Transform CSV tokens into spreadsheet display
 */
function transformCsvTokens(
  tokens: ViewTokenWire[],
  config: CsvConfig,
  viewportStart: number,
  startLineNum: number
): Record<string, unknown>[] {
  const text = extractText(tokens);
  const lines = text.split("\n");
  const output: Record<string, unknown>[] = [];

  let offset = viewportStart;
  let lineNum = startLineNum;

  for (const line of lines) {
    // Skip final empty line
    if (line === "" && lines.indexOf(line) === lines.length - 1) break;

    const fields = parseCsvLine(line, config.delimiter);

    // Row number
    const rowNumStr = lineNum.toString().padStart(ROW_NUM_WIDTH - 1) + "│";
    output.push(makeToken("text", rowNumStr, offset));

    // Fields
    for (let col = 0; col < config.numColumns; col++) {
      const value = fields[col] ?? "";
      const width = config.columnWidths[col] || 10;
      output.push(makeToken("text", pad(value, width), offset));

      if (col < config.numColumns - 1) {
        output.push(makeToken("text", "│", null));
      }
    }

    output.push(makeToken("newline", "", offset + line.length));
    offset += line.length + 1;
    lineNum++;
  }

  return output;
}

/**
 * Handle view transform request
 */
globalThis.onCsvViewTransform = async function(data: {
  buffer_id: number;
  split_id: number;
  viewport_start: number;
  viewport_end: number;
  tokens: ViewTokenWire[];
}): Promise<void> {
  // Only transform if CSV view is enabled for this buffer
  if (!csvBuffers.has(data.buffer_id)) return;

  const config = bufferConfigs.get(data.buffer_id);
  if (!config) return;

  // Get starting line number (use cache for performance)
  const cacheKey = `${data.buffer_id}:${data.viewport_start}`;
  let startLine = lineNumberCache.get(cacheKey);
  if (startLine === undefined) {
    startLine = await estimateLineNumber(data.buffer_id, data.viewport_start);
    lineNumberCache.set(cacheKey, startLine);
    // Limit cache size
    if (lineNumberCache.size > 100) {
      const firstKey = lineNumberCache.keys().next().value;
      if (firstKey) lineNumberCache.delete(firstKey);
    }
  }

  // Transform to spreadsheet format
  const transformed = transformCsvTokens(data.tokens, config, data.viewport_start, startLine);

  // Calculate total width
  let totalWidth = ROW_NUM_WIDTH;
  for (const w of config.columnWidths) {
    totalWidth += w + 1;
  }

  editor.submitViewTransform(
    data.buffer_id,
    data.split_id,
    data.viewport_start,
    data.viewport_end,
    transformed as unknown as ViewTokenWire[],
    { composeWidth: totalWidth + 10, columnGuides: null }
  );
};

/**
 * Enable CSV view for buffer
 */
async function enableCsvView(bufferId: number): Promise<void> {
  if (csvBuffers.has(bufferId)) return;

  const config = await sampleColumnWidths(bufferId);
  bufferConfigs.set(bufferId, config);
  csvBuffers.add(bufferId);

  editor.setLineNumbers(bufferId, false);
  editor.refreshLines(bufferId);

  editor.setStatus(`Spreadsheet: ${config.numColumns} columns`);
}

/**
 * Disable CSV view for buffer
 */
function disableCsvView(bufferId: number): void {
  if (!csvBuffers.has(bufferId)) return;

  csvBuffers.delete(bufferId);
  bufferConfigs.delete(bufferId);

  editor.setLineNumbers(bufferId, true);
  editor.clearViewTransform(bufferId, null);
  editor.refreshLines(bufferId);

  editor.setStatus("Text view");
}

/**
 * Toggle CSV view
 */
globalThis.csv_toggle = async function(): Promise<void> {
  const bufferId = editor.getActiveBufferId();
  if (bufferId === null || bufferId === undefined) {
    editor.setStatus("No buffer");
    return;
  }

  if (!isCsvPath(editor.getBufferPath(bufferId))) {
    editor.setStatus("Not a CSV/TSV file");
    return;
  }

  if (csvBuffers.has(bufferId)) {
    disableCsvView(bufferId);
  } else {
    await enableCsvView(bufferId);
  }
};

globalThis.csv_open = globalThis.csv_toggle;

globalThis.onCsvBufferClosed = function(data: { buffer_id: number }): void {
  csvBuffers.delete(data.buffer_id);
  bufferConfigs.delete(data.buffer_id);
};

// Register
editor.on("view_transform_request", "onCsvViewTransform");
editor.on("buffer_closed", "onCsvBufferClosed");

editor.registerCommand("%cmd.toggle", "%cmd.toggle_desc", "csv_toggle", null);
editor.registerCommand("%cmd.open", "%cmd.open_desc", "csv_open", null);

editor.debug("CSV plugin loaded");
