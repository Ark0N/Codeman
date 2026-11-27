/**
 * @fileoverview Plain text of a Claude conversation, for the opt-in saved transcripts
 * (`transcript-store.ts`).
 *
 * Claude Code's fullscreen UI keeps the conversation itself and scrolls it inside the app, so
 * neither the browser's scrollback nor tmux's holds anything older than the screen (measured:
 * `alternate_on=1`, tmux history 0). The conversation file Claude writes is the real history,
 * so the saved transcript is built from it: what you typed, what Claude answered in text, and
 * one line per tool call (its name and command or path). Tool RESULTS and thinking are left
 * out: they are large and are not what a person searches for.
 *
 * Only the last {@link READ_TAIL_BYTES} of the file are read (conversation files reach 100 MB+),
 * cut at a line start. `ClaudeTranscriptReader` remembers each file's size and mtime so an idle
 * conversation is not parsed again every minute.
 *
 * Tests: `test/claude-transcript-text.test.ts`.
 *
 * @module claude-transcript-text
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const READ_TAIL_BYTES = 32 * 1024 * 1024;
const MAX_TOOL_CHARS = 300;

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

const oneLine = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_TOOL_CHARS ? `${t.slice(0, MAX_TOOL_CHARS)}…` : t;
};

function toolLine(b: ContentBlock): string | null {
  if (!b.name) return null;
  const i = b.input ?? {};
  const arg = [i.command, i.file_path, i.path, i.pattern, i.url, i.query, i.description].find(
    (v): v is string => typeof v === 'string' && v.length > 0
  );
  return `[${b.name}]${arg ? ` ${oneLine(arg)}` : ''}`;
}

/** The text of one transcript line, or null for an entry that carries none. */
function entryText(line: string): string | null {
  let o: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (o.isMeta || o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) return null;
  const content = o.message?.content;
  const blocks: ContentBlock[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const label = o.type === 'user' ? 'You: ' : 'Claude: ';
  const parts: string[] = [];
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(`${label}${b.text.trim()}`);
    else if (b?.type === 'tool_use') {
      const t = toolLine(b);
      if (t) parts.push(t);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

/** Turn JSONL text into the searchable transcript. Lines that are not JSON are skipped. */
export function claudeJsonlToText(jsonl: string): string {
  const out: string[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    const t = entryText(line);
    if (t) out.push(t);
  }
  return out.join('\n');
}

/** `<projectsDir>/<project>/<id>.jsonl` for the first of `ids` that exists. Ids are checked, never joined raw. */
export async function findClaudeTranscriptPath(
  projectsDir: string,
  ids: Array<string | null | undefined>
): Promise<string | null> {
  const safe = [...new Set(ids)].filter((v): v is string => !!v && /^[a-zA-Z0-9._-]+$/.test(v));
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const id of safe) {
    for (const d of dirs) {
      const p = join(projectsDir, d, `${id}.jsonl`);
      try {
        if ((await stat(p)).isFile()) return p;
      } catch {
        /* not in this project folder */
      }
    }
  }
  return null;
}

export class ClaudeTranscriptReader {
  private readonly signatures = new Map<string, string>();

  /**
   * The transcript text of `path`. Null when the file is unreadable, holds no text, or
   * (unless `force`) has not changed since the last read of it.
   */
  async read(path: string, force = false): Promise<string | null> {
    let handle;
    try {
      handle = await open(path, 'r');
      const info = await handle.stat();
      const signature = `${info.size}:${info.mtimeMs}`;
      if (!force && this.signatures.get(path) === signature) return null;
      const start = Math.max(0, info.size - READ_TAIL_BYTES);
      const buf = Buffer.alloc(info.size - start);
      await handle.read(buf, 0, buf.length, start);
      let text = buf.toString('utf-8');
      // A tail read starts mid-line: drop the cut first line.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      this.signatures.set(path, signature);
      return claudeJsonlToText(text) || null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  forget(path: string): void {
    this.signatures.delete(path);
  }
}
