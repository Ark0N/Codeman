/**
 * @fileoverview Discord bridge settings and the deliberate-post route (src/discord-bridge.ts).
 *
 * GET  /api/discord                    the config WITHOUT its token, plus gateway state and last result
 * PUT  /api/discord                    change any field; an empty `token` clears it
 * POST /api/discord/test               post one test message to the parent channel
 * POST /api/sessions/:id/discord-notify  a CLI asks for the user (physical step, blocker, timed-out watch)
 *
 * The bot token is a bearer secret, so it is stored in its own 0600 file and never returned. In
 * multi-user mode the three settings routes are admin only: the server receives every session's
 * events. `discord-notify` follows the session's own ownership rules instead.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { canAccessOwned, findSessionOrFail, getAuthUser, isAdmin, parseBody } from '../route-helpers.js';
import type { SessionPort } from '../ports/session-port.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { describeUnknownPath, probePathKind } from '../../utils/bounded-path-probe.js';
import { DiscordNotifySchema, DiscordUpdateSchema } from '../schemas.js';
import {
  discordConfigProblem,
  MAX_FILE_BYTES,
  maskToken,
  readDiscordConfig,
  writeDiscordConfig,
  type DiscordBridge,
  type DiscordConfig,
  type DiscordGatewayState,
  type DiscordResult,
} from '../../discord-bridge.js';

export interface DiscordRouteDeps {
  bridge: DiscordBridge;
  configDir: string;
  ctx: SessionPort;
  hostTitle: () => string;
}

export type DiscordStatus = Omit<DiscordConfig, 'token'> & {
  hasToken: boolean;
  tokenMasked: string;
  gateway: DiscordGatewayState;
  gatewayError: string | null;
  lastResult: DiscordResult | null;
};

/**
 * A Docker case exports CODEMAN_SESSION_ID cut to 8 characters, so accept a unique prefix of at
 * least that length. Anything ambiguous or shorter is left as given and 404s like any unknown id.
 */
function resolveSessionId(ctx: SessionPort, req: FastifyRequest, id: string): string {
  if (ctx.sessions.has(id) || id.length < 8) return id;
  // Only sessions the caller may see count, so another user's session is never revealed by its prefix.
  const user = getAuthUser(req);
  const hits = [...ctx.sessions.values()].filter((s) => s.id.startsWith(id) && canAccessOwned(user, s.owner));
  return hits.length === 1 ? hits[0].id : id;
}

// A loop or a prompt-injected agent must not ping the phones until Discord answers 429, nor hold 8 MB
// uploads in memory without bound. Per session, refilled continuously (the same shape as paste-image's).
const NOTIFY_PER_MINUTE = 6;
const notifyBuckets = new Map<string, { tokens: number; at: number }>();

function consumeNotifyToken(sessionId: string, now: number = Date.now()): boolean {
  if (notifyBuckets.size > 1000) {
    for (const [k, b] of notifyBuckets) if (now - b.at > 3_600_000) notifyBuckets.delete(k);
  }
  const b = notifyBuckets.get(sessionId) ?? { tokens: NOTIFY_PER_MINUTE, at: now };
  b.tokens = Math.min(NOTIFY_PER_MINUTE, b.tokens + ((now - b.at) * NOTIFY_PER_MINUTE) / 60_000);
  b.at = now;
  notifyBuckets.set(sessionId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Give back a token spent on a request that was refused before anything was posted. */
function refundNotifyToken(sessionId: string): void {
  const b = notifyBuckets.get(sessionId);
  if (b) b.tokens = Math.min(NOTIFY_PER_MINUTE, b.tokens + 1);
}

/** Test hook: forget every bucket between runs. */
export function _resetNotifyBuckets(): void {
  notifyBuckets.clear();
}

/**
 * A file a session may send: a regular file, at most MAX_FILE_BYTES, whose REAL path (symlinks
 * followed) lies inside the session's working folder. Anything else is refused, so a CLI cannot be
 * talked into posting ~/.codeman/discord.json or an ssh key. Returns the bytes, or the reason.
 */
async function fileProblem(
  workingDir: string,
  remote: boolean,
  file: string
): Promise<{ name: string; data: Uint8Array } | string> {
  if (remote) return 'Files can only be sent from a local session';
  if (!isAbsolute(file)) return 'The file path must be absolute';
  // Bounded first: realpath on a dead mount would hang the request.
  if ((await probePathKind(workingDir, { pastCap: true })) !== 'directory') {
    return describeUnknownPath('The session folder', workingDir, { pastCap: true });
  }
  // The agent chose this path: probe it bounded too, before realpath can hold a worker on a dead mount.
  const kind = await probePathKind(file, { pastCap: true });
  if (kind === 'unknown') return describeUnknownPath('The file', file, { pastCap: true });
  if (kind !== 'file') return 'Not a regular file';
  try {
    const [root, real] = await Promise.all([realpath(workingDir), realpath(file)]);
    const rel = relative(root, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      return 'The file must be inside the session folder';
    const info = await stat(real);
    if (!info.isFile()) return 'Not a regular file';
    if (info.size > MAX_FILE_BYTES) return `The file is over ${MAX_FILE_BYTES / 1024 / 1024} MB`;
    return { name: basename(real), data: new Uint8Array(await readFile(real)) };
  } catch {
    return 'The file could not be read';
  }
}

export function registerDiscordRoutes(app: FastifyInstance, deps: DiscordRouteDeps): void {
  const denied = (req: FastifyRequest, reply: FastifyReply): ApiResponse<never> | null => {
    if (isMultiUserMode() && !isAdmin(req)) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
    }
    return null;
  };

  const status = async (): Promise<DiscordStatus> => {
    const { token, ...rest } = await readDiscordConfig(deps.configDir);
    return {
      ...rest,
      hasToken: token !== '',
      tokenMasked: maskToken(token),
      gateway: deps.bridge.gatewayState,
      gatewayError: deps.bridge.gatewayError,
      lastResult: deps.bridge.lastResult,
    };
  };

  app.get('/api/discord', async (req, reply): Promise<ApiResponse<DiscordStatus>> => {
    const no = denied(req, reply);
    if (no) return no;
    return { success: true, data: await status() };
  });

  app.put('/api/discord', async (req, reply): Promise<ApiResponse<DiscordStatus>> => {
    const no = denied(req, reply);
    if (no) return no;
    const patch = parseBody(DiscordUpdateSchema, req.body, 'Invalid Discord settings');
    const current = await readDiscordConfig(deps.configDir);
    const next: DiscordConfig = {
      ...current,
      ...patch,
      token: patch.token !== undefined ? patch.token.trim() : current.token,
    };
    const problem = discordConfigProblem(next);
    if (problem) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, problem);
    }
    try {
      await writeDiscordConfig(deps.configDir, next);
      await deps.bridge.reload();
    } catch (err) {
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
    return { success: true, data: await status() };
  });

  app.post('/api/discord/test', async (req, reply): Promise<ApiResponse<DiscordResult>> => {
    const no = denied(req, reply);
    if (no) return no;
    const cfg = await readDiscordConfig(deps.configDir);
    if (!cfg.token || !cfg.parentChannelId) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Save the bot token and parent channel ID first');
    }
    // 200 even when delivery failed: the request to Codeman worked, `data.ok` says whether Discord did.
    return { success: true, data: await deps.bridge.sendTest(cfg, deps.hostTitle()) };
  });

  app.post('/api/sessions/:id/discord-notify', async (req, reply): Promise<ApiResponse<DiscordResult | null>> => {
    const { id: rawId } = req.params as { id: string };
    const id = resolveSessionId(deps.ctx, req, rawId);
    const { message, urgent, file } = parseBody(DiscordNotifySchema, req.body, 'Invalid Discord message');
    const session = findSessionOrFail(deps.ctx, id, req);
    if (!consumeNotifyToken(session.id)) {
      reply.code(429);
      reply.header('Retry-After', '60');
      return createErrorResponse(
        ApiErrorCode.RATE_LIMITED,
        `Too many messages (${NOTIFY_PER_MINUTE} per minute per session)`
      );
    }
    let upload: { name: string; data: Uint8Array } | undefined;
    if (file !== undefined) {
      const problem = await fileProblem(session.workingDir, !!session.remote, file);
      if (typeof problem === 'string') {
        refundNotifyToken(session.id);
        reply.code(400);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, problem);
      }
      upload = problem;
    }
    const result = await deps.bridge.notify(
      {
        event: 'session:discord-notify',
        title: urgent ? 'Needs you now' : 'Message from the CLI',
        body: message,
        urgency: urgent ? 'critical' : 'warning',
        sessionId: session.id,
        sessionName: session.name,
        host: deps.hostTitle(),
        file: upload,
      },
      // deliberate: an agent's own message is never deduped, so a second, different post is not lost.
      { urgent: urgent === true, deliberate: true }
    );
    if (result === null) {
      reply.code(409);
      return createErrorResponse(ApiErrorCode.CONFLICT, 'The Discord bridge is not enabled');
    }
    return { success: true, data: result };
  });
}
