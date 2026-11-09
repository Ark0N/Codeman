/**
 * @fileoverview The home screen's foreign-session block: the wide scan is
 * one-shot, and an adoption failure says what the server said.
 *
 * Containers and ssh hosts cost a `docker exec` or a full ssh handshake each,
 * with a ~12s timeout. Riding them along on the 8s poll stacked connections on
 * a slow host, so the wide scan now runs only when the user asks. That makes a
 * second property load-bearing: the periodic poll's payload cannot contain
 * those rows, so they are kept apart and merged: assert only "the request was
 * right" and the real failure (the next tick wiping the container rows off the
 * list) sails through.
 *
 * Port: none.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = readFileSync(fileURLToPath(new URL('../src/web/public/foreign-sessions.js', import.meta.url)), 'utf8');

function stubEl(): Record<string, unknown> {
  const el: Record<string, unknown> = {
    children: [] as unknown[],
    dataset: {},
    disabled: false,
    textContent: '',
    title: '',
    type: '',
    className: '',
    hidden: false,
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c: unknown) {
      (el.children as unknown[]).push(c);
      return c;
    },
    setAttribute() {},
  };
  Object.defineProperty(el, 'innerHTML', { get: () => '', set: () => void (el.children = []) });
  return el;
}

/** The module is a classic script that mixes into CodemanApp.prototype. */
function loadApp(window: Record<string, unknown> = {}, page: Record<string, unknown> = {}) {
  const host = stubEl();
  const ctx: Record<string, unknown> = {
    console,
    Date,
    Number,
    Array,
    Object,
    JSON,
    Math,
    String,
    setInterval: () => 1,
    clearInterval() {},
    codemanT: null,
    window,
    document: Object.assign(page, {
      createElement: () => stubEl(),
      getElementById: (id: string) => (id === 'foreignSessions' ? host : null),
      addEventListener() {},
      removeEventListener() {},
      ...page,
    }),
    CodemanApp: function () {} as unknown,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const Ctor = ctx.CodemanApp as { prototype: object };
  return Object.create(Ctor.prototype) as Record<string, unknown> & {
    toggleForeignScanRemote(): void;
    rescanForeignWide(): void;
    loadForeignSessions(o?: { wide?: boolean }): Promise<void>;
    adoptForeignSession(id: string, el?: unknown): Promise<void>;
    _allForeignRows(): Array<{ id: string }>;
    renderAllForeignSessions(): void;
    startForeignPolling(): void;
    stopForeignPolling(): void;
    _foreignPollTick(): void;
    renderForeignSessions(el: unknown): void;
    _foreignRow(row: object): { children: Array<{ children: Array<{ textContent: string }> }> };
  };
}

/** A response as `_api` hands it over, the server's envelope included. */
function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}

const LOCAL = { id: 'L1', location: 'local', sessionName: 'work', mode: 'claude' };
const DOCKER = { id: 'D1', location: 'docker', sessionName: 'inbox', mode: 'codex' };

describe('the wide scan is one-shot', () => {
  function wired() {
    const app = loadApp();
    const calls: string[] = [];
    app._api = vi.fn(async (path: string) => {
      calls.push(path);
      return ok(
        path.includes('docker=1')
          ? {
              sessions: [LOCAL, DOCKER],
              notes: ['docker box: not running, no tmux, or engine unreachable'],
              canScanWide: true,
            }
          : { sessions: [LOCAL], notes: ['local: 1 session(s) skipped'], canScanWide: true }
      );
    });
    return { app, calls };
  }

  it('fetches containers and hosts once when the toggle goes on', async () => {
    const { app, calls } = wired();
    app.toggleForeignScanRemote();
    // Wait on the STATE, not on the call count: the stub pushes its path before
    // it resolves, so a call-count wait returns while the rows are still unset.
    await vi.waitFor(() => expect(app._allForeignRows()).toHaveLength(2));
    expect(calls[0]).toContain('docker=1');
    expect(calls[0]).toContain('remote=1');
    expect(app._allForeignRows().map((r) => r.id)).toEqual(['L1', 'D1']);
  });

  it('keeps the periodic poll local-only, and the container row survives it', async () => {
    // Both halves matter. The first is the cost fix; the second is what makes it
    // usable: a local-only payload has no container rows in it.
    const { app, calls } = wired();
    app.toggleForeignScanRemote();
    await vi.waitFor(() => expect(app._allForeignRows()).toHaveLength(2));
    await app.loadForeignSessions(); // the interval's call shape
    expect(calls[1]).toBe('/api/mux/foreign');
    expect(app._allForeignRows().map((r) => r.id)).toEqual(['L1', 'D1']);
  });

  it('keeps a container or host note across the local polls, and refreshes the local ones', async () => {
    // Only a wide scan can re-read a container's note, so a local poll wiping it
    // left "unreachable" gone while its stale rows stayed on the list.
    const { app } = wired();
    app.toggleForeignScanRemote();
    await vi.waitFor(() => expect(app._allForeignRows()).toHaveLength(2));
    await app.loadForeignSessions();
    expect(app._foreignWideNotes).toEqual(['docker box: not running, no tmux, or engine unreachable']);
    expect(app._foreignNotes).toEqual(['local: 1 session(s) skipped']);
  });

  it('discards the wide rows when the toggle goes off', async () => {
    // Nothing re-confirms them, so leaving them up would show a container
    // session that may be long gone.
    const { app, calls } = wired();
    app.toggleForeignScanRemote();
    await vi.waitFor(() => expect(app._allForeignRows()).toHaveLength(2));
    app.toggleForeignScanRemote();
    expect(app._allForeignRows().map((r) => r.id)).toEqual(['L1']);
  });

  it('Rescan re-runs the wide scan, and does nothing while the toggle is off', async () => {
    const { app, calls } = wired();
    app.rescanForeignWide();
    expect(calls).toHaveLength(0);
    app.toggleForeignScanRemote();
    await vi.waitFor(() => expect(app._allForeignRows()).toHaveLength(2));
    app.rescanForeignWide();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toContain('docker=1');
  });
});

describe('a hidden tab does not sweep tmux sockets', () => {
  // One scan forks once per socket and pane, and a tab left on the home screen in the
  // background has nobody reading the list: 772 forks a tick was measured on a real box.
  function harness(hidden: boolean) {
    const listeners = new Set<() => void>();
    const page: Record<string, unknown> = {
      hidden,
      addEventListener(type: string, listener: () => void) {
        if (type === 'visibilitychange') listeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        if (type === 'visibilitychange') listeners.delete(listener);
      },
    };
    const app = loadApp({}, page);
    const calls: string[] = [];
    app._api = vi.fn(async (path: string) => {
      calls.push(path);
      return ok({ sessions: [LOCAL], notes: [], canScanWide: false });
    });
    return { app, calls, page, listeners };
  }

  it('makes no first load for a home screen that opened in the background', () => {
    const { app, calls } = harness(true);
    app.startForeignPolling();
    expect(calls).toHaveLength(0);
  });

  it('skips the tick while hidden and runs it again once visible', () => {
    const { app, calls, page } = harness(false);
    app.startForeignPolling();
    expect(calls).toHaveLength(1);

    page.hidden = true;
    app._foreignPollTick();
    expect(calls).toHaveLength(1);

    page.hidden = false;
    app._foreignPollTick();
    expect(calls).toHaveLength(2);
  });

  it('catches up the moment the tab comes back, without waiting out the interval', () => {
    const { app, calls, page, listeners } = harness(true);
    app.startForeignPolling();
    expect(listeners.size).toBe(1);

    page.hidden = false;
    for (const listener of listeners) listener();

    expect(calls).toEqual(['/api/mux/foreign']);
  });

  it('does not scan on the visibility event that hides the tab', () => {
    const { app, calls, page, listeners } = harness(false);
    app.startForeignPolling();
    expect(listeners.size).toBe(1);

    page.hidden = true;
    for (const listener of listeners) listener();

    expect(calls).toHaveLength(1);
  });

  it('holds one listener over repeated home screens and none after leaving', () => {
    // showWelcome/hideWelcome run this on every trip, unlike a poller created once.
    const { app, listeners } = harness(false);
    for (let trip = 0; trip < 3; trip++) {
      app.startForeignPolling();
      app.startForeignPolling();
      expect(listeners.size).toBe(1);
      app.stopForeignPolling();
      expect(listeners.size).toBe(0);
    }
  });
});

describe('an adoption failure reports what the server said', () => {
  function adoptHarness(status: number, body: unknown) {
    const app = loadApp();
    const toasts: string[] = [];
    app.showToast = (msg: string) => void toasts.push(msg);
    app._api = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
    app._onSessionCreated = vi.fn();
    app.selectSession = vi.fn(async () => {});
    return { app, toasts };
  }

  it('shows "could not reach it" verbatim instead of "that session is gone"', async () => {
    // The server deliberately tells two different stories. `_apiJson` folds a
    // non-2xx to null, which collapsed both into one message and reported a
    // live remote session as deleted every time the link flickered.
    const msg = 'Could not reach it just now (ssh box: timeout). It may still be running, try again.';
    const { app, toasts } = adoptHarness(404, { success: false, error: msg, errorCode: 'NOT_FOUND' });
    await app.adoptForeignSession('cand-1');
    expect(toasts[0]).toBe(msg);
  });

  it('still shows the gone message when that is what the server said', async () => {
    const msg = 'That tmux session is no longer there. Refresh the list and try again.';
    const { app, toasts } = adoptHarness(404, { success: false, error: msg, errorCode: 'NOT_FOUND' });
    await app.adoptForeignSession('cand-1');
    expect(toasts[0]).toBe(msg);
  });

  it('falls back to its own wording when the server sent no readable body', async () => {
    const app = loadApp();
    const toasts: string[] = [];
    app.showToast = (msg: string) => void toasts.push(msg);
    app._api = vi.fn(async () => null); // network failure
    await app.adoptForeignSession('cand-1');
    expect(toasts[0]).toMatch(/Could not open that session/);
  });

  it('goes through the app’s normal create path on success', async () => {
    const session = { id: 'new-1' };
    const { app } = adoptHarness(200, { success: true, data: { session } });
    await app.adoptForeignSession('cand-1');
    expect(app._onSessionCreated).toHaveBeenCalledWith(session);
    expect(app.selectSession).toHaveBeenCalledWith('new-1');
  });
});

describe('a non-admin in multi-user mode', () => {
  // The list is admin-only, so every poll answers 403. That used to read as a failed
  // poll: a "Could not reach the server" block, and a request every eight seconds.
  it('stops asking and shows no block at all', async () => {
    const app = loadApp();
    const calls: string[] = [];
    app._api = vi.fn(async (path: string) => {
      calls.push(path);
      return { ok: false, status: 403, json: async () => ({ success: false, errorCode: 'FORBIDDEN' }) };
    });
    await app.loadForeignSessions();
    const box = stubEl();
    app.renderForeignSessions(box);
    expect(box.hidden).toBe(true);
    expect(box.children).toEqual([]);
    await app.loadForeignSessions();
    app.startForeignPolling();
    expect(calls).toHaveLength(1);
  });

  it('still reads any other failure as a failed poll', async () => {
    const app = loadApp();
    app._api = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ success: false }) }));
    await app.loadForeignSessions();
    expect(app._foreignError).toBe(true);
    expect(app._foreignRefused).toBeFalsy();
  });
});

describe('a row names its CLI in the registry\u2019s own word', () => {
  it('has no list of CLI ids to fall behind: omp and copilot read like the rest', () => {
    const app = loadApp({ __codemanCliCatalog: [{ id: 'copilot', label: 'GitHub Copilot' }] });
    const sub = (mode: string) =>
      app._foreignRow({ sessionName: 'x', mode, location: 'local' }).children[1].children[1].textContent;
    expect(sub('copilot')).toBe('GitHub Copilot \u00b7 this machine');
    // Absent from the catalog: the id itself, never a blank row.
    expect(sub('newcli')).toBe('newcli \u00b7 this machine');
  });
});
