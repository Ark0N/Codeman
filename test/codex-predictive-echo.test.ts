/**
 * @fileoverview Predictive-echo E2E against a REAL codex 0.147 TUI (issues
 * #218/#219/#220/#222 retest scenarios + the byte-identity and simulated-RTT
 * pins). CI-EXCLUDED (needs chromium + the codex binary); a REQUIRED item of
 * the release checklist.
 *
 * Unlike the other Playwright tests this one cannot use the in-process
 * WebServer: under VITEST the mux layer is a pure in-memory mock and Session
 * spawns an echo PTY, so no real codex would ever run. The lab server is a
 * CHILD PROCESS with the VITEST markers stripped from its env, isolated via
 * CODEMAN_INSTANCE=codexlab (own data dir under the per-test fixture HOME +
 * own tmux socket) on port 3222 (3220/3221 are taken; see the port sweep in
 * the plan). Codex runs against a throwaway CODEX_HOME with a fake API key
 * (never leaves the box: the first request 401s, which is fine — every
 * scenario here is about the composer, not completions).
 *
 * Run: npx vitest run --config config/vitest.config.ts test/codex-predictive-echo.test.ts
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const PORT = 3222;
const BASE_URL = `http://localhost:${PORT}`;
const INSTANCE = 'codexlab';
const TMUX = `tmux -L codeman-${INSTANCE}`;
const ROOT = resolve(import.meta.dirname, '..');
const CODEX_BIN_DIR = `${userInfo().homedir}/.local/bin`;

let server: ChildProcess | null = null;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let codexHome: string;
let trustedWorkdir: string;
let untrustedWorkdir: string;
let sessionId: string;
const createdSessions: string[] = [];

/** The transport edge the recorders wrap: every typed producer reaches it through the session FIFO. */
type ReliableSend = (sid: string, data: string, opts?: unknown) => void;
interface RecorderWindow {
  app: { _enqueueReliableInput: ReliableSend };
  __dbg: Array<[string, string]>;
  __trace: string[];
  __origSend?: ReliableSend;
  __origSend2?: ReliableSend;
}

function hasCodex(): boolean {
  try {
    execSync(`PATH="${CODEX_BIN_DIR}:$PATH" codex --version`, { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error('[codex-e2e] codex unavailable:', (e as Error).message.slice(0, 300));
    return false;
  }
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

const paneByTail = new Map<string, string>();

/** Rendered pane text (tmux ground truth). Panes are found once by the
 *  workdir basename codex prints in its banner, then cached by pane id —
 *  the lab tmux socket is exclusive to this test. */
function capturePaneFor(workdir: string): string {
  const tail = workdir.split('/').pop()!;
  const panes = execSync(`${TMUX} list-panes -a -F '#{pane_id}'`, { encoding: 'utf8' }).trim().split('\n');
  const capture = (p: string) => execSync(`${TMUX} capture-pane -p -t '${p}'`, { encoding: 'utf8' });
  const cached = paneByTail.get(tail);
  if (cached && panes.includes(cached)) return capture(cached);
  for (const p of panes.filter(Boolean)) {
    const text = capture(p);
    if (text.includes(tail)) {
      paneByTail.set(tail, p);
      return text;
    }
  }
  throw new Error(`no pane showing workdir ${tail}; panes: ${panes.join(', ')}`);
}

async function createCodexSession(workingDir: string): Promise<string> {
  const created = await api('POST', '/api/sessions', {
    mode: 'codex',
    workingDir,
    envOverrides: { CODEX_HOME: codexHome },
  });
  // Tolerate both the ApiResponse envelope and the legacy raw shape
  const payload = created.data ?? created;
  const id = payload.session?.id ?? payload.id ?? payload.sessionId;
  expect(id, JSON.stringify(created).slice(0, 300)).toBeTruthy();
  createdSessions.push(id);
  return id;
}

/** Select the session in the UI and wait for the codex composer to render. */
async function openInBrowser(id: string): Promise<void> {
  await page.evaluate((sid) => (window as any).app.selectSession(sid), id);
  await page.waitForFunction(
    () => {
      const app = (window as any).app;
      const buf = app.terminal?.buffer.active;
      if (!buf) return false;
      for (let y = 0; y < app.terminal.rows; y++) {
        const t = buf.getLine(buf.baseY + y)?.translateToString(true) ?? '';
        if (/^› /.test(t)) return true;
      }
      return false;
    },
    undefined,
    { timeout: 30000 }
  );
  await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
  await page.waitForFunction(() => (window as any).app._localEchoPolicy === 'predict');
  // Wait for the exact typing precondition: the CURSOR parked on the composer
  // row (the predictWhen gate itself), not merely a composer row existing —
  // during the boot animation the cursor roams and predictions are suppressed.
  await page.waitForFunction(
    () => {
      const w = window as any;
      return w.CodemanTerminalInput.isCodexComposerRow(w.app.terminal);
    },
    undefined,
    { timeout: 20000 }
  );
  await new Promise((r) => setTimeout(r, 300));
}

function predictState(): Promise<{ outstanding: number; confirmedTotal: number; droppedTotal: number }> {
  return page.evaluate(() => (window as any).app._predictiveEcho.state);
}

function spanCount(): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length);
}

/** Deterministic composer reset: codex's Ctrl+U kills only to LINE START, so
 *  End first; then a settle. Leaves the cursor parked on an empty composer. */
async function resetComposer(): Promise<void> {
  // Codex can be mid-respawn after an exhausted 401 retry loop killed it:
  // wait for a live composer (the gate itself) before touching the keyboard.
  await page.waitForFunction(
    () => {
      const w = window as any;
      return w.CodemanTerminalInput.isCodexComposerRow(w.app.terminal);
    },
    undefined,
    { timeout: 25000 }
  );
  await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
  await page.keyboard.press('End');
  await page.keyboard.press('Control+u');
  await new Promise((r) => setTimeout(r, 400));
}

/** After a submit 401s, codex sits in a Reconnecting retry loop that can eat
 *  typed input; Esc interrupts it. Wait until the retry line is gone. */
async function cancelRetryLoop(): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pane = capturePaneFor(trustedWorkdir);
    if (!/Reconnecting|esc to interrupt/.test(pane)) break;
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 500));
  }
  // Settle to a live composer (codex may have died at 5/5 and respawned),
  // then require it to STAY alive: the fake-key request can kill codex
  // seconds later, so a single gate-true observation is not enough.
  const stableDeadline = Date.now() + 30000;
  for (;;) {
    await resetComposer();
    let stable = true;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const alive = await page.evaluate(() => {
        const w = window as any;
        return w.CodemanTerminalInput.isCodexComposerRow(w.app.terminal);
      });
      if (!alive) {
        stable = false;
        break;
      }
    }
    if (stable || Date.now() > stableDeadline) return;
  }
}

const CODEX_AVAILABLE = hasCodex();
const d = CODEX_AVAILABLE ? describe : describe.skip;

beforeAll(async () => {
  if (!CODEX_AVAILABLE) return;
  codexHome = mkdtempSync(resolve(ROOT, 'tmp', 'codexlab-'));
  trustedWorkdir = mkdtempSync(resolve(ROOT, 'tmp', 'codexlab-work-'));
  untrustedWorkdir = mkdtempSync(resolve(ROOT, 'tmp', 'codexlab-untrusted-'));
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(resolve(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-123' }));
  writeFileSync(resolve(codexHome, 'config.toml'), `[projects."${trustedWorkdir}"]\ntrust_level = "trusted"\n`);

  // Child env: strip the vitest markers so the lab server runs REAL tmux/codex
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_MODE;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  delete env.NODE_ENV;
  env.CODEMAN_INSTANCE = INSTANCE;
  env.PATH = `${CODEX_BIN_DIR}:${env.PATH}`;

  server = spawn('npx', ['tsx', 'src/index.ts', 'web', '--port', String(PORT)], {
    cwd: ROOT,
    env: env as NodeJS.ProcessEnv,
    stdio: 'ignore',
    detached: false,
  });

  // Wait for the lab server
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/api/status`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('lab server did not start on :3222');
    await new Promise((r) => setTimeout(r, 300));
  }

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('codeman-app-settings', JSON.stringify({ localEchoEnabled: true }));
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 10000 });

  sessionId = await createCodexSession(trustedWorkdir);
  await openInBrowser(sessionId);
}, 120_000);

afterAll(async () => {
  for (const id of createdSessions) {
    try {
      await api('DELETE', `/api/sessions/${id}`);
    } catch {
      /* best effort */
    }
  }
  await context?.close();
  await browser?.close();
  server?.kill('SIGTERM');
  try {
    execSync(`${TMUX} kill-server`, { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}, 30_000);

d('codex predictive echo E2E (real codex TUI)', () => {
  it('bundle smoke: both echo globals are defined', async () => {
    const globals = await page.evaluate(() => ({
      zerolag: typeof (window as any).LocalEchoOverlay,
      predictive: typeof (window as any).PredictiveEchoOverlay,
      instance: !!(window as any).app._predictiveEcho,
    }));
    expect(globals.zerolag).toBe('function');
    expect(globals.predictive).toBe('function');
    expect(globals.instance).toBe(true);
  });

  it('typing predicts every char and converges into the real echo', async () => {
    await page.keyboard.type('hello', { delay: 30 });
    // Keystrokes went through the predictor (a transient repaint may suppress
    // one or two: that is designed graceful degradation, never a ghost)
    await page.waitForFunction(() => {
      const s = (window as any).app._predictiveEcho.state;
      return s.confirmedTotal + s.outstanding >= 3;
    });
    // Convergence: spans gone, composer shows the text, ZERO mispredictions
    await page.waitForFunction(
      () => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length === 0
    );
    const s = await predictState();
    expect(s.confirmedTotal).toBeGreaterThanOrEqual(3);
    expect(s.droppedTotal).toBe(0);
    const deadline = Date.now() + 10000;
    let pane = '';
    while (Date.now() < deadline) {
      pane = capturePaneFor(trustedWorkdir);
      if (pane.includes('hello')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(pane).toContain('hello');
  }, 30_000);

  it('#222: slash picker filters live while predictions confirm away', async () => {
    await resetComposer();
    await page.keyboard.type('/', { delay: 30 });
    const deadline = Date.now() + 10000;
    let pane = '';
    while (Date.now() < deadline) {
      pane = capturePaneFor(trustedWorkdir);
      if (/\/model|\/skills|\/init/.test(pane)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(pane).toMatch(/\/model|\/skills|\/init/);
    await page.keyboard.type('mo', { delay: 40 });
    await page.waitForFunction(
      () => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length === 0
    );
    const filtered = capturePaneFor(trustedWorkdir);
    expect(filtered).toContain('/model');
    await page.keyboard.press('Escape'); // close the picker
    await page.keyboard.press('Control+u'); // deterministically empty the composer
    await new Promise((r) => setTimeout(r, 300));
    const s = await predictState();
    expect(s.outstanding).toBe(0);
  }, 30_000);

  it('#219: typed text + paste land in order with nothing dropped', async () => {
    await resetComposer();
    const pidBefore = execSync(`${TMUX} list-panes -a -F '#{pane_id} #{pane_pid}'`, { encoding: 'utf8' }).trim();
    await page.evaluate(() => {
      const w = window as unknown as RecorderWindow;
      const app = w.app;
      w.__dbg = [];
      const original = (w.__origSend2 ??= app._enqueueReliableInput.bind(app));
      app._enqueueReliableInput = (sid, data, opts) => {
        w.__dbg.push([sid.slice(0, 8), JSON.stringify(data)]);
        return original(sid, data, opts);
      };
    });
    await page.keyboard.type('abc', { delay: 30 });
    await page.evaluate(() => (window as any).app.terminal.paste('XYZ'));
    const deadline = Date.now() + 15000;
    let pane = '';
    while (Date.now() < deadline) {
      pane = capturePaneFor(trustedWorkdir);
      if (pane.includes('abcXYZ')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!pane.includes('abcXYZ')) {
      const pidAfter = execSync(`${TMUX} list-panes -a -F '#{pane_id} #{pane_pid}'`, { encoding: 'utf8' }).trim();
      const dbg = await page.evaluate(() => (window as any).__dbg);
      const row = await page.evaluate(() => {
        const b = (window as any).app.terminal.buffer.active;
        return b.getLine(b.baseY + b.cursorY)?.translateToString(true);
      });
      console.log(
        'DBG219 pids-before:',
        pidBefore,
        '| pids-after:',
        pidAfter,
        '| sends:',
        JSON.stringify(dbg),
        '| app-cursor-row:',
        JSON.stringify(row)
      );
    }
    expect(pane).toContain('abcXYZ');
    expect(await spanCount()).toBe(0); // paste classified 'clear'
    await page.keyboard.press('Control+u'); // Ctrl+U: clear the composer line
  }, 30_000);

  it('#220: wrapped input renders exactly, no ghost glyphs past the edge', async () => {
    await resetComposer();
    const long = 'the quick brown fox jumps over the lazy dog and keeps running until the composer has to wrap';
    await page.keyboard.type(long, { delay: 5 });
    // Predictions on the first composer row confirm or drop; continuation
    // rows are gate-suppressed. Everything converges:
    await page.waitForFunction(
      () => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length === 0,
      undefined,
      { timeout: 10000 }
    );
    const deadline = Date.now() + 10000;
    let ok = false;
    while (Date.now() < deadline) {
      const pane = capturePaneFor(trustedWorkdir).replace(/\s+/g, ' ');
      if (pane.includes('composer has to wrap')) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(ok).toBe(true);
    await page.keyboard.press('Control+u');
    await new Promise((r) => setTimeout(r, 200));
  }, 45_000);

  it('modal ghost eliminator: zero spans while typing on the trust dialog', async () => {
    const modalSession = await createCodexSession(untrustedWorkdir);
    try {
      await page.evaluate((sid) => (window as any).app.selectSession(sid), modalSession);
      // Wait for the trust dialog (the pane may not exist for the first second)
      const deadline = Date.now() + 25000;
      let pane = '';
      while (Date.now() < deadline) {
        try {
          pane = capturePaneFor(untrustedWorkdir);
          if (pane.includes('Press enter to continue')) break;
        } catch {
          /* session still spawning */
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(pane).toContain('Press enter to continue');
      await page.waitForFunction(() => (window as any).app._localEchoPolicy === 'predict');
      await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
      await page.keyboard.type('x', { delay: 30 });
      expect(await spanCount()).toBe(0); // gate rejected: no ghost on the modal
      expect((await predictState()).outstanding).toBe(0);
    } finally {
      // Never strand later tests on the modal session
      await api('DELETE', `/api/sessions/${modalSession}`);
      await page.evaluate((sid) => (window as any).app.selectSession(sid), sessionId);
      await page.waitForFunction(() => (window as any).app._localEchoPolicy === 'predict');
      await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
    }
  }, 45_000);

  it('kill switch: localEchoEnabled OFF clears spans and typing still streams', async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      const s = app.loadAppSettingsFromStorage();
      s.localEchoEnabled = false;
      app.saveAppSettingsToStorage(s);
      app._updateLocalEchoState();
    });
    expect(await page.evaluate(() => (window as any).app._localEchoPolicy)).toBe('off');
    expect(await spanCount()).toBe(0);
    await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
    await page.keyboard.press('End');
    await page.keyboard.press('Control+u');
    await page.keyboard.type('still-live', { delay: 20 });
    const deadline = Date.now() + 10000;
    let pane = '';
    while (Date.now() < deadline) {
      pane = capturePaneFor(trustedWorkdir);
      if (pane.includes('still-live')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(pane).toContain('still-live'); // 1.12.2 behavior exactly
    expect(await spanCount()).toBe(0);
    await page.evaluate(() => {
      const app = (window as any).app;
      const s = app.loadAppSettingsFromStorage();
      s.localEchoEnabled = true;
      app.saveAppSettingsToStorage(s);
      app._updateLocalEchoState();
    });
    await page.keyboard.press('Control+u');
    await new Promise((r) => setTimeout(r, 200));
  }, 30_000);

  it('byte-identity: the wire receives the same bytes with the predictor active vs absent', async () => {
    const script = async () => {
      await resetComposer();
      await page.keyboard.type('ab', { delay: 60 });
      await page.keyboard.press('Backspace');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.type('c', { delay: 60 });
      await page.evaluate(() => (window as any).app.terminal.paste('PQ'));
      await new Promise((r) => setTimeout(r, 250));
      await page.keyboard.press('End');
      await page.keyboard.press('Control+u');
      await new Promise((r) => setTimeout(r, 250));
    };

    const record = () =>
      page.evaluate(() => {
        const w = window as unknown as RecorderWindow;
        const app = w.app;
        w.__trace = [];
        const original = (w.__origSend ??= app._enqueueReliableInput.bind(app));
        app._enqueueReliableInput = (sid, data, opts) => {
          w.__trace.push(data);
          return original(sid, data, opts);
        };
      });
    const trace = () => page.evaluate(() => (window as unknown as RecorderWindow).__trace.join(''));

    await record();
    await script();
    const withPredictor = await trace();

    await page.evaluate(() => {
      (window as any).__savedPredictor = (window as any).app._predictiveEcho;
      (window as any).app._predictiveEcho = null;
    });
    await record();
    await script();
    const withoutPredictor = await trace();
    await page.evaluate(() => {
      (window as any).app._predictiveEcho = (window as any).__savedPredictor;
    });

    expect(withPredictor.length).toBeGreaterThan(0);
    expect(withoutPredictor).toBe(withPredictor); // the visual-only invariant, end to end
  }, 60_000);

  it('#218: arrows + mid-word insert submit the exact edited text', async () => {
    await resetComposer();
    await page.keyboard.type('hello', { delay: 30 });
    await new Promise((r) => setTimeout(r, 300));
    await page.keyboard.press('ArrowLeft');
    // Nav keys clear predictions immediately (classify 'clear')
    expect(await predictState()).toMatchObject({ outstanding: 0 });
    expect(await spanCount()).toBe(0);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('X', { delay: 30 });
    await page.keyboard.press('Enter');
    // The submitted transcript line carries the edited text
    const deadline = Date.now() + 15000;
    let pane = '';
    while (Date.now() < deadline) {
      pane = capturePaneFor(trustedWorkdir);
      if (pane.includes('helXlo')) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(pane).toContain('helXlo');
    expect(await spanCount()).toBe(0);
    await cancelRetryLoop();
  }, 45_000);

  it('simulated 300ms RTT: instant spans with correct pixel geometry, exact convergence', async () => {
    await resetComposer();
    // Delay every terminal.write chunk by 300ms: display-side injection only,
    // the wire is untouched. This is the condition the feature exists for.
    await page.evaluate(() => {
      const app = (window as any).app;
      (window as any).__origWrite = app.terminal.write.bind(app.terminal);
      app.terminal.write = (data: unknown, cb?: () => void) =>
        setTimeout(() => (window as any).__origWrite(data, cb), 300);
    });
    // Let any pre-wrapper chunks and their reconcile passes settle first
    await new Promise((r) => setTimeout(r, 700));
    const base = await predictState();

    await page.keyboard.press('h');
    // The span exists NOW, long before the delayed echo can land
    const snap = await page.evaluate(() => {
      const app = (window as any).app;
      const span = document.querySelector('.xterm-screen [data-predictive-echo] span') as HTMLElement;
      const screen = document.querySelector('.xterm-screen') as HTMLElement;
      const dims = app.terminal._core._renderService.dimensions.css.cell;
      const buf = app.terminal.buffer.active;
      return span
        ? {
            outstanding: app._predictiveEcho.state.outstanding,
            spanLeft: span.getBoundingClientRect().left - screen.getBoundingClientRect().left,
            spanTop: span.getBoundingClientRect().top - screen.getBoundingClientRect().top,
            expectedLeft: buf.cursorX * dims.width,
            expectedTop: buf.cursorY * dims.height,
            text: span.textContent,
          }
        : null;
    });
    expect(snap).not.toBeNull();
    expect(snap!.outstanding).toBe(1);
    expect(snap!.text).toBe('h');
    // Pixel geometry: the DOM span sits on the exact cell the echo will use
    expect(Math.abs(snap!.spanLeft - snap!.expectedLeft)).toBeLessThan(1.5);
    expect(Math.abs(snap!.spanTop - snap!.expectedTop)).toBeLessThan(1.5);

    await page.keyboard.type('igh rtt', { delay: 40 });
    // (No mid-flight outstanding assertion: with local codex the delayed echo
    // begins confirming DURING the typing. The snap above already pinned the
    // zero-lag property; convergence + the delta below pin the rest.)

    // Full convergence after the delayed echo lands
    await page.waitForFunction(
      () => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length === 0,
      undefined,
      { timeout: 15000 }
    );
    const deadline = Date.now() + 10000;
    let pane = '';
    while (Date.now() < deadline) {
      pane = capturePaneFor(trustedWorkdir);
      if (pane.includes('high rtt')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(pane).toContain('high rtt');
    const after = await predictState();
    expect(after.confirmedTotal - base.confirmedTotal).toBeGreaterThanOrEqual(6); // h + igh rtt

    // #218 under RTT: arrows still edit correctly with the delayed display
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('Z', { delay: 40 });
    await page.keyboard.press('Enter');
    const deadline2 = Date.now() + 15000;
    let pane2 = '';
    while (Date.now() < deadline2) {
      pane2 = capturePaneFor(trustedWorkdir);
      if (pane2.includes('high rtZt')) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(pane2).toContain('high rtZt');

    await page.evaluate(() => {
      (window as any).app.terminal.write = (window as any).__origWrite;
    });
  }, 90_000);
});
