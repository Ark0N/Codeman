/**
 * @fileoverview Frontend tests for the one-shot custom-model launch path added to
 * session-ui.js (docs/custom-model-endpoints-plan.md): `runCustomModelEntry` dispatches
 * to `_runCustomModelEntryOneShot` for every custom-model-eligible CLI except claude,
 * which launches directly on the endpoint (no restart) by folding `customModel` into
 * the run<Mode>() function's own `/api/quick-start` body via `_pendingCustomModelForLaunch`
 * and `_quickStartWithCustomModelConfirm`. Fixes the visible native-boot-then-restart the
 * restart-after-launch path (`_runCustomModelEntryViaRestart`, still used for claude)
 * showed on every custom-model run — confirmed live on Codex, whose TUI fully
 * reinitializes on a restart.
 *
 * Uses the same JSDOM + `runScripts: "dangerously"` approach as
 * test/custom-model-run-menu-ui.test.ts, extended with the DOM elements runCodex() (the
 * CLI this was reported against) reads.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const CONSTANTS_JS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const SESSION_UI_JS = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');

function bootApp() {
  const dom = new JSDOM(
    `<!doctype html><body>
      <select id="quickStartCase"><option value="testcase" selected>testcase</option></select>
      <input id="tabCount" value="1">
      <button id="runBtn"></button>
      <div id="runModeMenu"></div>
    </body>`,
    { url: 'http://localhost/', runScripts: 'dangerously' }
  );
  const win = dom.window as unknown as Window & typeof globalThis & { CodemanApp: new () => any };
  (win as unknown as { eval: (s: string) => void }).eval('window.CodemanApp = function CodemanApp() {};');
  (win as unknown as { eval: (s: string) => void }).eval(CONSTANTS_JS);
  (win as unknown as { eval: (s: string) => void }).eval(SESSION_UI_JS);
  const app = new win.CodemanApp();
  app.cases = [{ name: 'testcase' }];
  app.terminal = { focus: () => {} };
  app.loadAppSettingsFromStorage = () => ({});
  app.getCaseSettings = () => ({});
  app.buildEnvOverrides = () => ({});
  app.showToast = () => {};
  app._beginSessionLaunchStatus = () => 'status-token';
  app._reportSessionLaunchError = (_token: unknown, message: string) => {
    app._lastReportedError = message;
  };
  app._ensureCreatedSessionVisible = async () => {};
  app.selectSession = async () => {};
  app._nextCaseSessionStartNumber = () => 1;
  return { win, app };
}

describe('runCustomModelEntry dispatch', () => {
  it('routes claude through the restart-after-launch path', async () => {
    const { app } = bootApp();
    let calledRestart = false;
    let calledOneShot = false;
    app._runCustomModelEntryViaRestart = async () => {
      calledRestart = true;
    };
    app._runCustomModelEntryOneShot = async () => {
      calledOneShot = true;
    };
    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');
    expect(calledRestart).toBe(true);
    expect(calledOneShot).toBe(false);
  });

  it('routes every other custom-model-eligible CLI through the one-shot path', async () => {
    for (const mode of ['opencode', 'codex', 'gemini', 'pi', 'grok', 'deepseek', 'omp']) {
      const { app } = bootApp();
      let calledRestart = false;
      let calledOneShot = false;
      app._runCustomModelEntryViaRestart = async () => {
        calledRestart = true;
      };
      app._runCustomModelEntryOneShot = async () => {
        calledOneShot = true;
      };
      await app.runCustomModelEntry(mode, 'llama-box', 'qwen3');
      expect(calledRestart, mode).toBe(false);
      expect(calledOneShot, mode).toBe(true);
    }
  });
});

describe('_runCustomModelEntryOneShot', () => {
  it('stashes the pick on _pendingCustomModelForLaunch for the duration of run(), then clears it', async () => {
    const { app } = bootApp();
    let seenDuringRun: unknown;
    app.run = async function (this: typeof app) {
      seenDuringRun = this._pendingCustomModelForLaunch;
    };
    await app._runCustomModelEntryOneShot('codex', 'llama-box', 'qwen3');
    expect(seenDuringRun).toEqual({ endpointId: 'llama-box', modelId: 'qwen3' });
    expect(app._pendingCustomModelForLaunch).toBeUndefined();
  });

  it('clears the pending pick even when run() throws', async () => {
    const { app } = bootApp();
    app.run = async () => {
      throw new Error('boom');
    };
    await expect(app._runCustomModelEntryOneShot('codex', 'llama-box', 'qwen3')).rejects.toThrow('boom');
    expect(app._pendingCustomModelForLaunch).toBeUndefined();
  });

  it('starts the loading watcher when the launch reports modelSwapInProgress, passing the new session id', async () => {
    const { app } = bootApp();
    app.run = async () => {
      app._lastCustomModelLaunchResult = { modelSwapInProgress: true, sessionId: 'new-session' };
    };
    let watched: unknown[] | null = null;
    app._watchLlamaSwapLoading = async (...args: unknown[]) => {
      watched = args;
    };
    await app._runCustomModelEntryOneShot('codex', 'llama-box', 'qwen3');
    expect(watched).toEqual(['llama-box', 'qwen3', 'new-session']);
  });

  it('never starts the watcher when no swap was needed', async () => {
    const { app } = bootApp();
    app.run = async () => {
      app._lastCustomModelLaunchResult = { modelSwapInProgress: false };
    };
    let watchCalled = false;
    app._watchLlamaSwapLoading = async () => {
      watchCalled = true;
    };
    await app._runCustomModelEntryOneShot('codex', 'llama-box', 'qwen3');
    expect(watchCalled).toBe(false);
  });
});

describe('_quickStartWithCustomModelConfirm', () => {
  function withFetch(win: Window & typeof globalThis, handler: (body: any) => any) {
    (win as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, opts: any) => ({
      json: async () => handler(JSON.parse(opts.body)),
    })) as unknown as typeof fetch;
  }

  it('returns the response directly when no confirmation is needed, and records "last used"', async () => {
    const { win, app } = bootApp();
    withFetch(win, (body) => ({ success: true, data: { sessionId: 's1', modelSwapInProgress: false, body } }));
    const data = await app._quickStartWithCustomModelConfirm({
      mode: 'codex',
      customModel: { endpointId: 'e', modelId: 'm' },
    });
    expect(data.success).toBe(true);
    expect(data.data.sessionId).toBe('s1');
    expect(app._lastCustomModelLaunchResult).toEqual(data.data);
    expect(win.localStorage.getItem('codeman:customModelLastUsed:codex:e')).toBe('m');
  });

  it('a plain launch with no customModel at all never touches the "last used" key (undefined endpointId/modelId would otherwise silently no-op it)', async () => {
    const { win, app } = bootApp();
    withFetch(win, () => ({ success: true, data: { sessionId: 's1' } }));
    await app._quickStartWithCustomModelConfirm({ mode: 'codex' });
    expect(win.localStorage.getItem('codeman:customModelLastUsed:codex:undefined')).toBeNull();
  });

  it('confirming re-sends with confirmedSwap, returns the second response, and only THEN records "last used"', async () => {
    const { win, app } = bootApp();
    app._confirmModelSwap = async () => true;
    let calls = 0;
    withFetch(win, (body) => {
      calls += 1;
      if (calls === 1) {
        return {
          success: true,
          data: {
            requiresConfirmation: true,
            currentlyLoadedModel: 'llama3',
            affectedSessions: [{ id: 's2', name: 'w2' }],
          },
        };
      }
      // the SWAP question's own flag, never the blanket `confirmed`: answering this one
      // must not also silence the context-floor warning.
      expect(body.customModel.confirmedSwap).toBe(true);
      expect(body.customModel.confirmed).toBeUndefined();
      return { success: true, data: { sessionId: 's1', modelSwapInProgress: true } };
    });
    const data = await app._quickStartWithCustomModelConfirm({
      mode: 'codex',
      customModel: { endpointId: 'e', modelId: 'm' },
    });
    expect(calls).toBe(2);
    expect(data.data.sessionId).toBe('s1');
    expect(app._lastCustomModelLaunchResult.modelSwapInProgress).toBe(true);
    expect(win.localStorage.getItem('codeman:customModelLastUsed:codex:e')).toBe('m');
  });

  it('cancelling never re-sends, reports a cancellation error, and must NEVER record "last used" for a launch that never happened', async () => {
    const { win, app } = bootApp();
    app._confirmModelSwap = async () => false;
    let calls = 0;
    withFetch(win, () => {
      calls += 1;
      return {
        success: true,
        data: {
          requiresConfirmation: true,
          currentlyLoadedModel: 'llama3',
          affectedSessions: [{ id: 's2', name: 'w2' }],
        },
      };
    });
    const data = await app._quickStartWithCustomModelConfirm({
      mode: 'codex',
      customModel: { endpointId: 'e', modelId: 'm' },
    });
    expect(calls).toBe(1);
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/cancelled/i);
    expect(app._lastCustomModelLaunchResult).toBeUndefined();
    expect(win.localStorage.getItem('codeman:customModelLastUsed:codex:e')).toBeNull();
  });
});

describe('runCodex(): one-shot custom-model launch (the CLI this was reported against)', () => {
  it('folds _pendingCustomModelForLaunch into the quick-start body as customModel', async () => {
    const { win, app } = bootApp();
    (win as unknown as { fetch: typeof fetch }).fetch = (async (url: string, opts?: any) => {
      if (url === '/api/codex/status') return { json: async () => ({ data: { available: true } }) };
      const body = JSON.parse(opts.body);
      expect(body.customModel).toEqual({ endpointId: 'llama-box', modelId: 'qwen3' });
      return { json: async () => ({ success: true, data: { sessionId: 's1', modelSwapInProgress: false } }) };
    }) as unknown as typeof fetch;

    app._pendingCustomModelForLaunch = { endpointId: 'llama-box', modelId: 'qwen3' };
    await app.runCodex();
    expect(app._lastReportedError).toBeUndefined();
  });

  it('omits customModel entirely for a plain (non-custom-model) Codex launch', async () => {
    const { win, app } = bootApp();
    (win as unknown as { fetch: typeof fetch }).fetch = (async (url: string, opts?: any) => {
      if (url === '/api/codex/status') return { json: async () => ({ data: { available: true } }) };
      const body = JSON.parse(opts.body);
      expect(body.customModel).toBeUndefined();
      return { json: async () => ({ success: true, data: { sessionId: 's1' } }) };
    }) as unknown as typeof fetch;

    await app.runCodex();
    expect(app._lastReportedError).toBeUndefined();
  });
});
