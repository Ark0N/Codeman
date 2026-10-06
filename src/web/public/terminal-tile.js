// src/web/public/terminal-tile.js

/**
 * @fileoverview TerminalTile: one independent live terminal pane bound to one
 * session, with its own xterm instance and its own
 * `/ws/sessions/:id/terminal` WebSocket. The split pane (terminal-split.js)
 * uses one as its second pane ("Pane B"); the tile grid planned in
 * docs/tile-grid-plan.md reuses the same class for every tile.
 *
 * Deliberately plainer than the primary pane (this.terminal/this._ws in
 * terminal-ui.js): no local-echo overlay, no CJK IME, no touch/mobile
 * handlers, no keyboard accessory bar. Desktop-only by nature; see
 * docs/split-pane-sessions-plan.md.
 *
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js
 * @dependency constants.js (window.CodemanTerminalFont, DEFAULT_SCROLLBACK, TERMINAL_TAIL_SIZE, TERMINAL_CHUNK_SIZE)
 * @dependency terminal-ui.js (codemanCurrentXtermTheme, codemanCurrentSkinIsLight)
 * @loadorder 7.4 of 16, loaded after terminal-ui.js and before terminal-split.js
 */

(function (global) {
  // How long a scroll-to-top history pull may hold Pane B's live output.
  const HISTORY_PULL_TIMEOUT_MS = 10000;

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

  class TerminalTile {
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
      this._wsClosed = false;
      this._destroyed = false;
      // Single-flight state for _loadBuffer()/_refreshBuffer() below.
      this._bufferLoading = false;
      this._bufferRefreshPending = false;
      // Scroll-to-top history pull (shell panes only), see _maybeLoadMoreHistory().
      // `_liveQueue` is non-null from the pull's response until its finally
      // block: live frames are held there with their arrival time instead of
      // written under the replay. `_markerOwed` is the "disconnected" marker a
      // load still has to write (see _onSocketClosed()/_stampMarkerIfOwed()).
      this._historyPullAt = 0;
      this._historyPullUseless = false;
      this._liveQueue = null;
      this._markerOwed = false;
      this._onWheel = null;
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

      this._installWheelListener();

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
            this._onLiveOutput(msg.d);
          } else if (msg.t === 'c') {
            this._onLiveClear();
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
      this.ws.onclose = () => this._onSocketClosed();

      this.ws.onerror = () => {
        // onclose fires after onerror — cleanup happens there.
      };
    }

    // The socket's close, split out of connect() so the tests can drive it.
    // While any load runs (a history pull or a `{t:'r'}` refresh) the marker is
    // only owed, and that load's finally block settles it (_stampMarkerIfOwed()):
    // written now, it would sit above the output a pull is still holding (flushed
    // after it on a skip, a downgrade or a failed fetch), above a refresh's
    // replay, or in the middle of a chunked replay. A pull still waiting for its
    // response holds the marker too, for as long as the request takes (up to its
    // budget, see _pullHistory()).
    _onSocketClosed() {
      this._wsReady = false;
      this._wsClosed = true;
      if (this._bufferLoading) this._markerOwed = true;
      else this._writeDisconnectedMarker();
    }

    // Settles a marker the pane owes: set when a close lands during a load (the
    // replay would otherwise sit below it) or when a load wipes the terminal on
    // a closed socket. Called from each load's own finally, just before
    // _endBufferLoad() starts any trailing refresh.
    _stampMarkerIfOwed() {
      // A trailing refresh is about to clear() synchronously, while xterm parses
      // a write() on a later tick: a marker written here would land in the
      // freshly cleared buffer ABOVE that refresh's replay, a second, stale copy.
      // The refresh re-owes the marker on a closed socket and stamps it itself.
      if (this._bufferRefreshPending && !this._destroyed) return;
      const owed = this._markerOwed;
      this._markerOwed = false;
      if (owed && this._wsClosed && !this._destroyed) this._writeDisconnectedMarker();
    }

    // Extracted so both _onSocketClosed() and a load that ends owing it on a
    // closed socket can write it (see _stampMarkerIfOwed()).
    _writeDisconnectedMarker() {
      this.terminal?.write('\r\n\x1b[2m[Pane B disconnected — close and reopen the split to reconnect]\x1b[0m\r\n');
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
        this._stampMarkerIfOwed();
        this._endBufferLoad();
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

    // Live terminal output. Written straight through, except while a history
    // pull is replaying: a capture is current only up to the instant tmux took
    // it, so a frame arriving mid-replay is held with its arrival time and
    // replayed behind the snapshot by _pullHistory() (the primary pane's
    // _finishBufferLoad `since` rule), never written underneath it.
    _onLiveOutput(data) {
      if (this._liveQueue) this._liveQueue.push({ at: performance.now(), data });
      else this.terminal?.write(data);
    }

    // The server's `{t:'c'}` clear frame takes the same route as output, for the
    // same reason: clearing straight away, mid-replay, would wipe the half-written
    // snapshot and leave _pullHistory() measuring a buffer that is no longer the
    // one it is restoring. Queued, it lands in order with the frames around it.
    _onLiveClear() {
      if (this._liveQueue) this._liveQueue.push({ at: performance.now(), clear: true });
      else this.terminal?.clear();
    }

    // Capture phase, because xterm's own wheel handler stopPropagation()s every
    // event it consumes, so a bubbling listener here would never see the wheel
    // while the pane still has scrollback to scroll. Passive: this only observes,
    // xterm keeps doing the scrolling.
    _installWheelListener() {
      this._onWheel = (ev) => {
        if (ev.deltaY < 0) this._maybeLoadMoreHistory();
      };
      this.mountEl.addEventListener('wheel', this._onWheel, { capture: true, passive: true });
    }

    // Wheel-up at the top of a SHELL pane's scrollback. tmux repaints a burst of
    // output (`cat` of a file longer than the screen) instead of scrolling it,
    // so this pane's xterm ends up with about one screen of scrollback while
    // tmux holds every line — and nothing here ever went back to ask, so the
    // history was unreachable. The primary pane has the same pull
    // (app.js _maybeRefetchFullHistory); Pane B is a separate xterm and needs its
    // own. Shell only: a non-shell CLI's history is out of scope for this pull
    // (its load already takes `full=1`; codex and Claude's inline renderer do
    // grow tmux history, this just isn't how they recover it). The alternate-
    // screen skip (nano, vim, less) only matters for a direct-PTY shell — under
    // tmux the browser xterm never enters the alternate buffer.
    _maybeLoadMoreHistory() {
      if (this.sessionMode !== 'shell' || this._destroyed || !this.terminal) return;
      if (this._bufferLoading) return;
      // Mirrors app.js _maybeRefetchFullHistory and this pane's own
      // _sendResize(): a detached session's own window already owns its PTY
      // size and scrollback, so Pane B has nothing of its own to reconcile.
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
      void this._pullHistory();
    }

    // Pulls a BOUNDED window of tmux's full history (the same TERMINAL_TAIL_SIZE
    // a tab switch loads, so a multi-megabyte capture never lands on xterm's
    // main thread) and replays it under the reader's current place. Holds the
    // single-flight flag across the fetch AND the replay, like _loadBuffer().
    async _pullHistory() {
      this._bufferLoading = true;
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
      let abortTimer = null;
      const armDeadline = (ms) => {
        if (!controller) return;
        clearTimeout(abortTimer);
        abortTimer = setTimeout(() => controller.abort(), ms);
      };
      try {
        armDeadline(global.CodemanFetchDeadline?.terminalFetchDeadlineMs?.({ full: true }) ?? HISTORY_PULL_TIMEOUT_MS);
        const res = await fetch(`/api/sessions/${this.sessionId}/terminal?full=1&tail=${TERMINAL_TAIL_SIZE}`, {
          signal: controller?.signal,
        });
        armDeadline(HISTORY_PULL_TIMEOUT_MS);
        // The cutoff below is the response's arrival, the same `since` rule the
        // primary pane uses (_finishBufferLoad). It is a client clock standing in
        // for the instant tmux took the capture, which lies somewhere in the
        // round trip, so a frame in that window can be lost or doubled. Bounded
        // by one round trip and not closable without a server-side capture time.
        capturedAt = performance.now();
        // Opened only now: a frame from before the response is either replaced by
        // the capture or written unchanged, so holding it for the round trip
        // bought nothing and froze the pane for as long as the fetch took.
        this._liveQueue = [];
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
        replayed = true;
        if (this._wsClosed) this._markerOwed = true;
        await writeChunked(term, buffer, () => this._destroyed);
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
        /* Best-effort — live output keeps arriving whatever happens here. */
      } finally {
        clearTimeout(abortTimer);
        const queued = this._liveQueue ?? [];
        this._liveQueue = null;
        // After a replay, only frames that arrived after the capture are news;
        // earlier ones are already in it. With no replay, every held frame is.
        const cutoff = replayed ? capturedAt : 0;
        for (const entry of queued) {
          if (entry.at < cutoff) continue;
          if (entry.clear) this.terminal?.clear();
          else this.terminal?.write(entry.data);
        }
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
      // The clear wipes a "disconnected" marker (a `{t:'r'}` frame can queue a
      // trailing refresh behind a pull that the socket's close then interrupts),
      // so a refresh on a closed socket owes it back once its replay is written.
      if (this._wsClosed) this._markerOwed = true;
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
      if (this._onWheel) {
        this.mountEl?.removeEventListener('wheel', this._onWheel, { capture: true });
        this._onWheel = null;
      }
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

  global.TerminalTile = TerminalTile;
})(window);
