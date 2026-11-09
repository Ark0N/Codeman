/**
 * @fileoverview Read My Mind routes: intent profiles + the predictor.
 *
 * Per-case intent profiles feeding the Read My Mind predictor
 * (docs/readmymind-plan.md):
 * - `GET    /api/sessions/:id/intent`: the profile for the session's case
 * - `PUT    /api/sessions/:id/intent`: replace the goals text
 * - `DELETE /api/sessions/:id/intent`: forget the case's profile
 * - `POST   /api/sessions/:id/readmymind`: predict the user's next prompt
 *
 * The profile is keyed by owner + workingDir, so multi-user scoping is
 * structural; session ownership is still enforced via `findSessionOrFail`
 * (with `req`, so a foreign session id 404s) to keep the session-routes
 * no-existence-leak policy.
 *
 * Deliberately session-scoped rather than a raw `/api/intents/:key` surface:
 * the session resolves owner + workingDir server-side, so a caller can never
 * address another case's profile by guessing keys.
 *
 * Predict gathers every signal Codeman already has (intent profile, pending
 * approval dialog, transcript tail, git state, run-summary events, sibling
 * sessions), assembles a budgeted prompt via the pure
 * `buildPredictionContext()`, and runs the one-shot predictor. Claude-mode
 * only (400: capture and transcripts exist for nothing else), one prediction
 * in flight per session (409 CONFLICT), and suggestions are only ever
 * RETURNED, never sent: the human click in the modal is the boundary, which
 * is also the prompt-injection mitigation for observed content.
 *
 * Registrations use the bare `app.<method>('path', ...)` + `req.params as`
 * shape (session-routes style): these endpoints are documented in the agent
 * skill, and the endpoints.md drift test's scanner does not see registrations
 * with a generic between the method and the path.
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { IntentGoalsSchema, ReadMyMindPredictSchema } from '../schemas.js';
import { parseBody, findSessionOrFail } from '../route-helpers.js';
import { intentStore } from '../../intent-store.js';
import { approvalInbox } from '../approval-inbox.js';
import { buildPredictionContext, type PredictionContextInputs } from '../../readmymind-context.js';
import { collectWorkspaceSignals, readTranscriptSignals } from '../../readmymind-collectors.js';
import { readMyMindPredictor } from '../../readmymind-predictor.js';
import type { ConfigPort, InfraPort, SessionPort } from '../ports/index.js';

/** One prediction in flight per session; a second POST while running is a 409. */
const predictionsInFlight = new Set<string>();

export function registerReadMyMindRoutes(app: FastifyInstance, ctx: SessionPort & ConfigPort & InfraPort): void {
  app.get('/api/sessions/:id/intent', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    return { success: true, data: { intent: intentStore.getProfile(session.owner, session.workingDir) } };
  });

  app.put('/api/sessions/:id/intent', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(IntentGoalsSchema, req.body);
    const session = findSessionOrFail(ctx, id, req);
    return { success: true, data: { intent: intentStore.setGoals(session.owner, session.workingDir, body.goals) } };
  });

  app.delete('/api/sessions/:id/intent', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    return { success: true, data: { deleted: intentStore.deleteProfile(session.owner, session.workingDir) } };
  });

  app.post('/api/sessions/:id/readmymind', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ReadMyMindPredictSchema, req.body ?? {});
    const session = findSessionOrFail(ctx, id, req);

    // `mode === 'claude'` directly, NOT hooksAvailableForMode(): that predicate
    // answers "can this session deliver stop/blocked", and once `deepseek` earned
    // a yes it silently widened this gate to a mode whose sessions have no Claude
    // transcript for readTranscriptSignals() to read.
    if (session.mode !== 'claude') {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Read My Mind predicts claude-mode sessions only');
    }
    if (predictionsInFlight.has(id)) {
      reply.code(409);
      return createErrorResponse(ApiErrorCode.CONFLICT, 'A prediction is already running for this session');
    }

    predictionsInFlight.add(id);
    try {
      const profile = intentStore.getProfile(session.owner, session.workingDir);
      const pending = approvalInbox.getForSession(id);
      const transcriptPath = ctx.getTranscriptPath(id);
      const transcript = transcriptPath ? await readTranscriptSignals(transcriptPath) : null;
      // Remote-SSH cases skip git: workingDir is not local. Docker cases are
      // fine (the workspace is bind-mounted at the same host path). An adopted
      // session's workingDir is a neutral wrapper folder, so it skips git too.
      const workspace = session.remote || session.isAdopted ? null : await collectWorkspaceSignals(session.workingDir);

      const lastPromptTs = profile.recentPrompts[profile.recentPrompts.length - 1]?.ts;
      const tracker = ctx.runSummaryTrackers.get(id);
      const awayEvents = (tracker?.getRecentEvents(15) ?? [])
        .filter((ev) => lastPromptTs === undefined || ev.timestamp >= lastPromptTs)
        .map((ev) => ({ timestamp: ev.timestamp, title: ev.title, details: ev.details }));

      const siblings = [...ctx.sessions.values()]
        .filter((s) => s.id !== id && s.workingDir === session.workingDir && s.status !== 'stopped')
        .map((s) => ({ name: s.name, mode: s.mode, working: s.isWorking }));

      const inputs: PredictionContextInputs = {
        pendingDialog: pending
          ? {
              kind: pending.kind,
              toolName: pending.toolName,
              message: pending.message,
              context: pending.context,
              options: pending.options,
            }
          : undefined,
        goals: profile.goals,
        lastAssistantText: transcript?.lastAssistantText ?? undefined,
        recentPrompts: profile.recentPrompts.map((p) => ({ ts: p.ts, text: p.text })),
        recentTools: transcript?.recentTools,
        workspace: workspace ?? undefined,
        awaySinceMs: lastPromptTs !== undefined ? Date.now() - lastPromptTs : undefined,
        awayEvents,
        siblings,
        steer: body.steer,
        rejected: body.rejected,
      };

      const { prompt } = buildPredictionContext(inputs);
      const model = await ctx.getReadMyMindModel();
      const result = await readMyMindPredictor.predict({ sessionId: id, prompt, model });
      return { success: true, data: { suggestions: result.suggestions, durationMs: result.durationMs } };
    } catch (err) {
      reply.code(502);
      const message = err instanceof Error ? err.message : 'Prediction failed';
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, message);
    } finally {
      predictionsInFlight.delete(id);
    }
  });
}
