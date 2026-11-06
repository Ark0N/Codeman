/**
 * @fileoverview Ctrl+W never closes a session; it reaches the terminal.
 *
 * "Close Session" used to be bound to Ctrl+W by default. Ctrl+W is "delete the
 * previous word" in every shell, readline prompt and agent CLI, so muscle memory
 * killed the session (its tmux pane and CLI, with no confirm) in the middle of a
 * sentence; with the split pane open it was not even the pane being typed in.
 * The action now has NO default key: the capture-phase shortcut handler lets
 * Ctrl+W through, and xterm sends ^W to the CLI like any other key. The action
 * stays in the registry so a user can still bind a key to it in App Settings →
 * Shortcuts.
 *
 * Real code under test: constants.js + app.js (DEFAULT_SHORTCUTS,
 * getShortcutRegistry, matchesShortcutEvent) in a `vm` context.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');

type Shortcut = { id: string; action?: string; bindings?: unknown[]; disabled?: boolean };
type App = {
  getShortcutRegistry(): Shortcut[];
  matchesShortcutEvent(e: Record<string, unknown>, s: Shortcut): boolean;
  loadAppSettingsFromStorage: () => Record<string, unknown>;
};

function makeApp(settings: Record<string, unknown> = {}): App {
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
    document: { addEventListener: vi.fn() },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${read('constants.js')}\n${read('app.js')}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;
  const app = Object.create(CodemanApp.prototype) as App;
  app.loadAppSettingsFromStorage = () => settings;
  return app;
}

const keydown = (overrides: Record<string, unknown>) => ({
  type: 'keydown',
  key: 'w',
  code: 'KeyW',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe('Ctrl+W is left to the terminal', () => {
  it('Close Session is still in the registry, with no default key', () => {
    const close = makeApp()
      .getShortcutRegistry()
      .find((s) => s.id === 'close-session');

    expect(close?.action).toBe('killActiveSession');
    expect(close?.bindings).toEqual([]);
  });

  it.each([
    ['Ctrl+W', { ctrlKey: true }],
    ['Cmd+W', { metaKey: true }],
  ])('no default shortcut answers %s, so the capture handler lets it reach xterm', (_name, mods) => {
    const app = makeApp();
    const event = keydown(mods);

    const matched = app.getShortcutRegistry().filter((s) => !s.disabled && s.action && app.matchesShortcutEvent(event, s));

    expect(matched.map((s) => s.id)).toEqual([]);
  });

  it('a user can still bind a key to Close Session', () => {
    const app = makeApp({
      shortcutOverrides: { 'close-session': { bindings: [{ modifiers: ['ctrl', 'shift'], key: 'w' }] } },
    });
    const close = app.getShortcutRegistry().find((s) => s.id === 'close-session')!;

    expect(app.matchesShortcutEvent(keydown({ ctrlKey: true, shiftKey: true, key: 'W' }), close)).toBe(true);
    expect(app.matchesShortcutEvent(keydown({ ctrlKey: true }), close)).toBe(false);
  });

  it('the shortcut overlay says an unbound action is not bound', () => {
    const appSource = read('app.js');
    const overlay = appSource.slice(appSource.indexOf('renderShortcutOverlay() {'), appSource.indexOf('closeShortcutOverlay() {'));

    expect(overlay).toContain("if (s.bindings.length === 0) return '<span class=\"shortcut-overlay-unbound\">not bound</span>';");
  });
});
