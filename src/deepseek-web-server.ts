/**
 * @fileoverview Supervises the one background `dsh web` process behind the Run
 * menu's "DeepSeek web UI..." entry.
 *
 * The shortcut originally started the server inside an ordinary SHELL SESSION,
 * on the reasoning that Codeman already knows how to supervise those: it was
 * visible, scrollable, killable, and died with its tab, and nothing new had to
 * own a long-lived HTTP server. That reasoning was sound and the result was
 * still wrong in use — clicking "open the DeepSeek web UI" spawned a terminal
 * tab the user never asked for, next to the web tab they did, and the terminal
 * was noise every time after the first.
 *
 * So the server moves here instead: one child process, no session, no tab.
 * What that buys back has to be paid for explicitly, which is what this module
 * is:
 *
 * - **Exactly one.** A second click reuses the running server rather than
 *   racing it for a port. The old shell-session flow could not do this at all,
 *   because two clicks were simply two sessions.
 * - **Restarted when the authority changes.** `--trusted-host` fences dsh's
 *   `/api` against the browser authority, and a Codeman reachable at both
 *   loopback and a tailnet name has two. Whoever asks last wins, because the
 *   asker is by definition the origin about to load the page.
 * - **Killed on shutdown.** A detached child that outlived Codeman would hold
 *   its port against the next start, which is exactly the EADDRINUSE this
 *   feature already got wrong once.
 * - **Failures reported, not swallowed.** The shell tab used to be where the
 *   stack trace landed. With no tab, the spawn's own output is captured and
 *   handed back to the caller instead.
 * - **The launch token traded, not forwarded.** `dsh web` gates its own index
 *   behind a one-time token it prints on stdout and exchanges for a browser
 *   cookie. The tab stores a clean URL, so nothing on the browser side could
 *   ever present that token and every load answered 401. This module trades it
 *   here, once, and hands the cookie to the proxy (`getDeepSeekWebCookie`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { getErrorMessage } from './types.js';

/**
 * Where the port search starts, and how far it walks.
 *
 * 3080 is `dsh web`'s own default, so it is the friendly first choice — and
 * emphatically not a fixed port. DeepSeek's web UI is a thing users run
 * themselves, which makes the default precisely the port most likely to be
 * taken already; hardcoding it made this feature die with EADDRINUSE against
 * the user's own server.
 */
const PORT_BASE = 3080;
const PORT_SPAN = 40;

/** How long a freshly spawned server gets to answer before we call it failed. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 400;
/** Grace between SIGTERM and SIGKILL when stopping the tree. */
const KILL_GRACE_MS = 3_000;
/** Bound on captured child output, so a chatty boot cannot grow without limit. */
const OUTPUT_CAP = 16_384;
/**
 * Bound on the boot-output window searched for the launch banner.
 *
 * Deliberately larger and separate from {@link OUTPUT_CAP}: that one only has to
 * keep an error tail, while this one must survive a chatty plugin tree's boot
 * logs long enough to see a banner printed after them. 256 KB of one-line output
 * is far beyond anything a real boot prints, and a bound still exists because a
 * wedged child can print forever.
 */
const BANNER_SCAN_CAP = 262_144;

/** How long boot waits for `dsh web` to print the launch URL it gates itself on. */
const LAUNCH_URL_WAIT_MS = 4_000;
/** Bound on the one-shot token→cookie exchange (loopback, so this is generous). */
const TOKEN_EXCHANGE_TIMEOUT_MS = 5_000;
/** Cookie name `dsh web` mints for a browser session that presented the token. */
const DSH_AUTH_COOKIE_PREFIX = 'dsh-auth-';

export interface DeepSeekWebStatus {
  running: boolean;
  port: number | null;
  url: string | null;
  /** Browser authority this server was started to trust (`--trusted-host`). */
  authority: string | null;
}

interface RunningServer {
  child: ChildProcess;
  port: number;
  authority: string;
  /**
   * Username of the Codeman user whose request started this server. Undefined in
   * single-user mode, where no owner exists. The cookie bought with the launch
   * token belongs to that identity and is presented to nobody else (see
   * `getDeepSeekWebCookie`).
   */
  starter: string | undefined;
  output: () => string;
  /**
   * Boot output scanned for the launch banner, on its own (larger) budget than
   * `output`. Read through this rather than `output` so a banner printed after
   * the error-tail cap filled is still found.
   */
  banner: () => string;
  /**
   * The `dsh-auth-*` cookie bought with this process's launch token, once the
   * exchange succeeded. Null on a dsh old enough to serve its index without a
   * token, which is why "no cookie" is not a startup failure.
   */
  cookie: string | null;
}

let current: RunningServer | null = null;

/**
 * True when nothing holds `port` on loopback.
 *
 * Binding is the only honest test: a connect probe cannot tell "free" from
 * "listening but not answering yet", and this runs moments before `dsh web`
 * binds the same port. It is inherently racy, which is why the caller still
 * waits for the server to actually answer before reporting success.
 */
async function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function findFreePort(): Promise<number | null> {
  for (let port = PORT_BASE; port < PORT_BASE + PORT_SPAN; port++) {
    if (await isLoopbackPortFree(port)) return port;
  }
  return null;
}

/** Does the server answer HTTP yet? Any status counts: dsh may 4xx a bare GET. */
async function answersHttp(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The authenticated URL `dsh web` prints once it is up.
 *
 * Its browser-auth gate made the index private: boot writes
 * `dsh web: http://127.0.0.1:<port>/?token=<one-time token>` and only a request
 * carrying that token is answered with the cookie that authorizes everything
 * after it. The token is per process, so it can be neither guessed nor carried
 * across restarts — it has to be read out of the boot output.
 *
 * Null for output without one, which is the older-dsh case and stays working.
 *
 * @param output - captured stdout+stderr so far.
 * @returns absolute http(s) URL carrying a `token`, or null.
 */
export function parseLaunchUrl(output: string): string | null {
  // Strip SGR sequences first: a coloured banner would otherwise hide the URL
  // behind escape codes and turn a perfectly working server into a 401. Built
  // from the code point rather than written as `\x1b` so the linter's
  // no-control-regex rule does not read it as an accidental control character.
  const plain = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const match = /dsh web:\s*(\S+)/.exec(plain);
  if (!match) return null;
  let url: URL;
  try {
    url = new URL(match[1]);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.searchParams.get('token') ? url.href : null;
}

/**
 * Trade the launch URL for the `dsh-auth-*` cookie the proxy will present.
 *
 * `redirect: 'manual'` is load-bearing: the 303 is the response that carries
 * `Set-Cookie`, and following it would burn the token on a redirect to `./`
 * while dropping the only credential the exchange produces.
 *
 * @param launchUrl - token-bearing URL from {@link parseLaunchUrl}.
 * @returns `name=value` pair ready for a Cookie header, or null.
 */
async function exchangeLaunchToken(launchUrl: string): Promise<string | null> {
  try {
    const response = await fetch(launchUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0]?.trim();
      if (pair?.startsWith(DSH_AUTH_COOKIE_PREFIX)) return pair;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Wait for the banner, then exchange it.
 *
 * Never fails startup: a dsh without the gate prints a token-less banner, which
 * is answered as "nothing to exchange" immediately rather than after the whole
 * wait, and a gate that changes shape must not turn a serving UI into a boot
 * failure.
 *
 * @param running - the just-started server, read for its captured output.
 * @returns the cookie to hand the proxy, or null.
 */
async function captureSessionCookie(running: RunningServer): Promise<string | null> {
  const deadline = Date.now() + LAUNCH_URL_WAIT_MS;
  while (Date.now() < deadline) {
    const banner = running.banner();
    const launchUrl = parseLaunchUrl(banner);
    if (launchUrl) {
      const cookie = await exchangeLaunchToken(launchUrl);
      // The URL is a credential: never log it, only the fact that it did not work.
      if (!cookie) {
        console.warn(
          '[DeepSeek web] the launch token was printed but could not be exchanged for a session cookie; ' +
            "the tab will show dsh's 401 page until `dsh web` is restarted"
        );
      }
      return cookie;
    }
    // Only a printed http(s) URL settles this: it is the older dsh, which needs
    // no cookie. Any other line carrying the prefix (a diagnostic, a truncated
    // write) is not a banner, so the wait continues instead of giving up early.
    const printed = /dsh web:\s*(\S+)/.exec(banner)?.[1];
    if (printed && /^https?:\/\//.test(printed)) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/**
 * Signal the whole process group.
 *
 * `dsh web` boots a plugin tree and fans out, so signalling only the direct
 * child leaves survivors holding the port. Same negative-pid escalation as
 * `runGit()` in git-clone.ts and the profile installer.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function getDeepSeekWebStatus(): DeepSeekWebStatus {
  if (!current) return { running: false, port: null, url: null, authority: null };
  return {
    running: true,
    port: current.port,
    url: `http://127.0.0.1:${current.port}`,
    authority: current.authority,
  };
}

/**
 * The cookie this server's launch token bought, for the proxy to present.
 *
 * Keyed by `port` because the cookie is signed for the authority it was minted
 * under (`127.0.0.1:<port>`): handing it to a web tab pointed at some other
 * server would neither authenticate nor be that server's to receive. Null also
 * covers a dsh old enough to need no cookie at all.
 *
 * @param port - loopback port the upstream request is bound for.
 * @param owner - identity asking for it; must be the user who started the server.
 *   Both sides are undefined in single-user mode, where there is no owner.
 * @returns `name=value` cookie pair, or null.
 */
export function getDeepSeekWebCookie(port: number, owner?: string): string | null {
  if (!current || current.port !== port) return null;
  if (current.starter !== owner) return null;
  return current.cookie;
}

/** Stop the background server, if one is running. Safe to call when none is. */
export async function stopDeepSeekWeb(): Promise<void> {
  const running = current;
  current = null;
  if (!running) return;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      resolve();
    };
    running.child.once('exit', finish);
    killTree(running.child, 'SIGTERM');
    const hard = setTimeout(() => {
      killTree(running.child, 'SIGKILL');
      finish();
    }, KILL_GRACE_MS);
  });
}

type StartResult = { ok: true; port: number; url: string; reused: boolean } | { ok: false; error: string };

/**
 * Serializes concurrent starts. Two POSTs racing (two devices, or a double
 * click while the first boots) used to both see `current === null`, pick the
 * SAME free port, and spawn twice: the loser died on EADDRINUSE while its exit
 * handler nulled the singleton out from under the winner, leaving a live
 * `dsh web` nothing tracked or killed — the exact orphan this module exists to
 * prevent. The second caller now simply waits and reuses the first's server.
 */
let startLock: Promise<unknown> = Promise.resolve();

/**
 * Start (or reuse) the background `dsh web` for `authority`.
 *
 * @param dshDir directory holding the resolved `dsh` binary.
 * @param authority browser authority to pass as `--trusted-host`.
 * @param starter user whose request is starting it (undefined in single-user).
 */
export function startDeepSeekWeb(dshDir: string, authority: string, starter?: string): Promise<StartResult> {
  const run = startLock.then(
    () => startDeepSeekWebLocked(dshDir, authority, starter),
    () => startDeepSeekWebLocked(dshDir, authority, starter)
  );
  startLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function startDeepSeekWebLocked(
  dshDir: string,
  authority: string,
  starter: string | undefined
): Promise<StartResult> {
  // Reuse only when the running server is BOTH healthy and fenced for the
  // authority now asking, and it was started by this identity: the launch cookie
  // is per process and per user, so handing a previous starter's server to
  // another user would leave that user's tab on dsh's 401 page.
  if (current) {
    if (current.authority === authority && current.starter === starter && (await answersHttp(current.port))) {
      return { ok: true, port: current.port, url: `http://127.0.0.1:${current.port}`, reused: true };
    }
    await stopDeepSeekWeb();
  }

  const port = await findFreePort();
  if (port === null) {
    return { ok: false, error: `No free port for the DeepSeek web UI in ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1}` };
  }

  let child: ChildProcess;
  try {
    child = spawn(
      join(dshDir, 'dsh'),
      ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port), '--trusted-host', authority],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so the whole plugin tree can be signalled at once.
        detached: true,
        env: process.env,
      }
    );
  } catch (err) {
    return { ok: false, error: `Failed to start dsh web: ${getErrorMessage(err)}` };
  }

  // The pipes must be drained whether or not anyone reads them: a full pipe
  // blocks the child. Storage is capped; draining is not.
  let output = '';
  // Scanned for the launch banner separately from `output`. That cap exists to
  // bound the error tail, and a chatty profile can fill it before the banner is
  // printed — losing the banner there produces exactly the 401 tab this module
  // exists to prevent, so the two buffers must not share a limit.
  let banner = '';
  const capture = (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    if (output.length < OUTPUT_CAP) output += text;
    if (banner.length < BANNER_SCAN_CAP) banner += text;
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  let exited = false;
  child.once('exit', () => {
    exited = true;
    // Only clear if this is still the current server: a restart may have
    // already replaced it, and clearing then would drop the live one.
    if (current?.child === child) current = null;
  });
  child.once('error', () => {
    exited = true;
    if (current?.child === child) current = null;
  });

  const running: RunningServer = {
    child,
    port,
    authority,
    starter,
    output: () => output,
    banner: () => banner,
    cookie: null,
  };
  current = running;

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      // Guarded like the exit/error handlers: a concurrent stop (DELETE route,
      // shutdown) may already have cleared or replaced the singleton, and an
      // unconditional null here would drop a server this call does not own.
      if (current === running) current = null;
      const tail = output.trim().slice(-800);
      return { ok: false, error: tail ? `dsh web exited during startup: ${tail}` : 'dsh web exited during startup' };
    }
    if (await answersHttp(port)) {
      // Bought before this call resolves, so the first proxied page load
      // already carries a credential — a tab opened a moment earlier would
      // otherwise get the 401 this whole module exists to prevent.
      running.cookie = await captureSessionCookie(running);
      return { ok: true, port, url: `http://127.0.0.1:${port}`, reused: false };
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }

  // Timeout: kill OUR child. Only route through stopDeepSeekWeb() while the
  // singleton is still ours — signalling `current` unconditionally here could
  // SIGTERM a healthy server a concurrent actor now owns.
  if (current === running) {
    await stopDeepSeekWeb();
  } else {
    killTree(running.child, 'SIGKILL');
  }
  const tail = output.trim().slice(-800);
  return {
    ok: false,
    error: tail
      ? `dsh web did not answer on port ${port} within ${READY_TIMEOUT_MS / 1000}s: ${tail}`
      : `dsh web did not answer on port ${port} within ${READY_TIMEOUT_MS / 1000}s`,
  };
}

/** Test seam: forget any tracked child without signalling it. */
export function resetDeepSeekWebForTest(): void {
  current = null;
}
