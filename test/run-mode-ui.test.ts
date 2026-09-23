/**
 * @fileoverview Unit tests for the Codex run-mode UI surface in session-ui.js /
 * settings-ui.js / index.html. Loads the browser modules into a vm sandbox (no
 * real DOM) and exercises run-mode selection + Codex quick-start wiring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadRunModeHarness() {
  const elements: Record<string, any> = {};
  const storage = new Map<string, string>();
  const CodemanApp = function CodemanApp(this: any) {};

  const context = vm.createContext({
    CodemanApp,
    VoiceInput: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
    },
    console,
  });

  const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
  const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
  vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });
  vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

  const runModeMenu = { classList: { remove: () => {} } };
  const gearBtn = { className: '' };
  const runBtn = { className: '', nextElementSibling: gearBtn };
  const runBtnLabel = { textContent: '' };
  elements.runModeMenu = runModeMenu;
  elements.runBtn = runBtn;
  elements.runBtnLabel = runBtnLabel;

  const app = new (CodemanApp as any)();
  app.loadAppSettingsFromStorage = () => ({});
  app.saveAppSettingsToStorage = () => {};
  app._apiPut = () => Promise.resolve();

  return { app, storage, runBtnLabel };
}

describe('run mode UI', () => {
  it('updates the visible mode when selecting Claude after server sync set Codex', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'codex' }));
    expect(app.runMode).toBe('codex');
    expect(runBtnLabel.textContent).toBe('Run CX');

    app.setRunMode('claude');

    expect(app.runMode).toBe('claude');
    expect(runBtnLabel.textContent).toBe('Run');
  });

  it('accepts Gemini mode from server sync and updates the run button label', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'gemini' }));

    expect(app.runMode).toBe('gemini');
    expect(runBtnLabel.textContent).toBe('Run GM');
  });

  it('accepts Antigravity mode from server sync and updates the run button label', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'antigravity' }));

    expect(app.runMode).toBe('antigravity');
    expect(runBtnLabel.textContent).toBe('Run AG');
  });

  it('accepts OMP mode from server sync and updates the run button label', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'omp' }));

    expect(app.runMode).toBe('omp');
    expect(runBtnLabel.textContent).toBe('Run OMP');
  });
});

describe('Run launch synchronization', () => {
  it('keeps launch progress out of an active session terminal', () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.activeSessionId = 'existing-session';
    app.terminal = {
      clear: vi.fn(),
      writeln: vi.fn(),
    };
    app.showToast = vi.fn();

    const ownsTerminal = app._beginSessionLaunchStatus('Starting Codex session', '1;32');
    app._appendSessionLaunchStatus(ownsTerminal, 'Creating session');
    app._reportSessionLaunchError(ownsTerminal, 'Launch failed');

    expect(ownsTerminal).toBe(false);
    expect(app.terminal.clear).not.toHaveBeenCalled();
    expect(app.terminal.writeln).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenNthCalledWith(1, 'Starting Codex session', 'info');
    expect(app.showToast).toHaveBeenNthCalledWith(2, 'Launch failed', 'error');
  });

  it('still renders launch progress in the terminal on the session-less home screen', () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.activeSessionId = null; // home screen: nothing else owns the terminal
    app.terminal = { clear: vi.fn(), writeln: vi.fn() };
    app.showToast = vi.fn();

    const ownsTerminal = app._beginSessionLaunchStatus('Starting Codex session', '1;32');
    app._appendSessionLaunchStatus(ownsTerminal, 'Creating session');
    app._reportSessionLaunchError(ownsTerminal, 'Launch failed');

    expect(ownsTerminal).toBe(true);
    expect(app.terminal.clear).toHaveBeenCalledTimes(1);
    expect(app.terminal.writeln.mock.calls.map((c: string[]) => c[0]).join('\n')).toContain('Starting Codex session');
    expect(app.terminal.writeln.mock.calls.map((c: string[]) => c[0]).join('\n')).toContain('Creating session');
    expect(app.terminal.writeln.mock.calls.map((c: string[]) => c[0]).join('\n')).toContain('Error: Launch failed');
    expect(app.showToast).not.toHaveBeenCalled();
  });

  /**
   * Static guard over session-ui.js itself. The helpers above can be perfectly
   * correct while a run*() entry point still writes to the shared xterm
   * directly, which is the actual bug: a launch started while another session
   * is active wipes that session's terminal, and _cleanupPreviousSession()
   * then serializes the wiped view into its restore snapshot. Asserting on the
   * helpers alone cannot see that, so pin the call sites here. This also
   * covers run modes added later, which is how runAntigravity was caught.
   */
  it('routes every run mode through the ownership helpers, never the terminal directly', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');

    // Methods live in one Object.assign(prototype, {...}) block at a fixed
    // 2-space indent, so `\n  },` reliably closes the one we are inside.
    //
    // `(\w*)` in the param list, not `()`, and the leading `_?`: PR B2
    // consolidated the eight run<Mode>() bodies into one shared
    // `_runCliMode(mode)`, and the ORIGINAL `\(\)`-only pattern matched every
    // one-line wrapper (`async runOpenCode() { return this._runCliMode(...) }`)
    // but not `_runCliMode` itself, where the real terminal-ownership logic
    // now lives — so this guard could see 8 clean one-liners and stay green
    // while the actual bug shipped unseen for all eight external CLIs at
    // once. Confirmed live: adding `this.terminal.clear()` to `_runCliMode`
    // left this test 32/32 green under the old pattern.
    const bodies = new Map<string, string>();
    const header = /^ {2}async (_?run[A-Za-z]*)\(\w*\) \{$/gm;
    for (let m = header.exec(src); m; m = header.exec(src)) {
      const start = m.index + m[0].length;
      const end = src.indexOf('\n  },', start);
      expect(end, `could not find the end of ${m[1]}()`).toBeGreaterThan(start);
      bodies.set(m[1], src.slice(start, end));
    }

    // Fail loudly if the scan matched nothing: a silently empty scan would make
    // every assertion below vacuously true.
    expect([...bodies.keys()]).toEqual(
      expect.arrayContaining([
        'runClaude',
        'runShell',
        '_runCliMode',
        'runOpenCode',
        'runCodex',
        'runGemini',
        'runAntigravity',
        'runPi',
        'runGrok',
      ])
    );

    for (const [name, body] of bodies) {
      expect(body, `${name}() must not clear a terminal it may not own`).not.toContain('this.terminal.clear(');
      expect(body, `${name}() must not write launch status straight to the terminal`).not.toContain(
        'this.terminal.writeln('
      );
    }
  });

  it('coalesces overlapping Run activations and disables the button while the request is active', async () => {
    const runBtn = {
      disabled: false,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => (id === 'runBtn' ? runBtn : null) },
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app._runMinLockMs = 0;
    let finishRun!: () => void;
    app.runClaude = vi.fn(
      () =>
        new Promise<void>((resolveRun) => {
          finishRun = resolveRun;
        })
    );

    const first = app.run();
    const duplicate = app.run();

    expect(app.runClaude).toHaveBeenCalledTimes(1);
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.setAttribute).toHaveBeenCalledWith('aria-busy', 'true');

    finishRun();
    await Promise.all([first, duplicate]);

    expect(runBtn.disabled).toBe(false);
    expect(runBtn.removeAttribute).toHaveBeenCalledWith('aria-busy');
  });

  it('renders a POST response session immediately without waiting for SSE', async () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      fetch: vi.fn(),
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.sessions = new Map();
    app._onSessionCreated = vi.fn((session: any) => app.sessions.set(session.id, session));
    app._renderSessionTabsImmediate = vi.fn();
    const snapshot = { id: 'sess-new', name: 'w1-case', workingDir: '/tmp/case' };

    await app._ensureCreatedSessionVisible(snapshot.id, snapshot);

    expect(context.fetch).not.toHaveBeenCalled();
    expect(app.sessions.get(snapshot.id)).toEqual(snapshot);
    expect(app._renderSessionTabsImmediate).toHaveBeenCalledTimes(1);
  });

  it('loads the new session when a quick-start response wins the race with SSE', async () => {
    const snapshot = { id: 'sess-race', name: 'w1-remote', workingDir: '/remote/work' };
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ success: true, data: snapshot }),
    }));
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      fetch: fetchMock,
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.sessions = new Map();
    app._onSessionCreated = vi.fn((session: any) => app.sessions.set(session.id, session));
    app._renderSessionTabsImmediate = vi.fn();

    await app._ensureCreatedSessionVisible(snapshot.id);

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-race');
    expect(app.sessions.get(snapshot.id)).toEqual(snapshot);
    expect(app._renderSessionTabsImmediate).toHaveBeenCalledTimes(1);
  });
});

describe('Codex quick start settings', () => {
  it('renders Codex CLI settings in their own group inside Agents & CLIs', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');

    // The settings modal is one scrolling document: Codex is a GROUP that can be
    // hidden wholesale, not a tab (see _applyCodexSettingsVisibility).
    const clis = html.match(/<section class="set-section" id="settings-clis"([\s\S]*?)<\/section>/);
    expect(clis?.[1]).toBeTruthy();

    const codexGroup = clis![1].match(/id="appSettingsCodexGroup"([\s\S]*)$/);
    expect(codexGroup?.[1]).toContain('appSettingsCodexDangerouslyBypassApprovals');
    expect(codexGroup?.[1]).toContain('appSettingsCodexAnimations');
    expect(codexGroup?.[1]).not.toContain('appSettingsCodexRenderMode');

    // The Claude settings above it must not have absorbed the codex inputs.
    const beforeCodex = clis![1].slice(0, clis![1].indexOf('id="appSettingsCodexGroup"'));
    expect(beforeCodex).not.toContain('appSettingsCodexDangerouslyBypassApprovals');
    expect(beforeCodex).not.toContain('appSettingsCodexAnimations');
  });

  describe('Codex CLI group visibility', () => {
    // Both settings in the group are handed to `codex` at launch, so on an
    // instance where the binary does not resolve the group is a promise nothing
    // can keep. renderIndexHtml injects window.__codemanCliAvailable; this pins
    // the client half. Coupled test: it drives the REAL settings-ui.js against a
    // stub element, so deleting the call in openAppSettings() is what it catches.
    function loadSettingsUi(codexAvailable: boolean | undefined) {
      const codexTabBtn = { id: 'appSettingsCodexGroup', style: { display: 'PRISTINE' } };
      const CodemanApp = function CodemanApp(this: any) {};
      const context: any = vm.createContext({
        CodemanApp,
        MobileDetection: { getDeviceType: () => 'desktop', isTouchDevice: () => false, isHandheldDevice: () => false },
        localStorage: { getItem: () => null, setItem: () => {} },
        document: {
          getElementById: (id: string) => (id === 'appSettingsCodexGroup' ? codexTabBtn : null),
          querySelector: () => null,
        },
        console,
      });
      context.window = context;
      if (codexAvailable !== undefined) context.__codemanCliAvailable = { codex: codexAvailable };
      const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
      vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });
      return { app: new (CodemanApp as any)(), codexTabBtn };
    }

    it('hides the Codex group when the codex binary is not available', () => {
      const { app, codexTabBtn } = loadSettingsUi(false);
      app._applyCodexSettingsVisibility();
      expect(codexTabBtn.style.display).toBe('none');
    });

    it('hides the Codex group when the availability flag was never injected', () => {
      const { app, codexTabBtn } = loadSettingsUi(undefined);
      app._applyCodexSettingsVisibility();
      expect(codexTabBtn.style.display).toBe('none');
    });

    it('shows the Codex group when codex is available', () => {
      const { app, codexTabBtn } = loadSettingsUi(true);
      app._applyCodexSettingsVisibility();
      expect(codexTabBtn.style.display).toBe('');
    });

    it('applies the gating from openAppSettings, not just in isolation', () => {
      const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
      const open = src.slice(src.indexOf('\n  openAppSettings() {'));
      const body = open.slice(0, open.indexOf('\n  },'));
      expect(body).toContain('_applyCodexSettingsVisibility()');
    });
  });

  describe('CLI availability gating (#200/#201)', () => {
    const CATALOG = [
      { id: 'claude', label: 'Claude Code', shortBadge: 'CC', kind: 'agent', enabled: true },
      { id: 'opencode', label: 'OpenCode', shortBadge: 'OC', kind: 'agent', enabled: true },
      { id: 'codex', label: 'Codex', shortBadge: 'CX', kind: 'agent', enabled: true },
      { id: 'gemini', label: 'Gemini', shortBadge: 'GM', kind: 'agent', enabled: true },
      { id: 'antigravity', label: 'Antigravity', shortBadge: 'AG', kind: 'agent', enabled: true },
      { id: 'pi', label: 'Pi', shortBadge: 'PI', kind: 'agent', enabled: true },
      { id: 'grok', label: 'Grok', shortBadge: 'GK', kind: 'agent', enabled: true },
      { id: 'deepseek', label: 'DeepSeek', shortBadge: 'DS', kind: 'agent', enabled: true },
      { id: 'omp', label: 'OMP', shortBadge: 'OM', kind: 'agent', enabled: true },
      { id: 'custom-agent', label: 'Custom Agent', shortBadge: 'CA', kind: 'agent', enabled: true },
      { id: 'shell', label: 'Shell', shortBadge: 'SH', kind: 'shell', enabled: true },
    ];

    function element() {
      const el: any = {
        style: { display: 'PRISTINE' },
        dataset: {},
        children: [] as any[],
        setAttribute: () => {},
        appendChild(child: any) {
          this.children.push(child);
          return child;
        },
        append(child: any) {
          this.children.push(child);
        },
        replaceChildren(...children: any[]) {
          this.children = children;
        },
      };
      return el;
    }

    // Drives the REAL settings-ui.js + session-ui.js against stub elements, including
    // a custom registry entry so a static stock-only list cannot pass this test.
    function loadUi(flags: Record<string, boolean> | undefined, catalog = CATALOG) {
      const CodemanApp = function CodemanApp(this: any) {};
      const welcomeCliActions = element();
      const tunnelBtn = element();
      const runModeCliOptions = element();
      const modeBtns: Record<string, any> = {};
      for (const cli of catalog) {
        modeBtns[cli.id] = element();
        modeBtns[cli.id].dataset.mode = cli.id;
      }
      const menu = {
        querySelector: (sel: string) =>
          sel === '#runModeDeepSeekInstall' || sel === '#runModeDeepSeekWeb' ? null : null,
        querySelectorAll: () => Object.values(modeBtns),
      };
      const context: any = vm.createContext({
        CodemanApp,
        MobileDetection: { getDeviceType: () => 'desktop', isTouchDevice: () => false, isHandheldDevice: () => false },
        localStorage: { getItem: () => null, setItem: () => {} },
        document: {
          getElementById: (id: string) =>
            id === 'welcomeCliActions'
              ? welcomeCliActions
              : id === 'welcomeTunnelBtn'
                ? tunnelBtn
                : id === 'runModeCliOptions'
                  ? runModeCliOptions
                  : null,
          createElement: element,
          createElementNS: element,
          querySelector: () => null,
        },
        console,
      });
      context.window = context;
      context.__codemanCliCatalog = catalog;
      if (flags !== undefined) context.__codemanCliAvailable = flags;
      for (const file of ['settings-ui.js', 'session-ui.js']) {
        const src = readFileSync(resolve(import.meta.dirname, `../src/web/public/${file}`), 'utf8');
        vm.runInContext(src, context, { filename: file });
      }
      return { app: new (CodemanApp as any)(), welcomeCliActions, tunnelBtn, runModeCliOptions, modeBtns, menu };
    }

    const ALL_OFF = {
      claude: false,
      opencode: false,
      codex: false,
      gemini: false,
      antigravity: false,
      pi: false,
      grok: false,
      deepseek: false,
      omp: false,
      'custom-agent': false,
      cloudflared: false,
    };

    it('renders only enabled and available registry entries on the welcome screen', () => {
      const { app, welcomeCliActions, tunnelBtn } = loadUi({ ...ALL_OFF, claude: true, 'custom-agent': true });
      app.applyWelcomeCliVisibility();
      const offered = welcomeCliActions.children.map((btn: any) => btn.dataset.mode);
      expect(offered).toEqual(['claude', 'custom-agent', 'shell']);
      // #200 originally DELETED the tunnel button and its QR outright; it is gated
      // on cloudflared instead, so a box that has cloudflared keeps the feature.
      expect(tunnelBtn.style.display).toBe('none');

      const withTunnel = loadUi({ ...ALL_OFF, cloudflared: true });
      withTunnel.app.applyWelcomeCliVisibility();
      expect(withTunnel.tunnelBtn.style.display).toBe('flex');

      const withPi = loadUi({ ...ALL_OFF, pi: true });
      withPi.app.applyWelcomeCliVisibility();
      expect(withPi.welcomeCliActions.children.map((btn: any) => btn.dataset.mode)).toEqual(['pi', 'shell']);
    });

    it('gates every run mode in the dropdown, antigravity included, and never shell', () => {
      const { app, modeBtns, menu } = loadUi({ ...ALL_OFF, claude: true, antigravity: true, omp: true });
      app._refreshRunModeAvailability(menu);
      expect(modeBtns.claude.style.display).toBe('flex');
      expect(modeBtns.antigravity.style.display).toBe('flex');
      expect(modeBtns.opencode.style.display).toBe('none');
      expect(modeBtns.codex.style.display).toBe('none');
      expect(modeBtns.gemini.style.display).toBe('none');
      expect(modeBtns.omp.style.display).toBe('flex');
      // Shell needs no external CLI, and leaving it alone is what guarantees the
      // menu is never empty on a box with nothing installed.
      expect(modeBtns.shell.style.display).toBe('PRISTINE');
    });

    it('renders each enabled agent registry entry in the Run menu, including custom entries', () => {
      const { app, runModeCliOptions } = loadUi({ ...ALL_OFF, claude: true, 'custom-agent': true });
      app.renderRegistryRunOptions();
      expect(runModeCliOptions.children.map((btn: any) => btn.dataset.mode)).toContain('custom-agent');
      expect(runModeCliOptions.children.map((btn: any) => btn.dataset.mode)).not.toContain('shell');
    });

    it('labels welcome buttons "Run <label>", the strings i18n.js translates ("Run Claude Code")', () => {
      const { app, welcomeCliActions } = loadUi({ ...ALL_OFF, claude: true });
      app.applyWelcomeCliVisibility();
      const texts = welcomeCliActions.children.map((btn: any) =>
        btn.children.filter((c: unknown) => typeof c === 'string').join('')
      );
      expect(texts).toEqual(['Run Claude Code', 'Run Shell']);
    });

    it('falls back to the first ENABLED agent when the chosen run mode is disabled, never a hardcoded claude', () => {
      const catalog = CATALOG.map((cli) =>
        cli.id === 'claude' || cli.id === 'codex' ? { ...cli, enabled: false } : cli
      );
      const { app } = loadUi(undefined, catalog);
      app.runMode = 'codex';
      expect(app.runMode).toBe('opencode');
      app.runMode = 'claude';
      expect(app.runMode).toBe('opencode');
      app.runMode = 'gemini';
      expect(app.runMode).toBe('gemini');
    });

    it('builds the run-mode menu from the registry rather than static markup', () => {
      const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
      expect(html).toContain('id="runModeCliOptions"');
      const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
      expect(src).toContain('renderRegistryRunOptions()');
      expect(src).not.toContain('data-mode="codex"');
    });

    it('shows everything when the flags were never injected', () => {
      // A cached page from a build without the injection, or a solo popup. Hiding
      // every run button on a doubt would leave a working install nothing to click.
      const { app, welcomeCliActions, modeBtns, menu } = loadUi(undefined);
      app.applyWelcomeCliVisibility();
      app._refreshRunModeAvailability(menu);
      expect(welcomeCliActions.children.map((btn: any) => btn.dataset.mode)).toContain('claude');
      expect(modeBtns.gemini.style.display).toBe('flex');
    });
  });

  it('passes global Codex settings into quick-start config for new sessions', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'codex-case' },
      tabCount: { value: '1' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      // Mock responses use the real wire shape: the global preSerialization hook in
      // server.ts wraps route payloads into the { success, data } envelope.
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/codex/status') return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start') return { json: async () => ({ success: true, data: { sessionId: 'sess-1' } }) };
        if (url === '/api/sessions/sess-1')
          return { json: async () => ({ success: true, data: { id: 'sess-1', name: 'w1-codex-case' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({
      codexDangerouslyBypassApprovals: true,
      codexAnimationsEnabled: false,
    });
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.sessions = new Map();
    app._onSessionCreated = (session: any) => app.sessions.set(session.id, session);
    app._renderSessionTabsImmediate = vi.fn();
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runCodex();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'codex-case',
      mode: 'codex',
      // tabs follow the w<n>-<case> naming convention (quick-start would otherwise auto-name codeman-<id>)
      sessionName: 'w1-codex-case',
      codexConfig: { dangerouslyBypassApprovals: true, animations: false, renderMode: 'hybrid' },
    });
    expect(selected).toEqual(['sess-1']);
  });
});

describe('case selector refresh', () => {
  it('sorts case picker options alphabetically and filters by case or host label', () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    const cases = [
      { name: 'zeta' },
      { name: 'moneytrove', location: 'remote', remote: { hostId: 'mac-mini', path: '/Users/saqeb/moneytrove' } },
      { name: 'Alpha' },
      { name: 'plex-previews' },
    ];

    const options = app.buildCasePickerOptions(cases);

    expect(options.map((option: any) => option.name)).toEqual([
      'Alpha',
      'moneytrove',
      'plex-previews',
      'testcase',
      'zeta',
    ]);
    expect(options.find((option: any) => option.name === 'moneytrove')?.label).toBe('moneytrove @ mac-mini');
    expect(app.filterCasePickerOptions(options, 'MAC').map((option: any) => option.name)).toEqual(['moneytrove']);
    expect(app.filterCasePickerOptions(options, 'plex').map((option: any) => option.name)).toEqual(['plex-previews']);
  });

  it('labels dockerized cases with a short "(docker)" tag (or the custom host id)', () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });
    const app = new (CodemanApp as any)();

    const label = (c: any) => app.formatCasePickerLabel(c);
    // default one-click host, the 'local' Docker-tab default, and per-case override
    // hosts all collapse to the short "(docker)" tag.
    expect(
      label({ name: 'sandbox', location: 'docker', docker: { hostId: 'default', container: 'codeman-case-sandbox' } })
    ).toBe('sandbox (docker)');
    expect(label({ name: 'sandbox', location: 'docker', docker: { hostId: 'local' } })).toBe('sandbox (docker)');
    expect(label({ name: 'sandbox', location: 'docker', docker: { hostId: 'q-sandbox' } })).toBe('sandbox (docker)');
    // a user-named docker host shows its id
    expect(label({ name: 'ml', location: 'docker', docker: { hostId: 'gpu-box' } })).toBe('ml (gpu-box)');
  });

  it('launches the highlighted case with the current run mode when pressing Enter in the picker', () => {
    const elements: Record<string, any> = {};
    const listeners: Record<string, (event: any) => void> = {};
    const CodemanApp = function CodemanApp(this: any) {};

    elements.quickStartCase = {
      value: 'Alpha',
      dataset: {},
    };
    elements.quickStartCaseSearch = {
      value: 'mon',
      dataset: {},
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
        listeners[event] = handler;
      }),
      select: vi.fn(),
    };
    elements.quickStartCaseList = {
      innerHTML: '',
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn(),
    };
    elements.quickStartCasePicker = {
      contains: () => true,
    };

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
        addEventListener: vi.fn(),
      },
      console,
      escapeHtml: (s: string) => s,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.cases = [
      { name: 'Alpha' },
      { name: 'moneytrove', location: 'remote', remote: { hostId: 'mac-mini', path: '/Users/saqeb/moneytrove' } },
      { name: 'zeta' },
    ];
    app.updateDirDisplayForCase = vi.fn();
    app.updateMobileCaseLabel = vi.fn();
    app.saveLastUsedCase = vi.fn();
    app.run = vi.fn(async () => {});

    app.setupQuickStartCasePicker();
    listeners.keydown({ key: 'Enter', preventDefault: vi.fn() });

    expect(elements.quickStartCase.value).toBe('moneytrove');
    expect(app.run).toHaveBeenCalledTimes(1);
  });

  it('creates remote shell sessions by caseName instead of remote display path', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'gpu-work' },
      shellCount: { value: '1' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/cases/gpu-work') {
          return {
            json: async () => ({
              success: true,
              data: {
                name: 'gpu-work',
                path: 'ubuntu@10.0.0.42:/home/ubuntu/work',
                location: 'remote',
                remote: { hostId: 'gpu-box', path: '/home/ubuntu/work' },
              },
            }),
          };
        }
        if (url === '/api/quick-start') {
          return { json: async () => ({ success: true, data: { sessionId: 'sess-1' } }) };
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.sessions = new Map();
    app.cases = [{ name: 'gpu-work', path: 'ubuntu@10.0.0.42:/home/ubuntu/work', location: 'remote' }];
    app.getTerminalDimensions = () => null;
    app.selectSession = async () => {};

    await app.runShell();

    // Remote cases must ride /api/quick-start (which resolves the remote case and
    // launches over ssh) — POST /api/sessions stat-validates workingDir locally and
    // its schema has no caseName, so the remote display path must never reach it.
    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'gpu-work',
      mode: 'shell',
    });
    expect(requests.find((req) => req.url === '/api/quick-start')?.body).not.toHaveProperty('workingDir');
    expect(requests.some((req) => req.url === '/api/sessions')).toBe(false);
  });

  it('removes a deleted selected case from the dropdown and blurs the native picker', async () => {
    const elements: Record<string, any> = {};
    const requests: Array<{ url: string; method: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};
    const quickStartCase = {
      value: 'deleted-case',
      innerHTML: '<option value="deleted-case">deleted-case</option><option value="kept-case">kept-case</option>',
      dataset: {},
      blur: vi.fn(),
      addEventListener: vi.fn(),
    };

    elements.quickStartCase = quickStartCase;
    elements.caseManageList = { innerHTML: '' };
    elements.mobileCaseName = { textContent: '' };
    elements.dirDisplay = { textContent: '' };
    elements.dirInput = { value: '' };

    const context = vm.createContext({
      CodemanApp,
      MobileDetection: { getDeviceType: () => 'desktop' },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      confirm: () => true,
      fetch: async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/cases/deleted-case')
          return { json: async () => ({ success: true, data: { name: 'deleted-case' } }) };
        // The server's preSerialization hook wraps bare payloads as { success, data },
        // so the frontend reads `.data` off every JSON response — mirror that here.
        if (url === '/api/settings')
          return { ok: true, json: async () => ({ success: true, data: { lastUsedCase: 'deleted-case' } }) };
        if (url === '/api/cases')
          return { json: async () => ({ success: true, data: [{ name: 'kept-case', path: '/tmp/kept-case' }] }) };
        if (url === '/api/cases/kept-case')
          return { json: async () => ({ success: true, data: { path: '/tmp/kept-case' } }) };
        if (url === '/api/settings' && init?.method === 'PUT') return { json: async () => ({ success: true }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
      escapeHtml: (s: string) => s,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.cases = [
      { name: 'deleted-case', path: '/tmp/deleted-case' },
      { name: 'kept-case', path: '/tmp/kept-case' },
    ];
    app.showToast = vi.fn();

    // deleteCase re-renders the case-manage list, whose path label goes through
    // _shortenHomePath. That method lives in terminal-ui.js, which this harness
    // does not load (the real app always has it: load order 7 before 12).
    app._shortenHomePath = (p: string) => p;

    await app.deleteCase('deleted-case');

    expect(quickStartCase.blur).toHaveBeenCalled();
    expect(quickStartCase.innerHTML).not.toContain('deleted-case');
    expect(quickStartCase.innerHTML).toContain('kept-case');
    expect(elements.mobileCaseName.textContent).toBe('kept-case');
    expect(requests).toContainEqual({
      url: '/api/settings',
      method: 'PUT',
      body: { lastUsedCase: 'kept-case' },
    });
  });
});

describe('Gemini quick start', () => {
  // Regression guard for the ApiResponse-envelope unwrap in runGemini(): the
  // status check must read `.data.available` and the quick-start response must
  // read `.data.sessionId`. Reading the raw shape (pre-fix) silently bails on
  // the status check and never selects the new tab — exactly the two blockers
  // caught in PR #134 review.
  it('drives runGemini() through the {success,data} envelope and selects the new session', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'gemini-case' },
      tabCount: { value: '1' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      // Mock responses use the real wire shape: the server.ts preSerialization
      // hook wraps raw route payloads into the { success, data } envelope.
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/gemini/status') return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start')
          return { json: async () => ({ success: true, data: { sessionId: 'sess-gm' } }) };
        if (url === '/api/sessions/sess-gm')
          return { json: async () => ({ success: true, data: { id: 'sess-gm', name: 'w1-gemini-case' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({});
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.sessions = new Map();
    app._onSessionCreated = (session: any) => app.sessions.set(session.id, session);
    app._renderSessionTabsImmediate = vi.fn();
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runGemini();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'gemini-case',
      mode: 'gemini',
      geminiConfig: { approvalMode: 'yolo' },
    });
    expect(selected).toEqual(['sess-gm']);
  });
});

describe('Antigravity quick start', () => {
  // Same envelope-unwrap regression guard as the Gemini block above, for runAntigravity().
  it('drives runAntigravity() through the {success,data} envelope and selects the new session', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'ag-case' },
      tabCount: { value: '1' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/antigravity/status')
          return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start')
          return { json: async () => ({ success: true, data: { sessionId: 'sess-ag' } }) };
        if (url === '/api/sessions/sess-ag')
          return { json: async () => ({ success: true, data: { id: 'sess-ag', name: 'w1-ag-case' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({});
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.sessions = new Map();
    app._onSessionCreated = (session: any) => app.sessions.set(session.id, session);
    app._renderSessionTabsImmediate = vi.fn();
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runAntigravity();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'ag-case',
      mode: 'antigravity',
      antigravityConfig: { dangerouslySkipPermissions: true },
    });
    expect(selected).toEqual(['sess-ag']);
  });
});

describe('Pi quick start', () => {
  // Same envelope-unwrap regression guard as the blocks above, for runPi(), plus the
  // rule that makes pi different: it must send NO piConfig. Pi has no permission
  // prompts, and `approveProjectTrust` would opt the session into EXECUTING
  // repo-supplied TypeScript — never something a Run button decides silently.
  it('drives runPi() through the {success,data} envelope and sends no piConfig', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'pi-case' },
      tabCount: { value: '1' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/pi/status')
          return {
            json: async () => ({ success: true, data: { available: true, path: '/usr/local/bin', version: '0.84.1' } }),
          };
        if (url === '/api/quick-start')
          return { json: async () => ({ success: true, data: { sessionId: 'sess-pi' } }) };
        if (url === '/api/sessions/sess-pi')
          return { json: async () => ({ success: true, data: { id: 'sess-pi', name: 'w1-pi-case' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({});
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.sessions = new Map();
    app._onSessionCreated = (session: any) => app.sessions.set(session.id, session);
    app._renderSessionTabsImmediate = vi.fn();
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runPi();

    const body = requests.find((req) => req.url === '/api/quick-start')?.body;
    expect(body).toMatchObject({ caseName: 'pi-case', mode: 'pi' });
    expect(body).not.toHaveProperty('piConfig');
    expect(selected).toEqual(['sess-pi']);
  });

  it('reports the install hint when the CLI is missing and starts nothing', async () => {
    const elements: Record<string, any> = { quickStartCase: { value: 'pi-case' } };
    const requests: string[] = [];
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async (url: string) => {
        requests.push(url);
        if (url === '/api/pi/status')
          return { json: async () => ({ success: true, data: { available: false, path: null, version: null } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    const errors: string[] = [];
    app._reportSessionLaunchError = (_owns: boolean, msg: string) => errors.push(msg);

    await app.runPi();

    expect(requests).toEqual(['/api/pi/status']);
    expect(errors[0]).toContain('@earendil-works/pi-coding-agent');
  });
});

describe('Grok quick start', () => {
  // Same envelope-unwrap regression guard as the blocks above, for runGrok(),
  // plus the rule that makes grok the OPPOSITE of pi: the Run button DOES send
  // `grokConfig: { alwaysApprove: true }` (grok's bypassPermissions mode), the
  // same product decision as runAntigravity's dangerouslySkipPermissions and
  // claude's --dangerously-skip-permissions. The multi-user clamp strips it
  // server-side for non-granted owners.
  it('drives runGrok() through the {success,data} envelope and sends alwaysApprove', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'grok-case' },
      tabCount: { value: '1' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/grok/status')
          return {
            json: async () => ({
              success: true,
              data: { available: true, path: '/home/user/.grok/bin', version: '1.0.5' },
            }),
          };
        if (url === '/api/quick-start')
          return { json: async () => ({ success: true, data: { sessionId: 'sess-gk' } }) };
        if (url === '/api/sessions/sess-gk')
          return { json: async () => ({ success: true, data: { id: 'sess-gk', name: 'w1-grok-case' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({});
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.sessions = new Map();
    app._onSessionCreated = (session: any) => app.sessions.set(session.id, session);
    app._renderSessionTabsImmediate = vi.fn();
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runGrok();

    const body = requests.find((req) => req.url === '/api/quick-start')?.body;
    expect(body).toMatchObject({
      caseName: 'grok-case',
      mode: 'grok',
      grokConfig: { alwaysApprove: true },
    });
    expect(selected).toEqual(['sess-gk']);
  });

  it('reports the install hint when the CLI is missing and starts nothing', async () => {
    const elements: Record<string, any> = { quickStartCase: { value: 'grok-case' } };
    const requests: string[] = [];
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async (url: string) => {
        requests.push(url);
        if (url === '/api/grok/status')
          return { json: async () => ({ success: true, data: { available: false, path: null, version: null } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });
    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    const errors: string[] = [];
    app._reportSessionLaunchError = (_owns: boolean, msg: string) => errors.push(msg);

    await app.runGrok();

    expect(requests).toEqual(['/api/grok/status']);
    expect(errors[0]).toContain('https://x.ai/cli/install.sh');
  });

  // The whole point of the shared _launchQuickStartInstances() helper. Before it,
  // every non-Claude run*() hardcoded exactly one quick-start call, so the
  // "Instance count" stepper next to the Run button silently did nothing on all
  // eight of them: no error, no hint, just the wrong number of sessions. The five
  // fixture edits that came with the change stub tabCount at '1', so they pass
  // identically with and without it; this is the one that does not.
  it('launches tabCount sessions with sequential w<n>-<case> names and selects the first', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'grok-case' },
      tabCount: { value: '3' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};
    let created = 0;

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async (url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : undefined;
        requests.push({ url, body });
        if (url === '/api/grok/status')
          return {
            json: async () => ({
              success: true,
              data: { available: true, path: '/home/user/.grok/bin', version: '1.0.5' },
            }),
          };
        if (url === '/api/quick-start') {
          const id = `sess-gk-${created++}`;
          return {
            json: async () => ({ success: true, data: { sessionId: id, session: { id, name: body.sessionName } } }),
          };
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({});
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.sessions = new Map();
    app._onSessionCreated = (session: any) => app.sessions.set(session.id, session);
    app._renderSessionTabsImmediate = () => {};
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runGrok();

    const names = requests.filter((r) => r.url === '/api/quick-start').map((r) => r.body.sessionName);
    expect(names).toEqual(['w1-grok-case', 'w2-grok-case', 'w3-grok-case']);
    expect(selected).toEqual(['sess-gk-0']);
  });
});
