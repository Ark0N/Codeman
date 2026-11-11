/**
 * @fileoverview Types of the local model INSTALL: the runtime pin, the job's states, steps and
 * error codes, the progress, the `install` object of `GET /api/local-model`, the bodies and
 * answers of the install verbs, and the shape of the state file.
 *
 * The read side (hardware, catalogue, recommendation) is in src/types/local-model.ts. This
 * file holds `LocalModelStatus`, the whole `data` of the GET, because it joins the two.
 *
 * Who produces what:
 *  - `LocalModelRuntimePin`: a compiled constant in src/local-model/runtime.ts. No file, no
 *    setting and no request can change which binary is downloaded.
 *  - `LocalModelStateFile`: src/local-model/state-store.ts, the ONE writer of
 *    `local-model.json` (mode 0600, temp file + rename).
 *  - `LocalModelInstallView`: src/local-model/install-job.ts (`buildInstallView()`, pure), from
 *    the state file plus what is live (the runtime child, the developer tools check).
 *  - `LocalModelStatus` and the verb answers: src/web/routes/local-model-routes.ts.
 *
 * The HTTP contract. Every route is admin only in multi-user mode (403 `FORBIDDEN`) and
 * EXPERIMENTAL like the GET (docs/versioning-policy.md). Every verb answers
 * `{ success: true, data: LocalModelInstallView }` with the view AFTER the verb.
 *
 * | Route                            | Body                        | Refusals                                              |
 * |----------------------------------|-----------------------------|-------------------------------------------------------|
 * | `GET /api/local-model`           | none                        | none (a failed probe is an answer)                    |
 * | `POST /api/local-model/install`  | `LocalModelInstallRequest`  | 400 not a row the server offers, or a saved endpoint  |
 * |                                  |                             | already has the reserved id; 409 `job-running`,       |
 * |                                  |                             | `already-installed` (this model at this context is    |
 * |                                  |                             | the one in use), `size-changed`, `sessions-open`      |
 * | `POST /api/local-model/use`      | `LocalModelUseRequest`      | 400 not a checked model of the library, or no coding  |
 * |                                  |                             | agent for it is installed; 409 `job-running`,         |
 * |                                  |                             | `wrong-state`, `already-installed`, `sessions-open`   |
 * | `POST /api/local-model/cancel`   | none                        | 409 `wrong-state` (no job is running)                 |
 * | `POST /api/local-model/resume`   | `LocalModelResumeRequest`   | 409 `job-running`, `wrong-state` (not paused or       |
 * |                                  |                             | failed), `sessions-open` (another port while live     |
 * |                                  |                             | sessions use the model)                               |
 * | `POST /api/local-model/runtime`  | `LocalModelRuntimeRequest`  | 409 `wrong-state` (not installed), `job-running`,     |
 * |                                  |                             | `sessions-open` (stop, or another port, while live    |
 * |                                  |                             | sessions use the model)                               |
 * | `DELETE /api/local-model`        | `LocalModelRemoveRequest`   | 409 `job-running`, `sessions-open`                    |
 * | `DELETE /api/local-model/models` | `LocalModelDeleteRequest`   | 400 not a model of this Mac; 409 `job-running`,       |
 * |                                  |                             | `wrong-state`, `model-active`, `runtime-not-running`; |
 * |                                  |                             | 500 the runtime did not delete it                     |
 *
 * A 409 is the error envelope plus `data: LocalModelConflict`:
 * `{ success: false, error, errorCode: 'CONFLICT', data: { reason, message, ... } }`. A 409
 * WITHOUT `data` is a write of `settings.json` or of the endpoint store that was refused
 * because the file does not parse; `error` names the fix. A 400 the service names carries its
 * sentence the same way: `{ success: false, error, errorCode: 'INVALID_INPUT', data: {
 * message } }` (`LocalModelRefusal`), so the window can print it in its own language.
 *
 * The rules of src/types/local-model.ts hold here too:
 *  1. A size a person reads travels twice: as bytes and as decimal GB text from `formatGb()`
 *     (`completedGb`, `totalGb`, `downloadGb`). The browser prints the text and adds or
 *     divides nothing for display. `mbPerSecond` is the one other unit, decimal MB per second.
 *  2. Every sentence the server chooses comes from `LOCAL_MODEL_INSTALL_LABELS`, with its
 *     numbers and names in `vars`. `{name}` is taken by the translator, so no slot has that name.
 *  3. A CLI id is data (`LocalModelInstallView.cli`): the browser passes it on and compares it
 *     with nothing. What a person reads is `cliLabel`.
 */

import type { HardwareFacts, Recommendation } from './local-model.js';

// ---------- The runtime pin ----------

/**
 * The one runtime build Codeman downloads and runs. A compiled constant
 * (`OLLAMA_RUNTIME_PIN` in src/local-model/runtime.ts): the hash is compared before anything
 * is unpacked, so the pin and the hash must come from the same reviewed source file.
 */
export interface LocalModelRuntimePin {
  /** The runtime's family. One value today. */
  id: 'ollama';
  /** The release ('0.40.15'). `GET /api/version` of the running runtime must answer it. */
  version: string;
  /** Where the archive is downloaded from. https, a fixed release asset. */
  url: string;
  /** Size of the archive in bytes. A body that grows past it is refused before the hash is finished. */
  bytes: number;
  /** Lowercase hex sha256 of the archive. */
  sha256: string;
  /** What the unpacked folder takes on disk, in bytes (measured: about 579 MB). */
  unpackedBytes: number;
  /** The oldest macOS major version the runtime supports. */
  minMacosMajor: number;
}

// ---------- States, steps, codes ----------

/**
 * Where the install stands. The verb of the flow is the same throughout: install, installing,
 * installed.
 *  - `idle`: nothing is installed and no job exists.
 *  - `installing`: the one job is running; `step` says where.
 *  - `paused`: the job stopped at `step` because of Cancel or a server restart. It never
 *    continues without a click.
 *  - `failed`: the job stopped at `step` with `error`.
 *  - `installed`: the model is connected. Whether the runtime runs is `running`, not a state.
 * The state table (what is on disk, what a restart and Cancel do, the allowed actions) is
 * `INSTALL_STATE_TABLE` in src/local-model/install-job.ts.
 */
export type LocalModelInstallState = 'idle' | 'installing' | 'paused' | 'failed' | 'installed';

/**
 * The steps of a job, in the order they run.
 *  - `runtime`: get the pinned runtime (download, compare the hash, unpack), start it, read
 *    the measured memory budget and judge the chosen model against it.
 *  - `model`: download the model (the runtime's pull).
 *  - `verify`: load the model and check it: one tiny chat, the memory and context the runtime
 *    reports, one tool call.
 *  - `agent`: install the coding agent. Left out of a job whose coding agent is installed.
 *  - `connect`: save the connection (the endpoint record and the settings flag).
 */
export type LocalModelInstallStep = 'runtime' | 'model' | 'verify' | 'agent' | 'connect';

/** Every step, in order. A job runs these, without `agent` when the coding agent is installed. */
export const LOCAL_MODEL_INSTALL_STEPS: readonly LocalModelInstallStep[] = [
  'runtime',
  'model',
  'verify',
  'agent',
  'connect',
];

/**
 * Why a job failed, or (in state `installed`) what blocks a session. Each code has one
 * sentence (`LOCAL_MODEL_ERROR_LABELS`) and one helpful next step (`LOCAL_MODEL_ERROR_NEXT`).
 *
 * | Code                      | Raised when                                                              |
 * |---------------------------|--------------------------------------------------------------------------|
 * | `runtime-download-failed` | the archive download still fails after its retries                       |
 * | `runtime-damaged`         | the archive's sha256 is not the pinned one (the file was deleted)        |
 * | `runtime-unpack-failed`   | `/usr/bin/tar` failed                                                    |
 * | `runtime-start-failed`    | the runtime was started and never answered `/api/version`. Installed:    |
 * |                           | the last start failed (the detail says why), and Start tries again       |
 * | `runtime-stopped`         | the runtime crashed and was restarted 3 times, then given up: on an      |
 * |                           | installed model, or during a job's download                             |
 * | `runtime-not-running`     | installed: the runtime is not running (the person stopped it). Only a    |
 * |                           | refused session start says it; the view shows no error for a stopped runtime |
 * | `port-in-use`             | another program listens on the stored port, or no port of the span is free |
 * | `disk-full`               | a write failed for lack of space                                         |
 * | `pull-failed`             | the pull still ends on an error line or a cut stream after its retries   |
 * | `model-not-found`         | the registry no longer has this model under this name                    |
 * | `does-not-fit`            | the measured budget rules the model out, or the runtime did not put all of it on the GPU |
 * | `context-not-applied`     | the runtime loaded the model with another context than the chosen one    |
 * | `load-failed`             | the tiny chat that loads the model failed                                |
 * | `no-tool-call`            | the tool probe was answered without a tool call with parseable arguments |
 * | `probe-unfinished`        | the tool probe ended on its token limit, so it proves nothing            |
 * | `harness-failed`          | the coding agent's install command failed, or its binary is still missing |
 * | `endpoint-id-taken`       | a saved endpoint with our id exists that this feature did not write      |
 * | `connect-failed`          | the endpoint record or the settings flag could not be written            |
 * | `model-changed`           | installed: the model's digest is not the one stored at install time. A   |
 * |                           | switch: the model's digest is not the one it was checked with            |
 * | `job-unfinished`          | a job that changes the model in use is running or stopped. Only a        |
 * |                           | refused session start says it: nothing is started until the job ended    |
 * | `internal`                | anything unexpected (the exception text is in `detail`)                  |
 */
export type LocalModelErrorCode =
  | 'runtime-download-failed'
  | 'runtime-damaged'
  | 'runtime-unpack-failed'
  | 'runtime-start-failed'
  | 'runtime-stopped'
  | 'runtime-not-running'
  | 'port-in-use'
  | 'disk-full'
  | 'pull-failed'
  | 'model-not-found'
  | 'does-not-fit'
  | 'context-not-applied'
  | 'load-failed'
  | 'no-tool-call'
  | 'probe-unfinished'
  | 'harness-failed'
  | 'endpoint-id-taken'
  | 'connect-failed'
  | 'model-changed'
  | 'job-unfinished'
  | 'internal';

/**
 * The ONE action that helps after an error. The window draws one button for it.
 *  - `retry`: "Try again". `POST /api/local-model/resume`.
 *  - `other-port`: "Use another port". `POST /api/local-model/resume` with `newPort: true`
 *    (state `failed`), or `POST /api/local-model/runtime` with `action: 'start'` and
 *    `newPort: true` (state `installed`).
 *  - `next-model`: "Try <model>". Back to the chooser with `error.nextModel` preselected; the
 *    person confirms its sizes and a new `POST /api/local-model/install` replaces the job.
 *    Without a `nextModel` the window offers the chooser and Remove.
 *  - `start`: "Start". `POST /api/local-model/runtime` with `action: 'start'`.
 *  - `remove`: "Remove". `DELETE /api/local-model`.
 *
 * `LOCAL_MODEL_ERROR_NEXT` is the default of a code. The view adapts it to the state the
 * error is shown in, so the button is always one the server accepts there: a code whose
 * default is `start` says `retry` on a failed job (there is no Start verb for a job), and
 * `runtime-start-failed` says `start` on an installed model (there is nothing to resume).
 */
export type LocalModelNextStep = 'retry' | 'other-port' | 'next-model' | 'start' | 'remove';

/**
 * What a client may do in the current state. The view's `actions` lists exactly the ones the
 * server would accept right now, so the window shows a button only for those.
 *  - `install`: `POST /api/local-model/install`.
 *  - `cancel`: `POST /api/local-model/cancel`.
 *  - `resume`: `POST /api/local-model/resume`.
 *  - `start` and `stop`: `POST /api/local-model/runtime`.
 *  - `remove`: `DELETE /api/local-model`. In `idle` it is listed only while the model store
 *    still holds something (models an earlier Remove kept): it is then what frees that space.
 *  - `start-session`: not a route of this feature: the window starts a session on the endpoint
 *    `endpointId` with the coding agent `cli`. Offered only while the runtime runs and nothing
 *    blocks a session.
 *  - `use`: `POST /api/local-model/use`. Listed only while a row of `library` offers it.
 *  - `delete-model`: `DELETE /api/local-model/models`. Listed only while a row of `library`
 *    offers it.
 *  - `install-agent`: `POST /api/local-model/agent`. Listed only while a row of `harnesses`
 *    offers it.
 */
export type LocalModelAction =
  | 'install'
  | 'cancel'
  | 'resume'
  | 'start'
  | 'stop'
  | 'remove'
  | 'start-session'
  | 'use'
  | 'delete-model'
  | 'install-agent';

/** Whether the Mac has the developer tools (git, Python) a coding agent calls. */
export type LocalModelDeveloperTools =
  /** `/usr/bin/xcode-select -p` succeeded. */
  | 'present'
  /** It failed: macOS will offer to install the tools the first time an agent needs one. */
  | 'missing'
  /** Not macOS, or the check did not answer in time. Nothing is said then. */
  | 'unknown';

// ---------- Sentences ----------

/**
 * Every sentence the server may put into the `install` object or a 409, in English (the i18n
 * source language). Like `LOCAL_MODEL_LABELS`: the zh-CN dictionary in src/web/public/i18n.js
 * has one entry per value, keyed by this exact text, and the i18n test lists them from here.
 * A constant of its own, so the sentences of the recommendation and of the install can be
 * listed apart.
 *
 * | Key                    | Slots (all text)                                                     |
 * |------------------------|----------------------------------------------------------------------|
 * | `errPortInUse`         | `port`: the port number                                              |
 * | `errModelNotFound`, `errDoesNotFit`, `errLoadFailed`, `errNoToolCall`, `errProbeUnfinished` | `model`: the model's label |
 * | `errContextNotApplied` | `model`; `actual`: the context the runtime reports; `wanted`: the chosen one |
 * | `errHarnessFailed`     | `cli`: the coding agent's label                                      |
 * | `errEndpointIdTaken`   | `id`: the endpoint id this feature uses                              |
 * | `refusedAgentNotInstallable` | `cli`: the coding agent's label                                |
 * | `refusedOtherModel`    | `model`: the label of the model that is in use                       |
 * | `refusedAgentMissing`  | `cli`: the coding agent's label                                      |
 * | `conflictModelActive`, `deleteFailed` | `model`: the model's label                            |
 * | `conflictSizeChanged`  | `size`: the server's own total as decimal GB                         |
 * | `conflictSessionsOpen` | `sessions`: the session names, joined with ', '                      |
 *
 * `developerToolsMissing` is not sent: the view carries `developerTools` and the window prints
 * this sentence when it is `missing`. It is here so that its wording has one source.
 *
 * `endpointManaged` and `endpointIdReserved` are what the endpoint routes
 * (src/web/routes/custom-model-routes.ts) answer for the record this feature manages and for
 * its reserved id. They have no slot, so the App Settings toast that prints them translates
 * them as it translates every other whole sentence.
 */
export const LOCAL_MODEL_INSTALL_LABELS = {
  errRuntimeDownloadFailed:
    'The download of the runtime stopped and could not be continued. Check the network connection, then try again.',
  errRuntimeDamaged: 'The runtime download was damaged and has been deleted. Try again.',
  errRuntimeUnpackFailed: 'The runtime could not be unpacked on this Mac.',
  errRuntimeStartFailed: 'The runtime did not start on this Mac.',
  errRuntimeStopped: 'The runtime keeps stopping, so Codeman no longer restarts it.',
  errRuntimeNotRunning: 'The model on this Mac is not running. Start it first.',
  errPortInUse: 'Port {port} is in use by another program.',
  errDiskFull: 'The disk is full. Free up space, then try again.',
  errPullFailed: 'The download keeps stopping. The network may be damaging data. Try again or use another network.',
  errModelNotFound: '{model} is no longer offered under this name. Update Codeman or pick another model.',
  errDoesNotFit: '{model} does not fit in the memory of this Mac after all.',
  errContextNotApplied: '{model} loaded with a context of {actual} tokens instead of {wanted}.',
  errLoadFailed: '{model} did not load on this Mac.',
  errNoToolCall: '{model} loaded but did not call a tool, so a coding agent cannot work with it.',
  errProbeUnfinished: 'The check of {model} did not finish.',
  errHarnessFailed: '{cli} could not be installed.',
  errEndpointIdTaken:
    'A saved model connection named {id} already exists and was not created here. Rename or delete it in App Settings, then try again.',
  errConnectFailed: 'Codeman could not save the connection to the model.',
  errModelChanged: 'The model on this Mac changed since it was installed. Remove it and install it again.',
  errJobUnfinished:
    'The model on this Mac is being changed and is not ready. Finish or undo that in the local model window first.',
  errInternal: 'The install stopped on an unexpected error.',
  conflictJobRunning: 'An install is already running.',
  conflictAlreadyInstalled: 'This model is already in use on this Mac.',
  conflictModelActive: '{model} is the model in use. Switch to another model first, or remove the local model.',
  conflictSizeChanged: 'The download is {size} GB now. Check the sizes and confirm again.',
  conflictSessionsOpen: 'Sessions are still using this model: {sessions}. Close them first.',
  conflictWrongState: 'That is not possible in the current state.',
  refusedModelNotOffered: 'This model at this context is not offered for this Mac right now.',
  refusedAgentNotOffered: 'This coding agent is not offered for this model.',
  refusedAgentNotInstallable: '{cli} is not installed and cannot be installed from here.',
  refusedOtherModel: 'Only {model} is in use on this Mac. Switch models in the local model window first.',
  refusedNotInLibrary: 'This model is not one of the checked models on this Mac.',
  refusedNotOnThisMac: 'This model is not on this Mac.',
  deleteFailed: '{model} could not be deleted from this Mac.',
  refusedAgentMissing: '{cli} is not installed on this Mac. Install a coding agent in the local model window first.',
  endpointManaged:
    'This endpoint belongs to the model Codeman runs on this Mac. Change or remove it in the local model window.',
  endpointIdReserved: 'This endpoint id is reserved for the model Codeman runs on this Mac. Pick another id.',
  developerToolsMissing:
    'Coding agents use git and Python. This Mac has no developer tools yet, so macOS will offer to install them the first time an agent needs one.',
} as const;

/** One of the texts in `LOCAL_MODEL_INSTALL_LABELS`. */
export type LocalModelInstallLabel = (typeof LOCAL_MODEL_INSTALL_LABELS)[keyof typeof LOCAL_MODEL_INSTALL_LABELS];

/** A sentence of the install: a text from `LOCAL_MODEL_INSTALL_LABELS` plus the values of its `{placeholder}` slots. */
export interface LocalModelInstallMessage {
  text: LocalModelInstallLabel;
  /** Slot values, already formatted as text. Absent when the text has no slot. */
  vars?: Record<string, string>;
}

/** The sentence of each error code. */
export const LOCAL_MODEL_ERROR_LABELS: Record<LocalModelErrorCode, LocalModelInstallLabel> = {
  'runtime-download-failed': LOCAL_MODEL_INSTALL_LABELS.errRuntimeDownloadFailed,
  'runtime-damaged': LOCAL_MODEL_INSTALL_LABELS.errRuntimeDamaged,
  'runtime-unpack-failed': LOCAL_MODEL_INSTALL_LABELS.errRuntimeUnpackFailed,
  'runtime-start-failed': LOCAL_MODEL_INSTALL_LABELS.errRuntimeStartFailed,
  'runtime-stopped': LOCAL_MODEL_INSTALL_LABELS.errRuntimeStopped,
  'runtime-not-running': LOCAL_MODEL_INSTALL_LABELS.errRuntimeNotRunning,
  'port-in-use': LOCAL_MODEL_INSTALL_LABELS.errPortInUse,
  'disk-full': LOCAL_MODEL_INSTALL_LABELS.errDiskFull,
  'pull-failed': LOCAL_MODEL_INSTALL_LABELS.errPullFailed,
  'model-not-found': LOCAL_MODEL_INSTALL_LABELS.errModelNotFound,
  'does-not-fit': LOCAL_MODEL_INSTALL_LABELS.errDoesNotFit,
  'context-not-applied': LOCAL_MODEL_INSTALL_LABELS.errContextNotApplied,
  'load-failed': LOCAL_MODEL_INSTALL_LABELS.errLoadFailed,
  'no-tool-call': LOCAL_MODEL_INSTALL_LABELS.errNoToolCall,
  'probe-unfinished': LOCAL_MODEL_INSTALL_LABELS.errProbeUnfinished,
  'harness-failed': LOCAL_MODEL_INSTALL_LABELS.errHarnessFailed,
  'endpoint-id-taken': LOCAL_MODEL_INSTALL_LABELS.errEndpointIdTaken,
  'connect-failed': LOCAL_MODEL_INSTALL_LABELS.errConnectFailed,
  'model-changed': LOCAL_MODEL_INSTALL_LABELS.errModelChanged,
  'job-unfinished': LOCAL_MODEL_INSTALL_LABELS.errJobUnfinished,
  internal: LOCAL_MODEL_INSTALL_LABELS.errInternal,
};

/** The one helpful next step of each error code. */
export const LOCAL_MODEL_ERROR_NEXT: Record<LocalModelErrorCode, LocalModelNextStep> = {
  'runtime-download-failed': 'retry',
  'runtime-damaged': 'retry',
  'runtime-unpack-failed': 'retry',
  'runtime-start-failed': 'retry',
  'runtime-stopped': 'start',
  'runtime-not-running': 'start',
  'port-in-use': 'other-port',
  'disk-full': 'retry',
  'pull-failed': 'retry',
  'model-not-found': 'next-model',
  'does-not-fit': 'next-model',
  'context-not-applied': 'retry',
  'load-failed': 'retry',
  'no-tool-call': 'next-model',
  'probe-unfinished': 'retry',
  'harness-failed': 'retry',
  'endpoint-id-taken': 'retry',
  'connect-failed': 'retry',
  'model-changed': 'remove',
  'job-unfinished': 'retry',
  internal: 'retry',
};

// ---------- The `install` object of the GET ----------

/**
 * How far a download is. Present while the `runtime` step downloads the archive and while the
 * `model` step pulls, once the total is known; kept on a paused or failed job as it stood.
 * During the `model` step both byte figures come from the pull's own lines, never from the
 * catalogue.
 */
export interface LocalModelProgress {
  completedBytes: number;
  totalBytes: number;
  /** `completedBytes` as decimal GB text, no unit ('6.2'). */
  completedGb: string;
  /** `totalBytes` as decimal GB text, no unit ('23.1'). */
  totalGb: string;
  /** Download speed. Absent until it can be told (the first moments, a paused job). */
  bytesPerSecond?: number;
  /** `bytesPerSecond` as whole decimal megabytes per second, no unit ('58'). Present exactly when `bytesPerSecond` is. */
  mbPerSecond?: string;
  /** Seconds left at the current speed, rounded up. Absent when the speed is unknown or 0. */
  secondsLeft?: number;
}

/** An error as the window shows it: the sentence, the one action that helps, and the raw detail. */
export interface LocalModelInstallError {
  code: LocalModelErrorCode;
  /** `LOCAL_MODEL_ERROR_LABELS[code]` with its slots filled. */
  message: LocalModelInstallMessage;
  /** `LOCAL_MODEL_ERROR_NEXT[code]`, adapted to the state the error is shown in (see `LocalModelNextStep`). */
  next: LocalModelNextStep;
  /**
   * For `next-model`: the model to try instead. After `does-not-fit` it is one that needs LESS
   * memory than the one that failed; after the other codes the best other model that fits.
   * Absent when there is none.
   */
  nextModel?: { modelId: string; modelLabel: string };
  /**
   * Raw text for the person who wants to know more: the last lines of an installer, the
   * message of a refused write, an exception. Not translated; printed with `textContent`.
   */
  detail?: string;
}

/** The model of the job or of the installation. */
export interface LocalModelInstalledModel {
  /** `LocalModelEntry.id`. */
  id: string;
  /** `LocalModelEntry.label`. */
  label: string;
}

/** The runtime, as the consent screen needs it. */
export interface LocalModelRuntimeView {
  /** `LocalModelRuntimePin.version`. */
  version: string;
  /** The pinned runtime is unpacked on disk. Then an install downloads only the model. */
  installed: boolean;
  /** What an install would download for the runtime: the archive size, 0 when `installed`. */
  downloadBytes: number;
  /** `downloadBytes` as decimal GB text, no unit ('0.2'). */
  downloadGb: string;
  /** What the unpacked runtime takes on disk, as decimal GB text, no unit ('0.6'). */
  unpackedGb: string;
}

/** What the runtime reported about the loaded model when the job checked it. The facts of the Done line. */
export interface LocalModelLoadedFacts {
  /** The context length in tokens the runtime loaded the model with. */
  context: number;
  /** Memory the loaded model took, in bytes (`size` of the runtime's process list). */
  memoryBytes: number;
  /** `memoryBytes` as decimal GB text, no unit. */
  memoryGb: string;
  /** All of it is on the GPU (`size_vram` equals `size`). Always true after a job that passed. */
  onGpu: boolean;
}

/**
 * The `install` object of `GET /api/local-model`: where the install stands and what can be
 * done about it. The window polls it once a second while it is open; there is no SSE event.
 *
 * Which members are present, by state:
 *
 * | Member                            | idle | installing | paused | failed | installed |
 * |-----------------------------------|------|------------|--------|--------|-----------|
 * | `step`, `steps`                   |      | yes        | yes    | yes    |           |
 * | `progress`                        |      | during a download | as it stood, when known | as it stood, when known | |
 * | `error`                           |      |            |        | yes    | only when something blocks a session |
 * | `model`, `cli`, `cliLabel`, `context` |  | yes        | yes    | yes    | yes       |
 * | `port`                            |      | once chosen | once chosen | once chosen | yes |
 * | `loaded`, `endpointId`            |      |            |        |        | yes       |
 *
 * `running`, `developerTools`, `runtime`, `folder`, `library`, `harnesses` and `actions` are
 * always present. `store` is present once the model store was measured. `harnesses` is empty
 * in every state but `installed`.
 */
export interface LocalModelInstallView {
  state: LocalModelInstallState;
  /** The step the job is in, or stopped in. */
  step?: LocalModelInstallStep;
  /** The steps of THIS job in order, for the step list (`agent` is absent when the coding agent was already installed). */
  steps?: LocalModelInstallStep[];
  progress?: LocalModelProgress;
  error?: LocalModelInstallError;
  model?: LocalModelInstalledModel;
  /**
   * The coding agent of the job, and on an installed model the DEFAULT one: the agent it was
   * installed with, which a client that names no agent starts. A CLI registry id, as data.
   * `harnesses` lists every agent a session can be started with.
   */
  cli?: string;
  /** The coding agent's display label ('OpenCode'). */
  cliLabel?: string;
  /** The context length in tokens the runtime is started with. */
  context?: number;
  /** The loopback port of the runtime. */
  port?: number;
  /** The runtime child Codeman started is alive right now. */
  running: boolean;
  developerTools: LocalModelDeveloperTools;
  runtime: LocalModelRuntimeView;
  /** The absolute folder everything of this feature is kept in, for the "where it goes" line. */
  folder: string;
  loaded?: LocalModelLoadedFacts;
  /** The id of the saved endpoint a session is started on. */
  endpointId?: string;
  /**
   * The models on this Mac: every model Codeman checked (`LocalModelStateFile.library`), plus
   * whatever else the running runtime lists. Empty in `idle` (no runtime is there to ask) and
   * before anything was downloaded. The model in use comes first.
   */
  library: LocalModelLibraryRow[];
  /** What the model store takes on disk right now. Present in every state once it was measured. */
  store?: LocalModelStoreView;
  /**
   * The coding agents a session on the model in use can be started with: every catalogue
   * harness that works at the model's context and accepts its name, the default one (`cli`)
   * first, then by catalogue rank. The agent is chosen per session, so a row is not a setting.
   * Empty in every state but `installed`.
   */
  harnesses: LocalModelHarnessRow[];
  /** What the server accepts right now, see `LocalModelAction`. */
  actions: LocalModelAction[];
}

/**
 * How a coding agent of `harnesses` stands on this Mac.
 *  - `ready`: it can be started (the same answer the Run menu gets).
 *  - `installable`: it is not on this Mac, and `POST /api/local-model/agent` installs it with
 *    `installCommand`.
 *  - `installing`: that install is running. It runs beside the model: nothing about the model
 *    in use changes, and a session with another agent can be started meanwhile.
 *  - `setup-needed`: it is not startable and one command does not make it so (a launcher
 *    without a profile, or a command that needs an administrator). Its own setup is in the Run
 *    menu or in a terminal; nothing is offered here.
 */
export type LocalModelHarnessStatus = 'ready' | 'installable' | 'installing' | 'setup-needed';

/** What can be done with one row of `harnesses`: start a session with it, or `POST /api/local-model/agent`. */
export type LocalModelHarnessAction = 'start-session' | 'install';

/** One coding agent the model in use can be run with. Everything a client needs is here, so it compares no CLI id. */
export interface LocalModelHarnessRow {
  /** The CLI registry id, as data: the `mode` of a session started with it, and the `cli` of `POST /api/local-model/agent`. */
  cli: string;
  /** The registry's display label ('OpenCode'). */
  cliLabel: string;
  /** True on the row `LocalModelInstallView.cli` names. */
  default: boolean;
  status: LocalModelHarnessStatus;
  /**
   * The literal command `POST /api/local-model/agent` would run: the STOCK command of the CLI
   * registry for this platform. Present exactly when `status` is `installable` or `installing`.
   * The consent prints it as it is.
   */
  installCommand?: string;
  /** The harness row's `slowFirstTurn`: the first answer takes minutes. */
  slowFirstTurn?: boolean;
  /**
   * A literal with no white space the agent's composer draws once it takes input
   * (`LocalHarnessEntry.readyMark`, else the CLI registry's `composerReadyMark`): what a script
   * waits for on `GET /api/sessions/:id/wait-output` before it sends the first prompt. Absent
   * for an agent with no measured mark.
   */
  readyMark?: string;
  /**
   * The last install of this agent through `POST /api/local-model/agent` failed, and it is
   * still not on this Mac. Kept in memory only: a restart of the server forgets it.
   */
  error?: LocalModelAgentError;
  /** What the server accepts for this row right now. */
  actions: LocalModelHarnessAction[];
}

/** Why an install of a coding agent from an installed model failed. */
export interface LocalModelAgentError {
  /** `errHarnessFailed` with the agent's label. */
  message: LocalModelInstallMessage;
  /** The end of what the installer printed, as it is (English or the tool's own language). */
  detail?: string;
}

/**
 * How a model of the library stands.
 *  - `ready`: checked by Codeman, and the runtime (when it was asked) still lists it with the
 *    digest that was stored.
 *  - `changed`: checked, but the runtime now lists another digest under the name. It is never
 *    started: `use` would fail with `model-changed`.
 *  - `missing`: checked, but the runtime no longer lists it (something deleted it through the
 *    runtime's port).
 *  - `unverified`: the runtime lists it and Codeman never checked it: a model an earlier
 *    Remove kept, the model of a job that has not passed its check yet, or one another program
 *    pulled through the runtime's port. Never startable.
 */
export type LocalModelLibraryStatus = 'ready' | 'changed' | 'missing' | 'unverified';

/** What can be done with one row of `library`: `POST /api/local-model/use` and `DELETE /api/local-model/models`. */
export type LocalModelLibraryAction = 'use' | 'delete';

/** One model on this Mac. */
export interface LocalModelLibraryRow {
  /** The model's name exactly as the runtime lists it (`name:tag`). */
  id: string;
  /** Its catalogue label, or `id` for a model the catalogue does not know. */
  label: string;
  /** The context it was checked with. Absent for an `unverified` row. */
  context?: number;
  /** Its size on disk: what the runtime reports, else what was recorded when it was checked. */
  sizeBytes?: number;
  /** `sizeBytes` as decimal GB text, no unit. Present exactly when `sizeBytes` is. */
  sizeGb?: string;
  /** It is the model in use: the one of an `installed` state. */
  active: boolean;
  /** Codeman checked it (`LocalModelStateFile.library` holds it). */
  verified: boolean;
  status: LocalModelLibraryStatus;
  /** What the server accepts for this row right now. `delete` needs the running runtime. */
  actions: LocalModelLibraryAction[];
}

/** The disk use of the model store: the files directly in its blob folder, summed. */
export interface LocalModelStoreView {
  bytes: number;
  /** `bytes` as decimal GB text, no unit. */
  gb: string;
}

/** The `data` of `GET /api/local-model`. Admin only in multi-user mode. */
export interface LocalModelStatus {
  hardware: HardwareFacts;
  recommendation: Recommendation;
  /** `LocalModelCatalog.updated`. */
  catalogUpdated: string;
  /** Where the install stands. Always present. */
  install: LocalModelInstallView;
}

// ---------- Request bodies and answers ----------

/**
 * Body of `POST /api/local-model/install`. The three choices must name a row the server offers
 * right now: a model of `recommendation.pick` or `recommendation.alternatives`, at that
 * candidate's `context`, with one of its `harnesses`. Anything else is a 400 before any
 * download.
 */
export interface LocalModelInstallRequest {
  /** `Candidate.modelId`. */
  modelId: string;
  /** `CandidateHarness.cli`. */
  cli: string;
  /** `Candidate.context`. */
  context: number;
  /**
   * The total the person saw and confirmed: `Candidate.installBytes`. The server compares it
   * with its own total and answers 409 `size-changed` when they differ, so a consent is bound
   * to the size that was shown.
   */
  acknowledgedBytes: number;
}

/** Body of `POST /api/local-model/resume`. May be absent or empty. */
export interface LocalModelResumeRequest {
  /** True: choose another port first (the answer to `port-in-use`). */
  newPort?: boolean;
}

/** Body of `POST /api/local-model/runtime`. */
export interface LocalModelRuntimeRequest {
  /** `stop` also keeps the runtime from being started at the next boot; `start` undoes that. */
  action: 'start' | 'stop';
  /** With `start`: choose another port first (the answer to `port-in-use`), and move the saved endpoint to it. */
  newPort?: boolean;
}

/** Body of `DELETE /api/local-model`. May be absent or empty. */
export interface LocalModelRemoveRequest {
  /** True: delete the downloaded model too. Default false: the model stays for a later install. */
  removeModel?: boolean;
}

/** Body of `POST /api/local-model/use`: a checked model of `library` to switch to. Nothing is downloaded. */
export interface LocalModelUseRequest {
  /** `LocalModelLibraryRow.id` of a row whose `actions` list `use`. */
  modelId: string;
}

/** Body of `DELETE /api/local-model/models`: one model to delete from the store. */
export interface LocalModelDeleteRequest {
  /** `LocalModelLibraryRow.id` of a row whose `actions` list `delete`. Never a path. */
  modelId: string;
}

/**
 * Body of `POST /api/local-model/agent`: a coding agent of `harnesses` to install beside an
 * installed model. The click that sends it is the consent to the row's `installCommand`.
 */
export interface LocalModelAgentRequest {
  /** `LocalModelHarnessRow.cli` of a row whose `actions` list `install`. */
  cli: string;
}

/** The `data` of a 400 the service names: its sentence, for the window to print in its own language. */
export interface LocalModelRefusal {
  message: LocalModelInstallMessage;
}

/** What every verb answers on success: the view after the verb. */
export type LocalModelVerbAnswer = LocalModelInstallView;

/**
 * Why a verb was refused with 409.
 *  - `job-running`: a job is running (a second install, a resume, a remove or a runtime action).
 *  - `already-installed`: install or use of the model that is already the one in use (at the
 *    same context).
 *  - `size-changed`: `acknowledgedBytes` is not the server's total; `expectedBytes` and
 *    `expectedGb` carry that total, so the window can show it and ask again.
 *  - `sessions-open`: remove, stop, a change of port, an install of another model or a switch
 *    while live sessions use the endpoint; `sessions` names them. Their coding agents were
 *    given the runtime's address and the model's name when they started, so they would go on
 *    calling a port nothing of ours holds, or make the runtime swap models on every request.
 *  - `wrong-state`: the verb makes no sense in the current state (see the route table above).
 *  - `model-active`: a delete of the model the installation or the current job is about.
 *  - `runtime-not-running`: a delete while the runtime is down: only the runtime deletes a model.
 */
export type LocalModelConflictReason =
  | 'job-running'
  | 'already-installed'
  | 'size-changed'
  | 'sessions-open'
  | 'wrong-state'
  | 'model-active'
  | 'runtime-not-running';

/** The `data` of a 409 of an install verb. */
export interface LocalModelConflict {
  reason: LocalModelConflictReason;
  /** The sentence for the window (`conflict...` of `LOCAL_MODEL_INSTALL_LABELS`). */
  message: LocalModelInstallMessage;
  /** `size-changed`: the server's own total in bytes. */
  expectedBytes?: number;
  /** `size-changed`: `expectedBytes` as decimal GB text, no unit. */
  expectedGb?: string;
  /** `sessions-open`: the names of the live sessions that use the endpoint. */
  sessions?: string[];
}

// ---------- The state file ----------

/**
 * `local-model.json` in the data dir: everything that must survive a restart. Mode 0600,
 * written through a temp file and a rename, by src/local-model/state-store.ts alone.
 *
 * Rules:
 *  - It holds NO path. Every path of this feature is built from `dataPath()` constants
 *    (`localModelPaths()`), so a state file can never point a delete somewhere else.
 *  - Reading is total: a missing file, a file that does not parse or one with another `schema`
 *    reads as `{ schema: 1, state: 'idle' }`.
 *  - A file read at boot with state `installing` is a job a restart interrupted: it becomes
 *    `paused` before anything else looks at it.
 */
export interface LocalModelStateFile {
  schema: 1;
  state: LocalModelInstallState;
  /** The step the job is in or stopped in. Absent in `idle` and `installed`. */
  step?: LocalModelInstallStep;
  /** The steps of the job, in order. Absent in `idle` and `installed`. */
  steps?: LocalModelInstallStep[];
  /** State `failed`: why. State `installed`: absent (a blocking problem is found live, never stored). */
  error?: {
    code: LocalModelErrorCode;
    /** The slot values of the code's sentence. */
    vars?: Record<string, string>;
    detail?: string;
    /** For a `next-model` code: the model to offer, when the job knew one. */
    nextModelId?: string;
  };
  /** The model of the job or of the installation. */
  model?: {
    id: string;
    label: string;
    /** The context length in tokens the person chose. */
    context: number;
    /** The total the pull reported, once known. */
    pullBytes?: number;
    /** The digest `/api/tags` reported after the pull. Compared again at boot and before a session starts. */
    digest?: string;
  };
  /**
   * The model of the job this one replaced, when it was another model: what that job left in
   * the model store is deleted once the runtime runs, before the new model is downloaded.
   * Absent once that was done, and in `idle` and `installed`.
   */
  replacedModelId?: string;
  /** The coding agent of the job or of the installation. */
  cli?: { id: string; label: string };
  /** The runtime, once its port was chosen. */
  runtime?: {
    /**
     * The runtime version this installation runs. A later build with another pin keeps
     * starting this version for as long as its folder is unpacked.
     */
    version: string;
    /** The loopback port, chosen once by binding. */
    port: number;
    /**
     * The pid of the child Codeman last started, stored the moment it is spawned. Used to
     * tell our own runtime from another program: at boot, and before the folder is deleted.
     */
    pid?: number;
    /** False after Stop: the runtime is not started at boot. */
    enabled: boolean;
    /** The device total the runtime printed when it started, in bytes. */
    measuredTotalBytes?: number;
  };
  /** How far the last download was when the job paused or failed. A restart may leave it absent. */
  progress?: { completedBytes: number; totalBytes: number };
  /** What the runtime reported when the job checked the loaded model. */
  loaded?: { context: number; sizeBytes: number; sizeVramBytes: number };
  /**
   * Every model that PASSED the check through Codeman and is believed to be in the store, the
   * model in use among them. An entry is written when the `verify` step passes and dropped
   * when the model is deleted; `remove` drops the whole list. An `installed` file an earlier
   * build wrote has none: its one model then counts as the library (`libraryOf()` in
   * src/local-model/install-job.ts).
   */
  library?: LocalModelLibraryEntry[];
  /**
   * Present once the `connect` step CLAIMED the connection, which it does before its two
   * writes: what uninstall must undo. A claim with nothing behind it (the step was interrupted
   * right after it) is harmless: a resumed job writes both, and uninstall removes nothing.
   */
  connection?: {
    /** The id of the endpoint record this feature wrote. */
    endpointId: string;
    /** The value `customModelEndpointsEnabled` had before this feature switched it on. */
    flagWasEnabled: boolean;
  };
  /** ISO time of the last write. */
  updatedAt?: string;
}

/** One checked model of `LocalModelStateFile.library`. It holds no path. */
export interface LocalModelLibraryEntry {
  id: string;
  label: string;
  /** The context length in tokens it was checked with. */
  context: number;
  /** The digest `/api/tags` reported when it passed the check. A switch to it must find the same one. */
  digest: string;
  /** Its size on disk as the runtime reported it then, for a listing while the runtime is stopped. */
  bytes?: number;
  /** The coding agent of the job that checked it. A switch back takes it when it is installed. */
  cli?: { id: string; label: string };
  /** ISO time of the check. */
  verifiedAt?: string;
}
