import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { EventEmitter } from 'node:events';

const TEST_PORT = 3107;

// Helper to parse SSE events
function parseSSEEvents(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const lines = text.split('\n');
  let currentEvent = '';
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.substring(7);
    } else if (line.startsWith('data: ')) {
      currentData = line.substring(6);
    } else if (line === '') {
      if (currentEvent && currentData) {
        try {
          events.push({ event: currentEvent, data: JSON.parse(currentData) });
        } catch {
          events.push({ event: currentEvent, data: currentData });
        }
      }
      currentEvent = '';
      currentData = '';
    }
  }

  return events;
}

describe('SSE Events', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(TEST_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
  }, 60000);

  describe('GET /api/events', () => {
    it('should return text/event-stream content type', async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);

      try {
        const response = await fetch(`${baseUrl}/api/events`, {
          signal: controller.signal,
        });

        expect(response.headers.get('content-type')).toBe('text/event-stream');
      } catch (err: any) {
        // AbortError is expected
        if (err.name !== 'AbortError') throw err;
      } finally {
        clearTimeout(timeout);
      }
    });

    it('should send init event on connection', async () => {
      const controller = new AbortController();

      // Collect data for a short time
      let receivedData = '';
      const timeout = setTimeout(() => controller.abort(), 500);

      try {
        const response = await fetch(`${baseUrl}/api/events`, {
          signal: controller.signal,
        });

        const reader = response.body?.getReader();
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedData += new TextDecoder().decode(value);
          }
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') throw err;
      } finally {
        clearTimeout(timeout);
      }

      // Parse and check for init event
      const events = parseSSEEvents(receivedData);
      const initEvent = events.find(e => e.event === 'init');

      expect(initEvent).toBeDefined();
      expect((initEvent?.data as any).sessions).toBeDefined();
      expect((initEvent?.data as any).scheduledRuns).toBeDefined();
      expect((initEvent?.data as any).respawnStatus).toBeDefined();
      expect((initEvent?.data as any).timestamp).toBeDefined();
    });

    it('should receive session:created event when session is created', async () => {
      const controller = new AbortController();
      let receivedData = '';

      // Start listening
      const fetchPromise = fetch(`${baseUrl}/api/events`, {
        signal: controller.signal,
      }).then(async response => {
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              receivedData += new TextDecoder().decode(value);
            }
          } catch {}
        }
      });

      // Give time to connect
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create a session
      await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp' }),
      });

      // Wait a bit for the event
      await new Promise(resolve => setTimeout(resolve, 200));

      // Stop listening
      controller.abort();
      try { await fetchPromise; } catch {}

      // Parse events
      const events = parseSSEEvents(receivedData);
      const sessionCreated = events.find(e => e.event === 'session:created');

      expect(sessionCreated).toBeDefined();
      expect((sessionCreated?.data as any).id).toBeDefined();
    });
  });

  describe('GET /api/status', () => {
    it('should return full state', async () => {
      const response = await fetch(`${baseUrl}/api/status`);
      const data = await response.json();

      expect(data).toHaveProperty('sessions');
      expect(data).toHaveProperty('scheduledRuns');
      expect(data).toHaveProperty('respawnStatus');
      expect(data).toHaveProperty('timestamp');
    });

    it('should include active sessions', async () => {
      // Create a session first
      await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp' }),
      });

      const response = await fetch(`${baseUrl}/api/status`);
      const data = await response.json();

      expect(data.sessions.length).toBeGreaterThan(0);
    });
  });
});

describe('SSE Event Types', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(TEST_PORT + 1, false, true);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT + 1}`;
  });

  afterAll(async () => {
    await server.stop();
  }, 60000);

  describe('Session Events', () => {
    it('should emit session:deleted when session is deleted', async () => {
      const controller = new AbortController();
      let receivedData = '';

      // Start listening
      const fetchPromise = fetch(`${baseUrl}/api/events`, {
        signal: controller.signal,
      }).then(async response => {
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              receivedData += new TextDecoder().decode(value);
            }
          } catch {}
        }
      });

      // Give time to connect
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create a session
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp' }),
      });
      const createData = await createRes.json();

      // Delete it
      await fetch(`${baseUrl}/api/sessions/${createData.session.id}`, {
        method: 'DELETE',
      });

      // Wait for events
      await new Promise(resolve => setTimeout(resolve, 200));

      // Stop listening
      controller.abort();
      try { await fetchPromise; } catch {}

      // Parse events
      const events = parseSSEEvents(receivedData);
      const sessionDeleted = events.find(e => e.event === 'session:deleted');

      expect(sessionDeleted).toBeDefined();
      expect((sessionDeleted?.data as any).id).toBe(createData.session.id);
    });
  });

  describe('Case Events', () => {
    it('should emit case:created when case is created', async () => {
      const controller = new AbortController();
      let receivedData = '';

      // Start listening
      const fetchPromise = fetch(`${baseUrl}/api/events`, {
        signal: controller.signal,
      }).then(async response => {
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              receivedData += new TextDecoder().decode(value);
            }
          } catch {}
        }
      });

      // Give time to connect
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create a case
      const caseName = `test-sse-case-${Date.now()}`;
      await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName }),
      });

      // Wait for events
      await new Promise(resolve => setTimeout(resolve, 200));

      // Stop listening
      controller.abort();
      try { await fetchPromise; } catch {}

      // Parse events
      const events = parseSSEEvents(receivedData);
      const caseCreated = events.find(e => e.event === 'case:created');

      expect(caseCreated).toBeDefined();
      expect((caseCreated?.data as any).name).toBe(caseName);

      // Cleanup
      const { rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');
      try {
        rmSync(join(homedir(), 'codeman-cases', caseName), { recursive: true });
      } catch {}
    });
  });
});
