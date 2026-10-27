/**
 * @fileoverview The Git panel's routes: `GET /api/sessions/:id/git-status` (what the session's workspace
 * has not committed or pushed, src/git-workspace-status.ts) and `POST /api/sessions/:id/git-fetch` (the
 * panel's Fetch button, src/git-fetch.ts), for the bottom-bar Git indicator and its window. The answer is
 * an overview: the enclosing repository, or each repository found below a folder that holds several
 * projects (see `getGitWorkspaceOverview` for exactly which).
 *
 * Read-only and offline: the status route never fetches and never runs a git write command. Fetching is a
 * separate, user-triggered path (`POST /api/sessions/:id/git-fetch`, src/git-fetch.ts) that the panel calls
 * only when the user clicks Fetch. A remote (SSH) or Docker session is not inspected and answers
 * `state: 'unsupported'` on both routes, and neither is any repository at or inside a Docker case
 * workspace (a container can write there, and git here would run on the host). Ownership goes through
 * `findSessionOrFail`, like every session-scoped route.
 */

import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { redactGitCredentials } from '../../git-clone.js';
import { emptyReport, fetchWorkspaceOnce, gitFetchStatusFrom, type GitFetchReport } from '../../git-fetch.js';
import { readDockerCasesOrThrow } from '../../docker-hosts.js';
import { getDataDir } from '../../config/instance.js';
import { findSessionOrFail, persistAndBroadcastSession } from '../route-helpers.js';
import {
  emptyOverview,
  findWorkspaceRepo,
  getGitFileDiff,
  resolveOverviewLimits,
  getGitWorkspaceOverview,
  getGitWorkspaceStatus,
  type GitFileDiff,
  type GitFileKind,
  type GitRunner,
  type GitWorkspaceOverview,
} from '../../git-workspace-status.js';
import type { EventPort, SessionPort } from '../ports/index.js';

/**
 * Host paths of every Docker case workspace: repositories at or inside these are never inspected.
 * Exported so the interval scheduler (src/git-fetch-scheduler.ts) uses the SAME list: the Docker rule has
 * to be one rule, checked by every path that could run git.
 *
 * REJECTS when `docker-cases.json` exists but cannot be read or parsed (its writer truncates and rewrites it
 * in place, so a read can land mid-write). The fetch paths fail closed on that: a fetch runs a repository's
 * own hooks, and without the list nothing tells which folders a container can write to. The read-only
 * status and diff routes read it as no Docker workspaces, as they always have.
 */
export const defaultDockerWorkspaces = async (): Promise<string[]> =>
  (await readDockerCasesOrThrow(getDataDir())).map((c) => c.hostWorkspacePath).filter(Boolean);

/** The read-only routes' reading of the list: unchanged, an unreadable list is no Docker workspaces. */
const dockerWorkspacesOrNone = (dockerWorkspaces: () => Promise<string[]>): Promise<string[]> =>
  dockerWorkspaces().catch(() => []);

/**
 * The repository limit and git timeout a request asks for (Settings → Bottom bar, per device):
 * `maxRepos` and `timeout` (seconds) query parameters, each clamped to a safe range, so an odd value
 * can never cost more than the module's own ceiling.
 */
function limitsFrom(query: { maxRepos?: unknown; timeout?: unknown }) {
  // A repeated key arrives as an array: it is not a number, so it means "default" like '' and absent.
  const timeout = typeof query.timeout === 'string' && query.timeout.trim() ? query.timeout : undefined;
  return resolveOverviewLimits({
    maxRepos: query.maxRepos,
    timeoutMs: timeout !== undefined ? Number(timeout) * 1000 : undefined,
  });
}

export function registerGitStatusRoutes(
  app: FastifyInstance,
  // EventPort as well as SessionPort: the fetch route publishes the run it did, and a route that broadcasts
  // has to say so in its own signature.
  ctx: SessionPort & EventPort,
  git?: GitRunner,
  dockerWorkspaces: () => Promise<string[]> = defaultDockerWorkspaces
): void {
  app.get('/api/sessions/:id/git-status', async (req): Promise<ApiResponse<GitWorkspaceOverview>> => {
    const { id } = req.params as { id: string };
    const query = req.query as { fresh?: string; maxRepos?: unknown; timeout?: unknown };
    const { fresh } = query;
    const limits = limitsFrom(query);
    const session = findSessionOrFail(ctx, id, req);
    if (session.remote) return { success: true, data: emptyOverview('unsupported', { reason: 'remote' }) };
    if (session.docker) return { success: true, data: emptyOverview('unsupported', { reason: 'docker' }) };
    return {
      success: true,
      data: await getGitWorkspaceOverview(session.workingDir, {
        git,
        fresh: fresh === '1',
        ...limits,
        dockerWorkspaces: await dockerWorkspacesOrNone(dockerWorkspaces),
      }),
    };
  });

  // The diff of one file the panel lists. `repo` and `path` are matched against the CURRENT status
  // (a repository this session's folder holds, a path git reported in it) rather than trusted, so
  // the route cannot be pointed at an arbitrary directory or file. The repository is checked against
  // the overview's own (cached) list with the Docker roots as they are now, and only that one
  // repository's status is refreshed: a click must not re-read every repository in the folder.
  app.get('/api/sessions/:id/git-diff', async (req, reply): Promise<ApiResponse<GitFileDiff>> => {
    const { id } = req.params as { id: string };
    const query = req.query as { repo?: string; path?: string; kind?: string; maxRepos?: unknown; timeout?: unknown };
    const { repo, path, kind } = query;
    const limits = limitsFrom(query);
    const session = findSessionOrFail(ctx, id, req);
    if (session.remote || session.docker) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Git is not available for remote or Docker sessions');
    }
    const repoRoot = repo
      ? await findWorkspaceRepo(session.workingDir, repo, {
          git,
          ...limits,
          dockerWorkspaces: await dockerWorkspacesOrNone(dockerWorkspaces),
        })
      : null;
    const status = repoRoot
      ? await getGitWorkspaceStatus(repoRoot, { git, fresh: true, timeoutMs: limits.timeoutMs })
      : null;
    const entry =
      status?.state === 'ok'
        ? status.files.find((f) => f.path === path && f.kind === (kind as GitFileKind))
        : undefined;
    if (!status?.repoRoot || !entry) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'That file has no outstanding change any more');
    }
    try {
      return {
        success: true,
        data: await getGitFileDiff(status.repoRoot, entry, { git, timeoutMs: limits.timeoutMs }),
      };
    } catch (err) {
      reply.code(500);
      return createErrorResponse(
        ApiErrorCode.INTERNAL_ERROR,
        `git diff failed: ${redactGitCredentials(getErrorMessage(err))}`
      );
    }
  });

  // Fetch, and only because the user clicked Fetch in the panel (src/git-fetch.ts): one
  // `git fetch --quiet` per repository the panel would show, through the same resolver so the two cannot
  // disagree about which repositories belong to the workspace. This is the only git command the Git panel runs
  // that writes, and it writes remote-tracking refs only: nothing commits, checks out or merges. Cloning and
  // worktree management write too, but those happen when the user asked for them; this route is the one that
  // can also run later, on a timer. It is not as harmless as a read though: a fetch holds git's ref lock, so
  // an agent's own `git pull` in the same clone can collide with it, which is why the run goes through
  // `fetchWorkspaceOnce`: a click while a tick is already fetching this folder joins that run instead of
  // starting a second one. It can also run a
  // repository's own hooks (`reference-transaction`, `pre-auto-gc` through the maintenance git runs after a
  // fetch) and its config commands such as `credential.helper`, so the `FETCH_CONFIG_ARGS` overrides turn
  // maintenance and gc off, and a repository a container can write to is refused before any git runs. Remote
  // and Docker sessions answer `unsupported` like the status route.
  app.post('/api/sessions/:id/git-fetch', async (req): Promise<ApiResponse<GitFetchReport>> => {
    const { id } = req.params as { id: string };
    const query = req.query as { maxRepos?: unknown; timeout?: unknown };
    const limits = limitsFrom(query);
    const session = findSessionOrFail(ctx, id, req);
    if (session.remote) return { success: true, data: emptyReport('unsupported', { reason: 'remote' }) };
    if (session.docker) return { success: true, data: emptyReport('unsupported', { reason: 'docker' }) };
    // Fail CLOSED on a Docker case list that cannot be read: a fetch runs the repository's hooks, so it never
    // runs without knowing which folders a container can write to. Answered as a failed run (`state: 'error'`),
    // published like one, so the Session Options Git row shows it.
    let dockerRoots: string[];
    try {
      dockerRoots = await dockerWorkspaces();
    } catch (err) {
      console.warn(`[git fetch] Docker case list unreadable, nothing fetched: ${getErrorMessage(err)}`);
      const report = emptyReport('error', {
        error:
          'Nothing was fetched: Codeman could not read its Docker case list (docker-cases.json), so it cannot tell which folders a container can write to.',
      });
      if (session.setGitFetchStatus(gitFetchStatusFrom(report, 'click'))) persistAndBroadcastSession(ctx, session);
      return { success: true, data: report };
    }
    const run = await fetchWorkspaceOnce(
      session.workingDir,
      { git, ...limits, dockerWorkspaces: dockerRoots },
      'click'
    );
    // The response answers the click, and the run is also the session's current truth: what the panel's
    // "behind" number is based on. Publishing it is what the api docs say a click does, and what makes a
    // second tab open on the same folder see the same run. The trigger recorded is the RUN's, not this
    // request's: a click that joined a tick already going fetched nothing itself, so the row has to name the
    // interval as what fetched.
    if (session.setGitFetchStatus(gitFetchStatusFrom(run.report, run.trigger)))
      persistAndBroadcastSession(ctx, session);
    return { success: true, data: run.report };
  });
}
