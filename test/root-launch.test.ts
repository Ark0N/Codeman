/**
 * @fileoverview A Codeman server that runs as root (uid 0) starts local Claude sessions
 * without the permission bypass.
 *
 * Claude Code exits on `--dangerously-skip-permissions` under uid 0 ("cannot be used with
 * root/sudo privileges for security reasons"). That flag is the default permission mode, so
 * a server installed and started as root (a VPS, an LXC container) showed a dead pane for
 * every local Claude session. Measured 2026-11-27 with the public installer in a fresh
 * `ubuntu:24.04` container.
 *
 * What is pinned here:
 *  - the pure rule (`applyRootValues`) and the registry data it reads (`rootValue`);
 *  - the uid helper is hermetic under vitest and only a stub makes it say "root";
 *  - under uid 0 the LOCAL command lines (tmux fresh + resume, direct PTY, one-shot) carry
 *    no bypass flag, and say so in one log line;
 *  - under any other uid every command line is byte-identical to the golden pins;
 *  - `auto`, `allowedTools` and `normal` are untouched under root;
 *  - remote and Docker pane commands never read the server's uid.
 *
 * Port: none (pure functions over registry data).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRootValues, describeRootValueChanges } from '../src/config/cli-registry/root-launch.js';
import { getCli } from '../src/config/cli-registry/registry.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import { DEFAULT_AGENT_IMAGE, defaultDockerCommandForMode, toSessionDocker } from '../src/docker-hosts.js';
import { buildInteractiveArgs, buildPromptArgs, directLaunchClaudeMode } from '../src/session-cli-builder.js';
import { buildSpawnCommandFromRegistry } from '../src/session-cli-registry-bridge.js';
import {
  buildDockerLaunchCommand,
  buildRemoteLaunchCommand,
  buildSpawnCommand,
  serverRootSpawnOptions,
  type DockerLaunchOptions,
} from '../src/tmux-manager.js';
import type { ClaudeMode, DockerCase, DockerHost, SessionMode, SessionRemote } from '../src/types.js';
import { serverRunsAsRoot, stubServerUidForTest } from '../src/utils/server-uid.js';

const SID = '0f9c2b14-1111-2222-3333-444455556666';
const BYPASS = '--dangerously-skip-permissions';

/** The golden pins of test/cli-registry-spawn-golden.test.ts, restated: the command lines of a launch that is not root. */
const GOLDEN_FRESH = `claude ${BYPASS} --session-id "${SID}"`;
const GOLDEN_RESUME = `claude ${BYPASS} --resume "abc-123-def" || claude ${BYPASS} --session-id "${SID}"`;

function claudeLaunch() {
  const entry = getCli('claude');
  if (!entry) throw new Error('no claude entry');
  return entry.launch;
}

/** The local tmux pane command, built the way `createSession` and `respawnPane` build it. */
function localCommand(extra: Partial<Parameters<typeof buildSpawnCommand>[0]> = {}, launchedElsewhere = false): string {
  const mode = (extra.mode ?? 'claude') as SessionMode;
  return buildSpawnCommand({
    mode,
    sessionId: SID,
    claudeCliVersion: null,
    ...extra,
    ...serverRootSpawnOptions({ mode, sessionId: SID, launchedElsewhere }),
  });
}

afterEach(() => {
  stubServerUidForTest(null);
  vi.restoreAllMocks();
});

describe('serverRunsAsRoot', () => {
  it('never reads the real uid under vitest, so the suite is the same when run as root', () => {
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    expect(serverRunsAsRoot()).toBe(false);
    expect(getuid).not.toHaveBeenCalled();
  });

  it('answers from the stubbed uid, asked again on every call', () => {
    stubServerUidForTest(0);
    expect(serverRunsAsRoot()).toBe(true);
    stubServerUidForTest(1000);
    expect(serverRunsAsRoot()).toBe(false);
    // A platform with no uid at all (process.getuid is absent on Windows).
    stubServerUidForTest(undefined);
    expect(serverRunsAsRoot()).toBe(false);
    stubServerUidForTest(null);
    expect(serverRunsAsRoot()).toBe(false);
  });
});

describe('the registry data', () => {
  it('declares the swap on the claude permission mode, and on nothing else', () => {
    const declared = STOCK_CLIS.flatMap((entry) =>
      Object.entries(entry.launch.params).flatMap(([param, spec]) =>
        spec.type === 'enum' && spec.rootValue ? [{ cli: entry.id as string, param, rootValue: spec.rootValue }] : []
      )
    );
    // A new line here is a decision about what another CLI does under root, to be measured first.
    expect(declared).toEqual([
      { cli: 'claude', param: 'claudeMode', rootValue: { 'dangerously-skip-permissions': 'normal' } },
    ]);
  });
});

describe('applyRootValues', () => {
  it('hands back the very object it was given when the launch is not root', () => {
    const params = { claudeMode: 'dangerously-skip-permissions' };
    const result = applyRootValues(claudeLaunch(), params, false);
    expect(result.params).toBe(params);
    expect(result.changes).toEqual([]);
  });

  it('swaps the bypass mode for normal under root, whether it was sent or is the default', () => {
    for (const params of [{}, { claudeMode: 'dangerously-skip-permissions' }, { claudeMode: 'no-such-mode' }]) {
      const before = { ...params };
      const result = applyRootValues(claudeLaunch(), params, true);
      expect(result.params.claudeMode).toBe('normal');
      expect(result.changes).toEqual([{ param: 'claudeMode', from: 'dangerously-skip-permissions', to: 'normal' }]);
      expect(params, 'the caller object is never mutated').toEqual(before);
    }
  });

  it('leaves every other mode alone under root', () => {
    for (const claudeMode of ['auto', 'allowedTools', 'normal']) {
      const params = { claudeMode, allowedTools: 'Read' };
      const result = applyRootValues(claudeLaunch(), params, true);
      expect(result.params, claudeMode).toBe(params);
      expect(result.changes, claudeMode).toEqual([]);
    }
  });

  it('keeps the other params of a launch it changes', () => {
    const result = applyRootValues(claudeLaunch(), { model: 'opus', resumeId: 'abc-123-def' }, true);
    expect(result.params).toEqual({ model: 'opus', resumeId: 'abc-123-def', claudeMode: 'normal' });
  });

  it('does nothing for a launch spec that declares no rootValue', () => {
    const codex = getCli('codex');
    if (!codex) throw new Error('no codex entry');
    const params = { dangerouslyBypassApprovals: true };
    expect(applyRootValues(codex.launch, params, true).params).toBe(params);
  });

  it('ignores a replacement the param does not declare (a hand-built spec the schema never saw)', () => {
    const launch = {
      params: { m: { type: 'enum' as const, values: ['a', 'b'], default: 'a', rootValue: { a: 'zzz' } } },
      variants: [{ id: 'new', args: [] }],
    };
    const params = {};
    const result = applyRootValues(launch, params, true);
    expect(result.params).toBe(params);
    expect(result.changes).toEqual([]);
  });

  it('describes the swap in one line that names the cause and the way out', () => {
    const line = describeRootValueChanges('Claude Code session 0f9c2b14', [
      { param: 'claudeMode', from: 'dangerously-skip-permissions', to: 'normal' },
    ]);
    expect(line).toContain('Claude Code session 0f9c2b14');
    expect(line).toContain('claudeMode "dangerously-skip-permissions" as "normal"');
    expect(line).toContain('runs as root (uid 0)');
    expect(line).toContain('normal user');
    expect(line).not.toContain('\n');
  });
});

describe('the local tmux pane command under a server that runs as root', () => {
  it('starts a fresh session without the bypass flag', () => {
    stubServerUidForTest(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(localCommand()).toBe(`claude --session-id "${SID}"`);
    expect(localCommand({ claudeMode: 'dangerously-skip-permissions' })).toBe(`claude --session-id "${SID}"`);
  });

  it('drops the flag from BOTH halves of the resume fallback', () => {
    stubServerUidForTest(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const command = localCommand({ resumeSessionId: 'abc-123-def' });
    expect(command).toBe(`claude --resume "abc-123-def" || claude --session-id "${SID}"`);
    expect(command).not.toContain(BYPASS);
  });

  it('is exactly the command an explicit normal mode gives, with every other flag kept', () => {
    stubServerUidForTest(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rest = {
      model: 'opus[1m]',
      effort: 'max' as const,
      advisorModel: 'opus',
      sessionName: 'w3-myapp',
      claudeCliVersion: '2.1.300',
      resumeSessionId: 'abc-123-def',
      statusLineCommand: '/tmp/exporter.sh',
    };
    const underRoot = localCommand(rest);
    stubServerUidForTest(1000);
    expect(underRoot).toBe(localCommand({ ...rest, claudeMode: 'normal' }));
    expect(underRoot).toContain('--model "opus[1m]"');
    expect(underRoot).toContain("--effort 'max'");
    expect(underRoot).toContain('--name "w3-myapp"');
  });

  it('says so in one log line per launch', () => {
    stubServerUidForTest(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localCommand();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(/^\[TmuxManager\] Claude Code session 0f9c2b14 /);
    expect(line).toContain('claudeMode "dangerously-skip-permissions" as "normal"');
    expect(line).toContain('runs as root (uid 0)');
    localCommand({ resumeSessionId: 'abc-123-def' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('leaves auto, allowedTools and normal exactly as they are, and logs nothing', () => {
    const cases: Array<{ claudeMode: ClaudeMode; allowedTools?: string }> = [
      { claudeMode: 'auto' },
      { claudeMode: 'allowedTools', allowedTools: 'Bash(git:*), Read' },
      { claudeMode: 'allowedTools' },
      { claudeMode: 'normal' },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const options of cases) {
      stubServerUidForTest(1000);
      const asUser = localCommand(options);
      const resumedAsUser = localCommand({ ...options, resumeSessionId: 'abc-123-def' });
      stubServerUidForTest(0);
      expect(localCommand(options), options.claudeMode).toBe(asUser);
      expect(localCommand({ ...options, resumeSessionId: 'abc-123-def' }), options.claudeMode).toBe(resumedAsUser);
    }
    expect(warn).not.toHaveBeenCalled();
    stubServerUidForTest(0);
    expect(localCommand({ claudeMode: 'auto' })).toBe(`claude --permission-mode auto --session-id "${SID}"`);
    expect(localCommand({ claudeMode: 'allowedTools', allowedTools: 'Bash(git:*), Read' })).toBe(
      `claude --allowedTools "Bash(git:*), Read" --session-id "${SID}"`
    );
  });

  it('renders every CLI that declares no rootValue the same as for a normal user', () => {
    const untouched = STOCK_CLIS.filter(
      (entry) => !Object.values(entry.launch.params).some((spec) => spec.type === 'enum' && spec.rootValue)
    ).map((entry) => entry.id as SessionMode);
    expect(untouched.length).toBeGreaterThanOrEqual(10);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const mode of untouched) {
      // Each CLI's own bypass switch is on, so a swap that leaked to another entry would show.
      const options = {
        mode,
        codexConfig: { dangerouslyBypassApprovals: true },
        antigravityConfig: { dangerouslySkipPermissions: true },
        geminiConfig: { approvalMode: 'yolo' as const },
        grokConfig: { alwaysApprove: true },
        copilotConfig: { allowAll: true },
      };
      stubServerUidForTest(1000);
      const asUser = localCommand(options);
      stubServerUidForTest(0);
      expect(localCommand(options), mode).toBe(asUser);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the local tmux pane command under any other uid', () => {
  it('adds nothing to the launch options, so the command is byte-identical', () => {
    for (const uid of [1000, 501, 1, undefined]) {
      stubServerUidForTest(uid);
      expect(serverRootSpawnOptions({ mode: 'claude', sessionId: SID, launchedElsewhere: false })).toEqual({});
      expect(localCommand()).toBe(GOLDEN_FRESH);
      expect(localCommand({ resumeSessionId: 'abc-123-def' })).toBe(GOLDEN_RESUME);
    }
  });

  it('is unchanged without a stub too (the hermetic default)', () => {
    expect(localCommand()).toBe(GOLDEN_FRESH);
    expect(localCommand({ resumeSessionId: 'abc-123-def' })).toBe(GOLDEN_RESUME);
  });

  it('never swaps on the bridge unless the caller said the launch runs as root', () => {
    // The bridge also renders commands that run under another account (the remote omp
    // relaunch), so it must not ask for the uid itself.
    stubServerUidForTest(0);
    const entry = getCli('claude');
    if (!entry) throw new Error('no claude entry');
    const onRootValue = vi.fn();
    expect(
      buildSpawnCommandFromRegistry(entry, { mode: 'claude', sessionId: SID, claudeCliVersion: null, onRootValue })
    ).toBe(GOLDEN_FRESH);
    expect(onRootValue).not.toHaveBeenCalled();
    expect(
      buildSpawnCommandFromRegistry(entry, {
        mode: 'claude',
        sessionId: SID,
        claudeCliVersion: null,
        runsAsServerRoot: true,
        onRootValue,
      })
    ).toBe(`claude --session-id "${SID}"`);
    expect(onRootValue).toHaveBeenCalledTimes(1);
  });
});

describe('remote and Docker launches', () => {
  const remote: SessionRemote = {
    hostId: 'gpu-box',
    label: 'GPU Box',
    host: '10.0.0.42',
    username: 'ubuntu',
    remotePath: '/home/ubuntu/work',
  };
  const HOST: DockerHost = { id: 'local', label: 'Local', image: DEFAULT_AGENT_IMAGE };
  const CASE: DockerCase = {
    name: 'myproj',
    type: 'docker',
    hostId: 'local',
    hostWorkspacePath: '/home/user/cases/myproj',
  };

  function dockerOpts(runsAsRoot?: boolean): DockerLaunchOptions {
    const docker = { ...toSessionDocker(HOST, CASE), ...(runsAsRoot === undefined ? {} : { runsAsRoot }) };
    return {
      mode: 'claude',
      docker,
      sessionId: '1a2b3c4d5e6f',
      createContext: {
        docker,
        sessionId: '1a2b3c4d5e6f',
        instance: '',
        userArgs: ['--user', '1000:0'],
        credentialMounts: [],
        extraMounts: [],
        envCreate: { HOME: '/home/agent' },
        addHostGateway: true,
        gatewayAlias: 'host.docker.internal',
      },
      execEnv: { TERM: 'xterm-256color', CODEMAN_SESSION_ID: '1a2b3c4d', CODEMAN_MUX: '1' },
      execEnvNames: [],
    };
  }

  it('add nothing to the launch options, whatever the server uid', () => {
    stubServerUidForTest(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(serverRootSpawnOptions({ mode: 'claude', sessionId: SID, launchedElsewhere: true })).toEqual({});
    // The local command built beside a remote or Docker launch is discarded; it must not log a swap that never ran.
    expect(localCommand({}, true)).toBe(GOLDEN_FRESH);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keep the remote claude pane command, bypass flag included, under a root server', () => {
    const build = (claudeMode?: ClaudeMode) =>
      buildRemoteLaunchCommand({ mode: 'claude', remote, sessionId: SID, claudeMode });
    stubServerUidForTest(1000);
    const asUser = { fresh: build(), auto: build('auto'), normal: build('normal') };
    stubServerUidForTest(0);
    expect(build()).toBe(asUser.fresh);
    expect(build('auto')).toBe(asUser.auto);
    expect(build('normal')).toBe(asUser.normal);
    expect(asUser.fresh).toContain(`claude ${BYPASS} --session-id ${SID}`);
    expect(asUser.normal).not.toContain(BYPASS);
  });

  it('keep the Docker pane command: the CONTAINER uid decides there, not the server uid', () => {
    stubServerUidForTest(1000);
    const asUser = { user: buildDockerLaunchCommand(dockerOpts()), root: buildDockerLaunchCommand(dockerOpts(true)) };
    stubServerUidForTest(0);
    expect(buildDockerLaunchCommand(dockerOpts())).toBe(asUser.user);
    expect(buildDockerLaunchCommand(dockerOpts(true))).toBe(asUser.root);
    expect(asUser.user).toContain(BYPASS);
    expect(asUser.root).not.toContain(BYPASS);
    expect(defaultDockerCommandForMode('claude')).toBe(`exec claude ${BYPASS}`);
    expect(defaultDockerCommandForMode('claude', true)).toBe('exec claude');
  });
});

describe('claude processes the server starts directly (direct PTY fallback, one-shot)', () => {
  it('carry no bypass flag under root, and log it', () => {
    stubServerUidForTest(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildInteractiveArgs(SID, 'dangerously-skip-permissions')).toEqual(['--session-id', SID]);
    expect(buildPromptArgs('hello')).toEqual(['-p', '--verbose', '--output-format', 'stream-json', 'hello']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[Session\] .*runs as root \(uid 0\)/);
  });

  it('are unchanged under any other uid', () => {
    for (const uid of [1000, undefined, null]) {
      stubServerUidForTest(uid);
      expect(buildInteractiveArgs(SID, 'dangerously-skip-permissions')).toEqual([BYPASS, '--session-id', SID]);
      expect(buildPromptArgs('hello')).toEqual(['-p', '--verbose', BYPASS, '--output-format', 'stream-json', 'hello']);
    }
  });

  it('keep auto, allowedTools and normal under root', () => {
    stubServerUidForTest(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildInteractiveArgs(SID, 'auto')).toEqual(['--permission-mode', 'auto', '--session-id', SID]);
    expect(buildInteractiveArgs(SID, 'allowedTools', undefined, 'Read')).toEqual([
      '--allowedTools',
      'Read',
      '--session-id',
      SID,
    ]);
    expect(buildInteractiveArgs(SID, 'normal')).toEqual(['--session-id', SID]);
    expect(buildPromptArgs('hello', undefined, 'auto')).toEqual([
      '-p',
      '--verbose',
      '--permission-mode',
      'auto',
      '--output-format',
      'stream-json',
      'hello',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('directLaunchClaudeMode is pure: the caller says whether the server is root', () => {
    const onChange = vi.fn();
    expect(directLaunchClaudeMode('dangerously-skip-permissions', false, onChange)).toBe(
      'dangerously-skip-permissions'
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(directLaunchClaudeMode('dangerously-skip-permissions', true, onChange)).toBe('normal');
    expect(onChange).toHaveBeenCalledTimes(1);
    for (const mode of ['auto', 'allowedTools', 'normal'] as const) {
      expect(directLaunchClaudeMode(mode, true, onChange)).toBe(mode);
    }
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
