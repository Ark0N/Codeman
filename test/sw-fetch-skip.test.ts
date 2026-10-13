/**
 * @fileoverview Which requests the service worker leaves to the network.
 *
 * The fetch handler caches every OK GET it answers, and the offline fallback
 * serves from that cache. A rendered HTML page (`/html-view/<cap>/...`) is
 * served `no-store` behind a capability that logout revokes, so a popped-out
 * page must never land there: it is skipped like `/api/`.
 *
 * Runs the shipped sw.js in a `vm` context with a stub ServiceWorkerGlobalScope
 * and drives its real fetch listener.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const swJs = readFileSync(resolve(import.meta.dirname, '../src/web/public/sw.js'), 'utf8');

function loadFetchListener(): (event: unknown) => void {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    location: { pathname: '/sw.js', origin: 'http://localhost' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
  };
  // A fetch that never settles: the listener only has to decide whether to answer.
  const fetch = vi.fn(() => new Promise(() => {}));
  vm.runInContext(swJs, vm.createContext({ self, console, caches: {}, fetch, URL }), { filename: 'sw.js' });
  const listener = listeners.get('fetch');
  expect(listener, 'sw.js registers a fetch listener').toBeDefined();
  return listener!;
}

function fetchEvent(path: string) {
  return {
    request: { method: 'GET', url: `http://localhost${path}`, headers: { get: () => null } },
    respondWith: vi.fn(),
  };
}

describe('service worker fetch skip list', () => {
  it('leaves rendered HTML pages and the API to the network', () => {
    const onFetch = loadFetchListener();
    for (const path of ['/html-view/AAAAAAAAAAAAAAAAAAAAAAAA/index.html', '/api/status']) {
      const event = fetchEvent(path);
      onFetch(event);
      expect(event.respondWith, path).not.toHaveBeenCalled();
    }
  });

  it('still answers an app asset', () => {
    const onFetch = loadFetchListener();
    const event = fetchEvent('/app.js');
    onFetch(event);
    expect(event.respondWith).toHaveBeenCalledTimes(1);
  });
});
