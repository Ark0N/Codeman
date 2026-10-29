// @vitest-environment node
/**
 * @fileoverview The glue between WebServer and the Discord bridge: alerts reach it even with no
 * Web Push subscription (with the rendered screen as the tail), and tab events reach it routed by
 * kind. The bridge and routes are tested on their own; this pins the lines that make the feature
 * exist. A real WebServer, never started, with the bridge replaced by a recorder.
 *
 * Port: N/A (no server start).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn(async () => undefined) }));
vi.mock('web-push', () => ({
  default: { sendNotification, setVapidDetails: vi.fn(), generateVAPIDKeys: vi.fn() },
}));

import { WebServer } from '../src/web/server.js';
import { SseEvent } from '../src/web/sse-events.js';

type Internals = {
  pushStore: { getAll: () => never[] };
  discordBridge: Record<string, ReturnType<typeof vi.fn>>;
  sessions: Map<string, unknown>;
  mux: { capturePaneText?: (name: string) => string | null };
  sendPushNotifications: (event: string, data: Record<string, unknown>) => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
};

function server(): Internals {
  const s = new WebServer(0, false, true, '127.0.0.1', 'box') as unknown as Internals;
  s.pushStore = { getAll: () => [] };
  s.discordBridge = {
    notify: vi.fn(async () => null),
    sessionCreated: vi.fn(async () => undefined),
    sessionRenamed: vi.fn(async () => undefined),
    sessionDeleted: vi.fn(async () => undefined),
    sessionIdle: vi.fn(async () => undefined),
  };
  return s;
}

beforeEach(() => sendNotification.mockClear());

describe('sendPushNotifications -> Discord', () => {
  it('posts a permission prompt with zero push subscriptions, with the rendered screen as the tail', async () => {
    const s = server();
    s.sessions.set('s1', { muxName: 'codeman-s1', textOutput: '', mode: 'claude' });
    s.mux = { capturePaneText: () => 'Which option?\n──────────\n  1. Cap GPUs\n\n  2. Cap CPU\n' };
    await s.sendPushNotifications('hook:permission_prompt', {
      sessionId: 's1',
      sessionName: 'w1-app',
      tool_name: 'Bash',
    });
    expect(s.discordBridge.notify).toHaveBeenCalledTimes(1);
    expect(s.discordBridge.notify.mock.calls[0][0]).toMatchObject({
      event: 'hook:permission_prompt',
      title: 'Permission Required',
      body: '[w1-app] Tool: Bash',
      urgency: 'critical',
      sessionId: 's1',
      sessionName: 'w1-app',
      tail: 'Which option?\n  1. Cap GPUs\n  2. Cap CPU',
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('falls back to plain text output when there is no tmux pane, and to no tail for an unknown session', async () => {
    const s = server();
    s.sessions.set('s2', { muxName: null, textOutput: 'plain answer\n', mode: 'claude' });
    await s.sendPushNotifications('hook:idle_prompt', { sessionId: 's2', sessionName: 'w2' });
    expect(s.discordBridge.notify.mock.calls[0][0].tail).toBe('plain answer');
    await s.sendPushNotifications('hook:idle_prompt', { sessionId: 'gone', sessionName: 'w3' });
    expect(s.discordBridge.notify.mock.calls[1][0].tail).toBeUndefined();
  });

  it('sends nothing for an event Web Push does not carry', async () => {
    const s = server();
    await s.sendPushNotifications('session:created', { sessionId: 's1', sessionName: 'w1' });
    expect(s.discordBridge.notify).not.toHaveBeenCalled();
  });
});

describe('broadcast -> Discord tab lifecycle', () => {
  it('routes created, updated and deleted by kind, reading both payload shapes', () => {
    const s = server();
    s.broadcast(SseEvent.SessionCreated, { session: { id: 's1', name: 'w1', createdAt: 123 } });
    expect(s.discordBridge.sessionCreated).toHaveBeenCalledWith('s1', 'w1', 123);
    s.broadcast(SseEvent.SessionUpdated, { id: 's1', name: 'renamed' });
    expect(s.discordBridge.sessionRenamed).toHaveBeenCalledWith('s1', 'renamed');
    s.broadcast(SseEvent.SessionDeleted, { id: 's1' });
    expect(s.discordBridge.sessionDeleted).toHaveBeenCalledWith('s1');
  });

  it('ignores an event with no session id', () => {
    const s = server();
    s.broadcast(SseEvent.SessionDeleted, {});
    expect(s.discordBridge.sessionDeleted).not.toHaveBeenCalled();
  });

  it('tells the bridge whether an idle session is an external CLI: codex yes, claude and shell no', () => {
    const s = server();
    s.sessions.set('cx', { mode: 'codex' });
    s.sessions.set('cl', { mode: 'claude' });
    s.sessions.set('sh', { mode: 'shell' });
    for (const id of ['cx', 'cl', 'sh', 'missing']) s.broadcast(SseEvent.SessionIdle, { id });
    expect(s.discordBridge.sessionIdle.mock.calls).toEqual([
      ['cx', true],
      ['cl', false],
      ['sh', false],
      ['missing', false],
    ]);
  });
});
