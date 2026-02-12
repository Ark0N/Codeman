import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TEST_PORT = 3099;
const CASES_DIR = join(homedir(), 'claudeman-cases');

describe('Quick Start API', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];

  beforeAll(async () => {
    server = new WebServer(TEST_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT}`;
  });

  afterEach(() => {
    // Clean up cases created during this test
    while (createdCases.length > 0) {
      const caseName = createdCases.pop()!;
      const casePath = join(CASES_DIR, caseName);
      if (existsSync(casePath)) {
        rmSync(casePath, { recursive: true, force: true });
      }
    }
  });

  afterAll(async () => {
    await server.stop();
  }, 30000);

  describe('POST /api/quick-start', () => {
    it('should create default testcase and start interactive session', async () => {
      const testCaseName = 'test-quick-start-default-' + Date.now();
      createdCases.push(testCaseName);

      const response = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: testCaseName }),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.sessionId).toBeDefined();
      expect(data.caseName).toBe(testCaseName);
      expect(data.casePath).toBe(join(CASES_DIR, testCaseName));

      // Verify case folder was created
      expect(existsSync(data.casePath)).toBe(true);
      expect(existsSync(join(data.casePath, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(data.casePath, 'src'))).toBe(true);
    });

    it('should use existing case without recreating it', async () => {
      const testCaseName = 'test-existing-case-' + Date.now();
      const casePath = join(CASES_DIR, testCaseName);
      createdCases.push(testCaseName);

      // Pre-create the case
      mkdirSync(casePath, { recursive: true });

      const response = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: testCaseName }),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.caseName).toBe(testCaseName);
      // Case should exist but CLAUDE.md won't be created since case already exists
      expect(existsSync(casePath)).toBe(true);
    });

    it('should reject invalid case names with special characters', async () => {
      const response = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: 'invalid/case\\name!' }),
      });

      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid case name');
    });

    it('should reject case names with spaces', async () => {
      const response = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: 'case with spaces' }),
      });

      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid case name');
    });

    it('should accept case names with hyphens and underscores', async () => {
      const testCaseName = 'test-case_with-mixed_123-' + Date.now();
      createdCases.push(testCaseName);

      const response = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: testCaseName }),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.caseName).toBe(testCaseName);
    });

    it('should default to "testcase" when no caseName provided', async () => {
      // Clean up testcase if it exists from previous runs
      const testcasePath = join(CASES_DIR, 'testcase');
      if (!createdCases.includes('testcase')) {
        createdCases.push('testcase');
      }

      const response = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.caseName).toBe('testcase');
    });
  });
});

describe('Session Management', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(TEST_PORT + 1, false, true);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT + 1}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('POST /api/sessions', () => {
    it('should create a new session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp' }),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.session).toBeDefined();
      expect(data.session.id).toBeDefined();
      expect(data.session.workingDir).toBe('/tmp');
      expect(data.session.status).toBe('idle');
    });
  });

  describe('GET /api/sessions', () => {
    it('should return list of sessions', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`);
      const data = await response.json();

      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('GET /api/status', () => {
    it('should return full server state', async () => {
      const response = await fetch(`${baseUrl}/api/status`);
      const data = await response.json();

      expect(data).toHaveProperty('sessions');
      expect(data).toHaveProperty('scheduledRuns');
      expect(data).toHaveProperty('respawnStatus');
      expect(data).toHaveProperty('timestamp');
      expect(Array.isArray(data.sessions)).toBe(true);
      expect(Array.isArray(data.scheduledRuns)).toBe(true);
    });
  });
});

describe('Case Management', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];

  beforeAll(async () => {
    server = new WebServer(TEST_PORT + 2, false, true);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT + 2}`;
  });

  afterAll(async () => {
    await server.stop();
    for (const caseName of createdCases) {
      const casePath = join(CASES_DIR, caseName);
      if (existsSync(casePath)) {
        rmSync(casePath, { recursive: true, force: true });
      }
    }
  });

  describe('GET /api/cases', () => {
    it('should return list of cases', async () => {
      const response = await fetch(`${baseUrl}/api/cases`);
      const data = await response.json();

      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('POST /api/cases', () => {
    it('should create a new case', async () => {
      const testCaseName = 'test-case-create-' + Date.now();
      createdCases.push(testCaseName);

      const response = await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: testCaseName, description: 'Test case' }),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.data.case.name).toBe(testCaseName);
    });

    it('should reject duplicate case names', async () => {
      const testCaseName = 'test-case-duplicate-' + Date.now();
      createdCases.push(testCaseName);

      // Create first case
      await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: testCaseName }),
      });

      // Try to create duplicate
      const response = await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: testCaseName }),
      });

      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('already exists');
    });

    it('should reject invalid case names', async () => {
      const response = await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'invalid name!' }),
      });

      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid case name');
    });
  });

  describe('GET /api/cases/:name', () => {
    it('should return case details', async () => {
      const testCaseName = 'test-case-get-' + Date.now();
      createdCases.push(testCaseName);

      // Create case first
      await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: testCaseName }),
      });

      const response = await fetch(`${baseUrl}/api/cases/${testCaseName}`);
      const data = await response.json();

      expect(data.name).toBe(testCaseName);
      expect(data.path).toBeDefined();
      expect(data.hasClaudeMd).toBe(true);
    });

    it('should return error for non-existent case', async () => {
      const response = await fetch(`${baseUrl}/api/cases/non-existent-case-12345`);
      const data = await response.json();

      expect(data.error).toBe('Case not found');
    });
  });
});
