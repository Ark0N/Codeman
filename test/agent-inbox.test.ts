/**
 * @fileoverview The agent inbox store (src/web/agent-inbox.ts), pure: no routes, no IO.
 *
 * Each block pins one rule from discussion #558: read until ack, seen only for the
 * receiver, byte and count caps that refuse instead of dropping, a TTL counted from
 * each message's own timestamp, and a snapshot that survives malformed input.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentInbox,
  MAX_INBOX_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_INBOX,
  MESSAGE_TTL_MS,
} from '../src/web/agent-inbox.js';

const RX = 'receiver-session';

describe('AgentInbox', () => {
  let now: number;
  let inbox: AgentInbox;

  beforeEach(() => {
    now = 1_000_000;
    inbox = new AgentInbox(() => now);
  });

  const post = (text: string, from: string | null = 'sender') => {
    const r = inbox.post(RX, from, text);
    if (!r.ok) throw new Error(`post refused: ${r.reason}`);
    return r.message;
  };

  describe('read until ack', () => {
    it('a read removes nothing; the same messages come back until acked', () => {
      const a = post('first');
      const b = post('second');
      expect(inbox.read(RX, { receiver: true }).messages.map((m) => m.id)).toEqual([a.id, b.id]);
      expect(inbox.read(RX, { receiver: true }).messages.map((m) => m.id)).toEqual([a.id, b.id]);
      expect(inbox.pendingCount(RX)).toBe(2);
      expect(inbox.ack(RX, [a.id])).toBe(1);
      expect(inbox.read(RX, { receiver: true }).messages.map((m) => m.id)).toEqual([b.id]);
    });

    it('ack is idempotent: an id that is already gone or never existed is not an error', () => {
      const a = post('x');
      expect(inbox.ack(RX, [a.id])).toBe(1);
      expect(inbox.ack(RX, [a.id])).toBe(0);
      expect(inbox.ack(RX, ['no-such-id'])).toBe(0);
      expect(inbox.ack('no-such-session', [a.id])).toBe(0);
    });

    it('ack removes only the given ids, never a message posted after the read', () => {
      const a = post('read me');
      inbox.read(RX, { receiver: true });
      const late = post('arrived after the read');
      inbox.ack(RX, [a.id]);
      expect(inbox.read(RX, { receiver: false }).messages.map((m) => m.id)).toEqual([late.id]);
    });

    it('keeps multi-line text byte for byte', () => {
      const text = 'line one\nline two\r\n\ttabbed\n';
      post(text);
      expect(inbox.read(RX, { receiver: true }).messages[0].text).toBe(text);
    });
  });

  describe('seen belongs to the receiver', () => {
    it('a receiver read marks seen; the flag on each message is the state BEFORE this read', () => {
      post('m');
      const first = inbox.read(RX, { receiver: true });
      expect(first.messages[0].seen).toBe(false);
      expect(first.unseen).toBe(0);
      const second = inbox.read(RX, { receiver: true });
      expect(second.messages[0].seen).toBe(true);
    });

    it('a peek changes nothing: unseen stays unseen', () => {
      post('m');
      const peek = inbox.read(RX, { receiver: false });
      expect(peek.messages[0].seen).toBe(false);
      expect(peek.unseen).toBe(1);
      expect(inbox.unseenCount(RX)).toBe(1);
      expect(inbox.summary().get(RX)).toMatchObject({ pending: 1, unseen: 1 });
    });

    it('a message posted after a receiver read is unseen again', () => {
      post('a');
      inbox.read(RX, { receiver: true });
      expect(inbox.unseenCount(RX)).toBe(0);
      post('b');
      expect(inbox.unseenCount(RX)).toBe(1);
    });
  });

  describe('caps refuse, never drop the oldest', () => {
    it(`refuses message ${MAX_MESSAGES_PER_INBOX + 1} and keeps the first one`, () => {
      const first = post('0');
      for (let i = 1; i < MAX_MESSAGES_PER_INBOX; i++) post(String(i));
      expect(inbox.post(RX, null, 'one too many')).toEqual({ ok: false, reason: 'inbox-full-count' });
      const ids = inbox.read(RX, { receiver: false }).messages.map((m) => m.id);
      expect(ids).toHaveLength(MAX_MESSAGES_PER_INBOX);
      expect(ids[0]).toBe(first.id);
    });

    it('counts the per-message cap in UTF-8 bytes, not characters', () => {
      // 'é' is 2 bytes: half the byte budget in characters already fills it.
      expect(inbox.post(RX, null, 'é'.repeat(MAX_MESSAGE_BYTES / 2)).ok).toBe(true);
      expect(inbox.post(RX, null, 'é'.repeat(MAX_MESSAGE_BYTES / 2 + 1))).toEqual({
        ok: false,
        reason: 'message-too-large',
      });
    });

    it('refuses a post that would cross the per-inbox byte cap', () => {
      const chunk = 'x'.repeat(MAX_MESSAGE_BYTES);
      const fit = Math.floor(MAX_INBOX_BYTES / MAX_MESSAGE_BYTES);
      for (let i = 0; i < fit; i++) post(chunk);
      expect(inbox.post(RX, null, 'x'.repeat(MAX_INBOX_BYTES - fit * MAX_MESSAGE_BYTES + 1))).toEqual({
        ok: false,
        reason: 'inbox-full-bytes',
      });
      expect(inbox.pendingCount(RX)).toBe(fit);
    });

    it('an ack makes room again', () => {
      const ids: string[] = [];
      for (let i = 0; i < MAX_MESSAGES_PER_INBOX; i++) ids.push(post(String(i)).id);
      inbox.ack(RX, [ids[0]]);
      expect(inbox.post(RX, null, 'now it fits').ok).toBe(true);
    });

    it('refuses empty text', () => {
      expect(inbox.post(RX, null, '')).toEqual({ ok: false, reason: 'empty' });
    });
  });

  describe('TTL from the message timestamp', () => {
    it('a message older than the TTL is gone, read or not', () => {
      post('old');
      now += MESSAGE_TTL_MS / 2;
      const fresh = post('fresh');
      now += MESSAGE_TTL_MS / 2 + 1;
      expect(inbox.read(RX, { receiver: false }).messages.map((m) => m.id)).toEqual([fresh.id]);
    });

    it('a restore keeps createdAt, so a restart does not restart the clock', () => {
      post('m');
      const snap = JSON.parse(JSON.stringify(inbox.snapshot()));
      now += MESSAGE_TTL_MS - 1000;
      const restarted = new AgentInbox(() => now);
      expect(restarted.restore(snap)).toBe(1);
      now += 1001;
      expect(restarted.pendingCount(RX)).toBe(0);
    });

    it('does not restore a message that expired while the server was down', () => {
      post('m');
      const snap = inbox.snapshot();
      now += MESSAGE_TTL_MS + 1;
      expect(new AgentInbox(() => now).restore(snap)).toBe(0);
    });

    it('sweeps an expired message that is not first (clock stepped back)', () => {
      const late = post('posted first, stamped later');
      now -= 1000; // the clock steps back
      const early = post('posted second, stamped earlier');
      now += MESSAGE_TTL_MS + 1000 - (late.createdAt - early.createdAt) / 2;
      // `early` is past the TTL, `late` is not, and `early` sits behind `late`.
      expect(inbox.read(RX, { receiver: false }).messages.map((m) => m.id)).toEqual([late.id]);
    });

    it('expiry fires onChange so the snapshot catches up', () => {
      post('m');
      let changes = 0;
      inbox.onChange = () => changes++;
      now += MESSAGE_TTL_MS + 1;
      inbox.summary();
      expect(changes).toBe(1);
    });
  });

  describe('summary', () => {
    it('reports counts and the oldest unseen time, never text', () => {
      const a = post('secret one');
      now += 10;
      post('secret two');
      inbox.read(RX, { receiver: true });
      now += 10;
      const c = post('secret three');
      const row = inbox.summary().get(RX);
      expect(row).toEqual({ pending: 3, unseen: 1, oldestUnseenAt: c.createdAt });
      expect(JSON.stringify(row)).not.toContain('secret');
      expect(a.createdAt).toBeLessThan(c.createdAt);
    });

    it('leaves out sessions with an empty inbox', () => {
      const a = post('m');
      inbox.ack(RX, [a.id]);
      expect(inbox.summary().has(RX)).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('drop discards the inbox and fires onChange', () => {
      post('m');
      let changes = 0;
      inbox.onChange = () => changes++;
      inbox.drop(RX);
      expect(inbox.pendingCount(RX)).toBe(0);
      expect(changes).toBe(1);
    });

    it('pruneExcept drops only inboxes of sessions not kept', () => {
      inbox.post('keep-me', null, 'a');
      inbox.post('gone', null, 'b');
      expect(inbox.pruneExcept(['keep-me'])).toBe(1);
      expect(inbox.pendingCount('keep-me')).toBe(1);
      expect(inbox.pendingCount('gone')).toBe(0);
    });
  });

  describe('snapshot / restore', () => {
    it('round-trips messages, senders and the seen state', () => {
      const a = post('from a session', 'sender-1');
      post('from the user', null);
      inbox.read(RX, { receiver: true });
      const c = post('unseen');
      const restored = new AgentInbox(() => now);
      expect(restored.restore(JSON.parse(JSON.stringify(inbox.snapshot())))).toBe(3);
      const read = restored.read(RX, { receiver: false });
      expect(read.messages.map((m) => [m.id, m.from, m.seen])).toEqual([
        [a.id, 'sender-1', true],
        [expect.any(String), null, true],
        [c.id, 'sender', false],
      ]);
    });

    it('skips malformed entries and files instead of throwing', () => {
      const restored = new AgentInbox(() => now);
      expect(restored.restore(null)).toBe(0);
      expect(restored.restore({ version: 2, inboxes: {} })).toBe(0);
      expect(restored.restore({ version: 1, inboxes: { s: 'nope' } })).toBe(0);
      const good = { id: 'g', from: null, text: 'ok', createdAt: now, seenAt: null };
      expect(
        restored.restore({
          version: 1,
          inboxes: {
            s: [
              good,
              { id: 1 },
              { ...good, id: 'big', text: 'x'.repeat(MAX_MESSAGE_BYTES + 1) },
              { ...good, text: '' },
            ],
          },
        })
      ).toBe(1);
    });

    it('restores oldest first whatever the file order, so the caps keep the oldest', () => {
      const msg = (id: string, createdAt: number) => ({ id, from: null, text: 'x', createdAt, seenAt: null });
      const restored = new AgentInbox(() => now);
      restored.restore({ version: 1, inboxes: { s: [msg('new', now - 10), msg('old', now - 20)] } });
      expect(restored.read('s', { receiver: false }).messages.map((m) => m.id)).toEqual(['old', 'new']);
    });

    it('holds the count cap on restore', () => {
      const many = Array.from({ length: MAX_MESSAGES_PER_INBOX + 5 }, (_, i) => ({
        id: `m${i}`,
        from: null,
        text: 'x',
        createdAt: now,
        seenAt: null,
      }));
      const restored = new AgentInbox(() => now);
      expect(restored.restore({ version: 1, inboxes: { s: many } })).toBe(MAX_MESSAGES_PER_INBOX);
    });
  });
});
