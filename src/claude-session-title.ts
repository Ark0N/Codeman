/**
 * @fileoverview Carry a Codeman rename into Claude Code's own session title.
 *
 * Claude Code keeps a conversation's title in its transcript as a
 * `{"type":"custom-title"}` row (what `/rename` writes), last row wins, and the
 * `/resume` picker shows `customTitle ?? aiTitle`. Renaming a tab in Codeman
 * used to change only the tab, so `/resume` kept listing the old name.
 *
 * Appending the row is enough for a pane that was spawned WITHOUT `--name`
 * (every placeholder- or auto-named tab, see `Session.cliPinnedName`): that
 * process holds no title of its own and never writes one back. A process that
 * WAS spawned with `--name` re-appends its in-memory title after each turn, so
 * there the new title holds from the next spawn, which pins the new name.
 *
 * @module claude-session-title
 */

import fs from 'node:fs/promises';

/**
 * Append a `custom-title` row for `conversationId` to an existing transcript.
 * Never creates the file: a missing transcript means the conversation has not
 * been written yet, and a file of only a title row would show up in `/resume`
 * as an empty conversation. Returns whether a row was written.
 */
export async function appendClaudeCustomTitle(
  transcriptPath: string,
  conversationId: string,
  title: string
): Promise<boolean> {
  const customTitle = title.trim();
  // Claude reads the row through `customTitle ?? aiTitle`, so an empty string
  // would blank the picker entry rather than fall back to the generated title.
  if (!customTitle) return false;
  try {
    if (!(await fs.stat(transcriptPath)).isFile()) return false;
  } catch {
    return false;
  }
  // One O_APPEND write of one line, the same way Claude appends its own rows,
  // so it cannot interleave with a row the live process is writing.
  const row = JSON.stringify({ type: 'custom-title', customTitle, sessionId: conversationId });
  await fs.appendFile(transcriptPath, `${row}\n`);
  return true;
}
