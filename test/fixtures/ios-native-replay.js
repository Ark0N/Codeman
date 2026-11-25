/** @fileoverview Replay phone-validated iOS native input events and browser defaults. */
// Synthetic events have no browser default. Replay WebKit's order and apply
// native edits by hand, but never apply a default after preventDefault().
(function (global) {
  'use strict';

  function kev(type, key, keyCode, extra = {}) {
    const ev = new KeyboardEvent(type, {
      key,
      code: extra.code || (key === 'Backspace' ? 'Backspace' : 'Unidentified'),
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: !!extra.ctrlKey,
      shiftKey: !!extra.shiftKey,
      altKey: !!extra.altKey,
      metaKey: !!extra.metaKey,
      isComposing: !!extra.isComposing,
    });
    Object.defineProperties(ev, {
      keyCode: { get: () => keyCode },
      which: { get: () => keyCode },
      charCode: { get: () => (type === 'keypress' ? keyCode : 0) },
    });
    return ev;
  }

  function iev(type, inputType, data, options = {}) {
    return new InputEvent(type, {
      inputType,
      data: data ?? null,
      bubbles: true,
      cancelable: type === 'beforeinput',
      composed: true,
      isComposing: !!options.isComposing,
    });
  }

  function applyEdit(ta, inputType, data, range) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const select = HTMLTextAreaElement.prototype.setSelectionRange;
    const value = ta.value;
    let start = range ? range[0] : ta.selectionStart;
    const end = range ? range[1] : ta.selectionEnd;
    if (inputType === 'deleteContentBackward') {
      if (start === end) {
        if (start === 0) return false;
        const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value.slice(0, start));
        start -= Array.from(segments).pop().segment.length;
      }
      setValue.call(ta, value.slice(0, start) + value.slice(end));
      select.call(ta, start, start);
    } else if (
      inputType === 'insertText' ||
      inputType === 'insertReplacementText' ||
      inputType === 'insertCompositionText' ||
      inputType === 'insertLineBreak'
    ) {
      const text = inputType === 'insertLineBreak' ? '\n' : data;
      setValue.call(ta, value.slice(0, start) + text + value.slice(end));
      // Textarea values normalize CRLF. Use the normalized inserted length.
      const caret = start + text.replace(/\r\n?/g, '\n').length;
      select.call(ta, caret, caret);
    } else {
      throw new Error('Unsupported replay edit: ' + inputType);
    }
    return true;
  }

  function edit(ta, inputType, data, range, options = {}) {
    if (range) HTMLTextAreaElement.prototype.setSelectionRange.call(ta, ...range);
    const before = iev('beforeinput', inputType, data, options);
    ta.dispatchEvent(before);
    if (before.defaultPrevented || !applyEdit(ta, inputType, data, range)) return false;
    if (!options.omitInput) ta.dispatchEvent(iev('input', inputType, data, options));
    return true;
  }

  // Replay event order/data, not old value snapshots: those include writes by
  // the broken owner. Preserve explicit hypothesis ranges, otherwise let the
  // caret advance in the intact field as real browser defaults would.
  function capturedEdits(ta, records, afterInput, afterEvent) {
    const select = HTMLTextAreaElement.prototype.setSelectionRange;
    const decode = (value) =>
      value
        .replace(/<LF>/g, '\n')
        .replace(/<CR>/g, '\r')
        .replace(/<NBSP>/g, '\u00a0');
    let pending;
    for (const record of records) {
      if (record.kind !== 'ev' || !['beforeinput', 'input'].includes(record.type)) continue;
      const data = record.data === 'null' || record.data == null ? null : decode(record.data);
      if (record.type === 'beforeinput') {
        if (record.sel[0] !== record.sel[1]) select.call(ta, ...record.sel);
        const event = iev(record.type, record.inputType, data, record);
        ta.dispatchEvent(event);
        if (afterEvent) afterEvent(record);
        pending = event.defaultPrevented ? null : { inputType: record.inputType, data };
      } else {
        if (pending) applyEdit(ta, pending.inputType, pending.data);
        pending = null;
        ta.dispatchEvent(iev(record.type, record.inputType, data, record));
        if (afterInput) afterInput(record);
        if (afterEvent) afterEvent(record);
      }
    }
  }

  function typeKey(ta, text) {
    const first = text.codePointAt(0);
    const keyCode = text === ' ' ? 32 : String.fromCodePoint(first).toUpperCase().codePointAt(0);
    const down = kev('keydown', text, keyCode);
    ta.dispatchEvent(down);
    if (!down.defaultPrevented) {
      const press = kev('keypress', text, first);
      ta.dispatchEvent(press);
      if (!press.defaultPrevented) edit(ta, 'insertText', text);
    }
    ta.dispatchEvent(kev('keyup', text, keyCode));
  }

  function backspace(ta) {
    const down = kev('keydown', 'Backspace', 8);
    ta.dispatchEvent(down);
    if (!down.defaultPrevented) edit(ta, 'deleteContentBackward');
    ta.dispatchEvent(kev('keyup', 'Backspace', 8));
  }

  function holdDeleteRepeat(ta, burst) {
    const down = kev('keydown', 'Backspace', 8);
    ta.dispatchEvent(down);
    if (!down.defaultPrevented) edit(ta, 'deleteContentBackward');
    for (let i = 0; i < burst; i += 1) edit(ta, 'deleteContentBackward');
    ta.dispatchEvent(kev('keyup', 'Backspace', 8));
  }

  function replaceSuggestion(ta, start, end, text) {
    return edit(ta, 'insertReplacementText', text, [start, end]);
  }

  function enter(ta) {
    const down = kev('keydown', 'Enter', 13);
    ta.dispatchEvent(down);
    if (!down.defaultPrevented) {
      const press = kev('keypress', 'Enter', 13);
      ta.dispatchEvent(press);
      if (!press.defaultPrevented) edit(ta, 'insertLineBreak');
    }
    ta.dispatchEvent(kev('keyup', 'Enter', 13));
  }

  function caret(ta, index) {
    ta.setSelectionRange(index, index);
    ta.ownerDocument.dispatchEvent(new Event('selectionchange'));
  }

  function composition(ta, type, data = '') {
    ta.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, composed: true }));
  }

  function paste(ta, text) {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    ta.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
  }

  global.IosReplay = Object.freeze({
    kev,
    iev,
    edit,
    capturedEdits,
    typeKey,
    backspace,
    holdDeleteRepeat,
    replaceSuggestion,
    enter,
    caret,
    composition,
    paste,
  });
})(window);
