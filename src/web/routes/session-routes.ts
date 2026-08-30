/**
 * @fileoverview Session management routes.
 * Covers session CRUD, input/output, terminal buffer, quick-start, quick-run,
 * auto-clear, auto-compact, image watcher, flicker filter, and logout.
 */

import { FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { join, dirname, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  ApiErrorCode,
  createErrorResponse,
  getErrorMessage,
  type ApiResponse,
  type SessionColor,
  type SessionStatus,
  type SessionMode,
  type CodexConfig,
  type GeminiConfig,
  type AntigravityConfig,
  type PiConfig,
  type GrokConfig,
  type DeepSeekConfig,
  type OmpConfig,
} from '../../types.js';
import { Session, isAltScreenStripMode, isMuxAltScreenOnlyStripMode } from '../../session.js';
import { SseEvent } from '../sse-events.js';
import {
  CreateSessionSchema,
  SessionNameSchema,
  SessionColorSchema,
  RunPromptSchema,
  SessionInputWithLimitSchema,
  ResizeSchema,
  AutoClearSchema,
  AutoCompactSchema,
  AutoResumeSchema,
  PinSessionSchema,
  ImageWatcherSchema,
  FlickerFilterSchema,
  QuickRunSchema,
  QuickStartSchema,
  InteractiveStartSchema,
  SessionOrderUpdateSchema,
  SessionWaitQuerySchema,
  SessionWaitOutputQuerySchema,
} from '../schemas.js';
import { ownerLayoutKey } from '../../tab-layout-persistence.js';
import { TabLayoutValidationError } from '../../tab-layout.js';
import {
  sessionWaits,
  resolveWaitSignals,
  sessionHookOptions,
  signalForStatus,
  WaitCapacityError,
  type WaitSignal,
  type SignalWaitResult,
} from '../session-wait-registry.js';
import { clampWaitMs, MAX_BUFFER_SCAN_BYTES } from '../../config/agent-wait.js';
import {
  autoConfigureRalph,
  canAccessOwned,
  CASES_DIR,
  findPersistedSessionOrFail,
  findSessionOrFail,
  getAuthUser,
  isAdmin,
  isWorkingDirAllowed,
  ownerFor,
  parseBody,
  persistAndBroadcastSession,
  resolveCasesDir,
  resolveParentSessionId,
  sessionCapacityMessage,
  SETTINGS_PATH,
  validatePathWithinBase,
} from '../route-helpers.js';
import { canUsernameRunPrivilegedCommands, resolveClaudeModeForUsername } from '../../user-store.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.js';
import {
  writeHooksConfig,
  updateCaseModel,
  stripCaseEnvKeys,
  applyAgentSkill,
  refreshUserAgentSkill,
  seedAgentSessionPreamble,
  applyWorkspaceHooks,
  refreshStaleCodemanHooks,
} from '../../hooks-config.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { imageWatcher } from '../../image-watcher.js';
import { convertHeicToJpeg } from '../heic-jpeg-converter.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import {
  mergeUnifiedSessions,
  filterAndPaginate,
  type LiveSessionInput,
  type PersistedSessionInput,
  type LifecycleInput,
  type HistoryInput,
  type MuxStatInput,
  type UnifiedSessionItem,
} from '../../services/unified-session-service.js';
import {
  buildHistorySessionIndexItems,
  setHistoryIndexRefresher,
  setHistorySessionIndex,
} from '../session-history-index.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort, AuthPort, TabLayoutPort } from '../ports/index.js';
import { RunSummaryTracker } from '../../run-summary.js';

import { MAX_INPUT_LENGTH, MAX_SESSION_NAME_LENGTH } from '../../config/terminal-limits.js';
import { MAX_PASTE_IMAGE_BYTES } from '../../config/buffer-limits.js';
import { dataPath, getDataDir } from '../../config/instance.js';
import {
  checkRemoteTmuxAvailable,
  readRemoteCases,
  readRemoteHosts,
  toAttachedSessionRemote,
  toSessionRemote,
} from '../../remote-hosts.js';
import {
  checkDockerAvailable,
  checkDockerConfigDrift,
  checkDockerTmuxAvailable,
  ensureAgentBaseImage,
  DEFAULT_AGENT_IMAGE,
  persistDockerCaseClaudeSessionId,
  readDockerCases,
  readDockerHosts,
  toSessionDocker,
} from '../../docker-hosts.js';
import { LRUMap } from '../../utils/lru-map.js';
import { findLatestOmpSessionId } from '../../utils/omp-session-resolver.js';
import { scanOmpSessionsHistory } from '../../omp-transcript.js';
import {
  getLastTranscriptResponse,
  isExternalCliTranscriptMode,
  parseExternalCliTranscript,
} from '../response-viewer-transcript.js';
import { readDeepSeekLastResponse } from '../../deepseek-transcript.js';

// Path to linked-cases registry (same file used by case-routes resolveCasePath)
const LINKED_CASES_FILE = dataPath('linked-cases.json');
const CODEMAN_CONFIG_DIR = getDataDir();

// Pre-compiled regex for terminal buffer cleaning (avoids per-request compilation)
// eslint-disable-next-line no-control-regex
const CLAUDE_BANNER_PATTERN = /\x1b\[1mClaud/;
// eslint-disable-next-line no-control-regex
const CTRL_L_PATTERN = /\x0c/g;
const LEADING_WHITESPACE_PATTERN = /^[\s\r\n]+/;

/**
 * Match xterm alternate-screen mode toggles + the standalone scrollback-erase.
 *
 * - DECSET/DECRST 47, 1047, 1049 = enter/exit alternate screen buffer
 *   (1049 also saves cursor and clears the alt buffer).
 * - CSI 3 J = erase saved lines (scrollback).
 *
 * Codex AND Claude Code emit `\x1b[?1049h` and clear-scrollback sequences (the
 * latter intermittently, e.g. full-screen pickers/dialogs). xterm.js obeys them
 * by switching to the alt buffer (no native scrollback) and wiping saved lines,
 * so the user's conversation history disappears on every tab switch / pane
 * refresh (and scroll-up breaks live). Stripping these from the replayed byte
 * stream keeps everything in the main buffer with scrollback intact. Mirrors the
 * live-stream strip in Session._handleTerminalOutput (isAltScreenStripMode).
 */
// eslint-disable-next-line no-control-regex
const ALT_SCREEN_TOGGLE_PATTERN = /\x1b\[\?(?:47|1047|1049)[hl]/g;
// eslint-disable-next-line no-control-regex
const ERASE_SCROLLBACK_PATTERN = /\x1b\[3J/g;
// Mouse-tracking enables (X10/button/any-event/UTF-8/SGR/alt-scroll) — once on,
// xterm.js forwards wheel events to the app instead of scrolling the viewport.
// Live streams are stripped at the source, but buffers persisted BEFORE that
// strip existed can still carry them; strip on replay for parity.
// eslint-disable-next-line no-control-regex
const MOUSE_TRACKING_PATTERN = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1007)[hl]/g;

/**
 * Strip redundant Ink spinner/status-bar redraw frames from the terminal buffer.
 * Ink (Claude Code's TUI) uses absolute cursor positioning (CSI n d = VPA) to animate
 * the spinner and update the status bar. During long thinking phases, these frames
 * accumulate to 500KB+ of repeated overwrites to the same rows.
 *
 * Strategy: detect "redraw clusters" — dense runs of VPA escapes where each is within
 * FRAME_GAP bytes of the previous (i.e. continuous rerendering of the same UI region).
 * Collapse each big cluster down to just the bytes from its last VPA onwards (the final
 * frame). Content *between* clusters (Claude's streamed response text) is preserved.
 *
 * Without clustering, a single first-VPA-finds-all approach would discard the entire
 * conversation after Claude's first render — losing 100KB+ of legitimate scrollback.
 */
export function stripInkRedrawBloat(buffer: string): string {
  // eslint-disable-next-line no-control-regex
  const vpaRe = /\x1b\[\d+d/g;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = vpaRe.exec(buffer)) !== null) {
    positions.push(m.index);
  }
  if (positions.length < 10) return buffer; // Too few VPAs to be bloat

  // Group consecutive VPAs into clusters separated by gaps > FRAME_GAP.
  // Within a cluster, VPAs are close together (continuous rerenders).
  // Between clusters, real terminal output (response text) lives.
  const FRAME_GAP = 8 * 1024; // 8KB — one Ink frame is typically 1-4KB
  const MIN_BLOAT_SIZE = 32 * 1024; // Only collapse clusters spanning >= 32KB

  const clusters: { start: number; end: number }[] = [];
  let cs = positions[0];
  let ce = positions[0];
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] - ce <= FRAME_GAP) {
      ce = positions[i];
    } else {
      clusters.push({ start: cs, end: ce });
      cs = positions[i];
      ce = positions[i];
    }
  }
  clusters.push({ start: cs, end: ce });

  // For each big cluster, replace [start..end] with the bytes from `end` onwards
  // (which contains the last frame's content up to where the next cluster, or
  // post-cluster content, begins).
  const parts: string[] = [];
  let cursor = 0;
  for (const cl of clusters) {
    if (cl.end - cl.start < MIN_BLOAT_SIZE) continue;
    parts.push(buffer.slice(cursor, cl.start));
    cursor = cl.end;
  }
  parts.push(buffer.slice(cursor));
  return parts.join('');
}

/**
 * Validate image bytes against a declared extension. Sniffs the first ~12 bytes
 * for a known magic-number signature. Defends against polyglots (e.g. HTML or
 * SVG disguised under a `Content-Type: image/png` header) and against simple
 * extension-only spoofing — both the multipart filename and the Content-Type
 * are attacker-controlled, the raw bytes are not.
 *
 * Signatures: https://en.wikipedia.org/wiki/List_of_file_signatures
 */
export function imageMagicMatchesExt(data: Buffer, ext: string): boolean {
  if (data.length < 12) return false;
  const u32be = (off: number): number => data.readUInt32BE(off);
  switch (ext) {
    case '.png':
      return u32be(0) === 0x89504e47 && u32be(4) === 0x0d0a1a0a;
    case '.jpg':
    case '.jpeg':
      return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case '.gif':
      return (
        data[0] === 0x47 &&
        data[1] === 0x49 &&
        data[2] === 0x46 &&
        data[3] === 0x38 &&
        (data[4] === 0x37 || data[4] === 0x39) &&
        data[5] === 0x61
      );
    case '.webp':
      // RIFF....WEBP
      return u32be(0) === 0x52494646 && u32be(8) === 0x57454250;
    case '.bmp':
      return data[0] === 0x42 && data[1] === 0x4d;
    case '.heic':
    case '.heif': {
      // ISO Base Media File Format: size + "ftyp" + major brand. The brand
      // list matches heic-decode's own isHeic() — accepting more brands here
      // would only route bytes into a conversion that always throws.
      if (u32be(4) !== 0x66747970) return false;
      const brand = data.subarray(8, 12).toString('ascii');
      return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
    }
    default:
      return false;
  }
}

// Per-(IP, sessionId) token bucket for paste-image. 30 requests/minute.
// Bucket map entries are pruned when they drift > 1h stale to bound memory
// against a flood of unique IP keys.
const PASTE_RATE_TOKENS = 30;
const PASTE_RATE_REFILL_PER_MS = PASTE_RATE_TOKENS / 60_000;
const PASTE_BUCKET_TTL_MS = 60 * 60 * 1000;
const PASTE_BUCKET_GC_THRESHOLD = 1000;
const pasteRateBuckets = new Map<string, { tokens: number; lastRefill: number }>();

export function consumePasteToken(key: string, now: number = Date.now()): boolean {
  if (pasteRateBuckets.size > PASTE_BUCKET_GC_THRESHOLD) {
    for (const [k, b] of pasteRateBuckets) {
      if (now - b.lastRefill > PASTE_BUCKET_TTL_MS) pasteRateBuckets.delete(k);
    }
  }
  let b = pasteRateBuckets.get(key);
  if (!b) {
    b = { tokens: PASTE_RATE_TOKENS, lastRefill: now };
    pasteRateBuckets.set(key, b);
  }
  const delta = (now - b.lastRefill) * PASTE_RATE_REFILL_PER_MS;
  b.tokens = Math.min(PASTE_RATE_TOKENS, b.tokens + delta);
  b.lastRefill = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Test hook: reset between runs.
export function _resetPasteRateBuckets(): void {
  pasteRateBuckets.clear();
}

/**
 * Security (multi-user §6.3): the Claude-only permission-mode downgrade does not
 * cover the other CLIs' bypass switches. Codex `--dangerously-bypass-approvals-and-sandbox`,
 * Gemini `--approval-mode yolo`, and Antigravity `--dangerously-skip-permissions` disable
 * the safety classifier the non-granted-user downgrade is meant to keep on, so clamp them
 * for a non-granted owner. buildGeminiCommand defaults an ABSENT approvalMode to yolo, so
 * the gemini config must be MATERIALIZED (auto_edit) even when the request sent none.
 * Antigravity is like Codex: an ABSENT config already defaults safe (no bypass flag), so
 * only a sent config needs the flag forced off. No-op in single-user mode / for a granted
 * owner (canUsernameRunPrivilegedCommands returns true when !isMultiUserMode()).
 *
 * Pi has no permission prompts at all, so there is no bypass switch to clamp; its
 * privilege-shaped knob is `approveProjectTrust`, which makes pi LOAD AND EXECUTE
 * repo-local `.pi/extensions` TypeScript and npm-install missing project packages.
 * Pi joins the gemini-style MATERIALIZE branch, not the codex/antigravity
 * only-if-sent one: pi's absent-config default is an interactive trust prompt the
 * session user could simply answer "yes" to in the terminal, so merely omitting
 * `--approve` is not a clamp. Forcing `approveProjectTrust: false` makes
 * buildPiCommand emit `--no-approve`, and the prompt never appears.
 *
 * Grok is like Codex/Antigravity: the bypass switch is `alwaysApprove`
 * (`--always-approve`), and an ABSENT config already spawns in grok's own
 * ask-mode default, so only a sent config needs the flag forced off.
 *
 * DeepSeek joins the same only-if-sent branch, but its switch is not a flag: the
 * harness has no command-line permission option, and its sandbox/approval rows
 * read `DSH_PERMISSION_MODE`. Omitting that export leaves the harness on its own
 * `workspace-write` preset, which still asks, so an absent config is already
 * safe; a sent one is forced down to `workspace-write` rather than to
 * `read-only`, because the clamp exists to remove PRIVILEGE, not to break a
 * session's ability to edit its own workspace.
 */
async function clampExternalCliBypassForOwner(
  owner: string | undefined,
  codexConfig: CodexConfig | undefined,
  geminiConfig: GeminiConfig | undefined,
  antigravityConfig: AntigravityConfig | undefined,
  piConfig: PiConfig | undefined,
  grokConfig: GrokConfig | undefined,
  deepSeekConfig: DeepSeekConfig | undefined
): Promise<{
  codexConfig: CodexConfig | undefined;
  geminiConfig: GeminiConfig | undefined;
  antigravityConfig: AntigravityConfig | undefined;
  piConfig: PiConfig | undefined;
  grokConfig: GrokConfig | undefined;
  deepSeekConfig: DeepSeekConfig | undefined;
}> {
  const granted = await canUsernameRunPrivilegedCommands(owner);
  if (granted) return { codexConfig, geminiConfig, antigravityConfig, piConfig, grokConfig, deepSeekConfig };
  // Non-granted: force codex/antigravity bypass off (only meaningful when a config was
  // sent) and materialize gemini to auto_edit (clamps an explicit 'yolo' and the yolo default)
  // and pi to --no-approve (clamps an explicit true AND pi's own "ask" default).
  const clampedCodex = codexConfig ? { ...codexConfig, dangerouslyBypassApprovals: false } : codexConfig;
  const clampedGemini: GeminiConfig = { ...(geminiConfig ?? {}), approvalMode: 'auto_edit' };
  const clampedAntigravity = antigravityConfig
    ? { ...antigravityConfig, dangerouslySkipPermissions: false }
    : antigravityConfig;
  const clampedPi: PiConfig = { ...(piConfig ?? {}), approveProjectTrust: false };
  const clampedGrok = grokConfig ? { ...grokConfig, alwaysApprove: false } : grokConfig;
  const clampedDeepSeek = deepSeekConfig
    ? { ...deepSeekConfig, permissionMode: 'workspace-write' as const }
    : deepSeekConfig;
  return {
    codexConfig: clampedCodex,
    geminiConfig: clampedGemini,
    antigravityConfig: clampedAntigravity,
    piConfig: clampedPi,
    grokConfig: clampedGrok,
    deepSeekConfig: clampedDeepSeek,
  };
}

/** Test hook: the clamp is the multi-user safety gate for the external CLIs' privileged flags. */
export const _clampExternalCliBypassForOwner = clampExternalCliBypassForOwner;

/**
 * Env-var keys a non-granted owner must not be able to set, because each one
 * hands back privilege the config clamp above just removed, or redirects a
 * credential-resolution endpoint.
 *
 * The DeepSeek three are reachable because `DSH_*` and `DEEPSEEK_*` are
 * allowlisted `envOverrides` prefixes (schemas.ts) — which they have to be, since
 * that is also how a user configures the harness's non-privileged knobs.
 *
 * - `DSH_PERMISSION_MODE` IS the harness's permission switch. Every other CLI's
 *   bypass is a command-line FLAG, reachable only through the per-CLI config the
 *   clamp already owns; this one is an env var, so the config clamp alone is
 *   half a gate.
 * - `DSH_HOME` points the launcher at a profile tree, and a profile's plugin code
 *   executes at BOOT, before any approval row can apply. A user who can write a
 *   workspace can put a profile in it, so this is the wider of the two.
 * - `DEEPSEEK_BASE_URL` aims the provider endpoint, and `_configureDeepSeek()`
 *   forwards the SERVER's own `DEEPSEEK_API_KEY` into every dsh pane before
 *   `applyEnvOverrides()` runs — so a non-granted owner who could set the base
 *   URL would have the operator's API key sent as a bearer credential to a host
 *   of their choosing. (`DEEPSEEK_API_KEY` itself stays overridable: supplying
 *   your OWN key removes privilege rather than granting it.)
 * - `OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN` are where omp resolves
 *   credentials from — the same shape as `DEEPSEEK_BASE_URL` above, reachable
 *   because `OMP_*` is an allowlisted prefix. Unlike DeepSeek, Codeman does not
 *   forward any operator-held key into an omp pane today (omp's provider
 *   credentials live in `~/.omp` config files, not env vars), so there is no
 *   known concrete exfiltration path yet — clamped defensively anyway, since a
 *   non-granted owner redirecting where a shared multi-tenant deployment
 *   resolves auth from is not something to allow silently (found in
 *   Ark0N/Codeman#353 review; omp's own knobs are otherwise mostly `PI_*`,
 *   already allowlisted for pi and not addressed here — see resolveOmpHome()).
 */
const OWNER_CLAMPED_ENV_KEYS = [
  'DSH_PERMISSION_MODE',
  'DSH_HOME',
  'DEEPSEEK_BASE_URL',
  'OMP_AUTH_BROKER_URL',
  'OMP_AUTH_BROKER_TOKEN',
] as const;

/**
 * Env-var half of the multi-user bypass clamp.
 *
 * `clampExternalCliBypassForOwner()` clamps the per-CLI CONFIG, and for every CLI
 * but DeepSeek that is the whole story. Here it is not: `applyEnvOverrides()` runs
 * AFTER `_configureDeepSeek()` in tmux-manager, so an override sent on the SAME
 * request lands last and wins, and a non-granted owner could restore
 * `danger-full-access` on the very request the config clamp downgraded.
 *
 * Keys are DROPPED rather than rewritten: dropping falls through to what
 * `_configureDeepSeek()` exports, which is the clamped config and the server's own
 * `DSH_HOME`, i.e. exactly the intended state. No-op in single-user mode and for a
 * granted owner, like every other clamp here
 * (`canUsernameRunPrivilegedCommands()` returns true when `!isMultiUserMode()`),
 * and it returns the caller's own object untouched when there is nothing to strip.
 */
async function clampEnvOverridesForOwner(
  owner: string | undefined,
  envOverrides: Record<string, string> | undefined
): Promise<Record<string, string> | undefined> {
  if (!envOverrides) return envOverrides;
  if (!OWNER_CLAMPED_ENV_KEYS.some((key) => key in envOverrides)) return envOverrides;
  if (await canUsernameRunPrivilegedCommands(owner)) return envOverrides;
  const clamped = { ...envOverrides };
  for (const key of OWNER_CLAMPED_ENV_KEYS) delete clamped[key];
  return clamped;
}

/** Test hook: the env-var half of the same multi-user safety gate. */
export const _clampEnvOverridesForOwner = clampEnvOverridesForOwner;

/**
 * Why a DeepSeek session cannot start, or null when it can.
 *
 * Availability for this mode is TWO questions, not one, because `dsh` is a
 * profile launcher rather than an agent: the binary must resolve (and prove it
 * is the harness and not Debian's dancer's shell), AND a profile that can occupy
 * a pane must exist. Reporting only the first would let the Run button spawn a
 * pane that dies instantly, which is the single most confusing failure this mode
 * can produce, so each half gets its own actionable message.
 *
 * A profile named EXPLICITLY is checked on both counts: existence, and whether
 * it is pane-capable — `web` serves a browser UI and `headless` answers one task
 * and exits, so both would present as "the tab immediately died".
 */
async function resolveDeepSeekLaunchError(requestedProfile?: string): Promise<string | null> {
  // Thin async wrapper: the implementation moved into the resolver module so
  // CRON fires can ask the same question before constructing a Session; the
  // dynamic import keeps this file's startup free of the probe machinery.
  const { resolveDeepSeekLaunchError: impl } = await import('../../utils/deepseek-cli-resolver.js');
  return impl(requestedProfile);
}

// ═══════════════════════════════════════════════════════════════
// Agent wait helpers (shared by GET /wait, GET /wait-output, POST /input)
// ═══════════════════════════════════════════════════════════════

/**
 * Validate a wait query WITHOUT throwing away the Zod issue.
 *
 * `parseBody`'s message argument REPLACES the issue text, so `?timeout=30s` came
 * back as a bare "Invalid wait parameters": the caller could not tell which of
 * `until`, `timeout` or `fresh` it got wrong, and its only move was to retry with
 * a different guess. These endpoints are driven by an LLM with no documentation in
 * context — the error message IS the documentation, which is why the signal parser
 * one line later goes to the trouble of naming the bad token and listing the valid
 * ones. This keeps the endpoint label AND names the offending field.
 */
function parseWaitQuery<T>(schema: z.ZodType<T>, query: unknown, label: string): T {
  const result = schema.safeParse(query);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.join('.') : '';
  const detail = issue?.message ?? 'validation failed';
  const message = field ? `Invalid ${label} parameter '${field}': ${detail}` : `Invalid ${label} parameters: ${detail}`;
  throw Object.assign(new Error(message), {
    statusCode: 400,
    body: createErrorResponse(ApiErrorCode.INVALID_INPUT, message),
  });
}

/**
 * Map a waiter-cap rejection to the code that tells the caller the truth.
 *
 * The two caps mean different things and warrant different recovery: `session` is
 * genuinely about THIS session, while `owner` and `total` are process-wide budgets
 * that say nothing about it. Reporting a global cap as `SESSION_BUSY` (409,
 * documented as "Session is busy") sent an agent off to a different session to hit
 * the identical error. `RATE_LIMITED` is the code whose whole meaning is "come back
 * later", and clients and proxies already treat 429 that way.
 */
function waitCapacityResponse(err: WaitCapacityError): ApiResponse<never> {
  const code = err.scope === 'session' ? ApiErrorCode.SESSION_BUSY : ApiErrorCode.RATE_LIMITED;
  // The registry's message already names the scope and the limit; passing it through
  // verbatim keeps the wording in one place.
  return createErrorResponse(code, err.message);
}

/**
 * The signal a session is ALREADY emitting, corrected for liveness.
 *
 * `signalForStatus` alone is not enough here, because `Session` parks a DEAD PTY at
 * `_status = 'idle'` (both `onExit` handlers do) and the object survives in the
 * session map until an explicit DELETE. Trusting the status therefore answers the
 * default wait with `{signal:"idle", immediate:true}` for a worker that has
 * crashed — HTTP 200, no error anywhere, and the agent types its next prompt into a
 * corpse — while `until=exit` blocks for the full timeout on an event that already
 * happened and can never happen again.
 *
 * `pid === null` means no process is behind this session: it exited, it was
 * detached, or it was created and never started. All three are `exit` from a
 * caller's point of view — nothing is running — and in all three the agent's
 * correct next move is to (re)start the worker rather than to type at it. The
 * response still carries the raw `status` alongside, so nothing is hidden.
 *
 * ⚠️ `pid` alone is NOT enough, and on the normal configuration it is never the
 * thing that fires — see `workerIsDead()`. `dead` carries the mux layer's answer.
 *
 * Fixing it HERE rather than in `signalForStatus` is deliberate: liveness is not
 * derivable from `SessionStatus`, and the registry holds no `Session` reference.
 */
function currentSignalFor(session: { pid: number | null; status: SessionStatus }, dead: boolean): WaitSignal | null {
  if (dead || session.pid === null || session.pid === undefined) return 'exit';
  return signalForStatus(session.status);
}

// ── Worker liveness for tmux-backed sessions ────────────────────────────────
//
// `session.pid` is the LOCAL `tmux attach` client, not the worker. Codeman sets
// `remain-on-exit on` for every session it creates, so when the command inside the
// pane exits, tmux keeps the pane (`pane_dead=1`), the tmux session survives, the
// attach client keeps running and `pid` never goes null — no `exit` event is emitted
// and nothing in `Session` changes. Measured on a shell worker killed with `exit 42`:
// tmux reports `pane_dead=1 status=42` while Codeman reports `pid=309406 status=idle`
// and the DEFAULT wait answers `{signal:"idle", immediate:true}` in 0 ms for a corpse.
// So the liveness check has to ask the mux layer. `pid === null` still matters: it is
// the right (and only) answer for a direct-PTY session, which has no pane to ask about.
//
// Cost control, because `isPaneDead()` is a synchronous `execSync` and `/wait` is
// polled in a loop by design:
//   1. Only mux-backed sessions are probed at all.
//   2. Only requests that actually wait probe — a plain `POST .../input` (the browser's
//      hot path, thousands per session) never touches tmux.
//   3. Results are cached per pane for PANE_DEATH_TTL_MS, so a poll loop cannot turn
//      into one exec per request.
//   4. The while-blocked watcher is ONE timer per session no matter how many waiters
//      are parked on it, and it exists only while at least one of them is.

/** How long a pane-liveness probe is reused. Long enough to absorb a poll loop. */
const PANE_DEATH_TTL_MS = 750;

/** How often a session with a parked waiter is re-checked for a dead worker. */
const PANE_DEATH_POLL_MS = 3_000;

/** Bounded, because a 24h server churns through panes. */
const paneDeathCache = new LRUMap<string, { dead: boolean; at: number }>({ maxSize: 256 });

/** One watcher per pane, refcounted by the waits currently parked on it. */
const paneDeathWatchers = new Map<string, { timer: NodeJS.Timeout; refs: number }>();

type LivenessSession = { usesMux?: boolean; muxName?: string | null };

/**
 * Whether the worker inside this session's tmux pane has exited.
 *
 * False for anything not tmux-backed (nothing to ask), and false when the probe is
 * unavailable or throws — an unknown answer must never invent a death.
 */
function workerIsDead(mux: InfraPort['mux'], session: LivenessSession, now: number = Date.now()): boolean {
  const muxName = session.usesMux === false ? null : session.muxName;
  if (!muxName) return false;
  // Defensive: `TerminalMultiplexer` declares it, but route-test doubles may not.
  if (typeof mux?.isPaneDead !== 'function') return false;

  const cached = paneDeathCache.get(muxName);
  if (cached && now - cached.at < PANE_DEATH_TTL_MS) return cached.dead;

  let dead = false;
  try {
    dead = mux.isPaneDead(muxName) === true;
  } catch {
    dead = false;
  }
  paneDeathCache.set(muxName, { dead, at: now });
  return dead;
}

/**
 * Release every waiter on a session whose worker has died, in the documented order.
 *
 * The same pair the PTY-exit listener and the delete path use, for the same reason:
 * `until=exit` callers get their signal, everyone else gets `ended: true` instead of
 * burning the rest of their timeout on feeds that will never produce anything.
 */
function releaseWaitersForDeadWorker(sessionId: string): void {
  sessionWaits.notifySignal(sessionId, 'exit');
  sessionWaits.cancelAll(sessionId);
}

/**
 * While a wait is parked on a mux-backed session, poll for the worker dying.
 *
 * Without this, a worker that dies DURING a wait is invisible: no `exit` event fires
 * (the attach client is still alive), no output arrives, and the caller blocks for its
 * full timeout — the common orchestration case, "send a prompt and wait", where the
 * worker crashes mid-turn.
 *
 * @returns a release function; call it in a `finally`, or the timer outlives the wait.
 */
function watchForDeadWorker(mux: InfraPort['mux'], session: LivenessSession, sessionId: string): () => void {
  const muxName = session.usesMux === false ? null : session.muxName;
  if (!muxName || typeof mux?.isPaneDead !== 'function') return () => {};

  const existing = paneDeathWatchers.get(muxName);
  if (existing) {
    existing.refs++;
  } else {
    const timer = setInterval(() => {
      if (!workerIsDead(mux, session)) return;
      releaseWaitersForDeadWorker(sessionId);
    }, PANE_DEATH_POLL_MS);
    // Auxiliary to the waiter's own timer, which is deliberately NOT unref'd; this one
    // must never be the reason the process stays up.
    timer.unref();
    paneDeathWatchers.set(muxName, { timer, refs: 1 });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = paneDeathWatchers.get(muxName);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      clearInterval(entry.timer);
      paneDeathWatchers.delete(muxName);
    }
  };
}

/** Test seam: pane-liveness state is module-level, so a suite must be able to reset it. */
export function _resetPaneLivenessState(): void {
  for (const entry of paneDeathWatchers.values()) clearInterval(entry.timer);
  paneDeathWatchers.clear();
  paneDeathCache.clear();
}

/** Test seam: how many panes are currently being watched for a dead worker. */
export function _paneDeathWatcherCount(): number {
  return paneDeathWatchers.size;
}

/**
 * An `AbortController` that fires when the CLIENT goes away, and only then.
 *
 * Freeing an abandoned waiter matters because the documented pattern is a loop of
 * short waits: `curl --max-time 30 ".../wait?timeout=600000"` abandons a live waiter
 * every iteration until the cap is hit and an innocent session reports busy. Same for
 * any proxy that cuts the connection.
 *
 * ⚠️ **It must listen on the RESPONSE, not the request.** `req.raw` emits `'close'`
 * as soon as the request body has finished streaming, which on a POST is BEFORE the
 * handler ever blocks — measured at +1ms with `aborted: false`, indistinguishable
 * from a real hang-up at +0ms. Wiring the abort there cancels every send-and-wait
 * instantly and silently kills the feature (it survives on GET only because a GET has
 * no body to finish). `reply.raw` emits `'close'` both when the response completes
 * and when the socket dies, and `writableFinished` is what tells those apart: true
 * only if the response actually went out. The guard is load-bearing, not defensive.
 *
 * `app.inject()` never emits `'close'` at all, so this is only observable over real
 * HTTP — which is why the regression test for it binds a port.
 */
function abortOnClientHangUp(reply: FastifyReply): AbortController {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller;
}

/**
 * Inject the agent skill into a case on create, surfacing only the REFUSALS.
 *
 * `applyAgentSkill` declines two shapes rather than writing through them ('foreign':
 * an unmarked skills/codeman the user authored; 'symlink': the skill dir or its
 * parent is a link). Both were silent: the user flips `agentSkillEnabled` on, nothing
 * appears in the case, and there is nowhere to look for why. The ordinary outcomes
 * ('installed'/'refreshed'/'unchanged') stay unlogged since they would print on every
 * single session create.
 *
 * Injection is best-effort and stays that way: neither a refusal nor a thrown error
 * may fail the create.
 */
async function injectAgentSkill(casePath: string): Promise<void> {
  const skillDir = join(casePath, '.claude', 'skills', 'codeman');
  try {
    // Claude Code loads a same-named USER-LEVEL skill (`~/.claude/skills/codeman`,
    // written once by `codeman skill install`) over the case copy injected below, so a
    // stale user copy silently replaces every fresh injection (observed 2026-08-14: an
    // old copy cost every spawned worker its lineage arc and the fast path). Keep it
    // current on the same trigger. Refresh-only + marker-guarded; quiet on refusal,
    // since a foreign user copy is the user's own authored skill, not a config error.
    await refreshUserAgentSkill();
    const result = await applyAgentSkill(casePath, true);
    if (result === 'foreign') {
      console.warn(
        `[agent-skill] not injected: ${skillDir} exists but is not Codeman-managed (no marker), refusing to touch it. Remove that copy if you want the packaged skill there.`
      );
    } else if (result === 'symlink') {
      console.warn(
        `[agent-skill] not injected: ${skillDir} (or its parent) is a symlink, refusing to write through it. Replace it with a real directory to let Codeman install the skill.`
      );
    }
  } catch (err: unknown) {
    console.warn(`[agent-skill] injection failed for ${skillDir}: ${getErrorMessage(err)}`);
  }
}

// Workspace hooks: the install-vs-refresh decision core moved to
// `applyWorkspaceHooks` in hooks-config.ts (imported above) so the non-route
// claude create paths — cron fires, legacy scheduled runs, the plan-orchestrator
// one-shots, the boot recovery sweep — share the SAME decision instead of
// bypassing the `workspaceHooksEnabled` setting. Route handlers here resolve the
// setting through the ConfigPort (tests stub it) and pass it as the second arg.

/**
 * A "Resume"/"continue" request for a NEW omp-mode session (the frontend's
 * resumeHistorySession(), or anyone hitting the API directly) carries
 * `continueSession: true` but no id — omp has none to give it, since Codeman
 * has never tracked its own conversation UUID. Left as `--continue`, that
 * picks whichever session file in the directory is newest, which silently
 * drifts to the WRONG conversation the moment a second omp session (this
 * one, a sibling worker, a stray manual run) has touched the same directory
 * more recently. Resolve the real id up front instead, same as the
 * dead-pane-respawn path in session.ts does, so even the FIRST relaunch of a
 * resumed conversation is pinned rather than guessed.
 */
export function resolveOmpConfigForCreate(
  mode: SessionMode,
  workingDir: string,
  ompConfig: OmpConfig | undefined
): OmpConfig | undefined {
  if (mode !== 'omp') return undefined;
  if (!ompConfig || ompConfig.resumeSessionId || !ompConfig.continueSession) {
    return ompConfig;
  }
  const resolvedId = findLatestOmpSessionId(workingDir);
  if (!resolvedId) {
    console.warn(
      `[Session] OMP: no session file found under ${workingDir} to pin --resume; falling back to ambiguous --continue`
    );
  }
  return resolvedId ? { ...ompConfig, resumeSessionId: resolvedId } : ompConfig;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort & InfraPort & AuthPort & TabLayoutPort
): void {
  // ═══════════════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════════════

  // ========== Logout ==========

  app.post('/api/logout', async (req, reply) => {
    // Invalidate server-side session token (not just the browser cookie)
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken) {
      ctx.authSessions?.delete(sessionToken);
    }
    reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
    return {};
  });

  // ═══════════════════════════════════════════════════════════════
  // Session CRUD (list, create, rename, color, delete, detail)
  // ═══════════════════════════════════════════════════════════════

  // ========== Session Listing ==========

  app.get('/api/sessions', async (req) => {
    const list = ctx.getLightSessionsState();
    if (!isMultiUserMode()) return list;
    const user = getAuthUser(req);
    if (user.role === 'admin') return list;
    return (list as Array<{ owner?: string }>).filter((s) => canAccessOwned(user, s.owner));
  });

  // ========== Legacy Session Tab Order (temporary synchronized compatibility bridge) ==========

  app.put('/api/session-order', async (req, reply): Promise<ApiResponse<{ order: string[] }>> => {
    try {
      const { order } = parseBody(SessionOrderUpdateSchema, req.body, 'Invalid session order');
      const user = getAuthUser(req);
      const result = await ctx.tabLayouts.putLegacyOrder(
        { owner: ownerLayoutKey(ownerFor(req)), isAdmin: user.role === 'admin' },
        order
      );
      return { success: true, data: { order: result.order } };
    } catch (error) {
      if (error instanceof TabLayoutValidationError) {
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, error.message));
      }
      throw error;
    }
  });

  // ========== Session Creation ==========

  app.post('/api/sessions', async (req) => {
    const owner = ownerFor(req);
    // Global + per-user session cap.
    const capMsg = sessionCapacityMessage(ctx.sessions, owner);
    if (capMsg) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, capMsg);

    const body = parseBody(CreateSessionSchema, req.body);
    let workingDir = body.workingDir || process.cwd();
    let remote = undefined;

    // COD-105 — attach to a discovered (non-owned) remote tmux session. The
    // remote session is already running, so we skip the tmux-prereq probe and
    // build a NON-owned SessionRemote (detach-not-kill on close). Remote CASE
    // creation (owned durable sessions) is handled by the dedicated case-create
    // endpoint below, which #145 consolidated remote-host resolution into.
    if (body.attachRemoteSession) {
      const { hostId, remoteSessionName } = body.attachRemoteSession;
      const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
      workingDir = `${host.username}@${host.host}:${remoteSessionName}`;
      remote = toAttachedSessionRemote(host, remoteSessionName, workingDir);
    }

    // Multi-user: shell mode is arbitrary command execution as the host account,
    // gated behind the same grant as bypass (section 6.3). Resolve the owner's grant
    // from the store so a GRANTED regular user is not wrongly denied (AuthUser role alone can't tell).
    if (body.mode === 'shell' && !(await canUsernameRunPrivilegedCommands(owner))) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Shell sessions require the can-bypass-permissions grant');
    }

    // Multi-user linchpin (section 6.2): a non-admin's workingDir must resolve
    // inside their own case space. Enforced BEFORE any disk-mutating call below so
    // a foreign path can never be written into.
    if (!isWorkingDirAllowed(getAuthUser(req), workingDir)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'workingDir is outside your workspace');
    }

    // Validate workingDir exists and is a directory
    if (body.workingDir) {
      try {
        const stat = statSync(workingDir);
        if (!stat.isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
      }
    }

    // envOverrides flow through Session → tmux setenv (ephemeral, per-session).
    //
    // For keys the caller is actively setting, strip any stale disk entry a prior
    // Codeman version may have written. Scope limited to:
    //   - Claude mode (OpenCode/Codex/Gemini/Antigravity don't read .claude/settings.local.json)
    //   - workingDir inside CASES_DIR / the per-user case space (Codeman's managed
    //     territory — we never mutate .claude/settings.local.json in arbitrary user
    //     repos that POST /api/sessions can target, as those may have hand-authored
    //     values).
    const managedCasesBase = resolveCasesDir(getAuthUser(req));
    const canStripDisk =
      body.mode !== 'opencode' &&
      body.mode !== 'codex' &&
      body.mode !== 'gemini' &&
      body.mode !== 'antigravity' &&
      body.mode !== 'pi' &&
      body.mode !== 'grok' &&
      body.mode !== 'deepseek' &&
      body.mode !== 'omp' &&
      body.envOverrides &&
      Object.keys(body.envOverrides).length > 0 &&
      (workingDir.startsWith(CASES_DIR + '/') || workingDir.startsWith(managedCasesBase + '/'));
    if (canStripDisk) {
      await stripCaseEnvKeys(workingDir, Object.keys(body.envOverrides!));
    }

    // Write model override to .claude/settings.local.json if provided
    if (body.modelOverride !== undefined) {
      await updateCaseModel(workingDir, body.modelOverride || null);
    }

    // Plan-usage telemetry request (App Settings → header chip). NO LONGER a
    // disk write here — a settings.local.json statusLine took precedence over
    // the user's own global/project statusLine for ANY `claude` run in that
    // directory, including entirely outside Codeman, with no disclosure and no
    // way to undo it (real bug, found 2026-08-31). The request now flows
    // through as an ordinary session field (statusLineTelemetryRequested below)
    // and Session/TmuxManager resolve it into an EPHEMERAL `claude --settings`
    // CLI flag at actual spawn time (resolveStatusLineCliCommand in
    // hooks-config.ts) — never written to disk, so a plain `claude` run outside
    // Codeman is untouched. That resolution also self-heals: it strips any
    // legacy disk-written exporter an older Codeman build left behind.
    const statusLineTelemetryRequested = body.statusLineTelemetry === true;

    // Hooks for the workspace this session runs in (install vs refresh-only is the
    // `workspaceHooksEnabled` setting; see applyWorkspaceHooks). Never for a remote
    // attach (workingDir is a user@host:session pseudo-path — mkdir would create it
    // as a junk local dir), and only when the caller named a workingDir: the
    // process-cwd fallback is $HOME under installer-created services, and hooks
    // materializing in ~/.claude/settings.local.json was never asked for.
    if (!remote && body.workingDir && (body.mode ?? 'claude') === 'claude') {
      await applyWorkspaceHooks(workingDir, await ctx.getWorkspaceHooksEnabled());
      // Agent skill (docs/agent-control-plan.md §2): ADD-ONLY on create, same shared-
      // .claude rationale as the statusLine above: a create must never remove the
      // skill from under other live sessions in the repo. Marker-guarded, so a
      // user's own skills/codeman is never touched.
      if (await ctx.getAgentSkillEnabled()) {
        await injectAgentSkill(workingDir);
      }
    }

    // Check OpenCode availability if requested. The error text comes from the
    // resolver (formatCliNotFoundMessage) so it names where resolution looked —
    // server PATH, login shell, common directories — same for the modes below.
    if (body.mode === 'opencode') {
      const { isOpenCodeAvailable, getOpenCodeNotFoundMessage } = await import('../../utils/opencode-cli-resolver.js');
      if (!isOpenCodeAvailable()) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getOpenCodeNotFoundMessage());
      }
    }

    // Check Codex availability if requested
    if (body.mode === 'codex') {
      const { isCodexAvailable, getCodexNotFoundMessage } = await import('../../utils/codex-cli-resolver.js');
      if (!isCodexAvailable()) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getCodexNotFoundMessage());
      }
    }

    // Check Gemini availability if requested
    if (body.mode === 'gemini') {
      const { isGeminiAvailable, getGeminiNotFoundMessage } = await import('../../utils/gemini-cli-resolver.js');
      if (!isGeminiAvailable()) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getGeminiNotFoundMessage());
      }
    }
    if (body.mode === 'antigravity') {
      const { isAntigravityAvailable, getAntigravityNotFoundMessage } =
        await import('../../utils/antigravity-cli-resolver.js');
      if (!isAntigravityAvailable()) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getAntigravityNotFoundMessage());
      }
    }
    if (body.mode === 'pi') {
      const { isPiAvailable, getPiNotFoundMessage } = await import('../../utils/pi-cli-resolver.js');
      if (!isPiAvailable()) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getPiNotFoundMessage());
      }
    }
    if (body.mode === 'deepseek') {
      const err = await resolveDeepSeekLaunchError(body.deepSeekConfig?.profile);
      if (err) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, err);
    }
    if (body.mode === 'grok') {
      const { isGrokAvailable, getGrokNotFoundMessage } = await import('../../utils/grok-cli-resolver.js');
      if (!isGrokAvailable()) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getGrokNotFoundMessage());
      }
    }
    if (body.mode === 'omp') {
      const { isOmpAvailable, getOmpNotFoundMessage } = await import('../../utils/omp-cli-resolver.js');
      if (!isOmpAvailable()) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getOmpNotFoundMessage());
      }
    }

    // Pre-validate resumeSessionId: check that the conversation file actually exists
    // in Claude's projects directory. If not, skip resume to avoid confusing
    // "No conversation found" errors from Claude CLI.
    let validatedResumeId = body.resumeSessionId;
    if (validatedResumeId) {
      const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');
      let found = false;
      try {
        const projectDirs = await fs.readdir(projectsDir);
        for (const projDir of projectDirs) {
          const sessionFile = join(projectsDir, projDir, `${validatedResumeId}.jsonl`);
          try {
            const stat = await fs.stat(sessionFile);
            if (stat.size > 4000) {
              found = true;
              break;
            }
          } catch {
            // File doesn't exist in this project dir
          }
        }
      } catch {
        // Projects dir doesn't exist
      }
      if (!found) {
        console.log(`[Session] Resume session ${validatedResumeId} not found on disk, starting fresh`);
        validatedResumeId = undefined;
      }
    }

    const globalNice = await ctx.getGlobalNiceConfig();
    const modelConfig = await ctx.getModelConfig();
    const mode = body.mode || 'claude';
    const model =
      mode === 'opencode'
        ? body.openCodeConfig?.model
        : mode === 'codex'
          ? body.codexConfig?.model
          : mode === 'gemini'
            ? body.geminiConfig?.model
            : mode === 'antigravity'
              ? body.antigravityConfig?.model
              : mode === 'pi'
                ? body.piConfig?.model
                : mode === 'grok'
                  ? body.grokConfig?.model
                  : mode === 'omp'
                    ? body.ompConfig?.model
                    : // DeepSeek's model is a composition entry in the profile's config
                      // tree, not a session flag, so there is deliberately nothing to
                      // read here (see docs/deepseek-integration.md).
                      mode !== 'shell' && mode !== 'deepseek'
                      ? modelConfig?.defaultModel || undefined
                      : undefined;
    const claudeModeConfig = await ctx.getClaudeModeConfig();
    // Section 6.3: force non-granted users to a classifier-guarded mode.
    const effectiveClaudeMode = await resolveClaudeModeForUsername(claudeModeConfig.claudeMode, owner);
    // Section 6.3: clamp Codex/Gemini/Antigravity bypass switches for a non-granted owner (no-op single-user/granted).
    const {
      codexConfig: gatedCodexConfig,
      geminiConfig: gatedGeminiConfig,
      antigravityConfig: gatedAntigravityConfig,
      piConfig: gatedPiConfig,
      grokConfig: gatedGrokConfig,
      deepSeekConfig: gatedDeepSeekConfig,
    } = await clampExternalCliBypassForOwner(
      owner,
      body.codexConfig,
      body.geminiConfig,
      body.antigravityConfig,
      body.piConfig,
      body.grokConfig,
      body.deepSeekConfig
    );
    const terminalHistoryConfig = await ctx.getTerminalHistoryConfig();
    const session = new Session({
      workingDir,
      mode,
      name: body.name || '',
      mux: ctx.mux,
      useMux: true,
      niceConfig: globalNice,
      model,
      claudeMode: effectiveClaudeMode,
      allowedTools: claudeModeConfig.allowedTools,
      openCodeConfig: mode === 'opencode' ? body.openCodeConfig : undefined,
      codexConfig: mode === 'codex' ? gatedCodexConfig : undefined,
      geminiConfig: mode === 'gemini' ? gatedGeminiConfig : undefined,
      antigravityConfig: mode === 'antigravity' ? gatedAntigravityConfig : undefined,
      piConfig: mode === 'pi' ? gatedPiConfig : undefined,
      grokConfig: mode === 'grok' ? gatedGrokConfig : undefined,
      deepSeekConfig: mode === 'deepseek' ? gatedDeepSeekConfig : undefined,
      ompConfig: resolveOmpConfigForCreate(mode, workingDir, body.ompConfig),
      resumeSessionId: validatedResumeId,
      envOverrides: await clampEnvOverridesForOwner(owner, body.envOverrides),
      effort: body.effort,
      statusLineTelemetry: statusLineTelemetryRequested,
      tmuxHistoryLimit: terminalHistoryConfig.tmuxHistoryLimit,
      remote,
      owner,
      parentSessionId: resolveParentSessionId(ctx, req, body.parentSessionId, owner),
    });

    await ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    // Pre-seed the agent skill's preamble cache so its §0 bootstrap is a two-line
    // loader (see seedAgentSessionPreamble). Local claude sessions only; best-effort.
    if (mode === 'claude' && !remote && (await ctx.getAgentSkillEnabled())) {
      await seedAgentSessionPreamble(session.id).catch((err: unknown) =>
        console.warn(`[agent-skill] preamble seed failed for ${session.id}: ${getErrorMessage(err)}`)
      );
    }
    getLifecycleLog().log({ event: 'created', sessionId: session.id, name: session.name });

    // Use light state for broadcast + response — buffers are fetched on-demand via /terminal.
    // Avoids serializing 2-3MB of terminal+text buffers per session creation.
    const lightState = ctx.getSessionStateWithRespawn(session);
    ctx.broadcast(SseEvent.SessionCreated, lightState);
    return { session: lightState };
  });

  // ========== Rename Session ==========

  app.put('/api/sessions/:id/name', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(SessionNameSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    const name = String(body.name || '').slice(0, MAX_SESSION_NAME_LENGTH);
    session.name = name;
    // Also update the mux session name if applicable
    ctx.mux.updateSessionName(id, session.name);
    persistAndBroadcastSession(ctx, session);
    return { name: session.name };
  });

  // ========== Set Session Color ==========

  app.put('/api/sessions/:id/color', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(SessionColorSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
    if (!validColors.includes(body.color)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid color');
    }

    session.setColor(body.color as SessionColor);
    persistAndBroadcastSession(ctx, session);
    return { color: session.color };
  });

  // ========== Delete Session ==========

  app.delete('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { killMux?: string };
    const killMux = query.killMux !== 'false'; // Default to true

    // A resumed/detached-but-never-live row (e.g. a non-claude "Resume" that
    // relaunched into a NEW session and wants to retire the old one it can no
    // longer reattach to) has no entry in ctx.sessions at all — only in
    // persisted state. Fall back to removing that persisted record directly
    // rather than 404ing: the caller means "make this row go away", and a
    // stale duplicate row is exactly what's left behind otherwise. Pinned
    // sessions keep their existing demote-not-delete protection.
    if (!ctx.sessions.has(id)) {
      // Called for its existence/ownership 404 side effect only — demoteOrRemoveSession
      // below re-looks-up the record by id, so the returned SessionState is unused here.
      findPersistedSessionOrFail(ctx.store, id, req);
      ctx.store.demoteOrRemoveSession(id);
      // Mirrors the broadcast at the tail of the live-session cleanup path
      // (_doCleanupSession in server.ts) — without it, other open tabs keep
      // showing the retired row until their next unrelated fetch.
      ctx.broadcast(SseEvent.SessionDeleted, { id });
      return {};
    }

    const session = findSessionOrFail(ctx, id, req);
    await ctx.cleanupSession(session.id, killMux, 'user_delete');
    return {};
  });

  // ========== Delete All Sessions ==========

  app.delete('/api/sessions', async (req): Promise<ApiResponse<{ killed: number }>> => {
    // Security: scope the bulk sweep to sessions the caller can access — a non-admin
    // must not wipe other users' sessions (canAccessOwned is allow-all for admin/single-user).
    const user = getAuthUser(req);
    const sessionIds = Array.from(ctx.sessions.values())
      .filter((s) => canAccessOwned(user, s.owner))
      .map((s) => s.id);
    let killed = 0;

    for (const id of sessionIds) {
      if (ctx.sessions.has(id)) {
        await ctx.cleanupSession(id, true, 'user_bulk_delete');
        killed++;
      }
    }

    return { success: true, data: { killed } };
  });

  // ========== Get Session Detail ==========

  app.get('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    // Use light state (no full buffers) — terminal buffer available via /terminal endpoint.
    // Full buffers were 2-3MB and caused slowness when polled frequently (e.g. Ralph wizard).
    return ctx.getSessionStateWithRespawn(session);
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Data (output, ralph state, run summary, active tools)
  // ═══════════════════════════════════════════════════════════════

  // ========== Get Session Output ==========

  app.get('/api/sessions/:id/output', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    return {
      success: true,
      data: {
        textOutput: session.textOutput,
        messages: session.messages,
        errorBuffer: session.errorBuffer,
      },
    };
  });

  // ========== Get Ralph State ==========

  app.get('/api/sessions/:id/ralph-state', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    return {
      success: true,
      data: {
        loop: session.ralphLoopState,
        todos: session.ralphTodos,
        todoStats: session.ralphTodoStats,
      },
    };
  });

  // ========== Get Run Summary ==========

  app.get('/api/sessions/:id/run-summary', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    const tracker = ctx.runSummaryTrackers.get(id);
    if (!tracker) {
      // Create a fresh tracker if one doesn't exist (shouldn't happen normally)
      const newTracker = new RunSummaryTracker(id, session.name);
      ctx.runSummaryTrackers.set(id, newTracker);
      return { summary: newTracker.getSummary() };
    }

    // Update session name in case it changed
    tracker.setSessionName(session.name);

    return { summary: tracker.getSummary() };
  });

  // ========== Get Active Tools ==========

  app.get('/api/sessions/:id/active-tools', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    return {
      success: true,
      data: {
        tools: session.activeTools,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Execution (run prompt, interactive mode, shell mode)
  // ═══════════════════════════════════════════════════════════════

  // ========== Run Prompt ==========

  app.post('/api/sessions/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const { prompt } = parseBody(RunPromptSchema, req.body);
    const session = findSessionOrFail(ctx, id, req);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    // Run async, don't wait
    session.runPrompt(prompt).catch((err) => {
      ctx.broadcast(SseEvent.SessionError, { id, error: err.message });
    });

    ctx.broadcast(SseEvent.SessionRunning, { id, prompt });
    return {};
  });

  // ========== Start Interactive Mode ==========

  app.post('/api/sessions/:id/interactive', async (req) => {
    const { id } = req.params as { id: string };
    // Body is optional (auto-reattach callers send none) — same idiom as /interactive-respawn.
    const bodyResult = req.body
      ? InteractiveStartSchema.safeParse(req.body)
      : { success: true as const, data: {} as { clearBreaker?: boolean } };
    if (!bodyResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const { clearBreaker } = bodyResult.data;
    const session = findSessionOrFail(ctx, id, req);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    try {
      // Auto-detect completion phrase from CLAUDE.md BEFORE starting (only if globally enabled and not explicitly disabled by user)
      // Ralph tracker is not supported for opencode / codex / gemini / antigravity / pi sessions.
      // Keep this list in step with isExternalCliMode(): _processExpensiveParsers() returns early
      // for those modes, so a tracker enabled here would never be fed, and the session would
      // still report ralphEnabled + Ralph UI state that no other external CLI shows.
      if (
        session.mode !== 'opencode' &&
        session.mode !== 'codex' &&
        session.mode !== 'gemini' &&
        session.mode !== 'antigravity' &&
        session.mode !== 'pi' &&
        session.mode !== 'grok' &&
        session.mode !== 'deepseek' &&
        session.mode !== 'omp' &&
        ctx.store.getConfig().ralphEnabled &&
        !session.ralphTracker.autoEnableDisabled
      ) {
        autoConfigureRalph(session, session.workingDir, ctx);
        if (!session.ralphTracker.enabled) {
          session.ralphTracker.enable();
        }
      }

      // COD-118: ONLY an explicit user-initiated restart (body {clearBreaker:true})
      // clears a tripped PTY-exit circuit breaker. This endpoint is ALSO the frontend's
      // automatic re-attach path (selectSession auto-POSTs it for any pid===null
      // session), so an unconditional reset here would re-arm the exact crash loop
      // the breaker exists to stop — auto-reattach sends no body and must not clear.
      if (clearBreaker) {
        session.resetRespawnBreaker();
      }
      // Re-attach listener wiring if a prior PTY exit detached it: the wiring exit
      // handler removes ALL session listeners (incl. respawnBreakerTripped), and only
      // session-create/boot-recovery paths ran setupSessionListeners before this fix —
      // without this, a re-attached session's SSE/terminal/trip events go unobserved.
      // setupSessionListeners is idempotent (no-op while refs are still attached).
      await ctx.setupSessionListeners(session);
      await session.startInteractive();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: session.mode,
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id });
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });

      return {};
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Start Shell Mode ==========

  app.post('/api/sessions/:id/shell', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    try {
      // Re-attach listener wiring if a prior PTY exit detached it (see /interactive).
      await ctx.setupSessionListeners(session);
      await session.startShell();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: 'shell',
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id, mode: 'shell' });
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });
      return {};
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Terminal I/O (input, resize, buffer)
  // ═══════════════════════════════════════════════════════════════

  // ========== Send Input ==========

  app.post('/api/sessions/:id/input', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { input, useMux, seq, clientId, wait, waitTimeout } = parseBody(SessionInputWithLimitSchema, req.body);
    const session = findSessionOrFail(ctx, id, req);

    const inputStr = String(input);
    if (inputStr.length > MAX_INPUT_LENGTH) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Input exceeds maximum length (${MAX_INPUT_LENGTH} bytes)`
      );
    }

    // Send-and-wait (agent orchestration). This has to be ONE endpoint rather than a
    // POST followed by GET .../wait: between the write and the session flipping to
    // `working` there is a window in which a separate wait sees the session still
    // idle and returns instantly, reporting the PREVIOUS turn as this turn's answer.
    // Registering the waiter before the write closes that window.
    const wantsWait =
      wait === true || (typeof wait === 'string' && wait.trim().length > 0) || (Array.isArray(wait) && wait.length > 0);
    let until: readonly WaitSignal[] = [];
    if (wantsWait) {
      const resolved = resolveWaitSignals(wait === true ? undefined : wait, {
        mode: session.mode,
        ...sessionHookOptions(session),
      });
      if (resolved.error) return createErrorResponse(ApiErrorCode.INVALID_INPUT, resolved.error);
      until = resolved.until;
    }

    // Reliable delivery (POST fallback when the WebSocket is down): a 2xx IS the
    // client's ACK, so a tagged duplicate redelivery must still return 200 but
    // skip the write. Untagged requests (curl/legacy) always apply.
    const tagged = typeof clientId === 'string' && typeof seq === 'number';
    const duplicate = tagged && !session.shouldApplyInput(clientId as string, seq as number);
    if (duplicate && !wantsWait) {
      return {};
    }

    // Only a waiting request pays for the tmux probe: the browser's plain input path
    // (thousands of calls per session) must stay exec-free.
    const workerDead = wantsWait && workerIsDead(ctx.mux, session);

    const timeoutMs = clampWaitMs(waitTimeout ?? undefined);
    // Same slot leak as the GET routes: a client that gives up mid-wait would
    // otherwise hold a waiter for the full timeout. Response-side, always — see
    // abortOnClientHangUp: on THIS route a request-side listener fires the moment the
    // JSON body finishes streaming and aborts every send-and-wait before it starts.
    const abort = abortOnClientHangUp(reply);
    let waitPromise: Promise<SignalWaitResult> | null = null;
    if (wantsWait) {
      try {
        waitPromise = sessionWaits.waitForSignal(id, {
          until,
          timeoutMs,
          owner: ownerFor(req),
          abortSignal: abort.signal,
          // A FRESH delivery must not be satisfied by the state the session is already
          // in: it is idle right now, which is precisely why we are typing at it.
          // A DUPLICATE has no new turn coming, so it answers from the current state
          // instead of blocking for a transition that already happened.
          requireTransition: !duplicate,
          currentSignal: duplicate ? currentSignalFor(session, workerDead) : undefined,
        });
      } catch (err) {
        if (err instanceof WaitCapacityError) {
          // Nothing has been written yet, but `shouldApplyInput` already consumed the
          // seq. Give it back or the caller's retry is rejected as a duplicate and the
          // input is lost by the very mechanism meant to make delivery reliable.
          if (tagged && !duplicate) session.forgetInputSeq(clientId as string, seq as number);
          return waitCapacityResponse(err);
        }
        throw err;
      }
    }
    const stopDeathWatch = wantsWait ? watchForDeadWorker(ctx.mux, session, id) : () => {};

    // Write input to PTY. Direct write is synchronous; writeViaMux
    // (tmux send-keys) is fire-and-forget to avoid blocking the HTTP response.
    //
    // Because the response has already been sent by then, a failure there is the
    // one case the caller can never learn about — so the dedup bookkeeping is
    // rolled back. Otherwise the seq stays recorded as applied and a retry, the
    // very mechanism reliable delivery exists for, is rejected as a duplicate.
    const undoOnFailure = () => {
      if (tagged) session.forgetInputSeq(clientId as string, seq as number);
    };

    // Whether the bytes actually reached a write path. Only meaningful on the wait
    // path (the fire-and-forget branches return before the response is built), and
    // reported there instead of the old `!duplicate`: a PTY that has exited fails
    // BOTH writes, and telling the caller "delivered, but it timed out" points it at
    // the wrong recovery — wait longer, when the truth is "restart the worker".
    let delivered = false;

    if (duplicate) {
      // Redelivery of an already-applied input: skip the write, but still honor the
      // wait, since the caller's question ("tell me when this settles") is unanswered.
    } else if (useMux && waitPromise) {
      // The response is already staying open for the wait, so the tmux write can be
      // awaited here. This is the ONE path where a writeViaMux failure is observable.
      const ok = await session.writeViaMux(inputStr).catch(() => false);
      if (ok) {
        delivered = true;
      } else {
        console.warn(`[Server] writeViaMux failed for session ${id}, falling back to direct write`);
        delivered = session.write(inputStr);
        if (!delivered) undoOnFailure();
      }
    } else if (useMux) {
      // Fire-and-forget: don't block the HTTP response on a tmux child process.
      // Fallback to a direct write on failure. Unchanged from before send-and-wait.
      session
        .writeViaMux(inputStr)
        .then((ok) => {
          if (ok) return;
          console.warn(`[Server] writeViaMux failed for session ${id}, falling back to direct write`);
          if (!session.write(inputStr)) undoOnFailure();
        })
        .catch(() => {
          if (!session.write(inputStr)) undoOnFailure();
        });
    } else {
      // Same rollback. NOT an error response, deliberately: a session can
      // legitimately have no PTY yet (created but not started), and callers have
      // always been able to write to one without a 4xx.
      delivered = session.write(inputStr);
      if (!delivered && tagged) {
        session.forgetInputSeq(clientId as string, seq as number);
      }
    }

    if (!waitPromise) return {};

    try {
      // `send-keys` SUCCEEDS against a dead pane — tmux is happy to write into a corpse
      // — so a truthful `delivered` cannot come from the write's return value alone.
      // This is the case the field exists for: "delivered, but it timed out" tells an
      // agent to wait longer when the truth is "restart the worker".
      if (delivered && workerDead) {
        delivered = false;
        // The bytes went nowhere, so the seq must not be recorded as applied or the
        // caller's retry against a restarted worker is refused as a duplicate.
        if (!duplicate) undoOnFailure();
      }

      // Nothing was written and nothing will be: no turn is coming, so blocking for the
      // full timeout would only delay the caller's real recovery by up to ten minutes.
      // Releasing the waiter also hands its slot back immediately.
      const selfReleased = !delivered && !duplicate;
      if (selfReleased) abort.abort();

      const result = await waitPromise;
      return {
        success: true,
        data: {
          delivered,
          duplicate,
          status: session.status,
          limitPaused: session.isLimitPaused,
          // Identical `wait` object to the two GET endpoints, so one client helper
          // reads all three, `timeoutMs` (post-clamp) included.
          //
          // `aborted` is the CLIENT-facing "you hung up, nobody is reading this", and
          // by that definition it is unobservable — which is exactly what the API
          // reference promises. The abort above is the server releasing its own waiter
          // on a delivery that failed, and the client IS reading this response, so
          // reporting `aborted: true` there would break that promise and hand an agent
          // a second, contradictory reason for the same outcome. `delivered: false`
          // already says what happened; `ended` says the wait was released early.
          wait: { ...result, aborted: selfReleased ? false : result.aborted, until: [...until] },
        },
      };
    } finally {
      stopDeathWatch();
    }
  });

  // ========== Wait For A Signal (agent orchestration) ==========
  //
  // A bounded long-poll: block until the session hits one of `until`, then answer.
  // This exists because SSE is the only "tell me when" channel Codeman has, and an
  // agent driving the API from a shell tool cannot hold a stream and parse events
  // inline. See docs/agent-control-plan.md.
  //
  // A TIMEOUT IS A 200, not an error: callers are expected to loop over short waits
  // (proxies such as `tailscale serve` cut idle connections), and turning every poll
  // boundary into a 4xx would make that loop indistinguishable from a real failure.

  app.get('/api/sessions/:id/wait', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = parseWaitQuery(SessionWaitQuerySchema, req.query, 'wait');
    const session = findSessionOrFail(ctx, id, req);

    // An agent polls this URL in a loop with identical parameters. Any intermediary
    // applying heuristic freshness to the 200 would serve the stored `timedOut:true`
    // body to the next iteration instantly, turning the loop into a busy spin that
    // never observes the signal.
    reply.header('Cache-Control', 'no-store');

    // Shared with the `wait` field on POST .../input: unknown token is a 400,
    // hook-only signals are rejected explicitly but dropped from the default.
    const { until, error } = resolveWaitSignals(query.until, { mode: session.mode, ...sessionHookOptions(session) });
    if (error) return createErrorResponse(ApiErrorCode.INVALID_INPUT, error);

    // The value actually applied after clamping, echoed below: a caller that asked
    // for 30 minutes and silently got 10 could not otherwise tell a poll boundary
    // from a wedged worker, and would kill a session that was working fine.
    const timeoutMs = clampWaitMs(query.timeout);

    // Free the waiter when the caller hangs up; the response can no longer be sent by
    // then, so freeing the slot is the entire purpose.
    const abort = abortOnClientHangUp(reply);
    // A worker that dies while this request is parked emits nothing at all (the tmux
    // attach client survives it), so a wait would otherwise run to its full timeout.
    const stopDeathWatch = watchForDeadWorker(ctx.mux, session, id);

    try {
      const result = await sessionWaits.waitForSignal(id, {
        until,
        timeoutMs,
        owner: ownerFor(req),
        abortSignal: abort.signal,
        requireTransition: query.fresh === '1' || query.fresh === 'true',
        // Read BEFORE awaiting: this is the state the caller is asking about.
        currentSignal: currentSignalFor(session, workerIsDead(ctx.mux, session)),
      });

      return {
        success: true,
        data: {
          sessionId: id,
          // Post-wait status, so a caller that timed out still learns where things stand.
          status: session.status,
          // A session paused on a usage limit emits nothing until its reset, so a
          // timeout here is expected rather than a stall worth retrying hard.
          limitPaused: session.isLimitPaused,
          // One shape across all three endpoints, so a single `is_done(resp)` helper
          // works against any of them. `result.timeoutMs` is the value actually
          // applied after clamping, which is what makes the clamp observable.
          wait: { ...result, until: [...until] },
        },
      };
    } catch (err) {
      if (err instanceof WaitCapacityError) return waitCapacityResponse(err);
      throw err;
    } finally {
      stopDeathWatch();
    }
  });

  // ========== Wait For Output (agent orchestration) ==========
  //
  // The companion to /wait: block until a literal string appears in this session's
  // output. Same 200-on-timeout contract. Fed by the `terminal` listener in
  // session-listener-wiring.ts, so what this scans is byte-for-byte what the pane
  // printed, ANSI stripped.
  //
  // ⚠️ A tmux repaint replays text already on screen, so `from=now` can match
  // something printed before the request. Callers need a marker unique per call.

  app.get('/api/sessions/:id/wait-output', async (req, reply) => {
    const { id } = req.params as { id: string };

    // Reject `regex` loudly instead of ignoring it. Matching is deliberately literal
    // (no ReDoS surface on a caller-supplied pattern over a live stream), and an agent
    // that assumed otherwise would silently wait on the wrong thing.
    if (req.query && typeof req.query === 'object' && 'regex' in req.query) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'regex is not supported; use match=<literal substring> (optionally with nocase=1)'
      );
    }

    const query = parseWaitQuery(SessionWaitOutputQuerySchema, req.query, 'wait-output');
    const session = findSessionOrFail(ctx, id, req);

    // Same reason as /wait: this URL is polled in a loop with identical parameters.
    reply.header('Cache-Control', 'no-store');

    const timeoutMs = clampWaitMs(query.timeout);
    const abort = abortOnClientHangUp(reply);
    const owner = ownerFor(req);
    // Output waiters are the ones a dead worker strands hardest: the feed simply stops.
    const stopDeathWatch = watchForDeadWorker(ctx.mux, session, id);

    try {
      // Check the cap BEFORE touching the buffer. `session.terminalBuffer` is
      // `BufferAccumulator.value`, which joins the WHOLE accumulator (up to 32MB)
      // before the slice below takes its tail — so a request that is going to be
      // rejected anyway must not pay for a full materialization first, or the cap
      // provides no backpressure at all against a `from=buffer` loop.
      sessionWaits.assertCapacity(id, owner);

      // `from=buffer` scans what already scrolled past before blocking. Bounded to a
      // tail: the buffer runs to 32MB and this is a per-request ANSI strip.
      let initialText: string | undefined;
      if (query.from === 'buffer') {
        const buffer = session.terminalBuffer;
        initialText =
          buffer.length > MAX_BUFFER_SCAN_BYTES ? buffer.slice(buffer.length - MAX_BUFFER_SCAN_BYTES) : buffer;
      }

      const result = await sessionWaits.waitForOutput(id, {
        match: query.match,
        nocase: query.nocase === '1' || query.nocase === 'true',
        timeoutMs,
        owner,
        abortSignal: abort.signal,
        initialText,
      });

      return {
        success: true,
        data: {
          sessionId: id,
          status: session.status,
          limitPaused: session.isLimitPaused,
          // Same envelope as /wait; this one carries `matched`/`snippet`/`match`
          // where the signal wait carries `signal`/`until`.
          wait: { ...result, match: query.match },
        },
      };
    } catch (err) {
      if (err instanceof WaitCapacityError) return waitCapacityResponse(err);
      throw err;
    } finally {
      stopDeathWatch();
    }
  });

  // ========== Send Named Key (tmux send-keys -H) ==========
  // Sends raw hex bytes to tmux pane for keys like Shift+Enter / Ctrl+Enter.
  // Uses send-keys -H (hex) to inject 0x0a (line feed) which Claude Code's
  // Ink input recognizes as "insert newline" vs 0x0d (carriage return = submit).

  app.post('/api/sessions/:id/send-key', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const key = typeof body?.key === 'string' ? body.key : '';

    // Map key names to hex byte sequences
    const KEY_HEX_MAP: Record<string, string[]> = {
      'S-Enter': ['0a'], // \n (line feed)
      'C-Enter': ['0a'], // \n (line feed)
    };
    const hex = KEY_HEX_MAP[key];
    if (!hex) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Key not allowed: ${key}`);
    }

    const session = findSessionOrFail(ctx, id, req);
    const muxName = session.muxName;
    if (!muxName) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No tmux session');
    }

    try {
      // Route through the dedicated Codeman socket — bare `tmux` would target the
      // user's default server and never find this session (same #80 regression class).
      await new Promise<void>((resolve, reject) => {
        execFile(
          'tmux',
          ['-L', ctx.mux.muxSocket, 'send-keys', '-H', '-t', muxName, ...hex],
          { timeout: 5000 },
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } catch (err) {
      console.error('[Server] send-key failed:', err);
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'tmux send-keys failed');
    }
    return {};
  });

  // ========== Resize Terminal ==========

  app.post('/api/sessions/:id/resize', async (req) => {
    const { id } = req.params as { id: string };
    const { cols, rows, viewportType, force } = parseBody(ResizeSchema, req.body);
    const session = findSessionOrFail(ctx, id, req);

    session.resize(cols, rows, { viewportType, force });
    return {};
  });

  // ========== Get Last Response (from transcript JSONL) ==========

  // How far apart a ~/.claude/history.jsonl entry and a pane's Enter may be and
  // still be the same submission. Claude appends to history as it accepts the
  // prompt, so the true gap is milliseconds — this is slack for a loaded box,
  // not a search radius.
  const CLAUDE_SUBMIT_MATCH_MS = 10_000;
  // history.jsonl grows forever; only the tail can hold entries near a submit.
  const CLAUDE_HISTORY_TAIL_BYTES = 256 * 1024;

  // Resolves the Claude conversation id THIS pane is currently on by matching
  // ~/.claude/history.jsonl (which logs every submitted prompt as
  // {project, sessionId, timestamp}) against the pane's last Enter. After
  // `/clear` Claude keeps writing to a new <uuid>.jsonl, and history.jsonl is
  // the only source-of-truth update that does not rely on project-local hooks
  // (we intentionally don't install hooks in arbitrary user repos, see the
  // POST /api/sessions comment).
  //
  // The pane's own Enter is what makes an entry OURS. `project` alone is not:
  // a cwd is shared by every other Codeman tab on it, by tabs long since
  // closed, and by any plain `claude` the user runs in their own terminal —
  // adopting the newest entry for the cwd pinned the viewer to whichever of
  // those conversations was typed in last, so the eye showed a stranger's
  // transcript. With no correlated entry we keep the id we have; a viewer one
  // turn behind beats a viewer showing someone else's conversation.
  const claudeHistoryPinCache = new LRUMap<string, { submitAt: number; claudeSessionId: string }>({ maxSize: 1024 });
  async function resolveActiveClaudeSessionIdFromHistory(
    session: Session,
    projectsDir: string
  ): Promise<string | null> {
    const submitAt = session.lastSubmitAt;
    if (!submitAt) return null; // never typed through Codeman — nothing to credit
    const cached = claudeHistoryPinCache.get(session.id);
    if (cached && cached.submitAt === submitAt) return cached.claudeSessionId;

    // Ids another live pane is already pinned to can never be ours, and every
    // pane sharing this cwd competes for the entry we are about to claim —
    // including non-Claude panes, since a shell pane can run `claude` too.
    const otherClaudeIds = new Set<string>();
    const otherSubmits: number[] = [];
    for (const s of ctx.sessions.values()) {
      if (s.id === session.id || s.workingDir !== session.workingDir) continue;
      if (s.claudeSessionId) otherClaudeIds.add(s.claudeSessionId);
      if (s.lastSubmitAt) otherSubmits.push(s.lastSubmitAt);
    }

    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    const stat = await fs.stat(historyPath).catch(() => null);
    if (!stat || stat.size === 0) return null;
    const tail = await readFileTail(historyPath, Buffer.alloc(CLAUDE_HISTORY_TAIL_BYTES), stat.size);
    if (!tail) return null;

    let best: { sessionId: string; dist: number } | undefined;
    for (const line of tail.split('\n')) {
      if (!line) continue;
      let entry: { project?: string; sessionId?: string; timestamp?: number };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue; // the first tail line is usually cut mid-JSON
      }
      const { sessionId, timestamp } = entry;
      if (entry.project !== session.workingDir) continue;
      if (typeof sessionId !== 'string' || !sessionId) continue;
      if (typeof timestamp !== 'number') continue;
      if (otherClaudeIds.has(sessionId)) continue;
      const dist = Math.abs(timestamp - submitAt);
      if (dist > CLAUDE_SUBMIT_MATCH_MS) continue;
      if (otherSubmits.some((other) => Math.abs(timestamp - other) < dist)) continue; // another pane is closer
      if (!best || dist <= best.dist) best = { sessionId, dist }; // ties: the newer entry wins
    }
    if (!best) return null;

    // Sanity: the conversation we switch to must exist on disk and must not be
    // staler than the one we are leaving. A `/clear` successor never is.
    const currentSessionId = session.claudeSessionId || session.id;
    if (best.sessionId !== currentSessionId) {
      const projectDirs = await fs.readdir(projectsDir).catch(() => null);
      if (!projectDirs) return null;
      let candidateMtime = 0;
      let currentMtime = 0;
      for (const projDir of projectDirs) {
        const candidateStat = await fs.stat(join(projectsDir, projDir, `${best.sessionId}.jsonl`)).catch(() => null);
        if (candidateStat && candidateStat.mtimeMs > candidateMtime) candidateMtime = candidateStat.mtimeMs;
        const currentStat = await fs.stat(join(projectsDir, projDir, `${currentSessionId}.jsonl`)).catch(() => null);
        if (currentStat && currentStat.mtimeMs > currentMtime) currentMtime = currentStat.mtimeMs;
      }
      if (candidateMtime === 0) return null; // transcript not written yet — retry next poll
      if (currentMtime > 0 && candidateMtime < currentMtime) return null;
    }

    claudeHistoryPinCache.set(session.id, { submitAt, claudeSessionId: best.sessionId });
    return best.sessionId;
  }

  interface ClaudeResponseMessage {
    role: 'user' | 'assistant';
    text: string;
    timestamp?: string;
  }

  interface ClaudeTranscriptEntry {
    type?: string;
    timestamp?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    isCompactSummary?: boolean;
    message?: { content?: unknown };
  }

  function extractClaudeText(content: unknown, separator: string): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          !!block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'text' &&
          typeof (block as { text?: string }).text === 'string'
      )
      .map((block) => block.text)
      .join(separator);
  }

  function isClaudeSyntheticUserMessage(entry: ClaudeTranscriptEntry, text: string): boolean {
    if (entry.isMeta || entry.isCompactSummary) return true;
    return /^(?:<local-command|<command-name>|<task-notification>|<system-reminder>|<teammate-message\b|Another Claude session sent a message:|Base directory for this skill:)/i.test(
      text
    );
  }

  /**
   * Claude writes one logical turn as many JSONL rows: text, thinking and tool
   * blocks share message ids, while tool results are represented as user rows.
   * Build viewer cards from real user boundaries instead of treating every row
   * as a separate chat message.
   */
  function parseClaudeResponseTranscript(
    content: string,
    full: boolean
  ): { text: string; timestamp: string; messages?: ClaudeResponseMessage[] } {
    let lastText = '';
    let lastTimestamp = '';
    const messages: ClaudeResponseMessage[] = [];
    let currentUserFragments = new Set<string>();
    let currentAssistantFragments = new Set<string>();

    for (const line of content.split('\n')) {
      if (!line) continue;
      let entry: ClaudeTranscriptEntry;
      try {
        entry = JSON.parse(line) as ClaudeTranscriptEntry;
      } catch {
        continue;
      }
      // Sidechains belong to agents/forks, not the main conversation. Meta user
      // rows include repeated image dimensions and other UI-generated context.
      if (entry.isSidechain) continue;

      if (entry.type === 'user') {
        const text = extractClaudeText(entry.message?.content, '\n').trim();
        // A tool_result block has no text block and naturally drops out here.
        if (!text || isClaudeSyntheticUserMessage(entry, text)) continue;
        if (!full) continue;

        const previous = messages.at(-1);
        if (previous?.role === 'user') {
          // Claude can replay the initial user row while restoring a transcript.
          // Only collapse duplicates within the same unanswered user turn; the
          // same prompt after an assistant response remains a legitimate turn.
          if (currentUserFragments.has(text)) continue;
          previous.text += `\n\n${text}`;
          currentUserFragments.add(text);
        } else {
          messages.push({ role: 'user', text, timestamp: entry.timestamp });
          currentUserFragments = new Set([text]);
        }
        currentAssistantFragments.clear();
        continue;
      }

      if (entry.type !== 'assistant') continue;
      const text = extractClaudeText(entry.message?.content, '\n\n').trim();
      if (!text) continue;
      lastText = text;
      lastTimestamp = entry.timestamp || '';
      if (!full) continue;

      const previous = messages.at(-1);
      if (previous?.role === 'assistant') {
        // Replayed snapshots sometimes repeat an identical text block. Distinct
        // progress/final blocks are kept, but remain inside one Claude card.
        if (currentAssistantFragments.has(text)) continue;
        previous.text += `\n\n${text}`;
        previous.timestamp = entry.timestamp || previous.timestamp;
        currentAssistantFragments.add(text);
      } else {
        messages.push({ role: 'assistant', text, timestamp: entry.timestamp });
        currentAssistantFragments = new Set([text]);
      }
      currentUserFragments.clear();
    }

    return full ? { text: lastText, timestamp: lastTimestamp, messages } : { text: lastText, timestamp: lastTimestamp };
  }

  /** Locate a top-level Claude transcript, including recovered tmux sessions. */
  async function findClaudeTranscript(
    projectsDir: string,
    conversationId: string,
    codemanSessionId: string
  ): Promise<{ sessionId: string; path: string } | null> {
    let projectDirs: import('node:fs').Dirent[];
    try {
      projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const safeIds = [...new Set([conversationId, codemanSessionId])].filter((value) => /^[a-zA-Z0-9._-]+$/.test(value));
    for (const candidateId of safeIds) {
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;
        const jsonlPath = join(projectsDir, projectDir.name, `${candidateId}.jsonl`);
        try {
          const stat = await fs.stat(jsonlPath);
          if (stat.isFile()) return { sessionId: candidateId, path: jsonlPath };
        } catch {
          /* continue */
        }
      }
    }

    // If mux-sessions.json was lost or stale, reconcileSessions() historically
    // recovered `codeman-40568a29` as `restored-40568a29` and used the server cwd.
    // The tmux name still carries the first eight UUID characters, which safely
    // reconnects the viewer when exactly one matching top-level transcript exists.
    const restoredMatch = /^restored-([a-f0-9]{8,})$/i.exec(codemanSessionId);
    if (!restoredMatch) return null;
    const fragment = restoredMatch[1].toLowerCase();
    const candidates: Array<{ sessionId: string; path: string; mtimeMs: number }> = [];
    const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const dirPath = join(projectsDir, projectDir.name);
      let files: import('node:fs').Dirent[];
      try {
        files = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const candidateId = file.name.slice(0, -'.jsonl'.length);
        if (!candidateId.toLowerCase().startsWith(fragment) || !uuidPattern.test(candidateId)) continue;
        const path = join(dirPath, file.name);
        const stat = await fs.stat(path).catch(() => null);
        if (stat) candidates.push({ sessionId: candidateId, path, mtimeMs: stat.mtimeMs });
      }
    }

    const candidateIds = new Set(candidates.map((candidate) => candidate.sessionId));
    if (candidateIds.size !== 1) return null;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0] ?? null;
  }

  app.get('/api/sessions/:id/last-response', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    // Codex sessions don't write to ~/.claude/projects — their transcripts
    // live in ~/.codex/sessions/**. Branch to a Codex-specific reader so the
    // response-viewer works for Codex panes too.
    if (session.mode === 'codex') {
      const codexQuery = req.query as { context?: string };
      return await readCodexLastResponse(session, codexQuery.context === 'full');
    }

    // DeepSeek Harness writes a real structured transcript under
    // `$DSH_HOME/sessions/**`, so read that rather than segmenting the pane.
    // ⚠️ For dsh the pane fallback is not merely coarse, it is WRONG: dsh-TUI
    // paints a full-screen splash, and the segmenter served its ASCII-art logo
    // back as the worker's answer (measured), which an agent polling for a
    // reply reads as a reply. So an EMPTY transcript result still wins over the
    // pane — "nothing said yet" is the honest answer. Only `null`, meaning a
    // Node too old to decode zstd, falls through to the segmenter below.
    // ⚠️ Local sessions only: a docker case's harness writes its transcript
    // inside the CONTAINER's ~/.dsh (the workspace bind-mount does not cover
    // it) and a remote-SSH case's lives on the remote host, so the local
    // reader would scan a $DSH_HOME that can never hold this session's file
    // and return "nothing said yet" forever — an agent polling that worker
    // would starve on an answer that exists. Those configurations keep the
    // pane segmenter below: coarse, but the real conversation.
    if (session.mode === 'deepseek' && !session.docker && !session.remote) {
      const deepSeekQuery = req.query as { context?: string };
      const full = deepSeekQuery.context === 'full';
      const transcript = await readDeepSeekLastResponse(session, { blocks: full });
      if (transcript) {
        return {
          text: transcript.text,
          timestamp: transcript.timestamp,
          hasContext: transcript.text.length > 0 || transcript.blocks.length > 0,
          messages: full ? transcript.blocks : undefined,
        };
      }
    }

    // OpenCode / Gemini / Antigravity / Pi render their own TUIs and write no
    // Claude transcript, so the scan below finds nothing and the response viewer
    // renders permanently empty for them. Segment the terminal buffer instead —
    // the pane IS the transcript for these CLIs. Codex is already handled above,
    // where a real rollout file is the better source.
    if (isExternalCliTranscriptMode(session.mode)) {
      const externalQuery = req.query as { context?: string };
      const blocks = parseExternalCliTranscript(session.terminalBuffer, session.mode);
      return {
        text: getLastTranscriptResponse(blocks),
        timestamp: '',
        hasContext: blocks.length > 0,
        messages: externalQuery.context === 'full' ? blocks : undefined,
      };
    }

    // Scan ~/.claude/projects/*/ for the transcript file
    const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');

    // Adopt the current conversation id if the user ran `/clear` — Claude CLI's
    // interactive PTY emits no JSON on stdout, so without this lookup the
    // stored id stays pinned to the pre-/clear transcript.
    const activeId = await resolveActiveClaudeSessionIdFromHistory(session, projectsDir);
    if (activeId && activeId !== session.claudeSessionId) {
      session.adoptClaudeSessionId(activeId);
      // Flush the Enter that vouched for this adoption to state.json. A `/clear`
      // emits no completion event, so without this the anchor could still be
      // unpersisted when the server restarts — and recovery would fall back to
      // the launch conversation.
      ctx.persistSessionState(session);
      // Docker sessions: keep the case's resume seed following the live conversation.
      if (session.docker) {
        void persistDockerCaseClaudeSessionId(CODEMAN_CONFIG_DIR, session.docker.containerName, activeId).catch(
          () => {}
        );
      }
    }

    const query = req.query as { context?: string };
    const claudeSessionId = session.claudeSessionId || session.id;
    const transcript = await findClaudeTranscript(projectsDir, claudeSessionId, session.id);
    if (!transcript) {
      return query.context === 'full' ? { text: '', timestamp: '', messages: [] } : { text: '', timestamp: '' };
    }

    if (transcript.sessionId !== session.claudeSessionId && transcript.sessionId !== session.id) {
      session.adoptClaudeSessionId(transcript.sessionId);
      if (session.docker) {
        void persistDockerCaseClaudeSessionId(
          CODEMAN_CONFIG_DIR,
          session.docker.containerName,
          transcript.sessionId
        ).catch(() => {});
      }
    }

    try {
      const content = await fs.readFile(transcript.path, 'utf8');
      return parseClaudeResponseTranscript(content, query.context === 'full');
    } catch {
      return query.context === 'full' ? { text: '', timestamp: '', messages: [] } : { text: '', timestamp: '' };
    }
  });

  function isCodexInjectedContext(text: string): boolean {
    return (
      /^# AGENTS\.md instructions\b/i.test(text) ||
      /^<environment_context\b/i.test(text) ||
      /^<turn_aborted\b/i.test(text) ||
      /^<codex_internal_context\b/i.test(text) ||
      /^<recommended_plugins\b/i.test(text) ||
      /^<user_instructions\b/i.test(text) ||
      /^# Options\b/i.test(text)
    );
  }

  // ── Codex response-viewer support ───────────────────────────────────────────────────────
  // Read the rollout's session_meta identity fields (plus turn_context cwd as
  // a fallback when the huge session_meta line got truncated by the head read).
  function readCodexRolloutMeta(head: string): { cwd?: string; originator?: string } {
    let cwd: string | undefined;
    let originator: string | undefined;
    for (const line of head.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          payload?: { cwd?: string; originator?: string };
        };
        if (entry.type === 'session_meta') {
          cwd ??= entry.payload?.cwd;
          originator ??= entry.payload?.originator;
        } else if (entry.type === 'turn_context') {
          cwd ??= entry.payload?.cwd;
        }
      } catch {
        // Malformed or truncated head line — keep scanning.
      }
      if (cwd && originator) break;
    }
    return { cwd, originator };
  }

  // The pane's last Enter (Session.lastSubmitAt) correlated against
  // ~/.codex/history.jsonl, which logs every submitted user message as
  // {session_id, ts}. This identifies the thread the pane is ACTUALLY on and
  // is the only signal that survives /resume, /new and /fork typed inside the
  // codex TUI itself. An entry is credited to this pane only when its Enter is
  // the closest among all codex panes, so a menu keystroke in another pane
  // can't steal the attribution.
  const codexHistoryPinCache = new LRUMap<string, { submitAt: number; threadId: string }>({ maxSize: 1024 });
  async function resolveCodexThreadFromHistory(
    session: { id: string; lastSubmitAt?: number },
    codexHome: string
  ): Promise<string | null> {
    const submitAt = session.lastSubmitAt || 0;
    if (!submitAt) return null;
    const cached = codexHistoryPinCache.get(session.id);
    if (cached && cached.submitAt === submitAt) return cached.threadId;

    const histPath = join(codexHome, 'history.jsonl');
    const st = await fs.stat(histPath).catch(() => null);
    if (!st || st.size === 0) return null;
    const tail = await readFileTail(histPath, Buffer.alloc(65536), st.size);
    if (!tail) return null;

    const WINDOW_MS = 15_000;
    const otherSubmits: number[] = [];
    for (const s of ctx.sessions.values()) {
      if (s.id !== session.id && s.mode === 'codex' && s.lastSubmitAt) {
        otherSubmits.push(s.lastSubmitAt);
      }
    }

    let best: { threadId: string; dist: number } | undefined;
    for (const line of tail.split('\n')) {
      if (!line) continue;
      let e: { session_id?: string; ts?: number };
      try {
        e = JSON.parse(line);
      } catch {
        continue; // first tail line may be cut mid-JSON
      }
      if (!e.session_id || typeof e.ts !== 'number') continue;
      const tsMs = e.ts * 1000; // history timestamps are unix seconds
      const dist = Math.abs(tsMs - submitAt);
      if (dist > WINDOW_MS) continue;
      if (otherSubmits.some((o) => Math.abs(tsMs - o) < dist)) continue; // another pane is closer
      if (!best || dist < best.dist) best = { threadId: e.session_id, dist };
    }
    if (!best) return null;
    codexHistoryPinCache.set(session.id, { submitAt, threadId: best.threadId });
    return best.threadId;
  }

  // Locate THIS pane's rollout, in order of confidence:
  //   0. history match — the thread the pane last submitted a message to
  //      (see resolveCodexThreadFromHistory); tracks the pane through
  //      /resume //new //fork typed inside the TUI.
  //   1. originator match — Codeman spawns codex panes with
  //      CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codeman_<sessionId>, which codex
  //      writes into session_meta.originator of every rollout it creates
  //      (including new files after /new in the same pane; newest match wins).
  //   2. resume-id match — resumed rollouts keep their ORIGINAL session_meta
  //      (codex appends without rewriting it), so originator matching can't
  //      see them; but the rollout uuid is in the filename and we know the id.
  //   3. legacy cwd+mtime heuristic — panes started before this feature, or
  //      TUI-resumed threads before their first tracked submit. Case-blind
  //      cwd compare (codex records the launch-time case, /mnt paths vary)
  //      and rollouts claimed by OTHER codeman panes are excluded.
  async function findActiveCodexFile(session: {
    id: string;
    workingDir: string;
    lastSubmitAt?: number;
    codexConfig?: { resumeSessionId?: string };
  }): Promise<string | null> {
    const codexHome = process.env.CODEX_HOME || join(process.env.HOME || '/tmp', '.codex');
    const sessionsDir = join(codexHome, 'sessions');

    const files: Array<{ path: string; mtimeMs: number }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const st = await fs.stat(fullPath).catch(() => null);
        if (!st || st.size < 100) continue;
        files.push({ path: fullPath, mtimeMs: st.mtimeMs });
      }
    };
    await walk(sessionsDir);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const historyThreadId = await resolveCodexThreadFromHistory(session, codexHome);
    if (historyThreadId) {
      const hit = files.find((f) => basename(f.path).endsWith(`-${historyThreadId}.jsonl`));
      if (hit) return hit.path;
    }

    const rawResumeId = session.codexConfig?.resumeSessionId;
    const resumeId =
      rawResumeId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(rawResumeId)
        ? rawResumeId
        : undefined;
    const idMatch = resumeId ? files.find((f) => basename(f.path).endsWith(`-${resumeId}.jsonl`)) : undefined;

    // Scan newest-first for our originator; anything strictly older than the
    // id match can never beat it, so the head reads stop there (mtime ties are
    // still scanned — a /new rollout may land in the same clock tick). The
    // 128 KiB head budget covers the session_meta line, which embeds full
    // base_instructions (observed max ~22 KiB on codex 0.144).
    const originator = `codeman_${session.id}`;
    const wantCwd = session.workingDir.toLowerCase();
    const headBuf = Buffer.alloc(131072);
    let cwdFallback: { path: string; mtimeMs: number } | undefined;
    for (const f of files) {
      if (idMatch && f.mtimeMs < idMatch.mtimeMs) break;
      const meta = await readCodexRolloutMetaCached(f.path, headBuf);
      if (!meta) continue;
      if (meta.originator === originator) return f.path; // newest-first → first hit wins
      if (
        !cwdFallback &&
        !idMatch &&
        meta.cwd?.toLowerCase() === wantCwd &&
        // A rollout stamped by another codeman pane belongs to that pane.
        !(meta.originator?.startsWith('codeman_') && meta.originator !== originator)
      ) {
        cwdFallback = f;
      }
    }

    return idMatch?.path ?? cwdFallback?.path ?? null;
  }

  // session_meta is written once when codex creates the rollout and never
  // rewritten (verified: resume appends without touching it), so the parsed
  // identity of a given path can be cached forever. This turns the per-request
  // scan into stat calls plus head reads for new files only.
  const codexRolloutMetaCache = new LRUMap<string, { cwd?: string; originator?: string }>({ maxSize: 4096 });
  async function readCodexRolloutMetaCached(
    filePath: string,
    headBuf: Buffer
  ): Promise<{ cwd?: string; originator?: string } | null> {
    const cached = codexRolloutMetaCache.get(filePath);
    if (cached) return cached;
    const head = await readFileHead(filePath, headBuf);
    if (!head) return null;
    const meta = readCodexRolloutMeta(head);
    // Don't cache a still-incomplete head: a rollout being created may not
    // have flushed session_meta/turn_context yet.
    if (!meta.cwd && !meta.originator) return meta;
    codexRolloutMetaCache.set(filePath, meta);
    return meta;
  }

  function extractCodexBlockText(content: unknown, kinds: string[]): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b &&
          typeof b === 'object' &&
          kinds.includes((b as { type?: string }).type || '') &&
          typeof (b as { text?: string }).text === 'string'
      )
      .map((b) => b.text)
      .join('\n\n');
  }

  // Single pass over a Codex rollout: track the last assistant message (for the
  // default eye view) and, when `full`, the whole user/assistant thread.
  //
  // User turns come from event_msg/user_message when available: codex emits one
  // per REAL user input, and injected context (AGENTS.md, environment_context,
  // compaction summaries, …) never appears there — so no filtering heuristics.
  // response_item user rows duplicate those inputs mixed with the injections;
  // they are kept only as a fallback for old rollouts without event_msg rows.
  async function readCodexLastResponse(
    session: { id: string; workingDir: string; codexConfig?: { resumeSessionId?: string } },
    full: boolean
  ): Promise<{
    text: string;
    timestamp: string;
    messages?: Array<{ role: string; text: string; timestamp?: string }>;
  }> {
    const empty = full ? { text: '', timestamp: '', messages: [] } : { text: '', timestamp: '' };
    const filePath = await findActiveCodexFile(session);
    if (!filePath) return empty;

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return empty;
    }

    let lastText = '';
    let lastTimestamp = '';
    const messages: Array<{ role: string; text: string; timestamp?: string; legacyUser?: boolean }> = [];
    // Multiset of event-sourced user texts: a real input appears BOTH as an
    // event_msg and as a response_item row, so each event text cancels exactly
    // one legacy twin. Legacy rows without an event twin (turns written by an
    // older codex appending to the same rollout) survive — a file-wide boolean
    // would wrongly drop them.
    const eventUserTexts = new Map<string, number>();

    for (const line of content.split('\n')) {
      if (!line) continue;
      let entry: {
        timestamp?: string;
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          content?: unknown;
          message?: unknown;
          images?: unknown;
          local_images?: unknown;
        };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (full && entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        let text = typeof entry.payload.message === 'string' ? entry.payload.message.trim() : '';
        if (text && isCodexInjectedContext(text)) continue;
        if (text) eventUserTexts.set(text, (eventUserTexts.get(text) || 0) + 1);
        // Image-only (or image+text) inputs: the text field alone would make
        // the turn vanish, so surface a placeholder.
        const imageCount =
          (Array.isArray(entry.payload.images) ? entry.payload.images.length : 0) +
          (Array.isArray(entry.payload.local_images) ? entry.payload.local_images.length : 0);
        if (imageCount > 0) text = text ? `${text}\n\n*[image ×${imageCount}]*` : `*[image ×${imageCount}]*`;
        if (text) messages.push({ role: 'user', text, timestamp: entry.timestamp });
        continue;
      }
      if (entry.type !== 'response_item' || entry.payload?.type !== 'message') continue;
      const role = entry.payload?.role;
      if (role === 'assistant') {
        const text = extractCodexBlockText(entry.payload?.content, ['output_text', 'text']);
        if (text) {
          lastText = text;
          lastTimestamp = entry.timestamp || '';
          if (full) messages.push({ role: 'assistant', text, timestamp: entry.timestamp });
        }
      } else if (role === 'user' && full) {
        const text = extractCodexBlockText(entry.payload?.content, ['input_text', 'text']).trim();
        // Drop Codex's injected context turns (AGENTS.md, environment_context, …)
        // so the thread shows real user prompts only.
        if (text && !isCodexInjectedContext(text)) {
          messages.push({ role: 'user', text, timestamp: entry.timestamp, legacyUser: true });
        }
      }
    }

    const thread = messages
      .filter((m) => {
        if (!m.legacyUser) return true;
        const n = eventUserTexts.get(m.text) || 0;
        if (n > 0) {
          eventUserTexts.set(m.text, n - 1);
          return false; // duplicate of an event_msg row already in the thread
        }
        return true;
      })
      .map(({ role, text, timestamp }) => ({ role, text, timestamp }));

    return full
      ? { text: lastText, timestamp: lastTimestamp, messages: thread }
      : { text: lastText, timestamp: lastTimestamp };
  }

  // ========== Get Terminal Buffer ==========

  // Query params:
  //   tail=<bytes> - Only return last N bytes (faster initial load)
  //   full=1       - Explicitly request the entire tmux scrollback (COD-47)
  app.get('/api/sessions/:id/terminal', async (req, reply) => {
    const routeStartedAt = performance.now();
    const { id } = req.params as { id: string };
    const query = req.query as { tail?: string; full?: string };
    const session = findSessionOrFail(ctx, id, req);

    // `full=1` is the EXPLICIT full-history signal (COD-47): capture the ENTIRE
    // tmux scrollback so history beyond the server byte buffer can be recovered.
    // Requests WITHOUT it — shell selection/tab switches (`tail=`) and legacy
    // no-param callers — keep the fast visible-frame capture.
    const tailBytes = query.tail ? parseInt(query.tail, 10) : 0;
    const isFullReload = query.full === '1' || query.full === 'true';
    const { tmuxHistoryLimit, terminalBufferMaxBytes } = await ctx.getTerminalHistoryConfig();

    // Prepend the live tmux pane buffer so tab-switch replay shows the current
    // on-screen frame, not just the accumulated byte history. This matters for
    // TUI modes (codex/opencode) that repaint only their latest frame: the
    // accumulated buffer alone replays as the idle banner. We clear the viewport
    // (`\x1b[H\x1b[2J`) between the history and the live pane so they don't
    // overlap. `captureActivePaneBuffer` is a no-op ('') under test mode and
    // returns null when unavailable, in which case we fall back to history.
    const muxName = session.muxName;
    const captureStartedAt = performance.now();
    const liveMuxBuffer =
      muxName && typeof ctx.mux.captureActivePaneBuffer === 'function'
        ? ctx.mux.captureActivePaneBuffer(
            muxName,
            isFullReload
              ? { fullHistory: true, historyLimitLines: tmuxHistoryLimit, maxCaptureBytes: terminalBufferMaxBytes }
              : undefined
          )
        : null;
    const captureFinishedAt = performance.now();
    const hasLiveMuxBuffer = liveMuxBuffer !== null && liveMuxBuffer.length > 0;
    const source: 'history' | 'mux-visible' | 'mux-full-history' = hasLiveMuxBuffer
      ? isFullReload
        ? 'mux-full-history'
        : 'mux-visible'
      : 'history';
    let rawBuffer: string;
    if (liveMuxBuffer !== null && liveMuxBuffer.length > 0) {
      // Full-history capture is the RENDERED form of everything already in the
      // byte buffer (up to tmux eviction) — return it alone. Prepending the byte
      // history would replay the whole conversation twice: `\x1b[2J` clears only
      // the viewport, not xterm scrollback. The history+clear+frame concat stays
      // for the visible-frame path, where the single pane frame lacks history.
      rawBuffer = isFullReload
        ? liveMuxBuffer
        : session.terminalBufferLength > 0
          ? `${session.terminalBuffer}\x1b[H\x1b[2J${liveMuxBuffer}`
          : liveMuxBuffer;
    } else {
      rawBuffer = session.terminalBuffer;
    }
    const fullSize = rawBuffer.length;
    let truncated = false;
    // WHY the reason and not just the boolean (#258): `truncated` is set at two
    // sites that mean opposite things to a user. 'tail' is an intentional
    // partial replay and the rest is still retained, so a `full=1` pull recovers
    // it. 'capped' means we hit the byte ceiling — and on a full-history capture
    // that is already everything tmux holds, so the oldest output is genuinely
    // out of reach rather than one click away. Collapsing both into one flag is
    // why the UI could only ever say "truncated for performance".
    let truncationReason: 'capped' | 'tail' | null = null;
    let cleanBuffer: string;

    // Cap the payload EARLY — before the regex normalization passes below run
    // over it. A full-history tmux capture can be tens of MB of scrollback;
    // normalizing all of it would stall the event loop only to discard most
    // bytes anyway. Keep the most RECENT bytes (slice from the end) and align
    // to a line boundary so we never start mid-ANSI-escape.
    if (terminalBufferMaxBytes > 0 && rawBuffer.length > terminalBufferMaxBytes) {
      rawBuffer = rawBuffer.slice(-terminalBufferMaxBytes);
      truncated = true;
      truncationReason = 'capped';
      const capNewline = rawBuffer.indexOf('\n');
      if (capNewline > 0 && capNewline < 4096) {
        rawBuffer = rawBuffer.slice(capNewline + 1);
      }
    }

    // Strip redundant Ink spinner/status redraws BEFORE tailing.
    // During long thinking phases, Ink rewrites the same rows thousands of times
    // (500KB+). Without stripping, tail mode returns only spinner frames and
    // the terminal appears empty when switching tabs.
    let strippedBuffer = session.mode === 'shell' ? rawBuffer : stripInkRedrawBloat(rawBuffer);

    // Strip alt-screen toggles and scrollback-erase from Codex/Claude byte
    // streams. xterm.js obeys them by switching to its scrollback-less alt
    // buffer and wiping saved lines, so conversation history disappears on tab
    // switch. Same gate as the live-stream strip in session.ts.
    if (isAltScreenStripMode(session.mode)) {
      strippedBuffer = strippedBuffer
        .replace(ALT_SCREEN_TOGGLE_PATTERN, '')
        .replace(ERASE_SCROLLBACK_PATTERN, '')
        .replace(MOUSE_TRACKING_PATTERN, '');
    } else if (isMuxAltScreenOnlyStripMode(session.mode, session.usesMux)) {
      // tmux-backed shell/opencode/antigravity: drop tmux's own client smcup only.
      // A byte buffer recorded before the live-side strip existed can still carry
      // it, and one replayed `\x1b[?1049h` re-parks xterm in the alt buffer (#205).
      strippedBuffer = strippedBuffer.replace(ALT_SCREEN_TOGGLE_PATTERN, '');
    }

    if (tailBytes > 0 && strippedBuffer.length > tailBytes) {
      // Fast path: tail from the end, skip expensive banner search on full 2MB buffer.
      // Banner is near the top and gets discarded by tail anyway.
      cleanBuffer = strippedBuffer.slice(-tailBytes);
      truncated = true;
      // 'capped' already means the oldest bytes are gone for good; a tail cut on
      // top of it does not soften that, so the stronger reason wins.
      truncationReason ??= 'tail';
      // Avoid starting mid-ANSI-escape: find first newline within the first 4KB
      // and start from there. This prevents xterm.js from parsing a partial escape
      // sequence which corrupts cursor position for all subsequent Ink redraws.
      const firstNewline = cleanBuffer.indexOf('\n');
      if (firstNewline > 0 && firstNewline < 4096) {
        cleanBuffer = cleanBuffer.slice(firstNewline + 1);
      }
    } else {
      // Full buffer: clean junk before actual Claude content
      cleanBuffer = strippedBuffer;

      // Find where Claude banner starts (has color codes before "Claude")
      const claudeMatch = cleanBuffer.match(CLAUDE_BANNER_PATTERN);
      if (claudeMatch && claudeMatch.index !== undefined && claudeMatch.index > 0) {
        let lineStart = claudeMatch.index;
        while (lineStart > 0 && cleanBuffer[lineStart - 1] !== '\n') {
          lineStart--;
        }
        cleanBuffer = cleanBuffer.slice(lineStart);
      }
    }

    // Remove Ctrl+L and leading whitespace (cheap on tailed subset)
    cleanBuffer = cleanBuffer.replace(CTRL_L_PATTERN, '').replace(LEADING_WHITESPACE_PATTERN, '');

    const finishedAt = performance.now();
    reply.header(
      'Server-Timing',
      `capture;dur=${(captureFinishedAt - captureStartedAt).toFixed(1)}, ` +
        `prepare;dur=${(finishedAt - captureFinishedAt).toFixed(1)}, ` +
        `total;dur=${(finishedAt - routeStartedAt).toFixed(1)}`
    );

    return {
      terminalBuffer: cleanBuffer,
      status: session.status,
      fullSize,
      truncated,
      truncationReason,
      // `retainedBytes` is what this response actually carries; `fullSize` is
      // what existed before the cut. The gap is what the indicator reports.
      retainedBytes: cleanBuffer.length,
      source,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Settings (auto-clear, auto-compact, image watcher, flicker filter)
  // ═══════════════════════════════════════════════════════════════

  // ========== Auto-Clear ==========

  app.post('/api/sessions/:id/auto-clear', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AutoClearSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    session.setAutoClear(body.enabled, body.threshold);
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        autoClear: {
          enabled: session.autoClearEnabled,
          threshold: session.autoClearThreshold,
        },
      },
    };
  });

  // ========== Auto-Compact ==========

  app.post('/api/sessions/:id/auto-compact', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AutoCompactSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    session.setAutoCompact(body.enabled, body.threshold, body.prompt);
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        autoCompact: {
          enabled: session.autoCompactEnabled,
          threshold: session.autoCompactThreshold,
          prompt: session.autoCompactPrompt,
        },
      },
    };
  });

  // ========== Auto-Resume (usage-limit pause) ==========

  app.post('/api/sessions/:id/auto-resume', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AutoResumeSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    session.setAutoResume(body.enabled);
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        autoResume: {
          enabled: session.autoResumeEnabled,
          resumeAt: session.autoResumeAt ?? undefined,
        },
      },
    };
  });

  // ========== Pin (float to top of the session manager list, COD-139) ==========

  app.post('/api/sessions/:id/pin', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(PinSessionSchema, req.body, 'Invalid request body');

    const session = ctx.sessions.get(id);
    if (session) {
      if (!canAccessOwned(getAuthUser(req), session.owner)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`);
      }
      session.setPinned(body.pinned);
      // Persist + broadcast session:updated (keeps tabs/state consistent), then a
      // dedicated session:pinned event so the session manager list re-sorts live.
      persistAndBroadcastSession(ctx, session);
      ctx.broadcast(SseEvent.SessionPinned, {
        id,
        pinned: session.pinned,
        pinnedAt: session.pinnedAt ?? undefined,
      });

      return {
        success: true,
        data: {
          pinned: session.pinned,
          pinnedAt: session.pinnedAt ?? undefined,
        },
      };
    }

    // COD-142 keeps a pinned session's record after kill (demoteOrRemoveSession),
    // so pin toggles must also work WITHOUT a live Session — otherwise a
    // pinned-then-killed record could never be unpinned (cleanup skips pinned
    // records, and the record has no live session to route through).
    const persisted = ctx.store.getSession(id);
    if (!persisted || !canAccessOwned(getAuthUser(req), persisted.owner)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`);
    }
    const pinnedAt = body.pinned ? Date.now() : undefined;
    ctx.store.setSession(id, { ...persisted, pinned: body.pinned || undefined, pinnedAt });
    ctx.broadcast(SseEvent.SessionPinned, { id, pinned: body.pinned, pinnedAt });
    return { success: true, data: { pinned: body.pinned, pinnedAt } };
  });

  // ========== Image Watcher ==========

  app.post('/api/sessions/:id/image-watcher', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ImageWatcherSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    if (body.enabled) {
      imageWatcher.watchSession(session.id, session.workingDir);
    } else {
      imageWatcher.unwatchSession(session.id);
    }

    // Store state on session for persistence
    session.imageWatcherEnabled = body.enabled;
    ctx.persistSessionState(session);

    return {
      success: true,
      data: {
        imageWatcherEnabled: body.enabled,
      },
    };
  });

  // ========== Flicker Filter ==========

  app.post('/api/sessions/:id/flicker-filter', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(FlickerFilterSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    session.flickerFilterEnabled = body.enabled;
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        flickerFilterEnabled: body.enabled,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Quick Actions (quick-run, quick-start)
  // ═══════════════════════════════════════════════════════════════

  // ========== Quick Run ==========

  app.post('/api/run', async (req) => {
    const runOwner = ownerFor(req);
    const capMsg = sessionCapacityMessage(ctx.sessions, runOwner);
    if (capMsg) return createErrorResponse(ApiErrorCode.SESSION_BUSY, capMsg);

    const {
      prompt,
      workingDir,
      envOverrides: runEnvOverrides,
    } = parseBody(QuickRunSchema, req.body, 'Invalid request body');

    if (!prompt.trim()) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'prompt is required');
    }
    const dir = workingDir || process.cwd();

    // Multi-user: confine a non-admin's one-shot working dir to their space.
    if (!isWorkingDirAllowed(getAuthUser(req), dir)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'workingDir is outside your workspace');
    }

    // Validate workingDir exists and is a directory
    if (workingDir) {
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
      }
    }

    // Section 6.3: the one-shot spawn path (runPrompt/buildPromptArgs) respects the
    // session's claudeMode, so resolve it for the owner (bypass -> auto for non-granted).
    const runClaudeModeConfig = await ctx.getClaudeModeConfig();
    const runClaudeMode = await resolveClaudeModeForUsername(runClaudeModeConfig.claudeMode, runOwner);
    const session = new Session({
      workingDir: dir,
      envOverrides: runEnvOverrides,
      claudeMode: runClaudeMode,
      allowedTools: runClaudeModeConfig.allowedTools,
      owner: runOwner,
    });
    await ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    getLifecycleLog().log({
      event: 'created',
      sessionId: session.id,
      name: session.name,
      reason: 'run_prompt',
    });

    ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));

    try {
      const result = await session.runPrompt(prompt);
      // Clean up session after completion to prevent memory leak
      await ctx.cleanupSession(session.id, true, 'run_prompt_complete');
      return { sessionId: session.id, ...result };
    } catch (err) {
      // Clean up session on error too. The session is destroyed here, so its id
      // is only useful for log correlation — carry it in the error message.
      await ctx.cleanupSession(session.id, true, 'run_prompt_error');
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `${getErrorMessage(err)} (session ${session.id})`);
    }
  });

  // ========== Quick Start ==========

  app.post('/api/quick-start', async (req) => {
    const owner = ownerFor(req);
    const capMsg = sessionCapacityMessage(ctx.sessions, owner);
    if (capMsg) return createErrorResponse(ApiErrorCode.SESSION_BUSY, capMsg);

    const {
      caseName = 'testcase',
      sessionName,
      mode = 'claude',
      modelOverride,
      openCodeConfig,
      codexConfig,
      geminiConfig,
      antigravityConfig,
      piConfig,
      grokConfig,
      deepSeekConfig,
      ompConfig,
      envOverrides,
      effort,
      parentSessionId,
    } = parseBody(QuickStartSchema, req.body);

    // Multi-user: shell mode is arbitrary host-account execution, gated by the grant.
    // Resolve the owner's grant from the store so a GRANTED regular user is not wrongly denied.
    if (mode === 'shell' && !(await canUsernameRunPrivilegedCommands(owner))) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Shell sessions require the can-bypass-permissions grant');
    }

    // Resolve the remote case FIRST — the CLI executes on the REMOTE host over ssh,
    // so the LOCAL availability gates below (isCodexAvailable() etc.) don't apply and
    // would wrongly reject a machine that hasn't got the CLI installed locally.
    let remote = undefined;
    let docker = undefined;
    let dockerResumeId: string | undefined;
    let casePath: string | null = null;
    // Security: fold ownership INTO the match (don't early-return) so a NON-OWNED
    // same-named remote/docker case is skipped and control falls through to the caller's
    // own LOCAL case — remote/docker names are globally unique but local names are
    // per-user, so a name collision must not shadow the caller's own case. canAccessOwned
    // is allow-all for admins/single-user, so flag-OFF stays byte-identical.
    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    const remoteCase = remoteCases.find(
      (item) => item.name === caseName && canAccessOwned(getAuthUser(req), item.owner)
    );
    const dockerCase = remoteCase
      ? undefined
      : (await readDockerCases(CODEMAN_CONFIG_DIR)).find(
          (item) => item.name === caseName && canAccessOwned(getAuthUser(req), item.owner)
        );
    if (remoteCase) {
      const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === remoteCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');

      // Per-session config that is applied to the LOCAL tmux/CLI wrapper (env vars via
      // tmux setenv, effort/model CLI args, codex/gemini/antigravity/opencode config) does NOT
      // cross ssh, so it would silently no-op. Reject rather than pretend it worked —
      // remote command/env customization goes through the per-host command override.
      if (
        (envOverrides && Object.keys(envOverrides).length > 0) ||
        effort ||
        modelOverride !== undefined ||
        codexConfig ||
        geminiConfig ||
        antigravityConfig ||
        piConfig ||
        grokConfig ||
        deepSeekConfig ||
        ompConfig ||
        openCodeConfig
      ) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          'envOverrides, effort, modelOverride, and per-CLI config are not supported for remote cases (they do not cross ssh). Configure the remote command via the host command override instead.'
        );
      }

      // tmux is a hard prerequisite on the remote host (the agent runs inside a remote
      // tmux server so it survives ssh drops). Probe before spawning so a missing tmux
      // surfaces a clear, structured error instead of a dead "tmux: command not found" pane.
      const tmuxCheck = await checkRemoteTmuxAvailable(host);
      if (!tmuxCheck.ok) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, tmuxCheck.error || 'remote host is missing tmux');
      }

      casePath = remoteCase.remotePath;
      remote = toSessionRemote(host, remoteCase);
    } else if (dockerCase) {
      // Docker case: the CLI executes INSIDE a container via local tmux + `docker
      // exec`, so the LOCAL availability gates below don't apply. Mirror the remote
      // branch's rejection of per-session config that would not cross into the
      // container (it would silently no-op). (Ownership is enforced in the .find above.)
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
      if (
        (envOverrides && Object.keys(envOverrides).length > 0) ||
        effort ||
        codexConfig ||
        geminiConfig ||
        antigravityConfig ||
        piConfig ||
        grokConfig ||
        deepSeekConfig ||
        ompConfig ||
        openCodeConfig
      ) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          'envOverrides, effort, and per-CLI config are not supported for docker cases (they do not cross into the container). Configure the container via the docker host command override instead.'
        );
      }

      const availability = await checkDockerAvailable(host.engine);
      if (!availability.ok) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          availability.error || 'docker daemon is not available'
        );
      }
      const sessionDocker = toSessionDocker(host, dockerCase);
      // Ensure the base image exists, auto-building the default image on first use so
      // it is never a blocker. Dedup'd with any build kicked off at case-create, so
      // this awaits the SAME in-flight build rather than starting a second one.
      const ensured = await ensureAgentBaseImage(sessionDocker, sessionDocker.image, {
        onProgress: (line) => ctx.broadcast(SseEvent.DockerImageBuildProgress, { name: dockerCase.name, line }),
      });
      if (!ensured.ok) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, ensured.error || 'base image not available');
      }
      if (ensured.built) {
        ctx.broadcast(SseEvent.DockerImageBuildComplete, { name: dockerCase.name, image: sessionDocker.image });
      }
      // tmux is a hard prerequisite (the in-container tmux makes reconnect durable).
      // Skip the extra container-run probe for our OWN default image (the baked
      // Dockerfile always contains tmux); still verify a custom image.
      if (sessionDocker.image !== DEFAULT_AGENT_IMAGE) {
        const tmuxCheck = await checkDockerTmuxAvailable(sessionDocker);
        if (!tmuxCheck.ok) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, tmuxCheck.error || 'base image is missing tmux');
        }
      }

      // Config drift (docs/docker-cases-plan.md §4): the desired create-config no
      // longer matches the existing container's codeman.confighash label. Refuse to
      // silently launch into the stale container — the frontend confirms a recreate
      // (POST /api/docker-cases/:name/recreate; workspace + transcripts ride bind
      // mounts and the conversation resumes), or the user reverts the host edit.
      const drift = await checkDockerConfigDrift(sessionDocker);
      if (drift.exists && drift.drifted) {
        return createErrorResponse(
          ApiErrorCode.CONFLICT,
          `Container config for case "${dockerCase.name}" changed since the container was created. Recreate the container to apply it (workspace and conversation survive), or revert the docker host edit.`
        );
      }

      casePath = dockerCase.hostWorkspacePath; // a REAL host dir (bind-mounted into the container)
      docker = sessionDocker;
      // Seed resume so a relaunch resumes the case's last conversation from the
      // bind-mounted transcript (decision: resume-on-start default ON).
      if (sessionDocker.resumeOnStart && dockerCase.lastClaudeSessionId) {
        dockerResumeId = dockerCase.lastClaudeSessionId;
      }
    } else {
      // Check OpenCode availability if requested. Error text comes from the
      // resolver so it carries the resolution diagnostics; same for the modes below.
      if (mode === 'opencode') {
        const { isOpenCodeAvailable, getOpenCodeNotFoundMessage } =
          await import('../../utils/opencode-cli-resolver.js');
        if (!isOpenCodeAvailable()) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getOpenCodeNotFoundMessage());
        }
      }

      // Check Codex availability if requested
      if (mode === 'codex') {
        const { isCodexAvailable, getCodexNotFoundMessage } = await import('../../utils/codex-cli-resolver.js');
        if (!isCodexAvailable()) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getCodexNotFoundMessage());
        }
      }

      // Check Gemini availability if requested
      if (mode === 'gemini') {
        const { isGeminiAvailable, getGeminiNotFoundMessage } = await import('../../utils/gemini-cli-resolver.js');
        if (!isGeminiAvailable()) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getGeminiNotFoundMessage());
        }
      }

      // Check Antigravity availability if requested
      if (mode === 'antigravity') {
        const { isAntigravityAvailable, getAntigravityNotFoundMessage } =
          await import('../../utils/antigravity-cli-resolver.js');
        if (!isAntigravityAvailable()) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getAntigravityNotFoundMessage());
        }
      }

      // Check Pi availability if requested
      if (mode === 'pi') {
        const { isPiAvailable, getPiNotFoundMessage } = await import('../../utils/pi-cli-resolver.js');
        if (!isPiAvailable()) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getPiNotFoundMessage());
        }
      }
      // Check OMP availability if requested
      if (mode === 'omp') {
        const { isOmpAvailable } = await import('../../utils/omp-cli-resolver.js');
        if (!isOmpAvailable()) {
          return createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            'OMP CLI not found. Install with: curl -fsSL https://omp.sh/install | sh'
          );
        }
      }

      // Check Grok availability if requested
      if (mode === 'grok') {
        const { isGrokAvailable, getGrokNotFoundMessage } = await import('../../utils/grok-cli-resolver.js');
        if (!isGrokAvailable()) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getGrokNotFoundMessage());
        }
      }

      // Check DeepSeek Harness availability if requested (binary AND a pane-capable profile).
      if (mode === 'deepseek') {
        const err = await resolveDeepSeekLaunchError(deepSeekConfig?.profile);
        if (err) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, err);
      }

      // Resolve case path: check linked-cases registry first, then fall back to CASES_DIR.
      // This mirrors the behaviour of resolveCasePath() in case-routes so that linked
      // external project directories are honoured by quick-start just like regular case routes.
      let linkedCases: Record<string, string> = {};
      try {
        const raw = await fs.readFile(LINKED_CASES_FILE, 'utf-8');
        linkedCases = JSON.parse(raw);
      } catch {
        // File missing or unparseable — treat as empty registry
      }
      // Multi-user: the linked-cases registry is ownerless/global, so only admins may
      // resolve a name to an arbitrary linked path. A non-admin resolves inside their
      // OWN case space only (single-user: isAdmin true, so linked cases still honoured).
      const linked = isAdmin(req) ? linkedCases[caseName] : undefined;
      casePath = linked || validatePathWithinBase(caseName, resolveCasesDir(getAuthUser(req)));
      if (!casePath) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
      }
    }

    // By this point casePath is guaranteed non-null: for remote cases it was set from remoteCase.remotePath,
    // for local cases the !casePath guard above returned early. TypeScript can't narrow across the if/else.
    const resolvedCasePath = casePath as string;

    // Multi-user linchpin (section 6.2): confine the resolved workingDir to the caller's
    // own case space BEFORE any mkdir/scaffold below creates or mutates it. Applies to
    // LOCAL and DOCKER cases (docker.hostWorkspacePath is a real host dir the file routes
    // trust); skipped for REMOTE, whose path is an ssh path that would spuriously fail
    // realpath confinement. No-op for admins / single-user mode.
    if (!remote && !isWorkingDirAllowed(getAuthUser(req), resolvedCasePath)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'case path is outside your workspace');
    }

    // Create case folder and CLAUDE.md if it doesn't exist (only for non-linked, non-remote,
    // non-docker cases — docker workspaces are scaffolded in their own block below)
    if (!remote && !docker && !existsSync(resolvedCasePath)) {
      try {
        mkdirSync(resolvedCasePath, { recursive: true });
        mkdirSync(join(resolvedCasePath, 'src'), { recursive: true });

        // Read settings to get custom template path
        const templatePath = await ctx.getDefaultClaudeMdPath();
        const claudeMd = generateClaudeMd(caseName, '', templatePath);
        writeFileSync(join(resolvedCasePath, 'CLAUDE.md'), claudeMd);

        // Write .claude/settings.local.json with hooks for desktop notifications
        // (Claude-specific — OpenCode, Codex, Gemini, Antigravity, Pi, Grok, DeepSeek and OMP use their own systems)
        if (
          mode !== 'opencode' &&
          mode !== 'codex' &&
          mode !== 'gemini' &&
          mode !== 'antigravity' &&
          mode !== 'pi' &&
          mode !== 'grok' &&
          mode !== 'omp'
        ) {
          await writeHooksConfig(resolvedCasePath);
        }

        ctx.broadcast(SseEvent.CaseCreated, { name: caseName, path: resolvedCasePath });
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create case: ${getErrorMessage(err)}`);
      }
    } else if (!remote && !docker && mode !== 'opencode') {
      // EXISTING case directory (a linked case, a cloned repo, anything Codeman did
      // not scaffold): install-or-refresh per the setting (see applyWorkspaceHooks).
      // Other modes keep the narrower COD-91 self-heal unconditionally: only claude
      // reads `.claude` hooks, so a shell/codex quick-start should not author a block
      // of its own. Skipped for remote cases — resolvedCasePath is a REMOTE path that
      // doesn't exist on the local filesystem.
      if (mode === 'claude') {
        await applyWorkspaceHooks(resolvedCasePath, await ctx.getWorkspaceHooksEnabled());
      } else {
        await refreshStaleCodemanHooks(resolvedCasePath).catch(() => {});
      }
    }

    // Agent skill injection (docs/agent-control-plan.md §2): ADD-ONLY on create,
    // marker-guarded (a user's own skills/codeman is never touched). Claude mode only
    // (`.claude/skills/` is a Claude Code surface); skipped for remote cases, whose
    // casePath lives on another host. Docker cases qualify: hostWorkspacePath is a
    // real host dir and the skill crosses the bind mount like the rest of `.claude/`.
    if (!remote && mode === 'claude' && (await ctx.getAgentSkillEnabled())) {
      await injectAgentSkill(resolvedCasePath);
    }

    // Docker cases: the workspace is a REAL host dir bind-mounted into the container.
    // Scaffold hooks (+ a CLAUDE.md) if MISSING so in-container permission prompts and
    // hook-idle detection fire (decision: wire hooks now). Never clobbers an existing
    // configured project. Claude mode ONLY — only claude reads `.claude` hooks, so a
    // shell or external-CLI quick-start must not author a block of its own (the same
    // rule the existing-case branch above states; this branch used to exclude just
    // the five external CLIs and let `shell` through).
    if (docker && docker.hooksEnabled && mode === 'claude') {
      try {
        if (!existsSync(join(resolvedCasePath, 'CLAUDE.md'))) {
          const templatePath = await ctx.getDefaultClaudeMdPath();
          writeFileSync(join(resolvedCasePath, 'CLAUDE.md'), generateClaudeMd(caseName, '', templatePath));
        }
        if (!existsSync(join(resolvedCasePath, '.claude', 'settings.local.json'))) {
          await writeHooksConfig(resolvedCasePath);
        } else {
          // A settings file with no hooks in it is the same dead-surface case as a
          // linked case. This branch is already gated on `docker.hooksEnabled`, and
          // applyWorkspaceHooks adds the user-level gate on top.
          await applyWorkspaceHooks(resolvedCasePath, await ctx.getWorkspaceHooksEnabled());
        }
      } catch {
        /* non-fatal — the session still runs, hooks may be degraded */
      }
    }

    // Model override → <case>/.claude/settings.local.json (claude-mode; local AND
    // docker — the docker workspace is a real host dir, so the settings file crosses
    // the bind mount and the in-container claude reads it). Remote was rejected above.
    if (mode === 'claude' && modelOverride !== undefined) {
      await updateCaseModel(resolvedCasePath, modelOverride || null);
    }

    // Strip stale disk entries for keys this request is actively setting (Claude only —
    // see POST /api/sessions for full rationale).
    if (
      mode !== 'opencode' &&
      mode !== 'codex' &&
      mode !== 'gemini' &&
      mode !== 'antigravity' &&
      mode !== 'pi' &&
      mode !== 'grok' &&
      mode !== 'deepseek' &&
      mode !== 'omp' &&
      !remote &&
      envOverrides &&
      Object.keys(envOverrides).length > 0
    ) {
      await stripCaseEnvKeys(resolvedCasePath, Object.keys(envOverrides));
    }

    // Create a new session with the case as working directory
    // Apply global Nice priority config and model config from settings
    const niceConfig = await ctx.getGlobalNiceConfig();
    const qsModelConfig = await ctx.getModelConfig();
    const qsModel =
      mode === 'opencode'
        ? openCodeConfig?.model
        : mode === 'codex'
          ? codexConfig?.model
          : mode === 'gemini'
            ? geminiConfig?.model
            : mode === 'antigravity'
              ? antigravityConfig?.model
              : mode === 'pi'
                ? piConfig?.model
                : mode === 'grok'
                  ? grokConfig?.model
                  : mode === 'omp'
                    ? ompConfig?.model
                    : // DeepSeek's model lives in the profile's config tree, not here.
                      mode !== 'shell' && mode !== 'deepseek'
                      ? qsModelConfig?.defaultModel || undefined
                      : undefined;
    const qsClaudeModeConfig = await ctx.getClaudeModeConfig();
    const qsEffectiveClaudeMode = await resolveClaudeModeForUsername(qsClaudeModeConfig.claudeMode, owner);
    // Section 6.3: clamp Codex/Gemini/Antigravity bypass switches for a non-granted owner (no-op single-user/granted).
    const {
      codexConfig: qsGatedCodexConfig,
      geminiConfig: qsGatedGeminiConfig,
      antigravityConfig: qsGatedAntigravityConfig,
      piConfig: qsGatedPiConfig,
      grokConfig: qsGatedGrokConfig,
      deepSeekConfig: qsGatedDeepSeekConfig,
    } = await clampExternalCliBypassForOwner(
      owner,
      codexConfig,
      geminiConfig,
      antigravityConfig,
      piConfig,
      grokConfig,
      deepSeekConfig
    );
    const qsTerminalHistoryConfig = await ctx.getTerminalHistoryConfig();
    const qsGatedEnvOverrides = await clampEnvOverridesForOwner(owner, envOverrides);
    const session = new Session({
      workingDir: resolvedCasePath,
      name: sessionName ? sessionName.slice(0, MAX_SESSION_NAME_LENGTH) : '',
      mux: ctx.mux,
      useMux: true,
      mode: mode,
      niceConfig: niceConfig,
      model: qsModel,
      claudeMode: qsEffectiveClaudeMode,
      allowedTools: qsClaudeModeConfig.allowedTools,
      owner,
      openCodeConfig: mode === 'opencode' ? openCodeConfig : undefined,
      codexConfig: mode === 'codex' ? qsGatedCodexConfig : undefined,
      geminiConfig: mode === 'gemini' ? qsGatedGeminiConfig : undefined,
      antigravityConfig: mode === 'antigravity' ? qsGatedAntigravityConfig : undefined,
      piConfig: mode === 'pi' ? qsGatedPiConfig : undefined,
      grokConfig: mode === 'grok' ? qsGatedGrokConfig : undefined,
      deepSeekConfig: mode === 'deepseek' ? qsGatedDeepSeekConfig : undefined,
      ompConfig: resolveOmpConfigForCreate(mode, resolvedCasePath, ompConfig),
      envOverrides: qsGatedEnvOverrides,
      effort,
      remote,
      docker,
      resumeSessionId: dockerResumeId,
      tmuxHistoryLimit: qsTerminalHistoryConfig.tmuxHistoryLimit,
      parentSessionId: resolveParentSessionId(ctx, req, parentSessionId, owner),
    });

    // Auto-detect completion phrase from CLAUDE.md BEFORE broadcasting
    // so the initial state already has the phrase configured (only if globally enabled)
    if (mode === 'claude' && !remote && !docker && ctx.store.getConfig().ralphEnabled) {
      autoConfigureRalph(session, resolvedCasePath, ctx);
      if (!session.ralphTracker.enabled) {
        session.ralphTracker.enable();
        session.ralphTracker.enableAutoEnable(); // Allow re-enabling on restart
      }
    }

    await ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    // Pre-seed the agent skill's preamble cache so its §0 bootstrap is a two-line
    // loader (see seedAgentSessionPreamble). Local claude sessions only; best-effort.
    if (mode === 'claude' && !remote && !docker && (await ctx.getAgentSkillEnabled())) {
      await seedAgentSessionPreamble(session.id).catch((err: unknown) =>
        console.warn(`[agent-skill] preamble seed failed for ${session.id}: ${getErrorMessage(err)}`)
      );
    }
    getLifecycleLog().log({
      event: 'created',
      sessionId: session.id,
      name: session.name,
      reason: 'quick_start',
    });
    ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));

    // Start in the appropriate mode
    try {
      if (mode === 'shell') {
        await session.startShell();
        getLifecycleLog().log({
          event: 'started',
          sessionId: session.id,
          name: session.name,
          mode: 'shell',
        });
        ctx.broadcast(SseEvent.SessionInteractive, { id: session.id, mode: 'shell' });
      } else {
        // every non-shell mode ('claude', the external CLIs) uses startInteractive()
        await session.startInteractive();
        getLifecycleLog().log({
          event: 'started',
          sessionId: session.id,
          name: session.name,
          mode,
        });
        ctx.broadcast(SseEvent.SessionInteractive, { id: session.id, mode });
      }
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });

      // Docker + claude: the pane command pins the conversation id (--session-id /
      // --resume, claudeDockerPaneCommand), so persist it as the case's resume seed
      // NOW — a later container stop/reboot relaunch resumes this conversation even
      // if no in-container hook ever reaches the host (loopback bind, no bridge
      // listener). Hook/last-response adoption updates it again after /clear.
      if (docker && mode === 'claude') {
        void persistDockerCaseClaudeSessionId(
          CODEMAN_CONFIG_DIR,
          docker.containerName,
          session.claudeSessionId || session.id
        ).catch(() => {});
      }

      // Save lastUsedCase to settings for TUI/web sync
      try {
        const settingsFilePath = SETTINGS_PATH;
        let settings: Record<string, unknown> = {};
        try {
          settings = JSON.parse(await fs.readFile(settingsFilePath, 'utf-8'));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        settings.lastUsedCase = caseName;
        const dir = dirname(settingsFilePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        // Use async write to avoid blocking event loop
        fs.writeFile(settingsFilePath, JSON.stringify(settings, null, 2)).catch((err) => {
          // Non-critical but log for debugging
          console.warn('[Server] Failed to save settings (lastUsedCase):', err);
        });
      } catch (err) {
        // Non-critical but log for debugging
        console.warn('[Server] Failed to prepare settings update:', err);
      }

      return {
        sessionId: session.id,
        casePath: resolvedCasePath,
        caseName,
      };
    } catch (err) {
      // Clean up session on error to prevent orphaned resources
      await ctx.cleanupSession(session.id, true, 'quick_start_error');
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // History — list past Claude conversations for resume
  // ═══════════════════════════════════════════════════════════════

  /** Extract the text of the first user message from a JSONL transcript head. */
  function extractFirstUserPrompt(head: string): string | undefined {
    const MAX_PROMPT_LEN = 120;
    // Iterate lines without allocating a full split array
    let start = 0;
    while (start < head.length) {
      const end = head.indexOf('\n', start);
      const line = end === -1 ? head.slice(start) : head.slice(start, end);
      start = end === -1 ? head.length : end + 1;
      if (!line.includes('"type":"user"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user' || !entry.message) continue;
        const content = entry.message.content;
        let text: string | undefined;
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b: { type: string }) => b.type === 'text');
          if (textBlock) text = textBlock.text;
        }
        if (!text) continue;
        // Strip XML-like system/command tags and ANSI escapes from transcripts
        text = text
          .replace(/<[^>]+>/g, '')
          .replace(new RegExp(String.raw`\x1b\[[0-9;]*[a-zA-Z]`, 'g'), '')
          .trim()
          .replace(/\s+/g, ' ');
        if (!text) continue;
        // Skip system-injected messages, slash command artifacts, and expanded skill prompts
        if (
          /^(Caveat:|init\b|clear\b|resume\b|\/[a-z][\w-]*\b|You are a |\[Request |Set model to )/i.test(text) ||
          /^(Please )?(analyze|review) this codebase/i.test(text) ||
          /^(Read|Implement the following) .+, then (search|list|check) /i.test(text) ||
          /^\d+ vulnerabilit/i.test(text) ||
          /\btoolu_/.test(text) ||
          /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/.test(text) ||
          /\b(sk-ant-|ANTHROPIC_API_KEY|API_KEY=|SECRET|TOKEN=)/i.test(text) ||
          text.length < 8
        )
          continue;
        return text.length > MAX_PROMPT_LEN ? text.slice(0, MAX_PROMPT_LEN) + '\u2026' : text;
      } catch {
        // Malformed line — skip
      }
    }
    return undefined;
  }

  /**
   * Is this `entrypoint` value an automated/SDK-driven invocation?
   *
   * ⚠️ Deliberately a BLOCKLIST on the SDK shape, not an allowlist on `'cli'`.
   * The exclusion below hides rows, so an allowlist fails CLOSED on any value
   * Claude Code has not shipped yet: the day it stamps a new interactive
   * entrypoint (a rename, or a second interactive host), every transcript stops
   * matching `'cli'` and the whole Past Sessions list goes blank with nothing in
   * the UI to explain it. A blocklist fails OPEN instead — an automated
   * entrypoint we do not recognize yet costs a few noisy rows, which is the
   * annoyance this filter set out to fix rather than a broken feature.
   *
   * Observed values: `cli` (interactive), `sdk-cli` / `sdk-py` (automated).
   */
  function isAutomatedEntrypoint(entrypoint: string): boolean {
    return /^sdk(-|$)/.test(entrypoint);
  }

  /**
   * The `entrypoint` field Claude Code stamps on its own message records:
   * 'cli' for a real interactive session, something else (e.g. 'sdk-py') for
   * an SDK/automated invocation. Used to exclude non-interactive transcripts
   * (CI review bots, etc.) from the resumable history list — they were never
   * something a user can resume into.
   *
   * Scans every `"type":"user"`/`"type":"assistant"` line with an entrypoint
   * field — not just the first one — and returns 'cli' the moment ANY of them
   * carries it. A transcript is excluded only when every entrypoint-bearing
   * message says something else; "first field wins" would misattribute a
   * transcript that started under an older Claude Code version (no entrypoint
   * on its true first message) and later picked up a non-'cli' entrypoint on
   * some later message, wrongly hiding a genuinely interactive session. This
   * deliberately errs toward keeping a session visible: one real interactive
   * message anywhere is enough. Returns undefined ("unknown", fail-open) only
   * when nothing scanned carries the field at all.
   */
  function extractTranscriptEntrypoint(text: string): string | undefined {
    let start = 0;
    let sawNonCli: string | undefined;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      const line = end === -1 ? text.slice(start) : text.slice(start, end);
      start = end === -1 ? text.length : end + 1;
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      if (!line.includes('"entrypoint"')) continue;
      try {
        const entry = JSON.parse(line);
        if ((entry.type === 'user' || entry.type === 'assistant') && typeof entry.entrypoint === 'string') {
          if (entry.entrypoint === 'cli') return 'cli';
          sawNonCli ??= entry.entrypoint;
        }
      } catch {
        // Malformed/truncated line — skip
      }
    }
    return sawNonCli;
  }

  /** Git/worktree facts recovered from a transcript. Every field is optional —
   *  "unknown" must stay distinguishable from "not a worktree" (#265/#266). */
  type TranscriptGitInfo = {
    /** The literal `cwd` Claude Code stamped on its own records. */
    cwd?: string;
    gitBranch?: string;
    worktreeName?: string;
    /** Main repo root the worktree belongs to. */
    worktreeRepo?: string;
  };

  /** `<repo>/.claude/worktrees/<name>` — the layout Claude Code's own worktree feature creates. */
  const CLAUDE_WORKTREE_PATH = /^(.*)\/\.claude\/worktrees\/([^/]+)\/?$/;

  /**
   * Recover cwd / branch / worktree from a transcript chunk.
   *
   * Claude Code stamps `"cwd"` and `"gitBranch"` on every user/assistant record,
   * and writes a dedicated `worktree-state` record when the session was started
   * through its own worktree feature. This reads buffers `scanProjectDir` has
   * ALREADY loaded, so it costs no extra file I/O.
   *
   * Why this matters beyond a label: `decodeProjectKey()` reconstructs a path by
   * stat-walking the filesystem and falls back to `$HOME` when nothing resolves.
   * A deleted worktree is the normal end of a worktree's life, so every past
   * worktree session used to collapse onto `$HOME` (#265). The transcript value
   * is the literal cwd — non-lossy, and it survives the directory being removed.
   *
   * cwd is taken from the FIRST record that carries it (a session's cwd does not
   * move); gitBranch from the LAST (a branch genuinely changes mid-session, and
   * the newest value in the scanned chunk is the closest to current).
   */
  function extractTranscriptGitInfo(text: string): TranscriptGitInfo {
    const info: TranscriptGitInfo = {};
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      const line = end === -1 ? text.slice(start) : text.slice(start, end);
      start = end === -1 ? text.length : end + 1;

      // Highest-confidence source: Claude's own worktree record. Names the
      // worktree explicitly, so it beats anything inferred from the path.
      if (line.includes('"worktree-state"')) {
        try {
          const rec = JSON.parse(line) as {
            worktreeSession?: { worktreeName?: unknown; worktreePath?: unknown; originalCwd?: unknown };
          };
          const ws = rec.worktreeSession;
          if (ws) {
            if (typeof ws.worktreeName === 'string') info.worktreeName ||= ws.worktreeName;
            if (typeof ws.originalCwd === 'string') info.worktreeRepo ||= ws.originalCwd;
            if (typeof ws.worktreePath === 'string') info.cwd ||= ws.worktreePath;
          }
        } catch {
          // Malformed/truncated line — skip
        }
        continue;
      }

      if (!line.includes('"cwd"') && !line.includes('"gitBranch"')) continue;
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      try {
        const rec = JSON.parse(line) as { cwd?: unknown; gitBranch?: unknown };
        if (!info.cwd && typeof rec.cwd === 'string' && rec.cwd) info.cwd = rec.cwd;
        // Last one wins — closest to the session's current branch.
        if (typeof rec.gitBranch === 'string' && rec.gitBranch) info.gitBranch = rec.gitBranch;
      } catch {
        // Malformed/truncated line — skip
      }
    }

    // No explicit worktree record: infer from Claude's own worktree path layout.
    // A worktree created by hand (`git worktree add` anywhere) has no recoverable
    // NAME here — it still gets a branch, and the badge degrades to branch-only
    // rather than guessing.
    if (!info.worktreeName && info.cwd) {
      const m = CLAUDE_WORKTREE_PATH.exec(info.cwd);
      if (m) {
        info.worktreeName = m[2];
        info.worktreeRepo ||= m[1];
      }
    }
    return info;
  }

  /**
   * Extract the text of the LAST user message from a JSONL transcript chunk
   * (COD-145). Mirrors `extractFirstUserPrompt` exactly — same user-message
   * detection, same noise/secret/slash-command filters, same 120-char cap — but
   * keeps the last qualifying match instead of returning on the first. Scan the
   * file tail for this (the most recent prompt lives near the end).
   */
  function extractLastUserPrompt(text: string): string | undefined {
    const MAX_PROMPT_LEN = 120;
    let result: string | undefined;
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      const line = end === -1 ? text.slice(start) : text.slice(start, end);
      start = end === -1 ? text.length : end + 1;
      if (!line.includes('"type":"user"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user' || !entry.message) continue;
        const content = entry.message.content;
        let msgText: string | undefined;
        if (typeof content === 'string') {
          msgText = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b: { type: string }) => b.type === 'text');
          if (textBlock) msgText = textBlock.text;
        }
        if (!msgText) continue;
        msgText = msgText
          .replace(/<[^>]+>/g, '')
          .replace(new RegExp(String.raw`\x1b\[[0-9;]*[a-zA-Z]`, 'g'), '')
          .trim()
          .replace(/\s+/g, ' ');
        if (!msgText) continue;
        if (
          /^(Caveat:|init\b|clear\b|resume\b|\/[a-z][\w-]*\b|You are a |\[Request |Set model to )/i.test(msgText) ||
          /^(Please )?(analyze|review) this codebase/i.test(msgText) ||
          /^(Read|Implement the following) .+, then (search|list|check) /i.test(msgText) ||
          /^\d+ vulnerabilit/i.test(msgText) ||
          /\btoolu_/.test(msgText) ||
          /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/.test(msgText) ||
          /\b(sk-ant-|ANTHROPIC_API_KEY|API_KEY=|SECRET|TOKEN=)/i.test(msgText) ||
          msgText.length < 8
        )
          continue;
        result = msgText.length > MAX_PROMPT_LEN ? msgText.slice(0, MAX_PROMPT_LEN) + '…' : msgText;
      } catch {
        // Malformed line — skip
      }
    }
    return result;
  }

  /**
   * Decode a Claude project key (e.g. "-Users-teigen-Documents-Workspace-AI-project-Mirror")
   * back to a filesystem path ("/Users/teigen/Documents/Workspace/AI_project/Mirror").
   *
   * Claude CLI encodes both '/' and '_' as '-', so each '-' in the key could be
   * any of: '/' (path separator), '_' (underscore), or '-' (literal dash).
   *
   * Strategy: recursive backtracking with longest-match-first preference.
   * At each segment boundary, try joining as many segments as possible (with '_'
   * or '-') into a single existing directory name. If a shorter match leads to a
   * dead end, backtrack and try the next-shorter candidate.
   *
   * Why backtracking: when both `diary/` and `diary-app/` exist as siblings, the
   * naive shortest-match would pick `diary` and then fail to find `app` inside,
   * leaving the rest of the key unresolved. Longest-first picks `diary-app`.
   */
  async function decodeProjectKey(projKey: string): Promise<string> {
    const encoded = projKey.startsWith('-') ? projKey.slice(1) : projKey;
    const segments = encoded.split('-');

    const isDirCache = new Map<string, boolean>();
    const isDir = async (p: string): Promise<boolean> => {
      const cached = isDirCache.get(p);
      if (cached !== undefined) return cached;
      const result = await fs
        .stat(p)
        .then((s) => s.isDirectory())
        .catch(() => false);
      isDirCache.set(p, result);
      return result;
    };

    // Recursive backtracking: returns the deepest valid path that consumes all
    // segments. Tries the longest segment-join first at each step so that
    // dash-containing directory names win over shorter same-prefix siblings.
    async function tryDecode(idx: number, current: string): Promise<string | null> {
      if (idx >= segments.length) return current;
      const maxLook = Math.min(idx + 4, segments.length);
      // Longest first: end = maxLook-1 down to idx
      for (let end = maxLook - 1; end >= idx; end--) {
        const candidates: string[] = [];
        if (end === idx) {
          // Skip an EMPTY segment: `isDir(current + '/' + '')` stats `current + '/'`,
          // which always succeeds, so the empty candidate would match unconditionally
          // and swallow the doubled dash that is the whole signature of a dotdir. It
          // then resolves "/home/x/.sib" to "/home/x//sib" whenever a non-dot sibling
          // exists, and shadows the dotdir branch below in every other case.
          if (segments[idx] !== '') candidates.push(segments[idx]);
        } else {
          candidates.push(segments.slice(idx, end + 1).join('-'));
          candidates.push(segments.slice(idx, end + 1).join('_'));
        }
        for (const child of candidates) {
          const candidate = current + '/' + child;
          if (await isDir(candidate)) {
            const result = await tryDecode(end + 1, candidate);
            if (result) return result;
          }
        }
      }
      // The encoder maps both '/' and '.' to '-', so a literal '.' in the
      // original path (e.g. "/home/timkjr/.codeman") collapses into an empty
      // split segment here. Retry this window as a dotdir/dotfile: ".<join>".
      if (segments[idx] === '' && idx + 1 < segments.length) {
        const dotMaxLook = Math.min(idx + 1 + 4, segments.length);
        for (let end = dotMaxLook - 1; end >= idx + 1; end--) {
          const dotCandidates =
            end === idx + 1
              ? [segments[idx + 1]]
              : [segments.slice(idx + 1, end + 1).join('-'), segments.slice(idx + 1, end + 1).join('_')];
          for (const child of dotCandidates) {
            const candidate = current + '/.' + child;
            if (await isDir(candidate)) {
              const result = await tryDecode(end + 1, candidate);
              if (result) return result;
            }
          }
        }
      }
      return null;
    }

    const decoded = await tryDecode(0, '');
    if (decoded) return decoded;

    // Fallback: greedy shortest-match (original behavior) — best effort when
    // no fully-valid path exists (e.g. directory was deleted after the
    // conversation was recorded).
    let current = '';
    let i = 0;
    while (i < segments.length) {
      let matched = false;
      const maxLook = Math.min(i + 4, segments.length);
      for (let end = i; end < maxLook; end++) {
        const candidates: string[] = [];
        if (end === i) {
          // Same empty-segment skip as tryDecode above. This loop is shortest-match
          // first, so without it the empty candidate matches on the very first try
          // and sets `matched`, leaving the dotdir branch below permanently dead.
          if (segments[i] !== '') candidates.push(segments[i]);
        } else {
          candidates.push(segments.slice(i, end + 1).join('_'));
          candidates.push(segments.slice(i, end + 1).join('-'));
        }
        for (const child of candidates) {
          const candidate = current + '/' + child;
          if (await isDir(candidate)) {
            current = candidate;
            i = end + 1;
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched && segments[i] === '' && i + 1 < segments.length) {
        const dotMaxLook = Math.min(i + 1 + 4, segments.length);
        for (let end = i + 1; end < dotMaxLook; end++) {
          const dotCandidates =
            end === i + 1
              ? [segments[i + 1]]
              : [segments.slice(i + 1, end + 1).join('_'), segments.slice(i + 1, end + 1).join('-')];
          for (const child of dotCandidates) {
            const candidate = current + '/.' + child;
            if (await isDir(candidate)) {
              current = candidate;
              i = end + 1;
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
      }
      if (!matched) {
        if (segments[i] === '') {
          // Nothing on disk matched (the usual reason this fallback runs at all is
          // that the directory was deleted). An empty segment still means the
          // encoder ate a literal '.', so guess the dotdir form rather than
          // appending a bare '/' and emitting a "//" path.
          if (i + 1 < segments.length) {
            current = current + '/.' + segments[i + 1];
            i += 2;
          } else {
            i++;
          }
        } else {
          current = current + '/' + segments[i];
          i++;
        }
      }
    }
    const finalExists = await fs
      .access(current)
      .then(() => true)
      .catch(() => false);
    return finalExists ? current : process.env.HOME || '/tmp';
  }

  /** Read the first `buf.length` bytes of a file for content sniffing. */
  async function readFileHead(path: string, buf: Buffer): Promise<string | null> {
    try {
      const fd = await fs.open(path, 'r');
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      await fd.close();
      return buf.toString('utf8', 0, bytesRead);
    } catch {
      return null;
    }
  }

  /** Read the last `buf.length` bytes of a file (for tail-scanning user prompts). */
  async function readFileTail(path: string, buf: Buffer, fileSize: number): Promise<string | null> {
    try {
      const fd = await fs.open(path, 'r');
      const offset = Math.max(0, fileSize - buf.length);
      const { bytesRead } = await fd.read(buf, 0, buf.length, offset);
      await fd.close();
      const text = buf.toString('utf8', 0, bytesRead);
      // Skip first partial line when we didn't read from the start
      if (offset > 0) {
        const nl = text.indexOf('\n');
        return nl >= 0 ? text.slice(nl + 1) : null;
      }
      return text;
    } catch {
      return null;
    }
  }

  type HistorySession = {
    sessionId: string;
    workingDir: string;
    projectKey: string;
    sizeBytes: number;
    lastModified: string;
    firstPrompt?: string;
    lastPrompt?: string;
    /** True when workingDir came from the transcript rather than decodeProjectKey's guess. */
    workingDirExact?: boolean;
    gitBranch?: string;
    worktreeName?: string;
    worktreeRepo?: string;
  };

  // Scan a single project directory and return all valid history sessions in it.
  // Reused by both the global overview and the single-folder drill-down.
  async function scanProjectDir(
    projPath: string,
    projDir: string,
    smallHeadBuf: Buffer,
    headBuf: Buffer
  ): Promise<HistorySession[]> {
    const out: HistorySession[] = [];
    const stat = await fs.stat(projPath).catch(() => null);
    if (!stat?.isDirectory()) return out;

    const workingDir = await decodeProjectKey(projDir);
    const entries = await fs.readdir(projPath).catch(() => [] as string[]);

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.replace('.jsonl', '');
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)) continue;

      const filePath = join(projPath, entry);
      const fileStat = await fs.stat(filePath).catch(() => null);
      if (!fileStat) continue;
      if (fileStat.size < 4000) continue;

      const hasConversation = (text: string) =>
        text.includes('"type":"user"') || text.includes('"type":"assistant"') || text.includes('"type":"summary"');

      // Two-tier head read: try the cheap smallHeadBuf (16KB) size first -- enough
      // for the vast majority of transcripts -- and only escalate to the full
      // headBuf (128KB) when that wasn't enough. Reading 128KB unconditionally for
      // EVERY file in the directory roughly quadrupled the cost of a full scan
      // (measured against a real ~/.claude/projects tree: ~4x both bytes read and
      // wall time) to fix a problem only ~28% of files actually have. Escalating
      // resolves the restart-bookkeeping case (the reason 128KB exists at all)
      // without ever touching the tail-read fallback below for most of that 28%.
      let head = await readFileHead(filePath, smallHeadBuf);
      let foundContent = head ? hasConversation(head) : false;
      let firstPrompt = head ? extractFirstUserPrompt(head) : undefined;
      if ((!foundContent || !firstPrompt) && head !== null && fileStat.size > smallHeadBuf.length) {
        const biggerHead = await readFileHead(filePath, headBuf);
        if (biggerHead) {
          head = biggerHead;
          if (!foundContent) foundContent = hasConversation(head);
          if (!firstPrompt) firstPrompt = extractFirstUserPrompt(head);
        }
      }

      let tail: string | null = null;
      // `head === null` (a failed read -- e.g. EMFILE while scanning hundreds of
      // files) must also get a shot at the tail, not just "file bigger than the
      // head buffer". Losing this dropped the session from history entirely
      // instead of giving it a second chance, for any file at or under the head
      // buffer size whose head read happened to fail.
      if (!foundContent && (head === null || fileStat.size > headBuf.length)) {
        const tailBuf = Buffer.alloc(32768);
        tail = await readFileTail(filePath, tailBuf, fileStat.size);
        if (tail) foundContent = hasConversation(tail);
      }
      if (!foundContent) continue;

      // firstPrompt was already attempted from head (both tiers) above; this is
      // purely the tail fallback for whatever's left unresolved.
      if (!firstPrompt && (head === null || fileStat.size > headBuf.length)) {
        if (!tail) {
          const tailBuf = Buffer.alloc(32768);
          tail = await readFileTail(filePath, tailBuf, fileStat.size);
        }
        if (tail) firstPrompt = extractFirstUserPrompt(tail);
      }

      // COD-145: last (most recent) user prompt lives near the END of the file, so
      // prefer the tail. For large files where no tail was read yet, read one
      // (mirrors the firstPrompt > headBuf.length block). Small files fit in `head`,
      // which then contains the whole transcript — scan it for the last match instead.
      if (!tail && fileStat.size > headBuf.length) {
        const tailBuf = Buffer.alloc(32768);
        tail = await readFileTail(filePath, tailBuf, fileStat.size);
      }
      const lastPrompt =
        (tail ? extractLastUserPrompt(tail) : undefined) ?? (head ? extractLastUserPrompt(head) : undefined);

      // Automated/SDK-driven invocations (CI review bots, etc.) write transcripts
      // into the same ~/.claude/projects tree as interactive sessions but were
      // never something a user can resume into — no PTY, no running process, and
      // their "conversation" is typically a single one-shot prompt (often with a
      // full diff embedded, which is exactly why it dwarfs this scanner's read
      // windows and shows up above as blank or as an identical boilerplate
      // sentence across many rows). Checked last, so it reuses whatever `head`/
      // `tail` the prompt extraction above already read rather than triggering
      // an extra file read. Missing entrypoint (older transcripts) reads as
      // interactive — fail open, matching every other gating check in this
      // codebase.
      //
      // head and tail are checked independently and merged with "cli wins" (not
      // a first-truthy-value `??` chain): a large file's head might land on a
      // non-'cli' message while a real interactive message sits in the tail (or
      // vice versa), and either one being 'cli' is enough to keep the session.
      const headEntrypoint = head ? extractTranscriptEntrypoint(head) : undefined;
      const tailEntrypoint = tail ? extractTranscriptEntrypoint(tail) : undefined;
      const entrypoint =
        headEntrypoint === 'cli' || tailEntrypoint === 'cli' ? 'cli' : (headEntrypoint ?? tailEntrypoint);
      if (entrypoint && isAutomatedEntrypoint(entrypoint)) continue;

      // Git/worktree facts from the buffers already read above — no extra I/O.
      // head first (cwd is stamped near the top; median offset ~1KB), tail as the
      // fallback for transcripts whose head read failed or came up empty.
      const headGit = head ? extractTranscriptGitInfo(head) : {};
      const tailGit = tail ? extractTranscriptGitInfo(tail) : {};
      const git: TranscriptGitInfo = {
        cwd: headGit.cwd ?? tailGit.cwd,
        // Last-wins within a chunk; across chunks the tail is the newer one.
        gitBranch: tailGit.gitBranch ?? headGit.gitBranch,
        worktreeName: headGit.worktreeName ?? tailGit.worktreeName,
        worktreeRepo: headGit.worktreeRepo ?? tailGit.worktreeRepo,
      };

      out.push({
        sessionId,
        // The transcript's literal cwd beats decodeProjectKey's stat-walked guess,
        // which silently collapses to $HOME once the directory is gone (#265).
        // Absent cwd falls back to the old behaviour rather than inventing a path.
        workingDir: git.cwd ?? workingDir,
        workingDirExact: git.cwd !== undefined,
        projectKey: projDir,
        sizeBytes: fileStat.size,
        lastModified: fileStat.mtime.toISOString(),
        firstPrompt,
        lastPrompt,
        gitBranch: git.gitBranch,
        worktreeName: git.worktreeName,
        worktreeRepo: git.worktreeRepo,
      });
    }
    return out;
  }

  app.get('/api/history/sessions', async (req) => {
    const query = req.query as { projectKey?: string; offset?: string; limit?: string };
    const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');
    // scanProjectDir tries smallHeadBuf (16KB, the original size) first for every
    // file and only escalates to headBuf (128KB) when that wasn't enough — see the
    // comment at the escalation site in scanProjectDir for why unconditional 128KB
    // reads were too expensive to keep. 128KB matches the existing precedent
    // elsewhere in this file (line ~1431).
    const smallHeadBuf = Buffer.alloc(16384);
    const headBuf = Buffer.alloc(131072);
    // Multi-user: this scans the host-wide ~/.claude/projects tree, so a non-admin
    // must only see history whose decoded workingDir is inside their own case space.
    // Do NOT trust the caller-supplied projectKey — confine on the decoded path.
    // No-op for admins / single-user mode.
    const user = getAuthUser(req);
    const scopeHistory = isMultiUserMode() && user.role !== 'admin';

    // Single-folder drill-down: when projectKey is provided, scan only that
    // directory, bypass the 50-cap, and honor offset/limit pagination.
    if (query.projectKey) {
      // Validate projectKey format to prevent path traversal
      if (!/^[A-Za-z0-9_-]+$/.test(query.projectKey)) {
        return { sessions: [], total: 0 };
      }
      const offset = Math.max(0, parseInt(query.offset || '0', 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10) || 20));
      const projPath = join(projectsDir, query.projectKey);
      let all = await scanProjectDir(projPath, query.projectKey, smallHeadBuf, headBuf);
      // Confine to the caller's workspace (a projectKey maps to a single foreign cwd).
      if (scopeHistory) all = all.filter((r) => isWorkingDirAllowed(user, r.workingDir));
      all.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      return { sessions: all.slice(offset, offset + limit), total: all.length };
    }

    // Global overview: scan all projects, return up to 50 most-recent sessions.
    let results: HistorySession[] = [];
    try {
      const projectDirs = await fs.readdir(projectsDir);
      for (const projDir of projectDirs) {
        const projPath = join(projectsDir, projDir);
        const list = await scanProjectDir(projPath, projDir, smallHeadBuf, headBuf);
        results.push(...list);
      }
    } catch {
      // Projects dir may not exist
    }

    // Multi-user: drop rows outside the non-admin caller's own case space.
    if (scopeHistory) results = results.filter((r) => isWorkingDirAllowed(user, r.workingDir));
    results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    return { sessions: results.slice(0, 50) };
  });

  /**
   * Gather the four read-only views the unified list is merged from, plus mux
   * stats. This is the expensive half (the lifecycle log and a scan of every
   * Claude transcript), factored out of the route handler because the
   * past-session search index rebuilds itself from the very same inputs, off
   * the request path, see session-history-index.ts.
   */
  async function gatherUnifiedInputs(): Promise<{
    live: LiveSessionInput[];
    persisted: PersistedSessionInput[];
    lifecycle: LifecycleInput[];
    history: HistoryInput[];
    mux: MuxStatInput[];
  }> {
    // Live (in-memory) sessions.
    const live: LiveSessionInput[] = [...ctx.sessions.values()].map((s) => {
      const st = s.toState();
      return {
        id: st.id,
        name: st.name,
        mode: st.mode,
        status: st.status,
        isWorking: s.isWorking,
        workingDir: st.workingDir,
        createdAt: st.createdAt,
        lastActivityAt: st.lastActivityAt,
        claudeSessionId: s.claudeSessionId ?? undefined,
        pinned: st.pinned,
        pinnedAt: st.pinnedAt,
      };
    });

    // Persisted sessions (state.json). resumeSessionId is the Claude
    // conversation UUID a resumed session continues — feed it to the merge's
    // alias map so its transcript row folds into this session.
    const persisted: PersistedSessionInput[] = Object.values(ctx.store.getState().sessions).map((p) => ({
      id: p.id,
      name: p.name,
      mode: p.mode,
      status: p.status,
      workingDir: p.workingDir,
      createdAt: p.createdAt,
      lastActivityAt: p.lastActivityAt,
      claudeSessionId: p.resumeSessionId,
      pinned: p.pinned,
      pinnedAt: p.pinnedAt,
    }));

    // Lifecycle audit log (newest-first, capped).
    let lifecycle: LifecycleInput[] = [];
    try {
      const entries = await getLifecycleLog().query({ limit: 2000 });
      lifecycle = entries.map((e) => ({
        sessionId: e.sessionId,
        name: e.name,
        mode: e.mode,
        ts: e.ts,
        event: e.event,
      }));
    } catch {
      // Lifecycle log may be unavailable; treat as empty.
    }

    // Transcript history (~/.claude/projects) — reuse the same scanner as the overview.
    const history: HistoryInput[] = [];
    try {
      const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');
      // See the sibling allocation above for why there are two sizes.
      const smallHeadBuf = Buffer.alloc(16384);
      const headBuf = Buffer.alloc(131072);
      const projectDirs = await fs.readdir(projectsDir);
      for (const projDir of projectDirs) {
        const projPath = join(projectsDir, projDir);
        const list = await scanProjectDir(projPath, projDir, smallHeadBuf, headBuf);
        for (const h of list) {
          history.push({
            sessionId: h.sessionId,
            workingDir: h.workingDir,
            sizeBytes: h.sizeBytes,
            lastModified: h.lastModified,
            firstPrompt: h.firstPrompt,
            lastPrompt: h.lastPrompt,
            projectKey: h.projectKey,
            gitBranch: h.gitBranch,
            worktreeName: h.worktreeName,
            worktreeRepo: h.worktreeRepo,
          });
        }
      }
    } catch {
      // Projects dir may not exist.
    }

    // OMP's own session files (~/.omp/agent/sessions) — the non-claude twin
    // of the scan above; see omp-transcript.ts for why this exists at all.
    try {
      for (const h of scanOmpSessionsHistory()) {
        history.push({
          sessionId: h.sessionId,
          workingDir: h.workingDir,
          sizeBytes: h.sizeBytes,
          lastModified: h.lastModified,
          firstPrompt: h.firstPrompt,
          lastPrompt: h.lastPrompt,
          mode: 'omp',
        });
      }
    } catch {
      // Best-effort, same as the claude scan above.
    }

    // Mux process stats (best-effort; guard against mocks lacking the method).
    let mux: MuxStatInput[] = [];
    try {
      const getStats = (ctx.mux as { getSessionsWithStats?: () => Promise<unknown[]> }).getSessionsWithStats;
      if (typeof getStats === 'function') {
        const muxSessions = (await getStats.call(ctx.mux)) as Array<{
          sessionId: string;
          muxName?: string;
          mode?: string;
          remote?: unknown;
          stats?: { memoryMB: number; cpuPercent: number };
        }>;
        mux = muxSessions.map((m) => ({
          sessionId: m.sessionId,
          muxName: m.muxName,
          mode: m.mode,
          remote: m.remote !== undefined ? true : undefined,
          stats: m.stats ? { memoryMB: m.stats.memoryMB, cpuPercent: m.stats.cpuPercent } : undefined,
        }));
      }
    } catch {
      // Mux stats are optional.
    }

    return { live, persisted, lifecycle, history, mux };
  }

  /**
   * Publish a merged unified list as the past-session search index (issue #261).
   * The snapshot is stored UNSCOPED with a per-row owner, so it must only ever be
   * built from an unscoped merge, `harvestSources()` in search-routes re-applies
   * the ownership check on read.
   */
  function publishHistorySessionIndex(merged: UnifiedSessionItem[]): void {
    const ownerById = new Map<string, string | undefined>();
    const stored = ctx.store.getState().sessions as Record<string, { id: string; owner?: string }>;
    for (const p of Object.values(stored)) ownerById.set(p.id, p.owner);
    // Live wins: a session's owner on disk can lag the running one.
    for (const s of ctx.sessions.values()) ownerById.set(s.id, s.owner);
    const liveIds = new Set(ctx.sessions.keys());
    setHistorySessionIndex(buildHistorySessionIndexItems(merged, ownerById, liveIds));
  }

  // Rebuild hook for the search route: it kicks this (fire-and-forget) when the
  // snapshot goes stale, so a search never pays for the scan itself.
  setHistoryIndexRefresher(async () => {
    if (ctx.testMode) return;
    publishHistorySessionIndex(mergeUnifiedSessions(await gatherUnifiedInputs()));
  });

  // Unified, read-only session list: merges live + persisted + lifecycle +
  // transcript history + mux stats into one de-duplicated, searchable list
  // (COD-121). Pure merge/filter logic lives in unified-session-service.ts.
  app.get('/api/sessions/unified', async (req) => {
    const query = req.query as { q?: string; offset?: string; limit?: string };

    if (ctx.testMode) {
      return { sessions: [], total: 0 };
    }

    const { live, persisted, lifecycle, history, mux } = await gatherUnifiedInputs();

    // Multi-user: a non-admin only sees their own sessions; host-wide transcript
    // history (not tied to an owned session) is admin-only.
    let sLive = live;
    let sPersisted = persisted;
    let sLifecycle = lifecycle;
    let sHistory = history;
    let scoped = false;
    const uUser = getAuthUser(req);
    if (isMultiUserMode() && uUser.role !== 'admin') {
      scoped = true;
      const ownedLive = new Set(
        [...ctx.sessions.values()].filter((s) => canAccessOwned(uUser, s.owner)).map((s) => s.id)
      );
      const stored = ctx.store.getState().sessions as Record<string, { id: string; owner?: string }>;
      const ownedPersisted = new Set(
        Object.values(stored)
          .filter((p) => canAccessOwned(uUser, p.owner))
          .map((p) => p.id)
      );
      const isOwned = (id: string) => ownedLive.has(id) || ownedPersisted.has(id);
      sLive = live.filter((l) => isOwned(l.id));
      sPersisted = persisted.filter((p) => isOwned(p.id));
      sLifecycle = lifecycle.filter((e) => isOwned(e.sessionId));
      sHistory = [];
    }

    const merged = mergeUnifiedSessions({
      live: sLive,
      persisted: sPersisted,
      lifecycle: sLifecycle,
      history: sHistory,
      mux,
    });

    // Refresh the search index off the back of this request, the home screen
    // fetches this endpoint whenever it opens, which is the same screen the
    // search box lives on, so the snapshot is warm before anyone types. A scoped
    // merge is a per-user subset and would corrupt the shared snapshot, so that
    // path re-merges unscoped instead (multi-user is opt-in and rarely hit).
    publishHistorySessionIndex(scoped ? mergeUnifiedSessions({ live, persisted, lifecycle, history, mux }) : merged);

    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : undefined;
    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : undefined;
    return filterAndPaginate(merged, {
      q: query.q,
      offset: Number.isNaN(offset as number) ? undefined : offset,
      limit: Number.isNaN(limit as number) ? undefined : limit,
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Paste Image (clipboard / drag-drop upload)
  // ═══════════════════════════════════════════════════════════════

  const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif']);
  // The per-file size cap (MAX_PASTE_IMAGE_BYTES) is enforced by @fastify/multipart (registered in server.ts).

  app.post('/api/sessions/:id/paste-image', async (req, reply) => {
    // CSRF defense: state-changing routes must come from same origin.
    // Cookies are SameSite=lax, multipart/form-data is a "simple" CORS request
    // (no preflight), so a cross-origin <form enctype="multipart/form-data">
    // submit attaches the session cookie unimpeded. Reject unless Origin/Referer
    // matches req.host. Non-browser clients (no Origin AND no Referer) must
    // supply X-Codeman-CSRF — a header browsers cannot add cross-origin without
    // a preflight, which our CORS config does not allow from other origins.
    const reqHost = req.headers.host;
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    let csrfOk = false;
    if (origin) {
      try {
        csrfOk = new URL(origin).host === reqHost;
      } catch {
        /* invalid Origin → not ok */
      }
    } else if (referer) {
      try {
        csrfOk = new URL(referer).host === reqHost;
      } catch {
        /* invalid Referer → not ok */
      }
    } else {
      csrfOk = !!req.headers['x-codeman-csrf'];
    }
    if (!csrfOk) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'CSRF check failed');
    }

    const { id } = req.params as { id: string };

    // Rate limit per (IP, sessionId): 30/min. Defends against disk-fill DoS
    // — even an authenticated attacker can otherwise loop large image POSTs.
    if (!consumePasteToken(`${req.ip}:${id}`)) {
      reply.code(429);
      reply.header('Retry-After', '60');
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Rate limit exceeded (30 uploads/min per session)');
    }

    const session = findSessionOrFail(ctx, id, req);

    if (!req.isMultipart()) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected multipart/form-data');
    }

    // Read the single file part. @fastify/multipart enforces the per-file size
    // cap (MAX_PASTE_IMAGE_BYTES) and the 1-file/4-field count limits (server.ts),
    // replacing a hand-rolled
    // boundary scanner with several bugs: literal boundary matches anywhere in
    // body, LF-only clients silently corrupted the last byte (hard-coded \r\n
    // offsets), no part-count cap.
    let part: import('@fastify/multipart').MultipartFile | undefined;
    try {
      part = await req.file();
    } catch (err: unknown) {
      reply.code(413);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err) || 'Invalid multipart payload');
    }
    if (!part) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No image uploaded');
    }
    if (part.fieldname !== 'image') {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Unexpected field "${part.fieldname}", expected "image"`);
    }
    let imageBytes: Buffer;
    try {
      imageBytes = await part.toBuffer();
    } catch (err: unknown) {
      reply.code(413);
      const maxMb = Math.round(MAX_PASTE_IMAGE_BYTES / (1024 * 1024));
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err) || `File too large (max ${maxMb}MB)`);
    }
    if (imageBytes.length === 0) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Empty file');
    }

    // Determine extension from filename or Content-Type.
    let ext = '.png';
    if (part.filename) {
      const origExt = extname(part.filename).toLowerCase();
      if (ALLOWED_IMAGE_EXTS.has(origExt)) ext = origExt;
    }
    const mimeMatch = (part.mimetype || '').toLowerCase().match(/^image\/(png|jpeg|jpg|webp|gif|bmp|heic|heif)$/);
    if (mimeMatch) {
      const map: Record<string, string> = {
        png: '.png',
        jpeg: '.jpg',
        jpg: '.jpg',
        webp: '.webp',
        gif: '.gif',
        bmp: '.bmp',
        heic: '.heic',
        heif: '.heif',
      };
      ext = map[mimeMatch[1]] ?? ext;
    }

    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      reply.code(400);
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Unsupported image type: ${ext}. Allowed: ${[...ALLOWED_IMAGE_EXTS].join(', ')}`
      );
    }

    // Route HEIC on the raw bytes, NOT the declared ext/mime: on some Android
    // galleries (e.g. MIUI) a HEIF comes back mislabeled as image/jpeg, and
    // browsers that cannot decode HEIF upload the original file as-is — so a
    // HEIC payload can arrive under any declared type. Filename and
    // Content-Type are attacker-supplied anyway; only the bytes are trusted.
    if (imageMagicMatchesExt(imageBytes, '.heic')) {
      try {
        imageBytes = await convertHeicToJpeg(imageBytes);
        ext = '.jpg';
      } catch (err: unknown) {
        console.warn(
          `[paste-image] HEIC conversion failed: filename=${JSON.stringify(part.filename)} mime=${JSON.stringify(part.mimetype)} error=${getErrorMessage(err)}`
        );
        reply.code(415);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Could not convert HEIC image to JPEG');
      }
    } else if (!imageMagicMatchesExt(imageBytes, ext)) {
      // Sniff actual bytes — a polyglot HTML/PNG would otherwise pass and
      // serve back with image/png MIME. Log the real header so format
      // mismatches can be pinned down without a reproduce-and-guess loop. The
      // client re-encodes images to JPEG/PNG before upload, so this is rare.
      console.warn(
        `[paste-image] magic mismatch: filename=${JSON.stringify(part.filename)} mime=${JSON.stringify(part.mimetype)} declaredExt=${ext} magic=${imageBytes.subarray(0, 12).toString('hex')}`
      );
      reply.code(415);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Image bytes do not match declared type ${ext}`);
    }

    // Save to {workingDir}/.claude-images/
    // Refuse symlinks at imageDir — an agent or postinstall script could plant
    // `.claude-images -> ~/.ssh/` and redirect future writes outside workingDir.
    // We lstat (not stat) so we see the symlink itself. Use mkdir without
    // `recursive` so the leaf creation does not follow a symlink either, and
    // O_EXCL|O_NOFOLLOW on the file open so the write itself is symlink-safe.
    const imageDir = join(session.workingDir, '.claude-images');
    try {
      const dirStat = await fs.lstat(imageDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, '.claude-images is not a regular directory');
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Non-recursive mkdir: does not follow symlinks for the leaf.
      // session.workingDir is guaranteed to exist (live session).
      try {
        await fs.mkdir(imageDir);
      } catch (mkErr: unknown) {
        // Concurrent uploads (a batch of photos) race to create .claude-images —
        // the losers get EEXIST. Treat an already-present REAL directory as
        // success, but re-verify it isn't a symlink a racing actor planted
        // (preserve the symlink-safety guarantee above).
        if ((mkErr as NodeJS.ErrnoException).code !== 'EEXIST') throw mkErr;
        const raceStat = await fs.lstat(imageDir);
        if (raceStat.isSymbolicLink() || !raceStat.isDirectory()) {
          reply.code(403);
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, '.claude-images is not a regular directory');
        }
      }
    }
    // Date.now() collides on same-ms uploads from two tabs (last-write wins
    // silently). Append 8 hex chars so concurrent pastes get distinct names.
    const filename = `paste-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
    const filepath = join(imageDir, filename);
    // O_EXCL: refuse to overwrite (collision is impossible with random suffix,
    // but defends against TOCTOU). O_NOFOLLOW: refuse if filepath is a symlink.
    const fh = await fs.open(
      filepath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
    );
    try {
      await fh.writeFile(imageBytes);
    } finally {
      await fh.close();
    }

    return { path: filepath, filename };
  });
}
