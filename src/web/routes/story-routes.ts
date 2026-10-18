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
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import {
  ApiErrorCode,
  createErrorResponse,
  type ApiResponse,
  type StoryHelperResponse,
  type StoryResponse,
} from '../../types.js';
import { getCli } from '../../config/cli-registry/registry.js';
import { STORY_LIMITS, buildHelperPage, buildStoryPage, buildStoryTurns, summarizeTurns } from '../../story-mode.js';
import { readSmallRegularFile, readStoryEntries, storyFileVersion } from '../../story-reader.js';
import {
  claudeProjectsDir,
  findClaudeTranscriptPath,
  findRestoredClaudeTranscriptPath,
} from '../../utils/claude-transcript.js';
import { LRUMap } from '../../utils/lru-map.js';
import { findSessionOrFail } from '../route-helpers.js';
import type { ConfigPort, SessionPort } from '../ports/index.js';

/**
 * Part of every ETag, so a server restart (possibly with a new page format) never answers 304 for a
 * page an older server built.
 */
const SERVER_EPOCH = Date.now().toString(36);
/** A helper's `.meta.json` is a few hundred bytes; anything bigger is not one. */
const MAX_META_BYTES = 64 * 1024;

/**
 * Whether `path` really lies in a Claude projects folder (the session's relocated config dir, or the
 * server's): symlinks resolved on both sides. Story Mode sends a transcript's CONTENT to the
 * browser, so the hook-reported path is trusted only where Claude Code writes transcripts.
 */
async function insideClaudeProjects(path: string, configDir?: string): Promise<boolean> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return false;
  }
  for (const root of new Set([claudeProjectsDir(configDir), claudeProjectsDir()])) {
    let base = root;
    try {
      base = await realpath(root);
    } catch {
      // a projects folder that does not exist holds nothing
      continue;
    }
    if (real.startsWith(base.endsWith(sep) ? base : base + sep)) return true;
  }
  return false;
}

/**
 * Transcripts found by id, briefly: a lookup reads every project folder, and a view without a hook
 * path (normal after a server restart) asks every few seconds. A miss is kept shorter, so a session
 * whose first prompt is on its way finds its transcript soon.
 */
const lookups = new LRUMap<string, { path: string | null; at: number }>({ maxSize: 200 });
const LOOKUP_HIT_MS = 30_000;
const LOOKUP_MISS_MS = 4_000;

/** For tests: forget the transcripts found by id. */
export function clearStoryLookupCache(): void {
  lookups.clear();
}

/** The transcript by conversation id, then by Codeman id, then a recovered session's, as last-response finds it. */
async function lookUpTranscript(ids: string[], codemanId: string, configDir?: string): Promise<string | null> {
  const key = `${ids.join('|')}|${configDir ?? ''}`;
  const hit = lookups.get(key);
  if (hit && Date.now() - hit.at < (hit.path ? LOOKUP_HIT_MS : LOOKUP_MISS_MS)) return hit.path;
  let path: string | null = null;
  for (const id of ids) {
    path = await findClaudeTranscriptPath(id, configDir);
    if (path) break;
  }
  path ??= await findRestoredClaudeTranscriptPath(codemanId, configDir);
  lookups.set(key, { path, at: Date.now() });
  return path;
}

/** The hook-reported path when it is a transcript in a projects folder, else a lookup by id. */
async function resolveTranscriptPath(
  hookPath: string | null,
  ids: string[],
  codemanId: string,
  configDir?: string
): Promise<string | null> {
  if (
    hookPath &&
    hookPath.startsWith('/') &&
    hookPath.endsWith('.jsonl') &&
    (await insideClaudeProjects(hookPath, configDir))
  )
    return hookPath;
  return lookUpTranscript(ids, codemanId, configDir);
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
  return {
    path: await resolveTranscriptPath(
      ctx.getTranscriptPath(id),
      [...new Set([session.claudeSessionId, session.id].filter((v): v is string => !!v))],
      session.id,
      session.claudeConfigDir
    ),
  };
}

/**
 * Sets the ETag and answers true (after sending a 304) when the browser already holds this version.
 * A live view refetches every few seconds; while the file has not changed, nothing gets built.
 */
const etagOf = (tag: string) => `W/"story-${SERVER_EPOCH}-${tag}"`;

function notModified(req: FastifyRequest, reply: FastifyReply, tag: string): boolean {
  const etag = etagOf(tag);
  reply.header('ETag', etag).header('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] !== etag) return false;
  reply.code(304).send();
  return true;
}

async function readHelperMeta(path: string): Promise<{ type?: string; description?: string; finished?: boolean }> {
  try {
    // A regular file only, read through one handle (a FIFO or a device here must not pin a worker).
    const text = await readSmallRegularFile(path, MAX_META_BYTES);
    if (text === null) return {};
    const meta = JSON.parse(text) as Record<string, unknown>;
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
    const turnKey = typeof turn === 'string' && turn ? turn.slice(0, 200) : '';
    const tagOf = (version: string) => `${version}-${encodeURIComponent(turnKey || 'latest')}`;
    // An unchanged file is a 304 from a stat alone: no read, no parse, whatever the cache holds.
    const before = await storyFileVersion(source.path);
    if (before && req.headers['if-none-match'] === etagOf(tagOf(before)) && notModified(req, reply, tagOf(before)))
      return;

    let read;
    try {
      read = await readStoryEntries(source.path);
    } catch {
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Could not read the session transcript');
    }
    if (notModified(req, reply, tagOf(read.version))) return;

    const turns = buildStoryTurns(read.entries);
    const wanted = turnKey ? turns.find((t) => t.id === turnKey) : turns[turns.length - 1];
    return {
      success: true,
      data: {
        supported: true,
        turns: summarizeTurns(turns),
        page: wanted ? buildStoryPage(wanted) : null,
        // Older turns exist that the list leaves out: before the part read, or past the listed ones.
        ...(read.partial || turns.length > STORY_LIMITS.turnsListed ? { older: true } : {}),
      },
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
