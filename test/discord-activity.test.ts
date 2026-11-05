import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordActivity, discordActivityName, type DiscordActivitySession } from '../src/discord-activity.js';
import { DiscordApi } from '../src/discord-bridge.js';

let now: number;
let scope: string | undefined;
let sessions: DiscordActivitySession[];
let destination: string | undefined;
let verify: ReturnType<typeof vi.fn>;
let rename: ReturnType<typeof vi.fn>;
let typing: ReturnType<typeof vi.fn>;
let activity: DiscordActivity;
beforeEach(() => {
  now = 1_000;
  scope = 'guild/category';
  destination = 'thread';
  sessions = [{ id: 's1', name: 'hs-lab', working: true }];
  verify = vi.fn(async () => true);
  rename = vi.fn(async () => undefined);
  typing = vi.fn(async () => undefined);
  activity = new DiscordActivity({
    scope: () => scope,
    sessions: () => sessions,
    destination: () => destination,
    verify,
    rename,
    typing,
    now: () => now,
  });
});

describe('Discord live activity', () => {
  it('shows working, renews typing while work continues, and avoids repeated renames', async () => {
    await activity.poll();
    expect(rename).toHaveBeenCalledWith('thread', '🟡 Working · hs-lab', expect.any(Function));
    expect(typing).toHaveBeenCalledTimes(1);
    now += 4_000;
    await activity.poll();
    expect(typing).toHaveBeenCalledTimes(1);
    now += 4_000;
    await activity.poll();
    expect(typing).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenCalledTimes(1);
  });
  it('shows questions and exit promptly, stops typing, and delays only settling to Idle', async () => {
    await activity.poll();
    sessions[0].waiting = true;
    now += 8_000;
    await activity.poll();
    expect(typing).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenLastCalledWith('thread', '🔴 Needs input · hs-lab', expect.any(Function));
    sessions[0] = { id: 's1', name: 'hs-lab', working: false };
    now += 30_000;
    await activity.poll();
    expect(rename).toHaveBeenLastCalledWith('thread', '🔴 Needs input · hs-lab', expect.any(Function));
    now += 30_000;
    await activity.poll();
    expect(rename).toHaveBeenLastCalledWith('thread', '🟢 Idle · hs-lab', expect.any(Function));
    sessions[0].exited = true;
    now += 30_000;
    await activity.poll();
    expect(rename).toHaveBeenLastCalledWith('thread', '⚫ Offline · hs-lab', expect.any(Function));
    expect(typing).toHaveBeenCalledTimes(1);
  });
  it('does not create destinations, reopen archives or bypass ownership refusals', async () => {
    destination = undefined;
    await activity.poll();
    expect(verify).not.toHaveBeenCalled();
    destination = 'thread';
    verify.mockResolvedValue(false);
    await activity.poll();
    expect(rename).not.toHaveBeenCalled();
    expect(typing).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'moved', 'deleted', 'reset', 'forgotten'] as const)(
    'abandons in-flight ownership verification when %s',
    async (change) => {
      let release!: () => void;
      verify.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(true);
          })
      );
      const run = activity.poll();
      if (change === 'disabled') scope = undefined;
      if (change === 'moved') destination = 'another-thread';
      if (change === 'deleted') sessions = [];
      if (change === 'reset') activity.reset();
      if (change === 'forgotten') activity.forget('s1');
      release();
      await run;
      expect(rename).not.toHaveBeenCalled();
      expect(typing).not.toHaveBeenCalled();
    }
  );
  it('checks the current state after verification so an arriving question stops typing', async () => {
    verify.mockImplementationOnce(async () => {
      sessions[0].waiting = true;
      return true;
    });
    await activity.poll();
    expect(rename).toHaveBeenCalledWith('thread', '🔴 Needs input · hs-lab', expect.any(Function));
    expect(typing).not.toHaveBeenCalled();
  });
  it('coalesces overlapping polls, contains REST failures and retries with backoff', async () => {
    rename.mockRejectedValueOnce(new Error('rate limited'));
    await Promise.all([activity.poll(), activity.poll(), activity.poll()]);
    expect(rename).toHaveBeenCalledTimes(1);
    now += 4_000;
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(1);
    now += 30_000;
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(2);
    expect(typing).toHaveBeenCalledTimes(2);
  });
  it('does not spend a rename on an already-correct title and shows a new short turn promptly', async () => {
    sessions[0].working = false;
    verify.mockResolvedValue({ name: '🟢 Idle · hs-lab' });
    await activity.poll();
    expect(rename).not.toHaveBeenCalled();
    now += 4_000;
    sessions[0].working = true;
    await activity.poll();
    expect(rename).toHaveBeenCalledWith('thread', '🟡 Working · hs-lab', expect.any(Function));
    expect(typing).toHaveBeenCalledTimes(1);
  });
  it('delays Idle between short turns rather than spending the title budget on a brief gap', async () => {
    await activity.poll();
    sessions[0].working = false;
    now += 4_000;
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(1);
    sessions[0].working = true;
    now += 4_000;
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(typing).toHaveBeenCalledTimes(2);
  });
  it('reconciles a stale Idle title written after our successful Working rename', async () => {
    await activity.poll();
    verify.mockResolvedValue({ name: '🟢 Idle · hs-lab' });
    now += 8_000;
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenLastCalledWith('thread', '🟡 Working · hs-lab', expect.any(Function));
  });
  it('keeps typing through a long rename rate limit and honors the actual retry-after', async () => {
    rename.mockRejectedValueOnce(Object.assign(new Error('limited'), { retryAfterMs: 120_000 }));
    await activity.poll();
    expect(typing).toHaveBeenCalledTimes(1);
    now += 8_000;
    await activity.poll();
    expect(typing).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenCalledTimes(1);
    now += 111_000;
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(1);
    now += 1_000;
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(2);
  });
  it('keeps title updates independent of typing endpoint failures', async () => {
    typing.mockRejectedValueOnce(Object.assign(new Error('typing limited'), { retryAfterMs: 60_000 }));
    await activity.poll();
    expect(rename).toHaveBeenCalledWith('thread', '🟡 Working · hs-lab', expect.any(Function));
    now += 8_000;
    sessions[0].waiting = true;
    await activity.poll();
    expect(rename).toHaveBeenLastCalledWith('thread', '🔴 Needs input · hs-lab', expect.any(Function));
    expect(typing).toHaveBeenCalledTimes(1);
  });
  it('measures retry-after from the response rather than an earlier slow ownership check', async () => {
    rename.mockImplementationOnce(async () => {
      now += 20_000;
      throw Object.assign(new Error('limited'), { retryAfterMs: 120_000 });
    });
    await activity.poll();
    now += 119_000;
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(1);
    now += 1_000;
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(2);
  });
  it('reconciles an externally stale title even while Idle', async () => {
    sessions[0].working = false;
    verify.mockResolvedValue({ name: '🟢 Idle · hs-lab' });
    await activity.poll();
    verify.mockResolvedValue({ name: '🟡 Working · hs-lab' });
    now += 30_000;
    await activity.poll();
    expect(rename).toHaveBeenCalledWith('thread', '🟢 Idle · hs-lab', expect.any(Function));
  });
  it('refreshes the destination after a scope change, forget and restart', async () => {
    await activity.poll();
    scope = 'new-guild/category';
    destination = 'new-thread';
    await activity.poll();
    expect(rename).toHaveBeenLastCalledWith('new-thread', '🟡 Working · hs-lab', expect.any(Function));
    activity.forget('s1');
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(3);
    activity.reset();
    await activity.poll();
    expect(rename).toHaveBeenCalledTimes(4);
  });
  it('keeps published titles stable until the next coalesced update', async () => {
    await activity.poll();
    sessions[0].waiting = true;
    expect(activity.name(sessions[0])).toBe('🟡 Working · hs-lab');
    now += 30_000;
    await activity.poll();
    expect(activity.name(sessions[0])).toBe('🔴 Needs input · hs-lab');
  });
  it.each(['typing', 'rename'] as const)(
    'defers a rate-limited cosmetic %s without holding the activity sweep',
    async (method) => {
      const fetch = vi.fn(async () => Response.json({ retry_after: 1 }, { status: 429 }));
      const api = new DiscordApi(
        () => 'test-token',
        fetch,
        async () => {
          scope = undefined;
        }
      );
      const request =
        method === 'typing'
          ? api.typing('thread', () => !!scope)
          : api.rename('thread', '🟡 Working · hs-lab', () => !!scope);
      await expect(request).rejects.toMatchObject({ status: 429, retryAfterMs: 1000 });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(scope).toBe('guild/category');
    }
  );
  it('retains a long Discord Retry-After header for the caller instead of retrying early', async () => {
    const fetch = vi.fn(async () => Response.json({}, { status: 429, headers: { 'retry-after': '123.5' } }));
    const sleep = vi.fn(async () => undefined);
    const api = new DiscordApi(() => 'test-token', fetch, sleep);
    await expect(api.request('GET', '/channels/thread')).rejects.toMatchObject({ status: 429, retryAfterMs: 123_500 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('caps names at Discord limits and gives waiting/offline priority over busy', () => {
    expect(discordActivityName({ id: 's', working: true, waiting: true })).toContain('Needs input');
    expect(discordActivityName({ id: 's', working: true, waiting: true, exited: true })).toContain('Offline');
    expect(discordActivityName({ id: 'abcdefgh-ijkl', name: 'a'.repeat(200) })).toHaveLength(100);
    expect(discordActivityName({ id: 'abcdefgh-ijkl', name: ' \n ' })).toBe('🟢 Idle · abcdefgh');
  });
});
