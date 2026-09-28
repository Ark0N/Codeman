/**
 * @fileoverview Pop-out through a native host's window opener.
 *
 * An Android WebView wrapper has no browser pop-ups: `window.open` there either
 * does nothing or replaces the page. On a foldable the app can still put a page
 * in a window of its own beside the dashboard, and says so by exposing
 * `window.CodemanHost.openWindow(absoluteUrl)`. When it does:
 *   1. `detachSession` hands the solo URL to the host instead of `window.open`,
 *      marks the tab detached and announces it on the window channel (there is
 *      no WindowProxy, so liveness is the roll-call path a reloaded dashboard
 *      already uses),
 *   2. a host that refuses leaves the tab docked and toasts,
 *   3. without a host nothing changes (`openInHostWindow` returns null),
 *   4. a solo window closes and raises itself through the host when it can.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — see connection-indicator.test.ts).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

function load(host?: Record<string, unknown>) {
  const windowStub: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
  };
  if (host) windowStub.CodemanHost = host;
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    URL,
    location: { href: 'http://10.0.0.2:8095/' },
    document: { addEventListener: vi.fn() },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: windowStub,
    MobileDetection: {},
  });
  const constants = readFileSync(resolve(PUBLIC, 'constants.js'), 'utf8');
  const source = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  const CodemanApp = (context as { __CodemanApp: { prototype: object } }).__CodemanApp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  app.isSoloWindow = false;
  app.sessions = new Map([['s1', {}]]);
  app.detachedSessions = new Set();
  app.detachedWindows = new Map();
  app.$ = () => null;
  app.showToast = vi.fn();
  app._postWindowMessage = vi.fn();
  app._watchDetachedWindow = vi.fn();
  return { app, windowStub };
}

describe('detach through a host window opener', () => {
  it('opens the solo URL in a host window and tracks the tab over the channel', () => {
    const openWindow = vi.fn().mockReturnValue(true);
    const { app, windowStub } = load({ openWindow });

    app.detachSession('s1');

    expect(openWindow).toHaveBeenCalledWith('http://10.0.0.2:8095/session/s1');
    expect(windowStub.open).not.toHaveBeenCalled();
    expect(app.detachedSessions.has('s1')).toBe(true);
    expect(app.detachedWindows.size).toBe(0);
    expect(app._watchDetachedWindow).not.toHaveBeenCalled();
    expect(app._postWindowMessage).toHaveBeenCalledWith({ type: 'detached', id: 's1' });
  });

  it('leaves the tab docked and toasts when the host opens nothing', () => {
    const { app, windowStub } = load({ openWindow: vi.fn().mockReturnValue(false) });

    app.detachSession('s1');

    expect(windowStub.open).not.toHaveBeenCalled();
    expect(app.detachedSessions.has('s1')).toBe(false);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('Could not open'), 'error');
  });

  it('treats a throwing host as a failed open', () => {
    const { app } = load({
      openWindow: () => {
        throw new Error('bridge gone');
      },
    });

    expect(app.openInHostWindow('/session/s1')).toBe(false);
  });

  it('keeps window.open when there is no host', () => {
    const { app, windowStub } = load();

    expect(app.hasHostWindows()).toBe(false);
    expect(app.openInHostWindow('/session/s1')).toBeNull();
    app.detachSession('s1');
    expect(windowStub.open).toHaveBeenCalledWith('/session/s1', 'codeman-session-s1', expect.any(String));
  });

  it('closes and raises a solo window through the host', () => {
    const closeWindow = vi.fn();
    const focusWindow = vi.fn();
    const { app, windowStub } = load({ openWindow: vi.fn(), closeWindow, focusWindow });
    app.isSoloWindow = true;
    app.soloSessionId = 's1';

    app._onWindowMessage({ type: 'focus-request', id: 's1' });
    app._onWindowMessage({ type: 'close-request', id: 's1' });

    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(windowStub.close).not.toHaveBeenCalled();
    expect(windowStub.focus).not.toHaveBeenCalled();
  });
});
