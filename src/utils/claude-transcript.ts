/**
 * @fileoverview Does a Claude conversation transcript exist on this host?
 *
 * Claude writes one `<conversation-id>.jsonl` per conversation under
 * `<config dir>/projects/<mangled cwd>/`. Two launch decisions turn on whether
 * such a file exists: `--resume <id>` needs one, and `--session-id <id>` is
 * REFUSED when one exists (`Error: Session ID ... is already in use.`).
 *
 * The project directory name is derived from the working directory, and a case
 * that has been moved or renamed leaves its transcript under the OLD name, so
 * the search is across every project directory rather than the one that matches
 * the pane's cwd today.
 *
 * ⚠️ Existence is the whole question here, with no size floor. The create route
 * additionally requires ~4 KB before it will resume, which is a "is this
 * conversation worth resuming" judgement; for a relaunch the question is the
 * opposite one — a one-line transcript still makes `--session-id` collide.
 *
 * ⚠️ A false answer is not the conservative one. Skipping a resume leaves the
 * relaunch on `--session-id <id>`, which is safe only when no transcript backs
 * that id either, so a lookup that misses the real config dir turns a
 * recoverable pane into the collision this module exists to prevent.
 *
 * @dependencies none
 * @consumedby session (relaunch resume pinning)
 *
 * @module utils/claude-transcript
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `<config dir>/projects`, honouring a session's relocated `CLAUDE_CONFIG_DIR`
 * (#255) and, failing that, the server process's own.
 *
 * ⚠️ The process env is not optional here. A pane inherits the server's
 * environment through tmux, so on an install that exports `CLAUDE_CONFIG_DIR`
 * the CLI writes its transcripts there and a lookup under `~/.claude` answers
 * "no transcript" for every conversation on the host. `claudeCredentialsPath()`
 * (claude-credentials.ts) and `realClaudeConfigDir()`
 * (custom-model-injection-apply.ts) resolve the same directory the same way.
 */
export function claudeProjectsDir(configDir?: string): string {
  const fromEnv = typeof process.env.CLAUDE_CONFIG_DIR === 'string' && process.env.CLAUDE_CONFIG_DIR.trim();
  return join(configDir || fromEnv || join(homedir(), '.claude'), 'projects');
}

/**
 * True when a transcript for `conversationId` exists under any project
 * directory. Returns false for a missing projects dir or an unreadable one,
 * which leaves the caller unpinned: safe where nothing else can collide with
 * the bare `--session-id`, and the reason the caller walks its candidates down
 * to the session's own id rather than treating one false answer as final.
 */
export async function claudeTranscriptExists(conversationId: string, configDir?: string): Promise<boolean> {
  if (!conversationId) return false;
  const projectsDir = claudeProjectsDir(configDir);
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return false;
  }
  for (const projectDir of projectDirs) {
    try {
      await stat(join(projectsDir, projectDir, `${conversationId}.jsonl`));
      return true;
    } catch {
      // Not in this project directory; keep looking.
    }
  }
  return false;
}
