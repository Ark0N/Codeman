/**
 * Web-tab proxy capabilities must die with the login that minted them.
 *
 * `WebviewCapabilityStore.revokeOwner()` shipped for two releases with a docstring
 * saying logout called it and NO caller. The capability is a bearer credential
 * exempt from cookie auth, with a rolling TTL refreshed on every use, so a leaked
 * proxy URL stayed valid indefinitely. These tests pin every call site:
 * `POST /api/logout` (own identity), the admin forced logout, and user deletion.
 * The rendered-HTML capabilities (`htmlViewCapabilities`) are pinned at the same sites.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebviewCapabilityStore, webviewCapabilities } from '../src/webview-capabilities.js';
import { HtmlViewCapabilityStore, htmlViewCapabilities } from '../src/html-view-capabilities.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { registerAdminRoutes } from '../src/web/routes/admin-routes.js';
import { createUser, invalidateUsersCache } from '../src/user-store.js';

const PASSWORD = 'correct-horse-battery-staple';

describe('WebviewCapabilityStore.revokeOwner', () => {
  it('revokes exactly the identity asked for, the single-user `undefined` identity included', () => {
    const store = new WebviewCapabilityStore();
    const solo = store.mint('wv-solo', undefined);
    const alice = store.mint('wv-alice', 'alice');
    const bob = store.mint('wv-bob', 'bob');

    expect(store.revokeOwner('alice')).toBe(1);
    expect(store.resolve(alice)).toBeUndefined();
    expect(store.resolve(bob)).toBeDefined();
    expect(store.resolve(solo)).toBeDefined();

    expect(store.revokeOwner(undefined)).toBe(1);
    expect(store.resolve(solo)).toBeUndefined();
    expect(store.resolve(bob)).toBeDefined();

    // A later open mints a NEW token rather than resurrecting the revoked one.
    expect(store.mint('wv-alice', 'alice')).not.toBe(alice);
    expect(store.revokeOwner('nobody')).toBe(0);
    store.dispose();
  });
});

describe('HtmlViewCapabilityStore.revokeOwner', () => {
  it('revokes exactly the identity asked for, the single-user `undefined` identity included', () => {
    const store = new HtmlViewCapabilityStore();
    const solo = store.mint('/srv/solo', undefined);
    const alice = store.mint('/srv/alice', 'alice');
    const bob = store.mint('/srv/bob', 'bob');

    expect(store.revokeOwner('alice')).toBe(1);
    expect(store.resolve(alice)).toBeUndefined();
    expect(store.resolve(bob)).toBeDefined();
    expect(store.resolve(solo)).toBeDefined();

    expect(store.revokeOwner(undefined)).toBe(1);
    expect(store.resolve(solo)).toBeUndefined();
    expect(store.resolve(bob)).toBeDefined();

    // Re-opening mints a NEW token rather than resurrecting the revoked one.
    expect(store.mint('/srv/alice', 'alice')).not.toBe(alice);
    store.dispose();
  });
});

describe('POST /api/logout', () => {
  let harness: RouteTestHarness;

  beforeAll(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
  });

  afterAll(async () => {
    await harness.app.close();
  });

  it('single-user: every outstanding capability dies with the login', async () => {
    const cap = webviewCapabilities.mint('wv-logout-solo', undefined);
    const page = htmlViewCapabilities.mint('/srv/logout-solo', undefined);
    expect(webviewCapabilities.resolve(cap)).toBeDefined();
    expect(htmlViewCapabilities.resolve(page)).toBeDefined();

    const res = await harness.app.inject({ method: 'POST', url: '/api/logout' });
    expect(res.statusCode).toBe(200);
    expect(webviewCapabilities.resolve(cap)).toBeUndefined();
    expect(htmlViewCapabilities.resolve(page)).toBeUndefined();
  });
});

describe('POST /api/logout in multi-user mode', () => {
  let harness: RouteTestHarness;
  let savedMode: string | undefined;

  beforeAll(async () => {
    savedMode = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    harness = await createRouteTestHarness(registerSessionRoutes, { authUser: { username: 'peon', role: 'user' } });
  });

  afterAll(async () => {
    await harness.app.close();
    if (savedMode === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = savedMode;
  });

  it("revokes only the caller's capabilities, never another user's", async () => {
    const mine = webviewCapabilities.mint('wv-peon-own', 'peon');
    const theirs = webviewCapabilities.mint('wv-boss-own', 'boss');
    const myPage = htmlViewCapabilities.mint('/srv/peon-own', 'peon');
    const theirPage = htmlViewCapabilities.mint('/srv/boss-own', 'boss');

    const res = await harness.app.inject({ method: 'POST', url: '/api/logout' });
    expect(res.statusCode).toBe(200);
    expect(webviewCapabilities.resolve(mine)).toBeUndefined();
    expect(webviewCapabilities.resolve(theirs)).toBeDefined();
    expect(htmlViewCapabilities.resolve(myPage)).toBeUndefined();
    expect(htmlViewCapabilities.resolve(theirPage)).toBeDefined();
    webviewCapabilities.revokeWebview('wv-boss-own');
    htmlViewCapabilities.revokeOwner('boss');
  });
});

describe('admin routes (multi-user)', () => {
  let harness: RouteTestHarness;
  let savedMode: string | undefined;

  // The temp HOME from test/setup.ts is per-FILE, so users.json persists across
  // the tests in this block.
  beforeAll(async () => {
    savedMode = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    invalidateUsersCache();
    await createUser({ username: 'boss', role: 'admin', password: PASSWORD });
    await createUser({ username: 'peon', role: 'user', password: PASSWORD });
    harness = await createRouteTestHarness(registerAdminRoutes, { authUser: { username: 'boss', role: 'admin' } });
  });

  afterAll(async () => {
    await harness.app.close();
    if (savedMode === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = savedMode;
    invalidateUsersCache();
  });

  it('a forced logout revokes the target user (normalised) and leaves the admin alone', async () => {
    const peon = webviewCapabilities.mint('wv-peon-forced', 'peon');
    const boss = webviewCapabilities.mint('wv-boss-forced', 'boss');
    const peonPage = htmlViewCapabilities.mint('/srv/peon-forced', 'peon');
    const bossPage = htmlViewCapabilities.mint('/srv/boss-forced', 'boss');

    const res = await harness.app.inject({ method: 'POST', url: '/api/admin/users/PEON/logout' });
    expect(res.statusCode).toBe(200);
    expect(webviewCapabilities.resolve(peon)).toBeUndefined();
    expect(webviewCapabilities.resolve(boss)).toBeDefined();
    expect(htmlViewCapabilities.resolve(peonPage)).toBeUndefined();
    expect(htmlViewCapabilities.resolve(bossPage)).toBeDefined();
    webviewCapabilities.revokeWebview('wv-boss-forced');
    htmlViewCapabilities.revokeOwner('boss');
  });

  it('deleting a user revokes whatever that user had open', async () => {
    const peon = webviewCapabilities.mint('wv-peon-deleted', 'peon');
    const peonPage = htmlViewCapabilities.mint('/srv/peon-deleted', 'peon');

    const res = await harness.app.inject({ method: 'DELETE', url: '/api/admin/users/peon' });
    expect(res.statusCode).toBe(200);
    expect(webviewCapabilities.resolve(peon)).toBeUndefined();
    expect(htmlViewCapabilities.resolve(peonPage)).toBeUndefined();
  });
});
