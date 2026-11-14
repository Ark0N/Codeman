/**
 * @fileoverview Pins bounded fs.watch failure handling and polling fallback after a production chokidar retry loop flooded logs and synchronous close caused unhandled rejections.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamWatcher } from '../src/team-watcher.js';
import { WorkflowRunWatcher } from '../src/workflow-run-watcher.js';
import { TEAM_POLL_INTERVAL_MS } from '../src/config/team-config.js';
import { WORKFLOW_RUN_POLL_INTERVAL_MS } from '../src/config/workflow-config.js';
import type { TeamConfig } from '../src/types.js';
import type { WorkflowRunInfo } from '../src/types/workflow-run.js';

const FAILURES = [
  { code: 'EMFILE', errno: -24, text: 'too many open files' },
  { code: 'ENOSPC', errno: -28, text: 'no space left on device' },
] as const;
type WatchFailure = (typeof FAILURES)[number];

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(10);
  }
}

function watchError(failure: WatchFailure, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${failure.code}: ${failure.text}, watch '${path}'`), {
    code: failure.code,
    errno: failure.errno,
    syscall: 'watch',
    path,
  });
}

function failEveryWatch(failure: WatchFailure) {
  return vi.spyOn(fs, 'watch').mockImplementation((path) => {
    throw watchError(failure, String(path));
  });
}

let tempDir: string;
let watcher: TeamWatcher | WorkflowRunWatcher | undefined;
let warn: ReturnType<typeof vi.spyOn<typeof console, 'warn'>>;
let error: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;
let unhandled: unknown[];
let onUnhandled: (reason: unknown) => void;

beforeEach(async () => {
  watcher = undefined;
  tempDir = await mkdtemp(join(tmpdir(), 'codeman-watch-failure-'));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  unhandled = [];
  onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  try {
    watcher?.stop();
    // Keep mocks and the rejection listener installed while asynchronous close settles.
    await delay(100);
    await rm(tempDir, { recursive: true, force: true });
  } finally {
    process.off('unhandledRejection', onUnhandled);
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

function createTeamConfig(): TeamConfig {
  return {
    name: 'test-team',
    createdAt: 1_700_000_000_000,
    leadAgentId: 'team-lead@test-team',
    leadSessionId: 'session-123',
    members: [
      {
        agentId: 'team-lead@test-team',
        name: 'team-lead',
        agentType: 'team-lead',
        joinedAt: 1_700_000_000_000,
      },
    ],
  };
}

async function writeTeam(teamsDir: string, config: TeamConfig): Promise<void> {
  const dir = join(teamsDir, config.name);
  await mkdir(dir);
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
}

describe('TeamWatcher fs.watch failure', () => {
  let teamsDir: string;
  let tasksDir: string;
  let teamWatcher: TeamWatcher;

  beforeEach(async () => {
    teamsDir = join(tempDir, 'teams');
    tasksDir = join(tempDir, 'tasks');
    await mkdir(teamsDir);
    await mkdir(tasksDir);
    watcher = teamWatcher = new TeamWatcher(teamsDir, tasksDir);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  it.each(FAILURES)('$code stops both watchers with two warnings and keeps polling', async (failure) => {
    const watch = failEveryWatch(failure);
    try {
      teamWatcher.start();
      await waitUntil(() => warn.mock.calls.length >= 2, 'timed out waiting for both watcher warnings');
      const attempts = watch.mock.calls.length;
      await delay(500);

      // Check counts before arguments so the unfixed log storm cannot flood failure output.
      expect(warn).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledTimes(0);
      for (const call of warn.mock.calls) expect(call.length).toBe(1);
      expect(warn.mock.calls.map(([message]) => message).sort()).toEqual(
        [
          `[TeamWatcher] teams watcher stopped, relying on polling: ${watchError(failure, teamsDir).message}`,
          `[TeamWatcher] tasks watcher stopped, relying on polling: ${watchError(failure, tasksDir).message}`,
        ].sort()
      );
      expect(watch.mock.calls.length).toBe(attempts);
      expect(attempts).toBeGreaterThanOrEqual(2);
      // Allow a handful of in-flight attempts, but never an ancestor retry loop.
      expect(attempts).toBeLessThanOrEqual(6);
      expect(unhandled.length).toBe(0);

      const config = createTeamConfig();
      await writeTeam(teamsDir, config);
      expect(teamWatcher.getTeams()).toEqual([]);
      vi.advanceTimersByTime(TEAM_POLL_INTERVAL_MS);
      await waitUntil(() => teamWatcher.getTeams().length > 0, 'polling did not discover the new team');
      expect(teamWatcher.getTeams()).toEqual([config]);
      expect(watch.mock.calls.length).toBe(attempts);
      expect(warn).toHaveBeenCalledTimes(2);

      expect(() => teamWatcher.stop()).not.toThrow();
      await delay(500);
      expect(watch.mock.calls.length).toBe(attempts);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledTimes(0);
      expect(unhandled.length).toBe(0);
    } finally {
      teamWatcher.stop();
    }
  });

  it('keeps a healthy watcher active and discovers a new team before the poll interval', async () => {
    try {
      teamWatcher.start();
      await delay(200);
      const config = createTeamConfig();
      await writeTeam(teamsDir, config);
      // No interval is advanced: discovery must come from the real filesystem watcher.
      await waitUntil(() => teamWatcher.getTeams().length > 0, 'healthy watcher did not discover the new team');
      expect(teamWatcher.getTeams()).toEqual([config]);
      teamWatcher.stop();
      await delay(100);
      expect(warn).toHaveBeenCalledTimes(0);
      expect(error).toHaveBeenCalledTimes(0);
      expect(unhandled.length).toBe(0);
    } finally {
      teamWatcher.stop();
    }
  });
});

describe('TeamWatcher in-flight fs.watch failure', () => {
  it('stays stopped when file replacement and deletion race with ENOSPC', async () => {
    const teamsDir = join(tempDir, 'teams');
    const tasksDir = join(tempDir, 'tasks');
    const teamDir = join(teamsDir, 't');
    await mkdir(teamDir, { recursive: true });
    await mkdir(tasksDir);
    await writeFile(join(teamDir, 'a.json'), '{}');
    await writeFile(join(teamDir, 'b.json'), '{}');
    const teamWatcher = new TeamWatcher(teamsDir, tasksDir);
    watcher = teamWatcher;
    const realWatch = fs.watch;
    const listeners = new Map<string, fs.WatchListener<string | Buffer>>();
    const watch = vi.spyOn(fs, 'watch').mockImplementation((...args) => {
      const handle = realWatch(...args);
      if (args[2]) listeners.set(String(args[0]), args[2]);
      return handle;
    });
    let firstFailure: NodeJS.ErrnoException | undefined;
    let failingCalls = 0;

    try {
      teamWatcher.start();
      await waitUntil(
        () => listeners.has(join(teamDir, 'a.json')) && listeners.has(join(teamDir, 'b.json')),
        'timed out waiting for both file watches'
      );
      expect(warn).toHaveBeenCalledTimes(0);
      expect(error).toHaveBeenCalledTimes(0);
      watch.mockImplementation((...args) => {
        // Bound the unfixed retry loop so it can recover and the test can finish.
        if (failingCalls >= 2000) return realWatch(...args);
        failingCalls++;
        const failure = watchError(FAILURES[1], String(args[0]));
        firstFailure ??= failure;
        throw failure;
      });

      fs.writeFileSync(join(teamDir, 'b.json.tmp'), '{"replaced":true}');
      fs.renameSync(join(teamDir, 'b.json.tmp'), join(teamDir, 'b.json'));
      await waitUntil(() => warn.mock.calls.length > 0, 'timed out waiting for the teams watcher warning');
      // Deliver the queued deletion callback only after the replacement failure stops the watcher.
      fs.unlinkSync(join(teamDir, 'a.json'));
      listeners.get(join(teamDir, 'a.json'))!('rename', 'a.json');
      await delay(1000);
      const attempts = watch.mock.calls.length;
      const failures = failingCalls;
      await delay(500);
      const settledAttempts = watch.mock.calls.length;
      const settledFailures = failingCalls;
      const warnings = warn.mock.calls.length;

      teamWatcher.stop();
      await delay(500);

      // Check counts before arguments so a retry storm cannot flood failure output.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warnings).toBe(1);
      expect(error).toHaveBeenCalledTimes(0);
      expect(unhandled.length).toBe(0);
      expect(watch.mock.calls.length).toBe(settledAttempts);
      expect(failingCalls).toBe(settledFailures);
      expect(settledAttempts).toBe(attempts);
      expect(settledFailures).toBe(failures);
      expect(failures).toBeGreaterThanOrEqual(1);
      expect(failures).toBeLessThanOrEqual(6);
      expect(firstFailure?.code).toBe('ENOSPC');
      expect(firstFailure?.path?.startsWith(`${teamDir}/`)).toBe(true);
      expect(warn.mock.calls).toEqual([
        [`[TeamWatcher] teams watcher stopped, relying on polling: ${firstFailure?.message}`],
      ]);
    } finally {
      teamWatcher.stop();
    }
  });
});

const PROJECT_HASH = '-home-arkon-default-claudeman';
const SESSION_UUID = '388113c8-cd01-4e80-93a8-3be66ab1519b';
const RUN_ID = 'wf_test1234-abc';
const RUN_START = 1_700_000_000_000;

function sampleRunJson() {
  return {
    runId: RUN_ID,
    timestamp: new Date(RUN_START).toISOString(),
    workflowName: 'watch-failure-test',
    summary: 'Discover a run despite exhausted filesystem watches',
    status: 'completed',
    startTime: RUN_START,
    agentCount: 0,
    durationMs: 1234,
    totalTokens: 0,
    totalToolCalls: 0,
    phases: [],
    workflowProgress: [],
  };
}

const { workflowProgress: _progress, ...runFields } = sampleRunJson();
const EXPECTED_RUN: WorkflowRunInfo = {
  ...runFields,
  agents: [],
  projectHash: PROJECT_HASH,
  sessionUuid: SESSION_UUID,
  lastActivityAt: RUN_START,
};

describe('WorkflowRunWatcher fs.watch failure', () => {
  let runWatcher: WorkflowRunWatcher;
  let workflowsDir: string;

  beforeEach(async () => {
    const projectsDir = join(tempDir, 'projects');
    workflowsDir = join(projectsDir, PROJECT_HASH, SESSION_UUID, 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, `${RUN_ID}.json`), JSON.stringify(sampleRunJson()));
    watcher = runWatcher = new WorkflowRunWatcher(projectsDir);
    // Later interval polls run only when a test explicitly advances the clock.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  function firstRun(): Promise<WorkflowRunInfo> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        runWatcher.off('run_discovered', onRun);
        reject(new Error('timed out waiting for run_discovered'));
      }, 1500);
      function onRun(info: WorkflowRunInfo) {
        clearTimeout(timer);
        resolve(info);
      }
      runWatcher.once('run_discovered', onRun);
      runWatcher.start();
    });
  }

  it.each(FAILURES)('$code discovers the run without retries, logging, or unhandled rejections', async (failure) => {
    const watch = failEveryWatch(failure);
    try {
      const discovered = await firstRun();
      await delay(500);
      const attempts = watch.mock.calls.length;
      await delay(500);

      expect(unhandled.length).toBe(0);
      expect(warn).toHaveBeenCalledTimes(0);
      expect(error).toHaveBeenCalledTimes(0);
      expect(watch.mock.calls.length).toBe(attempts);
      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(attempts).toBeLessThanOrEqual(3);
      expect(discovered).toEqual(EXPECTED_RUN);
      expect(runWatcher.getRun(RUN_ID)).toEqual(EXPECTED_RUN);
      expect(runWatcher.getAllRuns()).toEqual([EXPECTED_RUN]);
      expect(runWatcher.isRunning()).toBe(true);
      runWatcher.stop();
      expect(runWatcher.isRunning()).toBe(false);
      await delay(100);
      expect(unhandled.length).toBe(0);
      expect(watch.mock.calls.length).toBe(attempts);
      expect(warn).toHaveBeenCalledTimes(0);
      expect(error).toHaveBeenCalledTimes(0);
    } finally {
      runWatcher.stop();
    }
  });

  it('retries a failed directory once per poll and resumes live discovery when fs.watch recovers', async () => {
    const watch = failEveryWatch(FAILURES[0]);
    const discovered = vi.fn();
    try {
      expect(await firstRun()).toEqual(EXPECTED_RUN);
      await delay(500);
      const attemptsPerPoll = watch.mock.calls.length;
      expect(attemptsPerPoll).toBeGreaterThanOrEqual(1);
      expect(attemptsPerPoll).toBeLessThanOrEqual(3);
      await delay(500);
      expect(watch).toHaveBeenCalledTimes(attemptsPerPoll);
      expect(warn).toHaveBeenCalledTimes(0);
      expect(error).toHaveBeenCalledTimes(0);
      expect(unhandled.length).toBe(0);

      for (const pollCount of [2, 3]) {
        vi.advanceTimersByTime(WORKFLOW_RUN_POLL_INTERVAL_MS);
        await waitUntil(
          () => watch.mock.calls.length > attemptsPerPoll * (pollCount - 1),
          'later poll did not retry the failed workflows directory'
        );
        await delay(500);
        expect(watch).toHaveBeenCalledTimes(attemptsPerPoll * pollCount);
        expect(warn).toHaveBeenCalledTimes(0);
        expect(error).toHaveBeenCalledTimes(0);
        expect(unhandled.length).toBe(0);
      }

      watch.mockRestore();
      const recoveredWatch = vi.spyOn(fs, 'watch');
      vi.advanceTimersByTime(WORKFLOW_RUN_POLL_INTERVAL_MS);
      await waitUntil(() => recoveredWatch.mock.calls.length > 0, 'recovery poll did not install a watcher');
      // Let watcher setup and the recovery poll settle before creating the new completion file.
      await delay(500);
      expect(runWatcher.getAllRuns()).toEqual([EXPECTED_RUN]);
      const otherId = 'wf_recovered5678-def';
      runWatcher.on('run_discovered', discovered);
      await writeFile(join(workflowsDir, `${otherId}.json`), JSON.stringify({ ...sampleRunJson(), runId: otherId }));
      // Do not advance the interval again: only the recovered watcher can discover this file.
      await waitUntil(() => discovered.mock.calls.length > 0, 'recovered watcher did not discover the new run');
      expect(discovered).toHaveBeenCalledTimes(1);
      const expectedRun = { ...EXPECTED_RUN, runId: otherId };
      expect(discovered).toHaveBeenCalledWith(expectedRun);
      expect(runWatcher.getRun(otherId)).toEqual(expectedRun);
      runWatcher.stop();
      await delay(100);
      expect(warn).toHaveBeenCalledTimes(0);
      expect(error).toHaveBeenCalledTimes(0);
      expect(unhandled.length).toBe(0);
    } finally {
      runWatcher.stop();
      runWatcher.off('run_discovered', discovered);
    }
  });

  it('discovers a run with a healthy watcher without logging or unhandled rejections', async () => {
    try {
      const discovered = await firstRun();
      await delay(1000);
      expect(discovered).toEqual(EXPECTED_RUN);
      expect(runWatcher.getRun(RUN_ID)).toEqual(EXPECTED_RUN);
      expect(runWatcher.getAllRuns()).toEqual([EXPECTED_RUN]);
      runWatcher.stop();
      await delay(100);
      expect(warn).toHaveBeenCalledTimes(0);
      expect(error).toHaveBeenCalledTimes(0);
      expect(unhandled.length).toBe(0);
    } finally {
      runWatcher.stop();
    }
  });
});
