/**
 * @fileoverview Git worktrees of a local case (src/git-worktrees.ts holds the rules):
 *
 *   GET    /api/cases/:name/worktrees             the case repository's worktrees, which of them
 *                                                 Codeman manages, and the live sessions in each
 *   POST   /api/cases/:name/worktrees             create `<case>/.claude/worktrees/<name>` on a
 *                                                 new branch (`{ name, branch?, base? }`)
 *   DELETE /api/cases/:name/worktrees/:worktree   `git worktree remove` WITHOUT --force, refused
 *                                                 while a live session runs inside; optional
 *                                                 `?deleteBranch=true` is `git branch -d`
 *
 * A session starts in a worktree through the EXISTING create paths, never a new spawn path here:
 * `POST /api/quick-start` with `worktree: <name>` (validated against this module's rules), or
 * `POST /api/sessions` with the worktree path as `workingDir`.
 *
 * The case is resolved the way quick-start resolves it: an owned remote or Docker case is refused
 * with a 400 (git must never run on the host over a Docker workspace, and a remote case's folder
 * is on another machine); a linked case resolves for admins only in multi-user mode; anything else
 * is the caller's own case space, confined with `isWorkingDirAllowed`. The case folder is probed
 * BOUNDED (#516): a case on a network mount that stopped answering is a 422, never a 404.
 *
 * Statuses are set explicitly from the error code, so the route answers the same with or without
 * the server's envelope hook.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, httpStatusForErrorCode, type ApiResponse } from '../../types.js';
import { readDockerCases } from '../../docker-hosts.js';
import { readRemoteCases } from '../../remote-hosts.js';
import { dataPath, getDataDir } from '../../config/instance.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { listClis } from '../../config/cli-registry/registry.js';
import { agentSkillDir } from '../../hooks-config.js';
import { describeUnknownPath, probePathKind } from '../../utils/index.js';
import {
  createCaseWorktree,
  isPathWithin,
  listCaseWorktrees,
  managedWorktreesDir,
  removeCaseWorktree,
  resolveCaseRepository,
  respellUnder,
  worktreeNameError,
  type CaseRepository,
  type CaseWorktree,
  type CreatedWorktree,
  type RemovedWorktree,
  type WorktreeFailure,
  type WorktreeGitRunner,
} from '../../git-worktrees.js';
import { CreateWorktreeSchema, RemoveWorktreeQuerySchema } from '../schemas.js';
import {
  canAccessOwned,
  getAuthUser,
  isAdmin,
  isWorkingDirAllowed,
  parseBody,
  readJsonConfig,
  resolveCasesDir,
  validatePathWithinBase,
} from '../route-helpers.js';
import type { SessionPort } from '../ports/index.js';

const SAFE_CASE_NAME = /^[a-zA-Z0-9_-]+$/;

/** Host paths of every Docker case workspace: git never runs for a case at or inside one. */
const defaultDockerWorkspaces = async (): Promise<string[]> =>
  (await readDockerCases(getDataDir()).catch(() => [])).map((c) => c.hostWorkspacePath).filter(Boolean);

/**
 * Every workspace skills folder a session of some registry CLI gets Codeman's agent skill in
 * (`capabilities.agentSkillDir`), read from the registry at call time as data, never by CLI id.
 */
const registryAgentSkillDirs = (): string[] => {
  const dirs = new Set<string>();
  for (const cli of listClis()) {
    const dir = agentSkillDir(cli.capabilities);
    if (dir) dirs.add(dir);
  }
  return [...dirs];
};

/** A live session in a worktree, as the list reports it to a caller who may see it. */
export interface WorktreeSessionRef {
  id: string;
  name: string;
}

/** One row of `GET /api/cases/:name/worktrees`. */
export interface CaseWorktreeInfo extends CaseWorktree {
  /** Live sessions running in this worktree (deepest worktree wins), all owners. */
  sessionCount: number;
  /** The ones the caller may see (all of them outside multi-user mode). */
  sessions: WorktreeSessionRef[];
}

export interface CaseWorktreeList {
  caseName: string;
  repoRoot: string;
  /** `<repo>/.claude/worktrees`, where Codeman creates and removes worktrees. */
  worktreesDir: string;
  worktrees: CaseWorktreeInfo[];
  truncated: boolean;
}

type Fail = ApiResponse<never>;

function failWith(reply: FastifyReply, code: ApiErrorCode, message: string): Fail {
  reply.code(httpStatusForErrorCode(code));
  return createErrorResponse(code, message);
}

function failFrom(reply: FastifyReply, failure: WorktreeFailure): Fail {
  return failWith(reply, ApiErrorCode[failure.code], failure.message);
}

/**
 * The LOCAL folder of case `name` for this caller, or the refusal. Mirrors quick-start's
 * resolution (remote, then Docker, then linked, then the caller's case space) so a name means
 * the same case here as it does to the Run button.
 */
async function resolveLocalCaseFolder(
  req: FastifyRequest,
  name: string
): Promise<{ ok: true; casePath: string } | { ok: false; code: ApiErrorCode; message: string }> {
  if (!SAFE_CASE_NAME.test(name)) {
    return { ok: false, code: ApiErrorCode.INVALID_INPUT, message: 'Invalid case name' };
  }
  const user = getAuthUser(req);
  const configDir = getDataDir();
  // Ownership folded into the match, as quick-start does: a foreign same-named remote/Docker
  // case falls through to the caller's own local case instead of shadowing it.
  if ((await readRemoteCases(configDir)).some((c) => c.name === name && canAccessOwned(user, c.owner))) {
    return {
      ok: false,
      code: ApiErrorCode.INVALID_INPUT,
      message: 'Worktrees are not available for remote (SSH) cases: the repository is on another machine.',
    };
  }
  if ((await readDockerCases(configDir)).some((c) => c.name === name && canAccessOwned(user, c.owner))) {
    return {
      ok: false,
      code: ApiErrorCode.INVALID_INPUT,
      message:
        'Worktrees are not available for Docker cases: a container can write to the workspace, and git would run its hooks and filters on this machine.',
    };
  }
  const linkedCases = await readJsonConfig<Record<string, string>>(dataPath('linked-cases.json'), 'linked cases', {});
  // Linked cases carry no owner: only admins resolve them in multi-user mode.
  const linked = !isMultiUserMode() || isAdmin(req) ? linkedCases[name] : undefined;
  const casePath = linked || validatePathWithinBase(name, resolveCasesDir(user));
  if (!casePath) return { ok: false, code: ApiErrorCode.INVALID_INPUT, message: 'Invalid case path' };
  if (!isWorkingDirAllowed(user, casePath)) {
    return { ok: false, code: ApiErrorCode.FORBIDDEN, message: 'case path is outside your workspace' };
  }
  const kind = await probePathKind(casePath, { pastCap: true });
  if (kind === 'unknown') {
    return {
      ok: false,
      code: ApiErrorCode.OPERATION_FAILED,
      message: describeUnknownPath('Case folder', casePath, { pastCap: true }),
    };
  }
  if (kind === 'absent') return { ok: false, code: ApiErrorCode.NOT_FOUND, message: `Case "${name}" not found` };
  if (kind !== 'directory')
    return { ok: false, code: ApiErrorCode.INVALID_INPUT, message: 'Case path is not a folder' };
  return { ok: true, casePath };
}

/**
 * Live local sessions, with the folder each runs in as the case's repository spells it
 * (`respellUnder`: a folder named through the case's own path, which can run through a symlink,
 * is moved onto the repository's real top level, where git lists the worktrees). Remote sessions
 * have no local folder.
 */
function liveLocalSessions(
  ctx: SessionPort,
  casePath: string,
  repoRoot: string
): Array<{ id: string; name: string; owner?: string; dir: string }> {
  const out: Array<{ id: string; name: string; owner?: string; dir: string }> = [];
  for (const session of ctx.sessions.values()) {
    if (session.remote || !session.workingDir || !session.workingDir.startsWith('/')) continue;
    const dir = respellUnder(session.workingDir, casePath, repoRoot);
    out.push({ id: session.id, name: session.name, owner: session.owner, dir });
  }
  return out;
}

export function registerWorktreeRoutes(
  app: FastifyInstance,
  ctx: SessionPort,
  deps: { git?: WorktreeGitRunner; dockerWorkspaces?: () => Promise<string[]> } = {}
): void {
  const dockerWorkspaces = deps.dockerWorkspaces ?? defaultDockerWorkspaces;

  /**
   * Case folder → its repository, or the refusal already rendered. `casePath` is the folder as
   * the case resolves it (possibly through a symlink); `repo.repoRoot` is its real path.
   */
  async function caseRepository(
    req: FastifyRequest,
    reply: FastifyReply,
    name: string
  ): Promise<{ ok: true; repo: CaseRepository; casePath: string; dockerRoots: string[] } | { ok: false; fail: Fail }> {
    const folder = await resolveLocalCaseFolder(req, name);
    if (!folder.ok) return { ok: false, fail: failWith(reply, folder.code, folder.message) };
    const dockerRoots = await dockerWorkspaces();
    const repo = await resolveCaseRepository(folder.casePath, { git: deps.git, dockerWorkspaces: dockerRoots });
    if (!repo.ok) return { ok: false, fail: failFrom(reply, repo) };
    return { ok: true, repo: repo.repo, casePath: folder.casePath, dockerRoots };
  }

  app.get('/api/cases/:name/worktrees', async (req, reply): Promise<ApiResponse<CaseWorktreeList>> => {
    const { name } = req.params as { name: string };
    const resolved = await caseRepository(req, reply, name);
    if (!resolved.ok) return resolved.fail;
    const { repo, casePath } = resolved;
    const listed = await listCaseWorktrees(repo, { git: deps.git });
    if (!listed.ok) return failFrom(reply, listed);

    // Each live session belongs to the DEEPEST worktree holding its folder, so a session in a
    // managed worktree is not also counted against the main checkout that contains it.
    const user = getAuthUser(req);
    const rows: CaseWorktreeInfo[] = listed.worktrees.map((wt) => ({ ...wt, sessionCount: 0, sessions: [] }));
    for (const session of liveLocalSessions(ctx, casePath, repo.repoRoot)) {
      let best: CaseWorktreeInfo | undefined;
      for (const row of rows) {
        if (!isPathWithin(session.dir, row.path)) continue;
        if (!best || row.path.length > best.path.length) best = row;
      }
      if (!best) continue;
      best.sessionCount += 1;
      if (canAccessOwned(user, session.owner)) best.sessions.push({ id: session.id, name: session.name });
    }
    return {
      success: true,
      data: {
        caseName: name,
        repoRoot: repo.repoRoot,
        worktreesDir: managedWorktreesDir(repo.repoRoot),
        worktrees: rows,
        truncated: listed.truncated,
      },
    };
  });

  app.post('/api/cases/:name/worktrees', async (req, reply): Promise<ApiResponse<{ worktree: CreatedWorktree }>> => {
    const { name } = req.params as { name: string };
    const body = parseBody(CreateWorktreeSchema, req.body);
    const nameError = worktreeNameError(body.name);
    if (nameError) return failWith(reply, ApiErrorCode.INVALID_INPUT, nameError);
    const resolved = await caseRepository(req, reply, name);
    if (!resolved.ok) return resolved.fail;
    const created = await createCaseWorktree(resolved.repo, body, {
      git: deps.git,
      agentSkillDirs: registryAgentSkillDirs(),
    });
    if (!created.ok) return failFrom(reply, created);
    reply.code(201);
    return { success: true, data: { worktree: created.worktree } };
  });

  app.delete(
    '/api/cases/:name/worktrees/:worktree',
    async (req, reply): Promise<ApiResponse<{ removed: RemovedWorktree }>> => {
      const { name, worktree } = req.params as { name: string; worktree: string };
      const query = parseBody(RemoveWorktreeQuerySchema, req.query ?? {});
      const nameError = worktreeNameError(worktree);
      if (nameError) return failWith(reply, ApiErrorCode.INVALID_INPUT, nameError);
      const resolved = await caseRepository(req, reply, name);
      if (!resolved.ok) return resolved.fail;
      const removed = await removeCaseWorktree(
        resolved.repo,
        {
          name: worktree,
          deleteBranch: query.deleteBranch === 'true' || query.deleteBranch === '1',
          // Any owner's session blocks: removing the folder under a running agent is the damage
          // this refusal exists to prevent, whoever started it.
          isInUse: (path) =>
            liveLocalSessions(ctx, resolved.casePath, resolved.repo.repoRoot).some((s) => isPathWithin(s.dir, path)),
        },
        // The worktree folder itself must not be (or hold) a Docker case workspace either.
        { git: deps.git, dockerWorkspaces: resolved.dockerRoots }
      );
      if (!removed.ok) return failFrom(reply, removed);
      return { success: true, data: { removed: removed.removed } };
    }
  );
}
