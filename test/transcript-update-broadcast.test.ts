/**
 * @fileoverview The server path from a transcript watcher's `transcript:update` event to the
 * throttled `transcript:update` SSE broadcast, which the chat view's live updates depend on.
 *
 * Pinned: the first update broadcasts at once and a second one inside the interval broadcasts
 * once at its end (750 ms), stopTranscriptWatcher drops a pending trailing broadcast, and no
 * watcher starts for a session that cleanup is removing.
 *
 * Strategy: construct WebServer on port 0 in test mode (nothing listens until start()) and call
 * its private watcher methods directly.
 *
 * Port: N/A (no server start)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventEmitter } from 'node:events';
import { WebServer } from '../src/web/server.js';
import { SseEvent } from '../src/web/sse-events.js';

interface ServerInternals {
  broadcast: (event: string, data: unknown) => void;
  startTranscriptWatcher: (sessionId: string, transcriptPath: string) => void;
  stopTranscriptWatcher: (sessionId: string) => void;
  transcriptWatchers: Map<string, EventEmitter>;
  cleaningUp: Set<string>;
}

describe('transcript:update broadcast', () => {
  const SID = 'transcript-update-session';
  let server: ServerInternals;
  let broadcast: ReturnType<typeof vi.spyOn>;
  let transcriptPath: string;

  const updates = () => broadcast.mock.calls.filter(([event]) => event === SseEvent.TranscriptUpdate);

  beforeEach(() => {
    server = new WebServer(0, false, true) as unknown as ServerInternals;
    broadcast = vi.spyOn(server, 'broadcast').mockImplementation(() => {});
    transcriptPath = join(mkdtempSync(join(tmpdir(), 'codeman-transcript-update-')), 'conv.jsonl');
    writeFileSync(transcriptPath, '');
  });

  afterEach(() => {
    server.stopTranscriptWatcher(SID);
    vi.useRealTimers();
  });

  it('broadcasts the first update at once and a second one at the end of the interval', () => {
    server.startTranscriptWatcher(SID, transcriptPath);
    const watcher = server.transcriptWatchers.get(SID);
    expect(watcher).toBeDefined();
    vi.useFakeTimers();

    watcher!.emit('transcript:update');
    watcher!.emit('transcript:update');
    expect(updates()).toHaveLength(1);
    expect(updates()[0][1]).toMatchObject({ sessionId: SID });

    vi.advanceTimersByTime(749);
    expect(updates()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(updates()).toHaveLength(2);
    expect(updates()[1][1]).toMatchObject({ sessionId: SID });
  });

  it('drops a pending trailing broadcast when the watcher stops', () => {
    server.startTranscriptWatcher(SID, transcriptPath);
    const watcher = server.transcriptWatchers.get(SID)!;
    vi.useFakeTimers();

    watcher.emit('transcript:update');
    watcher.emit('transcript:update');
    server.stopTranscriptWatcher(SID);
    vi.advanceTimersByTime(1000);
    expect(updates()).toHaveLength(1);
    expect(server.transcriptWatchers.has(SID)).toBe(false);
  });

  it('starts no watcher for a session that cleanup is removing', () => {
    server.cleaningUp.add(SID);
    server.startTranscriptWatcher(SID, transcriptPath);
    expect(server.transcriptWatchers.has(SID)).toBe(false);
    server.cleaningUp.delete(SID);
  });
});
