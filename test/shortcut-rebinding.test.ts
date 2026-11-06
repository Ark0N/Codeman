/**
 * @fileoverview Behaviour of shortcut rebinding: Alt+[ / Alt+] as registry entries, the
 * user-bound gate that keeps a rebound chord out of the PTY, and refusal of duplicate chords.
 *
 * Real code under test: constants.js + app.js + settings-ui.js in one `vm` context (the
 * makeApp() harness of ctrl-w-never-closes.test.ts, with settings-ui.js loaded after app.js).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');

type Shortcut = { id: string; label: string; action?: string; bindings?: unknown[]; disabled?: boolean };
type App = {
  getShortcutRegistry(): Shortcut[];
  matchesShortcutEvent(e: Record<string, unknown>, s: Shortcut): boolean;
  isUserBoundShortcutEvent(e: Record<string, unknown>): boolean;
  findShortcutConflict(e: Record<string, unknown>, id: string): string;
  onShortcutCaptureKeydown(e: Record<string, unknown>, id: string): void;
  toggleShortcutEnabled(id: string, enabled: boolean): void;
  resetShortcutOverride(id: string): void;
  loadAppSettingsFromStorage: () => Record<string, any>;
  saveAppSettingsToStorage: (s: Record<string, any>) => void;
  renderShortcutSettingsList: () => void;
  showToast: (msg: string, type?: string) => void;
};

function makeApp(initial: Record<string, any> = {}) {
  const settings: Record<string, any> = structuredClone(initial);
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { getDeviceType: () => 'desktop', isMobile: () => false, isTouchDevice: () => false },
  });
  vm.runInContext(`${read('constants.js')}\n${read('app.js')}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  vm.runInContext(read('settings-ui.js'), context, { filename: 'settings-ui.js' });
  const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;
  const app = Object.create(CodemanApp.prototype) as App;
  app.loadAppSettingsFromStorage = () => settings;
  app.saveAppSettingsToStorage = (s) => {
    const next = { ...s };
    Object.keys(settings).forEach((k) => delete settings[k]);
    Object.assign(settings, next);
  };
  app.renderShortcutSettingsList = vi.fn();
  app.showToast = vi.fn();
  return { app, settings };
}

const key = (o: Record<string, unknown>) => ({
  type: 'keydown',
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...o,
});

const ownerOf = (app: App, e: Record<string, unknown>) =>
  app.getShortcutRegistry().find((s) => !s.disabled && s.action && app.matchesShortcutEvent(e, s))?.action;

describe('Alt+[ and Alt+] are registry entries', () => {
  it('resolve to previousSession and nextSession by physical key', () => {
    const { app } = makeApp();
    expect(ownerOf(app, key({ altKey: true, key: '[', code: 'BracketLeft' }))).toBe('previousSession');
    expect(ownerOf(app, key({ altKey: true, key: ']', code: 'BracketRight' }))).toBe('nextSession');
  });

  it('match the macOS Option layout that prints a curly quote for Option+[', () => {
    const { app } = makeApp();
    expect(ownerOf(app, key({ altKey: true, key: '“', code: 'BracketLeft' }))).toBe('previousSession');
  });

  it('keep their Alt/Option+[ labels until rebound', () => {
    const { app } = makeApp({
      shortcutOverrides: { 'next-session-alt': { bindings: [{ modifiers: ['alt'], key: 'j' }] } },
    });
    const byId = (id: string) =>
      app.getShortcutRegistry().find((s) => s.id === id) as Shortcut & { displayBindings?: string[] };
    expect(byId('previous-session').displayBindings).toEqual(['Alt/Option+[']);
    expect(byId('next-session-alt').displayBindings).toBeUndefined();
  });
});

describe('isUserBoundShortcutEvent', () => {
  const altJ = key({ altKey: true, key: 'j', code: 'KeyJ' });

  it('is false with no overrides, even for a default chord', () => {
    const { app } = makeApp();
    expect(app.isUserBoundShortcutEvent(key({ altKey: true, key: '[', code: 'BracketLeft' }))).toBe(false);
    expect(app.isUserBoundShortcutEvent(key({ ctrlKey: true, key: 'l', code: 'KeyL' }))).toBe(false);
  });

  it('is true for a chord the user rebound an action to', () => {
    const { app } = makeApp({
      shortcutOverrides: { 'previous-session': { bindings: [{ modifiers: ['alt'], key: 'j', code: 'KeyJ' }] } },
    });
    expect(app.isUserBoundShortcutEvent(altJ)).toBe(true);
  });

  it('is false for the copy-selection rebind, which has its own dispatch', () => {
    const { app } = makeApp({
      shortcutOverrides: { 'copy-selection': { bindings: [{ modifiers: ['alt'], key: 'j', code: 'KeyJ' }] } },
    });
    expect(app.isUserBoundShortcutEvent(altJ)).toBe(false);
  });

  it('is false for a rebound sidebar toggle, whose own gate lets the chord through', () => {
    const { app } = makeApp({
      shortcutOverrides: { 'toggle-session-sidebar': { bindings: [{ modifiers: ['alt'], key: 's', code: 'KeyS' }] } },
    });
    expect(app.isUserBoundShortcutEvent(key({ altKey: true, key: 's', code: 'KeyS' }))).toBe(false);
  });

  it('is false when the entry was re-captured onto its own default (Ctrl+L still reaches the CLI)', () => {
    const { app } = makeApp({
      shortcutOverrides: { 'clear-terminal': { bindings: [{ modifiers: ['ctrl'], key: 'l', code: 'KeyL' }] } },
    });
    expect(app.isUserBoundShortcutEvent(key({ ctrlKey: true, key: 'l', code: 'KeyL' }))).toBe(false);
  });

  it('is false for a disabled rebound entry', () => {
    const { app } = makeApp({
      shortcutOverrides: {
        'previous-session': { bindings: [{ modifiers: ['alt'], key: 'j', code: 'KeyJ' }], disabled: true },
      },
    });
    expect(app.isUserBoundShortcutEvent(altJ)).toBe(false);
  });
});

describe('duplicate chords are refused', () => {
  const ctrlL = key({ ctrlKey: true, key: 'l', code: 'KeyL' });

  it("a capture onto another action's chord names the owner and stores nothing", () => {
    const { app, settings } = makeApp();
    app.onShortcutCaptureKeydown(ctrlL, 'next-session-alt');
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('already used by Clear Terminal'), 'error');
    expect(settings.shortcutOverrides).toBeUndefined();
  });

  it("a shortcut's own id and a disabled owner are free", () => {
    const { app } = makeApp({ shortcutOverrides: { 'previous-session': { disabled: true } } });
    expect(app.findShortcutConflict(ctrlL, 'clear-terminal')).toBe('');
    expect(app.findShortcutConflict(key({ altKey: true, key: '[', code: 'BracketLeft' }), 'next-session-alt')).toBe('');
  });

  it.each([
    ['Alt+1', { altKey: true, key: '¡', code: 'Digit1' }],
    ['Cmd+Alt+1', { altKey: true, metaKey: true, key: '¡', code: 'Digit1' }],
    ['Ctrl+Enter', { ctrlKey: true, key: 'Enter', code: 'Enter' }],
    ['Shift+Enter', { shiftKey: true, key: 'Enter', code: 'Enter' }],
    ['Ctrl+V', { ctrlKey: true, key: 'v', code: 'KeyV' }],
    ['Cmd+V', { metaKey: true, key: 'v', code: 'KeyV' }],
  ])('%s is reserved', (_n, ev) => {
    const { app } = makeApp();
    expect(app.findShortcutConflict(key(ev), 'previous-session')).not.toBe('');
  });

  it('no two default shortcuts share a chord', () => {
    const { app } = makeApp();
    for (const s of app.getShortcutRegistry()) {
      for (const b of (s.bindings || []) as { modifiers?: string[]; key?: string; code?: string }[]) {
        const m = b.modifiers || [];
        const ev = key({
          ctrlKey: m.includes('ctrl'),
          metaKey: m.includes('meta'),
          shiftKey: m.includes('shift'),
          altKey: m.includes('alt'),
          key: b.key || '',
          code: b.code || '',
        });
        expect({ id: s.id, owner: app.findShortcutConflict(ev, s.id) }).toEqual({ id: s.id, owner: '' });
      }
    }
  });

  it('re-enabling a disabled action whose chord was taken is refused and leaves it disabled', () => {
    const { app, settings } = makeApp({
      shortcutOverrides: {
        'clear-terminal': { disabled: true },
        'next-session-alt': { bindings: [{ modifiers: ['ctrl'], key: 'l', code: 'KeyL' }] },
      },
    });
    app.toggleShortcutEnabled('clear-terminal', true);
    expect(app.showToast).toHaveBeenCalledWith(
      expect.stringContaining('already used by Next Session (alternate)'),
      'error'
    );
    expect(settings.shortcutOverrides['clear-terminal'].disabled).toBe(true);
  });

  it('re-enabling with no clash enables it', () => {
    const { app, settings } = makeApp({ shortcutOverrides: { 'clear-terminal': { disabled: true } } });
    app.toggleShortcutEnabled('clear-terminal', true);
    expect(settings.shortcutOverrides['clear-terminal'].disabled).toBe(false);
  });

  it('Reset is refused while another action owns the default chord, and works once it is free', () => {
    const { app, settings } = makeApp({
      shortcutOverrides: {
        'clear-terminal': { bindings: [{ modifiers: ['ctrl'], key: 'j', code: 'KeyJ' }] },
        'next-session-alt': { bindings: [{ modifiers: ['ctrl'], key: 'l', code: 'KeyL' }] },
      },
    });
    app.resetShortcutOverride('clear-terminal');
    expect(app.showToast).toHaveBeenCalledWith(
      expect.stringContaining('already used by Next Session (alternate)'),
      'error'
    );
    expect(settings.shortcutOverrides['clear-terminal']).toBeDefined();

    app.resetShortcutOverride('next-session-alt');
    app.resetShortcutOverride('clear-terminal');
    expect(settings.shortcutOverrides['clear-terminal']).toBeUndefined();
  });
});
