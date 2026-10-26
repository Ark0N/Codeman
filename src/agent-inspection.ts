/**
 * @fileoverview Bounded append-only JSONL evidence reads for agent inspection.
 * Opaque, expiring server-side cursors contain no public filesystem paths. A cursor
 * binds the caller, pane generation, attributed conversation and opened file identity.
 * Complete records only; an oversized row stalls explicitly rather than losing evidence.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';

export const INSPECT_MAX_BYTES = 65536;
export const INSPECT_SCAN_BYTES = 262144;
export interface InspectionScope {
  owner: string;
  sessionId: string;
  generation: string;
  conversationId: string;
}
interface CursorState {
  scope: string;
  /** Owner and session only: the unit the per-scope cap counts. */
  holder: string;
  path: string;
  identity: string;
  offset: number;
  observedSize: number;
  modifiedAt: number;
  changedAt: number;
  anchor: string;
  expiresAt: number;
}
export class InspectionConflict extends Error {}

/** UTF8-safe suffix, also used for explicitly non-incremental pane evidence. */
export function boundedUtf8Tail(text: string, maxBytes: number): string {
  // A UTF8 suffix fits within this many UTF16 units. Include a pair of extra
  // units so slicing cannot introduce a surrogate replacement inside the result.
  const bytes = Buffer.from(text.slice(-maxBytes - 2));
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
async function anchor(handle: FileHandle, offset: number): Promise<string> {
  const count = Math.min(offset, 4096);
  const head = Buffer.alloc(count);
  const tail = Buffer.alloc(count);
  await handle.read(head, 0, count, 0);
  await handle.read(tail, 0, count, Math.max(0, offset - count));
  return createHash('sha256').update(head).update(tail).digest('hex');
}

/** Cursors kept per owner and session; older ones are retired first. */
export const INSPECT_CURSORS_PER_SCOPE = 8;

export class InspectionReader {
  private readonly cursors = new Map<string, CursorState>();
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 1024,
    private readonly ttlMs = 900000,
    private readonly perScope = INSPECT_CURSORS_PER_SCOPE
  ) {}

  async read(path: string, scope: InspectionScope, maxBytes: number, since?: string) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > INSPECT_MAX_BYTES)
      throw new Error('Invalid byte budget');
    const scopeKey = JSON.stringify(scope);
    const previous = since ? this.cursors.get(since) : undefined;
    if (
      since &&
      (!previous || previous.expiresAt <= this.now() || previous.scope !== scopeKey || previous.path !== path)
    ) {
      throw new InspectionConflict('Invalid or expired inspection cursor; inspect without since to start again');
    }
    const handle = await open(path, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new InspectionConflict('Inspection source is not a regular file');
      const identity = `${before.dev}:${before.ino}:${before.birthtimeMs}`;
      let offset = previous?.offset ?? Math.max(0, before.size - INSPECT_SCAN_BYTES + 1);
      if (
        previous &&
        (identity !== previous.identity ||
          before.size < previous.observedSize ||
          (before.size === previous.observedSize &&
            (before.mtimeMs !== previous.modifiedAt || before.ctimeMs !== previous.changedAt)) ||
          (await anchor(handle, offset)) !== previous.anchor)
      ) {
        throw new InspectionConflict('Inspection cursor source changed; inspect without since to start again');
      }
      let startsAtBoundary = offset === 0;
      if (!previous && offset > 0) {
        const preceding = Buffer.alloc(1);
        await handle.read(preceding, 0, 1, offset - 1);
        startsAtBoundary = preceding[0] === 10;
      }
      const scan = Buffer.alloc(
        Math.min(INSPECT_SCAN_BYTES - (!previous && offset > 0 ? 1 : 0), Math.max(0, before.size - offset))
      );
      const { bytesRead } = await handle.read(scan, 0, scan.length, offset);
      let selectedStart = 0;
      let consumed = 0;
      let blockedReason: string | undefined;
      let omittedBeforeBytes = 0;
      if (!previous) {
        const leading = startsAtBoundary ? 0 : scan.indexOf(10) + 1;
        const completeEnd = scan.lastIndexOf(10, bytesRead - 1) + 1;
        if (!startsAtBoundary && leading === 0) {
          // The tail lies wholly inside one unfinished oversized record. Its
          // beginning is not known: retain the known file boundary rather than
          // manufacture a cursor pointing into a JSON/UTF8 fragment.
          offset = 0;
          blockedReason = 'record-exceeds-scan-limit';
        } else {
          selectedStart = completeEnd;
          consumed = completeEnd;
          while (selectedStart > leading) {
            const recordStart = Math.max(leading, scan.lastIndexOf(10, selectedStart - 2) + 1);
            if (completeEnd - recordStart > maxBytes) {
              if (selectedStart === completeEnd) {
                selectedStart = recordStart;
                consumed = recordStart;
                blockedReason = 'record-exceeds-output-budget';
              }
              break;
            }
            selectedStart = recordStart;
          }
          if (completeEnd < bytesRead && !blockedReason) blockedReason = 'partial-record';
          // If the only known boundary is the end of a skipped leading row,
          // the remainder is a partial record and stays pending there.
          if (completeEnd < leading) selectedStart = consumed = leading;
          omittedBeforeBytes = offset + selectedStart;
        }
      } else {
        while (consumed < bytesRead) {
          const end = scan.indexOf(10, consumed);
          if (end < 0) {
            blockedReason = bytesRead === INSPECT_SCAN_BYTES ? 'record-exceeds-scan-limit' : 'partial-record';
            break;
          }
          if (end + 1 > maxBytes) {
            if (consumed === 0) blockedReason = 'record-exceeds-output-budget';
            break;
          }
          consumed = end + 1;
        }
      }
      const evidenceBytes = scan.subarray(selectedStart, consumed);
      if (!isUtf8(evidenceBytes)) throw new InspectionConflict('Inspection source contains invalid UTF8');
      for (const row of evidenceBytes.toString('utf8').split('\n').slice(0, -1)) {
        try {
          JSON.parse(row);
        } catch {
          throw new InspectionConflict('Inspection source contains invalid JSONL');
        }
      }
      const after = await handle.stat();
      if (
        after.size < before.size ||
        after.ino !== before.ino ||
        (after.size === before.size && (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs))
      )
        throw new InspectionConflict('Inspection source changed during read');
      const nextAnchor = await anchor(handle, offset + consumed);
      const cursor = randomUUID();
      // No await between capacity enforcement and insertion: concurrent reads
      // must not all reserve the same remaining slot while hashing anchors.
      // Each owner and session keeps only its newest cursors, so one agent polling in
      // a loop retires its own oldest ones instead of pushing every other caller's out
      // of the shared map. The cursor just used stays among the newest, so a retry of
      // the last call still works. The global capacity is only a backstop.
      const holder = JSON.stringify([scope.owner, scope.sessionId]);
      const mine: string[] = [];
      for (const [key, value] of this.cursors) {
        if (value.expiresAt <= this.now()) this.cursors.delete(key);
        else if (value.holder === holder) mine.push(key);
      }
      while (mine.length >= this.perScope) this.cursors.delete(mine.shift()!);
      while (this.cursors.size >= this.capacity) this.cursors.delete(this.cursors.keys().next().value!);
      this.cursors.set(cursor, {
        scope: scopeKey,
        holder,
        path,
        identity,
        offset: offset + consumed,
        observedSize: before.size,
        modifiedAt: before.mtimeMs,
        changedAt: before.ctimeMs,
        anchor: nextAnchor,
        expiresAt: this.now() + this.ttlMs,
      });
      return {
        evidence: evidenceBytes.toString('utf8'),
        cursor,
        omittedBeforeBytes,
        truncated: omittedBeforeBytes > 0 || offset + consumed < before.size,
        blockedReason,
        scannedBytes: bytesRead,
      };
    } finally {
      await handle.close();
    }
  }
  clear(): void {
    this.cursors.clear();
  }
}
