/**
 * @fileoverview iOS WebKit native editing owner for xterm's helper textarea.
 *
 * Keep the native line intact and reconcile its projected text into one ordered
 * transaction. xterm retains commands, paste and composition rendering, but no
 * competing text producer. Native selection is visual only: never send arrows.
 *
 * The shared platform predicate lives in MobileImePreview, which already owns
 * it and loads first. Delegating keeps native ownership and preview gating in
 * lockstep without adding another platform detector or script dependency.
 *
 * @dependency mobile-ime-preview.js (shared isIosWebKitTouch predicate)
 * @loadorder 5.56 (after mobile-ime-preview.js, before terminal-ui.js/terminal-tile.js)
 */
(function (global) {
  'use strict';

  function editBetween(previous, next) {
    const a = Array.from(previous);
    const b = Array.from(next);
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
    return { deleted: a.length - prefix, inserted: b.slice(prefix).join('') };
  }

  // Native line breaks are provisional dictation text, never submit commands.
  function project(value) {
    return value.replace(/\r\n|[\r\n]/g, ' ');
  }

  const TERMINAL_KEYS = Object.freeze({
    Enter: 13,
    Tab: 9,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Insert: 45,
    Delete: 46,
    F1: 112,
    F2: 113,
    F3: 114,
    F4: 115,
    F5: 116,
    F6: 117,
    F7: 118,
    F8: 119,
    F9: 120,
    F10: 121,
    F11: 122,
    F12: 123,
  });
  const IOS_COMMANDS = new Set([
    'UIKeyInputUpArrow',
    'UIKeyInputDownArrow',
    'UIKeyInputLeftArrow',
    'UIKeyInputRightArrow',
    'UIKeyInputEscape',
  ]);

  function classifyKey(ev, textarea) {
    if (ev.isComposing || ev.key === 'Process' || ev.keyCode === 229) return 'compose';
    if (
      ev.ctrlKey ||
      ev.metaKey ||
      ev.altKey ||
      IOS_COMMANDS.has(ev.key) ||
      (Object.prototype.hasOwnProperty.call(TERMINAL_KEYS, ev.key) && TERMINAL_KEYS[ev.key] === ev.keyCode)
    )
      return 'command';
    if (ev.key === 'Backspace' && ev.keyCode === 8 && textarea && textarea.value === '') {
      return 'backspace-terminal';
    }
    return 'native';
  }

  function isSupported() {
    return !!(global.MobileImePreview && global.MobileImePreview.isIosWebKitTouch(global.navigator));
  }

  function create(options) {
    const opts = options || {};
    function record(entry) {
      try {
        if (typeof opts.log === 'function') opts.log(entry);
      } catch (_) {
        /* Diagnostics are optional. */
      }
    }
    function guard(hook, fn, fallback) {
      return function (...args) {
        try {
          return fn.apply(this, args);
        } catch (error) {
          record({ type: 'error', hook, error });
          return fallback;
        }
      };
    }

    const patches = [];
    const listeners = [];
    let textarea;
    let whitespace;
    let destroyed = false;
    let timer = null;
    let synced = '';
    let cursor = 0;
    let invalidated = false;
    let foreignSnapshot = null;
    let foreignTimer = null;
    const caretListeners = new Set(typeof opts.onCaret === 'function' ? [opts.onCaret] : []);
    let notifyCaret = function () {};
    let composing = false;
    let compositionPending = false;
    let reconciling = false;
    let again = false;
    let generation = 0;

    function cancelPending() {
      if (timer !== null) {
        global.clearTimeout(timer);
        timer = null;
      }
      if (foreignTimer !== null) {
        global.clearTimeout(foreignTimer);
        foreignTimer = null;
      }
    }

    const destroy = guard('destroy', function () {
      if (destroyed) return;
      destroyed = true;
      cancelPending();
      notifyCaret();
      caretListeners.clear();
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener, true);
      if (whitespace) {
        if (whitespace.value) textarea.style.setProperty('white-space', whitespace.value, whitespace.priority);
        else textarea.style.removeProperty('white-space');
      }
      // Restore property ownership as well as function identity: most methods
      // originally live on xterm's prototype, not on the instance.
      for (let i = patches.length - 1; i >= 0; i -= 1) {
        const { target, name, descriptor } = patches[i];
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      }
    });

    try {
      const terminal = opts.terminal;
      const core = terminal && terminal._core;
      const helper = core && core._compositionHelper;
      textarea = terminal && terminal.textarea;
      if (
        !textarea ||
        !core ||
        !helper ||
        !core.coreService ||
        typeof core.coreService.triggerDataEvent !== 'function' ||
        typeof core._inputEvent !== 'function' ||
        typeof core._handleTextAreaBlur !== 'function' ||
        typeof helper._handleAnyTextareaChanges !== 'function' ||
        typeof helper._finalizeComposition !== 'function' ||
        !helper._compositionView ||
        !helper._compositionView.classList ||
        typeof textarea.setSelectionRange !== 'function' ||
        (terminal.options && terminal.options.screenReaderMode) ||
        (opts.isScreenReaderMode && opts.isScreenReaderMode())
      )
        return null;

      const sendTransaction = opts.sendTransaction;
      if (typeof sendTransaction !== 'function') return null;
      whitespace = {
        value: textarea.style.getPropertyValue('white-space'),
        priority: textarea.style.getPropertyPriority('white-space'),
      };
      // nowrap collapses whitespace, making WebKit replace trailing spaces with
      // NBSP. pre preserves native spaces without wrapping or changing real NBSP.
      textarea.style.setProperty('white-space', 'pre');
      // A pre-existing field has no provenance: it is not evidence of PTY input.
      invalidated = textarea.value !== '';

      const caret = guard(
        'caret',
        function () {
          const value = Array.from(project(textarea.value));
          const index = Array.from(project(textarea.value.slice(0, textarea.selectionEnd))).length;
          const tail = value.slice(index).join('');
          let cellsFromEnd = value.length - index;
          const unicode = core.unicodeService;
          if (unicode && typeof unicode.getStringCellWidth === 'function') {
            try {
              cellsFromEnd = unicode.getStringCellWidth(tail);
            } catch (_) {
              /* Older xterm builds use the code-point fallback. */
            }
          }
          return {
            visible:
              !destroyed &&
              textarea.ownerDocument.activeElement === textarea &&
              !composing &&
              textarea.selectionStart === textarea.selectionEnd &&
              index < value.length,
            cellsFromEnd,
          };
        },
        { visible: false, cellsFromEnd: 0 }
      );
      let previousCaret;
      notifyCaret = function () {
        const current = caret();
        if (
          previousCaret &&
          previousCaret.visible === current.visible &&
          previousCaret.cellsFromEnd === current.cellsFromEnd
        )
          return;
        previousCaret = current;
        for (const callback of caretListeners) {
          try {
            callback({ ...current });
          } catch (error) {
            record({ type: 'error', hook: 'onCaret', error });
          }
        }
      };
      const onCaret = guard('onCaret', function (callback) {
        if (destroyed || typeof callback !== 'function') return function () {};
        caretListeners.add(callback);
        return function () {
          caretListeners.delete(callback);
        };
      });

      function restoreForeign() {
        if (!foreignSnapshot || destroyed) return;
        const snapshot = foreignSnapshot;
        foreignSnapshot = null;
        if (foreignTimer !== null) {
          global.clearTimeout(foreignTimer);
          foreignTimer = null;
        }
        textarea.value = snapshot.value;
        textarea.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction);
        synced = snapshot.synced;
        notifyCaret();
      }

      function invalidate() {
        if (invalidated) return;
        record({ type: 'drift', value: textarea.value, synced });
        // Never replace a supposedly sent baseline with an unproven field.
        cancelPending();
        foreignSnapshot = null;
        synced = '';
        cursor = 0;
        invalidated = true;
        generation += 1;
        record({ type: 'reset', reason: 'drift', generation });
        notifyCaret();
      }

      function schedule() {
        if (destroyed || timer !== null) return;
        timer = global.setTimeout(
          guard('timer', function () {
            timer = null;
            if (!destroyed) reconcile();
          }),
          0
        );
      }

      function notifyTransaction(transaction) {
        try {
          if (typeof opts.onTransaction === 'function') opts.onTransaction(transaction);
        } catch (error) {
          record({ type: 'error', hook: 'onTransaction', error });
        }
      }

      function reconcile() {
        if (destroyed || composing || invalidated || foreignSnapshot) return;
        if (reconciling) {
          again = true;
          return;
        }
        do {
          again = false;
          const current = project(textarea.value);
          const transaction = { ...editBetween(synced, current), composition: compositionPending };
          compositionPending = false;
          const ops = [];
          if (current !== synced) {
            const { deleted, inserted } = transaction;
            record({ type: 'reconcile', deleted, inserted });
            for (let i = 0; i < deleted; i += 1) ops.push('\x7f');
            if (inserted) ops.push(inserted);
            synced = current;
            cursor = Array.from(current).length;
            generation += 1;
          }
          // Publish the end-anchored baseline BEFORE calling out. A reset inside
          // the transaction survives; the destination receives all ops atomically.
          reconciling = true;
          try {
            if (ops.length) {
              try {
                sendTransaction(ops);
              } catch (error) {
                record({ type: 'error', hook: 'sendTransaction', error });
              }
            }
            // Empty/deletion-only compositions still settle the visual preview.
            notifyTransaction(transaction);
          } finally {
            reconciling = false;
          }
        } while (again && !destroyed && !composing && !invalidated && !foreignSnapshot);
        notifyCaret();
      }

      const settle = guard('settle', function () {
        cancelPending();
        reconcile();
      });
      const reset = guard('reset', function (reason) {
        if (destroyed) return;
        cancelPending();
        foreignSnapshot = null;
        textarea.value = '';
        invalidated = false;
        synced = '';
        cursor = 0;
        generation += 1;
        composing = false;
        compositionPending = false;
        record({ type: 'reset', reason, generation });
        notifyTransaction({ inserted: '', deleted: 0, composition: false });
        notifyCaret();
      });
      const keyFilter = guard(
        'keyFilter',
        function (ev) {
          if (destroyed) return true;
          if (ev.type === 'keypress') return false;
          if (ev.type === 'keyup') return textarea.ownerDocument.activeElement === textarea;
          if (ev.type !== 'keydown') return true;
          const kind = composing ? 'compose' : classifyKey(ev, textarea);
          if (kind === 'compose') {
            schedule();
            return false;
          }
          if (kind === 'command') {
            settle();
            reset('command');
            return true;
          }
          if (kind === 'backspace-terminal') {
            settle();
            return true;
          }
          return false;
        },
        false
      );

      function patch(target, name, replacement) {
        patches.push({ target, name, descriptor: Object.getOwnPropertyDescriptor(target, name) });
        target[name] = guard(name, replacement, false);
      }
      function listen(type, fn, target = textarea) {
        const listener = guard(type, fn);
        listeners.push([target, type, listener]);
        target.addEventListener(type, listener, true);
      }

      patch(core, '_inputEvent', function () {
        return false;
      });
      patch(helper, '_handleAnyTextareaChanges', schedule);
      patch(helper, '_finalizeComposition', function () {
        helper._compositionView.classList.remove('active');
        helper._isComposing = false;
        helper._isSendingComposition = false;
        schedule();
      });
      const originalBlur = core._handleTextAreaBlur;
      patch(core, '_handleTextAreaBlur', function (...args) {
        restoreForeign();
        const value = textarea.value;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const direction = textarea.selectionDirection;
        const before = generation;
        try {
          return originalBlur.apply(this, args);
        } finally {
          if (opts.blurPolicy === 'stock') {
            synced = '';
            cursor = 0;
            invalidated = false;
          } else if (!destroyed && generation === before) {
            textarea.value = value;
            textarea.setSelectionRange(start, end, direction);
          }
          notifyCaret();
        }
      });

      listen('beforeinput', function (ev) {
        if (destroyed || composing || ev.isComposing) return;
        if (foreignSnapshot || project(textarea.value) !== synced) invalidate();
      });
      listen('input', function (ev) {
        if (!destroyed && !ev.isComposing && !composing) {
          if (foreignSnapshot) invalidate();
          if (invalidated) reset('drift');
          else reconcile();
        }
        if (!destroyed) notifyCaret();
      });
      listen('compositionstart', function () {
        if (!destroyed) {
          composing = true;
          notifyCaret();
        }
      });
      listen('compositionend', function () {
        if (destroyed) return;
        composing = false;
        compositionPending = true;
        notifyCaret();
        schedule();
      });
      listen(
        'selectionchange',
        function () {
          if (!destroyed && textarea.ownerDocument.activeElement === textarea) notifyCaret();
        },
        textarea.ownerDocument
      );
      listen('focus', notifyCaret);
      listen('blur', notifyCaret);
      // xterm temporarily lends the helper to native Copy. Restore only before
      // a new key edit, after Copy has read it, or before blur preservation.
      if (terminal.element)
        listen(
          'contextmenu',
          function () {
            if (destroyed || foreignSnapshot) return;
            foreignSnapshot = {
              value: textarea.value,
              start: textarea.selectionStart,
              end: textarea.selectionEnd,
              direction: textarea.selectionDirection,
              synced,
            };
          },
          terminal.element
        );
      listen('keydown', restoreForeign);
      listen(
        'copy',
        function () {
          if (destroyed || !foreignSnapshot || foreignTimer !== null) return;
          foreignTimer = global.setTimeout(
            guard('copy timer', function () {
              foreignTimer = null;
              restoreForeign();
            }),
            0
          );
        },
        textarea.ownerDocument
      );
      listen('blur', restoreForeign);
      // xterm's paste handler emits the clipboard (bracketed when the app asks)
      // but never cancels the event, so the browser would also insert it into
      // the field and reconcile would send it a second time. Cancel only the
      // native insertion; xterm's bubble listener still runs.
      listen('paste', function (ev) {
        if (destroyed) return;
        settle();
        reset('paste');
        ev.preventDefault();
      });
      notifyCaret();

      return {
        keyFilter,
        reset,
        settle,
        destroy,
        caret,
        onCaret,
        state: guard('state', function () {
          return {
            value: textarea.value,
            synced,
            cursor,
            composing,
            invalidated,
            selectionStart: textarea.selectionStart,
            selectionEnd: textarea.selectionEnd,
            generation,
          };
        }),
      };
    } catch (error) {
      record({ type: 'error', hook: 'create', error });
      destroy();
      return null;
    }
  }

  // This is a visual projection only: native caret changes never become keys.
  // `options.anchor()` returns the viewport cell `{col, row}` where the VISIBLE line
  // ends (where the next typed character would appear), 'hide' to hide the
  // marker, or null/undefined to use xterm's cursor. A throwing anchor hides it. Codeman's local echo shows unsent text in an overlay while xterm's own
  // cursor stays at the prompt, so the overlay must supply that anchor. Without an
  // anchor the xterm cursor is used, which is right whenever every byte reached
  // the PTY (local echo off, tiles).
  // `options.subscribe(callback)` returns a disposer and is used to reposition
  // when the anchor moves without an xterm render (overlay repaint).
  function attachCaretMarker(terminal, owner, options) {
    const anchor = options && typeof options.anchor === 'function' ? options.anchor : null;
    const disposables = [];
    let marker;
    let disposed = false;
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of disposables) {
        try {
          cleanup();
        } catch (_) {
          /* Terminal teardown may already have run. */
        }
      }
      if (marker) marker.remove();
    }
    try {
      const screen = terminal.element && terminal.element.querySelector('.xterm-screen');
      if (!screen || !owner || typeof owner.caret !== 'function' || typeof owner.onCaret !== 'function') return dispose;
      marker = screen.ownerDocument.createElement('div');
      marker.className = 'ios-native-caret';
      marker.setAttribute('aria-hidden', 'true');
      marker.style.cssText = 'position:absolute;width:2px;pointer-events:none;display:none;z-index:10';
      screen.appendChild(marker);
      function position() {
        try {
          const caret = owner.caret();
          const core = terminal._core;
          const dimensions = core && core._renderService && core._renderService.dimensions;
          const cell = dimensions && dimensions.css && dimensions.css.cell;
          const buffer = terminal.buffer.active;
          if (disposed || !caret.visible || !cell || !cell.width || !cell.height || !terminal.cols) {
            marker.style.display = 'none';
            return;
          }
          let end = null;
          if (anchor) {
            try {
              end = anchor();
            } catch (_) {
              end = 'hide';
            }
          }
          if (end === 'hide') {
            marker.style.display = 'none';
            return;
          }
          if (end == null) end = { col: buffer.cursorX, row: buffer.cursorY + buffer.baseY - buffer.viewportY };
          let column = end.col - caret.cellsFromEnd;
          let row = end.row;
          if (column < 0) {
            const rows = Math.ceil(-column / terminal.cols);
            column += rows * terminal.cols;
            row -= rows;
          }
          marker.style.display = row < 0 || row >= terminal.rows ? 'none' : 'block';
          marker.style.left = column * cell.width + 'px';
          marker.style.top = row * cell.height + 'px';
          marker.style.height = cell.height + 'px';
          marker.style.backgroundColor = (terminal.options.theme && terminal.options.theme.cursor) || 'currentColor';
        } catch (_) {
          marker.style.display = 'none';
        }
      }
      disposables.push(owner.onCaret(position));
      for (const name of ['onRender', 'onCursorMove']) {
        if (typeof terminal[name] === 'function') {
          const subscription = terminal[name](position);
          disposables.push(() => subscription.dispose());
        }
      }
      if (options && typeof options.subscribe === 'function') {
        try {
          const unsubscribe = options.subscribe(position);
          if (typeof unsubscribe === 'function') disposables.push(unsubscribe);
        } catch (_) {
          /* Optional anchor feed. */
        }
      }
      position();
      return dispose;
    } catch (_) {
      dispose();
      return dispose;
    }
  }

  global.CodemanIosNativeInput = Object.freeze({ create, editBetween, classifyKey, attachCaretMarker, isSupported });
})(typeof window !== 'undefined' ? window : globalThis);
