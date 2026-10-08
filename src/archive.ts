// Pure logic: no `obsidian` import, so tests/ can run it under plain Node.

/** A range edit on the original text, in character offsets. */
export interface Change {
  from: number;
  to: number;
  insert: string;
}

export interface ArchiveOptions {
  /** Checkbox characters that mean finished. */
  doneMarkers: string;
  /** Text of the archive heading, without the hashes. */
  heading: string;
  /** Level of the archive heading, 1 to 6. */
  level: number;
  /** Heading text of today's group inside the archive section. Empty: no grouping. */
  dateHeading: string;
  /** Also archive finished tasks that sit under an unfinished one. */
  includeNested: boolean;
}

/** One task and everything nested under it. */
export interface Block {
  /** Index of the first line. */
  start: number;
  /** Index after the last line. */
  end: number;
  /** The lines, as written. */
  lines: string[];
}

export interface Line {
  text: string;
  /** Offset of the first character in the note. */
  offset: number;
}

const TASK = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\[(.)\](?:[ \t]|$)/u;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/u;
const FENCE = /^[ \t]*(`{3,}|~{3,})/u;

/** Splits a note into lines, remembering where each starts. A trailing newline does not make an extra line. */
export function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let offset = 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  for (const p of parts) {
    out.push({ text: p, offset });
    offset += p.length + 1;
  }
  return out;
}

/** Width of the leading whitespace, a tab counting as four columns. */
export function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

/** Which lines are code, front matter or comments, where a `- [x]` is not a task. */
export function skippedLines(lines: Line[]): boolean[] {
  const skip = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  if (lines[0]?.text.trim() === '---') {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].text.trim() === '---' || lines[j].text.trim() === '...') {
        for (let k = 0; k <= j; k++) skip[k] = true;
        i = j + 1;
        break;
      }
    }
  }
  let fence = '';
  for (; i < lines.length; i++) {
    const m = FENCE.exec(lines[i].text);
    if (fence) {
      skip[i] = true;
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && lines[i].text.trim() === m[1]) fence = '';
    } else if (m) {
      skip[i] = true;
      fence = m[1];
    }
  }
  return skip;
}

export function isDone(text: string, doneMarkers: string): boolean {
  const m = TASK.exec(text);
  return !!m && doneMarkers.includes(m[2]);
}

/** Last line of the task at `i` plus what is nested under it. Blank lines end it. */
function blockEnd(lines: Line[], skip: boolean[], i: number): number {
  const base = indentOf(lines[i].text);
  let end = i + 1;
  while (end < lines.length && !skip[end] && lines[end].text.trim() !== '' && indentOf(lines[end].text) > base) end++;
  return end;
}

/** The archive section: its heading line and the line after its last line. */
export function findSection(lines: Line[], skip: boolean[], heading: string, level: number): { head: number; end: number } | null {
  for (let i = 0; i < lines.length; i++) {
    if (skip[i]) continue;
    const m = HEADING.exec(lines[i].text);
    if (!m || m[1].length !== level || m[2] !== heading) continue;
    let end = i + 1;
    while (end < lines.length) {
      const h = skip[end] ? null : HEADING.exec(lines[end].text);
      if (h && h[1].length <= level) break;
      end++;
    }
    return { head: i, end };
  }
  return null;
}

/**
 * The finished tasks between lines `from` and `to` (half open), each with its nested lines.
 * Anything inside the archive section stays where it is.
 */
export function findCompleted(lines: Line[], opts: ArchiveOptions, from = 0, to = lines.length): Block[] {
  const skip = skippedLines(lines);
  const section = findSection(lines, skip, opts.heading, opts.level);
  const blocks: Block[] = [];
  let i = from;
  while (i < to) {
    if (section && i >= section.head && i < section.end) {
      i = section.end;
      continue;
    }
    if (skip[i] || !TASK.test(lines[i].text)) {
      i++;
      continue;
    }
    const done = isDone(lines[i].text, opts.doneMarkers);
    if (done) {
      const end = Math.min(blockEnd(lines, skip, i), section && i < section.head ? section.head : lines.length);
      blocks.push({ start: i, end, lines: lines.slice(i, end).map((l) => l.text) });
      i = end;
    } else if (opts.includeNested) {
      i++;
    } else {
      i = blockEnd(lines, skip, i);
    }
  }
  return blocks;
}

/** The task at line `i`, or the closest one above it that contains it, with its nested lines. */
export function taskAround(lines: Line[], i: number): Block | null {
  const skip = skippedLines(lines);
  if (i < 0 || i >= lines.length || skip[i]) return null;
  let at = -1;
  if (TASK.test(lines[i].text)) at = i;
  else {
    // Walk up through ever shallower lines until one is a task that holds this line.
    let limit = indentOf(lines[i].text);
    for (let j = i - 1; j >= 0 && !skip[j] && lines[j].text.trim() !== '' && limit > 0; j--) {
      const w = indentOf(lines[j].text);
      if (w >= limit) continue;
      if (TASK.test(lines[j].text)) {
        at = j;
        break;
      }
      limit = w;
    }
  }
  if (at < 0) return null;
  const end = blockEnd(lines, skip, at);
  if (end <= i) return null;
  return { start: at, end, lines: lines.slice(at, end).map((l) => l.text) };
}

/** Removes the leading indent of the shallowest line from every line, so a nested task lands at the top level. */
export function dedent(block: string[]): string[] {
  const base = indentOf(block[0]);
  return block.map((l) => {
    let cut = 0;
    let width = 0;
    while (cut < l.length && width < base && (l[cut] === ' ' || l[cut] === '\t')) {
      width += l[cut] === '\t' ? 4 : 1;
      cut++;
    }
    return l.slice(cut);
  });
}

/** The text that goes under the archive heading for these blocks. */
function blocksText(blocks: string[][]): string {
  return blocks.map((b) => dedent(b).join('\n')).join('\n');
}

/**
 * The edit that puts `blocks` into the archive section of `text`, creating the heading
 * (and the date group) when missing. Returns null when there is nothing to add.
 */
export function planInsertion(text: string, blocks: string[][], opts: ArchiveOptions): Change | null {
  if (blocks.length === 0) return null;
  const lines = splitLines(text);
  const skip = skippedLines(lines);
  const section = findSection(lines, skip, opts.heading, opts.level);
  const body = blocksText(blocks);
  const head = `${'#'.repeat(opts.level)} ${opts.heading}`;
  const dateHead = opts.dateHeading ? `${'#'.repeat(Math.min(opts.level + 1, 6))} ${opts.dateHeading}` : '';
  const sep = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';

  if (!section) {
    const insert = `${sep}${head}\n\n${dateHead ? `${dateHead}\n\n` : ''}${body}\n`;
    return { from: text.length, to: text.length, insert };
  }

  // Last non-blank line of the section, so the new text lands before the blank lines that precede the next heading.
  let last = section.end - 1;
  while (last > section.head && lines[last].text.trim() === '') last--;

  if (dateHead) {
    let group = -1;
    let groupEnd = section.end;
    for (let i = section.head + 1; i < section.end; i++) {
      if (!skip[i] && lines[i].text.trim() === dateHead) group = i;
      else if (group >= 0 && !skip[i] && HEADING.test(lines[i].text)) {
        groupEnd = i;
        break;
      }
    }
    if (group >= 0) {
      let end = groupEnd - 1;
      while (end > group && lines[end].text.trim() === '') end--;
      return afterLine(lines, end, body);
    }
    return afterLine(lines, last, `\n${dateHead}\n\n${body}`);
  }
  return afterLine(lines, last, body);
}

/** Inserts `add` on new lines after line `i`. */
function afterLine(lines: Line[], i: number, add: string): Change {
  const at = lines[i].offset + lines[i].text.length;
  return { from: at, to: at, insert: `\n${add}` };
}

/** The edits that cut these blocks out of the note. */
export function planRemoval(text: string, blocks: Block[], lines: Line[] = splitLines(text)): Change[] {
  return blocks.map((b) => {
    const from = lines[b.start].offset;
    const last = lines[b.end - 1];
    let to = last.offset + last.text.length;
    if (text[to] === '\n') to++;
    // The last line of the note has no newline after it: take the one before it instead.
    if (to === text.length && from > 0 && text[to - 1] !== '\n') return { from: from - 1, to, insert: '' };
    return { from, to, insert: '' };
  });
}

/** Applies range edits written against `text`. */
export function applyChanges(text: string, changes: Change[]): string {
  const sorted = [...changes].sort((a, b) => b.from - a.from || b.to - a.to);
  let out = text;
  for (const c of sorted) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

export interface Plan {
  changes: Change[];
  count: number;
  /** The archived blocks, as they will be written. */
  blocks: string[][];
}

/** Everything needed to archive the finished tasks of one note into the same note. */
export function planInNote(text: string, opts: ArchiveOptions, from?: number, to?: number): Plan | null {
  const lines = splitLines(text);
  const found = findCompleted(lines, opts, from, to);
  return planFor(text, lines, found, opts);
}

export function planFor(text: string, lines: Line[], found: Block[], opts: ArchiveOptions): Plan | null {
  if (found.length === 0) return null;
  const blocks = found.map((b) => b.lines);
  const insertion = planInsertion(text, blocks, opts);
  if (!insertion) return null;
  const removal = planRemoval(text, found, lines);
  return { changes: [...removal, insertion], count: found.length, blocks };
}

/** Counts the lines of a heading in tests and the settings preview. */
export function headingLine(opts: Pick<ArchiveOptions, 'heading' | 'level'>): string {
  return `${'#'.repeat(opts.level)} ${opts.heading}`;
}
