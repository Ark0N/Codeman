/**
 * Unit tests for the Docker cases storage + pure command-arg builders + probes
 * (src/docker-hosts.ts). Mirrors test/remote-hosts.test.ts. All docker IO no-ops
 * under VITEST, so probes return canned values and never spawn a real daemon.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentImageBuildArgs,
  buildDockerBaseArgs,
  buildDockerCreateArgs,
  buildSeamlessClaudeConfig,
  checkDockerAvailable,
  checkDockerImagePresent,
  checkDockerTmuxAvailable,
  CLAUDE_JSON_SEED,
  containerApiUrl,
  DEFAULT_AGENT_IMAGE,
  DEFAULT_DOCKER_RESOURCES,
  dockerConfigHash,
  dockerContainerName,
  dockerDisplayPath,
  defaultDockerCommandForMode,
  ensureAgentBaseImage,
  hostGatewayAlias,
  persistDockerCaseClaudeSessionId,
  probeDockerCliVersion,
  readDockerCases,
  readDockerHosts,
  resolveClaudeJsonSeedMount,
  resolveDockerClaudeArtifacts,
  resolveDockerCredentialArtifacts,
  resolveDockerDaemonMountSource,
  toSessionDocker,
  writeDockerCases,
  writeDockerHosts,
  type DockerCreateContext,
} from '../src/docker-hosts.js';
import type { DockerCase, DockerHost, SessionDocker } from '../src/types.js';

const HOST: DockerHost = { id: 'local', label: 'Local Docker', image: DEFAULT_AGENT_IMAGE };
const CASE: DockerCase = {
  name: 'myproj',
  type: 'docker',
  hostId: 'local',
  hostWorkspacePath: '/home/arkon/cases/myproj',
};

describe('docker-hosts storage', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-docker-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips hosts and cases through JSON storage', async () => {
    await writeDockerHosts(dir, [HOST]);
    await writeDockerCases(dir, [{ ...CASE, lastClaudeSessionId: 'abc-123' }]);
    expect(await readDockerHosts(dir)).toEqual([HOST]);
    const cases = await readDockerCases(dir);
    expect(cases[0].lastClaudeSessionId).toBe('abc-123');
  });

  it('returns [] for a missing file', async () => {
    expect(await readDockerHosts(dir)).toEqual([]);
    expect(await readDockerCases(dir)).toEqual([]);
  });

  it('persists the last Claude conversation id keyed by container name', async () => {
    await writeDockerCases(dir, [CASE, { ...CASE, name: 'other', container: 'custom-name' }]);
    await persistDockerCaseClaudeSessionId(dir, dockerContainerName(CASE.name), 'conv-1');
    await persistDockerCaseClaudeSessionId(dir, 'custom-name', 'conv-2');
    await persistDockerCaseClaudeSessionId(dir, 'no-such-container', 'conv-3'); // no-op
    const cases = await readDockerCases(dir);
    expect(cases.find((c) => c.name === 'myproj')?.lastClaudeSessionId).toBe('conv-1');
    expect(cases.find((c) => c.name === 'other')?.lastClaudeSessionId).toBe('conv-2');
    expect(cases.some((c) => c.lastClaudeSessionId === 'conv-3')).toBe(false);
  });
});

describe('naming / display / defaults', () => {
  it('derives a valid per-case container name', () => {
    expect(dockerContainerName('myproj')).toBe('codeman-case-myproj');
    // valid docker name charset: starts alnum, then [a-zA-Z0-9_.-]
    expect(dockerContainerName('my_proj-2')).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
  });

  it('maps each mode to a default pane command', () => {
    expect(defaultDockerCommandForMode('claude')).toBe('exec claude --dangerously-skip-permissions');
    expect(defaultDockerCommandForMode('shell')).toBe('exec bash -l');
    expect(defaultDockerCommandForMode('codex')).toBe('exec codex');
    expect(defaultDockerCommandForMode('gemini')).toBe('exec gemini');
  });

  it('formats a container:workdir display path from both shapes', () => {
    expect(dockerDisplayPath({ container: 'codeman-case-x', path: '/w' })).toBe('codeman-case-x:/w');
    const sd = toSessionDocker(HOST, CASE);
    expect(dockerDisplayPath(sd)).toBe('codeman-case-myproj:/home/arkon/cases/myproj');
  });
});

describe('hostGatewayAlias / containerApiUrl', () => {
  it('returns the engine-specific gateway alias', () => {
    expect(hostGatewayAlias('docker')).toBe('host.docker.internal');
    expect(hostGatewayAlias('podman')).toBe('host.containers.internal');
  });

  it('swaps only the hostname, preserving scheme and port', () => {
    expect(containerApiUrl('https://127.0.0.1:3000', 'docker')).toBe('https://host.docker.internal:3000');
    expect(containerApiUrl('http://127.0.0.1:3000', 'docker')).toBe('http://host.docker.internal:3000');
    expect(containerApiUrl('https://127.0.0.1:8443', 'docker')).toBe('https://host.docker.internal:8443');
    expect(containerApiUrl('https://127.0.0.1:3000', 'podman')).toBe('https://host.containers.internal:3000');
  });

  it('falls back to https://<alias>:3000 for absent or unparseable input', () => {
    expect(containerApiUrl(undefined, 'docker')).toBe('https://host.docker.internal:3000');
    expect(containerApiUrl('not a url', 'podman')).toBe('https://host.containers.internal:3000');
  });
});

describe('toSessionDocker / dockerConfigHash', () => {
  it('resolves every default (convenient, bridge, resume-on-start)', () => {
    const sd = toSessionDocker(HOST, CASE);
    expect(sd.engine).toBe('docker');
    expect(sd.image).toBe(DEFAULT_AGENT_IMAGE);
    expect(sd.containerName).toBe('codeman-case-myproj');
    expect(sd.hostWorkspacePath).toBe('/home/arkon/cases/myproj');
    expect(sd.containerWorkdir).toBe('/home/arkon/cases/myproj'); // mirror
    expect(sd.network).toBe('bridge');
    expect(sd.resources).toEqual(DEFAULT_DOCKER_RESOURCES);
    expect(sd.mountCredentials).toBe(true);
    expect(sd.hooksEnabled).toBe(true);
    expect(sd.resumeOnStart).toBe(true);
    expect(sd.configHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('honors host overrides and a custom container workdir', () => {
    const host: DockerHost = {
      ...HOST,
      engine: 'podman',
      network: 'none',
      mountCredentials: false,
      hooksEnabled: false,
      resumeOnStart: false,
    };
    const sd = toSessionDocker(host, { ...CASE, containerWorkdir: '/work', container: 'my-box' });
    expect(sd.engine).toBe('podman');
    expect(sd.network).toBe('none');
    expect(sd.mountCredentials).toBe(false);
    expect(sd.containerName).toBe('my-box');
    expect(sd.containerWorkdir).toBe('/work');
  });

  it('hash is stable for equal inputs and changes when a drift field changes', () => {
    const a = toSessionDocker(HOST, CASE);
    const b = toSessionDocker(HOST, CASE);
    expect(a.configHash).toBe(b.configHash);
    const c = toSessionDocker({ ...HOST, image: 'codeman/agent:other' }, CASE);
    expect(c.configHash).not.toBe(a.configHash);
    // lastClaudeSessionId is NOT a drift field
    expect(dockerConfigHash(a)).toBe(dockerConfigHash({ ...a }));
  });
});

describe('buildDockerBaseArgs', () => {
  it('defaults to docker with no extra flags', () => {
    expect(buildDockerBaseArgs({ engine: 'docker' })).toEqual(['docker']);
  });
  it('emits podman + context + daemon host', () => {
    const args = buildDockerBaseArgs({ engine: 'podman', context: 'remote', daemonHost: 'ssh://u@h' });
    expect(args[0]).toBe('podman');
    expect(args.join(' ')).toContain("--context 'remote'");
    expect(args.join(' ')).toContain("-H 'ssh://u@h'");
  });
});

describe('buildDockerCreateArgs', () => {
  function ctx(overrides: Partial<DockerCreateContext> = {}): DockerCreateContext {
    return {
      docker: toSessionDocker(HOST, CASE),
      sessionId: '1a2b3c4d5e6f',
      instance: '',
      userArgs: ['--user', '1000:0'],
      credentialMounts: [{ src: '/home/arkon/.claude', dst: '/home/agent/.claude' }],
      extraMounts: [
        { src: '/home/arkon/.codeman/hook-secret', dst: '/home/agent/.codeman/hook-secret', readonly: true },
      ],
      envCreate: { HOME: '/home/agent', CODEMAN_API_URL: 'https://host.docker.internal:3000' },
      addHostGateway: true,
      gatewayAlias: 'host.docker.internal',
      ...overrides,
    };
  }

  it('bakes in the security + lifecycle invariants', () => {
    const s = buildDockerCreateArgs(ctx()).join(' ');
    expect(s).toContain('--cap-drop ALL');
    expect(s).toContain('--security-opt no-new-privileges');
    expect(s).toContain('--pull=never');
    expect(s).toContain('--init');
    expect(s).toContain('--restart no');
    expect(s).toContain('--memory 4g --memory-swap 4g');
    expect(s).toContain('--pids-limit 512');
    expect(s).toContain('--ulimit nofile=4096:8192');
    expect(s).toContain('codeman.managed=1');
    expect(s).toContain("'codeman.session=1a2b3c4d'"); // first 8 chars only
    expect(s).toContain('--network bridge');
  });

  it('NEVER emits privileged mode or a docker-socket mount', () => {
    const s = buildDockerCreateArgs(ctx()).join(' ');
    expect(s).not.toContain('--privileged');
    expect(s).not.toContain('docker.sock');
  });

  it('ends with the image then the sleep-infinity CMD', () => {
    const args = buildDockerCreateArgs(ctx());
    expect(args.slice(-3)).toEqual([`'${DEFAULT_AGENT_IMAGE}'`, 'sleep', 'infinity']);
  });

  it('includes the resolved user args and the workspace bind', () => {
    const s = buildDockerCreateArgs(ctx()).join(' ');
    expect(s).toContain('--user 1000:0');
    expect(s).toContain("--mount 'type=bind,src=/home/arkon/cases/myproj,dst=/home/arkon/cases/myproj'");
  });

  it('shell-escapes a workspace path containing spaces into a single token', () => {
    const docker = toSessionDocker(HOST, { ...CASE, hostWorkspacePath: '/home/arkon/my cases/proj' });
    const args = buildDockerCreateArgs(ctx({ docker }));
    // the whole mount spec (with the space) is ONE single-quoted token
    expect(args).toContain("'type=bind,src=/home/arkon/my cases/proj,dst=/home/arkon/my cases/proj'");
    // and the workdir is single-quoted too
    expect(args).toContain("'/home/arkon/my cases/proj'");
  });

  it('adds the host-gateway only when requested', () => {
    expect(buildDockerCreateArgs(ctx({ addHostGateway: true })).join(' ')).toContain(
      '--add-host host.docker.internal:host-gateway'
    );
    expect(buildDockerCreateArgs(ctx({ addHostGateway: false })).join(' ')).not.toContain('--add-host');
  });

  it('omits credential mounts in sealed mode', () => {
    const s = buildDockerCreateArgs(ctx({ credentialMounts: [] })).join(' ');
    expect(s).not.toContain('/home/agent/.claude');
  });

  it('emits create-time env flags', () => {
    const s = buildDockerCreateArgs(ctx()).join(' ');
    expect(s).toContain("--env 'HOME=/home/agent'");
    expect(s).toContain("--env 'CODEMAN_API_URL=https://host.docker.internal:3000'");
  });

  it('uses the custom network name for custom mode', () => {
    const docker: SessionDocker = { ...toSessionDocker(HOST, CASE), network: 'custom', networkName: 'codeman-net-x' };
    expect(buildDockerCreateArgs(ctx({ docker })).join(' ')).toContain('--network codeman-net-x');
  });

  it('emits --gpus only when GPUs are requested (and never a storage cap)', () => {
    const withGpu: SessionDocker = { ...toSessionDocker(HOST, CASE), gpus: 'all' };
    const s = buildDockerCreateArgs(ctx({ docker: withGpu })).join(' ');
    expect(s).toContain("--gpus 'all'");
    // elastic disk: no fixed storage cap is ever emitted
    expect(s).not.toContain('--storage-opt');
    expect(buildDockerCreateArgs(ctx()).join(' ')).not.toContain('--gpus');
  });

  it('omits the unsupported swap limit while retaining the memory limit when disabled', () => {
    const s = buildDockerCreateArgs(ctx({ disableSwapLimit: true })).join(' ');
    expect(s).toContain('--memory 4g');
    expect(s).not.toContain('--memory-swap');
  });
});

describe('resolveDockerDaemonMountSource', () => {
  const runtimeHome = join(tmpdir(), 'codeman-runtime-home');
  const daemonHome = join(tmpdir(), 'codeman-daemon-home');

  it('maps paths beneath the runtime HOME into the daemon-visible HOME', () => {
    const source = join(runtimeHome, '.codeman', 'docker-seeds', 'codeman-case-test1.json');
    expect(resolveDockerDaemonMountSource(source, runtimeHome, daemonHome)).toBe(
      join(daemonHome, '.codeman', 'docker-seeds', 'codeman-case-test1.json')
    );
  });

  it('preserves direct-host and non-HOME sources', () => {
    const source = join(runtimeHome, '.claude', 'settings.json');
    expect(resolveDockerDaemonMountSource(source, runtimeHome)).toBe(source);

    const outsideHome = join(tmpdir(), 'codeman-cases', 'test1');
    expect(resolveDockerDaemonMountSource(outsideHome, runtimeHome, daemonHome)).toBe(outsideHome);
  });
});

describe('resolveDockerCredentialArtifacts (isolated codex/gemini/gcloud/opencode)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeman-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('NEVER whole-dir RW-mounts a credential store (no host pollution)', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.gemini'), { recursive: true });
    const { mounts } = resolveDockerCredentialArtifacts(home);
    // no wholesale RW mount at the store's HOME path
    expect(mounts.some((m) => m.dst === '/home/agent/.codex' && !m.readonly)).toBe(false);
    expect(mounts.some((m) => m.dst === '/home/agent/.gemini' && !m.readonly)).toBe(false);
  });

  it('codex: shares sessions/+history.jsonl RW, seeds auth.json/config.toml', () => {
    mkdirSync(join(home, '.codex', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.codex', 'history.jsonl'), '');
    writeFileSync(join(home, '.codex', 'auth.json'), '{}');
    writeFileSync(join(home, '.codex', 'config.toml'), '');
    const { mounts, seedCopies } = resolveDockerCredentialArtifacts(home);
    expect(mounts).toContainEqual({ src: join(home, '.codex', 'sessions'), dst: '/home/agent/.codex/sessions' });
    expect(mounts).toContainEqual({
      src: join(home, '.codex', 'history.jsonl'),
      dst: '/home/agent/.codex/history.jsonl',
    });
    const dests = seedCopies.map((s) => s.to);
    expect(dests).toContain('/home/agent/.codex/auth.json');
    expect(dests).toContain('/home/agent/.codex/config.toml');
    // seed copies of individual files are NOT recursive
    expect(seedCopies.filter((s) => s.to.startsWith('/home/agent/.codex')).every((s) => !s.recursive)).toBe(true);
  });

  it('gemini/gcloud/opencode: whole-dir seed-copy (cp -a, recursive)', () => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    mkdirSync(join(home, '.config', 'gcloud'), { recursive: true });
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    const { mounts, seedCopies } = resolveDockerCredentialArtifacts(home);
    // each is mounted read-only at a seed staging path and cp -a'd into the container HOME
    expect(seedCopies).toContainEqual({
      from: '/home/agent/.codeman/cred-seeds/.gemini',
      to: '/home/agent/.gemini',
      recursive: true,
    });
    expect(seedCopies).toContainEqual({
      from: '/home/agent/.codeman/cred-seeds/.config-gcloud',
      to: '/home/agent/.config/gcloud',
      recursive: true,
    });
    expect(mounts.filter((m) => m.readonly && m.dst.includes('cred-seeds')).length).toBeGreaterThanOrEqual(3);
  });

  /** Host files for both opt-in stores, present whether or not the switches are on. */
  function writeGhAzHostFiles(): void {
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), '');
    writeFileSync(join(home, '.config', 'gh', 'config.yml'), '');
    mkdirSync(join(home, '.azure'), { recursive: true });
    writeFileSync(join(home, '.azure', 'azureProfile.json'), '{}');
    writeFileSync(join(home, '.azure', 'msal_token_cache.json'), '{}');
  }
  const isGhOrAz = (p: string) => /\.azure|\.config[\\/]gh/.test(p);

  it('gh + az: the DEFAULT environment seeds neither, even when the host files exist', () => {
    writeGhAzHostFiles();
    for (const env of [{}, { CODEMAN_AGENT_IMAGE_INSTALL_GH: '0', CODEMAN_AGENT_IMAGE_INSTALL_AZ: '' }]) {
      const { mounts, seedCopies } = resolveDockerCredentialArtifacts(home, env);
      expect(mounts.filter((m) => isGhOrAz(m.src))).toEqual([]);
      expect(seedCopies.filter((s) => isGhOrAz(s.to))).toEqual([]);
    }
  });

  it('gh + az: each store follows ONLY its own switch, and only the exact value 1', () => {
    writeGhAzHostFiles();
    const dests = (env: NodeJS.ProcessEnv) => resolveDockerCredentialArtifacts(home, env).seedCopies.map((s) => s.to);
    const ghOnly = dests({ CODEMAN_AGENT_IMAGE_INSTALL_GH: '1' });
    expect(ghOnly).toContain('/home/agent/.config/gh/hosts.yml');
    expect(ghOnly.some((d) => d.includes('.azure'))).toBe(false);
    const azOnly = dests({ CODEMAN_AGENT_IMAGE_INSTALL_AZ: '1' });
    expect(azOnly).toContain('/home/agent/.azure/msal_token_cache.json');
    expect(azOnly.some((d) => d.includes('.config/gh'))).toBe(false);
    expect(
      dests({ CODEMAN_AGENT_IMAGE_INSTALL_GH: 'true', CODEMAN_AGENT_IMAGE_INSTALL_AZ: 'yes' }).some(isGhOrAz)
    ).toBe(false);
  });

  it('gh + az: seed only the sign-in files, never logs/extensions/caches', () => {
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), '');
    writeFileSync(join(home, '.config', 'gh', 'config.yml'), '');
    mkdirSync(join(home, '.azure', 'logs'), { recursive: true });
    mkdirSync(join(home, '.azure', 'cliextensions'), { recursive: true });
    writeFileSync(join(home, '.azure', 'azureProfile.json'), '{}');
    writeFileSync(join(home, '.azure', 'msal_token_cache.json'), '{}');
    writeFileSync(join(home, '.azure', 'config'), '');

    const { mounts, seedCopies } = resolveDockerCredentialArtifacts(home, {
      CODEMAN_AGENT_IMAGE_INSTALL_GH: '1',
      CODEMAN_AGENT_IMAGE_INSTALL_AZ: '1',
    });
    const dests = seedCopies.map((s) => s.to);
    expect(dests).toContain('/home/agent/.config/gh/hosts.yml');
    expect(dests).toContain('/home/agent/.config/gh/config.yml');
    expect(dests).toContain('/home/agent/.azure/azureProfile.json');
    expect(dests).toContain('/home/agent/.azure/msal_token_cache.json');
    expect(dests).toContain('/home/agent/.azure/config');
    // Absent files are skipped, and nothing outside the sign-in set is seeded.
    expect(dests).not.toContain('/home/agent/.azure/service_principal_entries.json');
    expect(dests.some((d) => d.includes('logs') || d.includes('cliextensions'))).toBe(false);
    expect(seedCopies.filter((s) => /\.azure|\.config\/gh/.test(s.to)).every((s) => !s.recursive)).toBe(true);
    // Every host credential file rides a READ-ONLY mount, so the container never writes back.
    const credMounts = mounts.filter((m) => /\.azure|\.config[\\/]gh/.test(m.src));
    expect(credMounts.length).toBe(5);
    expect(credMounts.every((m) => m.readonly)).toBe(true);
  });

  it('gates every artifact on existsSync (absent stores contribute nothing)', () => {
    const { mounts, seedCopies } = resolveDockerCredentialArtifacts(home);
    expect(mounts).toEqual([]);
    expect(seedCopies).toEqual([]);
  });

  it('omp: shares sessions/ RW (host-side history/resume reads), seeds config files only', () => {
    mkdirSync(join(home, '.omp', 'agent', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.omp', 'agent', 'config.yml'), '');
    writeFileSync(join(home, '.omp', 'agent', 'mcp.json'), '{}');
    writeFileSync(join(home, '.omp', 'agent', 'models.yml'), '');
    writeFileSync(join(home, '.omp', 'agent', 'settings.yml'), '');
    // Regenerable local state that must NOT be seeded (mirrors the pi/grok exclusions).
    writeFileSync(join(home, '.omp', 'agent', 'agent.db'), '');
    mkdirSync(join(home, '.omp', 'agent', 'terminal-sessions'), { recursive: true });

    const { mounts, seedCopies } = resolveDockerCredentialArtifacts(home);
    expect(mounts).toContainEqual({
      src: join(home, '.omp', 'agent', 'sessions'),
      dst: '/home/agent/.omp/agent/sessions',
    });
    const dests = seedCopies.map((s) => s.to);
    expect(dests).toContain('/home/agent/.omp/agent/config.yml');
    expect(dests).toContain('/home/agent/.omp/agent/mcp.json');
    expect(dests).toContain('/home/agent/.omp/agent/models.yml');
    expect(dests).toContain('/home/agent/.omp/agent/settings.yml');
    expect(dests).not.toContain('/home/agent/.omp/agent/agent.db');
    expect(mounts.some((m) => m.dst === '/home/agent/.omp/agent/terminal-sessions')).toBe(false);
    // seed copies of individual files are NOT recursive
    expect(seedCopies.filter((s) => s.to.startsWith('/home/agent/.omp')).every((s) => !s.recursive)).toBe(true);
  });
});

describe('resolveDockerClaudeArtifacts (isolated claude state)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeman-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('shares only projects (RW) and seeds .claude.json + credentials + settings + stats-cache', () => {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { id: 1 } }));
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}');
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }));
    writeFileSync(join(home, '.claude', 'stats-cache.json'), '{}');

    const art = resolveDockerClaudeArtifacts(home, 'codeman-case-x', '/ws/x');
    // transcripts shared RW (no readonly), whole ~/.claude never mounted
    expect(art.mounts).toContainEqual({ src: join(home, '.claude', 'projects'), dst: '/home/agent/.claude/projects' });
    expect(art.mounts.some((m) => m.dst === '/home/agent/.claude')).toBe(false);
    // credentials + settings + stats-cache + .claude.json seeded (copied into the container's own HOME)
    const dests = art.seedCopies.map((s) => s.to);
    expect(dests).toContain('/home/agent/.claude.json');
    expect(dests).toContain('/home/agent/.claude/.credentials.json');
    expect(dests).toContain('/home/agent/.claude/settings.json');
    expect(dests).toContain('/home/agent/.claude/stats-cache.json'); // restores the model/effort status indicator
    // the seed mounts are read-only
    expect(art.mounts.filter((m) => m.readonly).length).toBeGreaterThanOrEqual(3);
  });

  it('omits mounts/seeds for artifacts that do not exist', () => {
    const art = resolveDockerClaudeArtifacts(home, 'codeman-case-y', '/ws/y');
    expect(art.mounts).toEqual([]);
    expect(art.seedCopies).toEqual([]);
  });
});

describe('resolveClaudeJsonSeedMount', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeman-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns a read-only seed mount when ~/.claude.json exists', () => {
    writeFileSync(join(home, '.claude.json'), '{}');
    expect(resolveClaudeJsonSeedMount(home)).toEqual({
      src: join(home, '.claude.json'),
      dst: CLAUDE_JSON_SEED,
      readonly: true,
    });
  });

  it('returns null when ~/.claude.json is absent', () => {
    expect(resolveClaudeJsonSeedMount(home)).toBeNull();
  });
});

describe('buildSeamlessClaudeConfig', () => {
  it('forces onboarding-complete + theme + workspace trust while preserving host fields', () => {
    const merged = buildSeamlessClaudeConfig({ oauthAccount: { id: 1 }, projects: {} }, '/ws/proj');
    expect(merged.hasCompletedOnboarding).toBe(true);
    expect(merged.theme).toBe('dark');
    expect(merged.oauthAccount).toEqual({ id: 1 }); // host auth account preserved
    const proj = (merged.projects as Record<string, Record<string, unknown>>)['/ws/proj'];
    expect(proj.hasTrustDialogAccepted).toBe(true);
    expect(proj.hasCompletedProjectOnboarding).toBe(true);
    expect(proj.projectOnboardingSeenCount).toBe(1);
  });

  it('keeps an existing theme and merges into an existing project entry', () => {
    const merged = buildSeamlessClaudeConfig(
      { theme: 'light', projects: { '/ws/proj': { allowedTools: ['a'], projectOnboardingSeenCount: 5 } } },
      '/ws/proj',
      'dark'
    );
    expect(merged.theme).toBe('light'); // not overwritten when already set
    const proj = (merged.projects as Record<string, Record<string, unknown>>)['/ws/proj'];
    expect(proj.allowedTools).toEqual(['a']); // existing project fields kept
    expect(proj.hasTrustDialogAccepted).toBe(true);
    expect(proj.projectOnboardingSeenCount).toBe(5); // preserved, not reset to 1
  });
});

describe('agentImageBuildArgs', () => {
  it('builds the docker build argv in order', () => {
    expect(agentImageBuildArgs('/repo/docker/agent.Dockerfile', 'codeman/agent:base', '/repo')).toEqual([
      'build',
      '-f',
      '/repo/docker/agent.Dockerfile',
      '-t',
      'codeman/agent:base',
      '/repo',
    ]);
  });

  it('adds --no-cache before the context dir when requested', () => {
    const args = agentImageBuildArgs('/df', 'img', '/ctx', true);
    expect(args).toContain('--no-cache');
    expect(args.indexOf('--no-cache')).toBeLessThan(args.indexOf('/ctx'));
    expect(args[args.length - 1]).toBe('/ctx');
  });
});

describe('ensureAgentBaseImage (no-op under VITEST)', () => {
  it('reports the image as already present without spawning a build', async () => {
    const r = await ensureAgentBaseImage({ engine: 'docker' }, DEFAULT_AGENT_IMAGE);
    expect(r).toEqual({ ok: true, built: false, alreadyPresent: true });
  });
});

describe('daemon probes (no-op under VITEST)', () => {
  it('checkDockerAvailable returns a canned available result', async () => {
    const a = await checkDockerAvailable();
    expect(a.ok).toBe(true);
    expect(a.capsEnforced).toBe(true);
    expect(a.engine).toBe('docker');
  });

  it('checkDockerTmuxAvailable + image present are canned-true', async () => {
    expect((await checkDockerTmuxAvailable({ engine: 'docker', image: DEFAULT_AGENT_IMAGE })).ok).toBe(true);
    expect(await checkDockerImagePresent({ engine: 'docker' }, DEFAULT_AGENT_IMAGE)).toBe(true);
  });

  it('probeDockerCliVersion is undefined under test', async () => {
    expect(
      await probeDockerCliVersion({ engine: 'docker', containerName: 'codeman-case-x' }, 'claude')
    ).toBeUndefined();
  });
});
