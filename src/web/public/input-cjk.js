/**
 * @fileoverview CJK IME input for xterm.js terminal.
 *
 * Always-visible textarea below the terminal (in index.html).
 * The browser handles IME composition natively — we just read
 * textarea.value and send it to PTY.
 * While this textarea has focus, window.cjkActive = true blocks xterm's onData.
 * Arrow keys and function keys are forwarded to PTY directly.
 *
 * ## Send on Enter (setting cjkInputHoldUntilEnter)
 *
 * The live mode above streams typed text to the PTY after a short debounce.
 * With Send on Enter on, the field is a chat box instead: _flush() holds the
 * text, and only Enter sends it, through the sendPrompt callback
 * (terminal-ui.js _sendCjkPrompt: a single character is typed, anything longer
 * goes as the composer's bracketed paste, Enter is always its own later write,
 * and a lone digit at a pending dialog goes without it). Shift+Enter is a
 * newline, Esc clears, Backspace and the arrows reach the PTY only from an
 * empty field, and so do the Ctrl shortcuts. Autocorrect is on. A held draft
 * belongs to one session (_owner): clear() stashes it under that session and
 * restoreDraft() brings it back when the session is shown again, except a
 * clear({ discard: true }) (the keyboard bar's clear-line key), which throws
 * it away.
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
  // Send-on-Enter: the held text as of the last settled input event (phantom
  // stripped). Tells a deletion that emptied the field from a Backspace on a field
  // that was already empty, and finds the one character an armed Ctrl applies to.
  let _heldBase = '';
  // Send-on-Enter: delivers a held answer, text first and Enter as a separate
  // delayed write, to the session it was typed for (terminal-ui.js).
  let _sendPrompt = null;
  // Send-on-Enter: whether setHoldUntilEnter() has applied the current mode to
  // the field yet, so a repeat call with the same mode leaves the field alone.
  let _holdApplied = false;
  // Send-on-Enter: held drafts of the sessions switched away from, by session id.
  const _drafts = new Map();
  // Send-on-Enter: the session the field's text belongs to (the one last shown,
  // set by restoreDraft). clear() stashes a held draft under it, so every path
  // that drops the active session before the next cleanup (goHome, the tile
  // grid's _replaceTileGrid and _onTileAdoptedElsewhere) keeps the answer.
  let _owner = null;
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
    _heldBase = '';
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
      _holdSettle();
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
    // A hidden field (no session shown yet) measures 0: leave the CSS height,
    // or it stays a sliver until the next keystroke.
    if (_textarea.getClientRects && !_textarea.getClientRects().length) {
      _textarea.style.height = '';
      return;
    }
    const before = _textarea.style.height;
    _textarea.style.height = 'auto';
    // border-box: scrollHeight leaves the borders out, offsetHeight - clientHeight adds them back.
    _textarea.style.height = `${_textarea.scrollHeight + _textarea.offsetHeight - _textarea.clientHeight}px`;
    if (_textarea.style.height !== before && typeof KeyboardHandler !== 'undefined') {
      KeyboardHandler.updateLayoutForKeyboard?.();
    }
  }

  /** Send-on-Enter: deliver the held text, then Enter, through `_sendPrompt`
   *  (terminal-ui.js _sendCjkPrompt). Enter is never part of the text's write:
   *  Codex takes characters arriving in one burst as a paste and folds an Enter
   *  inside it into the paste, and Claude Code does the same for a long burst, so
   *  even `1\r` in one write sits unsent. Returns false when the text was refused
   *  (too long, no session), so the field keeps it. */
  function _sendHeld(val) {
    if (!_sendPrompt) {
      _t('hold send DROP no-prompt-path');
      return false;
    }
    return _sendPrompt(val) !== false;
  }

  /** Enter: send what the field holds (or a bare Enter when it is empty) and
   *  reset it. Returns false when a held answer was refused, which keeps it. */
  function _submit() {
    _composing = false;
    _cancelDebouncedFlush();
    clearTimeout(_compositionFlushTimer);
    _compositionFlushTimer = null;
    let val = _strip(_textarea.value);
    // Only blank lines held (Shift+Enter, then Enter): a bare Enter, not a
    // newline typed into the CLI.
    if (_hold && !val.trim()) val = '';
    if (_hold && val) {
      // Refused (too long, no session): keep the text so nothing is lost.
      if (!_sendHeld(val)) return false;
    } else if (val) {
      _send(val + '\r');
    } else {
      _send('\r');
    }
    _resetToPhantom();
    if (_hold) _autoGrow();
    return true;
  }

  function _ctrlArmed() {
    return typeof KeyboardAccessoryBar !== 'undefined' && KeyboardAccessoryBar.isCtrlArmed?.() === true;
  }

  /** Index of the one character `after` adds to `before`, or -1 when the change
   *  is anything else (several characters, a deletion, a rewrite). */
  function _singleInsertionAt(before, after) {
    if (after.length !== before.length + 1) return -1;
    let i = 0;
    while (i < before.length && before[i] === after[i]) i++;
    return after.slice(i + 1) === before.slice(i) ? i : -1;
  }

  /** Send-on-Enter: settle the field after an input event. With the shell bar's
   *  one-shot Ctrl armed, a single typed character is not held: it leaves the
   *  field and goes to the PTY, where _handleCjkInput turns it into the control
   *  byte (`c` → Ctrl+C). Any other change spends the modifier, the same rule
   *  live mode follows for a multi-character chunk. */
  function _holdSettle() {
    const before = _heldBase;
    const now = _strip(_textarea.value);
    _heldBase = now;
    if (now === before || !_ctrlArmed()) return;
    const at = _singleInsertionAt(before, now);
    if (at < 0 || now[at] === '\n') {
      KeyboardAccessoryBar.clearCtrl?.();
      return;
    }
    _t('hold ctrl key');
    _textarea.value = PHANTOM + before;
    _textarea.setSelectionRange(1 + at, 1 + at);
    _heldBase = before;
    _send(now[at]);
  }

  /** Send-on-Enter input handling: nothing is flushed, the field only settles.
   *  A deletion forwards Backspace to the PTY only when the field was ALREADY
   *  empty, i.e. the phantom itself was deleted. Deleting the last held
   *  character (or select-all + delete) must not also delete a character from
   *  the CLI's own composer, which Attach, image paste, Path and the mic fill. */
  function _holdInput(e) {
    if (_composing) return; // composed text settles at compositionend (_flush)
    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteWordBackward') {
      const wasEmpty = !_heldBase;
      _heldBase = _strip(_textarea.value);
      if (!_heldBase) {
        if (wasEmpty) _send('\x7f');
        _resetToPhantom();
      } else if (!_textarea.value.startsWith(PHANTOM)) {
        // Backspace at the very start of the text deleted the phantom: put it
        // back with the caret where it was, at the start of the text.
        _textarea.value = PHANTOM + _textarea.value;
        _textarea.setSelectionRange(1, 1);
      }
      _autoGrow();
      return;
    }
    _holdSettle();
    _autoGrow();
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
    init({ send, sendPrompt = null }) {
      if (_initialized) this.destroy();

      _send = send;
      _sendPrompt = sendPrompt;
      _composing = false;
      _printableKeydownAt = null;
      _flushTimer = null;
      _textarea = document.getElementById('cjkInput');
      _holdApplied = false; // a new field has not had the mode applied
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
          _submit();
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

        // Send-on-Enter with a draft in the field: Ctrl shortcuts are the
        // field's (Ctrl+Z undo, Ctrl+A select all, Ctrl+C copy a selection), so
        // they reach the CLI only while the field is empty, the rule Backspace
        // and the arrows already follow.
        if (e.ctrlKey && CTRL_KEYS[e.key] && (!_hold || _isEffectivelyEmpty())) {
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

        if (_hold) {
          _holdInput(e);
          return;
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
    clear({ discard = false } = {}) {
      if (!_initialized || !_textarea) return;
      _t(`clear (external)${discard ? ' discard' : ''}`);
      if (discard) {
        // The user threw the text away (the keyboard bar's clear-line key):
        // nothing is stashed, any older stash of this session goes too, and the
        // field keeps its owner, since the session shown has not changed.
        if (_owner) _drafts.delete(_owner);
      } else {
        // Send-on-Enter: a held draft is stashed for the session it was typed
        // for, whichever path got here. discardDraft() drops the owner of a
        // removed session, so its text is not stashed again.
        if (_hold && _owner) {
          const draft = _strip(_textarea.value);
          if (draft.trim()) _drafts.set(_owner, draft);
        }
        _owner = null;
      }
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
      // Called on every session select and SSE reconnect: with the mode
      // unchanged, leave the field alone, since rewriting its attributes while
      // it has focus can disturb a composition in progress.
      if (_holdApplied && _textarea && _hold === !!on) return;
      _hold = !!on;
      if (!_textarea) return;
      _holdApplied = true;
      _heldBase = _strip(_textarea.value);
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

    /**
     * Enter from outside the field (the phone toolbar's Enter button, which
     * xterm's onData would swallow while the field is visible). Same as Enter
     * in the field. Returns false when nothing was done (not initialized) or a
     * held answer was refused.
     */
    submit() {
      if (!_initialized || !_textarea) return false;
      _t(`submit (external) c=${_composing}`);
      if (_composing) {
        // An IME still composing (Gboard holds the current word, iOS the
        // unconverted pinyin): reading and resetting the field under it can
        // desync the keyboard. Blur commits the composition, focus keeps the
        // keyboard up (still inside the tap's gesture), then send what landed.
        _textarea.blur();
        _textarea.focus();
      }
      return _submit();
    },

    /**
     * Send-on-Enter: keep the held draft of the session being left, so a
     * switch (a stray sideways swipe) does not lose an answer. Call before
     * clear(); restoreDraft() puts it back when that session is shown again.
     */
    stashDraft(sessionId) {
      if (!_initialized || !_textarea || !_hold || !sessionId) return;
      // An empty field leaves any stash alone: a draft only sits in the map
      // while its session is not shown (restoreDraft takes it out), and the
      // tile grid may stash an id whose draft is already put away.
      const draft = _strip(_textarea.value);
      if (draft.trim()) _drafts.set(sessionId, draft);
    },

    /** Send-on-Enter: show the draft stashed for this session, if any, unless
     *  the field already holds text. */
    restoreDraft(sessionId) {
      if (!_initialized || !_textarea) return;
      // The field now belongs to this session, draft or not (see _owner),
      // unless it still holds another session's text (no clear() in between).
      if (!_owner || !_strip(_textarea.value)) _owner = sessionId || null;
      if (!_hold || !_drafts.has(sessionId)) return;
      if (_strip(_textarea.value)) return;
      const draft = _drafts.get(sessionId);
      _drafts.delete(sessionId);
      _t(`restore draft len=${draft.length}`);
      _textarea.value = PHANTOM + draft;
      _textarea.setSelectionRange(_textarea.value.length, _textarea.value.length);
      _heldBase = draft;
      _autoGrow();
    },

    /** Forget a stashed draft when its session no longer exists. */
    discardDraft(sessionId) {
      _drafts.delete(sessionId);
      if (_owner === sessionId) _owner = null;
    },

    /** Diagnostic/test: the session the field's text belongs to. */
    get draftOwner() { return _owner; },

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
