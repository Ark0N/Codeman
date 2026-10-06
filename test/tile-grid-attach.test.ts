/**
 * @fileoverview A tile whose session is not attached shows an Attach overlay.
 *
 * Three ways a tile has no live terminal: the session has no PTY attached
 * (`pid === null`, e.g. restored after a server restart), the agent exited in a
 * live pane (`paneExit`), or the server closed the tile's socket because the
 * session exited (close code 4009). The tile body then shows why, with an
 * Attach button, over the terminal (never resizing it).
 *
 * Attach is exactly the single view's automatic re-attach: `POST /interactive`
 * (or `/shell` for a shell) with NO body, at most one in flight per session
 * (the route has no in-flight guard of its own). A tripped PTY-exit breaker
 * (`respawnBlocked`) goes through the same confirm before `clearBreaker: true`,
 * and nothing automatic ever sends that. On success the tile is remounted onto
 * the new pane (a socket stopped for good cannot reconnect).
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  fetchSpy,
  makeGridApp,
  resetGridHarness,
  section,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];
const tileEl = (id: string) => section.children.find((el) => el.dataset.sessionId === id) as FakeEl;
const overlayOf = (id: string) => tileEl(id).children[1].children.find((c) => c.className === 'tile-attach') ?? null;
const visible = (id: string) => !!overlayOf(id) && !overlayOf(id)!.hidden;
const textOf = (id: string) => overlayOf(id)!.children[0].textContent;
const attachButton = (id: string) => overlayOf(id)!.children[1];
const tilesFor = (id: string) => FakeTile.all.filter((t) => t.sessionId === id);

function gridWith(setup: (app: GridApp) => void = () => {}): GridApp {
  const app = makeGridApp(IDS);
  setup(app);
  app.openTileGrid(IDS);
  return app;
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  resetGridHarness();
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async () => ({ ok: true, json: async () => ({}) }));
  windowStub.confirm = vi.fn(() => true);
});

describe('when the overlay shows', () => {
  it('a session with no PTY attached', () => {
    gridWith((app) => (app.sessions.get('s-b').pid = null));
    expect(visible('s-b')).toBe(true);
    expect(textOf('s-b')).toBe('Not attached');
    expect(attachButton('s-b').textContent).toBe('Attach');
    expect(visible('s-a')).toBe(false);
  });

  it('an agent that exited in a live pane', () => {
    gridWith((app) => (app.sessions.get('s-c').paneExit = { status: 2 }));
    expect(visible('s-c')).toBe(true);
    expect(textOf('s-c')).toBe('The agent exited (2)');
  });

  it('a socket closed because the session exited (4009) keeps the tile and shows it', () => {
    const app = gridWith();
    const tile = tilesFor('s-b')[0];
    tile._stoppedCode = 4009;
    tile.onExit?.(4009);
    expect(app._tileGrid.ids).toContain('s-b');
    expect(visible('s-b')).toBe(true);
    expect(textOf('s-b')).toBe('The session ended');
  });

  it('a live session shows none, and the overlay leaves once the session is back', () => {
    const app = gridWith((a) => (a.sessions.get('s-b').pid = null));
    app.sessions.get('s-b').pid = 4242;
    app._renderTileChrome();
    expect(visible('s-b')).toBe(false);
  });

  it('sits over the body, never inside the header (the body keeps its size)', () => {
    gridWith((app) => (app.sessions.get('s-b').pid = null));
    expect(tileEl('s-b').children[1].className).toBe('tile-body');
    expect(overlayOf('s-b')?.parentElement).toBe(tileEl('s-b').children[1]);
  });
});

describe('Attach', () => {
  it('POSTs /interactive with NO body, then remounts the tile onto the new pane', async () => {
    const app = gridWith((a) => (a.sessions.get('s-b').pid = null));
    const before = tilesFor('s-b')[0];
    attachButton('s-b').dispatch('click', { stopPropagation: vi.fn() });
    await settle();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/sessions/s-b/interactive', { method: 'POST' });
    expect(before.destroy).toHaveBeenCalledTimes(1);
    const after = tilesFor('s-b')[1];
    expect(after.connect).toHaveBeenCalledTimes(1);
    expect(app._tileFor('s-b')).toBe(after);
    // The server has not reported the new pid yet: no overlay meanwhile.
    expect(visible('s-b')).toBe(false);
  });

  it('a shell session attaches through /shell', async () => {
    const app = makeGridApp(IDS);
    app.sessions.get('s-c').mode = 'shell';
    app.sessions.get('s-c').pid = null;
    app.openTileGrid(IDS);
    await app.attachTileSession('s-c');
    expect(fetchSpy).toHaveBeenCalledWith('/api/sessions/s-c/shell', { method: 'POST' });
  });

  it('at most one attach in flight per session', async () => {
    const app = gridWith((a) => (a.sessions.get('s-b').pid = null));
    let release: (v: unknown) => void = () => {};
    fetchSpy.mockImplementation(() => new Promise((r) => (release = r)));
    const first = app.attachTileSession('s-b');
    attachButton('s-b').dispatch('click', { stopPropagation: vi.fn() });
    void app.attachTileSession('s-b');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(textOf('s-b')).toBe('Attaching…');
    expect(attachButton('s-b').disabled).toBe(true);
    release({ ok: true });
    await first;
  });

  it('a failed attach keeps the overlay and says so', async () => {
    const app = gridWith((a) => (a.sessions.get('s-b').pid = null));
    fetchSpy.mockImplementation(async () => ({ ok: false, json: async () => ({}) }));
    expect(await app.attachTileSession('s-b')).toBe(false);
    expect(app.showToast).toHaveBeenCalledWith('Could not attach the session', 'error');
    expect(visible('s-b')).toBe(true);
    expect(textOf('s-b')).toBe('Not attached');
    expect(tilesFor('s-b')).toHaveLength(1);
  });
});

describe('the PTY-exit breaker', () => {
  function tripped() {
    return gridWith((a) => {
      a.sessions.get('s-b').pid = null;
      a.sessions.get('s-b').respawnBlocked = true;
    });
  }

  it('asks first, and only a yes sends clearBreaker', async () => {
    const app = tripped();
    await app.attachTileSession('s-b');
    expect(windowStub.confirm).toHaveBeenCalledWith('s-b was stopped after crashing repeatedly. Restart it?');
    expect(fetchSpy).toHaveBeenCalledWith('/api/sessions/s-b/interactive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearBreaker: true }),
    });
    expect(app.sessions.get('s-b').respawnBlocked).toBe(false);
  });

  it('a no sends nothing at all', async () => {
    const app = tripped();
    windowStub.confirm = vi.fn(() => false);
    await app.attachTileSession('s-b');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(visible('s-b')).toBe(true);
  });

  it('nothing automatic attaches: opening the grid and refreshing headers POST nothing', () => {
    const app = tripped();
    app._renderTileChrome();
    app._reconcileTileGrid();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(windowStub.confirm).not.toHaveBeenCalled();
  });
});
