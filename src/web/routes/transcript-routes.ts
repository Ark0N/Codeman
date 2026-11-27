/**
 * @fileoverview API of the opt-in saved transcripts (`transcript-store.ts`).
 *
 *   GET    /api/sessions/:id/transcript/search?q=   matching lines of one session, with context
 *   GET    /api/sessions/:id/transcript/lines?line=&radius=   the lines around one hit
 *   DELETE /api/sessions/:id/transcript             delete that session's saved transcript
 *   DELETE /api/transcripts                         delete every saved transcript (admin)
 *
 * Nothing is saved unless `transcriptSearchEnabled` is on (system-routes.ts switches the store);
 * with it off, search answers `null` and the deletes still work, so a stale file can always go.
 * Ownership goes through `findSessionOrFail` with `req`, like every session-scoped route.
 */

import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, type ApiResponse } from '../../types.js';
import { findSessionOrFail, requireAdmin } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import type { SessionPort } from '../ports/index.js';
import {
  MAX_MATCHES,
  MAX_QUERY_CHARS,
  type TranscriptSearchResult,
  type TranscriptWindow,
  type TranscriptStore,
} from '../../transcript-store.js';

export function registerTranscriptRoutes(app: FastifyInstance, ctx: SessionPort, store: TranscriptStore): void {
  app.get('/api/sessions/:id/transcript/search', async (req): Promise<ApiResponse<TranscriptSearchResult | null>> => {
    const { id } = req.params as { id: string };
    const { q, limit } = req.query as { q?: string; limit?: string };
    const session = findSessionOrFail(ctx, id, req);
    if (typeof q !== 'string' || !q.trim() || q.length > MAX_QUERY_CHARS) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `q is required (at most ${MAX_QUERY_CHARS} characters)`);
    }
    const n = Number.parseInt(limit ?? '', 10);
    const result = await store.search(session.id, q, Number.isFinite(n) ? n : MAX_MATCHES);
    return { success: true, data: result };
  });

  app.get('/api/sessions/:id/transcript/lines', async (req): Promise<ApiResponse<TranscriptWindow | null>> => {
    const { id } = req.params as { id: string };
    const { line, radius } = req.query as { line?: string; radius?: string };
    const session = findSessionOrFail(ctx, id, req);
    const n = Number.parseInt(line ?? '', 10);
    if (!Number.isInteger(n) || n < 1)
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'line must be a positive integer');
    const r = Number.parseInt(radius ?? '', 10);
    return { success: true, data: await store.window(session.id, n, Number.isFinite(r) ? r : undefined) };
  });

  app.delete('/api/sessions/:id/transcript', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    await store.remove(session.id);
    return { success: true };
  });

  app.delete('/api/transcripts', async (req, reply) => {
    // One folder for every user's sessions: admin only in multi-user mode.
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    return { success: true, data: { removed: await store.removeAll() } } satisfies ApiResponse<{ removed: number }>;
  });
}
