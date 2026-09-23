/**
 * @fileoverview Case management routes.
 * Handles CRUD for cases (directories under ~/codeman-cases and linked folders),
 * cloning a repository into a new case (`/api/cases/clone` + `/clone-preflight`,
 * issue #236 — the URL-safety rules live in `src/git-clone.ts`), fix-plan reading,
 * and ralph-wizard file serving.
 */

import { FastifyInstance } from 'fastify';
import { existsSync, lstatSync, mkdirSync, writeFileSync, readdirSync, readFileSync, createReadStream } from 'node:fs';
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type {
  AgentCaseSummary,
  ApiResponse,
  CaseInfo,
  DockerHost,
  RemoteSessionInfo,
  SessionDocker,
  SessionMode,
} from '../../types.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import {
  CreateCaseSchema,
  CloneCaseSchema,
  ClonePreflightSchema,
  LinkCaseSchema,
  CaseOrderSchema,
  RemoteCaseLinkSchema,
  RemoteHostSchema,
  DockerCaseLinkSchema,
  DockerCaseAdoptSchema,
  DockerAdoptPreflightSchema,
  DockerBrowseSchema,
  DockerHostSchema,
  DockerExportSchema,
  DockerImportSchema,
  DockerQuickCreateSchema,
} from '../schemas.js';
import { exportDockerCase, importDockerBundle, listDockerExports, exportBundleName } from '../../docker-export.js';
import {
  cloneRepository,
  isGitAvailable,
  isSafeGitRef,
  parseGitRepositoryUrl,
  probeGitRemote,
} from '../../git-clone.js';
import type { GitRemoteProbe, GitUrlParse } from '../../git-clone.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { readAgentCaseMarker, type AgentCaseMarker } from '../../agent-case-marker.js';
import { settingsWriteBlocker, writeHooksConfig } from '../../hooks-config.js';
import {
  canAccessOwned,
  getAuthUser,
  isAdmin,
  isWorkingDirAllowed,
  ownerFor,
  resolveCasesDir,
  SETTINGS_PATH,
  validatePathWithinBase,
  parseBody,
  readJsonConfig,
} from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import type { AuthUser } from '../../types.js';
import { SseEvent } from '../sse-events.js';
import type { EventPort, ConfigPort, SessionPort } from '../ports/index.js';
import type { FastifyRequest } from 'fastify';
import { dataPath, getDataDir } from '../../config/instance.js';
import {
  checkDockerAvailable,
  checkDockerImagePresent,
  checkDockerTmuxAvailable,
  ensureAgentBaseImage,
  DEFAULT_AGENT_IMAGE,
  dockerContainerName,
  dockerDisplayPath,
  probeAdoptableContainer,
  classifyAdoptContainerConflict,
  listDockerContainers,
  browseInContainer,
  dockerAdoptProbeModes,
  readDockerCases,
  readDockerHosts,
  removeDockerContainer,
  toSessionDocker,
  writeDockerCases,
  writeDockerHosts,
} from '../../docker-hosts.js';
import type { AdoptedContainerProbe, DockerBrowseResult, DockerContainerInfo } from '../../docker-hosts.js';
import { buildDockerRemoveCommand } from '../../tmux-manager.js';
import {
  checkRemoteTmuxAvailable,
  listRemoteCodemanSessions,
  readRemoteCases,
  readRemoteHosts,
  remoteDisplayPath,
  writeRemoteCases,
  writeRemoteHosts,
} from '../../remote-hosts.js';

const LINKED_CASES_FILE = dataPath('linked-cases.json');
const CODEMAN_CONFIG_DIR = getDataDir();
const SAFE_CASE_NAME = /^[a-zA-Z0-9_-]+$/;
const DOCKER_EXPORTS_DIR = dataPath('docker-exports');
/** Auto-created host profile for the one-click "Run in Docker" case flow. */
const DEFAULT_DOCKER_HOST_ID = 'default';

/** App version for export manifests (best-effort read of package.json). */
const APP_VERSION = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')).version as string) || 'unknown';
  } catch {
    return 'unknown';
  }
})();

/**
 * Refusal text for a `local`-transport clone by a non-admin in multi-user mode.
 * Per-user case spaces live inside one $HOME, so cloning from an absolute path
 * would copy another user's workspace into the caller's own (the same escape
 * `/api/cases/link` is admin-only for).
 */
const LOCAL_CLONE_ADMIN_ONLY =
  'Cloning from a local path is admin-only in multi-user mode. Use a repository URL instead.';

/**
 * Whether a clone or preflight must run with git's credential helpers cleared:
 * a non-admin in multi-user mode. Every user's git runs as the one server
 * account, so its helpers (the Docker image's opt-in `gh`/`az` ones, or any
 * `gh auth setup-git`) would otherwise read a private repository with the
 * signed-in admin's credentials, the same boundary the local-transport rule
 * above guards. Admins and single-user mode keep the account's own helpers.
 */
export function cloneWithoutCredentialHelpers(req: FastifyRequest): boolean {
  return isMultiUserMode() && !isAdmin(req);
}

/**
 * The one line of git's stderr worth appending to an error message.
 *
 * NOT the first line: `git clone` opens with "Cloning into '<dest>'…", so a naive
 * first-line pick reported the destination path as the reason a bad branch failed
 * (observed against a real remote). Prefer the LAST diagnostic line
 * (`fatal:`/`error:`/`remote:`), which is where git puts the actual cause.
 */
function gitDiagnosticLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const line = [...lines].reverse().find((l) => /^(fatal|error|remote|warning):/i.test(l)) ?? lines.at(-1) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Does the freshly cloned tree carry its own Claude settings? Those can contain
 * hooks, which run on the user's machine when a session starts in the case, so
 * the clone response says so out loud instead of silently merging into them.
 */
function repoShipsClaudeSettings(casePath: string): boolean {
  return ['settings.json', 'settings.local.json'].some((file) => existsSync(join(casePath, '.claude', file)));
}

/**
 * Project a case's marker onto the wire shape `CaseInfo.agentCreated` carries.
 * `owner` stays server-side: the listings are already owner-scoped, and it is not
 * something the case list needs to publish.
 */
function agentCreatedInfo(marker: AgentCaseMarker): NonNullable<CaseInfo['agentCreated']> {
  return {
    createdAt: marker.createdAt,
    createdBy: marker.createdBy,
    ...(marker.parentSessionId ? { parentSessionId: marker.parentSessionId } : {}),
    ...(marker.parentSessionName ? { parentSessionName: marker.parentSessionName } : {}),
    ...(marker.mode ? { mode: marker.mode } : {}),
  };
}

/** Read and parse linked-cases.json, returning empty object on missing/invalid file. */
async function readLinkedCases(): Promise<Record<string, string>> {
  return readJsonConfig<Record<string, string>>(LINKED_CASES_FILE, 'linked cases', {});
}

/**
 * Resolve a case name to its directory path, checking linked cases first, then the
 * user's case space (per-user in multi-user mode, the shared CASES_DIR otherwise).
 */
async function resolveCasePath(name: string, user?: AuthUser): Promise<string> {
  const linkedCases = await readLinkedCases();
  // Linked cases carry no owner (legacy/admin-only registry): a non-admin must not
  // resolve arbitrary linked paths by name in multi-user mode (path-escape guard).
  if (linkedCases[name] && (!isMultiUserMode() || user?.role === 'admin')) return linkedCases[name];
  return join(resolveCasesDir(user), name);
}

/**
 * Gate a docker case on its base image, AUTO-BUILDING the default image on first
 * use so a missing image is never a blocker (the user's ask: "create it when it's
 * used for the first time"). Present image → verify tmux (hard prerequisite).
 * Default image missing → kick off a BACKGROUND build with SSE progress and return
 * `imageBuilding: true` (the case is created regardless; first launch awaits the
 * same dedup'd build). Custom image missing → a real error (we can't build a
 * foreign ref, and `--pull=never` forbids pulling).
 */
async function ensureCaseImage(
  broadcast: EventPort['broadcast'],
  sessionDocker: SessionDocker,
  name: string
): Promise<{ ok: true; imageBuilding: boolean } | { ok: false; error: string }> {
  if (await checkDockerImagePresent(sessionDocker, sessionDocker.image)) {
    const tmuxCheck = await checkDockerTmuxAvailable(sessionDocker);
    if (!tmuxCheck.ok) return { ok: false, error: tmuxCheck.error || 'base image is missing tmux' };
    return { ok: true, imageBuilding: false };
  }
  if (sessionDocker.image !== DEFAULT_AGENT_IMAGE) {
    return {
      ok: false,
      error: `base image ${sessionDocker.image} not present; only ${DEFAULT_AGENT_IMAGE} is auto-built. Build or pull it first.`,
    };
  }
  broadcast(SseEvent.DockerImageBuildStarted, { name, image: sessionDocker.image });
  void ensureAgentBaseImage(sessionDocker, sessionDocker.image, {
    onProgress: (line) => broadcast(SseEvent.DockerImageBuildProgress, { name, line }),
  })
    .then((r) =>
      broadcast(r.ok ? SseEvent.DockerImageBuildComplete : SseEvent.DockerImageBuildFailed, {
        name,
        image: sessionDocker.image,
        error: r.error,
      })
    )
    .catch((err) =>
      broadcast(SseEvent.DockerImageBuildFailed, { name, image: sessionDocker.image, error: getErrorMessage(err) })
    );
  return { ok: true, imageBuilding: true };
}

export function registerCaseRoutes(app: FastifyInstance, ctx: EventPort & ConfigPort & SessionPort): void {
  // ═══════════════════════════════════════════════════════════════
  // Case CRUD (list, create, link, detail, fix-plan)
  // ═══════════════════════════════════════════════════════════════

  // ========== List Cases ==========

  app.get('/api/cases', async (req): Promise<CaseInfo[]> => {
    const cases: CaseInfo[] = [];
    const user = getAuthUser(req);
    const admin = isAdmin(req);
    // Non-admins enumerate their OWN case space; admins see the shared CASES_DIR.
    const listBase = resolveCasesDir(user);

    // Get cases from the user's (or shared) cases dir
    try {
      const entries = await fs.readdir(listBase, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && SAFE_CASE_NAME.test(e.name)) {
          const casePath = join(listBase, e.name);
          // Only a directory Codeman scaffolded for an agent spawn carries a marker,
          // so this stays absent for every human-created, linked or cloned case.
          const marker = await readAgentCaseMarker(casePath);
          cases.push({
            name: e.name,
            path: casePath,
            hasClaudeMd: existsSync(join(casePath, 'CLAUDE.md')),
            location: 'local',
            ...(marker ? { agentCreated: agentCreatedInfo(marker) } : {}),
          });
        }
      }
    } catch {
      // dir may not exist yet
    }

    // Linked cases (v1 registry has no owner) are admin-only in multi-user mode.
    const linkedCases = await readLinkedCases();
    const existingNames = new Set(cases.map((c) => c.name));
    if (admin) {
      for (const [name, path] of Object.entries(linkedCases)) {
        if (!existingNames.has(name) && SAFE_CASE_NAME.test(name) && existsSync(path)) {
          cases.push({
            name,
            path,
            hasClaudeMd: existsSync(join(path, 'CLAUDE.md')),
            linked: true,
            location: 'linked-local',
          });
        }
      }
    }

    // Get remote cases (owner-scoped; legacy no-owner = admin-only)
    const remoteHosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    const remoteHostMap = new Map(remoteHosts.map((host) => [host.id, host]));
    for (const remoteCase of await readRemoteCases(CODEMAN_CONFIG_DIR)) {
      const host = remoteHostMap.get(remoteCase.hostId);
      if (!host || !SAFE_CASE_NAME.test(remoteCase.name)) continue;
      if (!admin && !canAccessOwned(user, remoteCase.owner)) continue;
      existingNames.add(remoteCase.name);
      const remoteCaseInfo: CaseInfo = {
        name: remoteCase.name,
        path: remoteDisplayPath({ username: host.username, host: host.host, path: remoteCase.remotePath }),
        hasClaudeMd: false,
        location: 'remote',
        remote: {
          hostId: host.id,
          host: host.host,
          username: host.username,
          path: remoteCase.remotePath,
        },
      };
      const existingIndex = cases.findIndex((item) => item.name === remoteCase.name);
      if (existingIndex === -1) {
        cases.push(remoteCaseInfo);
      } else {
        cases[existingIndex] = remoteCaseInfo;
      }
    }

    // Get docker cases
    const dockerHosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    const dockerHostMap = new Map(dockerHosts.map((host) => [host.id, host]));
    for (const dockerCase of await readDockerCases(CODEMAN_CONFIG_DIR)) {
      const host = dockerHostMap.get(dockerCase.hostId);
      if (!host || !SAFE_CASE_NAME.test(dockerCase.name)) continue;
      if (!admin && !canAccessOwned(user, dockerCase.owner)) continue;
      existingNames.add(dockerCase.name);
      const container = dockerCase.container ?? dockerContainerName(dockerCase.name);
      const dockerCaseInfo: CaseInfo = {
        name: dockerCase.name,
        path: dockerDisplayPath({ container, path: dockerCase.hostWorkspacePath }),
        hasClaudeMd: existsSync(join(dockerCase.hostWorkspacePath, 'CLAUDE.md')),
        location: 'docker',
        docker: {
          hostId: host.id,
          container,
          image: host.image,
          path: dockerCase.hostWorkspacePath,
          containerWorkdir: dockerCase.containerWorkdir ?? dockerCase.hostWorkspacePath,
          network: host.network ?? 'bridge',
          ...(dockerCase.availableModes ? { availableModes: dockerCase.availableModes } : {}),
          ...(dockerCase.owned === false ? { owned: false } : {}),
        },
      };
      const existingIndex = cases.findIndex((item) => item.name === dockerCase.name);
      if (existingIndex === -1) {
        cases.push(dockerCaseInfo);
      } else {
        cases[existingIndex] = dockerCaseInfo;
      }
    }

    // Sort by persisted caseOrder from settings.json
    const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings', {});
    const caseOrder = Array.isArray(settings.caseOrder) ? (settings.caseOrder as string[]) : [];
    if (caseOrder.length > 0) {
      const orderMap = new Map(caseOrder.map((name, idx) => [name, idx]));
      cases.sort((a, b) => {
        const ai = orderMap.get(a.name) ?? Number.MAX_SAFE_INTEGER;
        const bi = orderMap.get(b.name) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
    }

    return cases;
  });

  // ========== Agent-created cases (cleanup listing) ==========

  /**
   * The scratch workspaces agent workers left behind, newest first.
   *
   * A long orchestration creates one case directory per worker, and deleting the
   * sessions does not remove them, so without this the only way to tell an agent's
   * `alpha`/`beta` from a real project was to remember which was which. Reads the same
   * marker `GET /api/cases` exposes and adds the two facts a human needs before
   * deleting a directory: whether a live session is still working in it, and when it
   * was last touched.
   *
   * ⚠️ Read-only on purpose: removal goes through the existing `DELETE /api/cases/:name`,
   * one name at a time, so this file keeps exactly one recursive-delete path. Scoped by
   * construction — it only ever walks the caller's own case space.
   */
  app.get('/api/cases/agent-created', async (req): Promise<ApiResponse<{ cases: AgentCaseSummary[] }>> => {
    const user = getAuthUser(req);
    const listBase = resolveCasesDir(user);
    const inUsePaths = new Set(
      Array.from(ctx.sessions.values())
        .filter((session) => canAccessOwned(user, session.owner))
        .map((session) => session.workingDir)
    );

    let entries;
    try {
      entries = await fs.readdir(listBase, { withFileTypes: true });
    } catch {
      return { success: true, data: { cases: [] } }; // case space not created yet
    }

    const summaries: AgentCaseSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_CASE_NAME.test(entry.name)) continue;
      const casePath = join(listBase, entry.name);
      const marker = await readAgentCaseMarker(casePath);
      if (!marker) continue;
      const modifiedAt = await fs
        .stat(casePath)
        .then((stat) => stat.mtime.toISOString())
        .catch(() => undefined);
      summaries.push({
        name: entry.name,
        path: casePath,
        ...agentCreatedInfo(marker),
        inUse: inUsePaths.has(casePath),
        ...(modifiedAt ? { modifiedAt } : {}),
      });
    }

    summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { success: true, data: { cases: summaries } };
  });

  app.post('/api/cases', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    const { name, description } = parseBody(CreateCaseSchema, req.body);

    const casePath = validatePathWithinBase(name, resolveCasesDir(getAuthUser(req)));
    if (!casePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
    }

    if (existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    try {
      mkdirSync(casePath, { recursive: true });
      mkdirSync(join(casePath, 'src'), { recursive: true });

      // Read settings to get custom template path
      const templatePath = await ctx.getDefaultClaudeMdPath();
      const claudeMd = generateClaudeMd(name, description || '', templatePath);
      writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

      // Write .claude/settings.local.json with hooks for desktop notifications
      await writeHooksConfig(casePath);

      ctx.broadcast(SseEvent.CaseCreated, { name, path: casePath });

      return { success: true, data: { case: { name, path: casePath } } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Clone a repository as a case (issue #236) ==========

  /**
   * Ask a remote what it has, without cloning anything.
   *
   * Two jobs: tell the user whether the URL they typed can be cloned *anonymously*
   * (Codeman supplies no credentials, so "private" and "typo" both have to be
   * distinguishable from "fine"), and hand back the branch/tag lists so the ref
   * field is a picker instead of a guess.
   *
   * Always 200 with `reachable: false` on a dead remote — an unreachable URL is a
   * normal answer to a preflight, not a server error, and the UI renders the reason.
   */
  app.post(
    '/api/cases/clone-preflight',
    async (
      req,
      reply
    ): Promise<ApiResponse<{ parse: GitUrlParse; remote?: GitRemoteProbe; gitAvailable: boolean }>> => {
      const { repository } = parseBody(ClonePreflightSchema, req.body);
      const parsed = parseGitRepositoryUrl(repository);
      if (!parsed.cloneable) {
        return { success: true, data: { parse: parsed, gitAvailable: isGitAvailable() } };
      }
      if (parsed.transport === 'local' && isMultiUserMode() && !isAdmin(req)) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.FORBIDDEN, LOCAL_CLONE_ADMIN_ONLY);
      }
      if (!isGitAvailable()) {
        return { success: true, data: { parse: parsed, gitAvailable: false } };
      }
      const remote = await probeGitRemote(parsed.repository, undefined, {
        withoutCredentialHelpers: cloneWithoutCredentialHelpers(req),
      });
      return { success: true, data: { parse: parsed, remote, gitAvailable: true } };
    }
  );

  /**
   * Clone a repository into the caller's case space and register it as a normal
   * local case (issue #236).
   *
   * SYNCHRONOUS by design for v1: the request stays open for the whole clone
   * (bounded by `GIT_CLONE_TIMEOUT_MS`), so there is no job store, no polling and
   * no cancellation surface to get wrong. The `case:created` broadcast is what
   * makes that safe behind a proxy with its own idle timeout — a client whose
   * request died mid-clone still sees the case appear over SSE when git finishes.
   *
   * Deliberately NOT admin-gated in multi-user mode: unlike `/api/cases/link`,
   * this writes only inside the caller's own `resolveCasesDir`. Two things would
   * otherwise read through that boundary: a `local`-transport source (refused for
   * non-admins) and the server account's git credential helpers, which every user
   * shares (cleared for non-admins, see `cloneWithoutCredentialHelpers`).
   *
   * Repository contents win over scaffolding: an existing CLAUDE.md is left
   * alone, and hooks are MERGED into whatever `.claude/settings.local.json` the
   * repo ships (`writeHooksConfig` preserves non-Codeman handlers). A repo that
   * ships its own hooks is reported back as a warning, because those run on the
   * user's machine the moment a session starts in the case.
   */
  app.post(
    '/api/cases/clone',
    async (
      req,
      reply
    ): Promise<
      ApiResponse<{
        case: { name: string; path: string };
        repository: string;
        ref?: string;
        provider: string;
        warnings: string[];
      }>
    > => {
      const { name, repository, ref, shallow, description } = parseBody(CloneCaseSchema, req.body);
      const user = getAuthUser(req);

      const parsed = parseGitRepositoryUrl(repository);
      if (!parsed.cloneable) return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.message);
      if (ref && !isSafeGitRef(ref)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid branch or tag name');
      }
      if (parsed.transport === 'local' && isMultiUserMode() && !isAdmin(req)) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.FORBIDDEN, LOCAL_CLONE_ADMIN_ONLY);
      }
      if (!isGitAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'git is not installed on this machine (or not on the server’s PATH).'
        );
      }

      const casesDir = resolveCasesDir(user);
      const casePath = validatePathWithinBase(name, casesDir);
      if (!casePath) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');

      // Reject a duplicate name across EVERY case kind before invoking git, so a
      // clone can never be the thing that discovers the collision (it would have
      // spent minutes of network first, and git's own error is about a directory).
      const linkedCases = await readLinkedCases();
      const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
      const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
      if (
        existsSync(casePath) ||
        linkedCases[name] ||
        dockerCases.some((item) => item.name === name) ||
        remoteCases.some((item) => item.name === name)
      ) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
      }

      // git creates the leaf, not necessarily the case space above it.
      try {
        mkdirSync(casesDir, { recursive: true });
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }

      const clone = await cloneRepository({
        repository: parsed.repository,
        destination: casePath,
        withoutCredentialHelpers: cloneWithoutCredentialHelpers(req),
        ...(ref ? { ref } : {}),
        ...(shallow ? { shallow: true } : {}),
      });
      if (!clone.ok) {
        const code =
          clone.failure.code === 'NOT_FOUND'
            ? ApiErrorCode.NOT_FOUND
            : clone.failure.code === 'DESTINATION_EXISTS'
              ? ApiErrorCode.ALREADY_EXISTS
              : clone.failure.code === 'REF_NOT_FOUND'
                ? ApiErrorCode.INVALID_INPUT
                : clone.failure.code === 'BUSY'
                  ? ApiErrorCode.RATE_LIMITED
                  : ApiErrorCode.OPERATION_FAILED;
        const detail = clone.failure.stderr
          ? `${clone.failure.message} (${gitDiagnosticLine(clone.failure.stderr)})`
          : clone.failure.message;
        return createErrorResponse(code, detail);
      }

      // Scaffold WITHOUT overwriting anything the repository shipped, and
      // WITHOUT writing through anything it shipped as a symlink.
      const warnings = [...parsed.warnings];
      try {
        // Presence via lstat, not existsSync: a repo-shipped CLAUDE.md SYMLINK
        // counts as "the repository ships its own" even when the link is
        // broken (existsSync follows links and reports a broken one as
        // absent), because writeFileSync would write THROUGH it to a
        // repository-chosen path outside the case.
        if (!lstatSync(join(casePath, 'CLAUDE.md'), { throwIfNoEntry: false })) {
          const templatePath = await ctx.getDefaultClaudeMdPath();
          const summary = description || `Cloned from ${parsed.repository}`;
          writeFileSync(join(casePath, 'CLAUDE.md'), generateClaudeMd(name, summary, templatePath));
        } else {
          warnings.push('Kept the repository’s own CLAUDE.md.');
        }
        if (repoShipsClaudeSettings(casePath)) {
          warnings.push(
            'This repository ships its own .claude/settings files. Codeman merged its hooks alongside them without removing anything — review them before starting a session, since repo-supplied hooks run on this machine.'
          );
        }
        // A repository can ship `.claude` (or the settings file) as a symlink
        // pointing anywhere on this machine; writeHooksConfig itself refuses
        // to write through those (settingsWriteBlocker in hooks-config.ts).
        // Checking here too turns that refusal into a user-visible warning.
        const hooksBlocker = await settingsWriteBlocker(casePath);
        if (hooksBlocker) {
          warnings.push(
            `Codeman hooks were NOT installed: ${hooksBlocker}. Codeman refuses to write through repository-controlled links; replace the link with a real file or directory if you want hooks in this case.`
          );
        } else {
          await writeHooksConfig(casePath);
        }
      } catch (err) {
        // The clone itself succeeded: keep the case and report the scaffolding
        // problem, rather than deleting a tree the user just waited for.
        warnings.push(`Case scaffolding was incomplete: ${getErrorMessage(err)}`);
      }

      ctx.broadcast(SseEvent.CaseCreated, { name, path: casePath });
      return {
        success: true,
        data: {
          case: { name, path: casePath },
          repository: parsed.repository,
          ...(ref ? { ref } : {}),
          provider: parsed.provider,
          warnings,
        },
      };
    }
  );

  // Hosts are machine-level infra config (ssh users/identity paths): non-admins get an
  // empty list in multi-user mode, matching the admin-only write side. No-op otherwise.
  app.get('/api/remote-hosts', async (req) =>
    isMultiUserMode() && !isAdmin(req) ? [] : readRemoteHosts(CODEMAN_CONFIG_DIR)
  );

  // Hosts are machine-level resources: only admins may define them in multi-user mode.
  const adminOnly = (req: FastifyRequest, reply: { code: (n: number) => unknown }): ApiResponse<never> | null =>
    isAdmin(req)
      ? null
      : (reply.code(403), createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode'));

  // COD-105 — discover `codeman-*` tmux sessions already running on a remote
  // host (created by the remote's own Codeman, another instance, or this one)
  // so the operator can attach to one this Codeman didn't launch. Explicit
  // trigger only (Decision A): the frontend calls this on a "Discover" click,
  // never automatically on host select. listRemoteCodemanSessions never throws
  // (returns [] on unreachable/no-tmux/no-sessions) and is ssh-guarded under test.
  // Hosts are admin-only infra in multi-user mode, so discovery is too.
  app.get(
    '/api/remote-hosts/:hostId/sessions',
    async (req, reply): Promise<ApiResponse<{ sessions: RemoteSessionInfo[] }>> => {
      const denied = adminOnly(req, reply);
      if (denied) return denied;
      const { hostId } = req.params as { hostId: string };
      const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
      const sessions = await listRemoteCodemanSessions(host);
      return { success: true, data: { sessions } };
    }
  );

  app.post('/api/remote-hosts', async (req, reply): Promise<ApiResponse<{ host: unknown }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const host = parseBody(RemoteHostSchema, req.body);
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    if (hosts.some((item) => item.id === host.id)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Remote host already exists');
    }
    await writeRemoteHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
    return { success: true, data: { host } };
  });

  app.put('/api/remote-hosts/:id', async (req, reply): Promise<ApiResponse<{ host: unknown }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const host = parseBody(RemoteHostSchema, { ...(req.body as object), id });
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    const index = hosts.findIndex((item) => item.id === id);
    if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
    const next = [...hosts];
    next[index] = host;
    await writeRemoteHosts(CODEMAN_CONFIG_DIR, next);
    return { success: true, data: { host } };
  });

  app.delete('/api/remote-hosts/:id', async (req, reply): Promise<ApiResponse<{ id: string }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const cases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    if (cases.some((item) => item.hostId === id)) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Remote host is still used by remote cases');
    }
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    await writeRemoteHosts(
      CODEMAN_CONFIG_DIR,
      hosts.filter((item) => item.id !== id)
    );
    return { success: true, data: { id } };
  });

  app.post('/api/cases/remote-link', async (req): Promise<ApiResponse<{ case: unknown }>> => {
    const remoteCase = { ...parseBody(RemoteCaseLinkSchema, req.body), type: 'remote' as const, owner: ownerFor(req) };
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    const host = hosts.find((item) => item.id === remoteCase.hostId);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');

    const linkedCases = await readLinkedCases();
    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    if (
      remoteCases.some((item) => item.name === remoteCase.name) ||
      linkedCases[remoteCase.name] ||
      existsSync(join(resolveCasesDir(getAuthUser(req)), remoteCase.name))
    ) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    // Courtesy validation: tmux is a hard prerequisite for durable remote sessions.
    // Verify it up-front so linking surfaces a clear error now instead of a dead pane
    // at first launch (also confirms the SSH connection actually works).
    const tmuxCheck = await checkRemoteTmuxAvailable(host);
    if (!tmuxCheck.ok) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, tmuxCheck.error || 'remote host is missing tmux');
    }

    await writeRemoteCases(CODEMAN_CONFIG_DIR, [...remoteCases, remoteCase]);
    ctx.broadcast(SseEvent.CaseLinked, { name: remoteCase.name, path: remoteCase.remotePath, type: 'remote' });
    return { success: true, data: { case: remoteCase } };
  });

  // ========== Docker hosts + docker cases (COD-Docker) ==========

  // Hosts are machine-level infra config (images/mounts/env): non-admins get an empty
  // list in multi-user mode, matching the admin-only write side. No-op otherwise.
  app.get('/api/docker-hosts', async (req) =>
    isMultiUserMode() && !isAdmin(req) ? [] : readDockerHosts(CODEMAN_CONFIG_DIR)
  );

  app.post('/api/docker-hosts', async (req, reply): Promise<ApiResponse<{ host: unknown }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const host = parseBody(DockerHostSchema, req.body);
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    if (hosts.some((item) => item.id === host.id)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Docker host already exists');
    }
    await writeDockerHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
    return { success: true, data: { host } };
  });

  app.put('/api/docker-hosts/:id', async (req, reply): Promise<ApiResponse<{ host: unknown }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const host = parseBody(DockerHostSchema, { ...(req.body as object), id });
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    const index = hosts.findIndex((item) => item.id === id);
    if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
    const next = [...hosts];
    next[index] = host;
    await writeDockerHosts(CODEMAN_CONFIG_DIR, next);
    return { success: true, data: { host } };
  });

  app.delete('/api/docker-hosts/:id', async (req, reply): Promise<ApiResponse<{ id: string }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const cases = await readDockerCases(CODEMAN_CONFIG_DIR);
    if (cases.some((item) => item.hostId === id)) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Docker host is still used by docker cases');
    }
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    await writeDockerHosts(
      CODEMAN_CONFIG_DIR,
      hosts.filter((item) => item.id !== id)
    );
    return { success: true, data: { id } };
  });

  app.post(
    '/api/cases/docker-link',
    async (
      req
    ): Promise<
      ApiResponse<{ case: unknown; capsEnforced?: boolean; isDesktop?: boolean; imageBuilding?: boolean }>
    > => {
      const dockerCase = {
        ...parseBody(DockerCaseLinkSchema, req.body),
        type: 'docker' as const,
        owner: ownerFor(req),
      };
      const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
      const host = hosts.find((item) => item.id === dockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');

      const linkedCases = await readLinkedCases();
      const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
      if (
        dockerCases.some((item) => item.name === dockerCase.name) ||
        linkedCases[dockerCase.name] ||
        existsSync(join(resolveCasesDir(getAuthUser(req)), dockerCase.name))
      ) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
      }

      // Confine the bind-mounted workspace to the caller's own space BEFORE creating it
      // (also removes the arbitrary-dir-creation primitive). No-op for admins/single-user.
      if (!isWorkingDirAllowed(getAuthUser(req), dockerCase.hostWorkspacePath)) {
        return createErrorResponse(ApiErrorCode.FORBIDDEN, 'hostWorkspacePath is outside your workspace');
      }

      // The workspace is a REAL host directory (bind-mounted into the container), so
      // create it now if missing. Scaffolding (.claude/settings.local.json + CLAUDE.md)
      // is written by quick-start on first launch, matching local-case behaviour.
      if (!existsSync(dockerCase.hostWorkspacePath)) {
        try {
          mkdirSync(dockerCase.hostWorkspacePath, { recursive: true });
        } catch (err) {
          return createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            `Could not create workspace: ${getErrorMessage(err)}`
          );
        }
      }

      // Courtesy validation: docker daemon must be reachable. The base image is
      // auto-built on first use (default image) rather than being a link-time
      // blocker, so a missing image kicks off a background build instead of erroring.
      const availability = await checkDockerAvailable(host.engine);
      if (!availability.ok) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          availability.error || 'docker daemon is not available'
        );
      }
      const imageGate = await ensureCaseImage(ctx.broadcast, toSessionDocker(host, dockerCase), dockerCase.name);
      if (!imageGate.ok) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, imageGate.error);
      }

      await writeDockerCases(CODEMAN_CONFIG_DIR, [...dockerCases, dockerCase]);
      ctx.broadcast(SseEvent.CaseLinked, {
        name: dockerCase.name,
        path: dockerCase.hostWorkspacePath,
        type: 'docker',
      });
      return {
        success: true,
        data: {
          case: dockerCase,
          capsEnforced: availability.capsEnforced,
          isDesktop: availability.isDesktop,
          imageBuilding: imageGate.imageBuilding,
        },
      };
    }
  );

  /**
   * ADOPT an already-running container (`owned: false`). The mirror of the
   * remote-SSH attach path: Codeman execs into a container the user built and
   * runs, and never creates, starts, stops, restarts or removes it.
   *
   * Everything here is read-only toward the container. The preflight refuses at
   * LINK time — missing, stopped, or no tmux inside — because the alternative is
   * failing at session launch, where the only ways out would be a dead pane or
   * starting a container we do not own. There is no image gate and no
   * `ensureCaseImage`: adoption never runs `docker create`, so the container's
   * image is the user's business.
   */
  app.post(
    '/api/cases/docker-adopt',
    async (req, reply): Promise<ApiResponse<{ case: unknown; image?: string; availableModes?: SessionMode[] }>> => {
      // ⚠️ Admin-only in multi-user mode, unlike `docker-link` right above. Linking
      // creates OUR container, whose only bind mount is a workspace `isWorkingDirAllowed`
      // has already confined. Adoption names a container someone else built, and its
      // mounts are whatever its owner gave it — a container mounting `/` hands the
      // adopter a shell over the whole host, which is exactly the workspace scoping this
      // mode exists to enforce. Same machine-level reasoning as the docker HOST routes.
      const denied = adminOnly(req, reply);
      if (denied) return denied;
      const dockerCase = {
        ...parseBody(DockerCaseAdoptSchema, req.body),
        type: 'docker' as const,
        owner: ownerFor(req),
        owned: false as const,
      };
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');

      const linkedCases = await readLinkedCases();
      const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
      if (
        dockerCases.some((item) => item.name === dockerCase.name) ||
        linkedCases[dockerCase.name] ||
        existsSync(join(resolveCasesDir(getAuthUser(req)), dockerCase.name))
      ) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
      }
      // One container may back SEVERAL adopted cases, each pointing at a different
      // directory inside it. What still blocks it, and why, lives in
      // classifyAdoptContainerConflict — note that none of it is about the shared
      // in-container tmux server, which is safe precisely because sessions there
      // are named per SESSION id (`codeman-dkr-<id8>`), never per case.
      const container = dockerCase.container;
      const conflict = classifyAdoptContainerConflict({
        container,
        containerWorkdir: dockerCase.containerWorkdir ?? dockerCase.hostWorkspacePath,
        existing: dockerCases,
        canAccess: (owner) => canAccessOwned(getAuthUser(req), owner),
      });
      if (conflict?.kind === 'owned-case') {
        return createErrorResponse(
          ApiErrorCode.ALREADY_EXISTS,
          `Container "${container}" belongs to case "${conflict.caseName}", which Codeman created and whose lifecycle it manages. Adopt a container you started yourself, or open that case directly.`
        );
      }
      if (conflict?.kind === 'other-owner') {
        return createErrorResponse(
          ApiErrorCode.FORBIDDEN,
          `Container "${container}" is already adopted by another user.`
        );
      }
      if (conflict?.kind === 'duplicate') {
        return createErrorResponse(
          ApiErrorCode.ALREADY_EXISTS,
          `Case "${conflict.caseName}" already adopts "${container}" at that same directory. Point this one at another directory inside the container.`
        );
      }

      if (!isWorkingDirAllowed(getAuthUser(req), dockerCase.hostWorkspacePath)) {
        return createErrorResponse(ApiErrorCode.FORBIDDEN, 'hostWorkspacePath is outside your workspace');
      }
      // The workspace must ALREADY exist: it mirrors a path inside a container we
      // did not create, so silently mkdir-ing it would invent a host directory that
      // does not correspond to whatever is actually mounted there.
      if (!existsSync(dockerCase.hostWorkspacePath)) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          'hostWorkspacePath does not exist. Adoption mirrors an existing container, so point this at the real host directory already mounted into it.'
        );
      }

      const availability = await checkDockerAvailable(host.engine);
      if (!availability.ok) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          availability.error || 'docker daemon is not available'
        );
      }
      // The container workdir is validated INSIDE the container. It defaults to
      // hostWorkspacePath only because that is what an owned container's bind
      // mount guarantees; adoption mounts nothing, so the probe has to prove it.
      const adoptDocker = toSessionDocker(host, dockerCase);
      const probe = await probeAdoptableContainer(adoptDocker, dockerAdoptProbeModes(), adoptDocker.containerWorkdir);
      if (!probe.ok) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, probe.error || 'container is not adoptable');
      }

      // Persist what the container actually has: the run-mode picker gates on
      // HOST CLIs, which is the wrong question for a case whose agents run inside
      // a container the host knows nothing about.
      const adoptedCase = { ...dockerCase, availableModes: probe.availableModes };
      await writeDockerCases(CODEMAN_CONFIG_DIR, [...dockerCases, adoptedCase]);
      ctx.broadcast(SseEvent.CaseLinked, {
        name: adoptedCase.name,
        path: adoptedCase.hostWorkspacePath,
        type: 'docker',
      });
      return {
        success: true,
        data: { case: adoptedCase, image: probe.image, availableModes: probe.availableModes },
      };
    }
  );

  /**
   * Preflight an existing container WITHOUT linking anything, so the UI can tell
   * the user "not running" / "no tmux" / "codex present, claude missing" before
   * they commit to a case name. Read-only; never touches container lifecycle.
   */
  /**
   * Containers on the host's engine, for the adoption picker. Read-only and
   * best-effort (mirror of the remote `:hostId/sessions` discovery route): an
   * unreachable daemon yields an empty list rather than an error, because the
   * container name is a free-text field the user can always type by hand.
   */
  app.get(
    '/api/docker-hosts/:hostId/containers',
    async (req, reply): Promise<ApiResponse<{ containers: DockerContainerInfo[] }>> => {
      // Enumerating every container on the engine is machine-level information (names,
      // images, uptime), so it follows the docker-host policy rather than the case one.
      const denied = adminOnly(req, reply);
      if (denied) return denied;
      const { hostId } = req.params as { hostId: string };
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
      const containers = await listDockerContainers({
        engine: host.engine ?? 'docker',
        context: host.context,
        daemonHost: host.daemonHost,
      });
      return { success: true, data: { containers } };
    }
  );

  /**
   * Browse a directory INSIDE a container, for the adoption form's
   * container-workdir picker. The host picker cannot answer this: for an adopted
   * container nothing is mounted at a matching host path, so the field would
   * otherwise be typed blind. Read-only — one `ls` through `docker exec`.
   */
  app.post('/api/docker-cases/browse', async (req, reply): Promise<ApiResponse<DockerBrowseResult>> => {
    // Reads a directory listing inside an ARBITRARY named container, so it is gated with
    // the adopt flow it serves rather than with the (owner-scoped) case file routes.
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const body = parseBody(DockerBrowseSchema, req.body);
    const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === body.hostId);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
    const result = await browseInContainer(
      {
        engine: host.engine ?? 'docker',
        context: host.context,
        daemonHost: host.daemonHost,
        containerName: body.container,
      },
      body.path || '/'
    );
    return { success: true, data: result };
  });

  app.post('/api/docker-cases/adopt-preflight', async (req, reply): Promise<ApiResponse<AdoptedContainerProbe>> => {
    const body = parseBody(DockerAdoptPreflightSchema, req.body);
    const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
    // ⚠️ NOT plain `adminOnly`, unlike the two routes above: the run menu probes this for
    // every docker case to learn which CLIs the CONTAINER has, so an admin-only gate would
    // hide every agent mode from a non-admin's own docker case. A non-admin may therefore
    // probe a container ALREADY linked to a case they can access — never an arbitrary one,
    // which is the adopt-time question and stays admin-only with the rest of that flow.
    if (!isAdmin(req)) {
      const owns = dockerCases.some(
        (item) =>
          (item.container ?? dockerContainerName(item.name)) === body.container &&
          canAccessOwned(getAuthUser(req), item.owner)
      );
      if (!owns) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
      }
    }
    const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === body.hostId);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
    const probe = await probeAdoptableContainer(
      {
        engine: host.engine ?? 'docker',
        context: host.context,
        daemonHost: host.daemonHost,
        containerName: body.container,
      },
      dockerAdoptProbeModes(),
      body.containerWorkdir
    );
    return { success: true, data: probe };
  });

  // One-click "Run in Docker": create a NORMAL case (folder in CASES_DIR, scaffolded)
  // AND link it to a hardened container with default settings, auto-provisioning a
  // shared `default` docker host so the user never touches host/image/network fields.
  app.post(
    '/api/cases/docker-quickcreate',
    async (
      req
    ): Promise<
      ApiResponse<{ case: unknown; capsEnforced?: boolean; isDesktop?: boolean; imageBuilding?: boolean }>
    > => {
      const body = parseBody(DockerQuickCreateSchema, req.body);
      const { name, description } = body;
      const casePath = validatePathWithinBase(name, resolveCasesDir(getAuthUser(req)));
      if (!casePath) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');

      // Collision across every case kind.
      const linkedCases = await readLinkedCases();
      const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
      const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
      if (
        existsSync(casePath) ||
        dockerCases.some((item) => item.name === name) ||
        remoteCases.some((item) => item.name === name) ||
        linkedCases[name]
      ) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
      }

      // The checkbox alone (no overrides) uses the shared `default` host; any tweaked
      // setting gets a dedicated per-case host so it never mutates the shared default.
      const hasOverrides = !!(
        body.image ||
        body.network ||
        body.networkName ||
        body.memory ||
        body.cpus ||
        body.gpus ||
        body.mountCredentials !== undefined
      );
      const resources: { memory?: string; cpus?: string } = {};
      if (body.memory) resources.memory = body.memory;
      if (body.cpus) resources.cpus = body.cpus;
      const desiredHost: DockerHost = {
        id: hasOverrides ? `q-${name}` : DEFAULT_DOCKER_HOST_ID,
        label: hasOverrides ? `Case: ${name}` : 'Default',
        image: body.image || DEFAULT_AGENT_IMAGE,
        network: body.network || 'bridge',
        ...(body.networkName ? { networkName: body.networkName } : {}),
        ...(Object.keys(resources).length ? { resources } : {}),
        ...(body.gpus ? { gpus: body.gpus } : {}),
        mountCredentials: body.mountCredentials ?? true,
        resumeOnStart: true,
        hooksEnabled: true,
      };
      const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
      const existing = hosts.find((item) => item.id === desiredHost.id);
      // Reuse the shared default if present; create/refresh a per-case host for overrides.
      const host = existing && !hasOverrides ? existing : desiredHost;
      if (!existing) {
        await writeDockerHosts(CODEMAN_CONFIG_DIR, [...hosts, desiredHost]);
      } else if (hasOverrides) {
        await writeDockerHosts(
          CODEMAN_CONFIG_DIR,
          hosts.map((h) => (h.id === desiredHost.id ? desiredHost : h))
        );
      }

      // Probe the daemon BEFORE scaffolding so a missing docker surfaces a clear
      // error instead of leaving an orphaned case folder. The base image is NOT a
      // blocker: a missing default image auto-builds in the background on first use.
      const availability = await checkDockerAvailable(host.engine);
      if (!availability.ok) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          availability.error || 'docker daemon is not available'
        );
      }
      const dockerCase = {
        name,
        type: 'docker' as const,
        hostId: host.id,
        hostWorkspacePath: casePath,
        owner: ownerFor(req),
      };
      const imageGate = await ensureCaseImage(ctx.broadcast, toSessionDocker(host, dockerCase), name);
      if (!imageGate.ok) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, imageGate.error);
      }

      // Scaffold the case folder exactly like a normal case.
      try {
        mkdirSync(casePath, { recursive: true });
        mkdirSync(join(casePath, 'src'), { recursive: true });
        const templatePath = await ctx.getDefaultClaudeMdPath();
        writeFileSync(join(casePath, 'CLAUDE.md'), generateClaudeMd(name, description || '', templatePath));
        await writeHooksConfig(casePath);
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create case: ${getErrorMessage(err)}`);
      }

      await writeDockerCases(CODEMAN_CONFIG_DIR, [...dockerCases, dockerCase]);
      ctx.broadcast(SseEvent.CaseCreated, { name, path: casePath });
      ctx.broadcast(SseEvent.CaseLinked, { name, path: casePath, type: 'docker' });
      return {
        success: true,
        data: {
          case: dockerCase,
          capsEnforced: availability.capsEnforced,
          isDesktop: availability.isDesktop,
          imageBuilding: imageGate.imageBuilding,
        },
      };
    }
  );

  // ========== Docker export / import ==========

  // Export a docker case to a portable bundle. Runs in the BACKGROUND (a full image
  // save can take minutes) and broadcasts docker:exportComplete / docker:exportFailed.
  app.post('/api/docker-cases/:name/export', async (req): Promise<ApiResponse<{ started: true; bundle: string }>> => {
    const { name } = req.params as { name: string };
    const { mode = 'full' } = parseBody(DockerExportSchema, req.body ?? {});
    const dockerCase = (await readDockerCases(CODEMAN_CONFIG_DIR)).find((item) => item.name === name);
    if (!dockerCase) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker case not found');
    const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');

    const sessionDocker = toSessionDocker(host, dockerCase);
    // A full export `docker commit`s the container into an image. For an ADOPTED
    // container that means packaging someone else's container — with whatever
    // credentials its owner logged in with — into a bundle Codeman then hands out,
    // and it is the one export step that touches the container at all. The
    // workspace-only export is a plain host-directory tar and stays available.
    if (mode === 'full' && dockerCase.owned === false) {
      return createErrorResponse(
        ApiErrorCode.FORBIDDEN,
        `Case "${name}" adopted an existing container. Codeman does not own it and will not commit it to an image — use a workspace-only export, or build the image yourself.`
      );
    }
    if (mode === 'full' && !sessionDocker.mountCredentials) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'full-image export is refused for a sealed container (its in-container login would ride the committed layer). Use a workspace-only export.'
      );
    }

    const timestamp = Date.now();
    const bundle = exportBundleName(name, timestamp, mode);
    // Fire-and-forget: the client watches for the SSE completion event.
    void exportDockerCase({
      docker: sessionDocker,
      caseName: name,
      timestamp,
      exportsDir: DOCKER_EXPORTS_DIR,
      mode,
      codemanVersion: APP_VERSION,
    })
      .then((result) => {
        ctx.broadcast(SseEvent.DockerExportComplete, {
          name,
          bundle: basename(result.bundlePath),
          sizeBytes: result.sizeBytes,
          mode,
        });
      })
      .catch((err) => {
        ctx.broadcast(SseEvent.DockerExportFailed, { name, mode, error: getErrorMessage(err) });
      });

    return { success: true, data: { started: true, bundle } };
  });

  app.get('/api/docker-exports', async (): Promise<ApiResponse<{ exports: unknown[] }>> => {
    return { success: true, data: { exports: await listDockerExports(DOCKER_EXPORTS_DIR) } };
  });

  // Download an export bundle (filename resolved WITHIN the exports dir — no traversal).
  app.get('/api/docker-exports/:filename', async (req, reply) => {
    const { filename } = req.params as { filename: string };
    if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(filename)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid bundle filename');
    }
    const full = join(DOCKER_EXPORTS_DIR, filename);
    if (!existsSync(full)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Export not found');
    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(full));
  });

  app.delete('/api/docker-exports/:filename', async (req): Promise<ApiResponse<{ filename: string }>> => {
    const { filename } = req.params as { filename: string };
    if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(filename)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid bundle filename');
    }
    const full = join(DOCKER_EXPORTS_DIR, filename);
    if (!existsSync(full)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Export not found');
    await fs.rm(full, { force: true });
    return { success: true, data: { filename } };
  });

  // Import a bundle (already present in the exports dir) into a NEW docker case.
  app.post('/api/docker-cases/import', async (req): Promise<ApiResponse<{ case: unknown }>> => {
    const { bundle, newCaseName, destWorkspacePath } = parseBody(DockerImportSchema, req.body);
    const bundlePath = join(DOCKER_EXPORTS_DIR, bundle);
    if (!existsSync(bundlePath)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Bundle not found in exports dir');

    // Name-collision guard across ALL case kinds.
    const linkedCases = await readLinkedCases();
    const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
    if (
      dockerCases.some((item) => item.name === newCaseName) ||
      linkedCases[newCaseName] ||
      existsSync(join(resolveCasesDir(getAuthUser(req)), newCaseName))
    ) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    // Import extracts a tar into destWorkspacePath (later becomes Session.workingDir):
    // confine it to the caller's own space. No-op for admins/single-user.
    if (!isWorkingDirAllowed(getAuthUser(req), destWorkspacePath)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'destWorkspacePath is outside your workspace');
    }

    const timestamp = Date.now();
    let result;
    try {
      result = await importDockerBundle({
        bundlePath,
        destWorkspace: destWorkspacePath,
        engine: 'docker',
        timestamp,
        newCaseName,
      });
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Import failed: ${getErrorMessage(err)}`);
    }

    // Create (or REFRESH) the dedicated docker host pointing at the quarantined
    // imported image (full mode) or the manifest's base image (workspace-only).
    // Refresh matters: after a case-delete + re-import of the same name, a stale
    // `imported-<name>` host would silently pin the PREVIOUS import's image tag.
    const hostId = `imported-${newCaseName}`;
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    const importedHost = {
      id: hostId,
      label: `Imported: ${newCaseName}`,
      engine: result.manifest.engine,
      image: result.importedImage ?? result.manifest.image,
      network: (['bridge', 'none', 'custom'].includes(result.manifest.network) ? result.manifest.network : 'bridge') as
        'bridge' | 'none' | 'custom',
    };
    await writeDockerHosts(
      CODEMAN_CONFIG_DIR,
      hosts.some((h) => h.id === hostId)
        ? hosts.map((h) => (h.id === hostId ? { ...h, ...importedHost } : h))
        : [...hosts, importedHost]
    );
    const newCase = {
      name: newCaseName,
      type: 'docker' as const,
      hostId,
      hostWorkspacePath: destWorkspacePath,
      containerWorkdir: result.manifest.containerWorkdir,
      owner: ownerFor(req),
    };
    await writeDockerCases(CODEMAN_CONFIG_DIR, [...dockerCases, newCase]);
    ctx.broadcast(SseEvent.DockerImportComplete, { name: newCaseName, path: destWorkspacePath, type: 'docker' });
    return { success: true, data: { case: newCase } };
  });

  // Recreate-on-drift confirm (docs/docker-cases-plan.md §4): remove the case
  // container so the next launch recreates it with the CURRENT host config. The
  // workspace + transcripts ride bind mounts and survive; the conversation resumes
  // via the case's lastClaudeSessionId. Refused while sessions of the case are live
  // (removal would yank the container out from under their panes).
  app.post(
    '/api/docker-cases/:name/recreate',
    async (req): Promise<ApiResponse<{ name: string; container: string }>> => {
      const { name } = req.params as { name: string };
      // Ownership gate: recreate DESTROYS a container, so it must be scoped like
      // delete is (`canAccessOwned`). Without it any user could rebuild another
      // user's container by name.
      const dockerCase = (await readDockerCases(CODEMAN_CONFIG_DIR)).find(
        (item) => item.name === name && canAccessOwned(getAuthUser(req), item.owner)
      );
      if (!dockerCase) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker case not found');
      // An ADOPTED container is the user's own: there is nothing to recreate it
      // from (no create-config, no image gate) and destroying it is exactly what
      // adoption promises never to do.
      if (dockerCase.owned === false) {
        return createErrorResponse(
          ApiErrorCode.FORBIDDEN,
          `Case "${name}" adopted an existing container. Codeman does not own its lifecycle and will not recreate it — rebuild it yourself, or unlink the case.`
        );
      }
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
      const sessionDocker = toSessionDocker(host, dockerCase);

      for (const session of ctx.sessions.values()) {
        if (session.docker?.containerName === sessionDocker.containerName && session.pid) {
          return createErrorResponse(
            ApiErrorCode.CONFLICT,
            `Sessions of case "${name}" are still running — stop them first, then recreate the container.`
          );
        }
      }

      try {
        await removeDockerContainer(sessionDocker);
      } catch (err) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          `Failed to remove container: ${getErrorMessage(err)}`
        );
      }
      // Drop the per-container claude-config seed; it is regenerated at next launch.
      await fs
        .rm(join(dataPath('docker-seeds'), `${sessionDocker.containerName}.json`), { force: true })
        .catch(() => {});
      ctx.broadcast(SseEvent.DockerContainerRecreated, { name, container: sessionDocker.containerName });
      return { success: true, data: { name, container: sessionDocker.containerName } };
    }
  );

  // Link an existing folder as a case
  app.post('/api/cases/link', async (req, reply): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    // Linking writes an arbitrary absolute path into the shared ownerless registry:
    // admin-only in multi-user mode (mirrors host CRUD + the admin-only GET listing).
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { name, path: folderPath } = parseBody(LinkCaseSchema, req.body, 'Invalid request body');

    // Expand ~ to home directory
    const expandedPath = folderPath.startsWith('~') ? join(homedir(), folderPath.slice(1)) : folderPath;

    // Validate the folder exists
    if (!existsSync(expandedPath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Folder not found: ${expandedPath}`);
    }

    // Check if case name already exists in CASES_DIR
    const casePath = join(resolveCasesDir(getAuthUser(req)), name);
    if (existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'A case with this name already exists in codeman-cases.');
    }

    // Load existing linked cases
    const linkedCases = await readLinkedCases();

    // Check if name is already linked
    if (linkedCases[name]) {
      return createErrorResponse(
        ApiErrorCode.ALREADY_EXISTS,
        `Case "${name}" is already linked to ${linkedCases[name]}`
      );
    }

    // Save the linked case
    linkedCases[name] = expandedPath;
    try {
      const codemanDir = getDataDir();
      if (!existsSync(codemanDir)) {
        mkdirSync(codemanDir, { recursive: true });
      }
      await fs.writeFile(LINKED_CASES_FILE, JSON.stringify(linkedCases, null, 2));
      ctx.broadcast(SseEvent.CaseLinked, { name, path: expandedPath });
      return { success: true, data: { case: { name, path: expandedPath } } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Delete / Unlink Case ==========

  app.delete('/api/cases/:name', async (req): Promise<ApiResponse<{ name: string }>> => {
    const { name } = req.params as { name: string };
    const user = getAuthUser(req);

    if (!validatePathWithinBase(name, resolveCasesDir(user))) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Fold ownership INTO the match (don't early-return): a non-owned same-named remote/
    // docker case is skipped so control falls through to the caller's own local delete.
    // canAccessOwned is all-true for admins/single-user, so flag-OFF stays byte-identical.
    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    if (remoteCases.some((item) => item.name === name && canAccessOwned(user, item.owner))) {
      await writeRemoteCases(
        CODEMAN_CONFIG_DIR,
        remoteCases.filter((item) => !(item.name === name && canAccessOwned(user, item.owner)))
      );
      ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'remote-unlinked' });
      return { success: true, data: { name } };
    }

    const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
    const dockerCase = dockerCases.find((item) => item.name === name && canAccessOwned(user, item.owner));
    if (dockerCase) {
      await writeDockerCases(
        CODEMAN_CONFIG_DIR,
        dockerCases.filter((item) => item !== dockerCase)
      );
      // Best-effort `docker rm -f` the per-case container (case-delete is the
      // explicit teardown that removes it; the bind-mounted workspace survives).
      // An ADOPTED container is skipped entirely: unlinking the case must leave
      // the user's own container running and untouched. The seed file is skipped
      // with it — adoption never wrote one.
      const host =
        dockerCase.owned === false
          ? undefined
          : (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (host) {
        const sessionDocker = toSessionDocker(host, dockerCase);
        try {
          exec(buildDockerRemoveCommand(sessionDocker), { timeout: 15_000 }, () => {});
        } catch {
          /* best-effort — never blocks the unlink */
        }
        // Remove the per-container claude-config seed file (account metadata copy).
        await fs
          .rm(join(dataPath('docker-seeds'), `${sessionDocker.containerName}.json`), { force: true })
          .catch(() => {});
      }
      ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'docker-unlinked' });
      return { success: true, data: { name } };
    }

    // Check linked cases first — unlink only, don't delete the actual directory.
    // Linked cases carry no owner (admin-only WRITE in multi-user mode), so a non-admin
    // must not unlink one either; skip so control falls through to their local delete.
    const linkedCases = await readLinkedCases();
    if (linkedCases[name] && (!isMultiUserMode() || isAdmin(req))) {
      delete linkedCases[name];
      try {
        await fs.writeFile(LINKED_CASES_FILE, JSON.stringify(linkedCases, null, 2));
        ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'unlinked' });
        return { success: true, data: { name } };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }
    }

    // Case in CASES_DIR — delete the entire directory
    const casePath = join(resolveCasesDir(getAuthUser(req)), name);
    if (!existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Case "${name}" not found`);
    }

    try {
      await fs.rm(casePath, { recursive: true, force: true });
      ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'deleted' });
      return { success: true, data: { name } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Reorder Cases ==========

  app.put('/api/cases/order', async (req): Promise<ApiResponse<{ order: string[] }>> => {
    const { order } = parseBody(CaseOrderSchema, req.body, 'Invalid order data');

    try {
      const dir = getDataDir();
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf-8'));
      } catch {
        /* ignore */
      }
      const merged = { ...existing, caseOrder: order };
      await fs.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));
      ctx.broadcast(SseEvent.CaseOrderChanged, { order });
      return { success: true, data: { order } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  app.get('/api/cases/:name', async (req) => {
    const { name } = req.params as { name: string };

    if (!validatePathWithinBase(name, resolveCasesDir(getAuthUser(req)))) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Fold ownership INTO the match (don't early-return): a non-owned same-named remote/
    // docker case is skipped so control falls through to the caller's own LOCAL case
    // (remote/docker names are globally unique, local names per-user). No metadata is
    // disclosed for a foreign case. canAccessOwned is allow-all for admins/single-user.
    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    const remoteCase = remoteCases.find((item) => item.name === name && canAccessOwned(getAuthUser(req), item.owner));
    if (remoteCase) {
      const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === remoteCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
      return {
        name,
        path: remoteDisplayPath({ username: host.username, host: host.host, path: remoteCase.remotePath }),
        hasClaudeMd: false,
        location: 'remote',
        remote: {
          hostId: host.id,
          host: host.host,
          username: host.username,
          path: remoteCase.remotePath,
        },
      };
    }

    const dockerCase = (await readDockerCases(CODEMAN_CONFIG_DIR)).find(
      (item) => item.name === name && canAccessOwned(getAuthUser(req), item.owner)
    );
    if (dockerCase) {
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
      const container = dockerCase.container ?? dockerContainerName(dockerCase.name);
      return {
        name,
        path: dockerDisplayPath({ container, path: dockerCase.hostWorkspacePath }),
        hasClaudeMd: existsSync(join(dockerCase.hostWorkspacePath, 'CLAUDE.md')),
        location: 'docker',
        docker: {
          hostId: host.id,
          container,
          image: host.image,
          path: dockerCase.hostWorkspacePath,
          containerWorkdir: dockerCase.containerWorkdir ?? dockerCase.hostWorkspacePath,
          network: host.network ?? 'bridge',
          ...(dockerCase.owned === false ? { owned: false } : {}),
        },
      };
    }

    const casePath = await resolveCasePath(name, getAuthUser(req));

    if (!existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
    }

    const linked = casePath !== join(resolveCasesDir(getAuthUser(req)), name);
    return {
      name,
      path: casePath,
      hasClaudeMd: existsSync(join(casePath, 'CLAUDE.md')),
      ...(linked && { linked: true }),
    };
  });

  // Read @fix_plan.md from a case directory (for wizard to detect existing plans)
  app.get('/api/cases/:name/fix-plan', async (req) => {
    const { name } = req.params as { name: string };

    if (!validatePathWithinBase(name, resolveCasesDir(getAuthUser(req)))) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Get case path (check linked cases first, then CASES_DIR)
    const casePath = await resolveCasePath(name, getAuthUser(req));

    const fixPlanPath = join(casePath, '@fix_plan.md');

    if (!existsSync(fixPlanPath)) {
      return { exists: false, content: null, todos: [] };
    }

    try {
      const content = await fs.readFile(fixPlanPath, 'utf-8');

      // Parse todos from the content (similar to ralph-tracker's importFixPlanMarkdown)
      const todos: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: string | null;
      }> = [];
      const todoPattern = /^-\s*\[([ xX-])\]\s*(.+)$/;
      const p0HeaderPattern = /^##\s*(High Priority|Critical|P0|Critical Path)/i;
      const p1HeaderPattern = /^##\s*(Standard|P1|Medium Priority)/i;
      const p2HeaderPattern = /^##\s*(Nice to Have|P2|Low Priority)/i;
      const completedHeaderPattern = /^##\s*Completed/i;

      let currentPriority: string | null = null;
      let inCompletedSection = false;

      for (const line of content.split('\n')) {
        const trimmed = line.trim();

        if (p0HeaderPattern.test(trimmed)) {
          currentPriority = 'P0';
          inCompletedSection = false;
          continue;
        }
        if (p1HeaderPattern.test(trimmed)) {
          currentPriority = 'P1';
          inCompletedSection = false;
          continue;
        }
        if (p2HeaderPattern.test(trimmed)) {
          currentPriority = 'P2';
          inCompletedSection = false;
          continue;
        }
        if (completedHeaderPattern.test(trimmed)) {
          inCompletedSection = true;
          continue;
        }

        const match = trimmed.match(todoPattern);
        if (match) {
          const [, checkboxState, taskContent] = match;
          let status: 'pending' | 'in_progress' | 'completed';

          if (inCompletedSection || checkboxState === 'x' || checkboxState === 'X') {
            status = 'completed';
          } else if (checkboxState === '-') {
            status = 'in_progress';
          } else {
            status = 'pending';
          }

          todos.push({
            content: taskContent.trim(),
            status,
            priority: inCompletedSection ? null : currentPriority,
          });
        }
      }

      // Calculate stats in a single pass for better performance
      let pending = 0,
        inProgress = 0,
        completed = 0;
      for (const t of todos) {
        if (t.status === 'pending') pending++;
        else if (t.status === 'in_progress') inProgress++;
        else if (t.status === 'completed') completed++;
      }
      const stats = { total: todos.length, pending, inProgress, completed };

      return {
        exists: true,
        content,
        todos,
        stats,
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read @fix_plan.md: ${err}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Ralph Wizard Files (per-case prompt/result serving)
  // ═══════════════════════════════════════════════════════════════

  // ========== List Wizard Files ==========

  app.get('/api/cases/:caseName/ralph-wizard/files', async (req) => {
    const { caseName } = req.params as { caseName: string };
    if (!validatePathWithinBase(caseName, resolveCasesDir(getAuthUser(req)))) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    const casePath = await resolveCasePath(caseName, getAuthUser(req));

    const wizardDir = join(casePath, 'ralph-wizard');

    if (!existsSync(wizardDir)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Ralph wizard directory not found');
    }

    // List all subdirectories and their files
    const files: Array<{ agentType: string; promptFile?: string; resultFile?: string }> = [];
    const entries = readdirSync(wizardDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const agentDir = join(wizardDir, entry.name);
        const agentFiles: { agentType: string; promptFile?: string; resultFile?: string } = {
          agentType: entry.name,
        };

        if (existsSync(join(agentDir, 'prompt.md'))) {
          agentFiles.promptFile = `${entry.name}/prompt.md`;
        }
        if (existsSync(join(agentDir, 'result.json'))) {
          agentFiles.resultFile = `${entry.name}/result.json`;
        }

        if (agentFiles.promptFile || agentFiles.resultFile) {
          files.push(agentFiles);
        }
      }
    }

    return { success: true, data: { files, caseName } };
  });

  // Read a specific ralph-wizard file
  // Cache disabled to ensure fresh prompts when starting new plan generations
  app.get('/api/cases/:caseName/ralph-wizard/file/:filePath', async (req, reply) => {
    const { caseName, filePath } = req.params as { caseName: string; filePath: string };
    if (!validatePathWithinBase(caseName, resolveCasesDir(getAuthUser(req)))) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Prevent browser caching - prompts change between plan generations
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');

    const casePath = await resolveCasePath(caseName, getAuthUser(req));

    const wizardDir = join(casePath, 'ralph-wizard');

    // Decode the file path (it may be URL encoded)
    const decodedPath = decodeURIComponent(filePath);
    const fullPath = join(wizardDir, decodedPath);

    // Security: ensure path is within wizard directory
    const resolvedPath = resolve(fullPath);
    const resolvedWizard = resolve(wizardDir);
    if (!resolvedPath.startsWith(resolvedWizard)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid file path');
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
      }
      throw err;
    }
    const isJson = filePath.endsWith('.json');

    // Parse JSON content safely (may contain invalid JSON or unescaped control characters)
    let parsed: unknown = null;
    if (isJson) {
      try {
        parsed = JSON.parse(content);
      } catch {
        // Try repairing common JSON issues (unescaped control characters, trailing commas)
        try {
          let repaired = content;
          // Fix trailing commas before closing brackets
          repaired = repaired.replace(/,(\s*[\]}])/g, '$1');
          // Fix unescaped control characters within JSON strings
          repaired = repaired.replace(/"([^"\\]|\\.)*"/g, (match) => {
            return match
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t')
              .replace(
                // eslint-disable-next-line no-control-regex
                /[\x00-\x1f]/g,
                (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
              );
          });
          parsed = JSON.parse(repaired);
        } catch {
          // Still invalid - return null for parsed, content available as raw string
        }
      }
    }

    return {
      success: true,
      data: {
        content,
        filePath: decodedPath,
        isJson,
        parsed,
      },
    };
  });
}
