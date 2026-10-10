/**
 * @fileoverview Pure decisions behind "Keep this computer awake while Codeman runs"
 * (src/keep-awake.ts): settings defaults, platform choice, power-source parsing, the
 * hold/release rule, the lock argv and the failure classification.
 *
 * Port: none (pure).
 */

import { describe, expect, it } from 'vitest';
import {
  LINUX_HELD_MARKER,
  LINUX_INHIBIT_WHAT,
  classifyInhibitFailure,
  isOnAcPowerLinux,
  isOnAcPowerMac,
  keepAwakePlatform,
  linuxInhibitArgs,
  macCaffeinateArgs,
  resolveKeepAwakeConfig,
  shouldHoldLock,
} from '../src/keep-awake.js';

describe('resolveKeepAwakeConfig', () => {
  it('is off unless explicitly enabled, and AC-only unless explicitly not', () => {
    expect(resolveKeepAwakeConfig({})).toEqual({ enabled: false, acOnly: true });
    expect(resolveKeepAwakeConfig({ keepAwakeEnabled: 'yes' })).toEqual({ enabled: false, acOnly: true });
    expect(resolveKeepAwakeConfig({ keepAwakeEnabled: true })).toEqual({ enabled: true, acOnly: true });
    expect(resolveKeepAwakeConfig({ keepAwakeEnabled: true, keepAwakeAcOnly: false })).toEqual({
      enabled: true,
      acOnly: false,
    });
  });
});

describe('keepAwakePlatform', () => {
  it('maps darwin and linux, and treats WSL as unsupported', () => {
    expect(keepAwakePlatform('darwin', '24.0.0')).toBe('macos');
    expect(keepAwakePlatform('linux', '6.8.0-124-generic')).toBe('linux');
    expect(keepAwakePlatform('linux', '5.15.153.1-microsoft-standard-WSL2')).toBe('unsupported');
    expect(keepAwakePlatform('win32', '10.0.22631')).toBe('unsupported');
  });
});

describe('isOnAcPowerLinux', () => {
  const battery = (status: string) => ({ type: 'Battery', status });
  it('a machine with no battery of its own is on external power', () => {
    expect(isOnAcPowerLinux([])).toBe(true);
    expect(isOnAcPowerLinux([{ type: 'Battery', status: 'Discharging', scope: 'Device' }])).toBe(true);
  });
  it('an online adapter means AC, all adapters offline means battery', () => {
    expect(isOnAcPowerLinux([{ type: 'Mains', online: true }, battery('Charging')])).toBe(true);
    expect(isOnAcPowerLinux([{ type: 'USB', online: true }, battery('Unknown')])).toBe(true);
    expect(isOnAcPowerLinux([{ type: 'Mains', online: false }, battery('Unknown')])).toBe(false);
  });
  it('falls back to the battery status when no adapter is listed', () => {
    expect(isOnAcPowerLinux([battery('Discharging')])).toBe(false);
    expect(isOnAcPowerLinux([battery('Full')])).toBe(true);
    expect(isOnAcPowerLinux([battery('Not charging')])).toBe(true);
    expect(isOnAcPowerLinux([battery('Unknown')])).toBe(null);
  });
});

describe('isOnAcPowerMac', () => {
  it('reads the source from `pmset -g batt`', () => {
    expect(isOnAcPowerMac("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;")).toBe(true);
    expect(isOnAcPowerMac("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%;")).toBe(false);
    expect(isOnAcPowerMac("Now drawing from 'UPS Power'")).toBe(false);
    expect(isOnAcPowerMac('')).toBe(null);
  });
});

describe('shouldHoldLock', () => {
  it('holds only when enabled, and on battery only when not AC-only', () => {
    expect(shouldHoldLock({ enabled: false, acOnly: false }, true)).toBe(false);
    expect(shouldHoldLock({ enabled: true, acOnly: true }, true)).toBe(true);
    expect(shouldHoldLock({ enabled: true, acOnly: true }, false)).toBe(false);
    expect(shouldHoldLock({ enabled: true, acOnly: false }, false)).toBe(true);
  });
  it('treats an unknown power source as AC (a desktop without battery reporting)', () => {
    expect(shouldHoldLock({ enabled: true, acOnly: true }, null)).toBe(true);
  });
});

describe('lock argv', () => {
  it('asks logind for the lid lock, not just sleep (LidSwitchIgnoreInhibited=yes ignores sleep)', () => {
    const args = linuxInhibitArgs();
    expect(LINUX_INHIBIT_WHAT.split(':')).toContain('handle-lid-switch');
    expect(args).toContain(`--what=${LINUX_INHIBIT_WHAT}`);
    expect(args).toContain('--mode=block');
  });
  it('ends in a cat on stdin, so the lock dies with the server', () => {
    const args = linuxInhibitArgs();
    const script = args[args.length - 1];
    expect(args.slice(-3, -1)).toEqual(['/bin/sh', '-c']);
    expect(script).toBe(`echo ${LINUX_HELD_MARKER}; exec cat`);
    expect(script).not.toMatch(/sleep/);
  });
  it('ties caffeinate to the server pid', () => {
    expect(macCaffeinateArgs(4242)).toEqual(['-i', '-s', '-w', '4242']);
  });
});

describe('classifyInhibitFailure', () => {
  it('reads a polkit refusal as denied', () => {
    expect(classifyInhibitFailure('Failed to inhibit: Access denied\n').state).toBe('denied');
    expect(classifyInhibitFailure('Interactive authentication required.').state).toBe('denied');
  });
  it('reads a missing logind as unavailable', () => {
    expect(classifyInhibitFailure('Failed to connect to bus: No such file or directory').state).toBe('unavailable');
  });
  it('keeps the first line of anything else', () => {
    const r = classifyInhibitFailure('something odd\nmore');
    expect(r).toEqual({ state: 'failed', detail: 'something odd' });
    expect(classifyInhibitFailure('').detail).toBe('the inhibitor exited');
  });
});
