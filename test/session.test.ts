import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';

const TEST_PORT = 3102;

describe('Interactive Session Lifecycle', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(TEST_PORT);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('Session Creation', () => {
    it('should create session with default working directory', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.session.id).toBeDefined();
      expect(data.session.workingDir).toBeDefined();
      expect(data.session.status).toBe('idle');
    });

    it('should create session with custom working directory', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp/test' }),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.session.workingDir).toBe('/tmp/test');
    });
  });

  describe('Session Retrieval', () => {
    it('should get session by id', async () => {
      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.session.id;

      // Get the session
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      const data = await response.json();

      expect(data.id).toBe(sessionId);
      expect(data.status).toBeDefined();
    });

    it('should return error for non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent-id`);
      const data = await response.json();

      expect(data.error).toBe('Session not found');
    });
  });

  describe('Session Deletion', () => {
    it('should delete a session', async () => {
      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.session.id;

      // Delete the session
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      const data = await response.json();

      expect(data.success).toBe(true);

      // Verify it's gone
      const getRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      const getData = await getRes.json();
      expect(getData.error).toBe('Session not found');
    });

    it('should return error when deleting non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent-id`, {
        method: 'DELETE',
      });
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toBe('Session not found');
    });
  });

  describe('Session Output', () => {
    it('should get session output buffer', async () => {
      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.session.id;

      // Get output
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/output`);
      const data = await response.json();

      expect(data).toHaveProperty('textOutput');
      expect(data).toHaveProperty('messages');
      expect(data).toHaveProperty('errorBuffer');
    });
  });

  describe('Session Terminal Buffer', () => {
    it('should get session terminal buffer', async () => {
      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.session.id;

      // Get terminal buffer
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/terminal`);
      const data = await response.json();

      expect(data).toHaveProperty('terminalBuffer');
      expect(data).toHaveProperty('status');
    });
  });

  describe('Interactive Mode', () => {
    it('should start interactive session', async () => {
      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.session.id;

      // Start interactive mode
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/interactive`, {
        method: 'POST',
      });
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.message).toBe('Interactive session started');
    });

    it('should return error for non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/interactive`, {
        method: 'POST',
      });
      const data = await response.json();

      expect(data.error).toBe('Session not found');
    });
  });

  describe('Session Input', () => {
    it('should send input to interactive session', async () => {
      // Create and start interactive session
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.session.id;

      await fetch(`${baseUrl}/api/sessions/${sessionId}/interactive`, {
        method: 'POST',
      });

      // Wait a bit for interactive session to start
      await new Promise(resolve => setTimeout(resolve, 500));

      // Send input
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'test input\n' }),
      });
      const data = await response.json();

      expect(data.success).toBe(true);
    });
  });

  describe('Session Resize', () => {
    it('should resize session terminal', async () => {
      // Create and start interactive session
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.session.id;

      await fetch(`${baseUrl}/api/sessions/${sessionId}/interactive`, {
        method: 'POST',
      });

      // Resize
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: 120, rows: 40 }),
      });
      const data = await response.json();

      expect(data.success).toBe(true);
    });
  });
});
