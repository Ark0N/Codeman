/**
 * @fileoverview Shared helper functions for route modules.
 *
 * Contains pure functions extracted from server.ts and a session lookup helper
 * that replaces ~43 inline not-found checks across route handlers.
 */

import { join } from 'node:path';
import { Session } from '../session.js';
import { ApiErrorCode, createErrorResponse } from '../types.js';
import { parseRalphLoopConfig, extractCompletionPhrase } from '../ralph-config.js';
import type { SessionPort } from './ports/session-port.js';
import type { EventPort } from './ports/event-port.js';

// Maximum hook data size (prevents oversized SSE broadcasts)
const MAX_HOOK_DATA_SIZE = 8 * 1024;

/**
 * Look up a session by ID or throw a structured error.
 * Replaces the pattern: `const session = sessions.get(id); if (!session) return createErrorResponse(...)`.
 */
export function findSessionOrFail(ctx: SessionPort, sessionId: string): Session {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    throw Object.assign(new Error(`Session ${sessionId} not found`), {
      statusCode: 404,
      body: createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${sessionId} not found`),
    });
  }
  return session;
}

/**
 * Formats uptime in seconds to a human-readable string (e.g., "1d 2h 30m 15s").
 */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Sanitizes hook event data before broadcasting via SSE.
 * Extracts only relevant fields and limits total size to prevent
 * oversized payloads from being broadcast to all connected clients.
 */
export function sanitizeHookData(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};

  // Only forward known safe fields from Claude Code hook stdin
  const safeFields: Record<string, unknown> = {};
  const allowedKeys = [
    'hook_event_name',
    'tool_name',
    'tool_input',
    'session_id',
    'cwd',
    'permission_mode',
    'stop_hook_active',
    'transcript_path',
  ];

  for (const key of allowedKeys) {
    if (key in data && data[key] !== undefined) {
      safeFields[key] = data[key];
    }
  }

  // For tool_input, extract only summary fields (not full file content)
  if (safeFields.tool_input && typeof safeFields.tool_input === 'object') {
    const input = safeFields.tool_input as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    if (input.command) summary.command = String(input.command).slice(0, 500);
    if (input.file_path) summary.file_path = String(input.file_path).slice(0, 500);
    if (input.description) summary.description = String(input.description).slice(0, 200);
    if (input.query) summary.query = String(input.query).slice(0, 200);
    if (input.url) summary.url = String(input.url).slice(0, 500);
    if (input.pattern) summary.pattern = String(input.pattern).slice(0, 200);
    if (input.prompt) summary.prompt = String(input.prompt).slice(0, 200);
    safeFields.tool_input = summary;
  }

  // Final size check - drop if serialized data exceeds limit
  const serialized = JSON.stringify(safeFields);
  if (serialized.length > MAX_HOOK_DATA_SIZE) {
    return { tool_name: safeFields.tool_name, _truncated: true };
  }

  return safeFields;
}

/**
 * Auto-configure Ralph tracker for a session.
 *
 * Priority order:
 * 1. .claude/ralph-loop.local.md (official Ralph Wiggum plugin state)
 * 2. CLAUDE.md <promise> tags (fallback)
 *
 * The ralph-loop.local.md file has priority because it contains
 * the exact configuration from an active Ralph loop session.
 */
export function autoConfigureRalph(session: Session, workingDir: string, ctx: EventPort): void {
  // First, try to read the official Ralph Wiggum plugin state file
  const ralphConfig = parseRalphLoopConfig(workingDir);

  if (ralphConfig && ralphConfig.completionPromise) {
    session.ralphTracker.enable();
    session.ralphTracker.startLoop(ralphConfig.completionPromise, ralphConfig.maxIterations ?? undefined);

    // Restore iteration count if available
    if (ralphConfig.iteration > 0) {
      // The tracker's cycleCount will be updated when we detect iteration patterns
      // in the terminal output, but we can set maxIterations now
      console.log(`[auto-detect] Ralph loop at iteration ${ralphConfig.iteration}/${ralphConfig.maxIterations ?? '∞'}`);
    }

    console.log(
      `[auto-detect] Configured Ralph loop for session ${session.id} from ralph-loop.local.md: ${ralphConfig.completionPromise}`
    );
    ctx.broadcast('session:ralphLoopUpdate', {
      sessionId: session.id,
      state: session.ralphTracker.loopState,
    });
    return;
  }

  // Fallback: try CLAUDE.md
  const claudeMdPath = join(workingDir, 'CLAUDE.md');
  const completionPhrase = extractCompletionPhrase(claudeMdPath);

  if (completionPhrase) {
    session.ralphTracker.enable();
    session.ralphTracker.startLoop(completionPhrase);
    console.log(`[auto-detect] Configured Ralph loop for session ${session.id} from CLAUDE.md: ${completionPhrase}`);
    ctx.broadcast('session:ralphLoopUpdate', {
      sessionId: session.id,
      state: session.ralphTracker.loopState,
    });
  }
}
