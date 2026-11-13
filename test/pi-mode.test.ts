import { describe, expect, it } from 'vitest';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { defaultDockerCommandForMode } from '../src/docker-hosts.js';
import { defaultRemoteCommandForMode, buildRemoteCliVersionProbeCommand } from '../src/remote-hosts.js';
import { isExternalCliMode, isAltScreenStripMode } from '../src/session.js';

describe('Pi mode schemas', () => {
  it('accepts Pi session creation config', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'pi',
      piConfig: {
        model: 'sonnet:high',
        provider: 'anthropic',
        thinking: 'high',
      },
    });

    expect(parsed.mode).toBe('pi');
    expect(parsed.piConfig).toEqual({
      model: 'sonnet:high',
      provider: 'anthropic',
      thinking: 'high',
    });
  });

  it('accepts Pi quick-start config', () => {
    const parsed = QuickStartSchema.parse({
      caseName: 'pi-case',
      mode: 'pi',
      piConfig: { resumeSessionId: '0f9c2b14-aa10', continueSession: true },
    });

    expect(parsed.mode).toBe('pi');
    expect(parsed.piConfig?.resumeSessionId).toBe('0f9c2b14-aa10');
  });

  it('accepts a provider-qualified model (`openai/gpt-4o`)', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'pi',
      piConfig: { model: 'openai/gpt-4o' },
    });
    expect(parsed.piConfig?.model).toBe('openai/gpt-4o');
  });

  it('rejects unsafe Pi model strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'pi',
        piConfig: { model: 'pi; rm -rf /' },
      })
    ).toThrow();
  });

  it('rejects unsafe Pi provider strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'pi',
        piConfig: { provider: 'anthropic`whoami`' },
      })
    ).toThrow();
  });

  it('rejects unsafe Pi resumeSessionId values (ids only, never paths)', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'pi',
        piConfig: { resumeSessionId: '../../etc/passwd' },
      })
    ).toThrow();
  });

  it('rejects thinking levels outside pi’s enum', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'pi',
        piConfig: { thinking: 'ultra' },
      })
    ).toThrow();
  });

  it('allows PI_* env overrides but NOT bare provider keys', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'pi',
      envOverrides: { PI_OFFLINE: '1' },
    });
    expect(parsed.envOverrides).toEqual({ PI_OFFLINE: '1' });

    // Pi's ~34 provider key vars share no prefix, and ALLOWED_ENV_PREFIXES is a single
    // GLOBAL list with no mode context — allowlisting them for pi would widen the
    // allowlist for every mode at once. They stay out; auth goes through pi's /login.
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'pi',
        envOverrides: { ANTHROPIC_API_KEY: 'sk-test' },
      })
    ).toThrow();
  });
});

describe('Pi spawn command', () => {
  it('builds a bare pi command when no config is sent (pi has no permission prompts)', () => {
    const cmd = buildSpawnCommand({ mode: 'pi', sessionId: 'abc12345' });
    expect(cmd).toBe('pi');
  });

  it('maps model/provider/thinking to flags', () => {
    const cmd = buildSpawnCommand({
      mode: 'pi',
      sessionId: 'abc12345',
      piConfig: { model: 'sonnet:high', provider: 'anthropic', thinking: 'xhigh' },
    });
    expect(cmd).toBe('pi --model sonnet:high --provider anthropic --thinking xhigh');
  });

  it('emits --approve for true and --no-approve for false (tri-state project trust)', () => {
    expect(buildSpawnCommand({ mode: 'pi', sessionId: 'a', piConfig: { approveProjectTrust: true } })).toBe(
      'pi --approve'
    );
    expect(buildSpawnCommand({ mode: 'pi', sessionId: 'a', piConfig: { approveProjectTrust: false } })).toBe(
      'pi --no-approve'
    );
    // Absent = pi's own defaultProjectTrust; Codeman must not decide it.
    expect(buildSpawnCommand({ mode: 'pi', sessionId: 'a', piConfig: {} })).toBe('pi');
  });

  it('passes --session for resume and skips -c when both are present', () => {
    expect(buildSpawnCommand({ mode: 'pi', sessionId: 'a', piConfig: { resumeSessionId: '0f9c2b14' } })).toBe(
      'pi --session 0f9c2b14'
    );

    expect(buildSpawnCommand({ mode: 'pi', sessionId: 'a', piConfig: { continueSession: true } })).toBe('pi -c');

    // The two conflict upstream: a valid explicit session id wins.
    expect(
      buildSpawnCommand({
        mode: 'pi',
        sessionId: 'a',
        piConfig: { continueSession: true, resumeSessionId: '0f9c2b14' },
      })
    ).toBe('pi --session 0f9c2b14');
  });

  it('drops unsafe values rather than escaping them (the result lands in `bash -c "..."`)', () => {
    expect(buildSpawnCommand({ mode: 'pi', sessionId: 'a', piConfig: { model: 'a`b' } })).toBe('pi');
    expect(buildSpawnCommand({ mode: 'pi', sessionId: 'a', piConfig: { provider: 'x;id' } })).toBe('pi');
    expect(buildSpawnCommand({ mode: 'pi', sessionId: 'a', piConfig: { resumeSessionId: 'x; rm -rf /' } })).toBe('pi');
    // An out-of-enum thinking level never reaches the command line either.
    expect(
      buildSpawnCommand({
        mode: 'pi',
        sessionId: 'a',
        piConfig: { thinking: 'ultra' as unknown as 'high' },
      })
    ).toBe('pi');
  });

  it('never emits --api-key (a provider secret must not reach the spawn line)', () => {
    const cmd = buildSpawnCommand({
      mode: 'pi',
      sessionId: 'a',
      piConfig: { model: 'sonnet', provider: 'anthropic', approveProjectTrust: true },
    });
    expect(cmd).not.toContain('--api-key');
  });
});

describe('Pi mode gates', () => {
  it('is an external CLI mode (readiness/ralph/respawn gating)', () => {
    expect(isExternalCliMode('pi')).toBe(true);
  });

  it('is NOT an alt-screen strip mode (main-screen TUI + runtime-switchable fullscreen)', () => {
    expect(isAltScreenStripMode('pi')).toBe(false);
  });

  it('has docker/remote default commands', () => {
    expect(defaultDockerCommandForMode('pi')).toBe('exec pi');
    // Routed through an interactive login shell so npm's global bin resolves —
    // same fix as the other remote agent CLIs (see defaultRemoteCommandForMode).
    expect(defaultRemoteCommandForMode('pi')).toBe(
      '{ set -- -i -l; case ${SHELL##*/} in csh|tcsh) set --;; esac; exec "${SHELL:-/bin/sh}" "$@" -c \'pi\'; }'
    );
  });

  it('probes the CLI version on a remote host (REMOTE_CLI_BIN carries pi)', () => {
    // Without the REMOTE_CLI_BIN entry this returns null and Session.cliVersion stays
    // blank for every remote pi session, which is invisible until someone asks why the
    // version column is empty on that host only.
    const cmd = buildRemoteCliVersionProbeCommand({ username: 'dev', host: 'box.example', port: 22 }, 'pi');
    expect(cmd).not.toBeNull();
    expect(cmd).toContain('pi --version');
  });
});
