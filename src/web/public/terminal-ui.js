/**
 * @fileoverview Terminal setup (xterm.js config, input, resize, link provider), rendering pipeline
 * (batch writes, flicker filter, chunked writes, local echo), terminal controls (clear, font, resize),
 * and directory input.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.terminal, this.fitAddon, this.sessions)
 * @dependency constants.js (DEC_SYNC_STRIP_RE, TIMING constants)
 * @dependency mobile-handlers.js (MobileDetection)
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js, vendor/xterm-addon-webgl.js
 * @dependency vendor/xterm-zerolag-input.js (LocalEchoOverlay)
 * @loadorder 7 of 15 — loaded after app.js, before respawn-ui.js
 */

(function (global) {
  const TERMINAL_QUERY_RESPONSE_PATTERN = /^\x1b\[[\?>=]?[\d;]*[cnR]$/;
  const TERMINAL_OSC_RESPONSE_PATTERN = /^\x1b\][\d;]*[^\x07\x1b]*(?:\x07|\x1b\\)$/;
  // Pointer and focus reports xterm emits through onData on the terminal's OWN
  // initiative, with no key pressed: SGR mouse (DECSET 1006, also 1016), legacy
  // X10 mouse (DECSET 1000 — three raw bytes after CSI M) and focus in/out
  // (DECSET 1004). They are not query REPLIES, so the query-response filter
  // above does not match them, and they must keep reaching the PTY. What they
  // must NOT do is stand in for a keystroke: see isTerminalFocusOrMouseReport.
  const MOUSE_SGR_REPORT_PATTERN = /^\x1b\[<\d+;\d+;\d+[Mm]$/;
  const MOUSE_X10_REPORT_PATTERN = /^\x1b\[M[\s\S]{3}$/;
  const FOCUS_REPORT_PATTERN = /^\x1b\[[IO]$/;
  // Grace window after a manual scroll-up gesture during which sticky-scroll is
  // suppressed, so high-frequency Codex status redraws don't snap the viewport
  // back to the bottom while the user is inspecting earlier output.
  const USER_SCROLL_STICKY_SUPPRESS_MS = 1500;
  // Mobile browsers synthesize trusted mouse events after touchend. During this
  // short window, only the app's synthetic tap-to-position mouse event should
  // reach xterm.
  const TOUCH_COMPAT_MOUSE_SUPPRESS_MS = 450;
  // Finger travel (px) still counted as a tap rather than a scroll. Shared by
  // the terminal's own touch handling (TAP_THRESHOLD, initTerminal) and the
  // keyboard-dismiss handler (_installMobileKeyboardDismiss), which MUST agree:
  // a gesture the terminal treats as a scroll but the dismiss handler treats as
  // a tap would close the keyboard mid-scroll and drop the composer.
  const MOBILE_KEYBOARD_DISMISS_TAP_SLOP = 8;
  // Hold this long, finger still, before a press becomes a text selection.
  //
  // ⚠️ It must fire well BEFORE the platform's own long-press threshold (~500ms on
  // Android), not just under it: the guards this gesture installs are armed when it
  // fires, and at 450ms they were still being armed as Chrome ran its own handling
  // — which focuses the nearest editable element, so the keyboard shot up over the
  // selection the moment it appeared. 350ms is still far above a tap (~100-150ms).
  const TOUCH_SELECT_LONG_PRESS_MS = 350;
  // How long after a selection gesture the terminal input stays un-focusable. Long
  // enough to cover the platform's long-press handling and the compatibility events
  // that trail a touchend; short and self-expiring, so a stuck flag can never leave
  // the keyboard unreachable.
  const TOUCH_SELECT_FOCUS_GUARD_MS = 800;
  // Regions where a tap must NOT dismiss the on-screen keyboard
  // (_installMobileKeyboardDismiss). Two groups: anything that is about to take
  // focus itself, and the accessory bar, which is built to be used while the
  // keyboard is open.
  const MOBILE_KEYBOARD_DISMISS_EXEMPT_SELECTOR = [
    'input',
    'textarea',
    'select',
    'button',
    'a[href]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
    '.keyboard-accessory-bar',
    '.path-picker-overlay',
  ].join(',');
  // Escape sequences occupy no terminal cells, so they must come out before a
  // captured line's WIDTH can be measured (_estimateReplayRows). Covers OSC,
  // CSI, charset designators and the short escapes tmux emits; deliberately
  // approximate — this feeds a size comparison, not a renderer.
  // eslint-disable-next-line no-control-regex
  const REPLAY_ESCAPE_RE =
    /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b[()#][0-9A-Za-z]|\x1b[=>78M]/g;
  // PageUp / PageDown as xterm.js encodes them. Used as the LAST-RESORT scroll
  // gesture for a repaint-mode CLI whose local buffer holds no scrollback
  // (_maybePageCliTranscript).
  const KEY_PAGE_UP = '\x1b[5~';
  const KEY_PAGE_DOWN = '\x1b[6~';
  // Wheel/touch travel (in lines) that adds up to one PageUp/PageDown. Half a
  // screen rather than a full one: the page key always jumps a whole screen, so
  // a 1:1 mapping made the fallback feel unreachably slow with a discrete mouse
  // wheel (Firefox reports 3 lines a notch → 12 notches per page). Overshooting
  // the finger is the right trade against a gesture that otherwise does nothing.
  const PAGE_KEY_SCREEN_FRACTION = 0.5;
  // Bound on page keys emitted from one gesture batch, mirroring the SGR tick
  // cap: a fling must not build a backlog that keeps paging after it stops.
  const PAGE_KEY_MAX_PER_BATCH = 3;
  const TUI_PROMPT_DEFAULT_ROWS_FROM_BOTTOM = 4;
  // Composer navigation keys as xterm.js encodes user keystrokes: plain and
  // modified arrows (CSI A-D, CSI 1;mA-D, SS3 A-D), Home/End (CSI H/F, SS3
  // H/F, CSI 1~/4~), Insert/Delete/PgUp/PgDn (CSI 2~/3~/5~/6~, optional
  // modifier). Deliberately EXCLUDES terminal query responses that also
  // arrive via onData (DA `\x1b[?1;2c`, CPR `\x1b[12;34R`) and function
  // keys, so only genuine cursor/editing keys trigger the local-echo flush.
  // eslint-disable-next-line no-control-regex
  const COMPOSER_NAV_KEY_PATTERN = /^\x1b(?:\[(?:[ABCDHF]|1;[2-8][ABCDHF]|[1-8](?:;[2-8])?~)|O[ABCDHF])$/;
  // Prefix xterm.js puts on terminal.paste() payloads while the application
  // has bracketed-paste mode (DECSET 2004) enabled. Codex, Claude Code and
  // tmux all enable it, so browser pastes arrive as one onData chunk of
  // `\x1b[200~<text>\x1b[201~`.
  const BRACKETED_PASTE_START = '\x1b[200~';

  function isComposerNavKey(data) {
    return COMPOSER_NAV_KEY_PATTERN.test(data);
  }

  // Codex composer-row signature, measured against codex-cli 0.147.0
  // (docs/predictive-echo-plan.md): the composer's cursor row starts with
  // "› " (U+203A + space) when empty (placeholder text), while typing, and
  // while the slash picker filters. Modal rows ("Press enter to continue")
  // and wrapped continuation rows (2-space indent) do NOT match — that is
  // the ghost eliminator: no prediction is ever painted there.
  const CODEX_COMPOSER_ROW_RE = /^› /;

  // Classify onData for the predictive echo hook. Terminal query responses
  // never reach this (suppressed earlier in onData); bracketed pastes, nav
  // keys and mouse reports all start with ESC => 'clear'.
  function classifyPredictInput(data) {
    const cps = Array.from(data); // astral-safe
    if (cps.length === 1) {
      const cp = cps[0].codePointAt(0);
      if (cp === 0x7f) return 'backspace';
      if (cp >= 0x20) return 'char'; // incl. a single astral emoji
      return 'clear'; // \r \n \t \x03, bare ESC, ...
    }
    if (data.charCodeAt(0) === 0x1b) return 'clear'; // ESC seq: nav, paste, mouse SGR
    if (data.charCodeAt(0) >= 0x20) return 'text'; // multi-char printable (plain paste,
    return 'clear'; //   ZWJ emoji cluster): wire only, no visual
  }

  // Predictive-echo gate: predict only while the cursor sits on the codex
  // composer row. cursorY is baseY-relative (xterm API), hence baseY + cursorY.
  function isCodexComposerRow(terminal) {
    try {
      const buf = terminal.buffer.active;
      const line = buf.getLine(buf.baseY + buf.cursorY);
      return !!line && CODEX_COMPOSER_ROW_RE.test(line.translateToString(true));
    } catch {
      return false;
    }
  }

  function isTerminalQueryResponse(data) {
    return TERMINAL_QUERY_RESPONSE_PATTERN.test(data) || TERMINAL_OSC_RESPONSE_PATTERN.test(data);
  }

  function shouldSuppressTerminalQueryResponse(data) {
    return isTerminalQueryResponse(data);
  }

  /**
   * Did the terminal generate this chunk itself, rather than a human pressing a
   * key? True for mouse and focus reports (issue #262).
   *
   * Consumers that treat one onData chunk as "the next keystroke" must skip
   * these. The one-shot Ctrl modifier is why this exists, and the MOUSE half is
   * the live one: a shell session keeps the narrow scrollback strip, so mouse
   * DECSETs reach the browser and anything the user runs that enables tracking
   * (vim, htop, less) turns a tap into `\x1b[<0;31;23M`. Measured in a real
   * shell session: with Ctrl armed, one tap on the terminal spent it silently.
   *
   * Focus reports are the same class and cost nothing to cover, but they cannot
   * reach xterm today: `FOCUS_ESCAPE_FILTER` in session.ts strips `\x1b[?1004h`
   * (and the reports themselves) from every PTY read, so `sendFocusMode` never
   * turns on. Were that filter to go, the Ctrl button would spend the modifier
   * on its OWN refocus — the bar refocuses the terminal after every key so the
   * keyboard stays open, and that refocus emits `\x1b[I`.
   */
  function isTerminalFocusOrMouseReport(data) {
    return (
      FOCUS_REPORT_PATTERN.test(data) || MOUSE_SGR_REPORT_PATTERN.test(data) || MOUSE_X10_REPORT_PATTERN.test(data)
    );
  }

  // Per-skin xterm.js palettes. The 'daylight-blue' object equals the legacy hardcoded
  // theme, so default behavior is unchanged. Shared at module scope and exported on the
  // global so both terminal-ui.js (main terminal) and panels-ui.js (teammate terminals,
  // a separate IIFE) can read the current skin's palette.
  const CODEMAN_XTERM_THEMES = {
    og: { background: '#0d0d0d', foreground: '#e0e0e0', cursor: '#e0e0e0', cursorAccent: '#0d0d0d', selection: 'rgba(255,255,255,0.3)', black: '#0d0d0d', red: '#ff6b6b', green: '#51cf66', yellow: '#ffd43b', blue: '#339af0', magenta: '#cc5de8', cyan: '#22b8cf', white: '#e0e0e0', brightBlack: '#495057', brightRed: '#ff8787', brightGreen: '#69db7c', brightYellow: '#ffe066', brightBlue: '#5c7cfa', brightMagenta: '#da77f2', brightCyan: '#66d9e8', brightWhite: '#ffffff' },
    'daylight-green': { background: '#161b23', foreground: '#dfe6ef', cursor: '#2fd3aa', cursorAccent: '#161b23', selection: 'rgba(47,211,170,0.22)', black: '#161b23', red: '#ff8585', green: '#34d8a0', yellow: '#f0c25a', blue: '#5cc6e8', magenta: '#c79af2', cyan: '#2bcbbb', white: '#dfe6ef', brightBlack: '#5b6675', brightRed: '#ffa0a0', brightGreen: '#5fe6b8', brightYellow: '#ffd884', brightBlue: '#82d4ee', brightMagenta: '#d6b3f7', brightCyan: '#5ee0d4', brightWhite: '#f3f6fa' },
    'daylight-blue': { background: '#161b23', foreground: '#dfe6ef', cursor: '#38b6f0', cursorAccent: '#161b23', selection: 'rgba(56,182,240,0.22)', black: '#161b23', red: '#ff8585', green: '#34d8a0', yellow: '#f0c25a', blue: '#5cc6e8', magenta: '#c79af2', cyan: '#2bcbbb', white: '#dfe6ef', brightBlack: '#5b6675', brightRed: '#ffa0a0', brightGreen: '#5fe6b8', brightYellow: '#ffd884', brightBlue: '#82d4ee', brightMagenta: '#d6b3f7', brightCyan: '#5ee0d4', brightWhite: '#f3f6fa' },
    'paper-gray': { background: '#f6f8fa', foreground: '#1f2328', cursor: '#0969da', cursorAccent: '#ffffff', selection: 'rgba(9,105,218,0.2)', black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#59636e', brightBlack: '#6e7781', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d4e00', brightBlue: '#0550ae', brightMagenta: '#6639ba', brightCyan: '#116b75', brightWhite: '#1f2328' },
    'solarized-light': { background: '#fdf6e3', foreground: '#586e75', cursor: '#147ba3', cursorAccent: '#fdf6e3', selection: 'rgba(38,139,210,0.2)', black: '#eee8d5', red: '#dc322f', green: '#758600', yellow: '#9b7800', blue: '#147ba3', magenta: '#d33682', cyan: '#2a9189', white: '#073642', brightBlack: '#93a1a1', brightRed: '#cb4b16', brightGreen: '#657b83', brightYellow: '#586e75', brightBlue: '#268bd2', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#002b36' },
    'catppuccin-latte': { background: '#eff1f5', foreground: '#4c4f69', cursor: '#1e66f5', cursorAccent: '#ffffff', selection: 'rgba(30,102,245,0.18)', black: '#5c5f77', red: '#d20f39', green: '#3b8f2b', yellow: '#a86605', blue: '#1e66f5', magenta: '#8839ef', cyan: '#177f86', white: '#6c6f85', brightBlack: '#7c7f93', brightRed: '#b50930', brightGreen: '#2f7622', brightYellow: '#8b5604', brightBlue: '#174fbf', brightMagenta: '#6f2bc5', brightCyan: '#116b71', brightWhite: '#4c4f69' },
    'rose-pine-dawn': { background: '#faf4ed', foreground: '#575279', cursor: '#286983', cursorAccent: '#fffaf3', selection: 'rgba(40,105,131,0.2)', black: '#575279', red: '#b4637a', green: '#286983', yellow: '#96681f', blue: '#477f91', magenta: '#907aa9', cyan: '#3f7f8b', white: '#6e6a86', brightBlack: '#797593', brightRed: '#984d66', brightGreen: '#1f5266', brightYellow: '#7d5417', brightBlue: '#386b7c', brightMagenta: '#765f90', brightCyan: '#326b76', brightWhite: '#575279' },
  };
  const CODEMAN_LIGHT_SKINS = new Set(['paper-gray', 'solarized-light', 'catppuccin-latte', 'rose-pine-dawn']);
  function currentSkin() {
    return (typeof document !== 'undefined' && document.documentElement.dataset.skin) || 'daylight-blue';
  }
  function currentXtermTheme() {
    const skin = currentSkin();
    return CODEMAN_XTERM_THEMES[skin] || CODEMAN_XTERM_THEMES['daylight-blue'];
  }
  function currentSkinIsLight(skin = currentSkin()) {
    return CODEMAN_LIGHT_SKINS.has(skin);
  }

  global.CodemanTerminalInput = {
    isTerminalQueryResponse,
    shouldSuppressTerminalQueryResponse,
    isTerminalFocusOrMouseReport,
    isComposerNavKey,
    classifyPredictInput,
    isCodexComposerRow,
    CODEX_COMPOSER_ROW_RE,
    BRACKETED_PASTE_START,
    USER_SCROLL_STICKY_SUPPRESS_MS,
    TOUCH_COMPAT_MOUSE_SUPPRESS_MS,
    REPLAY_ESCAPE_RE,
    KEY_PAGE_UP,
    KEY_PAGE_DOWN,
    PAGE_KEY_SCREEN_FRACTION,
    PAGE_KEY_MAX_PER_BATCH,
    TUI_PROMPT_DEFAULT_ROWS_FROM_BOTTOM,
    MOBILE_KEYBOARD_DISMISS_EXEMPT_SELECTOR,
    MOBILE_KEYBOARD_DISMISS_TAP_SLOP,
    TOUCH_SELECT_LONG_PRESS_MS,
    TOUCH_SELECT_FOCUS_GUARD_MS,
  };
  global.CODEMAN_XTERM_THEMES = CODEMAN_XTERM_THEMES;
  global.codemanCurrentXtermTheme = currentXtermTheme;
  global.codemanCurrentSkinIsLight = currentSkinIsLight;
})(window);

Object.assign(CodemanApp.prototype, {
  // ═══════════════════════════════════════════════════════════════
  // Terminal Setup — xterm.js config and input handling
  // ═══════════════════════════════════════════════════════════════

  initTerminal() {
    // Load scrollback setting from localStorage, treating DEFAULT_SCROLLBACK as a floor
    // so users who picked up the previous (smaller) default get the new minimum on upgrade.
    const stored = parseInt(localStorage.getItem('codeman-scrollback'));
    const scrollback = Number.isFinite(stored) && stored > 0 ? Math.max(stored, DEFAULT_SCROLLBACK) : DEFAULT_SCROLLBACK;

    this.terminal = new Terminal({
      theme: { ...window.codemanCurrentXtermTheme() },
      fontFamily: window.CodemanTerminalFont.resolve(this.loadAppSettingsFromStorage?.().terminalFontFamily),
      // Use smaller font on mobile to fit more columns (prevents wrapping of Claude's status line)
      fontSize: MobileDetection.getDeviceType() === 'mobile' ? 10 : 14,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: 'block',
      minimumContrastRatio: window.codemanCurrentSkinIsLight() ? 4.5 : 1,
      scrollback: scrollback,
      allowTransparency: true,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    // SerializeAddon: lets us snapshot the xterm rendered state (viewport +
    // scrollback + colors/attrs) when switching away from a tab and restore
    // it on switch-back. Needed primarily for codex tabs — codex's TUI drops
    // earlier conversation from its current frame, so replaying the server
    // byte buffer on tab-switch shows only the latest (idle) frame. The
    // snapshot captures what the user was actually looking at.
    this._xtermSnapshots = new Map(); // Map<sessionId, serialized-string>
    if (typeof SerializeAddon !== 'undefined') {
      try {
        this._serializeAddon = new SerializeAddon.SerializeAddon();
        this.terminal.loadAddon(this._serializeAddon);
      } catch (_e) {
        /* SerializeAddon failed — snapshot/restore disabled, fallback to buffer-fetch */
        this._serializeAddon = null;
      }
    }

    if (typeof Unicode11Addon !== 'undefined') {
      try {
        const unicode11Addon = new Unicode11Addon.Unicode11Addon();
        this.terminal.loadAddon(unicode11Addon);
        this.terminal.unicode.activeVersion = '11';
      } catch (_e) {
        /* Unicode11 addon failed — default Unicode handling used */
      }
    }

    const container = document.getElementById('terminalContainer');
    this.terminal.open(container);
    this._installMobileTapMouseGuard();
    this._installTouchSelectionFocusGuard();

    // Let xterm's CompositionHelper own IME key events. In particular, a
    // non-composing keyCode 229 is how an active IME commits numbers and
    // punctuation; returning false here would stop xterm before it can diff
    // the helper textarea and emit the committed Unicode text.
    this.terminal.attachCustomKeyEventHandler((ev) => {
      if (ev.isComposing || ev.key === 'Process' || ev.keyCode === 229) return true;

      // Let the app's Alt/Option session-nav and Command Palette shortcuts reach the document keydown handler
      // (app.js switches tabs by PHYSICAL e.code) instead of xterm injecting ESC<char> into
      // the PTY. Mirror app.js's gate exactly — same physical codes + modifier guard — so
      // macOS Option layouts (Option+1 -> "¡", Option+[ -> "“", Option+K -> "˚") are suppressed here too and
      // don't leak an escape sequence into the focused terminal on every tab switch.
      if (
        ev.altKey &&
        !ev.ctrlKey &&
        !ev.shiftKey &&
        /^(Digit[1-9]|BracketLeft|BracketRight|KeyK)$/.test(ev.code || '')
      ) {
        return false;
      }

      // Command palette chord (COD-153): keep it out of the PTY. The document
      // CAPTURE handler has already opened the palette by the time xterm sees
      // this keydown, but its preventDefault() does NOT stop xterm — without
      // this gate Ctrl+K would ALSO write 0x0b (readline kill-line) into the
      // live session behind the palette, truncating whatever the user had
      // typed. Route through the registry-aware checker so a rebound or
      // disabled palette shortcut restores normal terminal Ctrl+K.
      if (ev.type === 'keydown' && this.shouldOpenCommandPaletteFromShortcut?.(ev)) {
        return false;
      }

      // Smart copy (#211): with a selection, Ctrl+C copies it instead of sending
      // ^C. With NO selection the branch must fall through (return true, and no
      // preventDefault) or the interrupt key is lost, which is the whole reason
      // the selection check runs before any registry dispatch. Ctrl+Shift+C is
      // the explicit copy chord and never falls through: an "explicit copy" that
      // interrupts a running agent because the selection happened to be empty is
      // a footgun with no upside.
      // NOTE: returning false does NOT cancel the event (xterm's _keyDown calls
      // this handler before its own cancel()), so preventDefault is explicit:
      // without it the browser runs its native copy on top of ours.
      if (this.shouldCopyTerminalSelectionFromShortcut?.(ev)) {
        const selection = this.terminal.hasSelection?.() ? this.terminal.getSelection() : '';
        if (selection) {
          ev.preventDefault();
          void this.copyTerminalSelection(selection);
          return false;
        }
        if (ev.shiftKey) {
          ev.preventDefault();
          return false;
        }
        return true;
      }

      // Session-sidebar toggle chord (default Alt+B): same trap as above —
      // preventDefault() in the capture handler does not stop xterm, so without
      // this gate every toggle would ALSO send ESC b (readline backward-word)
      // into the live session and walk the cursor back through the user's
      // half-typed prompt. Registry-aware and only while the sidebar layout is
      // active, so a rebind/disable and the default header layout keep plain
      // Meta-b working in the terminal.
      if (ev.type === 'keydown' && this.shouldToggleSessionSidebarFromShortcut?.(ev)) {
        return false;
      }

      // Ctrl+V / Cmd+V: intercept before xterm sends ^V to PTY.
      // Route through our paste trap which handles both images and text.
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'v' && ev.type === 'keydown') {
        if (this.activeSessionId && this._handleImagePaste) {
          this._handleImagePaste();
        }
        return false;
      }

      // Shift+Enter / Ctrl+Enter: insert newline for multi-line input.
      // xterm.js sends plain \r for all Enter variants, so Claude Code (Ink) can't
      // distinguish them. We use tmux send-keys -H to send a line feed byte (0x0a)
      // which the inner application recognizes as "insert newline" vs carriage return.
      if (ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey) && ev.type === 'keydown') {
        if (this.activeSessionId) {
          if (this._localEchoEnabled) {
            const text = this._localEchoOverlay?.pendingText || '';
            this._localEchoOverlay?.clear();
            this._localEchoOverlay?.suppressBufferDetection();
            this._flushedOffsets?.delete(this.activeSessionId);
            this._flushedTexts?.delete(this.activeSessionId);
            if (text) {
              this._pendingInput += text;
              flushInput();
            }
            setTimeout(() => {
              fetch(`/api/sessions/${this.activeSessionId}/send-key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: ev.ctrlKey ? 'C-Enter' : 'S-Enter' }),
              });
            }, text ? 80 : 0);
          } else {
            fetch(`/api/sessions/${this.activeSessionId}/send-key`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: ev.ctrlKey ? 'C-Enter' : 'S-Enter' }),
            });
          }
        }
        return false;
      }

      return true;
    });

    // WebGL renderer for GPU-accelerated terminal rendering.
    // Previously caused "page unresponsive" crashes from synchronous GPU stalls,
    // but the mode-aware 32/64KB frame cap in flushPendingWrites() now prevents
    // oversized terminal.write() calls that triggered the stalls.
    // Disable with ?nowebgl URL param if GPU issues return.
    // Auto-fallback: _initWebGL installs a long-task watchdog that disables
    // WebGL sticky in localStorage after repeated GPU stalls (see app.js).
    // Force re-enable after sticky disable with ?webgl=force.
    // Lazy-loaded: script downloaded only on desktop (saves 244KB on mobile).
    this._webglAddon = null;
    const _params = new URLSearchParams(location.search);
    const _stickyDisabled = (() => {
      try {
        const raw = localStorage.getItem('codeman-webgl-disabled');
        if (!raw) return false;
        const { at } = JSON.parse(raw);
        // Auto-expire after WEBGL_FALLBACK.STICKY_EXPIRY_MS so we retry
        // (driver/Chrome may have been updated).
        if (Date.now() - at > WEBGL_FALLBACK.STICKY_EXPIRY_MS) {
          localStorage.removeItem('codeman-webgl-disabled');
          return false;
        }
        return true;
      } catch { return false; }
    })();
    // User's "WebGL Renderer" toggle (Settings > Appearance). undefined = untouched
    // (desktop default on); false = explicit opt-out; true = explicit opt-in.
    const _webglSettings = this.loadAppSettingsFromStorage();
    const _webglDefaults = this.getDefaultSettings();
    const _webglPref = _webglSettings.webglRendererEnabled ?? _webglDefaults.webglRendererEnabled;
    const { skip: skipWebGL, clearSticky: _clearWebglSticky } = shouldSkipWebGL({
      deviceType: MobileDetection.getDeviceType(),
      noWebglParam: _params.has('nowebgl'),
      forceParam: _params.get('webgl') === 'force',
      stickyDisabled: _stickyDisabled,
      userPrefEnabled: _webglPref,
    });
    // Only ?webgl=force retires the auto-fallback marker at init — a stored
    // toggle ON is incidental (checkbox defaults checked) and must not defeat
    // the sticky safety net. An OFF→ON flip clears it in saveAppSettings().
    if (_clearWebglSticky) {
      try { localStorage.removeItem('codeman-webgl-disabled'); } catch {}
    }
    if (skipWebGL && _stickyDisabled) {
      console.log('[CRASH-DIAG] WebGL sticky-disabled from prior stalls — DOM renderer in use. Re-enable: ?webgl=force');
    }
    if (!skipWebGL) {
      if (typeof WebglAddon !== 'undefined') {
        this._initWebGL();
      } else {
        // Lazy-load WebGL addon — not bundled in <head> to avoid blocking mobile
        const wglScript = document.createElement('script');
        wglScript.src = 'vendor/xterm-addon-webgl.min.js';
        wglScript.onload = () => this._initWebGL();
        wglScript.onerror = () => console.warn('[CRASH-DIAG] Failed to load WebGL addon — using canvas renderer');
        document.head.appendChild(wglScript);
      }
    }

    this._localEchoOverlay = new LocalEchoOverlay(this.terminal);
    // Predictive write-through echo (codex): separate opt-in bundle
    // (vendor/xterm-predictive-echo.js); when it is missing or failed to
    // load, codex falls back to plain PTY echo exactly like 1.12.2.
    this._predictiveEcho =
      typeof PredictiveEchoOverlay !== 'undefined' ? new PredictiveEchoOverlay(this.terminal) : null;
    this._predictiveEcho?.setPredictWhen((terminal) => window.CodemanTerminalInput.isCodexComposerRow(terminal));
    if (MobileDetection.isTouchDevice()) {
      this.terminal.onCursorMove(() => this._syncMobileHelperTextareaToCursor());
      this.terminal.onRender(() => this._syncMobileHelperTextareaToCursor());
    }

    // CJK IME input — textarea in index.html, just wire up send
    this._cjkInput = null;
    if (typeof CjkInput !== 'undefined') {
      this._cjkInput = CjkInput.init({
        send: (text) => {
          this._handleCjkInput(text);
        },
      });
    }

    // ── Focus router ──
    // While the CJK field is visible, EVERY terminal.focus() call must land on
    // the CJK field instead. Focusing xterm's hidden textarea in CJK mode sends
    // the IME's output into a black hole: the keyboard composes normally, but
    // onData is gated by cjkActive, so nothing reaches the field OR the PTY.
    // Session select / SSE-reconnect restore paths call terminal.focus() and
    // were silently stealing focus after every app switch on mobile (the
    // intermittent "Chinese input goes nowhere" bug). One chokepoint here
    // covers all ~15 call sites plus any future ones.
    const _xtermFocus = this.terminal.focus.bind(this.terminal);
    this.terminal.focus = () => {
      const cjkEl = document.getElementById('cjkInput');
      if (cjkEl?.classList.contains('cjk-input-visible')) {
        cjkEl.focus();
      } else {
        _xtermFocus();
      }
    };

    // On mobile Safari, delay initial fit() to allow layout to settle
    // This prevents 0-column terminals caused by fit() running before container is sized
    const isMobileSafari =
      MobileDetection.getDeviceType() === 'mobile' && document.body.classList.contains('safari-browser');
    if (isMobileSafari) {
      // Wait for layout, then fit multiple times to ensure proper sizing
      requestAnimationFrame(() => {
        this.fitAddon.fit();
        // Double-check after another frame
        requestAnimationFrame(() => this.fitAddon.fit());
      });
    } else {
      this.fitAddon.fit();
    }

    // Register link provider for clickable file paths in Bash tool output
    this.registerFilePathLinkProvider();

    // Bar visible ⟺ a selection exists. xterm drops the selection on any keypress,
    // on reset and on a tab switch, and a Copy button floating over nothing is a
    // trap — one that would copy the PREVIOUS session's text if it still worked.
    this.terminal.onSelectionChange?.(() => {
      if (!this.terminal?.hasSelection?.()) {
        this._touchSelecting = false;
        this._touchSelectionActive = false;
        this._touchSelectionAnchor = null;
        this._hideTouchSelectionBar();
        // Nothing highlighted, nothing for Auto Copy to flush. xterm drops the
        // selection on any keypress, so without this a keystroke would leave a
        // stale flush armed for the next unrelated mouseup.
        this._autoCopyPending = false;
        return;
      }
      // Auto Copy arms here and fires at the END of the gesture (below). This
      // callback runs on EVERY cell the drag crosses, so copying here would be
      // one clipboard write per mouse move.
      this._autoCopyPending = true;
    });

    // Auto Copy (copy-on-select, per-device `autoCopySelection`, default OFF).
    //
    // ⚠️ The flush is SYNCHRONOUS inside the mouseup handler, deliberately: both
    // clipboard paths need user activation (Firefox gates navigator.clipboard
    // .writeText on it, and Safari requires document.execCommand('copy'), the
    // plain-HTTP fallback install.sh's LAN option lands on, to run inside the
    // gesture's own task). Deferring to a timer or to onSelectionChange loses it.
    //
    // ⚠️ document-level, because a drag that ends outside the terminal (the user
    // sweeps up past the header) delivers its mouseup to the document, not to
    // the container. Unrelated mouseups elsewhere on the page are filtered by
    // decideAutoCopy, not by the listener's target.
    if (!this._autoCopyListenerInstalled) {
      this._autoCopyListenerInstalled = true;
      document.addEventListener('mouseup', () => this._flushAutoCopySelection());
    }

    // Mouse wheel: forward to the TUI only for sessions verified to handle SGR
    // wheel reports (claude 2.1.187+ — see _shouldForwardWheelToApp), local
    // scrollback otherwise. Claude Code 2.1.187+ scrolls its own
    // transcript on SGR wheel reports — scrolled-away tool blocks re-render
    // live and stay clickable — and its select menus no longer capture wheel
    // as option navigation (verified against 2.1.202: /model menu highlight
    // ignores wheel reports); older versions DO capture wheel as option
    // navigation, so they keep the local wheel.
    // Shift+wheel always scrolls xterm's local scrollback (Codeman's restored
    // history lives there); the plain wheel stays on the CLI's transcript for
    // those modes regardless of scroll position, so the CLI's input box never
    // slides off the screen (see _shouldForwardWheelToApp).
    //
    // CAPTURE phase, deliberately, and Codeman owns the scroll. xterm's
    // viewport is a vscode-style ScrollableElement that consumes wheel events
    // itself (preventDefault + stopPropagation) whenever it believes a
    // scrollbar exists, does NOT consult attachCustomWheelEventHandler, and —
    // measured on the live instance — goes DEAF after terminal.reset(): a tab
    // switch or full-history replay leaves its scroll dimensions stale, after
    // which wheel events neither scroll nor propagate reliably. A bubble-phase
    // listener here therefore never fired once local scrollback existed
    // (measured: _shouldForwardWheelToApp call count stayed 0 while xterm
    // scrolled), and after a tab switch NOTHING scrolled at all — the "input
    // box scrolls up then it fights", "works at first, breaks after a tab
    // switch" reports on #205.
    //
    // So: capture runs ancestors-first; this handler sees every wheel first
    // and stops propagation, keeping xterm's scroller out of it entirely.
    // Local scrolling goes through terminal.scrollLines() — buffer-level, so
    // it keeps working after resets — with our own deltaMode normalization
    // (_wheelScrollLines) covering Firefox's line-unit wheels. Two cases still
    // belong to xterm and are passed through untouched:
    //  - mouseTrackingMode active: xterm's own encoder forwards the wheel to
    //    the PTY (htop/vim with mouse on in a shell pane);
    //  - alternate buffer (direct-PTY fallback running vim/less): xterm's
    //    alt-scroll handling converts the wheel to cursor keys, which is what
    //    those apps expect.
    container.addEventListener(
      'wheel',
      (ev) => {
        const trackingMode = this.terminal?.modes?.mouseTrackingMode;
        if (trackingMode && trackingMode !== 'none') return;
        if (this.terminal?.buffer?.active?.type === 'alternate') return;
        ev.preventDefault();
        ev.stopPropagation();
        if (this._shouldForwardWheelToApp(ev)) {
          this._logScrollRouting('forward-sgr');
          this._forwardScrollToApp(ev.clientX, ev.clientY, this._wheelScrollLines(ev));
          return;
        }
        // Local scrolling accumulates FRACTIONAL lines: a macOS trackpad emits
        // a stream of tiny pixel deltas, and rounding each one to a whole line
        // (the ±1 fallback) made slow drags scroll faster than the finger.
        const lines = this._wheelScrollLinesFloat(ev);
        // …unless there is no local scrollback to scroll, in which case page the
        // CLI's own transcript instead of doing nothing (_maybePageCliTranscript).
        if (this._maybePageCliTranscript(ev, lines)) return;
        this._logScrollRouting('local-scrollback');
        this._noteTerminalUserScroll(lines);
        this._smoothScrollBy(lines);
      },
      { passive: false, capture: true }
    );

    // Touch scrolling — use terminal.scrollLines() for all devices.
    // xterm.js DOM renderer doesn't populate xterm-viewport's scroll area,
    // so native CSS scrolling (overflow-y: scroll + touch-action: pan-y)
    // has nothing to scroll. Instead, convert touch deltas into scrollLines()
    // calls, matching the wheel handler above, including the forwarding
    // branch: for the sessions whose wheel goes to the CLI's own transcript
    // (_shouldForwardWheelToApp), a touch drag must go there too, or every
    // phone/tablet swipe scrolls the local buffer of stale repaint frames and
    // drags the CLI's pinned input box off the screen (issue #205's mobile
    // half). Same gate, so Shift has no touch analog but the local-scrollback
    // opt-out setting and the CLI-version gate apply to touch exactly as they
    // do to the wheel — including the PageUp/PageDown fallback the wheel uses
    // when that gate is false and there is no local scrollback to scroll
    // (_maybePageCliTranscript), which is what keeps a swipe from being a
    // complete no-op on a phone.
    {
      const cellHeight = () => this.terminal._core?._renderService?.dimensions?.css?.cell?.height || 13;
      let touchLastX = 0;
      let touchLastY = 0;
      let velocity = 0;
      let lastTime = 0;
      let scrollFrame = null;
      let isTouching = false;

      const scrollLoop = (timestamp) => {
        const dt = lastTime ? (timestamp - lastTime) / 16.67 : 1;
        lastTime = timestamp;

        if (!isTouching && Math.abs(velocity) > 0.3) {
          // Momentum phase — convert pixel velocity to lines
          const lines = Math.round(velocity / cellHeight());
          if (lines !== 0) {
            if (this._shouldForwardWheelToApp({ shiftKey: false })) {
              // Flick momentum keeps feeding the CLI's transcript from the last
              // touch point; the 40ms coalescer batches the per-frame reports.
              this._forwardScrollToApp(touchLastX, touchLastY, lines);
            } else if (!this._maybePageCliTranscript({ shiftKey: false }, lines)) {
              this.terminal.scrollLines(lines);
              this._maybeLoadMoreHistoryOnScroll(lines);
            }
          }
          velocity *= 0.92;
          scrollFrame = requestAnimationFrame(scrollLoop);
        } else if (!isTouching) {
          scrollFrame = null;
          velocity = 0;
        } else {
          scrollFrame = requestAnimationFrame(scrollLoop);
        }
      };

      // Accumulate sub-line pixel deltas so slow swipes still scroll
      let pixelAccum = 0;

      let didScroll = false; // track whether touchmove fired (tap vs scroll)
      let longPressTimer = null; // armed on touchstart, becomes a text selection
      let longPressStartX = 0;
      let longPressStartY = 0;
      let touchStartY = 0;
      let tapStartedWithTerminalFocus = false;
      let tapStartIntentCache = null;
      // px — ignore micro-drift to distinguish tap from scroll. Shared with the
      // keyboard-dismiss handler so both classify the same gesture the same way.
      const TAP_THRESHOLD = window.CodemanTerminalInput.MOBILE_KEYBOARD_DISMISS_TAP_SLOP;
      container.addEventListener(
        'touchstart',
        (ev) => {
          // The selection bar is a child of this container: its buttons own their
          // own taps and must not arm a gesture on the terminal underneath.
          if (ev.target?.closest?.('.term-select-bar')) return;
          if (ev.touches.length !== 1) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
          if (ev.touches.length === 1) {
            touchLastX = ev.touches[0].clientX;
            touchLastY = ev.touches[0].clientY;
            touchStartY = touchLastY;
            velocity = 0;
            pixelAccum = 0;
            isTouching = true;
            didScroll = false;
            tapStartedWithTerminalFocus = this._isMobileTerminalInputFocused();
            // Classifying scans the whole viewport with translateToString, and
            // this runs at the start of EVERY gesture including scroll drags.
            // Cache the result for the touchend of this same gesture rather than
            // recomputing it; the cache is keyed on the exact start coordinates
            // so a finger that moved re-classifies at its real position.
            const touchStartIntent = this._classifyMobileTerminalTap(touchLastX, touchLastY);
            tapStartIntentCache = { x: touchLastX, y: touchLastY, intent: touchStartIntent };
            if (touchStartIntent === 'content') {
              // Cancel xterm/browser focus before the compatibility click can
              // open the OS keyboard. Content taps are re-emitted as SGR on
              // touchend.
              //
              // 'history' is deliberately NOT included. A scrolled-up viewport
              // sends nothing, so there is no compatibility click worth
              // cancelling — and preventDefault() here, paired with touchend's
              // early return, closes both routes to focus at once. Since
              // selectSession() ends with scrollToLastNonEmptyLine(), that made
              // the keyboard unreachable after every tab switch.
              ev.preventDefault();
              this._blurMobileTerminalInput();
            }
            // Hold still and this press becomes a text selection. Cancelled by any
            // travel past the shared tap slop below, so a scroll can never become one.
            longPressStartX = touchLastX;
            longPressStartY = touchLastY;
            clearTimeout(longPressTimer);
            longPressTimer = setTimeout(() => {
              longPressTimer = null;
              this._beginTouchSelection(longPressStartX, longPressStartY);
            }, window.CodemanTerminalInput.TOUCH_SELECT_LONG_PRESS_MS);
            lastTime = 0;
            if (scrollFrame) {
              cancelAnimationFrame(scrollFrame);
              scrollFrame = null;
            }
          }
        },
        { passive: false }
      );

      container.addEventListener(
        'touchmove',
        (ev) => {
          // A drag that follows the long press grows the selection instead of
          // scrolling; preventDefault keeps the page from taking the gesture back.
          if (this._touchSelecting) {
            ev.preventDefault();
            const selTouch = ev.touches[0];
            if (selTouch) this._extendTouchSelection(selTouch.clientX, selTouch.clientY);
            return;
          }
          if (longPressTimer && ev.touches.length === 1) {
            const t = ev.touches[0];
            if (
              Math.abs(t.clientX - longPressStartX) > TAP_THRESHOLD ||
              Math.abs(t.clientY - longPressStartY) > TAP_THRESHOLD
            ) {
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
          }
          if (ev.touches.length === 1 && isTouching) {
            const touchY = ev.touches[0].clientY;
            if (!didScroll && Math.abs(touchY - touchStartY) >= TAP_THRESHOLD) {
              didScroll = true;
            }
            // Below the tap threshold, treat the gesture as a potential tap:
            // don't preventDefault (iOS needs click synthesis to show the
            // keyboard) and don't accumulate scroll distance or velocity. Without
            // this guard, sub-threshold micro-drift still scrolls a line and
            // leaves a non-zero velocity that touchend turns into a momentum
            // fling, so a jittery tap would both position the cursor AND scroll.
            if (!didScroll) return;
            ev.preventDefault();
            const delta = touchLastY - touchY; // positive = scroll down
            pixelAccum += delta;
            velocity = delta * 1.2;
            touchLastX = ev.touches[0].clientX;
            touchLastY = touchY;
            // Convert accumulated pixels to whole lines
            const ch = cellHeight();
            const lines = Math.trunc(pixelAccum / ch);
            if (lines !== 0) {
              if (this._shouldForwardWheelToApp({ shiftKey: false })) {
                this._logScrollRouting('forward-sgr');
                this._forwardScrollToApp(touchLastX, touchLastY, lines);
              } else if (!this._maybePageCliTranscript({ shiftKey: false }, lines)) {
                this._logScrollRouting('local-scrollback');
                this._noteTerminalUserScroll(lines);
                this.terminal.scrollLines(lines);
                this._maybeLoadMoreHistoryOnScroll(lines);
              }
              pixelAccum -= lines * ch;
            }
          }
        },
        { passive: false }
      );

      container.addEventListener(
        'touchend',
        (ev) => {
          if (ev.target?.closest?.('.term-select-bar')) return;
          clearTimeout(longPressTimer);
          longPressTimer = null;
          isTouching = false;
          if (this._touchSelecting) {
            // Lifting ends the DRAG, not the selection: the bar stays up so the
            // range can still be extended by tapping, or copied. preventDefault
            // cancels the compatibility mouse events this touchend would otherwise
            // synthesize — see _endTouchSelectionGesture.
            ev.preventDefault();
            velocity = 0;
            this._endTouchSelectionGesture();
            tapStartedWithTerminalFocus = false;
            return;
          }
          if (!scrollFrame && Math.abs(velocity) > 0.3) {
            scrollFrame = requestAnimationFrame(scrollLoop);
          }
          if (!didScroll && this.terminal) {
            const touch = ev.changedTouches && ev.changedTouches[0];
            if (touch) {
              this._suppressTrustedTapMouseEvents();
              const cached =
                tapStartIntentCache &&
                tapStartIntentCache.x === touch.clientX &&
                tapStartIntentCache.y === touch.clientY
                  ? tapStartIntentCache.intent
                  : null;
              this._handleMobileTerminalTap(touch, tapStartedWithTerminalFocus, cached);
            }
          }
          tapStartedWithTerminalFocus = false;
        },
        // NOT passive: the selection branch above must be able to preventDefault
        // the compatibility mouse events. Every other path leaves the event alone.
        { passive: false }
      );

      // Android Chrome fires `contextmenu` at its long-press threshold and then runs
      // its default long-press behaviour. Suppressed ONLY while a selection gesture
      // is in flight — a desktop right-click keeps its menu, since the timer is null
      // and no gesture is active there.
      container.addEventListener('contextmenu', (ev) => {
        if (longPressTimer !== null || this._touchSelecting || this._touchSelectionActive) {
          ev.preventDefault();
        }
      });

      container.addEventListener(
        'touchcancel',
        () => {
          clearTimeout(longPressTimer);
          longPressTimer = null;
          isTouching = false;
          this._touchSelecting = false;
          velocity = 0;
          pixelAccum = 0;
          tapStartedWithTerminalFocus = false;
        },
        { passive: true }
      );
    }

    // ── Desktop click-to-position cursor ──────────────────────────────
    // A real mouse click normally reaches the PTY through xterm's own mouse
    // encoder, but that encoder only runs while mouseTrackingMode is ON — and
    // the server strips the enabling DECSETs from claude/codex/gemini output
    // (isAltScreenStripMode, session.ts) so the wheel keeps scrolling
    // scrollback. Desktop clicks therefore stopped reporting entirely (the
    // same breakage the mobile touchend tap branch above works around).
    // Hand-encode the SGR report for plain left-clicks on those sessions.
    container.addEventListener('click', (ev) => this._handleDesktopTerminalClick(ev));

    this._installMobileKeyboardDismiss();

    // Welcome message
    this.showWelcome();

    // Image paste and drag-and-drop support
    this.initImageInput();

    // Generation counter for chunkedTerminalWrite — aborts stale writes on tab switch
    this._chunkedWriteGen = 0;
    this._bufferLoadSeq = 0;
    this._bufferLoadOwner = null;
    this._lastUserScrollUpAt = null;

    // Handle resize with throttling for performance
    this._resizeTimeout = null;
    this._lastResizeDims = null;

    // Minimum terminal dimensions to prevent vertical text wrapping
    const MIN_COLS = 40;
    const MIN_ROWS = 10;

    const throttledResize = () => {
      if (this._tabRailResizeOwnsObserver) return;
      // Trailing-edge debounce: ALL resize work (fit + clear + SIGWINCH) happens
      // once after the user stops resizing. During active resize, the terminal
      // stays at its old dimensions for up to 300ms.
      //
      // Why not fit() immediately? Each fitAddon.fit() reflows content at the
      // new width — lines that were 7 rows become 10, and the overflow gets
      // pushed into scrollback. With continuous resize events, this creates
      // dozens of intermediate reflow states in scrollback, appearing as
      // duplicate/garbled content when the user scrolls up.
      //
      // By deferring fit() to the trailing edge, there's exactly ONE reflow
      // at the final dimensions, ONE viewport clear, and ONE Ink redraw.
      if (this._resizeTimeout) {
        clearTimeout(this._resizeTimeout);
      }
      this._resizeTimeout = setTimeout(() => {
        this._resizeTimeout = null;
        // Fit xterm.js to final container dimensions
        if (this.fitAddon) {
          this.fitAddon.fit();
        }
        // Flush any stale flicker buffer before clearing viewport
        if (this.flickerFilterBuffer) {
          if (this.flickerFilterTimeout) {
            clearTimeout(this.flickerFilterTimeout);
            this.flickerFilterTimeout = null;
          }
          this.flushFlickerBuffer();
        }
        // Skip server resize while mobile keyboard is visible — sending SIGWINCH
        // causes Ink to re-render at the new row count, garbling terminal output.
        // Local fit() still runs so xterm knows the viewport size for scrolling.
        const keyboardUp = typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible;
        if (this.activeSessionId && !keyboardUp) {
          const dims = this.fitAddon.proposeDimensions();
          // Enforce minimum dimensions to prevent layout issues
          const cols = dims ? Math.max(dims.cols, MIN_COLS) : MIN_COLS;
          const rows = dims ? Math.max(dims.rows, MIN_ROWS) : MIN_ROWS;
          // Only send resize if dimensions actually changed
          if (!this._lastResizeDims || cols !== this._lastResizeDims.cols || rows !== this._lastResizeDims.rows) {
            // Clear viewport + scrollback ONLY when dimensions actually change.
            // fitAddon.fit() reflows content: lines at old width may wrap to more rows,
            // pushing overflow into scrollback. Ink's cursor-up count is based on the
            // pre-reflow line count, so ghost renders accumulate in scrollback.
            // Fix: \x1b[3J (Erase Saved Lines) clears scrollback reflow debris,
            // then \x1b[H\x1b[2J clears the viewport for a clean Ink redraw.
            // IMPORTANT: Only clear when we're actually sending SIGWINCH (dims changed).
            // Clearing without a subsequent Ink redraw leaves the terminal blank.
            const activeResizeSession = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
            if (
              activeResizeSession &&
              activeResizeSession.mode !== 'shell' &&
              this.terminal &&
              this.isTerminalAtBottom()
            ) {
              this.terminal.write('\x1b[3J\x1b[H\x1b[2J');
            }
            this._lastResizeDims = { cols, rows };
            // Typed + WS-first like sendResize: the viewport type feeds resize
            // arbitration (a phone rotating must not bypass a desktop claim),
            // and a desktop window narrowing past the tablet breakpoint must
            // send a typed WS frame so its stale desktop claim is released.
            const viewportType =
              typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType
                ? MobileDetection.getDeviceType()
                : 'desktop';
            let sentViaWs = false;
            if (this._wsReady && this._wsSessionId === this.activeSessionId) {
              try {
                this._ws.send(JSON.stringify({ t: 'z', c: cols, r: rows, v: viewportType }));
                sentViaWs = true;
              } catch {
                // Fall through to HTTP POST
              }
            }
            if (!sentViaWs) {
              fetch(`/api/sessions/${this.activeSessionId}/resize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cols, rows, viewportType }),
              }).catch(() => {});
            }
          }
        }
        // Update subagent connection lines and local echo at new dimensions.
        // Lineage lines are desktop-only, so a resize across the 1024px boundary
        // has to re-resolve their gate before the redraw, not just move them.
        this.applyLineageLineSettings?.();
        this.updateConnectionLines();
        if (this._localEchoOverlay?.hasPending) {
          this._localEchoOverlay.rerender();
        }
      }, 300); // Trailing-edge: only fire after 300ms of no resize events
    };

    window.addEventListener('resize', throttledResize);
    // Store resize observer for cleanup (prevents memory leak on terminal re-init)
    if (this.terminalResizeObserver) {
      this.terminalResizeObserver.disconnect();
    }
    this.terminalResizeObserver = new ResizeObserver(throttledResize);
    this.terminalResizeObserver.observe(container);

    // Handle keyboard input — send to PTY immediately, no local echo.
    // PTY/Ink handles all character echoing to avoid desync ("typing visible below" bug).
    this._pendingInput = '';
    this._inputFlushTimeout = null;
    this._lastKeystrokeTime = 0;

    const flushInput = () => {
      this._inputFlushTimeout = null;
      if (this._pendingInput && this.activeSessionId) {
        const input = this._pendingInput;
        const sessionId = this.activeSessionId;
        this._pendingInput = '';
        this._sendInputAsync(sessionId, input);
      }
    };

    // Local echo mode: buffer keystrokes locally (shown in overlay) and only
    // send to PTY on Enter.  Avoids out-of-order delivery on high-latency
    // mobile connections.  The overlay + localStorage persistence ensure input
    // survives tab switches and reconnects.

    this.terminal.onData((data) => {
      // Mouse SGR reports (tap-to-position) are NOT IME input — they must reach
      // the PTY even while the CJK input field owns focus. Without this exception
      // tapping to move the cursor silently does nothing whenever Chinese input
      // is on, because cjkActive stays true the whole time the field is visible.
      const isMouseReport = /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data);
      // CJK input has focus — block xterm from sending keystrokes to PTY
      if (!isMouseReport && (window.cjkActive || document.activeElement?.id === 'cjkInput')) {
        // Self-heal: if the CJK field is visible but focus drifted to xterm's
        // hidden textarea (e.g. something called terminal.focus()), everything
        // typed lands HERE and is swallowed — keyboard shows the IME composing
        // while both the CJK field and the terminal stay empty. Route focus
        // back so the very next keystroke lands in the CJK field again.
        // Only GENUINE typed input qualifies: onData also fires for xterm's
        // self-generated query replies (DA/DSR/CPR/OSC during Ink redraws),
        // which arrive no matter what has focus — so require focus to be on
        // xterm's own textarea and bail on query replies, or this would steal
        // focus from the rename/search/settings inputs while output streams.
        const cjkEl = document.getElementById('cjkInput');
        if (
          cjkEl?.classList.contains('cjk-input-visible') &&
          document.activeElement === this.terminal.textarea &&
          !window.CodemanTerminalInput?.shouldSuppressTerminalQueryResponse(data)
        ) {
          _crashDiag.log('CJK regain-focus (onData swallowed input)');
          cjkEl.focus();
        }
        return;
      }
      if (this.activeSessionId) {
        // Filter terminal query replies generated by xterm.js itself.
        // Forwarding them through the WebSocket injects DA/DSR/CPR replies
        // into the foreground process as typed input (for example "0;276;0c").
        if (
          window.CodemanTerminalInput?.shouldSuppressTerminalQueryResponse(data)
        ) {
          return;
        }

        // ── One-shot Ctrl (mobile shell bar, issue #262) ──
        // A virtual keyboard reports no usable key events, so a keydown hook
        // would never see the character the modifier applies to: it arrives
        // here as onData text. Sits AFTER the query-response filter so xterm's
        // own DA/CPR replies can never spend the modifier, and BEFORE every
        // send path so the control byte follows the normal control-char route
        // (immediate flush, local-echo state cleared).
        //
        // Mouse and focus reports are skipped rather than suppressed: they are
        // real bytes the PTY still needs, they just were not typed by anyone.
        // A shell session passes mouse DECSETs through, so with vim or htop
        // running, one tap on the terminal used to spend the modifier silently
        // (measured against a real shell). See isTerminalFocusOrMouseReport.
        if (
          typeof KeyboardAccessoryBar !== 'undefined' &&
          KeyboardAccessoryBar.isCtrlArmed?.() &&
          !window.CodemanTerminalInput?.isTerminalFocusOrMouseReport(data)
        ) {
          data = KeyboardAccessoryBar.consumeCtrl(data);
        }

        this._lastTerminalData = { data, time: performance.now() };

        // ── Local Echo Pass-through ──
        // After a composer nav key (arrow/Home/End/Delete) the real cursor may
        // sit mid-text, where the overlay's append-only buffering would corrupt
        // both the preview and the submitted text. Such sessions are handed
        // back to plain PTY echo until Enter or Ctrl+C submits/cancels the
        // composer line (see the nav-key branch below).
        const echoPassthrough =
          this._localEchoEnabled && this._echoPassthroughSessions?.has(this.activeSessionId);
        if (echoPassthrough && (data === '\r' || data === '\x03')) {
          this._echoPassthroughSessions.delete(this.activeSessionId);
        }

        // ── Local Echo Mode ──
        // When enabled, keystrokes are buffered locally in the overlay for
        // instant visual feedback.  Nothing is sent to the PTY until Enter
        // (or a control char) is pressed — avoids out-of-order char delivery.
        if (this._localEchoEnabled && !echoPassthrough) {
          if (data === '\x7f') {
            const source = this._localEchoOverlay?.removeChar();
            if (source === 'flushed') {
              // Sync app-level flushed Maps (per-session state for tab switching)
              const { count, text } = this._localEchoOverlay.getFlushed();
              if (this._flushedOffsets?.has(this.activeSessionId)) {
                if (count === 0) {
                  this._flushedOffsets.delete(this.activeSessionId);
                  this._flushedTexts?.delete(this.activeSessionId);
                } else {
                  this._flushedOffsets.set(this.activeSessionId, count);
                  this._flushedTexts?.set(this.activeSessionId, text);
                }
              }
              this._pendingInput += data;
              flushInput();
            } else if (source === false) {
              // Nothing pending, nothing flushed, nothing detected. The
              // composer may still hold text the overlay cannot see (buffer
              // detection is suppressed after a control-char flush), so
              // forward the backspace instead of swallowing it (issue #218);
              // an empty composer ignores it.
              this._pendingInput += data;
              flushInput();
            }
            // 'pending' = removed unsent text (no PTY backspace needed)
            return;
          }
          if (/^[\r\n]+$/.test(data)) {
            // Enter: send full buffered text + \r to PTY in one shot
            const text = this._localEchoOverlay?.pendingText || '';
            this._localEchoOverlay?.clear();
            // Suppress detection so PTY-echoed text isn't re-detected as user input
            this._localEchoOverlay?.suppressBufferDetection();
            // Clear flushed offset and text — Enter commits all text
            this._flushedOffsets?.delete(this.activeSessionId);
            this._flushedTexts?.delete(this.activeSessionId);
            if (this._inputFlushTimeout) {
              clearTimeout(this._inputFlushTimeout);
              this._inputFlushTimeout = null;
            }
            if (text) {
              this._pendingInput += text;
              flushInput();
            }
            // Send \r after a short delay so text arrives first
            setTimeout(() => {
              this._pendingInput += '\r';
              flushInput();
            }, 80);
            return;
          }
          if (data.length > 1 && data.charCodeAt(0) >= 32) {
            // Paste: append to overlay only (sent on Enter)
            this._localEchoOverlay?.appendText(data);
            return;
          }
          if (data.charCodeAt(0) < 32) {
            // Skip xterm-generated terminal responses.
            // These arrive via triggerDataEvent when the terminal processes
            // buffer data (DA responses, OSC color queries, mode reports, etc.).
            // They are NOT user input and must not clear flushed text state.
            // Covers: CSI (\x1b[), OSC (\x1b]), DCS (\x1bP), APC (\x1b_),
            // PM (\x1b^), SOS (\x1bX), and any other multi-byte ESC sequence.
            // Single-byte ESC (user pressing Escape) still falls through to
            // the control char handler below.
            if (data.length > 1 && data.charCodeAt(0) === 27) {
              // Bracketed paste (terminal.paste() while DECSET 2004 is on):
              // flush typed-but-unsent overlay text FIRST so the pasted block
              // lands after it in the composer, not before it (issue #219).
              // The paste sequence gets its own delayed write: Codex's
              // paste-burst handling drops keystrokes that arrive in the SAME
              // PTY read as a bracketed paste (verified against codex 0.147),
              // mirroring the delayed \r in the Enter branch above.
              if (data.startsWith(window.CodemanTerminalInput.BRACKETED_PASTE_START)) {
                const hadPending = !!this._localEchoOverlay?.pendingText;
                this._flushLocalEchoPending();
                if (hadPending) {
                  flushInput();
                  setTimeout(() => {
                    this._pendingInput += data;
                    flushInput();
                  }, 80);
                } else {
                  this._pendingInput += data;
                  flushInput();
                }
                return;
              }
              // Composer nav keys (arrows, Home/End, Delete, PgUp/PgDn):
              // flush unsent text so the key edits the real composer state,
              // then hand the session to plain PTY echo until Enter/Ctrl+C.
              // The cursor may now sit mid-text, where append-only buffering
              // cannot track edits (issue #218).
              if (window.CodemanTerminalInput.isComposerNavKey(data)) {
                this._flushLocalEchoPending();
                if (!this._echoPassthroughSessions) this._echoPassthroughSessions = new Set();
                this._echoPassthroughSessions.add(this.activeSessionId);
                this._pendingInput += data;
                flushInput();
                return;
              }
              // Multi-byte escape sequence — forward to PTY without clearing
              // overlay/flushed state (terminal response, not user input)
              this._pendingInput += data;
              flushInput();
              return;
            }
            // During buffer load (tab switch), stray control chars from
            // terminal response processing must not wipe the flushed state
            // that selectSession() is actively restoring.
            if (this._restoringFlushedState) {
              this._pendingInput += data;
              flushInput();
              return;
            }
            // Tab key: send pending text + Tab to PTY for tab completion.
            // Set a flag so flushPendingWrites() re-detects buffer text when
            // the PTY response arrives (event-driven, no fixed timer).
            if (data === '\t') {
              const text = this._localEchoOverlay?.pendingText || '';
              this._localEchoOverlay?.clear();
              this._flushedOffsets?.delete(this.activeSessionId);
              this._flushedTexts?.delete(this.activeSessionId);
              if (text) {
                this._pendingInput += text;
              }
              this._pendingInput += data;
              if (this._inputFlushTimeout) {
                clearTimeout(this._inputFlushTimeout);
                this._inputFlushTimeout = null;
              }
              // Snapshot prompt line text BEFORE flushing — used to distinguish
              // real Tab completions from pre-existing Claude UI text.
              let baseText = '';
              try {
                const p = this._localEchoOverlay?.findPrompt?.();
                if (p) {
                  const buf = this.terminal.buffer.active;
                  const line = buf.getLine(buf.viewportY + p.row);
                  if (line)
                    baseText = line
                      .translateToString(true)
                      .slice(p.col + 2)
                      .trimEnd();
                }
              } catch {}
              this._tabCompletionBaseText = baseText;
              flushInput();
              this._tabCompletionSessionId = this.activeSessionId;
              this._tabCompletionRetries = 0;
              // Fallback: if flushPendingWrites() detection misses the completion
              // (e.g., flicker filter delays data, or xterm hasn't processed writes
              // by the time the callback fires), retry detection after a delay.
              // This ensures the overlay renders even without further terminal data.
              if (this._tabCompletionFallback) clearTimeout(this._tabCompletionFallback);
              const selfTab = this;
              this._tabCompletionFallback = setTimeout(() => {
                selfTab._tabCompletionFallback = null;
                if (!selfTab._tabCompletionSessionId || selfTab._tabCompletionSessionId !== selfTab.activeSessionId)
                  return;
                const ov = selfTab._localEchoOverlay;
                if (!ov || ov.pendingText) return;
                selfTab.terminal.write('', () => {
                  if (!selfTab._tabCompletionSessionId) return;
                  ov.resetBufferDetection();
                  const detected = ov.detectBufferText();
                  if (detected && detected !== selfTab._tabCompletionBaseText) {
                    selfTab._tabCompletionSessionId = null;
                    selfTab._tabCompletionRetries = 0;
                    selfTab._tabCompletionBaseText = null;
                    ov.rerender();
                  }
                });
              }, 300);
              return;
            }
            // Control chars (Ctrl+C, single ESC): send buffered text + control char immediately
            const text = this._localEchoOverlay?.pendingText || '';
            this._localEchoOverlay?.clear();
            // Suppress detection so PTY-echoed text isn't re-detected as user input
            this._localEchoOverlay?.suppressBufferDetection();
            // Clear flushed offset and text — control chars (Ctrl+C, Escape) change
            // cursor position or abort readline, making flushed text tracking invalid.
            this._flushedOffsets?.delete(this.activeSessionId);
            this._flushedTexts?.delete(this.activeSessionId);
            if (text) {
              this._pendingInput += text;
            }
            this._pendingInput += data;
            if (this._inputFlushTimeout) {
              clearTimeout(this._inputFlushTimeout);
              this._inputFlushTimeout = null;
            }
            flushInput();
            return;
          }
          if (data.length === 1 && data.charCodeAt(0) >= 32) {
            // Printable char: add to overlay only (sent on Enter)
            this._localEchoOverlay?.addChar(data);
            return;
          }
        }

        // ── Predictive Echo (codex): visual only. A plain statement, never a
        // `return`: control ALWAYS falls through into the send path below,
        // which is the byte-identity guarantee for #218/#219/#220/#222 —
        // with the predictor active, absent or throwing, the wire sees the
        // same bytes. Body in _predictHookOnData (vm-testable).
        this._predictHookOnData(data);

        // ── Normal Mode (echo disabled) ──
        this._pendingInput += data;

        // Control chars (Enter, Ctrl+C, escape sequences) — flush immediately
        if (data.charCodeAt(0) < 32 || data.length > 1) {
          if (this._inputFlushTimeout) {
            clearTimeout(this._inputFlushTimeout);
            this._inputFlushTimeout = null;
          }
          flushInput();
          return;
        }

        // Regular chars — flush immediately if typed after a gap (>50ms),
        // otherwise batch via microtask to coalesce rapid keystrokes (paste).
        const now = performance.now();
        if (now - this._lastKeystrokeTime > 50) {
          // Single char after a gap — send immediately, no setTimeout latency
          if (this._inputFlushTimeout) {
            clearTimeout(this._inputFlushTimeout);
            this._inputFlushTimeout = null;
          }
          this._lastKeystrokeTime = now;
          flushInput();
        } else {
          // Rapid sequence (paste or fast typing) — coalesce via microtask
          this._lastKeystrokeTime = now;
          if (!this._inputFlushTimeout) {
            this._inputFlushTimeout = setTimeout(flushInput, 0);
          }
        }
      }
    });
  },

  /**
   * Register a custom link provider for xterm.js that detects file paths
   * in terminal output and makes them clickable.
   * When clicked, opens a floating log viewer window with live streaming.
   */
  registerFilePathLinkProvider() {
    const self = this;

    // Debug: Track if provider is being invoked
    let lastInvokedLine = -1;

    const provider = {
      provideLinks(bufferLineNumber, callback) {
        // Debug logging - only log if line changed to avoid spam
        if (bufferLineNumber !== lastInvokedLine) {
          lastInvokedLine = bufferLineNumber;
          console.debug('[LinkProvider] Checking line:', bufferLineNumber);
        }

        const buffer = self.terminal.buffer.active;
        // provideLinks passes 1-based line number, getLine expects 0-based
        const line = buffer.getLine(bufferLineNumber - 1);

        if (!line) {
          callback(undefined);
          return;
        }

        // Stitch the LOGICAL line back together.
        //
        // xterm invokes this provider per visible ROW and translateToString returns
        // that row alone, so a URL or path longer than the terminal is wide matched
        // only as far as the row boundary and the link opened a PREFIX of the real
        // target. `terminalLogicalLine` (constants.js) owns the reconstruction —
        // both continuation kinds, the indent a hard wrap leaves on its
        // continuation, and the offset↔cell mapping — because touch selection
        // measures the SAME lines and the two must not disagree.
        // Bounded so a screenful of full-width output (wide tables, box drawing)
        // cannot make every hover stitch and re-scan the entire viewport.
        const MAX_STITCHED_ROWS = 12;
        const logical = window.CodemanTerminalLines?.terminalLogicalLine(
          buffer,
          bufferLineNumber - 1,
          self.terminal.cols,
          MAX_STITCHED_ROWS
        );
        if (!logical) {
          callback(undefined);
          return;
        }
        const lineText = logical.text;

        /** Map an offset in the stitched text back to a 1-based terminal cell. */
        const coordAt = (index) => {
          const cell = logical.offsetToCell(index);
          return { x: cell.col + 1, y: cell.row + 1 };
        };

        if (!lineText || !lineText.includes('/')) {
          callback(undefined);
          return;
        }

        const links = [];

        // Pattern 0: URLs (https://, http://) — matched first so they take priority
        //
        // A single `&` is PART of the URL: it separates query parameters, so excluding
        // it truncated every real query string (`?post=1479&action=edit` linked only
        // through `1479`, landing on the wrong page). `&&` is still a boundary, since
        // that is the shell operator and never appears inside a URL. A lone trailing
        // `&` is trimmed below with the other trailing punctuation.
        const urlPattern = /https?:\/\/(?:[^\s"'<>|;&)\]\x00-\x1f]|&(?!&))+/g;

        const addUrlLink = (url, matchIndex) => {
          // Strip trailing punctuation that's likely not part of the URL
          const cleaned = url.replace(/[.,;:!?)&]+$/, '');
          const startCol = lineText.indexOf(cleaned, matchIndex);
          if (startCol === -1) return;

          const start = coordAt(startCol);
          const end = coordAt(startCol + cleaned.length);
          if (links.some((l) => l.range.start.x === start.x && l.range.start.y === start.y)) return;

          links.push({
            text: cleaned,
            range: { start, end },
            decorations: { pointerCursor: true, underline: true },
            activate(_event, text) {
              window.open(text, '_blank', 'noopener,noreferrer');
            },
            hover() {
              self._linkHovered = true;
            },
            leave() {
              self._linkHovered = false;
            },
          });
        };

        // Pattern 1: Commands with file paths (tail -f, cat, head, grep pattern, etc.)
        // Handles: tail -f /path, grep pattern /path, cat -n /path
        // ⚠ The arg group must stay linear-time: `(?:[^\s\/]*\s+)*` (empty-matchable
        // token, unbounded) backtracks exponentially on lines with a trigger word
        // followed by multi-space runs (e.g. wrapped heredoc/table output) — froze
        // the whole tab on hover. Non-empty token + bounded reps is O(n).
        const cmdPattern = /\b(tail|cat|head|less|grep|watch|vim|nano)\s+(?:[^\s\/]+\s+){0,4}(\/[^\s"'<>|;&\n\x00-\x1f]+)/g;

        // Pattern 2: Paths with common extensions. Image/PDF/media extensions are
        // included so pasted-attachment paths (`.claude-images/paste-*.png`) and
        // screenshots an agent just wrote are clickable; those open the file
        // preview rather than the log viewer (see addLink).
        //
        // The literal lives in constants.js because the response viewer linkifies
        // the SAME paths out of markdown — one definition, two consumers. A fresh
        // instance per call: `lastIndex` is per-object state.
        const extPattern = absoluteFilePathPattern();

        // Pattern 3: Bash() tool output
        const bashPattern = /Bash\([^)]*?(\/(?:home|tmp|var|etc|opt)[^\s"'<>|;&\)\n\x00-\x1f]+)/g;

        const addLink = (filePath, matchIndex) => {
          const startCol = lineText.indexOf(filePath, matchIndex);
          if (startCol === -1) return;

          const start = coordAt(startCol);
          const end = coordAt(startCol + filePath.length);
          // Skip if already have link at this position
          if (links.some((l) => l.range.start.x === start.x && l.range.start.y === start.y)) return;

          links.push({
            text: filePath,
            range: { start, end }, // 1-based, may span wrapped rows
            decorations: {
              pointerCursor: true,
              underline: true,
            },
            activate(event, text) {
              // Tailing a PNG in the log viewer shows binary noise; the file preview
              // already renders images, PDFs, documents and media inline — and it
              // now reaches files outside the workspace too, which is where an
              // agent's screenshots and scratchpad captures actually land.
              //
              // Text goes to the log viewer, which follows a file that is still
              // being written — but ONLY where it can actually read: it spawns
              // `tail -f` and allows the workspace, /var/log and ~/logs, so an
              // out-of-workspace path there answered "Path must be within
              // working directory or allowed log directories" while the SAME
              // path clicked in the response viewer previewed fine. The preview
              // reads those through the guarded attachment routes, so external
              // paths route there and the two surfaces agree.
              if (previewsInFileViewer(text) || self._isExternalPreviewPath(text, self.activeSessionId)) {
                self.openFilePreview(text, self.activeSessionId);
                return;
              }
              self.openLogViewerWindow(text, self.activeSessionId);
            },
            hover() {
              self._linkHovered = true;
            },
            leave() {
              self._linkHovered = false;
            },
          });
        };

        // Match all patterns — URLs first so they take priority
        let match;

        urlPattern.lastIndex = 0;
        while ((match = urlPattern.exec(lineText)) !== null) {
          addUrlLink(match[0], match.index);
        }

        cmdPattern.lastIndex = 0;
        while ((match = cmdPattern.exec(lineText)) !== null) {
          addLink(match[2], match.index);
        }

        extPattern.lastIndex = 0;
        while ((match = extPattern.exec(lineText)) !== null) {
          addLink(match[1], match.index);
        }

        bashPattern.lastIndex = 0;
        while ((match = bashPattern.exec(lineText)) !== null) {
          addLink(match[1], match.index);
        }

        if (links.length > 0) {
          console.debug(
            '[LinkProvider] Found links:',
            links.map((l) => l.text)
          );
        }
        callback(links.length > 0 ? links : undefined);
      },
    };

    // Keep the provider reachable: on touch devices xterm's linkifier never
    // resolves a link (it is driven by mousemove/mouseup, which a tap does not
    // produce), so the tap path asks this SAME provider what is under the finger
    // rather than growing a second, driftable copy of the patterns.
    // See _terminalLinkAtPoint.
    this._terminalLinkProvider = provider;
    this.terminal.registerLinkProvider(provider);

    console.log('[LinkProvider] File path link provider registered');
  },

  /**
   * The terminal link under a viewport point, or null.
   *
   * Resolved through the provider registered above, so a tap and a desktop click
   * can never disagree about what is a link or where it ends. Containment
   * mirrors xterm's own `_linkAtPosition` — flattened `y * cols + x`, inclusive
   * at both ends — for the same reason.
   *
   * ⚠️ The provider answers its callback SYNCHRONOUSLY (every path in
   * `registerFilePathLinkProvider` does, including the empty ones). xterm's
   * ILinkProvider contract permits an async reply, so this reads whatever
   * arrived by the time the call returns and answers null otherwise: a tap then
   * keeps its normal meaning instead of opening a link late, after the gesture
   * that made `window.open` permissible is gone.
   */
  _terminalLinkAtPoint(clientX, clientY) {
    const provider = this._terminalLinkProvider;
    const buffer = this.terminal?.buffer?.active;
    if (!provider || !buffer) return null;
    const pos = this._clientPointToCell(clientX, clientY);
    if (!pos) return null;
    // Link ranges are 1-based ABSOLUTE buffer lines (xterm adds ydisp to the
    // viewport row before asking), which is what the provider's coordAt() emits.
    const y = (buffer.viewportY || 0) + pos.row;
    let links = null;
    try {
      provider.provideLinks(y, (result) => {
        links = result || [];
      });
    } catch {
      return null;
    }
    if (!links || links.length === 0) return null;
    const cols = Math.max(1, this.terminal.cols || 1);
    const current = y * cols + pos.col;
    return (
      links.find((link) => {
        const start = link?.range?.start;
        const end = link?.range?.end;
        if (!start || !end) return false;
        return start.y * cols + start.x <= current && current <= end.y * cols + end.x;
      }) || null
    );
  },

  /**
   * Is this point on the caret's logical line — the editable composer?
   *
   * There a tap means "put the cursor here", so a URL the USER typed or pasted
   * into a prompt must stay editable rather than opening itself. The caret is the
   * signal that works for every CLI: claude's composer row carries it, and in a
   * plain shell it sits on the prompt line while output scrolls above, so the
   * same test covers both without asking what mode is running (tap
   * classification cannot answer this — a shell session classifies EVERY tap as
   * 'input', which would leave every URL in shell output inert).
   *
   * The caret's line is walked out through soft wraps, since a long prompt spans
   * rows.
   */
  _tapIsOnCaretLine(clientX, clientY) {
    const buffer = this.terminal?.buffer?.active;
    if (!buffer?.getLine) return false;
    const pos = this._clientPointToCell(clientX, clientY);
    if (!pos) return false;
    const rows = Math.max(1, this.terminal.rows || 1);
    const cursorRow = Math.max(0, Math.min(rows - 1, buffer.cursorY || 0));
    const tappedRow = pos.row - 1;
    if (tappedRow === cursorRow) return true;
    let start = cursorRow;
    while (start > 0 && buffer.getLine(buffer.viewportY + start)?.isWrapped) start--;
    let end = cursorRow;
    while (end + 1 < rows && buffer.getLine(buffer.viewportY + end + 1)?.isWrapped) end++;
    return tappedRow >= start && tappedRow <= end;
  },

  /**
   * Activate the terminal link under a touch point. Returns true when one was.
   *
   * xterm activates a link from a `mousemove` that resolves what is under the
   * pointer, followed by a `mouseup` on its SCREEN element — and on a touch
   * device it receives neither: `touch-action: none` plus touchstart's
   * preventDefault suppress the browser's compatibility mouse events,
   * _installMobileTapMouseGuard drops the ones that still arrive, and the
   * synthetic pair dispatched for mouse REPORTING goes to the `.xterm` root,
   * an ANCESTOR of the node the linkifier listens on (so it cannot reach it) and
   * carries no mousemove either way. Every URL and file path in the terminal was
   * therefore inert on phones and tablets — Claude Code's own `/login` URL
   * included, which is unfinishable from a phone without this.
   *
   * Activating here, synchronously inside the touchend handler, is what keeps
   * the user gesture that lets the URL branch's `window.open` through the popup
   * blocker; a later activation (a timer, a promise) is silently swallowed.
   */
  _activateTerminalLinkAtPoint(clientX, clientY) {
    const link = this._terminalLinkAtPoint(clientX, clientY);
    if (!link || typeof link.activate !== 'function') return false;
    try {
      link.activate(null, link.text);
    } catch (err) {
      console.warn('[LinkProvider] tap activation failed:', err);
      return false;
    }
    return true;
  },

  // ═══════════════════════════════════════════════════════════════
  // Touch text selection — long-press to select, tap to extend, Copy
  // ═══════════════════════════════════════════════════════════════
  //
  // There was no way to copy terminal text from a phone at all. Three layers
  // ruled it out at once: `user-select: none` on the whole terminal subtree
  // (taps are cursor gestures there, so the OS callout had to go), the WebGL
  // renderer drawing glyphs as pixels with only the accessibility tree behind
  // them, and xterm's own selection being a mouse DRAG — while the tap path
  // dispatches a zero-movement mousedown/mouseup pair, i.e. a click.
  //
  // So the gesture drives xterm's selection API directly (`select`, public and
  // renderer-independent, and the highlight is drawn by xterm itself). Long-press
  // is free real estate: tap and swipe are taken, long-press and double-tap are
  // used by nothing.

  /**
   * While a selection gesture is in flight, the terminal input must not hold focus.
   *
   * ⚠️ This is the guard that actually fixes "the keyboard pops up the moment the
   * selection appears". The mouse-event guard cannot: the focus does not arrive
   * through a mouse event at all. Android Chrome runs its own long-press handling
   * at ~500ms and focuses the nearest editable element — xterm's helper textarea,
   * a real <textarea> parked at the cursor — and nothing in the touch path can
   * preventDefault an event it never sees. Blurring on focus is the one move that
   * works regardless of which path did the focusing.
   *
   * Bounded by a self-expiring deadline rather than by the bar's visibility, so a
   * flag left set can never make the keyboard permanently unreachable.
   */
  _installTouchSelectionFocusGuard() {
    const textarea = this.terminal?.textarea;
    if (!textarea || textarea._codemanSelectionFocusGuard) return;
    textarea._codemanSelectionFocusGuard = true;
    textarea.addEventListener('focus', () => {
      if (!this._touchSelectionFocusGuarded()) return;
      // Same task as the focus: a keyboard that opens and closes still shoves the
      // viewport, and the selection with it.
      this._blurMobileTerminalInput();
    });
  },

  _touchSelectionFocusGuarded() {
    if (this._touchSelecting) return true;
    return performance.now() < (this._touchSelectionFocusGuardUntil || 0);
  },

  /** Re-arm the focus guard; called at every step of the gesture. */
  _armTouchSelectionFocusGuard() {
    this._touchSelectionFocusGuardUntil =
      performance.now() + (window.CodemanTerminalInput?.TOUCH_SELECT_FOCUS_GUARD_MS || 800);
  },

  /** The absolute 0-based buffer cell under a viewport point, or null. */
  _touchSelectionCellAt(clientX, clientY) {
    const pos = this._clientPointToCell(clientX, clientY);
    const buffer = this.terminal?.buffer?.active;
    if (!pos || !buffer) return null;
    return { col: pos.col - 1, row: (buffer.viewportY || 0) + pos.row - 1 };
  },

  /**
   * The logical line a buffer row belongs to — the SAME reconstruction the link
   * provider matches against (`terminalLogicalLine`, constants.js).
   *
   * ⚠️ Walking only `isWrapped` was not enough: Claude Code and every other Ink CLI
   * wrap their own output and emit real newlines, so nothing is flagged and "Line"
   * grabbed the one row on screen instead of the whole wrapped line. The shared
   * helper treats a row that fills the last column as continuing, and drops the
   * indent such a continuation carries.
   */
  _touchSelectionLogicalLine(row) {
    const buffer = this.terminal?.buffer?.active;
    const cols = Math.max(1, this.terminal?.cols || 1);
    if (!buffer || typeof window.CodemanTerminalLines?.terminalLogicalLine !== 'function') return null;
    return window.CodemanTerminalLines.terminalLogicalLine(buffer, row, cols);
  },

  /**
   * The run of NON-WHITESPACE around a cell, as {index, length} in absolute cells.
   *
   * Whitespace is the only delimiter on purpose: in a terminal the thing worth
   * grabbing is a path, a URL, a container id or a hash, and every punctuation-
   * aware word rule cuts those in half.
   *
   * ⚠️ Bounds are found in the reconstructed TEXT (so a token is not cut at a wrap)
   * and then converted to CELLS, because an xterm selection is one contiguous run of
   * cells. A token spanning a hard wrap therefore also covers the indent cells
   * between its halves — the alternative, a selection that skips them, cannot be
   * expressed and would not match what is highlighted.
   */
  _touchSelectionWordAt(cell) {
    const cols = Math.max(1, this.terminal?.cols || 1);
    const line = this._touchSelectionLogicalLine(cell.row);
    if (!line) return null;
    const offset = line.cellToOffset(cell.row, cell.col);
    if (offset < 0) return null;
    const ch = line.text[offset];
    if (!ch || !ch.trim()) return null; // pressed on blank space: nothing to select
    let from = offset;
    while (from > 0 && line.text[from - 1] && line.text[from - 1].trim()) from--;
    let to = offset;
    while (to + 1 < line.text.length && line.text[to + 1] && line.text[to + 1].trim()) to++;
    const startCell = line.offsetToCell(from);
    const endCell = line.offsetToCell(to);
    const index = startCell.row * cols + startCell.col;
    const length = endCell.row * cols + endCell.col - index + 1;
    return length > 0 ? { index, length } : null;
  },

  /** Apply a selection given absolute cell indices; `select()` wraps a length across rows. */
  _applyTouchSelection(index, length) {
    const cols = Math.max(1, this.terminal?.cols || 1);
    if (length <= 0) return;
    this.terminal?.select?.(index % cols, Math.floor(index / cols), length);
  },

  /** Long-press fired: select the word under the finger and arm drag-to-extend. */
  _beginTouchSelection(clientX, clientY) {
    const cell = this._touchSelectionCellAt(clientX, clientY);
    if (!cell) return false;
    const word = this._touchSelectionWordAt(cell);
    if (!word) return false;
    // The keyboard must not sit on top of the thing being selected, and the
    // composer would eat the selection on its next keystroke anyway.
    this._blurMobileTerminalInput();
    this._touchSelectionAnchor = word;
    this._touchSelecting = true;
    this._touchSelectionActive = true;
    // From here until the gesture ends, no trusted mouse event may reach xterm —
    // see _endTouchSelectionGesture for why — and the terminal input may not take
    // focus. Both are re-armed as the gesture continues, since their windows are
    // short and a press can be held for much longer.
    this._suppressTrustedTapMouseEvents();
    this._armTouchSelectionFocusGuard();
    this._applyTouchSelection(word.index, word.length);
    // Android answers; iOS ignores it silently. Both are fine.
    try {
      navigator.vibrate?.(15);
    } catch {
      /* vibration is a nicety, never a requirement */
    }
    this._showTouchSelectionBar();
    return true;
  },

  /**
   * Extend the selection to a point, from the anchor word.
   *
   * Used by BOTH the drag that follows the long-press and a tap while the bar is
   * up. The tap form is the one that makes this usable on a phone: picking up a
   * 4px handle with a fingertip is a coin flip, tapping the other end is not.
   */
  _extendTouchSelection(clientX, clientY) {
    const anchor = this._touchSelectionAnchor;
    const cell = this._touchSelectionCellAt(clientX, clientY);
    if (!anchor || !cell) return;
    const cols = Math.max(1, this.terminal?.cols || 1);
    const point = cell.row * cols + cell.col;
    // Grow from whichever END of the anchor word is further away, so the word the
    // press landed on always stays inside the selection.
    const from = Math.min(anchor.index, point);
    const to = Math.max(anchor.index + anchor.length, point + 1);
    this._applyTouchSelection(from, to - from);
    this._armTouchSelectionFocusGuard();
    this._positionTouchSelectionBar();
  },

  /**
   * Finger up: end the DRAG, keep the selection and the bar.
   *
   * ⚠️ The browser synthesizes a trusted `mousedown`/`mouseup` pair after this
   * touchend, and xterm acts on BOTH: `CoreBrowserTerminal` calls `focus()` from
   * its screen-element mousedown — so the on-screen keyboard springs up over the
   * text you just selected — and `SelectionService` resets the model there, so the
   * selection, and with it the Copy bar (hidden when `hasSelection()` goes false),
   * vanishes the instant you lift your finger. That is exactly what long-press-to-
   * copy did before this: keyboard up, selection gone, nothing to copy.
   *
   * The tap path already owns a guard for those events; it simply never armed it
   * here. Arming it is the fix, and the caller additionally `preventDefault()`s the
   * touchend so the synthesis is stopped at the source rather than swatted after.
   */
  _endTouchSelectionGesture() {
    this._touchSelecting = false;
    this._suppressTrustedTapMouseEvents();
    this._armTouchSelectionFocusGuard();
    this._positionTouchSelectionBar();
    // Auto Copy's other entry point. The touchend that ends this gesture is
    // preventDefault()ed (that is what stops the compat mouse pair from
    // stealing the selection back), so the document mouseup listener never sees
    // this surface at all, so a phone would have a dead toggle without this call.
    this._flushAutoCopySelection();
  },

  /** Whole logical line under the anchor — the common case a word selection just missed. */
  _selectTouchSelectionLine() {
    const anchor = this._touchSelectionAnchor;
    const cols = Math.max(1, this.terminal?.cols || 1);
    if (!anchor) return;
    const line = this._touchSelectionLogicalLine(Math.floor(anchor.index / cols));
    if (!line) return;
    // Every row of the logical line, wraps included — that is the whole point of
    // the button. The end is the last row's last non-blank cell: trailing cells are
    // padding, and copying them would put a wall of spaces on the clipboard.
    const buffer = this.terminal?.buffer?.active;
    const lastRow = (buffer?.getLine(line.endRow)?.translateToString(true) || '').length;
    const index = line.startRow * cols;
    const length = line.endRow * cols + Math.max(0, lastRow - 1) - index + 1;
    if (length <= 0) return;
    this._touchSelectionAnchor = { index, length };
    this._applyTouchSelection(index, length);
    this._positionTouchSelectionBar();
    // Widening to the whole line is a new selection the user asked for, and the
    // button's click carries the activation both clipboard paths need.
    this._flushAutoCopySelection();
  },

  /** Copy through the shared path: Clipboard API, else execCommand (plain-HTTP installs). */
  async _copyTouchSelection() {
    const ok = await this.copyTerminalSelection();
    this._clearTouchSelection();
    // copyTerminalSelection hands focus back to the terminal, which is right on a
    // desktop and wrong on a phone: it opens the on-screen keyboard over whatever
    // was just copied, with nothing waiting to be typed. The execCommand fallback
    // focuses its own temp textarea on the way through, so this runs after both.
    if (typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice?.()) {
      this._blurMobileTerminalInput();
    }
    return ok;
  },

  _clearTouchSelection() {
    this._touchSelecting = false;
    this._touchSelectionActive = false;
    this._touchSelectionAnchor = null;
    this.terminal?.clearSelection?.();
    this._hideTouchSelectionBar();
  },

  /** The Copy/Line/dismiss bar. Built in JS — index.html is read once at server start. */
  _ensureTouchSelectionBar() {
    if (this._touchSelectionBar?.isConnected) return this._touchSelectionBar;
    const container = document.getElementById('terminalContainer');
    if (!container) return null;
    const bar = document.createElement('div');
    bar.className = 'term-select-bar';
    bar.setAttribute('role', 'toolbar');
    bar.innerHTML =
      '<button type="button" class="term-select-btn" data-act="copy">Copy</button>' +
      '<button type="button" class="term-select-btn" data-act="line">Line</button>' +
      '<button type="button" class="term-select-btn term-select-btn--close" data-act="close" aria-label="Clear selection">✕</button>';
    // Pointer events only: the container's touch handlers are what own gestures in
    // this subtree, and they skip anything inside the bar (see initTerminal).
    bar.addEventListener('click', (ev) => {
      const act = ev.target?.closest?.('[data-act]')?.dataset?.act;
      if (!act) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (act === 'copy') void this._copyTouchSelection();
      else if (act === 'line') this._selectTouchSelectionLine();
      else this._clearTouchSelection();
    });
    container.appendChild(bar);
    this._touchSelectionBar = bar;
    return bar;
  },

  _showTouchSelectionBar() {
    const bar = this._ensureTouchSelectionBar();
    if (!bar) return;
    bar.classList.add('visible');
    this._positionTouchSelectionBar();
  },

  _hideTouchSelectionBar() {
    this._touchSelectionBar?.classList.remove('visible');
  },

  /**
   * Park the bar just above the selection, or below it when the selection starts
   * at the top of the screen. Clamped to the container so it can never sit
   * off-screen with the only Copy button on it.
   */
  _positionTouchSelectionBar() {
    const bar = this._touchSelectionBar;
    const container = document.getElementById('terminalContainer');
    const screen = this.terminal?.element?.querySelector('.xterm-screen');
    const cell = this.terminal?._core?._renderService?.dimensions?.css?.cell;
    const range = this.terminal?.getSelectionPosition?.();
    const buffer = this.terminal?.buffer?.active;
    if (!bar || !container || !screen || !cell?.height || !range || !buffer) return;
    const screenRect = screen.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const viewportRow = (row) => row - (buffer.viewportY || 0);
    const topPx = screenRect.top - containerRect.top + viewportRow(range.start.y) * cell.height;
    const bottomPx = screenRect.top - containerRect.top + (viewportRow(range.end.y) + 1) * cell.height;
    const barHeight = bar.offsetHeight || 36;
    const gap = 6;
    let top = topPx - barHeight - gap;
    if (top < 0) top = bottomPx + gap;
    top = Math.max(0, Math.min(top, containerRect.height - barHeight));
    const left = screenRect.left - containerRect.left + range.start.x * (cell.width || 8);
    const barWidth = bar.offsetWidth || 150;
    bar.style.top = `${Math.round(top)}px`;
    bar.style.left = `${Math.round(Math.max(0, Math.min(left, containerRect.width - barWidth)))}px`;
  },

  showWelcome() {
    // Phones get the session overview instead of the welcome screen: on a small
    // screen "which session is blocked on me" beats "how do I start one". The
    // gate lives in mobile-overview.js; every other device falls through
    // unchanged. Both surfaces are toggled here so a breakpoint change (rotate,
    // unfold) swaps cleanly instead of showing both.
    if (this.shouldUseMobileOverview?.()) {
      const overlay = document.getElementById('welcomeOverlay');
      if (overlay) overlay.classList.remove('visible');
      this.hideHomeSessions?.();
      this.showMobileOverview();
      this._updateCjkInputState?.();
      return;
    }
    this.hideMobileOverview?.();
    const overlay = document.getElementById('welcomeOverlay');
    if (overlay) {
      overlay.classList.add('visible');
      this.loadTunnelStatus();
      this.applyWelcomeCliVisibility();
      this.loadHistorySessions();
      this.initSearchPanel();
      // Open tabs down the left gutter. Self-gating: a window too narrow to hold
      // the column without overlapping the content leaves it hidden.
      this.showHomeSessions?.();
    }
    // Home screen has no input target — hide the CJK textarea (activeSessionId
    // is null by the time we get here). Guarded: defined on the app object.
    this._updateCjkInputState?.();
  },

  hideWelcome() {
    this.hideMobileOverview?.();
    this.hideHomeSessions?.();
    const overlay = document.getElementById('welcomeOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
    // Collapse expanded QR when leaving welcome screen
    const qrWrap = document.getElementById('welcomeQr');
    if (qrWrap) {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.remove('expanded');
    }
    // Entering a session — restore CJK textarea if the user has it enabled
    // (activeSessionId is already set by selectSession before this call).
    this._updateCjkInputState?.();
  },

  /**
   * Fetch and deduplicate history sessions (up to 3 per project, sorted by date).
   * Uses projectKey for grouping because workingDir decoding is lossy.
   * @returns {Promise<Array>} deduplicated session list, most recent first
   */
  async _fetchHistorySessions() {
    const res = await fetch('/api/history/sessions');
    const data = await res.json();
    const sessions = data.data?.sessions || [];
    if (sessions.length === 0) return [];

    const byProject = new Map();
    for (const s of sessions) {
      const key = s.projectKey || s.workingDir;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(s);
    }
    const items = [];
    for (const [, group] of byProject) {
      items.push(...group.slice(0, 3));
    }
    items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    return items;
  },

  /**
   * Fetch the unified session list (live + persisted + non-Claude + closed
   * history), already de-duplicated and sorted newest-first by the backend
   * (`GET /api/sessions/unified`, COD-121). No client-side grouping needed.
   * @param {number} [limit=60] max sessions to request
   * @returns {Promise<Array>} unified session items, most recent first
   */
  async _fetchUnifiedSessions(limit = 60) {
    const res = await fetch('/api/sessions/unified?limit=' + limit);
    // ApiResponse envelope: { success, data: { sessions } }. Throw on failure so
    // callers (loadHistorySessions) hit their catch instead of rendering a 5xx as
    // an empty history.
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.success === false || !data.data) {
      throw new Error(data?.error || `unified sessions request failed (HTTP ${res.status})`);
    }
    return data.data.sessions || [];
  },

  /**
   * Resolve workingDir to a case-aware short label.
   * - Exact case path match → "#caseName"
   * - workingDir under a case dir → "#caseName/subdir"
   * - Otherwise → basename (e.g. "Claudeman")
   */
  /**
   * Badge text for a session's git worktree, or '' when it isn't on one.
   * `⑂ <name> · <branch>`, either half alone if that's all we know.
   * Branch is truncated: the badge row is a single nowrap line.
   */
  _worktreeLabel(s) {
    // Worktree name is REQUIRED. gitBranch alone is not worktree information —
    // every ordinary repo session has one, and badging all of them with `⑂ master`
    // is noise that buries the rows this badge exists to distinguish.
    const name = s && s.worktreeName;
    if (!name) return '';
    let branch = s.gitBranch || '';
    // A worktree's branch often just restates its name; don't print it twice.
    if (branch === name || branch === `worktree-${name}`) branch = '';
    if (branch.length > 24) branch = branch.slice(0, 23) + '\u2026';
    return '⑂ ' + [name, branch].filter(Boolean).join(' · ');
  },

  _resolveCaseLabel(workingDir, cases) {
    if (!workingDir) return '';
    let best = null;
    for (const c of cases || []) {
      if (!c || !c.path) continue;
      if (workingDir === c.path) {
        return `#${c.name}`;
      }
      if (workingDir.startsWith(c.path + '/')) {
        const len = c.path.length;
        if (!best || len > best.len) {
          best = { name: c.name, suffix: workingDir.slice(len), len };
        }
      }
    }
    if (best) return `#${best.name}${best.suffix}`;
    return workingDir.split('/').pop() || workingDir;
  },

  /**
   * Normalize a home prefix to "~" on both Linux (`/home/<user>`) and macOS
   * (`/Users/<user>`). The lookahead lets the home directory ITSELF match, so a
   * path that is exactly `$HOME` renders "~" instead of being left raw.
   *
   * This is the only place that pattern belongs. Two hand-rolled copies had
   * drifted, each broken on the platform its author was not using: the Run
   * menu's matched `/home/` only, so on macOS nothing was stripped and every
   * Recent Sessions row spent its first ~19 characters on an identical
   * `/Users/<user>/` prefix (#273); the case-manage list's matched `/Users/`
   * only, so no Linux path was ever abbreviated there. Route new path labels
   * through here rather than writing a third copy.
   */
  _shortenHomePath(p) {
    return (p || '').replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
  },

  /**
   * Build a single history item DOM element.
   * @param {object} s session record
   * @param {Array} cases linked cases (for #caseName label)
   * @param {object} [options]
   * @param {boolean} [options.showViewAll=true] show "View all in folder" button in detail panel
   * @param {Function} [options.onActivate] main-row click handler override (default: resume the conversation)
   */
  _buildHistoryItem(s, cases, options) {
    const showViewAll = options?.showViewAll !== false;

    // Size: only render when a numeric byte count is present (unified items
    // backed solely by a live/persisted source may omit it).
    const hasSize = typeof s.sizeBytes === 'number';
    const size = !hasSize
      ? ''
      : s.sizeBytes < 1024
        ? `${s.sizeBytes}B`
        : s.sizeBytes < 1048576
          ? `${(s.sizeBytes / 1024).toFixed(0)}K`
          : `${(s.sizeBytes / 1048576).toFixed(1)}M`;

    // Timestamp: unified shape carries lastActivityAt (ms epoch); the older
    // folder-modal/history shape carries an ISO lastModified string. Prefer ms,
    // fall back to parsing the string, and omit entirely when neither is valid.
    const tsMs =
      typeof s.lastActivityAt === 'number'
        ? s.lastActivityAt
        : s.lastModified
          ? Date.parse(s.lastModified)
          : NaN;
    let timeStr = '';
    if (!Number.isNaN(tsMs)) {
      const date = new Date(tsMs);
      timeStr =
        date.toLocaleDateString('en', { month: 'short', day: 'numeric' }) +
        ' ' +
        date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    const shortDir = this._shortenHomePath(s.workingDir);
    const caseLabel = this._resolveCaseLabel(s.workingDir, cases);

    const isLive = Array.isArray(s.sources) && s.sources.includes('live');

    const isPinned = s.pinned === true;

    const item = document.createElement('div');
    item.className = 'history-item' + (isPinned ? ' is-pinned' : '');
    item.title = s.workingDir || '';

    // Main row: clickable surface. A caller-supplied onActivate wins (the
    // Session Manager routes live rows to selectSession and history rows to
    // resume). Otherwise the default focuses the live tab when the row is a
    // still-running session, else resumes the conversation — keyed by the Claude
    // conversation UUID (claudeSessionId) when present, since resumed sessions
    // carry theirs separately from their Codeman id.
    const mainRow = document.createElement('div');
    mainRow.className = 'history-item-main';
    mainRow.addEventListener(
      'click',
      options?.onActivate ||
        (() => {
          if (isLive && this.sessions.has(s.sessionId)) {
            this.selectSession(s.sessionId);
          } else {
            this.resumeHistorySession(s.claudeSessionId || s.sessionId, s.workingDir || '', s.name, s.mode, s.resumeId);
          }
        })
    );

    const textCol = document.createElement('div');
    textCol.className = 'history-item-text';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'history-item-title';
    if (isPinned) {
      // Filled pin glyph indicating the session is pinned to the top (COD-139).
      const pin = document.createElement('span');
      pin.className = 'history-item-pin';
      pin.textContent = '📌';
      pin.setAttribute('aria-label', 'Pinned');
      pin.title = 'Pinned';
      titleSpan.appendChild(pin);
    }
    titleSpan.appendChild(document.createTextNode(this._historyRowLabel(s, shortDir)));

    // Badge row: mode (claude/codex/opencode/gemini/antigravity/pi/grok/deepseek/shell) + a LIVE pill.
    const badgeRow = document.createElement('div');
    badgeRow.className = 'history-item-badges';
    if (s.mode) {
      const modeBadge = document.createElement('span');
      modeBadge.className = 'history-item-badge history-item-badge-mode';
      modeBadge.textContent = s.mode;
      badgeRow.appendChild(modeBadge);
    }
    // Worktree pill (#266): distinguishes sessions from different worktrees of the
    // same repo, which are otherwise identical in this list. Name AND branch when
    // both are known; a hand-made `git worktree add` yields no recoverable name,
    // so it degrades to branch-only rather than guessing one.
    const wtLabel = this._worktreeLabel(s);
    if (wtLabel) {
      const wtBadge = document.createElement('span');
      wtBadge.className = 'history-item-badge history-item-badge-worktree';
      wtBadge.textContent = wtLabel;
      wtBadge.title = s.worktreeRepo ? `worktree of ${s.worktreeRepo}` : wtLabel;
      badgeRow.appendChild(wtBadge);
    }
    if (isLive) {
      const liveBadge = document.createElement('span');
      liveBadge.className = 'history-item-badge history-item-badge-live';
      liveBadge.textContent = 'LIVE';
      badgeRow.appendChild(liveBadge);
    }

    const subtitleSpan = document.createElement('span');
    subtitleSpan.className = 'history-item-subtitle';
    if (caseLabel.startsWith('#')) subtitleSpan.classList.add('is-case');
    subtitleSpan.textContent = caseLabel;

    textCol.append(titleSpan);
    if (badgeRow.childElementCount > 0) textCol.append(badgeRow);
    textCol.append(subtitleSpan);

    const metaSpan = document.createElement('span');
    metaSpan.className = 'history-item-meta';
    metaSpan.textContent = timeStr;

    const expandBtn = document.createElement('button');
    expandBtn.className = 'history-item-expand';
    expandBtn.type = 'button';
    // COD-130: the ⋯ button now opens a context (kebab) menu rather than
    // toggling the inline detail panel directly. aria-expanded still tracks
    // the detail panel (toggled via the menu's "Show details" item).
    expandBtn.setAttribute('aria-haspopup', 'menu');
    expandBtn.setAttribute('aria-label', 'Session actions');
    expandBtn.setAttribute('aria-expanded', 'false');
    expandBtn.textContent = '⋯'; // ⋯

    mainRow.append(textCol, metaSpan, expandBtn);

    // Detail panel: full prompt + full path, hidden by default
    const detail = document.createElement('div');
    detail.className = 'history-item-detail';
    detail.hidden = true;

    const promptRow = document.createElement('div');
    promptRow.className = 'history-detail-row';
    const promptLabel = document.createElement('span');
    promptLabel.className = 'history-detail-label';
    promptLabel.textContent = 'Prompt';
    const promptText = document.createElement('span');
    promptText.className = 'history-detail-value history-detail-prompt';
    promptText.textContent = s.firstPrompt || '(no prompt captured)';
    promptRow.append(promptLabel, promptText);

    // COD-145: show the most recent user prompt too, but collapse single-prompt
    // sessions (omit when there's no last prompt or it duplicates the first).
    let lastPromptRow = null;
    if (s.lastPrompt && s.lastPrompt !== s.firstPrompt) {
      lastPromptRow = document.createElement('div');
      lastPromptRow.className = 'history-detail-row';
      const lastPromptLabel = document.createElement('span');
      lastPromptLabel.className = 'history-detail-label';
      lastPromptLabel.textContent = 'Last prompt';
      const lastPromptText = document.createElement('span');
      lastPromptText.className = 'history-detail-value history-detail-prompt';
      lastPromptText.textContent = s.lastPrompt;
      lastPromptRow.append(lastPromptLabel, lastPromptText);
    }

    const pathRow = document.createElement('div');
    pathRow.className = 'history-detail-row';
    const pathLabel = document.createElement('span');
    pathLabel.className = 'history-detail-label';
    pathLabel.textContent = 'Path';
    const pathText = document.createElement('span');
    pathText.className = 'history-detail-value history-detail-path';
    pathText.textContent = shortDir;
    pathRow.append(pathLabel, pathText);

    const metaRow = document.createElement('div');
    metaRow.className = 'history-detail-row history-detail-meta';
    const metaParts = [];
    if (timeStr) metaParts.push(timeStr);
    if (hasSize) metaParts.push(size);
    metaParts.push(s.sessionId.slice(0, 8));
    metaRow.textContent = metaParts.join(' · ');

    detail.append(promptRow);
    if (lastPromptRow) detail.append(lastPromptRow);
    detail.append(pathRow, metaRow);

    if (showViewAll && s.projectKey) {
      const actionRow = document.createElement('div');
      actionRow.className = 'history-detail-row history-detail-actions';
      const viewAllBtn = document.createElement('button');
      viewAllBtn.type = 'button';
      viewAllBtn.className = 'history-view-all-btn';
      viewAllBtn.textContent = 'View all in this folder';
      viewAllBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.openFolderHistoryModal(s.projectKey, s.workingDir, cases);
      });
      actionRow.appendChild(viewAllBtn);
      detail.appendChild(actionRow);
    }

    expandBtn.addEventListener('click', (ev) => {
      // COD-130: stop both the row resume handler and the Session Manager
      // modal's main-row close listener from firing, then open the kebab menu.
      ev.stopPropagation();
      ev.preventDefault();
      this._openSessionRowMenu(ev.currentTarget, s, cases, item, detail);
    });

    item.append(mainRow, detail);
    return item;
  },

  /**
   * COD-130: Open a context (kebab) menu anchored to a history item's ⋯
   * button. Replaces the old inline detail-toggle so the same control works
   * both in the history list and inside the Session Manager modal (where a
   * capture-phase close listener previously swallowed the click).
   *
   * The menu is appended to <body> with fixed positioning so it escapes the
   * modal's overflow/stacking context, and flips above the anchor when it
   * would overflow the viewport bottom.
   *
   * @param {HTMLElement} anchorEl the ⋯ button the menu anchors to
   * @param {object} s session record
   * @param {Array} cases linked cases (unused but kept for parity/future)
   * @param {HTMLElement} item the .history-item element (for detail toggle)
   * @param {HTMLElement} detail the inline detail panel element
   */
  _openSessionRowMenu(anchorEl, s, cases, item, detail) {
    // Close any already-open row menu first — call its own close fn so the
    // previous menu's document/window listeners are detached (a raw .remove()
    // would leave them dangling until the next event self-cleans).
    if (this._openRowMenuClose) {
      try {
        this._openRowMenuClose();
      } catch {
        /* noop */
      }
    }

    const isLiveOpen =
      Array.isArray(s.sources) && s.sources.includes('live') && this.sessions.has(s.sessionId);

    const menu = document.createElement('div');
    menu.className = 'session-row-menu';
    menu.setAttribute('role', 'menu');

    // closeMenu tears down the menu and all transient listeners.
    let onDocMouseDown = null;
    let onKeyDown = null;
    let onScrollResize = null;
    const closeMenu = () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize, true);
      try {
        menu.remove();
      } catch {
        /* noop */
      }
      if (this._openRowMenuEl === menu) {
        this._openRowMenuEl = null;
        this._openRowMenuClose = null;
      }
    };

    // Helper: build one menu item button.
    const addItem = (label, onActivate, opts) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'session-row-menu-item';
      btn.setAttribute('role', 'menuitem');
      const text = document.createElement('span');
      text.className = 'session-row-menu-label';
      text.textContent = label;
      btn.appendChild(text);
      if (opts && opts.sublabel) {
        const sub = document.createElement('span');
        sub.className = 'session-row-menu-sublabel';
        sub.textContent = opts.sublabel;
        btn.appendChild(sub);
      }
      btn.addEventListener('click', async (ev) => {
        // Never let the click bubble to the row resume / modal close handlers.
        ev.stopPropagation();
        ev.preventDefault();
        await onActivate();
      });
      menu.appendChild(btn);
    };

    // Resume / Switch to session (always).
    addItem(
      isLiveOpen ? 'Switch to session' : 'Resume session',
      () => {
        if (isLiveOpen) {
          this.selectSession(s.sessionId);
        } else {
          // Resume by the Claude conversation UUID when present (resumed sessions
          // carry theirs separately from their Codeman id).
          this.resumeHistorySession(s.claudeSessionId || s.sessionId, s.workingDir || '', s.name, s.mode, s.resumeId);
        }
        this.closeSessionManager?.();
        closeMenu();
      }
    );

    // Pin / Unpin (COD-139) — floats the session to the top of the list.
    const isPinned = s.pinned === true;
    addItem(isPinned ? 'Unpin session' : 'Pin to top', async () => {
      const ok = await this._setSessionPinned(s.sessionId, !isPinned);
      if (ok) {
        // Optimistic local flip so a re-render before the SSE event is consistent.
        s.pinned = !isPinned;
        this.showToast(!isPinned ? 'Pinned to top' : 'Unpinned', 'success');
      } else {
        this.showToast('Pin failed', 'error');
      }
      closeMenu();
    });

    // Open folder (only for a live+open session — file browser is session-scoped).
    if (isLiveOpen) {
      addItem('Open folder', () => {
        this.selectSession(s.sessionId);
        this.loadFileBrowser?.(s.sessionId);
        this.closeSessionManager?.();
        closeMenu();
      });
    }

    // Copy path (only when a workingDir is known).
    if (s.workingDir) {
      addItem('Copy path', async () => {
        const ok = await this._copyText(s.workingDir);
        this.showToast(ok ? 'Path copied' : 'Copy failed', ok ? 'success' : 'error');
        closeMenu();
      });
    }

    // Show details (always) — toggles the inline detail panel; keeps modal open.
    addItem('Show details', () => {
      const expanded = item.classList.toggle('expanded');
      detail.hidden = !expanded;
      anchorEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      closeMenu();
    });

    // Position: fixed, anchored under/over the button; flip up on overflow.
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 4;
    let top = rect.bottom + gap;
    if (top + menuRect.height > window.innerHeight && rect.top - gap - menuRect.height >= 0) {
      top = rect.top - gap - menuRect.height; // flip above the anchor
    }
    // Right-align the menu to the button, clamped into the viewport.
    let left = rect.right - menuRect.width;
    if (left < gap) left = gap;
    if (left + menuRect.width > window.innerWidth - gap) {
      left = Math.max(gap, window.innerWidth - gap - menuRect.width);
    }
    menu.style.top = `${Math.max(gap, top)}px`;
    menu.style.left = `${left}px`;

    // Dismissal listeners.
    onDocMouseDown = (ev) => {
      if (menu.contains(ev.target) || anchorEl.contains(ev.target)) return;
      closeMenu();
    };
    onKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        closeMenu();
      }
    };
    onScrollResize = () => closeMenu();
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize, true);

    this._openRowMenuEl = menu;
    this._openRowMenuClose = closeMenu;
  },

  /**
   * COD-139: Toggle a session's pin via POST /api/sessions/:id/pin.
   * Pinned sessions float to the top of the session manager list. Returns true
   * on success. The live re-sort happens when the session:pinned SSE event
   * fires (handled in app.js), so callers don't need to re-render themselves.
   * @param {string} sessionId
   * @param {boolean} pinned explicit desired pin state (idempotent)
   * @returns {Promise<boolean>}
   */
  async _setSessionPinned(sessionId, pinned) {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data?.success === true;
    } catch (err) {
      console.error('[_setSessionPinned]', err);
      return false;
    }
  },

  /** Number of history items shown before "Show More" */
  _HISTORY_INITIAL_COUNT: 10,

  /**
   * How many past sessions the home screen loads (also the filter/sort corpus).
   * 200, not the old 60, so the filter can reach a real backlog, an install with
   * 35+ conversations would otherwise hit the ceiling before the filter is useful
   * (raised in @jordan8037310's #263; the endpoint clamps at 500).
   */
  _HISTORY_FETCH_LIMIT: 200,

  /** localStorage key for the per-device sort choice (#263). */
  _HISTORY_SORT_KEY: 'codeman:historySort',

  async loadHistorySessions() {
    const container = document.getElementById('historySessions');
    const list = document.getElementById('historyList');
    if (!container || !list) return;

    try {
      // Load cases in parallel so subtitle can show "#caseName" labels.
      // Prefer already-loaded this.cases to avoid an extra request.
      const casesPromise = Array.isArray(this.cases) && this.cases.length > 0
        ? Promise.resolve(this.cases)
        : fetch('/api/cases').then((r) => (r.ok ? r.json() : null)).then((d) => d?.data || []).catch(() => []);
      const [allSessions, cases] = await Promise.all([
        this._fetchUnifiedSessions(this._HISTORY_FETCH_LIMIT),
        casesPromise,
      ]);
      if (allSessions.length === 0) {
        container.style.display = 'none';
        return;
      }

      // Keep the corpus around: filtering and sorting (issue #260) work on this
      // array, so a re-render costs no request. Expansion survives the periodic
      // refresh in panels-ui.js, collapsing the list under the user's cursor
      // every few seconds would be worse than the original 4-item cap.
      this._historyAll = allSessions;
      this._historyCases = cases;
      this._wireHistoryControls();
      this._renderHistoryList();

      container.style.display = '';
    } catch (err) {
      console.error('[loadHistorySessions]', err);
      container.style.display = 'none';
    }
  },

  /**
   * Wire the filter box and sort select once; both re-render from the cached
   * corpus. The sort choice is restored from (and saved to) localStorage, it is
   * a per-device display preference, so it stays out of the synced settings
   * schema, same as `codeman:skin`.
   */
  _wireHistoryControls() {
    if (this._historyControlsWired) return;
    const filter = document.getElementById('historyFilter');
    const sort = document.getElementById('historySort');
    if (!filter && !sort) return;
    this._historyControlsWired = true;

    if (sort) {
      try {
        const saved = localStorage.getItem(this._HISTORY_SORT_KEY);
        if (saved && Array.from(sort.options).some((o) => o.value === saved)) sort.value = saved;
      } catch {
        /* private mode, the order just won't persist */
      }
    }

    if (filter) {
      filter.addEventListener('input', () => this._renderHistoryList());
      filter.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && filter.value) {
          // Swallow it: Escape at the welcome screen otherwise closes overlays.
          ev.stopPropagation();
          filter.value = '';
          this._renderHistoryList();
        }
      });
    }
    if (sort) {
      sort.addEventListener('change', () => {
        try {
          localStorage.setItem(this._HISTORY_SORT_KEY, sort.value);
        } catch {
          /* private mode, the order just won't persist */
        }
        this._renderHistoryList();
      });
    }
  },

  /** True when a past-session row matches the filter text (name, folder, case, prompt). */
  _historyRowMatches(s, needle, cases) {
    const fields = [
      s.name,
      s.workingDir,
      this._resolveCaseLabel(s.workingDir, cases),
      s.firstPrompt,
      s.lastPrompt,
      s.sessionId,
    ];
    return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(needle));
  },

  /**
   * The text a history row shows as its title. Most transcript-backed rows have
   * no session name at all, so this falls through to the first prompt and then
   * to the path, and the A–Z sort keys off the SAME string, or "sort by name"
   * would silently do nothing for exactly the rows the list is mostly made of.
   */
  _historyRowLabel(s, fallback) {
    return s.name || s.firstPrompt || fallback || '';
  },

  /**
   * Sort past-session rows. 'recent' keeps the backend order (newest first);
   * the alphabetical modes sort by the visible title or by folder basename.
   * Pinned rows stay on top in every mode, pinning is an explicit override and
   * a sort that buried it would read as the pin having been lost.
   */
  _sortHistoryRows(rows, mode) {
    const label = (s) => this._historyRowLabel(s, this._shortenHomePath(s.workingDir)).toLowerCase();
    const folder = (s) => ((s.workingDir || '').split('/').pop() || '').toLowerCase();
    const key = mode === 'name' ? label : folder;
    // numeric collation so w2-… sorts before w10-…, and base sensitivity so case
    // does not split a project's rows apart (from @jordan8037310's #263).
    const sorted =
      mode === 'recent'
        ? rows.slice()
        : rows
            .slice()
            .sort((a, b) => key(a).localeCompare(key(b), undefined, { sensitivity: 'base', numeric: true }));
    const pinned = sorted.filter((s) => s.pinned);
    return pinned.length === 0 ? sorted : pinned.concat(sorted.filter((s) => !s.pinned));
  },

  /**
   * Render the "Resume Conversation" list from the cached corpus, applying the
   * current filter and sort. Collapsed by default to _HISTORY_INITIAL_COUNT;
   * "Show more" expands the list AND the box (the CSS cap is class-driven, since
   * a fixed 240px box made expansion pointless, issue #260).
   */
  _renderHistoryList() {
    const list = document.getElementById('historyList');
    if (!list) return;
    const all = this._historyAll || [];
    const cases = this._historyCases || [];
    const countEl = document.getElementById('historyCount');
    const needle = (document.getElementById('historyFilter')?.value || '').trim().toLowerCase();
    const mode = document.getElementById('historySort')?.value || 'recent';

    const matched = needle ? all.filter((s) => this._historyRowMatches(s, needle, cases)) : all;
    const rows = this._sortHistoryRows(matched, mode);
    // Filtering is itself an expansion request: hiding matches behind "Show more"
    // would defeat the point of typing a filter.
    const expanded = !!this._historyExpanded || needle.length > 0;
    const visible = expanded ? rows : rows.slice(0, this._HISTORY_INITIAL_COUNT);

    list.replaceChildren();
    list.classList.toggle('expanded', expanded);

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = `No conversations match "${needle}"`;
      list.appendChild(empty);
    }

    for (const s of visible) list.appendChild(this._buildHistoryItem(s, cases));

    const hidden = rows.length - visible.length;
    if (hidden > 0) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'history-show-more';
      moreBtn.textContent = `Show ${hidden} more`;
      moreBtn.addEventListener('click', () => {
        this._historyExpanded = true;
        this._renderHistoryList();
      });
      list.appendChild(moreBtn);
    } else if (expanded && !needle && rows.length > this._HISTORY_INITIAL_COUNT) {
      const lessBtn = document.createElement('button');
      lessBtn.className = 'history-show-more';
      lessBtn.textContent = 'Show less';
      lessBtn.addEventListener('click', () => {
        this._historyExpanded = false;
        this._renderHistoryList();
        list.scrollTop = 0;
      });
      list.appendChild(lessBtn);
    }

    if (countEl) {
      countEl.textContent = needle
        ? `${rows.length} of ${all.length}`
        : rows.length > visible.length
          ? `${visible.length} of ${rows.length}`
          : String(rows.length);
    }
  },

  /** Page size for the folder history modal */
  _FOLDER_HISTORY_PAGE_SIZE: 20,

  /**
   * Open a modal showing all history sessions in a single folder.
   * Paginated by FOLDER_HISTORY_PAGE_SIZE; "Show more" loads next page.
   */
  openFolderHistoryModal(projectKey, workingDir, cases) {
    // Close any existing instance first
    this._closeFolderHistoryModal();

    const modal = document.createElement('div');
    modal.className = 'modal active folder-history-modal';
    modal.id = 'folderHistoryModal';

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => this._closeFolderHistoryModal());

    const content = document.createElement('div');
    content.className = 'modal-content modal-lg';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('h3');
    title.textContent = 'Folder History';
    const subtitle = document.createElement('div');
    subtitle.className = 'folder-history-subtitle';
    subtitle.textContent = this._shortenHomePath(workingDir);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this._closeFolderHistoryModal());
    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    const list = document.createElement('div');
    list.className = 'folder-history-list';
    list.setAttribute('data-loading', 'true');
    list.textContent = 'Loading...';
    body.append(subtitle, list);

    content.append(header, body);
    modal.append(backdrop, content);
    document.body.appendChild(modal);

    // Track state for pagination
    this._folderHistoryState = {
      projectKey,
      workingDir,
      cases: cases || [],
      offset: 0,
      total: null,
      list,
    };

    // ESC to close
    this._folderHistoryEscHandler = (ev) => {
      if (ev.key === 'Escape') this._closeFolderHistoryModal();
    };
    document.addEventListener('keydown', this._folderHistoryEscHandler);

    this._loadFolderHistoryPage();
  },

  async _loadFolderHistoryPage() {
    const state = this._folderHistoryState;
    if (!state) return;
    const { projectKey, cases, list } = state;
    const limit = this._FOLDER_HISTORY_PAGE_SIZE;
    const offset = state.offset;

    // Remove existing "Show more" button while loading
    const existingMore = list.querySelector('.folder-history-more');
    if (existingMore) existingMore.remove();

    // First page: clear loading placeholder
    if (offset === 0) {
      list.replaceChildren();
      list.removeAttribute('data-loading');
    }

    try {
      const url = `/api/history/sessions?projectKey=${encodeURIComponent(projectKey)}&offset=${offset}&limit=${limit}`;
      const res = await fetch(url);
      const data = await res.json();
      const sessions = data.data?.sessions || [];
      state.total = typeof data.data?.total === 'number' ? data.data.total : sessions.length + offset;

      if (offset === 0 && sessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'folder-history-empty';
        empty.textContent = 'No conversations found in this folder.';
        list.appendChild(empty);
        return;
      }

      for (const s of sessions) {
        list.appendChild(this._buildHistoryItem(s, cases, { showViewAll: false }));
      }

      state.offset = offset + sessions.length;

      // Add "Show more" if there are more sessions
      if (state.offset < state.total) {
        const remaining = state.total - state.offset;
        const moreBtn = document.createElement('button');
        moreBtn.className = 'history-show-more folder-history-more';
        moreBtn.textContent = `Show ${Math.min(limit, remaining)} more (${remaining} remaining)`;
        moreBtn.addEventListener('click', () => this._loadFolderHistoryPage());
        list.appendChild(moreBtn);
      }
    } catch (err) {
      console.error('[loadFolderHistoryPage]', err);
      const errorEl = document.createElement('div');
      errorEl.className = 'folder-history-empty';
      errorEl.textContent = 'Failed to load folder history.';
      list.appendChild(errorEl);
    }
  },

  _closeFolderHistoryModal() {
    const modal = document.getElementById('folderHistoryModal');
    if (modal) modal.remove();
    if (this._folderHistoryEscHandler) {
      document.removeEventListener('keydown', this._folderHistoryEscHandler);
      this._folderHistoryEscHandler = null;
    }
    this._folderHistoryState = null;
  },

  // Choose the name for a resumed session: keep the session's own name when it
  // has one, otherwise synthesize a fresh w<N>-<dir> name (next free w-number
  // across open sessions). COD-143 — resume used to always generate a new name.
  _resolveResumeName(existingName, workingDir) {
    if (typeof existingName === 'string' && existingName.trim()) return existingName;
    const dirName = (workingDir || '').split('/').pop() || 'session';
    let startNumber = 1;
    for (const [, session] of this.sessions) {
      const match = session.name && session.name.match(/^w(\d+)-/);
      if (match) {
        const num = parseInt(match[1]);
        if (num >= startNumber) startNumber = num + 1;
      }
    }
    return `w${startNumber}-${dirName}`;
  },

  async resumeHistorySession(sessionId, workingDir, existingName, mode, resumeId) {
    // Close the run mode menu if open
    document.getElementById('runModeMenu')?.classList.remove('active');
    // Close folder history modal if open
    this._closeFolderHistoryModal();
    try {
      this.terminal.clear();
      this.terminal.writeln(`\x1b[1;32m Resuming conversation ${sessionId.slice(0, 8)}...\x1b[0m`);

      // Keep the session's own name when resuming; only synthesize a w<N>-<dir>
      // name when the source row had none (COD-143).
      const name = this._resolveResumeName(existingName, workingDir);

      // Create session with resumeSessionId — include envOverrides so resumed
      // conversations inherit current UI settings (effort, agent teams, etc.).
      // Match by path (not basename) so linked/renamed cases still resolve correctly.
      const matchingCase = (this.cases || []).find((c) => c.path === workingDir);
      const caseName = matchingCase?.name || workingDir.split('/').pop() || '';
      const globalSettings = this.loadAppSettingsFromStorage();
      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), globalSettings);
      const effort = this.getEffortSetting(globalSettings);
      // `resumeSessionId` is a Claude conversation UUID (server reads it from
      // ~/.claude/projects); an external-CLI row has no such thing, so sending
      // it there gets silently ignored while the OMITTED `mode` field defaults
      // the create to plain claude — reproducing whatever conversation THAT
      // uuid happens to collide with instead of the row's own backend. Row mode
      // wins here. Codeman has no cross-restart PTY-reattach outside server
      // boot, so "resume" for a non-claude row means relaunching the CLI's own
      // continue-most-recent flag (opencode/pi/grok/omp --continue, deepseek
      // resumeSession) in the same directory — real conversation continuity,
      // just not the literal old process.
      const effectiveMode = mode || 'claude';
      const modeConfigKey = {
        opencode: 'openCodeConfig',
        pi: 'piConfig',
        grok: 'grokConfig',
        omp: 'ompConfig',
      }[effectiveMode];
      // codex names a thread by an id of its own, not by Codeman's session id,
      // so it continues only when the row carried that id: `resumeId` is set by
      // the rollout scanner (codex-transcript.ts) and by nothing else, which is
      // what stops a LIVE codex row — whose sessionId is Codeman's uuid — from
      // asking codex for a thread that does not exist.
      //
      // gemini/antigravity still have no wired continuation here (same reason
      // codex used to have none: an exact conversation id nothing supplies) —
      // `continuesSomething` below is what keeps their row from being retired
      // for a resume that didn't actually continue anything.
      const codexResumeId = effectiveMode === 'codex' ? resumeId : undefined;
      const modeConfig =
        modeConfigKey
          ? { [modeConfigKey]: { continueSession: true } }
          : effectiveMode === 'deepseek'
            ? { deepSeekConfig: { resumeSession: true } }
            : codexResumeId
              ? { codexConfig: { resumeSessionId: codexResumeId } }
              : {};
      const continuesSomething =
        Boolean(modeConfigKey) || effectiveMode === 'deepseek' || Boolean(codexResumeId);
      const createRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workingDir,
          name,
          mode: effectiveMode,
          ...(effectiveMode === 'claude' ? { resumeSessionId: sessionId } : {}),
          ...modeConfig,
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          ...(effort ? { effort } : {}),
        }),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error);

      const newSessionId = createData.data.session.id;

      // Start interactive
      await fetch(`/api/sessions/${newSessionId}/interactive`, { method: 'POST' });

      // Retire the row being resumed: a non-claude "resume" is really a brand
      // new Codeman session pointed at the same directory (there is no id to
      // reattach to), so without this every resume leaves the old row behind
      // as a duplicate — click it 3 times, see the same name 3 times. Claude
      // rows are left alone: `sessionId` there is a claudeSessionId, which
      // usually has no live/persisted Codeman session of its own to delete.
      // Gated on `continuesSomething`: for gemini/antigravity, and for a codex
      // row carrying no `resumeId`, this is really a FRESH session with no
      // relation to the old row's conversation, so retiring it would discard
      // the old conversation with no recovery — worse than the duplicate row
      // this guard exists to prevent for the modes that DO continue.
      //
      // A codex row that DOES continue passes this gate, but the DELETE is a
      // no-op for it: `sessionId` there is codex's thread id and no Codeman
      // session carries that id. Its duplicate is cleared from the other side
      // instead, by the alias fold in gatherUnifiedInputs()/Session.
      if (effectiveMode !== 'claude' && continuesSomething && sessionId !== newSessionId) {
        fetch(`/api/sessions/${sessionId}?killMux=true`, { method: 'DELETE' }).catch(() => {});
      }

      this.terminal.writeln(`\x1b[90m Session ${name} ready\x1b[0m`);
      await this.selectSession(newSessionId);
      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Terminal Rendering
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if terminal viewport is at or near the bottom.
   * Used to implement "sticky scroll" behavior - keep user at bottom if they were there.
   */
  isTerminalAtBottom() {
    if (!this.terminal) return true;
    const buffer = this.terminal.buffer.active;
    // viewportY is the top line of the viewport, baseY is where scrollback starts
    // If viewportY >= baseY, we're showing the latest content (at bottom)
    // Allow 2 lines tolerance for edge cases
    return buffer.viewportY >= buffer.baseY - 2;
  },

  // Record manual scroll gestures so sticky-scroll can give an upward scroll a
  // short grace window (see _hasRecentUserScrollUp). A downward scroll that
  // lands back at the bottom clears the suppression immediately.
  _noteTerminalUserScroll(lines) {
    if (lines < 0) {
      this._lastUserScrollUpAt = performance.now();
    } else if (this.isTerminalAtBottom()) {
      this._lastUserScrollUpAt = null;
    }
  },

  /**
   * Post-scroll companion to _noteTerminalUserScroll: hitting the TOP of the
   * buffer while scrolling up gives the app a chance to pull the rest of tmux's
   * scrollback (issue #205, see _maybeRefetchFullHistory). Shell sessions decline
   * automatic pulls because their captures can be large; their banner button is
   * the explicit path. Must be called AFTER scrollLines(), since the check is on
   * the resulting position, and it is deliberately not folded into
   * _noteTerminalUserScroll for exactly that reason.
   */
  _maybeLoadMoreHistoryOnScroll(lines) {
    if (lines >= 0) return;
    if (this.terminal?.buffer?.active?.viewportY === 0) this._maybeRefetchFullHistory?.();
  },

  /**
   * Rows a `?full=1` capture will occupy once written into xterm.
   *
   * tmux joins wrapped rows in that capture (`capture-pane -J`), so a long
   * logical line re-wraps into several xterm rows on write and a bare newline
   * count would undershoot; escape sequences occupy no cells and come out
   * first. Approximate by construction (it ignores double-width glyphs), which
   * is fine: the only consumer is a coarse size comparison
   * (_replayWouldShrinkBuffer), and it runs once per cooldown-guarded re-pull.
   */
  _estimateReplayRows(text, cols) {
    if (typeof text !== 'string' || !text) return 0;
    const width = cols > 0 ? cols : 80;
    const plain = text.replace(window.CodemanTerminalInput.REPLAY_ESCAPE_RE, '');
    let rows = 0;
    for (const line of plain.split('\n')) {
      const cells = line.endsWith('\r') ? line.length - 1 : line.length;
      rows += cells > width ? Math.ceil(cells / width) : 1;
    }
    return rows;
  },

  /**
   * DOWNGRADE GUARD for the scroll-to-top re-pull (issue #205, round 2).
   *
   * `_maybeRefetchFullHistory` resets the terminal and rewrites it from the
   * capture, which is a straight win when tmux holds more than the browser —
   * the burst-repaint and tab-switch losses it was built for. But a repaint-mode
   * CLI pane keeps NO tmux history of its own (`history_size≈0` measured for a
   * Claude pane), so there the capture is roughly ONE frame while xterm may hold
   * hundreds of rows of replayed frames. Rewriting then DESTROYS history
   * mid-scroll: exactly the "goes back a limited amount, repeats blocks, gets
   * worse when I reach the top" report from the 1.12.0 retest.
   *
   * So refuse when the capture is smaller, with a one-screen tolerance because
   * both sides are estimates: `buffer.active.length` includes the blank rows
   * below the last line, and _estimateReplayRows can only approximate wrapping.
   * Only a capture that is worse by more than a full screen counts as a
   * downgrade, which leaves every genuine recovery case untouched.
   */
  _replayWouldShrinkBuffer(capture) {
    const term = this.terminal;
    const rowsNow = term?.buffer?.active?.length || 0;
    if (!rowsNow) return false;
    const screen = term?.rows || 24;
    return this._estimateReplayRows(capture, term?.cols) + screen < rowsNow;
  },

  /**
   * Ease-out smooth scrolling for the local wheel path. The capture-phase
   * wheel handler owns local scrolling (xterm's own smooth scroller is
   * bypassed, see the listener comment), so without this every notch was an
   * instant multi-line jump. Wheel deltas accumulate into a pending line
   * count (fractional — see _wheelScrollLinesFloat) and drain ~22% per
   * animation frame with a one-line floor, so a single notch starts with a
   * gentle step and glides to an exact landing; more notches mid-glide deepen
   * the pending count, which reads as natural acceleration. A sub-line
   * residual stays pending until further input pushes it past a whole line
   * (that is what makes slow trackpad drags track the finger). Direction
   * reversals cancel arithmetically. The pending amount is dropped when the
   * active session changes mid-glide — leftover momentum must never scroll
   * the tab the user just switched to.
   */
  _smoothScrollBy(lines) {
    if (!lines) return;
    this._smoothScrollPending = (this._smoothScrollPending || 0) + lines;
    this._smoothScrollSession = this.activeSessionId;
    if (this._smoothScrollFrame) return;
    const step = () => {
      this._smoothScrollFrame = null;
      const pending = this._smoothScrollPending || 0;
      if (!pending) return;
      if (this.activeSessionId !== this._smoothScrollSession) {
        this._smoothScrollPending = 0;
        return;
      }
      if (Math.abs(pending) < 1) return; // sub-line residual: wait for more input
      const eased = pending * 0.22;
      const move = pending > 0 ? Math.max(1, Math.floor(eased)) : Math.min(-1, Math.ceil(eased));
      this._smoothScrollPending = pending - move;
      this.terminal.scrollLines(move);
      this._maybeLoadMoreHistoryOnScroll(move);
      if (Math.abs(this._smoothScrollPending) >= 1) this._smoothScrollFrame = requestAnimationFrame(step);
    };
    this._smoothScrollFrame = requestAnimationFrame(step);
  },

  /**
   * Hand a scroll gesture (wheel tick or touch drag, already converted to
   * lines) to the CLI as synthetic SGR wheel reports. SGR coordinates address
   * the LIVE screen (the bottom `rows` of the buffer), so a report computed
   * from a scrolled-up viewport would hit-test a different row entirely, and
   * forwarding while the user stares at stale scrollback looks like the
   * gesture is dead. Snap back first: the gesture then always acts on what the
   * CLI is drawing now.
   */
  _forwardScrollToApp(clientX, clientY, lines) {
    if (!this._terminalViewportAtBottom()) this.terminal.scrollToBottom();
    this._sendSyntheticSgrWheel(clientX, clientY, lines);
  },

  _hasRecentUserScrollUp() {
    if (typeof this._lastUserScrollUpAt !== 'number') return false;
    return performance.now() - this._lastUserScrollUpAt < window.CodemanTerminalInput.USER_SCROLL_STICKY_SUPPRESS_MS;
  },

  batchTerminalWrite(data) {
    // If a buffer load (chunkedTerminalWrite) is in progress, queue live events
    // to prevent interleaving historical buffer data with live SSE data.
    // This is critical: interleaving causes cursor position chaos with Ink redraws.
    if (this._isLoadingBuffer) {
      if (this._loadBufferQueue) this._loadBufferQueue.push(data);
      return;
    }

    // Check if at bottom BEFORE adding data (captures user's scroll position)
    // Only update if not already scheduled (preserve the first check's result)
    if (!this.writeFrameScheduled) {
      this._wasAtBottomBeforeWrite = this.isTerminalAtBottom();
    }

    // Check if flicker filter is enabled for current session
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
    const flickerFilterEnabled = session?.flickerFilterEnabled ?? false;

    // xterm.js 6.0 handles DEC 2026 synchronized output natively — Ink's cursor-up
    // redraws are wrapped in 2026h/2026l markers and rendered atomically by xterm.js.
    // No client-side cursor-up detection/buffering needed. The old 50ms flicker filter
    // was actively harmful: it accumulated multiple resize redraws and flushed them
    // together, causing stacked ghost renders due to reflow line-count mismatches.

    // Opt-in flicker filter: buffer screen clear patterns (for sessions that enable it)
    if (flickerFilterEnabled) {
      const hasScreenClear =
        data.includes('\x1b[2J') ||
        data.includes('\x1b[H\x1b[J') ||
        (data.includes('\x1b[H') && data.includes('\x1b[?25l'));

      if (hasScreenClear) {
        this.flickerFilterActive = true;
        this.flickerFilterBuffer += data;

        if (this.flickerFilterTimeout) {
          clearTimeout(this.flickerFilterTimeout);
        }
        this.flickerFilterTimeout = setTimeout(() => {
          this.flickerFilterTimeout = null;
          this.flushFlickerBuffer();
        }, SYNC_WAIT_TIMEOUT_MS); // 50ms buffer window

        return;
      }

      if (this.flickerFilterActive) {
        this.flickerFilterBuffer += data;
        return;
      }
    }

    // Accumulate raw data (may contain DEC 2026 markers)
    this.pendingWrites.push(data);
    this._scheduleTerminalWriteFlush();
  },

  /**
   * Schedule one render-budgeted terminal flush.
   *
   * Clear the scheduled flag before flushing so flushPendingWrites() can queue
   * another yield when a large final batch leaves bytes behind. Keeping the
   * flag set through the flush stranded that remainder until unrelated output
   * arrived, which looked like truncated responses and idle shell commands.
   */
  _scheduleTerminalWriteFlush() {
    if (this._terminalWriteInFlight || this.writeFrameScheduled || this.pendingWrites.length === 0) return;
    this.writeFrameScheduled = true;
    this._safeYield(() => {
      this.writeFrameScheduled = false;
      // xterm.js 6.0 handles DEC 2026 sync markers natively — it buffers
      // content between 2026h/2026l and renders atomically.
      this.flushPendingWrites();
    });
  },

  /**
   * Flush the flicker filter buffer to the terminal.
   * Called after the buffer window expires.
   */
  flushFlickerBuffer() {
    if (!this.flickerFilterBuffer) return;

    // Transfer buffered data to normal pending writes
    this.pendingWrites.push(this.flickerFilterBuffer);
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;

    // Trigger a normal flush
    this._scheduleTerminalWriteFlush();
  },

  /**
   * Flush the local-echo overlay's unsent text into `_pendingInput` (no
   * trailing Enter) and reset overlay + flushed-state tracking. Used before
   * forwarding sequences that must arrive AFTER the typed text (bracketed
   * paste, composer nav keys). The caller forwards its own sequence: nav keys
   * ride the same write, pastes get a delayed second write because codex
   * drops keys that share a PTY read with a bracketed paste.
   */
  _flushLocalEchoPending() {
    const text = this._localEchoOverlay?.pendingText || '';
    this._localEchoOverlay?.clear();
    this._localEchoOverlay?.suppressBufferDetection();
    this._flushedOffsets?.delete(this.activeSessionId);
    this._flushedTexts?.delete(this.activeSessionId);
    if (text) this._pendingInput += text;
  },

  /**
   * Update local echo overlay state based on settings.
   * Enabled whenever the setting is on — works during idle AND busy.
   * Position is tracked dynamically by _findPrompt() on every render.
   */
  _updateLocalEchoState() {
    const settings = this.loadAppSettingsFromStorage();
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
    const echoEnabled = settings.localEchoEnabled ?? MobileDetection.isTouchDevice();
    const shouldEnable = !!(echoEnabled && session);
    if (this._localEchoEnabled && !shouldEnable) {
      this._localEchoOverlay?.clear();
    }
    this._localEchoEnabled = shouldEnable;

    // Swap prompt finder based on session mode
    if (this._localEchoOverlay && session) {
      if (session.mode === 'opencode') {
        // OpenCode (Bubble Tea TUI): find the ┃ border on the cursor's row.
        // The input area is "┃  <text>" — the ┃ is the anchor, offset 3 skips "┃  ".
        // We use the cursor row (cursorY) to find the right line, then scan for ┃.
        this._localEchoOverlay.setPrompt({
          type: 'custom',
          offset: 3,
          find: (terminal) => {
            try {
              const buf = terminal.buffer.active;
              const row = buf.cursorY;
              const line = buf.getLine(buf.viewportY + row);
              if (!line) return null;
              const text = line.translateToString(true);
              const idx = text.indexOf('\u2503'); // ┃ (BOX DRAWINGS HEAVY VERTICAL)
              if (idx >= 0) return { row, col: idx };
              return null;
            } catch {
              return null;
            }
          },
        });
      } else if (session.mode === 'shell' || session.mode === 'codex') {
        // Shell mode: the shell provides its own PTY echo so the overlay isn't needed.
        // Codex mode: the composer is fully interactive per keystroke. Typing
        // "/" pops a live-filtering command picker (issue #222), the composer
        // grows and rewraps as it fills (#220), pastes are bracketed (#219)
        // and arrows/history edit server-side state (#218). Buffering
        // keystrokes until Enter starves all of that, so codex sessions use
        // plain PTY echo like shell — visually augmented by the predictive
        // write-through echo (see _localEchoPolicy below and the onData hook).
        // Disable the buffer overlay by clearing any pending text.
        this._localEchoOverlay.clear();
        this._localEchoEnabled = false;
      } else {
        // Codex/Claude-style TUIs usually expose a ❯ prompt. During active
        // redraws or compact mobile layouts that marker may not be present in
        // the viewport, while xterm's cursor still marks the editable input
        // position. Fall back to cursor coordinates so phone typing appears at
        // the terminal cursor instead of disappearing into pending state.
        this._localEchoOverlay.setPrompt({
          type: 'custom',
          offset: 0,
          find: (terminal) => {
            try {
              const buf = terminal.buffer.active;
              for (let row = terminal.rows - 1; row >= 0; row--) {
                const line = buf.getLine(buf.viewportY + row);
                if (!line) continue;
                const text = line.translateToString(true);
                const idx = text.lastIndexOf('\u276f');
                if (idx >= 0) return { row, col: idx + 2 };
              }
              return {
                row: Math.max(0, Math.min(terminal.rows - 1, buf.cursorY)),
                col: Math.max(0, Math.min(terminal.cols - 1, buf.cursorX)),
              };
            } catch {
              return null;
            }
          },
        });
      }
    }

    // Per-session echo policy: 'buffer' (overlay), 'predict' (codex
    // write-through, see the onData predict hook), 'off'. _localEchoEnabled
    // keeps its exact historical values above (false for codex/shell), so
    // every existing consumer is unchanged; this field is purely additive.
    let policy = 'off';
    if (session && echoEnabled) {
      if (session.mode === 'codex') policy = 'predict';
      else if (session.mode !== 'shell') policy = 'buffer';
    }
    this._localEchoPolicy = policy;
    if (policy !== 'predict') this._predictiveEcho?.clearPredictions();
  },

  /**
   * Predictive-echo onData hook (codex write-through). VISUAL ONLY: paints,
   * pops or clears prediction spans and never touches _pendingInput, never
   * sends, never throws into the caller. The onData wire path behaves
   * byte-identically with this active, absent or broken.
   */
  _predictHookOnData(data) {
    if (this._localEchoPolicy !== 'predict' || !this._predictiveEcho) return;
    try {
      const kind = window.CodemanTerminalInput.classifyPredictInput(data);
      if (kind === 'char') this._predictiveEcho.predictChar(data);
      else if (kind === 'backspace') this._predictiveEcho.predictBackspace();
      // 'clear' AND 'text' (plain paste, IME word commits) both change the
      // composer in ways the display has not shown yet: clear the run and let
      // the addon's anchor hold suppress prediction until the echo catches up
      else this._predictiveEcho.clearPredictions();
    } catch {
      /* predictions must never block the wire */
    }
  },

  // CJK textarea already provides visual feedback — bypass local echo
  // buffering so each composed word reaches the PTY immediately.
  _handleCjkInput(text) {
    if (!this.activeSessionId) {
      _crashDiag.log(`CJK send DROP no-session len=${text.length}`);
      return;
    }
    // ── One-shot Ctrl (mobile shell bar, issue #262) ──
    // While the CJK field is visible it OWNS the keyboard: onData returns early
    // for everything it swallows, and the focus router even redirects
    // terminal.focus() into it — which is where the accessory bar sends focus
    // after every key. So the onData hook never sees these keystrokes, and an
    // armed modifier could neither fire NOR be spent: it survived until a
    // session switch and then turned an innocent keystroke into a control byte.
    // This is the module's single choke point to the PTY, so applying it here
    // covers typed characters, IME flushes, Enter, backspace and arrows at once.
    // Same policy as the onData hook: the next single character is modified,
    // anything longer merely spends the modifier.
    if (typeof KeyboardAccessoryBar !== 'undefined' && KeyboardAccessoryBar.isCtrlArmed?.()) {
      text = KeyboardAccessoryBar.consumeCtrl(text);
    }
    // Bypasses onData (like insertTerminalText): predictions cannot see this
    if (this._localEchoPolicy === 'predict') this._predictiveEcho?.clearPredictions();
    _crashDiag.log(`CJK send→${this.activeSessionId.slice(0, 8)} len=${text.length}`);
    this._sendInputAsync(this.activeSessionId, text);
  },

  /**
   * Flush pending writes to terminal, processing DEC 2026 sync markers.
   * Strips markers and writes content atomically within a single frame.
   */
  flushPendingWrites() {
    if (this._terminalWriteInFlight || this.pendingWrites.length === 0 || !this.terminal) return;

    const _t0 = performance.now();
    // xterm.js 6.0+ natively handles DEC 2026 synchronized output markers.
    // Pass raw data through — xterm.js buffers content between markers and
    // renders atomically, eliminating split-frame Ink redraws.
    const joined = this.pendingWrites.join('');
    this.pendingWrites = [];
    const _joinedLen = joined.length;
    if (_joinedLen > 16384) _crashDiag.log(`FLUSH: ${(_joinedLen / 1024).toFixed(0)}KB`);

    // Per-frame byte budget to prevent main thread blocking.
    // Large writes (141KB+) can freeze Chrome for 2+ minutes.
    // Codex's TUI emits dense synchronized redraws during thinking/high-effort
    // phases, so it gets a smaller first frame to keep per-frame xterm/WebGL
    // stalls short; other modes keep the larger 64KB budget.
    const activeSession = this.activeSessionId && this.sessions ? this.sessions.get(this.activeSessionId) : null;
    const MAX_FRAME_BYTES = activeSession?.mode === 'codex' ? 32768 : 65536;
    let deferred = false;
    // If the user is reading history, remember the viewport so we can restore it
    // after the write — Codex status redraws would otherwise jump it.
    //
    // Position, not recency (#259). This was gated on _hasRecentUserScrollUp(),
    // a 1500ms decay window, so a user who scrolled up and then actually READ
    // for longer than that lost the protection mid-read and got dragged along by
    // the next repaint. Being scrolled up IS the intent, however long ago it was
    // expressed; the recency window remains as an extra guard on the sticky
    // scroll-to-bottom below, where it protects against a mid-flush race.
    const preserveViewportY =
      this.terminal.buffer?.active && !this.isTerminalAtBottom() ? this.terminal.buffer.active.viewportY : null;

    const writeChunk = joined.slice(0, MAX_FRAME_BYTES);
    if (_joinedLen > MAX_FRAME_BYTES) {
      // Keep the remainder app-side where the 128KB cap can see it. The next
      // chunk is scheduled only after xterm confirms this one was parsed.
      this.pendingWrites.push(joined.slice(MAX_FRAME_BYTES));
      deferred = true;
    }
    this._terminalWriteInFlight = true;
    this._terminalWriteInFlightBytes = writeChunk.length;
    try {
      this.terminal.write(writeChunk, () => {
        this._terminalWriteInFlight = false;
        this._terminalWriteInFlightBytes = 0;
        this._scheduleTerminalWriteFlush();
      });
    } catch (err) {
      this._terminalWriteInFlight = false;
      this._terminalWriteInFlightBytes = 0;
      throw err;
    }
    if (
      preserveViewportY !== null &&
      this.terminal.buffer?.active?.viewportY !== preserveViewportY &&
      typeof this.terminal.scrollToLine === 'function'
    ) {
      this.terminal.scrollToLine(preserveViewportY);
    }
    const bytesThisFrame = deferred ? MAX_FRAME_BYTES : _joinedLen;
    const _dt = performance.now() - _t0;
    if (_dt > 100 || deferred)
      console.warn(
        `[CRASH-DIAG] flushPendingWrites: ${_dt.toFixed(0)}ms, ${(bytesThisFrame / 1024).toFixed(0)}KB written${deferred ? ', rest deferred' : ''} (total ${(_joinedLen / 1024).toFixed(0)}KB)`
      );

    // Sticky scroll: if user was at bottom, keep them there after new output.
    // Give manual scroll-up gestures a short grace window so high-frequency
    // Codex status ticks do not snap the viewport back while the user is
    // trying to inspect earlier output.
    if (this._wasAtBottomBeforeWrite && !this._hasRecentUserScrollUp()) {
      this.terminal.scrollToBottom();
    }

    // Re-position local echo overlay after terminal writes — Ink redraws can
    // move the ❯ prompt to a different row, making the overlay invisible.
    if (this._localEchoOverlay?.hasPending) {
      this._localEchoOverlay.rerender();
    }

    // After Tab completion: detect the completed text in the overlay.
    // Use terminal.write('', callback) to defer detection until xterm.js
    // finishes processing ALL queued writes — direct buffer reads after
    // terminal.write(data) can miss text if xterm processes asynchronously.
    if (
      this._tabCompletionSessionId &&
      this._tabCompletionSessionId === this.activeSessionId &&
      this._localEchoOverlay &&
      !this._localEchoOverlay.pendingText
    ) {
      const overlay = this._localEchoOverlay;
      const self = this;
      this.terminal.write('', () => {
        if (!self._tabCompletionSessionId) return; // already resolved
        overlay.resetBufferDetection();
        const detected = overlay.detectBufferText();
        if (detected) {
          if (detected === self._tabCompletionBaseText) {
            // Same text as before Tab — no completion yet. Undo and retry.
            overlay.undoDetection();
            self._tabCompletionRetries = (self._tabCompletionRetries || 0) + 1;
            if (self._tabCompletionRetries > 60) {
              self._tabCompletionSessionId = null;
              self._tabCompletionRetries = 0;
            }
          } else {
            // Text changed — real completion happened
            self._tabCompletionSessionId = null;
            self._tabCompletionRetries = 0;
            self._tabCompletionBaseText = null;
            if (self._tabCompletionFallback) {
              clearTimeout(self._tabCompletionFallback);
              self._tabCompletionFallback = null;
            }
            overlay.rerender();
          }
        } else {
          // No text found yet — retry on next flush.
          self._tabCompletionRetries = (self._tabCompletionRetries || 0) + 1;
          if (self._tabCompletionRetries > 60) {
            self._tabCompletionSessionId = null;
            self._tabCompletionRetries = 0;
          }
        }
      });
    }
  },

  /**
   * Schedule cb via THREE racing primitives so data-pacing makes progress
   * regardless of which scheduling primitive Chrome is throttling:
   *   1. requestAnimationFrame — primary, fires at compositor rate
   *      (may be 0Hz when window is occluded / on backgrounded monitor).
   *   2. setTimeout(50) — fallback for occluded-but-visible windows
   *      (clamped to 1Hz by Chrome's intensive wake-up throttling
   *      after ~5 min of no user interaction).
   *   3. Worker postMessage — bypasses intensive throttling entirely;
   *      Workers are not subject to background-tab / idle-tab throttling
   *      (the React Scheduler trick).
   * Whichever fires first wins; the others are no-ops thanks to the
   * `done` guard. Without all three, chunkedTerminalWrite and the deferred
   * path of flushPendingWrites stall indefinitely when the substrate is
   * degraded (visible-but-occluded window, OR idle-throttled tab, OR
   * background tab on a different monitor).
   */
  _safeYield(cb) {
    let done = false;
    const wrapped = () => {
      if (done) return;
      done = true;
      cb();
    };
    requestAnimationFrame(wrapped);
    setTimeout(wrapped, 50);
    this._workerYield(wrapped);
  },

  /**
   * Lazy-init a tiny "tick" worker whose only job is to postMessage back to
   * us as fast as possible, escaping main-thread throttling. The worker's
   * setTimeout(0) is not subject to Chrome's intensive wake-up throttling
   * even when the parent tab is idle.
   */
  _workerYield(cb) {
    try {
      if (this._yieldWorker === undefined) {
        // First call: build the worker (or mark unavailable). Each
        // postMessage in produces exactly one postMessage out — we count on
        // FIFO 1:1 to drain queue entries.
        const src = "onmessage=()=>setTimeout(()=>postMessage(0),0);";
        const blob = new Blob([src], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        this._yieldWorker = new Worker(url);
        URL.revokeObjectURL(url);
        this._yieldQueue = [];
        this._yieldWorker.onmessage = () => {
          const fn = this._yieldQueue.shift();
          if (fn) fn();
        };
      }
      if (!this._yieldWorker) return;
      this._yieldQueue.push(cb);
      this._yieldWorker.postMessage(0);
    } catch {
      this._yieldWorker = null; // mark unavailable, future calls skip
    }
  },

  scrollToLastNonEmptyLine() {
    if (!this.terminal?.buffer?.active) {
      this.terminal?.scrollToBottom?.();
      return;
    }

    const buffer = this.terminal.buffer.active;
    // `length` already includes scrollback + viewport rows. Adding baseY scans
    // every scrollback row twice, starting with thousands of out-of-range calls.
    const totalLines = buffer.length;
    let lastNonEmptyLine = -1;

    for (let lineIndex = totalLines - 1; lineIndex >= 0; lineIndex--) {
      const line = buffer.getLine(lineIndex);
      if (line?.translateToString(true).trim()) {
        lastNonEmptyLine = lineIndex;
        break;
      }
    }

    if (lastNonEmptyLine >= 0 && typeof this.terminal.scrollToLine === 'function') {
      let targetLine = Math.max(0, lastNonEmptyLine - this.terminal.rows + 2);
      const maxTargetLine = Math.max(0, lastNonEmptyLine);
      while (targetLine < maxTargetLine) {
        const line = buffer.getLine(targetLine);
        if (line?.translateToString(true).trim()) break;
        targetLine++;
      }
      this.terminal.scrollToLine(targetLine);
    } else {
      this.terminal.scrollToBottom();
    }
  },

  /**
   * Write large buffer to terminal in chunks to avoid UI jank.
   * Uses _safeYield to spread work across frames; falls back to setTimeout
   * and a tick-Worker so progress continues on occluded / idle-throttled tabs.
   * @param {string} buffer - The full terminal buffer to write
   * @param {number} chunkSize - Size of each chunk (default 32KB)
   * @returns {Promise<{parsedAt: number, bufferLength: number, completed: boolean}>} Parse marker snapshot
   */
  chunkedTerminalWrite(buffer, chunkSize = TERMINAL_CHUNK_SIZE, loadOwner) {
    // Generation counter: if a newer chunkedTerminalWrite starts (tab switch),
    // older writes abort instead of continuing to push stale data into the terminal.
    const writeGen = ++this._chunkedWriteGen;
    const bufferLoadOwner = this._beginBufferLoad(loadOwner);

    return new Promise((resolve) => {
      const parseSnapshot = (completed = this._chunkedWriteGen === writeGen) => ({
        parsedAt: performance.now(),
        bufferLength: this.terminal?.buffer?.active?.length ?? 0,
        completed,
      });
      if (!buffer || buffer.length === 0) {
        this._finishBufferLoad(bufferLoadOwner);
        resolve(parseSnapshot());
        return;
      }

      // Strip any DEC 2026 markers that might be in the buffer
      // (from historical SSE data that was stored with markers)
      const cleanBuffer = buffer.replace(DEC_SYNC_STRIP_RE, '');

      // For small buffers, write directly — single-frame render is fast enough
      if (cleanBuffer.length <= chunkSize) {
        this.terminal.write(cleanBuffer, () => resolve(parseSnapshot()));
        // The write is now ordered in xterm's queue. Release live output before
        // parsing completes; subsequent writes stay behind it without being lost.
        this._finishBufferLoad(bufferLoadOwner);
        return;
      }

      // Large buffers: enqueue paced chunks, then append an empty marker whose
      // callback fires after xterm parses every preceding chunk. The live-output
      // gate is released as soon as that marker is ordered, not after parsing, so
      // new output queues behind history instead of being held or dropped.
      let offset = 0;
      const _chunkStart = performance.now();
      let _chunkCount = 0;
      const writeChunk = () => {
        // Abort if a newer chunked write started (user switched tabs)
        if (this._chunkedWriteGen !== writeGen) {
          resolve(parseSnapshot(false));
          return;
        }

        const chunk = cleanBuffer.slice(offset, offset + chunkSize);
        offset += chunk.length;
        _chunkCount++;
        this.terminal.write(chunk);
        if (offset >= cleanBuffer.length) {
          this.terminal.write('', () => {
            const result = parseSnapshot();
            const _totalMs = result.parsedAt - _chunkStart;
            console.log(
              `[CRASH-DIAG] chunkedTerminalWrite complete: ${cleanBuffer.length} bytes in ${_chunkCount} chunks, ${_totalMs.toFixed(0)}ms parsed`
            );
            resolve(result);
          });
          this._finishBufferLoad(bufferLoadOwner);
          return;
        }

        // Schedule next chunk; rAF if possible, else setTimeout/Worker
        // fallback so progress doesn't stall on occluded/unfocused windows.
        this._safeYield(writeChunk);
      };

      // Start writing
      this._safeYield(writeChunk);
    });
  },

  /**
   * Complete a buffer load: unblock live SSE writes.
   * Called when chunkedTerminalWrite finishes (or is skipped for empty buffers).
   *
   * By default queued SSE events are DISCARDED, not flushed. For an established
   * session the loaded buffer from the API is the source of truth up to the
   * response timestamp; SSE events queued during the fetch+write overlap already
   * appear in that buffer, so flushing them writes duplicate data (especially Ink
   * cursor-up redraws), corrupting the terminal display.
   *
   * COD-144: a brand-new session is the exception. Its terminal fetch can resolve
   * BEFORE the PTY emits its first prompt, so the fetched buffer is empty and the
   * prompt arrives only as a queued SSE event. Discarding it leaves the terminal
   * blank until a tab-switch re-fetches a now-populated buffer. When the caller
   * knows the load painted nothing (empty fetch + no cache), it passes
   * `{ flushQueued: true }` so the queued events are REPLAYED through
   * `batchTerminalWrite()` instead of dropped. Replay runs after `_isLoadingBuffer`
   * is cleared, so the events write through normally and are not re-queued.
   *
   * After unblocking, new SSE/WS events deliver subsequent output normally.
   *
   * @param {string} [owner] Load token from `_beginBufferLoad`; a stale owner is a no-op.
   * @param {{ flushQueued?: boolean }} [opts] When `flushQueued` is true, replay any queued events.
   */
  _beginBufferLoad(owner) {
    if (this._bufferLoadSeq === undefined) this._bufferLoadSeq = 0;
    const loadOwner = owner === undefined ? `buffer-${++this._bufferLoadSeq}` : owner;
    this._bufferLoadOwner = loadOwner;
    this._isLoadingBuffer = true;
    this._loadBufferQueue = [];
    return loadOwner;
  },

  _finishBufferLoad(owner, opts) {
    if (owner !== undefined && this._bufferLoadOwner !== owner) {
      return false;
    }
    const queued = this._loadBufferQueue;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    this._bufferLoadOwner = null;
    // COD-144: replay (rather than discard) queued live events when the load
    // painted nothing — the queued prompt is the only content a new session has.
    if (opts?.flushQueued && queued && queued.length) {
      for (const data of queued) {
        this.batchTerminalWrite(data);
      }
    }
    return true;
  },

  // ═══════════════════════════════════════════════════════════════
  // Terminal Controls
  // ═══════════════════════════════════════════════════════════════

  clearTerminal() {
    this.terminal.clear();
  },

  /** Insert editable text at the active prompt without pressing Enter. */
  insertTerminalText(text) {
    if (!this.activeSessionId || !text) return;
    // Under predict the text goes out via sendInput (bypasses onData), so the
    // hook never sees it: clear outstanding predictions here instead.
    if (this._localEchoPolicy === 'predict') this._predictiveEcho?.clearPredictions();
    if (
      this._localEchoEnabled &&
      this._localEchoOverlay &&
      !this._echoPassthroughSessions?.has(this.activeSessionId)
    ) {
      this._localEchoOverlay.appendText(text);
    } else {
      this.sendInput(text).catch(() => {});
    }
    this.terminal?.focus();
  },

  /**
   * Clear only the current editable prompt. This is intentionally distinct
   * from Ctrl+L (clear display) and the agent's destructive `/clear` command.
   */
  clearTerminalInput() {
    if (!this.activeSessionId) return;

    if (typeof CjkInput !== 'undefined') CjkInput.clear();
    if (this._inputFlushTimeout) {
      clearTimeout(this._inputFlushTimeout);
      this._inputFlushTimeout = null;
    }
    this._pendingInput = '';
    // Composer content is about to change out from under any predictions
    if (this._localEchoPolicy === 'predict') this._predictiveEcho?.clearPredictions();

    if (this._localEchoEnabled && this._localEchoOverlay) {
      const flushed = this._localEchoOverlay.getFlushed?.() || { count: 0, text: '' };
      this._localEchoOverlay.clear();
      this._localEchoOverlay.suppressBufferDetection();
      this._flushedOffsets?.delete(this.activeSessionId);
      this._flushedTexts?.delete(this.activeSessionId);
      if (flushed.count > 0) {
        this.sendInput('\x7f'.repeat(flushed.count)).catch(() => {});
      }
    } else {
      // In non-local-echo mode the TUI already owns the editable buffer. Ctrl+U
      // is the conventional kill-line key supported by shells and agent TUIs.
      this.sendInput('\x15').catch(() => {});
    }

    this.showToast?.('Input cleared', 'success');
    this.terminal?.focus();
  },

  /**
   * Restore terminal size to match web UI dimensions.
   * Use this after mobile screen attachment has squeezed the terminal.
   * Sends only resize — SIGWINCH triggers Ink redraw on real dimension changes.
   * Ctrl+L is NOT sent here (Claude Code 2.x treats it as "clear conversation").
   */
  async restoreTerminalSize() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'warning');
      return;
    }

    const dims = this.getTerminalDimensions();
    if (!dims) {
      this.showToast('Could not determine terminal size', 'error');
      return;
    }

    try {
      // Force resize even when dimensions match the server's last known state —
      // another device may have changed the PTY size since this client last sent,
      // and force guarantees a SIGWINCH → Ink redraw at the current device's size.
      await this.sendResize(this.activeSessionId, { force: true });

      this.showToast(`Terminal restored to ${dims.cols}x${dims.rows}`, 'success');
    } catch (err) {
      console.error('Failed to restore terminal size:', err);
      this.showToast('Failed to restore terminal size', 'error');
    }
  },

  // Vestigial no-op: this method has no callers today. It's kept (not deleted)
  // as a documented guard so the Ctrl+L behavior below isn't reintroduced.
  //
  // Originally this sent Ctrl+L (\x0c) when a flagged session first reached
  // idle/working to scrub mux-init junk from the screen. Two problems:
  //   1. `pendingCtrlL` was never actually populated anywhere (dead path).
  //   2. Claude Code 2.x interprets Ctrl+L as a two-step "clear conversation"
  //      command — sending it from background flows risked nuking the user's
  //      conversation if it coincided with another Ctrl+L (e.g. from
  //      selectSession on page reload).
  // If a per-session display-fix is ever needed again, do it via sendResize
  // or an Ink-safe control sequence, NOT \x0c.
  sendPendingCtrlL(_sessionId) {
    // intentionally empty
  },

  // Registry-aware gate for the smart-copy chord (#211). Mirrors
  // shouldOpenCommandPaletteFromShortcut(): honors a rebound or disabled
  // 'copy-selection' entry, and falls back to the default chord when the
  // registry isn't available (isolated test harnesses).
  // Returning true only means "this chord asked to copy", the CALLER decides
  // what happens when there is no selection, so the interrupt stays intact.
  shouldCopyTerminalSelectionFromShortcut(ev) {
    // The custom key handler also runs for keypress/keyup; only keydown decides.
    if (!ev || ev.type !== 'keydown') return false;
    // Hot path: every dispatchable chord needs Ctrl/Cmd/Alt, so plain typing
    // exits before any registry work.
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) return false;
    const registryAvailable =
      typeof this.getShortcutRegistry === 'function' && typeof this.matchesShortcutEvent === 'function';
    const entry = registryAvailable ? this.getShortcutRegistry().find((s) => s.id === 'copy-selection') : null;
    if (entry) return !entry.disabled && this.matchesShortcutEvent(ev, entry);
    return !ev.altKey && (ev.key || '').toLowerCase() === 'c';
  },

  // Copy the current terminal selection. Goes through _copyText (Clipboard API,
  // then a hidden-textarea + execCommand fallback) because install.sh's LAN
  // option serves plain HTTP, where navigator.clipboard is undefined.
  async copyTerminalSelection(text) {
    const selection = text ?? (this.terminal.hasSelection?.() ? this.terminal.getSelection() : '');
    if (!selection) return false;
    const ok = await this._copyText(selection);
    if (ok) {
      // Clearing is what makes a second Ctrl+C an interrupt (and xterm already
      // drops the selection on any keypress, so this matches existing feel).
      this.terminal.clearSelection?.();
      this.showToast('Copied to clipboard', 'success');
    } else {
      this.showToast('Failed to copy', 'error');
    }
    // The execCommand fallback focuses a temp textarea, so hand focus back. This
    // is the CJK-aware focus router, not xterm's raw focus().
    this.terminal.focus();
    return ok;
  },

  /**
   * Auto Copy's ON/OFF, read at flush time from the CACHED settings object
   * (loadAppSettingsFromStorage memoizes, so this is not a localStorage hit).
   *
   * Reading it here rather than mirroring it into a field is deliberate: there
   * is then no apply-path a future settings save can forget to call, and the
   * toggle takes effect on the very next selection instead of the next reload.
   */
  _autoCopySelectionEnabled() {
    try {
      return this.loadAppSettingsFromStorage?.()?.autoCopySelection === true;
    } catch {
      return false;
    }
  },

  /**
   * Copy the current terminal selection because the user finished highlighting
   * it. Called at the end of a selection GESTURE: the document mouseup
   * installed in initTerminal, and the touch-selection gesture end (a touchend
   * the touch path preventDefaults, so no mouseup ever arrives there).
   *
   * ⚠️ This is NOT copyTerminalSelection(): that one clears the selection (so a
   * second Ctrl+C is an interrupt) and hands focus back to the terminal. Both
   * are wrong here: clearing would make the text vanish from under the cursor
   * that just highlighted it, and focusing opens the on-screen keyboard over
   * the text on a phone. Focus is instead RESTORED to whatever held it, which
   * only matters for the execCommand fallback (it focuses a temp textarea on
   * the way through); the Clipboard API path never moves focus at all.
   */
  async _flushAutoCopySelection() {
    const decide = window.CodemanAutoCopy?.decide;
    if (!decide || !this.terminal) return;
    const text = this.terminal.hasSelection?.() ? this.terminal.getSelection() : '';
    const verdict = decide({
      enabled: this._autoCopySelectionEnabled(),
      text,
      lastCopied: this._autoCopyLastText,
      pending: !!this._autoCopyPending,
    });
    this._autoCopyPending = false;
    if (verdict === 'skip') return;
    if (verdict === 'too-large') {
      this._autoCopyNotify('Selection too large to copy automatically. Press Ctrl+C.', 'warning');
      return;
    }

    this._autoCopyLastText = text;
    const focusedBefore = document.activeElement;
    const ok = await this._copyText(text);
    if (
      focusedBefore &&
      focusedBefore !== document.activeElement &&
      focusedBefore.isConnected &&
      typeof focusedBefore.focus === 'function'
    ) {
      try {
        focusedBefore.focus();
      } catch {}
    }
    if (!ok) {
      // Let the next gesture retry the same text rather than dedupe itself into
      // silence after a transient clipboard refusal.
      this._autoCopyLastText = '';
      this._autoCopyNotify('Auto Copy failed: the browser blocked clipboard access', 'error');
      return;
    }
    // Silent on success, like every terminal emulator's copy-on-select, except
    // ONCE per page load: a feature that works by doing nothing visible needs to
    // say so the first time, or the user cannot tell it from a dead toggle.
    if (!this._autoCopyHintShown) {
      this._autoCopyHintShown = true;
      this.showToast('Auto Copy: selection copied', 'success');
    }
  },

  /**
   * Failure/refusal toast, throttled. Auto Copy fires per gesture, so an
   * install where the clipboard is permanently blocked would otherwise paint a
   * toast on every drag, which trains the user to ignore toasts everywhere.
   */
  _autoCopyNotify(message, type) {
    const now = Date.now();
    const last = this._autoCopyNotifiedAt;
    // `last === undefined` is checked rather than falling back to 0: the first
    // failure must always be reported, and a `now - 0 < throttle` comparison
    // only happens to hold because the wall clock is a big number.
    if (last !== undefined && now - last < 10_000) return;
    this._autoCopyNotifiedAt = now;
    this.showToast(message, type);
  },

  _syncMobileHelperTextareaToCursor() {
    if (!MobileDetection.isTouchDevice() || !this.terminal?.element) return;
    try {
      const xtermEl = this.terminal.element;
      const cursor = this.terminal.element.querySelector('.xterm-cursor');
      const screen = this.terminal.element.querySelector('.xterm-screen');
      if (!(xtermEl instanceof HTMLElement) || !(cursor instanceof HTMLElement) || !(screen instanceof HTMLElement)) return;
      const cursorRect = cursor.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      if (!cursorRect.width && !cursorRect.height) return;
      const left = Math.max(0, Math.round(cursorRect.left - screenRect.left));
      const top = Math.max(0, Math.round(cursorRect.top - screenRect.top));
      xtermEl.style.setProperty('--xterm-helper-left', `${left}px`);
      xtermEl.style.setProperty('--xterm-helper-top', `${top}px`);
    } catch {}
  },

  _isMobileTerminalInputFocused() {
    const active = document.activeElement;
    return (
      active === this.terminal?.textarea ||
      active?.classList?.contains('xterm-helper-textarea') ||
      active?.id === 'cjkInput'
    );
  },

  /**
   * Separate terminal input from TUI-owned content on touch devices. A hidden
   * keyboard must not consume taps on expandable readbacks, tool results, or
   * decision rows; those taps belong to the foreground CLI. The visible prompt
   * row remains the deliberate keyboard target.
   */
  _classifyMobileTerminalTap(clientX, clientY) {
    if (!this._terminalViewportAtBottom()) return 'history';

    const pos = this._clientPointToCell(clientX, clientY);
    if (!pos || !this.terminal) return 'input';

    const mouseMode = this.terminal.modes?.mouseTrackingMode;
    const mouseTrackingOn = !!mouseMode && mouseMode !== 'none';
    if (!mouseTrackingOn && !this._shouldReportMouseToCli()) return 'input';

    const buffer = this.terminal.buffer?.active;
    if (!buffer?.getLine) return 'input';

    const rows = Math.max(1, this.terminal.rows || 1);
    const lines = [];
    const wrappedRows = [];
    let hasVisibleContent = false;
    for (let row = 0; row < rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      const text = line?.translateToString?.(true) || '';
      lines.push(text);
      wrappedRows.push(Boolean(line?.isWrapped));
      if (text.trim()) hasVisibleContent = true;
    }
    if (!hasVisibleContent) return 'input';

    const cursorRow = Math.max(0, Math.min(rows - 1, buffer.cursorY || 0));
    const mode = this.sessions?.get(this.activeSessionId)?.mode || 'claude';
    let promptRow = -1;
    let menuSelectionVisible = false;

    if (mode === 'opencode') {
      if (lines[cursorRow]?.includes('\u2503')) promptRow = cursorRow;
    } else {
      for (let row = rows - 1; row >= 0; row--) {
        const promptMatch = lines[row].match(/^\s*[❯›]/);
        if (!promptMatch) continue;
        const tail = lines[row].slice(promptMatch[0].length).trim();
        // A highlighted numbered choice is a menu row, not an editable prompt.
        const hasSiblingChoice = lines.some(
          (line, choiceRow) => choiceRow !== row && /^\s+\d+[.)]\s/.test(line)
        );
        if (/^\d+[.)]\s/.test(tail) && hasSiblingChoice) {
          menuSelectionVisible = true;
          break;
        }
        promptRow = row;
        break;
      }
    }

    const tappedRow = pos.row - 1;
    let logicalLineStart = tappedRow;
    while (logicalLineStart > 0 && wrappedRows[logicalLineStart]) logicalLineStart--;
    let logicalLineEnd = tappedRow;
    while (logicalLineEnd + 1 < rows && wrappedRows[logicalLineEnd + 1]) logicalLineEnd++;
    const tappedLine = lines.slice(logicalLineStart, logicalLineEnd + 1).join('');
    // Claude's status row is TUI-owned: tapping it opens the teammate view, so it
    // must not be treated as a keyboard target. Match the AFFORDANCE, not the
    // wording — the bullet and verb are both unstable (claude 2.1.226 prints
    // "✻ Cooked for 2m 6s", "✻ Baked for 9m 47s"; earlier builds printed
    // "• Working …"), while "esc to interrupt" / "background" are what make the
    // row actionable in the first place.
    if (mode === 'claude' && /\b(?:esc to interrupt|background)\b/i.test(tappedLine)) {
      return 'content';
    }
    if (menuSelectionVisible) return 'content';
    if (promptRow >= 0) {
      const inputEnd = cursorRow >= promptRow ? cursorRow : promptRow;
      if (tappedRow >= promptRow && tappedRow <= inputEnd) return 'input';
    } else if (
      tappedRow === cursorRow ||
      tappedRow >=
        Math.max(
          0,
          rows -
            window.CodemanTerminalInput
              .TUI_PROMPT_DEFAULT_ROWS_FROM_BOTTOM
        )
    ) {
      // During redraws a CLI can temporarily omit its prompt marker or place
      // the cursor above a status footer. Keep the live cursor and a stable
      // lower-screen focus band usable without turning transcript rows above
      // that band into keyboard targets.
      return 'input';
    }

    return 'content';
  },

  _blurMobileTerminalInput() {
    const active = document.activeElement;
    if (
      active === this.terminal?.textarea ||
      active?.classList?.contains('xterm-helper-textarea') ||
      active?.id === 'cjkInput'
    ) {
      active.blur?.();
    }
  },

  /**
   * Tapping outside the terminal closes the on-screen keyboard.
   *
   * The terminal keeps focus on a hidden textarea, and nothing ever released it:
   * once the keyboard was up, every tap on the header, the tab strip or empty
   * page chrome left it up, covering half a phone screen with no way to dismiss
   * it but the OS back gesture.
   *
   * Deliberately narrow, because focus is not ours to steal:
   *
   * - only when the terminal input actually holds focus;
   * - never for a tap inside the terminal — those are classified and routed by
   *   `_handleMobileTerminalTap`, which owns that decision;
   * - never for a tap on another control. Anything focusable or clickable is
   *   about to take focus itself, and the accessory bar in particular exists to
   *   be used WHILE the keyboard is open, so dismissing there would fight the
   *   user. `closest()` covers taps landing on a child (an icon inside a button).
   *
   * Bound to `touchend` rather than `click`: a tap that dismisses the keyboard
   * usually is not meant to activate whatever is underneath, and touchend fires
   * before the synthesized click, so the blur lands first.
   */
  _installMobileKeyboardDismiss() {
    if (this._mobileKeyboardDismissHandler) return;

    // A SCROLL also ends in touchend, and dismissing there is wrong: scrolling
    // to read something while composing must not close the keyboard and lose
    // the composer. Track how far the finger travelled and only treat a
    // near-stationary gesture as a tap — the same TAP_THRESHOLD the terminal's
    // own touch handling uses, so both agree on what a tap is.
    let startX = 0;
    let startY = 0;
    let moved = false;
    this._mobileKeyboardDismissStart = (ev) => {
      if (ev.touches.length !== 1) {
        moved = true; // a multi-touch gesture is never a dismissing tap
        return;
      }
      startX = ev.touches[0].clientX;
      startY = ev.touches[0].clientY;
      moved = false;
    };
    this._mobileKeyboardDismissMove = (ev) => {
      if (moved || !ev.touches.length) return;
      const dx = ev.touches[0].clientX - startX;
      const dy = ev.touches[0].clientY - startY;
      const slop = window.CodemanTerminalInput.MOBILE_KEYBOARD_DISMISS_TAP_SLOP;
      if (Math.abs(dx) > slop || Math.abs(dy) > slop) {
        moved = true;
      }
    };
    this._mobileKeyboardDismissHandler = (ev) => {
      if (moved) return;
      if (!this._isMobileTerminalInputFocused()) return;
      const target = ev.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('#terminalContainer')) return;
      if (target.closest(window.CodemanTerminalInput.MOBILE_KEYBOARD_DISMISS_EXEMPT_SELECTOR)) return;
      this._blurMobileTerminalInput();
    };
    // Passive throughout: this never calls preventDefault, so it must not make
    // the page feel less responsive to scrolling.
    document.addEventListener('touchstart', this._mobileKeyboardDismissStart, { passive: true });
    document.addEventListener('touchmove', this._mobileKeyboardDismissMove, { passive: true });
    document.addEventListener('touchend', this._mobileKeyboardDismissHandler, { passive: true });
  },

  /**
   * Which 'content' taps should DISMISS the mobile keyboard. Expandable
   * readbacks, tool results and decision rows are TUI-owned: tapping them acts
   * on the CLI, so popping the keyboard there is wrong. An inert transcript row
   * still sends its mouse report, but must keep the keyboard reachable —
   * touchstart's preventDefault cancels the compatibility click that would
   * otherwise focus xterm, so focus has to be restored explicitly.
   */
  _isActionableMobileTerminalTap(clientX, clientY) {
    const pos = this._clientPointToCell(clientX, clientY);
    const buffer = this.terminal?.buffer?.active;
    if (!pos || !buffer?.getLine) return false;

    const rows = Math.max(1, this.terminal.rows || 1);
    const lines = [];
    const wrappedRows = [];
    for (let row = 0; row < rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      lines.push(line?.translateToString?.(true) || '');
      wrappedRows.push(Boolean(line?.isWrapped));
    }

    const tappedRow = pos.row - 1;
    let logicalLineStart = tappedRow;
    while (logicalLineStart > 0 && wrappedRows[logicalLineStart]) logicalLineStart--;
    let logicalLineEnd = tappedRow;
    while (logicalLineEnd + 1 < rows && wrappedRows[logicalLineEnd + 1]) logicalLineEnd++;
    const tappedLine = lines.slice(logicalLineStart, logicalLineEnd + 1).join('');

    // Match the AFFORDANCE a CLI prints, not the row's title text: an
    // expandable readback, tool result or status row advertises how to act on
    // it ("ctrl+r to expand", "tap to collapse", "esc to interrupt"). Keying on
    // titles instead would only recognise the exact strings a fixture happens
    // to use, and would let a real readback keep the keyboard open.
    //
    // The hint sits on its own row, so a readback's TITLE row — the one a
    // finger actually lands on — carries no affordance text itself. Look at the
    // adjacent row too, which is how these blocks are laid out in practice.
    // Keyed on the ACTION VERB, and deliberately not on prose verbs. A CLI hint
    // names a key or a gesture ("ctrl+r to expand", "tap to collapse",
    // "esc to interrupt"); "click here to open the file" is transcript content
    // and must keep the keyboard, so `click` and bare `here` are excluded.
    // The hint may sit mid-line — Claude's status row is
    // "✻ Cooked for 2m 6s · esc to interrupt" — so this is not anchored.
    const affordance =
      /\b(?:ctrl\+\w+|shift\+\w+|esc|enter|tab|tap)\s+to\s+(?:expand|collapse|view|open|interrupt|see)\b/i;
    const blockStart = Math.max(0, logicalLineStart - 1);
    const blockEnd = Math.min(rows - 1, logicalLineEnd + 1);
    for (let row = blockStart; row <= blockEnd; row++) {
      if (affordance.test(lines[row])) return true;
    }
    // A Claude status row ("✻ Cooked for 2m 6s · esc to interrupt") is caught by
    // the affordance above; there is deliberately no verb literal here, because
    // the verb is randomised per build.

    // A visible selection dialog makes its OWN rows actionable, not the whole
    // screen. Two viewport-wide `some()` tests used to be the entire answer, so
    // while a Claude question or permission dialog was up EVERY tap in the
    // terminal (inert transcript, the question title, blank rows) came back
    // actionable, and the caller blurred on each one. The on-screen keyboard
    // could then not be opened at all until the dialog was answered, which left
    // tapping an option row as the only interaction available: the one that
    // commits an answer. Requiring the TAPPED line to be a numbered row keeps
    // the dialog's own rows behaving as before (report the tap, keep the
    // keyboard down) while any other row can still summon the keyboard, which
    // is how a digit gets typed at a dialog instead of aimed at it.
    const hasMenuPrompt = lines.some((line) => /^\s*[❯›]\s+\d+[.)]\s/.test(line));
    const hasMenuChoice = lines.some((line) => /^\s+\d+[.)]\s/.test(line));
    return hasMenuPrompt && hasMenuChoice && /^\s*(?:[❯›]\s*)?\d+[.)]\s/.test(tappedLine);
  },

  _focusMobileTerminalInput() {
    this._syncMobileHelperTextareaToCursor();
    const cjkInput = document.getElementById('cjkInput');
    if (cjkInput?.classList.contains('cjk-input-visible')) {
      cjkInput.focus();
    } else {
      this.terminal?.focus();
    }
  },

  _handleMobileTerminalTap(touch, startedWithTerminalFocus, cachedIntent = null) {
    // A guard bail-out, not a classification: there is nothing to classify. It is
    // deliberately NOT 'history', which would claim the viewport was scrolled up.
    if (!touch || !this.terminal) return null;
    // touchstart already classified this exact point; reuse it rather than paying
    // a second full-viewport scan for the same gesture.
    // While a selection is up, a tap EXTENDS it instead of doing its usual job —
    // picking up a 4px handle with a fingertip is a coin flip, tapping the other
    // end is not. Dismissal stays explicit (the bar's ✕, or Copy), so no tap is
    // ever spent on getting out of a mode the user is still using.
    if (this._touchSelectionActive) {
      this._extendTouchSelection(touch.clientX, touch.clientY);
      return 'select';
    }

    const intent = cachedIntent ?? this._classifyMobileTerminalTap(touch.clientX, touch.clientY);
    // Computed once and reused by the keyboard decision at the tail of this
    // method: both ask the same question, and the pane cannot change in between
    // (a mouse report only reaches the PTY; its output lands on a later turn).
    const actionable = this._isActionableMobileTerminalTap(touch.clientX, touch.clientY);

    // A tap that lands ON a link activates it, at any scroll position and before
    // any mouse report — exactly what a desktop click does, where the provider's
    // activate() runs and _handleDesktopTerminalClick deliberately skips the SGR
    // tap for a hovered link so the CLI never also sees a click there.
    //
    // Two kinds of row keep their existing meaning instead: the composer, where a
    // tap places the caret in text the USER typed (_tapIsOnCaretLine), and
    // TUI-owned rows, where a numbered choice or an expandable readback is
    // answering a dialog and routinely carries the very path the tap would
    // otherwise open — on a phone the dialog is the only interaction that
    // matters, so it wins.
    if (
      !actionable &&
      !this._tapIsOnCaretLine(touch.clientX, touch.clientY) &&
      this._activateTerminalLinkAtPoint(touch.clientX, touch.clientY)
    ) {
      // No focus change: a 'content' tap was already blurred by touchstart, and
      // popping the keyboard behind a tab that is about to take over is noise.
      return 'link';
    }

    if (intent === 'history') {
      // Scrolled up: send NO mouse report — a tap on old output must not be
      // delivered to the CLI as a click on whatever row now occupies that cell.
      // Focus is a separate question, and the answer is yes: the user tapped the
      // terminal, so let them type. Blurring here stranded activeElement on
      // <body> with no way back to the keyboard.
      this._focusMobileTerminalInput();
      return intent;
    }

    const mouseMode = this.terminal.modes?.mouseTrackingMode;
    const mouseTrackingOn = !!mouseMode && mouseMode !== 'none';
    const shouldActivate = intent === 'content' || startedWithTerminalFocus;
    if (shouldActivate && mouseTrackingOn) {
      // xterm's mouse encoder owns live DECSET modes. The synthetic DOM click
      // follows the same path as a desktop click.
      this._dispatchSyntheticTerminalClick(touch.clientX, touch.clientY);
    } else if (shouldActivate && this._shouldReportMouseToCli()) {
      // Claude/Codex/Gemini DECSETs are stripped from the browser stream, so
      // report directly to the PTY while retaining local touch scrollback. Only
      // while the CLI actually has tracking on (see _shouldReportMouseToCli).
      this._sendSyntheticSgrTap(touch.clientX, touch.clientY);
    }

    if (intent === 'content' && actionable) {
      // A synthetic xterm click can focus its helper textarea. Blur after the
      // report so collapsing a readback never opens or retains the keyboard.
      this._blurMobileTerminalInput();
    } else if (intent === 'content' && startedWithTerminalFocus) {
      // Tapping INERT transcript with the keyboard already up closes it.
      //
      // Every terminal tap re-focuses, so once the keyboard is open the only way
      // to close it is the accessory bar's dismiss chevron. Tapping the
      // transcript to get the screen back is the obvious gesture, and nothing
      // else claims it: an inert row has no action to trigger, so by this point
      // the tap has already done its only other job (the mouse report above).
      //
      // Scoped to 'content' ON PURPOSE. The prompt row ('input') keeps
      // focus-then-position, so a second tap there still places the caret —
      // pinned by "keeps the first prompt tap focus-only so it cannot activate a
      // CLI row". Toggling there would trade away real capability.
      this._blurMobileTerminalInput();
    } else {
      this._focusMobileTerminalInput();
    }
    return intent;
  },

  // ═══════════════════════════════════════════════════════════════
  // Synthetic tap → mouse report
  // ═══════════════════════════════════════════════════════════════
  // Dispatch a mousedown+mouseup pair at viewport coords (clientX/clientY) to
  // xterm's root element. xterm's mouse-reporting handler reads the event's
  // client coords, maps them to a terminal cell relative to .xterm-screen, and
  // — when the foreground app has mouse tracking active (DECSET 1000/1002/1006,
  // which Claude's input enables) — encodes an SGR mouse report to the PTY.
  // That is the same path a real desktop click takes; on touch devices the
  // browser's own compatibility-event synthesis is unreliable (and suppressed
  // by touch-action:none), so we drive it explicitly. With mouse tracking off
  // it degrades to a harmless zero-length click (no drag → no text selection).
  _dispatchSyntheticTerminalClick(clientX, clientY) {
    const el = this.terminal?.element;
    if (!el || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    // xterm registers its mouseup listener on document during mousedown, so a
    // bubbling mouseup reaches it; dispatch both to the root element in order.
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      detail: 1,
    };
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    } catch {
      /* MouseEvent constructor unavailable — tap-to-position simply no-ops */
    }
  },

  // Mirror of the server's isAltScreenStripMode (session.ts): session modes whose
  // output stream has mouse-tracking DECSET sequences stripped before reaching the
  // browser. For these, xterm's live mouseTrackingMode is useless as a gate — the
  // PTY-side TUI keeps tracking enabled, we just never see the enable sequence.
  /**
   * True when the browser has to hand-encode a click report for the CLI.
   *
   * Two conditions, and dropping either one is a bug that has already happened:
   *
   * 1. The session's mode is one whose mouse DECSETs the server STRIPS out of
   *    the stream (claude/codex/gemini, `isAltScreenStripMode`), which is why
   *    xterm's own encoder is permanently idle here and something has to stand
   *    in for it.
   * 2. The CLI actually has a mouse-tracking mode on right now. The server
   *    records that as it strips (`_recordStrippedMouseMode` in session.ts) and
   *    publishes it as `cliMouseTracking`. Without this half the browser
   *    reported EVERY click, so a CLI sitting at its composer with no dialog
   *    open, or a pane that has fallen back to a shell prompt, received mouse
   *    reports it never asked for. A shell prints those as literal text
   *    (`[<0;88;20M`) and they garble the next line typed.
   *
   * Fails toward silence: an unknown or stale flag reports nothing rather than
   * injecting bytes. After a server restart the flag is false until the CLI
   * re-emits its DECSET, which closing and reopening a dialog does.
   */
  _shouldReportMouseToCli() {
    const session = this.sessions?.get(this.activeSessionId);
    const mode = session?.mode || 'claude';
    if (mode !== 'claude' && mode !== 'codex' && mode !== 'gemini') return false;
    return session?.cliMouseTracking === true;
  },

  // True when xterm's viewport shows the live PTY screen (not scrolled up into
  // local scrollback). SGR coordinates are only meaningful then: the TUI's
  // screen is the bottom `rows` of the buffer, so a report computed from a
  // scrolled-up viewport would hit-test a completely different row.
  _terminalViewportAtBottom() {
    const buf = this.terminal?.buffer?.active;
    return !buf || buf.viewportY >= buf.baseY;
  },

  // Map a viewport point to a 1-based terminal cell the same way xterm maps a
  // click: offset inside .xterm-screen divided by the rendered cell size,
  // clamped to the grid. Returns null when the terminal isn't measurable yet.
  _clientPointToCell(clientX, clientY) {
    if (!this.terminal || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const screen = this.terminal.element?.querySelector('.xterm-screen');
    const cell = this.terminal._core?._renderService?.dimensions?.css?.cell;
    if (!screen || !cell?.width || !cell?.height) return null;
    const rect = screen.getBoundingClientRect();
    const col = Math.max(1, Math.min(this.terminal.cols, Math.floor((clientX - rect.left) / cell.width) + 1));
    const row = Math.max(1, Math.min(this.terminal.rows, Math.floor((clientY - rect.top) / cell.height) + 1));
    return { col, row };
  },

  // Encode a tap as an SGR mouse report (press + release at button 0) and send it
  // to the PTY directly, bypassing xterm's mouse encoder.
  _sendSyntheticSgrTap(clientX, clientY) {
    if (!this.activeSessionId) return;
    if (!this._terminalViewportAtBottom()) return; // scrollback click → misfire, do nothing
    const pos = this._clientPointToCell(clientX, clientY);
    if (!pos) return;
    this._sendInputAsync(this.activeSessionId, `\x1b[<0;${pos.col};${pos.row}M\x1b[<0;${pos.col};${pos.row}m`);
  },

  // True when a parsed CLI version string ('2.1.187' — banner-parsed on the
  // server, delivered via session:cliInfo / SessionState.cliVersion) is known
  // AND >= the minimum. Unknown or unparseable versions return false so
  // callers keep the conservative behavior.
  _cliVersionAtLeast(version, minimum) {
    if (typeof version !== 'string') return false;
    const parts = version.trim().replace(/^v/, '').split('.').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return false;
    const min = minimum.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (parts[i] !== min[i]) return parts[i] > min[i];
    }
    return true;
  },

  // Wheel forwarding gate for the container wheel handler: no Shift override,
  // xterm's own encoder dormant, viewport at the bottom, and a TUI VERIFIED to
  // scroll its transcript on SGR wheel reports — which today is claude 2.1.187+
  // and nothing else (older Claude Code captures wheel as select-menu option
  // navigation; an unknown version is treated as older). Gemini and codex are
  // strip modes too but keep the local wheel — taps/clicks are still forwarded
  // for them (harmless no-ops at worst).
  //
  // Codex USED to forward here and was the #227 regression (DodgyBadger, Codex
  // latest / Chrome / Win11: dead wheel in codex, working scrollbar drag).
  // Measured on codex-cli 0.147.0 in a bare tmux: it never enables mouse
  // tracking (`mouse_any_flag=0`) and SGR wheel reports fed to its PTY change
  // NOTHING on screen — it runs an inline viewport (`alternate_on=0`) and pushes
  // its transcript into the terminal's own scrollback (tmux `history_size`
  // grows), so there is no in-app pager to drive and local scrollback IS the
  // codex transcript. Forwarding therefore swallowed every tick.
  // Wheel delta → whole scroll lines. macOS trackpads turn Shift+two-finger
  // scroll into a HORIZONTAL wheel (deltaY≈0, deltaX carries the magnitude), and
  // Shift routes the wheel to local scrollback (_shouldForwardWheelToApp returns
  // false on Shift). So under Shift, read whichever axis dominates — otherwise
  // deltaY≈0 collapses to a fixed ±1 line/tick and the gesture can't page through
  // history on a trackpad (issue #154). Non-Shift and mouse-wheel paths are
  // unchanged (they carry deltaY). The `|| ±1` keeps sub-25px deltas moving.
  //
  // `deltaMode` says what UNIT the delta is in, and ignoring it made every
  // non-pixel browser scroll ~4x too slowly: Firefox reports DOM_DELTA_LINE (1)
  // with deltaY≈3 per notch, so the pixel math rounded to 0 and fell through to
  // the ±1 fallback — one line per notch, versus 4-5 for Chrome's ~110px. In
  // Claude mode the same value also capped the forwarded SGR report at one tick.
  _wheelScrollLines(ev) {
    const lines = this._wheelScrollLinesFloat(ev);
    if (!lines) return 0; // pure horizontal swipe: don't fall through to -1
    return Math.round(lines) || (lines > 0 ? 1 : -1);
  },

  /** Unrounded variant for the smooth local-scroll path, which accumulates
   *  sub-line fractions across events instead of forcing every tiny trackpad
   *  delta to a whole ±1 line. Same unit handling and Shift-axis trap. */
  _wheelScrollLinesFloat(ev) {
    const delta = ev.shiftKey && Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    if (!delta) return 0;
    return ev.deltaMode === 1 // DOM_DELTA_LINE (Firefox mouse wheel)
      ? delta
      : ev.deltaMode === 2 // DOM_DELTA_PAGE
        ? delta * (this.terminal?.rows || 24)
        : delta / 25; // DOM_DELTA_PIXEL (Chrome/WebKit, and every trackpad)
  },

  _shouldForwardWheelToApp(ev) {
    if (ev.shiftKey) return false;
    // Opt-out (App Settings → Input → "Wheel scrolls local history"): pin the
    // plain wheel to xterm's own scrollback like pre-#144, for users who prefer
    // it over forwarding the wheel to the CLI's transcript (issue #154). Cheap —
    // loadAppSettingsFromStorage() is cache-backed.
    //
    // FOOTGUN, and why it is handled downstream rather than here: for a
    // repaint-mode CLI that local scrollback is EMPTY (tmux keeps no history for
    // the pane), so this setting can silently convert a working wheel into a
    // dead one — a plausible reading of the #205 retest, where a user whose
    // scrolling was broken on 1.11.x may well have flipped it while hunting for
    // a fix. Scoping the setting away from those modes would be the other
    // option, but it would override an explicit user choice; instead the caller
    // falls through to _maybePageCliTranscript, so the gesture still pages the
    // CLI's transcript and the setting keeps meaning exactly what it says.
    if (this.loadAppSettingsFromStorage?.()?.terminalWheelLocalScrollback) return false;
    const mode = this.terminal?.modes?.mouseTrackingMode;
    if (mode && mode !== 'none') return false;
    const session = this.sessions?.get(this.activeSessionId);
    const sessionMode = session?.mode || 'claude';
    if (sessionMode !== 'claude') return false;
    if (!this._cliVersionAtLeast(session?.cliVersion, '2.1.187')) return false;
    // Deliberately NOT gated on _terminalViewportAtBottom(). It used to be, so
    // that leaving the bottom handed the wheel back to local scrollback and both
    // histories stayed reachable without a mode switch. In practice that inverted
    // the behavior users actually want: a repaint-mode CLI keeps NO terminal
    // scrollback of its own (tmux reports history_size=0 for a Claude pane), so
    // xterm's buffer holds only Codeman's REPLAYED repaint frames. Scrolling that
    // locally drags the CLI's own pinned furniture (the prompt box, the status
    // line) up the screen and shows stale frames underneath, which reads as "the
    // window scrolled away" rather than "I am reading history".
    //
    // And it was easy to fall into: scrollToLastNonEmptyLine() parks the viewport
    // `rows - 2` above the last non-empty row, so any tab switch onto a session
    // with trailing blank rows left the viewport off-bottom and every later wheel
    // went local. Forwarding unconditionally keeps the CLI's transcript as the
    // plain wheel's target and its input box fixed in place; local scrollback is
    // still on Shift+wheel and on the "Wheel scrolls local history" opt-out above.
    return true;
  },

  // Encode wheel ticks as SGR reports (button 64 = up, 65 = down) at the pointer
  // cell. Reports are coalesced into one fire-and-forget write per ~40ms: a
  // trackpad emits dozens of wheel events per second and each send becomes a
  // tmux send-keys on the server — unbatched, a single flick would spawn a
  // process storm. Per-event tick count is capped (Claude applies its own
  // scroll-speed multiplier and acceleration on top), and the queue is bounded
  // so a wild scroll can't build a backlog that keeps scrolling after the finger
  // stops. Flushed via _sendInputEphemeral — loss-tolerant, off the durable queue.
  _sendSyntheticSgrWheel(clientX, clientY, lines) {
    if (!this.activeSessionId || !lines) return;
    const pos = this._clientPointToCell(clientX, clientY);
    if (!pos) return;
    const btn = lines < 0 ? 64 : 65;
    const ticks = Math.min(Math.abs(lines), 5);
    this._queueScrollBytes(`\x1b[<${btn};${pos.col};${pos.row}M`.repeat(ticks));
  },

  /**
   * Shared 40ms coalescer for every byte a scroll gesture sends to the PTY (SGR
   * wheel reports and the PageUp/PageDown fallback alike). Each flush becomes a
   * tmux send-keys server-side, so per-event writes would spawn a process storm
   * on a single flick; the queue is bounded so a wild scroll can't build a
   * backlog that keeps scrolling after the finger stops.
   */
  _queueScrollBytes(data) {
    if (!data || !this.activeSessionId) return;
    const queued = this._wheelSgrQueue || '';
    if (queued.length > 512) return;
    this._wheelSgrQueue = queued + data;
    if (this._wheelSgrFlushTimer) return;
    this._wheelSgrFlushTimer = setTimeout(() => this._flushWheelSgrQueue(), 40);
  },

  /**
   * True when this session's LOCAL scrollback is structurally empty: a Claude
   * pane in repaint mode, where tmux reports `history_size≈0` and every frame
   * overwrites the last, so xterm's normal buffer never grows past one screen
   * (`baseY === 0`). Scrolling that buffer is a no-op no matter how the gesture
   * is routed — the "wheel does nothing at all" half of the #205 retest.
   */
  _localScrollbackIsHollow() {
    const mode = this.sessions?.get(this.activeSessionId)?.mode || 'claude';
    if (mode !== 'claude') return false;
    const buf = this.terminal?.buffer?.active;
    if (!buf || buf.type === 'alternate') return false;
    return (buf.baseY || 0) === 0;
  },

  /**
   * LAST-RESORT scroll for a hollow local buffer: translate gesture lines into
   * coalesced PageUp/PageDown key sends so the CLI pages its OWN transcript.
   *
   * The rescue path for every way `_shouldForwardWheelToApp` can come back false
   * on a Claude session that has no local history to fall back on: the CLI
   * version probe failed or is genuinely older than 2.1.187, or the user turned
   * on "Wheel scrolls local history" (which pins the wheel to a buffer that,
   * for a repaint-mode CLI, is empty — the setting's footgun). Before this, all
   * of those produced a completely dead gesture; the #205 reporter proved the
   * keyboard route works by paging back through intact text with Fn+Up.
   *
   * Triple-guarded (claude mode + gate false + `baseY === 0`), so a session with
   * real local scrollback is never touched. Shift is excluded on purpose: it is
   * the explicit "give me local scrollback" gesture and must keep that meaning.
   *
   * @returns true when the gesture was consumed here (the caller must not also
   *          scroll locally).
   */
  _maybePageCliTranscript(ev, lines) {
    if (!lines || ev?.shiftKey || !this.activeSessionId) return false;
    if (!this._localScrollbackIsHollow()) return false;
    // Leftover travel belongs to the tab it was made on.
    if (this._pageKeySession !== this.activeSessionId) {
      this._pageKeySession = this.activeSessionId;
      this._pageKeyPending = 0;
    }
    const tuning = window.CodemanTerminalInput;
    const perPage = Math.max(2, Math.round((this.terminal?.rows || 24) * tuning.PAGE_KEY_SCREEN_FRACTION));
    const pending = (this._pageKeyPending || 0) + lines;
    const pages = Math.trunc(pending / perPage);
    this._pageKeyPending = pending - pages * perPage;
    if (pages) {
      const key = pages < 0 ? tuning.KEY_PAGE_UP : tuning.KEY_PAGE_DOWN;
      this._queueScrollBytes(key.repeat(Math.min(Math.abs(pages), tuning.PAGE_KEY_MAX_PER_BATCH)));
    }
    this._logScrollRouting('page-keys');
    return true;
  },

  /**
   * One line in the console saying WHY a scroll gesture went where it went.
   *
   * Issue #205 ran two rounds of remote guesswork — is the CLI version probe
   * empty, is the opt-out setting on, did a mouse DECSET leak past the strip? —
   * that this single log answers directly. Logged once per session per distinct
   * decision, so a steady gesture stays silent and a CHANGE (e.g. the version
   * arriving late and flipping the route) still prints.
   */
  _logScrollRouting(decision) {
    const sessionId = this.activeSessionId || '(none)';
    const session = this.sessions?.get(sessionId);
    const optOut = !!this.loadAppSettingsFromStorage?.()?.terminalWheelLocalScrollback;
    const tracking = this.terminal?.modes?.mouseTrackingMode || 'none';
    const baseY = this.terminal?.buffer?.active?.baseY ?? -1;
    const signature = `${decision}|${session?.mode}|${session?.cliVersion}|${optOut}|${tracking}|${baseY > 0}`;
    if (!this._scrollRoutingLogged) this._scrollRoutingLogged = new Map();
    if (this._scrollRoutingLogged.get(sessionId) === signature) return;
    this._scrollRoutingLogged.set(sessionId, signature);
    console.log(
      `[scroll] ${sessionId} → ${decision} (mode=${session?.mode || '?'}, cliVersion=${session?.cliVersion || 'unknown'}, ` +
        `localScrollbackOptOut=${optOut}, mouseTracking=${tracking}, localScrollbackRows=${baseY})`
    );
  },

  _flushWheelSgrQueue() {
    this._wheelSgrFlushTimer = null;
    const data = this._wheelSgrQueue;
    this._wheelSgrQueue = '';
    // Ephemeral (fire-and-forget): wheel reports are loss-tolerant, so they skip
    // the durable seq/ACK queue — no localStorage churn, no "Nb queued" flicker
    // in the connection indicator on every scroll tick.
    if (data && this.activeSessionId) this._sendInputEphemeral(this.activeSessionId, data);
  },

  // Desktop counterpart of the touchend tap branch: hand-encode an SGR report
  // for a plain left-click when the server strips mouse DECSETs (see
  // _shouldReportMouseToCli). Every skip below is a click that already has
  // a meaning elsewhere: synthetic/compat clicks after a touch tap (touchend
  // reported already), modified clicks (shift keeps xterm's selection
  // override), double/triple clicks (word/line selection), drag-selections,
  // clicks on hovered links (activate() already handles the click — a second
  // synthetic SGR press could e.g. dismiss a claude permission dialog),
  // clicks outside the cell grid, and sessions where xterm's own encoder is
  // live (it reported the click itself — a second report would double-move).
  _handleDesktopTerminalClick(ev) {
    if (!this.terminal || !ev?.isTrusted) return;
    if (ev.button !== 0 || ev.detail !== 1) return;
    if (ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const mode = this.terminal.modes?.mouseTrackingMode;
    if (mode && mode !== 'none') return;
    if (!this._shouldReportMouseToCli()) return;
    if (this.terminal.hasSelection?.()) return;
    if (this._linkHovered) return; // link provider hover/leave callbacks (registerFilePathLinkProvider)
    if (performance.now() <= (this._trustedTapMouseSuppressUntil || 0)) return;
    if (!ev.target?.closest?.('.xterm-screen')) return;
    this._sendSyntheticSgrTap(ev.clientX, ev.clientY);
  },

  _installMobileTapMouseGuard() {
    const el = this.terminal?.element;
    if (!el || el._codemanTapMouseGuardInstalled) return;
    if (typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice && !MobileDetection.isTouchDevice()) return;
    el._codemanTapMouseGuardInstalled = true;
    const suppressTrustedCompatMouse = (ev) => {
      const suppressUntil = this._trustedTapMouseSuppressUntil || 0;
      if (!ev.isTrusted || performance.now() > suppressUntil) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    el.addEventListener('mousedown', suppressTrustedCompatMouse, true);
    el.addEventListener('mouseup', suppressTrustedCompatMouse, true);
  },

  _suppressTrustedTapMouseEvents() {
    const ms = window.CodemanTerminalInput?.TOUCH_COMPAT_MOUSE_SUPPRESS_MS || 450;
    this._trustedTapMouseSuppressUntil = performance.now() + ms;
  },

  increaseFontSize() {
    const current = this.terminal.options.fontSize || 14;
    this.setFontSize(Math.min(current + 2, 24));
  },

  decreaseFontSize() {
    const current = this.terminal.options.fontSize || 14;
    this.setFontSize(Math.max(current - 2, 10));
  },

  setFontSize(size) {
    this.terminal.options.fontSize = size;
    document.getElementById('fontSizeDisplay').textContent = size;
    this.fitAddon.fit();
    localStorage.setItem('codeman-font-size', size);
    // Update overlay font cache and re-render at new cell dimensions
    this._localEchoOverlay?.refreshFont();
    this._predictiveEcho?.refreshFont();
  },

  /**
   * Apply the per-device `terminalFontFamily` setting to the live terminal.
   * The custom family is resolved against the built-in stack (constants.js),
   * so passing '' / undefined restores the default. Mirrors setFontSize():
   * refit for the new cell metrics, then refresh the echo overlays' cached
   * font so predictions keep landing on the right cells.
   */
  applyTerminalFontFamily(custom) {
    const resolved = window.CodemanTerminalFont.resolve(custom);
    if (!this.terminal || this.terminal.options.fontFamily === resolved) return;
    this.terminal.options.fontFamily = resolved;
    this.fitAddon?.fit();
    this._localEchoOverlay?.refreshFont();
    this._predictiveEcho?.refreshFont();
  },

  loadFontSize() {
    const saved = localStorage.getItem('codeman-font-size');
    if (saved) {
      const size = parseInt(saved, 10);
      if (size >= 10 && size <= 24) {
        this.terminal.options.fontSize = size;
        document.getElementById('fontSizeDisplay').textContent = size;
      }
    }
  },

  /**
   * Get terminal dimensions with minimum enforcement.
   * Prevents extremely narrow terminals that cause vertical text wrapping.
   * @returns {{cols: number, rows: number}|null}
   */
  getTerminalDimensions() {
    const MIN_COLS = 40;
    const MIN_ROWS = 10;
    const dims = this.fitAddon?.proposeDimensions();
    if (!dims) return null;
    return {
      cols: Math.max(dims.cols, MIN_COLS),
      rows: Math.max(dims.rows, MIN_ROWS),
    };
  },

  /**
   * Send resize to a session with minimum dimension enforcement.
   * @param {string} sessionId
   * @param {{ forceHttp?: boolean, force?: boolean }} [options]
   * @returns {Promise<boolean>} Whether dimensions changed from the last send
   */
  async sendResize(sessionId, options = {}) {
    // Fit terminal to container before reading dimensions — ensures local
    // terminal size matches what we report to the server PTY.
    if (this.fitAddon) this.fitAddon.fit();
    const dims = this.getTerminalDimensions();
    if (!dims) return false;
    // Did the dimensions actually change since the last resize we sent? Callers
    // use this to skip work (e.g. the post-resize TUI-redraw settle) when no
    // real SIGWINCH was triggered — switching tabs at the same browser size is
    // a no-op on the server and needs no redraw grace.
    const prev = this._lastResizeDims;
    const changed = !prev || prev.cols !== dims.cols || prev.rows !== dims.rows;
    // Update _lastResizeDims so the throttledResize handler won't redundantly
    // clear the terminal for the same dimensions (which would blank the screen
    // without a subsequent Ink redraw to repaint it).
    this._lastResizeDims = { cols: dims.cols, rows: dims.rows };
    const viewportType =
      typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType
        ? MobileDetection.getDeviceType()
        : window.innerWidth < 430
          ? 'mobile'
          : window.innerWidth < 768
            ? 'tablet'
            : 'desktop';
    // Fast path: WebSocket resize
    if (!options.forceHttp && this._wsReady && this._wsSessionId === sessionId) {
      try {
        const msg = { t: 'z', c: dims.cols, r: dims.rows, v: viewportType };
        if (options.force) msg.f = true;
        this._ws.send(JSON.stringify(msg));
        return changed;
      } catch {
        // Fall through to HTTP POST
      }
    }
    const body = { ...dims, viewportType };
    if (options.force) body.force = true;
    await fetch(`/api/sessions/${sessionId}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return changed;
  },

  /**
   * Send input to the active session.
   * @param {string} input - Text to send (include \r for Enter)
   * @returns {Promise<void>}
   */
  async sendInput(input) {
    if (!this.activeSessionId || !input) return;
    // Route through the durable, exactly-once delivery layer (useMux for the
    // POST fallback) so voice / keyboard-accessory / paste input also survives a
    // dropped link instead of being lost in a single best-effort fetch.
    this._sendInputAsync(this.activeSessionId, input, { useMux: true });
  },

  // ═══════════════════════════════════════════════════════════════
  // Directory Input
  // ═══════════════════════════════════════════════════════════════

  toggleDirInput() {
    const btn = document.querySelector('#dirDisplay').parentElement;
    const input = document.getElementById('dirInput');

    if (input.classList.contains('hidden')) {
      input.classList.remove('hidden');
      btn.style.display = 'none';
      input.focus();
    }
  },

  hideDirInput() {
    const btn = document.querySelector('#dirDisplay').parentElement;
    const input = document.getElementById('dirInput');

    setTimeout(() => {
      input.classList.add('hidden');
      btn.style.display = '';

      const value = input.value.trim();
      document.getElementById('dirDisplay').textContent = value || 'No directory';
    }, 100);
  },

  // Re-theme all live xterm terminals (main + teammate) to the given skin's palette.
  // Uses the xterm v5+ live setter (full object assignment triggers a repaint for both
  // DOM and WebGL renderers) plus a belt-and-suspenders refresh().
  applyTerminalSkin(skin) {
    const theme = { ...(window.CODEMAN_XTERM_THEMES[skin] || window.CODEMAN_XTERM_THEMES['daylight-blue']) };
    const minimumContrastRatio = window.codemanCurrentSkinIsLight(skin) ? 4.5 : 1;
    if (this.terminal) {
      this.terminal.options.minimumContrastRatio = minimumContrastRatio;
      this.terminal.options.theme = theme;
      // The zero-lag typing overlay caches the xterm foreground/background.
      // Refresh it on live skin changes so typed text never keeps the prior
      // theme's dark backing surface or foreground color.
      this._localEchoOverlay?.refreshFont();
      this._predictiveEcho?.refreshFont();
      try {
        this.terminal.refresh(0, this.terminal.rows - 1);
      } catch {}
    }
    if (this.teammateTerminals) {
      for (const [, entry] of this.teammateTerminals) {
        if (entry && entry.terminal) {
          entry.terminal.options.minimumContrastRatio = minimumContrastRatio;
          entry.terminal.options.theme = { ...theme };
          try {
            entry.terminal.refresh(0, entry.terminal.rows - 1);
          } catch {}
        }
      }
    }
  },
});

// ═══════════════════════════════════════════════════════════════
// COD-9 — Cross-session search (folded into the welcome history panel)
// Consumes GET /api/search; renders grouped result cards with jump-to actions.
// ═══════════════════════════════════════════════════════════════

(function (global) {
  const SEARCH_DEBOUNCE_MS = 250;
  const SEARCH_LIMIT = 60;
  const SOURCE_LABELS = { session: 'Sessions', event: 'Events', file: 'Files' };

  /** Human-friendly relative-ish timestamp matching the history panel's style. */
  function formatSearchTime(ts) {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    return (
      d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })
    );
  }

  global.CodemanSearch = { SEARCH_DEBOUNCE_MS, SEARCH_LIMIT, SOURCE_LABELS, formatSearchTime };
})(window);

Object.assign(CodemanApp.prototype, {
  /**
   * Wire up the search box, filter chips, and selects inside the welcome
   * history panel. Idempotent — safe to call every time the overlay opens.
   */
  initSearchPanel() {
    const input = document.getElementById('searchInput');
    if (!input || this._searchPanelWired) {
      // Even when already wired, refresh the case dropdown (cases may have loaded since).
      if (this._searchPanelWired) this._populateSearchCaseFilter();
      return;
    }
    this._searchPanelWired = true;

    // Active source-type filter set (mirrors the chip .active state → types= param).
    this._searchTypes = new Set(['session', 'event', 'file']);
    this._searchSecondary = { caseLabel: '', status: '', days: '' };
    this._searchDebounceTimer = null;
    this._searchSeq = 0;
    this._searchLastData = null;

    const clearBtn = document.getElementById('searchClearBtn');
    const results = document.getElementById('searchResults');

    input.addEventListener('input', () => {
      if (clearBtn) clearBtn.hidden = input.value.length === 0;
      this._scheduleSearch();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && input.value) {
        ev.stopPropagation();
        this._clearSearch();
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => this._clearSearch());
    }

    document.querySelectorAll('#searchFilters .search-filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const t = chip.dataset.typeFilter;
        // Keep at least one type selected.
        if (this._searchTypes.has(t) && this._searchTypes.size === 1) return;
        if (this._searchTypes.has(t)) {
          this._searchTypes.delete(t);
          chip.classList.remove('active');
        } else {
          this._searchTypes.add(t);
          chip.classList.add('active');
        }
        this._runSearch();
      });
    });

    const caseSel = document.getElementById('searchCaseFilter');
    const statusSel = document.getElementById('searchStatusFilter');
    const dateSel = document.getElementById('searchDateFilter');
    if (caseSel) {
      caseSel.addEventListener('change', () => {
        this._searchSecondary.caseLabel = caseSel.value;
        this._renderSearch(this._searchLastData);
      });
    }
    if (statusSel) {
      statusSel.addEventListener('change', () => {
        this._searchSecondary.status = statusSel.value;
        this._renderSearch(this._searchLastData);
      });
    }
    if (dateSel) {
      dateSel.addEventListener('change', () => {
        this._searchSecondary.days = dateSel.value;
        this._renderSearch(this._searchLastData);
      });
    }

    this._populateSearchCaseFilter();
    if (results) results.hidden = true;
  },

  /** Fill the case <select> from loaded cases (#caseName values). */
  _populateSearchCaseFilter() {
    const sel = document.getElementById('searchCaseFilter');
    if (!sel) return;
    const cases = Array.isArray(this.cases) ? this.cases : [];
    const names = Array.from(new Set(cases.map((c) => c && c.name).filter(Boolean))).sort();
    const current = sel.value;
    // Rebuild options (keep the "All cases" placeholder).
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All cases';
    sel.appendChild(all);
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = '#' + name;
      sel.appendChild(opt);
    }
    if (current && names.includes(current)) sel.value = current;
  },

  /** Debounced trigger from the input event. */
  _scheduleSearch() {
    clearTimeout(this._searchDebounceTimer);
    this._searchDebounceTimer = setTimeout(() => this._runSearch(), window.CodemanSearch.SEARCH_DEBOUNCE_MS);
  },

  _clearSearch() {
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.hidden = true;
    this._searchLastData = null;
    this._renderSearch(null);
  },

  /** Execute the federated search request and render the result. */
  async _runSearch() {
    const input = document.getElementById('searchInput');
    if (!input) return;
    const q = input.value.trim();
    if (q.length === 0) {
      this._searchLastData = null;
      this._renderSearch(null);
      return;
    }

    const types = Array.from(this._searchTypes);
    const params = new URLSearchParams();
    params.set('q', q.slice(0, 200));
    if (types.length > 0 && types.length < 3) params.set('types', types.join(','));
    params.set('limit', String(window.CodemanSearch.SEARCH_LIMIT));

    const seq = ++this._searchSeq;
    const data = await this._apiJson('/api/search?' + params.toString());
    // Drop stale responses (a newer query already fired).
    if (seq !== this._searchSeq) return;

    if (!data) {
      // null = request error or 400 (bad input). Show an empty/error state.
      this._searchLastData = { query: q, groups: [], totalResults: 0, truncated: false, _error: true };
    } else {
      this._searchLastData = data;
    }
    this._renderSearch(this._searchLastData);
  },

  /**
   * Apply client-side secondary filters (case / status / date) to a group's
   * results. Type filtering already happened server-side via types=.
   */
  _applySecondaryFilters(results) {
    const { caseLabel, status, days } = this._searchSecondary;
    let out = results;
    if (caseLabel) {
      const want = '#' + caseLabel;
      out = out.filter((r) => (r.sessionName || '').includes(want) || r.sessionName === caseLabel);
    }
    if (status) {
      const activeIds = new Set((this.sessionOrder || []).concat(Object.keys(this.sessions || {})));
      out = out.filter((r) => {
        const isActive = activeIds.has(r.sessionId);
        return status === 'active' ? isActive : !isActive;
      });
    }
    if (days) {
      const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
      out = out.filter((r) => Number.isFinite(r.timestamp) && r.timestamp >= cutoff);
    }
    return out;
  },

  /** Render the grouped result cards (or empty/loading states). */
  _renderSearch(data) {
    const results = document.getElementById('searchResults');
    // The header carries the title plus the filter/sort controls (issue #260),
    // hide the whole row, not just the title, or the controls float above the
    // search results and act on a list that is not on screen.
    const historyHeader = document.getElementById('historyHeader') || document.getElementById('historyTitle');
    const historyList = document.getElementById('historyList');
    if (!results) return;

    const searching = !!data;
    // Hide the plain "Resume Conversation" history list while a search is active.
    if (historyHeader) historyHeader.style.display = searching ? 'none' : '';
    if (historyList) historyList.style.display = searching ? 'none' : '';

    results.innerHTML = '';
    if (!data) {
      results.hidden = true;
      return;
    }
    results.hidden = false;

    if (data._error) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = 'Search unavailable — check the query and try again.';
      results.appendChild(empty);
      return;
    }

    // Apply secondary (client-side) filters and recompute shown total.
    const groups = (data.groups || [])
      .map((g) => ({ type: g.type, results: this._applySecondaryFilters(g.results || []) }))
      .filter((g) => g.results.length > 0);

    const shownTotal = groups.reduce((n, g) => n + g.results.length, 0);

    if (shownTotal === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = 'No results for "' + (data.query || '') + '"';
      results.appendChild(empty);
      return;
    }

    for (const group of groups) {
      const header = document.createElement('div');
      header.className = 'search-group-header';
      const label = document.createElement('span');
      label.className = 'search-group-label';
      label.textContent = window.CodemanSearch.SOURCE_LABELS[group.type] || group.type;
      const count = document.createElement('span');
      count.className = 'search-group-count';
      count.textContent = String(group.results.length);
      header.append(label, count);
      results.appendChild(header);

      for (const r of group.results) {
        results.appendChild(this._buildSearchResultCard(r));
      }
    }

    if (data.truncated) {
      const trunc = document.createElement('div');
      trunc.className = 'search-truncated';
      trunc.textContent = 'Showing the top matches — refine your search to narrow results.';
      results.appendChild(trunc);
    }
  },

  /** Build a single result card DOM node wired to its jump-to action. */
  _buildSearchResultCard(r) {
    const card = document.createElement('div');
    card.className = 'search-result-card';
    card.dataset.type = r.type;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const topRow = document.createElement('div');
    topRow.className = 'search-result-top';

    // A past session resumes rather than switches tabs, so it says so on the badge.
    const isPast = r.jumpTo && r.jumpTo.kind === 'resume-session';
    const badge = document.createElement('span');
    badge.className = 'search-result-badge search-badge-' + r.type + (isPast ? ' search-badge-past' : '');
    badge.textContent = isPast ? 'Resume' : (window.CodemanSearch.SOURCE_LABELS[r.type] || r.type).replace(/s$/, '');

    const name = document.createElement('span');
    name.className = 'search-result-name';
    name.textContent = r.sessionName || r.sessionId || '(session)';

    const time = document.createElement('span');
    time.className = 'search-result-time';
    time.textContent = window.CodemanSearch.formatSearchTime(r.timestamp);

    topRow.append(badge, name, time);

    const snippet = document.createElement('div');
    snippet.className = 'search-result-snippet';
    snippet.textContent = r.snippet || '';

    card.append(topRow, snippet);

    const jump = () => this._jumpToSearchResult(r);
    card.addEventListener('click', jump);
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        jump();
      }
    });

    return card;
  },

  /**
   * Navigate to a search result by jumpTo.kind, reusing the existing app methods:
   *   session       → selectSession(sessionId)      (open/switch to the session)
   *   resume-session→ resumeHistorySession(...)     (past session, no tab to switch to)
   *   run-summary   → openRunSummary(sessionId)     (session options → summary tab)
   *   file-preview  → openFilePreview(path, sessionId, attachmentId)
   */
  _jumpToSearchResult(r) {
    const jt = r && r.jumpTo;
    if (!jt) return;
    // A past session has to be replayed, not switched to. Do it BEFORE hiding the
    // welcome overlay: resumeHistorySession() owns that transition itself.
    if (jt.kind === 'resume-session') {
      this.resumeHistorySession(jt.claudeSessionId || jt.sessionId, jt.workingDir || '', r.sessionName);
      return;
    }
    // Leaving the welcome overlay so the target surface is visible.
    if (typeof this.hideWelcome === 'function') this.hideWelcome();

    try {
      if (jt.kind === 'run-summary') {
        this.openRunSummary(jt.sessionId);
      } else if (jt.kind === 'file-preview') {
        this.openFilePreview(jt.relativePath || '', jt.sessionId, jt.targetId || null);
      } else {
        // 'session' (default)
        this.selectSession(jt.sessionId);
      }
    } catch (err) {
      console.error('[search] jump failed', err);
    }
  },
});
