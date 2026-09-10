/**
 * @fileoverview tmux session manager for persistent Claude sessions.
 *
 * This module provides the TmuxManager class which creates and manages
 * tmux sessions that wrap Claude CLI processes. tmux provides:
 *
 * - **Persistence**: Sessions survive server restarts and disconnects
 * - **Ghost recovery**: Orphaned sessions are discovered and reattached on startup
 * - **Resource tracking**: Memory, CPU, and child process stats per session
 * - **Reliable input**: `send-keys -l` sends literal text in a single command
 * - **Teammate support**: Immutable pane IDs enable targeting individual teammates
 *
 * tmux sessions are named `codeman-{sessionId}` and stored in ~/.codeman/mux-sessions.json.
 *
 * Key features:
 * - `send-keys 'text' Enter` sends literal text in a single command
 * - `list-sessions -F` provides structured queries
 * - `display-message -p '#{pane_pid}'` for reliable PID discovery
 * - Single server architecture
 *
 * @module tmux-manager
 */

import { EventEmitter } from 'node:events';
import { collectDescendants } from './proc-tree.js';
import { execSync, exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  dataPath,
  DEFAULT_TMUX_SOCKET,
  CODEMAN_INSTANCE,
  SAFE_TMUX_SOCKET_PATTERN,
  resolveTmuxSocketName,
} from './config/instance.js';
import {
  ProcessStats,
  PersistedRespawnConfig,
  getErrorMessage,
  DEFAULT_NICE_CONFIG,
  type PaneInfo,
  type ClaudeMode,
  type SessionMode,
  type OpenCodeConfig,
  type CodexConfig,
  type EffortLevel,
  type GeminiConfig,
  type AntigravityConfig,
  type PiConfig,
  type GrokConfig,
  type DeepSeekConfig,
  type OmpConfig,
  type SessionRemote,
  type SessionDocker,
  type DockerCommandMode,
} from './types.js';
import { getCli } from './config/cli-registry/registry.js';
import { missingCliMessage, resolveCliBinDir } from './utils/cli-resolver.js';
import {
  buildSpawnCommandFromRegistry,
  configSetenvValues,
  legacyConfigForMode,
} from './session-cli-registry-bridge.js';
import type { CliEntry } from './config/cli-registry/types.js';
import {
  buildSshConnectionArgs,
  defaultRemoteCommandForMode,
  remoteLoginShellCommand,
  remoteSshTarget,
  remoteTmuxSessionAlive,
} from './remote-hosts.js';
import {
  buildDockerBaseArgs,
  buildDockerCreateArgs,
  containerApiUrl,
  CONTAINER_HOME,
  defaultDockerCommandForMode,
  hostGatewayAlias,
  resolveDockerClaudeArtifacts,
  resolveDockerCredentialArtifacts,
  resolveDockerDaemonMountSource,
  type DockerCreateContext,
  type DockerMount,
  type DockerSeedCopy,
} from './docker-hosts.js';
import { wrapWithNice, SAFE_PATH_PATTERN, resolveLocalShell, loginShellArgs } from './utils/index.js';
import type {
  TerminalMultiplexer,
  MuxSession,
  MuxSessionWithStats,
  CreateSessionOptions,
  RespawnPaneOptions,
  PaneCaptureOptions,
} from './mux-interface.js';
import {
  decideReconnect,
  advanceBackoff,
  freshReconnectState,
  resetReconnectState,
  type RemoteReconnectState,
} from './remote-reconnect.js';

// ============================================================================
// Timing Constants
// ============================================================================

import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';
import { ensureDeepSeekStatusShim } from './deepseek-status-shim.js';

/** How long a cached process snapshot stays usable. */
const PROC_SNAPSHOT_TTL_MS = 2000;

/**
 * How long the kill path waits for a fresh snapshot before giving up on it.
 * Shorter than EXEC_TIMEOUT_MS on purpose: killSession has two further strategies
 * (process group, tmux kill-session) and must reach them even when `ps` is wedged.
 */
const PROC_SNAPSHOT_WAIT_MS = 1500;
import { DEFAULT_TMUX_HISTORY_LIMIT, DEFAULT_TERMINAL_BUFFER_MAX_BYTES } from './config/terminal-history.js';

/**
 * Extra stdout headroom for the full-history `capture-pane` child process on
 * top of the consumer's byte cap: raw scrollback carries per-line SGR/ANSI
 * overhead that the route pipeline strips before applying its cap, so the
 * capture must be allowed to exceed the final payload size.
 */
const FULL_HISTORY_CAPTURE_SLACK_BYTES = 8 * 1024 * 1024;

/** Delay after tmux session creation — enough for detached tmux to be queryable */
const TMUX_CREATION_WAIT_MS = 100;

/** Max retries for getPanePid — tmux server cold-start (e.g. macOS) may need extra time */
const GET_PID_MAX_RETRIES = 5;
const GET_PID_RETRY_MS = 200;

/** Delay after tmux kill command (200ms) */
const TMUX_KILL_WAIT_MS = 200;

/** Delay for graceful shutdown (100ms) */
const GRACEFUL_SHUTDOWN_WAIT_MS = 100;

/** Default stats collection interval (2 seconds) */
const DEFAULT_STATS_INTERVAL_MS = 2000;

/** Default remote-reconnect watcher poll interval (5 seconds) — COD-108 */
const DEFAULT_REMOTE_RECONNECT_INTERVAL_MS = 5000;

/** Stable cwd for tmux server/pane launch; actual session cwd is reached inside the pane. */
const TMUX_LAUNCH_CWD = '/tmp';

/** Claude Code native macOS recommendation for avoiding low nofile startup failures. */
export const CLAUDE_CODE_NOFILE_LIMIT = 2147483646;

/**
 * SAFETY: Test mode detection.
 * When running under vitest (VITEST env var is set automatically),
 * ALL tmux shell commands are disabled. TmuxManager becomes a pure
 * in-memory mock that cannot interact with real tmux sessions.
 *
 * This makes it PHYSICALLY IMPOSSIBLE for any test to:
 * - Kill a tmux session
 * - Create a tmux session
 * - Send input to a tmux session
 * - Discover/reconcile real tmux sessions
 * - Read/write ~/.codeman/mux-sessions.json
 */
const IS_TEST_MODE = !!process.env.VITEST;

/** Path to persisted mux session metadata */
const MUX_SESSIONS_FILE = dataPath('mux-sessions.json');

/**
 * COD-108 kill-switch: `remoteAutoReconnect` app setting (default ON). Read at
 * call time (like headroom routing) so a settings change takes effect without a
 * restart. Absent/non-boolean ⇒ true (feature on).
 */
function isRemoteAutoReconnectEnabled(): boolean {
  try {
    const s = JSON.parse(readFileSync(dataPath('settings.json'), 'utf8')) as Record<string, unknown>;
    return typeof s.remoteAutoReconnect === 'boolean' ? s.remoteAutoReconnect : true;
  } catch {
    return true;
  }
}

/** Regex to validate tmux session names (only allow safe characters) */
const SAFE_MUX_NAME_PATTERN = /^codeman-[a-f0-9-]+$/;

/** Legacy pattern for pre-rename sessions (claudeman- prefix) */
const LEGACY_MUX_NAME_PATTERN = /^claudeman-[a-f0-9-]+$/;

/** Regex to validate tmux pane targets (e.g., "%0", "%1", "0", "1") */
const SAFE_PANE_TARGET_PATTERN = /^(%\d+|\d+)$/;

/** Dedicated tmux socket for new Codeman-owned sessions (instance-scoped:
 *  `codeman` for prod, `codeman-beta` on the beta branch). */
const DEFAULT_CODEMAN_TMUX_SOCKET = DEFAULT_TMUX_SOCKET;

/**
 * Separator used in `tmux list-panes -F` output between session name and pid.
 *
 * Must NOT be a backslash-escape (e.g. `\t`, `\n`): under non-tty execution
 * contexts (launchd on macOS, systemd without TTYPath) tmux can emit such
 * escapes as the literal two characters `\` + letter rather than the control
 * byte, breaking the parser and causing every tracked session to be classified
 * as dead — which wipes state.json on restart. '|' is passed through verbatim
 * in every environment and is rejected by tmux's own session-name validation,
 * so it cannot appear inside `#{session_name}` and cause a false split.
 */
const PANE_LIST_SEP = '|';

/** Format string for `tmux list-panes -F`. Keep in sync with {@link parsePaneList}. */
const PANE_LIST_FORMAT = `#{session_name}${PANE_LIST_SEP}#{pane_pid}`;

/**
 * 构建 pane 启动前的 nofile 修复命令。
 *
 * macOS launchd/tmux 组合有时会让 pane 继承 256 的 soft nofile；
 * 新版 Claude Code 会在这种环境下直接退出。这里避免使用 $变量
 * 或命令替换，因为 fullCmd 目前经由双引号 bash -c 传递，外层
 * shell 会提前展开它们。
 */
export function buildNofileLimitCommand(targetLimit = CLAUDE_CODE_NOFILE_LIMIT): string {
  const safeLimit = Number.isSafeInteger(targetLimit) && targetLimit > 0 ? targetLimit : CLAUDE_CODE_NOFILE_LIMIT;
  return `ulimit -Sn ${safeLimit} 2>/dev/null || ulimit -n ${safeLimit} 2>/dev/null || true`;
}

/**
 * Parse the output of `tmux list-panes -a -F '#{session_name}|#{pane_pid}'`
 * into a Map of session-name → pane pid. Exported for unit testing.
 *
 * - Skips empty lines and lines without the separator.
 * - Skips entries with a non-numeric pid or empty name.
 */
export function parsePaneList(output: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const sep = line.indexOf(PANE_LIST_SEP);
    if (sep === -1) continue;
    const name = line.slice(0, sep);
    const pid = parseInt(line.slice(sep + 1), 10);
    if (name && !Number.isNaN(pid)) {
      result.set(name, pid);
    }
  }
  return result;
}

/**
 * Resolve a target pane id from `tmux list-panes -F '#{pane_id}:#{pane_active}'`.
 * Prefers the active pane and falls back to the first valid pane.
 */
export function resolveTmuxPaneTarget(muxName: string, paneTarget?: string): string | null {
  if (!isValidMuxName(muxName)) {
    return null;
  }
  if (paneTarget === undefined || paneTarget === 'active') {
    return muxName;
  }
  if (!SAFE_PANE_TARGET_PATTERN.test(paneTarget)) {
    return null;
  }
  return `${muxName}.${paneTarget}`;
}

/**
 * Pick the active pane id from `tmux list-panes -F '#{pane_id}:#{pane_active}'`
 * output (lines like `%0:1`). Returns the pane id whose active flag is 1.
 */
export function resolveActivePaneTarget(output: string): string | null {
  for (const line of output.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const paneId = line.slice(0, sep).trim();
    const active = line.slice(sep + 1).trim();
    if (paneId && active === '1') return paneId;
  }
  return null;
}

type GraphemeSegmenter = {
  segment(input: string): Iterable<{ segment: string }>;
};

const GRAPHEME_SEGMENTER: GraphemeSegmenter | null = (() => {
  try {
    const Segmenter = (
      Intl as typeof Intl & {
        Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => GraphemeSegmenter;
      }
    ).Segmenter;
    return Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  } catch {
    return null;
  }
})();

function findEscapeEnd(text: string, start: number): number {
  const type = text[start + 1];
  if (type === '[') {
    for (let i = start + 2; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i;
    }
    return text.length - 1;
  }

  if (type === ']') {
    for (let i = start + 2; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x07) return i;
      if (text[i] === '\x1b' && text[i + 1] === '\\') return i + 1;
    }
    return text.length - 1;
  }

  if (type === 'P' || type === '^' || type === '_' || type === 'X') {
    for (let i = start + 2; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x07) return i;
      if (text[i] === '\x1b' && text[i + 1] === '\\') return i + 1;
    }
    return text.length - 1;
  }

  return Math.min(start + 1, text.length - 1);
}

function sanitizePaneLineStyles(line: string): string {
  let result = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '\x1b') {
      result += line[i];
      continue;
    }

    const end = findEscapeEnd(line, i);
    const sequence = line.slice(i, end + 1);
    if (isSgrSequence(sequence)) {
      result += sequence;
    }
    i = end;
  }
  return result;
}

function isSgrSequence(sequence: string): boolean {
  return (
    sequence.length >= 3 &&
    sequence.charCodeAt(0) === 27 &&
    sequence[1] === '[' &&
    sequence.endsWith('m') &&
    /^[0-9;:]*$/.test(sequence.slice(2, -1))
  );
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    codePoint === 0x17b4 ||
    codePoint === 0x17b5 ||
    codePoint === 0x180e ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0x2060 ||
    codePoint === 0xfeff ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0483 && codePoint <= 0x0489) ||
    (codePoint >= 0x0591 && codePoint <= 0x05bd) ||
    codePoint === 0x05bf ||
    (codePoint >= 0x05c1 && codePoint <= 0x05c2) ||
    (codePoint >= 0x05c4 && codePoint <= 0x05c5) ||
    codePoint === 0x05c7 ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06dc) ||
    (codePoint >= 0x06df && codePoint <= 0x06e4) ||
    (codePoint >= 0x06e7 && codePoint <= 0x06e8) ||
    (codePoint >= 0x06ea && codePoint <= 0x06ed) ||
    codePoint === 0x0711 ||
    (codePoint >= 0x0730 && codePoint <= 0x074a) ||
    (codePoint >= 0x07a6 && codePoint <= 0x07b0) ||
    (codePoint >= 0x07eb && codePoint <= 0x07f3) ||
    (codePoint >= 0x0816 && codePoint <= 0x0819) ||
    (codePoint >= 0x081b && codePoint <= 0x0823) ||
    (codePoint >= 0x0825 && codePoint <= 0x0827) ||
    (codePoint >= 0x0829 && codePoint <= 0x082d) ||
    (codePoint >= 0x0859 && codePoint <= 0x085b) ||
    (codePoint >= 0x08d3 && codePoint <= 0x08e1) ||
    (codePoint >= 0x08e3 && codePoint <= 0x0902) ||
    (codePoint >= 0x093a && codePoint <= 0x093c) ||
    codePoint === 0x094d ||
    (codePoint >= 0x0951 && codePoint <= 0x0957) ||
    (codePoint >= 0x0962 && codePoint <= 0x0963) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function nextGrapheme(text: string, start: number): { value: string; nextIndex: number } {
  if (GRAPHEME_SEGMENTER) {
    const iterator = GRAPHEME_SEGMENTER.segment(text.slice(start))[Symbol.iterator]();
    const next = iterator.next();
    if (!next.done && next.value.segment) {
      return { value: next.value.segment, nextIndex: start + next.value.segment.length };
    }
  }

  const first = text.codePointAt(start);
  if (first === undefined) return { value: '', nextIndex: start + 1 };
  let value = String.fromCodePoint(first);
  let nextIndex = start + value.length;
  while (nextIndex < text.length) {
    const codePoint = text.codePointAt(nextIndex);
    if (codePoint === undefined || !isZeroWidthCodePoint(codePoint)) break;
    const mark = String.fromCodePoint(codePoint);
    value += mark;
    nextIndex += mark.length;
  }
  return { value, nextIndex };
}

function terminalCellWidth(grapheme: string): number {
  let hasVisible = false;
  let hasWide = false;
  for (let i = 0; i < grapheme.length; i++) {
    const codePoint = grapheme.codePointAt(i);
    if (codePoint === undefined) continue;
    if (codePoint > 0xffff) i++;
    if (isZeroWidthCodePoint(codePoint) || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      continue;
    }
    hasVisible = true;
    if (isWideCodePoint(codePoint)) hasWide = true;
  }
  if (!hasVisible) return 0;
  return hasWide ? 2 : 1;
}

function truncatePaneLineByVisibleColumns(line: string, maxColumns: number): string {
  let result = '';
  let visibleColumns = 0;
  let sawSgr = false;

  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const end = findEscapeEnd(line, i);
      const sequence = line.slice(i, end + 1);
      if (isSgrSequence(sequence)) {
        result += sequence;
        sawSgr = true;
      }
      i = end;
      continue;
    }

    const grapheme = nextGrapheme(line, i);
    const width = terminalCellWidth(grapheme.value);
    if (width === 0) {
      result += grapheme.value;
    } else if (visibleColumns + width <= maxColumns) {
      result += grapheme.value;
      visibleColumns += width;
    } else {
      break;
    }
    i = grapheme.nextIndex - 1;
    if (visibleColumns >= maxColumns) {
      continue;
    }
  }

  if (sawSgr) {
    result += '\x1b[0m';
  }
  return result;
}

/**
 * Normalize scrollback line endings to `\r\n` so a fresh xterm replays each line
 * at column 0 (COD-138).
 *
 * `capture-pane -p -e -S -` (full-history capture) joins scrollback rows with a
 * BARE `\n`. The browser xterm is created with the default `convertEol: false`
 * (correct for the live PTY stream, which already carries real `\r\n`), so a bare
 * `\n` drops a row without returning the cursor to column 0. Replaying that raw
 * buffer on a full page reload makes every line start one column further right —
 * the diagonal "staircase". The visible/tab-switch path avoids this by repainting
 * each row with an absolute cursor CSI (`formatPaneSnapshot`); the full-history
 * path returns raw scrollback, so it must be CRLF-normalized here.
 *
 * `\r?\n → \r\n` is idempotent on already-CRLF input and leaves a lone `\r` (an
 * intentional in-line column reset / overwrite) untouched.
 */
export function normalizeScrollbackEol(buffer: string): string {
  return buffer.replace(/\r?\n/g, '\r\n');
}

/** Pane geometry and caret position, as `display-message` reports them. */
interface PaneCursorGeometry {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
}

/**
 * Read the pane's cursor and size, or null when tmux cannot say.
 *
 * Every field is validated together: a caller that gets a value back can place
 * a caret with it, and one that gets null must not try.
 */
export function queryPaneCursor(run: () => string): PaneCursorGeometry | null {
  let raw: string;
  try {
    raw = run().trim();
  } catch (cursorErr) {
    console.error('[TmuxManager] Failed to query pane cursor after capture:', cursorErr);
    return null;
  }
  const [cursorX, cursorY, cols, rows] = raw.split(/\s+/).map((value) => parseInt(value, 10));
  if (
    !Number.isFinite(cursorX) ||
    !Number.isFinite(cursorY) ||
    !Number.isFinite(cols) ||
    !Number.isFinite(rows) ||
    cursorX < 0 ||
    cursorY < 0 ||
    cols <= 0 ||
    rows <= 0
  ) {
    return null;
  }
  return { cols, rows, cursorX, cursorY };
}

/** SGR attributes, which is all `capture-pane -e` emits. */
// eslint-disable-next-line no-control-regex
const CAPTURE_STYLE_SEQUENCE = /\x1b\[[0-9;:]*m/g;

/** Whether a capture holds anything a reader would see, styles discounted. */
export function hasVisibleContent(capture: string): boolean {
  return /\S/.test(capture.replace(CAPTURE_STYLE_SEQUENCE, ''));
}

/**
 * Put the caret back where the pane has it, counting UP from the bottom of what
 * was just replayed.
 *
 * Relative rather than absolute (`CUP`) on purpose. `\x1b[<row>;<col>H` numbers
 * rows from the top of the browser's screen, so it only lands correctly while
 * the browser's row count equals the pane's — and it need not, because
 * `resizeWindow` fires its tmux resize without waiting, so a capture can be
 * taken before a requested resize has been applied. Counting up from the last
 * replayed row is anchored to the content instead, which is the thing both ends
 * genuinely share.
 */
export function formatCursorRestore(geometry: PaneCursorGeometry): string {
  const up = Math.max(0, geometry.rows - 1 - geometry.cursorY);
  const right = Math.max(0, geometry.cursorX);
  // `\r` first so the column is known: the replay leaves the caret wherever the
  // last row's text ended.
  return `${up > 0 ? `\x1b[${up}A` : ''}\r${right > 0 ? `\x1b[${right}C` : ''}`;
}

export function formatPaneSnapshot(
  lines: string[],
  geometry: { cols: number; rows: number; cursorX: number; cursorY: number }
): string {
  const cols = Math.max(1, geometry.cols);
  // Paint the full pane width. Earlier this dropped the rightmost column
  // (cols - 1) out of caution about last-column autowrap, but every painted
  // row is immediately followed by an absolute cursor-position CSI (the next
  // row's `\x1b[r;1H`, or the final cursor move), which cancels xterm's
  // pending-wrap state before any further glyph — so the last column is safe.
  const paintCols = cols;
  const rows = Math.max(1, geometry.rows);
  const parts: string[] = [];
  for (let row = 0; row < Math.min(lines.length, rows); row++) {
    const safeLine = truncatePaneLineByVisibleColumns(sanitizePaneLineStyles(lines[row]), paintCols);
    parts.push(`\x1b[${row + 1};1H${safeLine}`);
  }
  const cursorX = Math.max(0, Math.min(cols - 1, geometry.cursorX));
  const cursorY = Math.max(0, Math.min(rows - 1, geometry.cursorY));
  parts.push(`\x1b[${cursorY + 1};${cursorX + 1}H`);
  return parts.join('');
}

/** Characters unsafe in paths — shell metacharacters, quotes, and control chars */
const UNSAFE_PATH_CHARS = /[;&|$`(){}<>'"\n\r]/;

/**
 * Validates that a session name contains only safe characters.
 * Prevents command injection via malformed session IDs.
 */
function isValidMuxName(name: string): boolean {
  return SAFE_MUX_NAME_PATTERN.test(name) || LEGACY_MUX_NAME_PATTERN.test(name);
}

function isValidTerminalDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 1000;
}

/**
 * Validates that a path contains only safe characters.
 * Prevents command injection via malformed paths.
 */
function isValidPath(path: string): boolean {
  if (UNSAFE_PATH_CHARS.test(path)) {
    return false;
  }
  if (path.includes('..')) {
    return false;
  }
  return SAFE_PATH_PATTERN.test(path);
}

// ===========================================================================
// Single-socket architecture: ALL Codeman sessions live on one dedicated tmux
// socket (`tmux -L codeman`), isolated from the user's default tmux server.
// The socket name is a process-wide constant (env-overridable for test/multi-
// instance isolation) — it is never stored per-session, so it cannot drift.
// ===========================================================================

/**
 * Resolve the process-wide Codeman tmux socket name. Always returns a valid
 * name: `CODEMAN_TMUX_SOCKET` env override if safe, else the built-in default.
 */
function resolveConfiguredTmuxSocket(): string {
  const raw = process.env.CODEMAN_TMUX_SOCKET ?? DEFAULT_CODEMAN_TMUX_SOCKET;
  if (!SAFE_TMUX_SOCKET_PATTERN.test(raw)) {
    console.warn(`[TmuxManager] Ignoring invalid CODEMAN_TMUX_SOCKET: ${JSON.stringify(raw)}`);
  }
  return resolveTmuxSocketName();
}

/** Build the `tmux -L <socket>` command prefix. Socket name is shell-escaped. */
function tmuxCommand(socket: string): string {
  return `tmux -L ${shellescape(socket)}`;
}

/**
 * Build Claude CLI permission flags for the tmux command string.
 * Validates allowedTools to prevent command injection.
 */
function buildClaudePermissionFlags(claudeMode?: ClaudeMode, allowedTools?: string): string {
  const mode = claudeMode || 'dangerously-skip-permissions';
  switch (mode) {
    case 'dangerously-skip-permissions':
      return ' --dangerously-skip-permissions';
    case 'auto':
      return ' --permission-mode auto';
    case 'allowedTools':
      if (allowedTools) {
        // Sanitize: allow tool names with patterns like Bash(git:*), space/comma-separated
        // Block shell metacharacters: ; & | $ ` \ { } < > ' " newlines
        const hasDangerousChars = /[;&|$`\\{}<>'"[\]\n\r]/.test(allowedTools);
        if (!hasDangerousChars) {
          return ` --allowedTools "${allowedTools}"`;
        }
      }
      // Fall back to normal mode if tools are invalid or missing
      return '';
    case 'normal':
      return '';
  }
}

/**
 * Build the codex CLI command.
 *
 * Kept as a named wrapper purely because callers (and `test/tmux-manager.test.ts`) reach for
 * it directly; the command itself is registry data now, like every other CLI's. The `??`
 * fallback covers a registry in which codex has been disabled or removed — this function
 * promises a string, so it degrades to the bare binary rather than throwing.
 */
export function buildCodexCommand(config?: CodexConfig): string {
  const entry = getCli('codex');
  if (!entry) return 'codex';
  return buildSpawnCommandFromRegistry(entry, { mode: 'codex', sessionId: '', codexConfig: config }) ?? 'codex';
}

export function buildSpawnCommand(options: {
  mode: SessionMode;
  sessionId: string;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
  codexConfig?: CodexConfig;
  geminiConfig?: GeminiConfig;
  antigravityConfig?: AntigravityConfig;
  piConfig?: PiConfig;
  grokConfig?: GrokConfig;
  deepSeekConfig?: DeepSeekConfig;
  ompConfig?: OmpConfig;
  resumeSessionId?: string;
  effort?: EffortLevel;
  /** Codeman session name, passed to claude as `--name` (version-gated, sanitized; local spawns only). */
  sessionName?: string;
  /**
   * Claude CLI version for the `--name` gate. Omitted = probe the local CLI
   * (getClaudeCliVersion; null under vitest). Tests inject a value here; the
   * docker/remote paths never see this builder's output, which is what keeps the
   * gate measuring the RIGHT binary, the local one.
   */
  claudeCliVersion?: string | null;
}): string {
  // Every CLI's command shape is registry DATA, rendered by the argv engine — see
  // config/cli-registry/argv.ts for why config can never contain shell text. A `shell`-kind
  // entry (or an unregistered mode) renders `undefined` and falls through to the local
  // login-shell resolution below, which cannot be templated because it varies per user.
  const entry = getCli(options.mode);
  if (entry) {
    const rendered = buildSpawnCommandFromRegistry(entry, options);
    if (rendered !== undefined) return rendered;
  }
  // #208: NOT the literal '$SHELL'. This string is embedded in the `bash -c "…"`
  // argument of the respawn-pane line, which execSync runs through `/bin/sh -c`,
  // so a `$SHELL` here is expanded by the SERVER process's shell against the
  // SERVER process's env — empty in containers and system systemd units, leaving
  // the pane command ending in a dangling `&&` ("syntax error: unexpected end of
  // file", pane dead on arrival). Resolve it in Node and quote the result.
  // #209: launch it as a LOGIN shell, which is what tmux itself does for a pane
  // with no `default-command`, so a Codeman shell tab matches a hand-started tmux
  // one. That is what picks up /etc/profile and /etc/profile.d/* — a systemd
  // --user service never sourced them, so its PATH is what every pane inherited.
  // The flags come from loginShellArgs() rather than being hardcoded: they are
  // appended to a path that ultimately comes from the passwd entry, and a shell
  // that rejects an unknown flag exits on the spot, which is #208 all over again.
  const shell = resolveLocalShell();
  return `${shellescape(shell)}${loginShellArgs(shell)}`;
}

/**
 * Dedicated socket for Codeman-launched REMOTE tmux servers, distinct from the
 * canonical local `-L codeman` socket. A remote host that runs its OWN Codeman
 * would otherwise share the `-L codeman` socket AND the `codeman-<hex>` discovery
 * name, so its `reconcileSessions()` would ADOPT our session (attach a PTY,
 * resize, respawn-pane it locally) — the cross-machine form of the "2nd instance
 * attaches live sessions" hazard. A private socket keeps our remote sessions off
 * that instance's radar entirely.
 */
const REMOTE_TMUX_SOCKET = 'codeman-remote';

/**
 * Deterministic, reattach-stable remote tmux session name for a Codeman session.
 *
 * Derived from the same stable field the LOCAL muxName uses (the first 8 chars of
 * the sessionId), so reconnecting (which re-issues the exact same
 * `ssh … new-session -A`) lands back in the SAME remote session. Must NOT be
 * random/time-based — it has to be stable across reconnects.
 *
 * The `codeman-ssh-` prefix is deliberately chosen to FAIL a remote Codeman's
 * `SAFE_MUX_NAME_PATTERN` (`^codeman-[a-f0-9-]+$`) — the `s`/`h` letters mean a
 * remote instance's discovery never treats this as one of its own sessions (belt
 * to the dedicated-socket suspenders above).
 */
export function remoteTmuxSessionName(sessionId: string): string {
  return `codeman-ssh-${sessionId.slice(0, 8)}`;
}

/**
 * COD-104 — build the SSH command that launches (or reattaches) a remote
 * session INSIDE a tmux server on the remote host, so the remote agent survives
 * an SSH drop.
 *
 * Emits:
 *   ssh -o BatchMode=yes -t [<COD-107 connection opts>] user@host \
 *     'tmux -L codeman-remote new-session -A -s codeman-ssh-<id> -c <path> "cd <path> && exec <cli>" \
 *        \; set -t codeman-ssh-<id> status off \; set -t codeman-ssh-<id> mouse off \
 *        \; set -t codeman-ssh-<id> prefix C-q \; set -s escape-time 0'
 *
 * COD-107 — the connection options (`-p`, `-i`, `-J`, SOCKS `-o ProxyCommand`,
 * arbitrary `-o`) come from the shared `buildSshConnectionArgs(remote)`, so the
 * prereq tmux probe and this launch connect with identical options.
 *
 * - `new-session -A -s codeman-ssh-<id>` = attach-if-exists-else-create
 *   (idempotent), so reconnect re-runs the same command and reattaches the
 *   still-running agent.
 * - `-L codeman-remote` = a DEDICATED socket, NOT the canonical `-L codeman` a
 *   remote Codeman would use, so our session never collides with / gets adopted by
 *   an instance running on the remote host.
 * - The `set` options are scoped per-session (`set -t <name>` / server-level
 *   `set -s`), never `-g`, so they never mutate other sessions' prefix/mouse.
 * - The whole tmux invocation is a SINGLE ssh argument (the remote login shell
 *   runs it), so it is shell-quoted as one unit; the `cd && exec` command is in
 *   turn a single tmux argument (tmux runs it via `/bin/sh -c`), so the path is
 *   shell-quoted inside it too. This keeps escaping correct through every layer
 *   even when the remote path contains spaces.
 */
export function buildRemoteLaunchCommand(options: {
  mode: SessionMode;
  remote: SessionRemote;
  sessionId: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
}): string {
  const { mode, remote, sessionId, claudeMode, allowedTools } = options;
  // §6.3: honor the session's EFFECTIVE claude permission mode on remote instead of
  // hardcoding --dangerously-skip-permissions, so a non-granted multi-user user's
  // downgraded 'auto' actually reaches the remote agent (the default command otherwise
  // ignored claudeMode). A per-host `commands.claude` override stays authoritative
  // (admin's explicit choice). Wrapped in `$SHELL -i -l -c` for the same reason as
  // `defaultRemoteCommandForMode`: `claude` lives under a per-user PATH entry that
  // only an interactive login shell resolves (see that function's comment).
  const override = remote.commands?.[mode];
  const modeCommand = override
    ? override
    : mode === 'claude'
      ? remoteLoginShellCommand(`claude${buildClaudePermissionFlags(claudeMode, allowedTools)}`)
      : defaultRemoteCommandForMode(mode);
  const remoteName = remoteTmuxSessionName(sessionId);

  // Innermost: the command tmux runs in the new pane. Run via `/bin/sh -c` by
  // tmux, so the path needs shell-quoting here. `exec` replaces the shell with
  // the CLI so the pane PID is the agent itself.
  const paneCommand = `cd ${shellescape(remote.remotePath)} && ${modeCommand}`;

  // The tmux command line, with `\;` separating commands so the config `set`s
  // apply on the SAME connection (and are idempotent on reattach). Options are
  // scoped per-session (`set -t <name>` / server `set -s`), NEVER `-g`, so a
  // shared remote tmux server's other sessions keep their own prefix/mouse.
  const tmuxInvocation = [
    `tmux -L ${REMOTE_TMUX_SOCKET} new-session -A -s ${remoteName} -c ${shellescape(remote.remotePath)} ${shellescape(paneCommand)}`,
    `set -t ${remoteName} status off`,
    `set -t ${remoteName} mouse off`,
    `set -t ${remoteName} prefix C-q`,
    'set -s escape-time 0',
    // COD-106 — shared/collaborative sessions: tmux defaults to sizing a window
    // to the SMALLEST attached client, so two Codemans at different viewports
    // would fight (clamp to the smaller). `window-size latest` sizes to the
    // most-recently-active client instead, so concurrent clients coexist.
    // Per-session scoped (`set -t <name>`, matching #145's hardening) so a shared
    // remote tmux server's other sessions keep their own sizing behavior.
    `set -t ${remoteName} window-size latest`,
    // #210: keep a CRASHED pane so the failure is still on screen. Without this,
    // tmux destroys the pane -> window -> session (and, being the only session,
    // the whole remote server) the instant the pane command exits, which tears the
    // local `ssh -t` attach down with it; reconnect's `-A` then builds a fresh
    // session and the cycle can repeat as a flap loop with no evidence surviving.
    // That is how the exit-127 PATH bug fixed above stayed invisible.
    //
    // `failed`, NOT `on`: `on` keeps the pane on a CLEAN exit too, so typing
    // `exit` in a remote shell leaves a dead pane behind, the session outlives it,
    // and the next launch's `-A` reattaches to that corpse ("Pane is dead (status
    // 0)") instead of starting a shell — verified against a real tmux. `failed`
    // keeps the pane only on a non-zero exit, which is exactly the diagnostic case.
    //
    // LAST in the chain on purpose: tmux aborts the remaining commands of a `\;`
    // sequence once one errors (also verified), and `failed` needs tmux >= 3.2 on
    // the REMOTE host. Trailing, a rejection costs only this option; leading, it
    // would silently drop status/mouse/prefix/escape-time/window-size with it.
    `set -t ${remoteName} remain-on-exit failed`,
  ].join(' \\; ');

  // ssh runs its trailing args through the remote login shell, so the entire
  // tmux invocation is passed as one shell-quoted argument.
  //
  // COD-107 — connection options (port, identity, SOCKS ProxyCommand, jump host,
  // arbitrary -o) come from the shared `buildSshConnectionArgs` so the launch and
  // the tmux-prereq probe connect IDENTICALLY. `-t` is inserted right after
  // `ssh -o BatchMode=yes` (preserving the historical token order), then the rest
  // of the connection args, then the target and the quoted tmux invocation.
  const [ssh, batchMode, ...connectionArgs] = buildSshConnectionArgs(remote);
  const sshParts = [ssh, batchMode, '-t', ...connectionArgs, remoteSshTarget(remote), shellescape(tmuxInvocation)];
  return sshParts.join(' ');
}

/**
 * Build the SSH command that kills the durable remote tmux session created by
 * `buildRemoteLaunchCommand`. Because that session lives on a private socket
 * (`-L codeman-remote`) under a stable name, killing the LOCAL ssh wrapper alone
 * would orphan the remote agent forever (invisible to Codeman, still burning plan
 * quota). This is fired best-effort on session kill; the shared connection args
 * carry the default `-o ConnectTimeout=10` so an unreachable host fails fast.
 */
export function buildRemoteKillCommand(options: { remote: SessionRemote; sessionId: string }): string {
  const { remote, sessionId } = options;
  const remoteName = remoteTmuxSessionName(sessionId);
  const killCmd = `tmux -L ${REMOTE_TMUX_SOCKET} kill-session -t ${shellescape(remoteName)}`;
  const [ssh, ...connectionArgs] = buildSshConnectionArgs(remote);
  return [ssh, ...connectionArgs, remoteSshTarget(remote), shellescape(killCmd)].join(' ');
}

// ========== Docker cases (COD-Docker) ==========
//
// The docker analog of the remote-SSH launch above. Instead of a local tmux pane
// running `ssh -t host 'tmux new-session …'`, it runs `docker exec -it <container>
// sh -lc 'tmux new-session …'` into a DURABLE in-container tmux server. The
// container is per-CASE, so many sessions `docker exec` into the same one. See
// docs/docker-cases-plan.md.

/**
 * DEDICATED in-container tmux socket. A Codeman running INSIDE the container uses
 * `-L codeman`; ours is `-L codeman-docker` with a `codeman-dkr-*` session name
 * that deliberately FAILS SAFE_MUX_NAME_PATTERN, so an in-container Codeman never
 * adopts/resizes/respawns our session (same defence as the remote socket).
 */
const DOCKER_TMUX_SOCKET = 'codeman-docker';
/**
 * Deterministic, reattach-stable in-container tmux session name. Derived from the
 * same stable field the local muxName uses (first 8 chars of the sessionId), so a
 * reconnect re-issues the exact same `new-session -A` and lands back in the SAME
 * in-container session. The `dkr` letters make it fail SAFE_MUX_NAME_PATTERN.
 */
export function dockerTmuxSessionName(sessionId: string): string {
  return `codeman-dkr-${sessionId.slice(0, 8)}`;
}

/** Resume ids are UUID-ish; reject anything with shell metacharacters (defensive). */
const RESUME_ID_SAFE = /^[A-Za-z0-9._-]+$/;

/**
 * Append the CLI-specific resume flag to a pane command (codex/gemini/antigravity). Only fires
 * when the in-container tmux is RE-CREATED (`new-session -A` makes the flag inert
 * on a live reattach), i.e. exactly when the previous live agent was lost and we
 * want to resume the conversation from the bind-mounted transcript. Claude mode
 * uses claudeDockerPaneCommand instead.
 */
function appendResumeFlag(modeCommand: string, mode: SessionMode, resumeId: string): string {
  if (!RESUME_ID_SAFE.test(resumeId)) return modeCommand;
  // The append-only sibling of the full launch spec: this bolts a resume onto an ALREADY
  // built command, for the docker "the in-container tmux was re-created" path. An entry with
  // no `resumeAppend` has no resume form to append (shell, opencode — opencode's docker
  // resume rides its own config object instead).
  const append = getCli(mode)?.launch.resumeAppend;
  if (!append) return modeCommand;
  return append.style === 'flag'
    ? `${modeCommand} ${append.flag} ${resumeId}`
    : `${modeCommand} ${append.token} ${resumeId}`;
}

/**
 * Claude-mode pane command with a DETERMINISTIC conversation id (the docker analog
 * of buildSpawnCommand's --resume/--session-id logic). A fresh launch passes
 * `--session-id <sessionId>`, so the in-container conversation id is knowable
 * host-side (resume-id capture + subagent/workflow correlation) WITHOUT relying on
 * hook reachability. When the in-container tmux was re-created after a container
 * stop/reboot, the same command re-runs against the surviving transcript:
 * `--session-id` exits 1 ("already in use") and the `||` fallback RESUMES that
 * conversation (verified CLI behavior). An explicit resumeId gets the local
 * builder's shape — resume first, session-id fallback — so a stale id never
 * dead-panes. The leading `exec ` is stripped: an exec'd first branch could never
 * fall back.
 */
function claudeDockerPaneCommand(modeCommand: string, sessionId: string, resumeId?: string): string {
  if (!RESUME_ID_SAFE.test(sessionId)) return modeCommand; // defensive — ids are server-minted uuids
  const cmd = modeCommand.replace(/^exec\s+/, '');
  const rid = resumeId && RESUME_ID_SAFE.test(resumeId) ? resumeId : undefined;
  if (rid && rid !== sessionId) {
    return `${cmd} --resume ${rid} || ${cmd} --session-id ${sessionId}`;
  }
  const cid = rid ?? sessionId;
  return `${cmd} --session-id ${cid} || ${cmd} --resume ${cid}`;
}

/** Fully-resolved inputs for buildDockerLaunchCommand (pure). */
export interface DockerLaunchOptions {
  mode: SessionMode;
  docker: SessionDocker;
  sessionId: string;
  resumeSessionId?: string;
  createContext: DockerCreateContext;
  /** exec-time inline env (non-secret): TERM, COLORTERM, CODEMAN_SESSION_ID, CODEMAN_MUX */
  execEnv: Record<string, string>;
  /** exec-time NAME-ONLY env forwarded from Codeman's process env (codex/gemini keys) */
  execEnvNames: string[];
  /**
   * Files to copy from read-only seed mounts into the container's writable HOME once
   * before launch (guarded so reconnects never clobber). Isolates Claude state: the
   * merged `~/.claude.json`, plus `~/.claude/.credentials.json` + `settings.json`,
   * are writable copies (not host mounts), so the container never re-auths and never
   * writes its runtime state back into the host `~/.claude`.
   */
  seedCopies?: DockerSeedCopy[];
}

/**
 * Build the ONE `bash -c` launch string for a docker session: image-check ->
 * ensure (inspect-or-create) -> start -> `exec docker exec -it` into the durable
 * in-container tmux (resume-aware). PURE and unit-testable. The escaping survives
 * four layers: outer `bash -c "…"` (JSON.stringify at respawn-pane) -> the joined
 * command -> `docker exec … sh -lc '<tmux>'` -> tmux `'<paneCommand>'`.
 */
export function buildDockerLaunchCommand(opts: DockerLaunchOptions): string {
  const { mode, docker, sessionId, resumeSessionId, createContext, execEnv, execEnvNames, seedCopies } = opts;
  const base = buildDockerBaseArgs(docker).join(' ');
  // ADOPTED container (docker.owned === false): the user built it and runs it, so
  // this chain may only LOOK and then exec. No image check (the image is theirs),
  // no create, and above all no `start` — starting a container we do not own is
  // exactly the lifecycle mutation adoption promises never to perform. A missing
  // or stopped container fails closed with an actionable message instead.
  const adopted = docker.owned === false;
  // Built lazily: an adopted case has no meaningful create-config, so computing
  // create args for it would demand a context the adopt path never assembles.
  const createArgs = adopted ? '' : buildDockerCreateArgs(createContext).join(' ');
  const name = shellescape(docker.containerName);
  const workdir = shellescape(docker.containerWorkdir);
  const image = shellescape(docker.image);
  const dkrName = dockerTmuxSessionName(sessionId);
  const sid = sessionId.slice(0, 8);

  let modeCommand =
    docker.commands?.[mode as DockerCommandMode] || defaultDockerCommandForMode(mode, !!docker.runsAsRoot);
  if (mode === 'claude') {
    modeCommand = claudeDockerPaneCommand(modeCommand, sessionId, resumeSessionId);
  } else if (resumeSessionId) {
    modeCommand = appendResumeFlag(modeCommand, mode, resumeSessionId);
  }
  // Run by tmux via /bin/sh -c, so the path is shell-quoted here. `exec` makes the
  // pane PID the agent itself.
  const paneCommand = `cd ${workdir} && ${modeCommand}`;

  // `setenv -g` primes the session id so reattaches / newly-created panes inherit
  // it. `new-session -A` = attach-or-create (idempotent + resume-aware). Options
  // are scoped per-session (`set -t`) or server (`set -s`), never `-g`, so a shared
  // in-container tmux server's other sessions keep their own prefix/mouse.
  const tmuxInvocation = [
    `tmux -L ${DOCKER_TMUX_SOCKET} setenv -g CODEMAN_SESSION_ID ${shellescape(sid)}`,
    'setenv -g CODEMAN_MUX 1',
    `new-session -A -s ${dkrName} -c ${workdir} ${shellescape(paneCommand)}`,
    `set -t ${dkrName} status off`,
    `set -t ${dkrName} mouse off`,
    `set -t ${dkrName} prefix C-q`,
    'set -s escape-time 0',
  ].join(' \\; ');

  const execEnvFlags: string[] = [];
  for (const [k, v] of Object.entries(execEnv)) execEnvFlags.push('--env', shellescape(`${k}=${v}`));
  // NAME-ONLY forwards: docker reads the VALUE from Codeman's own process env, so
  // the secret never appears in argv (no `ps` leak) and is not committed.
  for (const n of execEnvNames) execEnvFlags.push('--env', n);
  for (const extra of docker.extraExecArgs ?? []) execEnvFlags.push(shellescape(extra));

  const imageMissingMsg = shellescape(
    `Codeman: base image ${docker.image} not present (it is normally auto-built on first use)`
  );
  const startFailMsg = shellescape(`Codeman: container ${docker.containerName} failed to start (docker daemon down?)`);

  const notFoundMsg = shellescape(
    `Codeman: container ${docker.containerName} not found. Adopted containers are never created by Codeman - start it yourself, then reopen this session.`
  );
  const notRunningMsg = shellescape(
    `Codeman: container ${docker.containerName} is not running. Codeman never starts a container it does not own - start it yourself, then reopen this session.`
  );

  const imageCheck = adopted
    ? ''
    : `${base} image inspect ${image} >/dev/null 2>&1 || { echo ${imageMissingMsg}; exit 1; }`;
  // create-if-missing (idempotent): reconnect / boot recovery re-runs this exact
  // chain. A daemon without swap accounting warns whenever --memory is present,
  // even when --memory-swap is omitted. In compatibility mode, retain the memory
  // cap and filter ONLY that exact warning; all other stdout/stderr and the real
  // create exit status are preserved so mount/config failures remain visible.
  // A session-unique file avoids shell variables and command substitution, both
  // of which would be expanded too early by the nested bash/tmux launch layers.
  const createOutputPath = shellescape(`/tmp/codeman-create-${sessionId}.log`);
  const filteredCreateOutput = `sed '/^WARNING: Your kernel does not support swap limit capabilities or the cgroup is not mounted\\. Memory limited without swap\\.$/d' ${createOutputPath}`;
  const removeCreateOutput = `rm -f ${createOutputPath}`;
  const createCommand = createContext.disableSwapLimit
    ? `{ if ${base} ${createArgs} >${createOutputPath} 2>&1; ` +
      `then ${filteredCreateOutput}; ${removeCreateOutput}; ` +
      `elif ${base} inspect ${name} >/dev/null 2>&1; then ${removeCreateOutput}; ` +
      `else ${filteredCreateOutput} >&2; ${removeCreateOutput}; false; fi; }`
    : `${base} ${createArgs}`;
  const ensure = adopted
    ? `${base} inspect ${name} >/dev/null 2>&1 || { echo ${notFoundMsg}; exit 1; }`
    : `${base} inspect ${name} >/dev/null 2>&1 || ${createCommand}`;
  // ⚠️ No double quotes and no `$(…)` in the ADOPTED arms. This whole chain is
  // embedded in an outer `bash -c "…"`, so an unescaped `"` closes that string early,
  // the rest is re-tokenized, and tmux fails to exec with a bare `execvp(3) failed`.
  // A `grep -qx` pipeline reads the same answer using only the single-quoted form
  // every other line in this builder already uses.
  const start = adopted
    ? `${base} inspect -f ${shellescape('{{.State.Running}}')} ${name} 2>/dev/null | grep -qx true || { echo ${notRunningMsg}; exit 1; }`
    : `${base} start ${name} >/dev/null 2>&1 || { echo ${startFailMsg}; exit 1; }`;
  // Seed writable credential config from read-only host mounts ONCE per container
  // (guarded by [ -e ] so reconnects never clobber in-container config; `cp -a` for
  // whole-dir credential seeds). mkdir -p the parent so a file seed works even when
  // no sibling share-mount pre-created the dir. Paths are fixed CONTAINER_HOME
  // constants (no shell metachars), so the whole inner command is shell-quoted once.
  // An ADOPTED container gets NO seed copies: those read from create-time
  // read-only mounts that do not exist here, and writing host credentials into a
  // container the user owns is a mutation adoption does not permit. Its CLIs must
  // already be authenticated inside it.
  const seedSteps = (adopted ? [] : (seedCopies ?? [])).map((s) => {
    const cp = s.recursive ? 'cp -a' : 'cp';
    const parent = s.to.slice(0, s.to.lastIndexOf('/'));
    return `mkdir -p ${parent} 2>/dev/null; [ -e ${s.to} ] || ${cp} ${s.from} ${s.to} 2>/dev/null || true`;
  });
  const innerCmd = seedSteps.length ? `${seedSteps.join(' ; ')} ; ${tmuxInvocation}` : tmuxInvocation;
  const execCmd = `exec ${base} exec -it --workdir ${workdir} ${execEnvFlags.join(' ')} ${name} sh -lc ${shellescape(innerCmd)}`;

  return [imageCheck, ensure, start, execCmd].filter(Boolean).join(' ; ');
}

/**
 * Kill ONLY this session's in-container tmux session. The container is shared by
 * the case's other sessions, so this NEVER `docker stop`s it — stopping/removing
 * the container is an explicit teardown (buildDockerStopCommand) or case-delete
 * (buildDockerRemoveCommand). Fired best-effort on session kill.
 */
export function buildDockerKillCommand(options: { docker: SessionDocker; sessionId: string }): string {
  const { docker, sessionId } = options;
  const base = buildDockerBaseArgs(docker).join(' ');
  const dkrName = dockerTmuxSessionName(sessionId);
  return `${base} exec ${shellescape(docker.containerName)} tmux -L ${DOCKER_TMUX_SOCKET} kill-session -t ${shellescape(dkrName)}`;
}

/**
 * Guard for the two builders that mutate CONTAINER lifecycle. They are pure
 * string builders, so refusing here means an adopted container cannot even have
 * a stop/remove command constructed for it — there is no shape of caller bug
 * that turns into a `docker stop`/`rm` on something we do not own.
 */
function assertOwnedContainer(docker: SessionDocker, action: string): void {
  if (docker.owned === false) {
    throw new Error(
      `Refusing to ${action} adopted container "${docker.containerName}": Codeman does not own its lifecycle.`
    );
  }
}

/** Explicit container stop (frees RAM/CPU; conversation resumes on next launch via --resume). */
export function buildDockerStopCommand(docker: SessionDocker): string {
  assertOwnedContainer(docker, 'stop');
  return `${buildDockerBaseArgs(docker).join(' ')} stop -t 10 ${shellescape(docker.containerName)}`;
}

/** Explicit container removal (case-delete). Destroys in-image state; bind mounts survive. */
export function buildDockerRemoveCommand(docker: SessionDocker): string {
  assertOwnedContainer(docker, 'remove');
  return `${buildDockerBaseArgs(docker).join(' ')} rm -f ${shellescape(docker.containerName)}`;
}

/**
 * Resolve the environment-dependent bits of a docker launch (host uid, existing
 * credential mounts, derived api url, hook-secret mount, Desktop detection) into
 * the pure buildDockerLaunchCommand inputs. IO; only ever called from the real
 * launch path (createSession/respawnPane no-op under VITEST).
 */
export function resolveDockerLaunchOptions(
  mode: SessionMode,
  docker: SessionDocker,
  sessionId: string,
  resumeSessionId?: string
): DockerLaunchOptions {
  const home = homedir();
  const isDesktop = process.platform === 'darwin'; // Docker Desktop translates uids + native host.docker.internal
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const userArgs: string[] =
    docker.engine === 'podman'
      ? ['--userns=keep-id'] // rootless podman: map host uid to the image `agent` uid
      : isDesktop
        ? [] // Desktop: run as the image's baked uid (a mac uid wouldn't own /home/agent)
        : ['--user', `${uid}:0`]; // Linux: host uid + GID 0 (OpenShift arbitrary-uid writable HOME)
  const gatewayAlias = hostGatewayAlias(docker.engine);

  const credentialMounts: DockerMount[] = [];
  const extraMounts: DockerMount[] = [];
  // Isolated credential state (Claude + codex/gemini/gcloud/opencode): each store
  // shares ONLY what a host feature / --resume needs (Claude projects/, codex
  // sessions/+history) and seeds everything else (tokens, settings, configs) as
  // writable copies, so the container is authed WITHOUT re-auth and WITHOUT writing
  // its runtime state back into the host dirs. Only when credentials are mounted.
  let seedCopies: DockerSeedCopy[] = [];
  if (docker.mountCredentials) {
    const claudeArtifacts = resolveDockerClaudeArtifacts(home, docker.containerName, docker.containerWorkdir);
    const credArtifacts = resolveDockerCredentialArtifacts(home);
    extraMounts.push(...claudeArtifacts.mounts, ...credArtifacts.mounts);
    seedCopies = [...claudeArtifacts.seedCopies, ...credArtifacts.seedCopies];
  }
  const envCreate: Record<string, string> = {
    HOME: CONTAINER_HOME,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Force a UTF-8 locale (the base image defaults to POSIX/C). Without this, tmux
    // runs in non-UTF-8 mode and renders Claude's Unicode box-drawing (─│┌┐) as raw
    // VT100 ACS glyphs (`qqqq…`). `C.UTF-8` is built into glibc (no locale-gen).
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    // Give claude a temp dir it will own inside HOME. Its default `/tmp/claude-<uid>`
    // is refused when that path pre-exists root-owned — which happens when the
    // workspace bind-mount path traverses it (e.g. a workspace under /tmp/claude-<uid>).
    // A nonexistent HOME subpath is created+owned by the running uid, so this is robust
    // to any workspace location. Non-secret path, safe to be committed on export.
    CLAUDE_CODE_TMPDIR: `${CONTAINER_HOME}/.cache/codeman-claude-tmp`,
  };
  if (docker.hooksEnabled) {
    // Derive a container-reachable API url (scheme + port preserved; host swapped
    // for the engine gateway alias). Prod is HTTPS on 3000.
    envCreate.CODEMAN_API_URL = containerApiUrl(process.env.CODEMAN_API_URL, docker.engine);
    const hookSecretPath = dataPath('hook-secret');
    if (existsSync(hookSecretPath)) {
      const dst = `${CONTAINER_HOME}/.codeman/hook-secret`;
      extraMounts.push({ src: hookSecretPath, dst, readonly: true });
      envCreate.CODEMAN_HOOK_SECRET_FILE = dst; // a path is non-secret; the bytes ride the bind mount
    }
  }

  const createContext: DockerCreateContext = {
    docker,
    sessionId,
    instance: CODEMAN_INSTANCE,
    userArgs,
    credentialMounts: credentialMounts.map((mount) => ({
      ...mount,
      src: resolveDockerDaemonMountSource(mount.src, home, process.env.CODEMAN_DOCKER_HOST_HOME),
    })),
    extraMounts: extraMounts.map((mount) => ({
      ...mount,
      src: resolveDockerDaemonMountSource(mount.src, home, process.env.CODEMAN_DOCKER_HOST_HOME),
    })),
    envCreate,
    addHostGateway: !isDesktop,
    gatewayAlias,
    disableSwapLimit: process.env.CODEMAN_DOCKER_DISABLE_SWAP_LIMIT === '1',
  };

  const execEnv: Record<string, string> = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // UTF-8 at exec time too, so the tmux CLIENT this exec launches is UTF-8 and
    // renders box-drawing correctly even when reattaching to a container created
    // before this fix (client_utf8 is per-client, resolved from the exec's locale).
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CODEMAN_SESSION_ID: sessionId.slice(0, 8),
    CODEMAN_MUX: '1',
  };
  // NAME-ONLY exec env forwarded from Codeman's process env (the docker client
  // inherits it), so API-key CLIs get their key without it appearing in argv.
  const execEnvNames = getCli(mode)?.env.dockerExecEnvNames ?? [];

  return { mode, docker, sessionId, resumeSessionId, createContext, execEnv, execEnvNames, seedCopies };
}

/**
 * COD-105 — build the SSH command that ATTACHES to an EXISTING `codeman-*` tmux
 * session on the remote host (one this Codeman didn't create — discovered via
 * `listRemoteCodemanSessions`). Sibling of `buildRemoteLaunchCommand`.
 *
 * Emits:
 *   ssh -o BatchMode=yes -t [<COD-107 connection opts>] user@host \
 *     'tmux -L codeman attach -t <session>'
 *
 * - `attach` (NOT `new-session -A`) so we only join an existing session; the
 *   remote session keeps running independent of us, which is exactly why the
 *   resulting Codeman session is NON-OWNED (see `SessionRemote.owned`): closing
 *   the local tab must detach, never `kill-session` the remote.
 * - The remote session name is shell-escaped so a value with metachars stays a
 *   single token inside the quoted tmux invocation.
 * - COD-107 — connection options (`-p`, `-i`, `-J`, SOCKS `-o ProxyCommand`,
 *   arbitrary `-o`) come from the shared `buildSshConnectionArgs`, so attach
 *   connects identically to launch / discovery / the prereq probe. `-t` sits
 *   right after `ssh -o BatchMode=yes` (a PTY is required for interactive tmux).
 */
export function buildRemoteAttachCommand(remote: SessionRemote, remoteSessionName: string): string {
  const tmuxInvocation = `tmux -L codeman attach -t ${shellescape(remoteSessionName)}`;
  const [ssh, batchMode, ...connectionArgs] = buildSshConnectionArgs(remote);
  const sshParts = [ssh, batchMode, '-t', ...connectionArgs, remoteSshTarget(remote), shellescape(tmuxInvocation)];
  return sshParts.join(' ');
}

/**
 * COD-105 — choose the right remote ssh command for a session's ownership:
 *   - NON-owned (`remote.owned === false`): ATTACH to a discovered remote tmux
 *     session by its EXISTING name (`remote.remoteSessionName`, falling back to
 *     this session's deterministic name). We only join — never create.
 *   - owned (default): LAUNCH/attach-or-create via `buildRemoteLaunchCommand`
 *     (COD-104), which we then own and may explicitly kill.
 */
function buildRemoteSessionCommand(options: {
  mode: SessionMode;
  remote: SessionRemote;
  sessionId: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
}): string {
  const { remote, sessionId } = options;
  if (remote.owned === false) {
    const target = remote.remoteSessionName || remoteTmuxSessionName(sessionId);
    return buildRemoteAttachCommand(remote, target);
  }
  return buildRemoteLaunchCommand(options);
}

/**
 * Push one environment variable into a tmux session with `setenv`.
 *
 * ⚠️ `setenv` rather than the spawn command line is the whole point: a value set this way is
 * inherited by panes but never appears in `ps` output or tmux history, so an API key cannot
 * be read by every other process on the box. Nothing that carries a secret may move to the
 * command line.
 *
 * A failure is deliberately swallowed — a key the CLI does not need is not an error, and a
 * CLI that does need it will say so far more usefully than a spawn failure here would.
 */
function setTmuxEnvVar(tmuxCmd: string, muxName: string, key: string, value: string): void {
  // Shell-escape: wrap in single quotes, escape any inner single quotes.
  const escaped = value.replace(/'/g, "'\\''");
  try {
    execSync(`${tmuxCmd} setenv -t '${muxName}' ${key} '${escaped}'`, {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    /* Non-critical — key may not be needed */
  }
}

/**
 * Forward this CLI's declared sensitive env vars from the SERVER's own environment into the
 * tmux session. Names come from `env.tmuxSetenvKeys`; values are never in config.
 *
 * Was three near-identical per-CLI functions whose only difference was the key list.
 */
function setCliSensitiveEnvVars(tmuxCmd: string, muxName: string, keys: readonly string[]): void {
  for (const key of keys) {
    const val = process.env[key];
    if (val) setTmuxEnvVar(tmuxCmd, muxName, key, val);
  }
}

/**
 * Implementations of the named profiles a CLI may select via `env.setenvProfile` — the escape
 * hatch for setup that genuinely needs to RUN CODE rather than name a list of env keys.
 *
 * Keyed by PROFILE NAME, never by CLI id: a second launcher-style CLI adds an entry here and
 * names it from its registry entry, and nothing else in this file learns about it. The names
 * themselves are declared (and schema-validated at load) in `config/cli-registry/profiles.ts`.
 *
 * Returns the env vars to set; the caller does the actual `tmux setenv` calls.
 */
const SETENV_PROFILES: Record<
  string,
  (sessionId: string, entry: CliEntry, rawConfig?: Record<string, unknown>) => Record<string, string>
> = {
  /**
   * DeepSeek's Herdr-compatible status bridge.
   *
   * Pointing `HERDR_BIN_PATH` at our own generated shim is what upgrades this mode from
   * output-stabilization guessing to DEFINITIVE idle/working/blocked events (see
   * deepseek-status-shim.ts). The pane id IS the Codeman session id, which is how the shim
   * attributes a report without trusting anything the agent could influence.
   *
   * Needs a profile rather than key names because it writes an executable to disk and then
   * exports that file's path — neither a name list nor a config value could express it.
   */
  'deepseek-status-bridge': (sessionId, entry, rawConfig) => {
    // Opt-OUT, not opt-in: an absent flag means the bridge is armed, so a caller who says
    // nothing gets the better signals. Only an explicit `false` disarms it, which is exactly
    // what `hooksAvailableForMode()` reads to decide whether `stop` can ever fire.
    const field = entry.launch.legacyConfigAliases?.statusReporting ?? 'statusReporting';
    if (rawConfig?.[field] === false) return {};
    const shim = ensureDeepSeekStatusShim();
    if (!shim) return {};
    const vars: Record<string, string> = { HERDR_ENV: '1', HERDR_BIN_PATH: shim, HERDR_PANE_ID: sessionId };
    return vars;
  },
};

/**
 * Set a CLI's JSON config-content env var on a tmux session via setenv.
 *
 * The var NAME comes from `env.configContentVar` rather than being hardcoded, so this is not
 * an opencode special case — but opencode is its only user today. `setenv` (rather than the
 * command line) is what keeps user-supplied JSON away from shell metacharacter parsing.
 */
function setCliConfigContent(tmuxCmd: string, muxName: string, varName: string, config?: OpenCodeConfig): void {
  if (!config) return;

  let jsonContent: string | undefined;

  if (config.autoAllowTools) {
    const permConfig: Record<string, unknown> = { permission: { '*': 'allow' } };
    if (config.configContent) {
      try {
        const existing = JSON.parse(config.configContent) as Record<string, unknown>;
        Object.assign(permConfig, existing);
        permConfig.permission = { '*': 'allow' };
      } catch {
        /* invalid JSON, use default permConfig */
      }
    }
    jsonContent = JSON.stringify(permConfig);
  } else if (config.configContent) {
    // Validate JSON to prevent garbage config
    try {
      JSON.parse(config.configContent);
      jsonContent = config.configContent;
    } catch {
      console.error('[TmuxManager] Invalid JSON in openCodeConfig.configContent, skipping');
      return;
    }
  }

  if (jsonContent) setTmuxEnvVar(tmuxCmd, muxName, varName, jsonContent);
}

/**
 * Manages tmux sessions that wrap Claude CLI or shell processes.
 *
 * Implements the TerminalMultiplexer interface.
 *
 * @example
 * ```typescript
 * const manager = new TmuxManager();
 *
 * // Create a tmux session for Claude
 * const session = await manager.createSession({ sessionId, workingDir: '/project', mode: 'claude' });
 *
 * // Send input (single command, no delay!)
 * manager.sendInput(sessionId, '/clear\r');
 *
 * // Kill when done
 * await manager.killSession(sessionId);
 * ```
 */
export class TmuxManager extends EventEmitter implements TerminalMultiplexer {
  readonly backend = 'tmux' as const;
  private sessions: Map<string, MuxSession> = new Map();
  private readonly tmuxSocket = resolveConfiguredTmuxSocket();
  private statsInterval: NodeJS.Timeout | null = null;
  private mouseSyncInterval: NodeJS.Timeout | null = null;
  /** Track last-known pane count per session to avoid unnecessary tmux set-option calls */
  private lastPaneCount: Map<string, number> = new Map();

  // ── COD-108 remote-reconnect watcher state ────────────────────────────────
  /** Periodic watcher that re-establishes dropped remote sessions. */
  private remoteReconnectInterval: NodeJS.Timeout | null = null;
  /** Per-session backoff/attempt bookkeeping (sessionId → state). */
  private reconnectState: Map<string, RemoteReconnectState> = new Map();
  /**
   * Sessions excluded from auto-reconnect because they are being intentionally
   * torn down (killed/detached/stopping). A guarded session is NEVER revived.
   */
  private reconnectGuard: Set<string> = new Set();
  /**
   * Cached result of the remote tmux `has-session` probe (sessionId → alive).
   * `true` = the durable remote tmux session exists (transport drop → reconnect
   * is safe); `false` = remote session gone (agent exited cleanly → do NOT
   * reconnect); `undefined` = not yet probed / probe failed. Only sessions
   * whose pane is otherwise dead+eligible get probed, so a clean exit tears
   * down the remote tmux and the probe reports false — killing the auto-revive
   * (found live 2026-08-29: remote omp/opencode ctrl-c/ctrl-d auto-respawned
   * fresh agents because the watcher couldn't tell a clean exit from a
   * transport drop).
   */
  private remoteAliveCache: Map<string, boolean | undefined> = new Map();
  /**
   * Sessions with a `has-session` probe currently in flight. The probe is a
   * fire-and-forget ssh round-trip with a 15s timeout against a 5s tick, so
   * without this an unreachable host would accumulate three overlapping ssh
   * processes per dead session.
   */
  private remoteAliveInFlight: Set<string> = new Set();

  private trueColorConfigured = false;
  /** tmux 3.7+ can resize pane history after creation; older releases cannot. */
  private liveHistoryResizeSupported: boolean | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
    if (!IS_TEST_MODE) {
      this.loadSessions();
    }
  }

  /** The dedicated tmux socket all Codeman sessions live on (see {@link TerminalMultiplexer.muxSocket}). */
  get muxSocket(): string {
    return this.tmuxSocket;
  }

  private tmux(): string {
    return tmuxCommand(this.tmuxSocket);
  }

  private supportsLiveHistoryResize(): boolean {
    if (this.liveHistoryResizeSupported !== null) return this.liveHistoryResizeSupported;

    try {
      const output = execSync(`${this.tmux()} -V`, {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = output.match(/(?:^|\D)(\d+)\.(\d+)/);
      const major = match ? Number(match[1]) : 0;
      const minor = match ? Number(match[2]) : 0;
      this.liveHistoryResizeSupported = major > 3 || (major === 3 && minor >= 7);
    } catch {
      // Unknown versions take the legacy path required by tmux <3.7.
      this.liveHistoryResizeSupported = false;
    }
    return this.liveHistoryResizeSupported;
  }

  // Load saved sessions from disk (NEVER called in test mode)
  private loadSessions(): void {
    if (IS_TEST_MODE) return;

    try {
      if (existsSync(MUX_SESSIONS_FILE)) {
        const content = readFileSync(MUX_SESSIONS_FILE, 'utf-8');
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          // Dedup by muxName: one live tmux session must map to exactly one
          // tracked entry. A per-session socket-tag mismatch could historically
          // let the same session be tracked twice — once under its real UUID and
          // once under a "restored-<id>" placeholder — surfacing as duplicate tabs.
          // Single-socket unification removed that failure mode; this pass stays
          // to clean any stale duplicates already on disk. Keep the real (UUID)
          // entry and drop placeholder twins.
          let dropped = 0;
          const keptByMuxName = new Map<string, string>(); // muxName -> kept sessionId
          for (const session of data) {
            // Strip the obsolete per-session tmuxSocket tag (now a process-wide
            // constant). Left in place it would be written back by saveSessions()
            // and linger on disk as a zombie field forever.
            delete (session as { tmuxSocket?: unknown }).tmuxSocket;
            const muxName: string | undefined = session.muxName;
            const priorId = muxName ? keptByMuxName.get(muxName) : undefined;
            if (priorId) {
              const incomingIsPlaceholder = String(session.sessionId).startsWith('restored-');
              const priorIsPlaceholder = priorId.startsWith('restored-');
              // Drop the incoming unless it's the real twin of a placeholder we kept.
              if (incomingIsPlaceholder || !priorIsPlaceholder) {
                dropped++;
                continue;
              }
              this.sessions.delete(priorId);
              dropped++;
            }
            this.sessions.set(session.sessionId, session);
            if (muxName) keptByMuxName.set(muxName, session.sessionId);
          }
          // Persist the cleaned list so the stale duplicates don't reload.
          if (dropped > 0) {
            console.log(`[TmuxManager] Dropped ${dropped} duplicate mux session record(s) on load`);
            this.saveSessions();
          }
        }
      }
    } catch (err) {
      console.error('[TmuxManager] Failed to load sessions:', err);
    }
  }

  /**
   * Save sessions to disk asynchronously. (NEVER writes in test mode)
   * Uses atomic temp+rename to prevent corruption on crash.
   */
  private saveSessions(): void {
    if (IS_TEST_MODE) return;

    try {
      const dir = dirname(MUX_SESSIONS_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.sessions.values());
      const json = JSON.stringify(data, null, 2);

      const tempPath = MUX_SESSIONS_FILE + '.tmp';
      writeFile(tempPath, json, 'utf-8')
        .then(() => rename(tempPath, MUX_SESSIONS_FILE))
        .catch((err) => {
          console.error('[TmuxManager] Failed to save sessions:', err);
        });
    } catch (err) {
      console.error('[TmuxManager] Failed to save sessions:', err);
    }
  }

  /**
   * Build the array of environment export commands shared by createSession() and respawnPane().
   * Includes locale, mux markers, session identity, and API URL.
   *
   * User-supplied envOverrides are NOT inlined here — they go through applyEnvOverrides()
   * via `tmux setenv` so secret values (e.g., OPENCODE_API_KEY) never appear in the bash
   * command line (visible in `ps`). This also sidesteps shell-metachar injection via keys.
   */
  private buildEnvExports(sessionId: string, muxName: string, mode: SessionMode): string[] {
    const entry = getCli(mode);

    // Per-CLI colour/identity vars, straight from the entry. `unset` before `export` is
    // arbitrary: these are independent bash statements joined by ` && `, so nothing here
    // depends on another's value and the order carries no semantics.
    const cliEnv: string[] = [];
    for (const name of entry?.env.unset ?? []) cliEnv.push(`unset ${name}`);
    for (const item of entry?.env.exports ?? []) {
      // Values are either literals validated against the shell-token pattern at load, or an
      // engine value produced here — never free text from config.
      const value =
        typeof item.value === 'string'
          ? item.value
          : item.value.engine === 'codemanPrefixedSessionId'
            ? `codeman_${sessionId}`
            : item.value.engine === 'sessionId'
              ? sessionId
              : item.value.engine === 'muxName'
                ? muxName
                : undefined;
      // A CLI stamping a per-pane originator (codex) is what lets the response viewer find
      // THIS pane's rollout exactly; without it, rollouts are matched by cwd+mtime and two
      // panes in the same directory bleed into each other.
      if (value !== undefined) cliEnv.push(`export ${item.name}=${value}`);
    }

    return [
      'export LANG=en_US.UTF-8',
      'export LC_ALL=en_US.UTF-8',
      ...cliEnv,
      'export CODEMAN_MUX=1',
      `export CODEMAN_SESSION_ID=${sessionId}`,
      `export CODEMAN_MUX_NAME=${muxName}`,
      // Only exported when the server has stamped the real URL (scheme+host+port,
      // set in WebServer.start()). A hardcoded fallback here exported the wrong
      // scheme on HTTPS installs; leaving the variable unset makes in-session
      // guards fail closed instead of curling a URL that was never right.
      ...(process.env.CODEMAN_API_URL ? [`export CODEMAN_API_URL=${process.env.CODEMAN_API_URL}`] : []),
      // Path only (not the secret value): hook curl commands cat the file at
      // execution time, so the COD-54 hook secret stays off the command line.
      `export CODEMAN_HOOK_SECRET_FILE="${dataPath('hook-secret')}"`,
    ];
  }

  /**
   * Apply user-supplied env overrides to a tmux session via `tmux setenv`.
   * Values stay off the bash command line (not visible in `ps`), and are inherited
   * by new panes — including `respawn-pane`. Persists at tmux-session level, so
   * Codeman server restarts don't lose the setting as long as the tmux session lives.
   *
   * Key validation is strict (`/^[A-Z_][A-Z0-9_]*$/`) as defense-in-depth against
   * shell-metachar injection even if upstream schema check is bypassed.
   */
  private applyEnvOverrides(muxName: string, envOverrides?: Record<string, string>): void {
    // Legacy cleanup: pre-0.7.2 set CLAUDE_CODE_EFFORT_LEVEL via setenv, which persists
    // on the tmux session and hard-locks /effort switching in every respawned pane.
    // Effort now flows as a `--settings` soft default (see buildEffortSettingsFlag),
    // so unconditionally unset the stale var before applying current overrides.
    try {
      execSync(`${this.tmux()} setenv -t ${shellescape(muxName)} -u CLAUDE_CODE_EFFORT_LEVEL`, {
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      /* Non-critical — var may not exist */
    }
    if (!envOverrides) return;
    const VALID_KEY = /^[A-Z_][A-Z0-9_]*$/;
    for (const [key, value] of Object.entries(envOverrides)) {
      if (!value) continue; // Skip empty — nothing to set
      if (!VALID_KEY.test(key)) {
        console.warn(`[TmuxManager] Skipping invalid env override key: ${JSON.stringify(key)}`);
        continue;
      }
      try {
        execSync(`${this.tmux()} setenv -t ${shellescape(muxName)} ${key} ${shellescape(value)}`, {
          timeout: EXEC_TIMEOUT_MS,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        console.warn(`[TmuxManager] Failed to set env override ${key}:`, err);
      }
    }
  }

  /**
   * Resolve the CLI binary directory and return the PATH export prefix string.
   * Returns '' if no override is needed (shell mode) or the binary dir is not found.
   * In createSession(), a missing binary dir throws — the caller handles that separately.
   */
  private buildPathExport(mode: SessionMode): { pathExport: string; dir: string | null } {
    // Prepending the resolved bin dir is what makes a CLI installed somewhere the server's
    // own PATH does not cover (nvm, Homebrew, ~/.local/bin under a systemd unit) reachable
    // from inside the pane. `shell` and any unregistered mode resolve to null and get
    // nothing prepended.
    const dir = resolveCliBinDir(mode);
    return { pathExport: dir ? `export PATH="${dir}:$PATH" && ` : '', dir };
  }

  /**
   * Configure this CLI's environment on a tmux session, entirely from registry data.
   *
   * Four independent pieces, all via `tmux setenv` so they are inherited by the pane without
   * ever appearing in `ps`:
   *
   * 1. `env.tmuxSetenvKeys` — sensitive vars forwarded from the SERVER's own environment
   *    (API keys, CLI home dirs). Names only ever live in config; values never do.
   * 2. `env.configSetenv` — vars whose value comes from the caller's config rather than the
   *    server env. DeepSeek's `DSH_PERMISSION_MODE` is the case this exists for: its
   *    permission switch is an env var, not a flag. Routing it through a declared launch
   *    param is what lets the ordinary multi-user clamp reach it.
   * 3. `env.configContentVar` — a JSON config blob (opencode).
   * 4. `env.setenvProfile` — genuinely code-shaped setup. DeepSeek's status bridge writes an
   *    executable shim to disk and exports its path plus this session's pane id, which is
   *    what upgrades that mode from output-stabilization guessing to definitive hook events.
   *
   * Called UNCONDITIONALLY for every mode: an entry with no keys, no config var and no
   * profile does nothing here, which is a better shape than four `if (mode === ...)` guards
   * that each had to be remembered at two separate call sites.
   */
  private _configureCliEnv(
    muxName: string,
    sessionId: string,
    mode: SessionMode,
    rawConfig?: Record<string, unknown>
  ): void {
    const entry = getCli(mode);
    if (!entry) return;
    const tmuxCmd = this.tmux();

    setCliSensitiveEnvVars(tmuxCmd, muxName, entry.env.tmuxSetenvKeys);

    for (const [key, value] of Object.entries(configSetenvValues(entry, rawConfig))) {
      setTmuxEnvVar(tmuxCmd, muxName, key, value);
    }

    if (entry.env.configContentVar) {
      setCliConfigContent(tmuxCmd, muxName, entry.env.configContentVar, rawConfig as OpenCodeConfig | undefined);
    }

    const profileName = entry.env.setenvProfile;
    if (profileName) {
      const profile = SETENV_PROFILES[profileName];
      // A name the schema accepted but this build does not implement: skip rather than
      // throw. Losing a status bridge degrades signal quality; failing here would refuse
      // the session outright.
      if (profile) {
        for (const [key, value] of Object.entries(profile(sessionId, entry, rawConfig))) {
          setTmuxEnvVar(tmuxCmd, muxName, key, value);
        }
      }
    }
  }

  /**
   * Creates a new tmux session wrapping Claude CLI or a shell.
   * In test mode: creates an in-memory session only (no real tmux session).
   */
  async createSession(options: CreateSessionOptions): Promise<MuxSession> {
    const {
      sessionId,
      workingDir,
      mode,
      name,
      niceConfig,
      model,
      claudeMode,
      allowedTools,
      openCodeConfig,
      codexConfig,
      geminiConfig,
      antigravityConfig,
      piConfig,
      grokConfig,
      deepSeekConfig,
      ompConfig,
      resumeSessionId,
      envOverrides,
      effort,
      historyLimit = DEFAULT_TMUX_HISTORY_LIMIT,
      remote,
      docker,
      owner,
    } = options;
    const muxName = `codeman-${sessionId.slice(0, 8)}`;

    if (!isValidMuxName(muxName)) {
      throw new Error('Invalid session name: contains unsafe characters');
    }
    if (!isValidPath(workingDir)) {
      throw new Error('Invalid working directory path: contains unsafe characters');
    }

    // TEST MODE: Create in-memory session only — no real tmux session
    if (IS_TEST_MODE) {
      const session: MuxSession = {
        sessionId,
        muxName,
        pid: 99999,
        createdAt: Date.now(),
        workingDir,
        remote,
        docker,
        owner,
        mode,
        attached: false,
        name,
      };
      this.sessions.set(sessionId, session);
      this.emit('sessionCreated', session);
      return session;
    }

    // Resolve CLI binary directory based on mode. The not-found messages come
    // from the resolvers (formatCliNotFoundMessage) so the error names WHERE it
    // looked — server PATH, login shell, checked directories — instead of just
    // asserting the CLI is missing (the classic systemd/launchd PATH trap).
    const { pathExport, dir: cliDir } = this.buildPathExport(mode);
    // Refuse the spawn rather than launching a pane that dies on `command not found`.
    // `missingCliMessage()` returns null for a mode with no binary to find (`shell`), and
    // carries bounded PATH/login-shell/search-dir diagnostics so the error says where we
    // actually looked.
    //
    // ⚠️ Skipped entirely for a DOCKER session: the CLI runs INSIDE the container, so the
    // host does not need it at all. Demanding it here threw for a host without the binary,
    // the catch fell back to a direct PTY, and that PTY tried to exec the CLI on the HOST —
    // surfacing as a bare `execvp(3) failed: No such file or directory` with nothing
    // pointing at the real cause. The container's own CLIs are verified by the adoption
    // preflight / image gate before launch instead.
    const cliRunsInContainer = !!docker;
    if (!cliRunsInContainer && !cliDir) {
      const message = missingCliMessage(mode);
      if (message) throw new Error(message);
    }

    const envExportsStr = this.buildEnvExports(sessionId, muxName, mode).join(' && ');

    const baseCmd = buildSpawnCommand({
      mode,
      sessionId,
      model,
      claudeMode,
      allowedTools,
      openCodeConfig,
      codexConfig,
      geminiConfig,
      antigravityConfig,
      piConfig,
      grokConfig,
      deepSeekConfig,
      ompConfig,
      resumeSessionId,
      effort,
      sessionName: name,
    });

    const config = niceConfig || DEFAULT_NICE_CONFIG;
    const cmd = wrapWithNice(baseCmd, config);

    try {
      // Build the full command to run inside tmux
      const localFullCmd = `${buildNofileLimitCommand()} && ${pathExport}${envExportsStr} && ${cmd}`;
      const fullCmd = docker
        ? buildDockerLaunchCommand(resolveDockerLaunchOptions(mode, docker, sessionId, resumeSessionId))
        : remote
          ? buildRemoteSessionCommand({ mode, remote, sessionId, claudeMode, allowedTools })
          : localFullCmd;

      // Create tmux session in three steps to handle cold-start (no server running)
      // and avoid the race where the command exits before remain-on-exit is set:
      // 2. Set remain-on-exit (server now exists, session won't vanish on exit)
      // 3. Replace shell with actual command via respawn-pane (no terminal echo)
      // Unset $TMUX so nested sessions work when the dev server itself runs inside tmux.
      // (Production uses systemd which has a clean env, but dev/test may be nested.)
      const cleanEnv = { ...process.env };
      delete cleanEnv.TMUX;
      // Create the session on the dedicated socket (${this.tmux()} = `tmux -L <socket>`),
      // launched in TMUX_LAUNCH_CWD (/tmp) rather than the real workingDir: a FUSE/rclone
      // mount that isn't ready yet makes `getcwd` fail and breaks the spawn (see #110). The
      // pane cd's into workingDir below via respawn-pane.
      // tmux <3.7 allocates history only at pane creation, so its global default
      // must be set immediately BEFORE new-session. tmux 3.7+ can resize a pane
      // after creation; target only the new session there because changing the
      // global option can resize (and when lowered, trim) unrelated live panes.
      const safeHistoryLimit =
        Number.isSafeInteger(historyLimit) && historyLimit > 0 ? Math.trunc(historyLimit) : DEFAULT_TMUX_HISTORY_LIMIT;
      const createSessionCommand = this.supportsLiveHistoryResize()
        ? `${this.tmux()} new-session -ds "${muxName}" -c ${TMUX_LAUNCH_CWD} \\; set-option -t "${muxName}" history-limit ${safeHistoryLimit}`
        : `${this.tmux()} set-option -g history-limit ${safeHistoryLimit} \\; new-session -ds "${muxName}" -c ${TMUX_LAUNCH_CWD} \\; set-option -t "${muxName}" history-limit ${safeHistoryLimit}`;
      execSync(createSessionCommand, {
        cwd: TMUX_LAUNCH_CWD,
        timeout: EXEC_TIMEOUT_MS,
        stdio: 'ignore',
        env: cleanEnv,
      });
      this.resizeWindow(muxName, 120, 40);

      // Set remain-on-exit now that the server is running — must be before respawn-pane
      try {
        execSync(`${this.tmux()} set-option -t "${muxName}" remain-on-exit on`, {
          timeout: EXEC_TIMEOUT_MS,
          stdio: 'ignore',
        });
      } catch {
        /* Non-critical */
      }

      // Per-CLI env: API keys, config blobs, config-sourced vars, status bridges. All of
      // it is registry data, so this is one unconditional call rather than a per-mode ladder.
      this._configureCliEnv(
        muxName,
        sessionId,
        mode,
        legacyConfigForMode(mode, options as unknown as Record<string, unknown>)
      );

      // Apply user-supplied env overrides (e.g., CLAUDE_CODE_EFFORT_LEVEL) via tmux setenv
      // so secret values stay off the bash command line. Must run before respawn-pane.
      this.applyEnvOverrides(muxName, envOverrides);

      // Replace the shell with the actual command (no echo in terminal). Keep
      // pane launch in /tmp, then cd inside bash against the current mount table.
      const launchCmd = remote || docker ? fullCmd : `cd ${JSON.stringify(workingDir)} && ${fullCmd}`;
      execSync(
        `${this.tmux()} respawn-pane -k -c ${TMUX_LAUNCH_CWD} -t "${muxName}" bash -c ${JSON.stringify(launchCmd)}`,
        {
          timeout: EXEC_TIMEOUT_MS,
          stdio: 'ignore',
        }
      );

      // Wait for tmux session to be queryable
      await new Promise((resolve) => setTimeout(resolve, TMUX_CREATION_WAIT_MS));

      // Non-critical tmux config — run in parallel to avoid blocking event loop.
      // These configure UX niceties (no status bar, true color).
      // Mouse mode is OFF by default so xterm.js handles text selection natively.
      // It gets enabled dynamically when panes are split (agent teams).
      const configPromises: Promise<void>[] = [
        // Disable tmux status bar — Codeman's web UI provides session info
        execAsync(`${this.tmux()} set-option -t "${muxName}" status off`, { timeout: EXEC_TIMEOUT_MS })
          .then(() => {})
          .catch(() => {
            /* Non-critical — session still works with status bar */
          }),
        // Override global remain-on-exit with session-level setting
        execAsync(`${this.tmux()} set-option -t "${muxName}" remain-on-exit on`, { timeout: EXEC_TIMEOUT_MS })
          .then(() => {})
          .catch(() => {
            /* Already set globally as fallback */
          }),
      ];

      // Enable 24-bit true color passthrough — server-wide, set once per lifetime
      if (!this.trueColorConfigured) {
        configPromises.push(
          execAsync(`${this.tmux()} set-option -sa terminal-overrides ",*:Tc"`, { timeout: EXEC_TIMEOUT_MS })
            .then(() => {
              this.trueColorConfigured = true;
            })
            .catch(() => {
              /* Non-critical — colors limited to 256 */
            })
        );
      }

      // Fire-and-forget — these are non-critical UX niceties that don't need
      // to complete before the session is usable. Errors are already swallowed.
      void Promise.all(configPromises);

      // Get the PID of the pane process (retry for tmux server cold-start)
      let pid = this.getPanePid(muxName);
      for (let i = 0; !pid && i < GET_PID_MAX_RETRIES; i++) {
        await new Promise((resolve) => setTimeout(resolve, GET_PID_RETRY_MS));
        pid = this.getPanePid(muxName);
      }
      if (!pid) {
        throw new Error('Failed to get tmux pane PID');
      }

      const session: MuxSession = {
        sessionId,
        muxName,
        pid,
        createdAt: Date.now(),
        workingDir,
        remote,
        docker,
        owner,
        mode,
        attached: false,
        name,
      };

      this.sessions.set(sessionId, session);
      this.saveSessions();
      this.emit('sessionCreated', session);

      return session;
    } catch (err) {
      throw new Error(`Failed to create tmux session: ${getErrorMessage(err)}`);
    }
  }

  /**
   * Get the PID of the process running in the tmux pane.
   */
  private getPanePid(muxName: string): number | null {
    if (IS_TEST_MODE) return 99999;

    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in getPanePid:', muxName);
      return null;
    }

    try {
      const output = execSync(`${this.tmux()} display-message -t "${muxName}" -p '#{pane_pid}'`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      }).trim();
      const pid = parseInt(output, 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Check if a tmux session exists.
   */
  muxSessionExists(muxName: string): boolean {
    return this.sessionExists(muxName);
  }

  /**
   * Check if the pane in a tmux session is dead (command exited but remain-on-exit keeps it).
   * Returns true if the session exists but the pane's command has exited.
   */
  isPaneDead(muxName: string): boolean {
    if (IS_TEST_MODE) return false;
    if (!isValidMuxName(muxName)) return false;
    try {
      const output = execSync(`${this.tmux()} display-message -t "${muxName}" -p '#{pane_dead}'`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      }).trim();
      return output === '1';
    } catch {
      return false;
    }
  }

  /**
   * Respawn a dead pane in an existing tmux session.
   * Uses `tmux respawn-pane -k` to restart the command in the same pane,
   * preserving the session and its scrollback buffer.
   */
  async respawnPane(options: RespawnPaneOptions): Promise<number | null> {
    const {
      sessionId,
      workingDir,
      mode,
      niceConfig,
      model,
      claudeMode,
      allowedTools,
      openCodeConfig,
      codexConfig,
      geminiConfig,
      antigravityConfig,
      piConfig,
      grokConfig,
      deepSeekConfig,
      ompConfig,
      resumeSessionId,
      envOverrides,
      effort,
      remote,
      docker,
      name,
    } = options;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const muxName = session.muxName;

    if (!isValidMuxName(muxName) || !isValidPath(workingDir)) return null;

    // Resolve CLI binary directory based on mode
    const { pathExport } = this.buildPathExport(mode);

    const envExportsStr = this.buildEnvExports(sessionId, muxName, mode).join(' && ');

    const baseCmd = buildSpawnCommand({
      mode,
      sessionId,
      model,
      claudeMode,
      allowedTools,
      openCodeConfig,
      codexConfig,
      geminiConfig,
      antigravityConfig,
      piConfig,
      grokConfig,
      deepSeekConfig,
      ompConfig,
      resumeSessionId,
      effort,
      sessionName: name,
    });
    const config = niceConfig || DEFAULT_NICE_CONFIG;
    const cmd = wrapWithNice(baseCmd, config);
    const localFullCmd = `${buildNofileLimitCommand()} && ${pathExport}${envExportsStr} && ${cmd}`;
    const fullCmd = docker
      ? buildDockerLaunchCommand(resolveDockerLaunchOptions(mode, docker, sessionId, resumeSessionId))
      : remote
        ? buildRemoteSessionCommand({ mode, remote, sessionId, claudeMode, allowedTools })
        : localFullCmd;

    try {
      // Same per-CLI env setup as createSession, re-applied so the respawned pane inherits it.
      this._configureCliEnv(
        muxName,
        sessionId,
        mode,
        legacyConfigForMode(mode, options as unknown as Record<string, unknown>)
      );

      // Re-apply user env overrides before respawn so the new shell inherits them.
      this.applyEnvOverrides(muxName, envOverrides);

      // -c /tmp + cd bounce — see createSession() for rationale (stale FUSE state).
      const launchCmd = remote || docker ? fullCmd : `cd ${JSON.stringify(workingDir)} && ${fullCmd}`;
      await execAsync(
        `${this.tmux()} respawn-pane -k -c ${TMUX_LAUNCH_CWD} -t "${muxName}" bash -c ${JSON.stringify(launchCmd)}`,
        {
          timeout: EXEC_TIMEOUT_MS,
        }
      );
      // Wait for the respawned process to start
      await new Promise((resolve) => setTimeout(resolve, TMUX_CREATION_WAIT_MS));
      const pid = this.getPanePid(muxName);
      if (pid) session.pid = pid;
      return pid;
    } catch (err) {
      console.error('[TmuxManager] Failed to respawn pane:', err);
      return null;
    }
  }

  private sessionExists(muxName: string): boolean {
    if (IS_TEST_MODE) return false;
    if (!isValidMuxName(muxName)) return false;

    try {
      execSync(`${this.tmux()} has-session -t "${muxName}" 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** One `ps` snapshot of the whole process table, cached briefly. */
  private static procSnapshot: { at: number; byParent: Map<number, number[]> } | null = null;
  /** Single-flight guard so a hung `ps` cannot pile up parallel refreshes. */
  private static procRefresh: { started: number; promise: Promise<Map<number, number[]>> } | null = null;

  /**
   * Fork ONE `ps` asynchronously and cache the parent -> children map.
   *
   * Async on purpose: a synchronous fork here would block the event loop on every
   * stats tick, and under the procfs pathology this module exists to survive,
   * `execSync`'s timeout cannot return at all (spawnSync waits for the unkillable
   * child) — freezing the whole server where a hung async poll only costs staleness.
   */
  private static refreshProcSnapshot(): Promise<Map<number, number[]>> {
    const inFlight = TmuxManager.procRefresh;
    // Reuse an in-flight refresh — unless it is old enough to be presumed stuck.
    if (inFlight && Date.now() - inFlight.started < EXEC_TIMEOUT_MS * 2) return inFlight.promise;

    const started = Date.now();
    const promise = new Promise<Map<number, number[]>>((resolve) => {
      execFile('ps', ['-eo', 'pid=,ppid='], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (TmuxManager.procRefresh?.started === started) TmuxManager.procRefresh = null;
        if (err) {
          // ANY error, not just an empty one: a timed-out or truncated `ps` yields
          // partial output, and caching that as fresh would make whole subtrees
          // invisible — including to the kill path. Stale beats wrong.
          console.error('[TmuxManager] process snapshot failed:', err);
          resolve(TmuxManager.procSnapshot?.byParent ?? new Map());
          return;
        }
        const byParent = new Map<number, number[]>();
        for (const line of String(out).split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) continue;
          const pid = parseInt(parts[0], 10);
          const ppid = parseInt(parts[1], 10);
          if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
          const list = byParent.get(ppid);
          if (list) list.push(pid);
          else byParent.set(ppid, [pid]);
        }
        TmuxManager.procSnapshot = { at: Date.now(), byParent };
        resolve(byParent);
      });
    });
    TmuxManager.procRefresh = { started, promise };
    return promise;
  }

  /**
   * Best snapshot WITHOUT forking: returns the cache, kicking off a background
   * refresh when it has gone stale, and never blocks. Stats and window-title
   * consumers tolerate data one interval old; nothing that KILLS may use this.
   */
  private childrenByParent(): Map<number, number[]> {
    const cached = TmuxManager.procSnapshot;
    if (!cached || Date.now() - cached.at >= PROC_SNAPSHOT_TTL_MS) {
      void TmuxManager.refreshProcSnapshot();
    }
    return cached?.byParent ?? new Map();
  }

  /**
   * Descendants from a snapshot that is not the cached one — the kill path's variant.
   *
   * killSession re-scans for survivors between SIGTERM and SIGKILL, and the wait in
   * between (200ms) sits far inside the cache TTL (2000ms): reading the cache there
   * returns the pre-SIGTERM state verbatim, so children spawned since are invisible
   * and SIGKILL aims at stale PIDs, guarded only by kill(pid, 0) — which cannot
   * detect PID reuse.
   *
   * It forces a refresh rather than guaranteeing recency: an already-running refresh
   * is reused, so the snapshot can predate this call by up to one `ps` runtime. A
   * strict postdate guarantee would mean chaining a second `ps` behind every
   * in-flight one, which is the fork storm this code exists to avoid.
   *
   * Bounded by design: waiting forever would freeze killSession before it reaches
   * its process-group and tmux fallbacks.
   */
  private async getChildPidsFresh(pid: number): Promise<number[]> {
    let byParent: ReadonlyMap<number, readonly number[]>;
    try {
      byParent = await Promise.race([
        TmuxManager.refreshProcSnapshot(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('proc snapshot timeout')), PROC_SNAPSHOT_WAIT_MS)
        ),
      ]);
    } catch {
      console.warn('[TmuxManager] process snapshot did not return in time; using the cached one');
      byParent = TmuxManager.procSnapshot?.byParent ?? new Map<number, number[]>();
    }
    return collectDescendants(pid, byParent, {
      onTruncated: (root, cap, reason) =>
        console.warn(`[TmuxManager] descendant walk for ${root} hit the ${cap}-${reason} cap; truncating`),
    });
  }

  // Check if a process is still alive
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Verify all PIDs are dead, with retry
  private async verifyProcessesDead(pids: number[], maxWaitMs: number = 1000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 100;

    while (Date.now() - startTime < maxWaitMs) {
      const aliveCount = pids.filter((pid) => this.isProcessAlive(pid)).length;
      if (aliveCount === 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    const stillAlive = pids.filter((pid) => this.isProcessAlive(pid));
    if (stillAlive.length > 0) {
      console.warn(`[TmuxManager] ${stillAlive.length} processes still alive after kill: ${stillAlive.join(', ')}`);
    }
    return stillAlive.length === 0;
  }

  /**
   * Kill a tmux session and all its child processes.
   * Uses a 4-strategy approach (children → process group → tmux kill → SIGKILL).
   * In test mode: removes from memory only (no real kill).
   */
  async killSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // COD-108: an intentional kill/detach must NEVER be auto-revived by the
    // remote-reconnect watcher. Guard BEFORE any teardown so a tick that fires
    // mid-kill (especially the non-owned DETACH early-return below, where the
    // dead local pane would otherwise look reconnectable) sees the guard.
    this.guardRemoteReconnect(sessionId);

    // TEST MODE: Remove from memory only — NEVER touch real tmux sessions
    if (IS_TEST_MODE) {
      this.sessions.delete(sessionId);
      this.clearRemoteReconnectState(sessionId);
      this.emit('sessionKilled', { sessionId });
      return true;
    }

    // SAFETY: Never kill the tmux session we're running inside of
    const currentMuxName = process.env.CODEMAN_MUX_NAME;
    if (currentMuxName && session.muxName === currentMuxName) {
      console.error(`[TmuxManager] BLOCKED: Refusing to kill own tmux session: ${session.muxName}`);
      return false;
    }

    // COD-105 — DETACH-NOT-KILL for NON-owned remote sessions.
    //
    // When this session was created by ATTACHING a remote tmux session another
    // Codeman owns (`remote.owned === false`), closing the tab must NOT propagate
    // a remote `tmux kill-session` — that would nuke work the remote's own
    // Codeman (or another instance) still relies on. We tear down ONLY the LOCAL
    // pane that holds the ssh client: killing the local ssh sends SIGHUP to its
    // remote `tmux attach`, which DETACHES (the durable remote session survives).
    //
    // This early return is the structural guarantee: no code below this point
    // (now or in future for owned sessions) can ever issue a remote kill-session
    // for a non-owned session. The only `kill-session` we run is on OUR LOCAL
    // socket (`this.tmux()` = `tmux -L codeman` on THIS host), which kills the
    // local pane — it does NOT reach the REMOTE socket.
    if (session.remote && session.remote.owned === false) {
      console.log(`[TmuxManager] DETACH (non-owned remote): tearing down local pane only for ${session.muxName}`);
      if (isValidMuxName(session.muxName)) {
        try {
          // Local socket only — detaches the remote session by killing the local ssh pane.
          execSync(`${this.tmux()} kill-session -t "${session.muxName}" 2>/dev/null`, {
            timeout: EXEC_TIMEOUT_MS,
          });
        } catch {
          // Local pane may already be gone.
        }
      }
      this.lastPaneCount.delete(session.muxName);
      this.sessions.delete(sessionId);
      this.clearRemoteReconnectState(sessionId);
      this.saveSessions();
      this.emit('sessionKilled', { sessionId });
      return true;
    }

    // Get current PID (may have changed)
    const currentPid = this.getPanePid(session.muxName) || session.pid;

    console.log(`[TmuxManager] Killing session ${session.muxName} (PID ${currentPid})`);

    const allPids: number[] = [currentPid];

    // Strategy 1: Kill all child processes recursively
    let childPids = await this.getChildPidsFresh(currentPid);
    if (childPids.length > 0) {
      console.log(`[TmuxManager] Found ${childPids.length} child processes to kill`);
      allPids.push(...childPids);

      for (const childPid of [...childPids].reverse()) {
        if (this.isProcessAlive(childPid)) {
          try {
            process.kill(childPid, 'SIGTERM');
          } catch {
            // Process may already be dead
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, TMUX_KILL_WAIT_MS));

      childPids = await this.getChildPidsFresh(currentPid);
      for (const childPid of childPids) {
        if (this.isProcessAlive(childPid)) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // Process already terminated
          }
        }
      }
    }

    // Strategy 2: Kill the entire process group
    if (this.isProcessAlive(currentPid)) {
      try {
        process.kill(-currentPid, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, GRACEFUL_SHUTDOWN_WAIT_MS));
        if (this.isProcessAlive(currentPid)) {
          process.kill(-currentPid, 'SIGKILL');
        }
      } catch {
        // Process group may not exist or already terminated
      }
    }

    // Strategy 3: Kill tmux session by name (guard the name before it reaches the shell)
    if (isValidMuxName(session.muxName)) {
      try {
        execSync(`${this.tmux()} kill-session -t "${session.muxName}" 2>/dev/null`, {
          timeout: EXEC_TIMEOUT_MS,
        });
      } catch {
        // Session may already be dead
      }
    }

    // Strategy 3b: Remote sessions run a DURABLE tmux server on the remote host
    // (survives ssh drops), so killing only the local ssh wrapper above would
    // orphan the remote agent forever. Fire a best-effort `ssh … tmux kill-session`
    // — fire-and-forget so it NEVER blocks or throws the local kill (bounded by the
    // shared ConnectTimeout on an unreachable host).
    if (session.remote) {
      try {
        const remoteKillCmd = buildRemoteKillCommand({ remote: session.remote, sessionId });
        exec(remoteKillCmd, { timeout: EXEC_TIMEOUT_MS }, () => {});
      } catch {
        // Best-effort — a failure here must not affect the local kill result.
      }
    }

    // Strategy 3c: Docker sessions run a DURABLE in-container tmux session. Kill
    // ONLY this session's in-container tmux session (best-effort). The container is
    // PER-CASE and shared by the case's other sessions, so we deliberately do NOT
    // `docker stop` it here — stopping/removing is an explicit teardown/case-delete.
    if (session.docker && !IS_TEST_MODE) {
      try {
        exec(buildDockerKillCommand({ docker: session.docker, sessionId }), { timeout: EXEC_TIMEOUT_MS }, () => {});
      } catch {
        // Best-effort — never affects the local kill result.
      }
    }

    // Strategy 4: Direct kill by PID as final fallback
    if (this.isProcessAlive(currentPid)) {
      try {
        process.kill(currentPid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }

    // Verify all processes are dead
    const allDead = await this.verifyProcessesDead(allPids, 2000);
    if (!allDead) {
      console.error(`[TmuxManager] Warning: Some processes may still be alive for session ${session.muxName}`);
    }

    this.lastPaneCount.delete(session.muxName);
    this.sessions.delete(sessionId);
    this.clearRemoteReconnectState(sessionId);
    this.saveSessions();
    this.emit('sessionKilled', { sessionId });

    return true;
  }

  getSessions(): MuxSession[] {
    return Array.from(this.sessions.values());
  }

  getSession(sessionId: string): MuxSession | undefined {
    return this.sessions.get(sessionId);
  }

  updateSessionName(sessionId: string, name: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.name = name;
    this.saveSessions();
    return true;
  }

  /**
   * Reconcile tracked sessions with actual running tmux sessions.
   */
  async reconcileSessions(): Promise<{ alive: string[]; dead: string[]; discovered: string[] }> {
    // TEST MODE: Return all registered sessions as alive, never discover real ones
    if (IS_TEST_MODE) {
      return {
        alive: Array.from(this.sessions.keys()),
        dead: [],
        discovered: [],
      };
    }

    const alive: string[] = [];
    const dead: string[] = [];
    const discovered: string[] = [];

    // Single batched query against the one socket Codeman owns. With a single
    // socket a session's location is a constant, so there is no per-session
    // socket tag to reconcile and no cross-socket ambiguity that could mark a
    // live session dead (the root cause of vanished/duplicate tabs).
    let active: Map<string, number>;
    try {
      const output = execSync(`${this.tmux()} list-panes -a -F '${PANE_LIST_FORMAT}' 2>/dev/null || true`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      }).trim();
      active = parsePaneList(output);
    } catch (err) {
      console.error('[TmuxManager] Failed to list tmux panes:', err);
      active = new Map();
    }

    // Check tracked sessions against the live pane list.
    for (const [sessionId, session] of this.sessions) {
      const pid = active.get(session.muxName);
      if (pid !== undefined) {
        alive.push(sessionId);
        if (pid !== session.pid) session.pid = pid;
      } else {
        dead.push(sessionId);
        this.sessions.delete(sessionId);
        this.clearRemoteReconnectState(sessionId);
        this.emit('sessionDied', { sessionId });
      }
    }

    // Discover untracked codeman/claudeman sessions on our socket. Dedup by
    // muxName (globally unique) so a name we already track never spawns a
    // second "Restored:" entry.
    const knownMuxNames = new Set<string>();
    for (const session of this.sessions.values()) {
      knownMuxNames.add(session.muxName);
    }

    for (const [sessionName, pid] of active) {
      if (!sessionName.startsWith('codeman-') && !sessionName.startsWith('claudeman-')) continue;
      // Only admit names that pass the safe-name pattern. A foreign process on the
      // shared `tmux -L codeman` socket could create a `codeman-…` session whose name
      // contains shell metacharacters; rejecting it here keeps it out of this.sessions
      // and away from the name-interpolating tmux call sites (M1).
      if (!isValidMuxName(sessionName)) {
        console.warn(`[TmuxManager] Skipping discovered tmux session with unsafe name: ${sessionName}`);
        continue;
      }
      if (knownMuxNames.has(sessionName)) continue;

      const fragment = sessionName.replace(/^(?:codeman|claudeman)-/, '');
      const sessionId = `restored-${fragment}`;
      const session: MuxSession = {
        sessionId,
        muxName: sessionName,
        pid,
        createdAt: Date.now(),
        workingDir: process.cwd(),
        mode: 'claude',
        attached: false,
        name: `Restored: ${sessionName}`,
      };
      this.sessions.set(sessionId, session);
      knownMuxNames.add(sessionName);
      discovered.push(sessionId);
      console.log(`[TmuxManager] Discovered unknown tmux session: ${sessionName} (PID ${pid})`);
    }

    if (dead.length > 0 || discovered.length > 0) {
      this.saveSessions();
    }

    return { alive, dead, discovered };
  }

  async getProcessStats(sessionId: string): Promise<ProcessStats | null> {
    if (IS_TEST_MODE) return { memoryMB: 0, cpuPercent: 0, childCount: 0, updatedAt: Date.now() };

    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    try {
      const psOutput = (
        await execAsync(`ps -o rss=,pcpu= -p ${session.pid} 2>/dev/null || echo "0 0"`, {
          encoding: 'utf-8',
          timeout: EXEC_TIMEOUT_MS,
        })
      ).stdout.trim();

      const [rss, cpu] = psOutput.split(/\s+/).map((x) => parseFloat(x) || 0);

      // From the shared snapshot: this runs per session on every stats tick, and a
      // pgrep per session was a fork per session per interval.
      let childCount = 0;
      try {
        childCount = (this.childrenByParent().get(session.pid) ?? []).length;
      } catch {
        // No children or snapshot unavailable
      }

      return {
        memoryMB: Math.round((rss / 1024) * 10) / 10,
        cpuPercent: Math.round(cpu * 10) / 10,
        childCount,
        updatedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getSessionsWithStats(): Promise<MuxSessionWithStats[]> {
    if (IS_TEST_MODE) {
      return Array.from(this.sessions.values()).map((s) => ({
        ...s,
        stats: { memoryMB: 0, cpuPercent: 0, childCount: 0, updatedAt: Date.now() },
      }));
    }

    const sessions = Array.from(this.sessions.values());
    if (sessions.length === 0) {
      return [];
    }

    const sessionPids = sessions.map((s) => s.pid);
    const statsMap = new Map<number, ProcessStats>();

    try {
      // Step 1: Get descendant PIDs
      const descendantMap = new Map<number, number[]>();

      // Derived from the ONE snapshot instead of a shell loop that forks a pgrep
      // per session — the shape that turned into a fork storm under load.
      const byParent = this.childrenByParent();
      const childLines = sessionPids.map((p) => `${p}:${(byParent.get(p) ?? []).join(',')}`).join('\n');

      for (const line of childLines.split('\n')) {
        const [pidStr, childrenStr] = line.split(':');
        const sessionPid = parseInt(pidStr, 10);
        if (!Number.isNaN(sessionPid)) {
          const children = (childrenStr || '')
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !Number.isNaN(n) && n > 0);
          descendantMap.set(sessionPid, children);
        }
      }

      // Step 2: Collect all PIDs
      const allPids = new Set<number>(sessionPids);
      for (const children of descendantMap.values()) {
        for (const child of children) {
          allPids.add(child);
        }
      }

      // Step 3: Single ps call
      const pidArray = Array.from(allPids);
      if (pidArray.length > 0) {
        const psOutput = (
          await execAsync(`ps -o pid=,rss=,pcpu= -p ${pidArray.join(',')} 2>/dev/null || true`, {
            encoding: 'utf-8',
            timeout: EXEC_TIMEOUT_MS,
          })
        ).stdout.trim();

        const processStats = new Map<number, { rss: number; cpu: number }>();
        for (const line of psOutput.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            const pid = parseInt(parts[0], 10);
            const rss = parseFloat(parts[1]) || 0;
            const cpu = parseFloat(parts[2]) || 0;
            if (!Number.isNaN(pid)) {
              processStats.set(pid, { rss, cpu });
            }
          }
        }

        // Step 4: Aggregate stats
        for (const sessionPid of sessionPids) {
          const children = descendantMap.get(sessionPid) || [];
          const sessionStats = processStats.get(sessionPid) || { rss: 0, cpu: 0 };

          let totalRss = sessionStats.rss;
          let totalCpu = sessionStats.cpu;

          for (const childPid of children) {
            const childStats = processStats.get(childPid);
            if (childStats) {
              totalRss += childStats.rss;
              totalCpu += childStats.cpu;
            }
          }

          statsMap.set(sessionPid, {
            memoryMB: Math.round((totalRss / 1024) * 10) / 10,
            cpuPercent: Math.round(totalCpu * 10) / 10,
            childCount: children.length,
            updatedAt: Date.now(),
          });
        }
      }
    } catch {
      // Fall back to individual queries
      const statsPromises = sessions.map((session) => this.getProcessStats(session.sessionId));
      const results = await Promise.allSettled(statsPromises);
      return sessions.map((session, i) => ({
        ...session,
        stats: results[i].status === 'fulfilled' ? (results[i].value ?? undefined) : undefined,
      }));
    }

    return sessions.map((session) => ({
      ...session,
      stats: statsMap.get(session.pid) || undefined,
    }));
  }

  startStatsCollection(intervalMs: number = DEFAULT_STATS_INTERVAL_MS): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }

    this.statsInterval = setInterval(async () => {
      try {
        const sessionsWithStats = await this.getSessionsWithStats();
        this.emit('statsUpdated', sessionsWithStats);
      } catch (err) {
        console.error('[TmuxManager] Stats collection error:', err);
      }
    }, intervalMs);
  }

  stopStatsCollection(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  /**
   * Start periodic mouse mode sync for all tracked sessions.
   * Polls pane counts every 5s and toggles mouse on/off as needed.
   * Polls every 5s. On pane count change, toggles mouse on (>1 pane) or off (1 pane).
   * If enableMouseMode/disableMouseMode fails, lastPaneCount is NOT updated so it retries next poll.
   */
  startMouseModeSync(intervalMs: number = 5000): void {
    if (this.mouseSyncInterval) {
      clearInterval(this.mouseSyncInterval);
    }

    this.mouseSyncInterval = setInterval(async () => {
      if (IS_TEST_MODE) return;

      for (const session of this.sessions.values()) {
        const panes = await this.listPanes(session.muxName);
        const count = panes.length;
        if (count === 0) continue;

        const prev = this.lastPaneCount.get(session.muxName);
        if (prev === count) continue;

        // Pane count changed — toggle mouse mode
        if (count > 1) {
          if (await this.enableMouseMode(session.muxName)) {
            this.lastPaneCount.set(session.muxName, count);
          }
          // If enableMouseMode fails, DON'T update lastPaneCount — retry next poll
        } else {
          if (await this.disableMouseMode(session.muxName)) {
            this.lastPaneCount.set(session.muxName, count);
          }
        }
      }
    }, intervalMs);
  }

  stopMouseModeSync(): void {
    if (this.mouseSyncInterval) {
      clearInterval(this.mouseSyncInterval);
      this.mouseSyncInterval = null;
    }
    this.lastPaneCount.clear();
  }

  // ── COD-108 remote-session auto-reconnect watcher ─────────────────────────

  /**
   * Start the remote-reconnect watcher (COD-108). Each tick, for every tracked
   * session with `session.remote` whose local pane is DEAD, not intentionally
   * guarded, and within its backoff budget, emit `remoteSessionDropped` so the
   * session owner reattaches (re-running the idempotent remote command rejoins
   * the durable remote tmux session). After the attempt cap, emit
   * `remoteReconnectExhausted` once and go quiet.
   *
   * No-op tick body under `IS_TEST_MODE` (mirrors `startMouseModeSync`): tests
   * drive the logic deterministically via {@link runRemoteReconnectTick}.
   */
  startRemoteReconnectWatcher(intervalMs: number = DEFAULT_REMOTE_RECONNECT_INTERVAL_MS): void {
    if (this.remoteReconnectInterval) {
      clearInterval(this.remoteReconnectInterval);
    }
    this.remoteReconnectInterval = setInterval(() => {
      if (IS_TEST_MODE) return;
      try {
        this.runRemoteReconnectTick(Date.now(), isRemoteAutoReconnectEnabled());
      } catch (err) {
        console.error('[TmuxManager] Remote reconnect watcher error:', err);
      }
    }, intervalMs);
  }

  stopRemoteReconnectWatcher(): void {
    if (this.remoteReconnectInterval) {
      clearInterval(this.remoteReconnectInterval);
      this.remoteReconnectInterval = null;
    }
  }

  /**
   * Run ONE watcher tick. Extracted (and given an injected `now`/`enabled`) so
   * the reconnect logic is deterministically testable even though the live
   * `setInterval` body no-ops under test mode. For each remote session it
   * applies the pure {@link decideReconnect} decision and translates the result
   * into events + backoff/state transitions. Public for tests + the watcher.
   */
  /**
   * Refresh the cached remote-tmux liveness for a session whose pane is dead.
   * Fire-and-forget (async, not awaited by the sync tick): the probe is a slow
   * ssh round-trip, so it must not block the 5s watcher interval. On success it
   * writes the cached result; the NEXT tick then makes the revive decision with
   * fresh data. A clean exit makes the remote tmux session vanish, so the probe
   * resolves false and the watcher stops reviving it (2026-08-29).
   */
  private async refreshRemoteAlive(session: MuxSession): Promise<void> {
    if (!session.remote) return;
    if (this.remoteAliveInFlight.has(session.sessionId)) return;
    this.remoteAliveInFlight.add(session.sessionId);
    const remoteName = session.remote.remoteSessionName || remoteTmuxSessionName(session.sessionId);
    try {
      const alive = await remoteTmuxSessionAlive(session.remote, remoteName);
      this.remoteAliveCache.set(session.sessionId, alive);
    } catch {
      this.remoteAliveCache.set(session.sessionId, undefined);
    } finally {
      this.remoteAliveInFlight.delete(session.sessionId);
    }
  }

  runRemoteReconnectTick(now: number, enabled: boolean): void {
    for (const session of this.sessions.values()) {
      if (!session.remote) continue;
      const sessionId = session.sessionId;
      const state = this.reconnectState.get(sessionId);
      // Only probe when the pane is actually dead — otherwise the ssh round-trip
      // would run every 5s for every healthy remote session. The cache is
      // refreshed lazily so a clean exit (remote tmux gone) flips it to false
      // on the next tick and stops the auto-revive.
      const paneDead = this.isPaneDead(session.muxName);
      if (!paneDead) {
        // A live pane makes whatever the probe last said STALE, so forget it:
        // after a successful reattach (or a manual restart) the next dead pane
        // must be probed afresh. A cached `true` from the transport drop would
        // otherwise revive a later CLEAN exit, the exact bug this cache exists
        // to prevent, and a cached `false` from a clean exit would leave a
        // manually restarted session with auto-reconnect permanently off.
        this.remoteAliveCache.delete(sessionId);
      } else if (this.remoteAliveCache.get(sessionId) === undefined) {
        void this.refreshRemoteAlive(session);
      }
      const action = decideReconnect({
        session: {
          sessionId,
          isRemote: true,
          paneDead,
          remoteAlive: this.remoteAliveCache.get(sessionId),
        },
        state,
        guarded: this.reconnectGuard.has(sessionId),
        enabled,
        now,
      });

      if (action.kind === 'emit') {
        const base = state ?? freshReconnectState();
        // Mark in-flight + advance backoff BEFORE emitting so a re-entrant tick
        // (or a synchronous listener) can never stack a second reconnect.
        this.reconnectState.set(sessionId, { ...advanceBackoff(base, now), inFlight: true });
        this.emit('remoteSessionDropped', { sessionId, attempt: action.attempt });
      } else if (action.kind === 'exhaust') {
        const base = state ?? freshReconnectState();
        if (!base.exhaustedEmitted) {
          this.reconnectState.set(sessionId, { ...base, exhausted: true, exhaustedEmitted: true });
          this.emit('remoteReconnectExhausted', { sessionId });
        }
      }
      // 'skip' → nothing to do.
    }
  }

  /**
   * Tell the watcher a reattach attempt for `sessionId` finished. On success,
   * reset the backoff so the session is healthy again; on failure, just clear
   * the in-flight flag so the next due tick can retry under the existing
   * backoff schedule. Called by the session owner after `respawnPane`.
   */
  noteRemoteReconnect(sessionId: string, success: boolean): void {
    if (success) {
      this.reconnectState.set(sessionId, resetReconnectState());
      return;
    }
    const state = this.reconnectState.get(sessionId);
    if (state) this.reconnectState.set(sessionId, { ...state, inFlight: false });
  }

  /**
   * Exclude a session from auto-reconnect (intentional teardown). Adds it to the
   * guard set and drops any backoff state so a closed/killed tab — especially a
   * non-owned remote DETACH — is never auto-revived. Idempotent.
   */
  guardRemoteReconnect(sessionId: string): void {
    this.reconnectGuard.add(sessionId);
    this.reconnectState.delete(sessionId);
    this.remoteAliveCache.delete(sessionId);
    this.remoteAliveInFlight.delete(sessionId);
  }

  /** Clear all per-session reconnect + guard state (e.g. when a session is removed). */
  clearRemoteReconnectState(sessionId: string): void {
    this.reconnectState.delete(sessionId);
    this.reconnectGuard.delete(sessionId);
    this.remoteAliveCache.delete(sessionId);
    this.remoteAliveInFlight.delete(sessionId);
  }

  destroy(): void {
    this.stopStatsCollection();
    this.stopMouseModeSync();
    this.stopRemoteReconnectWatcher();
    this.reconnectState.clear();
    this.reconnectGuard.clear();
    this.remoteAliveCache.clear();
    this.remoteAliveInFlight.clear();
  }

  registerSession(session: MuxSession): void {
    this.sessions.set(session.sessionId, session);
    this.saveSessions();
  }

  setAttached(sessionId: string, attached: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.attached = attached;
      this.saveSessions();
    }
  }

  updateRespawnConfig(sessionId: string, config: PersistedRespawnConfig | undefined): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.respawnConfig = config;
      this.saveSessions();
    }
  }

  clearRespawnConfig(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.respawnConfig) {
      delete session.respawnConfig;
      this.saveSessions();
    }
  }

  updateRalphEnabled(sessionId: string, enabled: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.ralphEnabled = enabled;
      this.saveSessions();
    }
  }

  /**
   * Apply a tmux history limit. tmux 3.7+ safely targets tracked live sessions;
   * older releases can only change the global default for future panes. Invalid
   * limits fall back to the default.
   */
  async setHistoryLimit(limit: number): Promise<void> {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_TMUX_HISTORY_LIMIT;

    if (IS_TEST_MODE) {
      return;
    }

    if (this.supportsLiveHistoryResize()) {
      const updates = Array.from(this.sessions.values()).map((session) =>
        execAsync(`${this.tmux()} set-option -t ${shellescape(session.muxName)} history-limit ${safeLimit}`, {
          timeout: EXEC_TIMEOUT_MS,
        })
      );
      await Promise.allSettled(updates);
      return;
    }

    await execAsync(`${this.tmux()} set-option -g history-limit ${safeLimit}`, {
      timeout: EXEC_TIMEOUT_MS,
    }).catch(() => {
      // No tmux server yet is fine: legacy createSession sets the same default
      // immediately before it creates the first pane.
    });
  }

  /**
   * Send input directly to a tmux session using `send-keys`.
   *
   * Uses tmux send-keys for reliable input delivery:
   * - `-l` flag sends literal text (no key interpretation)
   * - `Enter` key is sent as a SEPARATE tmux invocation after a small delay
   * - Ink (Claude CLI) needs text and Enter split to avoid treating Enter as a newline
   */
  async sendInput(sessionId: string, input: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(
        `[TmuxManager] sendInput failed: no session found for ${sessionId}. Known: ${Array.from(this.sessions.keys()).join(', ')}`
      );
      return false;
    }

    // TEST MODE: No-op — don't send input to real tmux sessions
    if (IS_TEST_MODE) {
      return true;
    }

    console.log(
      `[TmuxManager] sendInput to ${session.muxName}, input length: ${input.length}, hasCarriageReturn: ${input.includes('\r')}`
    );

    if (!isValidMuxName(session.muxName)) {
      console.error('[TmuxManager] Invalid session name in sendInput:', session.muxName);
      return false;
    }

    try {
      const hasCarriageReturn = input.includes('\r');
      const textPart = input.replace(/\r/g, '').replace(/\n/g, '').trimEnd();

      if (textPart && hasCarriageReturn) {
        // Send text first, then Enter as a SEPARATE tmux command after a short delay.
        // Ink (Claude CLI's terminal framework) needs them split — sending both in a
        // single tmux invocation (via \;) causes Ink to interpret Enter as a newline
        // character in the input buffer rather than as form submission.
        await execAsync(`${this.tmux()} send-keys -t "${session.muxName}" -l ${shellescape(textPart)}`, {
          timeout: EXEC_TIMEOUT_MS,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await execAsync(`${this.tmux()} send-keys -t "${session.muxName}" Enter`, {
          timeout: EXEC_TIMEOUT_MS,
        });
      } else if (textPart) {
        // Text only, no Enter
        await execAsync(`${this.tmux()} send-keys -t "${session.muxName}" -l ${shellescape(textPart)}`, {
          timeout: EXEC_TIMEOUT_MS,
        });
      } else if (hasCarriageReturn) {
        // Enter only
        await execAsync(`${this.tmux()} send-keys -t "${session.muxName}" Enter`, {
          timeout: EXEC_TIMEOUT_MS,
        });
      }

      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to send input:', err);
      return false;
    }
  }

  // ========== Pane Methods (for Agent Team teammate panes) ==========

  /**
   * Enable mouse mode for an existing tmux session.
   * Allows clicking to select panes in agent team split-pane layouts.
   * When mouse mode is on, tmux intercepts mouse events (slow selection, no browser copy).
   */
  async enableMouseMode(muxName: string): Promise<boolean> {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in enableMouseMode:', muxName);
      return false;
    }

    try {
      await execAsync(`${this.tmux()} set-option -t "${muxName}" mouse on`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      console.log(`[TmuxManager] Mouse mode ON for ${muxName}`);
      return true;
    } catch (err) {
      console.error(`[TmuxManager] Failed to enable mouse mode for ${muxName}:`, err);
      return false;
    }
  }

  /**
   * Disable mouse mode for an existing tmux session.
   * Restores native xterm.js text selection and browser clipboard copy.
   */
  async disableMouseMode(muxName: string): Promise<boolean> {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in disableMouseMode:', muxName);
      return false;
    }

    try {
      await execAsync(`${this.tmux()} set-option -t "${muxName}" mouse off`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      console.log(`[TmuxManager] Mouse mode OFF for ${muxName}`);
      return true;
    } catch (err) {
      console.error(`[TmuxManager] Failed to disable mouse mode for ${muxName}:`, err);
      return false;
    }
  }

  /**
   * Sync mouse mode based on pane count: enable if split (>1 pane), disable if single.
   * Called by TeamWatcher when teammates spawn/despawn panes.
   * Uses `tmux list-panes` for bulletproof detection — counts actual panes, not config.
   */
  async syncMouseMode(muxName: string): Promise<boolean> {
    if (IS_TEST_MODE) return true;
    const panes = await this.listPanes(muxName);
    if (panes.length > 1) {
      return this.enableMouseMode(muxName);
    } else {
      return this.disableMouseMode(muxName);
    }
  }

  /**
   * List all panes in a tmux session.
   * Returns structured info for each pane.
   */
  async listPanes(muxName: string): Promise<PaneInfo[]> {
    if (IS_TEST_MODE) return [];
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in listPanes:', muxName);
      return [];
    }

    try {
      const output = (
        await execAsync(
          `${this.tmux()} list-panes -t "${muxName}" -F '#{pane_id}:#{pane_index}:#{pane_pid}:#{pane_width}:#{pane_height}'`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        )
      ).stdout.trim();

      return output
        .split('\n')
        .map((line) => {
          const [paneId, indexStr, pidStr, widthStr, heightStr] = line.split(':');
          return {
            paneId,
            paneIndex: parseInt(indexStr, 10),
            panePid: parseInt(pidStr, 10),
            width: parseInt(widthStr, 10),
            height: parseInt(heightStr, 10),
          };
        })
        .filter((p) => !Number.isNaN(p.paneIndex));
    } catch {
      return [];
    }
  }

  /**
   * Send input to a specific pane within a tmux session.
   * Uses the same literal text approach as sendInput() but targets a specific pane.
   */
  sendInputToPane(muxName: string, paneTarget: string, input: string): boolean {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in sendInputToPane:', muxName);
      return false;
    }
    if (!SAFE_PANE_TARGET_PATTERN.test(paneTarget)) {
      console.error('[TmuxManager] Invalid pane target:', paneTarget);
      return false;
    }

    // Build target: sessionName.paneId (e.g., "codeman-abc12345.%1")
    const target = paneTarget.startsWith('%') ? `${muxName}.${paneTarget}` : `${muxName}.%${paneTarget}`;
    const tmux = this.tmux();

    try {
      const hasCarriageReturn = input.includes('\r');
      const textPart = input.replace(/\r/g, '').replace(/\n/g, '').trimEnd();

      if (textPart && hasCarriageReturn) {
        execSync(`${tmux} send-keys -t ${shellescape(target)} -l ${shellescape(textPart)}`, {
          encoding: 'utf-8',
          timeout: EXEC_TIMEOUT_MS,
        });
        execSync(`${tmux} send-keys -t ${shellescape(target)} Enter`, {
          encoding: 'utf-8',
          timeout: EXEC_TIMEOUT_MS,
        });
      } else if (textPart) {
        execSync(`${tmux} send-keys -t ${shellescape(target)} -l ${shellescape(textPart)}`, {
          encoding: 'utf-8',
          timeout: EXEC_TIMEOUT_MS,
        });
      } else if (hasCarriageReturn) {
        execSync(`${tmux} send-keys -t ${shellescape(target)} Enter`, {
          encoding: 'utf-8',
          timeout: EXEC_TIMEOUT_MS,
        });
      }

      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to send input to pane:', err);
      return false;
    }
  }

  /**
   * Capture a pane's text and SGR styles.
   *
   * Two modes:
   * - Visible (default): `capture-pane -p -e` grabs only the on-screen frame,
   *   then `formatPaneSnapshot` repaints each row at its absolute position so
   *   the browser xterm reproduces the live frame. Used for fast tab switches.
   * - Full history (`opts.fullHistory`): `capture-pane -p -e -J -S -<N>` grabs
   *   the tmux scrollback (COD-47, bounded to the configured history limit),
   *   returned as linear scrollback text with SGR codes preserved. Rows are not
   *   repainted at absolute positions — a multi-screen history can't be painted
   *   into a single visible frame — but the capture DOES end with a cursor move
   *   putting the caret back where the pane has it, counted up from the last
   *   replayed row. `-J` re-joins lines hard-wrapped at the pane width so they
   *   reflow in the browser xterm. Used for full page reloads so the user gets
   *   back their scroll history. Returns '' for a pane holding nothing visible,
   *   so the caller keeps whatever history it already had.
   *   Caveat: lines tmux has already evicted past its history-limit are gone.
   */
  /**
   * Plain visible-frame text for the working/idle probe (see `session.ts`).
   *
   * One `capture-pane` and nothing else: no `-e` styles, no `display-message`
   * cursor query, no repaint reconstruction: this feeds a regex, not a
   * terminal. Returns null in tests (no tmux) so callers fall back to their
   * stream heuristics rather than reading an empty screen as "not working".
   */
  capturePaneText(muxName: string, paneTarget?: string): string | null {
    if (IS_TEST_MODE) return null;
    const target = resolveTmuxPaneTarget(muxName, paneTarget);
    if (!target) return null;
    try {
      return execSync(`${this.tmux()} capture-pane -p -t ${shellescape(target)}`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch {
      // A dead/renamed pane is an ordinary outcome here, not an error worth logging
      // on a timer; the caller treats null as "no evidence either way".
      return null;
    }
  }

  capturePaneBuffer(muxName: string, paneTarget?: string, opts?: PaneCaptureOptions): string | null {
    if (IS_TEST_MODE) return '';
    const target = resolveTmuxPaneTarget(muxName, paneTarget);
    if (!target) {
      console.error('[TmuxManager] Invalid pane target in capturePaneBuffer:', { muxName, paneTarget });
      return null;
    }

    const fullHistory = opts?.fullHistory === true;

    try {
      // `-S -<N>` starts the capture N lines above the visible frame (tmux
      // clamps to the top of history), so tmux never serializes more scrollback
      // than the configured history limit retains.
      const requestedLines = opts?.historyLimitLines;
      const historyLines =
        typeof requestedLines === 'number' && Number.isFinite(requestedLines) && requestedLines > 0
          ? Math.trunc(requestedLines)
          : DEFAULT_TMUX_HISTORY_LIMIT;
      const captureFlags = fullHistory ? `capture-pane -p -e -J -S -${historyLines}` : 'capture-pane -p -e';
      // execSync's default maxBuffer (1MB) kills multi-MB scrollback dumps
      // (ENOBUFS) and would silently degrade full-history capture to the byte
      // buffer for exactly the long sessions it exists for — size it from the
      // consumer's byte cap plus ANSI-overhead slack instead.
      const execOpts: { encoding: 'utf-8'; timeout: number; maxBuffer?: number } = {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      };
      if (fullHistory) {
        execOpts.maxBuffer =
          (opts?.maxCaptureBytes ?? DEFAULT_TERMINAL_BUFFER_MAX_BYTES) + FULL_HISTORY_CAPTURE_SLACK_BYTES;
      }
      const rawCapture = execSync(`${this.tmux()} ${captureFlags} -t ${shellescape(target)}`, execOpts);
      // Query the cursor BEFORE deciding anything else. On the full-history path
      // it settles both how the capture is trimmed and whether a cursor move is
      // appended, and those two have to agree: trailing blank rows are only safe
      // to keep when a move follows to put the caret back above them.
      const geometry = queryPaneCursor(() =>
        execSync(
          `${this.tmux()} display-message -p -t ${shellescape(target)} '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}'`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        )
      );

      if (fullHistory) {
        // Without geometry there is no cursor move, so fall back to the old trim.
        // Keeping the blank rows here would park the caret at the bottom of the
        // pane with nothing to correct it — worse than not trying at all.
        if (!geometry) return normalizeScrollbackEol(rawCapture.replace(/\n+$/g, ''));
        // Take the line terminator off and nothing else. The trailing blank rows
        // that remain are the real bottom of the screen, and the cursor move
        // below counts up from it. tmux joins rows with a bare `\n`; normalize to
        // `\r\n` so a fresh xterm (convertEol:false) starts each replayed line at
        // column 0 instead of staircasing diagonally (COD-138).
        const trimmed = rawCapture.replace(/\n$/, '');
        // An all-blank pane has to keep reading as "nothing to replay". The caller
        // treats an empty string as "capture unavailable" and keeps the byte
        // history; blank rows plus a cursor move are not empty, so without this a
        // blank pane REPLACES that history with a blank screen — the downgrade
        // `_replayWouldShrinkBuffer` exists to refuse, arriving from the server
        // side where that guard cannot see it.
        if (!hasVisibleContent(trimmed)) return '';
        return `${normalizeScrollbackEol(trimmed)}${formatCursorRestore(geometry)}`;
      }

      const buffer = rawCapture.replace(/\n+$/g, '');
      if (geometry) return formatPaneSnapshot(buffer.split('\n'), geometry);
      // Cursor query failed or geometry was invalid, so we skip the absolute-
      // positioned snapshot repaint and fall back to the raw capture. Normalize
      // its bare `\n` line endings to `\r\n` so the replay doesn't staircase
      // diagonally in a fresh xterm (COD-138, same reason as the fullHistory path).
      return normalizeScrollbackEol(buffer);
    } catch (err) {
      // ENOBUFS carries the truncated multi-MB stdout on the error object —
      // log a concise line instead of dumping it into the journal.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOBUFS') {
        console.error('[TmuxManager] Pane capture exceeded maxBuffer (ENOBUFS); falling back to byte history');
      } else {
        console.error('[TmuxManager] Failed to capture pane buffer:', err);
      }
      return null;
    }
  }

  /**
   * Capture the active pane for a tmux session.
   *
   * Pane ids are not stable across respawns or restores, so callers should not
   * assume the first pane remains `%0`.
   */
  captureActivePaneBuffer(muxName: string, opts?: PaneCaptureOptions): string | null {
    if (IS_TEST_MODE) return '';
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in captureActivePaneBuffer:', muxName);
      return null;
    }

    try {
      const output = execSync(`${this.tmux()} list-panes -t ${shellescape(muxName)} -F '#{pane_id}:#{pane_active}'`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      }).trim();
      const target = resolveActivePaneTarget(output);
      return target ? this.capturePaneBuffer(muxName, target, opts) : null;
    } catch (err) {
      console.error('[TmuxManager] Failed to resolve active pane for capture:', err);
      return null;
    }
  }

  /**
   * Start piping pane output to a file using tmux pipe-pane.
   * Only pipes output direction (-O) to avoid echoing input.
   */
  startPipePane(muxName: string, paneTarget: string, outputFile: string): boolean {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in startPipePane:', muxName);
      return false;
    }
    if (!SAFE_PANE_TARGET_PATTERN.test(paneTarget)) {
      console.error('[TmuxManager] Invalid pane target:', paneTarget);
      return false;
    }
    if (!isValidPath(outputFile)) {
      console.error('[TmuxManager] Invalid output file path:', outputFile);
      return false;
    }

    const target = paneTarget.startsWith('%') ? `${muxName}.${paneTarget}` : `${muxName}.%${paneTarget}`;

    try {
      execSync(`${this.tmux()} pipe-pane -O -t ${shellescape(target)} ${shellescape('cat >> ' + outputFile)}`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to start pipe-pane:', err);
      return false;
    }
  }

  /**
   * Stop piping pane output (calling pipe-pane with no command stops piping).
   */
  stopPipePane(muxName: string, paneTarget: string): boolean {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in stopPipePane:', muxName);
      return false;
    }
    if (!SAFE_PANE_TARGET_PATTERN.test(paneTarget)) {
      console.error('[TmuxManager] Invalid pane target:', paneTarget);
      return false;
    }

    const target = paneTarget.startsWith('%') ? `${muxName}.${paneTarget}` : `${muxName}.%${paneTarget}`;

    try {
      execSync(`${this.tmux()} pipe-pane -t ${shellescape(target)}`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to stop pipe-pane:', err);
      return false;
    }
  }

  getAttachCommand(): string {
    return 'tmux';
  }

  getAttachArgs(muxName: string): string[] {
    return ['-L', this.tmuxSocket, 'attach-session', '-t', muxName];
  }

  setManualWindowSize(muxName: string): boolean {
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in setManualWindowSize:', muxName);
      return false;
    }

    try {
      execSync(`${this.tmux()} set-window-option -t ${shellescape(muxName)} window-size manual`, {
        timeout: EXEC_TIMEOUT_MS,
        stdio: 'ignore',
      });
      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to set manual window size:', err);
      return false;
    }
  }

  resizeWindow(muxName: string, cols: number, rows: number): boolean {
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in resizeWindow:', muxName);
      return false;
    }
    if (!isValidTerminalDimension(cols) || !isValidTerminalDimension(rows)) {
      console.error('[TmuxManager] Invalid resize dimensions:', { cols, rows });
      return false;
    }

    // Fire-and-forget: this runs on the interactive resize path (WS {t:'z'} and
    // HTTP /resize), so use a non-blocking exec — a slow/hung tmux must not stall
    // the Fastify event loop while other sessions' input/SSE are served. The sole
    // caller (Session.resize) ignores the result, and under `window-size manual`
    // the subsequent ptyProcess.resize is subordinate to this authoritative size.
    exec(
      `${this.tmux()} resize-window -t ${shellescape(muxName)} -x ${cols} -y ${rows}`,
      { timeout: EXEC_TIMEOUT_MS },
      (err) => {
        if (err) console.error('[TmuxManager] Failed to resize tmux window:', err);
      }
    );
    return true;
  }

  isAvailable(): boolean {
    return TmuxManager.isTmuxAvailable();
  }

  /**
   * Check if tmux is available on the system.
   */
  static isTmuxAvailable(): boolean {
    try {
      execSync('which tmux', { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Shell-escape a string for use as a single argument.
 * Wraps in single quotes, escaping any embedded single quotes.
 */
function shellescape(str: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, restart quote)
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
