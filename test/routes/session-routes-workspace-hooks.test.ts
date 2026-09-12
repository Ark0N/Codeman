/**
 * @fileoverview Hooks are installed into the workspace a claude session starts in.
 *
 * Regression cover for the 2026-08-15 report: a session in a LINKED case (the user's
 * own repo, where most sessions live) ran with no hooks block at all, because
 * `writeHooksConfig` only fires when Codeman CREATES a case directory and the old
 * self-heal call deliberately never ADDED one. The visible symptom was an
 * AskUserQuestion dialog blocking the pane while the tab and the phone overview both
 * showed a calm `idle` — no hook event, so no pending-hook state, so no alert.
 *
 * Asserts bytes on disk (the real `ensureCodemanHooks`), not a spy call.
 * Uses app.inject(), so no real HTTP port is needed.
 *
 * Also covers the post-#304 follow-ups: the quick-start existing-case branch, the
 * docker branch's claude-only gate (a shell quick-start used to author a hooks
 * block of its own), and the shared decision core `applyWorkspaceHooks` in
 * hooks-config.ts — the function the non-route create paths (cron, scheduled runs,
 * plan one-shots, the boot recovery sweep) go through, tested directly here
 * including the sweep's deleted-workspace guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext, safeRmHomeTree, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { generateHooksConfig, applyWorkspaceHooks } from '../../src/hooks-config.js';
import { getDataDir } from '../../src/config/instance.js';
import { CASES_DIR } from '../../src/web/route-helpers.js';
import { Session } from '../../src/session.js';

interface HooksFile {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
  permissions?: unknown;
  model?: unknown;
}

/**
 * A faithful PRE-SECRET Codeman hooks block (what a case created before COD-54
 * contains): it targets /api/hook-event, so it is recognisably ours, but carries
 * no X-Codeman-Hook-Secret header and no -k. Used to prove the self-heal still
 * runs with the setting OFF.
 */
function staleCodemanHooks() {
  return {
    Stop: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command:
              "HOOK_DATA=$(cat 2>/dev/null || echo '{}'); " +
              'printf \'{"event":"stop","sessionId":"%s","data":%s}\' "$CODEMAN_SESSION_ID" "$HOOK_DATA" | ' +
              'curl -s -X POST "$CODEMAN_API_URL/api/hook-event" -H \'Content-Type: application/json\' --data @- 2>/dev/null || true',
            timeout: 5,
          },
        ],
      },
    ],
  };
}

describe('POST /api/sessions workspace hooks', () => {
  let app: FastifyInstance;
  let workingDir: string;

  const settingsPath = () => join(workingDir, '.claude', 'settings.local.json');
  const readSettings = async (): Promise<HooksFile> => JSON.parse(await readFile(settingsPath(), 'utf-8'));

  const createSession = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/sessions', payload });

  /** Rebuild the app with the `workspaceHooksEnabled` gate in a given position. */
  const useApp = async (workspaceHooksEnabled: boolean) => {
    await app?.close();
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerSessionRoutes(app, createMockRouteContext({ workspaceHooksEnabled }));
    installRouteErrorHandler(app);
    await app.ready();
  };

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'codeman-workspace-hooks-'));
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerSessionRoutes(app, createMockRouteContext());
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(workingDir, { recursive: true, force: true });
  });

  it('installs hooks in a workspace that has none (the linked-case bug)', async () => {
    const res = await createSession({ name: 'hooks-fresh', mode: 'claude', workingDir });
    expect(res.statusCode).toBe(200);

    const settings = await readSettings();
    const matchers = (settings.hooks?.Notification ?? []).map((entry) => entry.matcher);
    // permission_prompt is the one an AskUserQuestion dialog raises; the
    // elicitation pair is what CLOSES the resulting Approvals Inbox item.
    expect(matchers).toEqual(
      expect.arrayContaining([
        'idle_prompt',
        'permission_prompt',
        'elicitation_dialog',
        'elicitation_complete',
        'elicitation_response',
      ])
    );
    expect(settings.hooks?.Stop?.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(settings.hooks);
    // The two shapes that have historically shipped dead hooks: no secret header
    // (401 once the gate went unconditional) and no -k (exit 60 on HTTPS installs).
    expect(serialized).toContain('X-Codeman-Hook-Secret');
    expect(serialized).toContain('curl -sk -X POST');
  });

  it('merges into a user-owned settings file without disturbing it', async () => {
    await mkdir(join(workingDir, '.claude'), { recursive: true });
    const userHook = { matcher: 'Write', hooks: [{ type: 'command', command: './my-formatter.sh' }] };
    await writeFile(
      settingsPath(),
      JSON.stringify({ model: 'opus[1m]', permissions: { allow: ['Read'] }, hooks: { PostToolUse: [userHook] } })
    );

    expect((await createSession({ name: 'hooks-merge', mode: 'claude', workingDir })).statusCode).toBe(200);

    const settings = await readSettings();
    expect(settings.model).toBe('opus[1m]');
    expect(settings.permissions).toEqual({ allow: ['Read'] });
    expect(JSON.stringify(settings.hooks)).toContain('./my-formatter.sh');
    expect((settings.hooks?.Notification ?? []).length).toBeGreaterThan(0);
  });

  it('leaves a non-claude session alone (only claude reads .claude hooks)', async () => {
    expect((await createSession({ name: 'hooks-shell', mode: 'shell', workingDir })).statusCode).toBe(200);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('leaves the server cwd alone when workingDir is omitted', async () => {
    // workingDir falls back to process.cwd(), which is $HOME under installer-created
    // services — neither hooks NOR the statusLine exporter (same mkdir-into-cwd
    // exposure, closed in the #304 follow-ups) may materialize in
    // ~/.claude/settings.local.json.
    const cwdSettings = join(process.cwd(), '.claude', 'settings.local.json');
    const before = existsSync(cwdSettings) ? await readFile(cwdSettings, 'utf-8') : null;

    const res = await createSession({ name: 'hooks-no-dir', mode: 'claude' });
    expect(res.statusCode).toBe(200);

    const after = existsSync(cwdSettings) ? await readFile(cwdSettings, 'utf-8') : null;
    expect(after).toBe(before);
  });

  it('never writes hooks for a remote attach (workingDir is a user@host pseudo-path)', async () => {
    // A claude-mode attachRemoteSession create overwrites workingDir with
    // `user@host:session` — locally a RELATIVE path, so a mkdir would create it
    // as a junk directory under the server cwd. The statusLine exporter rides
    // along: applyStatusLineConfig mkdirs the same way and used to run for
    // remote attaches.
    // SAFETY (2026-08-29): write straight to `getDataDir()` — `test/setup.ts`
    // already sandboxes the data dir for the whole file (temp HOME, inherited
    // CODEMAN_DATA_DIR stripped; same convention as the docker-hosts fixtures
    // below). A prior version of this test stubbed
    // CODEMAN_DATA_DIR to a SEPARATE throwaway dir for just this write, but
    // `session-routes.ts`'s `CODEMAN_CONFIG_DIR` is a module-load-time constant
    // (frozen at the sandboxed dir before this test ever runs), so that fixture
    // landed somewhere the route handler could never read it — the remote host
    // lookup silently failed and the test passed for the wrong reason (Fastify
    // defaults an unset reply code to 200, so the NOT_FOUND branch and the
    // intended success branch were indistinguishable by status code alone).
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(
      join(getDataDir(), 'remote-hosts.json'),
      JSON.stringify([{ id: 'h1', label: 'box', host: '10.0.0.5', username: 'dev' }])
    );

    const res = await createSession({
      name: 'hooks-remote',
      mode: 'claude',
      attachRemoteSession: { hostId: 'h1', remoteSessionName: 'codeman-ssh-abc123' },
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(process.cwd(), 'dev@10.0.0.5:codeman-ssh-abc123'))).toBe(false);
  });

  it('leaves a malformed settings file untouched rather than replacing it', async () => {
    await mkdir(join(workingDir, '.claude'), { recursive: true });
    await writeFile(settingsPath(), '{ not json');

    expect((await createSession({ name: 'hooks-malformed', mode: 'claude', workingDir })).statusCode).toBe(200);
    expect(await readFile(settingsPath(), 'utf-8')).toBe('{ not json');
  });

  it('adds nothing when workspaceHooksEnabled is OFF', async () => {
    await useApp(false);

    expect((await createSession({ name: 'hooks-off', mode: 'claude', workingDir })).statusCode).toBe(200);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('still heals a stale Codeman block when workspaceHooksEnabled is OFF', async () => {
    // The setting turns off ADDING hooks, not the COD-91 self-heal: a pre-secret
    // block 401s against the now-unconditional hook-secret gate, so a workspace that
    // already opted in must not be left with hooks that silently fail.
    await useApp(false);
    await mkdir(join(workingDir, '.claude'), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify({ model: 'opus', hooks: staleCodemanHooks() }));

    expect((await createSession({ name: 'hooks-off-stale', mode: 'claude', workingDir })).statusCode).toBe(200);

    const settings = await readSettings();
    expect(settings.model).toBe('opus');
    expect(JSON.stringify(settings.hooks)).toContain('X-Codeman-Hook-Secret');
  });

  it('writes the hooks the generator produces, so the two cannot drift', async () => {
    expect((await createSession({ name: 'hooks-parity', mode: 'claude', workingDir })).statusCode).toBe(200);

    const written = (await readSettings()).hooks ?? {};
    expect(Object.keys(written).sort()).toEqual(Object.keys(generateHooksConfig().hooks).sort());
  });
});

describe('POST /api/quick-start workspace hooks', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;

  const quickStart = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/quick-start', payload });

  const hooksFileIn = (dir: string) => join(dir, '.claude', 'settings.local.json');

  beforeEach(async () => {
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    ctx = createMockRouteContext();
    registerSessionRoutes(app, ctx);
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    // Docker fixtures + case dirs must not leak into the next test.
    await rm(join(getDataDir(), 'docker-hosts.json'), { force: true });
    await rm(join(getDataDir(), 'docker-cases.json'), { force: true });
    // SAFETY (2026-08-29): CASES_DIR is `join(homedir(), 'codeman-cases')`, and
    // on environments where `os.homedir()` ignores `$HOME` it resolves to the
    // PROD case tree. `safeRmHomeTree` refuses to delete anything not under the
    // redirected test HOME, so a run can never nuke the real `~/codeman-cases`.
    safeRmHomeTree(CASES_DIR);
  });

  it('installs hooks into an EXISTING case directory (a linked case / cloned repo)', async () => {
    // The scaffold branch (writeHooksConfig) only runs when quick-start CREATES the
    // directory; a pre-existing case takes the applyWorkspaceHooks branch instead.
    const casePath = join(CASES_DIR, 'existingcase');
    await mkdir(casePath, { recursive: true });

    const res = await quickStart({ caseName: 'existingcase', mode: 'claude' });
    expect(res.statusCode).toBe(200);

    const raw = await readFile(hooksFileIn(casePath), 'utf-8');
    expect(raw).toContain('X-Codeman-Hook-Secret');
    expect(raw).toContain('/api/hook-event');
  });

  /** Minimal docker host + case fixtures (docker IO is no-op'd under vitest). */
  const writeDockerFixtures = async (caseName: string, hostWorkspacePath: string, lastClaudeSessionId?: string) => {
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(
      join(getDataDir(), 'docker-hosts.json'),
      JSON.stringify([{ id: 'd1', label: 'box', image: 'codeman/agent:base' }])
    );
    await writeFile(
      join(getDataDir(), 'docker-cases.json'),
      JSON.stringify([{ name: caseName, type: 'docker', hostId: 'd1', hostWorkspacePath, lastClaudeSessionId }])
    );
  };

  it('docker branch scaffolds hooks for a claude session', async () => {
    // Companion to the shell test below: proves the docker fixture path is live,
    // so the shell assertion cannot pass vacuously.
    const ws = await mkdtemp(join(tmpdir(), 'codeman-docker-claude-'));
    try {
      await writeDockerFixtures('dockclaude', ws);

      expect((await quickStart({ caseName: 'dockclaude', mode: 'claude' })).statusCode).toBe(200);
      expect(await readFile(hooksFileIn(ws), 'utf-8')).toContain('X-Codeman-Hook-Secret');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('docker branch authors NO hooks block for a shell session', async () => {
    // The branch used to exclude only the five external CLIs, so a shell
    // quick-start into a docker case wrote a `.claude` block of its own —
    // contradicting the existing-case branch's rule that only claude reads it.
    const ws = await mkdtemp(join(tmpdir(), 'codeman-docker-shell-'));
    try {
      await writeDockerFixtures('dockshell', ws);

      expect((await quickStart({ caseName: 'dockshell', mode: 'shell' })).statusCode).toBe(200);
      expect(existsSync(join(ws, '.claude'))).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it.each(['codex', 'gemini'] as const)('does not pass a saved Claude conversation id to Docker %s', async (mode) => {
    const ws = await mkdtemp(join(tmpdir(), `codeman-docker-${mode}-`));
    try {
      await writeDockerFixtures('dockexternal', ws, 'e83a9063-3cb4-44d2-a9a0-df153b81721f');

      const res = await quickStart({ caseName: 'dockexternal', mode });
      expect(res.statusCode).toBe(200);
      const session = ctx.sessions.get(JSON.parse(res.body).sessionId);
      expect(session?.toState().resumeSessionId).toBeUndefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('passes a saved Claude conversation id only to Docker Claude', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'codeman-docker-resume-'));
    const resumeId = 'e83a9063-3cb4-44d2-a9a0-df153b81721f';
    try {
      await writeDockerFixtures('dockresume', ws, resumeId);

      const res = await quickStart({ caseName: 'dockresume', mode: 'claude' });
      expect(res.statusCode).toBe(200);
      const session = ctx.sessions.get(JSON.parse(res.body).sessionId);
      expect(session?.toState().resumeSessionId).toBe(resumeId);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('applyWorkspaceHooks (the shared decision core in hooks-config)', () => {
  // The non-route claude create paths — cron fires, legacy scheduled runs, the
  // plan-orchestrator one-shots, the boot recovery sweep — call this function
  // directly, so its contract is tested here rather than by spinning those up.
  let workspace: string;

  const appSettingsPath = () => join(getDataDir(), 'settings.json');
  const wsSettingsPath = () => join(workspace, '.claude', 'settings.local.json');

  const setWorkspaceHooksSetting = async (enabled: boolean) => {
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(appSettingsPath(), JSON.stringify({ workspaceHooksEnabled: enabled }));
  };

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'codeman-hooks-core-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(appSettingsPath(), { force: true });
  });

  it('installs hooks with no settings.json at all (absent key = default ON)', async () => {
    await applyWorkspaceHooks(workspace);

    const raw = await readFile(wsSettingsPath(), 'utf-8');
    expect(raw).toContain('X-Codeman-Hook-Secret');
    expect(raw).toContain('curl -sk -X POST');
  });

  it('never ADDS a hooks block when workspaceHooksEnabled is OFF', async () => {
    await setWorkspaceHooksSetting(false);

    await applyWorkspaceHooks(workspace);
    expect(existsSync(wsSettingsPath())).toBe(false);
  });

  it('still heals a stale Codeman block when the setting is OFF (COD-91 self-heal)', async () => {
    await setWorkspaceHooksSetting(false);
    await mkdir(join(workspace, '.claude'), { recursive: true });
    await writeFile(wsSettingsPath(), JSON.stringify({ model: 'opus', hooks: staleCodemanHooks() }));

    await applyWorkspaceHooks(workspace);

    const settings: HooksFile = JSON.parse(await readFile(wsSettingsPath(), 'utf-8'));
    expect(settings.model).toBe('opus');
    expect(JSON.stringify(settings.hooks)).toContain('X-Codeman-Hook-Secret');
  });

  it('leaves a malformed settings file untouched rather than replacing it', async () => {
    await mkdir(join(workspace, '.claude'), { recursive: true });
    await writeFile(wsSettingsPath(), '{ not json');

    await applyWorkspaceHooks(workspace);
    expect(await readFile(wsSettingsPath(), 'utf-8')).toBe('{ not json');
  });

  it('skips a workspace that no longer exists (the boot-sweep resurrection bug)', async () => {
    // ensureCodemanHooks mkdir -p's, so the sweep used to recreate a DELETED repo
    // as an empty directory tree holding only .claude/settings.local.json.
    const gone = join(workspace, 'deleted-repo');

    // install=true mirrors the boot sweep's call shape (setting pre-resolved ON).
    await applyWorkspaceHooks(gone, true);
    expect(existsSync(gone)).toBe(false);

    // The setting-driven shape must skip it too.
    await applyWorkspaceHooks(gone);
    expect(existsSync(gone)).toBe(false);
  });
});
