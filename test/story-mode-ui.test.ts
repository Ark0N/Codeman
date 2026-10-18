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
import { bash, demoTurn, end, prompt, read, resetClock, result, said, tool } from './story-fixtures.js';

const STORY_JS = readFileSync(new URL('../src/web/public/story-mode.js', import.meta.url), 'utf-8');
// The real path matcher (findFilePathLinks / resolveLinkedFilePath) the terminal uses.
const CONSTANTS_JS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const SID = 'session-0001-abcdef';

type Win = Window & typeof globalThis & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function storyOf(lines: unknown[]) {
  const reducer = createStoryReducer();
  const turns = buildStoryTurns(lines.flatMap((l) => reducer.reduce(l)));
  return {
    supported: true,
    turns: summarizeTurns(turns),
    page: turns.length ? buildStoryPage(turns[turns.length - 1]) : null,
  };
}

/** A 2D context that accepts every call; measureText answers a plausible width. */
function fakeContext() {
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: String(text).length * 6 }),
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
    expect($('.story-panel[data-kind="mission"] .story-balloon')!.textContent).toBe(
      'The checkout button does nothing on phones. Can you fix it?'
    );
    expect($('.story-panel[data-kind="mission"] .story-balloon')!.className).toContain('story-balloon--you');
    expect($('.story-panel[data-kind="investigate"] .story-cap-story')!.textContent).toBe(
      'Claude reads 2 files to find its way around.'
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
    expect(balloon.textContent).toBe('Agent "Docs" finished');
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
