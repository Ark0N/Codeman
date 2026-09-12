/**
 * @fileoverview Orphaned-input forwarder for xterm's helper textarea.
 *
 * xterm's `CoreBrowserTerminal._inputEvent` only forwards an `insertText`
 * input event while `(!ev.composed || !this._keyDownSeen)` holds. A soft
 * keyboard that delivers a `composed: true` input event after a keydown fails
 * that guard, so xterm returns without emitting and the committed character is
 * silently dropped.
 *
 * ⚠ The gap is NARROWER than "keyCode 229", and assuming otherwise produces a
 * controller that looks useful while doing nothing. For a keydown that really
 * does report `keyCode: 229`, xterm ALREADY self-rescues: `CompositionHelper
 * .keydown()` calls `_handleAnyTextareaChanges()`, which snapshots
 * `textarea.value` and diffs it on a 0 ms timer, emitting the difference
 * itself. Measured in headless chromium against a real terminal: for a 229
 * keydown xterm emits and this controller correctly stands down. What is left
 * unrescued is a refused `insertText` where NO 229 diff was scheduled — that is
 * the case this module exists for, and the case its browser test asserts by
 * checking WHO delivered the byte rather than merely that one arrived.
 *
 * The recovery never guesses the character: the `input` event already carries
 * the real committed text in `ev.data`, which is exactly what xterm itself
 * would have forwarded. We only decide WHETHER to forward it, by asking
 * whether xterm produced any canonical data since the keydown that started the
 * keystroke. That snapshot must be taken at KEYDOWN, not at the input event:
 * xterm's `_keyPress` emits and sets `_keyPressHandled` before `input` fires,
 * so a snapshot read at input time would already contain that emission and the
 * character would be delivered twice.
 *
 * Listener registration is load-bearing, in BOTH phase and order. xterm
 * registers its own `input` listener in `terminal.open()` with `capture:
 * true`, and ours is added afterwards, so at-target it runs second. It must
 * also be a CAPTURE listener; see the measured table at the addEventListener
 * call below.
 *
 * @dependency none (standalone IIFE; consumed by terminal-ui.js)
 * @loadorder 5.55 (before app.js/terminal-ui.js, which create the controller)
 */
(function (global) {
  'use strict';

  function create(options) {
    const textarea = options?.textarea;
    const emitRecovered = options?.emitRecovered;
    if (!textarea?.addEventListener || !textarea?.removeEventListener || typeof emitRecovered !== 'function') {
      return null;
    }

    const isScreenReaderMode = options.isScreenReaderMode;
    const setTimer = options.setTimer || global.setTimeout.bind(global);
    const clearTimer = options.clearTimer || global.clearTimeout.bind(global);

    let destroyed = false;
    // Number of canonical data events xterm has emitted, bumped by the caller's
    // onData hook. Only its ORDER relative to a keydown matters.
    let canonicalCount = 0;
    let keydownSnapshot = null;
    let composing = false;
    const pending = [];

    function cancelPending() {
      for (const candidate of pending.splice(0)) {
        candidate.active = false;
        if (candidate.timer !== null) {
          try {
            clearTimer(candidate.timer);
          } catch {
            // A broken timer host must not break input handling.
          }
          candidate.timer = null;
        }
      }
    }

    function resolveCandidate(candidate) {
      const index = pending.indexOf(candidate);
      if (index !== -1) pending.splice(index, 1);
      candidate.timer = null;
      if (!candidate.active || destroyed) return;
      candidate.active = false;
      // xterm (or its keypress path) spoke for this keystroke — it is already
      // on its way to the PTY, so there is nothing to recover.
      if (canonicalCount > candidate.snapshot) return;
      try {
        emitRecovered(candidate.data);
      } catch {
        // Recovery is best effort; a failed delivery must never throw into the
        // browser's input handling.
      }
    }

    /** Called from xterm's onData hook: xterm produced canonical data. */
    function notifyCanonicalData() {
      canonicalCount += 1;
    }

    /**
     * Snapshot the canonical counter at every keydown. This deliberately reads
     * NOTHING else off the event — not `key`, not `keyCode`. Gating it on
     * keyCode 229 would make the recovery inert on exactly the devices it
     * exists for, whose keydowns report `key: 'Unidentified'`. It is a single
     * assignment, so running it for every keydown costs nothing.
     */
    function handleKeyEvent(event) {
      if (destroyed || event?.type !== 'keydown') return;
      keydownSnapshot = canonicalCount;
    }

    function onInput(event) {
      if (destroyed || composing || event?.isComposing) return;
      if (event.inputType !== 'insertText') return;
      const data = event.data;
      if (typeof data !== 'string' || data === '') return;
      try {
        if (isScreenReaderMode?.()) return;
      } catch {
        return;
      }

      const candidate = {
        data,
        snapshot: keydownSnapshot ?? canonicalCount,
        active: true,
        timer: null,
      };
      pending.push(candidate);
      try {
        candidate.timer = setTimer(() => resolveCandidate(candidate), 0);
      } catch {
        cancelPending();
      }
    }

    function onCompositionStart() {
      if (destroyed) return;
      composing = true;
      cancelPending();
    }

    function onCompositionEnd() {
      if (destroyed) return;
      composing = false;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelPending();
      try {
        textarea.removeEventListener('input', onInput, true);
        textarea.removeEventListener('compositionstart', onCompositionStart, true);
        textarea.removeEventListener('compositionend', onCompositionEnd, true);
      } catch {
        // Teardown is best effort; the terminal is being replaced anyway.
      }
    }

    // capture: true, not bubble. The target (the textarea) is visited TWICE in
    // the event path, so a capture-phase listener on it calling
    // stopPropagation() still stops later BUBBLE-phase listeners on that same
    // target. xterm's `_inputEvent` calls `this.cancel(ev)` (preventDefault +
    // stopPropagation) exactly in the branch where it HANDLED the input, so on
    // bubble we would never see handled events — and whether we saw them at
    // all would hang off xterm's `options.cancelEvents`, which Codeman does not
    // set. Measured (jsdom and headless chromium agree):
    //
    //   capture-then-BUBBLE,  no stop:          xterm -> ours
    //   capture-then-BUBBLE,  stopPropagation:  xterm            (ours never fires)
    //   capture-then-CAPTURE, no stop:          xterm -> ours
    //   capture-then-CAPTURE, stopPropagation:  xterm -> ours    (still fires)
    //
    // On capture we therefore observe EVERY input event uniformly, and the
    // canonicalCount snapshot alone decides whether to forward.
    try {
      textarea.addEventListener('input', onInput, true);
      textarea.addEventListener('compositionstart', onCompositionStart, true);
      textarea.addEventListener('compositionend', onCompositionEnd, true);
    } catch {
      destroy();
      return null;
    }

    return Object.freeze({ handleKeyEvent, notifyCanonicalData, destroy });
  }

  global.CodemanKeyCode229Recovery = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
