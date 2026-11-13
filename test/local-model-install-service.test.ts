/**
 * @fileoverview The service that drives the local model install job
 * (`createLocalModelService()` in src/local-model/install-job.ts).
 *
 * Every dependency is a fake: no runtime is downloaded or started, no model is pulled, no
 * installer is run and no port is bound. The runtime modules are replaced through the
 * service's own dependency object, so these tests pin what the JOB does with their answers,
 * not what they answer. The state lives in memory and is passed through the real parser on
 * every write, so a state the state file would not read back fails here.
 *
 * What is pinned: the whole job from the click to "installed"; one job at a time (409); the
 * consent bound to the size shown (409); what is checked before anything is downloaded;
 * Cancel in every step; Resume; a job a server restart interrupted comes back paused and
 * waits for a click; every failure is a state with a code and a next step; the coding agent
 * install (the stock command, the audit line, the resolver caches forgotten, still missing is
 * a failure); the digest that refuses a changed model; the runtime verbs; Remove; and the
 * library: a second model beside the first, the switch between checked models, the delete of
 * one model, what a stopped job leaves to go back to, and the two cached listings of the view.
 *
 * Port: N/A (nothing listens).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDataDir } from '../src/config/instance.js';
import { customModelHostsPath, readCustomModelHosts, type CustomModelHost } from '../src/custom-model-hosts.js';
import { connectLocalModel, disconnectLocalModel, inspectLocalEndpoint } from '../src/local-model/connect.js';
import {
  createLocalModelService,
  type LocalModelActor,
  type LocalModelService,
  type LocalModelServiceDeps,
} from '../src/local-model/install-job.js';
import type { PullOptions } from '../src/local-model/ollama-client.js';
import type { LocalModelPaths } from '../src/local-model/paths.js';
import {
  OLLAMA_RUNTIME_PIN,
  type RuntimeStartOptions,
  type RuntimeStartResult,
  type RuntimeStatus,
} from '../src/local-model/runtime.js';
import { IDLE_LOCAL_MODEL_STATE, parseLocalModelState } from '../src/local-model/state-store.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import {
  LOCAL_MODEL_INSTALL_LABELS,
  type Candidate,
  type HardwareFacts,
  type HarnessFact,
  type LocalModelCatalog,
  type LocalModelInstallRequest,
  type LocalModelInstallStep,
  type LocalModelStateFile,
  type Recommendation,
} from '../src/types.js';

// ---------- Fixtures ----------

const DIGEST = '0ce5ff81f9ffdf89dd8192ca7b5d34cefd8996a875b3aaaaafaf5c4813569eba';
const PULL_BYTES = 23_105_798_956;
const RUNTIME_BYTES = OLLAMA_RUNTIME_PIN.bytes;
const MEASURED = 40_157_944_217;
const INSTALL_COMMAND = 'curl -fsSL https://opencode.ai/install | bash';
const ADMIN: LocalModelActor = { username: 'root', ip: '127.0.0.1' };

const MAC: HardwareFacts = {
  platform: 'darwin',
  arch: 'arm64',
  arm64: true,
  memBytes: 51539607552,
  memGb: '51.5',
  memClassGb: 48,
  chip: 'Apple M5 Pro',
  source: 'sysctl',
};

/** Only what the service reads of a catalogue: the harness rows and the models' ids and labels. */
const CATALOG = {
  schema: 1,
  updated: '2026-11-06',
  minMacosMajor: 14,
  models: [
    { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B' },
    { id: 'gpt-oss:20b', label: 'GPT-OSS 20B' },
    { id: 'qwen3.5:9b', label: 'Qwen3.5 9B' },
  ],
  harnesses: [
    { cli: 'opencode', minContext: 65536, rank: 3 },
    { cli: 'claude', minContext: 65536, rank: 2 },
  ],
  chips: [],
} as unknown as LocalModelCatalog;

const FACTS: HarnessFact[] = [
  {
    cli: 'opencode',
    label: 'OpenCode',
    installed: false,
    installable: true,
    installCommand: INSTALL_COMMAND,
    acceptsModelId: () => true,
  },
];

function candidate(
  modelId: string,
  modelLabel: string,
  context: number,
  bytes: number,
  installed: boolean,
  needBytes = 36_000_000_000
): Candidate {
  return {
    modelId,
    modelLabel,
    license: 'Apache-2.0',
    paramsB: 20,
    context,
    cli: 'opencode',
    cliLabel: 'OpenCode',
    cliInstalled: installed,
    needBytes,
    needGb: '0.0',
    downloadBytes: bytes,
    downloadGb: '0.0',
    budgetShare: 0.8,
    fit: 'good',
    fitLabel: 'Good',
    speed: 'unknown',
    tested: false,
    harnesses: [
      {
        cli: 'opencode',
        cliLabel: 'OpenCode',
        installed,
        ...(installed ? {} : { installCommand: INSTALL_COMMAND }),
      },
    ],
    installBytes: bytes + RUNTIME_BYTES,
    installGb: '0.0',
  } as unknown as Candidate;
}

function recommendation(agentInstalled = false): Recommendation {
  return {
    verdict: 'ok',
    headline: { text: 'Best fit for this Mac' },
    notes: [],
    pick: candidate('qwen3.6:35b-a3b', 'Qwen3.6 35B-A3B', 131072, PULL_BYTES, agentInstalled),
    // Needs less memory than the pick, so it is what "does not fit" offers next.
    alternatives: [candidate('gpt-oss:20b', 'GPT-OSS 20B', 131072, 13_793_441_427, agentInstalled, 26_600_000_000)],
    budgetBytes: 37_580_963_840,
    budgetGb: '37.6',
    budgetSource: 'estimated',
  } as unknown as Recommendation;
}

const REQUEST: LocalModelInstallRequest = {
  modelId: 'qwen3.6:35b-a3b',
  cli: 'opencode',
  context: 131072,
  acknowledgedBytes: PULL_BYTES + RUNTIME_BYTES,
};

const PATHS: LocalModelPaths = {
  root: '/data/local-model',
  runtimeRoot: '/data/local-model/runtime',
  runtimeDir: '/data/local-model/runtime/ollama-0.40.15',
  binary: '/data/local-model/runtime/ollama-0.40.15/ollama',
  archivePartial: '/data/local-model/runtime/ollama-0.40.15.tgz.partial',
  unpackDir: '/data/local-model/runtime/ollama-0.40.15.unpack',
  modelsDir: '/data/local-model/models',
  homeDir: '/data/local-model/home',
  stateFile: '/data/local-model.json',
};

const INSTALLED: LocalModelStateFile = {
  schema: 1,
  state: 'installed',
  model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', context: 131072, pullBytes: PULL_BYTES, digest: DIGEST },
  cli: { id: 'opencode', label: 'OpenCode' },
  runtime: { version: '0.40.15', port: 11435, pid: 4711, enabled: true, measuredTotalBytes: MEASURED },
  loaded: { context: 131072, sizeBytes: 26_300_000_000, sizeVramBytes: 26_300_000_000 },
  connection: { endpointId: 'local-ollama', flagWasEnabled: false },
};

function jobAt(step: LocalModelInstallStep, state: 'installing' | 'paused' = 'installing'): LocalModelStateFile {
  return {
    schema: 1,
    state,
    step,
    steps: ['runtime', 'model', 'verify', 'agent', 'connect'],
    model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', context: 131072 },
    cli: { id: 'opencode', label: 'OpenCode' },
    ...(step === 'runtime' ? {} : { runtime: { version: '0.40.15', port: 11435, pid: 5000, enabled: true } }),
  };
}

// ---------- The harness ----------

/** What a write to a full disk rejects with. */
function noSpace(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

/**
 * The state file in memory. Every write goes through the real parser, like a write to disk and
 * a read back. `refuse` makes the disk full: while it answers true for a write, that write
 * rejects with ENOSPC and the file keeps what it had, like the real temp file plus rename.
 */
function memoryStore(initial: LocalModelStateFile = IDLE_LOCAL_MODEL_STATE) {
  let state = initial;
  let chain: Promise<unknown> = Promise.resolve();
  const history: LocalModelStateFile[] = [];
  const disk = {
    refuse: undefined as ((next: LocalModelStateFile, before: LocalModelStateFile) => boolean) | undefined,
  };
  return {
    get: () => state,
    history,
    disk,
    readState: async () => state,
    mutateState: (fn: (current: LocalModelStateFile) => LocalModelStateFile | undefined) => {
      const run = chain.then(async () => {
        const before = state;
        const next = fn(before);
        if (!next) return { before, after: undefined };
        if (disk.refuse?.(next, before)) throw noSpace();
        state = parseLocalModelState(JSON.stringify(next));
        history.push(state);
        return { before, after: state };
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}

/** Resolves when `signal` aborts. What a step in flight waits on in a Cancel test. */
function untilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function setup(
  options: {
    state?: LocalModelStateFile;
    agentInstalled?: boolean;
    runtimeOnDisk?: boolean;
    overrides?: Partial<LocalModelServiceDeps>;
  } = {}
) {
  const store = memoryStore(options.state);
  const world = {
    // A model that is installed was installed with its coding agent: what the world holds
    // then, unless the test says the agent has gone since.
    agentInstalled: options.agentInstalled ?? options.state?.state === 'installed',
    runtimeOnDisk: options.runtimeOnDisk ?? false,
    clock: 1_000_000,
    startResult: undefined as RuntimeStartResult | undefined,
    measured: MEASURED as number | undefined,
    running: false,
    gaveUp: false,
    pid: 5000,
    /** What the runtime lists on disk. Default: the model of the state, as it was pulled. */
    tags: undefined as { name: string; size: number; digest: string }[] | undefined,
    /** What the model store takes on disk. */
    storeBytes: 0,
  };
  const calls: string[] = [];

  const supervisor = {
    start: vi.fn(async (start: RuntimeStartOptions): Promise<RuntimeStartResult> => {
      calls.push('supervisor.start');
      if (world.startResult && !world.startResult.ok) {
        world.running = false;
        return world.startResult;
      }
      world.running = true;
      return {
        ok: true,
        pid: world.pid,
        port: start.port,
        orphan: 'none',
        ...(world.measured !== undefined ? { measuredTotalBytes: world.measured } : {}),
      };
    }),
    stop: vi.fn(async (_options?: { previousPid?: number }) => {
      calls.push('supervisor.stop');
      world.running = false;
    }),
    status: (): RuntimeStatus => ({ running: world.running, restarts: 0, gaveUp: world.gaveUp }),
  };

  const deps = {
    readHardware: vi.fn(async () => MAC),
    getCatalog: vi.fn(() => CATALOG),
    // The facts follow the world, like the real probe: an agent that is on this Mac is not
    // offered for install, and one that is missing is.
    buildHarnessFacts: vi.fn(
      async (): Promise<HarnessFact[]> =>
        FACTS.map((fact) =>
          world.agentInstalled
            ? {
                cli: fact.cli,
                label: fact.label,
                installed: true,
                installable: false,
                acceptsModelId: fact.acceptsModelId,
              }
            : fact
        )
    ),
    recommend: vi.fn(() => recommendation(world.agentInstalled)),
    modelFitsBudget: vi.fn(() => true),
    isRuntimeInstalled: vi.fn(async () => world.runtimeOnDisk),
    ensureRuntimeInstalled: vi.fn(
      async (install?: { onProgress?: (p: { completedBytes: number; totalBytes: number }) => void }) => {
        calls.push('ensureRuntimeInstalled');
        install?.onProgress?.({ completedBytes: RUNTIME_BYTES, totalBytes: RUNTIME_BYTES });
        world.runtimeOnDisk = true;
        return { ok: true as const, binaryPath: PATHS.binary, alreadyInstalled: false };
      }
    ),
    chooseRuntimePort: vi.fn(async () => 11435 as number | undefined),
    removeLocalModelFiles: vi.fn(async () => {
      calls.push('removeLocalModelFiles');
      world.runtimeOnDisk = false;
    }),
    supervisor,
    pullModel: vi.fn(async (_target: unknown, _id: string, pull?: { onProgress?: (p: unknown) => void }) => {
      calls.push('pullModel');
      pull?.onProgress?.({ completedBytes: PULL_BYTES, totalBytes: PULL_BYTES, bytesPerSecond: 58_000_000 });
      return { ok: true as const, totalBytes: PULL_BYTES };
    }),
    verifyModel: vi.fn(async () => {
      calls.push('verifyModel');
      return {
        ok: true as const,
        loaded: { context: 131072, sizeBytes: 26_300_000_000, sizeVramBytes: 26_300_000_000 },
      };
    }),
    readModelDigest: vi.fn(async () => DIGEST as string | undefined),
    // The runtime lists what was pulled: the model of the job.
    listOpenAiModels: vi.fn(async () => [store.get().model?.id ?? '']),
    listRunning: vi.fn(async () => [
      { name: 'qwen3.6:35b-a3b', size: 26_300_000_000, sizeVram: 26_300_000_000, contextLength: 32768 },
    ]),
    getRuntimeVersion: vi.fn(async () => '0.40.15' as string | undefined),
    deleteModel: vi.fn(async (_target: unknown, _id: string) => {
      calls.push('deleteModel');
      return true;
    }),
    listTags: vi.fn(async () => {
      if (world.tags) return world.tags;
      const model = store.get().model;
      return model ? [{ name: model.id, size: PULL_BYTES, digest: DIGEST }] : [];
    }),
    removePartialModelBlobs: vi.fn(async () => {
      calls.push('removePartialModelBlobs');
      return 0;
    }),
    measureModelStore: vi.fn(async () => world.storeBytes),
    checkDeveloperTools: vi.fn(async () => 'missing' as const),
    stockInstallCommand: vi.fn((id: string) => (id === FACTS[0].cli ? INSTALL_COMMAND : undefined)),
    tryBeginCliInstall: vi.fn((): (() => void) | null => () => {
      calls.push('release');
    }),
    runInstallCommand: vi.fn(async () => {
      calls.push('runInstallCommand');
      world.agentInstalled = true;
      return { code: 0 as number | null, output: 'opencode installed\n', timedOut: false, aborted: false };
    }),
    recheckCliInstalled: vi.fn(async () => {
      calls.push('recheckCliInstalled');
      return world.agentInstalled;
    }),
    audit: vi.fn(async () => {}),
    // Nothing saved under the reserved id, and the endpoints setting is off: a first install.
    inspectLocalEndpoint: vi.fn(async () => ({ record: 'absent' as 'absent' | 'same' | 'other', flagEnabled: false })),
    connectLocalModel: vi.fn(async () => {
      calls.push('connectLocalModel');
      return { ok: true as const, flagWasEnabled: false };
    }),
    moveLocalEndpoint: vi.fn(async () => {}),
    ensureLocalEndpoint: vi.fn(async () => false),
    disconnectLocalModel: vi.fn(async () => {
      calls.push('disconnectLocalModel');
    }),
    isEndpointIdTaken: vi.fn(async () => false),
    readState: store.readState,
    mutateState: store.mutateState,
    pin: OLLAMA_RUNTIME_PIN,
    paths: PATHS,
    now: () => world.clock,
    ...options.overrides,
  };

  const service = createLocalModelService(deps as unknown as Partial<LocalModelServiceDeps>);
  return { service, store, world, deps, supervisor, calls };
}

/** Starts the job and waits for its end. */
async function installAndWait(service: LocalModelService, request = REQUEST) {
  const result = await service.install(request, ADMIN);
  await service.idle();
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- The whole job ----------

describe('a job from the click to installed', () => {
  it('runs the five steps in order and ends installed, with every fact a later start needs', async () => {
    const { service, store, calls, deps } = setup();
    const started = await service.install(REQUEST, ADMIN);
    // The verb answers once the job is started: the work goes on in the server.
    expect(started.ok && started.view.state).toBe('installing');
    await service.idle();

    expect(calls).toEqual([
      'ensureRuntimeInstalled',
      'supervisor.start',
      'supervisor.start',
      'pullModel',
      'supervisor.start',
      'verifyModel',
      'recheckCliInstalled',
      'runInstallCommand',
      'release',
      'recheckCliInstalled',
      'supervisor.start',
      'connectLocalModel',
    ]);
    expect(store.get()).toMatchObject({
      schema: 1,
      state: 'installed',
      model: {
        id: 'qwen3.6:35b-a3b',
        label: 'Qwen3.6 35B-A3B',
        context: 131072,
        pullBytes: PULL_BYTES,
        digest: DIGEST,
      },
      cli: { id: 'opencode', label: 'OpenCode' },
      runtime: { version: '0.40.15', port: 11435, pid: 5000, enabled: true, measuredTotalBytes: MEASURED },
      loaded: { context: 131072, sizeBytes: 26_300_000_000, sizeVramBytes: 26_300_000_000 },
      connection: { endpointId: 'local-ollama', flagWasEnabled: false },
    });
    // A job's own members are gone once it is installed.
    for (const key of ['step', 'steps', 'progress', 'error']) expect(store.get()).not.toHaveProperty(key);

    // The runtime was started on the chosen port with the chosen context, every time.
    for (const [start] of deps.supervisor.start.mock.calls) {
      expect(start).toMatchObject({ port: 11435, contextLength: 131072 });
    }
    // The connection names the model as the runtime lists it, at the chosen context. It was
    // claimed in the state file first, so the record is written as ours.
    expect(deps.connectLocalModel).toHaveBeenCalledWith({
      port: 11435,
      modelId: 'qwen3.6:35b-a3b',
      context: 131072,
      ours: true,
      flagWasEnabled: false,
    });
  });

  it('walks the steps one at a time in the state file', async () => {
    const { service, store } = setup();
    await installAndWait(service);
    const steps = store.history.map((state) => `${state.state}:${state.step ?? '-'}`);
    const order = steps.filter((entry, index) => entry !== steps[index - 1]);
    expect(order).toEqual([
      'installing:runtime',
      'installing:model',
      'installing:verify',
      'installing:agent',
      'installing:connect',
      'installed:-',
    ]);
  });

  it('the view of the installed model: the Done facts, the endpoint, and a session can be started', async () => {
    const { service } = setup();
    await installAndWait(service);
    const view = await service.view();
    expect(view).toMatchObject({
      state: 'installed',
      running: true,
      developerTools: 'missing',
      model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B' },
      cli: 'opencode',
      cliLabel: 'OpenCode',
      context: 131072,
      port: 11435,
      loaded: { context: 131072, memoryBytes: 26_300_000_000, memoryGb: '26.3', onGpu: true },
      endpointId: 'local-ollama',
      actions: ['start-session', 'stop', 'install', 'remove'],
      folder: '/data/local-model',
      runtime: { version: '0.40.15', installed: true, downloadBytes: 0 },
    });
    expect(view).not.toHaveProperty('error');
    expect(await service.launchRefusal('local-ollama')).toBeUndefined();
  });

  it('a coding agent that is installed is not part of the job: nothing is run for it', async () => {
    const { service, store, deps } = setup({ agentInstalled: true });
    await installAndWait(service);
    expect(store.get().state).toBe('installed');
    expect(store.history.some((state) => state.step === 'agent')).toBe(false);
    expect(deps.runInstallCommand).not.toHaveBeenCalled();
    expect(deps.recheckCliInstalled).not.toHaveBeenCalled();
  });

  it('judges the model against the MEASURED budget right after the runtime started, before the pull', async () => {
    const { service, deps, calls } = setup();
    await installAndWait(service);
    expect(deps.modelFitsBudget).toHaveBeenCalledTimes(1);
    expect(deps.modelFitsBudget).toHaveBeenCalledWith(MAC, CATALOG, 'qwen3.6:35b-a3b', 131072, {
      measuredTotalBytes: MEASURED,
      runtimeDownloadBytes: 0,
    });
    expect(deps.modelFitsBudget.mock.invocationCallOrder[0]).toBeLessThan(deps.pullModel.mock.invocationCallOrder[0]);
    expect(calls.indexOf('pullModel')).toBeGreaterThan(0);
  });

  it('from then on the GET recommends with the measured budget and no runtime download', async () => {
    const { service } = setup();
    expect(await service.recommendOptions()).toEqual({ runtimeDownloadBytes: RUNTIME_BYTES });
    await installAndWait(service);
    expect(await service.recommendOptions()).toEqual({ measuredTotalBytes: MEASURED, runtimeDownloadBytes: 0 });
  });

  it('every size shown for the model comes from the pull once it is known', async () => {
    const pull = vi.fn(async () => ({ ok: true as const, totalBytes: 23_999_000_111 }));
    const { service, store } = setup({ overrides: { pullModel: pull } });
    await installAndWait(service);
    expect(store.get().model?.pullBytes).toBe(23_999_000_111);
  });

  it('writes an audit line for the install and one for the coding agent, with the literal command', async () => {
    const { service, deps } = setup();
    await installAndWait(service);
    expect(deps.audit).toHaveBeenCalledWith({
      admin: 'root',
      action: 'local_model_install',
      target: 'qwen3.6:35b-a3b',
      ip: '127.0.0.1',
      detail: { cli: 'opencode', context: 131072, bytes: PULL_BYTES + RUNTIME_BYTES },
    });
    expect(deps.audit).toHaveBeenCalledWith({
      admin: 'root',
      action: 'cli_install',
      target: 'opencode',
      ip: '127.0.0.1',
      detail: { command: INSTALL_COMMAND, exitCode: 0, timedOut: false, aborted: false, via: 'local-model' },
    });
  });

  it('the port is chosen once: a job that already has one keeps it', async () => {
    const { service, deps, store } = setup({
      state: { ...jobAt('runtime', 'paused'), runtime: { version: '0.40.15', port: 11440, enabled: true } },
    });
    await service.resume({}, ADMIN);
    await service.idle();
    expect(deps.chooseRuntimePort).not.toHaveBeenCalled();
    expect(store.get().runtime?.port).toBe(11440);
    expect(deps.connectLocalModel).toHaveBeenCalledWith(expect.objectContaining({ port: 11440 }));
  });
});

// ---------- What install checks first ----------

describe('install is checked before anything is downloaded', () => {
  const nothingStarted = (h: ReturnType<typeof setup>) => {
    expect(h.store.get()).toBe(IDLE_LOCAL_MODEL_STATE);
    expect(h.deps.ensureRuntimeInstalled).not.toHaveBeenCalled();
    expect(h.deps.pullModel).not.toHaveBeenCalled();
    expect(h.supervisor.start).not.toHaveBeenCalled();
    expect(h.deps.audit).not.toHaveBeenCalled();
  };

  it('consent is bound to the size shown: other bytes are 409 size-changed with the total', async () => {
    const h = setup();
    const result = await h.service.install({ ...REQUEST, acknowledgedBytes: PULL_BYTES }, ADMIN);
    expect(result).toEqual({
      ok: false,
      status: 409,
      conflict: {
        reason: 'size-changed',
        message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSizeChanged, vars: { size: '23.3' } },
        expectedBytes: PULL_BYTES + RUNTIME_BYTES,
        expectedGb: '23.3',
      },
    });
    nothingStarted(h);
  });

  it('once the runtime is on disk the total is the model alone, so the earlier figure is refused', async () => {
    const h = setup({ runtimeOnDisk: true });
    h.deps.recommend.mockImplementation(() => {
      const rec = recommendation();
      for (const row of [rec.pick!, ...rec.alternatives]) row.installBytes = row.downloadBytes;
      return rec;
    });
    const stale = await h.service.install(REQUEST, ADMIN);
    expect(stale).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: 'size-changed', expectedBytes: PULL_BYTES },
    });
    nothingStarted(h);
    const fresh = await h.service.install({ ...REQUEST, acknowledgedBytes: PULL_BYTES }, ADMIN);
    expect(fresh.ok).toBe(true);
    await h.service.idle();
  });

  it('a row without its own total is the model download plus the runtime download', async () => {
    const h = setup();
    h.deps.recommend.mockImplementation(() => {
      const rec = recommendation();
      delete (rec.pick as Partial<Candidate>).installBytes;
      delete (rec.pick as Partial<Candidate>).harnesses;
      return rec;
    });
    const wrong = await h.service.install({ ...REQUEST, acknowledgedBytes: PULL_BYTES }, ADMIN);
    expect(wrong).toMatchObject({ ok: false, status: 409, conflict: { expectedBytes: PULL_BYTES + RUNTIME_BYTES } });
    const right = await h.service.install(REQUEST, ADMIN);
    expect(right.ok).toBe(true);
    await h.service.idle();
    expect(h.store.get().state).toBe('installed');
  });

  it.each([
    ['a model the server does not offer', { modelId: 'llama9:900b' }],
    ['an offered model at another context', { context: 65536 }],
    ['a coding agent the row does not list', { cli: 'claude' }],
    ['a coding agent that is no CLI at all', { cli: 'rm' }],
  ])('%s is a 400', async (_label, change) => {
    const h = setup();
    const result = await h.service.install({ ...REQUEST, ...change }, ADMIN);
    expect(result).toMatchObject({ ok: false, status: 400 });
    nothingStarted(h);
  });

  it('a coding agent the row lists but the catalogue does not have is a 400', async () => {
    const h = setup();
    h.deps.getCatalog.mockReturnValue({ ...CATALOG, harnesses: [] } as unknown as LocalModelCatalog);
    expect(await h.service.install(REQUEST, ADMIN)).toMatchObject({ ok: false, status: 400 });
    nothingStarted(h);
  });

  it('a missing coding agent without a stock install command is a 400', async () => {
    const h = setup();
    h.deps.stockInstallCommand.mockReturnValue(undefined);
    const result = await h.service.install(REQUEST, ADMIN);
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: { text: '{cli} is not installed and cannot be installed from here.', vars: { cli: 'OpenCode' } },
    });
    nothingStarted(h);
  });

  it('a saved endpoint that already has our id is said now, not after the download', async () => {
    const h = setup();
    h.deps.isEndpointIdTaken.mockResolvedValue(true);
    const result = await h.service.install(REQUEST, ADMIN);
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: {
        text: 'A saved model connection named {id} already exists and was not created here. Rename or delete it in App Settings, then try again.',
        vars: { id: 'local-ollama' },
      },
    });
    nothingStarted(h);
  });

  it('when no model is recommended nothing can be installed', async () => {
    const h = setup();
    h.deps.recommend.mockReturnValue({
      verdict: 'none',
      reason: 'not-macos',
      headline: { text: 'x' },
      notes: [],
      alternatives: [],
      budgetBytes: 0,
      budgetGb: '0.0',
      budgetSource: 'estimated',
    } as unknown as Recommendation);
    expect(await h.service.install(REQUEST, ADMIN)).toMatchObject({ ok: false, status: 400 });
    nothingStarted(h);
  });

  it('an alternative row installs like the pick', async () => {
    const h = setup();
    const result = await installAndWait(h.service, {
      modelId: 'gpt-oss:20b',
      cli: 'opencode',
      context: 131072,
      acknowledgedBytes: 13_793_441_427 + RUNTIME_BYTES,
    });
    expect(result.ok).toBe(true);
    expect(h.store.get()).toMatchObject({ state: 'installed', model: { id: 'gpt-oss:20b', label: 'GPT-OSS 20B' } });
  });
});

// ---------- One job at a time ----------

describe('one job at a time', () => {
  it('while a job runs, a second install, a resume, a runtime action and a remove are 409 job-running', async () => {
    const h = setup({
      overrides: {
        pullModel: vi.fn(async (_t: unknown, _id: string, pull?: { signal?: AbortSignal }) => {
          await untilAborted(pull?.signal);
          return { ok: false as const, code: 'cancelled' as const };
        }),
      },
    });
    await h.service.install(REQUEST, ADMIN);
    await vi.waitFor(() => expect(h.store.get().step).toBe('model'));

    const jobRunning = { ok: false, status: 409, conflict: { reason: 'job-running' } };
    expect(await h.service.install(REQUEST, ADMIN)).toMatchObject(jobRunning);
    expect(await h.service.resume({}, ADMIN)).toMatchObject(jobRunning);
    expect(await h.service.use({ modelId: 'gpt-oss:20b' }, ADMIN)).toMatchObject(jobRunning);
    expect(await h.service.deleteLibraryModel({ modelId: 'gpt-oss:20b' }, ADMIN)).toMatchObject(jobRunning);
    expect(await h.service.runtime({ action: 'stop' })).toMatchObject(jobRunning);
    expect(await h.service.remove({}, [])).toMatchObject(jobRunning);
    expect(h.deps.ensureRuntimeInstalled).toHaveBeenCalledTimes(1);
    expect(h.supervisor.stop).not.toHaveBeenCalled();
    expect(h.deps.removeLocalModelFiles).not.toHaveBeenCalled();

    await h.service.cancel();
  });

  it('two installs sent at the same moment: one starts, the other is refused', async () => {
    const h = setup();
    const [first, second] = await Promise.all([h.service.install(REQUEST, ADMIN), h.service.install(REQUEST, ADMIN)]);
    expect(first.ok).toBe(true);
    // The second finds the first's job running, or (it ran to its end already) a model installed.
    expect(second).toMatchObject({ ok: false, status: 409 });
    await h.service.idle();
    expect(h.deps.ensureRuntimeInstalled).toHaveBeenCalledTimes(1);
  });

  it('an install of the model that is in use, at its context, is 409 already-installed', async () => {
    const h = setup({ state: INSTALLED });
    expect(await h.service.install(REQUEST, ADMIN)).toEqual({
      ok: false,
      status: 409,
      conflict: { reason: 'already-installed', message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictAlreadyInstalled } },
    });
  });

  it.each([
    ['cancel with no job', (s: LocalModelService) => s.cancel(), IDLE_LOCAL_MODEL_STATE],
    ['cancel while paused', (s: LocalModelService) => s.cancel(), jobAt('model', 'paused')],
    ['cancel while installed', (s: LocalModelService) => s.cancel(), INSTALLED],
    ['resume with no job', (s: LocalModelService) => s.resume({}, ADMIN), IDLE_LOCAL_MODEL_STATE],
    ['resume while installed', (s: LocalModelService) => s.resume({}, ADMIN), INSTALLED],
    [
      'a runtime action with nothing installed',
      (s: LocalModelService) => s.runtime({ action: 'start' }),
      IDLE_LOCAL_MODEL_STATE,
    ],
    [
      'a runtime action on a paused job',
      (s: LocalModelService) => s.runtime({ action: 'stop' }),
      jobAt('model', 'paused'),
    ],
  ])('%s is 409 wrong-state and changes nothing', async (_label, verb, state) => {
    const h = setup({ state });
    expect(await verb(h.service)).toEqual({
      ok: false,
      status: 409,
      conflict: { reason: 'wrong-state', message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictWrongState } },
    });
    expect(h.store.history).toEqual([]);
  });
});

// ---------- Cancel ----------

describe('Cancel in every step', () => {
  /** A fake that waits for the abort signal at position `at` of its arguments' options, then says cancelled. */
  const blocked: Record<Exclude<LocalModelInstallStep, 'connect'>, Partial<LocalModelServiceDeps>> = {
    runtime: {
      ensureRuntimeInstalled: vi.fn(async (install?: { signal?: AbortSignal }) => {
        await untilAborted(install?.signal);
        return { ok: false as const, code: 'cancelled' as const };
      }),
    },
    model: {
      pullModel: vi.fn(async (_t: unknown, _id: string, pull?: { signal?: AbortSignal }) => {
        await untilAborted(pull?.signal);
        return { ok: false as const, code: 'cancelled' as const };
      }),
    },
    verify: {
      verifyModel: vi.fn(async (_t: unknown, _id: string, _ctx: number, signal?: AbortSignal) => {
        await untilAborted(signal);
        return { ok: false as const, code: 'cancelled' as const };
      }),
    },
    agent: {
      runInstallCommand: vi.fn(async (_command: string, run?: { signal?: AbortSignal }) => {
        await untilAborted(run?.signal);
        return { code: null, output: '', timedOut: false, aborted: true };
      }),
    },
  } as unknown as Record<Exclude<LocalModelInstallStep, 'connect'>, Partial<LocalModelServiceDeps>>;

  it.each(['runtime', 'model', 'verify', 'agent'] as const)(
    'in the %s step: the step in flight is interrupted and the job is paused there',
    async (step) => {
      const h = setup({ overrides: blocked[step] });
      await h.service.install(REQUEST, ADMIN);
      await vi.waitFor(() => expect(h.store.get().step).toBe(step));
      await vi.waitFor(() => expect(Object.values(blocked[step])[0]).toHaveBeenCalled());

      const result = await h.service.cancel();
      expect(result.ok && result.view).toMatchObject({
        state: 'paused',
        step,
        actions: ['resume', 'install', 'remove'],
      });
      expect(h.store.get()).toMatchObject({ state: 'paused', step });
      // Paused is not failed: no error was stored, and nothing went on after the step.
      expect(h.store.get()).not.toHaveProperty('error');
      expect(h.store.history.some((state) => state.state === 'failed')).toBe(false);
      expect(h.deps.connectLocalModel).not.toHaveBeenCalled();
      await h.service.idle();
      expect(h.store.get().state).toBe('paused');
    }
  );

  it('an interrupted step that answers with an error instead of "cancelled" is still a pause, not a failure', async () => {
    const h = setup({
      overrides: {
        pullModel: vi.fn(async (_t: unknown, _id: string, pull?: { signal?: AbortSignal }) => {
          await untilAborted(pull?.signal);
          return { ok: false as const, code: 'pull-failed' as const, detail: 'socket hang up' };
        }),
      },
    });
    await h.service.install(REQUEST, ADMIN);
    await vi.waitFor(() => expect(h.store.get().step).toBe('model'));
    await vi.waitFor(() => expect(h.deps.pullModel).toHaveBeenCalled());
    await h.service.cancel();
    expect(h.store.get()).toMatchObject({ state: 'paused', step: 'model' });
    expect(h.store.get()).not.toHaveProperty('error');
  });

  it('in the connect step, before the first write: honoured, and nothing was written', async () => {
    const h = setup({
      overrides: {
        listOpenAiModels: vi.fn(async (_t: unknown, signal?: AbortSignal) => {
          await untilAborted(signal);
          return ['qwen3.6:35b-a3b'];
        }),
      },
    });
    await h.service.install(REQUEST, ADMIN);
    await vi.waitFor(() => expect(h.deps.listOpenAiModels).toHaveBeenCalled());
    const result = await h.service.cancel();
    expect(result.ok && result.view.state).toBe('paused');
    expect(h.store.get()).toMatchObject({ state: 'paused', step: 'connect' });
    expect(h.deps.connectLocalModel).not.toHaveBeenCalled();
    expect(h.store.get()).not.toHaveProperty('connection');
  });

  it('in the connect step, once the writes began: they finish and the job ends installed', async () => {
    let release: () => void = () => {};
    const writing = new Promise<void>((resolve) => (release = resolve));
    const h = setup({
      overrides: {
        connectLocalModel: vi.fn(async () => {
          await writing;
          return { ok: true as const, flagWasEnabled: true };
        }),
      },
    });
    // What the claim keeps: the setting was on before this feature touched it.
    h.deps.inspectLocalEndpoint.mockResolvedValue({ record: 'absent', flagEnabled: true });
    await h.service.install(REQUEST, ADMIN);
    await vi.waitFor(() => expect(h.deps.connectLocalModel).toHaveBeenCalled());
    const cancelling = h.service.cancel();
    release();
    const result = await cancelling;
    // The pair is never left half done: the answer is the view after the verb, installed.
    expect(result.ok && result.view.state).toBe('installed');
    expect(h.store.get()).toMatchObject({
      state: 'installed',
      connection: { endpointId: 'local-ollama', flagWasEnabled: true },
    });
  });

  it('keeps the download as it stood, without a speed', async () => {
    const h = setup({
      overrides: {
        pullModel: vi.fn(async (_t: unknown, _id: string, pull?: PullOptions) => {
          pull?.onProgress?.({ completedBytes: 6_200_000_000, totalBytes: PULL_BYTES, bytesPerSecond: 58_000_000 });
          await untilAborted(pull?.signal);
          return { ok: false as const, code: 'cancelled' as const };
        }),
      },
    });
    await h.service.install(REQUEST, ADMIN);
    await vi.waitFor(async () => expect((await h.service.view()).progress?.completedBytes).toBe(6_200_000_000));
    // While it runs the window sees the live figure and the speed.
    expect((await h.service.view()).progress).toEqual({
      completedBytes: 6_200_000_000,
      totalBytes: PULL_BYTES,
      completedGb: '6.2',
      totalGb: '23.1',
      bytesPerSecond: 58_000_000,
      mbPerSecond: '58',
      secondsLeft: 292,
    });
    const result = await h.service.cancel();
    expect(result.ok && result.view.progress).toEqual({
      completedBytes: 6_200_000_000,
      totalBytes: PULL_BYTES,
      completedGb: '6.2',
      totalGb: '23.1',
    });
    expect(h.store.get().progress).toEqual({ completedBytes: 6_200_000_000, totalBytes: PULL_BYTES });
  });

  it('a runtime that already runs keeps running after a Cancel', async () => {
    const h = setup({ overrides: blocked.model });
    await h.service.install(REQUEST, ADMIN);
    await vi.waitFor(() => expect(h.store.get().step).toBe('model'));
    await h.service.cancel();
    expect(h.supervisor.stop).not.toHaveBeenCalled();
    expect((await h.service.view()).running).toBe(true);
  });
});

// ---------- Resume ----------

describe('Resume', () => {
  it('re-enters the step the job stopped in and does not repeat the steps before it', async () => {
    const h = setup({ state: jobAt('verify', 'paused'), runtimeOnDisk: true });
    const result = await h.service.resume({}, ADMIN);
    expect(result.ok && result.view.state).toBe('installing');
    await h.service.idle();
    expect(h.store.get().state).toBe('installed');
    expect(h.deps.ensureRuntimeInstalled).not.toHaveBeenCalled();
    expect(h.deps.pullModel).not.toHaveBeenCalled();
    expect(h.deps.verifyModel).toHaveBeenCalledTimes(1);
    // The step needs the runtime: it is started first, with the stored port and the old pid.
    expect(h.supervisor.start.mock.calls[0][0]).toEqual({ port: 11435, contextLength: 131072, previousPid: 5000 });
  });

  it('"Try again" after a failure clears the error and runs the same step again', async () => {
    const h = setup();
    h.deps.verifyModel.mockResolvedValueOnce({
      ok: false,
      code: 'probe-unfinished',
      detail: 'finish_reason length',
    } as never);
    await installAndWait(h.service);
    expect(h.store.get()).toMatchObject({ state: 'failed', step: 'verify', error: { code: 'probe-unfinished' } });
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.store.get().state).toBe('installed');
    expect(h.deps.pullModel).toHaveBeenCalledTimes(1);
    expect(h.deps.verifyModel).toHaveBeenCalledTimes(2);
  });

  it('a resumed agent step looks for the binary first and runs no installer when it is there', async () => {
    const h = setup({ state: jobAt('agent', 'paused'), agentInstalled: true });
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.store.get().state).toBe('installed');
    expect(h.deps.recheckCliInstalled).toHaveBeenCalledTimes(1);
    expect(h.deps.runInstallCommand).not.toHaveBeenCalled();
    expect(h.deps.audit).not.toHaveBeenCalled();
  });

  it('"Use another port" chooses a port that is not the stored one before it resumes', async () => {
    const h = setup({
      state: { ...jobAt('model', 'paused'), state: 'failed', error: { code: 'port-in-use', vars: { port: '11435' } } },
    });
    h.deps.chooseRuntimePort.mockResolvedValue(11436);
    await h.service.resume({ newPort: true }, ADMIN);
    await h.service.idle();
    expect(h.deps.chooseRuntimePort).toHaveBeenCalledWith({ avoid: [11435] });
    expect(h.store.get()).toMatchObject({ state: 'installed', runtime: { port: 11436 } });
    // The stored pid goes along: when it is still our own runtime on the OLD port, the start
    // ends it instead of leaving a second runtime behind.
    expect(h.supervisor.start.mock.calls[0][0]).toEqual({ port: 11436, contextLength: 131072, previousPid: 5000 });
    expect(h.deps.connectLocalModel).toHaveBeenCalledWith(expect.objectContaining({ port: 11436 }));
  });
});

// ---------- A server restart ----------

describe('a job a server restart interrupted', () => {
  it('comes back paused at the same step, and nothing runs without a click', async () => {
    const h = setup({ state: jobAt('model') });
    const view = await h.service.view();
    expect(view).toMatchObject({ state: 'paused', step: 'model', actions: ['resume', 'install', 'remove'] });
    expect(h.store.get()).toMatchObject({ state: 'paused', step: 'model' });
    await h.service.idle();
    expect(h.calls).toEqual([]);
  });

  it('boot() does the same, and starts no runtime for a job', async () => {
    const h = setup({ state: jobAt('verify') });
    await h.service.boot();
    expect(h.store.get()).toMatchObject({ state: 'paused', step: 'verify' });
    expect(h.supervisor.start).not.toHaveBeenCalled();
    // The runtime the killed server left behind is ended: nothing would use it until a click.
    expect(h.calls).toEqual(['supervisor.stop']);
    expect(h.supervisor.stop).toHaveBeenCalledWith({ previousPid: 5000 });
  });

  it('boot() ends nothing for a job that never started a runtime', async () => {
    const h = setup({ state: jobAt('runtime') });
    await h.service.boot();
    expect(h.store.get()).toMatchObject({ state: 'paused', step: 'runtime' });
    expect(h.calls).toEqual([]);
  });

  it.each(['install', 'cancel', 'resume', 'remove'] as const)(
    'a %s sent before anything else finds it paused, not running',
    async (verb) => {
      const h = setup({ state: jobAt('model') });
      const result =
        verb === 'install'
          ? await h.service.install(REQUEST, ADMIN)
          : verb === 'cancel'
            ? await h.service.cancel()
            : verb === 'resume'
              ? await h.service.resume({}, ADMIN)
              : await h.service.remove({}, []);
      // A paused job accepts install, resume and remove; Cancel has nothing to cancel.
      if (verb === 'cancel') expect(result).toMatchObject({ ok: false, conflict: { reason: 'wrong-state' } });
      else expect(result.ok).toBe(true);
      expect(h.store.history[0]).toMatchObject({ state: 'paused', step: 'model' });
      await h.service.idle();
    }
  );

  it('shutdown interrupts the job without a word in the state file, so the next start reads it as paused', async () => {
    const pull = vi.fn(async (_t: unknown, _id: string, options?: { signal?: AbortSignal }) => {
      await untilAborted(options?.signal);
      return { ok: false as const, code: 'pull-failed' as const, detail: 'aborted' };
    });
    const h = setup({ overrides: { pullModel: pull } });
    await h.service.install(REQUEST, ADMIN);
    await vi.waitFor(() => expect(pull).toHaveBeenCalled());

    await h.service.shutdown();
    expect(h.supervisor.stop).toHaveBeenCalledTimes(1);
    // Neither paused nor failed was written: the file still says installing.
    expect(h.store.get()).toMatchObject({ state: 'installing', step: 'model' });

    // The next server process: a new service over the same file.
    const next = setup({ state: h.store.get() });
    expect((await next.service.view()).state).toBe('paused');
    expect(next.calls).toEqual([]);
  });

  it('paused, failed and installed stay what they were across a restart', async () => {
    const failed: LocalModelStateFile = {
      ...jobAt('verify', 'paused'),
      state: 'failed',
      error: { code: 'no-tool-call' },
    };
    for (const state of [
      jobAt('model', 'paused'),
      failed,
      { ...INSTALLED, runtime: { ...INSTALLED.runtime!, enabled: false } },
    ]) {
      const h = setup({ state });
      await h.service.boot();
      expect(h.store.get()).toEqual(state);
      expect(h.store.history).toEqual([]);
    }
  });
});

// ---------- Boot of an installed model ----------

describe('boot with a model installed', () => {
  it('starts the runtime on the stored port, with the stored pid to tell an orphan of ours, and reads the digest again', async () => {
    const h = setup({ state: INSTALLED, runtimeOnDisk: true });
    await h.service.boot();
    expect(h.supervisor.start).toHaveBeenCalledWith({ port: 11435, contextLength: 131072, previousPid: 4711 });
    expect(h.deps.readModelDigest).toHaveBeenCalledWith(
      { baseUrl: 'http://127.0.0.1:11435' },
      'qwen3.6:35b-a3b',
      expect.anything()
    );
    // The pid of the child that runs now replaces the stored one.
    expect(h.store.get().runtime?.pid).toBe(5000);
    const view = await h.service.view();
    expect(view).toMatchObject({
      state: 'installed',
      running: true,
      actions: ['start-session', 'stop', 'install', 'remove'],
    });
    expect(view).not.toHaveProperty('error');
  });

  it('puts the saved endpoint back when it is gone (a config-backup restore), also for a stopped runtime', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: { ...INSTALLED, runtime: { ...INSTALLED.runtime!, enabled: false } } });
    h.deps.ensureLocalEndpoint.mockResolvedValue(true);
    await h.service.boot();
    expect(h.deps.ensureLocalEndpoint).toHaveBeenCalledWith({
      port: 11435,
      modelId: 'qwen3.6:35b-a3b',
      context: 131072,
    });
    expect(warn.mock.calls.flat().join(' ')).toContain('was put back');
    // The settings flag is not touched at boot: only the record.
    expect(h.deps.connectLocalModel).not.toHaveBeenCalled();
    expect(h.supervisor.start).not.toHaveBeenCalled();
  });

  it('writes no endpoint for an installation that never connected, nor for a job', async () => {
    const { connection: _connection, ...unconnected } = INSTALLED;
    for (const state of [unconnected, jobAt('connect', 'paused')]) {
      const h = setup({ state });
      await h.service.boot();
      expect(h.deps.ensureLocalEndpoint).not.toHaveBeenCalled();
    }
  });

  it('does not start a runtime the person stopped', async () => {
    const h = setup({ state: { ...INSTALLED, runtime: { ...INSTALLED.runtime!, enabled: false } } });
    await h.service.boot();
    expect(h.supervisor.start).not.toHaveBeenCalled();
    const view = await h.service.view();
    expect(view).toMatchObject({ state: 'installed', running: false, actions: ['start', 'install', 'remove'] });
    // A stopped runtime is not an error.
    expect(view).not.toHaveProperty('error');
  });

  it('a model whose digest changed: the state stays installed, the view says why, and no session is offered', async () => {
    const h = setup({ state: INSTALLED });
    h.deps.readModelDigest.mockResolvedValue('ffff00000000');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await h.service.boot();
    const view = await h.service.view();
    expect(view.state).toBe('installed');
    expect(view.error).toEqual({
      code: 'model-changed',
      message: { text: 'The model on this Mac changed since it was installed. Remove it and install it again.' },
      next: 'remove',
    });
    expect(view.actions).toEqual(['stop', 'install', 'remove']);
    expect(h.store.get().state).toBe('installed');
    expect(h.store.get()).not.toHaveProperty('error');
  });

  it('another program on the port: port-in-use on the view, "Use another port" as the next step', async () => {
    const h = setup({ state: INSTALLED });
    h.world.startResult = { ok: false, code: 'port-in-use' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await h.service.boot();
    const view = await h.service.view();
    expect(view.error).toEqual({
      code: 'port-in-use',
      message: { text: 'Port {port} is in use by another program.', vars: { port: '11435' } },
      next: 'other-port',
    });
    expect(view.actions).toEqual(['start', 'install', 'remove']);
  });

  it('never throws, whatever the runtime does', async () => {
    const h = setup({ state: INSTALLED });
    h.supervisor.start.mockRejectedValue(new Error('spawn EACCES'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(h.service.boot()).resolves.toBeUndefined();
    expect((await h.service.view()).running).toBe(false);
  });

  it('a new pid the supervisor reports after a crash and restart is stored', async () => {
    const h = setup({ state: INSTALLED });
    h.service.onRuntimeChange({ running: true, pid: 6001, restarts: 1, gaveUp: false });
    await vi.waitFor(() => expect(h.store.get().runtime?.pid).toBe(6001));
    // A report without a pid, or with what is already stored, writes nothing.
    const writes = h.store.history.length;
    h.service.onRuntimeChange({ running: false, restarts: 3, gaveUp: true });
    h.service.onRuntimeChange({ running: true, pid: 6001, restarts: 1, gaveUp: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.store.history.length).toBe(writes);
  });
});

// ---------- Failures ----------

describe('every failure is a state with a code and a next step', () => {
  async function failed(h: ReturnType<typeof setup>) {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await installAndWait(h.service);
    const view = await h.service.view();
    expect(view.state).toBe('failed');
    expect(view.actions).toEqual(['resume', 'install', 'remove']);
    return view;
  }

  it('a damaged runtime download: runtime-damaged, try again', async () => {
    const h = setup();
    h.deps.ensureRuntimeInstalled.mockResolvedValue({
      ok: false,
      code: 'runtime-damaged',
      detail: 'sha256 mismatch',
    } as never);
    const view = await failed(h);
    expect(view.step).toBe('runtime');
    expect(view.error).toEqual({
      code: 'runtime-damaged',
      message: { text: 'The runtime download was damaged and has been deleted. Try again.' },
      next: 'retry',
      detail: 'sha256 mismatch',
    });
    expect(h.supervisor.start).not.toHaveBeenCalled();
  });

  it('no free port in the span: port-in-use with the first port, before a runtime is started', async () => {
    const h = setup();
    h.deps.chooseRuntimePort.mockResolvedValue(undefined);
    const view = await failed(h);
    expect(view.error).toMatchObject({ code: 'port-in-use', next: 'other-port', message: { vars: { port: '11435' } } });
    expect(h.supervisor.start).not.toHaveBeenCalled();
    expect(view).not.toHaveProperty('port');
  });

  it('another program on the chosen port: port-in-use with that port', async () => {
    const h = setup();
    h.world.startResult = { ok: false, code: 'port-in-use', detail: 'answers but is not ours' };
    const view = await failed(h);
    expect(view.step).toBe('runtime');
    expect(view.port).toBe(11435);
    expect(view.error).toMatchObject({ code: 'port-in-use', next: 'other-port', message: { vars: { port: '11435' } } });
  });

  it('a runtime that does not start: runtime-start-failed', async () => {
    const h = setup();
    h.world.startResult = { ok: false, code: 'runtime-start-failed', detail: 'exited with code 1' };
    const view = await failed(h);
    expect(view.error).toMatchObject({ code: 'runtime-start-failed', next: 'retry', detail: 'exited with code 1' });
    expect(h.deps.pullModel).not.toHaveBeenCalled();
  });

  it('the measured budget rules the model out: does-not-fit BEFORE the model is downloaded, with the next model', async () => {
    const h = setup();
    h.deps.modelFitsBudget.mockReturnValue(false);
    const view = await failed(h);
    expect(view.step).toBe('runtime');
    expect(view.error).toEqual({
      code: 'does-not-fit',
      message: {
        text: '{model} does not fit in the memory of this Mac after all.',
        vars: { model: 'Qwen3.6 35B-A3B' },
      },
      next: 'next-model',
      nextModel: { modelId: 'gpt-oss:20b', modelLabel: 'GPT-OSS 20B' },
    });
    expect(h.deps.pullModel).not.toHaveBeenCalled();
    // The next model was asked for with the measured budget, not the estimate.
    expect(h.deps.recommend.mock.calls.at(-1)?.[3]).toEqual({ measuredTotalBytes: MEASURED, runtimeDownloadBytes: 0 });
  });

  it('without a measured total (an adopted runtime printed nothing) the estimate stands and the job goes on', async () => {
    const h = setup();
    h.world.measured = undefined;
    h.deps.modelFitsBudget.mockReturnValue(false);
    await installAndWait(h.service);
    expect(h.deps.modelFitsBudget).not.toHaveBeenCalled();
    expect(h.store.get().state).toBe('installed');
  });

  it('a pull that keeps failing: pull-failed with the runtime own last error', async () => {
    const h = setup();
    h.deps.pullModel.mockResolvedValue({ ok: false, code: 'pull-failed', detail: 'tls: bad record MAC' } as never);
    const view = await failed(h);
    expect(view.step).toBe('model');
    expect(view.error).toEqual({
      code: 'pull-failed',
      message: { text: LOCAL_MODEL_INSTALL_LABELS.errPullFailed },
      next: 'retry',
      detail: 'tls: bad record MAC',
    });
  });

  it('a model the registry no longer has: model-not-found, and the next model to try', async () => {
    const h = setup();
    h.deps.pullModel.mockResolvedValue({ ok: false, code: 'model-not-found' } as never);
    const view = await failed(h);
    expect(view.error).toMatchObject({
      code: 'model-not-found',
      next: 'next-model',
      message: { vars: { model: 'Qwen3.6 35B-A3B' } },
      nextModel: { modelId: 'gpt-oss:20b', modelLabel: 'GPT-OSS 20B' },
    });
  });

  it('a full disk: disk-full', async () => {
    const h = setup();
    h.deps.pullModel.mockResolvedValue({ ok: false, code: 'disk-full' } as never);
    expect((await failed(h)).error).toMatchObject({ code: 'disk-full', next: 'retry' });
  });

  it.each([
    ['load-failed', 'retry', false],
    ['does-not-fit', 'next-model', true],
    ['no-tool-call', 'next-model', true],
    ['probe-unfinished', 'retry', false],
  ] as const)('the check answers %s: next step %s', async (code, next, offersModel) => {
    const h = setup();
    h.deps.verifyModel.mockResolvedValue({ ok: false, code, detail: 'detail' } as never);
    const view = await failed(h);
    expect(view.step).toBe('verify');
    expect(view.error).toMatchObject({ code, next, message: { vars: { model: 'Qwen3.6 35B-A3B' } }, detail: 'detail' });
    expect(view.error?.nextModel).toEqual(
      offersModel ? { modelId: 'gpt-oss:20b', modelLabel: 'GPT-OSS 20B' } : undefined
    );
    // Nothing after the check ran: no coding agent, no connection.
    expect(h.deps.runInstallCommand).not.toHaveBeenCalled();
    expect(h.deps.connectLocalModel).not.toHaveBeenCalled();
  });

  it('a model loaded at another context: the sentence carries what the runtime reports and what was chosen', async () => {
    const h = setup();
    h.deps.verifyModel.mockResolvedValue({ ok: false, code: 'context-not-applied' } as never);
    const view = await failed(h);
    expect(view.error?.message).toEqual({
      text: '{model} loaded with a context of {actual} tokens instead of {wanted}.',
      vars: { model: 'Qwen3.6 35B-A3B', actual: '32768', wanted: '131072' },
    });
  });

  it('a model the runtime reports no digest for cannot be installed: there would be nothing to compare later', async () => {
    const h = setup();
    h.deps.readModelDigest.mockResolvedValue(undefined);
    const view = await failed(h);
    expect(view.step).toBe('verify');
    expect(view.error).toMatchObject({ code: 'load-failed', detail: 'The runtime reports no digest for the model.' });
  });

  it('a runtime that does not list the model for a coding agent: connect-failed, nothing written', async () => {
    const h = setup();
    h.deps.listOpenAiModels.mockResolvedValue(['some-other:1b']);
    const view = await failed(h);
    expect(view.step).toBe('connect');
    expect(view.error).toMatchObject({ code: 'connect-failed', detail: 'The runtime does not list qwen3.6:35b-a3b.' });
    expect(h.deps.connectLocalModel).not.toHaveBeenCalled();
  });

  it('a saved endpoint with our id that is not ours: endpoint-id-taken with the id, and nothing is claimed or written', async () => {
    const h = setup();
    h.deps.inspectLocalEndpoint.mockResolvedValue({ record: 'other', flagEnabled: true });
    const view = await failed(h);
    expect(view.error).toMatchObject({
      code: 'endpoint-id-taken',
      next: 'retry',
      message: { vars: { id: 'local-ollama' } },
    });
    expect(h.store.get()).not.toHaveProperty('connection');
    expect(h.deps.connectLocalModel).not.toHaveBeenCalled();
  });

  it('a refused write of the connection: connect-failed with the reason', async () => {
    const h = setup();
    h.deps.connectLocalModel.mockResolvedValue({
      ok: false,
      code: 'connect-failed',
      detail: 'settings.json is not valid',
    } as never);
    expect((await failed(h)).error).toMatchObject({ code: 'connect-failed', detail: 'settings.json is not valid' });
  });

  it('an exception in a step is the code internal with its text, never an unhandled rejection', async () => {
    const h = setup();
    h.deps.pullModel.mockRejectedValue(new Error('socket exploded'));
    const view = await failed(h);
    expect(view.error).toEqual({
      code: 'internal',
      message: { text: 'The install stopped on an unexpected error.' },
      next: 'retry',
      detail: 'socket exploded',
    });
  });

  it('a failed job can be replaced by another choice, and the model it left is deleted before the new pull', async () => {
    const h = setup();
    h.deps.verifyModel.mockResolvedValueOnce({ ok: false, code: 'no-tool-call' } as never);
    await installAndWait(h.service);
    expect(h.store.get().state).toBe('failed');
    h.calls.length = 0;

    // The runtime is on disk now, so the total is the model alone.
    h.deps.recommend.mockImplementation(() => {
      const rec = recommendation();
      for (const row of [rec.pick!, ...rec.alternatives]) row.installBytes = row.downloadBytes;
      return rec;
    });
    const result = await installAndWait(h.service, {
      modelId: 'gpt-oss:20b',
      cli: 'opencode',
      context: 131072,
      acknowledgedBytes: 13_793_441_427,
    });
    expect(result.ok).toBe(true);
    expect(h.store.get()).toMatchObject({ state: 'installed', model: { id: 'gpt-oss:20b' } });
    expect(h.deps.deleteModel).toHaveBeenCalledWith(
      { baseUrl: 'http://127.0.0.1:11435' },
      'qwen3.6:35b-a3b',
      expect.anything()
    );
    expect(h.calls.indexOf('deleteModel')).toBeLessThan(h.calls.indexOf('pullModel'));
    expect(h.store.get()).not.toHaveProperty('replacedModelId');
    // The port was chosen once, by the first job.
    expect(h.deps.chooseRuntimePort).toHaveBeenCalledTimes(1);
  });
});

// ---------- The coding agent ----------

describe('the coding agent step', () => {
  it('forgets the cached lookups and looks for the binary again after the installer ran', async () => {
    const h = setup();
    await installAndWait(h.service);
    // Once before (a resumed job may find it), once after: the second is what a session start relies on.
    expect(h.deps.recheckCliInstalled).toHaveBeenCalledTimes(2);
    expect(h.deps.recheckCliInstalled).toHaveBeenCalledWith('opencode');
    const order = h.calls.filter((call) => call === 'recheckCliInstalled' || call === 'runInstallCommand');
    expect(order).toEqual(['recheckCliInstalled', 'runInstallCommand', 'recheckCliInstalled']);
  });

  it('runs exactly the stock command, with the job signal, inside the shared install slot', async () => {
    const h = setup();
    await installAndWait(h.service);
    expect(h.deps.stockInstallCommand).toHaveBeenCalledWith('opencode');
    expect(h.deps.tryBeginCliInstall).toHaveBeenCalledWith('opencode');
    expect(h.deps.runInstallCommand).toHaveBeenCalledTimes(1);
    const [command, options] = h.deps.runInstallCommand.mock.calls[0] as unknown as [string, { signal: AbortSignal }];
    expect(command).toBe(INSTALL_COMMAND);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    // The slot is given back.
    expect(h.calls).toContain('release');
  });

  it('an installer that ends well but leaves no binary is harness-failed: still missing is a failure', async () => {
    const h = setup();
    h.deps.runInstallCommand.mockResolvedValue({ code: 0, output: '', timedOut: false, aborted: false });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await installAndWait(h.service);
    const view = await h.service.view();
    expect(view).toMatchObject({ state: 'failed', step: 'agent' });
    expect(view.error).toEqual({
      code: 'harness-failed',
      message: { text: '{cli} could not be installed.', vars: { cli: 'OpenCode' } },
      next: 'retry',
      detail: 'The installer finished, but the program was not found afterwards.',
    });
    expect(h.deps.connectLocalModel).not.toHaveBeenCalled();
  });

  it('an installer that fails is harness-failed with its last lines, and the caches are forgotten all the same', async () => {
    const h = setup();
    h.deps.runInstallCommand.mockResolvedValue({
      code: 1,
      output: `${'x'.repeat(2000)}\ncurl: (6) Could not resolve host`,
      timedOut: false,
      aborted: false,
    });
    await installAndWait(h.service);
    const view = await h.service.view();
    expect(view.error?.code).toBe('harness-failed');
    expect(view.error?.detail?.endsWith('curl: (6) Could not resolve host')).toBe(true);
    expect(view.error?.detail?.length).toBeLessThanOrEqual(1000);
    expect(h.deps.recheckCliInstalled).toHaveBeenCalledTimes(2);
    expect(h.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cli_install', detail: expect.objectContaining({ exitCode: 1 }) })
    );
  });

  it('an installer that timed out says so', async () => {
    const h = setup();
    h.deps.runInstallCommand.mockResolvedValue({ code: null, output: 'partial', timedOut: true, aborted: false });
    await installAndWait(h.service);
    expect((await h.service.view()).error).toMatchObject({
      code: 'harness-failed',
      detail: 'The installer was stopped after 300 seconds.',
    });
  });

  it('an installer that left the binary although it ended badly counts as installed', async () => {
    const h = setup();
    h.deps.runInstallCommand.mockImplementation(async () => {
      h.world.agentInstalled = true;
      return { code: 1, output: 'could not edit .zshrc', timedOut: false, aborted: false };
    });
    await installAndWait(h.service);
    expect(h.store.get().state).toBe('installed');
  });

  it('while the registry route installs the same CLI the step fails instead of running a second installer', async () => {
    const h = setup();
    h.deps.tryBeginCliInstall.mockReturnValue(null);
    await installAndWait(h.service);
    expect((await h.service.view()).error).toMatchObject({
      code: 'harness-failed',
      detail: 'Another install of this coding agent is running.',
    });
    expect(h.deps.runInstallCommand).not.toHaveBeenCalled();
  });

  it('never runs a command for a CLI that is not a coding agent of the catalogue', async () => {
    const state: LocalModelStateFile = { ...jobAt('agent', 'paused'), cli: { id: 'grok', label: 'Grok Build' } };
    const h = setup({ state });
    h.deps.stockInstallCommand.mockReturnValue('curl https://example.invalid | bash');
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.store.get()).toMatchObject({ state: 'failed', error: { code: 'harness-failed' } });
    expect(h.deps.runInstallCommand).not.toHaveBeenCalled();
    expect(h.deps.tryBeginCliInstall).not.toHaveBeenCalled();
  });

  it('the audit line names who resumed the job, not who started it', async () => {
    const h = setup({ state: jobAt('agent', 'paused') });
    await h.service.resume({}, { username: 'second-admin', ip: '10.0.0.2' });
    await h.service.idle();
    expect(h.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ admin: 'second-admin', ip: '10.0.0.2', action: 'cli_install' })
    );
  });
});

// ---------- The launch check ----------

describe('launchRefusal: the digest and the runtime decide whether a session starts', () => {
  async function installed(overrides: Partial<LocalModelStateFile> = {}) {
    const h = setup({ state: { ...INSTALLED, ...overrides } });
    await h.service.boot();
    return h;
  }

  it('allows the launch while our runtime runs and the digest is the stored one', async () => {
    const h = await installed();
    h.deps.readModelDigest.mockClear();
    expect(await h.service.launchRefusal('local-ollama')).toBeUndefined();
    // Read again for this launch, not taken from the last look.
    expect(h.deps.readModelDigest).toHaveBeenCalledTimes(1);
    expect(await h.service.launchRefusalMessage('local-ollama', 'qwen3.6:35b-a3b')).toBeUndefined();
  });

  it('refuses a model whose digest is no longer the stored one, in one plain sentence', async () => {
    const h = await installed();
    h.deps.readModelDigest.mockResolvedValue('1111222233334444');
    expect(await h.service.launchRefusal('local-ollama')).toEqual({
      code: 'model-changed',
      message: { text: 'The model on this Mac changed since it was installed. Remove it and install it again.' },
      next: 'remove',
    });
    expect(await h.service.launchRefusalMessage('local-ollama', 'qwen3.6:35b-a3b')).toBe(
      'The model on this Mac changed since it was installed. Remove it and install it again.'
    );
    // And the window stops offering a session.
    expect((await h.service.view()).actions).toEqual(['stop', 'install', 'remove']);
  });

  it('a digest with the sha256 prefix some listings add is the same digest', async () => {
    const h = await installed();
    h.deps.readModelDigest.mockResolvedValue(`sha256:${DIGEST.toUpperCase()}`);
    expect(await h.service.launchRefusal('local-ollama')).toBeUndefined();
  });

  it('refuses while the runtime is stopped: whatever answers on the port then is not ours', async () => {
    const h = setup({ state: { ...INSTALLED, runtime: { ...INSTALLED.runtime!, enabled: false } } });
    await h.service.boot();
    expect(await h.service.launchRefusal('local-ollama')).toEqual({
      code: 'runtime-not-running',
      message: { text: 'The model on this Mac is not running. Start it first.' },
      next: 'start',
    });
    expect(h.deps.readModelDigest).not.toHaveBeenCalled();
  });

  it('names another program on the port, and a runtime that keeps stopping', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const taken = setup({ state: INSTALLED });
    taken.world.startResult = { ok: false, code: 'port-in-use' };
    await taken.service.boot();
    expect(await taken.service.launchRefusal('local-ollama')).toMatchObject({
      code: 'port-in-use',
      message: { vars: { port: '11435' } },
    });

    const crashing = setup({ state: INSTALLED });
    crashing.world.gaveUp = true;
    expect(await crashing.service.launchRefusal('local-ollama')).toMatchObject({
      code: 'runtime-stopped',
      next: 'start',
    });
  });

  it('a model that is gone from the runtime is a changed model; a runtime that stopped answering is not running', async () => {
    const gone = await installed();
    gone.deps.readModelDigest.mockResolvedValue(undefined);
    expect(await gone.service.launchRefusal('local-ollama')).toMatchObject({ code: 'model-changed' });

    const silent = await installed();
    silent.deps.readModelDigest.mockResolvedValue(undefined);
    silent.deps.getRuntimeVersion.mockResolvedValue(undefined);
    expect(await silent.service.launchRefusal('local-ollama')).toMatchObject({ code: 'runtime-not-running' });
  });

  it('is not asked about any other endpoint, nor about a record with our id that is not ours', async () => {
    const h = await installed();
    h.deps.readModelDigest.mockResolvedValue('changed');
    expect(await h.service.launchRefusal('office-gpu')).toBeUndefined();
    expect(await h.service.launchRefusalMessage('office-gpu', 'anything')).toBeUndefined();

    // Nothing installed: a hand-made endpoint with the reserved id is the person's own.
    const none = setup();
    expect(await none.service.launchRefusal('local-ollama')).toBeUndefined();
    const { connection: _connection, ...unconnected } = INSTALLED;
    const notOurs = setup({ state: unconnected });
    expect(await notOurs.service.launchRefusal('local-ollama')).toBeUndefined();
  });

  it('only the model that was installed and checked may be started on the managed endpoint', async () => {
    const h = await installed();
    expect(await h.service.launchRefusalMessage('local-ollama', 'someone-else:7b')).toBe(
      'Only Qwen3.6 35B-A3B is in use on this Mac. Switch models in the local model window first.'
    );
  });

  it('never throws: a state that cannot be read refuses the launch', async () => {
    const h = setup({ state: INSTALLED });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await h.service.view();
    h.deps.readState = vi.fn(async () => {
      throw new Error('EIO');
    });
    const broken = createLocalModelService({ ...(h.deps as unknown as Partial<LocalModelServiceDeps>) });
    expect(await broken.launchRefusal('local-ollama')).toMatchObject({ code: 'runtime-not-running' });
  });

  it('the view re-reads the digest in the background at most every 30 seconds', async () => {
    const h = await installed();
    h.deps.readModelDigest.mockClear();
    await h.service.view();
    await h.service.view();
    expect(h.deps.readModelDigest).not.toHaveBeenCalled();
    h.world.clock += 30_000;
    h.deps.readModelDigest.mockResolvedValue('changed-under-us');
    await h.service.view();
    await vi.waitFor(async () => expect((await h.service.view()).error?.code).toBe('model-changed'));
    expect(h.deps.readModelDigest).toHaveBeenCalledTimes(1);
  });
});

// ---------- The runtime verbs ----------

describe('the runtime verbs', () => {
  it('Stop stops the child and keeps it from starting at the next boot; Start undoes that', async () => {
    const h = setup({ state: INSTALLED });
    await h.service.boot();
    const stopped = await h.service.runtime({ action: 'stop' });
    expect(stopped.ok && stopped.view).toMatchObject({
      state: 'installed',
      running: false,
      actions: ['start', 'install', 'remove'],
    });
    expect(h.supervisor.stop).toHaveBeenCalledTimes(1);
    expect(h.store.get().runtime?.enabled).toBe(false);

    // The next server process does not start it.
    const next = setup({ state: h.store.get() });
    await next.service.boot();
    expect(next.supervisor.start).not.toHaveBeenCalled();

    const started = await h.service.runtime({ action: 'start' });
    expect(started.ok && started.view).toMatchObject({
      running: true,
      actions: ['start-session', 'stop', 'install', 'remove'],
    });
    expect(h.store.get().runtime?.enabled).toBe(true);
  });

  it('Start reads the digest again', async () => {
    const h = setup({ state: { ...INSTALLED, runtime: { ...INSTALLED.runtime!, enabled: false } } });
    h.deps.readModelDigest.mockResolvedValue('not-the-stored-one');
    const started = await h.service.runtime({ action: 'start' });
    expect(started.ok && started.view.error?.code).toBe('model-changed');
  });

  it('"Use another port": a port that is not the old one, and the saved endpoint moves with it', async () => {
    const h = setup({ state: INSTALLED });
    h.world.startResult = { ok: false, code: 'port-in-use' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await h.service.boot();
    expect((await h.service.view()).error?.code).toBe('port-in-use');

    h.world.startResult = undefined;
    h.deps.chooseRuntimePort.mockResolvedValue(11437);
    const result = await h.service.runtime({ action: 'start', newPort: true });
    expect(h.deps.chooseRuntimePort).toHaveBeenCalledWith({ avoid: [11435] });
    expect(h.deps.moveLocalEndpoint).toHaveBeenCalledWith(11437);
    // The stored pid goes along, so our own runtime on the old port could not be left behind.
    expect(h.supervisor.start).toHaveBeenLastCalledWith({ port: 11437, contextLength: 131072, previousPid: 4711 });
    expect(result.ok && result.view).toMatchObject({ port: 11437, running: true });
    expect(result.ok && result.view.error).toBeUndefined();
    expect(h.store.get().runtime).toMatchObject({ port: 11437, enabled: true });
  });

  it('a refused write of the saved endpoint leaves the old port in the state: the two never disagree', async () => {
    const h = setup({ state: INSTALLED });
    h.deps.chooseRuntimePort.mockResolvedValue(11437);
    h.deps.moveLocalEndpoint.mockRejectedValue(new Error('custom-model-hosts.json is not a valid JSON list'));
    await expect(h.service.runtime({ action: 'start', newPort: true })).rejects.toThrow('custom-model-hosts.json');
    expect(h.store.get().runtime?.port).toBe(11435);
    expect(h.supervisor.start).not.toHaveBeenCalled();
  });

  it('when no other port is free the old one is kept and the error stays', async () => {
    const h = setup({ state: INSTALLED });
    h.world.startResult = { ok: false, code: 'port-in-use' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await h.service.boot();
    h.deps.chooseRuntimePort.mockResolvedValue(undefined);
    const result = await h.service.runtime({ action: 'start', newPort: true });
    expect(h.deps.moveLocalEndpoint).not.toHaveBeenCalled();
    expect(result.ok && result.view).toMatchObject({ port: 11435, running: false, error: { code: 'port-in-use' } });
  });
});

// ---------- Remove ----------

describe('Remove', () => {
  it('while a live session uses the model: 409 with the session names, and nothing is touched', async () => {
    const h = setup({ state: INSTALLED });
    await h.service.boot();
    const result = await h.service.remove({ removeModel: true }, ['w1-app', 'w4-lib']);
    expect(result).toEqual({
      ok: false,
      status: 409,
      conflict: {
        reason: 'sessions-open',
        message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSessionsOpen, vars: { sessions: 'w1-app, w4-lib' } },
        sessions: ['w1-app', 'w4-lib'],
      },
    });
    expect(h.supervisor.stop).not.toHaveBeenCalled();
    expect(h.deps.disconnectLocalModel).not.toHaveBeenCalled();
    expect(h.deps.removeLocalModelFiles).not.toHaveBeenCalled();
    expect(h.store.get().state).toBe('installed');
    expect((await h.service.view()).running).toBe(true);
  });

  it('without one: stops the child, undoes the connection, deletes the files, and is idle again', async () => {
    const h = setup({ state: INSTALLED, runtimeOnDisk: true });
    await h.service.boot();
    h.calls.length = 0;
    const result = await h.service.remove({}, [], ADMIN);
    expect(h.calls).toEqual(['supervisor.stop', 'disconnectLocalModel', 'removeLocalModelFiles']);
    expect(h.deps.disconnectLocalModel).toHaveBeenCalledWith({ flagWasEnabled: false });
    // The model stays unless it was asked to go.
    expect(h.deps.removeLocalModelFiles).toHaveBeenCalledWith({ models: false, paths: PATHS });
    expect(result.ok && result.view).toEqual({
      state: 'idle',
      running: false,
      developerTools: 'missing',
      runtime: {
        version: '0.40.15',
        installed: false,
        downloadBytes: RUNTIME_BYTES,
        downloadGb: '0.2',
        unpackedGb: '0.6',
      },
      folder: '/data/local-model',
      library: [],
      // Measured again after the Remove: the store is empty here.
      store: { bytes: 0, gb: '0.0' },
      harnesses: [],
      actions: ['install'],
    });
    expect(h.store.get()).toMatchObject({ schema: 1, state: 'idle' });
    for (const key of ['model', 'cli', 'runtime', 'connection', 'loaded', 'library'])
      expect(h.store.get()).not.toHaveProperty(key);
    expect(h.deps.audit).toHaveBeenCalledWith({
      admin: 'root',
      action: 'local_model_remove',
      target: 'qwen3.6:35b-a3b',
      ip: '127.0.0.1',
      detail: { removeModel: false },
    });
  });

  it('removeModel deletes the downloaded model too', async () => {
    const h = setup({ state: INSTALLED });
    await h.service.remove({ removeModel: true }, []);
    expect(h.deps.removeLocalModelFiles).toHaveBeenCalledWith({ models: true, paths: PATHS });
  });

  it('hands the flag value from before this feature to the disconnect', async () => {
    const h = setup({ state: { ...INSTALLED, connection: { endpointId: 'local-ollama', flagWasEnabled: true } } });
    await h.service.remove({}, []);
    expect(h.deps.disconnectLocalModel).toHaveBeenCalledWith({ flagWasEnabled: true });
  });

  it('a paused or failed job has no connection to undo: the files go, sessions on some other endpoint do not matter', async () => {
    const h = setup({ state: jobAt('model', 'paused') });
    // The names belong to sessions on an endpoint a person made with our id; it is not ours.
    const result = await h.service.remove({ removeModel: true }, ['w1-app']);
    expect(result.ok).toBe(true);
    expect(h.deps.disconnectLocalModel).not.toHaveBeenCalled();
    expect(h.deps.removeLocalModelFiles).toHaveBeenCalledWith({ models: true, paths: PATHS });
    expect(h.store.get().state).toBe('idle');
  });

  it('a connection that cannot be undone stops the removal before any file is deleted', async () => {
    const h = setup({ state: INSTALLED });
    h.deps.disconnectLocalModel.mockRejectedValue(new Error('custom-model-hosts.json is not a valid JSON list'));
    await expect(h.service.remove({ removeModel: true }, [])).rejects.toThrow('custom-model-hosts.json');
    expect(h.deps.removeLocalModelFiles).not.toHaveBeenCalled();
    expect(h.store.get().state).toBe('installed');
    // The service still answers afterwards.
    expect((await h.service.view()).state).toBe('installed');
  });

  it('the coding agent stays: nothing of it is asked for, run or removed', async () => {
    const h = setup({ state: INSTALLED });
    await h.service.remove({ removeModel: true }, []);
    expect(h.deps.runInstallCommand).not.toHaveBeenCalled();
    expect(h.deps.stockInstallCommand).not.toHaveBeenCalled();
    expect(h.deps.recheckCliInstalled).not.toHaveBeenCalled();
  });

  it('after a remove the model can be installed again', async () => {
    const h = setup({ state: INSTALLED, agentInstalled: true });
    await h.service.remove({}, []);
    await installAndWait(h.service);
    expect(h.store.get().state).toBe('installed');
  });
});

// ---------- Remove and the real connection files ----------

describe('Remove with the real connection: the settings flag', () => {
  const HOSTS = () => customModelHostsPath(getDataDir());
  const OTHER: CustomModelHost = { id: 'office-gpu', label: 'Office GPU', baseUrl: 'http://192.168.1.50:8080' };

  function writeSettings(settings: Record<string, unknown>): void {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
  }
  const flag = (): unknown => JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).customModelEndpointsEnabled;

  afterEach(() => {
    rmSync(HOSTS(), { force: true });
    rmSync(SETTINGS_PATH, { force: true });
  });

  /** Installs with the real connect step, then removes with the real disconnect. */
  async function installThenRemove() {
    const h = setup({
      agentInstalled: true,
      overrides: { inspectLocalEndpoint, connectLocalModel, disconnectLocalModel },
    });
    await installAndWait(h.service);
    expect(h.store.get().state).toBe('installed');
    expect(flag()).toBe(true);
    expect((await readCustomModelHosts(getDataDir())).map((host) => host.id)).toContain('local-ollama');
    const removed = await h.service.remove({}, []);
    expect(removed.ok).toBe(true);
    expect((await readCustomModelHosts(getDataDir())).map((host) => host.id)).not.toContain('local-ollama');
    return h;
  }

  it('this feature switched it on and no other endpoint is saved: it is switched off again', async () => {
    writeSettings({ customModelEndpointsEnabled: false, tmuxHistoryLimit: 5000 });
    await installThenRemove();
    expect(flag()).toBe(false);
    expect(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).tmuxHistoryLimit).toBe(5000);
  });

  it('it was on before this feature: it stays on', async () => {
    writeSettings({ customModelEndpointsEnabled: true });
    await installThenRemove();
    expect(flag()).toBe(true);
  });

  it('this feature switched it on but another endpoint is saved: it stays on, and that endpoint is untouched', async () => {
    writeSettings({});
    writeFileSync(HOSTS(), JSON.stringify([OTHER]));
    await installThenRemove();
    expect(flag()).toBe(true);
    expect(await readCustomModelHosts(getDataDir())).toEqual([OTHER]);
  });

  it('a resumed connect step does not forget that the flag was off before', async () => {
    writeSettings({ customModelEndpointsEnabled: false });
    const h = setup({
      agentInstalled: true,
      overrides: { inspectLocalEndpoint, connectLocalModel, disconnectLocalModel },
    });
    await installAndWait(h.service);
    // The connection is written a second time, as a resumed job would: the flag is on by now.
    const again = await connectLocalModel({
      port: 11435,
      modelId: 'qwen3.6:35b-a3b',
      context: 131072,
      ours: true,
      flagWasEnabled: h.store.get().connection!.flagWasEnabled,
    });
    expect(again).toEqual({ ok: true, flagWasEnabled: false });
    await h.service.remove({}, []);
    expect(flag()).toBe(false);
  });
});

// ---------- The view never throws ----------

describe('view()', () => {
  it('answers an idle view when a dependency throws', async () => {
    const h = setup();
    h.deps.checkDeveloperTools.mockRejectedValue(new Error('spawn failed'));
    h.deps.isRuntimeInstalled.mockRejectedValue(new Error('EACCES'));
    expect(await h.service.view()).toMatchObject({
      state: 'idle',
      developerTools: 'unknown',
      runtime: { installed: false, downloadBytes: RUNTIME_BYTES },
      actions: ['install'],
    });
  });

  it('answers the bare idle view when the state itself cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = createLocalModelService({
      ...(setup().deps as unknown as Partial<LocalModelServiceDeps>),
      readState: async () => {
        throw new Error('EIO');
      },
    });
    expect(await service.view()).toMatchObject({ state: 'idle', running: false, actions: ['install'] });
  });

  it('computes a download speed for the runtime archive, which reports bytes only', async () => {
    let report: (p: { completedBytes: number; totalBytes: number }) => void = () => {};
    const h = setup({
      overrides: {
        ensureRuntimeInstalled: vi.fn(async (install?: { signal?: AbortSignal; onProgress?: typeof report }) => {
          report = install?.onProgress ?? report;
          await untilAborted(install?.signal);
          return { ok: false as const, code: 'cancelled' as const };
        }),
      },
    });
    await h.service.install(REQUEST, ADMIN);
    await vi.waitFor(() => expect(h.deps.ensureRuntimeInstalled).toHaveBeenCalled());
    report({ completedBytes: 0, totalBytes: RUNTIME_BYTES });
    expect((await h.service.view()).progress).not.toHaveProperty('bytesPerSecond');
    h.world.clock += 2_000;
    report({ completedBytes: 20_000_000, totalBytes: RUNTIME_BYTES });
    expect((await h.service.view()).progress).toMatchObject({
      completedBytes: 20_000_000,
      totalBytes: RUNTIME_BYTES,
      bytesPerSecond: 10_000_000,
      mbPerSecond: '10',
      // (185,971,671 - 20,000,000) / 10,000,000 = 16.6, rounded up.
      secondsLeft: 17,
    });
    await h.service.cancel();
  });

  it('a view whose read began while the job ran shows how the job ended, never paused', async () => {
    // The window polls every second, so a read of the state file can be under way while the
    // job writes its last state and lets go. That read returns the old `installing`, and
    // settling it with no job in this process read it as an interrupted job: the window (and
    // the e2e test, under CI load) saw `paused` with Resume for one tick instead of `failed`.
    const slow = {
      read: undefined as undefined | (() => Promise<LocalModelStateFile>),
      hold: undefined as undefined | Promise<void>,
      entered: undefined as undefined | (() => void),
    };
    const h = setup({
      overrides: {
        readState: async () => {
          const snapshot = await slow.read!();
          const hold = slow.hold;
          slow.hold = undefined;
          if (hold) {
            slow.entered?.();
            await hold;
          }
          return snapshot;
        },
      },
    });
    slow.read = h.store.readState;
    let failVerify!: () => void;
    const verifying = new Promise<void>((resolve) => (failVerify = resolve));
    h.deps.verifyModel.mockImplementationOnce(async () => {
      await verifying;
      return { ok: false, code: 'no-tool-call' } as never;
    });

    await h.service.install(REQUEST, ADMIN);
    await vi.waitFor(() => expect(h.deps.verifyModel).toHaveBeenCalled());

    // A view starts reading while the job is still in the verify step...
    let releaseRead!: () => void;
    slow.hold = new Promise<void>((resolve) => (releaseRead = resolve));
    const entered = new Promise<void>((resolve) => (slow.entered = resolve));
    const viewing = h.service.view();
    await entered;
    // ...the job fails, writes it and ends while that read is still out...
    failVerify();
    await h.service.idle();
    expect(h.store.get().state).toBe('failed');
    // ...and only then does the read come back, with the file as it was before.
    releaseRead();
    const view = await viewing;
    expect(view).toMatchObject({ state: 'failed', step: 'verify', error: { code: 'no-tool-call' } });
  });

  it('names the model to try next only when the catalogue still has it', async () => {
    const state: LocalModelStateFile = {
      ...jobAt('verify', 'paused'),
      state: 'failed',
      error: { code: 'no-tool-call', nextModelId: 'gone:1b' },
    };
    const h = setup({ state });
    const view = await h.service.view();
    expect(view.error?.next).toBe('next-model');
    expect(view.error).not.toHaveProperty('nextModel');
  });
});

// ---------- The connection is claimed before it is written ----------

describe('the connect step claims the connection before it writes anything outside the folder', () => {
  it('the state file knows the connection is ours before the endpoint record is written', async () => {
    let claimAtWrite: LocalModelStateFile['connection'];
    const h = setup();
    h.deps.inspectLocalEndpoint.mockResolvedValue({ record: 'absent', flagEnabled: true });
    h.deps.connectLocalModel.mockImplementation(async () => {
      claimAtWrite = h.store.get().connection;
      return { ok: true as const, flagWasEnabled: true };
    });
    await installAndWait(h.service);
    // The claim carries the value the setting had BEFORE this feature switched it on.
    expect(claimAtWrite).toEqual({ endpointId: 'local-ollama', flagWasEnabled: true });
    expect(h.deps.inspectLocalEndpoint).toHaveBeenCalledWith({
      port: 11435,
      modelId: 'qwen3.6:35b-a3b',
      context: 131072,
    });
  });

  it('a claim that cannot be written (a full disk) writes nothing outside, and "Try again" finishes the install', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: jobAt('connect', 'paused') });
    // The claim is refused once; every other write lands.
    let refused = false;
    h.store.disk.refuse = (next, before) => {
      if (refused || !next.connection || before.connection) return false;
      refused = true;
      return true;
    };
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(await h.service.view()).toMatchObject({ state: 'failed', step: 'connect', error: { code: 'disk-full' } });
    // Nothing was written outside our folder: the record and the setting are untouched.
    expect(h.deps.connectLocalModel).not.toHaveBeenCalled();
    expect(h.store.get()).not.toHaveProperty('connection');

    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.store.get()).toMatchObject({
      state: 'installed',
      connection: { endpointId: 'local-ollama', flagWasEnabled: false },
    });
    expect(h.deps.connectLocalModel).toHaveBeenCalledTimes(1);
  });

  it('a record that already says what ours would say is ours, and the setting is then never switched off', async () => {
    const h = setup({ state: jobAt('connect', 'paused') });
    h.deps.inspectLocalEndpoint.mockResolvedValue({ record: 'same', flagEnabled: true });
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.store.get()).toMatchObject({
      state: 'installed',
      connection: { endpointId: 'local-ollama', flagWasEnabled: true },
    });
  });

  it('an endpoint store that cannot be read: connect-failed, before anything is claimed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: jobAt('connect', 'paused') });
    h.deps.inspectLocalEndpoint.mockRejectedValue(new Error('custom-model-hosts.json is not a valid JSON list'));
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(await h.service.view()).toMatchObject({
      state: 'failed',
      error: { code: 'connect-failed', detail: 'custom-model-hosts.json is not a valid JSON list' },
    });
    expect(h.store.get()).not.toHaveProperty('connection');
    expect(h.deps.connectLocalModel).not.toHaveBeenCalled();
  });

  it('a resumed job does not look again: the claim it has keeps the value from before', async () => {
    const h = setup({
      state: { ...jobAt('connect', 'paused'), connection: { endpointId: 'local-ollama', flagWasEnabled: false } },
    });
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.deps.inspectLocalEndpoint).not.toHaveBeenCalled();
    expect(h.deps.connectLocalModel).toHaveBeenCalledWith(
      expect.objectContaining({ ours: true, flagWasEnabled: false })
    );
    expect(h.store.get().state).toBe('installed');
  });
});

describe('the connect step with the real endpoint store and settings: a write that does not land', () => {
  const HOSTS = () => customModelHostsPath(getDataDir());
  const real = { inspectLocalEndpoint, connectLocalModel, disconnectLocalModel };
  const hostIds = async () => (await readCustomModelHosts(getDataDir())).map((host) => host.id);
  const flag = (): unknown => {
    try {
      return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).customModelEndpointsEnabled;
    } catch {
      return undefined;
    }
  };

  afterEach(() => {
    rmSync(HOSTS(), { force: true });
    rmSync(SETTINGS_PATH, { force: true });
  });

  it('the claim fails once: nothing is left behind, "Try again" installs, and Remove undoes both writes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: jobAt('connect', 'paused'), overrides: real });
    let refused = false;
    h.store.disk.refuse = (next, before) => {
      if (refused || !next.connection || before.connection) return false;
      refused = true;
      return true;
    };
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect((await h.service.view()).error?.code).toBe('disk-full');
    expect(await hostIds()).toEqual([]);
    expect(flag()).toBeUndefined();

    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.store.get().state).toBe('installed');
    expect(await hostIds()).toEqual(['local-ollama']);
    expect(flag()).toBe(true);

    const removed = await h.service.remove({ removeModel: true }, [], ADMIN);
    expect(removed.ok && removed.view.state).toBe('idle');
    expect(await hostIds()).toEqual([]);
    expect(flag()).toBe(false);
  });

  it('the server is killed after the claim and before the record: the next server finishes it on Continue', async () => {
    // What the killed server left: the claim in the state file, nothing in the endpoint store.
    const h = setup({
      state: { ...jobAt('connect'), connection: { endpointId: 'local-ollama', flagWasEnabled: false } },
      overrides: real,
    });
    await h.service.boot();
    expect(await h.service.view()).toMatchObject({ state: 'paused', step: 'connect' });
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.store.get().state).toBe('installed');
    expect(await hostIds()).toEqual(['local-ollama']);
    await h.service.remove({}, [], ADMIN);
    expect(await hostIds()).toEqual([]);
    expect(flag()).toBe(false);
  });

  it('the server is killed after both writes and before the last step was recorded: Continue ends installed', async () => {
    const h = setup({
      state: { ...jobAt('connect'), connection: { endpointId: 'local-ollama', flagWasEnabled: false } },
      overrides: real,
    });
    await connectLocalModel({ port: 11435, modelId: 'qwen3.6:35b-a3b', context: 131072, ours: true });
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(await h.service.view()).toMatchObject({ state: 'installed' });
    expect(await hostIds()).toEqual(['local-ollama']);
  });

  it('a record of ours the state file does not know (written by an earlier order of the two) is taken as ours', async () => {
    // The record and the flag exist, the state file has no claim.
    await connectLocalModel({ port: 11435, modelId: 'qwen3.6:35b-a3b', context: 131072, ours: false });
    const h = setup({ state: jobAt('connect', 'paused'), overrides: real });
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(await h.service.view()).toMatchObject({ state: 'installed' });
    // Remove takes the record out. The setting stays: what it was before is not known.
    await h.service.remove({}, [], ADMIN);
    expect(await hostIds()).toEqual([]);
    expect(flag()).toBe(true);
  });

  it('a record with our id that says something else is never overwritten', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mkdirSync(dirname(HOSTS()), { recursive: true });
    const foreign = { id: 'local-ollama', label: 'My own', baseUrl: 'http://127.0.0.1:11434' };
    writeFileSync(HOSTS(), JSON.stringify([foreign]));
    const h = setup({ state: jobAt('connect', 'paused'), overrides: real });
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect((await h.service.view()).error?.code).toBe('endpoint-id-taken');
    expect(await readCustomModelHosts(getDataDir())).toEqual([foreign]);
    expect(h.store.get()).not.toHaveProperty('connection');
  });
});

// ---------- A job whose end could not be written ----------

describe('a state file that cannot be written when a step fails (a full disk)', () => {
  /** A pull that fills the disk: from its failure on, every write of the state file is refused. */
  function diskFillsDuringPull(h: ReturnType<typeof setup>) {
    h.deps.pullModel.mockImplementation(
      async (_target: unknown, _id: string, pull?: { onProgress?: (p: unknown) => void }) => {
        pull?.onProgress?.({ completedBytes: 14_200_000_000, totalBytes: PULL_BYTES, bytesPerSecond: 58_000_000 });
        h.store.disk.refuse = () => true;
        return { ok: false as const, code: 'disk-full' as const, detail: 'write blob: no space left on device' };
      }
    );
  }

  it('the job is not lost: the view says disk-full with the download as it stood, and no speed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: jobAt('model', 'paused') });
    diskFillsDuringPull(h);
    await h.service.resume({}, ADMIN);
    await h.service.idle();

    // The file could not be told and still says the job runs.
    expect(h.store.get().state).toBe('installing');
    const view = await h.service.view();
    expect(view).toMatchObject({
      state: 'failed',
      step: 'model',
      error: { code: 'disk-full', next: 'retry', detail: 'write blob: no space left on device' },
      actions: ['resume', 'install', 'remove'],
    });
    expect(view.progress).toMatchObject({ completedBytes: 14_200_000_000, totalBytes: PULL_BYTES });
    expect(view.progress).not.toHaveProperty('bytesPerSecond');
    // A GET writes nothing: the file is as it was.
    expect(h.store.get().state).toBe('installing');
  });

  it('Cancel has nothing to cancel (409, not a 500), and "Try again" on a disk that is still full says so again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: jobAt('model', 'paused') });
    diskFillsDuringPull(h);
    await h.service.resume({}, ADMIN);
    await h.service.idle();

    expect(await h.service.cancel()).toMatchObject({ ok: false, status: 409, conflict: { reason: 'wrong-state' } });
    const again = await h.service.resume({}, ADMIN);
    expect(again.ok && again.view).toMatchObject({ state: 'failed', error: { code: 'disk-full' } });
    expect(h.deps.pullModel).toHaveBeenCalledTimes(1);
  });

  it('once there is space again "Try again" writes the outcome, runs the step and installs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: jobAt('model', 'paused') });
    diskFillsDuringPull(h);
    await h.service.resume({}, ADMIN);
    await h.service.idle();

    h.store.disk.refuse = undefined;
    h.deps.pullModel.mockImplementation(async () => ({ ok: true as const, totalBytes: PULL_BYTES }));
    const resumed = await h.service.resume({}, ADMIN);
    expect(resumed.ok && resumed.view.state).toBe('installing');
    await h.service.idle();
    expect(h.store.get().state).toBe('installed');
    expect((await h.service.view()).error).toBeUndefined();
  });

  it('another verb writes what the view already showed: a new install replaces the failed job', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: jobAt('model', 'paused'), runtimeOnDisk: true });
    diskFillsDuringPull(h);
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    h.store.disk.refuse = undefined;
    h.deps.pullModel.mockImplementation(async () => ({ ok: true as const, totalBytes: 13_793_441_427 }));
    h.deps.recommend.mockImplementation(() => {
      const rec = recommendation();
      for (const row of [rec.pick!, ...rec.alternatives]) row.installBytes = row.downloadBytes;
      return rec;
    });
    const result = await installAndWait(h.service, {
      modelId: 'gpt-oss:20b',
      cli: 'opencode',
      context: 131072,
      acknowledgedBytes: 13_793_441_427,
    });
    expect(result.ok).toBe(true);
    expect(h.store.get()).toMatchObject({ state: 'installed', model: { id: 'gpt-oss:20b' } });
  });

  it('Cancel while the disk is full stops the job and shows it paused, without throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({
      overrides: {
        pullModel: vi.fn(async (_t: unknown, _id: string, pull?: PullOptions) => {
          pull?.onProgress?.({ completedBytes: 6_200_000_000, totalBytes: PULL_BYTES, bytesPerSecond: 58_000_000 });
          await untilAborted(pull?.signal);
          return { ok: false as const, code: 'cancelled' as const };
        }),
      },
    });
    await h.service.install(REQUEST, ADMIN);
    await vi.waitFor(() => expect(h.deps.pullModel).toHaveBeenCalled());
    h.store.disk.refuse = () => true;
    const result = await h.service.cancel();
    expect(result.ok && result.view).toMatchObject({
      state: 'paused',
      step: 'model',
      progress: { completedBytes: 6_200_000_000 },
      actions: ['resume', 'install', 'remove'],
    });
    // Space again: Continue writes the pause it could not write, and goes on.
    h.store.disk.refuse = undefined;
    h.deps.pullModel.mockImplementation(async () => ({ ok: true as const, totalBytes: PULL_BYTES }));
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.store.get().state).toBe('installed');
  });

  it('a first install on a full disk starts nothing and is answered with the sentence', async () => {
    const h = setup();
    h.store.disk.refuse = () => true;
    const result = await h.service.install(REQUEST, ADMIN);
    expect(result).toEqual({
      ok: false,
      status: 507,
      message: { text: 'The disk is full. Free up space, then try again.' },
    });
    expect(h.calls).toEqual([]);
    expect(h.store.get().state).toBe('idle');
  });

  it('a step that finished but could not be recorded (a full disk) is disk-full, and the step runs again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: jobAt('verify', 'paused') });
    // The write that would move the job past `verify` is refused, and every write after it.
    h.store.disk.refuse = (next, before) => before.step === 'verify' && next.step !== 'verify';
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(await h.service.view()).toMatchObject({ state: 'failed', step: 'verify', error: { code: 'disk-full' } });
    h.store.disk.refuse = undefined;
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.store.get().state).toBe('installed');
  });
});

// ---------- A runtime that does not start, and one an earlier server left behind ----------

describe('an installed model whose runtime does not start', () => {
  it('says so on the view with what the runtime said, and Start tries again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: INSTALLED, runtimeOnDisk: true });
    h.world.startResult = { ok: false, code: 'runtime-start-failed', detail: 'spawn ENOENT' };
    await h.service.boot();
    const view = await h.service.view();
    expect(view).toMatchObject({ state: 'installed', running: false, actions: ['start', 'install', 'remove'] });
    expect(view.error).toEqual({
      code: 'runtime-start-failed',
      message: { text: 'The runtime did not start on this Mac.' },
      // Start is the verb an installed model has: there is no job to resume.
      next: 'start',
      detail: 'spawn ENOENT',
    });
    // A session start is refused with the same reason, not with "start it first".
    expect(await h.service.launchRefusalMessage('local-ollama', 'qwen3.6:35b-a3b')).toBe(
      'The runtime did not start on this Mac.'
    );

    // Start again, and it fails again: the view still says why.
    const again = await h.service.runtime({ action: 'start' });
    expect(again.ok && again.view.error?.code).toBe('runtime-start-failed');

    // Start again, and it works: the error is gone.
    h.world.startResult = undefined;
    const started = await h.service.runtime({ action: 'start' });
    expect(started.ok && started.view).toMatchObject({ running: true });
    expect(started.ok && started.view.error).toBeUndefined();
  });

  it('Stop clears it: a model the person stopped shows no error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: INSTALLED, runtimeOnDisk: true });
    h.world.startResult = { ok: false, code: 'runtime-start-failed', detail: 'spawn ENOENT' };
    await h.service.boot();
    const stopped = await h.service.runtime({ action: 'stop' });
    expect(stopped.ok && stopped.view.error).toBeUndefined();
  });
});

describe('a later build with another runtime pin', () => {
  const OLD = '0.39.2';
  const OLD_STATE: LocalModelStateFile = { ...INSTALLED, runtime: { ...INSTALLED.runtime!, version: OLD } };
  /** Only the old version is unpacked: what an update of Codeman leaves on disk. */
  const onlyOldOnDisk = async (_pin?: unknown, paths?: LocalModelPaths) =>
    paths?.binary === `/data/local-model/runtime/ollama-${OLD}/ollama`;

  it('an installed model keeps running the version it was installed with', async () => {
    const h = setup({ state: OLD_STATE });
    h.deps.isRuntimeInstalled.mockImplementation(onlyOldOnDisk as never);
    await h.service.boot();
    expect(h.supervisor.start).toHaveBeenCalledWith({
      port: 11435,
      contextLength: 131072,
      previousPid: 4711,
      version: OLD,
    });
    // The stored version stays what runs, so the next start finds it again.
    expect(h.store.get().runtime?.version).toBe(OLD);
    const view = await h.service.view();
    expect(view).toMatchObject({
      state: 'installed',
      running: true,
      actions: ['start-session', 'stop', 'install', 'remove'],
    });
    expect(view.error).toBeUndefined();
    // A NEW install would still download the pinned build.
    expect(view.runtime).toMatchObject({ version: OLLAMA_RUNTIME_PIN.version, installed: false });
  });

  it('with the pinned build unpacked that one runs, and the state says so', async () => {
    const h = setup({ state: OLD_STATE, runtimeOnDisk: true });
    await h.service.boot();
    expect(h.supervisor.start).toHaveBeenCalledWith({ port: 11435, contextLength: 131072, previousPid: 4711 });
    expect(h.store.get().runtime?.version).toBe(OLLAMA_RUNTIME_PIN.version);
  });

  it('with neither on disk the start fails in the open: the view says the runtime did not start', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup({ state: OLD_STATE });
    h.world.startResult = { ok: false, code: 'runtime-start-failed', detail: 'spawn ENOENT' };
    await h.service.boot();
    expect((await h.service.view()).error).toMatchObject({ code: 'runtime-start-failed', next: 'start' });
  });

  it('a version the state file could never name is not turned into a path', async () => {
    const h = setup({ state: { ...INSTALLED, runtime: { ...INSTALLED.runtime!, version: '../../evil' } } });
    await h.service.boot();
    expect(h.supervisor.start).toHaveBeenCalledWith({ port: 11435, contextLength: 131072, previousPid: 4711 });
  });
});

describe('a runtime an earlier server left behind', () => {
  it.each(['paused', 'failed'] as const)('Remove of a %s job ends it before any file is deleted', async (state) => {
    const base = jobAt('model', 'paused');
    const h = setup({
      state: state === 'paused' ? base : { ...base, state: 'failed', error: { code: 'pull-failed' } },
    });
    const removed = await h.service.remove({ removeModel: true }, [], ADMIN);
    expect(removed.ok && removed.view.state).toBe('idle');
    expect(h.supervisor.stop).toHaveBeenCalledWith({ previousPid: 5000 });
    expect(h.calls.indexOf('supervisor.stop')).toBeLessThan(h.calls.indexOf('removeLocalModelFiles'));
  });

  it('Stop of an installed model ends it too, also when this server never started it', async () => {
    const h = setup({ state: INSTALLED });
    await h.service.runtime({ action: 'stop' });
    expect(h.supervisor.stop).toHaveBeenCalledWith({ previousPid: 4711 });
  });

  it('boot ends it for a model the person had stopped', async () => {
    const h = setup({ state: { ...INSTALLED, runtime: { ...INSTALLED.runtime!, enabled: false } } });
    await h.service.boot();
    expect(h.supervisor.start).not.toHaveBeenCalled();
    expect(h.supervisor.stop).toHaveBeenCalledWith({ previousPid: 4711 });
  });

  it('the pid is stored the moment the child is spawned, before it answers', async () => {
    const h = setup({
      state: { ...jobAt('model', 'paused'), runtime: { version: '0.40.15', port: 11435, enabled: true } },
    });
    h.service.onRuntimeChange({ running: false, pid: 7777, restarts: 0, gaveUp: false });
    await vi.waitFor(() => expect(h.store.get().runtime?.pid).toBe(7777));
  });
});

// ---------- What a failed download is called, and what is offered next ----------

describe('a runtime that is gone for good during the download', () => {
  it('is said as the runtime, not as the network, and "Try again" runs the step again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup();
    h.deps.pullModel.mockImplementation(async () => {
      h.world.running = false;
      h.world.gaveUp = true;
      return { ok: false as const, code: 'pull-failed' as const, detail: 'connect ECONNREFUSED 127.0.0.1:11435' };
    });
    await installAndWait(h.service);
    const view = await h.service.view();
    expect(view).toMatchObject({ state: 'failed', step: 'model', actions: ['resume', 'install', 'remove'] });
    expect(view.error).toEqual({
      code: 'runtime-stopped',
      message: { text: 'The runtime keeps stopping, so Codeman no longer restarts it.' },
      // A job has no Start verb: the step is run again.
      next: 'retry',
      detail: 'connect ECONNREFUSED 127.0.0.1:11435',
    });
  });

  it('a pull that fails while the runtime runs is still the download', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup();
    h.deps.pullModel.mockResolvedValue({ ok: false, code: 'pull-failed', detail: 'unexpected EOF' } as never);
    await installAndWait(h.service);
    expect((await h.service.view()).error).toMatchObject({ code: 'pull-failed', next: 'retry' });
  });
});

describe('the model offered after "does not fit"', () => {
  it('needs less memory than the one that failed: a model that needs more is not offered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup();
    // The only other row needs MORE than the model that failed.
    h.deps.recommend.mockImplementation(() => {
      const rec = recommendation();
      rec.alternatives = [candidate('qwen3.8:27b', 'Qwen3.8 27B', 131072, 17_700_000_000, false, 39_000_000_000)];
      return rec;
    });
    h.deps.verifyModel.mockResolvedValue({ ok: false, code: 'does-not-fit' } as never);
    await installAndWait(h.service);
    const view = await h.service.view();
    expect(view.error).toMatchObject({ code: 'does-not-fit', next: 'next-model' });
    expect(view.error).not.toHaveProperty('nextModel');
  });

  it('skips a larger row for the first one that needs less', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup();
    h.deps.getCatalog.mockReturnValue({
      ...CATALOG,
      models: [...CATALOG.models, { id: 'qwen3.8:27b', label: 'Qwen3.8 27B' }],
    } as unknown as LocalModelCatalog);
    h.deps.recommend.mockImplementation(() => {
      const rec = recommendation();
      rec.alternatives = [
        candidate('qwen3.8:27b', 'Qwen3.8 27B', 131072, 17_700_000_000, false, 39_000_000_000),
        candidate('gpt-oss:20b', 'GPT-OSS 20B', 131072, 13_793_441_427, false, 26_600_000_000),
      ];
      return rec;
    });
    h.deps.verifyModel.mockResolvedValue({ ok: false, code: 'does-not-fit' } as never);
    await installAndWait(h.service);
    expect((await h.service.view()).error?.nextModel).toEqual({ modelId: 'gpt-oss:20b', modelLabel: 'GPT-OSS 20B' });
  });

  it('after "no tool call" memory is not the question: the best other model is offered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = setup();
    h.deps.getCatalog.mockReturnValue({
      ...CATALOG,
      models: [...CATALOG.models, { id: 'qwen3.8:27b', label: 'Qwen3.8 27B' }],
    } as unknown as LocalModelCatalog);
    h.deps.recommend.mockImplementation(() => {
      const rec = recommendation();
      rec.alternatives = [candidate('qwen3.8:27b', 'Qwen3.8 27B', 131072, 17_700_000_000, false, 39_000_000_000)];
      return rec;
    });
    h.deps.verifyModel.mockResolvedValue({ ok: false, code: 'no-tool-call' } as never);
    await installAndWait(h.service);
    expect((await h.service.view()).error?.nextModel).toEqual({ modelId: 'qwen3.8:27b', modelLabel: 'Qwen3.8 27B' });
  });
});

describe('what a replaced download left behind', () => {
  it('the partial blobs are deleted as files, after the model was asked for and before the new pull', async () => {
    const h = setup({
      state: { ...jobAt('model', 'paused'), replacedModelId: 'gpt-oss:20b' },
    });
    h.deps.removePartialModelBlobs.mockImplementation(async () => {
      h.calls.push('removePartialModelBlobs');
      return 12_708_189_425;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    const order = h.calls.filter((call) => ['deleteModel', 'removePartialModelBlobs', 'pullModel'].includes(call));
    expect(order).toEqual(['deleteModel', 'removePartialModelBlobs', 'pullModel']);
    expect(h.deps.removePartialModelBlobs).toHaveBeenCalledWith(PATHS);
    expect(h.store.get()).not.toHaveProperty('replacedModelId');
  });

  it('a job that replaced nothing deletes nothing', async () => {
    const h = setup();
    await installAndWait(h.service);
    expect(h.deps.deleteModel).not.toHaveBeenCalled();
    expect(h.deps.removePartialModelBlobs).not.toHaveBeenCalled();
  });
});

// ---------- Live sessions keep the address they were started with ----------

describe('Stop and "Use another port" while live sessions use the model', () => {
  it('Stop is 409 sessions-open with their names, and the runtime keeps running', async () => {
    const h = setup({ state: INSTALLED });
    await h.service.boot();
    h.supervisor.stop.mockClear();
    const result = await h.service.runtime({ action: 'stop' }, ['w1-app', 'w4-lib']);
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      conflict: {
        reason: 'sessions-open',
        sessions: ['w1-app', 'w4-lib'],
        message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSessionsOpen, vars: { sessions: 'w1-app, w4-lib' } },
      },
    });
    expect(h.supervisor.stop).not.toHaveBeenCalled();
    expect(h.store.get().runtime?.enabled).toBe(true);
  });

  it('a start on another port is refused the same way, and nothing moves', async () => {
    const h = setup({ state: INSTALLED });
    const result = await h.service.runtime({ action: 'start', newPort: true }, ['w1-app']);
    expect(result).toMatchObject({ ok: false, status: 409, conflict: { reason: 'sessions-open' } });
    expect(h.deps.chooseRuntimePort).not.toHaveBeenCalled();
    expect(h.deps.moveLocalEndpoint).not.toHaveBeenCalled();
    expect(h.store.get().runtime?.port).toBe(11435);
  });

  it('a plain Start is not refused: it changes no address', async () => {
    const h = setup({ state: { ...INSTALLED, runtime: { ...INSTALLED.runtime!, enabled: false } } });
    const result = await h.service.runtime({ action: 'start' }, ['w1-app']);
    expect(result.ok && result.view.running).toBe(true);
  });

  it('"Use another port" of a job is refused only when a connection of ours exists', async () => {
    const failedOnPort: LocalModelStateFile = {
      ...jobAt('connect', 'paused'),
      state: 'failed',
      error: { code: 'port-in-use', vars: { port: '11435' } },
    };
    const connected = setup({
      state: { ...failedOnPort, connection: { endpointId: 'local-ollama', flagWasEnabled: false } },
    });
    expect(await connected.service.resume({ newPort: true }, ADMIN, ['w1-app'])).toMatchObject({
      ok: false,
      conflict: { reason: 'sessions-open', sessions: ['w1-app'] },
    });
    expect(connected.deps.chooseRuntimePort).not.toHaveBeenCalled();

    // Without a connection of ours no session can be on the model: sessions elsewhere do not matter.
    const fresh = setup({ state: failedOnPort });
    fresh.deps.chooseRuntimePort.mockResolvedValue(11436);
    const result = await fresh.service.resume({ newPort: true }, ADMIN, ['w1-app']);
    expect(result.ok).toBe(true);
    await fresh.service.idle();
  });

  it('a state write that fails before the saved endpoint moved changes nothing', async () => {
    const h = setup({ state: INSTALLED });
    h.deps.chooseRuntimePort.mockResolvedValue(11437);
    h.store.disk.refuse = (next) => next.runtime?.port === 11437;
    await expect(h.service.runtime({ action: 'start', newPort: true })).rejects.toThrow('ENOSPC');
    expect(h.deps.moveLocalEndpoint).not.toHaveBeenCalled();
    expect(h.store.get().runtime?.port).toBe(11435);
  });
});

// ---------- The library ----------

const GPT = { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', context: 131072 };
const GPT_BYTES = 13_793_441_427;
const QWEN_ENTRY = {
  id: 'qwen3.6:35b-a3b',
  label: 'Qwen3.6 35B-A3B',
  context: 131072,
  digest: DIGEST,
  bytes: PULL_BYTES,
  cli: { id: 'opencode', label: 'OpenCode' },
};
const GPT_ENTRY = {
  id: GPT.id,
  label: GPT.label,
  context: 65536,
  digest: DIGEST,
  bytes: GPT_BYTES,
  cli: { id: 'opencode', label: 'OpenCode' },
};
/** Two checked models, the Qwen one in use. */
const TWO_MODELS: LocalModelStateFile = { ...INSTALLED, library: [QWEN_ENTRY, GPT_ENTRY] };
const BOTH_TAGS = [
  { name: QWEN_ENTRY.id, size: PULL_BYTES, digest: DIGEST },
  { name: GPT_ENTRY.id, size: GPT_BYTES, digest: DIGEST },
];
const ADD_GPT: LocalModelInstallRequest = {
  modelId: GPT.id,
  cli: 'opencode',
  context: GPT.context,
  acknowledgedBytes: GPT_BYTES + RUNTIME_BYTES,
};

describe('the first install starts the library', () => {
  it('the model that passed its check is the one checked model, with its digest, size and coding agent', async () => {
    const h = setup();
    await installAndWait(h.service);
    expect(h.store.get().library).toEqual([{ ...QWEN_ENTRY, verifiedAt: new Date(1_000_000).toISOString() }]);
    const view = await h.service.view();
    expect(view.library).toEqual([
      {
        id: QWEN_ENTRY.id,
        label: QWEN_ENTRY.label,
        context: 131072,
        sizeBytes: PULL_BYTES,
        sizeGb: '23.1',
        active: true,
        verified: true,
        status: 'ready',
        actions: [],
      },
    ]);
  });

  it('the entry is written when the check passes, before the coding agent is installed', async () => {
    const h = setup({
      overrides: {
        runInstallCommand: vi.fn(async () => ({ code: 1, output: 'no network\n', timedOut: false, aborted: false })),
      },
    });
    await installAndWait(h.service);
    expect(h.store.get()).toMatchObject({ state: 'failed', step: 'agent', library: [{ id: QWEN_ENTRY.id }] });
    // It is the model of the stopped job: Resume goes on with it, so no switch is offered.
    const view = await h.service.view();
    expect(view.library.map((row) => row.actions)).toEqual([[]]);
    expect(view.actions).toEqual(['resume', 'install', 'remove']);
  });

  it('a size the runtime does not report falls back to what the pull counted', async () => {
    const h = setup();
    h.world.tags = [];
    await installAndWait(h.service);
    expect(h.store.get().library?.[0].bytes).toBe(PULL_BYTES);
  });
});

describe('adding a model to an installed one', () => {
  it('downloads, checks and connects it, and keeps the earlier model in the library', async () => {
    const h = setup({ state: INSTALLED, runtimeOnDisk: true, agentInstalled: true });
    await h.service.boot();
    h.calls.length = 0;
    h.world.tags = BOTH_TAGS;

    const started = await h.service.install(ADD_GPT, ADMIN);
    expect(started.ok && started.view.state).toBe('installing');
    await h.service.idle();

    expect(h.calls).toEqual([
      'ensureRuntimeInstalled',
      'supervisor.start',
      'supervisor.start',
      'pullModel',
      'supervisor.start',
      'verifyModel',
      'supervisor.start',
      'connectLocalModel',
    ]);
    // Nothing of the earlier model was deleted: it was checked, and it stays.
    expect(h.deps.deleteModel).not.toHaveBeenCalled();
    expect(h.deps.removePartialModelBlobs).not.toHaveBeenCalled();
    // The runtime is started for the new model's context.
    expect(h.supervisor.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ port: 11435, contextLength: 131072 })
    );
    // The one endpoint record is rewritten for the new model; it stays ours.
    expect(h.deps.connectLocalModel).toHaveBeenCalledWith({
      port: 11435,
      modelId: GPT.id,
      context: GPT.context,
      ours: true,
      flagWasEnabled: false,
    });
    expect(h.store.get()).toMatchObject({
      state: 'installed',
      model: { id: GPT.id, context: GPT.context, digest: DIGEST },
      connection: { endpointId: 'local-ollama', flagWasEnabled: false },
      library: [QWEN_ENTRY, { id: GPT.id, context: GPT.context, digest: DIGEST, bytes: GPT_BYTES }],
    });
    expect(h.store.get()).not.toHaveProperty('replacedModelId');

    const view = await h.service.view();
    expect(view.model).toEqual({ id: GPT.id, label: GPT.label });
    expect(view.library.map((row) => [row.id, row.active, row.status, row.actions])).toEqual([
      [GPT.id, true, 'ready', []],
      [QWEN_ENTRY.id, false, 'ready', ['use', 'delete']],
    ]);
    expect(view.actions).toEqual(['start-session', 'stop', 'install', 'use', 'delete-model', 'remove']);
    // Only the model in use may be launched.
    expect(await h.service.launchRefusalMessage('local-ollama', GPT.id)).toBeUndefined();
    expect(await h.service.launchRefusalMessage('local-ollama', QWEN_ENTRY.id)).toBe(
      'Only GPT-OSS 20B is in use on this Mac. Switch models in the local model window first.'
    );
  });

  it('is refused while live sessions use the model, before anything is asked or started', async () => {
    const h = setup({ state: INSTALLED, runtimeOnDisk: true, agentInstalled: true });
    await h.service.boot();
    h.calls.length = 0;
    const refused = await h.service.install(ADD_GPT, ADMIN, ['w1-app', 'w2-api']);
    expect(refused).toMatchObject({
      ok: false,
      status: 409,
      conflict: {
        reason: 'sessions-open',
        sessions: ['w1-app', 'w2-api'],
        message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSessionsOpen, vars: { sessions: 'w1-app, w2-api' } },
      },
    });
    expect(h.calls).toEqual([]);
    expect(h.deps.readHardware).not.toHaveBeenCalled();
    expect(h.store.get().state).toBe('installed');
  });

  it('a first install is not held up by sessions elsewhere: no connection of ours exists yet', async () => {
    const h = setup();
    const started = await h.service.install(REQUEST, ADMIN, ['w1-app']);
    expect(started.ok).toBe(true);
    await h.service.cancel();
  });

  it('the model in use at ANOTHER context is an install like any other: it is checked again at that context', async () => {
    const h = setup({ state: INSTALLED, runtimeOnDisk: true, agentInstalled: true });
    h.deps.recommend.mockReturnValue({
      ...recommendation(true),
      pick: candidate('qwen3.6:35b-a3b', 'Qwen3.6 35B-A3B', 65536, PULL_BYTES, true),
    });
    await h.service.boot();
    const started = await h.service.install({ ...REQUEST, context: 65536 }, ADMIN);
    expect(started.ok).toBe(true);
    await h.service.idle();
    expect(h.store.get()).toMatchObject({
      state: 'installed',
      model: { id: 'qwen3.6:35b-a3b', context: 65536 },
      library: [{ id: 'qwen3.6:35b-a3b', context: 65536 }],
    });
    expect(h.store.get().library).toHaveLength(1);
  });

  it('a job that stops leaves the earlier model to go back to, and no session until then', async () => {
    const h = setup({ state: INSTALLED, runtimeOnDisk: true, agentInstalled: true });
    await h.service.boot();
    h.world.tags = BOTH_TAGS;
    h.deps.verifyModel.mockResolvedValueOnce({ ok: false, code: 'no-tool-call' } as never);
    await h.service.install(ADD_GPT, ADMIN);
    await h.service.idle();

    expect(h.store.get()).toMatchObject({ state: 'failed', step: 'verify', model: { id: GPT.id } });
    // The endpoint record still names the earlier model, and nothing may be started on it.
    expect(await h.service.launchRefusal('local-ollama')).toEqual({
      code: 'job-unfinished',
      message: { text: LOCAL_MODEL_INSTALL_LABELS.errJobUnfinished },
      next: 'retry',
    });
    expect(await h.service.launchRefusalMessage('local-ollama', QWEN_ENTRY.id)).toBe(
      'The model on this Mac is being changed and is not ready. Finish or undo that in the local model window first.'
    );
    const view = await h.service.view();
    expect(view.actions).toEqual(['resume', 'install', 'use', 'delete-model', 'remove']);
    expect(view.library.map((row) => [row.id, row.status, row.actions])).toEqual([
      [QWEN_ENTRY.id, 'ready', ['use', 'delete']],
      // Downloaded and not checked: the model of the stopped job, so nothing is offered on it.
      [GPT.id, 'unverified', []],
    ]);

    // The way back. The model that never passed its check goes: it is what the job left behind.
    h.calls.length = 0;
    const back = await h.service.use({ modelId: QWEN_ENTRY.id }, ADMIN);
    expect(back.ok).toBe(true);
    await h.service.idle();
    expect(h.deps.deleteModel).toHaveBeenCalledWith(expect.anything(), GPT.id, expect.anything());
    expect(h.calls).toContain('removePartialModelBlobs');
    expect(h.store.get()).toMatchObject({ state: 'installed', model: { id: QWEN_ENTRY.id, digest: DIGEST } });
    expect(h.store.get()).not.toHaveProperty('replacedModelId');
    expect(h.store.get()).not.toHaveProperty('error');
    expect(await h.service.launchRefusalMessage('local-ollama', QWEN_ENTRY.id)).toBeUndefined();
  });
});

describe('use: the switch to a checked model', () => {
  it('loads and checks it again, connects it, and downloads nothing', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true, agentInstalled: true });
    await h.service.boot();
    h.calls.length = 0;
    h.world.tags = BOTH_TAGS;

    const started = await h.service.use({ modelId: GPT.id }, ADMIN);
    expect(started.ok && started.view).toMatchObject({
      state: 'installing',
      step: 'verify',
      steps: ['verify', 'connect'],
      model: { id: GPT.id, label: GPT.label },
      context: 65536,
    });
    await h.service.idle();

    expect(h.calls).toEqual([
      'recheckCliInstalled',
      'supervisor.start',
      'verifyModel',
      'supervisor.start',
      'connectLocalModel',
    ]);
    expect(h.deps.pullModel).not.toHaveBeenCalled();
    expect(h.deps.ensureRuntimeInstalled).not.toHaveBeenCalled();
    expect(h.deps.deleteModel).not.toHaveBeenCalled();
    // The runtime is restarted for the context the model was checked with.
    expect(h.supervisor.start).toHaveBeenLastCalledWith(expect.objectContaining({ contextLength: 65536 }));
    expect(h.deps.verifyModel).toHaveBeenCalledWith(expect.anything(), GPT.id, 65536, expect.anything());
    expect(h.deps.connectLocalModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: GPT.id, context: 65536, ours: true })
    );
    expect(h.store.get()).toMatchObject({
      state: 'installed',
      model: { id: GPT.id, context: 65536, digest: DIGEST },
      cli: { id: 'opencode', label: 'OpenCode' },
      library: [QWEN_ENTRY, { id: GPT.id, digest: DIGEST }],
    });
    expect(h.deps.audit).toHaveBeenCalledWith({
      admin: 'root',
      action: 'local_model_use',
      target: GPT.id,
      ip: '127.0.0.1',
      detail: { cli: 'opencode', context: 65536 },
    });
  });

  it('is refused for a model that is not one of the checked ones, and for the one in use', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true, agentInstalled: true });
    await h.service.boot();
    h.calls.length = 0;
    expect(await h.service.use({ modelId: 'someone-else:7b' }, ADMIN)).toEqual({
      ok: false,
      status: 400,
      message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedNotInLibrary },
    });
    expect(await h.service.use({ modelId: QWEN_ENTRY.id }, ADMIN)).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: 'already-installed' },
    });
    expect(h.calls).toEqual([]);
    expect(h.store.get().state).toBe('installed');
  });

  it('is refused while live sessions use the model', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true, agentInstalled: true });
    await h.service.boot();
    h.calls.length = 0;
    expect(await h.service.use({ modelId: GPT.id }, ADMIN, ['w1-app'])).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: 'sessions-open', sessions: ['w1-app'] },
    });
    expect(h.calls).toEqual([]);
  });

  it('is 409 wrong-state where there is nothing to switch: idle', async () => {
    const h = setup();
    expect(await h.service.use({ modelId: GPT.id }, ADMIN)).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: 'wrong-state' },
    });
  });

  it('a model whose digest is no longer the stored one is not loaded: model-changed, and the way back stays', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true, agentInstalled: true });
    await h.service.boot();
    h.world.tags = [BOTH_TAGS[0], { ...BOTH_TAGS[1], digest: 'ffff00000000' }];
    h.deps.readModelDigest.mockImplementation(async (_target: unknown, id: string) =>
      id === GPT.id ? 'ffff00000000' : DIGEST
    );
    h.calls.length = 0;
    await h.service.use({ modelId: GPT.id }, ADMIN);
    await h.service.idle();

    expect(h.deps.verifyModel).not.toHaveBeenCalled();
    expect(h.deps.connectLocalModel).not.toHaveBeenCalled();
    const view = await h.service.view();
    expect(view.state).toBe('failed');
    expect(view.error).toMatchObject({
      code: 'model-changed',
      detail: 'The runtime reports another digest for the model.',
    });
    expect(view.library.map((row) => [row.id, row.status, row.actions])).toEqual([
      [QWEN_ENTRY.id, 'ready', ['use', 'delete']],
      [GPT.id, 'changed', []],
    ]);
    // The changed model stays a library entry until the person deletes it; it is never deleted as a leftover.
    await h.service.use({ modelId: QWEN_ENTRY.id }, ADMIN);
    await h.service.idle();
    expect(h.deps.deleteModel).not.toHaveBeenCalled();
    expect(h.store.get()).toMatchObject({ state: 'installed', model: { id: QWEN_ENTRY.id } });
  });

  it('a model the runtime no longer lists is model-changed too, said as that', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true, agentInstalled: true });
    await h.service.boot();
    h.deps.readModelDigest.mockImplementation(async (_target: unknown, id: string) =>
      id === GPT.id ? undefined : DIGEST
    );
    await h.service.use({ modelId: GPT.id }, ADMIN);
    await h.service.idle();
    expect((await h.service.view()).error).toMatchObject({
      code: 'model-changed',
      detail: 'The runtime no longer lists the model.',
    });
  });

  it('takes the coding agent the model was checked with when it is installed, else the one of the state', async () => {
    const pi = { id: 'pi', label: 'Pi' };
    const state: LocalModelStateFile = { ...TWO_MODELS, library: [QWEN_ENTRY, { ...GPT_ENTRY, cli: pi }] };
    const withPi = setup({ state, runtimeOnDisk: true });
    withPi.deps.recheckCliInstalled.mockImplementation(async () => true);
    await withPi.service.boot();
    await withPi.service.use({ modelId: GPT.id }, ADMIN);
    await withPi.service.idle();
    expect(withPi.store.get().cli).toEqual(pi);

    const withoutPi = setup({ state, runtimeOnDisk: true });
    withoutPi.deps.recheckCliInstalled.mockImplementation((async (id: string) => id === 'opencode') as never);
    await withoutPi.service.boot();
    await withoutPi.service.use({ modelId: GPT.id }, ADMIN);
    await withoutPi.service.idle();
    expect(withoutPi.store.get().cli).toEqual({ id: 'opencode', label: 'OpenCode' });
  });

  it('with neither of the two installed it takes another agent the model can be run with that is on this Mac', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true, agentInstalled: false });
    // OpenCode has gone; Claude Code, the catalogue's other harness, is there.
    h.deps.buildHarnessFacts.mockImplementation(async () => [
      FACTS[0],
      { cli: 'claude', label: 'Claude Code', installed: true, installable: false, acceptsModelId: () => true },
    ]);
    await h.service.boot();
    expect((await h.service.use({ modelId: GPT.id }, ADMIN)).ok).toBe(true);
    await h.service.idle();
    expect(h.store.get()).toMatchObject({
      state: 'installed',
      model: { id: GPT.id },
      cli: { id: 'claude', label: 'Claude Code' },
    });
  });

  it('with no coding agent of the two installed it is refused, in one sentence, and nothing starts', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true, agentInstalled: false });
    await h.service.boot();
    expect(await h.service.use({ modelId: GPT.id }, ADMIN)).toEqual({
      ok: false,
      status: 400,
      message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentMissing, vars: { cli: 'OpenCode' } },
    });
    expect(h.store.get().state).toBe('installed');
  });

  it('a switch or a new model from a stopped model starts the runtime and undoes the Stop', async () => {
    const stopped: LocalModelStateFile = { ...TWO_MODELS, runtime: { ...INSTALLED.runtime!, enabled: false } };
    const switched = setup({ state: stopped, runtimeOnDisk: true, agentInstalled: true });
    await switched.service.boot();
    expect(switched.supervisor.start).not.toHaveBeenCalled();
    await switched.service.use({ modelId: GPT.id }, ADMIN);
    await switched.service.idle();
    // The model is in use and running now, so it starts with the server again, like after Start.
    expect(switched.store.get()).toMatchObject({ state: 'installed', runtime: { enabled: true } });
    expect((await switched.service.view()).running).toBe(true);

    const added = setup({ state: { ...INSTALLED, runtime: { ...INSTALLED.runtime!, enabled: false } } });
    added.world.runtimeOnDisk = true;
    added.world.agentInstalled = true;
    await added.service.boot();
    await added.service.install(ADD_GPT, ADMIN);
    await added.service.idle();
    expect(added.store.get()).toMatchObject({ state: 'installed', model: { id: GPT.id }, runtime: { enabled: true } });

    // A switch that was refused changed nothing: the model stays stopped.
    const refused = setup({ state: stopped, runtimeOnDisk: true, agentInstalled: true });
    await refused.service.use({ modelId: 'someone-else:7b' }, ADMIN);
    expect(refused.store.get().runtime?.enabled).toBe(false);
  });

  it('Cancel pauses a switch like any job, and Resume goes on with it', async () => {
    const h = setup({
      state: TWO_MODELS,
      runtimeOnDisk: true,
      agentInstalled: true,
      overrides: {
        verifyModel: vi
          .fn()
          .mockImplementationOnce(async (_t: unknown, _id: string, _c: number, signal?: AbortSignal) => {
            await untilAborted(signal);
            return { ok: false as const, code: 'cancelled' as const };
          })
          .mockResolvedValue({
            ok: true as const,
            loaded: { context: 65536, sizeBytes: 15_000_000_000, sizeVramBytes: 15_000_000_000 },
          }),
      },
    });
    await h.service.boot();
    await h.service.use({ modelId: GPT.id }, ADMIN);
    await vi.waitFor(() => expect(h.deps.verifyModel).toHaveBeenCalled());
    const paused = await h.service.cancel();
    expect(paused.ok && paused.view).toMatchObject({ state: 'paused', step: 'verify', steps: ['verify', 'connect'] });
    await h.service.resume({}, ADMIN);
    await h.service.idle();
    expect(h.store.get()).toMatchObject({ state: 'installed', model: { id: GPT.id } });
  });
});

describe('installAgent: one more coding agent beside an installed model', () => {
  /** An installed, running model whose coding agent is not on this Mac. */
  async function withoutAgent() {
    const h = setup({ state: INSTALLED, runtimeOnDisk: true, agentInstalled: false });
    await h.service.boot();
    return h;
  }

  it('the view offers it: the agent with its literal command, no session, and the state untouched', async () => {
    const h = await withoutAgent();
    const view = await h.service.view();
    expect(view.state).toBe('installed');
    expect(view.harnesses).toEqual([
      {
        cli: 'opencode',
        cliLabel: 'OpenCode',
        default: true,
        status: 'installable',
        installCommand: INSTALL_COMMAND,
        actions: ['install'],
      },
    ]);
    expect(view.actions).toContain('install-agent');
    // Nothing can be started, so no session is offered: the window says "Install OpenCode".
    expect(view.actions).not.toContain('start-session');
  });

  it('answers once the installer is started, runs the stock command in the shared slot, and ends on an agent that can be started', async () => {
    const h = await withoutAgent();
    let finish: () => void = () => {};
    h.deps.runInstallCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            h.world.agentInstalled = true;
            resolve({ code: 0, output: 'opencode installed\n', timedOut: false, aborted: false });
          };
        })
    );
    const before = structuredClone(h.store.get());

    const started = await h.service.installAgent({ cli: 'opencode' }, ADMIN);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    // While it runs: the row says so, nothing else is offered for it, and the model is as it was.
    expect(started.view.state).toBe('installed');
    expect(started.view.harnesses[0]).toMatchObject({
      status: 'installing',
      installCommand: INSTALL_COMMAND,
      actions: [],
    });
    expect(started.view.actions).not.toContain('install-agent');
    await vi.waitFor(() => expect(h.deps.runInstallCommand).toHaveBeenCalledTimes(1));
    const [command, options] = h.deps.runInstallCommand.mock.calls[0] as unknown as [string, { signal: AbortSignal }];
    expect(command).toBe(INSTALL_COMMAND);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(h.deps.tryBeginCliInstall).toHaveBeenCalledWith('opencode');
    // Not a job: a session on the model is still not refused.
    expect(await h.service.launchRefusal('local-ollama')).toBeUndefined();

    finish();
    await h.service.idle();
    const view = await h.service.view();
    expect(view.harnesses).toEqual([
      { cli: 'opencode', cliLabel: 'OpenCode', default: true, status: 'ready', actions: ['start-session'] },
    ]);
    expect(view.actions).toContain('start-session');
    expect(h.calls).toContain('release');
    expect(h.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        admin: ADMIN.username,
        action: 'cli_install',
        target: 'opencode',
        detail: expect.objectContaining({ command: INSTALL_COMMAND, exitCode: 0, via: 'local-model' }),
      })
    );
    // The state file never heard of it (the pid and the time of a write aside, nothing moved).
    expect(h.store.get()).toEqual(before);
  });

  it('an installer that fails leaves the model installed and usable, and its last words on the row', async () => {
    const h = await withoutAgent();
    h.deps.runInstallCommand.mockResolvedValue({
      code: 1,
      output: 'npm ERR! network request failed',
      timedOut: false,
      aborted: false,
    });
    expect((await h.service.installAgent({ cli: 'opencode' }, ADMIN)).ok).toBe(true);
    await h.service.idle();
    const view = await h.service.view();
    expect(view.state).toBe('installed');
    expect(view).not.toHaveProperty('error');
    expect(view.harnesses[0]).toMatchObject({
      status: 'installable',
      actions: ['install'],
      error: {
        message: { text: LOCAL_MODEL_INSTALL_LABELS.errHarnessFailed, vars: { cli: 'OpenCode' } },
        detail: 'npm ERR! network request failed',
      },
    });
    expect(h.store.get().state).toBe('installed');
    expect(await h.service.launchRefusal('local-ollama')).toBeUndefined();

    // Try again: the old failure is gone the moment the new attempt starts, and it can work.
    h.deps.runInstallCommand.mockImplementation(async () => {
      h.world.agentInstalled = true;
      return { code: 0, output: '', timedOut: false, aborted: false };
    });
    const again = await h.service.installAgent({ cli: 'opencode' }, ADMIN);
    if (!again.ok) throw new Error('unreachable');
    expect(again.view.harnesses[0]).not.toHaveProperty('error');
    await h.service.idle();
    expect((await h.service.view()).harnesses[0]).toMatchObject({ status: 'ready' });
  });

  it('one installer at a time: a second request while one runs is 409 job-running', async () => {
    const h = await withoutAgent();
    let finish: () => void = () => {};
    h.deps.runInstallCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ code: 1, output: 'stopped', timedOut: false, aborted: false });
        })
    );
    expect((await h.service.installAgent({ cli: 'opencode' }, ADMIN)).ok).toBe(true);
    expect(await h.service.installAgent({ cli: 'opencode' }, ADMIN)).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: 'job-running' },
    });
    await vi.waitFor(() => expect(h.deps.runInstallCommand).toHaveBeenCalledTimes(1));
    finish();
    await h.service.idle();
    expect(h.deps.runInstallCommand).toHaveBeenCalledTimes(1);
  });

  it('an agent that is already there answers with the view and runs nothing', async () => {
    const h = setup({ state: INSTALLED, runtimeOnDisk: true });
    await h.service.boot();
    const result = await h.service.installAgent({ cli: 'opencode' }, ADMIN);
    expect(result.ok).toBe(true);
    expect(h.deps.runInstallCommand).not.toHaveBeenCalled();
    expect(h.deps.tryBeginCliInstall).not.toHaveBeenCalled();
  });

  it('refuses an agent the view does not list, and one that one command does not make startable', async () => {
    const h = await withoutAgent();
    // `claude` is a catalogue harness with no fact here (the registry does not offer it).
    for (const cli of ['claude', 'not-a-cli']) {
      expect(await h.service.installAgent({ cli }, ADMIN)).toEqual({
        ok: false,
        status: 400,
        message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentNotOffered },
      });
    }
    // A launcher, or a command that needs an administrator: listed, never installed from here.
    h.deps.buildHarnessFacts.mockImplementation(async () => [
      { cli: 'opencode', label: 'OpenCode', installed: false, installable: false, acceptsModelId: () => true },
    ]);
    expect((await h.service.view()).harnesses[0]).toMatchObject({ status: 'setup-needed', actions: [] });
    expect(await h.service.installAgent({ cli: 'opencode' }, ADMIN)).toEqual({
      ok: false,
      status: 400,
      message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentNotInstallable, vars: { cli: 'OpenCode' } },
    });
    expect(h.deps.runInstallCommand).not.toHaveBeenCalled();
  });

  it('is refused outside installed: 409 wrong-state', async () => {
    for (const state of [undefined, jobAt('model', 'paused')]) {
      const h = setup(state ? { state } : {});
      expect(await h.service.installAgent({ cli: 'opencode' }, ADMIN)).toMatchObject({
        ok: false,
        status: 409,
        conflict: { reason: 'wrong-state' },
      });
      expect(h.deps.runInstallCommand).not.toHaveBeenCalled();
    }
  });

  it('a server that stops ends the installer and records nothing', async () => {
    const h = await withoutAgent();
    let seen: AbortSignal | undefined;
    h.deps.runInstallCommand.mockImplementation((async (_command: string, options?: { signal?: AbortSignal }) => {
      seen = options?.signal;
      await untilAborted(options?.signal);
      return { code: null, output: '', timedOut: false, aborted: true };
    }) as never);
    await h.service.installAgent({ cli: 'opencode' }, ADMIN);
    await vi.waitFor(() => expect(seen).toBeDefined());
    await h.service.shutdown();
    expect(seen?.aborted).toBe(true);
    await h.service.idle();
    expect(h.store.get().state).toBe('installed');
    // Interrupted is not failed: the row has no error.
    expect((await h.service.view()).harnesses[0]).not.toHaveProperty('error');
  });
});

describe('deleteLibraryModel: one model out of the store', () => {
  async function twoModelsRunning() {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true, agentInstalled: true });
    await h.service.boot();
    h.world.tags = [...BOTH_TAGS];
    h.deps.deleteModel.mockImplementation(async (_target: unknown, id: string) => {
      h.calls.push('deleteModel');
      h.world.tags = (h.world.tags ?? []).filter((tag) => tag.name !== id);
      return true;
    });
    h.calls.length = 0;
    return h;
  }

  it('deletes it through the runtime, drops its entry and writes the audit line', async () => {
    const h = await twoModelsRunning();
    const result = await h.service.deleteLibraryModel({ modelId: GPT.id }, ADMIN);
    expect(h.deps.deleteModel).toHaveBeenCalledTimes(1);
    expect(h.deps.deleteModel).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:11435' }, GPT.id, expect.anything());
    expect(h.store.get().library).toEqual([QWEN_ENTRY]);
    expect(h.store.get().state).toBe('installed');
    // The answer is the view after the delete: the runtime was asked again.
    expect(result.ok && result.view.library.map((row) => row.id)).toEqual([QWEN_ENTRY.id]);
    expect(h.deps.audit).toHaveBeenCalledWith({
      admin: 'root',
      action: 'local_model_delete',
      target: GPT.id,
      ip: '127.0.0.1',
      detail: { verified: true, bytes: GPT_BYTES },
    });
    // Nothing else of the feature was touched.
    expect(h.calls).toEqual(['deleteModel']);
  });

  it('refuses the model in use: switch first, or remove', async () => {
    const h = await twoModelsRunning();
    expect(await h.service.deleteLibraryModel({ modelId: QWEN_ENTRY.id }, ADMIN)).toEqual({
      ok: false,
      status: 409,
      conflict: {
        reason: 'model-active',
        message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictModelActive, vars: { model: 'Qwen3.6 35B-A3B' } },
      },
    });
    expect(h.deps.deleteModel).not.toHaveBeenCalled();
  });

  it('refuses while the runtime is down or does not answer: only the runtime deletes a model', async () => {
    const stopped = setup({ state: TWO_MODELS });
    expect(await stopped.service.deleteLibraryModel({ modelId: GPT.id }, ADMIN)).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: 'runtime-not-running', message: { text: LOCAL_MODEL_INSTALL_LABELS.errRuntimeNotRunning } },
    });
    const silent = await twoModelsRunning();
    silent.deps.getRuntimeVersion.mockResolvedValue(undefined);
    expect(await silent.service.deleteLibraryModel({ modelId: GPT.id }, ADMIN)).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: 'runtime-not-running' },
    });
    expect(silent.deps.deleteModel).not.toHaveBeenCalled();
    expect(silent.store.get().library).toHaveLength(2);
  });

  it('refuses a name that is neither a checked model nor one the runtime lists, and anything that is not name:tag', async () => {
    const h = await twoModelsRunning();
    const refused = { ok: false, status: 400, message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedNotOnThisMac } };
    expect(await h.service.deleteLibraryModel({ modelId: 'someone-else:7b' }, ADMIN)).toEqual(refused);
    for (const modelId of ['../../etc/passwd', '/Users/me/models', 'hf.co/someone/model:Q4', 'NoTag', '']) {
      expect(await h.service.deleteLibraryModel({ modelId }, ADMIN)).toEqual(refused);
    }
    expect(h.deps.deleteModel).not.toHaveBeenCalled();
  });

  it('is 409 wrong-state in idle: there is no runtime to ask', async () => {
    const h = setup();
    expect(await h.service.deleteLibraryModel({ modelId: GPT.id }, ADMIN)).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: 'wrong-state' },
    });
  });

  it('a runtime that does not delete it: said as that, and the entry stays', async () => {
    const h = await twoModelsRunning();
    h.deps.deleteModel.mockResolvedValue(false);
    expect(await h.service.deleteLibraryModel({ modelId: GPT.id }, ADMIN)).toEqual({
      ok: false,
      status: 500,
      message: { text: LOCAL_MODEL_INSTALL_LABELS.deleteFailed, vars: { model: 'GPT-OSS 20B' } },
    });
    expect(h.store.get().library).toEqual([QWEN_ENTRY, GPT_ENTRY]);
    expect(h.deps.audit).not.toHaveBeenCalled();
  });

  it('a model the runtime lists and Codeman never checked can be deleted too', async () => {
    const h = await twoModelsRunning();
    h.world.tags = [...BOTH_TAGS, { name: 'leftover:9b', size: 6_000_000_000, digest: 'aa' }];
    const before = await h.service.view();
    expect(before.library.find((row) => row.id === 'leftover:9b')).toMatchObject({
      status: 'unverified',
      sizeGb: '6.0',
      actions: ['delete'],
    });
    const result = await h.service.deleteLibraryModel({ modelId: 'leftover:9b' }, ADMIN);
    expect(result.ok && result.view.library.map((row) => row.id)).toEqual([QWEN_ENTRY.id, GPT.id]);
    expect(h.store.get().library).toEqual([QWEN_ENTRY, GPT_ENTRY]);
    expect(h.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'local_model_delete', detail: { verified: false, bytes: 6_000_000_000 } })
    );
  });

  it('a checked model the runtime no longer lists: its entry is dropped once the runtime says it is gone', async () => {
    const h = await twoModelsRunning();
    h.world.tags = [BOTH_TAGS[0]];
    const result = await h.service.deleteLibraryModel({ modelId: GPT.id }, ADMIN);
    expect(result.ok).toBe(true);
    // Asked of the runtime all the same: its "not found" is what says the model is gone.
    expect(h.deps.deleteModel).toHaveBeenCalledWith(expect.anything(), GPT.id, expect.anything());
    expect(h.store.get().library).toEqual([QWEN_ENTRY]);
  });

  it('works from a stopped job too, for any model but the one of that job', async () => {
    const state: LocalModelStateFile = {
      ...jobAt('verify', 'paused'),
      model: { ...GPT },
      library: [QWEN_ENTRY],
      connection: { endpointId: 'local-ollama', flagWasEnabled: false },
    };
    const h = setup({ state, runtimeOnDisk: true });
    h.world.running = true;
    h.world.tags = BOTH_TAGS;
    expect(await h.service.deleteLibraryModel({ modelId: GPT.id }, ADMIN)).toMatchObject({
      ok: false,
      conflict: { reason: 'model-active' },
    });
    const result = await h.service.deleteLibraryModel({ modelId: QWEN_ENTRY.id }, ADMIN);
    expect(result.ok).toBe(true);
    expect(h.store.get().library).toEqual([]);
    expect(h.store.get().state).toBe('paused');
  });
});

describe('the model store in idle: what an earlier Remove kept', () => {
  it('shows what it takes, offers Remove, and Remove with the models frees it', async () => {
    const h = setup();
    h.world.storeBytes = PULL_BYTES;
    const view = await h.service.view();
    expect(view).toMatchObject({
      state: 'idle',
      library: [],
      store: { bytes: PULL_BYTES, gb: '23.1' },
      actions: ['install', 'remove'],
    });

    h.deps.removeLocalModelFiles.mockImplementation(async () => {
      h.calls.push('removeLocalModelFiles');
      h.world.storeBytes = 0;
    });
    const removed = await h.service.remove({ removeModel: true }, [], ADMIN);
    expect(h.deps.removeLocalModelFiles).toHaveBeenCalledWith({ models: true, paths: PATHS });
    expect(removed.ok && removed.view).toMatchObject({
      state: 'idle',
      store: { bytes: 0, gb: '0.0' },
      actions: ['install'],
    });
  });

  it('Remove that keeps the models leaves them there: the next view says how much', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true });
    h.world.storeBytes = PULL_BYTES + GPT_BYTES;
    const removed = await h.service.remove({}, [], ADMIN);
    expect(removed.ok && removed.view).toMatchObject({
      state: 'idle',
      library: [],
      store: { bytes: PULL_BYTES + GPT_BYTES, gb: '36.9' },
      actions: ['install', 'remove'],
    });
    expect(h.store.get()).not.toHaveProperty('library');
  });
});

describe('the view does not ask the runtime or the disk on every poll', () => {
  it('reads the list and the store once, then again only when they are stale', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true });
    await h.service.boot();
    h.world.tags = BOTH_TAGS;
    h.deps.listTags.mockClear();
    for (let i = 0; i < 5; i++) await h.service.view();
    expect(h.deps.listTags).toHaveBeenCalledTimes(1);
    expect(h.deps.measureModelStore).toHaveBeenCalledTimes(1);

    // Five seconds on: the list is read again, in the background. The view does not wait for
    // a runtime that is slow to answer: it is built from the list it has.
    h.world.clock += 5_000;
    let answer: (tags: typeof BOTH_TAGS) => void = () => {};
    h.deps.listTags.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const stale = await h.service.view();
    expect(stale.library.map((row) => row.status)).toEqual(['ready', 'ready']);
    await vi.waitFor(() => expect(h.deps.listTags).toHaveBeenCalledTimes(2));
    // A second poll while that read is out starts no second one.
    await h.service.view();
    expect(h.deps.listTags).toHaveBeenCalledTimes(2);
    answer([BOTH_TAGS[0]]);
    await vi.waitFor(async () =>
      expect((await h.service.view()).library.map((row) => row.status)).toEqual(['ready', 'missing'])
    );
    expect(h.deps.measureModelStore).toHaveBeenCalledTimes(1);

    // Thirty seconds on: the store is measured again.
    h.world.clock += 30_000;
    await h.service.view();
    await vi.waitFor(() => expect(h.deps.measureModelStore).toHaveBeenCalledTimes(2));
  });

  it('a runtime that does not answer keeps the last list: no model reads as missing for a moment', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true });
    await h.service.boot();
    h.world.tags = BOTH_TAGS;
    await h.service.view();
    h.deps.getRuntimeVersion.mockResolvedValue(undefined);
    h.deps.listTags.mockClear();
    h.world.clock += 5_000;
    await h.service.view();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.deps.listTags).not.toHaveBeenCalled();
    expect((await h.service.view()).library.map((row) => row.status)).toEqual(['ready', 'ready']);
  });

  it('a stopped runtime is not asked at all, and offers no delete', async () => {
    const h = setup({ state: { ...TWO_MODELS, runtime: { ...INSTALLED.runtime!, enabled: false } } });
    await h.service.boot();
    const view = await h.service.view();
    expect(h.deps.listTags).not.toHaveBeenCalled();
    expect(view.library.map((row) => [row.id, row.sizeGb, row.actions])).toEqual([
      [QWEN_ENTRY.id, '23.1', []],
      [GPT.id, '13.8', ['use']],
    ]);
  });

  it('a listing or a measurement that fails is not an error of the view', async () => {
    const h = setup({ state: TWO_MODELS, runtimeOnDisk: true });
    await h.service.boot();
    h.deps.listTags.mockRejectedValue(new Error('socket hang up'));
    h.deps.measureModelStore.mockRejectedValue(new Error('EIO'));
    const view = await h.service.view();
    expect(view.state).toBe('installed');
    expect(view).not.toHaveProperty('store');
    expect(view.library.map((row) => row.id)).toEqual([QWEN_ENTRY.id, GPT.id]);
  });
});
