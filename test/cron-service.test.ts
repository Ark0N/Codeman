/**
 * @fileoverview Tests for CronService — the CRUD/bookkeeping + due-tick
 * state machine of the cron. The pure next-run math lives in
 * cron-time.test.ts; this exercises the service that sits on top of it.
 *
 * Launch attempts are steered down the "Session launch failed" path (the mock
 * deps lack the session-construction config getters) so no real Session/tmux
 * objects are constructed — we assert the scheduling state machine (due
 * detection, dedup guard, schedule advance, once-completion, concurrency skip,
 * auto-close, run-history recording), not the session layer it reuses.
 *
 * Port: N/A (no HTTP server).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CronService,
  clampCronExternalCliConfigs,
  deliverCronPrompt,
  type CronDeps,
} from '../src/cron/cron-service.js';
import { CRON_PASTE_ENTER_DELAY_MS } from '../src/config/server-timing.js';
import { CronJobSchema } from '../src/web/schemas.js';
import { MAX_CRON_JOBS } from '../src/config/map-limits.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';
import type { CronJobInput } from '../src/cron/cron-input.js';

const MISSING_DIR = '/nonexistent-codeman-cron-test-dir';
/** A real dir: createJob/updateJob validate workingDir existence up front. */
const VALID_DIR = mkdtempSync(join(tmpdir(), 'codeman-cron-wd-'));
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

type FakeSession = { mode: string; status?: string };

function makeStore() {
  const jobs: Record<string, CronJob> = {};
  const runs: Record<string, CronJobRun> = {};
  return {
    getCronJobs: () => jobs,
    getCronJob: (id: string) => jobs[id] ?? null,
    setCronJob: (id: string, j: CronJob) => {
      jobs[id] = j;
    },
    removeCronJob: (id: string) => {
      delete jobs[id];
    },
    getCronJobRuns: () => runs,
    setCronJobRun: (id: string, r: CronJobRun) => {
      runs[id] = r;
    },
    removeCronJobRun: (id: string) => {
      delete runs[id];
    },
    incrementSessionsCreated: vi.fn(),
  };
}

function makeService(sessions = new Map<string, FakeSession>()) {
  const store = makeStore();
  const broadcast = vi.fn();
  const cleanupSession = vi.fn(async (id: string) => {
    sessions.delete(id);
  });
  const deps = {
    store,
    broadcast,
    sessions,
    cleanupSession,
  } as unknown as CronDeps;
  return { service: new CronService(deps), store, broadcast, sessions, cleanupSession };
}

function mkInput(overrides: Partial<CronJobInput> = {}): CronJobInput {
  return {
    name: 'job',
    agentType: 'claude',
    workingDir: VALID_DIR,
    promptMode: 'inline_text',
    promptText: 'hello',
    inputMode: 'typed',
    scheduleType: 'interval',
    intervalMinutes: 10,
    enabled: true,
    concurrencyPolicy: 'warn_only',
    ...overrides,
  };
}

describe('CronService', () => {
  let svc: ReturnType<typeof makeService>;

  beforeEach(() => {
    svc = makeService();
  });

  describe('createJob', () => {
    it('computes nextRunAt for an enabled interval job', () => {
      const before = Date.now();
      const job = svc.service.createJob(mkInput({ intervalMinutes: 10 }));
      expect(job.id).toBeTruthy();
      expect(job.nextRunAt).not.toBeNull();
      expect(job.nextRunAt!).toBeGreaterThanOrEqual(before + 10 * 60_000);
      expect(job.lastRunAt).toBeNull();
      expect(job.lastStatus).toBeNull();
    });

    it('leaves nextRunAt null for a disabled job', () => {
      const job = svc.service.createJob(mkInput({ enabled: false }));
      expect(job.nextRunAt).toBeNull();
    });

    it('uses the absolute runAt for a one-time job', () => {
      const runAt = Date.now() + 3_600_000;
      const job = svc.service.createJob(mkInput({ scheduleType: 'once', runAt, intervalMinutes: undefined }));
      expect(job.nextRunAt).toBe(runAt);
    });
  });

  describe('setEnabled', () => {
    it('clears nextRunAt when disabling and recomputes when re-enabling', () => {
      const job = svc.service.createJob(mkInput());
      const disabled = svc.service.setEnabled(job.id, false);
      expect(disabled!.nextRunAt).toBeNull();
      const reenabled = svc.service.setEnabled(job.id, true);
      expect(reenabled!.nextRunAt).not.toBeNull();
    });

    it('returns null for an unknown id', () => {
      expect(svc.service.setEnabled('nope', true)).toBeNull();
    });
  });

  describe('updateJob', () => {
    it('clears the dup-guard and preserves createdAt', () => {
      const job = svc.service.createJob(mkInput({ intervalMinutes: 10 }));
      job.lastDueKey = 'stale';
      svc.store.setCronJob(job.id, job);
      const updated = svc.service.updateJob(job.id, { name: 'renamed' });
      expect(updated!.name).toBe('renamed');
      expect(updated!.lastDueKey).toBeNull();
      expect(updated!.createdAt).toBe(job.createdAt);
    });

    it('does NOT re-fire a completed once-job when editing a non-schedule field', async () => {
      const job = svc.service.createJob(
        mkInput({ scheduleType: 'once', runAt: Date.now() - 1000, intervalMinutes: undefined })
      );
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.getJob(job.id)!.completedOnce).toBe(true);

      const updated = svc.service.updateJob(job.id, { name: 'renamed' });
      expect(updated!.name).toBe('renamed');
      // Cosmetic edit must not resurrect a fired one-time job.
      expect(updated!.completedOnce).toBe(true);
      expect(updated!.nextRunAt).toBeNull();
    });

    it('does NOT resurrect a fired once-job when the edit form round-trips the unchanged schedule', async () => {
      // Reproduces the real UI flow: the edit modal re-sends the FULL job
      // (scheduleType + runAt unchanged) on every save. A field-presence check
      // would wrongly re-arm; we compare VALUES, so an unchanged schedule does not.
      const runAt = Date.now() - 1000;
      const job = svc.service.createJob(mkInput({ scheduleType: 'once', runAt, intervalMinutes: undefined }));
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.getJob(job.id)!.completedOnce).toBe(true);

      // Full-body edit changing only the name; schedule values identical.
      const updated = svc.service.updateJob(job.id, { name: 'renamed', scheduleType: 'once', runAt, enabled: false });
      expect(updated!.completedOnce).toBe(true);

      // Even re-enabling afterward must not bring the dead job back to life.
      const reenabled = svc.service.setEnabled(job.id, true);
      expect(reenabled!.nextRunAt).toBeNull();
    });

    it('re-arms a completed once-job when the schedule itself is edited', async () => {
      const job = svc.service.createJob(
        mkInput({ scheduleType: 'once', runAt: Date.now() - 1000, intervalMinutes: undefined })
      );
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.getJob(job.id)!.completedOnce).toBe(true);

      const future = Date.now() + 3_600_000;
      const updated = svc.service.updateJob(job.id, { runAt: future, enabled: true });
      expect(updated!.completedOnce).toBe(false);
      expect(updated!.nextRunAt).toBe(future);
    });

    it('rejects a partial update that leaves an inconsistent schedule (no dead enabled job)', () => {
      const job = svc.service.createJob(mkInput({ scheduleType: 'interval', intervalMinutes: 10 }));
      // Switch to 'once' WITHOUT a runAt → would otherwise yield a dead nextRunAt:null.
      expect(() => svc.service.updateJob(job.id, { scheduleType: 'once', intervalMinutes: undefined })).toThrow();
      // The stored job is left untouched.
      const after = svc.service.getJob(job.id)!;
      expect(after.scheduleType).toBe('interval');
      expect(after.nextRunAt).not.toBeNull();
    });
  });

  describe('deleteJob', () => {
    it('removes the job and its run history', async () => {
      const job = svc.service.createJob(
        mkInput({ scheduleType: 'once', runAt: Date.now() - 1000, intervalMinutes: undefined })
      );
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.listRuns(job.id).length).toBe(1);
      expect(svc.service.deleteJob(job.id)).toBe(true);
      expect(svc.service.getJob(job.id)).toBeNull();
      expect(svc.service.listRuns(job.id).length).toBe(0);
    });

    it('returns false for an unknown id', () => {
      expect(svc.service.deleteJob('nope')).toBe(false);
    });
  });

  describe('listRuns', () => {
    it('returns runs newest-first and filters by job id', async () => {
      const a = svc.service.createJob(
        mkInput({ name: 'a', scheduleType: 'once', runAt: Date.now() - 1000, intervalMinutes: undefined })
      );
      const b = svc.service.createJob(
        mkInput({ name: 'b', scheduleType: 'once', runAt: Date.now() - 1000, intervalMinutes: undefined })
      );
      await svc.service.runNow(a.id);
      await svc.service.runNow(b.id);
      const all = svc.service.listRuns();
      expect(all.length).toBe(2);
      expect(all[0].startedAt).toBeGreaterThanOrEqual(all[1].startedAt);
      expect(svc.service.listRuns(a.id).every((r) => r.cronJobId === a.id)).toBe(true);
    });
  });

  describe('init', () => {
    it('recomputes nextRunAt for enabled jobs missing one, but skips a completed once-job', () => {
      const live = svc.service.createJob(mkInput());
      live.nextRunAt = null;
      svc.store.setCronJob(live.id, live);

      const dead = svc.service.createJob(
        mkInput({ scheduleType: 'once', runAt: Date.now(), intervalMinutes: undefined })
      );
      dead.completedOnce = true;
      dead.nextRunAt = null;
      svc.store.setCronJob(dead.id, dead);

      svc.service.init();
      expect(svc.service.getJob(live.id)!.nextRunAt).not.toBeNull();
      expect(svc.service.getJob(dead.id)!.nextRunAt).toBeNull();
    });
  });

  describe('tickDueJobs', () => {
    it('fires a due one-time job exactly once and disables it', async () => {
      const runAt = Date.now() - 5000;
      const job = svc.service.createJob(mkInput({ scheduleType: 'once', runAt, intervalMinutes: undefined }));

      await svc.service.tickDueJobs(Date.now());
      await flush();

      const after = svc.service.getJob(job.id)!;
      expect(after.completedOnce).toBe(true);
      expect(after.enabled).toBe(false);
      expect(after.nextRunAt).toBeNull();
      const runs = svc.service.listRuns(job.id);
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe('failed'); // mock deps can't construct a Session → fails at launch

      // A second tick must not re-fire it.
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.listRuns(job.id).length).toBe(1);
    });

    it('advances an interval job to a future nextRunAt after firing', async () => {
      const job = svc.service.createJob(mkInput({ intervalMinutes: 10 }));
      const fireAt = job.nextRunAt! + 1000;

      await svc.service.tickDueJobs(fireAt);
      await flush();

      const after = svc.service.getJob(job.id)!;
      expect(after.enabled).toBe(true);
      expect(after.nextRunAt!).toBeGreaterThan(fireAt);
      expect(after.lastDueKey).not.toBeNull();
      expect(svc.service.listRuns(job.id).length).toBe(1);
    });

    it('does not fire a job whose nextRunAt is still in the future', async () => {
      const job = svc.service.createJob(mkInput({ intervalMinutes: 60 }));
      await svc.service.tickDueJobs(Date.now());
      await flush();
      expect(svc.service.listRuns(job.id).length).toBe(0);
    });

    it('skips an automatic run when concurrency policy is skip_if_same_agent_running', async () => {
      const sessions = new Map<string, { mode: string }>([['s1', { mode: 'claude' }]]);
      const local = makeService(sessions);
      const job = local.service.createJob(
        mkInput({ agentType: 'claude', concurrencyPolicy: 'skip_if_same_agent_running', intervalMinutes: 10 })
      );
      const fireAt = job.nextRunAt! + 1000;

      await local.service.tickDueJobs(fireAt);
      await flush();

      // A 'skipped' run is recorded (so the history isn't silently empty), and
      // the schedule still advanced past the skipped slot.
      const runs = local.service.listRuns(job.id);
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe('skipped');
      const after = local.service.getJob(job.id)!;
      expect(after.lastStatus).toBe('skipped');
      // A skip is not a run: lastRunAt must NOT advance.
      expect(after.lastRunAt).toBeNull();
      expect(after.nextRunAt!).toBeGreaterThan(fireAt);
      expect(after.lastDueKey).not.toBeNull();
    });

    it('coalesces consecutive skips — a perpetually-skipped job does not flood run history', async () => {
      const sessions = new Map<string, { mode: string }>([['s1', { mode: 'claude' }]]);
      const local = makeService(sessions);
      const job = local.service.createJob(
        mkInput({ agentType: 'claude', concurrencyPolicy: 'skip_if_same_agent_running', intervalMinutes: 10 })
      );

      // Drive 50 due ticks; the same-mode session keeps it skipped every time.
      for (let i = 0; i < 50; i++) {
        const due = local.service.getJob(job.id)!.nextRunAt! + 1;
        await local.service.tickDueJobs(due);
        await flush();
      }

      // Exactly ONE skipped run is recorded for the whole skip streak.
      expect(local.service.listRuns(job.id).length).toBe(1);
      expect(local.service.listRuns(job.id)[0].status).toBe('skipped');
    });
  });

  describe('resolvePrompt path guard', () => {
    // A real workspace dir for the in-workspace / confinement cases.
    let ws: string;
    beforeEach(() => {
      ws = mkdtempSync(join(tmpdir(), 'codeman-cron-ws-'));
    });

    const fileJob = (promptFilePath: string, workingDir: string) =>
      svc.service.createJob(
        mkInput({ promptMode: 'prompt_file_path', promptFilePath, promptText: undefined, workingDir })
      );

    it('blocks a sensitive system file via the blocklist (/etc/passwd)', async () => {
      const run = await svc.service.runNow(fileJob('/etc/passwd', ws).id);
      expect(run!.status).toBe('failed');
      // Fails at prompt resolution (blocked) — content is never read.
      expect(run!.errorMessage).toMatch(/Prompt error/i);
      expect(run!.errorMessage).toMatch(/block/i);
      expect(svc.sessions.size).toBe(0);
    });

    it('blocks /proc/self/environ (server-process env exfil) via the pseudo-fs blocklist', async () => {
      const run = await svc.service.runNow(fileJob('/proc/self/environ', ws).id);
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/Prompt error/i);
      expect(run!.errorMessage).toMatch(/block/i);
    });

    it.skipIf(!existsSync('/proc/self/environ'))(
      'blocks the workingDir=/proc + /proc/self/environ confinement bypass at fire time',
      async () => {
        // Create-time validation rejects a /proc workingDir, so simulate a
        // legacy/hand-edited job by mutating the stored record directly.
        const job = fileJob('/proc/self/environ', ws);
        const stored = svc.store.getCronJob(job.id)!;
        stored.workingDir = '/proc';
        svc.store.setCronJob(stored.id, stored);
        const run = await svc.service.runNow(job.id);
        expect(run!.status).toBe('failed');
        expect(run!.errorMessage).toMatch(/Prompt error/i);
        expect(run!.errorMessage).toMatch(/blocked/i);
      }
    );

    it('blocks a regular file that lives OUTSIDE the job workspace', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'codeman-cron-outside-'));
      const file = join(outside, 'prompt.md');
      writeFileSync(file, 'do the thing');
      const run = await svc.service.runNow(fileJob(file, ws).id);
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/inside the job working directory/i);
    });

    it('blocks a non-regular file (directory) inside the workspace', async () => {
      const sub = join(ws, 'adir');
      mkdirSync(sub);
      const run = await svc.service.runNow(fileJob(sub, ws).id);
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/not a regular file/i);
    });

    it('blocks an oversized prompt file (unbounded-read DoS)', async () => {
      const file = join(ws, 'huge.md');
      writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 0x61));
      const run = await svc.service.runNow(fileJob(file, ws).id);
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/too large/i);
    });

    it('fails cleanly (no throw) when the prompt file does not exist', async () => {
      const run = await svc.service.runNow(fileJob(join(ws, 'nope.md'), ws).id);
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/Prompt error/i);
    });

    it('allows a regular prompt file INSIDE the job workspace (passes resolution)', async () => {
      const file = join(ws, 'prompt.md');
      writeFileSync(file, 'do the thing');
      const run = await svc.service.runNow(fileJob(file, ws).id);
      // Got past prompt resolution + workingDir checks; fails only at the
      // (mock-incomplete) session-launch step — NOT a prompt error.
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).not.toMatch(/Prompt error/i);
      expect(run!.errorMessage).toMatch(/Session launch failed/i);
    });

    it('blocks a symlink inside the workspace that escapes to /etc/passwd', async () => {
      const link = join(ws, 'sneaky.md');
      symlinkSync('/etc/passwd', link);
      const run = await svc.service.runNow(fileJob(link, ws).id);
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/Prompt error/i);
    });
  });

  describe('runNow', () => {
    it('awaits layout insertion and stops lifecycle work when registration rejects', async () => {
      const store = makeStore();
      const sessions = new Map<string, FakeSession>();
      let rejectRegistration!: (error: Error) => void;
      const addSession = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectRegistration = reject;
          })
      );
      const persistSessionState = vi.fn();
      const setupSessionListeners = vi.fn(async () => {});
      const service = new CronService({
        store,
        sessions,
        addSession,
        persistSessionState,
        setupSessionListeners,
        broadcast: vi.fn(),
        getGlobalNiceConfig: vi.fn(async () => undefined),
        getModelConfig: vi.fn(async () => null),
        getClaudeModeConfig: vi.fn(async () => ({})),
        getCheckpointDefaultEnabled: vi.fn(async () => true),
        mux: { backend: 'tmux' },
      } as unknown as CronDeps);
      const job = service.createJob(mkInput({ enabled: false }));

      const pending = service.runNow(job.id);
      await vi.waitFor(() => expect(addSession).toHaveBeenCalledTimes(1));
      expect(persistSessionState).not.toHaveBeenCalled();
      expect(setupSessionListeners).not.toHaveBeenCalled();

      rejectRegistration(new Error('layout capacity exceeded'));
      const run = await pending;
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/layout capacity exceeded/);
      expect(persistSessionState).not.toHaveBeenCalled();
      expect(setupSessionListeners).not.toHaveBeenCalled();
    });

    it('launches regardless of enabled/schedule state', async () => {
      const job = svc.service.createJob(mkInput({ enabled: false }));
      const run = await svc.service.runNow(job.id);
      expect(run).not.toBeNull();
      expect(run!.triggerType).toBe('manual_run_now');
      // Disabled job stays disabled; a manual run doesn't arm the schedule.
      expect(svc.service.getJob(job.id)!.enabled).toBe(false);
    });

    it('returns null for an unknown id', async () => {
      expect(await svc.service.runNow('nope')).toBeNull();
    });
  });

  describe('workingDir validation (create/update)', () => {
    it('rejects a nonexistent workingDir at create', () => {
      expect(() => svc.service.createJob(mkInput({ workingDir: MISSING_DIR }))).toThrow(/does not exist/);
    });

    it('rejects blocked trees and the filesystem root at create', () => {
      expect(() => svc.service.createJob(mkInput({ workingDir: '/etc' }))).toThrow(/not allowed/);
      expect(() => svc.service.createJob(mkInput({ workingDir: '/' }))).toThrow(/not allowed/);
    });

    it('rejects an invalid workingDir on update and leaves the job untouched', () => {
      const job = svc.service.createJob(mkInput());
      expect(() => svc.service.updateJob(job.id, { workingDir: MISSING_DIR })).toThrow(/does not exist/);
      expect(svc.service.getJob(job.id)!.workingDir).toBe(VALID_DIR);
    });
  });

  describe('single-line prompt enforcement', () => {
    it('schema rejects a multi-line promptText and launchCommand', () => {
      expect(CronJobSchema.safeParse(mkInput({ promptText: 'a\nb' })).success).toBe(false);
      expect(CronJobSchema.safeParse(mkInput({ agentType: 'shell', launchCommand: 'a\nb' })).success).toBe(false);
      expect(CronJobSchema.safeParse(mkInput()).success).toBe(true);
    });

    it('fails the run when a legacy job carries a multi-line promptText', async () => {
      const job = svc.service.createJob(mkInput());
      const stored = svc.store.getCronJob(job.id)!;
      stored.promptText = 'line one\nline two';
      svc.store.setCronJob(stored.id, stored);
      const run = await svc.service.runNow(job.id);
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/single line/i);
    });

    it('fails the run when the prompt file is multi-line', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'codeman-cron-ml-'));
      const file = join(ws, 'prompt.md');
      writeFileSync(file, 'line one\nline two\n');
      const job = svc.service.createJob(
        mkInput({ promptMode: 'prompt_file_path', promptFilePath: file, promptText: undefined, workingDir: ws })
      );
      const run = await svc.service.runNow(job.id);
      expect(run!.status).toBe('failed');
      expect(run!.errorMessage).toMatch(/single line/i);
    });

    it('tolerates trailing newlines in a prompt file (every editor writes one)', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'codeman-cron-tn-'));
      const file = join(ws, 'prompt.md');
      writeFileSync(file, 'do the thing\n');
      const job = svc.service.createJob(
        mkInput({ promptMode: 'prompt_file_path', promptFilePath: file, promptText: undefined, workingDir: ws })
      );
      const run = await svc.service.runNow(job.id);
      // Past prompt resolution; fails only at the mock-incomplete session step.
      expect(run!.errorMessage).toMatch(/Session launch failed/i);
    });
  });

  describe('concurrency-skip session filtering', () => {
    const prevRun = (jobId: string, sessionId: string): CronJobRun => ({
      id: `r-${sessionId}`,
      cronJobId: jobId,
      sessionId,
      sessionName: 'job',
      startedAt: Date.now() - 60_000,
      finishedAt: Date.now() - 59_000,
      status: 'prompt_sent',
      triggerType: 'scheduled',
      createdSessionUrl: null,
    });

    it('does not skip when the only same-mode sessions are stopped/error (dead tabs)', async () => {
      const sessions = new Map<string, FakeSession>([
        ['dead1', { mode: 'claude', status: 'stopped' }],
        ['dead2', { mode: 'claude', status: 'error' }],
      ]);
      const local = makeService(sessions);
      const job = local.service.createJob(
        mkInput({ concurrencyPolicy: 'skip_if_same_agent_running', intervalMinutes: 10 })
      );
      await local.service.tickDueJobs(job.nextRunAt! + 1000);
      await flush();
      const runs = local.service.listRuns(job.id);
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe('failed'); // launched (mock session step), NOT skipped
    });

    it("does not skip on the job's own previous-run session (no self-deadlock)", async () => {
      const sessions = new Map<string, FakeSession>([['own-1', { mode: 'claude' }]]);
      const local = makeService(sessions);
      const job = local.service.createJob(
        mkInput({ concurrencyPolicy: 'skip_if_same_agent_running', intervalMinutes: 10 })
      );
      local.store.setCronJobRun('r-own-1', prevRun(job.id, 'own-1'));
      await local.service.tickDueJobs(job.nextRunAt! + 1000);
      await flush();
      expect(local.service.listRuns(job.id)[0].status).not.toBe('skipped');
    });

    it('does not consume a skipped once-job — it stays armed and fires when unblocked', async () => {
      const sessions = new Map<string, FakeSession>([['s1', { mode: 'claude' }]]);
      const local = makeService(sessions);
      const runAt = Date.now() - 1000;
      const job = local.service.createJob(
        mkInput({
          scheduleType: 'once',
          runAt,
          intervalMinutes: undefined,
          concurrencyPolicy: 'skip_if_same_agent_running',
        })
      );

      await local.service.tickDueJobs(Date.now());
      await flush();
      let after = local.service.getJob(job.id)!;
      expect(after.lastStatus).toBe('skipped');
      expect(after.completedOnce).toBeFalsy();
      expect(after.enabled).toBe(true);
      expect(after.nextRunAt).toBe(runAt); // still armed

      // The blocking session goes away → the next tick fires the single run.
      sessions.delete('s1');
      await local.service.tickDueJobs(Date.now());
      await flush();
      after = local.service.getJob(job.id)!;
      expect(after.completedOnce).toBe(true);
      expect(after.enabled).toBe(false);
      expect(local.service.listRuns(job.id).some((r) => r.status === 'failed')).toBe(true); // it launched
    });
  });

  describe('autoClosePreviousSession', () => {
    const prevRun = (jobId: string, sessionId: string): CronJobRun => ({
      id: `r-${sessionId}`,
      cronJobId: jobId,
      sessionId,
      sessionName: 'job',
      startedAt: Date.now() - 60_000,
      finishedAt: Date.now() - 59_000,
      status: 'prompt_sent',
      triggerType: 'scheduled',
      createdSessionUrl: null,
    });

    it("closes the previous run's still-open session before launching (default on)", async () => {
      const sessions = new Map<string, FakeSession>([['prev-1', { mode: 'claude' }]]);
      const local = makeService(sessions);
      const job = local.service.createJob(mkInput({ intervalMinutes: 10 }));
      local.store.setCronJobRun('r-prev-1', prevRun(job.id, 'prev-1'));
      await local.service.runNow(job.id);
      expect(local.cleanupSession).toHaveBeenCalledWith('prev-1', true, expect.stringContaining('cron'));
      expect(sessions.has('prev-1')).toBe(false);
    });

    it('does not close anything when autoClosePreviousSession is false', async () => {
      const sessions = new Map<string, FakeSession>([['prev-1', { mode: 'claude' }]]);
      const local = makeService(sessions);
      const job = local.service.createJob(mkInput({ intervalMinutes: 10, autoClosePreviousSession: false }));
      local.store.setCronJobRun('r-prev-1', prevRun(job.id, 'prev-1'));
      await local.service.runNow(job.id);
      expect(local.cleanupSession).not.toHaveBeenCalled();
      expect(sessions.has('prev-1')).toBe(true);
    });

    it('never auto-closes for a once schedule', async () => {
      const sessions = new Map<string, FakeSession>([['prev-1', { mode: 'claude' }]]);
      const local = makeService(sessions);
      const job = local.service.createJob(
        mkInput({ scheduleType: 'once', runAt: Date.now() + 3_600_000, intervalMinutes: undefined })
      );
      local.store.setCronJobRun('r-prev-1', prevRun(job.id, 'prev-1'));
      await local.service.runNow(job.id);
      expect(local.cleanupSession).not.toHaveBeenCalled();
    });
  });

  describe('job-count cap', () => {
    it(`rejects creation beyond MAX_CRON_JOBS (${MAX_CRON_JOBS})`, () => {
      for (let i = 0; i < MAX_CRON_JOBS; i++) svc.service.createJob(mkInput({ name: `j${i}` }));
      expect(() => svc.service.createJob(mkInput({ name: 'overflow' }))).toThrow(/Maximum number of cron jobs/);
    });
  });
});

/**
 * The §6.3 clamp cron applies at FIRE time. Cron sends no per-CLI config, so a
 * missing clamp here is not "the default applies" but "the CLI's own unsafe default
 * applies", which is the whole reason gemini and pi are materialized rather than
 * left absent like codex/antigravity.
 */
describe('clampCronExternalCliConfigs', () => {
  it('leaves everything undefined for a granted owner (upstream defaults)', () => {
    expect(clampCronExternalCliConfigs('gemini', true)).toEqual({ geminiConfig: undefined, piConfig: undefined });
    expect(clampCronExternalCliConfigs('pi', true)).toEqual({ geminiConfig: undefined, piConfig: undefined });
  });

  it('materializes gemini auto_edit for a non-granted owner (its default is yolo)', () => {
    expect(clampCronExternalCliConfigs('gemini', false)).toEqual({
      geminiConfig: { approvalMode: 'auto_edit' },
      piConfig: undefined,
    });
  });

  it('materializes pi --no-approve for a non-granted owner (its default is an answerable prompt)', () => {
    expect(clampCronExternalCliConfigs('pi', false)).toEqual({
      geminiConfig: undefined,
      piConfig: { approveProjectTrust: false },
    });
  });

  it('clamps nothing for modes whose absent config already spawns safe', () => {
    for (const mode of ['claude', 'shell', 'opencode', 'codex', 'antigravity'] as const) {
      expect(clampCronExternalCliConfigs(mode, false)).toEqual({ geminiConfig: undefined, piConfig: undefined });
    }
  });
});

/**
 * Paste mode used to write `<text>\r` in one piece. Claude Code takes a raw burst of
 * about a hundred characters as a paste and turns its `\r` into a newline, so the
 * prompt sat unsent on the composer while the run said `prompt_sent`.
 */
describe('deliverCronPrompt', () => {
  const PROMPT =
    'Reply with only the word ok and nothing else, this sentence is padding to reach about one hundred chars.';

  function fakeTarget(ok = true) {
    const calls: string[] = [];
    const target = {
      write: vi.fn((d: string) => {
        calls.push(`write:${JSON.stringify(d)}`);
        return ok;
      }),
      writeViaMux: vi.fn(async (d: string) => {
        calls.push(`mux:${JSON.stringify(d)}`);
        return ok;
      }),
      verifySubmitted: vi.fn((t: string) => {
        calls.push(`verify:${JSON.stringify(t)}`);
      }),
    };
    return { target, calls };
  }
  const noWait = async (): Promise<void> => {};

  it('paste mode writes the text and its Enter separately, then arms the composer check', async () => {
    const { target, calls } = fakeTarget();
    const waits: number[] = [];

    const ok = await deliverCronPrompt(target, PROMPT, 'paste', async (ms) => {
      waits.push(ms);
      calls.push('wait');
    });

    expect(ok).toBe(true);
    expect(calls).toEqual([
      `write:${JSON.stringify(PROMPT)}`,
      'wait',
      'write:"\\r"',
      `verify:${JSON.stringify(PROMPT)}`,
    ]);
    expect(waits).toEqual([CRON_PASTE_ENTER_DELAY_MS]);
    expect(target.writeViaMux).not.toHaveBeenCalled();
  });

  it('never puts the Enter in the same write as the text', async () => {
    const { target } = fakeTarget();

    await deliverCronPrompt(target, `${PROMPT}\r`, 'paste', noWait);

    for (const [data] of target.write.mock.calls) {
      expect(data === '\r' || !data.includes('\r')).toBe(true);
    }
  });

  it('typed mode is unchanged: one mux write that carries the Enter', async () => {
    const { target, calls } = fakeTarget();

    await deliverCronPrompt(target, PROMPT, 'typed', noWait);

    expect(calls).toEqual([`mux:${JSON.stringify(`${PROMPT}\r`)}`]);
  });

  it('reports a session it could not write to, instead of claiming the prompt went out', async () => {
    const { target } = fakeTarget(false);

    expect(await deliverCronPrompt(target, PROMPT, 'paste', noWait)).toBe(false);
    expect(target.verifySubmitted).not.toHaveBeenCalled();
  });
});
