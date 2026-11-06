/**
 * @fileoverview Reading a DeepSeek Harness (`dsh`) session transcript off disk.
 *
 * ## Why this exists
 *
 * `GET /api/sessions/:id/last-response` is how an agent (and the Response
 * Viewer) reads what a worker actually said. For Claude it comes from
 * `~/.claude/projects/**`, for Codex from `~/.codex/sessions/**`, and for every
 * other external CLI it comes from segmenting the terminal buffer, because
 * those CLIs write nothing a reader could open.
 *
 * dsh is not in that last group: it writes a complete, structured JSONL
 * transcript per session. Falling back to the pane for it was measurably wrong
 * rather than merely coarse — dsh-TUI paints a full-screen splash, so the pane
 * segmenter answered a `last-response` call for a fresh dsh session with the
 * ASCII-art logo:
 *
 *     {"text":"✦dsh-TUI v0.8.8█▀▀▀▄█▀▀▀▀█▀▀▀▀█▀▀▀▄█▀▀▀▀…","hasContext":true}
 *
 * which an agent polling for a worker's answer reads as an answer. This module
 * is the real source: it locates the session's transcript, decodes it, and
 * returns the last turn's text.
 *
 * ## The three things that make dsh transcripts unlike codex rollouts
 *
 * **1. One zstd FRAME per append, not one zstd stream.** The file is
 * `session.jsonl.zstd`, and dsh appends by compressing each batch of lines into
 * its own frame and writing it at the end. `zstd -dc` handles that (frames
 * concatenate by definition), but before Node 24.22 and 26.10
 * (nodejs/node#65865) `zlib.zstdDecompress()` and `createZstdDecompress()` both
 * stop at the first frame end, and the supported range still includes those
 * versions: measured on a real 56-line transcript, Node returned 158 bytes /
 * 1 line where the CLI returned 43,747 bytes / 56 lines. That is a silent
 * truncation to the session header: every call would have reported "no answer
 * yet" forever. `decodeZstdFrames()` below walks the frame headers itself and
 * decompresses each frame, and `test/deepseek-transcript.test.ts` pins it
 * against multi-frame fixtures.
 *
 * **2. The user's prompts are mixed with injected context.** Every turn also
 * writes a `user/message` whose source is a plugin (the runtime-context
 * snapshot: sandbox policy, approval policy, cwd). Those are `source.kind ===
 * 'plugin'`; a real prompt is `source.kind === 'user'`. Rendering the plugin
 * ones would show the agent its own boilerplate back as the user's words.
 *
 * **3. A failed turn is not an empty turn.** `turn/end` carries
 * `reason.kind === 'error'` with the provider's message. Returning `""` there
 * makes an agent poll `last-response` fifteen times and conclude the worker
 * never answered, when the truth ("the provider rejected the request") was on
 * disk the whole time. A turn that ends in an error and produced no text
 * answers with that error, prefixed so it can never be mistaken for the model's
 * own words.
 *
 * Verified against `dsh 0.1.1-rc.2` + `@deepseek-harness-tui/dsh-tui 0.8.8`.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

/**
 * One rendered block, in the shape the Response Viewer already speaks (see
 * `web/response-viewer-transcript.ts`). Imported as a type only — this module
 * must stay usable from the session layer without dragging web/ into it.
 */
export interface DeepSeekTranscriptBlock {
  kind: 'prompt' | 'response' | 'status' | 'tool';
  label: 'Prompt' | 'Response' | 'Status' | 'Tool';
  role: 'user' | 'assistant';
  text: string;
}

export interface DeepSeekTranscriptResult {
  /** Last turn's answer (or its error, prefixed). Empty before the first turn. */
  text: string;
  /** ISO timestamp of the event `text` came from, or '' when unknown. */
  timestamp: string;
  /** Rendered blocks, oldest first. Only built when the caller asks for them. */
  blocks: DeepSeekTranscriptBlock[];
  /** dsh's own session id, from the header line. */
  sessionId?: string;
  /** Workspace the harness recorded for the session. */
  cwd?: string;
}

/**
 * zstd decompression is a RUNTIME capability here, not an import.
 *
 * Node grew `zlib` zstd support in 22.15 (and `@types/node` still does not
 * declare it), while Codeman's floor is Node 22.0. So it is resolved through a
 * narrow cast and checked before use: on an older 22.x a dsh session keeps the
 * pane-segmenter behaviour it had before this module existed instead of
 * throwing on every `last-response` call.
 */
type ZstdDecompressSync = (buf: Buffer) => Buffer;
const zstdDecompressSync: ZstdDecompressSync | undefined = (
  zlib as unknown as { zstdDecompressSync?: ZstdDecompressSync }
).zstdDecompressSync;

/** Whether this Node can decode the compressed transcripts dsh writes. */
export function zstdSupported(): boolean {
  return typeof zstdDecompressSync === 'function';
}

/** zstd frame magic (RFC 8878 §3.1.1). */
const ZSTD_MAGIC = 0xfd2fb528;
/** Skippable-frame magic range: 0x184D2A50..0x184D2A5F. */
const ZSTD_SKIPPABLE_LO = 0x184d2a50;
const ZSTD_SKIPPABLE_HI = 0x184d2a5f;

const DID_FIELD_SIZE = [0, 1, 2, 4];
const FCS_FIELD_SIZE = [0, 2, 4, 8];

/**
 * Byte ranges of the zstd frames in `buf`, in order.
 *
 * Walks frame headers and block headers only — no decompression — so the cost
 * is proportional to the number of blocks, not to the content. Stops (rather
 * than throws) at the first thing it cannot parse, so a transcript still being
 * appended to mid-write yields every whole frame before the torn tail instead
 * of failing the whole read.
 *
 * ⚠️ Splitting on the magic bytes instead would be wrong: the 4-byte sequence
 * can occur inside compressed data, and a false split corrupts everything after
 * it. The block walk is what makes the boundaries exact.
 */
export function zstdFrameRanges(buf: Buffer): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;

  while (offset + 4 <= buf.length) {
    const magic = buf.readUInt32LE(offset);

    if (magic >= ZSTD_SKIPPABLE_LO && magic <= ZSTD_SKIPPABLE_HI) {
      if (offset + 8 > buf.length) break;
      const end = offset + 8 + buf.readUInt32LE(offset + 4);
      if (end > buf.length || end <= offset) break;
      offset = end;
      continue;
    }
    if (magic !== ZSTD_MAGIC) break;

    let p = offset + 4;
    if (p >= buf.length) break;

    const descriptor = buf[p] as number;
    p += 1;
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const hasChecksum = (descriptor >> 2) & 1;
    const dictIdFlag = descriptor & 3;

    if (!singleSegment) p += 1; // window descriptor
    p += DID_FIELD_SIZE[dictIdFlag] as number;
    // FCS is absent for flag 0 UNLESS Single_Segment is set, where it is 1 byte.
    p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : (FCS_FIELD_SIZE[fcsFlag] as number);
    if (p > buf.length) break;

    let lastBlock = false;
    let torn = false;
    while (!lastBlock) {
      if (p + 3 > buf.length) {
        torn = true;
        break;
      }
      const header = (buf[p] as number) | ((buf[p + 1] as number) << 8) | ((buf[p + 2] as number) << 16);
      p += 3;
      lastBlock = (header & 1) === 1;
      const blockType = (header >> 1) & 3;
      const blockSize = header >> 3;
      if (blockType === 3) {
        torn = true; // reserved: refuse rather than guess
        break;
      }
      p += blockType === 1 ? 1 : blockSize; // RLE stores a single byte
      if (p > buf.length) {
        torn = true;
        break;
      }
    }
    if (torn) break;

    if (hasChecksum) p += 4;
    if (p > buf.length) break;

    ranges.push([offset, p]);
    offset = p;
  }

  return ranges;
}

/**
 * Decode a possibly multi-frame zstd buffer. A buffer that does not start with
 * a zstd magic is passed through unchanged, which is what lets the same reader
 * open a plain `session.jsonl` (dsh writes one when compression is off).
 *
 * A frame that fails to decompress truncates the decode THERE rather than
 * failing it: everything decoded before it is kept, so a half-written tail
 * frame does not cost the caller the whole conversation. (Not "skipped" — a
 * frame after a corrupt one is never reached, which is the safe reading: dsh
 * appends, so a bad frame means everything after it is suspect too.)
 */
export function decodeZstdFrames(buf: Buffer): string {
  if (buf.length < 4) return buf.toString('utf8');
  const magic = buf.readUInt32LE(0);
  if (magic !== ZSTD_MAGIC && (magic < ZSTD_SKIPPABLE_LO || magic > ZSTD_SKIPPABLE_HI)) {
    return buf.toString('utf8');
  }

  if (!zstdDecompressSync) return '';

  const parts: Buffer[] = [];
  for (const [start, end] of zstdFrameRanges(buf)) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      // Torn or corrupt frame: keep what decoded before it.
      break;
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

interface DshEvent {
  type?: string;
  seq?: number | null;
  time?: number;
  data?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Strip a leaked reasoning prefix.
 *
 * Some providers stream reasoning into the same text block and close it with
 * `</think>` without ever opening it (measured on a local deepseek-v4-flash
 * route: `"I'll read the file first.</think>\n\nThe add function is…"`). The
 * closing tag is the only reliable boundary, so everything up to the LAST one
 * goes. A block with no tag is returned untouched.
 */
function stripReasoningPrefix(text: string): string {
  const close = text.lastIndexOf('</think>');
  return close === -1 ? text : text.slice(close + '</think>'.length);
}

/** `stripReasoning` is for ASSISTANT content only: a user prompt containing a
 *  literal `</think>` (someone pasting a transcript, say) must render whole. */
function textOfContent(content: unknown, stripReasoning = true): string {
  const parts: string[] = [];
  for (const entry of asArray(content)) {
    const block = asRecord(entry);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(stripReasoning ? stripReasoningPrefix(block.text) : block.text);
    }
  }
  return parts.join('').trim();
}

function toolCallsOfContent(content: unknown): string[] {
  const calls: string[] = [];
  for (const entry of asArray(content)) {
    const block = asRecord(entry);
    if (!block || block.type !== 'tool-call') continue;
    const name = typeof block.name === 'string' ? block.name : 'tool';
    const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {});
    calls.push(`${name}(${args})`);
  }
  return calls;
}

/** Flatten a `tool/result` message down to its text payload. */
function textOfToolResult(message: unknown): string {
  const parts: string[] = [];
  for (const entry of asArray(asRecord(message)?.content)) {
    const block = asRecord(entry);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    if (block.type === 'tool-result') {
      for (const inner of asArray(block.content)) {
        const innerBlock = asRecord(inner);
        if (innerBlock?.type === 'text' && typeof innerBlock.text === 'string') parts.push(innerBlock.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function isoTime(time: unknown): string {
  return typeof time === 'number' && Number.isFinite(time) ? new Date(time).toISOString() : '';
}

interface TurnAccumulator {
  /** Finalized `assistant/message` text, in step order. */
  finalized: Map<number, string>;
  /** Steps that produced a finalized message AT ALL. ⚠️ Not the same as a
   *  non-empty entry in `finalized`: a step whose whole reply was reasoning
   *  strips to `''`, and without this the deltas — which are NOT stripped at
   *  write time — would be resurrected in its place, putting the model's raw
   *  `</think>` monologue in front of the caller (measured). */
  finalizedSteps: Set<number>;
  /** Streamed deltas per step, used only where no finalized message landed. */
  streamed: Map<number, string>;
  /** Step order as encountered, so a reply reads in the order it was produced. */
  steps: number[];
  timestamp: string;
  /** Pre-rendered "Turn error: …" / "Turn ended: …" line, when the turn did not
   *  end with `completed`. */
  ending?: string;
}

function ensureStep(turn: TurnAccumulator, step: number): void {
  if (!turn.steps.includes(step)) turn.steps.push(step);
}

function turnText(turn: TurnAccumulator): string {
  const parts: string[] = [];
  for (const step of turn.steps) {
    // Deltas are only consulted for a step the model never finalized — a step
    // that has both would otherwise render its text twice.
    const text = turn.finalizedSteps.has(step)
      ? (turn.finalized.get(step) ?? '')
      : stripReasoningPrefix(turn.streamed.get(step) ?? '');
    if (text.trim()) parts.push(text.trim());
  }
  return parts.join('\n\n').trim();
}

/**
 * Parse a decoded dsh transcript.
 *
 * `text` is the LAST TURN's answer, not the last assistant message anywhere in
 * the file: a turn that errored after an earlier turn answered must not hand
 * back the earlier turn's text as though it were this turn's reply.
 */
export function parseDeepSeekTranscript(raw: string, options: { blocks?: boolean } = {}): DeepSeekTranscriptResult {
  const wantBlocks = options.blocks === true;
  const blocks: DeepSeekTranscriptBlock[] = [];
  const turns = new Map<number, TurnAccumulator>();
  const turnOrder: number[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;

  const getTurn = (n: number): TurnAccumulator => {
    let turn = turns.get(n);
    if (!turn) {
      turn = { finalized: new Map(), finalizedSteps: new Set(), streamed: new Map(), steps: [], timestamp: '' };
      turns.set(n, turn);
      turnOrder.push(n);
    }
    return turn;
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: DshEvent;
    try {
      event = JSON.parse(line) as DshEvent;
    } catch {
      continue; // a torn tail line, or a frame we could not decode
    }
    const data = asRecord(event.data) ?? {};
    const turnNo = typeof data.turn === 'number' ? data.turn : 0;
    const stepNo = typeof data.step === 'number' ? data.step : 0;

    switch (event.type) {
      case 'session': {
        const header = event as unknown as Record<string, unknown>;
        if (typeof header.id === 'string') sessionId = header.id;
        if (typeof header.cwd === 'string') cwd = header.cwd;
        break;
      }
      case 'user/message': {
        // ⚠️ Only a real prompt. The plugin-sourced twin is the runtime-context
        // snapshot dsh injects every turn (sandbox policy, approvals, cwd).
        if (asRecord(data.source)?.kind !== 'user') break;
        if (!wantBlocks) break;
        const text = textOfContent(data.content, false);
        if (text) blocks.push({ kind: 'prompt', label: 'Prompt', role: 'user', text });
        break;
      }
      case 'assistant/message': {
        const message = asRecord(data.message);
        const turn = getTurn(turnNo);
        ensureStep(turn, stepNo);
        const text = textOfContent(message?.content);
        if (message) turn.finalizedSteps.add(stepNo);
        if (text) {
          turn.finalized.set(stepNo, text);
          turn.timestamp = isoTime(event.time) || turn.timestamp;
          if (wantBlocks) blocks.push({ kind: 'response', label: 'Response', role: 'assistant', text });
        }
        if (wantBlocks) {
          for (const call of toolCallsOfContent(message?.content)) {
            blocks.push({ kind: 'tool', label: 'Tool', role: 'assistant', text: call });
          }
        }
        break;
      }
      case 'assistant/chunk': {
        const chunk = asRecord(data.chunk);
        if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') break;
        const turn = getTurn(turnNo);
        ensureStep(turn, stepNo);
        turn.streamed.set(stepNo, (turn.streamed.get(stepNo) ?? '') + chunk.text);
        break;
      }
      case 'text-chunks': {
        // The batched form of the same deltas (dsh coalesces once a stream gets
        // going). ⚠️ These carry `seq: null`, so file order is the only order.
        const turn = getTurn(turnNo);
        ensureStep(turn, stepNo);
        const texts = asArray(data.texts)
          .filter((t): t is string => typeof t === 'string')
          .join('');
        if (texts) turn.streamed.set(stepNo, (turn.streamed.get(stepNo) ?? '') + texts);
        break;
      }
      case 'tool/result': {
        if (!wantBlocks) break;
        const text = textOfToolResult(data.message);
        if (text) blocks.push({ kind: 'tool', label: 'Tool', role: 'assistant', text });
        break;
      }
      case 'turn/end': {
        const turn = getTurn(turnNo);
        const reason = asRecord(data.reason);
        if (reason && reason.kind !== 'completed') {
          // Two different things wear this field: a provider failure
          // (`kind:'error'` with a message) and an ordinary early stop
          // (`kind:'max-tokens'`, measured live). Calling the second one an
          // error would misreport a truncated but real answer.
          const error = asRecord(reason.error);
          const message = typeof error?.message === 'string' ? error.message : undefined;
          const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown';
          turn.ending = message ? `Turn error: ${message}` : `Turn ended: ${kind}`;
          if (wantBlocks) {
            blocks.push({ kind: 'status', label: 'Status', role: 'assistant', text: turn.ending });
          }
        }
        turn.timestamp = isoTime(event.time) || turn.timestamp;
        break;
      }
      default:
        break;
    }
  }

  const lastTurn = turnOrder.length > 0 ? turns.get(turnOrder[turnOrder.length - 1] as number) : undefined;
  let text = lastTurn ? turnText(lastTurn) : '';
  // A turn that failed and said nothing answers with its failure, labelled so
  // it can never read as the model's own words. Without this an agent polls
  // `last-response` fifteen times and concludes the worker never answered.
  if (!text && lastTurn?.ending) text = lastTurn.ending;

  return { text, timestamp: lastTurn?.timestamp ?? '', blocks, sessionId, cwd };
}

/**
 * `$DSH_HOME` for one session: a per-session override wins (`DSH_HOME` is an
 * allowlisted `envOverrides` prefix, and pointing a worker at its own profile
 * tree is a documented thing to do), then the server's own environment, then
 * `~/.dsh`. Reading the wrong tree does not fail loudly — it silently finds no
 * transcript — so this must resolve exactly the way the spawn did.
 */
/* ⚠️ The override is EPHEMERAL: `envOverrides` is applied at spawn and exported
 * through `tmux setenv`, but is deliberately not persisted to state.json (it can
 * carry provider keys). A session that overrode `DSH_HOME` and then outlived a
 * server restart therefore resolves to the default tree and finds no transcript
 * — it reads as "nothing said yet" rather than as another session's answer,
 * because every candidate is matched on its recorded `cwd`. */
export function resolveDeepSeekHome(session: { deepSeekHomeOverride?: string }): string {
  const override = session.deepSeekHomeOverride;
  if (override && override.trim()) return override.trim();
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return join(homedir(), '.dsh');
}

/**
 * How far apart a session's start and its transcript's `createdAt` may be and
 * still be the same session. dsh writes the header within ~2 s of pane start
 * (measured); 60 s absorbs a cold profile boot without ever reaching a sibling
 * started minutes later.
 */
const PAIRING_WINDOW_MS = 60_000;

/** Transcript file names dsh has used, newest convention first. */
const TRANSCRIPT_FILES = ['session.jsonl.zstd', 'session.jsonl'];

/**
 * Locate the transcript for a session.
 *
 * dsh buckets sessions by a mangled cwd (`--home-you-code-app--`) and then by
 * its own session id, and the id form has changed between versions (`<uuid>`
 * and `session-<uuid>` both exist on disk here). ⚠️ So the mangling is NOT
 * reproduced: every candidate's own header line carries `cwd`, which is
 * authoritative, and matching on it is immune to the next naming change.
 *
 * Pairing a Codeman session with ITS transcript then has one hard rule and one
 * ladder. The rule: a transcript created BEFORE this session started belongs to
 * an earlier conversation in the same directory and is never eligible. Measured
 * cost of getting that wrong — a freshly spawned worker answered its very first
 * `last-response` with the PREVIOUS session's reply, which is worse than saying
 * nothing, because an agent cannot tell a stale answer from a fresh one.
 *
 * The ladder, once the older ones are out:
 *
 *   1. a transcript whose header `createdAt` sits within `PAIRING_WINDOW_MS` of
 *      this session's start — that is this pane's own boot, and it stays right
 *      even when a sibling session is running in the same case directory;
 *   2. otherwise the newest transcript created after this session started;
 *   3. otherwise nothing.
 *
 * ⚠️ The boot transcript wins for as long as it exists on disk — deliberately,
 * and even over a LATER transcript in the same workspace. Step 2 cannot tell a
 * `/new` from a sibling session that started later in the same directory, so
 * preferring newest-eligible would hand a worker its busier sibling's reply
 * (the exact bug the hard rule above was measured against, one seat over).
 * The cost of that choice: after an interactive `/new` in a dsh tab, this
 * reader keeps serving the pre-`/new` conversation (the same session's own
 * earlier turns — stale, never foreign); step 2 is reached only when no
 * boot-window transcript exists. Worker fleets never `/new`, so they only
 * ever see step 1.
 */
export async function findDeepSeekTranscript(options: {
  dshHome: string;
  workingDir: string;
  startedAt?: number;
}): Promise<string | null> {
  const sessionsDir = join(options.dshHome, 'sessions');
  let buckets: string[];
  try {
    buckets = (await fs.readdir(sessionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const bucket of buckets) {
    const bucketPath = join(sessionsDir, bucket);
    let sessions: string[];
    try {
      sessions = (await fs.readdir(bucketPath, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const sessionDir of sessions) {
      for (const file of TRANSCRIPT_FILES) {
        const path = join(bucketPath, sessionDir, file);
        const stat = await fs.stat(path).catch(() => null);
        if (!stat || !stat.isFile() || stat.size === 0) continue;
        candidates.push({ path, mtimeMs: stat.mtimeMs });
        break;
      }
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const startedAt = options.startedAt ?? 0;
  // Slack in both directions: the harness writes its header a beat after the
  // pane starts, and mtimes on a shared clock are not worth trusting to the ms.
  const floor = startedAt > 0 ? startedAt - PAIRING_WINDOW_MS : 0;

  let laterMatch: string | null = null;
  for (const candidate of candidates) {
    const header = await readTranscriptHeader(candidate.path);
    if (!header || header.cwd !== options.workingDir) continue;
    // No usable header timestamp: fall back to the file's own mtime, which is
    // still enough to keep a pre-session transcript out.
    const createdAt = header.createdAt ?? candidate.mtimeMs;
    if (createdAt < floor) continue;
    if (startedAt > 0 && Math.abs(createdAt - startedAt) <= PAIRING_WINDOW_MS) return candidate.path;
    if (!laterMatch) laterMatch = candidate.path;
  }
  return laterMatch;
}

/**
 * Read only the first frame of a transcript, which is where the header line
 * lives. Bounded: a candidate scan must never decompress every conversation on
 * the box to answer one `last-response` call.
 */
async function readTranscriptHeader(path: string): Promise<{ cwd?: string; id?: string; createdAt?: number } | null> {
  let handle;
  try {
    handle = await fs.open(path, 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead === 0) return null;
    const text = decodeZstdFrames(head.subarray(0, bytesRead));
    const firstLine = text.split('\n').find((line) => line.trim());
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as { type?: string; cwd?: string; id?: string; createdAt?: number };
    if (parsed.type !== 'session') return null;
    return {
      cwd: parsed.cwd,
      id: parsed.id,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Hard ceiling on a transcript read. A long agent run is a few hundred KB; a
 *  file past this is pathological and is not worth a synchronous decode. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * Memo of the last few decoded transcripts, keyed on (path, mtime, size,
 * blocks). The skill's `last_text` polls once per second, and each poll used
 * to zstdDecompressSync + reparse the WHOLE file on the event loop even when
 * nothing had been appended — a multi-MB transcript made that a repeated
 * ~100ms-class stall on the single-threaded server. A poll that finds the
 * file unchanged now costs one stat. Insertion-order eviction; tiny, because
 * an entry only earns its keep while a session is being actively polled.
 */
const parseMemo = new Map<string, DeepSeekTranscriptResult>();
const PARSE_MEMO_MAX = 16;

/** Test seam: a fixture that rewrites one path in place inside a single mtime
 *  tick would otherwise read its predecessor back out of the memo. */
export function resetDeepSeekTranscriptMemoForTest(): void {
  parseMemo.clear();
}

/**
 * Read one dsh session's last answer.
 *
 * ⚠️ The two empty outcomes are deliberately different, because the caller must
 * treat them differently:
 *
 * - `null` means **this reader cannot run here** (a Node without zstd), and is
 *   the signal to fall back to the pane segmenter.
 * - an empty `text` means **read fine, nothing said yet** — no transcript for
 *   this workspace, or a turn still in flight.
 *
 * Collapsing the two would put the ASCII-art splash back in front of an agent
 * that is polling for a worker's first answer.
 */
export async function readDeepSeekLastResponse(
  session: { workingDir: string; createdAt?: Date | number; deepSeekHomeOverride?: string },
  options: { blocks?: boolean } = {}
): Promise<DeepSeekTranscriptResult | null> {
  const createdAt = session.createdAt instanceof Date ? session.createdAt.getTime() : session.createdAt;
  // dsh compresses by default, so a Node without zstd can read nothing here.
  // That is the one case the pane is still the better answer.
  if (!zstdSupported()) return null;

  const empty: DeepSeekTranscriptResult = { text: '', timestamp: '', blocks: [] };
  const path = await findDeepSeekTranscript({
    dshHome: resolveDeepSeekHome(session),
    workingDir: session.workingDir,
    startedAt: typeof createdAt === 'number' ? createdAt : undefined,
  });
  if (!path) return empty;

  const stat = await fs.stat(path).catch(() => null);
  if (!stat || stat.size > MAX_TRANSCRIPT_BYTES) return empty;

  const memoKey = `${path}|${stat.mtimeMs}|${stat.size}|${options.blocks ? 1 : 0}`;
  const memoized = parseMemo.get(memoKey);
  if (memoized) return memoized;

  let buf: Buffer;
  try {
    buf = await fs.readFile(path);
  } catch {
    return empty;
  }
  const result = parseDeepSeekTranscript(decodeZstdFrames(buf), options);
  if (parseMemo.size >= PARSE_MEMO_MAX) {
    const oldest = parseMemo.keys().next().value;
    if (oldest !== undefined) parseMemo.delete(oldest);
  }
  parseMemo.set(memoKey, result);
  return result;
}
