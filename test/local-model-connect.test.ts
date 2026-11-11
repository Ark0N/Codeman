/**
 * @fileoverview Connecting the installed local model to Codeman and undoing it
 * (src/local-model/connect.ts): the two writes outside the local model folder.
 *
 * What is pinned:
 *  - the endpoint record's exact shape, and that it passes the schema every saved endpoint passes;
 *  - connecting writes the record and switches the settings flag on, keeps every other
 *    endpoint and setting, and is idempotent;
 *  - the reserved id is never taken over: a record with it that is not ours refuses the
 *    connect and changes nothing;
 *  - a refused write leaves the pair as it was (a record this call added is taken out again);
 *  - disconnecting removes our record, and restores the flag ONLY when this feature switched
 *    it on and no other endpoint is saved;
 *  - the digest comparison, the session names of the DELETE's 409, the managed-record test,
 *    and that the runtime's private key cannot be served.
 *
 * Port: N/A (no server; the two files live in the test's temp data dir).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataPath, getDataDir } from '../src/config/instance.js';
import { customModelHostsPath, readCustomModelHosts, type CustomModelHost } from '../src/custom-model-hosts.js';
import {
  buildLocalEndpointRecord,
  compareModelDigest,
  connectLocalModel,
  disconnectLocalModel,
  ensureLocalEndpoint,
  inspectLocalEndpoint,
  isLocalModelEndpointId,
  isManagedLocalEndpoint,
  isSameLocalEndpoint,
  LOCAL_MODEL_ENDPOINT_ID,
  LOCAL_MODEL_ENDPOINT_LABEL,
  moveLocalEndpoint,
  sessionNamesUsingEndpoint,
} from '../src/local-model/connect.js';
import { CustomModelHostSchema } from '../src/web/schemas.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import { isSensitivePath } from '../src/web/sensitive-path.js';

const HOSTS = () => customModelHostsPath(getDataDir());
const STATE = () => dataPath('local-model.json');

const INPUT = { port: 11435, modelId: 'qwen3.6:35b-a3b', context: 131072 };

const OTHER: CustomModelHost = {
  id: 'office-gpu',
  label: 'Office GPU',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'sk-keep-me',
  models: ['some-model'],
};

const RECORD: CustomModelHost = {
  id: 'local-ollama',
  label: 'This Mac',
  baseUrl: 'http://127.0.0.1:11435',
  authStyle: 'bearer',
  models: ['qwen3.6:35b-a3b'],
  defaultModelId: 'qwen3.6:35b-a3b',
  defaultContextLength: 131072,
};

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
}

const readSettings = (): Record<string, unknown> => JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));

function writeHosts(hosts: CustomModelHost[]): void {
  writeFileSync(HOSTS(), JSON.stringify(hosts));
}

afterEach(() => {
  rmSync(HOSTS(), { force: true });
  rmSync(SETTINGS_PATH, { force: true });
  rmSync(STATE(), { force: true });
  vi.restoreAllMocks();
});

describe('buildLocalEndpointRecord', () => {
  it('is the one record this feature writes, to the letter', () => {
    expect(LOCAL_MODEL_ENDPOINT_ID).toBe('local-ollama');
    expect(LOCAL_MODEL_ENDPOINT_LABEL).toBe('This Mac');
    expect(buildLocalEndpointRecord(INPUT)).toEqual(RECORD);
  });

  it('carries no API key and no field of its own invention', () => {
    expect(Object.keys(buildLocalEndpointRecord(INPUT)).sort()).toEqual([
      'authStyle',
      'baseUrl',
      'defaultContextLength',
      'defaultModelId',
      'id',
      'label',
      'models',
    ]);
  });

  it('passes the schema a saved endpoint must pass, unchanged', () => {
    const parsed = CustomModelHostSchema.safeParse(buildLocalEndpointRecord(INPUT));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(RECORD);
  });

  it('the port of the runtime is the port of the URL, and the chosen context is the default context', () => {
    const record = buildLocalEndpointRecord({ port: 11442, modelId: 'gpt-oss:20b', context: 65536 });
    expect(record.baseUrl).toBe('http://127.0.0.1:11442');
    expect(record.models).toEqual(['gpt-oss:20b']);
    expect(record.defaultModelId).toBe('gpt-oss:20b');
    expect(record.defaultContextLength).toBe(65536);
  });
});

describe('connectLocalModel', () => {
  it('on a fresh data dir: writes the record, switches the flag on, and reports that it was off', async () => {
    const result = await connectLocalModel({ ...INPUT, ours: false });
    expect(result).toEqual({ ok: true, flagWasEnabled: false });
    expect(await readCustomModelHosts(getDataDir())).toEqual([RECORD]);
    expect(readSettings()).toEqual({ customModelEndpointsEnabled: true });
  });

  it('keeps every other endpoint and every other setting', async () => {
    writeHosts([OTHER]);
    writeSettings({ tmuxHistoryLimit: 5000, customModelEndpointsEnabled: false, voiceSettings: { apiKey: 'dg' } });
    const result = await connectLocalModel({ ...INPUT, ours: false });
    expect(result).toEqual({ ok: true, flagWasEnabled: false });
    expect(await readCustomModelHosts(getDataDir())).toEqual([OTHER, RECORD]);
    expect(readSettings()).toEqual({
      tmuxHistoryLimit: 5000,
      customModelEndpointsEnabled: true,
      voiceSettings: { apiKey: 'dg' },
    });
  });

  it('a flag that was already on is reported as such and the settings file is not rewritten', async () => {
    writeSettings({ customModelEndpointsEnabled: true, caseOrder: ['a'] });
    const before = readFileSync(SETTINGS_PATH, 'utf8');
    const result = await connectLocalModel({ ...INPUT, ours: false });
    expect(result).toEqual({ ok: true, flagWasEnabled: true });
    expect(readFileSync(SETTINGS_PATH, 'utf8')).toBe(before);
  });

  it('is idempotent: a second connect replaces our record and hands the first flag value back', async () => {
    writeHosts([OTHER]);
    const first = await connectLocalModel({ ...INPUT, ours: false });
    expect(first).toEqual({ ok: true, flagWasEnabled: false });
    // The second connect finds the flag ON, because the first switched it on. The value that
    // is remembered must stay the one from before this feature touched it.
    const second = await connectLocalModel({ ...INPUT, context: 65536, ours: true, flagWasEnabled: false });
    expect(second).toEqual({ ok: true, flagWasEnabled: false });
    const hosts = await readCustomModelHosts(getDataDir());
    expect(hosts.map((host) => host.id)).toEqual(['office-gpu', 'local-ollama']);
    expect(hosts[1].defaultContextLength).toBe(65536);
  });

  it('replaces our own record in place when the state says it is ours', async () => {
    writeHosts([{ ...RECORD, baseUrl: 'http://127.0.0.1:11440', models: ['old:1b'] }, OTHER]);
    const result = await connectLocalModel({ ...INPUT, ours: true, flagWasEnabled: true });
    expect(result).toEqual({ ok: true, flagWasEnabled: true });
    expect(await readCustomModelHosts(getDataDir())).toEqual([RECORD, OTHER]);
  });

  it('never takes over a record with the reserved id that is not ours, and changes nothing', async () => {
    const theirs: CustomModelHost = { id: 'local-ollama', label: 'My own Ollama', baseUrl: 'http://127.0.0.1:11434' };
    writeHosts([theirs]);
    writeSettings({ customModelEndpointsEnabled: false });
    const hostsBefore = readFileSync(HOSTS(), 'utf8');
    const settingsBefore = readFileSync(SETTINGS_PATH, 'utf8');
    const result = await connectLocalModel({ ...INPUT, ours: false });
    expect(result).toEqual({ ok: false, code: 'endpoint-id-taken' });
    expect(readFileSync(HOSTS(), 'utf8')).toBe(hostsBefore);
    expect(readFileSync(SETTINGS_PATH, 'utf8')).toBe(settingsBefore);
  });

  it('an endpoint store that does not parse is connect-failed: neither file is touched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(HOSTS(), '[{"id":"x","apiKey":"sk-secret"},');
    writeSettings({ customModelEndpointsEnabled: false });
    const result = await connectLocalModel({ ...INPUT, ours: false });
    expect(result).toMatchObject({ ok: false, code: 'connect-failed' });
    expect(result.ok === false && result.detail).toContain('custom-model-hosts.json');
    expect(result.ok === false && result.detail).not.toContain('sk-secret');
    expect(readFileSync(HOSTS(), 'utf8')).toBe('[{"id":"x","apiKey":"sk-secret"},');
    expect(readSettings()).toEqual({ customModelEndpointsEnabled: false });
  });

  it('a settings file that does not parse is connect-failed, and the record just added is taken out again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeHosts([OTHER]);
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, '{"customModelEndpointsEnabled":');
    const result = await connectLocalModel({ ...INPUT, ours: false });
    expect(result).toMatchObject({ ok: false, code: 'connect-failed' });
    expect(result.ok === false && result.detail).toContain('settings.json');
    // The pair is not left half done: a later attempt starts from the same place.
    expect(await readCustomModelHosts(getDataDir())).toEqual([OTHER]);
    expect(readFileSync(SETTINGS_PATH, 'utf8')).toBe('{"customModelEndpointsEnabled":');
  });

  it('a settings failure does not take out a record that was ours before this call', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeHosts([RECORD]);
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, 'not json');
    const result = await connectLocalModel({ ...INPUT, ours: true, flagWasEnabled: false });
    expect(result).toMatchObject({ ok: false, code: 'connect-failed' });
    expect(await readCustomModelHosts(getDataDir())).toEqual([RECORD]);
  });

  it('a port that cannot be a URL is connect-failed before anything is written', async () => {
    const result = await connectLocalModel({ port: Number.NaN, modelId: 'x:y', context: 131072, ours: false });
    expect(result).toMatchObject({ ok: false, code: 'connect-failed' });
    expect(existsSync(HOSTS())).toBe(false);
    expect(existsSync(SETTINGS_PATH)).toBe(false);
  });
});

describe('moveLocalEndpoint', () => {
  it('moves our record to the new port and keeps everything else of it', async () => {
    writeHosts([OTHER, RECORD]);
    await moveLocalEndpoint(11441);
    expect(await readCustomModelHosts(getDataDir())).toEqual([OTHER, { ...RECORD, baseUrl: 'http://127.0.0.1:11441' }]);
  });

  it('a missing record is not an error and creates no file', async () => {
    await moveLocalEndpoint(11441);
    expect(existsSync(HOSTS())).toBe(false);
    writeHosts([OTHER]);
    await moveLocalEndpoint(11441);
    expect(await readCustomModelHosts(getDataDir())).toEqual([OTHER]);
  });
});

describe('ensureLocalEndpoint', () => {
  it('puts our record back when it is gone, keeps the other endpoints, and does not touch the settings', async () => {
    writeHosts([OTHER]);
    writeSettings({ customModelEndpointsEnabled: false });
    expect(await ensureLocalEndpoint(INPUT)).toBe(true);
    expect(await readCustomModelHosts(getDataDir())).toEqual([OTHER, RECORD]);
    // A person who switched the setting off meant to.
    expect(readSettings()).toEqual({ customModelEndpointsEnabled: false });
  });

  it('never replaces a record that is there, ours or not', async () => {
    const theirs: CustomModelHost = { id: 'local-ollama', label: 'Edited', baseUrl: 'http://127.0.0.1:11499' };
    writeHosts([theirs]);
    const before = readFileSync(HOSTS(), 'utf8');
    expect(await ensureLocalEndpoint(INPUT)).toBe(false);
    expect(readFileSync(HOSTS(), 'utf8')).toBe(before);
  });

  it('never throws: a store that does not parse is left alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(HOSTS(), '{broken');
    expect(await ensureLocalEndpoint(INPUT)).toBe(false);
    expect(readFileSync(HOSTS(), 'utf8')).toBe('{broken');
  });
});

describe('disconnectLocalModel', () => {
  it('removes our record and switches the flag off again when this feature switched it on and no other endpoint is left', async () => {
    writeHosts([RECORD]);
    writeSettings({ customModelEndpointsEnabled: true, tmuxHistoryLimit: 5000 });
    await disconnectLocalModel({ flagWasEnabled: false });
    expect(await readCustomModelHosts(getDataDir())).toEqual([]);
    expect(readSettings()).toEqual({ customModelEndpointsEnabled: false, tmuxHistoryLimit: 5000 });
  });

  it('leaves the flag on when it was on before this feature', async () => {
    writeHosts([RECORD]);
    writeSettings({ customModelEndpointsEnabled: true });
    await disconnectLocalModel({ flagWasEnabled: true });
    expect(await readCustomModelHosts(getDataDir())).toEqual([]);
    expect(readSettings()).toEqual({ customModelEndpointsEnabled: true });
  });

  it('leaves the flag on when another endpoint is still saved, although this feature switched it on', async () => {
    writeHosts([OTHER, RECORD]);
    writeSettings({ customModelEndpointsEnabled: true });
    await disconnectLocalModel({ flagWasEnabled: false });
    expect(await readCustomModelHosts(getDataDir())).toEqual([OTHER]);
    expect(readSettings()).toEqual({ customModelEndpointsEnabled: true });
  });

  it('leaves the flag on when it was on before AND another endpoint is saved', async () => {
    writeHosts([RECORD, OTHER]);
    writeSettings({ customModelEndpointsEnabled: true });
    await disconnectLocalModel({ flagWasEnabled: true });
    expect(readSettings()).toEqual({ customModelEndpointsEnabled: true });
  });

  it('is idempotent: a second call changes nothing, and a flag somebody switched off stays off', async () => {
    writeHosts([RECORD]);
    writeSettings({ customModelEndpointsEnabled: true });
    await disconnectLocalModel({ flagWasEnabled: false });
    const hosts = readFileSync(HOSTS(), 'utf8');
    const settings = readFileSync(SETTINGS_PATH, 'utf8');
    await disconnectLocalModel({ flagWasEnabled: false });
    expect(readFileSync(HOSTS(), 'utf8')).toBe(hosts);
    expect(readFileSync(SETTINGS_PATH, 'utf8')).toBe(settings);
  });

  it('with nothing saved at all it writes neither file', async () => {
    await disconnectLocalModel({ flagWasEnabled: false });
    expect(existsSync(HOSTS())).toBe(false);
    expect(existsSync(SETTINGS_PATH)).toBe(false);
  });

  it('rejects when the endpoint store must not be overwritten, and leaves the flag alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(HOSTS(), '{broken');
    writeSettings({ customModelEndpointsEnabled: true });
    await expect(disconnectLocalModel({ flagWasEnabled: false })).rejects.toThrow('custom-model-hosts.json');
    expect(readSettings()).toEqual({ customModelEndpointsEnabled: true });
  });

  it('connect then disconnect leaves the data dir as it was found', async () => {
    writeHosts([OTHER]);
    writeSettings({ customModelEndpointsEnabled: true, caseOrder: ['a', 'b'] });
    const connected = await connectLocalModel({ ...INPUT, ours: false });
    expect(connected).toEqual({ ok: true, flagWasEnabled: true });
    await disconnectLocalModel({ flagWasEnabled: true });
    expect(await readCustomModelHosts(getDataDir())).toEqual([OTHER]);
    expect(readSettings()).toEqual({ customModelEndpointsEnabled: true, caseOrder: ['a', 'b'] });
  });
});

describe('the reserved id and the managed record', () => {
  it('isLocalModelEndpointId is an exact match', () => {
    expect(isLocalModelEndpointId('local-ollama')).toBe(true);
    for (const id of ['Local-Ollama', 'local-ollama ', 'local-ollama-2', 'ollama', '']) {
      expect(isLocalModelEndpointId(id)).toBe(false);
    }
  });

  it('a record with the reserved id is managed only while the state file records it as ours', async () => {
    // No state file: somebody made that record by hand.
    expect(await isManagedLocalEndpoint('local-ollama')).toBe(false);
    const installed = {
      schema: 1,
      state: 'installed',
      model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', context: 131072 },
      cli: { id: 'opencode', label: 'OpenCode' },
      runtime: { version: '0.40.15', port: 11435, enabled: true },
    };
    writeFileSync(STATE(), JSON.stringify(installed));
    expect(await isManagedLocalEndpoint('local-ollama')).toBe(false);
    writeFileSync(
      STATE(),
      JSON.stringify({ ...installed, connection: { endpointId: 'local-ollama', flagWasEnabled: false } })
    );
    expect(await isManagedLocalEndpoint('local-ollama')).toBe(true);
    // Any other id is never managed, whatever the state file says.
    expect(await isManagedLocalEndpoint('office-gpu')).toBe(false);
  });
});

describe('sessionNamesUsingEndpoint', () => {
  const sessions = [
    { name: 'w1-app', customModel: { endpointId: 'local-ollama' } },
    { name: 'w2-app' },
    { name: 'w3-lib', customModel: { endpointId: 'office-gpu' } },
    { name: 'w4-lib', customModel: { endpointId: 'local-ollama' } },
  ];

  it('names the sessions on our endpoint, in the order given', () => {
    expect(sessionNamesUsingEndpoint(sessions)).toEqual(['w1-app', 'w4-lib']);
  });

  it('takes any iterable and another endpoint id', () => {
    expect(sessionNamesUsingEndpoint(new Set(sessions), 'office-gpu')).toEqual(['w3-lib']);
    expect(sessionNamesUsingEndpoint(new Map().values())).toEqual([]);
  });

  // Seen on a Mac: a worker the codeman skill started has no name, and the refusal read
  // "Sessions are still using this model: . Close them first."
  it('names a session without a name the way its tab does: the folder, else the short id', () => {
    const ours = { endpointId: 'local-ollama' };
    expect(
      sessionNamesUsingEndpoint([
        {
          id: '7dbd7b0d-0000-4000-8000-000000000001',
          name: '',
          workingDir: '/Users/x/codeman-cases/summaries',
          customModel: ours,
        },
        {
          id: 'a030dddb-0000-4000-8000-000000000002',
          name: '   ',
          workingDir: '/Users/x/codeman-cases/review/',
          customModel: ours,
        },
        { id: 'c1d2e3f4-0000-4000-8000-000000000003', name: '', workingDir: '', customModel: ours },
        { id: 'ffffffff-0000-4000-8000-000000000004', name: 'w1-app', workingDir: '/Users/x/app', customModel: ours },
      ])
    ).toEqual(['summaries', 'review', 'c1d2e3f4', 'w1-app']);
  });
});

describe('compareModelDigest', () => {
  const digest = '0ce5ff81f9ffdf89dd8192ca7b5d34cefd8996a875b3aaaaafaf5c4813569eba';

  it('same digest, same model', () => {
    expect(compareModelDigest(digest, digest)).toBe('same');
  });

  it('a prefix or another letter case is not a change', () => {
    expect(compareModelDigest(digest, `sha256:${digest}`)).toBe('same');
    expect(compareModelDigest(digest.toUpperCase(), ` ${digest} `)).toBe('same');
  });

  it('another digest under the same name is a change', () => {
    expect(compareModelDigest(digest, digest.replace(/^0/, '1'))).toBe('changed');
    expect(compareModelDigest(digest, digest.slice(0, 12))).toBe('changed');
  });

  it('is unknown when either side is absent or empty', () => {
    expect(compareModelDigest(undefined, digest)).toBe('unknown');
    expect(compareModelDigest(digest, undefined)).toBe('unknown');
    expect(compareModelDigest('', digest)).toBe('unknown');
    expect(compareModelDigest(digest, 'sha256:')).toBe('unknown');
    expect(compareModelDigest(undefined, undefined)).toBe('unknown');
  });
});

describe('a record that says what ours would say is ours', () => {
  it('isSameLocalEndpoint: the address, the one model, its context and no key', () => {
    expect(isSameLocalEndpoint(RECORD, INPUT)).toBe(true);
    // What discovery may have added does not make it somebody else's.
    expect(
      isSameLocalEndpoint(
        { ...RECORD, modelContextLengths: { 'qwen3.6:35b-a3b': 131072 }, lastDiscoveredAt: '2026-11-06T10:00:00Z' },
        INPUT
      )
    ).toBe(true);
    const differs: Partial<CustomModelHost>[] = [
      { baseUrl: 'http://127.0.0.1:11434' },
      { label: 'My own' },
      { models: ['qwen3.6:35b-a3b', 'gpt-oss:20b'] },
      { models: ['gpt-oss:20b'], defaultModelId: 'gpt-oss:20b' },
      { defaultContextLength: 65536 },
      { apiKey: 'sk-not-ours' },
      { authStyle: 'api-key' },
    ];
    for (const change of differs) expect(isSameLocalEndpoint({ ...RECORD, ...change }, INPUT)).toBe(false);
  });

  it('connectLocalModel takes such a record as ours although the caller did not say so', async () => {
    writeSettings({});
    writeHosts([OTHER, RECORD]);
    expect(await connectLocalModel({ ...INPUT, ours: false })).toEqual({ ok: true, flagWasEnabled: false });
    expect(await readCustomModelHosts(getDataDir())).toEqual([OTHER, RECORD]);
  });

  it('a record with our id that says something else is still somebody else: taken, and untouched', async () => {
    const foreign = { ...RECORD, baseUrl: 'http://127.0.0.1:11434' };
    writeHosts([foreign]);
    expect(await connectLocalModel({ ...INPUT, ours: false })).toEqual({ ok: false, code: 'endpoint-id-taken' });
    expect(await readCustomModelHosts(getDataDir())).toEqual([foreign]);
  });
});

describe('inspectLocalEndpoint: what the connect step finds before it claims the connection', () => {
  it('nothing saved and no settings file: absent, and the flag is off', async () => {
    expect(await inspectLocalEndpoint(INPUT)).toEqual({ record: 'absent', flagEnabled: false });
  });

  it('reads the flag as it is now, and writes nothing', async () => {
    writeSettings({ customModelEndpointsEnabled: true, tmuxHistoryLimit: 5000 });
    writeHosts([OTHER]);
    const settingsBefore = readFileSync(SETTINGS_PATH, 'utf8');
    const hostsBefore = readFileSync(HOSTS(), 'utf8');
    expect(await inspectLocalEndpoint(INPUT)).toEqual({ record: 'absent', flagEnabled: true });
    expect(readFileSync(SETTINGS_PATH, 'utf8')).toBe(settingsBefore);
    expect(readFileSync(HOSTS(), 'utf8')).toBe(hostsBefore);
  });

  it("tells our record from somebody else's under the same id", async () => {
    writeHosts([RECORD]);
    expect((await inspectLocalEndpoint(INPUT)).record).toBe('same');
    expect((await inspectLocalEndpoint({ ...INPUT, port: 11436 })).record).toBe('other');
  });
});

describe('moveLocalEndpoint', () => {
  it('a record that is already on the port is not written again', async () => {
    writeHosts([RECORD]);
    const before = readFileSync(HOSTS(), 'utf8');
    await moveLocalEndpoint(11435);
    expect(readFileSync(HOSTS(), 'utf8')).toBe(before);
    await moveLocalEndpoint(11440);
    expect((await readCustomModelHosts(getDataDir()))[0].baseUrl).toBe('http://127.0.0.1:11440');
  });
});

describe('the runtime keeps a private key that is never served', () => {
  it('everything in the private home is on the sensitive list, and so is a runtime key under a real home', () => {
    const home = join(getDataDir(), 'local-model', 'home');
    expect(isSensitivePath(join(home, '.ollama', 'id_ed25519'))).toBe(true);
    expect(isSensitivePath(join(home, '.ollama', 'id_ed25519.pub'))).toBe(true);
    expect(isSensitivePath('/Users/me/.codeman-beta/local-model/home/.ollama/server.json')).toBe(true);
    expect(isSensitivePath('/Users/me/.ollama/id_ed25519')).toBe(true);
  });

  it('the model store and the state file hold no secret and stay ordinary files', () => {
    expect(isSensitivePath(join(getDataDir(), 'local-model', 'models', 'manifest'))).toBe(false);
    expect(isSensitivePath('/Users/me/.ollama/models/blobs/sha256-abc')).toBe(false);
  });
});
