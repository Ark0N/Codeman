/**
 * @fileoverview Agent inbox: a per-session mailbox other agents (or the user) post to,
 * and the receiving agent reads when it chooses to.
 *
 * The other agent-to-agent channel, `POST /api/sessions/:id/input`, types into the
 * receiver's composer. That is right for a prompt and wrong for a message: every
 * delivery starts or interrupts a turn, the receiver cannot defer it, and it is one
 * line only. The inbox stores instead of typing. Nothing here ever reaches a pane.
 *
 * Invariants (each pinned in `test/agent-inbox.test.ts`):
 * - **Read until ack.** A read hands out every pending message and removes nothing.
 *   A message goes only when the receiver acknowledges its id. "Read and dropped"
 *   and "done" must not look the same to the sender (discussion #558, the 09-23 case).
 * - **Seen is the receiver's alone.** `read(…, { receiver: true })` marks what it
 *   handed out as seen; any other read is a peek and changes nothing. The route
 *   decides who the receiver is; this module only takes the flag.
 * - **Bounded, and full refuses.** `MAX_MESSAGES_PER_INBOX`, `MAX_MESSAGE_BYTES` and
 *   `MAX_INBOX_BYTES`. A post that would cross any of them is refused so the sender
 *   learns. The oldest message is never dropped to make room.
 * - **TTL from the message's own timestamp** (`MESSAGE_TTL_MS`). A restore keeps
 *   `createdAt`, so a restart does not restart the clock. Expiry is lazy: every
 *   accessor sweeps the inbox it touches, `summary()` and `snapshot()` sweep all.
 * - **No IO, no `Session` import.** Persistence (`agent-inbox-persistence.ts`) hooks
 *   `onChange`; long-poll waiters live in `session-wait-registry.ts`.
 *
 * @consumedby web/routes/inbox-routes, web/agent-inbox-persistence, web/server
 * @module web/agent-inbox
 */

import { randomUUID } from 'node:crypto';

// ─── Bounds ──────────────────────────────────────────────────────────────────

/** Messages one inbox holds before posts are refused. */
export const MAX_MESSAGES_PER_INBOX = 200;
/** UTF-8 bytes per message. A bigger payload belongs in the workspace; post its path. */
export const MAX_MESSAGE_BYTES = 16_384;
/** UTF-8 bytes of message text one inbox holds before posts are refused. */
export const MAX_INBOX_BYTES = 512 * 1024;
/** A message older than this is gone, read or not (same span as the approvals inbox). */
export const MESSAGE_TTL_MS = 12 * 60 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────────────────────────

/** A message as it is stored (and persisted). */
interface StoredMessage {
  id: string;
  /** The posting session's full id, or null when no session could be resolved (the user). */
  from: string | null;
  text: string;
  /** Epoch ms. The TTL counts from here. */
  createdAt: number;
  /** Epoch ms of the first receiver read that handed this message out; null while unseen. */
  seenAt: number | null;
}

/** A message as a read hands it out. */
export interface InboxMessage {
  id: string;
  from: string | null;
  text: string;
  createdAt: number;
  /** True when a receiver read had handed this message out BEFORE this read. */
  seen: boolean;
}

export interface InboxReadResult {
  /** Every pending message, oldest first: unseen and seen-but-unacked alike. */
  messages: InboxMessage[];
  pending: number;
  /** Unseen after this read (0 after a receiver read; unchanged by a peek). */
  unseen: number;
}

export type PostResult =
  | { ok: true; message: InboxMessage; pending: number; unseen: number }
  | { ok: false; reason: 'empty' | 'message-too-large' | 'inbox-full-count' | 'inbox-full-bytes' };

/** What `summary()` reports for one session. Counts and times only, never text. */
export interface InboxCounts {
  pending: number;
  unseen: number;
  /** `createdAt` of the oldest unseen message, null when nothing is unseen. */
  oldestUnseenAt: number | null;
}

/** On-disk shape. `version` lets a later format refuse an older file instead of misreading it. */
export interface InboxSnapshot {
  version: 1;
  inboxes: Record<string, StoredMessage[]>;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class AgentInbox {
  private readonly inboxes = new Map<string, StoredMessage[]>();

  /** Any mutation (post, seen, ack, expiry, drop, prune, restore excluded). Persistence hooks this. */
  onChange: (() => void) | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Store a message for `sessionId`. `from` is the RESOLVED sender (the route's job),
   * never a client-supplied label.
   */
  post(sessionId: string, from: string | null, text: string): PostResult {
    if (text.length === 0) return { ok: false, reason: 'empty' };
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_MESSAGE_BYTES) return { ok: false, reason: 'message-too-large' };
    const queue = this.live(sessionId);
    if (queue.length >= MAX_MESSAGES_PER_INBOX) return { ok: false, reason: 'inbox-full-count' };
    if (inboxBytes(queue) + bytes > MAX_INBOX_BYTES) return { ok: false, reason: 'inbox-full-bytes' };
    const stored: StoredMessage = { id: randomUUID(), from, text, createdAt: this.now(), seenAt: null };
    queue.push(stored);
    this.inboxes.set(sessionId, queue);
    this.onChange?.();
    return { ok: true, message: view(stored), pending: queue.length, unseen: countUnseen(queue) };
  }

  /**
   * Every pending message, oldest first. Removes nothing. With `receiver`, the
   * messages handed out are marked seen (each keeps its first `seenAt`); without it
   * this is a peek and changes nothing at all.
   */
  read(sessionId: string, options: { receiver: boolean }): InboxReadResult {
    const queue = this.live(sessionId);
    const messages = queue.map(view);
    if (options.receiver) {
      let marked = false;
      const at = this.now();
      for (const m of queue) {
        if (m.seenAt !== null) continue;
        m.seenAt = at;
        marked = true;
      }
      if (marked) this.onChange?.();
    }
    return { messages, pending: queue.length, unseen: countUnseen(queue) };
  }

  /** Messages no receiver read has handed out yet. A `?wait=` read parks while this is 0. */
  unseenCount(sessionId: string): number {
    return countUnseen(this.live(sessionId));
  }

  pendingCount(sessionId: string): number {
    return this.live(sessionId).length;
  }

  /**
   * Remove the given messages. Idempotent: an id that is unknown or already gone is
   * not an error, so a retry after a lost response succeeds. Returns how many went.
   */
  ack(sessionId: string, ids: readonly string[]): number {
    const queue = this.live(sessionId);
    if (queue.length === 0 || ids.length === 0) return 0;
    const drop = new Set(ids);
    const kept = queue.filter((m) => !drop.has(m.id));
    const removed = queue.length - kept.length;
    if (removed === 0) return 0;
    this.store(sessionId, kept);
    this.onChange?.();
    return removed;
  }

  /** Per-session counts for every inbox that holds anything. Never blocks. */
  summary(): Map<string, InboxCounts> {
    const out = new Map<string, InboxCounts>();
    for (const sessionId of [...this.inboxes.keys()]) {
      const queue = this.live(sessionId);
      if (queue.length === 0) continue;
      const unseen = queue.filter((m) => m.seenAt === null);
      out.set(sessionId, {
        pending: queue.length,
        unseen: unseen.length,
        oldestUnseenAt: unseen.length > 0 ? unseen[0].createdAt : null,
      });
    }
    return out;
  }

  /** The session was DELETED: its mail goes with it. Not called on detach or shutdown. */
  drop(sessionId: string): void {
    if (this.inboxes.delete(sessionId)) this.onChange?.();
  }

  /**
   * Boot-time sweep, run only after the session restore succeeded: discard inboxes
   * whose session did not come back. Every route needs a live session, so an orphan
   * could otherwise never be removed. Returns how many inboxes were dropped.
   */
  pruneExcept(keep: Iterable<string>): number {
    const alive = new Set(keep);
    let dropped = 0;
    for (const sessionId of [...this.inboxes.keys()]) {
      if (alive.has(sessionId)) continue;
      this.inboxes.delete(sessionId);
      dropped++;
    }
    if (dropped > 0) this.onChange?.();
    return dropped;
  }

  /** Whole-store snapshot for persistence, expired messages already swept. */
  snapshot(): InboxSnapshot {
    const inboxes: Record<string, StoredMessage[]> = {};
    for (const sessionId of [...this.inboxes.keys()]) {
      const queue = this.live(sessionId);
      if (queue.length > 0) inboxes[sessionId] = queue.map((m) => ({ ...m }));
    }
    return { version: 1, inboxes };
  }

  /**
   * Replace the store from a snapshot (server boot). Malformed input is skipped entry
   * by entry rather than thrown: a corrupt file must not stop the server. Expired
   * messages are not restored, and the caps hold for what is. Does not fire
   * `onChange`: writing back what was just read would be a no-op at best.
   */
  restore(snapshot: unknown): number {
    const data = snapshot as Partial<InboxSnapshot> | null;
    this.inboxes.clear();
    if (!data || data.version !== 1 || typeof data.inboxes !== 'object' || data.inboxes === null) return 0;
    const cutoff = this.now() - MESSAGE_TTL_MS;
    let restored = 0;
    for (const [sessionId, raw] of Object.entries(data.inboxes)) {
      if (!Array.isArray(raw)) continue;
      const queue: StoredMessage[] = [];
      let bytes = 0;
      // Oldest first whatever order the file has, so the caps keep the oldest mail,
      // which is the rule for posts too.
      const entries = raw
        .filter((entry): entry is StoredMessage => isStoredMessage(entry) && entry.createdAt > cutoff)
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const entry of entries) {
        const size = Buffer.byteLength(entry.text, 'utf8');
        if (queue.length >= MAX_MESSAGES_PER_INBOX || bytes + size > MAX_INBOX_BYTES) break;
        queue.push({ ...entry });
        bytes += size;
      }
      if (queue.length === 0) continue;
      this.inboxes.set(sessionId, queue);
      restored += queue.length;
    }
    return restored;
  }

  /** Test hook: back to an empty store with no listener. */
  resetForTests(): void {
    this.inboxes.clear();
    this.onChange = undefined;
  }

  /** The inbox with expired messages swept out (fires `onChange` when it swept any). */
  private live(sessionId: string): StoredMessage[] {
    const queue = this.inboxes.get(sessionId);
    if (!queue) return [];
    const cutoff = this.now() - MESSAGE_TTL_MS;
    // Every message, not only queue[0]: a clock stepping back can put an older
    // createdAt behind a newer one. At most 200 entries, so the scan is cheap.
    if (!queue.some((m) => m.createdAt <= cutoff)) return queue;
    const kept = queue.filter((m) => m.createdAt > cutoff);
    this.store(sessionId, kept);
    this.onChange?.();
    return kept;
  }

  private store(sessionId: string, queue: StoredMessage[]): void {
    if (queue.length === 0) this.inboxes.delete(sessionId);
    else this.inboxes.set(sessionId, queue);
  }
}

function view(m: StoredMessage): InboxMessage {
  return { id: m.id, from: m.from, text: m.text, createdAt: m.createdAt, seen: m.seenAt !== null };
}

function countUnseen(queue: readonly StoredMessage[]): number {
  let n = 0;
  for (const m of queue) if (m.seenAt === null) n++;
  return n;
}

function inboxBytes(queue: readonly StoredMessage[]): number {
  let total = 0;
  for (const m of queue) total += Buffer.byteLength(m.text, 'utf8');
  return total;
}

function isStoredMessage(value: unknown): value is StoredMessage {
  const m = value as Partial<StoredMessage> | null;
  return (
    !!m &&
    typeof m.id === 'string' &&
    (m.from === null || typeof m.from === 'string') &&
    typeof m.text === 'string' &&
    m.text.length > 0 &&
    Buffer.byteLength(m.text, 'utf8') <= MAX_MESSAGE_BYTES &&
    typeof m.createdAt === 'number' &&
    Number.isFinite(m.createdAt) &&
    (m.seenAt === null || typeof m.seenAt === 'number')
  );
}

/** Process-wide store used by the routes and the server wiring. Tests construct their own. */
export const agentInbox = new AgentInbox();
