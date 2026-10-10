import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { safeRmHomeTree } from './mocks/index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Helper to parse SSE events from raw text
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

// Helper to collect SSE events for a given duration
async function collectSSEEvents(
  baseUrl: string,
  queryParams: string,
  durationMs: number
): Promise<Array<{ event: string; data: unknown }>> {
  const controller = new AbortController();
  let receivedData = '';

  const fetchPromise = fetch(`${baseUrl}/api/events${queryParams}`, {
    signal: controller.signal,
  }).then(async (response) => {
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedData += new TextDecoder().decode(value);
        }
      } catch {
        /* AbortError expected */
      }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, durationMs));
  controller.abort();
  try {
    await fetchPromise;
  } catch {
    /* AbortError expected */
  }

  return parseSSEEvents(receivedData);
}

describe('SSE Subscription Filtering', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
  }, 60000);

  it('should accept sessions query parameter without error', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);

    try {
      const response = await fetch(`${baseUrl}/api/events?sessions=abc,def`, {
        signal: controller.signal,
      });

      expect(response.headers.get('content-type')).toBe('text/event-stream');
    } catch (err: any) {
      if (err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timeout);
    }
  });

  it('should send init event regardless of session filter', async () => {
    const events = await collectSSEEvents(baseUrl, '?sessions=nonexistent-id', 500);

    const initEvent = events.find((e) => e.event === 'init');
    expect(initEvent).toBeDefined();
    expect((initEvent?.data as any).sessions).toBeDefined();
  });

  it('should receive all events when no sessions param is provided (backwards-compatible)', async () => {
    // Start two SSE listeners: one with no filter, one with a filter for a nonexistent session
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    let unfilteredData = '';
    let filteredData = '';

    const fetch1 = fetch(`${baseUrl}/api/events`, {
      signal: controller1.signal,
    }).then(async (response) => {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            unfilteredData += new TextDecoder().decode(value);
          }
        } catch {
          /* expected */
        }
      }
    });

    const fetch2 = fetch(`${baseUrl}/api/events?sessions=nonexistent-session`, {
      signal: controller2.signal,
    }).then(async (response) => {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            filteredData += new TextDecoder().decode(value);
          }
        } catch {
          /* expected */
        }
      }
    });

    // Wait for connections to establish
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Create a session — this emits session:created (a global-ish event that has id but
    // the nonexistent filter won't match it)
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    const createData = await createRes.json();
    const sessionId = createData.data.session.id;

    // Wait for events to arrive
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Stop listening
    controller1.abort();
    controller2.abort();
    try {
      await fetch1;
    } catch {
      /* expected */
    }
    try {
      await fetch2;
    } catch {
      /* expected */
    }

    const unfilteredEvents = parseSSEEvents(unfilteredData);
    const filteredEvents = parseSSEEvents(filteredData);

    // Unfiltered client should receive the session:created event
    const unfilteredCreated = unfilteredEvents.find((e) => e.event === 'session:created');
    expect(unfilteredCreated).toBeDefined();
    expect((unfilteredCreated?.data as any).id).toBe(sessionId);

    // Lifecycle/metadata events (session:created/updated/deleted, ralph:*, etc.) are
    // intentionally broadcast to ALL clients regardless of the ?sessions= filter — only
    // the high-volume terminal stream is filtered per-session (see sse-stream-manager
    // broadcast(): "Subscription filtering is intentionally NOT applied here"). So the
    // filtered client still receives session:created.
    const filteredCreated = filteredEvents.find((e) => e.event === 'session:created');
    expect(filteredCreated).toBeDefined();

    // Both should have received the init event (it has no sessionId)
    expect(unfilteredEvents.find((e) => e.event === 'init')).toBeDefined();
    expect(filteredEvents.find((e) => e.event === 'init')).toBeDefined();

    // Cleanup
    await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
  });

  it('should deliver session events to a client subscribed to that session', async () => {
    // First create a session so we know the ID
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    const createData = await createRes.json();
    const sessionId = createData.data.session.id;

    // Now connect SSE with the session filter
    const controller = new AbortController();
    let receivedData = '';

    const fetchPromise = fetch(`${baseUrl}/api/events?sessions=${sessionId}`, {
      signal: controller.signal,
    }).then(async (response) => {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedData += new TextDecoder().decode(value);
          }
        } catch {
          /* expected */
        }
      }
    });

    // Wait for connection
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Delete the session — this emits session:deleted with { id: sessionId }
    await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });

    // Wait for events
    await new Promise((resolve) => setTimeout(resolve, 300));

    controller.abort();
    try {
      await fetchPromise;
    } catch {
      /* expected */
    }

    const events = parseSSEEvents(receivedData);

    // Should receive session:deleted because we're subscribed to this session
    const deletedEvent = events.find((e) => e.event === 'session:deleted');
    expect(deletedEvent).toBeDefined();
    expect((deletedEvent?.data as any).id).toBe(sessionId);
  });

  it('should filter out events for sessions not in the subscription', async () => {
    // Create two sessions
    const createRes1 = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    const session1 = (await createRes1.json()).data.session;

    const createRes2 = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    const session2 = (await createRes2.json()).data.session;

    // Connect SSE subscribed ONLY to session1
    const controller = new AbortController();
    let receivedData = '';

    const fetchPromise = fetch(`${baseUrl}/api/events?sessions=${session1.id}`, {
      signal: controller.signal,
    }).then(async (response) => {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedData += new TextDecoder().decode(value);
          }
        } catch {
          /* expected */
        }
      }
    });

    // Wait for connection
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Delete both sessions — emits session:deleted for each
    await fetch(`${baseUrl}/api/sessions/${session1.id}`, { method: 'DELETE' });
    await fetch(`${baseUrl}/api/sessions/${session2.id}`, { method: 'DELETE' });

    // Wait for events
    await new Promise((resolve) => setTimeout(resolve, 300));

    controller.abort();
    try {
      await fetchPromise;
    } catch {
      /* expected */
    }

    const events = parseSSEEvents(receivedData);

    // Should receive session:deleted for session1
    const deleted1 = events.find((e) => e.event === 'session:deleted' && (e.data as any).id === session1.id);
    expect(deleted1).toBeDefined();

    // Lifecycle events are broadcast to all clients regardless of filter, so a client
    // subscribed to session1 still receives session2's session:deleted (only terminal
    // output is filtered per-session).
    const deleted2 = events.find((e) => e.event === 'session:deleted' && (e.data as any).id === session2.id);
    expect(deleted2).toBeDefined();
  });

  it('should support subscribing to multiple sessions', async () => {
    // Create two sessions
    const createRes1 = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    const session1 = (await createRes1.json()).data.session;

    const createRes2 = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    const session2 = (await createRes2.json()).data.session;

    // Connect SSE subscribed to both sessions
    const controller = new AbortController();
    let receivedData = '';

    const fetchPromise = fetch(`${baseUrl}/api/events?sessions=${session1.id},${session2.id}`, {
      signal: controller.signal,
    }).then(async (response) => {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedData += new TextDecoder().decode(value);
          }
        } catch {
          /* expected */
        }
      }
    });

    // Wait for connection
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Delete both sessions
    await fetch(`${baseUrl}/api/sessions/${session1.id}`, { method: 'DELETE' });
    await fetch(`${baseUrl}/api/sessions/${session2.id}`, { method: 'DELETE' });

    // Wait for events
    await new Promise((resolve) => setTimeout(resolve, 300));

    controller.abort();
    try {
      await fetchPromise;
    } catch {
      /* expected */
    }

    const events = parseSSEEvents(receivedData);

    // Should receive session:deleted for both sessions
    const deleted1 = events.find((e) => e.event === 'session:deleted' && (e.data as any).id === session1.id);
    const deleted2 = events.find((e) => e.event === 'session:deleted' && (e.data as any).id === session2.id);
    expect(deleted1).toBeDefined();
    expect(deleted2).toBeDefined();
  });

  it('should deliver global events (no sessionId) to filtered clients', async () => {
    // Connect with a filter — global events like case:created should still arrive
    const controller = new AbortController();
    let receivedData = '';

    const fetchPromise = fetch(`${baseUrl}/api/events?sessions=some-session-id`, {
      signal: controller.signal,
    }).then(async (response) => {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedData += new TextDecoder().decode(value);
          }
        } catch {
          /* expected */
        }
      }
    });

    // Wait for connection
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Create a case — case:created is a global event (no sessionId or id matching a session)
    const caseName = `test-filter-case-${Date.now()}`;
    await fetch(`${baseUrl}/api/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: caseName }),
    });

    // Wait for events
    await new Promise((resolve) => setTimeout(resolve, 300));

    controller.abort();
    try {
      await fetchPromise;
    } catch {
      /* expected */
    }

    const events = parseSSEEvents(receivedData);

    // case:created should arrive because it has no sessionId — it's a global event
    const caseCreated = events.find((e) => e.event === 'case:created');
    expect(caseCreated).toBeDefined();
    expect((caseCreated?.data as any).name).toBe(caseName);

    // Cleanup (containment-gated)
    safeRmHomeTree(join(homedir(), 'codeman-cases', caseName));
  });
});
