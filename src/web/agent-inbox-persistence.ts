/**
 * @fileoverview Opt-in snapshot of the agent inbox, so pending mail between agents
 * survives a server restart (the agents themselves keep running in tmux across it).
 *
 * Off by default: an install that never turns on `agentInboxPersistEnabled` writes
 * nothing new to disk. The rules (discussion #558):
 * - Off means no file. Switching it off deletes the snapshot; the in-memory inboxes
 *   stay as they are.
 * - Its own file under `dataPath()`, written 0600 through tmp + rename like
 *   `intents.json`, since messages carry the same kind of text prompts do. It is never
 *   read by `/api/search` and `sensitive-path.ts` keeps the file viewer off it.
 * - Writes are debounced (a burst of posts is one write) and flushed on shutdown.
 * - Boot pruning is NOT done here: the server calls `agentInbox.pruneExcept()` only
 *   after the session restore succeeded, so a failed restore leaves the mail alone.
 *
 * @module web/agent-inbox-persistence
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../config/instance.js';
import { agentInbox, type AgentInbox } from './agent-inbox.js';

/** A burst of posts (a coordinator fanning out to five workers) becomes one write. */
const WRITE_DEBOUNCE_MS = 250;

export class AgentInboxPersistence {
  private enabled = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly inbox: AgentInbox = agentInbox,
    /** Resolved per call: test HOMEs change between files. */
    private readonly filePath: () => string = () => dataPath('agent-inbox.json'),
    private readonly debounceMs: number = WRITE_DEBOUNCE_MS
  ) {
    this.inbox.onChange = () => this.schedule();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Boot: apply the setting and, when it is on, load the snapshot into the store.
   * Returns how many messages were restored. A missing or unreadable file is an
   * empty inbox, never a failed boot.
   */
  load(enabled: boolean): number {
    this.enabled = enabled;
    if (!enabled) {
      // A file left from an earlier "on" is removed, so off really means no file.
      this.removeFile();
      return 0;
    }
    const path = this.filePath();
    if (!existsSync(path)) return 0;
    try {
      return this.inbox.restore(JSON.parse(readFileSync(path, 'utf-8')));
    } catch (err) {
      console.warn(`[AgentInbox] Failed to load ${path}, starting empty:`, err);
      return 0;
    }
  }

  /**
   * The setting changed. On: write the current inboxes now. Off: drop any pending
   * write and delete the snapshot; memory is untouched.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.writeNow();
    } else {
      this.cancel();
      this.removeFile();
    }
  }

  /** Shutdown: write a pending change now instead of losing it with the timer. */
  flush(): void {
    if (!this.timer) return;
    this.cancel();
    this.writeNow();
  }

  /** Test hook: drop a pending write and detach from the store. */
  dispose(): void {
    this.cancel();
    if (this.inbox.onChange) this.inbox.onChange = undefined;
  }

  private schedule(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow();
    }, this.debounceMs);
    // A pending write must not hold the process open; shutdown flushes it explicitly.
    this.timer.unref();
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private writeNow(): void {
    if (!this.enabled) return;
    const path = this.filePath();
    const tmpPath = `${path}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      // 0600: agent messages can carry anything a prompt can, secrets included.
      // `mode` applies only when the file is created, and the rename makes every
      // write a fresh file, so the final file is always 0600.
      rmSync(tmpPath, { force: true });
      writeFileSync(tmpPath, JSON.stringify(this.inbox.snapshot()), { mode: 0o600 });
      renameSync(tmpPath, path);
    } catch (err) {
      console.warn(`[AgentInbox] Failed to persist ${path}:`, err);
    }
  }

  private removeFile(): void {
    const path = this.filePath();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}.tmp`, { force: true });
    } catch (err) {
      console.warn(`[AgentInbox] Failed to remove ${path}:`, err);
    }
  }
}

/** Process-wide instance wired to `agentInbox`; the server and the settings route use it. */
export const agentInboxPersistence = new AgentInboxPersistence();
