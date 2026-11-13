/**
 * @fileoverview Frontend tests for the Custom Model Endpoint Profiles Run-menu
 * picker (docs/custom-model-endpoints-plan.md): the generated entries in
 * session-ui.js's `_refreshCustomModelRunOptions()` / `runCustomModelEntry()`.
 *
 * These are DOM-level facts that need no Playwright and no tmux — `runScripts:
 * "dangerously"` is used deliberately (this JSDOM only ever parses markup this
 * module itself generated, never live user input) so that a broken inline
 * `onclick` attribute shows up as a genuinely uncallable handler, the same way
 * it would in a real browser, rather than merely as a string this test parses
 * by eye. `test/admin-ui.test.ts` and `test/home-sessions.test.ts` are the
 * precedent for driving a real frontend module against a JSDOM window rather
 * than a live server.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const CONSTANTS_JS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const SESSION_UI_JS = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');
// Only for the [hidden] CSS guard below: the filter toggles the `hidden` property, and
// `.run-mode-option`'s own `display: flex` would silently defeat it without the
// `!important` re-assertion in styles.css.
const STYLES_CSS = readFileSync(new URL('../src/web/public/styles.css', import.meta.url), 'utf-8');
// Only for the real _showCenterStatus DOM tests below (`bootAppWithRealCenterStatus`) —
// every other test in this file stubs _showCenterStatus itself and has no need of it.
const PANELS_UI_JS = readFileSync(new URL('../src/web/public/panels-ui.js', import.meta.url), 'utf-8');

// The warning formats counts with the runtime's own locale (a German user reads 131.072), so the
// expectations ask the same runtime instead of hard-coding the en-US grouping.
const num = (n: number) => n.toLocaleString();

function resp(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

/**
 * Boots a minimal CodemanApp instance with constants.js + session-ui.js
 * evaluated against a real JSDOM window, so escapeHtml and the picker's own
 * innerHTML-building code run exactly as they do in the browser.
 */
function bootApp(
  options: {
    customModelClis?: Array<{ id: string; label: string }>;
    hosts?: unknown;
    cliAvailable?: (id: string) => boolean;
    activeCase?: { location?: string } | null;
    settingsEnabled?: boolean;
    /** Live sessions for the "in use by a session" fallback, in `this.sessions` Map shape. */
    sessions?: Array<Record<string, unknown>>;
  } = {}
) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <select id="quickStartCase"><option value="testcase" selected>testcase</option></select>
      <input id="tabCount" value="1">
      <button id="runBtn"></button>
      <div id="runModeMenu">
        <div id="runModeCustomModelSep" style="display:none"></div>
        <div id="runModeCustomModelHeader" style="display:none"></div>
        <div id="runModeCustomModels"></div>
      </div>
      <div class="modal" id="customModelPickModal">
        <h3 id="customModelPickTitle"></h3>
        <p id="customModelPickHint"></p>
        <input type="search" id="customModelPickSearch" aria-label="Search models"
          oninput="app.filterCustomModelPick(this.value)">
        <p id="customModelPickNoMatches" role="status" hidden>No models match</p>
        <p id="customModelPickUnknown" role="status" hidden>Nothing is marked: this endpoint did not report which model it has loaded, and none of your running sessions uses one. Pick the model to launch.</p>
        <div id="customModelPickList"></div>
      </div>
      <div class="modal" id="customModelSwapConfirmModal">
        <p id="customModelSwapConfirmMessage"></p>
      </div>
      <div class="modal" id="customModelContextWarningModal">
        <p id="customModelContextWarningMessage"></p>
      </div>
    </body>`,
    { url: 'http://localhost/', runScripts: 'dangerously' }
  );
  const win = dom.window as unknown as Window &
    typeof globalThis & {
      CodemanApp: new () => any;
      __codemanCustomModelClis?: Array<{ id: string; label: string }>;
    };
  (win as unknown as { eval: (s: string) => void }).eval('window.CodemanApp = function CodemanApp() {};');
  (win as unknown as { eval: (s: string) => void }).eval(CONSTANTS_JS);
  (win as unknown as { eval: (s: string) => void }).eval(SESSION_UI_JS);

  win.__codemanCustomModelClis = options.customModelClis ?? [{ id: 'claude', label: 'Claude Code' }];

  const app = new win.CodemanApp();
  app.cases = options.activeCase ? [{ name: 'testcase', ...options.activeCase }] : [{ name: 'testcase' }];
  app.loadAppSettingsFromStorage = () => ({ customModelEndpointsEnabled: options.settingsEnabled ?? true });
  app.isCliAvailable = options.cliAvailable ?? (() => true);
  // The real app keeps live sessions in a Map keyed by id (app.js), which is what
  // _getCustomModelInUseBySession walks; empty by default so a test that says nothing
  // about sessions sees no promotion, exactly like a box with none running.
  app.sessions = new Map((options.sessions || []).map((s, i) => [String(i), s]));
  app.showToast = () => {};
  // Real implementation lives in panels-ui.js, not evaluated into this harness (only
  // constants.js + session-ui.js are — see below) — a no-op default handle matching its
  // real shape, same reasoning as showToast above; tests of the center status itself
  // override it.
  app._showCenterStatus = () => ({ dismiss: () => {}, setMessage: () => {} });
  // Default no-op so a button's onclick (selectCustomModelEntry -> possibly
  // straight to runCustomModelEntry for a single-model host) never rejects
  // with "this.run is not a function"; tests of the launch itself override it.
  app.run = async () => {};
  // _apiJson unwraps the {success,data} envelope for real against a live
  // server; here it stands in for that, driven from a fixed `hosts` fixture
  // so these tests exercise the picker's OWN code, not the envelope helper.
  app._apiJson = async (path: string) => {
    if (path === '/api/model-endpoints') return options.hosts ?? [];
    return null;
  };
  return { dom, win, app };
}

/**
 * Like `bootApp`, but also evaluates panels-ui.js so `_showCenterStatus` is the REAL
 * implementation rather than the plain stub `bootApp` installs — for the Cancel-button
 * rendering tests, which need to see actual DOM the app would produce.
 */
function bootAppWithRealCenterStatus() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'dangerously' });
  const win = dom.window as unknown as Window & typeof globalThis & { CodemanApp: new () => any };
  // jsdom doesn't polyfill requestAnimationFrame, and _showCenterStatus calls it to add
  // the 'show' class — run it synchronously, which is all a non-visual test needs.
  (win as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (cb) => {
    cb();
    return 0;
  };
  (win as unknown as { eval: (s: string) => void }).eval('window.CodemanApp = function CodemanApp() {};');
  (win as unknown as { eval: (s: string) => void }).eval(CONSTANTS_JS);
  (win as unknown as { eval: (s: string) => void }).eval(SESSION_UI_JS);
  (win as unknown as { eval: (s: string) => void }).eval(PANELS_UI_JS);
  const app = new win.CodemanApp();
  return { win, app };
}

describe('Custom Model Endpoint Profiles: Run-menu picker generation', () => {
  it('generates a real, clickable button per (capable CLI, endpoint) pair', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3'] }],
    });
    const menu = win.document.getElementById('runModeMenu')!;
    await app._refreshCustomModelRunOptions(menu);

    const container = win.document.getElementById('runModeCustomModels')!;
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);

    const btn = buttons[0] as unknown as HTMLButtonElement & { onclick: unknown };
    // The real bug: JSON.stringify's own double quotes terminate the
    // double-quoted onclick attribute at the first one, so btn.onclick comes
    // back null and the parsed attribute is garbage. With escapeHtml wrapping
    // each stringified argument, jsdom (which compiles inline handlers under
    // runScripts:"dangerously" exactly like a real browser) parses it as a
    // real, callable function.
    expect(typeof btn.onclick).toBe('function');

    win.app = app;
    expect(() => btn.onclick!(new (win as any).Event('click'))).not.toThrow();
  });

  it('escapes a model id containing HTML-significant characters instead of letting it break out of the tag', async () => {
    // modelId comes from the endpoint's OWN /v1/models reply, which this box
    // does not control — a live-HTML-injection vector if it ever reaches the
    // markup unescaped, distinct from (and on top of) the quoting bug above.
    const dangerousModel = '"><img src=x onerror=alert(1)>';
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: [dangerousModel] }],
    });
    const menu = win.document.getElementById('runModeMenu')!;
    await app._refreshCustomModelRunOptions(menu);

    const container = win.document.getElementById('runModeCustomModels')!;
    // The injected markup must never have produced a live <img> element: if it
    // did, the attacker-controlled tag closed the button early and escaped
    // into sibling markup instead of staying inert string data.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('button').length).toBe(1);
  });

  it('is hidden when the feature setting is off, even with capable CLIs and endpoints present', async () => {
    const { win, app } = bootApp({
      settingsEnabled: false,
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3'] }],
    });
    const menu = win.document.getElementById('runModeMenu')!;
    await app._refreshCustomModelRunOptions(menu);
    expect(win.document.getElementById('runModeCustomModels')!.innerHTML).toBe('');
    expect((win.document.getElementById('runModeCustomModelSep') as HTMLElement).style.display).toBe('none');
  });

  it('is hidden for a remote or Docker active case, since the apply route refuses both', async () => {
    for (const location of ['remote', 'docker']) {
      const { win, app } = bootApp({
        activeCase: { location },
        hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3'] }],
      });
      const menu = win.document.getElementById('runModeMenu')!;
      await app._refreshCustomModelRunOptions(menu);
      expect(win.document.getElementById('runModeCustomModels')!.innerHTML, location).toBe('');
    }
  });

  it('skips an endpoint with no discovered model and no default, rather than generating a dead entry', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'undiscovered', label: 'Not discovered yet', baseUrl: 'http://localhost:8080', models: [] }],
    });
    const menu = win.document.getElementById('runModeMenu')!;
    await app._refreshCustomModelRunOptions(menu);
    expect(win.document.getElementById('runModeCustomModels')!.innerHTML).toBe('');
  });

  it('omits a CLI the host does not have installed, matching the stock entries’ own gating', async () => {
    const { win, app } = bootApp({
      customModelClis: [
        { id: 'claude', label: 'Claude Code' },
        { id: 'codex', label: 'Codex' },
      ],
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3'] }],
      cliAvailable: (id: string) => id === 'claude',
    });
    const menu = win.document.getElementById('runModeMenu')!;
    await app._refreshCustomModelRunOptions(menu);
    const container = win.document.getElementById('runModeCustomModels')!;
    expect(container.querySelectorAll('button').length).toBe(1);
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).not.toContain('Codex');
  });
});

describe('Custom Model Endpoint Profiles: the "which model" picker', () => {
  it('launches straight away for a host with exactly one discovered model, no dialog', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3'] }],
    });
    let launched: unknown[] | null = null;
    app.runCustomModelEntry = async (...args: unknown[]) => {
      launched = args;
    };

    await app.selectCustomModelEntry('claude', 'llama-box');

    expect(launched).toEqual(['claude', 'llama-box', 'qwen3']);
    expect(win.document.getElementById('customModelPickModal')!.classList.contains('active')).toBe(false);
  });

  it('opens the picker for a host with more than one discovered model, rather than launching directly', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3', 'llama3'] }],
    });
    let launched = false;
    app.runCustomModelEntry = async () => {
      launched = true;
    };

    await app.selectCustomModelEntry('claude', 'llama-box');

    expect(launched).toBe(false);
    const modal = win.document.getElementById('customModelPickModal')!;
    expect(modal.classList.contains('active')).toBe(true);
    const list = win.document.getElementById('customModelPickList')!;
    expect(list.querySelectorAll('button').length).toBe(2);
    expect(list.textContent).toContain('qwen3');
    expect(list.textContent).toContain('llama3');
  });

  it('always asks with 2+ models, even when a defaultModelId is set — the point is letting this launch differ', async () => {
    const { win, app } = bootApp({
      hosts: [
        {
          id: 'llama-box',
          label: 'llama.cpp',
          baseUrl: 'http://localhost:8080',
          models: ['qwen3', 'llama3'],
          defaultModelId: 'qwen3',
        },
      ],
    });
    await app.selectCustomModelEntry('claude', 'llama-box');
    const modal = win.document.getElementById('customModelPickModal')!;
    expect(modal.classList.contains('active')).toBe(true);
    // The default is marked, not auto-chosen.
    expect(win.document.getElementById('customModelPickList')!.textContent).toContain('Default');
  });

  it('promotes the model llama-swap currently has loaded and ready to the top of the list, tagged', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3', 'phi4'] }],
    });
    const origApiJson = app._apiJson;
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints/llama-box/running-status') {
        return { isLlamaSwap: true, running: [{ model: 'phi4', state: 'ready' }] };
      }
      return origApiJson(path);
    };

    await app.selectCustomModelEntry('claude', 'llama-box');

    const buttons = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toHaveLength(3);
    expect(buttons[0].textContent).toContain('phi4');
    expect(buttons[0].textContent).toContain('Currently loaded');
    // Nothing else got relabelled or reordered past the promoted row.
    expect(buttons[1].textContent).toContain('qwen3');
    expect(buttons[2].textContent).toContain('llama3');
  });

  it('falls back to the last model launched on this (harness, endpoint) pair when nothing is currently loaded', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3', 'phi4'] }],
    });
    const origApiJson = app._apiJson;
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints/llama-box/running-status') return { isLlamaSwap: false, running: [] };
      return origApiJson(path);
    };
    // Simulate a prior launch on this exact (harness, endpoint) pair having picked llama3.
    win.localStorage.setItem('codeman:customModelLastUsed:claude:llama-box', 'llama3');

    await app.selectCustomModelEntry('claude', 'llama-box');

    const buttons = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')];
    expect(buttons[0].textContent).toContain('llama3');
    expect(buttons[0].textContent).toContain('Last used');
    expect(buttons[0].textContent).not.toContain('Currently loaded');
  });

  it('treats a remembered "last used" id the host no longer lists as nothing promoted: no tag, the line shows', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3'] }],
    });
    const origApiJson = app._apiJson;
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints/llama-box/running-status') return { isLlamaSwap: false, running: [] };
      return origApiJson(path);
    };
    // The remembered model was deleted from this endpoint since the last launch.
    win.localStorage.setItem('codeman:customModelLastUsed:claude:llama-box', 'gone-model');

    await app.selectCustomModelEntry('claude', 'llama-box');

    const list = win.document.getElementById('customModelPickList')!;
    expect(list.textContent).not.toContain('Last used');
    // Without a promoted row the probe really did answer "nothing is known", so the
    // explanation line must show rather than leave two unmarked rows unexplained.
    expect(win.document.getElementById('customModelPickUnknown')!.hidden).toBe(false);
  });

  it('prefers the currently-loaded model over a stale "last used" entry when both are present', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3', 'phi4'] }],
    });
    const origApiJson = app._apiJson;
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints/llama-box/running-status') {
        return { isLlamaSwap: true, running: [{ model: 'phi4', state: 'ready' }] };
      }
      return origApiJson(path);
    };
    win.localStorage.setItem('codeman:customModelLastUsed:claude:llama-box', 'llama3');

    await app.selectCustomModelEntry('claude', 'llama-box');

    const buttons = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')];
    expect(buttons[0].textContent).toContain('phi4');
    expect(buttons[0].textContent).toContain('Currently loaded');
  });

  it('a currently-loaded row that is also the endpoint default shows BOTH tags, as two separate spans', async () => {
    // The common case on a single-purpose GPU box: the one model that is loaded is the
    // saved default too. An exclusive tag slot (promotion, else Default) silently dropped
    // the Default marking for exactly that row.
    const { win, app } = bootApp({
      hosts: [
        {
          id: 'llama-box',
          label: 'llama.cpp',
          baseUrl: 'http://x',
          models: ['qwen3', 'llama3', 'phi4'],
          defaultModelId: 'phi4',
        },
      ],
    });
    const origApiJson = app._apiJson;
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints/llama-box/running-status') {
        return { isLlamaSwap: true, running: [{ model: 'phi4', state: 'ready' }] };
      }
      return origApiJson(path);
    };

    await app.selectCustomModelEntry('claude', 'llama-box');

    const buttons = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')];
    expect(buttons[0].textContent).toContain('phi4');
    const tags = [...buttons[0].querySelectorAll('.set-scope')].map((el) => el.textContent);
    expect(tags).toEqual(['Currently loaded', 'Default']);
    // Rows with neither a promotion nor the default carry no tag at all.
    expect(buttons[1].querySelectorAll('.set-scope')).toHaveLength(0);
    expect(buttons[2].querySelectorAll('.set-scope')).toHaveLength(0);
  });

  it('a "last used" row that is also the endpoint default shows both tags too', async () => {
    const { win, app } = bootApp({
      hosts: [
        {
          id: 'llama-box',
          label: 'llama.cpp',
          baseUrl: 'http://x',
          models: ['qwen3', 'llama3', 'phi4'],
          defaultModelId: 'llama3',
        },
      ],
    });
    const origApiJson = app._apiJson;
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints/llama-box/running-status') return { isLlamaSwap: false, running: [] };
      return origApiJson(path);
    };
    win.localStorage.setItem('codeman:customModelLastUsed:claude:llama-box', 'llama3');

    await app.selectCustomModelEntry('claude', 'llama-box');

    const buttons = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')];
    expect(buttons[0].textContent).toContain('llama3');
    const tags = [...buttons[0].querySelectorAll('.set-scope')].map((el) => el.textContent);
    expect(tags).toEqual(['Last used', 'Default']);
  });

  it('is not fooled by a model llama-swap reports loaded but not yet ready, or one this host no longer lists', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3'] }],
    });
    const origApiJson = app._apiJson;
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints/llama-box/running-status') {
        // "loading", not "ready" — and a model id this host's own /v1/models no longer serves.
        return { isLlamaSwap: true, running: [{ model: 'ghost-model', state: 'loading' }] };
      }
      return origApiJson(path);
    };

    await app.selectCustomModelEntry('claude', 'llama-box');

    const list = win.document.getElementById('customModelPickList')!;
    expect(list.textContent).not.toContain('Currently loaded');
    expect(list.textContent).not.toContain('ghost-model');
    const buttons = [...list.querySelectorAll('button')];
    expect(buttons[0].textContent).toContain('qwen3');
  });

  it('remembers the launched model as "last used" only once the apply actually succeeds, not on the mere attempt', async () => {
    const { win, app } = bootApp({});
    app.activeSessionId = 'old-session';
    // A real new session, and a real successful apply with no questions asked — the
    // restart path only reaches its _setCustomModelLastUsed call past both.
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    app._api = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { customModel: { endpointId: 'llama-box' }, restarted: true } }),
    });

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(win.localStorage.getItem('codeman:customModelLastUsed:claude:llama-box')).toBe('qwen3');
  });

  it('a slower currently-loaded probe for an earlier pick must never clobber a faster, later pick for a different endpoint', async () => {
    const { win, app } = bootApp({});
    const hostA = { id: 'host-a', label: 'Host A', baseUrl: 'http://a', models: ['a1', 'a2'] };
    const hostB = { id: 'host-b', label: 'Host B', baseUrl: 'http://b', models: ['b1', 'b2'] };
    let resolveA!: (v: unknown) => void;
    const pendingA = new Promise((resolve) => {
      resolveA = resolve;
    });
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints/host-a/running-status') return pendingA;
      if (path === '/api/model-endpoints/host-b/running-status') return { isLlamaSwap: false, running: [] };
      return null;
    };

    // Host A's picker opens first but its probe never resolves until we say so below —
    // Host B's opens second and resolves immediately, so it renders first.
    const openA = app._openCustomModelPickModal('claude', hostA);
    await app._openCustomModelPickModal('claude', hostB);

    expect(win.document.getElementById('customModelPickHint')!.textContent).toContain('Host B');
    expect(app._pendingCustomModelPick).toEqual({ mode: 'claude', endpointId: 'host-b' });

    // Host A's probe finally answers, after Host B has already rendered.
    resolveA({ isLlamaSwap: false, running: [] });
    await openA;

    // The late-arriving Host A response must be a no-op: still Host B on screen.
    expect(win.document.getElementById('customModelPickHint')!.textContent).toContain('Host B');
    expect(app._pendingCustomModelPick).toEqual({ mode: 'claude', endpointId: 'host-b' });
    const listText = win.document.getElementById('customModelPickList')!.textContent;
    expect(listText).toContain('b1');
    expect(listText).toContain('b2');
    expect(listText).not.toContain('a1');
    expect(listText).not.toContain('a2');
  });

  it('picking a row in the modal closes it and launches with that exact model', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3', 'llama3'] }],
    });
    let launched: unknown[] | null = null;
    app.runCustomModelEntry = async (...args: unknown[]) => {
      launched = args;
    };
    win.app = app;

    await app.selectCustomModelEntry('claude', 'llama-box');
    const buttons = win.document.getElementById('customModelPickList')!.querySelectorAll('button');
    const llama3Btn = [...buttons].find((b) => b.textContent?.includes('llama3')) as unknown as HTMLButtonElement & {
      onclick: (e: unknown) => void;
    };
    expect(typeof llama3Btn.onclick).toBe('function');
    llama3Btn.onclick(new (win as any).Event('click'));

    expect(launched).toEqual(['claude', 'llama-box', 'llama3']);
    expect(win.document.getElementById('customModelPickModal')!.classList.contains('active')).toBe(false);
  });

  it('re-fetches the endpoint at click time rather than trusting anything cached from the menu render', async () => {
    // The background re-discovery sweep (server-side, every 5 minutes) or a
    // settings-panel edit can change the model list between opening the
    // dropdown and clicking a row — the picker must reflect what is current.
    let fetchCount = 0;
    const { win, app } = bootApp({});
    app._apiJson = async (path: string) => {
      if (path !== '/api/model-endpoints') return null;
      fetchCount += 1;
      return [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3', 'phi4'] }];
    };
    await app.selectCustomModelEntry('claude', 'llama-box');
    expect(fetchCount).toBe(1);
    expect(win.document.getElementById('customModelPickList')!.querySelectorAll('button').length).toBe(3);
  });

  it('toasts and does nothing when the endpoint has vanished by click time', async () => {
    const { app } = bootApp({ hosts: [] });
    let toastMessage: string | null = null;
    app.showToast = (msg: string) => {
      toastMessage = msg;
    };
    await app.selectCustomModelEntry('claude', 'ghost-endpoint');
    expect(toastMessage).toMatch(/no longer exists/i);
  });

  it('toasts and does nothing when the endpoint has zero discovered models by click time', async () => {
    const { app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: [] }],
    });
    let toastMessage: string | null = null;
    app.showToast = (msg: string) => {
      toastMessage = msg;
    };
    await app.selectCustomModelEntry('claude', 'llama-box');
    expect(toastMessage).toMatch(/no models discovered/i);
  });

  it('resets and focuses the search box every time the picker opens', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3'] }],
    });
    win.app = app;
    await app.selectCustomModelEntry('claude', 'llama-box');
    const search = win.document.getElementById('customModelPickSearch') as HTMLInputElement;
    // The caret lands in the box, so the first keystroke filters with no click.
    expect(win.document.activeElement).toBe(search);
    // A stale query from a previous open must not survive into the next one.
    search.value = 'zzz';
    search.dispatchEvent(new win.Event('input'));
    app.closeCustomModelPickModal();

    await app.selectCustomModelEntry('claude', 'llama-box');
    expect(search.value).toBe('');
    expect(win.document.activeElement).toBe(search);
    expect(win.document.getElementById('customModelPickNoMatches')!.hasAttribute('hidden')).toBe(true);
    const visible = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')].filter(
      (b) => !b.hasAttribute('hidden')
    );
    expect(visible).toHaveLength(2);
  });

  it('leaves the search box unfocused on touch devices so the OS keyboard stays off the list', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3'] }],
    });
    win.app = app;
    // The guard reads the global the browser defines (mobile-detection.js).
    (win as unknown as { MobileDetection: { isTouchDevice: () => boolean } }).MobileDetection = {
      isTouchDevice: () => true,
    };

    await app.selectCustomModelEntry('claude', 'llama-box');

    const search = win.document.getElementById('customModelPickSearch') as HTMLInputElement;
    expect(win.document.activeElement).not.toBe(search);
    // Only the focus is skipped: the rows still render, unfiltered and functional.
    const visible = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')].filter(
      (b) => !b.hasAttribute('hidden')
    );
    expect(visible).toHaveLength(2);
  });

  it('filters rows case-insensitively on the model id, keeping the surviving row fully functional', async () => {
    const { win, app } = bootApp({
      hosts: [
        {
          id: 'llama-box',
          label: 'llama.cpp',
          baseUrl: 'http://x',
          models: ['qwen3', 'llama3'],
          defaultModelId: 'qwen3',
        },
      ],
    });
    let launched: unknown[] | null = null;
    app.runCustomModelEntry = async (...args: unknown[]) => {
      launched = args;
    };
    win.app = app;
    await app.selectCustomModelEntry('claude', 'llama-box');
    const search = win.document.getElementById('customModelPickSearch') as HTMLInputElement;
    search.value = 'QWEN';
    search.dispatchEvent(new win.Event('input'));

    const buttons = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')];
    expect(buttons.filter((b) => b.hasAttribute('hidden')).map((b) => b.textContent!.trim())).toEqual(['llama3']);
    const [visible] = buttons.filter((b) => !b.hasAttribute('hidden'));
    // The surviving row keeps its Default badge and its real, callable click handler.
    expect(visible.textContent).toContain('qwen3');
    expect(visible.textContent).toContain('Default');
    (visible as unknown as HTMLButtonElement & { onclick: (e: unknown) => void }).onclick(
      new (win as any).Event('click')
    );
    expect(launched).toEqual(['claude', 'llama-box', 'qwen3']);
  });

  it('shows the no-matches line only while a query matches nothing, and clears it with the query', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3'] }],
    });
    win.app = app;
    await app.selectCustomModelEntry('claude', 'llama-box');
    const search = win.document.getElementById('customModelPickSearch') as HTMLInputElement;
    const noMatches = win.document.getElementById('customModelPickNoMatches')!;
    const isHidden = () =>
      win.document.getElementById('customModelPickList')!.querySelectorAll('button[hidden]').length;

    // Whitespace is not a query: everything stays visible, no message.
    search.value = '   ';
    search.dispatchEvent(new win.Event('input'));
    expect(noMatches.hasAttribute('hidden')).toBe(true);
    expect(isHidden()).toBe(0);

    search.value = 'ghost';
    search.dispatchEvent(new win.Event('input'));
    expect(noMatches.hasAttribute('hidden')).toBe(false);
    expect(isHidden()).toBe(2);

    search.value = '';
    search.dispatchEvent(new win.Event('input'));
    expect(noMatches.hasAttribute('hidden')).toBe(true);
    expect(isHidden()).toBe(0);
  });

  it('keeps an HTML-significant model id inert in the picker rows too, and filterable by its raw text', async () => {
    // Same vector as the Run-menu row above, now via data-model-id: escapeHtml covers
    // the double quote, and the filter reads the decoded raw id back off dataset.
    const dangerousModel = '"><img src=x onerror=alert(1)>';
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', dangerousModel] }],
    });
    win.app = app;
    await app.selectCustomModelEntry('claude', 'llama-box');
    const list = win.document.getElementById('customModelPickList')!;
    expect(list.querySelector('img')).toBeNull();

    const search = win.document.getElementById('customModelPickSearch') as HTMLInputElement;
    search.value = 'src=x';
    search.dispatchEvent(new win.Event('input'));
    const visible = list.querySelectorAll('button:not([hidden])');
    expect(visible).toHaveLength(1);
    expect(visible[0].getAttribute('data-model-id')).toBe(dangerousModel);
  });

  it('re-asserts display:none !important for hidden picker rows so the filter cannot be silently defeated', () => {
    // `.run-mode-option` carries its own `display: flex` (styles.css, restated in
    // mobile.css), which outranks the UA `[hidden]` rule: without this scoped
    // !important re-assertion, toggling `hidden` would change nothing on screen.
    const rule = STYLES_CSS.match(/#customModelPickModal \.run-mode-option\[hidden\]\s*\{[^}]*\}/);
    expect(rule, 'picker rows need a [hidden] rule scoped to #customModelPickModal').toBeTruthy();
    expect(rule![0]).toMatch(/display:\s*none\s*!important/);
  });

  it('pins "No models match" hidden with an empty query and shown only when a query hides every row, in CSS too', async () => {
    // The visible symptom: the line carries `.form-hint`, whose `display: block`
    // outranks the UA `[hidden]` rule, so `hidden` alone showed "No models match"
    // while every model was listed with an empty search box. The attribute half
    // was always right (session-ui.js's `filterCustomModelPick`); the CSS half
    // needed the same `[hidden] { display: none !important }` re-assertion the
    // rows above carry. This test pins both states AND the CSS that makes them
    // actually render.
    const rule = STYLES_CSS.match(/#customModelPickModal \.custom-model-pick-no-matches\[hidden\]\s*\{[^}]*\}/);
    expect(rule, 'the no-matches line needs a [hidden] rule scoped to #customModelPickModal').toBeTruthy();
    expect(rule![0]).toMatch(/display:\s*none\s*!important/);

    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3'] }],
    });
    win.app = app;
    await app.selectCustomModelEntry('claude', 'llama-box');
    const noMatches = win.document.getElementById('customModelPickNoMatches')!;

    // Empty query, models listed: the attribute must be set, and the CSS rule
    // above is what makes that attribute actually hide the line.
    expect(noMatches.hasAttribute('hidden')).toBe(true);

    // A non-empty query that hides every row: shown again.
    const search = win.document.getElementById('customModelPickSearch') as HTMLInputElement;
    search.value = 'ghost';
    search.dispatchEvent(new win.Event('input'));
    expect(noMatches.hasAttribute('hidden')).toBe(false);
  });
});

/**
 * The reported bug: a gateway such as Bifrost (40 models, alphabetical, no llama-swap
 * `/running` route of its own) showed "Choose a model" with nothing marked, so the user
 * could not tell which model the endpoint was actually serving, while the same endpoint
 * reached from the Codex CLI appeared to "default to alpha order" for every other CLI.
 * The endpoint genuinely cannot answer, so the app falls back to what it does know: a
 * live session it has itself pointed at that endpoint. And it says so plainly when it
 * knows neither.
 */
describe('Custom Model Endpoint Profiles: gateways without /running fall back to a live session', () => {
  const GATEWAY = {
    id: 'bifrost',
    label: 'bifrost',
    baseUrl: 'https://bifrost.example',
    models: ['llama-swap/alpha-3b', 'llama-swap/qwen3.8-flash-next-unsloth-ud-iq4_xs', 'llama-swap/zeta-70b'],
  };

  /** The gateway's exact shape: reachable, OpenAI-compatible, and not llama-swap. */
  function gatewayApp(sessions: Array<Record<string, unknown>>) {
    const booted = bootApp({ hosts: [GATEWAY], sessions });
    const origApiJson = booted.app._apiJson;
    booted.app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints/bifrost/running-status') return { isLlamaSwap: false, running: [] };
      return origApiJson(path);
    };
    return booted;
  }

  const live = (modelId: string, overrides: Record<string, unknown> = {}) => ({
    name: 'w9-Gateway',
    status: 'busy',
    pid: 4242,
    createdAt: 1_700_000_000_000,
    customModel: { endpointId: 'bifrost', modelId, label: 'bifrost' },
    ...overrides,
  });

  it('marks the model a live session is running, at the top, for EVERY CLI, not just claude', async () => {
    const inUse = 'llama-swap/qwen3.8-flash-next-unsloth-ud-iq4_xs';
    for (const mode of ['opencode', 'deepseek', 'codex', 'claude']) {
      const { win, app } = gatewayApp([live(inUse)]);
      await app._openCustomModelPickModal(mode, GATEWAY);
      const buttons = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')];
      expect(buttons).toHaveLength(3);
      expect(buttons[0].textContent, mode).toContain(inUse);
      expect(buttons[0].textContent, mode).toContain('In use by a session');
      // The other rows keep discovery order and carry no tag of their own.
      expect(buttons[1].textContent).toContain('llama-swap/alpha-3b');
      expect(buttons[2].querySelectorAll('.set-scope')).toHaveLength(0);
      // Nothing was fabricated about the endpoint itself.
      expect(win.document.getElementById('customModelPickList')!.textContent).not.toContain('Currently loaded');
      expect(win.document.getElementById('customModelPickUnknown')!.hasAttribute('hidden')).toBe(true);
    }
  });

  it('a live session outranks this device’s "last used" memory, and both rank above nothing', async () => {
    const { win, app } = gatewayApp([live('llama-swap/zeta-70b')]);
    win.localStorage.setItem('codeman:customModelLastUsed:opencode:bifrost', 'llama-swap/alpha-3b');

    await app._openCustomModelPickModal('opencode', GATEWAY);

    const buttons = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')];
    expect(buttons[0].textContent).toContain('llama-swap/zeta-70b');
    expect(buttons[0].textContent).toContain('In use by a session');
    expect(buttons[0].textContent).not.toContain('Last used');
    // The remembered pick is still listed, just not promoted or double-tagged.
    expect(buttons[1].textContent).toContain('llama-swap/alpha-3b');
    expect(buttons[1].querySelectorAll('.set-scope')).toHaveLength(0);
  });

  it('a stopped session, an exited process, an exited pane, another endpoint or an undiscovered model mark nothing', async () => {
    const inUse = 'llama-swap/qwen3.8-flash-next-unsloth-ud-iq4_xs';
    const cases: Array<[string, Record<string, unknown>]> = [
      ['stopped', { status: 'stopped' }],
      ['process exited (pid null)', { pid: null }],
      ['pane exited', { paneExit: { at: 1, status: 0 } }],
      ['other endpoint', { customModel: { endpointId: 'other', modelId: inUse } }],
      ['no custom model', { customModel: undefined }],
      ['undiscovered model', { customModel: { endpointId: 'bifrost', modelId: 'llama-swap/retired-model' } }],
    ];
    for (const [label, overrides] of cases) {
      const { win, app } = gatewayApp([live(inUse, overrides)]);
      await app._openCustomModelPickModal('opencode', GATEWAY);
      const list = win.document.getElementById('customModelPickList')!;
      expect(list.textContent, label).not.toContain('In use by a session');
      expect(list.textContent, label).not.toContain('Last used');
      // Discovery order untouched: nothing got dragged to the top.
      expect(list.querySelectorAll('button')![0].textContent).toContain('llama-swap/alpha-3b');
    }
  });

  it('the most recently launched live session wins when two share an endpoint', async () => {
    const { win, app } = gatewayApp([
      live('llama-swap/alpha-3b', { createdAt: 1 }),
      live('llama-swap/zeta-70b', { createdAt: 2 }),
    ]);

    await app._openCustomModelPickModal('opencode', GATEWAY);

    const buttons = [...win.document.getElementById('customModelPickList')!.querySelectorAll('button')];
    expect(buttons[0].textContent).toContain('llama-swap/zeta-70b');
    expect(buttons.filter((b) => b.textContent!.includes('In use by a session'))).toHaveLength(1);
  });

  it('says so plainly when nothing is known (a down endpoint answers the very same shape)', async () => {
    const { win, app } = gatewayApp([]);

    await app._openCustomModelPickModal('opencode', GATEWAY);

    const unknown = win.document.getElementById('customModelPickUnknown')!;
    expect(unknown.hasAttribute('hidden')).toBe(false);
    expect(unknown.textContent).toContain('did not report which model it has loaded');
    // What REALLY arrives here, not a fiction: `getLlamaSwapStatus` (custom-model-routes.ts)
    // turns EVERY upstream failure into `isLlamaSwap: false` (a gateway with no
    // `/running` route, a closed port, an unresolvable host, a 401), so this stub is
    // also exactly what a DOWN endpoint produces, which is why the line's wording says
    // only "did not report" and never why.
    // The same class-of-bug trap as the no-matches line: `.form-hint`'s `display: block`
    // outranks the UA `[hidden]` rule, so the attribute needs the CSS re-assertion.
    const rule = STYLES_CSS.match(/#customModelPickModal \.custom-model-pick-unknown\[hidden\]\s*\{[^}]*\}/);
    expect(rule, 'the unknown-endpoint line needs a [hidden] rule scoped to #customModelPickModal').toBeTruthy();
    expect(rule![0]).toMatch(/display:\s*none\s*!important/);
  });

  it('hides that line whenever a row IS marked, and for a probe that never got any answer', async () => {
    // Marked by a live session: nothing to explain.
    const marked = gatewayApp([live('llama-swap/alpha-3b')]);
    await marked.app._openCustomModelPickModal('opencode', GATEWAY);
    expect(marked.win.document.getElementById('customModelPickUnknown')!.hasAttribute('hidden')).toBe(true);

    // `null` (no answer at all) only happens when Codeman's OWN request to the route
    // failed or the client-side bound won the race. The route itself never answers this
    // way for an unreachable endpoint: every fetch failure arrives as `isLlamaSwap:
    // false`, pinned by the test above. The box may merely be asleep, so stay silent.
    const asleep = bootApp({ hosts: [GATEWAY] });
    asleep.app._apiJson = async (path: string) => (path.includes('running-status') ? null : []);
    await asleep.app._openCustomModelPickModal('opencode', GATEWAY);
    expect(asleep.win.document.getElementById('customModelPickUnknown')!.hasAttribute('hidden')).toBe(true);
  });

  it('llama-swap’s own answer still wins over a session pin, and keeps its own tag', async () => {
    const booted = bootApp({
      hosts: [GATEWAY],
      sessions: [live('llama-swap/alpha-3b')],
    });
    const origApiJson = booted.app._apiJson;
    booted.app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints/bifrost/running-status') {
        return { isLlamaSwap: true, running: [{ model: 'llama-swap/zeta-70b', state: 'ready' }] };
      }
      return origApiJson(path);
    };

    await booted.app._openCustomModelPickModal('opencode', GATEWAY);

    const buttons = [...booted.win.document.getElementById('customModelPickList')!.querySelectorAll('button')];
    expect(buttons[0].textContent).toContain('llama-swap/zeta-70b');
    expect(buttons[0].textContent).toContain('Currently loaded');
    expect(buttons[0].textContent).not.toContain('In use by a session');
    // The session's model is an ordinary row again: one promotion, not two.
    expect(buttons.filter((b) => b.querySelector('.set-scope'))).toHaveLength(1);
  });

  it('never trusts displayModel: a session whose terminal merely printed a model marks nothing', async () => {
    const booted = gatewayApp([
      { name: 'w9-Other', status: 'busy', createdAt: 1, displayModel: { model: 'llama-swap/zeta-70b', source: 'screen' } },
    ]);

    await booted.app._openCustomModelPickModal('opencode', GATEWAY);

    expect(booted.win.document.getElementById('customModelPickList')!.textContent).not.toContain('In use by a session');
  });
});

describe('Custom Model Endpoint Profiles: _getCustomModelRunningStatus is client-side bounded', () => {
  // `timeoutMs` driven in milliseconds rather than the real 800 — same reasoning as
  // `_watchLlamaSwapLoading`'s own `pollIntervalMs` a few describe blocks down: this
  // code runs inside the JSDOM window's own realm, whose setTimeout vi.useFakeTimers()
  // does not patch, so this is the only way to test the bound without actually waiting
  // on it (or, worse, hanging on a promise that deliberately never resolves).

  it('never lets an endpoint that never answers keep the picker waiting past the client-side bound', async () => {
    const { app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3'] }],
    });
    // A `running-status` probe that simply never resolves — the exact shape of an
    // endpoint that is asleep or firewalled, distinct from one that answers an error.
    app._apiJson = () => new Promise(() => {});

    const status = await app._getCustomModelRunningStatus({ id: 'llama-box', models: ['qwen3'] }, 5);

    // `null` means "no answer at all" (Codeman's own request failed or the client-side
    // bound won): the picker keeps its "Nothing is marked" line hidden for exactly this
    // case (pinned in the gateway describe above). An endpoint that is merely down is
    // NOT here: the route turns every fetch failure into `isLlamaSwap: false`.
    expect(status).toBeNull();
    expect(app._pickReadyRunningModel(status, { id: 'llama-box', models: ['qwen3'] })).toBeNull();
  });

  it('an endpoint that answers well within the bound is unaffected by it', async () => {
    const { app } = bootApp({});
    app._apiJson = async () => ({ isLlamaSwap: true, running: [{ model: 'qwen3', state: 'ready' }] });

    const status = await app._getCustomModelRunningStatus({ id: 'llama-box', models: ['qwen3'] }, 5);

    expect(app._pickReadyRunningModel(status, { id: 'llama-box', models: ['qwen3'] })).toBe('qwen3');
  });

  it('a rejected probe settles quietly to null rather than leaving an unhandled rejection once the timeout has already won the race', async () => {
    const { app } = bootApp({});
    app._apiJson = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('boom')), 10));

    const status = await app._getCustomModelRunningStatus({ id: 'llama-box', models: ['qwen3'] }, 2);
    expect(status).toBeNull();
    // Give the loser of the race a turn to actually reject and hit its own .catch —
    // an unswallowed rejection here would surface as an "Unhandled Errors" failure
    // for the whole test file, not a failed assertion in this test.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe('Custom Model Endpoint Profiles: applying a picked entry', () => {
  it('does not apply the endpoint to a session that was already open when the launch fails', async () => {
    const { app } = bootApp({});
    app.activeSessionId = 'already-open-session';
    // Simulate every run*() function's own documented behaviour: a declined or
    // failed launch handles its own error and returns normally without ever
    // changing activeSessionId — it does NOT throw and does NOT leave it null.
    app.run = async () => {};
    app._runInFlight = false;
    let applyCalled = false;
    app._api = async (path: string) => {
      if (path.includes('/custom-model')) applyCalled = true;
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(applyCalled).toBe(false);
    expect(app.activeSessionId).toBe('already-open-session');
  });

  it('applies the endpoint once run() actually produces a NEW active session', async () => {
    const { app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    const calls: Array<{ path: string; body: unknown }> = [];
    app._api = async (path: string, opts?: { body?: unknown }) => {
      calls.push({ path, body: opts?.body });
      return {
        ok: true,
        json: async () => ({ success: true, data: { customModel: { endpointId: 'llama-box' }, restarted: true } }),
      };
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/sessions/new-session/custom-model');
    expect(calls[0].body).toEqual({ endpointId: 'llama-box', modelId: 'qwen3' });
  });

  it('waits for the freshly launched session to go idle before applying, so its own boot activity is never mistaken for a busy turn', async () => {
    // Measured live: a just-launched CLI reports 'busy' for its own startup
    // (spinner, workspace-trust check) well before the apply call could
    // otherwise reach it, and the apply route's isBusy() guard correctly
    // refuses to restart a session mid-turn — which a fresh boot looks
    // exactly like from the outside. This pins the fix: wait for idle FIRST.
    const { app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    const calls: string[] = [];
    app._apiJson = async (path: string) => {
      calls.push(path);
      if (path === '/api/model-endpoints') return [];
      return null; // the wait call's return value is unused — a timeout is a normal 200
    };
    app._api = async (path: string) => {
      calls.push(path);
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    const waitIndex = calls.findIndex((p) => p.includes('/wait?'));
    const applyIndex = calls.findIndex((p) => p.endsWith('/custom-model'));
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(calls[waitIndex]).toBe('/api/sessions/new-session/wait?until=idle&timeout=20000');
    expect(applyIndex).toBeGreaterThan(waitIndex);
  });

  it('surfaces the real server error in the toast on a failed apply, rather than a generic message', async () => {
    const { app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    app._api = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: 'Custom model endpoints are not supported for remote (SSH) or Docker sessions yet',
      }),
    });
    let toastMessage: string | null = null;
    let toastType: string | null = null;
    app.showToast = (msg: string, type: string) => {
      toastMessage = msg;
      toastType = type;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(toastMessage).toContain('Custom model endpoints are not supported for remote (SSH) or Docker sessions yet');
    expect(toastType).toBe('error');
  });

  it('shows a status toast for the native-boot-then-restart window, so it never reads as the endpoint failing to apply', async () => {
    // Claude still goes through this two-step launch (see runCustomModelEntry's own
    // comment for why) — without something saying so, the native boot it starts with
    // (which can genuinely talk to the cloud model for a moment) reads as "the
    // endpoint didn't apply" rather than "the switch hasn't happened yet".
    const { app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    app._api = async () => ({
      ok: true,
      json: async () => ({ success: true, data: { customModel: { endpointId: 'llama-box' }, restarted: true } }),
    });
    const banners: Array<{ message: string; dismissed: boolean }> = [];
    const messageHistory: string[] = [];
    app._showCenterStatus = (message: string) => {
      const entry = { message, dismissed: false };
      banners.push(entry);
      messageHistory.push(message);
      return {
        dismiss: () => {
          entry.dismissed = true;
        },
        setMessage: (next: string) => {
          entry.message = next;
          messageHistory.push(next);
        },
      };
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(banners).toHaveLength(1); // updated in place, not stacked with a second banner
    expect(messageHistory[0]).toContain('Claude started — switching to llama-box');
    expect(messageHistory.at(-1)).toContain('Pointed at llama-box — restarting');
  });

  it('dismisses the status banner on a failed apply rather than leaving it stuck on "switching"', async () => {
    const { app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    app._api = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: 'boom' }),
    });
    let bannerDismissed = false;
    app._showCenterStatus = () => ({
      dismiss: () => {
        bannerDismissed = true;
      },
      setMessage: () => {},
    });
    let toastMessage: string | undefined;
    app.showToast = (message: string) => {
      toastMessage = message;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(bannerDismissed).toBe(true); // the "switching..." banner, cleaned up
    expect(toastMessage).toContain('boom'); // the error toast, separate from it
  });

  it('routes through run() itself, so the Run in-flight lock actually engages', async () => {
    // src/web/CLAUDE.md, Run launch synchronization: the lock exists so a double click
    // cannot create duplicate sessions. A hardcoded dispatch table bypassing
    // run() would never set _runInFlight, which is what this pins.
    const { app } = bootApp({});
    let sawInFlight = false;
    app.run = async function (this: typeof app) {
      if (this._runInFlight) return;
      this._runInFlight = true;
      sawInFlight = true;
      this._runInFlight = false;
    };
    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');
    expect(sawInFlight).toBe(true);
  });

  it('restores the previous _runMode after a one-off custom-model launch, never persisting it', async () => {
    const { app } = bootApp({});
    app._runMode = 'opencode';
    let modeDuringRun: string | undefined;
    app.run = async function (this: typeof app) {
      modeDuringRun = this._runMode;
    };
    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');
    expect(modeDuringRun).toBe('claude');
    expect(app._runMode).toBe('opencode');
  });
});

describe('Custom Model Endpoint Profiles: llama-swap model-swap confirmation and loading state', () => {
  function launchHarness(applyResponses: Array<Record<string, unknown>>) {
    const { win, app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    const applyBodies: unknown[] = [];
    let call = 0;
    app._api = async (path: string, opts?: { body?: unknown }) => {
      if (path.endsWith('/custom-model')) {
        applyBodies.push(opts?.body);
        const data = applyResponses[Math.min(call, applyResponses.length - 1)];
        call += 1;
        return { ok: true, status: 200, json: async () => ({ success: true, data }) };
      }
      throw new Error(`unexpected _api call: ${path}`);
    };
    return { win, app, applyBodies };
  }

  it('confirming the in-app swap-confirm modal re-sends the apply with confirmed:true', async () => {
    const { app, applyBodies } = launchHarness([
      {
        requiresConfirmation: true,
        currentlyLoadedModel: 'llama3',
        affectedSessions: [{ id: 's2', name: 'w2-otherbox' }],
      },
      { customModel: { endpointId: 'llama-box' }, restarted: true, modelSwapInProgress: true },
    ]);
    let confirmMessage: string | undefined;
    app._confirmModelSwap = async (message: string) => {
      confirmMessage = message;
      return true;
    };
    app._watchLlamaSwapLoading = async () => {}; // not under test here

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(confirmMessage).toContain('w2-otherbox');
    expect(confirmMessage).toContain('llama3');
    expect(confirmMessage).toContain('qwen3');
    expect(applyBodies).toEqual([
      { endpointId: 'llama-box', modelId: 'qwen3' },
      { endpointId: 'llama-box', modelId: 'qwen3', confirmedSwap: true },
    ]);
  });

  it('cancelling the in-app swap-confirm modal keeps the native backend and never re-sends the apply', async () => {
    const { app, applyBodies } = launchHarness([
      { requiresConfirmation: true, currentlyLoadedModel: 'llama3', affectedSessions: [{ id: 's2', name: 'w2' }] },
    ]);
    app._confirmModelSwap = async () => false;
    let toastMessage: string | undefined;
    app.showToast = (msg: string) => {
      toastMessage = msg;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(applyBodies).toHaveLength(1); // no second (confirmed) call
    expect(toastMessage).toMatch(/cancelled/i);
  });

  it('a successful apply with modelSwapInProgress kicks off the loading watcher', async () => {
    const { app } = launchHarness([
      { customModel: { endpointId: 'llama-box' }, restarted: true, modelSwapInProgress: true },
    ]);
    let watched: unknown[] | null = null;
    app._watchLlamaSwapLoading = async (...args: unknown[]) => {
      watched = args;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(watched).toEqual(['llama-box', 'qwen3', 'new-session']);
  });

  it('a successful apply with no swap needed never starts the loading watcher', async () => {
    const { app } = launchHarness([
      { customModel: { endpointId: 'llama-box' }, restarted: true, modelSwapInProgress: false },
    ]);
    let watchCalled = false;
    app._watchLlamaSwapLoading = async () => {
      watchCalled = true;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(watchCalled).toBe(false);
  });
});

describe('Custom Model Endpoint Profiles: _watchLlamaSwapLoading polling', () => {
  // Driven with millisecond intervals (the function's own pollIntervalMs/maxWaitMs
  // params — real callers never pass them) rather than fake timers: this code runs
  // inside the JSDOM window's own realm (bootApp's `runScripts: "dangerously"` eval),
  // whose setTimeout is NOT the one vi.useFakeTimers() patches, so advancing fake
  // timers here would advance nothing and either hang or silently no-op.

  it('dismisses the loading banner as soon as the target model reports ready', async () => {
    const { app } = bootApp({});
    const bannerMessages: string[] = [];
    const dismissed: string[] = [];
    app._showCenterStatus = (message: string) => {
      bannerMessages.push(message);
      return { dismiss: () => dismissed.push(message), setMessage: () => {} };
    };
    const toastCalls: string[] = [];
    app.showToast = (message: string) => {
      toastCalls.push(message);
    };
    app._apiJson = async () => ({ isLlamaSwap: true, running: [{ model: 'qwen3', state: 'ready' }] });

    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 'sess-1', 5);

    expect(bannerMessages[0]).toMatch(/loading qwen3/i);
    expect(dismissed).toContain(bannerMessages[0]);
    expect(toastCalls.at(-1)).toMatch(/ready/i);
  });

  it('adds a second line with the real llama.cpp log line once one is available, stripped of the bootlog prefix', async () => {
    const { app } = bootApp({});
    const bannerMessages: string[] = [];
    app._showCenterStatus = (message: string) => {
      bannerMessages.push(message);
      return { dismiss: () => {}, setMessage: (next: string) => bannerMessages.push(next) };
    };
    app.showToast = () => {};
    let statusCalls = 0;
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints') return null; // size lookup — unrelated to this test
      statusCalls += 1;
      if (statusCalls === 1) {
        return {
          isLlamaSwap: true,
          running: [{ model: 'qwen3', state: 'starting' }],
          logLine: '0.31.428.568 I srv  llama_server: model loaded',
        };
      }
      return { isLlamaSwap: true, running: [{ model: 'qwen3', state: 'ready' }] };
    };

    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 'sess-1', 5);

    // First render (before any poll has landed) has no log line at all.
    expect(bannerMessages[0]).not.toMatch(/llama\.cpp:/);
    // Second render carries the log line, bootlog prefix (timestamp/level/component) stripped.
    const withLogLine = bannerMessages.find((m) => m.includes('llama.cpp:'));
    expect(withLogLine).toContain('llama.cpp: llama_server: model loaded');
    expect(withLogLine).not.toContain('0.31.428.568');
    expect(withLogLine).not.toContain(' I srv');
  });

  it('shows no second line at all when the endpoint has no logLine to offer', async () => {
    const { app } = bootApp({});
    const bannerMessages: string[] = [];
    app._showCenterStatus = (message: string) => {
      bannerMessages.push(message);
      return { dismiss: () => {}, setMessage: (next: string) => bannerMessages.push(next) };
    };
    app.showToast = () => {};
    app._apiJson = async () => ({ isLlamaSwap: true, running: [{ model: 'qwen3', state: 'ready' }] });

    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 'sess-1', 5);

    expect(bannerMessages.some((m) => m.includes('llama.cpp:'))).toBe(false);
  });

  it('is unbounded — never gives up on its own, even after many polls with no ready model', async () => {
    // No countdown, no timeout: confirms the loop just keeps polling rather than
    // eventually erroring out on its own after some fixed number of checks.
    const { app } = bootApp({});
    app._showCenterStatus = () => ({ dismiss: () => {}, setMessage: () => {} });
    app.showToast = () => {};
    let calls = 0;
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints') return null;
      calls += 1;
      if (calls >= 20) return { isLlamaSwap: true, running: [{ model: 'qwen3', state: 'ready' }] };
      return { isLlamaSwap: true, running: [{ model: 'something-else', state: 'ready' }] };
    };

    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 'sess-1', 1);

    expect(calls).toBe(20); // it really did keep polling past what the old bounded wait allowed
  });

  it('clicking Cancel on the banner dismisses it, shows an info toast (not an error), and closes the session', async () => {
    const { app } = bootApp({});
    let onCancel: (() => void) | undefined;
    let dismissed = false;
    app._showCenterStatus = (_message: string, opts?: { onCancel?: () => void }) => {
      onCancel = opts?.onCancel;
      return { dismiss: () => (dismissed = true), setMessage: () => {} };
    };
    const toastCalls: Array<{ message: string; type: string }> = [];
    app.showToast = (message: string, type = 'info') => {
      toastCalls.push({ message, type });
    };
    let closedSessionId: string | undefined;
    app.closeSession = async (id: string) => {
      closedSessionId = id;
    };
    app._apiJson = async () => ({ isLlamaSwap: true, running: [{ model: 'something-else', state: 'ready' }] });

    const watch = app._watchLlamaSwapLoading('llama-box', 'qwen3', 'sess-1', 5);
    // Give the loop a couple of ticks to actually be polling, then cancel it — a real
    // click happens whenever the user gets around to it, not on the very first render.
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(onCancel).toBeTypeOf('function');
    onCancel!();
    await watch;

    expect(dismissed).toBe(true);
    const cancelToast = toastCalls.find((t) => /cancelled/i.test(t.message));
    expect(cancelToast?.type).toBe('info'); // not 'error' — this was deliberate, not a failure
    expect(cancelToast?.message).toMatch(/session has been closed/i);
    expect(closedSessionId).toBe('sess-1');
  });

  it('never closes anything when no sessionId was given (a caller that has none to close)', async () => {
    const { app } = bootApp({});
    let onCancel: (() => void) | undefined;
    app._showCenterStatus = (_message: string, opts?: { onCancel?: () => void }) => {
      onCancel = opts?.onCancel;
      return { dismiss: () => {}, setMessage: () => {} };
    };
    app.showToast = () => {};
    let closeCalled = false;
    app.closeSession = async () => {
      closeCalled = true;
    };
    app._apiJson = async () => ({ isLlamaSwap: true, running: [{ model: 'something-else', state: 'ready' }] });

    const watch = app._watchLlamaSwapLoading('llama-box', 'qwen3', undefined, 5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    onCancel!();
    await watch;

    expect(closeCalled).toBe(false);
  });

  it('stops polling (without a warning) once the endpoint no longer reads as llama-swap', async () => {
    const { app } = bootApp({});
    let bannerDismissed = false;
    app._showCenterStatus = () => ({
      dismiss: () => {
        bannerDismissed = true;
      },
      setMessage: () => {},
    });
    const toastCalls: string[] = [];
    app.showToast = (message: string) => {
      toastCalls.push(message);
    };
    app._apiJson = async () => ({ isLlamaSwap: false, running: [] });

    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 'sess-1', 5);

    expect(bannerDismissed).toBe(true);
    expect(toastCalls).toHaveLength(0); // no follow-up warning toast
  });

  it('keeps waiting through a transient status-fetch failure instead of giving up early', async () => {
    const { app } = bootApp({});
    app._showCenterStatus = () => ({ dismiss: () => {}, setMessage: () => {} });
    const toastCalls: string[] = [];
    app.showToast = (message: string) => {
      toastCalls.push(message);
    };
    let call = 0;
    app._apiJson = async () => {
      call += 1;
      if (call === 1) return null; // transient failure
      return { isLlamaSwap: true, running: [{ model: 'qwen3', state: 'ready' }] };
    };

    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 'sess-1', 5);

    expect(toastCalls.at(-1)).toMatch(/ready/i);
  });

  it('checks immediately rather than waiting a full interval before the first check', async () => {
    // A model that is already ready by the time this runs (a fast load, or a re-apply
    // onto one that was already loaded) shouldn't sit on "Loading..." for a whole
    // pollIntervalMs before saying so.
    const { app } = bootApp({});
    app._showCenterStatus = () => ({ dismiss: () => {}, setMessage: () => {} });
    let calls = 0;
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints') return []; // size lookup — no match, no estimate
      calls += 1;
      return { isLlamaSwap: true, running: [{ model: 'qwen3', state: 'ready' }] };
    };

    // A huge interval that would time the test out if the function actually waited for
    // it before the first check.
    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 'sess-1', 60000);

    expect(calls).toBe(1);
  });

  it('a newer call takes over the shared banner — a superseded older call never touches it', async () => {
    const { app } = bootApp({});
    const dismissCalls: string[] = [];
    app._showCenterStatus = (message: string) => ({
      dismiss: () => dismissCalls.push(message),
      setMessage: () => {},
    });
    app.showToast = () => {};
    // The FIRST call never sees its own target model ready — left alone (unbounded, no
    // timeout) it would poll forever, but being superseded below must still make it stop
    // on its own very next isCurrent() check rather than needing a timeout to exit.
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints') return [];
      return { isLlamaSwap: true, running: [] };
    };
    const firstCall = app._watchLlamaSwapLoading('llama-box', 'model-a', undefined, 5);

    // Second call, for a DIFFERENT model that IS ready right away, takes over the banner.
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints') return [];
      return { isLlamaSwap: true, running: [{ model: 'model-b', state: 'ready' }] };
    };
    await app._watchLlamaSwapLoading('llama-box', 'model-b', undefined, 5);

    // Let the stale first call notice it's been superseded and return on its own.
    await firstCall;

    // Whatever the first call did or didn't show along the way, being superseded must
    // never touch a banner state that belongs to the newer, still-current call — exactly
    // one dismiss, for model-b, is the tell.
    expect(dismissCalls).toHaveLength(1);
    expect(dismissCalls[0]).toContain('model-b');
  });
});

describe('Custom Model Endpoint Profiles: model size lookup (no time estimate — see the unbounded-wait describe above)', () => {
  it('_lookupModelSizeGB reads the size off the matching endpoint/model, ignoring one with no parseable size', async () => {
    const { app } = bootApp({});
    app._apiJson = async (path: string) => {
      expect(path).toBe('/api/model-endpoints');
      return [
        { id: 'llama-box', modelSizesGB: { 'qwen3.8-27b-ud-q4_k_xl': 16.35, big: undefined } },
        { id: 'other-box', modelSizesGB: { 'qwen3.8-27b-ud-q4_k_xl': 999 } }, // must not match wrong endpoint
      ];
    };

    expect(await app._lookupModelSizeGB('llama-box', 'qwen3.8-27b-ud-q4_k_xl')).toBe(16.35);
    expect(await app._lookupModelSizeGB('llama-box', 'big')).toBeUndefined(); // no parseable size
    expect(await app._lookupModelSizeGB('llama-box', 'unknown-model')).toBeUndefined();
    expect(await app._lookupModelSizeGB('ghost-endpoint', 'qwen3')).toBeUndefined();
  });

  it('_lookupModelSizeGB is best-effort: an unreachable/malformed response yields undefined, never a throw', async () => {
    const { app } = bootApp({});
    app._apiJson = async () => {
      throw new Error('network down');
    };
    await expect(app._lookupModelSizeGB('llama-box', 'qwen3')).resolves.toBeUndefined();

    app._apiJson = async () => null; // e.g. a failed request _apiJson already swallowed
    await expect(app._lookupModelSizeGB('llama-box', 'qwen3')).resolves.toBeUndefined();
  });

  it('the loading banner includes the size, and the generic hardware/model-size disclaimer, when the size is known', async () => {
    const { app } = bootApp({});
    const bannerMessages: string[] = [];
    app._showCenterStatus = (message: string) => {
      bannerMessages.push(message);
      return { dismiss: () => {}, setMessage: () => {} };
    };
    app.showToast = () => {};
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints') {
        return [{ id: 'llama-box', modelSizesGB: { 'qwen3.8-27b-ud-q4_k_xl': 16.35 } }];
      }
      return { isLlamaSwap: true, running: [{ model: 'qwen3.8-27b-ud-q4_k_xl', state: 'ready' }] };
    };

    await app._watchLlamaSwapLoading('llama-box', 'qwen3.8-27b-ud-q4_k_xl', undefined, 5);

    expect(bannerMessages[0]).toBe(
      'Loading qwen3.8-27b-ud-q4_k_xl (16.4 GB) on llama-box — this can take a while depending on your hardware and the model size.'
    );
  });

  it('the loading banner omits the size but keeps the disclaimer when the size is unknown', async () => {
    const { app } = bootApp({});
    const bannerMessages: string[] = [];
    app._showCenterStatus = (message: string) => {
      bannerMessages.push(message);
      return { dismiss: () => {}, setMessage: () => {} };
    };
    app.showToast = () => {};
    app._apiJson = async (path: string) => {
      if (path === '/api/model-endpoints') return [{ id: 'llama-box', modelSizesGB: {} }];
      return { isLlamaSwap: true, running: [{ model: 'big', state: 'ready' }] };
    };

    await app._watchLlamaSwapLoading('llama-box', 'big', undefined, 5);

    expect(bannerMessages[0]).toBe(
      'Loading big on llama-box — this can take a while depending on your hardware and the model size.'
    );
  });
});

describe('Custom Model Endpoint Profiles: _showCenterStatus Cancel button (real DOM, not the stub)', () => {
  it('renders a real, clickable Cancel button when onCancel is given, and wires it up', () => {
    const { win, app } = bootAppWithRealCenterStatus();
    let cancelled = false;

    app._showCenterStatus('Loading qwen3 on llama-box…', { onCancel: () => (cancelled = true) });

    const btn = win.document.querySelector('.center-status-cancel') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Cancel');
    btn!.onclick!(new (win as any).Event('click'));
    expect(cancelled).toBe(true);
  });

  it('renders no Cancel button at all when onCancel is not given', () => {
    const { win, app } = bootAppWithRealCenterStatus();

    app._showCenterStatus('Loading qwen3 on llama-box…');

    expect(win.document.querySelector('.center-status-cancel')).toBeNull();
  });

  it("an 'error' banner keeps its own × close button rather than growing a redundant Cancel, even if onCancel is passed", () => {
    const { win, app } = bootAppWithRealCenterStatus();

    app._showCenterStatus('Something went wrong', { type: 'error', onCancel: () => {} });

    expect(win.document.querySelector('.center-status-close')).not.toBeNull();
    expect(win.document.querySelector('.center-status-cancel')).toBeNull();
  });

  it('reopening within the 200ms fade cancels the previous dismiss(), so the fresh banner is not hidden out from under it', () => {
    // The real bug: dismiss() schedules el.hidden = true 200ms later with nothing
    // to cancel it. _runCustomModelEntryViaRestart calls switchingToast.dismiss()
    // then awaits one same-origin request (5-30ms locally) before reopening the
    // banner for the model-load wait — well inside that 200ms window — so the
    // stale timer fired against the shared DOM node and hid the fresh banner.
    vi.useFakeTimers();
    try {
      const { win, app } = bootAppWithRealCenterStatus();
      const first = app._showCenterStatus('Claude started — switching to llama-swap…');
      first.dismiss();
      vi.advanceTimersByTime(20);
      app._showCenterStatus('Loading qwen3 on llama-box…');
      vi.advanceTimersByTime(280);

      const el = win.document.getElementById('customModelCenterStatus') as HTMLElement;
      expect(el.hidden).toBe(false);
      expect(el.textContent).toContain('Loading qwen3 on llama-box…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-asserts [hidden] over the flex display, so dismiss() actually hides it', () => {
    // .center-status-banner is display:flex, which defeats the `hidden` attribute —
    // dismiss()'s only visibility lever — unless this rule exists: without it the card
    // stays laid out at opacity:0 with its text/cancel/close children still
    // pointer-events:auto, an invisible click-blocker dead centre over the terminal
    // until the page reloads. Same trap as .home-sessions[hidden], see home-sessions.test.ts.
    const css = readFileSync(new URL('../src/web/public/styles.css', import.meta.url), 'utf-8');
    expect(css).toMatch(/\.center-status-banner\[hidden\]\s*\{\s*display:\s*none;/);
  });
});

describe("Custom Model Endpoint Profiles: requiresContextWarning (this CLI's own overhead can exceed a small model's real context)", () => {
  function launchHarness(applyResponses: Array<Record<string, unknown>>) {
    const { win, app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    const applyBodies: unknown[] = [];
    let call = 0;
    app._api = async (path: string, opts?: { body?: unknown }) => {
      if (path.endsWith('/custom-model')) {
        applyBodies.push(opts?.body);
        const data = applyResponses[Math.min(call, applyResponses.length - 1)];
        call += 1;
        return { ok: true, status: 200, json: async () => ({ success: true, data }) };
      }
      throw new Error(`unexpected _api call: ${path}`);
    };
    return { win, app, applyBodies };
  }

  it('confirming the in-app context-warning modal re-sends the apply with confirmed:true, and only THEN records "last used"', async () => {
    const { win, app, applyBodies } = launchHarness([
      { requiresContextWarning: true, modelId: 'qwen3', contextLength: 16384, minSafeContextTokens: 40000 },
      { customModel: { endpointId: 'llama-box' }, restarted: true, modelSwapInProgress: false },
    ]);
    let confirmArgs: unknown[] | undefined;
    app._confirmContextWarning = async (...args: unknown[]) => {
      confirmArgs = args;
      return true;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(confirmArgs).toEqual(['qwen3', 16384, 40000, undefined]);
    expect(applyBodies).toEqual([
      { endpointId: 'llama-box', modelId: 'qwen3' },
      { endpointId: 'llama-box', modelId: 'qwen3', confirmedContext: true },
    ]);
    expect(win.localStorage.getItem('codeman:customModelLastUsed:claude:llama-box')).toBe('qwen3');
  });

  it('forwards the slot count from the apply response into the modal', async () => {
    const { app, applyBodies } = launchHarness([
      {
        requiresContextWarning: true,
        modelId: 'qwen3',
        contextLength: 131072,
        minSafeContextTokens: 40000,
        slotCount: 4,
      },
      { customModel: { endpointId: 'llama-box' }, restarted: true, modelSwapInProgress: false },
    ]);
    let confirmArgs: unknown[] | undefined;
    app._confirmContextWarning = async (...args: unknown[]) => {
      confirmArgs = args;
      return true;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(confirmArgs).toEqual(['qwen3', 131072, 40000, 4]);
    expect(applyBodies).toHaveLength(2);
  });

  it('declining the in-app context-warning modal keeps the native backend, never re-sends the apply, and must NEVER record this model as "last used" — it cannot work with this CLI at all', async () => {
    const { win, app, applyBodies } = launchHarness([
      { requiresContextWarning: true, modelId: 'qwen3', contextLength: 16384, minSafeContextTokens: 40000 },
    ]);
    app._confirmContextWarning = async () => false;
    let toastMessage: string | undefined;
    app.showToast = (msg: string) => {
      toastMessage = msg;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(applyBodies).toHaveLength(1); // no second (confirmed) call
    expect(toastMessage).toMatch(/context window too small/i);
    expect(win.localStorage.getItem('codeman:customModelLastUsed:claude:llama-box')).toBeNull();
  });
});

describe('Custom Model Endpoint Profiles: _confirmModelSwap (in-app modal, replaces a native confirm() popup)', () => {
  it('shows the message, activates the modal, and resolves true when "Switch anyway" is clicked', async () => {
    const { win, app } = bootApp({});
    const promise = app._confirmModelSwap('w2 is using llama3. Switch anyway?');

    const modal = win.document.getElementById('customModelSwapConfirmModal')!;
    expect(modal.classList.contains('active')).toBe(true);
    expect(win.document.getElementById('customModelSwapConfirmMessage')!.textContent).toBe(
      'w2 is using llama3. Switch anyway?'
    );

    app._resolveModelSwapConfirm(true);

    expect(await promise).toBe(true);
    expect(modal.classList.contains('active')).toBe(false);
  });

  it('resolves false when Cancel (or the backdrop) is clicked, without ever showing a browser confirm() popup', async () => {
    const { win, app } = bootApp({});
    const promise = app._confirmModelSwap('w2 is using llama3. Switch anyway?');
    app._resolveModelSwapConfirm(false);
    expect(await promise).toBe(false);
    expect(win.document.getElementById('customModelSwapConfirmModal')!.classList.contains('active')).toBe(false);
  });
});

describe('Custom Model Endpoint Profiles: _confirmContextWarning (in-app modal, native backend never restarted while it is up)', () => {
  it('shows a message naming the model, the discovered context and the safe floor, activates the modal, and resolves true on "Launch anyway"', async () => {
    const { win, app } = bootApp({});
    const promise = app._confirmContextWarning('qwen3.8-27b-ud-q4_k_xl', 16384, 40000);

    const modal = win.document.getElementById('customModelContextWarningModal')!;
    expect(modal.classList.contains('active')).toBe(true);
    const message = win.document.getElementById('customModelContextWarningMessage')!.textContent!;
    expect(message).toContain('qwen3.8-27b-ud-q4_k_xl');
    expect(message).toContain((16384).toLocaleString()); // the modal formats for the user's locale
    expect(message).toContain((40000).toLocaleString());
    expect(message).toMatch(/llama-swap/i);
    expect(message).toMatch(/fit-ctx/i);

    app._resolveContextWarningConfirm(true);

    expect(await promise).toBe(true);
    expect(modal.classList.contains('active')).toBe(false);
  });

  it('resolves false when Cancel is clicked', async () => {
    const { win, app } = bootApp({});
    const promise = app._confirmContextWarning('qwen3', 16384, 40000);
    app._resolveContextWarningConfirm(false);
    expect(await promise).toBe(false);
    expect(win.document.getElementById('customModelContextWarningModal')!.classList.contains('active')).toBe(false);
  });

  it('explains shared parallel slots, and the --parallel 1 fix, when the context is enough only as a whole', async () => {
    const { win, app } = bootApp({});
    void app._confirmContextWarning('qwen3.8-27b-ud-q4_k_xl', 131072, 40000, 4);
    const message = win.document.getElementById('customModelContextWarningMessage')!.textContent!;
    expect(message).toContain('qwen3.8-27b-ud-q4_k_xl');
    expect(message).toContain('4 parallel');
    expect(message).toContain(num(131072));
    expect(message).toContain(num(32768)); // per slot
    expect(message).toContain('--parallel 1');
    expect(message).toContain('Context size has been exceeded');
    // this is not the "first message fails outright" case, so it must not claim that
    expect(message).not.toMatch(/first message will fail/i);
    expect(win.document.getElementById('customModelContextWarningModal')!.classList.contains('active')).toBe(true);
    app._resolveContextWarningConfirm(false);
  });

  it('says the context is split across the slots, about N each, from the discovered context alone', async () => {
    const { win, app } = bootApp({});
    void app._confirmContextWarning('qwen3', 65536, 40000, 4);
    const message = win.document.getElementById('customModelContextWarningMessage')!.textContent!;
    expect(message).toContain(
      `${num(65536)} tokens of context are split across 4 parallel server slots, about ${num(16384)} each`
    );
    app._resolveContextWarningConfirm(false);
  });

  it('keeps the too-small-context message for a small model and adds the slot advice when slots are known', async () => {
    const { win, app } = bootApp({});
    void app._confirmContextWarning('qwen3', 16384, 40000, 4);
    const message = win.document.getElementById('customModelContextWarningMessage')!.textContent!;
    expect(message).toContain(num(16384));
    expect(message).toMatch(/first message will fail/i);
    expect(message).toContain('4 parallel slots');
    expect(message).toContain('--parallel 1');
    app._resolveContextWarningConfirm(false);
  });

  it('does not mention slots when there is one (or none known)', async () => {
    const { win, app } = bootApp({});
    void app._confirmContextWarning('qwen3', 16384, 40000, 1);
    const message = win.document.getElementById('customModelContextWarningMessage')!.textContent!;
    expect(message).not.toMatch(/parallel/i);
    app._resolveContextWarningConfirm(false);
  });

  it('describes an unknown context length without printing a bogus number', async () => {
    const { win, app } = bootApp({});
    void app._confirmContextWarning('qwen3', undefined, 40000);
    const message = win.document.getElementById('customModelContextWarningMessage')!.textContent!;
    expect(message).not.toMatch(/undefined/);
    expect(message).toMatch(/unknown/i);
    app._resolveContextWarningConfirm(false);
  });
});
