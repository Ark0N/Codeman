/**
 * @fileoverview GET /api/local-model: what this Mac is and which local model fits it.
 *
 * The route only composes four injected functions (the hardware probe, the catalogue getter,
 * the harness facts and the pure `recommend()`), so every test passes its own and no test
 * depends on what those modules compute. What is pinned here is the route's own contract:
 * the envelope, the admin gate in multi-user mode, that an unsupported platform and a failed
 * probe are answers (200) and never a 500, what does answer 500, and that a request writes
 * nothing.
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
import { getDataDir } from '../../src/config/instance.js';
import {
  LOCAL_MODEL_LABELS,
  type HardwareFacts,
  type HarnessFact,
  type LocalModelCatalog,
  type Recommendation,
} from '../../src/types.js';

const CATALOG: LocalModelCatalog = {
  schema: 1,
  updated: '2026-11-06',
  minMacosMajor: 14,
  promptCacheTiers: [
    { minMemGb: 0, bytes: 512 * 1024 * 1024 },
    { minMemGb: 32, bytes: 2 * 1024 ** 3 },
  ],
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

interface Fakes {
  deps: LocalModelRouteDeps;
  readHardware: Mock<LocalModelRouteDeps['readHardware']>;
  getCatalog: Mock<LocalModelRouteDeps['getCatalog']>;
  buildHarnessFacts: Mock<LocalModelRouteDeps['buildHarnessFacts']>;
  recommend: Mock<LocalModelRouteDeps['recommend']>;
}

function fakes(hardware: HardwareFacts = MAC, recommendation: Recommendation = OK): Fakes {
  const readHardware = vi.fn<LocalModelRouteDeps['readHardware']>(async () => hardware);
  const getCatalog = vi.fn<LocalModelRouteDeps['getCatalog']>(() => CATALOG);
  const buildFacts = vi.fn<LocalModelRouteDeps['buildHarnessFacts']>(async () => FACTS);
  const recommend = vi.fn<LocalModelRouteDeps['recommend']>(() => recommendation);
  return {
    deps: { readHardware, getCatalog, buildHarnessFacts: buildFacts, recommend },
    readHardware,
    getCatalog,
    buildHarnessFacts: buildFacts,
    recommend,
  };
}

const harness = (deps: Partial<LocalModelRouteDeps>, authUser?: { username: string; role: 'admin' | 'user' }) =>
  createRouteTestHarness((app) => registerLocalModelRoutes(app, deps), authUser ? { authUser } : undefined);

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
      data: { hardware: MAC, recommendation: OK, catalogUpdated: '2026-11-06' },
    });
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
    expect(Object.keys(data).sort()).toEqual(['catalogUpdated', 'hardware', 'recommendation']);
    expect(data.hardware.memGb).toBe('51.5');
    expect(data.hardware.freeDiskGb).toBe('912');
    expect(data.recommendation.pick.needGb).toBe('29.6');
    expect(data.recommendation.budgetGb).toBe('37.6');
    // Harness facts hold a function and stay on the server.
    expect(res.body).not.toContain('acceptsModelId');
    expect(res.body).not.toContain('installable');
  });

  it('registers a GET and nothing else: this stage has no route that changes anything', async () => {
    const { app } = await harness(fakes().deps);
    expect((await app.inject({ method: 'POST', url: '/api/local-model', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/local-model' })).statusCode).toBe(404);
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
      // the route's own composition, and a hardware answer and a recommendation of the test's.
      const f = fakes();
      const { app } = await harness({ ...f.deps, buildHarnessFacts: (catalog) => buildHarnessFacts(catalog) });

      const home = homedir();
      const before = snapshot(home);
      const dataDirExisted = existsSync(getDataDir());

      for (let i = 0; i < 3; i++) {
        const res = await app.inject({ method: 'GET', url: '/api/local-model' });
        expect(res.statusCode).toBe(200);
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
      // No second argument: the server runs the real probe, catalogue, facts and recommend().
      expect(server).toContain('registerLocalModelRoutes(this.app);');
    });

    it('the default dependencies are the real modules, read at call time', () => {
      expect(Object.keys(defaultLocalModelRouteDeps).sort()).toEqual([
        'buildHarnessFacts',
        'getCatalog',
        'readHardware',
        'recommend',
      ]);
      for (const dep of Object.values(defaultLocalModelRouteDeps)) expect(typeof dep).toBe('function');
    });
  });
});
