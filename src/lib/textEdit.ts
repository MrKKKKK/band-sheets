/**
 * Editor B helpers (docs/m3-plan.md, decision 2): edit the raw ChordPro
 * text in place, never reformatting the rest, and return the new caret.
 */
export interface TextEdit {
  text: string;
  caret: number;
  /**
   * Set when this edit is a pure insertion (nothing deleted elsewhere): the
   * index in the *original* text where `text` gained new content. Lets a
   * caller replay the edit as a single native insertion (R10 — e.g. via
   * `document.execCommand('insertText')`, to join the browser's undo stack)
   * instead of diffing old vs. new text, which is ambiguous whenever the
   * inserted content shares a character with what follows it (e.g. `[G]`
   * inserted right before an existing `[F]`). Omitted when the edit also
   * deletes something (e.g. `insertAt`'s default 'replace' mode with a real
   * selection).
   */
  insertedAt?: number;
}

const clamp = (n: number, text: string) =>
  Math.max(0, Math.min(n, text.length));

export type InsertAtOptions = {
  /**
   * 'replace' (default) deletes the selection and puts `s` in its place.
   * 'insert' leaves the selection untouched and puts `s` right before it
   * (at the selection start) — used for the palette chips (R10) so a chip
   * click never discards selected text.
   */
  mode?: 'replace' | 'insert';
};

/**
 * Inserts `s` at the selection start. In the default 'replace' mode the
 * selection is deleted first (caret goes right after `s`); in 'insert' mode
 * the selection is kept, shifted after `s` (caret still goes right after `s`,
 * i.e. before the kept selection).
 */
export function insertAt(
  text: string,
  selStart: number,
  selEnd: number,
  s: string,
  { mode = 'replace' }: InsertAtOptions = {},
): TextEdit {
  const a = clamp(Math.min(selStart, selEnd), text);
  const b = clamp(Math.max(selStart, selEnd), text);
  const tail = mode === 'insert' ? a : b;
  return {
    text: text.slice(0, a) + s + text.slice(tail),
    caret: a + s.length,
    // A pure insertion whenever nothing is actually deleted: 'insert' mode
    // never deletes, and 'replace' mode only deletes when there was a real
    // (non-collapsed) selection.
    insertedAt: mode === 'insert' || a === b ? a : undefined,
  };
}

const DIRECTIVE_LINE = /^\s*\{\s*([A-Za-z][\w-]*)\s*(?::(.*?))?\s*\}\s*$/;

/** Short-form section directives (ChordPro): sov/soc/sob, eov/eoc/eob. */
const SHORT_START: Record<string, string> = {
  sov: 'verse',
  soc: 'chorus',
  sob: 'bridge',
};
const SHORT_END: Record<string, string> = {
  eov: 'verse',
  eoc: 'chorus',
  eob: 'bridge',
};

/** Kind of a `{start_of_x}` / short-form start directive ('part' included). */
function startKind(name: string): string | undefined {
  if (name.startsWith('start_of_') && name.length > 9) return name.slice(9);
  return SHORT_START[name];
}

function endKind(name: string): string | undefined {
  if (name.startsWith('end_of_') && name.length > 7) return name.slice(7);
  return SHORT_END[name];
}

/**
 * Line index (0-based, among `lines`) of the end directive of the innermost
 * `{start_of_x}`…`{end_of_x}` (or `{start_of_part}`…`{end_of_part}`, or the
 * sov/soc/sob short forms) block whose range contains `caretLine`, or
 * `undefined` when the caret isn't inside any such block. A block left open
 * at end of text is treated as closing on the last line.
 */
function enclosingBlockEndLine(
  lines: string[],
  caretLine: number,
): number | undefined {
  const stack: { kind: string; startLine: number }[] = [];
  const blocks: { startLine: number; endLine: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE_LINE.exec(lines[i]);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const sk = startKind(name);
    if (sk !== undefined) {
      stack.push({ kind: sk, startLine: i });
      continue;
    }
    const ek = endKind(name);
    if (ek === undefined) continue;
    for (let j = stack.length - 1; j >= 0; j--) {
      if (stack[j].kind === ek) {
        blocks.push({ startLine: stack[j].startLine, endLine: i });
        stack.splice(j, 1);
        break;
      }
    }
  }
  // Blocks never closed before EOF: treat as closing on the last line.
  for (const b of stack) {
    blocks.push({ startLine: b.startLine, endLine: lines.length - 1 });
  }

  // At or after the start line — being ON the start directive's own line,
  // at ANY position in it (including position 0, i.e. the very first
  // character), still counts as "inside" (N3: it used to take `>`, which
  // treated the whole start line as "outside" and let a new block be
  // inserted right after it, splitting the block open — e.g. leaving its
  // label-only body empty and its end directive dangling past the new
  // block) — and at/before the end line (being on the end directive's own
  // line still counts as "inside" too, so it isn't split either).
  let best: number | undefined;
  let bestStart = -1;
  for (const b of blocks) {
    if (
      caretLine >= b.startLine &&
      caretLine <= b.endLine &&
      b.startLine > bestStart
    ) {
      best = b.endLine;
      bestStart = b.startLine;
    }
  }
  return best;
}

/**
 * Inserts an empty `{start_of_verse: <label>}` block on its own line; the
 * caret goes to the empty line inside the block. Normally this lands at the
 * first line boundary at/after the caret, but when the caret sits inside an
 * existing section/part block (verse/chorus/bridge, including the sov/soc/
 * sob short forms, or a `{start_of_part}`…`{end_of_part}`) — which includes
 * being anywhere on that block's own start-directive line (N3) — it lands
 * right after that block's end directive instead, so the new block never
 * splits it.
 */
export function insertSection(
  text: string,
  caret: number,
  label: string,
): TextEdit {
  const clampedCaret = clamp(caret, text);
  const lines = text.split('\n');
  const caretLine = text.slice(0, clampedCaret).split('\n').length - 1;
  const enclosingEndLine = enclosingBlockEndLine(lines, caretLine);

  let pos: number;
  let prefix = '';
  if (enclosingEndLine !== undefined) {
    if (enclosingEndLine === lines.length - 1) {
      // The block's end directive is the last line and has no trailing
      // newline in `text`; append one before the new block.
      pos = text.length;
      prefix = '\n';
    } else {
      let offset = 0;
      for (let i = 0; i <= enclosingEndLine; i++) offset += lines[i].length + 1;
      pos = offset;
    }
  } else {
    pos = clampedCaret;
    if (pos > 0 && text[pos - 1] !== '\n') {
      const nl = text.indexOf('\n', pos);
      if (nl >= 0) pos = nl + 1;
      else {
        pos = text.length;
        prefix = '\n';
      }
    }
  }

  const start =
    label === '' ? '{start_of_verse}\n' : `{start_of_verse: ${label}}\n`;
  const block = `${prefix}${start}\n{end_of_verse}\n`;
  return {
    text: text.slice(0, pos) + block + text.slice(pos),
    caret: pos + prefix.length + start.length,
    insertedAt: pos, // always a pure insertion — never deletes anything
  };
}
