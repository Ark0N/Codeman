// src/web/public/terminal-split.js

/**
 * @fileoverview SplitTerminalPane — a second, independent live terminal pane
 * ("Pane B") for split-view sessions. Deliberately plainer than the primary
 * pane (this.terminal/this._ws in terminal-ui.js): no local-echo overlay, no
 * CJK IME, no touch/mobile handlers, no keyboard accessory bar. Desktop-only
 * feature by nature — see docs/split-pane-sessions-plan.md.
 *
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js
 * @dependency constants.js (window.CodemanTerminalFont, DEFAULT_SCROLLBACK, TERMINAL_TAIL_SIZE, TERMINAL_CHUNK_SIZE)
 * @dependency terminal-ui.js (codemanCurrentXtermTheme, codemanCurrentSkinIsLight)
 * @loadorder 7.5 of 16 — loaded after terminal-ui.js, before respawn-ui.js
 */

(function (global) {
  /**
   * Minimal chunked write for Pane B's own xterm instance — write() in
   * TERMINAL_CHUNK_SIZE slices, yielding a frame between each, instead of one
   * giant synchronous write that blocks the main thread while parsing a long
   * scrollback. Deliberately NOT the primary pane's chunkedTerminalWrite
   * (terminal-ui.js): that one is wired into session-switch generation
   * counters and the live-output gate this simpler, independently
   * created/destroyed pane has no equivalent of.
   */
  function writeChunked(terminal, buffer, isDestroyed) {
    if (!buffer) return Promise.resolve();
    if (buffer.length <= TERMINAL_CHUNK_SIZE) {
      terminal.write(buffer);
      return Promise.resolve();
    }
    // Resolves once the LAST chunk is written (or the pane was destroyed
    // mid-replay), so _loadBuffer() below can hold its single-flight flag
    // across the whole replay rather than just the fetch that precedes it.
    return new Promise((resolve) => {
      let offset = 0;
      const writeNext = () => {
        if (isDestroyed() || !terminal) {
          resolve();
          return;
        }
        const chunk = buffer.slice(offset, offset + TERMINAL_CHUNK_SIZE);
        offset += chunk.length;
        terminal.write(chunk);
        if (offset < buffer.length) {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(writeNext);
          else setTimeout(writeNext, 16);
        } else {
          resolve();
        }
      };
      writeNext();
    });
  }

  class SplitTerminalPane {
    constructor(sessionId, mountEl, opts = {}) {
      this.sessionId = sessionId;
      this.mountEl = mountEl;
      this.sessionMode = opts.mode;
      this.fontSettings = opts.fontSettings || {};
      // Live reference (not a snapshot) to the app's detachedSessions Set —
      // detaching this session AFTER the split is already open must still be
      // seen by _sendResize() below, or it re-creates the exact PTY-size
      // fight the split picker already refuses to open at pick time.
      this.detachedSessions = opts.detachedSessions;
      this.terminal = null;
      this.fitAddon = null;
      this.ws = null;
      this._wsReady = false;
      this._destroyed = false;
      // Single-flight state for _loadBuffer()/_refreshBuffer() below.
      this._bufferLoading = false;
      this._bufferRefreshPending = false;
    }

    async connect() {
      const savedFontSize = parseInt(localStorage.getItem('codeman-font-size'), 10);
      this.terminal = new Terminal({
        theme: { ...global.codemanCurrentXtermTheme() },
        fontFamily: global.CodemanTerminalFont.resolve(this.fontSettings.terminalFontFamily),
        ...global.CodemanTerminalFont.resolveWeights(this.fontSettings),
        fontSize: Number.isFinite(savedFontSize) ? savedFontSize : 14,
        lineHeight: 1.2,
        cursorBlink: false,
        cursorStyle: 'block',
        minimumContrastRatio: global.codemanCurrentSkinIsLight() ? 4.5 : 1,
        scrollback: DEFAULT_SCROLLBACK,
        allowTransparency: true,
        allowProposedApi: true,
      });

      this.fitAddon = new FitAddon.FitAddon();
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.open(this.mountEl);
      this.fitAddon.fit();

      this.terminal.onData((data) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ t: 'i', d: data }));
        }
      });

      // Pane B has no gates of its own by default, so every app-level chord
      // that the document capture-phase handler (app.js) only preventDefault()s
      // — never stopPropagation()s — reaches xterm here too and writes its raw
      // byte/escape sequence into THIS session's PTY on top of whatever the app
      // action already did to Pane A (COD-153; mirrors the primary pane's own
      // gates at terminal-ui.js's attachCustomKeyEventHandler: command palette,
      // Alt+1-9/[/] tab nav, Alt+B sidebar toggle, Ctrl+Z suspend, Shift/Ctrl+Enter
      // newline, and smart-copy Ctrl+C/Ctrl+Shift+C). Routed through the same
      // registry-aware predicates so a rebind or a disable restores plain
      // terminal behavior here too. Ctrl+V is deliberately left on xterm's own
      // default (plain-text paste): Pane B has no image-paste trap to route it
      // to, so intercepting it here would only break paste.
      this.terminal.attachCustomKeyEventHandler((ev) => {
        if (ev.isComposing || ev.key === 'Process' || ev.keyCode === 229) return true;
        if (
          ev.altKey &&
          !ev.ctrlKey &&
          !ev.shiftKey &&
          /^(Digit[1-9]|BracketLeft|BracketRight|KeyK)$/.test(ev.code || '')
        ) {
          return false;
        }
        if (ev.type === 'keydown' && global.app?.shouldOpenCommandPaletteFromShortcut?.(ev)) {
          return false;
        }
        if (ev.type === 'keydown' && global.app?.shouldToggleSessionSidebarFromShortcut?.(ev)) {
          return false;
        }
        // Ctrl+Z (SIGTSTP/job-control suspend): mirrors terminal-ui.js's own
        // swallow — in a plain shell session this is the user's own
        // job-control tool and must reach the PTY, but in every other mode
        // (claude/omp/pi/codex/...) it silently stops an unattended agent
        // loop dead. Pane B has its own PTY/session and must not send a
        // suspend into a non-shell one just because the primary pane's own
        // gate lives elsewhere.
        if (
          ev.type === 'keydown' &&
          ev.key.toLowerCase() === 'z' &&
          ev.ctrlKey &&
          !ev.altKey &&
          !ev.metaKey &&
          !ev.shiftKey &&
          this.sessionMode !== 'shell'
        ) {
          return false;
        }
        // Shift+Enter / Ctrl+Enter: insert a newline instead of submitting.
        // Mirrors terminal-ui.js's own handling — xterm sends plain \r for
        // every Enter variant, so an Ink app (Claude Code) can't tell a
        // newline from a submit. Without this gate, Pane B's onData would
        // send that bare \r straight over the WS and submit an incomplete
        // prompt instead of adding a line to it. Targets THIS pane's own
        // session (this.sessionId), never the primary pane's
        // activeSessionId, and has no local-echo overlay of its own to flush
        // first (Pane B is deliberately plainer — see the fileoverview).
        if (ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey) && ev.type === 'keydown') {
          fetch(`/api/sessions/${this.sessionId}/send-key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: ev.ctrlKey ? 'C-Enter' : 'S-Enter' }),
          }).catch(() => {
            /* Best-effort, matching this pane's tolerance elsewhere. */
          });
          return false;
        }
        // Smart copy (mirrors terminal-ui.js's Ctrl+C gate, #211): with a
        // selection, Ctrl+C copies THIS pane's own selection instead of
        // sending ^C; with none, plain Ctrl+C must fall through unchanged or
        // the interrupt key is lost. Ctrl+Shift+C is different: it is the
        // explicit, never-falls-through copy chord, and the predicate above
        // does not distinguish it from plain Ctrl+C — ev.shiftKey does, below.
        // xterm's own evaluateKeyboardEvent routes a shifted ctrl-letter into
        // a branch that assigns c.key only for a couple of special cases
        // ("_"->US, "@"->NUL), neither of which is "c", so it emits NOTHING
        // for Ctrl+Shift+C either way — this is not about an accidental
        // interrupt byte reaching the PTY (verified live: it does not).
        // Gating this whole block on hasSelection() (an earlier draft) meant
        // that with no selection Ctrl+Shift+C skipped straight to `return
        // true`, silently ceding the keystroke to the BROWSER's own handling
        // (e.g. Chrome's Inspect-Element binding) with no feedback and no
        // attempt to copy, unlike Pane A, which always intercepts it.
        // Re-implemented against this.terminal rather than reusing
        // app.copyTerminalSelection(), which reads app.terminal — Pane A's —
        // and would copy the wrong pane's selection.
        if (ev.type === 'keydown' && global.app?.shouldCopyTerminalSelectionFromShortcut?.(ev)) {
          const raw = this.terminal?.getSelection?.() || '';
          const isColumnSelection = this.terminal?._core?._selectionService?._activeSelectionMode === 3;
          // Both clean options are read for THIS pane, never the primary one:
          // the gutter width comes from this.sessionId's own run mode, and the
          // partial-first-line flag from this terminal's own selection range.
          // Passing neither left Pane B keeping a margin Pane A dropped, on the
          // same split and the same keystroke.
          const range = global.app?._normalisedSelectionRange?.(this.terminal);
          const selection = isColumnSelection
            ? raw
            : (global.CodemanCopySelection?.clean?.(raw, {
                margin: global.app?._cliGutterColumns?.(this.sessionId) ?? 0,
                firstLinePartial: !!range && range.start.x > 0,
              }) ?? raw);
          if (selection.trim()) {
            ev.preventDefault();
            void global.app._copyText?.(selection).then((ok) => {
              this.terminal?.clearSelection?.();
              global.app.showToast?.(ok ? 'Copied to clipboard' : 'Failed to copy', ok ? 'success' : 'error');
            });
            return false;
          }
          // Nothing worth copying — clear for feedback (a padding-only
          // selection cleans to '' and this press still falls through to the
          // PTY as 0x03, matching the primary pane's own rule).
          if (this.terminal?.hasSelection?.()) {
            this.terminal.clearSelection?.();
            global.app.showToast?.('Nothing to copy', 'warning');
          }
          // Ctrl+Shift+C never falls through, even with nothing to copy —
          // matches terminal-ui.js's own ev.shiftKey branch.
          if (ev.shiftKey) {
            ev.preventDefault();
            return false;
          }
        }
        return true;
      });

      // Load existing scrollback before going live. The WS below is
      // subscribe-only (ws-routes.ts sends nothing on connect, only future
      // 'terminal' events), so without this Pane B stays blank until the
      // target session happens to produce new output. It LOOKED
      // intermittent rather than always-broken because _sendResize() below
      // often nudges the shared session's real tmux window to a new size,
      // and tmux repaints its current screen on resize — that repaint was
      // getting captured and streamed here, incidentally populating the
      // pane. When Pane B's computed dimensions happened to already match
      // the session's last-known size, Session.resize() (session.ts) skips
      // the resize as a no-op, no repaint fires, and the pane stayed blank.
      // The await covers the whole chunked replay, not just the fetch, so a
      // live frame from the socket below can never land in the middle of it.
      await this._loadBuffer();
      if (this._destroyed) return;

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}${window.CodemanBase.base}/ws/sessions/${this.sessionId}/terminal`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this._wsReady = true;
        this._sendResize();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.t === 'o') {
            this.terminal.write(msg.d);
          } else if (msg.t === 'c') {
            this.terminal.clear();
          } else if (msg.t === 'r') {
            // Server-triggered refresh (SSE backpressure cleared, terminal
            // data was dropped). The primary pane routes this to
            // _onSessionNeedsRefresh (app.js:2990) — Pane B has its own
            // buffer loader for the same reason connect() does.
            this._refreshBuffer();
          }
        } catch {
          /* Malformed frame — ignore, matches primary pane's tolerance. */
        }
      };

      // Mirror app.js's onclose/onerror pattern (app.js:2905-2964): _wsReady
      // must go false on a drop or fit()/_sendResize() silently no-ops on a
      // closed socket per the WebSocket spec (no exception, no log). No
      // reconnect logic here — Pane B is deliberately plainer than the
      // primary pane (see the fileoverview above); a drop just stops
      // resizing until the parent recreates the pane. But onData already
      // silently drops keystrokes while _wsReady is false (below), so
      // without a visible marker a dropped socket left Pane B looking
      // normal while it quietly ate everything typed into it. v1 scope is
      // "say so", not reconnect — collapsing the split would lose the
      // user's place in Pane B's scrollback for a transient blip.
      this.ws.onclose = () => {
        this._wsReady = false;
        this.terminal?.write('\r\n\x1b[2m[Pane B disconnected — close and reopen the split to reconnect]\x1b[0m\r\n');
      };

      this.ws.onerror = () => {
        // onclose fires after onerror — cleanup happens there.
      };
    }

    // Fetches and writes the session's current scrollback. Used both by
    // connect() (initial load) and by the `{t:'r'}` server-refresh frame
    // (below) — the primary pane's own _onSessionNeedsRefresh (app.js) is
    // scoped to `this.activeSessionId` and clears/rewrites the primary
    // terminal, neither of which applies to this independent pane, so this is
    // a standalone equivalent rather than a call into it.
    //
    // Mirrors the primary pane's own mode check (app.js's selectSession /
    // _onSessionNeedsRefresh): a shell session can retain hundreds of
    // thousands of plain scrollback lines, so pulling `?full=1` there parses
    // an unbounded, server-capped (up to terminalBufferMaxBytes, 32MB) body
    // into a 50000-line xterm on every load. Non-shell (TUI) sessions still
    // get one full replay. `fetch` here goes through the global wrapper
    // (constants.js), which already prefixes CodemanBase — unlike the raw
    // WebSocket URL above, which does not.
    //
    // Single-flight: the flag is held across the fetch AND the chunked write
    // (writeChunked resolves after its last chunk), so two replays can never
    // interleave their chunks into one terminal. A second call while one is
    // in flight is dropped here; _refreshBuffer() is the caller that queues
    // a trailing re-run instead.
    async _loadBuffer() {
      if (this._bufferLoading) return;
      this._bufferLoading = true;
      try {
        const query = this.sessionMode === 'shell' ? `tail=${TERMINAL_TAIL_SIZE}` : 'full=1';
        const res = await fetch(`/api/sessions/${this.sessionId}/terminal?${query}`);
        const payload = (await res.json())?.data ?? {};
        if (payload.terminalBuffer && this.terminal) {
          await writeChunked(this.terminal, payload.terminalBuffer, () => this._destroyed);
        }
      } catch {
        /* Best-effort — live output still arrives once the socket connects. */
      } finally {
        this._bufferLoading = false;
      }
      if (this._bufferRefreshPending && !this._destroyed) {
        this._bufferRefreshPending = false;
        this._refreshBuffer();
      }
    }

    // The `{t:'r'}` server-refresh path: clear, then replay. Two refresh
    // frames in a row used to start two concurrent replays, each clearing
    // the terminal under the other's chunked write. A refresh that arrives
    // mid-replay is COALESCED into one trailing re-run rather than ignored:
    // the in-flight fetch may predate the drop the new frame is reporting,
    // and no further frame is coming to correct stale content.
    _refreshBuffer() {
      if (this._bufferLoading) {
        this._bufferRefreshPending = true;
        return;
      }
      this.terminal?.clear();
      void this._loadBuffer();
    }

    // Local reflow only — no PTY resize frame. Split out so a divider drag
    // can reflow both panes at the browser's paint rate (rAF) while sending
    // the actual `{t:'z'}` resize once, at drag end, matching the primary
    // pane's own convention (throttledResize in terminal-ui.js).
    localFit() {
      if (!this.fitAddon) return;
      this.fitAddon.fit();
    }

    fit() {
      this.localFit();
      this._sendResize();
    }

    _sendResize() {
      if (!this._wsReady || !this.fitAddon) return;
      // One PTY cannot hold two sizes (mirrors sendResize's own
      // detachedElsewhere yield in terminal-ui.js): the session got detached
      // to its own window AFTER this split was opened, so its own window now
      // owns the PTY's size and Pane B must stand aside.
      if (this.detachedSessions?.has(this.sessionId)) return;
      const dims = this.fitAddon.proposeDimensions();
      if (!dims) return;
      // Send the real proposed dimensions unclamped, matching the primary
      // pane's convention (terminal-ui.js's getTerminalDimensions()) — the
      // server enforces its own valid range ([1,500]/[1,200] in ws-routes.ts).
      // A 40/10 floor here misreported Pane B's real width to the PTY at the
      // divider's own reachable 20% floor position, causing real
      // output-wrapping bugs.
      this.ws.send(JSON.stringify({ t: 'z', c: dims.cols, r: dims.rows, v: 'desktop' }));
    }

    destroy() {
      this._destroyed = true;
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        // onclose fires asynchronously AFTER close(); without this it ran
        // its "disconnected" write against a pane already torn down.
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
        this.ws = null;
      }
      if (this.terminal) {
        this.terminal.dispose();
        this.terminal = null;
      }
      this.fitAddon = null;
    }
  }

  global.SplitTerminalPane = SplitTerminalPane;
})(window);

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
    // resize frame. Refuse before creating any DOM or SplitTerminalPane.
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

    this._splitPane = new window.SplitTerminalPane(sessionId, paneB.querySelector('.terminal-pane-b-container'), {
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
    // panes AND sent Pane B a `{t:'z'}` resize frame (SplitTerminalPane has
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
