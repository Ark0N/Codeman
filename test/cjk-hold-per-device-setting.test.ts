// test/cjk-hold-per-device-setting.test.ts
// Port: none (static analysis + vm, runs in CI, no browser/server).
//
// Send on Enter for the CJK input field (`cjkInputHoldUntilEnter`) is a
// PER-DEVICE setting like `cjkInputEnabled`: in settings-ui.js's displayKeys
// merge policy, stripped out of the object saveAppSettings() PUTs
// (SettingsUpdateSchema is .strict(), so sending it would 400 every save), and
// never declared in the schema. Plus the pieces around the mode: a held draft
// surviving a reload of the same session, the field staying one line tall with
// the keyboard down, and zh-CN strings for its placeholders.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, '../src/web/public');
const read = (file: string) => readFileSync(join(PUBLIC, file), 'utf8');

describe('cjkInputHoldUntilEnter stays per-device: display key, stripped from the PUT, absent from the schema', () => {
  const settingsUi = read('settings-ui.js');
  const schemas = readFileSync(join(HERE, '../src/web/schemas.ts'), 'utf8');

  it('is in the client-side displayKeys merge policy', () => {
    const start = settingsUi.indexOf('const displayKeys = new Set([');
    const displayKeys = settingsUi.slice(start, settingsUi.indexOf('])', start));
    expect(displayKeys).toContain("'cjkInputHoldUntilEnter'");
  });

  it('is stripped out of the object saveAppSettings() PUTs to the server', () => {
    expect(settingsUi).toContain('cjkInputHoldUntilEnter: _cjkHold,');
  });

  it('is never declared in the .strict() SettingsUpdateSchema', () => {
    expect(schemas).not.toContain('cjkInputHoldUntilEnter');
  });

  it('defaults OFF on handhelds, next to cjkInputEnabled', () => {
    expect(settingsUi).toMatch(/cjkInputEnabled: false,\s*cjkInputHoldUntilEnter: false,/);
  });

  it('is loaded into and saved from its App Settings switch', () => {
    expect(read('index.html')).toContain('id="appSettingsCjkHoldUntilEnter"');
    expect(settingsUi).toContain("document.getElementById('appSettingsCjkHoldUntilEnter').checked =");
    expect(settingsUi).toContain(
      "cjkInputHoldUntilEnter: document.getElementById('appSettingsCjkHoldUntilEnter').checked,"
    );
  });
});

describe('a held draft survives a reload of the same session', () => {
  // The REAL _cleanupPreviousSession from app.js. selectSession() nulls
  // activeSessionId before calling it on a same-session forceReload (tapping the
  // tab already shown, the geometry retry), so it is told through keepCjkDraft.
  function cleanup(hold: boolean, keepCjkDraft: boolean, outgoing: string | null = null) {
    const clear = vi.fn();
    const stashDraft = vi.fn();
    const context = vm.createContext({
      console,
      setTimeout,
      clearTimeout,
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      requestAnimationFrame: vi.fn(),
      HTMLCanvasElement: class HTMLCanvasElement {},
      WebSocket: { OPEN: 1 },
      fetch: vi.fn(),
      URLSearchParams,
      document: { addEventListener: vi.fn(), documentElement: { dataset: {} }, getElementById: () => null },
      localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      MobileDetection: { isTouchDevice: () => true, isHandheldDevice: () => true, getDeviceType: () => 'mobile' },
      CjkInput: { holdUntilEnter: hold, clear, stashDraft },
    });
    vm.runInContext(`${read('constants.js')}\n${read('app.js')}\nglobalThis.__CodemanApp = CodemanApp;`, context);
    const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;
    const app = Object.create(CodemanApp.prototype) as Record<string, unknown> & {
      _cleanupPreviousSession(id: string, opts?: { keepCjkDraft?: boolean }): void;
    };
    app.activeSessionId = outgoing;
    app.sessions = new Map();
    app._clearTimer = vi.fn();
    app._disconnectWs = vi.fn();
    app._xtermSnapshots = new Map();
    app.pendingWrites = [];
    app._cleanupPreviousSession('s1', { keepCjkDraft });
    return Object.assign(clear, { stashDraft });
  }

  it('keeps the draft on a same-session reload in Send on Enter mode', () => {
    expect(cleanup(true, true)).not.toHaveBeenCalled();
  });

  it('still clears on a real switch', () => {
    expect(cleanup(true, false)).toHaveBeenCalled();
  });

  it('still clears in live mode, where a pending flush could fire mid-reconnect', () => {
    expect(cleanup(false, true)).toHaveBeenCalled();
  });

  it('stashes the held draft of the session being left before clearing', () => {
    const clear = cleanup(true, false, 's0');
    expect(clear.stashDraft).toHaveBeenCalledWith('s0');
    expect(clear.stashDraft.mock.invocationCallOrder[0]).toBeLessThan(clear.mock.invocationCallOrder[0]);
  });

  it('selectSession restores the draft of the session it lands on', () => {
    // After _activateFileBrowserSession: test/file-browser-search.test.ts pins
    // that call as the line right after the activeSessionId assignment.
    expect(read('app.js')).toContain(
      "this.activeSessionId = sessionId;\n    this._activateFileBrowserSession?.(sessionId);\n    if (typeof CjkInput !== 'undefined') CjkInput.restoreDraft?.(sessionId);"
    );
  });

  it('leaving the tile grid for another session stashes the focused tile draft', () => {
    // selectSession nulls activeSessionId there, which hides the tile from
    // _cleanupPreviousSession.
    expect(read('app.js')).toMatch(
      /CjkInput\.stashDraft\?\.\(this\.activeSessionId\);\n(?:\s*\/\/.*\n)*\s*this\.activeSessionId = null;/
    );
  });

  it('tile focus does not stash again for a tile closed from this tab', () => {
    // removeSession discards the closed session's draft first; a stash after
    // that would keep it in the map until the page reloads.
    expect(read('tile-grid.js')).toContain(
      'if (this.sessions?.has(this.activeSessionId)) CjkInput.stashDraft?.(this.activeSessionId);'
    );
  });

  it('tile focus stashes the draft of the tile left and restores the focused one', () => {
    const tiles = read('tile-grid.js');
    const start = tiles.indexOf('  _selectTiledSession(sessionId, options = {}) {');
    const body = tiles.slice(start, tiles.indexOf('grid.focusedId = sessionId;', start));
    expect(body).toMatch(
      /CjkInput\.stashDraft\?\.\(this\.activeSessionId\);\s*CjkInput\.clear\(\);\s*\}\s*CjkInput\.restoreDraft\?\.\(sessionId\);\s*\}\s*this\.activeSessionId = sessionId;/
    );
  });

  it('going Home stashes the draft of the session it leaves', () => {
    const appJs = read('app.js');
    const start = appJs.indexOf('  goHome() {');
    const body = appJs.slice(start, appJs.indexOf('this.activeSessionId = null;', start));
    expect(body).toContain('CjkInput.stashDraft?.(this.activeSessionId);');
  });

  it('a removed session drops its stashed draft', () => {
    expect(read('app.js')).toMatch(
      /discardComposerDraft\?\.\(sessionId\);\n\s*if \(typeof CjkInput !== 'undefined'\) CjkInput\.discardDraft\?\.\(sessionId\);/
    );
  });

  it('selectSession passes the same-session flag it captured before nulling activeSessionId', () => {
    const appJs = read('app.js');
    expect(appJs).toMatch(
      /if \(this\.activeSessionId === sessionId && forceReload\) \{\s*reloadingSameSession = true;/
    );
    expect(appJs).toContain('this._cleanupPreviousSession(sessionId, { keepCjkDraft: reloadingSameSession });');
    // Nothing in the same-session reload block may clear the field ahead of
    // that flag: a CjkInput.clear() there wipes the held draft keepCjkDraft keeps.
    const start = appJs.indexOf('if (this.activeSessionId === sessionId && forceReload) {');
    const block = appJs.slice(start, appJs.indexOf('this.activeSessionId = null;', start));
    expect(block).not.toContain('CjkInput.clear');
  });
});

describe('Send on Enter field layout and strings', () => {
  it('keeps the field one line tall while the keyboard is down', () => {
    // .main reserves a fixed 84px there; a grown field would cover the terminal.
    expect(read('styles.css')).toMatch(
      /\.touch-device:not\(\.keyboard-visible\) #cjkInput\.cjk-input-visible \{\s*max-height: 34px;\s*\}/
    );
  });

  it('caps the field on every device, not only in the .touch-device rule', () => {
    // The setting is not limited to phones; on desktop an uncapped field grew to
    // 502px at 25 lines and resized the PTY on every step.
    const css = read('styles.css');
    const base = css.slice(css.indexOf('#cjkInput {'), css.indexOf('}', css.indexOf('#cjkInput {')));
    expect(base).toContain('max-height: 68px;');
    expect(base).toContain('overflow-y: auto;');
  });

  it('the phone toolbar Enter presses Enter in the visible CJK field, not a bare terminal Enter', () => {
    // onData drops everything while cjkActive, so the xterm path does nothing.
    // The real sendEnterKey from session-ui.js, run with and without the field.
    for (const visible of [true, false]) {
      const submit = vi.fn();
      const field = { classList: { contains: (name: string) => visible && name === 'cjk-input-visible' } };
      const context = vm.createContext({
        CodemanApp: function CodemanApp() {},
        CjkInput: { submit },
        document: { getElementById: (id: string) => (id === 'cjkInput' ? field : null) },
      });
      vm.runInContext(`${read('session-ui.js')}\nglobalThis.__mixin = CodemanApp.prototype;`, context);
      const mixin = (context as unknown as { __mixin: { sendEnterKey(this: object): void } }).__mixin;
      const submitFromToolbar = vi.fn();
      mixin.sendEnterKey.call({ submitFromToolbar });
      expect(submit).toHaveBeenCalledTimes(visible ? 1 : 0);
      expect(submitFromToolbar).toHaveBeenCalledTimes(visible ? 0 : 1);
    }
  });

  it('has zh-CN strings for both field placeholders', () => {
    const i18n = read('i18n.js');
    const cjk = read('input-cjk.js');
    for (const placeholder of [
      'CJK input (Enter = send, Esc = clear)',
      'Type, Enter to send (Shift+Enter: new line, Esc: clear)',
    ]) {
      expect(cjk).toContain(`'${placeholder}'`);
      expect(i18n.split(`'${placeholder}':`).length - 1).toBe(1);
    }
  });
});
