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
