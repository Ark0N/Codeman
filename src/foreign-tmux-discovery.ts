/**
 * @fileoverview Runs the foreign-tmux probe at the three locations Codeman
 * already knows how to reach: this host, inside a container, and across ssh.
 *
 * All the judgement lives in `foreign-tmux.ts` (pure). This module is only
 * transport + caching + the promise that it never throws.
 *
 * ## Cost policy
 *
 * The home screen shows LOCAL results automatically, so a local scan runs on a
 * TTL cache: N browser tabs polling every few seconds still trigger at most one
 * scan per `FOREIGN_CACHE_TTL_MS`. Docker and remote are ON DEMAND only:
 * opening the home page must never fan out one ssh connection per saved host.
 *
 * ## ⚠️ The probe must not cross an extra shell
 *
 * The script contains `$TMUX_TMPDIR` and `$(id -u)`, which the INNER shell has to
 * expand. Local and docker therefore spawn with an argv array, where no outer
 * shell exists to eat them first. Remote is the exception: the ssh
 * command line is a string like every other ssh call in this codebase, so the
 * script is wrapped in SINGLE quotes there, which is exactly why
 * `buildForeignProbeScript()` may not contain one.
 *
 * This was measured, not reasoned: running the probe through `execSync` (which
 * spawns `sh -c`) expanded `$TMUX_TMPDIR` and `$U` in the OUTER shell, leaving the
 * inner loop iterating over the literal `/tmux-/*` and reporting zero sessions on
 * a machine that had three.
 *
 * ## A probe that goes wrong still answers
 *
 * All three transports go through `runForeignProbe`, which never rejects and hands
 * back what it read. A timeout has to reach the whole process tree, not just the
 * `sh` on top (the same rule as `runFetch` in git-fetch.ts): signalling only `sh`
 * left its tmux child stuck on a stopped server, one more per scan, for as long as
 * the home screen stayed open. And a scan cut short keeps the rows it already has,
 * since one bad server must not empty the list of a machine with good ones.
 *
 * @module foreign-tmux-discovery
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  buildForeignProbeScript,
  classifyForeignPaneMode,
  createForeignSignatureMatcher,
  foreignRemoteShellCommand,
  foreignSessionId,
  isAdoptableSessionName,
  isAdoptableSocketPath,
  isCodemanOwnedPane,
  parseForeignProbeOutput,
} from './foreign-tmux.js';
import { dockerEngineArgv, readDockerCases, readDockerHosts } from './docker-hosts.js';
import { buildSshConnectionArgs, readRemoteHosts, remoteSshTarget, shellescape } from './remote-hosts.js';
import { runWithRemoteSshLimit } from './remote-ssh-limiter.js';
import { resolveTmuxSocketName, getDataDir } from './config/instance.js';
import {
  FOREIGN_CACHE_TTL_MS,
  FOREIGN_PROBE_KILL_GRACE_MS,
  FOREIGN_PROBE_MAX_BYTES,
  FOREIGN_PROBE_TIMEOUT_MS,
} from './config/foreign-tmux.js';
import type { ForeignDiscoveryResult, ForeignTmuxSession } from './types/foreign-tmux.js';
import type { DockerCase, DockerHost, RemoteHost, SessionDocker } from './types/session.js';

const IS_TEST_MODE = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

/** What one probe produced, however it ended. */
export interface ForeignProbeRun {
  /** Everything read before it finished or was stopped. */
  stdout: string;
  /** False when it timed out, flooded, exited non-zero or could not start. */
  ok: boolean;
}

/**
 * Run one probe in its own process group. Never rejects (see @fileoverview).
 *
 * The caller is answered AT the deadline, while the group is still dying.
 */
export function runForeignProbe(
  argv: readonly string[],
  opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<ForeignProbeRun> {
  const { timeoutMs = FOREIGN_PROBE_TIMEOUT_MS, maxBytes = FOREIGN_PROBE_MAX_BYTES } = opts;
  return new Promise((resolve) => {
    const [file, ...args] = argv;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let child: ChildProcess | undefined;
    let escalation: NodeJS.Timeout | undefined;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ stdout: Buffer.concat(chunks).toString('utf-8'), ok });
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (child?.pid) process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const stop = () => {
      signalGroup('SIGTERM');
      escalation = setTimeout(() => signalGroup('SIGKILL'), FOREIGN_PROBE_KILL_GRACE_MS);
      escalation.unref();
      // ⚠️ Let go of the pipe by hand. A stopped tmux server can hold it open with
      // everything in this group dead (see foreign-tmux.ts), so waiting for its EOF
      // would keep one handle per scan until that server is resumed.
      child?.stdout?.destroy();
      finish(false);
    };
    const deadline = setTimeout(stop, timeoutMs);

    try {
      child = spawn(file ?? '', args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch {
      finish(false);
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk.subarray(0, Math.max(0, maxBytes - bytes)));
      bytes += chunk.length;
      if (bytes > maxBytes) stop();
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => {
      // The group is gone, so a late SIGKILL could only reach whoever reused its id.
      clearTimeout(escalation);
      finish(code === 0);
    });
  });
}

/** The note for a probe that ended badly. Rows already read stay, so say which case this is. */
function probeFailureNote(where: string, run: ForeignProbeRun, nothing: string): string {
  return run.stdout ? `${where}: the scan did not finish, this list may be incomplete` : `${where}: ${nothing}`;
}

/**
 * Turn one probe's stdout into candidates. Shared by all three transports, so a
 * container's sessions and the host's are classified by identical rules.
 *
 * `where` opens every note this scan writes (`local`, `docker <name>`, `remote
 * <label>`). The browser tells the two kinds apart by it: a local note is re-read on
 * every poll, a container or host note only by the next explicit scan.
 */
export function candidatesFrom(
  stdout: string,
  location: ForeignTmuxSession['location'],
  hostKey: string,
  extra: Pick<ForeignTmuxSession, 'hostId' | 'hostLabel' | 'containerName'>,
  where: string,
  notes: string[]
): ForeignTmuxSession[] {
  const probe = parseForeignProbeOutput(stdout);
  const match = createForeignSignatureMatcher();
  const ownSocket = resolveTmuxSocketName();
  const out: ForeignTmuxSession[] = [];
  const seen = new Set<string>();
  let unsafe = 0;

  for (const pane of probe.panes) {
    if (isCodemanOwnedPane(pane, ownSocket)) continue;
    // ⚠️ THE security gate, and it lives here rather than at the adopt endpoint
    // on purpose: a name that cannot cross the launch chain safely never gets an
    // id, so there is nothing for a caller to send. Adoption re-resolves through
    // this same function, which makes the endpoint fail closed for free.
    // See `isAdoptableSessionName` for the injection this prevents.
    if (!isAdoptableSessionName(pane.sessionName) || !isAdoptableSocketPath(pane.socketPath)) {
      unsafe += 1;
      continue;
    }
    // One row per SESSION, not per pane: the first pane is the one we would land
    // on, and a multi-pane session is still a single thing to adopt.
    // \u0000 as an ESCAPE, never the literal byte: a raw NUL in the source makes git
    // treat this whole file as binary (no diff, no review), and the allowlists above
    // already guarantee neither half can contain one.
    const key = `${pane.socketPath}\u0000${pane.sessionName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const classified = classifyForeignPaneMode(pane, probe, match);
    out.push({
      id: foreignSessionId(location, hostKey, pane.socketPath, pane.sessionName),
      location,
      ...extra,
      socketPath: pane.socketPath,
      sessionName: pane.sessionName,
      windows: pane.windows,
      attached: pane.sessionAttached,
      createdAt: pane.sessionCreated * 1000,
      mode: classified.mode,
      command: classified.command,
      workingDir: pane.paneCurrentPath,
    });
  }
  if (unsafe) {
    notes.push(
      `${where}: ${unsafe} session(s) skipped, the tmux session name or socket path is one Codeman cannot pass safely to a shell or to tmux`
    );
  }
  // Another Codeman's server is not a session this list would ever have shown.
  const hung = probe.hungSockets.filter(
    (socketPath) => !isCodemanOwnedPane({ socketPath, sessionName: '' }, ownSocket)
  );
  if (hung.length) {
    notes.push(`${where}: ${hung.length} tmux server(s) did not answer, sessions on them are not listed`);
  }
  return out;
}

// ===========================================================================
// Local
// ===========================================================================

let localCache: { at: number; result: ForeignDiscoveryResult } | null = null;
let localInFlight: Promise<ForeignDiscoveryResult> | null = null;

/**
 * Scan this host. TTL-cached and single-flight, because this is the one location
 * the home screen polls on its own.
 */
export async function discoverLocalForeign(force = false): Promise<ForeignDiscoveryResult> {
  if (IS_TEST_MODE) return { sessions: [], scannedAt: Date.now(), notes: [] };

  const now = Date.now();
  if (!force && localCache && now - localCache.at < FOREIGN_CACHE_TTL_MS) return localCache.result;
  if (localInFlight) return localInFlight;

  localInFlight = (async (): Promise<ForeignDiscoveryResult> => {
    const notes: string[] = [];
    let sessions: ForeignTmuxSession[] = [];
    try {
      // argv array: no outer shell, so the script's own `$TMUX_TMPDIR`/`$(id -u)`
      // reach the inner sh intact (see @fileoverview).
      const run = await runForeignProbe(['sh', '-c', buildForeignProbeScript()]);
      sessions = candidatesFrom(run.stdout, 'local', 'local', {}, 'local', notes);
      if (!run.ok) notes.push(probeFailureNote('local', run, 'tmux probe produced no result'));
    } catch {
      // The probe answers rather than throws, so this is the classifier. "Nothing to
      // adopt here" is the only honest answer and it is never an error to the caller.
      notes.push('local: tmux probe produced no result');
    }
    const result: ForeignDiscoveryResult = { sessions, scannedAt: Date.now(), notes };
    localCache = { at: Date.now(), result };
    return result;
  })().finally(() => {
    localInFlight = null;
  });

  return localInFlight;
}

/** Drop the local cache so the next scan is real (used right after an adopt). */
export function invalidateForeignCache(): void {
  localCache = null;
}

// ===========================================================================
// Docker
// ===========================================================================

/** Connection facts for one adoptable container, resolved from the registries. */
export interface DockerTargetInfo {
  hostId: string;
  label: string;
  containerName: string;
  base: Pick<SessionDocker, 'engine' | 'context' | 'daemonHost'>;
}

function dockerTargets(cases: DockerCase[], hosts: DockerHost[]): DockerTargetInfo[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const out: DockerTargetInfo[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    const container = c.container || `codeman-case-${c.name}`;
    // Per engine, not global: two daemons can each run a container of one name,
    // and collapsing them here would leave the second one unscanned.
    const key = `${c.hostId}\u0000${container}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const host = byId.get(c.hostId);
    out.push({
      hostId: c.hostId,
      label: host?.label || c.name,
      containerName: container,
      base: {
        engine: host?.engine ?? 'docker',
        context: host?.context,
        daemonHost: host?.daemonHost,
      },
    });
  }
  return out;
}

/**
 * The argv of one in-container probe.
 *
 * ⚠️ `dockerEngineArgv`, never `buildDockerBaseArgs`, whose `--context` and `-H`
 * values are shell-quoted for the launch string. `execFile` passes those quotes
 * through literally, so `docker --context "'default'"` answered "context not found"
 * and every container behind a named context or a remote daemon read as unreachable.
 */
export function foreignDockerProbeArgv(target: DockerTargetInfo): string[] {
  return [...dockerEngineArgv(target.base), 'exec', target.containerName, 'sh', '-lc', buildForeignProbeScript()];
}

/**
 * Scan the containers behind the caller's docker cases. On demand only.
 *
 * Read-only by construction: one `docker exec` running the probe. Never inspects
 * lifecycle, never starts anything: a stopped or missing container simply
 * contributes a note, mirroring `probeAdoptableContainer`'s "engine unreachable
 * degrades to an empty list" rule.
 */
export async function discoverDockerForeign(cases: DockerCase[]): Promise<ForeignDiscoveryResult> {
  if (IS_TEST_MODE) return { sessions: [], scannedAt: Date.now(), notes: [] };

  const hosts = await readDockerHosts(getDataDir()).catch(() => [] as DockerHost[]);
  const targets = dockerTargets(cases, hosts);
  const notes: string[] = [];
  const sessions: ForeignTmuxSession[] = [];

  await Promise.all(
    targets.map(async (t) => {
      const where = `docker ${t.containerName}`;
      try {
        const run = await runForeignProbe(foreignDockerProbeArgv(t));
        sessions.push(
          ...candidatesFrom(
            run.stdout,
            'docker',
            `${t.hostId} ${t.containerName}`,
            { hostId: t.hostId, hostLabel: t.label, containerName: t.containerName },
            where,
            notes
          )
        );
        if (!run.ok) notes.push(probeFailureNote(where, run, 'not running, no tmux, or engine unreachable'));
      } catch {
        notes.push(`${where}: not running, no tmux, or engine unreachable`);
      }
    })
  );

  return { sessions, scannedAt: Date.now(), notes };
}

// ===========================================================================
// Remote
// ===========================================================================

/**
 * The ssh command line of one remote probe.
 *
 * `exec` so a timeout kill reaches ssh itself, not only the local `sh -c` around it.
 */
export function foreignRemoteProbeCommand(host: RemoteHost): string {
  return [
    'exec',
    ...buildSshConnectionArgs(host),
    remoteSshTarget(host),
    shellescape(foreignRemoteShellCommand(buildForeignProbeScript())),
  ].join(' ');
}

/**
 * Scan saved ssh hosts. On demand only: this is the expensive one.
 *
 * ⚠️ The ssh command is a STRING (as every ssh call in this codebase is), so the
 * probe crosses one extra shell and must be single-quoted. `shellescape` does
 * that, and `buildForeignProbeScript()` is single-quote-free precisely so the
 * escaping stays a wrap rather than a rewrite.
 *
 * Each host holds a slot of the shared remote-ssh limiter: one saved host per
 * connection, all at once, is the burst OpenSSH's `MaxStartups` starts dropping.
 * A host that waits too long for a slot reads as unreachable this round.
 */
export async function discoverRemoteForeign(hosts: RemoteHost[]): Promise<ForeignDiscoveryResult> {
  if (IS_TEST_MODE) return { sessions: [], scannedAt: Date.now(), notes: [] };

  const notes: string[] = [];
  const sessions: ForeignTmuxSession[] = [];

  await Promise.all(
    hosts.map(async (host) => {
      const where = `remote ${host.label}`;
      try {
        const run = await runWithRemoteSshLimit(() => runForeignProbe(['sh', '-c', foreignRemoteProbeCommand(host)]), {
          maxWaitMs: FOREIGN_PROBE_TIMEOUT_MS,
        });
        sessions.push(
          ...candidatesFrom(run.stdout, 'remote', host.id, { hostId: host.id, hostLabel: host.label }, where, notes)
        );
        if (!run.ok) notes.push(probeFailureNote(where, run, 'unreachable, or no tmux'));
      } catch {
        notes.push(`${where}: unreachable, or no tmux`);
      }
    })
  );

  return { sessions, scannedAt: Date.now(), notes };
}

// ===========================================================================
// Facade
// ===========================================================================

export interface ForeignDiscoveryRequest {
  /** Always scanned (cheap, cached). */
  local?: boolean;
  /** Docker cases the CALLER may see; ownership filtering happens in the route. */
  dockerCases?: DockerCase[];
  /** Remote hosts the CALLER may see. */
  remoteHosts?: RemoteHost[];
  /** Skip the local TTL cache. */
  force?: boolean;
}

/**
 * One scan across the requested locations. Merges notes, never throws.
 *
 * The caller supplies the docker cases and remote hosts rather than this module
 * reading the registries itself: which of them a user may see is an ownership
 * question, and ownership belongs to the route layer.
 */
export async function discoverForeignSessions(req: ForeignDiscoveryRequest): Promise<ForeignDiscoveryResult> {
  const parts: ForeignDiscoveryResult[] = [];
  if (req.local !== false) parts.push(await discoverLocalForeign(req.force));
  if (req.dockerCases?.length) parts.push(await discoverDockerForeign(req.dockerCases));
  if (req.remoteHosts?.length) parts.push(await discoverRemoteForeign(req.remoteHosts));

  return {
    sessions: parts.flatMap((p) => p.sessions),
    scannedAt: parts.length ? Math.max(...parts.map((p) => p.scannedAt)) : Date.now(),
    notes: parts.flatMap((p) => p.notes),
  };
}

/** Re-read the caller-visible docker cases, for routes that only hold a username. */
export async function readAllDockerCases(): Promise<DockerCase[]> {
  return readDockerCases(getDataDir()).catch(() => [] as DockerCase[]);
}

/** Re-read the saved remote hosts. */
export async function readAllRemoteHosts(): Promise<RemoteHost[]> {
  return readRemoteHosts(getDataDir()).catch(() => [] as RemoteHost[]);
}
