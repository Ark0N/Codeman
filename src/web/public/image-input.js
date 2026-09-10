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

      const imageFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        this.showToast('Only image files are supported', 'error');
        return;
      }
      this._uploadAndInsertImages(imageFiles);
    });
  },

  // Called from customKeyEventHandler in terminal-ui.js on Ctrl+V keydown.
  // Creates a hidden paste trap, lets the browser paste into it, then inspects
  // the result for images. Works on plain HTTP (no Clipboard API needed).
  _handleImagePaste() {
    const self = this;

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

      // Check for images in clipboard items
      var imageFiles = [];
      var items = e.clipboardData && e.clipboardData.items;
      if (items) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            var blob = items[i].getAsFile();
            if (blob) imageFiles.push(blob);
          }
        }
      }

      // Clean up the trap
      setTimeout(function() {
        if (trap.parentNode) trap.parentNode.removeChild(trap);
        // Refocus the terminal
        if (self.terminal) self.terminal.focus();
      }, 0);

      if (imageFiles.length > 0) {
        self._uploadAndInsertImages(imageFiles);
      } else {
        // No image -- route text through xterm's paste() so bracketed-paste
        // markers (CSI 200~ ... CSI 201~) survive when the inner application
        // has enabled bracketed-paste mode (Claude Code does). Sending text
        // via raw sendInput() strips those markers and makes pasted input
        // indistinguishable from typed input, weakening the CLI's
        // prompt-injection defenses.
        var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (text && self.terminal) self.terminal.paste(text);
      }
    });

    // Trigger the browser's native paste via execCommand
    // (this fires the paste event on our focused trap element)
    document.execCommand('paste');
  },

  // Max images accepted in one batch (paste / drop / mobile picker). Each is
  // uploaded as its own request, so 20 stays under the server's 30 uploads/min
  // rate limit while covering "select a bunch of photos at once".
  _maxBatchImages: 20,
  // How many uploads to run concurrently. Small enough that decoding several
  // large images through <canvas> at once won't OOM a phone, large enough that
  // 20 photos don't crawl through serially.
  _uploadConcurrency: 3,

  async _uploadAndInsertImages(fileList) {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;

    let files = Array.from(fileList || []);
    if (files.length === 0) return;

    // Cap the batch and tell the user what got dropped (no silent truncation).
    let capped = false;
    if (files.length > this._maxBatchImages) {
      files = files.slice(0, this._maxBatchImages);
      capped = true;
    }

    const total = files.length;
    let done = 0;
    let failed = 0;
    const results = new Array(total); // preserve selection order for insertion
    const progress = () =>
      this.showToast(`Uploading ${Math.min(done + 1, total)}/${total} image${total > 1 ? 's' : ''}…`, 'info');
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
    if (paths.length > 0) {
      // Insert all paths in one shot, space-separated, in selection order.
      await this.sendInput(paths.join(' '));
    }

    // Final status: successes, plus any failures / cap so nothing is silent.
    const parts = [];
    if (paths.length > 0) parts.push(`${paths.length} image${paths.length > 1 ? 's' : ''} ready`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (capped) parts.push(`max ${this._maxBatchImages} per batch`);
    const tone = paths.length > 0 ? (failed > 0 || capped ? 'info' : 'success') : 'error';
    this.showToast(parts.join(' · ') || 'No images uploaded', tone);
  },

  async _uploadPasteImage(sessionId, file) {
    const form = new FormData();
    form.append('image', file);

    const resp = await fetch('/api/sessions/' + sessionId + '/paste-image', {
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
    if (file.type === 'image/gif') return file;

    const toPng = file.type === 'image/png';
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
