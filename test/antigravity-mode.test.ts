import { describe, expect, it } from 'vitest';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { defaultDockerCommandForMode } from '../src/docker-hosts.js';
import { defaultRemoteCommandForMode } from '../src/remote-hosts.js';
import { isExternalCliMode, isAltScreenStripMode } from '../src/session.js';

describe('Antigravity mode schemas', () => {
  it('accepts Antigravity session creation config', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'antigravity',
      antigravityConfig: {
        model: 'gemini-3-pro',
        dangerouslySkipPermissions: true,
      },
    });

    expect(parsed.mode).toBe('antigravity');
    expect(parsed.antigravityConfig).toEqual({
      model: 'gemini-3-pro',
      dangerouslySkipPermissions: true,
    });
  });

  it('accepts Antigravity quick-start config', () => {
    const parsed = QuickStartSchema.parse({
      caseName: 'antigravity-case',
      mode: 'antigravity',
      antigravityConfig: {
        resumeConversationId: 'conv-1234abcd',
      },
    });

    expect(parsed.mode).toBe('antigravity');
    expect(parsed.antigravityConfig?.resumeConversationId).toBe('conv-1234abcd');
  });

  it('rejects unsafe Antigravity model strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'antigravity',
        antigravityConfig: { model: 'agy; rm -rf /' },
      })
    ).toThrow();
  });

  it('allows ANTIGRAVITY_* env overrides and still rejects unknown prefixes', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'antigravity',
      envOverrides: { ANTIGRAVITY_LOG_LEVEL: 'debug' },
    });
    expect(parsed.envOverrides).toEqual({ ANTIGRAVITY_LOG_LEVEL: 'debug' });

    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        envOverrides: { RANDOM_PREFIX_KEY: 'x' },
      })
    ).toThrow();
  });
});

describe('Antigravity spawn command', () => {
  it('builds a bare agy command when no config is sent (safe default, no bypass)', () => {
    const cmd = buildSpawnCommand({ mode: 'antigravity', sessionId: 'abc12345' });
    expect(cmd).toBe('agy');
  });

  it('adds --dangerously-skip-permissions only when explicitly requested', () => {
    const cmd = buildSpawnCommand({
      mode: 'antigravity',
      sessionId: 'abc12345',
      antigravityConfig: { dangerouslySkipPermissions: true, model: 'gemini-3-pro' },
    });
    expect(cmd).toBe('agy --dangerously-skip-permissions --model gemini-3-pro');
  });

  it('passes --conversation for resume and drops unsafe ids', () => {
    expect(
      buildSpawnCommand({
        mode: 'antigravity',
        sessionId: 'abc12345',
        antigravityConfig: { resumeConversationId: 'conv-99' },
      })
    ).toBe('agy --conversation conv-99');

    expect(
      buildSpawnCommand({
        mode: 'antigravity',
        sessionId: 'abc12345',
        antigravityConfig: { resumeConversationId: 'x; rm -rf /' },
      })
    ).toBe('agy');
  });

  it('drops unsafe model strings from the spawn command', () => {
    expect(
      buildSpawnCommand({
        mode: 'antigravity',
        sessionId: 'abc12345',
        antigravityConfig: { model: 'a`b' },
      })
    ).toBe('agy');
  });
});

describe('Antigravity mode gates', () => {
  it('is an external CLI mode (readiness/ralph/respawn gating)', () => {
    expect(isExternalCliMode('antigravity')).toBe(true);
  });

  it('is NOT an alt-screen strip mode (unverified Go TUI, like opencode)', () => {
    expect(isAltScreenStripMode('antigravity')).toBe(false);
  });

  it('has docker/remote default commands', () => {
    expect(defaultDockerCommandForMode('antigravity')).toBe('exec agy');
    // Routed through an interactive login shell so per-user PATH entries resolve —
    // same fix as the other remote agent CLIs (see defaultRemoteCommandForMode).
    expect(defaultRemoteCommandForMode('antigravity')).toBe(
      '{ set -- -i -l; case ${SHELL##*/} in csh|tcsh) set --;; esac; exec "${SHELL:-/bin/sh}" "$@" -c \'agy\'; }'
    );
  });
});
