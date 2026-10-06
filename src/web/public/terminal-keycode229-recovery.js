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
 * A SECOND failure lives in that same self-rescue: xterm diffs `newValue.replace(oldValue, '')`,
 * which only works when the keyboard APPENDED. A soft keyboard that autocorrects on space
 * (SwiftKey, Gboard) rewrites the tail instead: it deletes the word and inserts the corrected
 * one, and xterm answers by sending the WHOLE new textarea value (the old value is not a
 * substring of it), then sends the inserted text AGAIN from the second keydown's timer. One
 * autocorrect turned `testing the peompt` + <space> into
 * `testing the peompttesting the prompt rompt `. A multi-character delete is also sent as ONE
 * DEL. `installEditSync` below replaces that diff with an edit-based one.
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

  /**
   * What turns `previous` into `next`, as a terminal sees it: how many characters to delete from
   * the END of the line, then what to type. Everything after the common prefix is treated as
   * replaced, because a terminal can only edit at its cursor. Counts are code points, so an
   * emoji is one DEL, as it is one backspace.
   */
  function editBetween(previous, next) {
    const a = Array.from(previous);
    const b = Array.from(next);
    let prefix = 0;
    const max = Math.min(a.length, b.length);
    while (prefix < max && a[prefix] === b[prefix]) prefix += 1;
    return { deleted: a.length - prefix, inserted: b.slice(prefix).join('') };
  }

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
    // ⚠️ 0, never null. With `null` the `?? canonicalCount` fallback at the input
    // event reads a count xterm has ALREADY bumped: on a fresh page load with no
    // keydown yet (dictation, Android voice typing, any `insertText` with no key
    // held) xterm's own capture listener runs first, forwards the text itself and
    // bumps the counter, then this snapshot equals it, `count > snapshot` is false,
    // and the text is emitted a SECOND time. A baseline of 0 makes that comparison
    // true and stands the recovery down, which restores this file's invariant: a
    // missed recovery is acceptable, a duplicated keystroke is not.
    let keydownSnapshot = 0;
    let composing = false;
    const pending = [];

    /**
     * Resolve every candidate still pending, right now, instead of waiting for
     * its zero-delay timer.
     *
     * Android soft keyboards commit the last character and send the Enter key
     * in ONE InputConnection transaction: the `input` event and the Enter
     * keydown are both processed before any timer runs. Left on its timer the
     * candidate lost BOTH ways — xterm emits '\r' synchronously from the Enter
     * keydown (so the local-echo composer submitted the prompt without the
     * character), and that '\r' bumps `canonicalCount`, so the candidate then
     * read "xterm spoke for this keystroke" and stood down, dropping the
     * character outright. That is the "every message loses its last character"
     * report from phones.
     *
     * Draining at the next keydown is correct on both counts: the counter still
     * holds the value it had while this candidate's keystroke was current, and
     * the byte reaches the composer ahead of whatever the new key emits.
     */
    function flushPending() {
      for (const candidate of pending.splice(0)) {
        if (candidate.timer !== null) {
          try {
            clearTimer(candidate.timer);
          } catch {
            // A broken timer host must not break input handling.
          }
          candidate.timer = null;
        }
        resolveCandidate(candidate);
      }
    }

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
      // Settle the PREVIOUS keystroke before this one can move the counter or
      // reach the PTY — see flushPending(). This runs from xterm's custom key
      // handler, i.e. before xterm processes the key, so a recovered character
      // is always ordered ahead of the bytes this keydown produces.
      flushPending();
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

    /**
     * Replace xterm's `_handleAnyTextareaChanges` (see the header) with an edit-based diff against
     * the value the PTY side has already been told about. `synced` is that value; it is shared by
     * every keydown's timer, so two timers that both see the final textarea value cannot both
     * send it. Returns an uninstall function, or null when xterm's internals are not as expected
     * (then xterm's own, flawed, behaviour is left in place).
     */
    function installEditSync() {
      let helper;
      try {
        helper = options.getCompositionHelper?.();
      } catch {
        return null;
      }
      const original = helper?._handleAnyTextareaChanges;
      const coreService = helper?._coreService;
      if (typeof original !== 'function' || typeof coreService?.triggerDataEvent !== 'function') return null;

      let synced = textarea.value;
      let outstanding = 0;

      helper._handleAnyTextareaChanges = function handleAnyTextareaChanges() {
        if (destroyed) return original.call(this);
        // No edit in flight and the value is not what we last sent: something outside the IME
        // changed it (xterm clears it after Enter, a composition committed). Nothing to send;
        // resynchronise.
        if (outstanding === 0 && synced !== textarea.value) synced = textarea.value;
        outstanding += 1;
        setTimer(() => {
          outstanding -= 1;
          if (destroyed || helper._isComposing) return; // xterm's composition path owns this one
          const current = textarea.value;
          if (current === synced) return;
          const { deleted, inserted } = editBetween(synced, current);
          synced = current;
          try {
            // One DEL per character, like repeated backspace presses: the local-echo composer and
            // the PTY both treat each as a single edit.
            for (let i = 0; i < deleted; i += 1) coreService.triggerDataEvent('\x7f', true);
            if (inserted) {
              helper._dataAlreadySent = inserted;
              coreService.triggerDataEvent(inserted, true);
            }
          } catch {
            // Delivery is best effort; never throw into the browser's timer queue.
          }
        }, 0);
      };

      return () => {
        if (helper._handleAnyTextareaChanges !== original) helper._handleAnyTextareaChanges = original;
      };
    }

    const uninstallEditSync = installEditSync();

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
        uninstallEditSync?.();
      } catch {
        // Best effort.
      }
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

  global.CodemanKeyCode229Recovery = Object.freeze({ create, editBetween });
})(typeof window !== 'undefined' ? window : globalThis);
