/**
 * @fileoverview Status-telemetry route.
 *
 * Receives Claude Code statusline payloads POSTed by the Codeman-managed
 * statusLine exporter (see `hooks-config.generateStatusLineCommand`) and
 * broadcasts the parsed plan-usage limits (5-hour + weekly) to SSE clients for
 * the header "Plan Usage Limits" chip. Auth-exempt like `/api/hook-event`
 * (localhost-only; hook-secret-gated while a tunnel runs — see middleware/auth).
 *
 * Also records the session's model (`model.display_name`) as its reported model, which
 * `session:updated` publishes as `displayModel` for the session headers.
 *
 * Returns a compact plain-text status string for the exporter to print as the
 * in-terminal footer (print-through) when it has no statusline of the user's
 * own to wrap. An unknown session gets an EMPTY body: the old brand-word
 * answer rendered as the statusline itself (discussion #405).
 */

import { FastifyInstance } from 'fastify';
import { StatusTelemetrySchema } from '../schemas.js';
import { parseBody } from '../route-helpers.js';
import {
  parsePromptCache,
  parseStatusTelemetry,
  parseSessionStatus,
  formatSessionStatusText,
  telemetrySignature,
  type RawStatuslinePayload,
} from '../../usage-telemetry.js';
import { SessionPromptCache, SessionStatusTelemetry } from '../sse-events.js';
import { setLatestPlanUsage } from '../plan-usage-latest.js';
import type { SessionPort, EventPort } from '../ports/index.js';
import { getCli } from '../../config/cli-registry/index.js';

export function registerStatusTelemetryRoutes(app: FastifyInstance, ctx: SessionPort & EventPort): void {
  // Last broadcast telemetry signature per session — the statusline fires on
  // every assistant message, so we only rebroadcast when the value changes.
  const lastSig = new Map<string, string>();

  app.post('/api/status-telemetry', async (req, reply) => {
    const { sessionId, data } = parseBody(StatusTelemetrySchema, req.body);

    reply.type('text/plain; charset=utf-8');

    // Unknown session: nothing to broadcast and nothing to print. Never a brand
    // word here, it would render as the statusline.
    if (!ctx.sessions.has(sessionId)) {
      lastSig.delete(sessionId);
      return '';
    }

    const payload = data as RawStatuslinePayload | undefined;

    // The model the CLI says it is running, for the session headers (displayModel). It
    // rides every render, so it follows an in-session `/model`; the session dedupes and
    // broadcasts only a change. Only a CLI that has a statusline exporter at all may
    // report one here.
    const session = ctx.sessions.get(sessionId);
    if (session && getCli(session.mode)?.capabilities.statusLineTelemetry) {
      session.noteReportedModel('statusline', payload?.model?.display_name);
    }

    // Prompt-cache state of the main conversation (Claude Code v2.1.251+): kept on the
    // session for the Session Options readout and `toState()`, broadcast only when the
    // report changes (the statusline fires on every assistant message). The broadcast
    // carries the STORED object, so a compaction stamp set in setPromptCache rides along.
    // Reports are applied in arrival order. When the exporter wraps a user's own statusline
    // it backgrounds this POST (hooks-config.ts), so two sub-second loopback reports can
    // arrive out of order; a stale one then briefly overwrites newer state until the next
    // render corrects it. Accepted for a display-only readout rather than ordered here.
    const promptCache = parsePromptCache(payload);
    if (promptCache && session?.setPromptCache(promptCache)) {
      ctx.broadcast(SessionPromptCache, { sessionId, ...session.promptCache });
    }

    // Plan-usage limits (account-wide) → broadcast to the header chip, when
    // present and changed (the statusline fires on every assistant message).
    const telemetry = parseStatusTelemetry(payload);
    if (telemetry) {
      const sig = telemetrySignature(telemetry);
      if (lastSig.get(sessionId) !== sig) {
        lastSig.set(sessionId, sig);
        // Bound the map across long multi-session runs: prune dead sessions.
        if (lastSig.size > 256) {
          for (const id of [...lastSig.keys()]) {
            if (!ctx.sessions.has(id)) lastSig.delete(id);
          }
        }
        const update = { sessionId, ...telemetry };
        const snapshot = setLatestPlanUsage(update); // replayed in the SSE init snapshot for fresh loads
        ctx.broadcast(SessionStatusTelemetry, snapshot);
      }
    }

    // In-terminal statusline footer → CURRENT SESSION status (model / tokens /
    // context %), NOT the plan limits. Available from the first render, even
    // before rate_limits appears.
    return formatSessionStatusText(parseSessionStatus(payload));
  });
}
