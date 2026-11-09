/**
 * @fileoverview The Session Options → Git rows (session-ui.js `updateGitFetchStatus`) as the page drives them: the
 * real index.html in JSDOM with the real app.js and session-ui.js loaded into it, and every session update
 * delivered through app.js `_onSessionUpdated`, the path a `session:updated` SSE event takes.
 *
 * 1. A working session sends `session:updated` on each working/idle change, and that path refreshes the open Git
 *    tab every time, so the control the user is in is left alone: rewriting it put a half-typed "12" back to "300"
 *    before `onchange` could save it. Enter saves with the field still focused, so the save writes the clamped
 *    number back itself.
 * 2. The route takes one field at a time, so a session can hold half an override. The half it did not choose
 *    shows the app's value, which is what the scheduler runs it with, never a default.
 *
 * Port: N/A (no server; the one save is answered by a stub).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const SID = 'session-git-rows';
/** The app setting every case here runs against: on, every 900 s. */
const APP = { gitFetchEnabled: true, gitFetchIntervalSeconds: 900 };

type Update = Record<string, unknown> & { id: string };
type TestApp = Record<string, unknown> & {
  _onSessionUpdated(data: Update): void;
  autoSaveGitFetch(): Promise<void>;
  _apiJson: ReturnType<typeof vi.fn>;
};

let dom: JSDOM;
let CodemanApp: { prototype: object };

beforeAll(async () => {
  dom = new JSDOM(readFileSync(resolve(PUBLIC, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  // app.js starts the app on DOMContentLoaded. Loading it once the document is complete means that never fires
  // here, so the real constructor (SSE, WebSocket, timers) never runs in a window with no server behind it.
  await new Promise<void>((done) =>
    dom.window.document.readyState === 'complete' ? done() : dom.window.addEventListener('load', () => done())
  );
  const context = dom.getInternalVMContext();
  // app.js's last line publishes MobileDetection (mobile-handlers.js), which nothing here otherwise needs.
  vm.runInContext('var MobileDetection = { isTouchDevice: () => false };', context);
  for (const file of ['constants.js', 'app.js', 'session-ui.js']) {
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  }
  CodemanApp = vm.runInContext('CodemanApp', context);
});

afterAll(() => dom.window.close());

beforeEach(() => {
  (dom.window.document.activeElement as HTMLElement | null)?.blur?.();
});

const el = <T extends HTMLElement = HTMLInputElement>(id: string) => dom.window.document.getElementById(id) as T;

/** An app with the Git tab open on SID and everything the update path draws besides it stubbed. */
function openGitTab(): TestApp {
  const app = Object.create(CodemanApp.prototype) as TestApp;
  Object.assign(app, {
    sessions: new Map(),
    _closingSessions: new Set(),
    activeSessionId: null,
    editingSessionId: SID,
    renderSessionTabs: vi.fn(),
    updateCost: vi.fn(),
    updateSubagentParentNames: vi.fn(),
    showToast: vi.fn(),
    loadAppSettingsFromStorage: () => ({ ...APP }),
  });
  return app;
}

describe('Session Options → Git, under session updates', () => {
  it('leaves the interval the user is typing alone when a session update arrives, and still refreshes the run line', () => {
    const app = openGitTab();
    app._onSessionUpdated({ id: SID, status: 'idle', gitFetchEnabled: true, gitFetchIntervalSeconds: 300 });
    const num = el('modalGitFetchInterval');
    expect(num.disabled).toBe(false);
    expect(num.value).toBe('300');

    num.focus();
    expect(dom.window.document.activeElement).toBe(num);
    num.value = '12';
    // The working/idle flip that used to put the field back to 300, carrying a scheduled run's result this time.
    app._onSessionUpdated({
      id: SID,
      status: 'busy',
      gitFetchEnabled: true,
      gitFetchIntervalSeconds: 300,
      gitFetch: { ranAt: Date.now(), trigger: 'interval', state: 'ok', repos: 2, failed: 0 },
    });
    expect(num.value).toBe('12');
    expect(el('gitFetchStatus').textContent).toBe('Last run just now on the interval · 2 repositories');

    // Only the control the user is in is spared: once they leave it, an update shows the stored value again.
    num.blur();
    app._onSessionUpdated({ id: SID, status: 'idle', gitFetchEnabled: true, gitFetchIntervalSeconds: 300 });
    expect(num.value).toBe('300');
  });

  it('writes the clamped interval back when Enter saves with the field still focused', async () => {
    const app = openGitTab();
    app._apiJson = vi.fn(async (_url: string, opts: { body: unknown }) => ({ gitFetchSettings: opts.body }));
    app._onSessionUpdated({ id: SID, status: 'idle', gitFetchEnabled: true, gitFetchIntervalSeconds: 300 });
    const num = el('modalGitFetchInterval');
    num.focus();
    num.value = '12';

    await app.autoSaveGitFetch();
    expect(app._apiJson).toHaveBeenCalledWith(`/api/sessions/${SID}/git-fetch-settings`, {
      method: 'POST',
      body: { enabled: true, intervalSeconds: 30 },
    });
    expect(dom.window.document.activeElement).toBe(num);
    expect(num.value).toBe('30');
  });
});

describe('Session Options → Git, with half an override', () => {
  it("shows the app's switch beside an interval-only override, because the scheduler runs it with that switch", () => {
    const app = openGitTab();
    app._onSessionUpdated({ id: SID, status: 'idle', gitFetchIntervalSeconds: 120 });
    expect(el('modalGitFetchFollow').checked).toBe(false);
    expect(el('modalGitFetchEnabled').checked).toBe(true);
    expect(el('modalGitFetchInterval').value).toBe('120');
    // Not following, so both rows are live, and touching either saves what they show.
    expect(el('modalGitFetchEnabled').disabled).toBe(false);
    expect(el('modalGitFetchInterval').disabled).toBe(false);
  });

  it("shows the app's interval beside a switch-only override, because the scheduler runs it at that interval", () => {
    const app = openGitTab();
    app._onSessionUpdated({ id: SID, status: 'idle', gitFetchEnabled: true });
    expect(el('modalGitFetchFollow').checked).toBe(false);
    expect(el('modalGitFetchEnabled').checked).toBe(true);
    expect(el('modalGitFetchInterval').value).toBe('900');
  });

  it('follows the app on both rows, inert, when the session holds no choice of its own', () => {
    const app = openGitTab();
    app._onSessionUpdated({ id: SID, status: 'idle' });
    expect(el('modalGitFetchFollow').checked).toBe(true);
    expect(el('modalGitFetchEnabled').checked).toBe(true);
    expect(el('modalGitFetchInterval').value).toBe('900');
    expect(el('modalGitFetchEnabled').disabled).toBe(true);
    expect(el('modalGitFetchInterval').disabled).toBe(true);
  });
});
