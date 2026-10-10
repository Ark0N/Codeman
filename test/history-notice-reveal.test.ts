/**
 * @fileoverview The partial-history notice waits until the user reaches for history.
 *
 * Every tab switch after the first replays a 1 MiB TAIL of the session's byte
 * stream, which is truncated for any session that has run for a while, so the
 * notice ("Showing the most recent 1.0 MB of this session. 4.8 MB more may still
 * be retained.") covered the top rows on nearly every switch. Its × only lasted
 * until the next switch. Now:
 *   - it appears only once a scroll gesture reaches the top of the browser's
 *     buffer, after the history pull that gesture starts has settled;
 *   - a scroll back down to live output retires it, and so does a tab switch;
 *   - a dismissal sticks for that session until the page reloads.
 *
 * Runs the REAL methods (app.js banner + state, terminal-ui.js scroll hook,
 * constants.js notice decision) in a `vm` against a stub DOM, the same way
 * shell-scroll-history-pull.test.ts does (no jsdom on this box).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const APP = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');

function methodSource(source: string, method: string): string {
  const start = source.search(new RegExp(`^ {2}(?:async )?${method}\\(`, 'm'));
  expect(start, `${method} not found`).toBeGreaterThan(-1);
  const next = /^ {2}(?:async )?[A-Za-z_$][\w$]*\(/m.exec(source.slice(start + 1));
  return next ? source.slice(start, start + 1 + next.index) : source.slice(start);
}

interface FakeEl {
  tagName: string;
  hidden: boolean;
  className: string;
  type: string;
  disabled: boolean;
  children: FakeEl[];
  attrs: Record<string, string>;
  onclick: null | (() => void);
  textContent: string;
  appendChild(child: FakeEl): void;
  setAttribute(name: string, value: string): void;
}

function fakeEl(tagName: string): FakeEl {
  let text = '';
  const el: FakeEl = {
    tagName,
    hidden: false,
    className: '',
    type: '',
    disabled: false,
    children: [],
    attrs: {},
    onclick: null,
    get textContent() {
      return text + el.children.map((c) => c.textContent).join('');
    },
    set textContent(value: string) {
      text = value;
      el.children = [];
    },
    appendChild(child) {
      el.children.push(child);
    },
    setAttribute(name, value) {
      el.attrs[name] = value;
    },
  };
  return el;
}

/** Real terminal-ui.js mixin, for `_maybeLoadMoreHistoryOnScroll` / `isTerminalAtBottom`. */
function loadTerminalMixin(): Record<string, (...args: unknown[]) => unknown> {
  const source = readFileSync(resolve(PUBLIC, 'terminal-ui.js'), 'utf8');
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, (...args: unknown[]) => unknown> };
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: { addEventListener: vi.fn() },
  });
  vm.runInContext(source, context);
  return FakeCodemanApp.prototype;
}

function makeApp() {
  const bar = fakeEl('div');
  bar.hidden = true;
  const document = {
    getElementById: (id: string) => (id === 'historyTruncationBar' ? bar : null),
    createElement: (tag: string) => fakeEl(tag),
  };
  const methods = [
    '_setHistoryTruncation',
    '_clearHistoryTruncation',
    '_setHistoryNoticeRevealed',
    '_renderHistoryTruncationBanner',
  ]
    .map((m) => methodSource(APP, m))
    .join(',\n');
  const context = vm.createContext({ document, console, window: {}, navigator: { userAgent: 'test' } });
  const appMethods = vm.runInContext(
    `${readFileSync(resolve(PUBLIC, 'constants.js'), 'utf8')}
     ;({ ${methods} })`,
    context,
    { filename: 'app-methods.js' }
  ) as Record<string, (...args: unknown[]) => unknown>;
  const mixin = loadTerminalMixin();

  const buffer = { viewportY: 500, baseY: 500 };
  let resolvePull: (() => void) | null = null;
  const app = {
    activeSessionId: 's1' as string | null,
    terminal: { buffer: { active: buffer } },
    // Each gesture's pull is held open until the test settles it.
    _maybeRefetchFullHistory: vi.fn(
      () =>
        new Promise<void>((res) => {
          resolvePull = res;
        })
    ),
    ...appMethods,
    _maybeLoadMoreHistoryOnScroll: mixin._maybeLoadMoreHistoryOnScroll,
    isTerminalAtBottom: mixin.isTerminalAtBottom,
  } as Record<string, any>;

  const settle = async () => {
    resolvePull?.();
    resolvePull = null;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const scrollTo = async (viewportY: number) => {
    const lines = viewportY - buffer.viewportY;
    buffer.viewportY = viewportY;
    app._maybeLoadMoreHistoryOnScroll(lines);
    await settle();
  };
  return { app, bar, buffer, scrollTo, settle };
}

// What a tab switch's tail replay reports for a session with real scrollback.
const TAIL = {
  truncated: true,
  truncationReason: 'tail',
  source: 'mux-visible',
  fullSize: 5 * 1024 * 1024,
  retainedBytes: 1024 * 1024,
  paneHistoryLines: 40000,
};

const loadButton = (bar: FakeEl) => bar.children.find((c) => c.className === 'history-trunc-load');
const dismissButton = (bar: FakeEl) => bar.children.find((c) => c.className === 'history-trunc-dismiss');

describe('partial-history notice: lazy reveal', () => {
  it('stays hidden after a truncated tab-switch replay', () => {
    const { app, bar } = makeApp();
    app._setHistoryTruncation('s1', TAIL);
    expect(bar.hidden).toBe(true);
  });

  it('appears once a scroll reaches the top, after the pull that gesture started', async () => {
    const { app, bar, buffer, settle } = makeApp();
    app._setHistoryTruncation('s1', TAIL);

    buffer.viewportY = 0;
    app._maybeLoadMoreHistoryOnScroll(-500);
    expect(app._maybeRefetchFullHistory).toHaveBeenCalledTimes(1);
    // Still pulling: no notice describing the state the pull is about to replace.
    expect(bar.hidden).toBe(true);

    await settle();
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('40,000 lines of scrollback are retained.');
    expect(loadButton(bar)?.textContent).toBe('Load full history');
  });

  it('shows what the pull left: nothing, when the pull brought everything back', async () => {
    const { app, bar, buffer } = makeApp();
    app._setHistoryTruncation('s1', TAIL);
    app._maybeRefetchFullHistory.mockImplementation(async () => {
      app._setHistoryTruncation('s1', { truncated: false, source: 'mux-full-history', paneHistoryLines: 40000 });
    });
    buffer.viewportY = 0;
    app._maybeLoadMoreHistoryOnScroll(-500);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(app._historyNoticeRevealedFor).toBe('s1');
    expect(bar.hidden).toBe(true);
  });

  it('does not appear on the way up, only at the top', async () => {
    const { app, bar, scrollTo } = makeApp();
    app._setHistoryTruncation('s1', TAIL);
    await scrollTo(200);
    expect(app._maybeRefetchFullHistory).not.toHaveBeenCalled();
    expect(bar.hidden).toBe(true);
  });

  it('goes away once the user scrolls back down to live output', async () => {
    const { app, bar, scrollTo } = makeApp();
    app._setHistoryTruncation('s1', TAIL);
    await scrollTo(0);
    expect(bar.hidden).toBe(false);
    await scrollTo(300); // still reading history
    expect(bar.hidden).toBe(false);
    await scrollTo(500); // back at the bottom
    expect(bar.hidden).toBe(true);
  });

  it('never appears for a pane with no scrollback (fullscreen CLI), even at the top', async () => {
    const { app, bar, scrollTo } = makeApp();
    app._setHistoryTruncation('s1', { ...TAIL, paneHistoryLines: 0 });
    await scrollTo(0);
    expect(app._historyNoticeRevealedFor).toBe('s1');
    expect(bar.hidden).toBe(true);
  });

  it('is not revealed for a tab the user switched to while the pull ran', async () => {
    const { app, bar, buffer, settle } = makeApp();
    app._setHistoryTruncation('s1', TAIL);
    app._setHistoryTruncation('s2', TAIL);
    buffer.viewportY = 0;
    app._maybeLoadMoreHistoryOnScroll(-500);
    app.activeSessionId = 's2';
    await settle();
    expect(app._historyNoticeRevealedFor ?? null).toBe(null);
    expect(bar.hidden).toBe(true);
  });

  it('keeps a dismissal for that session, but only that session', async () => {
    const { app, bar, scrollTo } = makeApp();
    app._setHistoryTruncation('s1', TAIL);
    await scrollTo(0);
    dismissButton(bar)!.onclick!();
    expect(bar.hidden).toBe(true);

    // A new replay and another trip to the top do not bring it back.
    await scrollTo(500);
    app._setHistoryTruncation('s1', TAIL);
    await scrollTo(0);
    expect(bar.hidden).toBe(true);

    // Another session still gets its notice.
    app.activeSessionId = 's2';
    app._setHistoryTruncation('s2', TAIL);
    await scrollTo(500);
    await scrollTo(0);
    expect(bar.hidden).toBe(false);
  });

  it('forgets the dismissal with the session', async () => {
    const { app, bar, scrollTo } = makeApp();
    app._setHistoryTruncation('s1', TAIL);
    await scrollTo(0);
    dismissButton(bar)!.onclick!();
    app._clearHistoryTruncation('s1');
    expect(app._historyNoticeDismissed.has('s1')).toBe(false);
  });
});

describe('partial-history notice: a tab switch retires it (static guard)', () => {
  it('selectSession clears the reveal before repainting the banner', () => {
    const body = methodSource(APP, 'selectSession');
    const reset = body.indexOf('this._historyNoticeRevealedFor = null;');
    const render = body.indexOf('this._renderHistoryTruncationBanner();');
    expect(reset).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(reset);
  });
});
