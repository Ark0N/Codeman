/**
 * @fileoverview In-terminal preview of IME composition text on iOS Safari.
 *
 * On iOS WebKit touch devices the text an IME is composing (Japanese, Chinese,
 * Korean, dictation) is not visible inside the terminal until it commits, so
 * the user types blind. The controller listens to the helper textarea's
 * composition events and asks the caller to render the latest composition
 * (`phase: 'provisional'`), coalesced to one render per animation frame and
 * capped at 2048 characters. When xterm emits the committed text through
 * onData, the caller hands it to `consumeTerminalData()`, which switches the
 * preview to `phase: 'committed'` until something else shows the text: the
 * local echo overlay or a prediction (`completeCommit`), authoritative
 * terminal output (`noteAuthoritativeOutput`), or a 2 s fallback timer.
 *
 * VISUAL ONLY: the controller never sends, consumes or reorders input bytes,
 * and every callback is wrapped so a failing render cannot block the wire.
 * `isIosWebKitTouch()` gates creation; other platforms keep xterm's own
 * composition view untouched.
 *
 * @dependency none (standalone IIFE; consumed by terminal-ui.js)
 * @loadorder 5.52 (before app.js/terminal-ui.js, which create the controller)
 */
(function (global) {
  'use strict';

  const COMMITTED_VISUAL_TTL = 2000;
  const PREVIEW_CAP = 2048;
  const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

  function isIosWebKitTouch(nav = navigator) {
    const userAgent = String(nav && nav.userAgent ? nav.userAgent : '');
    const platform = String(nav && nav.platform ? nav.platform : '');
    const touchPoints = Number(nav && nav.maxTouchPoints ? nav.maxTouchPoints : 0);
    const iosDevice = /iPhone|iPad|iPod/.test(userAgent);
    const desktopIpad = platform === 'MacIntel' && touchPoints > 1;
    return touchPoints > 0 && /AppleWebKit/.test(userAgent) && (iosDevice || desktopIpad);
  }

  function create(options) {
    const textarea = options.textarea;
    const render = typeof options.render === 'function' ? options.render : function () {};
    const clear = typeof options.clear === 'function' ? options.clear : function () {};
    const onCommit = typeof options.onCommit === 'function' ? options.onCommit : function () {};
    const scheduleFrame = options.scheduleFrame || global.requestAnimationFrame.bind(global);
    const cancelFrame = options.cancelFrame || global.cancelAnimationFrame.bind(global);
    const setTimer = options.setTimer || global.setTimeout.bind(global);
    const clearTimer = options.clearTimer || global.clearTimeout.bind(global);

    let generation = 0;
    let composing = false;
    let awaitingCommit = false;
    let committed = false;
    let latestValue = '';
    let renderPhase = null;
    let frameToken = null;
    let timerToken = null;
    let finalizedByKeydown = false;
    let destroyed = false;
    let invokingClear = false;

    function safely(callback, ...args) {
      try {
        return callback(...args);
      } catch (_error) {
        return undefined;
      }
    }

    function cancelScheduledFrame() {
      const token = frameToken;
      frameToken = null;
      if (token && token.id !== undefined) safely(cancelFrame, token.id);
    }

    function cancelCommittedTimer() {
      const token = timerToken;
      timerToken = null;
      if (token && token.id !== undefined) safely(clearTimer, token.id);
    }

    function clearVisual() {
      if (invokingClear) return;
      invokingClear = true;
      safely(clear);
      invokingClear = false;
    }

    function cleanup() {
      generation += 1;
      cancelScheduledFrame();
      cancelCommittedTimer();
      composing = false;
      awaitingCommit = false;
      committed = false;
      latestValue = '';
      renderPhase = null;
      finalizedByKeydown = false;
      clearVisual();
    }

    function scheduleLatestPreview(phase) {
      if (destroyed) return;
      renderPhase = phase;
      if (frameToken) return;
      const token = { generation, id: undefined };
      frameToken = token;
      const callback = function () {
        if (destroyed || frameToken !== token || token.generation !== generation || renderPhase === null) return;
        frameToken = null;
        const value = latestValue.slice(0, PREVIEW_CAP);
        const phaseToRender = renderPhase;
        safely(render, { text: value, phase: phaseToRender });
      };
      const id = safely(scheduleFrame, callback);
      if (frameToken === token) {
        if (id === undefined) frameToken = null;
        else token.id = id;
      }
    }

    function beginComposition() {
      cleanup();
      if (destroyed) return;
      composing = true;
    }

    function updateComposition(event) {
      if (!composing) return;
      latestValue = event.data == null ? '' : String(event.data);
      scheduleLatestPreview('provisional');
    }

    function onComposingInput(event) {
      if (!event.isComposing) return;
      updateComposition({ data: event.data == null ? textarea.value : event.data });
    }

    function finalizeComposition(value, fromKeydown) {
      if (!composing) return;
      composing = false;
      awaitingCommit = true;
      committed = false;
      finalizedByKeydown = fromKeydown;
      latestValue = value == null ? latestValue : String(value);
      scheduleLatestPreview('provisional');
    }

    function onCompositionEnd(event) {
      if (finalizedByKeydown) {
        finalizedByKeydown = false;
        return;
      }
      finalizeComposition(event.data, false);
    }

    function onKeydown(event) {
      if (composing && event.isComposing === false && event.key !== 'Process' && event.key !== 'Unidentified') {
        finalizeComposition(latestValue, true);
      }
    }

    function reset() {
      if (destroyed) return;
      cleanup();
    }

    function consumeTerminalData(data) {
      if (
        destroyed ||
        !awaitingCommit ||
        typeof data !== 'string' ||
        data.length === 0 ||
        CONTROL_OR_LINE_BREAK.test(data)
      ) {
        return false;
      }

      generation += 1;
      const owner = generation;
      cancelScheduledFrame();
      cancelCommittedTimer();
      composing = false;
      awaitingCommit = false;
      committed = true;
      latestValue = data;
      renderPhase = 'committed';
      safely(onCommit, data);
      if (destroyed || generation !== owner || !committed) return true;

      scheduleLatestPreview('committed');
      if (destroyed || generation !== owner || !committed) return true;

      const token = { generation, id: undefined };
      timerToken = token;
      const callback = function () {
        if (destroyed || timerToken !== token || token.generation !== generation || !committed) return;
        timerToken = null;
        cleanup();
      };
      const id = safely(setTimer, callback, COMMITTED_VISUAL_TTL);
      if (timerToken === token) {
        if (id === undefined) {
          timerToken = null;
          if (!destroyed && generation === owner && committed) cleanup();
        } else {
          token.id = id;
        }
      }
      return true;
    }

    function completeCommit(result) {
      if (destroyed || !result || result.predicted !== true || !committed) return;
      cleanup();
    }

    function noteAuthoritativeOutput() {
      if (destroyed || !committed) return;
      cleanup();
    }

    const listeners = [
      ['compositionstart', beginComposition],
      ['compositionupdate', updateComposition],
      ['input', onComposingInput],
      ['compositionend', onCompositionEnd],
      ['keydown', onKeydown, true],
      ['blur', reset],
    ];
    for (const [type, listener, capture] of listeners) textarea.addEventListener(type, listener, capture);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const [type, listener, capture] of listeners) textarea.removeEventListener(type, listener, capture);
      cleanup();
    }

    return {
      consumeTerminalData,
      completeCommit,
      noteAuthoritativeOutput,
      reset,
      destroy,
      get state() {
        return {
          generation,
          composing,
          awaitingCommit,
          committed,
          latest: latestValue,
          framePending: frameToken !== null,
          timerPending: timerToken !== null,
        };
      },
    };
  }

  global.MobileImePreview = { create, isIosWebKitTouch };
})(globalThis);
