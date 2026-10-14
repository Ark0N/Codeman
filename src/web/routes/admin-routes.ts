/**
 * @fileoverview Admin user-management routes (multi-user mode only).
 *
 * All handlers: 404 unless multi-user mode is active, requireAdmin, and audit-logged
 * to ~/.codeman/admin-audit.jsonl. Endpoints (docs/multi-user-plan.md section 8):
 *   GET    /api/admin/users
 *   POST   /api/admin/users
 *   PATCH  /api/admin/users/:username
 *   POST   /api/admin/users/:username/reset-password
 *   POST   /api/admin/users/:username/logout
 *   DELETE /api/admin/users/:username
 *   GET    /api/admin/users/:username/cases          (list the user's case folders)
 *   DELETE /api/admin/users/:username/cases/:caseName (delete one case folder)
 *   GET/PUT/DELETE /api/admin/users/:username/workspaces (inspect, restrict, or restore access)
 *
 * Self-service GET /api/me + POST /api/me/password live in me-routes.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readdirSync, promises as fsp } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { isMultiUserMode, userCasesDir } from '../../config/multiuser.js';
import {
  createUser,
  deleteUser,
  deleteUserSpace,
  findUser,
  generateOneTimePassword,
  normalizeUsername,
  readUsers,
  setPassword,
  toPublicUser,
  updateUser,
  UserStoreError,
} from '../../user-store.js';
import { getAuthUser, isWorkingDirAllowed, requireAdmin, revokeUserSessions } from '../route-helpers.js';
import { webviewCapabilities } from '../../webview-capabilities.js';
import { htmlViewCapabilities } from '../../html-view-capabilities.js';
import { appendAdminAudit } from '../admin-audit.js';
import { SseEvent } from '../sse-events.js';
import type { AuthPort } from '../ports/auth-port.js';
import type { SessionPort } from '../ports/session-port.js';
import type { EventPort } from '../ports/event-port.js';
import {
  deleteSharedWorkspacePolicy,
  getSharedWorkspacePolicy,
  readLinkedWorkspacePaths,
  writeSharedWorkspacePolicy,
} from '../../shared-workspace-store.js';

const CreateUserSchema = z.object({
  username: z.string().min(1).max(64),
  role: z.enum(['admin', 'user']).default('user'),
  password: z.string().min(8).max(1024).optional(),
  canBypassPermissions: z.boolean().optional(),
});
const UpdateUserSchema = z.object({
  role: z.enum(['admin', 'user']).optional(),
  disabled: z.boolean().optional(),
  canBypassPermissions: z.boolean().optional(),
});
const DeleteUserSchema = z.object({ deleteSpace: z.boolean().optional() });
const WorkspacePolicySchema = z.object({
  workspaceNames: z.array(z.string().regex(/^[^./\\][^/\\]{0,127}$/)).max(100),
});

// Case-folder names: a single path segment, no separators, no leading dot (hidden
// dirs like .claude are infrastructure, not cases), so '.'/'..' are excluded too.
const SAFE_CASE_NAME = /^[^./\\][^/\\]{0,127}$/;

/** Map a UserStoreError's code onto the API error code + status. */
function storeError(reply: FastifyReply, err: unknown): ReturnType<typeof createErrorResponse> {
  if (err instanceof UserStoreError) {
    const code = ApiErrorCode[err.code as keyof typeof ApiErrorCode] ?? ApiErrorCode.INVALID_INPUT;
    reply.code(
      err.code === 'USER_EXISTS' || err.code === 'LAST_ADMIN' ? 409 : err.code === 'USER_NOT_FOUND' ? 404 : 400
    );
    return createErrorResponse(code, err.message);
  }
  reply.code(500);
  return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : 'error');
}

export function registerAdminRoutes(app: FastifyInstance, ctx: SessionPort & AuthPort & EventPort): void {
  // Gate: admin routes exist only in multi-user mode, and only for admins.
  const gate = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!isMultiUserMode()) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Not found'));
      return false;
    }
    return requireAdmin(req, reply);
  };
  const audit = (req: FastifyRequest, action: string, target?: string, detail?: Record<string, unknown>) =>
    void appendAdminAudit({ admin: getAuthUser(req).username, action, target, ip: req.ip, detail });

  // Count a user's live sessions + active cookie sessions + case folders.
  const statsFor = (username: string) => {
    let liveSessions = 0;
    for (const s of ctx.sessions.values()) if (s.owner === username) liveSessions++;
    let activeSessions = 0;
    if (ctx.authSessions) for (const [, rec] of ctx.authSessions) if (rec.username === username) activeSessions++;
    let caseCount = 0;
    try {
      caseCount = readdirSync(userCasesDir(username), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch {
      /* no cases dir yet */
    }
    return { liveSessions, activeSessions, caseCount };
  };

  app.get('/api/admin/users', async (req, reply) => {
    if (!gate(req, reply)) return;
    const users = await readUsers(true);
    return {
      success: true,
      data: users.map((u) => ({ ...toPublicUser(u), stats: statsFor(u.username) })),
    };
  });

  app.get('/api/admin/users/:username/workspaces', async (req, reply) => {
    if (!gate(req, reply)) return;
    const username = normalizeUsername((req.params as { username: string }).username);
    const user = await findUser(username);
    if (!user) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.USER_NOT_FOUND, 'User not found');
    }
    const linked = readLinkedWorkspacePaths();
    const available = await Promise.all(
      Object.entries(linked).map(async ([name, path]) => {
        if (!SAFE_CASE_NAME.test(name)) return null;
        try {
          const [realPath, stat] = await Promise.all([fsp.realpath(path), fsp.stat(path)]);
          return stat.isDirectory() ? { name, path: realPath } : null;
        } catch {
          return null;
        }
      })
    );
    const policy = getSharedWorkspacePolicy(username);
    return {
      success: true,
      data: {
        username,
        role: user.role,
        restricted: policy?.restricted ?? false,
        workspaceNames: policy?.workspaceNames ?? [],
        available: available.filter((item): item is { name: string; path: string } => item !== null),
      },
    };
  });

  app.put('/api/admin/users/:username/workspaces', async (req, reply) => {
    if (!gate(req, reply)) return;
    const username = normalizeUsername((req.params as { username: string }).username);
    const parsed = WorkspacePolicySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const user = await findUser(username);
    if (!user) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.USER_NOT_FOUND, 'User not found');
    }
    if (user.role !== 'user') {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Workspace restrictions apply to regular users only');
    }
    const linked = readLinkedWorkspacePaths();
    const invalid = parsed.data.workspaceNames.find((name) => !(name in linked));
    if (invalid) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Workspace is not linked: ${invalid}`);
    }
    for (const name of parsed.data.workspaceNames) {
      try {
        if (!(await fsp.stat(linked[name])).isDirectory()) throw new Error('not a directory');
      } catch {
        reply.code(400);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Workspace is unavailable: ${name}`);
      }
    }

    writeSharedWorkspacePolicy(username, parsed.data.workspaceNames);
    let stoppedSessions = 0;
    for (const session of [...ctx.sessions.values()]) {
      if (session.owner !== username) continue;
      if (!session.remote && isWorkingDirAllowed({ username, role: 'user' }, session.workingDir)) continue;
      try {
        await ctx.cleanupSession(session.id, true, 'workspace_access_revoked');
        stoppedSessions++;
      } catch {
        /* best effort; authorization checks still deny access to the session */
      }
    }
    audit(req, 'user.workspaces.update', username, {
      workspaceNames: parsed.data.workspaceNames,
      stoppedSessions,
    });
    ctx.broadcast(SseEvent.AdminUsersChanged, {});
    return {
      success: true,
      data: { restricted: true, workspaceNames: parsed.data.workspaceNames, stoppedSessions },
    };
  });

  app.delete('/api/admin/users/:username/workspaces', async (req, reply) => {
    if (!gate(req, reply)) return;
    const username = normalizeUsername((req.params as { username: string }).username);
    if (!(await findUser(username))) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.USER_NOT_FOUND, 'User not found');
    }
    deleteSharedWorkspacePolicy(username);
    audit(req, 'user.workspaces.clear', username);
    ctx.broadcast(SseEvent.AdminUsersChanged, {});
    return { success: true, data: { username, restricted: false } };
  });

  app.post('/api/admin/users', async (req, reply) => {
    if (!gate(req, reply)) return;
    const parsed = CreateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    // No password given: generate a one-time password, returned ONCE, force change.
    const oneTime = parsed.data.password ? undefined : generateOneTimePassword();
    try {
      const user = await createUser({
        username: parsed.data.username,
        role: parsed.data.role,
        password: parsed.data.password ?? oneTime!,
        canBypassPermissions: parsed.data.canBypassPermissions,
        mustChangePassword: !parsed.data.password,
      });
      audit(req, 'user.create', user.username, { role: user.role });
      ctx.broadcast(SseEvent.AdminUsersChanged, {});
      return { success: true, data: { user: toPublicUser(user), oneTimePassword: oneTime } };
    } catch (err) {
      return storeError(reply, err);
    }
  });

  app.patch('/api/admin/users/:username', async (req, reply) => {
    if (!gate(req, reply)) return;
    const { username } = req.params as { username: string };
    const parsed = UpdateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    try {
      const user = await updateUser(username, parsed.data);
      // Security: revoke the target's cookie sessions on ANY successful update. role,
      // disabled, and canBypassPermissions are all authorization-relevant, and the
      // cookie snapshots role, so a stale cookie could otherwise retain old privileges
      // (a demoted admin staying admin). Idempotent, affects only the target, and
      // forces a re-auth that re-snapshots the new record.
      revokeUserSessions(ctx.authSessions, user.username);
      audit(req, 'user.update', user.username, parsed.data);
      ctx.broadcast(SseEvent.AdminUsersChanged, {});
      return { success: true, data: { user: toPublicUser(user) } };
    } catch (err) {
      return storeError(reply, err);
    }
  });

  app.post('/api/admin/users/:username/reset-password', async (req, reply) => {
    if (!gate(req, reply)) return;
    const { username } = req.params as { username: string };
    if (!(await findUser(username))) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.USER_NOT_FOUND, 'No such user');
    }
    const oneTime = generateOneTimePassword();
    try {
      await setPassword(username, oneTime, { mustChangePassword: true });
      revokeUserSessions(ctx.authSessions, username);
      audit(req, 'user.reset-password', username);
      ctx.broadcast(SseEvent.AdminUsersChanged, {});
      return { success: true, data: { oneTimePassword: oneTime } };
    } catch (err) {
      return storeError(reply, err);
    }
  });

  app.post('/api/admin/users/:username/logout', async (req, reply) => {
    if (!gate(req, reply)) return;
    const { username } = req.params as { username: string };
    const revoked = revokeUserSessions(ctx.authSessions, username);
    // Web-tab proxy capabilities are a second credential the cookie purge does not
    // touch; a forced logout that left them alive would not be a logout.
    const revokedWebviews = webviewCapabilities.revokeOwner(normalizeUsername(username));
    const revokedHtmlViews = htmlViewCapabilities.revokeOwner(normalizeUsername(username));
    audit(req, 'user.logout', username, { revoked, revokedWebviews, revokedHtmlViews });
    return { success: true, data: { revoked } };
  });

  app.delete('/api/admin/users/:username', async (req, reply) => {
    if (!gate(req, reply)) return;
    const { username } = req.params as { username: string };
    const parsed = DeleteUserSchema.safeParse(req.body ?? {});
    const deleteSpace = parsed.success ? parsed.data.deleteSpace : false;
    try {
      // Security: validate BEFORE any teardown. deleteUser runs the authoritative
      // existence + last-admin guard under lock with no side effects, so a refusal
      // (409 LAST_ADMIN / 404 USER_NOT_FOUND) leaves the user's live sessions and
      // cookies untouched. Only after it succeeds do we irreversibly kill sessions and
      // revoke cookies. (owned is captured from the in-memory map, independent of the
      // record, so it is safe to read before the delete.)
      const owned = [...ctx.sessions.values()].filter((s) => s.owner === username).map((s) => s.id);
      await deleteUser(username); // throws LAST_ADMIN / USER_NOT_FOUND (no side effects)
      deleteSharedWorkspacePolicy(username);
      for (const id of owned) {
        await ctx.cleanupSession(id, true, 'admin_delete_user').catch(() => {});
      }
      revokeUserSessions(ctx.authSessions, username);
      webviewCapabilities.revokeOwner(normalizeUsername(username));
      htmlViewCapabilities.revokeOwner(normalizeUsername(username));
      if (deleteSpace) await deleteUserSpace(username);
      audit(req, 'user.delete', username, { deleteSpace, killedSessions: owned.length });
      ctx.broadcast(SseEvent.AdminUsersChanged, {});
      return { success: true, data: { username, deletedSpace: !!deleteSpace } };
    } catch (err) {
      return storeError(reply, err);
    }
  });

  // Count live sessions whose workingDir sits inside `dir` (any owner: a folder
  // in use by ANYONE must not be deleted out from under a running agent).
  const liveSessionsInside = (dir: string): number => {
    let n = 0;
    for (const s of ctx.sessions.values()) {
      const rel = relative(dir, s.workingDir || '');
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) n++;
    }
    return n;
  };

  app.get('/api/admin/users/:username/cases', async (req, reply) => {
    if (!gate(req, reply)) return;
    const username = normalizeUsername((req.params as { username: string }).username);
    if (!(await findUser(username))) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.USER_NOT_FOUND, 'No such user');
    }
    const dir = userCasesDir(username);
    let cases: { name: string; modifiedAt: number; liveSessions: number }[] = [];
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      cases = await Promise.all(
        entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map(async (e) => {
            const p = join(dir, e.name);
            const st = await fsp.stat(p).catch(() => null);
            return { name: e.name, modifiedAt: st ? Math.floor(st.mtimeMs) : 0, liveSessions: liveSessionsInside(p) };
          })
      );
    } catch {
      /* no cases dir yet */
    }
    cases.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { success: true, data: { dir, cases } };
  });

  app.delete('/api/admin/users/:username/cases/:caseName', async (req, reply) => {
    if (!gate(req, reply)) return;
    const params = req.params as { username: string; caseName: string };
    const username = normalizeUsername(params.username);
    if (!(await findUser(username))) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.USER_NOT_FOUND, 'No such user');
    }
    if (!SAFE_CASE_NAME.test(params.caseName)) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }
    // Same guard rails as deleteUserSpace: never follow a symlink, and the
    // realpath must stay strictly inside the user's cases dir.
    const root = userCasesDir(username);
    const target = join(root, params.caseName);
    let lst;
    try {
      lst = await fsp.lstat(target);
    } catch {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such case folder');
    }
    if (lst.isSymbolicLink() || !lst.isDirectory()) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Refusing to delete: not a plain directory');
    }
    const realRoot = await fsp.realpath(root).catch(() => root);
    const realTarget = await fsp.realpath(target);
    const rel = relative(realRoot, realTarget);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Case folder escapes the user space');
    }
    const inUse = liveSessionsInside(target) || liveSessionsInside(realTarget);
    if (inUse > 0) {
      reply.code(409);
      return createErrorResponse(
        ApiErrorCode.CONFLICT,
        `Case folder is in use by ${inUse} live session(s), close them first`
      );
    }
    await fsp.rm(realTarget, { recursive: true, force: true });
    audit(req, 'user.case-delete', username, { caseName: params.caseName });
    ctx.broadcast(SseEvent.AdminUsersChanged, {});
    return { success: true, data: { username, caseName: params.caseName } };
  });
}
