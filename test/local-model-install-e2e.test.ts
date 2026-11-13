/**
 * @fileoverview The local model install from the first GET to Remove, with the REAL modules
 * joined together: the routes, the install service, the catalogue and `recommend()`, the
 * runtime download and unpack, the supervisor, the pull, the checks, the connection and the
 * state file. Only what would touch the world is a stand-in:
 *
 *  - the runtime is the fake HTTP server of test/fixtures/fake-ollama.ts (one instance serves
 *    the archive, a second one is what the supervisor "starts" through the fake's `spawn`);
 *  - the pin points at the fake's small archive and carries that archive's own sha256, so the
 *    real download, the real hash comparison and the real `/usr/bin/tar` run;
 *  - the hardware is the owner's MacBook as its `sysctl` reported it (Apple M5 Pro, 48 GB);
 *  - the coding agent's installer is a function that says it ran;
 *  - the waits between retries are skipped (the retries themselves are the real ones).
 *
 * Nothing is downloaded from the network, no process is started and no fixed port is used
 * (the runtime's port is one the system handed out). Files live in the test's temp data dir.
 *
 * The walks: the whole install and its removal; a damaged runtime download; a model download
 * that fails twice and then succeeds; one that keeps failing; a model that calls no tool;
 * Cancel during the model download; a server restart during the model download; a server
 * that is KILLED during the model download and leaves its runtime running.
 *
 * "A server" here is one install service with its own runtime supervisor (`startServer()`).
 * A restart is `shutdown()` of the one and a new one over the same data dir.
 *
 * The other tests give each module fakes of its neighbours. This one is what fails when two
 * modules that each pass their own tests do not fit together.
 *
 * Port: the fake runtime binds port 0 twice; the routes use app.inject().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import {
  createFakeOllama,
  freeLoopbackPort,
  MACBOOK_MEASURED_TOTAL_BYTES,
  startFakeOllama,
  type FakeOllama,
} from './fixtures/fake-ollama.js';
import { dataPath, getDataDir } from '../src/config/instance.js';
import { customModelHostsPath, readCustomModelHosts } from '../src/custom-model-hosts.js';
import { createLocalModelService, type LocalModelService } from '../src/local-model/install-job.js';
import { memClassGb, formatGb } from '../src/local-model/format.js';
import { pullModel, PULL_RETRIES } from '../src/local-model/ollama-client.js';
import { localModelPaths, type LocalModelPaths } from '../src/local-model/paths.js';
import {
  createRuntimeSupervisor,
  ensureRuntimeInstalled,
  type RuntimeSupervisorDeps,
} from '../src/local-model/runtime.js';
import { readLocalModelState } from '../src/local-model/state-store.js';
import { registerLocalModelRoutes } from '../src/web/routes/local-model-routes.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import type { Candidate, HardwareFacts, HarnessFact, LocalModelInstallView, LocalModelStatus } from '../src/types.js';

const INSTALL_COMMAND = 'curl -fsSL https://opencode.ai/install | bash';

/** The owner's MacBook, from its sysctl capture of 2026-11-06. */
const MACBOOK: HardwareFacts = {
  platform: 'darwin',
  arch: 'arm64',
  arm64: true,
  translated: false,
  memBytes: 51539607552,
  memGb: formatGb(51539607552),
  memClassGb: memClassGb(51539607552),
  chip: 'Apple M5 Pro',
  model: 'Mac17,13',
  macosVersion: '27.2',
  macosMajor: 27,
  wiredLimitMb: 0,
  freeDiskBytes: 912308310016,
  freeDiskGb: formatGb(912308310016),
  source: 'sysctl',
};

interface World {
  archive: FakeOllama;
  runtime: FakeOllama | undefined;
  port: number;
  paths: LocalModelPaths;
  agentInstalled: boolean;
  installerRuns: number;
  /** How many of the next archive downloads arrive with one byte changed (the size stays the pinned one). */
  damagedDownloads: number;
  /** The server that is up. A restart replaces it. */
  service: LocalModelService;
  /** Every server of the test, for the clean-up. */
  services: LocalModelService[];
  sessions: Map<string, { name: string; customModel?: { endpointId: string } }>;
}

let world: World;

const HOSTS = () => customModelHostsPath(getDataDir());
const STATE = () => dataPath('local-model.json');

const harnessFacts = async (): Promise<HarnessFact[]> => [
  {
    cli: 'opencode',
    label: 'OpenCode',
    installed: world.agentInstalled,
    installable: !world.agentInstalled,
    ...(world.agentInstalled ? {} : { installCommand: INSTALL_COMMAND }),
    acceptsModelId: () => true,
  },
];

/**
 * The download of the runtime archive: the real `fetch` against the fake's archive. While
 * `world.damagedDownloads` is above 0 the body arrives with its last byte changed, as a
 * download damaged on the way does: the size is still the pinned one, only the hash can tell.
 */
const archiveFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (world.damagedDownloads <= 0 || !res.ok) return res;
  world.damagedDownloads -= 1;
  const body = Buffer.from(await res.arrayBuffer());
  body[body.length - 1] ^= 0xff;
  return new Response(body, { status: res.status, headers: { 'content-length': String(body.length) } });
};

/**
 * One Codeman server as far as this feature goes: an install service with its own runtime
 * supervisor, over the data dir, the pin and the port of the test. It becomes `world.service`,
 * which is the one the routes ask.
 */
function startServer(processes: Partial<Pick<RuntimeSupervisorDeps, 'commandOfPid' | 'kill'>> = {}): LocalModelService {
  const pin = world.archive.pin();
  const { paths, port } = world;
  const supervisor = createRuntimeSupervisor({
    // "Starting the runtime" makes the second fake listen on the port it was given.
    spawn: (command, args, options) => {
      if (!world.runtime) throw new Error('The test did not prepare a runtime');
      return world.runtime.spawn(command, args, options);
    },
    fetch,
    env: { PATH: process.env.PATH, CODEMAN_PASSWORD: 'must-not-reach-the-runtime', OLLAMA_ORIGINS: '*' },
    commandOfPid: async () => undefined,
    kill: () => {},
    ...processes,
    sleep: async () => {},
    pin,
    paths,
    onChange: (status) => service.onRuntimeChange(status),
  });
  const service: LocalModelService = createLocalModelService({
    readHardware: async () => MACBOOK,
    buildHarnessFacts: harnessFacts,
    pin,
    paths,
    // The real download and unpack, told where the network is: the fake's archive.
    ensureRuntimeInstalled: (options) =>
      ensureRuntimeInstalled({ ...options, deps: { fetch: archiveFetch, sleep: async () => {} } }),
    // The real pull with its real retries, without the seconds between them.
    pullModel: (target, modelId, options) => pullModel(target, modelId, { ...options, sleep: async () => {} }),
    chooseRuntimePort: async () => port,
    supervisor,
    recheckCliInstalled: async () => world.agentInstalled,
    tryBeginCliInstall: () => () => {},
    runInstallCommand: async () => {
      world.installerRuns++;
      world.agentInstalled = true;
      return { code: 0, output: 'opencode installed\n', timedOut: false, aborted: false };
    },
    audit: async () => {},
    checkDeveloperTools: async () => 'missing',
  });
  world.service = service;
  world.services.push(service);
  return service;
}

beforeEach(async () => {
  const archive = await startFakeOllama();
  world = {
    archive,
    runtime: undefined,
    port: await freeLoopbackPort(),
    paths: localModelPaths('0.40.15'),
    agentInstalled: false,
    installerRuns: 0,
    damagedDownloads: 0,
    service: undefined as unknown as LocalModelService,
    services: [],
    sessions: new Map(),
  };
  startServer();
});

afterEach(async () => {
  for (const service of world.services) await service.shutdown();
  await world.archive.close();
  await world.runtime?.close();
  await rm(world.paths.root, { recursive: true, force: true });
  rmSync(STATE(), { force: true });
  rmSync(HOSTS(), { force: true });
  rmSync(SETTINGS_PATH, { force: true });
  vi.restoreAllMocks();
});

async function routes() {
  const { app } = await createRouteTestHarness((instance) =>
    registerLocalModelRoutes(
      instance,
      { sessions: world.sessions },
      { readHardware: async () => MACBOOK, buildHarnessFacts: harnessFacts, service: () => world.service }
    )
  );
  const get = async (): Promise<LocalModelStatus> =>
    (await app.inject({ method: 'GET', url: '/api/local-model' })).json().data;
  /** Polls the GET the way the window does, until the job is no longer running. */
  const settled = async (): Promise<LocalModelInstallView> => {
    let install = (await get()).install;
    await vi.waitFor(
      async () => {
        install = (await get()).install;
        expect(install.state).not.toBe('installing');
      },
      { timeout: 20_000, interval: 25 }
    );
    return install;
  };
  /** The click on "Download and install" for the row the server recommends, with the size it showed. */
  const install = (pick: Candidate) =>
    app.inject({
      method: 'POST',
      url: '/api/local-model/install',
      payload: { modelId: pick.modelId, cli: 'opencode', context: pick.context, acknowledgedBytes: pick.installBytes },
    });
  /** Polls until the model download is under way and has moved. */
  const pulling = async (): Promise<void> => {
    await vi.waitFor(
      async () => {
        const status = await get();
        expect(status.install.step).toBe('model');
        expect(status.install.progress?.completedBytes ?? 0).toBeGreaterThan(0);
      },
      { timeout: 20_000, interval: 20 }
    );
  };
  return { app, get, settled, install, pulling };
}

/** The runtime the supervisor will "start": it has exactly the model the server recommended. */
function prepareRuntime(pick: Candidate): FakeOllama {
  world.runtime = createFakeOllama({
    model: { id: pick.modelId, bytes: pick.downloadBytes },
    contextLength: pick.context,
  });
  return world.runtime;
}

/** A model download that takes a while: 400 lines, 5 ms apart. */
function slowPull(runtime: FakeOllama): void {
  runtime.switches.pull.progressLines = 400;
  runtime.switches.pull.lineDelayMs = 5;
}

function quickPull(runtime: FakeOllama): void {
  runtime.switches.pull.progressLines = 20;
  runtime.switches.pull.lineDelayMs = 0;
}

describe('the install from the first GET to Remove, real modules over a fake runtime', () => {
  it('recommends for the MacBook, installs what was confirmed, connects it, refuses a changed model, and removes all of it', async () => {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ tmuxHistoryLimit: 5000 }));
    const { app, get, settled, install: clickInstall } = await routes();

    // ---- The chooser: what the window shows before anything is installed ----
    const before = await get();
    expect(before.install).toMatchObject({
      state: 'idle',
      running: false,
      developerTools: 'missing',
      actions: ['install'],
      folder: world.paths.root,
      runtime: { version: '0.40.15', installed: false, downloadBytes: world.archive.archive.size },
    });
    expect(before.recommendation.verdict).toBe('ok');
    expect(before.recommendation.budgetSource).toBe('estimated');
    const pick = before.recommendation.pick!;
    expect(pick).toBeDefined();
    // The MacBook's row: the one model that was run on a Mac like it, with its measured speed.
    expect(pick).toMatchObject({
      modelId: 'qwen3.6:35b-a3b',
      context: 131072,
      fit: 'tight',
      needSource: 'measured',
      tested: true,
      tag: { kind: 'tested' },
    });
    // The row carries the coding agent and the literal command the consent screen prints.
    expect(pick.harnesses[0]).toMatchObject({
      cli: 'opencode',
      cliLabel: 'OpenCode',
      installed: false,
      installCommand: INSTALL_COMMAND,
    });
    // The server's own total: the model plus the runtime archive that is still to download.
    expect(pick.installBytes).toBe(pick.downloadBytes + world.archive.archive.size);
    expect(pick.installGb).toBe(formatGb(pick.installBytes));
    const runtime = prepareRuntime(pick);

    // ---- Consent is bound to the size shown ----
    const stale = await app.inject({
      method: 'POST',
      url: '/api/local-model/install',
      payload: { modelId: pick.modelId, cli: 'opencode', context: pick.context, acknowledgedBytes: pick.downloadBytes },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().data).toMatchObject({ reason: 'size-changed', expectedBytes: pick.installBytes });
    expect(world.archive.state.archiveRequests).toBe(0);

    // ---- Install ----
    const started = await clickInstall(pick);
    expect(started.statusCode).toBe(200);
    expect(started.json().data).toMatchObject({
      state: 'installing',
      steps: ['runtime', 'model', 'verify', 'agent', 'connect'],
      model: { id: pick.modelId, label: pick.modelLabel },
      cli: 'opencode',
      context: pick.context,
      actions: ['cancel'],
    });
    // One job at a time.
    const second = await clickInstall(pick);
    expect(second.statusCode).toBe(409);
    expect(second.json().data).toMatchObject({ reason: 'job-running' });

    const install = await settled();
    expect(install.error).toBeUndefined();
    expect(install).toMatchObject({
      state: 'installed',
      running: true,
      port: world.port,
      model: { id: pick.modelId, label: pick.modelLabel },
      cli: 'opencode',
      cliLabel: 'OpenCode',
      context: pick.context,
      endpointId: 'local-ollama',
      folder: world.paths.root,
      loaded: { context: pick.context, onGpu: true },
      actions: ['start-session', 'stop', 'install', 'remove'],
      runtime: { installed: true, downloadBytes: 0, downloadGb: formatGb(0) },
    });

    // ---- What really happened ----
    // The runtime was downloaded once, unpacked, and "started" with the allowlisted environment.
    expect(world.archive.state.archiveRequests).toBe(1);
    expect(existsSync(world.paths.binary)).toBe(true);
    expect(existsSync(world.paths.archivePartial)).toBe(false);
    expect(runtime.state.children).toHaveLength(1);
    const env = runtime.state.children[0].env;
    expect(env.OLLAMA_HOST).toBe(`127.0.0.1:${world.port}`);
    expect(env.OLLAMA_CONTEXT_LENGTH).toBe(String(pick.context));
    expect(env.HOME).toBe(world.paths.homeDir);
    expect(env.OLLAMA_MODELS).toBe(world.paths.modelsDir);
    expect(Object.keys(env).filter((key) => key.startsWith('CODEMAN_'))).toEqual([]);
    expect(env).not.toHaveProperty('OLLAMA_ORIGINS');
    // One pull, one coding agent install.
    expect(runtime.state.pulls).toBe(1);
    expect(world.installerRuns).toBe(1);

    // The state file: the measured budget, the pull's own total, the digest.
    const state = await readLocalModelState();
    expect(state).toMatchObject({
      state: 'installed',
      model: { id: pick.modelId, context: pick.context, pullBytes: runtime.model.bytes, digest: runtime.model.digest },
      runtime: {
        version: '0.40.15',
        port: world.port,
        enabled: true,
        measuredTotalBytes: MACBOOK_MEASURED_TOTAL_BYTES,
      },
      connection: { endpointId: 'local-ollama', flagWasEnabled: false },
    });
    expect(JSON.stringify(state)).not.toContain(getDataDir());

    // The two writes outside the folder, and nothing else changed there.
    expect(await readCustomModelHosts(getDataDir())).toEqual([
      {
        id: 'local-ollama',
        label: 'This Mac',
        baseUrl: `http://127.0.0.1:${world.port}`,
        authStyle: 'bearer',
        models: [pick.modelId],
        defaultModelId: pick.modelId,
        defaultContextLength: pick.context,
      },
    ]);
    expect(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))).toEqual({
      tmuxHistoryLimit: 5000,
      customModelEndpointsEnabled: true,
    });

    // From now on the budget of the GET is the measured one.
    const after = await get();
    expect(after.recommendation.budgetSource).toBe('measured');
    expect(after.recommendation.budgetBytes).toBeLessThanOrEqual(MACBOOK_MEASURED_TOTAL_BYTES);

    // ---- A session may start, until the model changes under its name ----
    expect(await world.service.launchRefusalMessage('local-ollama', pick.modelId)).toBeUndefined();
    runtime.model.digest = 'f'.repeat(64);
    expect(await world.service.launchRefusalMessage('local-ollama', pick.modelId)).toBe(
      'The model on this Mac changed since it was installed. Remove it and install it again.'
    );
    expect((await get()).install).toMatchObject({
      state: 'installed',
      error: { code: 'model-changed', next: 'remove' },
    });

    // ---- Remove ----
    world.sessions.set('s1', { name: 'w1-app', customModel: { endpointId: 'local-ollama' } });
    const refused = await app.inject({ method: 'DELETE', url: '/api/local-model', payload: { removeModel: true } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().data).toMatchObject({ reason: 'sessions-open', sessions: ['w1-app'] });
    expect(existsSync(world.paths.binary)).toBe(true);

    world.sessions.clear();
    const removed = await app.inject({ method: 'DELETE', url: '/api/local-model', payload: { removeModel: true } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toMatchObject({ state: 'idle', running: false, actions: ['install'] });
    // The child was stopped and the whole folder is gone: the runtime, the private home, the models.
    expect(runtime.state.children[0].signals).toContain('SIGTERM');
    expect(runtime.listening).toBe(false);
    expect(existsSync(world.paths.root)).toBe(false);
    // Our record is gone, and the flag this feature switched on is off again.
    expect(await readCustomModelHosts(getDataDir())).toEqual([]);
    expect(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))).toEqual({
      tmuxHistoryLimit: 5000,
      customModelEndpointsEnabled: false,
    });
    expect((await readLocalModelState()).state).toBe('idle');
    // The chooser is back, with the runtime download in the total again.
    const again = await get();
    expect(again.install.runtime).toMatchObject({ installed: false, downloadBytes: world.archive.archive.size });
    expect(again.recommendation.pick?.installBytes).toBe(pick.installBytes);
  }, 60_000);

  it('a runtime download that arrives damaged is deleted before anything is unpacked, and Try again gets it', async () => {
    const { get, settled, install: clickInstall, app } = await routes();
    const pick = (await get()).recommendation.pick!;
    const runtime = prepareRuntime(pick);
    world.damagedDownloads = 1;

    await clickInstall(pick);
    const failed = await settled();
    expect(failed).toMatchObject({
      state: 'failed',
      step: 'runtime',
      error: { code: 'runtime-damaged', next: 'retry' },
      actions: ['resume', 'install', 'remove'],
      runtime: { installed: false },
    });
    expect(failed.error?.detail).toContain(world.archive.archive.sha256);
    // The hash was compared first: the file is gone, nothing was unpacked, nothing was started.
    expect(world.archive.state.archiveRequests).toBe(1);
    expect(existsSync(world.paths.archivePartial)).toBe(false);
    expect(existsSync(world.paths.unpackDir)).toBe(false);
    expect(existsSync(world.paths.runtimeDir)).toBe(false);
    expect(runtime.state.children).toHaveLength(0);
    expect(runtime.state.pulls).toBe(0);

    // "Try again" downloads the archive again, and this time it is the pinned one.
    const resumed = await app.inject({ method: 'POST', url: '/api/local-model/resume', payload: {} });
    expect(resumed.statusCode).toBe(200);
    expect((await settled()).state).toBe('installed');
    expect(world.archive.state.archiveRequests).toBe(2);
    expect(existsSync(world.paths.binary)).toBe(true);
    expect(runtime.state.children).toHaveLength(1);
  }, 60_000);

  it('a model download that fails twice is asked again and finishes; Remove leaves another saved endpoint and the models', async () => {
    writeFileSync(HOSTS(), JSON.stringify([{ id: 'office', label: 'Office', baseUrl: 'http://192.168.1.50:8080' }]));
    const { app, get, settled, install: clickInstall } = await routes();
    const pick = (await get()).recommendation.pick!;
    const runtime = prepareRuntime(pick);
    // The real error line of a pull whose download kept failing, on the first two pulls.
    runtime.switches.pull.fail = 'error-line';
    runtime.switches.pull.failTimes = 2;

    await clickInstall(pick);
    const install = await settled();
    expect(install.error).toBeUndefined();
    expect(install.state).toBe('installed');
    expect(runtime.state.pulls).toBe(3);
    // The size of the model is the pull's own total.
    expect((await readLocalModelState()).model?.pullBytes).toBe(runtime.model.bytes);
    expect(await readCustomModelHosts(getDataDir())).toMatchObject([{ id: 'office' }, { id: 'local-ollama' }]);

    // Remove without the box: the model store stays for a later install.
    const removed = await app.inject({ method: 'DELETE', url: '/api/local-model', payload: { removeModel: false } });
    expect(removed.json().data.state).toBe('idle');
    expect(existsSync(world.paths.runtimeRoot)).toBe(false);
    expect(existsSync(world.paths.homeDir)).toBe(false);
    expect(existsSync(world.paths.modelsDir)).toBe(true);
    // The other endpoint stays, and so does the flag it needs, although this feature switched it on.
    expect(await readCustomModelHosts(getDataDir())).toEqual([
      { id: 'office', label: 'Office', baseUrl: 'http://192.168.1.50:8080' },
    ]);
    expect(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).customModelEndpointsEnabled).toBe(true);
  }, 60_000);

  it('a model download that keeps failing ends failed after its retries, and Try again continues it', async () => {
    const { app, get, settled, install: clickInstall } = await routes();
    const pick = (await get()).recommendation.pick!;
    const runtime = prepareRuntime(pick);
    runtime.switches.pull.fail = 'error-line';

    await clickInstall(pick);
    const failed = await settled();
    expect(failed).toMatchObject({
      state: 'failed',
      step: 'model',
      error: { code: 'pull-failed', next: 'retry', detail: 'max retries exceeded: local error: tls: bad record MAC' },
      actions: ['resume', 'install', 'remove'],
    });
    // The first pull and every retry, and no more.
    expect(runtime.state.pulls).toBe(1 + PULL_RETRIES);
    // The download as it stood, in the pull's own figures.
    expect(failed.progress?.totalBytes).toBe(runtime.model.bytes);
    expect(failed.progress?.completedBytes).toBeGreaterThan(0);
    expect(failed.progress?.completedBytes).toBeLessThan(runtime.model.bytes);
    // Nothing was checked, installed or connected.
    expect(runtime.state.installed).toBe(false);
    expect(world.installerRuns).toBe(0);
    expect(existsSync(HOSTS())).toBe(false);
    expect(existsSync(SETTINGS_PATH)).toBe(false);

    // The network is fine again: "Try again" enters the same step.
    runtime.switches.pull.fail = 'none';
    const resumed = await app.inject({ method: 'POST', url: '/api/local-model/resume', payload: {} });
    expect(resumed.json().data).toMatchObject({ state: 'installing', step: 'model' });
    expect((await settled()).state).toBe('installed');
    expect(runtime.state.pulls).toBe(2 + PULL_RETRIES);
    // The runtime was neither downloaded nor started a second time.
    expect(world.archive.state.archiveRequests).toBe(1);
    expect(runtime.state.children).toHaveLength(1);
  }, 60_000);

  it('a model that does not call a tool ends failed with the next model to try, and Remove cleans up', async () => {
    const { app, get, settled, install: clickInstall } = await routes();
    const pick = (await get()).recommendation.pick!;
    const runtime = prepareRuntime(pick);
    runtime.switches.tool = 'none';

    await clickInstall(pick);
    const install = await settled();
    expect(install).toMatchObject({
      state: 'failed',
      step: 'verify',
      error: { code: 'no-tool-call', next: 'next-model', message: { vars: { model: pick.modelLabel } } },
      actions: ['resume', 'install', 'remove'],
    });
    // The model to try next is a row of the list the window has.
    const offered = (await get()).recommendation;
    expect(install.error?.nextModel?.modelId).not.toBe(pick.modelId);
    expect(offered.alternatives.map((row) => row.modelId)).toContain(install.error?.nextModel?.modelId);
    // The coding agent was not installed and nothing was connected.
    expect(world.installerRuns).toBe(0);
    expect(existsSync(HOSTS())).toBe(false);
    expect(existsSync(SETTINGS_PATH)).toBe(false);

    // "Try again" with a model that now calls the tool finishes the same job.
    runtime.switches.tool = 'call';
    const resumed = await app.inject({ method: 'POST', url: '/api/local-model/resume', payload: {} });
    expect(resumed.statusCode).toBe(200);
    expect((await settled()).state).toBe('installed');
    // The runtime was not downloaded again and the model was not pulled again.
    expect(world.archive.state.archiveRequests).toBe(1);
    expect(runtime.state.pulls).toBe(1);

    const removed = await app.inject({ method: 'DELETE', url: '/api/local-model' });
    expect(removed.json().data.state).toBe('idle');
    // This feature switched the flag on and no other endpoint is saved: it is off again.
    expect(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).customModelEndpointsEnabled).toBe(false);
    // The model was not asked to go: the store stays for a later install.
    expect(existsSync(world.paths.runtimeDir)).toBe(false);
    expect(existsSync(world.paths.modelsDir)).toBe(true);
  }, 60_000);

  it('Cancel during the model download pauses the job, nothing goes on by itself, and Continue finishes it', async () => {
    const { app, get, settled, install: clickInstall, pulling } = await routes();
    const pick = (await get()).recommendation.pick!;
    const runtime = prepareRuntime(pick);
    slowPull(runtime);

    await clickInstall(pick);
    // The window sees the model download move.
    await pulling();
    expect((await get()).install).toMatchObject({ state: 'installing', step: 'model' });

    const cancelled = await app.inject({ method: 'POST', url: '/api/local-model/cancel' });
    expect(cancelled.statusCode).toBe(200);
    const paused = cancelled.json().data as LocalModelInstallView;
    expect(paused).toMatchObject({ state: 'paused', step: 'model', actions: ['resume', 'install', 'remove'] });
    // The bytes as they stood, and the pull's own total.
    expect(paused.progress?.totalBytes).toBe(runtime.model.bytes);
    expect(paused.progress?.completedBytes).toBeLessThan(runtime.model.bytes);
    expect(paused.progress).not.toHaveProperty('bytesPerSecond');
    expect(runtime.state.installed).toBe(false);

    // Nothing goes on by itself.
    const pullsAfterCancel = runtime.state.pulls;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.state.pulls).toBe(pullsAfterCancel);
    expect((await get()).install.state).toBe('paused');

    quickPull(runtime);
    const resumed = await app.inject({ method: 'POST', url: '/api/local-model/resume' });
    expect(resumed.json().data.state).toBe('installing');
    expect((await settled()).state).toBe('installed');
    expect(runtime.state.pulls).toBe(pullsAfterCancel + 1);
  }, 60_000);

  it('a server restart during the model download comes back paused, waits for a click, and Continue finishes it', async () => {
    const { app, get, settled, install: clickInstall, pulling } = await routes();
    const pick = (await get()).recommendation.pick!;
    const runtime = prepareRuntime(pick);
    slowPull(runtime);

    await clickInstall(pick);
    await pulling();

    // ---- The server stops ----
    const first = world.service;
    await first.shutdown();
    // The runtime child was signalled and no longer listens; the download stopped with it.
    expect(runtime.state.children).toHaveLength(1);
    expect(runtime.state.children[0].signals).toContain('SIGTERM');
    expect(runtime.listening).toBe(false);
    expect(runtime.state.installed).toBe(false);
    // Stopping writes nothing: the file still says what the job was doing.
    expect(await readLocalModelState()).toMatchObject({ state: 'installing', step: 'model' });
    const pullsBefore = runtime.state.pulls;

    // ---- A new server starts over the same data dir ----
    const second = startServer();
    expect(second).not.toBe(first);
    await second.boot();
    const paused = (await get()).install;
    expect(paused).toMatchObject({
      state: 'paused',
      step: 'model',
      steps: ['runtime', 'model', 'verify', 'agent', 'connect'],
      model: { id: pick.modelId, label: pick.modelLabel },
      cli: 'opencode',
      context: pick.context,
      port: world.port,
      running: false,
      runtime: { installed: true, downloadBytes: 0 },
      actions: ['resume', 'install', 'remove'],
    });
    expect(paused.error).toBeUndefined();
    expect(await readLocalModelState()).toMatchObject({ state: 'paused', step: 'model' });

    // It never continues without a click: no runtime is started, nothing is pulled.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runtime.state.children).toHaveLength(1);
    expect(runtime.state.pulls).toBe(pullsBefore);
    expect((await get()).install.state).toBe('paused');

    // ---- Continue ----
    quickPull(runtime);
    const resumed = await app.inject({ method: 'POST', url: '/api/local-model/resume', payload: {} });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().data.state).toBe('installing');
    const install = await settled();
    expect(install.error).toBeUndefined();
    expect(install).toMatchObject({ state: 'installed', running: true, endpointId: 'local-ollama' });
    // The new server started the runtime itself and pulled once more; the archive was not fetched again.
    expect(runtime.state.children).toHaveLength(2);
    expect(runtime.state.pulls).toBe(pullsBefore + 1);
    expect(world.archive.state.archiveRequests).toBe(1);
    expect(world.installerRuns).toBe(1);
    expect(await readCustomModelHosts(getDataDir())).toMatchObject([{ id: 'local-ollama', models: [pick.modelId] }]);
  }, 60_000);
});

describe('the library: a second model, the switch back, and the delete of one model', () => {
  it('installs A, adds B beside it, switches back to A, and deletes B, with one model in use throughout', async () => {
    const { app, get, settled, install: clickInstall } = await routes();
    const hostsModels = async () =>
      (await readCustomModelHosts(getDataDir())).find((host) => host.id === 'local-ollama')?.models;
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
    const deleteModel = (modelId: string) =>
      app.inject({ method: 'DELETE', url: '/api/local-model/models', payload: { modelId } });

    // ---- A: the first install ----
    world.agentInstalled = true;
    const first = await get();
    const a = first.recommendation.pick!;
    const bRow = first.recommendation.alternatives[0];
    expect(bRow).toBeDefined();
    expect(bRow.modelId).not.toBe(a.modelId);
    const B_DIGEST = 'b'.repeat(64);
    world.runtime = createFakeOllama({
      model: { id: a.modelId, bytes: a.downloadBytes },
      contextLength: a.context,
      otherModels: [
        {
          id: bRow.modelId,
          bytes: bRow.downloadBytes,
          digest: B_DIGEST,
          format: 'gguf',
          runner: 'ggml',
          quantization: 'Q4_K_M',
          capabilities: ['completion', 'tools'],
        },
      ],
    });
    const runtime = world.runtime;
    expect((await clickInstall(a)).statusCode).toBe(200);
    expect((await settled()).state).toBe('installed');

    let status = await get();
    expect(status.install.library).toEqual([
      {
        id: a.modelId,
        label: a.modelLabel,
        context: a.context,
        sizeBytes: a.downloadBytes,
        sizeGb: formatGb(a.downloadBytes),
        active: true,
        verified: true,
        status: 'ready',
        actions: [],
      },
    ]);
    // The store of the fake runtime writes no blobs: measured, and empty.
    expect(status.install.store).toEqual({ bytes: 0, gb: '0.0' });
    // The chooser says the row is the model in use.
    expect(status.recommendation.pick?.library).toBe('active');
    expect(status.install.actions).toEqual(['start-session', 'stop', 'install', 'remove']);

    // ---- B: a second model. Refused while a session uses A. ----
    const b = [status.recommendation.pick!, ...status.recommendation.alternatives].find(
      (row) => row.modelId === bRow.modelId
    )!;
    // The runtime is on disk now, so the server's total for B is the model alone.
    expect(b.installBytes).toBe(b.downloadBytes);
    const addB = { modelId: b.modelId, cli: 'opencode', context: b.context, acknowledgedBytes: b.installBytes };
    world.sessions.set('s1', { name: 'w1-app', customModel: { endpointId: 'local-ollama' } });
    const busy = await post('/api/local-model/install', addB);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().data).toMatchObject({ reason: 'sessions-open', sessions: ['w1-app'] });
    expect(runtime.state.pulls).toBe(1);
    world.sessions.clear();

    // The fake runtime reports the context it was "started with": B's from here on.
    runtime.switches.ps.contextLength = b.context;
    const started = await post('/api/local-model/install', addB);
    expect(started.statusCode).toBe(200);
    expect(started.json().data).toMatchObject({ state: 'installing', model: { id: b.modelId } });
    const withB = await settled();
    expect(withB.error).toBeUndefined();
    expect(withB).toMatchObject({
      state: 'installed',
      model: { id: b.modelId, label: b.modelLabel },
      context: b.context,
      endpointId: 'local-ollama',
    });
    // Both are on disk, A was not deleted, and the ONE endpoint record lists the model in use.
    expect(runtime.state.installed).toBe(true);
    expect(runtime.state.others).toEqual([b.modelId]);
    expect(await hostsModels()).toEqual([b.modelId]);
    expect(runtime.requests.some((request) => request.path === '/api/delete')).toBe(false);
    await vi.waitFor(async () => {
      const library = (await get()).install.library;
      expect(library.map((row) => [row.id, row.active, row.status, row.actions])).toEqual([
        [b.modelId, true, 'ready', []],
        [a.modelId, false, 'ready', ['use', 'delete']],
      ]);
    });
    const stored = await readLocalModelState();
    expect(stored.library?.map((entry) => [entry.id, entry.context, entry.digest])).toEqual([
      [a.modelId, a.context, runtime.model.digest],
      [b.modelId, b.context, B_DIGEST],
    ]);
    // Only the model in use may be launched on the endpoint.
    expect(await world.service.launchRefusalMessage('local-ollama', b.modelId)).toBeUndefined();
    expect(await world.service.launchRefusalMessage('local-ollama', a.modelId)).toContain('is in use on this Mac');

    // ---- The model in use cannot be deleted ----
    const active = await deleteModel(b.modelId);
    expect(active.statusCode).toBe(409);
    expect(active.json().data).toMatchObject({ reason: 'model-active' });
    expect(runtime.state.others).toEqual([b.modelId]);

    // ---- Back to A: nothing is downloaded ----
    status = await get();
    expect(status.recommendation.pick?.library ?? status.recommendation.alternatives[0].library).toBeDefined();
    world.sessions.set('s1', { name: 'w1-app', customModel: { endpointId: 'local-ollama' } });
    const useBusy = await post('/api/local-model/use', { modelId: a.modelId });
    expect(useBusy.statusCode).toBe(409);
    expect(useBusy.json().data).toMatchObject({ reason: 'sessions-open' });
    world.sessions.clear();

    runtime.switches.ps.contextLength = a.context;
    const pullsBefore = runtime.state.pulls;
    const switched = await post('/api/local-model/use', { modelId: a.modelId });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().data).toMatchObject({ state: 'installing', steps: ['verify', 'connect'] });
    const backOnA = await settled();
    expect(backOnA.error).toBeUndefined();
    expect(backOnA).toMatchObject({ state: 'installed', model: { id: a.modelId }, context: a.context });
    expect(runtime.state.pulls).toBe(pullsBefore);
    expect(await hostsModels()).toEqual([a.modelId]);
    expect(await world.service.launchRefusalMessage('local-ollama', a.modelId)).toBeUndefined();

    // ---- Delete B: through the runtime, by its name ----
    const notOurs = await deleteModel('someone-else:7b');
    expect(notOurs.statusCode).toBe(400);
    const gone = await deleteModel(b.modelId);
    expect(gone.statusCode).toBe(200);
    expect(gone.json().data.library.map((row: { id: string }) => row.id)).toEqual([a.modelId]);
    expect(runtime.state.others).toEqual([]);
    expect(runtime.state.installed).toBe(true);
    const deletes = runtime.requests.filter((request) => request.path === '/api/delete');
    expect(deletes.map((request) => request.body)).toEqual([{ model: b.modelId }]);
    expect((await readLocalModelState()).library?.map((entry) => entry.id)).toEqual([a.modelId]);
    expect((await get()).install.actions).toEqual(['start-session', 'stop', 'install', 'remove']);
    // A is in use: it can only go with the whole installation.
    expect((await deleteModel(a.modelId)).statusCode).toBe(409);
  });
});

describe('a server that is killed leaves its runtime running: the next server never deletes under it', () => {
  /**
   * Installs up to the model download, then "kills" the server: its job stops and it signals
   * nothing, as a process that got SIGKILL does. Its runtime child goes on listening. Answers
   * what the next server needs to find that process: `ps` and `kill` over the fake child.
   */
  async function killedDuringTheDownload() {
    const api = await routes();
    const pick = (await api.get()).recommendation.pick!;
    const runtime = prepareRuntime(pick);
    slowPull(runtime);
    await api.install(pick);
    await api.pulling();

    const child = runtime.state.children[0];
    const signal = child.kill.bind(child);
    // A killed server sends its child nothing.
    child.kill = () => false;
    await world.service.shutdown();
    expect(runtime.listening).toBe(true);
    // The pid was stored the moment the child was spawned.
    expect((await readLocalModelState()).runtime?.pid).toBe(child.pid);

    const signals: Array<{ pid: number; signal: string; folderThere: boolean }> = [];
    const processes: Partial<Pick<RuntimeSupervisorDeps, 'commandOfPid' | 'kill'>> = {
      // What `ps -o command= -p <pid>` prints for the runtime while it lives.
      commandOfPid: async (pid) => (pid === child.pid && runtime.listening ? `${world.paths.binary} serve` : undefined),
      kill: (pid, sig) => {
        signals.push({ pid, signal: sig, folderThere: existsSync(world.paths.runtimeDir) });
        if (pid === child.pid) signal(sig);
      },
    };
    return { ...api, pick, runtime, child, signals, processes };
  }

  it('Remove of the job it left ends that runtime BEFORE the folder is deleted', async () => {
    const { app, runtime, child, signals, processes } = await killedDuringTheDownload();
    startServer(processes);
    const removed = await app.inject({ method: 'DELETE', url: '/api/local-model', payload: { removeModel: true } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.state).toBe('idle');
    // The process was signalled while its binary was still on disk, and it is gone.
    expect(signals).toEqual([{ pid: child.pid, signal: 'SIGTERM', folderThere: true }]);
    await vi.waitFor(() => expect(runtime.listening).toBe(false));
    expect(existsSync(world.paths.root)).toBe(false);
    expect(await readLocalModelState()).toEqual(expect.objectContaining({ schema: 1, state: 'idle' }));
  }, 60_000);

  it('the next start of the server ends it too: nothing would use it until a click', async () => {
    const { get, settled, app, runtime, child, signals, processes } = await killedDuringTheDownload();
    const next = startServer(processes);
    await next.boot();
    expect(signals.map((entry) => [entry.pid, entry.signal])).toEqual([[child.pid, 'SIGTERM']]);
    await vi.waitFor(() => expect(runtime.listening).toBe(false));
    expect((await get()).install).toMatchObject({ state: 'paused', step: 'model', running: false });

    // Continue starts a runtime of its own on the same port and finishes the install.
    quickPull(runtime);
    const resumed = await app.inject({ method: 'POST', url: '/api/local-model/resume', payload: {} });
    expect(resumed.statusCode).toBe(200);
    const install = await settled();
    expect(install).toMatchObject({ state: 'installed', running: true });
    expect(runtime.state.children).toHaveLength(2);
  }, 60_000);

  it('a pid that now runs something else is never signalled', async () => {
    const { app, child, signals } = await killedDuringTheDownload();
    // The pid was reused by another program since.
    startServer({
      commandOfPid: async () => '/Applications/Something.app/Contents/MacOS/Something',
      kill: (pid, sig) => signals.push({ pid, signal: sig, folderThere: true }),
    });
    const removed = await app.inject({ method: 'DELETE', url: '/api/local-model', payload: {} });
    expect(removed.statusCode).toBe(200);
    expect(signals).toEqual([]);
    // Left to the test's own cleanup.
    child.crash(0);
  }, 60_000);
});
