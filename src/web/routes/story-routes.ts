/**
 * @fileoverview `GET /api/sessions/:id/story`: one turn of a Claude Code session as a comic page
 * (Story Mode, `story-mode.js` in the browser). EXPERIMENTAL: the payload shape is not frozen.
 *
 * Query: `turn=<id>` picks a turn from the `turns` list; without it the newest turn is drawn.
 * Answers `{ supported: false, reason }` for a session it cannot draw, decided from the CLI's
 * registry capability (`capabilities.transcript === 'claude-jsonl'`, never the mode id) and from
 * where the transcript lives: a remote or Docker session's transcript is not on this host.
 *
 * Read-only: unlike `last-response` it never adopts a conversation id or persists anything. The file
 * read is the session's own transcript, chosen here and never named by the request: the path the
 * Claude hook reported for this session, else `<conversation id>.jsonl` under the projects directory.
 * Reading is bounded and async (story-reader.ts); what comes back is untrusted text the browser
 * renders with `textContent`, and file paths in it open through the existing file preview.
 */

import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, type ApiResponse, type StoryResponse } from '../../types.js';
import { getCli } from '../../config/cli-registry/registry.js';
import { buildStoryPage, buildStoryTurns, summarizeTurns } from '../../story-mode.js';
import { readStoryEntries } from '../../story-reader.js';
import { findClaudeTranscriptPath } from '../../utils/claude-transcript.js';
import { findSessionOrFail } from '../route-helpers.js';
import type { ConfigPort, SessionPort } from '../ports/index.js';

/**
 * Part of every ETag, so a server restart (possibly with a new page format) never answers 304 for a
 * page an older server built.
 */
const SERVER_EPOCH = Date.now().toString(36);

/** The hook-reported path when it looks like a transcript, else a lookup by conversation id. */
async function resolveTranscriptPath(hookPath: string | null, conversationId: string): Promise<string | null> {
  if (hookPath && hookPath.startsWith('/') && hookPath.endsWith('.jsonl')) return hookPath;
  return findClaudeTranscriptPath(conversationId);
}

export function registerStoryRoutes(app: FastifyInstance, ctx: SessionPort & ConfigPort): void {
  app.get('/api/sessions/:id/story', async (req, reply): Promise<ApiResponse<StoryResponse>> => {
    const { id } = req.params as { id: string };
    const { turn } = req.query as { turn?: unknown };
    const session = findSessionOrFail(ctx, id, req);

    if (getCli(session.mode)?.capabilities.transcript !== 'claude-jsonl') {
      return {
        success: true,
        data: { supported: false, reason: 'Story Mode draws Claude Code sessions. This session runs a different CLI.' },
      };
    }
    if (session.remote || session.docker) {
      return {
        success: true,
        data: {
          supported: false,
          reason:
            'Story Mode reads transcripts on this machine. This session keeps its transcript on another host or inside a container.',
        },
      };
    }

    const transcriptPath = await resolveTranscriptPath(
      ctx.getTranscriptPath(id),
      session.claudeSessionId || session.id
    );
    if (!transcriptPath) return { success: true, data: { supported: true, turns: [], page: null } };

    let entries;
    let version;
    try {
      ({ entries, version } = await readStoryEntries(transcriptPath));
    } catch {
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Could not read the session transcript');
    }

    // A live view refetches every few seconds; while the transcript has not changed, answer 304
    // before building anything. `no-cache` makes the browser revalidate every time.
    const etag = `W/"story-${SERVER_EPOCH}-${version}-${encodeURIComponent(typeof turn === 'string' && turn ? turn : 'latest')}"`;
    reply.header('ETag', etag).header('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) {
      reply.code(304);
      return reply.send();
    }

    const turns = buildStoryTurns(entries);
    const wanted = typeof turn === 'string' && turn ? turns.find((t) => t.id === turn) : turns[turns.length - 1];
    return {
      success: true,
      data: { supported: true, turns: summarizeTurns(turns), page: wanted ? buildStoryPage(wanted) : null },
    };
  });
}
