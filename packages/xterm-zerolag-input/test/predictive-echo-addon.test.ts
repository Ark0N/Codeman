/**
 * @vitest-environment jsdom
 *
 * PredictiveEchoAddon unit tests: the algorithm laws (anchoring, prefix-only
 * confirmation with cursor advance, two-pass mismatch cascade with neutral
 * blanks, TTL, off-row grace, gates) and lifecycle safety.
 *
 * Timer-based cases fake `performance` explicitly: the addon clocks
 * sentAt/TTL/grace with performance.now(), which vitest does NOT fake by
 * default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PredictiveEchoAddon } from '../src/predictive-echo-addon.js';
import { createMockTerminal } from './helpers.js';

const TIMER_CONFIG = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const,
};

/** Composer-like buffer: `› ` marker + placeholder, cursor at col 2 row 0. */
function composerMock(opts: Parameters<typeof createMockTerminal>[0] = {}) {
  return createMockTerminal({
    buffer: { lines: ['› Use /skills to list', '', ''], cursorX: 2, cursorY: 0 },
    ...opts,
  });
}

function spansOf(mock: ReturnType<typeof createMockTerminal>): HTMLSpanElement[] {
  const screen = mock.terminal.element.querySelector('.xterm-screen')!;
  return Array.from(screen.querySelectorAll('[data-predictive-echo] span')) as HTMLSpanElement[];
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PredictiveEchoAddon', () => {
  let mock: ReturnType<typeof createMockTerminal>;
  let addon: PredictiveEchoAddon;

  beforeEach(() => {
    vi.useFakeTimers(TIMER_CONFIG);
    mock = composerMock();
    addon = new PredictiveEchoAddon();
    addon.activate(mock.terminal as never);
  });

  afterEach(() => {
    addon.dispose();
    mock.cleanup();
    vi.useRealTimers();
  });

  it('paints a span at the cursor cell and returns true', () => {
    expect(addon.predictChar('h')).toBe(true);
    const spans = spansOf(mock);
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe('h');
    expect(spans[0].style.left).toBe(`${2 * 8.4}px`);
    expect(spans[0].style.top).toBe('0px');
    expect(addon.state.outstanding).toBe(1);
  });

  it('stacks predictions at anchor+cumulative width while the cursor is unmoved', () => {
    addon.predictChar('h');
    addon.predictChar('e');
    addon.predictChar('y');
    const spans = spansOf(mock);
    expect(spans.map((s) => s.style.left)).toEqual([`${2 * 8.4}px`, `${3 * 8.4}px`, `${4 * 8.4}px`]);
    expect(addon.state.anchor).toEqual({ row: 0, col: 2 });
  });

  it('exposes only the unconfirmed text for prompt handoff', async () => {
    addon.predictChar('h');
    addon.predictChar('i');
    expect(addon.pendingText).toBe('hi');

    mock.setLine(0, '› h');
    mock.setCursor(3, 0);
    mock.fireWriteParsed();
    await flushMicrotasks();

    expect(addon.pendingText).toBe('i');
  });

  it('re-anchors at the new cursor once outstanding drains to zero', async () => {
    addon.predictChar('h');
    mock.setLine(0, '› h');
    mock.setCursor(3, 0);
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(0);
    expect(addon.state.anchor).toBeNull();

    addon.predictChar('i');
    expect(addon.state.anchor).toEqual({ row: 0, col: 3 });
    expect(spansOf(mock)[0].style.left).toBe(`${3 * 8.4}px`);
  });

  it('inline reconcile inside predictChar absorbs an echo that landed between keystrokes', () => {
    addon.predictChar('h');
    // Echo lands but no onWriteParsed fires before the next keystroke
    mock.setLine(0, '› h');
    mock.setCursor(3, 0);
    expect(addon.predictChar('i')).toBe(true);
    // 'h' confirmed inline; 'i' anchored at the advanced cursor, not stacked
    expect(addon.state.outstanding).toBe(1);
    expect(addon.state.confirmedTotal).toBe(1);
    expect(addon.state.anchor).toEqual({ row: 0, col: 3 });
  });

  it('confirms and removes exactly the echoed prefix (cell match + cursor advance)', async () => {
    addon.predictChar('a');
    addon.predictChar('b');
    addon.predictChar('c');
    mock.setLine(0, '› ab');
    mock.setCursor(4, 0); // advanced past 'a' and 'b' only
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.confirmedTotal).toBe(2);
    expect(addon.state.outstanding).toBe(1);
    expect(spansOf(mock).map((s) => s.textContent)).toEqual(['c']);
  });

  it('partial confirmation never moves remaining spans (no jitter)', async () => {
    addon.predictChar('a');
    addon.predictChar('b');
    const bLeft = spansOf(mock)[1].style.left;
    mock.setLine(0, '› a');
    mock.setCursor(3, 0);
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(spansOf(mock)).toHaveLength(1);
    expect(spansOf(mock)[0].style.left).toBe(bLeft);
  });

  it('does NOT confirm when the cell matches but the cursor has not advanced (in-place repaint)', async () => {
    // Predict 'U' over the placeholder whose cell already shows 'U'
    addon.predictChar('U');
    expect(addon.state.outstanding).toBe(1);
    // tmux repaints the identical row; cursor stays at the anchor
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(1);
    expect(addon.state.confirmedTotal).toBe(0);
  });

  it('does NOT confirm or drop when the predicted char equals the pre-existing snapshot', async () => {
    addon.predictChar('U');
    // Several passes over the unchanged placeholder: no confirm, no cascade
    for (let i = 0; i < 4; i++) {
      mock.fireWriteParsed();
      await flushMicrotasks();
    }
    expect(addon.state.outstanding).toBe(1);
    expect(addon.state.droppedTotal).toBe(0);
  });

  it('one transient mismatch survives; a persistent foreign cell cascades (two-pass rule)', async () => {
    addon.predictChar('a');
    mock.setLine(0, '› Z'); // foreign non-blank at the predicted cell
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(1); // pass 1: survives

    // Transient recovery resets the counter
    mock.setLine(0, '› Use /skills to list');
    mock.fireWriteParsed();
    await flushMicrotasks();
    mock.setLine(0, '› Z');
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(1); // count restarted, pass 1 again

    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(0); // pass 2: cascaded
    expect(addon.state.droppedTotal).toBe(1);
    expect(spansOf(mock)).toHaveLength(0);
  });

  it('blank cells are neutral: placeholder cleared under predictions does not cascade', async () => {
    // Predict over placeholder text, then codex clears the placeholder on
    // first echo: later cells become blank, which must NOT count as
    // foreign (measured behavior; without this, fast typing over the
    // placeholder drops exactly when RTT is high).
    addon.predictChar('h');
    addon.predictChar('i');
    mock.setLine(0, '› h'); // 'h' echoed; placeholder gone; 'i' cell now blank
    mock.setCursor(3, 0);
    for (let i = 0; i < 4; i++) {
      mock.fireWriteParsed();
      await flushMicrotasks();
    }
    expect(addon.state.confirmedTotal).toBe(1);
    expect(addon.state.outstanding).toBe(1); // 'i' still pending, TTL-bounded
    expect(addon.state.droppedTotal).toBe(0);
  });

  it('mismatch cascade drops the record and all later ones, earlier confirmed stay gone', async () => {
    addon.predictChar('a');
    addon.predictChar('b');
    addon.predictChar('c');
    mock.setLine(0, '› aXX'); // 'a' echoed; foreign 'X' under 'b' and 'c'
    mock.setCursor(3, 0);
    mock.fireWriteParsed();
    await flushMicrotasks();
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.confirmedTotal).toBe(1);
    expect(addon.state.droppedTotal).toBe(2);
    expect(addon.state.outstanding).toBe(0);
    expect(spansOf(mock)).toHaveLength(0);
  });

  it('TTL expiry drops predictions and leaves no timers armed (fake timers)', () => {
    addon.predictChar('a');
    addon.predictChar('b');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1100);
    expect(addon.state.outstanding).toBe(0);
    expect(addon.state.droppedTotal).toBe(2);
    expect(spansOf(mock)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('TTL timer re-arms for remaining records after a partial confirm', async () => {
    addon.predictChar('a'); // t=0, deadline ~1001
    vi.advanceTimersByTime(600);
    addon.predictChar('b'); // t=600, deadline ~1601
    // Echo confirms 'a' before its TTL; 'b' remains
    mock.setLine(0, '› a');
    mock.setCursor(3, 0);
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(1);
    vi.advanceTimersByTime(450); // t=1050: a's timer fired, b (age 450) survives
    expect(addon.state.outstanding).toBe(1);
    expect(vi.getTimerCount()).toBe(1); // re-armed for b
    vi.advanceTimersByTime(600); // t=1650: b expired
    expect(addon.state.outstanding).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cursor off anchor row within grace keeps predictions; sustained off-row drops all', async () => {
    addon.predictChar('a');
    mock.setCursor(0, 5);
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(1); // transient excursion tolerated

    vi.advanceTimersByTime(200); // > cursorGraceMs (150)
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(0);
    expect(spansOf(mock)).toHaveLength(0);
  });

  it('viewportY !== baseY clears predictions (scrolled up)', async () => {
    addon.predictChar('a');
    mock.setScroll(0, 5); // user scrolled: viewport pinned above baseY
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(0);
    // And no new predictions while scrolled
    expect(addon.predictChar('b')).toBe(false);
  });

  it('maxPending: the 33rd predictChar returns false', () => {
    for (let i = 0; i < 32; i++) {
      expect(addon.predictChar('x')).toBe(true);
    }
    expect(addon.predictChar('y')).toBe(false);
    expect(addon.state.outstanding).toBe(32);
  });

  it('edge margin: a prediction landing within edgeMarginCells of cols returns false', () => {
    mock.setCursor(75, 0); // cols 80, margin 4: col 75 + 1 <= 76 allowed
    expect(addon.predictChar('a')).toBe(true);
    // Next lands at col 76: 77 > 76 suppressed
    expect(addon.predictChar('b')).toBe(false);
  });

  it('predictWhen gate false suppresses painting, predictChar just returns false', () => {
    addon.setPredictWhen(() => false);
    expect(addon.predictChar('a')).toBe(false);
    expect(spansOf(mock)).toHaveLength(0);
  });

  it('setPredictWhen(null) removes the gate at runtime', () => {
    addon.setPredictWhen(() => false);
    expect(addon.predictChar('a')).toBe(false);
    addon.setPredictWhen(null);
    expect(addon.predictChar('a')).toBe(true);
  });

  it('multi-codepoint graphemes and control chars return false', () => {
    for (const bad of ['ab', '\x1b', '\x03', '\r', '\n', '\t', '\x7f', '👨‍👩‍👧', '']) {
      expect(addon.predictChar(bad)).toBe(false);
    }
    expect(spansOf(mock)).toHaveLength(0);
    // Single astral emoji IS a single codepoint: predicted (width 2)
    expect(addon.predictChar('😀')).toBe(true);
  });

  it('CJK: 2-cell span, next prediction offsets by 2, confirm reads the leading cell', async () => {
    expect(addon.predictChar('你')).toBe(true);
    const first = spansOf(mock)[0];
    expect(first.style.width).toBe(`${2 * 8.4}px`);
    addon.predictChar('a');
    expect(spansOf(mock)[1].style.left).toBe(`${4 * 8.4}px`); // 2 + width 2

    mock.setLine(0, '› 你');
    mock.setCursor(4, 0); // advanced past the wide char
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.confirmedTotal).toBe(1);
    expect(addon.state.outstanding).toBe(1);
  });

  it('getCell-less terminal: ASCII fallback works, wide chars suppressed', () => {
    const bare = createMockTerminal({
      buffer: { lines: ['› ', ''], cursorX: 2, cursorY: 0 },
      getCellSupport: false,
    });
    const a = new PredictiveEchoAddon();
    a.activate(bare.terminal as never);
    expect(a.predictChar('x')).toBe(true);
    expect(a.predictChar('你')).toBe(false);
    a.dispose();
    bare.cleanup();
  });

  it("'' and ' ' cell reads are equivalent for snapshot and confirm", async () => {
    // Snapshot beyond the line text reads '' -> normalized ' '
    mock.setLine(0, '› ');
    addon.predictChar('a'); // snapshot at col 2 is '' -> ' '
    // A repaint that writes explicit spaces must not count as foreign
    mock.setLine(0, '›   ');
    mock.fireWriteParsed();
    await flushMicrotasks();
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(1);
    expect(addon.state.droppedTotal).toBe(0);
  });

  it('predictBackspace pops newest, returns false when empty, never touches confirmed', async () => {
    expect(addon.predictBackspace()).toBe(false);
    addon.reconcile(); // the empty pop armed the anchor hold; release it
    addon.predictChar('a');
    addon.predictChar('b');
    expect(addon.predictBackspace()).toBe(true);
    expect(addon.state.outstanding).toBe(1);
    expect(spansOf(mock).map((s) => s.textContent)).toEqual(['a']);

    mock.setLine(0, '› a');
    mock.setCursor(3, 0);
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.confirmedTotal).toBe(1);
    expect(addon.predictBackspace()).toBe(false); // confirmed text is not popped
  });

  it('clearPredictions empties the container, resets anchor, cancels the timer', () => {
    addon.predictChar('a');
    addon.predictChar('b');
    expect(vi.getTimerCount()).toBe(1);
    addon.clearPredictions();
    expect(spansOf(mock)).toHaveLength(0);
    expect(addon.state.outstanding).toBe(0);
    expect(addon.state.anchor).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onWriteParsed reconcile is debounced to one pass per burst', async () => {
    addon.predictChar('a');
    mock.setLine(0, '› Z'); // foreign cell: each PASS increments mismatches
    mock.fireWriteParsed();
    mock.fireWriteParsed();
    mock.fireWriteParsed();
    await flushMicrotasks();
    // Three synchronous fires coalesced into ONE pass: not dropped yet
    expect(addon.state.outstanding).toBe(1);
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.state.outstanding).toBe(0); // second pass cascades
  });

  it('onResize clears predictions (cell geometry changed)', () => {
    addon.predictChar('a');
    mock.fireResize(120, 40);
    expect(addon.state.outstanding).toBe(0);
    expect(spansOf(mock)).toHaveLength(0);
  });

  it('works without onWriteParsed via manual reconcile()', () => {
    const bare = composerMock({ emitters: false });
    const a = new PredictiveEchoAddon();
    a.activate(bare.terminal as never);
    a.predictChar('h');
    bare.setLine(0, '› h');
    bare.setCursor(3, 0);
    a.reconcile();
    expect(a.state.confirmedTotal).toBe(1);
    expect(a.state.outstanding).toBe(0);
    a.dispose();
    bare.cleanup();
  });

  it('dispose unhooks listeners and removes the container', () => {
    expect(mock.writeParsedListenerCount()).toBe(1);
    expect(mock.resizeListenerCount()).toBe(1);
    addon.predictChar('a');
    addon.dispose();
    expect(mock.writeParsedListenerCount()).toBe(0);
    expect(mock.resizeListenerCount()).toBe(0);
    const screen = mock.terminal.element.querySelector('.xterm-screen')!;
    expect(screen.querySelector('[data-predictive-echo]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('every public method is safe before activate and after dispose', () => {
    const fresh = new PredictiveEchoAddon();
    expect(fresh.predictChar('a')).toBe(false);
    expect(fresh.predictBackspace()).toBe(false);
    fresh.clearPredictions();
    fresh.reconcile();
    fresh.refreshFont();
    fresh.setPredictWhen(() => true);
    expect(fresh.hasPredictions).toBe(false);
    expect(fresh.state.outstanding).toBe(0);

    addon.dispose();
    expect(addon.predictChar('a')).toBe(false);
    expect(addon.predictBackspace()).toBe(false);
    addon.clearPredictions();
    addon.reconcile();
    addon.refreshFont();
    expect(addon.hasPredictions).toBe(false);
  });

  it('hostile terminal stubs never propagate exceptions', () => {
    const hostile = {
      element: document.createElement('div'),
      cols: 80,
      rows: 24,
      options: {},
      buffer: {
        active: {
          viewportY: 0,
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          getLine: () => {
            throw new Error('boom');
          },
        },
      },
    };
    const a = new PredictiveEchoAddon();
    expect(() => a.activate(hostile as never)).not.toThrow();
    expect(a.predictChar('x')).toBe(false); // getLine throws inside -> caught
    expect(() => a.reconcile()).not.toThrow();
    a.dispose();

    // Terminal with no render dimensions: addon inert, no throws
    const dimless = composerMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (dimless.terminal as any)._core;
    const b = new PredictiveEchoAddon();
    b.activate(dimless.terminal as never);
    expect(b.predictChar('x')).toBe(false);
    b.dispose();
    dimless.cleanup();
  });

  it('underlinePredictions styles spans; refreshFont re-reads the rendered color', () => {
    const themed = composerMock({ theme: { foreground: '#aabbcc', background: '#112233' } });
    // The recipe prefers the computed .xterm-rows color (what xterm really
    // renders with); give the mock rows an explicit color like a real skin.
    const rows = themed.terminal.element.querySelector('.xterm-rows') as HTMLElement;
    rows.style.color = 'rgb(170, 187, 204)';
    const a = new PredictiveEchoAddon({ underlinePredictions: true });
    a.activate(themed.terminal as never);
    a.predictChar('u');
    const span = themed.terminal.element.querySelector('.xterm-screen span') as HTMLSpanElement;
    expect(span.style.textDecoration).toBe('underline');
    expect(span.style.color).toBe('rgb(170, 187, 204)');

    rows.style.color = 'rgb(255, 0, 0)'; // skin change
    a.refreshFont();
    a.clearPredictions();
    a.reconcile(); // release the anchor hold armed by the clear
    a.predictChar('v');
    const span2 = themed.terminal.element.querySelector('.xterm-screen span') as HTMLSpanElement;
    expect(span2.style.color).toBe('rgb(255, 0, 0)');
    a.dispose();
    themed.cleanup();
  });

  it('anchor hold: backspace into echoed text suppresses prediction until a write parses', async () => {
    // \x7f went to the wire with nothing outstanding: the cursor will move
    // in a way the display has not shown, so anchoring now paints one cell
    // off (review finding: "tehh" ghosts on backspace-then-retype at RTT)
    expect(addon.predictBackspace()).toBe(false);
    expect(addon.predictChar('x')).toBe(false);
    expect(spansOf(mock)).toHaveLength(0);
    mock.fireWriteParsed(); // the display caught up
    await flushMicrotasks();
    expect(addon.predictChar('x')).toBe(true);
  });

  it('anchor hold: clearPredictions suppresses until a write parses (or manual reconcile)', async () => {
    addon.predictChar('a');
    addon.clearPredictions(); // consumer saw Enter/Esc/arrow/paste
    expect(addon.predictChar('b')).toBe(false);
    mock.fireWriteParsed();
    await flushMicrotasks();
    expect(addon.predictChar('b')).toBe(true);
  });

  it('anchor hold: the inline predictChar reconcile does NOT release it', () => {
    addon.clearPredictions();
    // Several keystrokes in a row before any echo: all suppressed, because
    // predictChar's inline pass must not count as the display catching up
    expect(addon.predictChar('a')).toBe(false);
    expect(addon.predictChar('b')).toBe(false);
    addon.reconcile(); // public/manual pass IS the caught-up contract
    expect(addon.predictChar('c')).toBe(true);
  });

  it('state getter reports outstanding/confirmedTotal/droppedTotal/anchor', async () => {
    expect(addon.state).toEqual({ outstanding: 0, confirmedTotal: 0, droppedTotal: 0, anchor: null });
    addon.predictChar('a');
    addon.predictChar('b');
    expect(addon.state.outstanding).toBe(2);
    expect(addon.state.anchor).toEqual({ row: 0, col: 2 });
    expect(addon.hasPredictions).toBe(true);

    mock.setLine(0, '› a');
    mock.setCursor(3, 0);
    mock.fireWriteParsed();
    await flushMicrotasks();
    addon.clearPredictions();
    expect(addon.state.confirmedTotal).toBe(1);
    expect(addon.state.droppedTotal).toBe(1);
    expect(addon.hasPredictions).toBe(false);
  });
});
