/**
 * @fileoverview The local model routes: what this Mac is and which local model fits it
 * (`GET /api/local-model`), and the verbs that install one, start and stop it and remove it.
 *
 * | Route                            | Body                        | Answer                                         |
 * |----------------------------------|-----------------------------|------------------------------------------------|
 * | `GET /api/local-model`           | none                        | `{ hardware, recommendation, catalogUpdated, install }` |
 * | `POST /api/local-model/install`  | `LocalModelInstallRequest`  | the install view; 400, 409                     |
 * | `POST /api/local-model/use`      | `LocalModelUseRequest`      | the install view; 400, 409                     |
 * | `POST /api/local-model/cancel`   | none                        | the install view; 409                          |
 * | `POST /api/local-model/resume`   | `LocalModelResumeRequest`   | the install view; 409                          |
 * | `POST /api/local-model/runtime`  | `LocalModelRuntimeRequest`  | the install view; 409                          |
 * | `DELETE /api/local-model`        | `LocalModelRemoveRequest`   | the install view; 409                          |
 * | `DELETE /api/local-model/models` | `LocalModelDeleteRequest`   | the install view; 400, 409, 500                |
 * | `POST /api/local-model/agent`    | `LocalModelAgentRequest`    | the install view; 400, 409                     |
 *
 * The GET is built from the hardware probe, the catalogue, the harness facts and the pure
 * `recommend()`, plus the `install` object of the install service
 * (`LocalModelService.view()`). The one thing joined here: a row of the recommendation that is
 * a checked model of the library is marked (`Candidate.library`, by `markLibraryCandidates()`).
 * Nothing is reformatted: every size text and every sentence in the payload was chosen by the
 * modules that produced it. There is no SSE event:
 * the window polls the GET once a second while it is open.
 *
 * EXPERIMENTAL (docs/versioning-policy.md, "Experimental local model routes"): the routes and
 * their payloads are outside the stable `/api/v1` contract. docs/api-reference.md says so in
 * its section; keep the two in step, and drop both labels together.
 *
 * Rules:
 *  - Every route is admin only in multi-user mode (403), the same bar as `GET /api/doctor`:
 *    the GET names hardware of the host, and the verbs download and run a program, install a
 *    coding agent and write the server-wide settings. The gate runs before anything is probed,
 *    parsed or started.
 *  - The GET changes nothing a person asked to keep: it downloads nothing, installs nothing
 *    and writes no setting. Its one write is the service's own bookkeeping (a job a server
 *    restart interrupted is marked paused the first time anything looks at it).
 *  - A failed probe is an answer, never a 500. `readHardware()` reports a spawn that failed
 *    in the hardware's `source` (`os-fallback`), and a server that is not on macOS as
 *    `not-probed`; both go out as a 200 whose recommendation is verdict `none` or computed
 *    from what is known. Should the probe itself reject (it promises not to), the route logs
 *    it and answers with what `node:os` knows (`hardwareFromOs()`), under the same two
 *    `source` values.
 *  - A 500 is left for a fault that is not a probe: the catalogue, the harness facts or
 *    `recommend()` throwing. That is a bug, and it must not be dressed up as "no model fits".
 *  - A verb answers the view AFTER the verb. A refusal the service names is a 400 (the request
 *    is not a row the server offers) or a 409 whose `data` is the `LocalModelConflict`
 *    (`reason`, the sentence, and for `size-changed` the server's own total, for
 *    `sessions-open` the session names). A 400 the service names carries its sentence as
 *    `data.message` too, so the window prints it in its own language. A write of the settings
 *    or of the endpoint store that was refused (a file that does not parse) is a 409 without
 *    `data`, with the fix.
 *  - The verbs do the work in the install service; this file only gates, parses and maps.
 *    `DELETE /api/local-model`, `runtime`, `resume`, `install` and `use` look at the live
 *    sessions: they hand their names to the service, which refuses a removal, a stop, a change
 *    of port, another model and a switch while one of them still uses the model.
 *  - `DELETE /api/local-model/models` takes a model NAME in its body, never a path: the schema
 *    admits only `name:tag`, and the service deletes only a name of its own listing, through
 *    the runtime.
 *  - `POST /api/local-model/agent` installs one more coding agent beside an installed model.
 *    Its body names a CLI id only: the service takes it only when it is a row of the view's
 *    `harnesses` that offers `install`, and runs the compiled stock command, never text from
 *    the request. It looks at no session: nothing about the model in use changes.
 *  - Every dependency is injected (`LocalModelRouteDeps`), so a route test spawns nothing and
 *    does not need a Mac: it passes its own hardware, harness facts and service.
 */

import { arch, totalmem } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiErrorCode,
  createErrorResponse,
  getErrorMessage,
  type ApiResponse,
  type HardwareFacts,
  type HarnessFact,
  type LocalModelCatalog,
  type LocalModelConflict,
  type LocalModelInstallView,
  type LocalModelRefusal,
  type LocalModelStatus,
  type Recommendation,
  type RecommendOptions,
} from '../../types.js';
import { getAuthUser, isAdmin, parseBody } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { getLocalModelCatalog } from '../../config/local-model-catalog.js';
import {
  CustomModelHostsWriteRefusedError,
  customModelHostsWriteErrorResponse,
} from '../../custom-model-hosts-writer.js';
import { sessionNamesUsingEndpoint } from '../../local-model/connect.js';
import { formatGb, memClassGb } from '../../local-model/format.js';
import { readHardware } from '../../local-model/hardware.js';
import { buildHarnessFacts } from '../../local-model/harness-facts.js';
import {
  formatInstallMessage,
  getLocalModelService,
  markLibraryCandidates,
  type LocalModelActor,
  type LocalModelService,
  type LocalModelVerbResult,
} from '../../local-model/install-job.js';
import { recommend } from '../../local-model/recommend.js';
import {
  LocalModelAgentSchema,
  LocalModelDeleteSchema,
  LocalModelInstallSchema,
  LocalModelRemoveSchema,
  LocalModelResumeSchema,
  LocalModelRuntimeSchema,
  LocalModelUseSchema,
} from '../schemas.js';
import { SettingsWriteRefusedError, settingsWriteErrorResponse } from '../settings-writer.js';

/** A live session as the DELETE needs it: its name, and the endpoint its model comes from. */
export interface LocalModelSessionLike {
  name: string;
  customModel?: { endpointId: string };
}

/** What the routes read of the server: its live sessions. */
export interface LocalModelRouteContext {
  sessions: ReadonlyMap<string, LocalModelSessionLike>;
}

/** What the routes call. Each member defaults to the real module; a test overrides what it needs. */
export interface LocalModelRouteDeps {
  readHardware: () => Promise<HardwareFacts>;
  getCatalog: () => LocalModelCatalog;
  buildHarnessFacts: (catalog: LocalModelCatalog) => Promise<HarnessFact[]>;
  recommend: (
    hw: HardwareFacts,
    catalog: LocalModelCatalog,
    harnessFacts: readonly HarnessFact[],
    options?: RecommendOptions
  ) => Recommendation;
  /** The install service. Looked up on every request, so the server's one service is built on first use. */
  service: () => LocalModelService;
}

export const defaultLocalModelRouteDeps: LocalModelRouteDeps = {
  readHardware: () => readHardware(),
  getCatalog: getLocalModelCatalog,
  buildHarnessFacts: (catalog) => buildHarnessFacts(catalog),
  recommend,
  service: getLocalModelService,
};

/**
 * The hardware answer when the probe rejected: memory and architecture from `node:os`, and the
 * `source` the probe itself uses for "nothing was read from sysctl" (`os-fallback` on macOS,
 * `not-probed` anywhere else). Sizes go through the one formatter, like every other size.
 */
export function hardwareFromOs(): HardwareFacts {
  const memBytes = totalmem();
  return {
    platform: process.platform,
    arch: arch(),
    memBytes,
    memGb: formatGb(memBytes),
    memClassGb: memClassGb(memBytes),
    source: process.platform === 'darwin' ? 'os-fallback' : 'not-probed',
  };
}

/** The 409 of a verb the service refused: the error envelope plus the conflict as `data`. */
export interface LocalModelConflictResponse {
  success: false;
  /** The conflict's sentence in English, its slots filled. */
  error: string;
  errorCode: ApiErrorCode;
  data: LocalModelConflict;
}

/** The 400 (or 500, or 507) of a verb the service refused with a sentence: the error envelope plus that sentence as `data`. */
export interface LocalModelRefusalResponse {
  success: false;
  /** The sentence in English, its slots filled. */
  error: string;
  errorCode: ApiErrorCode;
  data: LocalModelRefusal;
}

/** What a verb answers: the view after it, an error envelope, or a refusal that carries its sentence. */
export type LocalModelVerbResponse =
  | ApiResponse<LocalModelInstallView>
  | LocalModelConflictResponse
  | LocalModelRefusalResponse;

/** 403 for a non-admin in multi-user mode, before anything else runs. `null`: go on. */
function adminOnly(req: FastifyRequest, reply: FastifyReply): ApiResponse<never> | null {
  if (!isMultiUserMode() || isAdmin(req)) return null;
  reply.code(403);
  return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
}

function actorOf(req: FastifyRequest): LocalModelActor {
  return { username: getAuthUser(req).username, ip: req.ip };
}

/** A verb's result as its HTTP answer. */
function respond(result: LocalModelVerbResult, reply: FastifyReply): LocalModelVerbResponse {
  if (result.ok) return { success: true, data: result.view };
  reply.code(result.status);
  if (result.status !== 409) {
    return {
      success: false,
      error: formatInstallMessage(result.message),
      errorCode: result.status === 400 ? ApiErrorCode.INVALID_INPUT : ApiErrorCode.OPERATION_FAILED,
      data: { message: result.message },
    };
  }
  return {
    success: false,
    error: formatInstallMessage(result.conflict.message),
    errorCode: ApiErrorCode.CONFLICT,
    data: result.conflict,
  };
}

/** Runs one verb. What the service did not name as a refusal: a refused config write is a 409 with the fix, anything else a 500. */
async function runVerb(
  reply: FastifyReply,
  verb: () => Promise<LocalModelVerbResult>
): Promise<LocalModelVerbResponse> {
  try {
    return respond(await verb(), reply);
  } catch (err) {
    if (err instanceof CustomModelHostsWriteRefusedError) {
      reply.code(409);
      return customModelHostsWriteErrorResponse(err);
    }
    if (err instanceof SettingsWriteRefusedError) {
      reply.code(409);
      return settingsWriteErrorResponse(err);
    }
    reply.code(500);
    return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, `The local model request failed: ${getErrorMessage(err)}`);
  }
}

export function registerLocalModelRoutes(
  app: FastifyInstance,
  ctx: LocalModelRouteContext,
  deps: Partial<LocalModelRouteDeps> = {}
): void {
  const resolved: LocalModelRouteDeps = { ...defaultLocalModelRouteDeps, ...deps };

  app.get(
    '/api/local-model',
    async (req: FastifyRequest, reply: FastifyReply): Promise<ApiResponse<LocalModelStatus>> => {
      const denied = adminOnly(req, reply);
      if (denied) return denied;

      let hardware: HardwareFacts;
      try {
        hardware = await resolved.readHardware();
      } catch (err) {
        console.warn(`[local-model] The hardware probe failed, answering from node:os: ${getErrorMessage(err)}`);
        hardware = hardwareFromOs();
      }

      try {
        const catalog = resolved.getCatalog();
        const harnessFacts = await resolved.buildHarnessFacts(catalog);
        const service = resolved.service();
        // The measured budget once the runtime reported it, and the runtime download that an
        // install would still add: what turns the estimate into the figures of the consent.
        const options = await service.recommendOptions();
        const install = await service.view({ harnessFacts });
        // A row that is already a checked model on this Mac says so: choosing it is a switch.
        const recommendation = markLibraryCandidates(
          resolved.recommend(hardware, catalog, harnessFacts, options),
          install
        );
        return { success: true, data: { hardware, recommendation, catalogUpdated: catalog.updated, install } };
      } catch (err) {
        reply.code(500);
        return createErrorResponse(
          ApiErrorCode.INTERNAL_ERROR,
          `The local model recommendation failed: ${getErrorMessage(err)}`
        );
      }
    }
  );

  app.post('/api/local-model/install', async (req, reply): Promise<LocalModelVerbResponse> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const body = parseBody(LocalModelInstallSchema, req.body);
    // Asked at the moment of the request: another model takes the runtime from a live session.
    const sessionNames = sessionNamesUsingEndpoint(ctx.sessions.values());
    return runVerb(reply, () => resolved.service().install(body, actorOf(req), sessionNames));
  });

  app.post('/api/local-model/use', async (req, reply): Promise<LocalModelVerbResponse> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const body = parseBody(LocalModelUseSchema, req.body);
    const sessionNames = sessionNamesUsingEndpoint(ctx.sessions.values());
    return runVerb(reply, () => resolved.service().use(body, actorOf(req), sessionNames));
  });

  app.post('/api/local-model/cancel', async (req, reply): Promise<LocalModelVerbResponse> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    return runVerb(reply, () => resolved.service().cancel());
  });

  app.post('/api/local-model/resume', async (req, reply): Promise<LocalModelVerbResponse> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const body = parseBody(LocalModelResumeSchema, req.body ?? {});
    const sessionNames = sessionNamesUsingEndpoint(ctx.sessions.values());
    return runVerb(reply, () => resolved.service().resume(body, actorOf(req), sessionNames));
  });

  app.post('/api/local-model/runtime', async (req, reply): Promise<LocalModelVerbResponse> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const body = parseBody(LocalModelRuntimeSchema, req.body);
    // Asked at the moment of the request, like the DELETE: a stop or a change of port leaves
    // a live session calling an address nothing of ours holds.
    const sessionNames = sessionNamesUsingEndpoint(ctx.sessions.values());
    return runVerb(reply, () => resolved.service().runtime(body, sessionNames));
  });

  app.delete('/api/local-model', async (req, reply): Promise<LocalModelVerbResponse> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const body = parseBody(LocalModelRemoveSchema, req.body ?? {});
    // Asked at the moment of the request: a session that started a second ago counts.
    const sessionNames = sessionNamesUsingEndpoint(ctx.sessions.values());
    return runVerb(reply, () => resolved.service().remove(body, sessionNames, actorOf(req)));
  });

  app.delete('/api/local-model/models', async (req, reply): Promise<LocalModelVerbResponse> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const body = parseBody(LocalModelDeleteSchema, req.body);
    return runVerb(reply, () => resolved.service().deleteLibraryModel(body, actorOf(req)));
  });

  app.post('/api/local-model/agent', async (req, reply): Promise<LocalModelVerbResponse> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const body = parseBody(LocalModelAgentSchema, req.body);
    return runVerb(reply, () => resolved.service().installAgent(body, actorOf(req)));
  });
}
