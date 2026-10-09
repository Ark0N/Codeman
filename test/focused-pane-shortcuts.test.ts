/**
 * @fileoverview App-level terminal shortcuts act on the pane the keyboard is in.
 *
 * With the split pane open, the global shortcut handler (app.js, capture phase)
 * used to resolve every terminal action against the PRIMARY pane: Ctrl+L typed
 * into Pane B cleared Pane A's display while xterm sent the ^L into Pane B's
 * PTY, and Ctrl+Shift+R restored Pane A's size. `_focusedPane()` (terminal-ui.js)
 * now answers with the pane whose terminal was focused last, and the actions
 * that are about a TERMINAL (clear, restore size) go through it.
 *
 * Close Session is not one of them: it has no default key any more (Ctrl+W is
 * left to the terminal as delete-word, see ctrl-w-never-closes.test.ts), and a
 * key a user binds to it closes the active session, as it always did.
 *
 * Real code under test: constants.js + terminal-ui.js in a `vm` context.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');

function loadApp() {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    window: {},
    document: {
      body: { classList: { contains: () => false } },
      activeElement: null,
      addEventListener: vi.fn(),
      getElementById: () => null,
    },
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    setTimeout: () => 1,
    MobileDetection: { isTouchDevice: () => false },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('terminal-ui.js'), context, { filename: 'terminal-ui.js' });
  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  app.activeSessionId = 'session-a';
  app.terminal = { clear: vi.fn(), cols: 120, rows: 40 };
  app.showToast = vi.fn();
  app.sendResize = vi.fn(async () => true);
  app.getTerminalDimensions = () => ({ cols: 120, rows: 40 });
  return app;
}

function paneB(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-b',
    terminal: { clear: vi.fn(), cols: 60, rows: 30 },
    fit: vi.fn(),
    _destroyed: false,
    ...overrides,
  };
}

describe('_focusedPane()', () => {
  it('is the primary pane until another pane claims the keyboard', () => {
    const app = loadApp();

    const pane = app._focusedPane();

    expect(pane.isPrimary).toBe(true);
    expect(pane.terminal).toBe(app.terminal);
    expect(pane.sessionId).toBe('session-a');
  });

  it('is the second pane after its terminal was focused, and the primary again after the primary was', () => {
    const app = loadApp();
    const tile = paneB();

    app._noteFocusedTile(tile);
    expect(app._focusedPane()).toMatchObject({ isPrimary: false, sessionId: 'session-b', terminal: tile.terminal });

    app._noteFocusedTile(null);
    expect(app._focusedPane().isPrimary).toBe(true);
  });

  it('never answers with a destroyed pane', () => {
    const app = loadApp();
    const tile = paneB();
    app._noteFocusedTile(tile);

    tile._destroyed = true;

    expect(app._focusedPane().isPrimary).toBe(true);
  });
});

describe('terminal shortcuts follow the focused pane', () => {
  it('Ctrl+L clears the focused second pane, not the primary', () => {
    const app = loadApp();
    const tile = paneB();
    app._noteFocusedTile(tile);

    app.clearTerminal();

    expect(tile.terminal.clear).toHaveBeenCalledTimes(1);
    expect(app.terminal.clear).not.toHaveBeenCalled();
  });

  it('Ctrl+L still clears the primary when it holds the keyboard', () => {
    const app = loadApp();

    app.clearTerminal();

    expect(app.terminal.clear).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Shift+R forces the focused second pane's size onto its own PTY", async () => {
    const app = loadApp();
    const tile = paneB();
    app._noteFocusedTile(tile);

    await app.restoreTerminalSize();

    expect(tile.fit).toHaveBeenCalledWith({ force: true });
    expect(app.sendResize).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith('Terminal restored to 60x30', 'success');
  });

  // TerminalTile.fit() returns whether its resize went out. When it did not,
  // Redraw used to report a size that was never sent.
  it.each([
    [
      'popped out to its own window',
      { detached: true, wsReady: true },
      'This session is sized by its own window',
      'warning',
    ],
    [
      'whose socket is down',
      { detached: false, wsReady: false },
      'Terminal not connected: its size is sent when it reconnects',
      'warning',
    ],
    ['that could not measure itself', { detached: false, wsReady: true }, 'Could not determine terminal size', 'error'],
  ])('Ctrl+Shift+R on a second pane %s reports no success', async (_label, state, message, level) => {
    const app = loadApp();
    app.detachedSessions = new Set(state.detached ? ['session-b'] : []);
    const tile = paneB({ fit: vi.fn(() => false), _wsReady: state.wsReady });
    app._noteFocusedTile(tile);

    await app.restoreTerminalSize();

    expect(tile.fit).toHaveBeenCalledWith({ force: true });
    expect(app.showToast).toHaveBeenCalledTimes(1);
    expect(app.showToast).toHaveBeenCalledWith(message, level);
    expect(app.sendResize).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+R keeps restoring the primary when it holds the keyboard', async () => {
    const app = loadApp();

    await app.restoreTerminalSize();

    expect(app.sendResize).toHaveBeenCalledWith('session-a', { force: true });
  });
});

describe('Close Session (user-bound key only) stays on the active session', () => {
  it('killActiveSession closes activeSessionId and never consults the focused pane', () => {
    const appSource = read('app.js');
    const body = appSource.slice(
      appSource.indexOf('async killActiveSession() {'),
      appSource.indexOf('async killAllSessions() {')
    );

    expect(body).toContain('await this.closeSession(this.activeSessionId);');
    expect(body).not.toContain('_focusedPane');
  });
});
