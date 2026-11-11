/**
 * @fileoverview The pure half of the local model install job (src/local-model/install-job.ts):
 * the three tables, the reducer over them, and the view.
 *
 * The reducer is tested from the tables it is written against: every state is paired with
 * every event, and what `INSTALL_TRANSITIONS` says must happen is what happens (a pair the
 * table does not list hands back the very object it was given). The state table's own
 * columns (what a restart and Cancel do, which actions are allowed) are checked against the
 * reducer and the view, so the table in the file header cannot drift from the code.
 *
 * The service that drives the job is in test/local-model-install-service.test.ts.
 *
 * Port: N/A (pure functions).
 */
import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  buildInstallError,
  buildHarnessRows,
  buildInstallView,
  buildLibraryRows,
  formatInstallMessage,
  INSTALL_STATE_TABLE,
  INSTALL_STEP_TABLE,
  INSTALL_TRANSITIONS,
  installedBlocker,
  jobSteps,
  libraryOf,
  markLibraryCandidates,
  reduceInstallJob,
  upsertLibraryEntry,
  USE_JOB_STEPS,
  type InstallJobEvent,
  type InstallJobEventType,
  type InstallLiveFacts,
} from '../src/local-model/install-job.js';
import { OLLAMA_RUNTIME_PIN } from '../src/local-model/runtime.js';
import {
  LOCAL_MODEL_ERROR_LABELS,
  LOCAL_MODEL_ERROR_NEXT,
  LOCAL_MODEL_INSTALL_LABELS,
  LOCAL_MODEL_INSTALL_STEPS,
  type HarnessFact,
  type LocalHarnessEntry,
  type LocalModelAction,
  type LocalModelErrorCode,
  type LocalModelInstallState,
  type LocalModelInstallStep,
  type LocalModelLibraryEntry,
  type LocalModelStateFile,
  type Recommendation,
} from '../src/types.js';

const STATES: LocalModelInstallState[] = ['idle', 'installing', 'paused', 'failed', 'installed'];
const EVENT_TYPES: InstallJobEventType[] = [
  'install',
  'use',
  'progress',
  'step-done',
  'fail',
  'cancel',
  'restart',
  'resume',
  'remove',
];
const ALL_STEPS: LocalModelInstallStep[] = ['runtime', 'model', 'verify', 'agent', 'connect'];

const MODEL = { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', context: 131072 };
const CLI = { id: 'opencode', label: 'OpenCode' };
const RUNTIME = { version: '0.40.15', port: 11435, pid: 4711, enabled: true, measuredTotalBytes: 40_157_944_217 };
const CONNECTION = { endpointId: 'local-ollama', flagWasEnabled: false };
const LOADED = { context: 131072, sizeBytes: 26_300_000_000, sizeVramBytes: 26_300_000_000 };

/** The model in use as the library lists it, and a second checked model beside it. */
const ENTRY: LocalModelLibraryEntry = {
  id: MODEL.id,
  label: MODEL.label,
  context: MODEL.context,
  digest: 'abc123',
  bytes: 23_105_798_956,
  cli: CLI,
};
const OTHER: LocalModelLibraryEntry = {
  id: 'qwen3.8:27b-mtp-q4_k_m',
  label: 'Qwen3.8 27B',
  context: 65536,
  digest: 'def456',
  bytes: 17_741_872_154,
  cli: CLI,
};

/** The two as rows of the view, while nothing is known from the runtime. */
const ENTRY_ROW = {
  id: ENTRY.id,
  label: ENTRY.label,
  context: ENTRY.context,
  sizeBytes: 23_105_798_956,
  sizeGb: '23.1',
  active: true,
  verified: true,
  status: 'ready',
  actions: [],
};
const OTHER_ROW = {
  id: OTHER.id,
  label: OTHER.label,
  context: OTHER.context,
  sizeBytes: 17_741_872_154,
  sizeGb: '17.7',
  active: false,
  verified: true,
  status: 'ready',
  actions: ['use'],
};

const JOB: LocalModelStateFile = {
  schema: 1,
  state: 'installing',
  step: 'model',
  steps: ALL_STEPS,
  model: MODEL,
  cli: CLI,
  runtime: RUNTIME,
  progress: { completedBytes: 6_200_000_000, totalBytes: 23_105_798_956 },
  // An earlier install left one checked model: what `use` can go back to.
  library: [OTHER],
};

/** One state file of each state, as the job leaves it. */
const SAMPLE: Record<LocalModelInstallState, LocalModelStateFile> = {
  idle: { schema: 1, state: 'idle' },
  installing: JOB,
  paused: { ...JOB, state: 'paused' },
  failed: { ...JOB, state: 'failed', error: { code: 'pull-failed', detail: 'tls: bad record MAC' } },
  installed: {
    schema: 1,
    state: 'installed',
    model: { ...MODEL, pullBytes: 23_105_798_956, digest: 'abc123' },
    cli: CLI,
    runtime: RUNTIME,
    loaded: LOADED,
    library: [OTHER],
    connection: CONNECTION,
  },
};

/** One event of each type. */
const EVENT: Record<InstallJobEventType, InstallJobEvent> = {
  install: {
    type: 'install',
    model: { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', context: 65536 },
    cli: { id: 'claude', label: 'Claude Code' },
    steps: ['runtime', 'model', 'verify', 'connect'],
  },
  use: {
    type: 'use',
    model: { id: OTHER.id, label: OTHER.label, context: OTHER.context, digest: OTHER.digest },
    cli: CLI,
  },
  progress: { type: 'progress', completedBytes: 7_000_000_000, totalBytes: 23_105_798_956 },
  'step-done': { type: 'step-done' },
  fail: { type: 'fail', code: 'no-tool-call', vars: { model: 'Qwen3.6 35B-A3B' }, nextModelId: 'gpt-oss:20b' },
  cancel: { type: 'cancel' },
  restart: { type: 'restart' },
  resume: { type: 'resume' },
  remove: { type: 'remove' },
};

/** Freezes an object and everything in it, so a reducer that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

const LIVE: InstallLiveFacts = {
  running: false,
  gaveUp: false,
  portInUse: false,
  developerTools: 'present',
  runtimeInstalled: false,
  pin: OLLAMA_RUNTIME_PIN,
  folder: '/Users/me/.codeman/local-model',
};

describe('the tables', () => {
  it('have a row for every state and every step, and only for those', () => {
    expect(Object.keys(INSTALL_STATE_TABLE).sort()).toEqual([...STATES].sort());
    expect(Object.keys(INSTALL_TRANSITIONS).sort()).toEqual([...STATES].sort());
    expect(Object.keys(INSTALL_STEP_TABLE).sort()).toEqual([...LOCAL_MODEL_INSTALL_STEPS].sort());
    expect(LOCAL_MODEL_INSTALL_STEPS).toEqual(ALL_STEPS);
  });

  it('the transition table names only real events and real states', () => {
    for (const state of STATES) {
      for (const [type, target] of Object.entries(INSTALL_TRANSITIONS[state])) {
        expect(EVENT_TYPES).toContain(type);
        expect(STATES).toContain(target);
      }
    }
  });

  it('is the table of the design: these pairs and no others', () => {
    expect(INSTALL_TRANSITIONS).toEqual({
      idle: { install: 'installing', restart: 'idle', remove: 'idle' },
      installing: {
        progress: 'installing',
        'step-done': 'installing',
        fail: 'failed',
        cancel: 'paused',
        restart: 'paused',
      },
      paused: { resume: 'installing', install: 'installing', use: 'installing', remove: 'idle', restart: 'paused' },
      failed: { resume: 'installing', install: 'installing', use: 'installing', remove: 'idle', restart: 'failed' },
      installed: { install: 'installing', use: 'installing', remove: 'idle', restart: 'installed' },
    });
  });

  it('a switch is the two steps that load and connect a model, and downloads nothing', () => {
    expect(USE_JOB_STEPS).toEqual(['verify', 'connect']);
    for (const step of USE_JOB_STEPS) expect(INSTALL_STEP_TABLE[step].progress).toBe(false);
  });

  it('every step row names error codes that exist, each with a sentence and a next step', () => {
    for (const step of LOCAL_MODEL_INSTALL_STEPS) {
      const row = INSTALL_STEP_TABLE[step];
      expect(row.errors.length).toBeGreaterThan(0);
      expect(row.errors).toContain('internal');
      for (const code of row.errors) {
        expect(LOCAL_MODEL_ERROR_LABELS[code]).toBeTypeOf('string');
        expect(LOCAL_MODEL_ERROR_NEXT[code]).toBeTypeOf('string');
      }
    }
    // The two steps that download report byte progress; the others do not.
    expect(LOCAL_MODEL_INSTALL_STEPS.filter((step) => INSTALL_STEP_TABLE[step].progress)).toEqual(['runtime', 'model']);
    // The runtime must run for every step that talks to it.
    expect(LOCAL_MODEL_INSTALL_STEPS.filter((step) => INSTALL_STEP_TABLE[step].needsRuntime)).toEqual([
      'model',
      'verify',
      'connect',
    ]);
  });

  it('every error code has exactly one sentence and one next step', () => {
    const codes = Object.keys(LOCAL_MODEL_ERROR_LABELS) as LocalModelErrorCode[];
    expect(Object.keys(LOCAL_MODEL_ERROR_NEXT).sort()).toEqual([...codes].sort());
    const sentences = new Set(Object.values(LOCAL_MODEL_INSTALL_LABELS));
    for (const code of codes) expect(sentences.has(LOCAL_MODEL_ERROR_LABELS[code])).toBe(true);
  });
});

describe('jobSteps', () => {
  it('is every step in order, without the agent step when the coding agent is installed', () => {
    expect(jobSteps({ agentInstalled: false })).toEqual(['runtime', 'model', 'verify', 'agent', 'connect']);
    expect(jobSteps({ agentInstalled: true })).toEqual(['runtime', 'model', 'verify', 'connect']);
  });

  it('hands out a list of its own each time', () => {
    const steps = jobSteps({ agentInstalled: false });
    steps.pop();
    expect(jobSteps({ agentInstalled: false })).toHaveLength(5);
    expect(LOCAL_MODEL_INSTALL_STEPS).toHaveLength(5);
  });
});

describe('reduceInstallJob: every state with every event, from the transition table', () => {
  for (const state of STATES) {
    for (const type of EVENT_TYPES) {
      const target = INSTALL_TRANSITIONS[state][type];
      const current = deepFreeze(structuredClone(SAMPLE[state]));
      const event = deepFreeze(structuredClone(EVENT[type]));
      if (target === undefined) {
        it(`${state} + ${type}: refused, the same object comes back`, () => {
          expect(reduceInstallJob(current, event)).toBe(current);
        });
      } else {
        it(`${state} + ${type}: ${target}`, () => {
          const next = reduceInstallJob(current, event);
          expect(next.state).toBe(target);
          expect(next.schema).toBe(1);
          // Pure: the frozen input was not changed (a write to it would have thrown).
          expect(current).toEqual(SAMPLE[state]);
        });
      }
    }
  }

  it('covers all 45 pairs, 22 of them listed', () => {
    const listed = STATES.flatMap((state) => Object.keys(INSTALL_TRANSITIONS[state]));
    expect(STATES.length * EVENT_TYPES.length).toBe(45);
    expect(listed).toHaveLength(22);
  });
});

describe('the state table agrees with the reducer and the view', () => {
  it.each(STATES)('%s: what a server restart does', (state) => {
    const row = INSTALL_STATE_TABLE[state];
    const after = reduceInstallJob(SAMPLE[state], { type: 'restart' });
    expect(after.state).toBe(row.afterRestart);
  });

  it.each(STATES)('%s: what Cancel does', (state) => {
    const row = INSTALL_STATE_TABLE[state];
    const after = reduceInstallJob(SAMPLE[state], { type: 'cancel' });
    if (row.afterCancel === null) expect(after).toBe(SAMPLE[state]);
    else expect(after.state).toBe(row.afterCancel);
  });

  it.each(STATES)('%s: the allowed actions are the ones whose verb the reducer or the service accepts', (state) => {
    const row = INSTALL_STATE_TABLE[state];
    const accepts = (type: InstallJobEventType) => INSTALL_TRANSITIONS[state][type] !== undefined;
    expect(row.actions.includes('install')).toBe(accepts('install'));
    expect(row.actions.includes('use')).toBe(accepts('use'));
    expect(row.actions.includes('cancel')).toBe(accepts('cancel'));
    expect(row.actions.includes('resume')).toBe(accepts('resume'));
    // Remove is refused only while a job runs. From idle it only clears what an earlier
    // Remove kept, and the view lists it there only while the store holds something.
    expect(row.actions.includes('remove')).toBe(accepts('remove'));
    // A model is deleted through the runtime, which a state without a job in flight and with
    // a runtime set up can have: never idle (no runtime), never while a job runs.
    expect(row.actions.includes('delete-model')).toBe(state !== 'idle' && state !== 'installing');
    // The runtime and a session are things of an installed model only.
    for (const action of ['start', 'stop', 'start-session'] as LocalModelAction[]) {
      expect(row.actions.includes(action)).toBe(state === 'installed');
    }
  });

  it('a restart never leaves a job running, and never changes anything else', () => {
    for (const state of STATES) {
      const after = reduceInstallJob(SAMPLE[state], { type: 'restart' });
      expect(after.state).not.toBe('installing');
      if (state === 'installing') expect(after).toEqual({ ...SAMPLE.installing, state: 'paused' });
      else expect(after).toBe(SAMPLE[state]);
    }
  });
});

describe('reduceInstallJob: what each event writes', () => {
  it('install from idle starts at the first step with the model, the coding agent and the steps', () => {
    expect(reduceInstallJob(SAMPLE.idle, EVENT.install)).toEqual({
      schema: 1,
      state: 'installing',
      step: 'runtime',
      steps: ['runtime', 'model', 'verify', 'connect'],
      model: { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', context: 65536 },
      cli: { id: 'claude', label: 'Claude Code' },
    });
  });

  it('a new install replaces a failed job but keeps what is still on disk: the runtime and the connection', () => {
    const failed: LocalModelStateFile = { ...SAMPLE.failed, connection: CONNECTION, loaded: LOADED };
    const next = reduceInstallJob(failed, EVENT.install);
    expect(next).toEqual({
      schema: 1,
      state: 'installing',
      step: 'runtime',
      steps: ['runtime', 'model', 'verify', 'connect'],
      model: { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', context: 65536 },
      // The old job's model is another one: what it left in the store is deleted first.
      replacedModelId: 'qwen3.6:35b-a3b',
      cli: { id: 'claude', label: 'Claude Code' },
      runtime: RUNTIME,
      library: [OTHER],
      connection: CONNECTION,
    });
    // Gone: the error, the progress, what the runtime had loaded.
    expect(next).not.toHaveProperty('error');
    expect(next).not.toHaveProperty('progress');
    expect(next).not.toHaveProperty('loaded');
  });

  it('a new install of the SAME model replaces nothing in the store, and forgets its pull total and digest', () => {
    const paused: LocalModelStateFile = {
      ...SAMPLE.paused,
      model: { ...MODEL, pullBytes: 23_105_798_956, digest: 'abc' },
    };
    const next = reduceInstallJob(paused, { ...EVENT.install, model: MODEL } as InstallJobEvent);
    expect(next).not.toHaveProperty('replacedModelId');
    expect(next.model).toEqual(MODEL);
  });

  it('a model still waiting to be deleted is carried over a second replacement, unless it is the new choice', () => {
    const paused: LocalModelStateFile = { ...SAMPLE.paused, replacedModelId: 'qwen3.8:27b' };
    // Same model again: the older leftover is still to be deleted.
    expect(reduceInstallJob(paused, { ...EVENT.install, model: MODEL } as InstallJobEvent).replacedModelId).toBe(
      'qwen3.8:27b'
    );
    // Going back to the leftover itself: it is the model that is wanted now.
    const back = { ...EVENT.install, model: { id: 'qwen3.8:27b', label: 'Qwen3.8 27B', context: 131072 } };
    expect(
      reduceInstallJob({ ...paused, model: { ...MODEL, id: 'qwen3.8:27b' } }, back as InstallJobEvent)
    ).not.toHaveProperty('replacedModelId');
  });

  it('refuses an install whose steps are not a job', () => {
    const idle = SAMPLE.idle;
    expect(reduceInstallJob(idle, { ...EVENT.install, steps: [] } as InstallJobEvent)).toBe(idle);
    expect(reduceInstallJob(idle, { ...EVENT.install, steps: ['model', 'model'] } as InstallJobEvent)).toBe(idle);
    expect(reduceInstallJob(idle, { ...EVENT.install, steps: ['reboot'] } as unknown as InstallJobEvent)).toBe(idle);
  });

  it('progress changes the progress and nothing else', () => {
    const next = reduceInstallJob(SAMPLE.installing, EVENT.progress);
    expect(next).toEqual({
      ...SAMPLE.installing,
      progress: { completedBytes: 7_000_000_000, totalBytes: 23_105_798_956 },
    });
  });

  it('refuses progress that is not two byte counts', () => {
    for (const bad of [
      { completedBytes: -1, totalBytes: 10 },
      { completedBytes: 1.5, totalBytes: 10 },
      { completedBytes: Number.NaN, totalBytes: 10 },
      { completedBytes: 1, totalBytes: Number.POSITIVE_INFINITY },
    ]) {
      expect(reduceInstallJob(SAMPLE.installing, { type: 'progress', ...bad })).toBe(SAMPLE.installing);
    }
  });

  it('step-done moves to the next step of THIS job and clears the progress', () => {
    const steps: LocalModelInstallStep[] = ['runtime', 'model', 'verify', 'connect'];
    let state: LocalModelStateFile = { ...SAMPLE.installing, step: 'runtime', steps };
    const visited: (LocalModelInstallStep | undefined)[] = [state.step];
    for (let i = 0; i < 3; i++) {
      state = reduceInstallJob(state, { type: 'step-done' });
      expect(state.state).toBe('installing');
      expect(state).not.toHaveProperty('progress');
      visited.push(state.step);
    }
    // The agent step is not part of this job, so it is never entered.
    expect(visited).toEqual(steps);
  });

  it('the last step-done makes the job installed and keeps only what an installation has', () => {
    const last: LocalModelStateFile = {
      ...SAMPLE.installing,
      step: 'connect',
      model: { ...MODEL, pullBytes: 23_105_798_956, digest: 'abc123' },
      loaded: LOADED,
      connection: CONNECTION,
    };
    expect(reduceInstallJob(last, { type: 'step-done' })).toEqual(SAMPLE.installed);
  });

  it('refuses a step-done it cannot apply: a state without its step, a last step without a runtime', () => {
    const noStep: LocalModelStateFile = { schema: 1, state: 'installing', steps: ALL_STEPS, model: MODEL, cli: CLI };
    expect(reduceInstallJob(noStep, { type: 'step-done' })).toBe(noStep);
    const foreign: LocalModelStateFile = { ...SAMPLE.installing, step: 'agent', steps: ['runtime', 'model'] };
    expect(reduceInstallJob(foreign, { type: 'step-done' })).toBe(foreign);
    const noRuntime: LocalModelStateFile = {
      schema: 1,
      state: 'installing',
      step: 'connect',
      steps: ALL_STEPS,
      model: MODEL,
      cli: CLI,
    };
    expect(reduceInstallJob(noRuntime, { type: 'step-done' })).toBe(noRuntime);
  });

  it('fail keeps the step and the progress as they stood and stores the error', () => {
    expect(reduceInstallJob(SAMPLE.installing, EVENT.fail)).toEqual({
      ...SAMPLE.installing,
      state: 'failed',
      error: { code: 'no-tool-call', vars: { model: 'Qwen3.6 35B-A3B' }, nextModelId: 'gpt-oss:20b' },
    });
    // An error without extras is just its code.
    expect(reduceInstallJob(SAMPLE.installing, { type: 'fail', code: 'internal', vars: {} }).error).toEqual({
      code: 'internal',
    });
  });

  it('cancel pauses at the same step, with the progress as it stood', () => {
    expect(reduceInstallJob(SAMPLE.installing, { type: 'cancel' })).toEqual(SAMPLE.paused);
  });

  it('resume re-enters the same step and clears the error', () => {
    const next = reduceInstallJob(SAMPLE.failed, { type: 'resume' });
    expect(next).toEqual({ ...SAMPLE.installing });
    expect(next).not.toHaveProperty('error');
    expect(reduceInstallJob(SAMPLE.paused, { type: 'resume' }).step).toBe('model');
  });

  it('remove drops everything, from every state that allows it', () => {
    for (const state of ['idle', 'paused', 'failed', 'installed'] as const) {
      expect(reduceInstallJob(SAMPLE[state], { type: 'remove' })).toEqual({ schema: 1, state: 'idle' });
    }
  });
});

describe('allowedActions', () => {
  it('outside installed the runtime, the port and the digest narrow nothing', () => {
    const busy = { ...LIVE, running: true, gaveUp: true, portInUse: true };
    expect(allowedActions(SAMPLE.installing, busy)).toEqual(['cancel']);
    expect(allowedActions(SAMPLE.installing, LIVE)).toEqual(['cancel']);
    for (const state of ['paused', 'failed'] as const) {
      // `use` because a checked model is there; no delete while nothing is known from the runtime.
      expect(allowedActions(SAMPLE[state], busy)).toEqual(['resume', 'install', 'use', 'remove']);
      expect(allowedActions(SAMPLE[state], LIVE)).toEqual(['resume', 'install', 'use', 'remove']);
    }
  });

  it('idle: Remove is offered only while the model store still holds something', () => {
    expect(allowedActions(SAMPLE.idle, LIVE)).toEqual(['install']);
    expect(allowedActions(SAMPLE.idle, { ...LIVE, storeBytes: 0 })).toEqual(['install']);
    expect(allowedActions(SAMPLE.idle, { ...LIVE, storeBytes: 23_105_798_956 })).toEqual(['install', 'remove']);
  });

  it('use and delete-model are listed only while a row of the library offers them', () => {
    // A first job: no checked model yet, so nothing to switch to and nothing to delete.
    const first: LocalModelStateFile = { ...SAMPLE.paused, library: undefined };
    expect(allowedActions(first, LIVE)).toEqual(['resume', 'install', 'remove']);
    // The runtime lists the other model: it can be deleted as well as switched to.
    const tags = [{ name: OTHER.id, size: 17_741_872_154, digest: OTHER.digest }];
    expect(allowedActions(SAMPLE.paused, { ...LIVE, running: true, tags })).toEqual([
      'resume',
      'install',
      'use',
      'delete-model',
      'remove',
    ]);
    // The rows it was given decide, when it is given them.
    expect(allowedActions(SAMPLE.paused, { ...LIVE, running: true, tags }, [])).toEqual([
      'resume',
      'install',
      'remove',
    ]);
  });

  it('installed and running: a session can be started, the runtime stopped, a model added', () => {
    expect(allowedActions(SAMPLE.installed, { ...LIVE, running: true, digest: 'same' })).toEqual([
      'start-session',
      'stop',
      'install',
      'use',
      'remove',
    ]);
  });

  it('installed and stopped: it can be started, and no session is offered', () => {
    expect(allowedActions(SAMPLE.installed, LIVE)).toEqual(['start', 'install', 'use', 'remove']);
  });

  it('installed and running a model that changed: no session', () => {
    expect(allowedActions(SAMPLE.installed, { ...LIVE, running: true, digest: 'changed' })).toEqual([
      'stop',
      'install',
      'use',
      'remove',
    ]);
  });

  it('a digest that could not be read does not hide the session button: the launch itself reads it again', () => {
    expect(allowedActions(SAMPLE.installed, { ...LIVE, running: true, digest: 'unknown' })).toContain('start-session');
    expect(allowedActions(SAMPLE.installed, { ...LIVE, running: true })).toContain('start-session');
  });

  it('never returns the table row itself', () => {
    const actions = allowedActions(SAMPLE.idle, LIVE);
    actions.push('cancel');
    expect(INSTALL_STATE_TABLE.idle.actions).toEqual(['install', 'remove']);
  });
});

describe('installedBlocker', () => {
  it('is nothing outside installed, and nothing for a runtime the person stopped', () => {
    for (const state of ['idle', 'installing', 'paused', 'failed'] as const) {
      expect(
        installedBlocker(SAMPLE[state], { ...LIVE, portInUse: true, gaveUp: true, digest: 'changed' })
      ).toBeUndefined();
    }
    expect(installedBlocker(SAMPLE.installed, LIVE)).toBeUndefined();
    expect(installedBlocker(SAMPLE.installed, { ...LIVE, running: true, digest: 'same' })).toBeUndefined();
  });

  it('another program on the port: the port, and "Use another port"', () => {
    expect(installedBlocker(SAMPLE.installed, { ...LIVE, portInUse: true })).toEqual({
      code: 'port-in-use',
      message: { text: 'Port {port} is in use by another program.', vars: { port: '11435' } },
      next: 'other-port',
    });
  });

  it('a runtime that keeps stopping: "Start"', () => {
    expect(installedBlocker(SAMPLE.installed, { ...LIVE, gaveUp: true })).toEqual({
      code: 'runtime-stopped',
      message: { text: 'The runtime keeps stopping, so Codeman no longer restarts it.' },
      next: 'start',
    });
  });

  it('a runtime that did not start: what it said, and "Start" to try again (an installed model has no job to resume)', () => {
    expect(installedBlocker(SAMPLE.installed, { ...LIVE, startFailed: { detail: 'spawn ENOENT' } })).toEqual({
      code: 'runtime-start-failed',
      message: { text: 'The runtime did not start on this Mac.' },
      next: 'start',
      detail: 'spawn ENOENT',
    });
    expect(installedBlocker(SAMPLE.installed, { ...LIVE, startFailed: {} })).toEqual({
      code: 'runtime-start-failed',
      message: { text: 'The runtime did not start on this Mac.' },
      next: 'start',
    });
    // A runtime that runs has started: an older failure says nothing any more.
    expect(
      installedBlocker(SAMPLE.installed, { ...LIVE, running: true, digest: 'same', startFailed: { detail: 'x' } })
    ).toBeUndefined();
  });

  it('the port and a runtime that keeps stopping are said before a failed start', () => {
    const failed = { startFailed: { detail: 'x' } };
    expect(installedBlocker(SAMPLE.installed, { ...LIVE, ...failed, portInUse: true })?.code).toBe('port-in-use');
    expect(installedBlocker(SAMPLE.installed, { ...LIVE, ...failed, gaveUp: true })?.code).toBe('runtime-stopped');
  });

  it('a model that changed: "Remove"', () => {
    expect(installedBlocker(SAMPLE.installed, { ...LIVE, running: true, digest: 'changed' })).toEqual({
      code: 'model-changed',
      message: { text: 'The model on this Mac changed since it was installed. Remove it and install it again.' },
      next: 'remove',
    });
  });
});

describe('buildInstallView', () => {
  it('idle: only what is always there, with the runtime download an install would add', () => {
    expect(buildInstallView(SAMPLE.idle, { ...LIVE, developerTools: 'missing' })).toEqual({
      state: 'idle',
      running: false,
      developerTools: 'missing',
      runtime: {
        version: '0.40.15',
        installed: false,
        downloadBytes: 185_971_671,
        downloadGb: '0.2',
        unpackedGb: '0.6',
      },
      folder: '/Users/me/.codeman/local-model',
      library: [],
      harnesses: [],
      actions: ['install'],
    });
  });

  it('idle with a store an earlier Remove kept: its size, and Remove to free it', () => {
    const view = buildInstallView(SAMPLE.idle, { ...LIVE, storeBytes: 23_105_798_956 });
    expect(view.store).toEqual({ bytes: 23_105_798_956, gb: '23.1' });
    expect(view.library).toEqual([]);
    expect(view.actions).toEqual(['install', 'remove']);
    // A store that was measured as empty is said as that, and offers nothing.
    expect(buildInstallView(SAMPLE.idle, { ...LIVE, storeBytes: 0 }).store).toEqual({ bytes: 0, gb: '0.0' });
  });

  it('once the runtime is unpacked an install downloads nothing for it', () => {
    const view = buildInstallView(SAMPLE.idle, { ...LIVE, runtimeInstalled: true });
    expect(view.runtime).toEqual({
      version: '0.40.15',
      installed: true,
      downloadBytes: 0,
      downloadGb: '0.0',
      unpackedGb: '0.6',
    });
  });

  it('installing: the step, the steps, the choice, the port, and the download as the window prints it', () => {
    const view = buildInstallView(SAMPLE.installing, { ...LIVE, running: true, bytesPerSecond: 58_000_000 });
    expect(view).toEqual({
      state: 'installing',
      running: true,
      developerTools: 'present',
      runtime: {
        version: '0.40.15',
        installed: false,
        downloadBytes: 185_971_671,
        downloadGb: '0.2',
        unpackedGb: '0.6',
      },
      folder: '/Users/me/.codeman/local-model',
      // The checked model of an earlier install: listed, with nothing to do while a job runs.
      library: [{ ...OTHER_ROW, actions: [] }],
      harnesses: [],
      actions: ['cancel'],
      model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B' },
      context: 131072,
      cli: 'opencode',
      cliLabel: 'OpenCode',
      port: 11435,
      step: 'model',
      steps: ALL_STEPS,
      progress: {
        completedBytes: 6_200_000_000,
        totalBytes: 23_105_798_956,
        completedGb: '6.2',
        totalGb: '23.1',
        bytesPerSecond: 58_000_000,
        mbPerSecond: '58',
        // (23,105,798,956 - 6,200,000,000) / 58,000,000 = 291.5, rounded up.
        secondsLeft: 292,
      },
    });
  });

  it('a speed is shown only while the job runs: a paused job has its bytes and no speed', () => {
    const view = buildInstallView(SAMPLE.paused, { ...LIVE, bytesPerSecond: 58_000_000 });
    expect(view.progress).toEqual({
      completedBytes: 6_200_000_000,
      totalBytes: 23_105_798_956,
      completedGb: '6.2',
      totalGb: '23.1',
    });
    expect(view.actions).toEqual(['resume', 'install', 'use', 'remove']);
    // The way back from a job that stopped: the model that was checked before.
    expect(view.library).toEqual([OTHER_ROW]);
  });

  it('a speed of zero has no time left, and a download without a total has no progress at all', () => {
    const stalled = buildInstallView(SAMPLE.installing, { ...LIVE, bytesPerSecond: 0 });
    expect(stalled.progress).toMatchObject({ bytesPerSecond: 0, mbPerSecond: '0' });
    expect(stalled.progress).not.toHaveProperty('secondsLeft');
    const noTotal = buildInstallView(
      { ...SAMPLE.installing, progress: { completedBytes: 0, totalBytes: 0 } },
      { ...LIVE, bytesPerSecond: 5 }
    );
    expect(noTotal).not.toHaveProperty('progress');
  });

  it('a job before its port was chosen has no port', () => {
    const { runtime: _runtime, ...early } = SAMPLE.installing;
    expect(buildInstallView(early, LIVE)).not.toHaveProperty('port');
  });

  it('failed: the sentence, its slots, the one next step, the model to try next, and the raw detail', () => {
    const failed: LocalModelStateFile = {
      ...SAMPLE.failed,
      step: 'verify',
      error: {
        code: 'no-tool-call',
        vars: { model: 'Qwen3.6 35B-A3B' },
        detail: 'finish_reason stop',
        nextModelId: 'gpt-oss:20b',
      },
    };
    const view = buildInstallView(failed, {
      ...LIVE,
      nextModel: { modelId: 'gpt-oss:20b', modelLabel: 'GPT-OSS 20B' },
    });
    expect(view.state).toBe('failed');
    expect(view.step).toBe('verify');
    expect(view.error).toEqual({
      code: 'no-tool-call',
      message: {
        text: '{model} loaded but did not call a tool, so a coding agent cannot work with it.',
        vars: { model: 'Qwen3.6 35B-A3B' },
      },
      next: 'next-model',
      nextModel: { modelId: 'gpt-oss:20b', modelLabel: 'GPT-OSS 20B' },
      detail: 'finish_reason stop',
    });
  });

  it('a failed job never says "Start": a code whose own next step is that says "Try again" there', () => {
    const state: LocalModelStateFile = { ...SAMPLE.failed, error: { code: 'runtime-stopped', detail: 'ECONNREFUSED' } };
    expect(buildInstallView(state, LIVE).error).toEqual({
      code: 'runtime-stopped',
      message: { text: 'The runtime keeps stopping, so Codeman no longer restarts it.' },
      next: 'retry',
      detail: 'ECONNREFUSED',
    });
    // Every next step a failed job is shown with is one its actions can carry out.
    for (const code of Object.keys(LOCAL_MODEL_ERROR_NEXT) as LocalModelErrorCode[]) {
      const next = buildInstallView({ ...SAMPLE.failed, error: { code } }, LIVE).error?.next;
      expect(next, code).not.toBe('start');
    }
  });

  it('a next model is named only for an error whose next step is another model', () => {
    const view = buildInstallView(SAMPLE.failed, {
      ...LIVE,
      nextModel: { modelId: 'gpt-oss:20b', modelLabel: 'GPT-OSS 20B' },
    });
    expect(view.error).toEqual({
      code: 'pull-failed',
      message: { text: LOCAL_MODEL_INSTALL_LABELS.errPullFailed },
      next: 'retry',
      detail: 'tls: bad record MAC',
    });
  });

  it('installed: the facts of the Done line, the endpoint a session starts on, and no step', () => {
    const view = buildInstallView(SAMPLE.installed, { ...LIVE, running: true, runtimeInstalled: true, digest: 'same' });
    expect(view).toEqual({
      state: 'installed',
      running: true,
      developerTools: 'present',
      runtime: { version: '0.40.15', installed: true, downloadBytes: 0, downloadGb: '0.0', unpackedGb: '0.6' },
      folder: '/Users/me/.codeman/local-model',
      library: [ENTRY_ROW, OTHER_ROW],
      // The live facts name no coding agents here (unknown): none is listed, and a session is
      // still offered.
      harnesses: [],
      actions: ['start-session', 'stop', 'install', 'use', 'remove'],
      model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B' },
      context: 131072,
      cli: 'opencode',
      cliLabel: 'OpenCode',
      port: 11435,
      loaded: { context: 131072, memoryBytes: 26_300_000_000, memoryGb: '26.3', onGpu: true },
      endpointId: 'local-ollama',
    });
  });

  it('installed: what blocks a session is on the view and the state stays installed', () => {
    const view = buildInstallView(SAMPLE.installed, { ...LIVE, running: true, digest: 'changed' });
    expect(view.state).toBe('installed');
    expect(view.error?.code).toBe('model-changed');
    expect(view.actions).toEqual(['stop', 'install', 'use', 'remove']);
    // The row of the model in use says the same thing the error does.
    expect(view.library[0]).toMatchObject({ id: MODEL.id, active: true, status: 'changed' });
  });

  it('a model that was not all on the GPU says so', () => {
    const view = buildInstallView(
      { ...SAMPLE.installed, loaded: { ...LOADED, sizeVramBytes: 20_000_000_000 } },
      { ...LIVE, running: true }
    );
    expect(view.loaded?.onGpu).toBe(false);
  });

  it('every sentence it sends is one of the install labels', () => {
    const sentences = new Set<string>(Object.values(LOCAL_MODEL_INSTALL_LABELS));
    for (const code of Object.keys(LOCAL_MODEL_ERROR_LABELS) as LocalModelErrorCode[]) {
      const error = buildInstallError(code, { vars: { model: 'M' } });
      expect(sentences.has(error.message.text)).toBe(true);
      expect(error.next).toBe(LOCAL_MODEL_ERROR_NEXT[code]);
    }
  });
});

describe('reduceInstallJob: the library', () => {
  it('libraryOf: the list of the file, and for an installed file without one its model', () => {
    expect(libraryOf(SAMPLE.idle)).toEqual([]);
    expect(libraryOf(SAMPLE.paused)).toEqual([OTHER]);
    // A file an earlier build wrote: the model in use is the library.
    const old: LocalModelStateFile = { ...SAMPLE.installed, library: undefined };
    expect(libraryOf(old)).toEqual([ENTRY]);
    // The model in use is always one of them, first, also when the list does not name it.
    expect(libraryOf(SAMPLE.installed)).toEqual([ENTRY, OTHER]);
    // Never twice, and the list's own entry wins.
    const listed: LocalModelStateFile = { ...SAMPLE.installed, library: [OTHER, { ...ENTRY, context: 65536 }] };
    expect(libraryOf(listed)).toEqual([OTHER, { ...ENTRY, context: 65536 }]);
    // A model without a stored digest could never be compared: it is not one of them.
    const noDigest: LocalModelStateFile = { ...SAMPLE.installed, library: undefined, model: MODEL };
    expect(libraryOf(noDigest)).toEqual([]);
    // A job's model is not in the library before it was checked.
    expect(libraryOf({ ...SAMPLE.installing, library: undefined })).toEqual([]);
  });

  it('libraryOf hands out a list of its own', () => {
    const list = libraryOf(SAMPLE.paused);
    list.pop();
    expect(SAMPLE.paused.library).toEqual([OTHER]);
  });

  it('upsertLibraryEntry replaces the entry with the same id in place, else adds at the end', () => {
    const next = { ...OTHER, digest: 'fff', context: 131072 };
    expect(upsertLibraryEntry([ENTRY, OTHER], next)).toEqual([ENTRY, next]);
    expect(upsertLibraryEntry([ENTRY], OTHER)).toEqual([ENTRY, OTHER]);
    expect(upsertLibraryEntry([], OTHER)).toEqual([OTHER]);
  });

  it('an install from installed adds a model: the model in use stays in the library and is NOT deleted', () => {
    const next = reduceInstallJob(SAMPLE.installed, EVENT.install);
    expect(next).toEqual({
      schema: 1,
      state: 'installing',
      step: 'runtime',
      steps: ['runtime', 'model', 'verify', 'connect'],
      model: { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', context: 65536 },
      cli: { id: 'claude', label: 'Claude Code' },
      runtime: RUNTIME,
      // The model that was in use is written into the list: its state member is the new job's now.
      library: [ENTRY, OTHER],
      connection: CONNECTION,
    });
    expect(next).not.toHaveProperty('replacedModelId');
    expect(next).not.toHaveProperty('loaded');
  });

  it('an install from an installed file of an earlier build keeps its one model too', () => {
    const old: LocalModelStateFile = { ...SAMPLE.installed, library: undefined };
    const next = reduceInstallJob(old, EVENT.install);
    expect(next.library).toEqual([ENTRY]);
    expect(next).not.toHaveProperty('replacedModelId');
  });

  it('a replaced job deletes its model only when that model was never checked', () => {
    // The stopped job's model is a checked one (it failed after its check): it stays.
    const checked: LocalModelStateFile = { ...SAMPLE.failed, library: [OTHER, ENTRY] };
    expect(reduceInstallJob(checked, EVENT.install)).not.toHaveProperty('replacedModelId');
    // Not checked: what it left is deleted, as before.
    expect(reduceInstallJob(SAMPLE.failed, EVENT.install).replacedModelId).toBe(MODEL.id);
    // A leftover that is waiting to be deleted is dropped from the wait once it is a checked model.
    const waiting: LocalModelStateFile = { ...SAMPLE.paused, replacedModelId: OTHER.id };
    expect(reduceInstallJob(waiting, { ...EVENT.install, model: MODEL } as InstallJobEvent)).not.toHaveProperty(
      'replacedModelId'
    );
  });

  it('use from installed: the two steps for the checked model, with its stored digest', () => {
    expect(reduceInstallJob(SAMPLE.installed, EVENT.use)).toEqual({
      schema: 1,
      state: 'installing',
      step: 'verify',
      steps: ['verify', 'connect'],
      model: { id: OTHER.id, label: OTHER.label, context: OTHER.context, digest: OTHER.digest },
      cli: CLI,
      runtime: RUNTIME,
      library: [ENTRY, OTHER],
      connection: CONNECTION,
    });
  });

  it('use from a stopped job replaces it, and deletes what that job left of an unchecked model', () => {
    for (const state of ['paused', 'failed'] as const) {
      const next = reduceInstallJob(SAMPLE[state], EVENT.use);
      expect(next.state).toBe('installing');
      expect(next.step).toBe('verify');
      expect(next.model?.id).toBe(OTHER.id);
      expect(next.replacedModelId).toBe(MODEL.id);
      expect(next).not.toHaveProperty('error');
      expect(next).not.toHaveProperty('progress');
      expect(next.library).toEqual([OTHER]);
    }
  });

  it('refuses a use it cannot apply: a model that is not in the library, a state without a runtime', () => {
    const unknown = { ...EVENT.use, model: { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', context: 65536, digest: 'x' } };
    expect(reduceInstallJob(SAMPLE.installed, unknown as InstallJobEvent)).toBe(SAMPLE.installed);
    const noRuntime: LocalModelStateFile = { ...SAMPLE.paused, runtime: undefined };
    expect(reduceInstallJob(noRuntime, EVENT.use)).toBe(noRuntime);
  });

  it('every event but remove carries the library', () => {
    const job = SAMPLE.installing;
    expect(reduceInstallJob(job, EVENT.progress).library).toEqual([OTHER]);
    expect(reduceInstallJob(job, EVENT['step-done']).library).toEqual([OTHER]);
    expect(reduceInstallJob(job, EVENT.fail).library).toEqual([OTHER]);
    expect(reduceInstallJob(job, EVENT.cancel).library).toEqual([OTHER]);
    expect(reduceInstallJob(job, EVENT.restart).library).toEqual([OTHER]);
    expect(reduceInstallJob(SAMPLE.failed, EVENT.resume).library).toEqual([OTHER]);
    const last: LocalModelStateFile = { ...job, step: 'connect', library: [OTHER, ENTRY], connection: CONNECTION };
    expect(reduceInstallJob(last, EVENT['step-done'])).toMatchObject({ state: 'installed', library: [OTHER, ENTRY] });
    expect(reduceInstallJob(SAMPLE.installed, EVENT.remove)).toEqual({ schema: 1, state: 'idle' });
  });
});

describe('buildLibraryRows', () => {
  const tagOf = (entry: LocalModelLibraryEntry, extra: Partial<{ size: number; digest: string }> = {}) => ({
    name: entry.id,
    size: entry.bytes ?? 0,
    digest: entry.digest,
    ...extra,
  });

  it('is empty in idle, whatever is live', () => {
    expect(buildLibraryRows(SAMPLE.idle, { ...LIVE, running: true, tags: [tagOf(OTHER)] })).toEqual([]);
  });

  it('the runtime stopped: the checked models as they were recorded, a switch, and no delete', () => {
    expect(buildLibraryRows(SAMPLE.installed, LIVE)).toEqual([ENTRY_ROW, OTHER_ROW]);
    // A listing that is still around from before the stop is not trusted.
    expect(buildLibraryRows(SAMPLE.installed, { ...LIVE, running: false, tags: [] })).toEqual([ENTRY_ROW, OTHER_ROW]);
  });

  it('the runtime running: its sizes, and a delete for every model but the one in use', () => {
    const rows = buildLibraryRows(SAMPLE.installed, {
      ...LIVE,
      running: true,
      tags: [tagOf(ENTRY, { size: 23_105_800_000 }), tagOf(OTHER)],
    });
    expect(rows).toEqual([
      { ...ENTRY_ROW, sizeBytes: 23_105_800_000 },
      { ...OTHER_ROW, actions: ['use', 'delete'] },
    ]);
  });

  it('the model in use comes first, wherever the list has it', () => {
    const state: LocalModelStateFile = { ...SAMPLE.installed, library: [OTHER, ENTRY] };
    expect(buildLibraryRows(state, LIVE).map((row) => row.id)).toEqual([ENTRY.id, OTHER.id]);
  });

  it('a checked model whose digest the runtime no longer reports: changed, never switched to, deletable', () => {
    const rows = buildLibraryRows(SAMPLE.installed, {
      ...LIVE,
      running: true,
      tags: [tagOf(ENTRY), tagOf(OTHER, { digest: 'somethingelse' })],
    });
    expect(rows[1]).toMatchObject({ id: OTHER.id, status: 'changed', verified: true, actions: ['delete'] });
    // The digest is compared without its prefix and its case, like everywhere else.
    const same = buildLibraryRows(SAMPLE.installed, {
      ...LIVE,
      running: true,
      tags: [tagOf(ENTRY), tagOf(OTHER, { digest: 'sha256:DEF456' })],
    });
    expect(same[1].status).toBe('ready');
  });

  it('a checked model the runtime no longer lists: missing, with its recorded size, and its entry can be dropped', () => {
    const rows = buildLibraryRows(SAMPLE.installed, { ...LIVE, running: true, tags: [tagOf(ENTRY)] });
    expect(rows[1]).toEqual({ ...OTHER_ROW, status: 'missing', actions: ['delete'] });
  });

  it('what the runtime lists beside the checked models: not checked, deletable, never switched to', () => {
    const rows = buildLibraryRows(SAMPLE.installed, {
      ...LIVE,
      running: true,
      labels: { 'mimo-v2.6:9b-q4_k_m': 'MiMo V2.6 9B' },
      tags: [
        tagOf(ENTRY),
        tagOf(OTHER),
        { name: 'zeta:1b', size: 900_000_000, digest: 'z' },
        { name: 'mimo-v2.6:9b-q4_k_m', size: 6_550_811_033, digest: 'm' },
      ],
    });
    expect(rows.slice(2)).toEqual([
      {
        id: 'mimo-v2.6:9b-q4_k_m',
        // The catalogue knows it, so it is named as the chooser names it.
        label: 'MiMo V2.6 9B',
        sizeBytes: 6_550_811_033,
        sizeGb: '6.6',
        active: false,
        verified: false,
        status: 'unverified',
        actions: ['delete'],
      },
      {
        id: 'zeta:1b',
        label: 'zeta:1b',
        sizeBytes: 900_000_000,
        sizeGb: '0.9',
        active: false,
        verified: false,
        status: 'unverified',
        actions: ['delete'],
      },
    ]);
  });

  it('a name that is not a plain name:tag is listed with its size and offers nothing', () => {
    const rows = buildLibraryRows(SAMPLE.installed, {
      ...LIVE,
      running: true,
      tags: [tagOf(ENTRY), { name: 'hf.co/someone/model:Q4', size: 1_000_000_000, digest: 'h' }],
    });
    expect(rows.find((row) => row.id === 'hf.co/someone/model:Q4')).toMatchObject({
      status: 'unverified',
      sizeGb: '1.0',
      actions: [],
    });
  });

  it('the model of a stopped job: listed once it is on disk, and neither switched to nor deleted', () => {
    const rows = buildLibraryRows(SAMPLE.failed, {
      ...LIVE,
      running: true,
      tags: [tagOf(OTHER), { name: MODEL.id, size: 23_105_798_956, digest: 'abc123' }],
    });
    expect(rows).toEqual([
      { ...OTHER_ROW, actions: ['use', 'delete'] },
      {
        id: MODEL.id,
        label: MODEL.label,
        sizeBytes: 23_105_798_956,
        sizeGb: '23.1',
        active: false,
        verified: false,
        status: 'unverified',
        actions: [],
      },
    ]);
  });

  it('while a job runs nothing is offered on any row', () => {
    const rows = buildLibraryRows(SAMPLE.installing, { ...LIVE, running: true, tags: [tagOf(OTHER)] });
    expect(rows.map((row) => row.actions)).toEqual([[]]);
  });

  it('a row without a known size has neither size member', () => {
    const state: LocalModelStateFile = { ...SAMPLE.paused, library: [{ ...OTHER, bytes: undefined }] };
    const [row] = buildLibraryRows(state, LIVE);
    expect(row).not.toHaveProperty('sizeBytes');
    expect(row).not.toHaveProperty('sizeGb');
  });
});

describe('buildHarnessRows: the coding agents of the model in use', () => {
  const ROWS: LocalHarnessEntry[] = [
    { cli: 'opencode', minContext: 65536, rank: 4, readyMark: '┃' },
    { cli: 'claude', minContext: 65536, rank: 3, slowFirstTurn: true },
    { cli: 'pi', minContext: 65536, rank: 2 },
    { cli: 'deepseek', minContext: 65536, rank: 1 },
    { cli: 'later', minContext: 65536, rank: 0, gated: true },
  ];
  const fact = (cli: string, label: string, extra: Partial<HarnessFact> = {}): HarnessFact => ({
    cli,
    label,
    installed: false,
    installable: false,
    acceptsModelId: () => true,
    ...extra,
  });
  const FACTS: HarnessFact[] = [
    fact('opencode', 'OpenCode', { installed: true }),
    fact('claude', 'Claude Code', { installed: true, readyMark: 'shift+tab' }),
    fact('pi', 'Pi', { installable: true, installCommand: 'npm install -g pi' }),
    // A launcher without a profile: not startable, and one command does not make it so.
    fact('deepseek', 'DeepSeek', { readyMark: '❯' }),
    fact('later', 'Later', { installed: true }),
  ];
  const rows = (
    state: LocalModelStateFile = SAMPLE.installed,
    facts: readonly HarnessFact[] = FACTS,
    memory: Parameters<typeof buildHarnessRows>[3] = {}
  ) => buildHarnessRows(state, { harnesses: ROWS }, facts, memory);

  it('lists every harness that is not gated, the default first, then by rank, each with how it stands', () => {
    expect(rows()).toEqual([
      { cli: 'opencode', cliLabel: 'OpenCode', default: true, status: 'ready', readyMark: '┃', actions: [] },
      {
        cli: 'claude',
        cliLabel: 'Claude Code',
        default: false,
        status: 'ready',
        slowFirstTurn: true,
        // No mark on the catalogue row: the CLI registry's own stands.
        readyMark: 'shift+tab',
        actions: [],
      },
      {
        cli: 'pi',
        cliLabel: 'Pi',
        default: false,
        status: 'installable',
        installCommand: 'npm install -g pi',
        actions: ['install'],
      },
      { cli: 'deepseek', cliLabel: 'DeepSeek', default: false, status: 'setup-needed', readyMark: '❯', actions: [] },
    ]);
  });

  it('is empty in every state but installed', () => {
    for (const state of ['idle', 'installing', 'paused', 'failed'] as const) {
      expect(rows(SAMPLE[state])).toEqual([]);
    }
  });

  it('leaves out a harness without a fact, one the model is too small for, and one that refuses its name', () => {
    const small: LocalModelStateFile = { ...SAMPLE.installed, model: { ...MODEL, context: 32768 } };
    expect(rows(small)).toEqual([]);
    expect(rows(SAMPLE.installed, FACTS.slice(0, 1)).map((row) => row.cli)).toEqual(['opencode']);
    const picky = FACTS.map((entry) => (entry.cli === 'claude' ? { ...entry, acceptsModelId: () => false } : entry));
    expect(rows(SAMPLE.installed, picky).map((row) => row.cli)).toEqual(['opencode', 'pi', 'deepseek']);
    const throwing = FACTS.map((entry) =>
      entry.cli === 'claude'
        ? {
            ...entry,
            acceptsModelId: () => {
              throw new Error('bad recipe');
            },
          }
        : entry
    );
    expect(rows(SAMPLE.installed, throwing).map((row) => row.cli)).toEqual(['opencode', 'pi', 'deepseek']);
  });

  it('the default is the agent of the installation while it can be started, else the first that can', () => {
    const withClaude: LocalModelStateFile = { ...SAMPLE.installed, cli: { id: 'claude', label: 'Claude Code' } };
    expect(rows(withClaude).map((row) => [row.cli, row.default])).toEqual([
      ['claude', true],
      ['opencode', false],
      ['pi', false],
      ['deepseek', false],
    ]);
    // The agent of the installation was uninstalled: a client that names none starts another.
    const gone = FACTS.map((entry) =>
      entry.cli === 'opencode'
        ? fact('opencode', 'OpenCode', { installable: true, installCommand: 'curl x | bash' })
        : entry
    );
    expect(rows(SAMPLE.installed, gone).map((row) => [row.cli, row.default, row.status])).toEqual([
      ['claude', true, 'ready'],
      ['opencode', false, 'installable'],
      ['pi', false, 'installable'],
      ['deepseek', false, 'setup-needed'],
    ]);
    // Nothing can be started: the default stays the agent of the installation.
    const none = FACTS.map((entry) => fact(entry.cli, entry.label, { installable: true, installCommand: 'x' }));
    expect(rows(SAMPLE.installed, none).find((row) => row.default)?.cli).toBe('opencode');
  });

  it('while one installer runs: that row says installing with its command, and no other row offers an install', () => {
    const both = FACTS.map((entry) =>
      entry.cli === 'deepseek' ? fact('deepseek', 'DeepSeek', { installable: true, installCommand: 'y' }) : entry
    );
    const during = rows(SAMPLE.installed, both, { running: 'pi' });
    expect(during.find((row) => row.cli === 'pi')).toMatchObject({
      status: 'installing',
      installCommand: 'npm install -g pi',
      actions: [],
    });
    expect(during.find((row) => row.cli === 'deepseek')).toMatchObject({ status: 'installable', actions: [] });
    // The installer has landed and the memory has not caught up: the fact wins.
    const landed = both.map((entry) => (entry.cli === 'pi' ? fact('pi', 'Pi', { installed: true }) : entry));
    expect(rows(SAMPLE.installed, landed, { running: 'pi' }).find((row) => row.cli === 'pi')).toMatchObject({
      status: 'ready',
    });
  });

  it("a failed install stays on its row with the installer's last words, until the agent is there", () => {
    const failed = { failed: { pi: { detail: 'npm ERR! network' } } };
    expect(rows(SAMPLE.installed, FACTS, failed).find((row) => row.cli === 'pi')).toMatchObject({
      status: 'installable',
      actions: ['install'],
      error: {
        message: { text: LOCAL_MODEL_INSTALL_LABELS.errHarnessFailed, vars: { cli: 'Pi' } },
        detail: 'npm ERR! network',
      },
    });
    const there = FACTS.map((entry) => (entry.cli === 'pi' ? fact('pi', 'Pi', { installed: true }) : entry));
    expect(rows(SAMPLE.installed, there, failed).find((row) => row.cli === 'pi')).not.toHaveProperty('error');
  });

  it('the view: an agent that can be started offers a session exactly when the model does', () => {
    const harnesses = rows();
    const up = buildInstallView(SAMPLE.installed, { ...LIVE, running: true, digest: 'same', harnesses });
    expect(up.harnesses.map((row) => [row.cli, row.actions])).toEqual([
      ['opencode', ['start-session']],
      ['claude', ['start-session']],
      ['pi', ['install']],
      ['deepseek', []],
    ]);
    expect(up.actions).toContain('install-agent');
    expect(up.actions).toContain('start-session');
    // A stopped runtime: nothing is started, an agent can still be installed.
    const down = buildInstallView(SAMPLE.installed, { ...LIVE, running: false, harnesses });
    expect(down.harnesses.map((row) => row.actions)).toEqual([[], [], ['install'], []]);
    expect(down.actions).not.toContain('start-session');
    expect(down.actions).toContain('install-agent');
    // The live facts are not changed by the view.
    expect(harnesses[0].actions).toEqual([]);
  });

  it('the view: with no agent that can be started no session is offered, and `cli` names the default row', () => {
    const none = FACTS.map((entry) => fact(entry.cli, entry.label, { installable: true, installCommand: 'x' }));
    const view = buildInstallView(SAMPLE.installed, {
      ...LIVE,
      running: true,
      digest: 'same',
      harnesses: rows(SAMPLE.installed, none),
    });
    expect(view.actions).not.toContain('start-session');
    expect(view.actions).toContain('install-agent');
    expect(view.cli).toBe('opencode');

    const gone = FACTS.map((entry) =>
      entry.cli === 'opencode' ? fact('opencode', 'OpenCode', { installable: true, installCommand: 'x' }) : entry
    );
    const other = buildInstallView(SAMPLE.installed, {
      ...LIVE,
      running: true,
      digest: 'same',
      harnesses: rows(SAMPLE.installed, gone),
    });
    // What an older client reads as "the agent to start": one that is there.
    expect([other.cli, other.cliLabel]).toEqual(['claude', 'Claude Code']);
    expect(other.actions).toContain('start-session');
  });

  it('install-agent is an action of the installed state only', () => {
    for (const state of Object.keys(INSTALL_STATE_TABLE) as LocalModelInstallState[]) {
      expect(INSTALL_STATE_TABLE[state].actions.includes('install-agent')).toBe(state === 'installed');
    }
    // Listed only while a row offers it.
    expect(allowedActions(SAMPLE.installed, { ...LIVE, running: true })).not.toContain('install-agent');
  });
});

describe('markLibraryCandidates', () => {
  const candidate = (modelId: string, context: number) => ({ modelId, context }) as Recommendation['alternatives'][0];
  const view = buildInstallView(SAMPLE.installed, { ...LIVE, running: true });

  it('marks the model in use and a model a switch can take, at the context they were checked with', () => {
    const recommendation = {
      verdict: 'ok',
      pick: candidate(MODEL.id, MODEL.context),
      alternatives: [candidate(OTHER.id, OTHER.context), candidate('gpt-oss:20b', 65536)],
    } as unknown as Recommendation;
    const marked = markLibraryCandidates(recommendation, view);
    expect(marked.pick?.library).toBe('active');
    expect(marked.alternatives[0].library).toBe('ready');
    expect(marked.alternatives[1]).not.toHaveProperty('library');
    // The input is not written to.
    expect(recommendation.pick).not.toHaveProperty('library');
  });

  it('a row at another context than the one that was checked is an install like any other', () => {
    const recommendation = {
      verdict: 'ok',
      pick: candidate(MODEL.id, 65536),
      alternatives: [candidate(OTHER.id, 131072)],
    } as unknown as Recommendation;
    expect(markLibraryCandidates(recommendation, view)).toBe(recommendation);
  });

  it('hands back the same object when there is nothing to mark', () => {
    const none = { verdict: 'none', alternatives: [] } as unknown as Recommendation;
    expect(markLibraryCandidates(none, view)).toBe(none);
    const idle = buildInstallView(SAMPLE.idle, LIVE);
    const recommendation = { verdict: 'ok', pick: candidate(MODEL.id, MODEL.context), alternatives: [] };
    expect(markLibraryCandidates(recommendation as unknown as Recommendation, idle)).toBe(recommendation);
  });

  it('a checked model that changed is not marked ready', () => {
    const changed = buildInstallView(SAMPLE.installed, {
      ...LIVE,
      running: true,
      tags: [
        { name: MODEL.id, size: 1, digest: 'abc123' },
        { name: OTHER.id, size: 1, digest: 'other' },
      ],
    });
    const recommendation = {
      verdict: 'ok',
      pick: candidate(OTHER.id, OTHER.context),
      alternatives: [],
    } as unknown as Recommendation;
    expect(markLibraryCandidates(recommendation, changed).pick).not.toHaveProperty('library');
  });
});

describe('formatInstallMessage', () => {
  it('fills the slots of a sentence', () => {
    expect(formatInstallMessage({ text: LOCAL_MODEL_INSTALL_LABELS.errPortInUse, vars: { port: '11435' } })).toBe(
      'Port 11435 is in use by another program.'
    );
    expect(
      formatInstallMessage({
        text: LOCAL_MODEL_INSTALL_LABELS.errContextNotApplied,
        vars: { model: 'Qwen3.6 35B-A3B', actual: '32768', wanted: '131072' },
      })
    ).toBe('Qwen3.6 35B-A3B loaded with a context of 32768 tokens instead of 131072.');
  });

  it('leaves a sentence without slots, and a slot without a value, as they are', () => {
    expect(formatInstallMessage({ text: LOCAL_MODEL_INSTALL_LABELS.conflictJobRunning })).toBe(
      'An install is already running.'
    );
    expect(formatInstallMessage({ text: LOCAL_MODEL_INSTALL_LABELS.errPortInUse })).toBe(
      'Port {port} is in use by another program.'
    );
    // A slot name that is a member of every object is not a value.
    expect(formatInstallMessage({ text: LOCAL_MODEL_INSTALL_LABELS.errPortInUse, vars: {} })).toContain('{port}');
  });
});
