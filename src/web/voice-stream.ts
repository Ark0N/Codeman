/**
 * @fileoverview Upstream half of Claude voice dictation: one browser recording
 * relayed to the speech-to-text service Claude Code's own `/voice` mode uses.
 *
 * The browser cannot talk to that service directly — it would need the Claude
 * OAuth bearer token in page JavaScript, and the endpoint is not CORS-open — so
 * Codeman sits in the middle and is the only thing that ever holds the token.
 * See `docs/claude-voice-plan.md` for the protocol table this implements.
 *
 * Wire contract (mirrors the CLI's `connectVoiceStream`):
 * - Query pins the audio format: linear16 PCM, 16 kHz, mono. The browser worklet
 *   produces exactly that; a mismatch transcribes as silence or noise, never an error.
 * - `{"type":"KeepAlive"}` on open and every 8s, or upstream drops the socket
 *   between utterances.
 * - Audio frames go up as raw binary.
 * - Downstream, `TranscriptText`/`TranscriptInterim` carry the RUNNING transcript
 *   (each frame supersedes the previous one — they are not deltas to concatenate),
 *   and `TranscriptEndpoint` promotes the pending interim to final.
 * - `{"type":"CloseStream"}` finalizes; the endpoint frame that follows is the
 *   last transcript, so `finalize()` waits briefly for it rather than closing.
 *
 * The pure builders at the top are unit-tested; `VoiceStreamRelay` owns the socket,
 * the keepalive timer and the lifetime cap.
 */

import WebSocket from 'ws';
import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  FINALIZE_TIMEOUT_MS,
  KEEPALIVE_INTERVAL_MS,
  MAX_KEYTERMS_HEADER_CHARS,
  MAX_STREAM_MS,
  VOICE_STREAM_PATH,
  voiceStreamBase,
} from '../config/voice.js';

const KEEPALIVE_FRAME = '{"type":"KeepAlive"}';
const CLOSE_STREAM_FRAME = '{"type":"CloseStream"}';

export interface VoiceStreamParams {
  /** BCP-47-ish language hint. Anything unusable falls back to 'en'. */
  language?: string;
  /** Domain vocabulary sent as a recognition hint. */
  keyterms?: string[];
}

/**
 * Collapse keyterms into the single ASCII header value upstream accepts.
 *
 * Commas separate terms, so a comma INSIDE a term would silently split it; it is
 * replaced with a space rather than dropped. Non-ASCII is stripped because the
 * value travels as an HTTP header, where anything outside the visible ASCII range
 * is not portable. Deduped and truncated on a term boundary so a long list degrades
 * to a shorter list instead of a mangled final term.
 */
export function sanitizeKeyterms(terms: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  let length = 0;
  for (const term of terms) {
    const cleaned = term
      .replace(/,/g, ' ')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || seen.has(cleaned)) continue;
    const cost = cleaned.length + (out.length > 0 ? 1 : 0);
    if (length + cost > MAX_KEYTERMS_HEADER_CHARS) break;
    seen.add(cleaned);
    out.push(cleaned);
    length += cost;
  }
  return out.join(',');
}

/** Normalize a language hint to what the endpoint expects, defaulting to English. */
export function normalizeVoiceLanguage(language: string | undefined): string {
  const trimmed = (language ?? '').trim();
  if (!trimmed || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$|^multi$/.test(trimmed)) return 'en';
  return trimmed;
}

/** Full upstream URL with the audio format pinned. */
export function buildVoiceStreamUrl(params: VoiceStreamParams = {}, env: NodeJS.ProcessEnv = process.env): string {
  const query = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: String(AUDIO_SAMPLE_RATE),
    channels: String(AUDIO_CHANNELS),
    endpointing_ms: '300',
    utterance_end_ms: '1000',
    language: normalizeVoiceLanguage(params.language),
    use_conversation_engine: 'true',
    stt_provider: 'deepgram-nova3',
  });
  return `${voiceStreamBase(env)}${VOICE_STREAM_PATH}?${query.toString()}`;
}

/**
 * Upstream headers. Codeman identifies itself honestly (it is not the CLI), which
 * the endpoint accepts; the bearer token is the only thing that authenticates.
 */
export function buildVoiceStreamHeaders(
  accessToken: string,
  appVersion: string,
  keyterms: string[] = []
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `codeman/${appVersion} (voice-bridge)`,
    'x-app': 'codeman',
    'anthropic-client-platform': 'codeman_web',
  };
  const sanitized = sanitizeKeyterms(keyterms);
  if (sanitized) headers['x-config-keyterms'] = sanitized;
  return headers;
}

export interface VoiceStreamRelayOptions extends VoiceStreamParams {
  accessToken: string;
  appVersion: string;
  /** Called once the upstream socket is open and audio may flow. */
  onReady: () => void;
  /** Running transcript. `final` marks the utterance as complete. */
  onTranscript: (text: string, final: boolean) => void;
  /** Human-readable failure. The relay is dead (or dying) by the time this fires. */
  onError: (message: string) => void;
  /** Terminal: the relay released its socket and timers. Fires exactly once. */
  onClose: () => void;
}

/**
 * One dictation, upstream. Owns exactly one WebSocket and dies with it: every
 * exit path (error, upstream close, lifetime cap, caller close) funnels through
 * `_teardown()`, which fires `onClose` once and clears both timers.
 */
export class VoiceStreamRelay {
  private ws: WebSocket | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private finalizing = false;
  /** Latest interim, held so a close/finalize can promote it to final. */
  private pendingTranscript = '';

  constructor(private readonly opts: VoiceStreamRelayOptions) {}

  /** Open the upstream socket. Safe to call once; a second call is a no-op. */
  connect(): void {
    if (this.ws || this.closed) return;
    const url = buildVoiceStreamUrl({ language: this.opts.language, keyterms: this.opts.keyterms });
    const ws = new WebSocket(url, {
      headers: buildVoiceStreamHeaders(this.opts.accessToken, this.opts.appVersion, this.opts.keyterms ?? []),
    });
    this.ws = ws;

    ws.on('open', () => {
      // Ping immediately: the gap between upgrade and the browser's first audio
      // frame is long enough (mic permission, worklet boot) for upstream to drop us.
      this.safeSend(KEEPALIVE_FRAME);
      this.keepAlive = setInterval(() => this.safeSend(KEEPALIVE_FRAME), KEEPALIVE_INTERVAL_MS);
      this.lifetimeTimer = setTimeout(() => {
        this.opts.onError('Voice stream reached its maximum length');
        this.close();
      }, MAX_STREAM_MS);
      this.opts.onReady();
    });

    ws.on('message', (raw) => this.handleMessage(String(raw)));

    // An upgrade rejection never reaches 'open', so its status is the only signal
    // that the token was refused rather than the network being down.
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      this.opts.onError(
        status === 401 || status === 403
          ? 'Claude rejected the voice credentials. Run a Claude session to refresh your login.'
          : `Voice service refused the connection (HTTP ${status})`
      );
      this.teardown();
    });

    ws.on('error', (err: Error) => {
      if (this.closed) return;
      this.opts.onError(`Voice stream error: ${err.message}`);
    });

    ws.on('close', () => {
      this.promotePending();
      this.teardown();
    });
  }

  /** Relay one raw PCM16 frame upstream. Dropped after finalize, as upstream ignores it. */
  sendAudio(chunk: Buffer): void {
    if (this.finalizing || this.closed) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(chunk);
  }

  /**
   * Ask upstream for the final transcript. The endpoint frame usually follows
   * within a few hundred ms; the timer is the backstop so a silent upstream still
   * yields whatever interim we already have instead of hanging the caller.
   */
  finalize(): void {
    if (this.finalizing || this.closed) return;
    this.finalizing = true;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.promotePending();
      this.close();
      return;
    }
    this.safeSend(CLOSE_STREAM_FRAME);
    this.finalizeTimer = setTimeout(() => {
      this.promotePending();
      this.close();
    }, FINALIZE_TIMEOUT_MS);
  }

  /** Terminal shutdown. Idempotent. */
  close(): void {
    if (this.closed) return;
    const ws = this.ws;
    this.teardown();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  private handleMessage(raw: string): void {
    let msg: { type?: string; data?: string; description?: string; error_code?: string; message?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'TranscriptText':
      case 'TranscriptInterim': {
        // Each frame is the current utterance so far, not a delta; endpoints commit it.
        if (typeof msg.data === 'string' && msg.data) {
          this.pendingTranscript = msg.data;
          this.opts.onTranscript(msg.data, false);
        }
        break;
      }
      case 'TranscriptEndpoint': {
        this.promotePending();
        if (this.finalizing) this.close();
        break;
      }
      case 'TranscriptError': {
        this.opts.onError(msg.description || msg.error_code || 'Transcription failed');
        break;
      }
      case 'error': {
        this.opts.onError(msg.message || 'Voice service error');
        break;
      }
      default:
        break;
    }
  }

  /** Emit the held interim as final, exactly once per utterance. */
  private promotePending(): void {
    if (!this.pendingTranscript) return;
    const text = this.pendingTranscript;
    this.pendingTranscript = '';
    this.opts.onTranscript(text, true);
  }

  private safeSend(frame: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(frame);
    } catch {
      /* socket died between the check and the send */
    }
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.keepAlive = null;
    this.lifetimeTimer = null;
    this.finalizeTimer = null;
    this.opts.onClose();
  }
}
