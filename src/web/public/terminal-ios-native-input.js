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

  // WebKit removes one grapheme cluster per Backspace, and Claude Code and Codex
  // delete one grapheme per DEL, so an edit is counted in graphemes: a red heart,
  // a skin-tone emoji, a flag or a ZWJ family is one DEL, as it was through xterm.
  // Code points stand in where Intl.Segmenter is missing.
  const graphemeSegmenter = (function () {
    try {
      return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
    } catch (_) {
      return null;
    }
  })();

  function graphemes(text) {
    return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), (part) => part.segment) : Array.from(text);
  }

  function editBetween(previous, next) {
    // A pure append (including a combining mark or tone typed onto the last letter)
    // is sent as-is, as xterm sends it: re-typing the extended cluster would make
    // a code-point line editor (zsh) double the base letter.
    if (next.startsWith(previous)) return { deleted: 0, inserted: next.slice(previous.length) };
    const a = graphemes(previous);
    const b = graphemes(next);
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
          const text = project(textarea.value);
          const offset = project(textarea.value.slice(0, textarea.selectionEnd)).length;
          return {
            visible:
              !destroyed &&
              textarea.ownerDocument.activeElement === textarea &&
              !composing &&
              textarea.selectionStart === textarea.selectionEnd &&
              offset < text.length &&
              text === synced &&
              !invalidated &&
              !foreignSnapshot,
            text,
            offset,
            // Advances only when an edit is reconciled (sent) or the line is reset;
            // a borrowed clipboard value and its restoration leave it unchanged.
            generation,
          };
        },
        { visible: false, text: '', offset: 0, generation: 0 }
      );
      let previousCaret;
      notifyCaret = function () {
        const current = caret();
        if (
          previousCaret &&
          previousCaret.visible === current.visible &&
          previousCaret.text === current.text &&
          previousCaret.offset === current.offset &&
          previousCaret.generation === current.generation
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
              // These ops bypass xterm's triggerDataEvent(data, true), so its
              // scrollOnUserInput never runs; scroll to the prompt as xterm would.
              try {
                if (
                  terminal.options &&
                  terminal.options.scrollOnUserInput !== false &&
                  typeof terminal.scrollToBottom === 'function'
                )
                  terminal.scrollToBottom();
              } catch (error) {
                record({ type: 'error', hook: 'scrollOnUserInput', error });
              }
              try {
                sendTransaction(ops);
              } catch (error) {
                record({ type: 'error', hook: 'sendTransaction', error });
                invalidated = true;
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
          restoreForeign();
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

      patch(core, '_inputEvent', function (ev) {
        if (ev && ev.data && ev.inputType === 'insertText') core._unprocessedDeadKey = false;
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
            notifyCaret();
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

  // Visual only: an anchor(caret) supplies the exact viewport cell, 'hide', or
  // null to resolve against parsed xterm cells. Neither mode moves native input.
  // subscribe(callback) follows overlay repaints without an xterm render.
  function bufferCaretAnchor(terminal, caret) {
    const buffer = terminal.buffer.active;
    const text = caret.text;
    if (!text || caret.offset < 0 || caret.offset > text.length) return null;
    let row = buffer.baseY + buffer.cursorY;
    let col = buffer.cursorX;
    let line = buffer.getLine(row);
    // Read only as far as the native field and one preceding repetition.
    function previousCell() {
      while (line) {
        if (col === 0) {
          if (!line.isWrapped || row === 0) return null;
          const following = line;
          line = buffer.getLine(--row);
          if (!line) return null;
          col = terminal.cols;
          // A wide glyph that did not fit leaves unused cells before a soft
          // wrap. Validate that padding against the following glyph's width;
          // ordinary blank cells (including printed spaces) remain text.
          let padding = 0;
          while (col - padding > 0) {
            const cell = line.getCell(col - padding - 1);
            if (!cell || cell.getWidth() !== 1 || cell.getChars()) break;
            padding += 1;
          }
          const first = following.getCell(0);
          if (padding && first && first.getWidth() > padding) col -= padding;
        }
        const cell = line.getCell(--col);
        if (!cell) return null;
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars();
        if (!chars) return null;
        return { chars, col, row: row - buffer.viewportY };
      }
      return null;
    }
    const cells = [];
    let remaining = text.length;
    while (remaining > 0) {
      const cell = previousCell();
      if (!cell || cell.chars.length > remaining || text.slice(remaining - cell.chars.length, remaining) !== cell.chars)
        return null;
      cells.push(cell);
      remaining -= cell.chars.length;
    }
    // A previous identical native-length suffix makes provenance ambiguous.
    remaining = text.length;
    while (remaining > 0) {
      const cell = previousCell();
      if (!cell || cell.chars.length > remaining || text.slice(remaining - cell.chars.length, remaining) !== cell.chars)
        break;
      remaining -= cell.chars.length;
    }
    if (remaining === 0) return null;
    let offset = 0;
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      const cell = cells[i];
      if (caret.offset === offset) return { col: cell.col, row: cell.row };
      offset += cell.chars.length;
      if (caret.offset < offset) return null; // No cell inside a cluster.
    }
    return { col: buffer.cursorX, row: buffer.baseY + buffer.cursorY - buffer.viewportY };
  }
  function attachCaretMarker(terminal, owner, options) {
    const anchor = options && typeof options.anchor === 'function' ? options.anchor : null;
    const disposables = [];
    let marker;
    let disposed = false;
    let caretGeneration = 0;
    let awaitingEcho = false;
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
      caretGeneration = owner.caret().generation;
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
          if (disposed || !caret.visible || !cell || !cell.width || !cell.height || !terminal.cols) {
            marker.style.display = 'none';
            return;
          }
          let target = null;
          if (anchor) {
            try {
              target = anchor(caret);
            } catch (_) {
              target = 'hide';
            }
          }
          if (target == null && !awaitingEcho) target = bufferCaretAnchor(terminal, caret);
          if (!target || target === 'hide' || target.row < 0 || target.row >= terminal.rows) {
            marker.style.display = 'none';
            return;
          }
          marker.style.display = 'block';
          marker.style.left = target.col * cell.width + 'px';
          marker.style.top = target.row * cell.height + 'px';
          marker.style.height = cell.height + 'px';
          marker.style.backgroundColor = (terminal.options.theme && terminal.options.theme.cursor) || 'currentColor';
        } catch (_) {
          marker.style.display = 'none';
        }
      }
      disposables.push(
        owner.onCaret((caret) => {
          // Await parsed output only for a reconciled edit or reset (generation),
          // never for a borrowed clipboard value or its restoration.
          if (caret.generation !== caretGeneration) {
            caretGeneration = caret.generation;
            awaitingEcho = true;
          }
          position();
        })
      );
      if (typeof terminal.onWriteParsed === 'function') {
        const subscription = terminal.onWriteParsed(() => {
          awaitingEcho = false;
          position();
        });
        disposables.push(() => subscription.dispose());
      }
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
