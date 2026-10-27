/**
 * @fileoverview Input that lands while a guarded submit holds the input lease is held
 * and applied in arrival order once the lease is released, never refused and lost.
 *
 * Shaped like the review repro: a real `Session`, a mux that runs `beforeDispatch` and
 * then awaits the Enter the way `TmuxManager.sendInput` does, and the real WebSocket
 * route driven through a fake socket. The browser's WebSocket path does not wait for
 * ACKs, so the client model below sends every frame at once and redelivers whatever
 * is still unACKed afterwards, in seq order, the way `_redeliverSweep` does.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { formatPaneSnapshot } from '../src/tmux-manager.js';
import { GuardedInputBusyError, Session } from '../src/session.js';
import { registerWsRoutes } from '../src/web/routes/ws-routes.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';

type Frame = { t: 'i'; d: string; seq?: number; cid?: string };

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }
  ping(): void {}
  terminate(): void {
    this.readyState = 3;
  }
  frame(msg: Frame): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
  acks(): number[] {
    return this.sent.filter((m) => m.t === 'ia').map((m) => m.seq as number);
  }
}

interface Harness {
  session: Session;
  pty: string[];
  /** Resolve the in-flight Enter (true = tmux accepted it, false = it failed). */
  finishEnter(ok?: boolean | Error): void;
  enterDispatched(): boolean;
  connect(cid: string): FakeSocket;
  stop(): Promise<void>;
}

const sockets: FakeSocket[] = [];

function harness(awaitBeforeGuard = false): Harness {
  const pty: string[] = [];
  let finish: ((ok: boolean | Error) => void) | undefined;
  let dispatched = false;
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: (
      _name: string,
      _pane?: string,
      opts?: { capturedGeometry?: { cols: number; rows: number } }
    ) => {
      if (opts) opts.capturedGeometry = { cols: 100, rows: 20 };
      return formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], {
        cols: 100,
        rows: 20,
        cursorX: 7,
        cursorY: 0,
      });
    },
    // Like TmuxManager.sendInput's Enter-only branch: the guard runs synchronously,
    // then the `send-keys Enter` child process is awaited with the lease still held.
    sendInput: async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
      if (options?.beforeDispatch && text !== '\r') return false;
      const settle = () =>
        new Promise<boolean | Error>((resolve) => {
          finish = resolve;
        });
      // A transport that awaits before its guard leaves a window in which held
      // keystrokes must still invalidate the Enter.
      const early = awaitBeforeGuard ? await settle() : undefined;
      if (options?.beforeDispatch && !options.beforeDispatch()) return false;
      dispatched = true;
      const outcome = early ?? (await settle());
      if (outcome instanceof Error) throw outcome;
      if (outcome) pty.push(text);
      return outcome;
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  const access = session as unknown as { ptyProcess: { write(data: string): void } | null };
  access.ptyProcess = { write: (data: string) => pty.push(data) };

  let handler: ((socket: FakeSocket, req: unknown) => void) | undefined;
  const app = {
    get: (_path: string, _opts: unknown, h: (socket: FakeSocket, req: unknown) => void) => {
      handler = h;
    },
  } as unknown as FastifyInstance;
  const ctx = { sessions: new Map([[session.id, session]]) } as unknown as SessionPort;
  registerWsRoutes(app, ctx, () => ({ bindHost: '127.0.0.1', allowedHosts: [] }));

  return {
    session,
    pty,
    finishEnter: (ok = true) => finish!(ok),
    enterDispatched: () => dispatched,
    connect: (cid: string) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      handler!(socket, { headers: { host: 'localhost:3000' }, params: { id: session.id }, query: { cid } });
      return socket;
    },
    stop: async () => {
      access.ptyProcess = null;
      await session.stop(false);
    },
  };
}

/** Redeliver every still-unACKed frame in seq order, as the browser's sweep does. */
function redeliverUnacked(socket: FakeSocket, frames: Frame[]): void {
  const acked = new Set(socket.acks());
  for (const f of frames) if (f.seq !== undefined && !acked.has(f.seq)) socket.frame(f);
}

afterEach(() => {
  for (const s of sockets.splice(0)) s.emit('close', 1000, Buffer.from(''));
});

describe('input during a guarded submit lease', () => {
  it('delivers a keystroke that landed during the lease before the one typed after it (review repro)', async () => {
    const h = harness();
    try {
      const socket = h.connect('c1');
      const a: Frame = { t: 'i', d: 'a', seq: 1, cid: 'c1' };
      const b: Frame = { t: 'i', d: 'b', seq: 2, cid: 'c1' };
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      expect(h.enterDispatched()).toBe(true);
      expect(h.session.guardedSubmitInFlight).toBe(true);
      socket.frame(a);
      // Held, not refused: no ACK yet and nothing written while the lease is held.
      expect(socket.acks()).toEqual([]);
      expect(h.pty).toEqual([]);
      h.finishEnter(true);
      await expect(submit).resolves.toBe(true);
      socket.frame(b);
      redeliverUnacked(socket, [a, b]);
      expect(h.pty).toEqual(['\r', 'a', 'b']);
      expect(socket.acks()).toEqual([1, 2]);
      expect(socket.sent.filter((m) => m.dup)).toEqual([]);
    } finally {
      await h.stop();
    }
  });

  it('keeps arrival order for several frames during the lease and one after it', async () => {
    const h = harness();
    try {
      const socket = h.connect('c1');
      const frames: Frame[] = ['a', 'b', 'c', 'd'].map((d, i) => ({ t: 'i', d, seq: i + 1, cid: 'c1' }));
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      for (const f of frames.slice(0, 3)) socket.frame(f);
      expect(h.pty).toEqual([]);
      h.finishEnter(true);
      await submit;
      socket.frame(frames[3]);
      redeliverUnacked(socket, frames);
      expect(h.pty).toEqual(['\r', 'a', 'b', 'c', 'd']);
      expect(socket.acks()).toEqual([1, 2, 3, 4]);
    } finally {
      await h.stop();
    }
  });

  it('interleaves a second client by arrival, each with its own seq space', async () => {
    const h = harness();
    try {
      const one = h.connect('c1');
      const two = h.connect('c2');
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      one.frame({ t: 'i', d: 'a', seq: 1, cid: 'c1' });
      two.frame({ t: 'i', d: 'x', seq: 1, cid: 'c2' });
      one.frame({ t: 'i', d: 'b', seq: 2, cid: 'c1' });
      h.finishEnter(true);
      await submit;
      two.frame({ t: 'i', d: 'y', seq: 2, cid: 'c2' });
      expect(h.pty).toEqual(['\r', 'a', 'x', 'b', 'y']);
      expect(one.acks()).toEqual([1, 2]);
      expect(two.acks()).toEqual([1, 2]);
    } finally {
      await h.stop();
    }
  });

  it('flushes held input when the lease ends in failure, refused Enter or thrown', async () => {
    for (const outcome of [false, new Error('tmux send-keys failed')]) {
      const h = harness();
      try {
        const socket = h.connect('c1');
        const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
        await Promise.resolve();
        socket.frame({ t: 'i', d: 'a', seq: 1, cid: 'c1' });
        h.finishEnter(outcome);
        if (outcome instanceof Error) await expect(submit).rejects.toThrow('tmux send-keys failed');
        else await expect(submit).resolves.toBe(false);
        socket.frame({ t: 'i', d: 'b', seq: 2, cid: 'c1' });
        expect(h.pty).toEqual(['a', 'b']);
        expect(socket.acks()).toEqual([1, 2]);
        expect(h.session.guardedSubmitInFlight).toBe(false);
      } finally {
        await h.stop();
      }
    }
  });

  it('holds untagged frames too, which have no redelivery to fall back on', async () => {
    const h = harness();
    try {
      const socket = h.connect('c1');
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      socket.frame({ t: 'i', d: 'a' });
      h.finishEnter(true);
      await submit;
      socket.frame({ t: 'i', d: 'b' });
      expect(h.pty).toEqual(['\r', 'a', 'b']);
    } finally {
      await h.stop();
    }
  });

  it('a frame held for a socket that closed is still applied once; its redelivery is a duplicate', async () => {
    const h = harness();
    try {
      const first = h.connect('c1');
      const a: Frame = { t: 'i', d: 'a', seq: 1, cid: 'c1' };
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      first.frame(a);
      first.close();
      first.emit('close', 1006, Buffer.from(''));
      h.finishEnter(true);
      await submit;
      expect(first.sent).toEqual([]);
      const second = h.connect('c1');
      second.frame(a);
      second.frame({ t: 'i', d: 'b', seq: 2, cid: 'c1' });
      expect(h.pty).toEqual(['\r', 'a', 'b']);
      expect(second.sent.filter((m) => m.t === 'ia')).toEqual([
        { t: 'ia', seq: 1, dup: true, last: 1 },
        { t: 'ia', seq: 2 },
      ]);
    } finally {
      await h.stop();
    }
  });

  it('closes the socket instead of holding past the cap, and the reconnect resends in order', async () => {
    const h = harness();
    try {
      const socket = h.connect('c1');
      const cap = Session.MAX_GUARDED_HELD_INPUTS;
      const frames: Frame[] = Array.from({ length: cap + 3 }, (_, i) => ({
        t: 'i',
        d: `k${i}`,
        seq: i + 1,
        cid: 'c1',
      }));
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      for (const f of frames) socket.frame(f);
      // Frames past the cap are not held, not applied and not ACKed; the socket is
      // closed so the browser reconnects and resends everything still unACKed.
      expect(socket.closedWith).toBe(1013);
      h.finishEnter(true);
      await submit;
      expect(h.pty.length).toBe(1 + cap);
      expect(socket.acks()).toEqual([]);
      socket.emit('close', 1013, Buffer.from(''));
      const again = h.connect('c1');
      for (const f of frames) again.frame(f);
      expect(h.pty).toEqual(['\r', ...frames.map((f) => f.d)]);
      expect(again.acks()).toEqual(frames.map((f) => f.seq));
    } finally {
      await h.stop();
    }
  });

  it('holds managed writes and named keys behind the lease, and refuses them only when the hold queue is full', async () => {
    const h = harness();
    try {
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      const order: string[] = [];
      const key = h.session.performAuxiliaryInput(async () => {
        order.push('key');
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).toEqual([]);
      for (let i = 1; i < Session.MAX_GUARDED_HELD_INPUTS; i++) {
        expect(h.session.holdForGuardedLease(() => order.push('frame'))).toBe('held');
      }
      expect(h.session.holdForGuardedLease(() => order.push('lost'))).toBe('full');
      await expect(h.session.performAuxiliaryInput(async () => order.push('lost'))).rejects.toBeInstanceOf(
        GuardedInputBusyError
      );
      await expect(h.session.writeViaMux('lost')).resolves.toBe(false);
      h.finishEnter(true);
      await submit;
      await key;
      expect(order[0]).toBe('key');
      expect(order.filter((o) => o === 'frame')).toHaveLength(Session.MAX_GUARDED_HELD_INPUTS - 1);
      expect(order).not.toContain('lost');
    } finally {
      await h.stop();
    }
  });

  it('caps held bytes as well as held frames', async () => {
    const h = harness();
    try {
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      expect(h.session.holdForGuardedLease(() => {}, Session.MAX_GUARDED_HELD_BYTES)).toBe('held');
      expect(h.session.holdForGuardedLease(() => {}, 1)).toBe('full');
      h.finishEnter(true);
      await submit;
      expect(h.session.holdForGuardedLease(() => {}, Session.MAX_GUARDED_HELD_BYTES + 1)).toBe('free');
    } finally {
      await h.stop();
    }
  });

  it('a frame arriving while a held named key is still being sent waits for it', async () => {
    const h = harness();
    try {
      const socket = h.connect('c1');
      let keySent!: () => void;
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      const key = h.session.performAuxiliaryInput(async () => {
        await new Promise<void>((resolve) => {
          keySent = resolve;
        });
        h.pty.push('<newline>');
      });
      socket.frame({ t: 'i', d: 'a', seq: 1, cid: 'c1' });
      h.finishEnter(true);
      await submit;
      // The lease is over, but the held key is still in flight: input stays held.
      expect(h.session.guardedSubmitInFlight).toBe(false);
      expect(h.session.guardedInputHeld).toBe(true);
      socket.frame({ t: 'i', d: 'b', seq: 2, cid: 'c1' });
      expect(h.pty).toEqual(['\r']);
      keySent();
      await key;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.pty).toEqual(['\r', '<newline>', 'a', 'b']);
      expect(socket.acks()).toEqual([1, 2]);
      expect(h.session.guardedInputHeld).toBe(false);
    } finally {
      await h.stop();
    }
  });

  it('holds an untagged raw POST .../input during the lease and writes it after the Enter', async () => {
    const h = harness();
    const route = await createRouteTestHarness(registerSessionRoutes);
    try {
      (route.ctx.sessions as unknown as Map<string, Session>).set(h.session.id, h.session);
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      expect(h.session.guardedSubmitInFlight).toBe(true);
      // The Stop button's Ctrl+C: an untagged POST whose answer nobody reads.
      const res = await route.app.inject({
        method: 'POST',
        url: `/api/sessions/${h.session.id}/input`,
        payload: { input: '\x03' },
      });
      expect(res.statusCode).toBe(200);
      expect(h.pty).toEqual([]);
      h.finishEnter(true);
      await expect(submit).resolves.toBe(true);
      expect(h.pty).toEqual(['\r', '\x03']);
    } finally {
      await route.app.close();
      await h.stop();
    }
  });

  it('a held untagged raw send-and-wait reports the held write as delivered', async () => {
    const h = harness();
    const route = await createRouteTestHarness(registerSessionRoutes);
    try {
      (route.ctx.sessions as unknown as Map<string, Session>).set(h.session.id, h.session);
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      const answer = route.app.inject({
        method: 'POST',
        url: `/api/sessions/${h.session.id}/input`,
        payload: { input: '\x03', useMux: false, wait: 'exit', waitTimeout: 1000 },
      });
      // Private, but the only proof the route reached the hold before the lease ends.
      const queue = (h.session as unknown as { _guardedHeld: unknown[] })._guardedHeld;
      await vi.waitFor(() => expect(queue).toHaveLength(1));
      expect(h.pty).toEqual([]);
      h.finishEnter(true);
      await submit;
      const res = await answer;
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ delivered: true, duplicate: false });
      expect(h.pty).toEqual(['\r', '\x03']);
    } finally {
      await route.app.close();
      await h.stop();
    }
  });

  it('a keystroke held before the guard runs still invalidates the Enter, then lands', async () => {
    const h = harness(true);
    try {
      const socket = h.connect('c1');
      const submit = h.session.submitGuardedInput(h.session.guardedInputSnapshot()!);
      await Promise.resolve();
      socket.frame({ t: 'i', d: 'a', seq: 1, cid: 'c1' });
      h.finishEnter(true);
      await expect(submit).resolves.toBe(false);
      expect(h.enterDispatched()).toBe(false);
      expect(h.pty).toEqual(['a']);
      expect(socket.acks()).toEqual([1]);
    } finally {
      await h.stop();
    }
  });
});
