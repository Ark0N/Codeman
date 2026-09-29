// test/url-session-fragment.test.ts
// Port: N/A (no server/browser — loads constants.js and app.js via `vm`, like session-select-ack-gate.test.ts).
//
// A page that holds the dashboard's window switches its tab with a
// `#session=<id>` link, and sessionIdFromFragment() is what reads the link.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';

function loadHelper() {
  const context = vm.createContext({ window: {}, globalThis: {}, URLSearchParams });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanUrlSession: { sessionIdFromFragment: (hash: unknown) => string | null } })
    .CodemanUrlSession;
}

describe('CodemanUrlSession.sessionIdFromFragment', () => {
  const { sessionIdFromFragment } = loadHelper();

  it('reads the id from a #session= fragment', () => {
    expect(sessionIdFromFragment('#session=76763752-fa3a-40aa-a025-e1684c82d00e')).toBe(
      '76763752-fa3a-40aa-a025-e1684c82d00e'
    );
  });

  it('accepts the fragment without its leading #', () => {
    expect(sessionIdFromFragment('session=abc')).toBe('abc');
  });

  it('decodes an encoded id', () => {
    expect(sessionIdFromFragment('#session=' + encodeURIComponent('w1 my/app'))).toBe('w1 my/app');
  });

  it('finds the id beside other fragment parameters', () => {
    expect(sessionIdFromFragment('#tab=2&session=abc')).toBe('abc');
  });

  it('asks for nothing when the fragment names no session', () => {
    expect(sessionIdFromFragment('')).toBeNull();
    expect(sessionIdFromFragment('#')).toBeNull();
    expect(sessionIdFromFragment('#settings')).toBeNull();
    expect(sessionIdFromFragment('#session=')).toBeNull();
    expect(sessionIdFromFragment('#session=%20')).toBeNull();
    expect(sessionIdFromFragment(undefined)).toBeNull();
  });
});

// The dashboard side: reading the link, holding an id it does not list yet,
// and handing the selection over. Loaded like session-select-ack-gate.test.ts,
// on a bare instance whose DOM-touching methods are stubbed.
function loadApp() {
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const app = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const location = { hash: '', pathname: '/', search: '' };
  const history = {
    state: null,
    replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
      location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    }),
  };
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    URLSearchParams,
    location,
    history,
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
  });
  vm.runInContext(`${constants}\n${app}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  const CodemanApp = (context as { __CodemanApp: { prototype: object } }).__CodemanApp;
  const make = (ids: string[]) => {
    const inst = Object.create(CodemanApp.prototype) as Record<string, any>;
    inst.sessions = new Map(ids.map((id) => [id, { id, name: id }]));
    inst.sessionOrder = [...ids];
    inst.detachedSessions = new Set();
    inst.detachedWindows = new Map();
    inst.isSoloWindow = false;
    inst._urlSessionId = null;
    inst.selectSession = vi.fn();
    for (const stub of [
      'saveSessionOrder',
      'markSessionTabEntering',
      'markTerminalEntering',
      'renderSessionTabs',
      'updateCost',
      'startSystemStatsPolling',
    ]) {
      inst[stub] = vi.fn();
    }
    return inst;
  };
  return { make, location, history, CodemanApp };
}

describe('dashboard handling of a #session=<id> link', () => {
  it('reads the link and removes the fragment, so the same link counts as a change next time', () => {
    const { make, location, history } = loadApp();
    const app = make(['a']);
    location.hash = '#session=a';
    expect(app._takeUrlSession()).toBe('a');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(location.hash).toBe('');
  });

  it('leaves a URL without a session link alone', () => {
    const { make, location, history } = loadApp();
    location.hash = '#settings';
    expect(make([])._takeUrlSession()).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it('selects a listed session as an app selection, which leaves its idle alert armed', () => {
    const { make } = loadApp();
    const app = make(['a']);
    app._urlSessionId = 'a';
    expect(app._selectUrlSession()).toBe(true);
    expect(app.selectSession).toHaveBeenCalledWith('a', { auto: true });
    expect(app._urlSessionId).toBeNull();
  });

  it('holds an unlisted id until session:created names it', () => {
    const { make } = loadApp();
    const app = make([]);
    app._urlSessionId = 'new';
    expect(app._selectUrlSession()).toBe(false);
    expect(app.selectSession).not.toHaveBeenCalled();
    app._onSessionCreated({ id: 'other', name: 'other' });
    expect(app.selectSession).not.toHaveBeenCalled();
    app._onSessionCreated({ id: 'new', name: 'new' });
    expect(app.selectSession).toHaveBeenCalledWith('new', { auto: true });
    expect(app._urlSessionId).toBeNull();
  });

  it('retires a waiting link when you pick another tab yourself', async () => {
    const { make, CodemanApp } = loadApp();
    const app = make(['a', 'b']);
    app.selectSession = (CodemanApp.prototype as Record<string, any>).selectSession;
    app._urlSessionId = 'later';
    await app.selectSession('b').catch(() => {});
    expect(app._urlSessionId).toBeNull();
  });

  it('keeps a waiting link through a selection the app makes itself', async () => {
    const { make, CodemanApp } = loadApp();
    const app = make(['a', 'b']);
    app.selectSession = (CodemanApp.prototype as Record<string, any>).selectSession;
    app._urlSessionId = 'later';
    await app.selectSession('b', { auto: true }).catch(() => {});
    expect(app._urlSessionId).toBe('later');
  });

  it('puts the link ahead of restoring the last active tab when the page loads', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const link = source.indexOf('if (this._urlSessionId && this.sessions.has(this._urlSessionId))');
    const restore = source.indexOf("restoreId = localStorage.getItem('codeman-active-session')");
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(restore);
  });

  it('never reads the link in a solo window', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    expect(source).toContain('this._urlSessionId = this.isSoloWindow ? null : this._takeUrlSession();');
    expect(source).toMatch(/if \(!this\.isSoloWindow\) \{\s*window\.addEventListener\('hashchange'/);
  });
});
