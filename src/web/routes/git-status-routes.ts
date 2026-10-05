/**
 * @fileoverview `GET /api/sessions/:id/git-status`: what the session's workspace has not committed or
 * pushed (src/git-workspace-status.ts), for the bottom-bar Git indicator and its panel. The answer is
 * an overview: the enclosing repository, or each repository found below a folder that holds several
 * projects (see `getGitWorkspaceOverview` for exactly which).
 *
 * Read-only and offline: it never fetches and never runs a git write command. A remote (SSH) or
 * Docker session is not inspected and answers `state: 'unsupported'`, and neither is any repository at or
 * inside a Docker case workspace (a container can write there, and git here would run on the host). Ownership goes through
 * `findSessionOrFail`, like every session-scoped route.
 */

import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { redactGitCredentials } from '../../git-clone.js';
import { readDockerCases } from '../../docker-hosts.js';
import { getDataDir } from '../../config/instance.js';
import { findSessionOrFail } from '../route-helpers.js';
import {
  emptyOverview,
  getGitFileDiff,
  getGitWorkspaceOverview,
  type GitFileDiff,
  type GitFileKind,
  type GitRunner,
  type GitWorkspaceOverview,
} from '../../git-workspace-status.js';
import type { SessionPort } from '../ports/index.js';

/** Host paths of every Docker case workspace: repositories at or inside these are never inspected. */
const defaultDockerWorkspaces = async (): Promise<string[]> =>
  (await readDockerCases(getDataDir()).catch(() => [])).map((c) => c.hostWorkspacePath).filter(Boolean);

export function registerGitStatusRoutes(
  app: FastifyInstance,
  ctx: SessionPort,
  git?: GitRunner,
  dockerWorkspaces: () => Promise<string[]> = defaultDockerWorkspaces
): void {
  app.get('/api/sessions/:id/git-status', async (req): Promise<ApiResponse<GitWorkspaceOverview>> => {
    const { id } = req.params as { id: string };
    const { fresh } = req.query as { fresh?: string };
    const session = findSessionOrFail(ctx, id, req);
    if (session.remote) return { success: true, data: emptyOverview('unsupported', { reason: 'remote' }) };
    if (session.docker) return { success: true, data: emptyOverview('unsupported', { reason: 'docker' }) };
    return {
      success: true,
      data: await getGitWorkspaceOverview(session.workingDir, {
        git,
        fresh: fresh === '1',
        dockerWorkspaces: await dockerWorkspaces(),
      }),
    };
  });

  // The diff of one file the panel lists. `repo` and `path` are matched against the CURRENT status
  // (a repository this session's folder holds, a path git reported in it) rather than trusted, so
  // the route cannot be pointed at an arbitrary directory or file.
  app.get('/api/sessions/:id/git-diff', async (req, reply): Promise<ApiResponse<GitFileDiff>> => {
    const { id } = req.params as { id: string };
    const { repo, path, kind } = req.query as { repo?: string; path?: string; kind?: string };
    const session = findSessionOrFail(ctx, id, req);
    if (session.remote || session.docker) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Git is not available for remote or Docker sessions');
    }
    const overview = await getGitWorkspaceOverview(session.workingDir, {
      git,
      fresh: true,
      dockerWorkspaces: await dockerWorkspaces(),
    });
    const status = overview.repos.find((r) => r.status.repoRoot === repo)?.status;
    const entry = status?.files.find((f) => f.path === path && f.kind === (kind as GitFileKind));
    if (!status?.repoRoot || !entry) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'That file has no outstanding change any more');
    }
    try {
      return { success: true, data: await getGitFileDiff(status.repoRoot, entry, { git }) };
    } catch (err) {
      reply.code(500);
      return createErrorResponse(
        ApiErrorCode.INTERNAL_ERROR,
        `git diff failed: ${redactGitCredentials(getErrorMessage(err))}`
      );
    }
  });
}
