import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { WebServer } from '../src/web/server.js';
import { existsSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORIGINAL_HOME = process.env.HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'codeman-quick-start-'));
const CASES_DIR = join(TEST_HOME, 'codeman-cases');
let webServerModule: Promise<typeof import('../src/web/server.js')> | undefined;

process.env.HOME = TEST_HOME;

async function createTestServer(): Promise<WebServer> {
  webServerModule ??= import('../src/web/server.js');
  const { WebServer: TestWebServer } = await webServerModule;
  return new TestWebServer(0, false, true);
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
    server = await createTestServer();
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  }, 30000);

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
    server = await createTestServer();
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('POST /api/sessions', () => {
    it('should create a new session', async () => {
      // Under the test HOME, never the machine's real `/tmp`: a create writes the workspace
      // hooks and the agent skill (on by default) into its working dir.
      const workingDir = mkdtempSync(join(TEST_HOME, 'work-'));
      const response = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir }),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.data.session).toBeDefined();
      expect(data.data.session.id).toBeDefined();
      expect(data.data.session.workingDir).toBe(workingDir);
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
    server = await createTestServer();
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
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
    server = await createTestServer();
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
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

  // The tests below run in order against one server and one settings.json: absent key
  // (on), a partial PUT that omits it (still on), then an explicit false (off).
  const skillDirOf = (caseName: string) => join(CASES_DIR, caseName, '.claude', 'skills', 'codeman');

  async function quickStart(prefix: string, mode?: string): Promise<string> {
    const caseName = `${prefix}-${Date.now()}`;
    createdCases.push(caseName);
    const response = await fetch(`${baseUrl}/api/quick-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mode ? { caseName, mode } : { caseName }),
    });
    expect((await response.json()).success).toBe(true);
    return caseName;
  }

  async function putSettings(body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await response.json()).success).toBe(true);
    // The server's settings read is cached ~2s; outwait it so the next create sees the change.
    await new Promise((resolve) => setTimeout(resolve, 2100));
  }

  /** What settings.json holds, read back through GET /api/settings (enveloped or not). */
  async function storedSettings(): Promise<Record<string, unknown>> {
    const body = (await (await fetch(`${baseUrl}/api/settings`)).json()) as Record<string, unknown>;
    const settings = (body.success === true ? body.data : body) as Record<string, unknown>;
    // Not vacuous: every quick-start above records the case it used.
    expect(settings).toHaveProperty('lastUsedCase');
    return settings;
  }

  it('injects by default: a settings.json without the key means on', async () => {
    const caseName = await quickStart('test-skill-default');
    // A quick-start writes lastUsedCase, never this key.
    expect(await storedSettings()).not.toHaveProperty('agentSkillEnabled');

    const { readFileSync } = await import('node:fs');
    const skillMd = readFileSync(join(skillDirOf(caseName), 'SKILL.md'), 'utf-8');
    expect(skillMd.startsWith('---\nname: codeman')).toBe(true);
    expect(skillMd).toContain('<!-- codeman-managed-agent-skill');
    expect(existsSync(join(skillDirOf(caseName), 'reference', 'endpoints.md'))).toBe(true);
    expect(existsSync(join(skillDirOf(caseName), 'reference', 'recipes.md'))).toBe(true);
    // The copy ignores itself in git, so the default leaves a repository's status clean.
    expect(readFileSync(join(skillDirOf(caseName), '.gitignore'), 'utf-8')).toBe('*\n');
  }, 30000);

  it('a partial settings PUT that omits the key keeps it on', async () => {
    await putSettings({ autoNameSessions: false });
    expect(await storedSettings()).not.toHaveProperty('agentSkillEnabled');

    const caseName = await quickStart('test-skill-partial');
    expect(existsSync(join(skillDirOf(caseName), 'SKILL.md'))).toBe(true);
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

  it('an explicit false turns it off, and a later partial PUT leaves it off', async () => {
    // The `.strict()` settings schema accepts the synced key.
    await putSettings({ agentSkillEnabled: false });
    await putSettings({ autoNameSessions: true });
    expect((await storedSettings()).agentSkillEnabled).toBe(false);

    const caseName = await quickStart('test-skill-off');
    expect(existsSync(join(CASES_DIR, caseName))).toBe(true);
    expect(existsSync(skillDirOf(caseName))).toBe(false);
  }, 30000);
});
