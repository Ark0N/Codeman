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
