/**
 * @fileoverview Tests for test/fixtures/fake-ollama.ts, the fake model runtime every local
 * model test runs against. A fake that answers in the wrong shape makes every test built on
 * it prove nothing, so this file pins each answer and each switch once.
 *
 * It also shows how the fake is used: `startFakeOllama()` for a client test, and
 * `createFakeOllama()` plus `fake.spawn` and `freeLoopbackPort()` for a supervisor test.
 *
 * Port: none fixed (the fake listens on 0; the spawn test reserves a free port first).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFakeArchive,
  createFakeOllama,
  DEFAULT_FAKE_MODEL,
  fakeRuntimeLog,
  FakeRuntimeChild,
  freeLoopbackPort,
  INFERENCE_COMPUTE_LINE_MACBOOK,
  MACBOOK_MEASURED_TOTAL_BYTES,
  REAL_INFERENCE_COMPUTE_LINE_MAC_MINI,
  REAL_PULL_ERROR_LINE,
  startFakeOllama,
  type FakeOllama,
} from './fixtures/fake-ollama.js';

const execFileAsync = promisify(execFile);

let fake: FakeOllama | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** Every line of a pull, parsed. `cut` is true when the body ended in an error instead of a clean end. */
async function pull(target: FakeOllama, modelId = DEFAULT_FAKE_MODEL.id): Promise<{ lines: any[]; cut: boolean }> {
  const res = await fetch(`${target.baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, stream: true }),
  });
  let text = '';
  let cut = false;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      text += decoder.decode(chunk, { stream: true });
    }
  } catch {
    cut = true;
  }
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  return { lines, cut };
}

async function getJson(target: FakeOllama, path: string): Promise<any> {
  return (await fetch(`${target.baseUrl}${path}`)).json();
}

async function chat(target: FakeOllama, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${target.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: DEFAULT_FAKE_MODEL.id, messages: [{ role: 'user', content: 'ping' }], ...body }),
  });
  return { status: res.status, json: await res.json() };
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

describe('the fake runtime: listings', () => {
  it('answers the version and an empty store in the real shapes', async () => {
    fake = await startFakeOllama();
    expect(fake.port).toBeGreaterThan(0);
    expect(await (await fetch(`${fake.baseUrl}/`)).text()).toBe('Ollama is running');
    expect(await getJson(fake, '/api/version')).toEqual({ version: '0.40.15' });
    expect(await getJson(fake, '/api/tags')).toEqual({ models: [] });
    expect(await getJson(fake, '/api/ps')).toEqual({ models: [] });
    // The real runtime answers `data: null`, not an empty list, when it has no model.
    expect(await getJson(fake, '/v1/models')).toEqual({ object: 'list', data: null });
  });

  it('lists an installed model with the digest, format and runner a Mac reports', async () => {
    fake = await startFakeOllama({ installed: true });
    const tags = await getJson(fake, '/api/tags');
    expect(tags.models).toHaveLength(1);
    expect(tags.models[0]).toMatchObject({
      name: 'qwen3.6:35b-a3b',
      size: 23_105_798_956,
      digest: '0ce5ff81f9ffdf89dd8192ca7b5d34cefd8996a875b3aaaaafaf5c4813569eba',
      details: { format: 'safetensors', quantization_level: 'nvfp4', runner: 'mlx' },
      capabilities: ['completion', 'vision', 'tools', 'thinking'],
    });
    expect((await getJson(fake, '/v1/models')).data.map((m: { id: string }) => m.id)).toEqual(['qwen3.6:35b-a3b']);
  });

  it('records every request with its parsed body', async () => {
    fake = await startFakeOllama({ installed: true });
    await chat(fake, { reasoning_effort: 'none', max_tokens: 16 });
    expect(fake.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/v1/chat/completions',
      body: { model: 'qwen3.6:35b-a3b', reasoning_effort: 'none', max_tokens: 16 },
    });
  });
});

describe('the fake runtime: pull', () => {
  it('streams the MLX line shape of a Mac and installs the model', async () => {
    fake = await startFakeOllama({ pull: { progressLines: 4 } });
    const { lines, cut } = await pull(fake);
    expect(cut).toBe(false);
    expect(lines[0]).toEqual({ status: 'pulling manifest' });
    expect(lines[1]).toEqual({ status: 'pulling model', digest: 'sha256:model', total: 23_105_798_956, completed: 0 });
    expect(lines.slice(-3)).toEqual([
      { status: 'pulling model', digest: 'sha256:model', total: 23_105_798_956, completed: 23_105_798_956 },
      { status: 'writing manifest' },
      { status: 'success' },
    ]);
    const completed = lines.filter((l) => l.status === 'pulling model').map((l) => l.completed);
    expect(completed).toEqual([...completed].sort((a, b) => a - b));
    expect(fake.state.installed).toBe(true);
    expect((await getJson(fake, '/api/tags')).models).toHaveLength(1);
  });

  it('streams as many progress lines as asked for', async () => {
    fake = await startFakeOllama({ pull: { progressLines: 5000 } });
    const { lines } = await pull(fake);
    expect(lines.filter((l) => l.status === 'pulling model')).toHaveLength(5001);
  });

  it('streams the GGUF shape: layers that announce themselves, then the digest check', async () => {
    fake = await startFakeOllama({ pull: { shape: 'gguf', progressLines: 2 } });
    const { lines } = await pull(fake);
    const large = `sha256:${DEFAULT_FAKE_MODEL.digest}`;
    // The first line of a layer has no `completed`.
    expect(lines[1]).toEqual({ status: 'pulling 0ce5ff81f9ff', digest: large, total: 23_105_798_956 - 13_383 });
    expect(lines.map((l) => l.status).slice(-3)).toEqual(['verifying sha256 digest', 'writing manifest', 'success']);
    // The totals of all layers add up to the model.
    const totals = new Map<string, number>();
    for (const l of lines) if (l.digest) totals.set(l.digest, l.total);
    expect([...totals.values()].reduce((a, b) => a + b, 0)).toBe(23_105_798_956);
  });

  it('ends on the real error line, then resumes where it stopped and succeeds', async () => {
    fake = await startFakeOllama({ pull: { fail: 'error-line', failAfterLines: 3, failTimes: 1, progressLines: 6 } });
    const first = await pull(fake);
    expect(first.cut).toBe(false);
    expect(JSON.stringify(first.lines.at(-1))).toBe(REAL_PULL_ERROR_LINE);
    expect(first.lines.some((l) => l.status === 'success')).toBe(false);
    expect(fake.state.installed).toBe(false);
    const reached = fake.state.completedBytes;
    expect(reached).toBeGreaterThan(0);

    const second = await pull(fake);
    // A resumed pull's first progress line starts at what is already on disk.
    expect(second.lines[1].completed).toBe(reached);
    expect(second.lines.at(-1)).toEqual({ status: 'success' });
    expect(fake.state.pulls).toBe(2);
  });

  it('cuts the stream without a last line', async () => {
    fake = await startFakeOllama({ pull: { fail: 'cut', failAfterLines: 2 } });
    const { lines, cut } = await pull(fake);
    expect(cut).toBe(true);
    expect(lines.some((l) => l.status === 'success' || l.error)).toBe(false);
    expect(fake.state.installed).toBe(false);
  });

  it('starts a first pull at resumeFrom', async () => {
    fake = await startFakeOllama({ pull: { resumeFrom: 197_411_434, progressLines: 2 } });
    const { lines } = await pull(fake);
    expect(lines[1].completed).toBe(197_411_434);
  });

  it('says so when the registry has no such model', async () => {
    fake = await startFakeOllama();
    const unknown = await pull(fake, 'no-such:1b');
    expect(unknown.lines.at(-1)).toEqual({ error: 'pull model manifest: file does not exist' });
    fake.switches.pull.fail = 'not-found';
    expect((await pull(fake)).lines.at(-1)).toEqual({ error: 'pull model manifest: file does not exist' });
  });

  it('stops sending when the client aborts, and remembers how far it got', async () => {
    fake = await startFakeOllama({ pull: { progressLines: 200, lineDelayMs: 5 } });
    const controller = new AbortController();
    const res = await fetch(`${fake.baseUrl}/api/pull`, {
      method: 'POST',
      body: JSON.stringify({ model: DEFAULT_FAKE_MODEL.id, stream: true }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.read().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reached = fake.state.completedBytes;
    expect(fake.state.installed).toBe(false);
    expect(reached).toBeLessThan(23_105_798_956);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.state.completedBytes).toBe(reached);
  });

  it('deletes the model', async () => {
    fake = await startFakeOllama({ installed: true });
    const del = (): Promise<Response> =>
      fetch(`${fake!.baseUrl}/api/delete`, {
        method: 'DELETE',
        body: JSON.stringify({ model: DEFAULT_FAKE_MODEL.id }),
      });
    expect((await del()).status).toBe(200);
    expect(fake.state.installed).toBe(false);
    expect((await del()).status).toBe(404);
  });
});

describe('the fake runtime: chat, the process list and the tool probe', () => {
  it('answers a plain chat and lists the model as loaded, all on the GPU', async () => {
    fake = await startFakeOllama({ installed: true });
    expect((await getJson(fake, '/api/ps')).models).toEqual([]);
    const { status, json } = await chat(fake, { reasoning_effort: 'none' });
    expect(status).toBe(200);
    expect(json.choices[0]).toEqual({
      index: 0,
      message: { role: 'assistant', content: 'pong' },
      finish_reason: 'stop',
    });
    const [loaded] = (await getJson(fake, '/api/ps')).models;
    expect(loaded).toMatchObject({ name: 'qwen3.6:35b-a3b', context_length: 131072, runner: 'mlx' });
    expect(loaded.size_vram).toBe(loaded.size);
  });

  it('can report a model that is partly off the GPU, or loaded at another context', async () => {
    fake = await startFakeOllama({ installed: true, ps: { size: 30e9, sizeVram: 20e9 } });
    await chat(fake, {});
    expect((await getJson(fake, '/api/ps')).models[0]).toMatchObject({ size: 30e9, size_vram: 20e9 });
    fake.switches.ps = { contextLength: 32768 };
    expect((await getJson(fake, '/api/ps')).models[0].context_length).toBe(32768);
    fake.switches.ps = { loaded: false };
    expect((await getJson(fake, '/api/ps')).models).toEqual([]);
  });

  it('answers 404 in the real error shape for a model it does not have', async () => {
    fake = await startFakeOllama();
    const { status, json } = await chat(fake, {});
    expect(status).toBe(404);
    expect(json).toEqual({
      error: { message: "model 'qwen3.6:35b-a3b' not found", type: 'not_found_error', param: null, code: null },
    });
  });

  it('can fail the chat that loads the model', async () => {
    fake = await startFakeOllama({ installed: true, chat: 'error' });
    expect((await chat(fake, {})).status).toBe(500);
    expect((await getJson(fake, '/api/ps')).models).toEqual([]);
  });

  it('calls the tool it was given, with arguments that parse', async () => {
    fake = await startFakeOllama({ installed: true });
    const { json } = await chat(fake, { tools: TOOLS, reasoning_effort: 'none', max_tokens: 1024 });
    const choice = json.choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls).toHaveLength(1);
    expect(choice.message.tool_calls[0]).toMatchObject({ type: 'function', function: { name: 'read_file' } });
    expect(JSON.parse(choice.message.tool_calls[0].function.arguments)).toEqual({ path: 'README.md' });
  });

  it('can answer without a tool call, run into the token limit, or send arguments that do not parse', async () => {
    fake = await startFakeOllama({ installed: true, tool: 'none' });
    let choice = (await chat(fake, { tools: TOOLS })).json.choices[0];
    expect(choice.finish_reason).toBe('stop');
    expect(choice.message.tool_calls).toBeUndefined();

    fake.switches.tool = 'length';
    choice = (await chat(fake, { tools: TOOLS })).json.choices[0];
    expect(choice.finish_reason).toBe('length');
    expect(choice.message.content).toBe('');
    expect(choice.message.tool_calls).toBeUndefined();

    fake.switches.tool = 'bad-arguments';
    choice = (await chat(fake, { tools: TOOLS })).json.choices[0];
    expect(() => JSON.parse(choice.message.tool_calls[0].function.arguments)).toThrow();
  });
});

describe('the fake runtime: the archive', () => {
  it('serves an archive whose size and hash are the pin it hands out', async () => {
    fake = await startFakeOllama();
    const pin = fake.pin();
    expect(pin.url).toBe(`${fake.baseUrl}/download/ollama-darwin.tgz`);
    const res = await fetch(pin.url);
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(body.length).toBe(pin.bytes);
    expect(createHash('sha256').update(body).digest('hex')).toBe(pin.sha256);
  });

  it('continues from a Range request', async () => {
    fake = await startFakeOllama();
    const res = await fetch(fake.pin().url, { headers: { range: 'bytes=10-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 10-${fake.archive.size - 1}/${fake.archive.size}`);
    expect(Buffer.from(await res.arrayBuffer()).equals(fake.archive.body.subarray(10))).toBe(true);
    expect((await fetch(fake.pin().url, { headers: { range: `bytes=${fake.archive.size}-` } })).status).toBe(416);
  });

  it('cuts the body the first time only, so a Range request can finish it', async () => {
    fake = await startFakeOllama({ archive: { cutAfterBytes: 20 } });
    const first = await fetch(fake.pin().url);
    const got: Buffer[] = [];
    await (async () => {
      for await (const chunk of first.body as unknown as AsyncIterable<Uint8Array>) got.push(Buffer.from(chunk));
    })().catch(() => undefined);
    const head = Buffer.concat(got);
    expect(head.length).toBe(20);
    const rest = await fetch(fake.pin().url, { headers: { range: 'bytes=20-' } });
    const whole = Buffer.concat([head, Buffer.from(await rest.arrayBuffer())]);
    expect(createHash('sha256').update(whole).digest('hex')).toBe(fake.archive.sha256);
    expect(fake.state.archiveRequests).toBe(2);
  });

  it('can ignore Range, or answer another status', async () => {
    fake = await startFakeOllama({ archive: { ignoreRange: true } });
    expect((await fetch(fake.pin().url, { headers: { range: 'bytes=10-' } })).status).toBe(200);
    fake.switches.archive.status = 503;
    expect((await fetch(fake.pin().url)).status).toBe(503);
  });

  it('is a real archive that tar unpacks to an executable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fake-ollama-archive-'));
    try {
      const archive = join(dir, 'runtime.tgz');
      await writeFile(archive, buildFakeArchive({ ollama: '#!/bin/sh\necho hello\n', LICENSE: 'text\n' }));
      await execFileAsync('tar', ['-xzf', archive, '-C', dir]);
      expect(await readFile(join(dir, 'LICENSE'), 'utf8')).toBe('text\n');
      expect((await stat(join(dir, 'ollama'))).mode & 0o111).not.toBe(0);
      expect((await execFileAsync(join(dir, 'ollama'))).stdout).toBe('hello\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the fake runtime: the child process', () => {
  it('holds the real log lines with the device total', () => {
    expect(REAL_INFERENCE_COMPUTE_LINE_MAC_MINI).toContain('total="11.8 GiB" available="11.8 GiB"');
    expect(INFERENCE_COMPUTE_LINE_MACBOOK).toContain('total="37.4 GiB" available="37.4 GiB"');
    expect(MACBOOK_MEASURED_TOTAL_BYTES).toBe(Math.floor(37.4 * 1024 ** 3));
    expect(fakeRuntimeLog('37.4 GiB')[2]).toContain('msg="inference compute"');
  });

  it('listens on the port of OLLAMA_HOST once spawned, logs the budget, and is gone when killed', async () => {
    const port = await freeLoopbackPort();
    fake = createFakeOllama({ installed: true });
    expect(fake.listening).toBe(false);

    const child = fake.spawn('/somewhere/ollama', ['serve'], {
      env: { OLLAMA_HOST: `127.0.0.1:${port}`, HOME: '/private/home' },
    }) as unknown as FakeRuntimeChild;
    let log = '';
    child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(child.pid).toBeGreaterThan(4_194_304);
    expect(child.env.HOME).toBe('/private/home');
    expect(fake.port).toBe(port);
    expect(await getJson(fake, '/api/version')).toEqual({ version: '0.40.15' });
    expect(log).toContain('msg="inference compute"');
    expect(log).toContain('total="37.4 GiB"');

    const exited = new Promise<[number | null, string | null]>((resolve) =>
      child.once('exit', (code, signal) => resolve([code, signal]))
    );
    expect(child.kill('SIGTERM')).toBe(true);
    expect(await exited).toEqual([null, 'SIGTERM']);
    expect(fake.listening).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/api/version`)).rejects.toThrow();
    expect(fake.state.children).toEqual([child]);
  });

  it('can start without ever listening, exit at once, leave the budget out, or crash later', async () => {
    const port = await freeLoopbackPort();
    const env = { OLLAMA_HOST: `127.0.0.1:${port}` };

    fake = createFakeOllama({ spawn: { neverListens: true, logsBudget: false } });
    const silent = fake.spawn('ollama', ['serve'], { env }) as unknown as FakeRuntimeChild;
    let log = '';
    silent.stderr.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.listening).toBe(false);
    expect(log).toContain('Listening on');
    expect(log).not.toContain('inference compute');

    fake.switches.spawn = { neverListens: false, exitsAtOnce: 2, total: '37.4 GiB', logsBudget: true };
    const dead = fake.spawn('ollama', ['serve'], { env }) as unknown as FakeRuntimeChild;
    const code = await new Promise((resolve) => dead.once('exit', resolve));
    expect(code).toBe(2);

    fake.switches.spawn.exitsAtOnce = undefined;
    const alive = fake.spawn('ollama', ['serve'], { env }) as unknown as FakeRuntimeChild;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.listening).toBe(true);
    const crashed = new Promise((resolve) => alive.once('exit', resolve));
    alive.crash(137);
    expect(await crashed).toBe(137);
    expect(fake.listening).toBe(false);
  });
});
