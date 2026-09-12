/**
 * @fileoverview Resolve the real OMP session id for a working directory, so a
 * relaunch can pass `--resume <id>` instead of the ambiguous `--continue`.
 *
 * `omp` persists each conversation as its own file under
 * `~/.omp/agent/sessions/<mangled-workingDir>/<ISO-timestamp>_<session-uuid>.jsonl`
 * (workingDir mangled the same way Claude Code mangles `~/.claude/projects/*`:
 * every `/` replaced with `-`). `--continue` picks whichever file in that
 * directory is newest, which silently drifts to the WRONG conversation the
 * moment two Codeman sessions ever touch the same directory — exactly what a
 * closed-then-resumed row plus a still-running duplicate produces. Resolving
 * the id once and pinning it with `--resume` removes that ambiguity for every
 * later relaunch of the same Codeman session.
 *
 * @module utils/omp-session-resolver
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/** A real OMP session file is `<ISO-ish-timestamp>_<uuid>.jsonl`; only the uuid matters here. */
const OMP_SESSION_FILE_PATTERN = /^.+_([a-zA-Z0-9-]+)\.jsonl$/;

/**
 * Strip a trailing `/` from a workingDir unless it is the root itself.
 *
 * Case paths routinely end in `/` — a remote case's `remotePath` is stored
 * verbatim (e.g. `/home/user/dotfiles/`) — but omp persists sessions under
 * the slash-less mangle (`-dotfiles`) with a header `cwd` of
 * `/home/user/dotfiles`. Without normalization, the trailing slash survives
 * the mangle (`-dotfiles-`), `readdirSync` returns null for a directory that
 * exists, and OMP respawn pinning silently degrades to the ambiguous
 * `--continue` (found live 2026-08-29: a remote OMP ctrl-c relaunched a fresh
 * conversation instead of resuming). Exported so the same normalization is
 * used for the header-`cwd` comparison in {@link resolveAndClaimOmpSessionId}.
 */
export function stripTrailingSlash(workingDir: string): string {
  return workingDir.length > 1 && workingDir.endsWith('/') ? workingDir.slice(0, -1) : workingDir;
}

/**
 * Mirrors `omp`'s own directory mangling. Confirmed empirically against real
 * `~/.omp/agent/sessions/` directory names (2026-08-27): unlike Claude Code's
 * `~/.claude/projects/*`, which keeps the home prefix (`-home-user-dev-foo`),
 * omp collapses a home-relative workingDir to its home-relative remainder
 * FIRST (`/home/user/dev/foo` -> `/dev/foo`) and only then dash-replaces
 * (`-dev-foo`) — a path outside $HOME (e.g. `/tmp/...`) is dash-replaced as-is.
 * Getting this wrong doesn't error, it just silently returns an empty
 * directory listing: findLatestOmpSessionId() below then always falls through
 * to null, so continuation pinning quietly degrades to omp's own ambiguous
 * `--continue` for every case under $HOME (i.e. virtually all real Codeman
 * cases) while appearing to work in `/tmp`-based manual testing.
 * Pure so it's unit-testable without touching the filesystem.
 */
export function mangleOmpWorkingDir(workingDir: string): string {
  // UNVERIFIED EDGE CASE: if $HOME is itself a symlink, this compares against
  // the literal homedir() string, not a realpath()-resolved one. Whether that
  // matches omp's own behavior is unconfirmed — we only empirically verified
  // omp strips a literal $HOME prefix (2026-08-27), not that it canonicalizes
  // symlinks first. Do not "fix" this with realpathSync() without confirming
  // omp's actual behavior on a symlinked-home setup; guessing wrong here would
  // trade one silent mismatch for a different one.
  const home = homedir();
  const normalized = stripTrailingSlash(workingDir);
  const relative =
    normalized === home || normalized.startsWith(home + sep) ? normalized.slice(home.length) : normalized;
  return relative.replace(/\//g, '-');
}

/**
 * `~/.omp` — omp's own env overrides are mostly `PI_*` (shared with pi mode, already
 * allowlisted in schemas.ts), and `PI_CONFIG_DIR` in particular can move this root.
 * That is not honored here: a session with a redirected `PI_CONFIG_DIR` silently
 * degrades pinning/history to omp's own ambiguous `--continue` instead of erroring,
 * a known gap (found in Ark0N/Codeman#353 review) shared with pi and not fixed here.
 */
function resolveOmpHome(): string {
  return join(homedir(), '.omp');
}

/**
 * Newest OMP session id for this working directory, or null when the
 * directory doesn't exist yet (never launched) or holds no session files.
 *
 * Deliberately "newest file, full stop" rather than a time-windowed match:
 * callers only invoke this at a moment where that's unambiguous by
 * construction — right after the file that answers it was the only thing
 * that could have just been written (a dead pane's process already exited,
 * or a session being resumed has no live sibling in the same directory yet).
 */
export function findLatestOmpSessionId(workingDir: string): string | null {
  const dir = join(resolveOmpHome(), 'agent', 'sessions', mangleOmpWorkingDir(workingDir));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  let newestMtime = -Infinity;
  let newestId: string | null = null;
  for (const entry of entries) {
    const match = OMP_SESSION_FILE_PATTERN.exec(entry);
    if (!match) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(dir, entry)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > newestMtime) {
      newestMtime = mtimeMs;
      newestId = match[1];
    }
  }
  return newestId;
}

/**
 * The session header line is always near the top of the file (the
 * transcript's own "second line" — see omp-transcript.ts), so identifying a
 * file never needs reading the whole thing (up to multi-MB, per that same
 * module's size cap). Bounded read only.
 */
const HEADER_READ_BYTES = 8 * 1024;

function readOmpSessionHeader(filePath: string): { id: string; cwd: string } | null {
  let raw: string;
  try {
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(HEADER_READ_BYTES);
      const bytesRead = readSync(fd, buf, 0, HEADER_READ_BYTES, 0);
      raw = buf.toString('utf-8', 0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.type === 'session' && typeof e.id === 'string' && typeof e.cwd === 'string') {
      return { id: e.id, cwd: e.cwd };
    }
  }
  return null;
}

/**
 * Process-wide registry of OMP session ids already pinned to a live Codeman
 * session. Two omp tabs in the same case dir (`w1-foo`, `w2-foo`) resolve
 * against the SAME directory on disk — without this, both could pick the
 * newest file and alias onto each other's conversation (found in upstream PR
 * review, Ark0N/Codeman#353). Never released: this holds at most a handful of
 * short ids per real omp conversation ever pinned in this process's lifetime,
 * immaterial memory even after weeks of uptime — correctness here matters
 * more than reclaiming it.
 */
const claimedOmpSessionIds = new Set<string>();

/**
 * Safe variant of {@link findLatestOmpSessionId} for callers where two omp
 * sessions CAN share the same case directory — a dead-pane respawn, a
 * boot-recovery reattach, or a first-idle capture — instead of the narrower
 * cases where "newest file" is unambiguous by construction. Verifies each
 * candidate's own header `cwd` against `workingDir` (mangling is a lossy
 * one-way transform — see {@link mangleOmpWorkingDir} — so trusting the
 * filename-derived id alone isn't enough) and skips any id a sibling session
 * has already claimed. Claims the id it returns so a concurrent caller
 * resolving the same directory in the same tick can't double-claim it.
 */
export function resolveAndClaimOmpSessionId(workingDir: string): string | null {
  const dir = join(resolveOmpHome(), 'agent', 'sessions', mangleOmpWorkingDir(workingDir));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  let newestMtime = -Infinity;
  let newestId: string | null = null;
  for (const entry of entries) {
    if (!OMP_SESSION_FILE_PATTERN.test(entry)) continue;
    const filePath = join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs <= newestMtime) continue;
    const header = readOmpSessionHeader(filePath);
    // Compare against the slash-normalized workingDir: the session's own
    // workingDir may carry a trailing slash while omp's header cwd never does.
    if (!header || header.cwd !== stripTrailingSlash(workingDir) || claimedOmpSessionIds.has(header.id)) continue;
    newestMtime = mtimeMs;
    newestId = header.id;
  }
  if (newestId) claimedOmpSessionIds.add(newestId);
  return newestId;
}
