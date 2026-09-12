/**
 * DeepSeek Harness (`dsh`) run mode.
 *
 * The interesting assertions here are the ones that differ from every sibling
 * CLI, because dsh is shaped differently in two ways:
 *
 *  1. the agent is a PROFILE, not the binary, so the spawn line carries
 *     `--profile <name>` and a profile name has to be treated as a path segment;
 *  2. the permission switch is an ENV VAR (`DSH_PERMISSION_MODE`), not a flag,
 *     so the thing to pin is that nothing permission-shaped ever reaches the
 *     command line.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CreateSessionSchema, QuickStartSchema, HookEventSchema } from '../src/web/schemas.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { defaultDockerCommandForMode } from '../src/docker-hosts.js';
import { defaultRemoteCommandForMode } from '../src/remote-hosts.js';
import { isExternalCliMode, isAltScreenStripMode } from '../src/session.js';
import { hooksAvailableForMode, resolveWaitSignals, sessionHookOptions } from '../src/web/session-wait-registry.js';
import { _clampExternalCliBypassForOwner, _clampEnvOverridesForOwner } from '../src/web/routes/session-routes.js';
import { DEEPSEEK_STATE_TO_HOOK_EVENT } from '../src/deepseek-status-shim.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/utils/deepseek-cli-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/deepseek-cli-resolver.js')>();
  return { ...actual, resolveDefaultDeepSeekProfile: vi.fn(() => 'dsh-tui') };
});

describe('DeepSeek mode schemas', () => {
  it('accepts DeepSeek session creation config', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'deepseek',
      deepSeekConfig: { profile: 'dsh-tui', permissionMode: 'danger-full-access' },
    });

    expect(parsed.mode).toBe('deepseek');
    expect(parsed.deepSeekConfig).toEqual({ profile: 'dsh-tui', permissionMode: 'danger-full-access' });
  });

  it('accepts DeepSeek quick-start config', () => {
    const parsed = QuickStartSchema.parse({
      caseName: 'dsh-case',
      mode: 'deepseek',
      deepSeekConfig: { resumeSessionId: 'sess_01H9', statusReporting: false },
    });

    expect(parsed.mode).toBe('deepseek');
    expect(parsed.deepSeekConfig?.resumeSessionId).toBe('sess_01H9');
    expect(parsed.deepSeekConfig?.statusReporting).toBe(false);
  });

  it('rejects a profile name that is not a single path segment', () => {
    // A profile is BOTH interpolated into a `bash -c "…"` line and joined into a
    // filesystem path under $DSH_HOME/profiles, so separators and traversal have
    // to die at the schema boundary.
    for (const profile of ['../../etc/passwd', 'a/b', './x', '-rf', 'has space', 'semi;colon']) {
      expect(() =>
        CreateSessionSchema.parse({ workingDir: '/tmp', mode: 'deepseek', deepSeekConfig: { profile } })
      ).toThrow();
    }
  });

  it('rejects an unknown permission preset', () => {
    // The three presets are the harness's own; anything else would be exported
    // verbatim as DSH_PERMISSION_MODE and silently fall back to its default.
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'deepseek',
        deepSeekConfig: { permissionMode: 'yolo' },
      })
    ).toThrow();
  });

  it('rejects unsafe resumeSessionId values', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'deepseek',
        deepSeekConfig: { resumeSessionId: '../../etc/passwd' },
      })
    ).toThrow();
  });

  it('allows DSH_* and DEEPSEEK_* env overrides but not a foreign provider key', () => {
    const ok = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'deepseek',
      envOverrides: { DSH_HOME: '/tmp/dsh', DEEPSEEK_API_KEY: 'sk-test' },
    });
    expect(ok.envOverrides).toEqual({ DSH_HOME: '/tmp/dsh', DEEPSEEK_API_KEY: 'sk-test' });

    // A dsh settings.yaml can name ANY env var as a provider credential
    // (apiKeyEnv), which is pi's 34-provider-key problem in a new shape. The
    // allowlist is global, so admitting them would widen every mode at once.
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'deepseek',
        envOverrides: { QWEN5090_API_KEY: 'sk-test' },
      })
    ).toThrow();
  });
});

describe('DeepSeek spawn command', () => {
  it('boots the requested profile', () => {
    const cmd = buildSpawnCommand({
      mode: 'deepseek',
      sessionId: 's1',
      deepSeekConfig: { profile: 'dsh-tui' },
    });
    expect(cmd).toBe('dsh --profile dsh-tui');
  });

  it('falls back to the resolved default profile when none was requested', () => {
    const cmd = buildSpawnCommand({ mode: 'deepseek', sessionId: 's1' });
    expect(cmd).toBe('dsh --profile dsh-tui');
  });

  it('never puts anything permission-shaped on the command line', () => {
    // The harness has NO permission flag: the switch is the DSH_PERMISSION_MODE
    // env export, applied via `tmux setenv`. If this ever starts failing, someone
    // has invented a flag that does not exist.
    const cmd = buildSpawnCommand({
      mode: 'deepseek',
      sessionId: 's1',
      deepSeekConfig: { profile: 'dsh-tui', permissionMode: 'danger-full-access' },
    });
    expect(cmd).toBe('dsh --profile dsh-tui');
    expect(cmd).not.toMatch(/danger|approve|permission|yolo|dangerously/i);
  });

  it('prefers an explicit resume id over the most-recent form', () => {
    const cmd = buildSpawnCommand({
      mode: 'deepseek',
      sessionId: 's1',
      deepSeekConfig: { profile: 'p', resumeSession: true, resumeSessionId: 'sess_42' },
    });
    expect(cmd).toBe('dsh --profile p --resume sess_42');
  });

  it('resumes the most recent session when only the flag is set', () => {
    const cmd = buildSpawnCommand({
      mode: 'deepseek',
      sessionId: 's1',
      deepSeekConfig: { profile: 'p', resumeSession: true },
    });
    expect(cmd).toBe('dsh --profile p --resume');
  });

  it('drops an unsafe profile rather than interpolating it', () => {
    // Defense in depth behind the schema: builders must not trust their callers,
    // because this string is interpolated into a `bash -c "…"` argument.
    const cmd = buildSpawnCommand({
      mode: 'deepseek',
      sessionId: 's1',
      deepSeekConfig: { profile: 'evil; rm -rf /' },
    });
    expect(cmd).not.toContain('rm -rf');
    expect(cmd).toBe('dsh --profile dsh-tui');
  });
});

describe('DeepSeek mode wiring', () => {
  it('is an external CLI mode', () => {
    expect(isExternalCliMode('deepseek')).toBe(true);
  });

  it('is NOT an alt-screen strip mode', () => {
    // The strip is for Ink-style repaint TUIs (claude/codex/gemini). A dsh
    // terminal profile is a third-party fullscreen TUI, i.e. the opencode case.
    expect(isAltScreenStripMode('deepseek')).toBe(false);
  });

  it('has default remote and docker commands', () => {
    expect(defaultRemoteCommandForMode('deepseek')).toContain('dsh');
    expect(defaultDockerCommandForMode('deepseek')).toBe('exec dsh');
  });
});

describe('DeepSeek status bridge', () => {
  it('is the only non-claude mode allowed to deliver hook signals', () => {
    // Earned, not granted: the harness terminal front door REPORTS its state to
    // a supervisor, so `stop` and `blocked` for a dsh session are definitive
    // rather than inferred. Every other external CLI must keep failing this.
    expect(hooksAvailableForMode('deepseek')).toBe(true);
    expect(hooksAvailableForMode('claude')).toBe(true);
    for (const mode of ['shell', 'opencode', 'codex', 'gemini', 'antigravity', 'pi', 'grok'] as const) {
      expect(hooksAvailableForMode(mode)).toBe(false);
    }
  });

  it('is a per-SESSION answer for deepseek: a disarmed status bridge emits nothing', () => {
    // `statusReporting: false` is what stops _configureDeepSeek() exporting the
    // HERDR_* triple, and the triple is the ONLY reason a dsh session posts hook
    // events. Answering from the mode alone would accept `until=stop` on a
    // session where nothing can ever send one, which is the exact
    // infinite-wait-dressed-as-a-timeout this predicate exists to prevent.
    expect(hooksAvailableForMode('deepseek', { deepSeekStatusReporting: false })).toBe(false);
    expect(hooksAvailableForMode('deepseek', { deepSeekStatusReporting: true })).toBe(true);
    // Not sent = ON, so an ordinary session is unaffected.
    expect(hooksAvailableForMode('deepseek', {})).toBe(true);
    expect(hooksAvailableForMode('deepseek', { deepSeekStatusReporting: undefined })).toBe(true);
    // The flag is meaningless for every other mode and must not move them.
    expect(hooksAvailableForMode('claude', { deepSeekStatusReporting: false })).toBe(true);
    expect(hooksAvailableForMode('codex', { deepSeekStatusReporting: true })).toBe(false);
  });

  it('refuses an explicit stop/blocked on a dsh session whose bridge is off, and says why', () => {
    const off = { mode: 'deepseek' as const, deepSeekStatusReporting: false };
    const on = { mode: 'deepseek' as const };

    expect(resolveWaitSignals('stop', on)).toEqual({ until: ['stop'], error: null });

    const rejected = resolveWaitSignals('stop', off);
    expect(rejected.until).toEqual([]);
    // The generic "no Claude Code hooks" wording would send the caller hunting a
    // bug that is really a setting they chose, so this arm names the setting.
    expect(rejected.error).toContain('statusReporting');
    expect(rejected.error).not.toContain('no Claude Code hooks');

    // An OMITTED `until` must never 400: the hook-only signals are dropped from
    // the default set instead, leaving the two that still work.
    expect(resolveWaitSignals(undefined, off)).toEqual({ until: ['idle', 'exit'], error: null });
    expect(resolveWaitSignals(undefined, on).until).toContain('stop');
  });

  it('refuses stop/blocked on a docker or remote dsh session, where the bridge cannot reach the harness', () => {
    // `docker exec` does not carry the local tmux env into the container and the
    // remote shell never sees the local `HERDR_*` setenv, so such a session can
    // never post a hook event however statusReporting is set — accepting
    // `until=stop` there burns the caller's whole timeout on every turn.
    expect(hooksAvailableForMode('deepseek', { deepSeekBridgeUnreachable: true })).toBe(false);
    const unreachable = { mode: 'deepseek' as const, deepSeekBridgeUnreachable: true };
    const rejected = resolveWaitSignals('stop', unreachable);
    expect(rejected.until).toEqual([]);
    expect(rejected.error).toContain('container or on a remote host');
    // The default set degrades instead of erroring, exactly like the disarmed case.
    expect(resolveWaitSignals(undefined, unreachable)).toEqual({ until: ['idle', 'exit'], error: null });
    // sessionHookOptions() is what lifts the fact off a live session.
    expect(sessionHookOptions({ docker: { containerName: 'c' } }).deepSeekBridgeUnreachable).toBe(true);
    expect(sessionHookOptions({ remote: { hostId: 'h' } }).deepSeekBridgeUnreachable).toBe(true);
    expect(sessionHookOptions({}).deepSeekBridgeUnreachable).toBe(false);
  });

  it('keeps the hook predicate out of the two gates that mean "is this claude"', () => {
    // Read My Mind and intent capture read Claude's own transcript, so they mean
    // mode === 'claude'. They used to ask hooksAvailableForMode(), which was the
    // same question until `deepseek` earned a yes and silently widened both to a
    // mode with no transcript to read. Static, because the alternative is
    // standing up a predictor and a transcript watcher to observe one `if`.
    const rmm = readFileSync(join(process.cwd(), 'src/web/routes/readmymind-routes.ts'), 'utf-8');
    expect(rmm).toContain("session.mode !== 'claude'");
    // Comment lines dropped first: the comment above that `if` names the
    // predicate in order to explain why it is NOT the one being called there.
    const uncommented = (src: string) =>
      src
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
    expect(uncommented(rmm)).not.toMatch(/hooksAvailableForMode\(/);

    const server = readFileSync(join(process.cwd(), 'src/web/server.ts'), 'utf-8');
    expect(server).toContain("if (!session || session.mode !== 'claude') return;");
  });

  it('keeps the transcript reader off docker and remote-SSH sessions', () => {
    // A docker case's harness writes its transcript inside the CONTAINER's
    // ~/.dsh and a remote-SSH case's lives on the remote host, so the local
    // reader would scan a $DSH_HOME that can never hold the file and return
    // "nothing said yet" forever — starving an agent that polls the worker.
    // Those sessions must keep the pane segmenter. Static, because standing up
    // a docker/remote session in the unit harness is exactly what the tmux
    // test-mode mocks exist to avoid.
    //
    // The mode check itself is now a capability read (`transcript === 'deepseek-zstd'`) —
    // which reader understands this CLI's on-disk history is exactly the kind of fact the
    // CLI registry owns. What this test guards is unchanged and is the part that matters:
    // the two LOCATION exclusions beside it.
    const routes = readFileSync(join(process.cwd(), 'src/web/routes/session-routes.ts'), 'utf-8');
    expect(routes).toMatch(/capabilities\.transcript === 'deepseek-zstd' && !session\.docker && !session\.remote/);
  });

  it('maps the harness lifecycle states onto real hook events', () => {
    expect(DEEPSEEK_STATE_TO_HOOK_EVENT.idle).toBe('stop');
    expect(DEEPSEEK_STATE_TO_HOOK_EVENT.blocked).toBe('permission_prompt');
    expect(DEEPSEEK_STATE_TO_HOOK_EVENT.working).toBe('agent_working');
    // Every mapped event must be one the hook endpoint actually accepts, or the
    // bridge would post reports the schema silently rejects.
    for (const event of Object.values(DEEPSEEK_STATE_TO_HOOK_EVENT)) {
      expect(() => HookEventSchema.parse({ event, sessionId: 's1' })).not.toThrow();
    }
  });
});

describe('DeepSeek multi-user clamp', () => {
  const ORIGINAL = process.env.CODEMAN_MULTIUSER;
  beforeEach(() => {
    process.env.CODEMAN_MULTIUSER = '1';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = ORIGINAL;
  });

  it('clamps a sent danger-full-access down to workspace-write, not read-only', () => {
    // The clamp removes PRIVILEGE; it must not also break the session's ability
    // to edit its own workspace, which read-only would.
    return _clampExternalCliBypassForOwner('nobody', undefined, undefined, undefined, undefined, undefined, {
      permissionMode: 'danger-full-access',
    }).then((out) => {
      expect(out.deepSeekConfig?.permissionMode).toBe('workspace-write');
    });
  });

  it('leaves an ABSENT config absent (the only-if-sent branch)', async () => {
    // Omitting DSH_PERMISSION_MODE leaves the harness on its own workspace-write
    // preset, which still asks — so there is nothing to materialize, unlike pi.
    const out = await _clampExternalCliBypassForOwner(
      'nobody',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(out.deepSeekConfig).toBeUndefined();
  });
});

describe('DeepSeek multi-user clamp: the env-var half', () => {
  const ORIGINAL = process.env.CODEMAN_MULTIUSER;
  beforeEach(() => {
    process.env.CODEMAN_MULTIUSER = '1';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = ORIGINAL;
  });

  it('strips DSH_PERMISSION_MODE, which would otherwise undo the config clamp on the same request', async () => {
    // applyEnvOverrides() runs AFTER _configureDeepSeek() in tmux-manager, so an
    // override sent alongside the config lands last and WINS. Clamping the config
    // alone is therefore half a gate: this is the other half.
    const out = await _clampEnvOverridesForOwner('nobody', {
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_MODE: 'off',
    });
    expect(out).toEqual({ DSH_TELEMETRY_MODE: 'off' });
  });

  it('strips DSH_HOME, which points the launcher at a profile tree that executes at boot', async () => {
    const out = await _clampEnvOverridesForOwner('nobody', { DSH_HOME: '/home/attacker/evil-dsh' });
    expect(out).toEqual({});
  });

  it("strips DEEPSEEK_BASE_URL, which would aim the server's own forwarded API key at a foreign host", async () => {
    // _configureDeepSeek() exports the SERVER's DEEPSEEK_API_KEY into every dsh
    // pane, and applyEnvOverrides() lands after it — so a non-granted owner who
    // could set the base URL would have the operator's key sent as a bearer
    // credential to an endpoint of their choosing. Their OWN key stays settable:
    // that removes privilege rather than granting it.
    const out = await _clampEnvOverridesForOwner('nobody', {
      DEEPSEEK_BASE_URL: 'https://attacker.example/v1',
      DEEPSEEK_API_KEY: 'sk-their-own',
    });
    expect(out).toEqual({ DEEPSEEK_API_KEY: 'sk-their-own' });
  });

  it('leaves unrelated overrides alone, and returns the same object when there is nothing to strip', async () => {
    // CODEX_HOME is a poor "unrelated" example here — it is itself a privileged key
    // (codex's own registry entry), so a genuinely non-privileged one is needed to
    // prove the identity-return fast path, not just that DEEPSEEK_API_KEY is exempt.
    const input = { DEEPSEEK_API_KEY: 'sk-test', OPENCODE_LOG_LEVEL: 'debug' };
    const out = await _clampEnvOverridesForOwner('nobody', input);
    expect(out).toBe(input);
    expect(await _clampEnvOverridesForOwner('nobody', undefined)).toBeUndefined();
  });

  it('is a no-op in single-user mode', async () => {
    delete process.env.CODEMAN_MULTIUSER;
    const input = { DSH_PERMISSION_MODE: 'danger-full-access', DSH_HOME: '/opt/dsh' };
    // canUsernameRunPrivilegedCommands() returns true when !isMultiUserMode(), so
    // the single-user behaviour has to be byte-identical to before this clamp.
    expect(await _clampEnvOverridesForOwner(undefined, input)).toBe(input);
  });
});

describe('DeepSeek profile install is bounded for real', () => {
  it('runs in its own process group and escalates the kill to the whole tree', () => {
    // `dsh plugin add` fans out into package-manager resolver/build children, and
    // spawn's own `timeout` signals only the direct child: survivors hold the
    // inherited stdio pipes open, `close` never fires, and the held-open request
    // leaks forever. Same failure and same fix as runGit() in git-clone.ts.
    // Static, because reproducing it needs a real package manager that hangs.
    const src = readFileSync(join(process.cwd(), 'src/web/routes/system-routes.ts'), 'utf-8');
    const handler = src.slice(src.indexOf("app.post('/api/deepseek/install-profile'"));
    const body = handler.slice(0, handler.indexOf('app.post(', 1) + 1 || handler.length);
    expect(body).toContain('detached: true');
    expect(body).toContain('process.kill(-child.pid, signal)');
    expect(body).toContain("killTree('SIGTERM')");
    expect(body).toContain("killTree('SIGKILL')");
    // The built-in option is the thing that did NOT work here; it must not come back.
    expect(body).not.toContain('timeout: DEEPSEEK_INSTALL_TIMEOUT_MS');
  });
});
