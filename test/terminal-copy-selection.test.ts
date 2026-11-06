/**
 * Smart-copy chord gate (#211).
 *
 * `Ctrl+C` has to keep meaning "interrupt" whenever nothing is selected, so the
 * decision is split in two: `shouldCopyTerminalSelectionFromShortcut()` only
 * answers "did this chord ask to copy", and the caller in the xterm custom key
 * handler decides what to do when there is no selection. These tests pin the
 * gate itself (registry-aware, keydown-only) plus the static invariants that
 * keep the generic capture loop from ever swallowing the interrupt.
 *
 * Strategy: run terminal-ui.js in a vm with a stub CodemanApp, the same harness
 * shape test/command-palette-ui.test.ts uses for panels-ui.js. No DOM, no xterm.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const APP_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

type Shortcut = {
  id: string;
  disabled?: boolean;
  bindings?: Array<{ modifiers?: string[]; key?: string; code?: string }>;
};

function loadTerminalHarness(registry?: Shortcut[]) {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    CodemanApp,
    window: {},
    document: { getElementById: () => null, querySelector: () => null },
    console,
    MobileDetection: { isTouchDevice: () => false, getDeviceType: () => 'desktop' },
    Object,
  });
  const terminalUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(terminalUi, context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  if (registry) {
    app.getShortcutRegistry = () => registry;
    // Real implementation, copied by reference from app.js semantics: ctrl/meta are
    // interchangeable, every other modifier must be declared by the binding.
    app.matchesShortcutEvent = (e: any, shortcut: Shortcut) => {
      if (!shortcut || !Array.isArray(shortcut.bindings)) return false;
      return shortcut.bindings.some((binding) => {
        const mods = binding.modifiers || [];
        const wantsPrimary = mods.includes('ctrl') || mods.includes('meta');
        if (wantsPrimary !== !!(e.ctrlKey || e.metaKey)) return false;
        if (mods.includes('shift') !== !!e.shiftKey) return false;
        if (mods.includes('alt') !== !!e.altKey) return false;
        if (binding.code && e.code === binding.code) return true;
        if (binding.key && typeof e.key === 'string' && e.key.toLowerCase() === binding.key.toLowerCase()) return true;
        return false;
      });
    };
  }
  return app;
}

const DEFAULT_REGISTRY: Shortcut[] = [
  {
    id: 'copy-selection',
    bindings: [
      { modifiers: ['ctrl'], key: 'c' },
      { modifiers: ['ctrl', 'shift'], key: 'C' },
    ],
  },
];

function keydown(over: Record<string, unknown> = {}) {
  return {
    type: 'keydown',
    key: 'c',
    code: 'KeyC',
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  };
}

describe('terminal smart-copy gate', () => {
  it('matches the default Ctrl+C and Ctrl+Shift+C chords', () => {
    const app = loadTerminalHarness(DEFAULT_REGISTRY);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown())).toBe(true);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown({ key: 'C', shiftKey: true }))).toBe(true);
    // Cmd+C on macOS: the registry treats ctrl/meta as interchangeable.
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown({ ctrlKey: false, metaKey: true }))).toBe(true);
  });

  it('ignores plain typing and unrelated chords', () => {
    const app = loadTerminalHarness(DEFAULT_REGISTRY);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown({ ctrlKey: false }))).toBe(false);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown({ key: 'k', code: 'KeyK' }))).toBe(false);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown({ key: 'v', code: 'KeyV' }))).toBe(false);
  });

  it('only decides on keydown (the handler also runs for keypress and keyup)', () => {
    const app = loadTerminalHarness(DEFAULT_REGISTRY);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown({ type: 'keypress' }))).toBe(false);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown({ type: 'keyup' }))).toBe(false);
    expect(app.shouldCopyTerminalSelectionFromShortcut(null)).toBe(false);
  });

  it('honors a disabled shortcut so Ctrl+C goes back to being the interrupt', () => {
    const app = loadTerminalHarness([{ ...DEFAULT_REGISTRY[0], disabled: true }]);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown())).toBe(false);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown({ key: 'C', shiftKey: true }))).toBe(false);
  });

  it('honors a rebound chord and stops claiming the old one', () => {
    const app = loadTerminalHarness([{ id: 'copy-selection', bindings: [{ modifiers: ['alt'], key: 'y' }] }]);
    expect(
      app.shouldCopyTerminalSelectionFromShortcut(keydown({ ctrlKey: false, altKey: true, key: 'y', code: 'KeyY' }))
    ).toBe(true);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown())).toBe(false);
  });

  it('falls back to the default chord when no registry is available', () => {
    const app = loadTerminalHarness(); // no getShortcutRegistry / matchesShortcutEvent
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown())).toBe(true);
    expect(app.shouldCopyTerminalSelectionFromShortcut(keydown({ key: 'x', code: 'KeyX' }))).toBe(false);
  });
});

describe('smart-copy wiring invariants', () => {
  it('registers copy-selection in the shortcut registry', () => {
    expect(APP_SOURCE).toContain("id: 'copy-selection'");
    expect(APP_SOURCE).toContain("action: 'copyTerminalSelection'");
  });

  it('keeps copyTerminalSelection OUT of SHORTCUT_ACTIONS', () => {
    // The generic capture loop preventDefaults on every match it dispatches. If
    // the copy action were reachable from there, Ctrl+C would be swallowed with
    // no selection and the user would lose the interrupt key.
    const actionsBlock = APP_SOURCE.slice(
      APP_SOURCE.indexOf('_shortcutActions() {'),
      APP_SOURCE.indexOf('isUserBoundShortcutEvent(e) {')
    );
    expect(actionsBlock.length).toBeGreaterThan(0);
    expect(actionsBlock).not.toContain('copyTerminalSelection');
  });
});
