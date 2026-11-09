/**
 * @fileoverview Custom Model Endpoint Profiles, the Session half of applying and
 * clearing a selection against a live pane (`Session.setCustomModel()` +
 * `Session.restartCli()`), pinned against the four ways the first cut broke a
 * working session:
 *
 * 1. Clearing did not clear. The injected vars reach the CLI via `tmux setenv`,
 *    which persists at the tmux-session level and is inherited by `respawn-pane`,
 *    so removing them from `_envOverrides` relaunched the CLI still pointed at the
 *    endpoint (and, for the configDir kinds, at a `HOME`/`CODEX_HOME` that had just
 *    been deleted). The retired keys must ride `RespawnPaneOptions.unsetEnvKeys`.
 * 2. Applying to a local claude session killed the pane: the relaunch was
 *    `claude --session-id <id>` and Claude refuses an id that already has a
 *    transcript, so it needs the `--resume <id> || --session-id <id>` shape the
 *    docker and remote pane commands use, i.e. a pinned resume id. The pin is
 *    gated on that transcript existing, so these tests write one.
 * 3. pi/omp/grok wrote their config file and then launched without the `--model`
 *    that selects it, so the file was ignored.
 * 4. A value the session set itself under an injected key was overwritten, then deleted
 *    with the injected one on clear: an own `DSH_HOME` fell back to the server's tree and
 *    an own `CLAUDE_CONFIG_DIR` silently moved the session to the default Claude account.
 *
 * Drives a real `Session` against the in-memory tmux layer vitest substitutes,
 * spying on `respawnPane` to read the options the relaunch would get.
 * Port: N/A.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { buildCustomModelInjection } from '../src/custom-model-injection.js';
import {
  applyCustomModelInjection,
  customModelConfigDir,
  removeConfigDir,
} from '../src/custom-model-injection-apply.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession, SessionMode } from '../src/types.js';

const workingDir = join(homedir(), 'codeman-cases', 'custom-model-restart');
const projectsDir = join(homedir(), '.claude', 'projects', '-custom-model-restart');
const sessions: Session[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) s.stop();
  rmSync(workingDir, { recursive: true, force: true });
  // Only the directory these tests create. `setup.ts` gives each test file a
  // temp HOME, but a wider sweep here would delete a real `~/.claude` the day
  // that stops being true.
  rmSync(projectsDir, { recursive: true, force: true });
});

/**
 * Write the transcript Claude would have written for a conversation. A pane
 * `restartCli()` relaunches is a WORKING one, so its conversation has a
 * transcript on disk; that is both what makes the bare `--session-id` collide
 * and what the pin is now gated on.
 */
function giveTranscript(conversationId: string): void {
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(projectsDir, `${conversationId}.jsonl`), '{"type":"user"}\n');
}

function liveSession(mode: SessionMode, extra: Record<string, unknown> = {}) {
  mkdirSync(workingDir, { recursive: true });
  const mux = new TmuxManager();
  const muxSession: MuxSession = {
    sessionId: 'placeholder',
    muxName: 'codeman-cafe0001',
    pid: 1,
    createdAt: Date.now(),
    workingDir,
    mode,
    attached: false,
  };
  const session = new Session({ workingDir, mode, mux, useMux: true, muxSession, ...extra });
  sessions.push(session);
  vi.spyOn(mux, 'muxSessionExists').mockReturnValue(true);
  const respawn = vi.spyOn(mux, 'respawnPane').mockResolvedValue(4242);
  return { session, respawn };
}

const CLAUDE_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_DEFAULT_SONNET_MODEL'];
const claudeEnv = {
  ANTHROPIC_BASE_URL: 'http://box:8080',
  ANTHROPIC_API_KEY: 'k',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'q',
};

describe('clearing a selection unsets what it injected', () => {
  it('queues the retired keys for setenv -u on the next respawn and drops them from the overrides', async () => {
    const { session, respawn } = liveSession('claude', { envOverrides: { CLAUDE_CODE_KEEP: '1' } });
    session.setCustomModel({ endpointId: 'ep', modelId: 'q', envKeys: CLAUDE_KEYS }, claudeEnv);

    const result = session.setCustomModel(undefined);
    expect(result.removedEnvKeys).toEqual(CLAUDE_KEYS);
    expect(session.customModel).toBeUndefined();

    expect(await session.restartCli()).toBe(true);
    const options = respawn.mock.calls[0][0];
    expect(options.unsetEnvKeys).toEqual(CLAUDE_KEYS);
    expect(options.envOverrides).toEqual({ CLAUDE_CODE_KEEP: '1' });

    // Drained once the respawn succeeded: the next relaunch has nothing to unset.
    respawn.mockClear();
    await session.restartCli();
    expect(respawn.mock.calls[0][0].unsetEnvKeys).toBeUndefined();
  });

  it('switching endpoints re-sets the shared keys instead of unsetting them', async () => {
    const { session, respawn } = liveSession('claude');
    session.setCustomModel({ endpointId: 'a', modelId: 'q', envKeys: CLAUDE_KEYS }, claudeEnv);
    const next = { ...claudeEnv, ANTHROPIC_BASE_URL: 'http://other:8080' };
    session.setCustomModel({ endpointId: 'b', modelId: 'q', envKeys: CLAUDE_KEYS }, next);

    await session.restartCli();
    const options = respawn.mock.calls[0][0];
    expect(options.unsetEnvKeys).toBeUndefined();
    expect(options.envOverrides?.ANTHROPIC_BASE_URL).toBe('http://other:8080');
  });

  it('reports the previous config dir so the caller can delete it, and never leaks bookkeeping on the wire', () => {
    const { session } = liveSession('pi');
    session.setCustomModel(
      { endpointId: 'ep', modelId: 'q', envKeys: ['HOME'], configDir: '/tmp/cfg-1', launchModel: 'custom/q' },
      { HOME: '/tmp/cfg-1' }
    );
    expect(session.customModel).toEqual({ endpointId: 'ep', modelId: 'q', label: undefined });
    expect(session.toState().customModel).toEqual({ endpointId: 'ep', modelId: 'q', label: undefined });
    expect(session.getCustomModelForPersist()).toEqual({
      endpointId: 'ep',
      modelId: 'q',
      label: undefined,
      envKeys: ['HOME'],
      configDir: '/tmp/cfg-1',
      launchModel: 'custom/q',
    });
    expect(session.setCustomModel(undefined).previousConfigDir).toBe('/tmp/cfg-1');
  });
});

describe('restartCli() must not kill a working pane', () => {
  it('claude: pins the live conversation id so the relaunch renders --resume <id> || --session-id <id>', async () => {
    const { session, respawn } = liveSession('claude');
    giveTranscript(session.id);
    await session.restartCli();
    const options = respawn.mock.calls[0][0];
    expect(options.resumeSessionId).toBe(session.claudeSessionId);
    expect(options.resumeSessionId).toBe(session.id);
    // The pin is per-respawn: nothing about the session's own resume id changed.
    expect(session.toState().resumeSessionId).toBeUndefined();
  });

  it('claude: pins nothing when the pane has no transcript, because nothing can collide', async () => {
    // A pane that was launched and never prompted. `--session-id <this.id>` is
    // accepted on an id no transcript holds, so pinning would buy nothing and
    // cost two things: claude prints "No conversation found" into a pane with
    // no history, and `wrapWithNice()` prefixes only the first branch of the
    // rendered `a || b`, so the branch that actually runs loses its priority
    // for the life of the session.
    const { session, respawn } = liveSession('claude');
    await session.restartCli();
    expect(respawn.mock.calls[0][0].resumeSessionId).toBeUndefined();
  });

  it('claude: an explicit resume id from a resume-from-history launch wins over the pin', async () => {
    const RESUMED = '01a060f0-0361-7f91-abde-b283020db0d7';
    const { session, respawn } = liveSession('claude', { resumeSessionId: RESUMED });
    giveTranscript(RESUMED);
    await session.restartCli();
    expect(respawn.mock.calls[0][0].resumeSessionId).toBe(RESUMED);
  });

  it('claude: a launch seed survives the pin walk even with its transcript gone', async () => {
    // The walk only ever ADDS a pin. The seed is what the session was created
    // with and every respawn has always carried it, so a transcript deleted
    // under a running session leaves the relaunch on
    // `--resume <seed> || --session-id <this.id>` — the resume fails and the
    // fallback runs, which is safe precisely because nothing is on disk to
    // collide with.
    const RESUMED = '01a060f0-0361-7f91-abde-b283020db0d7';
    const { session, respawn } = liveSession('claude', { resumeSessionId: RESUMED });
    await session.restartCli();
    expect(respawn.mock.calls[0][0].resumeSessionId).toBe(RESUMED);
  });

  it('pi: no top-level resume pin, its resume id is minted by the CLI and lives in piConfig', async () => {
    const { session, respawn } = liveSession('pi');
    await session.restartCli();
    expect(respawn.mock.calls[0][0].resumeSessionId).toBeUndefined();
  });
});

describe('launchModel reaches the CLI through its own launch param', () => {
  /** A session the route just built: no pane yet, so its launch is `createSession`. */
  function freshSession(mode: SessionMode, extra: Record<string, unknown> = {}) {
    mkdirSync(workingDir, { recursive: true });
    const mux = new TmuxManager();
    const create = vi.spyOn(mux, 'createSession');
    vi.spyOn(mux, 'muxSessionExists').mockReturnValue(true);
    const respawn = vi.spyOn(mux, 'respawnPane').mockResolvedValue(4242);
    const session = new Session({ workingDir, mode, mux, useMux: true, ...extra });
    sessions.push(session);
    return { session, create, respawn };
  }

  it('the first launch carries it too, and a clear relaunches on the model the session was created with', async () => {
    const { session, create, respawn } = freshSession('pi', { piConfig: { model: 'anthropic/claude-x' } });
    session.setCustomModel(
      { endpointId: 'ep', modelId: 'qwen3', envKeys: ['HOME'], configDir: '/tmp/cfg', launchModel: 'custom/qwen3' },
      { HOME: '/tmp/cfg' }
    );
    await session.startInteractive();
    expect(create.mock.calls[0][0].piConfig?.model).toBe('custom/qwen3');
    expect(session.toState().piConfig?.model).toBe('anthropic/claude-x');

    session.setCustomModel(undefined);
    expect(await session.restartCli()).toBe(true);
    expect(respawn.mock.calls[0][0].piConfig?.model).toBe('anthropic/claude-x');
  });

  it('a clear on a session created with no model relaunches with none', async () => {
    const { session, create, respawn } = freshSession('codex');
    session.setCustomModel(
      { endpointId: 'ep', modelId: 'qwen3', envKeys: ['CODEX_HOME'], configDir: '/tmp/cfg', launchModel: 'qwen3' },
      { CODEX_HOME: '/tmp/cfg' }
    );
    await session.startInteractive();
    expect(create.mock.calls[0][0].codexConfig?.model).toBe('qwen3');

    session.setCustomModel(undefined);
    expect(await session.restartCli()).toBe(true);
    expect(respawn.mock.calls[0][0].codexConfig?.model).toBeUndefined();
  });

  it('leaves the launch untouched without a selection', async () => {
    const { session, create } = freshSession('pi', { piConfig: { model: 'anthropic/claude-x', thinking: 'low' } });
    await session.startInteractive();
    expect(create.mock.calls[0][0].piConfig).toEqual({ model: 'anthropic/claude-x', thinking: 'low' });
  });

  it('pi: the selection forces piConfig.model on the respawn options, leaving the stored config alone', async () => {
    const { session, respawn } = liveSession('pi', { piConfig: { model: 'anthropic/claude-x', thinking: 'low' } });
    session.setCustomModel(
      { endpointId: 'ep', modelId: 'qwen3', envKeys: ['HOME'], configDir: '/tmp/cfg', launchModel: 'custom/qwen3' },
      { HOME: '/tmp/cfg' }
    );
    await session.restartCli();
    expect(respawn.mock.calls[0][0].piConfig).toEqual({ model: 'custom/qwen3', thinking: 'low' });
    // The user's own choice survives underneath, which is what a clear falls back to.
    expect(session.toState().piConfig).toEqual({ model: 'anthropic/claude-x', thinking: 'low' });

    session.setCustomModel(undefined);
    respawn.mockClear();
    await session.restartCli();
    expect(respawn.mock.calls[0][0].piConfig).toEqual({ model: 'anthropic/claude-x', thinking: 'low' });
  });

  it('grok: the block name lands in grokConfig.model', async () => {
    const { session, respawn } = liveSession('grok');
    session.setCustomModel(
      {
        endpointId: 'ep',
        modelId: 'qwen3',
        envKeys: ['GROK_HOME'],
        configDir: '/tmp/cfg',
        launchModel: 'codeman-custom',
      },
      { GROK_HOME: '/tmp/cfg' }
    );
    await session.restartCli();
    expect(respawn.mock.calls[0][0].grokConfig).toEqual({ model: 'codeman-custom' });
  });

  it('claude: a selection without a launchModel leaves the model param untouched', async () => {
    const { session, respawn } = liveSession('claude');
    session.setCustomModel({ endpointId: 'ep', modelId: 'q', envKeys: CLAUDE_KEYS }, claudeEnv);
    await session.restartCli();
    expect(respawn.mock.calls[0][0].model).toBeUndefined();
  });
});

describe('Codex custom endpoint model overrides', () => {
  it('selects the local model over a native launch default and restores the default on clear', async () => {
    const entry = getCli('codex');
    if (!entry) throw new Error('Missing Codex entry');
    const injection = buildCustomModelInjection(
      entry,
      { id: 'ep', label: 'Local', baseUrl: 'http://box:8080' },
      'qwen3'
    );
    if (injection.kind !== 'configDir') throw new Error('Expected isolated Codex config');
    const { session, respawn } = liveSession('codex', {
      codexConfig: { model: 'native-model', reasoningEffort: 'high' },
    });
    session.setCustomModel(
      { endpointId: 'ep', modelId: 'qwen3', envKeys: ['CODEX_HOME'], launchModel: injection.launchModel },
      { CODEX_HOME: '/isolated/codex' }
    );
    await session.restartCli();
    expect(respawn.mock.calls[0][0].codexConfig).toEqual({ model: 'qwen3', reasoningEffort: 'high' });
    session.setCustomModel(undefined);
    respawn.mockClear();
    await session.restartCli();
    expect(respawn.mock.calls[0][0].codexConfig).toEqual({ model: 'native-model', reasoningEffort: 'high' });
  });
});

describe('a value the session set itself comes back with the selection gone', () => {
  const DSH_SELECTION = {
    endpointId: 'ep',
    modelId: 'q',
    envKeys: ['DSH_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY'],
    configDir: '/isolated/dsh',
    homeEnvVar: 'DSH_HOME',
  };
  const DSH_ENV = { DSH_HOME: '/isolated/dsh', CODEMAN_CUSTOM_MODEL_API_KEY: 'k' };

  it('puts an own DSH_HOME back on clear and sets it rather than unsetting it', async () => {
    const { session, respawn } = liveSession('deepseek', { envOverrides: { DSH_HOME: '/home/u/my-dsh' } });
    session.setCustomModel(DSH_SELECTION, DSH_ENV);
    expect(session.envOverrideValue('DSH_HOME')).toBe('/isolated/dsh');

    session.setCustomModel(undefined);
    expect(session.envOverrideValue('DSH_HOME')).toBe('/home/u/my-dsh');
    expect(session.deepSeekHomeOverride).toBe('/home/u/my-dsh');

    await session.restartCli();
    const options = respawn.mock.calls[0][0];
    expect(options.envOverrides).toEqual({ DSH_HOME: '/home/u/my-dsh' });
    expect(options.unsetEnvKeys).toEqual(['CODEMAN_CUSTOM_MODEL_API_KEY']);
  });

  it('carries it across a switch between endpoints', () => {
    const { session } = liveSession('deepseek', { envOverrides: { DSH_HOME: '/home/u/my-dsh' } });
    session.setCustomModel(DSH_SELECTION, DSH_ENV);
    session.setCustomModel({ ...DSH_SELECTION, endpointId: 'other' }, DSH_ENV);
    expect(session.envOverrideValue('DSH_HOME')).toBe('/isolated/dsh');

    session.setCustomModel(undefined);
    expect(session.envOverrideValue('DSH_HOME')).toBe('/home/u/my-dsh');
  });

  it('keeps a claude session on its own account, the #255 override', async () => {
    const { session, respawn } = liveSession('claude', {
      envOverrides: { CLAUDE_CONFIG_DIR: '/home/u/.claude-client', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '100000' },
    });
    session.setCustomModel(
      {
        endpointId: 'ep',
        modelId: 'q',
        envKeys: [...CLAUDE_KEYS, 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'],
        configDir: '/isolated/claude',
        homeEnvVar: 'CLAUDE_CONFIG_DIR',
      },
      { ...claudeEnv, CLAUDE_CONFIG_DIR: '/isolated/claude', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768' }
    );

    session.setCustomModel(undefined);
    await session.restartCli();
    const options = respawn.mock.calls[0][0];
    expect(options.envOverrides).toEqual({
      CLAUDE_CONFIG_DIR: '/home/u/.claude-client',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '100000',
    });
    expect(options.unsetEnvKeys).toEqual(CLAUDE_KEYS);
  });

  it('still unsets a key whose own value was empty, since tmux never held that value', () => {
    const { session } = liveSession('deepseek', { envOverrides: { DSH_HOME: '' } });
    session.setCustomModel(DSH_SELECTION, DSH_ENV);

    session.setCustomModel(undefined);
    expect(session.envOverrideValue('DSH_HOME')).toBeUndefined();
  });

  it('writes the own home to state.json and no other own value', () => {
    const { session } = liveSession('gemini', {
      envOverrides: { GEMINI_API_KEY: 'own-secret', DSH_HOME: '/home/u/my-dsh' },
    });
    session.setCustomModel(
      {
        endpointId: 'ep',
        modelId: 'q',
        envKeys: ['GEMINI_API_KEY', 'DSH_HOME'],
        homeEnvVar: 'DSH_HOME',
      },
      { GEMINI_API_KEY: 'endpoint-key', DSH_HOME: '/isolated/dsh' }
    );

    const persisted = session.getCustomModelForPersist();
    expect(persisted?.ownEnv).toEqual({ DSH_HOME: '/home/u/my-dsh' });
    expect(JSON.stringify(persisted)).not.toContain('own-secret');
    // The secret is still put back: it just never leaves memory.
    session.setCustomModel(undefined);
    expect(session.envOverrideValue('GEMINI_API_KEY')).toBe('own-secret');
  });

  it('keeps a home variable holding anything but an absolute path off disk', () => {
    // The registry types `configDirVar`/`dirEnvVar` as plain env names, so a clis.json
    // override can name a credential as the home variable. Only a path may reach disk.
    const { session } = liveSession('gemini', { envOverrides: { GEMINI_API_KEY: 'own-secret' } });
    session.setCustomModel(
      { endpointId: 'ep', modelId: 'q', envKeys: ['GEMINI_API_KEY'], homeEnvVar: 'GEMINI_API_KEY' },
      { GEMINI_API_KEY: 'endpoint-key' }
    );

    expect(JSON.stringify(session.getCustomModelForPersist())).not.toContain('own-secret');
    session.setCustomModel(undefined);
    expect(session.envOverrideValue('GEMINI_API_KEY')).toBe('own-secret');
  });

  it('reads the own value while a selection holds the key, never the injected one', () => {
    const { session } = liveSession('deepseek', { envOverrides: { DSH_HOME: ' /home/u/my-dsh ' } });
    expect(session.ownEnvValue('DSH_HOME')).toBe('/home/u/my-dsh');

    session.setCustomModel(DSH_SELECTION, DSH_ENV);
    expect(session.ownEnvValue('DSH_HOME')).toBe('/home/u/my-dsh');
    // An injected key the session never set has no own value, whatever the map holds now.
    expect(session.envOverrideValue('CODEMAN_CUSTOM_MODEL_API_KEY')).toBe('k');
    expect(session.ownEnvValue('CODEMAN_CUSTOM_MODEL_API_KEY')).toBeUndefined();
  });

  it('persists nothing extra for a recipe with no home variable', () => {
    const { session } = liveSession('gemini', { envOverrides: { GEMINI_API_KEY: 'own-secret' } });
    session.setCustomModel(
      { endpointId: 'ep', modelId: 'q', envKeys: ['GEMINI_API_KEY'] },
      { GEMINI_API_KEY: 'endpoint-key' }
    );

    expect(session.getCustomModelForPersist()).toEqual({ endpointId: 'ep', modelId: 'q', envKeys: ['GEMINI_API_KEY'] });
  });
});

describe('a claude session on its own config dir keeps its conversation', () => {
  const ownDir = join(homedir(), 'custom-model-restart-own-claude');
  const endpoint = { id: 'ep', label: 'Ep', baseUrl: 'http://box:8080', apiKey: 'k' };

  afterEach(() => rmSync(ownDir, { recursive: true, force: true }));

  function writeTranscript(configDir: string, conversationId: string): string {
    const dir = join(configDir, 'projects', '-custom-model-restart');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${conversationId}.jsonl`);
    writeFileSync(file, '{"type":"user"}\n');
    return file;
  }

  /** The route's apply, with the real isolated directory and its `projects` link. */
  function applyEndpoint(session: Session) {
    const applied = applyCustomModelInjection(
      getCli('claude')!,
      endpoint,
      'q',
      session.id,
      undefined,
      workingDir,
      (envVar) => session.ownEnvValue(envVar)
    )!;
    session.setCustomModel(
      {
        endpointId: 'ep',
        modelId: 'q',
        envKeys: applied.envKeys,
        configDir: applied.configDir,
        homeEnvVar: applied.homeEnvVar,
      },
      applied.envOverrides
    );
    return applied;
  }

  it('resumes it on apply, from under the own dir', async () => {
    const { session, respawn } = liveSession('claude', { envOverrides: { CLAUDE_CONFIG_DIR: ownDir } });
    writeTranscript(ownDir, session.id);
    const applied = applyEndpoint(session);

    await session.restartCli();
    const options = respawn.mock.calls[0][0];
    expect(options.envOverrides?.CLAUDE_CONFIG_DIR).toBe(applied.configDir);
    expect(options.resumeSessionId).toBe(session.id);
    removeConfigDir(applied.configDir);
  });

  it('resumes what the endpoint run wrote on clear, on the own account', async () => {
    // The server's tree exists, as it does on any machine that has run claude: this is
    // where the `projects` link used to send the transcript, out of the own dir's sight.
    mkdirSync(join(homedir(), '.claude', 'projects'), { recursive: true });
    const { session, respawn } = liveSession('claude', { envOverrides: { CLAUDE_CONFIG_DIR: ownDir } });
    const applied = applyEndpoint(session);
    writeTranscript(applied.configDir!, session.id);

    const { previousConfigDir } = session.setCustomModel(undefined);
    removeConfigDir(previousConfigDir);
    await session.restartCli();

    expect(existsSync(customModelConfigDir(session.id))).toBe(false);
    expect(existsSync(join(ownDir, 'projects', '-custom-model-restart', `${session.id}.jsonl`))).toBe(true);
    const options = respawn.mock.calls[0][0];
    expect(options.envOverrides?.CLAUDE_CONFIG_DIR).toBe(ownDir);
    expect(options.resumeSessionId).toBe(session.id);
  });
});
