// src/web/public/terminal-tile.js

/**
 * @fileoverview TerminalTile: one independent live terminal pane bound to one
 * session, with its own xterm instance and its own
 * `/ws/sessions/:id/terminal` WebSocket. The split pane (terminal-split.js)
 * uses one as its second pane ("Pane B"); the tile grid (tile-grid.js,
 * docs/tile-grid-plan.md) uses one per tile, and feeds every capture they
 * fetch through ONE TileLoadQueue (below), because each capture is a
 * synchronous tmux call that blocks the server's event loop.
 *
 * Deliberately plainer than the primary pane (this.terminal/this._ws in
 * terminal-ui.js): no local-echo overlay, no CJK IME textarea, no touch/mobile
 * handlers (a swipe on a touch screen pages nothing), and no keyboard
 * accessory bar. Built for wide screens; see docs/split-pane-sessions-plan.md
 * and docs/tile-grid-plan.md.
 *
 * What it does carry over from the primary pane, through the primary pane's
 * own code aimed at THIS pane (its terminal, its session, never the active
 * one):
 *  - SGR wheel forwarding (_maybeForwardWheelToCli): Claude's fullscreen
 *    renderer scrolls its own transcript on SGR wheel reports, while this
 *    xterm holds only replayed repaint frames, so the wheel goes to the CLI
 *    as reports at the pointer's cell in this pane, through the primary
 *    pane's forwarding gate and its encoding (sgrWheelReports). Shift+wheel
 *    scrolls the local scrollback itself (_maybeScrollLocalOnShift), as the
 *    primary pane does, since xterm turns it into a horizontal no-op.
 *  - Hollow-buffer paging (#555): a CLI that draws in place (opencode on the
 *    alternate screen, Claude's repaint mode) leaves the xterm no scrollback,
 *    so the wheel pages the CLI's own transcript with PageUp/PageDown
 *    (_maybePageCliTranscript) through the primary pane's gates, plus an
 *    overflow-row discount for this pane's capture-before-resize load
 *    (_localRows), and only while the viewport is on the live screen (a
 *    wheel-down from those overflow rows is xterm's, and brings it home).
 *  - The desktop click report: a plain left-click hand-encoded as SGR while
 *    the session's CLI has mouse tracking on (cliMouseTracking), for the modes
 *    whose mouse DECSETs the server strips (_installClickListener), sent
 *    ephemeral, like every mouse report from this pane (_onTerminalData).
 *  - The soft-keyboard controller (terminal-keycode229-recovery.js), one per
 *    pane, on this pane's own textarea and composition helper and sending to
 *    this pane's session (_createKeyCode229Recovery): it forwards an
 *    `insertText` xterm refused, settles a pending textarea edit at the next
 *    keydown ahead of that key (#441: the last character an Android keyboard
 *    commits in the same task as Enter), and replaces xterm's append-only
 *    keyCode-229 diff with an edit-based one (#541: autocorrect on space
 *    duplicated the line). Not a desktop-only concern: the grid and the split
 *    are gated on width alone (SPLIT_PANE_MIN_WIDTH, 1180 CSS px), which a wide
 *    Android tablet, or a large foldable unfolded in landscape, reaches.
 *
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js
 * @dependency constants.js (window.CodemanTerminalFont, window.CodemanFetchDeadline, DEFAULT_SCROLLBACK, TERMINAL_TAIL_SIZE, TERMINAL_CHUNK_SIZE)
 * @dependency terminal-ui.js (codemanCurrentXtermTheme, codemanCurrentSkinIsLight, CodemanTerminalInput.shouldSuppressTerminalQueryResponse/isTerminalFocusOrMouseReport/wheelDeltaLines/wheelDeltaWholeLines/sgrWheelReports/pageKeysForTravel, app._shouldForwardWheelToApp/_localScrollbackIsHollow/_terminalViewportAtBottom/_clientPointToCell/_handleDesktopTerminalClick)
 * @dependency terminal-keycode229-recovery.js (window.CodemanKeyCode229Recovery, optional: absent, xterm's own textarea handling stands)
 * @loadorder 7.4 of 16, loaded after terminal-ui.js and before terminal-split.js
 */

(function (global) {
  // How long a load may hold this pane's live output while it reads a bounded
  // body: a scroll-to-top history pull, or a refresh of a bounded window.
  const HISTORY_PULL_TIMEOUT_MS = 10000;

  // How much of a replay is queued in xterm at once: a 1 MiB load goes in one
  // window, and xterm's write queue throws past 50 MB, which an unbounded
  // `full=1` capture (up to the server's 32 MB) would otherwise come near.
  const REPLAY_WINDOW_BYTES = 1024 * 1024;

  /**
   * Replays a capture into a pane's own xterm: TERMINAL_CHUNK_SIZE slices, all
   * of a window queued at once. xterm 6 parses its write queue in 12 ms slices
   * and yields between them, so a long scrollback never becomes a long task,
   * and it is not held to one slice per animation frame either (that pacing
   * took about a second per 1 MiB, with the grid's load queue waiting behind
   * it). Queued up front, the capture also stays in one piece: live output
   * written during the parse lands after it, not between two of its slices.
   * Deliberately NOT the primary pane's chunkedTerminalWrite (terminal-ui.js):
   * that one is wired into session-switch generation counters and the
   * live-output gate this simpler, independently created/destroyed pane has no
   * equivalent of.
   *
   * Resolves once xterm has parsed the last slice (a write's callback runs once
   * everything queued before it is parsed), so _loadBuffer() below holds its
   * single-flight flag across the whole replay. A disposed xterm never runs its
   * callbacks, so `setCancel` hands the owner a function that settles the
   * replay at once: destroy() calls it, or the pane's flag and the grid's load
   * queue would wait forever.
   */
  function writeChunked(terminal, buffer, isDestroyed, setCancel) {
    if (!buffer || !terminal) return Promise.resolve();
    return new Promise((resolve) => {
      let offset = 0;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        setCancel?.(null);
        resolve();
      };
      const writeWindow = () => {
        if (settled) return;
        if (isDestroyed()) {
          settle();
          return;
        }
        const end = Math.min(buffer.length, offset + REPLAY_WINDOW_BYTES);
        while (offset < end) {
          const chunk = buffer.slice(offset, Math.min(end, offset + TERMINAL_CHUNK_SIZE));
          offset += chunk.length;
          terminal.write(chunk);
        }
        terminal.write('', offset < buffer.length ? writeWindow : settle);
      };
      setCancel?.(settle);
      writeWindow();
    });
  }

  class TerminalTile {
    constructor(sessionId, mountEl, opts = {}) {
      this.sessionId = sessionId;
      this.mountEl = mountEl;
      this.sessionMode = opts.mode;
      this.fontSettings = opts.fontSettings || {};
      // Live reference (not a snapshot) to the app's detachedSessions Set:
      // detaching this session AFTER the pane opened must still be seen by
      // _sendResize() below, or this pane and the session's own window fight
      // over the PTY's size (which the split picker refuses at pick time).
      this.detachedSessions = opts.detachedSessions;
      // Lines of scrollback this pane's xterm keeps (the grid passes its smaller
      // TILE_SCROLLBACK) and its font size (the grid's own tile font); absent,
      // the primary pane's values.
      this.scrollback = Number.isFinite(opts.scrollback) ? opts.scrollback : null;
      this.fontSize = Number.isFinite(opts.fontSize) ? opts.fontSize : null;
      // `scheduleLoad(tile, kind, run)` runs every capture this pane fetches
      // (`kind`: 'initial', 'refresh' or 'history') when its owner says so, and
      // resolves once `run` has finished or was dropped. The grid passes its one
      // queue so N tiles never fetch at once; absent, a load runs straight away.
      this._scheduleLoad = typeof opts.scheduleLoad === 'function' ? opts.scheduleLoad : null;
      // Loads a BOUNDED window (`full=1&tail=` for a TUI, `tail=` for a shell)
      // instead of a TUI's whole history. Grid tiles do; full history is one
      // "leave the grid" away in the primary pane.
      this.boundedLoad = opts.boundedLoad === true;
      this.terminal = null;
      this.fitAddon = null;
      this.ws = null;
      this._wsReady = false;
      this._wsClosed = false;
      this._destroyed = false;
      // Single-flight state for _loadBuffer()/_refreshBuffer() below.
      this._bufferLoading = false;
      this._bufferRefreshPending = false;
      // True only while a load's work runs, not while it waits in the owner's
      // queue (see _runLoad): a close during the wait writes its marker at once.
      this._loadRunning = false;
      // Aborts the running load's fetch; destroy() uses it so a removed tile
      // does not hold the owner's queue for a whole deadline.
      this._loadAbort = null;
      // Settles a replay xterm is still parsing (writeChunked): destroy() calls
      // it, because a disposed xterm never runs the callback the replay awaits.
      this._cancelReplay = null;
      // Scroll-to-top history pull (shell panes only), see _maybeLoadMoreHistory().
      // `_liveQueue` is non-null from the pull's response until its finally
      // block: live frames are held there with their arrival time instead of
      // written under the replay. `_markerOwed` is the "disconnected" marker a
      // load still has to write (see _onSocketClosed()/_stampMarkerIfOwed()).
      this._historyPullAt = 0;
      this._historyPullUseless = false;
      this._liveQueue = null;
      this._liveQueueBytes = 0;
      this._markerOwed = false;
      // Live-output flow control (_writeLive, TerminalTile.LIVE_BACKLOG_BUDGET):
      // code units written into this xterm and not yet parsed (each write's
      // callback counts its own back down, unless a reset bumped `_liveEpoch`
      // since), whether output was dropped and not yet recovered, when the last
      // frame was dropped, and the debounced, bounded recovery refresh.
      this._liveInFlight = 0;
      this._liveEpoch = 0;
      this._liveDropped = false;
      this._liveDropAt = 0;
      this._dropRecoveryTimer = null;
      this._dropRecoveryAttempt = 0;
      this._onWheel = null;
      // `{ ws, lastRecvAt }`, registered with the app's input-socket map while
      // this pane's socket is open, so the exactly-once input queue delivers this
      // session's keystrokes over it (app.js _inputSocketFor). Null otherwise.
      this._inputHandle = null;
      // Reconnect state. `_socketUrl` is set once connect() opens the first
      // socket: a pane that never connected has nothing to reconnect to.
      // `_reconnectAttempts` counts consecutive failed opens and is reset ONLY by
      // a successful open (resetting it per attempt is the tight-loop bug the
      // primary pane's _disconnectWs documents). `_stoppedCode` is the close code
      // that ended the pane for good; `onExit(code)` tells the owner once.
      this._socketUrl = null;
      this._reconnectAttempts = 0;
      this._reconnectTimer = null;
      this._stoppedCode = null;
      this._markerText = TerminalTile.MARKER_RECONNECTING;
      this.onExit = typeof opts.onExit === 'function' ? opts.onExit : null;
      // The `{ cols, rows }` last sent in a `{t:'z'}` frame, so an unchanged size
      // is not resent (each one costs a `tmux resize-window` and a SIGWINCH).
      // Cleared on every open: a fresh socket must announce its size, which is
      // also what registers it as a desktop viewer server-side.
      this._lastSentDims = null;
      // Whether the pointer is over a link in THIS pane (the primary pane's own
      // flag, app._linkHovered, belongs to its terminal alone).
      this._linkHovered = false;
      this._onFocusIn = null;
      // Hollow-buffer paging (_maybePageCliTranscript): wheel travel short of a
      // whole page, carried to the next wheel event.
      this._pageKeyPending = 0;
      // Shift+wheel travel short of a whole line, carried to the next wheel
      // event (_maybeScrollLocalOnShift).
      this._shiftScrollPending = 0;
      // Page keys waiting for the 40 ms flush, and its timer (_queueScrollBytes).
      this._scrollBytes = '';
      this._scrollFlushTimer = null;
      // Rows above the screen that this pane pushed there itself rather than
      // received as history: a capture taken at the PTY's previous, taller size
      // and row-shrinking fits (_overflowAfterLoad, _noteResizeRows). Not
      // history, so the paging gate leaves them out (_localRows).
      this._overflowRows = 0;
      // The desktop click reporter (_installClickListener).
      this._onClick = null;
      // The soft-keyboard controller (terminal-keycode229-recovery.js): created
      // in connect() once the xterm is open, torn down in destroy().
      this._keyCode229Recovery = null;
    }

    async connect() {
      const savedFontSize = this.fontSize ?? parseInt(localStorage.getItem('codeman-font-size'), 10);
      this.terminal = new Terminal({
        theme: { ...global.codemanCurrentXtermTheme() },
        fontFamily: global.CodemanTerminalFont.resolve(this.fontSettings.terminalFontFamily),
        ...global.CodemanTerminalFont.resolveWeights(this.fontSettings),
        fontSize: Number.isFinite(savedFontSize) ? savedFontSize : 14,
        lineHeight: 1.2,
        cursorBlink: false,
        cursorStyle: 'block',
        minimumContrastRatio: global.codemanCurrentSkinIsLight() ? 4.5 : 1,
        scrollback: this.scrollback ?? DEFAULT_SCROLLBACK,
        allowTransparency: true,
        allowProposedApi: true,
      });

      this.fitAddon = new FitAddon.FitAddon();
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.open(this.mountEl);
      this.fitAddon.fit();

      // File paths and URLs printed here are clickable, through the SAME
      // provider as the primary pane (registerFilePathLinkProvider,
      // terminal-ui.js), and open against THIS pane's session.
      global.app?.registerFilePathLinkProvider?.({
        terminal: this.terminal,
        getSessionId: () => this.sessionId,
        setHovered: (hovered) => {
          this._linkHovered = hovered;
        },
      });

      this._installWheelListener();
      this._installClickListener();

      // Focusing this terminal makes it the pane the keyboard is in, so the
      // app-level shortcuts, voice and paste act on it (app._focusedPane).
      this._onFocusIn = () => global.app?._noteFocusedTile?.(this);
      this.terminal.textarea?.addEventListener('focus', this._onFocusIn);

      this._createKeyCode229Recovery();
      // The twin of terminal-ui.js's onData gate (initTerminal; keep the two in
      // step). Canonical xterm data tells the controller this keystroke was
      // delivered, but not a query reply or a focus/mouse report, which xterm
      // emits on its own and which would otherwise stand a pending recovery
      // down. The notify lives HERE and not in _onTerminalData(): the
      // controller's own recovered bytes go through _onTerminalData() too, and
      // must never count as xterm's, or a second pending character from the
      // same keystroke window would stand down and be lost.
      this.terminal.onData((data) => {
        try {
          const input = global.CodemanTerminalInput;
          if (!input?.shouldSuppressTerminalQueryResponse?.(data) && !input?.isTerminalFocusOrMouseReport?.(data)) {
            this._keyCode229Recovery?.notifyCanonicalData?.();
          }
        } catch {
          /* Bookkeeping must never block real input. */
        }
        this._onTerminalData(data);
      });

      // xterm has no gates of its own, so every app-level chord that the
      // document capture-phase handler (app.js) only preventDefault()s (never
      // stopPropagation()s) would reach this xterm too and write its raw byte
      // or escape sequence into THIS session's PTY on top of whatever the app
      // action did (COD-153). These are the primary pane's gates
      // (terminal-ui.js attachCustomKeyEventHandler): command palette,
      // Alt+1-9/[/] tab nav, Alt+B sidebar toggle, the tile grid's chords,
      // Ctrl+Z suspend, Shift/Ctrl+Enter newline, and smart-copy
      // Ctrl+C/Ctrl+Shift+C. Routed through the same registry-aware
      // predicates so a rebind or a disable restores plain terminal behavior
      // here too. Ctrl+V goes through the primary pane's paste trap
      // (image-input.js), aimed at this pane (below).
      this.terminal.attachCustomKeyEventHandler((ev) => {
        // FIRST, above the IME early return below, as in terminal-ui.js: every
        // keydown settles this pane's pending textarea edit and drains a
        // pending recovery BEFORE xterm handles the key, so a character an
        // Android keyboard committed in the same task as Enter is sent ahead
        // of the \r. Below that return a keyCode-229 keydown would skip the
        // settle, the drain and the snapshot, and the panes would differ.
        // Read at call time, never captured, so the controller can be swapped
        // (the tests count xterm's emissions through it).
        try {
          this._keyCode229Recovery?.handleKeyEvent?.(ev);
        } catch {
          /* The controller must never interfere with xterm's own handling. */
        }
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
        // Tile grid chords (focus, toggle): acted on by the capture handler, so
        // they must never reach this tile's PTY. Every event type, and before
        // the Shift+Enter branch below.
        if (global.app?.tileShortcutFor?.(ev)) return false;
        // Ctrl+V / Cmd+V: the primary pane's paste trap, aimed at THIS pane, so
        // a pasted image uploads to this pane's session and its path is typed
        // here, and pasted text goes into this xterm with its bracketed-paste
        // markers intact. Mirrors terminal-ui.js's own Ctrl+V gate; without it
        // xterm's default only ever pasted text.
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'v' && ev.type === 'keydown') {
          global.app?._handleImagePaste?.({ terminal: this.terminal, sessionId: this.sessionId });
          return false;
        }
        // Ctrl+Z (SIGTSTP/job-control suspend), as terminal-ui.js swallows it:
        // in a plain shell session this is the user's own job-control tool and
        // must reach the PTY, but in every other mode (claude/omp/pi/codex/...)
        // it silently stops an unattended agent loop dead. This pane has its
        // own session and applies the same rule to it.
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
        // Shift+Enter / Ctrl+Enter: insert a newline instead of submitting, as
        // terminal-ui.js does. xterm sends plain \r for every Enter variant,
        // so an Ink app (Claude Code) can't tell a newline from a submit, and
        // without this gate this pane's onData would send that bare \r and
        // submit an incomplete prompt instead of adding a line to it. Targets
        // THIS pane's own session (this.sessionId), never the primary pane's
        // activeSessionId, and has no local-echo overlay of its own to flush
        // first (this pane is deliberately plainer, see the fileoverview).
        // Swallow keypress/keyup too (xterm would send \r for a Shift-only keypress); only keydown sends.
        if (ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey)) {
          if (ev.type === 'keydown') {
            fetch(`/api/sessions/${this.sessionId}/send-key`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: ev.ctrlKey ? 'C-Enter' : 'S-Enter' }),
            }).catch(() => {
              /* Best-effort, matching this pane's tolerance elsewhere. */
            });
          }
          return false;
        }
        // Smart copy, the primary pane's rule (terminal-ui.js's Ctrl+C gate,
        // #211) through the SAME helpers, aimed at THIS pane: the gutter width
        // comes from this session's run mode, the partial first line from this
        // terminal's selection, and the clear and refocus after the copy land
        // here. With a selection worth copying, Ctrl+C copies instead of
        // sending ^C; with none, plain Ctrl+C falls through unchanged or the
        // interrupt key is lost. Ctrl+Shift+C is the explicit copy chord and
        // never falls through (ev.shiftKey, below): with nothing to copy it
        // would otherwise reach the browser's own binding for that chord.
        // As in the primary gate, the CLEANED selection decides and the copy is
        // handed the RAW one, because the margin strip is not idempotent.
        if (ev.type === 'keydown' && global.app?.shouldCopyTerminalSelectionFromShortcut?.(ev)) {
          const app = global.app;
          const target = { terminal: this.terminal, sessionId: this.sessionId };
          const raw = this.terminal?.getSelection?.() || '';
          if (app.cleanedTerminalSelection?.(raw, target)?.trim()) {
            ev.preventDefault();
            void app.copyTerminalSelection(raw, target);
            return false;
          }
          // Nothing worth copying: cleared for feedback, and the press still
          // reaches the PTY as 0x03, as in the primary pane.
          if (this.terminal?.hasSelection?.()) {
            this.terminal.clearSelection?.();
            app.showToast?.('Nothing to copy', 'warning');
          }
          if (ev.shiftKey) {
            ev.preventDefault();
            return false;
          }
        }
        return true;
      });

      // Load existing scrollback before going live. The WS below is
      // subscribe-only (ws-routes.ts sends nothing on connect, only future
      // 'terminal' events), so without this the pane stays blank until the
      // session happens to produce new output. The resize _sendResize() sends
      // on open is no substitute: tmux repaints on a resize, but
      // Session.resize() (session.ts) skips one that matches the session's
      // last size, and then nothing repaints at all. The await covers the
      // whole chunked replay, not just the fetch, so a live frame from the
      // socket below can never land in the middle of it.
      await this._loadBuffer();
      if (this._destroyed) return;

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // The tab's own connection identity plus a `:tile` suffix. The server
      // supersedes a socket that reuses a cid on the same session (4010), so a
      // pane must never share the primary pane's exact cid: were both ever on
      // one session they would evict each other in a loop. Input frames still
      // carry the BARE clientId, which is what the server dedups on.
      const app = global.app;
      const cid = app?._clientId ? `${app._clientId}:${app._wsTabNonce}:tile` : '';
      const cidQuery = cid ? `?cid=${encodeURIComponent(cid)}` : '';
      this._socketUrl = `${proto}//${location.host}${window.CodemanBase.base}/ws/sessions/${this.sessionId}/terminal${cidQuery}`;
      this._openSocket();
    }

    // Opens a socket and makes it THE socket. A previous one is detached first
    // (handlers nulled, then closed), and every handler below checks it still
    // belongs to the current socket: a replacement opened while the old socket
    // still looked alive (a half-open connection whose close has not landed)
    // makes the server supersede the old one with a 4010, and that late close
    // must not stop a pane that is already running on its successor.
    _openSocket() {
      if (this._destroyed || !this._socketUrl) return;
      this._detachSocket();
      const ws = new WebSocket(this._socketUrl);
      this.ws = ws;

      ws.onopen = () => {
        if (ws !== this.ws) return;
        this._onSocketOpen();
      };

      ws.onmessage = (event) => {
        if (ws !== this.ws) return;
        if (this._inputHandle) this._inputHandle.lastRecvAt = Date.now();
        try {
          const msg = JSON.parse(event.data);
          if (msg.t === 'o') {
            this._onLiveOutput(msg.d);
          } else if (msg.t === 'c') {
            this._onLiveClear();
          } else if (msg.t === 'r') {
            // Server-triggered refresh (SSE backpressure cleared, terminal
            // data was dropped). The primary pane routes this to
            // _onSessionNeedsRefresh (app.js); this pane has its own buffer
            // loader for the same reason connect() does.
            this._refreshBuffer();
          } else if (msg.t === 'ia') {
            // Input ACK. The frame names no session, so it is this pane's.
            global.app?._onWsInputAck?.(msg.seq, msg, this.sessionId);
          } else if (msg.t === 'zc') {
            this._onPtyGeometryReport(msg.c, msg.r);
          }
        } catch {
          /* Malformed frame: ignored, as in the primary pane. */
        }
      };

      // _wsReady must go false on a drop or fit()/_sendResize() silently
      // no-op on a closed socket per the WebSocket spec (no exception, no log).
      // Input is not lost meanwhile: it waits in the app's durable queue and
      // goes out over HTTP or the next socket. The "disconnected" marker says
      // so on screen, and a transient close reconnects (_onSocketClosed).
      ws.onclose = (event) => {
        if (ws !== this.ws) return;
        this._onSocketClosed(event);
      };

      ws.onerror = () => {
        // onclose fires after onerror: cleanup happens there.
      };
    }

    // Lets go of the current socket without running its close handling.
    _detachSocket() {
      const ws = this.ws;
      if (!ws) return;
      ws.onopen = null;
      ws.onmessage = null;
      // onclose fires asynchronously AFTER close(); without this it would run
      // its "disconnected" write against a pane already torn down or replaced.
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* Already closed. */
      }
      this.ws = null;
      this._wsReady = false;
      this._unregisterInputSocket();
    }

    // A socket came up. After a drop this is a reconnect: the gap left nothing
    // to replay (output frames carry no sequence number), so the buffer is
    // refreshed. The closed state is reset FIRST, or the refresh would re-owe
    // the "disconnected" marker (_refreshBuffer does on a closed socket) and
    // stamp it under a healthy pane.
    _onSocketOpen() {
      const reconnected = this._wsClosed;
      this._wsReady = true;
      this._wsClosed = false;
      this._markerOwed = false;
      this._reconnectAttempts = 0;
      this._lastSentDims = null;
      this._registerInputSocket();
      this._sendResize();
      if (reconnected) {
        // The gap already cost output, and the refresh below replaces the
        // screen, so live-output accounting starts over with it.
        this._resetLiveFlow();
        this._refreshBuffer();
      }
    }

    // Opens a replacement socket now instead of waiting out the backoff (for an
    // owner that just learned the server is back). No-op while the current
    // socket is open, after a permanent stop, or once destroyed.
    reconnectNow() {
      if (this._destroyed || this._stoppedCode !== null || !this._socketUrl) return;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._openSocket();
    }

    // The socket's close, split out of connect() so the tests can drive it.
    // While any load runs (a history pull or a `{t:'r'}` refresh) the marker is
    // only owed, and that load's finally block settles it (_stampMarkerIfOwed()):
    // written now, it would sit above the output a pull is still holding (flushed
    // after it on a skip, a downgrade or a failed fetch), above a refresh's
    // replay, or in the middle of a chunked replay. A pull still waiting for its
    // response holds the marker too, for as long as the request takes (up to its
    // budget, see _pullHistory()).
    //
    // Then decides what comes next. Codes that cannot get better stop the pane
    // for good and report once through `onExit(code)`: 4004/4009 (the session
    // is gone), 4003 (refused: Host/Origin/owner, a retry gets the same answer)
    // and 4010 (another socket with this pane's cid took over; only ever
    // reaches here for the CURRENT socket, see _openSocket). Everything else,
    // including the redelivery sweep force-closing a silent socket (1005), is
    // transient and reconnects on the primary pane's backoff ladder
    // (CodemanWsReconnect, constants.js) plus jitter.
    _onSocketClosed(event) {
      this._wsReady = false;
      this._wsClosed = true;
      this._unregisterInputSocket();
      const code = event?.code;
      const permanent = TerminalTile.STOP_MARKERS[code];
      this._markerText = permanent || TerminalTile.MARKER_RECONNECTING;
      if (this._loadRunning) this._markerOwed = true;
      else this._writeDisconnectedMarker();
      if (this._destroyed) return;
      if (permanent) {
        this._stop(code);
        return;
      }
      this._scheduleReconnect(code);
    }

    _scheduleReconnect(code) {
      if (this._destroyed || !this._socketUrl || this._reconnectTimer) return;
      const plan = global.CodemanWsReconnect?.plan?.(code ?? 1006, this._reconnectAttempts) || {
        action: 'reconnect',
        delayMs: 1000,
      };
      if (plan.action === 'give-up') {
        this._stop(code);
        return;
      }
      this._reconnectAttempts++;
      const delay = plan.delayMs + Math.floor(Math.random() * 250); // jitter: tiles must not reconnect in lockstep
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._openSocket();
      }, delay);
    }

    _stop(code) {
      if (this._stoppedCode !== null) return;
      this._stoppedCode = code ?? null;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      if (!this._destroyed) this.onExit?.(code);
    }

    // Keystrokes and pastes go through the app's exactly-once input queue (seq,
    // ACK, persisted until delivered, redelivered after a drop), over this
    // pane's own socket while it is open and the HTTP fallback while it is not.
    // What xterm GENERATES must not be queued: a query reply (DA/CPR/OSC) is
    // dropped, as the primary pane drops it, because forwarding it types
    // "0;276;0c" into the CLI, and replaying one after a reload would do so
    // again into a later screen. A focus or mouse report is real input the
    // program asked for, but nobody typed it: it goes out once, never
    // persisted. Same predicates as the primary pane (terminal-ui.js onData).
    _onTerminalData(data) {
      const input = global.CodemanTerminalInput;
      if (input?.shouldSuppressTerminalQueryResponse?.(data)) return;
      const app = global.app;
      if (input?.isTerminalFocusOrMouseReport?.(data)) {
        app?._sendInputEphemeral?.(this.sessionId, data);
        return;
      }
      app?._sendInputAsync?.(this.sessionId, data);
    }

    // The soft-keyboard controller, the twin of the primary pane's wiring in
    // terminal-ui.js initTerminal() (keep the two in step); the behaviour lives
    // once, in terminal-keycode229-recovery.js. Everything it is handed is THIS
    // pane's: its textarea, its xterm's CompositionHelper (whose
    // `_handleAnyTextareaChanges` it patches, per instance) and its send path.
    // Recovered text goes straight to _onTerminalData(), never through xterm's
    // onData, so it is not counted as xterm's own (see connect()'s onData).
    // Created after terminal.open(): xterm's capture `input` listener on the
    // textarea is registered there, and must run before the controller's. No
    // device or mode gate, as in the primary pane: with a hardware keyboard it
    // costs one assignment per keydown. A failure leaves xterm's own handling.
    _createKeyCode229Recovery() {
      this._destroyKeyCode229Recovery();
      if (!this.terminal) return;
      try {
        this._keyCode229Recovery =
          global.CodemanKeyCode229Recovery?.create?.({
            textarea: this.terminal.textarea,
            emitRecovered: (data) => this._onTerminalData(data),
            getCompositionHelper: () => this.terminal?._core?._compositionHelper,
            isScreenReaderMode: () => this.terminal?.options?.screenReaderMode === true,
          }) ?? null;
      } catch {
        this._keyCode229Recovery = null;
      }
    }

    // Restores xterm's own textarea diff and removes the controller's capture
    // listeners from the live textarea, so it runs before terminal.dispose().
    _destroyKeyCode229Recovery() {
      try {
        this._keyCode229Recovery?.destroy?.();
      } catch {
        /* Optional; teardown must continue. */
      }
      this._keyCode229Recovery = null;
    }

    // Joins the app's input-socket map for this session and flushes anything
    // already queued for it (typed while the socket was down, or left over from
    // a reload) over the fresh socket. Called from onopen.
    _registerInputSocket() {
      const app = global.app;
      if (!this.ws || !app?._registerInputSocket) return;
      this._unregisterInputSocket();
      this._inputHandle = { ws: this.ws, lastRecvAt: 0 };
      app._registerInputSocket(this.sessionId, this._inputHandle);
      app._onWsReady?.(this.sessionId);
      // The header's connection dot reads tile sockets while the grid is open.
      app._updateConnectionIndicator?.();
    }

    // Leaves the map; only this pane's own handle is removed (a replacement
    // socket's registration survives a late close of the old one).
    _unregisterInputSocket() {
      if (!this._inputHandle) return;
      global.app?._unregisterInputSocket?.(this.sessionId, this._inputHandle);
      this._inputHandle = null;
      global.app?._updateConnectionIndicator?.();
    }

    // Settles a marker the pane owes: set when a close lands during a load (the
    // replay would otherwise sit below it) or when a load wipes the terminal on
    // a closed socket. Called from each load's own finally, just before
    // _endBufferLoad() starts any trailing refresh.
    _stampMarkerIfOwed() {
      // A trailing refresh is about to run, and it settles the marker itself:
      // a replay's queued `\x1bc` would wipe one written here (it re-owes the
      // marker on a closed socket and stamps it below the replay), and a refresh
      // that writes nothing stamps the one still owed. Stamped here as well,
      // there would be two marker writes for one close.
      if (this._bufferRefreshPending && !this._destroyed) return;
      const owed = this._markerOwed;
      this._markerOwed = false;
      if (owed && this._wsClosed && !this._destroyed) this._writeDisconnectedMarker();
    }

    // Extracted so both _onSocketClosed() and a load that ends owing it on a
    // closed socket can write it (see _stampMarkerIfOwed()).
    _writeDisconnectedMarker() {
      this.terminal?.write(`\r\n\x1b[2m${this._markerText}\x1b[0m\r\n`);
    }

    // Fetches and writes the session's current scrollback. Used both by
    // connect() (initial load) and by the refresh frames (`{t:'r'}`, `{t:'c'}`)
    // and a reconnect (_refreshBuffer). The primary pane's own
    // _onSessionNeedsRefresh (app.js) is scoped to `this.activeSessionId` and
    // rewrites the primary terminal, neither of which applies to this
    // independent pane, so this is a standalone equivalent rather than a call
    // into it, in the primary's order (below).
    //
    // Mirrors the primary pane's own mode check (app.js's selectSession /
    // _onSessionNeedsRefresh): a shell session can retain hundreds of
    // thousands of plain scrollback lines, so pulling `?full=1` there parses
    // an unbounded, server-capped (up to terminalBufferMaxBytes, 32MB) body
    // into this xterm on every load; a shell loads the `tail=` window. A
    // non-shell (TUI) session gets one full replay, or the same bounded window
    // with `boundedLoad` (grid tiles). `fetch` here goes through the global
    // wrapper (constants.js), which already prefixes CodemanBase, unlike the
    // raw WebSocket URL above, which does not.
    //
    // A refresh replaces what the pane shows, in the primary pane's order
    // (_onSessionNeedsRefresh, _resetTerminalForReplay): fetch FIRST, so the
    // pane keeps its last frame through the round trip (and through a grid
    // tile's wait in the load queue); then the queued in-stream `\x1bc`, never
    // xterm's clear(): clear() is synchronous while write() is parsed on a later
    // tick, so live bytes still queued would land after it and fuse into the
    // snapshot, and it keeps the cursor's row, column, SGR and margins, so the
    // capture (raw rows, no home) started wherever the cursor sat. Live frames
    // from the response onward are held (`_liveQueue`, the primary's
    // _finishBufferLoad `since` rule, as _pullHistory() holds them) and only
    // those that arrived after it are written behind the replay. A failed,
    // aborted or empty fetch writes nothing and resets nothing: the pane keeps
    // its last frame and every held frame. The initial load needs none of
    // this: it runs before the pane has a socket, onto a fresh xterm.
    //
    // Single-flight: the flag is held across the fetch AND the chunked write
    // (writeChunked resolves after its last chunk), so two replays can never
    // interleave their chunks into one terminal. A second call while one is
    // in flight is dropped here; _refreshBuffer() is the caller that queues
    // a trailing re-run instead.
    async _loadBuffer({ refresh = false } = {}) {
      if (this._bufferLoading) return;
      this._bufferLoading = true;
      await this._runLoad(refresh ? 'refresh' : 'initial', async () => {
        this._loadRunning = true;
        let replayed = false;
        let capturedAt = 0;
        // A deadline covering the body as well as the headers (the primary
        // pane's budgets, CodemanFetchDeadline): a capture that never answers
        // would otherwise hold this pane's single-flight flag, and in the grid
        // the one load queue every tile waits behind, forever. Re-armed once a
        // refresh's headers land (below), so one signal carries both budgets.
        const controller = global.AbortController ? new global.AbortController() : null;
        let abortTimer = null;
        const armDeadline = (ms) => {
          if (!controller) return;
          clearTimeout(abortTimer);
          abortTimer = setTimeout(() => controller.abort(), ms);
        };
        try {
          if (this._destroyed) return;
          const shell = this.sessionMode === 'shell';
          let query = shell ? `tail=${TERMINAL_TAIL_SIZE}` : 'full=1';
          if (this.boundedLoad && !shell) query = `full=1&tail=${TERMINAL_TAIL_SIZE}${this._historyLinesQuery()}`;
          this._loadAbort = controller;
          armDeadline(global.CodemanFetchDeadline?.terminalFetchDeadlineMs?.({ full: !shell }) ?? 45000);
          let payload;
          try {
            const res = await fetch(
              `/api/sessions/${this.sessionId}/terminal?${query}`,
              controller ? { signal: controller.signal } : undefined
            );
            if (refresh) {
              // The response's arrival stands in for the instant tmux took the
              // capture (see _pullHistory()). Frames from here on are news the
              // capture cannot hold, so they wait for the replay. From now on
              // live output IS held, so a bounded window's body (at most
              // TERMINAL_TAIL_SIZE) gets the pull's short budget; an unbounded
              // capture (the split's Pane B, up to 32 MB) keeps the request's.
              capturedAt = performance.now();
              this._openLiveQueue();
              if (shell || this.boundedLoad) armDeadline(HISTORY_PULL_TIMEOUT_MS);
            }
            payload = (await res.json())?.data ?? {};
          } finally {
            clearTimeout(abortTimer);
            this._loadAbort = null;
          }
          if (payload.terminalBuffer && this.terminal && !this._destroyed) {
            if (refresh) {
              this.terminal.write('\x1bc');
              this._overflowRows = 0; // the reset leaves nothing above the screen
              replayed = true;
              // The reset wipes a "disconnected" marker (a `{t:'r'}` frame can
              // queue a trailing refresh behind a pull that the socket's close
              // then interrupts), so a refresh on a closed socket owes it back
              // once its replay is written.
              if (this._wsClosed) this._markerOwed = true;
            }
            await writeChunked(
              this.terminal,
              payload.terminalBuffer,
              () => this._destroyed,
              (cancel) => (this._cancelReplay = cancel)
            );
            if (!this._destroyed && this.terminal) this._overflowRows = this._overflowAfterLoad(payload);
          }
        } catch {
          /* Best-effort: live output still arrives once the socket connects. */
        } finally {
          clearTimeout(abortTimer);
          this._loadAbort = null;
          this._loadRunning = false;
          // Before the flush: a refresh that recovered dropped output lets its
          // held frames through.
          if (refresh) this._settleDropRecovery({ replayed, capturedAt, timedOut: !!controller?.signal?.aborted });
          // Held frames before the marker, so the marker stays the last thing on
          // screen (see _pullHistory()).
          this._flushLiveQueue(replayed ? capturedAt : 0);
          this._stampMarkerIfOwed();
          this._endBufferLoad();
        }
      });
    }

    // Runs a load's work now, or when the owner's queue gives this pane its turn
    // (`scheduleLoad`). The single-flight flag is already set by the caller, so a
    // load waiting in the queue still coalesces refreshes and blocks a second
    // pull; the work itself sets `_loadRunning`. A load the queue drops (this
    // pane was destroyed while it waited) never runs, so its flags are released
    // here.
    async _runLoad(kind, work) {
      let ran = false;
      const run = () => {
        ran = true;
        return work();
      };
      if (!this._scheduleLoad) {
        await run();
        return;
      }
      try {
        await this._scheduleLoad(this, kind, run);
      } catch {
        /* The queue never rejects; a load that failed already settled itself. */
      }
      if (!ran) {
        this._bufferLoading = false;
        this._bufferRefreshPending = false;
      }
    }

    // Ends a single-flight load (initial, refresh or history pull): clears the
    // flag, then runs the ONE trailing refresh that arrived while it was busy.
    _endBufferLoad() {
      this._bufferLoading = false;
      if (this._bufferRefreshPending && !this._destroyed) {
        this._bufferRefreshPending = false;
        this._refreshBuffer();
      }
    }

    // Live terminal output. Written straight through, except while a refresh or
    // a history pull is replaying: a capture is current only up to the instant
    // tmux took it, so a frame arriving mid-replay is held with its arrival time
    // and written behind the snapshot by that load's _flushLiveQueue() (the
    // primary pane's _finishBufferLoad `since` rule), never underneath it.
    // Held frames count against the same budget as unparsed ones: a pull or a
    // refresh holds output for up to its body budget, and a flood meanwhile
    // must not grow the queue without bound either.
    _onLiveOutput(data) {
      if (!data) return;
      if (this._liveQueue) {
        if (this._liveQueueBytes + data.length > TerminalTile.LIVE_BACKLOG_BUDGET) {
          this._noteLiveDrop();
          return;
        }
        this._liveQueueBytes += data.length;
        this._liveQueue.push({ at: performance.now(), data });
        return;
      }
      this._writeLive(data);
    }

    _openLiveQueue() {
      this._liveQueue = [];
      this._liveQueueBytes = 0;
    }

    // Releases the frames a load held (_liveQueue) and closes the queue. After a
    // replay only those that arrived after the capture are news (`cutoff`, the
    // response's arrival; earlier ones are already in it); with no replay
    // (`cutoff` 0) every one is. Through _writeLive(), so they are counted (and
    // a write that throws cannot skip the load's marker and trailing refresh).
    _flushLiveQueue(cutoff) {
      const queued = this._liveQueue ?? [];
      this._liveQueue = null;
      this._liveQueueBytes = 0;
      for (const entry of queued) {
        if (entry.at < cutoff) continue;
        this._writeLive(entry.data);
      }
    }

    // Writes one live frame into this xterm, under flow control. The server
    // applies no backpressure (16 KB / 8 ms batches, never a bufferedAmount
    // check), so a flood a tile cannot parse as fast as it arrives (a shell
    // tile running `cat` on a huge log, `yes`) used to pile up in xterm's own
    // write queue without bound, on a main thread six tiles share, until
    // xterm's WriteBuffer throws past 50M code units and the frames were
    // silently lost in onmessage's catch. The primary pane caps its queues
    // and drops then recaptures (_onSessionTerminal, app.js); this is the
    // tile's equivalent. Past TerminalTile.LIVE_BACKLOG_BUDGET unparsed, a
    // frame is dropped and the tile stops writing until a refresh recaptures
    // the screen (_scheduleDropRecovery): every byte after a hole is written
    // onto a screen out of step with the PTY, which that refresh replaces
    // anyway. A write that throws is the same drop, never a malformed frame.
    _writeLive(data) {
      const terminal = this.terminal;
      if (!terminal || this._destroyed || !data) return;
      if (this._liveDropped) {
        this._noteLiveDrop();
        return;
      }
      const n = data.length;
      if (this._liveInFlight + n > TerminalTile.LIVE_BACKLOG_BUDGET) {
        this._noteLiveDrop();
        return;
      }
      const epoch = this._liveEpoch;
      this._liveInFlight += n;
      try {
        terminal.write(data, () => {
          if (epoch === this._liveEpoch) this._liveInFlight -= n;
        });
      } catch {
        if (epoch === this._liveEpoch) this._liveInFlight -= n;
        this._noteLiveDrop();
      }
    }

    // A live frame was dropped. Marks the tile out of step and arms ONE
    // recovery; later drops only move the stamp the recovery has to beat.
    _noteLiveDrop() {
      this._liveDropAt = performance.now();
      if (this._liveDropped) return;
      this._liveDropped = true;
      this._scheduleDropRecovery();
    }

    // The primary pane's dropped-output recovery (_scheduleDroppedOutputRecovery,
    // app.js), aimed at this tile: debounced by DROP_RECOVERY_DELAY_MS so a
    // sustained flood collapses into one attempt, and run as an ordinary
    // refresh, which is single-flight, bounded (`lines=`/`tail=`) and waits its
    // turn in the grid's load queue. _settleDropRecovery() decides what the
    // refresh it starts achieved.
    _scheduleDropRecovery() {
      if (this._dropRecoveryTimer || this._destroyed) return;
      const delay = global.CodemanDroppedOutput?.DROP_RECOVERY_DELAY_MS ?? 2000;
      this._dropRecoveryTimer = setTimeout(() => {
        this._dropRecoveryTimer = null;
        if (this._destroyed || !this._liveDropped) return;
        this._dropRecoveryAttempt++;
        this._refreshBuffer();
      }, delay);
    }

    // A refresh finished while output was marked dropped. Recovered when its
    // replay's capture was taken after the last dropped frame (the response's
    // arrival, the cutoff every load uses): output flows again. Otherwise one
    // more attempt, bounded by the primary pane's rule
    // (shouldRetryDroppedOutputRecovery: DROP_RECOVERY_MAX_ATTEMPTS, and never
    // after a capture cut off at its deadline, a stalled link); past that the
    // flag is released so the tile is never left frozen, and it writes on, out
    // of step, as every tile did before this existed.
    _settleDropRecovery({ replayed, capturedAt, timedOut }) {
      if (!this._liveDropped || this._destroyed) return;
      if (replayed && capturedAt >= this._liveDropAt) {
        this._liveDropped = false;
        this._dropRecoveryAttempt = 0;
        return;
      }
      // Another try is already on its way: the debounce, or a trailing refresh.
      if (this._dropRecoveryTimer || this._bufferRefreshPending) return;
      const retry =
        global.CodemanDroppedOutput?.shouldRetryDroppedOutputRecovery?.({
          repainted: false,
          timedOut,
          attempt: Math.max(0, this._dropRecoveryAttempt - 1),
          stillActive: true,
        }) === true;
      if (retry) {
        this._scheduleDropRecovery();
        return;
      }
      this._liveDropped = false;
      this._dropRecoveryAttempt = 0;
    }

    // Starts live-output accounting over (a reconnect, destroy): write callbacks
    // still pending from before carry the old epoch and count nothing.
    _resetLiveFlow() {
      this._liveEpoch++;
      this._liveInFlight = 0;
      this._liveDropped = false;
      this._dropRecoveryAttempt = 0;
      clearTimeout(this._dropRecoveryTimer);
      this._dropRecoveryTimer = null;
    }

    // The server's `{t:'c'}` frame, which is a refresh, not a wipe. Its one
    // emitter (Session.startInteractive, session.ts) sends it once a fresh Claude
    // pane first shows its prompt: the server has just trimmed its own buffer and
    // means "refresh after startup". The primary pane refetches the capture and
    // replays it (_onSessionClearTerminal, app.js), and while the grid is open
    // that handler stands aside for the tiles. A bare xterm clear() here kept
    // only the cursor's row and dropped the banner and every row above it, and an
    // idle Claude never repaints static rows, so a Claude session Run into the
    // grid (or Attached in a tile) sat there as a near-empty tile. So it takes
    // the `{t:'r'}` route: single-flight, coalesced into one trailing refresh
    // behind a load already running (a pull's held frames included), and paced
    // by the grid's load queue.
    _onLiveClear() {
      this._refreshBuffer();
    }

    // Capture phase, because xterm's own wheel handler stopPropagation()s every
    // event it consumes, so a bubbling listener here would never see the wheel
    // while the pane still has scrollback to scroll. Not passive: the three
    // routes this pane takes over, forwarding the wheel to Claude's fullscreen
    // renderer (_maybeForwardWheelToCli), paging a hollow buffer's CLI
    // transcript (_maybePageCliTranscript) and Shift+wheel's local scrollback
    // (_maybeScrollLocalOnShift), are consumed right here (preventDefault plus
    // stopPropagation in the capture phase, the primary pane's technique), so
    // xterm's viewport, a descendant, never sees them. Every other wheel is left
    // to xterm, which keeps doing the scrolling, and only observed for the
    // shell history pull.
    _installWheelListener() {
      this._onWheel = (ev) => {
        if (this._maybeForwardWheelToCli(ev) || this._maybePageCliTranscript(ev) || this._maybeScrollLocalOnShift(ev)) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        if (ev.deltaY < 0) this._maybeLoadMoreHistory();
      };
      this.mountEl.addEventListener('wheel', this._onWheel, { capture: true, passive: false });
    }

    // SGR wheel forwarding, the twin of the primary pane's capture-phase wheel
    // handler and _forwardScrollToApp (terminal-ui.js; keep them in step).
    // Claude's fullscreen renderer (claude 2.1.187+ while its mouse tracking is
    // on, cliMouseTracking) scrolls its own transcript on SGR wheel reports,
    // while this xterm holds only Codeman's replayed repaint frames (tmux keeps
    // no history for such a pane). Left to xterm, the wheel dragged those stale
    // frames, Claude's pinned input box with them, up the tile, or scrolled
    // nothing at all. The gate is the primary pane's own, asked for THIS pane
    // (its terminal, its session, never the active one), so the CLI rules stay
    // in terminal-ui.js and this file names no CLI; the reports go to this
    // pane's session through its own coalescer. Returns true when the wheel
    // belongs to the CLI: a gesture with no whole line or no measurable cell is
    // consumed too, as in the primary pane, so xterm never scrolls the stale
    // frames under a forwarding session. Shift fails the gate, so Shift+wheel
    // still scrolls the local scrollback (_maybeScrollLocalOnShift).
    _maybeForwardWheelToCli(ev) {
      if (this._destroyed || !this.terminal || !ev) return false;
      const app = global.app;
      const input = global.CodemanTerminalInput;
      if (!app?._shouldForwardWheelToApp || !input?.sgrWheelReports || !input.wheelDeltaWholeLines) return false;
      // xterm's own encoder forwards the wheel while the CLI's tracking reaches
      // it, and its alt-scroll owns the alternate buffer, as in the primary pane.
      const tracking = this.terminal.modes?.mouseTrackingMode;
      if (tracking && tracking !== 'none') return false;
      if (this.terminal.buffer?.active?.type === 'alternate') return false;
      if (!app._shouldForwardWheelToApp(ev, { terminal: this.terminal, sessionId: this.sessionId })) return false;
      // SGR coordinates address the live screen, so a report from a scrolled-up
      // viewport would hit-test another row: snap home first (_forwardScrollToApp).
      if (!app._terminalViewportAtBottom?.(this.terminal)) this.terminal.scrollToBottom?.();
      const lines = input.wheelDeltaWholeLines(ev, this.terminal.rows);
      const pos = app._clientPointToCell?.(ev.clientX, ev.clientY, this.terminal);
      const bytes = input.sgrWheelReports(lines, pos);
      if (bytes) this._queueScrollBytes(bytes);
      return true;
    }

    // Shift+wheel scrolls this xterm's local scrollback, the explicit "local
    // history" gesture, here as in the primary pane (whose capture-phase wheel
    // handler scrolls with terminal.scrollLines() for the same reason). Left to
    // xterm it was dead off macOS: Chrome on Windows sends Shift+wheel as a
    // HORIZONTAL wheel (deltaX), and xterm's own scroller turns a Shift+vertical
    // wheel into a horizontal one, so the viewport never moved. Reads the
    // dominant axis under Shift (wheelDeltaLines), keeps the sub-line remainder
    // for the next event (a trackpad's small deltas), and on the way up still
    // asks a shell pane for more history. Returns true when the wheel was
    // consumed here.
    _maybeScrollLocalOnShift(ev) {
      if (this._destroyed || !this.terminal || !ev?.shiftKey) return false;
      const input = global.CodemanTerminalInput;
      if (!input?.wheelDeltaLines) return false;
      // xterm's own encoder forwards the wheel while the CLI's tracking reaches
      // it, and its alt-scroll owns the alternate buffer, as in the primary pane.
      const tracking = this.terminal.modes?.mouseTrackingMode;
      if (tracking && tracking !== 'none') return false;
      if (this.terminal.buffer?.active?.type === 'alternate') return false;
      const total = this._shiftScrollPending + input.wheelDeltaLines(ev, this.terminal.rows);
      const lines = Math.trunc(total);
      this._shiftScrollPending = total - lines;
      if (lines) {
        this.terminal.scrollLines(lines);
        if (lines < 0) this._maybeLoadMoreHistory();
      }
      return true;
    }

    // A plain left-click reported to the CLI, the primary pane's desktop click
    // (terminal-ui.js _handleDesktopTerminalClick) aimed at this pane. The
    // server strips the mouse DECSETs of some modes (opencode's since #555, so a
    // drag selects text), which leaves this xterm's own mouse encoder idle for
    // them; without this a click in such a pane never reached the CLI. Only
    // while this pane's session has tracking on (cliMouseTracking), through the
    // same skips as the primary pane. Bubble phase, as there. The target is
    // built per click, so the terminal and the link hover are read live.
    _installClickListener() {
      this._onClick = (ev) => {
        if (this._destroyed || !this.terminal) return;
        global.app?._handleDesktopTerminalClick?.(ev, {
          terminal: this.terminal,
          sessionId: this.sessionId,
          linkHovered: this._linkHovered,
          // Like every mouse report from this pane (_onTerminalData): once,
          // never persisted, so a reload cannot replay it onto a later screen.
          ephemeral: true,
        });
      };
      this.mountEl.addEventListener('click', this._onClick);
    }

    // Hollow-buffer paging, the twin of the primary pane's
    // _maybePageCliTranscript (terminal-ui.js; keep the two in step). A CLI that
    // draws in place (opencode, on the alternate screen; Claude's repaint mode)
    // leaves this xterm no scrollback, so a wheel scrolled nothing; instead the
    // travel pages the CLI's own transcript with PageUp/PageDown. Every gate is
    // the primary pane's own, asked for THIS pane (its terminal, its session,
    // never the active one), so the CLI rules stay in terminal-ui.js and this
    // file names no CLI. Returns true when the wheel was consumed here.
    _maybePageCliTranscript(ev) {
      if (this._destroyed || !this.terminal || !ev || ev.shiftKey) return false;
      const app = global.app;
      const input = global.CodemanTerminalInput;
      if (!app || !input?.pageKeysForTravel || !input.wheelDeltaLines) return false;
      // xterm's own encoder forwards the wheel while the CLI's tracking reaches
      // it (a shell running htop), as in the primary pane.
      const tracking = this.terminal.modes?.mouseTrackingMode;
      if (tracking && tracking !== 'none') return false;
      const target = { terminal: this.terminal, sessionId: this.sessionId };
      // A wheel for Claude's fullscreen renderer was forwarded as SGR reports
      // before this ran (_maybeForwardWheelToCli); the gate is repeated so a
      // forwarding session is never paged.
      if (app._shouldForwardWheelToApp?.(ev, target)) return false;
      if (!app._localScrollbackIsHollow?.({ ...target, localRows: this._localRows() })) return false;
      // Only from the live screen. The one gate the primary pane never needs: a
      // primary hollow buffer has baseY 0, so its viewport is always at the
      // bottom, while a tile's is hollow with its own overflow rows still above
      // the screen, and Shift+PageUp, a scrollbar drag or a wheel during the
      // first replay can leave the viewport up there. Paging from there would
      // swallow every wheel (wheel-down included) and keep the stale rows on
      // screen while the CLI pages out of view; left to xterm, a wheel-down
      // brings the viewport home and paging resumes from there. The click
      // report refuses an off-bottom viewport for the same reason
      // (_terminalViewportAtBottom).
      if (!app._terminalViewportAtBottom?.(this.terminal)) return false;
      const lines = input.wheelDeltaLines(ev, this.terminal.rows);
      if (!lines) return false;
      const step = input.pageKeysForTravel(this._pageKeyPending, lines, this.terminal.rows);
      this._pageKeyPending = step.pending;
      if (step.keys) this._queueScrollBytes(step.keys);
      return true;
    }

    // Coalesces the scroll bytes (SGR wheel reports and page keys alike) into
    // one send per 40 ms, bounded at 512 bytes so a fling cannot build a backlog
    // that keeps scrolling after it stops. A narrow
    // twin of the primary pane's _queueScrollBytes / _flushWheelSgrQueue
    // (terminal-ui.js; keep the two in step), which flushes to the active
    // session only. Sent ephemeral (no seq, never persisted) to THIS pane's
    // session, over this pane's socket while it is open.
    _queueScrollBytes(data) {
      if (!data || this._destroyed) return;
      if (this._scrollBytes.length > 512) return;
      this._scrollBytes += data;
      if (this._scrollFlushTimer) return;
      this._scrollFlushTimer = setTimeout(() => {
        this._scrollFlushTimer = null;
        const bytes = this._scrollBytes;
        this._scrollBytes = '';
        if (bytes && !this._destroyed) global.app?._sendInputEphemeral?.(this.sessionId, bytes);
      }, 40);
    }

    // History rows in this xterm, for the paging gate: baseY less the rows this
    // pane pushed up itself. Clamped, because a clear (Ctrl+L) or an ED3/RIS in
    // the stream drops rows behind this count's back.
    _localRows() {
      const baseY = this.terminal?.buffer?.active?.baseY || 0;
      this._overflowRows = Math.min(this._overflowRows, baseY);
      return baseY - this._overflowRows;
    }

    // After a local resize: rows a shrinking fit pushed above the screen count
    // as overflow, and rows a growing one pulled back come off it. `before` is
    // baseY just before the resize (xterm resizes synchronously).
    _noteResizeRows(before) {
      const after = this.terminal?.buffer?.active?.baseY || 0;
      this._overflowRows = Math.max(0, Math.min(after, this._overflowRows + (after - before)));
    }

    // The overflow a finished load leaves: everything above the screen when the
    // capture held a single screen (the server says how tall in `captureRows`;
    // the full-history path keeps every pane row and trims one newline), none
    // when it carried history. The counterpart of the primary pane resizing the
    // PTY before it captures (app.js selectSession's sendResize), which this
    // pane does not do: its first capture is taken at the PTY's previous size
    // (usually the primary pane's, taller) and written into a shorter xterm,
    // whose extra rows land above the screen with nothing after them to clear
    // them. Without a `captureRows` the raw baseY stands, as in the primary.
    _overflowAfterLoad(payload) {
      const captureRows = payload?.captureRows;
      if (!Number.isFinite(captureRows)) return 0;
      const text = payload.terminalBuffer || '';
      let lines = 1;
      for (let i = text.indexOf('\n'); i !== -1 && lines <= captureRows; i = text.indexOf('\n', i + 1)) lines++;
      if (lines > captureRows) return 0;
      return this.terminal?.buffer?.active?.baseY || 0;
    }

    // Wheel-up at the top of a SHELL pane's scrollback. tmux repaints a burst of
    // output (`cat` of a file longer than the screen) instead of scrolling it,
    // so this pane's xterm ends up with about one screen of scrollback while
    // tmux holds every line, and without this pull the history is
    // unreachable. The primary pane has the same pull
    // (app.js _maybeRefetchFullHistory); a tile is a separate xterm and needs
    // its own. Shell only: a non-shell CLI's history is out of scope for this
    // pull (its load already takes `full=1`; codex and Claude's inline renderer
    // do grow tmux history, this just isn't how they recover it). The
    // alternate-screen skip (nano, vim, less) only matters for a direct-PTY
    // shell: under tmux the browser xterm never enters the alternate buffer.
    _maybeLoadMoreHistory() {
      if (this.sessionMode !== 'shell' || this._destroyed || !this.terminal) return;
      if (this._bufferLoading) return;
      // Mirrors app.js _maybeRefetchFullHistory and this pane's own
      // _sendResize(): a detached session's own window already owns its PTY
      // size and scrollback, so this pane has nothing of its own to reconcile.
      if (this.detachedSessions?.has(this.sessionId)) return;
      const active = this.terminal.buffer.active;
      if (active.type !== 'normal' || active.viewportY !== 0) return;
      // Momentum scrolling fires this dozens of times per flick, so cooldown
      // rather than latch; a pull that could only have downgraded the pane
      // waits far longer.
      const cooldown = this._historyPullUseless ? 60000 : 4000;
      const now = Date.now();
      if (now - this._historyPullAt < cooldown) return;
      this._historyPullAt = now;
      this._bufferLoading = true;
      void this._runLoad('history', () => this._pullHistory());
    }

    // Pulls a BOUNDED window of tmux's full history (the same TERMINAL_TAIL_SIZE
    // a tab switch loads, so a multi-megabyte capture never lands on xterm's
    // main thread) and replays it under the reader's current place. Holds the
    // single-flight flag across the fetch AND the replay, like _loadBuffer().
    async _pullHistory() {
      this._bufferLoading = true;
      if (this._destroyed) {
        this._endBufferLoad();
        return;
      }
      this._loadRunning = true;
      let replayed = false;
      let capturedAt = 0;
      // Two budgets on one signal. The request itself gets the primary pane's
      // (CodemanFetchDeadline, constants.js): live output is not held while it
      // runs, but the single-flight flag is, so a coalesced `{t:'r'}` refresh and
      // the marker owed by a close (_onSocketClosed()) both wait for it, at worst
      // for that whole budget. Once the headers land live output IS held, so the
      // body read gets the short one instead: a body that hangs would otherwise
      // freeze the pane for the long budget. Aborting lands in the catch below,
      // which releases the flag and the queue. AbortSignal.timeout() alone cannot
      // be re-armed, hence the controller; without AbortController the pull
      // simply has no deadline.
      const controller = global.AbortController ? new global.AbortController() : null;
      this._loadAbort = controller;
      let abortTimer = null;
      const armDeadline = (ms) => {
        if (!controller) return;
        clearTimeout(abortTimer);
        abortTimer = setTimeout(() => controller.abort(), ms);
      };
      try {
        armDeadline(global.CodemanFetchDeadline?.terminalFetchDeadlineMs?.({ full: true }) ?? HISTORY_PULL_TIMEOUT_MS);
        const res = await fetch(
          `/api/sessions/${this.sessionId}/terminal?full=1&tail=${TERMINAL_TAIL_SIZE}${this._historyLinesQuery()}`,
          { signal: controller?.signal }
        );
        armDeadline(HISTORY_PULL_TIMEOUT_MS);
        // The cutoff below is the response's arrival, the same `since` rule the
        // primary pane uses (_finishBufferLoad). It is a client clock standing in
        // for the instant tmux took the capture, which lies somewhere in the
        // round trip, so a frame in that window can be lost or doubled. Bounded
        // by one round trip and not closable without a server-side capture time.
        capturedAt = performance.now();
        // Opened only now: a frame from before the response is either replaced by
        // the capture or written unchanged, so holding it for the round trip
        // would buy nothing and freeze the pane for as long as the fetch took.
        this._openLiveQueue();
        const payload = (await res.json())?.data;
        clearTimeout(abortTimer);
        const buffer = payload?.terminalBuffer;
        const term = this.terminal;
        if (!buffer || !term || this._destroyed) return;
        const rowsBefore = term.buffer.active.length;
        const rowsIncoming = global.app?._estimateReplayRows?.(buffer, term.cols) ?? buffer.split('\n').length;
        // xterm keeps at most `scrollback + rows` rows while tmux keeps far more
        // lines, so a window of short lines can carry more rows than this pane
        // can ever hold, and `rowsIncoming <= rowsBefore` would never come true.
        const scrollbackCap = term.options?.scrollback || 0;
        const paneFull = scrollbackCap > 0 && rowsBefore >= scrollbackCap + term.rows;
        // Nothing to gain (this also covers a downgrade, which would delete
        // history mid-scroll), and a reset+rewrite would jump the viewport. An
        // untruncated window IS all of tmux's history and the next burst can add
        // more, so keep the 4 s cooldown. A truncated window can never reach past
        // what the pane shows, and every ask costs the server a capture-pane of
        // the whole history (`tail` is cut after it): back off to 60 s, as the
        // primary pane does (app.js _maybeRefetchFullHistory). A full pane backs
        // off too, since no window can ever fit in it.
        if (rowsIncoming <= rowsBefore || paneFull) {
          if (payload.truncated || paneFull) this._historyPullUseless = true;
          return;
        }
        this._historyPullUseless = false;
        term.write('\x1bc');
        this._overflowRows = 0; // the reset leaves nothing above the screen
        replayed = true;
        if (this._wsClosed) this._markerOwed = true;
        await writeChunked(
          term,
          buffer,
          () => this._destroyed,
          (cancel) => (this._cancelReplay = cancel)
        );
        if (this._destroyed || !this.terminal) return;
        // xterm parses asynchronously: an empty write's callback fires only
        // after everything before it, so the row count below is the settled one.
        await new Promise((resolve) => this.terminal.write('', resolve));
        if (this._destroyed || !this.terminal) return;
        // The replay grew the buffer UPWARD, so what was row 0 is now `delta`
        // rows down; land there and the recovered history sits above it.
        const delta = this.terminal.buffer.active.length - rowsBefore;
        if (delta > 0) this.terminal.scrollToLine(delta);
        else this.terminal.scrollToTop();
      } catch {
        /* Best-effort: live output keeps arriving whatever happens here. */
      } finally {
        clearTimeout(abortTimer);
        this._loadAbort = null;
        this._loadRunning = false;
        // After a replay, only frames that arrived after the capture are news;
        // earlier ones are already in it. With no replay, every held frame is.
        this._flushLiveQueue(replayed ? capturedAt : 0);
        // Settled after the queue flush so the marker is the last thing on
        // screen: a close during the pull wrote nothing (_onSocketClosed() defers
        // it while a load runs), and a replay's own `\x1bc` (flagged above) wipes
        // one written before it, which would paint a fresh, current-looking
        // history while onData keeps silently dropping every keystroke on the
        // dead socket. With a trailing refresh pending (_endBufferLoad) the marker
        // is left to that refresh, which writes it below its own replay.
        this._stampMarkerIfOwed();
        this._endBufferLoad();
      }
    }

    // A bounded load's `lines=` (grid tiles): tmux history beyond what this
    // xterm keeps (its scrollback plus the screen) would only be captured to be
    // thrown away, and a full capture is synchronous work on the server, about
    // 0.7 s for a 30k-line history. Unbounded panes (the split's Pane B) ask
    // for everything, as before.
    _historyLinesQuery() {
      if (!this.boundedLoad || !Number.isFinite(this.scrollback)) return '';
      return `&lines=${this.scrollback + (this.terminal?.rows || 0)}`;
    }

    // The refresh path (`{t:'r'}`, `{t:'c'}`, a reconnect): fetch, then reset
    // in-stream and replay (_loadBuffer). Two refresh frames in a row must not
    // start two concurrent replays, each resetting the terminal under the
    // other's chunked write. A refresh that arrives mid-replay is COALESCED
    // into one trailing re-run rather than ignored: the in-flight fetch may
    // predate the drop the new frame is reporting, and no further frame is
    // coming to correct stale content.
    _refreshBuffer() {
      if (this._bufferLoading) {
        this._bufferRefreshPending = true;
        return;
      }
      void this._loadBuffer({ refresh: true });
    }

    // Local reflow only, no PTY resize frame. Split out so a divider drag
    // can reflow the panes at the browser's paint rate (rAF) while sending
    // the actual `{t:'z'}` resize once, at drag end, matching the primary
    // pane's own convention (throttledResize in terminal-ui.js).
    localFit() {
      if (!this.fitAddon) return;
      const before = this.terminal?.buffer?.active?.baseY || 0;
      this.fitAddon.fit();
      this._noteResizeRows(before);
    }

    // Reflow to the container and tell the PTY, as one step: the xterm and the
    // PTY must never disagree about size (#464), and a font change is a size
    // change too, so the font setters call this rather than localFit().
    // `force` resends an unchanged size and asks the server to apply it anyway
    // (Redraw, restoreTerminalSize). Returns whether a resize went out.
    fit({ force = false } = {}) {
      this.localFit();
      return this._sendResize({ force });
    }

    // Returns true only once a `{t:'z'}` frame was sent, false at every early
    // exit, so Redraw can say when nothing reached the PTY.
    _sendResize({ force = false } = {}) {
      if (!this._wsReady || !this.fitAddon || !this.terminal) return false;
      // One PTY cannot hold two sizes (mirrors sendResize's own
      // detachedElsewhere yield in terminal-ui.js): the session got detached
      // to its own window AFTER this pane was opened, so its own window now
      // owns the PTY's size and this pane must stand aside.
      if (this.detachedSessions?.has(this.sessionId)) return false;
      // A hidden pane (a web tab over it, a zoomed neighbour) measures NaN, and
      // fit() then leaves the xterm alone: there is no size worth reporting.
      const dims = this.fitAddon.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return false;
      // Report what the xterm actually holds, so the PTY gets exactly the size
      // the pane renders at. Unclamped, unlike the primary pane's 40x10 floor:
      // a floor would misreport the split's Pane B at its divider's reachable
      // 20% position (about 28 columns) and wrap output wrongly, and a floored
      // xterm would be wider than its container. The server enforces
      // its own valid range ([1,500]/[1,200] in ws-routes.ts).
      const cols = this.terminal.cols;
      const rows = this.terminal.rows;
      const last = this._lastSentDims;
      if (!force && last && last.cols === cols && last.rows === rows) return false;
      // `f` is the primary pane's forced resize (sendResize, terminal-ui.js):
      // Session.resize (session.ts) otherwise skips a size equal to the one it
      // last applied, so without it a forced resend reached the server and did
      // nothing there (no tmux resize-window, no PTY resize).
      const msg = { t: 'z', c: cols, r: rows, v: 'desktop' };
      if (force) msg.f = true;
      try {
        this.ws.send(JSON.stringify(msg));
      } catch {
        return false; // nothing went out, so nothing is recorded as sent
      }
      this._lastSentDims = { cols, rows };
      return true;
    }

    // The session's PTY is new: a tile can connect before its session has a
    // pane (one Run started while the grid is open joins first), and the
    // server drops a resize that arrives with no PTY, then spawns at its own
    // default size. Forget what was sent, so the size goes out now, or with
    // the next fit() when this tile is hidden right now (a zoomed neighbour):
    // _sendResize() returns before recording anything it did not send.
    paneStarted() {
      this._lastSentDims = null;
      this._sendResize();
    }

    // The geometry the PTY actually holds (`{t:'zc'}`, the server's answer to
    // every resize). A PTY and a terminal that disagree on WIDTH render
    // garbled, so a different column count is adopted; rows stay local, as in
    // the primary pane (_onPtyGeometryReport in terminal-ui.js, #464). The
    // pure verdict is the primary's too (reconcilePtyGeometry, constants.js).
    _onPtyGeometryReport(cols, rows) {
      const terminal = this.terminal;
      if (!terminal) return;
      const verdict = global.CodemanTerminalGeometry?.reconcilePtyGeometry?.(
        { cols: terminal.cols, rows: terminal.rows },
        { cols, rows }
      );
      if (!verdict?.adopt) return;
      const before = terminal.buffer?.active?.baseY || 0;
      terminal.resize(verdict.cols, terminal.rows);
      this._noteResizeRows(before); // a column change reflows rows above the screen
      this._lastSentDims = { cols: verdict.cols, rows: terminal.rows };
    }

    destroy() {
      this._destroyed = true;
      // Anything still queued for this session stays in the app's queue and is
      // delivered over HTTP by the redelivery sweep, so closing the pane mid-
      // keystroke loses nothing.
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      // A load still fetching would otherwise hold the owner's queue (and the
      // server's attention) for a pane nobody can see any more.
      try {
        this._loadAbort?.abort();
      } catch {
        /* Already settled. */
      }
      this._loadAbort = null;
      // Likewise a replay still parsing: the xterm is disposed below, so the
      // write callback it waits for would never come.
      this._cancelReplay?.();
      this._cancelReplay = null;
      if (this._onWheel) {
        this.mountEl?.removeEventListener('wheel', this._onWheel, { capture: true });
        this._onWheel = null;
      }
      if (this._onClick) {
        this.mountEl?.removeEventListener('click', this._onClick);
        this._onClick = null;
      }
      // A disposed xterm never runs its write callbacks, and a pending
      // recovery would refresh a pane nobody can see.
      this._resetLiveFlow();
      // Page keys still waiting for their flush go nowhere: the pane is gone.
      clearTimeout(this._scrollFlushTimer);
      this._scrollFlushTimer = null;
      this._scrollBytes = '';
      this._pageKeyPending = 0;
      this._detachSocket();
      if (this._onFocusIn) {
        this.terminal?.textarea?.removeEventListener('focus', this._onFocusIn);
        this._onFocusIn = null;
      }
      // Before dispose(): puts xterm's own textarea diff back and takes the
      // controller's listeners off the textarea; its pending timers are inert
      // once it is destroyed.
      this._destroyKeyCode229Recovery();
      // A destroyed pane cannot hold the keyboard: shortcuts fall back to the
      // primary terminal (_focusedPane also skips a destroyed tile on its own).
      if (global.app?._focusedTile === this) global.app._noteFocusedTile?.(null);
      if (this.terminal) {
        this.terminal.dispose();
        this.terminal = null;
      }
      this.fitAddon = null;
    }
  }

  // Code units of live output a pane lets sit unparsed in its xterm (or held
  // behind a replay) before it drops a frame and recaptures (_writeLive). Not
  // the primary pane's 128 KB: that caps its own rAF-paced queues, about two
  // frames of them, while here xterm itself is the pacer, a burst normally
  // parses within a frame or two, and a tight cap would trip on ordinary
  // bursts and blank-and-reload the tile over and over. A few MB keeps a flood
  // far below xterm's 50M code-unit throw and bounds each tile's memory.
  TerminalTile.LIVE_BACKLOG_BUDGET = 4 * 1024 * 1024;

  // The marker a pane writes when its socket drops: a transient drop says it is
  // reconnecting; a permanent stop says why, keyed by close code. All start
  // with `[disconnected` so a reader (and a test) can tell any of them apart
  // from session output.
  TerminalTile.MARKER_RECONNECTING = '[disconnected, reconnecting…]';
  TerminalTile.STOP_MARKERS = {
    4003: '[disconnected: the server refused this connection]',
    4004: '[disconnected: the session ended]',
    4009: '[disconnected: the session ended]',
    4010: '[disconnected: another connection took over this pane]',
  };

  /**
   * ONE queue for every capture a set of tiles fetches (`GET
   * /api/sessions/:id/terminal`): the initial load, the refresh after a
   * reconnect, a server `{t:'r'}` refresh and the shell history pull. Each
   * capture runs synchronous tmux calls on the server, so N of them at once do
   * not run in parallel, they stall every WebSocket and SSE stream on it back to
   * back. After a deploy restart all N tiles reopen within the same second; this
   * drains their refreshes one at a time.
   *
   * Concurrency 1. Next up is a history pull (the user is waiting on it), then
   * the lowest `rank(tile)` (the grid ranks the focused tile first, then reading
   * order), then arrival order. A destroyed tile's entries are dropped, never run.
   * DOM-free, so the grid owns the policy and tests drive it directly.
   */
  class TileLoadQueue {
    /**
     * @param {{rank?: (tile: object) => number, onChange?: (tile: object, state: 'queued'|'running'|'idle') => void}} [opts]
     */
    constructor(opts = {}) {
      this._rank = typeof opts.rank === 'function' ? opts.rank : () => 0;
      this._onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
      this._pending = [];
      this._active = null;
      this._seq = 0;
    }

    /** The `scheduleLoad` a TerminalTile takes. Resolves once `run` finished or was dropped; never rejects. */
    schedule(tile, kind, run) {
      return new Promise((resolve) => {
        this._pending.push({ tile, kind, run, resolve, seq: this._seq++ });
        this._notify(tile, 'queued');
        this._pump();
      });
    }

    /** Drops every load still waiting for `tile` (the running one, if any, finishes on its own). */
    drop(tile) {
      const keep = [];
      for (const entry of this._pending) {
        if (entry.tile === tile) entry.resolve();
        else keep.push(entry);
      }
      this._pending = keep;
      if (this._active?.tile !== tile) this._notify(tile, 'idle');
    }

    /** How many loads are waiting (not counting the running one). */
    get size() {
      return this._pending.length;
    }

    /** The tile whose load is running, or null. */
    get activeTile() {
      return this._active?.tile ?? null;
    }

    _notify(tile, state) {
      try {
        this._onChange?.(tile, state);
      } catch {
        /* A display callback never stops the queue. */
      }
    }

    _takeNext() {
      let best = -1;
      let bestKey = null;
      for (let i = 0; i < this._pending.length; i++) {
        const entry = this._pending[i];
        if (entry.tile?._destroyed) continue;
        const key = [entry.kind === 'history' ? 0 : 1, this._rank(entry.tile), entry.seq];
        const order = bestKey ? key[0] - bestKey[0] || key[1] - bestKey[1] || key[2] - bestKey[2] : -1;
        if (order < 0) {
          best = i;
          bestKey = key;
        }
      }
      // Destroyed tiles' entries go now, resolved but never run.
      const dropped = this._pending.filter((entry) => entry.tile?._destroyed);
      const next = best === -1 ? null : this._pending[best];
      this._pending = this._pending.filter((entry) => entry !== next && !entry.tile?._destroyed);
      for (const entry of dropped) entry.resolve();
      return next;
    }

    async _pump() {
      if (this._active) return;
      const entry = this._takeNext();
      if (!entry) return;
      this._active = entry;
      this._notify(entry.tile, 'running');
      try {
        await entry.run();
      } catch {
        /* A load settles its own failure; the queue only moves on. */
      } finally {
        this._active = null;
        const stillQueued = this._pending.some((e) => e.tile === entry.tile);
        this._notify(entry.tile, stillQueued ? 'queued' : 'idle');
        entry.resolve();
        void this._pump();
      }
    }
  }

  global.TerminalTile = TerminalTile;
  global.TileLoadQueue = TileLoadQueue;
})(window);
