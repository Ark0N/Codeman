export type ResponseViewerTranscriptKind = 'prompt' | 'response' | 'status' | 'tool';

export interface ResponseViewerTranscriptBlock {
  kind: ResponseViewerTranscriptKind;
  label: 'Prompt' | 'Response' | 'Status' | 'Tool';
  /** What the frontend renders by: 'user' gets the "You" badge, everything else the agent badge. */
  role: 'user' | 'assistant';
  text: string;
}

// Keep in lockstep with isExternalCliMode() in src/session.ts. Importing it here
// would drag node-pty and the whole session layer into this pure module, so the
// list is duplicated and test/response-viewer-transcript.test.ts pins the parity.
const EXTERNAL_CLI_MODES = new Set(['codex', 'gemini', 'opencode', 'antigravity', 'pi', 'grok', 'deepseek']);

function isPromptLine(line: string): boolean {
  return /^\s*›\s*/.test(line);
}

function isDividerDashChar(ch: string): boolean {
  return ch === '─' || ch === '-';
}

function isWhitespaceChar(ch: string): boolean {
  return /\s/.test(ch);
}

// Linear-time equivalent of the old /^[─-]+\s*(.+?)\s*[─-]{3,}$/. The lazy
// middle of that pattern backtracked catastrophically on a long dash run that
// does NOT end in 3+ dashes (measured >2min at 8,000 chars) — and pane text is
// agent-controlled with buffers up to 32MB, so this ran on hostile input. Same
// accept set and same captured content, computed with counters; equivalence is
// pinned char-for-char against the old regex by the brute-force corpus test in
// test/response-viewer-transcript.test.ts.
function normalizeDividerStatusLine(line: string): string | null {
  const s = line.trim();
  const n = s.length;
  // Minimum match: 1 leading dash + 1 content char + 3 trailing dashes.
  if (n < 5) return null;

  let lead = 0;
  while (lead < n && isDividerDashChar(s.charAt(lead))) lead += 1;
  if (lead === 0) return null;

  let trail = 0;
  while (trail < n && isDividerDashChar(s.charAt(n - 1 - trail))) trail += 1;
  if (trail < 3) return null;

  // The regex was greedy on the leading run but gave dashes back until at least
  // one content char plus the 3-dash tail fit (an all-dash line matched with a
  // single leftover dash as its "content"), so the content window starts at the
  // end of the leading run, clamped to leave 4 chars.
  const contentStart = Math.min(lead, n - 4);
  let ws = 0;
  while (contentStart + ws < n - 4 && isWhitespaceChar(s.charAt(contentStart + ws))) ws += 1;
  const from = contentStart + ws;

  // The lazy middle stopped at the first position from which "optional
  // whitespace, then dashes to end-of-line" matches: the start of the
  // whitespace padding in front of the trailing dash run (never before the
  // first content char).
  const tailStart = n - trail;
  let padded = tailStart;
  while (padded > 0 && isWhitespaceChar(s.charAt(padded - 1))) padded -= 1;
  const end = Math.max(from + 1, padded);

  return s.slice(from, end).trim() || null;
}

function isDividerOnlyLine(line: string): boolean {
  return /^[\s─-]{8,}$/.test(line.trim());
}

// COD-227: unambiguous Codex tool-call markers. These only ever appear as internal
// activity, never as ordinary assistant prose, so they are always a Tool block.
function isToolActivityMarker(line: string): boolean {
  return /^\s*[•*-]\s+(Calling|Called)\b/.test(line.trim());
}

// COD-227: action verbs that ALSO occur in ordinary assistant prose (e.g.
// "• Created COD-226: …"). These are a Tool header only when corroborated by a
// box-drawing result tree on the next non-blank line (see the caller); the verb
// alone is not sufficient.
function isToolVerbBullet(line: string): boolean {
  return /^\s*[•*-]\s+(Explored|Viewed|Read|Edited|Updated|Created|Deleted|Ran|Searched|Opened|Listed|Found|Applied|Patched|Used|Wrote|Executed|Modified|Analyzed|Compared|Fetched|Installed)\b/.test(
    line.trim()
  );
}

// A genuine Codex tool block renders its result as a box-drawing tree (└ │ ├).
function isBoxDrawingLine(line: string): boolean {
  return /^[│├└]/.test(line.trim());
}

// Look past blank lines from `fromIndex + 1` for the next non-blank line and report
// whether it is a box-drawing tool-result line — the signal that a verb bullet is a
// real tool block rather than assistant prose that happens to start with a verb.
function nextNonBlankIsBoxDrawing(lines: string[], fromIndex: number): boolean {
  for (let j = fromIndex + 1; j < lines.length; j += 1) {
    const trimmed = (lines[j] || '').trim();
    if (!trimmed) continue;
    return isBoxDrawingLine(trimmed);
  }
  return false;
}

function isToolContinuationLine(line: string, currentKind: ResponseViewerTranscriptKind | null): boolean {
  if (currentKind !== 'tool') return false;
  const trimmed = line.trimEnd();
  if (!trimmed) return true;
  return /^\s*[│├└]/.test(trimmed) || /^\s{2,}\S/.test(line);
}

function isStatusLine(line: string, mode: string): boolean {
  if (!EXTERNAL_CLI_MODES.has(mode)) return false;
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (normalizeDividerStatusLine(trimmed)) return true;
  if (/^(model|directory):\s+/i.test(trimmed)) return true;
  if (/\bContext\b.*\bleft\b/i.test(trimmed)) return true;
  if (/\b\/model to change\b/i.test(trimmed)) return true;
  if (/\bReady\b/i.test(trimmed) && /·/.test(trimmed)) return true;
  if (/^(gpt|o\d|claude|gemini)\b/i.test(trimmed) && /·/.test(trimmed)) return true;
  if (/^Tip:/i.test(trimmed)) return true;
  if (/^\s*[•*-]\s+(Working|Thinking|Loading|Starting\b|Waiting\b)/i.test(trimmed)) return true;
  return false;
}

function isStandaloneMarkdownLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s/.test(trimmed)) return true;
  if (/^>\s/.test(trimmed)) return true;
  if (/^(```|~~~)/.test(trimmed)) return true;
  if (/^[-*+]\s/.test(trimmed)) return true;
  if (/^\d+[.)]\s/.test(trimmed)) return true;
  if (/^\|/.test(trimmed)) return true;
  if (/^\s{4,}\S/.test(line)) return true;
  return false;
}

function shouldJoinWrappedLine(previous: string, next: string): boolean {
  const prev = previous.trimEnd();
  const curr = next.trim();
  if (!prev || !curr) return false;
  if (/[.!?]$/.test(prev)) return false;
  if (/[:;]$/.test(prev)) return false;
  if (isStandaloneMarkdownLine(curr)) return false;
  if (/^[a-z(]/.test(curr)) return true;
  if (prev.length >= 72 && /^[A-Za-z0-9"'(]/.test(curr)) return true;
  return false;
}

function normalizeWrappedText(lines: string[]): string {
  const out: string[] = [];
  let paragraph = '';

  const flushParagraph = () => {
    if (!paragraph) return;
    out.push(paragraph);
    paragraph = '';
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      if (out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (isStandaloneMarkdownLine(line)) {
      flushParagraph();
      out.push(trimmed);
      continue;
    }
    if (!paragraph) {
      paragraph = trimmed;
      continue;
    }
    if (shouldJoinWrappedLine(paragraph, trimmed)) {
      paragraph += ` ${trimmed}`;
      continue;
    }
    flushParagraph();
    paragraph = trimmed;
  }

  flushParagraph();
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanTerminalTranscript(buffer: string): string {
  // Stripping ANSI/OSC/DCS escape sequences and stray C0/C1 control bytes
  // legitimately requires control characters in these patterns.
  /* eslint-disable no-control-regex */
  return String(buffer || '')
    .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[NO()][A-Z0-9]?/g, '')
    .replace(/\x1b[>=<78cDEHM]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  /* eslint-enable no-control-regex */
}

function trimLeadingStartup(lines: string[]): string[] {
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] || '';
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (/^[╭╰│─].*[╮╯│]?$/.test(trimmed)) {
      index += 1;
      continue;
    }
    if (/^>_\s*OpenAI Codex/i.test(trimmed)) {
      index += 1;
      continue;
    }
    if (/^(model|directory):\s+/i.test(trimmed)) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index);
}

function pushBlock(
  blocks: ResponseViewerTranscriptBlock[],
  kind: ResponseViewerTranscriptKind | null,
  lines: string[]
): void {
  if (!kind || lines.length === 0) return;
  const normalizedLines =
    kind === 'status'
      ? lines.map((line) => normalizeDividerStatusLine(line) || line.trim()).filter((line) => line.length > 0)
      : lines;
  const text =
    kind === 'tool' || kind === 'status'
      ? normalizedLines
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      : normalizeWrappedText(normalizedLines);
  if (!text) return;
  const label = (kind.charAt(0).toUpperCase() + kind.slice(1)) as ResponseViewerTranscriptBlock['label'];
  // The frontend's loadFullContext() renders via msg.role — a block without it
  // lost the "You" badge on prompts and rendered every block as the agent.
  blocks.push({ kind, label, role: kind === 'prompt' ? 'user' : 'assistant', text });
}

export function isExternalCliTranscriptMode(mode: string | null | undefined): boolean {
  return EXTERNAL_CLI_MODES.has(String(mode || ''));
}

export function parseExternalCliTranscript(
  buffer: string,
  mode: string | null | undefined
): ResponseViewerTranscriptBlock[] {
  const resolvedMode = String(mode || '');
  if (!isExternalCliTranscriptMode(resolvedMode)) return [];

  const cleaned = cleanTerminalTranscript(buffer);
  if (!cleaned) return [];

  const lines = trimLeadingStartup(cleaned.split('\n'));
  const blocks: ResponseViewerTranscriptBlock[] = [];
  let currentKind: ResponseViewerTranscriptKind | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    pushBlock(blocks, currentKind, currentLines);
    currentKind = null;
    currentLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // COD-226: within a prompt, the 2-space Codex gutter is authoritative. Blank
    // lines and gutter-indented (2+ leading spaces) continuation lines stay in the
    // Prompt block ahead of every structural detector below, so multiline prompts —
    // including bullets, indented dividers, and literal › lines — are not
    // misclassified as responses. Only a non-blank, non-gutter line ends the prompt
    // and falls through (a column-0 › then opens a NEW prompt).
    if (currentKind === 'prompt') {
      if (!line.trim()) {
        currentLines.push('');
        continue;
      }
      if (/^ {2,}\S/.test(line)) {
        currentLines.push(line);
        continue;
      }
    }

    if (isDividerOnlyLine(line)) {
      flush();
      continue;
    }

    if (isPromptLine(line)) {
      flush();
      currentKind = 'prompt';
      currentLines = [line.replace(/^\s*›\s*/, '').trim()];
      continue;
    }

    // COD-227: • Calling / • Called are always tool markers; the other action verbs
    // are a tool header only when a box-drawing result tree follows on the next
    // non-blank line — otherwise the verb bullet is ordinary assistant prose.
    if (isToolActivityMarker(line) || (isToolVerbBullet(line) && nextNonBlankIsBoxDrawing(lines, i))) {
      if (currentKind !== 'tool') flush();
      currentKind = 'tool';
      currentLines.push(line.trimEnd());
      continue;
    }

    if (isToolContinuationLine(line, currentKind)) {
      currentLines.push(line.trimEnd());
      continue;
    }

    if (isStatusLine(line, resolvedMode)) {
      if (currentKind !== 'status') flush();
      currentKind = 'status';
      currentLines.push(line.trim());
      continue;
    }

    if (!line.trim()) {
      currentLines.push('');
      continue;
    }

    if (currentKind !== 'response') flush();
    currentKind = 'response';
    currentLines.push(line);
  }

  flush();
  return blocks.filter((block) => block.text.trim().length > 0);
}

export function getLastTranscriptResponse(blocks: ResponseViewerTranscriptBlock[]): string {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.kind === 'response') return blocks[i].text;
  }
  return '';
}

/**
 * The messages of the most recent turn that has an answer: every assistant
 * message whose `turn` matches the highest turn any assistant message carries.
 *
 * This is what the viewer's brief ("Last Response") view renders for Claude.
 * The brief `text` is one row — the last assistant row — and a Claude turn is
 * a median of 3 rows (p90 11), so that row alone was usually the tail of the
 * answer ("Done.") with the substance in the rows before it. Reading the whole
 * turn gives the same cards the full view shows for it, and no more.
 *
 * Deliberately NOT "everything after the last user message": a prompt queued
 * while the agent works opens a new, still-unanswered turn, and the honest
 * brief view is then the previous, answered one — exactly the row `text`
 * already points at. Messages without a numeric `turn` (Codex, the pane
 * parser, an older reader) yield an empty list so callers fall back to `text`.
 */
export function selectLastAnsweredTurn<T extends { role: string; turn?: number }>(messages: T[]): T[] {
  let latest = -1;
  for (const message of messages) {
    if (message.role === 'assistant' && typeof message.turn === 'number' && message.turn > latest) {
      latest = message.turn;
    }
  }
  if (latest < 0) return [];
  return messages.filter((message) => message.role === 'assistant' && message.turn === latest);
}
