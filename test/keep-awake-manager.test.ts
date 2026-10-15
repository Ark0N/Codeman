/**
 * @fileoverview KeepAwakeManager (src/keep-awake-manager.ts) driven through fake deps: no
 * real lock is ever taken. Pins the lifecycle: a lock is confirmed before it reads as
 * active, a polkit refusal is a retried state, AC-only follows the power source, a
 * release closes the inhibitor's stdin (which is what drops the lock), and the macOS lid
 * request file follows the lock only when the root helper is installed.
 *
 * Port: none.
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeepAwakeManager, type KeepAwakeDeps } from '../src/keep-awake-manager.js';
import {
  LINUX_HELD_MARKER,
  POWER_POLL_MS,
  RETRY_MS,
  linuxInhibitArgs,
  macCaffeinateArgs,
  type PowerSupplyInfo,
} from '../src/keep-awake.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  /** Like the real `cat`: closing stdin ends the process (asynchronously). */
  stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(() => {
      queueMicrotask(() => {
        if (this.exitCode !== null || this.signalCode !== null) return;
        this.exitCode = 0;
        this.emit('exit', 0, null);
      });
    }),
  });
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn((signal?: string) => {
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', null, this.signalCode);
    return true;
  });
  /** The process announces the lock (systemd-inhibit only execs its child once held). */
  hold() {
    this.stdout.emit('data', Buffer.from(`${LINUX_HELD_MARKER}\n`));
  }
  fail(stderr: string, code = 1) {
    this.stderr.emit('data', Buffer.from(stderr));
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

const AC: PowerSupplyInfo[] = [
  { type: 'Mains', online: true },
  { type: 'Battery', status: 'Charging' },
];
const BATTERY: PowerSupplyInfo[] = [
  { type: 'Mains', online: false },
  { type: 'Battery', status: 'Discharging' },
];

/** Let queued reconciles (a promise chain) run to completion. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function makeDeps(overrides: Partial<KeepAwakeDeps> = {}) {
  const children: FakeChild[] = [];
  let supplies = AC;
  let batt = "Now drawing from 'AC Power'";
  const deps: KeepAwakeDeps = {
    platform: 'linux',
    serverPid: 4242,
    spawn: vi.fn(() => {
      const c = new FakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    }),
    readPowerSupplies: vi.fn(async () => supplies),
    readMacBatt: vi.fn(async () => batt),
    lidHelperInstalled: vi.fn(async () => true),
    writeLidRequest: vi.fn(async () => {}),
    removeLidRequest: vi.fn(async () => {}),
    ...overrides,
  };
  return {
    deps,
    children,
    setSupplies: (s: PowerSupplyInfo[]) => (supplies = s),
    setBatt: (s: string) => (batt = s),
  };
}

describe('KeepAwakeManager on Linux', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the logind lock and reads active only once the lock is confirmed', async () => {
    const { deps, children } = makeDeps();
    const m = new KeepAwakeManager(deps);
    await m.apply({ enabled: true, acOnly: true });
    expect(deps.spawn).toHaveBeenCalledWith('systemd-inhibit', linuxInhibitArgs());
    expect(m.getStatus().state).toBe('starting');
    children[0].hold();
    expect(m.getStatus()).toMatchObject({ state: 'active', onAc: true, platform: 'linux', lidHelper: null });
    await m.stop();
  });

  it('reports a polkit refusal as denied and retries it', async () => {
    const { deps, children } = makeDeps();
    const m = new KeepAwakeManager(deps);
    await m.apply({ enabled: true, acOnly: true });
    children[0].fail('Failed to inhibit: Access denied\n');
    expect(m.getStatus().state).toBe('denied');
    expect(deps.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await settle();
    expect(deps.spawn).toHaveBeenCalledTimes(2);
    children[1].hold();
    expect(m.getStatus().state).toBe('active');
    await m.stop();
  });

  it('turning it off closes the inhibitor stdin, which drops the lock, and does not retry', async () => {
    const { deps, children } = makeDeps();
    const m = new KeepAwakeManager(deps);
    await m.apply({ enabled: true, acOnly: false });
    children[0].hold();
    await m.apply({ enabled: false, acOnly: false });
    expect(children[0].stdin.end).toHaveBeenCalled();
    expect(m.getStatus().state).toBe('off');
    // The released child exiting is expected, not a failure to retry.
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    await settle();
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(m.getStatus().state).toBe('off');
  });

  it('AC-only: no lock on battery, takes it when plugged in, releases on unplug', async () => {
    const { deps, children, setSupplies } = makeDeps();
    setSupplies(BATTERY);
    const m = new KeepAwakeManager(deps);
    await m.apply({ enabled: true, acOnly: true });
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(m.getStatus()).toMatchObject({ state: 'paused-battery', onAc: false });

    setSupplies(AC);
    await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
    await settle();
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    children[0].hold();
    expect(m.getStatus().state).toBe('active');

    setSupplies(BATTERY);
    await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
    await settle();
    expect(children[0].stdin.end).toHaveBeenCalled();
    expect(m.getStatus().state).toBe('paused-battery');
    await m.stop();
  });

  it('without AC-only it never reads the power source', async () => {
    const { deps, setSupplies } = makeDeps();
    setSupplies(BATTERY);
    const m = new KeepAwakeManager(deps);
    await m.apply({ enabled: true, acOnly: false });
    expect(deps.readPowerSupplies).not.toHaveBeenCalled();
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    await m.stop();
  });

  it('a machine without systemd-inhibit is unavailable, and is not retried', async () => {
    const { deps } = makeDeps({
      spawn: vi.fn(() => {
        throw Object.assign(new Error('spawn systemd-inhibit ENOENT'), { code: 'ENOENT' });
      }),
    });
    const m = new KeepAwakeManager(deps);
    await m.apply({ enabled: true, acOnly: true });
    expect(m.getStatus()).toMatchObject({ state: 'unavailable' });
    expect(m.getStatus().detail).toMatch(/systemd-inhibit is not installed/);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    await settle();
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    await m.stop();
  });

  it('stop() releases the lock and leaves nothing scheduled', async () => {
    const { deps, children } = makeDeps();
    const m = new KeepAwakeManager(deps);
    await m.apply({ enabled: true, acOnly: true });
    children[0].hold();
    await m.stop();
    await settle();
    expect(children[0].stdin.end).toHaveBeenCalled();
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(m.getStatus().state).toBe('off');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('KeepAwakeManager on macOS', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs caffeinate tied to the server pid and keeps the lid request fresh while held', async () => {
    const { deps, children } = makeDeps({ platform: 'macos' });
    const m = new KeepAwakeManager(deps);
    await m.apply({ enabled: true, acOnly: true });
    expect(deps.spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', macCaffeinateArgs(4242));
    children[0].emit('spawn');
    expect(m.getStatus()).toMatchObject({ state: 'active', lidHelper: 'installed', onAc: true });
    expect(deps.writeLidRequest).toHaveBeenCalledWith(4242);

    await vi.advanceTimersByTimeAsync(30_000);
    expect((deps.writeLidRequest as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);

    await m.apply({ enabled: false, acOnly: true });
    expect(deps.removeLidRequest).toHaveBeenCalled();
    expect(children[0].kill).toHaveBeenCalled();
    const writes = (deps.writeLidRequest as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect((deps.writeLidRequest as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writes);
  });

  it('writes no lid request when the root helper is not installed', async () => {
    const { deps, children } = makeDeps({ platform: 'macos', lidHelperInstalled: vi.fn(async () => false) });
    const m = new KeepAwakeManager(deps);
    await m.apply({ enabled: true, acOnly: true });
    children[0].emit('spawn');
    expect(m.getStatus()).toMatchObject({ state: 'active', lidHelper: 'missing' });
    expect(deps.writeLidRequest).not.toHaveBeenCalled();
    await m.stop();
  });

  it('on battery with AC-only, drops both caffeinate and the lid request', async () => {
    const { deps, children, setBatt } = makeDeps({ platform: 'macos' });
    const m = new KeepAwakeManager(deps);
    await m.apply({ enabled: true, acOnly: true });
    children[0].emit('spawn');
    setBatt("Now drawing from 'Battery Power'");
    await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
    await settle();
    expect(m.getStatus().state).toBe('paused-battery');
    expect(children[0].kill).toHaveBeenCalled();
    expect(deps.removeLidRequest).toHaveBeenCalled();
    await m.stop();
  });
});

describe('the process-wide manager under vitest', () => {
  it('is inert: enabling it never spawns a real lock', async () => {
    const m = new KeepAwakeManager();
    await m.apply({ enabled: true, acOnly: false });
    expect(m.getStatus()).toMatchObject({ state: 'unavailable', detail: 'Disabled under the test runner.' });
    await m.stop();
  });
});
