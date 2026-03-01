// Codeman App - Tab-based Terminal UI
// Constants, utilities, and escapeHtml() are in constants.js (loaded before this file)
// MobileDetection, KeyboardHandler, SwipeHandler are in mobile-handlers.js
// DeepgramProvider, VoiceInput are in voice-input.js




class CodemanApp {
  constructor() {
    this.sessions = new Map();
    this.sessionOrder = []; // Track tab order for drag-and-drop reordering
    this.draggedTabId = null; // Currently dragged tab session ID
    this.cases = [];
    this.currentRun = null;
    this.totalTokens = 0;
    this.globalStats = null; // Global token/cost stats across all sessions
    this.eventSource = null;
    this.terminal = null;
    this.fitAddon = null;
    this.activeSessionId = null;
    this._initGeneration = 0;     // dedup concurrent handleInit calls
    this._initFallbackTimer = null; // fallback timer if SSE init doesn't arrive
    this._selectGeneration = 0;   // cancel stale selectSession loads
    this.respawnStatus = {};
    this.respawnTimers = {}; // Track timed respawn timers
    this.respawnCountdownTimers = {}; // { sessionId: { timerName: { endsAt, totalMs, reason } } }
    this.respawnActionLogs = {};      // { sessionId: [action, action, ...] } (max 20)
    this.timerCountdownInterval = null; // Interval for updating countdown display
    this.terminalBuffers = new Map(); // Store terminal content per session
    this.editingSessionId = null; // Session being edited in options modal
    this.pendingCloseSessionId = null; // Session pending close confirmation
    this.muxSessions = []; // Screen sessions for process monitor

    // Ralph loop/todo state per session
    this.ralphStates = new Map(); // Map<sessionId, { loop, todos }>

    // Subagent (Claude Code background agent) tracking
    this.subagents = new Map(); // Map<agentId, SubagentInfo>
    this.subagentActivity = new Map(); // Map<agentId, activity[]> - recent tool calls/progress
    this.subagentToolResults = new Map(); // Map<agentId, Map<toolUseId, result>> - tool results by toolUseId
    this.activeSubagentId = null; // Currently selected subagent for detail view
    this.subagentPanelVisible = false;
    this.subagentWindows = new Map(); // Map<agentId, { element, position }>
    this.subagentWindowZIndex = ZINDEX_SUBAGENT_BASE;
    this.minimizedSubagents = new Map(); // Map<sessionId, Set<agentId>> - minimized to tab
    this._subagentHideTimeout = null; // Timeout for hover-based dropdown hide

    // PERSISTENT parent associations - agentId -> sessionId
    // This is the SINGLE SOURCE OF TRUTH for which tab an agent window connects to.
    // Once set, never recalculated. Persisted to localStorage and server.
    this.subagentParentMap = new Map();

    // Agent Teams tracking
    this.teams = new Map(); // Map<teamName, TeamConfig>
    this.teamTasks = new Map(); // Map<teamName, TeamTask[]>
    this.teammateMap = new Map(); // Map<agentId-prefix, {name, color, teamName}> for quick lookup

    // Teammate tmux pane terminals (Agent Teams feature)
    this.teammatePanesByName = new Map(); // Map<name, { paneTarget, sessionId, color }>
    this.teammateTerminals = new Map(); // Map<agentId, { terminal, fitAddon, paneTarget, sessionId, resizeObserver }>

    this.terminalBufferCache = new Map(); // Map<sessionId, string> — client-side cache for instant tab re-visits (max 20)

    this.ralphStatePanelCollapsed = true; // Default to collapsed
    this.ralphClosedSessions = new Set(); // Sessions where user explicitly closed Ralph panel

    // Plan subagent windows (visible agents during plan generation)
    this.planSubagents = new Map(); // Map<agentId, { type, model, status, startTime, element, relativePos }>
    this.planSubagentWindowZIndex = ZINDEX_PLAN_SUBAGENT_BASE;
    this.planGenerationStopped = false; // Flag to ignore SSE events after Stop
    this.planAgentsMinimized = false; // Whether agent windows are minimized to tab

    // Wizard dragging state
    this.wizardDragState = null; // { startX, startY, startLeft, startTop, isDragging }
    this.wizardDragListeners = null; // { move, up } for cleanup
    this.wizardPosition = null; // { left, top } - null means centered

    // Project Insights tracking (active Bash tools with clickable file paths)
    this.projectInsights = new Map(); // Map<sessionId, ActiveBashTool[]>
    this.logViewerWindows = new Map(); // Map<windowId, { element, eventSource, filePath }>
    this.logViewerWindowZIndex = ZINDEX_LOG_VIEWER_BASE;
    this.projectInsightsPanelVisible = false;
    this.currentSessionWorkingDir = null; // Track current session's working dir for path normalization

    // Image popup windows (auto-open for detected screenshots/images)
    this.imagePopups = new Map(); // Map<imageId, { element, sessionId, filePath }>
    this.imagePopupZIndex = ZINDEX_IMAGE_POPUP_BASE;

    // Tab alert states: Map<sessionId, 'action' | 'idle'>
    this.tabAlerts = new Map();

    // Pending hooks per session: Map<sessionId, Set<hookType>>
    // Tracks pending hook events that need resolution (permission_prompt, elicitation_dialog, idle_prompt)
    this.pendingHooks = new Map();

    // Terminal write batching with DEC 2026 sync support
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._wasAtBottomBeforeWrite = true; // Default to true for sticky scroll
    this.syncWaitTimeout = null; // Timeout for incomplete sync blocks
    this._isLoadingBuffer = false; // true during chunkedTerminalWrite — blocks live SSE writes
    this._loadBufferQueue = null;  // queued SSE events during buffer load

    // Flicker filter state (buffers output after screen clears)
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    this.flickerFilterTimeout = null;

    // Render debouncing
    this.renderSessionTabsTimeout = null;
    this.renderRalphStatePanelTimeout = null;
    this.renderTaskPanelTimeout = null;
    this.renderMuxSessionsTimeout = null;

    // System stats polling
    this.systemStatsInterval = null;

    // SSE reconnect timeout (to prevent orphaned timeouts)
    this.sseReconnectTimeout = null;

    // SSE event listener cleanup function (to prevent listener accumulation on reconnect)
    this._sseListenerCleanup = null;

    // SSE connection status tracking
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.isOnline = navigator.onLine;

    // Offline input queue
    this._inputQueue = new Map(); // Map<sessionId, string>
    this._inputQueueMaxBytes = 64 * 1024; // 64KB cap per session
    this._connectionStatus = 'connected';

    // Sequential input send chain — ensures keystroke ordering across async fetches
    this._inputSendChain = Promise.resolve();

    // Local echo overlay — DOM overlay positioned at the visible ❯ prompt
    // (not at buffer.cursorY, which reflects Ink's internal cursor position)
    this._localEchoOverlay = null;  // created after terminal.open()
    this._localEchoEnabled = false; // true when setting on + session active
    this._restoringFlushedState = false; // true during selectSession buffer load — protects flushed Maps

    // Accessibility: Focus trap for modals
    this.activeFocusTrap = null;

    // Notification system
    this.notificationManager = new NotificationManager(this);
    this.idleTimers = new Map(); // Map<sessionId, timeout> for stuck detection

    // DOM element cache for performance (avoid repeated getElementById calls)
    this._elemCache = {};

    this.init();
  }

  // Cached element getter - avoids repeated DOM queries
  $(id) {
    if (!this._elemCache[id]) {
      this._elemCache[id] = document.getElementById(id);
    }
    return this._elemCache[id];
  }

  // Format token count: 1000k -> 1m, 1450k -> 1.45m, 500 -> 500
  formatTokens(count) {
    if (count >= 1000000) {
      const m = count / 1000000;
      return m >= 10 ? `${m.toFixed(1)}m` : `${m.toFixed(2)}m`;
    } else if (count >= 1000) {
      const k = count / 1000;
      return k >= 100 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
    }
    return String(count);
  }

  // Estimate cost from tokens using Claude Opus pricing
  // Input: $15/M tokens, Output: $75/M tokens
  estimateCost(inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1000000) * 15;
    const outputCost = (outputTokens / 1000000) * 75;
    return inputCost + outputCost;
  }

  // ========== Pending Hooks State Machine ==========
  // Track pending hook events per session to determine tab alerts.
  // Action hooks (permission_prompt, elicitation_dialog) take priority over idle_prompt.

  setPendingHook(sessionId, hookType) {
    if (!this.pendingHooks.has(sessionId)) {
      this.pendingHooks.set(sessionId, new Set());
    }
    this.pendingHooks.get(sessionId).add(hookType);
    this.updateTabAlertFromHooks(sessionId);
  }

  clearPendingHooks(sessionId, hookType = null) {
    const hooks = this.pendingHooks.get(sessionId);
    if (!hooks) return;
    if (hookType) {
      hooks.delete(hookType);
    } else {
      hooks.clear();
    }
    if (hooks.size === 0) {
      this.pendingHooks.delete(sessionId);
    }
    this.updateTabAlertFromHooks(sessionId);
  }

  updateTabAlertFromHooks(sessionId) {
    const hooks = this.pendingHooks.get(sessionId);
    if (!hooks || hooks.size === 0) {
      this.tabAlerts.delete(sessionId);
    } else if (hooks.has('permission_prompt') || hooks.has('elicitation_dialog')) {
      this.tabAlerts.set(sessionId, 'action');
    } else if (hooks.has('idle_prompt')) {
      this.tabAlerts.set(sessionId, 'idle');
    }
    this.renderSessionTabs();
  }

  init() {
    // Initialize mobile detection first (adds device classes to body)
    MobileDetection.init();
    // Initialize mobile handlers
    KeyboardHandler.init();
    SwipeHandler.init();
    VoiceInput.init();
    KeyboardAccessoryBar.init();
    this.applyHeaderVisibilitySettings();
    this.applyTabWrapSettings();
    this.applyMonitorVisibility();
    // Remove mobile-init class now that JS has applied visibility settings.
    // The inline <script> in <head> added this to prevent flash-of-content on mobile.
    document.documentElement.classList.remove('mobile-init');
    // Defer heavy terminal canvas creation to next frame — lets browser paint header/skeleton first.
    // IMPORTANT: connectSSE must run AFTER initTerminal to prevent a race where SSE data
    // arrives before the terminal exists, orphaning data in pendingWrites and corrupting
    // escape sequence boundaries when later concatenated with fresh data.
    requestAnimationFrame(() => {
      this.initTerminal();
      this.loadFontSize();
      this.connectSSE();
      // Only fetch state if SSE init event hasn't arrived within 3s (avoids duplicate handleInit)
      this._initFallbackTimer = setTimeout(() => {
        if (this._initGeneration === 0) this.loadState();
      }, 3000);
    });
    // Register service worker for push notifications
    this.registerServiceWorker();
    // Share a single settings fetch between both consumers
    const settingsPromise = fetch('/api/settings').then(r => r.ok ? r.json() : null).catch(() => null);
    this.loadQuickStartCases(null, settingsPromise);
    this._initRunMode();
    this.setupEventListeners();
    // Mobile: ensure button taps register even when keyboard is visible.
    // On mobile, tapping a button while the soft keyboard is up causes the
    // browser to dismiss the keyboard first (blur event), swallowing the tap.
    // The button only receives the click on a second tap. Fix: intercept
    // touchstart on buttons while keyboard is visible, preventDefault to stop
    // the dismiss-swallows-tap behavior, and trigger the click programmatically.
    if (MobileDetection.isTouchDevice()) {
      const addKeyboardTapFix = (container) => {
        if (!container) return;
        container.addEventListener('touchstart', (e) => {
          if (!KeyboardHandler.keyboardVisible) return;
          const btn = e.target.closest('button');
          if (!btn) return;
          e.preventDefault();
          btn.click();
          // Refocus terminal so keyboard stays open (e.g. voice input button)
          if (typeof app !== 'undefined' && app.terminal) {
            app.terminal.focus();
          }
        }, { passive: false });
      };
      addKeyboardTapFix(document.querySelector('.toolbar'));
      addKeyboardTapFix(document.querySelector('.welcome-overlay'));
    }
    // System stats polling deferred until sessions exist (started in handleInit/session:created)
    // Setup online/offline detection
    this.setupOnlineDetection();
    // Load server-stored settings (async, re-applies visibility after load)
    this.loadAppSettingsFromServer(settingsPromise).then(() => {
      this.applyHeaderVisibilitySettings();
      this.applyTabWrapSettings();
      this.applyMonitorVisibility();
    });
    // Hide loading skeleton now that the app shell is ready
    document.body.classList.add('app-loaded');
  }

  initTerminal() {
    // Load scrollback setting from localStorage (default 5000)
    const scrollback = parseInt(localStorage.getItem('codeman-scrollback')) || DEFAULT_SCROLLBACK;

    this.terminal = new Terminal({
      theme: {
        background: '#0d0d0d',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        cursorAccent: '#0d0d0d',
        selection: 'rgba(255, 255, 255, 0.3)',
        black: '#0d0d0d',
        red: '#ff6b6b',
        green: '#51cf66',
        yellow: '#ffd43b',
        blue: '#339af0',
        magenta: '#cc5de8',
        cyan: '#22b8cf',
        white: '#e0e0e0',
        brightBlack: '#495057',
        brightRed: '#ff8787',
        brightGreen: '#69db7c',
        brightYellow: '#ffe066',
        brightBlue: '#5c7cfa',
        brightMagenta: '#da77f2',
        brightCyan: '#66d9e8',
        brightWhite: '#ffffff',
      },
      fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
      // Use smaller font on mobile to fit more columns (prevents wrapping of Claude's status line)
      fontSize: MobileDetection.getDeviceType() === 'mobile' ? 10 : 14,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: scrollback,
      allowTransparency: true,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    if (typeof Unicode11Addon !== 'undefined') {
      try {
        const unicode11Addon = new Unicode11Addon.Unicode11Addon();
        this.terminal.loadAddon(unicode11Addon);
        this.terminal.unicode.activeVersion = '11';
      } catch (_e) { /* Unicode11 addon failed — default Unicode handling used */ }
    }

    const container = document.getElementById('terminalContainer');
    this.terminal.open(container);

    // Activate WebGL renderer for up to 900% faster rendering (fallback to canvas on failure)
    if (typeof WebglAddon !== 'undefined') {
      try {
        const webglAddon = new WebglAddon.WebglAddon();
        webglAddon.onContextLoss(() => { webglAddon.dispose(); });
        this.terminal.loadAddon(webglAddon);
      } catch (_e) { /* WebGL2 unavailable — canvas renderer used */ }
    }

    this._localEchoOverlay = new LocalEchoOverlay(this.terminal);

    // On mobile Safari, delay initial fit() to allow layout to settle
    // This prevents 0-column terminals caused by fit() running before container is sized
    const isMobileSafari = MobileDetection.getDeviceType() === 'mobile' &&
                           document.body.classList.contains('safari-browser');
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

    // Always use mouse wheel for terminal scrollback, never forward to application.
    // Prevents Claude's Ink UI (plan mode selector) from capturing scroll as option navigation.
    container.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const lines = Math.round(ev.deltaY / 25) || (ev.deltaY > 0 ? 1 : -1);
      this.terminal.scrollLines(lines);
    }, { passive: false });

    // Touch scrolling - only use custom JS scrolling on desktop
    // Mobile uses native browser scrolling via CSS touch-action: pan-y
    const isMobileDevice = MobileDetection.isTouchDevice() && window.innerWidth < 1024;

    if (!isMobileDevice) {
      // Desktop touch scrolling with custom momentum
      let touchLastY = 0;
      let pendingDelta = 0;
      let velocity = 0;
      let lastTime = 0;
      let scrollFrame = null;
      let isTouching = false;

      const viewport = container.querySelector('.xterm-viewport');

      // Single RAF loop handles both touch and momentum
      const scrollLoop = (timestamp) => {
        if (!viewport) return;

        const dt = lastTime ? (timestamp - lastTime) / 16.67 : 1; // Normalize to 60fps
        lastTime = timestamp;

        if (isTouching) {
          // During touch: apply pending delta
          if (pendingDelta !== 0) {
            viewport.scrollTop += pendingDelta;
            pendingDelta = 0;
          }
          scrollFrame = requestAnimationFrame(scrollLoop);
        } else if (Math.abs(velocity) > 0.1) {
          // Momentum phase
          viewport.scrollTop += velocity * dt;
          velocity *= 0.94; // Smooth deceleration
          scrollFrame = requestAnimationFrame(scrollLoop);
        } else {
          scrollFrame = null;
          velocity = 0;
        }
      };

      container.addEventListener('touchstart', (ev) => {
        if (ev.touches.length === 1) {
          touchLastY = ev.touches[0].clientY;
          pendingDelta = 0;
          velocity = 0;
          isTouching = true;
          lastTime = 0;
          if (!scrollFrame) {
            scrollFrame = requestAnimationFrame(scrollLoop);
          }
        }
      }, { passive: true });

      container.addEventListener('touchmove', (ev) => {
        if (ev.touches.length === 1 && isTouching) {
          const touchY = ev.touches[0].clientY;
          const delta = touchLastY - touchY;
          pendingDelta += delta;
          velocity = delta * 1.2; // Track for momentum
          touchLastY = touchY;
        }
      }, { passive: true });

      container.addEventListener('touchend', () => {
        isTouching = false;
        // Momentum continues in scrollLoop
      }, { passive: true });

      container.addEventListener('touchcancel', () => {
        isTouching = false;
        velocity = 0;
      }, { passive: true });
    }
    // Mobile: native scrolling handles touch via CSS

    // Welcome message
    this.showWelcome();

    // Handle resize with throttling for performance
    this._resizeTimeout = null;
    this._lastResizeDims = null;

    // Minimum terminal dimensions to prevent vertical text wrapping
    const MIN_COLS = 40;
    const MIN_ROWS = 10;

    const throttledResize = () => {
      if (this._resizeTimeout) return;
      this._resizeTimeout = setTimeout(() => {
        this._resizeTimeout = null;
        if (this.fitAddon) {
          this.fitAddon.fit();
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
            if (!this._lastResizeDims ||
                cols !== this._lastResizeDims.cols ||
                rows !== this._lastResizeDims.rows) {
              this._lastResizeDims = { cols, rows };
              fetch(`/api/sessions/${this.activeSessionId}/resize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cols, rows })
              }).catch(() => {});
            }
          }
        }
        // Update subagent connection lines when viewport resizes
        this.updateConnectionLines();
        // Re-render local echo overlay at new cell dimensions/positions
        if (this._localEchoOverlay?.hasPending) {
          this._localEchoOverlay.rerender();
        }
      }, 100); // Throttle to 100ms
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
      if (this.activeSessionId) {
        // Filter out terminal query responses that xterm.js generates automatically.
        // These are responses to DA (Device Attributes), DSR (Device Status Report), etc.
        // sent by tmux when attaching. Without this filter, they appear as typed text.
        // Patterns: \x1b[?...c (DA1), \x1b[>...c (DA2), \x1b[...R (CPR), \x1b[...n (DSR)
        if (/^\x1b\[[\?>=]?[\d;]*[cnR]$/.test(data)) return;

        // ── Local Echo Mode ──
        // When enabled, keystrokes are buffered locally in the overlay for
        // instant visual feedback.  Nothing is sent to the PTY until Enter
        // (or a control char) is pressed — avoids out-of-order char delivery.
        if (this._localEchoEnabled) {
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
            }
            // 'pending' = removed unsent text (no PTY backspace needed)
            // false = nothing to remove (swallow the backspace)
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
                  if (line) baseText = line.translateToString(true).slice(p.col + 2).trimEnd();
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
                if (!selfTab._tabCompletionSessionId || selfTab._tabCompletionSessionId !== selfTab.activeSessionId) return;
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
  }

  /**
   * Register a custom link provider for xterm.js that detects file paths
   * in terminal output and makes them clickable.
   * When clicked, opens a floating log viewer window with live streaming.
   */
  registerFilePathLinkProvider() {
    const self = this;

    // Debug: Track if provider is being invoked
    let lastInvokedLine = -1;

    this.terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        // Debug logging - only log if line changed to avoid spam
        if (bufferLineNumber !== lastInvokedLine) {
          lastInvokedLine = bufferLineNumber;
          console.debug('[LinkProvider] Checking line:', bufferLineNumber);
        }

        const buffer = self.terminal.buffer.active;
        const line = buffer.getLine(bufferLineNumber);

        if (!line) {
          callback(undefined);
          return;
        }

        // Get line text - translateToString handles wrapped lines
        const lineText = line.translateToString(true);

        if (!lineText || !lineText.includes('/')) {
          callback(undefined);
          return;
        }

        const links = [];

        // Pattern 1: Commands with file paths (tail -f, cat, head, grep pattern, etc.)
        // Handles: tail -f /path, grep pattern /path, cat -n /path
        const cmdPattern = /(tail|cat|head|less|grep|watch|vim|nano)\s+(?:[^\s\/]*\s+)*(\/[^\s"'<>|;&\n\x00-\x1f]+)/g;

        // Pattern 2: Paths with common extensions
        const extPattern = /(\/(?:home|tmp|var|etc|opt)[^\s"'<>|;&\n\x00-\x1f]*\.(?:log|txt|json|md|yaml|yml|csv|xml|sh|py|ts|js))\b/g;

        // Pattern 3: Bash() tool output
        const bashPattern = /Bash\([^)]*?(\/(?:home|tmp|var|etc|opt)[^\s"'<>|;&\)\n\x00-\x1f]+)/g;

        const addLink = (filePath, matchIndex) => {
          const startCol = lineText.indexOf(filePath, matchIndex);
          if (startCol === -1) return;

          // Skip if already have link at this position
          if (links.some(l => l.range.start.x === startCol + 1)) return;

          links.push({
            text: filePath,
            range: {
              start: { x: startCol + 1, y: bufferLineNumber },      // 1-based
              end: { x: startCol + filePath.length + 1, y: bufferLineNumber }
            },
            decorations: {
              pointerCursor: true,
              underline: true
            },
            activate(event, text) {
              self.openLogViewerWindow(text, self.activeSessionId);
            }
          });
        };

        // Match all patterns
        let match;

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
          console.debug('[LinkProvider] Found links:', links.map(l => l.text));
        }
        callback(links.length > 0 ? links : undefined);
      }
    });

    console.log('[LinkProvider] File path link provider registered');
  }

  showWelcome() {
    const overlay = document.getElementById('welcomeOverlay');
    if (overlay) {
      overlay.classList.add('visible');
      this.loadTunnelStatus();
    }
  }

  hideWelcome() {
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
  }

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
  }

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

    // Always buffer Ink's cursor-up redraws regardless of flicker filter setting.
    // Ink's status bar updates use cursor-up + erase-line + rewrite, which can split
    // across render frames causing old/new status text to overlap (garbled output).
    // Buffering for 50ms ensures the full redraw arrives atomically.
    const hasCursorUpRedraw = /\x1b\[\d{1,2}A/.test(data);
    if (hasCursorUpRedraw || (this.flickerFilterActive && !flickerFilterEnabled)) {
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

    // Opt-in flicker filter: also buffer screen clear patterns
    if (flickerFilterEnabled) {
      const hasScreenClear = data.includes('\x1b[2J') ||
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

    if (!this.writeFrameScheduled) {
      this.writeFrameScheduled = true;
      requestAnimationFrame(() => {
        if (this.pendingWrites.length > 0 && this.terminal) {
          // Join chunks for sync marker detection
          const pending = this.pendingWrites.join('');
          // Check if we have an incomplete sync block (SYNC_START without SYNC_END)
          const hasStart = pending.includes(DEC_SYNC_START);
          const hasEnd = pending.includes(DEC_SYNC_END);

          if (hasStart && !hasEnd) {
            // Incomplete sync block - wait for more data (up to 50ms max)
            if (!this.syncWaitTimeout) {
              this.syncWaitTimeout = setTimeout(() => {
                this.syncWaitTimeout = null;
                // Force flush after timeout to prevent stuck state
                this.flushPendingWrites();
              }, 50);
            }
            this.writeFrameScheduled = false;
            return;
          }

          // Clear any pending sync wait timeout
          if (this.syncWaitTimeout) {
            clearTimeout(this.syncWaitTimeout);
            this.syncWaitTimeout = null;
          }

          this.flushPendingWrites();
        }
        this.writeFrameScheduled = false;
      });
    }
  }

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
    if (!this.writeFrameScheduled) {
      this.writeFrameScheduled = true;
      requestAnimationFrame(() => {
        this.flushPendingWrites();
        this.writeFrameScheduled = false;
      });
    }
  }

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
              } catch { return null; }
            }
          });
        } else {
          // Claude Code: scan for ❯ prompt character
          this._localEchoOverlay.setPrompt({ type: 'character', char: '\u276f', offset: 2 });
        }
      }
  }

  /**
   * Flush pending writes to terminal, processing DEC 2026 sync markers.
   * Strips markers and writes content atomically within a single frame.
   */
  flushPendingWrites() {
    if (this.pendingWrites.length === 0 || !this.terminal) return;

    // Extract segments, stripping DEC 2026 markers
    // This implements synchronized output for xterm.js which doesn't support DEC 2026 natively
    const segments = extractSyncSegments(this.pendingWrites.join(''));
    this.pendingWrites = [];

    // Write all segments in a single batch (atomic within this frame)
    // xterm.js internally batches multiple write() calls within same frame
    // Never discard content from incomplete sync blocks — xterm.js doesn't support
    // DEC 2026 natively anyway, so strip the marker and write content regardless.
    // Discarding causes real data loss (including Ink's erase-line escapes).
    for (const segment of segments) {
      if (segment) {
        const content = segment.startsWith(DEC_SYNC_START)
          ? segment.slice(DEC_SYNC_START.length)
          : segment;
        if (content) this.terminal.write(content);
      }
    }

    // Sticky scroll: if user was at bottom, keep them there after new output
    if (this._wasAtBottomBeforeWrite) {
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
    if (this._tabCompletionSessionId && this._tabCompletionSessionId === this.activeSessionId
        && this._localEchoOverlay && !this._localEchoOverlay.pendingText) {
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
            if (self._tabCompletionFallback) { clearTimeout(self._tabCompletionFallback); self._tabCompletionFallback = null; }
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
  }

  /**
   * Write large buffer to terminal in chunks to avoid UI jank.
   * Uses requestAnimationFrame to spread work across frames.
   * @param {string} buffer - The full terminal buffer to write
   * @param {number} chunkSize - Size of each chunk (default 128KB for smooth 60fps)
   * @returns {Promise<void>} - Resolves when all chunks written
   */
  chunkedTerminalWrite(buffer, chunkSize = TERMINAL_CHUNK_SIZE) {
    return new Promise((resolve) => {
      if (!buffer || buffer.length === 0) {
        this._finishBufferLoad();
        resolve();
        return;
      }

      // Block live SSE writes during buffer load to prevent interleaving
      this._isLoadingBuffer = true;
      this._loadBufferQueue = [];

      // Strip any DEC 2026 markers that might be in the buffer
      // (from historical SSE data that was stored with markers)
      const cleanBuffer = buffer.replace(DEC_SYNC_STRIP_RE, '');

      const finish = () => {
        this._finishBufferLoad();
        resolve();
      };

      // For small buffers, write directly
      if (cleanBuffer.length <= chunkSize) {
        this.terminal.write(cleanBuffer);
        finish();
        return;
      }

      let offset = 0;
      const writeChunk = () => {
        if (offset >= cleanBuffer.length) {
          // Wait one more frame for xterm to finish rendering before resolving
          requestAnimationFrame(finish);
          return;
        }

        const chunk = cleanBuffer.slice(offset, offset + chunkSize);
        this.terminal.write(chunk);
        offset += chunkSize;

        // Schedule next chunk on next frame
        requestAnimationFrame(writeChunk);
      };

      // Start writing
      requestAnimationFrame(writeChunk);
    });
  }

  /**
   * Complete a buffer load: unblock live SSE writes and flush any queued events.
   * Called when chunkedTerminalWrite finishes (or is skipped for empty buffers).
   */
  _finishBufferLoad() {
    const queue = this._loadBufferQueue;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    if (queue && queue.length > 0) {
      for (const data of queue) {
        this.batchTerminalWrite(data);
      }
    }
  }

  setupEventListeners() {
    // Use capture to handle before terminal
    document.addEventListener('keydown', (e) => {
      // Escape - close panels and modals
      if (e.key === 'Escape') {
        this.closeAllPanels();
        this.closeHelp();
      }

      // Ctrl/Cmd + ? - help
      if ((e.ctrlKey || e.metaKey) && (e.key === '?' || e.key === '/')) {
        e.preventDefault();
        this.showHelp();
      }

      // Ctrl/Cmd + Enter - quick start
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.quickStart();
      }

      // Ctrl/Cmd + W - close active session
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        this.killActiveSession();
      }

      // Ctrl/Cmd + Tab - next session
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault();
        this.nextSession();
      }

      // Ctrl/Cmd + K - kill all
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.killAllSessions();
      }

      // Ctrl/Cmd + L - clear terminal
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        this.clearTerminal();
      }

      // Ctrl/Cmd + Shift + R - restore terminal size (after mobile squeeze)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        this.restoreTerminalSize();
      }

      // Ctrl/Cmd + +/- - font size
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        this.increaseFontSize();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        this.decreaseFontSize();
      }

      // Ctrl/Cmd + Shift + V - toggle voice input
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
        e.preventDefault();
        VoiceInput.toggle();
      }
    }, true); // Use capture phase to handle before terminal

    // Token stats click handler (with guard to prevent duplicate handlers on reconnect)
    const tokenEl = this.$('headerTokens');
    if (tokenEl && !tokenEl._statsHandlerAttached) {
      tokenEl.classList.add('clickable');
      tokenEl._statsHandlerAttached = true;
      tokenEl.addEventListener('click', () => this.openTokenStats());
    }

    // Color picker for session customization
    this.setupColorPicker();
  }

  // ========== SSE Connection ==========

  connectSSE() {
    // Check if browser is offline
    if (!navigator.onLine) {
      this.setConnectionStatus('offline');
      return;
    }

    // Clear any pending reconnect timeout to prevent duplicate connections
    if (this.sseReconnectTimeout) {
      clearTimeout(this.sseReconnectTimeout);
      this.sseReconnectTimeout = null;
    }

    // Clean up existing SSE listeners before creating new connection (prevents listener accumulation)
    if (this._sseListenerCleanup) {
      this._sseListenerCleanup();
      this._sseListenerCleanup = null;
    }

    // Close existing EventSource before creating new one to prevent duplicate connections
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    // Show connecting state
    if (this.reconnectAttempts === 0) {
      this.setConnectionStatus('connecting');
    } else {
      this.setConnectionStatus('reconnecting');
    }

    this.eventSource = new EventSource('/api/events');

    // Store all event listeners for cleanup on reconnect
    const listeners = [];
    const addListener = (event, handler) => {
      this.eventSource.addEventListener(event, handler);
      listeners.push({ event, handler });
    };

    // Create cleanup function to remove all listeners
    this._sseListenerCleanup = () => {
      for (const { event, handler } of listeners) {
        if (this.eventSource) {
          this.eventSource.removeEventListener(event, handler);
        }
      }
      listeners.length = 0;
    };

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this.setConnectionStatus('connected');
    };
    this.eventSource.onerror = () => {
      this.reconnectAttempts++;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.setConnectionStatus('disconnected');
      } else {
        this.setConnectionStatus('reconnecting');
      }
      // Close the failed connection before scheduling reconnect
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      // Clear any existing reconnect timeout before setting new one (prevents orphaned timeouts)
      if (this.sseReconnectTimeout) {
        clearTimeout(this.sseReconnectTimeout);
      }
      // Exponential backoff: 200ms, 500ms, 1s, 2s, 4s, ... up to 30s
      // Fast first retry (200ms) for server-restart case (COM deploy),
      // then ramp up for real network issues.
      const delay = this.reconnectAttempts <= 1 ? 200
        : Math.min(500 * Math.pow(2, this.reconnectAttempts - 2), 30000);
      this.sseReconnectTimeout = setTimeout(() => this.connectSSE(), delay);
    };

    addListener('init', (e) => {
      try {
        this.handleInit(JSON.parse(e.data));
      } catch (err) {
        console.error('[SSE] Failed to parse init event:', err);
      }
    });

    addListener('session:created', (e) => {
      const data = JSON.parse(e.data);
      this.sessions.set(data.id, data);
      // Add new session to end of tab order
      if (!this.sessionOrder.includes(data.id)) {
        this.sessionOrder.push(data.id);
        this.saveSessionOrder();
      }
      this.renderSessionTabs();
      this.updateCost();
      // Start stats polling when first session appears
      if (this.sessions.size === 1) this.startSystemStatsPolling();
    });

    addListener('session:updated', (e) => {
      const data = JSON.parse(e.data);
      const session = data.session || data;
      const oldSession = this.sessions.get(session.id);
      const claudeSessionIdJustSet = session.claudeSessionId && (!oldSession || !oldSession.claudeSessionId);
      this.sessions.set(session.id, session);
      this.renderSessionTabs();
      this.updateCost();
      // Update tokens display if this is the active session
      if (session.id === this.activeSessionId && session.tokens) {
        this.updateRespawnTokens(session.tokens);
      }
      // Update parentSessionName for any subagents belonging to this session
      // (fixes stale name display after session rename)
      this.updateSubagentParentNames(session.id);
      // If claudeSessionId was just set, re-check orphan subagents
      // This connects subagents that were waiting for the session to identify itself
      if (claudeSessionIdJustSet) {
        this.recheckOrphanSubagents();
        // Update connection lines after DOM settles (ensure tabs are rendered)
        requestAnimationFrame(() => {
          this.updateConnectionLines();
        });
      }
    });

    addListener('session:deleted', (e) => {
      const data = JSON.parse(e.data);
      this._cleanupSessionData(data.id);
      if (this.activeSessionId === data.id) {
        this.activeSessionId = null;
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        this.terminal.clear();
        this.showWelcome();
      }
      this.renderSessionTabs();
      this.renderRalphStatePanel();  // Update ralph panel after session deleted
      this.renderProjectInsightsPanel();  // Update project insights panel after session deleted
      // Stop stats polling when no sessions remain
      if (this.sessions.size === 0) this.stopSystemStatsPolling();
    });

    addListener('session:terminal', (e) => {
      const data = JSON.parse(e.data);
      if (data.id === this.activeSessionId) {
        this.batchTerminalWrite(data.data);
      }
    });

    // Server sends this after SSE backpressure clears — terminal data was dropped,
    // so reload the buffer to recover from any display corruption.
    addListener('session:needsRefresh', async () => {
      if (!this.activeSessionId || !this.terminal) return;
      try {
        const tailSize = 256 * 1024;
        const res = await fetch(`/api/sessions/${this.activeSessionId}/terminal?tail=${tailSize}`);
        const data = await res.json();
        if (data.terminalBuffer) {
          this.terminal.clear();
          this.terminal.reset();
          await this.chunkedTerminalWrite(data.terminalBuffer);
          this.terminal.scrollToBottom();
          // Re-position local echo overlay at new prompt location
          this._localEchoOverlay?.rerender();
          // Resize PTY to match actual browser dimensions (critical for OpenCode
          // TUI sessions that render at fixed 120x40 until told the real size)
          if (this.activeSessionId) {
            this.sendResize(this.activeSessionId);
          }
        }
      } catch (err) {
        console.error('needsRefresh reload failed:', err);
      }
    });

    addListener('session:clearTerminal', async (e) => {
      const data = JSON.parse(e.data);
      if (data.id === this.activeSessionId) {
        // Fetch buffer, clear terminal, write buffer, resize (no Ctrl+L needed)
        try {
          const res = await fetch(`/api/sessions/${data.id}/terminal`);
          const termData = await res.json();

          this.terminal.clear();
          this.terminal.reset();
          if (termData.terminalBuffer) {
            // Strip any DEC 2026 markers and write raw content
            // (markers don't help here - this is a static buffer reload, not live Ink redraws)
            const cleanBuffer = termData.terminalBuffer.replace(DEC_SYNC_STRIP_RE, '');
            // Use chunked write to avoid UI freeze with large buffers (can be 1-2MB)
            await this.chunkedTerminalWrite(cleanBuffer);
          }

          // Fire-and-forget resize — don't block on it
          this.sendResize(data.id);
          // Re-position local echo overlay at new prompt location
          this._localEchoOverlay?.rerender();
        } catch (err) {
          console.error('clearTerminal refresh failed:', err);
        }
      }
    });

    addListener('session:completion', (e) => {
      const data = JSON.parse(e.data);
      this.totalCost += data.cost || 0;
      this.updateCost();
      if (data.id === this.activeSessionId) {
        this.terminal.writeln('');
        this.terminal.writeln(`\x1b[1;32m Done (Cost: $${(data.cost || 0).toFixed(4)})\x1b[0m`);
      }
    });

    addListener('session:error', (e) => {
      const data = JSON.parse(e.data);
      if (data.id === this.activeSessionId) {
        this.terminal.writeln(`\x1b[1;31m Error: ${data.error}\x1b[0m`);
      }
      const session = this.sessions.get(data.id);
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'session-error',
        sessionId: data.id,
        sessionName: session?.name || data.id?.slice(0, 8),
        title: 'Session Error',
        message: data.error || 'Unknown error',
      });
    });

    addListener('session:exit', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'stopped';
        this.renderSessionTabs();
        if (data.id === this.activeSessionId) this._updateLocalEchoState();
      }
      // Notify on unexpected exit (non-zero code)
      if (data.code && data.code !== 0) {
        this.notificationManager?.notify({
          urgency: 'critical',
          category: 'session-crash',
          sessionId: data.id,
          sessionName: session?.name || data.id?.slice(0, 8),
          title: 'Session Crashed',
          message: `Exited with code ${data.code}`,
        });
      }
    });

    addListener('session:idle', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'idle';
        this.renderSessionTabs();
        this.sendPendingCtrlL(data.id);
        if (data.id === this.activeSessionId) this._updateLocalEchoState();
      }
      // Start stuck detection timer (only if no respawn running)
      if (!this.respawnStatus[data.id]?.enabled) {
        const threshold = this.notificationManager?.preferences?.stuckThresholdMs || 600000;
        clearTimeout(this.idleTimers.get(data.id));
        this.idleTimers.set(data.id, setTimeout(() => {
          const s = this.sessions.get(data.id);
          this.notificationManager?.notify({
            urgency: 'warning',
            category: 'session-stuck',
            sessionId: data.id,
            sessionName: s?.name || data.id?.slice(0, 8),
            title: 'Session Idle',
            message: `Idle for ${Math.round(threshold / 60000)}+ minutes`,
          });
          this.idleTimers.delete(data.id);
        }, threshold));
      }
    });

    addListener('session:working', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'busy';
        // Only clear tab alert if no pending hooks (permission_prompt, elicitation_dialog, etc.)
        if (!this.pendingHooks.has(data.id)) {
          this.tabAlerts.delete(data.id);
        }
        this.renderSessionTabs();
        this.sendPendingCtrlL(data.id);
        if (data.id === this.activeSessionId) this._updateLocalEchoState();
      }
      // Clear stuck detection timer
      const timer = this.idleTimers.get(data.id);
      if (timer) {
        clearTimeout(timer);
        this.idleTimers.delete(data.id);
      }
    });

    // Scheduled run events
    addListener('scheduled:created', (e) => {
      this.currentRun = JSON.parse(e.data);
      this.showTimer();
    });

    addListener('scheduled:updated', (e) => {
      this.currentRun = JSON.parse(e.data);
      this.updateTimer();
    });

    addListener('scheduled:completed', (e) => {
      this.currentRun = JSON.parse(e.data);
      this.hideTimer();
      this.showToast('Scheduled run completed!', 'success');
    });

    addListener('scheduled:stopped', (e) => {
      this.currentRun = null;
      this.hideTimer();
    });

    // Respawn events
    addListener('respawn:started', (e) => {
      const data = JSON.parse(e.data);
      this.respawnStatus[data.sessionId] = data.status;
      if (data.sessionId === this.activeSessionId) {
        this.showRespawnBanner();
      }
    });

    addListener('respawn:stopped', (e) => {
      const data = JSON.parse(e.data);
      delete this.respawnStatus[data.sessionId];
      if (data.sessionId === this.activeSessionId) {
        this.hideRespawnBanner();
      }
    });

    addListener('respawn:stateChanged', (e) => {
      const data = JSON.parse(e.data);
      if (this.respawnStatus[data.sessionId]) {
        this.respawnStatus[data.sessionId].state = data.state;
      }
      if (data.sessionId === this.activeSessionId) {
        this.updateRespawnBanner(data.state);
      }
    });

    addListener('respawn:cycleStarted', (e) => {
      const data = JSON.parse(e.data);
      if (this.respawnStatus[data.sessionId]) {
        this.respawnStatus[data.sessionId].cycleCount = data.cycleNumber;
      }
      if (data.sessionId === this.activeSessionId) {
        document.getElementById('respawnCycleCount').textContent = data.cycleNumber;
      }
    });

    addListener('respawn:blocked', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      const reasonMap = {
        circuit_breaker_open: 'Circuit Breaker Open',
        exit_signal: 'Exit Signal Detected',
        status_blocked: 'Claude Reported BLOCKED',
      };
      const title = reasonMap[data.reason] || 'Respawn Blocked';
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'respawn-blocked',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId?.slice(0, 8),
        title,
        message: data.details,
      });
      // Update respawn panel to show blocked state
      if (data.sessionId === this.activeSessionId) {
        const stateEl = document.getElementById('respawnStateLabel');
        if (stateEl) {
          stateEl.textContent = title;
          stateEl.classList.add('respawn-blocked');
        }
      }
    });

    addListener('respawn:stepSent', (_e) => {
      // Step info is shown via state label (e.g., "Sending prompt", "Clearing context")
    });

    addListener('respawn:autoAcceptSent', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'auto-accept',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId?.slice(0, 8),
        title: 'Plan Accepted',
        message: `Accepted plan mode for ${session?.name || 'session'}`,
      });
    });

    addListener('respawn:detectionUpdate', (e) => {
      const data = JSON.parse(e.data);
      if (this.respawnStatus[data.sessionId]) {
        this.respawnStatus[data.sessionId].detection = data.detection;
      }
      if (data.sessionId === this.activeSessionId) {
        this.updateDetectionDisplay(data.detection);
      }
    });

    addListener('respawn:aiCheckStarted', (_e) => {
      // AI check status shown via updateDetectionDisplay
    });

    addListener('respawn:aiCheckCompleted', (_e) => {
      // AI check status shown via updateDetectionDisplay
    });

    addListener('respawn:aiCheckFailed', (_e) => {
      // AI check status shown via updateDetectionDisplay
    });

    addListener('respawn:aiCheckCooldown', (_e) => {
      // AI check status shown via updateDetectionDisplay
    });

    // Respawn run timer events (timed respawn runs)
    addListener('respawn:timerStarted', (e) => {
      const data = JSON.parse(e.data);
      this.respawnTimers[data.sessionId] = {
        endAt: data.endAt,
        startedAt: data.startedAt,
        durationMinutes: data.durationMinutes
      };
      if (data.sessionId === this.activeSessionId) {
        this.showRespawnTimer();
      }
    });

    // Respawn controller countdown timer events (internal timers)
    addListener('respawn:timerStarted', (e) => {
      const data = JSON.parse(e.data);
      // This may fire for both run timers and controller timers - check for timer object
      if (data.timer) {
        const { sessionId, timer } = data;
        if (!this.respawnCountdownTimers[sessionId]) {
          this.respawnCountdownTimers[sessionId] = {};
        }
        this.respawnCountdownTimers[sessionId][timer.name] = {
          endsAt: timer.endsAt,
          totalMs: timer.durationMs,
          reason: timer.reason
        };
        if (sessionId === this.activeSessionId) {
          this.updateCountdownTimerDisplay();
          this.startCountdownInterval();
        }
      }
    });

    addListener('respawn:timerCancelled', (e) => {
      const data = JSON.parse(e.data);
      const { sessionId, timerName } = data;
      if (this.respawnCountdownTimers[sessionId]) {
        delete this.respawnCountdownTimers[sessionId][timerName];
      }
      if (sessionId === this.activeSessionId) {
        this.updateCountdownTimerDisplay();
      }
    });

    addListener('respawn:timerCompleted', (e) => {
      const data = JSON.parse(e.data);
      const { sessionId, timerName } = data;
      if (this.respawnCountdownTimers[sessionId]) {
        delete this.respawnCountdownTimers[sessionId][timerName];
      }
      if (sessionId === this.activeSessionId) {
        this.updateCountdownTimerDisplay();
      }
    });

    addListener('respawn:error', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'session-error',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Respawn Error',
        message: data.error || data.message || 'Respawn encountered an error',
      });
    });

    addListener('respawn:actionLog', (e) => {
      const data = JSON.parse(e.data);
      const { sessionId, action } = data;
      this.addActionLogEntry(sessionId, action);
      if (sessionId === this.activeSessionId) {
        this.updateCountdownTimerDisplay(); // Show row if hidden
        this.updateActionLogDisplay();
      }
    });

    // Auto-clear event
    addListener('session:autoClear', (e) => {
      const data = JSON.parse(e.data);
      if (data.sessionId === this.activeSessionId) {
        this.showToast(`Auto-cleared at ${data.tokens.toLocaleString()} tokens`, 'info');
        this.updateRespawnTokens(0);
      }
      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'auto-clear',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId?.slice(0, 8),
        title: 'Auto-Cleared',
        message: `Context reset at ${(data.tokens || 0).toLocaleString()} tokens`,
      });
    });

    // Claude Code CLI info (version, model) parsed from terminal
    addListener('session:cliInfo', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      if (session) {
        if (data.version) session.cliVersion = data.version;
        if (data.model) session.cliModel = data.model;
        if (data.accountType) session.cliAccountType = data.accountType;
        if (data.latestVersion) session.cliLatestVersion = data.latestVersion;
      }
      if (data.sessionId === this.activeSessionId) {
        this.updateCliInfoDisplay();
      }
    });

    // Background task events
    addListener('task:created', (e) => {
      const data = JSON.parse(e.data);
      this.renderSessionTabs();
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    addListener('task:completed', (e) => {
      const data = JSON.parse(e.data);
      this.renderSessionTabs();
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    addListener('task:failed', (e) => {
      const data = JSON.parse(e.data);
      this.renderSessionTabs();
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    addListener('task:updated', (e) => {
      const data = JSON.parse(e.data);
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    // Screen events
    addListener('mux:created', (e) => {
      const screen = JSON.parse(e.data);
      this.muxSessions.push(screen);
      this.renderMuxSessions();
    });

    addListener('mux:killed', (e) => {
      const data = JSON.parse(e.data);
      this.muxSessions = this.muxSessions.filter(s => s.sessionId !== data.sessionId);
      this.renderMuxSessions();
    });

    addListener('mux:died', (e) => {
      const data = JSON.parse(e.data);
      this.muxSessions = this.muxSessions.filter(s => s.sessionId !== data.sessionId);
      this.renderMuxSessions();
      this.showToast('Mux session died: ' + data.sessionId.slice(0, 8), 'warning');
    });

    addListener('mux:statsUpdated', (e) => {
      this.muxSessions = JSON.parse(e.data);
      if (document.getElementById('monitorPanel').classList.contains('open')) {
        this.renderMuxSessions();
      }
    });

    // Ralph loop/todo events
    addListener('session:ralphLoopUpdate', (e) => {
      const data = JSON.parse(e.data);
      // Skip if user explicitly closed this session's Ralph panel
      if (this.ralphClosedSessions.has(data.sessionId)) return;
      this.updateRalphState(data.sessionId, { loop: data.state });
    });

    addListener('session:ralphTodoUpdate', (e) => {
      const data = JSON.parse(e.data);
      // Skip if user explicitly closed this session's Ralph panel
      if (this.ralphClosedSessions.has(data.sessionId)) return;
      this.updateRalphState(data.sessionId, { todos: data.todos });
    });

    addListener('session:ralphCompletionDetected', (e) => {
      const data = JSON.parse(e.data);
      // Skip if user explicitly closed this session's Ralph panel
      if (this.ralphClosedSessions.has(data.sessionId)) return;
      // Prevent duplicate notifications for the same completion
      const completionKey = `${data.sessionId}:${data.phrase}`;
      if (this._shownCompletions?.has(completionKey)) {
        return;
      }
      if (!this._shownCompletions) {
        this._shownCompletions = new Set();
      }
      this._shownCompletions.add(completionKey);
      // Clear after 30 seconds to allow re-notification if loop restarts
      setTimeout(() => this._shownCompletions?.delete(completionKey), 30000);

      // Update ralph state to mark loop as inactive
      const existing = this.ralphStates.get(data.sessionId) || {};
      if (existing.loop) {
        existing.loop.active = false;
        this.updateRalphState(data.sessionId, existing);
      }

      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'warning',
        category: 'ralph-complete',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId?.slice(0, 8),
        title: 'Loop Complete',
        message: `Completion: ${data.phrase || 'unknown'}`,
      });
    });

    // RALPH_STATUS block and circuit breaker events
    addListener('session:ralphStatusUpdate', (e) => {
      const data = JSON.parse(e.data);
      // Skip if user explicitly closed this session's Ralph panel
      if (this.ralphClosedSessions.has(data.sessionId)) return;
      this.updateRalphState(data.sessionId, { statusBlock: data.block });
    });

    addListener('session:circuitBreakerUpdate', (e) => {
      const data = JSON.parse(e.data);
      // Skip if user explicitly closed this session's Ralph panel
      if (this.ralphClosedSessions.has(data.sessionId)) return;
      this.updateRalphState(data.sessionId, { circuitBreaker: data.status });
      // Notify if circuit breaker opens
      if (data.status.state === 'OPEN') {
        const session = this.sessions.get(data.sessionId);
        this.notificationManager?.notify({
          urgency: 'critical',
          category: 'circuit-breaker',
          sessionId: data.sessionId,
          sessionName: session?.name || data.sessionId?.slice(0, 8),
          title: 'Circuit Breaker Open',
          message: data.status.reason || 'Loop stuck - no progress detected',
        });
      }
    });

    addListener('session:exitGateMet', (e) => {
      const data = JSON.parse(e.data);
      // Notify when exit gate is met
      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'warning',
        category: 'exit-gate',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId?.slice(0, 8),
        title: 'Exit Gate Met',
        message: `Loop ready to exit (indicators: ${data.completionIndicators})`,
      });
    });

    // Active Bash tool events (for clickable file paths)
    addListener('session:bashToolStart', (e) => {
      const data = JSON.parse(e.data);
      this.handleBashToolStart(data.sessionId, data.tool);
    });

    addListener('session:bashToolEnd', (e) => {
      const data = JSON.parse(e.data);
      this.handleBashToolEnd(data.sessionId, data.tool);
    });

    addListener('session:bashToolsUpdate', (e) => {
      const data = JSON.parse(e.data);
      this.handleBashToolsUpdate(data.sessionId, data.tools);
    });

    // Hook events (from Claude Code hooks system)
    // Use pendingHooks state machine to track hook events and derive tab alerts.
    // This ensures alerts persist even when session:working events fire.
    addListener('hook:idle_prompt', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      // Always track pending hook - alert will show when switching away from session
      if (data.sessionId) {
        this.setPendingHook(data.sessionId, 'idle_prompt');
      }
      this.notificationManager?.notify({
        urgency: 'warning',
        category: 'hook-idle',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Waiting for Input',
        message: data.message || 'Claude is idle and waiting for a prompt',
      });
    });

    addListener('hook:permission_prompt', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      // Always track pending hook - action alerts need user interaction to clear
      if (data.sessionId) {
        this.setPendingHook(data.sessionId, 'permission_prompt');
      }
      const toolInfo = data.tool ? `${data.tool}${data.command ? ': ' + data.command : data.file ? ': ' + data.file : ''}` : '';
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'hook-permission',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Permission Required',
        message: toolInfo || 'Claude needs tool approval to continue',
      });
    });

    addListener('hook:elicitation_dialog', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      // Always track pending hook - action alerts need user interaction to clear
      if (data.sessionId) {
        this.setPendingHook(data.sessionId, 'elicitation_dialog');
      }
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'hook-elicitation',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Question Asked',
        message: data.question || 'Claude is asking a question and waiting for your answer',
      });
    });

    addListener('hook:stop', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      // Clear all pending hooks when Claude finishes responding
      if (data.sessionId) {
        this.clearPendingHooks(data.sessionId);
      }
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'hook-stop',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Response Complete',
        message: data.reason || 'Claude has finished responding',
      });
    });

    addListener('hook:teammate_idle', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'warning',
        category: 'hook-teammate-idle',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Teammate Idle',
        message: `A teammate is idle in ${session?.name || data.sessionId}`,
      });
    });

    addListener('hook:task_completed', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'hook-task-completed',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Task Completed',
        message: `A team task completed in ${session?.name || data.sessionId}`,
      });
    });

    // ========== Subagent Events (Claude Code Background Agents) ==========

    addListener('subagent:discovered', (e) => {
      const data = JSON.parse(e.data);
      // Clear all old data for this agentId (in case of ID reuse)
      this.subagents.set(data.agentId, data);
      this.subagentActivity.set(data.agentId, []);
      this.subagentToolResults.delete(data.agentId);
      // Close any existing window for this agentId (will be reopened fresh)
      if (this.subagentWindows.has(data.agentId)) {
        this.forceCloseSubagentWindow(data.agentId);
      }
      this.renderSubagentPanel();

      // Find which Codeman session owns this subagent (direct claudeSessionId match only)
      this.findParentSessionForSubagent(data.agentId);

      // Auto-open window for new active agents — but ONLY if they belong to a Codeman session tab.
      // Agents from external Claude sessions (not managed by Codeman) should not pop up.
      if (data.status === 'active') {
        const agentForCheck = this.subagents.get(data.agentId);
        const hasMatchingTab = agentForCheck?.sessionId &&
          Array.from(this.sessions.values()).some(s => s.claudeSessionId === agentForCheck.sessionId);
        if (hasMatchingTab) {
          this.openSubagentWindow(data.agentId);
        }
      }

      // Ensure connection lines are updated after window is created and DOM settles
      requestAnimationFrame(() => {
        this.updateConnectionLines();
      });

      // Notify about new subagent discovery
      const parentId = this.subagentParentMap.get(data.agentId);
      const parentSession = parentId ? this.sessions.get(parentId) : null;
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'subagent-spawn',
        sessionId: parentId || data.sessionId,
        sessionName: parentSession?.name || parentId || data.sessionId,
        title: 'Subagent Spawned',
        message: data.description || 'New background agent started',
      });
    });

    addListener('subagent:updated', (e) => {
      const data = JSON.parse(e.data);
      const existing = this.subagents.get(data.agentId);
      if (existing) {
        // Merge updated fields (especially description)
        Object.assign(existing, data);
        this.subagents.set(data.agentId, existing);
      } else {
        this.subagents.set(data.agentId, data);
      }
      this.renderSubagentPanel();
      // Update floating window if open (content + header/title)
      if (this.subagentWindows.has(data.agentId)) {
        this.renderSubagentWindowContent(data.agentId);
        this.updateSubagentWindowHeader(data.agentId);
      }
    });

    addListener('subagent:tool_call', (e) => {
      const data = JSON.parse(e.data);
      const activity = this.subagentActivity.get(data.agentId) || [];
      activity.push({ type: 'tool', ...data });
      if (activity.length > 50) activity.shift(); // Keep last 50 entries
      this.subagentActivity.set(data.agentId, activity);
      if (this.activeSubagentId === data.agentId) {
        this.renderSubagentDetail();
      }
      this.renderSubagentPanel();
      // Update floating window
      if (this.subagentWindows.has(data.agentId)) {
        this.renderSubagentWindowContent(data.agentId);
      }
    });

    addListener('subagent:progress', (e) => {
      const data = JSON.parse(e.data);
      const activity = this.subagentActivity.get(data.agentId) || [];
      activity.push({ type: 'progress', ...data });
      if (activity.length > 50) activity.shift();
      this.subagentActivity.set(data.agentId, activity);
      if (this.activeSubagentId === data.agentId) {
        this.renderSubagentDetail();
      }
      // Update floating window
      if (this.subagentWindows.has(data.agentId)) {
        this.renderSubagentWindowContent(data.agentId);
      }
    });

    addListener('subagent:message', (e) => {
      const data = JSON.parse(e.data);
      const activity = this.subagentActivity.get(data.agentId) || [];
      activity.push({ type: 'message', ...data });
      if (activity.length > 50) activity.shift();
      this.subagentActivity.set(data.agentId, activity);
      if (this.activeSubagentId === data.agentId) {
        this.renderSubagentDetail();
      }
      // Update floating window
      if (this.subagentWindows.has(data.agentId)) {
        this.renderSubagentWindowContent(data.agentId);
      }
    });

    addListener('subagent:tool_result', (e) => {
      const data = JSON.parse(e.data);
      // Store tool result by toolUseId for later lookup (cap at 50 per agent)
      if (!this.subagentToolResults.has(data.agentId)) {
        this.subagentToolResults.set(data.agentId, new Map());
      }
      const resultsMap = this.subagentToolResults.get(data.agentId);
      resultsMap.set(data.toolUseId, data);
      if (resultsMap.size > 50) {
        const oldest = resultsMap.keys().next().value;
        resultsMap.delete(oldest);
      }

      // Add to activity stream
      const activity = this.subagentActivity.get(data.agentId) || [];
      activity.push({ type: 'tool_result', ...data });
      if (activity.length > 50) activity.shift();
      this.subagentActivity.set(data.agentId, activity);

      if (this.activeSubagentId === data.agentId) {
        this.renderSubagentDetail();
      }
      // Update floating window
      if (this.subagentWindows.has(data.agentId)) {
        this.renderSubagentWindowContent(data.agentId);
      }
    });

    addListener('subagent:completed', async (e) => {
      const data = JSON.parse(e.data);
      const existing = this.subagents.get(data.agentId);
      if (existing) {
        existing.status = 'completed';
        this.subagents.set(data.agentId, existing);
      }
      this.renderSubagentPanel();
      this.updateSubagentWindows();

      // Auto-minimize completed subagent windows
      if (this.subagentWindows.has(data.agentId)) {
        const windowData = this.subagentWindows.get(data.agentId);
        if (windowData && !windowData.minimized) {
          await this.closeSubagentWindow(data.agentId); // This minimizes to tab
          this.saveSubagentWindowStates(); // Persist the minimized state
        }
      }

      // Notify about subagent completion
      const parentId = this.subagentParentMap.get(data.agentId);
      const parentSession = parentId ? this.sessions.get(parentId) : null;
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'subagent-complete',
        sessionId: parentId || existing?.sessionId || data.sessionId,
        sessionName: parentSession?.name || parentId || data.sessionId,
        title: 'Subagent Completed',
        message: existing?.description || data.description || 'Background agent finished',
      });

      // Clean up activity/tool data for completed agents after 5 minutes
      // This prevents memory leaks from long-running sessions with many subagents
      setTimeout(() => {
        const agent = this.subagents.get(data.agentId);
        // Only clean up if agent is still completed (not restarted)
        if (agent?.status === 'completed') {
          this.subagentActivity.delete(data.agentId);
          this.subagentToolResults.delete(data.agentId);
        }
      }, 5 * 60 * 1000); // 5 minutes

      // Prune stale completed agents from main maps after 30 minutes
      // Keeps subagents/subagentParentMap from growing unbounded in 24h sessions
      setTimeout(() => {
        const agent = this.subagents.get(data.agentId);
        if (agent?.status === 'completed' && !this.subagentWindows.has(data.agentId)) {
          this.subagents.delete(data.agentId);
          this.subagentParentMap.delete(data.agentId);
        }
      }, 30 * 60 * 1000); // 30 minutes
    });

    // ========== Image Detection Events (Screenshots & Generated Images) ==========

    addListener('image:detected', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Image Detected]', data);
      this.openImagePopup(data);
    });

    // ========== Tunnel Events ==========

    addListener('tunnel:started', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Tunnel] Started:', data.url);
      this._dismissTunnelConnecting();
      this._updateTunnelUrlDisplay(data.url);
      const welcomeVisible = document.getElementById('welcomeOverlay')?.classList.contains('visible');
      if (welcomeVisible) {
        // On welcome screen: QR appears inline, expanded first
        this._updateWelcomeTunnelBtn(true, data.url, true);
        this.showToast(`Tunnel active`, 'success');
      } else {
        // Not on welcome screen: popup QR overlay
        this._updateWelcomeTunnelBtn(true, data.url);
        this.showToast(`Tunnel active: ${data.url}`, 'success');
        this.showTunnelQR();
      }
    });

    addListener('tunnel:stopped', () => {
      console.log('[Tunnel] Stopped');
      this._dismissTunnelConnecting();
      this._updateTunnelUrlDisplay(null);
      this._updateWelcomeTunnelBtn(false);
      this.closeTunnelQR();
    });

    addListener('tunnel:progress', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Tunnel] Progress:', data.message);
      const toast = document.getElementById('tunnelConnectingToast');
      if (toast) {
        toast.innerHTML = `<span class="tunnel-spinner"></span> ${data.message}`;
      }
      // Also update button text if on welcome screen
      const btn = document.getElementById('welcomeTunnelBtn');
      if (btn?.classList.contains('connecting')) {
        btn.innerHTML = `<span class="tunnel-spinner"></span> ${data.message}`;
      }
    });

    addListener('tunnel:error', (e) => {
      const data = JSON.parse(e.data);
      console.warn('[Tunnel] Error:', data.message);
      this._dismissTunnelConnecting();
      this.showToast(`Tunnel error: ${data.message}`, 'error');
      const btn = document.getElementById('welcomeTunnelBtn');
      if (btn) { btn.disabled = false; btn.classList.remove('connecting'); }
    });

    // QR auto-refresh — inline SVG from SSE (no extra fetch)
    addListener('tunnel:qrRotated', (e) => {
      const data = JSON.parse(e.data);
      if (data.svg) {
        const container = document.getElementById('tunnelQrContainer');
        if (container) container.innerHTML = data.svg;
        const welcomeInner = document.getElementById('welcomeQrInner');
        if (welcomeInner) welcomeInner.innerHTML = data.svg;
      } else {
        this._refreshTunnelQrFromApi();
      }
      this._resetQrCountdown();
    });

    addListener('tunnel:qrRegenerated', (e) => {
      const data = JSON.parse(e.data);
      if (data.svg) {
        const container = document.getElementById('tunnelQrContainer');
        if (container) container.innerHTML = data.svg;
        const welcomeInner = document.getElementById('welcomeQrInner');
        if (welcomeInner) welcomeInner.innerHTML = data.svg;
      } else {
        this._refreshTunnelQrFromApi();
      }
      this._resetQrCountdown();
    });

    // QR auth consumed — notify desktop user (QRLjacking detection)
    addListener('tunnel:qrAuthUsed', (e) => {
      const data = JSON.parse(e.data);
      const ua = data.ua || 'Unknown device';
      const family = ua.match(/Chrome|Firefox|Safari|Edge|Mobile/)?.[0] || 'Browser';
      this.showToast(`Device authenticated via QR (${family}, ${data.ip}). Not you?`, 'warning', {
        duration: 10000,
        action: { label: 'Revoke All', onClick: () => {
          fetch('/api/auth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(() => this.showToast('All sessions revoked', 'success'))
            .catch(() => this.showToast('Failed to revoke sessions', 'error'));
        }},
      });
    });

    // Plan subagent visibility events (show Opus agents during plan generation)
    addListener('plan:subagent', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Plan Subagent]', data);
      this.handlePlanSubagentEvent(data);
    });

    // Plan generation progress events (for detailed mode with subagents)
    addListener('plan:progress', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Plan Progress]', data);

      // Update UI if we have a progress handler registered
      if (this._planProgressHandler) {
        this._planProgressHandler({ type: 'plan:progress', data });
      }

      // Also update the loading display directly for better feedback
      const titleEl = document.getElementById('planLoadingTitle');
      const hintEl = document.getElementById('planLoadingHint');

      if (titleEl && data.phase) {
        const phaseLabels = {
          'parallel-analysis': 'Running parallel analysis...',
          'subagent': data.detail || 'Subagent working...',
          'synthesis': 'Synthesizing results...',
          'verification': 'Running verification...',
        };
        titleEl.textContent = phaseLabels[data.phase] || data.phase;
      }
      if (hintEl && data.detail) {
        hintEl.textContent = data.detail;
      }
    });

    // Plan generation started - store orchestrator ID for cancellation
    addListener('plan:started', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Plan Started]', data);
      this.activePlanOrchestratorId = data.orchestratorId;
      this.planGenerationStopped = false; // Reset flag for new generation
      this.renderMonitorPlanAgents();
    });

    // Plan generation cancelled
    addListener('plan:cancelled', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Plan Cancelled]', data);
      if (this.activePlanOrchestratorId === data.orchestratorId) {
        this.activePlanOrchestratorId = null;
      }
      this.renderMonitorPlanAgents();
    });

    // Plan generation completed
    addListener('plan:completed', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Plan Completed]', data);
      if (this.activePlanOrchestratorId === data.orchestratorId) {
        this.activePlanOrchestratorId = null;
      }
      this.renderMonitorPlanAgents();
    });
  }

  setConnectionStatus(status) {
    this._connectionStatus = status;
    this._updateConnectionIndicator();
    if (status === 'connected' && this._inputQueue.size > 0) {
      this._drainInputQueues();
    }
  }

  /**
   * Send input to server without blocking the keystroke flush cycle.
   * Uses a sequential promise chain to preserve character ordering
   * across concurrent async fetches.
   */
  _sendInputAsync(sessionId, input) {
    // Queue immediately if offline
    if (!this.isOnline || this._connectionStatus === 'disconnected') {
      this._enqueueInput(sessionId, input);
      return;
    }

    // Chain on dispatch only — wait for the previous request to be sent before
    // dispatching the next one (preserves keystroke ordering), but don't wait
    // for the server's response. The server handles writeViaMux as
    // fire-and-forget anyway, so the HTTP response carries no useful data
    // beyond success/failure for retry purposes.
    this._inputSendChain = this._inputSendChain.then(() => {
      const fetchPromise = fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        keepalive: input.length < 65536,
      });

      // Handle response asynchronously — don't block next keystroke on response
      fetchPromise.then(resp => {
        if (!resp.ok) {
          this._enqueueInput(sessionId, input);
        } else {
          this.clearPendingHooks(sessionId);
        }
      }).catch(() => {
        this._enqueueInput(sessionId, input);
      });

      // Return immediately after fetch is dispatched (don't await response)
    });
  }


  _enqueueInput(sessionId, input) {
    const existing = this._inputQueue.get(sessionId) || '';
    let combined = existing + input;
    // Enforce 64KB cap — keep most recent keystrokes
    if (combined.length > this._inputQueueMaxBytes) {
      combined = combined.slice(combined.length - this._inputQueueMaxBytes);
    }
    this._inputQueue.set(sessionId, combined);
    this._updateConnectionIndicator();
  }

  async _drainInputQueues() {
    if (this._inputQueue.size === 0) return;
    // Snapshot and clear
    const queued = new Map(this._inputQueue);
    this._inputQueue.clear();
    this._updateConnectionIndicator();

    for (const [sessionId, input] of queued) {
      const resp = await this._apiPost(`/api/sessions/${sessionId}/input`, { input });
      if (!resp?.ok) {
        this._enqueueInput(sessionId, input);
      }
    }
    this._updateConnectionIndicator();
  }

  _updateConnectionIndicator() {
    const indicator = this.$('connectionIndicator');
    const dot = this.$('connectionDot');
    const text = this.$('connectionText');
    if (!indicator || !dot || !text) return;

    let totalBytes = 0;
    for (const v of this._inputQueue.values()) totalBytes += v.length;

    const status = this._connectionStatus;
    const hasQueue = totalBytes > 0;

    // Connected with empty queue — hide
    if ((status === 'connected' || status === 'connecting') && !hasQueue) {
      indicator.style.display = 'none';
      return;
    }

    indicator.style.display = 'flex';
    dot.className = 'connection-dot';

    const formatBytes = (b) => b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}KB`;

    if (status === 'connected' && hasQueue) {
      // Draining
      dot.classList.add('draining');
      text.textContent = `Sending ${formatBytes(totalBytes)}...`;
    } else if (status === 'reconnecting') {
      dot.classList.add('reconnecting');
      text.textContent = hasQueue ? `Reconnecting (${formatBytes(totalBytes)} queued)` : 'Reconnecting...';
    } else {
      // Offline or disconnected
      dot.classList.add('offline');
      text.textContent = hasQueue ? `Offline (${formatBytes(totalBytes)} queued)` : 'Offline';
    }
  }

  setupOnlineDetection() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.reconnectAttempts = 0;
      this.connectSSE();
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.setConnectionStatus('offline');
    });
  }

  handleInit(data) {
    // Clear the init fallback timer since we got data
    if (this._initFallbackTimer) {
      clearTimeout(this._initFallbackTimer);
      this._initFallbackTimer = null;
    }
    const gen = ++this._initGeneration;

    // Update version displays (header and toolbar)
    if (data.version) {
      const versionEl = this.$('versionDisplay');
      const headerVersionEl = this.$('headerVersion');
      if (versionEl) {
        versionEl.textContent = `v${data.version}`;
        versionEl.title = `Codeman v${data.version}`;
      }
      if (headerVersionEl) {
        headerVersionEl.textContent = `v${data.version}`;
        headerVersionEl.title = `Codeman v${data.version}`;
      }
    }

    // Stop any active voice recording on reconnect
    VoiceInput.cleanup();

    this.sessions.clear();
    this.ralphStates.clear();
    this.terminalBuffers.clear();
    this.terminalBufferCache.clear();
    this.projectInsights.clear();
    this.teams.clear();
    this.teamTasks.clear();
    // Clear all idle timers to prevent stale timers from firing
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    // Clear flicker filter state
    if (this.flickerFilterTimeout) {
      clearTimeout(this.flickerFilterTimeout);
      this.flickerFilterTimeout = null;
    }
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    // Clear pending terminal writes
    if (this.syncWaitTimeout) {
      clearTimeout(this.syncWaitTimeout);
      this.syncWaitTimeout = null;
    }
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    // Preserve local echo overlay text across SSE reconnect — just hide until
    // terminal buffer reloads and prompt is visible again.  _render() re-scans
    // for the ❯ prompt on every call, so rerender() after buffer load repositions it.
    this._localEchoOverlay?.rerender();
    // Clear pending hooks
    this.pendingHooks.clear();
    // Clear parent name cache (prevents stale session name entries accumulating)
    if (this._parentNameCache) this._parentNameCache.clear();
    // Clear subagent activity/results maps (prevents leaks if data.subagents is missing)
    this.subagentActivity.clear();
    this.subagentToolResults.clear();
    // Clean up mobile/keyboard handlers and re-init (prevents listener accumulation on reconnect)
    MobileDetection.cleanup();
    KeyboardHandler.cleanup();
    MobileDetection.init();
    KeyboardHandler.init();
    // Clear tab alerts
    this.tabAlerts.clear();
    // Clear shown completions (used for duplicate notification prevention)
    if (this._shownCompletions) {
      this._shownCompletions.clear();
    }
    // Clear notification manager title flash interval to prevent memory leak
    if (this.notificationManager?.titleFlashInterval) {
      clearInterval(this.notificationManager.titleFlashInterval);
      this.notificationManager.titleFlashInterval = null;
    }
    // Clear notification manager grouping timeouts (prevents orphaned timers)
    if (this.notificationManager?.groupingMap) {
      for (const { timeout } of this.notificationManager.groupingMap.values()) {
        clearTimeout(timeout);
      }
      this.notificationManager.groupingMap.clear();
    }
    // Disconnect terminal resize observer (prevents memory leak on reconnect)
    if (this.terminalResizeObserver) {
      this.terminalResizeObserver.disconnect();
      this.terminalResizeObserver = null;
    }
    // Clear any other orphaned timers
    if (this.planLoadingTimer) {
      clearInterval(this.planLoadingTimer);
      this.planLoadingTimer = null;
    }
    if (this.timerCountdownInterval) {
      clearInterval(this.timerCountdownInterval);
      this.timerCountdownInterval = null;
    }
    if (this.runSummaryAutoRefreshTimer) {
      clearInterval(this.runSummaryAutoRefreshTimer);
      this.runSummaryAutoRefreshTimer = null;
    }
    data.sessions.forEach(s => {
      this.sessions.set(s.id, s);
      // Load ralph state from session data (only if not explicitly closed by user)
      if ((s.ralphLoop || s.ralphTodos) && !this.ralphClosedSessions.has(s.id)) {
        this.ralphStates.set(s.id, {
          loop: s.ralphLoop || null,
          todos: s.ralphTodos || []
        });
      }
    });

    // Sync sessionOrder with current sessions (preserve order, add new, remove stale)
    this.syncSessionOrder();

    if (data.respawnStatus) {
      this.respawnStatus = data.respawnStatus;
    } else {
      // Clear respawn status on init if not provided (prevents stale data)
      this.respawnStatus = {};
    }
    // Clean up respawn state for sessions that no longer exist
    this.respawnTimers = {};
    this.respawnCountdownTimers = {};
    this.respawnActionLogs = {};

    // Store global stats for aggregate tracking
    if (data.globalStats) {
      this.globalStats = data.globalStats;
    }

    this.totalCost = data.sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
    this.totalCost += data.scheduledRuns.reduce((sum, r) => sum + (r.totalCost || 0), 0);

    const activeRun = data.scheduledRuns.find(r => r.status === 'running');
    if (activeRun) {
      this.currentRun = activeRun;
      this.showTimer();
    }

    this.updateCost();
    this.renderSessionTabs();

    // Start/stop system stats polling based on session count
    if (this.sessions.size > 0) {
      this.startSystemStatsPolling();
    } else {
      this.stopSystemStatsPolling();
    }

    // CRITICAL: Clean up all floating windows before loading new subagents
    // This prevents memory leaks from ResizeObservers, EventSources, and DOM elements
    this.cleanupAllFloatingWindows();

    // Load subagents - clear all related maps to prevent memory leaks on reconnect
    if (data.subagents) {
      this.subagents.clear();
      this.subagentActivity.clear();
      this.subagentToolResults.clear();
      data.subagents.forEach(s => {
        this.subagents.set(s.agentId, s);
      });
      this.renderSubagentPanel();

      // Load PERSISTENT parent associations FIRST, before restoring windows
      // This ensures connection lines are drawn to the correct tabs
      // Clear the in-memory map first to ensure fresh state from storage
      this.subagentParentMap.clear();
      this.loadSubagentParentMap().then(() => {
        // Apply stored parent associations to agents
        for (const [agentId, sessionId] of this.subagentParentMap) {
          const agent = this.subagents.get(agentId);
          if (agent && this.sessions.has(sessionId)) {
            agent.parentSessionId = sessionId;
            const session = this.sessions.get(sessionId);
            if (session) {
              agent.parentSessionName = this.getSessionName(session);
            }
            this.subagents.set(agentId, agent);
          }
        }

        // Now try to find parents for any agents that don't have one yet
        for (const [agentId] of this.subagents) {
          if (!this.subagentParentMap.has(agentId)) {
            this.findParentSessionForSubagent(agentId);
          }
        }

        // Finally, restore window states (this opens windows with correct parent info)
        this.restoreSubagentWindowStates();
      });
    }

    // Restore previously active session (survives page reload + SSE reconnect)
    // Must always re-select because handleInit clears terminal state above.
    // Reset activeSessionId so selectSession doesn't early-return.
    // Guard: skip if a newer handleInit has already started (race between loadState + SSE init).
    if (gen !== this._initGeneration) return;
    const previousActiveId = this.activeSessionId;
    this.activeSessionId = null;
    if (this.sessionOrder.length > 0) {
      // Priority: current active > localStorage > first session
      let restoreId = previousActiveId;
      if (!restoreId || !this.sessions.has(restoreId)) {
        try { restoreId = localStorage.getItem('codeman-active-session'); } catch {}
      }
      if (restoreId && this.sessions.has(restoreId)) {
        this.selectSession(restoreId);
      } else {
        this.selectSession(this.sessionOrder[0]);
      }
    }
  }

  async loadState() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      this.handleInit(data);
    } catch (err) {
      console.error('Failed to load state:', err);
    }
  }

  // ========== Session Tabs ==========

  renderSessionTabs() {
    // Debounce renders at 100ms to prevent excessive DOM updates
    if (this.renderSessionTabsTimeout) {
      clearTimeout(this.renderSessionTabsTimeout);
    }
    this.renderSessionTabsTimeout = setTimeout(() => {
      this._renderSessionTabsImmediate();
    }, 100);
  }

  /** Toggle .active class on tabs immediately (no debounce). Used by selectSession(). */
  _updateActiveTabImmediate(sessionId) {
    const container = this.$('sessionTabs');
    if (!container) return;
    const tabs = container.querySelectorAll('.session-tab[data-id]');
    for (const tab of tabs) {
      if (tab.dataset.id === sessionId) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    }
  }

  _renderSessionTabsImmediate() {
    const container = this.$('sessionTabs');
    const existingTabs = container.querySelectorAll('.session-tab[data-id]');
    const existingIds = new Set([...existingTabs].map(t => t.dataset.id));
    const currentIds = new Set(this.sessions.keys());

    // Check if we can do incremental update (same session IDs)
    const canIncremental = existingIds.size === currentIds.size &&
      [...existingIds].every(id => currentIds.has(id));

    if (canIncremental) {
      // Incremental update - only modify changed properties
      for (const [id, session] of this.sessions) {
        const tab = container.querySelector(`.session-tab[data-id="${id}"]`);
        if (!tab) continue;

        const isActive = id === this.activeSessionId;
        const status = session.status || 'idle';
        const name = this.getSessionName(session);
        const taskStats = session.taskStats || { running: 0, total: 0 };
        const hasRunningTasks = taskStats.running > 0;

        // Update active class
        if (isActive && !tab.classList.contains('active')) {
          tab.classList.add('active');
        } else if (!isActive && tab.classList.contains('active')) {
          tab.classList.remove('active');
        }

        // Update alert class
        const alertType = this.tabAlerts.get(id);
        const wantAction = alertType === 'action';
        const wantIdle = alertType === 'idle';
        const hasAction = tab.classList.contains('tab-alert-action');
        const hasIdle = tab.classList.contains('tab-alert-idle');
        if (wantAction && !hasAction) { tab.classList.add('tab-alert-action'); tab.classList.remove('tab-alert-idle'); }
        else if (wantIdle && !hasIdle) { tab.classList.add('tab-alert-idle'); tab.classList.remove('tab-alert-action'); }
        else if (!alertType && (hasAction || hasIdle)) { tab.classList.remove('tab-alert-action', 'tab-alert-idle'); }

        // Update status indicator
        const statusEl = tab.querySelector('.tab-status');
        if (statusEl && !statusEl.classList.contains(status)) {
          statusEl.className = `tab-status ${status}`;
        }

        // Update name if changed
        const nameEl = tab.querySelector('.tab-name');
        if (nameEl && nameEl.textContent !== name) {
          nameEl.textContent = name;
        }

        // Update task badge
        const badgeEl = tab.querySelector('.tab-badge');
        if (hasRunningTasks) {
          if (badgeEl) {
            if (badgeEl.textContent !== String(taskStats.running)) {
              badgeEl.textContent = taskStats.running;
            }
          } else {
            // Need to add badge - do full rebuild
            this._fullRenderSessionTabs();
            return;
          }
        } else if (badgeEl) {
          // Need to remove badge - do full rebuild
          this._fullRenderSessionTabs();
          return;
        }

        // Update subagent badge - check if count changed
        const subagentBadgeEl = tab.querySelector('.tab-subagent-badge');
        const minimizedAgents = this.minimizedSubagents.get(id);
        const minimizedCount = minimizedAgents?.size || 0;
        const currentCount = subagentBadgeEl ? parseInt(subagentBadgeEl.querySelector('.subagent-count')?.textContent || '0') : 0;
        if (minimizedCount !== currentCount) {
          // Count changed - need full rebuild for dropdown update
          this._fullRenderSessionTabs();
          return;
        }
      }
    } else {
      // Full rebuild needed (sessions added/removed)
      this._fullRenderSessionTabs();
    }

  }

  _fullRenderSessionTabs() {
    const container = this.$('sessionTabs');

    // Clean up any orphaned dropdowns before re-rendering
    document.querySelectorAll('body > .subagent-dropdown').forEach(d => d.remove());
    this.cancelHideSubagentDropdown();

    // Build tabs HTML using array for better string concatenation performance
    // Iterate in sessionOrder to respect user's custom tab arrangement
    // On mobile: put active session first (only one tab visible anyway)
    const parts = [];
    let tabOrder = this.sessionOrder;
    if (MobileDetection.getDeviceType() === 'mobile' && this.activeSessionId) {
      // Reorder to put active tab first
      tabOrder = [this.activeSessionId, ...this.sessionOrder.filter(id => id !== this.activeSessionId)];
    }
    for (const id of tabOrder) {
      const session = this.sessions.get(id);
      if (!session) continue; // Skip if session was removed

      const isActive = id === this.activeSessionId;
      const status = session.status || 'idle';
      const name = this.getSessionName(session);
      const mode = session.mode || 'claude';
      const color = session.color || 'default';
      const taskStats = session.taskStats || { running: 0, total: 0 };
      const hasRunningTasks = taskStats.running > 0;
      const alertType = this.tabAlerts.get(id);
      const alertClass = alertType === 'action' ? ' tab-alert-action' : alertType === 'idle' ? ' tab-alert-idle' : '';

      // Get minimized subagents for this session
      const minimizedAgents = this.minimizedSubagents.get(id);
      const minimizedCount = minimizedAgents?.size || 0;
      const subagentBadge = minimizedCount > 0 ? this.renderSubagentTabBadge(id, minimizedAgents) : '';

      // Show folder name if session has a custom name AND tall tabs setting is enabled
      const folderName = session.workingDir ? session.workingDir.split('/').pop() || '' : '';
      const tallTabsEnabled = this._tallTabsEnabled ?? false;
      const showFolder = tallTabsEnabled && session.name && folderName && folderName !== name;

      parts.push(`<div class="session-tab ${isActive ? 'active' : ''}${alertClass}" data-id="${id}" data-color="${color}" onclick="app.selectSession('${escapeHtml(id)}')" oncontextmenu="event.preventDefault(); app.startInlineRename('${escapeHtml(id)}')" tabindex="0" role="tab" aria-selected="${isActive ? 'true' : 'false'}" aria-label="${escapeHtml(name)} session" ${session.workingDir ? `title="${escapeHtml(session.workingDir)}"` : ''}>
          <span class="tab-status ${status}" aria-hidden="true"></span>
          <span class="tab-info">
            <span class="tab-name-row">
              ${mode === 'shell' ? '<span class="tab-mode shell" aria-hidden="true">sh</span>' : mode === 'opencode' ? '<span class="tab-mode opencode" aria-hidden="true">oc</span>' : ''}
              <span class="tab-name" data-session-id="${id}">${escapeHtml(name)}</span>
            </span>
            ${showFolder ? `<span class="tab-folder">\u{1F4C1} ${escapeHtml(folderName)}</span>` : ''}
          </span>
          ${hasRunningTasks ? `<span class="tab-badge" onclick="event.stopPropagation(); app.toggleTaskPanel()" aria-label="${taskStats.running} running tasks">${taskStats.running}</span>` : ''}
          ${subagentBadge}
          <span class="tab-gear" onclick="event.stopPropagation(); app.openSessionOptions('${escapeHtml(id)}')" title="Session options" aria-label="Session options" tabindex="0">&#x2699;</span>
          <span class="tab-close" onclick="event.stopPropagation(); app.requestCloseSession('${escapeHtml(id)}')" title="Close session" aria-label="Close session" tabindex="0">&times;</span>
        </div>`);
    }

    container.innerHTML = parts.join('');

    // Set up drag-and-drop handlers for tab reordering
    this.setupTabDragHandlers();

    // Set up keyboard navigation for tabs
    this.setupTabKeyboardNavigation(container);

    // Update connection lines after tabs change (positions may have shifted)
    this.updateConnectionLines();
  }

  // Set up arrow key navigation for session tabs (accessibility)
  setupTabKeyboardNavigation(container) {
    // Remove existing listener if any to avoid duplicates
    if (this._tabKeydownHandler) {
      container.removeEventListener('keydown', this._tabKeydownHandler);
    }

    this._tabKeydownHandler = (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(e.key)) return;

      const tabs = [...container.querySelectorAll('.session-tab')];
      const currentIndex = tabs.indexOf(document.activeElement);

      // Enter or Space activates the tab
      if ((e.key === 'Enter' || e.key === ' ') && currentIndex >= 0) {
        e.preventDefault();
        const sessionId = tabs[currentIndex].dataset.id;
        this.selectSession(sessionId);
        return;
      }

      if (currentIndex < 0) return;

      let newIndex;
      switch (e.key) {
        case 'ArrowLeft':
          newIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
          break;
        case 'ArrowRight':
          newIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
          break;
        case 'Home':
          newIndex = 0;
          break;
        case 'End':
          newIndex = tabs.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      tabs[newIndex]?.focus();
    };

    container.addEventListener('keydown', this._tabKeydownHandler);
  }


  // ========== Tab Order and Drag-and-Drop ==========

  // Sync sessionOrder with current sessions (preserve order for existing, add new at end)
  syncSessionOrder() {
    const currentIds = new Set(this.sessions.keys());

    // Load saved order from localStorage
    const savedOrder = this.loadSessionOrder();

    // Start with saved order, keeping only sessions that still exist
    const preserved = savedOrder.filter(id => currentIds.has(id));
    const preservedSet = new Set(preserved);

    // Add any new sessions at the end
    const newSessions = [...currentIds].filter(id => !preservedSet.has(id));

    this.sessionOrder = [...preserved, ...newSessions];
  }

  // Load session order from localStorage
  loadSessionOrder() {
    try {
      const saved = localStorage.getItem('codeman-session-order');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  // Save session order to localStorage
  saveSessionOrder() {
    try {
      localStorage.setItem('codeman-session-order', JSON.stringify(this.sessionOrder));
    } catch {
      // Ignore storage errors
    }
  }

  // Set up drag-and-drop handlers on tab elements
  setupTabDragHandlers() {
    const container = this.$('sessionTabs');
    const tabs = container.querySelectorAll('.session-tab[data-id]');

    tabs.forEach(tab => {
      tab.setAttribute('draggable', 'true');

      tab.addEventListener('dragstart', (e) => {
        this.draggedTabId = tab.dataset.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.dataset.id);
      });

      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        this.draggedTabId = null;
        // Remove all drag-over indicators
        container.querySelectorAll('.session-tab').forEach(t => {
          t.classList.remove('drag-over-left', 'drag-over-right');
        });
      });

      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!this.draggedTabId || this.draggedTabId === tab.dataset.id) return;

        e.dataTransfer.dropEffect = 'move';

        // Determine drop position based on mouse position
        const rect = tab.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const isLeftHalf = e.clientX < midpoint;

        // Update visual indicator
        tab.classList.toggle('drag-over-left', isLeftHalf);
        tab.classList.toggle('drag-over-right', !isLeftHalf);
      });

      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over-left', 'drag-over-right');
      });

      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over-left', 'drag-over-right');

        if (!this.draggedTabId || this.draggedTabId === tab.dataset.id) return;

        const targetId = tab.dataset.id;
        const draggedId = this.draggedTabId;

        // Determine insertion position
        const rect = tab.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const insertBefore = e.clientX < midpoint;

        // Reorder sessionOrder array
        const fromIndex = this.sessionOrder.indexOf(draggedId);
        let toIndex = this.sessionOrder.indexOf(targetId);

        if (fromIndex === -1 || toIndex === -1) return;

        // Remove dragged item
        this.sessionOrder.splice(fromIndex, 1);

        // Recalculate target index after removal
        toIndex = this.sessionOrder.indexOf(targetId);
        if (toIndex === -1) return;

        // Insert at correct position
        if (insertBefore) {
          this.sessionOrder.splice(toIndex, 0, draggedId);
        } else {
          this.sessionOrder.splice(toIndex + 1, 0, draggedId);
        }

        // Save and re-render
        this.saveSessionOrder();
        this._fullRenderSessionTabs();
      });
    });
  }


  getSessionName(session) {
    // Use custom name if set
    if (session.name) {
      return session.name;
    }
    // Fall back to directory name
    if (session.workingDir) {
      return session.workingDir.split('/').pop() || session.workingDir;
    }
    return session.id.slice(0, 8);
  }

  async selectSession(sessionId) {
    if (this.activeSessionId === sessionId) return;

    const selectGen = ++this._selectGeneration;

    if (selectGen !== this._selectGeneration) return; // newer tab switch won

    // Clean up flicker filter state when switching sessions
    if (this.flickerFilterTimeout) {
      clearTimeout(this.flickerFilterTimeout);
      this.flickerFilterTimeout = null;
    }
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;

    // Clear tab completion detection flag — don't carry across sessions
    this._tabCompletionSessionId = null;
    this._tabCompletionRetries = 0;
    this._tabCompletionBaseText = null;
    if (this._tabCompletionFallback) { clearTimeout(this._tabCompletionFallback); this._tabCompletionFallback = null; }

    // Clean up pending terminal writes to prevent old session data from appearing in new session
    if (this.syncWaitTimeout) {
      clearTimeout(this.syncWaitTimeout);
      this.syncWaitTimeout = null;
    }
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    // End any in-flight IME composition.
    // iOS Safari keeps autocorrect composing; switching tabs without ending it
    // leaves xterm's _compositionHelper._isComposing stuck true, which blocks
    // keyboard input when the user returns to this tab.
    try {
      const ch = this.terminal?._core?._compositionHelper;
      if (ch?._isComposing) {
        ch._isComposing = false;
        // Also fire compositionend on the textarea so any other listeners reset
        const ta = this.terminal?.element?.querySelector('.xterm-helper-textarea');
        if (ta) ta.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
      }
    } catch {}

    // Flush local echo text to PTY before switching tabs.
    // Send as a single batch (no Enter) so it lands in the session's readline
    // input buffer — avoids "old text resent on Enter" and overlay render bugs.
    // Track flushed length so _render() offsets the overlay correctly even before
    // the PTY echo arrives in the terminal buffer.
    if (this.activeSessionId) {
      const echoText = this._localEchoOverlay?.pendingText || '';
      // Include buffer-detected flushed text (from Tab completion, etc.)
      // so it's preserved across tab switches.
      const existingFlushed = this._localEchoOverlay?.getFlushed()?.count || 0;
      const existingFlushedText = this._localEchoOverlay?.getFlushed()?.text || '';
      if (echoText) {
        this._sendInputAsync(this.activeSessionId, echoText);
      }
      const totalOffset = existingFlushed + echoText.length;
      if (totalOffset > 0) {
        if (!this._flushedOffsets) this._flushedOffsets = new Map();
        if (!this._flushedTexts) this._flushedTexts = new Map();
        this._flushedOffsets.set(this.activeSessionId, totalOffset);
        this._flushedTexts.set(this.activeSessionId, existingFlushedText + echoText);
      }
    }
    this._localEchoOverlay?.clear();
    // Prevent _detectBufferText() from picking up Claude's Ink UI text
    // (status bar, model info, etc.) as "user input" on fresh sessions.
    // Only sessions with prior flushed text (from tab-switch-away) need detection.
    // After the user's first Enter, clear() resets _bufferDetectDone = false,
    // re-enabling detection for tab completion and other legitimate cases.
    if (this._localEchoOverlay && !this._flushedOffsets?.has(sessionId)) {
      this._localEchoOverlay.suppressBufferDetection();
    }
    this.activeSessionId = sessionId;
    try { localStorage.setItem('codeman-active-session', sessionId); } catch {}
    this.hideWelcome();
    // Clear idle hooks on view, but keep action hooks until user interacts
    this.clearPendingHooks(sessionId, 'idle_prompt');
    // Instant active-class toggle (no 100ms debounce), then schedule full render for badges/status
    this._updateActiveTabImmediate(sessionId);
    this.renderSessionTabs();
    this._updateLocalEchoState();

    // Restore flushed offset AND text IMMEDIATELY so backspace/typing work during
    // the async buffer load.  Without this, the offset is 0 during the
    // fetch() gap: backspace is swallowed, and typing a space covers the
    // canvas text with an opaque overlay showing only the new char.
    if (this._flushedOffsets?.has(sessionId) && this._localEchoOverlay) {
      this._localEchoOverlay.setFlushed(
        this._flushedOffsets.get(sessionId),
        this._flushedTexts?.get(sessionId) || '',
        false  // render=false: buffer not loaded yet
      );
    }

    // Glow the newly-active tab
    const activeTab = document.querySelector(`.session-tab.active[data-id="${sessionId}"]`);
    if (activeTab) {
      activeTab.classList.add('tab-glow');
      activeTab.addEventListener('animationend', () => activeTab.classList.remove('tab-glow'), { once: true });
    }

    // Check if this is a restored session that needs to be attached
    const session = this.sessions.get(sessionId);

    // Track working directory for path normalization in Project Insights
    this.currentSessionWorkingDir = session?.workingDir || null;
    if (session && session.pid === null && session.status === 'idle') {
      // This is a restored session - attach to the existing screen
      try {
        await fetch(`/api/sessions/${sessionId}/interactive`, { method: 'POST' });
        // Update local session state
        session.status = 'busy';
      } catch (err) {
        console.error('Failed to attach to restored session:', err);
      }
    }

    // Load terminal buffer for this session
    // Show cached content instantly while fetching fresh data in background.
    // Use tail mode for faster initial load (256KB is enough for recent visible content).
    //
    // Protect flushed state during buffer load: terminal.write() can trigger
    // xterm.js onData responses (DA, OSC, etc.) that would otherwise clear
    // the flushed Maps via the control char handler.  The multi-byte ESC
    // filter catches most cases, but _restoringFlushedState provides a
    // belt-and-suspenders guard for any edge cases.
    this._restoringFlushedState = true;
    try {
      // Instant cache restore — show previous buffer immediately while network fetch runs
      const cachedBuffer = this.terminalBufferCache.get(sessionId);
      if (cachedBuffer) {
        this.terminal.clear();
        this.terminal.reset();
        this.terminal.write(cachedBuffer);
        this.terminal.scrollToBottom();
      }

      const tailSize = 256 * 1024;
      const res = await fetch(`/api/sessions/${sessionId}/terminal?tail=${tailSize}`);
      if (selectGen !== this._selectGeneration) { this._restoringFlushedState = false; return; }
      const data = await res.json();

      if (data.terminalBuffer) {
        // Skip rewrite if fresh buffer matches cache — avoids visible clear+rewrite flash.
        // On slow connections (mobile 5G), the gap between clear() and chunkedWrite() is
        // very visible, causing the terminal to flash blank then repaint.
        const needsRewrite = data.terminalBuffer !== cachedBuffer;
        if (needsRewrite) {
          this.terminal.clear();
          this.terminal.reset();
          // Show truncation indicator if buffer was cut
          if (data.truncated) {
            this.terminal.write('\x1b[90m... (earlier output truncated for performance) ...\x1b[0m\r\n\r\n');
          }
          // Use chunked write for large buffers to avoid UI jank
          await this.chunkedTerminalWrite(data.terminalBuffer);
          if (selectGen !== this._selectGeneration) { this._restoringFlushedState = false; return; }
          // Ensure terminal is scrolled to bottom after buffer load
          this.terminal.scrollToBottom();
        }

        // Update cache (cap at 20 entries)
        this.terminalBufferCache.set(sessionId, data.terminalBuffer);
        if (this.terminalBufferCache.size > 20) {
          // Evict oldest entry (first key in Map iteration order)
          const oldest = this.terminalBufferCache.keys().next().value;
          this.terminalBufferCache.delete(oldest);
        }
      } else if (!cachedBuffer) {
        // No fresh buffer and no cache — clear any stale content
        this.terminal.clear();
        this.terminal.reset();
      }

      // Buffer load complete — drop the guard so user input clears state normally
      this._restoringFlushedState = false;

      // Restore flushed offset and text for this session so the overlay positions
      // correctly even before the PTY echo arrives in the terminal buffer.
      if (this._flushedOffsets?.has(sessionId) && this._localEchoOverlay) {
        this._localEchoOverlay.setFlushed(
          this._flushedOffsets.get(sessionId),
          this._flushedTexts?.get(sessionId) || '',
          false  // render=false: buffer just loaded, defer to rerender
        );
        // Trigger render after xterm.js finishes processing the buffer data.
        // terminal.write('', callback) fires the callback after ALL previously
        // queued writes have been parsed — so findPrompt() can find ❯ in the buffer.
        const zl = this._localEchoOverlay;
        this.terminal.write('', () => {
          if (zl.hasPending) zl.rerender();
        });
      }

      // Fire-and-forget resize — don't await to avoid blocking UI.
      // The resize triggers an Ink redraw in Claude which streams back via SSE.
      this.sendResize(sessionId);

      // Defer secondary panel updates so they don't block the main thread
      // after terminal content is already visible.
      const idleCb = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb) => setTimeout(cb, 16);
      idleCb(() => {
        // Guard against stale generation — user may have switched tabs again
        if (selectGen !== this._selectGeneration) return;

        // Update respawn banner
        if (this.respawnStatus[sessionId]) {
          this.showRespawnBanner();
          this.updateRespawnBanner(this.respawnStatus[sessionId].state);
          document.getElementById('respawnCycleCount').textContent = this.respawnStatus[sessionId].cycleCount || 0;
          this.updateCountdownTimerDisplay();
          this.updateActionLogDisplay();
          if (Object.keys(this.respawnCountdownTimers[sessionId] || {}).length > 0) {
            this.startCountdownInterval();
          }
        } else {
          this.hideRespawnBanner();
          this.stopCountdownInterval();
        }

        // Update task panel if open
        const taskPanel = document.getElementById('taskPanel');
        if (taskPanel && taskPanel.classList.contains('open')) {
          this.renderTaskPanel();
        }

        // Update ralph state panel for this session
        const curSession = this.sessions.get(sessionId);
        if (curSession && (curSession.ralphLoop || curSession.ralphTodos)) {
          this.updateRalphState(sessionId, {
            loop: curSession.ralphLoop,
            todos: curSession.ralphTodos
          });
        }
        this.renderRalphStatePanel();

        // Update CLI info bar (mobile - shows Claude version/model)
        this.updateCliInfoDisplay();

        // Update project insights panel for this session
        this.renderProjectInsightsPanel();

        // Update subagent window visibility for active session
        this.updateSubagentWindowVisibility();

        // Load file browser if enabled
        const settings = this.loadAppSettingsFromStorage();
        if (settings.showFileBrowser) {
          const fileBrowserPanel = this.$('fileBrowserPanel');
          if (fileBrowserPanel) {
            fileBrowserPanel.classList.add('visible');
            this.loadFileBrowser(sessionId);
          }
        }
      });

      this.terminal.focus();
      this.terminal.scrollToBottom();
    } catch (err) {
      this._restoringFlushedState = false;
      console.error('Failed to load session terminal:', err);
    }
  }

  // Shared cleanup for all session data — called from both closeSession() and session:deleted handler
  _cleanupSessionData(sessionId) {
    this.sessions.delete(sessionId);
    // Remove from tab order
    const orderIndex = this.sessionOrder.indexOf(sessionId);
    if (orderIndex !== -1) {
      this.sessionOrder.splice(orderIndex, 1);
      this.saveSessionOrder();
    }
    this.terminalBuffers.delete(sessionId);
    this.terminalBufferCache.delete(sessionId);

    this._flushedOffsets?.delete(sessionId);
    this._flushedTexts?.delete(sessionId);
    this._inputQueue.delete(sessionId);
    this.ralphStates.delete(sessionId);
    this.ralphClosedSessions.delete(sessionId);
    this.projectInsights.delete(sessionId);
    this.pendingHooks.delete(sessionId);
    this.tabAlerts.delete(sessionId);
    this.clearCountdownTimers(sessionId);
    this.closeSessionLogViewerWindows(sessionId);
    this.closeSessionImagePopups(sessionId);
    this.closeSessionSubagentWindows(sessionId, true);

    // Clean up idle timer
    const idleTimer = this.idleTimers.get(sessionId);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(sessionId);
    }
    // Clean up respawn state
    delete this.respawnStatus[sessionId];
    delete this.respawnTimers[sessionId];
    delete this.respawnCountdownTimers[sessionId];
    delete this.respawnActionLogs[sessionId];
  }

  async closeSession(sessionId, killMux = true) {
    try {
      await this._apiDelete(`/api/sessions/${sessionId}?killMux=${killMux}`);
      this._cleanupSessionData(sessionId);

      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        // Select another session or show welcome (use sessionOrder for consistent ordering)
        if (this.sessionOrder.length > 0 && this.sessions.size > 0) {
          const nextSessionId = this.sessionOrder[0];
          this.selectSession(nextSessionId);
        } else {
          this.terminal.clear();
          this.showWelcome();
          this.renderRalphStatePanel();  // Clear ralph panel when no sessions
        }
      }

      this.renderSessionTabs();

      if (killMux) {
        this.showToast('Session closed and tmux killed', 'success');
      } else {
        this.showToast('Tab hidden, tmux still running', 'info');
      }
    } catch (err) {
      this.showToast('Failed to close session', 'error');
    }
  }

  // Request confirmation before closing a session
  requestCloseSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.pendingCloseSessionId = sessionId;

    // Show session name in confirmation dialog
    const name = this.getSessionName(session);
    const sessionNameEl = document.getElementById('closeConfirmSessionName');
    sessionNameEl.textContent = name;

    // Update kill button text based on session mode
    const killTitle = document.getElementById('closeConfirmKillTitle');
    if (killTitle) {
      killTitle.textContent = session.mode === 'opencode'
        ? 'Kill Tmux & OpenCode'
        : 'Kill Tmux & Claude Code';
    }

    document.getElementById('closeConfirmModal').classList.add('active');
  }

  cancelCloseSession() {
    this.pendingCloseSessionId = null;
    document.getElementById('closeConfirmModal').classList.remove('active');
  }

  async confirmCloseSession(killMux = true) {
    const sessionId = this.pendingCloseSessionId;
    this.cancelCloseSession();

    if (sessionId) {
      await this.closeSession(sessionId, killMux);
    }
  }

  nextSession() {
    if (this.sessionOrder.length <= 1) return;

    const currentIndex = this.sessionOrder.indexOf(this.activeSessionId);
    const nextIndex = (currentIndex + 1) % this.sessionOrder.length;
    this.selectSession(this.sessionOrder[nextIndex]);
  }

  prevSession() {
    if (this.sessionOrder.length <= 1) return;

    const currentIndex = this.sessionOrder.indexOf(this.activeSessionId);
    const prevIndex = (currentIndex - 1 + this.sessionOrder.length) % this.sessionOrder.length;
    this.selectSession(this.sessionOrder[prevIndex]);
  }

  // ========== Navigation ==========

  goHome() {
    // Deselect active session and show welcome screen
    this.activeSessionId = null;
    try { localStorage.removeItem('codeman-active-session'); } catch {}
    this.terminal.clear();
    this.showWelcome();
    this.renderSessionTabs();
    this.renderRalphStatePanel();
  }

  // ========== Ralph Loop Wizard (methods in ralph-wizard.js) ==========

  // Wizard state (initialized here, methods loaded from ralph-wizard.js)
  ralphWizardStep = 1;
  ralphWizardConfig = {
    taskDescription: '',
    completionPhrase: 'COMPLETE',
    maxIterations: 10,
    caseName: 'testcase',
    enableRespawn: false,
    generatedPlan: null,
    planGenerated: false,
    skipPlanGeneration: false,
    planDetailLevel: 'detailed',
    existingPlan: null,
    useExistingPlan: false,
  };
  planLoadingTimer = null;
  planLoadingStartTime = null;

  // ========== Quick Start ==========

  async loadQuickStartCases(selectCaseName = null, settingsPromise = null) {
    try {
      // Load settings to get lastUsedCase (reuse shared promise if provided)
      let lastUsedCase = null;
      try {
        const settings = settingsPromise ? await settingsPromise : await fetch('/api/settings').then(r => r.ok ? r.json() : null);
        if (settings) {
          lastUsedCase = settings.lastUsedCase || null;
        }
      } catch {
        // Ignore settings load errors
      }

      const res = await fetch('/api/cases');
      const cases = await res.json();
      this.cases = cases;
      console.log('[loadQuickStartCases] Loaded cases:', cases.map(c => c.name), 'lastUsedCase:', lastUsedCase);

      const select = document.getElementById('quickStartCase');

      // Build options - existing cases first, then testcase as fallback if not present
      let options = '';
      const hasTestcase = cases.some(c => c.name === 'testcase');
      const isMobile = MobileDetection.getDeviceType() === 'mobile';
      const maxNameLength = isMobile ? 8 : 20; // Truncate to 8 chars on mobile

      cases.forEach(c => {
        const displayName = c.name.length > maxNameLength
          ? c.name.substring(0, maxNameLength) + '…'
          : c.name;
        options += `<option value="${escapeHtml(c.name)}">${escapeHtml(displayName)}</option>`;
      });

      // Add testcase option if it doesn't exist (will be created on first run)
      if (!hasTestcase) {
        options = `<option value="testcase">testcase</option>` + options;
      }

      select.innerHTML = options;
      console.log('[loadQuickStartCases] Set options:', select.innerHTML.substring(0, 200));

      // If a specific case was requested, select it
      if (selectCaseName) {
        select.value = selectCaseName;
        this.updateDirDisplayForCase(selectCaseName);
        this.updateMobileCaseLabel(selectCaseName);
      } else if (lastUsedCase && cases.some(c => c.name === lastUsedCase)) {
        // Use lastUsedCase if available and exists
        select.value = lastUsedCase;
        this.updateDirDisplayForCase(lastUsedCase);
        this.updateMobileCaseLabel(lastUsedCase);
      } else if (cases.length > 0) {
        // Fallback to testcase or first case
        const firstCase = cases.find(c => c.name === 'testcase') || cases[0];
        select.value = firstCase.name;
        this.updateDirDisplayForCase(firstCase.name);
        this.updateMobileCaseLabel(firstCase.name);
      } else {
        // No cases exist yet - show the default case name as directory
        select.value = 'testcase';
        document.getElementById('dirDisplay').textContent = '~/codeman-cases/testcase';
        this.updateMobileCaseLabel('testcase');
      }

      // Only add event listener once (on first load)
      if (!select.dataset.listenerAdded) {
        select.addEventListener('change', () => {
          this.updateDirDisplayForCase(select.value);
          this.saveLastUsedCase(select.value);
          this.updateMobileCaseLabel(select.value);
        });
        select.dataset.listenerAdded = 'true';
      }
    } catch (err) {
      console.error('Failed to load cases:', err);
    }
  }

  async updateDirDisplayForCase(caseName) {
    try {
      const res = await fetch(`/api/cases/${caseName}`);
      const data = await res.json();
      if (data.path) {
        document.getElementById('dirDisplay').textContent = data.path;
        document.getElementById('dirInput').value = data.path;
      }
    } catch (err) {
      document.getElementById('dirDisplay').textContent = caseName;
    }
  }

  async saveLastUsedCase(caseName) {
    try {
      // Get current settings
      const res = await fetch('/api/settings');
      const settings = res.ok ? await res.json() : {};
      // Update lastUsedCase
      settings.lastUsedCase = caseName;
      // Save back
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
    } catch (err) {
      console.error('Failed to save last used case:', err);
    }
  }

  async quickStart() {
    return this.run();
  }

  /** Run using the selected mode (Claude Code or OpenCode) */
  async run() {
    const mode = this._runMode || 'claude';
    if (mode === 'opencode') {
      return this.runOpenCode();
    }
    return this.runClaude();
  }

  /** Get/set the run mode, persisted in localStorage */
  get runMode() { return this._runMode || 'claude'; }

  setRunMode(mode) {
    this._runMode = mode;
    try { localStorage.setItem('codeman_runMode', mode); } catch {}
    this._applyRunMode();
    // Close menu
    document.getElementById('runModeMenu')?.classList.remove('active');
  }

  toggleRunModeMenu(e) {
    e?.stopPropagation();
    const menu = document.getElementById('runModeMenu');
    if (!menu) return;
    menu.classList.toggle('active');
    // Update selected state
    menu.querySelectorAll('.run-mode-option').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.mode === this.runMode);
    });
    // Close on click outside
    if (menu.classList.contains('active')) {
      const close = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.classList.remove('active');
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  }

  _applyRunMode() {
    const mode = this.runMode;
    const runBtn = document.getElementById('runBtn');
    const gearBtn = runBtn?.nextElementSibling;
    const label = document.getElementById('runBtnLabel');
    if (runBtn) {
      runBtn.className = `btn-toolbar btn-run mode-${mode}`;
    }
    if (gearBtn) {
      gearBtn.className = `btn-toolbar btn-run-gear mode-${mode}`;
    }
    if (label) {
      label.textContent = mode === 'opencode' ? 'Run OC' : 'Run';
    }
  }

  _initRunMode() {
    try { this._runMode = localStorage.getItem('codeman_runMode') || 'claude'; } catch { this._runMode = 'claude'; }
    this._applyRunMode();
  }

  // Tab count stepper functions
  incrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(20, current + 1);
  }

  decrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  }

  // Shell count stepper functions
  incrementShellCount() {
    const input = document.getElementById('shellCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(20, current + 1);
  }

  decrementShellCount() {
    const input = document.getElementById('shellCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  }

  async runClaude() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const tabCount = Math.min(20, Math.max(1, parseInt(document.getElementById('tabCount').value) || 1));

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting ${tabCount} Claude session(s) in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Get case path first
      const caseRes = await fetch(`/api/cases/${caseName}`);
      let caseData = await caseRes.json();

      // Create the case if it doesn't exist
      if (!caseData.path) {
        const createCaseRes = await fetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName, description: '' })
        });
        const createCaseData = await createCaseRes.json();
        if (!createCaseData.success) throw new Error(createCaseData.error || 'Failed to create case');
        // Use the newly created case data (API returns { success, case: { name, path } })
        caseData = createCaseData.case;
      }

      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');
      let firstSessionId = null;

      // Find the highest existing w-number for THIS case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^w(\d+)-(.+)$/);
        if (match && match[2] === caseName) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Get global Ralph tracker setting
      const ralphEnabled = this.isRalphTrackerEnabledByDefault();

      // Create all sessions in parallel for speed
      const sessionNames = [];
      for (let i = 0; i < tabCount; i++) {
        sessionNames.push(`w${startNumber + i}-${caseName}`);
      }

      // Build env overrides from global + case settings (case overrides global)
      const caseSettings = this.getCaseSettings(caseName);
      const globalSettings = this.loadAppSettingsFromStorage();
      const envOverrides = {};
      if (caseSettings.agentTeams || globalSettings.agentTeamsEnabled) {
        envOverrides.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      }
      const hasEnvOverrides = Object.keys(envOverrides).length > 0;

      // Step 1: Create all sessions in parallel
      this.terminal.writeln(`\x1b[90m Creating ${tabCount} session(s)...\x1b[0m`);
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir, name, ...(hasEnvOverrides ? { envOverrides } : {}) })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      // Collect created session IDs
      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        sessionIds.push(result.session.id);
      }
      firstSessionId = sessionIds[0];

      // Step 2: Configure Ralph for all sessions in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/ralph-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: ralphEnabled, disableAutoEnable: !ralphEnabled })
        })
      ));

      // Step 3: Start all sessions in parallel (biggest speedup)
      this.terminal.writeln(`\x1b[90m Starting ${tabCount} session(s) in parallel...\x1b[0m`);
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/interactive`, { method: 'POST' })
      ));

      this.terminal.writeln(`\x1b[90m All ${tabCount} sessions ready\x1b[0m`);

      // Auto-switch to the new session using selectSession (does proper refresh)
      if (firstSessionId) {
        await this.selectSession(firstSessionId);
        this.loadQuickStartCases();
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  }

  /** Send Ctrl+C to the active session to stop the current operation.
   *  Requires double-tap: first tap turns button amber, second tap within 2s sends Ctrl+C. */
  stopClaude() {
    if (!this.activeSessionId) return;
    const btn = document.querySelector('.btn-toolbar.btn-stop');
    if (!btn) return;

    if (this._stopConfirmTimer) {
      // Second tap — send Ctrl+C
      clearTimeout(this._stopConfirmTimer);
      this._stopConfirmTimer = null;
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
      btn.classList.remove('confirming');
      fetch(`/api/sessions/${this.activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x03' })
      });
    } else {
      // First tap — enter confirm state
      btn.dataset.origHtml = btn.innerHTML;
      btn.textContent = 'Tap again';
      btn.classList.add('confirming');
      this._stopConfirmTimer = setTimeout(() => {
        this._stopConfirmTimer = null;
        if (btn.dataset.origHtml) {
          btn.innerHTML = btn.dataset.origHtml;
          delete btn.dataset.origHtml;
        }
        btn.classList.remove('confirming');
      }, 2000);
    }
  }

  async runShell() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const shellCount = Math.min(20, Math.max(1, parseInt(document.getElementById('shellCount').value) || 1));

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;33m Starting ${shellCount} Shell session(s) in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Get the case path
      const caseRes = await fetch(`/api/cases/${caseName}`);
      const caseData = await caseRes.json();
      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');

      // Find the highest existing s-number for THIS case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^s(\d+)-(.+)$/);
        if (match && match[2] === caseName) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Create all shell sessions in parallel
      const sessionNames = [];
      for (let i = 0; i < shellCount; i++) {
        sessionNames.push(`s${startNumber + i}-${caseName}`);
      }

      // Step 1: Create all sessions in parallel
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir, mode: 'shell', name })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        sessionIds.push(result.session.id);
      }

      // Step 2: Start all shells in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/shell`, { method: 'POST' })
      ));

      // Step 3: Resize all in parallel (with minimum dimension enforcement)
      const dims = this.getTerminalDimensions();
      if (dims) {
        await Promise.all(sessionIds.map(id =>
          fetch(`/api/sessions/${id}/resize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dims)
          })
        ));
      }

      // Switch to first session
      if (sessionIds.length > 0) {
        this.activeSessionId = sessionIds[0];
        await this.selectSession(sessionIds[0]);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  }

  async runOpenCode() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting OpenCode session in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Check if OpenCode is available
      const statusRes = await fetch('/api/opencode/status');
      const status = await statusRes.json();
      if (!status.available) {
        this.terminal.writeln('\x1b[1;31m OpenCode CLI not found.\x1b[0m');
        this.terminal.writeln('\x1b[90m Install with: curl -fsSL https://opencode.ai/install | bash\x1b[0m');
        return;
      }

      // Quick-start with opencode mode (auto-allow tools by default)
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'opencode',
          openCodeConfig: { autoAllowTools: true },
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start OpenCode');

      // Switch to the new session (don't pre-set activeSessionId — selectSession
      // early-returns when IDs match, skipping buffer load and sendResize)
      if (data.sessionId) {
        await this.selectSession(data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  }

  // ========== Directory Input ==========

  toggleDirInput() {
    const btn = document.querySelector('#dirDisplay').parentElement;
    const input = document.getElementById('dirInput');

    if (input.classList.contains('hidden')) {
      input.classList.remove('hidden');
      btn.style.display = 'none';
      input.focus();
    }
  }

  hideDirInput() {
    const btn = document.querySelector('#dirDisplay').parentElement;
    const input = document.getElementById('dirInput');

    setTimeout(() => {
      input.classList.add('hidden');
      btn.style.display = '';

      const value = input.value.trim();
      document.getElementById('dirDisplay').textContent = value || 'No directory';
    }, 100);
  }

  // ========== Respawn Banner ==========

  showRespawnBanner() {
    this.$('respawnBanner').style.display = 'flex';
    // Also show timer if there's a timed respawn
    if (this.activeSessionId && this.respawnTimers[this.activeSessionId]) {
      this.showRespawnTimer();
    }
    // Show tokens if session has token data
    const session = this.sessions.get(this.activeSessionId);
    if (session && session.tokens) {
      this.updateRespawnTokens(session.tokens);
    }
  }

  hideRespawnBanner() {
    this.$('respawnBanner').style.display = 'none';
    this.hideRespawnTimer();
  }

  // Human-friendly state labels
  getStateLabel(state) {
    const labels = {
      'stopped': 'Stopped',
      'watching': 'Watching',
      'confirming_idle': 'Confirming idle',
      'ai_checking': 'AI checking',
      'sending_update': 'Sending prompt',
      'waiting_update': 'Running prompt',
      'sending_clear': 'Clearing context',
      'waiting_clear': 'Clearing...',
      'sending_init': 'Initializing',
      'waiting_init': 'Initializing...',
      'monitoring_init': 'Waiting for work',
      'sending_kickstart': 'Kickstarting',
      'waiting_kickstart': 'Kickstarting...',
    };
    return labels[state] || state.replace(/_/g, ' ');
  }

  updateRespawnBanner(state) {
    const stateEl = this.$('respawnState');
    stateEl.textContent = this.getStateLabel(state);
    // Clear blocked state when state changes (resumed from blocked)
    stateEl.classList.remove('respawn-blocked');
  }

  updateDetectionDisplay(detection) {
    if (!detection) return;

    const statusEl = this.$('detectionStatus');
    const waitingEl = this.$('detectionWaiting');
    const confidenceEl = this.$('detectionConfidence');
    const aiCheckEl = document.getElementById('detectionAiCheck');
    const hookEl = document.getElementById('detectionHook');

    // Hook-based detection indicator (highest priority signals)
    if (hookEl) {
      if (detection.stopHookReceived || detection.idlePromptReceived) {
        const hookType = detection.idlePromptReceived ? 'idle' : 'stop';
        hookEl.textContent = `🎯 ${hookType} hook`;
        hookEl.className = 'detection-hook hook-active';
        hookEl.style.display = '';
      } else {
        hookEl.style.display = 'none';
      }
    }

    // Simplified status - only show when meaningful
    if (detection.statusText && detection.statusText !== 'Watching...') {
      statusEl.textContent = detection.statusText;
      statusEl.style.display = '';
    } else {
      statusEl.style.display = 'none';
    }

    // Hide "waiting for" text - it's redundant with the state label
    waitingEl.style.display = 'none';

    // Show confidence only when confirming (>0%)
    const confidence = detection.confidenceLevel || 0;
    if (confidence > 0) {
      confidenceEl.textContent = `${confidence}%`;
      confidenceEl.style.display = '';
      confidenceEl.className = 'detection-confidence';
      // Hook signals give 100% confidence
      if (detection.stopHookReceived || detection.idlePromptReceived) {
        confidenceEl.classList.add('hook-confirmed');
      } else if (confidence >= 60) {
        confidenceEl.classList.add('high');
      } else if (confidence >= 30) {
        confidenceEl.classList.add('medium');
      }
    } else {
      confidenceEl.style.display = 'none';
    }

    // AI check display - compact format
    if (aiCheckEl && detection.aiCheck) {
      const ai = detection.aiCheck;
      let aiText = '';
      let aiClass = 'detection-ai-check';

      if (ai.status === 'checking') {
        aiText = '🔍 AI checking...';
        aiClass += ' ai-checking';
      } else if (ai.status === 'cooldown' && ai.cooldownEndsAt) {
        const remaining = Math.ceil((ai.cooldownEndsAt - Date.now()) / 1000);
        if (remaining > 0) {
          if (ai.lastVerdict === 'WORKING') {
            aiText = `⏳ Working, retry ${remaining}s`;
            aiClass += ' ai-working';
          } else {
            aiText = `✓ Idle, wait ${remaining}s`;
            aiClass += ' ai-idle';
          }
        }
      } else if (ai.status === 'disabled') {
        aiText = '⚠ AI disabled';
        aiClass += ' ai-disabled';
      } else if (ai.lastVerdict && ai.lastCheckTime) {
        const ago = Math.round((Date.now() - ai.lastCheckTime) / 1000);
        if (ago < 120) {
          aiText = ai.lastVerdict === 'IDLE'
            ? `✓ Idle (${ago}s)`
            : `⏳ Working (${ago}s)`;
          aiClass += ai.lastVerdict === 'IDLE' ? ' ai-idle' : ' ai-working';
        }
      }

      aiCheckEl.textContent = aiText;
      aiCheckEl.className = aiClass;
      aiCheckEl.style.display = aiText ? '' : 'none';
    } else if (aiCheckEl) {
      aiCheckEl.style.display = 'none';
    }

    // Manage row2 visibility - hide if nothing visible
    const row2 = this.$('respawnStatusRow2');
    if (row2) {
      const hasVisibleContent =
        (hookEl && hookEl.style.display !== 'none') ||
        (aiCheckEl && aiCheckEl.style.display !== 'none') ||
        (statusEl && statusEl.style.display !== 'none') ||
        (this.respawnCountdownTimers[this.activeSessionId] &&
         Object.keys(this.respawnCountdownTimers[this.activeSessionId]).length > 0);
      row2.style.display = hasVisibleContent ? '' : 'none';
    }
  }

  showRespawnTimer() {
    const timerEl = this.$('respawnTimer');
    timerEl.style.display = '';
    this.updateRespawnTimer();
    // Update every second
    if (this.respawnTimerInterval) clearInterval(this.respawnTimerInterval);
    this.respawnTimerInterval = setInterval(() => this.updateRespawnTimer(), 1000);
  }

  hideRespawnTimer() {
    this.$('respawnTimer').style.display = 'none';
    if (this.respawnTimerInterval) {
      clearInterval(this.respawnTimerInterval);
      this.respawnTimerInterval = null;
    }
  }

  updateRespawnTimer() {
    if (!this.activeSessionId || !this.respawnTimers[this.activeSessionId]) {
      this.hideRespawnTimer();
      return;
    }

    const timer = this.respawnTimers[this.activeSessionId];
    // Guard against invalid timer data
    if (!timer.endAt || isNaN(timer.endAt)) {
      this.hideRespawnTimer();
      return;
    }

    const now = Date.now();
    const remaining = Math.max(0, timer.endAt - now);

    if (remaining <= 0) {
      this.$('respawnTimer').textContent = 'Time up';
      delete this.respawnTimers[this.activeSessionId];
      this.hideRespawnTimer();
      return;
    }

    this.$('respawnTimer').textContent = this.formatTime(remaining);
  }

  updateRespawnTokens(tokens) {
    // Skip if tokens haven't changed (avoid unnecessary DOM writes)
    const isObject = tokens && typeof tokens === 'object';
    const total = isObject ? tokens.total : tokens;
    if (total === this._lastRespawnTokenTotal) return;
    this._lastRespawnTokenTotal = total;

    const tokensEl = this.$('respawnTokens');
    const input = isObject ? (tokens.input || 0) : Math.round(total * 0.6);
    const output = isObject ? (tokens.output || 0) : Math.round(total * 0.4);

    if (total > 0) {
      tokensEl.style.display = '';
      const tokenStr = this.formatTokens(total);
      const settings = this.loadAppSettingsFromStorage();
      const showCost = settings.showCost ?? false;
      if (showCost) {
        const estimatedCost = this.estimateCost(input, output);
        tokensEl.textContent = `${tokenStr} tokens · $${estimatedCost.toFixed(2)}`;
      } else {
        tokensEl.textContent = `${tokenStr} tokens`;
      }
    } else {
      tokensEl.style.display = 'none';
    }

    // Also update mobile CLI info bar (shows tokens on mobile)
    this.updateCliInfoDisplay();
  }

  // Update CLI info display (tokens, version, model - shown on mobile)
  updateCliInfoDisplay() {
    const infoBar = this.$('cliInfoBar');
    if (!infoBar) return;

    const session = this.sessions.get(this.activeSessionId);
    if (!session) {
      infoBar.style.display = 'none';
      return;
    }

    // Build display parts - tokens first (most important on mobile)
    let parts = [];

    // Add tokens if available
    if (session.tokens) {
      const total = typeof session.tokens === 'object' ? session.tokens.total : session.tokens;
      if (total > 0) {
        parts.push(`${this.formatTokens(total)} tokens`);
      }
    }

    // Add model (condensed)
    if (session.cliModel) {
      // Shorten model names for mobile: "claude-sonnet-4-20250514" -> "Sonnet 4"
      let model = session.cliModel;
      if (model.includes('opus')) model = 'Opus';
      else if (model.includes('sonnet')) model = 'Sonnet';
      else if (model.includes('haiku')) model = 'Haiku';
      parts.push(model);
    }

    // Add version (compact format)
    if (session.cliVersion) {
      // Show "v2.1.27" or "v2.1.27 ↑" if update available
      let versionStr = `v${session.cliVersion}`;
      if (session.cliLatestVersion && session.cliLatestVersion !== session.cliVersion) {
        versionStr += ' ↑'; // Arrow indicates update available
      }
      parts.push(versionStr);
    }

    if (parts.length > 0) {
      infoBar.textContent = parts.join(' · ');
      infoBar.style.display = '';
    } else {
      infoBar.style.display = 'none';
    }
  }

  // ========== Countdown Timer Display Methods ==========

  addActionLogEntry(sessionId, action) {
    // Only keep truly interesting events - no spam
    // KEEP: command (inputs), hook events, AI verdicts, plan verdicts
    // SKIP: timer, timer-cancel, state changes, routine detection, step confirmations

    const interestingTypes = ['command', 'hook'];

    // Always keep commands and hooks
    if (interestingTypes.includes(action.type)) {
      // ok, keep it
    }
    // AI check: only verdicts (IDLE, WORKING) and errors, not "Spawning"
    else if (action.type === 'ai-check') {
      if (action.detail.includes('Spawning')) return;
    }
    // Plan check: only verdicts, not "Spawning"
    else if (action.type === 'plan-check') {
      if (action.detail.includes('Spawning')) return;
    }
    // Transcript: keep completion/plan detection
    else if (action.type === 'transcript') {
      // keep it
    }
    // Skip everything else (timer, timer-cancel, state, detection, step)
    else {
      return;
    }

    if (!this.respawnActionLogs[sessionId]) {
      this.respawnActionLogs[sessionId] = [];
    }
    this.respawnActionLogs[sessionId].unshift(action);
    // Keep reasonable history
    if (this.respawnActionLogs[sessionId].length > 30) {
      this.respawnActionLogs[sessionId].pop();
    }
  }

  startCountdownInterval() {
    if (this.timerCountdownInterval) return;
    this.timerCountdownInterval = setInterval(() => {
      if (this.activeSessionId && this.respawnCountdownTimers[this.activeSessionId]) {
        this.updateCountdownTimerDisplay();
      }
    }, 100);
  }

  stopCountdownInterval() {
    if (this.timerCountdownInterval) {
      clearInterval(this.timerCountdownInterval);
      this.timerCountdownInterval = null;
    }
  }

  updateCountdownTimerDisplay() {
    const timersContainer = this.$('respawnCountdownTimers');
    const row2 = this.$('respawnStatusRow2');
    if (!timersContainer) return;

    const timers = this.respawnCountdownTimers[this.activeSessionId];
    const hasTimers = timers && Object.keys(timers).length > 0;

    if (!hasTimers) {
      timersContainer.innerHTML = '';
      // Update row2 visibility
      if (row2) {
        const hookEl = document.getElementById('detectionHook');
        const aiCheckEl = document.getElementById('detectionAiCheck');
        const statusEl = this.$('detectionStatus');
        const hasVisibleContent =
          (hookEl && hookEl.style.display !== 'none') ||
          (aiCheckEl && aiCheckEl.style.display !== 'none') ||
          (statusEl && statusEl.style.display !== 'none');
        row2.style.display = hasVisibleContent ? '' : 'none';
      }
      return;
    }

    // Show row2 since we have timers
    if (row2) row2.style.display = '';

    const now = Date.now();
    let html = '';

    for (const [name, timer] of Object.entries(timers)) {
      const remainingMs = Math.max(0, timer.endsAt - now);
      const remainingSec = (remainingMs / 1000).toFixed(1);
      const percent = Math.max(0, Math.min(100, (remainingMs / timer.totalMs) * 100));

      // Shorter timer name display
      const displayName = name.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());

      html += `<div class="respawn-countdown-timer" title="${escapeHtml(timer.reason || '')}">
        <span class="timer-name">${escapeHtml(displayName)}</span>
        <span class="timer-value">${remainingSec}s</span>
        <div class="respawn-timer-bar">
          <div class="respawn-timer-progress" style="width: ${percent}%"></div>
        </div>
      </div>`;
    }

    timersContainer.innerHTML = html;
  }

  updateActionLogDisplay() {
    const logContainer = this.$('respawnActionLog');
    if (!logContainer) return;

    const actions = this.respawnActionLogs[this.activeSessionId];
    if (!actions || actions.length === 0) {
      logContainer.innerHTML = '';
      return;
    }

    let html = '';
    // Show fewer entries for compact view
    for (const action of actions.slice(0, 5)) {
      const time = new Date(action.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const isCommand = action.type === 'command';
      const extraClass = isCommand ? ' action-command' : '';
      // Compact format: time [type] detail
      html += `<div class="respawn-action-entry${extraClass}">
        <span class="action-time">${time}</span>
        <span class="action-type">[${action.type}]</span>
        <span class="action-detail">${escapeHtml(action.detail)}</span>
      </div>`;
    }

    logContainer.innerHTML = html;
  }

  clearCountdownTimers(sessionId) {
    delete this.respawnCountdownTimers[sessionId];
    delete this.respawnActionLogs[sessionId];
    if (sessionId === this.activeSessionId) {
      this.updateCountdownTimerDisplay();
      this.updateActionLogDisplay();
    }
  }

  async stopRespawn() {
    if (!this.activeSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.activeSessionId}/respawn/stop`, {});
      delete this.respawnTimers[this.activeSessionId];
      this.clearCountdownTimers(this.activeSessionId);
    } catch (err) {
      this.showToast('Failed to stop respawn', 'error');
    }
  }

  // ========== Kill Sessions ==========

  async killActiveSession() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'warning');
      return;
    }
    await this.closeSession(this.activeSessionId);
  }

  async killAllSessions() {
    if (this.sessions.size === 0) return;

    if (!confirm(`Kill all ${this.sessions.size} session(s)?`)) return;

    try {
      await this._apiDelete('/api/sessions');
      this.sessions.clear();
      this.terminalBuffers.clear();
      this.terminalBufferCache.clear();
      this.activeSessionId = null;
      try { localStorage.removeItem('codeman-active-session'); } catch {}
      this.respawnStatus = {};
      this.respawnCountdownTimers = {};
      this.respawnActionLogs = {};
      this.stopCountdownInterval();
      this.hideRespawnBanner();
      this.renderSessionTabs();
      this.terminal.clear();
      this.showWelcome();
      this.showToast('All sessions killed', 'success');
    } catch (err) {
      this.showToast('Failed to kill sessions', 'error');
    }
  }

  // ========== Terminal Controls ==========

  clearTerminal() {
    this.terminal.clear();
  }

  /**
   * Restore terminal size to match web UI dimensions.
   * Use this after mobile screen attachment has squeezed the terminal.
   * Sends resize to PTY and Ctrl+L to trigger Claude to redraw.
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
      // Send resize to restore proper dimensions (with minimum enforcement)
      await this.sendResize(this.activeSessionId);

      // Send Ctrl+L to trigger Claude to redraw at new size
      await fetch(`/api/sessions/${this.activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x0c' })
      });

      this.showToast(`Terminal restored to ${dims.cols}x${dims.rows}`, 'success');
    } catch (err) {
      console.error('Failed to restore terminal size:', err);
      this.showToast('Failed to restore terminal size', 'error');
    }
  }

  // Send Ctrl+L to fix display for newly created sessions once Claude is running
  sendPendingCtrlL(sessionId) {
    if (!this.pendingCtrlL || !this.pendingCtrlL.has(sessionId)) {
      return;
    }
    this.pendingCtrlL.delete(sessionId);

    // Only send if this is the active session
    if (sessionId !== this.activeSessionId) {
      return;
    }

    // Send resize + Ctrl+L to fix the display (with minimum dimension enforcement)
    this.sendResize(sessionId).then(() => {
      fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x0c' })
      });
    });
  }

  async copyTerminal() {
    try {
      const buffer = this.terminal.buffer.active;
      let text = '';
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      await navigator.clipboard.writeText(text.replace(/\n+$/, '\n'));
      this.showToast('Copied to clipboard', 'success');
    } catch (err) {
      this.showToast('Failed to copy', 'error');
    }
  }

  increaseFontSize() {
    const current = this.terminal.options.fontSize || 14;
    this.setFontSize(Math.min(current + 2, 24));
  }

  decreaseFontSize() {
    const current = this.terminal.options.fontSize || 14;
    this.setFontSize(Math.max(current - 2, 10));
  }

  setFontSize(size) {
    this.terminal.options.fontSize = size;
    document.getElementById('fontSizeDisplay').textContent = size;
    this.fitAddon.fit();
    localStorage.setItem('codeman-font-size', size);
    // Update overlay font cache and re-render at new cell dimensions
    this._localEchoOverlay?.refreshFont();
  }

  loadFontSize() {
    const saved = localStorage.getItem('codeman-font-size');
    if (saved) {
      const size = parseInt(saved, 10);
      if (size >= 10 && size <= 24) {
        this.terminal.options.fontSize = size;
        document.getElementById('fontSizeDisplay').textContent = size;
      }
    }
  }

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
      rows: Math.max(dims.rows, MIN_ROWS)
    };
  }

  /**
   * Send resize to a session with minimum dimension enforcement.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async sendResize(sessionId) {
    const dims = this.getTerminalDimensions();
    if (!dims) return;
    await fetch(`/api/sessions/${sessionId}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dims)
    });
  }

  /**
   * Send input to the active session.
   * @param {string} input - Text to send (include \r for Enter)
   * @returns {Promise<void>}
   */
  async sendInput(input) {
    if (!this.activeSessionId) return;
    await fetch(`/api/sessions/${this.activeSessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, useMux: true })
    });
  }

  // ========== Timer ==========

  showTimer() {
    document.getElementById('timerBanner').style.display = 'flex';
    this.updateTimer();
    this.timerInterval = setInterval(() => this.updateTimer(), 1000);
  }

  hideTimer() {
    document.getElementById('timerBanner').style.display = 'none';
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  updateTimer() {
    if (!this.currentRun || this.currentRun.status !== 'running') return;

    const now = Date.now();
    const remaining = Math.max(0, this.currentRun.endAt - now);
    const total = this.currentRun.endAt - this.currentRun.startedAt;
    const elapsed = now - this.currentRun.startedAt;
    const percent = Math.min(100, (elapsed / total) * 100);

    document.getElementById('timerValue').textContent = this.formatTime(remaining);
    document.getElementById('timerProgress').style.width = `${percent}%`;
    document.getElementById('timerMeta').textContent =
      `${this.currentRun.completedTasks} tasks | $${this.currentRun.totalCost.toFixed(2)}`;
  }

  async stopCurrentRun() {
    if (!this.currentRun) return;
    try {
      await fetch(`/api/scheduled/${this.currentRun.id}`, { method: 'DELETE' });
    } catch (err) {
      this.showToast('Failed to stop run', 'error');
    }
  }

  formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  // ========== Tokens ==========

  updateCost() {
    // Now updates tokens instead of cost
    this.updateTokens();
  }

  updateTokens() {
    // Debounce at 200ms — token display is non-critical and shouldn't
    // compete with input handling on the main thread
    if (this._updateTokensTimeout) {
      clearTimeout(this._updateTokensTimeout);
    }
    this._updateTokensTimeout = setTimeout(() => {
      this._updateTokensTimeout = null;
      this._updateTokensImmediate();
    }, 200);
  }

  _updateTokensImmediate() {
    // Use global stats if available (includes deleted sessions)
    let totalInput = 0;
    let totalOutput = 0;
    if (this.globalStats) {
      totalInput = this.globalStats.totalInputTokens || 0;
      totalOutput = this.globalStats.totalOutputTokens || 0;
    } else {
      // Fallback to active sessions only
      this.sessions.forEach(s => {
        if (s.tokens) {
          totalInput += s.tokens.input || 0;
          totalOutput += s.tokens.output || 0;
        }
      });
    }
    const total = totalInput + totalOutput;
    this.totalTokens = total;
    const display = this.formatTokens(total);

    // Estimate cost from tokens (more accurate than stored cost in interactive mode)
    const estimatedCost = this.estimateCost(totalInput, totalOutput);
    const tokenEl = this.$('headerTokens');
    if (tokenEl) {
      const settings = this.loadAppSettingsFromStorage();
      const showCost = settings.showCost ?? false;
      tokenEl.textContent = total > 0
        ? (showCost ? `${display} tokens · $${estimatedCost.toFixed(2)}` : `${display} tokens`)
        : '0 tokens';
      tokenEl.title = this.globalStats
        ? `Lifetime: ${this.globalStats.totalSessionsCreated} sessions created${showCost ? '\nEstimated cost based on Claude Opus pricing' : ''}`
        : `Token usage across active sessions${showCost ? '\nEstimated cost based on Claude Opus pricing' : ''}`;
    }
  }

  // ========== Session Options Modal ==========

  openSessionOptions(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.editingSessionId = sessionId;

    // Reset to an appropriate tab — Summary for OpenCode (Respawn/Ralph are Claude-only)
    this.switchOptionsTab(session.mode === 'opencode' ? 'summary' : 'respawn');

    // Update respawn status display and buttons
    const respawnStatus = document.getElementById('sessionRespawnStatus');
    const enableBtn = document.getElementById('modalEnableRespawnBtn');
    const stopBtn = document.getElementById('modalStopRespawnBtn');

    if (this.respawnStatus[sessionId]) {
      respawnStatus.classList.add('active');
      respawnStatus.querySelector('.respawn-status-text').textContent =
        this.respawnStatus[sessionId].state || 'Active';
      enableBtn.style.display = 'none';
      stopBtn.style.display = '';
    } else {
      respawnStatus.classList.remove('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'Not active';
      enableBtn.style.display = '';
      stopBtn.style.display = 'none';
    }

    // Only show respawn section for claude mode sessions with a running process
    const respawnSection = document.getElementById('sessionRespawnSection');
    if (session.mode === 'claude' && session.pid) {
      respawnSection.style.display = '';
    } else {
      respawnSection.style.display = 'none';
    }

    // Hide Claude-specific options for OpenCode sessions
    const isOpenCode = session.mode === 'opencode';
    const claudeOnlyEls = document.querySelectorAll('[data-claude-only]');
    claudeOnlyEls.forEach(el => { el.style.display = isOpenCode ? 'none' : ''; });

    // Reset duration presets to default (unlimited)
    this.selectDurationPreset('');

    // Populate respawn config from saved state
    this.loadSavedRespawnConfig(sessionId);

    // Populate auto-compact/clear from session state
    document.getElementById('modalAutoCompactEnabled').checked = session.autoCompactEnabled ?? false;
    document.getElementById('modalAutoCompactThreshold').value = session.autoCompactThreshold ?? 110000;
    document.getElementById('modalAutoCompactPrompt').value = session.autoCompactPrompt ?? '';
    document.getElementById('modalAutoClearEnabled').checked = session.autoClearEnabled ?? false;
    document.getElementById('modalAutoClearThreshold').value = session.autoClearThreshold ?? 140000;
    document.getElementById('modalImageWatcherEnabled').checked = session.imageWatcherEnabled ?? true;
    document.getElementById('modalFlickerFilterEnabled').checked = session.flickerFilterEnabled ?? false;

    // Populate session name input
    document.getElementById('modalSessionName').value = session.name || '';

    // Initialize color picker with current session color
    const currentColor = session.color || 'default';
    const colorPicker = document.getElementById('sessionColorPicker');
    colorPicker?.querySelectorAll('.color-swatch').forEach(s => {
      s.classList.toggle('selected', s.dataset.color === currentColor);
    });

    // Initialize respawn preset dropdown
    this.renderPresetDropdown();
    document.getElementById('respawnPresetSelect').value = '';
    document.getElementById('presetDescriptionHint').textContent = '';

    // Hide Ralph/Todo tab and Respawn tab for opencode sessions (not supported)
    const ralphTabBtn = document.querySelector('#sessionOptionsModal .modal-tab-btn[data-tab="ralph"]');
    const respawnTabBtn = document.querySelector('#sessionOptionsModal .modal-tab-btn[data-tab="respawn"]');
    if (isOpenCode) {
      if (ralphTabBtn) ralphTabBtn.style.display = 'none';
      if (respawnTabBtn) respawnTabBtn.style.display = 'none';
      // Default to Context tab for opencode sessions since Respawn is hidden
      this.switchOptionsTab('context');
    } else {
      if (ralphTabBtn) ralphTabBtn.style.display = '';
      if (respawnTabBtn) respawnTabBtn.style.display = '';
    }

    // Populate Ralph Wiggum form with current session values (skip for opencode)
    if (!isOpenCode) {
      const ralphState = this.ralphStates.get(sessionId);
      this.populateRalphForm({
        enabled: ralphState?.loop?.enabled ?? session.ralphLoop?.enabled ?? false,
        completionPhrase: ralphState?.loop?.completionPhrase || session.ralphLoop?.completionPhrase || '',
        maxIterations: ralphState?.loop?.maxIterations || session.ralphLoop?.maxIterations || 0,
      });
    }

    const modal = document.getElementById('sessionOptionsModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  async saveSessionName() {
    if (!this.editingSessionId) return;
    const name = document.getElementById('modalSessionName').value.trim();
    try {
      await this._apiPut(`/api/sessions/${this.editingSessionId}/name`, { name });
    } catch (err) {
      this.showToast('Failed to save session name: ' + err.message, 'error');
    }
  }

  async autoSaveAutoCompact() {
    if (!this.editingSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-compact`, {
        enabled: document.getElementById('modalAutoCompactEnabled').checked,
        threshold: parseInt(document.getElementById('modalAutoCompactThreshold').value) || 110000,
        prompt: document.getElementById('modalAutoCompactPrompt').value.trim() || undefined
      });
    } catch { /* silent */ }
  }

  async autoSaveAutoClear() {
    if (!this.editingSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-clear`, {
        enabled: document.getElementById('modalAutoClearEnabled').checked,
        threshold: parseInt(document.getElementById('modalAutoClearThreshold').value) || 140000
      });
    } catch { /* silent */ }
  }

  async toggleSessionImageWatcher() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalImageWatcherEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/image-watcher`, { enabled });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.imageWatcherEnabled = enabled;
      }
      this.showToast(`Image watcher ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle image watcher', 'error');
    }
  }

  async toggleFlickerFilter() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalFlickerFilterEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/flicker-filter`, { enabled });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.flickerFilterEnabled = enabled;
      }
      this.showToast(`Flicker filter ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle flicker filter', 'error');
    }
  }

  async autoSaveRespawnConfig() {
    if (!this.editingSessionId) return;
    const config = {
      updatePrompt: document.getElementById('modalRespawnPrompt').value,
      sendClear: document.getElementById('modalRespawnSendClear').checked,
      sendInit: document.getElementById('modalRespawnSendInit').checked,
      kickstartPrompt: document.getElementById('modalRespawnKickstart').value.trim() || undefined,
      autoAcceptPrompts: document.getElementById('modalRespawnAutoAccept').checked,
    };
    try {
      await this._apiPut(`/api/sessions/${this.editingSessionId}/respawn/config`, config);
    } catch {
      // Silent save - don't interrupt user
    }
  }

  async loadSavedRespawnConfig(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/respawn/config`);
      const data = await res.json();
      if (data.success && data.config) {
        const c = data.config;
        document.getElementById('modalRespawnPrompt').value = c.updatePrompt || 'update all the docs and CLAUDE.md';
        document.getElementById('modalRespawnSendClear').checked = c.sendClear ?? true;
        document.getElementById('modalRespawnSendInit').checked = c.sendInit ?? true;
        document.getElementById('modalRespawnKickstart').value = c.kickstartPrompt || '';
        document.getElementById('modalRespawnAutoAccept').checked = c.autoAcceptPrompts ?? true;
        // Restore duration if set
        if (c.durationMinutes) {
          const presetBtn = document.querySelector(`.duration-preset-btn[data-minutes="${c.durationMinutes}"]`);
          if (presetBtn) {
            this.selectDurationPreset(String(c.durationMinutes));
          } else {
            this.selectDurationPreset('custom');
            document.getElementById('modalRespawnDuration').value = c.durationMinutes;
          }
        }
      }
    } catch {
      // Ignore - use defaults
    }
  }

  // Handle duration preset selection
  selectDurationPreset(value) {
    // Remove active from all buttons
    document.querySelectorAll('.duration-preset-btn').forEach(btn => btn.classList.remove('active'));

    // Find and activate the clicked button
    const btn = document.querySelector(`.duration-preset-btn[data-minutes="${value}"]`);
    if (btn) btn.classList.add('active');

    // Show/hide custom input
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (value === 'custom') {
      customInput.classList.add('visible');
      durationInput.focus();
    } else {
      customInput.classList.remove('visible');
      durationInput.value = ''; // Clear custom value when using preset
    }
  }

  // Get selected duration from preset buttons or custom input
  getSelectedDuration() {
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (customInput.classList.contains('visible')) {
      // Custom mode - use input value
      return durationInput.value ? parseInt(durationInput.value) : null;
    } else {
      // Preset mode - get from active button
      const activeBtn = document.querySelector('.duration-preset-btn.active');
      const minutes = activeBtn?.dataset.minutes;
      return minutes ? parseInt(minutes) : null;
    }
  }

  // ========== Respawn Presets ==========

  loadRespawnPresets() {
    const saved = localStorage.getItem('codeman-respawn-presets');
    const custom = saved ? JSON.parse(saved) : [];
    return [...BUILTIN_RESPAWN_PRESETS, ...custom];
  }

  saveRespawnPresets(presets) {
    // Only save custom presets (not built-in)
    const custom = presets.filter(p => !p.builtIn);
    localStorage.setItem('codeman-respawn-presets', JSON.stringify(custom));
  }

  renderPresetDropdown() {
    const presets = this.loadRespawnPresets();
    const builtinGroup = document.getElementById('builtinPresetsGroup');
    const customGroup = document.getElementById('customPresetsGroup');

    if (!builtinGroup || !customGroup) return;

    // Clear and repopulate
    builtinGroup.innerHTML = '';
    customGroup.innerHTML = '';

    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      if (preset.builtIn) {
        builtinGroup.appendChild(option);
      } else {
        customGroup.appendChild(option);
      }
    });
  }

  updatePresetDescription() {
    const select = document.getElementById('respawnPresetSelect');
    const hint = document.getElementById('presetDescriptionHint');
    if (!select || !hint) return;

    const presetId = select.value;
    if (!presetId) {
      hint.textContent = '';
      return;
    }

    const presets = this.loadRespawnPresets();
    const preset = presets.find(p => p.id === presetId);
    hint.textContent = preset?.description || '';
  }

  loadRespawnPreset() {
    const select = document.getElementById('respawnPresetSelect');
    const presetId = select?.value;
    if (!presetId) {
      this.showToast('Please select a preset first', 'warning');
      return;
    }

    const presets = this.loadRespawnPresets();
    const preset = presets.find(p => p.id === presetId);
    if (!preset) return;

    // Populate form fields
    document.getElementById('modalRespawnPrompt').value = preset.config.updatePrompt || '';
    document.getElementById('modalRespawnSendClear').checked = preset.config.sendClear ?? false;
    document.getElementById('modalRespawnSendInit').checked = preset.config.sendInit ?? false;
    document.getElementById('modalRespawnKickstart').value = preset.config.kickstartPrompt || '';
    document.getElementById('modalRespawnAutoAccept').checked = preset.config.autoAcceptPrompts ?? true;

    // Set duration if available
    if (preset.durationMinutes) {
      this.selectDurationPreset(String(preset.durationMinutes));
    }

    // Reset select to placeholder
    select.value = '';
    document.getElementById('presetDescriptionHint').textContent = '';

    this.showToast(`Loaded preset: ${preset.name}`, 'info');
  }

  saveCurrentAsPreset() {
    document.getElementById('savePresetModal').classList.add('active');
    document.getElementById('presetNameInput').value = '';
    document.getElementById('presetDescriptionInput').value = '';
    document.getElementById('presetNameInput').focus();
  }

  closeSavePresetModal() {
    document.getElementById('savePresetModal').classList.remove('active');
  }

  confirmSavePreset() {
    const name = document.getElementById('presetNameInput').value.trim();
    if (!name) {
      this.showToast('Please enter a preset name', 'error');
      return;
    }

    // Get current config from form
    const updatePrompt = document.getElementById('modalRespawnPrompt').value;
    const sendClear = document.getElementById('modalRespawnSendClear').checked;
    const sendInit = document.getElementById('modalRespawnSendInit').checked;
    const kickstartPrompt = document.getElementById('modalRespawnKickstart').value.trim() || undefined;
    const durationMinutes = this.getSelectedDuration();

    const newPreset = {
      id: 'custom-' + Date.now(),
      name,
      description: document.getElementById('presetDescriptionInput').value.trim() || undefined,
      config: {
        idleTimeoutMs: 5000, // Default
        updatePrompt,
        interStepDelayMs: 3000, // Default
        sendClear,
        sendInit,
        kickstartPrompt,
      },
      durationMinutes: durationMinutes || undefined,
      builtIn: false,
      createdAt: Date.now(),
    };

    const presets = this.loadRespawnPresets();
    presets.push(newPreset);
    this.saveRespawnPresets(presets);
    this.renderPresetDropdown();
    this.closeSavePresetModal();
    this.showToast(`Saved preset: ${name}`, 'success');
  }

  deletePreset(presetId) {
    const presets = this.loadRespawnPresets();
    const preset = presets.find(p => p.id === presetId);
    if (!preset || preset.builtIn) {
      this.showToast('Cannot delete built-in presets', 'warning');
      return;
    }

    const filtered = presets.filter(p => p.id !== presetId);
    this.saveRespawnPresets(filtered);
    this.renderPresetDropdown();
    this.showToast(`Deleted preset: ${preset.name}`, 'success');
  }

  // Get respawn config from modal inputs
  getModalRespawnConfig() {
    const updatePrompt = document.getElementById('modalRespawnPrompt').value;
    const sendClear = document.getElementById('modalRespawnSendClear').checked;
    const sendInit = document.getElementById('modalRespawnSendInit').checked;
    const kickstartPrompt = document.getElementById('modalRespawnKickstart').value.trim() || undefined;
    const autoAcceptPrompts = document.getElementById('modalRespawnAutoAccept').checked;
    const durationMinutes = this.getSelectedDuration();

    // Auto-compact settings
    const autoCompactEnabled = document.getElementById('modalAutoCompactEnabled').checked;
    const autoCompactThreshold = parseInt(document.getElementById('modalAutoCompactThreshold').value) || 110000;
    const autoCompactPrompt = document.getElementById('modalAutoCompactPrompt').value.trim() || undefined;

    // Auto-clear settings
    const autoClearEnabled = document.getElementById('modalAutoClearEnabled').checked;
    const autoClearThreshold = parseInt(document.getElementById('modalAutoClearThreshold').value) || 140000;

    return {
      respawnConfig: {
        enabled: true,  // Fix: ensure enabled is set so pre-saved configs with enabled: false get overridden
        updatePrompt,
        sendClear,
        sendInit,
        kickstartPrompt,
        autoAcceptPrompts,
      },
      durationMinutes,
      autoCompactEnabled,
      autoCompactThreshold,
      autoCompactPrompt,
      autoClearEnabled,
      autoClearThreshold
    };
  }

  async enableRespawnFromModal() {
    if (!this.editingSessionId) {
      this.showToast('No session selected', 'warning');
      return;
    }

    const {
      respawnConfig,
      durationMinutes,
      autoCompactEnabled,
      autoCompactThreshold,
      autoCompactPrompt,
      autoClearEnabled,
      autoClearThreshold
    } = this.getModalRespawnConfig();

    try {
      // Enable respawn on the session
      const res = await fetch(`/api/sessions/${this.editingSessionId}/respawn/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: respawnConfig, durationMinutes })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Set auto-compact if enabled
      if (autoCompactEnabled) {
        await fetch(`/api/sessions/${this.editingSessionId}/auto-compact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, threshold: autoCompactThreshold, prompt: autoCompactPrompt })
        });
      }

      // Set auto-clear if enabled
      if (autoClearEnabled) {
        await fetch(`/api/sessions/${this.editingSessionId}/auto-clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, threshold: autoClearThreshold })
        });
      }

      // Update UI
      const respawnStatus = document.getElementById('sessionRespawnStatus');
      respawnStatus.classList.add('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'WATCHING';
      document.getElementById('modalEnableRespawnBtn').style.display = 'none';
      document.getElementById('modalStopRespawnBtn').style.display = '';

      this.showToast('Respawn enabled', 'success');
    } catch (err) {
      this.showToast('Failed to enable respawn: ' + err.message, 'error');
    }
  }

  async stopRespawnFromModal() {
    if (!this.editingSessionId) return;
    try {
      await fetch(`/api/sessions/${this.editingSessionId}/respawn/stop`, { method: 'POST' });
      delete this.respawnTimers[this.editingSessionId];

      // Update the modal display
      const respawnStatus = document.getElementById('sessionRespawnStatus');
      respawnStatus.classList.remove('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'Not active';
      document.getElementById('modalEnableRespawnBtn').style.display = '';
      document.getElementById('modalStopRespawnBtn').style.display = 'none';

      this.showToast('Respawn stopped', 'success');
    } catch (err) {
      this.showToast('Failed to stop respawn', 'error');
    }
  }

  closeSessionOptions() {
    this.editingSessionId = null;
    // Stop run summary auto-refresh if it was running
    this.stopRunSummaryAutoRefresh();
    document.getElementById('sessionOptionsModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  setupColorPicker() {
    const picker = document.getElementById('sessionColorPicker');
    if (!picker) return;

    picker.addEventListener('click', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (!swatch || !this.editingSessionId) return;

      const color = swatch.dataset.color;
      this.setSessionColor(this.editingSessionId, color);
    });
  }

  async setSessionColor(sessionId, color) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/color`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color })
      });

      if (res.ok) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.color = color;
          this.renderSessionTabs();
        }

        // Update picker UI to show selection
        const picker = document.getElementById('sessionColorPicker');
        if (picker) {
          picker.querySelectorAll('.color-swatch').forEach(swatch => {
            swatch.classList.toggle('selected', swatch.dataset.color === color);
          });
        }
      } else {
        this.showToast('Failed to set session color', 'error');
      }
    } catch (err) {
      this.showToast('Failed to set session color', 'error');
    }
  }

  // ========== Run Summary Modal ==========

  async openRunSummary(sessionId) {
    // Open session options modal and switch to summary tab
    this.openSessionOptions(sessionId);
    this.switchOptionsTab('summary');

    this.runSummarySessionId = sessionId;
    this.runSummaryFilter = 'all';

    // Reset filter buttons
    document.querySelectorAll('.run-summary-filters .filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === 'all');
    });

    // Load summary data
    await this.loadRunSummary(sessionId);
  }

  closeRunSummary() {
    this.runSummarySessionId = null;
    this.stopRunSummaryAutoRefresh();
    // Close session options modal (summary is now a tab in it)
    this.closeSessionOptions();
  }

  async refreshRunSummary() {
    const sessionId = this.runSummarySessionId || this.editingSessionId;
    if (!sessionId) return;
    await this.loadRunSummary(sessionId);
  }

  toggleRunSummaryAutoRefresh() {
    const checkbox = document.getElementById('runSummaryAutoRefresh');
    if (checkbox.checked) {
      this.startRunSummaryAutoRefresh();
    } else {
      this.stopRunSummaryAutoRefresh();
    }
  }

  startRunSummaryAutoRefresh() {
    if (this.runSummaryAutoRefreshTimer) return;
    this.runSummaryAutoRefreshTimer = setInterval(() => {
      if (this.runSummarySessionId) {
        this.loadRunSummary(this.runSummarySessionId);
      }
    }, 5000); // Refresh every 5 seconds
  }

  stopRunSummaryAutoRefresh() {
    if (this.runSummaryAutoRefreshTimer) {
      clearInterval(this.runSummaryAutoRefreshTimer);
      this.runSummaryAutoRefreshTimer = null;
    }
    const checkbox = document.getElementById('runSummaryAutoRefresh');
    if (checkbox) checkbox.checked = false;
  }

  exportRunSummary(format) {
    if (!this.runSummaryData) {
      this.showToast('No summary data to export', 'error');
      return;
    }

    const { stats, events, sessionName, startedAt, lastUpdatedAt } = this.runSummaryData;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `run-summary-${sessionName || 'session'}-${timestamp}`;

    if (format === 'json') {
      const json = JSON.stringify(this.runSummaryData, null, 2);
      this.downloadFile(`${filename}.json`, json, 'application/json');
    } else if (format === 'md') {
      const duration = lastUpdatedAt - startedAt;
      let md = `# Run Summary: ${sessionName || 'Session'}\n\n`;
      md += `**Duration**: ${this.formatDuration(duration)}\n`;
      md += `**Started**: ${new Date(startedAt).toLocaleString()}\n`;
      md += `**Last Update**: ${new Date(lastUpdatedAt).toLocaleString()}\n\n`;

      md += `## Statistics\n\n`;
      md += `| Metric | Value |\n`;
      md += `|--------|-------|\n`;
      md += `| Respawn Cycles | ${stats.totalRespawnCycles} |\n`;
      md += `| Peak Tokens | ${this.formatTokens(stats.peakTokens)} |\n`;
      md += `| Active Time | ${this.formatDuration(stats.totalTimeActiveMs)} |\n`;
      md += `| Idle Time | ${this.formatDuration(stats.totalTimeIdleMs)} |\n`;
      md += `| Errors | ${stats.errorCount} |\n`;
      md += `| Warnings | ${stats.warningCount} |\n`;
      md += `| AI Checks | ${stats.aiCheckCount} |\n`;
      md += `| State Transitions | ${stats.stateTransitions} |\n\n`;

      md += `## Event Timeline\n\n`;
      if (events.length === 0) {
        md += `No events recorded.\n`;
      } else {
        md += `| Time | Type | Severity | Title | Details |\n`;
        md += `|------|------|----------|-------|----------|\n`;
        for (const event of events) {
          const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
          const details = event.details ? event.details.replace(/\|/g, '\\|') : '-';
          md += `| ${time} | ${event.type} | ${event.severity} | ${event.title} | ${details} |\n`;
        }
      }

      this.downloadFile(`${filename}.md`, md, 'text/markdown');
    }

    this.showToast(`Exported as ${format.toUpperCase()}`, 'success');
  }

  downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async loadRunSummary(sessionId) {
    const timeline = document.getElementById('runSummaryTimeline');
    timeline.innerHTML = '<p class="empty-message">Loading summary...</p>';

    try {
      const response = await fetch(`/api/sessions/${sessionId}/run-summary`);
      const data = await response.json();

      if (!data.success) {
        timeline.innerHTML = `<p class="empty-message">Failed to load summary: ${escapeHtml(data.error)}</p>`;
        return;
      }

      this.runSummaryData = data.summary;
      this.renderRunSummary();
    } catch (err) {
      console.error('Failed to load run summary:', err);
      timeline.innerHTML = '<p class="empty-message">Failed to load summary</p>';
    }
  }

  renderRunSummary() {
    if (!this.runSummaryData) return;

    const { stats, events, sessionName, startedAt, lastUpdatedAt } = this.runSummaryData;

    // Update session info
    const duration = lastUpdatedAt - startedAt;
    document.getElementById('runSummarySessionInfo').textContent =
      `${sessionName || 'Session'} - ${this.formatDuration(duration)} total`;

    // Filter and render events
    const filteredEvents = this.filterRunSummaryEvents(events);
    this.renderRunSummaryTimeline(filteredEvents);
  }

  filterRunSummaryEvents(events) {
    if (this.runSummaryFilter === 'all') return events;

    return events.filter(event => {
      switch (this.runSummaryFilter) {
        case 'errors': return event.severity === 'error';
        case 'warnings': return event.severity === 'warning' || event.severity === 'error';
        case 'respawn': return event.type.startsWith('respawn_') || event.type === 'state_stuck';
        case 'idle': return event.type === 'idle_detected' || event.type === 'working_detected';
        default: return true;
      }
    });
  }

  filterRunSummary(filter) {
    this.runSummaryFilter = filter;

    // Update active state on buttons
    document.querySelectorAll('.run-summary-filters .filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });

    this.renderRunSummary();
  }

  renderRunSummaryTimeline(events) {
    const timeline = document.getElementById('runSummaryTimeline');

    if (!events || events.length === 0) {
      timeline.innerHTML = '<p class="empty-message">No events recorded yet</p>';
      return;
    }

    // Reverse to show most recent first
    const reversedEvents = [...events].reverse();

    const html = reversedEvents.map(event => {
      const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const severityClass = `event-${event.severity}`;
      const icon = this.getEventIcon(event.type, event.severity);

      return `
        <div class="timeline-event ${severityClass}">
          <div class="event-icon">${icon}</div>
          <div class="event-content">
            <div class="event-header">
              <span class="event-title">${escapeHtml(event.title)}</span>
              <span class="event-time">${time}</span>
            </div>
            ${event.details ? `<div class="event-details">${escapeHtml(event.details)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    timeline.innerHTML = html;
  }

  getEventIcon(type, severity) {
    if (severity === 'error') return '&#x274C;'; // Red X
    if (severity === 'warning') return '&#x26A0;'; // Warning triangle
    if (severity === 'success') return '&#x2714;'; // Checkmark

    switch (type) {
      case 'session_started': return '&#x1F680;'; // Rocket
      case 'session_stopped': return '&#x1F6D1;'; // Stop sign
      case 'respawn_cycle_started': return '&#x1F504;'; // Cycle
      case 'respawn_cycle_completed': return '&#x2705;'; // Green check
      case 'respawn_state_change': return '&#x27A1;'; // Arrow
      case 'token_milestone': return '&#x1F4B0;'; // Money bag
      case 'idle_detected': return '&#x1F4A4;'; // Zzz
      case 'working_detected': return '&#x1F4BB;'; // Laptop
      case 'ai_check_result': return '&#x1F916;'; // Robot
      case 'hook_event': return '&#x1F514;'; // Bell
      default: return '&#x2022;'; // Bullet
    }
  }

  formatTokens(tokens) {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
    return String(tokens || 0);
  }

  formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  saveSessionOptions() {
    // Session options are applied immediately via individual controls
    // This just closes the modal
    this.closeSessionOptions();
  }

  // ========== Session Options Modal Tabs ==========

  switchOptionsTab(tabName) {
    // Toggle active class on tab buttons
    document.querySelectorAll('#sessionOptionsModal .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Toggle hidden class on tab content
    document.getElementById('respawn-tab').classList.toggle('hidden', tabName !== 'respawn');
    document.getElementById('context-tab').classList.toggle('hidden', tabName !== 'context');
    document.getElementById('ralph-tab').classList.toggle('hidden', tabName !== 'ralph');
    document.getElementById('summary-tab').classList.toggle('hidden', tabName !== 'summary');

    // Load run summary data when switching to summary tab
    if (tabName === 'summary' && this.editingSessionId) {
      this.loadRunSummary(this.editingSessionId);
    }
  }

  getRalphConfig() {
    return {
      enabled: document.getElementById('modalRalphEnabled').checked,
      completionPhrase: document.getElementById('modalRalphPhrase').value.trim(),
      maxIterations: parseInt(document.getElementById('modalRalphMaxIterations').value) || 0,
      maxTodos: parseInt(document.getElementById('modalRalphMaxTodos').value) || 50,
      todoExpirationMinutes: parseInt(document.getElementById('modalRalphTodoExpiration').value) || 60
    };
  }

  populateRalphForm(config) {
    document.getElementById('modalRalphEnabled').checked = config?.enabled ?? false;
    document.getElementById('modalRalphPhrase').value = config?.completionPhrase || '';
    document.getElementById('modalRalphMaxIterations').value = config?.maxIterations || 0;
    document.getElementById('modalRalphMaxTodos').value = config?.maxTodos || 50;
    document.getElementById('modalRalphTodoExpiration').value = config?.todoExpirationMinutes || 60;
  }

  async saveRalphConfig() {
    if (!this.editingSessionId) {
      this.showToast('No session selected', 'warning');
      return;
    }

    const config = this.getRalphConfig();

    // If user is enabling Ralph, clear from closed set
    if (config.enabled) {
      this.ralphClosedSessions.delete(this.editingSessionId);
    }

    try {
      const res = await fetch(`/api/sessions/${this.editingSessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      this.showToast('Ralph config saved', 'success');
    } catch (err) {
      this.showToast('Failed to save Ralph config: ' + err.message, 'error');
    }
  }

  // Inline rename on right-click
  startInlineRename(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const tabName = document.querySelector(`.tab-name[data-session-id="${sessionId}"]`);
    if (!tabName) return;

    const currentName = this.getSessionName(session);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = session.name || '';
    input.placeholder = currentName;
    input.className = 'tab-rename-input';
    input.style.cssText = 'width: 80px; font-size: 0.75rem; padding: 2px 4px; background: var(--bg-input); border: 1px solid var(--accent); border-radius: 3px; color: var(--text); outline: none;';

    const originalContent = tabName.textContent;
    tabName.textContent = '';
    tabName.appendChild(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      const newName = input.value.trim();
      tabName.textContent = newName || originalContent;

      if (newName && newName !== session.name) {
        try {
          await fetch(`/api/sessions/${sessionId}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
          });
        } catch (err) {
          tabName.textContent = originalContent;
          this.showToast('Failed to rename', 'error');
        }
      }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
  }

  // ========== Web Push ==========

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      this._swRegistration = reg;
      // Listen for messages from service worker (notification clicks)
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'notification-click') {
          const { sessionId } = event.data;
          if (sessionId && this.sessions.has(sessionId)) {
            this.selectSession(sessionId);
          }
          window.focus();
        }
      });
      // Check if already subscribed
      reg.pushManager.getSubscription().then((sub) => {
        if (sub) {
          this._pushSubscription = sub;
          this._updatePushUI(true);
        }
      });
    }).catch(() => {
      // Service worker registration failed (likely not HTTPS)
    });
  }

  async subscribeToPush() {
    if (!this._swRegistration) {
      this.showToast('Service worker not available. HTTPS or localhost required.', 'error');
      return;
    }
    try {
      // Get VAPID public key from server
      const keyData = await this._apiJson('/api/push/vapid-key');
      if (!keyData?.success) throw new Error('Failed to get VAPID key');

      const applicationServerKey = urlBase64ToUint8Array(keyData.data.publicKey);
      const subscription = await this._swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });

      // Send subscription to server
      const subJson = subscription.toJSON();
      const data = await this._apiJson('/api/push/subscribe', {
        method: 'POST',
        body: {
          endpoint: subJson.endpoint,
          keys: subJson.keys,
          userAgent: navigator.userAgent,
          pushPreferences: this._buildPushPreferences(),
        },
      });
      if (!data?.success) throw new Error('Failed to register subscription');

      this._pushSubscription = subscription;
      this._pushSubscriptionId = data.data.id;
      localStorage.setItem('codeman-push-subscription-id', data.data.id);
      this._updatePushUI(true);
      this.showToast('Push notifications enabled', 'success');
    } catch (err) {
      this.showToast('Push subscription failed: ' + (err.message || err), 'error');
    }
  }

  async unsubscribeFromPush() {
    try {
      if (this._pushSubscription) {
        await this._pushSubscription.unsubscribe();
      }
      const subId = this._pushSubscriptionId || localStorage.getItem('codeman-push-subscription-id');
      if (subId) {
        await fetch(`/api/push/subscribe/${subId}`, { method: 'DELETE' }).catch(() => {});
      }
      this._pushSubscription = null;
      this._pushSubscriptionId = null;
      localStorage.removeItem('codeman-push-subscription-id');
      this._updatePushUI(false);
      this.showToast('Push notifications disabled', 'success');
    } catch (err) {
      this.showToast('Failed to unsubscribe: ' + (err.message || err), 'error');
    }
  }

  async togglePushSubscription() {
    if (this._pushSubscription) {
      await this.unsubscribeFromPush();
    } else {
      await this.subscribeToPush();
    }
  }

  /** Sync push preferences to server */
  async _syncPushPreferences() {
    const subId = this._pushSubscriptionId || localStorage.getItem('codeman-push-subscription-id');
    if (!subId) return;
    try {
      await fetch(`/api/push/subscribe/${subId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pushPreferences: this._buildPushPreferences() }),
      });
    } catch {
      // Silently fail — prefs saved locally, will sync on next subscribe
    }
  }

  /** Build push preferences object from current event type checkboxes */
  _buildPushPreferences() {
    const prefs = {};
    const eventMap = {
      'hook:permission_prompt': 'eventPermissionPush',
      'hook:elicitation_dialog': 'eventQuestionPush',
      'hook:idle_prompt': 'eventIdlePush',
      'hook:stop': 'eventStopPush',
      'respawn:blocked': 'eventRespawnPush',
      'session:ralphCompletionDetected': 'eventRalphPush',
    };
    for (const [event, checkboxId] of Object.entries(eventMap)) {
      const el = document.getElementById(checkboxId);
      prefs[event] = el ? el.checked : true;
    }
    // session:error always receives push (no per-event toggle, always critical)
    prefs['session:error'] = true;
    return prefs;
  }

  _updatePushUI(subscribed) {
    const btn = document.getElementById('pushSubscribeBtn');
    const status = document.getElementById('pushSubscriptionStatus');
    if (btn) btn.textContent = subscribed ? 'Unsubscribe' : 'Subscribe';
    if (status) {
      status.textContent = subscribed ? 'active' : 'off';
      status.classList.remove('granted', 'denied');
      if (subscribed) status.classList.add('granted');
    }
  }

  // ========== App Settings Modal ==========

  openAppSettings() {
    // Load current settings
    const settings = this.loadAppSettingsFromStorage();
    document.getElementById('appSettingsClaudeMdPath').value = settings.defaultClaudeMdPath || '';
    document.getElementById('appSettingsDefaultDir').value = settings.defaultWorkingDir || '';
    // Use device-aware defaults for display settings (mobile has different defaults)
    const defaults = this.getDefaultSettings();
    document.getElementById('appSettingsRalphEnabled').checked = settings.ralphTrackerEnabled ?? defaults.ralphTrackerEnabled ?? false;
    // Header visibility settings
    document.getElementById('appSettingsShowFontControls').checked = settings.showFontControls ?? defaults.showFontControls ?? false;
    document.getElementById('appSettingsShowSystemStats').checked = settings.showSystemStats ?? defaults.showSystemStats ?? true;
    document.getElementById('appSettingsShowTokenCount').checked = settings.showTokenCount ?? defaults.showTokenCount ?? true;
    document.getElementById('appSettingsShowCost').checked = settings.showCost ?? defaults.showCost ?? false;
    document.getElementById('appSettingsShowLifecycleLog').checked = settings.showLifecycleLog ?? defaults.showLifecycleLog ?? true;
    document.getElementById('appSettingsShowMonitor').checked = settings.showMonitor ?? defaults.showMonitor ?? true;
    document.getElementById('appSettingsShowProjectInsights').checked = settings.showProjectInsights ?? defaults.showProjectInsights ?? false;
    document.getElementById('appSettingsShowFileBrowser').checked = settings.showFileBrowser ?? defaults.showFileBrowser ?? false;
    document.getElementById('appSettingsShowSubagents').checked = settings.showSubagents ?? defaults.showSubagents ?? true;
    document.getElementById('appSettingsSubagentTracking').checked = settings.subagentTrackingEnabled ?? defaults.subagentTrackingEnabled ?? true;
    document.getElementById('appSettingsSubagentActiveTabOnly').checked = settings.subagentActiveTabOnly ?? defaults.subagentActiveTabOnly ?? true;
    document.getElementById('appSettingsImageWatcherEnabled').checked = settings.imageWatcherEnabled ?? defaults.imageWatcherEnabled ?? false;
    document.getElementById('appSettingsTunnelEnabled').checked = settings.tunnelEnabled ?? false;
    this.loadTunnelStatus();
    document.getElementById('appSettingsLocalEcho').checked = settings.localEchoEnabled ?? MobileDetection.isTouchDevice();
    document.getElementById('appSettingsTabTwoRows').checked = settings.tabTwoRows ?? defaults.tabTwoRows ?? false;
    // Claude CLI settings
    const claudeModeSelect = document.getElementById('appSettingsClaudeMode');
    const allowedToolsRow = document.getElementById('allowedToolsRow');
    claudeModeSelect.value = settings.claudeMode || 'dangerously-skip-permissions';
    document.getElementById('appSettingsAllowedTools').value = settings.allowedTools || '';
    allowedToolsRow.style.display = claudeModeSelect.value === 'allowedTools' ? '' : 'none';
    // Toggle allowed tools row visibility based on mode selection
    claudeModeSelect.onchange = () => {
      allowedToolsRow.style.display = claudeModeSelect.value === 'allowedTools' ? '' : 'none';
    };
    // Claude Permissions settings
    document.getElementById('appSettingsAgentTeams').checked = settings.agentTeamsEnabled ?? false;
    // CPU Priority settings
    const niceSettings = settings.nice || {};
    document.getElementById('appSettingsNiceEnabled').checked = niceSettings.enabled ?? false;
    document.getElementById('appSettingsNiceValue').value = niceSettings.niceValue ?? 10;
    // Model configuration (loaded from server)
    this.loadModelConfigForSettings();
    // Notification settings
    const notifPrefs = this.notificationManager?.preferences || {};
    document.getElementById('appSettingsNotifEnabled').checked = notifPrefs.enabled ?? true;
    document.getElementById('appSettingsNotifBrowser').checked = notifPrefs.browserNotifications ?? false;
    document.getElementById('appSettingsNotifAudio').checked = notifPrefs.audioAlerts ?? false;
    document.getElementById('appSettingsNotifStuckMins').value = Math.round((notifPrefs.stuckThresholdMs || 600000) / 60000);
    document.getElementById('appSettingsNotifCritical').checked = !notifPrefs.muteCritical;
    document.getElementById('appSettingsNotifWarning').checked = !notifPrefs.muteWarning;
    document.getElementById('appSettingsNotifInfo').checked = !notifPrefs.muteInfo;
    // Push notification settings
    document.getElementById('appSettingsPushEnabled').checked = !!this._pushSubscription;
    this._updatePushUI(!!this._pushSubscription);
    // Per-event-type preferences
    const eventTypes = notifPrefs.eventTypes || {};
    // Permission prompts
    const permPref = eventTypes.permission_prompt || {};
    document.getElementById('eventPermissionEnabled').checked = permPref.enabled ?? true;
    document.getElementById('eventPermissionBrowser').checked = permPref.browser ?? true;
    document.getElementById('eventPermissionPush').checked = permPref.push ?? false;
    document.getElementById('eventPermissionAudio').checked = permPref.audio ?? true;
    // Questions (elicitation_dialog)
    const questionPref = eventTypes.elicitation_dialog || {};
    document.getElementById('eventQuestionEnabled').checked = questionPref.enabled ?? true;
    document.getElementById('eventQuestionBrowser').checked = questionPref.browser ?? true;
    document.getElementById('eventQuestionPush').checked = questionPref.push ?? false;
    document.getElementById('eventQuestionAudio').checked = questionPref.audio ?? true;
    // Session idle (idle_prompt)
    const idlePref = eventTypes.idle_prompt || {};
    document.getElementById('eventIdleEnabled').checked = idlePref.enabled ?? true;
    document.getElementById('eventIdleBrowser').checked = idlePref.browser ?? true;
    document.getElementById('eventIdlePush').checked = idlePref.push ?? false;
    document.getElementById('eventIdleAudio').checked = idlePref.audio ?? false;
    // Response complete (stop)
    const stopPref = eventTypes.stop || {};
    document.getElementById('eventStopEnabled').checked = stopPref.enabled ?? true;
    document.getElementById('eventStopBrowser').checked = stopPref.browser ?? false;
    document.getElementById('eventStopPush').checked = stopPref.push ?? false;
    document.getElementById('eventStopAudio').checked = stopPref.audio ?? false;
    // Respawn cycles
    const respawnPref = eventTypes.respawn_cycle || {};
    document.getElementById('eventRespawnEnabled').checked = respawnPref.enabled ?? true;
    document.getElementById('eventRespawnBrowser').checked = respawnPref.browser ?? false;
    document.getElementById('eventRespawnPush').checked = respawnPref.push ?? false;
    document.getElementById('eventRespawnAudio').checked = respawnPref.audio ?? false;
    // Task complete (ralph_complete)
    const ralphPref = eventTypes.ralph_complete || {};
    document.getElementById('eventRalphEnabled').checked = ralphPref.enabled ?? true;
    document.getElementById('eventRalphBrowser').checked = ralphPref.browser ?? true;
    document.getElementById('eventRalphPush').checked = ralphPref.push ?? false;
    document.getElementById('eventRalphAudio').checked = ralphPref.audio ?? true;
    // Subagent activity (subagent_spawn and subagent_complete)
    const subagentPref = eventTypes.subagent_spawn || {};
    document.getElementById('eventSubagentEnabled').checked = subagentPref.enabled ?? false;
    document.getElementById('eventSubagentBrowser').checked = subagentPref.browser ?? false;
    document.getElementById('eventSubagentPush').checked = subagentPref.push ?? false;
    document.getElementById('eventSubagentAudio').checked = subagentPref.audio ?? false;
    // Update permission status display (compact format for new grid layout)
    const permStatus = document.getElementById('notifPermissionStatus');
    if (permStatus && typeof Notification !== 'undefined') {
      const perm = Notification.permission;
      permStatus.textContent = perm === 'granted' ? '\u2713' : perm === 'denied' ? '\u2717' : '?';
      permStatus.classList.remove('granted', 'denied');
      if (perm === 'granted') permStatus.classList.add('granted');
      else if (perm === 'denied') permStatus.classList.add('denied');
    }
    // Voice settings (loaded from localStorage only)
    const voiceCfg = VoiceInput._getDeepgramConfig();
    document.getElementById('voiceDeepgramKey').value = voiceCfg.apiKey || '';
    document.getElementById('voiceLanguage').value = voiceCfg.language || 'en-US';
    document.getElementById('voiceKeyterms').value = voiceCfg.keyterms || 'refactor, endpoint, middleware, callback, async, regex, TypeScript, npm, API, deploy, config, linter, env, webhook, schema, CLI, JSON, CSS, DOM, SSE, backend, frontend, localhost, dependencies, repository, merge, rebase, diff, commit, com';
    document.getElementById('voiceInsertMode').value = voiceCfg.insertMode || 'direct';
    // Reset key visibility to hidden
    const keyInput = document.getElementById('voiceDeepgramKey');
    keyInput.type = 'password';
    document.getElementById('voiceKeyToggleBtn').textContent = 'Show';
    // Update provider status
    const providerName = VoiceInput.getActiveProviderName();
    const providerEl = document.getElementById('voiceProviderStatus');
    providerEl.textContent = providerName;
    providerEl.className = 'voice-provider-status' + (providerName.startsWith('Deepgram') ? ' active' : '');

    // Reset to first tab and wire up tab switching
    this.switchSettingsTab('settings-display');
    const modal = document.getElementById('appSettingsModal');
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.onclick = () => this.switchSettingsTab(btn.dataset.tab);
    });
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  switchSettingsTab(tabName) {
    const modal = document.getElementById('appSettingsModal');
    // Toggle active class on tab buttons
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // Toggle hidden class on tab content
    modal.querySelectorAll('.modal-tab-content').forEach(content => {
      content.classList.toggle('hidden', content.id !== tabName);
    });
  }

  closeAppSettings() {
    document.getElementById('appSettingsModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  async loadTunnelStatus() {
    try {
      const res = await fetch('/api/tunnel/status');
      const status = await res.json();
      const active = status.running && status.url;
      this._updateTunnelUrlDisplay(active ? status.url : null);
      this._updateWelcomeTunnelBtn(!!active, active ? status.url : null);
    } catch {
      this._updateTunnelUrlDisplay(null);
      this._updateWelcomeTunnelBtn(false);
    }
  }

  _updateTunnelUrlDisplay(url) {
    const row = document.getElementById('tunnelUrlRow');
    const display = document.getElementById('tunnelUrlDisplay');
    if (!row || !display) return;
    if (url) {
      row.style.display = '';
      display.textContent = url;
      display.onclick = () => {
        navigator.clipboard.writeText(url).then(() => {
          this.showToast('Tunnel URL copied', 'success');
        });
      };
    } else {
      row.style.display = 'none';
      display.textContent = '';
      display.onclick = null;
    }
  }

  showTunnelQR() {
    // Close existing popup if open
    this.closeTunnelQR();

    const overlay = document.createElement('div');
    overlay.id = 'tunnelQrOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:5000;display:flex;align-items:center;justify-content:center;cursor:pointer';
    overlay.onclick = (e) => { if (e.target === overlay) this.closeTunnelQR(); };

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center;max-width:340px;width:90vw;box-shadow:var(--shadow-lg);cursor:default';

    card.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:16px">Scan to connect</div>
      <div id="tunnelQrContainer" style="background:#fff;border-radius:8px;padding:16px;display:inline-block">
        <div style="color:#666;font-size:12px">Loading...</div>
      </div>
      <div id="tunnelQrUrl" style="margin-top:12px;font-family:monospace;font-size:11px;color:var(--text-muted);word-break:break-all;cursor:pointer" title="Click to copy"></div>
      <button onclick="app.closeTunnelQR()" style="margin-top:16px;padding:6px 20px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);cursor:pointer;font-size:13px">Close</button>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Fetch QR SVG from server
    fetch('/api/tunnel/qr')
      .then(res => {
        if (!res.ok) throw new Error('Tunnel not running');
        return res.json();
      })
      .then(data => {
        const container = document.getElementById('tunnelQrContainer');
        if (container && data.svg) container.innerHTML = data.svg;
        // Show auth badge, countdown, and regenerate button when auth is enabled
        if (data.authEnabled) {
          const badge = document.createElement('div');
          badge.id = 'tunnelQrBadge';
          badge.style.cssText = 'margin-top:8px;font-size:11px;color:var(--text-muted)';
          badge.textContent = 'Single-use auth \u00b7 expires in 60s';
          const regenBtn = document.createElement('button');
          regenBtn.textContent = 'Regenerate QR';
          regenBtn.style.cssText = 'margin-top:8px;padding:4px 12px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:4px;color:var(--text-secondary);cursor:pointer;font-size:11px';
          regenBtn.onclick = () => {
            fetch('/api/tunnel/qr/regenerate', { method: 'POST' })
              .then(() => this.showToast('QR code regenerated', 'success'))
              .catch(() => this.showToast('Failed to regenerate QR', 'error'));
          };
          const card = container.parentElement;
          if (card) {
            card.appendChild(badge);
            card.appendChild(regenBtn);
          }
          this._resetQrCountdown();
        }
      })
      .catch(() => {
        const container = document.getElementById('tunnelQrContainer');
        if (container) container.innerHTML = '<div style="color:#c00;font-size:12px;padding:20px">Tunnel not active</div>';
      });

    // Fetch URL for display
    fetch('/api/tunnel/status')
      .then(r => r.json())
      .then(status => {
        const urlEl = document.getElementById('tunnelQrUrl');
        if (urlEl && status.url) {
          urlEl.textContent = status.url;
          urlEl.onclick = () => {
            navigator.clipboard.writeText(status.url).then(() => {
              this.showToast('Tunnel URL copied', 'success');
            });
          };
        }
      })
      .catch(() => {});

    // Close on Escape
    this._tunnelQrEscHandler = (e) => { if (e.key === 'Escape') this.closeTunnelQR(); };
    document.addEventListener('keydown', this._tunnelQrEscHandler);
  }

  closeTunnelQR() {
    const overlay = document.getElementById('tunnelQrOverlay');
    if (overlay) overlay.remove();
    if (this._tunnelQrEscHandler) {
      document.removeEventListener('keydown', this._tunnelQrEscHandler);
      this._tunnelQrEscHandler = null;
    }
    this._clearQrCountdown();
  }

  /** Fallback: fetch QR SVG from API when SSE payload lacks it */
  _refreshTunnelQrFromApi() {
    fetch('/api/tunnel/qr')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.svg) return;
        const container = document.getElementById('tunnelQrContainer');
        if (container) container.innerHTML = data.svg;
        const welcomeInner = document.getElementById('welcomeQrInner');
        if (welcomeInner) welcomeInner.innerHTML = data.svg;
      })
      .catch(() => {});
  }

  /** Start or reset the 60s countdown on the QR badge */
  _resetQrCountdown() {
    this._clearQrCountdown();
    this._qrCountdownSec = 60;
    this._updateQrCountdownText();
    this._qrCountdownTimer = setInterval(() => {
      this._qrCountdownSec--;
      if (this._qrCountdownSec <= 0) {
        this._clearQrCountdown();
        return;
      }
      this._updateQrCountdownText();
    }, 1000);
  }

  _updateQrCountdownText() {
    const badge = document.getElementById('tunnelQrBadge');
    if (badge) {
      badge.textContent = `Single-use auth \u00b7 expires in ${this._qrCountdownSec}s`;
    }
  }

  _clearQrCountdown() {
    if (this._qrCountdownTimer) {
      clearInterval(this._qrCountdownTimer);
      this._qrCountdownTimer = null;
    }
  }

  async toggleTunnelFromWelcome() {
    const btn = document.getElementById('welcomeTunnelBtn');
    if (!btn) return;
    const isActive = btn.classList.contains('active');
    btn.disabled = true;
    try {
      const newEnabled = !isActive;
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelEnabled: newEnabled }),
      });
      if (newEnabled) {
        this._showTunnelConnecting();
        // Poll tunnel status as fallback in case SSE event is missed
        this._pollTunnelStatus();
      } else {
        this._dismissTunnelConnecting();
        this.showToast('Tunnel stopped', 'info');
        this._updateWelcomeTunnelBtn(false);
        btn.disabled = false;
      }
    } catch (err) {
      this._dismissTunnelConnecting();
      this.showToast('Failed to toggle tunnel', 'error');
      btn.disabled = false;
    }
  }

  _showTunnelConnecting() {
    // Remove any existing connecting toast first (without resetting button state)
    const oldToast = document.getElementById('tunnelConnectingToast');
    if (oldToast) {
      oldToast.remove();
    }
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) {
      btn.classList.add('connecting');
      btn.innerHTML = `
        <span class="tunnel-spinner"></span>
        Connecting...`;
    }
    // Persistent toast with spinner
    const toast = document.createElement('div');
    toast.className = 'toast toast-info show';
    toast.id = 'tunnelConnectingToast';
    toast.innerHTML = '<span class="tunnel-spinner"></span> Cloudflare Tunnel connecting...';
    toast.style.pointerEvents = 'auto';
    if (!this._toastContainer) {
      this._toastContainer = document.querySelector('.toast-container');
      if (!this._toastContainer) {
        this._toastContainer = document.createElement('div');
        this._toastContainer.className = 'toast-container';
        document.body.appendChild(this._toastContainer);
      }
    }
    this._toastContainer.appendChild(toast);
  }

  _dismissTunnelConnecting() {
    clearTimeout(this._tunnelPollTimer);
    this._tunnelPollTimer = null;
    const toast = document.getElementById('tunnelConnectingToast');
    if (toast) {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    }
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) btn.classList.remove('connecting');
  }

  _pollTunnelStatus(attempt = 0) {
    if (attempt > 15) return; // give up after ~30s
    this._tunnelPollTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/tunnel/status');
        const status = await res.json();
        if (status.running && status.url) {
          // Tunnel is up — update UI
          this._dismissTunnelConnecting();
          this._updateTunnelUrlDisplay(status.url);
          const welcomeVisible = document.getElementById('welcomeOverlay')?.classList.contains('visible');
          if (welcomeVisible) {
            this._updateWelcomeTunnelBtn(true, status.url, true);
            this.showToast('Tunnel active', 'success');
          } else {
            this._updateWelcomeTunnelBtn(true, status.url);
            this.showToast(`Tunnel active: ${status.url}`, 'success');
            this.showTunnelQR();
          }
          return;
        }
      } catch { /* ignore */ }
      this._pollTunnelStatus(attempt + 1);
    }, 2000);
  }

  _updateWelcomeTunnelBtn(active, url, firstAppear = false) {
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) {
      btn.disabled = false;
      if (active) {
        btn.classList.remove('connecting');
        btn.classList.add('active');
        btn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Tunnel Active`;
      } else {
        btn.classList.remove('active', 'connecting');
        btn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Cloudflare Tunnel`;
      }
    }
    // Update welcome QR code
    const qrWrap = document.getElementById('welcomeQr');
    const qrInner = document.getElementById('welcomeQrInner');
    const qrUrl = document.getElementById('welcomeQrUrl');
    if (!qrWrap || !qrInner) return;
    if (active) {
      qrWrap.classList.add('visible');
      // First appear: start expanded, auto-shrink after 8s
      if (firstAppear) {
        qrWrap.classList.add('expanded');
        clearTimeout(this._welcomeQrShrinkTimer);
        this._welcomeQrShrinkTimer = setTimeout(() => {
          qrWrap.classList.remove('expanded');
        }, 8000);
      }
      if (url) {
        qrUrl.textContent = url;
        qrUrl.title = 'Click QR to enlarge';
      }
      fetch('/api/tunnel/qr')
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then(data => { if (data.svg) qrInner.innerHTML = data.svg; })
        .catch(() => { qrInner.innerHTML = '<div style="color:#999;font-size:11px;padding:20px">QR unavailable</div>'; });
    } else {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.remove('visible', 'expanded');
      qrInner.innerHTML = '';
      if (qrUrl) qrUrl.textContent = '';
    }
  }

  toggleWelcomeQrSize() {
    const qrWrap = document.getElementById('welcomeQr');
    if (qrWrap) {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.toggle('expanded');
    }
  }

  toggleDeepgramKeyVisibility() {
    const input = document.getElementById('voiceDeepgramKey');
    const btn = document.getElementById('voiceKeyToggleBtn');
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      btn.textContent = 'Show';
    }
  }

  // ========== Session Lifecycle Log ==========

  openLifecycleLog() {
    const win = document.getElementById('lifecycleWindow');
    win.style.display = 'block';
    // Reset transform so it appears centered initially
    if (!win._dragInitialized) {
      win.style.left = '50%';
      win.style.transform = 'translateX(-50%)';
      this._initLifecycleDrag(win);
      win._dragInitialized = true;
    }
    this.loadLifecycleLog();
  }

  closeLifecycleLog() {
    document.getElementById('lifecycleWindow').style.display = 'none';
  }

  _initLifecycleDrag(win) {
    const header = document.getElementById('lifecycleWindowHeader');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      isDragging = true;
      // Clear transform so left/top work in absolute pixels
      const rect = win.getBoundingClientRect();
      win.style.transform = 'none';
      win.style.left = rect.left + 'px';
      win.style.top = rect.top + 'px';
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      win.style.left = (startLeft + e.clientX - startX) + 'px';
      win.style.top = (startTop + e.clientY - startY) + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  async loadLifecycleLog() {
    const eventFilter = document.getElementById('lifecycleFilterEvent').value;
    const sessionFilter = document.getElementById('lifecycleFilterSession').value.trim();
    const params = new URLSearchParams();
    if (eventFilter) params.set('event', eventFilter);
    if (sessionFilter) params.set('sessionId', sessionFilter);
    params.set('limit', '300');

    try {
      const res = await fetch(`/api/session-lifecycle?${params}`);
      const data = await res.json();
      const tbody = document.getElementById('lifecycleTableBody');
      const empty = document.getElementById('lifecycleEmpty');

      if (!data.entries || data.entries.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = '';
        return;
      }
      empty.style.display = 'none';

      const eventColors = {
        created: '#4ade80', started: '#4ade80', recovered: '#4ade80',
        exit: '#fbbf24', mux_died: '#f87171', deleted: '#f87171', stale_cleaned: '#f87171',
        server_started: '#666', server_stopped: '#666',
      };

      tbody.innerHTML = data.entries.map(e => {
        const time = new Date(e.ts).toLocaleString();
        const color = eventColors[e.event] || '#888';
        const name = e.name || (e.sessionId === '*' ? '—' : e.sessionId.slice(0, 8));
        const extra = [];
        if (e.exitCode !== undefined && e.exitCode !== null) extra.push(`code=${e.exitCode}`);
        if (e.mode) extra.push(e.mode);
        return `<tr style="border-bottom:1px solid #1a1a2e">
          <td style="padding:3px 8px;color:#888;white-space:nowrap">${time}</td>
          <td style="padding:3px 8px;color:${color};font-weight:600">${e.event}</td>
          <td style="padding:3px 8px;color:#e0e0e0" title="${e.sessionId}">${name}</td>
          <td style="padding:3px 8px;color:#aaa">${e.reason || ''}</td>
          <td style="padding:3px 8px;color:#666">${extra.join(', ')}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('Failed to load lifecycle log:', err);
    }
  }

  async saveAppSettings() {
    const settings = {
      defaultClaudeMdPath: document.getElementById('appSettingsClaudeMdPath').value.trim(),
      defaultWorkingDir: document.getElementById('appSettingsDefaultDir').value.trim(),
      ralphTrackerEnabled: document.getElementById('appSettingsRalphEnabled').checked,
      // Header visibility settings
      showFontControls: document.getElementById('appSettingsShowFontControls').checked,
      showSystemStats: document.getElementById('appSettingsShowSystemStats').checked,
      showTokenCount: document.getElementById('appSettingsShowTokenCount').checked,
      showCost: document.getElementById('appSettingsShowCost').checked,
      showLifecycleLog: document.getElementById('appSettingsShowLifecycleLog').checked,
      showMonitor: document.getElementById('appSettingsShowMonitor').checked,
      showProjectInsights: document.getElementById('appSettingsShowProjectInsights').checked,
      showFileBrowser: document.getElementById('appSettingsShowFileBrowser').checked,
      showSubagents: document.getElementById('appSettingsShowSubagents').checked,
      subagentTrackingEnabled: document.getElementById('appSettingsSubagentTracking').checked,
      subagentActiveTabOnly: document.getElementById('appSettingsSubagentActiveTabOnly').checked,
      imageWatcherEnabled: document.getElementById('appSettingsImageWatcherEnabled').checked,
      tunnelEnabled: document.getElementById('appSettingsTunnelEnabled').checked,
      localEchoEnabled: document.getElementById('appSettingsLocalEcho').checked,
      tabTwoRows: document.getElementById('appSettingsTabTwoRows').checked,
      // Claude CLI settings
      claudeMode: document.getElementById('appSettingsClaudeMode').value,
      allowedTools: document.getElementById('appSettingsAllowedTools').value.trim(),
      // Claude Permissions settings
      agentTeamsEnabled: document.getElementById('appSettingsAgentTeams').checked,
      // CPU Priority settings
      nice: {
        enabled: document.getElementById('appSettingsNiceEnabled').checked,
        niceValue: parseInt(document.getElementById('appSettingsNiceValue').value) || 10,
      },
    };

    // Save to localStorage
    this.saveAppSettingsToStorage(settings);
    this._updateLocalEchoState();

    // Save voice settings to localStorage + include in server payload for cross-device sync
    const voiceSettings = {
      apiKey: document.getElementById('voiceDeepgramKey').value.trim(),
      language: document.getElementById('voiceLanguage').value,
      keyterms: document.getElementById('voiceKeyterms').value.trim(),
      insertMode: document.getElementById('voiceInsertMode').value,
    };
    VoiceInput._saveDeepgramConfig(voiceSettings);

    // Save notification preferences separately
    const notifPrefsToSave = {
      enabled: document.getElementById('appSettingsNotifEnabled').checked,
      browserNotifications: document.getElementById('appSettingsNotifBrowser').checked,
      audioAlerts: document.getElementById('appSettingsNotifAudio').checked,
      stuckThresholdMs: (parseInt(document.getElementById('appSettingsNotifStuckMins').value) || 10) * 60000,
      muteCritical: !document.getElementById('appSettingsNotifCritical').checked,
      muteWarning: !document.getElementById('appSettingsNotifWarning').checked,
      muteInfo: !document.getElementById('appSettingsNotifInfo').checked,
      // Per-event-type preferences
      eventTypes: {
        permission_prompt: {
          enabled: document.getElementById('eventPermissionEnabled').checked,
          browser: document.getElementById('eventPermissionBrowser').checked,
          push: document.getElementById('eventPermissionPush').checked,
          audio: document.getElementById('eventPermissionAudio').checked,
        },
        elicitation_dialog: {
          enabled: document.getElementById('eventQuestionEnabled').checked,
          browser: document.getElementById('eventQuestionBrowser').checked,
          push: document.getElementById('eventQuestionPush').checked,
          audio: document.getElementById('eventQuestionAudio').checked,
        },
        idle_prompt: {
          enabled: document.getElementById('eventIdleEnabled').checked,
          browser: document.getElementById('eventIdleBrowser').checked,
          push: document.getElementById('eventIdlePush').checked,
          audio: document.getElementById('eventIdleAudio').checked,
        },
        stop: {
          enabled: document.getElementById('eventStopEnabled').checked,
          browser: document.getElementById('eventStopBrowser').checked,
          push: document.getElementById('eventStopPush').checked,
          audio: document.getElementById('eventStopAudio').checked,
        },
        session_error: {
          enabled: true,
          browser: this.notificationManager?.preferences?.eventTypes?.session_error?.browser ?? true,
          push: this.notificationManager?.preferences?.eventTypes?.session_error?.push ?? false,
          audio: false,
        },
        respawn_cycle: {
          enabled: document.getElementById('eventRespawnEnabled').checked,
          browser: document.getElementById('eventRespawnBrowser').checked,
          push: document.getElementById('eventRespawnPush').checked,
          audio: document.getElementById('eventRespawnAudio').checked,
        },
        token_milestone: {
          enabled: true,
          browser: false,
          push: false,
          audio: false,
        },
        ralph_complete: {
          enabled: document.getElementById('eventRalphEnabled').checked,
          browser: document.getElementById('eventRalphBrowser').checked,
          push: document.getElementById('eventRalphPush').checked,
          audio: document.getElementById('eventRalphAudio').checked,
        },
        subagent_spawn: {
          enabled: document.getElementById('eventSubagentEnabled').checked,
          browser: document.getElementById('eventSubagentBrowser').checked,
          push: document.getElementById('eventSubagentPush').checked,
          audio: document.getElementById('eventSubagentAudio').checked,
        },
        subagent_complete: {
          enabled: document.getElementById('eventSubagentEnabled').checked,
          browser: document.getElementById('eventSubagentBrowser').checked,
          push: document.getElementById('eventSubagentPush').checked,
          audio: document.getElementById('eventSubagentAudio').checked,
        },
      },
      _version: 4,
    };
    if (this.notificationManager) {
      this.notificationManager.preferences = notifPrefsToSave;
      this.notificationManager.savePreferences();
    }

    // Sync push preferences to server
    this._syncPushPreferences();

    // Apply header visibility immediately
    this.applyHeaderVisibilitySettings();
    this.applyTabWrapSettings();
    this._updateTokensImmediate();  // Re-render token display (picks up showCost change)
    this.applyMonitorVisibility();
    this.renderProjectInsightsPanel();  // Re-render to apply visibility setting
    this.updateSubagentWindowVisibility();  // Apply subagent window visibility setting

    // Save to server (includes notification prefs for cross-browser persistence)
    // Strip device-specific keys — localEchoEnabled is per-platform (touch default differs)
    const { localEchoEnabled: _leo, ...serverSettings } = settings;
    try {
      await this._apiPut('/api/settings', { ...serverSettings, notificationPreferences: notifPrefsToSave, voiceSettings });

      // Save model configuration separately
      await this.saveModelConfigFromSettings();

      this.showToast('Settings saved', 'success');

      // Show tunnel-specific feedback if toggled on
      if (settings.tunnelEnabled) {
        this.showToast('Tunnel starting — QR code will appear when ready...', 'info');
      }
    } catch (err) {
      // Server save failed but localStorage succeeded
      this.showToast('Settings saved locally', 'warning');
    }

    this.closeAppSettings();
  }

  // Load model configuration from server for the settings modal
  async loadModelConfigForSettings() {
    try {
      const res = await fetch('/api/execution/model-config');
      const data = await res.json();
      if (data.success && data.data) {
        const config = data.data;
        // Default model
        const defaultModelEl = document.getElementById('appSettingsDefaultModel');
        if (defaultModelEl) {
          defaultModelEl.value = config.defaultModel || 'opus';
        }
        // Show recommendations
        const showRecsEl = document.getElementById('appSettingsShowModelRecommendations');
        if (showRecsEl) {
          showRecsEl.checked = config.showRecommendations ?? true;
        }
        // Agent type overrides
        const overrides = config.agentTypeOverrides || {};
        const exploreEl = document.getElementById('appSettingsModelExplore');
        const implementEl = document.getElementById('appSettingsModelImplement');
        const testEl = document.getElementById('appSettingsModelTest');
        const reviewEl = document.getElementById('appSettingsModelReview');
        if (exploreEl) exploreEl.value = overrides.explore || '';
        if (implementEl) implementEl.value = overrides.implement || '';
        if (testEl) testEl.value = overrides.test || '';
        if (reviewEl) reviewEl.value = overrides.review || '';
      }
    } catch (err) {
      console.warn('Failed to load model config:', err);
    }
  }

  // Save model configuration from settings modal to server
  async saveModelConfigFromSettings() {
    const defaultModelEl = document.getElementById('appSettingsDefaultModel');
    const showRecsEl = document.getElementById('appSettingsShowModelRecommendations');
    const exploreEl = document.getElementById('appSettingsModelExplore');
    const implementEl = document.getElementById('appSettingsModelImplement');
    const testEl = document.getElementById('appSettingsModelTest');
    const reviewEl = document.getElementById('appSettingsModelReview');

    const agentTypeOverrides = {};
    if (exploreEl?.value) agentTypeOverrides.explore = exploreEl.value;
    if (implementEl?.value) agentTypeOverrides.implement = implementEl.value;
    if (testEl?.value) agentTypeOverrides.test = testEl.value;
    if (reviewEl?.value) agentTypeOverrides.review = reviewEl.value;

    const config = {
      defaultModel: defaultModelEl?.value || 'opus',
      showRecommendations: showRecsEl?.checked ?? true,
      agentTypeOverrides,
    };

    try {
      await fetch('/api/execution/model-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
    } catch (err) {
      console.warn('Failed to save model config:', err);
    }
  }

  // Get the global Ralph tracker enabled setting
  isRalphTrackerEnabledByDefault() {
    const settings = this.loadAppSettingsFromStorage();
    return settings.ralphTrackerEnabled ?? false;
  }

  // Get the settings storage key based on device type (mobile vs desktop)
  getSettingsStorageKey() {
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    return isMobile ? 'codeman-app-settings-mobile' : 'codeman-app-settings';
  }

  // Get default settings based on device type
  // Note: Notification prefs are handled separately by NotificationManager
  getDefaultSettings() {
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    if (isMobile) {
      // Mobile defaults: minimal UI for small screens
      return {
        // Header visibility - hide everything on mobile
        showFontControls: false,
        showSystemStats: false,
        showTokenCount: false,
        showCost: false,
        // Panel visibility - hide panels on mobile (not enough space)
        showMonitor: false,
        showProjectInsights: false,
        showFileBrowser: false,
        showSubagents: false,
        // Feature toggles - keep tracking on even on mobile
        subagentTrackingEnabled: true,
        subagentActiveTabOnly: true, // Only show subagents for active tab
        imageWatcherEnabled: false,
        ralphTrackerEnabled: false,
        tabTwoRows: false,
      };
    }
    // Desktop defaults - rely on ?? operators in apply functions
    // This allows desktop to have different defaults without duplication
    return {};
  }

  loadAppSettingsFromStorage() {
    // Return cached settings if available (avoids synchronous localStorage + JSON.parse
    // on every SSE event — critical for input responsiveness)
    if (this._cachedAppSettings) return this._cachedAppSettings;
    try {
      const key = this.getSettingsStorageKey();
      const saved = localStorage.getItem(key);
      if (saved) {
        this._cachedAppSettings = JSON.parse(saved);
        return this._cachedAppSettings;
      }
    } catch (err) {
      console.error('Failed to load app settings:', err);
    }
    // Return device-specific defaults
    this._cachedAppSettings = this.getDefaultSettings();
    return this._cachedAppSettings;
  }

  saveAppSettingsToStorage(settings) {
    // Invalidate cache on save
    this._cachedAppSettings = settings;
    try {
      const key = this.getSettingsStorageKey();
      localStorage.setItem(key, JSON.stringify(settings));
    } catch (err) {
      console.error('Failed to save app settings:', err);
    }
  }

  applyHeaderVisibilitySettings() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const showFontControls = settings.showFontControls ?? defaults.showFontControls ?? false;
    const showSystemStats = settings.showSystemStats ?? defaults.showSystemStats ?? true;
    const showTokenCount = settings.showTokenCount ?? defaults.showTokenCount ?? true;

    const fontControlsEl = document.querySelector('.header-font-controls');
    const systemStatsEl = document.getElementById('headerSystemStats');
    const tokenCountEl = document.getElementById('headerTokens');

    if (fontControlsEl) {
      fontControlsEl.style.display = showFontControls ? '' : 'none';
    }
    if (systemStatsEl) {
      systemStatsEl.style.display = showSystemStats ? '' : 'none';
    }
    if (tokenCountEl) {
      tokenCountEl.style.display = showTokenCount ? '' : 'none';
    }

    // Hide lifecycle log button when setting is disabled
    const showLifecycleLog = settings.showLifecycleLog ?? defaults.showLifecycleLog ?? true;
    const lifecycleBtn = document.querySelector('.btn-lifecycle-log');
    if (lifecycleBtn) {
      lifecycleBtn.style.display = showLifecycleLog ? '' : 'none';
    }

    // Hide notification bell when notifications are disabled
    const notifEnabled = this.notificationManager?.preferences?.enabled ?? true;
    const notifBtn = document.querySelector('.btn-notifications');
    if (notifBtn) {
      notifBtn.style.display = notifEnabled ? '' : 'none';
    }
    // Close the drawer if notifications got disabled while it's open
    if (!notifEnabled) {
      const drawer = document.getElementById('notifDrawer');
      if (drawer) drawer.classList.remove('open');
    }
  }

  applyTabWrapSettings() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const deviceType = MobileDetection.getDeviceType();
    // Two-row tabs disabled on mobile/tablet — not enough screen space
    const twoRows = deviceType === 'desktop'
      ? (settings.tabTwoRows ?? defaults.tabTwoRows ?? false)
      : false;
    const prevTallTabs = this._tallTabsEnabled;
    this._tallTabsEnabled = twoRows;
    const tabsEl = document.getElementById('sessionTabs');
    if (tabsEl) {
      tabsEl.classList.toggle('tabs-two-rows', twoRows);
      tabsEl.classList.toggle('tabs-show-folder', twoRows);
    }
    // Re-render tabs if folder visibility changed (folder spans are generated in JS)
    if (prevTallTabs !== undefined && prevTallTabs !== twoRows) {
      this._fullRenderSessionTabs();
    }
  }

  applyMonitorVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const showMonitor = settings.showMonitor ?? defaults.showMonitor ?? true;
    const showSubagents = settings.showSubagents ?? defaults.showSubagents ?? true;
    const showFileBrowser = settings.showFileBrowser ?? defaults.showFileBrowser ?? false;

    const monitorPanel = document.getElementById('monitorPanel');
    if (monitorPanel) {
      monitorPanel.style.display = showMonitor ? '' : 'none';
      if (showMonitor) {
        monitorPanel.classList.add('open');
      } else {
        monitorPanel.classList.remove('open');
      }
    }

    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      if (showSubagents) {
        subagentsPanel.classList.remove('hidden');
      } else {
        subagentsPanel.classList.add('hidden');
      }
    }

    // File browser panel visibility
    const fileBrowserPanel = document.getElementById('fileBrowserPanel');
    if (fileBrowserPanel) {
      if (showFileBrowser && this.activeSessionId) {
        fileBrowserPanel.classList.add('visible');
        this.loadFileBrowser(this.activeSessionId);
      } else {
        fileBrowserPanel.classList.remove('visible');
      }
    }
  }

  closeMonitor() {
    // Hide the monitor panel
    const monitorPanel = document.getElementById('monitorPanel');
    if (monitorPanel) {
      monitorPanel.classList.remove('open');
      monitorPanel.style.display = 'none';
    }
    // Save the setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showMonitor = false;
    this.saveAppSettingsToStorage(settings);
  }

  closeSubagentsPanel() {
    // Hide the subagents panel
    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      subagentsPanel.classList.remove('open');
      subagentsPanel.classList.add('hidden');
    }
    this.subagentPanelVisible = false;
    // Save the setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showSubagents = false;
    this.saveAppSettingsToStorage(settings);
  }

  async clearAllSubagents() {
    const count = this.subagents.size;
    if (count === 0) {
      this.showToast('No subagents to clear', 'info');
      return;
    }

    if (!confirm(`Clear all ${count} tracked subagent(s)? This removes them from the UI but does not affect running processes.`)) {
      return;
    }

    try {
      const res = await fetch('/api/subagents', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        // Clear local state
        this.subagents.clear();
        this.subagentActivity.clear();
        this.subagentToolResults.clear();
        // Close any open subagent windows
        this.cleanupAllFloatingWindows();
        // Update UI
        this.renderSubagentPanel();
        this.renderMonitorSubagents();
        this.updateSubagentBadge();
        this.showToast(`Cleared ${data.data.cleared} subagent(s)`, 'success');
      } else {
        this.showToast('Failed to clear subagents: ' + data.error, 'error');
      }
    } catch (err) {
      this.showToast('Failed to clear subagents', 'error');
    }
  }

  toggleSubagentsPanel() {
    const panel = document.getElementById('subagentsPanel');
    const toggleBtn = document.getElementById('subagentsToggleBtn');
    if (!panel) return;

    // If hidden, show it first
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      // Save setting
      const settings = this.loadAppSettingsFromStorage();
      settings.showSubagents = true;
      this.saveAppSettingsToStorage(settings);
    }

    // Toggle open/collapsed state
    panel.classList.toggle('open');
    this.subagentPanelVisible = panel.classList.contains('open');

    // Update toggle button icon
    if (toggleBtn) {
      toggleBtn.innerHTML = this.subagentPanelVisible ? '&#x25BC;' : '&#x25B2;'; // Down when open, up when collapsed
    }

    if (this.subagentPanelVisible) {
      this.renderSubagentPanel();
    }
  }

  async loadAppSettingsFromServer(settingsPromise = null) {
    try {
      const settings = settingsPromise ? await settingsPromise : await fetch('/api/settings').then(r => r.ok ? r.json() : null);
      if (settings) {
        // Extract notification prefs before merging app settings
        const { notificationPreferences, voiceSettings, ...appSettings } = settings;
        // Filter out display settings — these are device-specific (mobile vs desktop)
        // and should not be synced from the server to avoid overriding mobile defaults.
        // NOTE: Feature toggles (subagentTrackingEnabled, imageWatcherEnabled, ralphTrackerEnabled)
        // are NOT display keys — they control server-side behavior and must sync from server.
        const displayKeys = new Set([
          'showFontControls', 'showSystemStats', 'showTokenCount', 'showCost',
          'showMonitor', 'showProjectInsights', 'showFileBrowser', 'showSubagents',
          'subagentActiveTabOnly', 'tabTwoRows', 'localEchoEnabled',
        ]);
        // Merge settings: non-display keys always sync from server,
        // display keys only seed from server when localStorage has no value
        // (prevents cross-device overwrite while fixing settings re-enabling on fresh loads)
        const localSettings = this.loadAppSettingsFromStorage();
        const merged = { ...localSettings };
        for (const [key, value] of Object.entries(appSettings)) {
          if (displayKeys.has(key)) {
            // Display keys: only use server value as initial seed
            if (!(key in localSettings)) {
              merged[key] = value;
            }
          } else {
            // Non-display keys: server always wins
            merged[key] = value;
          }
        }
        this.saveAppSettingsToStorage(merged);

        // Apply notification prefs from server if present (only if localStorage has none)
        if (notificationPreferences && this.notificationManager) {
          const localNotifPrefs = localStorage.getItem(this.notificationManager.getStorageKey());
          if (!localNotifPrefs) {
            this.notificationManager.preferences = notificationPreferences;
            this.notificationManager.savePreferences();
          }
        }

        // Sync voice settings from server (seed localStorage if no local API key)
        if (voiceSettings) {
          const localVoice = localStorage.getItem('codeman-voice-settings');
          if (!localVoice || !JSON.parse(localVoice).apiKey) {
            VoiceInput._saveDeepgramConfig(voiceSettings);
          }
        }

        return merged;
      }
    } catch (err) {
      console.error('Failed to load settings from server:', err);
    }
    return this.loadAppSettingsFromStorage();
  }


  /**
   * Load subagent window states from server (or localStorage fallback).
   * Called on page load to restore minimized/open window states.
   */
  async loadSubagentWindowStates() {
    let states = null;

    // Try server first for cross-browser sync
    try {
      const res = await fetch('/api/subagent-window-states');
      if (res.ok) {
        states = await res.json();
        // Also update localStorage
        localStorage.setItem('codeman-subagent-window-states', JSON.stringify(states));
      }
    } catch (err) {
      console.error('Failed to load subagent window states from server:', err);
    }

    // Fallback to localStorage
    if (!states) {
      try {
        const saved = localStorage.getItem('codeman-subagent-window-states');
        if (saved) {
          states = JSON.parse(saved);
        }
      } catch (err) {
        console.error('Failed to load subagent window states from localStorage:', err);
      }
    }

    return states || { minimized: {}, open: [] };
  }


  // ========== Persistent Parent Associations ==========
  // This is the ROCK-SOLID system for tracking which tab an agent belongs to.
  // Once an agent's parent is discovered, it's saved here PERMANENTLY.

  /**
   * Save the subagent parent map to localStorage and server.
   * Called whenever a new parent association is discovered.
   */
  async saveSubagentParentMap() {
    const mapData = Object.fromEntries(this.subagentParentMap);

    // Save to localStorage for instant recovery
    try {
      localStorage.setItem('codeman-subagent-parents', JSON.stringify(mapData));
    } catch (err) {
      console.error('Failed to save subagent parents to localStorage:', err);
    }

    // Save to server for cross-browser/session persistence
    try {
      await fetch('/api/subagent-parents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mapData)
      });
    } catch (err) {
      console.error('Failed to save subagent parents to server:', err);
    }
  }

  /**
   * Load the subagent parent map from server (or localStorage fallback).
   * Called once on page load, before any agents are discovered.
   */
  async loadSubagentParentMap() {
    let mapData = null;

    // Try server first (most authoritative)
    try {
      const res = await fetch('/api/subagent-parents');
      if (res.ok) {
        mapData = await res.json();
        // Update localStorage as cache
        localStorage.setItem('codeman-subagent-parents', JSON.stringify(mapData));
      }
    } catch (err) {
      console.error('Failed to load subagent parents from server:', err);
    }

    // Fallback to localStorage
    if (!mapData) {
      try {
        const saved = localStorage.getItem('codeman-subagent-parents');
        if (saved) {
          mapData = JSON.parse(saved);
        }
      } catch (err) {
        console.error('Failed to load subagent parents from localStorage:', err);
      }
    }

    // Populate the map (prune stale entries: require both session and agent to exist)
    if (mapData && typeof mapData === 'object') {
      for (const [agentId, sessionId] of Object.entries(mapData)) {
        if (this.sessions.has(sessionId) && this.subagents.has(agentId)) {
          this.subagentParentMap.set(agentId, sessionId);
        }
      }
    }
  }

  /**
   * Get the parent session ID for an agent from the persistent map.
   * This is the ONLY source of truth for connection lines.
   */
  getAgentParentSessionId(agentId) {
    return this.subagentParentMap.get(agentId) || null;
  }

  /**
   * Set and persist the parent session ID for an agent.
   * Once set, this association is PERMANENT and never recalculated.
   */
  setAgentParentSessionId(agentId, sessionId) {
    if (!agentId || !sessionId) return;

    // Only set if not already set (first association wins)
    if (this.subagentParentMap.has(agentId)) {
      return; // Already has a parent, don't override
    }

    this.subagentParentMap.set(agentId, sessionId);
    this.saveSubagentParentMap(); // Persist immediately

    // Also update the agent object for consistency
    const agent = this.subagents.get(agentId);
    if (agent) {
      agent.parentSessionId = sessionId;
      const session = this.sessions.get(sessionId);
      if (session) {
        agent.parentSessionName = this.getSessionName(session);
      }
      this.subagents.set(agentId, agent);
    }
  }

  // ========== Help Modal ==========

  showHelp() {
    const modal = document.getElementById('helpModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  closeHelp() {
    document.getElementById('helpModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  closeAllPanels() {
    this.closeSessionOptions();
    this.closeAppSettings();
    this.cancelCloseSession();
    this.closeTokenStats();
    document.getElementById('monitorPanel').classList.remove('open');
    // Collapse subagents panel (don't hide it permanently)
    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      subagentsPanel.classList.remove('open');
    }
    this.subagentPanelVisible = false;
  }

  // ========== Token Statistics Modal ==========

  async openTokenStats() {
    try {
      const response = await fetch('/api/token-stats');
      const data = await response.json();
      if (data.success) {
        this.renderTokenStats(data);
        document.getElementById('tokenStatsModal').classList.add('active');
      } else {
        this.showToast('Failed to load token stats', 'error');
      }
    } catch (err) {
      console.error('Failed to fetch token stats:', err);
      this.showToast('Failed to load token stats', 'error');
    }
  }

  renderTokenStats(data) {
    const { daily, totals } = data;

    // Calculate period totals
    const today = new Date().toISOString().split('T')[0];
    const todayData = daily.find(d => d.date === today) || { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

    // Last 7 days totals (for summary card)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const last7Days = daily.filter(d => new Date(d.date) >= sevenDaysAgo);
    const weekInput = last7Days.reduce((sum, d) => sum + d.inputTokens, 0);
    const weekOutput = last7Days.reduce((sum, d) => sum + d.outputTokens, 0);
    const weekCost = this.estimateCost(weekInput, weekOutput);

    // Lifetime totals (from aggregate stats)
    const lifetimeInput = totals.totalInputTokens;
    const lifetimeOutput = totals.totalOutputTokens;
    const lifetimeCost = this.estimateCost(lifetimeInput, lifetimeOutput);

    // Render summary cards
    const summaryEl = document.getElementById('statsSummary');
    summaryEl.innerHTML = `
      <div class="stat-card">
        <span class="stat-card-label">Today</span>
        <span class="stat-card-value">${this.formatTokens(todayData.inputTokens + todayData.outputTokens)}</span>
        <span class="stat-card-cost">~$${todayData.estimatedCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">7 Days</span>
        <span class="stat-card-value">${this.formatTokens(weekInput + weekOutput)}</span>
        <span class="stat-card-cost">~$${weekCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">Lifetime</span>
        <span class="stat-card-value">${this.formatTokens(lifetimeInput + lifetimeOutput)}</span>
        <span class="stat-card-cost">~$${lifetimeCost.toFixed(2)}</span>
      </div>
    `;

    // Render bar chart (last 7 days)
    const chartEl = document.getElementById('statsChart');
    const daysEl = document.getElementById('statsChartDays');

    // Get last 7 days (fill gaps with empty data)
    const chartData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayData = daily.find(d => d.date === dateStr);
      chartData.push({
        date: dateStr,
        dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
        tokens: dayData ? dayData.inputTokens + dayData.outputTokens : 0,
        cost: dayData ? dayData.estimatedCost : 0,
      });
    }

    // Find max for scaling
    const maxTokens = Math.max(...chartData.map(d => d.tokens), 1);

    chartEl.innerHTML = chartData.map(d => {
      const height = Math.max((d.tokens / maxTokens) * 100, 3);
      const tooltip = `${d.dayName}: ${this.formatTokens(d.tokens)} (~$${d.cost.toFixed(2)})`;
      return `<div class="bar" style="height: ${height}%" data-tooltip="${tooltip}"></div>`;
    }).join('');

    daysEl.innerHTML = chartData.map(d => `<span>${d.dayName}</span>`).join('');

    // Render table (last 14 days with data)
    const tableEl = document.getElementById('statsTable');
    const tableData = daily.slice(0, 14);

    if (tableData.length === 0) {
      tableEl.innerHTML = '<div class="stats-no-data">No usage data recorded yet</div>';
    } else {
      tableEl.innerHTML = `
        <div class="stats-table-header">
          <span>Date</span>
          <span>Input</span>
          <span>Output</span>
          <span>Cost</span>
        </div>
        ${tableData.map(d => {
          const dateObj = new Date(d.date + 'T00:00:00');
          const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return `
            <div class="stats-table-row">
              <span class="cell cell-date">${dateStr}</span>
              <span class="cell">${this.formatTokens(d.inputTokens)}</span>
              <span class="cell">${this.formatTokens(d.outputTokens)}</span>
              <span class="cell cell-cost">$${d.estimatedCost.toFixed(2)}</span>
            </div>
          `;
        }).join('')}
      `;
    }
  }

  closeTokenStats() {
    const modal = document.getElementById('tokenStatsModal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // ========== Monitor Panel (combined Mux Sessions + Background Tasks) ==========

  async toggleMonitorPanel() {
    const panel = document.getElementById('monitorPanel');
    const toggleBtn = document.getElementById('monitorToggleBtn');
    panel.classList.toggle('open');

    if (panel.classList.contains('open')) {
      // Load screens and start stats collection
      await this.loadMuxSessions();
      await fetch('/api/mux-sessions/stats/start', { method: 'POST' });
      this.renderTaskPanel();
      if (toggleBtn) toggleBtn.innerHTML = '&#x25BC;'; // Down arrow when open
    } else {
      // Stop stats collection when panel is closed
      await fetch('/api/mux-sessions/stats/stop', { method: 'POST' });
      if (toggleBtn) toggleBtn.innerHTML = '&#x25B2;'; // Up arrow when closed
    }
  }

  // Legacy alias for task panel toggle (used by session tab badge)
  toggleTaskPanel() {
    this.toggleMonitorPanel();
  }

  // ========== Monitor Panel Detach & Drag ==========

  toggleMonitorDetach() {
    const panel = document.getElementById('monitorPanel');
    const detachBtn = document.getElementById('monitorDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon (two overlapping squares)
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon (squared plus - dock back)
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupMonitorDrag();
    }
  }

  setupMonitorDrag() {
    const panel = document.getElementById('monitorPanel');
    const header = document.getElementById('monitorPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  }

  // ========== Subagents Panel Detach & Drag ==========

  toggleSubagentsDetach() {
    const panel = document.getElementById('subagentsPanel');
    const detachBtn = document.getElementById('subagentsDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupSubagentsDrag();
    }
  }

  setupSubagentsDrag() {
    const panel = document.getElementById('subagentsPanel');
    const header = document.getElementById('subagentsPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  }

  renderTaskPanel() {
    // Debounce renders at 100ms to prevent excessive DOM updates
    if (this.renderTaskPanelTimeout) {
      clearTimeout(this.renderTaskPanelTimeout);
    }
    this.renderTaskPanelTimeout = setTimeout(() => {
      this._renderTaskPanelImmediate();
    }, 100);
  }

  _renderTaskPanelImmediate() {
    const session = this.sessions.get(this.activeSessionId);
    const body = document.getElementById('backgroundTasksBody');
    const stats = document.getElementById('taskPanelStats');
    const section = document.getElementById('backgroundTasksSection');

    if (!session || !session.taskTree || session.taskTree.length === 0) {
      // Hide the entire section when there are no background tasks
      if (section) section.style.display = 'none';
      body.innerHTML = '';
      stats.textContent = '0 tasks';
      return;
    }

    // Show the section when there are tasks
    if (section) section.style.display = '';

    const taskStats = session.taskStats || { running: 0, completed: 0, failed: 0, total: 0 };
    stats.textContent = `${taskStats.running} running, ${taskStats.completed} done`;

    // Render task tree recursively
    const renderTask = (task, allTasks) => {
      const statusIcon = task.status === 'running' ? '' :
                        task.status === 'completed' ? '&#x2713;' : '&#x2717;';
      const duration = task.endTime
        ? `${((task.endTime - task.startTime) / 1000).toFixed(1)}s`
        : `${((Date.now() - task.startTime) / 1000).toFixed(0)}s...`;

      let childrenHtml = '';
      if (task.children && task.children.length > 0) {
        childrenHtml = '<div class="task-children">';
        for (const childId of task.children) {
          // Find child task in allTasks map
          const childTask = allTasks.find(t => t.id === childId);
          if (childTask) {
            childrenHtml += `<div class="task-node">${renderTask(childTask, allTasks)}</div>`;
          }
        }
        childrenHtml += '</div>';
      }

      return `
        <div class="task-item">
          <span class="task-status-icon ${task.status}">${statusIcon}</span>
          <div class="task-info">
            <div class="task-description">${escapeHtml(task.description)}</div>
            <div class="task-meta">
              <span class="task-type">${task.subagentType}</span>
              <span>${duration}</span>
            </div>
          </div>
        </div>
        ${childrenHtml}
      `;
    };

    // Flatten all tasks for lookup
    const allTasks = this.flattenTaskTree(session.taskTree);

    // Render only root tasks (those without parents or with null parentId)
    let html = '<div class="task-tree">';
    for (const task of session.taskTree) {
      html += `<div class="task-node">${renderTask(task, allTasks)}</div>`;
    }
    html += '</div>';

    body.innerHTML = html;
  }

  flattenTaskTree(tasks, result = []) {
    for (const task of tasks) {
      result.push(task);
      // Children are stored as IDs, not nested objects in taskTree
      // The task tree from server already has the structure we need
    }
    return result;
  }

  // ========== Enhanced Ralph Wiggum Loop Panel ==========

  updateRalphState(sessionId, updates) {
    const existing = this.ralphStates.get(sessionId) || { loop: null, todos: [] };
    const updated = { ...existing, ...updates };
    this.ralphStates.set(sessionId, updated);

    // Re-render if this is the active session
    if (sessionId === this.activeSessionId) {
      this.renderRalphStatePanel();
    }
  }

  toggleRalphStatePanel() {
    // Preserve xterm scroll position to prevent jump when panel height changes
    const xtermViewport = this.terminal?.element?.querySelector('.xterm-viewport');
    const scrollTop = xtermViewport?.scrollTop;

    this.ralphStatePanelCollapsed = !this.ralphStatePanelCollapsed;
    this.renderRalphStatePanel();

    // Restore scroll position and refit terminal after layout change
    requestAnimationFrame(() => {
      // Restore xterm scroll position
      if (xtermViewport && scrollTop !== undefined) {
        xtermViewport.scrollTop = scrollTop;
      }
      // Refit terminal to new container size
      if (this.terminal && this.fitAddon) {
        this.fitAddon.fit();
      }
    });
  }

  async closeRalphTracker() {
    if (!this.activeSessionId) return;

    // Mark this session as explicitly closed - will stay hidden until user re-enables
    this.ralphClosedSessions.add(this.activeSessionId);

    // Disable tracker via API
    await this._apiPost(`/api/sessions/${this.activeSessionId}/ralph-config`, { enabled: false });

    // Clear local state and hide panel
    this.ralphStates.delete(this.activeSessionId);
    this.renderRalphStatePanel();
  }

  // ========== @fix_plan.md Integration ==========

  toggleRalphMenu() {
    const dropdown = document.getElementById('ralphDropdown');
    if (dropdown) {
      dropdown.classList.toggle('show');
    }
  }

  closeRalphMenu() {
    const dropdown = document.getElementById('ralphDropdown');
    if (dropdown) {
      dropdown.classList.remove('show');
    }
  }

  async resetCircuitBreaker() {
    if (!this.activeSessionId) return;

    try {
      const response = await this._apiPost(`/api/sessions/${this.activeSessionId}/ralph-circuit-breaker/reset`, {});
      const data = await response?.json();

      if (data?.success) {
        this.notificationManager?.notify({
          urgency: 'info',
          category: 'circuit-breaker',
          title: 'Reset',
          message: 'Circuit breaker reset to CLOSED',
        });
      }
    } catch (error) {
      console.error('Error resetting circuit breaker:', error);
    }
  }

  /**
   * Generate @fix_plan.md content and show in a modal.
   */
  async showFixPlan() {
    if (!this.activeSessionId) return;

    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/fix-plan`);
      const data = await response.json();

      if (!data.success) {
        this.notificationManager?.notify({
          urgency: 'error',
          category: 'fix-plan',
          title: 'Error',
          message: data.error || 'Failed to generate fix plan',
        });
        return;
      }

      // Show in a modal
      this.showFixPlanModal(data.data.content, data.data.todoCount);
    } catch (error) {
      console.error('Error fetching fix plan:', error);
    }
  }

  /**
   * Show fix plan content in a modal.
   */
  showFixPlanModal(content, todoCount) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('fixPlanModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'fixPlanModal';
      modal.className = 'modal';
      modal.innerHTML = `
        <div class="modal-content fix-plan-modal">
          <div class="modal-header">
            <h3>@fix_plan.md</h3>
            <button class="btn-close" onclick="app.closeFixPlanModal()">&times;</button>
          </div>
          <div class="modal-body">
            <textarea id="fixPlanContent" class="fix-plan-textarea" readonly></textarea>
          </div>
          <div class="modal-footer">
            <span class="fix-plan-stats" id="fixPlanStats"></span>
            <button class="btn btn-secondary" onclick="app.copyFixPlan()">Copy</button>
            <button class="btn btn-primary" onclick="app.writeFixPlanToFile()">Write to File</button>
            <button class="btn btn-secondary" onclick="app.closeFixPlanModal()">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    document.getElementById('fixPlanContent').value = content;
    document.getElementById('fixPlanStats').textContent = `${todoCount} tasks`;
    modal.classList.add('show');
  }

  closeFixPlanModal() {
    const modal = document.getElementById('fixPlanModal');
    if (modal) {
      modal.classList.remove('show');
    }
  }

  async copyFixPlan() {
    const content = document.getElementById('fixPlanContent')?.value;
    if (content) {
      await navigator.clipboard.writeText(content);
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'fix-plan',
        title: 'Copied',
        message: 'Fix plan copied to clipboard',
      });
    }
  }

  async writeFixPlanToFile() {
    if (!this.activeSessionId) return;

    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/fix-plan/write`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        this.notificationManager?.notify({
          urgency: 'info',
          category: 'fix-plan',
          title: 'Written',
          message: `@fix_plan.md written to ${data.data.filePath}`,
        });
        this.closeFixPlanModal();
      } else {
        this.notificationManager?.notify({
          urgency: 'error',
          category: 'fix-plan',
          title: 'Error',
          message: data.error || 'Failed to write file',
        });
      }
    } catch (error) {
      console.error('Error writing fix plan:', error);
    }
  }

  async importFixPlanFromFile() {
    if (!this.activeSessionId) return;

    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/fix-plan/read`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        this.notificationManager?.notify({
          urgency: 'info',
          category: 'fix-plan',
          title: 'Imported',
          message: `Imported ${data.data.importedCount} tasks from @fix_plan.md`,
        });
        // Refresh ralph panel
        this.updateRalphState(this.activeSessionId, { todos: data.data.todos });
      } else {
        this.notificationManager?.notify({
          urgency: 'warning',
          category: 'fix-plan',
          title: 'Not Found',
          message: data.error || '@fix_plan.md not found',
        });
      }
    } catch (error) {
      console.error('Error importing fix plan:', error);
    }
  }

  toggleRalphDetach() {
    const panel = this.$('ralphStatePanel');
    const detachBtn = this.$('ralphDetachBtn');

    if (!panel) return;

    if (panel.classList.contains('detached')) {
      // Re-attach to original position
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon (two overlapping squares)
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      // Expand when detaching for better visibility
      this.ralphStatePanelCollapsed = false;
      panel.classList.remove('collapsed');
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon (squared plus - dock back)
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupRalphDrag();
    }
    this.renderRalphStatePanel();
  }

  setupRalphDrag() {
    const panel = this.$('ralphStatePanel');
    const header = this.$('ralphSummary');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onMouseDown = (e) => {
      // Only drag from header, not from buttons or toggle
      if (e.target.closest('button') || e.target.closest('.ralph-toggle')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._ralphDragHandler);
    header._ralphDragHandler = onMouseDown;
    header.addEventListener('mousedown', onMouseDown);
  }

  renderRalphStatePanel() {
    // Debounce renders at 50ms to prevent excessive DOM updates
    if (this.renderRalphStatePanelTimeout) {
      clearTimeout(this.renderRalphStatePanelTimeout);
    }
    this.renderRalphStatePanelTimeout = setTimeout(() => {
      this._renderRalphStatePanelImmediate();
    }, 50);
  }

  _renderRalphStatePanelImmediate() {
    const panel = this.$('ralphStatePanel');
    const toggle = this.$('ralphToggle');

    if (!panel) return;

    // If user explicitly closed this session's Ralph panel, keep it hidden
    if (this.ralphClosedSessions.has(this.activeSessionId)) {
      panel.style.display = 'none';
      return;
    }

    const state = this.ralphStates.get(this.activeSessionId);

    // Check if there's anything to show
    // Only show panel if tracker is enabled OR there's active state to display
    const isEnabled = state?.loop?.enabled === true;
    const hasLoop = state?.loop?.active || state?.loop?.completionPhrase;
    const hasTodos = state?.todos?.length > 0;
    const hasCircuitBreaker = state?.circuitBreaker && state.circuitBreaker.state !== 'CLOSED';
    const hasStatusBlock = state?.statusBlock !== undefined;

    if (!isEnabled && !hasLoop && !hasTodos && !hasCircuitBreaker && !hasStatusBlock) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = '';

    // Calculate completion percentage
    const todos = state?.todos || [];
    const completed = todos.filter(t => t.status === 'completed').length;
    const total = todos.length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Update progress rings
    this.updateRalphRing(percent);

    // Update status badge (pass completion info)
    this.updateRalphStatus(state?.loop, completed, total);

    // Update stats
    this.updateRalphStats(state?.loop, completed, total);

    // Update circuit breaker badge
    this.updateCircuitBreakerBadge(state?.circuitBreaker);

    // Handle collapsed/expanded state
    if (this.ralphStatePanelCollapsed) {
      panel.classList.add('collapsed');
      if (toggle) toggle.innerHTML = '&#x25BC;'; // Down arrow when collapsed (click to expand)
    } else {
      panel.classList.remove('collapsed');
      if (toggle) toggle.innerHTML = '&#x25B2;'; // Up arrow when expanded (click to collapse)

      // Update expanded view content
      this.updateRalphExpandedView(state);
    }
  }

  updateRalphRing(percent) {
    // Ensure percent is a valid number between 0-100
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));

    // Mini ring (in summary)
    const miniProgress = this.$('ralphRingMiniProgress');
    const miniText = this.$('ralphRingMiniText');
    if (miniProgress) {
      // Circumference = 2 * PI * r = 2 * PI * 15.9 ≈ 100
      // offset = 100 means 0% visible, offset = 0 means 100% visible
      const offset = 100 - safePercent;
      miniProgress.style.strokeDashoffset = offset;
    }
    if (miniText) {
      miniText.textContent = `${safePercent}%`;
    }

    // Large ring (in expanded view)
    const largeProgress = this.$('ralphRingProgress');
    const largePercent = this.$('ralphRingPercent');
    if (largeProgress) {
      // Circumference = 2 * PI * r = 2 * PI * 42 ≈ 264
      // offset = 264 means 0% visible, offset = 0 means 100% visible
      const offset = 264 - (264 * safePercent / 100);
      largeProgress.style.strokeDashoffset = offset;
    }
    if (largePercent) {
      largePercent.textContent = `${safePercent}%`;
    }
  }

  updateRalphStatus(loop, completed = 0, total = 0) {
    const badge = this.$('ralphStatusBadge');
    const statusText = badge?.querySelector('.ralph-status-text');
    if (!badge || !statusText) return;

    badge.classList.remove('active', 'completed', 'tracking');

    if (loop?.active) {
      badge.classList.add('active');
      statusText.textContent = 'Running';
    } else if (total > 0 && completed === total) {
      // Only show "Complete" when all todos are actually done
      badge.classList.add('completed');
      statusText.textContent = 'Complete';
    } else if (loop?.enabled || total > 0) {
      badge.classList.add('tracking');
      statusText.textContent = 'Tracking';
    } else {
      statusText.textContent = 'Idle';
    }
  }

  updateCircuitBreakerBadge(circuitBreaker) {
    // Find or create the circuit breaker badge container
    let cbContainer = this.$('ralphCircuitBreakerBadge');
    if (!cbContainer) {
      // Create container if it doesn't exist (we'll add it dynamically)
      const summary = this.$('ralphSummary');
      if (!summary) return;

      // Check if it already exists
      cbContainer = summary.querySelector('.ralph-circuit-breaker');
      if (!cbContainer) {
        cbContainer = document.createElement('div');
        cbContainer.id = 'ralphCircuitBreakerBadge';
        cbContainer.className = 'ralph-circuit-breaker';
        // Insert after the status badge
        const statusBadge = this.$('ralphStatusBadge');
        if (statusBadge && statusBadge.nextSibling) {
          statusBadge.parentNode.insertBefore(cbContainer, statusBadge.nextSibling);
        } else {
          summary.appendChild(cbContainer);
        }
      }
    }

    // Hide if no circuit breaker state or CLOSED
    if (!circuitBreaker || circuitBreaker.state === 'CLOSED') {
      cbContainer.style.display = 'none';
      return;
    }

    cbContainer.style.display = '';
    cbContainer.classList.remove('half-open', 'open');

    if (circuitBreaker.state === 'HALF_OPEN') {
      cbContainer.classList.add('half-open');
      cbContainer.innerHTML = `<span class="cb-icon">⚠</span><span class="cb-text">Warning</span>`;
      cbContainer.title = circuitBreaker.reason || 'Circuit breaker warning';
    } else if (circuitBreaker.state === 'OPEN') {
      cbContainer.classList.add('open');
      cbContainer.innerHTML = `<span class="cb-icon">🛑</span><span class="cb-text">Stuck</span>`;
      cbContainer.title = circuitBreaker.reason || 'Loop appears stuck';
    }

    // Add click handler to reset
    cbContainer.onclick = () => this.resetCircuitBreaker();
  }

  async resetCircuitBreaker() {
    if (!this.activeSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.activeSessionId}/ralph-circuit-breaker/reset`, {});
    } catch (err) {
      console.error('Failed to reset circuit breaker:', err);
    }
  }

  updateRalphStats(loop, completed, total) {
    // Time stat
    const timeEl = this.$('ralphStatTime');
    if (timeEl) {
      if (loop?.elapsedHours !== null && loop?.elapsedHours !== undefined) {
        timeEl.textContent = this.formatRalphTime(loop.elapsedHours);
      } else if (loop?.startedAt) {
        const hours = (Date.now() - loop.startedAt) / (1000 * 60 * 60);
        timeEl.textContent = this.formatRalphTime(hours);
      } else {
        timeEl.textContent = '0m';
      }
    }

    // Cycles stat
    const cyclesEl = this.$('ralphStatCycles');
    if (cyclesEl) {
      if (loop?.maxIterations) {
        cyclesEl.textContent = `${loop.cycleCount || 0}/${loop.maxIterations}`;
      } else {
        cyclesEl.textContent = String(loop?.cycleCount || 0);
      }
    }

    // Tasks stat
    const tasksEl = this.$('ralphStatTasks');
    if (tasksEl) {
      tasksEl.textContent = `${completed}/${total}`;
    }
  }

  formatRalphTime(hours) {
    if (hours < 0.0167) return '0m'; // < 1 minute
    if (hours < 1) {
      const minutes = Math.round(hours * 60);
      return `${minutes}m`;
    }
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  updateRalphExpandedView(state) {
    // Update phrase
    const phraseEl = this.$('ralphPhrase');
    if (phraseEl) {
      phraseEl.textContent = state?.loop?.completionPhrase || '--';
    }

    // Update elapsed
    const elapsedEl = this.$('ralphElapsed');
    if (elapsedEl) {
      if (state?.loop?.elapsedHours !== null && state?.loop?.elapsedHours !== undefined) {
        elapsedEl.textContent = this.formatRalphTime(state.loop.elapsedHours);
      } else if (state?.loop?.startedAt) {
        const hours = (Date.now() - state.loop.startedAt) / (1000 * 60 * 60);
        elapsedEl.textContent = this.formatRalphTime(hours);
      } else {
        elapsedEl.textContent = '0m';
      }
    }

    // Update iterations
    const iterationsEl = this.$('ralphIterations');
    if (iterationsEl) {
      if (state?.loop?.maxIterations) {
        iterationsEl.textContent = `${state.loop.cycleCount || 0} / ${state.loop.maxIterations}`;
      } else {
        iterationsEl.textContent = String(state?.loop?.cycleCount || 0);
      }
    }

    // Update tasks count
    const todos = state?.todos || [];
    const completed = todos.filter(t => t.status === 'completed').length;
    const tasksCountEl = this.$('ralphTasksCount');
    if (tasksCountEl) {
      tasksCountEl.textContent = `${completed}/${todos.length}`;
    }

    // Update plan version display if available
    if (state?.loop?.planVersion) {
      this.updatePlanVersionDisplay(state.loop.planVersion, state.loop.planHistoryLength || 1);
    } else {
      this.updatePlanVersionDisplay(null, 0);
    }

    // Render task cards
    this.renderRalphTasks(todos);

    // Render RALPH_STATUS block if present
    this.renderRalphStatusBlock(state?.statusBlock);
  }

  renderRalphStatusBlock(statusBlock) {
    // Find or create the status block container
    let container = this.$('ralphStatusBlockDisplay');
    const expandedContent = this.$('ralphExpandedContent');

    if (!statusBlock) {
      // Remove container if no status block
      if (container) {
        container.remove();
      }
      return;
    }

    if (!container && expandedContent) {
      container = document.createElement('div');
      container.id = 'ralphStatusBlockDisplay';
      container.className = 'ralph-status-block';
      // Insert at the top of expanded content
      expandedContent.insertBefore(container, expandedContent.firstChild);
    }

    if (!container) return;

    // Build status class
    const statusClass = statusBlock.status === 'IN_PROGRESS' ? 'in-progress'
      : statusBlock.status === 'COMPLETE' ? 'complete'
      : statusBlock.status === 'BLOCKED' ? 'blocked' : '';

    // Build tests status icon
    const testsIcon = statusBlock.testsStatus === 'PASSING' ? '✅'
      : statusBlock.testsStatus === 'FAILING' ? '❌'
      : '⏸';

    // Build work type icon
    const workIcon = statusBlock.workType === 'IMPLEMENTATION' ? '🔧'
      : statusBlock.workType === 'TESTING' ? '🧪'
      : statusBlock.workType === 'DOCUMENTATION' ? '📝'
      : statusBlock.workType === 'REFACTORING' ? '♻️' : '📋';

    let html = `
      <div class="ralph-status-block-header">
        <span>RALPH_STATUS</span>
        <span class="ralph-status-block-status ${statusClass}">${escapeHtml(statusBlock.status)}</span>
        ${statusBlock.exitSignal ? '<span style="color: #4caf50;">🚪 EXIT</span>' : ''}
      </div>
      <div class="ralph-status-block-stats">
        <span>${workIcon} ${escapeHtml(statusBlock.workType)}</span>
        <span>📁 ${statusBlock.filesModified} files</span>
        <span>✓ ${escapeHtml(String(statusBlock.tasksCompletedThisLoop))} tasks</span>
        <span>${testsIcon} Tests: ${escapeHtml(statusBlock.testsStatus)}</span>
      </div>
    `;

    if (statusBlock.recommendation) {
      html += `<div class="ralph-status-block-recommendation">${escapeHtml(statusBlock.recommendation)}</div>`;
    }

    container.innerHTML = html;
  }

  renderRalphTasks(todos) {
    const grid = this.$('ralphTasksGrid');
    if (!grid) return;

    if (todos.length === 0) {
      if (grid.children.length !== 1 || !grid.querySelector('.ralph-state-empty')) {
        grid.innerHTML = '<div class="ralph-state-empty">No tasks detected</div>';
      }
      return;
    }

    // Sort: by priority (P0 > P1 > P2 > null), then by status (in_progress > pending > completed)
    const priorityOrder = { 'P0': 0, 'P1': 1, 'P2': 2, null: 3 };
    const statusOrder = { in_progress: 0, pending: 1, completed: 2 };
    const sorted = [...todos].sort((a, b) => {
      const priA = priorityOrder[a.priority] ?? 3;
      const priB = priorityOrder[b.priority] ?? 3;
      if (priA !== priB) return priA - priB;
      return (statusOrder[a.status] || 1) - (statusOrder[b.status] || 1);
    });

    // Always do full rebuild for enhanced features
    const fragment = document.createDocumentFragment();

    sorted.forEach((todo, idx) => {
      const card = this.createRalphTaskCard(todo, idx);
      fragment.appendChild(card);
    });

    grid.innerHTML = '';
    grid.appendChild(fragment);
  }

  createRalphTaskCard(todo, index) {
    const card = document.createElement('div');
    const statusClass = `task-${todo.status.replace('_', '-')}`;
    const priorityClass = todo.priority ? `task-priority-${todo.priority.toLowerCase()}` : '';
    card.className = `ralph-task-card ${statusClass} ${priorityClass}`.trim();
    card.dataset.taskId = todo.id || index;

    // Status icon
    const iconSpan = document.createElement('span');
    iconSpan.className = 'ralph-task-icon';
    iconSpan.textContent = this.getRalphTaskIcon(todo.status);
    card.appendChild(iconSpan);

    // Priority badge if present
    if (todo.priority) {
      const prioritySpan = document.createElement('span');
      prioritySpan.className = `ralph-task-priority priority-${todo.priority.toLowerCase()}`;
      prioritySpan.textContent = todo.priority;
      card.appendChild(prioritySpan);
    }

    // Task content
    const contentSpan = document.createElement('span');
    contentSpan.className = 'ralph-task-content';
    contentSpan.textContent = todo.content;
    card.appendChild(contentSpan);

    // Attempts indicator (if > 0)
    if (todo.attempts && todo.attempts > 0) {
      const attemptsSpan = document.createElement('span');
      attemptsSpan.className = 'ralph-task-attempts';
      if (todo.lastError) {
        attemptsSpan.classList.add('has-errors');
        attemptsSpan.title = `Last error: ${todo.lastError}`;
      }
      attemptsSpan.textContent = `#${todo.attempts}`;
      card.appendChild(attemptsSpan);
    }

    // Verification badge (if has verification criteria)
    if (todo.verificationCriteria) {
      const verifySpan = document.createElement('span');
      verifySpan.className = 'ralph-task-verify-badge';
      verifySpan.title = `Verify: ${todo.verificationCriteria}`;
      verifySpan.textContent = '✓';
      card.appendChild(verifySpan);
    }

    // Dependencies indicator
    if (todo.dependencies && todo.dependencies.length > 0) {
      const depsSpan = document.createElement('span');
      depsSpan.className = 'ralph-task-deps-indicator';
      depsSpan.title = `Depends on: ${todo.dependencies.join(', ')}`;
      depsSpan.textContent = `↗${todo.dependencies.length}`;
      card.appendChild(depsSpan);
    }

    // Quick action buttons (shown on hover)
    const actions = document.createElement('div');
    actions.className = 'ralph-task-actions';

    if (todo.status !== 'completed') {
      const completeBtn = document.createElement('button');
      completeBtn.className = 'ralph-task-action-btn';
      completeBtn.textContent = '✓';
      completeBtn.title = 'Mark complete';
      completeBtn.onclick = (e) => {
        e.stopPropagation();
        this.updateRalphTaskStatus(todo.id, 'completed');
      };
      actions.appendChild(completeBtn);
    }

    if (todo.status === 'completed') {
      const reopenBtn = document.createElement('button');
      reopenBtn.className = 'ralph-task-action-btn';
      reopenBtn.textContent = '↺';
      reopenBtn.title = 'Reopen';
      reopenBtn.onclick = (e) => {
        e.stopPropagation();
        this.updateRalphTaskStatus(todo.id, 'pending');
      };
      actions.appendChild(reopenBtn);
    }

    if (todo.lastError) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'ralph-task-action-btn';
      retryBtn.textContent = '↻';
      retryBtn.title = 'Retry (clear error)';
      retryBtn.onclick = (e) => {
        e.stopPropagation();
        this.retryRalphTask(todo.id);
      };
      actions.appendChild(retryBtn);
    }

    card.appendChild(actions);

    return card;
  }

  // Update a Ralph task's status via API
  async updateRalphTaskStatus(taskId, newStatus) {
    if (!this.activeSessionId) return;

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/task/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update task');
      }

      this.showToast(`Task ${newStatus === 'completed' ? 'completed' : 'reopened'}`, 'success');
    } catch (err) {
      this.showToast('Failed to update task: ' + err.message, 'error');
    }
  }

  // Retry a failed Ralph task (clear error, reset attempts)
  async retryRalphTask(taskId) {
    if (!this.activeSessionId) return;

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/task/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attempts: 0, lastError: null, status: 'pending' })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to retry task');
      }

      this.showToast('Task reset for retry', 'success');
    } catch (err) {
      this.showToast('Failed to retry task: ' + err.message, 'error');
    }
  }

  getRalphTaskIcon(status) {
    switch (status) {
      case 'completed': return '✓';
      case 'in_progress': return '◐';
      case 'pending':
      default: return '○';
    }
  }

  // Legacy method for backwards compatibility
  getTodoIcon(status) {
    return this.getRalphTaskIcon(status);
  }

  // ========== Plan Versioning ==========

  // Update the plan version display in the Ralph panel
  updatePlanVersionDisplay(version, historyLength) {
    const versionRow = this.$('ralphVersionRow');
    const versionBadge = this.$('ralphPlanVersion');
    const rollbackBtn = this.$('ralphRollbackBtn');

    if (!versionRow) return;

    if (version && version > 0) {
      versionRow.style.display = '';
      if (versionBadge) versionBadge.textContent = `v${version}`;
      if (rollbackBtn) {
        rollbackBtn.style.display = historyLength > 1 ? '' : 'none';
      }
    } else {
      versionRow.style.display = 'none';
    }
  }

  // Show plan history dropdown
  async showPlanHistory() {
    if (!this.activeSessionId) return;

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/history`);
      const data = await res.json();

      if (data.error) {
        this.showToast('Failed to load plan history: ' + data.error, 'error');
        return;
      }

      const history = data.history || [];
      if (history.length === 0) {
        this.showToast('No plan history available', 'info');
        return;
      }

      // Show history dropdown modal
      this.showPlanHistoryModal(history, data.currentVersion);
    } catch (err) {
      this.showToast('Failed to load plan history: ' + err.message, 'error');
    }
  }

  // Show the plan history modal
  showPlanHistoryModal(history, currentVersion) {
    // Remove existing modal if present
    const existing = document.getElementById('planHistoryModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'planHistoryModal';
    modal.className = 'modal active';
    modal.innerHTML = `
      <div class="modal-backdrop" onclick="app.closePlanHistoryModal()"></div>
      <div class="modal-content modal-sm">
        <div class="modal-header">
          <h3>Plan Version History</h3>
          <button class="modal-close" onclick="app.closePlanHistoryModal()">&times;</button>
        </div>
        <div class="modal-body">
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            Current version: <strong>v${currentVersion}</strong>
          </p>
          <div class="plan-history-list">
            ${history.map(item => `
              <div class="plan-history-item ${item.version === currentVersion ? 'current' : ''}"
                   onclick="app.rollbackToPlanVersion(${item.version})">
                <div>
                  <span class="plan-history-version">v${item.version}</span>
                  <span class="plan-history-tasks">${item.taskCount || 0} tasks</span>
                </div>
                <span class="plan-history-time">${this.formatRelativeTime(item.timestamp)}</span>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-toolbar" onclick="app.closePlanHistoryModal()">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  closePlanHistoryModal() {
    const modal = document.getElementById('planHistoryModal');
    if (modal) modal.remove();
  }

  // Rollback to a specific plan version
  async rollbackToPlanVersion(version) {
    if (!this.activeSessionId) return;

    if (!confirm(`Rollback to plan version ${version}? Current changes will be preserved in history.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/rollback/${version}`, {
        method: 'POST'
      });
      const data = await res.json();

      if (data.error) {
        this.showToast('Failed to rollback: ' + data.error, 'error');
        return;
      }

      this.showToast(`Rolled back to plan v${version}`, 'success');
      this.closePlanHistoryModal();

      // Refresh the plan display
      this.renderRalphStatePanel();
    } catch (err) {
      this.showToast('Failed to rollback: ' + err.message, 'error');
    }
  }

  // Format relative time (e.g., "2 mins ago", "1 hour ago")
  formatRelativeTime(timestamp) {
    if (!timestamp) return '';

    const now = Date.now();
    const diff = now - timestamp;

    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  // ========== Subagent Panel (Claude Code Background Agents) ==========

  // Legacy alias
  toggleSubagentPanel() {
    this.toggleSubagentsPanel();
  }

  updateSubagentBadge() {
    const badge = this.$('subagentCountBadge');
    const activeCount = Array.from(this.subagents.values()).filter(s => s.status === 'active' || s.status === 'idle').length;

    // Update badge with active count
    if (badge) {
      badge.textContent = activeCount > 0 ? activeCount : '';
    }
  }

  renderSubagentPanel() {
    // Debounce renders at 150ms to prevent excessive DOM updates from rapid subagent events
    if (this._subagentPanelRenderTimeout) {
      clearTimeout(this._subagentPanelRenderTimeout);
    }
    this._subagentPanelRenderTimeout = setTimeout(() => {
      scheduleBackground(() => this._renderSubagentPanelImmediate());
    }, 150);
  }

  _renderSubagentPanelImmediate() {
    const list = this.$('subagentList');
    if (!list) return;

    // Always update badge count
    this.updateSubagentBadge();

    // Always update monitor panel (even if subagent panel is hidden)
    this.renderMonitorSubagents();

    // If panel is not visible, don't render content
    if (!this.subagentPanelVisible) {
      return;
    }

    // Render subagent list
    if (this.subagents.size === 0) {
      list.innerHTML = '<div class="subagent-empty">No background agents detected</div>';
      return;
    }

    const html = [];
    const sorted = Array.from(this.subagents.values()).sort((a, b) => {
      // Active first, then by last activity
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return 1;
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });

    for (const agent of sorted) {
      const isActive = this.activeSubagentId === agent.agentId;
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const activity = this.subagentActivity.get(agent.agentId) || [];
      const lastActivity = activity[activity.length - 1];
      const lastTool = lastActivity?.type === 'tool' ? lastActivity.tool : null;
      const hasWindow = this.subagentWindows.has(agent.agentId);
      const canKill = agent.status === 'active' || agent.status === 'idle';
      const modelBadge = agent.modelShort
        ? `<span class="subagent-model-badge ${escapeHtml(agent.modelShort)}">${escapeHtml(agent.modelShort)}</span>`
        : '';

      const teammateInfo = this.getTeammateInfo(agent);
      const displayName = teammateInfo ? teammateInfo.name : (agent.description || agent.agentId.substring(0, 7));
      const teammateBadge = this.getTeammateBadgeHtml(agent);
      const agentIcon = teammateInfo ? `<span class="subagent-icon teammate-dot teammate-color-${teammateInfo.color}">●</span>` : '<span class="subagent-icon">🤖</span>';
      html.push(`
        <div class="subagent-item ${statusClass} ${isActive ? 'selected' : ''}${teammateInfo ? ' is-teammate' : ''}"
             onclick="app.selectSubagent('${escapeHtml(agent.agentId)}')"
             ondblclick="app.openSubagentWindow('${escapeHtml(agent.agentId)}')"
             title="Double-click to open tracking window">
          <div class="subagent-header">
            ${agentIcon}
            <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(displayName.length > 40 ? displayName.substring(0, 40) + '...' : displayName)}</span>
            ${teammateBadge}
            ${modelBadge}
            <span class="subagent-status ${statusClass}">${agent.status}</span>
            ${canKill ? `<button class="subagent-kill-btn" onclick="event.stopPropagation(); app.killSubagent('${escapeHtml(agent.agentId)}')" title="Kill agent">&#x2715;</button>` : ''}
            <button class="subagent-window-btn" onclick="event.stopPropagation(); app.${hasWindow ? 'closeSubagentWindow' : 'openSubagentWindow'}('${escapeHtml(agent.agentId)}')" title="${hasWindow ? 'Close window' : 'Open in window'}">
              ${hasWindow ? '✕' : '⧉'}
            </button>
          </div>
          <div class="subagent-meta">
            <span class="subagent-tools">${agent.toolCallCount} tools</span>
            ${lastTool ? `<span class="subagent-last-tool">${this.getToolIcon(lastTool)} ${lastTool}</span>` : ''}
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  }

  selectSubagent(agentId) {
    this.activeSubagentId = agentId;
    this.renderSubagentPanel();
    this.renderSubagentDetail();
  }

  renderSubagentDetail() {
    const detail = this.$('subagentDetail');
    if (!detail) return;

    if (!this.activeSubagentId) {
      detail.innerHTML = '<div class="subagent-empty">Select an agent to view details</div>';
      return;
    }

    const agent = this.subagents.get(this.activeSubagentId);
    const activity = this.subagentActivity.get(this.activeSubagentId) || [];

    if (!agent) {
      detail.innerHTML = '<div class="subagent-empty">Agent not found</div>';
      return;
    }

    const activityHtml = activity.slice(-30).map(a => {
      const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
      if (a.type === 'tool') {
        const toolDetail = this.getToolDetailExpanded(a.tool, a.input, a.fullInput, a.toolUseId);
        return `<div class="subagent-activity tool" data-tool-use-id="${a.toolUseId || ''}">
          <span class="time">${time}</span>
          <span class="icon">${this.getToolIcon(a.tool)}</span>
          <span class="name">${a.tool}</span>
          <span class="detail">${toolDetail.primary}</span>
          ${toolDetail.hasMore ? `<button class="tool-expand-btn" onclick="app.toggleToolParams('${escapeHtml(a.toolUseId)}')">▶</button>` : ''}
          ${toolDetail.hasMore ? `<div class="tool-params-expanded" id="tool-params-${a.toolUseId}" style="display:none;"><pre>${escapeHtml(JSON.stringify(a.fullInput || a.input, null, 2))}</pre></div>` : ''}
        </div>`;
      } else if (a.type === 'tool_result') {
        const icon = a.isError ? '❌' : '📄';
        const statusClass = a.isError ? 'error' : '';
        const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
        const preview = a.preview.length > 80 ? a.preview.substring(0, 80) + '...' : a.preview;
        return `<div class="subagent-activity tool-result ${statusClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="name">${a.tool || 'result'}</span>
          <span class="detail">${escapeHtml(preview)}${sizeInfo}</span>
        </div>`;
      } else if (a.type === 'progress') {
        // Check for hook events
        const isHook = a.hookEvent || a.hookName;
        const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
        const hookClass = isHook ? ' hook' : '';
        const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
        return `<div class="subagent-activity progress${hookClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="detail">${displayText}</span>
        </div>`;
      } else if (a.type === 'message') {
        const preview = a.text.length > 100 ? a.text.substring(0, 100) + '...' : a.text;
        return `<div class="subagent-activity message">
          <span class="time">${time}</span>
          <span class="icon">💬</span>
          <span class="detail">${escapeHtml(preview)}</span>
        </div>`;
      }
      return '';
    }).join('');

    const detailTitle = agent.description || `Agent ${agent.agentId}`;
    const modelBadge = agent.modelShort
      ? `<span class="subagent-model-badge ${escapeHtml(agent.modelShort)}">${escapeHtml(agent.modelShort)}</span>`
      : '';
    const tokenStats = (agent.totalInputTokens || agent.totalOutputTokens)
      ? `<span>Tokens: ${this.formatTokenCount(agent.totalInputTokens || 0)}↓ ${this.formatTokenCount(agent.totalOutputTokens || 0)}↑</span>`
      : '';

    detail.innerHTML = `
      <div class="subagent-detail-header">
        <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(detailTitle.length > 60 ? detailTitle.substring(0, 60) + '...' : detailTitle)}</span>
        ${modelBadge}
        <span class="subagent-status ${agent.status}">${agent.status}</span>
        <button class="subagent-transcript-btn" onclick="app.viewSubagentTranscript('${escapeHtml(agent.agentId)}')">
          View Full Transcript
        </button>
      </div>
      <div class="subagent-detail-stats">
        <span>Tools: ${agent.toolCallCount}</span>
        <span>Entries: ${agent.entryCount}</span>
        <span>Size: ${(agent.fileSize / 1024).toFixed(1)}KB</span>
        ${tokenStats}
      </div>
      <div class="subagent-activity-log">
        ${activityHtml || '<div class="subagent-empty">No activity yet</div>'}
      </div>
    `;
  }

  toggleToolParams(toolUseId) {
    const el = document.getElementById(`tool-params-${toolUseId}`);
    if (!el) return;
    const btn = el.previousElementSibling;
    if (el.style.display === 'none') {
      el.style.display = 'block';
      if (btn) btn.textContent = '▼';
    } else {
      el.style.display = 'none';
      if (btn) btn.textContent = '▶';
    }
  }

  formatTokenCount(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return count.toString();
  }

  formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return bytes + 'B';
  }

  getToolIcon(tool) {
    const icons = {
      WebSearch: '🔍',
      WebFetch: '🌐',
      Read: '📖',
      Write: '📝',
      Edit: '✏️',
      Bash: '💻',
      Glob: '📁',
      Grep: '🔎',
      Task: '🤖',
    };
    return icons[tool] || '🔧';
  }

  getToolDetail(tool, input) {
    if (!input) return '';
    if (tool === 'WebSearch' && input.query) return `"${input.query}"`;
    if (tool === 'WebFetch' && input.url) return input.url;
    if (tool === 'Read' && input.file_path) return input.file_path;
    if ((tool === 'Write' || tool === 'Edit') && input.file_path) return input.file_path;
    if (tool === 'Bash' && input.command) {
      const cmd = input.command;
      return cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd;
    }
    if (tool === 'Glob' && input.pattern) return input.pattern;
    if (tool === 'Grep' && input.pattern) return input.pattern;
    return '';
  }

  getToolDetailExpanded(tool, input, fullInput, toolUseId) {
    const primary = this.getToolDetail(tool, input);
    // Check if there are additional params beyond the primary one
    const primaryKeys = ['query', 'url', 'file_path', 'command', 'pattern'];
    const inputKeys = Object.keys(fullInput || input || {});
    const extraKeys = inputKeys.filter(k => !primaryKeys.includes(k));
    const hasMore = extraKeys.length > 0 || (fullInput && JSON.stringify(fullInput).length > 100);
    return { primary, hasMore, fullInput: fullInput || input };
  }

  async killSubagent(agentId) {
    try {
      const res = await this._apiDelete(`/api/subagents/${agentId}`);
      const data = await res?.json();
      if (data?.success) {
        // Update local state
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.status = 'completed';
          this.subagents.set(agentId, agent);
        }
        this.renderSubagentPanel();
        this.renderSubagentDetail();
        this.updateSubagentWindows();
        this.showToast(`Subagent ${agentId.substring(0, 7)} killed`, 'success');
      } else {
        this.showToast(data.error || 'Failed to kill subagent', 'error');
      }
    } catch (err) {
      console.error('Failed to kill subagent:', err);
      this.showToast('Failed to kill subagent: ' + err.message, 'error');
    }
  }

  async viewSubagentTranscript(agentId) {
    try {
      const res = await fetch(`/api/subagents/${agentId}/transcript?format=formatted`);
      const data = await res.json();

      if (!data.success) {
        alert('Failed to load transcript');
        return;
      }

      // Show in a modal or new window
      const content = data.data.formatted.join('\n');
      const win = window.open('', '_blank', 'width=800,height=600');
      win.document.write(`
        <html>
          <head>
            <title>Subagent ${escapeHtml(agentId)} Transcript</title>
            <style>
              body { background: #1a1a2e; color: #eee; font-family: monospace; padding: 20px; }
              pre { white-space: pre-wrap; word-wrap: break-word; }
            </style>
          </head>
          <body>
            <h2>Subagent ${escapeHtml(agentId)} Transcript (${data.data.entryCount} entries)</h2>
            <pre>${escapeHtml(content)}</pre>
          </body>
        </html>
      `);
    } catch (err) {
      console.error('Failed to load transcript:', err);
      alert('Failed to load transcript: ' + err.message);
    }
  }

  // ========== Subagent Parent TAB Tracking ==========
  //
  // CRITICAL: This system tracks which TAB an agent window connects to.
  // The association is stored in `subagentParentMap` (agentId -> sessionId).
  // The sessionId IS the tab identifier (tabs have data-id="${sessionId}").
  // Once set, this association is PERMANENT and persisted across restarts.

  /**
   * Find and assign the parent TAB for a subagent.
   *
   * Matching strategy (in order):
   * 1. Use existing stored association from subagentParentMap (permanent)
   * 2. Match via claudeSessionId (agent.sessionId === session.claudeSessionId)
   * 3. FALLBACK: Use the currently active session (since that's where the user typed the command)
   *
   * Once found, the association is stored PERMANENTLY in subagentParentMap.
   */
  findParentSessionForSubagent(agentId) {
    // Check if we already have a permanent association
    if (this.subagentParentMap.has(agentId)) {
      // Already have a parent - update agent object from stored value
      const storedSessionId = this.subagentParentMap.get(agentId);
      // Verify the session still exists
      if (this.sessions.has(storedSessionId)) {
        const agent = this.subagents.get(agentId);
        if (agent && !agent.parentSessionId) {
          agent.parentSessionId = storedSessionId;
          const session = this.sessions.get(storedSessionId);
          if (session) {
            agent.parentSessionName = this.getSessionName(session);
          }
          this.subagents.set(agentId, agent);
          this.updateSubagentWindowParent(agentId);
        }
        return;
      }
      // Stored session no longer exists - clear and re-discover
      this.subagentParentMap.delete(agentId);
    }

    const agent = this.subagents.get(agentId);
    if (!agent) return;

    // Strategy 1: Match via claudeSessionId (most accurate)
    if (agent.sessionId) {
      for (const [sessionId, session] of this.sessions) {
        if (session.claudeSessionId === agent.sessionId) {
          // FOUND! Store this association PERMANENTLY
          this.setAgentParentSessionId(agentId, sessionId);
          this.updateSubagentWindowParent(agentId);
          this.updateSubagentWindowVisibility();
          this.updateConnectionLines();
          return;
        }
      }
    }

    // Strategy 2: FALLBACK - Use the currently active session
    // This works because agents spawn from where the user typed the command
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      this.setAgentParentSessionId(agentId, this.activeSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
      return;
    }

    // Strategy 3: If no active session, use the first session
    if (this.sessions.size > 0) {
      const firstSessionId = this.sessions.keys().next().value;
      this.setAgentParentSessionId(agentId, firstSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
    }
  }

  /**
   * Re-check all orphan subagents (those without a parent TAB) when a session updates.
   * Called when session:updated fires with claudeSessionId.
   *
   * Also re-validates existing associations when claudeSessionId becomes available,
   * in case the fallback association was wrong.
   */
  recheckOrphanSubagents() {
    let anyChanged = false;
    for (const [agentId, agent] of this.subagents) {
      // Check if this agent has no parent in the persistent map
      if (!this.subagentParentMap.has(agentId)) {
        this.findParentSessionForSubagent(agentId);
        if (this.subagentParentMap.has(agentId)) {
          anyChanged = true;
        }
      } else if (agent.sessionId) {
        // Agent has a stored parent, but check if we can now do a proper claudeSessionId match
        // This handles the case where fallback was used but now the real parent is known
        const storedParent = this.subagentParentMap.get(agentId);
        const storedSession = this.sessions.get(storedParent);

        // If the stored session doesn't have a matching claudeSessionId, try to find the real match
        if (storedSession && storedSession.claudeSessionId !== agent.sessionId) {
          for (const [sessionId, session] of this.sessions) {
            if (session.claudeSessionId === agent.sessionId) {
              // Found the real parent - update the association
              this.subagentParentMap.set(agentId, sessionId);
              agent.parentSessionId = sessionId;
              agent.parentSessionName = this.getSessionName(session);
              this.subagents.set(agentId, agent);
              this.updateSubagentWindowParent(agentId);
              anyChanged = true;
              break;
            }
          }
        }
      }
    }
    if (anyChanged) {
      this.saveSubagentParentMap();
      this.updateConnectionLines();
    }
  }

  /**
   * Update parentSessionName for all subagents belonging to a TAB.
   * Called when a session is renamed to keep cached names fresh.
   */
  updateSubagentParentNames(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const newName = this.getSessionName(session);

    // Skip iteration if name hasn't changed (avoids O(n) loop on every session:updated)
    const cachedName = this._parentNameCache?.get(sessionId);
    if (cachedName === newName) return;
    if (!this._parentNameCache) this._parentNameCache = new Map();
    this._parentNameCache.set(sessionId, newName);

    for (const [agentId, storedSessionId] of this.subagentParentMap) {
      if (storedSessionId === sessionId) {
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.parentSessionName = newName;
          this.subagents.set(agentId, agent);

          // Update the window header if open
          const windowData = this.subagentWindows.get(agentId);
          if (windowData) {
            const parentNameEl = windowData.element.querySelector('.subagent-window-parent .parent-name');
            if (parentNameEl) {
              parentNameEl.textContent = newName;
            }
          }
        }
      }
    }
  }

  /**
   * Add parent header to an agent window, showing which TAB it belongs to.
   */
  updateSubagentWindowParent(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (!windowData) return;

    // Get parent from persistent map (THE source of truth)
    const parentSessionId = this.subagentParentMap.get(agentId);
    if (!parentSessionId) return;

    const session = this.sessions.get(parentSessionId);
    const parentName = session ? this.getSessionName(session) : 'Unknown';

    // Check if parent header already exists
    const win = windowData.element;
    const existingParent = win.querySelector('.subagent-window-parent');
    if (existingParent) {
      // Update existing
      existingParent.dataset.parentSession = parentSessionId;
      const nameEl = existingParent.querySelector('.parent-name');
      if (nameEl) {
        nameEl.textContent = parentName;
        nameEl.onclick = () => this.selectSession(parentSessionId);
      }
      return;
    }

    // Insert new parent header after the main header
    const header = win.querySelector('.subagent-window-header');
    if (header) {
      const parentDiv = document.createElement('div');
      parentDiv.className = 'subagent-window-parent';
      parentDiv.dataset.parentSession = parentSessionId;
      parentDiv.innerHTML = `
        <span class="parent-label">from</span>
        <span class="parent-name" onclick="app.selectSession('${escapeHtml(parentSessionId)}')">${escapeHtml(parentName)}</span>
      `;
      header.insertAdjacentElement('afterend', parentDiv);
    }
  }


  /**
   * Show/hide subagent windows based on active session.
   * Behavior controlled by "Subagents for Active Tab Only" setting.
   * Uses the PERSISTENT subagentParentMap for accurate tab-based visibility.
   */
  updateSubagentWindowVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;

    for (const [agentId, windowInfo] of this.subagentWindows) {
      // Get parent from PERSISTENT map (THE source of truth)
      const storedParent = this.subagentParentMap.get(agentId);
      const agent = this.subagents.get(agentId);
      const parentSessionId = storedParent || agent?.parentSessionId;

      // Determine visibility based on setting
      let shouldShow;
      if (activeTabOnly) {
        // Show if: no parent known yet, or parent matches active session
        const hasKnownParent = !!parentSessionId;
        shouldShow = !hasKnownParent || parentSessionId === this.activeSessionId;
      } else {
        // Show all windows (original behavior)
        shouldShow = true;
      }

      if (shouldShow) {
        // Show window (unless it was minimized by user)
        if (!windowInfo.minimized) {
          windowInfo.element.style.display = 'flex';
        }
        windowInfo.hidden = false;
      } else {
        // Hide window (but don't close it)
        windowInfo.element.style.display = 'none';
        windowInfo.hidden = true;
      }
    }
    // Update connection lines after visibility changes
    this.updateConnectionLines();
    // Restack mobile windows after visibility changes
    this.relayoutMobileSubagentWindows();
  }


  // Close all subagent windows for a session (fully removes them, not minimize)
  // If cleanupData is true, also remove activity and toolResults data to prevent memory leaks
  closeSessionSubagentWindows(sessionId, cleanupData = false) {
    const toClose = [];
    for (const [agentId, _windowData] of this.subagentWindows) {
      const agent = this.subagents.get(agentId);
      // Check both subagent parentSessionId and subagentParentMap
      // (standalone pane windows use subagentParentMap, not subagents map)
      const parentFromMap = this.subagentParentMap.get(agentId);
      if (agent?.parentSessionId === sessionId || parentFromMap === sessionId) {
        toClose.push(agentId);
      }
    }
    for (const agentId of toClose) {
      this.forceCloseSubagentWindow(agentId);
      // Clean up activity and tool results data if requested (prevents memory leaks)
      if (cleanupData) {
        this.subagents.delete(agentId);
        this.subagentActivity.delete(agentId);
        this.subagentToolResults.delete(agentId);
        this.subagentParentMap.delete(agentId);
      }
    }
    // Also clean up minimized agents for this session
    this.minimizedSubagents.delete(sessionId);
    this.renderSessionTabs();
  }

  // Fully close a subagent window (removes from DOM, not minimize)
  forceCloseSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      // Clean up resize observer
      if (windowData.resizeObserver) {
        windowData.resizeObserver.disconnect();
      }
      // Clean up global drag event listeners (prevents memory leak)
      if (windowData.dragListeners) {
        document.removeEventListener('mousemove', windowData.dragListeners.move);
        document.removeEventListener('mouseup', windowData.dragListeners.up);
        if (windowData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', windowData.dragListeners.touchMove);
          document.removeEventListener('touchend', windowData.dragListeners.up);
          document.removeEventListener('touchcancel', windowData.dragListeners.up);
        }
      }
      windowData.element.remove();
      this.subagentWindows.delete(agentId);
    }
    // Clean up teammate terminal if present
    const termData = this.teammateTerminals.get(agentId);
    if (termData) {
      if (termData.resizeObserver) {
        termData.resizeObserver.disconnect();
      }
      if (termData.terminal) {
        try { termData.terminal.dispose(); } catch {}
      }
      this.teammateTerminals.delete(agentId);
    }
  }


  minimizeSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      windowData.element.style.display = 'none';
      windowData.minimized = true;
      this.updateConnectionLines();
    }
  }


  renderSubagentWindowContent(agentId) {
    // Skip if this window has a live terminal (don't overwrite xterm with activity HTML)
    if (this.teammateTerminals.has(agentId)) return;

    const body = document.getElementById(`subagent-window-body-${agentId}`);
    if (!body) return;

    const activity = this.subagentActivity.get(agentId) || [];

    if (activity.length === 0) {
      body.innerHTML = '<div class="subagent-empty">No activity yet</div>';
      return;
    }

    // Incremental rendering: track how many items are already rendered
    const renderedCount = body.dataset.renderedCount ? parseInt(body.dataset.renderedCount, 10) : 0;
    const maxItems = 100;
    const visibleActivity = activity.slice(-maxItems);

    // If activity was trimmed or this is a fresh render, do full rebuild
    if (renderedCount === 0 || renderedCount > visibleActivity.length || body.children.length === 0 ||
        (body.children.length === 1 && body.querySelector('.subagent-empty'))) {
      // Full rebuild
      const html = visibleActivity.map(a => this._renderActivityItem(a)).join('');
      body.innerHTML = html;
      body.dataset.renderedCount = String(visibleActivity.length);
    } else {
      // Incremental: only append new items
      const newItems = visibleActivity.slice(renderedCount);
      if (newItems.length > 0) {
        const newHtml = newItems.map(a => this._renderActivityItem(a)).join('');
        body.insertAdjacentHTML('beforeend', newHtml);
        body.dataset.renderedCount = String(visibleActivity.length);

        // Trim excess children from the front if over maxItems
        while (body.children.length > maxItems) {
          body.removeChild(body.firstChild);
        }
      }
    }

    body.scrollTop = body.scrollHeight;
  }

  _renderActivityItem(a) {
    const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
    if (a.type === 'tool') {
      return `<div class="activity-line">
        <span class="time">${time}</span>
        <span class="tool-icon">${this.getToolIcon(a.tool)}</span>
        <span class="tool-name">${a.tool}</span>
        <span class="tool-detail">${escapeHtml(this.getToolDetail(a.tool, a.input))}</span>
      </div>`;
    } else if (a.type === 'tool_result') {
      const icon = a.isError ? '❌' : '📄';
      const statusClass = a.isError ? ' error' : '';
      const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
      const preview = a.preview.length > 60 ? a.preview.substring(0, 60) + '...' : a.preview;
      return `<div class="activity-line result-line${statusClass}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${a.tool || '→'}</span>
        <span class="tool-detail">${escapeHtml(preview)}${sizeInfo}</span>
      </div>`;
    } else if (a.type === 'progress') {
      const isHook = a.hookEvent || a.hookName;
      const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
      const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
      return `<div class="activity-line progress-line${isHook ? ' hook-line' : ''}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-detail">${escapeHtml(displayText)}</span>
      </div>`;
    } else if (a.type === 'message') {
      const preview = a.text.length > 150 ? a.text.substring(0, 150) + '...' : a.text;
      return `<div class="message-line">
        <span class="time">${time}</span> 💬 ${escapeHtml(preview)}
      </div>`;
    }
    return '';
  }

  // Update all open subagent windows
  updateSubagentWindows() {
    for (const agentId of this.subagentWindows.keys()) {
      this.renderSubagentWindowContent(agentId);
      this.updateSubagentWindowHeader(agentId);
    }
  }

  // Update subagent window header (title and status)
  updateSubagentWindowHeader(agentId) {
    const agent = this.subagents.get(agentId);
    if (!agent) return;

    const win = document.getElementById(`subagent-window-${agentId}`);
    if (!win) return;

    // Update title/id element with description if available
    const idEl = win.querySelector('.subagent-window-title .id');
    if (idEl) {
      const teammateInfo = this.getTeammateInfo(agent);
      const windowTitle = teammateInfo ? teammateInfo.name : (agent.description || agentId.substring(0, 7));
      const truncatedTitle = windowTitle.length > 50 ? windowTitle.substring(0, 50) + '...' : windowTitle;
      idEl.textContent = truncatedTitle;
    }

    // Add or update teammate badge
    let tmBadge = win.querySelector('.teammate-badge');
    const teammateInfo = this.getTeammateInfo(agent);
    if (teammateInfo && !tmBadge) {
      const titleContainer = win.querySelector('.subagent-window-title');
      if (titleContainer) {
        const badge = document.createElement('span');
        badge.className = `teammate-badge teammate-color-${teammateInfo.color}`;
        badge.title = `Team: ${teammateInfo.teamName}`;
        badge.textContent = `@${teammateInfo.name}`;
        const statusEl = titleContainer.querySelector('.status');
        if (statusEl) statusEl.insertAdjacentElement('beforebegin', badge);
      }
    }

    // Update full tooltip
    const titleContainer = win.querySelector('.subagent-window-title');
    if (titleContainer) {
      titleContainer.title = agent.description || agentId;
    }

    // Update or add model badge
    let modelBadge = win.querySelector('.subagent-window-title .subagent-model-badge');
    if (agent.modelShort) {
      if (!modelBadge) {
        modelBadge = document.createElement('span');
        modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
        const statusEl = win.querySelector('.subagent-window-title .status');
        if (statusEl) {
          statusEl.insertAdjacentElement('beforebegin', modelBadge);
        }
      }
      modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
      modelBadge.textContent = agent.modelShort;
    }

    // Update status
    const statusEl = win.querySelector('.subagent-window-title .status');
    if (statusEl) {
      statusEl.className = `status ${agent.status}`;
      statusEl.textContent = agent.status;
    }
  }

  // Open windows for all active subagents
  openAllActiveSubagentWindows() {
    for (const [agentId, agent] of this.subagents) {
      if (agent.status === 'active' && !this.subagentWindows.has(agentId)) {
        this.openSubagentWindow(agentId);
      }
    }
  }

  // ========== Agent Teams ==========

  /** Initialize an xterm.js terminal for a teammate's tmux pane */
  initTeammateTerminal(agentId, paneInfo, windowElement) {
    const body = windowElement.querySelector('.subagent-window-body');
    if (!body) return;

    // Clear the activity log content
    body.innerHTML = '';
    body.classList.add('teammate-terminal-body');
    windowElement.classList.add('has-terminal');

    const sessionId = paneInfo.sessionId;

    // Buffer incoming terminal data until xterm is ready
    const pendingData = [];
    this.teammateTerminals.set(agentId, {
      terminal: null,
      fitAddon: null,
      paneTarget: paneInfo.paneTarget,
      sessionId,
      resizeObserver: null,
      pendingData,
    });

    // Defer terminal creation to next frame so the body element has computed dimensions
    requestAnimationFrame(() => {
      // Safety: if window was closed before we got here, bail out
      if (!document.contains(body)) {
        this.teammateTerminals.delete(agentId);
        return;
      }

      const terminal = new Terminal({
        theme: {
          background: '#0d0d0d',
          foreground: '#e0e0e0',
          cursor: '#e0e0e0',
          cursorAccent: '#0d0d0d',
          selection: 'rgba(255, 255, 255, 0.3)',
          black: '#0d0d0d',
          red: '#ff6b6b',
          green: '#51cf66',
          yellow: '#ffd43b',
          blue: '#339af0',
          magenta: '#cc5de8',
          cyan: '#22b8cf',
          white: '#e0e0e0',
          brightBlack: '#495057',
          brightRed: '#ff8787',
          brightGreen: '#69db7c',
          brightYellow: '#ffe066',
          brightBlue: '#5c7cfa',
          brightMagenta: '#da77f2',
          brightCyan: '#66d9e8',
          brightWhite: '#ffffff',
        },
        fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
        fontSize: 12,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 5000,
        allowTransparency: true,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);

      if (typeof Unicode11Addon !== 'undefined') {
        try {
          const unicode11Addon = new Unicode11Addon.Unicode11Addon();
          terminal.loadAddon(unicode11Addon);
          terminal.unicode.activeVersion = '11';
        } catch (_e) { /* Unicode11 addon failed */ }
      }

      try {
        terminal.open(body);
      } catch (err) {
        console.warn('[TeammateTerminal] Failed to open terminal:', err);
        this.teammateTerminals.delete(agentId);
        return;
      }

      // Wait for terminal renderer to fully initialize before any writes.
      // xterm.js needs a few frames after open() before write() is safe.
      setTimeout(() => {
        try { fitAddon.fit(); } catch {}

        // Fetch initial pane buffer
        fetch(`/api/sessions/${sessionId}/teammate-pane-buffer/${encodeURIComponent(paneInfo.paneTarget)}`)
          .then(r => r.json())
          .then(resp => {
            if (resp.success && resp.data?.buffer) {
              try { terminal.write(resp.data.buffer); } catch {}
            }
          })
          .catch(err => console.error('[TeammateTerminal] Failed to fetch buffer:', err));

        // Flush any data that arrived while terminal was initializing
        for (const chunk of pendingData) {
          try { terminal.write(chunk); } catch {}
        }
        pendingData.length = 0;
      }, 100);

      // Forward keyboard input to the teammate's pane
      terminal.onData((data) => {
        fetch(`/api/sessions/${sessionId}/teammate-pane-input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paneTarget: paneInfo.paneTarget, input: data }),
        }).catch(err => console.error('[TeammateTerminal] Failed to send input:', err));
      });

      // Resize observer to refit terminal when window is resized
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });
      });
      resizeObserver.observe(body);

      // Update the stored entry with the real terminal
      const entry = this.teammateTerminals.get(agentId);
      if (entry) {
        entry.terminal = terminal;
        entry.fitAddon = fitAddon;
        entry.resizeObserver = resizeObserver;
      }
    });
  }

  /** Open a standalone terminal window for a tmux-pane teammate (no subagent entry needed) */
  openTeammateTerminalWindow(paneData) {
    // Only open if the session has a tab in Codeman
    if (!this.sessions.has(paneData.sessionId)) return;

    // Use pane target as the unique ID for this window
    const windowId = `pane-${paneData.paneTarget}`;

    // If window already exists, focus it
    if (this.subagentWindows.has(windowId)) {
      const existing = this.subagentWindows.get(windowId);
      if (existing.hidden) {
        existing.element.style.display = 'flex';
        existing.hidden = false;
      }
      existing.element.style.zIndex = ++this.subagentWindowZIndex;
      if (existing.minimized) {
        this.restoreSubagentWindow(windowId);
      }
      return;
    }

    // Calculate position
    const windowCount = this.subagentWindows.size;
    const windowWidth = 550;
    const windowHeight = 400;
    const gap = 20;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const startX = 50;
    const startY = 120;
    const maxCols = Math.floor((viewportWidth - startX - 50) / (windowWidth + gap)) || 1;
    const maxRows = Math.floor((viewportHeight - startY - 50) / (windowHeight + gap)) || 1;
    const col = windowCount % maxCols;
    const row = Math.floor(windowCount / maxCols) % maxRows;
    let finalX = startX + col * (windowWidth + gap);
    let finalY = startY + row * (windowHeight + gap);
    finalX = Math.max(10, Math.min(finalX, viewportWidth - windowWidth - 10));
    finalY = Math.max(10, Math.min(finalY, viewportHeight - windowHeight - 10));

    // Color badge
    const colorClass = paneData.color || 'blue';

    // Create window element
    const win = document.createElement('div');
    win.className = 'subagent-window has-terminal';
    win.id = `subagent-window-${windowId}`;
    win.style.zIndex = ++this.subagentWindowZIndex;
    win.style.left = `${finalX}px`;
    win.style.top = `${finalY}px`;
    win.style.width = `${windowWidth}px`;
    win.style.height = `${windowHeight}px`;
    win.innerHTML = `
      <div class="subagent-window-header">
        <div class="subagent-window-title" title="Teammate terminal: ${escapeHtml(paneData.teammateName)} (pane ${paneData.paneTarget})">
          <span class="icon" style="color: var(--team-color-${colorClass}, #339af0)">⬤</span>
          <span class="id">${escapeHtml(paneData.teammateName)}</span>
          <span class="status running">terminal</span>
        </div>
        <div class="subagent-window-actions">
          <button onclick="app.closeSubagentWindow('${escapeHtml(windowId)}')" title="Minimize to tab">─</button>
        </div>
      </div>
      <div class="subagent-window-body teammate-terminal-body" id="subagent-window-body-${windowId}">
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.subagent-window-header'));

    // Make resizable if method exists
    if (typeof this.makeWindowResizable === 'function') {
      this.makeWindowResizable(win);
    }

    // Check visibility based on active session
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;
    const shouldHide = activeTabOnly && paneData.sessionId !== this.activeSessionId;

    // Store reference
    this.subagentWindows.set(windowId, {
      element: win,
      minimized: false,
      hidden: shouldHide,
      dragListeners,
      description: `Teammate: ${paneData.teammateName}`,
    });

    // Also add to subagentParentMap for tab-based visibility
    this.subagentParentMap.set(windowId, paneData.sessionId);

    if (shouldHide) {
      win.style.display = 'none';
    }

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.subagentWindowZIndex;
    });

    // Resize observer for connection lines
    const resizeObserver = new ResizeObserver(() => {
      this.updateConnectionLines();
    });
    resizeObserver.observe(win);
    this.subagentWindows.get(windowId).resizeObserver = resizeObserver;

    // Init the xterm.js terminal
    this.initTeammateTerminal(windowId, paneData, win);

    // Animate in
    requestAnimationFrame(() => {
      win.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      win.style.transform = 'scale(1)';
      win.style.opacity = '1';
    });
  }

  /** Rebuild the teammate lookup map from all team configs */
  rebuildTeammateMap() {
    this.teammateMap.clear();
    for (const [teamName, team] of this.teams) {
      for (const member of team.members) {
        if (member.agentType !== 'team-lead') {
          // Use name as key prefix for matching subagent descriptions
          this.teammateMap.set(member.name, {
            name: member.name,
            color: member.color || 'blue',
            teamName,
            agentId: member.agentId,
          });
        }
      }
    }
  }

  /** Check if a subagent is a teammate and return its info */
  getTeammateInfo(agent) {
    if (!agent?.description) return null;
    // Teammate descriptions start with <teammate-message teammate_id=
    const match = agent.description.match(/<teammate-message\s+teammate_id="?([^">\s]+)/);
    if (!match) return null;
    const teammateId = match[1];
    // Extract name from teammate_id (format: name@teamName)
    const name = teammateId.split('@')[0];
    return this.teammateMap.get(name) || { name, color: 'blue', teamName: 'unknown' };
  }

  /** Get teammate badge HTML for a subagent */
  getTeammateBadgeHtml(agent) {
    const info = this.getTeammateInfo(agent);
    if (!info) return '';
    return `<span class="teammate-badge teammate-color-${info.color}" title="Team: ${escapeHtml(info.teamName)}">@${escapeHtml(info.name)}</span>`;
  }

  /** Render the team tasks panel */
  renderTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (!panel) return;

    // Find team for active session
    let activeTeam = null;
    let activeTeamName = null;
    if (this.activeSessionId) {
      for (const [name, team] of this.teams) {
        if (team.leadSessionId === this.activeSessionId) {
          activeTeam = team;
          activeTeamName = name;
          break;
        }
      }
    }

    if (!activeTeam) {
      panel.style.display = 'none';
      return;
    }

    // Set initial position and make draggable on first show
    const wasHidden = panel.style.display === 'none';
    panel.style.display = 'flex';

    if (wasHidden && !this.teamTasksDragListeners) {
      // Position bottom-right
      const panelWidth = 360;
      const panelHeight = 300;
      panel.style.left = `${Math.max(10, window.innerWidth - panelWidth - 20)}px`;
      panel.style.top = `${Math.max(10, window.innerHeight - panelHeight - 70)}px`;
      // Make draggable
      const header = panel.querySelector('.team-tasks-header');
      if (header) {
        this.teamTasksDragListeners = this.makeWindowDraggable(panel, header);
      }
    }

    const tasks = this.teamTasks.get(activeTeamName) || [];
    const completed = tasks.filter(t => t.status === 'completed').length;
    const total = tasks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const headerEl = panel.querySelector('.team-tasks-header-text');
    if (headerEl) {
      const teammateCount = activeTeam.members.filter(m => m.agentType !== 'team-lead').length;
      headerEl.textContent = `Team Tasks (${teammateCount} teammates)`;
    }

    const progressEl = panel.querySelector('.team-tasks-progress-fill');
    if (progressEl) {
      progressEl.style.width = `${pct}%`;
    }

    const progressText = panel.querySelector('.team-tasks-progress-text');
    if (progressText) {
      progressText.textContent = `${completed}/${total}`;
    }

    const listEl = panel.querySelector('.team-tasks-list');
    if (!listEl) return;

    if (tasks.length === 0) {
      listEl.innerHTML = '<div class="team-task-empty">No tasks yet</div>';
      return;
    }

    const html = tasks.map(task => {
      const statusIcon = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◉' : '○';
      const statusClass = task.status.replace('_', '-');
      const ownerBadge = task.owner
        ? `<span class="team-task-owner teammate-color-${this.getTeammateColor(task.owner)}">${escapeHtml(task.owner)}</span>`
        : '';
      return `<div class="team-task-item ${statusClass}">
        <span class="team-task-status">${statusIcon}</span>
        <span class="team-task-subject">${escapeHtml(task.subject)}</span>
        ${ownerBadge}
      </div>`;
    }).join('');

    listEl.innerHTML = html;
  }

  /** Hide team tasks panel and clean up drag listeners */
  hideTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (panel) panel.style.display = 'none';
    if (this.teamTasksDragListeners) {
      document.removeEventListener('mousemove', this.teamTasksDragListeners.move);
      document.removeEventListener('mouseup', this.teamTasksDragListeners.up);
      if (this.teamTasksDragListeners.touchMove) {
        document.removeEventListener('touchmove', this.teamTasksDragListeners.touchMove);
        document.removeEventListener('touchend', this.teamTasksDragListeners.up);
        document.removeEventListener('touchcancel', this.teamTasksDragListeners.up);
      }
      this.teamTasksDragListeners = null;
    }
  }

  /** Get teammate color by name */
  getTeammateColor(name) {
    const info = this.teammateMap.get(name);
    return info?.color || 'blue';
  }

  // ========== Project Insights Panel (Bash Tools with Clickable File Paths) ==========

  /**
   * Normalize a file path to its canonical form for comparison.
   * - Expands ~ to home directory approximation
   * - Resolves relative paths against working directory (case folder)
   * - Normalizes . and .. components
   */
  normalizeFilePath(path, workingDir) {
    if (!path) return '';

    let normalized = path.trim();
    const homeDir = '/home/' + (window.USER || 'user'); // Approximation

    // Expand ~ to home directory
    if (normalized.startsWith('~/')) {
      normalized = homeDir + normalized.slice(1);
    } else if (normalized === '~') {
      normalized = homeDir;
    }

    // If not absolute, resolve against working directory (case folder)
    if (!normalized.startsWith('/') && workingDir) {
      normalized = workingDir + '/' + normalized;
    }

    // Normalize path components (resolve . and ..)
    const parts = normalized.split('/');
    const stack = [];

    for (const part of parts) {
      if (part === '' || part === '.') {
        continue;
      } else if (part === '..') {
        if (stack.length > 1) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }

    return '/' + stack.join('/');
  }

  /**
   * Extract just the filename from a path.
   */
  getFilename(path) {
    const parts = path.split('/');
    return parts[parts.length - 1] || '';
  }

  /**
   * Check if a path is a "shallow root path" - an absolute path with only one
   * component after root (e.g., /test.txt, /file.log).
   * These are often typos where the user meant a relative path in the case folder.
   */
  isShallowRootPath(path) {
    if (!path.startsWith('/')) return false;
    const parts = path.split('/').filter(p => p !== '');
    return parts.length === 1;
  }

  /**
   * Check if a path is inside (or is) the working directory (case folder).
   */
  isPathInWorkingDir(path, workingDir) {
    if (!workingDir) return false;
    const normalized = this.normalizeFilePath(path, workingDir);
    return normalized.startsWith(workingDir + '/') || normalized === workingDir;
  }

  /**
   * Smart path equivalence check.
   * Two paths are considered equivalent if:
   * 1. They normalize to the same path (standard case)
   * 2. One is a "shallow root path" (e.g., /test.txt) and the other is the
   *    same filename inside the case folder - the shallow root path
   *    is likely a typo and they probably meant the same file.
   */
  pathsAreEquivalent(path1, path2, workingDir) {
    const norm1 = this.normalizeFilePath(path1, workingDir);
    const norm2 = this.normalizeFilePath(path2, workingDir);

    // Standard check: exact normalized match
    if (norm1 === norm2) return true;

    // Smart check: shallow root path vs case folder path with same filename
    const file1 = this.getFilename(norm1);
    const file2 = this.getFilename(norm2);

    if (file1 !== file2) return false; // Different filenames, can't be equivalent

    const shallow1 = this.isShallowRootPath(path1);
    const shallow2 = this.isShallowRootPath(path2);
    const inWorkDir1 = this.isPathInWorkingDir(norm1, workingDir);
    const inWorkDir2 = this.isPathInWorkingDir(norm2, workingDir);

    // If one is shallow root (e.g., /test.txt) and other is in case folder
    // with same filename, treat as equivalent (user likely made a typo)
    if (shallow1 && inWorkDir2) return true;
    if (shallow2 && inWorkDir1) return true;

    return false;
  }

  /**
   * Pick the "better" of two paths that resolve to the same file.
   * Prefers paths inside the case folder, longer/more explicit paths, and absolute paths.
   */
  pickBetterPath(path1, path2, workingDir) {
    // Prefer paths inside the case folder (working directory)
    if (workingDir) {
      const inWorkDir1 = this.isPathInWorkingDir(path1, workingDir);
      const inWorkDir2 = this.isPathInWorkingDir(path2, workingDir);
      if (inWorkDir1 && !inWorkDir2) return path1;
      if (inWorkDir2 && !inWorkDir1) return path2;
    }

    // Prefer absolute paths
    const abs1 = path1.startsWith('/');
    const abs2 = path2.startsWith('/');
    if (abs1 && !abs2) return path1;
    if (abs2 && !abs1) return path2;

    // Both absolute or both relative - prefer longer (more explicit)
    if (path1.length !== path2.length) {
      return path1.length > path2.length ? path1 : path2;
    }

    // Prefer paths without ~
    if (!path1.includes('~') && path2.includes('~')) return path1;
    if (!path2.includes('~') && path1.includes('~')) return path2;

    return path1;
  }

  /**
   * Deduplicate file paths across all tools, keeping the "best" version.
   * Uses smart equivalence checking:
   * - Standard normalization for relative vs absolute paths
   * - Detects likely typos (e.g., /file.txt when caseFolder/file.txt exists)
   * - Prefers paths inside the case folder (working directory)
   * - Prefers longer, more explicit paths
   * Returns a Map of normalized path -> best raw path.
   */
  deduplicateProjectInsightPaths(tools, workingDir) {
    // Collect all paths with their tool IDs
    const allPaths = [];
    for (const tool of tools) {
      for (const rawPath of tool.filePaths) {
        allPaths.push({ rawPath, toolId: tool.id });
      }
    }

    if (allPaths.length <= 1) {
      const pathMap = new Map();
      for (const p of allPaths) {
        pathMap.set(this.normalizeFilePath(p.rawPath, workingDir), p);
      }
      return pathMap;
    }

    // Sort paths: prefer paths in case folder first, then by length (longer first)
    allPaths.sort((a, b) => {
      const aInWorkDir = this.isPathInWorkingDir(a.rawPath, workingDir);
      const bInWorkDir = this.isPathInWorkingDir(b.rawPath, workingDir);
      if (aInWorkDir && !bInWorkDir) return -1;
      if (bInWorkDir && !aInWorkDir) return 1;
      return b.rawPath.length - a.rawPath.length; // Longer paths first
    });

    const result = new Map(); // normalized -> { rawPath, toolId }
    const seenNormalized = new Set();

    for (const { rawPath, toolId } of allPaths) {
      const normalized = this.normalizeFilePath(rawPath, workingDir);

      // Check if we've already seen an equivalent path
      let isDuplicate = false;
      for (const [, existing] of result) {
        if (this.pathsAreEquivalent(rawPath, existing.rawPath, workingDir)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate && !seenNormalized.has(normalized)) {
        result.set(normalized, { rawPath, toolId });
        seenNormalized.add(normalized);
      }
    }

    return result;
  }

  handleBashToolStart(sessionId, tool) {
    let tools = this.projectInsights.get(sessionId) || [];
    // Add new tool
    tools = tools.filter(t => t.id !== tool.id);
    tools.push(tool);
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  }

  handleBashToolEnd(sessionId, tool) {
    const tools = this.projectInsights.get(sessionId) || [];
    const existing = tools.find(t => t.id === tool.id);
    if (existing) {
      existing.status = 'completed';
    }
    this.renderProjectInsightsPanel();
    // Remove after a short delay
    setTimeout(() => {
      const current = this.projectInsights.get(sessionId) || [];
      this.projectInsights.set(sessionId, current.filter(t => t.id !== tool.id));
      this.renderProjectInsightsPanel();
    }, 2000);
  }

  handleBashToolsUpdate(sessionId, tools) {
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  }

  renderProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    const list = this.$('projectInsightsList');
    if (!panel || !list) return;

    // Check if panel is enabled in settings
    const settings = this.loadAppSettingsFromStorage();
    const showProjectInsights = settings.showProjectInsights ?? false;
    if (!showProjectInsights) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    // Get tools for active session only
    const tools = this.projectInsights.get(this.activeSessionId) || [];
    const runningTools = tools.filter(t => t.status === 'running');

    if (runningTools.length === 0) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    panel.classList.add('visible');
    this.projectInsightsPanelVisible = true;

    // Get working directory for path normalization
    const session = this.sessions.get(this.activeSessionId);
    const workingDir = session?.workingDir || this.currentSessionWorkingDir;

    // Smart deduplication: collect all unique paths across all tools
    // Paths that resolve to the same file are deduplicated, keeping the most complete version
    const deduplicatedPaths = this.deduplicateProjectInsightPaths(runningTools, workingDir);

    // Build a set of paths to show (only the best version of each unique file)
    const pathsToShow = new Set(Array.from(deduplicatedPaths.values()).map(p => p.rawPath));

    const html = [];
    for (const tool of runningTools) {
      // Filter this tool's paths to only include those that weren't deduplicated away
      const filteredPaths = tool.filePaths.filter(p => pathsToShow.has(p));

      // Skip tools with no paths to show (all were duplicates of better paths elsewhere)
      if (filteredPaths.length === 0) continue;

      const cmdDisplay = tool.command.length > 50
        ? tool.command.substring(0, 50) + '...'
        : tool.command;

      html.push(`
        <div class="project-insight-item" data-tool-id="${tool.id}">
          <div class="project-insight-command">
            <span class="icon">💻</span>
            <span class="cmd" title="${escapeHtml(tool.command)}">${escapeHtml(cmdDisplay)}</span>
            <span class="project-insight-status ${tool.status}">${tool.status}</span>
            ${tool.timeout ? `<span class="project-insight-timeout">${escapeHtml(tool.timeout)}</span>` : ''}
          </div>
          <div class="project-insight-paths">
      `);

      for (const path of filteredPaths) {
        const fileName = path.split('/').pop();
        html.push(`
            <span class="project-insight-filepath"
                  onclick="app.openLogViewerWindow('${escapeHtml(path)}', '${escapeHtml(tool.sessionId)}')"
                  title="${escapeHtml(path)}">${escapeHtml(fileName)}</span>
        `);
      }

      html.push(`
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  }

  closeProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    if (panel) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
    }
  }

  // ========== File Browser Panel ==========

  // File tree data and state
  fileBrowserData = null;
  fileBrowserExpandedDirs = new Set();
  fileBrowserFilter = '';
  fileBrowserAllExpanded = false;
  filePreviewContent = '';

  async loadFileBrowser(sessionId) {
    if (!sessionId) return;

    const treeEl = this.$('fileBrowserTree');
    const statusEl = this.$('fileBrowserStatus');
    if (!treeEl) return;

    // Show loading state
    treeEl.innerHTML = '<div class="file-browser-loading">Loading files...</div>';

    try {
      const res = await fetch(`/api/sessions/${sessionId}/files?depth=5&showHidden=false`);
      if (!res.ok) throw new Error('Failed to load files');

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load files');

      this.fileBrowserData = result.data;
      this.renderFileBrowserTree();

      // Update status
      if (statusEl) {
        const { totalFiles, totalDirectories, truncated } = result.data;
        statusEl.textContent = `${totalFiles} files, ${totalDirectories} dirs${truncated ? ' (truncated)' : ''}`;
      }
    } catch (err) {
      console.error('Failed to load file browser:', err);
      treeEl.innerHTML = `<div class="file-browser-empty">Failed to load files: ${escapeHtml(err.message)}</div>`;
    }
  }

  renderFileBrowserTree() {
    const treeEl = this.$('fileBrowserTree');
    if (!treeEl || !this.fileBrowserData) return;

    const { tree } = this.fileBrowserData;
    if (!tree || tree.length === 0) {
      treeEl.innerHTML = '<div class="file-browser-empty">No files found</div>';
      return;
    }

    const html = [];
    const filter = this.fileBrowserFilter.toLowerCase();

    const renderNode = (node, depth) => {
      const isDir = node.type === 'directory';
      const isExpanded = this.fileBrowserExpandedDirs.has(node.path);
      const matchesFilter = !filter || node.name.toLowerCase().includes(filter);

      // For directories, check if any children match
      let hasMatchingChildren = false;
      if (isDir && filter && node.children) {
        hasMatchingChildren = this.hasMatchingChild(node, filter);
      }

      const shouldShow = matchesFilter || hasMatchingChildren;
      const hiddenClass = !shouldShow && filter ? ' hidden-by-filter' : '';

      const icon = isDir
        ? (isExpanded ? '\uD83D\uDCC2' : '\uD83D\uDCC1')
        : this.getFileIcon(node.extension);

      const expandIcon = isDir
        ? `<span class="file-tree-expand${isExpanded ? ' expanded' : ''}">\u25B6</span>`
        : '<span class="file-tree-expand"></span>';

      const sizeStr = !isDir && node.size !== undefined
        ? `<span class="file-tree-size">${this.formatFileSize(node.size)}</span>`
        : '';

      const nameClass = isDir ? 'file-tree-name directory' : 'file-tree-name';

      html.push(`
        <div class="file-tree-item${hiddenClass}" data-path="${escapeHtml(node.path)}" data-type="${node.type}" data-depth="${depth}">
          ${expandIcon}
          <span class="file-tree-icon">${icon}</span>
          <span class="${nameClass}">${escapeHtml(node.name)}</span>
          ${sizeStr}
        </div>
      `);

      // Render children if directory is expanded
      if (isDir && isExpanded && node.children) {
        for (const child of node.children) {
          renderNode(child, depth + 1);
        }
      }
    };

    for (const node of tree) {
      renderNode(node, 0);
    }

    treeEl.innerHTML = html.join('');

    // Add click handlers
    treeEl.querySelectorAll('.file-tree-item').forEach(item => {
      item.addEventListener('click', () => {
        const path = item.dataset.path;
        const type = item.dataset.type;

        if (type === 'directory') {
          this.toggleFileBrowserFolder(path);
        } else {
          this.openFilePreview(path);
        }
      });
    });
  }

  hasMatchingChild(node, filter) {
    if (!node.children) return false;
    for (const child of node.children) {
      if (child.name.toLowerCase().includes(filter)) return true;
      if (child.type === 'directory' && this.hasMatchingChild(child, filter)) return true;
    }
    return false;
  }

  toggleFileBrowserFolder(path) {
    if (this.fileBrowserExpandedDirs.has(path)) {
      this.fileBrowserExpandedDirs.delete(path);
    } else {
      this.fileBrowserExpandedDirs.add(path);
    }
    this.renderFileBrowserTree();
  }

  filterFileBrowser(value) {
    this.fileBrowserFilter = value;
    // Auto-expand all if filtering
    if (value) {
      this.expandAllDirectories(this.fileBrowserData?.tree || []);
    }
    this.renderFileBrowserTree();
  }

  expandAllDirectories(nodes) {
    for (const node of nodes) {
      if (node.type === 'directory') {
        this.fileBrowserExpandedDirs.add(node.path);
        if (node.children) {
          this.expandAllDirectories(node.children);
        }
      }
    }
  }

  collapseAllDirectories() {
    this.fileBrowserExpandedDirs.clear();
  }

  toggleFileBrowserExpand() {
    this.fileBrowserAllExpanded = !this.fileBrowserAllExpanded;
    const btn = this.$('fileBrowserExpandBtn');

    if (this.fileBrowserAllExpanded) {
      this.expandAllDirectories(this.fileBrowserData?.tree || []);
      if (btn) btn.innerHTML = '\u229F'; // Collapse icon
    } else {
      this.collapseAllDirectories();
      if (btn) btn.innerHTML = '\u229E'; // Expand icon
    }
    this.renderFileBrowserTree();
  }

  refreshFileBrowser() {
    if (this.activeSessionId) {
      this.fileBrowserExpandedDirs.clear();
      this.fileBrowserFilter = '';
      this.fileBrowserAllExpanded = false;
      const searchInput = this.$('fileBrowserSearch');
      if (searchInput) searchInput.value = '';
      this.loadFileBrowser(this.activeSessionId);
    }
  }

  closeFileBrowserPanel() {
    const panel = this.$('fileBrowserPanel');
    if (panel) {
      panel.classList.remove('visible');
    }
    // Save setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showFileBrowser = false;
    this.saveAppSettingsToStorage(settings);
  }

  async openFilePreview(filePath) {
    if (!this.activeSessionId || !filePath) return;

    const overlay = this.$('filePreviewOverlay');
    const titleEl = this.$('filePreviewTitle');
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');

    if (!overlay || !bodyEl) return;

    // Show overlay with loading state
    overlay.classList.add('visible');
    titleEl.textContent = filePath;
    bodyEl.innerHTML = '<div class="binary-message">Loading...</div>';
    footerEl.textContent = '';

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/file-content?path=${encodeURIComponent(filePath)}&lines=500`);
      if (!res.ok) throw new Error('Failed to load file');

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load file');

      const data = result.data;

      if (data.type === 'image') {
        bodyEl.innerHTML = `<img src="${data.url}" alt="${escapeHtml(filePath)}">`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'video') {
        bodyEl.innerHTML = `<video src="${data.url}" controls autoplay></video>`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'binary') {
        bodyEl.innerHTML = `<div class="binary-message">Binary file (${this.formatFileSize(data.size)})<br>Cannot preview</div>`;
        footerEl.textContent = data.extension || 'binary';
      } else {
        // Text content
        this.filePreviewContent = data.content;
        bodyEl.innerHTML = `<pre><code>${escapeHtml(data.content)}</code></pre>`;
        const truncNote = data.truncated ? ` (showing 500/${data.totalLines} lines)` : '';
        footerEl.textContent = `${data.totalLines} lines \u2022 ${this.formatFileSize(data.size)}${truncNote}`;
      }
    } catch (err) {
      console.error('Failed to preview file:', err);
      bodyEl.innerHTML = `<div class="binary-message">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  closeFilePreview() {
    const overlay = this.$('filePreviewOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
    this.filePreviewContent = '';
  }

  copyFilePreviewContent() {
    if (this.filePreviewContent) {
      navigator.clipboard.writeText(this.filePreviewContent).then(() => {
        this.showToast('Copied to clipboard', 'success');
      }).catch(() => {
        this.showToast('Failed to copy', 'error');
      });
    }
  }

  getFileIcon(ext) {
    if (!ext) return '\uD83D\uDCC4'; // Default file

    const icons = {
      // TypeScript/JavaScript
      'ts': '\uD83D\uDCD8', 'tsx': '\uD83D\uDCD8', 'js': '\uD83D\uDCD2', 'jsx': '\uD83D\uDCD2',
      'mjs': '\uD83D\uDCD2', 'cjs': '\uD83D\uDCD2',
      // Python
      'py': '\uD83D\uDC0D', 'pyx': '\uD83D\uDC0D', 'pyw': '\uD83D\uDC0D',
      // Rust/Go/C
      'rs': '\uD83E\uDD80', 'go': '\uD83D\uDC39', 'c': '\u2699\uFE0F', 'cpp': '\u2699\uFE0F',
      'h': '\u2699\uFE0F', 'hpp': '\u2699\uFE0F',
      // Web
      'html': '\uD83C\uDF10', 'htm': '\uD83C\uDF10', 'css': '\uD83C\uDFA8', 'scss': '\uD83C\uDFA8',
      'sass': '\uD83C\uDFA8', 'less': '\uD83C\uDFA8',
      // Data
      'json': '\uD83D\uDCCB', 'yaml': '\uD83D\uDCCB', 'yml': '\uD83D\uDCCB', 'xml': '\uD83D\uDCCB',
      'toml': '\uD83D\uDCCB', 'csv': '\uD83D\uDCCB',
      // Docs
      'md': '\uD83D\uDCDD', 'markdown': '\uD83D\uDCDD', 'txt': '\uD83D\uDCDD', 'rst': '\uD83D\uDCDD',
      // Images
      'png': '\uD83D\uDDBC\uFE0F', 'jpg': '\uD83D\uDDBC\uFE0F', 'jpeg': '\uD83D\uDDBC\uFE0F',
      'gif': '\uD83D\uDDBC\uFE0F', 'svg': '\uD83D\uDDBC\uFE0F', 'webp': '\uD83D\uDDBC\uFE0F',
      'ico': '\uD83D\uDDBC\uFE0F', 'bmp': '\uD83D\uDDBC\uFE0F',
      // Video/Audio
      'mp4': '\uD83C\uDFAC', 'webm': '\uD83C\uDFAC', 'mov': '\uD83C\uDFAC',
      'mp3': '\uD83C\uDFB5', 'wav': '\uD83C\uDFB5', 'ogg': '\uD83C\uDFB5',
      // Config/Shell
      'sh': '\uD83D\uDCBB', 'bash': '\uD83D\uDCBB', 'zsh': '\uD83D\uDCBB',
      'env': '\uD83D\uDD10', 'gitignore': '\uD83D\uDEAB', 'dockerfile': '\uD83D\uDC33',
      // Lock files
      'lock': '\uD83D\uDD12',
    };

    return icons[ext.toLowerCase()] || '\uD83D\uDCC4';
  }

  formatFileSize(bytes) {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  // ========== Log Viewer Windows (Floating File Streamers) ==========

  openLogViewerWindow(filePath, sessionId) {
    sessionId = sessionId || this.activeSessionId;
    if (!sessionId) return;

    // Create unique window ID
    const windowId = `${sessionId}-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    // If window already exists, focus it
    if (this.logViewerWindows.has(windowId)) {
      const existing = this.logViewerWindows.get(windowId);
      existing.element.style.zIndex = ++this.logViewerWindowZIndex;
      return;
    }

    // Calculate position (cascade from top-left)
    const windowCount = this.logViewerWindows.size;
    const offsetX = 100 + (windowCount % 5) * 30;
    const offsetY = 100 + (windowCount % 5) * 30;

    // Get filename for title
    const fileName = filePath.split('/').pop();

    // Create window element
    const win = document.createElement('div');
    win.className = 'log-viewer-window';
    win.id = `log-viewer-window-${windowId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.logViewerWindowZIndex;

    win.innerHTML = `
      <div class="log-viewer-window-header">
        <div class="log-viewer-window-title" title="${escapeHtml(filePath)}">
          <span class="icon">📄</span>
          <span class="filename">${escapeHtml(fileName)}</span>
          <span class="status streaming">streaming</span>
        </div>
        <div class="log-viewer-window-actions">
          <button onclick="app.closeLogViewerWindow('${escapeHtml(windowId)}')" title="Close">×</button>
        </div>
      </div>
      <div class="log-viewer-window-body" id="log-viewer-body-${windowId}">
        <div class="log-info">Connecting to ${escapeHtml(filePath)}...</div>
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable (returns listener refs for cleanup)
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.log-viewer-window-header'));

    // Connect to SSE stream
    const eventSource = new EventSource(
      `/api/sessions/${sessionId}/tail-file?path=${encodeURIComponent(filePath)}&lines=50`
    );

    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const body = document.getElementById(`log-viewer-body-${windowId}`);
      if (!body) return;

      switch (data.type) {
        case 'connected':
          body.innerHTML = '';
          break;
        case 'data':
          // Append data, auto-scroll
          const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 10;
          const content = escapeHtml(data.content);
          body.innerHTML += content;
          if (wasAtBottom) {
            body.scrollTop = body.scrollHeight;
          }
          // Trim if too large
          if (body.innerHTML.length > 500000) {
            body.innerHTML = body.innerHTML.slice(-400000);
          }
          break;
        case 'end':
          this.updateLogViewerStatus(windowId, 'disconnected', 'ended');
          break;
        case 'error':
          body.innerHTML += `<div class="log-error">${escapeHtml(data.error)}</div>`;
          this.updateLogViewerStatus(windowId, 'error', 'error');
          break;
      }
    };

    eventSource.onerror = () => {
      this.updateLogViewerStatus(windowId, 'disconnected', 'connection error');
    };

    // Store reference (including drag listeners for cleanup)
    this.logViewerWindows.set(windowId, {
      element: win,
      eventSource,
      filePath,
      sessionId,
      dragListeners, // Store for cleanup to prevent memory leaks
    });
  }

  updateLogViewerStatus(windowId, statusClass, statusText) {
    const statusEl = document.querySelector(`#log-viewer-window-${windowId} .status`);
    if (statusEl) {
      statusEl.className = `status ${statusClass}`;
      statusEl.textContent = statusText;
    }
  }

  closeLogViewerWindow(windowId) {
    const windowData = this.logViewerWindows.get(windowId);
    if (!windowData) return;

    // Close SSE connection
    if (windowData.eventSource) {
      windowData.eventSource.close();
    }

    // Clean up global drag event listeners (prevents memory leak)
    if (windowData.dragListeners) {
      document.removeEventListener('mousemove', windowData.dragListeners.move);
      document.removeEventListener('mouseup', windowData.dragListeners.up);
    }

    // Remove element
    windowData.element.remove();

    // Remove from map
    this.logViewerWindows.delete(windowId);
  }

  // Close all log viewer windows for a session
  closeSessionLogViewerWindows(sessionId) {
    const toClose = [];
    for (const [windowId, data] of this.logViewerWindows) {
      if (data.sessionId === sessionId) {
        toClose.push(windowId);
      }
    }
    for (const windowId of toClose) {
      this.closeLogViewerWindow(windowId);
    }
  }

  // ========== Image Popup Windows (Auto-popup for Screenshots) ==========

  /**
   * Open a popup window to display a detected image.
   * Called automatically when image:detected SSE event is received.
   */
  openImagePopup(imageEvent) {
    const { sessionId, filePath, relativePath, fileName, timestamp, size } = imageEvent;

    // Create unique window ID
    const imageId = `${sessionId}-${timestamp}`;

    // If window already exists for this image, focus it
    if (this.imagePopups.has(imageId)) {
      const existing = this.imagePopups.get(imageId);
      existing.element.style.zIndex = ++this.imagePopupZIndex;
      return;
    }

    // Cap open popups at 20 — close oldest when at limit
    const MAX_IMAGE_POPUPS = 20;
    if (this.imagePopups.size >= MAX_IMAGE_POPUPS) {
      // Map iteration order is insertion order, so first key is oldest
      const oldestId = this.imagePopups.keys().next().value;
      if (oldestId) this.closeImagePopup(oldestId);
    }

    // Calculate position (cascade from center, with offset for multiple popups)
    const windowCount = this.imagePopups.size;
    const centerX = (window.innerWidth - 600) / 2;
    const centerY = (window.innerHeight - 500) / 2;
    const offsetX = centerX + (windowCount % 5) * 30;
    const offsetY = centerY + (windowCount % 5) * 30;

    // Get session name for display
    const session = this.sessions.get(sessionId);
    const sessionName = session?.name || sessionId.substring(0, 8);

    // Format file size
    const sizeKB = (size / 1024).toFixed(1);

    // Build image URL using the existing file-raw endpoint
    // Use relativePath (path from working dir) instead of fileName (basename) for subdirectory images
    const imageUrl = `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(relativePath || fileName)}`;

    // Create window element
    const win = document.createElement('div');
    win.className = 'image-popup-window';
    win.id = `image-popup-${imageId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.imagePopupZIndex;

    win.innerHTML = `
      <div class="image-popup-header">
        <div class="image-popup-title" title="${escapeHtml(filePath)}">
          <span class="icon">🖼️</span>
          <span class="filename">${escapeHtml(fileName)}</span>
          <span class="session-badge">${escapeHtml(sessionName)}</span>
          <span class="size-badge">${sizeKB} KB</span>
        </div>
        <div class="image-popup-actions">
          <button onclick="app.openImageInNewTab('${escapeHtml(imageUrl)}')" title="Open in new tab">↗</button>
          <button onclick="app.closeImagePopup('${escapeHtml(imageId)}')" title="Close">×</button>
        </div>
      </div>
      <div class="image-popup-body">
        <img src="${imageUrl}" alt="${escapeHtml(fileName)}"
             onerror="this.parentElement.innerHTML='<div class=\\'image-error\\'>Failed to load image</div>'"
             onclick="app.openImageInNewTab('${escapeHtml(imageUrl)}')" />
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.image-popup-header'));

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.imagePopupZIndex;
    });

    // Store reference
    this.imagePopups.set(imageId, {
      element: win,
      sessionId,
      filePath,
      dragListeners,
    });
  }

  /**
   * Close an image popup window.
   */
  closeImagePopup(imageId) {
    const popupData = this.imagePopups.get(imageId);
    if (!popupData) return;

    // Clean up global drag event listeners
    if (popupData.dragListeners) {
      document.removeEventListener('mousemove', popupData.dragListeners.move);
      document.removeEventListener('mouseup', popupData.dragListeners.up);
      if (popupData.dragListeners.touchMove) {
        document.removeEventListener('touchmove', popupData.dragListeners.touchMove);
        document.removeEventListener('touchend', popupData.dragListeners.up);
        document.removeEventListener('touchcancel', popupData.dragListeners.up);
      }
    }

    // Remove element
    popupData.element.remove();

    // Remove from map
    this.imagePopups.delete(imageId);
  }

  /**
   * Open image in a new browser tab.
   */
  openImageInNewTab(url) {
    window.open(url, '_blank');
  }

  /**
   * Close all image popups for a session.
   */
  closeSessionImagePopups(sessionId) {
    const toClose = [];
    for (const [imageId, data] of this.imagePopups) {
      if (data.sessionId === sessionId) {
        toClose.push(imageId);
      }
    }
    for (const imageId of toClose) {
      this.closeImagePopup(imageId);
    }
  }

  // ========== Mux Sessions (in Monitor Panel) ==========

  async loadMuxSessions() {
    try {
      const res = await fetch('/api/mux-sessions');
      const data = await res.json();
      this.muxSessions = data.sessions || [];
      this.renderMuxSessions();
    } catch (err) {
      console.error('Failed to load mux sessions:', err);
    }
  }

  killAllSessions() {
    const count = this.muxSessions?.length || 0;
    if (count === 0) {
      alert('No sessions to kill');
      return;
    }

    // Show the kill all modal
    document.getElementById('killAllCount').textContent = count;
    const modal = document.getElementById('killAllModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  closeKillAllModal() {
    document.getElementById('killAllModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  async confirmKillAll(killMux) {
    this.closeKillAllModal();

    try {
      if (killMux) {
        // Kill everything including tmux sessions
        const res = await fetch('/api/sessions', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          this.sessions.clear();
          this.muxSessions = [];
          this.activeSessionId = null;
          try { localStorage.removeItem('codeman-active-session'); } catch {}
          this.renderSessionTabs();
          this.renderMuxSessions();
          this.terminal.clear();
          this.terminal.reset();
          this.toast('All sessions and tmux killed', 'success');
        }
      } else {
        // Just remove tabs, keep mux sessions running
        this.sessions.clear();
        this.activeSessionId = null;
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        this.renderSessionTabs();
        this.terminal.clear();
        this.terminal.reset();
        this.toast('All tabs removed, tmux still running', 'info');
      }
    } catch (err) {
      console.error('Failed to kill sessions:', err);
      this.toast('Failed to kill sessions: ' + err.message, 'error');
    }
  }

  // ========== Case Settings ==========

  toggleCaseSettings() {
    const popover = document.getElementById('caseSettingsPopover');
    if (popover.classList.contains('hidden')) {
      // Load settings for current case
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeams').checked = settings.agentTeams;
      popover.classList.remove('hidden');

      // Close on outside click (one-shot listener)
      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      // Defer to avoid catching the current click
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  }

  getCaseSettings(caseName) {
    try {
      const stored = localStorage.getItem('caseSettings_' + caseName);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return { agentTeams: false };
  }

  saveCaseSettings(caseName, settings) {
    localStorage.setItem('caseSettings_' + caseName, JSON.stringify(settings));
  }

  onCaseSettingChanged() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeams').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync mobile checkbox
    const mobileCheckbox = document.getElementById('caseAgentTeamsMobile');
    if (mobileCheckbox) mobileCheckbox.checked = settings.agentTeams;
  }

  toggleCaseSettingsMobile() {
    const popover = document.getElementById('caseSettingsPopoverMobile');
    if (popover.classList.contains('hidden')) {
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeamsMobile').checked = settings.agentTeams;
      popover.classList.remove('hidden');

      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings-mobile')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  }

  onCaseSettingChangedMobile() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeamsMobile').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync desktop checkbox
    const desktopCheckbox = document.getElementById('caseAgentTeams');
    if (desktopCheckbox) desktopCheckbox.checked = settings.agentTeams;
  }

  // ========== Create Case Modal ==========

  showCreateCaseModal() {
    document.getElementById('newCaseName').value = '';
    document.getElementById('newCaseDescription').value = '';
    document.getElementById('linkCaseName').value = '';
    document.getElementById('linkCasePath').value = '';
    // Reset to first tab
    this.caseModalTab = 'case-create';
    this.switchCaseModalTab('case-create');
    // Wire up tab buttons
    const modal = document.getElementById('createCaseModal');
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.onclick = () => this.switchCaseModalTab(btn.dataset.tab);
    });
    // Scroll-into-view on focus for mobile keyboard visibility
    modal.querySelectorAll('input[type="text"]').forEach(input => {
      if (!input._mobileScrollWired) {
        input._mobileScrollWired = true;
        input.addEventListener('focus', () => {
          if (window.innerWidth <= 430) {
            setTimeout(() => input.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
          }
        });
      }
    });
    modal.classList.add('active');
    document.getElementById('newCaseName').focus();
  }

  switchCaseModalTab(tabName) {
    this.caseModalTab = tabName;
    const modal = document.getElementById('createCaseModal');
    // Toggle active class on tab buttons
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // Toggle hidden class on tab content
    modal.querySelectorAll('.modal-tab-content').forEach(content => {
      content.classList.toggle('hidden', content.id !== tabName);
    });
    // Update submit button text
    const submitBtn = document.getElementById('caseModalSubmit');
    submitBtn.textContent = tabName === 'case-create' ? 'Create' : 'Link';
    // Focus appropriate input
    if (tabName === 'case-create') {
      document.getElementById('newCaseName').focus();
    } else {
      document.getElementById('linkCaseName').focus();
    }
  }

  closeCreateCaseModal() {
    document.getElementById('createCaseModal').classList.remove('active');
  }

  async submitCaseModal() {
    const btn = document.getElementById('caseModalSubmit');
    const originalText = btn.textContent;
    btn.classList.add('loading');
    btn.textContent = this.caseModalTab === 'case-create' ? 'Creating...' : 'Linking...';
    try {
      if (this.caseModalTab === 'case-create') {
        await this.createCase();
      } else {
        await this.linkCase();
      }
    } finally {
      btn.classList.remove('loading');
      btn.textContent = originalText;
    }
  }

  async createCase() {
    const name = document.getElementById('newCaseName').value.trim();
    const description = document.getElementById('newCaseDescription').value.trim();

    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Case "${name}" created`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to create case', 'error');
      }
    } catch (err) {
      console.error('Failed to create case:', err);
      this.showToast('Failed to create case: ' + err.message, 'error');
    }
  }

  async linkCase() {
    const name = document.getElementById('linkCaseName').value.trim();
    const path = document.getElementById('linkCasePath').value.trim();

    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    if (!path) {
      this.showToast('Please enter a folder path', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Case "${name}" linked to ${path}`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to link case', 'error');
      }
    } catch (err) {
      console.error('Failed to link case:', err);
      this.showToast('Failed to link case: ' + err.message, 'error');
    }
  }

  // ============================================================================
  // Mobile Case Picker
  // ============================================================================

  showMobileCasePicker() {
    const modal = document.getElementById('mobileCasePickerModal');
    const listContainer = document.getElementById('mobileCaseList');
    const select = document.getElementById('quickStartCase');
    const currentCase = select.value;

    // Build case list HTML
    let html = '';
    const cases = this.cases || [];

    // Add testcase if not in list
    const hasTestcase = cases.some(c => c.name === 'testcase');
    const allCases = hasTestcase ? cases : [{ name: 'testcase' }, ...cases];

    for (const c of allCases) {
      const isSelected = c.name === currentCase;
      html += `
        <button class="mobile-case-item ${isSelected ? 'selected' : ''}"
                onclick="app.selectMobileCase('${escapeHtml(c.name)}')">
          <span class="mobile-case-item-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </span>
          <span class="mobile-case-item-name">${escapeHtml(c.name)}</span>
          <span class="mobile-case-item-check">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </span>
        </button>
      `;
    }

    listContainer.innerHTML = html;
    modal.classList.add('active');
  }

  closeMobileCasePicker() {
    document.getElementById('mobileCasePickerModal').classList.remove('active');
  }

  selectMobileCase(caseName) {
    // Update the desktop select (source of truth)
    const select = document.getElementById('quickStartCase');
    select.value = caseName;

    // Update mobile button label
    this.updateMobileCaseLabel(caseName);

    // Update directory display
    this.updateDirDisplayForCase(caseName);

    // Save as last used
    this.saveLastUsedCase(caseName);

    // Close the picker
    this.closeMobileCasePicker();

    this.showToast(`Selected: ${caseName}`, 'success');
  }

  updateMobileCaseLabel(caseName) {
    const label = document.getElementById('mobileCaseName');
    if (label) {
      // Let CSS handle truncation via text-overflow: ellipsis
      label.textContent = caseName;
    }
  }

  showCreateCaseFromMobile() {
    // Close mobile picker first
    this.closeMobileCasePicker();
    // Open the create case modal with slide-up animation
    this.showCreateCaseModal();
    const modal = document.getElementById('createCaseModal');
    modal.classList.add('from-mobile');
    // Remove animation class after it plays
    setTimeout(() => modal.classList.remove('from-mobile'), 300);
  }

  renderMuxSessions() {
    // Debounce renders at 100ms to prevent excessive DOM updates
    if (this.renderMuxSessionsTimeout) {
      clearTimeout(this.renderMuxSessionsTimeout);
    }
    this.renderMuxSessionsTimeout = setTimeout(() => {
      this._renderMuxSessionsImmediate();
    }, 100);
  }

  _renderMuxSessionsImmediate() {
    const body = document.getElementById('muxSessionsBody');

    if (!this.muxSessions || this.muxSessions.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No mux sessions</div>';
      return;
    }

    let html = '';
    for (const muxSession of this.muxSessions) {
      const stats = muxSession.stats || { memoryMB: 0, cpuPercent: 0, childCount: 0 };

      // Look up rich session data by sessionId
      const session = this.sessions.get(muxSession.sessionId);
      const status = session ? session.status : 'unknown';
      const isWorking = session ? session.isWorking : false;

      // Status badge
      let statusLabel, statusClass;
      if (status === 'idle' && !isWorking) {
        statusLabel = 'IDLE';
        statusClass = 'status-idle';
      } else if (status === 'busy' || isWorking) {
        statusLabel = 'WORKING';
        statusClass = 'status-working';
      } else if (status === 'stopped') {
        statusLabel = 'STOPPED';
        statusClass = 'status-stopped';
      } else {
        statusLabel = status.toUpperCase();
        statusClass = '';
      }

      // Token and cost info
      const tokens = session && session.tokens ? session.tokens : null;
      const totalCost = session ? session.totalCost : 0;
      const model = session ? (session.cliModel || '') : '';
      const modelShort = model.includes('opus') ? 'opus' : model.includes('sonnet') ? 'sonnet' : model.includes('haiku') ? 'haiku' : '';

      // Ralph/Todo progress
      const todoStats = session ? session.ralphTodoStats : null;
      let todoHtml = '';
      if (todoStats && todoStats.total > 0) {
        const pct = Math.round((todoStats.completed / todoStats.total) * 100);
        todoHtml = `<span class="process-stat todo-progress">${todoStats.completed}/${todoStats.total} (${pct}%)</span>`;
      }

      // Format tokens
      let tokenHtml = '';
      if (tokens && tokens.total > 0) {
        const totalK = (tokens.total / 1000).toFixed(1);
        tokenHtml = `<span class="process-stat tokens">${totalK}k tok</span>`;
      }

      // Format cost
      let costHtml = '';
      if (totalCost > 0) {
        costHtml = `<span class="process-stat cost">$${totalCost.toFixed(2)}</span>`;
      }

      // Model badge
      let modelHtml = '';
      if (modelShort) {
        modelHtml = `<span class="monitor-model-badge ${modelShort}">${modelShort}</span>`;
      }

      html += `
        <div class="process-item">
          <span class="monitor-status-badge ${statusClass}">${statusLabel}</span>
          <div class="process-info">
            <div class="process-name">${modelHtml} ${escapeHtml(muxSession.name || muxSession.muxName)}</div>
            <div class="process-meta">
              ${tokenHtml}
              ${costHtml}
              ${todoHtml}
              <span class="process-stat memory">${stats.memoryMB}MB</span>
              <span class="process-stat cpu">${stats.cpuPercent}%</span>
            </div>
          </div>
          <div class="process-actions">
            <button class="btn-toolbar btn-sm btn-danger" onclick="app.killMuxSession('${escapeHtml(muxSession.sessionId)}')" title="Kill session">Kill</button>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  renderMonitorSubagents() {
    const body = document.getElementById('monitorSubagentsBody');
    const stats = document.getElementById('monitorSubagentStats');
    if (!body) return;

    const subagents = Array.from(this.subagents.values());
    const activeCount = subagents.filter(s => s.status === 'active' || s.status === 'idle').length;

    if (stats) {
      stats.textContent = `${subagents.length} tracked` + (activeCount > 0 ? `, ${activeCount} active` : '');
    }

    if (subagents.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No background agents</div>';
      return;
    }

    let html = '';
    for (const agent of subagents) {
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const modelBadge = agent.modelShort ? `<span class="model-badge ${agent.modelShort}">${agent.modelShort}</span>` : '';
      const desc = agent.description ? escapeHtml(agent.description.substring(0, 40)) : agent.agentId;

      html += `
        <div class="process-item">
          <span class="process-mode ${statusClass}">${agent.status}</span>
          <div class="process-info">
            <div class="process-name">${modelBadge} ${desc}</div>
            <div class="process-meta">
              <span>ID: ${agent.agentId}</span>
              <span>${agent.toolCallCount || 0} tools</span>
            </div>
          </div>
          <div class="process-actions">
            ${agent.status !== 'completed' ? `<button class="btn-toolbar btn-sm btn-danger" onclick="app.killSubagent('${escapeHtml(agent.agentId)}')" title="Kill agent">Kill</button>` : ''}
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  async killMuxSession(sessionId) {
    if (!confirm('Kill this mux session?')) return;

    try {
      // Use closeSession to properly clean up both the session tab and tmux process
      // (closeSession handles its own toast messaging)
      await this.closeSession(sessionId, true);
    } catch (err) {
      // Fallback: kill mux directly if session cleanup fails
      try { await fetch(`/api/mux-sessions/${sessionId}`, { method: 'DELETE' }); } catch (_ignored) {}
      this.showToast('Tmux session killed', 'success');
    }
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== sessionId);
    this.renderMuxSessions();
  }

  async reconcileMuxSessions() {
    try {
      const res = await fetch('/api/mux-sessions/reconcile', { method: 'POST' });
      const data = await res.json();

      if (data.dead && data.dead.length > 0) {
        this.showToast(`Found ${data.dead.length} dead mux session(s)`, 'warning');
        await this.loadMuxSessions();
      } else {
        this.showToast('All mux sessions are alive', 'success');
      }
    } catch (err) {
      this.showToast('Failed to reconcile mux sessions', 'error');
    }
  }

  // ========== Plan Wizard Agents in Monitor ==========

  renderMonitorPlanAgents() {
    const section = document.getElementById('monitorPlanAgentsSection');
    const body = document.getElementById('monitorPlanAgentsBody');
    const stats = document.getElementById('monitorPlanAgentStats');
    if (!section || !body) return;

    const planAgents = Array.from(this.planSubagents?.values() || []);
    const hasActiveOrchestrator = !!this.activePlanOrchestratorId;

    // Show section only if there are plan agents or active orchestrator
    if (planAgents.length === 0 && !hasActiveOrchestrator) {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';

    const activeCount = planAgents.filter(a => a.status === 'running').length;
    const completedCount = planAgents.filter(a => a.status === 'completed' || a.status === 'failed').length;

    if (stats) {
      if (hasActiveOrchestrator) {
        stats.textContent = `${activeCount} running, ${completedCount} done`;
      } else {
        stats.textContent = `${planAgents.length} total`;
      }
    }

    if (planAgents.length === 0) {
      body.innerHTML = `<div class="monitor-empty">${hasActiveOrchestrator ? 'Plan generation starting...' : 'No plan agents'}</div>`;
      return;
    }

    let html = '';
    for (const agent of planAgents) {
      const statusClass = agent.status === 'running' ? 'active' : agent.status === 'completed' ? 'completed' : 'error';
      const agentLabel = agent.agentType || agent.agentId;
      const modelBadge = agent.model ? `<span class="model-badge opus">opus</span>` : '';
      const detail = agent.detail ? escapeHtml(agent.detail.substring(0, 50)) : '';
      const duration = agent.durationMs ? `${(agent.durationMs / 1000).toFixed(1)}s` : '';
      const itemCount = agent.itemCount ? `${agent.itemCount} items` : '';

      html += `
        <div class="process-item">
          <span class="process-mode ${statusClass}">${agent.status || 'pending'}</span>
          <div class="process-info">
            <div class="process-name">${modelBadge} ${escapeHtml(agentLabel)}</div>
            <div class="process-meta">
              ${detail ? `<span>${detail}</span>` : ''}
              ${itemCount ? `<span>${itemCount}</span>` : ''}
              ${duration ? `<span>${duration}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  async cancelPlanFromMonitor() {
    if (!this.activePlanOrchestratorId && this.planSubagents?.size === 0) {
      this.showToast('No active plan generation', 'info');
      return;
    }

    if (!confirm('Cancel plan generation and close all plan agent windows?')) return;

    // Cancel the plan generation (reuse existing method)
    await this.cancelPlanGeneration();

    // Also force close the wizard if it's open
    const wizardModal = document.getElementById('ralphWizardModal');
    if (wizardModal?.classList.contains('active')) {
      this.closeRalphWizard();
    }

    // Update monitor display
    this.renderMonitorPlanAgents();
    this.showToast('Plan generation cancelled', 'success');
  }

  // ========== Toast ==========

  // Cached toast container for performance
  _toastContainer = null;

  toggleNotifications() {
    this.notificationManager?.toggleDrawer();
  }

  // Alias for showToast
  toast(message, type = 'info') {
    return this.showToast(message, type);
  }

  showToast(message, type = 'info', opts = {}) {
    const { duration = 3000, action } = opts;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.style.cssText = 'margin-left:12px;padding:2px 10px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:3px;color:inherit;cursor:pointer;font-size:12px';
      btn.onclick = (e) => { e.stopPropagation(); action.onClick(); toast.remove(); };
      toast.appendChild(btn);
    }

    // Cache toast container reference
    if (!this._toastContainer) {
      this._toastContainer = document.querySelector('.toast-container');
      if (!this._toastContainer) {
        this._toastContainer = document.createElement('div');
        this._toastContainer.className = 'toast-container';
        document.body.appendChild(this._toastContainer);
      }
    }
    this._toastContainer.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }

  // ========== System Stats ==========

  startSystemStatsPolling() {
    // Clear any existing interval to prevent duplicates
    this.stopSystemStatsPolling();

    // Initial fetch
    this.fetchSystemStats();

    // Poll every 2 seconds
    this.systemStatsInterval = setInterval(() => {
      this.fetchSystemStats();
    }, 2000);
  }

  stopSystemStatsPolling() {
    if (this.systemStatsInterval) {
      clearInterval(this.systemStatsInterval);
      this.systemStatsInterval = null;
    }
  }

  async fetchSystemStats() {
    // Skip polling when system stats display is hidden
    const statsEl = document.getElementById('headerSystemStats');
    if (!statsEl || statsEl.style.display === 'none') return;

    try {
      const res = await fetch('/api/system/stats');
      const stats = await res.json();
      this.updateSystemStatsDisplay(stats);
    } catch (err) {
      // Silently fail - system stats are not critical
    }
  }

  updateSystemStatsDisplay(stats) {
    const cpuEl = this.$('statCpu');
    const cpuBar = this.$('statCpuBar');
    const memEl = this.$('statMem');
    const memBar = this.$('statMemBar');

    if (cpuEl && cpuBar) {
      cpuEl.textContent = `${stats.cpu}%`;
      cpuBar.style.width = `${Math.min(100, stats.cpu)}%`;

      // Color classes based on usage
      cpuBar.classList.remove('medium', 'high');
      cpuEl.classList.remove('high');
      if (stats.cpu > 80) {
        cpuBar.classList.add('high');
        cpuEl.classList.add('high');
      } else if (stats.cpu > 50) {
        cpuBar.classList.add('medium');
      }
    }

    if (memEl && memBar) {
      const memGB = (stats.memory.usedMB / 1024).toFixed(1);
      memEl.textContent = `${memGB}G`;
      memBar.style.width = `${Math.min(100, stats.memory.percent)}%`;

      // Color classes based on usage
      memBar.classList.remove('medium', 'high');
      memEl.classList.remove('high');
      if (stats.memory.percent > 80) {
        memBar.classList.add('high');
        memEl.classList.add('high');
      } else if (stats.memory.percent > 50) {
        memBar.classList.add('medium');
      }
    }
  }

}

// Migrate legacy localStorage keys (claudeman-* → codeman-*)
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('claudeman-') || key.startsWith('claudeman_'))) {
      const newKey = key.replace(/^claudeman[-_]/, (m) => 'codeman' + m.charAt(m.length - 1));
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, localStorage.getItem(key));
      }
    }
  }
} catch {}

// Initialize
const app = new CodemanApp();

// Expose for debugging/testing
window.app = app;
window.MobileDetection = MobileDetection;
