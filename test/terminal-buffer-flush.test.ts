/**
 * @fileoverview Regression tests for the buffer-load flush path (COD-144).
 *
 * Bug: newly launched Shell sessions rendered BLANK until a tab-switch. The
 * buffer-load path (`selectSession` → `_beginBufferLoad`/`_finishBufferLoad`)
 * QUEUES live SSE terminal events while `_isLoadingBuffer` is true, then on
 * completion DISCARDS the queue (`_loadBufferQueue = null`). That de-dup is
 * correct for an established session (the fetched buffer already contains the
 * queued output, so replaying it would duplicate Ink redraws). But for a
 * brand-new shell the fetch resolves BEFORE the PTY emits its prompt — the
 * fetched buffer is empty and the prompt arrives only as a queued event, which
 * then gets discarded → blank terminal.
 *
 * Fix: `_finishBufferLoad(owner, { flushQueued })` REPLAYS the queued events
 * through `batchTerminalWrite()` (after `_isLoadingBuffer` is cleared, so they
 * write through normally) ONLY when the load painted nothing. The default path
 * (no opts) still discards, preserving de-dup for established sessions.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — jsdom is broken on this
 * box; see connection-indicator.test.ts). We extract the REAL
 * `_beginBufferLoad`/`_finishBufferLoad` mixin methods from terminal-ui.js by
 * running it against a fake `CodemanApp` and capturing `CodemanApp.prototype`,
 * then copy them onto a minimal stub whose `batchTerminalWrite` is a spy. This
 * exercises the real flush/discard logic without a full xterm fake.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** Run terminal-ui.js in a vm against a fake CodemanApp and return the captured prototype mixin. */
function loadTerminalMixin(): Record<string, unknown> {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    // terminal-ui.js IIFE is invoked with `window`; it reads/writes a few globals.
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: { addEventListener: vi.fn() },
  });
  vm.runInContext(source, context);
  return FakeCodemanApp.prototype;
}

const mixin = loadTerminalMixin();

type BufferLoadApp = {
  _bufferLoadSeq: number;
  _bufferLoadOwner: string | null;
  _isLoadingBuffer: boolean;
  _loadBufferQueue: { at: number; data: string }[] | null;
  batchTerminalWrite: (data: string) => void;
  _beginBufferLoad: (owner?: string) => string;
  _finishBufferLoad: (owner?: string, opts?: { flushQueued?: boolean; since?: number }) => boolean;
};

/**
 * Minimal stub carrying the buffer-load state plus the REAL begin/finish methods.
 * `batchTerminalWrite` is a spy so flushed events are observable without a real
 * xterm terminal. The real `batchTerminalWrite` would queue while loading, but
 * the flush runs AFTER `_isLoadingBuffer` is cleared, so a spy is faithful here.
 */
function makeApp() {
  const writes: string[] = [];
  const app: BufferLoadApp = {
    _bufferLoadSeq: 0,
    _bufferLoadOwner: null,
    _isLoadingBuffer: false,
    _loadBufferQueue: null,
    batchTerminalWrite: vi.fn((data: string) => {
      writes.push(data);
    }),
    _beginBufferLoad: mixin._beginBufferLoad as BufferLoadApp['_beginBufferLoad'],
    _finishBufferLoad: mixin._finishBufferLoad as BufferLoadApp['_finishBufferLoad'],
  };
  return { app, writes };
}

/**
 * Simulate a live SSE event arriving while a buffer load is in progress.
 * Mirrors batchTerminalWrite's queue branch, which stamps each entry with its
 * arrival time so a flush can replay only the tail (see the `since` tests).
 */
function pushWhileLoading(app: BufferLoadApp, data: string, at = performance.now()) {
  if (app._isLoadingBuffer && app._loadBufferQueue) app._loadBufferQueue.push({ at, data });
}

describe('buffer-load flush (COD-144)', () => {
  it('finish WITHOUT flushQueued discards the queue (de-dup preserved for established sessions)', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('load-1');
    pushWhileLoading(app, 'chunk-a');
    pushWhileLoading(app, 'chunk-b');

    const ok = app._finishBufferLoad(owner); // default: discard
    expect(ok).toBe(true);
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._loadBufferQueue).toBeNull();
    // Queued events were NOT replayed.
    expect(app.batchTerminalWrite).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('finish WITH { flushQueued: true } replays queued events in order, exactly once each', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('load-2');
    pushWhileLoading(app, 'prompt-1');
    pushWhileLoading(app, 'prompt-2');

    const ok = app._finishBufferLoad(owner, { flushQueued: true });
    expect(ok).toBe(true);
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._loadBufferQueue).toBeNull();
    // Both chunks replayed, IN ORDER, exactly once each.
    expect(writes).toEqual(['prompt-1', 'prompt-2']);
    expect(app.batchTerminalWrite).toHaveBeenCalledTimes(2);
    expect(app.batchTerminalWrite).toHaveBeenNthCalledWith(1, 'prompt-1');
    expect(app.batchTerminalWrite).toHaveBeenNthCalledWith(2, 'prompt-2');
  });

  it('flushed events are not re-queued (the queue is null when batchTerminalWrite runs)', () => {
    const { app } = makeApp();
    const owner = app._beginBufferLoad('load-3');
    pushWhileLoading(app, 'only');

    // Spy that, like the real method, would re-queue if loading were still active.
    let reQueued = false;
    app.batchTerminalWrite = vi.fn((data: string) => {
      if (app._isLoadingBuffer && app._loadBufferQueue) {
        app._loadBufferQueue.push(data);
        reQueued = true;
      }
    });

    app._finishBufferLoad(owner, { flushQueued: true });
    expect(reQueued).toBe(false);
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._loadBufferQueue).toBeNull();
  });

  it('owner mismatch returns false and does NOT flush or clear state', () => {
    const { app, writes } = makeApp();
    app._beginBufferLoad('real-owner');
    pushWhileLoading(app, 'queued');

    const ok = app._finishBufferLoad('wrong-owner', { flushQueued: true });
    expect(ok).toBe(false);
    // State untouched — still loading, queue intact, nothing replayed.
    expect(app._isLoadingBuffer).toBe(true);
    expect(app._bufferLoadOwner).toBe('real-owner');
    expect(app._loadBufferQueue).toEqual([{ at: expect.any(Number), data: 'queued' }]);
    expect(app.batchTerminalWrite).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  // ── The tmux-capture tail: `since` ──
  //
  // A pane capture is a point-in-time frame taken part-way through the fetch, so
  // it holds what arrived BEFORE the capture and nothing after. selectSession
  // passes the response's arrival time as `since`, which splits the queue at
  // exactly that line: pre-capture events are already painted and must stay
  // dropped, post-capture events exist nowhere else and must be replayed.

  it('flushes only the entries at or after `since`', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('load-since');
    pushWhileLoading(app, 'already-in-the-capture', 100);
    pushWhileLoading(app, 'arrived-at-the-headers', 200);
    pushWhileLoading(app, 'arrived-after-the-headers', 300);

    app._finishBufferLoad(owner, { flushQueued: true, since: 200 });

    // The pre-capture event stays dropped; the boundary entry counts as after.
    expect(writes).toEqual(['arrived-at-the-headers', 'arrived-after-the-headers']);
  });

  it('flushQueued without `since` still replays the whole queue', () => {
    // The COD-144 path: a brand-new session's first prompt predates the
    // response, so cutting the queue would drop the only content it has.
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('load-no-since');
    pushWhileLoading(app, 'prompt', 10);
    pushWhileLoading(app, 'more', 20);

    app._finishBufferLoad(owner, { flushQueued: true });

    expect(writes).toEqual(['prompt', 'more']);
  });

  it('a `since` past every entry flushes nothing', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('load-since-late');
    pushWhileLoading(app, 'old', 10);

    app._finishBufferLoad(owner, { flushQueued: true, since: 999 });

    expect(writes).toEqual([]);
    expect(app.batchTerminalWrite).not.toHaveBeenCalled();
  });

  // ── Re-entering one load ──
  //
  // `selectSession` opens the load before its fetch, and `chunkedTerminalWrite`
  // opens it again under the SAME owner when it starts writing. A reset on that
  // second call would silently throw away everything queued during the fetch,
  // which on the capture path is output no buffer holds.

  it('re-entering the same load keeps what the queue already holds', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('load-reenter');
    pushWhileLoading(app, 'arrived-during-the-fetch', 100);

    // chunkedTerminalWrite re-opens the load it was handed.
    app._beginBufferLoad(owner);
    pushWhileLoading(app, 'arrived-during-the-write', 200);

    app._finishBufferLoad(owner, { flushQueued: true, since: 50 });

    expect(writes).toEqual(['arrived-during-the-fetch', 'arrived-during-the-write']);
  });

  it('a genuinely different load still starts with an empty queue', () => {
    const { app, writes } = makeApp();
    app._beginBufferLoad('load-first');
    pushWhileLoading(app, 'belongs-to-the-abandoned-load', 100);

    // A tab switch starts a new load under a new owner. Its events are not ours.
    const second = app._beginBufferLoad('load-second');
    pushWhileLoading(app, 'belongs-to-this-load', 200);

    app._finishBufferLoad(second, { flushQueued: true, since: 0 });

    expect(writes).toEqual(['belongs-to-this-load']);
  });

  it('empty queue + flushQueued is a no-op (no throw, no writes)', () => {
    const { app, writes } = makeApp();
    const owner = app._beginBufferLoad('load-empty');
    // No events queued.

    expect(() => app._finishBufferLoad(owner, { flushQueued: true })).not.toThrow();
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._loadBufferQueue).toBeNull();
    expect(app.batchTerminalWrite).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
