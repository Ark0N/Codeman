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
  buildInstallView,
  formatInstallMessage,
  INSTALL_STATE_TABLE,
  INSTALL_STEP_TABLE,
  INSTALL_TRANSITIONS,
  installedBlocker,
  jobSteps,
  reduceInstallJob,
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
  type LocalModelAction,
  type LocalModelErrorCode,
  type LocalModelInstallState,
  type LocalModelInstallStep,
  type LocalModelStateFile,
} from '../src/types.js';

const STATES: LocalModelInstallState[] = ['idle', 'installing', 'paused', 'failed', 'installed'];
const EVENT_TYPES: InstallJobEventType[] = [
  'install',
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

const JOB: LocalModelStateFile = {
  schema: 1,
  state: 'installing',
  step: 'model',
  steps: ALL_STEPS,
  model: MODEL,
  cli: CLI,
  runtime: RUNTIME,
  progress: { completedBytes: 6_200_000_000, totalBytes: 23_105_798_956 },
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
      paused: { resume: 'installing', install: 'installing', remove: 'idle', restart: 'paused' },
      failed: { resume: 'installing', install: 'installing', remove: 'idle', restart: 'failed' },
      installed: { remove: 'idle', restart: 'installed' },
    });
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

  it('covers all 40 pairs, 18 of them listed', () => {
    const listed = STATES.flatMap((state) => Object.keys(INSTALL_TRANSITIONS[state]));
    expect(STATES.length * EVENT_TYPES.length).toBe(40);
    expect(listed).toHaveLength(18);
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
    expect(row.actions.includes('cancel')).toBe(accepts('cancel'));
    expect(row.actions.includes('resume')).toBe(accepts('resume'));
    // Remove is refused only while a job runs. From idle it only clears leftovers, so the
    // window offers no button for it there.
    if (state !== 'idle') expect(row.actions.includes('remove')).toBe(accepts('remove'));
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
  it('outside installed it is the state row, whatever is live', () => {
    for (const state of ['idle', 'installing', 'paused', 'failed'] as const) {
      expect(allowedActions(SAMPLE[state], { ...LIVE, running: true, gaveUp: true, portInUse: true })).toEqual([
        ...INSTALL_STATE_TABLE[state].actions,
      ]);
    }
    expect(allowedActions(SAMPLE.idle, LIVE)).toEqual(['install']);
    expect(allowedActions(SAMPLE.installing, LIVE)).toEqual(['cancel']);
    expect(allowedActions(SAMPLE.paused, LIVE)).toEqual(['resume', 'install', 'remove']);
    expect(allowedActions(SAMPLE.failed, LIVE)).toEqual(['resume', 'install', 'remove']);
  });

  it('installed and running: a session can be started and the runtime stopped', () => {
    expect(allowedActions(SAMPLE.installed, { ...LIVE, running: true, digest: 'same' })).toEqual([
      'start-session',
      'stop',
      'remove',
    ]);
  });

  it('installed and stopped: it can be started, and no session is offered', () => {
    expect(allowedActions(SAMPLE.installed, LIVE)).toEqual(['start', 'remove']);
  });

  it('installed and running a model that changed: no session', () => {
    expect(allowedActions(SAMPLE.installed, { ...LIVE, running: true, digest: 'changed' })).toEqual(['stop', 'remove']);
  });

  it('a digest that could not be read does not hide the session button: the launch itself reads it again', () => {
    expect(allowedActions(SAMPLE.installed, { ...LIVE, running: true, digest: 'unknown' })).toContain('start-session');
    expect(allowedActions(SAMPLE.installed, { ...LIVE, running: true })).toContain('start-session');
  });

  it('never returns the table row itself', () => {
    const actions = allowedActions(SAMPLE.idle, LIVE);
    actions.push('remove');
    expect(INSTALL_STATE_TABLE.idle.actions).toEqual(['install']);
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
      actions: ['install'],
    });
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
    expect(view.actions).toEqual(['resume', 'install', 'remove']);
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
      actions: ['start-session', 'stop', 'remove'],
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
    expect(view.actions).toEqual(['stop', 'remove']);
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
