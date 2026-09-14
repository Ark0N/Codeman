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
 * by hand in a managed repo saw the bare word `codeman` (discussion #405: seven
 * repositories before the cause was found).
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
 * At RENDER time, not at injection time, from exactly the three files Claude
 * Code documents for a project: `.claude/settings.local.json` and
 * `.claude/settings.json` under the directory Claude Code was launched in
 * (`workspace.project_dir` in the blob), then `~/.claude/settings.json`. The
 * first `statusLine` that is not one of ours wins. Resolving late means a user
 * who edits their global statusline sees the change immediately, with no
 * reinjection and no stale command baked into a config file.
 *
 * Two candidates are deliberately NOT consulted, because delegating to a
 * command Claude Code itself would have ignored is exactly the failure this
 * shim exists to end: a user-level `~/.claude/settings.local.json` (not in the
 * documented set), and the project files of any ANCESTOR of the launch
 * directory (Claude Code reads project settings from the launch directory
 * alone, and a walk upward can land on a `.claude` that is not a project root).
 *
 * ## Why the injected command is shell that MAY run the shim
 *
 * The shim is a file at an absolute path under this instance's data dir, run
 * by the node binary Codeman itself runs on. Neither exists on the other side of
 * a Docker case's bind mount: the workspace (and its `settings.local.json`) is
 * mounted at the same absolute path inside the container, but `~/.codeman` and
 * the host's node are not. So the injected command is a self-selecting guard:
 * run the shim when both paths resolve, else fall through to the inline curl
 * exporter, which is env vars plus curl and works wherever the hooks do. The
 * SAME file therefore renders correctly from the host and from inside the
 * container, and the inline form is also what a wiped data dir degrades to.
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
 * `isCodemanStatusLine()` in hooks-config uses it to recognise a statusLine as
 * Codeman's, and the shim itself uses it to skip its own entry while hunting
 * for a delegate. Deciding ownership on the version-free token means bumping
 * SHIM_VERSION can never disown every previously injected command.
 */
export const STATUSLINE_SHIM_TOKEN = 'codeman-statusline-shim';

/**
 * The inline exporter's ownership marker: the route it posts to.
 *
 * Every command Codeman has ever injected carries this path, the pre-shim
 * inline `curl` and the fallback half of the current guarded command alike, so
 * `isCodemanStatusLine()` must keep reading it as OURS. Drop it and every repo
 * an older Codeman managed reads as hand-authored: the upgrade refuses to touch
 * it and the user keeps the shadowing exporter forever.
 */
export const LEGACY_STATUSLINE_MARKER = '/api/status-telemetry';

/**
 * The route the shim reports to. Identical in text to the legacy marker above,
 * and separate from it on purpose: one names an endpoint this code calls, the
 * other names a string an old config is recognised by. Changing the route must
 * not silently change what counts as an old config.
 */
const STATUS_TELEMETRY_PATH = '/api/status-telemetry';

/**
 * What a pre-1.28 server answers for a session it does not know. The current
 * route answers an empty body, but a shim written by a newer Codeman can be
 * talking to an older one (two instances sharing a repo), and this exact word
 * rendered as a statusline is the symptom the whole change exists to remove,
 * so the shim treats it as "no telemetry" rather than printing it.
 */
const NO_TELEMETRY_WORD = 'codeman';

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
 * - **A failing delegate falls through, never blanks by accident.** Empty
 *   output, a non-zero exit, or a timeout all fall through to Codeman's footer.
 *   With no footer either the shim prints nothing at all, which is what a user
 *   with no statusline of their own gets from Claude Code anyway: the one thing
 *   it never prints is a brand word that reads as a broken config.
 * - **Both timeouts are short and independent.** An unreachable Codeman must
 *   not delay a prompt by more than its own budget, and a hung delegate must
 *   not hold the render open indefinitely.
 */
const SHIM_SOURCE = `#!/usr/bin/env node
// ${SHIM_MARKER}
// GENERATED BY CODEMAN. Do not edit: rewritten from src/statusline-shim.ts
// whenever its version marker changes.
//
// Forwards Claude Code's statusline JSON to this Codeman instance (the only
// source of plan rate-limit numbers) and then prints the statusline this entry
// shadows, so taking the slot costs the user nothing.
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
// The HTTP transport is imported lazily, inside postTelemetry(): node:http
// costs ~38 ms to load on a fast Linux box (measured, versus ~4 ms for
// node:https alone), and this file runs on every assistant message. Loading
// only the transport the URL needs, and none outside a managed session, is
// most of the difference between an 80 ms render and a 110 ms one.

const SHIM_TOKEN = ${JSON.stringify(STATUSLINE_SHIM_TOKEN)}
const LEGACY_MARKER = ${JSON.stringify(LEGACY_STATUSLINE_MARKER)}
const NO_TELEMETRY_WORD = ${JSON.stringify(NO_TELEMETRY_WORD)}
const POST_TIMEOUT_MS = 1500
const DELEGATE_TIMEOUT_MS = 4000

let input = ''
try {
  input = readFileSync(0, 'utf-8')
} catch {
  // No stdin (a TTY, or a closed pipe): the delegate still deserves a run.
}
if (!input.trim()) input = '{}'

let parsed = {}
try {
  parsed = JSON.parse(input)
} catch {
  // Malformed payload: still forward it verbatim and still run the delegate.
  // Codeman's parser is defensive and the delegate may not need the JSON.
}
if (!parsed || typeof parsed !== 'object') parsed = {}

const str = (value) => (typeof value === 'string' && value ? value : '')
const workspace = parsed.workspace && typeof parsed.workspace === 'object' ? parsed.workspace : {}

// Claude Code reads a project's settings from the directory it was LAUNCHED in,
// which the blob reports as workspace.project_dir; current_dir/cwd can drift
// from it when the working directory changes mid-session. The process cwd is
// the last resort for a blob that carries neither.
const projectDir = str(workspace.project_dir) || str(workspace.current_dir) || str(parsed.cwd) || process.cwd()

/**
 * The settings files Claude Code consults for this render, highest precedence
 * first: the documented set is exactly these three. No ancestor of the launch
 * directory and no user-level settings.local.json: Claude Code reads neither,
 * and delegating to a command it would have ignored is the failure this shim
 * exists to end.
 */
function settingsCandidates() {
  return [
    join(projectDir, '.claude', 'settings.local.json'),
    join(projectDir, '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.json'),
  ]
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
    // Our own entry, in the guarded shim form or the pre-shim inline form.
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

/** POST the blob to Codeman. Resolves to the footer it answered, or null. */
async function postTelemetry() {
  const sessionId = process.env.CODEMAN_SESSION_ID
  const apiUrl = process.env.CODEMAN_API_URL
  // Outside a managed session there is no session to report against, so the
  // shim costs nothing beyond running the delegate.
  if (!sessionId || !apiUrl) return null

  let url
  try {
    url = new URL(${JSON.stringify(STATUS_TELEMETRY_PATH)}, apiUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  let secret = ''
  try {
    secret = readFileSync(process.env.CODEMAN_HOOK_SECRET_FILE || '', 'utf-8').trim()
  } catch {
    // Missing file: the loopback bypass still applies when no tunnel runs.
  }

  const { default: transport } = await import(url.protocol === 'https:' ? 'node:https' : 'node:http')
  const body = JSON.stringify({ sessionId, data: parsed })
  return new Promise((resolve) => {
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
// to shadow or the delegate produced nothing. With neither, print NOTHING: a
// blank statusline is what Claude Code shows a user with no statusline of
// their own, while the bare brand word is the symptom this shim exists to end.
const own = delegateOut && delegateOut.trim() ? delegateOut : ''
const footer = telemetryOut && telemetryOut.trim() && telemetryOut.trim() !== NO_TELEMETRY_WORD ? telemetryOut : ''
const rendered = own || footer
if (rendered) process.stdout.write(rendered.replace(/\\n$/, ''))
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
 * failed session start, so the caller receives null and injects the inline
 * command alone.
 */
export function ensureStatusLineShim(): string | null {
  const path = statusLineShimPath();
  if (ensuredThisProcess) return path;
  try {
    let current = '';
    try {
      current = readFileSync(path, 'utf-8');
    } catch {
      // Missing: fall through to the write.
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
 * The shell guard that runs the shim where it exists, for `generateStatusLineCommand()`
 * in hooks-config to prepend to the inline exporter.
 *
 * `if [ -x <node> ] && [ -f <shim> ]; then exec <node> <shim>; fi;`: both
 * tests fail inside a Docker case's container (see the fileoverview), on a
 * host whose data dir was wiped, and after the node Codeman ran on moves, so
 * the inline exporter after it is what renders there. `process.execPath`
 * rather than a bare `node`: Codeman is itself running on that binary, so it
 * is known to exist, and a managed session's PATH need not carry node at all.
 * The absolute path is also self-healing, because a node that moves changes
 * this string, and the next session create rewrites the config to match.
 *
 * Returns null when the shim could not be installed, in which case the caller
 * injects the inline exporter alone.
 */
export function statusLineShimGuard(): string | null {
  const shim = ensureStatusLineShim();
  if (!shim) return null;
  const node = shQuote(process.execPath);
  const file = shQuote(shim);
  return `if [ -x ${node} ] && [ -f ${file} ]; then exec ${node} ${file}; fi;`;
}

/** Test seam: forget the per-process memo so a fresh temp data dir is provisioned. */
export function resetStatusLineShimForTest(): void {
  ensuredThisProcess = false;
}
