// Codeman — Voice input with Deepgram Nova-3 and Web Speech API fallback
// Loaded after mobile-handlers.js, before app.js

// ============================================================================
// Voice Input (Deepgram Nova-3 + Web Speech API fallback)
// ============================================================================

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
    this._silenceTimeout = setTimeout(() => {
      this.stop();
    }, 3000);
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
 * VoiceInput - Speech-to-text with Deepgram Nova-3 (primary) and Web Speech API (fallback).
 * Toggle mode: tap mic to start, tap again to stop. Auto-stops after silence.
 * Shows interim transcription in a floating preview overlay.
 * Inserts final text into the active session (user presses Enter to submit).
 */
const VoiceInput = {
  recognition: null,
  isRecording: false,
  supported: false,
  silenceTimeout: null,
  previewEl: null,
  _lastTranscript: '',
  _stabilityTimer: null,
  _accumulatedFinal: '',
  _activeProvider: null, // 'deepgram' | 'webspeech' | null
  _recordingStartedAt: 0, // timestamp when recording started
  _retryCount: 0, // auto-retry counter for premature Web Speech API ends
  _hasReceivedResult: false, // whether any speech result came in this session
  _durationInterval: null, // timer for updating elapsed time display
  _analyser: null, // AudioContext analyser for level meter
  _analyserSource: null, // MediaStreamSource for level meter
  _audioContext: null, // AudioContext for level meter
  _levelAnimFrame: null, // rAF handle for level meter

  init() {
    this._initRecognition();
    // Always show buttons — if unsupported, toggle() shows a toast
    this._showButtons();
  },

  // --- Deepgram config (localStorage only, never sent to server) ---

  _getDeepgramConfig() {
    try {
      return JSON.parse(localStorage.getItem('codeman-voice-settings') || '{}');
    } catch (_e) {
      return {};
    }
  },

  _saveDeepgramConfig(config) {
    localStorage.setItem('codeman-voice-settings', JSON.stringify(config));
  },

  _shouldUseDeepgram() {
    const cfg = this._getDeepgramConfig();
    return !!(cfg.apiKey && cfg.apiKey.trim());
  },

  /** Get the active provider name for display */
  getActiveProviderName() {
    if (this._shouldUseDeepgram()) return 'Deepgram Nova-3';
    if (this.supported) return 'Web Speech API';
    return 'None';
  },

  /** Try to create a SpeechRecognition instance */
  _initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    if (!this.supported) return;

    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = (e) => this._onWebSpeechResult(e);
    this.recognition.onerror = (e) => this._onWebSpeechError(e);
    this.recognition.onend = () => this._onWebSpeechEnd();
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
    if (!app.activeSessionId) {
      app.showToast('No active session', 'warning');
      return;
    }
    this._retryCount = 0;

    if (this._shouldUseDeepgram()) {
      this._startDeepgram();
    } else {
      this._startWebSpeech();
    }
  },

  _startDeepgram() {
    const cfg = this._getDeepgramConfig();
    this.isRecording = true;
    this._activeProvider = 'deepgram';
    this._accumulatedFinal = '';
    this._lastTranscript = '';
    this._hasReceivedResult = false;
    this._recordingStartedAt = Date.now();
    this._updateButtons('recording');
    this._showPreview('Listening...', 'deepgram');
    this._startDurationTimer();

    const keyterms = (cfg.keyterms || 'refactor, endpoint, middleware, callback, async, regex, TypeScript, npm, API, deploy, config, linter, env, webhook, schema, CLI, JSON, CSS, DOM, SSE, backend, frontend, localhost, dependencies, repository, merge, rebase, diff, commit, com')
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
          this._accumulatedFinal += text;
          this._hidePreview();
          this._insertText(this._accumulatedFinal);
          this.stop();
        } else {
          const display = this._accumulatedFinal + text;
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
          if (this._accumulatedFinal) {
            this._insertText(this._accumulatedFinal);
          }
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
    this._accumulatedFinal = '';
    this._lastTranscript = '';
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
        this.stop();
        app.showToast('Voice input failed to start: ' + e.message, 'error');
        return;
      }
    }
    this._resetSilenceTimeout();
    // Get mic stream for level meter (non-blocking — level meter is cosmetic)
    navigator.mediaDevices?.getUserMedia({ audio: true }).then(stream => {
      if (this.isRecording && this._activeProvider === 'webspeech') {
        this._webSpeechStream = stream;
        this._startLevelMeter(stream);
      } else {
        stream.getTracks().forEach(t => t.stop());
      }
    }).catch(() => { /* level meter just won't show */ });
    // Haptic feedback on mobile
    if (navigator.vibrate) navigator.vibrate(50);
  },

  stop() {
    if (!this.isRecording) return;
    this.isRecording = false;
    clearTimeout(this.silenceTimeout);
    clearTimeout(this._stabilityTimer);
    this.silenceTimeout = null;
    this._stabilityTimer = null;
    this._retryCount = 0;
    this._stopDurationTimer();
    this._stopLevelMeter();
    this._updateButtons('idle');
    this._hidePreview();

    if (this._activeProvider === 'deepgram') {
      DeepgramProvider.stop();
    } else if (this._activeProvider === 'webspeech') {
      try {
        this.recognition?.stop();
      } catch (_e) {
        // Already stopped — ignore
      }
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

  _onWebSpeechResult(event) {
    if (!this.isRecording) return;
    this._hasReceivedResult = true;
    this._resetSilenceTimeout();
    let interim = '';
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }

    if (finalText) {
      this._accumulatedFinal += finalText;
      this._hidePreview();
      this._insertText(this._accumulatedFinal);
      this.stop();
    } else if (interim) {
      const display = this._accumulatedFinal + interim;
      this._showPreview(display);
      // iOS Safari workaround: isFinal is always false.
      // Detect when interim results stop changing for 750ms → treat as final.
      this._iosStabilityCheck(interim);
    }
  },

  _onWebSpeechError(event) {
    // During auto-retry, 'aborted' and 'no-speech' errors are expected — ignore them
    if (this._retryCount > 0 && (event.error === 'aborted' || event.error === 'no-speech')) return;

    const wasRecording = this.isRecording;
    this.stop();
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

    const elapsed = Date.now() - this._recordingStartedAt;
    // Web Speech API often fires onend prematurely on the first attempt (< 500ms, no results).
    // Auto-retry up to 2 times to avoid the "needs two clicks" problem.
    if (elapsed < 500 && !this._hasReceivedResult && this._retryCount < 2) {
      this._retryCount++;
      try {
        this.recognition.start();
      } catch (_e) {
        // If restart fails, fall through to stop
        if (this._accumulatedFinal) this._insertText(this._accumulatedFinal);
        this.stop();
      }
      return;
    }

    // Genuine end — finalize any accumulated text
    if (this._accumulatedFinal) {
      this._insertText(this._accumulatedFinal);
    }
    this.stop();
  },

  _insertText(text) {
    if (!app.activeSessionId || !text.trim()) return;
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
      // Direct mode: inject into local echo overlay if available, else send to PTY
      if (app._localEchoEnabled && app._localEchoOverlay) {
        app._localEchoOverlay.appendText(trimmed);
      } else {
        app.sendInput(trimmed).catch(() => {});
      }
      this._showVoiceSendBtn();
      setTimeout(() => { if (app.terminal) app.terminal.focus(); }, 150);
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
      if (!app.activeSessionId) return;
      // Simulate Enter key: if local echo is active, flush its buffer + send \r;
      // otherwise just send \r directly to the PTY
      if (app._localEchoEnabled && app._localEchoOverlay) {
        const text = app._localEchoOverlay.pendingText || '';
        app._localEchoOverlay.clear();
        app._localEchoOverlay.suppressBufferDetection();
        if (text) app.sendInput(text).catch(() => {});
        setTimeout(() => app.sendInput('\r').catch(() => {}), 80);
      } else {
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
      if (val) app.sendInput(val + '\r').catch(() => {});
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
    this.silenceTimeout = setTimeout(() => {
      if (this.isRecording) {
        // Finalize any accumulated text before stopping
        if (this._accumulatedFinal) {
          this._insertText(this._accumulatedFinal);
        }
        this.stop();
      }
    }, 3000);
  },

  _iosStabilityCheck(transcript) {
    if (transcript !== this._lastTranscript) {
      this._lastTranscript = transcript;
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = setTimeout(() => {
        if (this.isRecording) {
          const finalText = this._accumulatedFinal + transcript;
          this._hidePreview();
          this._insertText(finalText);
          this.stop();
        }
      }, 750);
    }
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
    if (!this._analyser || !this.isRecording) return;
    const dataArray = new Uint8Array(this._analyser.frequencyBinCount);
    this._analyser.getByteFrequencyData(dataArray);
    // Compute RMS level 0-1
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
    const rms = Math.sqrt(sum / dataArray.length) / 255;
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
      // Provider badge for Deepgram
      if (provider === 'deepgram') {
        const badge = document.createElement('span');
        badge.className = 'voice-preview-badge';
        badge.textContent = 'DG';
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
    if (this.isRecording) this.stop();
    this._hideVoiceSendBtn();
    DeepgramProvider._cleanup();
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
    clearTimeout(this._stabilityTimer);
    this.silenceTimeout = null;
    this._stabilityTimer = null;
    this._accumulatedFinal = '';
    this._lastTranscript = '';
    this._retryCount = 0;
    this._hasReceivedResult = false;
  }
};
