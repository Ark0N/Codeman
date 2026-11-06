/**
 * WebGL longtask auto-fallback tests.
 *
 * Covers the three follow-ups from #89:
 *   1. Pure trip-detection helper — rolling-window arithmetic for the
 *      "N longtasks of >=Xms within Yms" trip condition. Unit-tested
 *      independently of PerformanceObserver, which can't be driven
 *      deterministically from JS (entries arrive from the platform).
 *   2. Constants are hoisted from inline literals to `WEBGL_FALLBACK`
 *      in constants.js — assert they exist with the documented values.
 *   3. Observer disconnect — _disposeWebGLObserver() is idempotent and
 *      can be called from the onContextLoss path without the addon
 *      having been initialised. Mirrors the leak case in the issue:
 *      "observer outlives its addon" when teardown precedes a trip.
 *
 * Strategy: load the static app shell in a headless browser and drive
 * the helper through page.evaluate(). No real PTY/tmux/WebGL needed —
 * the trip math is pure and the dispose path is a couple of property
 * mutations, both of which run on any page where app.js loaded.
 *
 * Port: ephemeral
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

let baseUrl: string;

describe('WebGL longtask auto-fallback', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    // Wait for constants.js + app.js to have loaded — both expose globals.
    await page.waitForFunction(
      () =>
        typeof (window as { WEBGL_FALLBACK?: unknown }).WEBGL_FALLBACK !== 'undefined' &&
        typeof (window as { evaluateWebGLLongTaskTrip?: unknown }).evaluateWebGLLongTaskTrip === 'function' &&
        typeof (window as { app?: unknown }).app !== 'undefined'
    );
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  describe('constants are hoisted', () => {
    it('WEBGL_FALLBACK exposes documented thresholds', async () => {
      const cfg = await page.evaluate(
        () => (window as unknown as { WEBGL_FALLBACK: Record<string, number> }).WEBGL_FALLBACK
      );
      expect(cfg).toEqual({
        LONGTASK_MS: 200,
        LONGTASK_COUNT: 3,
        WINDOW_MS: 30000,
        GRACE_MS: 5000,
        STICKY_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000,
      });
    });
  });

  describe('evaluateWebGLLongTaskTrip — rolling window arithmetic', () => {
    type EvalFn = (
      recent: number[],
      entries: { startTime: number; duration: number }[],
      now: number
    ) => { tripped: boolean; recent: number[] };

    /** Run the pure helper in the page and return the post-call state. */
    const run: EvalFn = async (recent, entries, now) =>
      page.evaluate(
        ({ r, e, n }) => {
          const fn = (
            window as unknown as {
              evaluateWebGLLongTaskTrip: (
                rec: number[],
                ents: { startTime: number; duration: number }[],
                now: number
              ) => boolean;
            }
          ).evaluateWebGLLongTaskTrip;
          const recent = [...r];
          const tripped = fn(recent, e, n);
          return { tripped, recent };
        },
        { r: recent, e: entries, n: now }
      ) as unknown as { tripped: boolean; recent: number[] };

    it('trips when 3 longtasks fall inside the 30s window', async () => {
      const entries = [
        { startTime: 1000, duration: 250 },
        { startTime: 5000, duration: 300 },
        { startTime: 10000, duration: 220 },
      ];
      const result = await run([], entries, 12000);
      expect(result.tripped).toBe(true);
      expect(result.recent).toEqual([1000, 5000, 10000]);
    });

    it('does not trip when 3 longtasks are spread across 60s', async () => {
      // 3 longtasks 25s apart — only the most recent two stay inside 30s.
      const entries = [
        { startTime: 1000, duration: 250 },
        { startTime: 26000, duration: 250 },
        { startTime: 51000, duration: 250 },
      ];
      const result = await run([], entries, 51100);
      expect(result.tripped).toBe(false);
      // First entry pruned (1000 is >30s before now=51100); 26000 and 51000 stay.
      expect(result.recent).toEqual([26000, 51000]);
    });

    it('ignores entries shorter than 200ms', async () => {
      const entries = [
        { startTime: 1000, duration: 199 },
        { startTime: 2000, duration: 100 },
        { startTime: 3000, duration: 50 },
      ];
      const result = await run([], entries, 3500);
      expect(result.tripped).toBe(false);
      expect(result.recent).toEqual([]);
    });

    it('prunes stale entries even when no new ones arrive', async () => {
      // Existing window has 2 stale + 1 fresh; an empty batch should still
      // age out the stale ones so the next real batch evaluates correctly.
      const recent = [1000, 5000, 40000];
      const result = await run(recent, [], 41000);
      expect(result.tripped).toBe(false);
      expect(result.recent).toEqual([40000]);
    });

    it('counts entries cumulatively across batches', async () => {
      // Two batches of 2 entries each, all inside the window — second
      // batch should push the cumulative count to 4 and trip.
      const recent: number[] = [];
      const first = await run(
        recent,
        [
          { startTime: 1000, duration: 250 },
          { startTime: 2000, duration: 250 },
        ],
        3000
      );
      expect(first.tripped).toBe(false);
      expect(first.recent).toEqual([1000, 2000]);

      const second = await run(
        first.recent,
        [
          { startTime: 4000, duration: 250 },
          { startTime: 5000, duration: 250 },
        ],
        6000
      );
      expect(second.tripped).toBe(true);
      expect(second.recent).toEqual([1000, 2000, 4000, 5000]);
    });
  });

  describe('_disposeWebGLObserver', () => {
    it('is idempotent — safe to call when no observer was installed', async () => {
      const ok = await page.evaluate(() => {
        const app = (
          window as unknown as { app: { _disposeWebGLObserver: () => void; _webglLongTaskObserver: unknown } }
        ).app;
        app._webglLongTaskObserver = null;
        app._disposeWebGLObserver();
        app._disposeWebGLObserver();
        return app._webglLongTaskObserver === null;
      });
      expect(ok).toBe(true);
    });

    it('disconnects a stub observer and nulls the reference', async () => {
      const result = await page.evaluate(() => {
        const app = (
          window as unknown as { app: { _disposeWebGLObserver: () => void; _webglLongTaskObserver: unknown } }
        ).app;
        let disconnectCalls = 0;
        app._webglLongTaskObserver = {
          disconnect() {
            disconnectCalls++;
          },
        } as unknown;
        app._disposeWebGLObserver();
        return { disconnectCalls, ref: app._webglLongTaskObserver };
      });
      expect(result.disconnectCalls).toBe(1);
      expect(result.ref).toBeNull();
    });

    it('swallows a throwing disconnect — guards against driver quirks', async () => {
      const result = await page.evaluate(() => {
        const app = (
          window as unknown as { app: { _disposeWebGLObserver: () => void; _webglLongTaskObserver: unknown } }
        ).app;
        app._webglLongTaskObserver = {
          disconnect() {
            throw new Error('synthetic');
          },
        } as unknown;
        app._disposeWebGLObserver();
        return app._webglLongTaskObserver;
      });
      expect(result).toBeNull();
    });
  });

  describe('shouldSkipWebGL — renderer toggle + fallback precedence', () => {
    type Input = {
      deviceType?: string;
      noWebglParam?: boolean;
      forceParam?: boolean;
      stickyDisabled?: boolean;
      userPrefEnabled?: boolean;
    };
    const run = async (input: Input): Promise<{ skip: boolean; clearSticky: boolean }> =>
      page.evaluate(
        (i) =>
          (
            window as unknown as {
              shouldSkipWebGL: (x: unknown) => { skip: boolean; clearSticky: boolean };
            }
          ).shouldSkipWebGL(i),
        input
      );

    it('exposes shouldSkipWebGL on window', async () => {
      const t = await page.evaluate(() => typeof (window as unknown as { shouldSkipWebGL?: unknown }).shouldSkipWebGL);
      expect(t).toBe('function');
    });

    it('mobile always skips, even when the user opted in', async () => {
      expect(await run({ deviceType: 'mobile', userPrefEnabled: true })).toEqual({
        skip: true,
        clearSticky: false,
      });
    });

    it('explicit opt-out skips without touching the sticky marker', async () => {
      expect(await run({ deviceType: 'desktop', userPrefEnabled: false, stickyDisabled: false })).toEqual({
        skip: true,
        clearSticky: false,
      });
    });

    it('?nowebgl is a one-shot opt-out (sticky untouched)', async () => {
      expect(await run({ deviceType: 'desktop', noWebglParam: true })).toEqual({
        skip: true,
        clearSticky: false,
      });
    });

    it('stored toggle ON still respects the sticky marker (incidental saves must not defeat auto-fallback)', async () => {
      // The checkbox defaults checked on desktop, so any unrelated settings save
      // stores true — that must NOT act like ?webgl=force and clear the marker.
      expect(await run({ deviceType: 'desktop', userPrefEnabled: true, stickyDisabled: true })).toEqual({
        skip: true,
        clearSticky: false,
      });
    });

    it('stored toggle ON enables WebGL when no sticky marker is set', async () => {
      expect(await run({ deviceType: 'desktop', userPrefEnabled: true, stickyDisabled: false })).toEqual({
        skip: false,
        clearSticky: false,
      });
    });

    it('?webgl=force enables and clears the sticky marker', async () => {
      expect(await run({ deviceType: 'desktop', forceParam: true, stickyDisabled: true })).toEqual({
        skip: false,
        clearSticky: true,
      });
    });

    it('untouched default respects an active sticky marker', async () => {
      expect(await run({ deviceType: 'desktop', stickyDisabled: true })).toEqual({
        skip: true,
        clearSticky: false,
      });
    });

    it('untouched default enables WebGL when nothing is disabling it', async () => {
      expect(await run({ deviceType: 'desktop', stickyDisabled: false })).toEqual({
        skip: false,
        clearSticky: false,
      });
    });
  });

  describe('saveAppSettings — per-device WebGL toggle semantics', () => {
    type SaveHarnessApp = {
      loadAppSettingsFromStorage: () => Record<string, unknown>;
      saveAppSettingsToStorage: (s: Record<string, unknown>) => void;
      saveAppSettings: () => Promise<void>;
      _apiPut: (path: string, body: Record<string, unknown>) => Promise<unknown>;
      saveModelConfigFromSettings: () => Promise<void>;
      _syncPushPreferences: () => void;
    };

    /**
     * Drive the real saveAppSettings() in the page with the settings PUT stubbed
     * out. Seeds the stored blob (via saveAppSettingsToStorage so the in-memory
     * cache stays coherent), sets the sticky marker + checkbox, saves, and
     * reports what happened to the marker and the captured server payload.
     */
    const runSave = async (opts: { storedPref: boolean | undefined }) =>
      page.evaluate(async (o) => {
        const app = (window as unknown as { app: SaveHarnessApp }).app;
        const prevStored = { ...app.loadAppSettingsFromStorage() };
        const origPut = app._apiPut;
        const origModel = app.saveModelConfigFromSettings;
        const origSync = app._syncPushPreferences;
        let captured: Record<string, unknown> | null = null;
        try {
          const seeded = { ...prevStored };
          if (o.storedPref === undefined) delete seeded.webglRendererEnabled;
          else seeded.webglRendererEnabled = o.storedPref;
          app.saveAppSettingsToStorage(seeded);
          localStorage.setItem('codeman-webgl-disabled', JSON.stringify({ at: Date.now() }));
          (document.getElementById('appSettingsWebglRenderer') as HTMLInputElement).checked = true;
          app._apiPut = async (_path, body) => {
            captured = body;
            return { ok: true };
          };
          app.saveModelConfigFromSettings = async () => {};
          app._syncPushPreferences = () => {};
          await app.saveAppSettings();
          return {
            markerCleared: localStorage.getItem('codeman-webgl-disabled') === null,
            payloadHasWebglKey: captured ? 'webglRendererEnabled' in captured : null,
          };
        } finally {
          app._apiPut = origPut;
          app.saveModelConfigFromSettings = origModel;
          app._syncPushPreferences = origSync;
          localStorage.removeItem('codeman-webgl-disabled');
          app.saveAppSettingsToStorage(prevStored);
        }
      }, opts);

    it('a real OFF→ON flip clears the sticky marker and keeps the key off the settings PUT', async () => {
      const result = await runSave({ storedPref: false });
      expect(result.markerCleared).toBe(true);
      expect(result.payloadHasWebglKey).toBe(false);
    });

    it('a save with the toggle merely default-checked leaves the sticky marker alone', async () => {
      // No stored OFF → this is the "unrelated settings save stores true" case;
      // clearing here would permanently defeat the GPU-stall auto-fallback.
      const result = await runSave({ storedPref: undefined });
      expect(result.markerCleared).toBe(false);
      expect(result.payloadHasWebglKey).toBe(false);
    });
  });
});
