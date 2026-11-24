/**
 * @fileoverview Self-service identity routes (multi-user + single-user).
 *
 * - GET  /api/me            : who am I ({ username, role, mustChangePassword, viaTrustedProxy }).
 *                             Works in single-user mode too, returning the synthetic
 *                             admin so the frontend has one "am I admin" code path.
 * - POST /api/me/password   : change my own password (verifies the current one,
 *                             clears mustChangePassword, revokes my OTHER sessions).
 *
 * These are the two endpoints a `mustChangePassword` user may still reach (the auth
 * middleware's lockbox exempts them). See docs/multi-user-plan.md sections 5, 8.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { findUser, setPassword, verifyPassword } from '../../user-store.js';
import { getAuthUser, revokeUserSessions } from '../route-helpers.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.js';
import type { AuthPort } from '../ports/auth-port.js';

const PasswordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(8).max(1024),
});

export function registerMeRoutes(app: FastifyInstance, ctx: AuthPort): void {
  // GET /api/me — identity probe. Synthetic admin in single-user mode. The
  // `multiUser` flag lets the frontend distinguish a single-user admin (no admin
  // UI) from a real multi-user admin.
  app.get('/api/me', async (req) => {
    if (!isMultiUserMode()) {
      return { success: true, data: { username: 'admin', role: 'admin', mustChangePassword: false, multiUser: false } };
    }
    const user = getAuthUser(req);
    const record = await findUser(user.username);
    // A trusted-proxy sign-in never used the Codeman password, so a pending one-time
    // password must not open the forced change-password modal (admin-ui.js).
    const viaTrustedProxy = !!user.viaTrustedProxy;
    return {
      success: true,
      data: {
        username: user.username,
        role: user.role,
        mustChangePassword: viaTrustedProxy ? false : !!record?.mustChangePassword,
        multiUser: true,
        viaTrustedProxy,
      },
    };
  });

  // POST /api/me/password — self-service password change.
  app.post('/api/me/password', async (req, reply) => {
    if (!isMultiUserMode()) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Multi-user mode is not enabled');
    }
    const parsed = PasswordChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        parsed.error.issues[0]?.message ?? 'New password must be at least 8 characters'
      );
    }
    const { username } = getAuthUser(req);
    const verified = await verifyPassword(username, parsed.data.currentPassword);
    if (!verified) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Current password is incorrect');
    }
    await setPassword(username, parsed.data.newPassword, { mustChangePassword: false });

    // Revoke this user's OTHER cookie sessions; keep the caller's own session alive
    // and clear its mustChangePassword snapshot so they aren't re-locked immediately.
    const currentToken = req.cookies[AUTH_COOKIE_NAME];
    revokeUserSessions(ctx.authSessions, username, currentToken);
    if (currentToken) {
      const rec = ctx.authSessions?.get(currentToken);
      if (rec) rec.mustChangePassword = false;
    }
    return { success: true };
  });
}
