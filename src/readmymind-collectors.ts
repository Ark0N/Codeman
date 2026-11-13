/**
 * @fileoverview Read My Mind collectors: the IO feeding the pure context
 * assembler (`readmymind-context.ts`).
 *
 * - `readTranscriptSignals()`: tail-reads the session's Claude transcript
 *   JSONL for the full last assistant text plus recent tool calls. The live
 *   `TranscriptWatcher` keeps only a 500-char snippet, no tool history, and
 *   starts empty after a server restart, so prediction reads the file itself:
 *   on-demand, bounded, cold-start-proof. The line parse is pure
 *   (`parseTranscriptSignals`) for fixture tests.
 *
 * - `collectWorkspaceSignals()`: git branch/status/log via `execFile` in the
 *   session's workingDir with a 2s timeout, plus `.changeset/*.md` presence.
 *   Callers skip it for remote-SSH cases (workingDir is not local; Docker
 *   cases are fine, the workspace is bind-mounted at the same host path).
 *   Non-git dirs resolve to null and the section is simply omitted.
 */

import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PredictionToolCall, WorkspaceSignals } from './readmymind-context.js';
import { gitMissingError, gitSpawnAllowed } from './utils/git-availability.js';

const execFileAsync = promisify(execFile);

// ========== Transcript signals ==========

/** How much of the transcript tail to read. Turns are append-only JSONL, so the tail holds the newest entries. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** Safety cap on the extracted assistant text (the assembler truncates further). */
const MAX_ASSISTANT_CHARS = 12_000;

/** Max recent tool calls retained. */
export const MAX_TRANSCRIPT_TOOLS = 10;

const TOOL_DETAIL_KEYS = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description'] as const;
const MAX_TOOL_DETAIL_CHARS = 80;

export interface TranscriptSignals {
  lastAssistantText: string | null;
  recentTools: PredictionToolCall[];
}

interface TranscriptBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

/** One-line argument summary for a tool call, e.g. `Edit src/foo.ts` or `Bash npm test`. */
function summarizeToolInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of TOOL_DETAIL_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TOOL_DETAIL_CHARS);
    }
  }
  return undefined;
}

/**
 * Parse transcript JSONL lines into prediction signals. Pure; malformed lines
 * are skipped (the tail read starts mid-file, so the first line usually is).
 */
export function parseTranscriptSignals(lines: string[], maxTools: number = MAX_TRANSCRIPT_TOOLS): TranscriptSignals {
  let lastAssistantText: string | null = null;
  const tools: (PredictionToolCall & { id?: string })[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
    } catch {
      continue;
    }

    const content = entry.message?.content;
    if (entry.type === 'assistant') {
      if (typeof content === 'string') {
        if (content.trim()) lastAssistantText = content.slice(0, MAX_ASSISTANT_CHARS);
      } else if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content as TranscriptBlock[]) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text);
          } else if (block.type === 'tool_use' && block.name) {
            tools.push({ name: block.name, detail: summarizeToolInput(block.input), id: block.id });
          }
        }
        if (texts.length > 0) lastAssistantText = texts.join('\n').slice(0, MAX_ASSISTANT_CHARS);
      }
    } else if (entry.type === 'user' && Array.isArray(content)) {
      for (const block of content as TranscriptBlock[]) {
        if (block.type === 'tool_result' && block.is_error && block.tool_use_id) {
          const tool = tools.find((t) => t.id === block.tool_use_id);
          if (tool) tool.failed = true;
        }
      }
    }
  }

  return {
    lastAssistantText,
    recentTools: tools.slice(-maxTools).map(({ name, detail, failed }) => ({ name, detail, failed })),
  };
}

/**
 * Read the transcript tail and extract prediction signals. Returns null when
 * the file is missing or unreadable (the sections are simply omitted).
 */
export async function readTranscriptSignals(transcriptPath: string): Promise<TranscriptSignals | null> {
  let handle;
  try {
    const info = await stat(transcriptPath);
    const offset = Math.max(0, info.size - TRANSCRIPT_TAIL_BYTES);
    const length = info.size - offset;
    if (length <= 0) return { lastAssistantText: null, recentTools: [] };

    handle = await open(transcriptPath, 'r');
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const lines = buffer.toString('utf-8').split('\n');
    // A mid-file start point means the first line is a partial record.
    if (offset > 0) lines.shift();
    return parseTranscriptSignals(lines);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// ========== Workspace signals ==========

const GIT_TIMEOUT_MS = 2_000;
const MAX_STATUS_LINES = 30;

/**
 * Collect git signals from a local workingDir. Null when the dir is not a git
 * repo (or git is unavailable); individual sub-signals fail soft.
 */
export async function collectWorkspaceSignals(workingDir: string): Promise<WorkspaceSignals | null> {
  const git = async (args: string[]): Promise<string> => {
    // Never Apple's placeholder git on a Mac without developer tools (utils/git-availability.ts).
    if (!gitSpawnAllowed()) throw gitMissingError();
    const { stdout } = await execFileAsync('git', args, {
      cwd: workingDir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    return stdout;
  };

  let branch: string;
  try {
    branch = (await git(['branch', '--show-current'])).trim();
  } catch {
    return null; // Not a git repo (or no git): the section is omitted.
  }

  const signals: WorkspaceSignals = { branch: branch || undefined };

  try {
    const status = (await git(['status', '--short'])).trimEnd();
    signals.statusShort = status ? status.split('\n').slice(0, MAX_STATUS_LINES).join('\n') : '';
  } catch {
    // Fail soft: branch alone is still useful.
  }

  try {
    signals.recentCommits = (await git(['log', '--oneline', '-5'])).trimEnd();
  } catch {
    // A repo with no commits yet: omit.
  }

  try {
    const entries = await readdir(join(workingDir, '.changeset'));
    signals.hasChangesets = entries.some((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md');
  } catch {
    // No .changeset dir: not a changesets repo.
  }

  return signals;
}
