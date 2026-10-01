/**
 * @fileoverview The home screen's foreign-session block: the wide scan is
 * one-shot, and an adoption failure says what the server said.
 *
 * Containers and ssh hosts cost a `docker exec` or a full ssh handshake each,
 * with a ~12s timeout. Riding them along on the 8s poll stacked connections on
 * a slow host, so the wide scan now runs only when the user asks. That makes a
 * second property load-bearing: the periodic poll's payload cannot contain
 * those rows, so they are kept apart and merged — assert only "the request was
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
function loadApp() {
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
    document: {
      createElement: () => stubEl(),
      getElementById: (id: string) => (id === 'foreignSessions' ? host : null),
      addEventListener() {},
    },
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
  };
}

const LOCAL = { id: 'L1', location: 'local', sessionName: 'work', mode: 'claude' };
const DOCKER = { id: 'D1', location: 'docker', sessionName: 'inbox', mode: 'codex' };

describe('the wide scan is one-shot', () => {
  function wired() {
    const app = loadApp();
    const calls: string[] = [];
    app._apiJson = vi.fn(async (path: string) => {
      calls.push(path);
      return path.includes('docker=1')
        ? { sessions: [LOCAL, DOCKER], notes: [], canScanWide: true }
        : { sessions: [LOCAL], notes: [], canScanWide: true };
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
    // usable — a local-only payload has no container rows in it.
    const { app, calls } = wired();
    app.toggleForeignScanRemote();
    await vi.waitFor(() => expect(app._allForeignRows()).toHaveLength(2));
    await app.loadForeignSessions(); // the interval's call shape
    expect(calls[1]).toBe('/api/mux/foreign');
    expect(app._allForeignRows().map((r) => r.id)).toEqual(['L1', 'D1']);
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

describe('an adoption failure reports what the server said', () => {
  function adoptHarness(status: number, body: unknown) {
    const app = loadApp();
    const toasts: string[] = [];
    app.showToast = (msg: string) => void toasts.push(msg);
    app._api = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
    app._apiJson = vi.fn(async () => ({ sessions: [], notes: [], canScanWide: false }));
    app._onSessionCreated = vi.fn();
    app.selectSession = vi.fn(async () => {});
    return { app, toasts };
  }

  it('shows "could not reach it" verbatim instead of "that session is gone"', async () => {
    // The server deliberately tells two different stories. `_apiJson` folds a
    // non-2xx to null, which collapsed both into one message and reported a
    // live remote session as deleted every time the link flickered.
    const msg = 'Could not reach it just now (ssh box: timeout). It may still be running — try again.';
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
    app._apiJson = vi.fn(async () => ({ sessions: [], notes: [], canScanWide: false }));
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
