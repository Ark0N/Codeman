/**
 * @fileoverview Claude Code hooks configuration generator
 *
 * Generates .claude/settings.local.json with hook definitions that POST
 * to Claudeman's /api/hook-event endpoint when Claude Code fires
 * notification or stop hooks. Uses $CLAUDEMAN_API_URL and
 * $CLAUDEMAN_SESSION_ID env vars (set on every managed session) so the
 * config is static per case directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HookEventType } from './types.js';

/**
 * Generates the hooks section for .claude/settings.local.json
 *
 * The hook commands read stdin JSON from Claude Code (contains tool_name,
 * tool_input, etc.) and forward it as the `data` field to Claudeman's API.
 * Env vars are resolved at runtime by the shell, so the config is static
 * per case directory.
 */
export function generateHooksConfig(): { hooks: Record<string, unknown[]> } {
  // Read Claude Code's stdin JSON and forward it as the data field.
  // Falls back to empty object if stdin is unavailable or malformed.
  const curlCmd = (event: HookEventType) =>
    `HOOK_DATA=$(cat 2>/dev/null || echo '{}'); ` +
    `curl -s -X POST "$CLAUDEMAN_API_URL/api/hook-event" ` +
    `-H 'Content-Type: application/json' ` +
    `-d "{\\"event\\":\\"${event}\\",\\"sessionId\\":\\"$CLAUDEMAN_SESSION_ID\\",\\"data\\":$HOOK_DATA}" ` +
    `2>/dev/null || true`;

  return {
    hooks: {
      Notification: [
        {
          matcher: 'idle_prompt',
          hooks: [{ type: 'command', command: curlCmd('idle_prompt'), timeout: 10000 }],
        },
        {
          matcher: 'permission_prompt',
          hooks: [{ type: 'command', command: curlCmd('permission_prompt'), timeout: 10000 }],
        },
        {
          matcher: 'elicitation_dialog',
          hooks: [{ type: 'command', command: curlCmd('elicitation_dialog'), timeout: 10000 }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: curlCmd('stop'), timeout: 10000 }],
        },
      ],
    },
  };
}

/**
 * Writes hooks config to .claude/settings.local.json in the given case path.
 * Merges with existing file content, only touching the `hooks` key.
 */
export function writeHooksConfig(casePath: string): void {
  const claudeDir = join(casePath, '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const settingsPath = join(claudeDir, 'settings.local.json');
  let existing: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      // If file is malformed, start fresh
      existing = {};
    }
  }

  const hooksConfig = generateHooksConfig();
  const merged = { ...existing, ...hooksConfig };

  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}
