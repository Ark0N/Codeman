/**
 * @fileoverview How server.ts treats the agent inbox across a session's lifecycle.
 *
 * - Delete (`killMux=true`) drops the inbox; detach and shutdown (`killMux=false`)
 *   keep it, because a detached session comes back.
 * - Boot pruning of orphaned inboxes runs only after a successful restore, and keeps
 *   every session state.json still holds plus every session on the reboot-restore
 *   offer (its record is already pruned, and a rebuild reuses the id). A failed
 *   restore leaves all mail alone.
 *
 * Uses a bare `WebServer.prototype` object with just the fields these paths touch,
 * like tab-layout-restore-gate.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { agentInbox } from '../src/web/agent-inbox.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import type { RebootRestoreEntry } from '../src/reboot-restore.js';
import type { SessionState } from '../src/types.js';

type CleanupServer = {
  _doCleanupSession(sessionId: string, killMux: boolean, reason?: string): Promise<void>;
  finalizeRestoredState(restored: boolean): Promise<void>;
  [key: string]: unknown;
};

function bareServer(live: string[] = [], persisted: string[] = []): CleanupServer {
  const server = Object.create(WebServer.prototype) as CleanupServer;
  Object.assign(server, {
    sessions: new Map(live.map((id) => [id, {}])),
    keepWarmService: { remove: () => {} },
    store: {
      getSession: () => null,
      getSessions: () => Object.fromEntries(persisted.map((id) => [id, {}])),
      removeRalphState: () => {},
    },
    tabLayouts: {
      markRestorationComplete: () => {},
      markRestorationFailed: () => {},
      reconcileAfterRestoration: async () => {},
    },
    cleanupStaleSessions: async () => 0,
    _customModelDisplacedNotified: new Set(),
    respawnControllers: new Map(),
    respawnTimers: new Map(),
    pendingRespawnStarts: new Map(),
    runSummaryTrackers: new Map(),
    stopTranscriptWatcher: () => {},
    persistDeb: { cancelKey: () => {} },
    sse: { cleanupSessionBatches: () => {} },
    broadcast: () => {},
  });
  return server;
}

/** A reboot-restore offer entry; the prune reads only its `sessionId`. */
function offerEntry(sessionId: string): RebootRestoreEntry {
  return {
    sessionId,
    workingDir: `/tmp/codeman-agent-inbox-offer/${sessionId}`,
    mode: 'claude',
    resumeConversationId: `conv-${sessionId}`,
    state: { id: sessionId, workingDir: `/tmp/codeman-agent-inbox-offer/${sessionId}` } as SessionState,
  };
}

describe('agent inbox server wiring', () => {
  beforeEach(() => agentInbox.resetForTests());
  afterEach(() => {
    agentInbox.resetForTests();
    rebootRestoreRegistry.reset();
  });

  it('a delete drops the inbox; a detach (killMux=false) keeps it', async () => {
    const server = bareServer();
    agentInbox.post('detached', null, 'still here after detach');
    agentInbox.post('deleted', null, 'gone with the session');
    await server._doCleanupSession('detached', false, 'test');
    await server._doCleanupSession('deleted', true, 'test');
    expect(agentInbox.pendingCount('detached')).toBe(1);
    expect(agentInbox.pendingCount('deleted')).toBe(0);
  });

  it('a failed restore prunes nothing', async () => {
    const server = bareServer();
    agentInbox.post('not-restored', null, 'm');
    await server.finalizeRestoredState(false);
    expect(agentInbox.pendingCount('not-restored')).toBe(1);
  });

  it('a successful restore prunes orphans and keeps live and persisted sessions', async () => {
    const server = bareServer(['live'], ['kept-for-recovery']);
    for (const id of ['live', 'kept-for-recovery', 'orphan']) agentInbox.post(id, null, 'm');
    await server.finalizeRestoredState(true);
    expect(agentInbox.pendingCount('live')).toBe(1);
    expect(agentInbox.pendingCount('kept-for-recovery')).toBe(1);
    expect(agentInbox.pendingCount('orphan')).toBe(0);
  });

  it('a successful restore keeps the inbox of a session on the reboot-restore offer', async () => {
    // After a host reboot the dead session is in neither `this.sessions` nor state.json
    // (cleanupStaleSessions already pruned its record), only in the offer, and the
    // rebuild reuses its id, so its mail must still be there when it comes back.
    const server = bareServer();
    rebootRestoreRegistry.set([offerEntry('on-offer')]);
    for (const id of ['on-offer', 'orphan']) agentInbox.post(id, null, 'm');
    await server.finalizeRestoredState(true);
    expect(rebootRestoreRegistry.list(() => true).map((e) => e.sessionId)).toEqual(['on-offer']);
    expect(agentInbox.pendingCount('on-offer')).toBe(1);
    expect(agentInbox.pendingCount('orphan')).toBe(0);
  });
});
