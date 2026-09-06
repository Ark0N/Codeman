import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadPaletteHarness(overrides: Record<string, any> = {}) {
  const elements: Record<string, any> = {};
  const listeners: Record<string, (event: any) => void> = {};
  const CodemanApp = function CodemanApp(this: any) {};

  const makeClassList = () => {
    const classes = new Set<string>();
    return {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const shouldAdd = force ?? !classes.has(name);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      },
    };
  };

  elements.commandPaletteModal = {
    classList: makeClassList(),
    addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
      listeners[`modal:${event}`] = handler;
    }),
  };
  elements.commandPaletteSearch = {
    value: '',
    focus: vi.fn(),
    select: vi.fn(),
    addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
      listeners[`search:${event}`] = handler;
    }),
  };
  elements.commandPaletteList = {
    innerHTML: '',
    addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
      listeners[`list:${event}`] = handler;
    }),
  };
  elements.quickStartCase = {
    value: 'plex-previews',
  };

  const context = vm.createContext({
    CodemanApp,
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      createElement: (tagName: string) => ({
        tagName: tagName.toUpperCase(),
        value: '',
        textContent: '',
      }),
    },
    console,
    escapeHtml: (value: string) =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
    ...overrides,
  });

  const panelsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  vm.runInContext(panelsUi, context, { filename: 'panels-ui.js' });

  const app = new (CodemanApp as any)();
  app.sessions = new Map([
    [
      'sess-alpha',
      {
        id: 'sess-alpha',
        name: 'Alpha API cleanup',
        workingDir: '/repo/api',
        mode: 'codex',
        status: 'busy',
      },
    ],
    [
      'sess-beta',
      {
        id: 'sess-beta',
        name: 'Billing prompt polish',
        workingDir: '/repo/billing',
        mode: 'claude',
        status: 'idle',
      },
    ],
    [
      'sess-gamma',
      {
        id: 'sess-gamma',
        workingDir: '/repo/flux-player',
        mode: 'codex',
        status: 'busy',
      },
    ],
  ]);
  app.sessionOrder = ['sess-beta', 'sess-alpha', 'sess-gamma'];
  app.cases = [{ name: 'plex-previews' }, { name: 'flux-player' }, { name: 'api-tools' }];
  app.selectSession = vi.fn();
  app.run = vi.fn();
  app.getShortId = (id: string) => id.slice(0, 8);
  app.getSessionName = (session: any) =>
    session.name || session.workingDir?.split('/').pop() || app.getShortId(session.id);

  return { app, elements, listeners };
}

describe('Command-K session palette', () => {
  it('recognizes Cmd/Ctrl-K outside text-entry contexts only', () => {
    const { app } = loadPaletteHarness();

    expect(app.shouldOpenCommandPaletteFromShortcut({ key: 'k', metaKey: true, ctrlKey: false, target: null })).toBe(
      true
    );
    expect(app.shouldOpenCommandPaletteFromShortcut({ key: 'K', metaKey: false, ctrlKey: true, target: null })).toBe(
      true
    );
    expect(
      app.shouldOpenCommandPaletteFromShortcut({
        key: 'k',
        metaKey: true,
        ctrlKey: false,
        target: { tagName: 'INPUT', isContentEditable: false },
      })
    ).toBe(false);
    expect(
      app.shouldOpenCommandPaletteFromShortcut({
        key: 'k',
        metaKey: false,
        ctrlKey: true,
        target: { tagName: 'DIV', isContentEditable: true },
      })
    ).toBe(false);
  });

  it('recognizes Ctrl-K from the focused xterm helper textarea', () => {
    const { app } = loadPaletteHarness();

    expect(
      app.shouldOpenCommandPaletteFromShortcut({
        key: 'k',
        code: 'KeyK',
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        target: {
          tagName: 'TEXTAREA',
          isContentEditable: false,
          classList: { contains: (name: string) => name === 'xterm-helper-textarea' },
        },
      })
    ).toBe(true);
  });

  it('recognizes macOS Option-K by physical key code', () => {
    const { app } = loadPaletteHarness();

    expect(
      app.shouldOpenCommandPaletteFromShortcut({
        key: '˚',
        code: 'KeyK',
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        target: null,
      })
    ).toBe(true);
  });

  it('rejects the palette chord when extra modifiers are held (Ctrl+Shift+K is the Firefox devtools console)', () => {
    const { app } = loadPaletteHarness();

    expect(
      app.shouldOpenCommandPaletteFromShortcut({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true, target: null })
    ).toBe(false);
  });

  it('honors a disabled or rebound palette shortcut from the registry', () => {
    const { app } = loadPaletteHarness();

    // Disabled entry → never opens, even for the default chord.
    app.getShortcutRegistry = () => [
      { id: 'command-palette', disabled: true, bindings: [{ modifiers: ['ctrl'], key: 'k', code: 'KeyK' }] },
    ];
    app.matchesShortcutEvent = () => true;
    expect(app.shouldOpenCommandPaletteFromShortcut({ key: 'k', code: 'KeyK', ctrlKey: true, target: null })).toBe(
      false
    );

    // Rebound entry → the new chord opens, the old default no longer does.
    app.getShortcutRegistry = () => [{ id: 'command-palette', bindings: [{ modifiers: ['ctrl'], code: 'KeyP' }] }];
    app.matchesShortcutEvent = (e: any, s: any) => e.code === s.bindings[0].code;
    expect(app.shouldOpenCommandPaletteFromShortcut({ key: 'k', code: 'KeyK', ctrlKey: true, target: null })).toBe(
      false
    );
    expect(app.shouldOpenCommandPaletteFromShortcut({ key: 'p', code: 'KeyP', ctrlKey: true, target: null })).toBe(
      true
    );
  });

  it('opens and focuses the palette search box', () => {
    const { app, elements } = loadPaletteHarness();

    app.openCommandPalette();

    expect(elements.commandPaletteModal.classList.contains('active')).toBe(true);
    expect(elements.commandPaletteSearch.focus).toHaveBeenCalledTimes(1);
    expect(elements.commandPaletteList.innerHTML).toContain('Alpha API cleanup');
  });

  it('filters currently open sessions and always includes a new-session action', () => {
    const { app } = loadPaletteHarness();

    const results = app.buildCommandPaletteItems('bill');

    expect(results.map((item: any) => item.id)).toEqual(['session:sess-beta', 'new-session', 'browse-sessions']);
    expect(results[0]).toMatchObject({ type: 'session', sessionId: 'sess-beta', title: 'Billing prompt polish' });
    expect(results[1]).toMatchObject({ type: 'new-session', title: 'New session' });
    expect(results[2]).toMatchObject({ type: 'browse-sessions' });
  });

  it('uses the tab name instead of the short session id for unnamed sessions', () => {
    const { app } = loadPaletteHarness();

    const results = app.buildCommandPaletteItems('flux-player');

    expect(results[0]).toMatchObject({
      type: 'session',
      sessionId: 'sess-gamma',
      title: 'flux-player',
    });
    expect(results[0].title).not.toBe('sess-gam');
  });

  it('uses the best matching case for the new-session action', async () => {
    const { app, elements } = loadPaletteHarness();

    const results = app.buildCommandPaletteItems('flux');
    const newSession = results.find((item: any) => item.type === 'new-session');

    expect(newSession).toMatchObject({
      type: 'new-session',
      caseName: 'flux-player',
      subtitle: 'Run Claude in flux-player',
    });

    app.commandPaletteItems = [newSession];
    app.commandPaletteActiveIndex = 0;
    await app.activateCommandPaletteItem();

    expect(elements.quickStartCase.value).toBe('flux-player');
    expect(app.run).toHaveBeenCalledTimes(1);
  });

  it('adds the matched case option before selecting it for a new session', async () => {
    const { app, elements } = loadPaletteHarness();
    const options = [{ value: 'plex-previews' }];
    elements.quickStartCase = {
      tagName: 'SELECT',
      options,
      appendChild: vi.fn((option: any) => options.push(option)),
      get value() {
        return this._value || '';
      },
      set value(next: string) {
        this._value = options.some((option) => option.value === next) ? next : '';
      },
    };
    elements.quickStartCase.value = 'plex-previews';

    const newSession = app.buildCommandPaletteItems('flux').find((item: any) => item.type === 'new-session');
    app.commandPaletteItems = [newSession];
    app.commandPaletteActiveIndex = 0;

    await app.activateCommandPaletteItem();

    expect(elements.quickStartCase.appendChild).toHaveBeenCalledTimes(1);
    expect(elements.quickStartCase.value).toBe('flux-player');
    expect(app.run).toHaveBeenCalledTimes(1);
  });

  it('routes the new-session case pick through selectQuickStartCase when the picker mixin is loaded', async () => {
    const { app } = loadPaletteHarness();
    app.selectQuickStartCase = vi.fn();

    const newSession = app.buildCommandPaletteItems('flux').find((item: any) => item.type === 'new-session');
    app.commandPaletteItems = [newSession];
    app.commandPaletteActiveIndex = 0;
    await app.activateCommandPaletteItem();

    // Keeps the searchable combobox, dir display, and lastUsedCase in sync
    // instead of silently mutating the hidden native <select>.
    expect(app.selectQuickStartCase).toHaveBeenCalledWith('flux-player');
    expect(app.run).toHaveBeenCalledTimes(1);
  });

  it('activates the highlighted session result', async () => {
    const { app } = loadPaletteHarness();
    app.openCommandPalette();
    app.commandPaletteItems = app.buildCommandPaletteItems('api');
    app.commandPaletteActiveIndex = 0;

    await app.activateCommandPaletteItem();

    expect(app.selectSession).toHaveBeenCalledWith('sess-alpha');
    expect(app.run).not.toHaveBeenCalled();
  });

  it('activates the new-session result through the current run path', async () => {
    const { app } = loadPaletteHarness();
    app.openCommandPalette();
    app.commandPaletteItems = app.buildCommandPaletteItems('does-not-match');
    app.commandPaletteActiveIndex = 0;

    await app.activateCommandPaletteItem();

    expect(app.run).toHaveBeenCalledTimes(1);
    expect(app.selectSession).not.toHaveBeenCalled();
  });

  it('routes Enter from the palette search to the current result', async () => {
    const { app, listeners } = loadPaletteHarness();
    app.openCommandPalette();
    app.commandPaletteItems = app.buildCommandPaletteItems('api');
    app.commandPaletteActiveIndex = 0;

    const event = { key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await listeners['search:keydown'](event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(app.selectSession).toHaveBeenCalledWith('sess-alpha');
  });
});

describe('Session Manager unified list', () => {
  it('maps UnifiedSessionItem fields to the history-record shape and routes clicks by liveness', async () => {
    const { app, elements } = loadPaletteHarness({
      fetch: async (url: string) => {
        expect(url).toBe('/api/sessions/unified?limit=200&q=api');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              sessions: [
                {
                  sessionId: 'sess-alpha',
                  name: 'Alpha API cleanup',
                  workingDir: '/repo/api',
                  lastActivityAt: 1751000000000,
                  sources: ['live'],
                },
                {
                  sessionId: 'conv-uuid-1',
                  workingDir: '/repo/old',
                  sizeBytes: 2048,
                  firstPrompt: 'old prompt',
                  lastActivityAt: 1750000000000,
                  sources: ['history'],
                },
              ],
              total: 2,
            },
          }),
        };
      },
    });
    elements.sessionManagerList = { replaceChildren: vi.fn(), appendChild: vi.fn() };
    app._buildHistoryItem = vi.fn(() => ({}));
    app.resumeHistorySession = vi.fn();

    await app._loadSessionManagerList('api');

    expect(app._buildHistoryItem).toHaveBeenCalledTimes(2);
    const [liveRecord, , liveOptions] = app._buildHistoryItem.mock.calls[0];
    expect(liveRecord).toMatchObject({
      sessionId: 'sess-alpha',
      workingDir: '/repo/api',
      sizeBytes: 0,
      firstPrompt: 'Alpha API cleanup',
    });
    expect(new Date(liveRecord.lastModified).getTime()).toBe(1751000000000);
    expect(liveOptions.showViewAll).toBe(false);

    // Live row → switch to the session (resuming it would spawn a duplicate).
    liveOptions.onActivate();
    expect(app.selectSession).toHaveBeenCalledWith('sess-alpha');
    expect(app.resumeHistorySession).not.toHaveBeenCalled();

    // History row → resume by conversation UUID. The trailing `resumeId` is the
    // CLI's own thread token, which only a non-claude transcript scanner sets;
    // a Claude row carries none, so it arrives undefined here.
    const [historyRecord, , historyOptions] = app._buildHistoryItem.mock.calls[1];
    expect(historyRecord).toMatchObject({ sessionId: 'conv-uuid-1', sizeBytes: 2048, firstPrompt: 'old prompt' });
    historyOptions.onActivate();
    expect(app.resumeHistorySession).toHaveBeenCalledWith('conv-uuid-1', '/repo/old', undefined, undefined, undefined);
  });

  it('surfaces an error message instead of an empty list when the endpoint fails', async () => {
    const appended: any[] = [];
    const { app, elements } = loadPaletteHarness({
      fetch: async () => ({
        ok: false,
        status: 503,
        json: async () => ({ success: false, error: 'unified list unavailable', errorCode: 'OPERATION_FAILED' }),
      }),
    });
    elements.sessionManagerList = { replaceChildren: vi.fn(), appendChild: (el: any) => appended.push(el) };

    await app._loadSessionManagerList('');

    expect(appended).toHaveLength(1);
    expect(appended[0].textContent).toBe('unified list unavailable');
    expect(appended[0].textContent).not.toBe('No sessions found');
  });
});

describe('panel close helpers', () => {
  it('closes panels when the mobile header helper is unavailable', () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const elements: Record<string, any> = {
      monitorPanel: { classList: { remove: vi.fn() } },
      subagentsPanel: { classList: { remove: vi.fn() } },
    };
    const context = vm.createContext({
      CodemanApp,
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      console,
    });

    const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
    vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });

    const app = new (CodemanApp as any)();
    app.closeSessionOptions = vi.fn();
    app.closeAppSettings = vi.fn();
    app.cancelCloseSession = vi.fn();
    app.closeTokenStats = vi.fn();

    expect(() => app.closeAllPanels()).not.toThrow();
    expect(elements.monitorPanel.classList.remove).toHaveBeenCalledWith('open');
    expect(elements.subagentsPanel.classList.remove).toHaveBeenCalledWith('open');
  });
});
