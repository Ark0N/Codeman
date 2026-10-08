import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const appSource = readFileSync('src/web/public/app.js', 'utf8');
const settingsSource = readFileSync('src/web/public/settings-ui.js', 'utf8');
const htmlSource = readFileSync('src/web/public/index.html', 'utf8');

describe('shortcut registry and overlay', () => {
  it('defines shortcut metadata that can be overridden from global settings', () => {
    expect(appSource).toContain('const DEFAULT_SHORTCUTS = [');
    expect(appSource).toContain('shortcutOverrides');
    expect(appSource).toContain('getShortcutRegistry()');
    expect(appSource).toContain('matchesShortcutEvent(e, shortcut)');
  });

  it('renders a shortcut overlay modal from the registry', () => {
    expect(htmlSource).toContain('id="shortcutOverlayModal"');
    expect(htmlSource).toContain('id="shortcutOverlayList"');
    expect(appSource).toContain('showShortcutOverlay()');
    expect(appSource).toContain('renderShortcutOverlay()');
    expect(appSource).toContain('closeShortcutOverlay()');
  });

  it('adds Ctrl/Option question-mark bindings for the overlay', () => {
    expect(appSource).toContain("id: 'show-shortcuts'");
    expect(appSource).toContain("modifiers: ['ctrl']");
    expect(appSource).toContain("modifiers: ['alt']");
    expect(appSource).toContain("key: '?'");
    expect(appSource).toContain("code: 'Slash'");
    expect(appSource).not.toContain("key: '/'");
  });

  it('exposes shortcut overrides in a dedicated App Settings shortcuts section', () => {
    expect(htmlSource).toContain('data-section="settings-shortcuts"');
    expect(htmlSource).toContain('id="settings-shortcuts"');
    expect(htmlSource).toContain('id="appSettingsShortcutsList"');
    expect(htmlSource).not.toContain('id="appSettingsShortcutOverrides"');
    expect(htmlSource).not.toContain('Shortcut Overrides</span>');
    expect(settingsSource).toContain('renderShortcutSettingsList');
    expect(settingsSource).toContain('readShortcutOverridesFromSettings');
    expect(settingsSource).toContain('startShortcutCapture');
    expect(settingsSource).toContain('onShortcutCaptureKeydown');
    expect(settingsSource).toContain('settings.shortcutOverrides');
  });

  it('renders shortcut rows with capture, typed input, reset, and disable controls', () => {
    expect(settingsSource).toContain('shortcut-setting-row');
    expect(settingsSource).toContain('shortcut-capture-btn');
    expect(settingsSource).toContain('shortcut-binding-input');
    expect(settingsSource).toContain('shortcut-reset-btn');
    expect(settingsSource).toContain('shortcut-enabled-checkbox');
  });

  it('styles the shortcut settings rows and overlay (no unstyled tab)', () => {
    const css = readFileSync('src/web/public/styles.css', 'utf8');
    expect(css).toContain('.shortcut-setting-row {');
    expect(css).toContain('.shortcut-capture-btn,');
    expect(css).toContain('.shortcut-overlay-row {');
  });

  it('saveAppSettings preserves shortcutOverrides (rebuilt-from-DOM saves must not wipe them)', () => {
    // Same trap as showTokenCount/showCost: saveAppSettings() rebuilds the settings
    // object fresh from the DOM, so keys edited elsewhere (the Shortcuts tab) must be
    // explicitly carried over from the previously stored blob.
    expect(settingsSource).toContain(
      'if (_prev.shortcutOverrides !== undefined) settings.shortcutOverrides = _prev.shortcutOverrides;'
    );
  });

  it('keeps shortcutOverrides out of the settings PUT (the .strict() schema would 400 the whole save)', async () => {
    // Overrides are per-device and live only in the localStorage blob. Before this
    // strip, any device with an override (even an empty {} left by Reset) sent the
    // key on every App Settings save, and the server refused the whole PUT, so no
    // synced setting reached it again.
    expect(settingsSource).toContain('shortcutOverrides: _sco,');
    const { SettingsUpdateSchema } = await import('../src/web/schemas.js');
    expect(SettingsUpdateSchema.safeParse({ shortcutOverrides: {} }).success).toBe(false);
  });

  it('keeps the full help modal reachable now that Ctrl+? opens the registry overlay', () => {
    // The legacy #helpModal (full shortcut reference) lost its only opener when
    // Ctrl+? was rerouted to the overlay; the overlay footer must link to it.
    expect(htmlSource).toContain('shortcut-overlay-footer');
    expect(htmlSource).toContain('app.closeShortcutOverlay(); app.showHelp()');
  });
});

// ─── Functional coverage (vm-sandbox harness, mirrors run-mode-ui.test.ts) ────
// The grep assertions above pin the wiring; these exercise the actual
// persistence round-trip and capture flow that were broken in review.

function makeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

function loadSettingsHarness() {
  const CodemanApp = function CodemanApp(this: any) {};
  const localStorage = makeLocalStorage();
  const elements: Record<string, any> = {};
  const holder: { queryResult: any } = { queryResult: null };
  const context = vm.createContext({
    CodemanApp,
    MobileDetection: { getDeviceType: () => 'desktop', isMobile: () => false, isTouchDevice: () => false },
    localStorage,
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      querySelector: () => holder.queryResult,
    },
    console,
    escapeHtml: (s: string) => String(s),
  });

  const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
  vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });

  const app = new (CodemanApp as any)();
  return { app, localStorage, elements, holder };
}

describe('shortcut settings persistence and capture', () => {
  it('persists overrides under the app-settings storage key and round-trips through the cache', () => {
    const { app, localStorage } = loadSettingsHarness();

    app.toggleShortcutEnabled('close-session', false);

    // Written to the SAME key loadAppSettingsFromStorage() reads (NOT the
    // legacy 'codeman:settings' key), and the in-memory cache stays coherent.
    const raw = localStorage.getItem('codeman-app-settings');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).shortcutOverrides['close-session']).toMatchObject({ disabled: true });
    expect(localStorage.getItem('codeman:settings')).toBeNull();
    expect(app.readShortcutOverridesFromSettings()['close-session']).toMatchObject({ disabled: true });

    app.resetShortcutOverride('close-session');
    const after = JSON.parse(localStorage.getItem('codeman-app-settings')!);
    expect(after.shortcutOverrides['close-session']).toBeUndefined();
    expect(app.readShortcutOverridesFromSettings()['close-session']).toBeUndefined();
  });

  it('captures multi-modifier combos: bare modifier keydowns do not end the capture', () => {
    const { app, localStorage, holder } = loadSettingsHarness();
    const listeners: Array<(e: any) => void> = [];
    const input = {
      value: '',
      focus: vi.fn(),
      addEventListener: vi.fn((_ev: string, fn: (e: any) => void) => listeners.push(fn)),
      removeEventListener: vi.fn(),
    };
    holder.queryResult = input;

    app.startShortcutCapture('clear-terminal');
    expect(input.value).toBe('Press keys…');
    const handler = listeners[0];

    // First keydown of Ctrl+Shift+P is 'Control' — must not finalize.
    handler({ key: 'Control', ctrlKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(input.removeEventListener).not.toHaveBeenCalled();

    handler({
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      shiftKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(input.removeEventListener).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem('codeman-app-settings')!);
    expect(stored.shortcutOverrides['clear-terminal'].bindings[0]).toMatchObject({
      modifiers: ['ctrl', 'shift'],
      key: 'P',
      code: 'KeyP',
    });
  });

  it('rejects captures without a Ctrl/Cmd/Alt modifier (a bare key would fire while typing)', () => {
    const { app, localStorage, holder } = loadSettingsHarness();
    const listeners: Array<(e: any) => void> = [];
    holder.queryResult = {
      value: '',
      focus: vi.fn(),
      addEventListener: vi.fn((_ev: string, fn: (e: any) => void) => listeners.push(fn)),
      removeEventListener: vi.fn(),
    };
    app.showToast = vi.fn();

    app.startShortcutCapture('clear-terminal');
    listeners[0]({ key: 'x', code: 'KeyX', preventDefault: vi.fn(), stopPropagation: vi.fn() });

    expect(localStorage.getItem('codeman-app-settings')).toBeNull();
    expect(app.showToast).toHaveBeenCalledWith('Shortcut must include Ctrl, Cmd, or Alt', 'error');
  });

  it('renders the shortcuts list when the Shortcuts settings section is reached', () => {
    const { app, elements } = loadSettingsHarness();
    elements.appSettingsModal = { querySelectorAll: () => [] };
    app.renderShortcutSettingsList = vi.fn();

    app.switchSettingsTab('settings-shortcuts');
    expect(app.renderShortcutSettingsList).toHaveBeenCalledTimes(1);

    app.switchSettingsTab('settings-terminal');
    expect(app.renderShortcutSettingsList).toHaveBeenCalledTimes(1);
  });

  it('renders configurable rows with delegated controls (no inline onclick) and fixed rows read-only', () => {
    const { app, elements } = loadSettingsHarness();
    const list: any = { innerHTML: '', dataset: {}, addEventListener: vi.fn() };
    elements.appSettingsShortcutsList = list;
    app.getShortcutRegistry = () => [
      {
        id: 'clear-terminal',
        group: 'Terminal',
        label: 'Clear Terminal',
        bindings: [{ modifiers: ['ctrl'], key: 'l' }],
        action: 'clearTerminal',
      },
      { id: 'close-panels', group: 'Panels', label: 'Close Panels', displayBindings: ['Escape'] },
    ];

    app.renderShortcutSettingsList();

    expect(list.innerHTML).not.toContain('onclick=');
    expect((list.innerHTML.match(/shortcut-capture-btn/g) || []).length).toBe(1);
    expect(list.innerHTML).toContain('shortcut-setting-row--fixed');
    // Delegated listeners wired exactly once.
    expect(list.addEventListener).toHaveBeenCalledTimes(2);
    app.renderShortcutSettingsList();
    expect(list.addEventListener).toHaveBeenCalledTimes(2);
  });
});
