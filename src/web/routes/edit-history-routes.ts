/**
 * @fileoverview The edit history panel's API: which files a claude session edited (main agent
 * and subagents), each edit's diff, and Bash-generated images (src/web/edit-history-sync.ts).
 *
 *   GET  /api/sessions/:id/edits[?sync=1]   list (no diffs); `sync=1` reads what is new first
 *   GET  /api/sessions/:id/edits/:entryId   one edit's diff as unified text
 *   POST /api/sessions/:id/edits/older      read the next older block, then list
 *
 * Read-only, and reads only on these requests (the panel drives it; nothing syncs in the
 * background). Remote, Docker and non-claude sessions answer `state: 'unsupported'`
 * without being read. Ownership goes through `findSessionOrFail` with `req`, like every
 * session-scoped route. No route here serves a file: an image entry is shown through the
 * existing file routes (workspace `file-raw`, or the attachment routes outside it).
 */

import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, type ApiResponse } from '../../types.js';
import { findSessionOrFail } from '../route-helpers.js';
import type { SessionPort } from '../ports/index.js';
import type { EditHistoryEntry, EditHistoryStore } from '../../edit-history-store.js';
import type { EditHunk } from '../../edit-history-parse.js';
import {
  unsupportedReason,
  type EditHistorySession,
  type EditHistoryState,
  type EditHistoryStatus,
  type EditHistorySync,
} from '../edit-history-sync.js';

export interface EditHistoryListEntry extends Omit<EditHistoryEntry, 'hunks'> {
  relPath: string;
}

export interface EditHistoryList {
  state: EditHistoryState;
  reason?: string;
  backfillTruncated: boolean;
  agents: Record<string, { description: string; agentType: string; worktreeBranch?: string }>;
  entries: EditHistoryListEntry[];
}

export interface EditHistoryDiff {
  diff: string;
  truncated: boolean;
}

/** `path` relative to `base` when it lies below it, else unchanged. */
export function relativeTo(path: string, base: string | undefined): string {
  if (!base) return path;
  const root = base.endsWith('/') ? base : `${base}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

/** Hunks as unified diff text, the form the Git panel's renderer reads. */
export function hunksToUnified(hunks: readonly EditHunk[]): string {
  const out: string[] = [];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    out.push(...h.lines);
  }
  return out.join('\n');
}

function listOf(
  store: EditHistoryStore,
  workingDir: string,
  status: { state: EditHistoryState; reason?: string }
): EditHistoryList {
  const agents = store.getAgents();
  const entries = store.list().map(({ hunks: _hunks, ...rest }) => ({
    ...rest,
    relPath: relativeTo(rest.path, (rest.agentId && agents[rest.agentId]?.worktreePath) || workingDir),
  }));
  const publicAgents: EditHistoryList['agents'] = {};
  for (const [id, a] of Object.entries(agents)) {
    publicAgents[id] = { description: a.description, agentType: a.agentType };
    if (a.worktreeBranch) publicAgents[id].worktreeBranch = a.worktreeBranch;
  }
  const list: EditHistoryList = {
    state: status.state,
    backfillTruncated: store.backfillTruncated,
    agents: publicAgents,
    entries,
  };
  if (status.reason) list.reason = status.reason;
  return list;
}

export function registerEditHistoryRoutes(app: FastifyInstance, ctx: SessionPort, sync: EditHistorySync): void {
  const sessionOf = (id: string, req: Parameters<typeof findSessionOrFail>[2]) => {
    const session = findSessionOrFail(ctx, id, req);
    const view: EditHistorySession = {
      id: session.id,
      mode: session.mode,
      remote: session.remote,
      docker: session.docker,
      claudeSessionId: session.claudeSessionId,
      claudeConfigDir: session.claudeConfigDir(),
    };
    return { session, view };
  };

  app.get('/api/sessions/:id/edits', async (req): Promise<ApiResponse<EditHistoryList>> => {
    const { id } = req.params as { id: string };
    const { sync: doSync } = req.query as { sync?: string };
    const { session, view } = sessionOf(id, req);
    const why = unsupportedReason(view);
    // The sync starts in the same tick as the session check: a deletion right after it marks
    // the running sync gone (EditHistorySync.remove), so nothing writes a deleted session.
    const status: EditHistoryStatus = why
      ? { state: 'unsupported', reason: why }
      : doSync === '1'
        ? await sync.sync(view)
        : sync.getStatus(session.id);
    return { success: true, data: listOf(await sync.getStore(session.id), session.workingDir, status) };
  });

  app.post('/api/sessions/:id/edits/older', async (req): Promise<ApiResponse<EditHistoryList>> => {
    const { id } = req.params as { id: string };
    const { session, view } = sessionOf(id, req);
    const status = await sync.sync(view, { older: true });
    return { success: true, data: listOf(await sync.getStore(session.id), session.workingDir, status) };
  });

  app.get('/api/sessions/:id/edits/:entryId', async (req, reply): Promise<ApiResponse<EditHistoryDiff>> => {
    const { id, entryId } = req.params as { id: string; entryId: string };
    const { session } = sessionOf(id, req);
    const entry = (await sync.getStore(session.id)).get(entryId);
    if (!entry) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such edit in this session');
    }
    return { success: true, data: { diff: hunksToUnified(entry.hunks), truncated: entry.truncated } };
  });
}
