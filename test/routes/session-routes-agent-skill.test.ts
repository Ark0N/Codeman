/**
 * @fileoverview Agent-skill injection on POST /api/sessions (docs/agent-control-plan.md §2).
 *
 * The quick-start half of this is covered end-to-end in test/quick-start.test.ts;
 * the plain create path had NO coverage, because the shared mock context hardcoded
 * `getAgentSkillEnabled` to false and nothing could flip it. This exercises the real
 * `applyAgentSkill` against a temp working dir, so it asserts bytes on disk rather
 * than a spy call.
 *
 * Uses app.inject(), so no real HTTP port is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { resolveCliLaunchError } from '../../src/utils/cli-launcher.js';

// External CLIs are pre-flighted (is the binary there?) before anything touches the
// workspace; CI has none installed, so the pre-flight is stubbed to "can start" and one
// test flips it to a refusal.
vi.mock('../../src/utils/cli-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/cli-launcher.js')>();
  return { ...actual, resolveCliLaunchError: vi.fn().mockResolvedValue(null) };
});

const MARKER_PREFIX = '<!-- codeman-managed-agent-skill';

interface Harness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createHarness(agentSkillEnabled: boolean): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext({ agentSkillEnabled });
  registerSessionRoutes(app, ctx);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

describe('POST /api/sessions agent-skill injection', () => {
  let workingDir: string;
  let harness: Harness | undefined;

  const skillDir = () => join(workingDir, '.claude', 'skills', 'codeman');

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'codeman-create-skill-'));
  });

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
    await rm(workingDir, { recursive: true, force: true });
  });

  it('injects the packaged skill into the working dir when the gate is ON', async () => {
    harness = await createHarness(true);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-on', mode: 'claude', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx.getAgentSkillEnabled).toHaveBeenCalled();

    const skillMd = await readFile(join(skillDir(), 'SKILL.md'), 'utf-8');
    expect(skillMd.startsWith('---\nname: codeman')).toBe(true);
    // The marker is what makes the copy ours: without it, uninstall refuses to
    // remove what this create wrote.
    expect(skillMd).toContain(MARKER_PREFIX);
    expect(existsSync(join(skillDir(), 'reference', 'endpoints.md'))).toBe(true);
  });

  it('leaves the working dir untouched when the gate is OFF', async () => {
    harness = await createHarness(false);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-off', mode: 'claude', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx.getAgentSkillEnabled).toHaveBeenCalled();
    expect(existsSync(skillDir())).toBe(false);
  });

  it('does not inject for a non-claude mode even when the gate is ON', async () => {
    // `.claude/skills/` is read by Claude Code only, so the gate is never even
    // consulted for the other backends.
    harness = await createHarness(true);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-shell', mode: 'shell', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx.getAgentSkillEnabled).not.toHaveBeenCalled();
    expect(existsSync(skillDir())).toBe(false);
  });

  it('gives a codex session the skill in .agents/skills, where codex looks, and none in .claude', async () => {
    harness = await createHarness(true);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-codex', mode: 'codex', workingDir },
    });

    expect(res.statusCode).toBe(200);
    const skillMd = await readFile(join(workingDir, '.agents', 'skills', 'codeman', 'SKILL.md'), 'utf-8');
    expect(skillMd.startsWith('---\nname: codeman')).toBe(true);
    expect(skillMd).toContain(MARKER_PREFIX);
    expect(existsSync(join(workingDir, '.agents', 'skills', 'codeman', 'reference', 'endpoints.md'))).toBe(true);
    expect(existsSync(skillDir())).toBe(false);

    // The preamble cache is seeded for it too, so the skill's §0 is the two-line loader
    // in codex as in claude (nothing in the preamble is claude-specific).
    const sessionId = (JSON.parse(res.body) as { session: { id: string } }).session.id;
    const preamble = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), `codeman-agent-${sessionId}.sh`);
    expect(existsSync(preamble)).toBe(true);
  });

  it('gives a pi session nothing: a project skill would put up pi\'s trust prompt', async () => {
    harness = await createHarness(true);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-pi', mode: 'pi', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(existsSync(join(workingDir, '.agents'))).toBe(false);
    expect(existsSync(join(workingDir, '.pi'))).toBe(false);
    expect(harness.ctx.getAgentSkillEnabled).not.toHaveBeenCalled();
  });

  it('writes nothing when the CLI cannot start (pre-flight refusal)', async () => {
    vi.mocked(resolveCliLaunchError).mockResolvedValueOnce('codex not found');
    harness = await createHarness(true);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-codex-missing', mode: 'codex', workingDir },
    });

    expect(JSON.parse(res.body).success).toBe(false);
    expect(existsSync(join(workingDir, '.agents'))).toBe(false);
  });

  it('defaults an omitted mode to claude and injects', async () => {
    // The frontend omits `mode` for a plain claude create, so the default branch
    // is the common path, not an edge case.
    harness = await createHarness(true);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'skill-default-mode', workingDir },
    });

    expect(res.statusCode).toBe(200);
    expect(existsSync(join(skillDir(), 'SKILL.md'))).toBe(true);
  });
});
