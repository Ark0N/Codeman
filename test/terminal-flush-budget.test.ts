import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness(mode: string) {
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    window: {},
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => 0 },
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (_fn: () => void) => 1,
    Blob: function Blob() {},
    URL: {
      createObjectURL: () => 'blob:yield',
      revokeObjectURL: () => {},
    },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });

  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as any)();
  const writes: string[] = [];
  app.activeSessionId = 'session-1';
  app.sessions = new Map([['session-1', { mode }]]);
  app.pendingWrites = [];
  app.writeFrameScheduled = false;
  app._wasAtBottomBeforeWrite = false;
  app._workerYield = () => {};
  app._chunkedWriteGen = 0;
  app.terminal = {
    write: (data: string, callback?: () => void) => {
      writes.push(data);
      callback?.();
    },
    scrollToBottom: () => {},
    scrollToLine: () => {},
  };

  return { app, writes };
}

/**
 * Swap in a terminal whose write() parses ASYNCHRONOUSLY, the way xterm.js does.
 *
 * The real renderer queues the chunk and applies it later, firing the write
 * callback once it has been parsed; a redraw that addresses a row past the
 * viewport (Codex's status line) drags the viewport to the live bottom at that
 * point, not when write() returns. `parse()` runs that pending work.
 */
function attachAsyncParsingTerminal(app: any, opts: { viewportY: number; baseY: number }) {
  const buffer = { viewportY: opts.viewportY, baseY: opts.baseY };
  const pending: Array<() => void> = [];
  app.terminal.buffer = { active: buffer };
  app.terminal.write = vi.fn((_data: string, callback?: () => void) => {
    pending.push(() => {
      buffer.viewportY = buffer.baseY; // the redraw lands
      callback?.();
    });
  });
  app.terminal.scrollToLine = vi.fn((line: number) => {
    buffer.viewportY = line;
  });
  app.terminal.scrollToBottom = vi.fn(() => {
    buffer.viewportY = buffer.baseY;
  });
  return {
    buffer,
    parse: () => {
      const queued = pending.splice(0, pending.length);
      for (const run of queued) run();
    },
  };
}

function loadAppHarness() {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const fetchMock = vi.fn();
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    performance: { now: () => 0 },
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: fetchMock,
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
  });
  const constants = readFileSync(resolve(dir, 'constants.js'), 'utf8');
  const appSource = readFileSync(resolve(dir, 'app.js'), 'utf8');
  vm.runInContext(`${constants}\n${appSource}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  const CodemanApp = (context as { __CodemanApp: { prototype: object } }).__CodemanApp;
  return { CodemanApp, fetchMock };
}

describe('terminal flush budget', () => {
  it('counts incoming, loading, and xterm in-flight bytes before accepting live output', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = source.indexOf('_onSessionTerminal(data)');
    const body = source.slice(start, source.indexOf('\n  // ═', start));

    expect(body).toContain('this._loadBufferQueue?.reduce');
    expect(body).toContain('this._terminalWriteInFlightBytes || 0');
    expect(body).toContain('queued + data.data.length > 131072');
  });

  it('drops redundant SSE terminal events whenever WebSocket owns terminal I/O', () => {
    const { CodemanApp } = loadAppHarness();
    const app = Object.create(CodemanApp.prototype) as any;
    app._wsReady = true;
    app._onSessionTerminal = vi.fn();
    app._onSessionNeedsRefresh = vi.fn();
    app._onSessionClearTerminal = vi.fn();

    app._onSSETerminal({ id: 'session-1', data: 'duplicate' });
    app._onSSENeedsRefresh({});
    app._onSSEClearTerminal({ id: 'session-1' });

    expect(app._onSessionTerminal).not.toHaveBeenCalled();
    expect(app._onSessionNeedsRefresh).not.toHaveBeenCalled();
    expect(app._onSessionClearTerminal).not.toHaveBeenCalled();
  });

  it('runs at most one buffer recovery per session and ignores stale-session events', async () => {
    const { CodemanApp, fetchMock } = loadAppHarness();
    const app = Object.create(CodemanApp.prototype) as any;
    app.activeSessionId = 'session-1';
    app.sessions = new Map([['session-1', { mode: 'shell' }]]);
    app.terminal = {};
    app._isLoadingBuffer = false;
    app._terminalRefreshOwner = null;

    let releaseFetch!: () => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolveFetch) => {
          releaseFetch = () => resolveFetch({ json: async () => ({ data: { terminalBuffer: '' } }) });
        })
    );

    await app._onSessionNeedsRefresh({ id: 'stale-session' });
    expect(fetchMock).not.toHaveBeenCalled();

    const first = app._onSessionNeedsRefresh({ id: 'session-1' });
    const duplicate = app._onSessionNeedsRefresh({ id: 'session-1' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/terminal?tail=1048576');

    releaseFetch();
    await Promise.all([first, duplicate]);
    expect(app._terminalRefreshOwner).toBe(null);
  });

  it('drains a large final batch without waiting for unrelated terminal output', () => {
    const { app, writes } = loadTerminalUiHarness('codex');
    const scheduled: Array<() => void> = [];
    app._safeYield = (callback: () => void) => {
      scheduled.push(callback);
    };
    app.isTerminalAtBottom = () => true;

    app.batchTerminalWrite('x'.repeat(96 * 1024));
    expect(scheduled).toHaveLength(1);

    while (scheduled.length > 0) {
      scheduled.shift()?.();
    }

    expect(writes.map((write) => write.length)).toEqual([32 * 1024, 32 * 1024, 32 * 1024]);
    expect(app.pendingWrites).toEqual([]);
    expect(app.writeFrameScheduled).toBe(false);
  });

  it('uses a smaller first-frame write budget for Codex output to reduce renderer stalls', () => {
    const { app, writes } = loadTerminalUiHarness('codex');
    app.pendingWrites.push('x'.repeat(96 * 1024));

    app.flushPendingWrites();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(32 * 1024);
    expect(app.pendingWrites.join('')).toHaveLength(64 * 1024);
  });

  it('keeps the larger first-frame write budget for non-Codex terminal output', () => {
    const { app, writes } = loadTerminalUiHarness('claude');
    app.pendingWrites.push('x'.repeat(96 * 1024));

    app.flushPendingWrites();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(64 * 1024);
    expect(app.pendingWrites.join('')).toHaveLength(32 * 1024);
  });

  it('waits for xterm to parse a live chunk before submitting the next one', () => {
    const { app, writes } = loadTerminalUiHarness('shell');
    const scheduled: Array<() => void> = [];
    let parsed: (() => void) | undefined;
    app._safeYield = (callback: () => void) => scheduled.push(callback);
    app.isTerminalAtBottom = () => true;
    app.terminal.write = (data: string, callback?: () => void) => {
      writes.push(data);
      parsed = callback;
    };

    app.batchTerminalWrite('x'.repeat(96 * 1024));
    scheduled.shift()?.();

    expect(writes.map((write) => write.length)).toEqual([64 * 1024]);
    expect(app.pendingWrites.join('')).toHaveLength(32 * 1024);
    expect(scheduled).toHaveLength(0);
    expect(app._terminalWriteInFlightBytes).toBe(64 * 1024);

    parsed?.();

    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(writes.map((write) => write.length)).toEqual([64 * 1024, 32 * 1024]);
  });

  it('releases the live-output gate but waits for xterm to parse a small replay', async () => {
    const { app, writes } = loadTerminalUiHarness('codex');
    let writeDone: (() => void) | undefined;
    let resolved = false;
    const finishBufferLoad = vi.fn();
    app._finishBufferLoad = finishBufferLoad;
    app.terminal.write = (data: string, callback?: () => void) => {
      writes.push(data);
      writeDone = callback;
    };

    const promise = app.chunkedTerminalWrite('fresh tmux pane frame').then(() => {
      resolved = true;
    });

    await Promise.resolve();

    expect(writes).toEqual(['fresh tmux pane frame']);
    expect(writeDone).toBeTypeOf('function');
    expect(resolved).toBe(false);
    expect(finishBufferLoad).toHaveBeenCalledOnce();

    writeDone?.();
    await promise;

    expect(resolved).toBe(true);
  });

  it('paces a large enqueue and releases live output before the parse marker completes', async () => {
    const { app, writes } = loadTerminalUiHarness('shell');
    const scheduled: Array<() => void> = [];
    let parseDone: (() => void) | undefined;
    let resolved = false;
    let result: { parsedAt: number; bufferLength: number; completed: boolean } | undefined;
    app._safeYield = (callback: () => void) => scheduled.push(callback);
    app.isTerminalAtBottom = () => true;
    app.terminal.buffer = { active: { length: 37 } };
    app.terminal.write = (data: string, callback?: () => void) => {
      writes.push(data);
      if (callback) parseDone = callback;
    };

    const promise = app.chunkedTerminalWrite('x'.repeat(3 * 32 * 1024)).then((value: typeof result) => {
      result = value;
      resolved = true;
    });
    expect(writes).toEqual([]);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    expect(writes.map((write) => write.length)).toEqual([32 * 1024]);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    expect(writes.map((write) => write.length)).toEqual([32 * 1024, 32 * 1024]);
    expect(resolved).toBe(false);

    scheduled.shift()?.();
    expect(writes.map((write) => write.length)).toEqual([32 * 1024, 32 * 1024, 32 * 1024, 0]);
    expect(app._isLoadingBuffer).toBe(false);
    expect(resolved).toBe(false);

    app.batchTerminalWrite('new output after snapshot');
    expect(app._loadBufferQueue).toBe(null);
    expect(app.pendingWrites).toEqual(['new output after snapshot']);

    parseDone?.();
    app.terminal.buffer.active.length = 42;
    await promise;
    expect(resolved).toBe(true);
    expect(result?.bufferLength).toBe(37);
    expect(result?.completed).toBe(true);
  });

  it('marks a parse callback stale when a newer replay supersedes it', async () => {
    const { app } = loadTerminalUiHarness('shell');
    let parseDone: (() => void) | undefined;
    app.terminal.write = (_data: string, callback?: () => void) => {
      parseDone = callback;
    };

    const firstReplay = app.chunkedTerminalWrite('old snapshot');
    app._chunkedWriteGen += 1;
    parseDone?.();

    await expect(firstReplay).resolves.toMatchObject({ completed: false });
  });

  it('scans xterm rows from buffer.length instead of double-counting baseY', () => {
    const { app } = loadTerminalUiHarness('shell');
    const getLine = vi.fn((index: number) =>
      index === 99 || index === 77 ? { translateToString: () => 'content' } : undefined
    );
    app.terminal = {
      rows: 24,
      buffer: { active: { baseY: 76, length: 100, getLine } },
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
    };

    app.scrollToLastNonEmptyLine();

    expect(getLine.mock.calls[0]?.[0]).toBe(99);
    expect(app.terminal.scrollToLine).toHaveBeenCalledWith(77);
  });

  it('keeps stale buffer load owners from finishing a newer load', () => {
    const { app } = loadTerminalUiHarness('codex');

    app._beginBufferLoad('select-1');
    app._beginBufferLoad('select-2');

    expect(app._finishBufferLoad('select-1')).toBe(false);
    expect(app._isLoadingBuffer).toBe(true);
    expect(app._bufferLoadOwner).toBe('select-2');

    expect(app._finishBufferLoad('select-2')).toBe(true);
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._bufferLoadOwner).toBe(null);
  });

  it('does not snap back to bottom during Codex Working redraws right after the user scrolls up', () => {
    const { app } = loadTerminalUiHarness('codex');
    const scrollToBottom = vi.fn();
    app.terminal.scrollToBottom = scrollToBottom;
    app._wasAtBottomBeforeWrite = true;
    app._lastUserScrollUpAt = 0;
    app.pendingWrites.push('\x1b[55;1H\x1b[2m• Working (6s)');

    app.flushPendingWrites();

    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('restores the user scroll position when Codex Working redraws move the viewport', () => {
    const { app } = loadTerminalUiHarness('codex');
    const { buffer, parse } = attachAsyncParsingTerminal(app, { viewportY: 40, baseY: 100 });
    app._wasAtBottomBeforeWrite = true;
    app._lastUserScrollUpAt = 0;
    app.pendingWrites.push('\x1b[55;1H\x1b[2m• Working (6s)');

    app.flushPendingWrites();
    parse();

    expect(buffer.viewportY).toBe(40);
  });

  // Issue #358. xterm.js parses on its own schedule, so the buffer still holds
  // the pre-write viewport the instant write() returns: restoring there compared
  // the anchor against itself, did nothing, and left the redraw free to drag the
  // viewport to the live bottom a tick later. The previous regression passed
  // because its write mock moved the viewport synchronously, which real xterm
  // never does. These drive the callback explicitly instead.
  it('restores the history anchor only AFTER xterm has parsed the write (#358)', () => {
    const { app } = loadTerminalUiHarness('codex');
    const { buffer, parse } = attachAsyncParsingTerminal(app, { viewportY: 40, baseY: 100 });
    app.pendingWrites.push('\x1b[55;1H\x1b[2m• Working (6s)');

    app.flushPendingWrites();
    // Nothing has parsed yet, so nothing may have been restored yet either.
    expect(app.terminal.scrollToLine).not.toHaveBeenCalled();
    expect(buffer.viewportY).toBe(40);

    parse();

    expect(app.terminal.scrollToLine).toHaveBeenCalledWith(40);
    expect(buffer.viewportY).toBe(40);
  });

  it('holds the anchor across consecutive Codex redraws', () => {
    const { app } = loadTerminalUiHarness('codex');
    const { buffer, parse } = attachAsyncParsingTerminal(app, { viewportY: 40, baseY: 100 });

    for (const frame of ['\x1b[55;1H\x1b[2m• Working (6s)', '\x1b[55;1H\x1b[2m• Working (7s)']) {
      app.pendingWrites.push(frame);
      app.flushPendingWrites();
      parse();
      expect(buffer.viewportY).toBe(40);
    }
  });

  it('holds the anchor across a chunked write whose remainder is deferred', () => {
    const { app } = loadTerminalUiHarness('codex');
    const { buffer, parse } = attachAsyncParsingTerminal(app, { viewportY: 40, baseY: 100 });
    // Over the 32KB codex frame budget, so the flush defers a remainder and the
    // second chunk goes out from the write callback's reschedule.
    app.pendingWrites.push('x'.repeat(40000));

    app.flushPendingWrites();
    parse();
    expect(buffer.viewportY).toBe(40);

    app.flushPendingWrites();
    parse();
    expect(buffer.viewportY).toBe(40);
    expect(app.pendingWrites).toHaveLength(0);
  });

  it('drops the anchor when the user switched sessions before the write parsed', () => {
    // The anchor indexes the buffer it came from. selectSession() resets the
    // terminal and chunk-loads a different scrollback, so replaying row 40 into
    // that one is a jump to an arbitrary place, not a restore. Only reachable now
    // that the restore runs a parse later than the write.
    const { app } = loadTerminalUiHarness('codex');
    const { buffer, parse } = attachAsyncParsingTerminal(app, { viewportY: 40, baseY: 100 });
    app.pendingWrites.push('\x1b[55;1H\x1b[2m• Working (6s)');

    app.flushPendingWrites();
    app.activeSessionId = 'session-2'; // the user clicked another tab
    parse();

    expect(app.terminal.scrollToLine).not.toHaveBeenCalled();
    expect(buffer.viewportY).toBe(buffer.baseY);
  });

  it('drops the anchor while a buffer load is replaying history', () => {
    const { app } = loadTerminalUiHarness('codex');
    const { parse } = attachAsyncParsingTerminal(app, { viewportY: 40, baseY: 100 });
    app.pendingWrites.push('\x1b[55;1H\x1b[2m• Working (6s)');

    app.flushPendingWrites();
    app._isLoadingBuffer = true; // chunkedTerminalWrite owns the viewport now
    parse();

    expect(app.terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it('does not bounce off the bottom when the sticky flag and an anchor disagree', () => {
    // _wasAtBottomBeforeWrite is captured at the frame's first batchTerminalWrite
    // and the anchor at flush time, so a scroll-up in between leaves both live.
    // The anchor wins: scrolling to the bottom and back would be a visible jump.
    const { app } = loadTerminalUiHarness('codex');
    const { buffer, parse } = attachAsyncParsingTerminal(app, { viewportY: 40, baseY: 100 });
    app._wasAtBottomBeforeWrite = true;
    app._lastUserScrollUpAt = 0;
    app.pendingWrites.push('\x1b[55;1H\x1b[2m• Working (6s)');

    app.flushPendingWrites();
    parse();

    expect(app.terminal.scrollToBottom).not.toHaveBeenCalled();
    expect(buffer.viewportY).toBe(40);
  });
});
