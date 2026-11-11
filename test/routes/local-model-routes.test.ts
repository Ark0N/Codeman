/**
 * @fileoverview The local model routes: GET /api/local-model (what this Mac is and which local
 * model fits it, plus where the install stands) and the verbs that install, cancel, resume,
 * start, stop and remove.
 *
 * The routes only compose injected functions (the hardware probe, the catalogue getter, the
 * harness facts, the pure `recommend()` and the install service), so every test passes its own
 * and no test depends on what those modules compute. What is pinned here is the routes' own
 * contract: the envelope, the admin gate on EVERY verb in multi-user mode, that an unsupported
 * platform and a failed probe are answers (200) and never a 500, what does answer 500, how a
 * verb's refusal becomes a 400 or a 409 with its conflict, that DELETE hands the live sessions
 * to the service, and that a GET with nothing installed writes nothing.
 *
 * The install service itself is tested in test/local-model-install-service.test.ts.
 *
 * Port: N/A (app.inject()).
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouteTestHarness } from './_route-test-utils.js';
import {
  defaultLocalModelRouteDeps,
  hardwareFromOs,
  registerLocalModelRoutes,
  type LocalModelRouteDeps,
} from '../../src/web/routes/local-model-routes.js';
import { buildHarnessFacts } from '../../src/local-model/harness-facts.js';
import { formatGb, memClassGb } from '../../src/local-model/format.js';
import {
  createLocalModelService,
  getLocalModelService,
  type LocalModelService,
  type LocalModelVerbResult,
} from '../../src/local-model/install-job.js';
import { CustomModelHostsWriteRefusedError } from '../../src/custom-model-hosts-writer.js';
import { SettingsWriteRefusedError } from '../../src/web/settings-writer.js';
import { dataPath, getDataDir } from '../../src/config/instance.js';
import {
  LOCAL_MODEL_INSTALL_LABELS,
  LOCAL_MODEL_LABELS,
  type HardwareFacts,
  type HarnessFact,
  type LocalModelCatalog,
  type LocalModelInstallView,
  type Recommendation,
} from '../../src/types.js';

const CATALOG: LocalModelCatalog = {
  schema: 1,
  updated: '2026-11-06',
  minMacosMajor: 14,
  models: [],
  harnesses: [
    { cli: 'opencode', minContext: 65536, rank: 3 },
    { cli: 'claude', minContext: 65536, rank: 2, slowFirstTurn: true },
  ],
  chips: [],
};

/** A 48 GB Apple silicon Mac whose chip is in no chips row, as the probe would report it. */
const MAC: HardwareFacts = {
  platform: 'darwin',
  arch: 'arm64',
  arm64: true,
  translated: false,
  memBytes: 51539607552,
  memGb: '51.5',
  memClassGb: 48,
  chip: 'Apple M5 Pro',
  model: 'Mac17,13',
  macosVersion: '27.2',
  macosMajor: 27,
  wiredLimitMb: 0,
  freeDiskBytes: 912308310016,
  freeDiskGb: '912',
  source: 'sysctl',
};

/** The same Mac after a `sysctl` spawn that failed: `node:os` supplied what little is known. */
const MAC_FALLBACK: HardwareFacts = {
  platform: 'darwin',
  arch: 'arm64',
  memBytes: 51539607552,
  memGb: '51.5',
  memClassGb: 48,
  chip: 'Apple M5 Pro',
  source: 'os-fallback',
};

const LINUX: HardwareFacts = {
  platform: 'linux',
  arch: 'x64',
  memBytes: 67430404096,
  memGb: '67.4',
  memClassGb: 63,
  source: 'not-probed',
};

const OK: Recommendation = {
  verdict: 'ok',
  headline: { text: LOCAL_MODEL_LABELS.headlineOk },
  notes: [{ text: LOCAL_MODEL_LABELS.noteUntested }],
  pick: {
    modelId: 'qwen3.8:27b',
    modelLabel: 'Qwen3.8 27B',
    license: 'Apache-2.0',
    paramsB: 27.8,
    context: 131072,
    cli: 'opencode',
    cliLabel: 'OpenCode',
    cliInstalled: true,
    needBytes: 29551160064,
    needGb: '29.6',
    downloadBytes: 17740000000,
    downloadGb: '17.7',
    budgetShare: 0.79,
    fit: 'good',
    fitLabel: LOCAL_MODEL_LABELS.fitGood,
    speed: 'unknown',
    speedLabel: LOCAL_MODEL_LABELS.speedUnknown,
    tested: false,
    needSource: 'estimated',
    harnesses: [{ cli: 'opencode', cliLabel: 'OpenCode', installed: true }],
    installBytes: 17740000000,
    installGb: '17.7',
  },
  alternatives: [],
  budgetBytes: 37580963840,
  budgetGb: '37.6',
  budgetSource: 'estimated',
};

const NOT_MACOS: Recommendation = {
  verdict: 'none',
  reason: 'not-macos',
  headline: { text: LOCAL_MODEL_LABELS.noneNotMacos },
  notes: [],
  alternatives: [],
  budgetBytes: 0,
  budgetGb: '0.0',
  budgetSource: 'estimated',
};

const FACTS: HarnessFact[] = [
  { cli: 'opencode', label: 'OpenCode', installed: true, installable: false, acceptsModelId: () => true },
];

/** The install view of a Mac with nothing installed, as the service would answer it. */
const IDLE_VIEW: LocalModelInstallView = {
  state: 'idle',
  running: false,
  developerTools: 'missing',
  runtime: { version: '0.40.15', installed: false, downloadBytes: 185971671, downloadGb: '0.2', unpackedGb: '0.6' },
  folder: '/Users/me/.codeman/local-model',
  library: [],
  harnesses: [],
  actions: ['install'],
};

const INSTALLING_VIEW: LocalModelInstallView = {
  ...IDLE_VIEW,
  state: 'installing',
  step: 'runtime',
  steps: ['runtime', 'model', 'verify', 'agent', 'connect'],
  model: { id: 'qwen3.8:27b', label: 'Qwen3.8 27B' },
  cli: 'opencode',
  cliLabel: 'OpenCode',
  context: 131072,
  actions: ['cancel'],
};

const OK_RESULT: LocalModelVerbResult = { ok: true, view: INSTALLING_VIEW };

type ServiceMock = { [K in keyof LocalModelService]: Mock<LocalModelService[K]> };

/** An install service whose every verb answers `OK_RESULT` and whose view is idle. */
function fakeService(): ServiceMock {
  return {
    view: vi.fn(async () => IDLE_VIEW),
    launchRefusal: vi.fn(async () => undefined),
    launchRefusalMessage: vi.fn(async () => undefined),
    recommendOptions: vi.fn(async () => ({ runtimeDownloadBytes: 185971671 })),
    install: vi.fn(async () => OK_RESULT),
    use: vi.fn(async () => OK_RESULT),
    deleteLibraryModel: vi.fn(async () => OK_RESULT),
    installAgent: vi.fn(async () => OK_RESULT),
    cancel: vi.fn(async () => OK_RESULT),
    resume: vi.fn(async () => OK_RESULT),
    runtime: vi.fn(async () => OK_RESULT),
    remove: vi.fn(async () => OK_RESULT),
    boot: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    onRuntimeChange: vi.fn(),
    idle: vi.fn(async () => {}),
  };
}

interface Fakes {
  deps: LocalModelRouteDeps;
  readHardware: Mock<LocalModelRouteDeps['readHardware']>;
  getCatalog: Mock<LocalModelRouteDeps['getCatalog']>;
  buildHarnessFacts: Mock<LocalModelRouteDeps['buildHarnessFacts']>;
  recommend: Mock<LocalModelRouteDeps['recommend']>;
  service: ServiceMock;
}

function fakes(hardware: HardwareFacts = MAC, recommendation: Recommendation = OK): Fakes {
  const readHardware = vi.fn<LocalModelRouteDeps['readHardware']>(async () => hardware);
  const getCatalog = vi.fn<LocalModelRouteDeps['getCatalog']>(() => CATALOG);
  const buildFacts = vi.fn<LocalModelRouteDeps['buildHarnessFacts']>(async () => FACTS);
  const recommend = vi.fn<LocalModelRouteDeps['recommend']>(() => recommendation);
  const service = fakeService();
  return {
    deps: { readHardware, getCatalog, buildHarnessFacts: buildFacts, recommend, service: () => service },
    readHardware,
    getCatalog,
    buildHarnessFacts: buildFacts,
    recommend,
    service,
  };
}

type AuthUser = { username: string; role: 'admin' | 'user' };

/** The live sessions the DELETE looks at: a name, and for some the endpoint their model comes from. */
type SessionLike = { name: string; customModel?: { endpointId: string } };

const harness = (deps: Partial<LocalModelRouteDeps>, authUser?: AuthUser, sessions: SessionLike[] = []) =>
  createRouteTestHarness(
    (app) =>
      registerLocalModelRoutes(app, { sessions: new Map(sessions.map((session, i) => [`s${i}`, session])) }, deps),
    authUser ? { authUser } : undefined
  );

const get = async (deps: Partial<LocalModelRouteDeps>, authUser?: { username: string; role: 'admin' | 'user' }) => {
  const { app } = await harness(deps, authUser);
  return app.inject({ method: 'GET', url: '/api/local-model' });
};

/** Every file and folder under `root`, with its size and modification time. */
function snapshot(root: string): string[] {
  if (!existsSync(root)) return [];
  const rows: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      rows.push(`${path} ${stat.isDirectory() ? 'dir' : stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
  return rows;
}

afterEach(() => {
  delete process.env.CODEMAN_MULTIUSER;
  vi.restoreAllMocks();
});

describe('GET /api/local-model', () => {
  it('answers the success envelope with the hardware, the recommendation and the catalogue date', async () => {
    const f = fakes();
    const res = await get(f.deps);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { hardware: MAC, recommendation: OK, catalogUpdated: '2026-11-06', install: IDLE_VIEW },
    });
  });

  it('recommends with what the install service knows: the measured budget and the runtime still to download', async () => {
    const f = fakes();
    f.service.recommendOptions.mockResolvedValue({ measuredTotalBytes: 40_157_944_217, runtimeDownloadBytes: 0 });
    await get(f.deps);
    expect(f.service.recommendOptions).toHaveBeenCalledTimes(1);
    expect(f.recommend.mock.calls[0][3]).toEqual({ measuredTotalBytes: 40_157_944_217, runtimeDownloadBytes: 0 });
  });

  it('carries the install view of the service as it is, in every state', async () => {
    const f = fakes();
    f.service.view.mockResolvedValue(INSTALLING_VIEW);
    const res = await get(f.deps);
    expect(res.json().data.install).toEqual(INSTALLING_VIEW);
    expect(f.service.view).toHaveBeenCalledTimes(1);
    // The facts built for the recommendation are the ones the view lists its coding agents
    // from: the availability probe is asked once per answer, not twice.
    expect(f.service.view).toHaveBeenCalledWith({ harnessFacts: FACTS });
    expect(f.buildHarnessFacts).toHaveBeenCalledTimes(1);
    // Looking is not doing: no verb of the service was called.
    for (const verb of [
      'install',
      'installAgent',
      'cancel',
      'resume',
      'runtime',
      'remove',
      'boot',
      'shutdown',
    ] as const) {
      expect(f.service[verb]).not.toHaveBeenCalled();
    }
  });

  it('hands recommend() exactly what the probe, the catalogue and the harness facts answered', async () => {
    const f = fakes();
    await get(f.deps);
    expect(f.readHardware).toHaveBeenCalledTimes(1);
    expect(f.buildHarnessFacts).toHaveBeenCalledTimes(1);
    expect(f.buildHarnessFacts).toHaveBeenCalledWith(CATALOG);
    expect(f.recommend).toHaveBeenCalledTimes(1);
    const [hw, catalog, facts] = f.recommend.mock.calls[0];
    expect(hw).toBe(MAC);
    expect(catalog).toBe(CATALOG);
    expect(facts).toBe(FACTS);
  });

  it('sends the payload as the modules built it: no size is reformatted and no function leaks', async () => {
    const res = await get(fakes().deps);
    const { data } = res.json();
    expect(Object.keys(data).sort()).toEqual(['catalogUpdated', 'hardware', 'install', 'recommendation']);
    expect(data.hardware.memGb).toBe('51.5');
    expect(data.hardware.freeDiskGb).toBe('912');
    expect(data.recommendation.pick.needGb).toBe('29.6');
    expect(data.recommendation.budgetGb).toBe('37.6');
    // Harness facts hold a function and stay on the server.
    expect(res.body).not.toContain('acceptsModelId');
    expect(res.body).not.toContain('installable');
  });

  it('is the only thing a GET does: there is no POST, PUT or PATCH on the same path', async () => {
    const f = fakes();
    const { app } = await harness(f.deps);
    for (const method of ['POST', 'PUT', 'PATCH'] as const) {
      expect((await app.inject({ method, url: '/api/local-model', payload: {} })).statusCode).toBe(404);
    }
    expect(f.service.install).not.toHaveBeenCalled();
  });

  describe('multi-user mode', () => {
    it('refuses a non-admin with 403 before anything is probed', async () => {
      process.env.CODEMAN_MULTIUSER = '1';
      const f = fakes();
      const res = await get(f.deps, { username: 'bob', role: 'user' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
      expect(res.body).not.toContain('Apple M5 Pro');
      expect(f.readHardware).not.toHaveBeenCalled();
      expect(f.getCatalog).not.toHaveBeenCalled();
      expect(f.buildHarnessFacts).not.toHaveBeenCalled();
      expect(f.recommend).not.toHaveBeenCalled();
      expect(f.service.view).not.toHaveBeenCalled();
      expect(f.service.recommendOptions).not.toHaveBeenCalled();
    });

    it('answers an admin', async () => {
      process.env.CODEMAN_MULTIUSER = '1';
      const res = await get(fakes().deps, { username: 'root', role: 'admin' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.hardware.chip).toBe('Apple M5 Pro');
    });

    it('is not gated while multi-user mode is off, whoever asks', async () => {
      const res = await get(fakes().deps, { username: 'bob', role: 'user' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('an unsupported platform is an answer', () => {
    it('answers 200 with verdict none and reason not-macos on a server that is not a Mac', async () => {
      const f = fakes(LINUX, NOT_MACOS);
      const res = await get(f.deps);
      expect(res.statusCode).toBe(200);
      const { success, data } = res.json();
      expect(success).toBe(true);
      expect(data.hardware).toEqual(LINUX);
      expect(data.hardware.source).toBe('not-probed');
      expect(data.recommendation.verdict).toBe('none');
      expect(data.recommendation.reason).toBe('not-macos');
      expect(data.recommendation.pick).toBeUndefined();
      expect(data.recommendation.alternatives).toEqual([]);
      expect(data.recommendation.headline.text).toBe(LOCAL_MODEL_LABELS.noneNotMacos);
      expect(data.catalogUpdated).toBe('2026-11-06');
      expect(f.recommend.mock.calls[0][0]).toBe(LINUX);
    });
  });

  describe('a failed probe is an answer', () => {
    it('answers 200 when the probe reports that sysctl failed (source os-fallback)', async () => {
      const f = fakes(MAC_FALLBACK, OK);
      const res = await get(f.deps);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.hardware).toEqual(MAC_FALLBACK);
      expect(res.json().data.recommendation.verdict).toBe('ok');
    });

    it('answers 200 from node:os when the probe itself rejects, and still recommends', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const f = fakes();
      f.readHardware.mockRejectedValue(new Error('spawn EAGAIN'));
      const res = await get(f.deps);
      expect(res.statusCode).toBe(200);
      const { success, data } = res.json();
      expect(success).toBe(true);
      expect(data.hardware).toEqual(hardwareFromOs());
      expect(data.hardware.memBytes).toBe(totalmem());
      expect(data.recommendation).toEqual(OK);
      expect(f.recommend).toHaveBeenCalledTimes(1);
      expect(f.recommend.mock.calls[0][0]).toEqual(hardwareFromOs());
      expect(String(warn.mock.calls[0][0])).toContain('spawn EAGAIN');
    });

    it('hardwareFromOs() is a complete answer of its own, sized by the one formatter', () => {
      const hw = hardwareFromOs();
      expect(hw.platform).toBe(process.platform);
      expect(hw.arch).toBe(arch());
      expect(hw.memBytes).toBe(totalmem());
      expect(hw.memGb).toBe(formatGb(totalmem()));
      expect(hw.memClassGb).toBe(memClassGb(totalmem()));
      expect(hw.source).toBe(process.platform === 'darwin' ? 'os-fallback' : 'not-probed');
      // Nothing that only sysctl or statfs can know is invented.
      expect(Object.keys(hw).sort()).toEqual(['arch', 'memBytes', 'memClassGb', 'memGb', 'platform', 'source']);
    });

    it('answers 200 when no harness fact could be built (the facts are just empty)', async () => {
      const none: Recommendation = {
        ...NOT_MACOS,
        reason: 'no-harness',
        headline: { text: LOCAL_MODEL_LABELS.noneNoHarness },
      };
      const f = fakes(MAC, none);
      f.buildHarnessFacts.mockResolvedValue([]);
      const res = await get(f.deps);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.recommendation.reason).toBe('no-harness');
      expect(f.recommend.mock.calls[0][2]).toEqual([]);
    });
  });

  describe('a fault that is not a probe is a 500 in the envelope, never a made-up answer', () => {
    it.each([
      [
        'recommend() throws',
        (f: Fakes) =>
          f.recommend.mockImplementation(() => {
            throw new Error('rank table is empty');
          }),
        'rank table is empty',
      ],
      [
        'the catalogue getter throws',
        (f: Fakes) =>
          f.getCatalog.mockImplementation(() => {
            throw new Error('catalogue did not parse');
          }),
        'catalogue did not parse',
      ],
      [
        'the harness facts reject',
        (f: Fakes) => f.buildHarnessFacts.mockRejectedValue(new Error('registry unreadable')),
        'registry unreadable',
      ],
    ])('%s', async (_label, breakIt, message) => {
      const f = fakes();
      breakIt(f);
      const res = await get(f.deps);
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INTERNAL_ERROR');
      expect(body.error).toContain(message);
      expect(body.data).toBeUndefined();
    });
  });

  describe('read-only', () => {
    it('writes nothing: the home directory and the data dir are byte for byte what they were', async () => {
      // The real harness facts (they read the CLI registry and run the availability probe),
      // the REAL install service over the real state file (nothing is installed, so its view
      // is idle), the route's own composition, and a hardware answer and a recommendation of
      // the test's.
      const f = fakes();
      const service = createLocalModelService();
      const { app } = await harness({
        ...f.deps,
        buildHarnessFacts: (catalog) => buildHarnessFacts(catalog),
        service: () => service,
      });

      const home = homedir();
      const before = snapshot(home);
      const dataDirExisted = existsSync(getDataDir());

      for (let i = 0; i < 3; i++) {
        const res = await app.inject({ method: 'GET', url: '/api/local-model' });
        expect(res.statusCode).toBe(200);
        expect(res.json().data.install).toMatchObject({ state: 'idle', running: false, actions: ['install'] });
      }
      // A refused request and a failing one write nothing either.
      f.recommend.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      expect((await app.inject({ method: 'GET', url: '/api/local-model' })).statusCode).toBe(500);

      expect(snapshot(home)).toEqual(before);
      expect(existsSync(getDataDir())).toBe(dataDirExisted);
      expect(existsSync(join(getDataDir(), 'settings.json'))).toBe(false);
      expect(existsSync(join(getDataDir(), 'local-model.json'))).toBe(false);
      expect(existsSync(join(getDataDir(), 'local-models.json'))).toBe(false);
      // The facts really were built from the registry for the catalogue's two harnesses.
      expect(f.recommend.mock.calls[0][2].map((fact) => fact.cli)).toEqual(['opencode', 'claude']);

      // The comparison above is not vacuous: one new file in the home directory shows up.
      const probe = join(home, 'local-model-route-test-probe');
      writeFileSync(probe, 'x');
      try {
        expect(snapshot(home)).not.toEqual(before);
      } finally {
        rmSync(probe);
      }
    });

    it('is registered on the real server through the routes barrel', () => {
      const root = fileURLToPath(new URL('../../', import.meta.url));
      const server = readFileSync(join(root, 'src/web/server.ts'), 'utf8');
      const barrel = readFileSync(join(root, 'src/web/routes/index.ts'), 'utf8');
      expect(barrel).toContain("export { registerLocalModelRoutes } from './local-model-routes.js';");
      // The route context for the live sessions, and no third argument: the server runs the
      // real probe, catalogue, facts, recommend() and install service.
      expect(server).toContain('registerLocalModelRoutes(this.app, ctx);');
    });

    it('the server starts the install service at boot and stops it at shutdown, outside tests only', () => {
      const root = fileURLToPath(new URL('../../', import.meta.url));
      const server = readFileSync(join(root, 'src/web/server.ts'), 'utf8');
      const boot = server.indexOf('void getLocalModelService().boot();');
      const shutdown = server.indexOf('void getLocalModelService().shutdown();');
      expect(boot).toBeGreaterThan(-1);
      expect(shutdown).toBeGreaterThan(-1);
      // Each sits in a block that tests never enter: nothing of the runtime runs under vitest.
      for (const at of [boot, shutdown]) {
        const before = server.slice(0, at).trimEnd();
        expect(before.endsWith('if (!this.testMode) {')).toBe(true);
      }
      // Shutdown stands beside the other supervised child's stop.
      const deepseek = server.indexOf('void stopDeepSeekWeb();');
      expect(deepseek).toBeGreaterThan(-1);
      expect(shutdown).toBeGreaterThan(deepseek);
      expect(shutdown - deepseek).toBeLessThan(700);
    });

    it('the default dependencies are the real modules, read at call time', () => {
      expect(Object.keys(defaultLocalModelRouteDeps).sort()).toEqual([
        'buildHarnessFacts',
        'getCatalog',
        'readHardware',
        'recommend',
        'service',
      ]);
      for (const dep of Object.values(defaultLocalModelRouteDeps)) expect(typeof dep).toBe('function');
      // The one install service of the process, the same object every time.
      expect(defaultLocalModelRouteDeps.service()).toBe(getLocalModelService());
    });
  });
});

describe('the install verbs', () => {
  const INSTALL_BODY = { modelId: 'qwen3.8:27b', cli: 'opencode', context: 131072, acknowledgedBytes: 17926000000 };

  /** Every verb as a request, with a body the route accepts. */
  const VERBS = [
    { name: 'install', method: 'POST', url: '/api/local-model/install', payload: INSTALL_BODY },
    { name: 'use', method: 'POST', url: '/api/local-model/use', payload: { modelId: 'qwen3.8:27b' } },
    {
      name: 'deleteLibraryModel',
      method: 'DELETE',
      url: '/api/local-model/models',
      payload: { modelId: 'qwen3.8:27b' },
    },
    { name: 'installAgent', method: 'POST', url: '/api/local-model/agent', payload: { cli: 'pi' } },
    { name: 'cancel', method: 'POST', url: '/api/local-model/cancel', payload: undefined },
    { name: 'resume', method: 'POST', url: '/api/local-model/resume', payload: {} },
    { name: 'runtime', method: 'POST', url: '/api/local-model/runtime', payload: { action: 'stop' } },
    { name: 'remove', method: 'DELETE', url: '/api/local-model', payload: { removeModel: true } },
  ] as const;

  const call = (app: Awaited<ReturnType<typeof harness>>['app'], verb: (typeof VERBS)[number]) =>
    app.inject({ method: verb.method, url: verb.url, ...(verb.payload ? { payload: verb.payload } : {}) });

  describe.each(VERBS)('$method $url', (verb) => {
    it('answers the view after the verb in the success envelope', async () => {
      const f = fakes();
      const { app } = await harness(f.deps);
      const res = await call(app, verb);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, data: INSTALLING_VIEW });
      expect(f.service[verb.name]).toHaveBeenCalledTimes(1);
    });

    it('multi-user mode: a non-admin is refused with 403 before the service is asked anything', async () => {
      process.env.CODEMAN_MULTIUSER = '1';
      const f = fakes();
      const { app } = await harness(f.deps, { username: 'bob', role: 'user' });
      const res = await call(app, verb);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
      for (const name of ['install', 'cancel', 'resume', 'runtime', 'remove', 'view', 'recommendOptions'] as const) {
        expect(f.service[name]).not.toHaveBeenCalled();
      }
    });

    it('multi-user mode: the gate comes before the body is even parsed', async () => {
      process.env.CODEMAN_MULTIUSER = '1';
      const f = fakes();
      const { app } = await harness(f.deps, { username: 'bob', role: 'user' });
      const res = await app.inject({ method: verb.method, url: verb.url, payload: { nonsense: true } });
      expect(res.statusCode).toBe(403);
    });

    it('multi-user mode: an admin is served', async () => {
      process.env.CODEMAN_MULTIUSER = '1';
      const f = fakes();
      const { app } = await harness(f.deps, { username: 'root', role: 'admin' });
      expect((await call(app, verb)).statusCode).toBe(200);
      expect(f.service[verb.name]).toHaveBeenCalledTimes(1);
    });

    it('is not gated while multi-user mode is off', async () => {
      const f = fakes();
      const { app } = await harness(f.deps, { username: 'bob', role: 'user' });
      expect((await call(app, verb)).statusCode).toBe(200);
    });

    it('a 409 of the service is the error envelope plus the conflict as data', async () => {
      const f = fakes();
      f.service[verb.name].mockResolvedValue({
        ok: false,
        status: 409,
        conflict: { reason: 'job-running', message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictJobRunning } },
      });
      const { app } = await harness(f.deps);
      const res = await call(app, verb);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        success: false,
        error: 'An install is already running.',
        errorCode: 'CONFLICT',
        data: { reason: 'job-running', message: { text: 'An install is already running.' } },
      });
    });

    it('an exception of the service is a 500 in the envelope', async () => {
      const f = fakes();
      f.service[verb.name].mockRejectedValue(new Error('disk on fire'));
      const { app } = await harness(f.deps);
      const res = await call(app, verb);
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ success: false, errorCode: 'INTERNAL_ERROR' });
      expect(res.json().error).toContain('disk on fire');
    });

    it.each([
      ['the endpoint store', new CustomModelHostsWriteRefusedError('custom-model-hosts.json is not a valid JSON list')],
      ['the settings file', new SettingsWriteRefusedError('settings.json is not a valid JSON object')],
    ])('a refused write of %s is a 409 with the fix and no conflict data', async (_label, error) => {
      const f = fakes();
      f.service[verb.name].mockRejectedValue(error);
      const { app } = await harness(f.deps);
      const res = await call(app, verb);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ success: false, error: error.message, errorCode: 'CONFLICT' });
    });
  });

  describe('POST /api/local-model/install', () => {
    it('hands the service the four choices and who asked', async () => {
      const f = fakes();
      const { app } = await harness(f.deps, { username: 'alice', role: 'admin' });
      await app.inject({ method: 'POST', url: '/api/local-model/install', payload: INSTALL_BODY });
      expect(f.service.install).toHaveBeenCalledWith(INSTALL_BODY, { username: 'alice', ip: '127.0.0.1' }, []);
    });

    it('hands the service the names of the live sessions on the model: another model would take the runtime from them', async () => {
      const f = fakes();
      const { app } = await harness(f.deps, undefined, [
        { name: 'w1-app', customModel: { endpointId: 'local-ollama' } },
        { name: 'w2-app' },
        { name: 'w3-lib', customModel: { endpointId: 'office-gpu' } },
      ]);
      await app.inject({ method: 'POST', url: '/api/local-model/install', payload: INSTALL_BODY });
      expect(f.service.install.mock.calls[0][2]).toEqual(['w1-app']);
    });

    it('a row the server does not offer is a 400 with the service own sentence, as text and as data', async () => {
      const f = fakes();
      f.service.install.mockResolvedValue({
        ok: false,
        status: 400,
        message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentNotInstallable, vars: { cli: 'OpenCode' } },
      });
      const { app } = await harness(f.deps);
      const res = await app.inject({ method: 'POST', url: '/api/local-model/install', payload: INSTALL_BODY });
      expect(res.statusCode).toBe(400);
      // `error` is the English sentence with its slots filled; `data.message` is the sentence
      // with its slots apart, which the window prints in its own language.
      expect(res.json()).toEqual({
        success: false,
        error: 'OpenCode is not installed and cannot be installed from here.',
        errorCode: 'INVALID_INPUT',
        data: {
          message: { text: '{cli} is not installed and cannot be installed from here.', vars: { cli: 'OpenCode' } },
        },
      });
    });

    it('a first install on a full disk is a 507 with the sentence, not a 500', async () => {
      const f = fakes();
      f.service.install.mockResolvedValue({
        ok: false,
        status: 507,
        message: { text: LOCAL_MODEL_INSTALL_LABELS.errDiskFull },
      });
      const { app } = await harness(f.deps);
      const res = await app.inject({ method: 'POST', url: '/api/local-model/install', payload: INSTALL_BODY });
      expect(res.statusCode).toBe(507);
      expect(res.json()).toEqual({
        success: false,
        error: 'The disk is full. Free up space, then try again.',
        errorCode: 'OPERATION_FAILED',
        data: { message: { text: 'The disk is full. Free up space, then try again.' } },
      });
    });

    it('consent bound to the size: the 409 carries the server own total, so the window can ask again', async () => {
      const f = fakes();
      f.service.install.mockResolvedValue({
        ok: false,
        status: 409,
        conflict: {
          reason: 'size-changed',
          message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSizeChanged, vars: { size: '23.3' } },
          expectedBytes: 23291770627,
          expectedGb: '23.3',
        },
      });
      const { app } = await harness(f.deps);
      const res = await app.inject({ method: 'POST', url: '/api/local-model/install', payload: INSTALL_BODY });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        success: false,
        error: 'The download is 23.3 GB now. Check the sizes and confirm again.',
        errorCode: 'CONFLICT',
        data: {
          reason: 'size-changed',
          message: {
            text: 'The download is {size} GB now. Check the sizes and confirm again.',
            vars: { size: '23.3' },
          },
          expectedBytes: 23291770627,
          expectedGb: '23.3',
        },
      });
    });

    it.each([
      ['no body', undefined],
      ['a missing size', { modelId: 'qwen3.8:27b', cli: 'opencode', context: 131072 }],
      ['a model id with a registry host in it', { ...INSTALL_BODY, modelId: 'evil.example/x/y:z' }],
      ['a model id without a tag', { ...INSTALL_BODY, modelId: 'qwen3.8' }],
      ['an upper-case model id', { ...INSTALL_BODY, modelId: 'Qwen3.8:27B' }],
      ['a coding agent id with a space', { ...INSTALL_BODY, cli: 'open code' }],
      ['a coding agent id that is a path', { ...INSTALL_BODY, cli: '../bin/sh' }],
      ['a context of zero', { ...INSTALL_BODY, context: 0 }],
      ['a context that is not a whole number', { ...INSTALL_BODY, context: 1.5 }],
      ['a negative size', { ...INSTALL_BODY, acknowledgedBytes: -1 }],
      ['a size as text', { ...INSTALL_BODY, acknowledgedBytes: '17926000000' }],
      ['a member nobody defined', { ...INSTALL_BODY, url: 'https://example.invalid/ollama.tgz' }],
    ])('%s is a 400 before the service is asked', async (_label, payload) => {
      const f = fakes();
      const { app } = await harness(f.deps);
      const res = await app.inject({
        method: 'POST',
        url: '/api/local-model/install',
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
      expect(f.service.install).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/local-model/resume and /runtime', () => {
    it('resume takes no body, an empty one, or newPort', async () => {
      const f = fakes();
      const { app } = await harness(f.deps);
      await app.inject({ method: 'POST', url: '/api/local-model/resume' });
      await app.inject({ method: 'POST', url: '/api/local-model/resume', payload: {} });
      await app.inject({ method: 'POST', url: '/api/local-model/resume', payload: { newPort: true } });
      expect(f.service.resume.mock.calls.map(([body]) => body)).toEqual([{}, {}, { newPort: true }]);
      expect(f.service.resume.mock.calls[0][1]).toEqual({ username: 'admin', ip: '127.0.0.1' });
    });

    it('resume and runtime hand the service the live sessions on the model, read at the moment of the request', async () => {
      const f = fakes();
      const sessions = new Map<string, SessionLike>([
        ['a', { name: 'w1-app', customModel: { endpointId: 'local-ollama' } }],
        ['b', { name: 'w2-app', customModel: { endpointId: 'office-gpu' } }],
      ]);
      const { app } = await createRouteTestHarness((instance) =>
        registerLocalModelRoutes(instance, { sessions }, f.deps)
      );
      await app.inject({ method: 'POST', url: '/api/local-model/runtime', payload: { action: 'stop' } });
      await app.inject({ method: 'POST', url: '/api/local-model/resume', payload: { newPort: true } });
      sessions.delete('a');
      await app.inject({ method: 'POST', url: '/api/local-model/runtime', payload: { action: 'stop' } });
      expect(f.service.runtime.mock.calls.map((args) => args[1])).toEqual([['w1-app'], []]);
      expect(f.service.resume.mock.calls[0][2]).toEqual(['w1-app']);
    });

    it('a stop while a live session uses the model: 409 with the session names', async () => {
      const f = fakes();
      f.service.runtime.mockImplementation(async (_request, names = []) => ({
        ok: false,
        status: 409,
        conflict: {
          reason: 'sessions-open',
          message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSessionsOpen, vars: { sessions: names.join(', ') } },
          sessions: [...names],
        },
      }));
      const { app } = await harness(f.deps, undefined, [
        { name: 'w1-app', customModel: { endpointId: 'local-ollama' } },
      ]);
      const res = await app.inject({ method: 'POST', url: '/api/local-model/runtime', payload: { action: 'stop' } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'CONFLICT',
        error: 'Sessions are still using this model: w1-app. Close them first.',
        data: { reason: 'sessions-open', sessions: ['w1-app'] },
      });
    });

    it('resume refuses a body it does not know', async () => {
      const f = fakes();
      const { app } = await harness(f.deps);
      const res = await app.inject({ method: 'POST', url: '/api/local-model/resume', payload: { port: 80 } });
      expect(res.statusCode).toBe(400);
      expect(f.service.resume).not.toHaveBeenCalled();
    });

    it('runtime takes start or stop, and newPort with it', async () => {
      const f = fakes();
      const { app } = await harness(f.deps);
      await app.inject({
        method: 'POST',
        url: '/api/local-model/runtime',
        payload: { action: 'start', newPort: true },
      });
      await app.inject({ method: 'POST', url: '/api/local-model/runtime', payload: { action: 'stop' } });
      expect(f.service.runtime.mock.calls.map(([body]) => body)).toEqual([
        { action: 'start', newPort: true },
        { action: 'stop' },
      ]);
    });

    it.each([
      ['no body', undefined],
      ['no action', {}],
      ['an action that is neither', { action: 'restart' }],
      ['a port number of the caller own choosing', { action: 'start', port: 22 }],
    ])('runtime with %s is a 400', async (_label, payload) => {
      const f = fakes();
      const { app } = await harness(f.deps);
      const res = await app.inject({
        method: 'POST',
        url: '/api/local-model/runtime',
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(400);
      expect(f.service.runtime).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/local-model', () => {
    const SESSIONS: SessionLike[] = [
      { name: 'w1-app', customModel: { endpointId: 'local-ollama' } },
      { name: 'w2-app' },
      { name: 'w3-lib', customModel: { endpointId: 'office-gpu' } },
      { name: 'w4-lib', customModel: { endpointId: 'local-ollama' } },
    ];

    it('hands the service the names of the live sessions on the model, and who asked', async () => {
      const f = fakes();
      const { app } = await harness(f.deps, undefined, SESSIONS);
      await app.inject({ method: 'DELETE', url: '/api/local-model', payload: { removeModel: true } });
      expect(f.service.remove).toHaveBeenCalledWith({ removeModel: true }, ['w1-app', 'w4-lib'], {
        username: 'admin',
        ip: '127.0.0.1',
      });
    });

    it('without a live session on the model the list is empty, and no body means the model stays', async () => {
      const f = fakes();
      const { app } = await harness(f.deps, undefined, [SESSIONS[1], SESSIONS[2]]);
      const res = await app.inject({ method: 'DELETE', url: '/api/local-model' });
      expect(res.statusCode).toBe(200);
      expect(f.service.remove.mock.calls[0][0]).toEqual({});
      expect(f.service.remove.mock.calls[0][1]).toEqual([]);
    });

    it('the sessions are read at the moment of the request, not when the routes were registered', async () => {
      const f = fakes();
      const sessions = new Map<string, SessionLike>();
      const { app } = await createRouteTestHarness((instance) =>
        registerLocalModelRoutes(instance, { sessions }, f.deps)
      );
      await app.inject({ method: 'DELETE', url: '/api/local-model' });
      sessions.set('late', { name: 'w9-late', customModel: { endpointId: 'local-ollama' } });
      await app.inject({ method: 'DELETE', url: '/api/local-model' });
      expect(f.service.remove.mock.calls.map((args) => args[1])).toEqual([[], ['w9-late']]);
    });

    it('while a live session uses the model: 409 with the session names', async () => {
      const f = fakes();
      f.service.remove.mockImplementation(async (_request, names) => ({
        ok: false,
        status: 409,
        conflict: {
          reason: 'sessions-open',
          message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSessionsOpen, vars: { sessions: names.join(', ') } },
          sessions: [...names],
        },
      }));
      const { app } = await harness(f.deps, undefined, SESSIONS);
      const res = await app.inject({ method: 'DELETE', url: '/api/local-model' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        success: false,
        error: 'Sessions are still using this model: w1-app, w4-lib. Close them first.',
        errorCode: 'CONFLICT',
        data: {
          reason: 'sessions-open',
          message: {
            text: 'Sessions are still using this model: {sessions}. Close them first.',
            vars: { sessions: 'w1-app, w4-lib' },
          },
          sessions: ['w1-app', 'w4-lib'],
        },
      });
    });

    it('refuses a body it does not know', async () => {
      const f = fakes();
      const { app } = await harness(f.deps);
      const res = await app.inject({ method: 'DELETE', url: '/api/local-model', payload: { path: '/' } });
      expect(res.statusCode).toBe(400);
      expect(f.service.remove).not.toHaveBeenCalled();
    });
  });
});

describe('the library verbs', () => {
  const SESSIONS: SessionLike[] = [
    { name: 'w1-app', customModel: { endpointId: 'local-ollama' } },
    { name: 'w2-app' },
    { name: 'w3-lib', customModel: { endpointId: 'office-gpu' } },
  ];

  describe('POST /api/local-model/use', () => {
    it('hands the service the model, who asked and the live sessions on the model', async () => {
      const f = fakes();
      const { app } = await harness(f.deps, { username: 'alice', role: 'admin' }, SESSIONS);
      await app.inject({ method: 'POST', url: '/api/local-model/use', payload: { modelId: 'gpt-oss:20b' } });
      expect(f.service.use).toHaveBeenCalledWith({ modelId: 'gpt-oss:20b' }, { username: 'alice', ip: '127.0.0.1' }, [
        'w1-app',
      ]);
    });

    it('a model that is not one of the checked ones is a 400 with the sentence, as text and as data', async () => {
      const f = fakes();
      f.service.use.mockResolvedValue({
        ok: false,
        status: 400,
        message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedNotInLibrary },
      });
      const { app } = await harness(f.deps);
      const res = await app.inject({ method: 'POST', url: '/api/local-model/use', payload: { modelId: 'x:1b' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        success: false,
        error: 'This model is not one of the checked models on this Mac.',
        errorCode: 'INVALID_INPUT',
        data: { message: { text: 'This model is not one of the checked models on this Mac.' } },
      });
    });

    it.each([
      ['no body', undefined],
      ['no model', {}],
      ['a path', { modelId: '../../etc/passwd' }],
      ['another registry', { modelId: 'hf.co/someone/model:Q4' }],
      ['a member it does not know', { modelId: 'gpt-oss:20b', context: 65536 }],
    ])('refuses %s before the service is asked', async (_name, payload) => {
      const f = fakes();
      const { app } = await harness(f.deps);
      const res = await app.inject({ method: 'POST', url: '/api/local-model/use', ...(payload ? { payload } : {}) });
      expect(res.statusCode).toBe(400);
      expect(f.service.use).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/local-model/agent', () => {
    it('hands the service the coding agent and who asked, and looks at no session', async () => {
      const f = fakes();
      const { app } = await harness(f.deps, { username: 'alice', role: 'admin' }, SESSIONS);
      await app.inject({ method: 'POST', url: '/api/local-model/agent', payload: { cli: 'pi' } });
      // Nothing about the model in use changes, so live sessions on it do not matter.
      expect(f.service.installAgent).toHaveBeenCalledWith({ cli: 'pi' }, { username: 'alice', ip: '127.0.0.1' });
    });

    it('an agent the server does not offer is a 400 with the sentence, as text and as data', async () => {
      const f = fakes();
      f.service.installAgent.mockResolvedValue({
        ok: false,
        status: 400,
        message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentNotInstallable, vars: { cli: 'DeepSeek' } },
      });
      const { app } = await harness(f.deps);
      const res = await app.inject({ method: 'POST', url: '/api/local-model/agent', payload: { cli: 'deepseek' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        success: false,
        error: 'DeepSeek is not installed and cannot be installed from here.',
        errorCode: 'INVALID_INPUT',
        data: {
          message: {
            text: '{cli} is not installed and cannot be installed from here.',
            vars: { cli: 'DeepSeek' },
          },
        },
      });
    });

    it('an installer that already runs is a 409 with the reason', async () => {
      const f = fakes();
      f.service.installAgent.mockResolvedValue({
        ok: false,
        status: 409,
        conflict: { reason: 'job-running', message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictJobRunning } },
      });
      const { app } = await harness(f.deps);
      const res = await app.inject({ method: 'POST', url: '/api/local-model/agent', payload: { cli: 'pi' } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ success: false, errorCode: 'CONFLICT', data: { reason: 'job-running' } });
    });

    it.each([
      ['no body', undefined],
      ['no agent', {}],
      ['a command', { cli: 'pi; curl evil | bash' }],
      ['a path', { cli: '../bin/sh' }],
      ['an upper-case id', { cli: 'Pi' }],
      ['a command of its own', { cli: 'pi', command: 'npm install -g evil' }],
    ])('refuses %s before the service is asked', async (_name, payload) => {
      const f = fakes();
      const { app } = await harness(f.deps);
      const res = await app.inject({ method: 'POST', url: '/api/local-model/agent', ...(payload ? { payload } : {}) });
      expect(res.statusCode).toBe(400);
      expect(f.service.installAgent).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/local-model/models', () => {
    it('hands the service the model name and who asked', async () => {
      const f = fakes();
      const { app } = await harness(f.deps, { username: 'alice', role: 'admin' });
      await app.inject({ method: 'DELETE', url: '/api/local-model/models', payload: { modelId: 'gpt-oss:20b' } });
      expect(f.service.deleteLibraryModel).toHaveBeenCalledWith(
        { modelId: 'gpt-oss:20b' },
        { username: 'alice', ip: '127.0.0.1' }
      );
      // The whole installation is another route: it was not asked.
      expect(f.service.remove).not.toHaveBeenCalled();
    });

    it.each([
      ['no body', undefined],
      ['a path', { modelId: '/Users/me/.codeman/local-model/models' }],
      ['a path that climbs', { modelId: '../../etc/passwd' }],
      ['a name with a slash', { modelId: 'library/qwen3.8:27b' }],
      ['a name without a tag', { modelId: 'qwen3.8' }],
      ['a path member', { modelId: 'gpt-oss:20b', path: '/' }],
    ])('takes a model name and nothing else: refuses %s', async (_name, payload) => {
      const f = fakes();
      const { app } = await harness(f.deps);
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/local-model/models',
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(400);
      expect(f.service.deleteLibraryModel).not.toHaveBeenCalled();
    });

    it('the model in use: 409 with the reason and the sentence', async () => {
      const f = fakes();
      f.service.deleteLibraryModel.mockResolvedValue({
        ok: false,
        status: 409,
        conflict: {
          reason: 'model-active',
          message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictModelActive, vars: { model: 'Qwen3.8 27B' } },
        },
      });
      const { app } = await harness(f.deps);
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/local-model/models',
        payload: { modelId: 'qwen3.8:27b' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        success: false,
        error: 'Qwen3.8 27B is the model in use. Switch to another model first, or remove the local model.',
        errorCode: 'CONFLICT',
        data: {
          reason: 'model-active',
          message: {
            text: '{model} is the model in use. Switch to another model first, or remove the local model.',
            vars: { model: 'Qwen3.8 27B' },
          },
        },
      });
    });

    it('a runtime that did not delete it: 500 with the sentence, as text and as data', async () => {
      const f = fakes();
      f.service.deleteLibraryModel.mockResolvedValue({
        ok: false,
        status: 500,
        message: { text: LOCAL_MODEL_INSTALL_LABELS.deleteFailed, vars: { model: 'GPT-OSS 20B' } },
      });
      const { app } = await harness(f.deps);
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/local-model/models',
        payload: { modelId: 'gpt-oss:20b' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        success: false,
        error: 'GPT-OSS 20B could not be deleted from this Mac.',
        errorCode: 'OPERATION_FAILED',
        data: { message: { text: '{model} could not be deleted from this Mac.', vars: { model: 'GPT-OSS 20B' } } },
      });
    });
  });

  describe('GET /api/local-model marks the rows that are already on this Mac', () => {
    it('the model in use and a model a switch can take, at the context they were checked with', async () => {
      const second = { ...OK.pick!, modelId: 'gpt-oss:20b', modelLabel: 'GPT-OSS 20B', context: 65536 };
      const third = { ...OK.pick!, modelId: 'mimo-v2.6:9b-q4_k_m', modelLabel: 'MiMo V2.6 9B' };
      const f = fakes(MAC, { ...OK, alternatives: [second, third] });
      const row = (id: string, context: number, active: boolean) => ({
        id,
        label: id,
        context,
        active,
        verified: true,
        status: 'ready' as const,
        actions: active ? [] : ['use' as const],
      });
      f.service.view.mockResolvedValue({
        ...IDLE_VIEW,
        state: 'installed',
        library: [row(OK.pick!.modelId, OK.pick!.context, true), row('gpt-oss:20b', 65536, false)],
        actions: ['start-session', 'stop', 'install', 'use', 'remove'],
      });
      const data = (await get(f.deps)).json().data;
      expect(data.recommendation.pick.library).toBe('active');
      expect(data.recommendation.alternatives[0].library).toBe('ready');
      expect(data.recommendation.alternatives[1]).not.toHaveProperty('library');
      // What recommend() answered is not written to.
      expect(OK.pick).not.toHaveProperty('library');
    });

    it('with nothing on this Mac no row carries the mark', async () => {
      const data = (await get(fakes().deps)).json().data;
      expect(data.recommendation.pick).not.toHaveProperty('library');
    });
  });
});

describe('the routes over the real install service', () => {
  const STATE = () => dataPath('local-model.json');

  afterEach(() => {
    rmSync(STATE(), { force: true });
  });

  /** The real service with the real state file. Only the hardware is the test's: a server that is not a Mac. */
  function realService(): LocalModelService {
    return createLocalModelService({ readHardware: async () => LINUX });
  }

  it('on a server that is not a Mac nothing can be installed: the install is a 400 and nothing is written', async () => {
    const service = realService();
    const { app } = await harness({ readHardware: async () => LINUX, service: () => service });
    const res = await app.inject({
      method: 'POST',
      url: '/api/local-model/install',
      payload: { modelId: 'qwen3.6:35b-a3b', cli: 'opencode', context: 131072, acknowledgedBytes: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(existsSync(STATE())).toBe(false);
    const get = await app.inject({ method: 'GET', url: '/api/local-model' });
    expect(get.json().data.install).toMatchObject({ state: 'idle', actions: ['install'] });
    expect(get.json().data.recommendation).toMatchObject({ verdict: 'none', reason: 'not-macos' });
  });

  it('with nothing installed: cancel, resume and a runtime action are 409 wrong-state', async () => {
    const service = realService();
    const { app } = await harness({ service: () => service });
    for (const [url, payload] of [
      ['/api/local-model/cancel', undefined],
      ['/api/local-model/resume', {}],
      ['/api/local-model/runtime', { action: 'start' }],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, ...(payload ? { payload } : {}) });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        success: false,
        errorCode: 'CONFLICT',
        error: 'That is not possible in the current state.',
        data: { reason: 'wrong-state' },
      });
    }
    expect(existsSync(STATE())).toBe(false);
  });

  it('a job the state file still calls installing comes back paused on the first GET of a new server', async () => {
    writeFileSync(
      STATE(),
      JSON.stringify({
        schema: 1,
        state: 'installing',
        step: 'model',
        steps: ['runtime', 'model', 'verify', 'agent', 'connect'],
        model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', context: 131072 },
        cli: { id: 'opencode', label: 'OpenCode' },
        runtime: { version: '0.40.15', port: 11435, enabled: true },
        progress: { completedBytes: 6200000000, totalBytes: 23105798956 },
      })
    );
    const service = realService();
    const { app } = await harness({ readHardware: async () => LINUX, service: () => service });
    const res = await app.inject({ method: 'GET', url: '/api/local-model' });
    expect(res.json().data.install).toMatchObject({
      state: 'paused',
      step: 'model',
      running: false,
      model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B' },
      cli: 'opencode',
      port: 11435,
      progress: { completedBytes: 6200000000, totalBytes: 23105798956, completedGb: '6.2', totalGb: '23.1' },
      actions: ['resume', 'install', 'remove'],
    });
    expect(JSON.parse(readFileSync(STATE(), 'utf8')).state).toBe('paused');
    // A second install while that job is only paused is refused for what it asks, not started.
    const cancel = await app.inject({ method: 'POST', url: '/api/local-model/cancel' });
    expect(cancel.statusCode).toBe(409);
  });
});
