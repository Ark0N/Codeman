/**
 * Inline rename input tests.
 *
 * Covers the three fixes shipped after the audit of #81:
 *   1. CJK composition guard — Enter/Escape during IME composition belong to
 *      the IME and must not commit/cancel the rename.
 *   2. Ghost tab cleanup — when a session is deleted while its tab is being
 *      renamed, _cleanupSessionData() must cancel the rename so the inline
 *      <input> doesn't ghost on screen.
 *   3. Settle-once — cancel()/blur convergence is idempotent and reliably
 *      clears _activeRename, even on repeated invocation.
 *
 * Strategy: stub a synthetic .tab-name node and a fake session entry, then
 * drive the rename function directly via page.evaluate(). No real PTY/tmux.
 *
 * Ports: 3164, plus 3165 and 3192 for the two server-backed describes below
 * (per MEMORY.md, ports 3150+ for tests)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3164;
const ORDERING_PORT = 3165;
const LONG_PREFIX_PORT = 3192;
const BASE_URL = `http://localhost:${PORT}`;

describe('Inline rename input', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true); // testMode = true
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    // Wait for app.js to expose window.app and finish constructor init.
    await page.waitForFunction(
      () =>
        typeof (window as { app?: unknown }).app !== 'undefined' &&
        !!(window as { app?: { sessions?: Map<string, unknown> } }).app?.sessions
    );
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  // Reset state between tests so each starts from a clean slate.
  async function resetState(): Promise<void> {
    await page.evaluate(() => {
      const app = (
        window as unknown as { app: { _activeRename: { cancel: () => void } | null; sessions: Map<string, unknown> } }
      ).app;
      if (app._activeRename) app._activeRename.cancel();
      app.sessions.clear();
      document.querySelectorAll('[data-test-tab]').forEach((n) => n.remove());
    });
    // Allow any cancel-triggered renderSessionTabs to settle.
    await page.waitForTimeout(20);
  }

  // Helper: stub a session + tab-name DOM node, then start rename.
  // Returns whether the rename input was successfully created.
  async function startRename(sessionId: string, name: string): Promise<boolean> {
    return page.evaluate(
      ({ id, name }) => {
        const app = (
          window as unknown as {
            app: {
              sessions: Map<string, { id: string; name: string }>;
              startInlineRename: (id: string) => void;
            };
          }
        ).app;
        app.sessions.set(id, { id, name });
        const wrap = document.createElement('div');
        wrap.setAttribute('data-test-tab', '1');
        const tabName = document.createElement('span');
        tabName.className = 'tab-name';
        tabName.setAttribute('data-session-id', id);
        tabName.textContent = name;
        wrap.appendChild(tabName);
        document.body.appendChild(wrap);
        app.startInlineRename(id);
        return !!tabName.querySelector('input.tab-rename-input');
      },
      { id: sessionId, name }
    );
  }

  it('CJK guard: Enter with isComposing=true does not commit', async () => {
    await resetState();
    expect(await startRename('cjk-isc', 'OldName')).toBe(true);

    const result = await page.evaluate(() => {
      const app = (window as unknown as { app: { _activeRename: unknown } }).app;
      const input = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      input.value = 'partial-pinyin';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      return {
        inputStillInDom: document.body.contains(input),
        renameStillActive: !!app._activeRename,
      };
    });

    expect(result.inputStillInDom).toBe(true);
    expect(result.renameStillActive).toBe(true);
  });

  it('CJK guard: Enter with legacy keyCode 229 does not commit', async () => {
    await resetState();
    expect(await startRename('cjk-229', 'OldName')).toBe(true);

    const renameStillActive = await page.evaluate(() => {
      const app = (window as unknown as { app: { _activeRename: unknown } }).app;
      const input = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      // Some Safari/Edge versions report keyCode 229 with isComposing=false on the
      // Enter that triggers compositionend — the legacy guard catches that case.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
      return !!app._activeRename;
    });

    expect(renameStillActive).toBe(true);
  });

  it('Escape cancels the rename instead of committing an empty name', async () => {
    await resetState();
    expect(await startRename('esc-cancel', 'rail-beta')).toBe(true);

    // Escape used to clear the field and blur, and the blur handler commits —
    // so cancelling a rename PUT an empty name, and the tab fell back to its
    // folder label (measured against a live server, in the header strip as well
    // as both vertical layouts). The observable here is the REQUEST: this
    // harness's server has no such session, so a failed PUT would leave the
    // local map looking innocent.
    const result = await page.evaluate(async () => {
      const app = (window as unknown as { app: { _activeRename: unknown } }).app;
      const calls: string[] = [];
      const origFetch = window.fetch;
      window.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response('{"success":true}', { status: 200 });
      }) as typeof window.fetch;

      const inputEl = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      inputEl.value = 'typed-but-abandoned';
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // The blur that follows the input's removal must not resurrect the commit.
      inputEl.dispatchEvent(new Event('blur'));
      await new Promise((r) => setTimeout(r, 50));

      window.fetch = origFetch;
      return {
        renamePuts: calls.filter((url) => url.includes('/api/sessions/esc-cancel/name')),
        renameActive: !!app._activeRename,
        inputStillInDom: document.body.contains(inputEl),
      };
    });

    expect(result.renamePuts).toEqual([]);
    expect(result.renameActive).toBe(false);
    expect(result.inputStillInDom).toBe(false);
  });

  it('CJK guard: regular Enter (no IME) DOES commit', async () => {
    await resetState();
    expect(await startRename('regular-enter', 'OldName')).toBe(true);

    // Stub fetch so the commit doesn't hit the real API.
    const result = await page.evaluate(async () => {
      const app = (window as unknown as { app: { _activeRename: unknown } }).app;
      let fetchUrl: string | null = null;
      const origFetch = window.fetch;
      window.fetch = (async (input: RequestInfo | URL) => {
        fetchUrl = String(input);
        return new Response('{"success":true}', { status: 200 });
      }) as typeof window.fetch;

      const inputEl = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      inputEl.value = 'NewName';
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      // Enter calls input.blur() which fires the async finishRename. Wait for it.
      await new Promise((r) => setTimeout(r, 30));

      window.fetch = origFetch;
      return { fetchUrl, renameActive: !!app._activeRename };
    });

    expect(result.fetchUrl).toContain('/api/sessions/regular-enter/name');
    expect(result.renameActive).toBe(false);
  });

  it('Ghost tab: _cleanupSessionData cancels rename for the deleted session', async () => {
    await resetState();
    expect(await startRename('ghost-id', 'OldName')).toBe(true);

    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { sessionId: string } | null;
            sessions: Map<string, unknown>;
            _cleanupSessionData: (id: string) => void;
          };
        }
      ).app;

      let fetchFired = false;
      const origFetch = window.fetch;
      window.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/sessions/ghost-id/name')) fetchFired = true;
        return new Response('{}', { status: 200 });
      }) as typeof window.fetch;

      const matchedBefore = app._activeRename?.sessionId === 'ghost-id';
      app._cleanupSessionData('ghost-id');
      // Cancel triggers async renderSessionTabs; allow it to settle.
      await new Promise((r) => setTimeout(r, 50));

      window.fetch = origFetch;
      return {
        matchedBefore,
        renameActiveAfter: !!app._activeRename,
        sessionGone: !app.sessions.has('ghost-id'),
        fetchFired,
        renameClassActive:
          document.querySelector('.tab-name[data-session-id="ghost-id"]')?.classList.contains('tab-name-renaming') ??
          false,
      };
    });

    expect(result.matchedBefore).toBe(true);
    expect(result.renameActiveAfter).toBe(false);
    expect(result.sessionGone).toBe(true);
    // Cancel path skips the API call — deleting a session shouldn't trigger a stale rename PUT.
    expect(result.fetchFired).toBe(false);
    expect(result.renameClassActive).toBe(false);
  });

  it('Ghost tab: _cleanupSessionData for a DIFFERENT session does NOT cancel rename', async () => {
    await resetState();
    expect(await startRename('keep-rename', 'OldName')).toBe(true);

    const result = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: unknown;
            sessions: Map<string, { id: string; name: string }>;
            _cleanupSessionData: (id: string) => void;
          };
        }
      ).app;
      // Add an unrelated session and delete it — the rename for keep-rename must survive.
      app.sessions.set('unrelated', { id: 'unrelated', name: 'X' });
      app._cleanupSessionData('unrelated');
      return { renameStillActive: !!app._activeRename };
    });

    expect(result.renameStillActive).toBe(true);
  });

  it('Settle-once: cancel() is idempotent and clears _activeRename', async () => {
    await resetState();
    expect(await startRename('idempotent-id', 'OldName')).toBe(true);

    const result = await page.evaluate(async () => {
      const app = (window as unknown as { app: { _activeRename: { cancel: () => void } | null } }).app;
      const cancelFn = app._activeRename!.cancel;
      cancelFn();
      const afterFirst = app._activeRename;
      let threw = false;
      try {
        cancelFn();
      } catch {
        threw = true;
      }
      // Allow any async re-renders to settle.
      await new Promise((r) => setTimeout(r, 30));
      const afterSecond = app._activeRename;
      return { afterFirstNull: afterFirst === null, afterSecondNull: afterSecond === null, threw };
    });

    expect(result.afterFirstNull).toBe(true);
    expect(result.afterSecondNull).toBe(true);
    expect(result.threw).toBe(false);
  });

  it('Render guard: _renderSessionTabsImmediate() does not destroy an open rename input', async () => {
    await resetState();

    // The debounced tab render is scheduled by renderSessionTabs() but EXECUTED by
    // _renderSessionTabsImmediate(). A render queued just before the rename opened
    // still fires ~100ms later and lands in the executor directly, so the guard has
    // to live there too, otherwise the incremental branch rewrites .tab-name's
    // innerHTML and the user's half-typed description is lost.
    //
    // The tab MUST live inside the real #sessionTabs container and be the only
    // session in app.sessions: the renderer walks that container, so a synthetic
    // node parked on <body> would make this test pass with the guard removed.
    const result = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            sessions: Map<string, { id: string; name: string; status: string }>;
            sessionOrder: string[];
            startInlineRename: (id: string) => void;
            _renderSessionTabsImmediate: () => void;
            _activeRename: unknown;
          };
        }
      ).app;
      const id = 'render-race';
      app.sessions.set(id, { id, name: 'w9-case', status: 'idle' });
      app.sessionOrder = [id];

      const container = document.getElementById('sessionTabs') as HTMLElement;
      const tab = document.createElement('div');
      tab.setAttribute('data-test-tab', '1');
      tab.className = 'session-tab';
      tab.dataset.id = id;
      tab.innerHTML =
        '<span class="tab-status idle"></span><span class="tab-info"><span class="tab-name-row">' +
        `<span class="tab-name" data-session-id="${id}">w9-case</span>` +
        '</span></span>';
      container.appendChild(tab);

      app.startInlineRename(id);
      const input = document.querySelector('input.tab-rename-input') as HTMLInputElement | null;
      if (!input) return { opened: false };
      input.value = 'half-typed';

      // Exactly what a debounce timer queued before the rename would do.
      app._renderSessionTabsImmediate();

      const after = document.querySelector('input.tab-rename-input') as HTMLInputElement | null;
      return {
        opened: true,
        stillInDom: !!after && document.body.contains(after),
        value: after?.value ?? null,
        renameStillActive: !!app._activeRename,
      };
    });

    expect(result.opened).toBe(true);
    expect(result.stillInDom).toBe(true);
    expect(result.value).toBe('half-typed');
    expect(result.renameStillActive).toBe(true);
  });

  it('Modal: closeSessionOptions() commits the Session Name field before clearing the id', async () => {
    await resetState();

    // Every autosave handler in the session-options modal bails on a null
    // editingSessionId, and hiding the modal blurs the focused input. If the id is
    // cleared first, the blur-driven save is dropped and the typed name vanishes,
    // which is what Escape and backdrop-click used to do.
    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            editingSessionId: string | null;
            sessions: Map<string, { id: string; name: string }>;
            closeSessionOptions: () => void;
          };
        }
      ).app;
      app.sessions.set('modal-id', { id: 'modal-id', name: 'w9-case' });
      app.editingSessionId = 'modal-id';

      const nameInput = document.getElementById('modalSessionName') as HTMLInputElement;
      const modal = document.getElementById('sessionOptionsModal') as HTMLElement;
      modal.classList.add('active');
      // The Session Name field lives on the modal's Context tab, which is hidden
      // until selected: a hidden input cannot take focus.
      document.getElementById('context-tab')?.classList.remove('hidden');
      nameInput.value = 'mydesc';
      nameInput.focus();
      const wasFocused = document.activeElement === nameInput;

      let putBody: string | null = null;
      const origFetch = window.fetch;
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/api/sessions/modal-id/name')) putBody = String(init?.body ?? '');
        return new Response('{"success":true}', { status: 200 });
      }) as typeof window.fetch;

      app.closeSessionOptions();
      await new Promise((r) => setTimeout(r, 30));
      window.fetch = origFetch;
      modal.classList.remove('active');

      return { wasFocused, putBody, editingAfter: app.editingSessionId };
    });

    expect(result.wasFocused).toBe(true);
    // Prefixed session: the suffix the user typed is appended to the w9-case prefix.
    expect(result.putBody).toContain('w9-case: mydesc');
    expect(result.editingAfter).toBe(null);
  });

  it('Commit writes the confirmed name into app.sessions WITHOUT any session:updated frame', async () => {
    await resetState();
    expect(await startRename('no-sse', 'w9-case')).toBe(true);

    // finishRename() re-renders the tab strip from app.sessions, so the rename
    // used to depend on the session:updated SSE frame to carry its own write
    // back. On a page whose stream has gone quiet without erroring, the PUT
    // stored the new name, the re-render repainted the stale one, and the tab
    // only showed it after a full reload. No SSE is dispatched here at all.
    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: { sessions: Map<string, { id: string; name: string }> };
        }
      ).app;
      const origFetch = window.fetch;
      window.fetch = (async () =>
        new Response('{"success":true,"data":{"name":"w9-case: fresh"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof window.fetch;

      const inputEl = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      inputEl.value = 'fresh';
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));

      window.fetch = origFetch;
      return {
        mapName: app.sessions.get('no-sse')?.name ?? null,
        renameClassActive:
          document.querySelector('.tab-name[data-session-id="no-sse"]')?.classList.contains('tab-name-renaming') ??
          false,
      };
    });

    expect(result.mapName).toBe('w9-case: fresh');
    expect(result.renameClassActive).toBe(false);
  });

  it('A rejected rename restores the old label and leaves app.sessions untouched', async () => {
    await resetState();
    expect(await startRename('rename-500', 'w9-case')).toBe(true);

    // _apiPut turns a network error into a null Response and an API-level
    // failure arrives as a non-ok status, neither of which throws, so a
    // rejected rename has to be detected from the response, or it reports
    // success and silently discards the user's edit.
    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: { sessions: Map<string, { id: string; name: string }>; showToast: (m: string, k: string) => void };
        }
      ).app;
      const toasts: string[] = [];
      const origToast = app.showToast;
      app.showToast = (msg: string) => void toasts.push(msg);
      const origFetch = window.fetch;
      window.fetch = (async () =>
        new Response('{"success":false,"error":"boom","errorCode":"INTERNAL"}', {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof window.fetch;

      const inputEl = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      inputEl.value = 'never-stored';
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));

      window.fetch = origFetch;
      app.showToast = origToast;
      return {
        mapName: app.sessions.get('rename-500')?.name ?? null,
        label: document.querySelector('.tab-name[data-session-id="rename-500"]')?.textContent ?? null,
        renameClassActive:
          document.querySelector('.tab-name[data-session-id="rename-500"]')?.classList.contains('tab-name-renaming') ??
          false,
        toasts,
      };
    });

    expect(result.mapName).toBe('w9-case');
    expect(result.label).toBe('w9-case');
    expect(result.renameClassActive).toBe(false);
    expect(result.toasts).toContain('Failed to rename');
  });

  it('Re-entry: starting rename while one is active aborts the previous one', async () => {
    await resetState();
    expect(await startRename('first-id', 'First')).toBe(true);

    const result = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { sessionId: string } | null;
            sessions: Map<string, { id: string; name: string }>;
            renderSessionTabs: () => void;
            startInlineRename: (id: string) => void;
          };
        }
      ).app;
      const firstActive = app._activeRename?.sessionId;
      // Start a second rename without cancelling — startInlineRename should
      // pre-emptively cancel the previous one so state never gets stuck on the dead session.
      app.sessions.set('second-id', { id: 'second-id', name: 'Second' });
      const wrap = document.createElement('div');
      wrap.setAttribute('data-test-tab', '1');
      const tabName = document.createElement('span');
      tabName.className = 'tab-name';
      tabName.setAttribute('data-session-id', 'second-id');
      tabName.textContent = 'Second';
      wrap.appendChild(tabName);
      document.body.appendChild(wrap);

      // Cancelling the first rename is allowed to repaint the tab list. Model
      // that synchronously so a target captured before cancel() becomes stale.
      const originalRenderSessionTabs = app.renderSessionTabs;
      app.renderSessionTabs = () => {
        const current = document.querySelector('.tab-name[data-session-id="second-id"]');
        current?.replaceWith(current.cloneNode(true));
      };
      app.startInlineRename('second-id');
      app.renderSessionTabs = originalRenderSessionTabs;
      return {
        firstActive,
        secondActive: app._activeRename?.sessionId,
        secondInputVisible: !!document.querySelector('.tab-name[data-session-id="second-id"] input.tab-rename-input'),
        firstRenameClassActive:
          document.querySelector('.tab-name[data-session-id="first-id"]')?.classList.contains('tab-name-renaming') ??
          false,
      };
    });

    expect(result.firstActive).toBe('first-id');
    expect(result.secondActive).toBe('second-id');
    expect(result.secondInputVisible).toBe(true);
    expect(result.firstRenameClassActive).toBe(false);
  });

  it('Session sidebar paints typing without ellipsizing the live editor', async () => {
    await resetState();
    const id = 'sidebar-live-input';

    await page.evaluate((sessionId) => {
      const app = (
        window as unknown as {
          app: {
            sessions: Map<string, { id: string; name: string }>;
            startInlineRename: (id: string) => void;
          };
        }
      ).app;
      document.documentElement.dataset.sessionList = 'sidebar';
      document.documentElement.dataset.sidebar = 'expanded';
      const list = document.getElementById('sessionSidebarList') as HTMLElement;
      const tab = document.createElement('div');
      tab.setAttribute('data-test-tab', '1');
      tab.className = 'session-tab';
      tab.innerHTML =
        '<span class="tab-info"><span class="tab-name-row">' +
        `<span class="tab-name" data-session-id="${sessionId}">old title</span>` +
        '</span></span>';
      list.appendChild(tab);
      app.sessions.set(sessionId, { id: sessionId, name: 'old title' });
      app.startInlineRename(sessionId);
    }, id);

    const label = page.locator(`.tab-name[data-session-id="${id}"]`);
    const input = label.locator('input.tab-rename-input');
    await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type('edited title');

    expect(await input.inputValue()).toBe('edited title');
    expect(await input.evaluate((node) => document.activeElement === node)).toBe(true);
    expect(await label.evaluate((node) => node.classList.contains('tab-name-renaming'))).toBe(true);
    expect(await label.evaluate((node) => getComputedStyle(node).overflow)).toBe('visible');
    expect(await input.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(0);
  });

  // The rail has two row variants, and the detailed one clamps the name to
  // three lines instead of two: the editor must come out unclamped in both,
  // and cancelling must put back the clamp of the variant it was opened in.
  it.each([
    { detail: 'simple', restoredClamp: '2' },
    { detail: 'rich', restoredClamp: '3' },
  ])(
    'Vertical rail ($detail rows) paints typing in an unclamped editor and restores the clamp on cancel',
    async ({ detail, restoredClamp }) => {
      await resetState();
      const id = `vertical-live-input-${detail}`;

      await page.evaluate(
        ({ sessionId, detail }) => {
          const app = (
            window as unknown as {
              app: {
                sessions: Map<string, { id: string; name: string }>;
                startInlineRename: (id: string) => void;
              };
            }
          ).app;
          document.documentElement.dataset.tabOrientation = 'vertical';
          document.documentElement.dataset.tabRailDetail = detail;
          const rail = document.getElementById('tabRail') as HTMLElement;
          const tab = document.createElement('div');
          tab.setAttribute('data-test-tab', '1');
          tab.className = 'session-tab';
          tab.innerHTML =
            `<span class="tab-name" data-session-id="${sessionId}">` +
            '<span class="tab-name-prefix">w9-case: </span>old</span>';
          rail.appendChild(tab);
          app.sessions.set(sessionId, { id: sessionId, name: 'w9-case: old' });
          app.startInlineRename(sessionId);
        },
        { sessionId: id, detail }
      );

      const label = page.locator(`.tab-name[data-session-id="${id}"]`);
      const input = label.locator('input.tab-rename-input');
      await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.type('edited title');

      expect(await input.inputValue()).toBe('edited title');
      expect(await input.evaluate((node) => document.activeElement === node)).toBe(true);
      expect(await label.evaluate((node) => node.classList.contains('tab-name-renaming'))).toBe(true);
      expect(await label.evaluate((node) => getComputedStyle(node).webkitLineClamp)).toBe('none');
      expect(await input.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(0);

      const settled = await page.evaluate((sessionId) => {
        const app = (window as unknown as { app: { _activeRename: { cancel: () => void } | null } }).app;
        app._activeRename?.cancel();
        const label = document.querySelector(`.tab-name[data-session-id="${sessionId}"]`) as HTMLElement;
        const result = {
          classActive: label.classList.contains('tab-name-renaming'),
          inputPresent: !!label.querySelector('input.tab-rename-input'),
          webkitLineClamp: getComputedStyle(label).webkitLineClamp,
        };
        document.documentElement.dataset.tabOrientation = 'horizontal';
        return result;
      }, id);

      expect(settled).toEqual({ classActive: false, inputPresent: false, webkitLineClamp: restoredClamp });
    }
  );
});

/**
 * Two renames of one session can be in flight at once: commit, reopen the
 * editor before the PUT answers, then commit or cancel again (or start a group
 * rename, which cancels the session editor). The writes go out one at a time
 * in the order they were made, and a confirmed write is applied locally even
 * if the editor that made it has since been cancelled, so the tab never shows
 * a name the server no longer holds.
 */
describe('Inline rename write ordering', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  type Pending = { body: string; resolve: (response: Response) => void };

  beforeAll(async () => {
    server = new WebServer(ORDERING_PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(`http://localhost:${ORDERING_PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        typeof (window as { app?: unknown }).app !== 'undefined' &&
        !!(window as { app?: { sessions?: Map<string, unknown> } }).app?.sessions
    );
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  /** Mount a header-strip row for `id`, hold every PUT open, and open its editor. */
  async function mount(id: string, name: string): Promise<void> {
    await page.evaluate(
      ({ id, name }) => {
        const w = window as unknown as {
          app: {
            _activeRename: { cancel: () => void } | null;
            sessions: Map<string, { id: string; name: string; status: string }>;
            sessionOrder: string[];
          };
          __pending: Array<{ body: string; resolve: (response: Response) => void }>;
          __origFetch?: typeof window.fetch;
        };
        w.app._activeRename?.cancel();
        w.app.sessions.clear();
        document.querySelectorAll('[data-test-tab]').forEach((n) => n.remove());
        w.app.sessions.set(id, { id, name, status: 'idle' });
        w.app.sessionOrder = [id];
        const tab = document.createElement('div');
        tab.setAttribute('data-test-tab', '1');
        tab.className = 'session-tab';
        tab.dataset.id = id;
        tab.innerHTML = `<span class="tab-info"><span class="tab-name" data-session-id="${id}">${name}</span></span>`;
        (document.getElementById('sessionTabs') as HTMLElement).appendChild(tab);
        w.__pending = [];
        w.__origFetch ??= window.fetch;
        const passThrough = w.__origFetch;
        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method !== 'PUT' || !String(input).endsWith('/name')) return passThrough(input, init);
          return new Promise<Response>((resolve) => {
            w.__pending.push({ body: String(init?.body ?? ''), resolve });
          });
        }) as typeof window.fetch;
      },
      { id, name }
    );
  }

  async function restoreFetch(): Promise<void> {
    await page.evaluate(() => {
      const w = window as unknown as { __origFetch?: typeof window.fetch };
      if (w.__origFetch) window.fetch = w.__origFetch;
    });
  }

  async function commit(id: string, value: string | null): Promise<void> {
    await page.evaluate(
      async ({ id, value }) => {
        const app = (window as unknown as { app: { startInlineRename: (id: string) => void } }).app;
        if (!document.querySelector(`.tab-name[data-session-id="${id}"] input.tab-rename-input`)) {
          app.startInlineRename(id);
        }
        const input = document.querySelector(
          `.tab-name[data-session-id="${id}"] input.tab-rename-input`
        ) as HTMLInputElement;
        if (value !== null) input.value = value;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      { id, value }
    );
  }

  async function answer(index: number, name: string): Promise<void> {
    await page.evaluate(
      async ({ index, body }) => {
        const w = window as unknown as { __pending: Pending[] };
        w.__pending[index]?.resolve(
          new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
      { index, body: JSON.stringify({ success: true, data: { name } }) }
    );
  }

  async function state(id: string) {
    return page.evaluate((id) => {
      const w = window as unknown as {
        app: { sessions: Map<string, { name: string }>; _activeRename: unknown };
        __pending: Pending[];
      };
      return {
        bodies: w.__pending.map(({ body }) => JSON.parse(body).name),
        mapName: w.app.sessions.get(id)?.name ?? null,
        renameActive: !!w.app._activeRename,
      };
    }, id);
  }

  it('sends successive renames of one session one at a time, in the order they were made', async () => {
    await mount('order', 'Old');
    await commit('order', 'First');
    await commit('order', 'Second');
    expect((await state('order')).bodies).toEqual(['First']);

    await answer(0, 'First');
    expect((await state('order')).bodies).toEqual(['First', 'Second']);
    await answer(1, 'Second');
    await restoreFetch();
    expect(await state('order')).toEqual({ bodies: ['First', 'Second'], mapName: 'Second', renameActive: false });
  });

  it('keeps a confirmed rename when the editor reopened over it is cancelled', async () => {
    await mount('reopen', 'Old');
    await commit('reopen', 'First');
    await page.evaluate(() => {
      const app = (
        window as unknown as { app: { startInlineRename: (id: string) => void; _activeRename: { cancel: () => void } } }
      ).app;
      app.startInlineRename('reopen');
      app._activeRename.cancel();
    });
    await answer(0, 'First');
    await restoreFetch();
    expect(await state('reopen')).toEqual({ bodies: ['First'], mapName: 'First', renameActive: false });
  });

  it('re-sends the shown name when it is confirmed unchanged over a rename still in flight', async () => {
    await mount('stale', 'Old');
    await commit('stale', 'First');
    // The reopened editor still shows "Old" (the PUT has not answered), and
    // Enter confirms that: the user's last word is "Old", not "First".
    await commit('stale', null);
    await answer(0, 'First');
    await answer(1, 'Old');
    await restoreFetch();
    expect(await state('stale')).toEqual({ bodies: ['First', 'Old'], mapName: 'Old', renameActive: false });
  });

  it('keeps a confirmed session rename when a group rename takes over the editor', async () => {
    await mount('to-group', 'Old');
    await commit('to-group', 'Saved');
    const groupStarted = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            tabLayout: unknown;
            startTabGroupRename: (groupId: string) => boolean;
          };
        }
      ).app;
      const section = document.createElement('section');
      section.setAttribute('data-test-tab', '1');
      section.innerHTML =
        '<div class="tab-layout-group-header" data-tab-group-header="g1">' +
        '<span class="tab-layout-group-name">Group</span></div>';
      (document.getElementById('sessionTabs') as HTMLElement).appendChild(section);
      (window as unknown as { __origLayout: unknown }).__origLayout = app.tabLayout;
      app.tabLayout = { version: 1, groups: [{ id: 'g1', name: 'Group', refs: [] }], ungrouped: [] };
      return app.startTabGroupRename('g1');
    });
    expect(groupStarted).toBe(true);

    await answer(0, 'Saved');
    const after = await page.evaluate(() => {
      const w = window as unknown as {
        app: {
          sessions: Map<string, { name: string }>;
          _inlineRenameActive: boolean;
          _activeRename: { cancel: () => void } | null;
          tabLayout: unknown;
        };
        __origLayout: unknown;
      };
      const groupInput = document.querySelector('.tab-layout-group-rename-input');
      const result = {
        mapName: w.app.sessions.get('to-group')?.name ?? null,
        groupEditorOpen: !!groupInput?.isConnected,
        guardHeld: w.app._inlineRenameActive,
      };
      w.app._activeRename?.cancel();
      w.app.tabLayout = w.__origLayout;
      return result;
    });
    await restoreFetch();
    expect(after).toEqual({ mapName: 'Saved', groupEditorOpen: true, guardHeld: true });
  });
});

/**
 * Real rows, rendered by the app from a live session: a long `w<n>-<case>`
 * prefix must not push the editor (or the prefix itself) out of the row in any
 * rail variant. The prefix gives way first, with an ellipsis, and the input
 * always keeps a usable width.
 */
describe('Vertical rail rename editor with a long prefix', () => {
  let server: WebServer;
  let browser: Browser;
  const port = LONG_PREFIX_PORT;
  const NAME = 'w3-this_is_a_very_long_valid_prefix: charlie';
  let sessionId = '';

  beforeAll(async () => {
    server = new WebServer(port, false, true);
    await server.start();
    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NAME, mode: 'shell' }),
    });
    expect(res.ok).toBe(true);
    const created = (await res.json()) as { data?: { id?: string; session?: { id?: string } } };
    sessionId = created.data?.session?.id ?? created.data?.id ?? '';
    expect(sessionId).not.toBe('');
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  it.each([
    { variant: 'simple rows', settings: { tabOrientation: 'vertical', tabRailDetail: 'simple' }, compact: false },
    { variant: 'detailed rows', settings: { tabOrientation: 'vertical', tabRailDetail: 'rich' }, compact: false },
    { variant: 'compact rail', settings: { tabOrientation: 'vertical', tabRailWidth: 208 }, compact: true },
  ])('keeps the prefix and a usable input inside the row ($variant)', async ({ settings, compact }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    try {
      await context.addInitScript(
        (value) => localStorage.setItem('codeman-app-settings', JSON.stringify(value)),
        settings
      );
      const page = await context.newPage();
      await page.goto(`http://localhost:${port}`, { waitUntil: 'domcontentloaded' });
      const row = page.locator(`#tabRail .session-tab[data-id="${sessionId}"]`);
      await row.waitFor({ state: 'visible', timeout: 15000 });
      expect(await page.evaluate(() => document.documentElement.classList.contains('tab-rail-compact'))).toBe(compact);

      await row.click({ button: 'right' });
      const input = row.locator('input.tab-rename-input');
      await input.press('Control+A');
      await page.keyboard.type('typed live text');
      expect(await input.inputValue()).toBe('typed live text');

      const geometry = await row.evaluate((tab) => {
        const box = (el: Element) => el.getBoundingClientRect();
        const within = (inner: DOMRect, outer: DOMRect) =>
          inner.left >= outer.left - 0.5 &&
          inner.right <= outer.right + 0.5 &&
          inner.top >= outer.top - 0.5 &&
          inner.bottom <= outer.bottom + 0.5;
        const input = tab.querySelector('input.tab-rename-input') as HTMLInputElement;
        const prefix = tab.querySelector('.tab-rename-prefix') as HTMLElement;
        const info = tab.querySelector('.tab-info') as HTMLElement;
        return {
          focused: document.activeElement === input,
          inputWidth: box(input).width,
          prefixWidth: box(prefix).width,
          inputInsideRow: within(box(input), box(info)),
          prefixInsideRow: within(box(prefix), box(info)),
          prefixEllipsis: getComputedStyle(prefix).textOverflow,
        };
      });
      expect(geometry.focused).toBe(true);
      expect(geometry.inputWidth).toBeGreaterThanOrEqual(64);
      expect(geometry.prefixWidth).toBeGreaterThanOrEqual(24);
      expect(geometry.inputInsideRow).toBe(true);
      expect(geometry.prefixInsideRow).toBe(true);
      expect(geometry.prefixEllipsis).toBe('ellipsis');

      await input.press('Escape');
      expect(await row.locator('input.tab-rename-input').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
