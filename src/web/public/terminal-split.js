// src/web/public/terminal-split.js

/**
 * @fileoverview Split-pane orchestration: opens a second live session
 * ("Pane B") beside the active one, in a TerminalTile (terminal-tile.js), with
 * a draggable divider, a session picker, and auto-collapse when either
 * session ends. Desktop-only; see docs/split-pane-sessions-plan.md.
 *
 * @dependency terminal-tile.js (window.TerminalTile)
 * @dependency constants.js (window.CodemanSplitPane, SPLIT_PANE_MIN_WIDTH)
 * @loadorder 7.5 of 16, loaded after terminal-tile.js and before respawn-ui.js
 */

Object.assign(CodemanApp.prototype, {
  /**
   * Desktop-only gate, same shape as home-sessions.js's shouldShowHomeSessions
   * + matchMedia backstop: a JS width check (so openSplitPane() below can
   * refuse even if a click somehow reaches the button) plus a live listener,
   * because a window narrowed WHILE the button is showing must hide it
   * without waiting for a settings save or reload. The CSS `@media
   * (max-width: 1179px)` rule in styles.css is the backstop for the reverse
   * direction: it hides the button even if this JS never runs at all.
   */
  _applySplitButtonVisibility(enabled) {
    this._splitButtonSettingEnabled = enabled;
    const splitBtn = document.querySelector('.btn-split');
    const wide = window.innerWidth >= SPLIT_PANE_MIN_WIDTH;
    // Narrowing past the gate must not leave an open split on screen with no
    // way to reach the button that would close it — the two 240px min-widths
    // plus the divider overflow a narrow window and .main clips Pane B's edge.
    if (!wide && this._splitPane) this.closeSplitPane();
    if (!splitBtn) return;
    splitBtn.classList.toggle('btn-split--hidden', !enabled || !wide);
    if (!this._splitButtonWidthListenerInstalled && window.matchMedia) {
      this._splitButtonWidthListenerInstalled = true;
      const mq = window.matchMedia(`(min-width: ${SPLIT_PANE_MIN_WIDTH}px)`);
      mq.addEventListener('change', () => this._applySplitButtonVisibility(this._splitButtonSettingEnabled));
    }
  },

  openSplitPicker(event) {
    // Mirrors toggleRunModeMenu (session-ui.js): stopPropagation on the
    // OPENING click so it never reaches the outside-click listener this
    // same call is about to register — without it, a click landing on the
    // button's own inner <svg> (matched by neither `menu.contains()` nor
    // the old exact-node check below) bubbled straight through to
    // `document` and self-closed the menu it just opened.
    event?.stopPropagation();
    if (this._splitPane) {
      this.closeSplitPane();
      return;
    }
    const candidates = window.CodemanSplitPane.buildSplitPickerSessions(
      this.sessions,
      this.sessionOrder,
      this.activeSessionId,
      this.detachedSessions
    );
    // Route a pre-existing menu through the SAME dismiss path used
    // everywhere else, instead of a raw `.remove()`: a genuinely still-open
    // menu has live document listeners (see below), and a raw removal left
    // them attached forever — only the single-slot field below got
    // overwritten, so every prior pair but the last was orphaned on
    // `document` with no way to ever find and remove it again.
    this._dismissSplitPicker();

    const menu = document.createElement('div');
    menu.id = 'splitPickerMenu';
    menu.className = 'split-picker-menu';
    if (candidates.length === 0) {
      menu.innerHTML = '<div class="split-picker-empty">No other sessions to split with</div>';
    } else {
      menu.innerHTML = candidates
        .map(
          (c) =>
            // data-i18n-skip: the whole row's text IS a session name — i18n.js
            // does exact-string lookup over text nodes, and a session
            // literally named e.g. "Sessions" would otherwise get translated
            // on zh-CN (see the .session-name skip on the pane header below).
            `<button type="button" class="split-picker-item" data-i18n-skip onclick="app.openSplitPane(${escapeHtml(JSON.stringify(c.id))}); app._dismissSplitPicker();">${escapeHtml(c.label)}</button>`
        )
        .join('');
    }
    document.body.appendChild(menu);
    const splitBtn = document.querySelector('.btn-split');
    if (splitBtn) {
      const rect = splitBtn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.right = `${window.innerWidth - rect.right}px`;
    }

    // Dismiss on outside click or Escape — same one-shot listener pattern as
    // session-ui.js's other transient popovers (toggleCaseSettings(),
    // toggleRunModeMenu()). Deferred by a tick so the click that OPENED the
    // menu (still bubbling) doesn't immediately close it — reinforced by
    // the button's own stopPropagation() above, which is what actually
    // stops that same click reaching `document` at all. Picking an item
    // (above) calls the SAME dismiss method, so these listeners never
    // outlive the menu either way.
    //
    // Self-removing by identity: each handler removes ITSELF (and its
    // sibling) the moment it fires, rather than leaning solely on the
    // `this._splitPickerDismissHandlers` field. That field is still kept in
    // sync (so `_dismissSplitPicker()` called from elsewhere — the picker
    // item's onclick above, or a still-open menu at the top of this method
    // — can find and remove the CURRENT pair), but no path here can ever
    // again leave a pair attached to `document` with nothing referencing it.
    const closeOnOutsideClick = (e) => {
      if (menu.contains(e.target) || e.target.closest('.btn-split')) return;
      document.removeEventListener('click', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      this._splitPickerDismissHandlers = null;
      menu.remove();
    };
    const closeOnEscape = (e) => {
      if (e.key !== 'Escape') return;
      document.removeEventListener('click', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      this._splitPickerDismissHandlers = null;
      menu.remove();
    };
    this._splitPickerDismissHandlers = { closeOnOutsideClick, closeOnEscape };
    setTimeout(() => document.addEventListener('click', closeOnOutsideClick), 0);
    document.addEventListener('keydown', closeOnEscape);
  },

  _dismissSplitPicker() {
    document.getElementById('splitPickerMenu')?.remove();
    if (this._splitPickerDismissHandlers) {
      document.removeEventListener('click', this._splitPickerDismissHandlers.closeOnOutsideClick);
      document.removeEventListener('keydown', this._splitPickerDismissHandlers.closeOnEscape);
      this._splitPickerDismissHandlers = null;
    }
  },

  openSplitPane(sessionId) {
    // Desktop-only hard gate, independent of the button's own hidden state —
    // see _applySplitButtonVisibility's comment for why both a JS check and
    // a CSS backstop exist.
    if (window.innerWidth < SPLIT_PANE_MIN_WIDTH) return;
    // No active session means there is no `.terminal-wrap` to split against
    // (the welcome overlay is showing) — without this, a split opened from
    // the home screen still created the container and connected Pane B, just
    // behind the opaque overlay with nothing visible to show for it.
    if (!this.activeSessionId) return;
    // A web tab hides `.terminal-wrap`'s container via CSS with nothing
    // gating the button itself, and `activeSessionId` survives openWebview()
    // — without this, picking a session opens Pane B's socket behind a
    // hidden container with nothing on screen to show for it.
    if (this.activeWebviewId) return;
    // A stale picker click (opened before switching tabs) or clicking Pane
    // B's own session tab while split can otherwise land here with
    // sessionId === activeSessionId: two live WebSockets to the same
    // session, each independently claiming PTY dimensions via its own `{t:'z',...}`
    // resize frame. Refuse before creating any DOM or TerminalTile.
    if (sessionId === this.activeSessionId) return;
    // The picker's own exclusions (buildSplitPickerSessions in constants.js),
    // re-applied here: the menu can sit open while a listed session's CLI
    // exits (pid → null) or gets popped out to its own window, and nothing
    // re-runs the picker filter for a row that already rendered. Same
    // outcome as the picker gives such a session (not offered, silently):
    // one with no PTY has nothing reading its pane, so Pane B would show
    // nothing and drop every keystroke behind a healthy-looking socket, and
    // a detached session's own window already owns its PTY size.
    const session = this.sessions.get(sessionId);
    if (!session || session.pid === null) return;
    if (this.detachedSessions?.has?.(sessionId)) return;
    if (this._splitPane) this.closeSplitPane();

    const wrap = document.querySelector('.terminal-wrap');
    const parent = wrap.parentElement;

    const container = document.createElement('div');
    container.className = 'terminal-split-container';

    const divider = document.createElement('div');
    divider.className = 'split-divider';

    const paneB = document.createElement('div');
    paneB.className = 'terminal-pane-b';
    paneB.innerHTML = `
      <div class="terminal-pane-b-header">
        <span class="session-name">${escapeHtml(session?.name || 'Session')}</span>
        <button type="button" class="terminal-pane-b-close" onclick="app.closeSplitPane()" aria-label="Close split">&times;</button>
      </div>
      <div class="terminal-pane-b-container"></div>
    `;

    parent.insertBefore(container, wrap);
    container.appendChild(wrap);
    wrap.style.flexBasis = '50%';
    container.appendChild(divider);
    container.appendChild(paneB);
    paneB.style.flexBasis = '50%';

    this._splitPane = new window.TerminalTile(sessionId, paneB.querySelector('.terminal-pane-b-container'), {
      mode: session?.mode,
      fontSettings: this.loadAppSettingsFromStorage?.() || {},
      detachedSessions: this.detachedSessions,
    });
    this._splitPane.connect().catch(() => {
      /* Best-effort, matching the primary pane's own tolerance for a failed
         initial load — live output still arrives once/if the socket connects. */
    });
    this._splitSessionId = sessionId;

    // Pane A just went from full width to 50%, but nothing has told its
    // session's PTY/tmux window about it yet — the passive ResizeObserver in
    // terminal-ui.js debounces 300ms and would eventually catch up, but
    // relying on that left the pane showing stale-width content (existing
    // box-drawing lines, banners) until the user hit "Redraw Terminal".
    // Force it immediately, mirroring closeSplitPane()'s symmetric call.
    this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});

    this._installSplitDividerDrag(divider, wrap, paneB);
    this._updateSplitButtonState(true);
  },

  closeSplitPane(options = {}) {
    if (!this._splitPane) return;
    // A split can collapse MID-DRAG (either session ending, the window
    // narrowing past the gate, a click on Pane B's own tab). The drag's own
    // onUp is what normally clears `body.split-pane-resizing` (a col-resize
    // cursor plus user-select:none on EVERY element, styles.css), and it
    // relied on pointer capture routing pointerup back to a divider this
    // method detaches below, so a mid-drag collapse left the whole page
    // locked in resize mode until a reload. Tear the drag down first.
    this._splitDividerDragTeardown?.();
    this._splitDividerDragTeardown = null;
    this._splitPane.destroy();
    this._splitPane = null;
    this._splitSessionId = null;
    this._updateSplitButtonState(false);

    const container = document.querySelector('.terminal-split-container');
    if (!container) return;
    const wrap = container.querySelector('.terminal-wrap');
    const parent = container.parentElement;
    wrap.style.flexBasis = '';
    parent.insertBefore(wrap, container);
    container.remove();

    if (this.fitAddon) this.fitAddon.fit();
    // The Pane-A-ends branch of the _onSessionDeleted wrapper below collapses the split
    // while activeSessionId is still the id the server just removed, so a
    // resize from here would be aimed at a session that no longer exists;
    // the promoted session gets its own resize from selectSession().
    if (!options.skipPrimaryResize) {
      this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});
    }
  },

  // A click on .btn-split does one of two things — open the picker, or
  // (openSplitPicker's own early return) close an already-open split — and
  // nothing on the button said which. `.split-open` + aria-pressed give it
  // the same active-state language as the codebase's other toggle buttons
  // (keyboard-accessory's Ctrl key, the voice-input mic).
  _updateSplitButtonState(open) {
    const btn = document.querySelector('.btn-split');
    if (!btn) return;
    btn.classList.toggle('split-open', open);
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    const title = open ? 'Split: close the second session' : 'Split: open a second session beside this one';
    btn.title = title;
    btn.setAttribute('aria-label', title);
  },

  _installSplitDividerDrag(divider, wrap, paneB) {
    let dragging = false;
    let dragRaf = null;
    let pendingClientX = null;
    let capturedPointerId = null;

    // Local-only reflow (flexBasis + both panes' xterm fit, no PTY resize
    // frame). Coalesced to one call per animation frame below — a raw
    // mousemove stream fires far faster than the browser repaints, and
    // without the rAF gate each event did a full xterm reflow on BOTH
    // panes AND sent Pane B a `{t:'z'}` resize frame (TerminalTile has
    // no client-side "dims unchanged" skip), which fanned out into a
    // `tmux resize-window` child plus a SIGWINCH per frame — roughly fifty
    // of each dragging across half a wide viewport.
    const applyDragPercent = (clientX) => {
      const container = divider.parentElement;
      // The split can auto-collapse mid-drag (the other pane's session
      // ending, or the picker's own close button) — closeSplitPane() removes
      // `.terminal-split-container` from the DOM, which detaches `divider`
      // too, so `divider.parentElement` is null on the very next frame and
      // every drag threw here until mouseup finally removed the listener.
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const rawPercent = ((clientX - rect.left) / rect.width) * 100;
      const percent = window.CodemanSplitPane.clampDividerPercent(rawPercent);
      wrap.style.flexBasis = `${percent}%`;
      paneB.style.flexBasis = `${100 - percent}%`;
      if (this.fitAddon) this.fitAddon.fit();
      this._splitPane?.localFit();
    };

    const onMove = (e) => {
      if (!dragging) return;
      pendingClientX = e.clientX;
      if (dragRaf) return;
      dragRaf = requestAnimationFrame(() => {
        dragRaf = null;
        applyDragPercent(pendingClientX);
      });
    };

    // Everything pointerdown ARMS, undone in one place: the body-level
    // cursor/selection lock, the divider's dragging class, pointer capture,
    // the move/up/cancel listeners and a queued reflow frame. Shared by onUp
    // (a normal drag end) and by closeSplitPane(), via the teardown handle
    // stored below, for a split that collapses mid-drag: the pointerup that
    // would have run onUp is routed by pointer capture to a divider
    // closeSplitPane() has detached, so it never arrives. Idempotent, since
    // the teardown runs whether or not a drag is in progress.
    const endDrag = () => {
      dragging = false;
      divider.classList.remove('dragging');
      document.body.classList.remove('split-pane-resizing');
      if (capturedPointerId !== null) {
        try {
          divider.releasePointerCapture(capturedPointerId);
        } catch {
          /* Already released (pointercancel/lostpointercapture beat us here). */
        }
        capturedPointerId = null;
      }
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
      divider.removeEventListener('pointercancel', onUp);
      if (dragRaf) {
        cancelAnimationFrame(dragRaf);
        dragRaf = null;
      }
    };

    const onUp = () => {
      // A reflow frame still queued at release carries the final pointer
      // position; apply it once, synchronously, so the panes end where the
      // pointer did rather than one frame short.
      const hadQueuedFrame = dragRaf !== null;
      endDrag();
      if (hadQueuedFrame) applyDragPercent(pendingClientX);
      // Send the real PTY resize exactly once here, at drag end, for BOTH
      // panes — never per-move (matching the codebase's established
      // trailing-edge debounce convention, see throttledResize in
      // terminal-ui.js) so a fast drag doesn't flood dozens of intermediate
      // SIGWINCH/reflow states into scrollback or spawn a `tmux
      // resize-window` child per frame.
      this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});
      this._splitPane?.fit();
    };

    // Pointer events + setPointerCapture (mirrors tab-rail-resize.js) instead
    // of mousedown/document-level mousemove: a plain mousedown drag selects
    // the text under the cursor as it crosses both terminals, and pointer
    // capture routes move/up straight to `divider` regardless of what's under
    // the cursor mid-drag, so no document-level listener leak is possible if
    // the pointer is released off-window. `body.split-pane-resizing` (mirrors
    // `body.tab-rail-resizing`) locks the cursor/selection for the drag.
    divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      divider.classList.add('dragging');
      document.body.classList.add('split-pane-resizing');
      try {
        divider.setPointerCapture(e.pointerId);
        capturedPointerId = e.pointerId;
      } catch {
        /* Capture failed — the drag still works via the listeners below. */
      }
      divider.addEventListener('pointermove', onMove);
      divider.addEventListener('pointerup', onUp);
      divider.addEventListener('pointercancel', onUp);
    });
    this._splitDividerDragTeardown = endDrag;
  },
});

const _originalOnSessionDeleted = CodemanApp.prototype._onSessionDeleted;
CodemanApp.prototype._onSessionDeleted = function (data) {
  if (this._splitSessionId === data.id) {
    this.closeSplitPane();
  } else if (this._splitPane && this.activeSessionId === data.id) {
    // Pane A's session ended: promote Pane B by closing the split and
    // selecting its session as the new (single) active pane. This is an
    // app-driven selection, not the user clicking a tab, so it must not
    // spend the promoted session's idle alert (see the Approvals Inbox
    // acknowledgement rule in CLAUDE.md — only a human opening a session
    // acknowledges it).
    const promoted = this._splitSessionId;
    // activeSessionId is still data.id here (the original handler below is
    // what retires it), so closeSplitPane()'s closing resize would be aimed
    // at the session the server just removed. Skip it; selectSession() sizes
    // the promoted session itself.
    this.closeSplitPane({ skipPrimaryResize: true });
    // Closing Pane A's own tab (closeSession(), app.js) adds data.id to
    // _closingSessions BEFORE awaiting the delete, then owns the follow-up
    // selection itself once the delete lands — same race _onSessionDeleted's
    // own active-session handoff guards against (see its comment). Selecting
    // here too would fight it for which tab wins.
    if (promoted && !this._closingSessions.has(data.id)) {
      this.selectSession(promoted, { auto: true });
    }
  }
  return _originalOnSessionDeleted.call(this, data);
};

// I2: closes an active split BEFORE the primary pane rebinds to the same
// session Pane B is showing (clicking Pane B's own session tab while split,
// or any other selectSession() call that targets _splitSessionId). Without
// this, Pane A rebinds to a session that Pane B's independent WebSocket is
// still attached to — two live WebSockets to one session, each claiming PTY
// dimensions via its own `{t:'z',...}` resize frame.
const _originalSelectSession = CodemanApp.prototype.selectSession;
CodemanApp.prototype.selectSession = function (sessionId, ...args) {
  if (this._splitPane && this._splitSessionId === sessionId) {
    this.closeSplitPane();
  }
  return _originalSelectSession.call(this, sessionId, ...args);
};
