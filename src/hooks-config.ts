/**
 * @fileoverview Claude Code hooks configuration generator.
 *
 * Generates `.claude/settings.local.json` with hook definitions that POST
 * to Codeman's `/api/hook-event` endpoint when Claude Code fires hooks.
 * Uses `$CODEMAN_API_URL`, `$CODEMAN_SESSION_ID`, and `$CODEMAN_HOOK_SECRET_FILE`
 * env vars (set on every managed session) so the config is static per case
 * directory and free of secret values.
 *
 * Key exports:
 * - `generateHooksConfig()` — returns hooks object for settings.local.json
 * - `writeHooksConfig(casePath)` — writes hooks + env config to disk
 * - `applyWorkspaceHooks(workspace, install?)` — the ONE install-vs-refresh decision
 *   point every claude-session create path routes through (see its doc comment)
 * - `ensureCodemanHooks(casePath)` — safely installs/updates hooks for a managed case
 * - `updateCaseEnvVars(casePath, envVars)` — merges env vars into settings
 *
 * Hook events generated: `idle_prompt`, `permission_prompt`, `elicitation_dialog`,
 * `elicitation_complete`, `elicitation_response`, `stop`, `teammate_idle`,
 * `task_completed`
 *
 * Hook categories: `Notification` (5 matchers), `Stop` (1), `SubagentStop` (1),
 * `TeammateIdle` (1), `TaskCompleted` (1), `PostToolUse` (1 self-contained
 * background Bash rewake)
 *
 * @dependencies types (HookEventType), config/auth-config (HOOK_TIMEOUT_SECONDS)
 * @consumedby web/server (session creation), session-cli-builder (env setup)
 *
 * @module hooks-config
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, lstat, readdir, realpath, rename, unlink, rmdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HookEventType } from './types.js';
import { HOOK_TIMEOUT_SECONDS } from './config/auth-config.js';
import { dataPath } from './config/instance.js';

/**
 * Serializes read-modify-write access to a `settings.local.json` path. Every
 * writer in this module (hooks, env, model, statusLine) shares this map, so
 * concurrent updates to the SAME file — e.g. session-create writing hooks/model
 * while an App-Settings toggle injects the statusLine into the same repo — can't
 * lose each other's changes through interleaved read-then-write. Per-path chains
 * are independent; the map self-prunes when a path's chain goes idle.
 *
 * The agent-skill injector keys the same map on its skill DIRECTORY, which can never
 * collide with a settings-file path, so those writers serialize against each other too.
 */
const settingsWriteLocks = new Map<string, Promise<unknown>>();
/**
 * Version-agnostic ownership prefix: every rewake script version embeds a marker
 * starting with this, and `isCodemanHookHandler` matches on the prefix. That way a
 * version bump replaces the old handler instead of duplicating it (matching on the
 * full versioned marker would disown every older script).
 */
const BACKGROUND_WAKE_MARKER_PREFIX = 'CODEMAN_BACKGROUND_REWAKE_V';
/**
 * Current script version. Bump the suffix whenever `generateBackgroundWakeScript`
 * changes: `refreshStaleCodemanHooks` treats the absence of the CURRENT marker as
 * stale, so healed cases pick up the new script on next launch.
 */
const BACKGROUND_WAKE_MARKER = `${BACKGROUND_WAKE_MARKER_PREFIX}3`;
const SUBAGENT_STOP_GUARD_MARKER_PREFIX = 'CODEMAN_SUBAGENT_STOP_GUARD_V';
const SUBAGENT_STOP_GUARD_MARKER = `${SUBAGENT_STOP_GUARD_MARKER_PREFIX}1`;
const BACKGROUND_WAKE_TIMEOUT_SECONDS = 6 * 60 * 60;

/**
 * Inline Node helper for Claude Code's `asyncRewake` hook.
 *
 * A background Bash tool returns immediately with a task ID, then Claude writes
 * its completion as a queue-operation in the top-level transcript. Subagent hooks
 * receive their own transcript path even though their completion is parent-owned,
 * so the helper watches both paths. Watching durable records avoids injecting
 * terminal input (which could submit a user's draft).
 * The helper is embedded in settings via `node -e`, so it has no script path
 * that can go stale after an install or plugin-cache cleanup.
 *
 * Self-terminating: Claude Code enforces the hook timeout, but the helper does not
 * rely on it. It exits on its own deadline (same budget) and when orphaned
 * (`ppid === 1`), so a dead session cannot leave a poller stat-ing the transcript
 * forever. The ppid check misses subreaper setups; the deadline is the backstop.
 */
export function generateBackgroundWakeScript(): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const ${BACKGROUND_WAKE_MARKER} = true;`,
    `const deadline = Date.now() + ${BACKGROUND_WAKE_TIMEOUT_SECONDS} * 1000;`,
    "const RESULT_BEGIN = '=== CODEMAN_RESULT_BEGIN ===';",
    "const RESULT_END = '=== CODEMAN_RESULT_END ===';",
    'const MAX_RESULT_CHARS = 65536;',
    'let input = {};',
    "try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }",
    'function findTaskId(value) {',
    "  const idKeys = new Set(['taskId', 'task_id', 'shellId', 'shell_id', 'backgroundTaskId', 'background_task_id']);",
    '  const stack = [value];',
    '  const seen = new Set();',
    '  while (stack.length > 0) {',
    '    const current = stack.pop();',
    "    if (!current || typeof current !== 'object' || seen.has(current)) continue;",
    '    seen.add(current);',
    '    for (const [key, nested] of Object.entries(current)) {',
    "      if (idKeys.has(key) && typeof nested === 'string' && /^[A-Za-z0-9_-]+$/.test(nested)) return nested;",
    "      if (nested && typeof nested === 'object') stack.push(nested);",
    '    }',
    '  }',
    "  const serialized = JSON.stringify(value ?? '');",
    '  const messageMatch = serialized.match(/Command running in background with ID:\\s*([A-Za-z0-9_-]+)/i);',
    '  if (messageMatch) return messageMatch[1];',
    '  const pathMatch = serialized.match(/[\\\\/]tasks[\\\\/]([A-Za-z0-9_-]+)\\.output/i);',
    '  return pathMatch ? pathMatch[1] : null;',
    '}',
    'const taskId = findTaskId(input.tool_response);',
    "const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';",
    'if (!taskId || !transcriptPath) process.exit(0);',
    'const transcriptPaths = [transcriptPath];',
    'const sessionDir = path.dirname(path.dirname(transcriptPath));',
    "if (typeof input.agent_id === 'string' && path.basename(path.dirname(transcriptPath)) === 'subagents' &&",
    "    typeof input.session_id === 'string' && path.basename(sessionDir) === input.session_id) {",
    "  transcriptPaths.push(sessionDir + '.jsonl');",
    '}',
    'const transcripts = [...new Set(transcriptPaths)].map((transcript) => {',
    '  let position = 0;',
    '  try { position = Math.max(0, fs.statSync(transcript).size - 262144); } catch {}',
    "  return { path: transcript, position, carry: '' };",
    '});',
    'if (!transcripts.some((transcript) => fs.existsSync(transcript.path))) process.exit(0);',
    'function readMarkedResult(outputPath) {',
    "  if (!outputPath || !path.isAbsolute(outputPath) || path.basename(outputPath) !== taskId + '.output') return '';",
    "  if (path.basename(path.dirname(outputPath)) !== 'tasks') return '';",
    '  try {',
    '    const size = fs.statSync(outputPath).size;',
    '    const length = Math.min(size, MAX_RESULT_CHARS * 2);',
    '    const buffer = Buffer.allocUnsafe(length);',
    "    const fd = fs.openSync(outputPath, 'r');",
    '    const bytes = fs.readSync(fd, buffer, 0, length, size - length);',
    '    fs.closeSync(fd);',
    "    const text = buffer.subarray(0, bytes).toString('utf8');",
    '    const begin = text.lastIndexOf(RESULT_BEGIN);',
    '    const end = text.indexOf(RESULT_END, begin + RESULT_BEGIN.length);',
    "    if (begin < 0 || end < 0) return '';",
    '    let result = text.slice(begin + RESULT_BEGIN.length, end).trim();',
    "    if (!result) return '';",
    '    if (result.length > MAX_RESULT_CHARS) {',
    '      const half = Math.floor(MAX_RESULT_CHARS / 2);',
    "      result = result.slice(0, half) + '\\n\\n[report truncated by Codeman]\\n\\n' + result.slice(-half);",
    '    }',
    "    return '\\n\\nCompleted task report:\\n<codeman-background-result>\\n' + result + '\\n</codeman-background-result>';",
    "  } catch { return ''; }",
    '}',
    'function inspect(text) {',
    '  for (const line of text.split(/\\r?\\n/)) {',
    '    if (!line.includes(taskId)) continue;',
    '    let entry;',
    '    try { entry = JSON.parse(line); } catch { continue; }',
    "    if (entry.type !== 'queue-operation' || entry.operation !== 'enqueue' || typeof entry.content !== 'string') continue;",
    "    if (!entry.content.includes('<task-id>' + taskId + '</task-id>')) continue;",
    '    const status = entry.content.match(/<status>(completed|failed|killed|error)<\\/status>/i);',
    '    if (!status) continue;',
    '    const output = entry.content.match(/<output-file>([^<]+)<\\/output-file>/i);',
    "    const outputPath = output ? output[1].trim() : '';",
    "    const location = outputPath ? ' Read ' + outputPath + ' and' : '';",
    '    const result = readMarkedResult(outputPath);',
    "    console.error('Background command ' + taskId + ' ' + status[1].toLowerCase() + '.' + location + ' continue the task.' + result);",
    '    process.exit(2);',
    '  }',
    '}',
    'function pollTranscript(transcript) {',
    '  try {',
    '    const size = fs.statSync(transcript.path).size;',
    "    if (size < transcript.position) { transcript.position = 0; transcript.carry = ''; }",
    '    if (size > transcript.position) {',
    '      const length = Math.min(size - transcript.position, 1048576);',
    '      const buffer = Buffer.allocUnsafe(length);',
    "      const fd = fs.openSync(transcript.path, 'r');",
    '      const bytes = fs.readSync(fd, buffer, 0, length, transcript.position);',
    '      fs.closeSync(fd);',
    '      transcript.position += bytes;',
    "      transcript.carry = (transcript.carry + buffer.subarray(0, bytes).toString('utf8')).slice(-262144);",
    '      inspect(transcript.carry);',
    '    }',
    '  } catch {}',
    '}',
    'function poll() {',
    '  if (Date.now() > deadline || process.ppid === 1) process.exit(0);',
    '  for (const transcript of transcripts) pollTranscript(transcript);',
    '  setTimeout(poll, 1000);',
    '}',
    'poll();',
  ].join('\n');
}

/**
 * Keep a Claude subagent alive while its Monitor or background Bash work is live.
 * Claude otherwise can publish the worker's last progress sentence as an Agent
 * result when one watcher ends, even if other tracked tasks are still running.
 */
export function generateSubagentStopGuardScript(): string {
  return [
    "const fs = require('node:fs');",
    `const ${SUBAGENT_STOP_GUARD_MARKER} = true;`,
    'let input = {};',
    "try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }",
    "const transcriptPath = typeof input.agent_transcript_path === 'string' ? input.agent_transcript_path : '';",
    'if (!transcriptPath) process.exit(0);',
    'let text;',
    'try {',
    '  const size = fs.statSync(transcriptPath).size;',
    '  const length = Math.min(size, 16 * 1024 * 1024);',
    '  const buffer = Buffer.allocUnsafe(length);',
    "  const fd = fs.openSync(transcriptPath, 'r');",
    '  const bytes = fs.readSync(fd, buffer, 0, length, size - length);',
    '  fs.closeSync(fd);',
    "  text = buffer.subarray(0, bytes).toString('utf8');",
    '} catch { process.exit(0); }',
    'const launched = new Set();',
    'const finished = new Set();',
    'function inspectToolResult(value) {',
    "  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? '');",
    '  for (const match of serialized.matchAll(/Command running in background with ID:\\s*([A-Za-z0-9_-]+)/gi)) launched.add(match[1]);',
    '  for (const match of serialized.matchAll(/Monitor started \\(task ([A-Za-z0-9_-]+)/gi)) launched.add(match[1]);',
    '}',
    'function inspectNotifications(value) {',
    "  if (typeof value !== 'string' || !value.includes('<task-notification>')) return;",
    '  for (const match of value.matchAll(/<task-notification>([\\s\\S]*?)<\\/task-notification>/gi)) {',
    '    const body = match[1];',
    '    const id = body.match(/<task-id>([^<]+)<\\/task-id>/i);',
    '    const status = body.match(/<status>(completed|failed|killed|error)<\\/status>/i);',
    '    if (id && status) finished.add(id[1].trim());',
    '  }',
    '}',
    'for (const line of text.split(/\\r?\\n/)) {',
    '  let entry;',
    '  try { entry = JSON.parse(line); } catch { continue; }',
    '  const content = entry && entry.message ? entry.message.content : undefined;',
    '  if (Array.isArray(content)) {',
    '    for (const block of content) {',
    "      if (block && block.type === 'tool_result') inspectToolResult(block.content);",
    "      if (block && block.type === 'text') inspectNotifications(block.text);",
    '    }',
    '  } else {',
    '    inspectNotifications(content);',
    '  }',
    '  inspectNotifications(entry && entry.content);',
    '}',
    'function findLiveTasks(candidates) {',
    '  const live = new Set();',
    "  if (candidates.size === 0 || !fs.existsSync('/proc')) return live;",
    '  let processIds;',
    "  try { processIds = fs.readdirSync('/proc').filter((name) => /^\\d+$/.test(name)); } catch { return live; }",
    '  for (const processId of processIds) {',
    "    for (const descriptor of ['0', '1', '2']) {",
    '      let target;',
    "      try { target = fs.readlinkSync('/proc/' + processId + '/fd/' + descriptor); } catch { continue; }",
    '      const match = target.match(/[\\/]tasks[\\/]([A-Za-z0-9_-]+)\\.output(?: \\(deleted\\))?$/);',
    '      if (match && candidates.has(match[1])) live.add(match[1]);',
    '    }',
    '    if (live.size === candidates.size) break;',
    '  }',
    '  return live;',
    '}',
    'const unfinished = new Set([...launched].filter((taskId) => !finished.has(taskId)));',
    'const active = [...findLiveTasks(unfinished)];',
    'if (active.length === 0) process.exit(0);',
    'const shown = active.slice(0, 8);',
    "const suffix = active.length > shown.length ? ' and ' + (active.length - shown.length) + ' more' : '';",
    'process.stdout.write(JSON.stringify({',
    "  decision: 'block',",
    "  reason: 'You still own active background work (' + shown.join(', ') + suffix + '). Do not return an intermediate progress message as your final report. Process the task notifications or keep actively polling until every task completes, then return one complete summary.',",
    '}));',
  ].join('\n');
}

function withSettingsLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = settingsWriteLocks.get(path) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run after the prior writer, regardless of its outcome
  // Tail never rejects, so a failed write doesn't poison subsequent writers.
  const tail = run.then(
    () => {},
    () => {}
  );
  settingsWriteLocks.set(path, tail);
  void tail.then(() => {
    if (settingsWriteLocks.get(path) === tail) settingsWriteLocks.delete(path);
  });
  return run;
}

/**
 * Why writing into `<casePath>/.claude/settings.local.json` must NOT proceed,
 * or null when it is safe.
 *
 * Case contents can be FOREIGN (a freshly cloned repository, an imported
 * tree): `.claude` or the settings file itself can arrive as a symlink
 * pointing anywhere on this machine, and `writeFile` follows links, so a
 * scaffold write would land outside the case, up to and including replacing
 * the user's own `~/.claude/settings.json` (#251 review). Any symlink in the
 * chain, or a `.claude` that resolves outside the case, refuses the write.
 * A missing `.claude` is fine (the writer creates it).
 */
export async function settingsWriteBlocker(casePath: string): Promise<string | null> {
  const claudeDir = join(casePath, '.claude');
  try {
    const dirStat = await lstat(claudeDir).catch(() => null);
    if (dirStat?.isSymbolicLink()) return 'its .claude is a symlink';
    if (dirStat && !dirStat.isDirectory()) return 'its .claude is a file, not a directory';
    if (dirStat && (await realpath(claudeDir)) !== join(await realpath(casePath), '.claude')) {
      return 'its .claude directory resolves outside the case';
    }
    const settingsStat = await lstat(join(claudeDir, 'settings.local.json')).catch(() => null);
    if (settingsStat?.isSymbolicLink()) return 'its .claude/settings.local.json is a symlink';
  } catch (err) {
    return `its .claude paths could not be verified (${String(err)})`;
  }
  return null;
}

/**
 * The ONE gate for writing `<casePath>/.claude/settings.local.json`.
 *
 * Serializes writers per path (withSettingsLock) and, INSIDE the lock, refuses
 * the write when `settingsWriteBlocker` reports the target unsafe. Every
 * settings writer in this module must go through here rather than calling
 * `writeFile` on the settings path itself, so a repository-controlled symlink
 * can never redirect ANY of them outside the case (#251 review: the guard
 * originally covered only two writers, and applyStatusLineConfig was shown
 * writing through a symlinked settings file). Refusal is a console.warn, not
 * a throw: hooks/statusline degrade gracefully and the session still runs.
 */
async function withSafeSettingsWrite(
  casePath: string,
  purpose: string,
  fn: (claudeDir: string, settingsPath: string) => Promise<void>
): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');
  await withSettingsLock(settingsPath, async () => {
    const blocker = await settingsWriteBlocker(casePath);
    if (blocker) {
      console.warn(`[hooks-config] Refusing to write ${purpose} for ${casePath}: ${blocker}`);
      return;
    }
    await fn(claudeDir, settingsPath);
  });
}

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
  // COD-54: present the per-instance hook secret so the bypass keeps working while
  // a tunnel is running. The value is read from the secret file AT EXECUTION TIME
  // (path via $CODEMAN_HOOK_SECRET_FILE, set in every managed session's env), so it
  // never lands in this config and rotation needs no respawn. If the var/file is
  // missing the header is empty — the middleware then allows the request only on
  // the plain loopback bypass (tunnel down), same as pre-secret behavior.
  const curlCmd = (event: HookEventType) =>
    `HOOK_DATA=$(cat 2>/dev/null || echo '{}'); ` +
    `printf '{"event":"${event}","sessionId":"%s","data":%s}' "$CODEMAN_SESSION_ID" "$HOOK_DATA" | ` +
    // `-k`, same as the statusline exporter: CODEMAN_API_URL is loopback HTTPS with
    // a self-signed cert on --https/tailscale installs. Without it curl exits 60,
    // the `|| true` swallows it, and ALL SIX hook events die silently: respawn loses
    // its definitive idle signals and the wait endpoints lose stop/blocked.
    `curl -sk -X POST "$CODEMAN_API_URL/api/hook-event" ` +
    `-H 'Content-Type: application/json' ` +
    `-H "X-Codeman-Hook-Secret: $(cat "$CODEMAN_HOOK_SECRET_FILE" 2>/dev/null)" ` +
    `--data @- ` +
    `2>/dev/null || true`;

  return {
    hooks: {
      Notification: [
        {
          matcher: 'idle_prompt',
          hooks: [{ type: 'command', command: curlCmd('idle_prompt'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
        {
          matcher: 'permission_prompt',
          hooks: [{ type: 'command', command: curlCmd('permission_prompt'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
        {
          matcher: 'elicitation_dialog',
          hooks: [{ type: 'command', command: curlCmd('elicitation_dialog'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
        // The two dialog-closed notifications resolve Approvals Inbox items the
        // moment a question is answered IN the terminal (long before `stop`).
        {
          matcher: 'elicitation_complete',
          hooks: [{ type: 'command', command: curlCmd('elicitation_complete'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
        {
          matcher: 'elicitation_response',
          hooks: [{ type: 'command', command: curlCmd('elicitation_response'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: curlCmd('stop'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
      SubagentStop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['-e', generateSubagentStopGuardScript()],
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
      TeammateIdle: [
        {
          hooks: [{ type: 'command', command: curlCmd('teammate_idle'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
      TaskCompleted: [
        {
          hooks: [{ type: 'command', command: curlCmd('task_completed'), timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['-e', generateBackgroundWakeScript()],
              asyncRewake: true,
              timeout: BACKGROUND_WAKE_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

function isCodemanHookHandler(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    // Prefixes, not versioned markers: older script versions must still be ours.
    return (
      serialized.includes('/api/hook-event') ||
      serialized.includes(BACKGROUND_WAKE_MARKER_PREFIX) ||
      serialized.includes(SUBAGENT_STOP_GUARD_MARKER_PREFIX)
    );
  } catch {
    return false;
  }
}

/**
 * Replace only Codeman-owned command handlers while preserving user events,
 * matcher entries, and sibling handlers in mixed entries.
 */
function mergeCodemanHooks(existingValue: unknown, generated: Record<string, unknown[]>): Record<string, unknown[]> {
  const existing =
    existingValue && typeof existingValue === 'object' && !Array.isArray(existingValue)
      ? (existingValue as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown[]> = {};

  for (const eventName of new Set([...Object.keys(existing), ...Object.keys(generated)])) {
    const existingEntries = Array.isArray(existing[eventName]) ? (existing[eventName] as unknown[]) : [];
    const generatedEntries = generated[eventName];
    if (!generatedEntries) {
      merged[eventName] = existingEntries;
      continue;
    }

    const entries: unknown[] = [];
    let insertedGenerated = false;
    for (const entry of existingEntries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        if (!isCodemanHookHandler(entry)) entries.push(entry);
        continue;
      }

      const record = entry as Record<string, unknown>;
      if (!Array.isArray(record.hooks)) {
        if (isCodemanHookHandler(record)) {
          if (!insertedGenerated) {
            entries.push(...generatedEntries);
            insertedGenerated = true;
          }
        } else {
          entries.push(entry);
        }
        continue;
      }

      const retainedHandlers = record.hooks.filter((handler) => !isCodemanHookHandler(handler));
      const removedCodemanHandler = retainedHandlers.length !== record.hooks.length;
      if (removedCodemanHandler && !insertedGenerated) {
        entries.push(...generatedEntries);
        insertedGenerated = true;
      }
      if (retainedHandlers.length > 0 || !removedCodemanHandler) {
        entries.push(retainedHandlers.length === record.hooks.length ? entry : { ...record, hooks: retainedHandlers });
      }
    }

    if (!insertedGenerated) entries.push(...generatedEntries);
    merged[eventName] = entries;
  }

  return merged;
}

/**
 * Remove a subset of env keys from .claude/settings.local.json.env if present.
 * Used during the disk→tmux-setenv migration: when the caller is actively setting
 * a fresh value for a Codeman-managed key, any stale disk entry for THAT KEY is
 * superseded and should be removed. Keys NOT in `keysToRemove` are left alone
 * (they may be user-managed). No-op if the file/keys don't exist.
 */
export async function stripCaseEnvKeys(casePath: string, keysToRemove: readonly string[]): Promise<void> {
  if (keysToRemove.length === 0) return;

  await withSafeSettingsWrite(casePath, 'env-key removal', async (_claudeDir, settingsPath) => {
    if (!existsSync(settingsPath)) return;

    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch {
      return; // Malformed — don't rewrite it
    }

    const env = existing.env as Record<string, string> | undefined;
    if (!env) return;

    let changed = false;
    for (const key of keysToRemove) {
      if (key in env) {
        delete env[key];
        changed = true;
      }
    }
    if (!changed) return;

    existing.env = env;
    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  });
}

/**
 * Updates env vars in .claude/settings.local.json for the given case path.
 * Merges with existing env field; removes vars set to empty string.
 */
export async function updateCaseEnvVars(casePath: string, envVars: Record<string, string>): Promise<void> {
  await withSafeSettingsWrite(casePath, 'env vars', async (claudeDir, settingsPath) => {
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

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
  });
}

/**
 * Updates the `model` field in .claude/settings.local.json for the given case path.
 * Pass a non-empty string to set, or empty/null to remove.
 */
export async function updateCaseModel(casePath: string, model: string | null): Promise<void> {
  await withSafeSettingsWrite(casePath, 'model', async (claudeDir, settingsPath) => {
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch {
      existing = {};
    }

    if (model) {
      existing.model = model;
    } else {
      delete existing.model;
    }

    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  });
}

/**
 * Writes hooks config to .claude/settings.local.json in the given case path.
 * Merges with existing file content, only touching the `hooks` key.
 * Refuses (with a console.warn, not a throw: hooks degrade to output-based
 * idle detection) when `settingsWriteBlocker` reports the target unsafe.
 */
export async function writeHooksConfig(casePath: string): Promise<void> {
  await withSafeSettingsWrite(casePath, 'hooks', async (claudeDir, settingsPath) => {
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch {
      // If file is malformed or doesn't exist, start fresh
      existing = {};
    }

    const hooksConfig = generateHooksConfig();
    const merged = {
      ...existing,
      hooks: mergeCodemanHooks(existing.hooks, hooksConfig.hooks),
    };

    await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  });
}

/**
 * Ensures a workspace Codeman is about to run Claude in has the current Codeman hooks.
 *
 * Unlike `refreshStaleCodemanHooks`, this may ADD Codeman handlers to a settings
 * file that has none (a linked case, a cloned repo, any directory Codeman did not
 * scaffold). It merges rather than replaces, so a user's own hook entries survive,
 * and a malformed existing file is left untouched rather than replaced.
 *
 * ⚠️ That "may add" is a deliberate POLICY, adopted 2026-08-15 after the symptom it
 * causes was reported: hooks were only ever written when Codeman CREATED a case
 * directory, so every session in a linked case ran with no hooks at all and each
 * hook-driven surface was silently dead there — an AskUserQuestion dialog blocking
 * the pane while the tab and the phone overview both read a calm `idle`, no
 * Approvals Inbox item, no push, no definitive `stop`/`idle_prompt` for respawn, and
 * no `stop`/`blocked` for the agent wait endpoints. The cost of the policy is the
 * other direction: a user who DELETES Codeman's hooks from a workspace gets them
 * back on the next session create there, because nothing on disk distinguishes
 * "removed on purpose" from "never had any".
 *
 * Called from both session-create paths (`POST /api/sessions`, `POST /api/quick-start`)
 * for claude mode, and from `restoreMuxSessions()` so sessions that predate this heal
 * on the next server start. Claude Code re-reads the file, so a session ALREADY running
 * in the workspace picks the hooks up without a restart (verified live, 2026-08-15).
 */
export async function ensureCodemanHooks(casePath: string): Promise<void> {
  await withSafeSettingsWrite(casePath, 'hooks (ensure)', async (claudeDir, settingsPath) => {
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      existing = parsed as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }

    const generated = generateHooksConfig();
    const hooks = mergeCodemanHooks(existing.hooks, generated.hooks);
    if (JSON.stringify(existing.hooks ?? {}) === JSON.stringify(hooks)) return;

    await writeFile(settingsPath, JSON.stringify({ ...existing, hooks }, null, 2) + '\n');
  });
}

/**
 * Self-heal a case's Codeman-owned hooks block.
 *
 * `writeHooksConfig` only runs when a case is first CREATED. Cases created before the
 * X-Codeman-Hook-Secret header was added (COD-54, 2026-06-10) keep hook curls in their
 * settings.local.json that POST to /api/hook-event WITHOUT the secret — which, once the
 * gate requires it unconditionally (COD-91), silently 401 on a password-protected install.
 * Older Codeman blocks also lack the current background Bash async-rewake hook or the
 * SubagentStop guard. A further stale shape: hook curls without `-k`, which exit 60 on
 * every --https/tailscale install (the cert is self-signed), swallowed by the hooks'
 * own `|| true` — all six hook events die silently. Refresh any of these stale shapes
 * on launch so existing cases heal.
 *
 * Deliberately surgical: regenerates ONLY when settings.local.json already contains
 * Codeman's own hook curls (they target `/api/hook-event`) and they are stale. No-op
 * when the file/hooks are absent (we never impose hooks on a user who removed them) or
 * when the hooks aren't ours, so it is cheap enough to call on every Claude spawn.
 */
export async function refreshStaleCodemanHooks(casePath: string): Promise<void> {
  if (!existsSync(join(casePath, '.claude', 'settings.local.json'))) return;
  await withSafeSettingsWrite(casePath, 'hooks (refresh)', async (_claudeDir, settingsPath) => {
    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch {
      return; // malformed — leave it untouched (case-create owns the happy path)
    }
    const hooksJson = JSON.stringify(existing.hooks ?? null);
    const isOurs = hooksJson.includes('/api/hook-event');
    // The generated curl carries this header literal (see generateHooksConfig); its
    // absence on our own hooks means they predate COD-54 and need regenerating.
    const hasSecret = hooksJson.includes('X-Codeman-Hook-Secret');
    const hasBackgroundWake = hooksJson.includes(BACKGROUND_WAKE_MARKER);
    // The pre--k curl shape: `curl -sk -X POST` does not contain `curl -s -X POST`
    // as a substring, so this cleanly identifies hook curls that die with exit 60
    // on a self-signed HTTPS install.
    const hasTlsFlaglessCurl = hooksJson.includes('curl -s -X POST');
    const hasSubagentStopGuard = hooksJson.includes(SUBAGENT_STOP_GUARD_MARKER);
    // Approvals Inbox needs the elicitation_complete/elicitation_response
    // matchers; their absence marks a pre-inbox hooks block.
    const hasElicitationComplete = hooksJson.includes('elicitation_complete');
    if (
      !isOurs ||
      (hasSecret && hasBackgroundWake && hasSubagentStopGuard && hasElicitationComplete && !hasTlsFlaglessCurl)
    )
      return;
    const generated = generateHooksConfig();
    const merged = {
      ...existing,
      hooks: mergeCodemanHooks(existing.hooks, generated.hooks),
    };
    await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  });
}

/**
 * Hooks for the workspace a Claude session is about to run in. ONE decision point,
 * shared by every claude-session create path — the interactive routes, quick-start,
 * cron fires, legacy scheduled runs, the plan-orchestrator one-shots, and the boot
 * recovery sweep — so the `workspaceHooksEnabled` setting cannot apply to some of
 * them only.
 *
 * ON (the default): INSTALL Codeman's hooks block (`ensureCodemanHooks`), merging so
 * a user's own hook entries and every other settings key survive. Hooks used to be
 * written only when Codeman CREATED the case DIRECTORY, so a linked case or any
 * pre-existing repo — where most sessions actually run — had none, and every
 * hook-driven surface was silently dead there (full history on `ensureCodemanHooks`).
 *
 * OFF: the older, narrower behavior. A Codeman block that is already there is still
 * refreshed when stale (COD-91: a pre-secret block 401s once the hook-secret gate
 * went unconditional), but one is never added, so Codeman leaves the repo alone.
 *
 * `install` overrides the setting read: route handlers resolve it through their
 * ConfigPort (`ctx.getWorkspaceHooksEnabled()`, which tests stub), and the boot sweep
 * passes `true` after checking the setting once for its whole batch. Every other
 * caller omits it and the synced setting is read from settings.json here — default ON
 * when the key is absent or the file unreadable, matching the server's resolver.
 *
 * Callers gate on their own context (claude mode only; local — never a remote
 * workingDir, which is a path on ANOTHER host, and never a docker case that opted
 * out of hooks). The guards EVERY caller needs live here instead:
 *  - a workspace that does not exist is skipped — `ensureCodemanHooks` mkdir -p's,
 *    so a deleted repo whose tmux session survived would otherwise be resurrected
 *    as an empty directory tree holding only `.claude/settings.local.json`;
 *  - errors are swallowed — a session create must never fail on hooks.
 */
export async function applyWorkspaceHooks(workspace: string, install?: boolean): Promise<void> {
  try {
    if (!existsSync(workspace)) return;
    const shouldInstall = install ?? (await readWorkspaceHooksEnabled());
    await (shouldInstall ? ensureCodemanHooks(workspace) : refreshStaleCodemanHooks(workspace));
  } catch {
    // Best-effort by contract (see doc comment): hooks degrade to output-based
    // idle detection; the create goes ahead.
  }
}

/**
 * The synced `workspaceHooksEnabled` app setting, read straight from settings.json
 * for callers that live outside the web layer (cron, scheduled runs, the plan
 * orchestrator). Default ON: an absent key means a user who has never seen the
 * setting, and OFF for them would mean no tab alerts, no Approvals Inbox and no
 * respawn idle signals in every workspace Codeman did not scaffold itself.
 */
async function readWorkspaceHooksEnabled(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(dataPath('settings.json'), 'utf-8')) as Record<string, unknown>;
    return parsed.workspaceHooksEnabled !== false;
  } catch {
    return true;
  }
}

/** Unique marker identifying Codeman's own statusLine command (vs a user's). */
const STATUSLINE_MARKER = '/api/status-telemetry';

/**
 * The plan-usage statusLine exporter command. Mirrors the hook `curlCmd` pattern:
 * reads Claude Code's statusline stdin JSON, POSTs `{sessionId,data}` to Codeman,
 * and prints the response body (a compact "⟳ 5h 15% · 7d 34%" footer) back to
 * stdout so the in-terminal statusline stays useful. Env vars resolve at runtime
 * (present in every managed session via tmux setenv), so the config is static.
 */
export function generateStatusLineCommand(): string {
  // `curl -sk`: CODEMAN_API_URL is loopback HTTPS with a self-signed cert in the
  // production setup; without -k curl returns 000 and the statusline shows
  // nothing. -k is safe here (loopback only). Falls back to a brand string so the
  // footer is never blank if Codeman is unreachable.
  return (
    `INPUT=$(cat 2>/dev/null || echo '{}'); ` +
    `printf '{"sessionId":"%s","data":%s}' "$CODEMAN_SESSION_ID" "$INPUT" | ` +
    `curl -sk -X POST "$CODEMAN_API_URL${STATUSLINE_MARKER}" ` +
    `-H 'Content-Type: application/json' ` +
    `-H "X-Codeman-Hook-Secret: $(cat "$CODEMAN_HOOK_SECRET_FILE" 2>/dev/null)" ` +
    `--data @- 2>/dev/null || echo codeman`
  );
}

/**
 * Add or remove Codeman's plan-usage statusLine exporter in
 * `.claude/settings.local.json`. Only ever touches a statusLine that is OURS
 * (command targets `/api/status-telemetry`), so a user's hand-authored
 * statusLine is never removed OR overwritten — on both the enable and disable
 * paths we bail out when an existing statusLine isn't ours. Callers gate on
 * Claude mode. Merges, preserving all other keys (hooks, env, model).
 */
export async function applyStatusLineConfig(casePath: string, enabled: boolean): Promise<void> {
  await withSafeSettingsWrite(casePath, 'statusLine', async (claudeDir, settingsPath) => {
    let existing: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
      } catch {
        return; // Malformed — don't rewrite it
      }
    }

    const current = existing.statusLine as { command?: unknown } | undefined;
    const isOurs = !!current && typeof current.command === 'string' && current.command.includes(STATUSLINE_MARKER);

    if (enabled) {
      const desired = generateStatusLineCommand();
      if (isOurs && current?.command === desired) return; // already current — skip rewrite
      if (current && !isOurs) return; // user has their OWN statusLine — never clobber it
      if (!existsSync(claudeDir)) await mkdir(claudeDir, { recursive: true });
      existing.statusLine = { type: 'command', command: desired }; // add, or update an out-of-date ours
    } else {
      if (!isOurs) return; // nothing of ours to remove (leave a user's own statusLine alone)
      delete existing.statusLine;
    }

    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  });
}

/**
 * Version-agnostic marker embedded as a comment in the generated exporter
 * SCRIPT (see ensureStatusLineExporterScript) — bump the numeric suffix
 * whenever the script content changes so `ensureStatusLineExporterScript`'s
 * content comparison rewrites stale copies on next use.
 */
const STATUSLINE_EXPORTER_SCRIPT_MARKER = 'CODEMAN_STATUSLINE_EXPORTER_V1';

function statusLineExporterScriptContent(): string {
  // Byte-identical logic to generateStatusLineCommand(), just as a real file
  // instead of an inline string — see ensureStatusLineExporterScript for why
  // that distinction matters (it is NOT cosmetic).
  return (
    `#!/bin/sh\n` +
    `# ${STATUSLINE_EXPORTER_SCRIPT_MARKER} — auto-generated by Codeman; safe to delete, regenerated on demand.\n` +
    `INPUT=$(cat 2>/dev/null || echo '{}')\n` +
    `printf '{"sessionId":"%s","data":%s}' "$CODEMAN_SESSION_ID" "$INPUT" | ` +
    `curl -sk -X POST "$CODEMAN_API_URL${STATUSLINE_MARKER}" ` +
    `-H 'Content-Type: application/json' ` +
    `-H "X-Codeman-Hook-Secret: $(cat "$CODEMAN_HOOK_SECRET_FILE" 2>/dev/null)" ` +
    `--data @- 2>/dev/null || echo codeman\n`
  );
}

/**
 * Write (or refresh) the SHARED, single exporter script every claude session
 * points its ephemeral --settings statusLine flag at, and return its absolute
 * path. Idempotent: only rewrites when the marker-versioned content differs.
 *
 * This is the fix for a real bug found live 2026-08-31: the exporter's
 * command string legitimately depends on `$CODEMAN_SESSION_ID`,
 * `$CODEMAN_API_URL`, `$CODEMAN_HOOK_SECRET_FILE`, and its own internal
 * `$INPUT` — all meant to be expanded ONLY when Claude Code itself finally
 * executes the statusLine command, using the PANE's tmux-setenv'd
 * environment. Passing that command as literal TEXT through
 * `--settings '...'` routes it through this server's OWN spawn-time shell
 * layers first (tmux respawn-pane's `bash -c "..."`, itself invoked via
 * execSync's implicit `/bin/sh -c`) — and POSIX double quotes do NOT
 * suppress `$` expansion, so those vars got expanded there and then, against
 * the SERVER process's environment (where they are unset), producing a
 * mangled curl call that posted malformed JSON and printed the server's raw
 * error response as the statusline text itself. A bare file PATH has no `$`,
 * quotes, or pipes for any of those intermediate shells to mangle — the
 * script's own content (containing the real `$VAR`s) is never touched by a
 * shell until Claude Code executes the file itself, at which point the
 * pane's real environment is in scope. This mirrors the existing #208 fix in
 * tmux-manager.ts (never embed a literal `$SHELL` meant for later
 * expansion — resolve it, or in this case reference a file, instead).
 */
export async function ensureStatusLineExporterScript(): Promise<string> {
  const scriptPath = dataPath('statusline-exporter.sh');
  const desired = statusLineExporterScriptContent();
  let current: string | null = null;
  try {
    current = await readFile(scriptPath, 'utf-8');
  } catch {
    // Doesn't exist yet.
  }
  if (current !== desired) {
    await writeFile(scriptPath, desired);
    await chmod(scriptPath, 0o755);
  }
  return scriptPath;
}

/**
 * Resolve the statusLine command to pass as an EPHEMERAL `claude --settings`
 * CLI flag for this one process (see buildClaudeSettingsFlag in
 * tmux-manager.ts) — never written to disk. This supersedes the old
 * applyStatusLineConfig(path, true) disk-write: a file-based statusLine
 * leaked into any plain `claude` run in that directory outside Codeman
 * entirely (it took precedence over the user's own global/project
 * statusline with no disclosure and no way to remove it — found live
 * 2026-08-31).
 *
 * Also self-heals: if an OLDER Codeman build already wrote its marked
 * exporter into this workspace's settings.local.json, it is stripped here
 * (isOurs-guarded, same as applyStatusLineConfig's removal branch) so every
 * workspace migrates off the disk-based mechanism the first time a session
 * starts there again — no manual cleanup required.
 *
 * Returns undefined when telemetry wasn't requested, or when the workspace
 * already has its OWN hand-configured statusLine (never override a real one).
 */
export async function resolveStatusLineCliCommand(
  casePath: string,
  telemetryRequested: boolean
): Promise<string | undefined> {
  const settingsPath = join(casePath, '.claude', 'settings.local.json');
  let userHasOwnStatusLine = false;
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
      const current = existing.statusLine as { command?: unknown } | undefined;
      if (current && typeof current.command === 'string') {
        if (current.command.includes(STATUSLINE_MARKER)) {
          await applyStatusLineConfig(casePath, false); // strip legacy disk-written exporter
        } else {
          userHasOwnStatusLine = true;
        }
      }
    } catch {
      // Malformed — leave it alone, same guard applyStatusLineConfig itself uses.
    }
  }
  if (!telemetryRequested || userHasOwnStatusLine) return undefined;
  return ensureStatusLineExporterScript();
}

// ─── Agent skill injection ───────────────────────────────────────────────────

/**
 * Version-agnostic ownership prefix for the injected agent skill, same pattern as
 * `BACKGROUND_WAKE_MARKER_PREFIX`: ownership is decided on the prefix so a wording
 * change in the full marker cannot disown every previously injected copy.
 */
const AGENT_SKILL_MARKER_PREFIX = '<!-- codeman-managed-agent-skill';

/**
 * Marker appended to the injected SKILL.md. Its presence is what makes a copy OURS:
 * install/refresh/remove all refuse to touch a `skills/codeman` whose SKILL.md lacks
 * it, so a user's hand-authored or hand-edited-and-de-marked skill is never clobbered.
 */
const AGENT_SKILL_MARKER = `${AGENT_SKILL_MARKER_PREFIX}: installed by Codeman; edits are overwritten while the agent-skill setting is on -->`;

/**
 * Packaged source of the skill: `skills/codeman/` at the package root. Resolved
 * relative to this module so it works from `src/` (tsx dev), `dist/` (tsc build),
 * and an npm install (`files` includes `skills`), all of which sit one level below
 * the package root.
 */
function agentSkillSourceDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'codeman');
}

interface AgentSkillFile {
  /** Path relative to the target skill dir (e.g. `reference/endpoints.md`). */
  relPath: string;
  content: string;
}

/**
 * Read the packaged skill: SKILL.md (marker appended) plus every markdown file
 * under `reference/`. Enumerated from disk rather than a hardcoded manifest so a
 * new reference file ships without touching this module.
 */
async function readAgentSkillSource(): Promise<AgentSkillFile[]> {
  const src = agentSkillSourceDir();
  const skill = await readFile(join(src, 'SKILL.md'), 'utf-8');
  const files: AgentSkillFile[] = [{ relPath: 'SKILL.md', content: `${skill.trimEnd()}\n\n${AGENT_SKILL_MARKER}\n` }];
  let referenceNames: string[] = [];
  try {
    referenceNames = (await readdir(join(src, 'reference'))).filter((name) => name.endsWith('.md')).sort();
  } catch {
    // no reference dir in the source; SKILL.md alone is still a valid skill
  }
  for (const name of referenceNames) {
    files.push({ relPath: join('reference', name), content: await readFile(join(src, 'reference', name), 'utf-8') });
  }
  return files;
}

/**
 * Publish one skill file with a temp + rename, never a bare overwrite.
 *
 * Claude Code reads SKILL.md whole when it loads the skill, so an in-place rewrite of
 * the file (20KB+, several write() syscalls) lets a load that lands mid-write see a
 * TRUNCATED skill. rename() swaps the finished file in one step, so a
 * reader sees either the old copy or the new one. The pid+random temp name matters
 * because `codeman skill install` writes these same paths from a DIFFERENT process than
 * the server, where the in-process lock cannot help: a shared temp name would let the
 * two tear each other's payload (same reasoning as user-store.ts).
 */
async function writeSkillFileAtomic(target: string, content: string): Promise<void> {
  // `.tmp` last, so a leftover temp is never picked up as a `.md` skill file.
  const tmpPath = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, content);
    await rename(tmpPath, target);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** What an install/remove actually did, so callers (CLI, logs) can say so. */
export type AgentSkillApplyResult =
  | 'installed' // fresh copy written
  | 'refreshed' // our copy was stale and got rewritten
  | 'unchanged' // our copy already matches the packaged source
  | 'removed' // our copy deleted
  | 'absent' // nothing there to remove
  | 'foreign' // a copy exists but is not ours; left untouched
  | 'symlink'; // the skill dir (or its parent) is a symlink; left untouched

/**
 * Install or refresh the Codeman agent skill into `skillDir` (a `.../codeman`
 * directory, e.g. `<case>/.claude/skills/codeman` or `~/.claude/skills/codeman`).
 *
 * Refuses two shapes rather than writing through them:
 * - a SYMLINK at the skill dir or its `skills/` parent: this repo's own dogfooding
 *   layout (`.claude/skills/codeman -> ../../skills/codeman`) would otherwise have
 *   the injector overwrite the repo source through the link;
 * - a FOREIGN copy (SKILL.md present without our marker): that is the user's own
 *   skill, and per the statusLine rule we never clobber what we did not write.
 *
 * Idempotent and cheap: unchanged files are not rewritten, so calling on every
 * session create causes no mtime churn.
 *
 * Serialized on the skill dir through the same lock the settings writers use: two
 * sessions created at once in one repo both inject this skill, and interleaving their
 * ownership read with the other's write reports a bogus result (an 'unchanged' for a
 * copy the other writer had not finished). Writes go out via temp + rename, which is
 * what protects a concurrent skill LOAD, in this process or the CLI's.
 */
export async function installAgentSkillInto(skillDir: string): Promise<AgentSkillApplyResult> {
  return withSettingsLock(skillDir, async () => {
    if ((await isSymlink(dirname(skillDir))) || (await isSymlink(skillDir))) return 'symlink';

    let existing: string | null = null;
    try {
      existing = await readFile(join(skillDir, 'SKILL.md'), 'utf-8');
    } catch {
      // absent: fresh install
    }
    if (existing !== null && !existing.includes(AGENT_SKILL_MARKER_PREFIX)) return 'foreign';

    const files = await readAgentSkillSource();
    let changed = false;
    for (const file of files) {
      const target = join(skillDir, file.relPath);
      let current: string | null = null;
      try {
        current = await readFile(target, 'utf-8');
      } catch {
        // missing: will be written
      }
      if (current === file.content) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeSkillFileAtomic(target, file.content);
      changed = true;
    }
    if (!changed) return 'unchanged';
    return existing === null ? 'installed' : 'refreshed';
  });
}

/**
 * Seed a claude session's agent preamble file (`$XDG_CACHE_HOME/codeman-agent-<id>.sh`,
 * default `~/.cache/`) from the packaged `skills/codeman/preamble.sh`, so the agent
 * skill's §0 bootstrap collapses to a two-line loader instead of a ~150-line block the
 * model has to type out (measured live: that paste alone cost a spawn run ~47 s of
 * generation time). The path formula must match the skill's
 * `${XDG_CACHE_HOME:-$HOME/.cache}` exactly; sessions inherit the server's env, so
 * reading the server's own XDG_CACHE_HOME keeps the two in agreement (`||` mirrors the
 * shell's `:-`, treating empty as unset). Callers gate to LOCAL claude sessions (a
 * remote or in-container HOME is not this filesystem) and treat it as best-effort: the
 * skill's §0 fallback block self-heals a missing or stale file.
 */
export async function seedAgentSessionPreamble(sessionId: string): Promise<void> {
  const content = await readFile(join(agentSkillSourceDir(), 'preamble.sh'), 'utf-8');
  const cacheDir = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, `codeman-agent-${sessionId}.sh`), content, { mode: 0o600 });
}

/**
 * Refresh the USER-LEVEL skill copy (`~/.claude/skills/codeman`) IF one exists and is
 * Codeman-managed. `codeman skill install` (no `--case`) writes that copy once, and
 * unlike per-case copies (re-installed on every session create) nothing ever refreshed
 * it, so it stayed at whatever version installed it. That matters because Claude Code
 * loads the USER-LEVEL copy over a case's fresh one when both carry the name `codeman`:
 * observed live 2026-08-14, an Aug 9 user copy (pre fast-path, pre lineage header)
 * shadowed the current per-case injections, so every agent-driven spawn ran the old
 * recipes, spawned workers serially, and lost their lineage arcs.
 *
 * Refresh-ONLY: an absent copy is not installed (the user never asked for a global
 * copy), and foreign/symlink copies are refused by installAgentSkillInto itself.
 */
export async function refreshUserAgentSkill(): Promise<AgentSkillApplyResult | 'absent'> {
  const skillDir = join(homedir(), '.claude', 'skills', 'codeman');
  try {
    const existing = await readFile(join(skillDir, 'SKILL.md'), 'utf-8');
    if (!existing.includes(AGENT_SKILL_MARKER_PREFIX)) return 'foreign';
  } catch {
    return 'absent';
  }
  return installAgentSkillInto(skillDir);
}

/**
 * Remove a Codeman-managed skill copy from `skillDir`. Same ownership and symlink
 * refusals as the install path. Deletes only files the packaged source would have
 * written (never `rm -rf`, so a user's extra files in the directory survive), then
 * prunes the directories bottom-up if they emptied.
 *
 * Shares the install path's per-dir lock so an uninstall can't run between an install's
 * ownership read and its writes, which would leave half the skill back on disk.
 */
export async function removeAgentSkillFrom(skillDir: string): Promise<AgentSkillApplyResult> {
  return withSettingsLock(skillDir, async () => {
    if ((await isSymlink(dirname(skillDir))) || (await isSymlink(skillDir))) return 'symlink';

    let existing: string | null = null;
    try {
      existing = await readFile(join(skillDir, 'SKILL.md'), 'utf-8');
    } catch {
      return 'absent';
    }
    if (!existing.includes(AGENT_SKILL_MARKER_PREFIX)) return 'foreign';

    // Manifest-based, with SKILL.md as the fallback when the packaged source is
    // unreadable: removal must still work on an install whose skills/ dir went missing.
    const files = await readAgentSkillSource().catch((): AgentSkillFile[] => [{ relPath: 'SKILL.md', content: '' }]);
    for (const file of files) {
      await unlink(join(skillDir, file.relPath)).catch(() => {});
    }
    await rmdir(join(skillDir, 'reference')).catch(() => {}); // fails when non-empty, fine
    await rmdir(skillDir).catch(() => {});
    await rmdir(dirname(skillDir)).catch(() => {}); // prune `.claude/skills` if now empty
    return 'removed';
  });
}

/**
 * Add or remove the Codeman agent skill in `<case>/.claude/skills/codeman`,
 * mirroring `applyStatusLineConfig`'s shape. Gated by the synced `agentSkillEnabled`
 * app setting (default OFF); callers gate on Claude mode, since the skill is discovered
 * via `.claude/skills/`, which only Claude Code reads.
 *
 * Call-site policy is ADD-ONLY on session create (callers pass `enabled: true` or
 * skip the call), for the statusLine reason: sessions in a repo share one `.claude/`
 * dir, so a single create while the setting is off must not yank the skill out from
 * under other live sessions.
 *
 * ⚠️ Consequence: turning `agentSkillEnabled` OFF sweeps nothing. There is deliberately
 * no server-side toggle-off sweep (it would have to walk every case, including ones
 * with live sessions, and would hit exactly the shared-`.claude/` hazard above), so
 * already-injected copies stay on disk until removed per case with
 * `codeman skill uninstall --case <name>`. The `enabled: false` branch here backs that
 * CLI and the tests; it has no server call site. Keep the README's Agent Skill note in
 * sync if this ever changes.
 */
export async function applyAgentSkill(casePath: string, enabled: boolean): Promise<AgentSkillApplyResult> {
  const skillDir = join(casePath, '.claude', 'skills', 'codeman');
  return enabled ? installAgentSkillInto(skillDir) : removeAgentSkillFrom(skillDir);
}
