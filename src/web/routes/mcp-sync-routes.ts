/**
 * @fileoverview MCP server sync (src/mcp-sync.ts).
 *
 * GET  /api/mcp-sync — dry run: per enabled CLI, which servers it has and which it would gain.
 * POST /api/mcp-sync — apply: add the missing servers to each CLI's own config file.
 *
 * Writes files in the SERVER user's home, so in multi-user mode it is admin only. Responses
 * carry server names only, never env values or headers.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { isAdmin } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { enabledClis } from '../../config/cli-registry/registry.js';
import { syncMcpServers, type McpSyncResult, type McpSyncTarget } from '../../mcp-sync.js';

/** Enabled CLIs that declare an MCP config file, in registry order (first definition wins). */
export function mcpSyncTargets(): McpSyncTarget[] {
  return enabledClis()
    .filter((e) => e.capabilities.mcpConfig)
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ id: e.id, label: e.label, ...e.capabilities.mcpConfig! }));
}

function gate(req: FastifyRequest): ApiResponse<never> | null {
  if (isMultiUserMode() && !isAdmin(req)) {
    return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
  }
  return null;
}

export function registerMcpSyncRoutes(app: FastifyInstance): void {
  const run = async (req: FastifyRequest, apply: boolean): Promise<ApiResponse<McpSyncResult>> => {
    const denied = gate(req);
    if (denied) return denied;
    try {
      return { success: true, data: await syncMcpServers(mcpSyncTargets(), { apply }) };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  };
  app.get('/api/mcp-sync', (req) => run(req, false));
  app.post('/api/mcp-sync', (req) => run(req, true));
}
