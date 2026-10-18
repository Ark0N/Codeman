/**
 * @fileoverview Story Mode routes (`story-mode.js` in the browser). EXPERIMENTAL: payload shapes are
 * not frozen.
 *
 * - `GET /api/sessions/:id/story[?turn=<id>]`: one turn of a Claude Code session as a comic page;
 *   without `turn` the newest turn is drawn.
 * - `GET /api/sessions/:id/story/helpers/:agentId`: one helper's own steps (an Agent call's
 *   transcript, `<conversation>/subagents/agent-<agentId>.jsonl` beside the session's), as one page.
 *
 * Both answer `{ supported: false, reason }` for a session they cannot draw, decided from the CLI's
 * registry capability (`capabilities.transcript === 'claude-jsonl'`, never the mode id) and from
 * where the transcript lives: a remote or Docker session's transcript is not on this host.
 *
 * Read-only: unlike `last-response` they never adopt a conversation id or persist anything. The file
 * read is the session's own transcript, chosen here and never named by the request: the path the
 * Claude hook reported for this session, else `<conversation id>.jsonl` under the projects directory.
 * A helper's file is derived from that path and an `agentId` checked against a strict charset.
 * Reading is bounded and async (story-reader.ts); what comes back is untrusted text the browser
 * renders with `textContent`, and file paths in it open through the existing file preview.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  ApiErrorCode,
  createErrorResponse,
  type ApiResponse,
  type StoryHelperResponse,
  type StoryResponse,
} from '../../types.js';
import { getCli } from '../../config/cli-registry/registry.js';
import { buildHelperPage, buildStoryPage, buildStoryTurns, summarizeTurns } from '../../story-mode.js';
import { readStoryEntries } from '../../story-reader.js';
import { findClaudeTranscriptPath } from '../../utils/claude-transcript.js';
import { findSessionOrFail } from '../route-helpers.js';
import type { ConfigPort, SessionPort } from '../ports/index.js';

/**
 * Part of every ETag, so a server restart (possibly with a new page format) never answers 304 for a
 * page an older server built.
 */
const SERVER_EPOCH = Date.now().toString(36);
/** A helper's `.meta.json` is a few hundred bytes; anything bigger is not one. */
const MAX_META_BYTES = 64 * 1024;

/** The hook-reported path when it looks like a transcript, else a lookup by conversation id. */
async function resolveTranscriptPath(hookPath: string | null, conversationId: string): Promise<string | null> {
  if (hookPath && hookPath.startsWith('/') && hookPath.endsWith('.jsonl')) return hookPath;
  return findClaudeTranscriptPath(conversationId);
}

type Source = { unsupported: string } | { path: string | null };

/** Whether this session can be drawn at all, and where its transcript is. */
async function storySource(ctx: SessionPort & ConfigPort, id: string, req: FastifyRequest): Promise<Source> {
  const session = findSessionOrFail(ctx, id, req);
  if (getCli(session.mode)?.capabilities.transcript !== 'claude-jsonl') {
    return { unsupported: 'Story Mode draws Claude Code sessions, and this one runs a shell or another CLI.' };
  }
  if (session.remote || session.docker) {
    return {
      unsupported:
        'Story Mode reads transcripts on this machine. This session keeps its transcript on another host or inside a container.',
    };
  }
  return { path: await resolveTranscriptPath(ctx.getTranscriptPath(id), session.claudeSessionId || session.id) };
}

/**
 * Sets the ETag and answers true (after sending a 304) when the browser already holds this version.
 * A live view refetches every few seconds; while the file has not changed, nothing gets built.
 */
function notModified(req: FastifyRequest, reply: FastifyReply, tag: string): boolean {
  const etag = `W/"story-${SERVER_EPOCH}-${tag}"`;
  reply.header('ETag', etag).header('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] !== etag) return false;
  reply.code(304).send();
  return true;
}

async function readHelperMeta(path: string): Promise<{ type?: string; description?: string; finished?: boolean }> {
  try {
    if ((await stat(path)).size > MAX_META_BYTES) return {};
    const meta = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    return {
      type: typeof meta.agentType === 'string' ? meta.agentType.slice(0, 80) : undefined,
      description: typeof meta.description === 'string' ? meta.description.slice(0, 300) : undefined,
      finished: typeof meta.finished === 'boolean' ? meta.finished : undefined,
    };
  } catch {
    return {};
  }
}

export function registerStoryRoutes(app: FastifyInstance, ctx: SessionPort & ConfigPort): void {
  app.get('/api/sessions/:id/story', async (req, reply): Promise<ApiResponse<StoryResponse> | void> => {
    const { id } = req.params as { id: string };
    const { turn } = req.query as { turn?: unknown };
    const source = await storySource(ctx, id, req);
    if ('unsupported' in source) return { success: true, data: { supported: false, reason: source.unsupported } };
    if (!source.path) return { success: true, data: { supported: true, turns: [], page: null } };

    let read;
    try {
      read = await readStoryEntries(source.path);
    } catch {
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Could not read the session transcript');
    }
    const turnKey = typeof turn === 'string' && turn ? turn : '';
    if (notModified(req, reply, `${read.version}-${encodeURIComponent(turnKey || 'latest')}`)) return;

    const turns = buildStoryTurns(read.entries);
    const wanted = turnKey ? turns.find((t) => t.id === turnKey) : turns[turns.length - 1];
    return {
      success: true,
      data: { supported: true, turns: summarizeTurns(turns), page: wanted ? buildStoryPage(wanted) : null },
    };
  });

  app.get(
    '/api/sessions/:id/story/helpers/:agentId',
    async (req, reply): Promise<ApiResponse<StoryHelperResponse> | void> => {
      const { id, agentId } = req.params as { id: string; agentId: string };
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) {
        reply.code(400);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid helper id');
      }
      const source = await storySource(ctx, id, req);
      if ('unsupported' in source) return { success: true, data: { supported: false, reason: source.unsupported } };
      const helper = { agentId };
      if (!source.path) return { success: true, data: { supported: true, helper, page: null } };

      const dir = join(dirname(source.path), basename(source.path, '.jsonl'), 'subagents');
      const path = join(dir, `agent-${agentId}.jsonl`);
      let read;
      try {
        read = await readStoryEntries(path, { sidechain: true });
      } catch {
        // Not written yet (a helper that just started), or gone: nothing to draw, not an error.
        return { success: true, data: { supported: true, helper, page: null } };
      }
      const meta = await readHelperMeta(join(dir, `agent-${agentId}.meta.json`));
      if (notModified(req, reply, `helper-${read.version}-${meta.finished ? 1 : 0}`)) return;
      return {
        success: true,
        data: {
          supported: true,
          helper: { ...helper, ...meta },
          page: buildHelperPage(buildStoryTurns(read.entries), meta.finished),
        },
      };
    }
  );
}
