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
  decideRemoteInputAction,
  parseMacList,
  resolveWakeTarget,
  sendWakePackets,
  wakeConfigured,
  REMOTE_WAKE_PENDING_MAX_BYTES,
  type RemoteWakeDeps,
  type WakeableRemote,
  type WakeableSession,
} from '../src/remote-wake.js';

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

  it('trims a single oversized chunk to the cap, keeping its TAIL', () => {
    // One large paste is one input value, so the cap has to hold WITHIN a chunk too
    // (otherwise "bounded at 4 KB" would only be true per chunk, not per session).
    const huge = 'y'.repeat(REMOTE_WAKE_PENDING_MAX_BYTES + 100);
    const result = appendBoundedPending([], huge);
    expect(result).toEqual(['y'.repeat(REMOTE_WAKE_PENDING_MAX_BYTES)]);
    expect(result[0].length).toBe(REMOTE_WAKE_PENDING_MAX_BYTES);
  });

  it('trims a multi-byte tail without splitting a character', () => {
    const cap = 10;
    const value = 'ä'.repeat(8); // 2 bytes each → 16 bytes
    const result = appendBoundedPending([], value, cap);
    expect(Buffer.byteLength(result[0])).toBeLessThanOrEqual(cap);
    expect(result[0]).toBe('ä'.repeat(5)); // 10 bytes, no U+FFFD
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

  const deps: RemoteWakeDeps = {
    probe,
    wake,
    waitUntilReady,
    delay: async () => {},
    noteReconnected,
    broadcast: (event) => events.push(event),
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

  it('retains input that could not be written and reports nothing lost', async () => {
    const h = harness({ writesFail: true });
    h.probe.mockResolvedValue(false);

    await h.registry.handleInput(h.session, 'abc');
    await h.registry.wake(h.session);

    expect(h.writeViaMux).toHaveBeenCalledTimes(1);
    expect(h.registry.pendingBytes('sess-1')).toBe(3);
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

  it('does not consult the resolver when the session already has a wake target', async () => {
    const resolveRemote = vi.fn(async () => undefined);
    const h = harness({ resolveRemote });
    expect(await h.registry.hasWakeTarget(h.session)).toBe(true);
    expect(resolveRemote).not.toHaveBeenCalled();
  });

  it('drops buffered input with the session', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    await h.registry.handleInput(h.session, 'abc');
    h.registry.drop('sess-1');
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
    expect(h.registry.isWaking('sess-1')).toBe(false);
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
  it('only the input route may reach the wake registry', () => {
    // The auto-reconnect watcher (tmux-manager.ts), the server's dropped-session
    // handler and any boot-recovery path must NOT import remote-wake: waking there
    // re-wakes the host seconds after each suspend. Asserted, not commented.
    const allowed = new Set([join('web', 'routes', 'session-routes.ts')]);
    const importers = walkTs(SRC)
      .filter((full) => /from\s+['"][^'"]*remote-wake(\.js)?['"]/.test(readFileSync(full, 'utf-8')))
      .map((full) => relative(SRC, full));

    expect(importers.sort()).toEqual([...allowed].sort());
  });
});
