/**
 * @fileoverview showToast() display time and drawer logging: a toast with no explicit
 * `duration` uses the notification preference, an explicit `duration` (0 = sticky) still wins,
 * and every toast is recorded in the notification drawer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const windows: JSDOM[] = [];

function loadApp(notificationManager?: unknown) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  windows.push(dom);
  const CodemanApp = function CodemanApp() {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    CodemanApp,
    document: dom.window.document,
    requestAnimationFrame: (cb: () => void) => cb(),
    setTimeout,
    clearTimeout,
    console,
  });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'panels-ui.js' });
  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  app.notificationManager = notificationManager;
  return app;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dom of windows.splice(0)) dom.window.close();
});

describe('showToast', () => {
  it('uses the configured display time when no duration is given', () => {
    vi.useFakeTimers();
    const app = loadApp({ getToastDurationMs: () => 10_000, logToast: vi.fn() });
    app.showToast('hello');
    expect(windows[0].window.document.querySelectorAll('.toast')).toHaveLength(1);
    vi.advanceTimersByTime(9_000);
    expect(windows[0].window.document.querySelector('.toast.show')).not.toBeNull();
    vi.advanceTimersByTime(1_500);
    expect(windows[0].window.document.querySelector('.toast.show')).toBeNull();
  });

  it('falls back to 3s without a notification manager', () => {
    vi.useFakeTimers();
    const app = loadApp();
    app.showToast('hello');
    vi.advanceTimersByTime(3_100);
    expect(windows[0].window.document.querySelector('.toast.show')).toBeNull();
  });

  it('lets an explicit duration of 0 stay until dismissed', () => {
    vi.useFakeTimers();
    const app = loadApp({ getToastDurationMs: () => 1_000, logToast: vi.fn() });
    app.showToast('sticky', 'error', { duration: 0 });
    vi.advanceTimersByTime(60_000);
    expect(windows[0].window.document.querySelector('.toast.show')).not.toBeNull();
  });

  it('records every toast in the notification drawer', () => {
    const logToast = vi.fn();
    const app = loadApp({ getToastDurationMs: () => 3_000, logToast });
    app.showToast('Saved', 'success');
    expect(logToast).toHaveBeenCalledWith('Saved', 'success');
  });
});
