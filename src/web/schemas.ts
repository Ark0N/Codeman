/**
 * @fileoverview Zod validation schemas for API routes
 *
 * This module contains Zod schemas for validating API request bodies.
 * Schemas are used in src/web/server.ts route handlers.
 *
 * @module web/schemas
 */

import { z } from 'zod';
import { SAFE_PATH_PATTERN, isSafePushEndpoint } from '../utils/index.js';
import { isValidWebviewUrl } from './webview-proxy.js';
import { isBlockedWebviewUrl } from './webview-egress-policy.js';
import {
  MAX_TERMINAL_BUFFER_BYTES,
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_BUFFER_BYTES,
  MIN_TERMINAL_SCROLLBACK_LINES,
} from '../config/terminal-history.js';
import { MAX_EDITABLE_BYTES } from '../config/file-editing.js';
import { MIN_MATCH_LENGTH, MAX_MATCH_LENGTH } from '../config/agent-wait.js';
import { enabledCliIds, enabledClis } from '../config/cli-registry/registry.js';
import type { SessionMode } from '../types.js';

// ========== Path Validation ==========

/** Validate a path string: no shell metacharacters, no traversal, must be absolute */
export function isValidWorkingDir(p: string): boolean {
  if (!p || !p.startsWith('/')) return false;
  if (
    p.includes(';') ||
    p.includes('&') ||
    p.includes('|') ||
    p.includes('$') ||
    p.includes('`') ||
    p.includes('(') ||
    p.includes(')') ||
    p.includes('{') ||
    p.includes('}') ||
    p.includes('<') ||
    p.includes('>') ||
    p.includes("'") ||
    p.includes('"') ||
    p.includes('\n') ||
    p.includes('\r')
  ) {
    return false;
  }
  if (p.includes('..')) return false;
  return SAFE_PATH_PATTERN.test(p);
}

/** Zod refinement for safe absolute path */
const safePathSchema = z.string().max(1000).refine(isValidWorkingDir, {
  message: 'Invalid path: must be absolute, no shell metacharacters or traversal',
});

/**
 * Filesystem picker paths are never interpolated into a shell command, so legal
 * filename characters such as spaces, quotes, and parentheses are accepted.
 * Containment and symlink resolution are enforced by the route after parsing.
 */
const filesystemPickerPathSchema = z
  .string()
  .max(4096)
  .refine((p) => p.startsWith('/') && !p.includes('\0') && !p.includes('\n') && !p.includes('\r'), {
    message: 'Path must be an absolute filesystem path',
  })
  .refine((p) => !p.split('/').includes('..'), { message: 'Path traversal is not allowed' });

/**
 * Opt-in flag for listing dot-prefixed entries in the path picker. Absent means
 * off, so an old client keeps the previous behavior. It is a string rather than
 * a boolean because it arrives as a query parameter; `'false'` is accepted (and
 * means off) so a client can send the flag unconditionally.
 */
const showHiddenQuerySchema = z.enum(['true', 'false']).optional();

/** Query validation for the lazy, allowlisted filesystem path picker. */
export const FilesystemBrowseQuerySchema = z.object({
  path: filesystemPickerPathSchema.optional(),
  sessionId: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid session id')
    .optional(),
  showHidden: showHiddenQuerySchema,
});

/** Query validation for a single allowlisted path-picker file preview. */
export const FilesystemPreviewQuerySchema = z.object({
  path: filesystemPickerPathSchema,
  sessionId: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid session id')
    .optional(),
  showHidden: showHiddenQuerySchema,
});

/**
 * Body validation for `PUT /api/sessions/:id/file-content` (File Viewer edit
 * mode). `content.max()` counts UTF-16 code units, which for UTF-8 output is
 * always <= the byte length, so it is a coarse pre-filter that never rejects
 * valid content; the handler enforces the exact MAX_EDITABLE_BYTES byte cap.
 * Workspace containment and symlink resolution are enforced by the route via
 * validateSessionFilePath after parsing.
 */
export const FileWriteSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((p) => !p.includes('\0') && !p.includes('\n') && !p.includes('\r'), {
        message: 'Invalid path',
      }),
    content: z.string().max(MAX_EDITABLE_BYTES),
    baseHash: z.string().regex(/^[a-f0-9]{64}$/, 'baseHash must be a sha256 hex digest'),
    eol: z.enum(['lf', 'crlf']).optional(),
    force: z.boolean().optional(),
  })
  .strict();

/**
 * The run-mode ids the API currently accepts: every ENABLED registry entry.
 *
 * Exported so anything needing the authoritative list derives it from here rather than
 * restating the nine names (which is how the old literal enum drifted from the run menu).
 */
export function sessionModeIds(): string[] {
  return enabledCliIds();
}

/**
 * Validation for a run mode, resolved AT PARSE TIME.
 *
 * ⚠️ Deliberately not a `z.enum([...])`. An enum has to be handed its members when the
 * SCHEMA OBJECT is built, which happens once at module import — so a CLI enabled while the
 * server was running kept failing validation with INVALID_INPUT until a restart, even
 * though the run menu already offered it. Checking membership inside the refinement moves
 * the question to when the request is actually validated.
 *
 * The cast is because callers type this field as `SessionMode`; the runtime check above is
 * what actually constrains it.
 */
function sessionModeSchema(): z.ZodType<SessionMode> {
  return (
    z
      .string()
      // Bounded BEFORE the membership check, and before the failure message quotes the value
      // back. `.max(24)` matches the `cliId` pattern in cli-registry/schema.ts — no id longer
      // than that can ever be registered, so nothing legitimate is rejected — and it means a
      // rejected mode cannot echo a body-limit-sized string into an error string and a log
      // line. Without it the only bound on either was the HTTP body limit.
      .max(24)
      .superRefine((value, ctx) => {
        const allowed = sessionModeIds();
        if (!allowed.includes(value)) {
          ctx.addIssue({
            code: 'custom',
            message: `Invalid run mode ${JSON.stringify(value)}. Enabled modes: ${allowed.join(', ')}`,
          });
        }
      }) as unknown as z.ZodType<SessionMode>
  );
}

// ========== Env Var Allowlist ==========

/**
 * Allowlisted env var key prefixes, contributed by the ENABLED CLIs in the registry
 * (`env.allowedPrefixes`) — `CLAUDE_CODE_`, `OPENCODE_`, `CODEX_`, `GEMINI_`, `GOOGLE_`,
 * `ANTIGRAVITY_`, `PI_`, `GROK_`, `XAI_`, `DSH_`, `DEEPSEEK_` as shipped.
 *
 * ⚠️ Resolved AT PARSE TIME, not at module load. This used to be a frozen array computed
 * once when the module was imported, which meant a CLI enabled while the server was running
 * had its env prefix rejected until a restart — validation and the run menu disagreeing
 * about which CLIs exist. Reading the registry per call costs a memoized array lookup.
 *
 * ⚠️ This is ONE GLOBAL LIST applied with no mode context, so admitting a prefix for one CLI
 * widens it for every mode at once. That is why an entry only ever contributes its own
 * VENDOR namespace: pi's ~34 provider keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, HF_TOKEN, …)
 * share no prefix and stay out, and a dsh `settings.yaml` can nominate ANY env var as a
 * provider credential — same problem, same answer. Those CLIs authenticate via their own
 * `/login` or the server process's own environment.
 */
function allowedEnvPrefixes(): string[] {
  return enabledClis().flatMap((entry) => entry.env.allowedPrefixes);
}

/**
 * Allowlisted exact env var keys (checked alongside the prefixes), likewise contributed by
 * enabled registry entries via `env.allowedKeys`.
 *
 * As shipped this is claude's CLAUDE_CONFIG_DIR, which relocates the Claude CLI's user
 * config (credentials, settings, stats) so a case can run on a separate Claude subscription
 * (#255). Exact match only — CLAUDE_CONFIG_DIR_EXTRA etc. stay rejected.
 */
function allowedEnvKeys(): Set<string> {
  return new Set(enabledClis().flatMap((entry) => entry.env.allowedKeys));
}

/** Env var keys that are always blocked (security-sensitive) */
const BLOCKED_ENV_KEYS = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'CODEMAN_MUX_NAME',
  'CODEMAN_TMUX',
  'OPENCODE_SERVER_PASSWORD', // Security-sensitive: server auth password
]);

/**
 * Validate that an env var key is allowed.
 *
 * ⚠️ `BLOCKED_ENV_KEYS` is checked FIRST and is deliberately NOT registry-driven. It is a
 * hard floor: a rogue or fat-fingered `allowedPrefixes` entry (say `''`, which prefixes
 * everything) still cannot unblock PATH or LD_PRELOAD.
 */
function isAllowedEnvKey(key: string): boolean {
  if (BLOCKED_ENV_KEYS.has(key)) return false;
  if (allowedEnvKeys().has(key)) return true;
  return allowedEnvPrefixes().some((prefix) => key.startsWith(prefix));
}

/** Zod schema for env overrides with allowlist enforcement */
const safeEnvOverridesSchema = z
  .record(z.string(), z.string())
  .optional()
  .refine(
    (val) => {
      if (!val) return true;
      return Object.keys(val).every(isAllowedEnvKey);
    },
    {
      message:
        'envOverrides contains blocked or disallowed env var keys. Only CLAUDE_CODE_*, OPENCODE_*, CODEX_*, GEMINI_*, GOOGLE_*, ANTIGRAVITY_*, PI_*, GROK_*, XAI_*, DSH_*, DEEPSEEK_*, OMP_* keys and CLAUDE_CONFIG_DIR are allowed.',
    }
  );

// ========== Effort Level ==========

/**
 * Claude CLI effort level for new sessions. Injected as a `--settings` soft default
 * (NOT the CLAUDE_CODE_EFFORT_LEVEL env var, which would hard-lock the session and
 * block in-session `/effort` switching). `ultracode` enables dynamic workflow orchestration.
 */
const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']).optional();

// ========== Session Routes ==========

/**
 * Schema for POST /api/sessions
 * Creates a new session with optional working directory, mode, and name.
 */
/** Schema for OpenCode-specific configuration */
const OpenCodeConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    autoAllowTools: z.boolean().optional(),
    continueSession: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    forkSession: z.boolean().optional(),
    configContent: z
      .string()
      .max(10000)
      .refine(
        (val) => {
          try {
            JSON.parse(val);
            return true;
          } catch {
            return false;
          }
        },
        { message: 'configContent must be valid JSON' }
      )
      .optional(),
  })
  .optional();

/** Schema for Codex (OpenAI CLI)-specific configuration */
const CodexConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    resumeSessionId: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    dangerouslyBypassApprovals: z.boolean().optional(),
    animations: z.boolean().optional(),
    renderMode: z
      .enum(['scrollback', 'hybrid'])
      .optional()
      .transform(() => 'hybrid' as const),
  })
  .optional();

/** Schema for Gemini CLI-specific configuration */
const GeminiConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    approvalMode: z.enum(['default', 'auto_edit', 'yolo', 'plan']).optional(),
    resumeSession: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
  })
  .optional();

/** Schema for Antigravity CLI (agy)-specific configuration */
const AntigravityConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    resumeConversationId: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
  })
  .optional();

/**
 * Schema for Pi CLI (pi.dev)-specific configuration.
 *
 * No bypass field exists on purpose: pi has no permission prompts. The one
 * privilege-shaped knob is the TRI-STATE `approveProjectTrust` (see PiConfig),
 * which the multi-user clamp MATERIALIZES to `false` for non-granted owners.
 */
const PiConfigSchema = z
  .object({
    // `:` for a thinking suffix (`sonnet:high`), `/` for `provider/id`.
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/:]+$/)
      .optional(),
    provider: z
      .string()
      .max(50)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    continueSession: z.boolean().optional(),
    resumeSessionId: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
    approveProjectTrust: z.boolean().optional(),
  })
  .optional();

/**
 * Schema for Grok Build CLI (xAI `grok`)-specific configuration.
 *
 * `alwaysApprove` maps to `--always-approve` (grok's bypassPermissions mode).
 * An ABSENT config spawns bare `grok` = grok's own ask-mode default, so the
 * multi-user clamp only needs the only-if-sent branch (like codex/antigravity).
 */
const GrokConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    alwaysApprove: z.boolean().optional(),
    continueSession: z.boolean().optional(),
    // Ids only: grok's --resume also matches session TITLES (arbitrary user
    // strings), which this regex deliberately cannot express.
    resumeSessionId: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
  })
  .optional();

/**
 * Schema for OMP CLI-specific configuration.
 */
const OmpConfigSchema = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    resumeSessionId: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
    continueSession: z.boolean().optional(),
  })
  .optional();

/**
 * Schema for DeepSeek Harness (`dsh`)-specific configuration.
 *
 * `permissionMode` maps to the `DSH_PERMISSION_MODE` env export, NOT to a flag —
 * the harness has no command-line permission switch. An ABSENT config spawns the
 * profile under the harness's own `workspace-write` default, which still asks
 * for approval, so the multi-user clamp only needs the only-if-sent branch (like
 * codex/antigravity/grok).
 *
 * `profile` is a directory name under `$DSH_HOME/profiles`, so it is constrained
 * to a single path SEGMENT: no separators, no dots-only names. It is interpolated
 * into the `bash -c "…"` spawn line and joined into a filesystem path, and this
 * regex is what keeps both safe.
 */
const DeepSeekConfigSchema = z
  .object({
    profile: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .optional(),
    permissionMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    resumeSession: z.boolean().optional(),
    resumeSessionId: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
    statusReporting: z.boolean().optional(),
  })
  .optional();

/**
 * Body of POST /api/deepseek/install-profile.
 *
 * `package` is a package SPECIFIER handed to `dsh plugin … add`, which runs a
 * real package-manager install, so it is the security-relevant field. Two things
 * contain it: this regex (an npm name, optionally scoped, optionally with an
 * `@version` tail, and NOTHING else — no path, no URL, no git spec, no leading
 * dash that could be read as a flag), and the route, which spawns an argv ARRAY
 * with no shell. The route additionally requires the privileged grant in
 * multi-user mode: installing a plugin is arbitrary code execution on the host,
 * the same bar as a `shell` session.
 */
export const DeepSeekInstallProfileSchema = z
  .object({
    profile: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .optional(),
    package: z
      .string()
      .min(1)
      .max(214)
      .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/)
      .optional(),
  })
  .strict();

/**
 * POST /api/deepseek/web: start the background `dsh web` for one browser authority.
 *
 * `authority` becomes `--trusted-host`, which is what dsh fences its own `/api`
 * behind, so it must be the origin the browser will actually load the tab from
 * (`location.host`). It reaches a spawn as one element of an argv ARRAY, never a
 * shell string, so this regex is defence in depth rather than the only guard: it
 * admits host:port in the shapes a browser authority can take (dotted names,
 * IPv4, bracketed IPv6) and nothing that could be read as a second argument.
 */
export const DeepSeekWebStartSchema = z
  .object({
    authority: z
      .string()
      .min(1)
      .max(255)
      .regex(/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::\d{1,5})?$/),
  })
  .strict();

/**
 * The session that spawned the one being created — pure UI decoration, drawn as a
 * lineage line between the two tabs. Accepted here and, equivalently, as the
 * `X-Codeman-Parent-Session` header (the agent skill sets that once on its shared
 * curl invocation so every spawn recipe carries it); the body wins when both are
 * present. `resolveParentSessionId()` in route-helpers.ts re-checks it against live
 * sessions and DROPS anything it cannot resolve — a bad value must never fail a
 * spawn, and this is never an ownership or permission signal.
 */
const parentSessionIdSchema = z.string().max(100).optional();

export const CreateSessionSchema = z.object({
  workingDir: safePathSchema.optional(),
  mode: sessionModeSchema().optional(),
  name: z.string().max(100).optional(),
  /** Session that spawned this one — see parentSessionIdSchema. */
  parentSessionId: parentSessionIdSchema,
  envOverrides: safeEnvOverridesSchema,
  /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
  effort: effortLevelSchema,
  /** Model override to write to .claude/settings.local.json (e.g., "opus[1m]"). Empty string clears. */
  modelOverride: z.string().max(50).optional(),
  /** Inject the Claude statusLine source for the shared plan-usage chip. Claude sessions only; Codex is host-polled. */
  statusLineTelemetry: z.boolean().optional(),
  openCodeConfig: OpenCodeConfigSchema,
  codexConfig: CodexConfigSchema,
  geminiConfig: GeminiConfigSchema,
  antigravityConfig: AntigravityConfigSchema,
  piConfig: PiConfigSchema,
  grokConfig: GrokConfigSchema,
  deepSeekConfig: DeepSeekConfigSchema,
  ompConfig: OmpConfigSchema,
  /** Resume a previous Claude conversation by its session ID (used for reboot recovery) */
  resumeSessionId: z
    .string()
    .max(100)
    .regex(/^[a-f0-9-]+$/, 'resumeSessionId must be a valid UUID')
    .optional(),
  /**
   * COD-105 — attach to an EXISTING remote tmux session discovered via
   * `GET /api/remote-hosts/:hostId/sessions` (one this Codeman didn't create).
   * The resulting session is NON-owned (closing it detaches, never kills the
   * remote). `remoteSessionName` is a discovered `codeman-*` tmux session name.
   */
  attachRemoteSession: z
    .object({
      hostId: z.string().min(1).max(200),
      remoteSessionName: z
        .string()
        .min(1)
        .max(200)
        .regex(/^codeman-[a-zA-Z0-9._-]+$/, 'remoteSessionName must be a codeman-* tmux session name'),
    })
    .optional(),
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
  viewportType: z.enum(['mobile', 'tablet', 'desktop']).optional(),
  force: z.boolean().optional(),
});

/**
 * Schema for POST /api/status-telemetry
 * Claude Code statusline payload forwarded by the Codeman-managed statusLine
 * exporter (see hooks-config.generateStatusLineCommand). Validates only the
 * subset Codeman displays; unknown keys (session_id, transcript_path, cwd, …)
 * are stripped by z.object. Auth-exempt like /api/hook-event.
 */
// NOTE: every modeled field is `.nullish()` (not `.optional()`) on purpose.
// Claude's statusline blob is officially shipped but undocumented in exact
// shape, and `z.optional()` REJECTS an explicit `null` (accepts only
// `undefined`) — a single stray `null` (e.g. `cost:{total_cost_usd:null}`)
// would 400 the ENTIRE POST before the deliberately-tolerant parser
// (usage-telemetry.ts, which only acts on `typeof === 'number'/'string'`) ever
// runs, silently killing the chip's data feed. `.nullish()` keeps the schema
// gate as forgiving as the parser it guards.
const RateLimitWindowSchema = z
  .object({
    used_percentage: z.number().nullish(),
    resets_at: z.number().nullish(),
  })
  .nullish();

export const StatusTelemetrySchema = z.object({
  sessionId: z.string().min(1).max(100),
  data: z
    .object({
      rate_limits: z
        .object({
          five_hour: RateLimitWindowSchema,
          seven_day: RateLimitWindowSchema,
        })
        .nullish(),
      context_window: z
        .object({
          used_percentage: z.number().nullish(),
          total_input_tokens: z.number().nullish(),
          total_output_tokens: z.number().nullish(),
        })
        .nullish(),
      cost: z.object({ total_cost_usd: z.number().nullish() }).nullish(),
      model: z.object({ display_name: z.string().max(100).nullish() }).nullish(),
    })
    .nullish(),
});

// ========== Case Routes ==========

/**
 * Schema for POST /api/cases
 * Creates a new case folder.
 */
export const CreateCaseSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format. Use only letters, numbers, hyphens, underscores.'),
  description: z.string().max(1000).optional(),
});

/**
 * Schema for POST /api/cases/clone — issue #236.
 *
 * `repository` is only length-bounded here on purpose: what makes an operand safe
 * is the transport/shape analysis in `parseGitRepositoryUrl` (which also produces
 * the user-facing rejection reason), and duplicating a weaker version of that as a
 * regex would be the copy that drifts. The route parses before touching git.
 */
export const CloneCaseSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format. Use only letters, numbers, hyphens, underscores.'),
  repository: z.string().min(1).max(2048),
  /** Branch or tag → `--branch <ref> --single-branch`. */
  ref: z.string().min(1).max(200).optional(),
  /** `--depth 1`. */
  shallow: z.boolean().optional(),
  description: z.string().max(1000).optional(),
});

/** Schema for POST /api/cases/clone-preflight — ask the remote what it has, clone nothing. */
export const ClonePreflightSchema = z.object({
  repository: z.string().min(1).max(2048),
});

const RemoteCommandOverridesSchema = z
  .object({
    shell: z.string().min(1).max(300).optional(),
    claude: z.string().min(1).max(300).optional(),
    opencode: z.string().min(1).max(300).optional(),
    codex: z.string().min(1).max(300).optional(),
    gemini: z.string().min(1).max(300).optional(),
    antigravity: z.string().min(1).max(300).optional(),
    pi: z.string().min(1).max(300).optional(),
    grok: z.string().min(1).max(300).optional(),
    deepseek: z.string().min(1).max(300).optional(),
  })
  .strict()
  .optional();

// COD-107 — advanced SSH connection options. These ultimately exec as shell
// (ProxyCommand etc.), but are OPERATOR-entered host config (never attacker- or
// terminal-output-influenced), so we validate as defense-in-depth, not as the
// security boundary. Reject newline/NUL/backtick/`$(` shell-injection vectors.
const NO_SHELL_INJECTION = /^[^\n\r\0`]*$/;
const noCommandSubstitution = (s: string) => !s.includes('$(');

// `remotePath`/`identityFile` are shell-escaped, then the whole launch command is
// embedded via `JSON.stringify(...)` inside `bash -c "..."` (tmux-manager). That
// outer DOUBLE-quote layer re-exposes `$(...)`, backticks, and `$VAR` even though
// the inner value is single-quoted — so a `$(cmd)` in the path would run LOCALLY at
// launch. Reject `$` and backtick (and newline/CR/NUL) entirely at the boundary.
const NO_SHELL_META = /^[^\n\r\0`$]*$/;

export const RemoteHostSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid remote host id'),
  label: z.string().min(1).max(100),
  host: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._:-]+$/, 'Invalid SSH host'),
  username: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid SSH username'),
  port: z.number().int().min(1).max(65535).optional(),
  // Identity (private-key) file PATH only — never key bytes. Reject shell
  // metacharacters ($, backtick) that survive into the `bash -c` launch layer.
  identityFile: z.string().min(1).max(4096).regex(NO_SHELL_META, 'Invalid identity file path').optional(),
  // SOCKS5 proxy as host:port (e.g. 127.0.0.1:1080).
  socksProxy: z
    .string()
    .regex(/^[\w.-]+:\d{1,5}$/, 'SOCKS proxy must be host:port')
    .optional(),
  // SSH jump host: a comma-separated chain of [user@]host[:port] hops. Structural
  // ALLOWLIST (not an open denylist) — only chars valid in user/host/port/IPv6,
  // so no shell metacharacter (;, |, &, space, $, quotes, …) can appear. The value
  // is also shellescaped at command-build time (buildSshConnectionArgs); this is the
  // belt to that suspenders.
  jumpHost: z
    .string()
    .min(1)
    .max(255)
    .regex(
      /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.:[\]-]+(?::\d{1,5})?(?:,(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.:[\]-]+(?::\d{1,5})?)*$/,
      'Jump host must be [user@]host[:port] (comma-separated for multiple hops)'
    )
    .optional(),
  // Arbitrary extra -o KEY=VALUE options (escape hatch); each must be KEY=VALUE.
  extraSshOptions: z
    .array(
      z
        .string()
        .min(3)
        .max(1024)
        .regex(/^[A-Za-z][A-Za-z0-9]*=.+$/, 'Extra SSH option must be KEY=VALUE')
        .regex(NO_SHELL_INJECTION, 'Invalid characters in SSH option')
        .refine(noCommandSubstitution, 'Invalid characters in SSH option')
    )
    .max(32)
    .optional(),
  commands: RemoteCommandOverridesSchema,
});

// Custom Model Endpoint Profiles (deployment_plan.md) — a user-configured custom
// OpenAI-compatible endpoint, local (llama.cpp) or cloud (Azure AI Foundry, etc.).
export const CustomModelHostSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid endpoint id'),
  label: z.string().min(1).max(100),
  baseUrl: z.string().url().max(2048),
  apiKey: z.string().max(4096).optional(),
  // No 'both': live-tested against a real server, sending both auth header
  // conventions on one request reliably HANGS it — see custom-model-hosts.ts.
  authStyle: z.enum(['bearer', 'api-key']).optional(),
  models: z.array(z.string().max(200)).max(200).optional(),
  lastDiscoveredAt: z.string().max(64).optional(),
});

/** POST /api/sessions/:id/custom-model — apply or clear a session's custom-model selection. */
export const CustomModelSelectionSchema = z.union([
  z.object({
    endpointId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid endpoint id'),
    modelId: z.string().min(1).max(200),
  }),
  z.object({ clear: z.literal(true) }),
]);

export const RemoteCaseLinkSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  hostId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid remote host id'),
  remotePath: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^\//, 'Remote path must be absolute')
    .regex(NO_SHELL_META, 'Invalid characters in remote path'),
});

// ========== Docker cases ==========
//
// Docker mode is a location overlay on cases (see docs/docker-cases-plan.md),
// the analog of the remote-SSH schemas above. `image`, `hostWorkspacePath`,
// `containerWorkdir`, and `container` all reach the outer `bash -c "..."` launch
// layer, so they carry NO_SHELL_META (rejects `$`/backtick that survive the
// double-quote layer) exactly like remotePath/identityFile. `--privileged` and
// any docker-socket mount are structurally unrepresentable (never accepted).

const DockerResourceLimitsSchema = z
  .object({
    memory: z
      .string()
      .regex(/^\d+[bkmg]?$/i, 'Memory must be like 512m / 4g')
      .optional(),
    cpus: z
      .string()
      .regex(/^\d+(\.\d+)?$/, 'CPUs must be a number')
      .optional(),
    pidsLimit: z.number().int().positive().max(100000).optional(),
    nofile: z
      .string()
      .regex(/^\d+:\d+$/, 'nofile must be soft:hard')
      .optional(),
    shmSize: z
      .string()
      .regex(/^\d+[bkmg]?$/i, 'shm-size must be like 256m')
      .optional(),
  })
  .strict();

export const DockerHostSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid docker host id'),
  label: z.string().min(1).max(100),
  engine: z.enum(['docker', 'podman']).optional(),
  image: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[a-zA-Z0-9][\w./:@-]*$/, 'Invalid image reference')
    .regex(NO_SHELL_META, 'Invalid characters in image reference'),
  daemonHost: z.string().max(512).regex(NO_SHELL_META, 'Invalid daemon host').optional(),
  context: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid docker context')
    .optional(),
  network: z.enum(['bridge', 'none', 'custom']).optional(),
  networkName: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Invalid network name')
    .optional(),
  resources: DockerResourceLimitsSchema.optional(),
  gpus: z
    .string()
    .max(128)
    .regex(/^(all|\d+|device=[a-zA-Z0-9,:._-]+)$/, 'GPUs must be all / a count / device=...')
    .optional(),
  mountCredentials: z.boolean().optional(),
  hooksEnabled: z.boolean().optional(),
  resumeOnStart: z.boolean().optional(),
  commands: RemoteCommandOverridesSchema, // same shell/claude/opencode/codex/gemini/antigravity shape
  extraCreateArgs: z
    .array(
      z
        .string()
        .min(1)
        .max(1024)
        .regex(NO_SHELL_INJECTION, 'Invalid characters in create arg')
        .refine(noCommandSubstitution, 'Invalid characters in create arg')
    )
    .max(32)
    .optional(),
  extraExecArgs: z
    .array(
      z
        .string()
        .min(1)
        .max(1024)
        .regex(NO_SHELL_INJECTION, 'Invalid characters in exec arg')
        .refine(noCommandSubstitution, 'Invalid characters in exec arg')
    )
    .max(32)
    .optional(),
});

export const DockerCaseLinkSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  hostId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid docker host id'),
  // No commas: the path is embedded in a `--mount type=bind,src=<path>,dst=<path>`
  // CSV spec, and docker's --mount parser splits fields on commas (shell escaping
  // cannot protect it). Spaces are fine.
  hostWorkspacePath: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^\//, 'Workspace path must be absolute')
    .regex(/^[^,]*$/, 'Workspace path must not contain commas (docker --mount is comma-delimited)')
    .regex(NO_SHELL_META, 'Invalid characters in workspace path'),
  containerWorkdir: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^\//, 'Container workdir must be absolute')
    .regex(/^[^,]*$/, 'Container workdir must not contain commas (docker --mount is comma-delimited)')
    .regex(NO_SHELL_META, 'Invalid characters in container workdir')
    .optional(),
  container: z
    .string()
    .min(2)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Invalid container name')
    .optional(),
});

/**
 * ADOPT an already-running container the user built and runs themselves. The
 * container name is REQUIRED (there is nothing to derive it from — we are not
 * creating it), and `hostWorkspacePath` still points at real host bytes so the
 * file routes, watchers and transcript correlation keep working exactly as they
 * do for an owned case. Everything that only makes sense at container-create
 * time (image, network, resources, gpus, credential mounts) is deliberately
 * absent: adoption never runs `docker create`.
 */
export const DockerCaseAdoptSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  hostId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid docker host id'),
  container: z
    .string()
    .min(2)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Invalid container name'),
  hostWorkspacePath: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^\//, 'Workspace path must be absolute')
    .regex(/^[^,]*$/, 'Workspace path must not contain commas (docker --mount is comma-delimited)')
    .regex(NO_SHELL_META, 'Invalid characters in workspace path'),
  containerWorkdir: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^\//, 'Container workdir must be absolute')
    .regex(/^[^,]*$/, 'Container workdir must not contain commas (docker --mount is comma-delimited)')
    .regex(NO_SHELL_META, 'Invalid characters in container workdir')
    .optional(),
});

/** Read-only adoption preflight: report on an existing container, link nothing. */
export const DockerAdoptPreflightSchema = z.object({
  hostId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid docker host id'),
  container: z
    .string()
    .min(2)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Invalid container name'),
  /** Optional: also verify this path exists INSIDE the container. */
  containerWorkdir: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^\//, 'Container workdir must be absolute')
    .regex(NO_SHELL_META, 'Invalid characters in container workdir')
    .optional(),
});

/** Read-only directory listing inside a container (adoption workdir picker). */
export const DockerBrowseSchema = z.object({
  hostId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid docker host id'),
  container: z
    .string()
    .min(2)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Invalid container name'),
  path: z
    .string()
    .max(2000)
    .regex(/^\//, 'Path must be absolute')
    .regex(NO_SHELL_META, 'Invalid characters in path')
    .optional(),
});

export const DockerExportSchema = z.object({
  mode: z.enum(['full', 'workspace']).optional(),
});

export const DockerImportSchema = z.object({
  // A bare filename resolved WITHIN the exports dir (never an arbitrary path).
  bundle: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[a-zA-Z0-9._-]+\.tgz$/, 'Invalid bundle filename'),
  newCaseName: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  destWorkspacePath: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^\//, 'Destination path must be absolute')
    .regex(/^[^,]*$/, 'Destination path must not contain commas (docker --mount is comma-delimited)')
    .regex(NO_SHELL_META, 'Invalid characters in destination path'),
});

// One-click "Run in Docker" case creation. name/description behave like a normal
// case; the docker fields are OPTIONAL overrides of the predefined defaults (the
// checkbox alone, with no overrides, uses the shared `default` host).
export const DockerQuickCreateSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  description: z.string().max(1000).optional(),
  image: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[a-zA-Z0-9][\w./:@-]*$/, 'Invalid image reference')
    .regex(NO_SHELL_META, 'Invalid characters in image reference')
    .optional(),
  network: z.enum(['bridge', 'none', 'custom']).optional(),
  networkName: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Invalid network name')
    .optional(),
  memory: z
    .string()
    .regex(/^\d+[bkmg]?$/i, 'Memory must be like 512m / 4g')
    .optional(),
  cpus: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'CPUs must be a number')
    .optional(),
  gpus: z
    .string()
    .max(128)
    .regex(/^(all|\d+|device=[a-zA-Z0-9,:._-]+)$/, 'GPUs must be all / a count / device=...')
    .optional(),
  mountCredentials: z.boolean().optional(),
});

// ========== Quick Start ==========

/**
 * Schema for POST /api/quick-start
 * Creates case (if needed) and starts interactive session.
 */
export const QuickStartSchema = z.object({
  caseName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format. Use only letters, numbers, hyphens, underscores.')
    .optional(),
  /** Display name for the created session tab (e.g. w1-mycase). Cosmetic; the durable
   *  mux/container names derive from the session id, not this. Defaults server-side. */
  sessionName: z.string().max(128).optional(),
  /** Session that spawned this one — see parentSessionIdSchema. */
  parentSessionId: parentSessionIdSchema,
  /** Model override written to <case>/.claude/settings.local.json (e.g. "opus[1m]").
   *  Empty string clears. Applied for local AND docker cases (the docker workspace is
   *  a real host dir, so the settings file crosses the bind mount); rejected for
   *  remote cases (the file would be written on the WRONG machine). */
  modelOverride: z.string().max(50).optional(),
  mode: sessionModeSchema().optional(),
  openCodeConfig: OpenCodeConfigSchema,
  codexConfig: CodexConfigSchema,
  geminiConfig: GeminiConfigSchema,
  antigravityConfig: AntigravityConfigSchema,
  piConfig: PiConfigSchema,
  grokConfig: GrokConfigSchema,
  deepSeekConfig: DeepSeekConfigSchema,
  ompConfig: OmpConfigSchema,
  envOverrides: safeEnvOverridesSchema,
  /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
  effort: effortLevelSchema,
  /**
   * Who is spawning this worker (`codeman-skill` from the packaged agent skill), or,
   * equivalently, the `X-Codeman-Agent-Origin` header; the body wins when both are
   * present. Used ONLY to label a case directory this request CREATES as an agent
   * scratch workspace, so it can be found and cleaned up later — see
   * `src/agent-case-marker.ts`. Never a permission signal, and an unrecognised token
   * is dropped rather than rejected. `POST /api/sessions` has no equivalent field
   * because it takes an existing `workingDir` and so never creates a directory to label.
   */
  agentOrigin: z.string().max(64).optional(),
});

// ========== Hook Events ==========

/**
 * Schema for POST /api/hook-event
 * Receives Claude Code hook events.
 */
export const HookEventSchema = z.object({
  event: z.enum([
    'permission_prompt',
    'elicitation_dialog',
    'elicitation_complete',
    'elicitation_response',
    'idle_prompt',
    'stop',
    'teammate_idle',
    'task_completed',
    // Claude Code's UserPromptSubmit: a first-hand report of the pane's live
    // conversation id. Keep in step with HookEventType in types/api.ts.
    'prompt_submitted',
    // A turn STARTED. Unlike the others this one has no Claude Code hook behind
    // it: it is reported by the DeepSeek Harness status shim, and exists so a
    // dialog answered in the terminal resolves its Approvals Inbox item at once
    // instead of lingering red until the next `stop`.
    'agent_working',
  ]),
  sessionId: z.string().min(1),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * Body of POST /api/approvals/:id/answer (Approvals Inbox).
 * `option` digits are additionally validated against the item's PARSED options
 * in the route; the schema alone must not authorize blind digit-poking.
 */
export const ApprovalAnswerSchema = z
  .object({
    action: z.enum(['approve', 'deny', 'option', 'text']),
    option: z.number().int().min(1).max(9).optional(),
    text: z.string().min(1).max(4000).optional(),
  })
  .strict();

/**
 * Body of PUT /api/sessions/:id/intent (Read My Mind). The 8192 cap mirrors
 * MAX_GOALS_CHARS in intent-store.ts.
 */
export const IntentGoalsSchema = z
  .object({
    goals: z.string().max(8192),
  })
  .strict();

/**
 * Body of POST /api/sessions/:id/readmymind (Read My Mind predict). Both
 * fields are the Rethink flow: `rejected` carries suggestions the user
 * dismissed (strong negative signal, fed back verbatim), `steer` an optional
 * free-text correction ("no, I meant the mobile bug").
 */
export const ReadMyMindPredictSchema = z
  .object({
    steer: z.string().max(2000).optional(),
    rejected: z.array(z.string().max(1000)).max(10).optional(),
  })
  .strict();

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
export const ConfigUpdateSchema = z
  .object({
    pollIntervalMs: z.number().int().min(100).max(60000).optional(),
    defaultTimeoutMs: z.number().int().min(1000).max(3600000).optional(),
    maxConcurrentSessions: z.number().int().min(1).max(50).optional(),
    respawn: RespawnConfigSchema.optional(),
  })
  .strict();

/**
 * Schema for PUT /api/settings
 * Explicit allowlist of known settings fields — prevents arbitrary key persistence.
 */
const NotificationEventSchema = z
  .object({
    enabled: z.boolean().optional(),
    browser: z.boolean().optional(),
    audio: z.boolean().optional(),
    push: z.boolean().optional(),
  })
  .optional();

export const SettingsUpdateSchema = z
  .object({
    // User-facing product branding. This changes browser/UI copy only; package,
    // CLI, API, storage, and protocol identifiers remain Codeman.
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .refine(
        (value) =>
          Array.from(value).every((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
          }),
        'Display name must not contain control characters'
      )
      .optional(),
    // Paths
    defaultClaudeMdPath: z.string().max(500).optional(),
    defaultWorkingDir: z.string().max(500).optional(),
    lastUsedCase: z.string().max(200).optional(),
    // Feature toggles
    ralphTrackerEnabled: z.boolean().optional(),
    subagentTrackingEnabled: z.boolean().optional(),
    subagentActiveTabOnly: z.boolean().optional(),
    /** Ultracode/Workflow run visualization (default OFF). Gates workflowRunWatcher + the master-detail tab. SYNCED. */
    showUltracodeAgents: z.boolean().optional(),
    /** Floating ultracode run windows w/ tab connector lines (default OFF). Also starts workflowRunWatcher. SYNCED. */
    ultracodeFloatingWindows: z.boolean().optional(),
    imageWatcherEnabled: z.boolean().optional(),
    /**
     * Inject the Codeman agent skill (`skills/codeman`) into `<case>/.claude/skills/`
     * on Claude session create, so an agent inside the session can drive the API
     * (see docs/agent-control-plan.md §2). SYNCED, default OFF: every skill's
     * name+description costs context on every turn, so it is opt-in. Injection is
     * add-only at create; a marker keeps user-authored copies untouched.
     */
    agentSkillEnabled: z.boolean().optional(),
    /**
     * Install Codeman's hooks block into the workspace of every Claude session,
     * not only into cases Codeman scaffolded itself. SYNCED, default ON: without
     * it a linked case or an existing repo runs with no hooks at all, and each
     * hook-driven surface is silently dead there (tab alert, Approvals Inbox,
     * push, respawn's definitive idle signals, the wait endpoints' stop/blocked).
     * Turning it OFF restores the older, narrower behavior — a Codeman hooks
     * block that is already present is still refreshed when stale, but one is
     * never added — for a user who wants Codeman to leave their repos alone.
     */
    workspaceHooksEnabled: z.boolean().optional(),
    /**
     * Let browser dictation transcribe through this machine's Claude Code login,
     * the same speech-to-text service the CLI's own `/voice` mode uses
     * (docs/claude-voice-plan.md). SYNCED, default OFF: enabling it spends the
     * operator's Claude subscription on transcription for anyone who can reach
     * the UI, and routes microphone audio to Anthropic rather than to whichever
     * provider was configured before. The Deepgram and Web Speech paths are
     * untouched by this flag.
     */
    claudeVoiceEnabled: z.boolean().optional(),
    /**
     * Approvals Inbox (header bell + drawer, phone overview answer buttons,
     * push Approve/Deny action buttons). SYNCED, default OFF (opt-in): even
     * with items pending, no surface renders and push payloads carry no
     * actions/approvalId until this is enabled. The server-side store and the
     * answer endpoints run regardless, so flipping it ON shows anything
     * already pending immediately.
     */
    approvalsInboxEnabled: z.boolean().optional(),
    /**
     * Read My Mind (docs/readmymind-plan.md): capture the user's submitted
     * prompts into per-case intent profiles. SYNCED, default OFF (opt-in:
     * captured prompts are sensitive). OFF stops capture immediately; already
     * stored profiles stay until DELETE /api/sessions/:id/intent.
     */
    readMyMindEnabled: z.boolean().optional(),
    /**
     * Custom Model Endpoint Profiles (deployment_plan.md): the toolbar picker that lets a
     * session point at a user-configured custom OpenAI-compatible endpoint (local or
     * cloud) instead of its native cloud backend. SYNCED, default OFF — endpoint entry,
     * discovery, and the extra toolbar surface are all opt-in.
     */
    customModelEndpointsEnabled: z.boolean().optional(),
    /**
     * Read My Mind predictor model override. Empty/absent = the AI-checker
     * default (opus: prediction quality is the product and it runs only on an
     * explicit press). Shell-safety is validated again at spawn time.
     */
    readMyMindModel: z.string().max(100).optional(),
    tunnelEnabled: z.boolean().optional(),
    // Action field (NOT persisted): explicit per-request acknowledgment that the
    // operator accepts exposing an UNAUTHENTICATED public tunnel (no CODEMAN_PASSWORD).
    // Lets the UI enable a tunnel after a confirm dialog without the
    // CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK env var. Stripped before persisting.
    acknowledgeUnauthTunnel: z.boolean().optional(),
    tabTwoRows: z.boolean().optional(),
    tabOrientation: z.enum(['horizontal', 'vertical']).optional(),
    tabRailWidth: z.number().int().min(208).max(360).optional(),
    tabRailDetail: z.enum(['simple', 'rich']).optional(),
    /**
     * Session list layout. Display key (per-device).
     * 'header'       = horizontal tab strip
     * 'sidebar'      = collapsible left sidebar, one compact row per session
     * 'sidebar-rich' = same sidebar, each row carrying the home screen's detail
     *                  (created/idle/working stamps + status pill)
     * Both sidebar values render the SAME docked column and set
     * data-session-list="sidebar"; they differ only in row detail, which rides
     * on data-sidebar-detail. See applySessionListLayout() in app.js.
     */
    sessionListLayout: z.enum(['header', 'sidebar', 'sidebar-rich']).optional(),
    /** Session-name text size in vertical navigation. Display key (per-device). */
    sessionSidebarFontSize: z.number().int().min(11).max(18).optional(),
    agentTeamsEnabled: z.boolean().optional(),
    /** Model for new Claude sessions (e.g. "claude-fable-5[1m]", "opus[1m]"); takes precedence over opusContext1mEnabled */
    claudeModel: z.string().max(50).optional(),
    opusContext1mEnabled: z.boolean().optional(),
    // COD-108 remote-session auto-reconnect kill-switch (default ON). When false,
    // the TmuxManager watcher does nothing — dropped remote sessions are NOT
    // auto-reattached.
    remoteAutoReconnect: z.boolean().optional(),
    thinkingEffort: z.string().max(20).optional(),
    // UI visibility
    showFontControls: z.boolean().optional(),
    showSystemStats: z.boolean().optional(),
    showTokenCount: z.boolean().optional(),
    showCost: z.boolean().optional(),
    showLifecycleLog: z.boolean().optional(),
    showResponseViewer: z.boolean().optional(),
    showMonitor: z.boolean().optional(),
    showProjectInsights: z.boolean().optional(),
    showFileBrowser: z.boolean().optional(),
    showSubagents: z.boolean().optional(),
    showMultiMonitorButton: z.boolean().optional(),
    showPlanUsageLimits: z.boolean().optional(),
    // Action field (NOT persisted as a setting): when true, (re)injects the
    // plan-usage statusLine exporter into active Claude sessions so live usage %
    // starts flowing. Sent on ENABLE only — the chip's DISPLAY is per-device
    // (client-side), but telemetry COLLECTION is server-side, so the per-device
    // toggle signals it out-of-band here rather than via showPlanUsageLimits.
    statusLineTelemetry: z.boolean().optional(),
    showRedrawButton: z.boolean().optional(),
    // Input
    gestureControlEnabled: z.boolean().optional(),
    // Claude CLI settings
    claudeMode: z.string().max(50).optional(),
    allowedTools: z.string().max(2000).optional(),
    // Codex CLI settings
    codexDangerouslyBypassApprovals: z.boolean().optional(),
    codexAnimationsEnabled: z.boolean().optional(),
    // Terminal history and retention
    terminalScrollbackLines: z
      .number()
      .int()
      .min(MIN_TERMINAL_SCROLLBACK_LINES)
      .max(MAX_TERMINAL_SCROLLBACK_LINES)
      .optional(),
    tmuxHistoryLimit: z.number().int().min(MIN_TERMINAL_SCROLLBACK_LINES).max(MAX_TERMINAL_SCROLLBACK_LINES).optional(),
    terminalBufferMaxBytes: z.number().int().min(MIN_TERMINAL_BUFFER_BYTES).max(MAX_TERMINAL_BUFFER_BYTES).optional(),
    terminalBufferTrimBytes: z.number().int().min(MIN_TERMINAL_BUFFER_BYTES).max(MAX_TERMINAL_BUFFER_BYTES).optional(),
    // CPU priority
    nice: z
      .object({
        enabled: z.boolean().optional(),
        niceValue: z.number().int().min(-20).max(19).optional(),
      })
      .optional(),
    // Notification preferences (cross-device sync)
    notificationPreferences: z
      .object({
        enabled: z.boolean().optional(),
        browserNotifications: z.boolean().optional(),
        audioAlerts: z.boolean().optional(),
        stuckThresholdMs: z.number().optional(),
        muteCritical: z.boolean().optional(),
        muteWarning: z.boolean().optional(),
        muteInfo: z.boolean().optional(),
        eventTypes: z
          .object({
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
          })
          .optional(),
        _version: z.number().optional(),
      })
      .optional(),
    // Voice settings (cross-device sync)
    voiceSettings: z
      .object({
        /** 'auto' | 'claude' | 'deepgram' | 'webspeech'. Unknown values fall back to auto client-side. */
        provider: z.string().max(20).optional(),
        apiKey: z.string().max(200).optional(),
        language: z.string().max(20).optional(),
        keyterms: z.string().max(500).optional(),
        insertMode: z.string().max(20).optional(),
      })
      .optional(),
    // Run mode preference (cross-device sync)
    runMode: z.string().max(20).optional(),
    // Custom respawn presets (cross-device sync, replaces localStorage-only storage)
    respawnPresets: z
      .array(
        z.object({
          id: z.string().max(100),
          name: z.string().max(100),
          config: z.object({
            idleTimeoutMs: z.number().optional(),
            updatePrompt: z.string().max(5000).optional(),
            interStepDelayMs: z.number().optional(),
            sendClear: z.boolean().optional(),
            sendInit: z.boolean().optional(),
            kickstartPrompt: z.string().max(5000).optional(),
            autoAcceptPrompts: z.boolean().optional(),
          }),
          durationMinutes: z.number().optional(),
          builtIn: z.boolean().optional(),
          createdAt: z.number().optional(),
        })
      )
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((settings, ctx) => {
    if (
      settings.terminalBufferMaxBytes !== undefined &&
      settings.terminalBufferTrimBytes !== undefined &&
      settings.terminalBufferTrimBytes > settings.terminalBufferMaxBytes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminalBufferTrimBytes'],
        message: 'terminalBufferTrimBytes must be less than or equal to terminalBufferMaxBytes',
      });
    }
  });

/**
 * Schema for POST /api/sessions/:id/input with length limit
 */
export const SessionInputWithLimitSchema = z.object({
  input: z.string().max(100000), // 100KB max input
  useMux: z.boolean().optional(),
  // Reliable-delivery dedup (optional; absent for curl/legacy clients). The web
  // client tags each input with a stable clientId + a monotonic per-session seq
  // and redelivers anything it hasn't seen ACKed (e.g. a frame silently dropped
  // by a half-open WebSocket on a flaky link). The server applies each (clientId,
  // seq) at-most-once via Session.shouldApplyInput so a redelivery can't type the
  // prompt twice. `.optional()` (not `.nullish()`) — the client omits them when
  // unset rather than sending null. See docs/reliable-input-delivery.md.
  seq: z.number().int().nonnegative().optional(),
  clientId: z.string().max(128).optional(),
  // Send-and-wait (agent orchestration): `true` for the default signal set, or the
  // same grammar as `GET .../wait` — a comma string or an array of signals. Absent
  // means the historical fire-and-forget behavior, byte for byte.
  //
  // `.nullish()`, not `.optional()`: a third-party caller building the body with
  // JSON.stringify keeps an explicit null on the wire, and `.optional()` rejects it
  // with INVALID_INPUT. That gotcha has shipped as a real bug twice.
  wait: z.union([z.boolean(), z.string().max(120), z.array(z.string().max(120)).max(8)]).nullish(),
  // Unbounded above: the effective value is clamped to MAX_WAIT_MS server-side and
  // returned as `data.wait.timeoutMs`, so a caller that asks for 24h sees what it
  // actually got. A `.max()` here would turn the same documented clamp into a 400 for
  // large-enough guesses, which is the one behaviour an agent cannot predict.
  waitTimeout: z.number().int().positive().nullish(),
});

/**
 * Query validation for `GET /api/sessions/:id/wait` (agent wait primitives).
 *
 * Everything arrives as a string. `timeout` is coerced and bounded here, then
 * clamped again to the operator's ceiling by `clampWaitMs()` — the schema bound
 * only keeps an absurd number out of the arithmetic. A non-numeric `timeout` is a
 * 400 rather than a silent fallback, so an agent never believes it asked for a
 * longer wait than it got; the value actually applied comes back as
 * `data.wait.timeoutMs`, which is what makes the clamp observable. `until` is
 * parsed by `parseWaitSignals()`, which reports unknown tokens instead of
 * dropping them.
 *
 * `until` accepts an ARRAY as well as the comma string: `?until=stop&until=exit`
 * is how most HTTP clients express a list, Fastify's query parser delivers a
 * repeated parameter as an array, and `parseWaitSignals()` has always handled
 * both. Rejecting the repeated form left that branch unreachable and 400'd the
 * more natural spelling.
 */
export const SessionWaitQuerySchema = z.object({
  until: z.union([z.string().max(120), z.array(z.string().max(120)).max(8)]).optional(),
  // No upper bound on purpose. The contract is "clamped to [MIN_WAIT_MS, MAX_WAIT_MS]",
  // and a `.max()` here contradicted it: `timeout=99999999` was a 400 mid-fan-out while
  // `timeout=600001` was silently clamped, so the same documented rule produced two
  // different outcomes depending on how big the caller's guess was. `clampWaitMs()`
  // bounds every finite value, and `.int()` still rejects `Infinity`/`1e999` and junk.
  timeout: z.coerce.number().int().positive().optional(),
  fresh: z.enum(['0', '1', 'true', 'false']).optional(),
});

/**
 * Query validation for `GET /api/sessions/:id/wait-output`.
 *
 * `match` is a LITERAL substring, never a pattern: `search-service.ts` avoids regex
 * so there is no ReDoS surface, and this endpoint is more exposed still (the pattern
 * would be caller-supplied and the input is a live stream). The length bound is a
 * second reason the carry buffer stays small. The route separately rejects a `regex`
 * parameter outright rather than ignoring it.
 */
export const SessionWaitOutputQuerySchema = z.object({
  match: z.string().min(MIN_MATCH_LENGTH).max(MAX_MATCH_LENGTH),
  nocase: z.enum(['0', '1', 'true', 'false']).optional(),
  from: z.enum(['now', 'buffer']).optional(),
  // Unbounded above for the same reason as SessionWaitQuerySchema.timeout: clamping is
  // the documented contract, so a large value must clamp rather than 400.
  timeout: z.coerce.number().int().positive().optional(),
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
  maxTodos: z.number().int().positive().max(10000).optional(),
  todoExpirationMinutes: z.number().int().positive().max(525600).optional(),
  reset: z.union([z.boolean(), z.literal('full')]).optional(),
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

/** POST /api/sessions/:id/auto-resume */
export const AutoResumeSchema = z.object({
  enabled: z.boolean(),
});

/** POST /api/sessions/:id/pin (COD-139) — explicit pin state for idempotency. */
export const PinSessionSchema = z.object({
  pinned: z.boolean(),
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
  envOverrides: safeEnvOverridesSchema,
});

/** POST /api/scheduled */
export const ScheduledRunSchema = z.object({
  prompt: z.string().min(1).max(100000),
  workingDir: safePathSchema.optional(),
  durationMinutes: z.number().int().min(1).max(14400).optional(),
});

// ========== Cron Jobs ==========

/** 'HH:MM' 24-hour time. */
const hhmmSchema = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24-hour)');

/** Prompt delivery is single-line only (writeViaMux/Ink constraint) — reject newlines outright. */
const noNewlines = (v: string) => !/[\r\n]/.test(v);

/** Shared field shape for creating/updating a scheduled job. */
const CronJobBaseSchema = z.object({
  name: z.string().min(1).max(200),
  agentType: sessionModeSchema(),
  workingDir: safePathSchema,
  launchCommand: z.string().max(2000).refine(noNewlines, 'launchCommand must be a single line').optional(),
  promptMode: z.enum(['inline_text', 'prompt_file_path']),
  promptText: z
    .string()
    .max(100000)
    .refine(noNewlines, 'promptText must be a single line (multi-line prompts are not supported)')
    .optional(),
  promptFilePath: safePathSchema.optional(),
  inputMode: z.enum(['paste', 'typed']),
  scheduleType: z.enum(['once', 'interval', 'daily', 'weekly']),
  runAt: z.number().int().positive().optional(),
  intervalMinutes: z.number().int().min(1).max(525600).optional(),
  dailyTime: hhmmSchema.optional(),
  weeklyDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  weeklyTime: hhmmSchema.optional(),
  enabled: z.boolean(),
  notes: z.string().max(2000).optional(),
  concurrencyPolicy: z.enum(['warn_only', 'skip_if_same_agent_running']),
  autoClosePreviousSession: z.boolean().optional(),
});

/** Cross-field validation: required fields depend on promptMode + scheduleType. */
function refineCronJob(val: z.infer<typeof CronJobBaseSchema>, ctx: z.RefinementCtx): void {
  const add = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });

  if (val.promptMode === 'inline_text' && !val.promptText) {
    add('promptText is required when promptMode is inline_text', 'promptText');
  }
  if (val.promptMode === 'prompt_file_path' && !val.promptFilePath) {
    add('promptFilePath is required when promptMode is prompt_file_path', 'promptFilePath');
  }
  if (val.scheduleType === 'once' && val.runAt === undefined) {
    add('runAt is required for a one-time schedule', 'runAt');
  }
  if (val.scheduleType === 'interval' && val.intervalMinutes === undefined) {
    add('intervalMinutes is required for an interval schedule', 'intervalMinutes');
  }
  if (val.scheduleType === 'daily' && !val.dailyTime) {
    add('dailyTime is required for a daily schedule', 'dailyTime');
  }
  if (val.scheduleType === 'weekly' && (!val.weeklyTime || !val.weeklyDays?.length)) {
    add('weeklyDays and weeklyTime are required for a weekly schedule', 'weeklyTime');
  }
}

/** POST /api/cron/jobs — full job definition. */
export const CronJobSchema = CronJobBaseSchema.superRefine(refineCronJob);

/** PUT /api/cron/jobs/:id — partial update. */
export const CronJobUpdateSchema = CronJobBaseSchema.partial();

/** PUT /api/cron/jobs/:id/enabled */
export const CronJobEnabledSchema = z.object({ enabled: z.boolean() });

/** POST /api/cases/link */
export const LinkCaseSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format'),
  path: safePathSchema,
});

/** PUT /api/cases/order */
export const CaseOrderSchema = z.object({
  order: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format')),
});

/** PUT /api/session-order — global tab order (ordered sessionIds), COD-131 */
export const SessionOrderUpdateSchema = z.object({
  // Bounded defensively: ids are uuid-ish (<=100 chars) and the client pushes only
  // its open-tab order (max sessions is 50) — 500 leaves ample headroom while
  // keeping a hostile/buggy client from persisting megabytes into state.json.
  order: z.array(z.string().max(100)).max(500),
});

/** POST /api/auth/revoke */
export const RevokeSessionSchema = z.object({
  sessionToken: z.string().min(1).max(200).optional(),
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
export const SubagentWindowStatesSchema = z
  .object({
    minimized: z.record(z.string(), z.boolean()).optional(),
    open: z.array(z.string()).optional(),
  })
  .passthrough();

/** PUT /api/subagent-parents */
export const SubagentParentMapSchema = z.record(z.string(), z.string());

/** POST /api/sessions/:id/interactive */
export const InteractiveStartSchema = z.object({
  /**
   * COD-118: explicit user-initiated restart — clears a tripped PTY-exit circuit
   * breaker before starting. Automatic reconnect/re-attach callers (e.g. the
   * frontend's selectSession auto-attach) must NOT send this flag.
   */
  clearBreaker: z.boolean().optional(),
});

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
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine(isSafePushEndpoint, { message: 'endpoint must be an https URL to a public (non-internal) host' }),
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
  caseName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid case name format')
    .optional()
    .default('testcase'),
  taskDescription: z.string().min(1).max(100000),
  completionPhrase: z.string().max(100).default('COMPLETE'),
  maxIterations: z.number().int().min(0).max(1000).nullable().default(10),
  enableRespawn: z.boolean().default(false),
  envOverrides: safeEnvOverridesSchema,
  /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
  effort: effortLevelSchema,
  planItems: z
    .array(
      z.object({
        content: z.string(),
        priority: z.string().optional(),
        enabled: z.boolean().default(true),
      })
    )
    .optional(),
});

// ========== Orchestrator Loop ==========

/** POST /api/orchestrator/start */
export const OrchestratorStartSchema = z.object({
  goal: z.string().min(1).max(100000),
  config: z
    .object({
      plannerModel: z.string().max(100).optional(),
      researchEnabled: z.boolean().optional(),
      autoApprove: z.boolean().optional(),
      maxPhaseRetries: z.number().int().min(1).max(10).optional(),
      phaseTimeoutMs: z.number().int().min(60000).max(7200000).optional(),
      enableTeamAgents: z.boolean().optional(),
      maxParallelSessions: z.number().int().min(1).max(10).optional(),
      verificationMode: z.enum(['strict', 'moderate', 'lenient']).optional(),
      compactBetweenPhases: z.boolean().optional(),
    })
    .optional(),
});

/** POST /api/orchestrator/reject */
export const OrchestratorRejectSchema = z.object({
  feedback: z.string().min(1).max(10000),
});

// ========== Cross-Session Search (COD-9) ==========

/** Valid federated source kinds for `GET /api/search?types=`. */
export const SEARCH_SOURCE_TYPES = ['session', 'event', 'file'] as const;

/**
 * GET /api/search query validation.
 *
 * Query params arrive as strings: `q` is bounded (1..200 chars), `types` is an
 * optional comma-separated allowlisted CSV, and `limit` is an optional coerced
 * integer clamped to 1..60. Validation is the first line of defense — a missing
 * or oversized `q`, an unknown type, or a non-numeric limit is rejected with 400.
 */
export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Query is required').max(200, 'Query too long (max 200 chars)'),
  types: z
    .string()
    .max(100)
    .optional()
    .refine(
      (v) =>
        v === undefined ||
        v
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .every((t) => (SEARCH_SOURCE_TYPES as readonly string[]).includes(t)),
      { message: 'Invalid types value' }
    ),
  limit: z.coerce.number().int().min(1).max(60).optional(),
});

// ========== Web Tabs (dashboard URLs) ==========

/**
 * A dashboard URL. `isValidWebviewUrl` rejects anything that is not plain
 * http/https, anything carrying embedded credentials, and anything without a
 * hostname. See `src/web/webview-proxy.ts` for why each of those matters.
 */
const webviewUrlSchema = z
  .string()
  .trim()
  .min(1, 'URL is required')
  .max(2000, 'URL too long (max 2000 chars)')
  .refine(isValidWebviewUrl, {
    message: 'Invalid URL: must be http(s), with a hostname and no embedded credentials',
  })
  // Egress policy (`webview-egress-policy.ts`): no dashboard lives at a link-local
  // or cloud-metadata address, while an IAM credential does. Refused at save time
  // for the clear message; the proxy re-judges the RESOLVED address at connect time.
  .refine((url) => !isBlockedWebviewUrl(url), {
    message:
      'Blocked URL: link-local and cloud-metadata addresses (169.254.0.0/16, metadata.google.internal, ...) cannot be dashboards',
  });

const WebviewBaseSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60, 'Name too long (max 60 chars)'),
  url: webviewUrlSchema,
  /** A single glyph shown on the tab. Bounded generously: one emoji can be several code units. */
  icon: z.string().max(8).optional(),
  embedMode: z.enum(['proxy', 'direct']).optional(),
  /**
   * Opt out of the iframe sandbox. Defaults to false: a proxied page is served
   * from Codeman's own origin, so `allow-same-origin` would let it read this page
   * and call the API that spawns agents.
   */
  trusted: z.boolean().optional(),
  /**
   * Marks a record Codeman maintains itself. Declared here because a plain
   * `z.object` STRIPS undeclared keys, so an undeclared marker would be dropped
   * on the way in and the dedup it drives would never fire.
   */
  managed: z.enum(['deepseek-web']).optional(),
});

/** POST /api/webviews */
export const WebviewCreateSchema = WebviewBaseSchema;

/** PATCH /api/webviews/:id, partial update. */
export const WebviewUpdateSchema = WebviewBaseSchema.partial();

/** POST /api/webviews/probe: reachability + framing check for the editor's Test button. */
export const WebviewProbeSchema = z.object({ url: webviewUrlSchema });
