import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { DiscordBridge, DEFAULT_DISCORD_CONFIG, MAX_REPLY_CHARS, writeDiscordConfig } from '../src/discord-bridge.js';

describe('structured input transport', () => {
  it.each(['claude', 'codex'] as const)('forwards the whitespace flag to the %s multiplexer', async (mode) => {
    const session = new Session({ workingDir: '/tmp', mode });
    const sendInput = vi.fn(async () => true);
    const internals = session as any;
    internals._mux = { sendInput };
    internals._muxSession = { muxName: 'codeman-structured-test' };
    try {
      const text = '\n  **Review**\n\n    code\n\n\r';
      expect(await session.writeViaMux(text, { fromUser: true, preserveWhitespace: true })).toBe(true);
      expect(sendInput).toHaveBeenCalledWith(session.id, text, { preserveWhitespace: true });
    } finally {
      internals._submitVerifier?.cancel();
      internals._mux = undefined;
      internals._muxSession = undefined;
    }
  });

  it('refuses unbracketed multiline input on a direct PTY instead of submitting separate lines', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    const write = vi.fn();
    (session as any).ptyProcess = { write };
    expect(await session.writeViaMux('one\ntwo\r', { preserveWhitespace: true })).toBe(false);
    expect(write).not.toHaveBeenCalled();
    (session as any).ptyProcess = null;
  });

  it('routes a formatted Discord message once and explicitly refuses oversize input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-structured-'));
    const sendInput = vi.fn(async () => true);
    const posts: string[] = [];
    const guild = '111111111111111111';
    const channel = '444444444444444444';
    const user = '333333333333333333';
    const bridge = new DiscordBridge({
      configDir: dir,
      sendInput,
      fetchImpl: async (url, init) => {
        if (url.pathname.endsWith('/messages')) posts.push(JSON.parse(String(init.body)).content);
        return Response.json({ id: channel });
      },
      socketFactory: () => ({ send() {}, close() {}, on() {} }),
    });
    try {
      await writeDiscordConfig(dir, {
        ...DEFAULT_DISCORD_CONFIG,
        enabled: true,
        token: 'test-only',
        guildId: guild,
        parentChannelId: '222222222222222222',
        allowedUserIds: [user],
      });
      await bridge.notify({ event: 'test', title: 'test', body: 'test', urgency: 'critical', sessionId: 's1' });
      const text = '\n  **Review**\n\n  - one\n  - two\n\n';
      await bridge.onGatewayMessage({
        id: '555555555555555555',
        guild_id: guild,
        channel_id: channel,
        author: { id: user },
        content: text,
      });
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('s1', text + '\r');
      await bridge.onGatewayMessage({
        id: '555555555555555556',
        guild_id: guild,
        channel_id: channel,
        author: { id: user },
        content: 'x'.repeat(MAX_REPLY_CHARS + 1),
      });
      expect(sendInput).toHaveBeenCalledTimes(1);
      expect(posts.some((p) => /Nothing was typed; shorten it/.test(p))).toBe(true);
      expect((await bridge.recentDeliveries()).some((r) => r.reason === 'input_too_large')).toBe(true);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
