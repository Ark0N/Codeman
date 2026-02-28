/**
 * @fileoverview Mux (tmux) session management routes.
 * Provides mux session listing, killing, reconciliation, and stats control.
 */

import { FastifyInstance } from 'fastify';
import type { InfraPort } from '../ports/index.js';

// Stats collection interval (2 seconds) — matches server.ts constant
const STATS_COLLECTION_INTERVAL_MS = 2000;

export function registerMuxRoutes(app: FastifyInstance, ctx: InfraPort): void {
  app.get('/api/mux-sessions', async () => {
    const sessions = await ctx.mux.getSessionsWithStats();
    return {
      sessions,
      muxAvailable: ctx.mux.isAvailable(),
    };
  });

  app.delete('/api/mux-sessions/:sessionId', async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    const success = await ctx.mux.killSession(sessionId);
    return { success };
  });

  app.post('/api/mux-sessions/reconcile', async () => {
    const result = await ctx.mux.reconcileSessions();
    return result;
  });

  app.post('/api/mux-sessions/stats/start', async () => {
    ctx.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
    return { success: true };
  });

  app.post('/api/mux-sessions/stats/stop', async () => {
    ctx.mux.stopStatsCollection();
    return { success: true };
  });
}
