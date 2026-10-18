/**
 * @fileoverview envOverrides allowlist: exact-key entries alongside the prefixes.
 *
 * CLAUDE_CONFIG_DIR (#255) relocates the Claude CLI's user config (credentials,
 * settings, stats) so a case can run on a separate Claude subscription. It starts
 * with `CLAUDE_`, not `CLAUDE_CODE_`, so the prefix allowlist alone rejects it;
 * ALLOWED_ENV_KEYS in schemas.ts admits it as an exact match. These tests pin:
 * the exact key is accepted, near-misses stay rejected (no accidental prefix
 * widening), blocked keys stay blocked, and the key survives persist filtering
 * (losing it on restart would silently move a session back to the default account).
 */

import { describe, it, expect } from 'vitest';
import { CreateSessionSchema } from '../src/web/schemas.js';
import { Session } from '../src/session.js';

describe('envOverrides exact-key allowlist', () => {
  it('accepts CLAUDE_CONFIG_DIR', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'claude',
      envOverrides: { CLAUDE_CONFIG_DIR: '/home/user/.claude-clients/acme' },
    });
    expect(parsed.envOverrides).toEqual({ CLAUDE_CONFIG_DIR: '/home/user/.claude-clients/acme' });
  });

  it('accepts CLAUDE_CONFIG_DIR alongside prefix-allowlisted keys', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'claude',
      envOverrides: {
        CLAUDE_CONFIG_DIR: '/home/user/.claude-clients/acme',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      },
    });
    expect(Object.keys(parsed.envOverrides ?? {})).toHaveLength(2);
  });

  it('rejects other CLAUDE_-prefixed keys (exact match only, no prefix widening)', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        envOverrides: { CLAUDE_SOMETHING_ELSE: 'x' },
      })
    ).toThrow();
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        envOverrides: { CLAUDE_CONFIG_DIR_EXTRA: '/tmp/x' },
      })
    ).toThrow();
  });

  it('rejects the shared GitHub token names (Copilot reads COPILOT_GITHUB_TOKEN, in its own prefix)', () => {
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      for (const mode of ['claude', 'shell', 'codex', 'copilot'] as const) {
        expect(() => CreateSessionSchema.parse({ workingDir: '/tmp', mode, envOverrides: { [key]: 'x' } })).toThrow();
      }
    }
    expect(() =>
      CreateSessionSchema.parse({ workingDir: '/tmp', mode: 'copilot', envOverrides: { COPILOT_GITHUB_TOKEN: 'x' } })
    ).not.toThrow();
  });

  it('still blocks security-sensitive keys', () => {
    for (const key of ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'CODEMAN_MUX_NAME']) {
      expect(() =>
        CreateSessionSchema.parse({
          workingDir: '/tmp',
          envOverrides: { [key]: 'x' },
        })
      ).toThrow();
    }
  });
});

describe('CLAUDE_CONFIG_DIR persistence', () => {
  it('survives the state.json persist filter (path, not a secret)', () => {
    const session = new Session({
      workingDir: '/tmp',
      envOverrides: {
        CLAUDE_CONFIG_DIR: '/home/user/.claude-clients/acme',
        OPENCODE_API_KEY: 'secret-must-not-persist',
      },
    });
    expect(session.getEnvOverridesForPersist()).toEqual({
      CLAUDE_CONFIG_DIR: '/home/user/.claude-clients/acme',
    });
  });
});
