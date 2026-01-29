/// <reference path="./lib/fresh.d.ts" />

/**
 * CSV/TSV Spreadsheet Plugin for Fresh Editor
 *
 * A spreadsheet-style viewer and editor for CSV/TSV files with:
 * - Auto-detection of delimiter (comma, tab, semicolon)
 * - Lotus 1-2-3 / Excel / Google Sheets style UI
 * - Cell navigation with Tab, arrow keys, Enter
 * - Inline cell editing
 * - Save back to original file
 * - Column and row headers
 * - Selection highlighting
 */

const editor = getEditor();

// =============================================================================
// Types
// =============================================================================

interface CsvState {
  isOpen: boolean;
  bufferId: number | null;
  splitId: number | null;
  sourceBufferId: number | null;
  sourcePath: string | null;
  delimiter: string;
  data: string[][];
  columnWidths: number[];
  cursorRow: number;
  cursorCol: number;
  editMode: boolean;
  editValue: string;
  scrollRow: number;
  scrollCol: number;
  modified: boolean;
  hasHeaderRow: boolean;
}

// =============================================================================
// State
// =============================================================================

const state: CsvState = {
  isOpen: false,
  bufferId: null,
  splitId: null,
  sourceBufferId: null,
  sourcePath: null,
  delimiter: ",",
  data: [],
  columnWidths: [],
  cursorRow: 0,
  cursorCol: 0,
  editMode: false,
  editValue: "",
  scrollRow: 0,
  scrollCol: 0,
  modified: false,
  hasHeaderRow: true,
};

// =============================================================================
// Layout Constants
// =============================================================================

const ROW_NUM_WIDTH = 5;       // Width for row numbers column
const MIN_COL_WIDTH = 8;       // Minimum column width
const MAX_COL_WIDTH = 30;      // Maximum column width
const DEFAULT_COL_WIDTH = 12;  // Default column width
const VISIBLE_ROWS = 20;       // Number of visible rows
const HEADER_HEIGHT = 3;       // Header rows (title, column headers, separator)
const FOOTER_HEIGHT = 2;       // Footer rows (separator, help)

// =============================================================================
// Theme Colors
// =============================================================================

interface ThemeColor {
  fg?: [number, number, number];
  bg?: [number, number, number];
  bold?: boolean;
}

const theme: Record<string, ThemeColor> = {
  // Headers
  title: { fg: [100, 180, 255], bold: true },
  columnHeader: { fg: [180, 180, 100], bg: [40, 42, 50], bold: true },
  rowNumber: { fg: [120, 120, 130], bg: [35, 37, 42] },

  // Cells
  cell: { fg: [200, 200, 210] },
  cellEven: { fg: [200, 200, 210], bg: [32, 34, 38] },
  cellOdd: { fg: [200, 200, 210], bg: [38, 40, 45] },
  cellSelected: { fg: [255, 255, 255], bg: [60, 90, 140] },
  cellEditing: { fg: [255, 255, 255], bg: [80, 120, 60] },
  headerCell: { fg: [220, 220, 180], bg: [45, 48, 55], bold: true },

  // Grid elements
  border: { fg: [60, 62, 70] },
  separator: { fg: [50, 52, 58] },

  // Status
  modified: { fg: [220, 180, 80] },
  help: { fg: [100, 100, 110] },
  error: { fg: [255, 100, 100] },
};

// =============================================================================
// CSV Parsing
// =============================================================================

/**
 * Detect the delimiter used in CSV content
 */
function detectDelimiter(content: string): string {
  const firstLine = content.split("\n")[0] || "";

  // Count occurrences of common delimiters
  const counts: Record<string, number> = {
    "\t": 0,
    ",": 0,
    ";": 0,
    "|": 0,
  };

  // Count delimiters outside of quoted strings
  let inQuotes = false;
  for (const char of firstLine) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && char in counts) {
      counts[char]++;
    }
  }

  // Prefer tab, then comma, then semicolon, then pipe
  if (counts["\t"] > 0) return "\t";
  if (counts[","] > 0) return ",";
  if (counts[";"] > 0) return ";";
  if (counts["|"] > 0) return "|";

  return ","; // Default to comma
}

/**
 * Parse CSV content into a 2D array
 */
function parseCsv(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    if (line.trim() === "" && rows.length > 0) continue;

    const row: string[] = [];
    let current = "";
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
      const char = line[i];

      if (inQuotes) {
        if (char === '"') {
          // Check for escaped quote
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i += 2;
          } else {
            inQuotes = false;
            i++;
          }
        } else {
          current += char;
          i++;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
          i++;
        } else if (char === delimiter) {
          row.push(current);
          current = "";
          i++;
        } else {
          current += char;
          i++;
        }
      }
    }

    // Don't forget the last field
    row.push(current);
    rows.push(row);
  }

  return rows;
}

/**
 * Serialize data back to CSV format
 */
function serializeCsv(data: string[][], delimiter: string): string {
  return data
    .map((row) =>
      row
        .map((cell) => {
          // Quote if contains delimiter, quotes, or newlines
          if (
            cell.includes(delimiter) ||
            cell.includes('"') ||
            cell.includes("\n") ||
            cell.includes("\r")
          ) {
            return '"' + cell.replace(/"/g, '""') + '"';
          }
          return cell;
        })
        .join(delimiter)
    )
    .join("\n");
}

// =============================================================================
// Column/Row Utilities
// =============================================================================

/**
 * Convert column index to letter (0 -> A, 25 -> Z, 26 -> AA, etc.)
 */
function colToLetter(col: number): string {
  let result = "";
  let n = col;
  do {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result;
}

/**
 * Calculate column widths based on content
 */
function calculateColumnWidths(data: string[][]): number[] {
  if (data.length === 0) return [];

  const maxCols = Math.max(...data.map((row) => row.length));
  const widths: number[] = new Array(maxCols).fill(MIN_COL_WIDTH);

  // Consider header width (A, B, C, ..., AA, AB, ...)
  for (let col = 0; col < maxCols; col++) {
    const headerWidth = colToLetter(col).length + 2; // +2 for padding
    widths[col] = Math.max(widths[col], headerWidth);
  }

  // Consider content width
  for (const row of data) {
    for (let col = 0; col < row.length; col++) {
      const cellWidth = row[col].length + 2; // +2 for padding
      widths[col] = Math.max(widths[col], Math.min(cellWidth, MAX_COL_WIDTH));
    }
  }

  return widths;
}

/**
 * Truncate text to fit width, adding ellipsis if needed
 */
function truncate(text: string, width: number): string {
  if (text.length <= width - 2) {
    return text;
  }
  return text.slice(0, width - 3) + "…";
}

/**
 * Pad/truncate cell content to fit column width
 */
function formatCell(text: string, width: number, align: "left" | "right" | "center" = "left"): string {
  const truncated = truncate(text, width);
  const padding = width - truncated.length;

  switch (align) {
    case "right":
      return " ".repeat(padding) + truncated;
    case "center":
      const left = Math.floor(padding / 2);
      const right = padding - left;
      return " ".repeat(left) + truncated + " ".repeat(right);
    case "left":
    default:
      return truncated + " ".repeat(padding);
  }
}

// =============================================================================
// Rendering
// =============================================================================

/**
 * Build the spreadsheet view entries
 */
function buildSpreadsheetView(): TextPropertyEntry[] {
  const entries: TextPropertyEntry[] = [];
  const viewport = editor.getViewport();
  const viewHeight = viewport ? viewport.height : VISIBLE_ROWS;
  const visibleRows = Math.max(5, viewHeight - HEADER_HEIGHT - FOOTER_HEIGHT);

  // Calculate visible area
  const totalRows = state.data.length;
  const totalCols = state.columnWidths.length;

  // Ensure cursor is within bounds
  state.cursorRow = Math.max(0, Math.min(state.cursorRow, totalRows - 1));
  state.cursorCol = Math.max(0, Math.min(state.cursorCol, totalCols - 1));

  // Adjust scroll to keep cursor visible
  if (state.cursorRow < state.scrollRow) {
    state.scrollRow = state.cursorRow;
  } else if (state.cursorRow >= state.scrollRow + visibleRows) {
    state.scrollRow = state.cursorRow - visibleRows + 1;
  }

  // Calculate which columns are visible based on viewport width
  const viewWidth = viewport ? viewport.width : 80;
  let visibleColWidth = ROW_NUM_WIDTH + 1; // Start with row number column
  let endCol = state.scrollCol;
  while (endCol < totalCols && visibleColWidth + state.columnWidths[endCol] + 1 < viewWidth) {
    visibleColWidth += state.columnWidths[endCol] + 1;
    endCol++;
  }
  if (endCol === state.scrollCol && totalCols > 0) {
    endCol = state.scrollCol + 1; // Show at least one column
  }

  // Ensure scroll column keeps cursor visible
  if (state.cursorCol < state.scrollCol) {
    state.scrollCol = state.cursorCol;
  } else if (state.cursorCol >= endCol) {
    state.scrollCol = state.cursorCol;
    // Recalculate endCol
    visibleColWidth = ROW_NUM_WIDTH + 1;
    endCol = state.scrollCol;
    while (endCol < totalCols && visibleColWidth + state.columnWidths[endCol] + 1 < viewWidth) {
      visibleColWidth += state.columnWidths[endCol] + 1;
      endCol++;
    }
    if (endCol === state.scrollCol && totalCols > 0) {
      endCol = state.scrollCol + 1;
    }
  }

  // === Title Row ===
  const delimName = state.delimiter === "\t" ? "TSV" : state.delimiter === "," ? "CSV" : "DSV";
  const fileName = state.sourcePath ? editor.pathBasename(state.sourcePath) : "Untitled";
  const modifiedIndicator = state.modified ? " [+]" : "";
  const cellRef = totalRows > 0 ? ` - ${colToLetter(state.cursorCol)}${state.cursorRow + 1}` : "";

  entries.push({
    text: ` ${fileName}${modifiedIndicator} (${delimName})${cellRef}\n`,
    properties: { type: "title" },
  });

  if (totalRows === 0) {
    entries.push({
      text: "\n  No data\n\n",
      properties: { type: "empty" },
    });
    entries.push({
      text: " Press 'q' to close\n",
      properties: { type: "help" },
    });
    return entries;
  }

  // === Column Headers Row ===
  // Row number header
  entries.push({
    text: " ".repeat(ROW_NUM_WIDTH) + "│",
    properties: { type: "border" },
  });

  // Column letters
  for (let col = state.scrollCol; col < endCol && col < totalCols; col++) {
    const header = formatCell(colToLetter(col), state.columnWidths[col], "center");
    const isSelectedCol = col === state.cursorCol;
    entries.push({
      text: header,
      properties: {
        type: "columnHeader",
        selected: isSelectedCol,
      },
    });
    entries.push({
      text: "│",
      properties: { type: "border" },
    });
  }
  entries.push({ text: "\n", properties: { type: "newline" } });

  // === Separator Row ===
  entries.push({
    text: "─".repeat(ROW_NUM_WIDTH) + "┼",
    properties: { type: "separator" },
  });
  for (let col = state.scrollCol; col < endCol && col < totalCols; col++) {
    entries.push({
      text: "─".repeat(state.columnWidths[col]) + "┼",
      properties: { type: "separator" },
    });
  }
  entries.push({ text: "\n", properties: { type: "newline" } });

  // === Data Rows ===
  const endRow = Math.min(state.scrollRow + visibleRows, totalRows);
  for (let row = state.scrollRow; row < endRow; row++) {
    const rowData = state.data[row] || [];
    const isHeaderRow = state.hasHeaderRow && row === 0;
    const isSelectedRow = row === state.cursorRow;

    // Row number
    const rowNum = (row + 1).toString().padStart(ROW_NUM_WIDTH - 1) + " ";
    entries.push({
      text: rowNum,
      properties: {
        type: "rowNumber",
        selected: isSelectedRow,
      },
    });
    entries.push({
      text: "│",
      properties: { type: "border" },
    });

    // Cells
    for (let col = state.scrollCol; col < endCol && col < totalCols; col++) {
      const cellValue = rowData[col] ?? "";
      const isSelected = row === state.cursorRow && col === state.cursorCol;
      const isEditing = isSelected && state.editMode;

      // Determine display value
      let displayValue: string;
      if (isEditing) {
        displayValue = state.editValue + "▌"; // Cursor indicator
      } else {
        displayValue = cellValue;
      }

      // Format cell
      const formatted = formatCell(displayValue, state.columnWidths[col]);

      // Determine cell type for styling
      let cellType: string;
      if (isEditing) {
        cellType = "cellEditing";
      } else if (isSelected) {
        cellType = "cellSelected";
      } else if (isHeaderRow) {
        cellType = "headerCell";
      } else {
        cellType = row % 2 === 0 ? "cellEven" : "cellOdd";
      }

      entries.push({
        text: formatted,
        properties: {
          type: cellType,
          row,
          col,
        },
      });
      entries.push({
        text: "│",
        properties: { type: "border" },
      });
    }
    entries.push({ text: "\n", properties: { type: "newline" } });
  }

  // === Bottom Separator ===
  entries.push({
    text: "─".repeat(ROW_NUM_WIDTH) + "┴",
    properties: { type: "separator" },
  });
  for (let col = state.scrollCol; col < endCol && col < totalCols; col++) {
    entries.push({
      text: "─".repeat(state.columnWidths[col]) + "┴",
      properties: { type: "separator" },
    });
  }
  entries.push({ text: "\n", properties: { type: "newline" } });

  // === Help/Status Row ===
  let helpText: string;
  if (state.editMode) {
    helpText = " Enter:confirm  Esc:cancel  Type to edit";
  } else {
    helpText = " ←↑↓→:move  Tab:next  Enter:edit  s:save  q:close";
  }

  const rowInfo = `  ${state.cursorRow + 1}/${totalRows} rows`;
  const scrollInfo = state.scrollRow > 0 || endRow < totalRows
    ? `  (${state.scrollRow + 1}-${endRow})`
    : "";

  entries.push({
    text: helpText + rowInfo + scrollInfo + "\n",
    properties: { type: "help" },
  });

  return entries;
}

/**
 * Calculate UTF-8 byte length
 */
function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Apply styling overlays
 */
function applyHighlighting(): void {
  if (state.bufferId === null) return;

  editor.clearNamespace(state.bufferId, "csv");

  const entries = buildSpreadsheetView();
  let byteOffset = 0;

  for (const entry of entries) {
    const props = entry.properties as Record<string, unknown>;
    const len = utf8ByteLength(entry.text);
    const type = props.type as string;

    let style = theme[type];

    // Handle selected variants
    if (props.selected && type === "columnHeader") {
      style = { ...theme.columnHeader, bg: [60, 70, 90] as [number, number, number] };
    } else if (props.selected && type === "rowNumber") {
      style = { ...theme.rowNumber, fg: [180, 180, 200] as [number, number, number] };
    }

    if (style) {
      const options: Record<string, unknown> = {};
      if (style.fg) options.fg = style.fg;
      if (style.bg) options.bg = style.bg;
      if (style.bold) options.bold = true;

      if (Object.keys(options).length > 0) {
        editor.addOverlay(state.bufferId, "csv", byteOffset, byteOffset + len, options);
      }
    }

    byteOffset += len;
  }
}

/**
 * Update the view
 */
function updateView(): void {
  if (state.bufferId === null) return;

  const entries = buildSpreadsheetView();
  editor.setVirtualBufferContent(state.bufferId, entries);
  applyHighlighting();
}

// =============================================================================
// Navigation
// =============================================================================

globalThis.csv_move_left = function (): void {
  if (!state.isOpen || state.editMode) return;
  if (state.cursorCol > 0) {
    state.cursorCol--;
    updateView();
  }
};

globalThis.csv_move_right = function (): void {
  if (!state.isOpen || state.editMode) return;
  if (state.cursorCol < state.columnWidths.length - 1) {
    state.cursorCol++;
    updateView();
  }
};

globalThis.csv_move_up = function (): void {
  if (!state.isOpen || state.editMode) return;
  if (state.cursorRow > 0) {
    state.cursorRow--;
    updateView();
  }
};

globalThis.csv_move_down = function (): void {
  if (!state.isOpen || state.editMode) return;
  if (state.cursorRow < state.data.length - 1) {
    state.cursorRow++;
    updateView();
  }
};

globalThis.csv_tab_next = function (): void {
  if (!state.isOpen) return;

  if (state.editMode) {
    // Confirm current edit and move to next cell
    confirmEdit();
  }

  // Move to next cell (right, or next row)
  if (state.cursorCol < state.columnWidths.length - 1) {
    state.cursorCol++;
  } else if (state.cursorRow < state.data.length - 1) {
    state.cursorCol = 0;
    state.cursorRow++;
  }
  updateView();
};

globalThis.csv_tab_prev = function (): void {
  if (!state.isOpen) return;

  if (state.editMode) {
    confirmEdit();
  }

  // Move to previous cell
  if (state.cursorCol > 0) {
    state.cursorCol--;
  } else if (state.cursorRow > 0) {
    state.cursorRow--;
    state.cursorCol = state.columnWidths.length - 1;
  }
  updateView();
};

globalThis.csv_home = function (): void {
  if (!state.isOpen || state.editMode) return;
  state.cursorCol = 0;
  updateView();
};

globalThis.csv_end = function (): void {
  if (!state.isOpen || state.editMode) return;
  state.cursorCol = state.columnWidths.length - 1;
  updateView();
};

globalThis.csv_page_up = function (): void {
  if (!state.isOpen || state.editMode) return;
  const viewport = editor.getViewport();
  const visibleRows = viewport ? viewport.height - HEADER_HEIGHT - FOOTER_HEIGHT : 10;
  state.cursorRow = Math.max(0, state.cursorRow - visibleRows);
  updateView();
};

globalThis.csv_page_down = function (): void {
  if (!state.isOpen || state.editMode) return;
  const viewport = editor.getViewport();
  const visibleRows = viewport ? viewport.height - HEADER_HEIGHT - FOOTER_HEIGHT : 10;
  state.cursorRow = Math.min(state.data.length - 1, state.cursorRow + visibleRows);
  updateView();
};

globalThis.csv_goto_top = function (): void {
  if (!state.isOpen || state.editMode) return;
  state.cursorRow = 0;
  state.cursorCol = 0;
  updateView();
};

globalThis.csv_goto_bottom = function (): void {
  if (!state.isOpen || state.editMode) return;
  state.cursorRow = state.data.length - 1;
  updateView();
};

// =============================================================================
// Editing
// =============================================================================

function confirmEdit(): void {
  if (!state.editMode) return;

  // Ensure row exists
  while (state.data.length <= state.cursorRow) {
    state.data.push([]);
  }

  // Ensure column exists in row
  const row = state.data[state.cursorRow];
  while (row.length <= state.cursorCol) {
    row.push("");
  }

  // Update cell value
  const oldValue = row[state.cursorCol];
  if (oldValue !== state.editValue) {
    row[state.cursorCol] = state.editValue;
    state.modified = true;
  }

  state.editMode = false;
  state.editValue = "";
}

function cancelEdit(): void {
  state.editMode = false;
  state.editValue = "";
}

globalThis.csv_enter_edit = function (): void {
  if (!state.isOpen) return;

  if (state.editMode) {
    // Confirm and move down
    confirmEdit();
    if (state.cursorRow < state.data.length - 1) {
      state.cursorRow++;
    }
  } else {
    // Enter edit mode
    const row = state.data[state.cursorRow] || [];
    state.editValue = row[state.cursorCol] ?? "";
    state.editMode = true;
  }
  updateView();
};

globalThis.csv_cancel_edit = function (): void {
  if (!state.isOpen) return;

  if (state.editMode) {
    cancelEdit();
    updateView();
  } else {
    // Close the spreadsheet
    globalThis.csv_close();
  }
};

globalThis.csv_backspace = function (): void {
  if (!state.isOpen || !state.editMode) return;

  if (state.editValue.length > 0) {
    state.editValue = state.editValue.slice(0, -1);
    updateView();
  }
};

globalThis.csv_delete_cell = function (): void {
  if (!state.isOpen) return;

  if (state.editMode) {
    state.editValue = "";
  } else {
    // Clear current cell
    const row = state.data[state.cursorRow];
    if (row && row[state.cursorCol] !== undefined) {
      row[state.cursorCol] = "";
      state.modified = true;
    }
  }
  updateView();
};

// Character input handler for edit mode
function createCharHandler(char: string): () => void {
  return function (): void {
    if (!state.isOpen) return;

    if (state.editMode) {
      state.editValue += char;
      updateView();
    } else {
      // Start editing with this character
      state.editValue = char;
      state.editMode = true;
      updateView();
    }
  };
}

// Register character handlers for edit mode
const printableChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;':\",./<>? ";
for (const char of printableChars) {
  const handlerName = `csv_char_${char.charCodeAt(0)}`;
  (globalThis as Record<string, unknown>)[handlerName] = createCharHandler(char);
}

// =============================================================================
// Row/Column Operations
// =============================================================================

globalThis.csv_insert_row = function (): void {
  if (!state.isOpen || state.editMode) return;

  const newRow = new Array(state.columnWidths.length).fill("");
  state.data.splice(state.cursorRow + 1, 0, newRow);
  state.cursorRow++;
  state.modified = true;
  updateView();
};

globalThis.csv_delete_row = function (): void {
  if (!state.isOpen || state.editMode) return;
  if (state.data.length <= 1) return; // Keep at least one row

  state.data.splice(state.cursorRow, 1);
  if (state.cursorRow >= state.data.length) {
    state.cursorRow = state.data.length - 1;
  }
  state.modified = true;
  updateView();
};

globalThis.csv_insert_col = function (): void {
  if (!state.isOpen || state.editMode) return;

  for (const row of state.data) {
    row.splice(state.cursorCol + 1, 0, "");
  }
  state.columnWidths.splice(state.cursorCol + 1, 0, DEFAULT_COL_WIDTH);
  state.cursorCol++;
  state.modified = true;
  updateView();
};

globalThis.csv_delete_col = function (): void {
  if (!state.isOpen || state.editMode) return;
  if (state.columnWidths.length <= 1) return; // Keep at least one column

  for (const row of state.data) {
    row.splice(state.cursorCol, 1);
  }
  state.columnWidths.splice(state.cursorCol, 1);
  if (state.cursorCol >= state.columnWidths.length) {
    state.cursorCol = state.columnWidths.length - 1;
  }
  state.modified = true;
  updateView();
};

// =============================================================================
// Save/Close
// =============================================================================

globalThis.csv_save = async function (): Promise<void> {
  if (!state.isOpen) return;

  if (state.editMode) {
    confirmEdit();
  }

  if (!state.sourcePath) {
    // Prompt for file path
    const path = await editor.prompt("Save as:", "data.csv");
    if (!path) {
      editor.setStatus("Save cancelled");
      return;
    }
    state.sourcePath = path;
  }

  const content = serializeCsv(state.data, state.delimiter);
  if (editor.writeFile(state.sourcePath, content)) {
    state.modified = false;
    editor.setStatus(`Saved ${state.sourcePath}`);
    updateView();
  } else {
    editor.setStatus(`Failed to save ${state.sourcePath}`);
  }
};

globalThis.csv_close = function (): void {
  if (!state.isOpen) return;

  if (state.modified) {
    // TODO: Prompt to save changes
    editor.setStatus("Unsaved changes - press 's' to save first, or 'Q' to discard");
    return;
  }

  if (state.bufferId !== null) {
    editor.closeBuffer(state.bufferId);
  }

  // Restore previous buffer
  if (state.sourceBufferId !== null) {
    editor.showBuffer(state.sourceBufferId);
  }

  // Reset state
  state.isOpen = false;
  state.bufferId = null;
  state.splitId = null;
  state.data = [];
  state.columnWidths = [];
  state.modified = false;
};

globalThis.csv_force_close = function (): void {
  if (!state.isOpen) return;

  state.modified = false; // Discard changes
  globalThis.csv_close();
};

globalThis.csv_toggle_header = function (): void {
  if (!state.isOpen || state.editMode) return;

  state.hasHeaderRow = !state.hasHeaderRow;
  editor.setStatus(state.hasHeaderRow ? "First row is header" : "No header row");
  updateView();
};

// =============================================================================
// Mode Definition
// =============================================================================

function defineCsvMode(): void {
  const bindings: [string, string][] = [
    // Navigation
    ["Left", "csv_move_left"],
    ["Right", "csv_move_right"],
    ["Up", "csv_move_up"],
    ["Down", "csv_move_down"],
    ["h", "csv_move_left"],
    ["l", "csv_move_right"],
    ["k", "csv_move_up"],
    ["j", "csv_move_down"],
    ["Tab", "csv_tab_next"],
    ["S-Tab", "csv_tab_prev"],
    ["Home", "csv_home"],
    ["End", "csv_end"],
    ["PageUp", "csv_page_up"],
    ["PageDown", "csv_page_down"],
    ["g g", "csv_goto_top"],
    ["G", "csv_goto_bottom"],

    // Editing
    ["Return", "csv_enter_edit"],
    ["Escape", "csv_cancel_edit"],
    ["Backspace", "csv_backspace"],
    ["Delete", "csv_delete_cell"],

    // Row/Column operations
    ["o", "csv_insert_row"],
    ["d d", "csv_delete_row"],
    ["A-Right", "csv_insert_col"],
    ["A-Left", "csv_delete_col"],

    // Save/Close
    ["s", "csv_save"],
    ["C-s", "csv_save"],
    ["q", "csv_close"],
    ["S-Q", "csv_force_close"],

    // Toggle header
    ["H", "csv_toggle_header"],
  ];

  // Add character bindings for edit mode
  for (const char of printableChars) {
    const code = char.charCodeAt(0);
    const handlerName = `csv_char_${code}`;

    // Map key - handle special cases
    let key: string;
    if (char === " ") {
      key = "Space";
    } else if (char === char.toUpperCase() && char !== char.toLowerCase()) {
      // Uppercase letter
      key = `S-${char.toLowerCase()}`;
    } else {
      key = char;
    }

    // Skip keys already bound to navigation/commands
    if (["h", "j", "k", "l", "s", "q", "o", "g", "G", "H"].includes(char)) {
      continue;
    }

    bindings.push([key, handlerName]);
  }

  editor.defineMode("csv", "normal", bindings, true);
}

// =============================================================================
// Commands
// =============================================================================

/**
 * Open current buffer as CSV spreadsheet
 */
globalThis.csv_open = async function (): Promise<void> {
  if (state.isOpen) {
    editor.showBuffer(state.bufferId!);
    return;
  }

  const bufferId = editor.getActiveBufferId();
  if (!bufferId) {
    editor.setStatus("No buffer open");
    return;
  }

  const bufferInfo = editor.getBufferInfo(bufferId);
  if (!bufferInfo) {
    editor.setStatus("Cannot read buffer");
    return;
  }

  // Read buffer content
  const content = await editor.getBufferText(bufferId, 0, bufferInfo.length);
  if (!content || content.trim() === "") {
    editor.setStatus("Buffer is empty");
    return;
  }

  // Parse CSV
  const delimiter = detectDelimiter(content);
  const data = parseCsv(content, delimiter);

  if (data.length === 0) {
    editor.setStatus("No data found in file");
    return;
  }

  // Initialize state
  state.sourceBufferId = bufferId;
  state.sourcePath = bufferInfo.path || null;
  state.splitId = editor.getActiveSplitId();
  state.delimiter = delimiter;
  state.data = data;
  state.columnWidths = calculateColumnWidths(data);
  state.cursorRow = 0;
  state.cursorCol = 0;
  state.scrollRow = 0;
  state.scrollCol = 0;
  state.editMode = false;
  state.editValue = "";
  state.modified = false;
  state.hasHeaderRow = true;

  // Build initial view
  const entries = buildSpreadsheetView();

  // Create virtual buffer
  const result = await editor.createVirtualBufferInExistingSplit({
    name: `*${editor.pathBasename(state.sourcePath || "Spreadsheet")}*`,
    mode: "csv",
    readOnly: true,
    editingDisabled: true,
    showCursors: false,
    showLineNumbers: false,
    splitId: state.splitId!,
    entries,
  });

  state.bufferId = result.bufferId;
  state.isOpen = true;

  applyHighlighting();

  const delimName = delimiter === "\t" ? "Tab" : delimiter === "," ? "Comma" : "Delimiter: " + delimiter;
  editor.setStatus(`Opened ${data.length} rows, ${state.columnWidths.length} columns (${delimName})`);
};

/**
 * Open a file as CSV spreadsheet
 */
globalThis.csv_open_file = async function (): Promise<void> {
  const path = await editor.prompt("Open CSV file:", "");
  if (!path) return;

  const content = editor.readFile(path);
  if (!content) {
    editor.setStatus(`Cannot read file: ${path}`);
    return;
  }

  // Create a temporary buffer with the content, then open as CSV
  // For now, we'll parse directly
  const delimiter = detectDelimiter(content);
  const data = parseCsv(content, delimiter);

  if (data.length === 0) {
    editor.setStatus("No data found in file");
    return;
  }

  // Initialize state
  state.sourceBufferId = null;
  state.sourcePath = path;
  state.splitId = editor.getActiveSplitId();
  state.delimiter = delimiter;
  state.data = data;
  state.columnWidths = calculateColumnWidths(data);
  state.cursorRow = 0;
  state.cursorCol = 0;
  state.scrollRow = 0;
  state.scrollCol = 0;
  state.editMode = false;
  state.editValue = "";
  state.modified = false;
  state.hasHeaderRow = true;

  // Build initial view
  const entries = buildSpreadsheetView();

  // Create virtual buffer
  const result = await editor.createVirtualBuffer({
    name: `*${editor.pathBasename(path)}*`,
    mode: "csv",
    readOnly: true,
    editingDisabled: true,
    showCursors: false,
    showLineNumbers: false,
    entries,
  });

  state.bufferId = result.bufferId;
  state.isOpen = true;

  applyHighlighting();

  editor.setStatus(`Opened ${data.length} rows, ${state.columnWidths.length} columns`);
};

/**
 * Create a new empty spreadsheet
 */
globalThis.csv_new = async function (): Promise<void> {
  // Create 10x5 empty grid
  const rows = 10;
  const cols = 5;
  const data: string[][] = [];
  for (let i = 0; i < rows; i++) {
    data.push(new Array(cols).fill(""));
  }

  // Initialize state
  state.sourceBufferId = null;
  state.sourcePath = null;
  state.splitId = editor.getActiveSplitId();
  state.delimiter = ",";
  state.data = data;
  state.columnWidths = new Array(cols).fill(DEFAULT_COL_WIDTH);
  state.cursorRow = 0;
  state.cursorCol = 0;
  state.scrollRow = 0;
  state.scrollCol = 0;
  state.editMode = false;
  state.editValue = "";
  state.modified = false;
  state.hasHeaderRow = false;

  // Build initial view
  const entries = buildSpreadsheetView();

  // Create virtual buffer
  const result = await editor.createVirtualBuffer({
    name: "*New Spreadsheet*",
    mode: "csv",
    readOnly: true,
    editingDisabled: true,
    showCursors: false,
    showLineNumbers: false,
    entries,
  });

  state.bufferId = result.bufferId;
  state.isOpen = true;

  applyHighlighting();

  editor.setStatus("New spreadsheet created");
};

// =============================================================================
// Auto-open for CSV/TSV files
// =============================================================================

globalThis.onCsvBufferOpened = function (data: { buffer_id: number; path: string }): void {
  const ext = editor.pathExtname(data.path).toLowerCase();
  if (ext === ".csv" || ext === ".tsv") {
    // Show the buffer first, then open as spreadsheet
    editor.showBuffer(data.buffer_id);
    // Use setTimeout equivalent via delay to let buffer fully open
    (async () => {
      await editor.delay(100);
      globalThis.csv_open();
    })();
  }
};

// Optionally auto-open CSV files - disabled by default, uncomment to enable
// editor.on("buffer_opened", "onCsvBufferOpened");

// =============================================================================
// Mode and Command Registration (runs once at plugin load)
// =============================================================================

// Define the CSV mode with keybindings
defineCsvMode();

// Register mode-specific commands
const csvCommands = [
  ["csv_move_left", "Move left"],
  ["csv_move_right", "Move right"],
  ["csv_move_up", "Move up"],
  ["csv_move_down", "Move down"],
  ["csv_tab_next", "Next cell"],
  ["csv_tab_prev", "Previous cell"],
  ["csv_enter_edit", "Edit cell"],
  ["csv_cancel_edit", "Cancel/Close"],
  ["csv_save", "Save"],
  ["csv_close", "Close"],
  ["csv_insert_row", "Insert row"],
  ["csv_delete_row", "Delete row"],
  ["csv_insert_col", "Insert column"],
  ["csv_delete_col", "Delete column"],
  ["csv_toggle_header", "Toggle header row"],
];

for (const [name, desc] of csvCommands) {
  editor.registerCommand(name, `CSV: ${desc}`, name, "csv");
}

// Register character input handlers for edit mode
for (const char of printableChars) {
  const handlerName = `csv_char_${char.charCodeAt(0)}`;
  editor.registerCommand(handlerName, `CSV: Type '${char}'`, handlerName, "csv");
}

// =============================================================================
// Global Command Registration
// =============================================================================

editor.registerCommand(
  "%cmd.open",
  "%cmd.open_desc",
  "csv_open",
  null
);

editor.registerCommand(
  "%cmd.open_file",
  "%cmd.open_file_desc",
  "csv_open_file",
  null
);

editor.registerCommand(
  "%cmd.new",
  "%cmd.new_desc",
  "csv_new",
  null
);

editor.debug("CSV Spreadsheet plugin loaded");
