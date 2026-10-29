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
import { findSessionOrFail, isAdmin, parseBody } from '../route-helpers.js';
import type { SessionPort } from '../ports/session-port.js';
import { isMultiUserMode } from '../../config/multiuser.js';
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
    const { id } = req.params as { id: string };
    const { message, urgent, file } = parseBody(DiscordNotifySchema, req.body, 'Invalid Discord message');
    const session = findSessionOrFail(deps.ctx, id, req);
    let upload: { name: string; data: Uint8Array } | undefined;
    if (file !== undefined) {
      const problem = await fileProblem(session.workingDir, !!session.remote, file);
      if (typeof problem === 'string') {
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
      urgent === true
    );
    if (result === null) {
      reply.code(409);
      return createErrorResponse(ApiErrorCode.CONFLICT, 'The Discord bridge is not enabled');
    }
    return { success: true, data: result };
  });
}
