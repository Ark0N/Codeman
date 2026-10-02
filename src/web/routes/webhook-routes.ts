/**
 * @fileoverview Webhook notification settings (src/webhook-notify.ts).
 *
 * GET  /api/webhook       — the config WITHOUT its URL (scheme + host only), and the last delivery result
 * PUT  /api/webhook       — change enabled / kind / url / scope; an empty `url` clears it
 * POST /api/webhook/test  — send one test message with the saved config
 *
 * The URL is a bearer secret (anyone holding a Slack/Discord webhook URL can post as it), so it is
 * stored in its own 0600 file and never returned. In multi-user mode all three routes are admin only:
 * the channel receives every session's events, the same reach an admin's own Web Push has.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { isAdmin, parseBody } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { WebhookUpdateSchema } from '../schemas.js';
import {
  maskWebhookUrl,
  readWebhookConfig,
  webhookUrlProblem,
  writeWebhookConfig,
  type WebhookKind,
  type WebhookNotifier,
  type WebhookResult,
  type WebhookScope,
} from '../../webhook-notify.js';

export interface WebhookStatus {
  enabled: boolean;
  kind: WebhookKind;
  scope: WebhookScope;
  hasUrl: boolean;
  /** Scheme + host only; the path and query are the secret. */
  urlMasked: string;
  lastResult: WebhookResult | null;
}

export interface WebhookRouteDeps {
  notifier: WebhookNotifier;
  configDir: string;
  /** The instance's window title, so a test message says which machine sent it. */
  hostTitle: () => string;
}

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  const denied = (req: FastifyRequest, reply: FastifyReply): ApiResponse<never> | null => {
    if (isMultiUserMode() && !isAdmin(req)) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
    }
    return null;
  };

  const status = async (): Promise<WebhookStatus> => {
    const cfg = await readWebhookConfig(deps.configDir);
    return {
      enabled: cfg.enabled,
      kind: cfg.kind,
      scope: cfg.scope,
      hasUrl: cfg.url !== '',
      urlMasked: maskWebhookUrl(cfg.url),
      lastResult: deps.notifier.lastResult,
    };
  };

  app.get('/api/webhook', async (req, reply): Promise<ApiResponse<WebhookStatus>> => {
    const no = denied(req, reply);
    if (no) return no;
    return { success: true, data: await status() };
  });

  app.put('/api/webhook', async (req, reply): Promise<ApiResponse<WebhookStatus>> => {
    const no = denied(req, reply);
    if (no) return no;
    const patch = parseBody(WebhookUpdateSchema, req.body, 'Invalid webhook settings');
    const current = await readWebhookConfig(deps.configDir);
    const next = {
      enabled: patch.enabled ?? current.enabled,
      kind: patch.kind ?? current.kind,
      scope: patch.scope ?? current.scope,
      url: patch.url !== undefined ? patch.url.trim() : current.url,
    };
    if (next.url) {
      const problem = webhookUrlProblem(next.url);
      if (problem) {
        reply.code(400);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, problem);
      }
    }
    if (next.enabled && !next.url) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Add a webhook URL before enabling notifications');
    }
    try {
      await writeWebhookConfig(deps.configDir, next);
    } catch (err) {
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
    return { success: true, data: await status() };
  });

  app.post('/api/webhook/test', async (req, reply): Promise<ApiResponse<WebhookResult>> => {
    const no = denied(req, reply);
    if (no) return no;
    const cfg = await readWebhookConfig(deps.configDir);
    if (!cfg.url) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Save a webhook URL first');
    }
    // 200 even when delivery failed: the request to Codeman worked, `data.ok` says whether the webhook did.
    return { success: true, data: await deps.notifier.sendTest(cfg, deps.hostTitle()) };
  });
}
