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
import { describe, expect, it } from 'vitest';

const CONSTANTS_JS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const SESSION_UI_JS = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');

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
  app.showToast = () => {};
  // _apiJson unwraps the {success,data} envelope for real against a live
  // server; here it stands in for that, driven from a fixed `hosts` fixture
  // so these tests exercise the picker's OWN code, not the envelope helper.
  app._apiJson = async (path: string) => {
    if (path === '/api/model-endpoints') return options.hosts ?? [];
    return null;
  };
  return { dom, win, app };
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
    const realApiJson = app._apiJson.bind(app);
    app._apiJson = async (path: string, opts?: unknown) => {
      if (path.includes('/custom-model')) applyCalled = true;
      return realApiJson(path, opts as never);
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
    app._apiJson = async (path: string, opts?: { body?: unknown }) => {
      calls.push({ path, body: opts?.body });
      return { customModel: { endpointId: 'llama-box' }, restarted: true };
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/sessions/new-session/custom-model');
    expect(calls[0].body).toEqual({ endpointId: 'llama-box', modelId: 'qwen3' });
  });

  it('routes through run() itself, so the Run in-flight lock actually engages', async () => {
    // CLAUDE.md, Run launch synchronization: the lock exists so a double click
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
