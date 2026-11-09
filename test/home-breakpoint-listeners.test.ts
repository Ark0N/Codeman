// Port: none (the real home-screen modules in a vm context with a fake
// matchMedia; no browser, no server).
//
// #702: folding a phone on the home screen must swap the home surface even when
// the page loaded wide. The phone overview's breakpoint listener used to be
// wired from its first show, which a wide-loaded page never reaches. Both home
// screens' listeners are now installed once at startup and self-gate on a home
// screen being up. The real resize walk lives in
// test/home-breakpoint-swap.browser.test.ts (browser suite, not in the gate);
// this file keeps the wiring itself under `npm test`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

type Listener = () => void;

function loadHomeApp(innerWidth = 1440) {
  const listeners = new Map<string, Listener[]>();
  const elements: Record<string, any> = {
    welcomeOverlay: { classList: new Set<string>(), hidden: false },
    mobileOverview: { classList: new Set<string>(), hidden: true },
    homeSessions: { hidden: true },
  };
  for (const el of Object.values(elements)) {
    if (el.classList) {
      const set = el.classList as Set<string>;
      el.classList = {
        contains: (c: string) => set.has(c),
        add: (c: string) => set.add(c),
        remove: (c: string) => set.delete(c),
      };
    }
  }
  const timers: Array<() => void> = [];
  const window: any = {
    innerWidth,
    matchMedia: (query: string) => ({
      matches: false,
      addEventListener: (_type: string, fn: Listener) => {
        listeners.set(query, [...(listeners.get(query) || []), fn]);
      },
    }),
  };
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    console,
    window,
    document: {
      documentElement: { getAttribute: () => null },
      getElementById: (id: string) => elements[id] || null,
      createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {} }),
    },
    MobileDetection: { getDeviceType: () => (window.innerWidth < 600 ? 'mobile' : 'desktop') },
  });
  for (const file of ['constants.js', 'mobile-overview.js', 'home-sessions.js']) {
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  }
  const app = new (CodemanApp as any)();
  app.loadAppSettingsFromStorage = () => ({});
  app.activeSessionId = null;
  app.showWelcomeCalls = 0;
  app.showWelcome = () => app.showWelcomeCalls++;
  app.renderHomeSessionsCalls = 0;
  app.renderHomeSessions = () => {
    app.renderHomeSessionsCalls++;
    elements.homeSessions.hidden = false;
  };
  app._debouncedCall = (_key: string, fn: () => void) => timers.push(fn);
  const fire = (query: string) => (listeners.get(query) || []).forEach((fn) => fn());
  const flushTimers = () => timers.splice(0).forEach((fn) => fn());
  return { app, window, elements, listeners, fire, flushTimers };
}

const PHONE_QUERY = '(max-width: 599px)';
const RAIL_QUERY = '(min-width: 1180px)';

describe('home-screen breakpoint listeners (#702)', () => {
  it('installs each listener once, with nothing shown yet', () => {
    const { app, listeners } = loadHomeApp();
    app._wireMobileOverviewBreakpoint();
    app._wireHomeSessionsBreakpoint();
    // The lazy wiring from a first show must not add a second copy.
    app._wireMobileOverviewBreakpoint();
    app._wireHomeSessionsBreakpoint();
    expect(listeners.get(PHONE_QUERY)).toHaveLength(1);
    expect(listeners.get(RAIL_QUERY)).toHaveLength(1);
  });

  it('a fold on a wide-loaded welcome screen re-decides the surface', () => {
    const { app, window, elements, fire } = loadHomeApp(1440);
    app._wireMobileOverviewBreakpoint();
    elements.welcomeOverlay.classList.add('visible');
    window.innerWidth = 390;
    fire(PHONE_QUERY);
    expect(app.showWelcomeCalls).toBe(1);
  });

  it('an unfold on the phone overview re-decides the surface', () => {
    const { app, window, elements, fire } = loadHomeApp(390);
    app._wireMobileOverviewBreakpoint();
    elements.mobileOverview.classList.add('visible');
    window.innerWidth = 820;
    fire(PHONE_QUERY);
    expect(app.showWelcomeCalls).toBe(1);
  });

  it('stays out of the way inside a session and before any home screen is up', () => {
    const { app, elements, fire } = loadHomeApp();
    app._wireMobileOverviewBreakpoint();
    fire(PHONE_QUERY); // page still loading: no home surface yet
    elements.welcomeOverlay.classList.add('visible');
    app.activeSessionId = 'abc';
    fire(PHONE_QUERY);
    expect(app.showWelcomeCalls).toBe(0);
  });

  it('a rail render queued before a fold does not bring the hidden rail back', () => {
    const { app, window, elements, flushTimers } = loadHomeApp(1440);
    elements.welcomeOverlay.classList.add('visible');
    elements.homeSessions.hidden = false;
    app._refreshHomeSessionsIfVisible(); // queued while the rail is still up
    window.innerWidth = 390; // the fold
    elements.homeSessions.hidden = true; // showWelcome()'s phone path hid it
    flushTimers();
    expect(app.renderHomeSessionsCalls).toBe(0);
    expect(elements.homeSessions.hidden).toBe(true);
  });

  it('is wired from init(), not from the first show', () => {
    const appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
    const start = appJs.indexOf('\n  init() {');
    const end = appJs.indexOf('\n  }\n', start);
    const init = appJs.slice(start, end);
    expect(init).toContain('this._wireMobileOverviewBreakpoint?.()');
    expect(init).toContain('this._wireHomeSessionsBreakpoint?.()');
  });
});
