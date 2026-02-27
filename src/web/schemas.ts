/**
 * @fileoverview Zod validation schemas for API routes
 *
 * This module contains Zod schemas for validating API request bodies.
 * Schemas are used in src/web/server.ts route handlers.
 *
 * @module web/schemas
 */

import { z } from 'zod';
import { SAFE_PATH_PATTERN } from '../utils/regex-patterns.js';

// ========== Path Validation ==========

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
const ALLOWED_ENV_PREFIXES = ['CLAUDE_CODE_', 'OPENCODE_'];

/** Env var keys that are always blocked (security-sensitive) */
const BLOCKED_ENV_KEYS = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
  'CODEMAN_MUX_NAME', 'CODEMAN_TMUX',
  'OPENCODE_SERVER_PASSWORD',  // Security-sensitive: server auth password
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
  { message: 'envOverrides contains blocked or disallowed env var keys. Only CLAUDE_CODE_* and OPENCODE_* keys are allowed.' },
);

// ========== Session Routes ==========

/**
 * Schema for POST /api/sessions
 * Creates a new session with optional working directory, mode, and name.
 */
/** Schema for OpenCode-specific configuration */
const OpenCodeConfigSchema = z.object({
  model: z.string().max(100).regex(/^[a-zA-Z0-9._\-/]+$/).optional(),
  autoAllowTools: z.boolean().optional(),
  continueSession: z.string().max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  forkSession: z.boolean().optional(),
  configContent: z.string().max(10000).refine(
    (val) => { try { JSON.parse(val); return true; } catch { return false; } },
    { message: 'configContent must be valid JSON' },
  ).optional(),
}).optional();

export const CreateSessionSchema = z.object({
  workingDir: safePathSchema.optional(),
  mode: z.enum(['claude', 'shell', 'opencode']).optional(),
  name: z.string().max(100).optional(),
  envOverrides: safeEnvOverridesSchema,
  openCodeConfig: OpenCodeConfigSchema,
});

/**
 * Schema for POST /api/sessions/:id/run
 * Runs a prompt in a session.
 */
export const RunPromptSchema = z.object({
  prompt: z.string().min(1).max(100000),
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
  mode: z.enum(['claude', 'shell', 'opencode']).optional(),
  openCodeConfig: OpenCodeConfigSchema,
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
 * Explicit allowlist of known settings fields — prevents arbitrary key persistence.
 */
const NotificationEventSchema = z.object({
  enabled: z.boolean().optional(),
  browser: z.boolean().optional(),
  audio: z.boolean().optional(),
  push: z.boolean().optional(),
}).optional();

export const SettingsUpdateSchema = z.object({
  // Paths
  defaultClaudeMdPath: z.string().max(500).optional(),
  defaultWorkingDir: z.string().max(500).optional(),
  lastUsedCase: z.string().max(200).optional(),
  // Feature toggles
  ralphTrackerEnabled: z.boolean().optional(),
  subagentTrackingEnabled: z.boolean().optional(),
  subagentActiveTabOnly: z.boolean().optional(),
  imageWatcherEnabled: z.boolean().optional(),
  tunnelEnabled: z.boolean().optional(),
  tabTwoRows: z.boolean().optional(),
  agentTeamsEnabled: z.boolean().optional(),
  // UI visibility
  showFontControls: z.boolean().optional(),
  showSystemStats: z.boolean().optional(),
  showTokenCount: z.boolean().optional(),
  showCost: z.boolean().optional(),
  showLifecycleLog: z.boolean().optional(),
  showMonitor: z.boolean().optional(),
  showProjectInsights: z.boolean().optional(),
  showFileBrowser: z.boolean().optional(),
  showSubagents: z.boolean().optional(),
  // Claude CLI settings
  claudeMode: z.string().max(50).optional(),
  allowedTools: z.string().max(2000).optional(),
  // CPU priority
  nice: z.object({
    enabled: z.boolean().optional(),
    niceValue: z.number().int().min(-20).max(19).optional(),
  }).optional(),
  // Notification preferences (cross-device sync)
  notificationPreferences: z.object({
    enabled: z.boolean().optional(),
    browserNotifications: z.boolean().optional(),
    audioAlerts: z.boolean().optional(),
    stuckThresholdMs: z.number().optional(),
    muteCritical: z.boolean().optional(),
    muteWarning: z.boolean().optional(),
    muteInfo: z.boolean().optional(),
    eventTypes: z.object({
      permission_prompt: NotificationEventSchema,
      elicitation_dialog: NotificationEventSchema,
      idle_prompt: NotificationEventSchema,
      stop: NotificationEventSchema,
      session_error: NotificationEventSchema,
      respawn_cycle: NotificationEventSchema,
      token_milestone: NotificationEventSchema,
      ralph_complete: NotificationEventSchema,
      subagent_spawn: NotificationEventSchema,
      subagent_complete: NotificationEventSchema,
    }).optional(),
    _version: z.number().optional(),
  }).optional(),
  // Voice settings (cross-device sync)
  voiceSettings: z.object({
    apiKey: z.string().max(200).optional(),
    language: z.string().max(20).optional(),
    keyterms: z.string().max(500).optional(),
    insertMode: z.string().max(20).optional(),
  }).optional(),
}).strict();

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

// ========== Web Push ==========

/** POST /api/push/subscribe */
export const PushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
  userAgent: z.string().max(500).optional(),
  pushPreferences: z.record(z.string(), z.boolean()).optional(),
});

/** PUT /api/push/subscribe/:id */
export const PushPreferencesUpdateSchema = z.object({
  pushPreferences: z.record(z.string(), z.boolean()),
});

// ========== Ralph Loop ==========

/** POST /api/ralph-loop/start */
export const RalphLoopStartSchema = z.object({
  caseName: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format').optional().default('testcase'),
  taskDescription: z.string().min(1).max(100000),
  completionPhrase: z.string().max(100).default('COMPLETE'),
  maxIterations: z.number().int().min(0).max(1000).nullable().default(10),
  enableRespawn: z.boolean().default(false),
  planItems: z.array(z.object({
    content: z.string(),
    priority: z.string().optional(),
    enabled: z.boolean().default(true),
  })).optional(),
});
