/**
 * @fileoverview PUT /api/sessions/:id/name hands the name to the user (#376).
 *
 * A rename flips `nameSource` to `manual`, persists it and broadcasts it, so
 * auto-naming can never overwrite a name a person chose, on this server or
 * on the one that restores the session after a restart.
 *
 * The rename also reaches Claude's own `/resume` title: a `custom-title` row is
 * appended to the conversation's transcript, the row `/rename` writes.
 *
 * Uses app.inject() — no real HTTP ports needed.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { Session } from '../../src/session.js';
import { SseEvent } from '../../src/web/sse-events.js';

describe('PUT /api/sessions/:id/name', () => {
  let harness: RouteTestHarness;
  let session: Session;
  const updateSessionName = vi.fn(() => true);
  const transcriptDir = mkdtempSync(join(tmpdir(), 'codeman-rename-title-'));
  const transcriptPath = join(transcriptDir, '6f1c1a2e-0000-4000-8000-000000000001.jsonl');
  const transcriptRows = () =>
    readFileSync(transcriptPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  beforeAll(async () => {
    writeFileSync(transcriptPath, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    harness = await createRouteTestHarness(registerSessionRoutes);
    // A REAL session, since the ownership flag lives on the class, not the mock.
    session = new Session({ id: 'name-route-test', workingDir: '/tmp', name: 'w1-demo' });
    harness.ctx.sessions.set(session.id, session as never);
    (harness.ctx.mux as Record<string, unknown>).updateSessionName = updateSessionName;
    (harness.ctx as Record<string, unknown>).getTranscriptPath = (id: string) =>
      id === session.id ? transcriptPath : null;
  });

  afterAll(async () => {
    await harness.app.close();
    rmSync(transcriptDir, { recursive: true, force: true });
  });

  it('treats a same-name PUT as a no-op: stays placeholder, writes no title row', async () => {
    // The Session Options field saves on blur and recomposes the unchanged placeholder.
    const before = transcriptRows().length;
    const res = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${session.id}/name`,
      payload: { name: 'w1-demo' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'w1-demo' });
    expect(session.nameSource).toBe('placeholder');
    expect(transcriptRows()).toHaveLength(before);
    expect(updateSessionName).not.toHaveBeenCalled();
    expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
  });

  it('flips a placeholder to manual, then persists and broadcasts the ownership', async () => {
    expect(session.nameSource).toBe('placeholder');

    const res = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${session.id}/name`,
      payload: { name: 'my window' },
    });

    expect(res.statusCode).toBe(200);
    // The harness registers the bare route; the {success,data} envelope is a server-level hook.
    expect(res.json()).toMatchObject({ name: 'my window' });
    expect(session.name).toBe('my window');
    expect(session.nameSource).toBe('manual');
    expect(session.applyAutoName('w1-demo: fix it')).toBe(false);
    expect(session.name).toBe('my window');

    expect(updateSessionName).toHaveBeenCalledWith(session.id, 'my window');
    expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(session);
    expect(harness.ctx.broadcast).toHaveBeenCalledWith(
      SseEvent.SessionUpdated,
      expect.objectContaining({ id: session.id, name: 'my window', nameSource: 'manual' })
    );
    // What the restore path will read back: the persisted state carries the flag.
    expect(session.toState().nameSource).toBe('manual');
  });

  it("appends the name as the conversation's custom-title, the row /resume reads", async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${session.id}/name`,
      payload: { name: '修复登录跳转' },
    });

    expect(res.statusCode).toBe(200);
    expect(transcriptRows().at(-1)).toEqual({
      type: 'custom-title',
      customTitle: '修复登录跳转',
      sessionId: '6f1c1a2e-0000-4000-8000-000000000001',
    });
  });

  it('writes no title row for an empty name, which would blank the /resume entry', async () => {
    const before = transcriptRows().length;
    const res = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${session.id}/name`,
      payload: { name: '   ' },
    });

    expect(res.statusCode).toBe(200);
    expect(transcriptRows()).toHaveLength(before);
  });

  it('appends a title row only once when the same name is PUT twice', async () => {
    const before = transcriptRows().length;
    for (let i = 0; i < 2; i++) {
      await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${session.id}/name`,
        payload: { name: 'twice' },
      });
    }
    expect(transcriptRows()).toHaveLength(before + 1);
  });

  it('writes no title row for a docker session, whose transcript lives in the container', async () => {
    const before = transcriptRows().length;
    Object.defineProperty(session, 'docker', { configurable: true, get: () => ({ caseName: 'c' }) });
    try {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${session.id}/name`,
        payload: { name: 'in a container' },
      });
      expect(res.statusCode).toBe(200);
      expect(session.name).toBe('in a container');
      expect(transcriptRows()).toHaveLength(before);
    } finally {
      delete (session as unknown as Record<string, unknown>).docker;
    }
  });
});
