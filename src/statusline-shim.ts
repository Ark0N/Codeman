/**
 * @fileoverview The plan-usage statusLine exporter, as a delegating shim.
 *
 * ## Why this exists
 *
 * Claude Code hands its statusLine command a JSON blob on stdin before every
 * render, and on a subscription that blob is the ONLY place `rate_limits`
 * surfaces. No hook event carries plan usage. So Codeman takes the statusLine
 * slot purely as a data tap for the header "Plan Usage Limits" chip.
 *
 * Taking that slot has a cost the original inline exporter did not pay back.
 * Claude Code ranks a repo's `.claude/settings.local.json` above the user's
 * `~/.claude/settings.json`, so writing a statusLine into a managed repo
 * SHADOWS whatever statusline the user configured globally. The inline exporter
 * then printed Codeman's own footer in its place, and a user who ran `claude`
 * by hand in a managed repo saw the bare word `codeman` — the response this
 * instance returns for a session id it does not know.
 *
 * This shim keeps the data tap and gives the line back. It forwards the blob
 * exactly as before, resolves the statusline it is shadowing, runs that command
 * with the same blob on stdin, and prints its output. Codeman's own footer
 * still appears when there is nothing to shadow, so the exporter remains useful
 * on a machine with no statusline of its own and stops being a thief on one
 * that has it.
 *
 * ## How the delegate is resolved
 *
 * At RENDER time, not at injection time. The shim walks the settings files
 * Claude Code would consult, nearest first, and takes the first `statusLine`
 * that is not one of ours. Resolving late means a user who edits their global
 * statusline sees the change immediately, with no reinjection and no stale
 * command baked into a config file.
 *
 * ## Why it is generated rather than committed
 *
 * Same reasoning as `deepseek-status-shim`: the shim must be a file at a stable
 * absolute path in a git clone, in an `npm i -g aicodeman` install where only
 * `dist` ships, and under any `CODEMAN_INSTANCE`. Writing it into the data dir
 * covers all three from one code path and single-sources the content here.
 *
 * @module statusline-shim
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from './config/instance.js';

/**
 * Bumped whenever SHIM_SOURCE changes, and embedded in the generated file so
 * `ensureStatusLineShim()` can tell a current shim from one an older Codeman
 * wrote. Without it an upgraded Codeman would either rewrite on every session
 * create or leave a stale shim in place forever.
 */
const SHIM_VERSION = 1;
const SHIM_MARKER = `codeman-statusline-shim v${SHIM_VERSION}`;

/**
 * Version-agnostic ownership token, and the shim's own loop guard.
 *
 * It appears in the generated file's NAME, so it is a substring of the injected
 * command for every shim version. Two separate decisions key on that:
 * `applyStatusLineConfig` uses it to recognise a statusLine as Codeman's, and
 * the shim itself uses it to skip its own entry while hunting for a delegate.
 * Deciding ownership on the version-free token means bumping SHIM_VERSION can
 * never disown every previously injected command.
 */
export const STATUSLINE_SHIM_TOKEN = 'codeman-statusline-shim';

/**
 * The pre-shim inline exporter's ownership marker, kept only for recognition.
 *
 * Codeman injected a bare `curl` carrying this path before the shim existed.
 * Those commands are still sitting in every repo a previous version managed, so
 * `applyStatusLineConfig` must still read them as OURS — otherwise the upgrade
 * mistakes them for a hand-authored line, refuses to touch them, and the user
 * keeps the shadowing exporter forever.
 */
export const LEGACY_STATUSLINE_MARKER = '/api/status-telemetry';

/**
 * The route the shim reports to. Identical in text to the legacy marker above,
 * and separate from it on purpose: one names an endpoint this code calls, the
 * other names a string an old config is recognised by. Changing the route must
 * not silently change what counts as an old config.
 */
const STATUS_TELEMETRY_PATH = '/api/status-telemetry';

/** Wrap a path for safe use inside a single-quoted shell word. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The generated shim.
 *
 * Three behaviours are worth reading closely, because each one exists to avoid
 * a specific failure the inline exporter had or would have had:
 *
 * - **The delegate runs concurrently with the POST.** This command executes on
 *   every assistant message, so its latency lands in the user's prompt. Running
 *   both at once costs the slower of the two rather than their sum.
 * - **A failing delegate never blanks the line.** Empty output, a non-zero
 *   exit, or a timeout all fall through to Codeman's footer, then to a brand
 *   string. A statusline that renders nothing looks like a broken terminal.
 * - **Both timeouts are short and independent.** An unreachable Codeman must
 *   not delay a prompt by more than its own budget, and a hung delegate must
 *   not hold the render open indefinitely.
 */
const SHIM_SOURCE = `#!/usr/bin/env node
// ${SHIM_MARKER}
// GENERATED BY CODEMAN — do not edit. Rewritten from src/statusline-shim.ts
// whenever its version marker changes.
//
// Forwards Claude Code's statusline JSON to this Codeman instance (the only
// source of plan rate-limit numbers) and then prints the statusline this entry
// shadows, so taking the slot costs the user nothing.
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import http from 'node:http'
import https from 'node:https'

const SHIM_TOKEN = ${JSON.stringify(STATUSLINE_SHIM_TOKEN)}
const LEGACY_MARKER = ${JSON.stringify(LEGACY_STATUSLINE_MARKER)}
const POST_TIMEOUT_MS = 1500
const DELEGATE_TIMEOUT_MS = 4000

let input = ''
try {
  input = readFileSync(0, 'utf-8')
} catch {
  // No stdin (a TTY, or a closed pipe) — the delegate still deserves a run.
}
if (!input.trim()) input = '{}'

let parsed = {}
try {
  parsed = JSON.parse(input)
} catch {
  // Malformed payload: still forward it verbatim and still run the delegate.
  // Codeman's parser is defensive and the delegate may not need the JSON.
}

// Claude Code reports the render's directory here. Fall back to the process cwd,
// which is the same directory in every shape we have seen.
const cwd =
  (typeof parsed.cwd === 'string' && parsed.cwd) ||
  (parsed.workspace && typeof parsed.workspace.current_dir === 'string' && parsed.workspace.current_dir) ||
  process.cwd()

/**
 * Settings files Claude Code consults, nearest first.
 *
 * Walking UP from the render directory matters: Claude Code applies a project's
 * settings from the workspace root, which is often an ancestor of the directory
 * a session actually sits in. The home files come last, matching the precedence
 * that makes a project entry win over a global one.
 */
function settingsCandidates() {
  const out = []
  let dir = cwd
  for (;;) {
    out.push(join(dir, '.claude', 'settings.local.json'))
    out.push(join(dir, '.claude', 'settings.json'))
    const parent = dirname(dir)
    if (!parent || parent === dir) break
    dir = parent
  }
  const home = homedir()
  out.push(join(home, '.claude', 'settings.local.json'))
  out.push(join(home, '.claude', 'settings.json'))
  return [...new Set(out)]
}

/** The first statusLine command that is not one of ours, or null. */
function resolveDelegate() {
  for (const file of settingsCandidates()) {
    if (!existsSync(file)) continue
    let settings
    try {
      settings = JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      continue // Malformed file: Claude Code would ignore it too.
    }
    const line = settings && settings.statusLine
    if (!line || typeof line !== 'object') continue
    if (line.type && line.type !== 'command') continue
    const command = line.command
    if (typeof command !== 'string' || !command.trim()) continue
    // Our own entry, in either the shim form or the pre-shim inline form.
    // Delegating to either one would recurse or double-report.
    if (command.includes(SHIM_TOKEN) || command.includes(LEGACY_MARKER)) continue
    return command
  }
  return null
}

/** Run the shadowed statusline with the same JSON on stdin. Never rejects. */
function runDelegate(command) {
  return new Promise((resolve) => {
    // bash when it exists: a user's statusline may well use bashisms, and
    // /bin/sh is dash on Debian-family systems.
    const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
    let child
    try {
      child = spawn(shell, ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      return resolve(null)
    }
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(out.trim() ? out : null) // partial output beats no output
    }, DELEGATE_TIMEOUT_MS)
    timer.unref?.()
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // A non-zero exit that still printed something is worth showing: plenty
      // of statusline scripts end on the exit code of their last command.
      const usable = out.trim().length > 0 || code === 0
      finish(usable ? out : null)
    })
    child.stdin.on('error', () => {}) // a delegate that ignores stdin closes it early
    child.stdin.end(input)
  })
}

/** POST the blob to Codeman. Resolves to the response body, or null. */
function postTelemetry() {
  return new Promise((resolve) => {
    const sessionId = process.env.CODEMAN_SESSION_ID
    const apiUrl = process.env.CODEMAN_API_URL
    // Outside a managed session there is no session to report against, so the
    // shim costs nothing beyond running the delegate.
    if (!sessionId || !apiUrl) return resolve(null)

    let secret = ''
    try {
      secret = readFileSync(process.env.CODEMAN_HOOK_SECRET_FILE || '', 'utf-8').trim()
    } catch {
      // Missing file: the loopback bypass still applies when no tunnel runs.
    }

    let url
    try {
      url = new URL(${JSON.stringify(STATUS_TELEMETRY_PATH)}, apiUrl)
    } catch {
      return resolve(null)
    }

    const body = JSON.stringify({ sessionId, data: parsed })
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        timeout: POST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Codeman-Hook-Secret': secret,
        },
        // Loopback HTTPS with a self-signed cert (--https / tailscale installs).
        rejectUnauthorized: false,
      },
      (res) => {
        let text = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300 ? text : null))
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
    req.end(body)
  })
}

const delegateCommand = resolveDelegate()
const [delegateOut, telemetryOut] = await Promise.all([
  delegateCommand ? runDelegate(delegateCommand) : Promise.resolve(null),
  postTelemetry(),
])

// The shadowed line wins. Codeman's footer fills in only when there is no line
// to shadow or the delegate produced nothing, and the brand string is the last
// resort — a blank statusline reads as a broken terminal.
const rendered = (delegateOut && delegateOut.trim() && delegateOut) || telemetryOut || 'codeman'
process.stdout.write(rendered.replace(/\\n$/, ''))
`;

/** Absolute path of the generated shim for this instance. */
export function statusLineShimPath(): string {
  return dataPath(`${STATUSLINE_SHIM_TOKEN}.mjs`);
}

let ensuredThisProcess = false;

/**
 * Write the shim if it is missing or stale, and return its path.
 *
 * Idempotent and cheap: after the first call in a process it does nothing, and
 * even the first call rewrites only when the on-disk marker differs. Never
 * throws. A data dir that cannot be written is a degraded exporter, not a
 * failed session start, so the caller receives null and falls back to the
 * inline command.
 */
export function ensureStatusLineShim(): string | null {
  const path = statusLineShimPath();
  if (ensuredThisProcess) return path;
  try {
    let current = '';
    try {
      current = readFileSync(path, 'utf-8');
    } catch {
      // Missing — fall through to the write.
    }
    if (!current.includes(SHIM_MARKER)) {
      mkdirSync(dirname(path), { recursive: true });
      // Temp + rename, same reasoning as the DeepSeek shim: a live session can
      // be executing this exact path at the moment an upgraded Codeman
      // refreshes it, and a reader that catches a half-written file gets a
      // syntax error and a blank statusline. rename(2) is atomic within the
      // directory. Pid-suffixed so two instances sharing a data dir cannot
      // collide on the temp name.
      const tempPath = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(tempPath, SHIM_SOURCE, { mode: 0o700 });
        // The mode argument applies only when writeFileSync CREATES the file,
        // so a leftover temp from a crashed run would keep its old permissions.
        chmodSync(tempPath, 0o700);
        renameSync(tempPath, path);
      } catch (err) {
        rmSync(tempPath, { force: true });
        throw err;
      }
    }
    // Re-assert the mode even when the content matched: a shim that lost its
    // executable bit (a restored backup, a copied data dir) would fail on every
    // render, and the user would see the fallback string instead of their line.
    chmodSync(path, 0o700);
    ensuredThisProcess = true;
    return path;
  } catch (err) {
    console.warn(`[statusline] Could not install the shim at ${path}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * The statusLine command Codeman injects.
 *
 * `process.execPath` rather than a bare `node`: Codeman is itself running on
 * that binary, so it is known to exist, and a managed session's PATH need not
 * carry node at all. The absolute path is also self-healing, because a node
 * that moves changes this string, and the next session create rewrites the
 * config to match.
 *
 * Returns null when the shim could not be installed, leaving the caller to
 * decide the fallback.
 */
export function generateShimStatusLineCommand(): string | null {
  const shim = ensureStatusLineShim();
  if (!shim) return null;
  return `${shQuote(process.execPath)} ${shQuote(shim)}`;
}

/** Test seam: forget the per-process memo so a fresh temp data dir is provisioned. */
export function resetStatusLineShimForTest(): void {
  ensuredThisProcess = false;
}
