/**
 * @fileoverview `codeman tui`: the full-screen dashboard plus the two
 * non-interactive fast paths (`--list`, `<n>`).
 *
 * This is the IO half of `src/tui/`: it owns the terminal, the timers, stdin
 * and the tmux handoff. Every decision it makes that can be stated as a
 * function of its inputs lives at the top of this file as an exported pure
 * helper (attach planning, the kill confirmation, footer selection, the
 * repaint test, degraded-row building), because none of those can be tested
 * through a real terminal.
 *
 * TERMINAL LIFECYCLE is the part users judge. A TUI that dies leaving the
 * terminal in raw mode with a hidden cursor is unusable until the user types a
 * blind `reset`, so `leave()` is idempotent and runs from every exit path there
 * is: normal quit, SIGINT/SIGTERM, and a `process.on('exit')` backstop that
 * fires even when someone else's handler calls `process.exit()`. The fatal
 * handlers are installed with `prependListener` on purpose: `src/index.ts`
 * already handles `uncaughtException` by exiting, and a listener registered
 * after it would never run.
 *
 * ATTACH is a handoff, never a proxy: the screen is fully restored and tmux
 * gets the real terminal (`stdio: 'inherit'`), so mouse, paste and colors are
 * tmux's own. Inside tmux on the same socket there is nothing to hand off to,
 * so the TUI issues `switch-client` and EXITS: the client it would draw on is
 * now showing the target session, and a dashboard nobody can see must not keep
 * polling the server.
 *
 * REPAINT POLICY: on state change (the model's revision), on resize, and on a
 * 500ms tick that runs only while a WORKING row is on screen (the glyph
 * animates). An idle dashboard writes nothing at all. The preview's own 1s poll
 * obeys the same rule: an unchanged tail never reaches the model, so it cannot
 * bump the revision and cannot repaint.
 *
 * ANSWERING A DIALOG goes through `POST /api/approvals/:id/answer` and nothing
 * else. That route re-captures the pane before it sends a keystroke and refuses
 * with 409 when the dialog has moved on, which is the only reason it is safe to
 * bind a single digit to it; a blind `send-keys` from here would type into
 * whatever now has focus.
 *
 * NOT HERE YET (phase 3 of docs/tui-plan.md): mouse support, the `--pick` popup
 * switcher, the opt-in attach status line, OSC 9 notifications, and resuming a
 * RECENT row.
 *
 * @module tui/tui-app
 */

import { spawnSync } from 'node:child_process';
import { hostname as osHostname } from 'node:os';
import chalk from 'chalk';
import { palette, table, tint, type Tone } from '../cli-style.js';
import { CODEMAN_INSTANCE, resolveTmuxSocketName } from '../config/instance.js';
import { getErrorMessage } from '../types/api.js';
import { dropSeveredEscape, foldPreviewGlyphs, toDisplayLines } from './tui-ansi.js';
import { approvalAnswerForKey, newApprovalIds } from './tui-approvals.js';
import { composerScroll, composerStep, composerText, createComposer, type TuiComposerState } from './tui-composer.js';
import { formatAwayDigest } from './tui-digest.js';
import {
  ATTACH_BANNER_MARKER,
  TuiClient,
  type TuiSessionOptions,
  type TuiWindowSizing,
  type TuiApprovalAnswer,
  type TuiEventStream,
  type TuiLiveSessionMetrics,
  type TuiPlanUsage,
  type TuiQuickStartOptions,
  type TuiTmuxSession,
} from './tui-client.js';
import { createKeyParser, type TuiInputEvent, type TuiKeyParser } from './tui-keys.js';
import { computeLayout, needsBanner, type TuiLayout } from './tui-layout.js';
import {
  buildSearchEntries,
  createTuiModel,
  firstSearchIndex,
  moveSearchIndex,
  type TuiModelStore,
} from './tui-model.js';
import {
  COMPOSER_PREFIX,
  composerCursorCell,
  detectGlyphTier,
  digestCapacity,
  formatPlanUsage,
  glyphsFor,
  renderFrame,
  rowLabel,
  STATE_WORDS,
  type TuiGlyphSet,
} from './tui-render.js';
import type { TuiRenderOptions } from './tui-render.js';
import type { ApprovalItem } from '../web/approval-inbox.js';
import type {
  TuiConfirmState,
  TuiConnectionStatus,
  TuiGlyphTier,
  TuiPickerItem,
  TuiPreview,
  TuiRow,
  TuiSessionRow,
  TuiSessionState,
  TuiUiMode,
} from './tui-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Timing
// ─────────────────────────────────────────────────────────────────────────────

/** How long a lone ESC waits for the rest of a sequence before it counts as Escape. */
const ESC_FLUSH_MS = 30;
/** Animation period. Two frames a second is what the plan's WORKING glyph asks for. */
const TICK_MS = 500;
/** A burst of SSE events (one session change fans out to several) becomes one refetch. */
const RESYNC_DEBOUNCE_MS = 250;
/**
 * Floor between two AMBIENT refetches, i.e. the ones an SSE event asks for.
 *
 * `GET /api/sessions/unified` is the expensive read in the app (~550ms measured
 * against 11 live sessions: it scans every Claude transcript plus the lifecycle
 * log, uncached, and republishes the search index), and the server broadcasts
 * `session:updated` per session per 500ms while anything is working. A trailing
 * debounce collapses a BURST but does not rate-limit a stream, so without a
 * floor the dashboard runs those scans back to back for as long as sessions are
 * busy, and the stall lands on every other client of the same server.
 *
 * A user's OWN actions bypass this (they call `refresh()` directly), so what it
 * paces is only "notice what changed elsewhere", where three seconds of
 * staleness on a status dot is invisible.
 */
const RESYNC_MIN_INTERVAL_MS = 3_000;
/** Poll period once the client reports SSE is not carrying events. */
const POLL_INTERVAL_MS = 2_000;
/** Degraded mode re-probes this often, so a server that starts upgrades the TUI live. */
const REPROBE_INTERVAL_MS = 10_000;
/** Unified-list page size. RECENT is capped far lower by the model. */
const UNIFIED_LIMIT = 60;
/** How often the selected session's tail is re-read while it is producing output. */
const PREVIEW_INTERVAL_MS = 1_000;
/**
 * Ceiling the tail poll backs off to once the pane stops changing.
 *
 * `GET /api/sessions/:id/terminal` is not a cheap read either (~80-100ms
 * measured): it runs two `execSync` tmux calls and normalizes the whole byte
 * buffer before it takes the tail, all of it blocking the server's event loop.
 * A pane at its composer prints nothing, so polling it every second buys
 * nothing; anything landing in the tail resets the cadence to fast again.
 */
const PREVIEW_MAX_INTERVAL_MS = 5_000;
/** Tail size. Enough for a tall pane's last screens, small enough to poll every second. */
const PREVIEW_TAIL_BYTES = 12 * 1024;
/** Lines kept from a tail. The pane shows a fraction of these; the rest is headroom. */
const PREVIEW_MAX_LINES = 200;
/** Quiet time after the last keystroke before the search query goes to the server. */
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 40;
/** How long a "sent" style notice stays up before it clears itself. */
const NOTICE_MS = 1_500;

/**
 * How long a resumed session gets to grow a tmux pane before the TUI stops
 * waiting and simply selects its row. Generous: `POST /interactive` spawns the
 * CLI, and a cold claude start is seconds, not milliseconds.
 */
const RESUME_PANE_TIMEOUT_MS = 8_000;
const RESUME_PANE_POLL_MS = 250;
/** History rows are labelled by their whole opening prompt; the notice shows a slice of it. */
const RESUME_NOTICE_WIDTH = 48;
/** Approval ids remembered for the bell before the set is rebuilt from what is pending. */
const SEEN_APPROVAL_CAP = 500;

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
/** DECSET 2026: terminals that know it show the frame atomically, the rest ignore it. */
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
/** One BEL when a prompt starts waiting on a human, and never for a repaint. */
const BELL = '\x07';

// ─────────────────────────────────────────────────────────────────────────────
// Attach planning (pure)
// ─────────────────────────────────────────────────────────────────────────────

export type TuiAttachRefusal = 'no-mux-name' | 'nested-foreign-socket';

export type TuiAttachPlan =
  | { kind: 'attach'; file: string; args: string[] }
  | { kind: 'switch'; file: string; args: string[] }
  | { kind: 'refuse'; reason: TuiAttachRefusal; message: string };

export interface TuiAttachContext {
  /** This instance's tmux socket name (`-L`). */
  socket: string;
  /** `$TMUX` as tmux sets it inside a pane: `<socket path>,<pid>,<session index>`. */
  tmux?: string;
}

/**
 * The socket NAME behind a `$TMUX` value, or null when we are not inside tmux.
 * tmux itself splits the variable on commas, so the path can be taken as
 * everything before the first one; `-L <name>` sockets live in one directory
 * per user, which makes the basename the name we compare against.
 */
export function tmuxSocketFromEnv(tmux: string | undefined): string | null {
  const raw = (tmux ?? '').trim();
  if (!raw) return null;
  const path = raw.split(',')[0];
  const name = path.split('/').filter(Boolean).pop();
  return name ?? null;
}

/**
 * How to reach a session's pane from where we are standing.
 *
 * Nesting is the case worth spelling out: inside tmux on a FOREIGN socket an
 * attach would either be refused by tmux or produce a terminal inside a
 * terminal whose prefix keys collide, so the TUI explains the situation instead
 * of trying.
 */
export function planAttach(muxName: string | undefined, context: TuiAttachContext): TuiAttachPlan {
  const name = (muxName ?? '').trim();
  if (!name) {
    return {
      kind: 'refuse',
      reason: 'no-mux-name',
      message: 'that session has no tmux pane to attach to (it is history, or it runs on a direct PTY)',
    };
  }
  const inside = tmuxSocketFromEnv(context.tmux);
  if (inside === null) {
    return {
      kind: 'attach',
      file: 'tmux',
      args: ['-L', context.socket, 'attach-session', '-t', name],
    };
  }
  if (inside === context.socket) {
    return { kind: 'switch', file: 'tmux', args: ['-L', context.socket, 'switch-client', '-t', name] };
  }
  return {
    kind: 'refuse',
    reason: 'nested-foreign-socket',
    message:
      `this terminal is already inside tmux on socket "${inside}", and Codeman's sessions live on "${context.socket}". ` +
      'Detach first (Ctrl+B D), then run codeman tui again.',
  };
}

/**
 * tmux's prefix key as a human reads it: `C-b` → `Ctrl+B`, `M-a` → `Alt+A`.
 *
 * Never hardcoded: the socket reads the user's `~/.tmux.conf`, so a config with
 * `set -g prefix C-a` makes every "press Ctrl+B" instruction a lie, and the one
 * instruction that matters here is how to get back OUT of an attach.
 */
export function formatPrefixKey(prefix: string | undefined): string {
  const raw = (prefix ?? '').trim();
  if (!raw) return 'Ctrl+B';
  const ctrl = /^C-(.+)$/.exec(raw);
  if (ctrl) return `Ctrl+${ctrl[1].toUpperCase()}`;
  const meta = /^M-(.+)$/.exec(raw);
  if (meta) return `Alt+${meta[1].toUpperCase()}`;
  return raw;
}

/** tmux's stock `detach-client` binding, used when `list-keys` cannot be read. */
export const DEFAULT_DETACH_KEY = 'd';

/**
 * The ONE key that leaves an attach, bound in tmux's prefix-less `root` table.
 *
 * ⚠️ Everything else here is a fallback. tmux's native way out is a chord typed
 * in a particular order — press the prefix, LET GO of the modifier, then a
 * letter — and three rounds of beta testing died on it: first the bar named the
 * wrong letter, then the right letter failed because the modifier was held.
 * The instruction itself was the problem ("release Ctrl and THEN d" is, in the
 * tester's words, very unclear), so the way out stopped being a chord.
 *
 * F1 because it is a single keystroke with no modifier to hold or release, it
 * sits next to Esc where a hand reaching to back out already goes, and no CLI
 * that runs in these panes wants it: claude, codex, a shell and vim all leave
 * it alone, and tmux ships an EMPTY root table apart from mouse bindings, so
 * claiming it shadows nothing.
 */
export const ONE_KEY_DETACH = 'F1';

/**
 * The key a user produces when they DON'T let go of Ctrl: `d` becomes `C-d`.
 *
 * ⚠️ This is the single most reported way the way-out fails. "Ctrl+B then d"
 * gets typed as one held chord, the terminal sends 0x02 then 0x04, and tmux
 * leaves `C-d` unbound in the prefix table, so absolutely nothing happens and
 * the user concludes the app is frozen (measured on the beta: three separate
 * reports, and both variants verified inert against a live pane).
 *
 * Null when there is no sensible alias: a key that is already a chord, or not a
 * single letter, has no "held Ctrl" form worth claiming.
 */
export function heldCtrlAlias(key: string): string | null {
  const trimmed = (key ?? '').trim();
  if (!/^[A-Za-z]$/.test(trimmed)) return null;
  return `C-${trimmed.toLowerCase()}`;
}

/**
 * The chord that ends an attach: the prefix, then the key bound to
 * `detach-client`.
 *
 * ⚠️ Case is load-bearing here and this shipped wrong once. tmux binds
 * LOWERCASE `d` to `detach-client` and CAPITAL `D` to `choose-client`, so a bar
 * advertising `Ctrl+B D` opened a client chooser and nothing detached (reported
 * from the beta: the way out was on screen and still did not work). The key is
 * therefore READ from tmux exactly like the prefix already is, and never passed
 * through `formatPrefixKey`, which uppercases.
 */
export function detachChord(prefix?: string, key?: string): string {
  return `${formatPrefixKey(prefix)} then ${key || DEFAULT_DETACH_KEY}`;
}

/**
 * The chord an attach advertises when it could not claim the one-key way out.
 *
 * With no key bound to `detach-client` in the prefix table there is no stock
 * `d` to name: Codeman keeps only `send-prefix` there (src/tmux-prefix-table.ts),
 * so the held-Ctrl alias the attach claimed is the chord that works.
 */
export function fallbackDetachChord(prefix?: string, detachKey?: string, heldAlias?: string): string {
  if (!detachKey && heldAlias) return detachChord(prefix, formatPrefixKey(heldAlias));
  return detachChord(prefix, detachKey);
}

/** `#` opens `#[…]`/`#{…}` in a tmux format, so a name carrying one must double it. */
function escapeTmuxFormat(value: string): string {
  return value.replace(/#/g, '##');
}

/**
 * The status line an attached session wears, as tmux option → value.
 *
 * Codeman turns the status bar OFF on every pane it owns (tmux-manager.ts): the
 * web UI carries that information around the terminal instead. A terminal
 * attach has no such frame, so the way out is invisible, and "how do I get out
 * of this?" is answered by exiting the agent (measured: a tester left a dead
 * pane behind on the first try). The bar exists for the length of the attach
 * and is put back exactly as it was on detach.
 *
 * ⚠️ `status-style` is set EXPLICITLY and is not optional. Styling only
 * `status-format[0]` leaves tmux's stock `status-style` (`bg=green,fg=black`)
 * underneath it, which paints a full-width bright green slab across the bottom
 * of the pane, `#[reverse]` on top of it included (reported from the beta as
 * "a big green line"). `bg=default,fg=default` lets the bar sit on the
 * terminal's own background so it reads as a hint line rather than a banner,
 * and the chord alone carries emphasis.
 */
export function buildAttachBanner(options: {
  prefix?: string;
  label?: string;
  detachKey?: string;
  /** The held-Ctrl form, when the attach managed to claim it. */
  heldAlias?: string;
  /** The prefix-less key, when the attach managed to claim it. Preferred over every chord. */
  oneKey?: string;
  /** The other sessions, drawn as a strip so they stay visible from inside a pane. */
  tabs?: readonly TuiAttachTab[];
  /** The attaching terminal's width, so the strip can be kept clear of the hint. */
  cols?: number;
  /** Alt+1..9 really switch sessions, so the bar may say so. */
  switchKeys?: boolean;
}): Record<string, string> {
  const chord = escapeTmuxFormat(fallbackDetachChord(options.prefix, options.detachKey, options.heldAlias));
  // Named on the bar because it is what people actually type: keeping Ctrl held
  // is the common way to press this, and the bar has to say that it works.
  const held = options.heldAlias && options.detachKey ? escapeTmuxFormat(formatPrefixKey(options.heldAlias)) : '';
  const alias = held ? ` (or ${held})` : '';
  const label = escapeTmuxFormat(truncateLabel((options.label ?? '').trim(), ATTACH_BANNER_LABEL_MAX));
  // ONE option, not `status-left`/`status-right`/`status-style`: `status-format[0]`
  // owns the whole line, which is what removes tmux's window list (`0:bash*`)
  // from the middle of it. The window-status options that would otherwise hide
  // it are WINDOW options, so `set-option -t <session>` cannot even reach them.
  // The hint is measured, not estimated, and the strip is given whatever is
  // left. tmux truncates a status line that overflows, and what it drops is the
  // RIGHT-aligned segment — which is the hint, the one thing on the bar a user
  // cannot do without. Every width tested lost it before this budget existed.
  // ⚠️ The switch hint appears only when the keys were actually claimed, the
  // same rule the way-out key follows. A bar naming a key that does nothing is
  // the bug this whole series started with.
  const switchHint = options.switchKeys ? 'alt+1-9 switch · ' : '';
  const hint = options.oneKey
    ? ` ${switchHint}${options.oneKey} ${ATTACH_BANNER_MARKER} `
    : ` ${switchHint}${chord}${alias} ${ATTACH_BANNER_MARKER} `;
  const budget = Math.max(0, (options.cols ?? Number.POSITIVE_INFINITY) - hint.length - 1);
  // The strip names the session it highlights, so the standalone label is only
  // a fallback for when there is no strip to draw (degraded mode has no list).
  const strip = buildAttachTabs(options.tabs ?? [], 6, budget);
  const left = strip || (label ? ` ${label} ` : '');
  return {
    status: 'on',
    'status-style': 'bg=default,fg=default',
    // At the TOP, where the web UI keeps its tabs and where a strip of sessions
    // is read as a strip of sessions rather than as a footer.
    'status-position': 'top',
    // One key when we have one, the chord only as a fallback. The bar is the
    // ONLY instruction a user gets during an attach, so it names the simplest
    // thing that is known to work, never a menu of ways.
    'status-format[0]': options.oneKey
      ? `#[align=left]${left}#[align=right] ${switchHint}#[bold]${escapeTmuxFormat(options.oneKey)}#[nobold] ${ATTACH_BANNER_MARKER} #[default]`
      : `#[align=left]${left}#[align=right] ${switchHint}#[bold]${chord}#[nobold]${alias} ${ATTACH_BANNER_MARKER} #[default]`,
  };
}

/** Long enough for a session name, short enough to survive a narrow terminal. */
const ATTACH_BANNER_LABEL_MAX = 28;

/** One session as the attach bar draws it. */
export interface TuiAttachTab {
  /** The number that selects it on the dashboard, so the bar and the list agree. */
  index: number;
  label: string;
  active: boolean;
  /** tmux session to switch to when its number is pressed inside a pane. */
  muxName?: string;
}

/** Per-tab label cap. Eight of these plus separators still fit an 80-column terminal. */
const ATTACH_TAB_LABEL_MAX = 12;

/**
 * The session strip the attach bar carries, so the other sessions stay visible
 * from inside a pane instead of the dashboard vanishing the moment you enter
 * one.
 *
 * A WINDOW around the active tab rather than the whole list: the bar is one
 * line shared with the way-out hint, and a strip that overflowed would push
 * that hint off the end, which is the one thing on the bar that must never be
 * lost. Ellipses mark what is not shown, so a truncated strip reads as
 * truncated rather than as the whole list.
 */
export function buildAttachTabs(tabs: readonly TuiAttachTab[], maxTabs = 6, budget = Number.POSITIVE_INFINITY): string {
  if (tabs.length === 0) return '';
  const active = Math.max(
    0,
    tabs.findIndex((tab) => tab.active)
  );
  let start = Math.max(0, Math.min(active - Math.floor(maxTabs / 2), tabs.length - maxTabs));
  if (start < 0) start = 0;
  const shown = tabs.slice(start, start + maxTabs);
  const shownLabels = shown.map((tab) => truncateLabel(tab.label, ATTACH_TAB_LABEL_MAX));
  const parts = shown.map((tab, i) => {
    const label = shownLabels[i];
    const text = escapeTmuxFormat(`${tab.index} ${label}`);
    // The active tab is inverted rather than bracketed: brackets cost two
    // columns per tab and read as punctuation next to the session names.
    return tab.active ? `#[reverse] ${text} #[noreverse]` : ` ${text} `;
  });
  // Drop tabs from the far end until the strip fits the space the hint leaves.
  // ⚠️ Measured on the VISIBLE text, not the format string: `#[reverse]` and
  // friends cost zero columns, and counting them made a strip that "fitted"
  // truncate the hint on a real terminal at every width tested.
  const visible = (index: number): number => shownLabels[index].length + String(shown[index].index).length + 3;
  let width = shown.reduce((total, _tab, index) => total + visible(index), 0);
  let last = shown.length;
  while (last > 1 && width + 2 > budget) {
    last -= 1;
    width -= visible(last);
  }
  const head = start > 0 ? '…' : '';
  const tail = start + last < tabs.length ? '…' : '';
  return `${head}${parts.slice(0, last).join('')}${tail}`;
}

/**
 * The name a newly started session gets: `w<n>-<case>`, the same convention the
 * web UI uses, with `n` one past the highest already in use.
 *
 * A session created with no name at all is not merely unlabelled: rowLabel()
 * falls back to the transcript's first line, and a session that has not been
 * prompted yet gets named after whatever its CLI printed while starting up.
 */
export function nextSessionName(caseName: string, existing: readonly string[]): string {
  let highest = 0;
  for (const name of existing) {
    const match = /^w(\d+)-/.exec((name ?? '').trim());
    const index = match ? Number.parseInt(match[1] ?? '', 10) : Number.NaN;
    if (Number.isSafeInteger(index) && index > highest) highest = index;
  }
  return `w${highest + 1}-${caseName}`;
}

/**
 * What pressing Enter on a RECENT row does, decided from the row alone.
 *
 * Resuming is Claude Code's `--resume`, so it is claude-only, needs the
 * directory the conversation ran in, and needs the CONVERSATION's id
 * (`claudeSessionId`) rather than the Codeman row's: a `/clear`-respawned or
 * re-attached session carries a different one, and the server's regex only
 * accepts the hex-and-dashes shape a real transcript id has.
 */
export type TuiResumePlan =
  | { kind: 'resume'; workingDir: string; resumeSessionId: string; sessionName?: string }
  | { kind: 'refuse'; message: string };

/** Ids the server's `resumeSessionId` accepts (`/^[a-f0-9-]+$/`), checked before the round trip. */
const RESUME_ID_PATTERN = /^[a-f0-9-]+$/;

export function planResume(session: TuiSessionRow): TuiResumePlan {
  const workingDir = (session.workingDir ?? '').trim();
  if (!workingDir) {
    return { kind: 'refuse', message: 'that row has no working directory recorded, so there is nothing to resume in' };
  }
  const mode = (session.mode ?? 'claude').trim();
  if (mode !== 'claude') {
    return {
      kind: 'refuse',
      message: `resuming is a Claude Code feature; this row is a ${mode} session, so start a new one with n`,
    };
  }
  const resumeSessionId = (session.claudeSessionId ?? session.sessionId ?? '').trim();
  if (!RESUME_ID_PATTERN.test(resumeSessionId)) {
    return { kind: 'refuse', message: 'that row carries no Claude conversation id, so it cannot be resumed' };
  }
  const sessionName = (session.name ?? '').trim();
  return {
    kind: 'resume',
    workingDir,
    resumeSessionId,
    // Kept rather than synthesized: a resumed session losing its name is how
    // the web UI's COD-143 bug read.
    ...(sessionName ? { sessionName } : {}),
  };
}

/** A handoff to tmux, set up so it can be left and put back. */
export interface TuiAttachHandoff {
  /** The chord that ends it, in the local tmux's own prefix. */
  chord: string;
  /** Undo everything the handoff changed. Idempotent enough to call once per attach. */
  restore(): Promise<void>;
}

/**
 * Prepare a tmux window for a human terminal: let it follow the attaching
 * client's shape, and give it a status bar naming the way out. Both halves are
 * best-effort and both are put back by `restore()`, so a session that was
 * `window-size manual` with no status bar (what Codeman creates) is exactly
 * that again after the detach.
 */
export async function beginAttachHandoff(
  client: TuiClient,
  muxName: string,
  label: string,
  tabs: readonly TuiAttachTab[] = [],
  cols?: number,
  rows?: number
): Promise<TuiAttachHandoff> {
  const prefix = (await client.readPrefixKey(muxName)) ?? undefined;
  // Read, not assumed: see detachChord() for the `d` vs `D` mix-up this closes.
  const detachKey = (await client.readDetachKey()) ?? undefined;
  // Codeman pins its windows to the size the BROWSER dictates (`window-size
  // manual` + `resize-window`, tmux-manager.ts), so a terminal of any other
  // shape attaches to a window that does not fill it and tmux pads the gap with
  // dots. `latest` (not a one-off resize to our size) is also what makes a
  // terminal resized MID-attach follow along: tmux recomputes on every SIGWINCH
  // and the caller is blocked in `spawnSync`.
  // Claimed only when tmux has nothing there: an attach must never shadow a
  // binding the user put in their own config.
  const alias = heldCtrlAlias(detachKey ?? DEFAULT_DETACH_KEY);
  const claimed = alias && (await client.readPrefixBinding(alias)) === null ? await client.bindDetachKey(alias) : false;
  // The one-key way out, in the prefix-less table.
  //
  // ⚠️ "Already bound to detach-client" counts as CLAIMED, not as taken. An
  // attach whose TUI was killed leaks the binding, and treating that leak as
  // someone else's binding made every later attach fall back to advertising
  // the tmux chord — so the bar stopped saying F1 while F1 still worked, which
  // is the worst of both. Anything else there is genuinely the user's and is
  // left alone.
  const existing = await client.readPrefixBinding(ONE_KEY_DETACH, 'root');
  const oneKey =
    existing === 'detach-client'
      ? true
      : existing === null
        ? await client.bindDetachKey(ONE_KEY_DETACH, 'root')
        : false;
  // Alt+1..9 switch sessions from inside the pane, so the strip on the bar is
  // usable rather than decorative. Only the first nine, only sessions that
  // really have a pane, and only keys tmux reports as free — the same rule the
  // way-out key follows, so a binding of the user's own is never shadowed.
  const switchKeys: string[] = [];
  for (const tab of tabs.slice(0, 9)) {
    if (!tab.muxName) continue;
    const key = `M-${tab.index}`;
    const bound = await client.readPrefixBinding(key, 'root');
    if (bound !== null && !bound.startsWith('switch-client')) continue;
    if (await client.bindSwitchKey(key, tab.muxName)) switchKeys.push(key);
  }
  const bannerFor = (activeMux: string, ownLabel: string): Record<string, string> =>
    buildAttachBanner({
      ...(prefix ? { prefix } : {}),
      ...(detachKey ? { detachKey } : {}),
      ...(claimed && alias ? { heldAlias: alias } : {}),
      ...(oneKey ? { oneKey: ONE_KEY_DETACH } : {}),
      ...(cols ? { cols } : {}),
      ...(switchKeys.length > 0 ? { switchKeys: true } : {}),
      label: ownLabel,
      tabs: tabs.map((tab) => ({ ...tab, active: tab.muxName === activeMux })),
    });

  // ⚠️ The bar goes on EVERY session the strip can switch to, not just the one
  // being attached. `switch-client` moves this client to another session, and
  // that session draws its OWN status line: with the bar only on the first one,
  // pressing Alt+2 landed the user in a pane with no strip and, worse, no way
  // out on screen. Each copy highlights its own tab, so the strip tracks where
  // you actually are.
  const banner = bannerFor(muxName, label);
  const dressed: Array<{ muxName: string; options: TuiSessionOptions }> = [];
  const resized: Array<{ muxName: string; sizing: TuiWindowSizing }> = [];
  const targets = new Map<string, string>([[muxName, label]]);
  for (const tab of tabs.slice(0, 9)) {
    if (tab.muxName && !targets.has(tab.muxName)) targets.set(tab.muxName, tab.label);
  }
  for (const [target, targetLabel] of targets) {
    const snapshot = await client.readSessionOptions(target, Object.keys(banner));
    if (snapshot) dressed.push({ muxName: target, options: snapshot });
    await client.applySessionOptions(target, bannerFor(target, targetLabel));
    // ⚠️ Sizing for EVERY switchable session, not just the one being attached.
    // Codeman pins each window `window-size manual` at the BROWSER's size, so a
    // session switched into from inside a pane stays pinned and tmux pads the
    // gap with dots — the pane filled half the terminal and the rest was a dot
    // grid (reported from the beta, with a screenshot, after Alt+N switching
    // shipped). `latest` makes each window follow whichever client is looking
    // at it, which is the same reason the attached one gets it.
    const sizing = await client.readWindowSizing(target);
    if (sizing) resized.push({ muxName: target, sizing });
    // Pre-size to this terminal so a switch has nothing left to resize, then
    // let the session we are actually opening follow the terminal live.
    if (cols && rows && rows > 1) await client.presizeWindow(target, cols, rows - 1);
    if (target === muxName) await client.followAttachingClient(target);
  }
  return {
    chord: oneKey ? ONE_KEY_DETACH : fallbackDetachChord(prefix, detachKey, claimed && alias ? alias : undefined),
    async restore(): Promise<void> {
      for (const key of switchKeys) await client.unbindSwitchKey(key);
      if (oneKey) await client.unbindDetachKey(ONE_KEY_DETACH, 'root');
      if (claimed && alias) await client.unbindDetachKey(alias);
      // Options first, then the size: dropping the status bar gives its row
      // back to the pane, and the resize is what re-pins the browser's
      // authority over the window.
      for (const entry of dressed) await client.restoreSessionOptions(entry.muxName, entry.options);
      for (const entry of resized) await client.restoreWindowSizing(entry.muxName, entry.sizing);
    },
  };
}

/**
 * Is this the session the TUI itself runs in? Codeman exports
 * `CODEMAN_SESSION_ID` into every managed pane, and killing that one would take
 * the TUI down with it. Ids reach agents truncated, so either side may be the
 * prefix; anything shorter than 8 characters is not identification.
 */
export function isSelfSession(sessionId: string, env: { CODEMAN_SESSION_ID?: string } = {}): boolean {
  const self = (env.CODEMAN_SESSION_ID ?? '').trim();
  if (self.length < 8 || sessionId.length < 8) return false;
  return sessionId.startsWith(self) || self.startsWith(sessionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Kill confirmation (pure)
// ─────────────────────────────────────────────────────────────────────────────

export type TuiConfirmStep = { kind: 'confirm' } | { kind: 'cancel' } | { kind: 'ignore' };

/**
 * One keystroke of the kill confirmation: `y` kills, anything else does not.
 *
 * ⚠️ It used to demand the session's NAME typed out in full. That is the right
 * ceremony for deleting a production database and the wrong one for closing a
 * pane you are looking at: the beta tester's verdict was "thats stupid, just
 * make me type Y to confirm". Kill is already two deliberate keystrokes (`x`
 * then `y`) on a row the user selected, and the session's work lives in its
 * transcript, which a kill does not touch.
 *
 * Everything that is NOT `y` cancels rather than being ignored, so a stray key
 * closes the dialog instead of leaving a live kill prompt waiting for whatever
 * the user types next.
 */
export function confirmKillStep(_state: TuiConfirmState, event: TuiInputEvent): TuiConfirmStep {
  switch (event.type) {
    case 'char':
      return event.value === 'y' || event.value === 'Y' ? { kind: 'confirm' } : { kind: 'cancel' };
    case 'enter':
      // Enter alone is NOT a confirmation: it is the key most likely to be
      // pressed by reflex, and this is the one dialog that destroys something.
      return { kind: 'cancel' };
    case 'escape':
      return { kind: 'cancel' };
    case 'ctrl':
      return event.key === 'c' ? { kind: 'cancel' } : { kind: 'ignore' };
    default:
      return { kind: 'ignore' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which approval keys the selected row makes live. `menu` is a dialog on
 * screen (y/n/digits answer it); `idle` is a prompt with no dialog, where the
 * only reply path is the composer.
 */
export type TuiApprovalKeys = 'menu' | 'idle' | null;

export interface TuiKeymapContext {
  /** False in degraded mode, where the only verb that works is attach. */
  server: boolean;
  approval?: TuiApprovalKeys;
  /** How the last attach said to leave it. Defaults to F1, the key an attach claims. */
  detach?: string;
  /** A dead-row card is offering `r` to resume, so the footer has to say so. */
  resumeOffer?: boolean;
}

/**
 * The footer keys for a mode. This is the honest inventory of what works RIGHT
 * NOW, not a fixed list: `n` starts a session normally and denies a dialog when
 * one is on the selected row, and a footer that advertised both at once would
 * be wrong half the time.
 */
export function footerKeysFor(mode: TuiUiMode, glyphs: TuiGlyphSet, context: TuiKeymapContext): string[] {
  switch (mode) {
    case 'help':
      return ['esc close'];
    case 'confirm-kill':
      return ['y kill', 'any other key cancels'];
    case 'message':
      return context.resumeOffer ? ['r resume', 'esc dismiss'] : ['esc dismiss'];
    case 'new-session':
      return [`${glyphs.updown} select`, `${glyphs.enter} choose`, 'type to filter', 'esc cancel'];
    case 'prompt':
      return [`${glyphs.enter} send`, 'esc cancel'];
    case 'search':
      return [`${glyphs.updown} results`, `${glyphs.enter} open`, 'type to search', 'esc close'];
    case 'digest':
      return ['j/k scroll', 'esc close'];
    case 'list': {
      if (!context.server) {
        return [`${glyphs.updown} select`, `${glyphs.enter} attach`, '1-9 switch', '? help', 'q quit'];
      }
      const keys = [`${glyphs.updown} select`, `${glyphs.enter} attach`];
      if (context.approval === 'menu') keys.push('y approve', 'n deny', '1-9 option');
      else keys.push('1-9 switch');
      keys.push(context.approval === 'idle' ? 'p reply' : 'p prompt');
      if (context.approval !== 'menu') keys.push('n new');
      keys.push('x kill', '/ search', 'g digest', '? help', 'q quit');
      return keys;
    }
  }
}

/**
 * The help overlay's rows, for the same reason `footerKeysFor` exists: a help
 * screen listing verbs the build does not implement is worse than no help.
 */
export function helpKeysFor(glyphs: TuiGlyphSet, context: TuiKeymapContext): Array<[string, string]> {
  const keys: Array<[string, string]> = [
    [`${glyphs.updown} / j k`, 'select'],
    [glyphs.enter, 'attach — on a RECENT row, resume that conversation'],
    ['1-9', 'switch to that session'],
    // The web UI's tab switching, as close as a terminal can carry it: Alt+N
    // matches exactly, while Alt+[ / Alt+] cannot be transmitted (ESC+[ IS the
    // CSI introducer) so the brackets do that job unmodified.
    ['[ / ]', 'previous / next session'],
    ['tab', 'next session'],
    // The one key that is not the TUI's: an attach hands the terminal to tmux,
    // and leaving it is the question every first attach asks.
    [context.detach ?? ONE_KEY_DETACH, 'detach from an attached session, back to here'],
  ];
  if (context.server) {
    keys.push(
      ['y / n', 'approve or deny the selected dialog'],
      ['1-9', 'answer with that option, when a dialog is on screen'],
      ['p', 'send one line to the selected session'],
      ['/', 'search sessions, events and files'],
      ['g', 'away digest'],
      ['n', 'new session'],
      ['x', 'kill (y to confirm)']
    );
  }
  keys.push(['?', 'this help'], ['esc', 'close an overlay'], ['q', 'quit']);
  return keys;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview policy (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface TuiPreviewContext {
  mode: TuiUiMode;
  /** Narrow layouts have no preview pane at all, so a poll would be wasted. */
  narrow: boolean;
  connection: TuiConnectionStatus;
  row: TuiRow | null;
}

/**
 * Is the selected row worth polling for a tail? Only a live session that is on
 * screen with the list in focus qualifies: a history row has no buffer to read,
 * and an overlay hides the pane it would repaint.
 */
export function shouldFetchPreview(context: TuiPreviewContext): boolean {
  if (context.mode !== 'list' || context.narrow) return false;
  if (context.connection === 'degraded' || context.connection === 'down') return false;
  const row = context.row;
  return row !== null && row.group !== 'recent';
}

/**
 * The static line a pane shows instead of a tail, or null when a tail is on its
 * way. Says what is true rather than "loading", which would never resolve.
 */
export function previewNoteFor(row: TuiRow | null, connection: TuiConnectionStatus): string | null {
  if (!row) return null;
  if (connection === 'degraded' || connection === 'down') return null;
  if (row.group === 'recent') return 'this session is not running: no live output to show';
  return null;
}

/**
 * Delay before the next AMBIENT refetch: the debounce, unless that would land
 * inside the floor since the last one started, in which case it waits out the
 * rest of the floor. Measured start-to-start, so a slow scan cannot be followed
 * immediately by another one.
 *
 * `lastRefreshAt` of 0 means "never refreshed", which the arithmetic handles on
 * its own: the gap is enormous, so the first refetch pays the debounce only.
 */
export function resyncDelayMs(
  now: number,
  lastRefreshAt: number,
  debounceMs = RESYNC_DEBOUNCE_MS,
  minIntervalMs = RESYNC_MIN_INTERVAL_MS
): number {
  return Math.max(debounceMs, minIntervalMs - (now - lastRefreshAt));
}

/**
 * How long to wait before re-reading the selected session's tail, given how
 * many consecutive reads came back identical.
 *
 * Doubling from one second to a five-second ceiling, and ANY change resets the
 * count, so a pane that is printing is read every second while a pane sitting
 * at its composer costs one read every five. The counter is also reset when the
 * selection moves and when this dashboard sends input, so the read that should
 * show a reply is never the backed-off one.
 */
export function previewIntervalMs(
  unchangedReads: number,
  baseMs = PREVIEW_INTERVAL_MS,
  maxMs = PREVIEW_MAX_INTERVAL_MS
): number {
  const steps = Math.min(Math.max(0, Math.trunc(unchangedReads)), 10);
  return Math.min(baseMs * 2 ** steps, maxMs);
}

/**
 * Would painting `next` change anything? The preview polls on a timer, and a
 * quiet session returns the same bytes every time; comparing here is what keeps
 * that poll from bumping the model's revision and repainting the frame, and it
 * is also what drives the poll's own backoff.
 */
export function samePreview(previous: TuiPreview | null, next: TuiPreview | null): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  if (previous.sessionId !== next.sessionId) return false;
  if (previous.error !== next.error || previous.note !== next.note) return false;
  if (previous.lines.length !== next.lines.length) return false;
  return previous.lines.every((line, i) => line === next.lines[i]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Repaint policy (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a frame depends on, cheap enough to compare on every event. */
export interface TuiFrameKey {
  revision: number;
  cols: number;
  rows: number;
  tick: number;
}

export function sameFrame(previous: TuiFrameKey | null, next: TuiFrameKey): boolean {
  return (
    previous !== null &&
    previous.revision === next.revision &&
    previous.cols === next.cols &&
    previous.rows === next.rows &&
    previous.tick === next.tick
  );
}

/** Only a WORKING row animates, so only a WORKING row justifies a tick timer. */
export function shouldAnimate(rows: readonly TuiRow[]): boolean {
  return rows.some((row) => row.state === 'working');
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * tmux sessions as dashboard rows, for when no server answered.
 *
 * They are tagged `live` deliberately: a running pane is the only liveness
 * evidence that exists without a server, and the alternative (no `live` source)
 * would classify every attachable session as history and file it under RECENT.
 * With no classification running they land in IDLE, which is honest: unknown
 * state, still attachable.
 */
export function tmuxRowsToSessions(sessions: readonly TuiTmuxSession[]): TuiSessionRow[] {
  return sessions.map((session) => ({
    sessionId: session.sessionId ?? session.muxName,
    muxName: session.muxName,
    sources: ['live', 'mux'],
    ...(session.name ? { name: session.name } : {}),
    ...(session.mode ? { mode: session.mode } : {}),
    ...(session.workingDir ? { workingDir: session.workingDir } : {}),
    ...(session.createdAt ? { createdAt: session.createdAt, lastActivityAt: session.createdAt } : {}),
  }));
}

/**
 * Stamp each row with the tmux session that backs it. The mux name carries only
 * the first 8 characters of the session id (`codeman-<prefix>`), so the join is
 * by prefix; a row that matches nothing keeps no mux name and cannot be
 * attached, which is exactly what the attach path then reports.
 */
export function applyMuxNames(sessions: readonly TuiSessionRow[], tmux: readonly TuiTmuxSession[]): TuiSessionRow[] {
  if (tmux.length === 0) return sessions.map((session) => ({ ...session }));
  return sessions.map((session) => {
    const match = tmux.find(
      (entry) => entry.sessionId === session.sessionId || session.sessionId.startsWith(entry.sessionIdPrefix)
    );
    return match ? { ...session, muxName: match.muxName } : { ...session };
  });
}

/**
 * Fold the live-only counters onto the rows the unified list produced: the
 * pane's last Enter (which dates a running turn and orders the WORKING group)
 * and the token totals the wide layout shows.
 *
 * A ZERO is treated as "unknown" rather than merged, and that is the whole
 * reason this is not a spread: `stateSince()` reads `lastSubmitAt ?? createdAt`,
 * and 0 is not nullish, so merging a 0 would date every never-submitted session
 * to the epoch and sort it as the oldest turn on the list. The join is on the
 * FULL id, since both sides come from the same server.
 */
export function applyLiveMetrics(
  sessions: readonly TuiSessionRow[],
  metrics: readonly TuiLiveSessionMetrics[]
): TuiSessionRow[] {
  if (metrics.length === 0) return sessions.map((session) => ({ ...session }));
  const byId = new Map(metrics.map((entry) => [entry.sessionId, entry]));
  return sessions.map((session) => {
    const live = byId.get(session.sessionId);
    if (!live) return { ...session };
    return {
      ...session,
      ...(live.lastSubmitAt ? { lastSubmitAt: live.lastSubmitAt } : {}),
      ...(live.inputTokens ? { inputTokens: live.inputTokens } : {}),
      ...(live.outputTokens ? { outputTokens: live.outputTokens } : {}),
    };
  });
}

const STATE_TONE: Record<TuiSessionState, Tone> = {
  'blocked-permission': 'err',
  'blocked-question': 'err',
  waiting: 'warn',
  working: 'ok',
  idle: 'idle',
  recent: 'idle',
};

export interface TuiListLine {
  /** 1-based position, the same number `codeman tui <n>` takes. */
  index: number;
  state: TuiSessionState;
  label: string;
  workingDir: string;
}

/**
 * Label column cap. History rows are labelled by their opening prompt, and one
 * long prompt pads every other row of the table out to its width.
 */
const LIST_LABEL_WIDTH = 48;

function truncateLabel(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

/** `--list` rows, in the dashboard's own order so `<n>` and the TUI agree. */
export function buildListLines(rows: readonly TuiRow[], labelWidth = LIST_LABEL_WIDTH): TuiListLine[] {
  return rows.map((row, i) => ({
    index: i + 1,
    state: row.state,
    label: truncateLabel(rowLabel(row.session), labelWidth),
    workingDir: row.session.workingDir ?? '',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Session modes offered by the new-session picker
// ─────────────────────────────────────────────────────────────────────────────

type TuiRunMode = NonNullable<TuiQuickStartOptions['mode']>;

const MODE_ITEMS: ReadonlyArray<{ id: TuiRunMode; label: string; detail: string }> = [
  { id: 'claude', label: 'claude', detail: 'Claude Code' },
  { id: 'shell', label: 'shell', detail: 'plain shell' },
  { id: 'opencode', label: 'opencode', detail: 'OpenCode' },
  { id: 'codex', label: 'codex', detail: 'OpenAI Codex' },
  { id: 'gemini', label: 'gemini', detail: 'Google Gemini' },
  { id: 'antigravity', label: 'antigravity', detail: 'Google Antigravity' },
  { id: 'pi', label: 'pi', detail: 'pi.dev' },
  { id: 'grok', label: 'grok', detail: 'xAI Grok Build' },
  { id: 'deepseek', label: 'deepseek', detail: 'DeepSeek Harness (dsh)' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Terminal
// ─────────────────────────────────────────────────────────────────────────────

/** The slices of stdin/stdout the TUI uses; `process.stdin`/`stdout` satisfy both. */
export interface TuiStdin extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TuiStdout {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): unknown;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

/**
 * Alternate screen + raw mode, entered and left as one unit. `leave()` is
 * idempotent and safe to call from a signal handler, an exit hook and the
 * normal path in any order.
 */
class TerminalScreen {
  private entered = false;

  constructor(
    private readonly stdin: TuiStdin,
    private readonly stdout: TuiStdout,
    private readonly onResize: () => void
  ) {}

  get active(): boolean {
    return this.entered;
  }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.stdout.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);
    if (this.stdin.isTTY) this.stdin.setRawMode?.(true);
    this.stdin.resume();
    this.stdout.on('resize', this.onResize);
  }

  leave(): void {
    if (!this.entered) return;
    this.entered = false;
    this.stdout.off('resize', this.onResize);
    if (this.stdin.isTTY) this.stdin.setRawMode?.(false);
    this.stdin.pause();
    this.stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The app
// ─────────────────────────────────────────────────────────────────────────────

export interface TuiRunOptions {
  stdin?: TuiStdin;
  stdout?: TuiStdout;
  env?: NodeJS.ProcessEnv;
  /** Injected by tests; the default builds one from the environment. */
  client?: TuiClient;
  /** Overrides chalk's detection. Chalk owns it everywhere else (see cli-style). */
  color?: boolean;
}

interface PickerRuntime {
  stage: 'case' | 'mode';
  caseName?: string;
  /** Unfiltered items; the model holds the filtered view the renderer paints. */
  all: TuiPickerItem[];
}

class TuiApp {
  private readonly model: TuiModelStore = createTuiModel();
  private readonly parser: TuiKeyParser = createKeyParser();
  private readonly screen: TerminalScreen;
  private readonly stdin: TuiStdin;
  private readonly stdout: TuiStdout;
  private readonly env: NodeJS.ProcessEnv;
  private readonly client: TuiClient;
  private readonly color: boolean;
  private readonly glyphTier: TuiGlyphTier;
  private readonly glyphs: TuiGlyphSet;
  private readonly socket = resolveTmuxSocketName();
  /**
   * How to leave an attach. Read per attach (F1 may be the user's, a session
   * can override the prefix) and remembered for the help overlay; until the
   * first attach it names F1, what an attach claims unless the user's config
   * already holds it.
   */
  private detachChordLabel: string = ONE_KEY_DETACH;
  /** True for the length of one resume. The only thing standing between a resume and a loop. */
  private resuming = false;

  private stream: TuiEventStream | null = null;
  private tick = 0;
  private lastFrame: TuiFrameKey | null = null;
  private escTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private previewTimer: NodeJS.Timeout | null = null;
  private searchTimer: NodeJS.Timeout | null = null;
  private noticeTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private refreshQueued = false;
  /** When the last refresh STARTED, which is what `resyncDelayMs()` paces off. */
  private lastRefreshAt = 0;
  private picker: PickerRuntime | null = null;
  private pendingSelectId: string | null = null;
  /** Whose tail the preview is currently following; null when nothing is polled. */
  private previewSessionId: string | null = null;
  private previewFetching = false;
  /** Is the tail still worth re-reading? The chained timeout stops when it is not. */
  private previewFollowing = false;
  /** Consecutive tail reads that changed nothing; the poll's backoff counter. */
  private previewQuiet = 0;
  /** Bumped per search so a slow response cannot overwrite a newer query's results. */
  private searchSeq = 0;
  /** Approval ids the bell has already rung for. See `newApprovalIds`. */
  private readonly seenApprovals = new Set<string>();
  private exiting = false;
  private resolveExit: ((code: number) => void) | null = null;

  private readonly onData = (chunk: Buffer): void => this.feed(chunk);
  // A resize can cross the narrow breakpoint, where there is no preview pane to
  // poll for.
  private readonly onResize = (): void => {
    this.updatePreview();
    this.paint(true);
  };
  private readonly onProcessExit = (): void => this.screen.leave();
  private readonly onSignal = (): void => this.quit(0);
  private readonly onFatal = (error: unknown): void => {
    this.screen.leave();
    process.stderr.write(`codeman tui: ${getErrorMessage(error)}\n`);
    if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  };

  constructor(options: TuiRunOptions) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.env = options.env ?? process.env;
    this.client = options.client ?? new TuiClient();
    this.color = options.color ?? chalk.level > 0;
    this.glyphTier = detectGlyphTier(this.env);
    this.glyphs = glyphsFor(this.glyphTier);
    this.screen = new TerminalScreen(this.stdin, this.stdout, this.onResize);
  }

  async run(): Promise<number> {
    const server = await this.client.connect();
    if (server?.authRequired) {
      this.client.close();
      process.stderr.write(
        `${palette.err('The Codeman server rejected these credentials.')}\n` +
          `Set ${palette.info('CODEMAN_PASSWORD')} (and ${palette.info('CODEMAN_USERNAME')} if it is not "admin"), ` +
          'or put them in ~/.codeman/.env, then run codeman tui again.\n'
      );
      return 1;
    }

    if (server) {
      this.model.setConnection('connected');
      this.model.setHeader({
        ...(server.hostname ? { hostname: server.hostname } : {}),
        ...(server.instance ? { instance: server.instance } : {}),
        ...(server.version ? { version: server.version } : {}),
        ...(server.planUsage ? { planUsage: this.planUsageChip(server.planUsage) } : {}),
      });
    } else {
      this.model.setConnection('degraded');
      // No server to name the machine, and tmux is local by definition.
      this.model.setHeader({
        hostname: osHostname(),
        ...(CODEMAN_INSTANCE ? { instance: CODEMAN_INSTANCE } : {}),
      });
      this.startProbing();
    }

    this.installSafetyNets();
    this.stdin.on('data', this.onData);
    this.screen.enter();
    this.paint(true);

    await this.refresh();
    if (server) this.subscribe();

    // Fire and forget: a bar stranded by a previous run is cosmetic, so it must
    // never delay the first frame or fail a start.
    void this.client.clearLeakedAttachBanners().catch(() => undefined);

    return new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** The chip, punctuated with the glyph tier's own separator. */
  private planUsageChip(usage: TuiPlanUsage): string {
    return formatPlanUsage(usage, ` ${this.glyphs.separator} `);
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  private subscribe(): void {
    this.stream = this.client.subscribeEvents({
      onInit: (state) => {
        if (state.version) this.model.setHeader({ version: state.version });
        if (state.planUsage) this.model.setHeader({ planUsage: this.planUsageChip(state.planUsage) });
        this.paint();
      },
      onResync: () => this.scheduleRefresh(),
      // The bell and the card both ride the refetch this schedules: the event
      // carries the item, but the list has to be re-read anyway (an approval
      // changes which group its row is in), and one code path cannot double-ring.
      onApproval: () => this.scheduleRefresh(),
      onPlanUsage: (usage) => {
        this.model.setHeader({ planUsage: this.planUsageChip(usage) });
        this.paint();
      },
      onStatus: (status, detail) => {
        this.model.setConnection(status === 'connected' ? 'connected' : 'reconnecting');
        if (detail.recommendPolling) this.startPolling();
        else this.stopPolling();
        if (status === 'connected') this.scheduleRefresh();
        this.paint();
      },
    });
  }

  private scheduleRefresh(): void {
    if (this.resyncTimer) return;
    this.resyncTimer = setTimeout(
      () => {
        this.resyncTimer = null;
        void this.refresh();
      },
      resyncDelayMs(Date.now(), this.lastRefreshAt)
    );
  }

  /**
   * Re-read everything the dashboard shows. Overlapping calls collapse: a burst
   * of events must not queue a burst of round trips, and the last one has to
   * still run or the list would sit one change behind.
   *
   * A call that arrived while this one was in flight is handed back to
   * `scheduleRefresh()` rather than run on the spot. Recursing there instead
   * (which is what this did) paced the refetches at the endpoint's own latency
   * and chained one pending promise per iteration, so a busy machine kept the
   * server scanning transcripts continuously.
   */
  private async refresh(): Promise<void> {
    if (this.exiting) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    // Stamped at the START, so the floor is start-to-start and a direct call
    // (an action of the user's own) also pushes the next ambient one out.
    this.lastRefreshAt = Date.now();
    try {
      if (this.model.connection === 'degraded') await this.refreshDegraded();
      else await this.refreshConnected();
    } finally {
      this.refreshing = false;
    }
    if (this.refreshQueued && !this.exiting) {
      this.refreshQueued = false;
      this.scheduleRefresh();
    }
  }

  private async refreshConnected(): Promise<void> {
    try {
      const [sessions, approvals, tmux, metrics] = await Promise.all([
        this.client.fetchUnifiedSessions(UNIFIED_LIMIT),
        this.client.fetchApprovals().catch(() => []),
        this.client.enumerateTmuxSessions().catch(() => [] as TuiTmuxSession[]),
        // Best-effort like the other two: without it a running turn is dated by
        // its session's creation, which is worse than the list going stale.
        this.client.fetchLiveSessionMetrics().catch(() => [] as TuiLiveSessionMetrics[]),
      ]);
      this.model.replaceSessions(applyLiveMetrics(applyMuxNames(sessions, tmux), metrics));
      this.model.setApprovals(approvals);
      this.noteApprovals(approvals);
      if (this.pendingSelectId && this.model.select(this.pendingSelectId)) this.pendingSelectId = null;
      this.updatePreview();
      this.paint();
    } catch (error) {
      // A failed refresh is a connection symptom, not a reason to lose the list:
      // the rows on screen stay, the banner explains why they may be stale.
      this.model.setConnection('reconnecting');
      this.paint();
      if (this.env.CODEMAN_TUI_DEBUG) process.stderr.write(`refresh failed: ${getErrorMessage(error)}\n`);
    }
  }

  private async refreshDegraded(): Promise<void> {
    const tmux = await this.client.enumerateTmuxSessions().catch(() => [] as TuiTmuxSession[]);
    this.model.replaceSessions(tmuxRowsToSessions(tmux));
    // Nothing classifies states without a server, so a prompt that was pending
    // when it went down is no longer a fact we can stand behind, and a card
    // whose answer route is unreachable is worse than no card.
    this.model.setApprovals([]);
    this.updatePreview();
    this.paint();
  }

  /**
   * Ring once for prompts that were not pending a moment ago. Answered ids stay
   * in the set on purpose (the inbox restores a failed write under the SAME id),
   * so the bell cannot stutter on one dialog.
   */
  private noteApprovals(items: readonly ApprovalItem[]): void {
    const fresh = newApprovalIds(this.seenApprovals, items);
    if (fresh.length === 0) return;
    for (const id of fresh) this.seenApprovals.add(id);
    if (this.seenApprovals.size > SEEN_APPROVAL_CAP) {
      this.seenApprovals.clear();
      for (const item of items) this.seenApprovals.add(item.id);
    }
    this.stdout.write(BELL);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Degraded mode: re-probe so a server that comes up upgrades the TUI in place. */
  private startProbing(): void {
    if (this.probeTimer) return;
    this.probeTimer = setInterval(() => void this.probe(), REPROBE_INTERVAL_MS);
  }

  private async probe(): Promise<void> {
    if (this.exiting || this.model.connection !== 'degraded') return;
    const server = await this.client.connect().catch(() => null);
    if (!server || server.authRequired) {
      await this.refresh();
      return;
    }
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
    this.model.setConnection('connected');
    this.model.setHeader({
      ...(server.hostname ? { hostname: server.hostname } : {}),
      ...(server.instance ? { instance: server.instance } : {}),
      ...(server.version ? { version: server.version } : {}),
      ...(server.planUsage ? { planUsage: this.planUsageChip(server.planUsage) } : {}),
    });
    await this.refresh();
    this.subscribe();
  }

  // ── Preview ────────────────────────────────────────────────────────────────

  /**
   * Keep the preview pointed at the selected session: start polling when the
   * selection is a live row with the list in focus, stop when it is not, and
   * say why when there is nothing to poll.
   */
  private updatePreview(): void {
    const row = this.model.selectedSession();
    const sessionId = row?.session.sessionId ?? null;
    const changed = sessionId !== this.previewSessionId;
    this.previewSessionId = sessionId;

    const wanted = shouldFetchPreview({
      mode: this.model.mode,
      narrow: this.currentLayout().narrow,
      connection: this.model.connection,
      row,
    });

    if (!wanted) {
      this.stopPreview();
      const note = previewNoteFor(row, this.model.connection);
      if (row && note) this.applyPreview({ sessionId: row.session.sessionId, lines: [], note });
      else if (changed) this.applyPreview(null);
      return;
    }

    this.previewFollowing = true;
    if (changed) {
      // A different pane, so what the last one printed says nothing about how
      // fast this one needs reading.
      this.previewQuiet = 0;
      // Null rather than an empty tail: the renderer reads that as "loading",
      // while empty lines would claim the session has printed nothing.
      this.applyPreview(null);
      void this.fetchPreview();
    }
    this.armPreview();
  }

  /**
   * Arm the next tail read. A chained timeout rather than an interval, because
   * the delay depends on how long the pane has been quiet, and re-arming is the
   * LAST thing each read does so a slow response can never stack two in flight.
   */
  private armPreview(): void {
    if (this.previewTimer || !this.previewFollowing || this.exiting) return;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      void this.fetchPreview().finally(() => this.armPreview());
    }, previewIntervalMs(this.previewQuiet));
  }

  private stopPreview(): void {
    this.previewFollowing = false;
    if (!this.previewTimer) return;
    clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }

  /** Paint a preview, reporting whether it actually differed from what is up. */
  private applyPreview(preview: TuiPreview | null): boolean {
    if (samePreview(this.model.preview, preview)) return false;
    this.model.setPreview(preview);
    return true;
  }

  private async fetchPreview(): Promise<void> {
    const sessionId = this.previewSessionId;
    if (!sessionId || this.previewFetching || this.exiting) return;
    this.previewFetching = true;
    try {
      const raw = await this.client.fetchTerminalTail(sessionId, PREVIEW_TAIL_BYTES);
      if (this.previewSessionId !== sessionId) return;
      const tail = toDisplayLines(dropSeveredEscape(raw)).slice(-PREVIEW_MAX_LINES);
      // A nerd font can draw anything; every other terminal gets the rare
      // prompt glyphs folded to the arrows they already look like, because a
      // font's per-glyph coverage cannot be detected from in here and tofu is
      // worse than an ASCII arrow.
      const lines = this.glyphTier === 'nerd' ? tail : tail.map(foldPreviewGlyphs);
      // An identical tail is what the backoff counts; anything new resets it, so
      // a pane that starts printing again is back to one read a second.
      if (this.applyPreview({ sessionId, lines })) this.previewQuiet = 0;
      else this.previewQuiet++;
    } catch {
      // A tail that cannot be read is a pane-level fact, not a connection one:
      // the list stays exactly as it is and only this pane says so. It counts as
      // quiet either way, so a pane that cannot be read is not retried hard.
      if (this.previewSessionId !== sessionId) return;
      this.applyPreview({ sessionId, lines: [], error: "could not read that session's terminal" });
      this.previewQuiet++;
    } finally {
      this.previewFetching = false;
    }
    this.paint();
  }

  // ── Painting ───────────────────────────────────────────────────────────────

  private currentLayout(): TuiLayout {
    return computeLayout(this.stdout.columns ?? 80, this.stdout.rows ?? 24, {
      banner: needsBanner(this.model.connection),
    });
  }

  /**
   * The session a dead-row error card is offering to resume, by id.
   *
   * An id rather than the row: by the time the key is pressed the model has
   * resynced at least once, and acting on a captured row would resume whatever
   * that stale object still pointed at. Armed only while the card is up, and
   * cleared the moment anything else happens, so `r` can never resume a session
   * the user is no longer looking at.
   */
  private resumeOffer: string | null = null;

  private keymapContext(): TuiKeymapContext {
    const approval = this.model.selectedSession()?.approval;
    return {
      server: this.model.connection !== 'degraded',
      approval: approval ? (approval.kind === 'idle' ? 'idle' : 'menu') : null,
      detach: this.detachChordLabel,
      resumeOffer: this.resumeOffer !== null,
    };
  }

  private paint(force = false): void {
    if (this.exiting || !this.screen.active) return;
    const layout = this.currentLayout();
    const key: TuiFrameKey = {
      revision: this.model.revision,
      cols: layout.cols,
      rows: layout.rows,
      tick: this.tick,
    };
    if (!force && sameFrame(this.lastFrame, key)) return;
    this.lastFrame = key;

    const keymap = this.keymapContext();
    const options: TuiRenderOptions = {
      color: this.color,
      glyphs: this.glyphTier,
      tick: this.tick,
      now: Date.now(),
      footerKeys: footerKeysFor(this.model.mode, this.glyphs, keymap),
      helpKeys: helpKeysFor(this.glyphs, keymap),
    };
    // The cursor belongs in the composer while one is open and nowhere else: a
    // blinking cursor parked in a dashboard reads as a stuck program.
    const cursor = composerCursorCell(this.model, layout);
    const place = cursor ? `\x1b[${cursor.row};${cursor.col}H${CURSOR_SHOW}` : CURSOR_HIDE;
    this.stdout.write(`${SYNC_BEGIN}${renderFrame(this.model, layout, options)}${place}${SYNC_END}`);
    this.syncAnimation();
  }

  private syncAnimation(): void {
    const wanted = shouldAnimate(this.model.rows());
    if (wanted && !this.tickTimer) {
      this.tickTimer = setInterval(() => {
        this.tick++;
        this.paint();
      }, TICK_MS);
      return;
    }
    if (!wanted && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private feed(chunk: Buffer): void {
    for (const event of this.parser.feed(chunk)) this.handle(event);
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    // A held ESC is either a lone Escape or the head of a sequence still in
    // flight; only silence tells the two apart.
    if (this.parser.pending() > 0) {
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        for (const event of this.parser.flush()) this.handle(event);
        this.afterInput();
      }, ESC_FLUSH_MS);
    }
    this.afterInput();
  }

  /**
   * An Alt chord: `Alt+1`..`Alt+9` switch session, everything else is replayed.
   *
   * Alt+N SELECTS rather than attaches. In the web UI Alt+N switches which tab
   * you are looking at, which is cheap and reversible; the terminal equivalent
   * is moving the selection and its preview, not handing the whole terminal to
   * a pane. Bare 1-9 keeps its documented jump-and-attach meaning.
   *
   * ⚠️ Every OTHER chord is replayed as `escape` then the character, and that
   * fallback is load-bearing rather than tidiness. A terminal encodes Alt+x as
   * ESC then x, so a real Esc that lands in the same read as the next keystroke
   * is byte-identical to a chord. Without the replay, "Esc then q" typed
   * quickly decoded as Alt+Q, matched nothing, and was swallowed — the e2e test
   * caught it as the dashboard refusing to quit. Replaying keeps every overlay
   * dismissal and every existing key working exactly as before.
   */
  private handleAlt(value: string): void {
    if (this.model.mode === 'list' && value >= '1' && value <= '9') {
      this.model.cursorToIndex(Number.parseInt(value, 10));
      return;
    }
    this.handle({ type: 'escape' });
    this.handle({ type: 'char', value });
  }

  /**
   * The live sessions, numbered the way the dashboard numbers them, for the
   * strip the attach bar draws.
   *
   * A SNAPSHOT taken at attach time and not refreshed: the TUI is blocked in
   * `spawnSync` for the whole attach, so there is no loop to update it from,
   * and tmux's own format language cannot map a `codeman-<hex>` session name
   * back to the label a human recognises. A strip that is a few minutes stale
   * about a session created elsewhere is worth far more than no strip.
   */
  private attachTabs(activeId: string): TuiAttachTab[] {
    const tabs: TuiAttachTab[] = [];
    let index = 0;
    for (const row of this.model.rows()) {
      if (row.group === 'recent') continue;
      index += 1;
      const muxName = (row.session.muxName ?? '').trim();
      tabs.push({
        index,
        label: rowLabel(row.session),
        active: row.session.sessionId === activeId,
        ...(muxName ? { muxName } : {}),
      });
    }
    return tabs;
  }

  /** Every key can change the selection or the mode, and both steer the preview. */
  private afterInput(): void {
    if (this.exiting) return;
    this.updatePreview();
    this.paint();
  }

  private handle(event: TuiInputEvent): void {
    if (this.exiting) return;
    if (event.type === 'alt') {
      this.handleAlt(event.value);
      return;
    }
    switch (this.model.mode) {
      case 'confirm-kill':
        this.handleConfirm(event);
        return;
      case 'new-session':
        this.handlePicker(event);
        return;
      case 'prompt':
        this.handlePrompt(event);
        return;
      case 'search':
        this.handleSearch(event);
        return;
      case 'digest':
        this.handleDigest(event);
        return;
      case 'message':
        // ⚠️ `r` is checked BEFORE the dismiss, because a message overlay is
        // dismissed by ANY key: without this branch the offer would be consumed
        // as "some key was pressed" and the card would just close.
        if (this.resumeOffer && event.type === 'char' && event.value === 'r') {
          this.takeResumeOffer();
          return;
        }
        this.resumeOffer = null;
        if (event.type !== 'mouse') this.model.closeOverlay();
        return;
      case 'help':
        // Any key dismisses; the footer says esc because that is the one key
        // every overlay in the app answers to.
        if (event.type !== 'mouse') this.model.closeOverlay();
        return;
      default:
        this.handleList(event);
    }
  }

  private handleList(event: TuiInputEvent): void {
    switch (event.type) {
      case 'key':
        if (event.name === 'up') this.model.moveCursor(-1);
        else if (event.name === 'down') this.model.moveCursor(1);
        else if (event.name === 'pageup') this.model.moveCursor(-5);
        else if (event.name === 'pagedown') this.model.moveCursor(5);
        return;
      case 'enter':
        void this.attachSelected();
        return;
      case 'ctrl':
        if (event.key === 'c') this.quit(0);
        return;
      case 'char':
        this.handleListChar(event.value);
        return;
      case 'tab':
        // Ctrl+Tab in the web UI. A terminal cannot report the Ctrl, so plain
        // Tab carries it: nothing else in the list wants the key.
        this.model.moveCursor(1);
        return;
      default:
        return;
    }
  }

  private handleListChar(value: string): void {
    // A pending dialog takes the keys it can answer, and only those: the mapping
    // returns null for a digit the dialog has no option for (and for every key
    // on an idle prompt), which leaves the list's own bindings intact.
    const approval = this.model.selectedSession()?.approval;
    if (approval) {
      const answer = approvalAnswerForKey(approval, value);
      if (answer) {
        void this.answerApproval(approval, answer);
        return;
      }
    }

    if (value >= '1' && value <= '9') {
      // SELECT, never attach. A digit used to jump AND hand the terminal to
      // that pane, which made Alt+N unusable: a terminal sends Alt+N as ESC
      // then N, and when those land in separate reads — routine over SSH — the
      // chord decodes as Escape plus a bare digit, so "switch to tab 2" threw
      // the user into tab 2's pane instead. Selecting matches what Alt+N means
      // in the web UI, and Enter is how you go in.
      this.model.cursorToIndex(Number.parseInt(value, 10));
      return;
    }
    switch (value) {
      case 'j':
        this.model.moveCursor(1);
        return;
      case 'k':
        this.model.moveCursor(-1);
        return;
      // The web UI's Alt+[ / Alt+] for previous/next tab. WITHOUT the Alt,
      // because ESC+[ is byte-identical to the CSI introducer every arrow key
      // arrives on, so the chord cannot be transmitted by a terminal at all.
      case '[':
        this.model.moveCursor(-1);
        return;
      case ']':
        this.model.moveCursor(1);
        return;
      case 'q':
        this.quit(0);
        return;
      case '?':
        this.model.setMode('help');
        return;
      case 'x':
        this.beginKill();
        return;
      case 'n':
        void this.openNewSession();
        return;
      case 'p':
        this.openPrompt();
        return;
      case '/':
        this.openSearch();
        return;
      case 'g':
        void this.openDigest();
        return;
      default:
        return;
    }
  }

  private handleConfirm(event: TuiInputEvent): void {
    const state = this.model.confirm;
    if (!state) {
      this.model.closeOverlay();
      return;
    }
    const step = confirmKillStep(state, event);
    switch (step.kind) {
      case 'cancel':
        this.model.closeOverlay();
        return;
      case 'confirm':
        void this.killSession(state.sessionId, state.name);
        return;
      case 'ignore':
        return;
    }
  }

  // ── Composer, search and digest input ──────────────────────────────────────

  /** Columns the composer's text gets, once its fixed prefix is paid for. */
  private composerWidth(): number {
    return Math.max(1, (this.stdout.columns ?? 80) - COMPOSER_PREFIX.length);
  }

  private handlePrompt(event: TuiInputEvent): void {
    const state = this.model.prompt;
    if (!state) {
      this.model.closeOverlay();
      return;
    }
    const step = composerStep(state.composer, event);
    switch (step.kind) {
      case 'edit':
        this.model.updatePrompt(this.scrolled(step.state));
        return;
      case 'cancel':
        this.model.closeOverlay();
        return;
      case 'submit':
        void this.sendPrompt(state.sessionId, step.text);
        return;
      case 'ignore':
        return;
    }
  }

  private scrolled(state: TuiComposerState): TuiComposerState {
    return composerScroll(state, this.composerWidth());
  }

  private handleSearch(event: TuiInputEvent): void {
    const state = this.model.search;
    if (!state) {
      this.model.closeOverlay();
      return;
    }
    // The arrows drive the RESULT list, not the query caret: the query renders
    // its caret as a trailing underscore, so a caret that could move would move
    // invisibly.
    if (event.type === 'key') {
      if (event.name === 'up') this.moveSearch(-1);
      else if (event.name === 'down') this.moveSearch(1);
      else if (event.name === 'pageup') this.moveSearch(-5);
      else if (event.name === 'pagedown') this.moveSearch(5);
      return;
    }
    if (event.type === 'enter') {
      this.openSearchResult();
      return;
    }
    const step = composerStep(state.composer, event);
    switch (step.kind) {
      case 'edit':
        this.model.updateSearch({ composer: step.state });
        this.scheduleSearch(composerText(step.state));
        return;
      case 'cancel':
        this.closeSearch();
        return;
      default:
        return;
    }
  }

  private moveSearch(delta: number): void {
    const state = this.model.search;
    if (!state || state.entries.length === 0) return;
    this.model.updateSearch({ index: moveSearchIndex(state.entries, state.index, delta) });
  }

  private handleDigest(event: TuiInputEvent): void {
    const capacity = digestCapacity(this.currentLayout());
    const page = Math.max(1, capacity - 1);
    switch (event.type) {
      case 'escape':
        this.closeOverlayAndResume();
        return;
      case 'ctrl':
        if (event.key === 'c') this.closeOverlayAndResume();
        return;
      case 'key':
        if (event.name === 'up') this.model.scrollDigest(-1, capacity);
        else if (event.name === 'down') this.model.scrollDigest(1, capacity);
        else if (event.name === 'pageup') this.model.scrollDigest(-page, capacity);
        else if (event.name === 'pagedown') this.model.scrollDigest(page, capacity);
        else if (event.name === 'home') this.model.scrollDigest(-Number.MAX_SAFE_INTEGER, capacity);
        else if (event.name === 'end') this.model.scrollDigest(Number.MAX_SAFE_INTEGER, capacity);
        return;
      case 'char':
        if (event.value === 'j') this.model.scrollDigest(1, capacity);
        else if (event.value === 'k') this.model.scrollDigest(-1, capacity);
        else if (event.value === 'q' || event.value === 'g') this.closeOverlayAndResume();
        return;
      default:
        return;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  private message(tone: 'info' | 'warn' | 'err', text: string): void {
    this.model.setMessage({ tone, text });
    // An overlay hides the preview pane, so stop re-reading the tail behind it.
    // Keystroke-driven overlays get this from `afterInput()`; the ones an async
    // action opens (answered, killed, started) would otherwise keep polling.
    this.updatePreview();
  }

  /**
   * A message that clears itself. Used for outcomes the user already expects
   * ("sent"), where a box waiting to be dismissed is one keystroke of ceremony
   * for no information.
   */
  private notice(text: string): void {
    this.model.setMessage({ tone: 'info', text });
    this.updatePreview();
    const shown = this.model.message;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      // Only clear the notice this timer armed: anything the user opened in the
      // meantime owns the screen now.
      if (this.model.message !== shown) return;
      this.closeOverlayAndResume();
    }, NOTICE_MS);
  }

  /** Drop the overlay and let the preview start following the list again. */
  private closeOverlayAndResume(): void {
    this.model.closeOverlay();
    this.updatePreview();
    this.paint();
  }

  private async answerApproval(item: ApprovalItem, answer: TuiApprovalAnswer): Promise<void> {
    let result;
    try {
      result = await this.client.answerApproval(item.id, answer);
    } catch (error) {
      this.message('err', `could not answer that prompt: ${getErrorMessage(error)}`);
      this.paint();
      return;
    }
    // Answering a dialog unblocks the agent, so the pane starts printing again.
    if (result.ok) this.previewQuiet = 0;
    await this.refresh();
    if (result.ok) this.notice(`answered ${item.sessionName || item.sessionId.slice(0, 8)}`);
    // The server re-captures the pane before it types, so this is the normal
    // outcome when the dialog was answered in tmux a moment ago.
    else if (result.reason === 'gone') this.message('warn', 'that dialog is no longer on screen');
    else this.message('err', result.message);
    this.paint();
  }

  private openPrompt(): void {
    const row = this.model.selectedSession();
    if (!row) return;
    if (this.model.connection === 'degraded') {
      this.message('warn', 'sending a prompt needs the server; only attach works while it is down');
      return;
    }
    if (row.group === 'recent') {
      this.message('warn', 'that session is not running: there is nothing to type at');
      return;
    }
    this.model.setPrompt({
      sessionId: row.session.sessionId,
      label: rowLabel(row.session),
      composer: createComposer(),
    });
  }

  private async sendPrompt(sessionId: string, text: string): Promise<void> {
    const line = text.trim();
    this.model.closeOverlay();
    if (line === '') {
      this.updatePreview();
      this.paint();
      return;
    }
    try {
      await this.client.sendInput(sessionId, line);
      // The pane is about to print the reply, so read it at the fast cadence
      // however long it had been sitting quiet before this.
      this.previewQuiet = 0;
      await this.refresh();
      this.notice('sent');
    } catch (error) {
      this.message('err', `could not send that prompt: ${getErrorMessage(error)}`);
    }
    this.updatePreview();
    this.paint();
  }

  private openSearch(): void {
    if (this.model.connection === 'degraded') {
      this.message('warn', 'search needs the server; only attach works while it is down');
      return;
    }
    this.model.setSearch({ composer: createComposer(), query: '', entries: [], index: -1, status: 'idle' });
  }

  private closeSearch(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.closeOverlayAndResume();
  }

  private scheduleSearch(query: string): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.runSearch(query);
    }, SEARCH_DEBOUNCE_MS);
  }

  private async runSearch(query: string): Promise<void> {
    if (this.model.mode !== 'search' || !this.model.search) return;
    const needle = query.trim();
    const seq = ++this.searchSeq;
    if (needle === '') {
      this.model.updateSearch({ query: '', entries: [], index: -1, status: 'idle', note: undefined });
      this.paint();
      return;
    }

    this.model.updateSearch({ status: 'searching', note: 'searching…' });
    this.paint();
    try {
      const data = await this.client.search(needle, SEARCH_LIMIT);
      if (seq !== this.searchSeq || this.model.mode !== 'search') return;
      // Only a session that is on the list can be selected; a history hit has a
      // session id but no row to move the cursor to.
      const live = new Set(
        this.model
          .rows()
          .filter((row) => row.group !== 'recent')
          .map((row) => row.session.sessionId)
      );
      const entries = buildSearchEntries(data.groups, (id) => live.has(id));
      this.model.updateSearch({
        query: needle,
        entries,
        index: firstSearchIndex(entries),
        status: 'done',
        note:
          entries.length === 0
            ? 'no matches'
            : `${data.totalResults} result${data.totalResults === 1 ? '' : 's'}${data.truncated ? ' (capped)' : ''}`,
      });
    } catch (error) {
      if (seq !== this.searchSeq || this.model.mode !== 'search') return;
      this.model.updateSearch({
        status: 'error',
        entries: [],
        index: -1,
        note: `search failed: ${getErrorMessage(error)}`,
      });
    }
    this.paint();
  }

  private openSearchResult(): void {
    const state = this.model.search;
    if (!state) return;
    const entry = state.entries[state.index];
    if (!entry || entry.kind !== 'result') return;
    if (entry.live && entry.sessionId && this.model.select(entry.sessionId)) {
      this.closeSearch();
      return;
    }
    // Nothing to switch to (a history or file hit), so the row's own facts are
    // the answer; resuming one is phase 3.
    this.model.updateSearch({ note: [entry.text, entry.detail].filter((part) => part).join(' · ') });
  }

  private async openDigest(): Promise<void> {
    if (this.model.connection === 'degraded') {
      this.message('warn', 'the digest needs the server; only attach works while it is down');
      return;
    }
    this.model.setDigest({ title: 'Away digest', lines: ['loading…'], offset: 0 });
    this.updatePreview();
    this.paint();
    let lines: string[];
    try {
      const digest = await this.client.fetchAwayDigest();
      lines = formatAwayDigest(digest, { now: Date.now() });
    } catch (error) {
      lines = [`could not load the digest: ${getErrorMessage(error)}`];
    }
    // Esc works throughout the round trip, and a digest that lands afterwards
    // must not reopen the overlay the user just closed.
    if (this.model.mode !== 'digest') return;
    this.model.setDigest({ title: 'Away digest', lines, offset: 0 });
    this.paint();
  }

  /**
   * Enter on a RECENT row: resume that conversation and hand the terminal to
   * it, so one key means the same thing everywhere in the list ("put me in
   * this"). The row itself is history and has no pane, so the resumed session
   * is a NEW one carrying the old conversation, exactly like the web UI's
   * Resume Conversation list.
   */
  private async resumeSelected(row: TuiRow): Promise<void> {
    if (this.resuming) return;
    if (this.model.connection === 'degraded') {
      this.message('warn', 'resuming needs the server; only attach works while it is down');
      return;
    }
    const plan = planResume(row.session);
    if (plan.kind === 'refuse') {
      this.message('warn', plan.message);
      return;
    }
    // The flag is the loop breaker, not decoration: a resume ends in an attach,
    // and one that could re-enter this method would spawn a session per pass.
    this.resuming = true;
    let sessionId: string;
    try {
      this.notice(`resuming ${truncateLabel(rowLabel(row.session), RESUME_NOTICE_WIDTH)}…`);
      this.paint(true);
      sessionId = await this.client.resumeSession({
        workingDir: plan.workingDir,
        resumeSessionId: plan.resumeSessionId,
        ...(plan.sessionName ? { sessionName: plan.sessionName } : {}),
      });
    } catch (error) {
      this.message('err', `could not resume that conversation: ${getErrorMessage(error)}`);
      this.paint(true);
      return;
    } finally {
      this.resuming = false;
    }

    // Selected whichever way the race goes: a row that is not in the model yet
    // is picked up by the next resync instead.
    this.pendingSelectId = sessionId;
    const fresh = await this.awaitResumedRow(sessionId);
    if (!fresh) {
      this.message('info', 'resumed; its pane is still starting — press ⏎ on the new row when it appears');
      this.paint(true);
      return;
    }
    this.pendingSelectId = null;
    await this.attachToSession(fresh);
  }

  /**
   * Wait for the resumed session to exist as a LIVE row with a pane, so the
   * attach that follows has something to attach to. Bounded, and it gives up by
   * returning null rather than by trying again from the top.
   */
  private async awaitResumedRow(sessionId: string): Promise<TuiRow | null> {
    const deadline = Date.now() + RESUME_PANE_TIMEOUT_MS;
    for (;;) {
      if (await this.awaitPane(sessionId, 0)) {
        await this.refresh();
        if (this.model.select(sessionId)) {
          const row = this.model.selectedSession();
          if (row && row.group !== 'recent' && (row.session.muxName ?? '').trim()) return row;
        }
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, RESUME_PANE_POLL_MS));
    }
  }

  /**
   * Wait for a just-created session's tmux pane to exist, by the same prefix
   * join `applyMuxNames()` uses. Enumeration is the only honest evidence the
   * pane is really there; deriving `codeman-<prefix>` by hand would attach to a
   * name that may not exist yet.
   */
  private async awaitPane(sessionId: string, timeoutMs = RESUME_PANE_TIMEOUT_MS): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tmux = await this.client.enumerateTmuxSessions().catch(() => []);
      const match = tmux.find((entry) => entry.sessionId === sessionId || sessionId.startsWith(entry.sessionIdPrefix));
      if (match) return match.muxName;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, RESUME_PANE_POLL_MS));
    }
  }

  private async attachSelected(): Promise<void> {
    const row = this.model.selectedSession();
    if (!row) return;
    if (row.group === 'recent') {
      await this.resumeSelected(row);
      return;
    }
    await this.attachToSession(row);
  }

  /**
   * The attach itself, for a row that is known to be live.
   *
   * ⚠️ Deliberately NOT reachable through `attachSelected()`: resuming ends by
   * attaching, and routing that back through the group dispatch turned one
   * keystroke into an unbounded resume loop (measured: 35 sessions in 40
   * seconds before it was killed) whenever the fresh row was not selectable
   * yet. Nothing here looks at `group` again.
   */
  private async attachToSession(row: TuiRow): Promise<void> {
    const muxName = (row.session.muxName ?? '').trim();
    const plan = planAttach(muxName, {
      socket: this.socket,
      ...(this.env.TMUX ? { tmux: this.env.TMUX } : {}),
    });
    if (plan.kind === 'refuse') {
      this.message('warn', plan.message);
      return;
    }

    // A dead pane still LISTS, because Codeman keeps `remain-on-exit on`: the
    // row looks ordinary and the server still calls it idle. Attaching to one
    // hands the terminal to a pane that reads nothing, which a beta tester
    // experienced as the TUI freezing with no way out.
    if (await this.client.isPaneDead(muxName)) {
      // Its conversation usually survives the pane: tmux's own dead-pane screen
      // says `claude --resume "<name>"`. Offering that turns a dead end into
      // recovery, instead of telling the user to throw the work away.
      const offer = planResume(row.session).kind === 'resume';
      this.resumeOffer = offer ? row.session.sessionId : null;
      this.message(
        'err',
        `${rowLabel(row.session)} has exited — its pane is dead, so there is nothing there to type into. ` +
          (offer
            ? 'Press r to resume the conversation in a fresh pane, or x to close the row.'
            : 'Close the row with x, or start a fresh session with n.')
      );
      // ⚠️ message() only sets state. The keypress that got us here painted
      // BEFORE this await resolved, so without a paint of our own the refusal
      // is invisible and Enter looks like it did nothing at all.
      this.paint();
      return;
    }

    // tmux is about to own this terminal. The dashboard is not on screen, and
    // the pane the preview would keep re-reading is the one the user is now
    // looking at directly, so the poll stops for the whole handoff (an attach
    // can last hours).
    this.stopPreview();

    if (plan.kind === 'switch') {
      // Only the sizing, and no restore: this client keeps showing the other
      // session after the TUI exits, so snapping the window back to the
      // browser's size would put the dots on screen at the moment the user
      // arrives, and a bar reading "back to the dashboard" would point at a
      // dashboard that is gone. The web UI reclaims the size on its next
      // resize, which sets `manual` again on its own.
      await this.client.followAttachingClient(muxName);
      // The client this TUI draws on is about to show another session, so the
      // dashboard has nothing left to draw and no reason to keep polling.
      this.screen.leave();
      const result = spawnSync(plan.file, plan.args, { stdio: 'inherit' });
      if (result.error) {
        process.stderr.write(`codeman tui: ${getErrorMessage(result.error)}\n`);
        this.quit(1);
        return;
      }
      this.quit(result.status ?? 0);
      return;
    }

    // The way OUT, set up before tmux takes the terminal: a status bar that
    // stays for the whole attach. The line written below is on a screen tmux
    // repaints a moment later, so it is not what the user reads.
    const handoff = await beginAttachHandoff(
      this.client,
      muxName,
      rowLabel(row.session),
      this.attachTabs(row.session.sessionId),
      this.currentLayout().cols,
      this.currentLayout().rows
    );
    this.detachChordLabel = handoff.chord;
    this.screen.leave();
    this.stdout.write(`${handoff.chord} detaches and brings you back here.\n`);
    const result = spawnSync(plan.file, plan.args, { stdio: 'inherit' });
    await handoff.restore();
    this.screen.enter();
    // Whatever happened in the pane happened while nobody was reading it, so the
    // first tail after a detach must not be a backed-off one.
    this.previewQuiet = 0;
    this.updatePreview();
    this.paint(true);
    if (result.error) {
      this.message('err', `tmux attach failed: ${getErrorMessage(result.error)}`);
      return;
    }
    this.notice(`detached from ${rowLabel(row.session)} · it keeps running`);
    await this.refresh();
    this.paint(true);
  }

  private beginKill(): void {
    const row = this.model.selectedSession();
    if (!row) return;
    if (this.model.connection === 'degraded') {
      this.message('warn', 'killing a session needs the server; only attach works while it is down');
      return;
    }
    if (row.group === 'recent') {
      this.message('warn', 'that row is history: there is no session left to kill');
      return;
    }
    if (isSelfSession(row.session.sessionId, this.env)) {
      this.message('warn', 'that is the session this TUI is running in');
      return;
    }
    this.model.beginConfirmKill(row, rowLabel(row.session));
  }

  private async killSession(sessionId: string, name: string): Promise<void> {
    this.model.closeOverlay();
    try {
      await this.client.deleteSession(sessionId);
      await this.refresh();
      this.message('info', `killed ${name}`);
    } catch (error) {
      this.message('err', `could not kill ${name}: ${getErrorMessage(error)}`);
    }
    this.paint();
  }

  private async openNewSession(): Promise<void> {
    if (this.model.connection === 'degraded') {
      this.message('warn', 'starting a session needs the server; only attach works while it is down');
      return;
    }
    this.picker = { stage: 'case', all: [] };
    this.model.setPicker({ title: 'New session', items: [], index: -1, filter: '', hint: 'loading cases…' });
    this.paint();

    let items: TuiPickerItem[];
    try {
      const cases = await this.client.fetchCases();
      items = cases.map((entry) => ({
        id: entry.name,
        label: entry.name,
        ...(entry.location && entry.location !== 'local' ? { detail: entry.location } : {}),
      }));
    } catch (error) {
      this.picker = null;
      this.message('err', `could not list cases: ${getErrorMessage(error)}`);
      this.paint();
      return;
    }

    // The picker can be gone already: fetching cases takes a round trip and esc
    // works throughout it.
    if (!this.picker || this.picker.stage !== 'case') return;
    this.picker.all = items;
    this.showPicker('Pick a case', items.length > 0 ? 'which case should the session run in?' : 'no cases found');
    this.paint();
  }

  private showPicker(title: string, hint: string, filter = ''): void {
    const runtime = this.picker;
    if (!runtime) return;
    const needle = filter.trim().toLowerCase();
    const items = needle ? runtime.all.filter((item) => item.label.toLowerCase().includes(needle)) : [...runtime.all];
    this.model.setPicker({ title, items, index: items.length > 0 ? 0 : -1, filter, hint });
  }

  private handlePicker(event: TuiInputEvent): void {
    const state = this.model.picker;
    const runtime = this.picker;
    if (!state || !runtime) {
      this.model.closeOverlay();
      return;
    }
    switch (event.type) {
      case 'escape':
        this.picker = null;
        this.model.closeOverlay();
        return;
      case 'ctrl':
        if (event.key === 'c') {
          this.picker = null;
          this.model.closeOverlay();
        }
        return;
      case 'key':
        if (event.name === 'up') this.movePicker(-1);
        else if (event.name === 'down') this.movePicker(1);
        return;
      case 'backspace':
        this.showPicker(state.title, state.hint ?? '', [...(state.filter ?? '')].slice(0, -1).join(''));
        return;
      case 'char':
        this.showPicker(state.title, state.hint ?? '', `${state.filter ?? ''}${event.value}`);
        return;
      case 'enter':
        this.choosePicked();
        return;
      default:
        return;
    }
  }

  private movePicker(delta: number): void {
    const state = this.model.picker;
    if (!state || state.items.length === 0) return;
    const next = (((state.index + delta) % state.items.length) + state.items.length) % state.items.length;
    this.model.setPicker({ ...state, index: next });
  }

  private choosePicked(): void {
    const state = this.model.picker;
    const runtime = this.picker;
    if (!state || !runtime || state.index < 0 || state.index >= state.items.length) return;
    const chosen = state.items[state.index];

    if (runtime.stage === 'case') {
      this.picker = {
        stage: 'mode',
        caseName: chosen.id,
        all: MODE_ITEMS.map((mode) => ({ id: mode.id, label: mode.label, detail: mode.detail })),
      };
      this.showPicker('Pick a CLI', `new session in ${chosen.label}`);
      return;
    }

    const caseName = runtime.caseName;
    // Resolved against the table rather than cast: the picker's ids are strings
    // and quick-start refuses a mode the server does not know.
    const mode = MODE_ITEMS.find((entry) => entry.id === chosen.id);
    this.picker = null;
    this.model.closeOverlay();
    if (caseName && mode) void this.startSession(caseName, mode.id);
  }

  /**
   * Act on the dead-row card's offer: resume the conversation whose pane died.
   *
   * ⚠️ Re-resolved from the model by id and disarmed BEFORE anything async, so
   * a second `r` cannot start a second resume. `resumeSelected()` owns the rest
   * of the loop safety (its own `resuming` flag, and it ends in
   * `attachToSession`, never the group dispatch that once produced 35 sessions
   * in 40 seconds).
   */
  private takeResumeOffer(): void {
    const sessionId = this.resumeOffer;
    this.resumeOffer = null;
    this.model.closeOverlay();
    if (!sessionId) return;
    const row = this.model.rows().find((candidate) => candidate.session.sessionId === sessionId);
    if (!row) {
      this.message('warn', 'that row is gone; the list has moved on since the card opened');
      this.paint();
      return;
    }
    void this.resumeSelected(row);
  }

  private async startSession(caseName: string, mode: TuiRunMode): Promise<void> {
    try {
      const result = await this.client.quickStart({
        caseName,
        mode,
        // Named here rather than left to the server: an unnamed session falls
        // back to whatever rowLabel() can find, and before the user has typed
        // anything that was the CLI's first line of output. `w<n>-<case>` is
        // the web UI's own convention, so a session started from either surface
        // reads the same in both.
        sessionName: nextSessionName(
          caseName,
          this.model.sessions().map((session) => session.name ?? '')
        ),
      });
      // The row appears with the next resync; remember which one to select.
      this.pendingSelectId = result.sessionId;
      this.notice(`starting ${mode} in ${caseName}…`);
      this.paint(true);
      await this.refresh();
      // Starting a session is a request to WORK in it, so the terminal goes
      // there as soon as the pane exists. Leaving the user on the dashboard
      // next to a session they just asked for reads as the create having
      // silently failed (reported from the beta as "it doesn't go into it
      // directly"), and the pane is worth watching while the CLI boots.
      const fresh = await this.awaitResumedRow(result.sessionId);
      if (!fresh) {
        this.message('info', `started ${mode} in ${caseName}; its pane is still starting — press ⏎ on the new row`);
        this.paint(true);
        return;
      }
      this.pendingSelectId = null;
      await this.attachToSession(fresh);
      return;
    } catch (error) {
      this.message('err', `could not start a session in ${caseName}: ${getErrorMessage(error)}`);
    }
    this.paint();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private installSafetyNets(): void {
    process.on('exit', this.onProcessExit);
    process.on('SIGINT', this.onSignal);
    process.on('SIGTERM', this.onSignal);
    // Prepended: src/index.ts already handles both by exiting, and a listener
    // registered after it would never run, leaving the terminal in raw mode.
    process.prependListener('uncaughtException', this.onFatal);
    process.prependListener('unhandledRejection', this.onFatal);
  }

  private removeSafetyNets(): void {
    process.off('exit', this.onProcessExit);
    process.off('SIGINT', this.onSignal);
    process.off('SIGTERM', this.onSignal);
    process.off('uncaughtException', this.onFatal);
    process.off('unhandledRejection', this.onFatal);
  }

  private quit(code: number): void {
    if (this.exiting) return;
    this.exiting = true;
    for (const timer of [this.escTimer, this.resyncTimer, this.searchTimer, this.noticeTimer, this.previewTimer]) {
      if (timer) clearTimeout(timer);
    }
    for (const timer of [this.tickTimer, this.pollTimer, this.probeTimer]) {
      if (timer) clearInterval(timer);
    }
    // Not only the timer: the chain re-arms itself, so the flag has to go too.
    this.previewFollowing = false;
    this.escTimer = null;
    this.resyncTimer = null;
    this.searchTimer = null;
    this.noticeTimer = null;
    this.tickTimer = null;
    this.pollTimer = null;
    this.probeTimer = null;
    this.previewTimer = null;
    this.stream?.close();
    this.client.close();
    this.stdin.off('data', this.onData);
    this.screen.leave();
    this.removeSafetyNets();
    this.resolveExit?.(code);
    this.resolveExit = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

type Snapshot = { kind: 'ok'; rows: TuiRow[]; degraded: boolean } | { kind: 'auth' };

/**
 * One read of the world for the non-interactive paths. Same client, same
 * classification and same ordering as the dashboard, so `--list`'s numbers are
 * the numbers `codeman tui <n>` takes.
 */
async function snapshot(client: TuiClient): Promise<Snapshot> {
  const server = await client.connect();
  if (server?.authRequired) return { kind: 'auth' };
  const model = createTuiModel();
  if (!server) {
    model.replaceSessions(tmuxRowsToSessions(await client.enumerateTmuxSessions()));
    return { kind: 'ok', rows: model.rows(), degraded: true };
  }
  const [sessions, approvals, tmux, metrics] = await Promise.all([
    client.fetchUnifiedSessions(UNIFIED_LIMIT),
    client.fetchApprovals().catch(() => []),
    client.enumerateTmuxSessions().catch(() => [] as TuiTmuxSession[]),
    client.fetchLiveSessionMetrics().catch(() => [] as TuiLiveSessionMetrics[]),
  ]);
  // Same merge as the dashboard, so `--list`'s numbers stay the numbers
  // `codeman tui <n>` takes: the WORKING group's order depends on it.
  model.replaceSessions(applyLiveMetrics(applyMuxNames(sessions, tmux), metrics));
  model.setApprovals(approvals);
  return { kind: 'ok', rows: model.rows(), degraded: false };
}

function authHint(): string {
  return (
    `${palette.err('The Codeman server rejected these credentials.')}\n` +
    `Set ${palette.info('CODEMAN_PASSWORD')} (and ${palette.info('CODEMAN_USERNAME')} if it is not "admin"), ` +
    'or put them in ~/.codeman/.env.\n'
  );
}

/** The full-screen dashboard. */
export async function runTui(options: TuiRunOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write(
      `${palette.err('codeman tui needs an interactive terminal.')}\n` +
        `Use ${palette.info('codeman tui --list')} for a plain list, or ${palette.info('codeman tui <n>')} to attach.\n`
    );
    return 1;
  }
  return new TuiApp(options).run();
}

/**
 * `codeman tui --list`: prints and exits, colored when the output is a terminal
 * and plain when it is piped (chalk's call, not ours), so it composes with
 * grep/awk.
 */
export async function runTuiList(options: TuiRunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const client = options.client ?? new TuiClient();
  try {
    const state = await snapshot(client).catch((error: unknown) => {
      process.stderr.write(`${palette.err(getErrorMessage(error))}\n`);
      return null;
    });
    if (!state) return 1;
    if (state.kind === 'auth') {
      process.stderr.write(authHint());
      return 1;
    }
    if (state.degraded) {
      process.stderr.write(`${palette.warn('server not running: listing tmux sessions only')}\n`);
    }
    const lines = buildListLines(state.rows);
    if (lines.length === 0) {
      process.stderr.write(`${palette.muted('no sessions')}\n`);
      return 0;
    }
    const rows = lines.map((line) => [
      palette.muted(String(line.index)),
      tint(STATE_TONE[line.state], STATE_WORDS[line.state]),
      line.label,
      palette.muted(line.workingDir),
    ]);
    stdout.write(`${table(rows, { indent: '  ' })}\n`);
    return 0;
  } finally {
    client.close();
  }
}

/**
 * `codeman tui <n>`: attach straight to the nth row of `--list`. No screen setup
 * at all, so it is as fast as the API call it makes.
 */
export async function runTuiAttach(position: number, options: TuiRunOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write(`${palette.err('attaching needs an interactive terminal.')}\n`);
    return 1;
  }
  const env = options.env ?? process.env;
  const client = options.client ?? new TuiClient();
  try {
    const state = await snapshot(client).catch((error: unknown) => {
      process.stderr.write(`${palette.err(getErrorMessage(error))}\n`);
      return null;
    });
    if (!state) return 1;
    if (state.kind === 'auth') {
      process.stderr.write(authHint());
      return 1;
    }
    const row = state.rows[Math.trunc(position) - 1];
    if (!row) {
      process.stderr.write(
        `${palette.err(`there is no session ${position}`)}\nRun ${palette.info('codeman tui --list')} to see the numbers.\n`
      );
      return 1;
    }
    const plan = planAttach(row.session.muxName, {
      socket: resolveTmuxSocketName(),
      ...(env.TMUX ? { tmux: env.TMUX } : {}),
    });
    if (plan.kind === 'refuse') {
      process.stderr.write(`${palette.warn(plan.message)}\n`);
      return 1;
    }
    // Same handoff the dashboard does: the window follows this terminal and
    // wears a bar naming the way out. This path has no dashboard to come back
    // to, so the bar's wording is the only thing the detach hint has to carry.
    const muxName = (row.session.muxName ?? '').trim();
    const handoff = plan.kind === 'attach' ? await beginAttachHandoff(client, muxName, rowLabel(row.session)) : null;
    if (handoff) stdout.write(`${palette.muted(`${handoff.chord} detaches and leaves the session running.`)}\n`);
    const result = spawnSync(plan.file, plan.args, { stdio: 'inherit' });
    await handoff?.restore();
    if (result.error) {
      process.stderr.write(`${palette.err(getErrorMessage(result.error))}\n`);
      return 1;
    }
    return result.status ?? 0;
  } finally {
    client.close();
  }
}
