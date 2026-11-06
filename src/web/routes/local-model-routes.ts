/**
 * @fileoverview `GET /api/local-model`: what this Mac is and which local model fits it.
 *
 * SKELETON: the route is registered and answers 501 until its handler is written. It will
 * answer `{ success: true, data: LocalModelStatus }`, built from the hardware probe, the
 * catalogue, the harness facts and the pure `recommend()`:
 * `{ hardware, recommendation, catalogUpdated }`.
 *
 * Rules:
 *  - Read-only. It downloads nothing, installs nothing, writes no file and reads no setting.
 *  - Never a 500 for a probe that failed: a failed probe is an answer (the hardware's `source`
 *    says so and the recommendation is verdict `none`).
 *  - The payload names hardware of the host, so in multi-user mode it is admin only (403), the
 *    same bar as `GET /api/doctor`.
 *  - Every dependency is injected (`LocalModelRouteDeps`), so a route test spawns nothing and
 *    does not need a Mac: it passes its own hardware and harness facts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiErrorCode,
  createErrorResponse,
  type ApiResponse,
  type HardwareFacts,
  type HarnessFact,
  type LocalModelCatalog,
  type LocalModelStatus,
  type Recommendation,
} from '../../types.js';
import { getLocalModelCatalog } from '../../config/local-model-catalog.js';
import { readHardware } from '../../local-model/hardware.js';
import { buildHarnessFacts } from '../../local-model/harness-facts.js';
import { recommend } from '../../local-model/recommend.js';

/** What the route calls. Each member defaults to the real module; a test overrides what it needs. */
export interface LocalModelRouteDeps {
  readHardware: () => Promise<HardwareFacts>;
  getCatalog: () => LocalModelCatalog;
  buildHarnessFacts: (catalog: LocalModelCatalog) => Promise<HarnessFact[]>;
  recommend: (hw: HardwareFacts, catalog: LocalModelCatalog, harnessFacts: readonly HarnessFact[]) => Recommendation;
}

export const defaultLocalModelRouteDeps: LocalModelRouteDeps = {
  readHardware: () => readHardware(),
  getCatalog: getLocalModelCatalog,
  buildHarnessFacts,
  recommend,
};

export function registerLocalModelRoutes(app: FastifyInstance, deps: Partial<LocalModelRouteDeps> = {}): void {
  const resolved: LocalModelRouteDeps = { ...defaultLocalModelRouteDeps, ...deps };
  void resolved;
  app.get(
    '/api/local-model',
    async (_req: FastifyRequest, reply: FastifyReply): Promise<ApiResponse<LocalModelStatus>> => {
      reply.code(501);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'GET /api/local-model is not implemented yet');
    }
  );
}
