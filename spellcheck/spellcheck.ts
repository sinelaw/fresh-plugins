/// <reference path="./lib/fresh.d.ts" />
// Spell Check Plugin for Fresh Editor
// Highlights misspelled words and offers corrections via hunspell/aspell
const editor = getEditor();

// ============================================================================
// State
// ============================================================================

let enabled = false;
let enabledBuffers = new Set<number>();
let personalDict = new Set<string>();
let correctCache = new Set<string>();
let misspelledCache = new Set<string>();
let misspelledWords = new Map<number, Array<{ start: number; end: number; word: string }>>();
let spellBackend: "hunspell" | "aspell" | null = null;
let language = "en_US";
let availableLanguages: string[] = [];
let detectionDone = false;
// Tracks edit version per buffer — incremented on every insert/delete.
// checkLine captures the version before spawning hunspell; if it changed
// by the time hunspell returns, the byte offsets are stale and we discard.
let bufferVersions = new Map<number, number>();

const NAMESPACE = "spellcheck";
const PROSE_EXTENSIONS = [".md", ".txt", ".rst", ".tex"];

// ============================================================================
// Personal Dictionary
// ============================================================================

function getDictPath(): string {
  return editor.pathJoin(editor.getConfigDir(), "spell-dictionary.txt");
}

function loadPersonalDict(): void {
  personalDict.clear();
  const dictPath = getDictPath();
  const content = editor.readFile(dictPath);
  if (content) {
    for (const line of content.split("\n")) {
      const word = line.trim();
      if (word && !word.startsWith("#")) {
        personalDict.add(word.toLowerCase());
      }
    }
    editor.debug(`[spellcheck] Loaded ${personalDict.size} words from ${dictPath}`);
  } else {
    editor.debug(`[spellcheck] No personal dictionary at ${dictPath}`);
  }
}

function savePersonalDict(): void {
  const dictPath = getDictPath();
  const words = Array.from(personalDict).sort().join("\n") + "\n";
  editor.writeFile(dictPath, words);
  editor.debug(`[spellcheck] Saved ${personalDict.size} words to ${dictPath}`);
}

// ============================================================================
// Spell Checker Detection
// ============================================================================

async function detectSpellChecker(): Promise<boolean> {
  if (detectionDone) return spellBackend !== null;
  detectionDone = true;

  let foundBinary = false;

  // Try hunspell
  try {
    const result = await editor.spawnProcess("hunspell", ["-v"]);
    if (result.exit_code === 0) {
      foundBinary = true;
      spellBackend = "hunspell";
      editor.debug("[spellcheck] Found hunspell");
      await discoverLanguages();
      if (await verifyDictionary()) return true;
      spellBackend = null;
    }
  } catch (e) {
    editor.error(`[spellcheck] Failed to check hunspell: ${e}`);
  }

  // Try aspell
  try {
    const result = await editor.spawnProcess("aspell", ["--version"]);
    if (result.exit_code === 0) {
      foundBinary = true;
      spellBackend = "aspell";
      editor.debug("[spellcheck] Found aspell");
      await discoverLanguages();
      if (await verifyDictionary()) return true;
      spellBackend = null;
    }
  } catch (e) {
    editor.error(`[spellcheck] Failed to check aspell: ${e}`);
  }

  if (!foundBinary) {
    // Neither hunspell nor aspell installed
    editor.error("[spellcheck] No spell checker found. Install hunspell or aspell.");
    editor.setStatus(editor.t("status.no_spellchecker"));
  }
  // If a binary was found but no dictionary, verifyDictionary already showed the error
  return false;
}

async function verifyDictionary(): Promise<boolean> {
  // Try the configured language first
  const candidates = [language];
  // Add discovered languages as fallbacks
  for (const lang of availableLanguages) {
    if (!candidates.includes(lang)) {
      candidates.push(lang);
    }
  }

  editor.debug(`[spellcheck] Verifying dictionary, candidates: ${candidates.join(", ")}`);
  for (const lang of candidates) {
    const cmd =
      spellBackend === "hunspell"
        ? `hunspell -a -d ${lang}`
        : `aspell pipe -d ${lang}`;
    try {
      editor.debug(`[spellcheck] Testing: ${cmd}`);
      const result = await editor.spawnProcess("sh", [
        "-c",
        `echo test | ${cmd}`,
      ]);
      if (result.exit_code === 0) {
        language = lang;
        editor.debug(`[spellcheck] Verified ${spellBackend} with language: ${lang}`);
        return true;
      }
      editor.debug(`[spellcheck] Dictionary '${lang}' failed (exit ${result.exit_code}): ${result.stderr}`);
    } catch (e) {
      editor.error(`[spellcheck] Failed to verify dictionary '${lang}': ${e}`);
    }
  }

  editor.error(
    `[spellcheck] ${spellBackend} found but no dictionaries available. Install a dictionary package (e.g. hunspell-en_us).`,
  );
  editor.setStatus(
    `Spell check: No dictionaries found. Install a dictionary package (e.g. hunspell-en_us).`,
  );
  return false;
}

async function discoverLanguages(): Promise<void> {
  try {
    if (spellBackend === "hunspell") {
      const result = await editor.spawnProcess("hunspell", ["-D"], ".");
      // hunspell -D writes dictionary paths to stderr
      const output = (result.stderr || "") + "\n" + (result.stdout || "");
      const langs = new Set<string>();
      for (const line of output.split("\n")) {
        // Dictionary paths look like /usr/share/hunspell/en_US.dic
        const match = line.match(
          /\/([a-z]{2}(?:_[A-Z]{2})?)(?:\.dic|\.aff)?\s*$/,
        );
        if (match) {
          langs.add(match[1]);
        }
      }
      availableLanguages = Array.from(langs).sort();
    } else if (spellBackend === "aspell") {
      const result = await editor.spawnProcess("aspell", ["dicts"]);
      if (result.exit_code === 0) {
        availableLanguages = result.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .sort();
      }
    }
    editor.debug(
      `[spellcheck] Available languages: ${availableLanguages.length > 0 ? availableLanguages.join(", ") : "(none)"}`,
    );
  } catch (e) {
    editor.error(`[spellcheck] Failed to discover languages: ${e}`);
  }
}

// ============================================================================
// UTF-8 Byte Length
// ============================================================================

/** Compute the UTF-8 byte length of a JS string via the editor API. */
function utf8ByteLength(str: string): number {
  return editor.utf8ByteLength(str);
}

// ============================================================================
// Word Extraction
// ============================================================================

/**
 * Extract words from text, returning byte offsets (not character offsets).
 * Words only contain ASCII chars so word.length == byte length of word.
 */
function extractWords(text: string): Array<{ word: string; offset: number }> {
  const results: Array<{ word: string; offset: number }> = [];
  const regex = /[a-zA-Z']+/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const word = match[0];
    // Skip short words, all-uppercase (acronyms), and words starting/ending with apostrophe
    if (word.length < 2) continue;
    if (word === word.toUpperCase()) continue;
    if (word.startsWith("'") || word.endsWith("'")) continue;
    // Convert character offset to byte offset (handles multi-byte chars like emojis)
    const byteOffset = utf8ByteLength(text.substring(0, match.index));
    results.push({ word, offset: byteOffset });
  }
  return results;
}

function isKnownCorrect(word: string): boolean {
  const lower = word.toLowerCase();
  return personalDict.has(lower) || correctCache.has(lower);
}

function isKnownMisspelled(word: string): boolean {
  return misspelledCache.has(word.toLowerCase());
}

// ============================================================================
// Hunspell/Aspell Integration
// ============================================================================

function buildSpellCmd(): string {
  if (spellBackend === "hunspell") {
    return `hunspell -a -d ${language}`;
  }
  return `aspell pipe -d ${language}`;
}

async function checkWords(
  words: string[],
): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();
  if (words.length === 0 || !spellBackend) return results;

  // Deduplicate
  const unique = Array.from(new Set(words));
  const input = unique.join("\n");

  // Use heredoc to safely pass words to the spell checker
  const spellCmd = buildSpellCmd();
  const cmd = `${spellCmd} <<'SPELLEOF'\n${input}\nSPELLEOF`;

  try {
    editor.debug(`[spellcheck] Running: ${spellCmd} with ${unique.length} words`);
    const result = await editor.spawnProcess("sh", ["-c", cmd]);
    if (result.exit_code !== 0) {
      editor.error(`[spellcheck] Spell check failed (exit ${result.exit_code}): ${result.stderr}`);
      return results;
    }

    editor.debug(`[spellcheck] Output: ${result.stdout.length} bytes`);
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("& ")) {
        // & word count offset: sug1, sug2, ...
        const match = line.match(/^& (\S+) \d+ \d+: (.+)$/);
        if (match) {
          results.set(match[1], match[2].split(", "));
        }
      } else if (line.startsWith("# ")) {
        // # word offset — misspelled, no suggestions
        const match = line.match(/^# (\S+)/);
        if (match) {
          results.set(match[1], []);
        }
      }
      // * + - = correct, ignore
    }

    // Cache results — both correct and misspelled
    for (const word of unique) {
      if (results.has(word)) {
        misspelledCache.add(word.toLowerCase());
      } else {
        correctCache.add(word.toLowerCase());
      }
    }
  } catch (e) {
    editor.error(`[spellcheck] Error running spell check: ${e}`);
  }

  return results;
}

// ============================================================================
// Highlighting
// ============================================================================

function addMisspelledOverlay(
  bufferId: number,
  start: number,
  end: number,
  word: string,
): void {
  editor.addOverlay(bufferId, NAMESPACE, start, end, {
    fg: [255, 100, 100],
  });
  let bufferErrors = misspelledWords.get(bufferId);
  if (!bufferErrors) {
    bufferErrors = [];
    misspelledWords.set(bufferId, bufferErrors);
  }
  bufferErrors.push({ start, end, word });
}

function checkLine(
  bufferId: number,
  byteStart: number,
  content: string,
): void {
  const words = extractWords(content);

  // Apply cached misspellings synchronously (no hunspell needed)
  // and collect unknown words for async check
  const toCheck: Array<{ word: string; offset: number }> = [];
  for (const w of words) {
    if (isKnownCorrect(w.word)) continue;
    if (isKnownMisspelled(w.word)) {
      addMisspelledOverlay(bufferId, byteStart + w.offset, byteStart + w.offset + w.word.length, w.word);
      continue;
    }
    toCheck.push(w);
  }

  if (toCheck.length === 0) return;

  // Capture the edit version before the async check. If the buffer is
  // edited while hunspell runs, the byte offsets become stale.
  const versionAtStart = bufferVersions.get(bufferId) || 0;

  editor.debug(`[spellcheck] Checking ${toCheck.length} new words from line at byte ${byteStart} (v${versionAtStart})`);
  checkWords(toCheck.map((w) => w.word)).then((misspelled) => {
    if (!enabled) return;

    // Buffer was edited since we started — byte offsets are stale, discard
    if ((bufferVersions.get(bufferId) || 0) !== versionAtStart) {
      editor.debug(`[spellcheck] Discarding stale results for buffer ${bufferId}`);
      return;
    }

    let added = 0;
    for (const entry of toCheck) {
      if (misspelled.has(entry.word)) {
        addMisspelledOverlay(bufferId, byteStart + entry.offset, byteStart + entry.offset + entry.word.length, entry.word);
        added++;
      }
    }

    // Overlays were added after render — trigger a re-render.
    // Safe because all words are now cached, so the next lines_changed
    // pass won't spawn any async work.
    if (added > 0) {
      editor.refreshLines(bufferId);
    }
  });
}

async function checkVisibleLines(bufferId: number): Promise<number> {
  const viewport = editor.getViewport();
  if (!viewport) {
    editor.debug("[spellcheck] checkVisibleLines: no viewport");
    return 0;
  }

  const length = editor.getBufferLength(bufferId);
  if (length === 0) return 0;

  // Read from viewport top to an estimated bottom (viewport height in lines * ~120 bytes avg)
  const start = viewport.topByte;
  const estimatedEnd = Math.min(length, start + viewport.height * 120);
  editor.debug(`[spellcheck] Checking visible range ${start}-${estimatedEnd} of buffer ${bufferId}`);

  const text = await editor.getBufferText(bufferId, start, estimatedEnd);
  const lines = text.split("\n");

  let byteOffset = start;
  const allWords: Array<{ word: string; offset: number; lineByteStart: number }> = [];

  for (const line of lines) {
    const words = extractWords(line);
    for (const w of words) {
      if (!isKnownCorrect(w.word)) {
        allWords.push({ word: w.word, offset: w.offset, lineByteStart: byteOffset });
      }
    }
    byteOffset += utf8ByteLength(line) + 1; // +1 for newline byte
  }

  if (allWords.length === 0) return 0;

  const misspelled = await checkWords(allWords.map((w) => w.word));
  if (!enabled) return 0;

  let bufferErrors = misspelledWords.get(bufferId);
  if (!bufferErrors) {
    bufferErrors = [];
    misspelledWords.set(bufferId, bufferErrors);
  }

  let count = 0;
  for (const entry of allWords) {
    if (misspelled.has(entry.word)) {
      const s = entry.lineByteStart + entry.offset;
      const e = s + entry.word.length;
      editor.addOverlay(bufferId, NAMESPACE, s, e, {
        fg: [255, 100, 100],
      });
      bufferErrors.push({ start: s, end: e, word: entry.word });
      count++;
    }
  }

  editor.debug(`[spellcheck] Visible check found ${count} error(s)`);
  if (count > 0) {
    editor.refreshLines(bufferId);
  }
  return count;
}

async function checkBuffer(bufferId: number): Promise<number> {
  const length = editor.getBufferLength(bufferId);
  editor.debug(`[spellcheck] Checking entire buffer ${bufferId} (${length} bytes)`);
  if (length === 0) return 0;

  // Clear existing overlays and errors
  editor.clearNamespace(bufferId, NAMESPACE);
  misspelledWords.set(bufferId, []);

  // Read entire buffer
  const text = await editor.getBufferText(bufferId, 0, length);
  const lines = text.split("\n");

  let byteOffset = 0;
  const allWords: Array<{ word: string; offset: number; lineByteStart: number }> = [];

  for (const line of lines) {
    const words = extractWords(line);
    for (const w of words) {
      if (!isKnownCorrect(w.word)) {
        allWords.push({ word: w.word, offset: w.offset, lineByteStart: byteOffset });
      }
    }
    byteOffset += utf8ByteLength(line) + 1; // +1 for newline byte
  }

  editor.debug(`[spellcheck] Buffer has ${allWords.length} words to check`);
  if (allWords.length === 0) return 0;

  const misspelled = await checkWords(allWords.map((w) => w.word));
  if (!enabled) return 0;

  const bufferErrors: Array<{ start: number; end: number; word: string }> = [];

  for (const entry of allWords) {
    if (misspelled.has(entry.word)) {
      const start = entry.lineByteStart + entry.offset;
      const end = start + entry.word.length;
      editor.addOverlay(bufferId, NAMESPACE, start, end, {
        fg: [255, 100, 100],
      });
      bufferErrors.push({ start, end, word: entry.word });
    }
  }

  misspelledWords.set(bufferId, bufferErrors);
  return bufferErrors.length;
}

// ============================================================================
// Word at Cursor
// ============================================================================

async function getWordAtCursor(): Promise<{
  word: string;
  start: number;
  end: number;
} | null> {
  const bufferId = editor.getActiveBufferId();
  if (!bufferId) {
    editor.debug("[spellcheck] getWordAtCursor: no active buffer");
    return null;
  }

  const cursorPos = editor.getCursorPosition();
  const bufLen = editor.getBufferLength(bufferId);

  // Read a small window around cursor — enough to capture any word
  const readStart = Math.max(0, cursorPos - 100);
  const readEnd = Math.min(bufLen, cursorPos + 100);
  const text = await editor.getBufferText(bufferId, readStart, readEnd);
  const cursorInText = cursorPos - readStart;

  editor.debug(`[spellcheck] getWordAtCursor: cursor=${cursorPos}, readStart=${readStart}, cursorInText=${cursorInText}, textLen=${text.length}`);

  const regex = /[a-zA-Z']+/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    // Convert character offset to byte offset (cursor position is in bytes)
    const wordByteStart = utf8ByteLength(text.substring(0, match.index));
    const wordByteEnd = wordByteStart + match[0].length; // ASCII word, byte len == char len
    if (cursorInText >= wordByteStart && cursorInText <= wordByteEnd) {
      editor.debug(`[spellcheck] getWordAtCursor: found "${match[0]}" at byte ${readStart + wordByteStart}`);
      return {
        word: match[0],
        start: readStart + wordByteStart,
        end: readStart + wordByteEnd,
      };
    }
  }

  editor.debug(`[spellcheck] getWordAtCursor: no word found at cursor offset ${cursorInText} in "${text.substring(Math.max(0, cursorInText - 20), cursorInText + 20)}"`);
  return null;
}

// ============================================================================
// Auto-Enable for Prose Files
// ============================================================================

function isProseFile(path: string): boolean {
  if (!path) return false;
  const ext = editor.pathExtname(path).toLowerCase();
  return PROSE_EXTENSIONS.includes(ext);
}

function isSpellCheckBuffer(bufferId: number): boolean {
  if (enabledBuffers.has(bufferId)) return true;
  // Accept any non-virtual buffer with a real file path
  const info = editor.getBufferInfo(bufferId);
  return info !== null && !info.is_virtual;
}

async function autoEnableForBuffer(explicitBufferId?: number): Promise<void> {
  const bufferId = explicitBufferId || editor.getActiveBufferId();
  if (!bufferId) return;

  const path = editor.getBufferPath(bufferId);
  if (!isProseFile(path)) return;

  if (!enabled) {
    editor.debug(`[spellcheck] Auto-enabling for prose file: ${path}`);
    await enableSpellCheck();
  } else if (!enabledBuffers.has(bufferId)) {
    // Already enabled globally, just add this new prose buffer
    await enableSpellCheckForBuffer(bufferId);
  }
}

// ============================================================================
// Enable / Disable
// ============================================================================

async function enableSpellCheckForBuffer(bufferId: number): Promise<void> {
  if (enabledBuffers.has(bufferId)) return;
  enabledBuffers.add(bufferId);
  editor.debug(`[spellcheck] Enabled for buffer ${bufferId}`);
  await checkVisibleLines(bufferId);
}

async function enableSpellCheck(): Promise<boolean> {
  if (!(await detectSpellChecker())) {
    // detectSpellChecker already showed the appropriate error
    return false;
  }

  enabled = true;
  editor.setContext("spellcheck", true);

  const bufferId = editor.getActiveBufferId();
  editor.debug(`[spellcheck] Enabled with backend=${spellBackend}, language=${language}, activeBuffer=${bufferId}`);

  if (bufferId) {
    await enableSpellCheckForBuffer(bufferId);
  }

  editor.setStatus(editor.t("status.enabled"));
  return true;
}

function disableSpellCheck(): void {
  enabled = false;
  editor.setContext("spellcheck", false);

  // Clear all overlays from all enabled buffers
  for (const bufferId of enabledBuffers) {
    editor.clearNamespace(bufferId, NAMESPACE);
  }
  enabledBuffers.clear();
  misspelledWords.clear();

  editor.setStatus(editor.t("status.disabled"));
}

// ============================================================================
// Event Handlers
// ============================================================================

globalThis.spellcheck_on_lines_changed = function (data: {
  buffer_id: number;
  lines: Array<{
    line_number: number;
    byte_start: number;
    byte_end: number;
    content: string;
  }>;
}): void {
  if (!enabled || !isSpellCheckBuffer(data.buffer_id)) return;

  // First time seeing this buffer — do a full viewport scan instead of
  // per-line checks.  This handles the case where getActiveBufferId()
  // returned 0 at enable time (e.g. during toggle command).
  if (!enabledBuffers.has(data.buffer_id)) {
    enableSpellCheckForBuffer(data.buffer_id);
    return;
  }

  for (const line of data.lines) {
    checkLine(data.buffer_id, line.byte_start, line.content);
  }
};

globalThis.spellcheck_on_after_insert = function (data: {
  buffer_id: number;
  position: number;
  text: string;
  affected_start: number;
  affected_end: number;
}): void {
  // Bump version so in-flight async checks know their offsets are stale
  bufferVersions.set(data.buffer_id, (bufferVersions.get(data.buffer_id) || 0) + 1);

  if (!enabled || !isSpellCheckBuffer(data.buffer_id)) return;
  editor.clearOverlaysInRange(data.buffer_id, data.affected_start, data.affected_end);

  // Remove stale entries from misspelledWords for this buffer
  const errors = misspelledWords.get(data.buffer_id);
  if (errors) {
    misspelledWords.set(
      data.buffer_id,
      errors.filter((e) => e.end <= data.affected_start || e.start >= data.affected_end),
    );
  }
};

globalThis.spellcheck_on_after_delete = function (data: {
  buffer_id: number;
  start: number;
  end: number;
  deleted_text: string;
  affected_start: number;
  deleted_len: number;
}): void {
  // Bump version so in-flight async checks know their offsets are stale
  bufferVersions.set(data.buffer_id, (bufferVersions.get(data.buffer_id) || 0) + 1);

  if (!enabled || !isSpellCheckBuffer(data.buffer_id)) return;
  const clearStart = data.affected_start > 0 ? data.affected_start - 1 : 0;
  const clearEnd = data.affected_start + 1;
  editor.clearOverlaysInRange(data.buffer_id, clearStart, clearEnd);

  // Remove stale entries
  const errors = misspelledWords.get(data.buffer_id);
  if (errors) {
    misspelledWords.set(
      data.buffer_id,
      errors.filter((e) => e.end <= data.start || e.start >= data.end),
    );
  }
};

globalThis.spellcheck_on_buffer_activated = async function (data: {
  buffer_id: number;
}): Promise<void> {
  await autoEnableForBuffer(data.buffer_id);
  // If already enabled, scan visible lines for this buffer
  if (enabled && data.buffer_id && isSpellCheckBuffer(data.buffer_id)) {
    await checkVisibleLines(data.buffer_id);
  }
};

globalThis.spellcheck_on_after_file_open = function (data: {
  buffer_id: number;
  path: string;
}): void {
  autoEnableForBuffer(data.buffer_id);
};

globalThis.spellcheck_on_buffer_closed = function (data: {
  buffer_id: number;
}): void {
  enabledBuffers.delete(data.buffer_id);
  misspelledWords.delete(data.buffer_id);
  bufferVersions.delete(data.buffer_id);
};

// Register event listeners
editor.on("lines_changed", "spellcheck_on_lines_changed");
editor.on("after_insert", "spellcheck_on_after_insert");
editor.on("after_delete", "spellcheck_on_after_delete");
editor.on("buffer_activated", "spellcheck_on_buffer_activated");
editor.on("after_file_open", "spellcheck_on_after_file_open");
editor.on("buffer_closed", "spellcheck_on_buffer_closed");

// ============================================================================
// Commands
// ============================================================================

globalThis.spellcheck_toggle = async function (): Promise<void> {
  if (enabled) {
    disableSpellCheck();
  } else {
    await enableSpellCheck();
  }
};

globalThis.spellcheck_correct_word = async function (): Promise<void> {
  const wordInfo = await getWordAtCursor();
  if (!wordInfo) {
    editor.setStatus(editor.t("status.no_word"));
    return;
  }

  // Check the word
  const misspelled = await checkWords([wordInfo.word]);
  if (!misspelled.has(wordInfo.word)) {
    editor.setStatus(editor.t("status.word_correct", { word: wordInfo.word }));
    return;
  }

  const suggestions = misspelled.get(wordInfo.word) || [];
  if (suggestions.length === 0) {
    editor.setStatus(editor.t("status.no_suggestions", { word: wordInfo.word }));
    return;
  }

  // Open prompt with suggestions
  const promptLabel = editor.t("prompt.replace", { word: wordInfo.word });
  const promptPromise = editor.prompt(promptLabel, "");
  editor.setPromptSuggestions(
    suggestions.map((s) => ({ text: s })),
  );
  const replacement = await promptPromise;

  if (replacement === null || replacement === "") return;

  // Replace the word
  const bufferId = editor.getActiveBufferId();
  if (!bufferId) return;

  editor.deleteRange(bufferId, wordInfo.start, wordInfo.end);
  editor.insertText(bufferId, wordInfo.start, replacement);
  editor.setStatus(
    editor.t("status.replaced", { old: wordInfo.word, new: replacement }),
  );
};

globalThis.spellcheck_next_error = function (): void {
  const bufferId = editor.getActiveBufferId();
  if (!bufferId) return;

  const errors = misspelledWords.get(bufferId);
  if (!errors || errors.length === 0) {
    editor.setStatus(editor.t("status.no_more_errors"));
    return;
  }

  const cursorPos = editor.getCursorPosition();

  // Sort by position for navigation
  const sorted = errors.slice().sort((a, b) => a.start - b.start);

  // Find next error after cursor
  let next = sorted.find((e) => e.start > cursorPos);
  if (!next) {
    // Wrap around to first error
    next = sorted[0];
  }

  editor.setBufferCursor(bufferId, next.start);
  editor.setStatus(`"${next.word}"`);
};

globalThis.spellcheck_add_to_dict = async function (): Promise<void> {
  const wordInfo = await getWordAtCursor();
  if (!wordInfo) {
    editor.setStatus(editor.t("status.no_word"));
    return;
  }

  const lower = wordInfo.word.toLowerCase();
  personalDict.add(lower);
  correctCache.add(lower);
  savePersonalDict();

  // Clear overlay for this word across the current buffer
  const bufferId = editor.getActiveBufferId();
  if (bufferId) {
    editor.clearNamespace(bufferId, NAMESPACE);
    // Remove from misspelled list
    const errors = misspelledWords.get(bufferId);
    if (errors) {
      misspelledWords.set(
        bufferId,
        errors.filter((e) => e.word.toLowerCase() !== lower),
      );
    }
    // Refresh to re-highlight remaining errors (the added word won't be flagged)
    editor.refreshLines(bufferId);
  }

  editor.setStatus(editor.t("status.word_added", { word: wordInfo.word }));
};

globalThis.spellcheck_check_buffer = async function (): Promise<void> {
  const bufferId = editor.getActiveBufferId();
  if (!bufferId) return;

  editor.setStatus(editor.t("status.checking"));
  const count = await checkBuffer(bufferId);

  if (count === 0) {
    editor.setStatus(editor.t("status.no_errors"));
  } else {
    editor.setStatus(editor.t("status.errors_found", { count: String(count) }));
  }
};

globalThis.spellcheck_language = async function (): Promise<void> {
  if (availableLanguages.length === 0) {
    editor.setStatus(editor.t("status.no_dictionaries"));
    return;
  }

  const promptLabel = editor.t("prompt.language");
  const promptPromise = editor.prompt(promptLabel, language);
  editor.setPromptSuggestions(
    availableLanguages.map((lang) => ({
      text: lang,
      description: lang === language ? "(current)" : undefined,
    })),
  );
  const selected = await promptPromise;

  if (selected === null || selected === "") return;

  language = selected;
  correctCache.clear();
  misspelledCache.clear();

  // Re-check current buffer
  const bufferId = editor.getActiveBufferId();
  if (bufferId && enabled) {
    editor.clearNamespace(bufferId, NAMESPACE);
    misspelledWords.set(bufferId, []);
    editor.refreshLines(bufferId);
  }

  editor.setStatus(editor.t("status.language_changed", { lang: language }));
};

// ============================================================================
// Command Registration
// ============================================================================

// Toggle is always available
editor.registerCommand(
  "%cmd.toggle",
  "%cmd.toggle_desc",
  "spellcheck_toggle",
);

// Contextual commands — only visible when spell check is active
editor.registerCommand(
  "%cmd.correct_word",
  "%cmd.correct_word_desc",
  "spellcheck_correct_word",
  "spellcheck",
);

editor.registerCommand(
  "%cmd.next_error",
  "%cmd.next_error_desc",
  "spellcheck_next_error",
  "spellcheck",
);

editor.registerCommand(
  "%cmd.add_to_dict",
  "%cmd.add_to_dict_desc",
  "spellcheck_add_to_dict",
  "spellcheck",
);

editor.registerCommand(
  "%cmd.check_buffer",
  "%cmd.check_buffer_desc",
  "spellcheck_check_buffer",
  "spellcheck",
);

editor.registerCommand(
  "%cmd.language",
  "%cmd.language_desc",
  "spellcheck_language",
  "spellcheck",
);

// ============================================================================
// Initialization
// ============================================================================

loadPersonalDict();
editor.debug(
  `[spellcheck] Plugin loaded, personal dictionary: ${personalDict.size} words`,
);

// Auto-enable for current buffer on load
autoEnableForBuffer();
