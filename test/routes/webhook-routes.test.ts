/**
 * @fileoverview /api/webhook: the webhook-notification config. The URL is a bearer secret, so it
 * is never returned and the routes are admin only in multi-user mode.
 * Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerWebhookRoutes } from '../../src/web/routes/webhook-routes.js';
import { readWebhookConfig, webhookConfigPath, WebhookNotifier, type WebhookFetch } from '../../src/webhook-notify.js';

const SECRET_URL = 'https://hooks.slack.com/services/T0/B0/SUPERSECRET';

let dir: string;
let fetchImpl: ReturnType<typeof vi.fn<WebhookFetch>>;

async function harness(authUser?: { username: string; role: 'admin' | 'user' }) {
  const notifier = new WebhookNotifier(() => readWebhookConfig(dir), fetchImpl);
  const h = await createRouteTestHarness(
    (app) => registerWebhookRoutes(app, { notifier, configDir: dir, hostTitle: () => 'codeman:test' }),
    authUser ? { authUser } : undefined
  );
  return { ...h, notifier };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'webhook-routes-'));
  fetchImpl = vi.fn<WebhookFetch>(async () => new Response('', { status: 200 }));
});
afterEach(() => {
  delete process.env.CODEMAN_MULTIUSER;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/webhook', () => {
  it('starts disabled with no URL', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/webhook' });
    expect(res.json().data).toEqual({
      enabled: false,
      kind: 'ntfy',
      scope: 'attention',
      hasUrl: false,
      urlMasked: '',
      lastResult: null,
    });
  });
});

describe('PUT /api/webhook', () => {
  it('saves the config, masks the URL in every response, and writes the file 0600', async () => {
    const { app } = await harness();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/webhook',
      payload: { enabled: true, kind: 'slack', scope: 'all', url: SECRET_URL },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data).toMatchObject({ enabled: true, kind: 'slack', scope: 'all', hasUrl: true });
    expect(put.json().data.urlMasked).toBe('https://hooks.slack.com/•••');
    const get = await app.inject({ method: 'GET', url: '/api/webhook' });
    for (const body of [put.body, get.body]) expect(body).not.toMatch(/SUPERSECRET|T0\/B0/);
    expect((await readWebhookConfig(dir)).url).toBe(SECRET_URL);
    expect(statSync(webhookConfigPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('changing kind or scope keeps the saved URL (the secret is never re-sent)', async () => {
    const { app } = await harness();
    await app.inject({ method: 'PUT', url: '/api/webhook', payload: { enabled: true, url: SECRET_URL } });
    await app.inject({ method: 'PUT', url: '/api/webhook', payload: { kind: 'discord' } });
    expect(await readWebhookConfig(dir)).toMatchObject({ kind: 'discord', url: SECRET_URL, enabled: true });
  });

  it('an empty url clears it', async () => {
    const { app } = await harness();
    await app.inject({ method: 'PUT', url: '/api/webhook', payload: { url: SECRET_URL } });
    const res = await app.inject({ method: 'PUT', url: '/api/webhook', payload: { url: '' } });
    expect(res.json().data).toMatchObject({ hasUrl: false, urlMasked: '' });
    expect((await readWebhookConfig(dir)).url).toBe('');
  });

  it.each([
    ['enabling with no URL', { enabled: true }, /Add a webhook URL/],
    ['a metadata address', { url: 'http://169.254.169.254/latest' }, /metadata|link-local/],
    ['a non-http scheme', { url: 'file:///etc/passwd' }, /http and https/],
    ['credentials in the URL', { url: 'https://u:p@example.com/x' }, /credentials/],
    ['clearing the URL while enabled', null, /Add a webhook URL/],
  ])('rejects %s with 400 and saves nothing', async (_label, payload, why) => {
    const { app } = await harness();
    if (payload === null) {
      await app.inject({ method: 'PUT', url: '/api/webhook', payload: { enabled: true, url: SECRET_URL } });
      const res = await app.inject({ method: 'PUT', url: '/api/webhook', payload: { url: '' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(why);
      expect((await readWebhookConfig(dir)).url).toBe(SECRET_URL);
      return;
    }
    const res = await app.inject({ method: 'PUT', url: '/api/webhook', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(why);
    expect(await readWebhookConfig(dir)).toMatchObject({ enabled: false, url: '' });
  });

  it('rejects unknown keys and bad enums (strict schema)', async () => {
    const { app } = await harness();
    for (const payload of [{ extra: 1 }, { kind: 'telegram' }, { scope: 'everything' }, { enabled: 'yes' }]) {
      const res = await app.inject({ method: 'PUT', url: '/api/webhook', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('POST /api/webhook/test', () => {
  it('refuses with 400 until a URL is saved', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'POST', url: '/api/webhook/test' });
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends one message with the saved config, even while notifications are disabled', async () => {
    const { app, notifier } = await harness();
    await app.inject({ method: 'PUT', url: '/api/webhook', payload: { kind: 'generic', url: SECRET_URL } });
    const res = await app.inject({ method: 'POST', url: '/api/webhook/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string)).toMatchObject({
      host: 'codeman:test',
      event: 'webhook:test',
    });
    expect(notifier.lastResult?.ok).toBe(true);
    expect(res.body).not.toContain('SUPERSECRET');
  });

  it('reports a delivery failure in data (HTTP 200) without leaking the URL, and GET shows it as the last result', async () => {
    fetchImpl.mockImplementation(async () => new Response('', { status: 404 }));
    const { app } = await harness();
    await app.inject({ method: 'PUT', url: '/api/webhook', payload: { url: SECRET_URL } });
    const res = await app.inject({ method: 'POST', url: '/api/webhook/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ ok: false, status: 404, error: 'HTTP 404' });
    const get = await app.inject({ method: 'GET', url: '/api/webhook' });
    expect(get.json().data.lastResult).toMatchObject({ ok: false, status: 404 });
    expect(get.body).not.toContain('SUPERSECRET');
  });
});

describe('multi-user', () => {
  it.each([
    ['GET', '/api/webhook'],
    ['PUT', '/api/webhook'],
    ['POST', '/api/webhook/test'],
  ] as const)('refuses a non-admin on %s %s and touches nothing', async (method, url) => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await harness({ username: 'bob', role: 'user' });
    const res = await app.inject({ method, url, payload: method === 'PUT' ? { url: SECRET_URL } : undefined });
    expect(res.statusCode).toBe(403);
    expect((await readWebhookConfig(dir)).url).toBe('');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows an admin', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await harness({ username: 'root', role: 'admin' });
    expect((await app.inject({ method: 'GET', url: '/api/webhook' })).statusCode).toBe(200);
  });
});
