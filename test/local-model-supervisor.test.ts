/**
 * @fileoverview Tests for the supervisor of src/local-model/runtime.ts: how Codeman starts,
 * watches, restarts and stops its model runtime.
 *
 * Nothing real runs here. The child process is the fake of test/fixtures/fake-ollama.ts
 * (`fake.spawn`): "starting" it makes the fake listen on the port of `OLLAMA_HOST` and write
 * the runtime's start-up log, and killing it closes that listener.
 *
 * Pinned:
 *  - Start: one non-detached child, `<runtime folder>/ollama serve`, with the allowlisted
 *    environment; it is ready when `/api/version` answers the pinned version; the device total
 *    of its log is reported as the measured budget.
 *  - The port: a listener that is not ours is `port-in-use` and is never signalled; our own
 *    orphan (the stored pid runs a binary under our runtime folder) is adopted when it holds a
 *    loaded model at the wanted context, and replaced otherwise.
 *  - A child that exits by itself is restarted at most 3 times, then given up.
 *  - Stop: SIGTERM, and nothing is restarted afterwards.
 *  - Under vitest nothing spawns unless the test injects it.
 *
 * Port: none fixed (each test reserves a free loopback port).
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localModelPaths, runtimeBinaryForVersion, type LocalModelPaths } from '../src/local-model/paths.js';
import {
  createRuntimeSupervisor,
  RUNTIME_MAX_RESTARTS,
  type RuntimeStatus,
  type RuntimeSupervisor,
  type RuntimeSupervisorDeps,
} from '../src/local-model/runtime.js';
import {
  createFakeOllama,
  FakeRuntimeChild,
  freeLoopbackPort,
  startFakeOllama,
  type FakeOllama,
  type FakeOllamaOptions,
} from './fixtures/fake-ollama.js';

const CONTEXT = 131072;
/** A pid of an "earlier server's" runtime. Above every real pid, like the fake's own. */
const ORPHAN_PID = 9_800_000;

let paths: LocalModelPaths;
let port: number;
const fakes: FakeOllama[] = [];
const supervisors: RuntimeSupervisor[] = [];
const servers: Server[] = [];

beforeEach(async () => {
  paths = localModelPaths('0.40.15');
  port = await freeLoopbackPort();
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
  for (const fake of fakes.splice(0)) await fake.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(paths.root, { recursive: true, force: true });
});

/** A fake runtime that does not listen until it is "spawned". */
function fakeRuntime(options: FakeOllamaOptions = {}): FakeOllama {
  const fake = createFakeOllama(options);
  fakes.push(fake);
  return fake;
}

/** The children the fake has spawned so far. */
function children(fake: FakeOllama): FakeRuntimeChild[] {
  return fake.state.children;
}

interface Harness {
  supervisor: RuntimeSupervisor;
  /** Every status `onChange` was called with. */
  changes: RuntimeStatus[];
  /** Every wait the supervisor asked for. */
  waits: number[];
  /** Every signal sent to a pid that is not our child. */
  kills: [number, NodeJS.Signals][];
}

/** A supervisor whose child is `fake`. Waits are instant unless a test passes its own `sleep`. */
function supervise(fake: FakeOllama, overrides: Partial<RuntimeSupervisorDeps> = {}): Harness {
  const changes: RuntimeStatus[] = [];
  const waits: number[] = [];
  const kills: [number, NodeJS.Signals][] = [];
  const supervisor = createRuntimeSupervisor({
    spawn: fake.spawn,
    fetch,
    env: { PATH: '/usr/bin:/bin' },
    pin: fake.pin(),
    paths,
    sleep: async (ms) => {
      waits.push(ms);
    },
    commandOfPid: async () => undefined,
    kill: (pid, signal) => {
      kills.push([pid, signal]);
    },
    onChange: (status) => changes.push(status),
    startTimeoutMs: 3_000,
    budgetWaitMs: 500,
    ...overrides,
  });
  supervisors.push(supervisor);
  return { supervisor, changes, waits, kills };
}

/** Waits until `check()` is true. Fails the test when it never is. */
async function until(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The command line `ps` would print for a runtime of ours. */
function ownCommand(): string {
  return `${paths.binary} serve`;
}

// ---------- Start ----------

describe('start', () => {
  it('starts one child, the runtime binary with "serve", and answers once it is up', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    const result = await supervisor.start({ port, contextLength: CONTEXT });

    expect(children(fake)).toHaveLength(1);
    const child = children(fake)[0];
    expect(child.command).toBe(paths.binary);
    expect(child.args).toEqual(['serve']);
    expect(result).toEqual({
      ok: true,
      pid: child.pid,
      port,
      orphan: 'none',
      // 37.4 GiB, read from the child's log line "inference compute".
      measuredTotalBytes: 40_157_944_217,
    });
    expect(supervisor.status()).toEqual({
      running: true,
      pid: child.pid,
      port,
      contextLength: CONTEXT,
      measuredTotalBytes: 40_157_944_217,
      restarts: 0,
      gaveUp: false,
    });
    expect(fake.port).toBe(port);
  });

  it('starts the child non-detached, with pipes, in the private home', async () => {
    const fake = fakeRuntime();
    const seen: SpawnOptions[] = [];
    const { supervisor } = supervise(fake, {
      spawn: (command, args, options) => {
        seen.push(options);
        return fake.spawn(command, args, options);
      },
    });
    await supervisor.start({ port, contextLength: CONTEXT });
    expect(seen).toHaveLength(1);
    expect(seen[0].detached).toBe(false);
    expect(seen[0].stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(seen[0].cwd).toBe(paths.homeDir);
    expect(seen[0]).not.toHaveProperty('shell');
    // The folders it needs exist before it starts.
    expect(existsSync(paths.homeDir)).toBe(true);
    expect(existsSync(paths.modelsDir)).toBe(true);
  });

  it('gives the child the allowlisted environment and nothing of the server beyond it', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake, {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/arkon',
        LANG: 'en_US.UTF-8',
        CODEMAN_PASSWORD: 'hunter2',
        CODEMAN_API_URL: 'http://127.0.0.1:3000',
        OLLAMA_ORIGINS: '*',
        OLLAMA_HOST: '0.0.0.0:11434',
        OLLAMA_KEEP_ALIVE: '-1',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
      },
    });
    await supervisor.start({ port, contextLength: 65536 });
    expect(children(fake)[0].env).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      HOME: paths.homeDir,
      OLLAMA_HOST: `127.0.0.1:${port}`,
      OLLAMA_MODELS: paths.modelsDir,
      OLLAMA_CONTEXT_LENGTH: '65536',
      OLLAMA_NO_CLOUD: '1',
      OLLAMA_KEEP_ALIVE: '10m',
      OLLAMA_NUM_PARALLEL: '1',
      OLLAMA_MAX_LOADED_MODELS: '1',
      OLLAMA_KV_CACHE_TYPE: 'q8_0',
      OLLAMA_FLASH_ATTENTION: '1',
      LLAMA_ARG_CACHE_RAM: '1024',
      LLAMA_ARG_CTX_CHECKPOINTS: '8',
    });
  });

  it('reads the budget the child logs, whatever the Mac', async () => {
    const fake = fakeRuntime({ spawn: { total: '11.8 GiB' } });
    const { supervisor } = supervise(fake);
    const result = await supervisor.start({ port, contextLength: CONTEXT });
    expect(result).toMatchObject({ ok: true, measuredTotalBytes: 12_670_153_523 });
    expect(supervisor.status().measuredTotalBytes).toBe(12_670_153_523);
  });

  it('still starts when the child prints no budget line, and reports none', async () => {
    const fake = fakeRuntime({ spawn: { logsBudget: false } });
    const { supervisor } = supervise(fake, { budgetWaitMs: 60 });
    const result = await supervisor.start({ port, contextLength: CONTEXT });
    expect(result).toMatchObject({ ok: true, port });
    expect(result).not.toHaveProperty('measuredTotalBytes');
    expect(supervisor.status()).not.toHaveProperty('measuredTotalBytes');
    expect(supervisor.status().running).toBe(true);
  });

  it('is idempotent: a child that already runs as asked is kept', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    const first = await supervisor.start({ port, contextLength: CONTEXT });
    const second = await supervisor.start({ port, contextLength: CONTEXT });
    expect(second).toEqual(first);
    expect(children(fake)).toHaveLength(1);
    expect(children(fake)[0].signals).toEqual([]);
  });

  it('replaces a child that runs with another context length', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    await supervisor.start({ port, contextLength: CONTEXT });
    const result = await supervisor.start({ port, contextLength: 65536 });
    expect(result).toMatchObject({ ok: true, orphan: 'none' });
    expect(children(fake)).toHaveLength(2);
    // The first got SIGTERM; the second runs with the new context.
    expect(children(fake)[0].signals).toEqual(['SIGTERM']);
    expect(children(fake)[1].env.OLLAMA_CONTEXT_LENGTH).toBe('65536');
    expect(supervisor.status()).toMatchObject({ running: true, pid: children(fake)[1].pid, contextLength: 65536 });
    // Replacing on purpose is not a crash.
    expect(supervisor.status().restarts).toBe(0);
  });

  it('runs two starts one after the other, never two children at once', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    const [a, b] = await Promise.all([
      supervisor.start({ port, contextLength: CONTEXT }),
      supervisor.start({ port, contextLength: CONTEXT }),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    expect(children(fake)).toHaveLength(1);
  });

  it('refuses a port or a context length that is none, without starting anything', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    for (const bad of [0, -1, 70_000, 1.5, Number.NaN]) {
      expect(await supervisor.start({ port: bad, contextLength: CONTEXT }), String(bad)).toMatchObject({
        ok: false,
        code: 'runtime-start-failed',
      });
    }
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(await supervisor.start({ port, contextLength: bad }), String(bad)).toMatchObject({
        ok: false,
        code: 'runtime-start-failed',
      });
    }
    expect(children(fake)).toHaveLength(0);
  });

  it('tells its caller every change, and survives a caller that throws', async () => {
    const fake = fakeRuntime();
    const seen: RuntimeStatus[] = [];
    const { supervisor } = supervise(fake, {
      onChange: (status) => {
        seen.push(status);
        throw new Error('the state file is read-only');
      },
    });
    const result = await supervisor.start({ port, contextLength: CONTEXT });
    expect(result).toMatchObject({ ok: true });
    // The caller stores pid and port from this.
    expect(seen.at(-1)).toMatchObject({ running: true, pid: children(fake)[0].pid, port, contextLength: CONTEXT });
    await supervisor.stop();
    expect(seen.at(-1)).toEqual({ running: false, restarts: 0, gaveUp: false });
  });

  it('hands out a copy of its status', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    await supervisor.start({ port, contextLength: CONTEXT });
    const status = supervisor.status();
    status.running = false;
    status.pid = 1;
    expect(supervisor.status()).toMatchObject({ running: true, pid: children(fake)[0].pid });
  });

  it("writes no state file: storing pid and port is the caller's business", async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    await supervisor.start({ port, contextLength: CONTEXT });
    await supervisor.stop();
    expect(existsSync(paths.stateFile)).toBe(false);
  });
});

// ---------- A start that fails ----------

describe('a start that fails', () => {
  it('answers runtime-start-failed when the child never answers, and does not leave it running', async () => {
    const fake = fakeRuntime({ spawn: { neverListens: true } });
    const { supervisor } = supervise(fake, { startTimeoutMs: 150 });
    const result = await supervisor.start({ port, contextLength: CONTEXT });
    expect(result).toMatchObject({ ok: false, code: 'runtime-start-failed' });
    const detail = (result as { detail?: string }).detail ?? '';
    expect(detail).toContain('did not answer');
    // The last lines of its log are the detail.
    expect(detail).toContain('Listening on');
    expect(children(fake)).toHaveLength(1);
    expect(children(fake)[0].signals).toEqual(['SIGTERM']);
    expect(supervisor.status()).toEqual({ running: false, restarts: 0, gaveUp: false });
  });

  it('answers runtime-start-failed when the child exits at once, with what it printed', async () => {
    const fake = fakeRuntime({ spawn: { exitsAtOnce: 2 } });
    const { supervisor } = supervise(fake);
    const result = await supervisor.start({ port, contextLength: CONTEXT });
    expect(result).toMatchObject({ ok: false, code: 'runtime-start-failed' });
    const detail = (result as { detail?: string }).detail ?? '';
    expect(detail).toContain('exited with code 2');
    expect(detail).toContain('address already in use');
    // A start that failed is not a crash to recover from: nothing is started again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(children(fake)).toHaveLength(1);
    expect(supervisor.status()).toMatchObject({ running: false, restarts: 0, gaveUp: false });
  });

  it('answers runtime-start-failed when a runtime of another version answers', async () => {
    const fake = fakeRuntime({ version: '0.39.2' });
    const { supervisor } = supervise(fake, { pin: { ...fake.pin(), version: '0.40.15' } });
    const result = await supervisor.start({ port, contextLength: CONTEXT });
    expect(result).toMatchObject({ ok: false, code: 'runtime-start-failed' });
    expect((result as { detail?: string }).detail).toContain('0.39.2');
    expect(children(fake)[0].signals).toEqual(['SIGTERM']);
  });

  it('answers runtime-start-failed when the binary cannot be started at all', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake, {
      spawn: () => {
        throw new Error('spawn EACCES');
      },
    });
    expect(await supervisor.start({ port, contextLength: CONTEXT })).toEqual({
      ok: false,
      code: 'runtime-start-failed',
      detail: 'spawn EACCES',
    });
  });

  it('spawns nothing under vitest unless the test injects a spawn', async () => {
    // No `spawn` and no `fetch` given: the defaults refuse here.
    const supervisor = createRuntimeSupervisor({ paths, startTimeoutMs: 200 });
    supervisors.push(supervisor);
    const result = await supervisor.start({ port, contextLength: CONTEXT });
    // The refusal itself, not a failed attempt to run a binary that is not there.
    expect(result).toEqual({
      ok: false,
      code: 'runtime-start-failed',
      detail: 'spawn is not available under vitest: the test must inject its own',
    });
    expect(supervisor.status().running).toBe(false);
  });

  it('gives up a start at once when stop is called while it waits', async () => {
    const fake = fakeRuntime({ spawn: { neverListens: true } });
    const { supervisor } = supervise(fake, {
      startTimeoutMs: 20_000,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 10)),
    });
    const starting = supervisor.start({ port, contextLength: CONTEXT });
    await until(() => children(fake).length === 1, 'the child to be spawned');
    const began = Date.now();
    await supervisor.stop();
    const result = await starting;
    expect(result).toMatchObject({ ok: false, code: 'runtime-start-failed' });
    // Not after the 20 seconds a start may take.
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(children(fake)[0].signals).toEqual(['SIGTERM']);
    expect(supervisor.status().running).toBe(false);
  });
});

// ---------- The port ----------

describe('the port', () => {
  /** A runtime that listens on `port` already, as an earlier server's would. */
  async function listeningRuntime(options: FakeOllamaOptions = {}): Promise<FakeOllama> {
    const other = createFakeOllama(options);
    fakes.push(other);
    await other.listen(port);
    return other;
  }

  it('answers port-in-use for a runtime that is not ours, and does not touch it', async () => {
    // The user's own runtime on our port. No pid of ours is stored.
    const theirs = await listeningRuntime();
    const fake = fakeRuntime();
    const { supervisor, kills } = supervise(fake);
    const result = await supervisor.start({ port, contextLength: CONTEXT });
    // Told apart from any other program on the port: it answers as a runtime, and is not ours.
    expect(result).toEqual({
      ok: false,
      code: 'port-in-use',
      detail: `A model runtime that Codeman did not start answers on port ${port} (version 0.40.15)`,
    });
    expect(children(fake)).toHaveLength(0);
    expect(kills).toEqual([]);
    expect(theirs.listening).toBe(true);
    expect(supervisor.status().running).toBe(false);
  });

  it('answers port-in-use when the stored pid now runs something else', async () => {
    const theirs = await listeningRuntime();
    const fake = fakeRuntime();
    const { supervisor, kills } = supervise(fake, {
      // The pid was reused, or it is a runtime outside our folder.
      commandOfPid: async () => '/usr/local/bin/ollama serve',
    });
    const result = await supervisor.start({ port, contextLength: CONTEXT, previousPid: ORPHAN_PID });
    expect(result).toMatchObject({ ok: false, code: 'port-in-use' });
    expect(kills).toEqual([]);
    expect(theirs.listening).toBe(true);
    expect(children(fake)).toHaveLength(0);
  });

  it('answers port-in-use for a listener that is no runtime at all', async () => {
    // Some other program: it takes the connection and hangs up.
    const holder = createServer((socket) => socket.destroy());
    servers.push(holder);
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', () => resolve()));
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    expect(await supervisor.start({ port, contextLength: CONTEXT })).toEqual({
      ok: false,
      code: 'port-in-use',
      detail: `Another program holds port ${port}`,
    });
    expect(children(fake)).toHaveLength(0);
  });

  it('ADOPTS its own orphan when that holds a loaded model at the wanted context', async () => {
    const orphan = await listeningRuntime({ installed: true });
    orphan.state.loaded = true;
    let gone = false;
    const fake = fakeRuntime();
    const { supervisor, kills, changes } = supervise(fake, {
      commandOfPid: async (pid) => (pid === ORPHAN_PID && !gone ? ownCommand() : undefined),
    });
    const result = await supervisor.start({ port, contextLength: CONTEXT, previousPid: ORPHAN_PID });
    // Kept as it is: nothing spawned, nothing signalled, the loaded model stays loaded.
    expect(result).toEqual({ ok: true, pid: ORPHAN_PID, port, orphan: 'adopted' });
    expect(children(fake)).toHaveLength(0);
    expect(kills).toEqual([]);
    expect(orphan.listening).toBe(true);
    // Its log is not ours to read, so there is no measured budget.
    expect(supervisor.status()).toEqual({
      running: true,
      pid: ORPHAN_PID,
      port,
      contextLength: CONTEXT,
      restarts: 0,
      gaveUp: false,
    });
    expect(changes.at(-1)).toMatchObject({ running: true, pid: ORPHAN_PID });
    // So that the stop after this test finds it gone and does not wait out its grace period.
    gone = true;
  });

  it('stops an adopted orphan by its pid', async () => {
    const orphan = await listeningRuntime({ installed: true });
    orphan.state.loaded = true;
    let gone = false;
    const fake = fakeRuntime();
    const { supervisor, kills } = supervise(fake, {
      commandOfPid: async (pid) => (pid === ORPHAN_PID && !gone ? ownCommand() : undefined),
      kill: (pid, signal) => {
        kills.push([pid, signal]);
        gone = true;
      },
    });
    await supervisor.start({ port, contextLength: CONTEXT, previousPid: ORPHAN_PID });
    await supervisor.stop();
    expect(kills).toEqual([[ORPHAN_PID, 'SIGTERM']]);
    expect(supervisor.status()).toEqual({ running: false, restarts: 0, gaveUp: false });
  });

  /** Starts with an orphan on the port that is ours and goes away when it is signalled. */
  async function startOverOrphan(orphanOptions: FakeOllamaOptions, loaded: boolean) {
    const orphan = await listeningRuntime(orphanOptions);
    orphan.state.loaded = loaded;
    let gone = false;
    const fake = fakeRuntime();
    const harness = supervise(fake, {
      commandOfPid: async (pid) => (pid === ORPHAN_PID && !gone ? ownCommand() : undefined),
      kill: (pid, signal) => {
        harness.kills.push([pid, signal]);
        gone = true;
        void orphan.close();
      },
    });
    const result = await harness.supervisor.start({ port, contextLength: CONTEXT, previousPid: ORPHAN_PID });
    return { orphan, fake, result, ...harness };
  }

  it('REPLACES its own orphan when that has no model loaded: nothing is lost, and the budget is read again', async () => {
    const { orphan, fake, result, kills, supervisor } = await startOverOrphan({ installed: true }, false);
    expect(kills).toEqual([[ORPHAN_PID, 'SIGTERM']]);
    expect(orphan.listening).toBe(false);
    expect(children(fake)).toHaveLength(1);
    expect(result).toEqual({
      ok: true,
      pid: children(fake)[0].pid,
      port,
      orphan: 'replaced',
      measuredTotalBytes: 40_157_944_217,
    });
    expect(supervisor.status()).toMatchObject({ running: true, pid: children(fake)[0].pid });
  });

  it('replaces its own orphan when the model is loaded at another context', async () => {
    const { fake, result, kills } = await startOverOrphan({ installed: true, contextLength: 32768 }, true);
    expect(result).toMatchObject({ ok: true, orphan: 'replaced' });
    expect(kills).toEqual([[ORPHAN_PID, 'SIGTERM']]);
    expect(children(fake)[0].env.OLLAMA_CONTEXT_LENGTH).toBe(String(CONTEXT));
  });

  it('replaces its own orphan when it is another version than the pinned one', async () => {
    const { fake, result, kills } = await startOverOrphan({ installed: true, version: '0.39.2' }, true);
    expect(result).toMatchObject({ ok: true, orphan: 'replaced' });
    expect(kills).toEqual([[ORPHAN_PID, 'SIGTERM']]);
    expect(children(fake)).toHaveLength(1);
  });

  it('replaces its own orphan that no longer answers, and starts on the free port', async () => {
    // The stored pid is a runtime of ours, but nothing listens on the port.
    let gone = false;
    const fake = fakeRuntime();
    const { supervisor, kills } = supervise(fake, {
      commandOfPid: async (pid) => (pid === ORPHAN_PID && !gone ? ownCommand() : undefined),
      kill: (pid, signal) => {
        kills.push([pid, signal]);
        gone = true;
      },
    });
    const result = await supervisor.start({ port, contextLength: CONTEXT, previousPid: ORPHAN_PID });
    expect(result).toMatchObject({ ok: true, orphan: 'replaced' });
    expect(kills).toEqual([[ORPHAN_PID, 'SIGTERM']]);
  });

  it('never signals a pid whose command is not under our runtime folder', async () => {
    for (const command of [
      '/usr/local/bin/ollama serve',
      `${paths.runtimeRoot}-other/ollama serve`,
      `/bin/sh -c ${paths.binary} serve`,
      undefined,
    ]) {
      const fake = fakeRuntime();
      const { supervisor, kills } = supervise(fake, { commandOfPid: async () => command });
      const result = await supervisor.start({ port, contextLength: CONTEXT, previousPid: ORPHAN_PID });
      expect(result, String(command)).toMatchObject({ ok: true, orphan: 'none' });
      expect(kills, String(command)).toEqual([]);
      await supervisor.stop();
    }
  });

  it('takes over from an adopted orphan that dies: the next runtime is a child of its own', async () => {
    const orphan = await listeningRuntime({ installed: true });
    orphan.state.loaded = true;
    let gone = false;
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake, {
      commandOfPid: async (pid) => (pid === ORPHAN_PID && !gone ? ownCommand() : undefined),
      orphanPollMs: 15,
    });
    expect(await supervisor.start({ port, contextLength: CONTEXT, previousPid: ORPHAN_PID })).toMatchObject({
      orphan: 'adopted',
    });
    // The orphan dies by itself.
    await orphan.close();
    gone = true;
    await until(() => children(fake).length === 1 && supervisor.status().running, 'a child of our own to run');
    expect(supervisor.status()).toMatchObject({
      running: true,
      pid: children(fake)[0].pid,
      port,
      restarts: 1,
      measuredTotalBytes: 40_157_944_217,
    });
  });
});

// ---------- Restart ----------

describe('a child that exits by itself', () => {
  it('is started again, with the same port and context', async () => {
    const fake = fakeRuntime();
    const { supervisor, waits, changes } = supervise(fake);
    await supervisor.start({ port, contextLength: CONTEXT });
    const first = children(fake)[0];

    first.crash(1);
    await until(() => children(fake).length === 2 && supervisor.status().running, 'the runtime to run again');

    const second = children(fake)[1];
    expect(second.env.OLLAMA_HOST).toBe(`127.0.0.1:${port}`);
    expect(second.env.OLLAMA_CONTEXT_LENGTH).toBe(String(CONTEXT));
    expect(supervisor.status()).toMatchObject({ running: true, pid: second.pid, restarts: 1, gaveUp: false });
    // It waited a second before starting it again.
    expect(waits).toContain(1000);
    // The caller was told that it stopped, and that it runs again.
    const running = changes.map((status) => status.running);
    expect(running.indexOf(false, running.indexOf(true))).toBeGreaterThan(0);
    expect(running.at(-1)).toBe(true);
    // Nobody signalled the one that crashed.
    expect(first.signals).toEqual([]);
  });

  it('is started again at most 3 times, then given up', async () => {
    expect(RUNTIME_MAX_RESTARTS).toBe(3);
    const fake = fakeRuntime();
    const { supervisor, changes } = supervise(fake);
    await supervisor.start({ port, contextLength: CONTEXT });

    for (let crash = 1; crash <= 3; crash++) {
      children(fake).at(-1)?.crash(1);
      await until(() => children(fake).length === crash + 1 && supervisor.status().running, `restart number ${crash}`);
      expect(supervisor.status()).toMatchObject({ running: true, restarts: crash, gaveUp: false });
    }

    // The fourth exit is one too many.
    children(fake).at(-1)?.crash(1);
    await until(() => supervisor.status().gaveUp, 'the supervisor to give up');
    expect(supervisor.status()).toEqual({
      running: false,
      port,
      contextLength: CONTEXT,
      measuredTotalBytes: 40_157_944_217,
      restarts: 3,
      gaveUp: true,
    });
    // The first child and three restarts, and no fifth.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(children(fake)).toHaveLength(4);
    expect(changes.at(-1)).toMatchObject({ running: false, gaveUp: true, restarts: 3 });
  });

  it('counts a restart that does not come up as one of the three', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake, { startTimeoutMs: 100 });
    await supervisor.start({ port, contextLength: CONTEXT });
    // From now on the runtime exits as soon as it is started.
    fake.switches.spawn.exitsAtOnce = 1;
    children(fake)[0].crash(1);
    await until(() => supervisor.status().gaveUp, 'the supervisor to give up');
    expect(children(fake)).toHaveLength(4);
    expect(supervisor.status()).toMatchObject({ running: false, restarts: 3, gaveUp: true });
  });

  it('starts counting again after a start that was asked for', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake, { startTimeoutMs: 100 });
    await supervisor.start({ port, contextLength: CONTEXT });
    fake.switches.spawn.exitsAtOnce = 1;
    children(fake)[0].crash(1);
    await until(() => supervisor.status().gaveUp, 'the supervisor to give up');

    // The person presses Start: it runs again, and the count is back at 0.
    fake.switches.spawn.exitsAtOnce = undefined;
    const result = await supervisor.start({ port, contextLength: CONTEXT });
    expect(result).toMatchObject({ ok: true, orphan: 'none' });
    expect(supervisor.status()).toMatchObject({ running: true, restarts: 0, gaveUp: false });
  });

  it('is not started again once stop was called, also while it waits to restart', async () => {
    const fake = fakeRuntime();
    let release: () => void = () => undefined;
    const { supervisor } = supervise(fake, {
      // The wait before a restart does not end by itself; the polls of a start still do.
      sleep: (ms) =>
        ms === 1000
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(),
    });
    await supervisor.start({ port, contextLength: CONTEXT });
    children(fake)[0].crash(1);
    await until(() => supervisor.status().restarts === 1, 'the restart to be scheduled');

    const stopping = supervisor.stop();
    release();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(children(fake)).toHaveLength(1);
    expect(supervisor.status()).toEqual({ running: false, restarts: 0, gaveUp: false });
  });
});

// ---------- Stop ----------

describe('stop', () => {
  it('sends the child SIGTERM and resolves once it is gone', async () => {
    const fake = fakeRuntime();
    const { supervisor, changes } = supervise(fake);
    await supervisor.start({ port, contextLength: CONTEXT });
    const child = children(fake)[0];

    await supervisor.stop();

    expect(child.signals).toEqual(['SIGTERM']);
    expect(child.signalCode).toBe('SIGTERM');
    // Gone, and the port is free again.
    expect(fake.listening).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/api/version`)).rejects.toThrow();
    expect(supervisor.status()).toEqual({ running: false, restarts: 0, gaveUp: false });
    expect(changes.at(-1)).toEqual({ running: false, restarts: 0, gaveUp: false });
  });

  it('does not take the stop for a crash: nothing is started again', async () => {
    const fake = fakeRuntime();
    const { supervisor, waits } = supervise(fake);
    await supervisor.start({ port, contextLength: CONTEXT });
    await supervisor.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(children(fake)).toHaveLength(1);
    expect(waits).not.toContain(1000);
  });

  it('is safe when nothing runs, and twice in a row', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    await supervisor.stop();
    await supervisor.start({ port, contextLength: CONTEXT });
    await Promise.all([supervisor.stop(), supervisor.stop()]);
    await supervisor.stop();
    expect(children(fake)[0].signals).toEqual(['SIGTERM']);
    expect(supervisor.status().running).toBe(false);
  });

  it('can be started again after a stop', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    await supervisor.start({ port, contextLength: CONTEXT });
    await supervisor.stop();
    const again = await supervisor.start({ port, contextLength: CONTEXT });
    expect(again).toMatchObject({ ok: true, pid: children(fake)[1].pid, orphan: 'none' });
    expect(children(fake)).toHaveLength(2);
  });

  it('kills the child when the server process exits without its shutdown', async () => {
    // The last resort for a forced exit: a listener on the process, for as long as the child lives.
    const fake = fakeRuntime();
    const before = process.listenerCount('exit');
    const { supervisor } = supervise(fake);
    await supervisor.start({ port, contextLength: CONTEXT });
    expect(process.listenerCount('exit')).toBe(before + 1);
    const child = children(fake)[0] as unknown as ChildProcess & FakeRuntimeChild;

    // What Node does on `process.exit()`: it calls the listeners.
    const added = process.listeners('exit').at(-1) as () => void;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    added();
    await exited;
    expect(child.signals).toEqual(['SIGTERM']);
    // The listener goes with its child. (This process did not really exit, so the supervisor
    // took the exit for a crash and started another child, which has a listener of its own.)
    expect(process.listeners('exit')).not.toContain(added);
    await supervisor.stop();
    expect(process.listenerCount('exit')).toBe(before);
  });
});

// ---------- A runtime an earlier server left behind, and the pid that names it ----------

describe('the pid is told the moment the child is spawned', () => {
  it('reports it before the child answers, so a server killed during the start leaves a pid', async () => {
    // The child never answers: the start waits, and is told to stop.
    const fake = fakeRuntime({ spawn: { neverListens: true } });
    const { supervisor, changes } = supervise(fake, {
      startTimeoutMs: 60_000,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    });
    const starting = supervisor.start({ port, contextLength: CONTEXT });
    await until(() => children(fake).length === 1, 'the child to be spawned');
    await until(() => changes.some((status) => status.pid === children(fake)[0].pid), 'the pid to be reported');
    const early = changes.find((status) => status.pid === children(fake)[0].pid);
    // Not running yet: it has not answered.
    expect(early).toMatchObject({ running: false, pid: children(fake)[0].pid });
    await supervisor.stop();
    await starting;
    // A start that failed leaves no pid behind.
    expect(supervisor.status()).toEqual({ running: false, restarts: 0, gaveUp: false });
  });
});

describe('stop with the pid the state file kept', () => {
  it('ends a runtime of ours that this process never started', async () => {
    let gone = false;
    const fake = fakeRuntime();
    const { supervisor, kills } = supervise(fake, {
      commandOfPid: async (pid) => (pid === ORPHAN_PID && !gone ? ownCommand() : undefined),
      kill: (pid, signal) => {
        kills.push([pid, signal]);
        gone = true;
      },
    });
    await supervisor.stop({ previousPid: ORPHAN_PID });
    expect(kills).toEqual([[ORPHAN_PID, 'SIGTERM']]);
    // Nothing was spawned to do it.
    expect(children(fake)).toHaveLength(0);
  });

  it('ends one that runs another version of ours: the folder decides, not the version', async () => {
    let gone = false;
    const fake = fakeRuntime();
    const { supervisor, kills } = supervise(fake, {
      commandOfPid: async (pid) =>
        pid === ORPHAN_PID && !gone ? `${runtimeBinaryForVersion(paths, '0.39.2')} serve` : undefined,
      kill: (pid, signal) => {
        kills.push([pid, signal]);
        gone = true;
      },
    });
    await supervisor.stop({ previousPid: ORPHAN_PID });
    expect(kills).toEqual([[ORPHAN_PID, 'SIGTERM']]);
  });

  it('never signals a pid that runs something else now, nor one that is gone', async () => {
    const fake = fakeRuntime();
    const { supervisor, kills } = supervise(fake, {
      commandOfPid: async (pid) => (pid === ORPHAN_PID ? '/usr/local/bin/ollama serve' : undefined),
    });
    await supervisor.stop({ previousPid: ORPHAN_PID });
    await supervisor.stop({ previousPid: ORPHAN_PID + 1 });
    await supervisor.stop({ previousPid: 1 });
    await supervisor.stop({ previousPid: Number.NaN });
    expect(kills).toEqual([]);
  });

  it('stops its own child first, and the stored pid only when it is somebody else', async () => {
    const fake = fakeRuntime();
    const { supervisor, kills } = supervise(fake);
    const started = await supervisor.start({ port, contextLength: CONTEXT });
    expect(started.ok).toBe(true);
    await supervisor.stop({ previousPid: children(fake)[0].pid });
    expect(children(fake)[0].signals).toEqual(['SIGTERM']);
    // The child is gone by then: its pid names nothing of ours any more.
    expect(kills).toEqual([]);
  });
});

describe('start with the version an installed model was installed with', () => {
  it('runs that version from its own folder and expects it to answer as that version', async () => {
    const fake = fakeRuntime({ version: '0.39.2' });
    const { supervisor } = supervise(fake, { pin: { ...fake.pin(), version: '0.40.15' } });
    const result = await supervisor.start({ port, contextLength: CONTEXT, version: '0.39.2' });
    expect(result).toMatchObject({ ok: true });
    expect(children(fake)[0].command).toBe(runtimeBinaryForVersion(paths, '0.39.2'));
    // Asked again the same way: the child is kept. Asked for the pinned version: replaced.
    await supervisor.start({ port, contextLength: CONTEXT, version: '0.39.2' });
    expect(children(fake)).toHaveLength(1);
  });

  it('a restart after a crash starts the same version again', async () => {
    const fake = fakeRuntime({ version: '0.39.2' });
    const { supervisor } = supervise(fake, { pin: { ...fake.pin(), version: '0.40.15' } });
    await supervisor.start({ port, contextLength: CONTEXT, version: '0.39.2' });
    children(fake)[0].crash();
    await until(() => children(fake).length === 2 && supervisor.status().running, 'the restart');
    expect(children(fake)[1].command).toBe(runtimeBinaryForVersion(paths, '0.39.2'));
  });

  it('refuses a version that is no version before anything is spawned', async () => {
    const fake = fakeRuntime();
    const { supervisor } = supervise(fake);
    const result = await supervisor.start({ port, contextLength: CONTEXT, version: '../../bin' });
    expect(result).toMatchObject({ ok: false, code: 'runtime-start-failed' });
    expect(children(fake)).toHaveLength(0);
  });
});
