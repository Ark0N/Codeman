/**
 * @fileoverview A pending IDLE tab alert is spent by a HUMAN opening a session,
 * never by the app putting one on screen.
 *
 * `selectSession()` acknowledges the session's idle approval item server-side
 * (`markIdleAlertSeen` → `POST /api/approvals/session/:id/viewed`), which is
 * what makes "I checked it" survive a reload and reach the user's other
 * devices. Four call sites are the APP choosing a session rather than the
 * user: the boot restore, a solo (popped-out) window opening its target, a
 * `#session=<id>` link from another page, and the fallback after the active
 * session is deleted. Those pass `auto: true`
 * and must not spend the alert, or a yellow tab would clear itself every time
 * the page loaded and the user would never see it.
 *
 * The gate defaults to user-initiated on purpose: an untagged call site fails
 * toward acknowledging (today's behavior) rather than toward an alert nothing
 * can clear. This suite pins both halves, the runtime gate through the real
 * `selectSession`, and the three tagged call sites as a source guard.
 *
 * Loaded via `vm` with a stubbed context (no jsdom), like input-send-order.test.ts.
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const APP_PATH = resolve(import.meta.dirname, '../src/web/public/app.js');
const APP_SOURCE = readFileSync(APP_PATH, 'utf8');

function loadCodemanAppClass() {
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
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
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
  });
  vm.runInContext(`${constants}\n${APP_SOURCE}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp;
}

const CodemanApp = loadCodemanAppClass();
const SID = 'session-with-a-yellow-tab';

/**
 * Minimal instance: enough surface for selectSession to reach the
 * acknowledgement line. Everything after it is DOM work that throws in this
 * context, which is why callers swallow the rejection.
 */
function makeApp(activeSessionId: string | null) {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as Record<string, unknown>;
  app.markIdleAlertSeen = vi.fn();
  app.pendingHooks = new Map([[SID, new Set(['idle_prompt'])]]);
  app.activeSessionId = activeSessionId;
  app.detachedSessions = new Set();
  app.isSoloWindow = false;
  app._selectGeneration = 0;
  app._shouldFocusTerminalForTabSwitch = () => false;
  app._setTerminalLoadState = vi.fn();
  app._clearTerminalLoadState = vi.fn();
  app._cleanupPreviousSession = vi.fn();
  app._renderHistoryTruncationBanner = vi.fn();
  app._updateSseSubscription = vi.fn();
  app.hideWelcome = vi.fn();
  app.sessions = new Map([[SID, { id: SID, name: 'w1' }]]);
  return app as Record<string, unknown> & {
    selectSession: (id: string, opts?: Record<string, unknown>) => Promise<void>;
    markIdleAlertSeen: ReturnType<typeof vi.fn>;
  };
}

describe('selectSession acknowledgement gate', () => {
  describe('switching to a session (the main path)', () => {
    it('a user-initiated selection spends the idle alert', async () => {
      const app = makeApp(null);
      await app.selectSession(SID).catch(() => {});
      expect(app.markIdleAlertSeen).toHaveBeenCalledWith(SID);
    });

    it('an `auto` selection leaves it armed', async () => {
      const app = makeApp(null);
      await app.selectSession(SID, { auto: true }).catch(() => {});
      expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    });
  });

  describe('re-selecting the session already on screen (the early return)', () => {
    it('a tap on the active tab spends the idle alert', async () => {
      const app = makeApp(SID);
      await app.selectSession(SID);
      expect(app.markIdleAlertSeen).toHaveBeenCalledWith(SID);
    });

    it('an `auto` re-select leaves it armed', async () => {
      const app = makeApp(SID);
      await app.selectSession(SID, { auto: true });
      expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    });
  });

  describe('with the tile grid open (tile-grid.js)', () => {
    // A plain stand-in for the grid: the branch reads only `open` and `has(id)`.
    function withGrid(app: ReturnType<typeof makeApp>, tiled: string[]) {
      const a = app as Record<string, unknown>;
      a._tileGrid = { open: true, has: (id: string) => tiled.includes(id) };
      a._selectTiledSession = vi.fn();
      a.closeTileGrid = vi.fn();
      a._connectWs = vi.fn();
      return a;
    }

    it('a tiled session goes to its tile, never the main terminal, and the tile decides the ack', async () => {
      const app = withGrid(makeApp('other'), [SID]);
      await (app.selectSession as (id: string) => Promise<void>)(SID);
      expect(app._selectTiledSession).toHaveBeenCalledWith(SID, {});
      expect(app._cleanupPreviousSession).not.toHaveBeenCalled();
      expect(app._connectWs).not.toHaveBeenCalled();
      // The branch returns before the main path's own acknowledgement line.
      expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    });

    it('passes `auto` through, so an app-driven focus stays unacknowledged', async () => {
      const app = withGrid(makeApp('other'), [SID]);
      await (app.selectSession as (id: string, o: object) => Promise<void>)(SID, { auto: true });
      expect(app._selectTiledSession).toHaveBeenCalledWith(SID, { auto: true });
    });

    it('an `auto` selection of a session that is not tiled leaves the grid open and acknowledges nothing', async () => {
      const app = withGrid(makeApp('other'), []);
      await (app.selectSession as (id: string, o: object) => Promise<void>)(SID, { auto: true });
      expect(app.closeTileGrid).not.toHaveBeenCalled();
      expect(app._cleanupPreviousSession).not.toHaveBeenCalled();
      expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    });

    it('a user-initiated one leaves the grid (remembered) and switches normally, acknowledging', async () => {
      const app = withGrid(makeApp('other'), []);
      await (app.selectSession as (id: string) => Promise<void>)(SID).catch(() => {});
      expect(app.closeTileGrid).toHaveBeenCalledWith({ keepStored: true, reselect: false });
      expect(app._cleanupPreviousSession).toHaveBeenCalled();
      expect(app.markIdleAlertSeen).toHaveBeenCalledWith(SID);
    });

    it('`leaveTiles` leaves it too, without acknowledging an `auto` pick', async () => {
      const app = withGrid(makeApp('other'), []);
      await (app.selectSession as (id: string, o: object) => Promise<void>)(SID, {
        auto: true,
        leaveTiles: true,
      }).catch(() => {});
      expect(app.closeTileGrid).toHaveBeenCalledTimes(1);
      expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    });
  });

  describe('the call sites the app drives itself', () => {
    // Source guard: these call sites are the reason the flag exists. If a refactor
    // moves or reformats them, fail loudly rather than silently going back to
    // "every page load clears the user's yellow tab".
    it.each([
      ['boot restore, stored session', 'this.selectSession(restoreId, { auto: true });'],
      ['boot restore, first tab fallback', 'this.selectSession(this.sessionOrder[0], { auto: true });'],
      ['solo window opening its target', 'this.selectSession(this.soloSessionId, { auto: true });'],
      ['fallback after the active session is removed', 'this.selectSession(nextSessionId, { auto: true });'],
      ['a #session=<id> link from another page', 'this.selectSession(id, { auto: true, leaveTiles: true });'],
    ])('%s passes auto: true', (_label, call) => {
      expect(APP_SOURCE).toContain(call);
    });

    it('keyboard tab switching stays user-initiated', () => {
      // Alt+1..9 and Alt+[/] are a human asking for that tab, so they keep
      // acknowledging; only app-chosen selections are tagged.
      expect(APP_SOURCE).toContain('this.selectSession(live[idx]);');
      expect(APP_SOURCE).toContain('this.selectSession(this.sessionOrder[nextIndex]);');
    });
  });
});
