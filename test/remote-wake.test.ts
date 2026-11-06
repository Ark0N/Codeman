/**
 * @fileoverview Wake-on-LAN from user input (see `src/remote-wake.ts`).
 *
 * Covers the two things that are easy to get wrong and expensive when wrong:
 *  1. the decision/throttle table (probe at most once per window, never a probe
 *     burst per keystroke),
 *  2. the guarantee that a wake is SINGLE-FLIGHT and that buffered input is
 *     flushed IN ORDER once the pane is reattached — plus that no reconnect or
 *     boot-recovery module can reach the wake flow at all (a wake there would
 *     re-wake the host seconds after every suspend, so it could never sleep).
 *
 * Pure logic + a fake session/deps: no tmux, no ssh, no real host.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  RemoteWakeRegistry,
  appendBoundedPending,
  buildMagicPacket,
  createDefaultRemoteWakeDeps,
  decideRemoteInputAction,
  isProbeable,
  parseMacList,
  probeRemoteHostReachable,
  resolveWakeTarget,
  runRemoteWakeCommand,
  sendWakePackets,
  waitUntilRemoteReady,
  wakeConfigured,
  REMOTE_WAKE_PENDING_MAX_BYTES,
  REMOTE_WAKE_READY_INTERVAL_MS,
  REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS,
  type RemoteWakeDeps,
  type WakeableRemote,
  type WakeableSession,
} from '../src/remote-wake.js';
import { RemoteHostSchema } from '../src/web/schemas.js';
import { MAX_WAKE_MACS } from '../src/config/remote-wake-limits.js';

// ========== Pure decisions ==========

describe('decideRemoteInputAction', () => {
  const base = { hasWakeTarget: true, waking: false, probeAgeMs: 0, lastReachable: undefined as boolean | undefined };

  it('delivers unchanged when the host has no wake command (feature off)', () => {
    expect(decideRemoteInputAction({ ...base, hasWakeTarget: false, probeAgeMs: Number.MAX_SAFE_INTEGER })).toBe(
      'deliver'
    );
  });

  it('buffers while a wake is already in flight, whatever the probe state says', () => {
    expect(decideRemoteInputAction({ ...base, waking: true, probeAgeMs: Number.MAX_SAFE_INTEGER })).toBe('buffer');
  });

  it('buffers without re-probing when the last probe said the host is down', () => {
    // Re-probing per keystroke would add seconds of latency to every character.
    expect(decideRemoteInputAction({ ...base, lastReachable: false, probeAgeMs: 1 })).toBe('buffer');
  });

  it('delivers inside the throttle window when the host was reachable', () => {
    expect(decideRemoteInputAction({ ...base, lastReachable: true, probeAgeMs: 10 })).toBe('deliver');
  });

  it('probes once the throttle window has elapsed', () => {
    expect(decideRemoteInputAction({ ...base, lastReachable: true, probeAgeMs: 30_001 })).toBe('probe');
    expect(decideRemoteInputAction({ ...base, lastReachable: true, probeAgeMs: 29_999 })).toBe('deliver');
  });

  it('probes on the very first input of a session (probeAgeMs 0 is only "never probed")', () => {
    // probedAt is initialised to 0, so a fresh session's age is huge in real time.
    expect(decideRemoteInputAction({ ...base, probeAgeMs: Date.now() })).toBe('probe');
  });
});

describe('appendBoundedPending', () => {
  it('keeps everything under the cap, in order', () => {
    expect(appendBoundedPending(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('drops the OLDEST chunk when the cap is exceeded, keeping the tail', () => {
    const big = 'x'.repeat(REMOTE_WAKE_PENDING_MAX_BYTES);
    expect(appendBoundedPending([big], 'newest')).toEqual(['newest']);
  });

  it('drops an oversized chunk outright instead of delivering a fragment of it', () => {
    // One large paste is one input value and was never typed character by character, so its
    // tail is not "what the user just typed" — writing it into the pane would run a partial
    // command (with the paste's trailing carriage return, if it had one).
    const huge = 'y'.repeat(REMOTE_WAKE_PENDING_MAX_BYTES + 100);
    expect(appendBoundedPending([], huge)).toEqual([]);
    // The bytes already queued are left alone, not replaced by the fragment.
    expect(appendBoundedPending(['typed'], huge)).toEqual(['typed']);
  });

  it('measures the cap in UTF-8 bytes, so a multi-byte paste is dropped too', () => {
    const cap = 10;
    const value = 'ä'.repeat(8); // 2 bytes each → 16 bytes > cap
    expect(appendBoundedPending([], value, cap)).toEqual([]);
  });
});

describe('MAC parsing + magic packet', () => {
  it('parses one or more MACs with either separator', () => {
    expect(parseMacList('04:d9:f5:80:c6:58')).toEqual([[4, 217, 245, 128, 198, 88]]);
    expect(parseMacList('04-d9-f5-80-c6-58, 1c:61:b4:20:58:eb')).toEqual([
      [4, 217, 245, 128, 198, 88],
      [28, 97, 180, 32, 88, 235],
    ]);
  });

  it('is all-or-nothing so a typo cannot half-arm a host', () => {
    expect(parseMacList('04:d9:f5:80:c6')).toBeNull();
    expect(parseMacList('04:d9:f5:80:c6:58, nonsense')).toBeNull();
    expect(parseMacList('')).toBeNull();
    expect(
      parseMacList('04:d9:f5:80:c6:58,1c:61:b4:20:58:eb,aa:bb:cc:dd:ee:ff,11:22:33:44:55:66,99:88:77:66:55:44')
    ).toBeNull();
  });

  it('builds the documented magic packet byte-for-byte', () => {
    // 6 x 0xFF then the MAC repeated 16 times — a packet off by one byte simply never
    // wakes anything, so the shape is pinned rather than described.
    const mac = [4, 217, 245, 128, 198, 88];
    const packet = buildMagicPacket(mac);
    expect(packet.length).toBe(6 + 16 * 6);
    expect([...packet.subarray(0, 6)]).toEqual([255, 255, 255, 255, 255, 255]);
    for (let repeat = 0; repeat < 16; repeat++) {
      expect([...packet.subarray(6 + repeat * 6, 12 + repeat * 6)]).toEqual(mac);
    }
  });

  it('binds BEFORE enabling broadcast — the order that silently kills the packet on Linux', async () => {
    // `setBroadcast()` on an unbound socket throws EBADF on Linux and the follow-up
    // send dies with EACCES, so the magic packet never leaves the machine (verified
    // against a real sleeping host). The order is asserted, not described.
    const calls: string[] = [];
    const sent: { packet: Buffer; port: number; address: string }[] = [];
    const packets = await sendWakePackets(
      [
        [4, 217, 245, 128, 198, 88],
        [28, 97, 180, 32, 88, 235],
      ],
      9,
      () => ({
        bind: (cb: () => void) => {
          calls.push('bind');
          cb();
        },
        setBroadcast: () => calls.push('setBroadcast'),
        send: (packet: Buffer, port: number, address: string, cb: (err?: Error | null) => void) => {
          calls.push('send');
          sent.push({ packet, port, address });
          cb(null);
        },
        close: () => calls.push('close'),
        once: () => undefined,
      })
    );

    expect(packets).toBe(true);
    expect(calls[0]).toBe('bind');
    expect(calls[1]).toBe('setBroadcast');
    // One 102-byte magic packet per MAC, to the broadcast address on port 9.
    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.packet.length === 102 && s.port === 9 && s.address === '255.255.255.255')).toBe(true);
  });

  it('reports failure when the platform refuses to broadcast', async () => {
    const ok = await sendWakePackets([[4, 217, 245, 128, 198, 88]], 9, () => ({
      bind: (cb: () => void) => cb(),
      setBroadcast: () => {
        throw new Error('EBADF');
      },
      send: () => undefined,
      close: () => undefined,
      once: () => undefined,
    }));
    expect(ok).toBe(false);
  });

  it('resolves the wake target with the command as the explicit override', () => {
    const mac = '04:d9:f5:80:c6:58';
    expect(resolveWakeTarget(undefined)).toBeNull();
    expect(resolveWakeTarget({ hostId: 'h', label: 'H', host: '10.0.0.1' })).toBeNull();
    expect(resolveWakeTarget({ hostId: 'h', label: 'H', host: '10.0.0.1', wakeMac: mac })).toEqual({
      kind: 'mac',
      macs: [[4, 217, 245, 128, 198, 88]],
    });
    expect(
      resolveWakeTarget({ hostId: 'h', label: 'H', host: '10.0.0.1', wakeMac: mac, wakeCommand: '/bin/wake' })
    ).toEqual({ kind: 'command', command: '/bin/wake' });
    // A malformed MAC (hand-written config) must not arm a broken wake.
    expect(resolveWakeTarget({ hostId: 'h', label: 'H', host: '10.0.0.1', wakeMac: 'nope' })).toBeNull();
  });

  it('reports which wake path the UI should offer', () => {
    expect(wakeConfigured(undefined)).toBe('none');
    expect(wakeConfigured({ hostId: 'h', label: 'H', host: 'x' })).toBe('none');
    expect(wakeConfigured({ hostId: 'h', label: 'H', host: 'x', wakeMac: '04:d9:f5:80:c6:58' })).toBe('mac');
    expect(wakeConfigured({ hostId: 'h', label: 'H', host: 'x', wakeCommand: '/bin/wake' })).toBe('command');
  });
});

// ========== Registry ==========

const remote: WakeableRemote = {
  hostId: 'hufflepuff',
  label: 'Hufflepuff',
  host: '192.168.50.137',
  wakeCommand: '/home/joe/bin/whuff',
};

interface Harness {
  registry: RemoteWakeRegistry;
  session: WakeableSession;
  probe: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
  waitUntilReady: ReturnType<typeof vi.fn>;
  reattachRemote: ReturnType<typeof vi.fn>;
  writeViaMux: ReturnType<typeof vi.fn>;
  noteReconnected: ReturnType<typeof vi.fn>;
  events: string[];
  payloads: Array<{ event: string; payload: Record<string, unknown> }>;
}

function harness(
  opts: { remote?: WakeableRemote; writesFail?: boolean; resolveRemote?: RemoteWakeDeps['resolveRemote'] } = {}
): Harness {
  const probe = vi.fn(async () => false);
  const wake = vi.fn(async () => true);
  const waitUntilReady = vi.fn(async () => true);
  const reattachRemote = vi.fn(async () => true);
  const writeViaMux = vi.fn(async () => !opts.writesFail);
  const noteReconnected = vi.fn();
  const events: string[] = [];
  const payloads: Array<{ event: string; payload: Record<string, unknown> }> = [];

  const deps: RemoteWakeDeps = {
    probe,
    wake,
    waitUntilReady,
    delay: async () => {},
    noteReconnected,
    broadcast: (event, payload) => {
      events.push(event);
      payloads.push({ event, payload });
    },
    log: () => {},
    ...(opts.resolveRemote ? { resolveRemote: opts.resolveRemote } : {}),
  };

  const session: WakeableSession = {
    id: 'sess-1',
    remote: opts.remote ?? remote,
    reattachRemote,
    writeViaMux,
  };

  return {
    registry: new RemoteWakeRegistry(deps),
    session,
    probe,
    wake,
    waitUntilReady,
    reattachRemote,
    writeViaMux,
    noteReconnected,
    events,
    payloads,
  };
}

describe('RemoteWakeRegistry', () => {
  it('does nothing at all when the host has no wake command', async () => {
    const h = harness({ remote: { hostId: 'x', label: 'X', host: '10.0.0.9' } });
    await expect(h.registry.handleInput(h.session, 'a')).resolves.toBe('deliver');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('delivers normally when the host is reachable, without waking', async () => {
    const h = harness();
    h.probe.mockResolvedValue(true);
    await expect(h.registry.handleInput(h.session, 'a')).resolves.toBe('deliver');
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('skips the probe inside the throttle window once the host was reachable', async () => {
    const h = harness();
    h.probe.mockResolvedValue(true);
    await h.registry.handleInput(h.session, 'a');
    await h.registry.handleInput(h.session, 'b');
    await h.registry.handleInput(h.session, 'c');
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('wakes an unreachable host once, then flushes buffered input in order after reattach', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    // Hold the wake open so the second input lands while it is genuinely in flight
    // (with instantaneous mocks the whole wake chain can finish between two awaits).
    let releaseWake: (() => void) | undefined;
    h.waitUntilReady.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseWake = () => resolve(true);
        })
    );

    await expect(h.registry.handleInput(h.session, 'hal')).resolves.toBe('buffered');
    await expect(h.registry.handleInput(h.session, 'lo')).resolves.toBe('buffered');
    // Single-flight: the second input joins the in-flight wake, it does not start another.
    expect(h.registry.isWaking('sess-1')).toBe(true);
    expect(h.wake).toHaveBeenCalledTimes(1);

    releaseWake?.();
    await h.registry.wake(h.session);

    expect(h.wake).toHaveBeenCalledWith({ kind: 'command', command: '/home/joe/bin/whuff' });
    expect(h.reattachRemote).toHaveBeenCalledTimes(1);
    expect(h.noteReconnected).toHaveBeenCalledWith('sess-1', true);
    expect(h.writeViaMux.mock.calls.map((c) => c[0])).toEqual(['hal', 'lo']);
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
    expect(h.events).toEqual(['remote:hostWaking', 'remote:sessionReconnected']);
  });

  it('keeps input buffered and reports failure when the host never comes back', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    h.waitUntilReady.mockResolvedValue(false);

    await h.registry.handleInput(h.session, 'hello');
    await h.registry.wake(h.session);

    expect(h.reattachRemote).not.toHaveBeenCalled();
    expect(h.writeViaMux).not.toHaveBeenCalled();
    expect(h.registry.pendingBytes('sess-1')).toBe(5);
    expect(h.events).toContain('remote:hostWakeFailed');
  });

  it('retries the wake on the next input after a failed wake (probe state reset)', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    h.waitUntilReady.mockResolvedValueOnce(false);

    await h.registry.handleInput(h.session, 'a');
    await h.registry.wake(h.session);
    expect(h.wake).toHaveBeenCalledTimes(1);

    // Next keystroke must probe again (not trust the stale "down" verdict) and retry.
    await h.registry.handleInput(h.session, 'b');
    await h.registry.wake(h.session);
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect(h.wake).toHaveBeenCalledTimes(2);
    expect(h.writeViaMux.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('does not claim reconnected when the pane cannot be reattached', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    h.reattachRemote.mockResolvedValue(false);

    await h.registry.handleInput(h.session, 'a');
    await h.registry.wake(h.session);

    expect(h.noteReconnected).not.toHaveBeenCalled();
    expect(h.writeViaMux).not.toHaveBeenCalled();
    expect(h.events).not.toContain('remote:sessionReconnected');
  });

  it('reports an oversized chunk as dropped, and flushes as user input so the tab can be named', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    let release: (() => void) | undefined;
    h.waitUntilReady.mockImplementation(() => new Promise<boolean>((resolve) => (release = () => resolve(true))));
    await expect(h.registry.handleInput(h.session, 'ok')).resolves.toBe('buffered');
    // Over the cap: never enters the buffer, and the caller is told — a bare 200 could
    // not distinguish delivered from buffered from gone.
    await expect(h.registry.handleInput(h.session, 'x'.repeat(REMOTE_WAKE_PENDING_MAX_BYTES + 1))).resolves.toBe(
      'dropped'
    );
    expect(h.registry.pendingBytes('sess-1')).toBe(2);
    release?.();
    await h.registry.wake(h.session);
    // `fromUser`: a first prompt that was buffered through a wake may still name the tab.
    expect(h.writeViaMux).toHaveBeenCalledWith('ok', { fromUser: true });
  });

  it('drops the buffer when a flush write fails, so nothing is replayed by a later wake', async () => {
    // Retaining the chunk was the earlier behaviour, and it was worse: the wake still
    // resolves and marks the host reachable, so the next input takes the deliver path
    // while the retained chunk waits for the NEXT wake — replayed hours later, after
    // everything typed since. Same policy as the oversized paste: dropped, logged.
    const h = harness({ writesFail: true });
    h.probe.mockResolvedValue(false);

    await h.registry.handleInput(h.session, 'abc');
    await h.registry.handleInput(h.session, 'def');
    await h.registry.wake(h.session);

    expect(h.writeViaMux).toHaveBeenCalledTimes(1);
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
    // And the recovered host takes the deliver path from here, with nothing behind it.
    h.probe.mockClear();
    await expect(h.registry.handleInput(h.session, 'g')).resolves.toBe('deliver');
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
  });

  it('flushes the chunk it is writing out of the buffer first, so a concurrent enqueue cannot drop a different one', async () => {
    // Input arriving DURING the flush is enqueued (`waking` is still set), and the cap
    // then drops the OLDEST chunk — the one already on its way to the pane. Shifting the
    // buffer after the write removed the NEXT chunk instead, so the drop-oldest
    // bookkeeping lost a chunk that was never written.
    const h = harness();
    h.probe.mockResolvedValue(false);
    let release: (() => void) | undefined;
    h.waitUntilReady.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        })
    );

    const big = 'a'.repeat(REMOTE_WAKE_PENDING_MAX_BYTES - 10);
    await h.registry.handleInput(h.session, big);
    await h.registry.handleInput(h.session, 'bbbbbbbbbb'); // fills the cap exactly
    // The third chunk arrives while the FIRST write is in flight, which is what pushes
    // the buffer over the cap mid-flush.
    h.writeViaMux.mockImplementationOnce(async () => {
      await h.registry.handleInput(h.session, 'c');
      return true;
    });

    release?.();
    await h.registry.wake(h.session);

    expect(h.writeViaMux.mock.calls.map((c) => c[0])).toEqual([big, 'bbbbbbbbbb', 'c']);
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
  });

  it('ensureAwake blocks only for the wait path and returns true without a wake command', async () => {
    const h = harness({ remote: { hostId: 'x', label: 'X', host: '10.0.0.9' } });
    await expect(h.registry.ensureAwake(h.session)).resolves.toBe(true);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('ensureAwake wakes an unreachable host without buffering anything', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    await expect(h.registry.ensureAwake(h.session)).resolves.toBe(true);
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
  });

  it('wakes a MAC-configured host by magic packet, with no external command', async () => {
    const h = harness({
      remote: { hostId: 'h', label: 'H', host: '10.0.0.9', wakeMac: '04:d9:f5:80:c6:58' },
    });
    h.probe.mockResolvedValue(false);
    await expect(h.registry.handleInput(h.session, 'hi')).resolves.toBe('buffered');
    await h.registry.wake(h.session);
    expect(h.wake).toHaveBeenCalledWith({ kind: 'mac', macs: [[4, 217, 245, 128, 198, 88]] });
    expect(h.writeViaMux.mock.calls.map((c) => c[0])).toEqual(['hi']);
  });

  it('resolves host config for a session that predates it, so a saved MAC works live', async () => {
    // The persisted `remote` snapshot is taken at launch: without this the banner's
    // config dialog would only take effect after restarting the session.
    const resolveRemote = vi.fn(async () => ({
      hostId: 'hufflepuff',
      label: 'Hufflepuff',
      host: '192.168.50.137',
      wakeMac: '04:d9:f5:80:c6:58',
    }));
    const h = harness({
      remote: { hostId: 'hufflepuff', label: 'Hufflepuff', host: '192.168.50.137' },
      resolveRemote,
    });
    h.probe.mockResolvedValue(false);

    expect(await h.registry.hasWakeTarget(h.session)).toBe(true);
    await expect(h.registry.handleInput(h.session, 'a')).resolves.toBe('buffered');
    await h.registry.wake(h.session);
    expect(h.wake).toHaveBeenCalledWith({ kind: 'mac', macs: [[4, 217, 245, 128, 198, 88]] });
    expect(resolveRemote).toHaveBeenCalledTimes(1);

    // Cached: the next keystroke must not re-read the host config.
    await h.registry.hasWakeTarget(h.session);
    expect(resolveRemote).toHaveBeenCalledTimes(1);
  });

  it('consults the resolver on the TTL even when the session has a target', async () => {
    // The host config is authoritative in BOTH directions: a target removed in the config
    // (or the dialog) must turn the feature off for a live session, which it cannot do if
    // the session's own snapshot short-circuits the lookup.
    const resolveRemote = vi.fn(async () => ({
      hostId: 'hufflepuff',
      label: 'Hufflepuff',
      host: '192.168.50.137',
    }));
    const h = harness({
      remote: {
        hostId: 'hufflepuff',
        label: 'Hufflepuff',
        host: '192.168.50.137',
        wakeMac: '04:d9:f5:80:c6:58',
      },
      resolveRemote,
    });

    expect(await h.registry.hasWakeTarget(h.session)).toBe(false);
    expect(await h.registry.wakeConfigured(h.session)).toBe('none');
    // ... and with the feature off there is nothing to buffer for.
    expect(await h.registry.handleInput(h.session, 'x')).toBe('deliver');
    // Cached for the TTL — not one host-config read per keystroke.
    expect(resolveRemote).toHaveBeenCalledTimes(1);
    await h.registry.hasWakeTarget(h.session);
    expect(resolveRemote).toHaveBeenCalledTimes(1);
  });

  it('drops buffered input with the session', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    await h.registry.handleInput(h.session, 'abc');
    h.registry.drop('sess-1');
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
    expect(h.registry.isWaking('sess-1')).toBe(false);
  });

  it('never keys the state map on a local session', async () => {
    // `hasWakeTarget` runs on EVERY input chunk (it is the route's gate), so allocating
    // state before the `!session.remote` return would put an entry — and later a pending
    // buffer — in the map for every local session the user types in.
    const h = harness();
    const local: WakeableSession = {
      id: 'local-1',
      remote: undefined,
      reattachRemote: h.reattachRemote,
      writeViaMux: h.writeViaMux,
    };
    expect(await h.registry.hasWakeTarget(local)).toBe(false);
    expect(await h.registry.wakeConfigured(local)).toBe('none');
    expect(h.registry.stateCount()).toBe(0);
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('ensureAwake hands the caller’s budget to the readiness poll (the wake button’s case)', async () => {
    // The button is pressed from the same dashboard as Run/Attach, so it must not inherit
    // the 90 s session default and get cut off by the proxy's 60 s read timeout.
    const h = harness();
    h.probe.mockResolvedValue(false);
    await expect(
      h.registry.ensureAwake(h.session, { force: true, timeoutMs: REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS })
    ).resolves.toBe(true);
    expect(h.waitUntilReady).toHaveBeenCalledWith(remote, {
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal),
    });
    // Not asserted to the millisecond: the wake's own elapsed time is subtracted, so a
    // slow runner lands a few ms under the budget.
    const [, readyOpts] = h.waitUntilReady.mock.calls[0] as [unknown, { timeoutMs: number; signal: AbortSignal }];
    expect(readyOpts.timeoutMs).toBeLessThanOrEqual(REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS);
    expect(readyOpts.timeoutMs).toBeGreaterThan(REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS - 1_000);
  });
});

// ========== Host-scoped wake (session create/attach) ==========

describe('the MAC-count limit lives in one place', () => {
  // The schema's 128-character cap admits seven MACs while parseMacList takes at most
  // MAX_WAKE_MACS, all-or-nothing. They used to disagree, so a five-MAC wakeMac
  // validated, persisted to remote-hosts.json, and then resolved to NO wake target:
  // the host read as unconfigured and the banner offered "Configure WoL" for a host
  // the user had just set up.
  const mac = (n: number) => `04:d9:f5:80:c6:${n.toString(16).padStart(2, '0')}`;

  it('parses exactly MAX_WAKE_MACS', () => {
    const value = Array.from({ length: MAX_WAKE_MACS }, (_, i) => mac(i)).join(',');
    expect(parseMacList(value)).toHaveLength(MAX_WAKE_MACS);
    expect(
      RemoteHostSchema.safeParse({ id: 'h', label: 'H', host: '10.0.0.5', username: 'joe', wakeMac: value }).success
    ).toBe(true);
  });

  it('rejects one more in BOTH the schema and the parser, so neither can admit what the other drops', () => {
    const value = Array.from({ length: MAX_WAKE_MACS + 1 }, (_, i) => mac(i)).join(',');
    expect(parseMacList(value)).toBeNull();
    const parsed = RemoteHostSchema.safeParse({
      id: 'h',
      label: 'H',
      host: '10.0.0.5',
      username: 'joe',
      wakeMac: value,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('isProbeable', () => {
  const base: WakeableRemote = { hostId: 'h', label: 'H', host: '10.0.0.9', wakeMac: '04:d9:f5:80:c6:58' };

  it('is true for a host reached directly', () => {
    expect(isProbeable(base)).toBe(true);
    expect(isProbeable({ ...base, extraSshOptions: ['ServerAliveCountMax=3', 'StrictHostKeyChecking=no'] })).toBe(true);
  });

  it('is false behind a jump host, a SOCKS proxy, or a ProxyCommand/ProxyJump option', () => {
    expect(isProbeable({ ...base, jumpHost: 'bastion.example' })).toBe(false);
    expect(isProbeable({ ...base, socksProxy: '127.0.0.1:1080' })).toBe(false);
    expect(isProbeable({ ...base, extraSshOptions: ['ProxyCommand=cloudflared access ssh --hostname %h'] })).toBe(
      false
    );
    expect(isProbeable({ ...base, extraSshOptions: ['proxyjump=bastion'] })).toBe(false);
  });
});

describe('RemoteWakeRegistry — a proxied host is reachability-unknown', () => {
  // The bare TCP probe connects to `host:port`, which a jump-host/SOCKS host does not
  // answer even while ssh works. Acting on that verdict buffered input for the life of
  // the session (the readiness poll could never succeed), showed a permanent banner and
  // hid the real ssh error behind "not reachable". Unknown is not asleep.
  const proxied: WakeableRemote = {
    hostId: 'behind-bastion',
    label: 'Behind bastion',
    host: '10.20.0.5',
    jumpHost: 'bastion.example',
    wakeCommand: '/usr/local/bin/wake-behind-bastion',
  };

  it('delivers every input without probing, buffering or waking', async () => {
    const h = harness({ remote: proxied });
    await expect(h.registry.handleInput(h.session, 'ls\r')).resolves.toBe('deliver');
    await expect(h.registry.handleInput(h.session, 'pwd\r')).resolves.toBe('deliver');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
  });

  it('answers null (unknown), never false, so the UI has no banner to raise', async () => {
    const h = harness({ remote: proxied });
    await expect(h.registry.checkReachable(h.session, { force: true })).resolves.toBeNull();
    await expect(h.registry.checkHostReachable(proxied, { force: true })).resolves.toBeNull();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('does not gate a create/attach request on it (unprobeable, like no-target)', async () => {
    const h = harness({ remote: proxied });
    await expect(h.registry.ensureHostAwake(proxied)).resolves.toBe('unprobeable');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('lets the send-and-wait path through, and fires the manual wake blind', async () => {
    const h = harness({ remote: proxied });
    await expect(h.registry.ensureAwake(h.session)).resolves.toBe(true);
    expect(h.wake).not.toHaveBeenCalled();

    // The button: the user asked, so the target goes out — but nothing can verify the
    // host came back, so there is no readiness poll, no reattach and no "waking" toast
    // promising a wait that does not happen.
    await expect(h.registry.ensureAwake(h.session, { force: true })).resolves.toBe(true);
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.waitUntilReady).not.toHaveBeenCalled();
    expect(h.reattachRemote).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);

    h.wake.mockResolvedValueOnce(false);
    await expect(h.registry.ensureAwake(h.session, { force: true })).resolves.toBe(false);

    // A wake IO that throws is a failed wake, not a rejected route — and the public
    // `wake()` takes the same blind path, so nobody can poll readiness through a proxy.
    h.wake.mockRejectedValueOnce(new Error('udp socket exploded'));
    await expect(h.registry.wake(h.session)).resolves.toBe(false);
    expect(h.waitUntilReady).not.toHaveBeenCalled();
  });
});

describe('RemoteWakeRegistry — SSE payload routing', () => {
  const hostRemote: WakeableRemote = {
    hostId: 'hufflepuff',
    label: 'Hufflepuff',
    host: '192.168.50.137',
    wakeMac: '04:d9:f5:80:c6:58',
  };

  it('a session wake names its session, so the server routes it to the owner', async () => {
    const h = harness({ remote: hostRemote });
    h.probe.mockResolvedValue(false);
    await h.registry.handleInput(h.session, 'x');
    await h.registry.wake(h.session);
    const waking = h.payloads.find((p) => p.event === 'remote:hostWaking')!;
    expect(waking.payload).toMatchObject({ sessionId: 'sess-1', hostId: 'hufflepuff', label: 'Hufflepuff' });
    expect(waking.payload).not.toHaveProperty('username');
  });

  it('a create/attach wake has no session, so it names the requesting user instead', async () => {
    // Without it the server can only fail closed (admins only) — the requester would
    // never see their own wake. The payload carries `hostId`/`label`, which non-admins
    // are not shown elsewhere, so it must not go global either.
    const h = harness({ remote: hostRemote });
    h.probe.mockResolvedValue(false);
    h.waitUntilReady.mockResolvedValue(false);
    await expect(h.registry.ensureHostAwake(hostRemote, { requestedBy: 'alice' })).resolves.toBe('failed');
    const [waking, failed] = ['remote:hostWaking', 'remote:hostWakeFailed'].map(
      (event) => h.payloads.find((p) => p.event === event)!.payload
    );
    expect(waking).toMatchObject({ forNewSession: true, username: 'alice' });
    expect(failed).toMatchObject({ forNewSession: true, username: 'alice' });
    expect(waking).not.toHaveProperty('sessionId');
  });

  it('omits the requester when the route did not name one (single-user mode)', async () => {
    const h = harness({ remote: hostRemote });
    h.probe.mockResolvedValue(false);
    await h.registry.ensureHostAwake(hostRemote);
    expect(h.payloads.find((p) => p.event === 'remote:hostWaking')!.payload).not.toHaveProperty('username');
  });
});

describe('real IO is refused under vitest', () => {
  // Every consumer injects its IO (RemoteWakeDeps, the socket factory). The guard is
  // what makes that seam mandatory: a test that reaches the defaults fails loudly here
  // instead of opening a TCP connection, spawning a process or broadcasting UDP from CI.
  const target: WakeableRemote = { hostId: 'h', label: 'H', host: '127.0.0.1', port: 1 };

  it('the TCP probe', () => {
    expect(() => probeRemoteHostReachable(target)).toThrow(/disabled under test/);
  });

  it('the wake command', () => {
    expect(() => runRemoteWakeCommand('/bin/true')).toThrow(/disabled under test/);
  });

  it('the UDP broadcast — only with the DEFAULT socket, an injected one still works', async () => {
    await expect(sendWakePackets([[1, 2, 3, 4, 5, 6]])).rejects.toThrow(/disabled under test/);
  });

  it('the readiness poll, which probes by default', async () => {
    await expect(waitUntilRemoteReady(target, { timeoutMs: 10, intervalMs: 1 })).rejects.toThrow(/disabled under test/);
  });

  it('the default deps poll readiness with the INJECTED probe, never the real one', async () => {
    // `createDefaultRemoteWakeDeps({ probe })` used to override `probe` alone while
    // `waitUntilReady` kept the module default — so a shutdown test polled a production
    // address until the guard above made it fail instead of connecting.
    const probe = vi.fn(async () => true);
    const deps = createDefaultRemoteWakeDeps({ probe });
    await expect(deps.waitUntilReady(target, { timeoutMs: 10 })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledWith(target);
  });
});

describe('RemoteWakeRegistry — host-scoped wake for a request that waits on it', () => {
  const hostRemote: WakeableRemote = {
    hostId: 'hufflepuff',
    label: 'Hufflepuff',
    host: '192.168.50.137',
    wakeMac: '04:d9:f5:80:c6:58',
  };

  it('does not even probe a host without a wake target (byte-identical to no feature)', async () => {
    const h = harness({ remote: { hostId: 'x', label: 'X', host: '10.0.0.9' } });
    await expect(h.registry.ensureHostAwake(h.session.remote!)).resolves.toBe('no-target');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('reports ready without waking when the host already answers', async () => {
    const h = harness({ remote: hostRemote });
    h.probe.mockResolvedValue(true);
    await expect(h.registry.ensureHostAwake(hostRemote)).resolves.toBe('ready');
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('wakes a sleeping host and waits with the caller’s budget, not the 90 s default', async () => {
    const h = harness({ remote: hostRemote });
    h.probe.mockResolvedValue(false);

    await expect(
      h.registry.ensureHostAwake(hostRemote, { timeoutMs: REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS })
    ).resolves.toBe('ready');

    expect(h.wake).toHaveBeenCalledWith({ kind: 'mac', macs: [[4, 217, 245, 128, 198, 88]] });
    // The budget has to reach the readiness poll: the reverse proxy cuts a request at
    // 60 s, so a create-path wake must not inherit the 90 s session default. A magic
    // packet is effectively instant, so the poll gets essentially the whole budget;
    // it is not asserted to the millisecond because the wake's own elapsed time is
    // subtracted (see the wakeCommand case below).
    const [, readyOpts] = h.waitUntilReady.mock.calls[0] as [unknown, { timeoutMs: number; signal: AbortSignal }];
    expect(readyOpts.timeoutMs).toBeLessThanOrEqual(REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS);
    expect(readyOpts.timeoutMs).toBeGreaterThan(REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS - 1_000);
    // The shutdown signal rides along so `WebServer.stop()` can end the poll.
    expect(readyOpts.signal).toEqual(expect.any(AbortSignal));
    expect(h.events).toContain('remote:hostWaking');
  });

  it('spends a slow wake command out of the request budget rather than on top of it', async () => {
    // REMOTE_WAKE_COMMAND_TIMEOUT_MS is 10 s and runs BEFORE the readiness poll, so the
    // original arithmetic (40 s poll + 1.5 s probe + 15 s tmux prereq) understated a
    // wakeCommand host's worst case by the whole wake: ~68 s against the 60 s
    // proxy_read_timeout this budget exists to stay under.
    const h = harness({ remote: { ...hostRemote, wakeMac: undefined, wakeCommand: '/usr/bin/whuff' } });
    h.probe.mockResolvedValue(false);
    h.wake.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return true;
    });

    await expect(
      h.registry.ensureHostAwake(
        { ...hostRemote, wakeMac: undefined, wakeCommand: '/usr/bin/whuff' },
        { timeoutMs: 5_000 }
      )
    ).resolves.toBe('ready');

    const [, readyOpts] = h.waitUntilReady.mock.calls[0] as [unknown, { timeoutMs: number }];
    expect(readyOpts.timeoutMs).toBeLessThan(5_000);
    expect(readyOpts.timeoutMs).toBeGreaterThanOrEqual(5_000 - 2_000);
  });

  it('still gives a wake that ate the whole budget one readiness probe', async () => {
    const h = harness({ remote: { ...hostRemote, wakeMac: undefined, wakeCommand: '/usr/bin/whuff' } });
    h.probe.mockResolvedValue(false);
    h.wake.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return true;
    });

    await h.registry.ensureHostAwake(
      { ...hostRemote, wakeMac: undefined, wakeCommand: '/usr/bin/whuff' },
      { timeoutMs: 10 }
    );

    const [, readyOpts] = h.waitUntilReady.mock.calls[0] as [unknown, { timeoutMs: number }];
    expect(readyOpts.timeoutMs).toBe(REMOTE_WAKE_READY_INTERVAL_MS);
  });

  it('reports failed when the host never comes back, and probes again on the next attempt', async () => {
    const h = harness({ remote: hostRemote });
    h.probe.mockResolvedValue(false);
    h.waitUntilReady.mockResolvedValue(false);

    await expect(h.registry.ensureHostAwake(hostRemote)).resolves.toBe('failed');
    expect(h.events).toContain('remote:hostWakeFailed');

    // The failure resets the probe verdict, so a second Run probes instead of
    // trusting a stale "down" forever.
    h.waitUntilReady.mockResolvedValue(true);
    h.probe.mockClear();
    await expect(h.registry.ensureHostAwake(hostRemote)).resolves.toBe('ready');
    expect(h.probe).toHaveBeenCalled();
  });

  it('single-flights two concurrent create-path wakes for the same host', async () => {
    const h = harness({ remote: hostRemote });
    h.probe.mockResolvedValue(false);
    let release: (value: boolean) => void = () => {};
    h.waitUntilReady.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));

    const first = h.registry.ensureHostAwake(hostRemote);
    const second = h.registry.ensureHostAwake(hostRemote);
    await vi.waitFor(() => expect(h.wake).toHaveBeenCalledTimes(1));
    release(true);

    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready']);
    // One magic packet for a double click, not two.
    expect(h.wake).toHaveBeenCalledTimes(1);
  });

  it('checkHostReachable is a question, never an action', async () => {
    const h = harness({ remote: hostRemote });
    h.probe.mockResolvedValue(false);

    await expect(h.registry.checkHostReachable(hostRemote)).resolves.toBe(false);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('reports failed instead of rejecting when the wake IO itself throws', async () => {
    // A create route must answer with its own error, not a 500 from an unexpected
    // rejection — the session flow catches for the same reason.
    const h = harness({ remote: hostRemote });
    h.probe.mockResolvedValue(false);
    h.wake.mockRejectedValue(new Error('udp socket exploded'));

    await expect(h.registry.ensureHostAwake(hostRemote)).resolves.toBe('failed');
  });

  it('stop() resolves an in-flight wake as failed, so shutdown cannot wait it out', async () => {
    // `WebServer.stop()` ends with `app.close()`, which does not abort in-flight requests:
    // without this the shutdown sits out the whole readiness poll. Real `waitUntilReady`
    // (abortable sleep) with fake probe/wake, which is the shape of a restart mid-wake.
    const registry = new RemoteWakeRegistry(
      createDefaultRemoteWakeDeps({ probe: async () => false, wake: async () => true, log: () => {} })
    );
    const pending = registry.ensureHostAwake(hostRemote, { timeoutMs: 60_000 });
    await vi.waitFor(() => expect(registry.isWaking('host:hufflepuff')).toBe(true));

    registry.stop();
    await expect(pending).resolves.toBe('failed');

    // ... and nothing new starts afterwards.
    await expect(registry.ensureHostAwake(hostRemote)).resolves.toBe('failed');
  });
});

describe('waitUntilRemoteReady', () => {
  const remote: WakeableRemote = { hostId: 'h', label: 'H', host: '10.0.0.9' };

  it('ends on abort instead of waiting out the current interval', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = waitUntilRemoteReady(remote, {
      intervalMs: 1_000,
      timeoutMs: 60_000,
      probe: async () => false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('returns false immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = vi.fn(async () => true);
    await expect(waitUntilRemoteReady(remote, { probe, signal: controller.signal })).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

// ========== Wiring guard ==========

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
      continue;
    }
    if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('wake wiring guard', () => {
  it('only the route module and the server may import remote-wake', () => {
    // The auto-reconnect watcher (tmux-manager.ts), the server's dropped-session
    // handler and any boot-recovery path must NOT be able to WAKE a host: waking there
    // re-wakes the host seconds after each suspend. `web/server.ts` is allowed to hold
    // the registry for its LIFETIME only (`drop()` on session cleanup, `stop()` on
    // shutdown) — the test below pins that it never calls a waking method, which is the
    // property this import list is an approximation of.
    const allowed = new Set([join('web', 'routes', 'session-routes.ts'), join('web', 'server.ts')]);
    const importers = walkTs(SRC)
      .filter((full) => /from\s+['"][^'"]*remote-wake(\.js)?['"]/.test(readFileSync(full, 'utf-8')))
      .map((full) => relative(SRC, full));

    expect(importers.sort()).toEqual([...allowed].sort());
  });

  it('the server only ever calls drop/stop on the registry — never a waking method', () => {
    // `server.ts` holds the registry because `cleanupSession` and `stop()` need it, and
    // those run on timers and shutdown paths. Any wake-capable call from this file is the
    // exact failure invariant #1 exists to prevent, so it is asserted here rather than
    // left to the import check above (which the field's type alone would satisfy).
    const server = readFileSync(join(SRC, 'web', 'server.ts'), 'utf-8');
    for (const method of [
      'wake',
      'ensureAwake',
      'ensureHostAwake',
      'handleInput',
      'checkReachable',
      'checkHostReachable',
    ]) {
      expect(server).not.toContain(`remoteWake.${method}(`);
      expect(server).not.toContain(`remoteWake?.${method}(`);
    }
    expect(server).toContain('remoteWake?.drop(');
    expect(server).toContain('remoteWake?.stop(');
  });

  it('wakes a host for a create/attach request ONLY from the HTTP route', () => {
    // The create-path wake (`ensureHostAwake`) is a USER request, so it belongs to the
    // HTTP route. `cron-service.ts` builds sessions through the shared service with
    // nobody waiting on the answer, so a wake down there would power the host on for
    // every schedule — the failure invariant #1 exists to prevent. Asserted across the
    // source tree, so a future caller has to come through this test.
    // `remote-wake.ts` names itself: that is the definition, not a caller, and the
    // import guard above already pins the file to the route.
    const allowed = new Set([join('web', 'routes', 'session-routes.ts'), 'remote-wake.ts']);
    const callers = walkTs(SRC)
      .filter((full) => /ensureHostAwake\s*\(/.test(readFileSync(full, 'utf-8')))
      .map((full) => relative(SRC, full));

    expect(callers.sort()).toEqual([...allowed].sort());
  });
});
