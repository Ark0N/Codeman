/**
 * @fileoverview Zod validation schemas for API routes
 *
 * This module contains Zod schemas for validating API request bodies.
 * Schemas are used in src/web/server.ts route handlers.
 *
 * @module web/schemas
 */

import { z } from 'zod';

// ========== Session Routes ==========

/**
 * Schema for POST /api/sessions
 * Creates a new session with optional working directory, mode, and name.
 */
export const CreateSessionSchema = z.object({
  workingDir: z.string().optional(),
  mode: z.enum(['claude', 'shell']).optional(),
  name: z.string().max(100).optional(),
  envOverrides: z.record(z.string(), z.string()).optional(),
});

/**
 * Schema for POST /api/sessions/:id/run
 * Runs a prompt in a session.
 */
export const RunPromptSchema = z.object({
  prompt: z.string().min(1).max(100000),
});

/**
 * Schema for POST /api/sessions/:id/input
 * Sends input to an interactive session.
 */
export const SessionInputSchema = z.object({
  input: z.string(),
  useScreen: z.boolean().optional(),
});

/**
 * Schema for POST /api/sessions/:id/resize
 * Resizes a session's terminal.
 */
export const ResizeSchema = z.object({
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
});

// ========== Case Routes ==========

/**
 * Schema for POST /api/cases
 * Creates a new case folder.
 */
export const CreateCaseSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format. Use only letters, numbers, hyphens, underscores.'),
  description: z.string().max(1000).optional(),
});

// ========== Quick Start ==========

/**
 * Schema for POST /api/quick-start
 * Creates case (if needed) and starts interactive session.
 */
export const QuickStartSchema = z.object({
  caseName: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format. Use only letters, numbers, hyphens, underscores.').optional(),
  mode: z.enum(['claude', 'shell']).optional(),
});

// ========== Hook Events ==========

/**
 * Schema for POST /api/hook-event
 * Receives Claude Code hook events.
 */
export const HookEventSchema = z.object({
  event: z.enum(['permission_prompt', 'elicitation_dialog', 'idle_prompt', 'stop', 'teammate_idle', 'task_completed']),
  sessionId: z.string().min(1),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});

// ========== Configuration ==========

/**
 * Schema for respawn configuration (partial updates allowed)
 * Used in PUT /api/config and respawn endpoints.
 */
export const RespawnConfigSchema = z.object({
  idleTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  updatePrompt: z.string().max(10000).optional(),
  interStepDelayMs: z.number().int().min(100).max(60000).optional(),
  enabled: z.boolean().optional(),
  sendClear: z.boolean().optional(),
  sendUpdate: z.boolean().optional(),
  sendInit: z.boolean().optional(),
  sendKickstart: z.boolean().optional(),
  kickstartPrompt: z.string().max(10000).optional(),
  aiIdleCheckEnabled: z.boolean().optional(),
  aiIdleCheckTimeoutMs: z.number().int().min(10000).max(300000).optional(),
  aiIdleCheckModel: z.string().max(100).optional(),
  completionConfirmMs: z.number().int().min(1000).max(60000).optional(),
  noOutputTimeoutMs: z.number().int().min(5000).max(600000).optional(),
  maxIterations: z.number().int().min(0).max(10000).optional(),
  stuckStateWarningMs: z.number().int().min(60000).max(3600000).optional(),
  autoAcceptEnabled: z.boolean().optional(),
  autoAcceptDelayMs: z.number().int().min(1000).max(60000).optional(),
  planModeEnabled: z.boolean().optional(),
  planCheckTimeoutMs: z.number().int().min(10000).max(300000).optional(),
  planCheckModel: z.string().max(100).optional(),
}).strict();

/**
 * Schema for PUT /api/config
 * Updates application configuration with whitelist of allowed fields.
 */
export const ConfigUpdateSchema = z.object({
  pollIntervalMs: z.number().int().min(100).max(60000).optional(),
  defaultTimeoutMs: z.number().int().min(1000).max(3600000).optional(),
  maxConcurrentSessions: z.number().int().min(1).max(50).optional(),
  respawn: RespawnConfigSchema.optional(),
}).strict();

/**
 * Schema for PUT /api/settings
 * User settings with allowed fields only.
 */
export const SettingsUpdateSchema = z.object({
  defaultClaudeMdPath: z.string().max(500).optional(),
  lastUsedCase: z.string().max(200).optional(),
  // Add other known settings fields as needed
}).passthrough(); // Allow additional fields but validate known ones

/**
 * Schema for POST /api/sessions/:id/input with length limit
 */
export const SessionInputWithLimitSchema = z.object({
  input: z.string().max(100000), // 100KB max input
  useScreen: z.boolean().optional(),
});
