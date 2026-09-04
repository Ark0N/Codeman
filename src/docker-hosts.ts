/**
 * @fileoverview Docker cases: storage, pure command-arg builders, and daemon probes.
 *
 * Docker mode is a LOCATION OVERLAY on cases (not a 6th SessionMode), the direct
 * analog of the remote-SSH feature in `remote-hosts.ts`. Instead of a local tmux
 * pane running `ssh host` into a durable remote tmux server, a local tmux pane
 * runs `docker exec -it` into a durable IN-CONTAINER tmux server. The container is
 * scoped to the CASE (`codeman-case-<name>`), so multiple sessions can `docker
 * exec` into the same long-lived container.
 *
 * This module mirrors `remote-hosts.ts`:
 *  - JSON storage for hosts (`docker-hosts.json`) and cases (`docker-cases.json`)
 *  - `toSessionDocker()` (mirror of `toSessionRemote`)
 *  - `buildDockerBaseArgs()` / `buildDockerCreateArgs()` (mirror of `buildSshConnectionArgs`)
 *  - `checkDockerAvailable()` / `checkDockerTmuxAvailable()` (mirror of `checkRemoteTmuxAvailable`)
 *
 * The launch/kill command orchestration (`buildDockerLaunchCommand`,
 * `buildDockerKillCommand`, `dockerTmuxSessionName`) lives in `tmux-manager.ts`,
 * mirroring where `buildRemoteLaunchCommand` lives.
 *
 * @module docker-hosts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getCli } from './config/cli-registry/registry.js';
import { STOCK_CLIS } from './config/cli-registry/stock.js';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dataPath } from './config/instance.js';
import type {
  DockerCase,
  DockerEngine,
  DockerHost,
  DockerNetworkMode,
  DockerResourceLimits,
  SessionDocker,
  SessionMode,
} from './types.js';

const execFileAsync = promisify(execFile);

/** Under vitest, all real `docker` invocations no-op (mirror of tmux-manager's IS_TEST_MODE). */
const IS_TEST_MODE = !!process.env.VITEST;

const DOCKER_HOSTS_FILE = 'docker-hosts.json';
const DOCKER_CASES_FILE = 'docker-cases.json';

/** Locally-built base image (see scripts/build-agent-image.mjs). */
export const DEFAULT_AGENT_IMAGE = 'codeman/agent:base';

/** HOME inside the base image (the `agent` user). Cred mounts + hook-secret land under it. */
export const CONTAINER_HOME = '/home/agent';

/** Per-case container name prefix. The `case` letters deliberately do NOT matter to
 * tmux; this is a DOCKER name (`^[a-zA-Z0-9][a-zA-Z0-9_.-]+$`), and case names are
 * already validated `^[a-zA-Z0-9_-]+$`, so `codeman-case-<name>` is always valid. */
const CONTAINER_NAME_PREFIX = 'codeman-case-';

/** Sensible resource defaults (all overridable per host). */
export const DEFAULT_DOCKER_RESOURCES: DockerResourceLimits = {
  memory: '4g',
  cpus: '2',
  pidsLimit: 512,
  nofile: '4096:8192',
};

// ========== Storage (mirror of remote-hosts.ts) ==========

export function dockerHostsPath(configDir: string): string {
  return join(configDir, DOCKER_HOSTS_FILE);
}

export function dockerCasesPath(configDir: string): string {
  return join(configDir, DOCKER_CASES_FILE);
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonArray<T>(configDir: string, path: string, value: T[]): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}

export async function readDockerHosts(configDir: string): Promise<DockerHost[]> {
  return readJsonArray<DockerHost>(dockerHostsPath(configDir));
}

export async function writeDockerHosts(configDir: string, hosts: DockerHost[]): Promise<void> {
  await writeJsonArray(configDir, dockerHostsPath(configDir), hosts);
}

export async function readDockerCases(configDir: string): Promise<DockerCase[]> {
  return readJsonArray<DockerCase>(dockerCasesPath(configDir));
}

export async function writeDockerCases(configDir: string, cases: DockerCase[]): Promise<void> {
  await writeJsonArray(configDir, dockerCasesPath(configDir), cases);
}

/**
 * Persist the case's last Claude conversation id (the `--resume` seed for the
 * container-recreated relaunch, docs/docker-cases-plan.md two-layer durability).
 * Keyed by container name so callers that only hold a SessionDocker can update it.
 * No-op when the id is unchanged or the case is gone.
 */
export async function persistDockerCaseClaudeSessionId(
  configDir: string,
  containerName: string,
  claudeSessionId: string
): Promise<void> {
  const cases = await readDockerCases(configDir);
  const idx = cases.findIndex((c) => (c.container ?? dockerContainerName(c.name)) === containerName);
  if (idx === -1 || cases[idx].lastClaudeSessionId === claudeSessionId) return;
  cases[idx] = { ...cases[idx], lastClaudeSessionId: claudeSessionId };
  await writeDockerCases(configDir, cases);
}

// ========== Naming / display / defaults ==========

/** Per-case container name. Mirrors how remote derives a stable name from the case. */
export function dockerContainerName(caseName: string): string {
  return `${CONTAINER_NAME_PREFIX}${caseName}`;
}

/**
 * Default in-container pane command per CLI mode (mirror of defaultRemoteCommandForMode).
 *
 * ⚠️ Read from the registry (`overlays.docker`), not from a hardcoded
 * `Record<DockerCommandMode, string>`. That table duplicated the registry exactly with
 * nothing keeping the two in step. `shell` is the one arm still written here, because it is
 * the entry that declares `docker: { disabled: true }` — a container has no per-user login
 * shell to resolve, so it gets a plain `bash -l` rather than a CLI invocation.
 */
export function defaultDockerCommandForMode(mode: SessionMode): string {
  const entry = getCli(mode);
  const overlay = entry?.overlays.docker;
  if (!entry || (overlay && 'disabled' in overlay)) return 'exec bash -l';
  // Mirrors the LOCAL default for each CLI; claude's carries
  // `--dangerously-skip-permissions` so the in-container agent runs non-interactively.
  const cli = overlay?.command ?? entry.discovery.binaries[0];
  return cli ? `exec ${cli}` : 'exec bash -l';
}

/** `container:/workdir` display string (mirror of remoteDisplayPath's `user@host:path`). */
export function dockerDisplayPath(
  docker: Pick<SessionDocker, 'containerName' | 'containerWorkdir'> | { container: string; path: string }
): string {
  if ('containerName' in docker) return `${docker.containerName}:${docker.containerWorkdir}`;
  return `${docker.container}:${docker.path}`;
}

/**
 * The host-callback gateway alias is ENGINE-SPECIFIC: Docker exposes the host as
 * `host.docker.internal`, Podman as `host.containers.internal`. Both are added to
 * the host-guard allowlist so a mixed fleet keeps working.
 */
export function hostGatewayAlias(engine: DockerEngine): string {
  return engine === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
}

/**
 * Rewrite the server's own `CODEMAN_API_URL` to a container-reachable one by
 * swapping ONLY the hostname for the engine's host-gateway alias, preserving
 * scheme AND port (prod is HTTPS on 3000, so hardcoding http://…:3000 breaks
 * every hook). Falls back to `https://<alias>:3000` when the input is absent or
 * unparseable.
 */
export function containerApiUrl(processApiUrl: string | undefined, engine: DockerEngine): string {
  const alias = hostGatewayAlias(engine);
  if (!processApiUrl) return `https://${alias}:3000`;
  try {
    const url = new URL(processApiUrl);
    url.hostname = alias;
    // origin drops any trailing path/slash and keeps scheme + (non-default) port
    return url.origin;
  } catch {
    return `https://${alias}:3000`;
  }
}

/**
 * Stable hash of the drift-relevant `docker create` inputs, stored on the
 * container as the `codeman.confighash` label. On launch, a mismatch between the
 * desired hash and the running container's label triggers the recreate-on-drift
 * prompt (host config edits actually take effect).
 */
export function dockerConfigHash(
  docker: Pick<
    SessionDocker,
    | 'engine'
    | 'image'
    | 'containerWorkdir'
    | 'network'
    | 'networkName'
    | 'resources'
    | 'gpus'
    | 'mountCredentials'
    | 'extraCreateArgs'
  >
): string {
  const normalized = JSON.stringify({
    engine: docker.engine,
    image: docker.image,
    containerWorkdir: docker.containerWorkdir,
    network: docker.network,
    networkName: docker.networkName ?? null,
    resources: docker.resources ?? null,
    gpus: docker.gpus ?? null,
    mountCredentials: docker.mountCredentials,
    extraCreateArgs: docker.extraCreateArgs ?? null,
  });
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * Build the flattened per-session Docker metadata from a host profile + a case,
 * resolving every default (mirror of toSessionRemote). The `configHash` is
 * computed last over the resolved values.
 */
export function toSessionDocker(host: DockerHost, dockerCase: DockerCase): SessionDocker {
  const engine: DockerEngine = host.engine ?? 'docker';
  const containerWorkdir = dockerCase.containerWorkdir ?? dockerCase.hostWorkspacePath;
  const base: Omit<SessionDocker, 'configHash'> = {
    hostId: host.id,
    label: host.label,
    engine,
    image: host.image || DEFAULT_AGENT_IMAGE,
    containerName: dockerCase.container ?? dockerContainerName(dockerCase.name),
    hostWorkspacePath: dockerCase.hostWorkspacePath,
    containerWorkdir,
    network: host.network ?? 'bridge',
    networkName: host.networkName,
    resources: host.resources ?? DEFAULT_DOCKER_RESOURCES,
    gpus: host.gpus,
    mountCredentials: host.mountCredentials ?? true,
    hooksEnabled: host.hooksEnabled ?? true,
    resumeOnStart: host.resumeOnStart ?? true,
    daemonHost: host.daemonHost,
    context: host.context,
    commands: host.commands,
    extraCreateArgs: host.extraCreateArgs,
    extraExecArgs: host.extraExecArgs,
  };
  return { ...base, configHash: dockerConfigHash(base) };
}

// ========== Shell escaping ==========

/**
 * POSIX single-quote shell-escaping (end-quote, escaped-quote, restart-quote).
 * Mirror of the helper in remote-hosts.ts / tmux-manager.ts. Every dynamic value
 * interpolated into the outer `bash -c "..."` launch layer is escaped through
 * this so a path with spaces stays a single shell token. Operator-entered fields
 * are ALSO schema-rejected for `$`/backtick (NO_SHELL_META) as defense in depth.
 */
export function shellescape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ========== Pure command-arg builders ==========

/** A resolved bind mount (source existence already checked by the caller). */
export interface DockerMount {
  src: string;
  dst: string;
  readonly?: boolean;
}

/**
 * Resolve a bind source into the Docker daemon's filesystem namespace.
 *
 * A bare-host Codeman process and its Docker daemon see the same HOME, so the
 * source is returned unchanged. In Docker-outside-of-Docker deployments,
 * `runtimeHome` is the path inside Codeman while `daemonHome` is the host path
 * bind-mounted there. Sources beneath HOME must therefore be translated before
 * they are sent through the Docker socket.
 */
export function resolveDockerDaemonMountSource(source: string, runtimeHome: string, daemonHome?: string): string {
  const configuredDaemonHome = daemonHome?.trim();
  if (!configuredDaemonHome) return source;

  const relativeSource = relative(resolve(runtimeHome), resolve(source));
  if (relativeSource.startsWith('..') || isAbsolute(relativeSource)) return source;
  return resolve(configuredDaemonHome, relativeSource);
}

/**
 * Resolved, IO-free context for buildDockerCreateArgs. The caller (tmux-manager)
 * resolves the environment-dependent bits (host uid, existing cred mounts, the
 * derived api url, Desktop detection) so this builder stays pure and unit-testable.
 */
export interface DockerCreateContext {
  docker: SessionDocker;
  /** Codeman session id (only the first 8 chars are used, for the codeman.session label). */
  sessionId: string;
  /** CODEMAN_INSTANCE ('' for prod) — scopes the boot reaper so a beta never reaps prod. */
  instance: string;
  /** Pre-resolved uid/userns tokens: ['--user','1000:0'] | ['--userns','keep-id'] | []. */
  userArgs: string[];
  /** Existing host credential bind mounts (convenient mode). Empty in sealed mode. */
  credentialMounts: DockerMount[];
  /** Extra bind mounts (e.g. the read-only hook-secret file). */
  extraMounts: DockerMount[];
  /** Create-time env (NON-secret, committed-safe): HOME, TERM, COLORTERM, CODEMAN_API_URL, CODEMAN_HOOK_SECRET_FILE. */
  envCreate: Record<string, string>;
  /** Whether to add `--add-host <alias>:host-gateway` (skipped on Docker Desktop, where the alias is native). */
  addHostGateway: boolean;
  /** Engine host-gateway alias (host.docker.internal / host.containers.internal). */
  gatewayAlias: string;
  /** Omit --memory-swap when the host kernel cannot enforce swap limits. */
  disableSwapLimit?: boolean;
}

/**
 * Engine prefix tokens shared by every docker invocation (mirror of
 * buildSshConnectionArgs). Returns e.g. ['docker'] or ['podman','--context','ctx'].
 */
export function buildDockerBaseArgs(docker: Pick<SessionDocker, 'engine' | 'context' | 'daemonHost'>): string[] {
  const parts: string[] = [docker.engine === 'podman' ? 'podman' : 'docker'];
  if (docker.context) parts.push('--context', shellescape(docker.context));
  if (docker.daemonHost) parts.push('-H', shellescape(docker.daemonHost));
  return parts;
}

function mountSpec(m: DockerMount): string {
  return `type=bind,src=${m.src},dst=${m.dst}${m.readonly ? ',readonly' : ''}`;
}

function resourceFlags(resources?: DockerResourceLimits, disableSwapLimit = false): string[] {
  if (!resources) return [];
  const flags: string[] = [];
  if (resources.memory) {
    flags.push('--memory', resources.memory);
    // memory-swap == memory disables swap where the daemon supports swap
    // accounting. Some kernels, including the deployed Unraid host, do not;
    // requesting it there emits a warning and Docker ignores the value.
    if (!disableSwapLimit) flags.push('--memory-swap', resources.memory);
  }
  if (resources.cpus) flags.push('--cpus', resources.cpus);
  if (resources.pidsLimit) flags.push('--pids-limit', String(resources.pidsLimit));
  if (resources.nofile) flags.push('--ulimit', `nofile=${resources.nofile}`);
  if (resources.shmSize) flags.push('--shm-size', resources.shmSize);
  return flags;
}

function networkArg(network: DockerNetworkMode, networkName?: string): string {
  if (network === 'custom' && networkName) return networkName;
  return network; // 'bridge' | 'none'
}

/**
 * Build the `docker create` token list (from `create` through the `sleep
 * infinity` CMD) for a long-lived, hardened, per-case container. PURE: every
 * dynamic value is shellescaped; the caller joins with spaces into the launch
 * string. Security invariants baked in: --cap-drop ALL, --security-opt
 * no-new-privileges, --pids-limit, --memory==--memory-swap, --init,
 * --pull=never, --restart no, NEVER --privileged, NEVER the docker socket.
 */
export function buildDockerCreateArgs(ctx: DockerCreateContext): string[] {
  const {
    docker,
    sessionId,
    instance,
    userArgs,
    credentialMounts,
    extraMounts,
    envCreate,
    addHostGateway,
    gatewayAlias,
  } = ctx;

  const args: string[] = [
    'create',
    '--name',
    shellescape(docker.containerName),
    '--label',
    'codeman.managed=1',
    '--label',
    shellescape(`codeman.instance=${instance}`),
    '--label',
    shellescape(`codeman.session=${sessionId.slice(0, 8)}`),
    '--label',
    shellescape(`codeman.confighash=${docker.configHash ?? dockerConfigHash(docker)}`),
    '--pull=never',
    '--init',
    '--restart',
    'no',
    ...userArgs,
    '--workdir',
    shellescape(docker.containerWorkdir),
    // Workspace bind: mirror the host path inside the container so the transcript
    // projHash correlates and file features read real host bytes.
    '--mount',
    shellescape(mountSpec({ src: docker.hostWorkspacePath, dst: docker.containerWorkdir })),
    ...credentialMounts.flatMap((m) => ['--mount', shellescape(mountSpec(m))]),
    ...extraMounts.flatMap((m) => ['--mount', shellescape(mountSpec(m))]),
  ];

  if (addHostGateway) args.push('--add-host', `${gatewayAlias}:host-gateway`);

  args.push(
    ...resourceFlags(docker.resources, ctx.disableSwapLimit),
    // GPU passthrough (needs the NVIDIA container toolkit on the host). No storage
    // cap is set, so the container's writable layer + volumes grow elastically as
    // data flows in (bounded only by host disk).
    ...(docker.gpus ? ['--gpus', shellescape(docker.gpus)] : []),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    networkArg(docker.network, docker.networkName)
  );

  for (const [key, value] of Object.entries(envCreate)) {
    args.push('--env', shellescape(`${key}=${value}`));
  }

  // Operator escape-hatch args (schema-validated NO_SHELL_INJECTION), escaped again here.
  for (const extra of docker.extraCreateArgs ?? []) {
    args.push(shellescape(extra));
  }

  args.push(shellescape(docker.image), 'sleep', 'infinity');
  return args;
}

/**
 * PURE argv for building the agent base image locally (the programmatic mirror of
 * scripts/build-agent-image.mjs): `build -f <dockerfile> -t <image> [--no-cache]
 * <contextDir>`. Kept pure + unit-testable; the caller prepends the engine binary.
 */
export function agentImageBuildArgs(
  dockerfile: string,
  image: string,
  contextDir: string,
  noCache = false,
  buildArgs: Array<[string, string]> = []
): string[] {
  return [
    'build',
    '-f',
    dockerfile,
    '-t',
    image,
    ...(noCache ? ['--no-cache'] : []),
    ...buildArgs.flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]),
    contextDir,
  ];
}

/**
 * npm packages the agent image installs in its shared layer, from the STOCK catalogue.
 *
 * ⚠️ Stock, deliberately, NOT the merged registry. A user's `~/.codeman/clis.json` must not
 * change what lands inside an image tagged `codeman/agent:base`, or two machines holding that
 * same tag hold different images and every cache-hit decision downstream is a lie.
 *
 * ⚠️ This mirrors `agentImageNpmPackages()` in `scripts/lib/cli-catalog.mjs`, which the CLI
 * build path uses because a `.mjs` cannot import TypeScript. Two producers of one command
 * line drift; `test/agent-image-build-args-parity.test.ts` is what stops them.
 */
export function agentImageNpmPackages(): string[] {
  return STOCK_CLIS.filter((entry) => entry.enabled && !AGENT_IMAGE_SPECIAL_CASE_IDS.has(entry.id as string))
    .map((entry) => entry.discovery.install.npmPackage)
    .filter((pkg): pkg is string => Boolean(pkg));
}

/**
 * CLIs the agent image installs in their OWN Dockerfile layer rather than the shared npm one.
 * The registry cannot express what makes each special, so the layers stay hand-written and
 * `test/docker-agent-image-coverage.test.ts` requires each to carry a reason and still exist.
 */
const AGENT_IMAGE_SPECIAL_CASE_IDS = new Set(['pi', 'deepseek']);

/** The `--build-arg` pairs the agent image takes. */
export function agentImageBuildArgPairs(): Array<[string, string]> {
  return [['CLI_NPM_PACKAGES', agentImageNpmPackages().join(' ')]];
}

// ========== Credential mount resolution (IO) ==========

/** Container Claude config dir (created gid-0 writable in the image). */
export const CONTAINER_CLAUDE_DIR = `${CONTAINER_HOME}/.claude`;
/** In-container path of the seeded (writable) `~/.claude.json`. */
export const CLAUDE_JSON_HOME = `${CONTAINER_HOME}/.claude.json`;
/** In-container path of the read-only host-seeded `~/.claude.json` (copied into HOME at launch). */
export const CLAUDE_JSON_SEED = `${CONTAINER_HOME}/.codeman/claude.seed.json`;
/** Read-only seed paths for the files copied into the container's `.claude`. */
const CLAUDE_CREDS_SEED = `${CONTAINER_HOME}/.codeman/claude-creds.seed.json`;
const CLAUDE_SETTINGS_SEED = `${CONTAINER_HOME}/.codeman/claude-settings.seed.json`;
const CLAUDE_STATS_SEED = `${CONTAINER_HOME}/.codeman/claude-stats.seed.json`;
/** Staging root for read-only host-cred seed mounts (codex/gemini/gcloud/opencode). */
const CRED_SEED_DIR = `${CONTAINER_HOME}/.codeman/cred-seeds`;

/**
 * PURE: merge the host `~/.claude.json` into a config that makes an
 * already-authenticated Claude skip its INTERACTIVE onboarding inside the container
 * (the host file itself lacks these flags — the host install is grandfathered, so a
 * verbatim copy still triggers the theme picker + login wizard + folder-trust
 * prompt). Forces `hasCompletedOnboarding`, a `theme` (so the theme picker is
 * skipped), and marks the workspace project trusted + onboarded. Auth still comes
 * from the copied `oauthAccount` + the dir-mounted `~/.claude/.credentials.json`.
 */
export function buildSeamlessClaudeConfig(
  hostConfig: Record<string, unknown>,
  workspacePath: string,
  theme = 'dark'
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...hostConfig };
  merged.hasCompletedOnboarding = true;
  if (typeof merged.theme !== 'string') merged.theme = theme;
  const projects = { ...((merged.projects as Record<string, Record<string, unknown>> | undefined) ?? {}) };
  const existing = (projects[workspacePath] as Record<string, unknown> | undefined) ?? {};
  const seenCount = existing.projectOnboardingSeenCount;
  projects[workspacePath] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
    projectOnboardingSeenCount: typeof seenCount === 'number' && seenCount > 0 ? seenCount : 1,
  };
  merged.projects = projects;
  return merged;
}

/** Best-effort read of the host `~/.claude/settings.json` theme (drives the seed's theme). */
function readHostClaudeTheme(home: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')) as { theme?: unknown };
    return typeof parsed.theme === 'string' ? parsed.theme : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the read-only seed mount for `~/.claude.json`. Reads the host file, merges
 * in the seamless-onboarding flags + workspace trust (buildSeamlessClaudeConfig),
 * writes the result to a per-container seed file under `~/.codeman/docker-seeds/`,
 * and returns its mount. The launch chain copies it to `~/.claude.json` inside HOME
 * once — giving Claude a NORMAL writable, already-onboarded config (no atomic-rename
 * EBUSY, no re-auth, no theme/trust prompts). Falls back to the RAW host file when
 * parse/write fails (auth still works; the wizard may show). Returns null when the
 * host has no `~/.claude.json`. IO; under VITEST returns the raw mount (no write).
 */
export function resolveClaudeJsonSeedMount(
  home: string = homedir(),
  containerName?: string,
  workspacePath?: string
): DockerMount | null {
  const src = join(home, '.claude.json');
  if (!existsSync(src)) return null;
  const rawMount: DockerMount = { src, dst: CLAUDE_JSON_SEED, readonly: true };
  if (IS_TEST_MODE || !containerName || !workspacePath) return rawMount;
  try {
    const hostConfig = JSON.parse(readFileSync(src, 'utf-8')) as Record<string, unknown>;
    const merged = buildSeamlessClaudeConfig(hostConfig, workspacePath, readHostClaudeTheme(home) ?? 'dark');
    const seedsDir = dataPath('docker-seeds');
    if (!existsSync(seedsDir)) mkdirSync(seedsDir, { recursive: true });
    const seedFile = join(seedsDir, `${containerName}.json`);
    writeFileSync(seedFile, JSON.stringify(merged), { mode: 0o600 });
    return { src: seedFile, dst: CLAUDE_JSON_SEED, readonly: true };
  } catch {
    return rawMount; // partial host write / unreadable — auth still carries, wizard may show
  }
}

/** A file (or dir, when `recursive`) copied into the container HOME once at launch
 *  (`[ -e to ] || cp [-a] from to`). */
export interface DockerSeedCopy {
  from: string;
  to: string;
  /** `cp -a` for whole-directory credential seeds (gemini/gcloud/opencode). */
  recursive?: boolean;
}

export interface DockerClaudeArtifacts {
  /** Bind mounts to add: the shared `projects/` transcripts (RW) + read-only seed files. */
  mounts: DockerMount[];
  /** Files copied into the container's writable HOME/.claude (+ HOME/.claude.json) at launch. */
  seedCopies: DockerSeedCopy[];
}

/**
 * Resolve the ISOLATED Claude artifacts for a docker session (replaces the old
 * whole-`~/.claude` RW mount that polluted the host). Shares ONLY what must cross
 * the boundary and seeds the rest as writable copies:
 *  - `~/.claude/projects` → RW dir mount (transcripts: host watchers + `--resume`).
 *  - `~/.claude.json` → merged onboarding seed, copied to HOME (no re-auth/wizard).
 *  - `~/.claude/.credentials.json` + `~/.claude/settings.json` → read-only seeds
 *    copied into the container's own `~/.claude` (token + global prefs carry in;
 *    the container refreshes its own copy and never writes back to the host).
 * Everything else Claude writes (backups, tasks, teams, session-env, history) stays
 * container-local. IO (reads host files, writes the merged `.claude.json` seed).
 */
export function resolveDockerClaudeArtifacts(
  home: string,
  containerName: string,
  workspacePath: string
): DockerClaudeArtifacts {
  const mounts: DockerMount[] = [];
  const seedCopies: DockerSeedCopy[] = [];

  // The ONE genuinely-shared part: conversation transcripts (dir mount → renames work).
  const projectsSrc = join(home, '.claude', 'projects');
  if (existsSync(projectsSrc)) {
    mounts.push({ src: projectsSrc, dst: `${CONTAINER_CLAUDE_DIR}/projects` });
  }

  // ~/.claude.json → merged, onboarding-complete seed at HOME root.
  const jsonSeed = resolveClaudeJsonSeedMount(home, containerName, workspacePath);
  if (jsonSeed) {
    mounts.push(jsonSeed);
    seedCopies.push({ from: CLAUDE_JSON_SEED, to: CLAUDE_JSON_HOME });
  }

  // credentials (token) + settings (theme/model/effort/permissions) + stats-cache
  // (drives the model/effort status indicator) → writable copies inside the
  // container's own ~/.claude (never a wholesale mount → no host pollution).
  const files: Array<[rel: string, seed: string, dest: string]> = [
    ['.credentials.json', CLAUDE_CREDS_SEED, `${CONTAINER_CLAUDE_DIR}/.credentials.json`],
    ['settings.json', CLAUDE_SETTINGS_SEED, `${CONTAINER_CLAUDE_DIR}/settings.json`],
    ['stats-cache.json', CLAUDE_STATS_SEED, `${CONTAINER_CLAUDE_DIR}/stats-cache.json`],
  ];
  for (const [rel, seed, dest] of files) {
    const src = join(home, '.claude', rel);
    if (existsSync(src)) {
      mounts.push({ src, dst: seed, readonly: true });
      seedCopies.push({ from: seed, to: dest });
    }
  }

  return { mounts, seedCopies };
}

/**
 * Per-CLI credential-store isolation policy (the codex/gemini/gcloud/opencode analog
 * of resolveDockerClaudeArtifacts). Codex is the direct Claude-analog: its
 * `sessions/` rollouts + `history.jsonl` are read HOST-SIDE (response-viewer +
 * `codex resume`), so they are SHARED (RW), while `auth.json`/`config.toml` are
 * seeded. The other three have no host-read/resume dependency and are fully
 * seed-copied (writable copy in the container, no write-back to the host).
 */
interface CredStorePolicy {
  /** Path relative to HOME (host + container), e.g. '.codex' or '.config/gcloud'. */
  rel: string;
  /** Subdirs bind-mounted RW (shared: resume + host reads). */
  shareDirs?: string[];
  /** Files bind-mounted RW (append-only, e.g. codex history.jsonl — never renamed). */
  shareFiles?: string[];
  /** Files seeded (RO mount → cp) into the container's own copy. */
  seedFiles?: string[];
  /** Seed the WHOLE dir (RO mount → cp -a) — for stores with no shared/host-read state. */
  seedWhole?: boolean;
}

const CRED_STORES: CredStorePolicy[] = [
  { rel: '.codex', shareDirs: ['sessions'], shareFiles: ['history.jsonl'], seedFiles: ['auth.json', 'config.toml'] },
  // Also covers Antigravity: `agy` nests its whole state (auth `jetski_state.pbtxt`,
  // `conversations/`, `knowledge/`) under `~/.gemini/antigravity-cli/`, so it needs no
  // entry of its own. There is no `~/.antigravity` credential dir to add.
  { rel: '.gemini', seedWhole: true },
  // Pi (pi.dev) keeps auth + config in `~/.pi/agent`, but that dir ALSO holds
  // `sessions/`, `extensions/`, `skills/` and the installed package trees
  // (`npm/`, `git/`) — easily gigabytes on an active host, so seedWhole would
  // `cp -a` all of it into every container start. Seed only what pi needs to
  // authenticate and behave consistently; `models.json` is in the list because it
  // holds user-defined custom providers. Consequence to document: in-container pi
  // sessions are invisible host-side, so `pi -c` inside a Docker case only sees
  // that container's own history (unlike codex, whose `sessions/` is shared RW
  // precisely because Codeman reads it host-side).
  {
    rel: '.pi/agent',
    seedFiles: ['auth.json', 'settings.json', 'trust.json', 'models.json', 'models-store.json'],
  },
  // Grok (xAI) keeps auth + config in `~/.grok`, but that dir ALSO holds
  // `sessions/`, `memory/`, `downloads/` (the ~100MB binary itself) and `bin/`,
  // so seedWhole would copy all of it into every container start. Seed only what
  // grok needs to authenticate and behave consistently. Same trade-off as pi:
  // in-container grok sessions are invisible host-side, so `grok -c` inside a
  // Docker case only sees that container's own history.
  {
    rel: '.grok',
    seedFiles: ['auth.json', 'config.toml', 'pager.toml'],
  },
  // DeepSeek Harness keeps credentials in `~/.dsh/.env` (0600) and composition in
  // `settings.yaml` / `cordis.patch.yml`. `profiles/` is deliberately NOT seeded:
  // it is a pnpm workspace holding a full node_modules tree per profile, which is
  // both enormous and host-arch-specific. An in-container dsh therefore needs its
  // profile installed IN the image (see docker/agent.Dockerfile), and the seeded
  // files only supply auth and model composition. Same host-invisibility trade-off
  // as pi and grok: `~/.dsh/sessions` inside a container is that container's own.
  {
    rel: '.dsh',
    seedFiles: ['.env', 'settings.yaml', 'cordis.patch.yml'],
  },
  { rel: '.config/gcloud', seedWhole: true },
  { rel: '.config/opencode', seedWhole: true },
  // OMP keeps its config in `~/.omp/agent` (config.yml/mcp.json/models.yml/
  // settings.yml — small, no bigger than grok's config.toml/pager.toml), but
  // that dir ALSO holds agent.db/history.db/models.db (SQLite caches) and
  // terminal-sessions/blobs/cache (large, regenerable), so seed only the
  // config files. UNLIKE pi/grok, `sessions/` is SHARED (RW), not
  // host-invisible: Codeman reads `~/.omp/agent/sessions/**/*.jsonl`
  // HOST-SIDE for history recovery and --resume pinning
  // (omp-transcript.ts, omp-session-resolver.ts) — the same reason codex's
  // `sessions/` is shared rather than seeded. Without this, an in-container
  // OMP conversation would be invisible to Codeman's own history-scan/resume
  // logic, silently breaking the kill-survival feature for Docker cases.
  {
    rel: '.omp/agent',
    shareDirs: ['sessions'],
    seedFiles: ['config.yml', 'mcp.json', 'models.yml', 'settings.yml'],
  },
];

/**
 * Resolve the ISOLATED codex/gemini/gcloud/opencode artifacts (replaces the old
 * whole-dir RW mounts that let each in-container CLI write its refreshed tokens +
 * session state back into the host). Every path is existsSync-gated (on most hosts
 * only a subset exists). Pure-ish IO (no writes; just existence checks + mount specs).
 */
export function resolveDockerCredentialArtifacts(home: string = homedir()): DockerClaudeArtifacts {
  const mounts: DockerMount[] = [];
  const seedCopies: DockerSeedCopy[] = [];
  for (const store of CRED_STORES) {
    const hostBase = join(home, store.rel);
    if (!existsSync(hostBase)) continue;
    const containerBase = `${CONTAINER_HOME}/${store.rel}`;
    const seedName = store.rel.replace(/\//g, '-'); // '.config/gcloud' → '.config-gcloud'
    if (store.seedWhole) {
      const seed = `${CRED_SEED_DIR}/${seedName}`;
      mounts.push({ src: hostBase, dst: seed, readonly: true });
      seedCopies.push({ from: seed, to: containerBase, recursive: true });
      continue;
    }
    for (const sub of store.shareDirs ?? []) {
      const src = join(hostBase, sub);
      if (existsSync(src)) mounts.push({ src, dst: `${containerBase}/${sub}` });
    }
    for (const file of store.shareFiles ?? []) {
      const src = join(hostBase, file);
      if (existsSync(src)) mounts.push({ src, dst: `${containerBase}/${file}` });
    }
    for (const file of store.seedFiles ?? []) {
      const src = join(hostBase, file);
      if (existsSync(src)) {
        const seed = `${CRED_SEED_DIR}/${seedName}-${file}`;
        mounts.push({ src, dst: seed, readonly: true });
        seedCopies.push({ from: seed, to: `${containerBase}/${file}` });
      }
    }
  }
  return { mounts, seedCopies };
}

// ========== Daemon probes (IO; no-op under VITEST) ==========

/**
 * UNESCAPED argv prefix for execFile-based probes. The shellescaped
 * buildDockerBaseArgs variant is for interpolation into the `bash -c` launch
 * string; argv arrays must NOT carry literal quotes (mirror of docker-export's
 * dockerArgv).
 */
function dockerEngineArgv(docker: Pick<SessionDocker, 'engine' | 'context' | 'daemonHost'>): string[] {
  const argv: string[] = [docker.engine === 'podman' ? 'podman' : 'docker'];
  if (docker.context) argv.push('--context', docker.context);
  if (docker.daemonHost) argv.push('-H', docker.daemonHost);
  return argv;
}

export interface DockerDriftStatus {
  /** Container exists (daemon reachable AND a container with this name is present). */
  exists: boolean;
  running: boolean;
  /** The desired configHash no longer matches the container's codeman.confighash label. */
  drifted: boolean;
  currentHash?: string;
}

/**
 * Drift check (docs/docker-cases-plan.md §4): compare the DESIRED configHash
 * against the existing container's `codeman.confighash` label so docker-host
 * config edits actually take effect instead of being silently ignored by the
 * idempotent inspect-or-create launch chain. `exists:false` (no container /
 * daemon down) means there is nothing to drift. No-op under VITEST.
 */
export async function checkDockerConfigDrift(
  docker: Pick<SessionDocker, 'engine' | 'context' | 'daemonHost' | 'containerName' | 'configHash'>
): Promise<DockerDriftStatus> {
  if (IS_TEST_MODE) return { exists: false, running: false, drifted: false };
  const argv = dockerEngineArgv(docker);
  try {
    const { stdout } = await execFileAsync(
      argv[0],
      [
        ...argv.slice(1),
        'inspect',
        '-f',
        '{{.State.Running}}\t{{index .Config.Labels "codeman.confighash"}}',
        docker.containerName,
      ],
      { timeout: DOCKER_PROBE_TIMEOUT_MS }
    );
    const [running = '', hash = ''] = stdout.trim().split('\t');
    return { exists: true, running: running === 'true', drifted: hash !== docker.configHash, currentHash: hash };
  } catch {
    return { exists: false, running: false, drifted: false };
  }
}

/**
 * `docker rm -f` the case container (the recreate-on-drift confirm action; the
 * launch chain recreates it with the new config on next start). Workspace +
 * transcripts ride bind mounts and survive; the conversation resumes via the
 * case's lastClaudeSessionId. No-op under VITEST.
 */
export async function removeDockerContainer(
  docker: Pick<SessionDocker, 'engine' | 'context' | 'daemonHost' | 'containerName'>
): Promise<void> {
  if (IS_TEST_MODE) return;
  const argv = dockerEngineArgv(docker);
  await execFileAsync(argv[0], [...argv.slice(1), 'rm', '-f', docker.containerName], { timeout: 30_000 });
}

export interface DockerAvailability {
  ok: boolean;
  engine: DockerEngine;
  rootless: boolean;
  isDesktop: boolean;
  cgroupV2: boolean;
  /** Best-effort: are --memory/--cpus/--pids-limit actually enforced on this engine? */
  capsEnforced: boolean;
  error?: string;
}

const DOCKER_PROBE_TIMEOUT_MS = 15_000;

interface DockerInfoJson {
  ServerVersion?: string;
  CgroupVersion?: string;
  SecurityOptions?: string[];
  OperatingSystem?: string;
  OSType?: string;
  Name?: string;
}

async function runDockerInfo(engine: DockerEngine): Promise<DockerInfoJson | null> {
  try {
    const { stdout } = await execFileAsync(engine, ['info', '--format', '{{json .}}'], {
      timeout: DOCKER_PROBE_TIMEOUT_MS,
    });
    return JSON.parse(stdout) as DockerInfoJson;
  } catch {
    return null;
  }
}

function classifyDockerInfo(engine: DockerEngine, info: DockerInfoJson): DockerAvailability {
  const security = info.SecurityOptions ?? [];
  const rootless = security.some((opt) => opt.includes('rootless'));
  const cgroupV2 = info.CgroupVersion === '2';
  const os = `${info.OperatingSystem ?? ''}`.toLowerCase();
  const isDesktop = os.includes('docker desktop') || os.includes('desktop');
  // Under rootless, resource caps are only reliably enforced with cgroup v2 +
  // systemd delegation. We can't detect delegation from `docker info`, so we
  // treat rootless+cgroupv2 as "likely enforced" and rootless+cgroupv1 as not.
  const capsEnforced = !rootless || cgroupV2;
  return { ok: true, engine, rootless, isDesktop, cgroupV2, capsEnforced };
}

/**
 * Probe the container engine: server up, cgroup version, rootless, Desktop, and
 * whether resource caps are enforceable. Auto-detects docker then podman when no
 * engine is given. No-op canned value under VITEST.
 */
export async function checkDockerAvailable(engine?: DockerEngine): Promise<DockerAvailability> {
  if (IS_TEST_MODE) {
    return {
      ok: true,
      engine: engine ?? 'docker',
      rootless: false,
      isDesktop: false,
      cgroupV2: true,
      capsEnforced: true,
    };
  }
  const candidates: DockerEngine[] = engine ? [engine] : ['docker', 'podman'];
  for (const candidate of candidates) {
    const info = await runDockerInfo(candidate);
    if (info) return classifyDockerInfo(candidate, info);
  }
  return {
    ok: false,
    engine: engine ?? 'docker',
    rootless: false,
    isDesktop: false,
    cgroupV2: false,
    capsEnforced: false,
    error: 'Docker/Podman not available. Install docker (or podman) and ensure the daemon is running.',
  };
}

/** Is the base image present on the host's daemon? (never triggers an auto-pull).
 *  Honors context/daemonHost so a remote-daemon host is probed on the RIGHT daemon. */
export async function checkDockerImagePresent(
  docker: Pick<SessionDocker, 'engine' | 'context' | 'daemonHost'>,
  image: string
): Promise<boolean> {
  if (IS_TEST_MODE) return true;
  const argv = dockerEngineArgv(docker);
  try {
    await execFileAsync(argv[0], [...argv.slice(1), 'image', 'inspect', '--format', '{{.Id}}', image], {
      timeout: DOCKER_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export interface EnsureImageResult {
  ok: boolean;
  /** true when this call actually ran a build (vs. the image already existing). */
  built: boolean;
  alreadyPresent: boolean;
  error?: string;
}

/** In-flight builds keyed by `engine:image`, so concurrent callers share ONE build. */
const inFlightImageBuilds = new Map<string, Promise<EnsureImageResult>>();

/**
 * Resolve the repo's Dockerfile + build context. Works from BOTH src (dev/tsx) and
 * dist/index.js (esbuild prod: dist sits at repo root), since both are one level
 * under the repo root. Returns null when the Dockerfile is absent (npm-global
 * installs don't ship docker/ — Docker cases are a git-clone feature).
 */
function resolveAgentDockerfile(): { dockerfile: string; contextDir: string } | null {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dockerfile = join(repoRoot, 'docker', 'agent.Dockerfile');
  return existsSync(dockerfile) ? { dockerfile, contextDir: repoRoot } : null;
}

/**
 * Ensure the agent base image exists, BUILDING it locally on first use so a missing
 * image is never a hard blocker (decision: "build locally on first use",
 * docs/docker-cases-plan.md). Idempotent, concurrency-safe (one build per
 * engine:image shared by concurrent callers), and a no-op under VITEST. Only the
 * DEFAULT image is auto-built — we can never build a user's custom ref, and the
 * `--pull=never` invariant forbids pulling. `onProgress` receives build output
 * lines for SSE surfacing.
 */
export async function ensureAgentBaseImage(
  docker: Pick<SessionDocker, 'engine' | 'context' | 'daemonHost'>,
  image: string,
  opts: { onProgress?: (line: string) => void; noCache?: boolean } = {}
): Promise<EnsureImageResult> {
  if (IS_TEST_MODE) return { ok: true, built: false, alreadyPresent: true };
  if (await checkDockerImagePresent(docker, image)) {
    return { ok: true, built: false, alreadyPresent: true };
  }
  if (image !== DEFAULT_AGENT_IMAGE) {
    return {
      ok: false,
      built: false,
      alreadyPresent: false,
      error: `image ${image} is not present and only ${DEFAULT_AGENT_IMAGE} is auto-built. Build or pull ${image} yourself.`,
    };
  }
  const key = `${docker.engine}:${image}`;
  const existing = inFlightImageBuilds.get(key);
  if (existing) return existing;
  const build = buildAgentImage(docker, image, opts).finally(() => inFlightImageBuilds.delete(key));
  inFlightImageBuilds.set(key, build);
  return build;
}

function buildAgentImage(
  docker: Pick<SessionDocker, 'engine' | 'context' | 'daemonHost'>,
  image: string,
  opts: { onProgress?: (line: string) => void; noCache?: boolean }
): Promise<EnsureImageResult> {
  const resolved = resolveAgentDockerfile();
  if (!resolved) {
    return Promise.resolve({
      ok: false,
      built: false,
      alreadyPresent: false,
      error: `docker/agent.Dockerfile not found in this install; clone the repo or build ${image} manually`,
    });
  }
  const argv = dockerEngineArgv(docker);
  const args = [
    ...argv.slice(1),
    ...agentImageBuildArgs(resolved.dockerfile, image, resolved.contextDir, opts.noCache, agentImageBuildArgPairs()),
  ];
  return new Promise<EnsureImageResult>((resolve) => {
    // async spawn (NEVER spawnSync) so a multi-minute build never wedges the event loop.
    const child = spawn(argv[0], args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (buf: Buffer) => {
      for (const line of buf.toString('utf-8').split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed) opts.onProgress?.(trimmed);
      }
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('error', (err) => {
      resolve({
        ok: false,
        built: false,
        alreadyPresent: false,
        error: `could not spawn ${argv[0]} build: ${err.message}`,
      });
    });
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true, built: true, alreadyPresent: false });
      else resolve({ ok: false, built: false, alreadyPresent: false, error: `${argv[0]} build failed (exit ${code})` });
    });
  });
}

export interface DockerTmuxCheckResult {
  ok: boolean;
  tmuxPath?: string;
  /** Distinguishes "image missing" (build it) from "tmux missing in image" (rebuild it). */
  imageMissing?: boolean;
  error?: string;
}

/**
 * Verify the base image is present AND contains tmux (a HARD prerequisite: the
 * in-container tmux is what makes reconnect durable). Never triggers a pull
 * (`--pull=never`). No-op under VITEST. Mirror of checkRemoteTmuxAvailable.
 */
export async function checkDockerTmuxAvailable(
  docker: Pick<SessionDocker, 'engine' | 'image' | 'context' | 'daemonHost'>
): Promise<DockerTmuxCheckResult> {
  if (IS_TEST_MODE) return { ok: true, tmuxPath: '/usr/bin/tmux' };
  if (!(await checkDockerImagePresent(docker, docker.image))) {
    return {
      ok: false,
      imageMissing: true,
      error: `image ${docker.image} not present (the default image is auto-built on first use; a custom image must be built or pulled first)`,
    };
  }
  const argv = dockerEngineArgv(docker);
  try {
    const { stdout } = await execFileAsync(
      argv[0],
      [...argv.slice(1), 'run', '--rm', '--pull=never', docker.image, 'sh', '-lc', 'command -v tmux'],
      { timeout: DOCKER_PROBE_TIMEOUT_MS }
    );
    const tmuxPath = stdout.trim();
    if (!tmuxPath) {
      return { ok: false, error: `base image ${docker.image} is missing tmux (required for durable sessions)` };
    }
    return { ok: true, tmuxPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `could not verify tmux in ${docker.image}: ${msg}` };
  }
}

/**
 * Resolve the host's IP on the default docker bridge (the address a container
 * reaches as `host.docker.internal`), so the server can bind a hooks-only listener
 * there and in-container hooks can call back. Defaults to the conventional
 * 172.17.0.1 when the inspect fails but docker is up; null when docker is absent.
 * No-op canned value under VITEST.
 */
export async function detectDockerBridgeGateway(engine: DockerEngine = 'docker'): Promise<string | null> {
  if (IS_TEST_MODE) return '172.17.0.1';
  const bin = engine === 'podman' ? 'podman' : 'docker';
  try {
    const { stdout } = await execFileAsync(
      bin,
      ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'],
      { timeout: DOCKER_PROBE_TIMEOUT_MS }
    );
    const ip = stdout.trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : '172.17.0.1';
  } catch {
    return null; // docker not available — nothing to bind
  }
}

/**
 * Instance-scoped boot reaper: `docker rm -f` any MANAGED container that belongs
 * to THIS instance (by the `codeman.instance` label) but whose case is no longer
 * in `docker-cases.json`. The instance scoping is what stops a beta from reaping
 * prod's containers (the cross-instance hazard). No-op under VITEST. Best-effort.
 */
export async function reapOrphanedDockerContainers(
  configDir: string,
  instance: string,
  engine: DockerEngine = 'docker'
): Promise<string[]> {
  if (IS_TEST_MODE) return [];
  const bin = engine === 'podman' ? 'podman' : 'docker';
  let rows: Array<{ name: string; inst: string }> = [];
  try {
    const { stdout } = await execFileAsync(
      bin,
      [
        'ps',
        '-a',
        '--filter',
        'label=codeman.managed=1',
        '--format',
        '{{.Names}}\t{{index .Labels "codeman.instance"}}',
      ],
      { timeout: DOCKER_PROBE_TIMEOUT_MS }
    );
    rows = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, inst = ''] = line.split('\t');
        return { name, inst };
      });
  } catch {
    return []; // daemon down / engine absent — nothing to reap
  }
  const cases = await readDockerCases(configDir);
  const expected = new Set(cases.map((c) => c.container ?? dockerContainerName(c.name)));
  const reaped: string[] = [];
  for (const { name, inst } of rows) {
    if (inst !== instance) continue; // only THIS instance's containers
    if (expected.has(name)) continue; // still referenced by a live case
    try {
      await execFileAsync(bin, ['rm', '-f', name], { timeout: DOCKER_PROBE_TIMEOUT_MS });
      reaped.push(name);
    } catch {
      /* best-effort */
    }
  }
  return reaped;
}

/**
 * Read the IN-CONTAINER Claude CLI version (`docker exec <container> claude
 * --version`). Feeds Session.cliVersion for docker sessions (the LOCAL claude
 * would report the wrong version and disable trackpad wheel-forwarding, #154).
 * Returns undefined on any failure. No-op under VITEST.
 */
export async function probeDockerCliVersion(
  docker: Pick<SessionDocker, 'engine' | 'containerName' | 'context' | 'daemonHost'>,
  mode: SessionMode
): Promise<string | undefined> {
  if (IS_TEST_MODE) return undefined;
  // ⚠️ The MODE NAME IS NOT ALWAYS THE BINARY NAME — `antigravity` runs `agy`. This used
  // to pass the mode straight through as the command, which would have probed a binary that
  // does not exist. Only claude reaches this today (it is the one CLI with a version gate),
  // so nothing was actually broken, but the registry is what makes it correct for the next
  // CLI that needs a version.
  const bin = getCli(mode)?.discovery.binaries[0];
  if (!bin) return undefined; // `shell` has no binary of its own
  const argv = dockerEngineArgv(docker);
  try {
    const { stdout } = await execFileAsync(
      argv[0],
      [...argv.slice(1), 'exec', docker.containerName, bin, '--version'],
      {
        timeout: DOCKER_PROBE_TIMEOUT_MS,
      }
    );
    const match = stdout.trim().match(/\d+\.\d+\.\d+/);
    return match ? match[0] : stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
