/**
 * @fileoverview Range-request coverage for the raw file-serving routes.
 *
 * The file viewer points a `<video>` at `GET /api/sessions/:id/file-raw`. That
 * route used to read the whole file and answer 200 with no `Accept-Ranges`,
 * which makes a browser treat the media as unseekable: measured against an 18MB
 * mp4, `video.seekable` was `[0, 0]` and assigning `currentTime` was reverted on
 * the next tick, so the scrub bar looked dead.
 *
 * These tests pin the wire contract that makes seeking work, since none of it is
 * visible from a plain 200-vs-404 assertion:
 *   1. `Accept-Ranges: bytes` on the un-ranged response (what tells the browser
 *      it MAY seek at all),
 *   2. 206 + `Content-Range` + the sliced body for a range request,
 *   3. the slice actually coming from a bounded read, not a full-file read that
 *      is then truncated,
 *   4. 416 (with `Content-Range: bytes *​/size`) for a range past EOF, rather
 *      than a silent full-body 200 the media element cannot interpret.
 *
 * Uses app.inject() — no real ports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

const FILE_BYTES = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes, index == value position

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => Buffer.from('unused')),
    stat: vi.fn(async () => ({ size: 20, isFile: () => true, isDirectory: () => false, mtimeMs: 1 })),
    readdir: vi.fn(async () => []),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
    // Honour start/end so a test can tell a real bounded read from a full read.
    createReadStream: vi.fn((_path: string, opts?: { start?: number; end?: number }) => {
      const start = opts?.start ?? 0;
      const end = opts?.end ?? FILE_BYTES.length - 1;
      return Readable.from([FILE_BYTES.subarray(start, end + 1)]);
    }),
  };
});

vi.mock('../../src/file-stream-manager.js', () => ({
  fileStreamManager: {
    createStream: vi.fn(async () => ({ success: true, streamId: 'stream-1' })),
    closeStream: vi.fn(() => true),
  },
}));

import fs from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';

const mockedStat = vi.mocked(fs.stat);
const mockedRealpathSync = vi.mocked(realpathSync);
const mockedCreateReadStream = vi.mocked(createReadStream);

describe('file-raw range requests', () => {
  let harness: RouteTestHarness;
  let sid: string;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    vi.clearAllMocks();
    mockedRealpathSync.mockImplementation((p: string) => p as never);
    mockedStat.mockResolvedValue({ size: FILE_BYTES.length, isFile: () => true } as never);
    mockedCreateReadStream.mockImplementation(
      (_path: unknown, opts?: unknown) =>
        Readable.from([
          FILE_BYTES.subarray(
            (opts as { start?: number })?.start ?? 0,
            ((opts as { end?: number })?.end ?? FILE_BYTES.length - 1) + 1
          ),
        ]) as never
    );
    sid = harness.ctx._sessionId as string;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rawUrl = (name = 'clip.mp4') => `/api/sessions/${sid}/file-raw?path=${name}`;

  it('advertises Accept-Ranges on an un-ranged response, so the browser knows it may seek', async () => {
    const res = await harness.app.inject({ method: 'GET', url: rawUrl() });

    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-length']).toBe(String(FILE_BYTES.length));
    expect(res.rawPayload.equals(FILE_BYTES)).toBe(true);
  });

  it('answers bytes=0- with 206 (Chrome opens every media element this way)', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: rawUrl(),
      headers: { range: 'bytes=0-' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-19/${FILE_BYTES.length}`);
    expect(res.headers['content-length']).toBe(String(FILE_BYTES.length));
    expect(res.rawPayload.equals(FILE_BYTES)).toBe(true);
  });

  it('serves a mid-file slice from a bounded read', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: rawUrl(),
      headers: { range: 'bytes=5-9' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 5-9/20');
    expect(res.headers['content-length']).toBe('5');
    expect(res.rawPayload.toString()).toBe('56789');
    // The read itself must be bounded: a full read that is sliced afterwards
    // would still pull an 18MB video into memory on every seek.
    expect(mockedCreateReadStream).toHaveBeenCalledWith(expect.any(String), { start: 5, end: 9 });
  });

  it('serves a suffix range as the LAST N bytes', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: rawUrl(),
      headers: { range: 'bytes=-4' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 16-19/20');
    expect(res.rawPayload.toString()).toBe('GHIJ');
  });

  it('answers a range past EOF with 416 instead of a full-body 200', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: rawUrl(),
      headers: { range: 'bytes=100-200' },
    });

    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */20');
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('ignores a malformed range and serves the whole file', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: rawUrl(),
      headers: { range: 'bytes=abc-def' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(FILE_BYTES)).toBe(true);
  });

  it('keeps the security headers on a partial response', async () => {
    // 206 bodies go out through reply.hijack(), which bypasses Fastify's own
    // header write — the nosniff/type headers have to be carried across by hand.
    const res = await harness.app.inject({
      method: 'GET',
      url: rawUrl(),
      headers: { range: 'bytes=0-3' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  it('supports resuming a download (?download=true) as well as inline playback', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `${rawUrl('clip.mp4')}&download=true`,
      headers: { range: 'bytes=10-14' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-disposition']).toContain('attachment; filename="clip.mp4"');
    expect(res.rawPayload.toString()).toBe('ABCDE');
  });

  it('still refuses files past the raw size cap before looking at Range', async () => {
    // 3GB, past the 2GB CODEMAN_MAX_DOWNLOAD_BYTES default. The cap is checked
    // before the range, so a small slice of an oversized file is refused too.
    mockedStat.mockResolvedValue({ size: 3 * 1024 * 1024 * 1024, isFile: () => true } as never);

    const res = await harness.app.inject({
      method: 'GET',
      url: rawUrl('huge.mp4'),
      headers: { range: 'bytes=0-99' },
    });

    expect(res.statusCode).toBe(413);
  });

  it('serves a 100MB file that the historical 50MB cap would have refused', async () => {
    mockedStat.mockResolvedValue({ size: 100 * 1024 * 1024, isFile: () => true } as never);

    const res = await harness.app.inject({
      method: 'GET',
      url: rawUrl('big.mp4'),
      headers: { range: 'bytes=0-99' },
    });

    expect(res.statusCode).toBe(206);
  });
});
