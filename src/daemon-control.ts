/**
 * @fileoverview Detached `codeman web` control: start (-d), stop, status.
 *
 * Backs `codeman web -d`, `codeman web --stop` and `codeman web --status`. The
 * server itself is unchanged; this module re-launches the SAME entry script in a
 * new session (`detached: true` calls setsid), so the child has no controlling
 * terminal and no shell job entry. That is what actually makes it outlive the
 * shell: `nohup` does not, because Node re-arms SIGHUP to its default disposition
 * even when it inherits "ignore", and `cli.ts` installs a SIGHUP handler that
 * shuts the server down gracefully (issue #231).
 *
 * Two rules shape the rest of the module:
 *
 * 1. **Never start a second server on one data dir.** `~/.codeman` and the
 *    `tmux -L codeman` socket are process-wide (config/instance.ts), so a second
 *    instance discovers and attaches PTYs to the first one's live sessions and
 *    starts resizing them. A double `-d` therefore has to be a hard error, which
 *    means checking both the pidfile AND the port before spawning.
 * 2. **Never report success we have not seen.** The parent polls `/api/status`
 *    until the child answers (or dies) before printing a URL. A port clash or a
 *    missing dependency otherwise looks exactly like a clean start.
 *
 * Pure helpers (arg building, URL building, pidfile parsing, the process-identity
 * check) are exported separately so they can be unit-tested without spawning.
 *
 * @module daemon-control
 */

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dataPath } from './config/instance.js';
import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';

/** How long to wait for a freshly spawned server to answer `/api/status`. */
const START_TIMEOUT_MS = 30_000;
/** How long to wait for a SIGTERM'd server to actually exit before giving up. */
const STOP_TIMEOUT_MS = 15_000;
/** Poll interval while waiting for either of the above. */
const POLL_INTERVAL_MS = 250;

/** The `web` command's options, as far as a detached relaunch cares about them. */
export interface WebLaunchOptions {
  host: string;
  port: number;
  https: boolean;
  /** Reverse-proxy sub-path prefix (normalized: '' for root, or '/foo'). */
  basePath?: string;
  titleHostname?: string;
  allowUnauthenticatedNetwork?: boolean;
  allowUnauthenticatedTunnel?: boolean;
  multiuser?: boolean;
}

export interface StartResult {
  ok: boolean;
  pid?: number;
  url?: string;
  /** Machine-readable failure cause; `undefined` on success. */
  reason?: 'already-running' | 'exited' | 'timeout';
  message?: string;
  logPath: string;
}

export interface StopResult {
  ok: boolean;
  pid?: number;
  reason?: 'not-running' | 'foreign-pid' | 'timeout' | 'no-pidfile-but-responding';
  message?: string;
}

export interface DaemonStatus {
  pid: number | null;
  /** The pid in the pidfile is alive AND still looks like a Codeman web process. */
  running: boolean;
  /** Something answered `/api/status` at the expected address. */
  responding: boolean;
  version?: string;
  url: string;
  pidFile: string;
  logPath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Rebuild the `web` argv for the child, dropping the daemon flags themselves. */
export function buildWebArgs(options: WebLaunchOptions): string[] {
  const args = ['web', '--host', options.host, '--port', String(options.port)];
  if (options.https) args.push('--https');
  if (options.basePath) args.push('--base-url', options.basePath);
  if (options.titleHostname) args.push('--title-hostname', options.titleHostname);
  if (options.allowUnauthenticatedNetwork) args.push('--allow-unauthenticated-network');
  if (options.allowUnauthenticatedTunnel) args.push('--allow-unauthenticated-tunnel');
  if (options.multiuser) args.push('--multiuser');
  return args;
}

/**
 * Connectable address for this bind. A wildcard bind is not itself connectable,
 * so `0.0.0.0` / `::` become loopback; a bare IPv6 literal gets bracketed.
 */
export function buildBaseUrl(options: WebLaunchOptions): string {
  const protocol = options.https ? 'https' : 'http';
  let host = options.host.trim();
  if (host === '0.0.0.0' || host === '::' || host === '') host = '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return `${protocol}://${host}:${options.port}`;
}

/** The endpoint polled for readiness. */
export function buildStatusUrl(options: WebLaunchOptions): string {
  return `${buildBaseUrl(options)}/api/status`;
}

/** Parse a pidfile body. Rejects garbage, and pid 1 (init is never ours). */
export function parsePidFileContents(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  return pid;
}

/**
 * Does this command line look like a Codeman web server?
 *
 * Pids are recycled, and a stale pidfile pointing at whatever inherited the
 * number is a live footgun: `codeman web --stop` must not SIGTERM an unrelated
 * process. Both the npm bin (`codeman`/`aicodeman`) and the direct entry
 * (`node dist/index.js web`, `tsx src/index.ts web`) have to match.
 */
export function looksLikeCodemanWeb(command: string | null | undefined): boolean {
  if (!command) return false;
  if (!/(^|\s)web(\s|$)/.test(command)) return false;
  return /(^|[/\s])(ai)?codeman(\s|$)/.test(command) || /index\.(js|ts)(\s|$)/.test(command);
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolved at call time, not module load: tests swap `HOME` per file, and the
 * data dir is derived from it (see test/setup.ts).
 */
export function pidFilePath(): string {
  return dataPath('web.pid');
}

/** Where a detached server's stdout/stderr is appended. */
export function logFilePath(): string {
  return dataPath('web.log');
}

// ─────────────────────────────────────────────────────────────────────────────
// Process probing
// ─────────────────────────────────────────────────────────────────────────────

/** Signal 0 liveness check. EPERM means the pid exists but is not ours. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Full command line of a pid, or null. `-o command=` is portable to macOS. */
export function readProcessCommand(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Read the pidfile, returning null when it is missing, empty or malformed. */
export function readPidFile(): number | null {
  const file = pidFilePath();
  if (!existsSync(file)) return null;
  try {
    return parsePidFileContents(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function removePidFile(): void {
  try {
    unlinkSync(pidFilePath());
  } catch {
    /* already gone */
  }
}

/** Pid of a live Codeman web server recorded in the pidfile, or null. */
export function readLivePid(): number | null {
  const pid = readPidFile();
  if (pid === null) return null;
  if (!isProcessAlive(pid)) return null;
  // A recycled pid is not ours. `ps` can also legitimately fail (containers with
  // no procps); treat "cannot tell" as ours rather than orphaning the pidfile.
  const command = readProcessCommand(pid);
  if (command !== null && !looksLikeCodemanWeb(command)) return null;
  return pid;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP readiness probe
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeResult {
  /** A Codeman server answered. A 401 counts: auth is active, the server is up. */
  up: boolean;
  version?: string;
}

/**
 * Probe `/api/status`. Self-signed certs are accepted (`--https` generates one),
 * and 401 counts as up because `CODEMAN_PASSWORD` gates that route. The body is
 * checked so an unrelated service squatting on the port is not read as success.
 */
export function probeServer(url: string, timeoutMs = 2000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      done({ up: false });
      return;
    }

    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        if (res.statusCode === 401) {
          res.resume();
          done({ up: true });
          return;
        }
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          if (body.length < 4096) body += chunk;
        });
        res.on('end', () => {
          if (!body.includes('"success"')) {
            done({ up: false });
            return;
          }
          let version: string | undefined;
          try {
            version = (JSON.parse(body) as { data?: { version?: string } }).data?.version;
          } catch {
            /* body was truncated at 4KB; up is still true */
          }
          done({ up: true, version });
        });
        res.on('error', () => done({ up: false }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      done({ up: false });
    });
    req.on('error', () => done({ up: false }));
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Start / stop / status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The script to relaunch. `process.execArgv` is carried over with it so a dev
 * run under tsx (whose execArgv holds the tsx loader flags) re-launches through
 * tsx instead of handing a `.ts` file to bare node.
 */
function entryScript(): string {
  const script = process.argv[1];
  if (!script) throw new Error('cannot determine the codeman entry script to relaunch');
  return script;
}

/** Marks one launch in the append-only log so a tail cannot mix two runs. */
const LOG_SEPARATOR = '=== codeman web start';

/**
 * Last few lines of the daemon log, for reporting a failed start. The log is
 * append-only across launches, so the tail starts at the last separator when
 * there is one: otherwise a crash report is padded with the previous run's
 * cheerful startup banner.
 */
export function tailLog(maxLines = 15): string {
  try {
    const lines = readFileSync(logFilePath(), 'utf-8').trimEnd().split('\n');
    const start = lines.map((line) => line.startsWith(LOG_SEPARATOR)).lastIndexOf(true);
    const current = start === -1 ? lines : lines.slice(start + 1);
    return current.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Spawn a detached `codeman web` and wait until it answers before returning.
 * Refuses when a server is already up on this data dir (see rule 1 in the module
 * docblock).
 */
export async function startDaemon(options: WebLaunchOptions): Promise<StartResult> {
  const logPath = logFilePath();
  const url = buildBaseUrl(options);
  const statusUrl = buildStatusUrl(options);

  const existingPid = readLivePid();
  if (existingPid !== null) {
    return {
      ok: false,
      reason: 'already-running',
      pid: existingPid,
      logPath,
      message: `a Codeman server is already running (pid ${existingPid}). Stop it with \`codeman web --stop\` first.`,
    };
  }
  const alreadyServing = await probeServer(statusUrl, 1500);
  if (alreadyServing.up) {
    return {
      ok: false,
      reason: 'already-running',
      logPath,
      url,
      message: `something is already serving ${url}. Two servers on one data dir attach to each other's tmux sessions, so refusing to start.`,
    };
  }
  // A pidfile that survived a crash: the process is gone, so it is just litter.
  if (readPidFile() !== null) removePidFile();

  const args = buildWebArgs(options);
  try {
    appendFileSync(logPath, `\n${LOG_SEPARATOR} ${new Date().toISOString()} ===\n`, 'utf-8');
  } catch {
    /* the spawn below reports a genuinely unwritable log */
  }
  const logFd = openSync(logPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [...process.execArgv, entryScript(), ...args], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
  } finally {
    closeSync(logFd);
  }

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', () => {
    exited = true;
  });

  const pid = child.pid;
  if (pid === undefined) {
    return { ok: false, reason: 'exited', logPath, message: 'failed to spawn the server process' };
  }
  writeFileSync(pidFilePath(), `${pid}\n`, 'utf-8');

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      removePidFile();
      child.unref();
      return {
        ok: false,
        reason: 'exited',
        logPath,
        message: `the server exited during startup. Last lines of ${logPath}:\n${tailLog()}`,
      };
    }
    const probe = await probeServer(statusUrl, 1000);
    if (probe.up) {
      child.unref();
      return { ok: true, pid, url, logPath };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  child.unref();
  return {
    ok: false,
    reason: 'timeout',
    pid,
    url,
    logPath,
    message: `the server did not answer ${url} within ${START_TIMEOUT_MS / 1000}s. It may still be starting; check ${logPath}.`,
  };
}

/** SIGTERM the recorded server and wait for it to actually exit. */
export async function stopDaemon(options: WebLaunchOptions): Promise<StopResult> {
  const pid = readPidFile();
  if (pid === null) {
    const probe = await probeServer(buildStatusUrl(options), 1500);
    if (probe.up) {
      return {
        ok: false,
        reason: 'no-pidfile-but-responding',
        message:
          'a server is responding but there is no pidfile, so it was not started with `-d`. If it is a service use `codeman service uninstall` (or stop the unit); otherwise `pkill -f "index.js web"`.',
      };
    }
    return { ok: true, reason: 'not-running', message: 'no daemon is running; nothing to stop' };
  }

  if (!isProcessAlive(pid)) {
    removePidFile();
    return { ok: true, pid, message: `stale pidfile removed (pid ${pid} was not running)` };
  }

  const command = readProcessCommand(pid);
  if (command !== null && !looksLikeCodemanWeb(command)) {
    return {
      ok: false,
      reason: 'foreign-pid',
      pid,
      message: `pid ${pid} is not a Codeman server (${command}). Refusing to signal it; delete ${pidFilePath()} if it is stale.`,
    };
  }

  // SIGTERM, never SIGKILL: cli.ts flushes state on the way out.
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, reason: 'foreign-pid', pid, message: `could not signal pid ${pid}: ${String(err)}` };
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidFile();
      return { ok: true, pid };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    reason: 'timeout',
    pid,
    message: `pid ${pid} did not exit within ${STOP_TIMEOUT_MS / 1000}s. Force it with \`kill -9 ${pid}\` if you are sure.`,
  };
}

/** Report on both halves: the recorded process, and whether the port answers. */
export async function daemonStatus(options: WebLaunchOptions): Promise<DaemonStatus> {
  const url = buildBaseUrl(options);
  const pid = readPidFile();
  const probe = await probeServer(buildStatusUrl(options), 2000);
  return {
    pid,
    running: readLivePid() !== null,
    responding: probe.up,
    version: probe.version,
    url,
    pidFile: pidFilePath(),
    logPath: logFilePath(),
  };
}
