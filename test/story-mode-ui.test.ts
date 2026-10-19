/**
 * @fileoverview Frontend test for story-mode.js (Story Mode overlay). Builds a JSDOM window in-test
 * (like admin-ui.test.ts), evaluates the real module, and feeds it pages built by the real server
 * core from invented transcripts (test/story-fixtures.ts). Canvas 2D is a permissive fake, so every
 * scene's drawing code runs: a scene that throws for some panel shape fails here, not in a browser.
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStoryPage, buildStoryTurns, createStoryReducer, summarizeTurns } from '../src/story-mode.js';
import type { StoryPage, StoryPanel } from '../src/types/story.js';
import { bash, demoTurn, edit, end, prompt, read, resetClock, result, said, tool } from './story-fixtures.js';

const STORY_JS = readFileSync(new URL('../src/web/public/story-mode.js', import.meta.url), 'utf-8');
// The real path matcher (findFilePathLinks / resolveLinkedFilePath) the terminal uses.
const CONSTANTS_JS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const SID = 'session-0001-abcdef';

type Win = Window & typeof globalThis & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The response for `?turn=<id>`: every turn listed, the page of the one asked for. */
function storyAt(lines: unknown[], index: number) {
  const reducer = createStoryReducer();
  const turns = buildStoryTurns(lines.flatMap((l) => reducer.reduce(l)));
  return { supported: true, turns: summarizeTurns(turns), page: buildStoryPage(turns[index]) };
}

function storyOf(lines: unknown[]) {
  const reducer = createStoryReducer();
  const turns = buildStoryTurns(lines.flatMap((l) => reducer.reduce(l)));
  return {
    supported: true,
    turns: summarizeTurns(turns),
    page: turns.length ? buildStoryPage(turns[turns.length - 1]) : null,
  };
}

/** Every text a scene drew, in order (the fake context records `fillText`). */
const drawnTexts: string[] = [];

/** A 2D context that accepts every call; measureText answers a plausible width. */
function fakeContext() {
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    fillText: (text: unknown) => void drawnTexts.push(String(text)),
  };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key as string];
      return () => undefined;
    },
    set(t, key, value) {
      t[key as string] = value;
      return true;
    },
  });
}

let dom: JSDOM;
let win: Win;
let app: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let responses: Array<{ status: number; body: unknown }>;
let calls: string[];

function boot(initial: unknown) {
  dom = new JSDOM(
    `<!doctype html><body>
      <button class="btn-story-header btn-story-header--hidden"></button>
      <button id="sessionOptionsStoryBtn" hidden></button>
      <div class="file-preview-overlay" id="filePreviewOverlay"><button id="pvOther">Edit</button><button title="Close">×</button></div>
      <div class="folder-grid-overlay" id="folderGridOverlay"></div>
    </body>`,
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  win = dom.window as unknown as Win;
  win.HTMLCanvasElement.prototype.getContext = (() => fakeContext()) as never;
  win.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  win.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  win.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  win.eval(CONSTANTS_JS);
  win.eval('class CodemanApp {}; window.CodemanApp = CodemanApp;');
  win.eval(STORY_JS);
  responses = [{ status: 200, body: { success: true, data: initial } }];
  calls = [];
  app = Object.create(win.CodemanApp.prototype);
  Object.assign(app, {
    activeSessionId: SID,
    sessions: new Map([[SID, { name: 'demo-shop', workingDir: '/work/demo-shop' }]]),
    loadAppSettingsFromStorage: () => ({ showStoryButton: true }),
    getDefaultSettings: () => ({}),
    showToast: vi.fn(),
    openFilePreview: vi.fn(),
    closeFilePreview: vi.fn(() => win.document.getElementById('filePreviewOverlay')!.classList.remove('visible')),
    filePreviewEdit: null,
    _api: async (path: string) => {
      calls.push(path);
      const next = responses.length > 1 ? responses.shift()! : responses[0];
      return { ok: next.status < 300, status: next.status, headers: { get: () => null }, json: async () => next.body };
    },
  });
}

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel: string) => win.document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...win.document.querySelectorAll(sel)] as HTMLElement[];
/** Panels have no layout in JSDOM; give them a size so scenes draw and click regions exist. */
function sizeAndDraw() {
  for (const rt of app._story.panels) {
    rt.w = 600;
    rt.h = 270;
    rt.dpr = 1;
    rt.canvas.width = 600;
    rt.canvas.height = 270;
    rt.bgKey = '';
    app._storyDrawPanel(rt);
  }
}
const press = (key: string) =>
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

beforeEach(() => resetClock());
afterEach(() => {
  app?.closeStoryMode?.();
  dom?.window.close();
});

describe('story-mode.js overlay', () => {
  it('draws the newest turn: panels, captions, balloons, turn picker', async () => {
    boot(storyOf([prompt('first job'), said('Done.'), end(2000), ...demoTurn()]));
    app.openStoryMode(SID);
    await settle();
    expect(calls).toEqual([`/api/sessions/${SID}/story`]);
    expect($$('.story-panel').map((p) => p.dataset.kind)).toEqual([
      'mission',
      'investigate',
      'plan',
      'backup',
      'loop',
      'save',
      'complete',
    ]);
    expect($('.story-panel[data-kind="mission"] .story-balloon-text')!.textContent).toBe(
      'The checkout button does nothing on phones. Can you fix it?'
    );
    // Who speaks, for a screen reader (visually hidden; the art shows it).
    expect($('.story-panel[data-kind="mission"] .story-balloon .story-vh')!.textContent).toBe('You say: ');
    expect($('.story-panel[data-kind="mission"]')!.getAttribute('aria-label')).toBe('Panel 1 of 7');
    expect($('.story-panel[data-kind="mission"] .story-balloon')!.className).toContain('story-balloon--you');
    expect($('.story-panel[data-kind="investigate"] .story-cap-story')!.textContent).toBe(
      'Claude reads CheckoutButton.tsx and banner.css.'
    );
    expect($('.story-splash-title')!.textContent).toBe('Mission complete!');
    expect($$('.story-turns option').map((o) => o.textContent)).toEqual([
      '1. first job',
      '2. The checkout button does nothing on phones. Can you fix it?',
    ]);
    expect(($('.story-prev') as HTMLButtonElement).disabled).toBe(false);
    expect(($('.story-next') as HTMLButtonElement).disabled).toBe(true);
    expect($('.story-bar .story-live')!.hidden).toBe(true);
    expect($('.story-pencils')).toBeNull();
    expect($('.story-note')!.hidden).toBe(true);
  });

  it("the Director's cut shows one wire row per event and the tool captions", async () => {
    const data = storyOf(demoTurn());
    boot(data);
    app.openStoryMode(SID);
    await settle();
    app._storySetDirector(true);
    expect($('.story-overlay')!.classList.contains('is-director')).toBe(true);
    expect($$('.story-ev')).toHaveLength((data.page as StoryPage).events.length);
    expect($$('.story-wire-group')[0].textContent).toBe('Panel 1 · The mission');
    expect($('.story-panel[data-kind="investigate"] .story-cap-dir')!.textContent).toBe('Read ×2 · Bash');
  });

  it('a file card opens the file preview; the code page opens the diff with real line numbers', async () => {
    boot(storyOf(demoTurn()));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const card = $$('.story-panel[data-kind="investigate"] .story-hit').find(
      (b) => b.getAttribute('aria-label') === 'Open CheckoutButton.tsx'
    );
    expect(card).toBeTruthy();
    card!.click();
    expect(app.openFilePreview).toHaveBeenCalledWith('/work/demo-shop/src/checkout/CheckoutButton.tsx', SID);

    const page = $$('.story-panel[data-kind="loop"] .story-hit').find(
      (b) => b.getAttribute('aria-label') === "See Claude's changes"
    );
    page!.click();
    expect($('.story-drawer')!.hidden).toBe(false);
    expect($('.story-drawer-kind')!.textContent).toBe('Diff');
    expect($$('.story-df')).toHaveLength(2);
    // The first hunk starts at line 10 in both files: context 10/10, an added line at new 11, context 11/12.
    const rows = $$('.story-df')[0].querySelectorAll('.story-ln:not(.story-ln--hunk)');
    expect([...rows].map((r) => [...r.querySelectorAll('.story-ln-no')].map((n) => n.textContent))).toEqual([
      ['10', '10'],
      ['', '11'],
      ['11', '12'],
    ]);
    ($$('.story-df')[0].querySelector('.story-btn-s') as HTMLElement).click();
    expect(app.openFilePreview).toHaveBeenLastCalledWith('/work/demo-shop/src/styles/banner.css', SID);
  });

  it('the test board opens the output, with paths in it as links', async () => {
    boot(
      storyOf([
        prompt('go'),
        ...bash('b1', 'npm test', 'Run tests', 'FAIL src/a.test.ts:12\n Tests  1 failed | 3 passed (4)', true),
        end(1000),
      ])
    );
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $('.story-panel[data-kind="check"] .story-hit')!.click();
    expect($('.story-drawer-kind')!.textContent).toBe('Output');
    const link = $('.story-drawer .story-pre .story-link');
    expect(link!.textContent).toBe('src/a.test.ts');
    link!.click();
    expect(app.openFilePreview).toHaveBeenLastCalledWith('/work/demo-shop/src/a.test.ts', SID);
  });

  it('a live refresh adds panels with an entrance and keeps the clocks of the ones already there', async () => {
    const lines = [prompt('go'), ...read('r1', '/w/a.ts')];
    boot(storyOf(lines));
    app.openStoryMode(SID);
    await settle();
    expect($$('.story-panel').map((p) => p.dataset.kind)).toEqual(['mission', 'investigate']);
    expect($('.story-pencils')).toBeTruthy();
    expect($('.story-bar .story-live')!.hidden).toBe(false);
    const first = app._story.panels[1];
    first.clock = 500;
    responses = [
      {
        status: 200,
        body: {
          success: true,
          data: storyOf([...lines, ...bash('b1', 'npm test', 'Run tests', ' Tests  4 passed (4)'), end(9000)]),
        },
      },
    ];
    await app._storyRefresh();
    await settle();
    expect($$('.story-panel').map((p) => p.dataset.kind)).toEqual(['mission', 'investigate', 'check', 'complete']);
    expect(app._story.panels[1]).toBe(first);
    expect(first.clock).toBeGreaterThanOrEqual(500); // kept (and still running), never restarted
    expect($('.story-panel[data-kind="check"]')!.classList.contains('story-fresh')).toBe(true);
    expect($('.story-panel[data-kind="investigate"]')!.classList.contains('story-fresh')).toBe(false);
    expect($('.story-pencils')).toBeNull();
  });

  it('a balloon too tall for its panel clamps its text, never the hidden speaker words', async () => {
    boot(storyOf(demoTurn()));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const rt = app._story.panels[0];
    const balloon = rt.balloon as HTMLElement;
    const text = balloon.querySelector('.story-balloon-text') as HTMLElement;
    // No layout in JSDOM: a balloon 300 px tall in a 270 px panel.
    Object.defineProperty(balloon, 'offsetHeight', { value: 300, configurable: true });
    Object.defineProperty(balloon, 'offsetTop', { value: 10, configurable: true });
    Object.defineProperty(text, 'offsetHeight', { value: 280, configurable: true });
    rt.balloonKey = '';
    app._storyPlaceBalloon(rt, null, 0, 1);
    expect(text.style.getPropertyValue('--story-lines')).toBe('12');
    expect((balloon.querySelector('.story-vh') as HTMLElement).style.getPropertyValue('--story-lines')).toBe('');
  });

  it('a fold near the start keeps every later panel as it was: no second entrance', async () => {
    const data = storyOf(demoTurn());
    boot(data);
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const before = new Map(app._story.panels.map((rt: { kind: string }) => [rt.kind, rt]));
    const folded = JSON.parse(JSON.stringify(data));
    const ps = folded.page.panels;
    ps.splice(1, 2, { ...ps[1], kind: 'montage', events: [...ps[1].events, ...ps[2].events] });
    responses = [{ status: 200, body: { success: true, data: folded } }];
    await app._storyRefresh();
    await settle();
    expect($$('.story-panel').map((p) => p.dataset.kind)).toEqual([
      'mission',
      'montage',
      'backup',
      'loop',
      'save',
      'complete',
    ]);
    for (const kind of ['mission', 'backup', 'loop', 'save', 'complete']) {
      const rt = app._story.panels.find((r: { kind: string }) => r.kind === kind);
      expect(rt).toBe(before.get(kind));
    }
    expect($('.story-panel[data-kind="montage"]')!.classList.contains('story-fresh')).toBe(true);
    expect($('.story-panel[data-kind="loop"]')!.classList.contains('story-fresh')).toBe(false);
  });

  it('a refresh that changes nothing keeps the open drawer as it is, focus included', async () => {
    const data = storyOf(demoTurn());
    boot(data);
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $('.story-panel[data-kind="loop"] .story-hit')!.click();
    const btn = $('.story-drawer-body button')!;
    btn.focus();
    responses = [{ status: 200, body: { success: true, data: JSON.parse(JSON.stringify(data)) } }];
    await app._storyRefresh();
    await settle();
    expect(win.document.contains(btn)).toBe(true);
    expect(win.document.activeElement).toBe(btn);
  });

  it('a fix that folds into a loop under an open drawer: Escape gives focus to the loop', async () => {
    const lines = [prompt('fix it'), ...edit('e1', '/work/demo-shop/a.py', ['+a = 1'])];
    boot(storyOf(lines));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const hit = $$('.story-panel[data-kind="fix"] .story-hit').find((h) => h.dataset.storyOpen?.startsWith('diff@'))!;
    hit.focus();
    hit.click();
    responses = [
      {
        status: 200,
        body: {
          success: true,
          data: storyOf([
            ...lines,
            ...bash('b1', 'pytest -q', 'Run tests', '1 failed, 2 passed in 0.1s'),
            ...edit('e2', '/work/demo-shop/a.py', ['-a = 1', '+a = 2']),
            ...bash('b2', 'pytest -q', 'Run tests', '3 passed in 0.1s'),
          ]),
        },
      },
    ];
    await app._storyRefresh();
    await settle();
    sizeAndDraw();
    expect($('.story-panel[data-kind="loop"]')).toBeTruthy();
    press('Escape');
    expect($('.story-drawer')!.hidden).toBe(true);
    expect((win.document.activeElement as HTMLElement).dataset.storyOpen).toMatch(/^diff@loop:/);
  });

  it('a drawer holds its turn when the newest turn moves on, and lets go when it closes', async () => {
    const one = [prompt('first job'), ...read('r1', '/work/demo-shop/a.ts'), said('Done.'), end(2000)];
    const two = [...one, prompt('second job'), said('On it.')];
    boot(storyOf(one));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const first = app._story.data.page.id;
    $('[data-story-open="list:page"]')!.click();
    expect($('.story-drawer')!.hidden).toBe(false);
    const title = $('.story-drawer-title')!.textContent;
    responses = [
      { status: 200, body: { success: true, data: storyOf(two) } },
      { status: 200, body: { success: true, data: storyAt(two, 0) } },
    ];
    calls.length = 0;
    await app._storyRefresh();
    await settle(12);
    expect(app._story.data.page.id).toBe(first);
    expect(app._story.turnId).toBe(first);
    expect($('.story-drawer')!.hidden).toBe(false);
    expect($('.story-drawer-title')!.textContent).toBe(title);
    expect($$('.story-turns option')).toHaveLength(2);
    // The held turn's last state is fetched a moment later (the refresh's own retry, 250 ms).
    await new Promise((r) => setTimeout(r, 320));
    await settle();
    expect(calls.some((c) => c.includes(`turn=${encodeURIComponent(first)}`))).toBe(true);
    expect(app._story.data.page.id).toBe(first);
    expect($('.story-sr')!.textContent).toMatch(/stays on the turn you are reading/);
    // Closing the drawer follows the newest turn again.
    responses = [{ status: 200, body: { success: true, data: storyOf(two) } }];
    press('Escape');
    await settle(12);
    expect(app._story.turnId).toBeNull();
    expect(app._story.data.page.id).not.toBe(first);
  });

  it('Previous on the second turn lands on the first with focus on the picker, not the page', async () => {
    const two = [prompt('first job'), said('Done.'), end(2000), prompt('second job'), said('Done too.'), end(2000)];
    boot(storyOf(two));
    app.openStoryMode(SID);
    await settle();
    responses = [{ status: 200, body: { success: true, data: storyAt(two, 0) } }];
    const prev = $('.story-prev') as HTMLButtonElement;
    prev.focus();
    prev.click();
    await settle(12);
    expect(prev.disabled).toBe(true);
    expect(win.document.activeElement).toBe($('.story-turns'));
  });

  it('the diff of a command that also printed a file shows what it printed, with the file to open', async () => {
    const lines = [
      prompt('note it'),
      ...bash(
        'b1',
        "cat >> NOTES.md <<'EOF'\nmore\nEOF\ncat stats.py",
        'Append a note and show the module',
        'def f(): pass'
      ),
      end(1000),
    ];
    (lines[1] as { cwd?: string }).cwd = '/work/demo-shop';
    boot(storyOf(lines));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $$('.story-panel .story-hit')
      .find((h) => h.dataset.storyOpen?.startsWith('diff@'))!
      .click();
    expect($('.story-drawer-kind')!.textContent).toBe('Diff');
    expect($('.story-drawer-body')!.textContent).toContain('def f(): pass');
    expect($$('.story-drawer-body .story-out-files button').map((b) => b.textContent)).toEqual(['Open stats.py']);
    expect($$('.story-drawer-body button').some((b) => /it wrote/.test(b.textContent || ''))).toBe(false);
  });

  it('a drawer covering the whole page makes the page behind it inert; one beside it does not', async () => {
    boot(storyOf(demoTurn()));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const st = app._story;
    const box = (left: number, width: number) => () => ({
      left,
      width,
      top: 0,
      height: 500,
      right: left + width,
      bottom: 500,
    });
    st.mainEl.getBoundingClientRect = box(0, 400);
    st.drawerEl.getBoundingClientRect = box(0, 400);
    $('.story-panel[data-kind="loop"] .story-hit')!.click();
    expect(st.mainEl.inert).toBe(true);
    press('Escape');
    expect(st.mainEl.inert).toBe(false);
    st.mainEl.getBoundingClientRect = box(0, 1400);
    st.drawerEl.getBoundingClientRect = box(900, 500);
    $('.story-panel[data-kind="loop"] .story-hit')!.click();
    expect(st.mainEl.inert).toBe(false);
  });

  it('activity for this session refreshes, activity for another does not', async () => {
    vi.useFakeTimers();
    try {
      boot(storyOf(demoTurn()));
      app.openStoryMode(SID);
      await vi.advanceTimersByTimeAsync(10);
      calls.length = 0;
      app._storyOnActivity({ data: JSON.stringify({ sessionId: 'someone-else' }) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toEqual([]);
      app._storyOnActivity({ data: JSON.stringify({ sessionId: SID }) });
      app._storyOnActivity({ data: JSON.stringify({ sessionId: SID }) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toEqual([`/api/sessions/${SID}/story`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape closes one layer per press: file preview, then drawer, then the overlay', async () => {
    boot(storyOf(demoTurn()));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $$('.story-panel[data-kind="loop"] .story-hit')[0].click();
    $('#filePreviewOverlay')!.classList.add('visible');
    press('Escape');
    expect(app.closeFilePreview).toHaveBeenCalledTimes(1);
    expect($('.story-drawer')!.hidden).toBe(false);
    press('Escape');
    expect($('.story-drawer')!.hidden).toBe(true);
    expect($('#storyOverlay')!.hidden).toBe(false);
    press('Escape');
    expect($('#storyOverlay')!.hidden).toBe(true);
    expect(app._story.open).toBe(false);
  });

  it('leaves Escape to a folder grid on top and to a preview being edited', async () => {
    boot(storyOf(demoTurn()));
    app.openStoryMode(SID);
    await settle();
    $('#folderGridOverlay')!.classList.add('visible');
    press('Escape');
    expect($('#storyOverlay')!.hidden).toBe(false);
    $('#folderGridOverlay')!.classList.remove('visible');
    $('#filePreviewOverlay')!.classList.add('visible');
    app.filePreviewEdit = { dirty: true };
    press('Escape');
    expect(app.closeFilePreview).not.toHaveBeenCalled();
    expect($('#storyOverlay')!.hidden).toBe(false);
  });

  it('closing stops listening: no Escape handling and no refresh after close', async () => {
    vi.useFakeTimers();
    try {
      boot(storyOf([prompt('go'), ...read('r1', '/w/a.ts')]));
      app.openStoryMode(SID);
      await vi.advanceTimersByTimeAsync(10);
      app.closeStoryMode();
      calls.length = 0;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toEqual([]);
      expect($$('.story-panel')).toHaveLength(0);
      app._storyOnActivity({ data: JSON.stringify({ sessionId: SID }) });
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says why when a session cannot be drawn, or the request fails', async () => {
    boot({ supported: false, reason: 'Story Mode draws Claude Code sessions. This session runs a different CLI.' });
    app.openStoryMode(SID);
    await settle();
    expect($('.story-note')!.textContent).toMatch(/different CLI/);
    expect($$('.story-panel')).toHaveLength(0);
    responses = [{ status: 404, body: { success: false, error: 'Session not found' } }];
    await app._storyRefresh();
    expect($('.story-note')!.textContent).toBe('Session not found');
  });

  it('a turn a background task started gets a notice, not your speech balloon', async () => {
    boot(
      storyOf([
        prompt('<task-notification><summary>Agent "Docs" finished</summary></task-notification>', {
          turnOrigin: 'task_notification',
        }),
        said('Nice.'),
        end(1000),
      ])
    );
    app.openStoryMode(SID);
    await settle();
    const balloon = $('.story-panel[data-kind="mission"] .story-balloon')!;
    expect(balloon.className).toContain('story-balloon--note');
    expect(balloon.querySelector('.story-balloon-text')!.textContent).toBe('Agent "Docs" finished');
    expect(balloon.querySelector('.story-vh')!.textContent).toBe('Notice: ');
  });

  it("the helper drawer fetches and lists the helper's own steps", async () => {
    const lines = [
      prompt('Docs please'),
      tool('a1', 'Agent', { description: 'Write README', subagent_type: 'general-purpose', prompt: 'Write it' }),
      result('a1', 'ok', {
        toolUseResult: { agentId: 'h1', content: [{ type: 'text', text: 'Written.' }], totalToolUseCount: 2 },
      }),
      end(3000),
    ];
    boot(storyOf(lines));
    const helperPage = storyOf([prompt('Write it'), ...read('r1', '/work/demo-shop/a.md')]).page;
    const base = app._api;
    app._api = async (path: string) => {
      if (path.includes('/story/helpers/h1')) {
        calls.push(path);
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            success: true,
            data: { supported: true, helper: { agentId: 'h1', finished: true }, page: helperPage },
          }),
        };
      }
      return base(path);
    };
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $('.story-panel[data-kind="backup"] .story-hit')!.click();
    await settle();
    expect($('.story-drawer-title')!.textContent).toBe('Write README');
    expect($('.story-drawer-sub')!.textContent).toContain('general-purpose');
    expect(calls).toContain(`/api/sessions/${SID}/story/helpers/h1`);
    const steps = $('.story-helper-steps')!;
    expect(steps.textContent).toContain('1 step');
    // Paths inside the session's folder are shown short; the click still opens the full path.
    const link = steps.querySelector('.story-link') as HTMLElement;
    expect(link.textContent).toBe('a.md');
    link.click();
    expect(app.openFilePreview).toHaveBeenLastCalledWith('/work/demo-shop/a.md', SID);
  });

  it("a page that holds still (304) still refreshes a working helper's steps in its open drawer", async () => {
    const data = storyOf([
      prompt('docs'),
      tool('a1', 'Agent', { description: 'Write README', subagent_type: 'general-purpose', prompt: 'Write it' }),
      result('a1', 'Async agent launched successfully. agentId: h9', {
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'h9' },
      }),
      end(1000),
    ]);
    boot(data);
    const helperPage = storyOf([prompt('Write it'), ...read('r1', '/work/demo-shop/a.md')]).page;
    let helperCalls = 0;
    app._api = async (path: string) => {
      if (path.includes('/story/helpers/h9')) {
        helperCalls++;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ success: true, data: { supported: true, helper: { agentId: 'h9' }, page: helperPage } }),
        };
      }
      // The parent page never changes while the helper works: the same tag every time.
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? 'W/"same"' : null) },
        json: async () => ({ success: true, data }),
      };
    };
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $('.story-panel[data-kind="backup"] .story-hit')!.click();
    await settle();
    const before = helperCalls;
    expect(before).toBeGreaterThan(0);
    await app._storyRefresh();
    await settle();
    expect(helperCalls).toBe(before + 1);
  });

  it('a request that never settled does not block the next open: the page draws', async () => {
    const data = storyOf(demoTurn());
    boot(data);
    app._api = () => new Promise(() => {}); // hangs forever
    app.openStoryMode(SID);
    await settle();
    app.closeStoryMode();
    app._api = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true, data }),
    });
    app.openStoryMode(SID);
    await settle();
    expect($$('.story-panel').length).toBeGreaterThan(0);
    // Reopened, nothing from before is announced as news.
    expect($('.story-sr')!.textContent).toBe('');
  });

  it('a session Story Mode cannot draw is not polled', async () => {
    let poll: (() => void) | undefined;
    boot({ supported: false, reason: 'A shell session.' });
    win.setInterval = ((fn: () => void) => {
      poll = fn;
      return 1;
    }) as never;
    app.openStoryMode(SID);
    await settle();
    app._story.lastIdlePoll = 0;
    calls.length = 0;
    poll!();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('Tab stays inside the overlay', async () => {
    boot(storyOf(demoTurn()));
    app.openStoryMode(SID);
    await settle();
    // JSDOM has no layout (offsetParent is always null), so give every control one.
    for (const el of $$('#storyOverlay button, #storyOverlay select'))
      Object.defineProperty(el, 'offsetParent', { get: () => win.document.body });
    const controls = $$('#storyOverlay button, #storyOverlay select').filter((n) => !(n as HTMLButtonElement).disabled);
    controls[controls.length - 1].focus();
    press('Tab');
    expect(win.document.activeElement).toBe(controls[0]);
  });

  it("the mission opens the whole prompt, and a task turn's mission opens what the job reported", async () => {
    const report = [
      '<task-notification>',
      '<tool-use-id>a1</tool-use-id>',
      '<status>completed</status>',
      '<summary>Agent "Docs" finished</summary>',
      '<result>I wrote /home/me/demo-shop/README.md. Names look like old.jpg -> new.jpg.</result>',
      '</task-notification>',
    ].join('\n');
    boot(storyOf([prompt(report, { turnOrigin: 'task_notification' }), said('Thanks.'), end(1000)]));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const hit = $('.story-panel[data-kind="mission"] .story-hit')!;
    expect(hit.title).toBe('Read the report');
    hit.click();
    expect($('.story-drawer-kind')!.textContent).toBe('Report');
    expect($('.story-drawer-body')!.textContent).toContain('What it reported');
    const links = $$('.story-drawer-body .story-link');
    // In prose only rooted paths link: `old.jpg` is an example, not a file.
    expect(links.map((l) => l.textContent)).toEqual(['/home/me/demo-shop/README.md']);
  });

  it("the wire files Claude's last words under the final panel", async () => {
    boot(storyOf([prompt('look'), ...read('r1', '/work/demo-shop/a.md'), said('All done here.'), end(1000)]));
    app.openStoryMode(SID);
    await settle();
    app._storySetDirector(true);
    const rows = $$('.story-wire li').map((li) => li.textContent || '');
    const lastGroup = [...rows].reverse().find((t) => t.startsWith('Panel'));
    expect(lastGroup).toMatch(/· The end$/);
    expect(rows[rows.length - 1]).toContain('All done here.');
  });

  it('a fix made from the terminal opens what ran, not an empty diff', async () => {
    boot(
      storyOf([
        prompt('patch it'),
        ...bash('b1', "sed -i 's/a/b/' app.py", 'Patch the file', ''),
        ...bash('b2', 'printf x > notes.md', 'Write notes', ''),
        end(1000),
      ])
    );
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $('.story-panel[data-kind="fix"] .story-hit')!.click();
    expect($('.story-drawer-kind')!.textContent).toBe('Output');
    expect($('.story-drawer-body')!.textContent).toContain("sed -i 's/a/b/' app.py");
    expect($('.story-drawer-body')!.textContent).not.toContain('No changes');
  });

  it('output links skip globs and paths a tool elided', async () => {
    boot(
      storyOf([
        prompt('test'),
        ...bash('b1', 'pytest -q', 'Run tests', 'FAILED test_a.py::t - 2...rted_0/a.txt\nsee *.test.ts and src/app.py'),
        end(1000),
      ])
    );
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $('.story-panel[data-kind="check"] .story-hit')!.click();
    const links = $$('.story-drawer-body .story-link').map((l) => l.textContent);
    expect(links).toContain('src/app.py');
    expect(links.some((l) => /\.\.\.|\*/.test(l || ''))).toBe(false);
    expect(links).not.toContain('.test.ts');
  });

  it('a helper still working in the background says so, in its drawer and on the final panel', async () => {
    boot(
      storyOf([
        prompt('docs'),
        tool('a1', 'Agent', { description: 'Write README', subagent_type: 'general-purpose', prompt: 'Write it' }),
        result('a1', 'Async agent launched successfully. agentId: h9', {
          toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'h9' },
        }),
        end(1000),
      ])
    );
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    expect($('.story-panel[data-kind="complete"] .story-chips')!.textContent).toContain('1 helper, 1 still working');
    // Work still out is not a finished mission.
    expect($('.story-panel[data-kind="complete"] .story-splash-title')!.textContent).toBe('Done for now');
    $('.story-panel[data-kind="backup"] .story-hit')!.click();
    await settle();
    expect($('.story-drawer-sub')!.textContent).toContain('in the background');
    expect($('.story-drawer-body')!.textContent).toContain('Still working in the background.');
    expect($('.story-drawer-body')!.textContent).not.toContain('Async agent launched');
  });

  it('a click region reused for a new page gets the new label', async () => {
    boot(storyOf([prompt('one'), ...read('r1', '/work/demo-shop/README.md'), end(1000)]));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    expect($('.story-panel[data-kind="investigate"] .story-hit')!.title).toBe('Open README.md');
    const next = storyOf([prompt('one'), ...read('r1', '/work/demo-shop/rename_by_date.sh'), end(1000)]);
    next.page!.id = app._story.data.page.id;
    app._story.data = next;
    app._storyRender();
    sizeAndDraw();
    expect($('.story-panel[data-kind="investigate"] .story-hit')!.title).toBe('Open rename_by_date.sh');
  });

  it('files written through a here-document open as a diff from the wire, with short paths', async () => {
    const lines = [
      prompt('write'),
      ...bash('b1', "cat > app.js <<'EOF'\nconst a = 1;\nEOF\nnode --test", 'Write and test', '# pass 1\n# fail 0'),
      end(1000),
    ];
    (lines[1] as { cwd?: string }).cwd = '/work/demo-shop';
    boot(storyOf(lines));
    app.openStoryMode(SID);
    await settle();
    app._storySetDirector(true);
    const link = $$('.story-wire .story-link').find((l) => l.dataset.storyOpen?.startsWith('diff:'))!;
    link.click();
    expect($('.story-drawer-kind')!.textContent).toBe('Diff');
    expect($('.story-drawer-title')!.textContent).toBe('app.js');
    expect($('.story-df-path')!.textContent).toBe('app.js');
    expect($('.story-df-path')!.title).toBe('/work/demo-shop/app.js');
    expect($$('.story-ln--add').map((l) => l.textContent)).toEqual(['1+const a = 1;']);
  });

  it('an append draws without line numbers, and a check offers the file it printed', async () => {
    const lines = [
      prompt('add and test'),
      ...bash(
        'b1',
        "cat >> notes.md <<'EOF'\nmore\nEOF\ncat stats.py && pytest -q",
        'Append, show and test',
        'def f(): pass\n5 passed in 0.1s'
      ),
      end(1000),
    ];
    (lines[1] as { cwd?: string }).cwd = '/work/demo-shop';
    boot(storyOf(lines));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $('.story-panel[data-kind="check"] .story-hit')!.click();
    const open = $$('.story-drawer-body .story-out-files button');
    expect(open.map((b) => b.textContent)).toEqual(['Open stats.py']);
    open[0].click();
    expect(app.openFilePreview).toHaveBeenLastCalledWith('/work/demo-shop/stats.py', SID);
    $$('.story-drawer-body button')
      .find((b) => b.textContent === 'See the file it wrote')!
      .click();
    expect($('.story-ln--hunk')!.textContent).toBe('Added at the end of the file (1 line)');
    expect($$('.story-ln--add').map((l) => l.textContent)).toEqual(['+more']);
  });

  it('a turn whose last words name an open problem ends "Done, with a catch", not "Mission complete!"', async () => {
    const words = [
      'I built the pomodoro timer and its tests, and all of them pass.',
      'It keeps the time in memory and redraws the clock every second while it runs. '.repeat(3),
      "Opening the page: it won't work if you double-click index.html.",
    ].join(' ');
    boot(storyOf([prompt('build it'), ...edit('e1', '/work/demo-shop/t.js', ['+x']), said(words), end(1000)]));
    app.openStoryMode(SID);
    await settle();
    expect($('.story-panel[data-kind="complete"] .story-splash-title')!.textContent).toBe('Done, with a catch');
    expect($('.story-panel[data-kind="complete"] .story-balloon-text')!.textContent).toMatch(
      /won't work if you double-click/
    );
  });

  it("a second opinion is a line in the next panel's caption, not a panel of its own", async () => {
    const advisor = {
      type: 'assistant',
      timestamp: '2026-10-18T09:41:20.000Z',
      message: {
        content: [
          { type: 'server_tool_use', id: 'srv1', name: 'advisor', input: {} },
          { type: 'advisor_tool_result', tool_use_id: 'srv1', content: { type: 'advisor_redacted_result' } },
        ],
      },
    };
    boot(storyOf([prompt('fix it'), advisor, ...edit('e1', '/work/demo-shop/a.py', ['+a = 1']), end(1000)]));
    app.openStoryMode(SID);
    await settle();
    expect($$('.story-panel').map((p) => p.dataset.kind)).toEqual(['mission', 'fix', 'complete']);
    const note = $('.story-panel[data-kind="fix"] .story-cap-note')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('after asking a stronger AI model for a second opinion');
  });

  it('a second opinion asked in the middle of a step says so, and the badge counts the card in front', async () => {
    const advisor = {
      type: 'assistant',
      timestamp: '2026-10-18T09:41:20.000Z',
      message: {
        content: [
          { type: 'server_tool_use', id: 'srv1', name: 'advisor', input: {} },
          { type: 'advisor_tool_result', tool_use_id: 'srv1', content: { type: 'advisor_redacted_result' } },
        ],
      },
    };
    boot(
      storyOf([
        prompt('fix it'),
        ...edit('e1', '/work/demo-shop/a.py', ['+a = 1', '+b = 2']),
        advisor,
        ...edit('e2', '/work/demo-shop/b.py', ['+c = 3', '+d = 4', '+e = 5']),
        end(1000),
      ])
    );
    drawnTexts.length = 0;
    app.openStoryMode(SID);
    await settle();
    expect($('.story-panel[data-kind="fix"] .story-cap-note')!.textContent).toBe(
      'along the way, asks a stronger AI model for a second opinion'
    );
    // Two files: the badge counts a.py, the card in front (+2), not the panel's +5. (JSDOM lays out
    // nothing, so the panel is given a size and drawn late in its animation, the badge showing.)
    const rt = app._story.panels.find((p: { kind: string }) => p.kind === 'fix');
    Object.assign(rt, { w: 600, h: 270, dpr: 1, bgKey: '', clock: 200 });
    app._storyDrawPanel(rt);
    expect(drawnTexts).toContain('+2');
    expect(drawnTexts).not.toContain('+5');
  });

  it("the first save no prompt asked for says so in a small line; a catch beats 'Done for now'", async () => {
    boot(
      storyOf([
        prompt('Add a.'),
        ...bash('b1', 'git commit -qm "add a"', 'Commit', ''),
        // Still running when the turn ends: the page would read "Done for now" without the catch.
        ...bash('b2', 'sleep 60 && pytest -q', 'Slow tests', 'Command running in background with ID: b2x'),
        said(
          'I added a and saved it. ' +
            'It reads the file and prints the counts for each column, one line per column. '.repeat(3) +
            'One known issue: big numbers are shown rounded.'
        ),
        end(1000),
      ])
    );
    app.openStoryMode(SID);
    await settle();
    expect($('.story-panel[data-kind="save"] .story-cap-note')!.textContent).toBe(
      'a save your prompt here did not ask for'
    );
    expect($('.story-panel[data-kind="complete"] .story-splash-title')!.textContent).toBe('Done, with a catch');
  });

  it("an unasked save that Claude says the project's rules ask for says so", async () => {
    boot(
      storyOf([
        prompt('Add a.'),
        ...bash('b1', 'git commit -qm "add a"', 'Commit', ''),
        said("I added a. I committed it to follow CLAUDE.md's commit-after-each-change rule."),
        end(1000),
      ])
    );
    app.openStoryMode(SID);
    await settle();
    expect($('.story-panel[data-kind="save"] .story-cap-note')!.textContent).toBe(
      "a save your prompt here did not ask for; your project's rules do"
    );
  });

  it('a second opinion that came back with an error says no answer came', async () => {
    const failed = {
      type: 'assistant',
      timestamp: '2026-10-18T09:41:20.000Z',
      message: {
        content: [
          { type: 'server_tool_use', id: 'srv1', name: 'advisor', input: {} },
          {
            type: 'advisor_tool_result',
            tool_use_id: 'srv1',
            content: { type: 'advisor_tool_result_error', error_code: 'unavailable' },
          },
        ],
      },
    };
    boot(storyOf([prompt('fix it'), failed, ...edit('e1', '/work/demo-shop/a.py', ['+a = 1']), end(1000)]));
    app.openStoryMode(SID);
    await settle();
    expect($('.story-panel[data-kind="fix"] .story-cap-note')!.textContent).toBe(
      'after trying to ask a stronger AI model for a second opinion (no answer came)'
    );
  });

  it('the final panel counts the commits of the whole turn, and says when the work was uploaded', async () => {
    const chipsFor = async (to: string) => {
      boot(
        storyOf([
          prompt('ship it'),
          ...edit('e1', '/work/demo-shop/a.py', ['+a = 1']),
          ...bash('b1', 'pytest -q && git commit -qam "fix: a"', 'Test and commit', '3 passed in 0.1s'),
          ...bash(
            'b2',
            'git commit -qam "docs: b" && git push',
            'Commit and push',
            `To ${to}\n   1a2b3c4..5d6e7f8  main -> main`
          ),
          end(1000),
        ])
      );
      app.openStoryMode(SID);
      await settle();
      return $$('.story-panel[data-kind="complete"] .story-chips li').map((li) => li.textContent);
    };
    expect(await chipsFor('git@github.com:me/shop.git')).toContain('2 commits, uploaded');
    app.closeStoryMode?.();
    // A folder on this computer: a copy, named.
    expect(await chipsFor('./origin.git')).toContain('2 commits, copied to origin.git');
  });

  it('a chip that opened the drawer takes focus back, even when the page was redrawn meanwhile', async () => {
    boot(storyOf(demoTurn()));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const chip = $$('.story-chips button').find((b) => b.dataset.storyOpen === 'diff:page')!;
    chip.focus();
    chip.click();
    expect($('.story-drawer-kind')!.textContent).toBe('Diff');
    // A redraw with the same chips keeps the same element.
    app._storyRender();
    expect(win.document.contains(chip)).toBe(true);
    // One that did replace it: focus goes to the chip that opens the same thing.
    const twin = chip.cloneNode(true) as HTMLElement;
    chip.replaceWith(twin);
    press('Escape');
    expect($('.story-drawer')!.hidden).toBe(true);
    expect(win.document.activeElement).toBe(twin);
  });

  it("the compact panel opens what was packed up: the compaction's numbers, not an empty output", async () => {
    boot(
      storyOf([
        prompt('go'),
        ...read('r1', '/work/demo-shop/a.ts'),
        {
          type: 'system',
          subtype: 'compact_boundary',
          timestamp: '2026-10-18T09:45:00.000Z',
          compactMetadata: { trigger: 'auto', preTokens: 46928, postTokens: 3623, durationMs: 24014 },
        },
        said('Carrying on.'),
        end(1000),
      ])
    );
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const hit = $('.story-panel[data-kind="compact"] .story-hit')!;
    expect(hit.getAttribute('aria-label')).toBe('See what was packed up');
    hit.click();
    expect($('.story-drawer')!.hidden).toBe(false);
    const body = $('.story-drawer-body')!.textContent!;
    expect(body).toMatch(/46\.9k/);
    expect(body).toMatch(/3\.6k/);
    expect(body).not.toMatch(/No output|nothing to show/i);
  });

  it('parked on an older turn, the poll learns about new turns and says so, without moving the reader', async () => {
    const two = [prompt('first job'), said('Done.'), end(2000), prompt('second job'), said('Done too.'), end(2000)];
    const three = [...two, prompt('third job'), said('All three.'), end(2000)];
    let poll: (() => void) | undefined;
    boot(storyOf(two));
    win.setInterval = ((fn: () => void) => {
      poll = fn;
      return 1;
    }) as never;
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const first = app._story.data.turns[0].id;
    responses = [{ status: 200, body: { success: true, data: storyAt(two, 0) } }];
    app._storyPickTurn(first);
    await settle();
    expect(app._story.data.page.id).toBe(first);
    const announced = $('.story-sr')!.textContent;
    // A third turn arrives while the reader looks at the first.
    responses = [{ status: 200, body: { success: true, data: storyAt(three, 0) } }];
    app._story.lastIdlePoll = 0;
    calls.length = 0;
    poll!();
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`turn=${encodeURIComponent(first)}`);
    expect($$('.story-turns option')).toHaveLength(3);
    expect(app._story.data.page.id).toBe(first);
    expect($('.story-turns')!.getAttribute('aria-label')).toBe('Turn 1 of 3');
    // The new turn is news, said once, without moving the reader.
    expect($('.story-sr')!.textContent).not.toBe(announced);
    expect($('.story-sr')!.textContent).toBe('A new turn started: third job. You are on turn 1 of 3.');
  });

  it('while a question waits, the pencils say so; the chosen answer is marked, not struck', async () => {
    const ask = (answered: boolean) =>
      storyOf([
        prompt('pick'),
        tool('q1', 'AskUserQuestion', {
          questions: [{ question: 'Which name?', options: [{ label: 'slugify' }, { label: 'kebab' }] }],
        }),
        ...(answered ? [result('q1', 'kebab', { toolUseResult: { answers: { 'Which name?': 'kebab' } } })] : []),
      ]);
    boot(ask(false));
    app.openStoryMode(SID);
    await settle();
    expect($('.story-pencils small')!.textContent).toBe('Waiting for your answer…');
    responses = [{ status: 200, body: { success: true, data: ask(true) } }];
    await app._storyRefresh();
    await settle();
    sizeAndDraw();
    $('.story-panel[data-kind="ask"] .story-hit')!.click();
    const chosen = $('.story-drawer-body .is-chosen')!;
    expect(chosen.textContent).toBe('kebab');
    expect($('.story-drawer-body .is-done')).toBeNull();
    expect($('.story-pencils small')!.textContent).toBe('Claude is working…');
  });

  it('a bare name under an ls header links into that folder; the session folder reads as "."', async () => {
    boot(
      storyOf([
        prompt('look'),
        ...bash(
          'b1',
          'ls /work/demo-shop && ls -R /work/demo-shop/clone',
          'List the clone',
          'clone/src:\nkebab.py\n\nnotes.md'
        ),
        end(1000),
      ])
    );
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $('.story-panel[data-kind="investigate"] .story-hit')!.click();
    expect($('.story-out-cmd')!.textContent).toBe('$ ls . && ls -R clone');
    const links = $$('.story-drawer-body .story-link');
    links.find((l) => l.textContent === 'kebab.py')!.click();
    expect(app.openFilePreview).toHaveBeenLastCalledWith('/work/demo-shop/clone/src/kebab.py', SID);
    links.find((l) => l.textContent === 'notes.md')!.click();
    expect(app.openFilePreview).toHaveBeenLastCalledWith('/work/demo-shop/notes.md', SID);
  });

  it('a file opened from Story Mode takes keyboard focus, keeps Tab inside, and gives focus back on Escape', async () => {
    boot(storyOf(demoTurn()));
    const overlay = () => $('#filePreviewOverlay')!;
    app.openFilePreview = vi.fn(() => overlay().classList.add('visible'));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    $('.story-panel[data-kind="loop"] .story-hit')!.click();
    const open = $$('.story-drawer-body .story-btn-s').find((b) => b.textContent === 'Open file')!;
    open.focus();
    open.click();
    await new Promise((r) => win.requestAnimationFrame(() => r(null)));
    const close = $('#filePreviewOverlay button[title="Close"]')!;
    expect(win.document.activeElement).toBe(close);
    for (const n of $$('#filePreviewOverlay button'))
      Object.defineProperty(n, 'offsetParent', { get: () => win.document.body });
    press('Tab');
    expect(overlay().contains(win.document.activeElement)).toBe(true);
    press('Escape');
    expect(app.closeFilePreview).toHaveBeenCalled();
    expect(win.document.activeElement).toBe(open);
    expect($('#storyOverlay')!.hidden).toBe(false);
  });

  it('turning the setting off hides the button and closes an open story', async () => {
    boot(storyOf(demoTurn()));
    app.openStoryMode(SID);
    await settle();
    app.loadAppSettingsFromStorage = () => ({ showStoryButton: false });
    app.applyStoryButtonVisibility();
    expect($('.btn-story-header')!.classList.contains('btn-story-header--hidden')).toBe(true);
    expect($('#sessionOptionsStoryBtn')!.hidden).toBe(true);
    expect($('#storyOverlay')!.hidden).toBe(true);
    app.loadAppSettingsFromStorage = () => ({ showStoryButton: true });
    app.applyStoryButtonVisibility();
    expect($('#sessionOptionsStoryBtn')!.hidden).toBe(false);
  });
});

describe('story-mode.js scenes', () => {
  /** Every panel kind, in plain and awkward shapes, drawn across its whole animation. */
  function pageWith(panels: StoryPanel[], extra: Partial<StoryPage> = {}): StoryPage {
    const base = storyOf(demoTurn()).page as StoryPage;
    return { ...base, ...extra, panels };
  }
  const cap = { story: 's', director: 'd' };

  it('no scene throws, whatever the panel holds', async () => {
    const base = storyOf(demoTurn()).page as StoryPage;
    const manyFiles = Array.from(
      { length: 20 },
      (_, i) => `/w/src/a/very/deep/path/file${i}WithALongCamelCaseName.test.tsx`
    );
    const shapes: StoryPanel[] = [
      { kind: 'mission', events: [0], caption: cap, balloon: { who: 'you', text: 'x'.repeat(500) } },
      { kind: 'investigate', events: [], caption: cap, files: [] },
      { kind: 'investigate', events: [], caption: cap, files: manyFiles, notes: ['grep -rn x'] },
      { kind: 'investigate', events: [], caption: cap, files: ['/w/a'] },
      {
        kind: 'research',
        events: [],
        caption: cap,
        notes: ['https://example.com/a/very/long/url/' + 'x'.repeat(200), 'q'],
      },
      { kind: 'research', events: [], caption: cap },
      {
        kind: 'plan',
        events: [],
        caption: cap,
        todos: Array.from({ length: 12 }, (_, i) => ({ text: `step ${i} ` + 'y'.repeat(80), done: i % 2 === 0 })),
      },
      { kind: 'plan', events: [], caption: cap, notes: [] },
      { kind: 'backup', events: [], caption: cap, helpers: [] },
      {
        kind: 'backup',
        events: [],
        caption: cap,
        helpers: Array.from({ length: 6 }, (_, i) => ({
          name: `h${i}`,
          type: 'Explore',
          task: 'z'.repeat(90),
          event: 0,
        })),
      },
      { kind: 'fix', events: [], caption: cap, files: [], added: 0, removed: 0 },
      {
        kind: 'fix',
        events: base.panels.find((p) => p.kind === 'loop')!.events,
        caption: cap,
        files: manyFiles,
        added: 999,
        removed: 999,
      },
      { kind: 'check', events: [], caption: cap },
      { kind: 'check', events: [], caption: cap, ok: true, tests: { passed: 5000, failed: 0 } },
      { kind: 'check', events: [], caption: cap, ok: false, tests: { passed: 0, failed: 3 } },
      { kind: 'check', events: [], caption: cap, ok: false },
      { kind: 'loop', events: [], caption: cap, rounds: 7, ok: false },
      { kind: 'loop', events: base.panels.find((p) => p.kind === 'loop')!.events, caption: cap, rounds: 2, ok: true },
      { kind: 'run', events: [], caption: cap, notes: [] },
      { kind: 'run', events: [], caption: cap, notes: Array.from({ length: 10 }, () => 'w'.repeat(300)) },
      { kind: 'save', events: [], caption: cap },
      { kind: 'ask', events: [], caption: cap, question: { text: 'Which one?', answer: 'The first' } },
      { kind: 'compact', events: [], caption: cap },
      { kind: 'montage', events: [], caption: cap, notes: ['a'] },
      { kind: 'complete', events: [], caption: cap, balloon: { who: 'claude', text: 'Done.' } },
    ];
    for (const interrupted of [false, true]) {
      boot({ supported: true, turns: [], page: pageWith(shapes, { interrupted, helpers: interrupted ? 0 : 3 }) });
      app.openStoryMode(SID);
      await settle();
      expect($$('.story-panel')).toHaveLength(shapes.length);
      for (const director of [false, true]) {
        app._storySetDirector(director);
        for (const frame of [0, 1, 15, 30, 45, 72, 200, 1000]) {
          for (const rt of app._story.panels) {
            rt.clock = frame;
            for (const [w, h] of [
              [600, 270],
              [300, 300],
              [900, 270],
              [220, 430],
            ]) {
              rt.w = w;
              rt.h = h;
              rt.dpr = 1;
              rt.bgKey = '';
              expect(() => app._storyDrawPanel(rt), `${rt.kind} at frame ${frame}, ${w}x${h}`).not.toThrow();
            }
          }
        }
      }
      app.closeStoryMode();
    }
  });
});

describe('story-mode.js layout', () => {
  it('fills every 6-column row exactly, and the last panel stretches to the end', () => {
    boot(null);
    const spans = (prefs: number[], cols = 6) => win.storyLayoutSpans(prefs, cols) as number[];
    for (const prefs of [[3, 3, 2, 2, 2, 6], [3, 2, 2, 2, 3, 2], [2], [3, 4, 2, 2], [6, 6], [2, 2, 2, 2, 2, 2, 2]]) {
      const s = spans(prefs);
      expect(s).toHaveLength(prefs.length);
      // Walk the rows: every row adds up to exactly 6.
      let row = 0;
      for (const span of s) {
        row += span;
        expect(row).toBeLessThanOrEqual(6);
        if (row === 6) row = 0;
      }
      expect(row).toBe(0);
    }
    expect(spans([1, 1, 1], 2)).toEqual([1, 1, 2]);
  });
});

describe('story-mode.js speech balloons', () => {
  const room = (o: Record<string, unknown>) => win.storyBalloonRoom(o) as { limit: number; grow: number };

  it('a balloon reaches down to the first object under it, its tail to the first under the tail', () => {
    boot(null);
    const base = { top: 10, x0: 100, x1: 300, floor: 250, keep: 62 };
    expect(room(base)).toEqual({ limit: 250, grow: 0 });
    // Under the body: the balloon ends above it (4 px gap).
    expect(room({ ...base, obstacles: [{ x0: 200, x1: 260, y: 104 }] }).limit).toBe(100);
    // Beside it (more than the gap away): ignored.
    expect(room({ ...base, obstacles: [{ x0: 20, x1: 90, y: 40 }] }).limit).toBe(250);
    // Under the tail only: the tail's tip ends above it, so the body ends a tail higher.
    const tail = { x0: 330, x1: 352, h: 16.5 };
    expect(room({ ...base, tail, obstacles: [{ x0: 340, x1: 400, y: 120 }] }).limit).toBe(120 - 16.5 - 4);
    // No room for two lines below a long caption: the panel grows by the shortfall.
    expect(room({ ...base, top: 168, obstacles: [{ x0: 200, x1: 260, y: 104 }] })).toEqual({ limit: 100, grow: 130 });
  });

  /** A panel with a box model: JSDOM lays nothing out, so every box the fit reads is given here. */
  function boxes(rt: Record<string, any>, capHeight: number) {
    const def = (el: HTMLElement, props: Record<string, () => number>) => {
      for (const [k, get] of Object.entries(props)) Object.defineProperty(el, k, { get, configurable: true });
    };
    const state = { grown: 0 };
    rt.el.style.setProperty('--story-panel-min', '270px');
    def(rt.el, {
      offsetHeight: () => 270 + state.grown,
      clientHeight: () => 264 + state.grown,
      clientWidth: () => 394,
    });
    def(rt.capStory.parentElement, {
      offsetTop: () => 10,
      offsetLeft: () => 10,
      offsetHeight: () => capHeight,
      offsetWidth: () => 250,
    });
    const b = rt.balloon as HTMLElement;
    const text = b.querySelector('.story-balloon-text') as HTMLElement;
    // Three lines of 19 px, fewer once clamped; 24 px of padding and border around them.
    const lines = () => Number(text.style.getPropertyValue('--story-lines')) || 3;
    const right = () => parseFloat(b.style.right);
    def(b, {
      offsetTop: () => parseFloat(b.style.top) || 0,
      offsetWidth: () => 200,
      offsetLeft: () => (Number.isNaN(right()) ? parseFloat(b.style.left) || 0 : 394 - right() - 200),
      offsetHeight: () => 24 + lines() * 19,
    });
    def(text, { offsetHeight: () => lines() * 19 });
    return state;
  }

  it('a balloon pushed below a long caption grows its panel, the same growth on the grown panel', async () => {
    boot(storyOf(demoTurn()));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const rt = app._story.panels.find((p: { kind: string }) => p.kind === 'investigate');
    const box = boxes(rt, 150);
    app._storyFitCaption(rt);
    // No room beside the caption: the balloon stands below it, over Claude's head at the right.
    expect(rt.balloon.style.top).toBe('168px');
    const grown = rt.el.style.minHeight;
    // Two lines (24 + 38 px) end above Claude's head (91 px down the usual stage, the tail 22 px
    // over it), so the panel grows by 168 + 62 - 69: more than the caption alone asks for (71).
    expect(grown).toBe('431px');
    // The resize observer refits the grown panel: the same height, and the text clamps to two lines.
    box.grown = parseFloat(grown) - 270;
    app._storyFitCaption(rt);
    expect(rt.el.style.minHeight).toBe(grown);
    const text = rt.balloon.querySelector('.story-balloon-text') as HTMLElement;
    expect(text.style.getPropertyValue('--story-lines')).toBe('2');
    // A taller row (a neighbour grew more) gives the text its third line back.
    rt.h = 264 + box.grown + 40;
    app._storyPlaceBalloon(rt);
    expect(text.style.getPropertyValue('--story-lines')).toBe('');
  });

  it('your balloon stands below a long caption, never under it', async () => {
    boot(storyOf(demoTurn()));
    app.openStoryMode(SID);
    await settle();
    sizeAndDraw();
    const rt = app._story.panels.find((p: { kind: string }) => p.kind === 'mission');
    boxes(rt, 120);
    app._storyFitCaption(rt);
    expect(rt.balloon.className).toContain('story-balloon--you');
    expect(rt.balloon.style.top).toBe('140px');
    expect(rt.balloon.style.left).toBe('16px');
    // The mission's click region is Claude himself: not an object to avoid, only his face is.
    expect(rt.layout.objects).toEqual([]);
    // Claude stands at the right: the balloon ends left of his face.
    const face = rt.layout.face;
    expect(16 + parseFloat(rt.balloon.style.maxWidth)).toBeLessThanOrEqual(face.x0 - 8);
  });
});
