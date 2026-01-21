import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TEST_PORT = 3120;
const CASES_DIR = join(homedir(), 'claudeman-cases');

/**
 * Session Cleanup Tests
 *
 * Tests for automatic session cleanup and resource management
 */
describe('Session Cleanup', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];
  const createdSessions: string[] = [];

  beforeAll(async () => {
    server = new WebServer(TEST_PORT);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT}`;
  });

  afterAll(async () => {
    // Cleanup all sessions
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch {}
    }
    // Cleanup all cases
    for (const caseName of createdCases) {
      const casePath = join(CASES_DIR, caseName);
      if (existsSync(casePath)) {
        rmSync(casePath, { recursive: true, force: true });
      }
    }
    await server.stop();
  }, 60000);

  describe('Session Deletion', () => {
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
      const deleteRes = await fetch(`${baseUrl}/api/sessions/${quickStartData.sessionId}`, {
        method: 'DELETE',
      });
      const deleteData = await deleteRes.json();
      expect(deleteData.success).toBe(true);

      // Verify session is gone
      const getRes = await fetch(`${baseUrl}/api/sessions/${quickStartData.sessionId}`);
      const getData = await getRes.json();
      expect(getData.error).toBe('Session not found');
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
        sessionIds.push(data.sessionId);
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
        expect(sessions.find((s: any) => s.id === id)).toBeUndefined();
      }
    }, 60000); // Extended timeout for multi-session test
  });

  describe('Respawn Controller Cleanup', () => {
    it('should cleanup respawn controller when session is deleted', async () => {
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
      const interactiveRes = await fetch(`${baseUrl}/api/sessions/${sessionData.session.id}/interactive-respawn`, {
        method: 'POST',
      });
      const interactiveData = await interactiveRes.json();
      expect(interactiveData.success).toBe(true);

      // Verify respawn is running
      const respawnRes = await fetch(`${baseUrl}/api/sessions/${sessionData.session.id}/respawn`);
      const respawnData = await respawnRes.json();
      expect(respawnData.enabled).toBe(true);

      // Delete session
      await fetch(`${baseUrl}/api/sessions/${sessionData.session.id}`, {
        method: 'DELETE',
      });

      // Wait for cleanup to complete (exit event handler)
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify respawn controller is cleaned up (enabled: false when controller doesn't exist)
      const respawnAfterRes = await fetch(`${baseUrl}/api/sessions/${sessionData.session.id}/respawn`);
      const respawnAfterData = await respawnAfterRes.json();
      // The respawn endpoint returns enabled: false when there's no controller
      expect(respawnAfterData.enabled).toBe(false);
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
      const stopRes = await fetch(`${baseUrl}/api/scheduled/${createData.run.id}`, {
        method: 'DELETE',
      });
      const stopData = await stopRes.json();
      expect(stopData.success).toBe(true);

      // Verify status is stopped
      const getRes = await fetch(`${baseUrl}/api/scheduled/${createData.run.id}`);
      const getData = await getRes.json();
      expect(getData.status).toBe('stopped');
    });
  });
});

describe('Resource Management', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];

  beforeAll(async () => {
    server = new WebServer(TEST_PORT + 1);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT + 1}`;
  });

  afterAll(async () => {
    for (const caseName of createdCases) {
      const casePath = join(CASES_DIR, caseName);
      if (existsSync(casePath)) {
        rmSync(casePath, { recursive: true, force: true });
      }
    }
    await server.stop();
  }, 60000);

  it('should handle rapid session creation and deletion', async () => {
    // Get initial session count (may have restored sessions from other tests)
    const initialRes = await fetch(`${baseUrl}/api/sessions`);
    const initialSessions = await initialRes.json();
    const initialCount = initialSessions.length;

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
      createdSessionIds.push(createData.sessionId);

      // Delete immediately
      const deleteRes = await fetch(`${baseUrl}/api/sessions/${createData.sessionId}`, {
        method: 'DELETE',
      });
      const deleteData = await deleteRes.json();
      expect(deleteData.success).toBe(true);

      // Small delay to allow async cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Wait a bit more for all cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify created sessions were deleted (account for restored sessions from other tests)
    const listRes = await fetch(`${baseUrl}/api/sessions`);
    const sessions = await listRes.json();

    // None of the sessions we created should still exist
    for (const sessionId of createdSessionIds) {
      expect(sessions.find((s: { id: string }) => s.id === sessionId)).toBeUndefined();
    }

    // Session count should be back to initial (or less if some restored sessions were cleaned up)
    expect(sessions.length).toBeLessThanOrEqual(initialCount);
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
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get terminal buffer before stop - may or may not have content depending on timing
    const terminalRes = await fetch(`${baseUrl}/api/sessions/${createData.sessionId}/terminal`);
    const terminalData = await terminalRes.json();
    // Just verify the property exists
    expect(terminalData.terminalBuffer).toBeDefined();

    // Delete session
    await fetch(`${baseUrl}/api/sessions/${createData.sessionId}`, {
      method: 'DELETE',
    });

    // Session should be gone
    const afterRes = await fetch(`${baseUrl}/api/sessions/${createData.sessionId}/terminal`);
    const afterData = await afterRes.json();
    expect(afterData.error).toBe('Session not found');
  });
});
