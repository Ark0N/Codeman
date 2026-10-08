/**
 * @fileoverview End-to-end wiring of the agent-case label: quick-start writes the
 * marker, the case list publishes it, and `GET /api/cases/agent-created` reports it
 * for cleanup.
 *
 * The rules under test are the ones that decide whether the cleanup list can be
 * trusted: only a directory quick-start CREATES is ever labelled (a pre-existing
 * case — a linked repo, a real project — never is), a spawn with no agent signal at
 * all leaves no marker, the lineage header alone is enough to label one (that is how
 * a stale skill copy still gets swept up), and a case a live session is working in is
 * reported as `inUse` rather than silently offered up for deletion.
 *
 * Real filesystem against the per-file temp HOME from test/setup.ts, so the marker is
 * asserted as bytes on disk rather than through a mock.
 *
 * Port: N/A (app.inject()).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockRouteContext, createMockSession, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';
import { getCasesDir } from '../../src/config/cases-dir.js';
import { AGENT_CASE_MARKER_FILE } from '../../src/agent-case-marker.js';
import type { AgentCaseSummary, CaseInfo } from '../../src/types.js';

const PARENT_ID = 'test-session-1'; // the id the mock context pre-populates

interface Harness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx);
  registerCaseRoutes(app, ctx);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

describe('agent-created case marker', () => {
  let harness: Harness;
  const created: string[] = [];

  /** Spawn a worker through quick-start, the skill's usual route. */
  async function quickStart(caseName: string, opts: { headers?: Record<string, string>; payload?: object } = {}) {
    created.push(caseName);
    return harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      headers: opts.headers,
      payload: { caseName, mode: 'claude', ...(opts.payload ?? {}) },
    });
  }

  const markerPath = (caseName: string) => join(getCasesDir(), caseName, AGENT_CASE_MARKER_FILE);

  async function readMarker(caseName: string): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await readFile(markerPath(caseName), 'utf-8'));
    } catch {
      return null;
    }
  }

  async function listCases(): Promise<CaseInfo[]> {
    const res = await harness.app.inject({ method: 'GET', url: '/api/cases' });
    const body = JSON.parse(res.body);
    return (body.data ?? body) as CaseInfo[];
  }

  async function listAgentCases(): Promise<AgentCaseSummary[]> {
    const res = await harness.app.inject({ method: 'GET', url: '/api/cases/agent-created' });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).data.cases as AgentCaseSummary[];
  }

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
    for (const name of created.splice(0)) {
      await rm(join(getCasesDir(), name), { recursive: true, force: true });
    }
  });

  it('labels a case directory created for a spawn carrying the skill origin header', async () => {
    const res = await quickStart('agentcase1', {
      headers: { 'x-codeman-agent-origin': 'codeman-skill', 'x-codeman-parent-session': PARENT_ID },
    });

    expect(res.statusCode).toBe(200);
    const marker = await readMarker('agentcase1');
    expect(marker).toMatchObject({
      version: 1,
      createdBy: 'codeman-skill',
      parentSessionId: PARENT_ID,
      mode: 'claude',
    });
    expect(Date.parse(String(marker?.createdAt))).not.toBeNaN();
  });

  it('accepts the origin as a body field too, with the body winning', async () => {
    await quickStart('agentcase2', {
      headers: { 'x-codeman-agent-origin': 'codeman-skill' },
      payload: { agentOrigin: 'my-orchestrator' },
    });

    expect(await readMarker('agentcase2')).toMatchObject({ createdBy: 'my-orchestrator' });
  });

  it('labels a spawn that carries only the lineage header, which is how an older skill copy still gets swept up', async () => {
    await quickStart('agentcase3', { headers: { 'x-codeman-parent-session': PARENT_ID } });

    expect(await readMarker('agentcase3')).toMatchObject({
      createdBy: 'agent-session',
      parentSessionId: PARENT_ID,
    });
  });

  it('writes NO marker for a spawn with no agent signal at all', async () => {
    // A human clicking Run in the browser sets neither header, and their case must
    // not turn up in a cleanup list.
    await quickStart('humancase1');

    expect(await readMarker('humancase1')).toBeNull();
  });

  it('never labels a directory that already existed', async () => {
    // The linchpin: a linked case or a real repo is not ours to offer for deletion,
    // and the create branch is the only place the marker may be written.
    const name = 'preexisting1';
    created.push(name);
    await mkdir(join(getCasesDir(), name), { recursive: true });

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      headers: { 'x-codeman-agent-origin': 'codeman-skill' },
      payload: { caseName: name, mode: 'claude' },
    });

    expect(res.statusCode).toBe(200);
    expect(await readMarker(name)).toBeNull();
  });

  it('never labels the working directory of a POST /api/sessions, header or not', async () => {
    // `codeman agent` sends the origin only on quick-start, but the server must not
    // trust that: a session created on an EXISTING workingDir (somebody's real repo)
    // is never marked as agent scratch, whatever the request carries.
    const name = 'existingrepo1';
    created.push(name);
    const dir = join(getCasesDir(), name);
    await mkdir(dir, { recursive: true });

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-codeman-agent-origin': 'codeman-agent-cli', 'x-codeman-parent-session': PARENT_ID },
      payload: { workingDir: dir, mode: 'claude' },
    });

    expect(res.statusCode).toBe(200);
    expect(await readMarker(name)).toBeNull();
  });

  it('labels a case quick-start creates for `codeman agent spawn`, and not one that existed', async () => {
    await quickStart('agentclicase1', { headers: { 'x-codeman-agent-origin': 'codeman-agent-cli' } });
    expect(await readMarker('agentclicase1')).toMatchObject({ createdBy: 'codeman-agent-cli' });

    const name = 'preexisting2';
    created.push(name);
    await mkdir(join(getCasesDir(), name), { recursive: true });
    await quickStart(name, { headers: { 'x-codeman-agent-origin': 'codeman-agent-cli' } });
    expect(await readMarker(name)).toBeNull();
  });

  it('drops an unrecognised origin token rather than storing it', async () => {
    await quickStart('agentcase4', { payload: { agentOrigin: '<script>alert(1)</script>' } });

    // No parent either, so nothing labels this one at all.
    expect(await readMarker('agentcase4')).toBeNull();
  });

  it('still spawns the worker when the origin is bogus', async () => {
    const res = await quickStart('agentcase5', { payload: { agentOrigin: 'not a token' } });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).sessionId ?? JSON.parse(res.body).data?.sessionId).toBeTruthy();
  });

  it('publishes the label on GET /api/cases and hides it from cases without one', async () => {
    await quickStart('agentcase6', { headers: { 'x-codeman-agent-origin': 'codeman-skill' } });
    await quickStart('humancase2');

    const cases = await listCases();
    expect(cases.find((c) => c.name === 'agentcase6')?.agentCreated).toMatchObject({ createdBy: 'codeman-skill' });
    expect(cases.find((c) => c.name === 'humancase2')?.agentCreated).toBeUndefined();
  });

  it('lists only agent cases in the cleanup listing, newest first', async () => {
    await quickStart('agentcase7', { headers: { 'x-codeman-agent-origin': 'codeman-skill' } });
    await quickStart('humancase3');

    const listed = await listAgentCases();
    expect(listed.map((c) => c.name)).toContain('agentcase7');
    expect(listed.map((c) => c.name)).not.toContain('humancase3');
    const sorted = [...listed].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(listed.map((c) => c.name)).toEqual(sorted.map((c) => c.name));
  });

  it('flags a case a live session is still working in as inUse', async () => {
    // Deleting one of these would pull the rug out from under a running worker, so
    // the UI excludes it rather than confirming it away.
    await quickStart('agentcase8', { headers: { 'x-codeman-agent-origin': 'codeman-skill' } });
    const busyPath = join(getCasesDir(), 'agentcase8');
    const busy = createMockSession('busy-session') as unknown as { workingDir: string };
    busy.workingDir = busyPath;
    harness.ctx.sessions.set('busy-session', busy as never);

    const entry = (await listAgentCases()).find((c) => c.name === 'agentcase8');
    expect(entry?.inUse).toBe(true);
    expect(entry?.path).toBe(busyPath);
  });

  it('reports a marker-less case space as an empty list rather than failing', async () => {
    expect(await listAgentCases()).toEqual([]);
  });
});
