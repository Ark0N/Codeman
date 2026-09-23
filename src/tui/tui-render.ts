/**
 * @fileoverview Pure frame renderer: model + layout in, one string out.
 *
 * The frame is absolute-addressed, one `ESC [ <row>;1 H` per line followed by
 * `ESC [ K`, so nothing ever scrolls and a repaint cannot leave debris. The
 * caller wraps the result in synchronized-output brackets (DECSET 2026) where
 * the terminal supports it; that is an IO decision and stays out of here.
 *
 * Color is decided by the caller and passed in, never detected here: chalk's
 * auto-detection is the right answer for the one-shot CLI (see `cli-style.ts`)
 * but it would make a frame non-deterministic, and "same inputs, same string"
 * is what makes this module testable. The palette below is the same semantic
 * vocabulary chalk gives `cli-style` (ok green, warn yellow, err red, info
 * cyan, muted gray, emph bold), written as raw SGR so the mapping is fixed.
 *
 * With `color: false` the frame contains no escape sequences at all beyond the
 * cursor addressing that puts each line in place.
 *
 * @module tui/tui-render
 */

import { clipStyledLine, padDisplay, stripStyles, visibleWidth } from './tui-ansi.js';
import { approvalCard } from './tui-approvals.js';
import { composerText, composerWindow } from './tui-composer.js';
import type { TuiLayout, TuiRect } from './tui-layout.js';
import type { ApprovalItem } from '../web/approval-inbox.js';
import type { StatusTelemetry } from '../usage-telemetry.js';
import type {
  TuiDigestState,
  TuiGlyphTier,
  TuiGroup,
  TuiPickerState,
  TuiPromptState,
  TuiRenderModel,
  TuiRow,
  TuiSearchState,
  TuiSessionRow,
  TuiSessionState,
} from './tui-types.js';

export interface TuiRenderOptions {
  /** Emit SGR color. False is NO_COLOR: cursor addressing and nothing else. */
  color: boolean;
  glyphs: TuiGlyphTier;
  /** Animation counter. The WORKING glyph cycles with it. */
  tick: number;
  /** Wall clock for elapsed times, passed in so a frame is reproducible. */
  now: number;
  /**
   * Footer entries, already labelled, joined here with the separator glyph.
   * The app layer passes the keys that actually do something right now (which
   * verbs are wired up, whether a server is answering); omitting it falls back
   * to the full keymap below.
   */
  footerKeys?: readonly string[];
  /**
   * `[key, what it does]` pairs for the help overlay, same reasoning as
   * `footerKeys`: the app layer knows which verbs are wired up. Omitting it
   * falls back to the full keymap.
   */
  helpKeys?: ReadonlyArray<readonly [string, string]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette and glyphs
// ─────────────────────────────────────────────────────────────────────────────

const SGR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

/**
 * One word per state, shared by the preview title and the `--list` output so
 * both surfaces call a session the same thing.
 */
export const STATE_WORDS: Record<TuiSessionState, string> = {
  'blocked-permission': 'blocked',
  'blocked-question': 'blocked',
  waiting: 'waiting',
  working: 'working',
  idle: 'idle',
  recent: 'done',
};

const STATE_COLOR: Record<TuiSessionState, string> = {
  'blocked-permission': SGR.red,
  'blocked-question': SGR.red,
  waiting: SGR.yellow,
  working: SGR.green,
  idle: SGR.gray,
  recent: SGR.gray,
};

export interface TuiGlyphSet {
  blockedPermission: string;
  blockedQuestion: string;
  waiting: string;
  /** WORKING animates through Claude's own glyph family, a deliberate nod. */
  working: readonly string[];
  idle: string;
  recent: string;
  cursor: string;
  rule: string;
  divider: string;
  boxTopLeft: string;
  boxTopRight: string;
  boxBottomLeft: string;
  boxBottomRight: string;
  boxHorizontal: string;
  boxVertical: string;
  enter: string;
  updown: string;
  separator: string;
  ellipsis: string;
}

/**
 * ⚠️ Every glyph here must clear TWO bars that are easy to miss, and both were
 * failed at once by the first version of this table.
 *
 * WIDTH: the renderer addresses cells by column, so a glyph the terminal draws
 * two cells wide shifts everything after it. `east_asian_width` W or F is
 * therefore disqualifying. `✋` (U+270B) was Wide, and being an emoji is also
 * why fonts render it at emoji size in the middle of a text row.
 *
 * COVERAGE: a plain terminal font carries far less than the unicode TIER
 * implies. The tier answers "is the locale UTF-8", which says nothing about
 * whether a given codepoint has a glyph.
 *
 * One beta tester's font mapped the blocks like this, and it is the profile to
 * design against because it is an ordinary terminal font, not a broken one:
 *
 *   RENDERS   Latin-1 (·), Box Drawing (─ │), Block Elements (█ ▛ ▐),
 *             Geometric Shapes (○ ▶), General Punctuation (…), Arrows
 *   TOFU      Misc Technical (⏎ U+23CE, ⏵ U+23F5), the sparse end of
 *             Dingbats (❯ U+276F)
 *
 * So: draw from the blocks on the first line. Dingbats, Miscellaneous
 * Technical, Miscellaneous Symbols and anything with emoji presentation are
 * out — that class produced three separate "why are there boxes" reports, one
 * per glyph, because each was fixed on its own instead of as a class.
 */
const UNICODE_GLYPHS: TuiGlyphSet = {
  blockedPermission: '▲',
  blockedQuestion: '▲',
  waiting: '!',
  // Quadrant blocks, which rotate as a spinner and live in the same block as
  // the `▛█▐` art claude itself draws — proven to render on the font that
  // failed the dingbats this used to use.
  working: ['▖', '▘', '▝', '▗'],
  idle: '○',
  recent: '✔',
  cursor: '▶',
  rule: '─',
  divider: '│',
  boxTopLeft: '┌',
  boxTopRight: '┐',
  boxBottomLeft: '└',
  boxBottomRight: '┘',
  boxHorizontal: '─',
  boxVertical: '│',
  enter: '↵',
  updown: '↑↓',
  separator: '·',
  ellipsis: '…',
};

/**
 * The lowest tier, for terminals that are not known-capable. Every state token
 * is three columns wide so rows still line up, mirroring what `sc` falls back
 * to today.
 */
const ASCII_GLYPHS: TuiGlyphSet = {
  blockedPermission: '[!]',
  blockedQuestion: '[?]',
  waiting: '[w]',
  working: ['[*]', '[+]', '[x]', '[+]'],
  idle: '[-]',
  recent: '[v]',
  cursor: '>',
  rule: '-',
  divider: '|',
  boxTopLeft: '+',
  boxTopRight: '+',
  boxBottomLeft: '+',
  boxBottomRight: '+',
  boxHorizontal: '-',
  boxVertical: '|',
  enter: 'enter',
  updown: 'up/dn',
  separator: '-',
  ellipsis: '..',
};

/**
 * Glyphs for a tier. `nerd` currently renders like `unicode`: the tier exists
 * so detection has somewhere to land and a nerd-font-only set has a home,
 * without shipping glyphs nobody has reviewed on a real font.
 */
export function glyphsFor(tier: TuiGlyphTier): TuiGlyphSet {
  return tier === 'ascii' ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

/**
 * Glyph tier from the environment. IO-ish by nature (it reads env), so it takes
 * the env as an argument and the app layer calls it once at startup. The
 * known-capable list is a TERM allowlist, plus a UTF-8 locale check and an
 * explicit override.
 */
export function detectGlyphTier(env: Record<string, string | undefined>): TuiGlyphTier {
  const override = env.CODEMAN_TUI_GLYPHS;
  if (override === 'ascii' || override === 'unicode' || override === 'nerd') return override;
  const term = env.TERM ?? '';
  if (term === '' || term === 'dumb') return 'ascii';
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (!/utf-?8/i.test(locale)) return 'ascii';
  const termProgram = env.TERM_PROGRAM ?? '';
  if (termProgram.startsWith('iTerm') || term === 'xterm-kitty' || env.WEZTERM_PANE || env.LC_TERMINAL === 'iTerm2') {
    return 'nerd';
  }
  return 'unicode';
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers (pure, exported for tests and for the app layer)
// ─────────────────────────────────────────────────────────────────────────────

/** Compact age: `45s`, `11m`, `2h`, `3d`. Empty when the anchor is unknown. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

/** Compact token count: `842`, `45.2k`, `1.2M`. Empty when there is nothing to show. */
export function formatTokens(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '';
  if (total < 1000) return String(Math.floor(total));
  if (total < 1_000_000) return `${trimTrailingZero((total / 1000).toFixed(1))}k`;
  return `${trimTrailingZero((total / 1_000_000).toFixed(1))}M`;
}

/**
 * The header's plan-usage chip: `5h 32% · wk 61%`, the same two windows the web
 * chip shows (the statusline telemetry carries no others). Empty when the
 * account reports neither, so the header shows no placeholder for a fact that
 * does not exist. The separator is passed in because the header's own comes
 * from the glyph tier, and an ASCII terminal must not get a stray `·`.
 */
export function formatPlanUsage(usage: StatusTelemetry | null | undefined, separator = ' · '): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (typeof usage.fiveHour?.usedPercentage === 'number') {
    parts.push(`5h ${Math.round(usage.fiveHour.usedPercentage)}%`);
  }
  if (typeof usage.sevenDay?.usedPercentage === 'number') {
    parts.push(`wk ${Math.round(usage.sevenDay.usedPercentage)}%`);
  }
  return parts.join(separator);
}

/**
 * What a row is called. Same rule as the web history rows, including the
 * "(no content)" placeholder the transcript reader emits, which is not a title.
 */
export function rowLabel(session: TuiSessionRow): string {
  if (session.name) return session.name;
  const base = (session.workingDir ?? '').split('/').filter(Boolean).pop();
  // ⚠️ A LIVE pane (it has a mux name) is identified by WHERE it runs, never by
  // a line scraped out of its transcript. A session created before the user has
  // typed anything has no prompt to be named after, so the fallback took
  // whatever the CLI happened to print first: a beta tester's new session
  // appeared in the list called "Login interrupted", which reads like a failure
  // report and was in fact a healthy session. A history row is the opposite
  // case, where the prompt IS the identity, so it keeps the old order.
  if (session.muxName && base) return base;
  const prompt = (session.firstPrompt ?? '').trim();
  if (prompt && prompt !== '(no content)') return prompt;
  return base || session.sessionId.slice(0, 8);
}

/** Keep the tail of a path: the last segments identify it, the root never does. */
function truncatePathLeft(path: string, width: number, ellipsis: string): string {
  if (width <= 0) return '';
  if (visibleWidth(path) <= width) return path;
  const keep = Math.max(0, width - visibleWidth(ellipsis));
  return ellipsis + path.slice(path.length - keep);
}

function tokensOf(session: TuiSessionRow): number {
  return (session.inputTokens ?? 0) + (session.outputTokens ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Painting
// ─────────────────────────────────────────────────────────────────────────────

type Painter = (text: string, code: string) => string;

function painterFor(enabled: boolean): Painter {
  return enabled ? (text, code) => (text === '' ? text : `${code}${text}${SGR.reset}`) : (text) => text;
}

function stateGlyph(row: TuiRow, glyphs: TuiGlyphSet, tick: number): string {
  switch (row.state) {
    case 'blocked-permission':
      return glyphs.blockedPermission;
    case 'blocked-question':
      return glyphs.blockedQuestion;
    case 'waiting':
      return glyphs.waiting;
    case 'working': {
      const frames = glyphs.working;
      const index = ((Math.trunc(tick) % frames.length) + frames.length) % frames.length;
      return frames[index];
    }
    case 'idle':
      return glyphs.idle;
    case 'recent':
      return glyphs.recent;
  }
}

function centered(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return padDisplay(`${' '.repeat(pad)}${text}`, width);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows and groups
// ─────────────────────────────────────────────────────────────────────────────

interface RowContext {
  width: number;
  /** 1-based position in the flattened list; only 1-9 get a jump digit. */
  index: number;
  selected: boolean;
  twoLine: boolean;
  glyphs: TuiGlyphSet;
  opts: TuiRenderOptions;
}

function renderRowLines(row: TuiRow, ctx: RowContext): string[] {
  // A selected row is one inverse-video block, so its parts are built unpainted:
  // an inner reset would punch a hole in the highlight.
  const inverse = ctx.selected && ctx.opts.color;
  const paint = painterFor(ctx.opts.color && !inverse);
  const { session } = row;

  const marker = ctx.selected ? padDisplay(ctx.glyphs.cursor, 2) : '  ';
  const digit = ctx.index >= 1 && ctx.index <= 9 ? `${ctx.index} ` : '  ';

  const glyph = paint(stateGlyph(row, ctx.glyphs, ctx.opts.tick), STATE_COLOR[row.state]);
  const elapsed = row.since > 0 ? formatElapsed(ctx.opts.now - row.since) : '';
  const tokens = formatTokens(tokensOf(session));
  const rightParts = [glyph, paint(elapsed, SGR.gray)];
  if (!ctx.twoLine && tokens) rightParts.push(paint(tokens, SGR.gray));
  const right = rightParts.filter((part) => part !== '').join(' ');

  const mode = session.mode && session.mode !== 'claude' ? session.mode : '';
  const nameWidth = Math.max(4, ctx.width - visibleWidth(marker + digit) - visibleWidth(right) - 1);
  const label = rowLabel(session);
  const name = mode ? `${label} ${paint(mode, SGR.magenta)}` : label;

  const first = padDisplay(`${marker}${digit}${padDisplay(name, nameWidth)} ${right}`, ctx.width);
  const lines = [first];

  if (ctx.twoLine) {
    const detail = [truncatePathLeft(session.workingDir ?? '', Math.max(0, ctx.width - 8), ctx.glyphs.ellipsis)];
    if (mode) detail.push(mode);
    if (tokens) detail.push(tokens);
    const text = detail.filter((part) => part !== '').join(` ${ctx.glyphs.separator} `);
    lines.push(padDisplay(`    ${paint(text, SGR.gray)}`, ctx.width));
  }

  return inverse ? lines.map((line) => `${SGR.inverse}${line}${SGR.reset}`) : lines;
}

function renderGroupHeader(group: TuiGroup, width: number, glyphs: TuiGlyphSet, opts: TuiRenderOptions): string {
  const paint = painterFor(opts.color);
  const label = ` ${group.label} `;
  const fill = Math.max(0, width - visibleWidth(label));
  return padDisplay(`${paint(label, SGR.bold)}${paint(glyphs.rule.repeat(fill), SGR.gray)}`, width);
}

export interface TuiListEntry {
  text: string;
  /** Set on the lines that belong to a session row, so the window can chase the cursor. */
  sessionId?: string;
}

function buildListEntries(model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): TuiListEntry[] {
  const glyphs = glyphsFor(opts.glyphs);
  const width = layout.list.width;
  const entries: TuiListEntry[] = [];
  let index = 0;
  for (const group of model.groups()) {
    if (group.rows.length === 0) continue;
    entries.push({ text: renderGroupHeader(group, width, glyphs, opts) });
    for (const row of group.rows) {
      index++;
      const ctx: RowContext = {
        width,
        index,
        selected: row.session.sessionId === model.selectedId,
        twoLine: layout.rowHeight === 2,
        glyphs,
        opts,
      };
      for (const text of renderRowLines(row, ctx)) entries.push({ text, sessionId: row.session.sessionId });
    }
  }
  return entries;
}

/**
 * First visible entry, scrolling the minimum needed to keep the selected row on
 * screen. Deterministic on purpose: the window is derived, never remembered, so
 * two identical models render identically.
 */
export function computeListWindow(
  entries: readonly TuiListEntry[],
  capacity: number,
  selectedId: string | null
): number {
  if (capacity <= 0 || entries.length <= capacity) return 0;
  const maxStart = entries.length - capacity;
  if (!selectedId) return 0;
  const first = entries.findIndex((entry) => entry.sessionId === selectedId);
  if (first < 0) return 0;
  let last = first;
  while (last + 1 < entries.length && entries[last + 1].sessionId === selectedId) last++;
  let start = 0;
  if (last >= capacity) start = Math.min(last - capacity + 1, maxStart);
  if (first < start) start = first;
  return start;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The pending dialog, drawn above the tail: the question, the parsed options
 * with their digits, and the keys that answer them. Red for a permission or
 * question prompt, yellow for an idle one, the same severity vocabulary the web
 * inbox uses. An idle prompt that opened acknowledged carries neither: it reads
 * grey with the idle glyph, because nothing about it wants the reader.
 */
export function renderApprovalCard(
  item: ApprovalItem,
  width: number,
  glyphs: TuiGlyphSet,
  opts: TuiRenderOptions
): string[] {
  const paint = painterFor(opts.color);
  const card = approvalCard(item);
  const color = card.tone === 'err' ? SGR.red : card.tone === 'warn' ? SGR.yellow : SGR.gray;
  const glyph = card.tone === 'err' ? glyphs.blockedPermission : card.tone === 'warn' ? glyphs.waiting : glyphs.idle;
  const lines: string[] = [];
  const push = (text: string, style: string): void => {
    lines.push(padDisplay(paint(clipStyledLine(text, width), style), width));
  };

  push(` ${glyph} ${card.title}`, color);
  for (const detail of card.detail) push(`   ${detail}`, SGR.gray);
  for (const option of card.options) push(`   ${option.n}. ${option.label}`, '');
  push(` ${card.hint}`, SGR.gray);
  return lines;
}

/** The card may take half the pane at most: the tail is why the pane exists. */
function cardCapacity(height: number): number {
  return Math.max(0, Math.floor((height - 1) / 2));
}

/**
 * `name · mode · dir · state`, with the DIRECTORY absorbing the squeeze: the
 * state word is the one fact the pane exists to confirm, so it must survive a
 * narrow preview that a full path would push off the end.
 */
function previewTitle(row: TuiRow, width: number, glyphs: TuiGlyphSet): string {
  const { session } = row;
  const sep = ` ${glyphs.separator} `;
  const head = ` ${rowLabel(session)}${sep}${session.mode ?? 'claude'}`;
  const tail = `${sep}${STATE_WORDS[row.state]}`;
  const dirBudget = width - visibleWidth(head) - visibleWidth(tail) - visibleWidth(sep);
  const dir = session.workingDir ? truncatePathLeft(session.workingDir, Math.max(0, dirBudget), glyphs.ellipsis) : '';
  return clipStyledLine(dir ? `${head}${sep}${dir}${tail}` : `${head}${tail}`, width);
}

function buildPreviewLines(model: TuiRenderModel, rect: TuiRect, opts: TuiRenderOptions): string[] {
  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);
  const lines: string[] = [];
  const selected = model.selectedId
    ? (model
        .groups()
        .flatMap((group) => group.rows)
        .find((row) => row.session.sessionId === model.selectedId) ?? null)
    : null;

  if (!selected) {
    lines.push(padDisplay(paint(' no session selected', SGR.gray), rect.width));
  } else {
    lines.push(padDisplay(paint(previewTitle(selected, rect.width, glyphs), SGR.bold), rect.width));
  }

  const budget = cardCapacity(rect.height);
  if (selected?.approval && budget > 0) {
    for (const line of renderApprovalCard(selected.approval, rect.width, glyphs, opts).slice(0, budget)) {
      lines.push(line);
    }
    if (lines.length < rect.height) lines.push(' '.repeat(rect.width));
  }

  const body = previewBody(model, selected, rect, opts, rect.height - lines.length);
  for (const line of body) lines.push(line);
  while (lines.length < rect.height) lines.push(' '.repeat(rect.width));
  return lines.slice(0, Math.max(0, rect.height));
}

function previewBody(
  model: TuiRenderModel,
  selected: TuiRow | null,
  rect: TuiRect,
  opts: TuiRenderOptions,
  capacity: number
): string[] {
  const paint = painterFor(opts.color);
  if (capacity <= 0) return [];
  const hint = (text: string): string[] => [padDisplay(paint(` ${text}`, SGR.gray), rect.width)];

  if (!selected) return [];
  if (model.connection === 'degraded' || model.connection === 'down') {
    return hint('preview unavailable while the server is down');
  }
  const preview = model.preview;
  if (!preview || preview.sessionId !== selected.session.sessionId) return hint('loading preview…');
  if (preview.note) return hint(preview.note);
  if (preview.error) return hint(preview.error);

  const trimmed = [...preview.lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
  if (trimmed.length === 0) return hint('(no output yet)');
  // The tail carries the session's OWN colors, which is the point of the pane,
  // but under NO_COLOR they must go too.
  return trimmed
    .slice(-capacity)
    .map((line) => padDisplay(` ${clipStyledLine(opts.color ? line : stripStyles(line), rect.width - 1)}`, rect.width));
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sessions with a prompt waiting on a human, which is what the badge counts.
 *
 * An ACKNOWLEDGED item is not one of them. Its alert has been spent, either by somebody
 * opening the session elsewhere or because the inbox opened it that way for a session
 * watching its own background work, and the row has already left NEEDS YOU by the same
 * flag (`classifySession`). Counting it here would put a number in the header for a
 * group the reader can see is empty.
 */
export function pendingApprovalCount(model: TuiRenderModel): number {
  let count = 0;
  for (const group of model.groups())
    for (const row of group.rows) if (row.approval && !row.approval.acknowledgedAt) count++;
  return count;
}

function renderHeaderLine(model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): string {
  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);
  const { hostname, instance, version, planUsage } = model.header;
  const facts = [
    instance ? `${hostname ?? ''}:${instance}` : (hostname ?? ''),
    version ? `v${version}` : '',
    `${model.sessionCount} session${model.sessionCount === 1 ? '' : 's'}`,
    planUsage ?? '',
  ].filter((part) => part !== '');

  const pending = pendingApprovalCount(model);
  const badge = pending > 0 ? `${paint(`${glyphs.blockedPermission} ${pending}`, SGR.red)}  ` : '';
  const left = ` ${paint('codeman', SGR.bold)}  ${badge}${paint(facts.join(` ${glyphs.separator} `), SGR.gray)}`;
  const right = paint('? help  q quit ', SGR.gray);
  const gap = layout.cols - visibleWidth(left) - visibleWidth(right);
  if (gap < 1) return padDisplay(left, layout.cols);
  return `${left}${' '.repeat(gap)}${right}`;
}

function renderBannerLine(model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): string {
  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);
  const [text, color] =
    model.connection === 'degraded'
      ? ['server not running: attach only', SGR.yellow]
      : model.connection === 'reconnecting'
        ? ['reconnecting to the server…', SGR.yellow]
        : ['server unreachable', SGR.red];
  return padDisplay(paint(` ${glyphs.blockedPermission} ${text}`, color), layout.cols);
}

const FOOTER_KEYS: Record<string, (glyphs: TuiGlyphSet) => string> = {
  list: (g) =>
    [
      `${g.updown} select`,
      `${g.enter} attach`,
      '1-9 switch',
      'y/n answer',
      'p prompt',
      'n new',
      'x kill',
      '/ search',
      'g digest',
      '? help',
      'q quit',
    ].join(` ${g.separator} `),
  help: (g) => `esc ${g.separator} ? close`,
  'confirm-kill': (g) => `y kill ${g.separator} any other key cancels`,
  message: () => 'esc dismiss',
  prompt: (g) => `${g.enter} send ${g.separator} esc cancel`,
  search: (g) => `${g.updown} results ${g.separator} ${g.enter} open ${g.separator} esc close`,
  digest: (g) => `j/k ${g.separator} ${g.updown} scroll ${g.separator} esc close`,
  'new-session': (g) => `${g.updown} select ${g.separator} ${g.enter} choose ${g.separator} esc cancel`,
};

/**
 * The composer's prefix. Fixed width on purpose: the terminal cursor is placed
 * by column arithmetic (`composerCursorCell`), and a prefix that changed with
 * the session name would move the cursor with it.
 */
export const COMPOSER_PREFIX = ' > ';

function renderComposerLine(prompt: TuiPromptState, layout: TuiLayout, opts: TuiRenderOptions): string {
  const paint = painterFor(opts.color);
  const window = composerWindow(prompt.composer, Math.max(1, layout.cols - visibleWidth(COMPOSER_PREFIX)));
  return padDisplay(`${paint(COMPOSER_PREFIX, SGR.cyan)}${window.text}`, layout.cols);
}

/**
 * Where the terminal's own cursor belongs, or null when nothing is being typed
 * into a single-line editor. The app shows the cursor there and hides it
 * otherwise, because a blinking cursor parked in a dashboard reads as a bug.
 */
export function composerCursorCell(model: TuiRenderModel, layout: TuiLayout): { row: number; col: number } | null {
  if (model.mode !== 'prompt' || !model.prompt || layout.footer.height <= 0) return null;
  const prefix = visibleWidth(COMPOSER_PREFIX);
  const window = composerWindow(model.prompt.composer, Math.max(1, layout.cols - prefix));
  return { row: layout.footer.row, col: Math.min(layout.cols, prefix + 1 + window.cursorColumn) };
}

function renderFooterLine(model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): string {
  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);
  if (model.mode === 'prompt' && model.prompt) return renderComposerLine(model.prompt, layout, opts);
  const text = opts.footerKeys
    ? opts.footerKeys.join(` ${glyphs.separator} `)
    : (FOOTER_KEYS[model.mode] ?? FOOTER_KEYS.list)(glyphs);
  return padDisplay(paint(clipStyledLine(` ${text}`, layout.cols), SGR.gray), layout.cols);
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlays
// ─────────────────────────────────────────────────────────────────────────────

interface OverlayContent {
  title: string;
  lines: string[];
  /**
   * Floor for the box's inner width. The search and digest panels are lists
   * people scan, so they keep a stable width instead of snapping around their
   * longest current line.
   */
  minWidth?: number;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (visibleWidth(candidate) > width && line !== '') {
      out.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') out.push(line);
  return out.length > 0 ? out : [''];
}

function helpLines(glyphs: TuiGlyphSet, custom?: ReadonlyArray<readonly [string, string]>): string[] {
  const pairs: ReadonlyArray<readonly [string, string]> = custom ?? [
    [`${glyphs.updown} / j k`, 'select'],
    [glyphs.enter, 'attach'],
    ['1-9', 'jump'],
    ['y / n', 'answer the pending approval'],
    ['p', 'send a prompt'],
    ['n', 'new session'],
    ['x', 'kill (typed confirmation)'],
    ['/', 'search'],
    ['g', 'away digest'],
    ['?', 'this help'],
    ['q', 'quit'],
  ];
  const keyWidth = Math.max(...pairs.map(([key]) => visibleWidth(key)));
  return pairs.map(([key, description]) => `${padDisplay(key, keyWidth)}  ${description}`);
}

/** Longest item list a picker overlay shows, however tall the terminal is. */
const PICKER_MAX_ROWS = 10;

/**
 * A picker's lines: hint, a window of items around the cursor, then the filter
 * echo. Windowed rather than clipped, so the selected item is always visible in
 * a long case list.
 */
function pickerLines(picker: TuiPickerState, glyphs: TuiGlyphSet, capacity: number): string[] {
  const head: string[] = picker.hint ? [picker.hint, ''] : [];
  const tail: string[] = picker.filter === undefined ? [] : ['', `filter: ${picker.filter}_`];
  if (picker.items.length === 0) return [...head, '(nothing to choose)', ...tail];

  const budget = Math.max(1, Math.min(PICKER_MAX_ROWS, capacity - head.length - tail.length));
  const first = Math.max(0, Math.min(picker.index - Math.floor(budget / 2), picker.items.length - budget));
  const rows = picker.items.slice(first, first + budget).map((item, i) => {
    const marker = first + i === picker.index ? glyphs.cursor : ' '.repeat(visibleWidth(glyphs.cursor));
    return `${marker} ${item.label}${item.detail ? `  ${item.detail}` : ''}`;
  });
  return [...head, ...rows, ...tail];
}

/**
 * The `/` overlay: the query with a caret, one status line, then the results.
 *
 * The caret is a trailing `_` rather than the terminal's own cursor, and that is
 * why the search keymap leaves left/right to the result list: a caret that
 * cannot move is honest, an invisible one that can is not.
 */
function searchLines(state: TuiSearchState, glyphs: TuiGlyphSet, capacity: number): string[] {
  const head = [`${composerText(state.composer)}_`];
  if (state.note) head.push(state.note);
  head.push('');

  const budget = Math.max(1, capacity - head.length);
  if (state.entries.length === 0) {
    return [...head, state.status === 'searching' ? 'searching…' : '(type to search sessions, events and files)'];
  }
  const first = Math.max(0, Math.min(state.index - Math.floor(budget / 2), state.entries.length - budget));
  const rows = state.entries.slice(first, first + budget).map((entry, i) => {
    if (entry.kind === 'header') return entry.text;
    const marker = first + i === state.index ? glyphs.cursor : ' '.repeat(visibleWidth(glyphs.cursor));
    return `${marker} ${entry.text}${entry.detail ? `  ${entry.detail}` : ''}`;
  });
  return [...head, ...rows];
}

/** Lines an overlay box can show inside its border, given the body's height. */
function overlayCapacity(height: number): number {
  return Math.max(1, height - 2);
}

/**
 * How many digest lines fit. Exported because the app scrolls by pages and must
 * not scroll the last page into empty space, which needs this exact number.
 */
export function digestCapacity(layout: TuiLayout): number {
  return overlayCapacity(layout.body.height);
}

function digestLines(state: TuiDigestState, capacity: number): string[] {
  const offset = Math.min(Math.max(0, state.offset), Math.max(0, state.lines.length - 1));
  return state.lines.slice(offset, offset + capacity);
}

function overlayContent(
  model: TuiRenderModel,
  opts: TuiRenderOptions,
  width: number,
  height: number
): OverlayContent | null {
  const glyphs = glyphsFor(opts.glyphs);
  const panelWidth = Math.max(20, Math.min(width - 8, 72));
  switch (model.mode) {
    case 'help':
      return { title: 'Keys', lines: helpLines(glyphs, opts.helpKeys) };
    case 'search': {
      if (!model.search) return null;
      return {
        title: 'Search',
        lines: searchLines(model.search, glyphs, overlayCapacity(height)),
        minWidth: panelWidth,
      };
    }
    case 'digest': {
      if (!model.digest) return null;
      return {
        title: model.digest.title,
        lines: digestLines(model.digest, overlayCapacity(height)),
        minWidth: panelWidth,
      };
    }
    case 'new-session': {
      if (!model.picker) return null;
      return { title: model.picker.title, lines: pickerLines(model.picker, glyphs, Math.max(1, height - 2)) };
    }
    case 'confirm-kill': {
      if (!model.confirm) return null;
      return {
        title: 'Kill session',
        lines: [`Kill ${model.confirm.name}?`, '', 'press y to kill, any other key cancels'],
      };
    }
    case 'message':
      if (!model.message) return null;
      return {
        title: model.message.tone === 'err' ? 'Error' : model.message.tone === 'warn' ? 'Warning' : 'Notice',
        lines: wrapText(model.message.text, Math.max(8, width - 8)),
      };
    default:
      return null;
  }
}

/** Paint an overlay box over the body, centered, replacing whole terminal rows. */
function applyOverlay(lines: string[], model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): void {
  const body = layout.body;
  if (body.height < 3 || body.width < 12) return;
  const content = overlayContent(model, opts, body.width, body.height);
  if (!content) return;

  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);
  const maxInner = body.width - 4;
  const visible = content.lines.slice(0, Math.max(1, body.height - 2));
  const inner = Math.min(
    maxInner,
    Math.max(content.minWidth ?? 0, visibleWidth(content.title) + 2, ...visible.map((line) => visibleWidth(line)))
  );
  const boxWidth = inner + 4;
  const boxHeight = visible.length + 2;
  const left = body.col + Math.max(0, Math.floor((body.width - boxWidth) / 2));
  const top = body.row + Math.max(0, Math.floor((body.height - boxHeight) / 2));

  const titleText = ` ${content.title} `;
  const titleFill = Math.max(0, inner + 2 - visibleWidth(titleText));
  const boxLines = [
    `${glyphs.boxTopLeft}${titleText}${glyphs.boxHorizontal.repeat(titleFill)}${glyphs.boxTopRight}`,
    ...visible.map((line) => `${glyphs.boxVertical} ${padDisplay(line, inner)} ${glyphs.boxVertical}`),
    `${glyphs.boxBottomLeft}${glyphs.boxHorizontal.repeat(inner + 2)}${glyphs.boxBottomRight}`,
  ];

  for (let i = 0; i < boxLines.length; i++) {
    const row = top + i - 1;
    if (row < 0 || row >= lines.length) continue;
    lines[row] = `${' '.repeat(left - 1)}${paint(boxLines[i], SGR.cyan)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame
// ─────────────────────────────────────────────────────────────────────────────

function writeBody(lines: string[], model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): void {
  const { list, preview, divider } = layout;
  if (list.height <= 0) return;
  const paint = painterFor(opts.color);
  const glyphs = glyphsFor(opts.glyphs);

  const entries = buildListEntries(model, layout, opts);
  if (entries.length === 0) {
    const hint = paint('No sessions. n to start one, q to quit.', SGR.gray);
    const row = list.row + Math.floor((list.height - 1) / 2);
    lines[row - 1] = centered(hint, layout.cols);
    return;
  }

  const start = computeListWindow(entries, list.height, model.selectedId);
  const previewLines = preview ? buildPreviewLines(model, preview, opts) : [];

  for (let i = 0; i < list.height; i++) {
    const left = entries[start + i]?.text ?? ' '.repeat(list.width);
    if (!preview || !divider) {
      lines[list.row - 1 + i] = left;
      continue;
    }
    const right = previewLines[i] ?? ' '.repeat(preview.width);
    lines[list.row - 1 + i] = `${left}${paint(glyphs.divider, SGR.gray)}${right}`;
  }
}

/**
 * The whole frame as one string: absolute cursor addressing per line, each line
 * closed with an erase-to-end so a shorter line cannot leave the previous
 * frame's tail behind.
 */
export function renderFrame(model: TuiRenderModel, layout: TuiLayout, opts: TuiRenderOptions): string {
  const lines: string[] = new Array<string>(layout.rows).fill('');
  lines[0] = renderHeaderLine(model, layout, opts);
  if (layout.banner) lines[layout.banner.row - 1] = renderBannerLine(model, layout, opts);
  writeBody(lines, model, layout, opts);
  if (layout.footer.height > 0) lines[layout.footer.row - 1] = renderFooterLine(model, layout, opts);
  applyOverlay(lines, model, layout, opts);

  let frame = '';
  for (let i = 0; i < lines.length; i++) {
    frame += `\x1b[${i + 1};1H${clipStyledLine(lines[i], layout.cols)}\x1b[K`;
  }
  return frame;
}
