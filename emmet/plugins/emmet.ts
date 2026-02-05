/// <reference path="./lib/fresh.d.ts" />
const editor = getEditor();

/**
 * Emmet Plugin for Fresh Editor
 *
 * Expands Emmet abbreviations for HTML, CSS, JSX, and more.
 *
 * Features:
 * - HTML/XML tag expansion: div, div.class, div#id, input:text
 * - Nesting: div>p>span, ul>li*3
 * - Siblings: div+p+span
 * - Grouping: (div>p)+footer
 * - CSS abbreviations: m10, p10-20, w100p, fz16
 * - Keybinding: Tab to expand (when cursor follows an abbreviation)
 * - Command palette: "Emmet: Expand Abbreviation"
 *
 * Supported file types: HTML, CSS, JavaScript, TypeScript, JSX, TSX, Vue, Svelte
 */

// ============================================================================
// Types and Interfaces
// ============================================================================

interface EmmetNode {
  tag: string;
  id?: string;
  classes: string[];
  attributes: Record<string, string>;
  children: EmmetNode[];
  text?: string;
  repeat?: number;
  selfClosing?: boolean;
}

// ============================================================================
// Emmet HTML Parser
// ============================================================================

/**
 * Parse an Emmet abbreviation into a tree structure
 */
function parseEmmet(abbr: string): EmmetNode[] {
  try {
    const tokens = tokenize(abbr);
    return parseTokens(tokens);
  } catch (e) {
    editor.debug(`Emmet parse error: ${e}`);
    return [];
  }
}

/**
 * Tokenize an abbreviation into operators and elements
 */
function tokenize(abbr: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;

  for (let i = 0; i < abbr.length; i++) {
    const char = abbr[i];

    if (char === "(") {
      depth++;
      current += char;
    } else if (char === ")") {
      depth--;
      current += char;
    } else if (depth === 0 && (char === ">" || char === "+" || char === "*")) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      tokens.push(char);
    } else {
      current += char;
    }
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Parse tokens into EmmetNode tree
 */
function parseTokens(tokens: string[]): EmmetNode[] {
  const result: EmmetNode[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token === ">" || token === "+") {
      i++;
      continue;
    }

    if (token === "*") {
      // Handle multiplication
      i++;
      if (i < tokens.length && result.length > 0) {
        const count = parseInt(tokens[i], 10);
        if (!isNaN(count)) {
          const last = result[result.length - 1];
          last.repeat = count;
          i++;
        }
      }
      continue;
    }

    // Parse element
    const node = parseElement(token);

    // Check for nesting
    if (i + 1 < tokens.length && tokens[i + 1] === ">") {
      i += 2; // Skip '>'
      const children: EmmetNode[] = [];

      while (i < tokens.length && tokens[i] !== "+") {
        if (tokens[i] === "*") {
          i++;
          if (i < tokens.length && children.length > 0) {
            const count = parseInt(tokens[i], 10);
            if (!isNaN(count)) {
              const last = children[children.length - 1];
              last.repeat = count;
              i++;
            }
          }
          continue;
        }

        if (tokens[i] === ">") {
          i++;
          continue;
        }

        children.push(parseElement(tokens[i]));
        i++;

        if (i < tokens.length && tokens[i] === ">") {
          // Continue nesting deeper
          continue;
        } else {
          break;
        }
      }

      node.children = children;
    } else {
      i++;
    }

    result.push(node);
  }

  return result;
}

/**
 * Parse a single element with classes, IDs, and attributes
 */
function parseElement(token: string): EmmetNode {
  // Remove grouping parentheses
  if (token.startsWith("(") && token.endsWith(")")) {
    token = token.slice(1, -1);
  }

  const node: EmmetNode = {
    tag: "",
    classes: [],
    attributes: {},
    children: [],
  };

  // Parse tag name, classes, IDs, and attributes
  let i = 0;
  let part = "";
  let inAttr = false;
  let attrName = "";

  while (i < token.length) {
    const char = token[i];

    if (char === "[") {
      // Start of attributes
      if (part) {
        if (!node.tag) node.tag = part;
        part = "";
      }
      inAttr = true;
      i++;
      continue;
    }

    if (char === "]") {
      // End of attributes
      if (attrName && part) {
        node.attributes[attrName] = part;
      }
      inAttr = false;
      attrName = "";
      part = "";
      i++;
      continue;
    }

    if (inAttr) {
      if (char === "=") {
        attrName = part;
        part = "";
        i++;
        continue;
      }
      part += char;
      i++;
      continue;
    }

    if (char === ".") {
      if (part) {
        if (!node.tag) node.tag = part;
        part = "";
      }
      i++;
      // Read class name
      while (i < token.length && /[\w-]/.test(token[i])) {
        part += token[i];
        i++;
      }
      if (part) {
        node.classes.push(part);
        part = "";
      }
      continue;
    }

    if (char === "#") {
      if (part) {
        if (!node.tag) node.tag = part;
        part = "";
      }
      i++;
      // Read ID
      while (i < token.length && /[\w-]/.test(token[i])) {
        part += token[i];
        i++;
      }
      if (part) {
        node.id = part;
        part = "";
      }
      continue;
    }

    if (char === "{") {
      // Text content
      if (part) {
        if (!node.tag) node.tag = part;
        part = "";
      }
      i++;
      let text = "";
      while (i < token.length && token[i] !== "}") {
        text += token[i];
        i++;
      }
      node.text = text;
      i++; // Skip '}'
      continue;
    }

    if (char === ":") {
      // Shorthand like input:text, button:submit
      if (part) {
        if (!node.tag) node.tag = part;
        part = "";
      }
      i++;
      let type = "";
      while (i < token.length && /[\w-]/.test(token[i])) {
        type += token[i];
        i++;
      }
      if (node.tag === "input" || node.tag === "button") {
        node.attributes.type = type;
      }
      continue;
    }

    part += char;
    i++;
  }

  if (part) {
    if (!node.tag) node.tag = part;
  }

  // Default to div if no tag specified
  if (!node.tag && (node.classes.length > 0 || node.id)) {
    node.tag = "div";
  }

  // Handle self-closing tags
  const selfClosing = [
    "img",
    "input",
    "br",
    "hr",
    "meta",
    "link",
    "area",
    "base",
    "col",
    "embed",
    "param",
    "source",
    "track",
    "wbr",
  ];
  if (selfClosing.includes(node.tag)) {
    node.selfClosing = true;
  }

  return node;
}

/**
 * Render EmmetNode tree to HTML string
 */
function renderHTML(nodes: EmmetNode[], indent = 0): string {
  let result = "";
  const indentStr = "  ".repeat(indent);

  for (const node of nodes) {
    const repeat = node.repeat || 1;

    for (let r = 0; r < repeat; r++) {
      result += indentStr;
      result += `<${node.tag}`;

      if (node.id) {
        result += ` id="${node.id}"`;
      }

      if (node.classes.length > 0) {
        result += ` class="${node.classes.join(" ")}"`;
      }

      for (const [key, value] of Object.entries(node.attributes)) {
        result += ` ${key}="${value}"`;
      }

      if (node.selfClosing) {
        result += " />";
      } else {
        result += ">";

        if (node.text) {
          result += node.text;
        }

        if (node.children.length > 0) {
          result += "\n";
          result += renderHTML(node.children, indent + 1);
          result += indentStr;
        }

        result += `</${node.tag}>`;
      }

      result += "\n";
    }
  }

  return result;
}

// ============================================================================
// CSS Abbreviation Expansion
// ============================================================================

interface EmmetCSSRule {
  property: string;
  value: string;
}

/**
 * Parse CSS abbreviation and return CSS rules
 */
function parseCSS(abbr: string): EmmetCSSRule[] {
  const rules: EmmetCSSRule[] = [];

  // Margin: m10, m10-20, m10-20-30-40
  if (abbr.startsWith("m") && /^m\d/.test(abbr)) {
    const values = abbr.slice(1).split("-");
    const rule: EmmetCSSRule = {
      property: "margin",
      value: values.map((v) => `${v}px`).join(" "),
    };
    rules.push(rule);
  }

  // Padding: p10, p10-20
  else if (abbr.startsWith("p") && /^p\d/.test(abbr)) {
    const values = abbr.slice(1).split("-");
    const rule: EmmetCSSRule = {
      property: "padding",
      value: values.map((v) => `${v}px`).join(" "),
    };
    rules.push(rule);
  }

  // Width: w100, w100p (100%)
  else if (abbr.startsWith("w")) {
    const match = abbr.match(/^w(\d+)(p|px|em|rem|%)?$/);
    if (match) {
      const value = match[1];
      const unit = match[2] === "p" ? "%" : match[2] || "px";
      rules.push({ property: "width", value: `${value}${unit}` });
    }
  }

  // Height: h100, h100p
  else if (abbr.startsWith("h")) {
    const match = abbr.match(/^h(\d+)(p|px|em|rem|%)?$/);
    if (match) {
      const value = match[1];
      const unit = match[2] === "p" ? "%" : match[2] || "px";
      rules.push({ property: "height", value: `${value}${unit}` });
    }
  }

  // Font size: fz16, fz1.5rem
  else if (abbr.startsWith("fz")) {
    const match = abbr.match(/^fz([\d.]+)(px|em|rem|pt)?$/);
    if (match) {
      const value = match[1];
      const unit = match[2] || "px";
      rules.push({ property: "font-size", value: `${value}${unit}` });
    }
  }

  // Display: db (block), di (inline), dib (inline-block), df (flex), dg (grid)
  else if (abbr.startsWith("d")) {
    const displayMap: Record<string, string> = {
      db: "block",
      di: "inline",
      dib: "inline-block",
      df: "flex",
      dg: "grid",
      dn: "none",
    };
    if (displayMap[abbr]) {
      rules.push({ property: "display", value: displayMap[abbr] });
    }
  }

  // Position: posa (absolute), posr (relative), posf (fixed), poss (sticky)
  else if (abbr.startsWith("pos")) {
    const posMap: Record<string, string> = {
      posa: "absolute",
      posr: "relative",
      posf: "fixed",
      poss: "sticky",
    };
    if (posMap[abbr]) {
      rules.push({ property: "position", value: posMap[abbr] });
    }
  }

  // Flexbox: jcc (justify-content: center), aic (align-items: center)
  else if (abbr === "jcc") {
    rules.push({ property: "justify-content", value: "center" });
  } else if (abbr === "jcsb") {
    rules.push({ property: "justify-content", value: "space-between" });
  } else if (abbr === "aic") {
    rules.push({ property: "align-items", value: "center" });
  } else if (abbr === "fdc") {
    rules.push({ property: "flex-direction", value: "column" });
  }

  // Color: c#fff, c#ff0000
  else if (abbr.startsWith("c#")) {
    rules.push({ property: "color", value: abbr.slice(1) });
  }

  // Background color: bg#fff
  else if (abbr.startsWith("bg#")) {
    rules.push({ property: "background-color", value: abbr.slice(2) });
  }

  return rules;
}

/**
 * Render CSS rules to string
 */
function renderCSS(rules: EmmetCSSRule[]): string {
  return rules.map((rule) => `${rule.property}: ${rule.value};`).join("\n");
}

// ============================================================================
// Main Expansion Logic
// ============================================================================

/**
 * Detect if current context supports Emmet expansion
 */
function canExpandEmmet(): boolean {
  const bufferId = editor.getActiveBufferId();
  if (bufferId === 0) return false;

  const path = editor.getBufferPath(bufferId);
  if (!path) return true; // Allow in unsaved buffers

  const ext = editor.pathExtname(path).toLowerCase();
  const supportedExts = [
    ".html",
    ".htm",
    ".xml",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".vue",
    ".svelte",
  ];

  return supportedExts.includes(ext);
}

/**
 * Extract the abbreviation before cursor
 */
async function getAbbreviationBeforeCursor(): Promise<string | null> {
  const bufferId = editor.getActiveBufferId();
  if (bufferId === 0) return null;

  const cursorPos = editor.getCursorPosition();
  const lineNum = editor.getCursorLine();

  const lineStart = await editor.getLineStartPosition(lineNum);
  if (lineStart === null) return null;

  // Read text from line start to cursor
  const text = await editor.getBufferText(bufferId, lineStart, cursorPos);

  // Extract abbreviation (word-like characters before cursor)
  const match = text.match(/[\w.#:\-+>*\[\]{}()=\d]+$/);
  return match ? match[0] : null;
}

/**
 * Expand Emmet abbreviation at cursor
 */
async function expandAbbreviation(): Promise<boolean> {
  if (!canExpandEmmet()) {
    return false;
  }

  const abbr = await getAbbreviationBeforeCursor();
  if (!abbr) {
    return false;
  }

  // Determine if it's CSS or HTML context
  const bufferId = editor.getActiveBufferId();
  const path = editor.getBufferPath(bufferId);
  const ext = path ? editor.pathExtname(path).toLowerCase() : "";
  const isCSSContext =
    ext === ".css" || ext === ".scss" || ext === ".sass" || ext === ".less";

  let expanded = "";

  if (isCSSContext) {
    // Try CSS expansion
    const rules = parseCSS(abbr);
    if (rules.length > 0) {
      expanded = renderCSS(rules);
    }
  } else {
    // Try HTML expansion
    const nodes = parseEmmet(abbr);
    if (nodes.length > 0) {
      expanded = renderHTML(nodes).trimEnd();
    }
  }

  if (!expanded) {
    // Try CSS expansion as fallback even in HTML context
    const rules = parseCSS(abbr);
    if (rules.length > 0) {
      expanded = renderCSS(rules);
    }
  }

  if (!expanded) {
    return false;
  }

  // Delete the abbreviation
  const cursorPos = editor.getCursorPosition();
  const startPos = cursorPos - abbr.length;
  editor.deleteRange(bufferId, startPos, cursorPos);

  // Insert expanded text
  editor.insertAtCursor(expanded);

  editor.setStatus(editor.t("status.expanded", { abbr }));
  return true;
}

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Command handler for manual expansion
 */
globalThis.emmet_expand_abbreviation = async function (): Promise<void> {
  const success = await expandAbbreviation();
  if (!success) {
    editor.setStatus(editor.t("status.no_abbreviation"));
  }
};

/**
 * Command handler for Tab key expansion
 */
globalThis.emmet_expand_or_pass = async function (): Promise<void> {
  const success = await expandAbbreviation();
  if (!success) {
    // Fall through to default Tab behavior
    editor.executeAction("insert_tab");
  }
};

/**
 * Command handler for prompt-based expansion
 * Opens a prompt asking for abbreviation, then expands and inserts it
 */
globalThis.emmet_expand_from_prompt = async function (): Promise<void> {
  const abbr = await editor.prompt("Emmet abbreviation:", "");

  if (!abbr) {
    return; // User cancelled
  }

  // Determine context
  const bufferId = editor.getActiveBufferId();
  const path = bufferId ? editor.getBufferPath(bufferId) : "";
  const ext = path ? editor.pathExtname(path).toLowerCase() : "";
  const isCSSContext =
    ext === ".css" || ext === ".scss" || ext === ".sass" || ext === ".less";

  let expanded = "";

  if (isCSSContext) {
    // Try CSS expansion
    const rules = parseCSS(abbr);
    if (rules.length > 0) {
      expanded = renderCSS(rules);
    }
  } else {
    // Try HTML expansion
    const nodes = parseEmmet(abbr);
    if (nodes.length > 0) {
      expanded = renderHTML(nodes).trimEnd();
    }
  }

  if (!expanded) {
    // Try CSS expansion as fallback
    const rules = parseCSS(abbr);
    if (rules.length > 0) {
      expanded = renderCSS(rules);
    }
  }

  if (expanded) {
    editor.insertAtCursor(expanded);
    editor.setStatus(editor.t("status.expanded", { abbr }));
  } else {
    editor.setStatus(editor.t("status.could_not_expand", { abbr }));
  }
};

// Register commands
editor.registerCommand(
  "%cmd.expand_abbreviation",
  "%cmd.expand_abbreviation_desc",
  "emmet_expand_abbreviation",
  null
);

editor.registerCommand(
  "%cmd.expand_from_prompt",
  "%cmd.expand_from_prompt_desc",
  "emmet_expand_from_prompt",
  null
);

// Define HTML mode with Tab key bound to Emmet expansion
// This extends the normal mode and adds Tab -> Emmet
editor.defineMode("html", null, [
  ["Tab", "emmet_expand_or_pass"],
], false); // read_only = false to allow typing

// Define CSS mode with Tab key bound to Emmet expansion
editor.defineMode("css", null, [
  ["Tab", "emmet_expand_or_pass"],
], false);

// Define SCSS mode with Tab key bound to Emmet expansion
editor.defineMode("scss", null, [
  ["Tab", "emmet_expand_or_pass"],
], false);

editor.debug("Emmet plugin loaded with HTML/CSS Tab bindings");
editor.setStatus(editor.t("status.loaded"));
