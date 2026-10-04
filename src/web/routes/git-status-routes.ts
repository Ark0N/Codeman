/**
 * @fileoverview `GET /api/sessions/:id/git-status`: what the session's workspace has not committed or
 * pushed (src/git-workspace-status.ts), for the bottom-bar Git indicator and its panel. The answer is
 * an overview: the enclosing repository, or each repository found below a folder that holds several
 * projects (see `getGitWorkspaceOverview` for exactly which).
 *
 * Read-only and offline: it never fetches and never runs a git write command. A remote (SSH) or
 * Docker session is not inspected and answers `state: 'unsupported'`: a Docker workspace is writable
 * from inside the sandbox, and git here would run on the host. Ownership goes through
 * `findSessionOrFail`, like every session-scoped route.
 */

import type { FastifyInstance } from 'fastify';
import type { ApiResponse } from '../../types.js';
import { findSessionOrFail } from '../route-helpers.js';
import {
  emptyOverview,
  getGitWorkspaceOverview,
  type GitRunner,
  type GitWorkspaceOverview,
} from '../../git-workspace-status.js';
import type { SessionPort } from '../ports/index.js';

export function registerGitStatusRoutes(app: FastifyInstance, ctx: SessionPort, git?: GitRunner): void {
  app.get('/api/sessions/:id/git-status', async (req): Promise<ApiResponse<GitWorkspaceOverview>> => {
    const { id } = req.params as { id: string };
    const { fresh } = req.query as { fresh?: string };
    const session = findSessionOrFail(ctx, id, req);
    if (session.remote) return { success: true, data: emptyOverview('unsupported', { reason: 'remote' }) };
    if (session.docker) return { success: true, data: emptyOverview('unsupported', { reason: 'docker' }) };
    return { success: true, data: await getGitWorkspaceOverview(session.workingDir, { git, fresh: fresh === '1' }) };
  });
}
