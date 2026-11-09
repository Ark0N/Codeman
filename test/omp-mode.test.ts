import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { defaultDockerCommandForMode } from '../src/docker-hosts.js';
import { defaultRemoteCommandForMode } from '../src/remote-hosts.js';
import { isExternalCliMode, isAltScreenStripMode } from '../src/session.js';
import { _clampEnvOverridesForOwner } from '../src/web/routes/session-routes.js';

describe('OMP mode schemas', () => {
  it('accepts OMP session creation config', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'omp',
      ompConfig: {
        model: 'crof/glm-5.2',
      },
    });

    expect(parsed.mode).toBe('omp');
    expect(parsed.ompConfig).toEqual({
      model: 'crof/glm-5.2',
    });
  });

  it('accepts OMP quick-start config', () => {
    const parsed = QuickStartSchema.parse({
      caseName: 'omp-case',
      mode: 'omp',
      ompConfig: {
        resumeSessionId: 'session-1234abcd',
      },
    });

    expect(parsed.mode).toBe('omp');
    expect(parsed.ompConfig?.resumeSessionId).toBe('session-1234abcd');
  });

  it('rejects unsafe OMP model strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'omp',
        ompConfig: { model: 'omp; rm -rf /' },
      })
    ).toThrow();
  });

  it('allows OMP_* env overrides and still rejects unknown prefixes', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'omp',
      envOverrides: { OMP_PROFILE: 'work' },
    });
    expect(parsed.envOverrides).toEqual({ OMP_PROFILE: 'work' });

    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        envOverrides: { RANDOM_PREFIX_KEY: 'x' },
      })
    ).toThrow();
  });
});

describe('OMP spawn command', () => {
  it('builds a bare omp command when no config is sent', () => {
    const cmd = buildSpawnCommand({ mode: 'omp', sessionId: 'abc12345' });
    expect(cmd).toBe('omp');
  });

  it('passes --model and --resume, and drops unsafe ids', () => {
    expect(
      buildSpawnCommand({
        mode: 'omp',
        sessionId: 'abc12345',
        ompConfig: { model: 'crof/glm-5.2', resumeSessionId: 'session-99' },
      })
    ).toBe('omp --model crof/glm-5.2 --resume session-99');

    expect(
      buildSpawnCommand({
        mode: 'omp',
        sessionId: 'abc12345',
        ompConfig: { resumeSessionId: 'x; rm -rf /' },
      })
    ).toBe('omp');
  });

  it('continues the most recent session when no explicit resume id is given', () => {
    expect(
      buildSpawnCommand({
        mode: 'omp',
        sessionId: 'abc12345',
        ompConfig: { continueSession: true },
      })
    ).toBe('omp --continue');
  });

  it('prefers an explicit --resume id over --continue', () => {
    expect(
      buildSpawnCommand({
        mode: 'omp',
        sessionId: 'abc12345',
        ompConfig: { resumeSessionId: 'session-99', continueSession: true },
      })
    ).toBe('omp --resume session-99');
  });

  it('drops unsafe model strings from the spawn command', () => {
    expect(
      buildSpawnCommand({
        mode: 'omp',
        sessionId: 'abc12345',
        ompConfig: { model: 'a`b' },
      })
    ).toBe('omp');
  });
});

describe('OMP mode gates', () => {
  it('is an external CLI mode (readiness/ralph/respawn gating)', () => {
    expect(isExternalCliMode('omp')).toBe(true);
  });

  it('is NOT an alt-screen strip mode (unverified TUI, like opencode/antigravity)', () => {
    expect(isAltScreenStripMode('omp')).toBe(false);
  });

  it('has docker/remote default commands', () => {
    expect(defaultDockerCommandForMode('omp')).toBe('exec omp');
    // Routed through an interactive login shell so per-user PATH entries resolve —
    // same fix as the other remote agent CLIs (see defaultRemoteCommandForMode).
    expect(defaultRemoteCommandForMode('omp')).toBe(
      '{ set -- -i -l; case ${SHELL##*/} in csh|tcsh) set --;; esac; exec "${SHELL:-/bin/sh}" "$@" -c \'omp\'; }'
    );
  });
});

describe('OMP multi-user clamp: the env-var half', () => {
  // Unlike DeepSeek, omp has no permission FLAG or CONFIG for the clamp to
  // gate (buildOmpCommand() only ever emits --model/--resume/--continue), so
  // the only privilege surface is the two credential-resolution env vars the
  // OMP_* prefix admits.
  const ORIGINAL = process.env.CODEMAN_MULTIUSER;
  beforeEach(() => {
    process.env.CODEMAN_MULTIUSER = '1';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = ORIGINAL;
  });

  it('strips OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN, leaving unrelated overrides alone', async () => {
    const out = await _clampEnvOverridesForOwner('nobody', {
      OMP_AUTH_BROKER_URL: 'https://attacker.example/broker',
      OMP_AUTH_BROKER_TOKEN: 'stolen-token',
      OMP_PROFILE: 'default',
    });
    expect(out).toEqual({ OMP_PROFILE: 'default' });
  });

  it('is a no-op in single-user mode', async () => {
    delete process.env.CODEMAN_MULTIUSER;
    const input = { OMP_AUTH_BROKER_URL: 'https://attacker.example/broker' };
    expect(await _clampEnvOverridesForOwner(undefined, input)).toBe(input);
  });
});
