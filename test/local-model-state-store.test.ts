/**
 * @fileoverview The one reader and writer of `local-model.json` (src/local-model/state-store.ts).
 *
 * What is pinned:
 *  - reading is TOTAL: a missing file, text that does not parse, another schema, an unknown
 *    state and a state that lacks a member it needs all read as idle, and a member of the
 *    wrong type is dropped rather than trusted;
 *  - the file holds no path, so nothing in it can point a delete anywhere;
 *  - writes are serialized, go through a temp file, are mode 0600 and stamp `updatedAt`.
 *
 * Port: N/A (no server; the file lives in the test's temp data dir).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../src/config/instance.js';
import {
  IDLE_LOCAL_MODEL_STATE,
  mutateLocalModelState,
  parseLocalModelState,
  readLocalModelState,
} from '../src/local-model/state-store.js';
import type { LocalModelStateFile } from '../src/types.js';

const FILE = () => dataPath('local-model.json');

const INSTALLED: LocalModelStateFile = {
  schema: 1,
  state: 'installed',
  model: {
    id: 'qwen3.6:35b-a3b',
    label: 'Qwen3.6 35B-A3B',
    context: 131072,
    pullBytes: 23_105_798_956,
    digest: '0ce5ff81f9ffdf89dd8192ca7b5d34cefd8996a875b3aaaaafaf5c4813569eba',
  },
  cli: { id: 'opencode', label: 'OpenCode' },
  runtime: { version: '0.40.15', port: 11435, pid: 4711, enabled: true, measuredTotalBytes: 40_157_944_217 },
  loaded: { context: 131072, sizeBytes: 26_300_000_000, sizeVramBytes: 26_300_000_000 },
  connection: { endpointId: 'local-ollama', flagWasEnabled: false },
  updatedAt: '2026-11-06T10:00:00.000Z',
};

const PAUSED: LocalModelStateFile = {
  schema: 1,
  state: 'paused',
  step: 'model',
  steps: ['runtime', 'model', 'verify', 'agent', 'connect'],
  model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', context: 131072 },
  cli: { id: 'opencode', label: 'OpenCode' },
  runtime: { version: '0.40.15', port: 11435, enabled: true },
  progress: { completedBytes: 6_200_000_000, totalBytes: 23_105_798_956 },
};

const FAILED: LocalModelStateFile = {
  ...PAUSED,
  state: 'failed',
  step: 'verify',
  error: {
    code: 'no-tool-call',
    vars: { model: 'Qwen3.6 35B-A3B' },
    detail: 'finish_reason stop',
    nextModelId: 'gpt-oss:20b',
  },
};

afterEach(() => {
  rmSync(FILE(), { force: true });
});

describe('parseLocalModelState', () => {
  it('reads back exactly what a state of each kind holds', () => {
    for (const state of [INSTALLED, PAUSED, FAILED, { ...PAUSED, state: 'installing' as const }]) {
      expect(parseLocalModelState(JSON.stringify(state))).toEqual(state);
    }
  });

  it.each([
    ['an empty file', ''],
    ['text that does not parse', '{"schema":1,"state":"installed",'],
    ['a list', '[]'],
    ['null', 'null'],
    ['another schema', JSON.stringify({ ...INSTALLED, schema: 2 })],
    ['no schema', JSON.stringify({ state: 'installed' })],
    ['an unknown state', JSON.stringify({ ...INSTALLED, state: 'ready' })],
    ['idle', JSON.stringify({ schema: 1, state: 'idle', model: INSTALLED.model })],
    ['idle with everything a job has', JSON.stringify({ ...PAUSED, state: 'idle' })],
    ['idle with everything an installation has', JSON.stringify({ ...INSTALLED, state: 'idle' })],
  ])('%s reads as idle', (_label, raw) => {
    expect(parseLocalModelState(raw)).toBe(IDLE_LOCAL_MODEL_STATE);
  });

  it('a state that lacks a member it needs is not trusted: it reads as idle', () => {
    const without = (state: LocalModelStateFile, key: keyof LocalModelStateFile) => {
      const copy: Record<string, unknown> = { ...state };
      delete copy[key];
      return JSON.stringify(copy);
    };
    // Installed needs its model, its coding agent and its runtime (the port).
    expect(parseLocalModelState(without(INSTALLED, 'model'))).toBe(IDLE_LOCAL_MODEL_STATE);
    expect(parseLocalModelState(without(INSTALLED, 'cli'))).toBe(IDLE_LOCAL_MODEL_STATE);
    expect(parseLocalModelState(without(INSTALLED, 'runtime'))).toBe(IDLE_LOCAL_MODEL_STATE);
    // A job needs its step and its steps, and a failed one its error.
    expect(parseLocalModelState(without(PAUSED, 'step'))).toBe(IDLE_LOCAL_MODEL_STATE);
    expect(parseLocalModelState(without(PAUSED, 'steps'))).toBe(IDLE_LOCAL_MODEL_STATE);
    expect(parseLocalModelState(without(FAILED, 'error'))).toBe(IDLE_LOCAL_MODEL_STATE);
    expect(parseLocalModelState(JSON.stringify({ ...PAUSED, step: 'agent', steps: ['runtime', 'model'] }))).toBe(
      IDLE_LOCAL_MODEL_STATE
    );
    expect(parseLocalModelState(JSON.stringify({ ...PAUSED, steps: ['runtime', 'model', 'model'] }))).toBe(
      IDLE_LOCAL_MODEL_STATE
    );
    expect(parseLocalModelState(JSON.stringify({ ...PAUSED, steps: ['runtime', 'model', 'reboot'] }))).toBe(
      IDLE_LOCAL_MODEL_STATE
    );
    expect(parseLocalModelState(JSON.stringify({ ...FAILED, error: { code: 'made-up' } }))).toBe(
      IDLE_LOCAL_MODEL_STATE
    );
  });

  it('drops a member of the wrong type instead of trusting it', () => {
    const parsed = parseLocalModelState(
      JSON.stringify({
        ...INSTALLED,
        model: { ...INSTALLED.model, pullBytes: '23 GB', digest: 12 },
        runtime: { ...INSTALLED.runtime, pid: 'four', measuredTotalBytes: -1 },
        loaded: { context: 131072, sizeBytes: 'big', sizeVramBytes: 1 },
        connection: { endpointId: 'local-ollama', flagWasEnabled: 'no' },
        updatedAt: 5,
      })
    );
    expect(parsed).toEqual({
      schema: 1,
      state: 'installed',
      model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', context: 131072 },
      cli: { id: 'opencode', label: 'OpenCode' },
      runtime: { version: '0.40.15', port: 11435, enabled: true },
    });
  });

  it('a port that is not a port makes the runtime unknown', () => {
    for (const port of [0, 70_000, 11435.5, '11435', null]) {
      expect(
        parseLocalModelState(JSON.stringify({ ...PAUSED, runtime: { version: '0.40.15', port, enabled: true } }))
      ).not.toHaveProperty('runtime');
    }
  });

  it('only an explicit false switches the runtime off', () => {
    const enabled = (value: unknown) =>
      parseLocalModelState(
        JSON.stringify({ ...INSTALLED, runtime: { version: '0.40.15', port: 11435, enabled: value } })
      ).runtime?.enabled;
    expect(enabled(false)).toBe(false);
    expect(enabled(true)).toBe(true);
    expect(enabled(undefined)).toBe(true);
    expect(enabled('false')).toBe(true);
  });

  it('drops members it does not know, at every level: a state file holds no path', () => {
    const parsed = parseLocalModelState(
      JSON.stringify({
        ...INSTALLED,
        root: '/Users/me',
        runtimeDir: '/',
        model: { ...INSTALLED.model, path: '/etc' },
        runtime: { ...INSTALLED.runtime, binary: '/bin/sh' },
        connection: { ...INSTALLED.connection, file: '/etc/passwd' },
      })
    );
    expect(parsed).toEqual(INSTALLED);
    expect(JSON.stringify(parsed)).not.toContain('/');
  });

  it('keeps the model a replaced job left behind on a job, and never on an installed state', () => {
    expect(parseLocalModelState(JSON.stringify({ ...PAUSED, replacedModelId: 'qwen3.8:27b' })).replacedModelId).toBe(
      'qwen3.8:27b'
    );
    expect(parseLocalModelState(JSON.stringify({ ...INSTALLED, replacedModelId: 'qwen3.8:27b' }))).not.toHaveProperty(
      'replacedModelId'
    );
  });

  it('an error is kept only on a failed job, and progress and a step only on a job', () => {
    expect(parseLocalModelState(JSON.stringify({ ...PAUSED, error: FAILED.error }))).not.toHaveProperty('error');
    const installed = parseLocalModelState(
      JSON.stringify({
        ...INSTALLED,
        error: FAILED.error,
        step: 'connect',
        steps: PAUSED.steps,
        progress: PAUSED.progress,
      })
    );
    expect(installed).toEqual(INSTALLED);
  });
});

describe('parseLocalModelState: the library', () => {
  const QWEN = {
    id: 'qwen3.6:35b-a3b',
    label: 'Qwen3.6 35B-A3B',
    context: 131072,
    digest: '0ce5ff81f9ffdf89dd8192ca7b5d34cefd8996a875b3aaaaafaf5c4813569eba',
    bytes: 23_105_798_956,
    cli: { id: 'opencode', label: 'OpenCode' },
    verifiedAt: '2026-11-10T09:00:00.000Z',
  };
  const MIMO = { id: 'mimo-v2.6:9b-q4_k_m', label: 'MiMo V2.6 9B', context: 65536, digest: 'abc123' };
  const read = (state: unknown) => parseLocalModelState(JSON.stringify(state));

  it('reads back the checked models of an installed state and of a job, in their order', () => {
    expect(read({ ...INSTALLED, library: [QWEN, MIMO] })).toEqual({ ...INSTALLED, library: [QWEN, MIMO] });
    expect(read({ ...PAUSED, library: [MIMO] })).toEqual({ ...PAUSED, library: [MIMO] });
    expect(read({ ...FAILED, library: [MIMO, QWEN] }).library).toEqual([MIMO, QWEN]);
  });

  it('a file an earlier build wrote has no list, and reads back without one', () => {
    expect(read(INSTALLED)).toEqual(INSTALLED);
    expect(read(INSTALLED)).not.toHaveProperty('library');
    expect(read(PAUSED)).not.toHaveProperty('library');
  });

  it('an empty list stays an empty list: every checked model was deleted', () => {
    expect(read({ ...PAUSED, library: [] }).library).toEqual([]);
  });

  it('a list that is not a list is dropped, the state is kept', () => {
    for (const library of ['qwen', 7, { 0: QWEN }, null, true]) {
      const state = read({ ...INSTALLED, library });
      expect(state.state).toBe('installed');
      expect(state).not.toHaveProperty('library');
    }
  });

  it('drops an entry that could never be switched to: without its id, label, context or digest', () => {
    const library = [
      { ...QWEN, id: '' },
      { ...QWEN, label: 7 },
      { ...QWEN, context: 0 },
      { ...QWEN, context: '131072' },
      { ...QWEN, digest: undefined },
      'qwen3.6:35b-a3b',
      null,
      ['qwen3.6:35b-a3b'],
      MIMO,
    ];
    expect(read({ ...INSTALLED, library }).library).toEqual([MIMO]);
  });

  it('keeps one entry per model: the first', () => {
    const library = [QWEN, { ...QWEN, context: 65536 }, MIMO];
    expect(read({ ...INSTALLED, library }).library).toEqual([QWEN, MIMO]);
  });

  it('drops what it does not know inside an entry, and a member of the wrong type: an entry holds no path', () => {
    const library = [
      {
        ...QWEN,
        path: '/Users/me/.codeman/local-model/models',
        blobs: ['/etc/passwd'],
        bytes: -5,
        cli: { id: 'opencode' },
        verifiedAt: 7,
      },
    ];
    const [entry] = read({ ...INSTALLED, library }).library ?? [];
    expect(entry).toEqual({ id: QWEN.id, label: QWEN.label, context: QWEN.context, digest: QWEN.digest });
    expect(JSON.stringify(read({ ...INSTALLED, library }))).not.toContain('/');
  });

  it('reads at most 64 entries of a list, however long it is', () => {
    const library = Array.from({ length: 500 }, (_unused, i) => ({ ...MIMO, id: `model-${i}:9b` }));
    expect(read({ ...INSTALLED, library }).library).toHaveLength(64);
  });

  it('an idle file has no list, whatever it says', () => {
    expect(read({ schema: 1, state: 'idle', library: [QWEN] })).toEqual(IDLE_LOCAL_MODEL_STATE);
  });
});

describe('readLocalModelState', () => {
  it('is idle when the file is missing, and never throws', async () => {
    expect(existsSync(FILE())).toBe(false);
    expect(await readLocalModelState()).toBe(IDLE_LOCAL_MODEL_STATE);
  });

  it('is idle for a file that does not parse', async () => {
    writeFileSync(FILE(), 'not json');
    expect(await readLocalModelState()).toBe(IDLE_LOCAL_MODEL_STATE);
  });

  it('reads what is stored', async () => {
    writeFileSync(FILE(), JSON.stringify(INSTALLED));
    expect(await readLocalModelState()).toEqual(INSTALLED);
  });
});

describe('mutateLocalModelState', () => {
  it('writes the returned state, stamps updatedAt, and answers with before and after', async () => {
    const { updatedAt: _stamp, ...paused } = PAUSED;
    const { before, after } = await mutateLocalModelState(() => paused);
    expect(before).toBe(IDLE_LOCAL_MODEL_STATE);
    expect(after).toMatchObject(paused);
    expect(Number.isNaN(Date.parse(after!.updatedAt!))).toBe(false);
    expect(await readLocalModelState()).toEqual(after);
  });

  it('writes nothing when the change returns undefined: no file appears', async () => {
    const { before, after } = await mutateLocalModelState(() => undefined);
    expect(before).toBe(IDLE_LOCAL_MODEL_STATE);
    expect(after).toBeUndefined();
    expect(existsSync(FILE())).toBe(false);
  });

  it('the file is mode 0600 and no temp file is left beside it', async () => {
    await mutateLocalModelState(() => PAUSED);
    expect(statSync(FILE()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(FILE())).filter((name) => name.startsWith('local-model.json'))).toEqual([
      'local-model.json',
    ]);
  });

  it('changes started together run one after the other: none is lost', async () => {
    await mutateLocalModelState(() => PAUSED);
    const add = (bytes: number) =>
      mutateLocalModelState((current) => ({
        ...current,
        progress: {
          completedBytes: (current.progress?.completedBytes ?? 0) + bytes,
          totalBytes: 23_105_798_956,
        },
      }));
    await Promise.all(Array.from({ length: 10 }, () => add(1_000)));
    expect((await readLocalModelState()).progress?.completedBytes).toBe(6_200_000_000 + 10_000);
  });

  it('a change that throws rejects its own caller and the next one still runs', async () => {
    const thrown = mutateLocalModelState(() => {
      throw new Error('boom');
    });
    const next = mutateLocalModelState(() => PAUSED);
    await expect(thrown).rejects.toThrow('boom');
    expect((await next).after).toMatchObject({ state: 'paused' });
  });

  it('replaces a file that does not parse: it holds nothing of the person to lose', async () => {
    writeFileSync(FILE(), '{broken');
    const { before } = await mutateLocalModelState(() => PAUSED);
    expect(before).toBe(IDLE_LOCAL_MODEL_STATE);
    expect(JSON.parse(readFileSync(FILE(), 'utf8'))).toMatchObject({ schema: 1, state: 'paused' });
  });
});
