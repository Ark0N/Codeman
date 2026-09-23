/**
 * @fileoverview Table-driven pin for `run()`'s dispatch in session-ui.js
 * (PR #458). Before the run-menu consolidation, `run()` was an eight-arm
 * `if (mode === 'codex') return this.runCodex(); ...` chain and each arm was
 * pinned only by the name it called; after it, every non-claude, non-shell
 * mode reaches ONE shared launcher, `_runCliMode(mode)`, gated on
 * `EXTERNAL_CLI_MODES` (the key set of `RUN_MODE_LAUNCH`). Nothing pinned that
 * gate: a mode dropped from the table would fall through to `runClaude()` and
 * start a Claude session under a Codex label with no error, while an unknown
 * mode reaching `_runCliMode()` would throw on `entry.label` of an undefined
 * entry.
 *
 * The external ids are read off `RUN_MODE_LAUNCH` itself (same JSDOM
 * extraction as test/run-mode-launch-table-drift.test.ts, which separately
 * pins that key set against stock.ts), so a ninth CLI is covered the day it
 * lands in the table.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const SESSION_UI_JS = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');

interface HarnessApp {
  _runMode?: string;
  _runInFlight?: boolean;
  _runMinLockMs?: number;
  run: () => Promise<unknown>;
  runClaude: ReturnType<typeof vi.fn>;
  runShell: ReturnType<typeof vi.fn>;
  _runCliMode: ReturnType<typeof vi.fn>;
}

interface Harness {
  app: HarnessApp;
  runBtn: HTMLButtonElement;
  externalIds: string[];
}

function loadHarness(): Harness {
  const dom = new JSDOM('<!doctype html><body><button id="runBtn"></button></body>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
  });
  const win = dom.window as unknown as {
    eval: (s: string) => void;
    document: Document;
    CodemanApp: new () => HarnessApp;
    __TEST_RUN_MODE_LAUNCH: Record<string, unknown>;
  };
  win.eval('window.CodemanApp = function CodemanApp() {};');
  // The assignment rides in the SAME evaluated string as the module:
  // RUN_MODE_LAUNCH is a bare top-level `const`, visible only to this eval call
  // (see test/run-mode-launch-table-drift.test.ts for the measurement).
  win.eval(`${SESSION_UI_JS}\nwindow.__TEST_RUN_MODE_LAUNCH = RUN_MODE_LAUNCH;`);
  const app = new win.CodemanApp();
  app._runMinLockMs = 0; // run() otherwise holds its lock for >= 500ms per call
  app.runClaude = vi.fn(async () => 'claude');
  app.runShell = vi.fn(async () => 'shell');
  app._runCliMode = vi.fn(async (mode: string) => `cli:${mode}`);
  return {
    app,
    runBtn: win.document.getElementById('runBtn') as HTMLButtonElement,
    externalIds: Object.keys(win.__TEST_RUN_MODE_LAUNCH),
  };
}

describe('run() dispatch (session-ui.js)', () => {
  const { externalIds } = loadHarness();

  it('reads at least the eight external CLIs off RUN_MODE_LAUNCH (anti-vacuity)', () => {
    expect(externalIds.length).toBeGreaterThanOrEqual(8);
    expect(externalIds).not.toContain('claude');
    expect(externalIds).not.toContain('shell');
  });

  it("'claude' reaches runClaude() and nothing else", async () => {
    const { app } = loadHarness();
    app._runMode = 'claude';
    await expect(app.run()).resolves.toBe('claude');
    expect(app.runClaude).toHaveBeenCalledTimes(1);
    expect(app._runCliMode).not.toHaveBeenCalled();
    expect(app.runShell).not.toHaveBeenCalled();
  });

  it("'shell' reaches runShell(), which needs no CLI probe at all", async () => {
    const { app } = loadHarness();
    app._runMode = 'shell';
    await expect(app.run()).resolves.toBe('shell');
    expect(app.runShell).toHaveBeenCalledTimes(1);
    expect(app.runClaude).not.toHaveBeenCalled();
    expect(app._runCliMode).not.toHaveBeenCalled();
  });

  for (const id of externalIds) {
    it(`'${id}' reaches _runCliMode('${id}') and never runClaude()`, async () => {
      const { app } = loadHarness();
      app._runMode = id;
      await expect(app.run()).resolves.toBe(`cli:${id}`);
      expect(app._runCliMode).toHaveBeenCalledTimes(1);
      expect(app._runCliMode).toHaveBeenCalledWith(id);
      expect(app.runClaude).not.toHaveBeenCalled();
      expect(app.runShell).not.toHaveBeenCalled();
    });
  }

  it('an unknown mode lands on runClaude(), never on the shared launcher', async () => {
    // `_runCliMode(mode)` reads `RUN_MODE_LAUNCH[mode].label` unguarded, so an
    // unknown id reaching it would throw rather than launch anything.
    for (const mode of ['nope', 'CLAUDE', 'code x']) {
      const { app } = loadHarness();
      app._runMode = mode;
      await expect(app.run()).resolves.toBe('claude');
      expect(app.runClaude).toHaveBeenCalledTimes(1);
      expect(app._runCliMode).not.toHaveBeenCalled();
      expect(app.runShell).not.toHaveBeenCalled();
    }
  });

  it('an unset or empty _runMode defaults to claude', async () => {
    for (const mode of [undefined, '']) {
      const { app } = loadHarness();
      app._runMode = mode;
      await expect(app.run()).resolves.toBe('claude');
      expect(app.runClaude).toHaveBeenCalledTimes(1);
      expect(app._runCliMode).not.toHaveBeenCalled();
    }
  });

  it('holds the launch lock for the whole launch and releases it afterwards', async () => {
    const { app, runBtn } = loadHarness();
    app._runMode = 'codex';
    const pending = app.run();
    expect(app._runInFlight).toBe(true);
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.getAttribute('aria-busy')).toBe('true');
    // A second click while the first launch is in flight is a no-op.
    await expect(app.run()).resolves.toBeUndefined();
    await pending;
    expect(app._runCliMode).toHaveBeenCalledTimes(1);
    expect(app._runInFlight).toBe(false);
    expect(runBtn.disabled).toBe(false);
    expect(runBtn.hasAttribute('aria-busy')).toBe(false);
  });
});
