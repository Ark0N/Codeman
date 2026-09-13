/**
 * @fileoverview Pure functions for building CLI arguments and environment variables
 * for Claude and OpenCode CLI spawning.
 *
 * Extracted from Session to keep argument construction logic testable and
 * separate from PTY lifecycle management.
 *
 * @module session-cli-builder
 */

import type { ClaudeMode, EffortLevel } from './types.js';
import { isEffortLevel } from './types.js';
import { getAugmentedPath } from './utils/index.js';
import { compareVersions } from './utils/dependency-checker.js';
import { dataPath } from './config/instance.js';
import { getCli } from './config/cli-registry/registry.js';

/**
 * Build Claude CLI permission flags based on the configured mode.
 * Returns an array of args to pass to the CLI.
 */
function buildPermissionArgs(claudeMode: ClaudeMode, allowedTools?: string): string[] {
  switch (claudeMode) {
    case 'dangerously-skip-permissions':
      return ['--dangerously-skip-permissions'];
    case 'auto':
      return ['--permission-mode', 'auto'];
    case 'allowedTools':
      if (allowedTools) {
        return ['--allowedTools', allowedTools];
      }
      // Fall back to normal mode if no tools specified
      return [];
    case 'normal':
    default:
      return [];
  }
}

/**
 * Build the CLI args carrying the effort level as a SOFT default (switchable
 * in-session via /effort). The CLAUDE_CODE_EFFORT_LEVEL env var is deliberately
 * avoided — it hard-locks effort and blocks in-session `/effort` switching.
 *
 * Two carriers are needed because neither covers all levels:
 * - regular levels (incl. `max`) → `--effort <level>` (the settings `effortLevel`
 *   key is enum(["low","medium","high","xhigh"]) with .catch(undefined), so `max`
 *   would be SILENTLY dropped there)
 * - `ultracode` → `--settings '{"ultracode":true}'` (its own boolean settings key,
 *   claude >= 2.1.154; rejected by the --effort flag)
 */
export function buildEffortCliArgs(effort?: EffortLevel): string[] {
  if (!effort || !isEffortLevel(effort)) return [];
  return effort === 'ultracode' ? ['--settings', '{"ultracode":true}'] : ['--effort', effort];
}

/**
 * Minimum Claude CLI version for passing `--name` at spawn. 2.1.224 is the release
 * that ships cross-session messaging (the feature that makes the peer name matter),
 * and the flag's presence at exactly this version was verified against the installed
 * binary (`2.1.224 --help` lists `-n, --name`). The gate MUST stay fail-closed: an
 * older or unknown CLI aborts startup on an unknown flag ("error: unknown option"),
 * which would kill every session spawn: so no version means no flag, and the
 * command line stays byte-identical to the pre-`--name` one.
 */
export const CLAUDE_NAME_FLAG_MIN_VERSION = '2.1.224';

/**
 * Reduce a Codeman session name to a string safe to pass as the Claude CLI
 * `--name` value. Allowlist, not escaping: keeps Unicode letters/digits (CJK
 * session names survive) plus ` . _ : -`, which excludes every character that is
 * special inside the double-quoted shell interpolation buildSpawnCommand uses
 * (`"`, `$`, backslash, backtick) as well as newlines. Leading dashes/punctuation
 * are stripped so the value can never be parsed as another CLI option, and the
 * result is capped at 64 chars. Returns undefined when nothing safe remains;
 * callers must then omit the flag entirely (never send `--name ""`).
 */
export function sanitizeCliSessionName(name?: string): string | undefined {
  if (!name) return undefined;
  const cleaned = name
    .replace(/[^\p{L}\p{N} ._:-]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._:-]+/, '')
    .trim()
    .slice(0, 64)
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Build the `--name <session name>` args pair, version-gated and fail-closed.
 * Returns [] unless the CLI version is KNOWN to support the flag (>= 2.1.224):
 * a null/undefined version (probe failed, or running under vitest where
 * getClaudeCliVersion() is hermetically null) yields [], keeping the spawn
 * command identical to a Codeman without this feature. The name itself is a
 * SOFT default, exactly like model and effort: `/rename` in-session still works.
 */
export function buildNameCliArgs(sessionName: string | undefined, cliVersion: string | null | undefined): string[] {
  if (!cliVersion || compareVersions(cliVersion, CLAUDE_NAME_FLAG_MIN_VERSION) < 0) return [];
  const name = sanitizeCliSessionName(sessionName);
  return name ? ['--name', name] : [];
}

/**
 * Build args for an interactive Claude CLI session (direct PTY, non-mux fallback).
 *
 * @param sessionId - The Codeman session ID (passed as --session-id to Claude)
 * @param claudeMode - Permission mode for the CLI
 * @param model - Optional model override (e.g., 'opus', 'sonnet')
 * @param allowedTools - Optional comma-separated allowed tools list
 * @param effort - Optional effort level, injected via --settings (overridable in-session)
 * @param sessionName - Optional Codeman session name, passed as `--name` (version-gated)
 * @param cliVersion - Installed Claude CLI version for the `--name` gate (null = omit the flag)
 * @returns Array of CLI arguments
 */
export function buildInteractiveArgs(
  sessionId: string,
  claudeMode: ClaudeMode,
  model?: string,
  allowedTools?: string,
  effort?: EffortLevel,
  sessionName?: string,
  cliVersion?: string | null
): string[] {
  const args = [...buildPermissionArgs(claudeMode, allowedTools), '--session-id', sessionId];
  if (model) args.push('--model', model);
  args.push(...buildEffortCliArgs(effort));
  args.push(...buildNameCliArgs(sessionName, cliVersion));
  return args;
}

/**
 * Build args for a one-shot Claude CLI prompt (runPrompt mode).
 *
 * @param prompt - The prompt text to send
 * @param model - Optional model override
 * @returns Array of CLI arguments
 */
export function buildPromptArgs(
  prompt: string,
  model?: string,
  claudeMode: ClaudeMode = 'dangerously-skip-permissions',
  allowedTools?: string
): string[] {
  // Respect the session's permission mode instead of always skipping, so a
  // multi-user non-granted user's one-shot runs classifier-guarded (auto) rather
  // than with full bypass. Defaults to skip-permissions (unchanged single-user).
  const args = ['-p', '--verbose', ...buildPermissionArgs(claudeMode, allowedTools), '--output-format', 'stream-json'];
  if (model) {
    args.push('--model', model);
  }
  args.push(prompt);
  return args;
}

/**
 * Build environment variables for Claude CLI processes (direct PTY, non-mux).
 *
 * Augments process.env with:
 * - UTF-8 locale settings
 * - Augmented PATH (includes Claude CLI directory)
 * - xterm-256color terminal type
 * - Codeman session identification vars
 *
 * @param sessionId - The Codeman session ID
 * @returns Environment variables object for pty.spawn
 */
export function buildClaudeEnv(sessionId: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    PATH: getAugmentedPath(),
    TERM: 'xterm-256color',
    // Inform Claude it's running within Codeman (helps prevent self-termination)
    CODEMAN_MUX: '1',
    CODEMAN_SESSION_ID: sessionId,
    // CODEMAN_API_URL rides in via the process.env spread when the server has
    // stamped it (WebServer.start()); no fallback: a hardcoded one was the wrong
    // scheme on HTTPS installs, and a present-with-undefined key would serialize
    // as the literal "CODEMAN_API_URL=undefined" (COD-115).
    // Path only (not the secret value) — hook curls cat it at execution time (COD-54)
    CODEMAN_HOOK_SECRET_FILE: dataPath('hook-secret'),
  };
  // The colour and identity vars come from the registry entry, the same source
  // buildEnvExports() and buildMuxAttachEnv() read, so this fallback cannot drift from
  // the tmux pane the way a hand-maintained list here did.
  // COD-115: `delete`, not `= undefined` — node-pty serializes a present-with-undefined
  // key as the literal string "KEY=undefined" (see buildMuxAttachEnv below).
  const cliEnv = getCli('claude')?.env;
  for (const name of cliEnv?.unset ?? []) delete env[name];
  for (const item of cliEnv?.exports ?? []) {
    // A direct PTY has no mux, so `muxName` has no value to resolve against. Claude
    // declares literals only; an unresolvable engine value is skipped, never guessed.
    const value =
      typeof item.value === 'string'
        ? item.value
        : item.value.engine === 'sessionId'
          ? sessionId
          : item.value.engine === 'codemanPrefixedSessionId'
            ? `codeman_${sessionId}`
            : undefined;
    if (value !== undefined) env[item.name] = value;
  }
  return env;
}

/**
 * Build environment variables for mux-attached PTY sessions (tmux attach).
 * Lighter than buildClaudeEnv — no PATH augmentation or Codeman vars needed
 * since the mux session already has those set.
 *
 * @param truecolorEnabled - When true, set COLORTERM=truecolor (COD-75 opt-in);
 *   otherwise leave COLORTERM unset. Mirrors buildEnvExports() so both paths agree.
 * @returns Environment variables object for pty.spawn
 */
export function buildMuxAttachEnv(truecolorEnabled?: boolean): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
  };
  // COD-115: keys to UNSET must be `delete`d, NOT set to `undefined`. On a
  // `{...process.env}` spread the key stays present with value undefined, and node-pty
  // serializes it as the literal string "TMUX=undefined" — a non-empty value that still
  // trips tmux's nesting guard, killing the attach-bridge PTY (exit 1 → respawn loop).
  // The server can be launched from inside tmux; attach clients must never inherit that
  // parent tmux context. (Same fix the working create path uses in tmux-manager.ts.)
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CLAUDECODE;
  if (truecolorEnabled) {
    env.COLORTERM = 'truecolor';
  } else {
    delete env.COLORTERM; // COD-75: unset for non-truecolor (was `: undefined`, same node-pty quirk)
  }
  return env;
}

/**
 * Build environment variables for a direct shell session (non-mux fallback).
 *
 * @param sessionId - The Codeman session ID
 * @returns Environment variables object for pty.spawn
 */
export function buildShellEnv(sessionId: string): Record<string, string | undefined> {
  return {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    CODEMAN_MUX: '1',
    CODEMAN_SESSION_ID: sessionId,
    // CODEMAN_API_URL rides in via the process.env spread when set; no fallback
    // (same reasoning as buildClaudeEnv above).
    // Path only (not the secret value) — hook curls cat it at execution time (COD-54)
    CODEMAN_HOOK_SECRET_FILE: dataPath('hook-secret'),
  };
}
