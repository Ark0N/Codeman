/**
 * @fileoverview Shared helper functions for route modules.
 *
 * Contains pure functions extracted from server.ts and a session lookup helper
 * that replaces ~43 inline not-found checks across route handlers.
 */

import { join, resolve, relative, isAbsolute } from 'node:path';
import { realpathSync, existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import type { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Session } from '../session.js';
import { ApiErrorCode, createErrorResponse, type AuthUser, type SessionState } from '../types.js';
import { MAX_CONCURRENT_SESSIONS } from '../config/map-limits.js';
import { parseRalphLoopConfig, extractCompletionPhrase } from '../ralph-config.js';
import { SseEvent } from './sse-events.js';
import type { SessionPort } from './ports/session-port.js';
import type { EventPort } from './ports/event-port.js';
import type { AuthSessionRecord } from './ports/auth-port.js';
import type { StaleExpirationMap } from '../utils/index.js';
import { dataPath } from '../config/instance.js';
import { getCasesDir } from '../config/cases-dir.js';
import { isMultiUserMode, maxSessionsPerUser, userCasesDir } from '../config/multiuser.js';
import { SYNTHETIC_ADMIN, findUser } from '../user-store.js';
import { AGENT_ORIGIN_SPAWNED_BY_SESSION, normalizeAgentOrigin } from '../agent-case-marker.js';

// Shared path constants used across route modules. CASES_DIR (project folders)
// stays shared across instances; SETTINGS_PATH is per-instance runtime state.
// The cases dir is resolved in ONE place (config/cases-dir.ts) because the CLI
// resolves it too, and CODEMAN_CASES_PATH must move both or neither.
export const CASES_DIR = getCasesDir();
export const SETTINGS_PATH = dataPath('settings.json');

/**
 * Validates that a path component doesn't escape the base directory.
 * Returns the resolved full path, or null if the path is a traversal attempt.
 */
export function validatePathWithinBase(name: string, baseDir: string): string | null {
  const fullPath = resolve(join(baseDir, name));
  const resolvedBase = resolve(baseDir);
  const relPath = relative(resolvedBase, fullPath);
  if (relPath.startsWith('..') || isAbsolute(relPath)) {
    return null;
  }
  return fullPath;
}

/**
 * Reads and parses a JSON config file, returning a default value on ENOENT.
 * Logs an error for any I/O failure other than a missing file.
 */
export async function readJsonConfig<T>(filePath: string, logLabel: string, defaultValue: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Failed to read ${logLabel}:`, err);
    }
    return defaultValue;
  }
}

/**
 * Validates that a file path (possibly containing symlinks) resolves to a location
 * within the given session working directory. Returns the resolved and relative paths,
 * or null if the path escapes the directory or doesn't exist.
 *
 * BOTH sides are realpath-resolved before they are compared. Resolving only the
 * candidate leaves the two paths in different namespaces whenever the workspace
 * itself is reached through a symlink, and `relative()` then reports a spurious
 * `../` for a file that is genuinely inside it — refusing every read and write in
 * that session. A symlinked workspace is ordinary: `os.tmpdir()` returns one on
 * macOS (`/tmp` -> `/private/tmp`), as do symlinked project dirs and bind-mounted
 * case paths. Canonicalizing the base only makes the comparison honest; escapes
 * are still refused, since the candidate keeps its own realpath.
 */
export function validateSessionFilePath(
  sessionWorkingDir: string,
  filePath: string
): { resolvedPath: string; relativePath: string } | null {
  let resolvedWorkingDir: string;
  let resolvedPath: string;
  try {
    resolvedWorkingDir = realpathSync(sessionWorkingDir);
    resolvedPath = realpathSync(resolve(sessionWorkingDir, filePath));
  } catch {
    return null;
  }
  return confineToRoot(resolvedWorkingDir, resolvedPath);
}

/**
 * The lexical half of {@link validateSessionFilePath}: same containment rule, but
 * WITHOUT touching the filesystem.
 *
 * Needed for remote-SSH cases (`src/remote-files.ts`), where `workingDir` is an
 * absolute path on the REMOTE host and any local `realpathSync` fails by
 * construction — which is how every file-raw/file-content request in a remote case
 * used to end up as a 404 before a single byte was read. The caller follows this
 * pre-check with a remote realpath + the same containment rule, so escapes are
 * refused exactly as they are locally; what changes is only WHICH filesystem
 * resolves the symlinks.
 *
 * A lexical check alone would follow nothing, so it must never be the last word for
 * a path that can contain a symlink — it is the cheap reject in front of the real
 * (local or remote) resolution, not a replacement for it.
 */
export function validateSessionFilePathLexical(
  sessionWorkingDir: string,
  filePath: string
): { resolvedPath: string; relativePath: string } | null {
  return confineToRoot(resolve(sessionWorkingDir), resolve(sessionWorkingDir, filePath));
}

/**
 * Shared containment rule: `candidate` must sit inside `root` (both already
 * canonical for their filesystem). `relative()` is the whole test — a `..` or an
 * absolute result means the candidate escaped.
 */
function confineToRoot(root: string, candidate: string): { resolvedPath: string; relativePath: string } | null {
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
  return { resolvedPath: candidate, relativePath };
}

// Maximum hook data size (prevents oversized SSE broadcasts)
const MAX_HOOK_DATA_SIZE = 8 * 1024;

/**
 * Effective identity for a request. In multi-user mode this is the auth-decorated
 * user; in single-user mode (or when unset) it defaults to a synthetic admin so
 * downstream ownership checks are no-ops and there is ONE code path.
 */
export function getAuthUser(req: FastifyRequest): AuthUser {
  return req.authUser ?? SYNTHETIC_ADMIN;
}

/**
 * Whether an identity may see/act on a resource with the given owner. Always true
 * in single-user mode; in multi-user, admins see everything and regular users only
 * their own (an absent owner is legacy/unassigned = admin-only).
 */
export function canAccessOwned(user: AuthUser, owner: string | undefined): boolean {
  if (!isMultiUserMode()) return true;
  if (user.role === 'admin') return true;
  return !!owner && owner === user.username;
}

/**
 * The owner to stamp on a resource created by this request: the requesting user in
 * multi-user mode, or undefined in single-user (so state stays owner-free and the
 * flag can be removed later without leaving stray owners).
 */
export function ownerFor(req: FastifyRequest): string | undefined {
  return isMultiUserMode() ? getAuthUser(req).username : undefined;
}

/**
 * The cases directory for a request/user: the shared ~/codeman-cases in single-user
 * mode, or the per-user ~/codeman-users/<username>/cases in multi-user (created
 * lazily). Admins are NOT auto-scoped here — an admin acting on a specific user's
 * case resolves through the owner-aware case resolver instead.
 */
export function resolveCasesDir(user?: AuthUser): string {
  if (!isMultiUserMode() || !user) return CASES_DIR;
  const dir = userCasesDir(user.username);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Realpath-confine a non-admin's requested working directory to their own case
 * space in multi-user mode. Returns true if allowed. Admins and single-user mode
 * are unrestricted. The path need not exist yet (checked against its nearest
 * existing ancestor) so newly-created case dirs pass. This is the load-bearing
 * rule (plan 6.2/14.7): every file-serving surface downstream trusts workingDir.
 */
export function isWorkingDirAllowed(user: AuthUser, workingDir: string): boolean {
  if (!isMultiUserMode() || user.role === 'admin') return true;
  const base = userCasesDir(user.username);
  // Resolve the deepest existing ancestor to defeat symlink escapes without
  // requiring the leaf to exist yet.
  const resolveExisting = (p: string): string => {
    let cur = resolve(p);
    // walk up until an existing path is found
    for (;;) {
      try {
        return realpathSync(cur);
      } catch {
        const parent = resolve(cur, '..');
        if (parent === cur) return cur;
        cur = parent;
      }
    }
  };
  let realBase: string;
  try {
    realBase = realpathSync(base);
  } catch {
    // base does not exist yet — create it so confinement has a stable anchor
    mkdirSync(base, { recursive: true });
    realBase = realpathSync(base);
  }
  const realTarget = resolveExisting(workingDir);
  if (realTarget === realBase) return true;
  const rel = relative(realBase, realTarget);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Username-keyed variant of `isWorkingDirAllowed` for spawn sites that only carry
 * an owner username (cron fire-time, scheduled-run loop) rather than a live request.
 * Resolves the owner's role from the store; a missing/deleted user is treated as a
 * non-privileged regular user (fails closed to their deterministic case space).
 * No-op (true) in single-user mode or for an unset owner.
 */
export async function isWorkingDirAllowedForUsername(
  username: string | undefined,
  workingDir: string
): Promise<boolean> {
  if (!isMultiUserMode() || !username) return true;
  const user = await findUser(username);
  return isWorkingDirAllowed({ username, role: user?.role ?? 'user' }, workingDir);
}

/** Whether the caller is an admin (or single-user mode, where the sole user is admin). */
export function isAdmin(req: FastifyRequest): boolean {
  return !isMultiUserMode() || getAuthUser(req).role === 'admin';
}

/**
 * First line of admin-only handlers: 403 FORBIDDEN + returns false when the caller
 * is not an admin. Always true in single-user mode (the sole user is the admin).
 */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (isAdmin(req)) return true;
  reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN));
  return false;
}

/**
 * Session-capacity check, centralized so the global cap AND the per-user cap are
 * enforced everywhere a session is created (the check was copy-pasted at 6 sites).
 * Pure: takes the sessions Map so it composes with ctx.sessions / this.sessions /
 * this.deps.sessions callers. Per-user cap only applies in multi-user mode.
 */
export function sessionCapacityState(
  sessions: ReadonlyMap<string, Session>,
  owner?: string
): { atGlobalCap: boolean; atUserCap: boolean } {
  const atGlobalCap = sessions.size >= MAX_CONCURRENT_SESSIONS;
  let atUserCap = false;
  if (isMultiUserMode() && owner) {
    let count = 0;
    for (const s of sessions.values()) if (s.owner === owner) count++;
    atUserCap = count >= maxSessionsPerUser();
  }
  return { atGlobalCap, atUserCap };
}

/**
 * Route sugar: the human-readable error message when at capacity, else null. The
 * caller wraps it in createErrorResponse with its own error code (OPERATION_FAILED
 * vs SESSION_BUSY, matching the pre-existing per-route codes).
 */
export function sessionCapacityMessage(sessions: ReadonlyMap<string, Session>, owner?: string): string | null {
  const { atGlobalCap, atUserCap } = sessionCapacityState(sessions, owner);
  if (atGlobalCap) {
    return `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached. Delete some sessions first.`;
  }
  if (atUserCap) {
    return `Your session limit (${maxSessionsPerUser()}) reached. Delete some of your sessions first.`;
  }
  return null;
}

/**
 * Revoke every cookie session belonging to a user (optionally keeping one token,
 * e.g. the caller's own during a self-service password change). Returns the count.
 */
export function revokeUserSessions(
  authSessions: StaleExpirationMap<string, AuthSessionRecord> | null,
  username: string,
  exceptToken?: string
): number {
  if (!authSessions) return 0;
  const norm = username.trim().toLowerCase();
  let removed = 0;
  for (const [token, record] of authSessions) {
    if (record.username === norm && token !== exceptToken) {
      authSessions.delete(token);
      removed++;
    }
  }
  return removed;
}

/**
 * The 404 both session-lookup helpers below throw. A missing session and one
 * the caller isn't allowed to see get the IDENTICAL error (never 403), so
 * existence of another user's session is never leaked.
 */
function sessionNotFoundError(sessionId: string): Error & { statusCode: number; body: unknown } {
  return Object.assign(new Error(`Session ${sessionId} not found`), {
    statusCode: 404,
    body: createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${sessionId} not found`),
  });
}

/**
 * Look up a session by ID or throw a structured error.
 * Replaces the pattern: `const session = sessions.get(id); if (!session) return createErrorResponse(...)`.
 *
 * When `req` is passed in multi-user mode, a session the caller does not own is
 * reported as NOT_FOUND (never 403), so existence of other users' sessions is not
 * leaked. Single-user / admin callers are unaffected.
 */
export function findSessionOrFail(ctx: SessionPort, sessionId: string, req?: FastifyRequest): Session {
  const session = ctx.sessions.get(sessionId);
  if (!session) throw sessionNotFoundError(sessionId);
  if (req && !canAccessOwned(getAuthUser(req), session.owner)) throw sessionNotFoundError(sessionId);
  return session;
}

/**
 * Like {@link findSessionOrFail}, for a session that exists ONLY in persisted
 * state — a resumed-but-never-reattached row (e.g. a non-claude "Resume" that
 * relaunched into a new session and wants to retire the row it can no longer
 * reattach to) has no live `Session` instance for `findSessionOrFail` to
 * return, so this returns the persisted record instead. Same ownership
 * enforcement, same 404-not-403 leak protection — this is that function's
 * missing other half, not a separate check reimplemented inline.
 */
export function findPersistedSessionOrFail(
  store: { getSession(id: string): SessionState | null },
  sessionId: string,
  req?: FastifyRequest
): SessionState {
  const persisted = store.getSession(sessionId);
  if (!persisted) throw sessionNotFoundError(sessionId);
  if (req && !canAccessOwned(getAuthUser(req), persisted.owner)) throw sessionNotFoundError(sessionId);
  return persisted;
}

/** Shortest prefix accepted for a parent session id (see resolveParentSessionId). */
const PARENT_SESSION_ID_MIN_PREFIX = 8;

/**
 * Resolve the "who spawned me" hint a create request may carry, for the tab lineage
 * lines in the web UI. Reads the body field first, then the `X-Codeman-Parent-Session`
 * header (the agent skill sets that once on its shared curl invocation, so every spawn
 * recipe carries it without a per-recipe edit).
 *
 * ⚠️ Decoration, and resolved rather than trusted:
 * - Returns `undefined` for anything unresolvable and NEVER throws. A stale or bogus
 *   id must not be able to fail a worker spawn over a cosmetic line.
 * - The parent must be a live session the caller can already see AND carry the same
 *   owner as the session being created, so a multi-user caller cannot staple their
 *   session under someone else's tab.
 * - Exact id match first, then a UNIQUE prefix of >= 8 chars, because ids appear
 *   truncated to 8 in mux names and in a Docker export's `$CODEMAN_SESSION_ID`.
 *   An ambiguous prefix resolves to nothing rather than to a guess.
 *
 * Returns the parent's FULL id, which is what the frontend matches tabs on.
 */
export function resolveParentSessionId(
  ctx: SessionPort,
  req: FastifyRequest,
  bodyValue: string | undefined,
  owner: string | undefined
): string | undefined {
  const header = req.headers['x-codeman-parent-session'];
  const raw = bodyValue ?? (Array.isArray(header) ? header[0] : header);
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  // The body field is schema-capped; the header is not, so cap it here too.
  if (!candidate || candidate.length > 100) return undefined;

  let parent = ctx.sessions.get(candidate);
  if (!parent && candidate.length >= PARENT_SESSION_ID_MIN_PREFIX) {
    for (const session of ctx.sessions.values()) {
      if (!session.id.startsWith(candidate)) continue;
      if (parent) return undefined; // ambiguous prefix — resolve to nothing, never a guess
      parent = session;
    }
  }
  if (!parent) return undefined;

  if (!canAccessOwned(getAuthUser(req), parent.owner)) return undefined;
  if ((parent.owner ?? undefined) !== (owner ?? undefined)) return undefined;
  return parent.id;
}

/**
 * Resolve "an agent asked for this", the signal that labels a case directory
 * Codeman is about to CREATE as an agent scratch workspace (see agent-case-marker.ts).
 *
 * Two signals, in order:
 * 1. an explicit `agentOrigin` body field, or the `X-Codeman-Agent-Origin` header the
 *    packaged skill sets once on its shared curl invocation, so every spawn recipe
 *    carries it without a per-recipe edit. The body wins, mirroring parentSessionId;
 * 2. failing that, an already-RESOLVED parent session id. A create request that names
 *    the session that spawned it came from an agent by construction: nothing in the
 *    browser UI sets lineage. This is what still labels workers spawned by a stale
 *    skill copy or by hand-rolled curl that only carries the lineage header.
 *
 * ⚠️ Decoration, like parentSessionId: never an ownership or permission signal, and
 * never a reason to fail a spawn. An unrecognised origin token is dropped by
 * `normalizeAgentOrigin` rather than rejected.
 */
export function resolveAgentCaseOrigin(
  req: FastifyRequest,
  bodyValue: string | undefined,
  resolvedParentSessionId: string | undefined
): string | undefined {
  const header = req.headers['x-codeman-agent-origin'];
  const raw = bodyValue ?? (Array.isArray(header) ? header[0] : header);
  return normalizeAgentOrigin(raw) ?? (resolvedParentSessionId ? AGENT_ORIGIN_SPAWNED_BY_SESSION : undefined);
}

/**
 * Parse and validate a request body against a Zod schema, or throw a structured 400 error.
 * Replaces the repeated pattern: `const r = Schema.safeParse(body); if (!r.success) return createErrorResponse(...)`.
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, errorMessage?: string): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const msg = errorMessage ?? result.error.issues[0]?.message ?? 'Validation failed';
    throw Object.assign(new Error(msg), {
      statusCode: 400,
      body: createErrorResponse(ApiErrorCode.INVALID_INPUT, msg),
    });
  }
  return result.data;
}

/**
 * Whether an input body is a plain prompt: printable text followed by exactly one
 * carriage return, and nothing else.
 *
 * That is the shape a script, a bot or a curl call sends to submit a prompt, and the
 * one that must NOT be written into the pane in one piece. Measured on Claude Code
 * 2.1.283 (2026-09-28): a direct write of `<text>\r` arrives as a single burst, and a
 * burst of about a hundred characters or more is taken as a paste, so its trailing
 * `\r` lands as a NEWLINE in the composer and the prompt sits there unsent. A later
 * bare `\r` written the same way does not recover it; a tmux `send-keys Enter` does.
 * Short bursts (tens of characters) submit, which is why the failure looked random.
 *
 * Anything with another control character (escape sequences, a bracketed-paste frame,
 * a line feed, a tab, C1 controls) is raw terminal input and keeps the direct write.
 */
export function isPlainPromptInput(input: string): boolean {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return /^[^\x00-\x1f\x7f-\x9f]+\r$/.test(input);
}

/**
 * Persist session state and broadcast a SessionUpdated event.
 * Replaces the repeated two-line pattern across route handlers.
 */
export function persistAndBroadcastSession(ctx: SessionPort & EventPort, session: Session): void {
  ctx.persistSessionState(session);
  ctx.broadcast(SseEvent.SessionUpdated, ctx.getSessionStateWithRespawn(session));
}

/**
 * Formats uptime in seconds to a human-readable string (e.g., "1d 2h 30m 15s").
 */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Sanitizes hook event data before broadcasting via SSE.
 * Extracts only relevant fields and limits total size to prevent
 * oversized payloads from being broadcast to all connected clients.
 */
export function sanitizeHookData(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};

  // Only forward known safe fields from Claude Code hook stdin
  const safeFields: Record<string, unknown> = {};
  const allowedKeys = [
    'hook_event_name',
    'tool_name',
    'tool_input',
    'session_id',
    'cwd',
    'permission_mode',
    'stop_hook_active',
    'transcript_path',
    'message',
    // UserPromptSubmit identity fields. `prompt` is deliberately NOT here: the
    // prompt text would land in the SSE broadcast, and Read My Mind already
    // captures intent through transcript-watcher.
    'prompt_id',
    'source',
  ];

  for (const key of allowedKeys) {
    if (key in data && data[key] !== undefined) {
      safeFields[key] = data[key];
    }
  }

  // Notification hooks carry the human-readable prompt text in `message`
  // ("Claude needs your permission to use Bash"). Bound it like the
  // tool_input summaries; the frontend and the Approvals Inbox both read it.
  if (typeof safeFields.message === 'string') {
    safeFields.message = safeFields.message.slice(0, 500);
  } else if ('message' in safeFields) {
    delete safeFields.message;
  }

  // For tool_input, extract only summary fields (not full file content)
  if (safeFields.tool_input && typeof safeFields.tool_input === 'object') {
    const input = safeFields.tool_input as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    if (input.command) summary.command = String(input.command).slice(0, 500);
    if (input.file_path) summary.file_path = String(input.file_path).slice(0, 500);
    if (input.description) summary.description = String(input.description).slice(0, 200);
    if (input.query) summary.query = String(input.query).slice(0, 200);
    if (input.url) summary.url = String(input.url).slice(0, 500);
    if (input.pattern) summary.pattern = String(input.pattern).slice(0, 200);
    if (input.prompt) summary.prompt = String(input.prompt).slice(0, 200);
    safeFields.tool_input = summary;
  }

  // Final size check - drop if serialized data exceeds limit
  const serialized = JSON.stringify(safeFields);
  if (serialized.length > MAX_HOOK_DATA_SIZE) {
    return { tool_name: safeFields.tool_name, _truncated: true };
  }

  return safeFields;
}

/**
 * Toggles a service (watcher/manager) on or off based on an enabled flag.
 * Logs start/stop to console with the given label. Runs an optional callback after starting.
 */
export function toggleService(
  enabled: boolean,
  service: { isRunning(): boolean; start(): void; stop(): void },
  label: string,
  onStart?: () => void
): void {
  if (enabled && !service.isRunning()) {
    service.start();
    onStart?.();
    console.log(`${label} started via settings change`);
  } else if (!enabled && service.isRunning()) {
    service.stop();
    console.log(`${label} stopped via settings change`);
  }
}

/**
 * Auto-configure Ralph tracker for a session.
 *
 * Priority order:
 * 1. .claude/ralph-loop.local.md (official Ralph Wiggum plugin state)
 * 2. CLAUDE.md <promise> tags (fallback)
 *
 * The ralph-loop.local.md file has priority because it contains
 * the exact configuration from an active Ralph loop session.
 */
export function autoConfigureRalph(session: Session, workingDir: string, ctx: EventPort): void {
  // First, try to read the official Ralph Wiggum plugin state file
  const ralphConfig = parseRalphLoopConfig(workingDir);

  if (ralphConfig && ralphConfig.completionPromise) {
    session.ralphTracker.enable();
    session.ralphTracker.startLoop(ralphConfig.completionPromise, ralphConfig.maxIterations ?? undefined);

    // Restore iteration count if available
    if (ralphConfig.iteration > 0) {
      // The tracker's cycleCount will be updated when we detect iteration patterns
      // in the terminal output, but we can set maxIterations now
      console.log(`[auto-detect] Ralph loop at iteration ${ralphConfig.iteration}/${ralphConfig.maxIterations ?? '∞'}`);
    }

    console.log(
      `[auto-detect] Configured Ralph loop for session ${session.id} from ralph-loop.local.md: ${ralphConfig.completionPromise}`
    );
    ctx.broadcast(SseEvent.SessionRalphLoopUpdate, {
      sessionId: session.id,
      state: session.ralphTracker.loopState,
    });
    return;
  }

  // Fallback: try CLAUDE.md
  const claudeMdPath = join(workingDir, 'CLAUDE.md');
  const completionPhrase = extractCompletionPhrase(claudeMdPath);

  if (completionPhrase) {
    session.ralphTracker.enable();
    session.ralphTracker.startLoop(completionPhrase);
    console.log(`[auto-detect] Configured Ralph loop for session ${session.id} from CLAUDE.md: ${completionPhrase}`);
    ctx.broadcast(SseEvent.SessionRalphLoopUpdate, {
      sessionId: session.id,
      state: session.ralphTracker.loopState,
    });
  }
}
