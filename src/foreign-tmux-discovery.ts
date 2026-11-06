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
 * scan per `FOREIGN_CACHE_TTL_MS`. Docker and remote are ON DEMAND only —
 * opening the home page must never fan out one ssh connection per saved host.
 *
 * ## ⚠️ The probe must not cross an extra shell
 *
 * The script contains `$TMUX_TMPDIR` and `$(id -u)`, which the INNER shell has to
 * expand. Local and docker therefore spawn with an argv array (`execFile`), where
 * no outer shell exists to eat them first. Remote is the exception: the ssh
 * command line is a string like every other ssh call in this codebase, so the
 * script is wrapped in SINGLE quotes there — which is exactly why
 * `buildForeignProbeScript()` may not contain one.
 *
 * This was measured, not reasoned: running the probe through `execSync` (which
 * spawns `sh -c`) expanded `$TMUX_TMPDIR` and `$U` in the OUTER shell, leaving the
 * inner loop iterating over the literal `/tmux-/*` and reporting zero sessions on
 * a machine that had three.
 *
 * @module foreign-tmux-discovery
 */

import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildForeignProbeScript,
  classifyForeignPaneMode,
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
import { FOREIGN_CACHE_TTL_MS, FOREIGN_PROBE_MAX_BYTES, FOREIGN_PROBE_TIMEOUT_MS } from './config/foreign-tmux.js';
import type { ForeignDiscoveryResult, ForeignTmuxSession } from './types/foreign-tmux.js';
import type { DockerCase, DockerHost, RemoteHost, SessionDocker } from './types/session.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const IS_TEST_MODE = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

const PROBE_OPTS = {
  encoding: 'utf-8' as const,
  timeout: FOREIGN_PROBE_TIMEOUT_MS,
  maxBuffer: FOREIGN_PROBE_MAX_BYTES,
};

/**
 * Turn one probe's stdout into candidates. Shared by all three transports, so a
 * container's sessions and the host's are classified by identical rules.
 *
 * `where` opens every note this scan writes (`local`, `docker <name>`, `remote
 * <label>`). The browser tells the two kinds apart by it: a local note is re-read on
 * every poll, a container or host note only by the next explicit scan.
 */
function candidatesFrom(
  stdout: string,
  location: ForeignTmuxSession['location'],
  hostKey: string,
  extra: Pick<ForeignTmuxSession, 'hostId' | 'hostLabel' | 'containerName'>,
  where: string,
  notes: string[]
): ForeignTmuxSession[] {
  const probe = parseForeignProbeOutput(stdout);
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

    const classified = classifyForeignPaneMode(pane, probe);
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
      `${where}: ${unsafe} session(s) skipped, the tmux session name or socket path contains characters Codeman will not pass to a shell`
    );
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
      const { stdout } = await execFileAsync('sh', ['-c', buildForeignProbeScript()], PROBE_OPTS);
      sessions = candidatesFrom(stdout, 'local', 'local', {}, 'local', notes);
    } catch {
      // No tmux, no sockets, or a probe that timed out. "Nothing to adopt here"
      // is the only honest answer and it is never an error to the caller.
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
 * lifecycle, never starts anything — a stopped or missing container simply
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
      const [engine, ...args] = foreignDockerProbeArgv(t);
      try {
        const { stdout } = await execFileAsync(engine, args, PROBE_OPTS);
        sessions.push(
          ...candidatesFrom(
            stdout,
            'docker',
            `${t.hostId} ${t.containerName}`,
            { hostId: t.hostId, hostLabel: t.label, containerName: t.containerName },
            `docker ${t.containerName}`,
            notes
          )
        );
      } catch {
        notes.push(`docker ${t.containerName}: not running, no tmux, or engine unreachable`);
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
 * Scan saved ssh hosts. On demand only — this is the expensive one.
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
        const { stdout } = await runWithRemoteSshLimit(() => execAsync(foreignRemoteProbeCommand(host), PROBE_OPTS), {
          maxWaitMs: FOREIGN_PROBE_TIMEOUT_MS,
        });
        sessions.push(...candidatesFrom(stdout, 'remote', host.id, { hostId: host.id, hostLabel: host.label }, where, notes));
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
  /** Docker cases the CALLER may see — ownership filtering happens in the route. */
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
