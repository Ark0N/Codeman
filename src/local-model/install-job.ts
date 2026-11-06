/**
 * @fileoverview The local model install job: its state table, the pure reducer over it, the
 * pure view of it, and the service that drives it.
 *
 * CONTRACT STAGE: the three tables (`INSTALL_STATE_TABLE`, `INSTALL_STEP_TABLE`,
 * `INSTALL_TRANSITIONS`) are final and are what the reducer's table-driven test iterates.
 * Every function below has its final signature and a body that throws; the bodies are written
 * next.
 *
 * ONE job at a time. The job is five steps in a fixed order (`LOCAL_MODEL_INSTALL_STEPS`:
 * runtime, model, verify, agent, connect; `agent` is left out when the coding agent is
 * installed). Its state is one of five (`LocalModelInstallState`), stored in the state file.
 *
 * The state table. "On disk" names what lies under the local model folder; the two writes
 * outside it belong to the `connect` step.
 *
 * | State        | On disk                                   | A server restart            | Cancel                 | Allowed next actions            |
 * |--------------|-------------------------------------------|-----------------------------|------------------------|---------------------------------|
 * | `idle`       | nothing, or leftovers a Remove could not  | stays `idle`                | refused (409)          | install                         |
 * |              | delete (never read back)                  |                             |                        |                                 |
 * | `installing` | what the finished steps wrote, plus what  | becomes `paused` at the     | becomes `paused` at    | cancel                          |
 * |              | the current step has written so far       | same step; nothing resumes  | the same step          |                                 |
 * |              | (see the step table)                      | without a click             |                        |                                 |
 * | `paused`     | as `installing` at that step, nothing in  | stays `paused`              | refused (409)          | resume, install (another        |
 * |              | flight                                    |                             |                        | choice), remove                 |
 * | `failed`     | as `installing` at that step, nothing in  | stays `failed`, same error  | refused (409)          | resume (try again), install     |
 * |              | flight                                    |                             |                        | (another choice), remove        |
 * | `installed`  | the runtime, the private home, the model  | stays `installed`; the      | refused (409)          | start a session, start or stop  |
 * |              |                                           | runtime is started again    |                        | the runtime, remove             |
 * |              |                                           | when it was not stopped     |                        |                                 |
 *
 * The step table. Every step is IDEMPOTENT, so Resume and "Try again" re-enter the step the
 * job stopped in; they first make sure the runtime runs when the step needs it.
 *
 * | Step      | Adds to disk                          | Cancel                                   | Resume                                         |
 * |-----------|---------------------------------------|------------------------------------------|------------------------------------------------|
 * | `runtime` | the archive's partial file, then the  | aborts the download, the partial file    | continues the partial file with a Range        |
 * |           | unpacked runtime, then the private    | stays                                    | request, or skips what is already unpacked     |
 * |           | home once the runtime started         |                                          |                                                |
 * | `model`   | the model store: partial blobs, then  | aborts the pull request, which stops the | pulls again; the runtime continues its partial |
 * |           | the model                             | download; the partial blobs stay         | blobs                                          |
 * | `verify`  | nothing (the model is loaded into     | aborts the request in flight             | runs the three checks again from the first     |
 * |           | memory)                               |                                          |                                                |
 * | `agent`   | whatever the coding agent's own       | kills the installer's process group      | looks for the binary first and runs the        |
 * |           | installer writes, outside our folder; |                                          | installer only when it is still missing        |
 * |           | never removed by us                   |                                          |                                                |
 * | `connect` | our endpoint record and the settings  | honoured before the first write; once    | writes both again                              |
 * |           | flag: the two writes outside our      | the writes began they finish and the job |                                                |
 * |           | folder                                | ends `installed`                         |                                                |
 *
 * How the memory budget gets measured before a model is downloaded (ONE consent, bound to the
 * size shown): the person confirms `Candidate.installBytes` once. The `runtime` step then
 * gets and starts the runtime, reads the device total from its log and judges the choice
 * again with it (`modelFitsBudget()`; `recommend()` with the same options names the next
 * model). When the chosen model at the chosen context no longer fits, the job fails right
 * there with `does-not-fit` and the next model that fits, BEFORE the model download starts. When it fits, the job goes on without a second question: the sizes that were
 * confirmed did not change. From then on the GET reports `budgetSource: 'measured'`.
 *
 * Rules:
 *  - `reduceInstallJob()` is PURE and total: an event the transition table does not list for
 *    the current state is refused by returning the SAME object, which the service answers
 *    with 409 `wrong-state`.
 *  - The reducer moves the state, the step, the error and the progress. The FACTS a step
 *    learns (the port and pid, the measured total, the pull's total, the digest, what the
 *    runtime loaded, the previous settings flag) are written by the service through
 *    `mutateLocalModelState()` and never change the state.
 *  - A job read as `installing` at boot was interrupted by the restart: the service applies
 *    the event `restart` before anything else, so it is `paused` and waits for a click.
 *  - A new install from `paused` or `failed` REPLACES the job. When it names another model,
 *    what the old job left of its model is deleted from the store first.
 *  - Install is checked before anything is downloaded: admin only in multi-user mode; the
 *    model, the context and the coding agent must be a row the current recommendation offers;
 *    the coding agent must be a harness row of the catalogue; `acknowledgedBytes` must be the
 *    server's own total.
 *  - No CLI id is compared with a literal here: the coding agent is a catalogue row plus a
 *    `HarnessFact`.
 */

import type {
  HardwareFacts,
  HarnessFact,
  LocalModelAction,
  LocalModelCatalog,
  LocalModelConflict,
  LocalModelDeveloperTools,
  LocalModelErrorCode,
  LocalModelInstallError,
  LocalModelInstallRequest,
  LocalModelInstallState,
  LocalModelInstallStep,
  LocalModelInstallView,
  LocalModelRemoveRequest,
  LocalModelResumeRequest,
  LocalModelRuntimePin,
  LocalModelRuntimeRequest,
  LocalModelStateFile,
  Recommendation,
  RecommendOptions,
} from '../types.js';
import type { CliInstallResult, RunInstallCommandOptions } from '../cli-install-runner.js';
import type { ConnectLocalModelInput, ConnectResult } from './connect.js';
import type { OllamaTarget, PullOptions, PullResult, VerifyResult } from './ollama-client.js';
import type { LocalModelPaths } from './paths.js';
import type {
  ChooseRuntimePortOptions,
  RemoveLocalModelFilesOptions,
  RuntimeInstallOptions,
  RuntimeInstallResult,
  RuntimeSupervisor,
} from './runtime.js';

/** Marks a body the contract stage left unwritten. */
function notImplemented(what: string, ..._args: unknown[]): never {
  throw new Error(`${what} is not implemented yet`);
}

// ---------- The state table ----------

/** One row of the state table. */
export interface InstallStateRow {
  /** What lies on disk in this state, in words. */
  onDisk: string;
  /** The state a server restart turns this one into. */
  afterRestart: LocalModelInstallState;
  /** What the restart does, in words. */
  restart: string;
  /** The state Cancel turns this one into, or `null` when Cancel is refused (409 `wrong-state`). */
  afterCancel: LocalModelInstallState | null;
  /** What Cancel does, in words. */
  cancel: string;
  /**
   * Every action a client may take in this state. The view's `actions` is this list narrowed
   * by what is live (`allowedActions()`): `start` only while the runtime is down, `stop` and
   * `start-session` only while it runs, `start-session` only when nothing blocks a session.
   */
  actions: readonly LocalModelAction[];
}

/** The state table of the file header, as data. */
export const INSTALL_STATE_TABLE: Readonly<Record<LocalModelInstallState, InstallStateRow>> = {
  idle: {
    onDisk:
      'Nothing of ours. The local model folder is absent, or holds leftovers an earlier Remove could not delete; they are never read back.',
    afterRestart: 'idle',
    restart: 'Nothing happens.',
    afterCancel: null,
    cancel: 'Refused: no job is running.',
    actions: ['install'],
  },
  installing: {
    onDisk:
      'What the finished steps wrote, plus what the current step has written so far (INSTALL_STEP_TABLE). The state file names the model, the coding agent, the context and the step.',
    afterRestart: 'paused',
    restart:
      'The job comes back paused at the same step. Nothing is downloaded, started or installed until the person presses Resume.',
    afterCancel: 'paused',
    cancel: 'The step in flight is interrupted the way its step row says, and the job is paused at that step.',
    actions: ['cancel'],
  },
  paused: {
    onDisk: 'As installing at that step, with nothing in flight.',
    afterRestart: 'paused',
    restart: 'Stays paused.',
    afterCancel: null,
    cancel: 'Refused: no job is running.',
    actions: ['resume', 'install', 'remove'],
  },
  failed: {
    onDisk: 'As installing at that step, with nothing in flight.',
    afterRestart: 'failed',
    restart: 'Stays failed, with the same error.',
    afterCancel: null,
    cancel: 'Refused: no job is running.',
    actions: ['resume', 'install', 'remove'],
  },
  installed: {
    onDisk:
      'The runtime, its private home and the model. The state file holds the port, the pid, the digest, what the runtime loaded and the previous settings flag. Outside the folder: our endpoint record and the settings flag.',
    afterRestart: 'installed',
    restart:
      'Stays installed. The runtime is started again unless the person had stopped it, and the digest is read again: a changed digest or a port taken by another program shows as an error on the view and blocks a session, the state stays installed.',
    afterCancel: null,
    cancel: 'Refused: no job is running.',
    actions: ['start-session', 'start', 'stop', 'remove'],
  },
};

// ---------- The step table ----------

/** One row of the step table. */
export interface InstallStepRow {
  /** What the step does, in words. */
  does: string;
  /** What it adds to disk (possibly partly, when it is interrupted). */
  onDisk: string;
  /** How Cancel interrupts it. */
  cancel: string;
  /** What Resume, and "Try again" after a failure, does: every step is idempotent and is entered again. */
  resume: string;
  /** Whether the step reports byte progress (`LocalModelProgress`). */
  progress: boolean;
  /** Whether the runtime must run before the step is entered (the service starts it first, idempotently). */
  needsRuntime: boolean;
  /** Every error code the step can fail with. `internal` and `disk-full` can come from any step that writes. */
  errors: readonly LocalModelErrorCode[];
}

/** The step table of the file header, as data. */
export const INSTALL_STEP_TABLE: Readonly<Record<LocalModelInstallStep, InstallStepRow>> = {
  runtime: {
    does: 'Downloads the pinned runtime archive unless it is unpacked already, compares its sha256, unpacks it, chooses the port once, starts the runtime, reads the measured memory budget from its log and judges the chosen model against it.',
    onDisk:
      'runtime/ollama-<version>.tgz.partial while it downloads, runtime/ollama-<version>/ once unpacked, home/ once the runtime started.',
    cancel: 'Aborts the download. The partial file stays. A runtime that already runs keeps running.',
    resume:
      'Continues the partial file with a Range request, or skips the download when the folder is unpacked. Starting the runtime again is a no-op when it runs.',
    progress: true,
    needsRuntime: false,
    errors: [
      'runtime-download-failed',
      'runtime-damaged',
      'runtime-unpack-failed',
      'runtime-start-failed',
      'port-in-use',
      'does-not-fit',
      'disk-full',
      'internal',
    ],
  },
  model: {
    does: 'Pulls the model through the runtime, reading the progress stream line by line.',
    onDisk: 'models/ with partial blobs, then the finished model.',
    cancel: 'Aborts the pull request, which stops the download. The partial blobs stay.',
    resume: 'Pulls again. The runtime continues its partial blobs.',
    progress: true,
    needsRuntime: true,
    errors: ['pull-failed', 'model-not-found', 'runtime-start-failed', 'port-in-use', 'disk-full', 'internal'],
  },
  verify: {
    does: 'Loads the model with one tiny chat, checks that the runtime put all of it on the GPU at the chosen context, runs one tool probe, and stores the digest the runtime reports.',
    onDisk: 'Nothing new. The model is loaded into memory.',
    cancel: 'Aborts the request in flight.',
    resume: 'Runs the three checks again from the first.',
    progress: false,
    needsRuntime: true,
    errors: [
      'load-failed',
      'does-not-fit',
      'context-not-applied',
      'no-tool-call',
      'probe-unfinished',
      'runtime-start-failed',
      'port-in-use',
      'internal',
    ],
  },
  agent: {
    does: 'Installs the coding agent with its stock install command through the shared CLI install runner, writes the admin audit entry, forgets the cached lookups of its binary and looks for it again.',
    onDisk:
      'Whatever the coding agent installer writes, outside the local model folder (its own folder in the home directory). Never removed by us.',
    cancel: 'Kills the whole process group of the installer.',
    resume: 'Looks for the binary first and runs the installer only when it is still missing.',
    progress: false,
    needsRuntime: false,
    errors: ['harness-failed', 'internal'],
  },
  connect: {
    does: 'Writes the endpoint record and switches the custom model endpoints setting on, keeping its previous value in the state file.',
    onDisk:
      'Our record in custom-model-hosts.json and the flag in settings.json: the two writes outside the local model folder.',
    cancel:
      'Honoured before the first write. Once the writes began they finish and the job ends installed, so the pair is never left half done.',
    resume: 'Writes both again. Both are idempotent.',
    progress: false,
    needsRuntime: true,
    errors: ['endpoint-id-taken', 'connect-failed', 'internal'],
  },
};

// ---------- Events and transitions ----------

/** What moves the job. */
export type InstallJobEvent =
  /** A new job: `POST /api/local-model/install` passed its checks. From `idle`, `paused` or `failed`. */
  | {
      type: 'install';
      model: { id: string; label: string; context: number };
      cli: { id: string; label: string };
      /** The steps of this job in order (`jobSteps()`). */
      steps: LocalModelInstallStep[];
    }
  /** A download moved. Changes `progress` only. */
  | { type: 'progress'; completedBytes: number; totalBytes: number }
  /** The current step finished: the next step of `steps`, or `installed` after the last. Clears `progress`. */
  | { type: 'step-done' }
  /** The current step failed. */
  | {
      type: 'fail';
      code: LocalModelErrorCode;
      vars?: Record<string, string>;
      detail?: string;
      nextModelId?: string;
    }
  /** `POST /api/local-model/cancel`. */
  | { type: 'cancel' }
  /** The server started and found this state in the file. */
  | { type: 'restart' }
  /** `POST /api/local-model/resume`: the same step again. Clears `error`. */
  | { type: 'resume' }
  /** `DELETE /api/local-model` finished: back to `idle`, every other member dropped. */
  | { type: 'remove' };

export type InstallJobEventType = InstallJobEvent['type'];

/**
 * Which state an event leads to, by current state. A pair that is not listed is REFUSED: the
 * reducer returns the object it was given. One entry needs a word: `step-done` in
 * `installing` leads to `installing` at the next step, and to `installed` when the step that
 * finished was the last of the job's `steps`.
 */
export const INSTALL_TRANSITIONS: Readonly<
  Record<LocalModelInstallState, Readonly<Partial<Record<InstallJobEventType, LocalModelInstallState>>>>
> = {
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
};

/** The steps a job runs, in order: all of `LOCAL_MODEL_INSTALL_STEPS`, without `agent` when the coding agent is installed. Pure. */
export function jobSteps(input: { agentInstalled: boolean }): LocalModelInstallStep[] {
  return notImplemented('jobSteps', input);
}

/**
 * The state file after `event`. Pure: no IO, no clock (`updatedAt` is the state store's
 * business). Refuses an event the transition table does not list for the current state by
 * returning `current` itself. Keeps `runtime` and `connection` across a new install, because
 * what they record is still on disk; `remove` drops everything.
 */
export function reduceInstallJob(current: LocalModelStateFile, event: InstallJobEvent): LocalModelStateFile {
  return notImplemented('reduceInstallJob', current, event);
}

// ---------- The view ----------

/** What is live and not in the state file, for the view. Gathered by the service on every GET. */
export interface InstallLiveFacts {
  /** The runtime child is alive (`RuntimeStatus.running`). */
  running: boolean;
  /** The supervisor stopped restarting the runtime (`RuntimeStatus.gaveUp`): the error `runtime-stopped` in state `installed`. */
  gaveUp: boolean;
  /** Another program holds the stored port: the error `port-in-use` in state `installed`. */
  portInUse: boolean;
  /** The stored digest against the runtime's current one (`compareModelDigest()`). `changed` is the error `model-changed`. Absent while not installed. */
  digest?: 'same' | 'changed' | 'unknown';
  developerTools: LocalModelDeveloperTools;
  /** The pinned runtime is unpacked on disk. */
  runtimeInstalled: boolean;
  /** The current download speed. Not stored, so absent after a restart. */
  bytesPerSecond?: number;
  /** For an error whose next step is `next-model`: the model to offer, from the current recommendation. */
  nextModel?: { modelId: string; modelLabel: string };
  pin: LocalModelRuntimePin;
  /** `LocalModelPaths.root`, for the "where it goes" line. */
  folder: string;
}

/** The actions the server accepts right now: the state row's list narrowed by what is live. Pure. */
export function allowedActions(state: LocalModelStateFile, live: InstallLiveFacts): LocalModelAction[] {
  return notImplemented('allowedActions', state, live);
}

/** The `install` object of the GET. Pure: every size text comes from `formatGb()`, every sentence from `LOCAL_MODEL_INSTALL_LABELS`. */
export function buildInstallView(state: LocalModelStateFile, live: InstallLiveFacts): LocalModelInstallView {
  return notImplemented('buildInstallView', state, live);
}

// ---------- The service ----------

/** Who asked, for the admin audit entry of the coding agent install. */
export interface LocalModelActor {
  username: string;
  ip?: string;
}

/** How a verb ended: the view after it, a 400 with its message, or a 409 with its conflict. */
export type LocalModelVerbResult =
  | { ok: true; view: LocalModelInstallView }
  | { ok: false; status: 400; message: string }
  | { ok: false; status: 409; conflict: LocalModelConflict };

/**
 * Everything the service calls, so a test spawns, fetches and downloads nothing. Each member
 * defaults to the real module. The members named like a function of another module have
 * exactly that function's signature.
 */
export interface LocalModelServiceDeps {
  readHardware: () => Promise<HardwareFacts>;
  getCatalog: () => LocalModelCatalog;
  buildHarnessFacts: (catalog: LocalModelCatalog) => Promise<HarnessFact[]>;
  recommend: (
    hw: HardwareFacts,
    catalog: LocalModelCatalog,
    harnessFacts: readonly HarnessFact[],
    options?: RecommendOptions
  ) => Recommendation;
  /** `modelFitsBudget()` of src/local-model/recommend.ts: the judgement of the `runtime` step, with the measured budget. */
  modelFitsBudget: (
    hw: HardwareFacts,
    catalog: LocalModelCatalog,
    modelId: string,
    context: number,
    options?: RecommendOptions
  ) => boolean;
  // src/local-model/runtime.ts
  isRuntimeInstalled: (pin?: LocalModelRuntimePin, paths?: LocalModelPaths) => Promise<boolean>;
  ensureRuntimeInstalled: (options?: RuntimeInstallOptions) => Promise<RuntimeInstallResult>;
  chooseRuntimePort: (options?: ChooseRuntimePortOptions) => Promise<number | undefined>;
  removeLocalModelFiles: (options: RemoveLocalModelFilesOptions) => Promise<void>;
  supervisor: RuntimeSupervisor;
  // src/local-model/ollama-client.ts
  pullModel: (target: OllamaTarget, modelId: string, options?: PullOptions) => Promise<PullResult>;
  verifyModel: (target: OllamaTarget, modelId: string, context: number, signal?: AbortSignal) => Promise<VerifyResult>;
  readModelDigest: (target: OllamaTarget, modelId: string, signal?: AbortSignal) => Promise<string | undefined>;
  listOpenAiModels: (target: OllamaTarget, signal?: AbortSignal) => Promise<string[]>;
  deleteModel: (target: OllamaTarget, modelId: string, signal?: AbortSignal) => Promise<boolean>;
  // src/local-model/developer-tools.ts
  checkDeveloperTools: () => Promise<LocalModelDeveloperTools>;
  // src/cli-install-runner.ts
  stockInstallCommand: (id: string) => string | undefined;
  tryBeginCliInstall: (id: string) => (() => void) | null;
  runInstallCommand: (command: string, options?: RunInstallCommandOptions) => Promise<CliInstallResult>;
  /** Forgets the cached lookups of the CLI's binaries, then says whether its binary is found now. */
  recheckCliInstalled: (cli: string) => Promise<boolean>;
  /** Writes one admin audit line (`appendAdminAudit()`). */
  audit: (entry: { admin: string; action: string; target: string; ip?: string; detail?: unknown }) => Promise<void>;
  // src/local-model/connect.ts
  connectLocalModel: (input: ConnectLocalModelInput) => Promise<ConnectResult>;
  moveLocalEndpoint: (port: number) => Promise<void>;
  disconnectLocalModel: (input: { flagWasEnabled: boolean }) => Promise<void>;
  // src/local-model/state-store.ts
  readState: () => Promise<LocalModelStateFile>;
  mutateState: (
    fn: (current: LocalModelStateFile) => LocalModelStateFile | undefined
  ) => Promise<{ before: LocalModelStateFile; after: LocalModelStateFile | undefined }>;
  pin: LocalModelRuntimePin;
  paths: LocalModelPaths;
}

/** The install as the routes and the server see it. One per process. */
export interface LocalModelService {
  /** The `install` object of the GET. Never throws. */
  view(): Promise<LocalModelInstallView>;
  /**
   * Whether a session may be started on the saved endpoint `endpointId` right now. `undefined`:
   * yes, which is also the answer for every endpoint that is not this feature's. Otherwise the
   * error that refuses the launch, in this order: `runtime-not-running` (the runtime child
   * Codeman started is not alive, so whatever answers on the port is not ours),
   * `port-in-use`, `runtime-stopped`, `model-changed` (the digest is read again and is not the
   * stored one). The session launch path asks this before it starts a session with the
   * managed endpoint, and `boot()` asks it once. Never throws.
   */
  launchRefusal(endpointId: string): Promise<LocalModelInstallError | undefined>;
  /** What the GET passes to `recommend()`: the stored measured total and the runtime download that is still needed. */
  recommendOptions(): Promise<RecommendOptions>;
  /** `POST /api/local-model/install`. Answers once the job is STARTED; the job runs on in the server. */
  install(request: LocalModelInstallRequest, actor: LocalModelActor): Promise<LocalModelVerbResult>;
  /** `POST /api/local-model/cancel`. Answers once the step in flight was interrupted. */
  cancel(): Promise<LocalModelVerbResult>;
  /** `POST /api/local-model/resume`. */
  resume(request: LocalModelResumeRequest, actor: LocalModelActor): Promise<LocalModelVerbResult>;
  /** `POST /api/local-model/runtime`. */
  runtime(request: LocalModelRuntimeRequest): Promise<LocalModelVerbResult>;
  /**
   * `DELETE /api/local-model`. `liveSessionNames` is what `sessionNamesUsingEndpoint()` found:
   * not empty answers 409 `sessions-open`. Else: stop the runtime, remove our endpoint record,
   * restore the settings flag when this feature switched it on and no other endpoint is left,
   * delete the runtime and the private home and (when asked) the models. The coding agent stays.
   */
  remove(request: LocalModelRemoveRequest, liveSessionNames: readonly string[]): Promise<LocalModelVerbResult>;
  /**
   * Called once when the server starts. An interrupted job becomes `paused`. An installed
   * runtime that was not stopped is started (an own orphan on the port is adopted or
   * replaced, another listener is `port-in-use`) and the digest is read again. Never throws,
   * and never keeps the server from starting.
   */
  boot(): Promise<void>;
  /** Called when the server stops, beside `stopDeepSeekWeb()`: aborts a job in flight (it reads `paused` at the next boot) and stops the runtime. */
  shutdown(): Promise<void>;
}

/** A service over `deps`. A test builds its own with fakes. */
export function createLocalModelService(deps: Partial<LocalModelServiceDeps> = {}): LocalModelService {
  return notImplemented('createLocalModelService', deps);
}

/** The one service of this process, built on first use with the real modules. What the routes and server.ts call. */
export function getLocalModelService(): LocalModelService {
  return notImplemented('getLocalModelService');
}
