// src/web/public/terminal-split.js

/**
 * @fileoverview SplitTerminalPane — a second, independent live terminal pane
 * ("Pane B") for split-view sessions. Deliberately plainer than the primary
 * pane (this.terminal/this._ws in terminal-ui.js): no local-echo overlay, no
 * CJK IME, no touch/mobile handlers, no keyboard accessory bar. Desktop-only
 * feature by nature — see docs/superpowers/specs/2026-09-15-split-pane-sessions-design.md.
 *
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js
 * @dependency terminal-ui.js (window.CodemanTerminalFont, codemanCurrentXtermTheme, codemanCurrentSkinIsLight)
 * @loadorder 7.5 of 16 — loaded after terminal-ui.js, before respawn-ui.js
 */

(function (global) {
  class SplitTerminalPane {
    constructor(sessionId, mountEl) {
      this.sessionId = sessionId;
      this.mountEl = mountEl;
      this.terminal = null;
      this.fitAddon = null;
      this.ws = null;
      this._wsReady = false;
    }

    connect() {
      this.terminal = new Terminal({
        theme: { ...global.codemanCurrentXtermTheme() },
        fontFamily: global.CodemanTerminalFont.resolve(),
        ...global.CodemanTerminalFont.resolveWeights({}),
        fontSize: 14,
        lineHeight: 1.2,
        cursorBlink: false,
        cursorStyle: 'block',
        minimumContrastRatio: global.codemanCurrentSkinIsLight() ? 4.5 : 1,
        scrollback: 5000,
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
      // resizing until the parent recreates the pane.
      this.ws.onclose = () => {
        this._wsReady = false;
      };

      this.ws.onerror = () => {
        // onclose fires after onerror — cleanup happens there.
      };
    }

    fit() {
      if (!this.fitAddon) return;
      this.fitAddon.fit();
      this._sendResize();
    }

    _sendResize() {
      if (!this._wsReady || !this.fitAddon) return;
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
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
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
      this.activeSessionId
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
            `<div class="split-picker-item" data-session-id="${escapeHtml(c.id)}" onclick="app.openSplitPane(${escapeHtml(JSON.stringify(c.id))}); app._dismissSplitPicker();">${escapeHtml(c.label)}</div>`
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
    // A stale picker click (opened before switching tabs) or clicking Pane
    // B's own session tab while split can otherwise land here with
    // sessionId === activeSessionId: two live WebSockets to the same
    // session, each independently claiming PTY dimensions via its own `{t:'z',...}`
    // resize frame. Refuse before creating any DOM or SplitTerminalPane.
    if (sessionId === this.activeSessionId) return;
    if (this._splitPane) this.closeSplitPane();

    const wrap = document.querySelector('.terminal-wrap');
    const parent = wrap.parentElement;

    const container = document.createElement('div');
    container.className = 'terminal-split-container';

    const divider = document.createElement('div');
    divider.className = 'split-divider';

    const paneB = document.createElement('div');
    paneB.className = 'terminal-pane-b';
    const session = this.sessions.get(sessionId);
    paneB.innerHTML = `
      <div class="terminal-pane-b-header">
        <span>${escapeHtml(session?.name || 'Session')}</span>
        <span class="terminal-pane-b-close" onclick="app.closeSplitPane()">&times;</span>
      </div>
      <div class="terminal-pane-b-container"></div>
    `;

    parent.insertBefore(container, wrap);
    container.appendChild(wrap);
    wrap.style.flexBasis = '50%';
    container.appendChild(divider);
    container.appendChild(paneB);
    paneB.style.flexBasis = '50%';

    this._splitPane = new window.SplitTerminalPane(sessionId, paneB.querySelector('.terminal-pane-b-container'));
    this._splitPane.connect();
    this._splitSessionId = sessionId;

    this._installSplitDividerDrag(divider, wrap, paneB);
  },

  closeSplitPane() {
    if (!this._splitPane) return;
    this._splitPane.destroy();
    this._splitPane = null;
    this._splitSessionId = null;

    const container = document.querySelector('.terminal-split-container');
    if (!container) return;
    const wrap = container.querySelector('.terminal-wrap');
    const parent = container.parentElement;
    wrap.style.flexBasis = '';
    parent.insertBefore(wrap, container);
    container.remove();

    if (this.fitAddon) this.fitAddon.fit();
    this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});
  },

  _installSplitDividerDrag(divider, wrap, paneB) {
    let dragging = false;

    const onMove = (e) => {
      if (!dragging) return;
      const container = divider.parentElement;
      const rect = container.getBoundingClientRect();
      const rawPercent = ((e.clientX - rect.left) / rect.width) * 100;
      const percent = window.CodemanSplitPane.clampDividerPercent(rawPercent);
      wrap.style.flexBasis = `${percent}%`;
      paneB.style.flexBasis = `${100 - percent}%`;
      if (this.fitAddon) this.fitAddon.fit();
      this._splitPane?.fit();
    };

    const onUp = () => {
      dragging = false;
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    divider.addEventListener('mousedown', () => {
      dragging = true;
      divider.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  },
});

const _originalOnSessionDeleted = CodemanApp.prototype._onSessionDeleted;
CodemanApp.prototype._onSessionDeleted = function (data) {
  if (this._splitSessionId === data.id) {
    this.closeSplitPane();
  } else if (this._splitPane && this.activeSessionId === data.id) {
    // Pane A's session ended: promote Pane B by closing the split and
    // selecting its session as the new (single) active pane.
    const promoted = this._splitSessionId;
    this.closeSplitPane();
    if (promoted) this.selectSession(promoted);
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
