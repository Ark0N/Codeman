/**
 * @fileoverview Claude Code hooks configuration generator
 *
 * Generates .claude/settings.local.json with hook definitions that POST
 * to Codeman's /api/hook-event endpoint when Claude Code fires
 * notification or stop hooks. Uses $CODEMAN_API_URL and
 * $CODEMAN_SESSION_ID env vars (set on every managed session) so the
 * config is static per case directory.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { HookEventType } from './types.js';

/**
 * Generates the hooks section for .claude/settings.local.json
 *
 * The hook commands read stdin JSON from Claude Code (contains tool_name,
 * tool_input, etc.) and forward it as the `data` field to Codeman's API.
 * Env vars are resolved at runtime by the shell, so the config is static
 * per case directory.
 */
export function generateHooksConfig(): { hooks: Record<string, unknown[]> } {
  // Read Claude Code's stdin JSON and forward it as the data field.
  // Falls back to empty object if stdin is unavailable or malformed.
  const curlCmd = (event: HookEventType) =>
    `HOOK_DATA=$(cat 2>/dev/null || echo '{}'); ` +
    `curl -s -X POST "$CODEMAN_API_URL/api/hook-event" ` +
    `-H 'Content-Type: application/json' ` +
    `-d "{\\"event\\":\\"${event}\\",\\"sessionId\\":\\"$CODEMAN_SESSION_ID\\",\\"data\\":$HOOK_DATA}" ` +
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
      TeammateIdle: [
        {
          hooks: [{ type: 'command', command: curlCmd('teammate_idle'), timeout: 10000 }],
        },
      ],
      TaskCompleted: [
        {
          hooks: [{ type: 'command', command: curlCmd('task_completed'), timeout: 10000 }],
        },
      ],
    },
  };
}

/**
 * Updates env vars in .claude/settings.local.json for the given case path.
 * Merges with existing env field; removes vars set to empty string.
 */
export async function updateCaseEnvVars(casePath: string, envVars: Record<string, string>): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  if (!existsSync(claudeDir)) {
    await mkdir(claudeDir, { recursive: true });
  }

  const settingsPath = join(claudeDir, 'settings.local.json');
  let existing: Record<string, unknown> = {};

  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
  } catch {
    existing = {};
  }

  const currentEnv = (existing.env as Record<string, string>) || {};
  for (const [key, value] of Object.entries(envVars)) {
    if (value) {
      currentEnv[key] = value;
    } else {
      delete currentEnv[key];
    }
  }
  existing.env = currentEnv;

  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
}

/**
 * Writes hooks config to .claude/settings.local.json in the given case path.
 * Merges with existing file content, only touching the `hooks` key.
 */
export async function writeHooksConfig(casePath: string): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  if (!existsSync(claudeDir)) {
    await mkdir(claudeDir, { recursive: true });
  }

  const settingsPath = join(claudeDir, 'settings.local.json');
  let existing: Record<string, unknown> = {};

  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
  } catch {
    // If file is malformed or doesn't exist, start fresh
    existing = {};
  }

  const hooksConfig = generateHooksConfig();
  const merged = { ...existing, ...hooksConfig };

  await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}
