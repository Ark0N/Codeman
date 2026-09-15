/**
 * @fileoverview Wake a SLEEPING remote host from user input (user-triggered Wake-on-LAN).
 *
 * A durable remote session survives SSH drops (COD-104) and auto-reconnects
 * (COD-108), but nothing brings the HOST back: if the remote machine suspended,
 * the local tmux pane's `ssh` child stalls silently. `tmux send-keys` then
 * SUCCEEDS against a pane that will never deliver the bytes, so typed input is
 * lost with no error anywhere — the failure this module exists to close.
 *
 * Design (deliberately narrow, see docs/remote-sessions.md §Wake-on-LAN):
 *  - ONLY real user input wakes a host. The auto-reconnect watcher and
 *    boot-recovery must never wake one, or a host would be re-woken ~45 s after
 *    each suspend and could never stay asleep (the "keepalive pings a sleeping
 *    host" failure already solved for a different consumer by
 *    `hufflepuff-mcp-lazy`).
 *  - Detection is a cheap TCP connect to the SSH port (no auth, no ssh client,
 *    a few hundred bytes — below any meaningful activity threshold), throttled
 *    per session. No SSH keepalive is added to the launch command: keepalives
 *    would move bytes into an otherwise idle connection every interval, which is
 *    exactly the "an open pipe keeps the host awake" bug the remote-side idle
 *    detector was rewritten to avoid.
 *  - While a wake is in flight, input is BUFFERED and flushed in order once the
 *    pane is reattached, so the user's first characters after a long pause are
 *    not the ones that get eaten.
 *
 * The pure decisions and the IO are separated so the decision table can be
 * unit-tested without tmux, ssh, or a real host.
 *
 * @module remote-wake
 */

import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';

/** Minimum spacing between two reachability probes for the same session. */
export const REMOTE_WAKE_PROBE_MIN_INTERVAL_MS = 30_000;
/** TCP-connect timeout for a reachability probe (host awake ≈ a few ms). */
export const REMOTE_WAKE_PROBE_TIMEOUT_MS = 1_500;
/** Poll spacing while waiting for a woken host to accept SSH again. */
export const REMOTE_WAKE_READY_INTERVAL_MS = 1_500;
/** Bounded wait for the host to come back after the wake command ran. */
export const REMOTE_WAKE_READY_TIMEOUT_MS = 90_000;
/** The wake command itself must not hang the wake flow. */
export const REMOTE_WAKE_COMMAND_TIMEOUT_MS = 10_000;
/**
 * Settle time between respawning the ssh pane and flushing buffered input: the
 * respawned `ssh` needs a moment to run `tmux -L codeman-remote … -A` and attach,
 * and bytes written into a still-connecting pane land in nothing.
 */
export const REMOTE_WAKE_ATTACH_SETTLE_MS = 1_500;
/**
 * Cap on buffered input per session while a host is being woken. 4 KB is a lot
 * of typing for a ~10 s wake; beyond it the OLDEST bytes are dropped (keeping the
 * tail preserves what the user just typed, and a silently unbounded buffer would
 * be a memory leak keyed on user input).
 */
export const REMOTE_WAKE_PENDING_MAX_BYTES = 4096;
/** Default SSH port used when the host config has no explicit `port`. */
export const DEFAULT_SSH_PORT = 22;

/** What the input path should do with a chunk of user input. Pure. */
export type RemoteInputAction = 'deliver' | 'probe' | 'buffer';
/**
 * The caller-facing outcome of {@link RemoteWakeRegistry.handleInput}: either the
 * caller writes the bytes as usual, or the registry took ownership of them.
 */
export type RemoteInputOutcome = 'deliver' | 'buffered';

/**
 * Decide what to do with an input chunk on an input route. Mirrors
 * {@link RemoteWakeRegistry.handleInput} so the throttle table has exactly ONE
 * definition and is unit-testable:
 *
 *  - a wake already in flight → buffer (the flush owns delivery),
 *  - no wake command configured → deliver (feature off, today's behavior),
 *  - the last probe said "down" → buffer (no second probe; re-probing a known
 *    sleeping host on every keystroke would add seconds of latency per character),
 *  - never probed / throttle window elapsed → probe,
 *  - probed "up" inside the window → deliver.
 *
 * Pure — no clock, no IO.
 */
export function decideRemoteInputAction(args: {
  hasWakeTarget: boolean;
  waking: boolean;
  probeAgeMs: number;
  lastReachable?: boolean;
  minProbeIntervalMs?: number;
}): RemoteInputAction {
  if (args.waking) return 'buffer';
  if (!args.hasWakeTarget) return 'deliver';
  if (args.lastReachable === false) return 'buffer';
  const interval = args.minProbeIntervalMs ?? REMOTE_WAKE_PROBE_MIN_INTERVAL_MS;
  if (args.probeAgeMs >= interval) return 'probe';
  return 'deliver';
}

/**
 * Append `data` to the pending buffer, dropping the OLDEST bytes when the cap is
 * exceeded. Returns the resulting buffer. Pure.
 *
 * A single chunk can itself exceed the cap (one large paste is one `input` value),
 * so after whole chunks are dropped the surviving chunk's HEAD is trimmed too —
 * otherwise "bounded at 4 KB" would hold only per chunk, not per session. The trim
 * is code-point aware, so it never emits a broken multi-byte character.
 */
export function appendBoundedPending(
  pending: string[],
  data: string,
  maxBytes = REMOTE_WAKE_PENDING_MAX_BYTES
): string[] {
  const next = [...pending, data];
  let total = next.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
  while (next.length > 1 && total > maxBytes) {
    total -= Buffer.byteLength(next[0]);
    next.shift();
  }
  if (next.length === 1) next[0] = tailWithinBytes(next[0], maxBytes);
  return next;
}

/** Keep only the trailing part of `value` that fits in `maxBytes` UTF-8 bytes. Pure. */
function tailWithinBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const chars = [...value];
  let total = 0;
  let start = chars.length;
  while (start > 0) {
    const size = Buffer.byteLength(chars[start - 1]);
    if (total + size > maxBytes) break;
    total += size;
    start--;
  }
  return chars.slice(start).join('');
}

/** The remote fields the wake flow needs. Structurally satisfied by `SessionRemote`. */
export interface WakeableRemote {
  wakeCommand?: string;
  wakeMac?: string;
  hostId: string;
  label: string;
  host: string;
  port?: number;
}

/**
 * A resolved wake path for a host. `command` wins over `mac` (an explicit override
 * beats the default path), and `null` means the host cannot be woken at all — which
 * is what the UI turns into "configure WoL" instead of "wake".
 */
export type WakeTarget = { kind: 'command'; command: string } | { kind: 'mac'; macs: number[][] } | null;

/**
 * Resolve the wake target from host config. Pure.
 *
 * A malformed `wakeMac` resolves to `null` rather than throwing: the schema
 * already rejects one at config time, so this can only be reached with a config
 * written by hand, and a broken MAC must not break the input route.
 */
export function resolveWakeTarget(remote: WakeableRemote | undefined): WakeTarget {
  if (!remote) return null;
  if (remote.wakeCommand) return { kind: 'command', command: remote.wakeCommand };
  if (remote.wakeMac) {
    const macs = parseMacList(remote.wakeMac);
    if (macs && macs.length > 0) return { kind: 'mac', macs };
  }
  return null;
}

/**
 * Parse a comma-separated MAC list into byte arrays. Pure; returns null when any
 * entry is malformed (all-or-nothing, so a typo cannot half-arm a host).
 */
export function parseMacList(value: string, maxMacs = 4): number[][] | null {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > maxMacs) return null;
  const macs: number[][] = [];
  for (const part of parts) {
    const match =
      /^([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})$/.exec(
        part
      );
    if (!match) return null;
    macs.push(match.slice(1).map((hex) => Number.parseInt(hex, 16)));
  }
  return macs;
}

/**
 * Build a Wake-on-LAN "magic packet": six `0xFF` bytes then the MAC repeated 16
 * times. Pure — the shape is asserted byte-for-byte in the tests because a packet
 * that is off by one byte simply never wakes anything.
 */
export function buildMagicPacket(mac: number[]): Buffer {
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let repeat = 0; repeat < 16; repeat++) {
    Buffer.from(mac).copy(packet, 6 + repeat * 6);
  }
  return packet;
}

/**
 * The slice of `Session` the wake flow uses — an interface rather than the
 * concrete class so the registry is testable without a tmux server.
 */
export interface WakeableSession {
  readonly id: string;
  readonly remote: WakeableRemote | undefined;
  /** COD-108 reattach: respawns the local ssh pane, idempotently attaching the durable remote tmux. */
  reattachRemote(): Promise<boolean>;
  /** Write bytes to the session's pane. */
  writeViaMux(data: string): Promise<boolean>;
}

/** Injected IO so the registry holds no direct dependency on ssh/net/child_process in tests. */
export interface RemoteWakeDeps {
  /** Cheap reachability probe. Must resolve false (never throw) for a sleeping host. */
  probe(remote: WakeableRemote): Promise<boolean>;
  /** Run the resolved wake target (magic packet or host command). Resolves false on failure. */
  wake(target: NonNullable<WakeTarget>): Promise<boolean>;
  /** Poll until the woken host accepts connections again. */
  waitUntilReady(remote: WakeableRemote): Promise<boolean>;
  /** Sleep helper (injected for tests). */
  delay(ms: number): Promise<void>;
  /** Notify the COD-108 watcher so an exhausted backoff is reset. */
  noteReconnected?(sessionId: string, success: boolean): void;
  /** SSE broadcast. */
  broadcast?(
    event: 'remote:hostWaking' | 'remote:hostWakeFailed' | 'remote:sessionReconnected',
    payload: Record<string, unknown>
  ): void;
  /** Structured diagnostics. */
  log?(message: string): void;
  /**
   * Resolve the host's CURRENT wake config for a session whose persisted `remote`
   * snapshot predates it (or was configured after launch). Called at most once per
   * `REMOTE_WAKE_RESOLVE_TTL_MS` per session, and only when the session's own copy
   * has no wake target — so a config saved in the UI works without restarting the
   * session, without a per-keystroke config read.
   */
  resolveRemote?(session: WakeableSession): Promise<WakeableRemote | undefined>;
}

/** Probe freshness for the UI's reachability check (a tab switch is not a hammer). */
export const REMOTE_WAKE_REACHABILITY_TTL_MS = 5_000;
/** How long a resolved host config is trusted before asking the resolver again. */
export const REMOTE_WAKE_RESOLVE_TTL_MS = 30_000;

/**
 * What the UI is allowed to offer for a host: how it can be woken, if at all. The
 * `'none'` case is what the banner turns into "configure WoL" instead of "wake".
 */
export type WakeConfigured = 'command' | 'mac' | 'none';

/** Which wake path a host config provides (mirrors {@link resolveWakeTarget}). Pure. */
export function wakeConfigured(remote: WakeableRemote | undefined): WakeConfigured {
  const target = resolveWakeTarget(remote);
  if (!target) return 'none';
  return target.kind;
}

/** Per-session wake bookkeeping. */
interface WakeState {
  probedAt: number;
  reachable?: boolean;
  waking: Promise<boolean> | null;
  pending: string[];
  /** Host config resolved after launch (see `RemoteWakeDeps.resolveRemote`). */
  resolvedRemote?: WakeableRemote;
  resolvedAt: number;
}

/**
 * Per-session wake state + single-flight wake flow.
 *
 * One instance per web server (module singleton in the routes file, like the
 * signal-wait registry). State is keyed by session id and dropped with the
 * session.
 */
export class RemoteWakeRegistry {
  private readonly states = new Map<string, WakeState>();

  constructor(private readonly deps: RemoteWakeDeps) {}

  /** Drop a session's state (session closed/killed). The pending buffer goes with it. */
  drop(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** Whether a wake is currently in flight (diagnostics/tests). */
  isWaking(sessionId: string): boolean {
    return this.states.get(sessionId)?.waking != null;
  }

  /** Buffered input bytes for a session (diagnostics/tests). */
  pendingBytes(sessionId: string): number {
    const state = this.states.get(sessionId);
    if (!state) return 0;
    return state.pending.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
  }

  /** Whether this session's host has any wake path configured at all. */
  async hasWakeTarget(session: WakeableSession): Promise<boolean> {
    return resolveWakeTarget(await this._effectiveRemote(session)) !== null;
  }

  /** Which wake path is configured (`'none'` when the UI should offer configuration). */
  async wakeConfigured(session: WakeableSession): Promise<WakeConfigured> {
    return wakeConfigured(await this._effectiveRemote(session));
  }

  /**
   * Reachability for the UI: probe unless a recent result is still fresh.
   *
   * Shares the per-session probe state with the input path on purpose — a fresh
   * answer is exactly what the input ladder wants, and an `unreachable` verdict here
   * makes the next keystroke buffer + wake instead of vanishing into a stalled pane.
   */
  async checkReachable(session: WakeableSession, opts: { force?: boolean; ttlMs?: number } = {}): Promise<boolean> {
    const remote = await this._effectiveRemote(session);
    if (!remote) return true;
    const state = this._state(session.id);
    const ttl = opts.force ? 0 : (opts.ttlMs ?? REMOTE_WAKE_REACHABILITY_TTL_MS);
    if (Date.now() - state.probedAt >= ttl) {
      state.probedAt = Date.now();
      state.reachable = await this.deps.probe(remote);
    }
    return state.reachable === true;
  }

  /**
   * Decide + act for one input chunk.
   *
   * `'deliver'` means the caller writes it as usual (today's path, zero added
   * cost). `'buffered'` means the registry took ownership of the bytes: it either
   * queued them behind an in-flight wake or started a wake, and will flush them
   * in order once the pane is reattached.
   */
  async handleInput(session: WakeableSession, data: string): Promise<RemoteInputOutcome> {
    const remote = await this._effectiveRemote(session);
    const state = this._state(session.id);
    const target = resolveWakeTarget(remote);
    const action = decideRemoteInputAction({
      hasWakeTarget: target !== null,
      waking: state.waking != null,
      probeAgeMs: Date.now() - state.probedAt,
      lastReachable: state.reachable,
    });

    if (action === 'deliver') return 'deliver';
    if (action === 'buffer') {
      this._enqueue(session.id, data);
      // A buffered verdict with no wake in flight still has to DRIVE a wake (the
      // previous one failed and reset the probe state, or the ladder landed here
      // directly) — otherwise the bytes would sit in the buffer forever.
      if (state.waking == null && target) void this.wake(session);
      return 'buffered';
    }

    // action === 'probe' — the throttle window elapsed, so one TCP connect is owed.
    state.probedAt = Date.now();
    state.reachable = remote ? await this.deps.probe(remote) : true;
    if (state.reachable) return 'deliver';

    this._enqueue(session.id, data);
    void this.wake(session);
    return 'buffered';
  }

  /**
   * Block until the host is reachable and the pane is reattached — the
   * send-and-wait path, where the HTTP response stays open anyway and buffering
   * would break the wait contract.
   */
  async ensureAwake(session: WakeableSession, opts: { force?: boolean } = {}): Promise<boolean> {
    const remote = await this._effectiveRemote(session);
    if (!remote || !resolveWakeTarget(remote)) return true;
    const state = this._state(session.id);
    // `force` is the manual path (a user pressed "wake"): a cached "reachable" from
    // seconds ago must not talk the button out of waking a host that just slept.
    if (opts.force || (state.reachable !== false && Date.now() - state.probedAt >= REMOTE_WAKE_PROBE_MIN_INTERVAL_MS)) {
      state.probedAt = Date.now();
      state.reachable = await this.deps.probe(remote);
    }
    if (state.reachable) return true;
    return this.wake(session);
  }

  /**
   * Single-flight wake: probe-free (the caller already knows the host is down),
   * run the wake command, poll for readiness, reattach the pane, flush the buffer.
   */
  async wake(session: WakeableSession): Promise<boolean> {
    const remote = await this._effectiveRemote(session);
    const target = resolveWakeTarget(remote);
    if (!remote || !target) return true;
    const state = this._state(session.id);
    if (state.waking) return state.waking;

    state.waking = (async (): Promise<boolean> => {
      const id = session.id;
      try {
        this.deps.broadcast?.('remote:hostWaking', { sessionId: id, hostId: remote.hostId, label: remote.label });
        this.deps.log?.(`[RemoteWake] waking ${remote.label} (${remote.host}) via ${target.kind} for session ${id}`);

        const woke = await this.deps.wake(target);
        if (!woke) {
          this.deps.log?.(
            `[RemoteWake] wake failed for ${remote.label}: ${target.kind === 'command' ? target.command : 'magic packet'}`
          );
        }

        const ready = await this.deps.waitUntilReady(remote);
        if (!ready) {
          this.deps.log?.(`[RemoteWake] ${remote.label} did not come back — input stays buffered`);
          this.deps.broadcast?.('remote:hostWakeFailed', { sessionId: id, hostId: remote.hostId, label: remote.label });
          // Reset the probe state so the NEXT user input probes and retries
          // instead of trusting a stale "down" verdict forever.
          state.probedAt = 0;
          state.reachable = undefined;
          return false;
        }

        state.reachable = true;
        state.probedAt = Date.now();
        const reattached = await session.reattachRemote();
        if (!reattached) {
          this.deps.log?.(`[RemoteWake] ${remote.label} is up but the pane could not be reattached`);
          return false;
        }
        // The reset also clears an EXHAUSTED COD-108 backoff, which otherwise
        // never fires again for this session (see remote-reconnect.ts).
        this.deps.noteReconnected?.(id, true);
        this.deps.broadcast?.('remote:sessionReconnected', { sessionId: id });
        this.deps.log?.(`[RemoteWake] ${remote.label} reattached for session ${id}`);

        await this.deps.delay(REMOTE_WAKE_ATTACH_SETTLE_MS);
        await this._flush(state, session);
        return true;
      } catch (err) {
        this.deps.log?.(`[RemoteWake] unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        state.waking = null;
      }
    })();

    return state.waking;
  }

  private _state(sessionId: string): WakeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { probedAt: 0, reachable: undefined, waking: null, pending: [], resolvedAt: 0 };
      this.states.set(sessionId, state);
    }
    return state;
  }

  /**
   * The host config to act on: the session's own `remote` when it can wake, else a
   * freshly resolved one.
   *
   * The persisted `remote` snapshot is taken at launch, so a wake target configured
   * AFTER the session started (e.g. through the banner's config dialog, or by adding
   * `wakeMac` to `remote-hosts.json`) is invisible to it. Recovery rehydration
   * (server.ts) covers restarts; this covers the live session, and it is why saving
   * the dialog takes effect without restarting anything. The resolver is asked at
   * most once per TTL, and never for a session that already has a usable target.
   */
  private async _effectiveRemote(session: WakeableSession): Promise<WakeableRemote | undefined> {
    const state = this._state(session.id);
    if (state.resolvedRemote && resolveWakeTarget(state.resolvedRemote)) return state.resolvedRemote;
    if (resolveWakeTarget(session.remote)) return session.remote;
    if (!session.remote || !this.deps.resolveRemote) return state.resolvedRemote ?? session.remote;
    if (Date.now() - state.resolvedAt < REMOTE_WAKE_RESOLVE_TTL_MS) {
      return state.resolvedRemote ?? session.remote;
    }
    state.resolvedAt = Date.now();
    try {
      const resolved = await this.deps.resolveRemote(session);
      if (resolved) state.resolvedRemote = resolved;
    } catch (err) {
      this.deps.log?.(
        `[RemoteWake] host config lookup failed for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return state.resolvedRemote ?? session.remote;
  }

  private _enqueue(sessionId: string, data: string): void {
    const state = this._state(sessionId);
    const before = state.pending.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
    state.pending = appendBoundedPending(state.pending, data);
    const after = state.pending.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
    if (before + Buffer.byteLength(data) > after) {
      this.deps.log?.(`[RemoteWake] pending buffer cap reached for session ${sessionId} — oldest input dropped`);
    }
  }

  private async _flush(state: WakeState, session: WakeableSession): Promise<void> {
    while (state.pending.length > 0) {
      const chunk = state.pending[0];
      const ok = await session.writeViaMux(chunk).catch(() => false);
      if (!ok) {
        this.deps.log?.(
          `[RemoteWake] flush failed for session ${session.id} — ${state.pending.length} chunk(s) retained`
        );
        return;
      }
      state.pending.shift();
    }
  }
}

// ========== Default IO ==========

/**
 * Cheap reachability probe: a bare TCP connect to the SSH port.
 *
 * Deliberately NOT an `ssh … true` probe: that opens a full session (auth,
 * remote log, process) every throttle window for a question a SYN already
 * answers. Any byte count it does move is a few hundred bytes per probe, far
 * below the remote idle detector's traffic threshold, so probing cannot keep a
 * host awake.
 */
export function probeRemoteHostReachable(
  remote: WakeableRemote,
  timeoutMs = REMOTE_WAKE_PROBE_TIMEOUT_MS
): Promise<boolean> {
  const port = remote.port ?? DEFAULT_SSH_PORT;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ host: remote.host, port });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Run a host's wake command (e.g. a Wake-on-LAN wrapper script). No shell — the
 * value is a single executable path, so nothing in it can be interpreted.
 * Resolves false on any failure (missing binary, non-zero exit, timeout) rather
 * than throwing: a broken wake command must not break the input route.
 */
export function runRemoteWakeCommand(command: string, timeoutMs = REMOTE_WAKE_COMMAND_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [], { stdio: 'ignore' });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

/**
 * Send Wake-on-LAN magic packets for every MAC, over UDP to the broadcast address.
 *
 * This is the whole reason `wakeMac` exists: the common case needs no external
 * script. Broadcast on 255.255.255.255 is what the CLI `wakeonlan` does and what the
 * NICs here answer to; the socket is closed as soon as the packets are queued, so a
 * sleeping host cannot leave a handle behind. Resolves false on any failure (no
 * interface to broadcast on, permission) rather than throwing — a broken network
 * must not break the wake flow, which reports the failure itself.
 */
export function sendWakePackets(
  addresses: number[][],
  port = 9,
  createSocket: WakeSocketFactory = () => dgram.createSocket('udp4')
): Promise<boolean> {
  if (addresses.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createSocket();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    socket.once('error', () => finish(false));
    // ⚠️ `setBroadcast` BEFORE the socket is bound fails with EBADF on Linux, and the
    // send that follows fails with EACCES — i.e. the packet silently never leaves the
    // machine. So the broadcast flag is set in the bind callback, always. (Found by
    // the live test: macOS/BSD tolerate the wrong order, Linux does not.)
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        finish(false);
        return;
      }
      let pending = addresses.length;
      let failed = false;
      for (const mac of addresses) {
        socket.send(buildMagicPacket(mac), port, '255.255.255.255', (err?: Error | null) => {
          if (err) failed = true;
          pending--;
          if (pending === 0) finish(!failed);
        });
      }
    });
  });
}

/** The `dgram` surface {@link sendWakePackets} uses — injectable so the bind/setBroadcast ORDER is testable. */
export interface WakeSocket {
  bind(callback: () => void): void;
  setBroadcast(flag: boolean): void;
  send(msg: Buffer, port: number, address: string, callback: (err?: Error | null) => void): void;
  close(): void;
  once(event: 'error', listener: (err: Error) => void): void;
}

export type WakeSocketFactory = () => WakeSocket;

/** Poll the host until it accepts connections again, or the bound is hit. */
export async function waitUntilRemoteReady(
  remote: WakeableRemote,
  opts: { intervalMs?: number; timeoutMs?: number; probe?: (remote: WakeableRemote) => Promise<boolean> } = {}
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? REMOTE_WAKE_READY_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? REMOTE_WAKE_READY_TIMEOUT_MS;
  const probe = opts.probe ?? probeRemoteHostReachable;
  const deadline = Date.now() + timeoutMs;
  // Probe immediately: WoL from a warm S3 is fast (~7.5 s measured on this setup),
  // and the first poll is what turns "just woke" into a sub-interval response.
  for (;;) {
    if (await probe(remote)) return true;
    if (Date.now() + intervalMs > deadline) return false;
    await delay(intervalMs);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Production wiring: all IO defaults, overridable for tests. */
export function createDefaultRemoteWakeDeps(overrides: Partial<RemoteWakeDeps> = {}): RemoteWakeDeps {
  return {
    probe: probeRemoteHostReachable,
    wake: (target) => (target.kind === 'command' ? runRemoteWakeCommand(target.command) : sendWakePackets(target.macs)),
    waitUntilReady: (remote) => waitUntilRemoteReady(remote),
    delay,
    ...overrides,
  };
}
