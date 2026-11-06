/**
 * @fileoverview Connecting the installed local model to Codeman, and undoing it: the endpoint
 * record, the settings flag, and the checks around them.
 *
 * CONTRACT STAGE: the two constants are final. Every function below has its final signature
 * and a body that throws; the bodies are written next.
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
 *  - Both writes are idempotent, so a resumed job writes them again.
 *  - Undoing removes our record, and switches the flag off again only when this feature
 *    switched it on AND no other endpoint is saved.
 *  - The model's digest is compared again before a session starts and at boot
 *    (`compareModelDigest()`): a model that changed under the same name is not launched.
 */

import type { CustomModelHost } from '../custom-model-hosts.js';
import type { LocalModelErrorCode } from '../types.js';

/** Marks a body the contract stage left unwritten. */
function notImplemented(what: string, ..._args: unknown[]): never {
  throw new Error(`${what} is not implemented yet`);
}

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
  return notImplemented('buildLocalEndpointRecord', input);
}

export interface ConnectLocalModelInput extends LocalEndpointInput {
  /**
   * True when the state file already records a connection of ours: an existing record with
   * our id is then ours and is replaced. False: such a record is somebody else's.
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

/** Writes the record and the flag. Idempotent. Never throws: a refused write is `connect-failed` with its message as `detail`. */
export async function connectLocalModel(input: ConnectLocalModelInput): Promise<ConnectResult> {
  return notImplemented('connectLocalModel', input);
}

/** Moves our record to another port (the answer to "Use another port" once connected). A missing record is not an error. */
export async function moveLocalEndpoint(port: number): Promise<void> {
  return notImplemented('moveLocalEndpoint', port);
}

/**
 * Removes our record, and restores the settings flag when this feature switched it on
 * (`flagWasEnabled` is false) and no other endpoint is left. Idempotent.
 */
export async function disconnectLocalModel(input: { flagWasEnabled: boolean }): Promise<void> {
  return notImplemented('disconnectLocalModel', input);
}

/** Whether `id` is the reserved endpoint id. For the endpoint routes and the discovery sweep, which leave that record alone. */
export function isLocalModelEndpointId(id: string): boolean {
  return notImplemented('isLocalModelEndpointId', id);
}

/**
 * The names of the live sessions that use the endpoint `endpointId`, in the order given.
 * Pure. What `DELETE /api/local-model` answers its 409 with.
 */
export function sessionNamesUsingEndpoint(
  sessions: Iterable<{ name: string; customModel?: { endpointId: string } }>,
  endpointId: string = LOCAL_MODEL_ENDPOINT_ID
): string[] {
  return notImplemented('sessionNamesUsingEndpoint', sessions, endpointId);
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
  return notImplemented('compareModelDigest', stored, current);
}
