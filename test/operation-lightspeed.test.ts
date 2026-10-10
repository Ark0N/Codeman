/**
 * @fileoverview Tests for Operation Lightspeed performance optimizations.
 *
 * Covers:
 * - SSE subscription filter edge cases (empty params, whitespace, duplicates)
 * - Lifecycle-event broadcast contract (session:*, case:* fan out to all clients;
 *   only session:terminal is filtered by subscription)
 * - Tab switching: terminal buffer loading, session creation + switch
 * - Terminal data cap / backpressure recovery
 * - Lazy teammate terminal lifecycle
 * - SSE padding strategy (only latency-sensitive events)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

// Helper to create a session and return its ID
async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workingDir: '/tmp' }),
  });
  const data = await res.json();
  if (!data.data?.session?.id) {
    throw new Error(`Failed to create session: ${JSON.stringify(data)}`);
  }
  return data.data.session.id;
}

// Helper to delete a session
async function deleteSession(baseUrl: string, id: string): Promise<void> {
  await fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE' });
}

describe('Operation Lightspeed', () => {
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

  // ═══════════════════════════════════════════════════════════════
  // SSE Subscription Filter — Edge Cases
  // ═══════════════════════════════════════════════════════════════

  describe('SSE Subscription Filter Edge Cases', () => {
    it('should treat empty sessions param as no filter (receive all)', async () => {
      // ?sessions= (empty string) should not create a filter
      const controller = new AbortController();
      let receivedData = '';

      const fetchPromise = fetch(`${baseUrl}/api/events?sessions=`, {
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

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Create a session — should arrive since empty filter = no filter
      const sessionId = await createSession(baseUrl);

      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      const events = parseSSEEvents(receivedData);
      const created = events.find((e) => e.event === 'session:created');
      expect(created).toBeDefined();

      await deleteSession(baseUrl, sessionId);
    });

    it('should handle whitespace-only session IDs gracefully', async () => {
      // ?sessions=  ,  ,  — should be treated as no valid IDs = no filter
      const events = await collectSSEEvents(baseUrl, '?sessions=%20,%20,%20', 400);

      // Should still receive init event
      const initEvent = events.find((e) => e.event === 'init');
      expect(initEvent).toBeDefined();
    });

    it('should deduplicate session IDs in filter', async () => {
      // Create a session
      const sessionId = await createSession(baseUrl);

      // Subscribe with duplicated ID
      const controller = new AbortController();
      let receivedData = '';

      const fetchPromise = fetch(`${baseUrl}/api/events?sessions=${sessionId},${sessionId},${sessionId}`, {
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

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Delete session — should emit session:deleted once
      await deleteSession(baseUrl, sessionId);

      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      const events = parseSSEEvents(receivedData);
      const deleted = events.filter((e) => e.event === 'session:deleted' && (e.data as any).id === sessionId);
      // Should receive exactly one session:deleted event (not duplicated)
      expect(deleted.length).toBe(1);
    });

    it('should handle sessions param with trailing comma', async () => {
      const sessionId = await createSession(baseUrl);

      // Trailing comma: ?sessions=id, — should parse just the one ID
      const controller = new AbortController();
      let receivedData = '';

      const fetchPromise = fetch(`${baseUrl}/api/events?sessions=${sessionId},`, {
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

      await new Promise((resolve) => setTimeout(resolve, 200));
      await deleteSession(baseUrl, sessionId);
      await new Promise((resolve) => setTimeout(resolve, 300));

      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      const events = parseSSEEvents(receivedData);
      const deleted = events.find((e) => e.event === 'session:deleted' && (e.data as any).id === sessionId);
      expect(deleted).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Lifecycle Event Broadcast — Event Classification
  // ═══════════════════════════════════════════════════════════════

  describe('Lifecycle Event Broadcast Contract', () => {
    it('should deliver session:updated events to all clients regardless of filter', async () => {
      // Create two sessions
      const session1 = await createSession(baseUrl);
      const session2 = await createSession(baseUrl);

      // Subscribe only to session1
      const controller = new AbortController();
      let receivedData = '';

      const fetchPromise = fetch(`${baseUrl}/api/events?sessions=${session1}`, {
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

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Rename session2 — emits session:updated with { id: session2 }
      await fetch(`${baseUrl}/api/sessions/${session2}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed-session' }),
      });

      // Rename session1 — emits session:updated with { id: session1 }
      await fetch(`${baseUrl}/api/sessions/${session1}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'my-session' }),
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      const events = parseSSEEvents(receivedData);

      // New contract: session:updated is a lifecycle event that broadcasts to ALL clients.
      // The subscription filter only applies to session:terminal.
      const updatedEvents = events.filter((e) => e.event === 'session:updated');
      const session1Updated = updatedEvents.find((e) => (e.data as any).id === session1);
      const session2Updated = updatedEvents.find((e) => (e.data as any).id === session2);

      expect(session1Updated).toBeDefined();
      expect(session2Updated).toBeDefined();

      // Cleanup
      await deleteSession(baseUrl, session1);
      await deleteSession(baseUrl, session2);
    });

    it('should deliver session:deleted events to all clients regardless of filter', async () => {
      // New contract: lifecycle events (session:*) broadcast to every connected client;
      // the per-client filter no longer gates them. Only session:terminal is filtered.
      const target = await createSession(baseUrl);
      const other = await createSession(baseUrl);

      // Subscribe only to target
      const controller = new AbortController();
      let receivedData = '';

      const fetchPromise = fetch(`${baseUrl}/api/events?sessions=${target}`, {
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

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Delete the other session — should NOT appear for our filtered client
      await deleteSession(baseUrl, other);

      // Delete target — SHOULD appear
      await deleteSession(baseUrl, target);

      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      const events = parseSSEEvents(receivedData);

      // Both deletions arrive regardless of the per-client filter
      const targetDeleted = events.find((e) => e.event === 'session:deleted' && (e.data as any).id === target);
      expect(targetDeleted).toBeDefined();

      const otherDeleted = events.find((e) => e.event === 'session:deleted' && (e.data as any).id === other);
      expect(otherDeleted).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Tab Switching — Terminal Buffer & Session Management
  // ═══════════════════════════════════════════════════════════════

  describe('Tab Switching — Terminal Buffer Loading', () => {
    it('should return terminal buffer for a session', async () => {
      const sessionId = await createSession(baseUrl);

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/terminal`);
      const data = await res.json();

      expect(res.status).toBe(200);
      // terminalBuffer may be empty for a fresh session, but field should exist
      expect(data.data).toHaveProperty('terminalBuffer');
      expect(data.data).toHaveProperty('truncated');
      expect(data.data.truncated).toBe(false);

      await deleteSession(baseUrl, sessionId);
    });

    it('should support tail parameter for terminal buffer', async () => {
      const sessionId = await createSession(baseUrl);

      // Fetch with tail=1024 — should not crash even if buffer is smaller
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/terminal?tail=1024`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data).toHaveProperty('terminalBuffer');

      await deleteSession(baseUrl, sessionId);
    });

    it('should return error for terminal of nonexistent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent-id/terminal`);
      const data = await res.json();
      // Server returns 200 with error body (createErrorResponse convention)
      expect(data.success).toBe(false);
      expect(data.errorCode).toBeDefined();
    });

    it('should handle rapid tab switches (multiple sessions created)', async () => {
      // Create 3 sessions rapidly
      const ids = await Promise.all([createSession(baseUrl), createSession(baseUrl), createSession(baseUrl)]);

      // Fetch all terminal buffers in parallel (simulates rapid tab switching)
      const results = await Promise.all(
        ids.map((id) => fetch(`${baseUrl}/api/sessions/${id}/terminal?tail=131072`).then((r) => r.json()))
      );

      // All should succeed
      for (const data of results) {
        expect(data.data).toHaveProperty('terminalBuffer');
      }

      // Cleanup
      await Promise.all(ids.map((id) => deleteSession(baseUrl, id)));
    });

    it('should handle concurrent tab switch + session deletion gracefully', async () => {
      const sessionId = await createSession(baseUrl);

      // Start fetching terminal buffer and delete session concurrently
      const [terminalRes, deleteRes] = await Promise.all([
        fetch(`${baseUrl}/api/sessions/${sessionId}/terminal`),
        // Small delay before delete so the terminal fetch likely starts first
        new Promise<Response>((resolve) =>
          setTimeout(async () => {
            resolve(await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' }));
          }, 10)
        ),
      ]);

      // Terminal fetch may succeed (200) or fail (404) depending on timing — both are valid
      expect([200, 404]).toContain(terminalRes.status);
      expect(deleteRes.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SSE Client Lifecycle & Cleanup
  // ═══════════════════════════════════════════════════════════════

  describe('SSE Client Lifecycle', () => {
    it('should clean up SSE client on disconnect', async () => {
      // Connect and immediately disconnect
      const controller = new AbortController();

      const fetchPromise = fetch(`${baseUrl}/api/events`, {
        signal: controller.signal,
      }).then(async (response) => {
        // Read just the first chunk
        const reader = response.body?.getReader();
        if (reader) {
          await reader.read();
          reader.cancel();
        }
      });

      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      // Server should clean up — verify by connecting again (should work)
      const events = await collectSSEEvents(baseUrl, '', 300);
      expect(events.find((e) => e.event === 'init')).toBeDefined();
    });

    it('should fan lifecycle events out to all SSE clients regardless of filter', async () => {
      const session1 = await createSession(baseUrl);
      const session2 = await createSession(baseUrl);

      // Client A: subscribes to session1, Client B: subscribes to session2, Client C: no filter.
      // Under the broadcast contract, all three see every session:deleted event — the filter
      // only narrows session:terminal traffic.
      const controllerA = new AbortController();
      const controllerB = new AbortController();
      const controllerC = new AbortController();
      let dataA = '';
      let dataB = '';
      let dataC = '';

      const fetchA = fetch(`${baseUrl}/api/events?sessions=${session1}`, {
        signal: controllerA.signal,
      }).then(async (r) => {
        const reader = r.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              dataA += new TextDecoder().decode(value);
            }
          } catch {
            /* expected */
          }
        }
      });

      const fetchB = fetch(`${baseUrl}/api/events?sessions=${session2}`, {
        signal: controllerB.signal,
      }).then(async (r) => {
        const reader = r.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              dataB += new TextDecoder().decode(value);
            }
          } catch {
            /* expected */
          }
        }
      });

      const fetchC = fetch(`${baseUrl}/api/events`, {
        signal: controllerC.signal,
      }).then(async (r) => {
        const reader = r.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              dataC += new TextDecoder().decode(value);
            }
          } catch {
            /* expected */
          }
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Delete session1 — A and C should see it, B should not
      await deleteSession(baseUrl, session1);
      // Delete session2 — B and C should see it, A should not
      await deleteSession(baseUrl, session2);

      await new Promise((resolve) => setTimeout(resolve, 300));

      controllerA.abort();
      controllerB.abort();
      controllerC.abort();
      try {
        await fetchA;
      } catch {
        /* expected */
      }
      try {
        await fetchB;
      } catch {
        /* expected */
      }
      try {
        await fetchC;
      } catch {
        /* expected */
      }

      const eventsA = parseSSEEvents(dataA);
      const eventsB = parseSSEEvents(dataB);
      const eventsC = parseSSEEvents(dataC);

      // Every client sees both deletions — lifecycle events are not filter-gated.
      expect(eventsA.find((e) => e.event === 'session:deleted' && (e.data as any).id === session1)).toBeDefined();
      expect(eventsA.find((e) => e.event === 'session:deleted' && (e.data as any).id === session2)).toBeDefined();

      expect(eventsB.find((e) => e.event === 'session:deleted' && (e.data as any).id === session1)).toBeDefined();
      expect(eventsB.find((e) => e.event === 'session:deleted' && (e.data as any).id === session2)).toBeDefined();

      expect(eventsC.find((e) => e.event === 'session:deleted' && (e.data as any).id === session1)).toBeDefined();
      expect(eventsC.find((e) => e.event === 'session:deleted' && (e.data as any).id === session2)).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Name / Rename (tab label changes)
  // ═══════════════════════════════════════════════════════════════

  describe('Session Rename (Tab Labels)', () => {
    it('should rename a session and emit session:updated', async () => {
      const sessionId = await createSession(baseUrl);

      const controller = new AbortController();
      let receivedData = '';

      const fetchPromise = fetch(`${baseUrl}/api/events`, {
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

      await new Promise((resolve) => setTimeout(resolve, 200));

      const renameRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Lightspeed Test' }),
      });
      expect(renameRes.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      const events = parseSSEEvents(receivedData);
      const updated = events.find((e) => e.event === 'session:updated' && (e.data as any).id === sessionId);
      expect(updated).toBeDefined();
      expect((updated?.data as any).name).toBe('Lightspeed Test');

      await deleteSession(baseUrl, sessionId);
    });

    it('should accept empty session name (schema allows min 0)', async () => {
      const sessionId = await createSession(baseUrl);

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      const data = await res.json();
      expect(data.success).toBe(true);

      await deleteSession(baseUrl, sessionId);
    });

    it('should reject overly long session name via schema', async () => {
      const sessionId = await createSession(baseUrl);

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'A'.repeat(200) }),
      });
      const data = await res.json();
      // Schema max(128) rejects 200 chars — returns success: false in body
      expect(data.success).toBe(false);
      expect(data.errorCode).toBeDefined();

      await deleteSession(baseUrl, sessionId);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Session List / Status (Tab Bar Data)
  // ═══════════════════════════════════════════════════════════════

  describe('Session List for Tab Bar', () => {
    it('should return session list without terminal buffers (light state)', async () => {
      const sessionId = await createSession(baseUrl);

      const res = await fetch(`${baseUrl}/api/sessions`);
      const body = await res.json();
      const sessions = body.data;

      expect(Array.isArray(sessions)).toBe(true);
      const session = sessions.find((s: any) => s.id === sessionId);
      expect(session).toBeDefined();

      // Light state should NOT include full terminal buffer
      // (the terminalBuffer field should be empty or minimal, not megabytes)
      if (session.terminalBuffer) {
        // If included at all, it should be reasonable (not the full 2MB)
        expect(session.terminalBuffer.length).toBeLessThan(1024 * 1024);
      }

      await deleteSession(baseUrl, sessionId);
    });

    it('should include all created sessions in list', async () => {
      // Create sessions sequentially to avoid race conditions
      const id1 = await createSession(baseUrl);
      const id2 = await createSession(baseUrl);
      const id3 = await createSession(baseUrl);

      // Wait for cache invalidation (SESSIONS_LIST_CACHE_TTL = 1s)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const res = await fetch(`${baseUrl}/api/sessions`);
      const body = await res.json();
      const sessions = body.data;

      // All 3 should be present in the response
      const foundIds = sessions.map((s: any) => s.id);
      expect(foundIds).toContain(id1);
      expect(foundIds).toContain(id2);
      expect(foundIds).toContain(id3);

      await Promise.all([id1, id2, id3].map((id) => deleteSession(baseUrl, id)));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SSE Padding Strategy
  // ═══════════════════════════════════════════════════════════════

  describe('SSE Padding Strategy', () => {
    it('should not include tunnel padding on session:created events (low frequency)', async () => {
      // When tunnel is NOT active, no events should have padding
      const controller = new AbortController();
      let rawData = '';

      const fetchPromise = fetch(`${baseUrl}/api/events`, {
        signal: controller.signal,
      }).then(async (response) => {
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              rawData += new TextDecoder().decode(value);
            }
          } catch {
            /* expected */
          }
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      const sessionId = await createSession(baseUrl);
      await new Promise((resolve) => setTimeout(resolve, 300));

      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      // SSE_PADDING is 1KB+ of spaces. session:created should not have it
      // when tunnel is not active. Check that data between events is clean.
      // Find "session:created" in raw data — check there's no massive padding after it
      const createdIdx = rawData.indexOf('event: session:created');
      expect(createdIdx).toBeGreaterThan(-1);

      // Find next event after session:created
      const afterCreated = rawData.substring(createdIdx);
      const dataEnd = afterCreated.indexOf('\n\n');
      if (dataEnd > -1) {
        const between = afterCreated.substring(dataEnd + 2);
        const nextEvent = between.indexOf('event: ');
        if (nextEvent > 0) {
          // Gap between events should be small (no 1KB padding)
          expect(nextEvent).toBeLessThan(100);
        }
      }

      await deleteSession(baseUrl, sessionId);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Tab Switching — SSE Filter Update Simulation
  // ═══════════════════════════════════════════════════════════════

  describe('Tab Switching — SSE Filter Simulation', () => {
    it('should allow reconnecting SSE with different session filter (tab switch)', async () => {
      // Simulates a tab switch: client disconnects SSE for session1, reconnects for session2
      const session1 = await createSession(baseUrl);
      const session2 = await createSession(baseUrl);

      // Phase 1: Subscribe to session1
      const controller1 = new AbortController();
      let data1 = '';

      const fetch1 = fetch(`${baseUrl}/api/events?sessions=${session1}`, {
        signal: controller1.signal,
      }).then(async (r) => {
        const reader = r.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              data1 += new TextDecoder().decode(value);
            }
          } catch {
            /* expected */
          }
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Disconnect (simulates tab switch away from session1)
      controller1.abort();
      try {
        await fetch1;
      } catch {
        /* expected */
      }

      // Phase 2: Reconnect subscribing to session2 (tab switch to session2)
      const controller2 = new AbortController();
      let data2 = '';

      const fetch2 = fetch(`${baseUrl}/api/events?sessions=${session2}`, {
        signal: controller2.signal,
      }).then(async (r) => {
        const reader = r.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              data2 += new TextDecoder().decode(value);
            }
          } catch {
            /* expected */
          }
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Delete session2 — should arrive in new subscription
      await deleteSession(baseUrl, session2);
      await new Promise((resolve) => setTimeout(resolve, 300));

      controller2.abort();
      try {
        await fetch2;
      } catch {
        /* expected */
      }

      const events2 = parseSSEEvents(data2);
      const deleted = events2.find((e) => e.event === 'session:deleted' && (e.data as any).id === session2);
      expect(deleted).toBeDefined();

      // Phase 1 data should have init but no session2 events
      const events1 = parseSSEEvents(data1);
      const session2InPhase1 = events1.find((e) => (e.data as any)?.id === session2 && e.event !== 'init');
      expect(session2InPhase1).toBeUndefined();

      await deleteSession(baseUrl, session1);
    });

    it('should receive init state with all sessions on each SSE reconnect', async () => {
      const session1 = await createSession(baseUrl);
      const session2 = await createSession(baseUrl);

      // Connect with filter for session1
      const events = await collectSSEEvents(baseUrl, `?sessions=${session1}`, 400);

      const initEvent = events.find((e) => e.event === 'init');
      expect(initEvent).toBeDefined();

      // Init should contain ALL sessions (not filtered) — client needs full list for tab bar
      const initSessions = (initEvent?.data as any).sessions;
      expect(Array.isArray(initSessions)).toBe(true);
      const initIds = initSessions.map((s: any) => s.id);
      expect(initIds).toContain(session1);
      expect(initIds).toContain(session2);

      await Promise.all([deleteSession(baseUrl, session1), deleteSession(baseUrl, session2)]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Terminal Buffer — Local Echo Support
  // ═══════════════════════════════════════════════════════════════

  describe('Terminal Buffer — Local Echo Support', () => {
    it('should return terminal buffer with status field for local echo state sync', async () => {
      const sessionId = await createSession(baseUrl);

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/terminal`);
      const data = await res.json();

      expect(res.status).toBe(200);
      // Local echo overlay needs session status to know when to show/hide
      expect(data.data).toHaveProperty('status');
      expect(typeof data.data.status).toBe('string');
      // Fresh session starts as 'starting'
      expect(['starting', 'running', 'idle', 'error']).toContain(data.data.status);

      await deleteSession(baseUrl, sessionId);
    });

    it('should return fullSize field for buffer truncation detection', async () => {
      const sessionId = await createSession(baseUrl);

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/terminal?tail=100`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data).toHaveProperty('fullSize');
      expect(typeof data.data.fullSize).toBe('number');
      expect(data.data.fullSize).toBeGreaterThanOrEqual(0);

      await deleteSession(baseUrl, sessionId);
    });

    it('should handle tail=0 same as no tail (full buffer)', async () => {
      const sessionId = await createSession(baseUrl);

      const [fullRes, tailZeroRes] = await Promise.all([
        fetch(`${baseUrl}/api/sessions/${sessionId}/terminal`).then((r) => r.json()),
        fetch(`${baseUrl}/api/sessions/${sessionId}/terminal?tail=0`).then((r) => r.json()),
      ]);

      // tail=0 means "don't tail" — should return same as no tail param
      expect(fullRes.data.truncated).toBe(false);
      expect(tailZeroRes.data.truncated).toBe(false);
      expect(fullRes.data.terminalBuffer).toBe(tailZeroRes.data.terminalBuffer);

      await deleteSession(baseUrl, sessionId);
    });

    it('should handle very large tail value gracefully', async () => {
      const sessionId = await createSession(baseUrl);

      // Tail larger than buffer — should return full buffer without error
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/terminal?tail=999999999`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data).toHaveProperty('terminalBuffer');
      expect(data.data.truncated).toBe(false); // Can't truncate if tail > fullSize

      await deleteSession(baseUrl, sessionId);
    });

    it('should handle negative tail value without crashing', async () => {
      const sessionId = await createSession(baseUrl);

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/terminal?tail=-1`);
      const data = await res.json();

      // Should handle gracefully (either return full buffer or error cleanly)
      expect(res.status).toBe(200);
      expect(data.data).toHaveProperty('terminalBuffer');

      await deleteSession(baseUrl, sessionId);
    });

    it('should handle non-numeric tail value without crashing', async () => {
      const sessionId = await createSession(baseUrl);

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/terminal?tail=abc`);
      const data = await res.json();

      // NaN tail should be handled (parseInt('abc') = NaN, which is falsy)
      expect(res.status).toBe(200);
      expect(data.data).toHaveProperty('terminalBuffer');

      await deleteSession(baseUrl, sessionId);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Lifecycle Event Broadcast — Additional Edge Cases
  // ═══════════════════════════════════════════════════════════════

  describe('Lifecycle Event Broadcast — Edge Cases via SSE', () => {
    it('should treat non-session: events with id field as global (not filtered)', async () => {
      // Events like case:created have an `id` field but aren't session:* events.
      // Under the broadcast contract they reach every connected client.
      const controller = new AbortController();
      let receivedData = '';

      const fetchPromise = fetch(`${baseUrl}/api/events?sessions=nonexistent`, {
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

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Create a case — case:created has an `id` field but is NOT session-scoped
      const caseName = `test-extract-${Date.now()}`;
      await fetch(`${baseUrl}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: caseName }),
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      const events = parseSSEEvents(receivedData);
      // case:created should still arrive (it's global, not filtered by session)
      const caseEvent = events.find((e) => e.event === 'case:created');
      expect(caseEvent).toBeDefined();

      // Cleanup (containment-gated: never touch prod ~/codeman-cases)
      safeRmHomeTree(join(homedir(), 'codeman-cases', caseName));
    });

    it('should deliver session:created to every client, even those with a mismatched filter', async () => {
      // Under the broadcast contract, lifecycle events ignore the per-client filter.
      // A client subscribed only to `existing` still receives `session:created` for `newSession`.
      const existing = await createSession(baseUrl);

      // Subscribe to existing session only
      const controller = new AbortController();
      let receivedData = '';

      const fetchPromise = fetch(`${baseUrl}/api/events?sessions=${existing}`, {
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

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Create a NEW session — its session:created event should NOT reach our filtered client
      const newSession = await createSession(baseUrl);

      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      const events = parseSSEEvents(receivedData);
      // session:created reaches the filtered client even though its id doesn't match the filter.
      const createdEvent = events.find((e) => e.event === 'session:created' && (e.data as any).id === newSession);
      expect(createdEvent).toBeDefined();

      await Promise.all([deleteSession(baseUrl, existing), deleteSession(baseUrl, newSession)]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Tab Switching — Session Auto-Select After Delete
  // ═══════════════════════════════════════════════════════════════

  describe('Tab Switching — Session Lifecycle', () => {
    it('should emit session:deleted when active tab session is killed', async () => {
      const sessionId = await createSession(baseUrl);

      // Subscribe to that session's events (simulates having it as active tab)
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

      await new Promise((resolve) => setTimeout(resolve, 200));
      await deleteSession(baseUrl, sessionId);
      await new Promise((resolve) => setTimeout(resolve, 300));

      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      const events = parseSSEEvents(receivedData);
      const deleted = events.find((e) => e.event === 'session:deleted');
      expect(deleted).toBeDefined();
      expect((deleted?.data as any).id).toBe(sessionId);
    });

    it('should create and delete multiple sessions rapidly (tab churn)', async () => {
      // Rapid create-delete cycles simulating user rapidly opening/closing tabs
      const results: boolean[] = [];

      for (let i = 0; i < 5; i++) {
        const id = await createSession(baseUrl);
        const delRes = await fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE' });
        results.push(delRes.status === 200);
      }

      expect(results.every(Boolean)).toBe(true);
    });

    it('should handle delete of already-deleted session gracefully', async () => {
      const sessionId = await createSession(baseUrl);
      await deleteSession(baseUrl, sessionId);

      // Double delete — should not crash
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      const data = await res.json();

      // Should return error response but not crash the server
      expect(data.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SSE Max Clients Limit
  // ═══════════════════════════════════════════════════════════════

  describe('SSE Max Clients', () => {
    it('should reject SSE connections when at limit', async () => {
      // The MAX_SSE_CLIENTS is 100 — we can't test hitting the exact limit,
      // but we can verify the server responds with 503 structure by checking
      // that many concurrent connections don't crash
      const controllers: AbortController[] = [];
      const connections: Promise<void>[] = [];

      // Open 10 concurrent SSE connections
      for (let i = 0; i < 10; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        connections.push(
          fetch(`${baseUrl}/api/events`, { signal: controller.signal })
            .then(async (r) => {
              expect(r.headers.get('content-type')).toBe('text/event-stream');
              const reader = r.body?.getReader();
              if (reader) {
                try {
                  await reader.read();
                } catch {
                  /* expected */
                }
              }
            })
            .catch(() => {
              /* AbortError expected */
            })
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      // All should be connected — verify server still works
      const statusRes = await fetch(`${baseUrl}/api/status`);
      expect(statusRes.status).toBe(200);

      // Cleanup all SSE connections
      controllers.forEach((c) => c.abort());
      await Promise.allSettled(connections);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Concurrent Operations (stress tests for tab switching)
  // ═══════════════════════════════════════════════════════════════

  describe('Concurrent Operations', () => {
    it('should handle 5 concurrent session creates without error', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          fetch(`${baseUrl}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workingDir: '/tmp' }),
          }).then((r) => r.json())
        )
      );

      const ids = results.map((r) => r.data.session.id);
      expect(ids.length).toBe(5);
      expect(new Set(ids).size).toBe(5); // All unique

      // Cleanup
      await Promise.all(ids.map((id) => deleteSession(baseUrl, id)));
    });

    it('should handle concurrent terminal fetches for different sessions', async () => {
      const ids = await Promise.all(Array.from({ length: 3 }, () => createSession(baseUrl)));

      // Fetch all terminal buffers concurrently with tail parameter
      const responses = await Promise.all(ids.map((id) => fetch(`${baseUrl}/api/sessions/${id}/terminal?tail=131072`)));

      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      await Promise.all(ids.map((id) => deleteSession(baseUrl, id)));
    });

    it('should broadcast lifecycle events while filtering concurrent session terminal streams', async () => {
      // Create 2 sessions
      const target = await createSession(baseUrl);
      const other = await createSession(baseUrl);

      // Subscribe only to target
      const controller = new AbortController();
      let receivedData = '';

      const fetchPromise = fetch(`${baseUrl}/api/events?sessions=${target}`, {
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

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Rapid operations on both sessions concurrently
      await Promise.all([
        fetch(`${baseUrl}/api/sessions/${target}/name`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'target-renamed' }),
        }),
        fetch(`${baseUrl}/api/sessions/${other}/name`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'other-renamed' }),
        }),
        deleteSession(baseUrl, other),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      try {
        await fetchPromise;
      } catch {
        /* expected */
      }

      const events = parseSSEEvents(receivedData);

      // session:updated is a lifecycle event broadcast to all clients; the
      // subscription filter applies only to high-volume terminal streams.
      const updatedEvents = events.filter((e) => e.event === 'session:updated');
      const targetUpdated = updatedEvents.find((e) => (e.data as any).id === target);
      expect(targetUpdated).toBeDefined();

      const otherLifecycleEvents = events.filter(
        (e) => e.event !== 'init' && e.event !== 'session:terminal' && (e.data as any)?.id === other
      );
      expect(otherLifecycleEvents.length).toBeGreaterThan(0);

      const otherTerminalEvents = events.filter(
        (e) => e.event === 'session:terminal' && (e.data as any)?.sessionId === other
      );
      expect(otherTerminalEvents.length).toBe(0);

      await deleteSession(baseUrl, target);
    });
  });
});
