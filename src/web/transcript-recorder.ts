/**
 * @fileoverview Timer that fills the opt-in saved transcripts (`transcript-store.ts`).
 *
 * Every {@link RECORD_INTERVAL_MS} it asks each live session for its plain text and hands it
 * to the store, one session at a time and asynchronously (a 100k-line `capture-pane` is a few
 * MB). A snapshot whose text did not change since the last one is not written again. While the
 * setting is off the timer does nothing at all: no capture, no file.
 *
 * Tests: `test/transcript-recorder.test.ts`.
 *
 * @module web/transcript-recorder
 */

import { createHash } from 'node:crypto';
import type { TranscriptStore } from '../transcript-store.js';

export const RECORD_INTERVAL_MS = 60_000;

export interface RecordableSession {
  id: string;
  /**
   * `force`: write even if nothing new happened (the file was deleted since the last snapshot).
   * A source that can tell "unchanged" cheaply may return null when `force` is false.
   */
  captureTranscriptText(force?: boolean): Promise<string | null>;
}

export class TranscriptRecorder {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Last snapshot hash per session, so an idle session costs no write. */
  private readonly last = new Map<string, string>();

  constructor(
    private readonly store: TranscriptStore,
    private readonly sessions: () => Iterable<RecordableSession>,
    private readonly intervalMs: number = RECORD_INTERVAL_MS
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.recordAll(), this.intervalMs);
    // Never holds the process open.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async recordAll(): Promise<void> {
    if (!this.store.isEnabled || this.running) return;
    this.running = true;
    try {
      const live = new Set<string>();
      for (const s of this.sessions()) {
        live.add(s.id);
        if (!this.store.isEnabled) return;
        try {
          const prev = this.last.get(s.id);
          const text = await s.captureTranscriptText(!prev?.startsWith(`${this.store.generation}:`));
          if (!text) continue;
          // The deletion count is part of the key: after a delete the same text must be written again.
          const key = `${this.store.generation}:${createHash('sha1').update(text).digest('hex')}`;
          if (this.last.get(s.id) === key) continue;
          await this.store.save(s.id, text);
          this.last.set(s.id, key);
        } catch (err) {
          console.warn(`[Transcript] Recording ${s.id} failed:`, err instanceof Error ? err.message : err);
        }
      }
      for (const id of this.last.keys()) if (!live.has(id)) this.last.delete(id);
    } finally {
      this.running = false;
    }
  }
}
