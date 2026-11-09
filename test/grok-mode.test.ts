import { describe, expect, it } from 'vitest';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { defaultDockerCommandForMode } from '../src/docker-hosts.js';
import { defaultRemoteCommandForMode } from '../src/remote-hosts.js';
import { isExternalCliMode, isAltScreenStripMode } from '../src/session.js';

describe('Grok mode schemas', () => {
  it('accepts Grok session creation config', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'grok',
      grokConfig: {
        model: 'grok-4.5',
        alwaysApprove: true,
      },
    });

    expect(parsed.mode).toBe('grok');
    expect(parsed.grokConfig).toEqual({
      model: 'grok-4.5',
      alwaysApprove: true,
    });
  });

  it('accepts Grok quick-start config', () => {
    const parsed = QuickStartSchema.parse({
      caseName: 'grok-case',
      mode: 'grok',
      grokConfig: { resumeSessionId: '0198f2b4-aa10-7def-8123-4c5d6e7f8a9b', continueSession: true },
    });

    expect(parsed.mode).toBe('grok');
    expect(parsed.grokConfig?.resumeSessionId).toBe('0198f2b4-aa10-7def-8123-4c5d6e7f8a9b');
  });

  it('rejects unsafe Grok model strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'grok',
        grokConfig: { model: 'grok; rm -rf /' },
      })
    ).toThrow();
  });

  it('rejects unsafe Grok resumeSessionId values (ids only, never titles or paths)', () => {
    // grok's own --resume also matches session TITLES, which are arbitrary user
    // strings; the id regex is what keeps those (and paths) off the spawn line.
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'grok',
        grokConfig: { resumeSessionId: '../../etc/passwd' },
      })
    ).toThrow();
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'grok',
        grokConfig: { resumeSessionId: 'my session title' },
      })
    ).toThrow();
  });

  it('allows GROK_* and XAI_* env overrides but NOT bare provider keys', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'grok',
      envOverrides: { GROK_HOME: '/tmp/grok-home', XAI_API_KEY: 'xai-test' },
    });
    expect(parsed.envOverrides).toEqual({ GROK_HOME: '/tmp/grok-home', XAI_API_KEY: 'xai-test' });

    // XAI_* is xAI's own namespace (grok's documented auth var), the same
    // narrow-vendor-namespace reasoning that admitted GOOGLE_* for gemini.
    // Foreign provider keys stay out.
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'grok',
        envOverrides: { ANTHROPIC_API_KEY: 'sk-test' },
      })
    ).toThrow();
  });
});

describe('Grok spawn command', () => {
  it('builds a bare grok command when no config is sent (ask-mode default)', () => {
    const cmd = buildSpawnCommand({ mode: 'grok', sessionId: 'abc12345' });
    expect(cmd).toBe('grok');
  });

  it('maps alwaysApprove and model to flags', () => {
    const cmd = buildSpawnCommand({
      mode: 'grok',
      sessionId: 'abc12345',
      grokConfig: { alwaysApprove: true, model: 'grok-4.5' },
    });
    expect(cmd).toBe('grok --always-approve --model grok-4.5');
  });

  it('omits --always-approve when false or absent (grok defaults safe on its own)', () => {
    expect(buildSpawnCommand({ mode: 'grok', sessionId: 'a', grokConfig: { alwaysApprove: false } })).toBe('grok');
    expect(buildSpawnCommand({ mode: 'grok', sessionId: 'a', grokConfig: {} })).toBe('grok');
  });

  it('passes --resume for resume and skips --continue when both are present', () => {
    expect(buildSpawnCommand({ mode: 'grok', sessionId: 'a', grokConfig: { resumeSessionId: '0198f2b4' } })).toBe(
      'grok --resume 0198f2b4'
    );

    expect(buildSpawnCommand({ mode: 'grok', sessionId: 'a', grokConfig: { continueSession: true } })).toBe(
      'grok --continue'
    );

    // The two conflict upstream: a valid explicit session id wins.
    expect(
      buildSpawnCommand({
        mode: 'grok',
        sessionId: 'a',
        grokConfig: { continueSession: true, resumeSessionId: '0198f2b4' },
      })
    ).toBe('grok --resume 0198f2b4');
  });

  it('drops unsafe values rather than escaping them (the result lands in `bash -c "..."`)', () => {
    expect(buildSpawnCommand({ mode: 'grok', sessionId: 'a', grokConfig: { model: 'a`b' } })).toBe('grok');
    expect(buildSpawnCommand({ mode: 'grok', sessionId: 'a', grokConfig: { resumeSessionId: 'x; rm -rf /' } })).toBe(
      'grok'
    );
  });

  it('never puts a secret-shaped flag on the spawn line (XAI_API_KEY flows via tmux setenv)', () => {
    const cmd = buildSpawnCommand({
      mode: 'grok',
      sessionId: 'a',
      grokConfig: { model: 'grok-4.5', alwaysApprove: true },
    });
    expect(cmd).not.toContain('key');
    expect(cmd).not.toContain('token');
  });
});

describe('Grok mode gates', () => {
  it('is an external CLI mode (readiness/ralph/respawn gating)', () => {
    expect(isExternalCliMode('grok')).toBe(true);
  });

  it('is NOT an alt-screen strip mode (fullscreen alt-screen TUI with mouse support)', () => {
    expect(isAltScreenStripMode('grok')).toBe(false);
  });

  it('has docker/remote default commands', () => {
    expect(defaultDockerCommandForMode('grok')).toBe('exec grok');
    // Routed through an interactive login shell so ~/.grok/bin resolves,
    // the same fix as the other remote agent CLIs (see defaultRemoteCommandForMode).
    expect(defaultRemoteCommandForMode('grok')).toBe(
      '{ set -- -i -l; case ${SHELL##*/} in csh|tcsh) set --;; esac; exec "${SHELL:-/bin/sh}" "$@" -c \'grok\'; }'
    );
  });
});
