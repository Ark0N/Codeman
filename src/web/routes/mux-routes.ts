/**
 * @fileoverview Mux (tmux) session management routes.
 * Provides mux session listing, killing, reconciliation, stats control, and
 * discovery of FOREIGN tmux sessions (ones a human started outside Codeman).
 *
 * Discovery lives here rather than beside the adopt endpoint on purpose: like
 * every other route in this file it exposes cross-user process state (other
 * people's session names, commands and working directories), so it inherits the
 * admin gate this file already applies. Adoption is a session CREATE and stays in
 * `session-routes.ts`, where the owner, capacity and case-space gates live.
 */

import { FastifyInstance } from 'fastify';
import type { InfraPort, SessionPort } from '../ports/index.js';
import { STATS_COLLECTION_INTERVAL_MS } from '../../config/server-timing.js';
import { requireAdmin } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { discoverForeignSessions, readAllDockerCases, readAllRemoteHosts } from '../../foreign-tmux-discovery.js';
import { adoptTargetIdentity, foreignTargetKey } from '../../foreign-tmux.js';
import { FOREIGN_POLL_INTERVAL_MS } from '../../config/foreign-tmux.js';

export function registerMuxRoutes(app: FastifyInstance, ctx: InfraPort & SessionPort): void {
  app.get('/api/mux-sessions', async (req, reply) => {
    // Multi-user: this recovery/debug surface exposes every user's tmux + workdirs → admin-only
    // (requireAdmin is a no-op allow-all in single-user mode, so flag-off is unchanged).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const sessions = await ctx.mux.getSessionsWithStats();
    return {
      sessions,
      muxAvailable: ctx.mux.isAvailable(),
    };
  });

  app.delete('/api/mux-sessions/:sessionId', async (req, reply) => {
    // Multi-user: killing any tmux session by name is a cross-user destructive action → admin-only.
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const { sessionId } = req.params as { sessionId: string };
    const success = await ctx.mux.killSession(sessionId);
    return { killed: success };
  });

  app.post('/api/mux-sessions/reconcile', async (req, reply) => {
    // Multi-user: process-wide reconcile → admin-only.
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const result = await ctx.mux.reconcileSessions();
    return result;
  });

  /**
   * Foreign tmux sessions available for adoption.
   *
   * LOCAL results are always included and are TTL-cached, because the home screen
   * polls this endpoint while it is open. DOCKER and REMOTE are opt-in per
   * request (`?docker=1`, `?remote=1`): each costs one `docker exec` or one ssh
   * per target, and having the home page fan those out on every load is the one
   * cost this design refuses to pay.
   *
   * `adoptedBy` is filled from the live sessions, so a target Codeman already wraps
   * renders as "open" rather than offering a second wrapper. Sessions and not mux
   * records: the tmux record only exists once the tab's first attach starts the pane.
   */
  app.get('/api/mux/foreign', async (req, reply) => {
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const wantDocker = q.docker === '1' || q.docker === 'true';
    const wantRemote = q.remote === '1' || q.remote === 'true';

    // Read the registries either way: `canScanWide` tells the browser whether the
    // expensive scan has anywhere to go. Without it the UI hides an empty block,
    // and with it the toggle that is the ONLY way to populate that block, which on
    // a host with containers but no local tmux sessions made the feature invisible.
    const dockerCases = await readAllDockerCases();
    const remoteHosts = await readAllRemoteHosts();

    const result = await discoverForeignSessions({
      local: true,
      force: q.force === '1',
      dockerCases: wantDocker ? dockerCases : undefined,
      remoteHosts: wantRemote ? remoteHosts : undefined,
    });

    // The same key the adopt route's one-wrapper check reads (see foreignTargetKey).
    const wrapped = new Map<string, string>();
    for (const session of ctx.sessions.values()) {
      if (session.adopt) wrapped.set(foreignTargetKey(adoptTargetIdentity(session.adopt)), session.id);
    }

    return {
      sessions: result.sessions.map((f) => ({
        ...f,
        adoptedBy: wrapped.get(foreignTargetKey(f)),
      })),
      scannedAt: result.scannedAt,
      notes: result.notes,
      pollIntervalMs: FOREIGN_POLL_INTERVAL_MS,
      canScanWide: dockerCases.length > 0 || remoteHosts.length > 0,
    };
  });

  app.post('/api/mux-sessions/stats/start', async (req, reply) => {
    // Multi-user: process-wide stats collection toggle → admin-only.
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    ctx.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
    return {};
  });

  app.post('/api/mux-sessions/stats/stop', async (req, reply) => {
    // Multi-user: process-wide stats collection toggle → admin-only.
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    ctx.mux.stopStatsCollection();
    return {};
  });
}
