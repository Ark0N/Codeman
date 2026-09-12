/**
 * @fileoverview Custom Model Endpoint Profiles CRUD + discovery
 * (deployment_plan.md). Endpoints are machine-level infra, like remote/docker
 * hosts, so writes are admin-only in multi-user mode
 * (`case-routes.ts`'s `/api/remote-hosts` is the pattern this mirrors).
 *
 * Discovery (`POST /:id/discover-models`) fetches `${baseUrl}/v1/models`.
 * `isBlockedWebviewUrl()` is the same synchronous hostname/link-local/cloud-
 * metadata check `webview-egress-policy.ts` uses for saved dashboard URLs —
 * reused here as a save-time and discover-time guard. It does NOT re-check
 * the DNS-RESOLVED address the way `webviewFetch()`'s undici lookup hook
 * does; wiring that dispatcher-level guard here is a followup, not done in
 * this pass, since this route is already admin-only in multi-user mode.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, type ApiResponse } from '../../types.js';
import { isAdmin, parseBody } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { getDataDir } from '../../config/instance.js';
import { isBlockedWebviewUrl } from '../webview-egress-policy.js';
import { CustomModelHostSchema } from '../schemas.js';
import { readCustomModelHosts, writeCustomModelHosts, type CustomModelHost } from '../../custom-model-hosts.js';

const CODEMAN_CONFIG_DIR = getDataDir();
const DISCOVER_TIMEOUT_MS = 8000;

function adminOnly(req: FastifyRequest, reply: { code: (n: number) => unknown }): ApiResponse<never> | null {
  if (!isMultiUserMode() || isAdmin(req)) return null;
  reply.code(403);
  return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
}

async function discoverModels(host: Pick<CustomModelHost, 'baseUrl' | 'apiKey' | 'authStyle'>): Promise<string[]> {
  const headers: Record<string, string> = {};
  const apiKey = host.apiKey?.trim();
  // Exactly ONE header, never both — see custom-model-hosts.ts's CustomModelAuthStyle
  // doc comment for why: sending both reliably HANGS some real servers.
  const style = host.authStyle ?? 'bearer';
  if (apiKey && style === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  if (apiKey && style === 'api-key') headers['api-key'] = apiKey;

  const res = await fetch(`${host.baseUrl.replace(/\/+$/, '')}/v1/models`, {
    headers,
    signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function registerCustomModelRoutes(app: FastifyInstance): void {
  app.get('/api/model-endpoints', async (req) =>
    isMultiUserMode() && !isAdmin(req) ? [] : readCustomModelHosts(CODEMAN_CONFIG_DIR)
  );

  app.post('/api/model-endpoints', async (req, reply): Promise<ApiResponse<{ host: CustomModelHost }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const host = parseBody(CustomModelHostSchema, req.body);
    if (isBlockedWebviewUrl(host.baseUrl)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
    }
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    if (hosts.some((item) => item.id === host.id)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Model endpoint already exists');
    }
    await writeCustomModelHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
    return { success: true, data: { host } };
  });

  app.put('/api/model-endpoints/:id', async (req, reply): Promise<ApiResponse<{ host: CustomModelHost }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const host = parseBody(CustomModelHostSchema, { ...(req.body as object), id });
    if (isBlockedWebviewUrl(host.baseUrl)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
    }
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    const index = hosts.findIndex((item) => item.id === id);
    if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Model endpoint not found');
    const next = [...hosts];
    next[index] = host;
    await writeCustomModelHosts(CODEMAN_CONFIG_DIR, next);
    return { success: true, data: { host } };
  });

  app.delete('/api/model-endpoints/:id', async (req, reply): Promise<ApiResponse<{ id: string }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    await writeCustomModelHosts(
      CODEMAN_CONFIG_DIR,
      hosts.filter((item) => item.id !== id)
    );
    return { success: true, data: { id } };
  });

  app.post(
    '/api/model-endpoints/:id/discover-models',
    async (req, reply): Promise<ApiResponse<{ models: string[] }>> => {
      const denied = adminOnly(req, reply);
      if (denied) return denied;
      const { id } = req.params as { id: string };
      const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
      const index = hosts.findIndex((item) => item.id === id);
      if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Model endpoint not found');
      const host = hosts[index];
      if (isBlockedWebviewUrl(host.baseUrl)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
      }
      try {
        const models = await discoverModels(host);
        const next = [...hosts];
        next[index] = { ...host, models, lastDiscoveredAt: new Date().toISOString() };
        await writeCustomModelHosts(CODEMAN_CONFIG_DIR, next);
        return { success: true, data: { models } };
      } catch (err) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          `Could not reach endpoint: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );
}
