// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWebhookRequest,
  DEFAULT_WEBHOOK_CONFIG,
  maskWebhookUrl,
  readWebhookConfig,
  sendWebhook,
  shouldSendWebhook,
  webhookConfigPath,
  WebhookNotifier,
  webhookUrlProblem,
  writeWebhookConfig,
  type WebhookFetch,
  type WebhookMessage,
} from '../src/webhook-notify.js';
import type { WebhookConfig } from '../src/types/push.js';
import { webviewFetch, WebviewEgressBlockedError } from '../src/web/webview-egress.js';

const MSG: WebhookMessage = {
  event: 'hook:permission_prompt',
  title: 'Permission Required',
  body: '[w1-app] Tool: Bash',
  urgency: 'critical',
  sessionId: 's1',
  sessionName: 'w1-app',
  host: 'codeman:box',
};
const CFG: WebhookConfig = {
  enabled: true,
  kind: 'generic',
  url: 'https://hooks.example.com/T0/B0/secret',
  scope: 'attention',
};
// A 204 (like a 3xx with no body) must be built without one.
const ok = (status = 200) => new Response(status === 204 ? null : '', { status });

describe('webhookUrlProblem', () => {
  it.each([
    'https://ntfy.sh/mytopic',
    'https://hooks.slack.com/services/T/B/x',
    'http://localhost:8080/t',
    'http://192.168.1.5/hook',
  ])('accepts %s (loopback and LAN are the point of a local ntfy)', (url) => expect(webhookUrlProblem(url)).toBeNull());

  it.each([
    ['ftp://example.com/x', /http and https/],
    ['file:///etc/passwd', /http and https/],
    ['https://user:pw@example.com/x', /credentials/],
    ['not a url', /valid URL/],
    ['http://169.254.169.254/latest/meta-data', /link-local|metadata/],
    ['http://metadata.google.internal/computeMetadata/v1/', /metadata/],
    ['http://[fd00:ec2::254]/', /metadata|link-local/],
    [`https://example.com/${'a'.repeat(2100)}`, /too long/],
  ])('rejects %s', (url, why) => expect(webhookUrlProblem(url)).toMatch(why));
});

describe('maskWebhookUrl', () => {
  it('keeps scheme and host and drops the secret path and query', () => {
    const masked = maskWebhookUrl('https://hooks.slack.com/services/T0/B0/XXXXSECRET?token=abc');
    expect(masked).toBe('https://hooks.slack.com/•••');
    expect(masked).not.toMatch(/SECRET|token|T0/);
  });
  it('is empty for nothing or garbage', () => {
    expect(maskWebhookUrl('')).toBe('');
    expect(maskWebhookUrl('nope')).toBe('');
  });
});

describe('shouldSendWebhook', () => {
  it('needs enabled and a url', () => {
    expect(shouldSendWebhook({ ...CFG, enabled: false }, 'critical')).toBe(false);
    expect(shouldSendWebhook({ ...CFG, url: '' }, 'critical')).toBe(false);
    expect(shouldSendWebhook(CFG, 'critical')).toBe(true);
  });
  it('scope attention skips "response complete" (info); scope all sends it', () => {
    expect(shouldSendWebhook(CFG, 'warning')).toBe(true);
    expect(shouldSendWebhook(CFG, 'info')).toBe(false);
    expect(shouldSendWebhook({ ...CFG, scope: 'all' }, 'info')).toBe(true);
  });
});

describe('buildWebhookRequest', () => {
  it('ntfy: plain-text body, priority and tag by urgency, host-prefixed title', () => {
    const r = buildWebhookRequest('ntfy', MSG);
    expect(r.body).toBe('[w1-app] Tool: Bash');
    expect(r.headers.Title).toBe('codeman:box: Permission Required');
    expect(r.headers.Priority).toBe('5');
    expect(buildWebhookRequest('ntfy', { ...MSG, urgency: 'info' }).headers.Priority).toBe('3');
    expect(buildWebhookRequest('ntfy', { ...MSG, urgency: 'warning' }).headers.Priority).toBe('4');
  });

  it('ntfy: a non-ASCII or multi-line title can never break the header (RFC 2047 encoded)', () => {
    const r = buildWebhookRequest('ntfy', { ...MSG, title: 'Prüfung\r\nX-Injected: 1', host: undefined });
    expect(r.headers.Title).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(Buffer.from(r.headers.Title.slice(10, -2), 'base64').toString('utf8')).toBe('Prüfung X-Injected: 1');
    expect(Object.keys(r.headers)).not.toContain('X-Injected');
  });

  it('slack: control characters are escaped so agent text cannot ping a channel', () => {
    const r = JSON.parse(
      buildWebhookRequest('slack', { ...MSG, body: '<!channel> <@U123> <https://evil|click> & more' }).body
    );
    expect(r.text).not.toMatch(/<[!@h]/);
    expect(r.text).toContain('&lt;!channel&gt;');
    expect(r.text).toContain('&amp; more');
  });

  it('discord: mentions are disabled and the content is length-capped', () => {
    const r = JSON.parse(buildWebhookRequest('discord', { ...MSG, body: '@everyone ' + 'x'.repeat(5000) }).body);
    expect(r.allowed_mentions).toEqual({ parse: [] });
    expect(r.content.length).toBeLessThanOrEqual(1900);
  });

  it('generic: structured JSON with the session and a timestamp', () => {
    const r = JSON.parse(buildWebhookRequest('generic', MSG, new Date('2026-10-02T12:00:00Z')).body);
    expect(r).toEqual({
      event: 'hook:permission_prompt',
      title: 'Permission Required',
      body: '[w1-app] Tool: Bash',
      urgency: 'critical',
      sessionId: 's1',
      sessionName: 'w1-app',
      host: 'codeman:box',
      at: '2026-10-02T12:00:00.000Z',
    });
  });

  it('truncates a long body for every kind', () => {
    const long = 'y'.repeat(2000);
    expect(buildWebhookRequest('ntfy', { ...MSG, body: long }).body.length).toBeLessThanOrEqual(500);
    expect(JSON.parse(buildWebhookRequest('generic', { ...MSG, body: long }).body).body.length).toBeLessThanOrEqual(
      500
    );
  });
});

describe('store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webhook-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the defaults for a missing or corrupt file', async () => {
    expect(await readWebhookConfig(dir)).toEqual(DEFAULT_WEBHOOK_CONFIG);
    writeFileSync(webhookConfigPath(dir), '{ nope');
    expect(await readWebhookConfig(dir)).toEqual(DEFAULT_WEBHOOK_CONFIG);
  });

  it('round-trips and writes the file readable by its owner only', async () => {
    await writeWebhookConfig(dir, CFG);
    expect(await readWebhookConfig(dir)).toEqual(CFG);
    expect(statSync(webhookConfigPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing world-readable file instead of keeping its mode', async () => {
    writeFileSync(webhookConfigPath(dir), '{}', { mode: 0o644 });
    await writeWebhookConfig(dir, CFG);
    expect(statSync(webhookConfigPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('coerces unknown kinds and scopes back to the defaults', async () => {
    writeFileSync(
      webhookConfigPath(dir),
      JSON.stringify({ enabled: true, kind: 'telegram', scope: 'nope', url: 'https://x.test/h' })
    );
    const cfg = await readWebhookConfig(dir);
    expect(cfg).toEqual({ enabled: true, kind: 'ntfy', scope: 'attention', url: 'https://x.test/h' });
  });
});

describe('sendWebhook', () => {
  it('posts the built request with redirects off and a timeout signal', async () => {
    const fetchImpl = vi.fn<WebhookFetch>(async () => ok(204));
    const r = await sendWebhook(CFG, MSG, fetchImpl);
    expect(r).toMatchObject({ ok: true, status: 204 });
    const [target, init] = fetchImpl.mock.calls[0];
    expect(target.href).toBe(CFG.url);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports an HTTP failure by status, a redirect as such, and never echoes the URL', async () => {
    const bad = await sendWebhook(CFG, MSG, async () => ok(404));
    expect(bad).toMatchObject({ ok: false, status: 404, error: 'HTTP 404' });
    const redirect = await sendWebhook(CFG, MSG, async () => ok(302));
    expect(redirect.ok).toBe(false);
    expect(redirect.error).toMatch(/redirects/);
    for (const r of [bad, redirect]) expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('turns network errors into short messages that do not contain the URL', async () => {
    const cases: [unknown, RegExp][] = [
      [Object.assign(new Error('x'), { name: 'TimeoutError' }), /Timed out/],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), /Host not found/],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), /refused/],
      [new TypeError('fetch failed https://hooks.example.com/T0/B0/secret'), /Network error/],
    ];
    for (const [err, re] of cases) {
      const r = await sendWebhook(CFG, MSG, async () => {
        throw err;
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(re);
      expect(JSON.stringify(r)).not.toContain('secret');
    }
  });

  it('refuses a blocked URL without fetching', async () => {
    const fetchImpl = vi.fn<WebhookFetch>(async () => ok());
    const r = await sendWebhook({ ...CFG, url: 'http://169.254.169.254/latest' }, MSG, fetchImpl);
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('recognises an egress refusal by its code anywhere in the cause chain, not by message text', async () => {
    // A DNS name resolving into a blocked range is refused by the connect-time lookup, and undici
    // hands that back wrapped (`fetch failed` -> connect error -> the refusal), so it can sit deep.
    const blocked = new WebviewEgressBlockedError('cloud metadata');
    const deep = new TypeError('fetch failed', { cause: new Error('connect failed', { cause: blocked }) });
    for (const err of [blocked, deep]) {
      const r = await sendWebhook(CFG, MSG, async () => {
        throw err;
      });
      expect(r.error).toBe('Refused: target is a link-local or cloud-metadata address');
    }
    // Words alone (an upstream error that happens to mention them) are not a refusal.
    const r = await sendWebhook(CFG, MSG, async () => {
      throw new TypeError('fetch failed', { cause: new Error('link-local EGRESS hiccup') });
    });
    expect(r.error).toBe('Network error');
  });
});

describe('delivery through the real egress-guarded fetch', () => {
  let server: Server;
  let received: { headers: IncomingMessage['headers']; body: string } | null;
  let port: number;

  beforeEach(async () => {
    received = null;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = { headers: req.headers, body };
        res.statusCode = req.url === '/redirect' ? 302 : 200;
        if (req.url === '/redirect') res.setHeader('Location', 'http://169.254.169.254/');
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('delivers to a local server (loopback is allowed) with the ntfy headers', async () => {
    const r = await sendWebhook({ kind: 'ntfy', url: `http://127.0.0.1:${port}/topic` }, MSG, webviewFetch);
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(received?.body).toBe('[w1-app] Tool: Bash');
    expect(received?.headers.priority).toBe('5');
  });

  it('does not follow a redirect to a metadata address', async () => {
    const r = await sendWebhook({ kind: 'generic', url: `http://127.0.0.1:${port}/redirect` }, MSG, webviewFetch);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redirects/);
  });

  it('refuses a metadata address at the fetch layer too', async () => {
    await expect(webviewFetch(new URL('http://169.254.169.254/'))).rejects.toThrow();
  });
});

describe('WebhookNotifier', () => {
  const make = (cfg: Partial<WebhookConfig> = {}, fetchImpl: WebhookFetch = async () => ok(), now?: () => number) => {
    const sent = vi.fn(fetchImpl);
    const notifier = new WebhookNotifier(async () => ({ ...CFG, ...cfg }), sent, now);
    return { notifier, sent };
  };

  it('sends an event that needs attention and records the result', async () => {
    const { notifier, sent } = make();
    await notifier.notify(MSG);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(notifier.lastResult).toMatchObject({ ok: true });
  });

  it('sends nothing when disabled, without a url, or for info under scope attention', async () => {
    for (const cfg of [{ enabled: false }, { url: '' }]) {
      const { notifier, sent } = make(cfg);
      await notifier.notify(MSG);
      expect(sent).not.toHaveBeenCalled();
    }
    const { notifier, sent } = make();
    await notifier.notify({ ...MSG, urgency: 'info' });
    expect(sent).not.toHaveBeenCalled();
  });

  it('sends the same event for the same session once per window, then again', async () => {
    let t = 1_000_000;
    const { notifier, sent } = make(
      {},
      async () => ok(),
      () => t
    );
    await notifier.notify(MSG);
    t += 1000;
    await notifier.notify(MSG);
    expect(sent).toHaveBeenCalledTimes(1);
    await notifier.notify({ ...MSG, sessionId: 's2' });
    expect(sent).toHaveBeenCalledTimes(2);
    t += 5000;
    await notifier.notify(MSG);
    expect(sent).toHaveBeenCalledTimes(3);
  });

  it('caps what is in flight so a hung endpoint cannot pile up requests', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { notifier, sent } = make({}, async () => (await gate, ok()));
    const pending = Array.from({ length: 12 }, (_, i) => notifier.notify({ ...MSG, sessionId: `s${i}` }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveBeenCalledTimes(5);
    release();
    await Promise.all(pending);
  });

  it('a test send ignores enabled and scope, bypasses dedupe, and records the result', async () => {
    const { notifier, sent } = make({ enabled: false });
    const r1 = await notifier.sendTest(CFG, 'codeman:box');
    const r2 = await notifier.sendTest(CFG);
    expect(r1.ok && r2.ok).toBe(true);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(notifier.lastResult).toBe(r2);
    expect(JSON.parse(sent.mock.calls[0][1].body as string).host).toBe('codeman:box');
  });

  it('never throws on a failing endpoint', async () => {
    const { notifier } = make({}, async () => {
      throw new Error('boom');
    });
    await expect(notifier.notify(MSG)).resolves.toBeUndefined();
    expect(notifier.lastResult).toMatchObject({ ok: false });
  });
});
