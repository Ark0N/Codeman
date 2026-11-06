/**
 * @fileoverview `GET /api/local-model`: what this Mac is and which local model fits it.
 *
 * Answers `{ success: true, data: LocalModelStatus }`, built from the hardware probe, the
 * catalogue, the harness facts and the pure `recommend()`:
 * `{ hardware, recommendation, catalogUpdated }`. Nothing is reformatted here: every size text
 * and every sentence in the payload was chosen by the modules that produced it.
 *
 * Rules:
 *  - Read-only. It downloads nothing, installs nothing, writes no file and reads no setting.
 *  - A failed probe is an answer, never a 500. `readHardware()` reports a spawn that failed
 *    in the hardware's `source` (`os-fallback`), and a server that is not on macOS as
 *    `not-probed`; both go out as a 200 whose recommendation is verdict `none` or computed
 *    from what is known. Should the probe itself reject (it promises not to), the route logs
 *    it and answers with what `node:os` knows (`hardwareFromOs()`), under the same two
 *    `source` values.
 *  - A 500 is left for a fault that is not a probe: the catalogue, the harness facts or
 *    `recommend()` throwing. That is a bug, and it must not be dressed up as "no model fits".
 *  - The payload names hardware of the host, so in multi-user mode it is admin only (403), the
 *    same bar as `GET /api/doctor`. The gate runs before anything is probed.
 *  - Every dependency is injected (`LocalModelRouteDeps`), so a route test spawns nothing and
 *    does not need a Mac: it passes its own hardware and harness facts.
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
  type LocalModelStatus,
  type Recommendation,
} from '../../types.js';
import { isAdmin } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { getLocalModelCatalog } from '../../config/local-model-catalog.js';
import { formatGb, memClassGb } from '../../local-model/format.js';
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
  buildHarnessFacts: (catalog) => buildHarnessFacts(catalog),
  recommend,
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

export function registerLocalModelRoutes(app: FastifyInstance, deps: Partial<LocalModelRouteDeps> = {}): void {
  const resolved: LocalModelRouteDeps = { ...defaultLocalModelRouteDeps, ...deps };
  app.get(
    '/api/local-model',
    async (req: FastifyRequest, reply: FastifyReply): Promise<ApiResponse<LocalModelStatus>> => {
      if (isMultiUserMode() && !isAdmin(req)) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
      }

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
        const recommendation = resolved.recommend(hardware, catalog, harnessFacts);
        return { success: true, data: { hardware, recommendation, catalogUpdated: catalog.updated } };
      } catch (err) {
        reply.code(500);
        return createErrorResponse(
          ApiErrorCode.INTERNAL_ERROR,
          `The local model recommendation failed: ${getErrorMessage(err)}`
        );
      }
    }
  );
}
