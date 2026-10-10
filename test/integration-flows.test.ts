import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeRmHomeTree } from './mocks/index.js';

const CASES_DIR = join(homedir(), 'codeman-cases');

/**
 * Integration tests for complete user flows
 * These tests verify end-to-end scenarios that users would perform
 */
describe('Integration Flows', () => {
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
    // delete a case dir outside the temp HOME, e.g. prod ~/codeman-cases on
    // platforms where os.homedir() ignores $HOME).
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

  describe('Quick Start to Interactive Session Flow', () => {
    it('should complete full quick start flow: create case -> start session -> interactive mode', async () => {
      const caseName = `flow-test-${Date.now()}`;
      createdCases.push(caseName);

      // Step 1: Quick start (creates case + session + starts interactive)
      const quickStartRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const quickStartData = await quickStartRes.json();

      expect(quickStartData.success).toBe(true);
      expect(quickStartData.data.sessionId).toBeDefined();
      expect(quickStartData.data.caseName).toBe(caseName);
      createdSessions.push(quickStartData.data.sessionId);

      // Step 2: Verify session is in interactive mode
      const sessionRes = await fetch(`${baseUrl}/api/sessions/${quickStartData.data.sessionId}`);
      const sessionData = await sessionRes.json();

      expect(sessionData.data.id).toBe(quickStartData.data.sessionId);
      expect(sessionData.data.workingDir).toContain(caseName);
      expect(['busy', 'idle', 'running']).toContain(sessionData.data.status); // May transition quickly in test mode

      // Step 3: Verify case was created with CLAUDE.md
      const caseRes = await fetch(`${baseUrl}/api/cases/${caseName}`);
      const caseData = await caseRes.json();

      expect(caseData.data.name).toBe(caseName);
      expect(caseData.data.hasClaudeMd).toBe(true);
    });

    it('should reuse existing case when quick starting with existing case name', async () => {
      const caseName = `reuse-test-${Date.now()}`;
      createdCases.push(caseName);

      // First quick start - creates the case
      const firstRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const firstData = await firstRes.json();
      expect(firstData.success).toBe(true);
      createdSessions.push(firstData.data.sessionId);

      // Delete the session but keep the case
      await fetch(`${baseUrl}/api/sessions/${firstData.data.sessionId}`, { method: 'DELETE' });

      // Second quick start - should reuse the case
      const secondRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const secondData = await secondRes.json();

      expect(secondData.success).toBe(true);
      expect(secondData.data.caseName).toBe(caseName);
      expect(secondData.data.casePath).toBe(firstData.data.casePath);
      createdSessions.push(secondData.data.sessionId);
    });
  });

  describe('Manual Case and Session Flow', () => {
    it('should complete manual flow: create case -> create session -> start interactive', async () => {
      const caseName = `manual-flow-${Date.now()}`;
      createdCases.push(caseName);

      // Step 1: Create case
      const caseRes = await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName, description: 'Test case for manual flow' }),
      });
      const caseData = await caseRes.json();
      expect(caseData.success).toBe(true);

      // Step 2: Create session with case directory
      const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: caseData.data.case.path }),
      });
      const sessionData = await sessionRes.json();
      expect(sessionData.success).toBe(true);
      createdSessions.push(sessionData.data.session.id);

      // Step 3: Start interactive mode
      const interactiveRes = await fetch(`${baseUrl}/api/sessions/${sessionData.data.session.id}/interactive`, {
        method: 'POST',
      });
      const interactiveData = await interactiveRes.json();
      expect(interactiveData.success).toBe(true);

      // Verify session state
      const verifyRes = await fetch(`${baseUrl}/api/sessions/${sessionData.data.session.id}`);
      const verifyData = await verifyRes.json();
      expect(['busy', 'idle', 'running']).toContain(verifyData.data.status);
      expect(verifyData.data.workingDir).toContain(caseName);
    });
  });

  describe('Session Input Flow', () => {
    it('should handle input to interactive session', async () => {
      const caseName = `input-flow-${Date.now()}`;
      createdCases.push(caseName);

      // Quick start to get interactive session
      const quickStartRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const quickStartData = await quickStartRes.json();
      expect(quickStartData.success).toBe(true);
      createdSessions.push(quickStartData.data.sessionId);

      // Wait for Claude to start up
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Send input
      const inputRes = await fetch(`${baseUrl}/api/sessions/${quickStartData.data.sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '/help\n' }),
      });
      const inputData = await inputRes.json();
      expect(inputData.success).toBe(true);

      // Wait for response
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check terminal buffer has content
      const terminalRes = await fetch(`${baseUrl}/api/sessions/${quickStartData.data.sessionId}/terminal`);
      const terminalData = await terminalRes.json();
      expect(terminalData.data.terminalBuffer.length).toBeGreaterThan(0);
    });

    it('should handle terminal resize', async () => {
      const caseName = `resize-flow-${Date.now()}`;
      createdCases.push(caseName);

      // Quick start
      const quickStartRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const quickStartData = await quickStartRes.json();
      expect(quickStartData.success).toBe(true);
      createdSessions.push(quickStartData.data.sessionId);

      // Resize terminal (retry briefly — a just-quick-started session can be
      // momentarily busy, which would return SESSION_BUSY; this is a transient race).
      let resizeData;
      for (let attempt = 0; attempt < 5; attempt++) {
        const resizeRes = await fetch(`${baseUrl}/api/sessions/${quickStartData.data.sessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: 200, rows: 50 }),
        });
        resizeData = await resizeRes.json();
        if (resizeData.success) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(resizeData.success).toBe(true);
    });
  });

  describe('Session Cleanup Flow', () => {
    it('should properly stop and delete session', async () => {
      const caseName = `cleanup-flow-${Date.now()}`;
      createdCases.push(caseName);

      // Create session via quick start
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
      const verifyRes = await fetch(`${baseUrl}/api/sessions/${quickStartData.data.sessionId}`);
      const verifyData = await verifyRes.json();
      expect(verifyData.error).toContain('not found');
    });
  });

  describe('Full Status API Flow', () => {
    it('should return consistent state across status API', async () => {
      const caseName = `status-flow-${Date.now()}`;
      createdCases.push(caseName);

      // Create a session
      const quickStartRes = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName }),
      });
      const quickStartData = await quickStartRes.json();
      expect(quickStartData.success).toBe(true);
      createdSessions.push(quickStartData.data.sessionId);

      // Get full status
      const statusRes = await fetch(`${baseUrl}/api/status`);
      const statusData = await statusRes.json();

      expect(statusData.data.sessions).toBeDefined();
      expect(Array.isArray(statusData.data.sessions)).toBe(true);
      expect(statusData.data.scheduledRuns).toBeDefined();
      expect(statusData.data.respawnStatus).toBeDefined();
      expect(statusData.data.timestamp).toBeDefined();

      // Verify our session is in the list
      const ourSession = statusData.data.sessions.find((s: any) => s.id === quickStartData.data.sessionId);
      expect(ourSession).toBeDefined();
      expect(ourSession.workingDir).toContain(caseName);
    });
  });
});

describe('SSE Event Flow', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];
  const createdSessions: string[] = [];

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch {}
    }
    for (const caseName of createdCases) {
      safeRmHomeTree(join(CASES_DIR, caseName));
    }
    await server.stop();
  }, 60000);

  it('should receive all expected events during quick start flow', async () => {
    const caseName = `sse-flow-${Date.now()}`;
    createdCases.push(caseName);

    // Start SSE connection
    const controller = new AbortController();
    let receivedData = '';
    const receivedEvents: string[] = [];

    const fetchPromise = fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    }).then(async (response) => {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);
            receivedData += chunk;
            // Extract event types
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                receivedEvents.push(line.substring(7));
              }
            }
          }
        } catch {}
      }
    });

    // Wait for connection
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Perform quick start
    const quickStartRes = await fetch(`${baseUrl}/api/quick-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseName }),
    });
    const quickStartData = await quickStartRes.json();
    expect(quickStartData.success).toBe(true);
    createdSessions.push(quickStartData.data.sessionId);

    // Wait for events
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop SSE
    controller.abort();
    try {
      await fetchPromise;
    } catch {}

    // Verify expected events were received
    expect(receivedEvents).toContain('init');
    expect(receivedEvents).toContain('session:created');
    expect(receivedEvents).toContain('session:interactive');
    // case:created should be emitted for new cases
    expect(receivedEvents).toContain('case:created');
  });
});
