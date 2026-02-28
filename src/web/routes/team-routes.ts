/**
 * @fileoverview Team routes.
 * Provides read-only access to agent team data from TeamWatcher.
 */

import { FastifyInstance } from 'fastify';
import type { InfraPort } from '../ports/index.js';

export function registerTeamRoutes(app: FastifyInstance, ctx: InfraPort): void {
  app.get('/api/teams', async () => {
    return { success: true, data: ctx.teamWatcher.getTeams() };
  });

  app.get('/api/teams/:name/tasks', async (req) => {
    const { name } = req.params as { name: string };
    return { success: true, data: ctx.teamWatcher.getTeamTasks(name) };
  });
}
