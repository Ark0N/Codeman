/**
 * @fileoverview The ONE reader and writer of `local-model.json`, the state file of the local
 * model install (`LocalModelStateFile`).
 *
 * Why one module: the install job writes the state, the step and the digest, and the caller
 * of the runtime supervisor writes the pid and the port. Two writers with their own temp file
 * and rename would lose each other's change, which is the fault `mutateCustomModelHosts()`
 * exists to end for the endpoint store. So every write goes through `mutateLocalModelState()`.
 *
 * The shape of `mutateSettingsFile()` (src/web/settings-writer.ts):
 *  - Serialized: mutations run one at a time on one promise chain.
 *  - Atomic: each write goes to a temp file with a random name beside the target and is
 *    renamed over it. The file is mode 0600.
 *  - Reading is TOTAL, unlike the settings writer: the file holds no setting of the user, only
 *    what this feature recorded, so a missing file, one that does not parse or one with
 *    another `schema` reads as `IDLE_LOCAL_MODEL_STATE` and the next write replaces it.
 *  - The path is `localModelPaths().stateFile`. The file itself holds no path.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  LOCAL_MODEL_ERROR_LABELS,
  LOCAL_MODEL_INSTALL_STEPS,
  type LocalModelErrorCode,
  type LocalModelInstallState,
  type LocalModelInstallStep,
  type LocalModelLibraryEntry,
  type LocalModelStateFile,
} from '../types.js';
import { OLLAMA_RUNTIME_PIN } from './runtime.js';
import { localModelPaths } from './paths.js';

/** The state when nothing was ever installed. What an unreadable file reads as. */
export const IDLE_LOCAL_MODEL_STATE: LocalModelStateFile = Object.freeze({ schema: 1, state: 'idle' });

const STATES: readonly LocalModelInstallState[] = ['idle', 'installing', 'paused', 'failed', 'installed'];

// ---------- Reading one member at a time ----------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, max = 4_096): string | undefined =>
  typeof value === 'string' && value !== '' && value.length <= max ? value : undefined;

/** A whole number of bytes, tokens, a port or a pid: finite, not negative, and an integer. */
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const step = (value: unknown): LocalModelInstallStep | undefined =>
  LOCAL_MODEL_INSTALL_STEPS.find((candidate) => candidate === value);

function parseSteps(value: unknown): LocalModelInstallStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: LocalModelInstallStep[] = [];
  for (const item of value) {
    const parsed = step(item);
    // A list with an unknown or a repeated step is not a list this build wrote.
    if (!parsed || steps.includes(parsed)) return undefined;
    steps.push(parsed);
  }
  return steps.length > 0 ? steps : undefined;
}

function parseVars(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const vars: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.length <= 4_096) vars[key] = item;
  }
  return Object.keys(vars).length > 0 ? vars : undefined;
}

function parseError(value: unknown): LocalModelStateFile['error'] {
  if (!isRecord(value)) return undefined;
  const code = text(value.code);
  if (!code || !Object.prototype.hasOwnProperty.call(LOCAL_MODEL_ERROR_LABELS, code)) return undefined;
  const vars = parseVars(value.vars);
  const detail = text(value.detail, 16_384);
  const nextModelId = text(value.nextModelId, 200);
  return {
    code: code as LocalModelErrorCode,
    ...(vars ? { vars } : {}),
    ...(detail ? { detail } : {}),
    ...(nextModelId ? { nextModelId } : {}),
  };
}

function parseModel(value: unknown): LocalModelStateFile['model'] {
  if (!isRecord(value)) return undefined;
  const id = text(value.id, 200);
  const label = text(value.label, 200);
  const context = count(value.context);
  if (!id || !label || !context) return undefined;
  const pullBytes = count(value.pullBytes);
  const digest = text(value.digest, 200);
  return {
    id,
    label,
    context,
    ...(pullBytes !== undefined ? { pullBytes } : {}),
    ...(digest ? { digest } : {}),
  };
}

function parseCli(value: unknown): LocalModelStateFile['cli'] {
  if (!isRecord(value)) return undefined;
  const id = text(value.id, 200);
  const label = text(value.label, 200);
  return id && label ? { id, label } : undefined;
}

function parseRuntime(value: unknown): LocalModelStateFile['runtime'] {
  if (!isRecord(value)) return undefined;
  const version = text(value.version, 64);
  const port = count(value.port);
  if (!version || !port || port > 65_535) return undefined;
  const pid = count(value.pid);
  const measuredTotalBytes = count(value.measuredTotalBytes);
  return {
    version,
    port,
    ...(pid ? { pid } : {}),
    // Anything but an explicit `false` reads as enabled: only Stop switches the runtime off.
    enabled: value.enabled !== false,
    ...(measuredTotalBytes ? { measuredTotalBytes } : {}),
  };
}

function parseProgress(value: unknown): LocalModelStateFile['progress'] {
  if (!isRecord(value)) return undefined;
  const completedBytes = count(value.completedBytes);
  const totalBytes = count(value.totalBytes);
  return completedBytes !== undefined && totalBytes !== undefined ? { completedBytes, totalBytes } : undefined;
}

function parseLoaded(value: unknown): LocalModelStateFile['loaded'] {
  if (!isRecord(value)) return undefined;
  const context = count(value.context);
  const sizeBytes = count(value.sizeBytes);
  const sizeVramBytes = count(value.sizeVramBytes);
  return context !== undefined && sizeBytes !== undefined && sizeVramBytes !== undefined
    ? { context, sizeBytes, sizeVramBytes }
    : undefined;
}

function parseConnection(value: unknown): LocalModelStateFile['connection'] {
  if (!isRecord(value)) return undefined;
  const endpointId = text(value.endpointId, 200);
  return endpointId && typeof value.flagWasEnabled === 'boolean'
    ? { endpointId, flagWasEnabled: value.flagWasEnabled }
    : undefined;
}

/** How many checked models a state file may list: far more than one Mac holds, and a bound on what a damaged file can cost. */
const MAX_LIBRARY_ENTRIES = 64;

/**
 * The checked models of a file. An entry without its id, label, context or digest is dropped
 * (it could never be switched to), and so is a second entry for an id. `undefined` for a file
 * that has no list, which is what an earlier build wrote.
 */
function parseLibrary(value: unknown): LocalModelLibraryEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: LocalModelLibraryEntry[] = [];
  for (const item of value) {
    if (entries.length >= MAX_LIBRARY_ENTRIES) break;
    if (!isRecord(item)) continue;
    const id = text(item.id, 200);
    const label = text(item.label, 200);
    const context = count(item.context);
    const digest = text(item.digest, 200);
    if (!id || !label || !context || !digest || entries.some((entry) => entry.id === id)) continue;
    const bytes = count(item.bytes);
    const cli = parseCli(item.cli);
    const verifiedAt = text(item.verifiedAt, 64);
    entries.push({
      id,
      label,
      context,
      digest,
      ...(bytes ? { bytes } : {}),
      ...(cli ? { cli } : {}),
      ...(verifiedAt ? { verifiedAt } : {}),
    });
  }
  return entries;
}

/**
 * The state a file's text stands for. Pure and total: text that is not a JSON object of
 * `schema: 1` with a known `state` is `IDLE_LOCAL_MODEL_STATE`. Members it does not know are
 * dropped, and a member of the wrong type is dropped rather than trusted.
 *
 * A state that needs a member it does not have is not trusted either: a job (`installing`,
 * `paused`, `failed`) without its model, its coding agent or its step, a `failed` job without
 * its error, and an `installed` state without its model or its runtime all read as idle.
 * Nothing is deleted by that: what lies in the folder stays until a Remove or a new install.
 */
export function parseLocalModelState(raw: string): LocalModelStateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return IDLE_LOCAL_MODEL_STATE;
  }
  if (!isRecord(parsed) || parsed.schema !== 1) return IDLE_LOCAL_MODEL_STATE;
  const state = STATES.find((candidate) => candidate === parsed.state);
  if (!state || state === 'idle') return IDLE_LOCAL_MODEL_STATE;

  const model = parseModel(parsed.model);
  const cli = parseCli(parsed.cli);
  const runtime = parseRuntime(parsed.runtime);
  const connection = parseConnection(parsed.connection);
  const updatedAt = text(parsed.updatedAt, 64);
  const replacedModelId = text(parsed.replacedModelId, 200);
  const library = parseLibrary(parsed.library);
  if (!model || !cli) return IDLE_LOCAL_MODEL_STATE;

  if (state === 'installed') {
    if (!runtime) return IDLE_LOCAL_MODEL_STATE;
    const loaded = parseLoaded(parsed.loaded);
    return {
      schema: 1,
      state,
      model,
      cli,
      runtime,
      ...(loaded ? { loaded } : {}),
      ...(library ? { library } : {}),
      ...(connection ? { connection } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  const steps = parseSteps(parsed.steps);
  const current = step(parsed.step);
  if (!steps || !current || !steps.includes(current)) return IDLE_LOCAL_MODEL_STATE;
  const error = parseError(parsed.error);
  if (state === 'failed' && !error) return IDLE_LOCAL_MODEL_STATE;
  const progress = parseProgress(parsed.progress);
  const loaded = parseLoaded(parsed.loaded);
  return {
    schema: 1,
    state,
    step: current,
    steps,
    ...(state === 'failed' && error ? { error } : {}),
    model,
    cli,
    ...(runtime ? { runtime } : {}),
    ...(progress ? { progress } : {}),
    ...(loaded ? { loaded } : {}),
    ...(library ? { library } : {}),
    ...(connection ? { connection } : {}),
    ...(replacedModelId ? { replacedModelId } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** Where the state file is. Built from `dataPath()` on every call, so a test's own data dir is honoured. */
function stateFilePath(): string {
  return localModelPaths(OLLAMA_RUNTIME_PIN.version).stateFile;
}

async function readStateFrom(path: string): Promise<LocalModelStateFile> {
  try {
    return parseLocalModelState(await fs.readFile(path, 'utf-8'));
  } catch {
    return IDLE_LOCAL_MODEL_STATE;
  }
}

/** The stored state. Never throws: a file that cannot be read is `IDLE_LOCAL_MODEL_STATE`. */
export async function readLocalModelState(): Promise<LocalModelStateFile> {
  return readStateFrom(stateFilePath());
}

async function writeStateFile(path: string, state: LocalModelStateFile): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

let mutationChain: Promise<unknown> = Promise.resolve();

/**
 * Runs one change to the state file. `fn` receives the current state and returns the state to
 * write, or `undefined` to write nothing. Resolves with the state before and after the change
 * (`after` is `undefined` when nothing was written). `updatedAt` is stamped here. A failed
 * write rejects its own caller only; the chain keeps going.
 */
export function mutateLocalModelState(
  fn: (current: LocalModelStateFile) => LocalModelStateFile | undefined
): Promise<{ before: LocalModelStateFile; after: LocalModelStateFile | undefined }> {
  const run = mutationChain.then(async () => {
    const path = stateFilePath();
    const before = await readStateFrom(path);
    const next = fn(before);
    if (!next) return { before, after: undefined };
    const after: LocalModelStateFile = { ...next, updatedAt: new Date().toISOString() };
    await writeStateFile(path, after);
    return { before, after };
  });
  mutationChain = run.catch(() => {});
  return run;
}
