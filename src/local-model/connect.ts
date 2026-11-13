/**
 * @fileoverview Connecting the installed local model to Codeman, and undoing it: the endpoint
 * record, the settings flag, and the checks around them.
 *
 * These are the ONLY two writes of the local model outside its own folder:
 *  1. One record in `custom-model-hosts.json`, through `mutateCustomModelHosts()`:
 *     `{ id: 'local-ollama', label: 'This Mac', baseUrl: 'http://127.0.0.1:<port>',
 *     authStyle: 'bearer', models: [<id as /v1/models lists it>], defaultModelId,
 *     defaultContextLength: <the chosen context> }`, validated by `CustomModelHostSchema`
 *     before it is written. No `apiKey`. `defaultContextLength` is what reaches the coding
 *     agent as its context limit, because the runtime's model listing states none.
 *  2. `customModelEndpointsEnabled: true` in `settings.json`, through `mutateSettingsFile()`.
 *     The value it had before is returned and kept in the state file.
 *
 * Rules:
 *  - The id is reserved. A record with it that this feature did not write is never
 *    overwritten: the connect step fails with `endpoint-id-taken`.
 *  - The connection is CLAIMED before it is written: the install job records `connection` in
 *    the state file first (`inspectLocalEndpoint()` tells it what is there and what the flag
 *    is), then calls `connectLocalModel()` with `ours: true`. A state write that fails, or a
 *    server that is killed between the two, therefore never leaves a record of ours that the
 *    state file does not know: the worst case is a claim with nothing behind it, which a
 *    resumed job fills in and Remove undoes.
 *  - Second net: a record with the reserved id that already says exactly what ours would say
 *    (`isSameLocalEndpoint()`) is ours whatever `ours` says. Nobody else can have made it: the
 *    endpoint routes refuse the reserved id.
 *  - Both writes are idempotent, so a resumed job writes them again.
 *  - Undoing removes our record, and switches the flag off again only when this feature
 *    switched it on AND no other endpoint is saved.
 *  - The model's digest is compared again before a session starts and at boot
 *    (`compareModelDigest()`): a model that changed under the same name is not launched.
 *  - The record is MANAGED while the state file records it as ours (`isManagedLocalEndpoint()`):
 *    the endpoint routes then refuse to edit or delete it and the discovery sweep leaves it
 *    alone, so its `models` stays the one model the install job checked.
 */

import { mutateCustomModelHosts } from '../custom-model-hosts-writer.js';
import type { CustomModelHost } from '../custom-model-hosts.js';
import { getDataDir } from '../config/instance.js';
import { readCustomModelHosts } from '../custom-model-hosts.js';
import { getErrorMessage, type LocalModelErrorCode } from '../types.js';
import { readJsonConfig, SETTINGS_PATH } from '../web/route-helpers.js';
import { CustomModelHostSchema } from '../web/schemas.js';
import { mutateSettingsFile } from '../web/settings-writer.js';
import { readLocalModelState } from './state-store.js';

/** The key of the settings flag that shows saved endpoints in the Run menu and runs the discovery sweep. */
const ENDPOINTS_FLAG = 'customModelEndpointsEnabled';

/** The id of the endpoint record this feature writes. Reserved: nobody else may use it. */
export const LOCAL_MODEL_ENDPOINT_ID = 'local-ollama';
/** The label of that record, what the Run menu shows in brackets. */
export const LOCAL_MODEL_ENDPOINT_LABEL = 'This Mac';

/** What the endpoint record is built from. */
export interface LocalEndpointInput {
  /** The runtime's loopback port. */
  port: number;
  /** The model id exactly as the runtime's `/v1/models` lists it. */
  modelId: string;
  /** The chosen context length in tokens. */
  context: number;
}

/** The endpoint record of the file header. Pure; the caller validates it with `CustomModelHostSchema`. */
export function buildLocalEndpointRecord(input: LocalEndpointInput): CustomModelHost {
  return {
    id: LOCAL_MODEL_ENDPOINT_ID,
    label: LOCAL_MODEL_ENDPOINT_LABEL,
    baseUrl: `http://127.0.0.1:${input.port}`,
    authStyle: 'bearer',
    models: [input.modelId],
    defaultModelId: input.modelId,
    defaultContextLength: input.context,
  };
}

/**
 * Whether a saved record says exactly what our record for `input` says: the same address, the
 * one model, its context, no key. What discovery may have added to it (context lengths, a
 * time stamp) does not count. Pure.
 */
export function isSameLocalEndpoint(host: CustomModelHost, input: LocalEndpointInput): boolean {
  const ours = buildLocalEndpointRecord(input);
  return (
    host.id === ours.id &&
    host.label === ours.label &&
    host.baseUrl === ours.baseUrl &&
    host.authStyle === ours.authStyle &&
    host.apiKey === undefined &&
    Array.isArray(host.models) &&
    host.models.length === 1 &&
    host.models[0] === input.modelId &&
    host.defaultModelId === ours.defaultModelId &&
    host.defaultContextLength === ours.defaultContextLength
  );
}

/** What the connect step finds before it claims the connection. */
export interface LocalEndpointInspection {
  /**
   * The saved record with the reserved id: there is none, it says what ours would say, or it
   * says something else (somebody else's: `endpoint-id-taken`).
   */
  record: 'absent' | 'same' | 'other';
  /** `customModelEndpointsEnabled` right now: what the claim keeps as the value before this feature. */
  flagEnabled: boolean;
}

/**
 * Looks at the endpoint store and the settings flag WITHOUT writing either. The install job
 * calls it before it claims the connection in the state file. Rejects when the endpoint store
 * cannot be read; a settings file that cannot be read counts as "the flag is off".
 */
export async function inspectLocalEndpoint(input: LocalEndpointInput): Promise<LocalEndpointInspection> {
  const hosts = await readCustomModelHosts(getDataDir());
  const existing = hosts.find((host) => host.id === LOCAL_MODEL_ENDPOINT_ID);
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});
  return {
    record: !existing ? 'absent' : isSameLocalEndpoint(existing, input) ? 'same' : 'other',
    flagEnabled: settings[ENDPOINTS_FLAG] === true,
  };
}

export interface ConnectLocalModelInput extends LocalEndpointInput {
  /**
   * True when the state file already records a connection of ours: an existing record with
   * our id is then ours and is replaced. False: such a record is somebody else's, unless it
   * says exactly what ours would say (`isSameLocalEndpoint()`).
   */
  ours: boolean;
  /**
   * The flag's value before this feature first switched it on, when the state file already
   * holds one. It is handed back unchanged, so a second connect cannot overwrite it with `true`.
   */
  flagWasEnabled?: boolean;
}

/** How the connect step ended. */
export type ConnectResult =
  | {
      ok: true;
      /** The value `customModelEndpointsEnabled` had before this feature switched it on. */
      flagWasEnabled: boolean;
    }
  | { ok: false; code: Extract<LocalModelErrorCode, 'endpoint-id-taken' | 'connect-failed'>; detail?: string };

/**
 * Writes the record and the flag. Idempotent. Never throws: a refused write is `connect-failed`
 * with its message as `detail`.
 *
 * The record goes first, with the "is the id free" check in the same serialized step as the
 * write, so a record that is somebody else's is found before anything is changed. Should the
 * flag then fail to save, a record this call ADDED is taken out again: the pair is never left
 * half done, and a later attempt starts from the same place.
 */
export async function connectLocalModel(input: ConnectLocalModelInput): Promise<ConnectResult> {
  const parsed = CustomModelHostSchema.safeParse(buildLocalEndpointRecord(input));
  if (!parsed.success) {
    return { ok: false, code: 'connect-failed', detail: `The endpoint record is not valid: ${parsed.error.message}` };
  }
  const record: CustomModelHost = parsed.data;

  let outcome: 'added' | 'replaced' | 'taken';
  try {
    outcome = await mutateCustomModelHosts<'added' | 'replaced' | 'taken'>((hosts) => {
      const index = hosts.findIndex((host) => host.id === record.id);
      if (index === -1) return { hosts: [...hosts, record], result: 'added' };
      if (!input.ours && !isSameLocalEndpoint(hosts[index], input)) return { result: 'taken' };
      const next = [...hosts];
      next[index] = record;
      return { hosts: next, result: 'replaced' };
    });
  } catch (err) {
    return { ok: false, code: 'connect-failed', detail: getErrorMessage(err) };
  }
  if (outcome === 'taken') return { ok: false, code: 'endpoint-id-taken' };

  let flagBefore: boolean;
  try {
    const { before } = await mutateSettingsFile((current) =>
      current[ENDPOINTS_FLAG] === true ? undefined : { ...current, [ENDPOINTS_FLAG]: true }
    );
    flagBefore = before[ENDPOINTS_FLAG] === true;
  } catch (err) {
    if (outcome === 'added') await removeLocalEndpoint().catch(() => {});
    return { ok: false, code: 'connect-failed', detail: getErrorMessage(err) };
  }
  return { ok: true, flagWasEnabled: input.flagWasEnabled ?? flagBefore };
}

/**
 * Puts our record back when it is gone, and does nothing when a record with our id exists
 * (it is never replaced here). For the start of the server while a model is installed: a
 * config-backup restore can bring back an older endpoint store without our record while the
 * model, the runtime and the state file stay. The settings flag is NOT touched: a person who
 * switched it off meant to. Resolves true when the record was added. Never throws.
 */
export async function ensureLocalEndpoint(input: LocalEndpointInput): Promise<boolean> {
  const parsed = CustomModelHostSchema.safeParse(buildLocalEndpointRecord(input));
  if (!parsed.success) return false;
  const record: CustomModelHost = parsed.data;
  try {
    return await mutateCustomModelHosts<boolean>((hosts) =>
      hosts.some((host) => host.id === record.id) ? { result: false } : { hosts: [...hosts, record], result: true }
    );
  } catch {
    // A store that must not be overwritten stays as it is; a session start then says what is wrong.
    return false;
  }
}

/** Takes our record out of the store. Resolves with how many OTHER endpoints are saved. */
async function removeLocalEndpoint(): Promise<number> {
  return mutateCustomModelHosts<number>((hosts) => {
    const others = hosts.filter((host) => host.id !== LOCAL_MODEL_ENDPOINT_ID);
    return others.length === hosts.length ? { result: others.length } : { hosts: others, result: others.length };
  });
}

/**
 * Moves our record to another port (the answer to "Use another port" once connected). A
 * missing record is not an error, and a record that is already there is not written again.
 */
export async function moveLocalEndpoint(port: number): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;
  await mutateCustomModelHosts<void>((hosts) => {
    const index = hosts.findIndex((host) => host.id === LOCAL_MODEL_ENDPOINT_ID);
    if (index === -1 || hosts[index].baseUrl === baseUrl) return { result: undefined };
    const next = [...hosts];
    next[index] = { ...next[index], baseUrl };
    return { hosts: next, result: undefined };
  });
}

/**
 * Removes our record, and restores the settings flag when this feature switched it on
 * (`flagWasEnabled` is false) and no other endpoint is left. Idempotent.
 */
export async function disconnectLocalModel(input: { flagWasEnabled: boolean }): Promise<void> {
  const othersLeft = await removeLocalEndpoint();
  if (input.flagWasEnabled || othersLeft > 0) return;
  await mutateSettingsFile((current) =>
    current[ENDPOINTS_FLAG] === true ? { ...current, [ENDPOINTS_FLAG]: false } : undefined
  );
}

/** Whether `id` is the reserved endpoint id. For the endpoint routes and the discovery sweep, which leave that record alone. */
export function isLocalModelEndpointId(id: string): boolean {
  return id === LOCAL_MODEL_ENDPOINT_ID;
}

/**
 * Whether the saved endpoint `id` is the record THIS feature wrote and still owns: the id is
 * the reserved one and the state file records a connection under it. A record with the
 * reserved id that somebody made by hand (before this feature, or while nothing is installed)
 * is not managed, so its owner can still edit and delete it. Never throws.
 */
export async function isManagedLocalEndpoint(id: string): Promise<boolean> {
  if (!isLocalModelEndpointId(id)) return false;
  const state = await readLocalModelState();
  return state.connection?.endpointId === id;
}

/**
 * What a session is called where a person reads it. A session an agent started (a worker of
 * the codeman skill, `codeman agent spawn`) has no name of its own, and its tab then shows
 * the last folder of its working directory, else the first eight characters of its id
 * (`getSessionName()` in app.js). The same steps here, so that a sentence which lists
 * sessions never lists an empty name. Pure.
 */
export function sessionLabel(session: { id?: string; name?: string; workingDir?: string }): string {
  const name = (session.name ?? '').trim();
  if (name) return name;
  const folder = (session.workingDir ?? '').split('/').filter(Boolean).pop();
  return folder || (session.id ?? '').slice(0, 8);
}

/**
 * The live sessions that use the endpoint `endpointId`, in the order given, each by the name
 * its tab shows (`sessionLabel()`). Pure. What the feature answers a 409 `sessions-open` with.
 */
export function sessionNamesUsingEndpoint(
  sessions: Iterable<{ id?: string; name: string; workingDir?: string; customModel?: { endpointId: string } }>,
  endpointId: string = LOCAL_MODEL_ENDPOINT_ID
): string[] {
  const names: string[] = [];
  for (const session of sessions) {
    if (session.customModel?.endpointId === endpointId) names.push(sessionLabel(session));
  }
  return names;
}

/**
 * Compares the digest stored at install time with the one the runtime reports now. Pure.
 *  - `same`: launch.
 *  - `changed`: refuse (`model-changed`): the name now stands for other weights or another template.
 *  - `unknown`: one of the two is absent (the runtime does not answer, the model is gone).
 *    The caller refuses as well, with the reason it knows.
 */
export function compareModelDigest(
  stored: string | undefined,
  current: string | undefined
): 'same' | 'changed' | 'unknown' {
  const a = normalizeDigest(stored);
  const b = normalizeDigest(current);
  if (!a || !b) return 'unknown';
  return a === b ? 'same' : 'changed';
}

/** A digest as it is compared: lowercase hex, without the `sha256:` some listings put in front. */
function normalizeDigest(digest: string | undefined): string | undefined {
  if (typeof digest !== 'string') return undefined;
  const hex = digest
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '');
  return hex === '' ? undefined : hex;
}
