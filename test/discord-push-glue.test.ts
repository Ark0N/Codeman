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
  pushStore: { getAll: () => never[]; dispose: () => void };
  discordBridge: Record<string, ReturnType<typeof vi.fn>>;
  sessions: Map<string, unknown>;
  mux: { capturePaneText?: (name: string) => string | null };
  lastResponseFor?: (session: unknown, context?: string) => Promise<{ text: string }>;
  sendPushNotifications: (event: string, data: Record<string, unknown>) => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
  cleanupSession: (id: string, killMux?: boolean, reason?: string) => Promise<void>;
  discardPartiallyBuiltSession: (id: string) => Promise<void>;
};

function server(): Internals {
  const s = new WebServer(0, false, true, '127.0.0.1', 'box') as unknown as Internals;
  s.pushStore = { getAll: () => [], dispose: () => undefined };
  s.discordBridge = {
    notify: vi.fn(async () => null),
    sessionCreated: vi.fn(async () => undefined),
    sessionRenamed: vi.fn(async () => undefined),
    sessionDeleted: vi.fn(async () => undefined),
    forgetTab: vi.fn(),
    sessionIdle: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  return s;
}

beforeEach(() => sendNotification.mockClear());

describe('bridge deps', () => {
  it('agentExited is true only for a session whose pane exit was observed', () => {
    const s = new WebServer(0, false, true, '127.0.0.1', 'box') as unknown as Internals & {
      discordBridge: { deps: { agentExited: (id: string) => boolean } };
    };
    s.sessions.set('dead', { paneExit: { observedAt: 1 } });
    s.sessions.set('alive', {});
    const { agentExited } = s.discordBridge.deps;
    expect(agentExited('dead')).toBe(true);
    expect(agentExited('alive')).toBe(false);
    expect(agentExited('missing')).toBe(false);
  });
});

describe('sendPushNotifications -> Discord', () => {
  it('posts a permission prompt with zero push subscriptions, with the rendered screen as the tail', async () => {
    const s = server();
    s.sessions.set('s1', { muxName: 'codeman-s1', textOutput: '', mode: 'claude' });
    const capture = vi.fn(() => 'Which option?\n──────────\n  1. Cap GPUs\n\n  2. Cap CPU\n');
    s.mux = { capturePaneText: capture };
    await s.sendPushNotifications('hook:permission_prompt', {
      sessionId: 's1',
      sessionName: 'w1-app',
      tool_name: 'Bash',
    });
    expect(s.discordBridge.notify).toHaveBeenCalledTimes(1);
    const msg = s.discordBridge.notify.mock.calls[0][0];
    expect(msg).toMatchObject({
      event: 'hook:permission_prompt',
      title: 'Permission Required',
      body: '[w1-app] Tool: Bash',
      urgency: 'critical',
      sessionId: 's1',
      sessionName: 'w1-app',
    });
    // A function, so the screen is read (a synchronous tmux exec) only once the bridge will post.
    expect(typeof msg.tail).toBe('function');
    expect(capture).not.toHaveBeenCalled();
    expect(msg.tail()).toBe('Which option?\n  1. Cap GPUs\n  2. Cap CPU');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('reads the whole last message from the transcript on a finished turn, and keeps the screen for a dialog', async () => {
    const s = server();
    s.sessions.set('s5', { muxName: 'codeman-s5', textOutput: '', mode: 'claude' });
    const reader = vi.fn(async () => ({ text: 'The full answer.\n\n- one\n- two', timestamp: '2026-10-30T00:00:00Z' }));
    s.lastResponseFor = reader;
    s.mux = { capturePaneText: () => 'screen\n❯\n  status' };
    await s.sendPushNotifications('hook:idle_prompt', { sessionId: 's5', sessionName: 'w5' });
    const idle = s.discordBridge.notify.mock.calls[0][0];
    expect(await idle.fullText()).toEqual({
      text: 'The full answer.\n\n- one\n- two',
      version: '2026-10-30T00:00:00Z',
    });
    expect(idle.tail()).toBe('screen'); // the composer row and the status under it are cut
    await s.sendPushNotifications('hook:permission_prompt', { sessionId: 's5', sessionName: 'w5' });
    const dialog = s.discordBridge.notify.mock.calls[1][0];
    expect(dialog.fullText).toBeUndefined();
    expect(dialog.tail()).toBe('screen\n❯\n  status');
  });

  it.each(['claude', 'codex', 'opencode', 'gemini', 'antigravity', 'pi', 'grok', 'deepseek', 'omp', 'copilot'])(
    'a finished turn in a %s tab posts the whole last message',
    async (mode) => {
      const s = server();
      s.sessions.set('s6', { muxName: 'codeman-s6', textOutput: '', mode });
      s.lastResponseFor = vi.fn(async () => ({ text: '1. First?\n2. Second?\n3. Third?' }));
      s.mux = { capturePaneText: () => 'screen' };
      await s.sendPushNotifications('hook:idle_prompt', { sessionId: 's6', sessionName: 'w6' });
      const msg = s.discordBridge.notify.mock.calls[0][0];
      expect((await msg.fullText()).text).toBe('1. First?\n2. Second?\n3. Third?');
    }
  );

  it('a shell tab has no turns, so it keeps the screen tail', async () => {
    const s = server();
    s.sessions.set('s7', { muxName: 'codeman-s7', textOutput: '', mode: 'shell' });
    s.lastResponseFor = vi.fn(async () => ({ text: 'x' }));
    s.mux = { capturePaneText: () => 'prompt$' };
    await s.sendPushNotifications('hook:idle_prompt', { sessionId: 's7', sessionName: 'w7' });
    const msg = s.discordBridge.notify.mock.calls[0][0];
    expect(await msg.fullText()).toBeUndefined();
    expect(msg.tail()).toBe('prompt$');
  });

  it('falls back to plain text output when there is no tmux pane, and to no tail for an unknown session', async () => {
    const s = server();
    s.sessions.set('s2', { muxName: null, textOutput: 'plain answer\n', mode: 'claude' });
    await s.sendPushNotifications('hook:idle_prompt', { sessionId: 's2', sessionName: 'w2' });
    expect(s.discordBridge.notify.mock.calls[0][0].tail()).toBe('plain answer');
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
  });

  it('does not touch the thread on session:deleted, which a detach also fires', () => {
    const s = server();
    s.broadcast(SseEvent.SessionDeleted, { id: 's1' });
    expect(s.discordBridge.sessionDeleted).not.toHaveBeenCalled();
  });

  it('tells the bridge about a real delete (killMux true) but not a detach (killMux false)', async () => {
    const s = server();
    await s.cleanupSession('gone', false);
    expect(s.discordBridge.sessionDeleted).not.toHaveBeenCalled();
    await s.cleanupSession('gone', true);
    expect(s.discordBridge.sessionDeleted).toHaveBeenCalledWith('gone');
  });

  it('a discarded half-built session clears the per-tab state but keeps its thread', async () => {
    const s = server();
    s.sessions.set('rebuild', {
      owner: 'u',
      ralphTracker: { stopWatchingFixPlan: () => undefined, fullReset: () => undefined },
      removeAllListeners: () => undefined,
      stop: async () => undefined,
    });
    await s.discardPartiallyBuiltSession('rebuild');
    expect(s.discordBridge.forgetTab).toHaveBeenCalledWith('rebuild');
    expect(s.discordBridge.sessionDeleted).not.toHaveBeenCalled();
  });

  it('ignores an event with no session id', () => {
    const s = server();
    s.broadcast(SseEvent.SessionUpdated, {});
    expect(s.discordBridge.sessionRenamed).not.toHaveBeenCalled();
  });

  it('allows the typed hint only for a local external CLI: not Claude, a shell, a remote or a Docker tab', () => {
    const s = server();
    s.sessions.set('cx', { mode: 'codex' });
    s.sessions.set('cl', { mode: 'claude' });
    s.sessions.set('sh', { mode: 'shell' });
    s.sessions.set('rm', { mode: 'codex', remote: { label: 'box' } });
    s.sessions.set('dk', { mode: 'codex', docker: { image: 'x' } });
    for (const id of ['cx', 'cl', 'sh', 'rm', 'dk', 'missing']) s.broadcast(SseEvent.SessionIdle, { id });
    expect(s.discordBridge.sessionIdle.mock.calls).toEqual([
      ['cx', true],
      ['cl', false],
      ['sh', false],
      ['rm', false],
      ['dk', false],
      ['missing', false],
    ]);
  });

  it('closes the bridge when the server stops', async () => {
    const s = server();
    await (s as unknown as { stop: () => Promise<void> }).stop();
    expect(s.discordBridge.stop).toHaveBeenCalledTimes(1);
  });
});
