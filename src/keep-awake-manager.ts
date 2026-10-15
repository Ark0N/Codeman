/**
 * @fileoverview Holds the OS sleep lock behind `keepAwakeEnabled` for exactly as long
 * as Codeman runs. The decisions (which lock, when, what a failure means) are pure and
 * live in `keep-awake.ts`; this module only does the IO and keeps the state current.
 *
 * Lifecycle rules, each load-bearing:
 *
 * - **The lock dies with the server, never after it.** Linux: `systemd-inhibit` runs a
 *   `cat` on a stdin pipe from this process, so any exit (SIGKILL included) closes the
 *   pipe and releases the lock even under the unit's `KillMode=process`. macOS:
 *   `caffeinate -w <pid>` exits with the server. The macOS lid request file is only a
 *   heartbeat: the root helper ignores it once it is two minutes old.
 * - **Reconcile from settings, never from a request body.** `apply()` takes the merged
 *   config and is idempotent, so the boot path and every `PUT /api/settings` call the
 *   same thing.
 * - **A refusal is a state, not an error.** polkit denies the Linux lock until someone
 *   logs in to the desktop; that is reported as `denied` and retried, never thrown.
 * - **Inert under vitest** unless a test injects its own deps, so the suite never takes
 *   a real lock on the machine running it.
 */

import { spawn as nodeSpawn, execFile, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { dataPath } from './config/instance.js';
import {
  MAC_LID_HEARTBEAT_MS,
  MAC_LID_HELPER_PLIST,
  MAC_LID_REQUEST_FILE,
  LINUX_HELD_MARKER,
  POWER_POLL_MS,
  RETRY_MS,
  classifyInhibitFailure,
  isOnAcPowerLinux,
  isOnAcPowerMac,
  keepAwakePlatform,
  linuxInhibitArgs,
  macCaffeinateArgs,
  shouldHoldLock,
  type KeepAwakeConfig,
  type KeepAwakePlatform,
  type KeepAwakeStatus,
  type PowerSupplyInfo,
} from './keep-awake.js';

/** Grace between closing the inhibitor's stdin and SIGTERM. */
const RELEASE_GRACE_MS = 2_000;
/** Bound on captured stderr from the lock process. */
const STDERR_CAP = 2_048;

export interface KeepAwakeDeps {
  platform: KeepAwakePlatform;
  serverPid: number;
  spawn: (command: string, args: string[]) => ChildProcess;
  readPowerSupplies: () => Promise<PowerSupplyInfo[]>;
  readMacBatt: () => Promise<string | null>;
  lidHelperInstalled: () => Promise<boolean>;
  writeLidRequest: (pid: number) => Promise<void>;
  removeLidRequest: () => Promise<void>;
}

const POWER_SUPPLY_DIR = '/sys/class/power_supply';

async function readSysValue(dir: string, name: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(join(dir, name), 'utf-8')).trim();
  } catch {
    return undefined;
  }
}

async function readLinuxPowerSupplies(): Promise<PowerSupplyInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(POWER_SUPPLY_DIR);
  } catch {
    return [];
  }
  const out: PowerSupplyInfo[] = [];
  for (const name of names) {
    const dir = join(POWER_SUPPLY_DIR, name);
    const type = await readSysValue(dir, 'type');
    if (!type) continue;
    const online = await readSysValue(dir, 'online');
    out.push({
      type,
      online: online === undefined ? undefined : online === '1',
      status: await readSysValue(dir, 'status'),
      scope: await readSysValue(dir, 'scope'),
    });
  }
  return out;
}

function readPmsetBatt(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5_000 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

function defaultDeps(): KeepAwakeDeps {
  const lidRequest = () => dataPath(MAC_LID_REQUEST_FILE);
  return {
    platform: keepAwakePlatform(process.platform, release()),
    serverPid: process.pid,
    spawn: (command, args) => nodeSpawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }),
    readPowerSupplies: readLinuxPowerSupplies,
    readMacBatt: readPmsetBatt,
    lidHelperInstalled: async () => {
      try {
        await fs.access(MAC_LID_HELPER_PLIST);
        return true;
      } catch {
        return false;
      }
    },
    writeLidRequest: async (pid) => {
      await fs.writeFile(lidRequest(), `${pid}\n`, { mode: 0o644 });
    },
    removeLidRequest: async () => {
      await fs.rm(lidRequest(), { force: true });
    },
  };
}

export class KeepAwakeManager {
  private readonly deps: KeepAwakeDeps;
  private readonly inert: boolean;
  private config: KeepAwakeConfig = { enabled: false, acOnly: true };
  private status: KeepAwakeStatus;
  private child: ChildProcess | null = null;
  /** Children we asked to exit; their exit is expected and must not trigger a retry. */
  private releasing = new WeakSet<ChildProcess>();
  private powerTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Serializes reconciles: a settings PUT can land while a power poll is mid-read. */
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private lastLoggedState: KeepAwakeStatus['state'] = 'off';

  constructor(deps?: KeepAwakeDeps) {
    this.inert = !deps && !!process.env.VITEST;
    this.deps = deps ?? defaultDeps();
    this.status = {
      enabled: false,
      acOnly: true,
      platform: this.deps.platform,
      state: 'off',
      onAc: null,
      lidHelper: null,
      detail: null,
    };
  }

  /** Current status (a copy). */
  getStatus(): KeepAwakeStatus {
    return { ...this.status };
  }

  /** Reconcile to `config`. Idempotent; safe to call on every settings save. */
  apply(config: KeepAwakeConfig): Promise<void> {
    this.config = { ...config };
    this.stopped = false;
    return this.enqueue();
  }

  /** Release everything and stop all timers (server shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    await this.chain.catch(() => {});
    await this.release();
    this.status = { ...this.status, state: 'off', detail: null };
  }

  private enqueue(): Promise<void> {
    const next = this.chain
      .then(() => this.reconcile())
      .catch((err) => {
        console.error('[keep-awake] reconcile failed:', err);
      });
    this.chain = next;
    return next;
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    const { enabled, acOnly } = this.config;
    this.status = { ...this.status, enabled, acOnly };

    if (!enabled) {
      this.clearTimers();
      await this.release();
      this.setState('off', null);
      return;
    }
    if (this.inert) {
      this.setState('unavailable', 'Disabled under the test runner.');
      return;
    }
    if (this.deps.platform === 'unsupported') {
      this.setState('unavailable', 'Not supported on this system.');
      return;
    }

    if (this.deps.platform === 'macos') {
      this.status.lidHelper = (await this.deps.lidHelperInstalled()) ? 'installed' : 'missing';
    }

    const onAc = acOnly ? await this.readOnAc() : null;
    this.status.onAc = onAc;
    this.ensurePowerPoll(acOnly);

    if (!shouldHoldLock(this.config, onAc)) {
      await this.release();
      this.setState('paused-battery', null);
      return;
    }

    // The lid helper is a separate mechanism from caffeinate: it only needs a fresh
    // request file, so it runs whether or not caffeinate is currently up.
    if (this.deps.platform === 'macos' && this.status.lidHelper === 'installed') this.startLidHeartbeat();

    // A pending retry owns the next attempt; a live child is already the lock.
    if (this.child || this.retryTimer) return;
    if (this.status.state === 'unavailable') return;
    this.acquire();
  }

  private async readOnAc(): Promise<boolean | null> {
    try {
      if (this.deps.platform === 'linux') return isOnAcPowerLinux(await this.deps.readPowerSupplies());
      if (this.deps.platform === 'macos') {
        const out = await this.deps.readMacBatt();
        return out === null ? null : isOnAcPowerMac(out);
      }
    } catch {
      /* unknown */
    }
    return null;
  }

  private acquire(): void {
    if (this.deps.platform === 'linux') this.acquireLinux();
    else if (this.deps.platform === 'macos') this.acquireMac();
  }

  private acquireLinux(): void {
    let child: ChildProcess;
    try {
      child = this.deps.spawn('systemd-inhibit', linuxInhibitArgs());
    } catch (err) {
      this.onSpawnError(err as NodeJS.ErrnoException);
      return;
    }
    this.child = child;
    this.setState('starting', null);
    // Closing the pipe to an already-dead process emits EPIPE on the stream; unhandled,
    // that would take the whole server down.
    child.stdin?.on('error', () => {});
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child === child && String(chunk).includes(LINUX_HELD_MARKER)) this.setState('active', null);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += String(chunk);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = null;
      this.onSpawnError(err);
    });
    child.on('exit', () => {
      if (this.releasing.has(child) || this.child !== child) return;
      this.child = null;
      const { state, detail } = classifyInhibitFailure(stderr);
      this.setState(state, detail);
      if (state !== 'unavailable') this.scheduleRetry();
    });
  }

  private acquireMac(): void {
    let child: ChildProcess;
    try {
      child = this.deps.spawn('/usr/bin/caffeinate', macCaffeinateArgs(this.deps.serverPid));
    } catch (err) {
      this.onSpawnError(err as NodeJS.ErrnoException);
      return;
    }
    this.child = child;
    this.setState('starting', null);
    child.on('spawn', () => {
      if (this.child === child) this.setState('active', null);
    });
    child.stdin?.on('error', () => {});
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = null;
      this.onSpawnError(err);
    });
    child.on('exit', (code, signal) => {
      if (this.releasing.has(child) || this.child !== child) return;
      this.child = null;
      this.setState('failed', `caffeinate exited (${signal ?? `code ${code}`})`);
      this.scheduleRetry();
    });
  }

  private onSpawnError(err: NodeJS.ErrnoException): void {
    if (err.code === 'ENOENT') {
      const tool = this.deps.platform === 'macos' ? 'caffeinate' : 'systemd-inhibit';
      this.setState('unavailable', `${tool} is not installed on this machine.`);
      return;
    }
    this.setState('failed', err.message);
    this.scheduleRetry();
  }

  private startLidHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const beat = () => {
      void this.deps.writeLidRequest(this.deps.serverPid).catch((err) => {
        console.warn('[keep-awake] could not write the lid request file:', err);
      });
    };
    beat();
    this.heartbeatTimer = setInterval(beat, MAC_LID_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private async release(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.deps.platform === 'macos' && !this.inert) {
      await this.deps.removeLidRequest().catch(() => {});
    }
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.releasing.add(child);
    // Closing stdin ends `cat` (Linux), which ends systemd-inhibit and drops the lock.
    child.stdin?.end();
    if (this.deps.platform === 'macos') {
      child.kill('SIGTERM');
      return;
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }, RELEASE_GRACE_MS);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue();
    }, RETRY_MS);
    this.retryTimer.unref?.();
  }

  private ensurePowerPoll(acOnly: boolean): void {
    if (!acOnly) {
      if (this.powerTimer) clearInterval(this.powerTimer);
      this.powerTimer = null;
      return;
    }
    if (this.powerTimer) return;
    this.powerTimer = setInterval(() => void this.enqueue(), POWER_POLL_MS);
    this.powerTimer.unref?.();
  }

  private clearTimers(): void {
    for (const t of [this.powerTimer, this.heartbeatTimer]) if (t) clearInterval(t);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.powerTimer = this.heartbeatTimer = this.retryTimer = null;
  }

  private setState(state: KeepAwakeStatus['state'], detail: string | null): void {
    // Log settled transitions only: a denied lock is retried every minute and would
    // otherwise log `starting` + `denied` forever on a box nobody logs in to.
    if (state !== 'starting' && state !== this.lastLoggedState) {
      this.lastLoggedState = state;
      console.log(`[keep-awake] ${state}${detail ? `: ${detail}` : ''}`);
    }
    this.status = { ...this.status, state, detail };
  }
}

/** The process-wide manager. */
export const keepAwake = new KeepAwakeManager();
