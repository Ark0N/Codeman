/**
 * @fileoverview Zod validation schemas for API routes
 *
 * This module contains Zod schemas for validating API request bodies.
 * Schemas are used in src/web/server.ts route handlers.
 *
 * @module web/schemas
 */

import { z } from 'zod';

// ========== Path Validation ==========

/** Regex to validate working directory paths (no shell metacharacters) — matches tmux-manager.ts */
const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_\/\-. ~]+$/;

/** Validate a path string: no shell metacharacters, no traversal, must be absolute */
export function isValidWorkingDir(p: string): boolean {
  if (!p || !p.startsWith('/')) return false;
  if (p.includes(';') || p.includes('&') || p.includes('|') ||
      p.includes('$') || p.includes('`') || p.includes('(') ||
      p.includes(')') || p.includes('{') || p.includes('}') ||
      p.includes('<') || p.includes('>') || p.includes("'") ||
      p.includes('"') || p.includes('\n') || p.includes('\r')) {
    return false;
  }
  if (p.includes('..')) return false;
  return SAFE_PATH_PATTERN.test(p);
}

/** Zod refinement for safe absolute path */
const safePathSchema = z.string().max(1000).refine(isValidWorkingDir, {
  message: 'Invalid path: must be absolute, no shell metacharacters or traversal',
});

// ========== Env Var Allowlist ==========

/** Allowlisted env var key prefixes */
const ALLOWED_ENV_PREFIXES = ['CLAUDE_CODE_'];

/** Env var keys that are always blocked (security-sensitive) */
const BLOCKED_ENV_KEYS = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
  'CLAUDEMAN_MUX_NAME', 'CLAUDEMAN_TMUX',
]);

/** Validate that an env var key is allowed */
function isAllowedEnvKey(key: string): boolean {
  if (BLOCKED_ENV_KEYS.has(key)) return false;
  return ALLOWED_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** Zod schema for env overrides with allowlist enforcement */
const safeEnvOverridesSchema = z.record(z.string(), z.string()).optional().refine(
  (val) => {
    if (!val) return true;
    return Object.keys(val).every(isAllowedEnvKey);
  },
  { message: 'envOverrides contains blocked or disallowed env var keys. Only CLAUDE_CODE_* keys are allowed.' },
);

// ========== Session Routes ==========

/**
 * Schema for POST /api/sessions
 * Creates a new session with optional working directory, mode, and name.
 */
export const CreateSessionSchema = z.object({
  workingDir: safePathSchema.optional(),
  mode: z.enum(['claude', 'shell']).optional(),
  name: z.string().max(100).optional(),
  envOverrides: safeEnvOverridesSchema,
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
  useMux: z.boolean().optional(),
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
  sendInit: z.boolean().optional(),
  kickstartPrompt: z.string().max(10000).optional(),
  completionConfirmMs: z.number().int().min(1000).max(60000).optional(),
  noOutputTimeoutMs: z.number().int().min(5000).max(600000).optional(),
  autoAcceptPrompts: z.boolean().optional(),
  autoAcceptDelayMs: z.number().int().min(1000).max(60000).optional(),
  aiIdleCheckEnabled: z.boolean().optional(),
  aiIdleCheckModel: z.string().max(100).optional(),
  aiIdleCheckMaxContext: z.number().int().min(1000).max(500000).optional(),
  aiIdleCheckTimeoutMs: z.number().int().min(10000).max(300000).optional(),
  aiIdleCheckCooldownMs: z.number().int().min(1000).max(300000).optional(),
  aiPlanCheckEnabled: z.boolean().optional(),
  aiPlanCheckModel: z.string().max(100).optional(),
  aiPlanCheckMaxContext: z.number().int().min(1000).max(500000).optional(),
  aiPlanCheckTimeoutMs: z.number().int().min(10000).max(300000).optional(),
  aiPlanCheckCooldownMs: z.number().int().min(1000).max(300000).optional(),
  adaptiveTimingEnabled: z.boolean().optional(),
  adaptiveMinConfirmMs: z.number().int().min(1000).max(60000).optional(),
  adaptiveMaxConfirmMs: z.number().int().min(1000).max(600000).optional(),
  skipClearWhenLowContext: z.boolean().optional(),
  skipClearThresholdPercent: z.number().int().min(0).max(100).optional(),
});

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
  useMux: z.boolean().optional(),
});

// ========== Session Mutation Routes ==========

/** PUT /api/sessions/:id/name */
export const SessionNameSchema = z.object({
  name: z.string().min(0).max(128),
});

/** PUT /api/sessions/:id/color */
export const SessionColorSchema = z.object({
  color: z.string().max(30),
});

/** POST /api/sessions/:id/ralph-config */
export const RalphConfigSchema = z.object({
  enabled: z.boolean().optional(),
  completionPhrase: z.string().max(500).optional(),
  maxIterations: z.number().int().min(0).max(10000).optional(),
  reset: z.boolean().optional(),
  disableAutoEnable: z.boolean().optional(),
});

/** POST /api/sessions/:id/fix-plan/import */
export const FixPlanImportSchema = z.object({
  content: z.string().max(500000),
});

/** POST /api/sessions/:id/ralph-prompt/write */
export const RalphPromptWriteSchema = z.object({
  content: z.string().max(500000),
});

/** POST /api/sessions/:id/auto-clear */
export const AutoClearSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().min(0).max(1000000).optional(),
});

/** POST /api/sessions/:id/auto-compact */
export const AutoCompactSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().min(0).max(1000000).optional(),
  prompt: z.string().max(10000).optional(),
});

/** POST /api/sessions/:id/image-watcher */
export const ImageWatcherSchema = z.object({
  enabled: z.boolean(),
});

/** POST /api/sessions/:id/flicker-filter */
export const FlickerFilterSchema = z.object({
  enabled: z.boolean(),
});

/** POST /api/run */
export const QuickRunSchema = z.object({
  prompt: z.string().min(1).max(100000),
  workingDir: safePathSchema.optional(),
});

/** POST /api/scheduled */
export const ScheduledRunSchema = z.object({
  prompt: z.string().min(1).max(100000),
  workingDir: safePathSchema.optional(),
  durationMinutes: z.number().int().min(1).max(14400).optional(),
});

/** POST /api/cases/link */
export const LinkCaseSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  path: z.string().min(1).max(1000),
});

/** POST /api/generate-plan */
export const GeneratePlanSchema = z.object({
  taskDescription: z.string().min(1).max(100000),
  detailLevel: z.enum(['brief', 'standard', 'detailed']).optional(),
});

/** POST /api/generate-plan-detailed */
export const GeneratePlanDetailedSchema = z.object({
  taskDescription: z.string().min(1).max(100000),
  caseName: z.string().max(200).optional(),
});

/** POST /api/cancel-plan-generation */
export const CancelPlanSchema = z.object({
  orchestratorId: z.string().max(200).optional(),
});

/** PATCH /api/sessions/:id/plan/task/:taskId */
export const PlanTaskUpdateSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'blocked']).optional(),
  error: z.string().max(10000).optional(),
  incrementAttempts: z.boolean().optional(),
});

/** POST /api/sessions/:id/plan/task (add task) */
export const PlanTaskAddSchema = z.object({
  content: z.string().min(1).max(10000),
  priority: z.enum(['P0', 'P1', 'P2']).optional(),
  verificationCriteria: z.string().max(10000).optional(),
  dependencies: z.array(z.string().max(200)).optional(),
  insertAfter: z.string().max(200).optional(),
});

/** POST /api/sessions/:id/cpu-limit */
export const CpuLimitSchema = z.object({
  cpuLimit: z.number().int().min(0).max(100).optional(),
  ioClass: z.enum(['idle', 'best-effort', 'realtime']).optional(),
  ioLevel: z.number().int().min(0).max(7).optional(),
});

/** PUT /api/execution/model-config */
export const ModelConfigUpdateSchema = z.record(z.string(), z.unknown());

/** PUT /api/subagent-window-states */
export const SubagentWindowStatesSchema = z.object({
  minimized: z.record(z.string(), z.boolean()).optional(),
  open: z.array(z.string()).optional(),
}).passthrough();

/** PUT /api/subagent-parents */
export const SubagentParentMapSchema = z.record(z.string(), z.string());

/** POST /api/sessions/:id/interactive-respawn */
export const InteractiveRespawnSchema = z.object({
  respawnConfig: RespawnConfigSchema.optional(),
  durationMinutes: z.number().int().min(1).max(14400).optional(),
});

/** POST /api/sessions/:id/respawn/enable */
export const RespawnEnableSchema = z.object({
  config: RespawnConfigSchema.optional(),
  durationMinutes: z.number().int().min(1).max(14400).optional(),
});
