/**
 * Browser performance test suite
 *
 * Tests real browser interactions: page load, tab creation/switching,
 * terminal input latency, subagent window management, settings modal,
 * SSE connection speed, and rendering under load.
 *
 * Port: 3210 (perf-browser tests)
 *
 * Run: npx vitest run test/perf-browser.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3210;
const BASE_URL = `http://localhost:${PORT}`;

// Thresholds (ms)
const THRESHOLDS = {
  PAGE_LOAD: 3000,           // Full page load including JS init
  DOMContentLoaded: 1500,    // HTML parsed
  SSE_CONNECT: 2000,         // SSE EventSource open
  TAB_CREATE_API: 200,       // POST /api/sessions response
  TAB_RENDER: 300,           // Tab element appears in DOM
  TAB_SWITCH: 400,           // Tab click to active class applied (includes tmux session creation)
  TERMINAL_INIT: 500,        // xterm.js instance created for tab
  INPUT_ROUNDTRIP: 500,      // Keystroke sent via API → acknowledged
  SETTINGS_OPEN: 300,        // Settings modal visible
  SETTINGS_CLOSE: 200,       // Settings modal hidden
  SESSION_OPTIONS_OPEN: 300, // Session options modal visible
  SESSION_OPTIONS_TAB: 200,  // Modal tab switch
  SUBAGENT_WINDOW_OPEN: 400, // Subagent window rendered
  SUBAGENT_WINDOW_CLOSE: 200,
  BULK_TAB_CREATE: 3000,     // Create 10 sessions
  BULK_TAB_SWITCH_AVG: 300,  // Average per-tab switch across 10 tabs (includes buffer loads)
  MEMORY_HEAP_MB: 200,       // Max JS heap after heavy load
  BUFFER_LOAD_16KB: 500,     // Load a 16KB terminal buffer
};

let server: WebServer;
let browser: Browser;

// ─── Helpers ──────────────────────────────────────────────

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  return { context, page };
}

async function navigateAndWait(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  // Wait for app.js to initialize (app-loaded class added to body)
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
    timeout: 5000,
  });
}

/** Create a session via API, return its ID */
async function createSession(page: Page, name: string): Promise<string> {
  const result = await page.evaluate(async (n: string) => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: n }),
    });
    const data = await res.json();
    return data.id ?? data.session?.id;
  }, name);
  return result as string;
}

/** Delete a session via API */
async function deleteSession(page: Page, id: string): Promise<void> {
  await page.evaluate(async (sid: string) => {
    await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
  }, id);
}

/** Measure time for a function to complete */
async function measure(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/** Get JS heap size in MB (Chromium only) */
async function getHeapMB(page: Page): Promise<number> {
  const metrics = await page.evaluate(() => {
    // @ts-expect-error — Chromium-only API
    return (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  });
  return metrics ? metrics / (1024 * 1024) : 0;
}

// ─── Setup / Teardown ─────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Tests ────────────────────────────────────────────────

describe('Page load performance', () => {
  let context: BrowserContext;
  let page: Page;

  afterAll(async () => {
    await context?.close();
  });

  it('DOMContentLoaded fires within threshold', async () => {
    ({ context, page } = await freshPage());

    const timing = await measure(async () => {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    });

    console.log(`[page load] DOMContentLoaded: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.DOMContentLoaded);
  });

  it('full app initialization completes within threshold', async () => {
    ({ context, page } = await freshPage());

    const timing = await measure(async () => {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
        timeout: 5000,
      });
    });

    console.log(`[page load] Full init: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.PAGE_LOAD);
  });

  it('SSE EventSource connects within threshold', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    const timing = await measure(async () => {
      await page.waitForFunction(
        () => {
          const indicator = document.getElementById('connectionIndicator');
          if (!indicator) return false;
          const dot = document.getElementById('connectionDot');
          return dot?.classList.contains('connected') || indicator.style.display === 'none';
        },
        { timeout: 5000 },
      );
    });

    console.log(`[SSE] connection established: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.SSE_CONNECT);
  });

  it('loading skeleton disappears after init', async () => {
    ({ context, page } = await freshPage());
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    // Skeleton should be visible initially
    const skeletonVisible = await page.locator('.loading-skeleton').isVisible();
    // May already be hidden if JS executed fast — that's fine

    await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
      timeout: 5000,
    });

    // After init, skeleton should be hidden
    const skeletonHidden = await page.evaluate(() => {
      const el = document.querySelector('.loading-skeleton') as HTMLElement;
      return el ? getComputedStyle(el).display === 'none' : true;
    });
    expect(skeletonHidden).toBe(true);
  });
});

describe('Session tab creation', () => {
  let context: BrowserContext;
  let page: Page;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    // Clean up sessions
    for (const id of sessionIds) {
      await deleteSession(page, id).catch(() => {});
    }
    await context?.close();
  });

  it('API responds within threshold', async () => {
    let sessionId: string | undefined;
    const timing = await measure(async () => {
      sessionId = await createSession(page, 'perf-api-test');
    });
    if (sessionId) sessionIds.push(sessionId);

    console.log(`[tab create] API response: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.TAB_CREATE_API);
  });

  it('tab element renders in DOM within threshold', async () => {
    const tabCountBefore = await page.locator('.session-tab').count();

    const id = await createSession(page, 'perf-render-test');
    sessionIds.push(id);

    const timing = await measure(async () => {
      await page.waitForFunction(
        (expected: number) => document.querySelectorAll('.session-tab').length > expected,
        tabCountBefore,
        { timeout: 3000 },
      );
    });

    console.log(`[tab create] DOM render: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.TAB_RENDER);
  });

  it('terminal container initializes after selecting tab', async () => {
    const id = await createSession(page, 'perf-terminal-test');
    sessionIds.push(id);

    // Wait for tab to appear
    await page.waitForSelector(`.session-tab[data-id="${id}"]`, { timeout: 3000 });

    const timing = await measure(async () => {
      // Click the tab
      await page.locator(`.session-tab[data-id="${id}"]`).click();
      // Wait for xterm.js to init (canvas or rows appear)
      await page.waitForFunction(
        () => {
          const container = document.getElementById('terminalContainer');
          if (!container) return false;
          return container.querySelector('.xterm-screen') !== null;
        },
        { timeout: 3000 },
      );
    });

    console.log(`[tab create] terminal init: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.TERMINAL_INIT);
  });
});

describe('Tab switching performance', () => {
  let context: BrowserContext;
  let page: Page;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Create 5 sessions
    for (let i = 0; i < 5; i++) {
      const id = await createSession(page, `perf-switch-${i}`);
      sessionIds.push(id);
    }
    // Wait for all tabs to render
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('.session-tab').length >= count,
      sessionIds.length,
      { timeout: 5000 },
    );
    // Select first tab
    await page.locator(`.session-tab[data-id="${sessionIds[0]}"]`).click();
    await page.waitForTimeout(500); // Let terminal fully init
  });

  afterAll(async () => {
    for (const id of sessionIds) {
      await deleteSession(page, id).catch(() => {});
    }
    await context?.close();
  });

  it('switches between 2 tabs within threshold', async () => {
    const timings: number[] = [];

    for (let i = 0; i < 4; i++) {
      const targetIdx = i % 2 === 0 ? 1 : 0;
      const targetId = sessionIds[targetIdx];

      const timing = await measure(async () => {
        await page.locator(`.session-tab[data-id="${targetId}"]`).click();
        await page.waitForFunction(
          (id: string) => document.querySelector(`.session-tab[data-id="${id}"]`)?.classList.contains('active'),
          targetId,
          { timeout: 2000 },
        );
      });
      timings.push(timing);
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    const max = Math.max(...timings);
    console.log(`[tab switch] avg: ${avg.toFixed(0)}ms, max: ${max.toFixed(0)}ms (${timings.length} switches)`);
    expect(avg).toBeLessThan(THRESHOLDS.TAB_SWITCH);
  });

  it('cycles through all 5 tabs efficiently', async () => {
    const timings: number[] = [];

    for (let i = 0; i < sessionIds.length; i++) {
      const targetId = sessionIds[i];
      const timing = await measure(async () => {
        await page.locator(`.session-tab[data-id="${targetId}"]`).click();
        await page.waitForFunction(
          (id: string) => document.querySelector(`.session-tab[data-id="${id}"]`)?.classList.contains('active'),
          targetId,
          { timeout: 2000 },
        );
      });
      timings.push(timing);
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    const max = Math.max(...timings);
    console.log(`[tab cycle] avg: ${avg.toFixed(0)}ms, max: ${max.toFixed(0)}ms (5 tabs)`);
    expect(avg).toBeLessThan(THRESHOLDS.TAB_SWITCH);
  });
});

describe('Bulk tab operations', () => {
  let context: BrowserContext;
  let page: Page;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    for (const id of sessionIds) {
      await deleteSession(page, id).catch(() => {});
    }
    await context?.close();
  });

  it('creates 10 sessions within threshold', async () => {
    const timing = await measure(async () => {
      for (let i = 0; i < 10; i++) {
        const id = await createSession(page, `perf-bulk-${i}`);
        sessionIds.push(id);
      }
      // Wait for all tabs to render
      await page.waitForFunction(
        (count: number) => document.querySelectorAll('.session-tab').length >= count,
        10,
        { timeout: 5000 },
      );
    });

    console.log(`[bulk create] 10 sessions: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.BULK_TAB_CREATE);
  });

  it('average tab switch stays fast with 10 tabs', async () => {
    const timings: number[] = [];

    // Cycle through all 10 tabs
    for (const targetId of sessionIds) {
      const timing = await measure(async () => {
        await page.locator(`.session-tab[data-id="${targetId}"]`).click();
        await page.waitForFunction(
          (id: string) => document.querySelector(`.session-tab[data-id="${id}"]`)?.classList.contains('active'),
          targetId,
          { timeout: 2000 },
        );
      });
      timings.push(timing);
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    const max = Math.max(...timings);
    const p95 = timings.sort((a, b) => a - b)[Math.floor(timings.length * 0.95)];
    console.log(`[bulk switch] avg: ${avg.toFixed(0)}ms, p95: ${p95.toFixed(0)}ms, max: ${max.toFixed(0)}ms (10 tabs)`);
    expect(avg).toBeLessThan(THRESHOLDS.BULK_TAB_SWITCH_AVG);
  });

  it('rapidly switches tabs without errors', async () => {
    // Rapid-fire tab switching — test for race conditions
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      const targetId = sessionIds[i % sessionIds.length];
      await page.locator(`.session-tab[data-id="${targetId}"]`).click();
      // Minimal wait — stress test
      await page.waitForTimeout(30);
    }
    const elapsed = performance.now() - start;

    console.log(`[rapid switch] 20 switches in ${elapsed.toFixed(0)}ms (${(elapsed / 20).toFixed(0)}ms avg)`);
    expect(errors).toHaveLength(0);
  });
});

describe('Terminal input performance', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    sessionId = await createSession(page, 'perf-input');
    await page.waitForSelector(`.session-tab[data-id="${sessionId}"]`, { timeout: 3000 });
    await page.locator(`.session-tab[data-id="${sessionId}"]`).click();
    await page.waitForTimeout(500); // Let terminal init
  });

  afterAll(async () => {
    await deleteSession(page, sessionId).catch(() => {});
    await context?.close();
  });

  it('API input endpoint responds quickly', async () => {
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const timing = await measure(async () => {
        await page.evaluate(async (sid: string) => {
          await fetch(`/api/sessions/${sid}/input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: `echo test-${Date.now()}` }),
          });
        }, sessionId);
      });
      timings.push(timing);
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(`[input API] avg: ${avg.toFixed(0)}ms (5 calls)`);
    expect(avg).toBeLessThan(THRESHOLDS.INPUT_ROUNDTRIP);
  });

  it('keyboard typing performance via page.keyboard', async () => {
    // Focus the terminal
    await page.locator('.terminal-container').click();
    await page.waitForTimeout(100);

    const text = 'The quick brown fox jumps over the lazy dog';
    const start = performance.now();
    await page.keyboard.type(text, { delay: 0 }); // No artificial delay
    const elapsed = performance.now() - start;

    const msPerChar = elapsed / text.length;
    console.log(`[keyboard type] ${text.length} chars in ${elapsed.toFixed(0)}ms (${msPerChar.toFixed(1)}ms/char)`);
    // Should be well under 5ms per character
    expect(msPerChar).toBeLessThan(10);
  });
});

describe('Settings modal performance', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('opens within threshold', async () => {
    const timing = await measure(async () => {
      await page.locator('.btn-settings').click();
      await page.waitForSelector('#appSettingsModal.active', { timeout: 2000 });
    });

    console.log(`[settings] open: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.SETTINGS_OPEN);
  });

  it('closes within threshold', async () => {
    // Make sure it's open
    const isOpen = await page.locator('#appSettingsModal.active').isVisible().catch(() => false);
    if (!isOpen) {
      await page.locator('.btn-settings').click();
      await page.waitForSelector('#appSettingsModal.active', { timeout: 2000 });
    }

    const timing = await measure(async () => {
      // Press Escape to close
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => !document.querySelector('#appSettingsModal')?.classList.contains('active'),
        { timeout: 2000 },
      );
    });

    console.log(`[settings] close: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.SETTINGS_CLOSE);
  });

  it('repeated open/close cycles stay fast', async () => {
    const timings: number[] = [];

    for (let i = 0; i < 5; i++) {
      // Open
      const openTime = await measure(async () => {
        await page.locator('.btn-settings').click();
        await page.waitForSelector('#appSettingsModal.active', { timeout: 2000 });
      });
      // Close
      const closeTime = await measure(async () => {
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () => !document.querySelector('#appSettingsModal')?.classList.contains('active'),
          { timeout: 2000 },
        );
      });
      timings.push(openTime + closeTime);
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(`[settings] avg open+close cycle: ${avg.toFixed(0)}ms (5 cycles)`);
    // Each cycle should be under open + close thresholds
    expect(avg).toBeLessThan(THRESHOLDS.SETTINGS_OPEN + THRESHOLDS.SETTINGS_CLOSE);
  });
});

describe('Session options modal performance', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    sessionId = await createSession(page, 'perf-options');
    await page.waitForSelector(`.session-tab[data-id="${sessionId}"]`, { timeout: 3000 });
    await page.locator(`.session-tab[data-id="${sessionId}"]`).click();
    await page.waitForTimeout(300);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId).catch(() => {});
    await context?.close();
  });

  it('opens via gear icon within threshold', async () => {
    const timing = await measure(async () => {
      await page.locator(`.session-tab[data-id="${sessionId}"] .tab-gear`).click();
      await page.waitForSelector('#sessionOptionsModal.active', { timeout: 2000 });
    });

    console.log(`[session options] open: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.SESSION_OPTIONS_OPEN);
  });

  it('tab switching within modal is instant', async () => {
    // Ensure modal is open
    const isOpen = await page.locator('#sessionOptionsModal.active').isVisible().catch(() => false);
    if (!isOpen) {
      await page.locator(`.session-tab[data-id="${sessionId}"] .tab-gear`).click();
      await page.waitForSelector('#sessionOptionsModal.active', { timeout: 2000 });
    }

    const tabs = ['respawn', 'context', 'ralph'];
    const timings: number[] = [];

    for (const tab of tabs) {
      const timing = await measure(async () => {
        await page.locator(`[data-tab="${tab}"]`).click();
        await page.waitForFunction(
          (t: string) => document.querySelector(`[data-tab="${t}"]`)?.classList.contains('active'),
          tab,
          { timeout: 1000 },
        );
      });
      timings.push(timing);
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(`[session options] tab switch avg: ${avg.toFixed(0)}ms (${tabs.join(', ')})`);
    expect(avg).toBeLessThan(THRESHOLDS.SESSION_OPTIONS_TAB);

    // Close modal
    await page.keyboard.press('Escape');
  });
});

describe('Subagent window simulation', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    sessionId = await createSession(page, 'perf-subagent');
    await page.waitForSelector(`.session-tab[data-id="${sessionId}"]`, { timeout: 3000 });
    await page.locator(`.session-tab[data-id="${sessionId}"]`).click();
    await page.waitForTimeout(300);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId).catch(() => {});
    await context?.close();
  });

  it('opens a mock subagent window within threshold', async () => {
    // Must inject fake agent data into the subagents map first —
    // openSubagentWindow checks this.subagents.get(agentId) and returns early if missing
    const claudeSessionId = await page.evaluate((sid: string) => {
      const app = (window as unknown as { app: { sessions: Map<string, { claudeSessionId?: string }> } }).app;
      return app.sessions.get(sid)?.claudeSessionId || 'fake-claude-session';
    }, sessionId);

    const timing = await measure(async () => {
      await page.evaluate(({ agentId, cSessionId }: { agentId: string; cSessionId: string }) => {
        const app = (window as unknown as {
          app: {
            subagents: Map<string, Record<string, unknown>>;
            openSubagentWindow: (id: string) => void;
          }
        }).app;
        // Inject fake agent data
        app.subagents.set(agentId, {
          agentId,
          sessionId: cSessionId,
          status: 'active',
          description: 'Performance test agent',
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          toolCallCount: 0,
          entryCount: 0,
          fileSize: 0,
        });
        app.openSubagentWindow(agentId);
      }, { agentId: 'perf-agent-1', cSessionId: claudeSessionId });
      await page.waitForSelector('.subagent-window', { timeout: 3000 });
    });

    console.log(`[subagent window] open: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.SUBAGENT_WINDOW_OPEN);
  });

  it('closes subagent window within threshold', async () => {
    // Ensure a window is open
    const hasWindow = await page.locator('.subagent-window').count().then(c => c > 0);
    if (!hasWindow) {
      const claudeSessionId = await page.evaluate((sid: string) => {
        const app = (window as unknown as { app: { sessions: Map<string, { claudeSessionId?: string }> } }).app;
        return app.sessions.get(sid)?.claudeSessionId || 'fake-claude-session';
      }, sessionId);
      await page.evaluate(({ cSessionId }: { cSessionId: string }) => {
        const app = (window as unknown as {
          app: {
            subagents: Map<string, Record<string, unknown>>;
            openSubagentWindow: (id: string) => void;
          }
        }).app;
        app.subagents.set('perf-agent-close', {
          agentId: 'perf-agent-close',
          sessionId: cSessionId,
          status: 'active',
          description: 'Close test agent',
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          toolCallCount: 0,
          entryCount: 0,
          fileSize: 0,
        });
        app.openSubagentWindow('perf-agent-close');
      }, { cSessionId: claudeSessionId });
      await page.waitForSelector('.subagent-window', { timeout: 3000 });
    }

    const timing = await measure(async () => {
      await page.evaluate(() => {
        const app = (window as unknown as { app: { closeSubagentWindow: (id: string) => void } }).app;
        const win = document.querySelector('.subagent-window');
        const id = win?.id?.replace('subagent-window-', '') || 'perf-agent-close';
        app.closeSubagentWindow(id);
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.subagent-window').length === 0,
        { timeout: 2000 },
      );
    });

    console.log(`[subagent window] close: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.SUBAGENT_WINDOW_CLOSE);
  });

  it('opens 5 subagent windows without jank', async () => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const claudeSessionId = await page.evaluate((sid: string) => {
      const app = (window as unknown as { app: { sessions: Map<string, { claudeSessionId?: string }> } }).app;
      return app.sessions.get(sid)?.claudeSessionId || 'fake-claude-session';
    }, sessionId);

    const timing = await measure(async () => {
      for (let i = 0; i < 5; i++) {
        await page.evaluate(({ idx, cSessionId }: { idx: number; cSessionId: string }) => {
          const agentId = `perf-multi-agent-${idx}`;
          const app = (window as unknown as {
            app: {
              subagents: Map<string, Record<string, unknown>>;
              openSubagentWindow: (id: string) => void;
            }
          }).app;
          app.subagents.set(agentId, {
            agentId,
            sessionId: cSessionId,
            status: 'active',
            description: `Perf agent ${idx}`,
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
            toolCallCount: 0,
            entryCount: 0,
            fileSize: 0,
          });
          app.openSubagentWindow(agentId);
        }, { idx: i, cSessionId: claudeSessionId });
      }
      // Wait for all 5
      await page.waitForFunction(
        () => document.querySelectorAll('.subagent-window').length >= 5,
        { timeout: 5000 },
      );
    });

    const windowCount = await page.locator('.subagent-window').count();
    console.log(`[subagent window] open 5: ${timing.toFixed(0)}ms (${windowCount} windows)`);
    expect(timing).toBeLessThan(THRESHOLDS.SUBAGENT_WINDOW_OPEN * 5);
    expect(errors).toHaveLength(0);

    // Clean up
    await page.evaluate(() => {
      const app = (window as unknown as { app: { closeSubagentWindow: (id: string) => void } }).app;
      for (let i = 0; i < 5; i++) {
        app.closeSubagentWindow(`perf-multi-agent-${i}`);
      }
    });
  });
});

describe('SSE event throughput', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('handles rapid session creation SSE events without errors', async () => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const sessionIds: string[] = [];
    const start = performance.now();

    // Create 5 sessions rapidly
    for (let i = 0; i < 5; i++) {
      const id = await createSession(page, `perf-sse-${i}`);
      sessionIds.push(id);
    }

    // Wait for all tabs to appear
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('.session-tab').length >= count,
      sessionIds.length,
      { timeout: 5000 },
    );
    const elapsed = performance.now() - start;

    console.log(`[SSE throughput] ${sessionIds.length} session events processed: ${elapsed.toFixed(0)}ms`);
    expect(errors).toHaveLength(0);

    // Cleanup
    for (const id of sessionIds) {
      await deleteSession(page, id).catch(() => {});
    }
  });

  it('handles rapid session deletion SSE events', async () => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Create then delete rapidly
    const sessionIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      sessionIds.push(await createSession(page, `perf-del-${i}`));
    }
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('.session-tab').length >= count,
      sessionIds.length,
      { timeout: 5000 },
    );

    const start = performance.now();
    for (const id of sessionIds) {
      await deleteSession(page, id);
    }
    // Wait for tabs to disappear
    await page.waitForFunction(
      () => {
        const tabs = document.querySelectorAll('.session-tab');
        for (const tab of tabs) {
          if (tab.getAttribute('data-id')?.startsWith('perf-del-')) return false;
        }
        return true;
      },
      { timeout: 5000 },
    );
    const elapsed = performance.now() - start;

    console.log(`[SSE throughput] ${sessionIds.length} deletion events processed: ${elapsed.toFixed(0)}ms`);
    expect(errors).toHaveLength(0);
  });
});

describe('Buffer loading performance', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    sessionId = await createSession(page, 'perf-buffer');
    await page.waitForSelector(`.session-tab[data-id="${sessionId}"]`, { timeout: 3000 });
    await page.locator(`.session-tab[data-id="${sessionId}"]`).click();
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId).catch(() => {});
    await context?.close();
  });

  it('fetches terminal buffer via API quickly', async () => {
    const timing = await measure(async () => {
      await page.evaluate(async (sid: string) => {
        const res = await fetch(`/api/sessions/${sid}/buffer`);
        await res.text();
      }, sessionId);
    });

    console.log(`[buffer load] API fetch: ${timing.toFixed(0)}ms`);
    expect(timing).toBeLessThan(THRESHOLDS.BUFFER_LOAD_16KB);
  });
});

describe('Memory usage under load', () => {
  let context: BrowserContext;
  let page: Page;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    for (const id of sessionIds) {
      await deleteSession(page, id).catch(() => {});
    }
    await context?.close();
  });

  it('heap stays within limits after creating 10 sessions and switching', async () => {
    const heapBefore = await getHeapMB(page);

    // Create 10 sessions
    for (let i = 0; i < 10; i++) {
      const id = await createSession(page, `perf-mem-${i}`);
      sessionIds.push(id);
    }
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('.session-tab').length >= count,
      10,
      { timeout: 5000 },
    );

    // Switch through all tabs
    for (const id of sessionIds) {
      await page.locator(`.session-tab[data-id="${id}"]`).click();
      await page.waitForTimeout(50);
    }

    const heapAfter = await getHeapMB(page);
    const heapGrowth = heapAfter - heapBefore;

    console.log(`[memory] before: ${heapBefore.toFixed(1)}MB, after: ${heapAfter.toFixed(1)}MB, growth: ${heapGrowth.toFixed(1)}MB`);

    // Heap should stay under absolute limit
    if (heapAfter > 0) { // memory API may not be available
      expect(heapAfter).toBeLessThan(THRESHOLDS.MEMORY_HEAP_MB);
    }
  });
});

describe('No console errors during normal usage', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
  });

  afterAll(async () => {
    await context?.close();
  });

  it('page loads and runs without JS errors', async () => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await navigateAndWait(page);

    // Create a session, switch to it, open settings, close settings
    const id = await createSession(page, 'perf-no-errors');
    await page.waitForSelector(`.session-tab[data-id="${id}"]`, { timeout: 3000 });
    await page.locator(`.session-tab[data-id="${id}"]`).click();
    await page.waitForTimeout(300);

    await page.locator('.btn-settings').click();
    await page.waitForSelector('#appSettingsModal.active', { timeout: 2000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    await deleteSession(page, id).catch(() => {});
    await page.waitForTimeout(500);

    if (errors.length > 0) {
      console.log('[errors]', errors);
    }
    expect(errors).toHaveLength(0);
  });
});

describe('Performance summary', () => {
  it('prints threshold reference', () => {
    console.log('\n--- Performance Thresholds ---');
    for (const [name, value] of Object.entries(THRESHOLDS)) {
      console.log(`  ${name}: ${value}ms`);
    }
    console.log('-----------------------------\n');
  });
});
