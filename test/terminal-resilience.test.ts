// Port: none (pure helpers — no browser, no server).
//
// Three small decision functions behind the mobile terminal resilience work,
// pinned here because the code that consumes them lives in app.js /
// terminal-ui.js, which the CI gate cannot execute. Keeping the decision pure
// and the DOM half thin is what makes any of this testable without a browser.
//
// The renderer-liveness case is the one worth reading. iOS DISCARDS scheduled
// requestAnimationFrame callbacks when a PWA backgrounds — never delivered, not
// deferred — and xterm's RenderDebouncer only clears its `_animationFrame`
// handle from inside that callback. One drop leaves the handle permanently set,
// so every later refresh() returns immediately and the terminal freezes while
// its buffer keeps updating correctly. Codeman has exactly one xterm instance
// per page load, so a single backgrounding can wedge it until a reload.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

function loadConstants() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  const w = context.window as {
    CodemanRenderLiveness: {
      shouldKickRenderer: (s: {
        wroteAt: number;
        renderedAt: number;
        now: number;
        visible: boolean;
        thresholdMs?: number;
      }) => boolean;
      RENDER_STALL_MS: number;
      RENDER_LIVENESS_POLL_MS: number;
    };
    CodemanFetchDeadline: {
      terminalFetchDeadlineMs: (s: { full?: boolean; inflight?: number }) => number;
      FETCH_DEADLINE_TAIL_MS: number;
      FETCH_DEADLINE_FULL_MS: number;
      FETCH_DEADLINE_MAX_MS: number;
    };
    CodemanDiag: {
      sanitizeDiagEntry: (msg: unknown) => string;
      DIAG_ENTRY_MAX_CHARS: number;
    };
  };
  return w;
}

describe('shouldKickRenderer', () => {
  const { CodemanRenderLiveness } = loadConstants();
  const { shouldKickRenderer, RENDER_STALL_MS } = CodemanRenderLiveness;

  // The signature of the real failure: bytes were written, the element is
  // visible, and no frame has been produced since.
  it('kicks when a visible terminal owes a frame past the threshold', () => {
    expect(shouldKickRenderer({ wroteAt: 1000, renderedAt: 500, now: 1000 + RENDER_STALL_MS, visible: true })).toBe(
      true
    );
  });

  it('does not kick before the threshold elapses', () => {
    expect(shouldKickRenderer({ wroteAt: 1000, renderedAt: 500, now: 1000 + RENDER_STALL_MS - 1, visible: true })).toBe(
      false
    );
  });

  // A render at or after the last write means the pipeline is alive. This is
  // the common case on every healthy terminal and must never kick.
  it('does not kick when a render landed after the last write', () => {
    expect(shouldKickRenderer({ wroteAt: 1000, renderedAt: 1000, now: 99_999, visible: true })).toBe(false);
    expect(shouldKickRenderer({ wroteAt: 1000, renderedAt: 1200, now: 99_999, visible: true })).toBe(false);
  });

  // A hidden terminal legitimately stops rendering — xterm pauses it. Kicking
  // there would fire on every backgrounded tab, forever.
  it('never kicks a hidden terminal', () => {
    expect(shouldKickRenderer({ wroteAt: 1000, renderedAt: 500, now: 99_999, visible: false })).toBe(false);
  });

  // A quiet terminal is the normal state, not a stalled one. Gating on "no
  // render recently" instead of "owes a frame" would kick every idle session.
  it('never kicks a terminal that has never been written to', () => {
    expect(shouldKickRenderer({ wroteAt: 0, renderedAt: 0, now: 99_999, visible: true })).toBe(false);
  });

  it('tolerates missing and malformed input rather than throwing', () => {
    expect(shouldKickRenderer(undefined as never)).toBe(false);
    expect(shouldKickRenderer({} as never)).toBe(false);
    expect(shouldKickRenderer({ wroteAt: NaN, renderedAt: NaN, now: NaN, visible: true } as never)).toBe(false);
  });

  it('polls coarsely enough not to wake an idle phone every second', () => {
    expect(CodemanRenderLiveness.RENDER_LIVENESS_POLL_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe('terminalFetchDeadlineMs', () => {
  const { CodemanFetchDeadline } = loadConstants();
  const { terminalFetchDeadlineMs, FETCH_DEADLINE_TAIL_MS, FETCH_DEADLINE_FULL_MS, FETCH_DEADLINE_MAX_MS } =
    CodemanFetchDeadline;

  // A full scrollback capture can be megabytes where a tail is one frame, so a
  // single fixed timeout is wrong in both directions on a mobile link.
  it('gives a full capture more budget than a tail', () => {
    expect(terminalFetchDeadlineMs({ full: true })).toBeGreaterThan(terminalFetchDeadlineMs({ full: false }));
    expect(terminalFetchDeadlineMs({ full: false })).toBe(FETCH_DEADLINE_TAIL_MS);
    expect(terminalFetchDeadlineMs({ full: true })).toBe(FETCH_DEADLINE_FULL_MS);
  });

  // Eight tabs resuming must not all expire together because each assumed it
  // had the link to itself.
  it('scales with captures already in flight', () => {
    const alone = terminalFetchDeadlineMs({ full: false, inflight: 0 });
    const queued = terminalFetchDeadlineMs({ full: false, inflight: 3 });
    expect(queued).toBeGreaterThan(alone);
  });

  it('is bounded — a stuck link still fails eventually', () => {
    expect(terminalFetchDeadlineMs({ full: true, inflight: 1000 })).toBe(FETCH_DEADLINE_MAX_MS);
  });

  it('treats absent and nonsense input as a lone tail fetch', () => {
    expect(terminalFetchDeadlineMs({})).toBe(FETCH_DEADLINE_TAIL_MS);
    expect(terminalFetchDeadlineMs({ inflight: -5 } as never)).toBe(FETCH_DEADLINE_TAIL_MS);
    expect(terminalFetchDeadlineMs({ inflight: NaN } as never)).toBe(FETCH_DEADLINE_TAIL_MS);
  });
});

describe('sanitizeDiagEntry', () => {
  const { CodemanDiag } = loadConstants();
  const { sanitizeDiagEntry, DIAG_ENTRY_MAX_CHARS } = CodemanDiag;

  // The crash trail is joined with '\n' into one localStorage value and
  // beaconed, and at least one call site interpolates a WebSocket close
  // `reason`, which the server controls. A newline there forges entries.
  it('collapses every newline form so an entry cannot forge another', () => {
    expect(sanitizeDiagEntry('WS CLOSE reason=a\nFAKE ENTRY')).toBe('WS CLOSE reason=a FAKE ENTRY');
    expect(sanitizeDiagEntry('a\r\nb')).toBe('a b');
    expect(sanitizeDiagEntry('a b c')).toBe('a b c');
  });

  it('bounds length so one entry cannot exhaust the storage quota', () => {
    const out = sanitizeDiagEntry('x'.repeat(DIAG_ENTRY_MAX_CHARS * 3));
    expect(out).toHaveLength(DIAG_ENTRY_MAX_CHARS);
  });

  it('never throws on the values a diagnostic call site can actually pass', () => {
    expect(sanitizeDiagEntry(null)).toBe('');
    expect(sanitizeDiagEntry(undefined)).toBe('');
    expect(sanitizeDiagEntry(42)).toBe('42');
    expect(sanitizeDiagEntry({ toString: () => 'obj' })).toBe('obj');
  });
});

// ── The deadline must cover the BODY, not just the handshake ────────────────
//
// `await fetch()` settles on response HEADERS. Clearing the abort timer there
// leaves the body — the multi-megabyte `?full=1` capture the deadline exists
// for — completely unbounded; it only ever covered a server that accepts a
// connection and never replies at all.
//
// Measured on the pre-fix shape against a server that sends headers immediately
// and stalls the body 4s under a 1s deadline: fetch resolved at 30ms, the timer
// was cleared there, and the body completed at 4026ms unaborted.
//
// This exercises the real property with a real socket rather than asserting on
// source text, because the bug was a lifetime mistake that reads correctly.
describe('terminal capture deadline covers the response body', () => {
  // Mirrors _fetchTerminalCapture's lifetime: one timer spanning headers AND
  // body, cleared only once the body has been read.
  async function captureUnderDeadline(url: string, deadlineMs: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const headersAt = performance.now();
      const json = await res.json();
      return { json, headers: res.headers, headersAt };
    } finally {
      clearTimeout(timer);
    }
  }

  async function serve(handler: (res: ServerResponse) => void) {
    const srv = createServer((_req, res) => handler(res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/`, close: () => srv.close() };
  }

  it('aborts a stalled body instead of waiting on it forever', async () => {
    let finish: NodeJS.Timeout | undefined;
    const { url, close } = await serve((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(' '); // headers out immediately, body never completes in time
      finish = setTimeout(() => res.end('{"data":{}}'), 5000);
    });
    try {
      await expect(captureUnderDeadline(url, 300)).rejects.toThrow(/abort/i);
    } finally {
      if (finish) clearTimeout(finish);
      close();
    }
  });

  // The two tests above exercise the PATTERN against a real socket, using a
  // local mirror — so on their own they would still pass if the real helper
  // regressed to clearing its timer at headers. This pins the real one.
  it('_fetchTerminalCapture reads the body before releasing its deadline', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = app.indexOf('async _fetchTerminalCapture(');
    expect(start, 'helper not found — renamed?').toBeGreaterThan(-1);
    const body = app.slice(start, app.indexOf('\n  }', start));
    const jsonAt = body.indexOf('await res.json()');
    const finallyAt = body.indexOf('} finally {');
    expect(jsonAt, 'the body must be read inside the helper, not by callers').toBeGreaterThan(-1);
    expect(finallyAt).toBeGreaterThan(-1);
    expect(
      jsonAt,
      'await res.json() must run BEFORE the finally that clears the abort timer — ' +
        'fetch() settles on headers, so a timer cleared there leaves the body unbounded'
    ).toBeLessThan(finallyAt);
    // And the returned shape the five call sites destructure.
    expect(body).toContain('return { json, headers: res.headers, headersAt };');
  });

  // Nothing in the gate pinned the invariant this PR exists to establish, which
  // is the same drift it is fixing: a clear()+reset() pair reads as obviously
  // equivalent to the queued RIS and is exactly what someone tidies back in.
  it('_resetTerminalForReplay is a queued write and nothing else', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = app.indexOf('_resetTerminalForReplay() {');
    expect(start, 'helper not found — renamed?').toBeGreaterThan(-1);
    const body = app.slice(start, app.indexOf('\n  }', start));
    // RIS, queued through write() so it lands after any bytes already parsing.
    expect(body).toContain("this.terminal.write('\\x1bc')");
    expect(
      body,
      'reset()/clear() are SYNCHRONOUS and skip the write queue, so bytes queued ' +
        'before them are parsed after and fuse into the snapshot written next'
    ).not.toMatch(/\.(reset|clear)\(\)/);
  });

  it('every replay path clears through that helper, never by hand', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    // The three paths that blank the terminal before rewriting it from a capture.
    for (const site of ['_onSessionNeedsRefresh(event = {}) {', 'async _onSessionClearTerminal(data) {']) {
      const start = app.indexOf(site);
      expect(start, `${site} not found — renamed?`).toBeGreaterThan(-1);
      const body = app.slice(start, start + 4000);
      expect(body, `${site} must clear via _resetTerminalForReplay`).toContain('this._resetTerminalForReplay()');
      expect(body, `${site} hand-rolled a clear again`).not.toContain('this.terminal.clear()');
    }
    // And the PAIR appears nowhere in the frontend. A lone `clear()` before
    // `showWelcome()` is fine — nothing is written after it, so there is nothing
    // for stray bytes to fuse into. `clear()` immediately followed by `reset()`
    // is the signature of someone blanking the terminal to rewrite it, which is
    // precisely the case that has to be queued instead.
    const pair = /\.clear\(\);\s*\n\s*this\.terminal\.reset\(\)/;
    for (const rel of [
      'src/web/public/app.js',
      'src/web/public/panels-ui.js',
      'src/web/public/terminal-ui.js',
      'src/web/public/session-ui.js',
    ]) {
      const src = readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');
      expect(src, `${rel} blanks the terminal with clear()+reset() — use _resetTerminalForReplay()`).not.toMatch(pair);
    }
  });

  it('returns the parsed envelope and headers on a healthy response', async () => {
    const { url, close } = await serve((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'server-timing': 'db;dur=12' });
      res.end('{"data":{"terminalBuffer":"hello"}}');
    });
    try {
      const out = await captureUnderDeadline(url, 5000);
      // Callers read `capture.json?.data`, `capture.headers.get(...)` and
      // `capture.headersAt` — all three must survive.
      expect((out.json as { data: { terminalBuffer: string } }).data.terminalBuffer).toBe('hello');
      expect(out.headers.get('server-timing')).toBe('db;dur=12');
      expect(typeof out.headersAt).toBe('number');
    } finally {
      close();
    }
  });
});
