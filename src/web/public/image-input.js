/**
 * Image Input Mixin - Clipboard paste and drag-and-drop image support
 *
 * For paste: intercepts Ctrl+V at the xterm keyboard level, creates a temporary
 * hidden contenteditable div ("paste trap"), lets the browser's native paste fill
 * it, then checks for image data. This works on HTTP (no secure context needed).
 *
 * For drag-and-drop: listens on the terminal container for file drops.
 *
 * @dependency app.js (uses global `app` for sendInput, activeSessionId, showToast)
 * @dependency panels-ui.js (provides showToast)
 */

Object.assign(CodemanApp.prototype, {

  initImageInput() {
    // Phone toolbar Attach (index.html): the tap lands on the file INPUT, which
    // sits invisibly over the button, and the browser opens the picker itself.
    //
    // Nothing here may open the picker from script. While the keyboard is up,
    // app.js's keyboard tap shim cancels every touch on a toolbar BUTTON and
    // re-dispatches it as a scripted click, and iOS will not open a file picker
    // from an untrusted click: measured on iOS 17, `isTrusted: false` two
    // milliseconds after pointerdown, no picker, no error, and no real click after
    // it either because the gesture was cancelled. A native tap on the input is not
    // a button tap, so the shim leaves it alone and the click stays trusted. It also
    // anchors the picker popover to the input's own frame (a `hidden` input has
    // none, which is why the composer's picker floated loose).
    //
    // Cancelling mousedown's default keeps focus on the terminal's hidden textarea,
    // so the fixed toolbar never reflows out from under the finger mid-tap.
    //
    // It does NOT keep the keyboard up, and nothing here can: iOS resigns first
    // responder to present the picker, and on DEVICE it does not hand the keyboard
    // back when the picker closes, even though focus never left the textarea.
    // (An iOS 27 simulator does hand it back, which is a simulator artifact, so do
    // not take a keyboard measurement from one.) A blur-then-focus on the close
    // of the picker, cancel and change alike, restores DOM focus and still leaves
    // the keyboard down, because iOS only raises it inside a user gesture. So the
    // user taps the prompt when ready to type, which is the keyboard policy
    // everywhere else in the app.
    //
    // Do not try to hide the keyboard's exit by freezing the page's keyboard
    // state across the picker. That was tried (holdKeyboardState, reverted) to
    // avoid the reflow and the two PTY resizes the hide/show pair costs: with the
    // keyboard gone and the layout still keyboard-sized, the toolbar and accessory
    // bar strand in the MIDDLE of the screen over a dead black band, which is far
    // worse than the reflow. The page must follow the keyboard out.
    const attachBtn = document.getElementById('attachBtnMobile');
    const attachInput = document.getElementById('attachFileInput');
    if (attachBtn && attachInput) {
      attachInput.addEventListener('mousedown', (event) => event.preventDefault());
      // The button is the ACCESSIBLE control (the input is aria-hidden and not
      // tabbable), so a keyboard or VoiceOver activation arrives here instead of on
      // the input. That click is trusted, so opening the picker from it is allowed.
      attachBtn.addEventListener('click', () => attachInput.click());
      attachInput.addEventListener('click', (event) => {
        if (!this.activeSessionId) {
          event.preventDefault(); // refuse before the picker opens, not after a pick
          this.showToast('Open a session to attach a file', 'error');
          return;
        }
        // Captured before the picker opens: the session can be deleted while it is
        // up, and the pick must not land on whatever replaced it.
        this._attachSessionId = this.activeSessionId;
      });
      attachInput.addEventListener('change', () => {
        const files = Array.from(attachInput.files || []);
        // Reset so picking the same file again still fires change.
        attachInput.value = '';
        // Captured when the picker opened (see the click handler above).
        const sessionId = this._attachSessionId;
        this._attachSessionId = null;
        if (files.length > 0) {
          void this._attachFromToolbar(files, sessionId).catch((err) => console.warn('Attach failed:', err));
        }
      });
    }

    // Drag-and-drop handlers on terminal container
    const container = document.getElementById('terminalContainer');
    if (!container) return;

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        container.classList.add('drag-active');
      }
    });

    container.addEventListener('dragleave', (e) => {
      if (!container.contains(e.relatedTarget)) {
        container.classList.remove('drag-active');
      }
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      container.classList.remove('drag-active');

      if (!this.activeSessionId) return;
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;

      const mediaFiles = Array.from(e.dataTransfer.files).filter((f) => this._promptAttachKind(f));
      if (mediaFiles.length === 0) {
        this.showToast('Only image or video files are supported', 'error');
        return;
      }
      this._uploadAndInsertImages(mediaFiles);
    });
  },

  /** Upload the toolbar Attach selection and put the paths on the prompt. The
   *  Compose dialog is deliberately not involved (see initImageInput).
   *
   *  With local echo on (every phone by default) the paths go into the OVERLAY as
   *  pending text rather than to the PTY. That is what makes them part of "what the
   *  user typed": they paint at the prompt, anything typed after them appends in
   *  order, Enter flushes the whole line, and opening Compose adopts path and prose
   *  together (_takePendingLocalEcho reads exactly this buffer). Writing to the PTY
   *  instead would strand the path on the terminal while Compose took only the prose.
   *  Without the overlay (local echo off) there is nothing to buffer into, so the
   *  text goes straight out. The trailing space keeps the next word off the path. */
  async _attachFromToolbar(files, sessionId) {
    const media = files.filter((f) => this._promptAttachKind(f));
    if (media.length === 0) {
      this.showToast('Only image or video files are supported', 'error');
      return;
    }
    if (!sessionId) return; // no captured session: refuse rather than guess at one
    const paths = await this._uploadAndInsertImages(media, { insert: false, sessionId });
    if (paths.length === 0) return;
    // Deleted while the upload ran: a write would go to a dead session, and the
    // flushed maps below would gain an entry whose cleanup has already run.
    if (this.sessions && !this.sessions.has(sessionId)) return;
    const text = paths.join(' ');

    // The prompt composer, if it opened for this session while the upload ran, is
    // where the prompt now lives: it took the terminal's pending text with it, so
    // appending behind it would strand the path outside the text being composed.
    // _insertComposerText adds its own separator and fires the draft save.
    const openComposer = KeyboardAccessoryBar._composerOverlay;
    const composerTextarea =
      openComposer?.isConnected && openComposer.dataset.sessionId === sessionId
        ? openComposer.querySelector('.prompt-composer-textarea')
        : null;
    if (composerTextarea) {
      KeyboardAccessoryBar._insertComposerText(composerTextarea, text);
      return;
    }

    const stillActive = this.activeSessionId === sessionId;
    // The overlay holds the prompt only while local echo actually owns it. A
    // session handed back to plain PTY echo by a composer nav key (echo
    // passthrough) skips the whole overlay branch in onData, Enter included, so
    // text buffered there would sit on screen and never be submitted. Nor while
    // the tile grid owns the terminal area: the main terminal is parked and
    // hidden then, and a tile's Enter never reaches its overlay, so the path
    // goes to the PTY like any other background write.
    const overlayOwnsPrompt =
      stillActive &&
      !this._tilesOwnTerminal?.() &&
      this._localEchoEnabled &&
      this._localEchoOverlay &&
      !this._echoPassthroughSessions?.has(sessionId);
    if (overlayOwnsPrompt) {
      // Prompt text the overlay has not adopted yet (a tab completion, a restored
      // tab) only lands in its flushed half once detection runs, and appendText
      // runs it AFTER we would have measured. Detect first, or the separator is
      // computed against an empty string and the path fuses onto a real word.
      if (!this._localEchoOverlay.pendingText && !this._localEchoOverlay.getFlushed().count) {
        this._localEchoOverlay.detectBufferText();
      }
      const flushed = this._localEchoOverlay.getFlushed().text || '';
      const prompt = flushed + (this._localEchoOverlay.pendingText || '');
      const gap = prompt && !/\s$/.test(prompt) ? ' ' : '';
      this._localEchoOverlay.appendText(gap + text + ' ');
    } else {
      // No buffer to measure, so lead with a separator unconditionally rather than
      // risk fusing onto whatever the CLI's own composer already holds.
      const out = ` ${text} `;
      this._sendInputAsync(sessionId, out);
      // A background session's prompt is tracked in the flushed maps, which is what
      // a later composer open adopts and erases. An untracked write leaves that
      // count short, so the erase would eat the tail of this path instead. Not for
      // a passthrough session: its cursor can sit mid-text, nothing tracks its
      // composer, and Enter there never clears the maps, so a record would offset
      // the overlay for the next prompt instead.
      if (!stillActive && !this._echoPassthroughSessions?.has(sessionId)) {
        if (!this._flushedOffsets) this._flushedOffsets = new Map();
        if (!this._flushedTexts) this._flushedTexts = new Map();
        this._flushedTexts.set(sessionId, (this._flushedTexts.get(sessionId) || '') + out);
        this._flushedOffsets.set(sessionId, (this._flushedOffsets.get(sessionId) || 0) + out.length);
      }
    }
  },

  // Called from customKeyEventHandler in terminal-ui.js on Ctrl+V keydown.
  // Creates a hidden paste trap, lets the browser paste into it, then inspects
  // the result for images. Works on plain HTTP (no Clipboard API needed).
  // `target` names the terminal the Ctrl+V came from and its session; both
  // default to the primary pane. A second terminal (the split pane) passes its
  // own, so text pastes into THAT xterm and images upload to THAT session.
  _handleImagePaste(target = {}) {
    const self = this;
    const terminal = target.terminal || this.terminal;
    const sessionId = target.sessionId || this.activeSessionId;

    // Create a hidden contenteditable div to receive the paste
    const trap = document.createElement('div');
    trap.contentEditable = 'true';
    trap.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;overflow:hidden';
    document.body.appendChild(trap);
    trap.focus();

    // One Ctrl+V can deliver TWO paste events to this trap. The
    // execCommand('paste') below fires one wherever the browser honours that
    // command, and the key's own default action fires another, because xterm's
    // custom key handler returns false without cancelling the keydown. Handling
    // both sends the clipboard text to the PTY twice, which is the "Ctrl+V
    // pastes twice, right-click Paste does not" report: the context-menu paste
    // has no keydown, so it only ever produces one event. The trap therefore
    // accepts the first paste and drops every later one.
    var pasteConsumed = false;

    // Listen for the paste event on our trap
    trap.addEventListener('paste', function(e) {
      e.stopPropagation();
      e.preventDefault();
      if (pasteConsumed) return;
      pasteConsumed = true;

      // Check for images or videos in clipboard items
      var imageFiles = [];
      var items = e.clipboardData && e.clipboardData.items;
      if (items) {
        for (var i = 0; i < items.length; i++) {
          var blob = items[i].getAsFile();
          if (blob && self._promptAttachKind(blob)) imageFiles.push(blob);
        }
      }

      // Clean up the trap
      setTimeout(function() {
        if (trap.parentNode) trap.parentNode.removeChild(trap);
        // Refocus the terminal
        if (terminal) terminal.focus();
      }, 0);

      if (imageFiles.length > 0) {
        self._uploadAndInsertImages(imageFiles, { sessionId: sessionId });
      } else {
        // No image -- route text through xterm's paste() so bracketed-paste
        // markers (CSI 200~ ... CSI 201~) survive when the inner application
        // has enabled bracketed-paste mode (Claude Code does). Sending text
        // via raw sendInput() strips those markers and makes pasted input
        // indistinguishable from typed input, weakening the CLI's
        // prompt-injection defenses.
        var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (text && terminal) terminal.paste(text);
      }
    });

    // Trigger the browser's native paste via execCommand
    // (this fires the paste event on our focused trap element)
    document.execCommand('paste');
  },

  /** What a pick or a paste may upload: 'image', or 'video' for the camera
   *  roll's clips (the server streams those to disk under their own cap), else
   *  null. The one filter behind Attach, drop, the Compose and paste-dialog
   *  pickers and the clipboard handlers. The MIME type decides; some Android
   *  file managers hand over a File with none, so the name's extension is the
   *  fallback, mirroring the server's own allowlists. */
  _promptAttachKind(file) {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    const ext = (file.name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
    return null;
  },

  // Max images accepted in one batch (paste / drop / mobile picker). Each is
  // uploaded as its own request, so 20 stays under the server's 30 uploads/min
  // rate limit while covering "select a bunch of photos at once".
  _maxBatchImages: 20,
  // How many uploads to run concurrently. Small enough that decoding several
  // large images through <canvas> at once won't OOM a phone, large enough that
  // 20 photos don't crawl through serially.
  _uploadConcurrency: 3,

  /** Upload a batch and normally insert its paths into the active terminal.
   *  The prompt composer passes `{ insert: false }` so it can put those paths
   *  into its textarea instead. `options.sessionId` names the session to upload
   *  to (default: the active one). Returns successful paths in selection order. */
  async _uploadAndInsertImages(fileList, options = {}) {
    const sessionId = options.sessionId || this.activeSessionId;
    if (!sessionId) return [];
    if (options.sessionId && this.sessions && !this.sessions.has(sessionId)) return [];

    let files = Array.from(fileList || []);
    if (files.length === 0) return [];

    // Cap the batch and tell the user what got dropped (no silent truncation).
    let capped = false;
    if (files.length > this._maxBatchImages) {
      files = files.slice(0, this._maxBatchImages);
      capped = true;
    }

    const total = files.length;
    let done = 0;
    let failed = 0;
    let failReason = ''; // first server reason, shown in the toast so a failure is not just a count
    const results = new Array(total); // preserve selection order for insertion
    const progress = () =>
      this.showToast(`Uploading ${Math.min(done + 1, total)}/${total} file${total > 1 ? 's' : ''}…`, 'info');
    progress();

    // Bounded-concurrency worker pool over the file list.
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= total) return;
        try {
          // Re-encode to a standard JPEG/PNG (and downscale very large images)
          // before upload. Galleries on some phones (notably Android/MIUI) hand
          // back a WebP/HEIF whose filename and MIME claim "image/jpeg", which
          // passes the server's extension allowlist but fails its magic-byte
          // check. Decoding through the browser and re-encoding guarantees the
          // bytes match the extension we send — and shrinks huge photos so they
          // fit the upload limit and iOS's <canvas> area cap.
          const normalized = await this._normalizeImageForUpload(files[i]);
          results[i] = await this._uploadPasteImage(sessionId, normalized);
        } catch (err) {
          failed++;
          if (!failReason && err && err.message) failReason = err.message;
          console.warn('Image upload failed:', err);
          results[i] = null;
        } finally {
          done++;
          if (done < total) progress();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this._uploadConcurrency, total) }, () => worker()));

    const paths = results.filter(Boolean);
    if (paths.length > 0 && options.insert !== false) {
      // Insert all paths in one shot, space-separated, in selection order, into
      // the session the batch was uploaded TO. Not sendInput(): it re-reads
      // activeSessionId, and after the awaits above that is whatever tab the
      // user switched to mid-upload, so the paths landed in the wrong session.
      // Same delivery sendInput() uses (durable queue, useMux for the POST path).
      this._sendInputAsync(sessionId, paths.join(' '), { useMux: true });
    }

    // Final status: successes, plus any failures / cap so nothing is silent.
    const parts = [];
    if (paths.length > 0) parts.push(`${paths.length} file${paths.length > 1 ? 's' : ''} ready`);
    if (failed > 0) parts.push(failReason ? `${failed} failed: ${failReason}` : `${failed} failed`);
    if (capped) parts.push(`max ${this._maxBatchImages} per batch`);
    const tone = paths.length > 0 ? (failed > 0 || capped ? 'info' : 'success') : 'error';
    this.showToast(parts.join(' · ') || 'No files uploaded', tone);
    return paths;
  },

  async _uploadPasteImage(sessionId, file) {
    const form = new FormData();
    form.append('image', file);

    // A video takes the server's disk-streamed path and its larger cap; the flag
    // has to ride the URL because the size budget is fixed before the part is read.
    const kind = this._promptAttachKind(file) === 'video' ? '?kind=video' : '';
    const resp = await fetch('/api/sessions/' + sessionId + '/paste-image' + kind, {
      method: 'POST',
      body: form,
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || 'HTTP ' + resp.status);
    }

    const data = await resp.json();
    return data.data.path;
  },

  // Decode an image File through the browser and re-encode it to a format the
  // server accepts, so the uploaded bytes always match their declared
  // extension. PNG is re-encoded as PNG (preserves transparency); everything
  // else (JPEG, WebP, HEIF, unknown) becomes JPEG. Animated GIFs are passed
  // through untouched since a canvas would flatten them to one frame. On any
  // decode/encode failure the original file is returned unchanged so the server
  // still gets a chance (and logs a precise diagnostic).
  async _normalizeImageForUpload(file) {
    // Only an image goes through the canvas; a video is uploaded as picked. With no
    // MIME (some Android file managers) the name's extension stands in, as it does in
    // _promptAttachKind, so a .gif keeps its frames and a .png its transparency.
    const name = (file.name || '').toLowerCase();
    const isGif = file.type === 'image/gif' || (!file.type && name.endsWith('.gif'));
    if (this._promptAttachKind(file) !== 'image' || isGif) return file;

    const toPng = file.type === 'image/png' || (!file.type && name.endsWith('.png'));
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode failed'));
        img.src = url;
      });

      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (!width || !height) return file;

      // Downscale very large images. Two reasons: (1) iOS Safari refuses to
      // render a <canvas> larger than ~16.7M px (it returns a blank/null
      // blob), so a 48MP photo would otherwise fail to re-encode and fall back
      // to the original — which then trips the server's magic-byte check for
      // HEIF mislabeled as JPEG. (2) It keeps multi-photo uploads fast and well
      // under the size limit. Cap the longest edge so area stays safely below
      // the canvas limit while still uploading a large, high-quality image.
      const MAX_EDGE = 4096;
      const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.drawImage(img, 0, 0, w, h);

      const mime = toPng ? 'image/png' : 'image/jpeg';
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.92));
      if (!blob) return file;

      const baseName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
      return new File([blob], baseName + (toPng ? '.png' : '.jpg'), { type: mime });
    } catch (err) {
      console.warn('Image re-encode failed, uploading original:', err);
      return file;
    } finally {
      URL.revokeObjectURL(url);
    }
  },

});
