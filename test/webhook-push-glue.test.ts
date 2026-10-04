/**
 * @fileoverview The glue between `WebServer.sendPushNotifications()` and the webhook channel.
 *
 * The notifier and the routes are tested on their own (webhook-notify.test.ts,
 * routes/webhook-routes.test.ts); this file pins the one line that makes the feature exist: the
 * webhook fires even when there is NO Web Push subscription, which is exactly the headless server
 * it was built for. Moving the call below the "no subscriptions" early return passes every other
 * test and silently kills the feature, so it is asserted here end to end: a real WebServer (never
 * started), an empty push store, `webhook.json` in the instance data dir, and a local HTTP receiver
 * reached through the real egress-guarded fetch.
 *
 * Port: N/A (no server start; the receiver binds an ephemeral 127.0.0.1 port).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn(async () => undefined) }));
vi.mock('web-push', () => ({
  default: { sendNotification, setVapidDetails: vi.fn(), generateVAPIDKeys: vi.fn() },
}));

import { WebServer } from '../src/web/server.js';
import { getDataDir } from '../src/config/instance.js';
import { writeWebhookConfig, type WebhookMessage, type WebhookNotifier } from '../src/webhook-notify.js';
import type { WebhookConfig } from '../src/types/push.js';

interface Received {
  url?: string;
  title?: string;
  body: string;
}

type PushSender = { sendPushNotifications: (e: string, d: Record<string, unknown>) => Promise<void> };

let receiver: Server;
let receiverUrl: string;
const got: Received[] = [];

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // Recorded before the response goes out, so a resolved notify() means it is already here.
      got.push({ url: req.url, title: req.headers.title as string | undefined, body });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/codeman-topic`;
});

afterAll(() => new Promise<void>((resolve) => receiver.close(() => resolve())));

beforeEach(() => {
  got.length = 0;
  sendNotification.mockClear();
});

/**
 * A headless server: no push subscription at all. The real notifier stays in place; its `notify`
 * is only wrapped to collect the promises `sendPushNotifications` fires and forgets, so a test can
 * await delivery instead of sleeping.
 */
async function headlessServer(cfg: Partial<WebhookConfig>) {
  await writeWebhookConfig(getDataDir(), { enabled: true, kind: 'ntfy', scope: 'attention', url: receiverUrl, ...cfg });
  const server = new WebServer(0, false, true, '127.0.0.1', 'box');
  (server as unknown as { pushStore: { getAll: () => never[] } }).pushStore = { getAll: () => [] };
  const notifier = (server as unknown as { webhookNotifier: WebhookNotifier }).webhookNotifier;
  const pending: Promise<void>[] = [];
  const realNotify = notifier.notify.bind(notifier);
  notifier.notify = (msg: WebhookMessage) => {
    const p = realNotify(msg);
    pending.push(p);
    return p;
  };
  const send = async (event: string, data: Record<string, unknown>) => {
    await (server as unknown as PushSender).sendPushNotifications(event, data);
    await Promise.all(pending.splice(0));
  };
  return { send };
}

describe('sendPushNotifications -> webhook (the headless case)', () => {
  it('delivers a permission prompt to the webhook with zero push subscriptions', async () => {
    const { send } = await headlessServer({});
    await send('hook:permission_prompt', { sessionId: 's1', sessionName: 'w1-app', tool_name: 'Bash' });
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      url: '/codeman-topic',
      title: 'codeman:box: Permission Required',
      body: '[w1-app] Tool: Bash',
    });
    // Web Push had nobody to send to, and the webhook did not need it.
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('dedupes an immediate repeat of the same event for the same session', async () => {
    const { send } = await headlessServer({});
    await send('hook:idle_prompt', { sessionId: 's1', sessionName: 'w1-app' });
    await send('hook:idle_prompt', { sessionId: 's1', sessionName: 'w1-app' });
    expect(got).toHaveLength(1);
    await send('hook:idle_prompt', { sessionId: 's2', sessionName: 'w2-app' });
    expect(got).toHaveLength(2);
  });

  it('skips "response complete" under scope attention and sends it under scope all', async () => {
    const attention = await headlessServer({ scope: 'attention' });
    await attention.send('hook:stop', { sessionId: 's1', sessionName: 'w1-app' });
    expect(got).toHaveLength(0);

    const all = await headlessServer({ scope: 'all' });
    await all.send('hook:stop', { sessionId: 's1', sessionName: 'w1-app' });
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe('codeman:box: Response Complete');
  });

  it('sends nothing while disabled, and nothing for an event Web Push does not carry', async () => {
    const disabled = await headlessServer({ enabled: false });
    await disabled.send('hook:permission_prompt', { sessionId: 's1', sessionName: 'w1-app', tool_name: 'Bash' });
    const enabled = await headlessServer({});
    await enabled.send('session:created', { sessionId: 's1', sessionName: 'w1-app' });
    expect(got).toHaveLength(0);
  });
});
