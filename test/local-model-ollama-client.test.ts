/**
 * @fileoverview Tests for src/local-model/ollama-client.ts: what Codeman asks its own model
 * runtime, and the pure functions that read the answers.
 *
 * Laid out like the module:
 *
 * 1. The listings (`/api/version`, `/api/tags`, `/api/ps`, `/v1/models`, the delete), against
 *    the fake runtime, and what each answers when nothing listens.
 * 2. The pull parser, pure: the two real line shapes fed in small pieces across line breaks, an
 *    error line, a resumed pull, and that it keeps no line.
 * 3. `pullModel()` against the fake: the total it reports, progress, an error line and a cut
 *    stream that are retried, the cap of 5 retries, a model the registry does not have (no
 *    retry), a resumed pull, and Cancel.
 * 4. The check after the pull: the two request bodies, the two judges (pure), and
 *    `verifyModel()` against the fake for every way it can end, the answer without a tool call
 *    among them.
 *
 * Port: none fixed (the fake runtime listens on 0).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildChatProbeRequest,
  buildToolProbeRequest,
  createPullParser,
  deleteModel,
  getRuntimeVersion,
  judgeLoaded,
  judgeToolProbe,
  listOpenAiModels,
  listRunning,
  listTags,
  PULL_RETRIES,
  pullModel,
  readModelDigest,
  TOOL_PROBE_MAX_TOKENS,
  verifyModel,
  type OllamaPsModel,
  type OllamaTarget,
  type PullProgress,
} from '../src/local-model/ollama-client.js';
import {
  DEFAULT_FAKE_MODEL,
  freeLoopbackPort,
  REAL_PULL_ERROR_LINE,
  startFakeOllama,
  type FakeOllama,
  type FakeOllamaOptions,
} from './fixtures/fake-ollama.js';

const MODEL = DEFAULT_FAKE_MODEL.id;
const MODEL_BYTES = DEFAULT_FAKE_MODEL.bytes;
const CONTEXT = 131072;

let fake: FakeOllama | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** Starts the fake and returns the target that points at it. */
async function runtime(options: FakeOllamaOptions = {}): Promise<{ fake: FakeOllama; target: OllamaTarget }> {
  fake = await startFakeOllama(options);
  return { fake, target: { baseUrl: fake.baseUrl } };
}

/** A target nothing listens on. */
async function deadTarget(): Promise<OllamaTarget> {
  return { baseUrl: `http://127.0.0.1:${await freeLoopbackPort()}` };
}

/** No waiting between retries. */
const noSleep = async (): Promise<void> => undefined;

// ---------- 1. Listings ----------

describe('the listings', () => {
  it('reads the version of a runtime', async () => {
    const { target } = await runtime();
    expect(await getRuntimeVersion(target)).toBe('0.40.15');
  });

  it('answers undefined for a port nothing listens on, and for a listener that is no runtime', async () => {
    expect(await getRuntimeVersion(await deadTarget())).toBeUndefined();
    // Something answers, but not with a version.
    const notARuntime: OllamaTarget = {
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () => new Response('<html>hello</html>', { status: 200 }),
    };
    expect(await getRuntimeVersion(notARuntime)).toBeUndefined();
    const wrongShape: OllamaTarget = {
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () => new Response(JSON.stringify({ version: 42 }), { status: 200 }),
    };
    expect(await getRuntimeVersion(wrongShape)).toBeUndefined();
    const refused: OllamaTarget = {
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () => new Response(JSON.stringify({ version: '0.40.15' }), { status: 503 }),
    };
    expect(await getRuntimeVersion(refused)).toBeUndefined();
  });

  it('lists the model on disk with what a Mac reports: size, digest, format, runner', async () => {
    const { target } = await runtime({ installed: true });
    expect(await listTags(target)).toEqual([
      {
        name: 'qwen3.6:35b-a3b',
        size: 23_105_798_956,
        digest: '0ce5ff81f9ffdf89dd8192ca7b5d34cefd8996a875b3aaaaafaf5c4813569eba',
        format: 'safetensors',
        runner: 'mlx',
        capabilities: ['completion', 'vision', 'tools', 'thinking'],
      },
    ]);
    expect(await readModelDigest(target, MODEL)).toBe(DEFAULT_FAKE_MODEL.digest);
    expect(await readModelDigest(target, 'qwen3.5:9b')).toBeUndefined();
  });

  it('stores a digest in one form: lowercase hex without the prefix', async () => {
    const target: OllamaTarget = {
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () =>
        new Response(JSON.stringify({ models: [{ name: MODEL, size: 1, digest: 'sha256:0CE5FF81' }] }), {
          status: 200,
        }),
    };
    expect(await readModelDigest(target, MODEL)).toBe('0ce5ff81');
  });

  it('lists nothing on an empty store, and reads the "data: null" of the OpenAI route as no model', async () => {
    const { target } = await runtime();
    expect(await listTags(target)).toEqual([]);
    expect(await listRunning(target)).toEqual([]);
    expect(await listOpenAiModels(target)).toEqual([]);
    expect(await readModelDigest(target, MODEL)).toBeUndefined();
  });

  it('lists the model ids of the OpenAI route exactly as they are listed', async () => {
    const { target } = await runtime({ installed: true });
    expect(await listOpenAiModels(target)).toEqual(['qwen3.6:35b-a3b']);
  });

  it('lists a loaded model with its memory, the part on the GPU and its context', async () => {
    const { fake: server, target } = await runtime({ installed: true });
    expect(await listRunning(target)).toEqual([]);
    server.state.loaded = true;
    expect(await listRunning(target)).toEqual([
      {
        name: 'qwen3.6:35b-a3b',
        size: 23_205_798_956,
        sizeVram: 23_205_798_956,
        contextLength: 131072,
        digest: DEFAULT_FAKE_MODEL.digest,
      },
    ]);
  });

  it('answers an empty list, never an exception, when nothing listens', async () => {
    const target = await deadTarget();
    expect(await listTags(target)).toEqual([]);
    expect(await listRunning(target)).toEqual([]);
    expect(await listOpenAiModels(target)).toEqual([]);
    expect(await readModelDigest(target, MODEL)).toBeUndefined();
  });

  it('skips rows that are not models instead of failing on them', async () => {
    const target: OllamaTarget = {
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () =>
        new Response(JSON.stringify({ models: [null, 'x', {}, { name: 'a:b' }, { model: 'c:d', size: -1 }] }), {
          status: 200,
        }),
    };
    expect(await listTags(target)).toEqual([
      { name: 'a:b', size: 0, digest: '' },
      { name: 'c:d', size: 0, digest: '' },
    ]);
    // A row without a digest has none to compare.
    expect(await readModelDigest(target, 'a:b')).toBeUndefined();
  });

  it('deletes a model, and calls a model that never was there gone too', async () => {
    const { fake: server, target } = await runtime({ installed: true });
    expect(await deleteModel(target, MODEL)).toBe(true);
    expect(server.requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/delete', body: { model: MODEL } });
    expect(await listTags(target)).toEqual([]);
    // The runtime answers 404 for it now.
    expect(await deleteModel(target, MODEL)).toBe(true);
    // No runtime: nothing was deleted, and it says so.
    expect(await deleteModel(await deadTarget(), MODEL)).toBe(false);
  });

  it('gives up on a listing when the caller aborts', async () => {
    const { target } = await runtime({ installed: true });
    const controller = new AbortController();
    controller.abort();
    expect(await listTags(target, controller.signal)).toEqual([]);
    expect(await getRuntimeVersion(target, controller.signal)).toBeUndefined();
  });
});

// ---------- 2. The pull parser ----------

describe('createPullParser', () => {
  const mlxLine = (completed: number): string =>
    JSON.stringify({ status: 'pulling model', digest: 'sha256:model', total: MODEL_BYTES, completed });

  it('adds up the line shape of an MLX build', () => {
    const parser = createPullParser();
    parser.push('{"status":"pulling manifest"}\n');
    expect(parser.snapshot()).toEqual({
      completedBytes: 0,
      totalBytes: 0,
      status: 'pulling manifest',
      succeeded: false,
      lines: 1,
    });
    parser.push(`${mlxLine(0)}\n${mlxLine(6_200_000_000)}\n`);
    expect(parser.snapshot()).toMatchObject({ completedBytes: 6_200_000_000, totalBytes: 23_105_798_956, lines: 3 });
    parser.push(`${mlxLine(MODEL_BYTES)}\n{"status":"writing manifest"}\n{"status":"success"}\n`);
    parser.end();
    expect(parser.snapshot()).toEqual({
      completedBytes: 23_105_798_956,
      totalBytes: 23_105_798_956,
      status: 'success',
      succeeded: true,
      lines: 6,
    });
  });

  it('reads the same stream whatever the size of the pieces, also across line breaks', () => {
    const stream =
      ['{"status":"pulling manifest"}', mlxLine(0), mlxLine(1_000), mlxLine(999_999_999), mlxLine(MODEL_BYTES)].join(
        '\n'
      ) + '\n{"status":"writing manifest"}\n{"status":"success"}\n';
    const whole = createPullParser();
    whole.push(stream);
    whole.end();
    const expected = whole.snapshot();
    expect(expected).toMatchObject({ succeeded: true, completedBytes: MODEL_BYTES, lines: 7 });

    for (const size of [1, 2, 3, 5, 7, 13, 64, 1000]) {
      const parser = createPullParser();
      for (let at = 0; at < stream.length; at += size) parser.push(stream.slice(at, at + size));
      parser.end();
      expect(parser.snapshot(), `pieces of ${size}`).toEqual(expected);
    }
    // And as bytes, one at a time: what a socket may really deliver.
    const bytes = new TextEncoder().encode(stream);
    const parser = createPullParser();
    for (const byte of bytes) parser.push(Uint8Array.of(byte));
    parser.end();
    expect(parser.snapshot()).toEqual(expected);
  });

  it('survives a character of several bytes that is split between two pieces', () => {
    const bytes = new TextEncoder().encode('{"status":"lädt Manifest ✓"}\n{"status":"success"}\n');
    for (let cut = 1; cut < bytes.length; cut++) {
      const parser = createPullParser();
      parser.push(bytes.subarray(0, cut));
      parser.push(bytes.subarray(cut));
      parser.end();
      expect(parser.snapshot(), `cut at ${cut}`).toMatchObject({ succeeded: true, lines: 2 });
    }
    const parser = createPullParser();
    parser.push(bytes.subarray(0, 14));
    parser.push(bytes.subarray(14));
    expect(parser.snapshot().lines).toBe(2);
  });

  it('adds up the layers of a GGUF build, each announced without "completed" first', () => {
    const parser = createPullParser();
    const big = { status: 'pulling c5396e06af29', digest: 'sha256:c5396e06af29aaaa', total: 397_807_936 };
    const small = { status: 'pulling 66b9ea09bd5b', digest: 'sha256:66b9ea09bd5bbbbb', total: 68 };
    parser.push(`${JSON.stringify(big)}\n`);
    // Known, nothing downloaded yet.
    expect(parser.snapshot()).toMatchObject({ totalBytes: 397_807_936, completedBytes: 0 });
    parser.push(`${JSON.stringify({ ...big, completed: 100_000_000 })}\n`);
    parser.push(`${JSON.stringify(small)}\n`);
    // The total grows when a new layer appears; a line without "completed" keeps what was seen.
    parser.push(`${JSON.stringify(big)}\n`);
    expect(parser.snapshot()).toMatchObject({ totalBytes: 397_808_004, completedBytes: 100_000_000 });
    parser.push(`${JSON.stringify({ ...big, completed: 397_807_936 })}\n`);
    parser.push(`${JSON.stringify({ ...small, completed: 68 })}\n`);
    parser.push('{"status":"verifying sha256 digest"}\n{"status":"writing manifest"}\n{"status":"success"}\n');
    expect(parser.snapshot()).toEqual({
      completedBytes: 397_808_004,
      totalBytes: 397_808_004,
      status: 'success',
      succeeded: true,
      lines: 9,
    });
  });

  it('reads a resumed pull from where it starts, not from zero', () => {
    const parser = createPullParser();
    parser.push(`{"status":"pulling manifest"}\n${mlxLine(11_000_000_000)}\n`);
    expect(parser.snapshot()).toMatchObject({ completedBytes: 11_000_000_000, totalBytes: MODEL_BYTES });
  });

  it('keeps the text of an error line, the real one included', () => {
    const parser = createPullParser();
    parser.push(`{"status":"pulling manifest"}\n${mlxLine(5)}\n${REAL_PULL_ERROR_LINE}\n`);
    parser.end();
    expect(parser.snapshot()).toEqual({
      completedBytes: 5,
      totalBytes: MODEL_BYTES,
      status: 'pulling model',
      succeeded: false,
      error: 'max retries exceeded: local error: tls: bad record MAC',
      lines: 3,
    });
    // The first error stays.
    parser.push('{"error":"another"}\n');
    expect(parser.snapshot().error).toBe('max retries exceeded: local error: tls: bad record MAC');
  });

  it('reads a last line that has no line break only when the body ends', () => {
    const parser = createPullParser();
    parser.push('{"status":"success"}');
    expect(parser.snapshot()).toMatchObject({ succeeded: false, lines: 0 });
    parser.end();
    expect(parser.snapshot()).toMatchObject({ succeeded: true, lines: 1 });
  });

  it('skips a line that is not JSON and still counts it; a blank line is no line', () => {
    const parser = createPullParser();
    parser.push('not json\n\n   \n[1,2]\n"text"\nnull\n{"status":"success"}\n');
    expect(parser.snapshot()).toEqual({
      completedBytes: 0,
      totalBytes: 0,
      status: 'success',
      succeeded: true,
      lines: 5,
    });
  });

  it('never lets "completed" pass "total", and ignores sizes that are no byte counts', () => {
    const parser = createPullParser();
    parser.push('{"status":"pulling a","digest":"sha256:a","total":100,"completed":250}\n');
    parser.push('{"status":"pulling b","digest":"sha256:b","total":-5,"completed":1}\n');
    parser.push('{"status":"pulling c","digest":"sha256:c","total":"100","completed":1}\n');
    expect(parser.snapshot()).toMatchObject({ completedBytes: 100, totalBytes: 100 });
  });

  it('keeps no line: a million progress lines leave it as small as ten', () => {
    // What it holds is one entry per layer and the unfinished line. Proven by its answers: the
    // totals are those of the LAST line of each layer, and the count is every line.
    const parser = createPullParser();
    const lines = 200_000;
    let block = '';
    for (let i = 1; i <= lines; i++) {
      block += `${mlxLine(i * 1000)}\n`;
      if (i % 5000 === 0) {
        parser.push(block);
        block = '';
      }
    }
    parser.end();
    expect(parser.snapshot()).toEqual({
      completedBytes: lines * 1000,
      totalBytes: MODEL_BYTES,
      status: 'pulling model',
      succeeded: false,
      lines,
    });
  });

  it('drops a "line" that never ends instead of buffering it', () => {
    const parser = createPullParser();
    // Three megabytes without a line break, then the stream goes on normally.
    for (let i = 0; i < 3; i++) parser.push('x'.repeat(1024 * 1024));
    parser.push('tail of the endless line\n{"status":"success"}\n');
    expect(parser.snapshot()).toMatchObject({ succeeded: true, lines: 2 });
  });
});

// ---------- 3. pullModel ----------

describe('pullModel', () => {
  it('pulls the model and reports the total of the pull itself', async () => {
    const { fake: server, target } = await runtime();
    const seen: PullProgress[] = [];
    const result = await pullModel(target, MODEL, { onProgress: (progress) => seen.push(progress) });
    expect(result).toEqual({ ok: true, totalBytes: 23_105_798_956 });
    expect(server.state.installed).toBe(true);
    expect(server.requests.filter((r) => r.path === '/api/pull')).toEqual([
      expect.objectContaining({ method: 'POST', body: { model: MODEL, stream: true } }),
    ]);
    // The last report is the finished pull, and no report runs backwards.
    expect(seen.at(-1)).toMatchObject({ completedBytes: MODEL_BYTES, totalBytes: MODEL_BYTES });
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].completedBytes).toBeGreaterThanOrEqual(seen[i - 1].completedBytes);
    }
    for (const progress of seen) expect(progress.totalBytes).toBe(MODEL_BYTES);
  });

  it('adds up the layers of a GGUF pull to the same total', async () => {
    const { target } = await runtime({ pull: { shape: 'gguf', progressLines: 6 } });
    expect(await pullModel(target, MODEL)).toEqual({ ok: true, totalBytes: MODEL_BYTES });
  });

  it('reports a speed from the clock it is given', async () => {
    const { target } = await runtime({ pull: { progressLines: 8, lineDelayMs: 5 } });
    const seen: PullProgress[] = [];
    let clock = 0;
    const result = await pullModel(target, MODEL, {
      onProgress: (progress) => seen.push(progress),
      // One second passes between two looks at the clock.
      now: () => (clock += 1000),
    });
    expect(result.ok).toBe(true);
    const speeds = seen.flatMap((progress) => (progress.bytesPerSecond === undefined ? [] : [progress.bytesPerSecond]));
    expect(speeds.length).toBeGreaterThan(0);
    for (const speed of speeds) {
      expect(Number.isInteger(speed)).toBe(true);
      expect(speed).toBeGreaterThanOrEqual(0);
    }
    // The first report has nothing to compare with.
    expect(seen[0].bytesPerSecond).toBeUndefined();
    expect(Math.max(...speeds)).toBeGreaterThan(0);
  });

  it('starts again after an error line, and the new pull continues where the last one stopped', async () => {
    const { fake: server, target } = await runtime({
      pull: { fail: 'error-line', failTimes: 2, failAfterLines: 10, progressLines: 20 },
    });
    const waits: number[] = [];
    const firstOfEachPull: number[] = [];
    let last = -1;
    const result = await pullModel(target, MODEL, {
      sleep: async (ms) => {
        waits.push(ms);
        last = -1;
      },
      onProgress: (progress) => {
        if (last === -1) firstOfEachPull.push(progress.completedBytes);
        last = progress.completedBytes;
      },
    });
    expect(result).toEqual({ ok: true, totalBytes: MODEL_BYTES });
    // Two failures, then the one that succeeded.
    expect(server.state.pulls).toBe(3);
    // It waits before each retry, longer every time.
    expect(waits).toEqual([1000, 2000]);
    // The second and third pull do not start at zero.
    expect(firstOfEachPull).toHaveLength(3);
    expect(firstOfEachPull[1]).toBeGreaterThan(0);
    expect(firstOfEachPull[2]).toBeGreaterThan(firstOfEachPull[1]);
  });

  it('starts again after a stream that was cut without a word', async () => {
    const { fake: server, target } = await runtime({ pull: { fail: 'cut', failTimes: 1 } });
    expect(await pullModel(target, MODEL, { sleep: noSleep })).toEqual({ ok: true, totalBytes: MODEL_BYTES });
    expect(server.state.pulls).toBe(2);
  });

  it('gives up after 5 retries, with the error the runtime gave', async () => {
    expect(PULL_RETRIES).toBe(5);
    const { fake: server, target } = await runtime({ pull: { fail: 'error-line' } });
    const waits: number[] = [];
    const result = await pullModel(target, MODEL, { sleep: async (ms) => void waits.push(ms) });
    expect(result).toEqual({
      ok: false,
      code: 'pull-failed',
      detail: 'max retries exceeded: local error: tls: bad record MAC',
    });
    // The first pull and five more.
    expect(server.state.pulls).toBe(6);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(server.state.installed).toBe(false);
  });

  it('gives up on a stream that is cut every time, and says that it ended early', async () => {
    const { fake: server, target } = await runtime({ pull: { fail: 'cut' } });
    const result = await pullModel(target, MODEL, { sleep: noSleep, retries: 2 });
    expect(result).toMatchObject({ ok: false, code: 'pull-failed' });
    expect((result as { detail?: string }).detail).toBeTruthy();
    expect(server.state.pulls).toBe(3);
  });

  it('does not retry when 0 retries are asked for, and falls back to 5 for a nonsense count', async () => {
    const { fake: server, target } = await runtime({ pull: { fail: 'error-line' } });
    expect(await pullModel(target, MODEL, { sleep: noSleep, retries: 0 })).toMatchObject({ code: 'pull-failed' });
    expect(server.state.pulls).toBe(1);
    await pullModel(target, MODEL, { sleep: noSleep, retries: -3 });
    expect(server.state.pulls).toBe(1 + 6);
  });

  it('does not ask again for a model the registry does not have', async () => {
    const { fake: server, target } = await runtime({ pull: { fail: 'not-found' } });
    const result = await pullModel(target, MODEL, { sleep: noSleep });
    expect(result).toEqual({
      ok: false,
      code: 'model-not-found',
      detail: 'pull model manifest: file does not exist',
    });
    expect(server.state.pulls).toBe(1);
  });

  it('does not ask again when the disk is full', async () => {
    const target: OllamaTarget = {
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () =>
        new Response(
          '{"status":"pulling manifest"}\n{"error":"write /models/blobs/sha256-abc-partial: no space left on device"}\n',
          { status: 200 }
        ),
    };
    let asked = 0;
    const counting: OllamaTarget = {
      ...target,
      fetch: (...args) => {
        asked += 1;
        return (target.fetch as typeof fetch)(...args);
      },
    };
    expect(await pullModel(counting, MODEL, { sleep: noSleep })).toMatchObject({ ok: false, code: 'disk-full' });
    expect(asked).toBe(1);
  });

  it('retries, then fails, when no runtime answers at all', async () => {
    const waits: number[] = [];
    const result = await pullModel(await deadTarget(), MODEL, { sleep: async (ms) => void waits.push(ms), retries: 2 });
    expect(result).toMatchObject({ ok: false, code: 'pull-failed' });
    expect(waits).toHaveLength(2);
  });

  it('continues a pull that an earlier run left unfinished', async () => {
    const { target } = await runtime({ pull: { resumeFrom: 11_000_000_000 } });
    const seen: number[] = [];
    const result = await pullModel(target, MODEL, { onProgress: (progress) => seen.push(progress.completedBytes) });
    expect(result).toEqual({ ok: true, totalBytes: MODEL_BYTES });
    // The first figure the window shows is where the earlier run stopped.
    expect(seen[0]).toBeGreaterThanOrEqual(11_000_000_000);
  });

  it('reports the size of a model that was complete already, when the pull names no layer', async () => {
    // A runtime that answers "success" at once: the size is what it lists for the model.
    const { fake: server } = await runtime({ installed: true });
    const target: OllamaTarget = {
      baseUrl: server.baseUrl,
      fetch: async (input, init) =>
        String(input).endsWith('/api/pull')
          ? new Response('{"status":"pulling manifest"}\n{"status":"success"}\n', { status: 200 })
          : fetch(input, init),
    };
    expect(await pullModel(target, MODEL)).toEqual({ ok: true, totalBytes: MODEL_BYTES });
  });

  it('stops the download when the caller cancels, and does not start again', async () => {
    const { fake: server, target } = await runtime({ pull: { progressLines: 200, lineDelayMs: 10 } });
    const controller = new AbortController();
    const seen: PullProgress[] = [];
    const result = await pullModel(target, MODEL, {
      signal: controller.signal,
      sleep: noSleep,
      onProgress: (progress) => {
        seen.push(progress);
        controller.abort();
      },
    });
    expect(result).toEqual({ ok: false, code: 'cancelled' });
    expect(seen).toHaveLength(1);
    expect(server.state.pulls).toBe(1);
    expect(server.state.installed).toBe(false);
    // Pulling again is the resume: it starts where the cancelled one stopped.
    server.switches.pull.lineDelayMs = 0;
    const again: number[] = [];
    expect(await pullModel(target, MODEL, { onProgress: (p) => again.push(p.completedBytes) })).toEqual({
      ok: true,
      totalBytes: MODEL_BYTES,
    });
    expect(again[0]).toBeGreaterThan(0);
  });

  it('answers cancelled at once for a signal that is already aborted', async () => {
    const { fake: server, target } = await runtime();
    const controller = new AbortController();
    controller.abort();
    expect(await pullModel(target, MODEL, { signal: controller.signal })).toEqual({ ok: false, code: 'cancelled' });
    expect(server.state.pulls).toBe(0);
  });

  it('calls a cancel a cancel also on its last try, never a failed download', async () => {
    // With no retry left, the cut stream of an abort must not read as "the download keeps stopping".
    const { fake: server, target } = await runtime({ pull: { progressLines: 200, lineDelayMs: 10 } });
    const controller = new AbortController();
    const result = await pullModel(target, MODEL, {
      signal: controller.signal,
      retries: 0,
      onProgress: () => controller.abort(),
    });
    expect(result).toEqual({ ok: false, code: 'cancelled' });
    expect(server.state.pulls).toBe(1);
  });

  it('does not let a progress callback that throws fail the download', async () => {
    const { fake: server, target } = await runtime();
    let called = 0;
    const result = await pullModel(target, MODEL, {
      sleep: noSleep,
      onProgress: () => {
        called += 1;
        throw new Error('the window is gone');
      },
    });
    expect(called).toBeGreaterThan(0);
    expect(result).toEqual({ ok: true, totalBytes: MODEL_BYTES });
    expect(server.state.pulls).toBe(1);
  });

  it('answers with a result, not an exception, when its own clock throws', async () => {
    const { target } = await runtime();
    const result = await pullModel(target, MODEL, {
      sleep: noSleep,
      retries: 1,
      onProgress: () => undefined,
      now: () => {
        throw new Error('no clock');
      },
    });
    expect(result).toEqual({ ok: false, code: 'pull-failed', detail: 'no clock' });
  });
});

// ---------- 4. The check after the pull ----------

describe('the probe requests', () => {
  it('builds a tiny chat with reasoning off', () => {
    expect(buildChatProbeRequest(MODEL)).toEqual({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      reasoning_effort: 'none',
      max_tokens: 16,
      temperature: 0,
      stream: false,
    });
    expect(buildChatProbeRequest(MODEL)).not.toHaveProperty('tools');
  });

  it('builds a tool probe with a tools array, reasoning off and 1024 tokens', () => {
    expect(TOOL_PROBE_MAX_TOKENS).toBe(1024);
    const request = buildToolProbeRequest(MODEL) as {
      model: string;
      messages: { role: string; content: string }[];
      tools: { type: string; function: { name: string; parameters: { type: string; required: string[] } } }[];
      reasoning_effort: string;
      max_tokens: number;
      stream: boolean;
    };
    expect(request.model).toBe(MODEL);
    expect(request.reasoning_effort).toBe('none');
    expect(request.max_tokens).toBe(1024);
    expect(request.stream).toBe(false);
    expect(request.tools.map((tool) => [tool.type, tool.function.name])).toEqual([
      ['function', 'read_file'],
      ['function', 'write_file'],
      ['function', 'run_command'],
    ]);
    for (const tool of request.tools) {
      expect(tool.function.parameters.type).toBe('object');
      expect(tool.function.parameters.required.length).toBeGreaterThan(0);
    }
    // The task can only be done with a tool.
    expect(request.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Read the file README.md and tell me what it says.',
    });
    // Nothing forces the call: the model has to decide to make it.
    expect(request).not.toHaveProperty('tool_choice');
  });
});

describe('judgeLoaded', () => {
  const loaded = (overrides: Partial<OllamaPsModel> = {}): OllamaPsModel => ({
    name: MODEL,
    size: 23_205_798_956,
    sizeVram: 23_205_798_956,
    contextLength: CONTEXT,
    ...overrides,
  });

  it('passes a model that is all on the GPU at the chosen context', () => {
    expect(judgeLoaded([loaded()], MODEL, CONTEXT)).toEqual({
      ok: true,
      loaded: { context: 131072, sizeBytes: 23_205_798_956, sizeVramBytes: 23_205_798_956 },
    });
    // Another loaded model beside it does not matter.
    expect(judgeLoaded([loaded({ name: 'other:1', contextLength: 4096 }), loaded()], MODEL, CONTEXT).ok).toBe(true);
  });

  it('answers load-failed when the model is not listed', () => {
    expect(judgeLoaded([], MODEL, CONTEXT)).toMatchObject({ ok: false, code: 'load-failed' });
    expect(judgeLoaded([loaded({ name: 'other:1' })], MODEL, CONTEXT)).toMatchObject({
      ok: false,
      code: 'load-failed',
    });
    expect(judgeLoaded([loaded({ size: 0, sizeVram: 0 })], MODEL, CONTEXT)).toMatchObject({
      ok: false,
      code: 'load-failed',
    });
  });

  it('answers does-not-fit when part of the model is not on the GPU', () => {
    const judged = judgeLoaded([loaded({ sizeVram: 20_000_000_000 })], MODEL, CONTEXT);
    expect(judged).toEqual({
      ok: false,
      code: 'does-not-fit',
      detail: '20.0 of 23.2 GB of the model are on the GPU',
    });
    // One byte is enough.
    expect(judgeLoaded([loaded({ sizeVram: 23_205_798_955 })], MODEL, CONTEXT)).toMatchObject({ code: 'does-not-fit' });
    expect(judgeLoaded([loaded({ sizeVram: 0 })], MODEL, CONTEXT)).toMatchObject({ code: 'does-not-fit' });
  });

  it('answers context-not-applied when the runtime loaded another context', () => {
    expect(judgeLoaded([loaded({ contextLength: 32768 })], MODEL, CONTEXT)).toEqual({
      ok: false,
      code: 'context-not-applied',
      detail: 'The runtime reports a context of 32768 tokens, not 131072',
    });
    // A larger one is not the chosen one either.
    expect(judgeLoaded([loaded({ contextLength: 262144 })], MODEL, CONTEXT)).toMatchObject({
      code: 'context-not-applied',
    });
  });

  it('looks at the GPU before the context', () => {
    expect(judgeLoaded([loaded({ sizeVram: 1, contextLength: 4096 })], MODEL, CONTEXT)).toMatchObject({
      code: 'does-not-fit',
    });
  });
});

describe('judgeToolProbe', () => {
  /** An answer of `/v1/chat/completions` with this message and finish reason. */
  const answer = (message: Record<string, unknown>, finishReason: string): unknown => ({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
  });
  const call = (argumentsValue: unknown, name: unknown = 'read_file'): Record<string, unknown> => ({
    id: 'call_1',
    index: 0,
    type: 'function',
    function: { name, arguments: argumentsValue },
  });

  it('passes on a tool call whose arguments parse as a JSON object', () => {
    expect(
      judgeToolProbe(200, answer({ content: '', tool_calls: [call('{"path":"README.md"}')] }, 'tool_calls'))
    ).toEqual({ ok: true });
    // Arguments that are an object already, and an empty object, are arguments too.
    expect(judgeToolProbe(200, answer({ tool_calls: [call({ path: 'README.md' })] }, 'tool_calls'))).toEqual({
      ok: true,
    });
    expect(judgeToolProbe(200, answer({ tool_calls: [call('{}')] }, 'tool_calls'))).toEqual({ ok: true });
    // The finish reason is not what decides: the call is.
    expect(judgeToolProbe(200, answer({ tool_calls: [call('{"path":"a"}')] }, 'stop'))).toEqual({ ok: true });
  });

  it('answers no-tool-call for an answer in plain text', () => {
    expect(judgeToolProbe(200, answer({ content: 'I would read the file, but I cannot.' }, 'stop'))).toEqual({
      ok: false,
      code: 'no-tool-call',
      detail: 'The model answered in text: I would read the file, but I cannot.',
    });
    expect(judgeToolProbe(200, answer({ content: '', tool_calls: [] }, 'stop'))).toMatchObject({
      ok: false,
      code: 'no-tool-call',
    });
  });

  it('answers no-tool-call for a tool call whose arguments are not a JSON object', () => {
    for (const bad of ['{"path": ', 'README.md', '"README.md"', '[1]', 'null', '', 42, null, undefined]) {
      expect(judgeToolProbe(200, answer({ tool_calls: [call(bad)] }, 'tool_calls')), JSON.stringify(bad)).toMatchObject(
        {
          ok: false,
          code: 'no-tool-call',
        }
      );
    }
    // A call without a name, and one good call beside a broken one.
    expect(judgeToolProbe(200, answer({ tool_calls: [call('{}', '')] }, 'tool_calls'))).toMatchObject({
      code: 'no-tool-call',
    });
    expect(
      judgeToolProbe(200, answer({ tool_calls: [call('{"path":"a"}'), call('{"path": ')] }, 'tool_calls'))
    ).toMatchObject({ code: 'no-tool-call' });
    expect(judgeToolProbe(200, answer({ tool_calls: ['read_file'] }, 'tool_calls'))).toMatchObject({
      code: 'no-tool-call',
    });
  });

  it('answers probe-unfinished when the token limit ended the answer: that proves nothing', () => {
    expect(
      judgeToolProbe(200, answer({ content: '', reasoning: 'The user wants me to read a file. I should' }, 'length'))
    ).toEqual({ ok: false, code: 'probe-unfinished', detail: 'The answer ended at 1024 tokens' });
  });

  it('answers load-failed for any other status, with what the runtime said', () => {
    expect(judgeToolProbe(500, { error: { message: 'llm server error: out of memory' } })).toEqual({
      ok: false,
      code: 'load-failed',
      detail: 'llm server error: out of memory',
    });
    expect(judgeToolProbe(404, { error: "model 'x' not found" })).toMatchObject({
      code: 'load-failed',
      detail: "model 'x' not found",
    });
    expect(judgeToolProbe(502, undefined)).toEqual({
      ok: false,
      code: 'load-failed',
      detail: 'The runtime answered 502',
    });
  });

  it('answers no-tool-call for a 200 it cannot read at all', () => {
    for (const body of [undefined, null, 'text', [], {}, { choices: [] }, { choices: [null] }, { choices: [{}] }]) {
      expect(judgeToolProbe(200, body), JSON.stringify(body)).toEqual({
        ok: false,
        code: 'no-tool-call',
        detail: 'The answer holds no tool call',
      });
    }
  });
});

describe('verifyModel', () => {
  it('passes a model that loads, sits on the GPU at the chosen context and calls a tool', async () => {
    const { fake: server, target } = await runtime({ installed: true });
    expect(await verifyModel(target, MODEL, CONTEXT)).toEqual({
      ok: true,
      loaded: { context: 131072, sizeBytes: 23_205_798_956, sizeVramBytes: 23_205_798_956 },
    });
    // In this order: the chat that loads it, the process list, the tool probe.
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/chat/completions',
      'GET /api/ps',
      'POST /v1/chat/completions',
    ]);
    const [chat, , probe] = server.requests.map((r) => r.body as Record<string, unknown>);
    expect(chat).toEqual(buildChatProbeRequest(MODEL));
    expect(chat).toMatchObject({ reasoning_effort: 'none' });
    expect(chat).not.toHaveProperty('tools');
    expect(probe).toEqual(buildToolProbeRequest(MODEL));
    expect(probe).toMatchObject({ reasoning_effort: 'none', max_tokens: 1024 });
    expect(Array.isArray(probe.tools)).toBe(true);
  });

  it('answers load-failed when the chat that loads the model fails, and asks nothing more', async () => {
    const { fake: server, target } = await runtime({ installed: true, chat: 'error' });
    expect(await verifyModel(target, MODEL, CONTEXT)).toEqual({
      ok: false,
      code: 'load-failed',
      detail: 'llm server error: out of memory',
    });
    expect(server.requests).toHaveLength(1);
  });

  it('answers load-failed for a model that is not on disk', async () => {
    const { target } = await runtime();
    expect(await verifyModel(target, MODEL, CONTEXT)).toMatchObject({ ok: false, code: 'load-failed' });
  });

  it('answers load-failed when no runtime answers', async () => {
    expect(await verifyModel(await deadTarget(), MODEL, CONTEXT)).toEqual({
      ok: false,
      code: 'load-failed',
      detail: 'The runtime did not answer the first request',
    });
  });

  it('answers load-failed when the model is not in the process list after the chat', async () => {
    const { fake: server, target } = await runtime({ installed: true, ps: { loaded: false } });
    expect(await verifyModel(target, MODEL, CONTEXT)).toMatchObject({ ok: false, code: 'load-failed' });
    // The tool probe was not sent.
    expect(server.requests.filter((r) => r.path === '/v1/chat/completions')).toHaveLength(1);
  });

  it('answers does-not-fit when part of the model is not on the GPU, before any tool probe', async () => {
    const { fake: server, target } = await runtime({ installed: true, ps: { sizeVram: 18_000_000_000 } });
    expect(await verifyModel(target, MODEL, CONTEXT)).toEqual({
      ok: false,
      code: 'does-not-fit',
      detail: '18.0 of 23.2 GB of the model are on the GPU',
    });
    expect(server.requests.filter((r) => r.path === '/v1/chat/completions')).toHaveLength(1);
  });

  it('answers context-not-applied when the runtime loaded another context than the chosen one', async () => {
    const { target } = await runtime({ installed: true, contextLength: 32768 });
    expect(await verifyModel(target, MODEL, CONTEXT)).toMatchObject({ ok: false, code: 'context-not-applied' });
    // The same runtime passes when 32768 is what was chosen.
    expect(await verifyModel(target, MODEL, 32768)).toMatchObject({ ok: true, loaded: { context: 32768 } });
  });

  it('answers no-tool-call when the model answers the tool probe in text', async () => {
    const { target } = await runtime({ installed: true, tool: 'none' });
    expect(await verifyModel(target, MODEL, CONTEXT)).toEqual({
      ok: false,
      code: 'no-tool-call',
      detail: 'The model answered in text: I would read the file, but I cannot.',
    });
  });

  it('answers no-tool-call when the arguments of the tool call do not parse', async () => {
    const { target } = await runtime({ installed: true, tool: 'bad-arguments' });
    expect(await verifyModel(target, MODEL, CONTEXT)).toMatchObject({ ok: false, code: 'no-tool-call' });
  });

  it('answers probe-unfinished, not no-tool-call, when the token limit ended the answer', async () => {
    const { target } = await runtime({ installed: true, tool: 'length' });
    expect(await verifyModel(target, MODEL, CONTEXT)).toMatchObject({ ok: false, code: 'probe-unfinished' });
  });

  it('answers cancelled for an aborted signal, at whatever point it is noticed', async () => {
    const { fake: server, target } = await runtime({ installed: true });
    const before = new AbortController();
    before.abort();
    expect(await verifyModel(target, MODEL, CONTEXT, before.signal)).toEqual({ ok: false, code: 'cancelled' });
    expect(server.requests).toHaveLength(0);

    // Aborted while the first request is on its way.
    const during = new AbortController();
    const slow: OllamaTarget = {
      baseUrl: server.baseUrl,
      fetch: async (input, init) => {
        during.abort();
        return fetch(input, init);
      },
    };
    expect(await verifyModel(slow, MODEL, CONTEXT, during.signal)).toEqual({ ok: false, code: 'cancelled' });
  });

  it('never throws, whatever the runtime sends back', async () => {
    const answers = ['', 'not json', '[]', 'null', '{"choices":"x"}'];
    for (const text of answers) {
      const target: OllamaTarget = {
        baseUrl: 'http://127.0.0.1:1',
        fetch: async () => new Response(text, { status: 200 }),
      };
      const result = await verifyModel(target, MODEL, CONTEXT);
      // The chat was "answered", the process list lists nothing.
      expect(result, text).toMatchObject({ ok: false, code: 'load-failed' });
    }
  });
});
