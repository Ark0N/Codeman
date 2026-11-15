/**
 * @fileoverview CJK IME input for xterm.js terminal.
 *
 * Always-visible textarea below the terminal (in index.html).
 * The browser handles IME composition natively — we just read
 * textarea.value and send it to PTY.
 * While this textarea has focus, window.cjkActive = true blocks xterm's onData.
 * Arrow keys and function keys are forwarded to PTY directly.
 *
 * ## Android IME challenge
 *
 * Android virtual keyboards (WeChat, Sogou, Gboard in Chinese mode) use
 * composition for EVERYTHING — including English prediction and punctuation.
 * This means compositionstart fires even for English text, and compositionend
 * may not fire until the user explicitly confirms (space, candidate tap).
 *
 * During composition, all input events are ignored — only compositionend
 * triggers a flush (CJK candidate selection).
 *
 * ## iOS dictation challenge (WebKit Bug 261764)
 *
 * iOS/iPadOS voice dictation does NOT fire composition events. Text arrives
 * as bare input events with isComposing === false. Dictation refinement is
 * a delete→reinsert cycle (deleteContentBackward + insertReplacementText),
 * all within a few ms. Flushing on every input event would send irrevocable
 * provisional text to the PTY, causing duplication when the IME replaces it.
 *
 * Solution: outside composition, flush is DEBOUNCED (200ms). The entire
 * delete→reinsert cycle collapses into one flush of the final textarea value.
 * Physical-keyboard commits are flushed immediately after the input event
 * exposes the final browser/IME text; keydown never guesses that text.
 *
 * ## Phantom character for Android backspace
 *
 * Android virtual keyboards don't generate key-repeat keydown events for held
 * keys. When the textarea is empty, backspace produces no `input` event either
 * (nothing to delete). We keep a zero-width space (U+200B) "phantom" in the
 * textarea at all times. Backspace deletes the phantom → `input` fires with
 * `deleteContentBackward` → we send \x7f to PTY and restore the phantom.
 * Long-press backspace generates rapid deleteContentBackward events, each
 * handled the same way — giving continuous deletion at the keyboard's native
 * repeat rate.
 *
 * @dependency index.html (#cjkInput textarea)
 * @globals {object} CjkInput — window.cjkActive (boolean) signals app.js to block xterm onData
 * @loadorder 5.5 of 15 — loaded after keyboard-accessory.js, before app.js
 */

// eslint-disable-next-line no-unused-vars
const CjkInput = (() => {
  let _textarea = null;
  let _send = null;
  let _initialized = false;
  let _composing = false;
  let _flushTimer = null;
  let _compositionFlushTimer = null;
  let _dictationActive = false;
  let _dictationDecayTimer = null;
  let _printableKeydownAt = null;
  // Send-on-Enter mode (setting cjkInputHoldUntilEnter): typed text stays in the
  // field until Enter, like a chat box, instead of streaming to the PTY as it is
  // typed. Lets a phone user scroll the terminal and edit an answer before sending.
  let _hold = false;
  const _listeners = {};

  const PHANTOM = '​';

  // ── Diagnostic trace (intermittent CJK-loss investigation) ──
  // In-memory ring buffer of every IME event + flush decision. Mirrored into
  // the crash-diag breadcrumbs (app.js), which persist to localStorage and
  // beacon to the server every 2s — after a repro, `GET /api/crash-diag`
  // shows the exact event sequence.
  // PRIVACY: because the trace leaves the page, it must stay CONTENT-FREE —
  // event types, booleans, key classes, and value LENGTHS only. Never log a
  // typed character or the textarea value (pasted secrets would be captured).
  const TRACE_MAX = 200;
  const _trace = [];
  /** Content-free value descriptor: real-text length + phantom presence. */
  function _vdesc(v) {
    const s = String(v == null ? '' : v);
    return `len=${_strip(s).length}${s.includes(PHANTOM) ? '+ph' : ''}`;
  }
  /** Content-free key descriptor: named keys (Enter, Process…) pass through; any single code point is typed content. */
  function _kdesc(key) {
    const k = String(key == null ? '' : key);
    return [...k].length === 1 ? 'printable' : k;
  }
  function _t(msg) {
    _trace.push(`${Date.now() % 1000000} ${msg}`);
    if (_trace.length > TRACE_MAX) _trace.shift();
    try {
      // eslint-disable-next-line no-undef
      if (typeof _crashDiag !== 'undefined') _crashDiag.log('CJK ' + msg);
    } catch {
      /* crash-diag unavailable (tests) — ring buffer still records */
    }
  }

  // Two-tier debounce for non-composition input:
  // - KEYBOARD: short debounce (third-party IMEs like Doubao may not fire
  //   composition events even for keyboard CJK typing)
  // - DICTATION: long debounce (iOS voice dictation sends delete→reinsert
  //   refinement cycles without composition events — WebKit Bug 261764)
  //
  // Dictation is detected by deleteContentBackward on non-empty text or
  // insertReplacementText — signals that the IME is rewriting provisional
  // text. Once detected, dictation mode persists for 3s (covers multi-word
  // dictation with natural pauses between words).
  const DEBOUNCE_KEYBOARD_MS = 150;
  const DEBOUNCE_DICTATION_MS = 1500;
  const DICTATION_DECAY_MS = 3000;

  const PASSTHROUGH_KEYS = {
    ArrowUp:    '\x1b[A',
    ArrowDown:  '\x1b[B',
    ArrowLeft:  '\x1b[D',
    ArrowRight: '\x1b[C',
    Home:       '\x1b[H',
    End:        '\x1b[F',
    Tab:        '\t',
  };

  const CTRL_KEYS = {
    c: '\x03', d: '\x04', l: '\x0c', z: '\x1a', a: '\x01', e: '\x05',
  };

  /** CSI final byte per navigation key, for the modifier-carrying forms below. */
  const CSI_NAV_FINAL = {
    ArrowUp: 'A',
    ArrowDown: 'B',
    ArrowRight: 'C',
    ArrowLeft: 'D',
    End: 'F',
    Home: 'H',
  };

  /**
   * The `CSI 1 ; <mod> <final>` form for a Ctrl/Alt-modified navigation key, or
   * null when this key is not one.
   *
   * A modified navigation key is a terminal COMMAND, not text editing — claude's
   * own "Jump to bottom (ctrl+End)" is one. PASSTHROUGH_KEYS carries only the
   * plain forms, so Ctrl+End used to fail in BOTH directions: with an empty
   * field it was sent as a bare `\x1b[F` (the modifier silently dropped, so the
   * CLI saw a plain End), and with any text in the field it was not forwarded at
   * all and the browser's default moved the caret to the end of the composer,
   * which is what the user sees as "the shortcut does something to the input box
   * instead".
   *
   * ⚠️ Shift ALONE is deliberately excluded: Shift+arrow selects text inside the
   * composer, which is a real editing gesture worth keeping local. Shift is still
   * encoded when it accompanies Ctrl or Alt.
   */
  function _modifiedNavSequence(e) {
    const final = CSI_NAV_FINAL[e.key];
    if (!final) return null;
    if (!e.ctrlKey && !e.altKey) return null;
    const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
    return `\x1b[1;${mod}${final}`;
  }

  function _strip(str) {
    return str.replace(/​/g, '');
  }

  function _resetToPhantom() {
    // Skip redundant writes: every programmatic value/selection mutation can
    // desync an Android IME's input session (InputConnection) — after which
    // the keyboard composes in its own UI but NO events ever reach the page.
    // Only touch the DOM when the content actually differs.
    if (_textarea.value === PHANTOM) {
      if (_textarea.selectionStart !== 1 || _textarea.selectionEnd !== 1) {
        _textarea.setSelectionRange(1, 1);
      }
      return;
    }
    _textarea.value = PHANTOM;
    _textarea.setSelectionRange(1, 1);
  }

  function _isEffectivelyEmpty() {
    return !_strip(_textarea.value);
  }

  /** Flush textarea: send real text to PTY and reset to phantom */
  function _flush() {
    // Never flush mid-composition: reading the value would send the IME's
    // provisional text, and resetting the textarea cancels the in-progress
    // composition on iOS Safari — silently eating the character being typed.
    // Any committed-but-unflushed text stays in the textarea and is sent
    // together by the next compositionend flush.
    if (_composing) {
      _t('flush SKIP composing');
      return;
    }
    // Send-on-Enter: nothing leaves the field until Enter (keydown handler).
    if (_hold) {
      _t('flush SKIP hold');
      _autoGrow();
      return;
    }
    const val = _strip(_textarea.value);
    _t(`flush ${val ? 'send len=' + val.length : 'empty'}`);
    if (val) {
      _send(val);
    }
    _resetToPhantom();
  }

  /** Send-on-Enter: grow the field with its content (up to the CSS max-height)
   *  and let the keyboard layout re-read its height. */
  function _autoGrow() {
    if (!_textarea) return;
    const before = _textarea.style.height;
    _textarea.style.height = 'auto';
    _textarea.style.height = `${_textarea.scrollHeight}px`;
    if (_textarea.style.height !== before && typeof KeyboardHandler !== 'undefined') {
      KeyboardHandler.updateLayoutForKeyboard?.();
    }
  }

  /** Send-on-Enter: deliver the held text as one prompt, then Enter. One line
   *  goes as typed text + CR in one write (what live mode's Enter sends, so CLI
   *  menus that answer to a digit keep working). Several lines go as one
   *  bracketed paste with Enter as a separate, delayed write, the same bytes as
   *  the mobile prompt composer (keyboard-accessory.js _sendComposedPrompt), so
   *  embedded newlines don't submit early. */
  function _sendHeld(val) {
    if (!/\n/.test(val)) {
      _send(val + '\r');
      return;
    }
    let text = val;
    while (/\x1b\[20[01]~/.test(text)) text = text.replace(/\x1b\[20[01]~/g, '');
    _send(`\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`);
    setTimeout(() => _send('\r'), 120);
  }

  /** Cancel any pending debounced flush */
  function _cancelDebouncedFlush() {
    if (_flushTimer) {
      clearTimeout(_flushTimer);
      _flushTimer = null;
    }
  }

  /** Mark that dictation rewriting is in progress */
  function _enterDictationMode() {
    _dictationActive = true;
    clearTimeout(_dictationDecayTimer);
    _dictationDecayTimer = setTimeout(() => {
      _dictationActive = false;
      _dictationDecayTimer = null;
    }, DICTATION_DECAY_MS);
  }

  /** Schedule a flush after input settles */
  function _debouncedFlush() {
    _cancelDebouncedFlush();
    const delay = _dictationActive ? DEBOUNCE_DICTATION_MS : DEBOUNCE_KEYBOARD_MS;
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      _flush();
    }, delay);
  }

  return {
    init({ send }) {
      if (_initialized) this.destroy();

      _send = send;
      _composing = false;
      _printableKeydownAt = null;
      _flushTimer = null;
      _textarea = document.getElementById('cjkInput');
      if (!_textarea) return this;

      _resetToPhantom();

      _t('init v2-trace');

      _listeners.mousedown = (e) => { e.stopPropagation(); };

      // ── Wedged-IME recovery (Android ONLY) ──
      // Some Android IMEs (esp. 9-key Sogou/Xiaomi/Baidu) can wedge their
      // InputConnection: the keyboard composes in its own candidate bar but
      // delivers ZERO DOM events to the focused textarea. JS cannot detect
      // this (nothing fires) — but re-tapping the already-focused empty field
      // is the user's natural "it's stuck" gesture. A blur→focus cycle forces
      // the browser to restart the IME input session, which un-wedges it.
      // iOS is excluded: tapping the focused empty field there is normal
      // (paste callout, habitual tap), and the setTimeout refocus runs outside
      // the user-gesture stack, so the cycle would just misbehave.
      if (/Android/i.test(navigator.userAgent)) {
        _listeners.pointerdown = () => {
          if (document.activeElement === _textarea && !_composing && _isEffectivelyEmpty()) {
            _t('ime-reset (retap)');
            _textarea.blur();
            setTimeout(() => _textarea.focus(), 0);
          }
        };
        _textarea.addEventListener('pointerdown', _listeners.pointerdown);
      }
      _listeners.focus = () => {
        _t(`focus ${_vdesc(_textarea.value)}`);
        window.cjkActive = true;
        if (!_textarea.value) _resetToPhantom();
      };
      _listeners.blur = () => {
        _t(`blur composing=${_composing} ${_vdesc(_textarea.value)}`);
        _printableKeydownAt = null;
        // Keep cjkActive while CJK input is visible — iOS dictation and system
        // UI may steal focus temporarily, and clearing the flag during that
        // window lets xterm's onData process duplicated input.
        if (!_textarea.classList.contains('cjk-input-visible')) {
          window.cjkActive = false;
        }
        // Reset composing state — some IMEs fire compositionstart without a
        // matching compositionend, leaving _composing stuck true and blocking
        // all subsequent input events.
        _composing = false;
      };
      _textarea.addEventListener('mousedown', _listeners.mousedown);
      _textarea.addEventListener('focus', _listeners.focus);
      _textarea.addEventListener('blur', _listeners.blur);

      // ── Composition tracking (keyboard IME — works for CJK typing) ──
      _listeners.compositionstart = () => {
        _t(`compstart ${_vdesc(_textarea.value)}`);
        _composing = true;
        _printableKeydownAt = null;
        _cancelDebouncedFlush();
        // Leave textarea.value untouched — programmatic changes during
        // compositionstart cancel the IME composition on iOS Safari.
      };
      _listeners.compositionend = () => {
        _t(`compend ${_vdesc(_textarea.value)}`);
        _composing = false;
        _cancelDebouncedFlush();
        // Defer flush: some Android IMEs haven't committed text to textarea
        // when compositionend fires. setTimeout(0) ensures we read the final value.
        // Tracked so destroy() can cancel it; if the next composition starts
        // before it runs, _flush's _composing guard turns it into a no-op.
        clearTimeout(_compositionFlushTimer);
        _compositionFlushTimer = setTimeout(() => {
          _compositionFlushTimer = null;
          _flush();
        }, 0);
      };
      _textarea.addEventListener('compositionstart', _listeners.compositionstart);
      _textarea.addEventListener('compositionend', _listeners.compositionend);

      // ── Keydown: special keys work REGARDLESS of composition state ──
      _listeners.keydown = (e) => {
        _t(`keydown ${_kdesc(e.key)} kc=${e.keyCode} ic=${e.isComposing} c=${_composing}`);
        _printableKeydownAt = null;
        if (e.key === 'Enter') {
          // Send-on-Enter: Shift+Enter (or an IME still composing) is a newline
          // in the field, never a send.
          if (_hold && (e.shiftKey || e.isComposing || e.keyCode === 229)) {
            setTimeout(_autoGrow, 0);
            return;
          }
          e.preventDefault();
          _composing = false;
          _cancelDebouncedFlush();
          const val = _strip(_textarea.value);
          if (_hold && val) {
            _sendHeld(val);
          } else if (val) {
            _send(val + '\r');
          } else {
            _send('\r');
          }
          _resetToPhantom();
          if (_hold) _autoGrow();
          return;
        }

        if (e.key === 'Escape') {
          e.preventDefault();
          _composing = false;
          _cancelDebouncedFlush();
          _resetToPhantom();
          if (_hold) _autoGrow();
          return;
        }

        if (e.ctrlKey && CTRL_KEYS[e.key]) {
          e.preventDefault();
          _send(CTRL_KEYS[e.key]);
          return;
        }

        // Below: only when NOT composing (composing keystrokes belong to IME).
        // Also check isComposing/keyCode 229 — the first keydown of a CJK
        // sequence arrives BEFORE compositionstart, so _composing is still false.
        if (_composing || e.isComposing || e.keyCode === 229) return;

        // Backspace: forward to PTY when no real text in textarea
        if (e.key === 'Backspace' && _isEffectivelyEmpty()) {
          e.preventDefault();
          _send('\x7f');
          _resetToPhantom();
          return;
        }

        // Ctrl/Alt-modified navigation keys go to the PTY REGARDLESS of whether
        // the field has text: they are commands for the CLI, and the composer has
        // no editing behaviour for them worth preserving (plain Home/End still
        // edit locally through the table below).
        const modNav = _modifiedNavSequence(e);
        if (modNav) {
          e.preventDefault();
          _send(modNav);
          return;
        }

        // Arrow/function keys: forward to PTY when no real text
        if (PASSTHROUGH_KEYS[e.key] && _isEffectivelyEmpty()) {
          e.preventDefault();
          _send(PASSTHROUGH_KEYS[e.key]);
          return;
        }

        // A printable KeyboardEvent.key is the physical key, not necessarily
        // the committed text. Let the browser/IME produce the input event so
        // full-width punctuation and other layout transforms are preserved.
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && _isEffectivelyEmpty()) {
          _printableKeydownAt = performance.now();
          return;
        }
      };
      _textarea.addEventListener('keydown', _listeners.keydown);

      // ── Input event: primary path for virtual keyboards + dictation ──
      _listeners.input = (e) => {
        _t(`input ${e.inputType || '?'} ic=${e.isComposing} c=${_composing} ${_vdesc(_textarea.value)}`);
        const printableKeydownAt = _printableKeydownAt;
        _printableKeydownAt = null;
        // ── Stuck-composition recovery ──
        // Some IMEs (WeChat/Sogou keyboards) fire compositionstart without a
        // matching compositionend. A stale _composing=true blocks every flush
        // below — committed CJK text piles up in the textarea and never
        // reaches the PTY. When the event itself says composition is over
        // (isComposing false AND a non-composition inputType), trust it.
        if (
          _composing &&
          e.isComposing === false &&
          e.inputType !== 'insertCompositionText' &&
          e.inputType !== 'deleteCompositionText'
        ) {
          _t('UNSTICK composing');
          _composing = false;
        }

        // ── Backspace / delete detection ──
        if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteWordBackward') {
          if (_composing) return;
          if (_isEffectivelyEmpty()) {
            _cancelDebouncedFlush();
            _send('\x7f');
            _resetToPhantom();
            return;
          }
          // Delete on non-empty text outside composition = dictation rewrite.
          // The IME is revising provisional text — switch to long debounce.
          _enterDictationMode();
          if (!_textarea.value.startsWith(PHANTOM)) {
            _textarea.value = PHANTOM + _textarea.value;
            _textarea.setSelectionRange(1, 1);
          }
          _debouncedFlush();
          return;
        }

        // insertReplacementText = dictation/autocorrect refinement
        if (e.inputType === 'insertReplacementText') {
          _enterDictationMode();
          _debouncedFlush();
          return;
        }

        if (_composing) return;

        // A recent physical printable key makes this insertText a keyboard
        // commit, so keep the old zero-latency path. Send the textarea's final
        // Unicode value, never KeyboardEvent.key, because the IME may have
        // transformed punctuation or the active layout may differ.
        if (
          e.inputType === 'insertText' &&
          printableKeydownAt !== null &&
          performance.now() - printableKeydownAt < 100
        ) {
          _cancelDebouncedFlush();
          _flush();
          return;
        }

        // Outside composition: keyboard typing or voice dictation.
        // If dictation mode was detected (delete/replacement events seen
        // recently), use long debounce. Otherwise short debounce for keyboard.
        _debouncedFlush();
      };
      _textarea.addEventListener('input', _listeners.input);

      _initialized = true;
      return this;
    },

    /**
     * Discard pending text and timers (e.g. on session switch, so stale text
     * can't flush into the wrong session). Restores the phantom so backspace
     * forwarding keeps working — unlike a raw `textarea.value = ''`.
     */
    clear() {
      if (!_initialized || !_textarea) return;
      _t('clear (external)');
      _cancelDebouncedFlush();
      clearTimeout(_compositionFlushTimer);
      _compositionFlushTimer = null;
      _composing = false;
      _printableKeydownAt = null;
      _resetToPhantom();
    },

    /**
     * Send-on-Enter mode on or off (setting cjkInputHoldUntilEnter). On: text
     * stays in the field until Enter and the browser's autocorrect is allowed,
     * since nothing typed has reached the PTY yet. Off: the original live mode.
     */
    setHoldUntilEnter(on) {
      _hold = !!on;
      if (!_textarea) return;
      const v = _hold ? 'on' : 'off';
      _textarea.setAttribute('autocorrect', v);
      _textarea.setAttribute('autocapitalize', _hold ? 'sentences' : 'off');
      _textarea.setAttribute('spellcheck', _hold ? 'true' : 'false');
      _textarea.placeholder = _hold
        ? 'Type, Enter to send (Shift+Enter: new line, Esc: clear)'
        : 'CJK input (Enter = send, Esc = clear)';
      if (_hold) {
        _cancelDebouncedFlush();
        _autoGrow();
      } else {
        _textarea.style.height = '';
      }
      _t(`hold ${v}`);
    },

    get holdUntilEnter() { return _hold; },

    /** Diagnostic: recent IME event trace (ring buffer). */
    getTrace() {
      return _trace.slice();
    },

    destroy() {
      _cancelDebouncedFlush();
      clearTimeout(_compositionFlushTimer);
      _compositionFlushTimer = null;
      clearTimeout(_dictationDecayTimer);
      _dictationActive = false;
      if (_textarea) {
        for (const [event, handler] of Object.entries(_listeners)) {
          if (handler) _textarea.removeEventListener(event, handler);
        }
      }
      window.cjkActive = false;
      _composing = false;
      _printableKeydownAt = null;
      for (const key of Object.keys(_listeners)) delete _listeners[key];
      _initialized = false;
    },

    get element() { return _textarea; },
  };
})();
