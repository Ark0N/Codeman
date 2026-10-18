/**
 * @fileoverview The three per-mode predicates that used to be hand-written id lists, and the
 * invariant that they are INDEPENDENT.
 *
 * `isExternalCliMode()`, `isAltScreenStripMode()` and `hooksAvailableForMode()` describe three
 * different, deliberately unequal sets. Deriving any one of them from another looks like a
 * tidy-up and has already shipped a bug: `shell` has no hooks but is NOT an external CLI, so
 * a hooks predicate written as `!isExternalCliMode()` accepted `until=stop` on a shell session
 * and then blocked the caller for their entire timeout — an infinite wait wearing a timeout's
 * clothes, which is precisely what that guard exists to prevent.
 *
 * Keeping them as three separate `CliCapabilities` fields makes that structural. This file is
 * what stops someone collapsing them again.
 *
 * Port: none (pure predicates over registry data).
 */

import { describe, it, expect } from 'vitest';
import { isExternalCliMode, isAltScreenStripMode } from '../src/session.js';
import { hooksAvailableForMode } from '../src/web/session-wait-registry.js';
import { enabledCliIds } from '../src/config/cli-registry/registry.js';
import type { SessionMode } from '../src/types/session.js';

const MODES = enabledCliIds() as SessionMode[];

describe('per-mode capability predicates', () => {
  it.each([
    // mode           external  altScreenStrip  hooks
    ['claude', false, true, true],
    ['shell', false, false, false],
    ['opencode', true, false, false],
    ['codex', true, true, false],
    ['gemini', true, true, false],
    ['antigravity', true, false, false],
    ['pi', true, false, false],
    ['grok', true, false, false],
    ['deepseek', true, false, true],
    ['omp', true, false, false],
    ['copilot', true, false, false],
  ] as Array<[SessionMode, boolean, boolean, boolean]>)(
    '%s: external=%s altScreenStrip=%s hooks=%s',
    (mode, external, altScreen, hooks) => {
      expect(isExternalCliMode(mode)).toBe(external);
      expect(isAltScreenStripMode(mode)).toBe(altScreen);
      expect(hooksAvailableForMode(mode)).toBe(hooks);
    }
  );

  it('covers every enabled mode (sanity)', () => {
    // If a CLI is added without a row above, this fails rather than the table silently
    // describing a subset of reality.
    expect(MODES.length).toBe(11);
  });

  it('keeps the three predicates genuinely distinct', () => {
    // Not "they happen to differ today" — each pair differs on a NAMED mode, and each of
    // those disagreements is load-bearing.
    const external = MODES.filter(isExternalCliMode);
    const altScreen = MODES.filter(isAltScreenStripMode);
    const hooks = MODES.filter((m) => hooksAvailableForMode(m));

    expect(external).not.toEqual(altScreen);
    expect(external).not.toEqual(hooks);
    expect(altScreen).not.toEqual(hooks);

    // claude is the mode that separates all three: not external, IS stripped, HAS hooks.
    expect(isExternalCliMode('claude')).toBe(false);
    expect(isAltScreenStripMode('claude')).toBe(true);
    expect(hooksAvailableForMode('claude')).toBe(true);
    // deepseek is external AND has hooks — the pairing that makes "external ⇒ no hooks" false.
    expect(isExternalCliMode('deepseek')).toBe(true);
    expect(hooksAvailableForMode('deepseek')).toBe(true);
  });

  it('does not accept a hook-only wait on a shell session', () => {
    // The exact historical bug, reproduced. `shell` is not external, so any hooks predicate
    // derived from `isExternalCliMode` would answer true here and hang the caller.
    expect(isExternalCliMode('shell')).toBe(false);
    expect(hooksAvailableForMode('shell')).toBe(false);
  });

  it("treats deepseek's hooks as a per-SESSION question, not a per-mode one", () => {
    // 'supervised': real signals, but only while this session's bridge is actually armed and
    // reachable. Answering from the mode alone promises a `stop` that never arrives.
    expect(hooksAvailableForMode('deepseek')).toBe(true);
    expect(hooksAvailableForMode('deepseek', { deepSeekStatusReporting: false })).toBe(false);
    expect(hooksAvailableForMode('deepseek', { deepSeekBridgeUnreachable: true })).toBe(false);
    // claude's are unconditional, so the same options change nothing.
    expect(hooksAvailableForMode('claude', { deepSeekStatusReporting: false })).toBe(true);
    expect(hooksAvailableForMode('claude', { deepSeekBridgeUnreachable: true })).toBe(true);
  });

  it('falls back conservatively for an unregistered mode', () => {
    const unknown = 'not-a-cli' as SessionMode;
    // External: disables Claude-specific parsing rather than pointing it at foreign output.
    expect(isExternalCliMode(unknown)).toBe(true);
    // No hooks: never promise a signal nothing will send.
    expect(hooksAvailableForMode(unknown)).toBe(false);
    // No full strip: leaving the alt screen alone is the safe default for an unknown TUI.
    expect(isAltScreenStripMode(unknown)).toBe(false);
  });
});
