/**
 * @fileoverview Tests for TeamWatcher - Agent Teams filesystem polling
 *
 * Test port: 3150 (if server needed)
 * SAFETY: Never uses port 3000, never kills w1-codeman/w2/w3-codeman
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TeamWatcher } from '../src/team-watcher.js';
import type { TeamConfig, TeamTask, InboxMessage } from '../src/types.js';

// Unique temp dir per test run
const TEST_BASE = join(tmpdir(), `codeman-test-teams-${randomUUID().substring(0, 8)}`);
const TEAMS_DIR = join(TEST_BASE, 'teams');
const TASKS_DIR = join(TEST_BASE, 'tasks');

function createTeamConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: 'test-team',
    createdAt: Date.now(),
    leadAgentId: 'team-lead@test-team',
    leadSessionId: 'session-123',
    members: [
      {
        agentId: 'team-lead@test-team',
        name: 'team-lead',
        agentType: 'team-lead',
        joinedAt: Date.now(),
      },
      {
        agentId: 'researcher@test-team',
        name: 'researcher',
        agentType: 'general-purpose',
        color: 'blue',
        backendType: 'in-process',
        joinedAt: Date.now(),
      },
      {
        agentId: 'coder@test-team',
        name: 'coder',
        agentType: 'general-purpose',
        color: 'green',
        backendType: 'in-process',
        joinedAt: Date.now(),
      },
    ],
    ...overrides,
  };
}

function createTask(id: string, status: 'pending' | 'in_progress' | 'completed', owner?: string): TeamTask {
  return {
    id,
    subject: `Task ${id}`,
    description: `Description for task ${id}`,
    activeForm: `Working on task ${id}`,
    status,
    owner,
    blocks: [],
    blockedBy: [],
  };
}

function writeTeamConfig(teamName: string, config: TeamConfig): void {
  const dir = join(TEAMS_DIR, teamName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
}

function writeTask(teamName: string, task: TeamTask): void {
  const dir = join(TASKS_DIR, teamName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${task.id}.json`), JSON.stringify(task));
}

function writeInbox(teamName: string, member: string, messages: InboxMessage[]): void {
  const dir = join(TEAMS_DIR, teamName, 'inboxes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${member}.json`), JSON.stringify(messages));
}

describe('TeamWatcher', () => {
  let watcher: TeamWatcher;

  beforeEach(() => {
    // Clean and recreate
    if (existsSync(TEST_BASE)) {
      rmSync(TEST_BASE, { recursive: true, force: true });
    }
    mkdirSync(TEAMS_DIR, { recursive: true });
    mkdirSync(TASKS_DIR, { recursive: true });
    watcher = new TeamWatcher(TEAMS_DIR, TASKS_DIR);
  });

  afterEach(() => {
    watcher.stop();
    if (existsSync(TEST_BASE)) {
      rmSync(TEST_BASE, { recursive: true, force: true });
    }
  });

  describe('Team discovery', () => {
    it('should discover a team from config.json', async () => {
      const config = createTeamConfig();
      writeTeamConfig('test-team', config);

      const created = new Promise<TeamConfig>(resolve => {
        watcher.on('teamCreated', resolve);
      });

      watcher.start();
      const team = await created;

      expect(team.name).toBe('test-team');
      expect(team.leadSessionId).toBe('session-123');
      expect(team.members).toHaveLength(3);
    });

    it('should return teams via getTeams()', async () => {
      writeTeamConfig('alpha', createTeamConfig({ name: 'alpha' }));
      writeTeamConfig('beta', createTeamConfig({ name: 'beta', leadSessionId: 'session-456' }));

      const events: TeamConfig[] = [];
      watcher.on('teamCreated', (t: TeamConfig) => events.push(t));

      watcher.start();
      // Wait for first poll
      await new Promise(r => setTimeout(r, 100));

      const teams = watcher.getTeams();
      expect(teams).toHaveLength(2);
    });

    it('should match team to session via getTeamForSession()', async () => {
      writeTeamConfig('test-team', createTeamConfig({ leadSessionId: 'my-session' }));

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      expect(watcher.getTeamForSession('my-session')).toBeDefined();
      expect(watcher.getTeamForSession('other-session')).toBeUndefined();
    });

    it('should emit teamUpdated when config changes', async () => {
      const config = createTeamConfig();
      writeTeamConfig('test-team', config);

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      const updated = new Promise<TeamConfig>(resolve => {
        watcher.on('teamUpdated', resolve);
      });

      // Modify config (add a member)
      config.members.push({
        agentId: 'writer@test-team',
        name: 'writer',
        agentType: 'general-purpose',
        color: 'yellow',
        joinedAt: Date.now(),
      });
      // Small delay to ensure different mtime
      await new Promise(r => setTimeout(r, 50));
      writeTeamConfig('test-team', config);

      const team = await updated;
      expect(team.members).toHaveLength(4);
    });

    it('should emit teamRemoved when directory deleted', async () => {
      writeTeamConfig('test-team', createTeamConfig());

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      expect(watcher.getTeams()).toHaveLength(1);

      const removed = new Promise<TeamConfig>(resolve => {
        watcher.on('teamRemoved', resolve);
      });

      rmSync(join(TEAMS_DIR, 'test-team'), { recursive: true, force: true });

      const team = await removed;
      expect(team.name).toBe('test-team');
      expect(watcher.getTeams()).toHaveLength(0);
    });
  });

  describe('Task tracking', () => {
    it('should read tasks from task directory', async () => {
      writeTeamConfig('test-team', createTeamConfig());
      writeTask('test-team', createTask('1', 'in_progress', 'researcher'));
      writeTask('test-team', createTask('2', 'pending'));

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      const tasks = watcher.getTeamTasks('test-team');
      expect(tasks).toHaveLength(2);
    });

    it('should count active tasks', async () => {
      writeTeamConfig('test-team', createTeamConfig());
      writeTask('test-team', createTask('1', 'in_progress', 'researcher'));
      writeTask('test-team', createTask('2', 'completed', 'coder'));
      writeTask('test-team', createTask('3', 'pending'));

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      expect(watcher.getActiveTaskCount('test-team')).toBe(2); // in_progress + pending
    });

    it('should filter out internal tasks', async () => {
      writeTeamConfig('test-team', createTeamConfig());
      writeTask('test-team', createTask('1', 'in_progress', 'researcher'));

      const internalTask: TeamTask = {
        ...createTask('2', 'in_progress'),
        metadata: { _internal: true },
      };
      const dir = join(TASKS_DIR, 'test-team');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '2.json'), JSON.stringify(internalTask));

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      const tasks = watcher.getTeamTasks('test-team');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('1');
    });
  });

  describe('Active teammates detection', () => {
    it('should detect active teammates when tasks exist', async () => {
      writeTeamConfig('test-team', createTeamConfig({ leadSessionId: 'session-abc' }));
      writeTask('test-team', createTask('1', 'in_progress', 'researcher'));

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      expect(watcher.hasActiveTeammates('session-abc')).toBe(true);
    });

    it('should return false when all tasks completed', async () => {
      writeTeamConfig('test-team', createTeamConfig({ leadSessionId: 'session-abc' }));
      writeTask('test-team', createTask('1', 'completed', 'researcher'));

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      expect(watcher.hasActiveTeammates('session-abc')).toBe(false);
    });

    it('should return false for unknown sessions', () => {
      expect(watcher.hasActiveTeammates('nonexistent')).toBe(false);
    });

    it('should return correct teammate count', async () => {
      writeTeamConfig('test-team', createTeamConfig({ leadSessionId: 'session-abc' }));

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      expect(watcher.getActiveTeammateCount('session-abc')).toBe(2); // researcher + coder
      expect(watcher.getActiveTeammateCount('nonexistent')).toBe(0);
    });
  });

  describe('Inbox tracking', () => {
    it('should read inbox messages', async () => {
      writeTeamConfig('test-team', createTeamConfig());

      const messages: InboxMessage[] = [
        { from: 'team-lead', text: '{"type":"task_assignment"}', timestamp: new Date().toISOString(), read: false },
      ];
      writeInbox('test-team', 'researcher', messages);

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      const inbox = watcher.getInboxMessages('test-team', 'researcher');
      expect(inbox).toHaveLength(1);
      expect(inbox[0].from).toBe('team-lead');
    });

    it('should emit inboxMessage for new messages', async () => {
      writeTeamConfig('test-team', createTeamConfig());
      writeInbox('test-team', 'researcher', []);

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      const received = new Promise<{ teamName: string; member: string; message: InboxMessage }>(resolve => {
        watcher.on('inboxMessage', resolve);
      });

      // Add a new message
      await new Promise(r => setTimeout(r, 50));
      const messages: InboxMessage[] = [
        { from: 'team-lead', text: '{"type":"task_assignment"}', timestamp: new Date().toISOString(), read: false },
      ];
      writeInbox('test-team', 'researcher', messages);

      const event = await received;
      expect(event.teamName).toBe('test-team');
      expect(event.member).toBe('researcher');
      expect(event.message.from).toBe('team-lead');
    });
  });

  describe('Lock handling', () => {
    it('should skip locked config files', async () => {
      writeTeamConfig('test-team', createTeamConfig());
      // Create a lock directory before starting
      mkdirSync(join(TEAMS_DIR, 'test-team', 'config.json.lock'));

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      // Should not discover the team because it's locked
      expect(watcher.getTeams()).toHaveLength(0);
    });

    it('should discover team after lock is released', async () => {
      // Start with locked config
      writeTeamConfig('test-team', createTeamConfig());
      mkdirSync(join(TEAMS_DIR, 'test-team', 'config.json.lock'));

      watcher.start();
      await new Promise(r => setTimeout(r, 100));
      expect(watcher.getTeams()).toHaveLength(0);

      // Stop, remove lock, restart (fresh mtime cache)
      watcher.stop();
      rmSync(join(TEAMS_DIR, 'test-team', 'config.json.lock'), { recursive: true });

      watcher = new TeamWatcher(TEAMS_DIR, TASKS_DIR);
      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      expect(watcher.getTeams()).toHaveLength(1);
    });
  });

  describe('Cleanup', () => {
    it('should clear all state on stop()', async () => {
      writeTeamConfig('test-team', createTeamConfig());
      writeTask('test-team', createTask('1', 'in_progress'));

      watcher.start();
      await new Promise(r => setTimeout(r, 100));

      expect(watcher.getTeams()).toHaveLength(1);

      watcher.stop();

      expect(watcher.getTeams()).toHaveLength(0);
      expect(watcher.getTeamTasks('test-team')).toHaveLength(0);
    });
  });
});
