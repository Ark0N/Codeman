/**
 * @fileoverview Short-lived, bounded guarded prompt receipts. No prompt content is
 * retained: only caller/session identity, lifecycle/input revisions and SHA-256.
 * A receipt is consumed synchronously before verification/delivery, including failures.
 */
import { createHash, randomUUID } from 'node:crypto';
import { stripAnsi } from './utils/regex-patterns.js';
import { visibleWidth } from './tui/tui-ansi.js';
export const STAGE_MAX_BYTES = 8192;
export const promptSha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export interface GuardedInputSnapshot {
  generation: string;
  revision: number;
  composerSha: string;
}
export interface GuardedInputTarget {
  id: string;
  snapshot(): GuardedInputSnapshot | null;
  write(text: string): Promise<boolean>;
  submit(expected: GuardedInputSnapshot): Promise<boolean>;
}
interface Receipt extends GuardedInputSnapshot {
  owner: string;
  sessionId: string;
  expiresAt: number;
  sha256: string;
}
export class GuardedInputConflict extends Error {}

/**
 * Conservatively read a Codex composer: exactly one visible, unwrapped row and a
 * known footer. Never remove internal spaces, infer an unknown shell prompt, or
 * interpret dialog options as authority. An unsupported frame yields no proof.
 */
export function readGuardedCodexComposer(screen: string): string | null {
  const lines = stripAnsi(screen)
    .split('\n')
    .map((line) => line.trimEnd());
  const rows = lines.map((line, index) => ({ line, index })).filter((row) => /^\s*›(?:\s|$)/.test(row.line));
  const last = rows.at(-1);
  if (!last) return null;
  const below = lines.slice(last.index + 1).filter((line) => line.trim());
  if (
    below.length === 0 ||
    below.length > 3 ||
    below.some(
      (line) =>
        !/^\s+(?:\d+% context left|\? for shortcuts|← for agents|\S+ (?:default|low|medium|high|xhigh|max) · )/.test(
          line
        )
    )
  )
    return null;
  // Preserve exact printable content; only SGR-dim placeholder/suggestion text is excluded.
  const raw = screen.split('\n')[last.index];
  let dim = false;
  let visible = '';
  // eslint-disable-next-line no-control-regex
  for (const token of raw.split(/(\x1b\[[0-9;]*m)/)) {
    // eslint-disable-next-line no-control-regex
    if (/^\x1b\[/.test(token)) {
      const codes = token.slice(2, -1).split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        // Extended color payloads may contain 0, 2 or 22; those are not SGR modes.
        if (codes[i] === 38 || codes[i] === 48 || codes[i] === 58) {
          i += codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
        } else if (codes[i] === 0 || codes[i] === 22) dim = false;
        else if (codes[i] === 2) dim = true;
      }
    } else if (!dim) visible += token;
  }
  return stripAnsi(visible).trimStart().slice(2).trimEnd();
}

/** Require the capture's caret at the exact end of the unwrapped composer. */
export function readGuardedCodexSnapshot(snapshot: string): string | null {
  // formatPaneSnapshot emits one absolute row address per line, then the caret.
  // Plain captures lack caret evidence and cannot prove invisible trailing edits.
  // eslint-disable-next-line no-control-regex
  const positions = [...snapshot.matchAll(/\x1b\[(\d+);(\d+)H/g)];
  if (positions.length < 2) return null;
  const caret = positions.at(-1)!;
  if (caret.index! + caret[0].length !== snapshot.length) return null;
  const rows: string[] = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const position = positions[i];
    if (Number(position[1]) !== i + 1 || position[2] !== '1') return null;
    rows.push(snapshot.slice(position.index! + position[0].length, positions[i + 1].index));
  }
  const composer = readGuardedCodexComposer(rows.join('\n'));
  if (composer === null) return null;
  let composerRow = -1;
  for (let i = rows.length - 1; i >= 0; i--)
    if (/^\s*›(?:\s|$)/.test(stripAnsi(rows[i]))) {
      composerRow = i;
      break;
    }
  const prefix = stripAnsi(rows[composerRow]).match(/^(\s*›[ \u00a0])/);
  if (!prefix || Number(caret[1]) !== composerRow + 1 || Number(caret[2]) !== visibleWidth(prefix[1] + composer) + 1)
    return null;
  return composer;
}

export class GuardedStageStore {
  private readonly receipts = new Map<string, Receipt>();
  private readonly busy = new Set<string>();
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 1024,
    private readonly ttlMs = 120000
  ) {}
  async stage(target: GuardedInputTarget, owner: string, message: string) {
    // eslint-disable-next-line no-control-regex
    const hasControls = /[\x00-\x1f\x7f-\x9f]/.test(message);
    if (
      !message ||
      message !== message.trimEnd() ||
      Buffer.byteLength(message) > STAGE_MAX_BYTES ||
      Buffer.from(message).toString('utf8') !== message ||
      hasControls
    )
      throw new GuardedInputConflict(
        'Stage requires printable single-line input within 8192 UTF8 bytes, without trailing whitespace'
      );
    const key = target.id;
    if (this.busy.has(key)) throw new GuardedInputConflict('Another guarded input operation is in progress');
    this.busy.add(key);
    try {
      const before = target.snapshot();
      if (!before || before.composerSha !== promptSha256(''))
        throw new GuardedInputConflict('An empty, verifiable composer is required');
      for (const [id, receipt] of this.receipts)
        if (receipt.expiresAt <= this.now() || receipt.sessionId === target.id) this.receipts.delete(id);
      // Refuse capacity before typing. Do not evict a caller's still-live receipt.
      // Include in-flight stages (this operation already owns one busy slot),
      // so different sessions cannot type concurrently into the same last slot.
      if (this.receipts.size + this.busy.size > this.capacity)
        throw new GuardedInputConflict('Guarded stage receipt capacity reached');
      if (!(await target.write(message)))
        throw new GuardedInputConflict('Staging delivery failed; inspect the pane before trying again');
      const after = target.snapshot();
      if (!after || after.generation !== before.generation || after.revision !== before.revision + 1)
        throw new GuardedInputConflict('Input or pane changed while staging; no receipt was issued');
      const stageId = randomUUID();
      const expiresAt = this.now() + this.ttlMs;
      const sha256 = promptSha256(message);
      this.receipts.set(stageId, { ...after, owner, sessionId: target.id, expiresAt, sha256 });
      return { stageId, sha256, expiresAt, sessionId: target.id, submitted: false as const };
    } finally {
      this.busy.delete(key);
    }
  }
  async submit(target: GuardedInputTarget, owner: string, stageId: string, confirmSha: string) {
    const receipt = this.receipts.get(stageId);
    if (!receipt || receipt.owner !== owner || receipt.sessionId !== target.id)
      throw new GuardedInputConflict('Unknown, used, or foreign stage receipt');
    // One shot, even a wrong hash or unprovable composer. No retry of ambiguous Enter.
    this.receipts.delete(stageId);
    if (this.busy.has(target.id)) throw new GuardedInputConflict('Another guarded input operation is in progress');
    this.busy.add(target.id);
    try {
      if (receipt.expiresAt <= this.now() || receipt.sha256 !== confirmSha)
        throw new GuardedInputConflict('Expired stage receipt or confirmation hash mismatch');
      const current = target.snapshot();
      if (
        !current ||
        current.generation !== receipt.generation ||
        current.revision !== receipt.revision ||
        current.composerSha !== receipt.sha256
      )
        throw new GuardedInputConflict('Staged composer, input, or pane identity changed; nothing submitted');
      if (!(await target.submit(current)))
        throw new GuardedInputConflict('Submission delivery failed or ambiguous; receipt consumed, inspect the pane');
      return { stageId, sessionId: target.id, submitted: true as const };
    } finally {
      this.busy.delete(target.id);
    }
  }
  clear(): void {
    this.receipts.clear();
    this.busy.clear();
  }
}
