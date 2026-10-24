/**
 * @fileoverview Voice input with three providers: Claude (this server's Claude Code
 * login), Deepgram Nova-3, and the Web Speech API.
 *
 * Defines three singleton objects:
 *
 * - ClaudeVoiceProvider — Dictation through Codeman's own `/ws/voice/stream`, which
 *   relays to the speech-to-text service Claude Code's `/voice` mode uses. No API key:
 *   the server holds the OAuth token, the browser only sends PCM16 @16 kHz (AudioWorklet,
 *   since MediaRecorder cannot emit raw PCM) and receives text. See docs/claude-voice-plan.md.
 *
 * - DeepgramProvider — Direct browser-to-Deepgram WebSocket connection for speech-to-text.
 *   Captures audio via MediaRecorder, streams chunks every 250ms, handles KeepAlive pings,
 *   auto-detects MIME type (opus/webm/mp4), and supports custom key terms for dev vocabulary.
 *
 * - VoiceInput — High-level voice input controller. Toggle mode: tap mic to start, tap
 *   again to stop. Auto-stops after configurable silence. Shows floating preview overlay with recording
 *   indicator, level meter (AnalyserNode), and elapsed timer. Two insert modes: "direct"
 *   (inject into local echo overlay or PTY) and "compose" (editable textarea overlay).
 *   Includes a temporary green Send button that replaces the settings gear icon after voice input.
 *   Web Speech API retries empty runs twice with backoff and preserves late results after Stop.
 *
 * @globals {object} ClaudeVoiceProvider
 * @globals {object} DeepgramProvider
 * @globals {object} VoiceInput
 *
 * @dependency mobile-handlers.js (MobileDetection for device checks)
 * @dependency app.js (uses global `app` for sendInput, showToast, terminal focus)
 * @loadorder 3 of 15 — loaded after mobile-handlers.js, before notification-manager.js
 */

// Codeman — Voice input with Claude, Deepgram Nova-3 and Web Speech API
// Loaded after mobile-handlers.js, before app.js

/** Dev vocabulary sent to the recognizer as a hint. Shared by every provider and the settings form. */
const DEFAULT_VOICE_KEYTERMS =
  'refactor, endpoint, middleware, callback, async, regex, TypeScript, npm, API, deploy, config, linter, env, webhook, schema, CLI, JSON, CSS, DOM, SSE, backend, frontend, localhost, dependencies, repository, merge, rebase, diff, commit, com';

// ═══════════════════════════════════════════════════════════════
// Voice Input (Deepgram Nova-3 + Web Speech API fallback)
// ═══════════════════════════════════════════════════════════════

/**
 * DeepgramProvider - Speech-to-text via Deepgram Nova-3 WebSocket API.
 * Direct browser-to-Deepgram connection (no server proxy).
 * Uses MediaRecorder to capture audio and streams via WebSocket.
 */
const DeepgramProvider = {
  _ws: null,
  _mediaRecorder: null,
  _stream: null,
  _silenceTimeout: null,
  _keepAliveInterval: null,
  _onResult: null,
  _onError: null,
  _onEnd: null,

  /**
   * Start streaming audio to Deepgram.
   * @param {object} opts - { apiKey, language, keyterms[], onResult(text, isFinal), onError(msg), onEnd(), onStream(stream) }
   */
  async start(opts) {
    this._onResult = opts.onResult;
    this._onError = opts.onError;
    this._onEnd = opts.onEnd;

    // 1. Get microphone access
    if (!navigator.mediaDevices?.getUserMedia) {
      this._onError?.('Microphone requires a secure context (HTTPS). Use --https flag or access via localhost.');
      this._cleanup();
      return;
    }
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
      });
    } catch (err) {
      const msg = err.name === 'NotAllowedError'
        ? 'Microphone access denied. Check browser settings.'
        : 'Microphone error: ' + err.message;
      this._onError?.(msg);
      this._cleanup();
      return;
    }
    // Notify caller so it can set up audio level meter
    opts.onStream?.(this._stream);

    // 2. Detect best supported MIME type for MediaRecorder
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    this._selectedMime = null;
    for (const mt of mimeTypes) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mt)) {
        this._selectedMime = mt;
        break;
      }
    }

    // 3. Build WebSocket URL (no encoding param — Deepgram auto-detects from container format)

    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'false',
      punctuate: 'false',
      interim_results: 'true',
      utterance_end_ms: '1500',
      vad_events: 'true',
    });
    if (opts.language && opts.language !== 'multi') {
      params.set('language', opts.language);
    } else if (opts.language === 'multi') {
      params.set('detect_language', 'true');
    }
    if (opts.keyterms?.length) {
      for (const term of opts.keyterms) {
        const trimmed = term.trim();
        if (trimmed) params.append('keyterm', trimmed + ':2');
      }
    }

    // 4. Connect WebSocket (trim API key to avoid whitespace auth failures)
    const apiKey = (opts.apiKey || '').trim();
    if (!apiKey) {
      this._onError?.('No Deepgram API key configured. Add one in Settings > Voice.');
      this._cleanup();
      return;
    }
    const wsUrl = `wss://api.deepgram.com/v1/listen?${params}`;
    try {
      this._ws = new WebSocket(wsUrl, ['token', apiKey]);
    } catch (err) {
      this._onError?.('Failed to connect to Deepgram: ' + err.message);
      this._cleanup();
      return;
    }

    this._ws.onopen = () => {
      // 5. Send KeepAlive every 8s to prevent Deepgram from closing idle connections
      // (covers the gap before MediaRecorder produces its first chunk)
      this._keepAliveInterval = setInterval(() => {
        if (this._ws?.readyState === WebSocket.OPEN) {
          try { this._ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch (_e) { /* ignore */ }
        }
      }, 8000);
      // 6. Start MediaRecorder once connected
      this._startRecording();
    };

    this._ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'Results' && data.channel?.alternatives?.[0]) {
          const alt = data.channel.alternatives[0];
          const transcript = alt.transcript || '';
          if (transcript) {
            const isFinal = data.is_final === true;
            this._onResult?.(transcript, isFinal);
            this._resetSilenceTimeout();
          }
        }
      } catch (_e) {
        // Ignore parse errors for non-JSON messages
      }
    };

    this._ws.onerror = () => {
      // WebSocket onerror doesn't carry useful info — onclose handles it
    };

    this._ws.onclose = (event) => {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
      if (event.code === 1008) {
        this._onError?.('Authentication failed. Check your Deepgram API key in Settings > Voice.');
      } else if (event.code === 1006) {
        // 1006 = abnormal closure (no close frame). Usually auth failure, expired key, or no credits.
        this._onError?.('Deepgram connection failed (1006). Check your API key is valid and has credits in Settings > Voice.');
      } else if (event.code !== 1000) {
        this._onError?.('Deepgram connection closed: ' + (event.reason || `code ${event.code}`));
      }
      this._stopRecording();
      this._onEnd?.();
    };
  },

  _startRecording() {
    if (!this._stream || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    const recorderOpts = this._selectedMime ? { mimeType: this._selectedMime } : {};
    try {
      this._mediaRecorder = new MediaRecorder(this._stream, recorderOpts);
    } catch (err) {
      this._onError?.('MediaRecorder failed: ' + err.message);
      this._cleanup();
      return;
    }

    this._mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(event.data);
      }
    };

    this._mediaRecorder.start(250); // Send chunks every 250ms
    this._resetSilenceTimeout();
  },

  _stopRecording() {
    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
      try { this._mediaRecorder.stop(); } catch (_e) { /* already stopped */ }
    }
    // Stop all mic tracks
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
    }
  },

  _resetSilenceTimeout() {
    clearTimeout(this._silenceTimeout);
    this._silenceTimeout = null;
    const delay = VoiceInput.getSilenceTimeoutMs(3000);
    if (delay === 0) return;
    this._silenceTimeout = setTimeout(() => {
      this.stop();
    }, delay);
  },

  stop() {
    clearTimeout(this._silenceTimeout);
    this._silenceTimeout = null;
    clearInterval(this._keepAliveInterval);
    this._keepAliveInterval = null;
    this._stopRecording();
    // Detach WS handlers before closing to prevent stale onclose from
    // killing a subsequent recording that starts before the close completes
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.onmessage = null;
      this._ws.onerror = null;
      if (this._ws.readyState === WebSocket.OPEN) {
        try { this._ws.close(1000); } catch (_e) { /* ignore */ }
      }
      this._ws = null;
    }
    // Save onEnd before nulling — must notify VoiceInput when silence timeout
    // triggers stop internally (VoiceInput.onEnd guards with isRecording check)
    const onEnd = this._onEnd;
    this._onResult = null;
    this._onError = null;
    this._onEnd = null;
    onEnd?.();
  },

  _cleanup() {
    this.stop();
    this._mediaRecorder = null;
    this._stream = null;
    this._selectedMime = null;
  }
};

/**
 * ClaudeVoiceProvider - Speech-to-text through this Codeman server's Claude Code
 * login, i.e. the same service the CLI's own `/voice` mode uses. No API key.
 *
 * Audio goes browser -> Codeman -> Anthropic: the OAuth token never leaves the
 * server, so the browser only ever sends PCM and receives text
 * (docs/claude-voice-plan.md).
 *
 * ⚠️ The upstream endpoint is opened as linear16 / 16 kHz / mono, so capture MUST
 * be raw PCM at that rate. MediaRecorder cannot emit raw PCM (container formats
 * only), which is why this path uses an AudioWorklet rather than reusing
 * DeepgramProvider's recorder. The AudioContext is constructed at 16000 Hz so the
 * browser does the resampling.
 *
 * Transcript frames cover the current utterance. Replace interims and append
 * each endpoint final once; an endpoint alone does not end the recording.
 */
const ClaudeVoiceProvider = {
  _ws: null,
  _stream: null,
  _audioContext: null,
  _workletNode: null,
  _sourceNode: null,
  _scriptNode: null,
  _silenceTimeout: null,
  _onResult: null,
  _onError: null,
  _onEnd: null,
  _finalized: false,
  _finalizeTimeout: null,
  _generation: 0,

  /** How long without any transcript before the recording gives up on its own. */
  SILENCE_MS: 6000,

  /**
   * Start streaming.
   * @param {object} opts - { language, keyterms[], onResult(text, isFinal), onError(msg), onEnd(), onStream(stream) }
   */
  async start(opts) {
    this._cleanup();
    const generation = this._generation;
    this._onResult = opts.onResult;
    this._onError = opts.onError;
    this._onEnd = opts.onEnd;
    this._finalized = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      this._onError?.('Microphone requires a secure context (HTTPS). Use --https flag or access via localhost.');
      this._cleanup();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
      });
      // Permission prompts can resolve after Stop/reconnect or a newer recording.
      if (generation !== this._generation || this._finalized) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      this._stream = stream;
    } catch (err) {
      if (generation !== this._generation || this._finalized) return;
      const msg = err.name === 'NotAllowedError'
        ? 'Microphone access denied. Check browser settings.'
        : 'Microphone error: ' + err.message;
      this._onError?.(msg);
      this._cleanup();
      return;
    }
    opts.onStream?.(this._stream);

    const params = new URLSearchParams();
    if (opts.language) params.set('language', opts.language);
    if (opts.keyterms?.length) params.set('keyterms', opts.keyterms.join(','));
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      this._ws = new WebSocket(`${proto}//${location.host}${window.CodemanBase?.base || ''}/ws/voice/stream?${params}`);
    } catch (err) {
      this._onError?.('Failed to open voice stream: ' + err.message);
      this._cleanup();
      return;
    }
    this._ws.binaryType = 'arraybuffer';

    this._ws.onopen = () => {
      if (generation !== this._generation || this._finalized) return;
      // Capture starts only once the socket is up: PCM buffered before that would
      // be the oldest audio, and dropping it keeps the transcript aligned with what
      // the user hears themselves saying.
      this._startCapture(generation).catch((err) => {
        if (generation !== this._generation || this._finalized) return;
        this._onError?.('Microphone capture failed: ' + err.message);
        this.stop();
      });
      this._resetSilenceTimeout();
    };

    this._ws.onmessage = (event) => {
      if (generation !== this._generation) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_e) {
        return;
      }
      if (msg.t === 'transcript' && msg.text) {
        this._resetSilenceTimeout();
        this._onResult?.(msg.text, msg.final === true);
      } else if (msg.t === 'error') {
        this._onError?.(msg.message || 'Voice transcription failed');
      }
    };

    this._ws.onerror = () => {
      // onclose carries the actionable detail (close code); nothing useful here.
    };

    this._ws.onclose = (event) => {
      if (generation !== this._generation) return;
      if (event.code === 4004) {
        this._onError?.(this._unavailableMessage(event.reason));
      } else if (event.code === 4008) {
        this._onError?.('Too many voice streams are already running on this server.');
      } else if (event.code === 4003) {
        this._onError?.('Voice stream refused (origin not allowed).');
      } else if (event.code !== 1000 && !this._finalized) {
        this._onError?.('Voice stream closed: ' + (event.reason || `code ${event.code}`));
      }
      this._stopCapture();
      const onEnd = this._onEnd;
      this._onEnd = null;
      onEnd?.();
    };
  },

  /** Map the server's close reason onto something a user can act on. */
  _unavailableMessage(reason) {
    if (reason === 'expired') return 'Claude login expired. Run a Claude session to refresh it, then try again.';
    if (reason === 'disabled') return 'Claude voice is off. Enable it in Settings > Voice.';
    return 'No Claude Code login found on the server. Sign in with `claude` there, or use Deepgram.';
  },

  /** Wire mic -> 16 kHz PCM16 frames -> WebSocket. */
  async _startCapture(generation = this._generation) {
    if (generation !== this._generation || this._finalized) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // Ask for 16 kHz directly so the browser resamples; Safari may hand back its
    // own rate, which _pcmFromFloat32 then downsamples to match.
    this._audioContext = new Ctx({ sampleRate: 16000 });
    if (this._audioContext.state === 'suspended') await this._audioContext.resume();
    if (generation !== this._generation || this._finalized) return;
    this._sourceNode = this._audioContext.createMediaStreamSource(this._stream);

    if (this._audioContext.audioWorklet) {
      await this._audioContext.audioWorklet.addModule(this._workletUrl());
      if (generation !== this._generation || this._finalized) return;
      this._workletNode = new AudioWorkletNode(this._audioContext, 'pcm-frame-processor');
      this._workletNode.port.onmessage = (event) => this._sendAudio(event.data);
      this._sourceNode.connect(this._workletNode);
      // A worklet with no destination is not pulled in some engines; a zero-gain
      // sink keeps the graph running without echoing the mic to the speakers.
      const sink = this._audioContext.createGain();
      sink.gain.value = 0;
      this._workletNode.connect(sink).connect(this._audioContext.destination);
      return;
    }

    // Fallback for engines without AudioWorklet (older Safari): deprecated, but
    // it is this or no dictation at all there.
    this._scriptNode = this._audioContext.createScriptProcessor(4096, 1, 1);
    this._scriptNode.onaudioprocess = (event) => {
      this._sendAudio(this._pcmFromFloat32(event.inputBuffer.getChannelData(0), this._audioContext.sampleRate));
    };
    this._sourceNode.connect(this._scriptNode);
    this._scriptNode.connect(this._audioContext.destination);
  },

  /**
   * Worklet URL carrying this page's cache-bust token.
   *
   * ⚠️ Static assets are served `immutable` for a year, and `cacheBustAssets`
   * only rewrites `.js` refs in `<script>`/`<link>` tags — a URL built here in JS
   * is invisible to it. So the token is borrowed from voice-input.js's own script
   * tag, which the server DID rewrite. Consequence: **edit the worklet and this
   * file together**, or the browser keeps serving the old worklet.
   */
  _workletUrl() {
    const src = document.querySelector('script[src*="voice-input.js"]')?.getAttribute('src') || '';
    const q = src.indexOf('?');
    return 'voice-pcm-worklet.js' + (q === -1 ? '' : src.slice(q));
  },

  /** Float32 [-1,1] at any rate -> Int16 PCM at 16 kHz (nearest-neighbour decimation). */
  _pcmFromFloat32(input, sampleRate) {
    const ratio = sampleRate / 16000;
    const outLength = Math.floor(input.length / ratio);
    const out = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const sample = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
      out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return out.buffer;
  },

  _sendAudio(arrayBuffer) {
    if (this._finalized) return;
    if (this._ws?.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(arrayBuffer);
    } catch (_e) {
      /* socket died mid-frame */
    }
  },

  _resetSilenceTimeout() {
    clearTimeout(this._silenceTimeout);
    this._silenceTimeout = null;
    const delay = VoiceInput.getSilenceTimeoutMs(this.SILENCE_MS);
    if (delay === 0) return;
    this._silenceTimeout = setTimeout(() => this.stop(), delay);
  },

  /**
   * Ask for the final transcript and let the server close the socket. Capture stops
   * immediately, but the WebSocket stays open: the last (and usually best) transcript
   * arrives AFTER the audio does, so closing here would throw away the utterance.
   */
  stop() {
    clearTimeout(this._silenceTimeout);
    this._silenceTimeout = null;
    if (this._finalized) return;
    this._finalized = true;
    this._stopCapture();
    // Bound both manual and silence-triggered finalization on a dead connection.
    // Repeated stop requests return above, so they cannot extend this deadline.
    this._finalizeTimeout = setTimeout(() => {
      const onEnd = this._onEnd;
      this._cleanup();
      onEnd?.();
    }, 5000);
    if (this._ws?.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify({ t: 'finalize' }));
      } catch (_e) {
        /* ignore */
      }
    } else {
      const onEnd = this._onEnd;
      this._onEnd = null;
      onEnd?.();
    }
  },

  /** Tear down the audio graph and release the mic. Idempotent. */
  _stopCapture() {
    if (this._workletNode) {
      this._workletNode.port.onmessage = null;
      try { this._workletNode.disconnect(); } catch (_e) { /* ignore */ }
      this._workletNode = null;
    }
    if (this._scriptNode) {
      this._scriptNode.onaudioprocess = null;
      try { this._scriptNode.disconnect(); } catch (_e) { /* ignore */ }
      this._scriptNode = null;
    }
    if (this._sourceNode) {
      try { this._sourceNode.disconnect(); } catch (_e) { /* ignore */ }
      this._sourceNode = null;
    }
    if (this._audioContext) {
      try { this._audioContext.close(); } catch (_e) { /* ignore */ }
      this._audioContext = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
  },

  /** Hard stop: drop the socket without waiting for a final transcript. */
  _cleanup() {
    this._generation++;
    this._finalized = true;
    clearTimeout(this._finalizeTimeout);
    this._finalizeTimeout = null;
    clearTimeout(this._silenceTimeout);
    this._silenceTimeout = null;
    this._stopCapture();
    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onclose = null;
      this._ws.onmessage = null;
      this._ws.onerror = null;
      if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
        try { this._ws.close(1000); } catch (_e) { /* ignore */ }
      }
      this._ws = null;
    }
    this._onResult = null;
    this._onError = null;
    this._onEnd = null;
  }
};

/**
 * VoiceInput - Speech-to-text with Claude (this server's Claude Code login),
 * Deepgram Nova-3, or the Web Speech API.
 * Toggle mode: tap mic to start, tap again to stop. Auto-stops after silence.
 * Shows interim transcription in a floating preview overlay.
 * Inserts final text into the active session (user presses Enter to submit).
 */
const VoiceInput = {
  SILENCE_TIMEOUT_SECONDS: Object.freeze([0, 3, 6, 15, 30]),
  recognition: null,
  isRecording: false,
  supported: false,
  silenceTimeout: null,
  previewEl: null,
  _accumulatedFinal: '',
  _pendingInterim: '',
  _webSpeechCommitted: '', // Text from completed native recognition runs.
  _webSpeechSingleUtterance: false,
  _webSpeechSoundActive: false,
  _webSpeechActivityUntil: 0,
  _webSpeechStopping: false,
  _webSpeechStopTimer: null,
  _webSpeechRestartTimer: null,
  _activeProvider: null, // 'claude' | 'deepgram' | 'webspeech' | null
  _recordingStartedAt: 0, // timestamp when recording started
  _retryCount: 0, // consecutive empty Web Speech API runs
  _hasReceivedResult: false, // whether this native recognition run received speech
  _durationInterval: null, // timer for updating elapsed time display
  _analyser: null, // AudioContext analyser for level meter
  _analyserSource: null, // MediaStreamSource for level meter
  _audioContext: null, // AudioContext for level meter
  _levelAnimFrame: null, // rAF handle for level meter
  // The session dictation was started FOR, captured in start(). Transcripts
  // arrive seconds later and the green send button / compose overlay can be
  // used later still; reading app.activeSessionId at that point sent the text
  // to whatever tab the user had switched to in the meantime.
  _targetSessionId: null,

  init() {
    this._initRecognition();
    // Always show buttons — if unsupported, toggle() shows a toast
    this._showButtons();
    // Probe the server's Claude voice availability in the background. `auto`
    // resolution reads the cached answer, so the first mic press does not wait
    // on a round trip; a miss just falls through to the next provider.
    this.refreshClaudeStatus();
  },

  /** Last /api/voice/status answer, or null before the first probe resolves. */
  _claudeStatus: null,

  /**
   * Re-probe whether this server can transcribe with its Claude Code login.
   * Called at init and whenever App Settings opens (the setting is server-side,
   * so another device could have flipped it).
   */
  async refreshClaudeStatus() {
    try {
      const res = await fetch('/api/voice/status');
      const json = await res.json();
      this._claudeStatus = json?.success ? json.data : { available: false, reason: 'disabled' };
    } catch (_e) {
      this._claudeStatus = { available: false, reason: 'disabled' };
    }
    return this._claudeStatus;
  },

  // --- Deepgram config (localStorage only, never sent to server) ---

  _getDeepgramConfig() {
    try {
      return JSON.parse(localStorage.getItem('codeman-voice-settings') || '{}');
    } catch (_e) {
      return {};
    }
  },

  /** Seconds in settings; zero means stop only when the user asks. */
  getSilenceTimeoutMs(fallback) {
    const seconds = this._getDeepgramConfig().silenceTimeout;
    return this.SILENCE_TIMEOUT_SECONDS.includes(seconds) ? seconds * 1000 : fallback;
  },

  _saveDeepgramConfig(config) {
    localStorage.setItem('codeman-voice-settings', JSON.stringify(config));
  },

  _shouldUseDeepgram() {
    const cfg = this._getDeepgramConfig();
    return !!(cfg.apiKey && cfg.apiKey.trim());
  },

  _claudeAvailable() {
    return this._claudeStatus?.available === true;
  },

  /**
   * Which provider a press of the mic would use.
   *
   * An explicit pick always wins, even when it cannot run — the resulting error
   * ("Claude voice is off", "no Deepgram key") is more useful than silently
   * transcribing somewhere the user did not choose. `auto` prefers Claude because
   * it needs no key and no per-word billing, then the configured Deepgram key,
   * then the browser's own engine.
   */
  _resolveProvider() {
    const pinned = this._getDeepgramConfig().provider;
    if (pinned === 'claude' || pinned === 'deepgram' || pinned === 'webspeech') return pinned;
    if (this._claudeAvailable()) return 'claude';
    if (this._shouldUseDeepgram()) return 'deepgram';
    return 'webspeech';
  },

  /** Get the active provider name for display */
  getActiveProviderName() {
    switch (this._resolveProvider()) {
      case 'claude':
        return this._claudeAvailable() ? 'Claude (this server’s login)' : 'Claude (unavailable)';
      case 'deepgram':
        return this._shouldUseDeepgram() ? 'Deepgram Nova-3' : 'Deepgram (no API key)';
      default:
        return this.supported ? 'Web Speech API' : 'None';
    }
  },

  /** Try to create a SpeechRecognition instance */
  _initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    if (!this.supported) return;

    this.recognition = new SR();
    // Android's continuous bridge promotes growing partials to separate finals.
    // Single-utterance mode keeps refinements provisional; onend resumes the mic
    // while our own silence deadline controls the overall dictation session.
    // Android tablets in desktop-site mode may identify as touch-capable Linux.
    this._webSpeechSingleUtterance = navigator.userAgentData?.platform === 'Android'
      || /Android/i.test(navigator.userAgent || '')
      || (navigator.maxTouchPoints > 0 && /Linux/i.test(navigator.platform || ''));
    this.recognition.continuous = !this._webSpeechSingleUtterance;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = (e) => this._onWebSpeechResult(e);
    this.recognition.onerror = (e) => this._onWebSpeechError(e);
    this.recognition.onend = () => this._onWebSpeechEnd();
    this.recognition.onsoundstart = this.recognition.onspeechstart = () => this._onWebSpeechSound(true);
    this.recognition.onsoundend = this.recognition.onspeechend = this.recognition.onaudioend = () => this._onWebSpeechSound(false);
  },

  toggle() {
    if (this.isRecording) {
      this.stop();
    } else {
      this.start();
    }
  },

  start() {
    if (this.isRecording) return;
    const target = app._focusedPane?.()?.sessionId || app.activeSessionId;
    if (!target) {
      app.showToast('No active session', 'warning');
      return;
    }
    this._targetSessionId = target;
    this._retryCount = 0;

    const provider = this._resolveProvider();
    if (provider === 'claude') {
      this._startClaude();
    } else if (provider === 'deepgram') {
      this._startDeepgram();
    } else {
      this._startWebSpeech();
    }
  },

  _startClaude() {
    if (!this._claudeAvailable()) {
      const reason = this._claudeStatus?.reason;
      app.showToast(
        reason === 'expired'
          ? 'Claude login expired on the server. Run a Claude session to refresh it.'
          : reason === 'no-credentials'
            ? 'No Claude Code login found on the server. Sign in there with `claude`.'
            : 'Claude voice is off. Enable it in Settings > Voice.',
        'warning'
      );
      // Re-probe so a setting flipped on another device is picked up by the next press.
      this.refreshClaudeStatus();
      return;
    }

    const cfg = this._getDeepgramConfig();
    this.isRecording = true;
    this._activeProvider = 'claude';
    this._accumulatedFinal = '';
    this._pendingInterim = '';
    this._hasReceivedResult = false;
    this._recordingStartedAt = Date.now();
    this._updateButtons('recording');
    this._showPreview('Listening...', 'claude');
    this._startDurationTimer();

    const keyterms = (cfg.keyterms || DEFAULT_VOICE_KEYTERMS)
      .split(',').map(t => t.trim()).filter(Boolean);

    ClaudeVoiceProvider.start({
      // The upstream endpoint wants a bare language tag; the Deepgram picker's
      // 'en-US' style narrows to its base, and 'multi' means auto-detect.
      language: (cfg.language || 'en-US').split('-')[0],
      keyterms,
      onStream: (stream) => this._startLevelMeter(stream),
      onResult: (text, isFinal) => {
        if (!this.isRecording) return;
        this._hasReceivedResult = true;
        // Interims replace the current utterance; each endpoint commits it once.
        if (isFinal) {
          this._accumulatedFinal = [this._accumulatedFinal, text].filter(Boolean).join(' ');
          this._pendingInterim = '';
          if (ClaudeVoiceProvider._finalized) this.stop(true);
          else this._showPreview(this._accumulatedFinal, 'claude');
        } else {
          this._pendingInterim = (this._accumulatedFinal ? ' ' : '') + text;
          this._showPreview(this._accumulatedFinal + this._pendingInterim, 'claude');
        }
      },
      onError: (msg) => {
        const wasRecording = this.isRecording;
        this.stop(true);
        if (wasRecording) app.showToast(msg, 'error');
      },
      onEnd: () => {
        if (this.isRecording) {
          this.stop(true);
        }
      }
    });

    if (navigator.vibrate) navigator.vibrate(50);
  },

  _startDeepgram() {
    const cfg = this._getDeepgramConfig();
    this.isRecording = true;
    this._activeProvider = 'deepgram';
    this._accumulatedFinal = '';
    this._pendingInterim = '';
    this._hasReceivedResult = false;
    this._recordingStartedAt = Date.now();
    this._updateButtons('recording');
    this._showPreview('Listening...', 'deepgram');
    this._startDurationTimer();

    const keyterms = (cfg.keyterms || DEFAULT_VOICE_KEYTERMS)
      .split(',').map(t => t.trim()).filter(Boolean);

    DeepgramProvider.start({
      apiKey: cfg.apiKey,
      language: cfg.language || 'en-US',
      keyterms,
      onStream: (stream) => {
        this._startLevelMeter(stream);
      },
      onResult: (text, isFinal) => {
        if (!this.isRecording) return;
        this._hasReceivedResult = true;
        if (isFinal) {
          this._accumulatedFinal += (this._accumulatedFinal ? ' ' : '') + text;
          this._pendingInterim = '';
          this._showPreview(this._accumulatedFinal, 'deepgram');
        } else {
          this._pendingInterim = (this._accumulatedFinal ? ' ' : '') + text;
          const display = this._accumulatedFinal + this._pendingInterim;
          this._showPreview(display, 'deepgram');
        }
      },
      onError: (msg) => {
        const wasRecording = this.isRecording;
        this.stop();
        if (wasRecording) app.showToast(msg, 'error');
      },
      onEnd: () => {
        if (this.isRecording) {
          this.stop();
        }
      }
    });

    // Haptic feedback on mobile
    if (navigator.vibrate) navigator.vibrate(50);
  },

  _startWebSpeech() {
    // Lazy-init: retry if recognition was cleaned up or not available at page load
    if (!this.recognition) this._initRecognition();
    if (!this.supported) {
      if (!this._shouldUseDeepgram()) {
        app.showToast('Voice input not available. Configure Deepgram in Settings > Voice.', 'warning');
      } else {
        app.showToast('Voice input not supported in this browser', 'warning');
      }
      return;
    }
    this.isRecording = true;
    this._activeProvider = 'webspeech';
    this._retryCount = 0;
    this._webSpeechCommitted = '';
    this._webSpeechSoundActive = false;
    this._webSpeechActivityUntil = 0;
    this._accumulatedFinal = '';
    this._pendingInterim = '';
    this._hasReceivedResult = false;
    this._recordingStartedAt = Date.now();
    this._updateButtons('recording');
    this._showPreview('Listening...');
    this._startDurationTimer();
    try {
      this.recognition.start();
    } catch (e) {
      // InvalidStateError = already started — ignore. Other errors = genuine failure.
      if (e.name !== 'InvalidStateError') {
        this.stop(true);
        app.showToast('Voice input failed to start: ' + e.message, 'error');
        return;
      }
    }
    this._resetSilenceTimeout();
    // SpeechRecognition owns its microphone. A second getUserMedia capture for
    // a cosmetic meter can take audio away from Android's recognition service.
    // Streaming providers still meter the same stream they transcribe.
    this._drawLevelMeter();
    // Haptic feedback on mobile
    if (navigator.vibrate) navigator.vibrate(50);
  },

  stop(providerFinished = false) {
    if (!this.isRecording) return;
    if (this._webSpeechRestartTimer !== null) {
      clearTimeout(this._webSpeechRestartTimer);
      this._webSpeechRestartTimer = null;
      // The recognizer already ended; no onend remains to wait for.
      providerFinished = true;
    }
    // Claude delivers its final transcript after finalize. Keep accepting it
    // until that frame (or onEnd) completes this recording.
    if (this._activeProvider === 'claude' && !providerFinished && ClaudeVoiceProvider._ws?.readyState === WebSocket.OPEN) {
      ClaudeVoiceProvider.stop();
      return;
    }
    if (this._activeProvider === 'webspeech' && !providerFinished) {
      if (this._webSpeechStopping) return;
      this._webSpeechStopping = true;
      clearTimeout(this.silenceTimeout);
      // stop() requests a result; Android may deliver it only before onend.
      // Keep accepting results, with a backstop for engines that never end.
      this._webSpeechStopTimer = setTimeout(() => {
        try { this.recognition?.abort(); } catch (_e) { /* already ended */ }
        this.stop(true);
      }, 3000);
      try { this.recognition?.stop(); } catch (_e) { this.stop(true); }
      return;
    }
    clearTimeout(this._webSpeechStopTimer);
    this._webSpeechStopTimer = null;
    this._webSpeechStopping = false;
    this.isRecording = false;
    const text = this._accumulatedFinal + this._pendingInterim;
    this._accumulatedFinal = '';
    this._pendingInterim = '';
    if (text) this._insertText(text);
    clearTimeout(this.silenceTimeout);
    this.silenceTimeout = null;
    this._retryCount = 0;
    this._stopDurationTimer();
    this._stopLevelMeter();
    this._updateButtons('idle');
    this._hidePreview();

    if (this._activeProvider === 'claude') {
      // Completion received, or forced teardown: callbacks must not outlive it.
      ClaudeVoiceProvider._cleanup();
    } else if (this._activeProvider === 'deepgram') {
      DeepgramProvider.stop();
    } else if (this._activeProvider === 'webspeech') {
      // Stop the mic stream we opened for the level meter
      if (this._webSpeechStream) {
        this._webSpeechStream.getTracks().forEach(t => t.stop());
        this._webSpeechStream = null;
      }
    }
    this._activeProvider = null;

    // Haptic feedback on mobile
    if (navigator.vibrate) navigator.vibrate([30, 50, 30]);
  },

  _onWebSpeechSound(active) {
    if (!this.isRecording || this._activeProvider !== 'webspeech' || this._webSpeechStopping) return;
    this._webSpeechSoundActive = active;
    if (!active) this._webSpeechActivityUntil = 0;
  },

  _onWebSpeechResult(event) {
    if (!this.isRecording) return;
    this._resetSilenceTimeout();
    // results is the current run's complete snapshot, not a list of new words.
    // Rebuild by result position so repeats/corrections replace the same text.
    // Never deduplicate by text: "go go" and repeated phrases can be intentional.
    const finals = [];
    const interims = [];
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript?.trim();
      if (text) (result.isFinal ? finals : interims).push(text);
    }
    this._accumulatedFinal = [this._webSpeechCommitted, ...finals].filter(Boolean).join(' ');
    const interim = interims.join(' ');
    this._hasReceivedResult ||= finals.length > 0 || !!interim;
    this._pendingInterim = interim ? (this._accumulatedFinal ? ' ' : '') + interim : '';
    this._showPreview(this._accumulatedFinal + this._pendingInterim);
    // Some engines omit sound events; transcript updates are also real evidence
    // of speech activity. This is an activity animation, not an amplitude meter.
    if (finals.length || interim) this._webSpeechActivityUntil = Date.now() + 600;
  },

  _onWebSpeechError(event) {
    // During auto-retry, 'aborted' and 'no-speech' errors are expected — ignore them
    if (this._retryCount > 0 && (event.error === 'aborted' || event.error === 'no-speech')) return;

    // Browser silence events must not override an extended/manual deadline.
    if (event.error === 'no-speech' && this.getSilenceTimeoutMs(3000) !== 3000) return;

    const wasRecording = this.isRecording;
    this.stop(true);
    if (!wasRecording) return;

    switch (event.error) {
      case 'not-allowed':
        app.showToast('Microphone access denied. Check browser settings.', 'error');
        break;
      case 'no-speech':
        // Silent — auto-stop is enough feedback
        break;
      case 'network':
        app.showToast('Voice input requires internet connection.', 'error');
        break;
      case 'aborted':
        // User cancelled — no message needed
        break;
      default:
        app.showToast('Voice input error: ' + event.error, 'error');
    }
  },

  _onWebSpeechEnd() {
    // Recognition ended (browser auto-stopped or we called stop())
    if (!this.isRecording) return;
    this._onWebSpeechSound(false);
    if (this._webSpeechStopping) {
      this.stop(true);
      return;
    }

    const empty = !this._hasReceivedResult;
    this._retryCount = empty ? this._retryCount + 1 : 0;
    if (this._retryCount > 2) {
      this.stop(true);
      return;
    }

    // Native endpoints must not extend the configured silence deadline.
    const delay = this.getSilenceTimeoutMs(3000);
    if (empty || this._webSpeechSingleUtterance || delay === 0 || delay > 3000) {
      // Commit this run once before the next run resets its result indexes.
      this._webSpeechCommitted = (this._accumulatedFinal + this._pendingInterim).trim();
      this._accumulatedFinal = this._webSpeechCommitted;
      this._pendingInterim = '';
      const restart = () => {
        this._webSpeechRestartTimer = null;
        if (!this.isRecording || this._webSpeechStopping) return;
        this._hasReceivedResult = false;
        try { this.recognition.start(); } catch (_e) { this.stop(true); }
      };
      // A broken or unavailable recognizer must not spin forever in Manual mode.
      if (empty) this._webSpeechRestartTimer = setTimeout(restart, 250);
      else restart();
      return;
    }

    // Genuine end — finalize any accumulated text
    this.stop(true);
  },

  /** The session this dictation belongs to (see _targetSessionId). */
  _targetSession() {
    return this._targetSessionId || app.activeSessionId;
  },

  /**
   * Send text to the dictation's own session. The active session keeps going
   * through app.sendInput() exactly as before; any other session goes straight
   * to the durable queue with the same useMux flag sendInput() passes.
   */
  _sendToTarget(target, text) {
    if (target === app.activeSessionId) return app.sendInput(text);
    // Closed while dictating: say so instead of queueing text for a session
    // that will only answer 404 (and never typing it into some other tab).
    if (app.sessions && !app.sessions.has(target)) {
      app.showToast?.('That session has closed; dictation not sent', 'warning');
      return Promise.resolve();
    }
    app._sendInputAsync(target, text, { useMux: true });
    return Promise.resolve();
  },

  _insertText(text) {
    const target = this._targetSession();
    if (!target || !text.trim()) return;
    const trimmed = text.trim();
    const mode = this._getDeepgramConfig().insertMode || 'direct';

    if (mode === 'compose') {
      // If a compose overlay is already open, populate its textarea instead of recreating
      const existingTextarea = document.querySelector('.voice-compose-overlay .paste-textarea');
      if (existingTextarea) {
        existingTextarea.value = trimmed;
        existingTextarea.focus();
        existingTextarea.selectionStart = existingTextarea.selectionEnd = trimmed.length;
      } else {
        this._showComposeOverlay(trimmed);
      }
    } else {
      // Direct mode: inject into local echo overlay if available, else send to PTY.
      // The overlay belongs to the ACTIVE session's terminal, so text dictated
      // for any other session must not be typed into it. It also belongs to the
      // MAIN terminal, which the tile grid parks (display: none): with tiles
      // open the text would sit in an invisible overlay the focused tile never
      // sees, so it goes straight to the session instead.
      const isActive = target === app.activeSessionId;
      const tilesOpen = !!app._tilesOwnTerminal?.();
      if (isActive && !tilesOpen && app._localEchoEnabled && app._localEchoOverlay) {
        app._localEchoOverlay.appendText(trimmed);
      } else {
        this._sendToTarget(target, trimmed).catch(() => {});
      }
      this._showVoiceSendBtn();
      setTimeout(() => {
        if (!isActive) return;
        // With the grid open the keyboard belongs to the focused tile; the
        // parked main terminal cannot take focus. Split view keeps the main
        // terminal, even if Pane B took focus meanwhile (it is not the target).
        if (app._tilesOwnTerminal?.()) {
          const pane = app._focusedPane?.();
          if (pane?.sessionId === target) pane.terminal?.focus();
        } else if (app.terminal) {
          app.terminal.focus();
        }
      }, 150);
    }
  },

  /** Show a green Enter button by transforming the gear icon in-place */
  _showVoiceSendBtn() {
    // Find the gear button (mobile or desktop header)
    const gear = document.querySelector('.btn-settings-mobile') || document.querySelector('.btn-settings');
    if (!gear || gear.classList.contains('voice-send-active')) return;

    // Remove existing if any
    this._hideVoiceSendBtn();

    // Save original state
    this._voiceSendGear = gear;
    this._voiceSendOriginalHTML = gear.innerHTML;
    this._voiceSendOriginalOnclick = gear.getAttribute('onclick');

    // Transform into green send button
    gear.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    gear.classList.add('voice-send-active');
    gear.removeAttribute('onclick');
    gear.title = 'Send (Enter)';

    // Click handler
    this._voiceSendHandler = () => {
      const target = this._targetSession();
      if (!target) return;
      // Simulate Enter key: if local echo is active, flush its buffer + send \r;
      // otherwise just send \r directly to the PTY. Both the overlay and the
      // predictions belong to the ACTIVE session's MAIN terminal, so a
      // dictation for another session, or for a tile while the grid has the
      // main terminal parked, just sends its Enter there.
      if (target !== app.activeSessionId || app._tilesOwnTerminal?.()) {
        this._sendToTarget(target, '\r').catch(() => {});
      } else if (app._localEchoEnabled && app._localEchoOverlay) {
        const text = app._localEchoOverlay.pendingText || '';
        app._localEchoOverlay.clear();
        app._localEchoOverlay.suppressBufferDetection();
        if (text) app.sendInput(text).catch(() => {});
        setTimeout(() => app.sendInput('\r').catch(() => {}), 80);
      } else {
        // Predict-mode sessions (codex) take this branch: the send bypasses
        // onData, so clear outstanding predictions here (composer will reset)
        app._predictiveEcho?.clearPredictions();
        app.sendInput('\r').catch(() => {});
      }
      // Blink then restore
      gear.classList.add('voice-send-blink');
      setTimeout(() => this._hideVoiceSendBtn(), 400);
    };
    gear.addEventListener('click', this._voiceSendHandler);
  },

  _hideVoiceSendBtn() {
    const gear = this._voiceSendGear;
    if (!gear) return;
    gear.removeEventListener('click', this._voiceSendHandler);
    gear.classList.remove('voice-send-active', 'voice-send-blink');
    gear.innerHTML = this._voiceSendOriginalHTML || '';
    if (this._voiceSendOriginalOnclick) {
      gear.setAttribute('onclick', this._voiceSendOriginalOnclick);
    }
    gear.title = 'App Settings';
    this._voiceSendGear = null;
    this._voiceSendHandler = null;
    this._voiceSendOriginalHTML = null;
    this._voiceSendOriginalOnclick = null;
  },

  /** Show an editable compose overlay so the user can review/edit before sending */
  _showComposeOverlay(text) {
    document.querySelector('.voice-compose-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'voice-compose-overlay paste-overlay';
    overlay.innerHTML = `
      <div class="paste-dialog">
        <textarea class="paste-textarea">${text.replace(/</g, '&lt;')}</textarea>
        <div class="paste-actions">
          <button class="paste-cancel">Cancel</button>
          <button class="paste-new"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> New</button>
          <button class="paste-send">Send</button>
        </div>
      </div>
    `;
    const textarea = overlay.querySelector('textarea');
    const send = () => {
      const val = textarea.value.trim();
      overlay.remove();
      if (val) this._sendToTarget(this._targetSession(), val + '\r').catch(() => {});
    };
    const cancel = () => overlay.remove();
    const newInput = () => {
      textarea.value = '';
      textarea.blur();
      this.start();
    };
    overlay.querySelector('.paste-cancel').addEventListener('click', cancel);
    overlay.querySelector('.paste-new').addEventListener('click', newInput);
    overlay.querySelector('.paste-send').addEventListener('click', send);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
    document.body.appendChild(overlay);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  },

  _resetSilenceTimeout() {
    clearTimeout(this.silenceTimeout);
    this.silenceTimeout = null;
    const delay = this.getSilenceTimeoutMs(3000);
    if (delay === 0) return;
    this.silenceTimeout = setTimeout(() => {
      if (this.isRecording) {
        this.stop();
      }
    }, delay);
  },

  _startDurationTimer() {
    this._stopDurationTimer();
    this._durationInterval = setInterval(() => {
      if (!this.isRecording || !this.previewEl) return;
      const elapsed = Math.floor((Date.now() - this._recordingStartedAt) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `0:${String(secs).padStart(2, '0')}`;
      const timerEl = this.previewEl.querySelector('.voice-timer');
      if (timerEl) timerEl.textContent = timeStr;
    }, 1000);
  },

  _stopDurationTimer() {
    if (this._durationInterval) {
      clearInterval(this._durationInterval);
      this._durationInterval = null;
    }
  },

  /** Start audio level meter using AnalyserNode — attaches to the active mic stream */
  _startLevelMeter(stream) {
    this._stopLevelMeter();
    try {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this._analyserSource = this._audioContext.createMediaStreamSource(stream);
      this._analyser = this._audioContext.createAnalyser();
      this._analyser.fftSize = 256;
      this._analyserSource.connect(this._analyser);
      this._drawLevelMeter();
    } catch (_e) {
      // AudioContext not available — level meter just won't show
    }
  },

  _stopLevelMeter() {
    this._webSpeechSoundActive = false;
    this._webSpeechActivityUntil = 0;
    if (this._levelAnimFrame) {
      cancelAnimationFrame(this._levelAnimFrame);
      this._levelAnimFrame = null;
    }
    if (this._analyserSource) {
      try { this._analyserSource.disconnect(); } catch (_e) { /* */ }
      this._analyserSource = null;
    }
    if (this._audioContext) {
      try { this._audioContext.close(); } catch (_e) { /* */ }
      this._audioContext = null;
    }
    this._analyser = null;
  },

  _drawLevelMeter() {
    if (!this.isRecording) return;
    let rms = 0;
    if (this._activeProvider === 'webspeech') {
      // The speech API exposes activity events, but no microphone sample level.
      const active = !this._webSpeechStopping
        && (this._webSpeechSoundActive || Date.now() < this._webSpeechActivityUntil);
      if (active) rms = 0.25 + 0.55 * (1 + Math.sin(Date.now() / 110)) / 2;
    } else {
      if (!this._analyser) return;
      const dataArray = new Uint8Array(this._analyser.frequencyBinCount);
      this._analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
      rms = Math.sqrt(sum / dataArray.length) / 255;
    }
    // Update the level bars in the preview
    const barsEl = this.previewEl?.querySelector('.voice-level-bars');
    if (barsEl) {
      const bars = barsEl.children;
      for (let i = 0; i < bars.length; i++) {
        const threshold = (i + 1) / bars.length;
        bars[i].classList.toggle('active', rms >= threshold * 0.7);
      }
    }
    this._levelAnimFrame = requestAnimationFrame(() => this._drawLevelMeter());
  },

  _showPreview(text, provider) {
    if (!this.previewEl) {
      this.previewEl = document.createElement('div');
      this.previewEl.className = 'voice-preview';
      this.previewEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(this.previewEl);
    }

    // Build the indicator structure once, then just update the text node
    if (!this.previewEl.querySelector('.voice-recording-indicator')) {
      this.previewEl.textContent = '';
      // Recording indicator: red dot + level bars + timer
      const indicator = document.createElement('span');
      indicator.className = 'voice-recording-indicator';
      indicator.innerHTML = '<span class="voice-rec-dot"></span>';
      const barsEl = document.createElement('span');
      barsEl.className = 'voice-level-bars';
      barsEl.setAttribute('aria-label', this._activeProvider === 'webspeech' ? 'Speech activity' : 'Microphone level');
      barsEl.title = this._activeProvider === 'webspeech' ? 'Speech activity' : 'Microphone level';
      for (let i = 0; i < 5; i++) {
        const bar = document.createElement('span');
        bar.className = 'voice-level-bar';
        barsEl.appendChild(bar);
      }
      indicator.appendChild(barsEl);
      const timerEl = document.createElement('span');
      timerEl.className = 'voice-timer';
      timerEl.textContent = '0:00';
      indicator.appendChild(timerEl);
      this.previewEl.appendChild(indicator);
      // Provider badge (Web Speech gets none — it is the fallback, not a choice)
      const badgeText = provider === 'deepgram' ? 'DG' : provider === 'claude' ? 'CLAUDE' : '';
      if (badgeText) {
        const badge = document.createElement('span');
        badge.className = 'voice-preview-badge';
        badge.textContent = badgeText;
        this.previewEl.appendChild(badge);
        this.previewEl.appendChild(document.createTextNode(' '));
      }
      // Text node for transcript
      this._previewTextNode = document.createTextNode(text || 'Listening...');
      this.previewEl.appendChild(this._previewTextNode);
    } else {
      // Just update the text content
      if (this._previewTextNode) {
        this._previewTextNode.textContent = text || 'Listening...';
      }
    }
    this.previewEl.style.display = '';
  },

  _hidePreview() {
    if (this.previewEl) {
      this.previewEl.style.display = 'none';
      this.previewEl.textContent = '';
    }
  },

  _updateButtons(state) {
    const isRecording = state === 'recording';
    // Desktop button
    const desktopBtn = document.getElementById('voiceInputBtn');
    if (desktopBtn) {
      desktopBtn.classList.toggle('recording', isRecording);
      desktopBtn.setAttribute('aria-pressed', String(isRecording));
      desktopBtn.setAttribute('aria-label', isRecording ? 'Stop voice input' : 'Start voice input');
      desktopBtn.title = isRecording ? 'Stop voice input (Ctrl+Shift+V)' : 'Voice input (Ctrl+Shift+V)';
    }
    // Mobile toolbar button (always visible on mobile)
    const mobileToolbarBtn = document.getElementById('voiceInputBtnMobile');
    if (mobileToolbarBtn) {
      mobileToolbarBtn.classList.toggle('recording', isRecording);
      mobileToolbarBtn.setAttribute('aria-pressed', String(isRecording));
      mobileToolbarBtn.setAttribute('aria-label', isRecording ? 'Stop voice input' : 'Start voice input');
    }
  },

  _showButtons() {
    const desktopBtn = document.getElementById('voiceInputBtn');
    if (desktopBtn) desktopBtn.style.display = '';
    const mobileToolbarBtn = document.getElementById('voiceInputBtnMobile');
    if (mobileToolbarBtn) mobileToolbarBtn.style.display = '';
  },

  /** Cleanup on SSE reconnect or page unload */
  cleanup() {
    if (this.isRecording) {
      this.stop(true);
      try { this.recognition?.abort(); } catch (_e) { /* already ended */ }
    }
    this._hideVoiceSendBtn();
    DeepgramProvider._cleanup();
    ClaudeVoiceProvider._cleanup();
    this.recognition = null;
    this._activeProvider = null;
    this._stopDurationTimer();
    this._stopLevelMeter();
    if (this._webSpeechStream) {
      this._webSpeechStream.getTracks().forEach(t => t.stop());
      this._webSpeechStream = null;
    }
    if (this.previewEl) {
      this.previewEl.remove();
      this.previewEl = null;
    }
    clearTimeout(this.silenceTimeout);
    this.silenceTimeout = null;
    this._accumulatedFinal = '';
    this._pendingInterim = '';
    this._retryCount = 0;
    this._hasReceivedResult = false;
  }
};
