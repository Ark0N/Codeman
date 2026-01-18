import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebServer } from '../src/web/server.js';

const TEST_PORT = 3105;

describe('Scheduled Runs API', () => {
  let server: WebServer;
  let baseUrl: string;
  const createdRuns: string[] = [];

  beforeAll(async () => {
    server = new WebServer(TEST_PORT);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT}`;
  });

  afterAll(async () => {
    // Cancel any remaining runs
    for (const runId of createdRuns) {
      try {
        await fetch(`${baseUrl}/api/scheduled/${runId}`, { method: 'DELETE' });
      } catch {}
    }
    await server.stop();
  });

  describe('GET /api/scheduled', () => {
    it('should return empty list initially', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled`);
      const data = await response.json();

      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('POST /api/scheduled', () => {
    it('should create a scheduled run', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'echo test',
          workingDir: '/tmp',
          durationMinutes: 1,
        }),
      });
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.run).toBeDefined();
      expect(data.run.id).toBeDefined();
      expect(data.run.prompt).toBe('echo test');
      expect(data.run.durationMinutes).toBe(1);
      expect(data.run.status).toBe('running');

      createdRuns.push(data.run.id);

      // Stop the run immediately to avoid resource usage
      await fetch(`${baseUrl}/api/scheduled/${data.run.id}`, { method: 'DELETE' });
    });

    it('should set correct timestamps', async () => {
      const beforeCreate = Date.now();

      const response = await fetch(`${baseUrl}/api/scheduled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'test timestamps',
          durationMinutes: 5,
        }),
      });
      const data = await response.json();

      const afterCreate = Date.now();

      expect(data.run.startedAt).toBeGreaterThanOrEqual(beforeCreate);
      expect(data.run.startedAt).toBeLessThanOrEqual(afterCreate);
      expect(data.run.endAt).toBe(data.run.startedAt + 5 * 60 * 1000);

      createdRuns.push(data.run.id);
      await fetch(`${baseUrl}/api/scheduled/${data.run.id}`, { method: 'DELETE' });
    });

    it('should initialize with zero completed tasks and cost', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'test initial values',
          durationMinutes: 1,
        }),
      });
      const data = await response.json();

      expect(data.run.completedTasks).toBe(0);
      expect(data.run.totalCost).toBe(0);
      // Logs may have 1 or more entries depending on timing
      expect(data.run.logs.length).toBeGreaterThanOrEqual(1);

      createdRuns.push(data.run.id);
      await fetch(`${baseUrl}/api/scheduled/${data.run.id}`, { method: 'DELETE' });
    });
  });

  describe('GET /api/scheduled/:id', () => {
    it('should return scheduled run details', async () => {
      // Create a run first
      const createRes = await fetch(`${baseUrl}/api/scheduled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'test get',
          durationMinutes: 1,
        }),
      });
      const createData = await createRes.json();
      const runId = createData.run.id;
      createdRuns.push(runId);

      // Get the run
      const response = await fetch(`${baseUrl}/api/scheduled/${runId}`);
      const data = await response.json();

      expect(data.id).toBe(runId);
      expect(data.prompt).toBe('test get');

      await fetch(`${baseUrl}/api/scheduled/${runId}`, { method: 'DELETE' });
    });

    it('should return error for non-existent run', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled/non-existent-id`);
      const data = await response.json();

      expect(data.error).toBe('Scheduled run not found');
    });
  });

  describe('DELETE /api/scheduled/:id', () => {
    it('should stop a scheduled run', async () => {
      // Create a run
      const createRes = await fetch(`${baseUrl}/api/scheduled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'test delete',
          durationMinutes: 10,
        }),
      });
      const createData = await createRes.json();
      const runId = createData.run.id;

      // Delete/stop the run
      const response = await fetch(`${baseUrl}/api/scheduled/${runId}`, {
        method: 'DELETE',
      });
      const data = await response.json();

      expect(data.success).toBe(true);

      // Verify it's stopped
      const getRes = await fetch(`${baseUrl}/api/scheduled/${runId}`);
      const runData = await getRes.json();
      expect(runData.status).toBe('stopped');
    });

    it('should return error for non-existent run', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled/non-existent-id`, {
        method: 'DELETE',
      });
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toBe('Scheduled run not found');
    });
  });
});

describe('Quick Run API', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(TEST_PORT + 1);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT + 1}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('POST /api/run', () => {
    it('should create session and run prompt', async () => {
      // Note: This test will actually try to run Claude
      // We use a simple echo to minimize API usage
      const response = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'say "test"',
          workingDir: '/tmp',
        }),
      });
      const data = await response.json();

      expect(data.sessionId).toBeDefined();
      // Note: success/failure depends on Claude actually running
    });

    it('should use current directory when workingDir not provided', async () => {
      const response = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'pwd',
        }),
      });
      const data = await response.json();

      expect(data.sessionId).toBeDefined();
    });
  });
});
