/**
 * @fileoverview MCP server sync (src/mcp-sync.ts).
 *
 * GET  /api/mcp-sync — dry run: per participating CLI, which servers it has and which it would gain.
 * POST /api/mcp-sync — apply: add the missing servers to each CLI's own config file.
 *
 * Opt-in: both verbs answer 403 until `mcpSyncEnabled` is on (default OFF), because this writes
 * OTHER tools' own user config. Writes files in the SERVER user's home, so in multi-user mode it
 * is admin only. A second apply while one is running answers 409. Responses carry server names
 * only, never env values or headers.
 *
 * A CLI takes part when it is ENABLED in the registry, declares an `mcpConfig`, and is installed
 * or already has its config file; one that is enabled but absent from the machine is reported
 * `absent` and never created.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { isAdmin, readJsonConfig, SETTINGS_PATH } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { enabledClis } from '../../config/cli-registry/registry.js';
import { isCliEntryInstalled, probeStockCliAvailability } from '../../utils/cli-installed-probes.js';
import { McpSyncBusyError, syncMcpServers, type McpSyncResult, type McpSyncTarget } from '../../mcp-sync.js';

/** Default OFF, same shape as `readCliManagementEnabled`: read fresh so a toggle applies at once. */
export async function readMcpSyncEnabled(): Promise<boolean> {
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});
  return settings.mcpSyncEnabled === true;
}

/** Enabled CLIs that declare an MCP config file, in registry order (first definition wins). */
export async function mcpSyncTargets(): Promise<McpSyncTarget[]> {
  const availability = await probeStockCliAvailability();
  return enabledClis()
    .filter((e) => e.capabilities.mcpConfig)
    .sort((a, b) => a.order - b.order)
    .map((e) => ({
      id: e.id,
      label: e.label,
      ...e.capabilities.mcpConfig!,
      installed: isCliEntryInstalled(e, availability),
    }));
}

/** Enabled agent CLIs with no known MCP config file (sync cannot touch them). */
export function mcpUnsupportedLabels(): string[] {
  return enabledClis()
    .filter((e) => e.kind === 'agent' && !e.capabilities.mcpConfig)
    .map((e) => e.label);
}

async function gate(req: FastifyRequest): Promise<ApiResponse<never> | null> {
  if (isMultiUserMode() && !isAdmin(req)) {
    return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
  }
  if (!(await readMcpSyncEnabled())) {
    return createErrorResponse(ApiErrorCode.FORBIDDEN, 'MCP sync is disabled. Enable it in Settings first.');
  }
  return null;
}

export function registerMcpSyncRoutes(app: FastifyInstance): void {
  const run = async (req: FastifyRequest, reply: FastifyReply, apply: boolean): Promise<ApiResponse<McpSyncResult>> => {
    const denied = await gate(req);
    if (denied) {
      reply.code(403);
      return denied;
    }
    try {
      return { success: true, data: await syncMcpServers(await mcpSyncTargets(), { apply }, mcpUnsupportedLabels()) };
    } catch (err) {
      if (err instanceof McpSyncBusyError) {
        reply.code(409);
        return createErrorResponse(ApiErrorCode.CONFLICT, err.message);
      }
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  };
  app.get('/api/mcp-sync', (req, reply) => run(req, reply, false));
  app.post('/api/mcp-sync', (req, reply) => run(req, reply, true));
}
