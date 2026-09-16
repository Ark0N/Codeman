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
      const cols = Math.max(dims.cols, 40);
      const rows = Math.max(dims.rows, 10);
      this.ws.send(JSON.stringify({ t: 'z', c: cols, r: rows, v: 'desktop' }));
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
