/**
 * @fileoverview Tests for src/local-model/runtime.ts, everything but the supervisor (that is
 * test/local-model-supervisor.test.ts): the pin, the budget line, the child's environment,
 * the download with its hash, the port, and the removal.
 *
 * Pinned:
 *  - The pin is the reviewed constant, and a test never reaches it: the default `fetch`
 *    refuses under vitest.
 *  - The budget parser reads the REAL log line of both test Macs and no other line.
 *  - The environment is an allowlist: no `CODEMAN_PASSWORD`, none of the user's own
 *    `OLLAMA_*`, nothing that is not named.
 *  - The download: a matching hash unpacks, a wrong hash deletes the file and unpacks
 *    NOTHING, a cut body is continued with `Range`, the retries are capped, a body longer
 *    than the pin is refused, Cancel keeps the partial file for the next run.
 *  - The port is chosen by binding.
 *  - The removal deletes only inside the one folder and follows no symlink out of it.
 *
 * Port: none fixed (the fake runtime listens on 0; the port tests bind 0 and read the port).
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localModelPaths, type LocalModelPaths } from '../src/local-model/paths.js';
import {
  chooseRuntimePort,
  ensureRuntimeInstalled,
  isLoopbackPortFree,
  isOwnRuntimeCommand,
  isRuntimeInstalled,
  OLLAMA_RUNTIME_PIN,
  parseInferenceComputeTotal,
  removeLocalModelFiles,
  measureModelStore,
  removePartialModelBlobs,
  RUNTIME_CTX_CHECKPOINTS,
  RUNTIME_DOWNLOAD_RETRIES,
  RUNTIME_HOST_PROMPT_CACHE_MIB,
  RUNTIME_KEEP_ALIVE,
  RUNTIME_KV_CACHE_TYPE,
  RUNTIME_MAX_RESTARTS,
  RUNTIME_PORT_FIRST,
  RUNTIME_PORT_SPAN,
  runtimeEnv,
  type RuntimeDownloadProgress,
} from '../src/local-model/runtime.js';
import type { LocalModelRuntimePin } from '../src/types.js';
import {
  buildFakeArchive,
  fakeRuntimeLog,
  INFERENCE_COMPUTE_LINE_MACBOOK,
  MACBOOK_MEASURED_TOTAL_BYTES,
  REAL_INFERENCE_COMPUTE_LINE_MAC_MINI,
  REAL_VRAM_DEFAULT_CONTEXT_LINE_MAC_MINI,
  startFakeOllama,
  type FakeOllama,
} from './fixtures/fake-ollama.js';

const execFileAsync = promisify(execFile);

let fake: FakeOllama | undefined;
let paths: LocalModelPaths;
const cleanup: string[] = [];

beforeEach(() => {
  // Under the temp HOME test/setup.ts gives this file.
  paths = localModelPaths('0.40.15');
});

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  await rm(paths.root, { recursive: true, force: true });
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A temp folder outside the local model folder, removed after the test. */
async function outsideDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'local-model-outside-'));
  cleanup.push(dir);
  return dir;
}

/** What `ensureRuntimeInstalled()` needs to reach the fake: the global `fetch`, and no waiting. */
function deps(waits: number[] = []): { fetch: typeof fetch; sleep: (ms: number) => Promise<void> } {
  return {
    fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

/** The archive requests the fake saw, as the `Range` header of each (`undefined` without one). */
function archiveRanges(server: FakeOllama): (string | undefined)[] {
  return server.requests
    .filter((request) => request.path === '/download/ollama-darwin.tgz')
    .map((request) => request.headers.range as string | undefined);
}

/** A fake whose archive is about 40 KB: a runtime script plus bytes that do not compress. */
async function fakeWithLargeArchive(archive: FakeOllama['switches']['archive'] | object = {}): Promise<FakeOllama> {
  fake = await startFakeOllama({
    archive,
    archiveFiles: { ollama: '#!/bin/sh\necho "fake runtime"\n', 'lib/blob.bin': randomBytes(30_000).toString('hex') },
  });
  return fake;
}

// ---------- The pin and the constants ----------

describe('the pin', () => {
  it('is the reviewed build: version, address, size and hash', () => {
    expect(OLLAMA_RUNTIME_PIN).toEqual({
      id: 'ollama',
      version: '0.40.15',
      url: 'https://github.com/ollama/ollama/releases/download/v0.40.15/ollama-darwin.tgz',
      bytes: 185_971_671,
      sha256: '607c79d5d6315ef9d896db83adde736a4c0057196329843544e79b95afb260a8',
      unpackedBytes: 579_000_000,
      minMacosMajor: 14,
    });
  });

  it('cannot be changed by code that holds it', () => {
    expect(Object.isFrozen(OLLAMA_RUNTIME_PIN)).toBe(true);
    expect(() => {
      (OLLAMA_RUNTIME_PIN as { url: string }).url = 'https://example.com/other.tgz';
    }).toThrow();
    expect(OLLAMA_RUNTIME_PIN.url).toMatch(/^https:\/\/github\.com\/ollama\/ollama\/releases\/download\/v0\.40\.15\//);
  });

  it('states the limits of the supervisor and the download', () => {
    expect(RUNTIME_PORT_FIRST).toBe(11435);
    expect(RUNTIME_PORT_SPAN).toBe(20);
    expect(RUNTIME_MAX_RESTARTS).toBe(3);
    expect(RUNTIME_DOWNLOAD_RETRIES).toBe(3);
    expect(RUNTIME_KEEP_ALIVE).toBe('10m');
  });

  it('is never downloaded by a test: the default fetch refuses under vitest', async () => {
    const waits: number[] = [];
    const result = await ensureRuntimeInstalled({ deps: { sleep: async (ms) => void waits.push(ms) } });
    expect(result).toEqual({
      ok: false,
      code: 'runtime-download-failed',
      detail: 'fetch is not available under vitest: the test must inject its own',
    });
    // Refused at once, not after the retries.
    expect(waits).toEqual([]);
    expect(await isRuntimeInstalled()).toBe(false);
  });
});

// ---------- The budget line ----------

describe('parseInferenceComputeTotal', () => {
  it('reads the device total of the real line of the Mac mini', () => {
    // total="11.8 GiB": 11.8 x 1024^3, rounded down.
    expect(parseInferenceComputeTotal(REAL_INFERENCE_COMPUTE_LINE_MAC_MINI)).toBe(12_670_153_523);
    expect(12_670_153_523).toBe(Math.floor(11.8 * 1024 ** 3));
  });

  it('reads 37.4 GiB, what the MacBook reported, as 40,157,944,217 bytes', () => {
    expect(parseInferenceComputeTotal(INFERENCE_COMPUTE_LINE_MACBOOK)).toBe(40_157_944_217);
    expect(parseInferenceComputeTotal(INFERENCE_COMPUTE_LINE_MACBOOK)).toBe(MACBOOK_MEASURED_TOTAL_BYTES);
    // The two fields quoted in the measurement notes are enough.
    expect(parseInferenceComputeTotal('msg="inference compute" total="37.4 GiB" available="37.4 GiB"')).toBe(
      40_157_944_217
    );
  });

  it('does not read the line that follows it, which carries the total under another key', () => {
    expect(parseInferenceComputeTotal(REAL_VRAM_DEFAULT_CONTEXT_LINE_MAC_MINI)).toBeUndefined();
    // Not even when that key sits on an "inference compute" line.
    expect(
      parseInferenceComputeTotal('msg="inference compute" total_vram="11.8 GiB" subtotal="1 GiB"')
    ).toBeUndefined();
  });

  it('finds exactly one line of a start-up log', () => {
    const totals = fakeRuntimeLog('37.4 GiB').map(parseInferenceComputeTotal);
    expect(totals).toEqual([undefined, undefined, 40_157_944_217, undefined]);
  });

  it('reads the binary units the runtime prints', () => {
    const line = (total: string): string => `level=INFO msg="inference compute" id=0 total="${total}" available="1 B"`;
    expect(parseInferenceComputeTotal(line('512 B'))).toBe(512);
    expect(parseInferenceComputeTotal(line('8 KiB'))).toBe(8192);
    expect(parseInferenceComputeTotal(line('12713.1 MiB'))).toBe(Math.floor(12713.1 * 1024 ** 2));
    expect(parseInferenceComputeTotal(line('96 GiB'))).toBe(96 * 1024 ** 3);
    expect(parseInferenceComputeTotal(line('1.5 TiB'))).toBe(1.5 * 1024 ** 4);
    // Without the space between the number and the unit.
    expect(parseInferenceComputeTotal(line('16GiB'))).toBe(16 * 1024 ** 3);
  });

  it('answers undefined for anything it does not understand, and never throws', () => {
    const line = (total: string): string => `msg="inference compute" total="${total}"`;
    for (const text of [
      '',
      'total="37.4 GiB"',
      'msg="inference compute"',
      line(''),
      line('GiB'),
      line('37.4'),
      line('37.4 GB'),
      line('-1 GiB'),
      line('0 GiB'),
      line('1e9 GiB'),
      line('NaN GiB'),
      'msg="inference compute" total=37.4GiB',
      'msg="discovering available GPUs..."',
    ]) {
      expect(parseInferenceComputeTotal(text), JSON.stringify(text)).toBeUndefined();
    }
  });
});

// ---------- The environment ----------

describe('runtimeEnv', () => {
  const input = (source: NodeJS.ProcessEnv): Parameters<typeof runtimeEnv>[0] => ({
    source,
    home: '/data/local-model/home',
    modelsDir: '/data/local-model/models',
    port: 11435,
    contextLength: 131072,
  });

  /** A server environment with everything a real one may hold. */
  const SERVER_ENV: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/Users/arkon',
    TMPDIR: '/var/folders/xy/T/',
    LANG: 'de_CH.UTF-8',
    HTTP_PROXY: 'http://proxy:3128',
    HTTPS_PROXY: 'http://proxy:3128',
    NO_PROXY: 'localhost,127.0.0.1',
    http_proxy: 'http://proxy-lower:3128',
    https_proxy: 'http://proxy-lower:3128',
    no_proxy: 'localhost',
    // Codeman's own secrets and switches.
    CODEMAN_PASSWORD: 'hunter2',
    CODEMAN_USERNAME: 'admin',
    CODEMAN_MUX: '1',
    CODEMAN_API_URL: 'http://127.0.0.1:3000',
    // The user's settings for their OWN runtime.
    OLLAMA_HOST: '0.0.0.0:11434',
    OLLAMA_ORIGINS: '*',
    OLLAMA_MODELS: '/Users/arkon/.ollama/models',
    OLLAMA_DEBUG: '1',
    OLLAMA_DEBUG_LOG_REQUESTS: '1',
    OLLAMA_KEEP_ALIVE: '-1',
    OLLAMA_NUM_PARALLEL: '8',
    OLLAMA_MAX_LOADED_MODELS: '0',
    OLLAMA_CONTEXT_LENGTH: '4096',
    OLLAMA_NO_CLOUD: '0',
    OLLAMA_REMOTES: 'evil.example',
    OLLAMA_AUTH: '1',
    LLAMA_ARG_CACHE_RAM: '0',
    LLAMA_ARG_CTX_CHECKPOINTS: '64',
    // Other secrets a server environment carries.
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-secret',
    GITHUB_TOKEN: 'ghp_secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    SSH_AUTH_SOCK: '/tmp/ssh.sock',
    USER: 'arkon',
    SHELL: '/bin/zsh',
    LC_ALL: 'C',
    NODE_OPTIONS: '--inspect',
    DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
  };

  it('holds exactly the allowlist: what is copied, the private HOME, and eleven settings', () => {
    expect(runtimeEnv(input(SERVER_ENV))).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: '/var/folders/xy/T/',
      LANG: 'de_CH.UTF-8',
      HTTP_PROXY: 'http://proxy:3128',
      HTTPS_PROXY: 'http://proxy:3128',
      NO_PROXY: 'localhost,127.0.0.1',
      http_proxy: 'http://proxy-lower:3128',
      https_proxy: 'http://proxy-lower:3128',
      no_proxy: 'localhost',
      HOME: '/data/local-model/home',
      OLLAMA_HOST: '127.0.0.1:11435',
      OLLAMA_MODELS: '/data/local-model/models',
      OLLAMA_CONTEXT_LENGTH: '131072',
      OLLAMA_NO_CLOUD: '1',
      OLLAMA_KEEP_ALIVE: '10m',
      OLLAMA_NUM_PARALLEL: '1',
      OLLAMA_MAX_LOADED_MODELS: '1',
      // The memory settings the catalogue's llamacpp rows are computed for.
      OLLAMA_KV_CACHE_TYPE: 'q8_0',
      OLLAMA_FLASH_ATTENTION: '1',
      LLAMA_ARG_CACHE_RAM: '1024',
      LLAMA_ARG_CTX_CHECKPOINTS: '8',
    });
  });

  it('sets the llama.cpp memory settings from the exported constants, never from the server', () => {
    expect(RUNTIME_KV_CACHE_TYPE).toBe('q8_0');
    expect(RUNTIME_HOST_PROMPT_CACHE_MIB).toBe(1024);
    expect(RUNTIME_CTX_CHECKPOINTS).toBe(8);
    const env = runtimeEnv(input(SERVER_ENV));
    expect(env.OLLAMA_KV_CACHE_TYPE).toBe(RUNTIME_KV_CACHE_TYPE);
    expect(env.LLAMA_ARG_CACHE_RAM).toBe(String(RUNTIME_HOST_PROMPT_CACHE_MIB));
    expect(env.LLAMA_ARG_CTX_CHECKPOINTS).toBe(String(RUNTIME_CTX_CHECKPOINTS));
    // The server's own `LLAMA_ARG_CACHE_RAM=0` and `LLAMA_ARG_CTX_CHECKPOINTS=64`, and a user's
    // q4_0 cache, lose against ours.
    const env2 = runtimeEnv(input({ ...SERVER_ENV, OLLAMA_KV_CACHE_TYPE: 'q4_0', OLLAMA_FLASH_ATTENTION: '0' }));
    expect([
      env2.OLLAMA_KV_CACHE_TYPE,
      env2.OLLAMA_FLASH_ATTENTION,
      env2.LLAMA_ARG_CACHE_RAM,
      env2.LLAMA_ARG_CTX_CHECKPOINTS,
    ]).toEqual(['q8_0', '1', '1024', '8']);
  });

  it('lets no CODEMAN_ variable through, the password least of all', () => {
    const env = runtimeEnv(input(SERVER_ENV));
    expect(Object.keys(env).filter((name) => name.startsWith('CODEMAN_'))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain('hunter2');
  });

  it("lets none of the user's own OLLAMA_ settings through: every one is ours or absent", () => {
    const env = runtimeEnv(input(SERVER_ENV));
    expect(
      Object.keys(env)
        .filter((name) => name.startsWith('OLLAMA_'))
        .sort()
    ).toEqual([
      'OLLAMA_CONTEXT_LENGTH',
      'OLLAMA_FLASH_ATTENTION',
      'OLLAMA_HOST',
      'OLLAMA_KEEP_ALIVE',
      'OLLAMA_KV_CACHE_TYPE',
      'OLLAMA_MAX_LOADED_MODELS',
      'OLLAMA_MODELS',
      'OLLAMA_NO_CLOUD',
      'OLLAMA_NUM_PARALLEL',
    ]);
    // The inherited values lost against ours, and the ones we do not set are gone.
    expect(env.OLLAMA_HOST).toBe('127.0.0.1:11435');
    expect(env.OLLAMA_KEEP_ALIVE).toBe('10m');
    expect(env.OLLAMA_MAX_LOADED_MODELS).toBe('1');
    for (const name of [
      'OLLAMA_ORIGINS',
      'OLLAMA_DEBUG',
      'OLLAMA_DEBUG_LOG_REQUESTS',
      'OLLAMA_REMOTES',
      'OLLAMA_AUTH',
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
    // The server's `LLAMA_ARG_CACHE_RAM=0` is not copied: the value is ours.
    expect(env.LLAMA_ARG_CACHE_RAM).toBe('1024');
  });

  it('carries no secret and no value of the server that is not on the list', () => {
    const env = runtimeEnv(input(SERVER_ENV));
    const text = JSON.stringify(env);
    for (const secret of ['sk-ant-secret', 'sk-secret', 'ghp_secret', 'aws-secret', 'evil', '/Users/arkon']) {
      expect(text, secret).not.toContain(secret);
    }
    // Whatever is in the result and came from the server is one of the nine copied names.
    const copied = [
      'PATH',
      'TMPDIR',
      'LANG',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ];
    for (const [name, value] of Object.entries(env)) {
      if (SERVER_ENV[name] === value) expect(copied, name).toContain(name);
    }
  });

  it('binds the loopback address only, on the port it is given', () => {
    for (const port of [11435, 11454, 40123]) {
      expect(runtimeEnv({ ...input({}), port }).OLLAMA_HOST).toBe(`127.0.0.1:${port}`);
    }
    expect(runtimeEnv({ ...input({}), contextLength: 65536 }).OLLAMA_CONTEXT_LENGTH).toBe('65536');
  });

  it('leaves out what the server does not have, and sets the rest all the same', () => {
    expect(Object.keys(runtimeEnv(input({}))).sort()).toEqual([
      'HOME',
      'LLAMA_ARG_CACHE_RAM',
      'LLAMA_ARG_CTX_CHECKPOINTS',
      'OLLAMA_CONTEXT_LENGTH',
      'OLLAMA_FLASH_ATTENTION',
      'OLLAMA_HOST',
      'OLLAMA_KEEP_ALIVE',
      'OLLAMA_KV_CACHE_TYPE',
      'OLLAMA_MAX_LOADED_MODELS',
      'OLLAMA_MODELS',
      'OLLAMA_NO_CLOUD',
      'OLLAMA_NUM_PARALLEL',
    ]);
    // An empty value is not copied either.
    expect(runtimeEnv(input({ PATH: '', LANG: undefined }))).not.toHaveProperty('PATH');
  });

  it('is pure: the server environment is not changed', () => {
    const source = { ...SERVER_ENV };
    runtimeEnv(input(source));
    expect(source).toEqual(SERVER_ENV);
  });
});

// ---------- Whose process is it ----------

describe('isOwnRuntimeCommand', () => {
  const root = '/Users/arkon/.codeman/local-model/runtime';

  it('knows a runtime under our folder by its command line', () => {
    expect(isOwnRuntimeCommand(`${root}/ollama-0.40.15/ollama serve`, root)).toBe(true);
    expect(isOwnRuntimeCommand(`  ${root}/ollama-0.40.15/ollama serve\n`, root)).toBe(true);
    // Another version of ours, and a folder name with a space in it.
    expect(isOwnRuntimeCommand(`${root}/ollama-0.39.0/ollama serve`, root)).toBe(true);
    const spaced = '/Users/Jane Doe/.codeman/local-model/runtime';
    expect(isOwnRuntimeCommand(`${spaced}/ollama-0.40.15/ollama serve`, spaced)).toBe(true);
    expect(isOwnRuntimeCommand(`${root}/ollama-0.40.15/ollama serve`, `${root}/`)).toBe(true);
  });

  it('reads /private in front of a path as the same path', () => {
    const temp = '/var/folders/xy/T/codeman/local-model/runtime';
    expect(isOwnRuntimeCommand(`/private${temp}/ollama-0.40.15/ollama serve`, temp)).toBe(true);
    expect(isOwnRuntimeCommand(`${temp}/ollama-0.40.15/ollama serve`, `/private${temp}`)).toBe(true);
  });

  it('does not take any other process for ours', () => {
    for (const command of [
      // A runtime the user started.
      '/usr/local/bin/ollama serve',
      '/Applications/Ollama.app/Contents/Resources/ollama serve',
      'ollama serve',
      // Our folder is only an argument, or a prefix of another folder.
      `/bin/sh ${root}/ollama-0.40.15/ollama serve`,
      `/usr/bin/tail -f ${root}/log`,
      `${root}-other/ollama-0.40.15/ollama serve`,
      `${root}`,
      // A way back out of the folder.
      `${root}/../../../../usr/local/bin/ollama serve`,
      `${root}/ollama-0.40.15/../../../evil serve`,
      '',
    ]) {
      expect(isOwnRuntimeCommand(command, root), command).toBe(false);
    }
    expect(isOwnRuntimeCommand('/anything/ollama serve', '')).toBe(false);
    expect(isOwnRuntimeCommand('relative/ollama serve', 'relative')).toBe(false);
  });
});

// ---------- The download ----------

describe('ensureRuntimeInstalled', () => {
  it('downloads, proves the hash, unpacks, and leaves a runtime that runs', async () => {
    fake = await startFakeOllama();
    const seen: RuntimeDownloadProgress[] = [];
    const result = await ensureRuntimeInstalled({
      pin: fake.pin(),
      paths,
      deps: deps(),
      onProgress: (progress) => seen.push(progress),
    });
    expect(result).toEqual({ ok: true, binaryPath: paths.binary, alreadyInstalled: false });
    expect(await isRuntimeInstalled(fake.pin(), paths)).toBe(true);
    // Unpacked by the real tar: the file is executable and is the one of the archive.
    expect((await stat(paths.binary)).mode & 0o111).not.toBe(0);
    expect((await execFileAsync(paths.binary)).stdout).toBe('fake runtime\n');
    // The archive and the temporary folder are gone; one request was enough.
    expect(existsSync(paths.archivePartial)).toBe(false);
    expect(existsSync(paths.unpackDir)).toBe(false);
    expect(archiveRanges(fake)).toEqual([undefined]);
    // Progress ends at the whole archive, measured against the pin.
    expect(seen.at(-1)).toEqual({ completedBytes: fake.archive.size, totalBytes: fake.archive.size });
    for (const progress of seen) expect(progress.totalBytes).toBe(fake.pin().bytes);
  });

  it('does nothing the second time: the runtime is already there', async () => {
    fake = await startFakeOllama();
    await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() });
    const again = await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() });
    expect(again).toEqual({ ok: true, binaryPath: paths.binary, alreadyInstalled: true });
    expect(fake.state.archiveRequests).toBe(1);
  });

  it('unpacks NOTHING when the hash is wrong, and deletes the download', async () => {
    fake = await startFakeOllama();
    const wrongPin: LocalModelRuntimePin = {
      ...fake.pin(),
      sha256: createHash('sha256').update('other').digest('hex'),
    };
    let unpacked = 0;
    const result = await ensureRuntimeInstalled({
      pin: wrongPin,
      paths,
      deps: {
        ...deps(),
        untar: async () => {
          unpacked += 1;
        },
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'runtime-damaged' });
    expect((result as { detail?: string }).detail).toContain(fake.archive.sha256);
    expect(unpacked).toBe(0);
    expect(existsSync(paths.archivePartial)).toBe(false);
    expect(existsSync(paths.unpackDir)).toBe(false);
    expect(existsSync(paths.runtimeDir)).toBe(false);
    expect(await isRuntimeInstalled(wrongPin, paths)).toBe(false);
    // The whole archive was read before the verdict: it is the hash that failed, not the size.
    expect(fake.state.archiveRequests).toBe(1);
  });

  it('compares the hash whatever the case it is written in', async () => {
    fake = await startFakeOllama();
    const upper: LocalModelRuntimePin = { ...fake.pin(), sha256: fake.archive.sha256.toUpperCase() };
    expect(await ensureRuntimeInstalled({ pin: upper, paths, deps: deps() })).toMatchObject({ ok: true });
  });

  it('continues a download that was cut, with a Range request from where the file ends', async () => {
    fake = await fakeWithLargeArchive({ cutAfterBytes: 1000 });
    const waits: number[] = [];
    const result = await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps(waits) });
    expect(result).toMatchObject({ ok: true, alreadyInstalled: false });
    // The first request from the start, the second for the rest.
    expect(archiveRanges(fake)).toEqual([undefined, 'bytes=1000-']);
    expect(waits).toEqual([500]);
    expect((await execFileAsync(paths.binary)).stdout).toBe('fake runtime\n');
  });

  it('gives up after 3 continuations and keeps the partial file for the next run', async () => {
    expect(RUNTIME_DOWNLOAD_RETRIES).toBe(3);
    fake = await fakeWithLargeArchive({ cutAfterBytes: 1000, cutTimes: Infinity });
    const waits: number[] = [];
    const result = await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps(waits) });
    expect(result).toMatchObject({ ok: false, code: 'runtime-download-failed' });
    expect((result as { detail?: string }).detail).toBeTruthy();
    // The first request and three more, each from where the last one stopped.
    expect(archiveRanges(fake)).toEqual([undefined, 'bytes=1000-', 'bytes=2000-', 'bytes=3000-']);
    expect(waits).toEqual([500, 1000, 2000]);
    expect((await stat(paths.archivePartial)).size).toBe(4000);
    expect(existsSync(paths.runtimeDir)).toBe(false);

    // "Try again": the next run continues the same file, it does not start over.
    fake.switches.archive.cutAfterBytes = undefined;
    expect(await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() })).toMatchObject({ ok: true });
    expect(archiveRanges(fake).at(-1)).toBe('bytes=4000-');
    expect((await execFileAsync(paths.binary)).stdout).toBe('fake runtime\n');
  });

  it('fails after the same number of tries when the server keeps answering an error', async () => {
    fake = await startFakeOllama({ archive: { status: 503 } });
    const waits: number[] = [];
    const result = await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps(waits) });
    expect(result).toEqual({
      ok: false,
      code: 'runtime-download-failed',
      detail: 'The download server answered HTTP 503',
    });
    expect(fake.state.archiveRequests).toBe(4);
    expect(waits).toHaveLength(3);
  });

  it('starts over when the server ignores the Range request and sends the whole archive', async () => {
    fake = await fakeWithLargeArchive({ ignoreRange: true });
    // A partial file of an earlier run: the true first 1500 bytes.
    await mkdir(paths.runtimeRoot, { recursive: true });
    await writeFile(paths.archivePartial, fake.archive.body.subarray(0, 1500));
    const result = await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() });
    expect(result).toMatchObject({ ok: true });
    expect(archiveRanges(fake)).toEqual(['bytes=1500-']);
    // Appending the whole body to the 1500 bytes would not have had the pinned hash.
    expect((await execFileAsync(paths.binary)).stdout).toBe('fake runtime\n');
  });

  it('proves the WHOLE file: a partial file that is not the start of the archive ends as damaged', async () => {
    fake = await fakeWithLargeArchive();
    await mkdir(paths.runtimeRoot, { recursive: true });
    await writeFile(paths.archivePartial, randomBytes(1500));
    const first = await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() });
    expect(first).toMatchObject({ ok: false, code: 'runtime-damaged' });
    expect(existsSync(paths.archivePartial)).toBe(false);
    expect(existsSync(paths.runtimeDir)).toBe(false);
    // The damaged file is gone, so the next run downloads from the first byte.
    expect(await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() })).toMatchObject({ ok: true });
    expect(archiveRanges(fake)).toEqual(['bytes=1500-', undefined]);
  });

  it('throws away a partial file that is larger than the archive', async () => {
    fake = await startFakeOllama();
    await mkdir(paths.runtimeRoot, { recursive: true });
    await writeFile(paths.archivePartial, randomBytes(fake.archive.size + 100));
    expect(await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() })).toMatchObject({ ok: true });
    expect(archiveRanges(fake)).toEqual([undefined]);
  });

  it('verifies a file that is already complete without asking the server', async () => {
    fake = await startFakeOllama();
    await mkdir(paths.runtimeRoot, { recursive: true });
    await writeFile(paths.archivePartial, fake.archive.body);
    expect(await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() })).toMatchObject({ ok: true });
    expect(fake.state.archiveRequests).toBe(0);
  });

  it('refuses a download whose size is not the pinned one, before it reads it', async () => {
    fake = await startFakeOllama();
    const shortPin: LocalModelRuntimePin = { ...fake.pin(), bytes: fake.archive.size - 10 };
    const result = await ensureRuntimeInstalled({ pin: shortPin, paths, deps: deps() });
    expect(result).toEqual({
      ok: false,
      code: 'runtime-damaged',
      detail: `The download is ${fake.archive.size} bytes, the pinned archive has ${fake.archive.size - 10}`,
    });
    expect(existsSync(paths.archivePartial)).toBe(false);
    expect(fake.state.archiveRequests).toBe(1);
  });

  it('refuses a body that grows past the pinned size, when the server names no size', async () => {
    fake = await startFakeOllama();
    const pin = fake.pin();
    const body = fake.archive.body;
    let unpacked = 0;
    // The right archive followed by more bytes, as a stream without a content-length.
    const endless: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(body));
            controller.enqueue(new Uint8Array(1000));
            controller.close();
          },
        }),
        { status: 200 }
      );
    const result = await ensureRuntimeInstalled({
      pin,
      paths,
      deps: {
        fetch: endless,
        sleep: async () => undefined,
        untar: async () => {
          unpacked += 1;
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      code: 'runtime-damaged',
      detail: `The download is longer than the ${pin.bytes} bytes of the pinned archive`,
    });
    expect(unpacked).toBe(0);
    expect(existsSync(paths.archivePartial)).toBe(false);
  });

  /** A server that sends the first `bytes` of the archive and then nothing more, until it is aborted. */
  function stallingFetch(server: FakeOllama, bytes: number, counter: { requests: number }): typeof fetch {
    return async (_input, init) => {
      counter.requests += 1;
      const signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(server.archive.body.subarray(0, bytes)));
            signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          },
        }),
        { status: 200 }
      );
    };
  }

  it('stops when the caller cancels, and the next run continues the same file', async () => {
    fake = await fakeWithLargeArchive();
    const counter = { requests: 0 };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const cancelled = await ensureRuntimeInstalled({
      pin: fake.pin(),
      paths,
      signal: controller.signal,
      deps: { fetch: stallingFetch(fake, 2000, counter), sleep: async () => undefined },
    });
    expect(cancelled).toEqual({ ok: false, code: 'cancelled' });
    // One request, no retry after a cancel, and what arrived is kept.
    expect(counter.requests).toBe(1);
    expect((await stat(paths.archivePartial)).size).toBe(2000);
    expect(existsSync(paths.runtimeDir)).toBe(false);

    expect(await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() })).toMatchObject({ ok: true });
    expect(archiveRanges(fake)).toEqual(['bytes=2000-']);
  });

  it('answers cancelled at once for a signal that is already aborted', async () => {
    fake = await startFakeOllama();
    const controller = new AbortController();
    controller.abort();
    const result = await ensureRuntimeInstalled({ pin: fake.pin(), paths, signal: controller.signal, deps: deps() });
    expect(result).toEqual({ ok: false, code: 'cancelled' });
    expect(fake.state.archiveRequests).toBe(0);
  });

  it('treats a download that delivers nothing as cut, a bounded number of times', async () => {
    fake = await fakeWithLargeArchive();
    const counter = { requests: 0 };
    const result = await ensureRuntimeInstalled({
      pin: fake.pin(),
      paths,
      idleTimeoutMs: 30,
      deps: { fetch: stallingFetch(fake, 500, counter), sleep: async () => undefined },
    });
    expect(result).toEqual({
      ok: false,
      code: 'runtime-download-failed',
      detail: 'The download delivered nothing for 1 s',
    });
    expect(counter.requests).toBe(4);
  });

  it('answers runtime-unpack-failed when tar fails, keeps the proven archive, and unpacks it next time', async () => {
    fake = await startFakeOllama();
    const failed = await ensureRuntimeInstalled({
      pin: fake.pin(),
      paths,
      deps: {
        ...deps(),
        untar: async () => {
          throw new Error('tar: Error opening archive: Unrecognized archive format');
        },
      },
    });
    expect(failed).toEqual({
      ok: false,
      code: 'runtime-unpack-failed',
      detail: 'tar: Error opening archive: Unrecognized archive format',
    });
    expect(existsSync(paths.unpackDir)).toBe(false);
    expect(existsSync(paths.runtimeDir)).toBe(false);
    expect((await stat(paths.archivePartial)).size).toBe(fake.archive.size);

    expect(await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() })).toMatchObject({ ok: true });
    // Not downloaded a second time.
    expect(fake.state.archiveRequests).toBe(1);
  });

  it('answers disk-full when unpacking runs out of space', async () => {
    fake = await startFakeOllama();
    const result = await ensureRuntimeInstalled({
      pin: fake.pin(),
      paths,
      deps: {
        ...deps(),
        untar: async () => {
          throw new Error("tar: ollama: Can't write: No space left on device");
        },
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'disk-full' });
  });

  it('refuses an archive that holds no runtime binary', async () => {
    fake = await startFakeOllama({ archiveFiles: { 'README.txt': 'no binary here\n' } });
    const result = await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() });
    expect(result).toEqual({
      ok: false,
      code: 'runtime-unpack-failed',
      detail: 'The archive holds no ollama binary',
    });
    expect(existsSync(paths.runtimeDir)).toBe(false);
    expect(existsSync(paths.unpackDir)).toBe(false);
  });

  it('replaces a runtime folder that an interrupted unpack left without its binary', async () => {
    fake = await startFakeOllama();
    await mkdir(paths.runtimeDir, { recursive: true });
    await writeFile(join(paths.runtimeDir, 'half-written'), 'x');
    await mkdir(paths.unpackDir, { recursive: true });
    await writeFile(join(paths.unpackDir, 'stale'), 'x');
    expect(await isRuntimeInstalled(fake.pin(), paths)).toBe(false);
    expect(await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() })).toMatchObject({ ok: true });
    expect(existsSync(join(paths.runtimeDir, 'half-written'))).toBe(false);
    expect(existsSync(join(paths.runtimeDir, 'stale'))).toBe(false);
    expect(await readFile(paths.binary, 'utf8')).toContain('fake runtime');
  });

  it('writes the download where only the owner can read it, inside the one folder', async () => {
    fake = await fakeWithLargeArchive({ cutAfterBytes: 1000, cutTimes: Infinity });
    await ensureRuntimeInstalled({ pin: fake.pin(), paths, deps: deps() });
    expect((await stat(paths.archivePartial)).mode & 0o077).toBe(0);
    expect(paths.archivePartial.startsWith(paths.root)).toBe(true);
  });

  it('never throws: a version that is no version is an answer', async () => {
    const badPin = { ...OLLAMA_RUNTIME_PIN, version: '../../etc' };
    expect(await isRuntimeInstalled(badPin)).toBe(false);
    expect(await ensureRuntimeInstalled({ pin: badPin, deps: deps() })).toMatchObject({
      ok: false,
      code: 'runtime-download-failed',
    });
  });
});

// ---------- The port ----------

describe('chooseRuntimePort', () => {
  let holder: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (holder ? holder.close(() => resolve()) : resolve()));
    holder = undefined;
  });

  /** Binds a loopback port the system picks and keeps it. */
  async function holdPort(): Promise<number> {
    holder = createServer();
    await new Promise<void>((resolve) => holder?.listen(0, '127.0.0.1', () => resolve()));
    return (holder.address() as AddressInfo).port;
  }

  it('takes the first port of the span that is free, in order', async () => {
    const asked: number[] = [];
    const port = await chooseRuntimePort({
      isFree: async (candidate) => {
        asked.push(candidate);
        return candidate >= 11438;
      },
    });
    expect(port).toBe(11438);
    expect(asked).toEqual([11435, 11436, 11437, 11438]);
  });

  it('starts at 11435 and tries 20 ports, never 11434', async () => {
    const asked: number[] = [];
    const port = await chooseRuntimePort({
      isFree: async (candidate) => {
        asked.push(candidate);
        return false;
      },
    });
    expect(port).toBeUndefined();
    expect(asked).toHaveLength(20);
    expect(asked[0]).toBe(11435);
    expect(asked.at(-1)).toBe(11454);
    expect(asked).not.toContain(11434);
  });

  it('skips the ports it is told to avoid: "Use another port"', async () => {
    const asked: number[] = [];
    const port = await chooseRuntimePort({
      avoid: [11435, 11436],
      isFree: async (candidate) => {
        asked.push(candidate);
        return true;
      },
    });
    expect(port).toBe(11437);
    expect(asked).toEqual([11437]);
  });

  it('does not take a port whose probe failed for free', async () => {
    const port = await chooseRuntimePort({
      first: 100,
      span: 3,
      isFree: async (candidate) => {
        if (candidate === 100) throw new Error('EACCES');
        return candidate === 102;
      },
    });
    expect(port).toBe(102);
  });

  it('decides by BINDING: a held port is not free, and is free again once it is let go', async () => {
    const port = await holdPort();
    expect(await isLoopbackPortFree(port)).toBe(false);
    expect(await chooseRuntimePort({ first: port, span: 1 })).toBeUndefined();
    await new Promise<void>((resolve) => holder?.close(() => resolve()));
    holder = undefined;
    expect(await isLoopbackPortFree(port)).toBe(true);
    expect(await chooseRuntimePort({ first: port, span: 1 })).toBe(port);
    // The probe let go of it again: it can be bound right away.
    expect(await isLoopbackPortFree(port)).toBe(true);
  });

  it('calls a number that is no port not free', async () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN])
      expect(await isLoopbackPortFree(port), String(port)).toBe(false);
  });
});

// ---------- The removal ----------

describe('removeLocalModelFiles', () => {
  /** Everything an install leaves on disk, plus the state file beside the folder. */
  async function installTree(): Promise<void> {
    await mkdir(join(paths.runtimeDir, 'lib'), { recursive: true });
    await writeFile(paths.binary, '#!/bin/sh\n');
    await writeFile(join(paths.runtimeDir, 'lib', 'libmlx.dylib'), 'x');
    await mkdir(join(paths.runtimeRoot, 'ollama-0.39.0'), { recursive: true });
    await writeFile(join(paths.runtimeRoot, 'ollama-0.39.0', 'ollama'), 'old');
    await writeFile(paths.archivePartial, 'partial');
    await mkdir(join(paths.homeDir, '.ollama'), { recursive: true });
    await writeFile(join(paths.homeDir, '.ollama', 'id_ed25519'), 'private key');
    await mkdir(join(paths.modelsDir, 'blobs'), { recursive: true });
    await writeFile(join(paths.modelsDir, 'blobs', 'sha256-abc'), 'weights');
    await writeFile(paths.stateFile, '{"schema":1,"state":"installed"}');
  }

  it('removes the runtime, every version of it, the archive and the private home, and keeps the models', async () => {
    await installTree();
    await removeLocalModelFiles({ models: false, paths });
    expect(existsSync(paths.runtimeRoot)).toBe(false);
    expect(existsSync(paths.homeDir)).toBe(false);
    expect(await readFile(join(paths.modelsDir, 'blobs', 'sha256-abc'), 'utf8')).toBe('weights');
    // The folder still holds the models, so it stays.
    expect(existsSync(paths.root)).toBe(true);
  });

  it('removes the models too when asked, and then the folder itself', async () => {
    await installTree();
    await removeLocalModelFiles({ models: true, paths });
    expect(existsSync(paths.modelsDir)).toBe(false);
    expect(existsSync(paths.root)).toBe(false);
  });

  it('leaves the state file alone: that is the business of its one writer', async () => {
    await installTree();
    await removeLocalModelFiles({ models: true, paths });
    expect(await readFile(paths.stateFile, 'utf8')).toBe('{"schema":1,"state":"installed"}');
    await rm(paths.stateFile, { force: true });
  });

  it('is fine with nothing to remove, and can be run twice', async () => {
    await removeLocalModelFiles({ models: true, paths });
    await installTree();
    await removeLocalModelFiles({ models: true, paths });
    await removeLocalModelFiles({ models: true, paths });
    expect(existsSync(paths.root)).toBe(false);
    await rm(paths.stateFile, { force: true });
  });

  it('keeps a folder of the root that is not ours', async () => {
    await installTree();
    await mkdir(join(paths.root, 'notes'), { recursive: true });
    await writeFile(join(paths.root, 'notes', 'mine.txt'), 'keep');
    await removeLocalModelFiles({ models: true, paths });
    expect(await readFile(join(paths.root, 'notes', 'mine.txt'), 'utf8')).toBe('keep');
    await rm(paths.stateFile, { force: true });
  });

  it('unlinks a symlink in the place of a folder and never deletes what it points at', async () => {
    const outside = await outsideDir();
    await writeFile(join(outside, 'precious.gguf'), 'the only copy');
    await mkdir(paths.root, { recursive: true });
    // The model store was moved to another disk and linked back.
    await symlink(outside, paths.modelsDir);
    await removeLocalModelFiles({ models: true, paths });
    expect(existsSync(paths.modelsDir)).toBe(false);
    expect(await readFile(join(outside, 'precious.gguf'), 'utf8')).toBe('the only copy');
  });

  it('refuses a local model folder that is itself a symlink, and deletes nothing behind it', async () => {
    // <data dir>/local-model is a link to a folder somewhere else that happens to hold the
    // three names this feature deletes.
    const elsewhere = await outsideDir();
    await mkdir(join(elsewhere, 'home'), { recursive: true });
    await writeFile(join(elsewhere, 'home', 'thesis.txt'), 'the only copy');
    await mkdir(join(elsewhere, 'runtime'), { recursive: true });
    await mkdir(join(elsewhere, 'models', 'blobs'), { recursive: true });
    await writeFile(join(elsewhere, 'models', 'blobs', 'sha256-abc'), 'weights');
    await mkdir(join(paths.root, '..'), { recursive: true });
    await symlink(elsewhere, paths.root);
    try {
      await expect(removeLocalModelFiles({ models: true, paths })).rejects.toThrow(/symbolic link/);
      expect(await readFile(join(elsewhere, 'home', 'thesis.txt'), 'utf8')).toBe('the only copy');
      expect(await readFile(join(elsewhere, 'models', 'blobs', 'sha256-abc'), 'utf8')).toBe('weights');
      expect(existsSync(join(elsewhere, 'runtime'))).toBe(true);
      // The partial blobs are not deleted through the link either.
      await writeFile(join(elsewhere, 'models', 'blobs', 'sha256-def-partial'), 'half');
      expect(await removePartialModelBlobs(paths)).toBe(0);
      expect(existsSync(join(elsewhere, 'models', 'blobs', 'sha256-def-partial'))).toBe(true);
    } finally {
      // The link itself, never what it points at.
      await rm(paths.root, { force: true });
    }
  });

  it('refuses a local model folder that is a file', async () => {
    await mkdir(join(paths.root, '..'), { recursive: true });
    await writeFile(paths.root, 'not a folder');
    try {
      await expect(removeLocalModelFiles({ models: true, paths })).rejects.toThrow(/not a folder/);
    } finally {
      await rm(paths.root, { force: true });
    }
  });

  it('removes a symlink it meets inside a folder, not the tree behind it', async () => {
    const outside = await outsideDir();
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await mkdir(paths.homeDir, { recursive: true });
    await symlink(outside, join(paths.homeDir, 'link-out'));
    await removeLocalModelFiles({ models: false, paths });
    expect(existsSync(paths.homeDir)).toBe(false);
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses a path that is not inside the one folder, and deletes nothing', async () => {
    const outside = await outsideDir();
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await installTree();
    const cases: Partial<LocalModelPaths>[] = [
      { runtimeRoot: outside },
      { homeDir: outside },
      { modelsDir: outside },
      // The folder itself, and a way back out of it.
      { runtimeRoot: paths.root },
      { homeDir: join(paths.root, '..', 'elsewhere') },
    ];
    for (const change of cases) {
      await expect(removeLocalModelFiles({ models: true, paths: { ...paths, ...change } })).rejects.toThrow(/Refusing/);
    }
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    // A refusal deletes NOTHING: every folder is judged before the first one is removed.
    expect(await readFile(paths.binary, 'utf8')).toBe('#!/bin/sh\n');
    expect(await readFile(join(paths.homeDir, '.ollama', 'id_ed25519'), 'utf8')).toBe('private key');
    expect(await readFile(join(paths.modelsDir, 'blobs', 'sha256-abc'), 'utf8')).toBe('weights');
    await rm(paths.stateFile, { force: true });
  });

  it('refuses a folder whose real place is outside the real root', async () => {
    // The root is real, but `runtime` inside it is reached through a linked parent.
    const outside = await outsideDir();
    await mkdir(join(outside, 'runtime'), { recursive: true });
    await writeFile(join(outside, 'runtime', 'keep.txt'), 'keep');
    await mkdir(paths.root, { recursive: true });
    await symlink(outside, join(paths.root, 'nested'));
    const twisted: LocalModelPaths = { ...paths, runtimeRoot: join(paths.root, 'nested', 'runtime') };
    await expect(removeLocalModelFiles({ models: false, paths: twisted })).rejects.toThrow(/Refusing/);
    expect(await readFile(join(outside, 'runtime', 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe('removePartialModelBlobs', () => {
  const blob = (name: string): string => join(paths.modelsDir, 'blobs', name);

  it('deletes what an interrupted download left, and keeps every finished blob and the manifests', async () => {
    await mkdir(join(paths.modelsDir, 'blobs'), { recursive: true });
    await mkdir(join(paths.modelsDir, 'manifests', 'registry.ollama.ai'), { recursive: true });
    await writeFile(blob('sha256-aaa'), 'finished weights');
    await writeFile(blob('sha256-bbb-partial'), '12345');
    await writeFile(blob('sha256-bbb-partial-0'), '678');
    await writeFile(blob('sha256-bbb-partial-1'), '9');
    await writeFile(join(paths.modelsDir, 'manifests', 'registry.ollama.ai', 'latest'), '{}');

    // The bytes that were freed: 5 + 3 + 1.
    expect(await removePartialModelBlobs(paths)).toBe(9);
    expect(existsSync(blob('sha256-bbb-partial'))).toBe(false);
    expect(existsSync(blob('sha256-bbb-partial-0'))).toBe(false);
    expect(existsSync(blob('sha256-bbb-partial-1'))).toBe(false);
    expect(await readFile(blob('sha256-aaa'), 'utf8')).toBe('finished weights');
    expect(existsSync(join(paths.modelsDir, 'manifests', 'registry.ollama.ai', 'latest'))).toBe(true);
  });

  it('is fine without a model store, and deletes nothing a second time', async () => {
    expect(await removePartialModelBlobs(paths)).toBe(0);
    await mkdir(join(paths.modelsDir, 'blobs'), { recursive: true });
    await writeFile(blob('sha256-ccc-partial'), 'xx');
    expect(await removePartialModelBlobs(paths)).toBe(2);
    expect(await removePartialModelBlobs(paths)).toBe(0);
  });

  it('touches only regular files directly in the blob folder', async () => {
    const outside = await outsideDir();
    await writeFile(join(outside, 'keep-partial'), 'keep');
    await mkdir(join(paths.modelsDir, 'blobs', 'a-partial-folder'), { recursive: true });
    await writeFile(join(paths.modelsDir, 'blobs', 'a-partial-folder', 'inside-partial'), 'keep');
    // A link whose name carries the marker: the link stays, and so does what it points at.
    await symlink(join(outside, 'keep-partial'), blob('sha256-ddd-partial'));
    expect(await removePartialModelBlobs(paths)).toBe(0);
    expect(await readFile(join(outside, 'keep-partial'), 'utf8')).toBe('keep');
    expect(existsSync(join(paths.modelsDir, 'blobs', 'a-partial-folder', 'inside-partial'))).toBe(true);
  });

  it('leaves a blob folder alone that is a symlink to somewhere else', async () => {
    const outside = await outsideDir();
    await writeFile(join(outside, 'sha256-eee-partial'), "half of somebody else's model");
    await mkdir(paths.modelsDir, { recursive: true });
    await symlink(outside, join(paths.modelsDir, 'blobs'));
    expect(await removePartialModelBlobs(paths)).toBe(0);
    expect(existsSync(join(outside, 'sha256-eee-partial'))).toBe(true);
  });
});

describe('measureModelStore', () => {
  const blob = (name: string): string => join(paths.modelsDir, 'blobs', name);

  it('is the sizes of the files in the blob folder, a download that was interrupted included', async () => {
    await mkdir(join(paths.modelsDir, 'blobs'), { recursive: true });
    await mkdir(join(paths.modelsDir, 'manifests', 'registry.ollama.ai'), { recursive: true });
    await writeFile(blob('sha256-aaa'), 'x'.repeat(1000));
    await writeFile(blob('sha256-bbb'), 'y'.repeat(250));
    await writeFile(blob('sha256-ccc-partial'), 'z'.repeat(40));
    // The manifests are a few kilobytes beside gigabytes of layers: left out.
    await writeFile(join(paths.modelsDir, 'manifests', 'registry.ollama.ai', 'latest'), '{"layers":[]}');
    expect(await measureModelStore(paths)).toBe(1290);
  });

  it('is 0 without a model store, without a blob folder and for an empty one, and never throws', async () => {
    expect(await measureModelStore(paths)).toBe(0);
    await mkdir(paths.modelsDir, { recursive: true });
    expect(await measureModelStore(paths)).toBe(0);
    await mkdir(join(paths.modelsDir, 'blobs'), { recursive: true });
    expect(await measureModelStore(paths)).toBe(0);
  });

  it('reads nothing and changes nothing: the store is as it was afterwards', async () => {
    await mkdir(join(paths.modelsDir, 'blobs'), { recursive: true });
    await writeFile(blob('sha256-aaa'), 'weights');
    await writeFile(blob('sha256-bbb-partial'), 'half');
    await measureModelStore(paths);
    expect(await readFile(blob('sha256-aaa'), 'utf8')).toBe('weights');
    expect(await readFile(blob('sha256-bbb-partial'), 'utf8')).toBe('half');
  });

  it('counts only regular files directly in the blob folder, and follows no link', async () => {
    const outside = await outsideDir();
    await writeFile(join(outside, 'huge'), 'h'.repeat(5000));
    await mkdir(join(paths.modelsDir, 'blobs', 'a-folder'), { recursive: true });
    await writeFile(join(paths.modelsDir, 'blobs', 'a-folder', 'inside'), 'i'.repeat(700));
    await symlink(join(outside, 'huge'), blob('sha256-link'));
    await writeFile(blob('sha256-aaa'), 'x'.repeat(10));
    // The folder's file and the link's target are somebody else's: not counted.
    expect(await measureModelStore(paths)).toBe(10);
  });

  it('a blob folder, a model store or a root that is a symlink counts as empty', async () => {
    const outside = await outsideDir();
    await writeFile(join(outside, 'sha256-eee'), 'e'.repeat(900));
    await mkdir(paths.modelsDir, { recursive: true });
    await symlink(outside, join(paths.modelsDir, 'blobs'));
    expect(await measureModelStore(paths)).toBe(0);
    // A path that is not inside the local model folder is refused before anything is read.
    expect(await measureModelStore({ ...paths, modelsDir: outside })).toBe(0);
  });
});
