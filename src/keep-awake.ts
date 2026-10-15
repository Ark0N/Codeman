/**
 * @fileoverview Pure decisions behind "Keep this computer awake while Codeman runs"
 * (`keepAwakeEnabled`, SYNCED, default OFF; `keepAwakeAcOnly`, default ON).
 *
 * A laptop that suspends freezes every agent session: nothing runs while the lid is
 * closed, the phone loses its tailnet route to the dashboard, and in-flight API
 * requests and ssh links usually break. The IO side (`keep-awake-manager.ts`) holds an
 * OS-level sleep lock for exactly as long as Codeman runs; everything it has to decide
 * lives here so the tests exercise the shipped logic.
 *
 * What each platform's lock can and cannot do, measured rather than assumed:
 *
 * - **Linux (systemd-logind).** Lid-close suspend obeys only the LOW-level
 *   `handle-lid-switch` lock: logind's default `LidSwitchIgnoreInhibited=yes` makes it
 *   ignore a plain `sleep` lock for the lid. A `sleep` lock also never blocks a suspend
 *   requested by the SAME user (logind skips inhibitors whose uid matches the caller),
 *   so the desktop's own Automatic Suspend timer keeps working; it is the user's setting
 *   to change. polkit grants `handle-lid-switch` and `sleep` only to a process in an
 *   active login session, and a systemd user service is not in one: polkit then falls
 *   back to the user's display session, so the lock is granted while someone is logged
 *   in to the desktop and DENIED at a login screen (or on a headless box). The manager
 *   retries a denial, so logging in later picks it up.
 * - **macOS.** `caffeinate -i -s` (no root) blocks idle sleep, and system sleep while on
 *   AC power, but NOT lid-close sleep. Only `pmset -a disablesleep 1` keeps a closed
 *   MacBook awake, and that is a machine-wide root setting with no owner process, so the
 *   optional root helper (`scripts/keep-awake-macos.sh`, installed by `install.sh`)
 *   applies it while the server keeps a fresh request file, and undoes it when the file
 *   goes stale or disappears.
 */

/** Settings keys this feature reads. */
export interface KeepAwakeConfig {
  /** Hold a sleep lock while Codeman runs. Opt-in: only an explicit `true` enables. */
  enabled: boolean;
  /** Release the lock while the machine runs on battery. Default ON. */
  acOnly: boolean;
}

export type KeepAwakePlatform = 'linux' | 'macos' | 'unsupported';

/**
 * - `off`: the setting is off.
 * - `paused-battery`: `acOnly` and the machine is on battery.
 * - `starting`: a lock was requested and has not been confirmed yet.
 * - `active`: the lock is held.
 * - `denied`: Linux refused the lock (no active desktop login); retried periodically.
 * - `unavailable`: this machine has no usable mechanism (no systemd-logind, WSL, …).
 * - `failed`: anything else; retried periodically.
 */
export type KeepAwakeState = 'off' | 'paused-battery' | 'starting' | 'active' | 'denied' | 'unavailable' | 'failed';

export interface KeepAwakeStatus {
  enabled: boolean;
  acOnly: boolean;
  platform: KeepAwakePlatform;
  state: KeepAwakeState;
  /** Last known power source: true = AC, false = battery, null = unknown or not read. */
  onAc: boolean | null;
  /** macOS only: whether the root lid-close helper is installed. null elsewhere. */
  lidHelper: 'installed' | 'missing' | null;
  /** Short reason for `denied` / `unavailable` / `failed`, else null. */
  detail: string | null;
}

/** One entry of `/sys/class/power_supply/<name>/`. */
export interface PowerSupplyInfo {
  /** `type`: Mains, Battery, USB, UPS, Wireless, … */
  type: string;
  /** `online` for adapters (1/0); undefined when the file is absent. */
  online?: boolean;
  /** `status` for batteries: Charging, Discharging, Full, Not charging, Unknown. */
  status?: string;
  /** `scope`: `Device` marks a peripheral's battery (a mouse), not the machine's. */
  scope?: string;
}

/** Lock set requested from logind. Order is cosmetic; all three are block locks. */
export const LINUX_INHIBIT_WHAT = 'handle-lid-switch:sleep:idle';

/** Printed by the inhibitor's child once the lock is held (systemd-inhibit execs it only then). */
export const LINUX_HELD_MARKER = 'codeman-keep-awake-held';

/** Name of the request file the macOS lid helper watches, under the data dir. */
export const MAC_LID_REQUEST_FILE = 'keep-awake-lid.pid';

/** The LaunchDaemon the installer writes for the macOS lid helper. */
export const MAC_LID_HELPER_PLIST = '/Library/LaunchDaemons/com.codeman.keepawake.plist';

/** How often the server refreshes the macOS request file. The helper treats it as stale after 2 minutes. */
export const MAC_LID_HEARTBEAT_MS = 30_000;

/** How often the power source is re-read while `acOnly` is on. */
export const POWER_POLL_MS = 30_000;

/** Delay before retrying a denied or failed lock. */
export const RETRY_MS = 60_000;

/** Settings → config. Absent `keepAwakeEnabled` is OFF; absent `keepAwakeAcOnly` is ON. */
export function resolveKeepAwakeConfig(settings: Record<string, unknown>): KeepAwakeConfig {
  return {
    enabled: settings.keepAwakeEnabled === true,
    acOnly: settings.keepAwakeAcOnly !== false,
  };
}

/**
 * Which mechanism applies. WSL is unsupported even though it may have systemd: the
 * Windows host decides when the machine sleeps, and a lock inside the VM does nothing.
 */
export function keepAwakePlatform(platform: string, kernelRelease: string): KeepAwakePlatform {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return /microsoft/i.test(kernelRelease) ? 'unsupported' : 'linux';
  return 'unsupported';
}

/**
 * Linux power source from `/sys/class/power_supply`. Peripheral batteries
 * (`scope=Device`) are ignored. A machine with no battery of its own runs on external
 * power by definition; otherwise any online adapter means AC, adapters that are all
 * offline mean battery, and a machine that lists no adapter at all falls back to the
 * battery's own charging status. null when nothing conclusive is reported.
 */
export function isOnAcPowerLinux(supplies: readonly PowerSupplyInfo[]): boolean | null {
  const system = supplies.filter((s) => (s.scope ?? '').toLowerCase() !== 'device');
  const batteries = system.filter((s) => s.type === 'Battery');
  if (batteries.length === 0) return true;
  const adapters = system.filter((s) => s.type !== 'Battery' && s.online !== undefined);
  if (adapters.some((s) => s.online)) return true;
  if (adapters.length > 0) return false;
  const statuses = batteries.map((b) => (b.status ?? '').toLowerCase());
  if (statuses.includes('discharging')) return false;
  if (statuses.some((s) => s === 'charging' || s === 'full' || s === 'not charging')) return true;
  return null;
}

/** macOS power source from `pmset -g batt` (first line names the source). */
export function isOnAcPowerMac(pmsetBatt: string): boolean | null {
  const m = /drawing from '([^']+)'/.exec(pmsetBatt);
  if (!m) return null;
  if (m[1] === 'AC Power') return true;
  if (m[1] === 'Battery Power' || m[1] === 'UPS Power') return false;
  return null;
}

/**
 * Whether the lock should be held right now. An unknown power source counts as AC:
 * it is what a desktop or VM without battery reporting looks like.
 */
export function shouldHoldLock(config: KeepAwakeConfig, onAc: boolean | null): boolean {
  if (!config.enabled) return false;
  if (!config.acOnly) return true;
  return onAc !== false;
}

/**
 * argv for `systemd-inhibit`. The child it runs announces the lock and then becomes
 * `cat` on a stdin pipe from the server: when the server exits for ANY reason (a
 * SIGKILL included) the pipe closes, `cat` exits, and logind drops the lock. That
 * matters because the shipped unit uses `KillMode=process`, which leaves children
 * running on stop; a `sleep infinity` child would hold the lock forever.
 */
export function linuxInhibitArgs(): string[] {
  return [
    `--what=${LINUX_INHIBIT_WHAT}`,
    '--who=Codeman',
    '--why=Keeping agent sessions running',
    '--mode=block',
    '/bin/sh',
    '-c',
    `echo ${LINUX_HELD_MARKER}; exec cat`,
  ];
}

/**
 * argv for `caffeinate`: `-i` idle sleep, `-s` system sleep on AC power. `-w` ties
 * the assertion to the server's pid, so it ends when the server does, crash included.
 */
export function macCaffeinateArgs(serverPid: number): string[] {
  return ['-i', '-s', '-w', String(serverPid)];
}

/** Classify why `systemd-inhibit` exited before the lock was confirmed. */
export function classifyInhibitFailure(stderr: string): { state: 'denied' | 'unavailable' | 'failed'; detail: string } {
  const text = stderr.trim();
  if (/access denied|not authori[sz]ed|interactive authentication required/i.test(text)) {
    return {
      state: 'denied',
      detail: 'Linux refused the sleep lock: no one is logged in to a desktop session on this machine.',
    };
  }
  if (/failed to connect to (system )?bus|no such file or directory|not found|unknown (unit|object)/i.test(text)) {
    return { state: 'unavailable', detail: 'systemd-logind is not reachable on this machine.' };
  }
  const firstLine = text.split('\n')[0]?.slice(0, 200) || 'the inhibitor exited';
  return { state: 'failed', detail: firstLine };
}
