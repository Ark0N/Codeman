import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeRmHomeTree } from './mocks/index.js';

const CASES_DIR = join(homedir(), 'codeman-cases');

describe('Edge Cases and Error Handling', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterEach(() => {
    // Clean up cases created during this test. SAFETY: CASES_DIR is
    // homedir()-derived, which on some platforms ignores the test HOME — the
    // containment gate refuses to delete anything not under the temp HOME.
    while (createdCases.length > 0) {
      const caseName = createdCases.pop()!;
      safeRmHomeTree(join(CASES_DIR, caseName));
    }
  });

  afterAll(async () => {
    await server.stop();
  }, 30000);

  describe('Session Edge Cases', () => {
    it('should handle deleting non-existent session gracefully', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent-id-12345`, {
        method: 'DELETE',
      });
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('not found');
    });

    it('should handle getting non-existent session gracefully', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent-id-12345`);
      const data = await response.json();

      expect(data.error).toContain('not found');
    });

    it('should handle running prompt on non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'test' }),
      });
      const data = await response.json();

      expect(data.error).toContain('not found');
    });

    it('should handle input to non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'test' }),
      });
      const data = await response.json();

      expect(data.error).toContain('not found');
    });

    it('should handle resize on non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      });
      const data = await response.json();

      expect(data.error).toContain('not found');
    });

    it('should handle interactive mode on non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/interactive`, {
        method: 'POST',
      });
      const data = await response.json();

      expect(data.error).toContain('not found');
    });

    it('should handle terminal buffer request on non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/terminal`);
      const data = await response.json();

      expect(data.error).toContain('not found');
    });

    it('should handle output request on non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/output`);
      const data = await response.json();

      expect(data.error).toContain('not found');
    });
  });

  describe('Case Edge Cases', () => {
    it('should reject empty case name', async () => {
      const response = await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid case name');
    });

    it('should reject case name with only special characters', async () => {
      const response = await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '!@#$%^' }),
      });
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid case name');
    });

    it('should reject case name with path traversal attempt', async () => {
      const response = await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '../escape' }),
      });
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid case name');
    });

    it('should handle getting non-existent case', async () => {
      const response = await fetch(`${baseUrl}/api/cases/this-case-does-not-exist-12345`);
      const data = await response.json();

      expect(data.error).toBe('Case not found');
    });
  });

  describe('Quick Start Edge Cases', () => {
    it('should reject quick start with empty case name', async () => {
      const response = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: '' }),
      });
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid case name');
    });

    it('should reject quick start with special characters', async () => {
      const response = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: 'test/../../etc/passwd' }),
      });
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid case name');
    });

    it('should handle very long case names gracefully', async () => {
      // Test with a very long but valid case name
      const longName = 'a'.repeat(100);
      const response = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: longName }),
      });
      const data = await response.json();

      // Should succeed with valid characters, even if long
      if (data.success) {
        createdCases.push(data.data.caseName);
      }
      // Either succeeds or fails gracefully
      expect(data).toHaveProperty('success');
    });
  });

  describe('Respawn Controller Edge Cases', () => {
    it('should handle getting respawn status for non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/respawn`);
      const data = await response.json();

      expect(data.data.enabled).toBe(false);
      expect(data.data.status).toBeNull();
    });

    it('should handle starting respawn on non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/respawn/start`, {
        method: 'POST',
      });
      const data = await response.json();

      expect(data.error).toContain('not found');
    });

    it('should handle stopping non-existent respawn controller', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/respawn/stop`, {
        method: 'POST',
      });
      const data = await response.json();

      // respawn/stop now owner-gates via findSessionOrFail first (multi-user #18), so a
      // non-existent session id 404s as "Session ... not found" (same not-found semantics,
      // matching the sibling start/config/enable handlers).
      expect(data.error).toContain('not found');
    });

    it('should handle updating config on non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/respawn/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idleTimeoutMs: 5000 }),
      });
      const data = await response.json();

      expect(data.error).toContain('not found');
    });
  });

  describe('Scheduled Run Edge Cases', () => {
    it('should handle stopping non-existent scheduled run', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled/non-existent`, {
        method: 'DELETE',
      });
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toBe('Scheduled run not found');
    });

    it('should handle getting non-existent scheduled run', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled/non-existent`);
      const data = await response.json();

      expect(data.error).toBe('Scheduled run not found');
    });
  });
});

describe('Concurrent Session Handling', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
  }, 30000);

  it('should handle multiple sessions simultaneously', async () => {
    // Create multiple sessions concurrently
    const createPromises = Array(5)
      .fill(null)
      .map(() =>
        fetch(`${baseUrl}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir: '/tmp' }),
        }).then((r) => r.json())
      );

    const results = await Promise.all(createPromises);

    // All should succeed
    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.data.session.id).toBeDefined();
    }

    // Verify sessions are listed
    const listRes = await fetch(`${baseUrl}/api/sessions`);
    const sessions = await listRes.json();
    expect(sessions.data.length).toBeGreaterThanOrEqual(5);

    // Clean up - delete all created sessions
    for (const result of results) {
      await fetch(`${baseUrl}/api/sessions/${result.data.session.id}`, {
        method: 'DELETE',
      });
    }
  });

  it('should handle rapid session creation and deletion', async () => {
    const iterations = 10;

    for (let i = 0; i < iterations; i++) {
      // Create
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp' }),
      });
      const createData = await createRes.json();
      expect(createData.success).toBe(true);

      // Delete immediately
      const deleteRes = await fetch(`${baseUrl}/api/sessions/${createData.data.session.id}`, {
        method: 'DELETE',
      });
      const deleteData = await deleteRes.json();
      expect(deleteData.success).toBe(true);
    }
  });

  it('should handle multiple quick starts concurrently', async () => {
    const caseNames = ['concurrent-test-1', 'concurrent-test-2', 'concurrent-test-3'];
    const createdCases: string[] = [];

    const quickStartPromises = caseNames.map((name) =>
      fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: `${name}-${Date.now()}` }),
      }).then((r) => r.json())
    );

    const results = await Promise.all(quickStartPromises);

    for (const result of results) {
      expect(result.success).toBe(true);
      if (result.data.caseName) {
        createdCases.push(result.data.caseName);
      }
    }

    // Cleanup (containment-gated: never touch prod ~/codeman-cases)
    for (const name of createdCases) {
      safeRmHomeTree(join(homedir(), 'codeman-cases', name));
    }
  });
});

describe('API Request Validation', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
  }, 30000);

  it('should handle malformed JSON in request body', async () => {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json',
    });

    // Should return an error status
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('should handle empty request body when one is expected', async () => {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });

    // Should either succeed with defaults or return appropriate error
    // Fastify handles this gracefully
    expect([200, 400, 500]).toContain(response.status);
  });

  it('should handle requests with missing content-type', async () => {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
    });

    // Should work or fail gracefully
    expect(response.status).toBeDefined();
  });
});
