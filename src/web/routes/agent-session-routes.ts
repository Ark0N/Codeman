/**
 * @fileoverview Agent-facing bounded inspection and guarded stage/submit endpoints.
 * Ownership is checked before any disk or pane read. Native evidence comes only
 * from strict conversation attribution; all other modes get labeled snapshots.
 */
import type { FastifyInstance } from 'fastify';
import type { Session } from '../../session.js';
import type { SessionPort, InfraPort } from '../ports/index.js';
import { getCli } from '../../config/cli-registry/registry.js';
import { findExactCodexConversation, resolveEffectiveCodexHome } from '../../agent-codex-identity.js';
import { InspectionReader, InspectionConflict, boundedUtf8Tail } from '../../agent-inspection.js';
import { GuardedStageStore, GuardedInputConflict, type GuardedInputTarget } from '../../agent-staging.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { findSessionOrFail, getAuthUser, parseBody } from '../route-helpers.js';
import { AgentInspectQuerySchema, AgentStageSchema, AgentSubmitSchema } from '../schemas.js';

export function registerAgentSessionRoutes(app: FastifyInstance, ctx: SessionPort & InfraPort): void {
  const reader = new InspectionReader();
  const stages = new GuardedStageStore();
  app.addHook('onClose', async () => {
    reader.clear();
    stages.clear();
  });
  const generation = (session: Session) => session.inspectionGeneration;
  const target = (session: Session): GuardedInputTarget => ({
    id: session.id,
    snapshot: () => {
      if (ctx.sessions.get(session.id) !== session) return null;
      const snapshot = session.guardedInputSnapshot?.();
      return snapshot ?? null;
    },
    write: (text) => session.stageGuardedInput(text),
    submit: (expected) => session.submitGuardedInput(expected),
  });
  app.get('/api/sessions/:id/inspect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    const { maxBytes, since } = parseBody(AgentInspectQuerySchema, req.query);
    const initialGeneration = generation(session);
    const identity = { sessionId: session.id, mode: session.mode };
    const activity = { status: session.status, lastSubmitAt: session.lastSubmitAt || null, observedAt: Date.now() };
    try {
      if (getCli(session.mode)?.capabilities.transcript === 'codex-rollout' && !session.remote && !session.docker) {
        const conversation = await findExactCodexConversation(
          {
            codexHome: resolveEffectiveCodexHome(session.getCodexHomeOverride(), session.workingDir),
            sessionId: session.id,
            workingDir: session.workingDir,
            resumeSessionId: session.codexConfig?.resumeSessionId,
          },
          { maxEntries: 8192, maxBytes: 1048576 }
        );
        if (generation(session) !== initialGeneration || ctx.sessions.get(id) !== session)
          throw new InspectionConflict('Session changed during inspection');
        if (conversation) {
          const result = await reader.read(
            conversation.path,
            {
              owner: getAuthUser(req).username,
              sessionId: id,
              generation: initialGeneration,
              conversationId: conversation.id,
            },
            maxBytes,
            since
          );
          if (generation(session) !== initialGeneration || ctx.sessions.get(id) !== session)
            throw new InspectionConflict('Session changed during inspection');
          return {
            success: true,
            data: {
              source: 'codex-jsonl',
              identity: { ...identity, conversationId: conversation.id },
              activity,
              incremental: true,
              maxBytes,
              ...result,
            },
          };
        }
      }
      if (since)
        throw new InspectionConflict('Attributed transcript unavailable; this cursor cannot resume a pane snapshot');
      const frame = session.muxName ? ctx.mux.capturePaneText?.(session.muxName) : null;
      const evidence = frame ?? session.terminalBuffer;
      return {
        success: true,
        data: {
          source: 'pane-snapshot',
          identity,
          activity,
          incremental: false,
          cursor: null,
          maxBytes,
          evidence: boundedUtf8Tail(evidence, maxBytes),
          truncated: evidence.length > maxBytes || Buffer.byteLength(evidence) > maxBytes,
        },
      };
    } catch (error) {
      if (error instanceof InspectionConflict)
        return reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, error.message));
      // Native paths and arbitrary IO errors must never escape into the response.
      return reply
        .code(409)
        .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Inspection source unavailable; retry without a cursor'));
    }
  });
  app.post('/api/sessions/:id/stage', async (req, reply) => {
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req);
    const { message } = parseBody(AgentStageSchema, req.body);
    try {
      const receipt = await stages.stage(target(session), getAuthUser(req).username, message);
      return { success: true, data: receipt };
    } catch (error) {
      return reply
        .code(409)
        .send(
          createErrorResponse(
            ApiErrorCode.CONFLICT,
            error instanceof GuardedInputConflict
              ? error.message
              : 'Stage delivery failed; inspect the pane before retrying'
          )
        );
    }
  });
  app.post('/api/sessions/:id/submit', async (req, reply) => {
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req);
    const { stageId, confirmSha } = parseBody(AgentSubmitSchema, req.body);
    try {
      return {
        success: true,
        data: await stages.submit(target(session), getAuthUser(req).username, stageId, confirmSha),
      };
    } catch (error) {
      return reply
        .code(409)
        .send(
          createErrorResponse(
            ApiErrorCode.CONFLICT,
            error instanceof GuardedInputConflict
              ? error.message
              : 'Submit delivery failed or ambiguous; receipt consumed, inspect the pane'
          )
        );
    }
  });
}
