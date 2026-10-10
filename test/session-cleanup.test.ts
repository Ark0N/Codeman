import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { safeRmHomeTree } from './mocks/index.js';

const CASES_DIR = join(homedir(), 'codeman-cases');

/**
 * Session Cleanup Tests
 *
 * Tests for automatic session cleanup and resource management
 */
describe('Session Cleanup', () => {
  let server: WebServer;
  let baseUrl: string;
  let testWorkingDir: string;
  const createdCases: string[] = [];
  const createdSessions: string[] = [];

  beforeAll(async () => {
    testWorkingDir = mkdtempSync(join(tmpdir(), 'codeman-cleanup-test-'));
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterEach(() => {
    // Clean up cases created during this test (containment-gated).
    while (createdCases.length > 0) {
      safeRmHomeTree(join(CASES_DIR, createdCases.pop()!));
    }
  });

  afterAll(async () => {
    // Cleanup all sessions
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch {}
    }
    await server.stop();
    rmSync(testWorkingDir, { recursive: true, force: true });
  }, 60000);

  describe('Session Deletion', () => {
    it('rejects before stopping the session when layout deletion preparation fails', async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: testWorkingDir }),
      });
      const created = await createRes.json();
      const id = created.data.session.id;
      createdSessions.push(id);
      const internals = server as unknown as {
        tabLayouts: { runSessionDeletion: (...args: unknown[]) => Promise<unknown> };
      };
      const deletionSpy = vi
        .spyOn(internals.tabLayouts, 'runSessionDeletion')
        .mockRejectedValueOnce(new Error('layout prune unavailable'));
      try {
        const deleteRes = await fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE' });
        const getRes = await fetch(`${baseUrl}/api/sessions/${id}`);

        expect(deleteRes.status).toBe(500);
        expect(getRes.status).toBe(200);
      } finally {
        deletionSpy.mockRestore();
      }
    });

    it('should properly stop and cleanup interactive session', async () => {
      const caseName = `cleanup-test-${Date.now()}`;
      createdCases.push(caseName);

      // Create and start interactive session
      const quickStartRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const quickStartData = await quickStartRes.json();
      expect(quickStartData.success).toBe(true);

      // Delete the session
      const deleteRes = await fetch(`${baseUrl}/api/sessions/${quickStartData.data.sessionId}`, {
        method: 'DELETE',
      });
      const deleteData = await deleteRes.json();
      expect(deleteData.success).toBe(true);

      // Verify session is gone
      const getRes = await fetch(`${baseUrl}/api/sessions/${quickStartData.data.sessionId}`);
      const getData = await getRes.json();
      expect(getData.error).toContain('not found');
    });

    it('should cleanup multiple sessions when deleted', async () => {
      const sessionIds: string[] = [];

      // Create multiple sessions
      for (let i = 0; i < 3; i++) {
        const caseName = `multi-cleanup-${Date.now()}-${i}`;
        createdCases.push(caseName);

        const res = await fetch(`${baseUrl}/api/quick-start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caseName }),
        });
        const data = await res.json();
        expect(data.success).toBe(true);
        sessionIds.push(data.data.sessionId);
      }

      // Delete all sessions
      for (const id of sessionIds) {
        const deleteRes = await fetch(`${baseUrl}/api/sessions/${id}`, {
          method: 'DELETE',
        });
        const deleteData = await deleteRes.json();
        expect(deleteData.success).toBe(true);
      }

      // Verify all sessions are gone
      const listRes = await fetch(`${baseUrl}/api/sessions`);
      const sessions = await listRes.json();
      for (const id of sessionIds) {
        expect(sessions.data.find((s: any) => s.id === id)).toBeUndefined();
      }
    }, 60000); // Extended timeout for multi-session test
  });

  describe('Respawn Controller Cleanup', () => {
    // TODO(test-harness): this exercises POST /interactive-respawn, but under the VITEST
    // tmux no-op the session never becomes truly interactive, so the respawn controller
    // has nothing to drive and unregisters before the GET — `enabled` reads false. It
    // needs a real interactive session. Respawn-controller cleanup is covered by
    // respawn-controller.test.ts (MockSession). Re-enable if interactive-respawn gains a
    // test-mode path that keeps the controller registered.
    it.skip('should cleanup respawn controller when session is deleted', async () => {
      const caseName = `respawn-cleanup-${Date.now()}`;
      createdCases.push(caseName);

      // Create session
      const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp' }),
      });
      const sessionData = await sessionRes.json();
      expect(sessionData.success).toBe(true);

      // Start interactive with respawn
      const interactiveRes = await fetch(`${baseUrl}/api/sessions/${sessionData.data.session.id}/interactive-respawn`, {
        method: 'POST',
      });
      const interactiveData = await interactiveRes.json();
      expect(interactiveData.success).toBe(true);

      // Verify respawn is running
      const respawnRes = await fetch(`${baseUrl}/api/sessions/${sessionData.data.session.id}/respawn`);
      const respawnData = await respawnRes.json();
      expect(respawnData.data.enabled).toBe(true);

      // Delete session
      await fetch(`${baseUrl}/api/sessions/${sessionData.data.session.id}`, {
        method: 'DELETE',
      });

      // Wait for cleanup to complete (exit event handler)
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify respawn controller is cleaned up (enabled: false when controller doesn't exist)
      const respawnAfterRes = await fetch(`${baseUrl}/api/sessions/${sessionData.data.session.id}/respawn`);
      const respawnAfterData = await respawnAfterRes.json();
      // The respawn endpoint returns enabled: false when there's no controller
      expect(respawnAfterData.data.enabled).toBe(false);
    });
  });

  describe('Scheduled Run Cleanup', () => {
    it('should properly stop scheduled run', async () => {
      // Create a scheduled run
      const createRes = await fetch(`${baseUrl}/api/scheduled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'test cleanup',
          workingDir: '/tmp',
          durationMinutes: 1,
        }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);

      // Stop the scheduled run
      const stopRes = await fetch(`${baseUrl}/api/scheduled/${createData.data.run.id}`, {
        method: 'DELETE',
      });
      const stopData = await stopRes.json();
      expect(stopData.success).toBe(true);

      // Verify status is stopped
      const getRes = await fetch(`${baseUrl}/api/scheduled/${createData.data.run.id}`);
      const getData = await getRes.json();
      expect(getData.data.status).toBe('stopped');
    });
  });
});

describe('Resource Management', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    for (const caseName of createdCases) {
      safeRmHomeTree(join(CASES_DIR, caseName));
    }
    await server.stop();
  }, 60000);

  it('should handle rapid session creation and deletion', async () => {
    // Get initial session count (may have restored sessions from other tests)
    const initialRes = await fetch(`${baseUrl}/api/sessions`);
    const initialSessions = await initialRes.json();
    const initialCount = initialSessions.data.length;

    const iterations = 5;
    const createdSessionIds: string[] = [];

    for (let i = 0; i < iterations; i++) {
      const caseName = `rapid-${Date.now()}-${i}`;
      createdCases.push(caseName);

      // Create
      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessionIds.push(createData.data.sessionId);

      // Delete immediately
      const deleteRes = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}`, {
        method: 'DELETE',
      });
      const deleteData = await deleteRes.json();
      expect(deleteData.success).toBe(true);

      // Small delay to allow async cleanup to complete
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Wait a bit more for all cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify created sessions were deleted (account for restored sessions from other tests)
    const listRes = await fetch(`${baseUrl}/api/sessions`);
    const sessions = await listRes.json();

    // None of the sessions we created should still exist
    for (const sessionId of createdSessionIds) {
      expect(sessions.data.find((s: { id: string }) => s.id === sessionId)).toBeUndefined();
    }

    // Session count should be back to initial (or less if some restored sessions were cleaned up)
    expect(sessions.data.length).toBeLessThanOrEqual(initialCount);
  });

  it('should clear terminal buffer after session stop', async () => {
    const caseName = `buffer-clear-${Date.now()}`;
    createdCases.push(caseName);

    // Create session
    const createRes = await fetch(`${baseUrl}/api/quick-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseName }),
    });
    const createData = await createRes.json();
    expect(createData.success).toBe(true);

    // Wait for some terminal output - Claude startup time can vary
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get terminal buffer before stop - may or may not have content depending on timing
    const terminalRes = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/terminal`);
    const terminalData = await terminalRes.json();
    // Just verify the property exists
    expect(terminalData.data.terminalBuffer).toBeDefined();

    // Delete session
    await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}`, {
      method: 'DELETE',
    });

    // Session should be gone
    const afterRes = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/terminal`);
    const afterData = await afterRes.json();
    expect(afterData.error).toContain('not found');
  });
});
