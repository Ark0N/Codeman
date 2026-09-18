/**
 * @fileoverview Service worker for PWA install + Web Push notifications.
 *
 * App-shell caching: on install, precaches the core UI assets so the app
 * launches instantly and works offline (or on flaky connections). Uses a
 * network-first strategy for navigation and API calls, cache-first for
 * static assets.
 *
 * Push notifications: receives push events from the Codeman server (via
 * web-push library) and displays OS-level notifications. Handles notification
 * clicks to focus an existing Codeman tab or open a new one.
 *
 * Lifecycle: skipWaiting on install, claim clients on activate -- ensures the
 * latest service worker takes control immediately without waiting for tab
 * refresh.
 *
 * @dependency None (runs in ServiceWorkerGlobalScope, isolated from page scripts)
 * @see src/push-store.ts -- server-side VAPID key management and subscription CRUD
 */

// Build identity. scripts/build.mjs rewrites this declaration after it content-
// hashes the assets; the literal below is what dev serves, and dev wants a
// stable key.
//
// Why the cache key MUST carry it: `activate` deletes every cache whose key is
// not the current one, so the old constant key meant that cleanup never deleted
// anything — hashed assets from every release ever deployed accumulated in one
// bucket until the origin hit its storage quota.
const BUILD_ID = 'dev';
const CACHE_NAME = `codeman-${BUILD_ID}`;

// Reverse-proxy base path: the worker is served at `<base>/sw.js`, so its own
// location tells us the mount prefix ('' at root, or '/codeman'). Every URL below
// is prefixed through B() so the cached shell, icons and API calls resolve under
// the mount instead of escaping to the origin root.
const SW_BASE = self.location.pathname.replace(/\/sw\.js$/, '');
const B = (p) => (p && p[0] === '/' ? SW_BASE + p : p);

// Content-hashed assets. scripts/build.mjs rewrites this declaration with the
// filenames it actually emitted; dev has no hashing, so the empty literal below
// is correct there and the unhashed modules are simply cached on first use by
// the runtime handler further down.
//
// This list used to be maintained by hand with the PRE-hash names, which the
// build then renamed — so in production every entry 404'd and the silent
// `.catch()` in install swallowed all of it. Measured against a running
// instance: 15 of 23 entries failed. Offline still worked, because the fetch
// handler caches every successful GET at runtime, but the precache warmed
// nothing while looking like it did. Deriving it from the same manifest that
// renames the files is the only thing that keeps the two from drifting again.
const HASHED_ASSETS = [];

// Core app shell -- cached on install for instant startup
const APP_SHELL = [
  '/',
  ...HASHED_ASSETS.map((p) => '/' + p),
  '/vendor/xterm.min.js',
  '/vendor/xterm-addon-fit.min.js',
  '/vendor/xterm-addon-unicode11.min.js',
  '/vendor/xterm.css',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
].map(B);

// --- Install: precache app shell ---

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use addAll but don't fail install if some assets 404 (hashed filenames)
      return Promise.allSettled(
        APP_SHELL.map((url) => cache.add(url).catch(() => {}))
      );
    })
  );
  self.skipWaiting();
});

// --- Activate: clean old caches, claim clients ---

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// --- Fetch: network-first with cache fallback ---
// Network-first ensures deploys take effect immediately when online.
// Cache is only used when the network is unavailable (offline/flaky).

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET, WebSocket upgrades, and SSE streams
  if (request.method !== 'GET') return;
  if (request.headers.get('upgrade') === 'websocket') return;
  if (request.headers.get('accept') === 'text/event-stream') return;
  if (request.url.includes('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      // ignoreSearch, or the precache can never be hit. `renderIndexHtml` runs
      // `cacheBustAssets`, which appends `?v=<mtime>` to EVERY same-origin
      // `.js`/`.css` reference — content-hashed names included, so the page asks
      // for `/app.556be563.js?v=1789423735875` while the precache stored
      // `/app.556be563.js`. `caches.match` is query-sensitive by default, so
      // every precached entry was unreachable and only `/`, the icons and the
      // manifest could ever be served offline.
      //
      // It also makes runtime-cached entries survive an mtime change: the same
      // file re-requested under a new `?v=` still matches the copy already held.
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});

// --- Push notifications ---

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  const { title, hostTitle, body, tag, sessionId, approvalId, urgency, actions } = payload;

  const options = {
    body: body || '',
    tag: tag || 'codeman-default',
    icon: B('/icon-192.png'),
    badge: B('/icon-192.png'),
    data: { sessionId, approvalId, url: sessionId ? B(`/?session=${sessionId}`) : B('/') },
    renotify: true,
    requireInteraction: urgency === 'critical',
  };

  if (actions && actions.length > 0) {
    options.actions = actions;
  }

  // Match the in-page Notification format: "codeman:<host>: <event title>".
  // hostTitle is sent by servers >= the hostname-aware push payload change;
  // older servers omit it and we fall back to the bare title.
  const displayTitle = hostTitle && title
    ? `${hostTitle}: ${title}`
    : (title || hostTitle || 'Codeman');

  event.waitUntil(
    self.registration.showNotification(displayTitle, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { sessionId, approvalId, url } = event.notification.data || {};
  const targetUrl = url || B('/');
  const action = event.action || null;

  // Approve/Deny action buttons answer the Approvals Inbox item directly from
  // the worker, so they work with NO Codeman tab open (lock-screen approvals).
  // Same-origin POST with cookie credentials; the CSRF Origin check passes
  // because a service worker fetch carries the worker's own (same) origin.
  if ((action === 'approve' || action === 'deny') && approvalId) {
    event.waitUntil(
      fetch(B(`/api/approvals/${encodeURIComponent(approvalId)}/answer`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }).then((res) => {
        if (res && res.ok) return undefined;
        // 401/404/409: let the human see the state by falling back to a tab.
        return openOrFocus(sessionId, action, approvalId, targetUrl);
      }).catch(() => openOrFocus(sessionId, action, approvalId, targetUrl))
    );
    return;
  }

  event.waitUntil(openOrFocus(sessionId, action, approvalId, targetUrl));
});

function openOrFocus(sessionId, action, approvalId, targetUrl) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    // Try to find an existing Codeman tab
    for (const client of clients) {
      if (client.url.includes(self.location.origin)) {
        client.postMessage({
          type: 'notification-click',
          sessionId,
          approvalId,
          action,
        });
        return client.focus();
      }
    }
    // No existing tab -- open a new one
    return self.clients.openWindow(targetUrl);
  });
}
