/**
 * @fileoverview Append-only JSONL audit log for session lifecycle events.
 *
 * Records every session creation, start, exit, deletion, recovery, and server
 * start/stop to ~/.claudeman/session-lifecycle.jsonl. Survives server restarts
 * (unlike RunSummary which is in-memory only).
 *
 * @module session-lifecycle-log
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { LifecycleEventType, LifecycleEntry } from './types.js';

const MAX_LINES = 10_000;
const TRIM_TO = 8_000;

export class SessionLifecycleLog {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath?: string) {
    this.filePath = filePath || join(homedir(), '.claudeman', 'session-lifecycle.jsonl');
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Append a lifecycle event. Fire-and-forget — errors are logged but never thrown.
   */
  log(entry: Omit<LifecycleEntry, 'ts'> & { ts?: number }): void {
    const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
    // Chain writes to prevent interleaving
    this.writeQueue = this.writeQueue
      .then(() => appendFile(this.filePath, line, 'utf-8'))
      .catch((err) => {
        console.error('[LifecycleLog] Failed to write:', err);
      });
  }

  /**
   * Query the log file with optional filters.
   */
  async query(opts?: {
    sessionId?: string;
    event?: LifecycleEventType;
    since?: number;
    limit?: number;
  }): Promise<LifecycleEntry[]> {
    const limit = opts?.limit ?? 200;

    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const lines = raw.trim().split('\n').filter(Boolean);
    let entries: LifecycleEntry[] = [];

    // Parse in reverse (newest first) for efficiency with limit
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]) as LifecycleEntry;

        if (opts?.sessionId && entry.sessionId !== opts.sessionId) continue;
        if (opts?.event && entry.event !== opts.event) continue;
        if (opts?.since && entry.ts < opts.since) continue;

        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /**
   * Trim the log file if it exceeds MAX_LINES. Called on server start.
   */
  async trimIfNeeded(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;

    const trimmed = lines.slice(-TRIM_TO);
    await writeFile(this.filePath, trimmed.join('\n') + '\n', 'utf-8');
    console.log(`[LifecycleLog] Trimmed from ${lines.length} to ${trimmed.length} entries`);
  }
}

// Singleton
let instance: SessionLifecycleLog | null = null;

export function getLifecycleLog(filePath?: string): SessionLifecycleLog {
  if (!instance) {
    instance = new SessionLifecycleLog(filePath);
  }
  return instance;
}
