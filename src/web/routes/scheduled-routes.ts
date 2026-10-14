/**
 * @fileoverview Scheduled run routes.
 * CRUD operations for scheduled autonomous runs with session lifecycle management.
 */

import { FastifyInstance } from 'fastify';
import { statSync } from 'node:fs';
import { ApiErrorCode, createErrorResponse, type ApiResponse } from '../../types.js';
import { ScheduledRunSchema } from '../schemas.js';
import {
  parseBody,
  getAuthUser,
  ownerFor,
  isWorkingDirAllowed,
  canAccessOwned,
  resolveCasesDir,
} from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import type { SessionPort, EventPort, InfraPort, ScheduledRun } from '../ports/index.js';

export function registerScheduledRoutes(app: FastifyInstance, ctx: SessionPort & EventPort & InfraPort): void {
  app.get('/api/scheduled', async (req) => {
    // Multi-user: non-admins see only their own runs (no-op in single-user).
    const user = getAuthUser(req);
    return Array.from(ctx.scheduledRuns.values()).filter((r) => canAccessOwned(user, r.owner));
  });

  app.post('/api/scheduled', async (req): Promise<{ run: ScheduledRun } | ApiResponse<never>> => {
    const { prompt, workingDir, durationMinutes } = parseBody(ScheduledRunSchema, req.body, 'Invalid request body');

    // Multi-user: confine the run's workingDir to the caller's own case space.
    // The spawned Session (--dangerously-skip-permissions by default) trusts this
    // dir; without confinement a non-admin could point it at another user's files.
    // No-op for admins / single-user (isWorkingDirAllowed returns true).
    if (workingDir && !isWorkingDirAllowed(getAuthUser(req), workingDir)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'workingDir is not within your allowed workspace');
    }

    // Validate workingDir exists and is a directory
    if (workingDir) {
      try {
        const stat = statSync(workingDir);
        if (!stat.isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
      }
    }

    // Multi-user: default a missing workingDir to the user's own cases dir rather
    // than the server's cwd. Single-user keeps process.cwd() (byte-identical).
    const effectiveWorkingDir = workingDir || (isMultiUserMode() ? resolveCasesDir(getAuthUser(req)) : process.cwd());
    if (!isWorkingDirAllowed(getAuthUser(req), effectiveWorkingDir)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'workingDir is not within your allowed workspace');
    }

    const run = await ctx.startScheduledRun(prompt, effectiveWorkingDir, durationMinutes ?? 60, ownerFor(req));
    return { run };
  });

  app.delete('/api/scheduled/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = ctx.scheduledRuns.get(id);

    // NOT_FOUND (not FORBIDDEN) for a foreign run so existence isn't leaked; no-op
    // for admins / single-user (canAccessOwned returns true).
    if (!run || !canAccessOwned(getAuthUser(req), run.owner)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled run not found');
    }

    await ctx.stopScheduledRun(id);
    return {};
  });

  app.get('/api/scheduled/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = ctx.scheduledRuns.get(id);

    // Owner-scoped read: a foreign run reads as NOT_FOUND (no-op in single-user).
    if (!run || !canAccessOwned(getAuthUser(req), run.owner)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled run not found');
    }

    return run;
  });
}
