/**
 * @fileoverview Agent-facing bounded inspection and guarded stage/submit endpoints.
 * Ownership is checked before any disk or pane read. Native evidence comes only
 * from strict conversation attribution; all other modes get labeled snapshots.
 *
 * Experimental and opt-in: all three routes answer `403 FORBIDDEN`, naming the
 * setting, until the synced `agentCoordinationEnabled` is on (default OFF), the
 * same shape as `cliManagementEnabled` and `mcpSyncEnabled`. The gate runs first,
 * before session lookup, so a disabled install reveals nothing about its sessions.
 */
import type { FastifyInstance } from 'fastify';
import type { Session } from '../../session.js';
import type { SessionPort, InfraPort } from '../ports/index.js';
import { getCli } from '../../config/cli-registry/registry.js';
import { findExactCodexConversation, resolveEffectiveCodexHome } from '../../agent-codex-identity.js';
import { InspectionReader, InspectionConflict, boundedUtf8Tail } from '../../agent-inspection.js';
import {
  GuardedStageStore,
  GuardedInputConflict,
  guardedComposerChrome,
  MAY_BE_TYPED,
  type GuardedInputTarget,
} from '../../agent-staging.js';
import { ApiErrorCode, createErrorResponse, type ApiResponse } from '../../types.js';
import { findSessionOrFail, getAuthUser, parseBody, readJsonConfig, SETTINGS_PATH } from '../route-helpers.js';
import { AgentInspectQuerySchema, AgentStageSchema, AgentSubmitSchema } from '../schemas.js';

/** Default OFF, same shape as `readMcpSyncEnabled`: read fresh so a toggle applies at once. */
export async function readAgentCoordinationEnabled(): Promise<boolean> {
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});
  return settings.agentCoordinationEnabled === true;
}

/** The refusal every route sends while the setting is off. Exported for the tests. */
export const AGENT_COORDINATION_DISABLED_MESSAGE =
  'Experimental agent coordination (inspect, stage, submit) is disabled. Turn on "Experimental agent coordination" in Settings (agentCoordinationEnabled) and save first.';

async function gate(): Promise<ApiResponse<never> | null> {
  if (await readAgentCoordinationEnabled()) return null;
  return createErrorResponse(ApiErrorCode.FORBIDDEN, AGENT_COORDINATION_DISABLED_MESSAGE);
}

/** A Node error code (`EACCES`, `EIO`, ...) or the error's class name; never its message. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return error instanceof Error ? error.constructor.name : 'unknown';
}

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
    chrome: () => guardedComposerChrome(getCli(session.mode)),
    snapshot: () => {
      if (ctx.sessions.get(session.id) !== session) return null;
      const snapshot = session.guardedInputSnapshot?.();
      return snapshot ?? null;
    },
    write: (text) => session.stageGuardedInput(text),
    submit: (expected) => session.submitGuardedInput(expected),
  });
  app.get('/api/sessions/:id/inspect', async (req, reply) => {
    const refused = await gate();
    if (refused) return reply.code(403).send(refused);
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
      // Anything else (an unreadable rollout, an IO error) is not a retryable cursor
      // conflict. Log the session and the error code only: the message can carry the
      // native transcript path, which must never reach the log or the response.
      console.warn(`[agent-inspect] session ${session.id}: inspection failed (${errorCode(error)})`);
      return reply.code(422).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Inspection source unavailable'));
    }
  });
  app.post('/api/sessions/:id/stage', async (req, reply) => {
    const refused = await gate();
    if (refused) return reply.code(403).send(refused);
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req);
    const { message } = parseBody(AgentStageSchema, req.body);
    try {
      const receipt = await stages.stage(target(session), getAuthUser(req).username, message);
      return { success: true, data: receipt };
    } catch (error) {
      if (!(error instanceof GuardedInputConflict))
        console.warn(`[agent-stage] session ${session.id}: delivery failed (${errorCode(error)})`);
      return reply
        .code(409)
        .send(
          createErrorResponse(
            ApiErrorCode.CONFLICT,
            error instanceof GuardedInputConflict
              ? error.message
              : `Stage delivery failed or ambiguous; ${MAY_BE_TYPED}`
          )
        );
    }
  });
  app.post('/api/sessions/:id/submit', async (req, reply) => {
    const refused = await gate();
    if (refused) return reply.code(403).send(refused);
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req);
    const { stageId, confirmSha } = parseBody(AgentSubmitSchema, req.body);
    try {
      return {
        success: true,
        data: await stages.submit(target(session), getAuthUser(req).username, stageId, confirmSha),
      };
    } catch (error) {
      if (!(error instanceof GuardedInputConflict))
        console.warn(`[agent-submit] session ${session.id}: delivery failed (${errorCode(error)})`);
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
