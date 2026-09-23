import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { WebServer } from '../src/web/server.js';
import { existsSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_PORT = 3099;
const ORIGINAL_HOME = process.env.HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'codeman-quick-start-'));
const CASES_DIR = join(TEST_HOME, 'codeman-cases');
let webServerModule: Promise<typeof import('../src/web/server.js')> | undefined;

process.env.HOME = TEST_HOME;

async function createTestServer(port: number): Promise<WebServer> {
  webServerModule ??= import('../src/web/server.js');
  const { WebServer: TestWebServer } = await webServerModule;
  return new TestWebServer(port, false, true);
}

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('Quick Start API', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];

  beforeAll(async () => {
    server = await createTestServer(TEST_PORT);
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
      expect(data.data.sessionId).toBeDefined();
      expect(data.data.caseName).toBe(testCaseName);
      expect(data.data.casePath).toBe(join(CASES_DIR, testCaseName));

      // Verify case folder was created
      expect(existsSync(data.data.casePath)).toBe(true);
      expect(existsSync(join(data.data.casePath, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(data.data.casePath, 'src'))).toBe(true);
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
      expect(data.data.caseName).toBe(testCaseName);
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
      expect(data.data.caseName).toBe(testCaseName);
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
      expect(data.data.caseName).toBe('testcase');
    });
  });
});

describe('Session Management', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createTestServer(TEST_PORT + 1);
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
      expect(data.data.session).toBeDefined();
      expect(data.data.session.id).toBeDefined();
      expect(data.data.session.workingDir).toBe('/tmp');
      expect(data.data.session.status).toBe('idle');
    });
  });

  describe('GET /api/sessions', () => {
    it('should return list of sessions', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
    });
  });

  describe('GET /api/status', () => {
    it('should return full server state', async () => {
      const response = await fetch(`${baseUrl}/api/status`);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('sessions');
      expect(data.data).toHaveProperty('scheduledRuns');
      expect(data.data).toHaveProperty('respawnStatus');
      expect(data.data).toHaveProperty('timestamp');
      expect(Array.isArray(data.data.sessions)).toBe(true);
      expect(Array.isArray(data.data.scheduledRuns)).toBe(true);
    });
  });
});

describe('Case Management', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];

  beforeAll(async () => {
    server = await createTestServer(TEST_PORT + 2);
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

      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
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

      expect(data.success).toBe(true);
      expect(data.data.name).toBe(testCaseName);
      expect(data.data.path).toBeDefined();
      expect(data.data.hasClaudeMd).toBe(true);
    });

    it('should return error for non-existent case', async () => {
      const response = await fetch(`${baseUrl}/api/cases/non-existent-case-12345`);
      const data = await response.json();

      expect(data.error).toBe('Case not found');
    });
  });
});

describe('Agent skill injection (agentSkillEnabled)', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdCases: string[] = [];

  beforeAll(async () => {
    server = await createTestServer(TEST_PORT + 4); // 3103
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT + 4}`;
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

  it('does not inject by default, accepts the setting via PUT, then injects on quick-start', async () => {
    // 1. Default OFF: a claude quick-start creates the case without the skill.
    const offCase = 'test-skill-off-' + Date.now();
    createdCases.push(offCase);
    const offResponse = await fetch(`${baseUrl}/api/quick-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseName: offCase }),
    });
    const offData = await offResponse.json();
    expect(offData.success).toBe(true);
    expect(existsSync(join(CASES_DIR, offCase, '.claude', 'skills', 'codeman'))).toBe(false);

    // 2. The `.strict()` settings schema accepts the new synced key.
    const putResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSkillEnabled: true }),
    });
    const putData = await putResponse.json();
    expect(putData.success).toBe(true);

    // 3. The server's settings read is cached ~2s; outwait it so the create sees the toggle.
    await new Promise((resolve) => setTimeout(resolve, 2100));

    // 4. Quick-start now injects the marker-carrying skill into the new case.
    const onCase = 'test-skill-on-' + Date.now();
    createdCases.push(onCase);
    const onResponse = await fetch(`${baseUrl}/api/quick-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseName: onCase }),
    });
    const onData = await onResponse.json();
    expect(onData.success).toBe(true);

    const skillDir = join(CASES_DIR, onCase, '.claude', 'skills', 'codeman');
    const { readFileSync } = await import('node:fs');
    const skillMd = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd.startsWith('---\nname: codeman')).toBe(true);
    expect(skillMd).toContain('<!-- codeman-managed-agent-skill');
    expect(existsSync(join(skillDir, 'reference', 'endpoints.md'))).toBe(true);
    expect(existsSync(join(skillDir, 'reference', 'recipes.md'))).toBe(true);
  }, 30000);

  it('does not inject for shell-mode quick-start even when enabled', async () => {
    const shellCase = 'test-skill-shell-' + Date.now();
    createdCases.push(shellCase);
    const response = await fetch(`${baseUrl}/api/quick-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseName: shellCase, mode: 'shell' }),
    });
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(existsSync(join(CASES_DIR, shellCase, '.claude', 'skills', 'codeman'))).toBe(false);
  });
});
