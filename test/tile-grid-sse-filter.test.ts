/**
 * @fileoverview While the tile grid owns the terminal, the page's SSE filter
 * names TILE_GRID_SSE_FILTER (constants.js), which no session matches.
 *
 * The SSE filter gates only session:terminal batches (server side, pinned by
 * test/sse-tile-grid-filter.test.ts). With the grid open those frames were for
 * the focused tile alone and were only parsed to be dropped: the main terminal
 * is parked and the tiles carry their own output over their own sockets. Both
 * places that set the filter ask `_sseFilterSessionId()`: the live re-subscribe
 * (`_updateSseSubscription`, run by every tile focus) and the connect URL
 * (`connectSSE`, rebuilt by every SSE reconnect with the grid still open).
 * Leaving the grid gives the filter back to the session shown.
 *
 * Real code: the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fetchSpy, makeGridApp, resetGridHarness, windowStub, type GridApp } from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];
const FILTER = (windowStub.CodemanTileGrid as { TILE_GRID_SSE_FILTER: string }).TILE_GRID_SSE_FILTER;

/** The app with the REAL _updateSseSubscription, and the filters it posted, in order. */
function makeApp(): GridApp {
  const app = makeGridApp(IDS);
  delete app._updateSseSubscription;
  app._clientId = 'client-1';
  return app;
}
const posted = () =>
  fetchSpy.mock.calls
    .filter(([url]) => url === '/api/events/subscribe')
    .map(([, init]) => JSON.parse((init as { body: string }).body).sessions);

beforeEach(() => {
  resetGridHarness();
  fetchSpy.mockClear();
});

describe('the SSE filter while tiles own the terminal', () => {
  it('is a fixed id no session can take', () => {
    expect(FILTER).toBe('tile-grid');
    // Session ids are UUIDs.
    expect(FILTER).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('opening the grid and every tile focus subscribe with it, never a session id', async () => {
    const app = makeApp();
    app.openTileGrid(IDS);
    delete app.selectSession;
    await app.selectSession('s-b');
    await app.selectSession('s-c');
    expect(posted().length).toBeGreaterThanOrEqual(3);
    expect(new Set(posted().map((s: string[]) => s.join()))).toEqual(new Set([FILTER]));
  });

  it('leaving the grid gives the filter back to the session shown', () => {
    const app = makeApp();
    app.openTileGrid(IDS);
    expect(app._sseFilterSessionId('s-a')).toBe(FILTER);
    app.closeTileGrid({ keepStored: true, reselect: false });
    // What the single view's selectSession (app.js) then posts.
    app._updateSseSubscription('s-a');
    expect(posted().at(-1)).toEqual(['s-a']);
    expect(app._sseFilterSessionId('s-b')).toBe('s-b');
  });

  it('a page with no grid open (a reload into the single view) filters on the session as before', () => {
    const app = makeApp();
    expect(app._sseFilterSessionId('s-a')).toBe('s-a');
    expect(app._sseFilterSessionId(null)).toBe(null);
    app._updateSseSubscription('s-a');
    expect(posted()).toEqual([['s-a']]);
  });

  it('the connect URL asks the same question, so an SSE reconnect with the grid open keeps the filter', () => {
    // connectSSE builds an EventSource, which this harness has none of, so its
    // URL building is read from source: one place, through the helper.
    const app = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = app.indexOf('const _sseParams = new URLSearchParams(');
    expect(start).toBeGreaterThan(-1);
    const block = app.slice(start, app.indexOf('this.eventSource = new EventSource(', start));
    expect(block).toContain('this._sseFilterSessionId(this.activeSessionId)');
    expect(block).not.toMatch(/set\('sessions', this\.activeSessionId\)/);
  });
});
