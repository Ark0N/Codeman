/**
 * @fileoverview Integration tests for Ralph/Todo tracking
 *
 * Tests the complete Ralph Wiggum loop and Todo tracking functionality
 * through the API endpoints. These tests verify:
 * - Session lifecycle (create, list, delete)
 * - Ralph loop state tracking and updates
 * - Todo item detection and management
 * - Ralph configuration via API
 *
 * Test port: ephemeral
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeRmHomeTree } from './mocks/index.js';

const CASES_DIR = join(homedir(), 'codeman-cases');

describe('Ralph Integration Tests', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];
  const createdSessions: string[] = [];

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterEach(() => {
    // Clean up cases created during this test (containment-gated: never
    // delete a case dir outside the temp HOME).
    while (createdCases.length > 0) {
      safeRmHomeTree(join(CASES_DIR, createdCases.pop()!));
    }
  });

  afterAll(async () => {
    // Cleanup sessions
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch {}
    }
    await server.stop();
  }, 60000);

  // ========== Session Lifecycle Tests ==========

  describe('Session Lifecycle', () => {
    it('should list sessions as an array', async () => {
      const res = await fetch(`${baseUrl}/api/sessions`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('should create a new session via quick-start', async () => {
      const caseName = `ralph-test-${Date.now()}`;
      createdCases.push(caseName);

      const res = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.data.sessionId).toBeDefined();
      createdSessions.push(data.data.sessionId);
    });

    it('should get session details by ID', async () => {
      const caseName = `session-detail-${Date.now()}`;
      createdCases.push(caseName);

      // Create session first
      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      createdSessions.push(createData.data.sessionId);

      // Get session details
      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data.id).toBe(createData.data.sessionId);
      expect(data.data.workingDir).toContain(caseName);
    });

    it('should return error for non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/non-existent-id`);
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });

    it('should delete a session', async () => {
      const caseName = `delete-test-${Date.now()}`;
      createdCases.push(caseName);

      // Create session
      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      const sessionId = createData.data.sessionId;

      // Delete session
      const deleteRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      const deleteData = await deleteRes.json();

      expect(deleteRes.status).toBe(200);
      expect(deleteData.success).toBe(true);

      // Verify session is gone
      const getRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      const getData = await getRes.json();
      expect(getRes.status).toBe(404);
      expect(getData.error).toContain('not found');
    });

    it('should create shell session', async () => {
      const caseName = `shell-test-${Date.now()}`;
      createdCases.push(caseName);

      const res = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName, mode: 'shell' }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.data.sessionId).toBeDefined();
      createdSessions.push(data.data.sessionId);

      // Verify mode
      const sessionRes = await fetch(`${baseUrl}/api/sessions/${data.data.sessionId}`);
      const sessionData = await sessionRes.json();
      expect(sessionData.data.mode).toBe('shell');
    });
  });

  // ========== Ralph State API Tests ==========

  describe('Ralph State API', () => {
    it('should get ralph state for session', async () => {
      const caseName = `ralph-state-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-state`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      // API returns { success: true, data: { loop, todos, todoStats } }
      expect(data.data).toBeDefined();
      expect(data.data.loop).toBeDefined();
      expect(data.data.todos).toBeDefined();
    });

    it('should return error for ralph state of non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/fake-session/ralph-state`);
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error).toContain('not found');
    });
  });

  // ========== Cases API Tests ==========

  describe('Cases API', () => {
    it('should list cases', async () => {
      const res = await fetch(`${baseUrl}/api/cases`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('should create a new case', async () => {
      const caseName = `new-case-${Date.now()}`;
      createdCases.push(caseName);

      const res = await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.case.name).toBe(caseName);
    });

    it('should reject duplicate case name', async () => {
      const caseName = `dup-case-${Date.now()}`;
      createdCases.push(caseName);

      // Create first
      await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName }),
      });

      // Try to create duplicate
      const res = await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName }),
      });
      const data = await res.json();

      expect(res.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error).toContain('already exists');
    });

    it('should get case by name', async () => {
      const caseName = `get-case-${Date.now()}`;
      createdCases.push(caseName);

      // Create case
      await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName }),
      });

      // Get case
      const res = await fetch(`${baseUrl}/api/cases/${caseName}`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data.name).toBe(caseName);
      expect(data.data.path).toContain(caseName);
    });

    it('should return error for non-existent case', async () => {
      const res = await fetch(`${baseUrl}/api/cases/non-existent-case-12345`);
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.error).toBe('Case not found');
    });
  });

  // ========== Status API Tests ==========

  describe('Status API', () => {
    it('should return app status', async () => {
      const res = await fetch(`${baseUrl}/api/status`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data.sessions).toBeDefined();
      expect(data.data.scheduledRuns).toBeDefined();
      expect(data.data.respawnStatus).toBeDefined();
      expect(data.data.timestamp).toBeDefined();
    });

    it('should include sessions array in status', async () => {
      const res = await fetch(`${baseUrl}/api/status`);
      const data = await res.json();

      expect(Array.isArray(data.data.sessions)).toBe(true);
      expect(typeof data.data.timestamp).toBe('number');
    });
  });

  // ========== Mux Sessions API Tests ==========

  describe('Mux Sessions API', () => {
    it('should return sessions object with array', async () => {
      const res = await fetch(`${baseUrl}/api/mux-sessions`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data.sessions).toBeDefined();
      expect(Array.isArray(data.data.sessions)).toBe(true);
      expect(typeof data.data.muxAvailable).toBe('boolean');
    });
  });

  // ========== Session Input Tests ==========

  describe('Session Input', () => {
    it('should send input to session', async () => {
      const caseName = `input-test-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'test input' }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should reject null input', async () => {
      const caseName = `input-null-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: null }),
      });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });

    it('should return error for input to non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/fake-session/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'test' }),
      });
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });
  });

  // ========== Session Resize Tests ==========

  describe('Session Resize', () => {
    it('should resize session terminal', async () => {
      const caseName = `resize-test-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      // Wait for session to be ready
      await new Promise((r) => setTimeout(r, 200));

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: 120, rows: 40 }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should reject invalid resize dimensions', async () => {
      const caseName = `resize-invalid-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      // Wait for session to be ready
      await new Promise((r) => setTimeout(r, 200));

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: -1, rows: 40 }),
      });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });
  });

  // ========== Auto-Compact/Clear Config Tests ==========

  describe('Auto-Compact Config', () => {
    it('should configure auto-compact for session', async () => {
      const caseName = `auto-compact-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/auto-compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, threshold: 100000 }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should return error for auto-compact of non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/fake-session/auto-compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });

    it('should reject invalid threshold', async () => {
      const caseName = `auto-compact-invalid-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/auto-compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, threshold: -100 }),
      });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });
  });

  describe('Auto-Clear Config', () => {
    it('should configure auto-clear for session', async () => {
      const caseName = `auto-clear-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/auto-clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, threshold: 150000 }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should return error for auto-clear of non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/fake-session/auto-clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });

    it('should reject invalid threshold for auto-clear', async () => {
      const caseName = `auto-clear-invalid-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/auto-clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, threshold: -50 }),
      });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });
  });

  // ========== Ralph Config API Tests ==========

  describe('Ralph Config API', () => {
    it('should configure ralph tracking for session', async () => {
      const caseName = `ralph-config-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should reset ralph state via config', async () => {
      const caseName = `ralph-reset-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should return error for ralph-config of non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/fake-session/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });

    it('should perform full ralph reset via config', async () => {
      const caseName = `ralph-full-reset-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: 'full' }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should set completion phrase via ralph-config', async () => {
      const caseName = `ralph-phrase-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, completionPhrase: 'DONE' }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify the state was updated
      const stateRes = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-state`);
      const stateData = await stateRes.json();

      expect(stateData.success).toBe(true);
      expect(stateData.data.loop.enabled).toBe(true);
    });

    it('should disable auto-enable via ralph-config', async () => {
      const caseName = `ralph-auto-disable-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disableAutoEnable: true }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  // ========== Ralph State and Todo Tracking Tests ==========

  describe('Ralph State Tracking', () => {
    it('should return initial ralph state with empty todos', async () => {
      const caseName = `ralph-initial-state-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-state`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.loop).toBeDefined();
      expect(data.data.todos).toBeDefined();
      expect(Array.isArray(data.data.todos)).toBe(true);
      expect(data.data.todoStats).toBeDefined();
    });

    it('should track loop state after enabling', async () => {
      const caseName = `ralph-track-loop-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      // Enable ralph tracking
      await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, completionPhrase: 'TASK_DONE' }),
      });

      // Check state
      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-state`);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.data.loop.enabled).toBe(true);
      expect(data.data.loop.completionPhrase).toBe('TASK_DONE');
    });

    it('should clear todos on reset', async () => {
      const caseName = `ralph-clear-todos-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      // Enable first
      await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Then reset
      const resetRes = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
      const resetData = await resetRes.json();

      expect(resetData.success).toBe(true);

      // Check that todos are cleared
      const stateRes = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-state`);
      const stateData = await stateRes.json();

      expect(stateData.success).toBe(true);
      expect(stateData.data.todos).toEqual([]);
    });

    it('should preserve enabled status on soft reset', async () => {
      const caseName = `ralph-soft-reset-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      // Enable tracking
      await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Soft reset (keep enabled)
      await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });

      // Check state
      const stateRes = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-state`);
      const stateData = await stateRes.json();

      expect(stateData.success).toBe(true);
      expect(stateData.data.loop.enabled).toBe(true);
    });

    it('should disable tracking on full reset', async () => {
      const caseName = `ralph-full-reset-disable-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      // Enable tracking
      await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Full reset
      await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: 'full' }),
      });

      // Check state
      const stateRes = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/ralph-state`);
      const stateData = await stateRes.json();

      expect(stateData.success).toBe(true);
      expect(stateData.data.loop.enabled).toBe(false);
    });
  });

  // ========== Respawn Controller Tests ==========

  describe('Respawn Controller API', () => {
    it('should return no respawn status for new session', async () => {
      const caseName = `respawn-new-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/respawn`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data.enabled).toBe(false);
    });

    it('should return error for respawn start on non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/fake-session/respawn/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });

    it('should return error for respawn stop without controller', async () => {
      const caseName = `respawn-stop-none-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/respawn/stop`, {
        method: 'POST',
      });
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });

    it('should save respawn config as pre-config without controller', async () => {
      const caseName = `respawn-config-none-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/respawn/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idleTimeoutMs: 10000 }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.config.idleTimeoutMs).toBe(10000);
    });
  });

  // ========== Session Output and Terminal Tests ==========

  describe('Session Output API', () => {
    it('should get session output', async () => {
      const caseName = `output-test-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/output`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(data.data.textOutput).toBeDefined();
      expect(data.data.messages).toBeDefined();
    });

    it('should return error for output of non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/fake-session/output`);
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });

    it('should get session terminal buffer', async () => {
      const caseName = `terminal-test-${Date.now()}`;
      createdCases.push(caseName);

      const createRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);
      createdSessions.push(createData.data.sessionId);

      const res = await fetch(`${baseUrl}/api/sessions/${createData.data.sessionId}/terminal`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data.terminalBuffer).toBeDefined();
      expect(data.data.status).toBeDefined();
    });

    it('should return error for terminal of non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/fake-session/terminal`);
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });
  });
});
