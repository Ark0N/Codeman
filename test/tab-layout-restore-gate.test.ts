/** @fileoverview Startup restoration must gate destructive tab-layout reconciliation. */
import { describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';

describe('tab layout restore gate', () => {
  it('does not unlock pruning, cleanup stale state, or reconcile after a failed restore', async () => {
    const markRestorationComplete = vi.fn();
    const markRestorationFailed = vi.fn();
    const reconcileAfterRestoration = vi.fn(async () => {});
    const cleanupStaleSessions = vi.fn(async () => 0);
    const server = Object.create(WebServer.prototype) as {
      tabLayouts: {
        markRestorationComplete: typeof markRestorationComplete;
        markRestorationFailed: typeof markRestorationFailed;
        reconcileAfterRestoration: typeof reconcileAfterRestoration;
      };
      cleanupStaleSessions: typeof cleanupStaleSessions;
      mux: { reconcileSessions(): Promise<never> };
      restoreMuxSessions(): Promise<boolean>;
      finalizeRestoredState(restored: boolean): Promise<void>;
    };
    server.tabLayouts = { markRestorationComplete, markRestorationFailed, reconcileAfterRestoration };
    server.cleanupStaleSessions = cleanupStaleSessions;
    server.mux = { reconcileSessions: vi.fn(async () => Promise.reject(new Error('mux unavailable'))) };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const restored = await server.restoreMuxSessions();
    await server.finalizeRestoredState(restored);

    expect(restored).toBe(false);
    expect(markRestorationComplete).not.toHaveBeenCalled();
    expect(markRestorationFailed).toHaveBeenCalledTimes(1);
    expect(cleanupStaleSessions).not.toHaveBeenCalled();
    expect(reconcileAfterRestoration).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith('[Server] Failed to restore mux sessions:', expect.any(Error));
  });

  it('unlocks cleanup and reconciliation only after successful restoration', async () => {
    const order: string[] = [];
    const server = Object.create(WebServer.prototype) as {
      tabLayouts: {
        markRestorationComplete(): void;
        markRestorationFailed(): void;
        reconcileAfterRestoration(): Promise<void>;
      };
      cleanupStaleSessions(): Promise<number>;
      finalizeRestoredState(restored: boolean): Promise<void>;
      sessions: Map<string, unknown>;
      store: { getSessions(): Record<string, unknown> };
    };
    // Read by the agent-inbox prune at the end of a successful restore.
    server.sessions = new Map();
    server.store = { getSessions: () => ({}) };
    server.tabLayouts = {
      markRestorationComplete: () => order.push('complete'),
      markRestorationFailed: () => order.push('failed'),
      reconcileAfterRestoration: async () => {
        order.push('reconcile');
      },
    };
    server.cleanupStaleSessions = async () => (order.push('cleanup'), 0);

    await server.finalizeRestoredState(true);

    expect(order).toEqual(['complete', 'cleanup', 'reconcile']);
  });
});
