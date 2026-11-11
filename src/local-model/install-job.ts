/**
 * @fileoverview The local model install job: its state table, the pure reducer over it, the
 * pure view of it, and the service that drives it.
 *
 * ONE job at a time. The job is five steps in a fixed order (`LOCAL_MODEL_INSTALL_STEPS`:
 * runtime, model, verify, agent, connect; `agent` is left out when the coding agent is
 * installed). Its state is one of five (`LocalModelInstallState`), stored in the state file.
 *
 * A LIBRARY with ONE model in use. The store can hold several models; exactly one of them is
 * the model in use: the one the saved endpoint record lists, the runtime is started for and a
 * session may be launched on. `LocalModelStateFile.library` lists every model that passed the
 * check through Codeman. A job makes its model the one in use when it ends: an install (also
 * from `installed`, which adds a model and keeps the earlier ones) or a switch (`use`, the two
 * steps `USE_JOB_STEPS`: nothing is downloaded, the model is loaded and checked again and its
 * digest must still be the stored one).
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
 * |              | flight                                    |                             |                        | choice), use (a checked model), |
 * |              |                                           |                             |                        | delete a model, remove          |
 * | `failed`     | as `installing` at that step, nothing in  | stays `failed`, same error  | refused (409)          | resume (try again), install     |
 * |              | flight                                    |                             |                        | (another choice), use, delete a |
 * |              |                                           |                             |                        | model, remove                   |
 * | `installed`  | the runtime, the private home, the model  | stays `installed`; the      | refused (409)          | start a session, start or stop  |
 * |              | in use and every other model of the       | runtime is started again    |                        | the runtime, install (add a     |
 * |              | library                                   | when it was not stopped     |                        | model), use, delete a model,    |
 * |              |                                           |                             |                        | install a coding agent, remove  |
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
 * |           | folder. The state file claims them    | ends `installed`                         |                                                |
 * |           | first                                 |                                          |                                                |
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
 *  - A new install or a switch from `paused` or `failed` REPLACES the job. When it names another
 *    model, what the old job left of its model is deleted from the store first: the model
 *    through the runtime when it was downloaded whole, and the partial blobs of a download that
 *    was interrupted (the runtime knows no model for those, so they are deleted as files). A
 *    model of the library is never deleted that way: it was checked, and it stays until the
 *    person deletes it.
 *  - Installing another model and switching change which model the runtime holds (it holds
 *    one), and often its context. Both are refused (409 `sessions-open`) while live sessions
 *    use the endpoint, like Stop: their coding agents were started with the other model's name.
 *  - While a job that started from `installed` is not finished (`installing`, `paused`,
 *    `failed`), no session is started: the launch check wants the state `installed`. `use` on
 *    the earlier model is the way back.
 *  - A model is deleted ONLY through the runtime (`deleteModel()`), by a name that is in the
 *    server's own listing (the library or the runtime's tags), never by a path. The model of
 *    the installation or of the current job is refused (`model-active`): switch first, or
 *    Remove. Deleting moves no state: it is not an event of the reducer, and whether a state
 *    allows it is the `delete-model` action of its row in `INSTALL_STATE_TABLE`.
 *  - Install is checked before anything is downloaded: admin only in multi-user mode; the
 *    model, the context and the coding agent must be a row the current recommendation offers;
 *    the coding agent must be a harness row of the catalogue; `acknowledgedBytes` must be the
 *    server's own total.
 *  - No CLI id is compared with a literal here: the coding agent is a catalogue row plus a
 *    `HarnessFact`.
 *  - The coding agent is chosen PER SESSION. The state file's `cli` is the agent of the job
 *    and, once installed, the default one; the view's `harnesses` lists every catalogue harness
 *    the model in use can be run with (`buildHarnessRows()`). The launch check
 *    (`launchRefusalMessage()`) asks about the endpoint and the model, never about the agent.
 *  - Installing one more coding agent beside an installed model (`installAgent()`,
 *    `POST /api/local-model/agent`) is NOT a job and not an event of the reducer: the state
 *    stays `installed` whatever the installer does, so a failed `npm install` never blocks a
 *    session on a model that works. It runs in the background through the same install slot
 *    and the same stock command as the `agent` step, one at a time, and what it leaves behind
 *    is in memory only (`LocalModelHarnessRow.status` `installing`, or its `error`).
 *
 * The service (`createLocalModelService()`), beyond the reducer:
 *  - Verbs run one at a time on one queue, so two installs sent together cannot both find the
 *    state free. The view is not on that queue: the window polls it every second.
 *  - An interrupted step is never recorded as failed, whatever its last call answered (an
 *    aborted request looks like a network error): the job looks at its own signal before it
 *    writes `failed`. Cancel writes `paused` itself; a server that is stopping writes nothing,
 *    so the file still says `installing` and the next start reads that as a paused job.
 *  - A download's progress is kept in memory, written to the state file every few seconds and
 *    when the job pauses or fails. The view shows the live figure and its speed.
 *  - What blocks a session on an installed model (another program on the port, a runtime that
 *    keeps stopping or did not start, a model whose digest changed) is found live and shown as
 *    `error` on the view. It is never stored, and the state stays `installed`.
 *  - `launchRefusalMessage()` is what every path that STARTS a coding agent on the managed
 *    endpoint asks first: a new session with the model, a model applied to a session, the
 *    attach that starts an agent in a session that has none, and the rebuild after a reboot.
 *    The digest is read again for every one of them. Two things are not launches and are not
 *    asked: a pane that survived a server restart (its agent is already running), and a
 *    respawn cycle (it types into the agent that runs).
 *  - With a model installed, `boot()` puts the saved endpoint record back when it is gone (a
 *    config-backup restore can take it away), starts the runtime unless it was stopped, and
 *    reads the digest again.
 *  - A runtime an earlier server left behind (a crash, a forced quit) is never left running
 *    under a deleted folder or beside a second one: its pid is stored the moment it is
 *    spawned, a start adopts or replaces it, and Stop, Remove and the boot of anything that
 *    is not a running installation end it (`RuntimeSupervisor.stop({ previousPid })`).
 *  - An installed model keeps the runtime VERSION it was installed with: when a later build
 *    pins another version, the stored one is started for as long as its folder is unpacked.
 *  - A job whose end could not be written to the state file (a full disk) is not lost: the
 *    outcome is kept in memory, the view shows it, Resume and a new install start from it, and
 *    the next verb writes it. The same holds for any `installing` in the file while this
 *    process runs no job, which is what a restart leaves too.
 *  - Stop and "Use another port" are refused (409 `sessions-open`) while live sessions use
 *    the model: their coding agents were given the address when they started.
 *  - The view's `library` joins the state file's checked models with what the running runtime
 *    lists, and `store` is the disk use of the blob folder. Neither is asked for on every
 *    one-second poll: both are cached (`TAGS_RECHECK_MS`, `STORE_RECHECK_MS`), refreshed in the
 *    background, and thrown away by every verb and step that changes them.
 */

import { appendAdminAudit } from '../web/admin-audit.js';
import {
  CLI_INSTALL_TIMEOUT_MS,
  forgetResolvedCli,
  runInstallCommand,
  stockInstallCommand,
  tryBeginCliInstall,
  type CliInstallResult,
  type RunInstallCommandOptions,
} from '../cli-install-runner.js';
import { getCli } from '../config/cli-registry/registry.js';
import { getDataDir } from '../config/instance.js';
import { getLocalModelCatalog, LOCAL_MODEL_ID_PATTERN } from '../config/local-model-catalog.js';
import { readCustomModelHosts } from '../custom-model-hosts.js';
import {
  getErrorMessage,
  LOCAL_MODEL_ERROR_LABELS,
  LOCAL_MODEL_ERROR_NEXT,
  LOCAL_MODEL_INSTALL_LABELS,
  LOCAL_MODEL_INSTALL_STEPS,
  type Candidate,
  type CandidateHarness,
  type HardwareFacts,
  type HarnessFact,
  type LocalModelAction,
  type LocalModelAgentRequest,
  type LocalModelCatalog,
  type LocalModelConflict,
  type LocalModelDeleteRequest,
  type LocalModelDeveloperTools,
  type LocalModelErrorCode,
  type LocalModelInstallError,
  type LocalModelInstallMessage,
  type LocalModelInstallRequest,
  type LocalModelInstallState,
  type LocalModelInstallStep,
  type LocalModelInstallView,
  type LocalModelHarnessRow,
  type LocalModelHarnessStatus,
  type LocalModelLibraryAction,
  type LocalModelLibraryEntry,
  type LocalModelLibraryRow,
  type LocalModelNextStep,
  type LocalModelProgress,
  type LocalModelRemoveRequest,
  type LocalModelResumeRequest,
  type LocalModelRuntimePin,
  type LocalModelRuntimeRequest,
  type LocalModelStateFile,
  type LocalModelUseRequest,
  type Recommendation,
  type RecommendOptions,
} from '../types.js';
import { isCliEntryInstalled, probeStockCliAvailability } from '../utils/cli-installed-probes.js';
import {
  compareModelDigest,
  connectLocalModel,
  disconnectLocalModel,
  ensureLocalEndpoint,
  inspectLocalEndpoint,
  isLocalModelEndpointId,
  LOCAL_MODEL_ENDPOINT_ID,
  moveLocalEndpoint,
  type ConnectLocalModelInput,
  type ConnectResult,
  type LocalEndpointInput,
  type LocalEndpointInspection,
} from './connect.js';
import { checkDeveloperTools } from './developer-tools.js';
import { formatGb } from './format.js';
import { readHardware } from './hardware.js';
import { buildHarnessFacts } from './harness-facts.js';
import {
  deleteModel,
  getRuntimeVersion,
  listOpenAiModels,
  listRunning,
  listTags,
  pullModel,
  readModelDigest,
  verifyModel,
  type OllamaPsModel,
  type OllamaTagModel,
  type OllamaTarget,
  type PullOptions,
  type PullResult,
  type VerifyResult,
} from './ollama-client.js';
import { localModelPaths, runtimeBinaryForVersion, type LocalModelPaths } from './paths.js';
import { modelFitsBudget, needBytes, recommend } from './recommend.js';
import {
  chooseRuntimePort,
  createRuntimeSupervisor,
  ensureRuntimeInstalled,
  isRuntimeInstalled,
  measureModelStore,
  OLLAMA_RUNTIME_PIN,
  removeLocalModelFiles,
  removePartialModelBlobs,
  RUNTIME_PORT_FIRST,
  type ChooseRuntimePortOptions,
  type RemoveLocalModelFilesOptions,
  type RuntimeInstallOptions,
  type RuntimeInstallResult,
  type RuntimeStartResult,
  type RuntimeStatus,
  type RuntimeSupervisor,
} from './runtime.js';
import { IDLE_LOCAL_MODEL_STATE, mutateLocalModelState, readLocalModelState } from './state-store.js';

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
   * `start-session` only while it runs, `start-session` only when nothing blocks a session,
   * `use` and `delete-model` only while a row of the library offers them, `install-agent` only
   * while a row of `harnesses` offers it, and in `idle` `remove` only while the model store
   * still holds something.
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
    actions: ['install', 'remove'],
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
    actions: ['resume', 'install', 'use', 'delete-model', 'remove'],
  },
  failed: {
    onDisk: 'As installing at that step, with nothing in flight.',
    afterRestart: 'failed',
    restart: 'Stays failed, with the same error.',
    afterCancel: null,
    cancel: 'Refused: no job is running.',
    actions: ['resume', 'install', 'use', 'delete-model', 'remove'],
  },
  installed: {
    onDisk:
      'The runtime, its private home, the model in use and every other model of the library. The state file holds the port, the pid, the digest, what the runtime loaded, the checked models and the previous settings flag. Outside the folder: our endpoint record and the settings flag.',
    afterRestart: 'installed',
    restart:
      'Stays installed. The runtime is started again unless the person had stopped it, and the digest is read again: a changed digest or a port taken by another program shows as an error on the view and blocks a session, the state stays installed.',
    afterCancel: null,
    cancel: 'Refused: no job is running.',
    actions: ['start-session', 'start', 'stop', 'install', 'use', 'delete-model', 'install-agent', 'remove'],
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
    errors: [
      'pull-failed',
      'model-not-found',
      'runtime-start-failed',
      'runtime-stopped',
      'port-in-use',
      'disk-full',
      'internal',
    ],
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
    does: 'Claims the connection in the state file (with the value the custom model endpoints setting has now), then writes the endpoint record and switches that setting on.',
    onDisk:
      'Our record in custom-model-hosts.json and the flag in settings.json: the two writes outside the local model folder. The state file records the claim before either is written, so neither can exist without it.',
    cancel:
      'Honoured before the first write. Once the writes began they finish and the job ends installed. A job interrupted between the claim and the writes has a claim with nothing behind it, which Resume fills in and Remove undoes.',
    resume: 'Writes both again. Both are idempotent, and the claim keeps the value the setting had before.',
    progress: false,
    needsRuntime: true,
    errors: ['endpoint-id-taken', 'connect-failed', 'internal'],
  },
};

// ---------- Events and transitions ----------

/** The steps of a switch to a checked model: it is loaded and checked again, then connected. Nothing is downloaded. */
export const USE_JOB_STEPS: readonly LocalModelInstallStep[] = ['verify', 'connect'];

/** What moves the job. */
export type InstallJobEvent =
  /**
   * A new job: `POST /api/local-model/install` passed its checks. From `idle`, `paused` or
   * `failed`, and from `installed`, where it adds a model: the earlier ones stay in the library.
   */
  | {
      type: 'install';
      model: { id: string; label: string; context: number };
      cli: { id: string; label: string };
      /** The steps of this job in order (`jobSteps()`). */
      steps: LocalModelInstallStep[];
    }
  /**
   * A switch: `POST /api/local-model/use` passed its checks. From `installed`, `paused` or
   * `failed`. The model must be one of the library; its stored `digest` rides along, and the
   * `verify` step fails with `model-changed` when the runtime reports another one.
   */
  | {
      type: 'use';
      model: { id: string; label: string; context: number; digest: string };
      cli: { id: string; label: string };
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
  paused: { resume: 'installing', install: 'installing', use: 'installing', remove: 'idle', restart: 'paused' },
  failed: { resume: 'installing', install: 'installing', use: 'installing', remove: 'idle', restart: 'failed' },
  installed: { install: 'installing', use: 'installing', remove: 'idle', restart: 'installed' },
};

/**
 * The checked models of a state: its `library`, and for an `installed` state whose model is
 * not in it (a file an earlier build wrote has no list) that model too, first. A model without
 * a stored digest is never one of them: nothing could be compared when it is switched to. Pure.
 */
export function libraryOf(state: LocalModelStateFile): LocalModelLibraryEntry[] {
  const entries = [...(state.library ?? [])];
  const model = state.model;
  if (state.state === 'installed' && model?.digest && !entries.some((entry) => entry.id === model.id)) {
    entries.unshift({
      id: model.id,
      label: model.label,
      context: model.context,
      digest: model.digest,
      ...(model.pullBytes ? { bytes: model.pullBytes } : {}),
      ...(state.cli ? { cli: state.cli } : {}),
    });
  }
  return entries;
}

/** `library` with `entry` in the place of the one with its id, or at the end. Pure. */
export function upsertLibraryEntry(
  library: readonly LocalModelLibraryEntry[],
  entry: LocalModelLibraryEntry
): LocalModelLibraryEntry[] {
  const index = library.findIndex((existing) => existing.id === entry.id);
  if (index === -1) return [...library, entry];
  const next = [...library];
  next[index] = entry;
  return next;
}

/**
 * The model whose leftovers a new job for `nextId` deletes from the store first: the model of
 * the job it replaces when that is another model, else one that was already waiting to be
 * deleted. Never a model of the library (it was checked and stays until the person deletes
 * it), and never the model that is wanted now. Pure.
 */
function replacedModelFor(
  current: LocalModelStateFile,
  nextId: string,
  library: readonly LocalModelLibraryEntry[]
): string | undefined {
  const checked = (id: string): boolean => library.some((entry) => entry.id === id);
  const replaced =
    current.model && current.model.id !== nextId && !checked(current.model.id) ? current.model.id : undefined;
  const pending = replaced ?? current.replacedModelId;
  return pending !== undefined && pending !== nextId && !checked(pending) ? pending : undefined;
}

/** The steps a job runs, in order: all of `LOCAL_MODEL_INSTALL_STEPS`, without `agent` when the coding agent is installed. Pure. */
export function jobSteps(input: { agentInstalled: boolean }): LocalModelInstallStep[] {
  return LOCAL_MODEL_INSTALL_STEPS.filter((step) => step !== 'agent' || !input.agentInstalled);
}

/** A byte count as a download reports it: a whole number that is not negative. */
const isByteCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/**
 * The state file after `event`. Pure: no IO, no clock (`updatedAt` is the state store's
 * business). Refuses an event the transition table does not list for the current state by
 * returning `current` itself. Keeps `runtime`, `connection` and `library` across a new install
 * or a switch, because what they record is still on disk; `remove` drops everything.
 *
 * An event that is listed but cannot be applied is refused the same way: an `install` whose
 * steps are not a job's, a `use` of a model that is not in the library or on a state without a
 * runtime, a `progress` that is not two byte counts, a `step-done` on a state without a step,
 * and a last `step-done` on a job that has no runtime recorded.
 */
export function reduceInstallJob(current: LocalModelStateFile, event: InstallJobEvent): LocalModelStateFile {
  if (INSTALL_TRANSITIONS[current.state][event.type] === undefined) return current;
  switch (event.type) {
    case 'install': {
      const steps = event.steps.filter((step, index) => event.steps.indexOf(step) === index);
      if (
        steps.length === 0 ||
        steps.length !== event.steps.length ||
        steps.some((step) => !LOCAL_MODEL_INSTALL_STEPS.includes(step))
      ) {
        return current;
      }
      // What the replaced job left of ANOTHER model is deleted before the new one is pulled,
      // unless that model is one of the library.
      const library = libraryOf(current);
      const replacedModelId = replacedModelFor(current, event.model.id, library);
      return {
        schema: 1,
        state: 'installing',
        step: steps[0],
        steps,
        model: { id: event.model.id, label: event.model.label, context: event.model.context },
        ...(replacedModelId ? { replacedModelId } : {}),
        cli: { id: event.cli.id, label: event.cli.label },
        ...(current.runtime ? { runtime: current.runtime } : {}),
        ...(library.length > 0 ? { library } : {}),
        ...(current.connection ? { connection: current.connection } : {}),
      };
    }
    case 'use': {
      const library = libraryOf(current);
      // Only a checked model can be switched to, and only where a runtime was set up.
      if (!current.runtime || !library.some((entry) => entry.id === event.model.id)) return current;
      const replacedModelId = replacedModelFor(current, event.model.id, library);
      return {
        schema: 1,
        state: 'installing',
        step: USE_JOB_STEPS[0],
        steps: [...USE_JOB_STEPS],
        model: {
          id: event.model.id,
          label: event.model.label,
          context: event.model.context,
          digest: event.model.digest,
        },
        ...(replacedModelId ? { replacedModelId } : {}),
        cli: { id: event.cli.id, label: event.cli.label },
        runtime: current.runtime,
        library,
        ...(current.connection ? { connection: current.connection } : {}),
      };
    }
    case 'progress': {
      if (!isByteCount(event.completedBytes) || !isByteCount(event.totalBytes)) return current;
      return { ...current, progress: { completedBytes: event.completedBytes, totalBytes: event.totalBytes } };
    }
    case 'step-done': {
      const steps = current.steps ?? [];
      const index = current.step ? steps.indexOf(current.step) : -1;
      if (index === -1) return current;
      if (index < steps.length - 1) {
        const { progress: _progress, ...rest } = current;
        return { ...rest, step: steps[index + 1] };
      }
      // The last step: the model is connected.
      if (!current.model || !current.cli || !current.runtime) return current;
      return {
        schema: 1,
        state: 'installed',
        model: current.model,
        cli: current.cli,
        runtime: current.runtime,
        ...(current.loaded ? { loaded: current.loaded } : {}),
        ...(current.library ? { library: current.library } : {}),
        ...(current.connection ? { connection: current.connection } : {}),
      };
    }
    case 'fail':
      return {
        ...current,
        state: 'failed',
        error: {
          code: event.code,
          ...(event.vars && Object.keys(event.vars).length > 0 ? { vars: event.vars } : {}),
          ...(event.detail ? { detail: event.detail } : {}),
          ...(event.nextModelId ? { nextModelId: event.nextModelId } : {}),
        },
      };
    case 'cancel':
      return { ...current, state: 'paused' };
    case 'restart':
      // Only a running job changes: the restart interrupted it, and it waits for a click.
      return current.state === 'installing' ? { ...current, state: 'paused' } : current;
    case 'resume': {
      const { error: _error, ...rest } = current;
      return { ...rest, state: 'installing' };
    }
    case 'remove':
      return { schema: 1, state: 'idle' };
  }
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
  /** The last start of the runtime failed for another reason: the error `runtime-start-failed` in state `installed`, with what the runtime said. */
  startFailed?: { detail?: string };
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
  /**
   * What the RUNNING runtime lists on disk (`/api/tags`), as last read. Absent while the
   * runtime is down or before the first read: the library then shows the state file's entries
   * as they were recorded, and offers no delete.
   */
  tags?: readonly { name: string; size: number; digest: string }[];
  /** What the model store takes on disk (`measureModelStore()`), once measured. */
  storeBytes?: number;
  /** The catalogue's label per model id, for a model the runtime lists and the state file does not know. */
  labels?: Readonly<Record<string, string>>;
  /**
   * The coding agents of the model in use (`buildHarnessRows()`), without their
   * `start-session` action: the view adds it once it knows whether a session can be started.
   * Absent while nothing is installed, and when the catalogue or the CLI registry could not be
   * read: the view then lists none.
   */
  harnesses?: readonly LocalModelHarnessRow[];
}

/** An error code with its sentence, its slots and its one next step. Pure. */
export function buildInstallError(
  code: LocalModelErrorCode,
  extra: {
    vars?: Record<string, string>;
    detail?: string;
    nextModel?: { modelId: string; modelLabel: string };
    /** The next step in the state the error is shown in, when it is not the code's default. */
    next?: LocalModelNextStep;
  } = {}
): LocalModelInstallError {
  const next = extra.next ?? LOCAL_MODEL_ERROR_NEXT[code];
  return {
    code,
    message: {
      text: LOCAL_MODEL_ERROR_LABELS[code],
      ...(extra.vars && Object.keys(extra.vars).length > 0 ? { vars: extra.vars } : {}),
    },
    next,
    ...(next === 'next-model' && extra.nextModel ? { nextModel: extra.nextModel } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
}

/**
 * What blocks a session in state `installed`, found live and never stored: another program
 * on the port, a runtime that keeps stopping, a runtime that did not start, a model that
 * changed. `undefined` when nothing does, which includes a runtime the person stopped. Pure.
 */
export function installedBlocker(
  state: LocalModelStateFile,
  live: InstallLiveFacts
): LocalModelInstallError | undefined {
  if (state.state !== 'installed') return undefined;
  if (!live.running && live.portInUse) {
    return buildInstallError('port-in-use', { vars: { port: String(state.runtime?.port ?? '') } });
  }
  if (!live.running && live.gaveUp) return buildInstallError('runtime-stopped');
  if (!live.running && live.startFailed) {
    // Start is the verb an installed model has: it tries the start again.
    return buildInstallError('runtime-start-failed', {
      next: 'start',
      ...(live.startFailed.detail ? { detail: live.startFailed.detail } : {}),
    });
  }
  if (live.digest === 'changed') return buildInstallError('model-changed');
  return undefined;
}

/**
 * The models on this Mac, for the view: the checked models of the state file joined with what
 * the running runtime lists. The model in use first, then the other checked models in the
 * order they were checked, then what the runtime lists beside them, by name. Pure.
 *
 * What a row offers:
 *  - `use`: a checked model the runtime does not contradict (`ready`), in a state whose row of
 *    `INSTALL_STATE_TABLE` lists `use`, unless it is the model of the installation (in use
 *    already) or of the stopped job (Resume goes on with that one).
 *  - `delete`: any model the running runtime lists, in a state that lists `delete-model`,
 *    unless it is the model of the installation or of the current job, and unless its name is
 *    not a plain `name:tag` (`LOCAL_MODEL_ID_PATTERN`): the delete route takes no other name.
 *    A checked model the runtime no longer lists (`missing`) can be deleted too: that drops
 *    its entry.
 */
export function buildLibraryRows(state: LocalModelStateFile, live: InstallLiveFacts): LocalModelLibraryRow[] {
  if (state.state === 'idle') return [];
  const stateActions = INSTALL_STATE_TABLE[state.state].actions;
  const tags = live.running ? live.tags : undefined;
  const jobModelId = state.model?.id;
  const canDelete = (id: string): boolean =>
    stateActions.includes('delete-model') && tags !== undefined && id !== jobModelId && LOCAL_MODEL_ID_PATTERN.test(id);
  const sized = (bytes: number | undefined): Pick<LocalModelLibraryRow, 'sizeBytes' | 'sizeGb'> =>
    bytes !== undefined && bytes > 0 ? { sizeBytes: bytes, sizeGb: formatGb(bytes) } : {};

  const rows: LocalModelLibraryRow[] = [];
  const entries = libraryOf(state);
  for (const entry of entries) {
    const tag = tags?.find((listed) => listed.name === entry.id);
    const active = state.state === 'installed' && entry.id === jobModelId;
    let status: LocalModelLibraryRow['status'] = 'ready';
    if (tags !== undefined) {
      if (!tag) status = 'missing';
      else if (compareModelDigest(entry.digest, tag.digest) === 'changed') status = 'changed';
    }
    // The model in use is compared on its own schedule too: what blocks a session says so here.
    if (active && live.digest === 'changed') status = 'changed';
    const actions: LocalModelLibraryAction[] = [];
    // The model of the installation is in use already, and the model of a stopped job is
    // what Resume goes on with: a switch is offered to every OTHER checked model.
    if (stateActions.includes('use') && status === 'ready' && entry.id !== jobModelId) actions.push('use');
    if (canDelete(entry.id)) actions.push('delete');
    rows.push({
      id: entry.id,
      label: entry.label,
      context: entry.context,
      ...sized(tag && tag.size > 0 ? tag.size : entry.bytes),
      active,
      verified: true,
      status,
      actions,
    });
  }
  rows.sort((a, b) => Number(b.active) - Number(a.active));

  const others = (tags ?? [])
    .filter((listed) => !entries.some((entry) => entry.id === listed.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const listed of others) {
    rows.push({
      id: listed.name,
      label:
        live.labels?.[listed.name] ?? (listed.name === jobModelId && state.model ? state.model.label : listed.name),
      ...sized(listed.size),
      active: false,
      verified: false,
      status: 'unverified',
      actions: canDelete(listed.name) ? ['delete'] : [],
    });
  }
  return rows;
}

/** What the service remembers of installs of a coding agent beside an installed model. In memory only. */
export interface AgentInstallMemory {
  /** The CLI id of the agent whose installer runs right now. */
  running?: string;
  /** The agents whose last install failed, by CLI id, with the end of what the installer printed. */
  failed?: Readonly<Record<string, { detail?: string }>>;
}

/**
 * The coding agents the model in use can be run with: every catalogue harness that is not
 * gated, has a fact, works at the model's context and accepts its name. The default agent
 * first, then the higher catalogue rank. The default is the agent of the installation
 * (`state.cli`) while it can be started, else the first one that can, so a client that names
 * no agent never starts one that is gone. Rows carry no `start-session` action yet: whether a
 * session can be started at all is the view's knowledge (`buildInstallView()`). Empty unless
 * the state is `installed`. Pure, and it compares no CLI id with a literal.
 */
export function buildHarnessRows(
  state: LocalModelStateFile,
  catalog: Pick<LocalModelCatalog, 'harnesses'>,
  facts: readonly HarnessFact[],
  memory: AgentInstallMemory = {}
): LocalModelHarnessRow[] {
  if (state.state !== 'installed' || !state.model) return [];
  const model = state.model;
  const ranked: Array<{ rank: number; row: LocalModelHarnessRow }> = [];
  for (const entry of catalog.harnesses) {
    if (entry.gated) continue;
    const fact = facts.find((candidate) => candidate.cli === entry.cli);
    if (!fact || model.context < entry.minContext) continue;
    let accepts = false;
    try {
      accepts = fact.acceptsModelId(model.id);
    } catch {
      accepts = false;
    }
    if (!accepts) continue;

    const installing = !fact.installed && memory.running === entry.cli;
    const status: LocalModelHarnessStatus = fact.installed
      ? 'ready'
      : installing
        ? 'installing'
        : fact.installable
          ? 'installable'
          : 'setup-needed';
    const failure = status === 'installable' ? memory.failed?.[entry.cli] : undefined;
    const readyMark = entry.readyMark ?? fact.readyMark;
    ranked.push({
      rank: entry.rank,
      row: {
        cli: entry.cli,
        cliLabel: fact.label,
        default: false,
        status,
        ...((status === 'installable' || status === 'installing') && fact.installCommand !== undefined
          ? { installCommand: fact.installCommand }
          : {}),
        ...(entry.slowFirstTurn ? { slowFirstTurn: true } : {}),
        ...(readyMark !== undefined ? { readyMark } : {}),
        ...(failure
          ? {
              error: {
                message: { text: LOCAL_MODEL_INSTALL_LABELS.errHarnessFailed, vars: { cli: fact.label } },
                ...(failure.detail ? { detail: failure.detail } : {}),
              },
            }
          : {}),
        // One installer at a time: while one runs, no other agent is offered for install.
        actions: status === 'installable' && memory.running === undefined ? ['install'] : [],
      },
    });
  }
  ranked.sort((a, b) => b.rank - a.rank);
  const rows = ranked.map((entry) => entry.row);
  const chosen = state.cli?.id;
  const fallback =
    rows.find((row) => row.cli === chosen && row.status === 'ready') ??
    rows.find((row) => row.status === 'ready') ??
    rows.find((row) => row.cli === chosen);
  if (!fallback) return rows;
  fallback.default = true;
  return [fallback, ...rows.filter((row) => row !== fallback)];
}

/**
 * The actions the server accepts right now: the state row's list narrowed by what is live.
 * `rows` is `buildLibraryRows()` of the same two arguments, for a caller that has it. Pure.
 */
export function allowedActions(
  state: LocalModelStateFile,
  live: InstallLiveFacts,
  rows: readonly LocalModelLibraryRow[] = buildLibraryRows(state, live)
): LocalModelAction[] {
  const actions = INSTALL_STATE_TABLE[state.state].actions;
  const blocked = installedBlocker(state, live) !== undefined;
  return actions.filter((action) => {
    if (action === 'use') return rows.some((row) => row.actions.includes('use'));
    if (action === 'delete-model') return rows.some((row) => row.actions.includes('delete'));
    if (action === 'install-agent') return (live.harnesses ?? []).some((row) => row.actions.includes('install'));
    // From idle a Remove only clears what an earlier one kept: offered while there is something.
    if (state.state === 'idle') return action !== 'remove' || (live.storeBytes ?? 0) > 0;
    if (state.state !== 'installed') return true;
    if (action === 'start') return !live.running;
    if (action === 'stop') return live.running;
    if (action === 'start-session') {
      // With the agents known, a session needs one that can be started. Unknown (the registry
      // could not be read) is not "none": the launch itself says what is missing then.
      const anAgent = live.harnesses === undefined || live.harnesses.some((row) => row.status === 'ready');
      return live.running && !blocked && anAgent;
    }
    return true;
  });
}

/** How far a download is, as the window prints it. Pure. */
function buildProgress(
  progress: { completedBytes: number; totalBytes: number },
  bytesPerSecond: number | undefined
): LocalModelProgress {
  const view: LocalModelProgress = {
    completedBytes: progress.completedBytes,
    totalBytes: progress.totalBytes,
    completedGb: formatGb(progress.completedBytes),
    totalGb: formatGb(progress.totalBytes),
  };
  if (bytesPerSecond !== undefined && Number.isFinite(bytesPerSecond) && bytesPerSecond >= 0) {
    view.bytesPerSecond = Math.round(bytesPerSecond);
    view.mbPerSecond = String(Math.round(bytesPerSecond / 1_000_000));
    const left = progress.totalBytes - progress.completedBytes;
    if (bytesPerSecond > 0 && left >= 0) view.secondsLeft = Math.ceil(left / bytesPerSecond);
  }
  return view;
}

/** The `install` object of the GET. Pure: every size text comes from `formatGb()`, every sentence from `LOCAL_MODEL_INSTALL_LABELS`. */
export function buildInstallView(state: LocalModelStateFile, live: InstallLiveFacts): LocalModelInstallView {
  const runtimeDownload = live.runtimeInstalled ? 0 : live.pin.bytes;
  const library = buildLibraryRows(state, live);
  const view: LocalModelInstallView = {
    state: state.state,
    running: live.running,
    developerTools: live.developerTools,
    runtime: {
      version: live.pin.version,
      installed: live.runtimeInstalled,
      downloadBytes: runtimeDownload,
      downloadGb: formatGb(runtimeDownload),
      unpackedGb: formatGb(live.pin.unpackedBytes),
    },
    folder: live.folder,
    library,
    ...(live.storeBytes !== undefined ? { store: { bytes: live.storeBytes, gb: formatGb(live.storeBytes) } } : {}),
    harnesses: [],
    actions: allowedActions(state, live, library),
  };
  if (state.state === 'idle') return view;

  if (state.model) {
    view.model = { id: state.model.id, label: state.model.label };
    view.context = state.model.context;
  }
  if (state.cli) {
    view.cli = state.cli.id;
    view.cliLabel = state.cli.label;
  }
  if (state.runtime) view.port = state.runtime.port;

  if (state.state === 'installed') {
    if (state.loaded) {
      view.loaded = {
        context: state.loaded.context,
        memoryBytes: state.loaded.sizeBytes,
        memoryGb: formatGb(state.loaded.sizeBytes),
        onGpu: state.loaded.sizeVramBytes === state.loaded.sizeBytes,
      };
    }
    if (state.connection) view.endpointId = state.connection.endpointId;
    const blocker = installedBlocker(state, live);
    if (blocker) view.error = blocker;
    // An agent that can be started offers a session exactly when the model does.
    const canStart = view.actions.includes('start-session');
    view.harnesses = (live.harnesses ?? []).map((row) =>
      row.status === 'ready' && canStart ? { ...row, actions: ['start-session', ...row.actions] } : { ...row }
    );
    // The default agent is the one a client that names none starts: never one that is gone
    // while another can be started.
    const preferred = view.harnesses.find((row) => row.default);
    if (preferred) {
      view.cli = preferred.cli;
      view.cliLabel = preferred.cliLabel;
    }
    return view;
  }

  if (state.step) view.step = state.step;
  if (state.steps) view.steps = [...state.steps];
  // A download whose total is not known yet has nothing to show.
  if (state.progress && state.progress.totalBytes > 0) {
    view.progress = buildProgress(state.progress, state.state === 'installing' ? live.bytesPerSecond : undefined);
  }
  if (state.state === 'failed' && state.error) {
    view.error = buildInstallError(state.error.code, {
      vars: state.error.vars,
      detail: state.error.detail,
      nextModel: live.nextModel,
      // A job has no Start verb: what helps there is to run the step again.
      ...(LOCAL_MODEL_ERROR_NEXT[state.error.code] === 'start' ? { next: 'retry' as const } : {}),
    });
  }
  return view;
}

/**
 * `recommendation` with every row marked that is a checked model of the library at the row's
 * context (`Candidate.library`): `active` for the model in use, `ready` for one a switch can
 * take. The chooser then says the model is on this Mac and switches without a download. A
 * recommendation with nothing to mark is handed back as it is. Pure.
 */
export function markLibraryCandidates(recommendation: Recommendation, view: LocalModelInstallView): Recommendation {
  const mark = (candidate: Candidate): Candidate => {
    const row = view.library.find(
      (entry) => entry.verified && entry.id === candidate.modelId && entry.context === candidate.context
    );
    if (!row) return candidate;
    if (row.active) return { ...candidate, library: 'active' };
    return row.actions.includes('use') ? { ...candidate, library: 'ready' } : candidate;
  };
  if (view.library.length === 0 || !recommendation.pick) return recommendation;
  const pick = mark(recommendation.pick);
  const alternatives = recommendation.alternatives.map(mark);
  const changed = pick !== recommendation.pick || alternatives.some((row, i) => row !== recommendation.alternatives[i]);
  return changed ? { ...recommendation, pick, alternatives } : recommendation;
}

/** A sentence of the install as plain English text, its slots filled. For an API error message and the log. Pure. */
export function formatInstallMessage(message: LocalModelInstallMessage): string {
  const vars = message.vars ?? {};
  return message.text.replace(/\{([a-zA-Z]+)\}/g, (slot, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : slot
  );
}

// ---------- The service ----------

/** Who asked, for the admin audit entry of the coding agent install. */
export interface LocalModelActor {
  username: string;
  ip?: string;
}

/** How a verb ended: the view after it, a refusal with its sentence, or a 409 with its conflict. */
export type LocalModelVerbResult =
  | { ok: true; view: LocalModelInstallView }
  /**
   * 400: the request is not something the server offers. 507: nothing could be started because
   * the disk is full. 500: the runtime answered a delete with an error.
   */
  | { ok: false; status: 400 | 500 | 507; message: LocalModelInstallMessage }
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
  listRunning: (target: OllamaTarget, signal?: AbortSignal) => Promise<OllamaPsModel[]>;
  getRuntimeVersion: (target: OllamaTarget, signal?: AbortSignal) => Promise<string | undefined>;
  deleteModel: (target: OllamaTarget, modelId: string, signal?: AbortSignal) => Promise<boolean>;
  /** The models the runtime has on disk, with their sizes and digests: the library's live half. */
  listTags: (target: OllamaTarget, signal?: AbortSignal) => Promise<OllamaTagModel[]>;
  /** `removePartialModelBlobs()` of src/local-model/runtime.ts: what an interrupted download left in the model store. Resolves with the bytes freed. */
  removePartialModelBlobs: (paths?: LocalModelPaths) => Promise<number>;
  /** `measureModelStore()` of src/local-model/runtime.ts: what the model store takes on disk, in bytes. */
  measureModelStore: (paths?: LocalModelPaths) => Promise<number>;
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
  /** What is saved under the reserved id and what the settings flag is, read before the connection is claimed. Writes nothing. */
  inspectLocalEndpoint: (input: LocalEndpointInput) => Promise<LocalEndpointInspection>;
  connectLocalModel: (input: ConnectLocalModelInput) => Promise<ConnectResult>;
  moveLocalEndpoint: (port: number) => Promise<void>;
  /** Puts our endpoint record back when it is gone (after a config-backup restore). True when it was added. */
  ensureLocalEndpoint: (input: LocalEndpointInput) => Promise<boolean>;
  disconnectLocalModel: (input: { flagWasEnabled: boolean }) => Promise<void>;
  /** Whether a saved endpoint already has the reserved id (asked before a first install, so the answer comes before the download). */
  isEndpointIdTaken: () => Promise<boolean>;
  // src/local-model/state-store.ts
  readState: () => Promise<LocalModelStateFile>;
  mutateState: (
    fn: (current: LocalModelStateFile) => LocalModelStateFile | undefined
  ) => Promise<{ before: LocalModelStateFile; after: LocalModelStateFile | undefined }>;
  pin: LocalModelRuntimePin;
  /** Default `localModelPaths(pin.version)`, built when it is first needed. */
  paths?: LocalModelPaths;
  /** The clock of the progress throttle and the digest re-read, in milliseconds. */
  now: () => number;
}

/** The install as the routes and the server see it. One per process. */
export interface LocalModelService {
  /**
   * The `install` object of the GET. Never throws. `harnessFacts`: the facts a caller already
   * built for the same answer (the GET builds them for the recommendation), so they are not
   * built twice; without them the service builds its own.
   */
  view(options?: { harnessFacts?: readonly HarnessFact[] }): Promise<LocalModelInstallView>;
  /**
   * Whether a session may be started on the saved endpoint `endpointId` right now. `undefined`:
   * yes, which is also the answer for every endpoint that is not this feature's. Otherwise the
   * error that refuses the launch. While a job that changes the model in use is running or
   * stopped (any state but `installed` that holds a connection of ours) it is `job-unfinished`.
   * While the runtime child Codeman started is not alive (whatever answers on the port then
   * is not ours), the reason is the one that is known: `port-in-use`, `runtime-stopped`,
   * `runtime-start-failed`, else `runtime-not-running`.
   * While it runs, the digest is read again: `model-changed` when it is not the stored one or
   * the model is gone. Every path that starts a coding agent on the managed endpoint asks
   * this first (see the file header for the list). Never throws.
   */
  launchRefusal(endpointId: string): Promise<LocalModelInstallError | undefined>;
  /**
   * `launchRefusal()` as one plain English sentence, plus the one check it does not make: on
   * the managed endpoint only the model that was installed and checked may be started, so a
   * model somebody pulled through the runtime's port is not launched. `undefined`: start it.
   * What the session launch paths call. Never throws.
   */
  launchRefusalMessage(endpointId: string, modelId: string): Promise<string | undefined>;
  /** What the GET passes to `recommend()`: the stored measured total and the runtime download that is still needed. */
  recommendOptions(): Promise<RecommendOptions>;
  /**
   * `POST /api/local-model/install`. Answers once the job is STARTED; the job runs on in the
   * server. From `installed` it adds a model: the earlier ones stay in the library, and the new
   * one becomes the model in use when the job ends. `liveSessionNames` as for `remove()`: not
   * empty answers 409 `sessions-open` while a connection of ours exists.
   */
  install(
    request: LocalModelInstallRequest,
    actor: LocalModelActor,
    liveSessionNames?: readonly string[]
  ): Promise<LocalModelVerbResult>;
  /**
   * `POST /api/local-model/use`: switch to a checked model of the library. Answers once the
   * job (`USE_JOB_STEPS`) is STARTED. Nothing is downloaded. `liveSessionNames` as for
   * `remove()`.
   */
  use(
    request: LocalModelUseRequest,
    actor: LocalModelActor,
    liveSessionNames?: readonly string[]
  ): Promise<LocalModelVerbResult>;
  /**
   * `DELETE /api/local-model/models`: delete one model from the store, through the runtime.
   * The name must be in the server's own listing (the library or the runtime's tags). Refused
   * for the model of the installation or of the current job, while a job runs and while the
   * runtime is down.
   */
  deleteLibraryModel(request: LocalModelDeleteRequest, actor?: LocalModelActor): Promise<LocalModelVerbResult>;
  /**
   * `POST /api/local-model/agent`: install one more coding agent beside an installed model.
   * Answers once the installer is STARTED; it runs on in the server, and the view's
   * `harnesses` says how it stands. Not a job: the state stays `installed` and sessions go on.
   * The agent must be a row of `harnesses` that offers `install`; one that can already be
   * started answers with the view as it is. One installer at a time (409 `job-running`).
   */
  installAgent(request: LocalModelAgentRequest, actor: LocalModelActor): Promise<LocalModelVerbResult>;
  /** `POST /api/local-model/cancel`. Answers once the step in flight was interrupted. */
  cancel(): Promise<LocalModelVerbResult>;
  /**
   * `POST /api/local-model/resume`. `liveSessionNames` as for `remove()`: with `newPort` and a
   * connection of ours, not empty answers 409 `sessions-open`.
   */
  resume(
    request: LocalModelResumeRequest,
    actor: LocalModelActor,
    liveSessionNames?: readonly string[]
  ): Promise<LocalModelVerbResult>;
  /**
   * `POST /api/local-model/runtime`. `liveSessionNames` as for `remove()`: Stop and a start on
   * another port answer 409 `sessions-open` while one of them uses the model, because their
   * coding agents keep calling the address they were started with.
   */
  runtime(request: LocalModelRuntimeRequest, liveSessionNames?: readonly string[]): Promise<LocalModelVerbResult>;
  /**
   * `DELETE /api/local-model`. `liveSessionNames` is what `sessionNamesUsingEndpoint()` found:
   * not empty answers 409 `sessions-open` while a connection of ours exists. Else: stop the
   * runtime, remove our endpoint record, restore the settings flag when this feature switched
   * it on and no other endpoint is left, delete the runtime and the private home and (when
   * asked) the models. The coding agent stays. A refused write of the endpoint store or of the
   * settings REJECTS, before any file is deleted.
   */
  remove(
    request: LocalModelRemoveRequest,
    liveSessionNames: readonly string[],
    actor?: LocalModelActor
  ): Promise<LocalModelVerbResult>;
  /**
   * Called once when the server starts. An interrupted job becomes `paused`. With a model
   * installed: the saved endpoint record is put back when it is gone, a runtime that was not
   * stopped is started (an own orphan on the port is adopted or replaced, another listener is
   * `port-in-use`) and the digest is read again. In every other case a runtime an earlier
   * server left behind is ended: nothing would use it, and it holds the model's memory.
   * Never throws, and never keeps the server from starting.
   */
  boot(): Promise<void>;
  /** Called when the server stops, beside `stopDeepSeekWeb()`: aborts a job in flight (it reads `paused` at the next boot) and stops the runtime. */
  shutdown(): Promise<void>;
  /** What the runtime supervisor reports through `onChange`: the pid of a child the moment it is spawned, a new pid after a restart, the budget line. Stored, never thrown. */
  onRuntimeChange(status: RuntimeStatus): void;
  /** Resolves once no job is in flight and no coding agent is being installed. For `shutdown()` and for tests. */
  idle(): Promise<void>;
}

/** How often a download's progress is written to the state file. The window reads the live figure, not the file. */
const PROGRESS_FLUSH_MS = 5_000;
/** How long a digest read stays good for the view. A session launch always reads it again. */
const DIGEST_RECHECK_MS = 30_000;
/** How long a read of the runtime's listings may take. */
const RUNTIME_READ_TIMEOUT_MS = 5_000;
/** How long the runtime's list of models stays good for the view. Every verb and step that changes the store throws it away. */
const TAGS_RECHECK_MS = 5_000;
/** How long a measurement of the model store stays good for the view. */
const STORE_RECHECK_MS = 30_000;
/** How long the view waits for the FIRST listing and measurement. Later ones are read in the background. */
const FIRST_LISTING_WAIT_MS = 300;
/** The window a download speed is measured over when the source reports none. */
const SPEED_WINDOW_MS = 5_000;
/** How much of an installer's output is kept as the error detail. */
const INSTALLER_DETAIL_CHARS = 1_000;

/** How a step ended. */
type StepOutcome =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'fail'; code: LocalModelErrorCode; vars?: Record<string, string>; detail?: string; nextModelId?: string };

const DONE: StepOutcome = { kind: 'done' };
const CANCELLED: StepOutcome = { kind: 'cancelled' };

const baseUrlOf = (port: number): OllamaTarget => ({ baseUrl: `http://127.0.0.1:${port}` });

function conflict(
  reason: LocalModelConflict['reason'],
  extra: Partial<LocalModelConflict> = {},
  vars?: Record<string, string>
): LocalModelVerbResult {
  const text = {
    'job-running': LOCAL_MODEL_INSTALL_LABELS.conflictJobRunning,
    'already-installed': LOCAL_MODEL_INSTALL_LABELS.conflictAlreadyInstalled,
    'size-changed': LOCAL_MODEL_INSTALL_LABELS.conflictSizeChanged,
    'sessions-open': LOCAL_MODEL_INSTALL_LABELS.conflictSessionsOpen,
    'wrong-state': LOCAL_MODEL_INSTALL_LABELS.conflictWrongState,
    'model-active': LOCAL_MODEL_INSTALL_LABELS.conflictModelActive,
    'runtime-not-running': LOCAL_MODEL_INSTALL_LABELS.errRuntimeNotRunning,
  }[reason];
  return { ok: false, status: 409, conflict: { reason, message: { text, ...(vars ? { vars } : {}) }, ...extra } };
}

/** A supervisor that is built when it is first started, so a server that never installs a model builds none. */
function lazySupervisor(build: () => RuntimeSupervisor): RuntimeSupervisor {
  let instance: RuntimeSupervisor | undefined;
  return {
    start: (options) => (instance ??= build()).start(options),
    stop: async (options) => {
      // Built for a stored pid too: a runtime an earlier server left behind has no instance here.
      if (instance || options?.previousPid !== undefined) await (instance ??= build()).stop(options);
    },
    status: () => (instance ? instance.status() : { running: false, restarts: 0, gaveUp: false }),
  };
}

/** Whether a write failed for lack of space. */
function isDiskFullError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;
  return code === 'ENOSPC' || code === 'EDQUOT' || /no space left on device/i.test(getErrorMessage(err));
}

/** How a job ended, as the `fail` event carries it. */
type JobFailure = Omit<Extract<InstallJobEvent, { type: 'fail' }>, 'type'>;

/** Forgets the cached lookups of a CLI's binaries the way the CLI registry routes do, then probes it again. */
async function recheckCliInstalledNow(cli: string): Promise<boolean> {
  const entry = getCli(cli);
  if (!entry) return false;
  forgetResolvedCli(cli, entry.discovery.binaries);
  const stockAvailability = await probeStockCliAvailability();
  return isCliEntryInstalled(entry, stockAvailability);
}

class LocalModelServiceImpl implements LocalModelService {
  private readonly deps: LocalModelServiceDeps;
  /** The one job of this process, while it runs. */
  private job: { controller: AbortController; promise: Promise<void> } | undefined;
  /** Verbs run one at a time, so two installs cannot both find the state free. */
  private verbChain: Promise<unknown> = Promise.resolve();
  private recovery: Promise<void> | undefined;
  private stopping = false;
  /** A verb wrote `installing` and is about to start the job: the view must not take that for a job that is gone. */
  private jobStarting = false;
  /**
   * How the last job ended when the state file could not be told (a full disk): the failure,
   * or nothing for a pause, and the download as it stood. Shown from memory and written by
   * the next verb.
   */
  private unrecorded: { failure?: JobFailure; progress?: { completedBytes: number; totalBytes: number } } | undefined;
  /** The download in flight, as last reported. The state file gets it every few seconds. */
  private liveProgress: { completedBytes: number; totalBytes: number; bytesPerSecond?: number } | undefined;
  private lastProgressFlush = 0;
  private speedSamples: Array<{ at: number; bytes: number }> = [];
  /** The last start found another program on the stored port. */
  private portInUse = false;
  /** The last start failed for another reason, with what the runtime said. Cleared by a start that works and by Stop. */
  private startFailed: { detail?: string } | undefined;
  private digestStatus: 'same' | 'changed' | 'unknown' | undefined;
  private digestCheckedAt = 0;
  /** What the runtime on `port` last listed on disk, and when. Thrown away whenever the store may have changed. */
  private tagsCache: { at: number; port: number; tags: OllamaTagModel[] } | undefined;
  private tagsRefresh: Promise<void> | undefined;
  /** What the model store last took on disk, and when. */
  private storeCache: { at: number; bytes: number } | undefined;
  private storeRefresh: Promise<void> | undefined;
  /**
   * The install of one more coding agent beside an installed model, while its installer runs.
   * Not a job: the state file never hears of it, and the state stays `installed`.
   */
  private agentInstall: { cli: string; controller: AbortController; promise: Promise<void> } | undefined;
  /** The agents whose last such install failed, with the end of what the installer printed. Forgotten at a restart. */
  private readonly agentFailures = new Map<string, { detail?: string }>();

  constructor(deps: Partial<LocalModelServiceDeps>) {
    const pin = deps.pin ?? OLLAMA_RUNTIME_PIN;
    this.deps = {
      readHardware: () => readHardware(),
      getCatalog: getLocalModelCatalog,
      buildHarnessFacts: (catalog) => buildHarnessFacts(catalog),
      recommend,
      modelFitsBudget,
      isRuntimeInstalled,
      ensureRuntimeInstalled,
      chooseRuntimePort,
      removeLocalModelFiles,
      supervisor: lazySupervisor(() =>
        createRuntimeSupervisor({ pin, paths: this.paths(), onChange: (status) => this.onRuntimeChange(status) })
      ),
      pullModel,
      verifyModel,
      readModelDigest,
      listOpenAiModels,
      listRunning,
      getRuntimeVersion,
      deleteModel,
      listTags,
      removePartialModelBlobs,
      measureModelStore,
      checkDeveloperTools: () => checkDeveloperTools(),
      stockInstallCommand,
      tryBeginCliInstall,
      runInstallCommand,
      recheckCliInstalled: recheckCliInstalledNow,
      audit: (entry) => appendAdminAudit({ ...entry, detail: entry.detail as Record<string, unknown> | undefined }),
      inspectLocalEndpoint,
      connectLocalModel,
      moveLocalEndpoint,
      ensureLocalEndpoint,
      disconnectLocalModel,
      isEndpointIdTaken: async () =>
        (await readCustomModelHosts(getDataDir())).some((host) => host.id === LOCAL_MODEL_ENDPOINT_ID),
      readState: readLocalModelState,
      mutateState: mutateLocalModelState,
      now: () => Date.now(),
      ...deps,
      pin,
    };
  }

  // ---------- Small helpers ----------

  private paths(): LocalModelPaths {
    return this.deps.paths ?? localModelPaths(this.deps.pin.version);
  }

  /** Runs `fn` after every verb that was asked before it. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.verbChain.then(fn);
    this.verbChain = run.catch(() => {});
    return run;
  }

  /** Applies one event of the running job to the stored state. False when the reducer refused it. */
  private async dispatch(event: InstallJobEvent): Promise<boolean> {
    const { after } = await this.deps.mutateState((current) => {
      const next = reduceInstallJob(current, event);
      return next === current ? undefined : next;
    });
    return after !== undefined;
  }

  /**
   * `state` as it stands once a job that is over is counted as over: `installing` in the file
   * while this process runs no job is a job that ended without the file knowing. It is
   * `failed` with the outcome kept in memory, or `paused` when there is none (a restart, a
   * Cancel whose write was refused). A paused or failed job with an outcome in memory is a
   * Resume that could not be written. Pure apart from reading `this.job` and `this.unrecorded`.
   */
  private settled(state: LocalModelStateFile): LocalModelStateFile {
    if (this.job) return state;
    const failure = this.unrecorded?.failure;
    let next: LocalModelStateFile;
    if (state.state === 'installing') {
      next = failure
        ? reduceInstallJob(state, { type: 'fail', ...failure })
        : reduceInstallJob(state, { type: 'restart' });
    } else if (failure && (state.state === 'paused' || state.state === 'failed')) {
      // A Resume that could not even be written (the disk is full): the job did not start,
      // and it says why instead of looking as if the click did nothing.
      next = reduceInstallJob({ ...state, state: 'installing' }, { type: 'fail', ...failure });
    } else {
      return state;
    }
    const progress = this.unrecorded?.progress;
    return progress ? { ...next, progress } : next;
  }

  /**
   * The stored state as a view or a verb must see it: settled, unless a verb is just starting a
   * job. A job writes its last state BEFORE it lets go of `this.job`, so when the job ended while
   * this read was out, the read may hold the `installing` from before that write; it is read
   * again rather than settled, or it would show as an interrupted (`paused`) job for a tick.
   */
  private async currentState(): Promise<LocalModelStateFile> {
    const jobAtRead = this.job;
    let state = await this.deps.readState();
    if (jobAtRead && !this.job) state = await this.deps.readState();
    return this.jobStarting ? state : this.settled(state);
  }

  /**
   * Applies one event of a VERB to the stored state, after settling it (`settled()`), in one
   * write. False when the reducer refused the event; the settlement is written all the same.
   */
  private async verbDispatch(event: InstallJobEvent): Promise<boolean> {
    let applied = false;
    let settledNow = false;
    await this.deps.mutateState((current) => {
      const base = this.settled(current);
      settledNow = base !== current;
      const next = reduceInstallJob(base, event);
      applied = next !== base;
      if (applied) return next;
      return settledNow ? base : undefined;
    });
    if (settledNow || applied) this.unrecorded = undefined;
    return applied;
  }

  /**
   * Writes the settlement alone, so the file says what the view already shows. Best effort: a
   * write that is refused (the disk is still full) changes nothing, the outcome stays in
   * memory and the next verb tries again.
   */
  private async settle(): Promise<void> {
    try {
      let settledNow = false;
      await this.deps.mutateState((current) => {
        const base = this.settled(current);
        settledNow = base !== current;
        return settledNow ? base : undefined;
      });
      if (settledNow) this.unrecorded = undefined;
    } catch (err) {
      console.warn(`[local-model] Could not write the state of the install: ${getErrorMessage(err)}`);
    }
  }

  /** Writes facts a step learned. Never moves the state, and writes nothing once the job's state is gone. */
  private async record(change: (current: LocalModelStateFile) => LocalModelStateFile | undefined): Promise<void> {
    await this.deps.mutateState((current) => (current.state === 'idle' ? undefined : change(current)));
  }

  /**
   * A job the state file still calls `installing` when this process has none is one a restart
   * interrupted: it becomes `paused`. Written once per process, before the first view or verb,
   * whether or not `boot()` ran yet. This is the one write a GET makes; a job that ends later
   * without the file knowing is shown from memory (`settled()`) and written by the next verb.
   */
  private recovered(): Promise<void> {
    this.recovery ??= this.settle();
    return this.recovery;
  }

  private async isRuntimeOnDisk(): Promise<boolean> {
    try {
      return await this.deps.isRuntimeInstalled(this.deps.pin, this.paths());
    } catch {
      return false;
    }
  }

  /**
   * The runtime version to start: the pinned one when it is unpacked, else the version the
   * state file records when THAT is still unpacked (a model installed by an earlier build
   * with another pin keeps running), else the pinned one, whose start then says what is
   * missing.
   */
  private async runtimeVersionToRun(state: LocalModelStateFile): Promise<string> {
    const pinned = this.deps.pin.version;
    const stored = state.runtime?.version;
    if (!stored || stored === pinned || (await this.isRuntimeOnDisk())) return pinned;
    try {
      const paths = this.paths();
      const binary = runtimeBinaryForVersion(paths, stored);
      if (await this.deps.isRuntimeInstalled({ ...this.deps.pin, version: stored }, { ...paths, binary })) {
        return stored;
      }
    } catch {
      /* not a version this build can name: the pinned one is tried */
    }
    return pinned;
  }

  private errorVars(code: LocalModelErrorCode, state: LocalModelStateFile): Record<string, string> | undefined {
    const model = state.model?.label ?? '';
    switch (code) {
      case 'port-in-use':
        return { port: String(state.runtime?.port ?? RUNTIME_PORT_FIRST) };
      case 'model-not-found':
      case 'does-not-fit':
      case 'load-failed':
      case 'no-tool-call':
      case 'probe-unfinished':
        return { model };
      case 'harness-failed':
        return { cli: state.cli?.label ?? '' };
      case 'endpoint-id-taken':
        return { id: LOCAL_MODEL_ENDPOINT_ID };
      default:
        return undefined;
    }
  }

  /**
   * The model to offer after `failed` did not work: the best one the current recommendation
   * offers that is another model. With `smallerThan` (the memory the failed model needs, for
   * `does-not-fit`) only a model that needs LESS is offered: one that needs more would fail
   * the same way. `undefined` when there is none.
   */
  private async nextModelId(
    failed: { id: string; context: number },
    options?: RecommendOptions,
    rule: { needsLessMemory?: boolean } = {}
  ): Promise<string | undefined> {
    try {
      const hw = await this.deps.readHardware();
      const catalog = this.deps.getCatalog();
      const facts = await this.deps.buildHarnessFacts(catalog);
      const rec = this.deps.recommend(hw, catalog, facts, options ?? (await this.recommendOptions()));
      const rows = [rec.pick, ...rec.alternatives].filter(
        (row): row is Candidate => row !== undefined && row.modelId !== failed.id
      );
      if (!rule.needsLessMemory) return rows[0]?.modelId;
      // What the failed model needs: its row when the recommendation still has it, else the
      // catalogue's figures for it at the context that was chosen.
      const failedRow = [rec.pick, ...rec.alternatives].find((row) => row?.modelId === failed.id);
      const entry = catalog.models.find((model) => model.id === failed.id);
      const limit =
        failedRow && failedRow.context === failed.context
          ? failedRow.needBytes
          : entry
            ? needBytes(entry, failed.context)
            : undefined;
      if (limit === undefined || !Number.isFinite(limit)) return undefined;
      return rows.find((row) => row.needBytes < limit)?.modelId;
    } catch {
      return undefined;
    }
  }

  // ---------- Progress ----------

  private onProgress(progress: { completedBytes: number; totalBytes: number; bytesPerSecond?: number }): void {
    const now = this.deps.now();
    let bytesPerSecond = progress.bytesPerSecond;
    if (bytesPerSecond === undefined) {
      // The archive download reports bytes only: the speed is what arrived over the last seconds.
      this.speedSamples.push({ at: now, bytes: progress.completedBytes });
      while (this.speedSamples.length > 2 && now - this.speedSamples[1].at >= SPEED_WINDOW_MS)
        this.speedSamples.shift();
      const first = this.speedSamples[0];
      const elapsed = now - first.at;
      if (elapsed >= 1_000 && progress.completedBytes >= first.bytes) {
        bytesPerSecond = ((progress.completedBytes - first.bytes) * 1_000) / elapsed;
      }
    }
    this.liveProgress = {
      completedBytes: progress.completedBytes,
      totalBytes: progress.totalBytes,
      ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
    };
    if (now - this.lastProgressFlush >= PROGRESS_FLUSH_MS) {
      this.lastProgressFlush = now;
      void this.flushProgress().catch(() => {});
    }
  }

  private async flushProgress(): Promise<void> {
    const progress = this.liveProgress;
    if (!progress) return;
    await this.dispatch({
      type: 'progress',
      completedBytes: progress.completedBytes,
      totalBytes: progress.totalBytes,
    });
  }

  /** The download as it stands, for a job that ends: what a paused or failed job keeps. */
  private progressNow(): { completedBytes: number; totalBytes: number } | undefined {
    const progress = this.liveProgress;
    return progress ? { completedBytes: progress.completedBytes, totalBytes: progress.totalBytes } : undefined;
  }

  private clearProgress(): void {
    this.liveProgress = undefined;
    this.speedSamples = [];
    this.lastProgressFlush = 0;
  }

  // ---------- The runtime ----------

  /** Starts the runtime on the stored port (a no-op when it runs with this context) and stores what the start learned. */
  private async startRuntime(state: LocalModelStateFile): Promise<RuntimeStartResult> {
    if (!state.runtime || !state.model) {
      return { ok: false, code: 'runtime-start-failed', detail: 'No port was chosen for the runtime yet.' };
    }
    const { port } = state.runtime;
    const version = await this.runtimeVersionToRun(state);
    let result: RuntimeStartResult;
    try {
      result = await this.deps.supervisor.start({
        port,
        contextLength: state.model.context,
        ...(state.runtime.pid !== undefined ? { previousPid: state.runtime.pid } : {}),
        ...(version !== this.deps.pin.version ? { version } : {}),
      });
    } catch (err) {
      result = { ok: false, code: 'runtime-start-failed', detail: getErrorMessage(err) };
    }
    this.portInUse = !result.ok && result.code === 'port-in-use';
    // Kept, so an installed model whose runtime does not start says so instead of only "stopped".
    this.startFailed =
      !result.ok && result.code === 'runtime-start-failed'
        ? { ...(result.detail ? { detail: result.detail } : {}) }
        : undefined;
    if (result.ok) {
      const { pid, measuredTotalBytes } = result;
      await this.record((current) =>
        current.runtime
          ? {
              ...current,
              runtime: {
                ...current.runtime,
                version,
                pid,
                ...(measuredTotalBytes !== undefined ? { measuredTotalBytes } : {}),
              },
            }
          : undefined
      );
    }
    return result;
  }

  private startFailure(result: Extract<RuntimeStartResult, { ok: false }>, state: LocalModelStateFile): StepOutcome {
    return {
      kind: 'fail',
      code: result.code,
      vars: this.errorVars(result.code, state),
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }

  /** Reads the model's digest from the running runtime and compares it with the stored one. */
  private async refreshDigest(state: LocalModelStateFile): Promise<'same' | 'changed' | 'unknown'> {
    let current: string | undefined;
    if (state.runtime && state.model && this.deps.supervisor.status().running) {
      try {
        current = await this.deps.readModelDigest(
          baseUrlOf(state.runtime.port),
          state.model.id,
          AbortSignal.timeout(RUNTIME_READ_TIMEOUT_MS)
        );
      } catch {
        current = undefined;
      }
    }
    this.digestStatus = compareModelDigest(state.model?.digest, current);
    this.digestCheckedAt = this.deps.now();
    return this.digestStatus;
  }

  onRuntimeChange(status: RuntimeStatus): void {
    // The pid is stored from the moment the child is spawned, not only once it answers: a
    // server that is killed in between must still find its own runtime at the next start.
    if (status.pid === undefined) return;
    const { pid, measuredTotalBytes } = status;
    void this.record((current) => {
      if (!current.runtime) return undefined;
      const samePid = current.runtime.pid === pid;
      const sameTotal = measuredTotalBytes === undefined || current.runtime.measuredTotalBytes === measuredTotalBytes;
      if (samePid && sameTotal) return undefined;
      return {
        ...current,
        runtime: { ...current.runtime, pid, ...(measuredTotalBytes !== undefined ? { measuredTotalBytes } : {}) },
      };
    }).catch(() => {});
  }

  // ---------- The library's live half ----------

  /** The store changed, or may have: the next view reads the runtime's list and the disk again. */
  private forgetStore(): void {
    this.tagsCache = undefined;
    this.storeCache = undefined;
  }

  /**
   * Reads what the running runtime lists on disk. A runtime that does not answer leaves the
   * last list in place: "it has no models" and "it said nothing" must not look alike, or every
   * checked model would read as missing for a moment. Never throws.
   */
  private refreshTags(state: LocalModelStateFile): Promise<void> {
    const port = state.runtime?.port;
    if (port === undefined || !this.deps.supervisor.status().running) {
      this.tagsCache = undefined;
      return Promise.resolve();
    }
    this.tagsRefresh ??= (async () => {
      try {
        const target = baseUrlOf(port);
        const version = await this.deps.getRuntimeVersion(target, AbortSignal.timeout(RUNTIME_READ_TIMEOUT_MS));
        if (version === undefined) return;
        const tags = await this.deps.listTags(target, AbortSignal.timeout(RUNTIME_READ_TIMEOUT_MS));
        this.tagsCache = { at: this.deps.now(), port, tags };
      } catch {
        /* the last list stays */
      } finally {
        this.tagsRefresh = undefined;
      }
    })();
    return this.tagsRefresh;
  }

  /** Measures the model store on disk. Never throws. */
  private refreshStore(): Promise<void> {
    this.storeRefresh ??= (async () => {
      try {
        const bytes = await this.deps.measureModelStore(this.paths());
        this.storeCache = { at: this.deps.now(), bytes };
      } catch {
        /* the last figure stays */
      } finally {
        this.storeRefresh = undefined;
      }
    })();
    return this.storeRefresh;
  }

  /**
   * Keeps the two caches of the view current WITHOUT making the one-second poll wait for the
   * runtime or the disk: a stale figure is refreshed in the background, and only a figure that
   * was never read is waited for, briefly.
   */
  private async freshenListings(state: LocalModelStateFile): Promise<void> {
    const now = this.deps.now();
    const first: Promise<void>[] = [];
    if (!this.storeCache || now - this.storeCache.at >= STORE_RECHECK_MS) {
      const run = this.refreshStore();
      if (!this.storeCache) first.push(run);
    }
    const port = state.runtime?.port;
    if (port === undefined || !this.deps.supervisor.status().running) {
      this.tagsCache = undefined;
    } else if (!this.tagsCache || this.tagsCache.port !== port || now - this.tagsCache.at >= TAGS_RECHECK_MS) {
      const known = this.tagsCache?.port === port;
      const run = this.refreshTags(state);
      if (!known) first.push(run);
    }
    if (first.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FIRST_LISTING_WAIT_MS);
      timer.unref();
    });
    await Promise.race([Promise.all(first), waited]);
    clearTimeout(timer);
  }

  // ---------- The view ----------

  /** What `buildHarnessRows()` is told about agent installs: the one that runs, and the ones that failed. */
  private agentMemory(): AgentInstallMemory {
    return {
      ...(this.agentInstall ? { running: this.agentInstall.cli } : {}),
      ...(this.agentFailures.size > 0 ? { failed: Object.fromEntries(this.agentFailures) } : {}),
    };
  }

  private async liveFacts(
    state: LocalModelStateFile,
    harnessFacts?: readonly HarnessFact[]
  ): Promise<InstallLiveFacts> {
    const status = this.deps.supervisor.status();
    let harnesses: LocalModelHarnessRow[] | undefined;
    if (state.state === 'installed') {
      try {
        const catalog = this.deps.getCatalog();
        const facts = harnessFacts ?? (await this.deps.buildHarnessFacts(catalog));
        harnesses = buildHarnessRows(state, catalog, facts, this.agentMemory());
      } catch (err) {
        // Unknown, not "none": the view then lists no agent and still offers a session.
        console.warn(`[local-model] The coding agents could not be listed: ${getErrorMessage(err)}`);
      }
    }
    let developerTools: LocalModelDeveloperTools = 'unknown';
    try {
      developerTools = await this.deps.checkDeveloperTools();
    } catch {
      /* said as unknown: the sentence is not shown */
    }
    let nextModel: InstallLiveFacts['nextModel'];
    const nextModelId = state.error?.nextModelId;
    let labels: Record<string, string> | undefined;
    try {
      const models = this.deps.getCatalog().models;
      const entry = nextModelId ? models.find((model) => model.id === nextModelId) : undefined;
      if (entry) nextModel = { modelId: entry.id, modelLabel: entry.label };
      labels = Object.fromEntries(models.map((model) => [model.id, model.label]));
    } catch {
      /* no model is offered then, and a model the state file does not know keeps its name */
    }
    const port = state.runtime?.port;
    const tags =
      status.running && port !== undefined && this.tagsCache?.port === port ? this.tagsCache.tags : undefined;
    return {
      running: status.running,
      gaveUp: status.gaveUp,
      portInUse: this.portInUse,
      ...(this.startFailed ? { startFailed: this.startFailed } : {}),
      ...(state.state === 'installed' && this.digestStatus ? { digest: this.digestStatus } : {}),
      developerTools,
      runtimeInstalled: await this.isRuntimeOnDisk(),
      ...(this.liveProgress?.bytesPerSecond !== undefined ? { bytesPerSecond: this.liveProgress.bytesPerSecond } : {}),
      ...(nextModel ? { nextModel } : {}),
      pin: this.deps.pin,
      folder: this.paths().root,
      ...(tags ? { tags } : {}),
      ...(this.storeCache ? { storeBytes: this.storeCache.bytes } : {}),
      ...(labels ? { labels } : {}),
      ...(harnesses ? { harnesses } : {}),
    };
  }

  async view(options: { harnessFacts?: readonly HarnessFact[] } = {}): Promise<LocalModelInstallView> {
    try {
      await this.recovered();
      let state = await this.currentState();
      if (state.state === 'installing' && this.liveProgress) {
        state = {
          ...state,
          progress: {
            completedBytes: this.liveProgress.completedBytes,
            totalBytes: this.liveProgress.totalBytes,
          },
        };
      }
      if (
        state.state === 'installed' &&
        this.deps.supervisor.status().running &&
        this.deps.now() - this.digestCheckedAt >= DIGEST_RECHECK_MS
      ) {
        // In the background: the window polls every second and must not wait for the runtime.
        this.digestCheckedAt = this.deps.now();
        void this.refreshDigest(state).catch(() => {});
      }
      await this.freshenListings(state);
      return buildInstallView(state, await this.liveFacts(state, options.harnessFacts));
    } catch (err) {
      console.warn(`[local-model] Could not build the install view: ${getErrorMessage(err)}`);
      return buildInstallView(IDLE_LOCAL_MODEL_STATE, {
        running: false,
        gaveUp: false,
        portInUse: false,
        developerTools: 'unknown',
        runtimeInstalled: false,
        pin: this.deps.pin,
        folder: '',
      });
    }
  }

  async recommendOptions(): Promise<RecommendOptions> {
    let measuredTotalBytes: number | undefined;
    try {
      await this.recovered();
      measuredTotalBytes = (await this.deps.readState()).runtime?.measuredTotalBytes;
    } catch {
      measuredTotalBytes = undefined;
    }
    return {
      ...(measuredTotalBytes !== undefined ? { measuredTotalBytes } : {}),
      runtimeDownloadBytes: (await this.isRuntimeOnDisk()) ? 0 : this.deps.pin.bytes,
    };
  }

  async launchRefusal(endpointId: string): Promise<LocalModelInstallError | undefined> {
    if (!isLocalModelEndpointId(endpointId)) return undefined;
    try {
      await this.recovered();
      const state = await this.currentState();
      // A record with the reserved id that this feature did not write is not ours to judge.
      if (state.connection?.endpointId !== endpointId) return undefined;
      const status = this.deps.supervisor.status();
      // A job that changes the model in use runs or stopped: the record may still name the
      // earlier model, and nothing is started on it until a job ended `installed` again.
      if (state.state !== 'installed') return buildInstallError('job-unfinished');
      if (!state.runtime || !state.model || !status.running) {
        if (this.portInUse) return buildInstallError('port-in-use', { vars: this.errorVars('port-in-use', state) });
        if (status.gaveUp) return buildInstallError('runtime-stopped');
        if (this.startFailed) return buildInstallError('runtime-start-failed', { next: 'start' });
        return buildInstallError('runtime-not-running');
      }
      const digest = await this.refreshDigest(state);
      if (digest === 'same') return undefined;
      if (digest === 'unknown') {
        // No digest to compare: either the runtime stopped answering, or the model is gone.
        let version: string | undefined;
        try {
          version = await this.deps.getRuntimeVersion(
            baseUrlOf(state.runtime.port),
            AbortSignal.timeout(RUNTIME_READ_TIMEOUT_MS)
          );
        } catch {
          version = undefined;
        }
        if (version === undefined) return buildInstallError('runtime-not-running');
        this.digestStatus = 'changed';
      }
      return buildInstallError('model-changed');
    } catch (err) {
      console.warn(`[local-model] The launch check failed: ${getErrorMessage(err)}`);
      return buildInstallError('runtime-not-running');
    }
  }

  async launchRefusalMessage(endpointId: string, modelId: string): Promise<string | undefined> {
    const refusal = await this.launchRefusal(endpointId);
    if (refusal) return formatInstallMessage(refusal.message);
    if (!isLocalModelEndpointId(endpointId)) return undefined;
    try {
      const state = await this.deps.readState();
      if (state.connection?.endpointId === endpointId && state.model && state.model.id !== modelId) {
        return formatInstallMessage({
          text: LOCAL_MODEL_INSTALL_LABELS.refusedOtherModel,
          vars: { model: state.model.label },
        });
      }
    } catch {
      /* an unreadable state is "nothing of ours": nothing to refuse */
    }
    return undefined;
  }

  // ---------- Verbs ----------

  private async answer(): Promise<LocalModelVerbResult> {
    return { ok: true, view: await this.view() };
  }

  install(
    request: LocalModelInstallRequest,
    actor: LocalModelActor,
    liveSessionNames: readonly string[] = []
  ): Promise<LocalModelVerbResult> {
    return this.exclusive(async () => {
      await this.settle();
      const state = await this.currentState();
      if (state.state === 'installing') return conflict('job-running');
      // The model in use at the context it runs with: there is nothing to install.
      if (
        state.state === 'installed' &&
        state.model?.id === request.modelId &&
        state.model.context === request.context
      ) {
        return conflict('already-installed');
      }
      // Another model takes the runtime (it holds one) and often restarts it for its context.
      const open = this.sessionsOpen(state, liveSessionNames);
      if (open) return open;

      // Everything below is checked against what the server itself offers right now, before
      // anything is downloaded.
      const hw = await this.deps.readHardware();
      const catalog = this.deps.getCatalog();
      const facts = await this.deps.buildHarnessFacts(catalog);
      const options = await this.recommendOptions();
      const rec = this.deps.recommend(hw, catalog, facts, options);
      const rows = [rec.pick, ...rec.alternatives].filter((row): row is Candidate => row !== undefined);
      const candidate = rows.find((row) => row.modelId === request.modelId);
      if (!candidate || candidate.context !== request.context) {
        return { ok: false, status: 400, message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedModelNotOffered } };
      }
      // A row without the list (an older shape) still names its one coding agent in the flat fields.
      const harnesses: CandidateHarness[] = candidate.harnesses ?? [
        { cli: candidate.cli, cliLabel: candidate.cliLabel, installed: candidate.cliInstalled },
      ];
      const harness = harnesses.find((row) => row.cli === request.cli);
      if (!harness || !catalog.harnesses.some((row) => row.cli === request.cli)) {
        return { ok: false, status: 400, message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentNotOffered } };
      }
      if (!harness.installed && !this.deps.stockInstallCommand(harness.cli)) {
        return {
          ok: false,
          status: 400,
          message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentNotInstallable, vars: { cli: harness.cliLabel } },
        };
      }
      const expectedBytes = candidate.installBytes ?? candidate.downloadBytes + (options.runtimeDownloadBytes ?? 0);
      if (request.acknowledgedBytes !== expectedBytes) {
        const expectedGb = formatGb(expectedBytes);
        return conflict('size-changed', { expectedBytes, expectedGb }, { size: expectedGb });
      }
      // Said now, not after the download: a saved endpoint that already has our id and is not ours.
      if (!state.connection && (await this.deps.isEndpointIdTaken())) {
        return {
          ok: false,
          status: 400,
          message: buildInstallError('endpoint-id-taken', { vars: { id: LOCAL_MODEL_ENDPOINT_ID } }).message,
        };
      }

      const refused = await this.beginJob(actor, {
        type: 'install',
        model: { id: candidate.modelId, label: candidate.modelLabel, context: candidate.context },
        cli: { id: harness.cli, label: harness.cliLabel },
        steps: jobSteps({ agentInstalled: harness.installed }),
      });
      if (refused) return refused;
      await this.undoStop();
      this.forgetStore();
      void this.deps
        .audit({
          admin: actor.username,
          action: 'local_model_install',
          target: candidate.modelId,
          ...(actor.ip ? { ip: actor.ip } : {}),
          detail: { cli: harness.cli, context: candidate.context, bytes: expectedBytes },
        })
        .catch(() => {});
      return this.answer();
    });
  }

  use(
    request: LocalModelUseRequest,
    actor: LocalModelActor,
    liveSessionNames: readonly string[] = []
  ): Promise<LocalModelVerbResult> {
    return this.exclusive(async () => {
      await this.settle();
      const state = await this.currentState();
      if (state.state === 'installing') return conflict('job-running');
      if (INSTALL_TRANSITIONS[state.state].use === undefined) return conflict('wrong-state');
      const entry = libraryOf(state).find((candidate) => candidate.id === request.modelId);
      if (!entry) {
        return { ok: false, status: 400, message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedNotInLibrary } };
      }
      if (state.state === 'installed' && state.model?.id === entry.id) return conflict('already-installed');
      const open = this.sessionsOpen(state, liveSessionNames);
      if (open) return open;

      // The coding agent of the switch, which becomes the default one: the one this model was
      // checked with, else the one of the state, whichever is on this Mac now. A job that
      // stopped while it installed another agent leaves the state naming one that may not be
      // there. With neither, any agent the model can be run with that is on this Mac: the
      // agent is chosen per session, so a switch is not refused for one that was uninstalled.
      const agents = [entry.cli, state.cli].filter(
        (cli, index, all): cli is { id: string; label: string } =>
          cli !== undefined && all.findIndex((other) => other?.id === cli.id) === index
      );
      let cli: { id: string; label: string } | undefined;
      for (const agent of agents) {
        if (await this.deps.recheckCliInstalled(agent.id).catch(() => false)) {
          cli = agent;
          break;
        }
      }
      if (!cli) {
        try {
          const catalog = this.deps.getCatalog();
          const afterSwitch: LocalModelStateFile = {
            schema: 1,
            state: 'installed',
            model: { id: entry.id, label: entry.label, context: entry.context },
          };
          const ready = buildHarnessRows(afterSwitch, catalog, await this.deps.buildHarnessFacts(catalog)).find(
            (row) => row.status === 'ready'
          );
          if (ready) cli = { id: ready.cli, label: ready.cliLabel };
        } catch {
          /* no other agent is known then, and the switch is refused below */
        }
      }
      if (!cli) {
        return {
          ok: false,
          status: 400,
          message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentMissing, vars: { cli: agents[0]?.label ?? '' } },
        };
      }

      const refused = await this.beginJob(actor, {
        type: 'use',
        model: { id: entry.id, label: entry.label, context: entry.context, digest: entry.digest },
        cli,
      });
      if (refused) return refused;
      await this.undoStop();
      this.forgetStore();
      void this.deps
        .audit({
          admin: actor.username,
          action: 'local_model_use',
          target: entry.id,
          ...(actor.ip ? { ip: actor.ip } : {}),
          detail: { cli: cli.id, context: entry.context },
        })
        .catch(() => {});
      return this.answer();
    });
  }

  installAgent(request: LocalModelAgentRequest, actor: LocalModelActor): Promise<LocalModelVerbResult> {
    return this.exclusive(async () => {
      await this.settle();
      const state = await this.currentState();
      if (state.state === 'installing') return conflict('job-running');
      if (!INSTALL_STATE_TABLE[state.state].actions.includes('install-agent')) return conflict('wrong-state');
      // One installer at a time, whichever agent it is for.
      if (this.agentInstall) return conflict('job-running');

      // Checked against what the server itself lists right now, before anything runs.
      const catalog = this.deps.getCatalog();
      const facts = await this.deps.buildHarnessFacts(catalog);
      const row = buildHarnessRows(state, catalog, facts).find((candidate) => candidate.cli === request.cli);
      if (!row) {
        return { ok: false, status: 400, message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentNotOffered } };
      }
      // Already there (a second click, or it was installed by hand meanwhile): nothing to do.
      if (row.status === 'ready') return this.answer();
      if (row.status !== 'installable') {
        return {
          ok: false,
          status: 400,
          message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentNotInstallable, vars: { cli: row.cliLabel } },
        };
      }

      this.agentFailures.delete(row.cli);
      const controller = new AbortController();
      const cli = row.cli;
      const run = {
        cli,
        controller,
        promise: this.installCodingAgent(cli, actor, controller.signal)
          .then((outcome) => {
            if (outcome.kind === 'fail') this.agentFailures.set(cli, { detail: outcome.detail });
          })
          .catch((err: unknown) => {
            this.agentFailures.set(cli, { detail: getErrorMessage(err) });
          })
          .finally(() => {
            if (this.agentInstall === run) this.agentInstall = undefined;
          }),
      };
      this.agentInstall = run;
      return this.answer();
    });
  }

  deleteLibraryModel(request: LocalModelDeleteRequest, actor?: LocalModelActor): Promise<LocalModelVerbResult> {
    return this.exclusive(async () => {
      await this.settle();
      const state = await this.currentState();
      if (state.state === 'installing') return conflict('job-running');
      if (!INSTALL_STATE_TABLE[state.state].actions.includes('delete-model') || !state.runtime) {
        return conflict('wrong-state');
      }
      const id = request.modelId;
      // Never a path, and never another registry's name: the same shape a catalogue id has.
      if (!LOCAL_MODEL_ID_PATTERN.test(id)) {
        return { ok: false, status: 400, message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedNotOnThisMac } };
      }
      const entry = libraryOf(state).find((candidate) => candidate.id === id);
      if (state.model?.id === id) return conflict('model-active', {}, { model: state.model.label });

      // Only the runtime deletes a model, and only its answer says what is on disk.
      const target = baseUrlOf(state.runtime.port);
      let version: string | undefined;
      if (this.deps.supervisor.status().running) {
        try {
          version = await this.deps.getRuntimeVersion(target, AbortSignal.timeout(RUNTIME_READ_TIMEOUT_MS));
        } catch {
          version = undefined;
        }
      }
      if (version === undefined) return conflict('runtime-not-running');
      const listed = (await this.deps.listTags(target, AbortSignal.timeout(RUNTIME_READ_TIMEOUT_MS))).find(
        (model) => model.name === id
      );
      if (!entry && !listed) {
        return { ok: false, status: 400, message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedNotOnThisMac } };
      }
      // Asked of the runtime also for a checked model it did not list just now: its answer
      // (deleted, or "not found") is what says the model is gone, never an empty listing.
      let gone = false;
      try {
        gone = await this.deps.deleteModel(target, id, AbortSignal.timeout(RUNTIME_READ_TIMEOUT_MS));
      } catch {
        gone = false;
      }
      if (!gone) {
        return {
          ok: false,
          status: 500,
          message: { text: LOCAL_MODEL_INSTALL_LABELS.deleteFailed, vars: { model: entry?.label ?? id } },
        };
      }
      if (entry) {
        await this.record((current) => {
          const library = libraryOf(current).filter((candidate) => candidate.id !== id);
          return { ...current, library };
        });
      }
      this.forgetStore();
      if (actor) {
        void this.deps
          .audit({
            admin: actor.username,
            action: 'local_model_delete',
            target: id,
            ...(actor.ip ? { ip: actor.ip } : {}),
            detail: { verified: entry !== undefined, bytes: listed?.size ?? entry?.bytes ?? 0 },
          })
          .catch(() => {});
      }
      return this.answer();
    });
  }

  /**
   * Writes the event that starts a job (`install`, `use` or `resume`) and starts the job. `undefined`:
   * started. A state file that cannot be written for lack of space is not a 500: the job did
   * not start, and the view says `disk-full` with its "Try again" (a first install, which has
   * no job to show it on, is answered with that sentence).
   */
  private async beginJob(
    actor: LocalModelActor,
    event: Extract<InstallJobEvent, { type: 'install' | 'use' | 'resume' }>
  ): Promise<LocalModelVerbResult | undefined> {
    this.jobStarting = true;
    try {
      const started = await this.verbDispatch(event);
      if (!started) return conflict('wrong-state');
      this.startJob(actor);
      return undefined;
    } catch (err) {
      if (!isDiskFullError(err)) throw err;
      // A first install has no job to show the failure on: the sentence goes back as it is.
      if (event.type === 'install' && (await this.currentState().catch(() => undefined))?.state === 'idle') {
        return { ok: false, status: 507, message: { text: LOCAL_MODEL_INSTALL_LABELS.errDiskFull } };
      }
      const kept = this.unrecorded?.progress;
      this.unrecorded = {
        failure: { code: 'disk-full', detail: getErrorMessage(err) },
        ...(kept ? { progress: kept } : {}),
      };
      return this.answer();
    } finally {
      this.jobStarting = false;
    }
  }

  cancel(): Promise<LocalModelVerbResult> {
    return this.exclusive(async () => {
      // Taken before anything is awaited: a Cancel that arrives while a job runs is answered
      // with the view after it, also when the job finishes in the same moment.
      const job = this.job;
      if (!job) {
        // No job in this process: a job a restart interrupted is paused, never running.
        await this.settle();
        return conflict('wrong-state');
      }
      job.controller.abort();
      await job.promise.catch(() => {});
      // The step may have finished the job while it was being interrupted (the connect step
      // completes its two writes). Then there is nothing left to pause, and the view says so.
      // Otherwise the job is paused with its download as it stood, in ONE write.
      const progress = this.progressNow();
      try {
        await this.deps.mutateState((current) => {
          if (current.state !== 'installing') return undefined;
          const kept = progress ? reduceInstallJob(current, { type: 'progress', ...progress }) : current;
          return reduceInstallJob(kept, { type: 'cancel' });
        });
      } catch (err) {
        // The job IS stopped. The file could not be told: the view shows the pause from memory.
        console.warn(`[local-model] Could not write the paused install: ${getErrorMessage(err)}`);
        this.unrecorded = { ...(progress ? { progress } : {}) };
      }
      this.clearProgress();
      return this.answer();
    });
  }

  resume(
    request: LocalModelResumeRequest,
    actor: LocalModelActor,
    liveSessionNames: readonly string[] = []
  ): Promise<LocalModelVerbResult> {
    return this.exclusive(async () => {
      await this.settle();
      const state = await this.currentState();
      if (state.state === 'installing') return conflict('job-running');
      if (state.state !== 'paused' && state.state !== 'failed') return conflict('wrong-state');
      if (request.newPort === true && state.runtime) {
        const open = this.sessionsOpen(state, liveSessionNames);
        if (open) return open;
        await this.changePort(state);
      }
      return (await this.beginJob(actor, { type: 'resume' })) ?? this.answer();
    });
  }

  /**
   * A job that starts from a model the person had stopped runs the runtime, and that model is
   * then in use: the Stop is undone, like Start undoes it, so the runtime starts with the
   * server again. Without this the model would be running now and stay down after a restart.
   */
  private async undoStop(): Promise<void> {
    await this.record((current) =>
      current.runtime && !current.runtime.enabled
        ? { ...current, runtime: { ...current.runtime, enabled: true } }
        : undefined
    );
  }

  /** 409 `sessions-open` while live sessions use a connection of ours, else `undefined`. */
  private sessionsOpen(
    state: LocalModelStateFile,
    liveSessionNames: readonly string[]
  ): LocalModelVerbResult | undefined {
    if (!state.connection || liveSessionNames.length === 0) return undefined;
    const sessions = [...liveSessionNames];
    return conflict('sessions-open', { sessions }, { sessions: sessions.join(', ') });
  }

  /**
   * Chooses another port than the stored one and moves the saved endpoint with it. False when
   * no other port is free. The state file first, then the saved endpoint: a state write that
   * fails changes nothing, and a refused endpoint write puts the old port back, so the two
   * never disagree. The stored pid stays: when it is still our own runtime on the OLD port,
   * the next start ends it instead of leaving a second runtime behind.
   */
  private async changePort(state: LocalModelStateFile): Promise<boolean> {
    if (!state.runtime) return false;
    const previous = state.runtime.port;
    const port = await this.deps.chooseRuntimePort({ avoid: [previous] });
    if (port === undefined) return false;
    const setPort = (value: number): Promise<void> =>
      this.record((current) =>
        current.runtime ? { ...current, runtime: { ...current.runtime, port: value } } : undefined
      );
    await setPort(port);
    if (state.connection) {
      try {
        await this.deps.moveLocalEndpoint(port);
      } catch (err) {
        await setPort(previous).catch(() => {});
        throw err;
      }
    }
    this.portInUse = false;
    return true;
  }

  runtime(request: LocalModelRuntimeRequest, liveSessionNames: readonly string[] = []): Promise<LocalModelVerbResult> {
    return this.exclusive(async () => {
      await this.settle();
      let state = await this.currentState();
      if (state.state === 'installing') return conflict('job-running');
      if (state.state !== 'installed' || !state.runtime) return conflict('wrong-state');

      if (request.action === 'stop') {
        // Their coding agents keep calling the address they were started with.
        const open = this.sessionsOpen(state, liveSessionNames);
        if (open) return open;
        await this.deps.supervisor.stop({
          ...(state.runtime.pid !== undefined ? { previousPid: state.runtime.pid } : {}),
        });
        this.portInUse = false;
        this.startFailed = undefined;
        this.forgetStore();
        await this.record((current) =>
          current.runtime ? { ...current, runtime: { ...current.runtime, enabled: false } } : undefined
        );
        return this.answer();
      }

      if (request.newPort === true) {
        const open = this.sessionsOpen(state, liveSessionNames);
        if (open) return open;
        // The old child, when one is still alive, holds the old port: it must go first.
        await this.deps.supervisor.stop({
          ...(state.runtime.pid !== undefined ? { previousPid: state.runtime.pid } : {}),
        });
        await this.changePort(state);
      }
      await this.record((current) =>
        current.runtime ? { ...current, runtime: { ...current.runtime, enabled: true } } : undefined
      );
      state = await this.deps.readState();
      const started = await this.startRuntime(state);
      if (started.ok) await this.refreshDigest(await this.deps.readState());
      this.forgetStore();
      return this.answer();
    });
  }

  remove(
    request: LocalModelRemoveRequest,
    liveSessionNames: readonly string[],
    actor?: LocalModelActor
  ): Promise<LocalModelVerbResult> {
    return this.exclusive(async () => {
      await this.settle();
      const state = await this.currentState();
      if (state.state === 'installing') return conflict('job-running');
      const open = this.sessionsOpen(state, liveSessionNames);
      if (open) return open;

      // Our child, and a runtime an earlier server left behind (known by the stored pid): no
      // file is deleted under a process that still runs from it.
      await this.deps.supervisor.stop({
        ...(state.runtime?.pid !== undefined ? { previousPid: state.runtime.pid } : {}),
      });
      // The two writes outside our folder are undone first: when one is refused, nothing was
      // deleted yet and the person can try again.
      if (state.connection) {
        await this.deps.disconnectLocalModel({ flagWasEnabled: state.connection.flagWasEnabled });
      }
      const removeModel = request.removeModel === true;
      await this.deps.removeLocalModelFiles({ models: removeModel, paths: this.paths() });
      await this.verbDispatch({ type: 'remove' });
      this.clearProgress();
      this.unrecorded = undefined;
      this.portInUse = false;
      this.startFailed = undefined;
      this.digestStatus = undefined;
      this.forgetStore();
      if (actor) {
        void this.deps
          .audit({
            admin: actor.username,
            action: 'local_model_remove',
            target: state.model?.id ?? '',
            ...(actor.ip ? { ip: actor.ip } : {}),
            detail: { removeModel },
          })
          .catch(() => {});
      }
      return this.answer();
    });
  }

  async boot(): Promise<void> {
    try {
      await this.recovered();
      const state = await this.currentState();
      const installed = state.state === 'installed' && state.runtime !== undefined && state.model !== undefined;
      // The record of the connection can be gone while the model is still installed (a
      // config-backup restore of an older endpoint store): it is put back, never replaced.
      if (installed && state.connection && state.runtime && state.model) {
        const restored = await this.deps.ensureLocalEndpoint({
          port: state.runtime.port,
          modelId: state.model.id,
          context: state.model.context,
        });
        if (restored)
          console.warn('[local-model] The saved endpoint of the model on this Mac was missing and was put back.');
      }
      if (!installed || !state.runtime?.enabled) {
        // Nothing starts the runtime here (a job waits for a click, the person stopped the
        // model). One an earlier server left behind is ended: it holds the model's memory,
        // and a later Remove must not delete its folder under it.
        if (state.runtime?.pid !== undefined) {
          await this.deps.supervisor.stop({ previousPid: state.runtime.pid });
        }
        return;
      }
      const started = await this.startRuntime(state);
      if (!started.ok) {
        console.warn(
          `[local-model] The runtime did not start: ${started.code}${started.detail ? ` (${started.detail})` : ''}`
        );
        return;
      }
      const digest = await this.refreshDigest(await this.deps.readState());
      if (digest === 'changed') {
        console.warn('[local-model] The model changed since it was installed. Sessions on it are refused.');
      }
    } catch (err) {
      console.warn(`[local-model] Start-up check failed: ${getErrorMessage(err)}`);
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const job = this.job;
    // The state file keeps saying `installing`: the next start reads that as a paused job.
    job?.controller.abort();
    // An agent installer beside an installed model: its process group is ended, nothing is recorded.
    this.agentInstall?.controller.abort();
    // The runtime is signalled at once, not after the job let go: the server may exit soon.
    const stopped = Promise.resolve()
      .then(() => this.deps.supervisor.stop())
      .catch((err: unknown) => {
        console.warn(`[local-model] Stopping the runtime failed: ${getErrorMessage(err)}`);
      });
    if (job) {
      await Promise.race([job.promise.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3_000).unref())]);
    }
    await stopped;
  }

  async idle(): Promise<void> {
    while (this.job || this.agentInstall) {
      await (this.job ?? this.agentInstall)?.promise.catch(() => {});
    }
  }

  // ---------- The job ----------

  private startJob(actor: LocalModelActor): void {
    const controller = new AbortController();
    this.clearProgress();
    this.unrecorded = undefined;
    const job = {
      controller,
      promise: this.runJob(actor, controller.signal).finally(() => {
        if (this.job === job) this.job = undefined;
      }),
    };
    this.job = job;
  }

  /** Runs the steps from the stored one on, until the job is installed, failed or interrupted. Never rejects. */
  private async runJob(actor: LocalModelActor, signal: AbortSignal): Promise<void> {
    try {
      for (;;) {
        const state = await this.deps.readState();
        if (state.state !== 'installing' || !state.step || signal.aborted) return;
        let outcome: StepOutcome;
        try {
          outcome = await this.runStep(state.step, state, actor, signal);
        } catch (err) {
          // A write of the step itself that found no space is a full disk, not a mystery.
          outcome = {
            kind: 'fail',
            code: isDiskFullError(err) ? 'disk-full' : 'internal',
            detail: getErrorMessage(err),
          };
        }
        if (outcome.kind === 'done') {
          // A step that finished stays finished, also when Cancel arrived while it ran. Its
          // download figures go first, so the next step is never shown with them.
          this.clearProgress();
          // A model arrived, was checked or was connected: the library is read again.
          this.forgetStore();
          await this.dispatch({ type: 'step-done' });
          continue;
        }
        // An interrupted step is not a failed one, whatever its last call answered. Cancel
        // writes `paused` itself; a server that is stopping writes nothing.
        if (outcome.kind === 'cancelled' || signal.aborted || this.stopping) return;
        const failure: JobFailure = {
          code: outcome.code,
          ...(outcome.vars ? { vars: outcome.vars } : {}),
          ...(outcome.detail ? { detail: outcome.detail } : {}),
          ...(outcome.nextModelId ? { nextModelId: outcome.nextModelId } : {}),
        };
        const progress = this.progressNow();
        try {
          // The failure and the download as it stood, in ONE write.
          await this.deps.mutateState((current) => {
            const kept = progress ? reduceInstallJob(current, { type: 'progress', ...progress }) : current;
            const next = reduceInstallJob(kept, { type: 'fail', ...failure });
            return next === current ? undefined : next;
          });
        } catch (err) {
          // The disk that failed the step also refuses the state file. The outcome is not
          // lost: the view shows it from memory and the next verb writes it.
          console.warn(`[local-model] Could not write why the install stopped: ${getErrorMessage(err)}`);
          this.unrecorded = { failure, ...(progress ? { progress } : {}) };
        }
        this.clearProgress();
        return;
      }
    } catch (err) {
      // A write of the job itself was refused (the step that finished could not be recorded).
      console.warn(`[local-model] The install job stopped: ${getErrorMessage(err)}`);
      const progress = this.progressNow();
      this.unrecorded = {
        failure: { code: isDiskFullError(err) ? 'disk-full' : 'internal', detail: getErrorMessage(err) },
        ...(progress ? { progress } : {}),
      };
      this.clearProgress();
    }
  }

  private runStep(
    step: LocalModelInstallStep,
    state: LocalModelStateFile,
    actor: LocalModelActor,
    signal: AbortSignal
  ): Promise<StepOutcome> {
    switch (step) {
      case 'runtime':
        return this.stepRuntime(state, signal);
      case 'model':
        return this.stepModel(state, signal);
      case 'verify':
        return this.stepVerify(state, signal);
      case 'agent':
        return this.stepAgent(state, actor, signal);
      case 'connect':
        return this.stepConnect(state, signal);
    }
  }

  /** Makes sure the runtime runs before a step that needs it. `undefined`: it runs. */
  private async needRuntime(signal: AbortSignal): Promise<StepOutcome | undefined> {
    const state = await this.deps.readState();
    const started = await this.startRuntime(state);
    if (signal.aborted) return CANCELLED;
    return started.ok ? undefined : this.startFailure(started, state);
  }

  private async stepRuntime(state: LocalModelStateFile, signal: AbortSignal): Promise<StepOutcome> {
    if (!state.model) return { kind: 'fail', code: 'internal', detail: 'The job has no model.' };
    const installed = await this.deps.ensureRuntimeInstalled({
      pin: this.deps.pin,
      paths: this.paths(),
      signal,
      onProgress: (progress) => this.onProgress(progress),
    });
    if (!installed.ok) {
      if (installed.code === 'cancelled') return CANCELLED;
      return { kind: 'fail', code: installed.code, ...(installed.detail ? { detail: installed.detail } : {}) };
    }
    if (signal.aborted) return CANCELLED;

    // The port is chosen ONCE. A job that already has one keeps it.
    if (!state.runtime) {
      const port = await this.deps.chooseRuntimePort();
      if (port === undefined) return { kind: 'fail', code: 'port-in-use', vars: this.errorVars('port-in-use', state) };
      await this.record((current) =>
        current.runtime ? undefined : { ...current, runtime: { version: this.deps.pin.version, port, enabled: true } }
      );
    }
    const withPort = await this.deps.readState();
    const started = await this.startRuntime(withPort);
    if (signal.aborted) return CANCELLED;
    if (!started.ok) return this.startFailure(started, withPort);

    // The budget is MEASURED now: the runtime printed the device total when it started. The
    // model is judged against it before a byte of it is downloaded.
    const measuredTotalBytes = started.measuredTotalBytes ?? withPort.runtime?.measuredTotalBytes;
    if (measuredTotalBytes !== undefined) {
      const hw = await this.deps.readHardware();
      const catalog = this.deps.getCatalog();
      const options: RecommendOptions = { measuredTotalBytes, runtimeDownloadBytes: 0 };
      if (!this.deps.modelFitsBudget(hw, catalog, state.model.id, state.model.context, options)) {
        const nextModelId = await this.nextModelId(state.model, options, { needsLessMemory: true });
        return {
          kind: 'fail',
          code: 'does-not-fit',
          vars: this.errorVars('does-not-fit', state),
          ...(nextModelId ? { nextModelId } : {}),
        };
      }
    }
    return DONE;
  }

  private async stepModel(state: LocalModelStateFile, signal: AbortSignal): Promise<StepOutcome> {
    if (!state.model) return { kind: 'fail', code: 'internal', detail: 'The job has no model.' };
    const blocked = await this.needRuntime(signal);
    if (blocked) return blocked;
    const running = await this.deps.readState();
    if (!running.runtime) return { kind: 'fail', code: 'internal', detail: 'The runtime has no port.' };
    const target = baseUrlOf(running.runtime.port);

    // What a replaced job left of another model goes first, so no unchecked leftover stays in the store.
    if (await this.dropReplacedModel(running, target, signal)) return CANCELLED;

    const pulled = await this.deps.pullModel(target, state.model.id, {
      signal,
      onProgress: (progress) => this.onProgress(progress),
    });
    if (!pulled.ok) {
      if (pulled.code === 'cancelled') return CANCELLED;
      // A runtime that is gone for good looks like a broken network to the pull. It is not.
      const status = this.deps.supervisor.status();
      if (pulled.code === 'pull-failed' && (status.gaveUp || !status.running)) {
        return {
          kind: 'fail',
          code: 'runtime-stopped',
          ...(pulled.detail ? { detail: pulled.detail } : {}),
        };
      }
      const nextModelId = pulled.code === 'model-not-found' ? await this.nextModelId(state.model) : undefined;
      return {
        kind: 'fail',
        code: pulled.code,
        vars: this.errorVars(pulled.code, state),
        ...(pulled.detail ? { detail: pulled.detail } : {}),
        ...(nextModelId ? { nextModelId } : {}),
      };
    }
    // From here on every size shown for the model is the pull's own total.
    const pullBytes = pulled.totalBytes;
    await this.record((current) =>
      current.model ? { ...current, model: { ...current.model, pullBytes } } : undefined
    );
    return DONE;
  }

  /**
   * Deletes what a replaced job left of ANOTHER model (`replacedModelId`): the model through
   * the runtime when it was downloaded whole, and the partial blobs of an interrupted download.
   * A no-op without one. True when the job was cancelled meanwhile.
   */
  private async dropReplacedModel(
    running: LocalModelStateFile,
    target: OllamaTarget,
    signal: AbortSignal
  ): Promise<boolean> {
    if (!running.replacedModelId) return false;
    try {
      await this.deps.deleteModel(target, running.replacedModelId, signal);
    } catch {
      /* a leftover is not a reason to stop: Remove with the models deletes it */
    }
    if (signal.aborted) return true;
    // A download that was interrupted left partial blobs and no model: the runtime answers
    // "not found" for it and deletes nothing. No download is in flight here, so every
    // partial file in the store is a dead one.
    try {
      const freed = await this.deps.removePartialModelBlobs(this.paths());
      if (freed > 0) console.log(`[local-model] Deleted ${formatGb(freed)} GB a replaced download had left.`);
    } catch {
      /* as above */
    }
    await this.record((current) => {
      const { replacedModelId: _replaced, ...rest } = current;
      return rest;
    });
    this.forgetStore();
    return false;
  }

  private async stepVerify(state: LocalModelStateFile, signal: AbortSignal): Promise<StepOutcome> {
    if (!state.model) return { kind: 'fail', code: 'internal', detail: 'The job has no model.' };
    const blocked = await this.needRuntime(signal);
    if (blocked) return blocked;
    const running = await this.deps.readState();
    if (!running.runtime) return { kind: 'fail', code: 'internal', detail: 'The runtime has no port.' };
    const target = baseUrlOf(running.runtime.port);
    const { id, context } = state.model;

    // A switch has no download step, so the leftovers of the job it replaced go here.
    if (await this.dropReplacedModel(running, target, signal)) return CANCELLED;

    // A switch names the digest the model was checked with (`use`). Another one under the
    // same name is other weights or another template: it is not loaded, let alone connected.
    const expected = state.model.digest;
    if (expected) {
      const before = await this.deps.readModelDigest(target, id, signal);
      if (signal.aborted) return CANCELLED;
      if (compareModelDigest(expected, before) !== 'same') {
        return {
          kind: 'fail',
          code: 'model-changed',
          detail: before
            ? 'The runtime reports another digest for the model.'
            : 'The runtime no longer lists the model.',
        };
      }
    }

    const verified = await this.deps.verifyModel(target, id, context, signal);
    if (!verified.ok) {
      if (verified.code === 'cancelled') return CANCELLED;
      let vars = this.errorVars(verified.code, state);
      if (verified.code === 'context-not-applied') {
        let actual = '?';
        try {
          const loaded = (await this.deps.listRunning(target, AbortSignal.timeout(RUNTIME_READ_TIMEOUT_MS))).find(
            (model) => model.name === id
          );
          if (loaded) actual = String(loaded.contextLength);
        } catch {
          /* the sentence then says "?" */
        }
        vars = { model: state.model.label, actual, wanted: String(context) };
      }
      const nextModelId =
        verified.code === 'does-not-fit'
          ? await this.nextModelId(state.model, undefined, { needsLessMemory: true })
          : verified.code === 'no-tool-call'
            ? await this.nextModelId(state.model)
            : undefined;
      return {
        kind: 'fail',
        code: verified.code,
        ...(vars ? { vars } : {}),
        ...(verified.detail ? { detail: verified.detail } : {}),
        ...(nextModelId ? { nextModelId } : {}),
      };
    }

    // The digest of what was just checked: what a session launch compares with from now on.
    const digest = await this.deps.readModelDigest(target, id, signal);
    if (signal.aborted) return CANCELLED;
    if (!digest) {
      return {
        kind: 'fail',
        code: 'load-failed',
        vars: this.errorVars('load-failed', state),
        detail: 'The runtime reports no digest for the model.',
      };
    }
    if (expected && compareModelDigest(expected, digest) !== 'same') {
      return { kind: 'fail', code: 'model-changed', detail: 'The runtime reports another digest for the model.' };
    }
    const loaded = verified.loaded;
    // The model is one of the library from here on: checked, with the digest a later switch
    // must find again, its size on disk and the coding agent of this job.
    let bytes: number | undefined;
    try {
      bytes = (await this.deps.listTags(target, AbortSignal.timeout(RUNTIME_READ_TIMEOUT_MS))).find(
        (model) => model.name === id
      )?.size;
    } catch {
      bytes = undefined;
    }
    let verifiedAt: string | undefined;
    try {
      verifiedAt = new Date(this.deps.now()).toISOString();
    } catch {
      verifiedAt = undefined;
    }
    await this.record((current) => {
      if (!current.model) return undefined;
      const known = (current.library ?? []).find((entry) => entry.id === id);
      const size = bytes && bytes > 0 ? bytes : (current.model.pullBytes ?? known?.bytes);
      const entry: LocalModelLibraryEntry = {
        id,
        label: current.model.label,
        context,
        digest,
        ...(size ? { bytes: size } : {}),
        ...(current.cli ? { cli: current.cli } : {}),
        ...(verifiedAt ? { verifiedAt } : {}),
      };
      return {
        ...current,
        model: { ...current.model, digest },
        loaded: { ...loaded },
        library: upsertLibraryEntry(current.library ?? [], entry),
      };
    });
    this.digestStatus = 'same';
    this.digestCheckedAt = this.deps.now();
    return DONE;
  }

  private async stepAgent(
    state: LocalModelStateFile,
    actor: LocalModelActor,
    signal: AbortSignal
  ): Promise<StepOutcome> {
    if (!state.cli) return { kind: 'fail', code: 'internal', detail: 'The job has no coding agent.' };
    const outcome = await this.installCodingAgent(state.cli.id, actor, signal);
    if (outcome.kind !== 'fail') return outcome;
    return {
      kind: 'fail',
      code: 'harness-failed',
      vars: this.errorVars('harness-failed', state),
      detail: outcome.detail,
    };
  }

  /**
   * Installs one coding agent with its STOCK command, through the install slot it shares with
   * the CLI management routes. What the `agent` step of a job and `installAgent()` both run.
   * `done` also when the agent is already there; `fail` carries what to show as the detail.
   */
  private async installCodingAgent(
    cli: string,
    actor: LocalModelActor,
    signal: AbortSignal
  ): Promise<{ kind: 'done' } | { kind: 'cancelled' } | { kind: 'fail'; detail: string }> {
    // A resumed job, or an installer that finished before a restart: the binary may be there.
    if (await this.deps.recheckCliInstalled(cli)) return { kind: 'done' };
    if (signal.aborted) return { kind: 'cancelled' };

    // Only a coding agent of the catalogue, and only its STOCK install command.
    if (!this.deps.getCatalog().harnesses.some((row) => row.cli === cli)) {
      return { kind: 'fail', detail: 'Not a coding agent of the local model catalogue.' };
    }
    const command = this.deps.stockInstallCommand(cli);
    if (!command) return { kind: 'fail', detail: 'No install command for this platform.' };
    const release = this.deps.tryBeginCliInstall(cli);
    if (!release) return { kind: 'fail', detail: 'Another install of this coding agent is running.' };
    let result: CliInstallResult;
    try {
      result = await this.deps.runInstallCommand(command, { signal });
    } finally {
      release();
    }
    void this.deps
      .audit({
        admin: actor.username,
        action: 'cli_install',
        target: cli,
        ...(actor.ip ? { ip: actor.ip } : {}),
        detail: {
          command,
          exitCode: result.code,
          timedOut: result.timedOut,
          aborted: result.aborted,
          via: 'local-model',
        },
      })
      .catch(() => {});
    // Even a failed or interrupted install may have left a binary behind: the cached lookups
    // are forgotten either way, and what counts is whether the binary is found now.
    const installed = await this.deps.recheckCliInstalled(cli);
    if (result.aborted || signal.aborted) return { kind: 'cancelled' };
    if (installed) return { kind: 'done' };
    const detail = result.timedOut
      ? `The installer was stopped after ${Math.round(CLI_INSTALL_TIMEOUT_MS / 1000)} seconds.`
      : result.output.slice(-INSTALLER_DETAIL_CHARS).trim() ||
        (result.code === 0 ? 'The installer finished, but the program was not found afterwards.' : 'No output.');
    return { kind: 'fail', detail };
  }

  private async stepConnect(state: LocalModelStateFile, signal: AbortSignal): Promise<StepOutcome> {
    if (!state.model) return { kind: 'fail', code: 'internal', detail: 'The job has no model.' };
    const blocked = await this.needRuntime(signal);
    if (blocked) return blocked;
    const running = await this.deps.readState();
    if (!running.runtime) return { kind: 'fail', code: 'internal', detail: 'The runtime has no port.' };
    const { port } = running.runtime;
    const { id, context } = state.model;

    // The record names the model exactly as the runtime lists it for a coding agent.
    const listed = await this.deps.listOpenAiModels(baseUrlOf(port), signal);
    if (signal.aborted) return CANCELLED;
    if (!listed.includes(id)) {
      return { kind: 'fail', code: 'connect-failed', detail: `The runtime does not list ${id}.` };
    }

    // The connection is CLAIMED in the state file before either write, so no record of ours
    // can exist that the state file does not know: a state write that fails, or a server that
    // is killed between the two, leaves at worst a claim with nothing behind it.
    let claim = running.connection;
    if (!claim) {
      let found: LocalEndpointInspection;
      try {
        found = await this.deps.inspectLocalEndpoint({ port, modelId: id, context });
      } catch (err) {
        return { kind: 'fail', code: 'connect-failed', detail: getErrorMessage(err) };
      }
      if (signal.aborted) return CANCELLED;
      // A record with our id that says something else is somebody else's: never overwritten.
      if (found.record === 'other') {
        return { kind: 'fail', code: 'endpoint-id-taken', vars: this.errorVars('endpoint-id-taken', state) };
      }
      // A record that already says what ours would say can only be ours (the routes refuse
      // the id): the flag was then switched on by us, and its earlier value is not known, so
      // it is never switched off again.
      claim = {
        endpointId: LOCAL_MODEL_ENDPOINT_ID,
        flagWasEnabled: found.record === 'same' ? true : found.flagEnabled,
      };
      const claimed = claim;
      await this.record((current) => ({ ...current, connection: claimed }));
    }
    if (signal.aborted) return CANCELLED;

    // From here on the two writes run to their end: Cancel no longer interrupts.
    const connected = await this.deps.connectLocalModel({
      port,
      modelId: id,
      context,
      ours: true,
      flagWasEnabled: claim.flagWasEnabled,
    });
    if (!connected.ok) {
      return {
        kind: 'fail',
        code: connected.code,
        vars: this.errorVars(connected.code, state),
        ...(connected.detail ? { detail: connected.detail } : {}),
      };
    }
    return DONE;
  }
}

/** A service over `deps`. A test builds its own with fakes. */
export function createLocalModelService(deps: Partial<LocalModelServiceDeps> = {}): LocalModelService {
  return new LocalModelServiceImpl(deps);
}

let processService: LocalModelService | undefined;

/** The one service of this process, built on first use with the real modules. What the routes and server.ts call. */
export function getLocalModelService(): LocalModelService {
  processService ??= createLocalModelService();
  return processService;
}
