/**
 * @fileoverview Registry-driven CLI binary resolution: look up ANY registered CLI's binary
 * directory, version and not-found message from its `CliEntry`, with no per-CLI branch.
 *
 * This is a LAYER over `cli-executable-resolver.ts`, not a replacement for it. That module
 * still owns the lookup chain (process PATH → the entry's search dirs → an interactive
 * login shell), the negative cache and its doubling backoff, the marker-fenced login-shell
 * parse, the `SIGKILL` timeouts and the vitest hermeticity gate — all of it deliberately
 * untouched here, because those guards are load-bearing and separately tested. What this
 * module adds is: where the parameters come from (the registry, rather than seven
 * hand-written constant blocks) and what makes a candidate acceptable.
 *
 * CANDIDATE VALIDATION runs in a fixed order, and the order is the point:
 *
 *   1. IDENTITY (`discovery.identity`) — does the binary say it is the program we meant?
 *      Checked FIRST, because a version probe cannot tell an impostor from the real thing:
 *      Debian's `dsh` (dancer's shell) answers `--version` perfectly happily, and npm
 *      carries squatters for both `pi` and `grok`.
 *   2. VERSION (`discovery.version`) — does its version output have the right shape? With
 *      `requireVersionMatch`, a mismatch means ABSENT rather than present-with-unknown-
 *      version, which is what a short, generic binary name needs.
 *
 * Both probes EXECUTE the candidate, which is exactly why both are gated off under vitest:
 * a suite must never depend on — let alone run — whatever binary of that name the machine
 * running it happens to carry. Tests inject probes instead.
 *
 * @module utils/cli-resolver
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { compileVersionRegex, MAX_VERSION_OUTPUT } from '../config/cli-registry/patterns.js';
import { getCli, resolveInstallCommandForPlatform } from '../config/cli-registry/registry.js';
import { getClaudeCliVersion } from './claude-cli-resolver.js';
import type { CliEntry } from '../config/cli-registry/types.js';
import {
  createCliExecutableResolver,
  formatCliNotFoundMessage,
  type CliExecutableResolver,
  type CliResolverHost,
} from './cli-executable-resolver.js';

/** Expand a leading `~` to the home directory. Nothing else is interpreted. */
export function expandHome(dir: string): string {
  if (dir === '~') return homedir();
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2));
  return dir;
}

/**
 * Run `<binPath> <arg>` and return its trimmed output, truncated to the cap a
 * config-supplied regex is allowed to see.
 *
 * Returns null under vitest — see this file's header. This is defense in depth rather than
 * the only gate (the shared resolver host is already inert under vitest), and it is what
 * makes the "resolve nothing even against a real on-disk fixture" behaviour hold for a
 * test that opts back into real filesystem IO.
 */
function probeCommandOutput(binPath: string, arg: string, logPrefix: string): string | null {
  if (process.env.VITEST) return null;
  try {
    return execFileSync(binPath, [arg], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      // execFileSync's `timeout` only SENDS the signal and then keeps waiting. A stuck or
      // hostile binary that ignores SIGTERM would survive it and block the server.
      killSignal: 'SIGKILL',
    })
      .trim()
      .slice(0, MAX_VERSION_OUTPUT);
  } catch (err) {
    console.warn(`[${logPrefix}] Ignoring ${binPath}: "${arg}" failed (${(err as Error).message})`);
    return null;
  }
}

/** What a candidate probe reports back. `version` is undefined when none was declared. */
export interface CliCandidateProbeResult {
  accepted: boolean;
  version?: string;
}

/** A probe hook, so tests can drive resolution without executing anything. */
export type CliCandidateProbe = (binPath: string, entry: CliEntry) => CliCandidateProbeResult;

/**
 * The production probe: identity first, then version. A CLI declaring neither is accepted
 * on existence alone, which is the common case (opencode, codex, gemini, antigravity).
 */
export function probeCliCandidate(binPath: string, entry: CliEntry): CliCandidateProbeResult {
  const logPrefix = `CliResolver:${entry.id as string}`;
  const { identity, version } = entry.discovery;

  if (identity) {
    const pattern = compileVersionRegex(identity.regex);
    if (!pattern) {
      console.warn(`[${logPrefix}] identity.regex was rejected as unsafe; refusing every candidate.`);
      return { accepted: false };
    }
    const out = probeCommandOutput(binPath, identity.arg, logPrefix);
    if (out === null || !pattern.test(out)) {
      console.warn(`[${logPrefix}] Ignoring ${binPath}: "${identity.arg}" did not identify it as ${entry.label}.`);
      return { accepted: false };
    }
  }

  if (!version) return { accepted: true };

  const out = probeCommandOutput(binPath, version.arg, logPrefix);
  const pattern = version.regex ? compileVersionRegex(version.regex) : null;
  const found = out !== null && pattern ? (pattern.exec(out)?.[1] ?? undefined) : undefined;

  if (found === undefined && version.requireVersionMatch) {
    // A `which` hit is not evidence for a short, generic or squatted binary name.
    console.warn(`[${logPrefix}] Ignoring ${binPath}: "${version.arg}" printed ${JSON.stringify(out?.slice(0, 80))}`);
    return { accepted: false };
  }
  return { accepted: true, version: found };
}

/**
 * A resolver for one registry entry. An entry may declare several binary names (first hit
 * wins), so this holds one underlying resolver per name and returns the first that
 * resolves — which is also what keeps each name's own negative cache and backoff intact.
 */
interface RegistryResolver {
  resolveDir(): string | null;
  getVersion(): string | null;
  notFoundMessage(base: string): string;
}

function createRegistryResolver(
  entry: CliEntry,
  probe: CliCandidateProbe = probeCliCandidate,
  host?: CliResolverHost,
  now?: () => number
): RegistryResolver {
  const searchDirs = entry.discovery.searchDirs.map(expandHome);
  const perBinary: CliExecutableResolver<string>[] = entry.discovery.binaries.map((binary) =>
    createCliExecutableResolver<string>(
      {
        binary,
        searchDirs,
        validateCandidate: (binPath) => {
          const result = probe(binPath, entry);
          return result.accepted ? { accepted: true, metadata: result.version } : { accepted: false };
        },
        now,
      },
      host
    )
  );

  const first = () => {
    for (const resolver of perBinary) {
      const resolution = resolver.resolve();
      if (resolution) return resolution;
    }
    return null;
  };

  return {
    resolveDir: () => first()?.directory ?? null,
    getVersion: () => first()?.metadata ?? null,
    notFoundMessage: (base) =>
      // Diagnostics come from the FIRST declared binary: every name shares the same search
      // dirs, PATH and login shell, so the extra copies would say the same thing twice.
      perBinary.length > 0 ? formatCliNotFoundMessage(base, perBinary[0].diagnostics()) : base,
  };
}

/**
 * One memoized resolver per id, for the process lifetime — the same caching the per-CLI
 * modules already do for themselves, just keyed by id so generic code holding only a
 * `CliId` string can resolve a CLI it knows nothing else about, custom entries included.
 */
const resolvers = new Map<string, RegistryResolver>();

function resolverFor(id: string): RegistryResolver | null {
  const cached = resolvers.get(id);
  if (cached) return cached;
  const entry = getCli(id);
  // `shell` declares no binary: tmux-manager resolves the real login shell in code.
  if (!entry || entry.discovery.binaries.length === 0) return null;
  const resolver = createRegistryResolver(entry);
  resolvers.set(id, resolver);
  return resolver;
}

/**
 * Drop the memoized resolver for `id` so the next lookup re-probes from scratch instead of
 * replaying a cached negative result and waiting out a backoff window already in progress.
 */
export function invalidateCliResolverCache(id?: string): void {
  if (id === undefined) resolvers.clear();
  else resolvers.delete(id);
}

/** The directory containing this CLI's binary, or null when it cannot be found. */
export function resolveCliBinDir(id: string): string | null {
  return resolverFor(id)?.resolveDir() ?? null;
}

/** Is this CLI's binary present? Note: for a launcher CLI this is NOT the same as runnable. */
export function isCliAvailable(id: string): boolean {
  return resolveCliBinDir(id) !== null;
}

/** The version the resolved binary reported, or null when unresolved or none was declared. */
export function resolveCliVersion(id: string): string | null {
  return resolverFor(id)?.getVersion() ?? null;
}

/**
 * "CLI not found" message for `id`, with bounded PATH/login-shell/search-dir diagnostics
 * appended so the error names where resolution actually looked. Returns null for an id with
 * no binary to find (`shell`) or one that is not registered at all.
 */
export function missingCliMessage(id: string): string | null {
  const entry = getCli(id);
  if (!entry || entry.discovery.binaries.length === 0) return null;
  const install = resolveInstallCommandForPlatform(entry);
  const base = install
    ? `${entry.label} CLI not found. Install with: ${install}`
    : `${entry.label} CLI not found (looked for ${entry.discovery.binaries.join(', ')}).`;
  return resolverFor(id)?.notFoundMessage(base) ?? base;
}

/**
 * The version to stamp on a SESSION in this mode.
 *
 * ⚠️ Dispatched on DATA, not on an id, and the field it dispatches on is the one that
 * describes the difference: `discovery.version.retryOnTransientFailure`.
 *
 * Claude needs a probe policy no other CLI does. A single failed `claude --version` — a 5s
 * timeout, a PATH-starved systemd unit, a transient fs hiccup — used to be cached forever,
 * which silently disabled wheel-forwarding to Claude's own transcript for every session
 * until the server restarted (the only route to history in repaint mode: a dead wheel on
 * every device at once). `getClaudeCliVersion()` caches success forever and retries failure
 * with backoff, and that policy has to be preserved exactly, so this routes to it rather
 * than reimplementing it generically.
 *
 * Everything else goes through the ordinary registry resolver, which is the point: the
 * caller asks `cliNeedsVersionProbe()` whether this CLI gates anything on its version and
 * then asks HERE for that CLI's version. Before this, all three call sites asked
 * `cliNeedsVersionProbe()` a generic question and then called `getClaudeCliVersion()`
 * unconditionally — so the first non-claude entry to declare a `capabilities.gates` would
 * have had CLAUDE's version stamped on its sessions and its gate evaluated against it.
 */
export function resolveSessionCliVersion(mode: string): string | null {
  return getCli(mode)?.discovery.version?.retryOnTransientFailure ? getClaudeCliVersion() : resolveCliVersion(mode);
}
