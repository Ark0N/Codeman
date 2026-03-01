/**
 * @fileoverview Tests for team-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerTeamRoutes } from '../../src/web/routes/team-routes.js';

describe('team-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerTeamRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/teams ==========

  describe('GET /api/teams', () => {
    it('returns empty array when no teams exist', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/teams',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns teams from teamWatcher', async () => {
      const mockTeams = [
        { name: 'team-alpha', leadSessionId: 'session-1', members: [{ name: 'lead', agentType: 'team-lead' }] },
        { name: 'team-beta', leadSessionId: 'session-2', members: [] },
      ];
      harness.ctx.teamWatcher.getTeams.mockReturnValue(mockTeams);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/teams',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].name).toBe('team-alpha');
      expect(body.data[1].name).toBe('team-beta');
    });
  });

  // ========== GET /api/teams/:name/tasks ==========

  describe('GET /api/teams/:name/tasks', () => {
    it('returns empty array for unknown team', async () => {

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/teams/nonexistent/tasks',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns tasks for a team', async () => {
      const mockTasks = [
        { id: '1', subject: 'Implement feature', status: 'in_progress', owner: 'dev-1' },
        { id: '2', subject: 'Write tests', status: 'pending', owner: null },
      ];
      harness.ctx.teamWatcher.getTeamTasks.mockReturnValue(mockTasks);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/teams/team-alpha/tasks',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].subject).toBe('Implement feature');
      expect(body.data[1].status).toBe('pending');
    });
  });
});
