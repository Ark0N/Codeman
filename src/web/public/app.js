// Claudeman App - Tab-based Terminal UI
// Default terminal scrollback (can be changed via settings)
const DEFAULT_SCROLLBACK = 5000;

class ClaudemanApp {
  constructor() {
    this.sessions = new Map();
    this.cases = [];
    this.currentRun = null;
    this.totalTokens = 0;
    this.eventSource = null;
    this.terminal = null;
    this.fitAddon = null;
    this.activeSessionId = null;
    this.respawnStatus = {};
    this.respawnTimers = {}; // Track timed respawn timers
    this.terminalBuffers = new Map(); // Store terminal content per session
    this.editingSessionId = null; // Session being edited in options modal
    this.pendingCloseSessionId = null; // Session pending close confirmation
    this.screenSessions = []; // Screen sessions for process monitor

    // Inner loop/todo state per session
    this.innerStates = new Map(); // Map<sessionId, { loop, todos }>
    this.innerStatePanelCollapsed = true; // Default to collapsed

    // Terminal write batching
    this.pendingWrites = '';
    this.writeFrameScheduled = false;

    // Render debouncing
    this.renderSessionTabsTimeout = null;

    // System stats polling
    this.systemStatsInterval = null;

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

  init() {
    this.initTerminal();
    this.loadFontSize();
    this.applyHeaderVisibilitySettings();
    this.connectSSE();
    this.loadState();
    this.loadQuickStartCases();
    this.setupEventListeners();
    // Start system stats polling
    this.startSystemStatsPolling();
  }

  initTerminal() {
    // Load scrollback setting from localStorage (default 5000)
    const scrollback = parseInt(localStorage.getItem('claudeman-scrollback')) || DEFAULT_SCROLLBACK;

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
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: scrollback,
      allowTransparency: true,
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    const container = document.getElementById('terminalContainer');
    this.terminal.open(container);
    this.fitAddon.fit();

    // Welcome message
    this.showWelcome();

    // Handle resize with throttling for performance
    this._resizeTimeout = null;
    this._lastResizeDims = null;

    const throttledResize = () => {
      if (this._resizeTimeout) return;
      this._resizeTimeout = setTimeout(() => {
        this._resizeTimeout = null;
        if (this.fitAddon) {
          this.fitAddon.fit();
          if (this.activeSessionId) {
            const dims = this.fitAddon.proposeDimensions();
            // Only send resize if dimensions actually changed
            if (dims && (!this._lastResizeDims ||
                dims.cols !== this._lastResizeDims.cols ||
                dims.rows !== this._lastResizeDims.rows)) {
              this._lastResizeDims = { cols: dims.cols, rows: dims.rows };
              fetch(`/api/sessions/${this.activeSessionId}/resize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cols: dims.cols, rows: dims.rows })
              });
            }
          }
        }
      }, 100); // Throttle to 100ms
    };

    window.addEventListener('resize', throttledResize);
    const resizeObserver = new ResizeObserver(throttledResize);
    resizeObserver.observe(container);

    // Handle keyboard input
    this.terminal.onData((data) => {
      if (this.activeSessionId) {
        fetch(`/api/sessions/${this.activeSessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: data })
        });
      }
    });
  }

  showWelcome() {
    this.terminal.writeln('\x1b[1;36m  Claudeman Terminal\x1b[0m');
    this.terminal.writeln('\x1b[90m  Click "Run Claude" or press Ctrl+Enter to begin\x1b[0m');
    this.terminal.writeln('');
  }

  batchTerminalWrite(data) {
    this.pendingWrites += data;
    if (!this.writeFrameScheduled) {
      this.writeFrameScheduled = true;
      requestAnimationFrame(() => {
        if (this.pendingWrites && this.terminal) {
          this.terminal.write(this.pendingWrites);
          this.pendingWrites = '';
        }
        this.writeFrameScheduled = false;
      });
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

      // Ctrl/Cmd + +/- - font size
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        this.increaseFontSize();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        this.decreaseFontSize();
      }
    }, true); // Use capture phase to handle before terminal
  }

  // ========== SSE Connection ==========

  connectSSE() {
    this.eventSource = new EventSource('/api/events');

    this.eventSource.onopen = () => this.setConnectionStatus('connected');
    this.eventSource.onerror = () => {
      this.setConnectionStatus('disconnected');
      setTimeout(() => this.connectSSE(), 3000);
    };

    this.eventSource.addEventListener('init', (e) => {
      this.handleInit(JSON.parse(e.data));
    });

    this.eventSource.addEventListener('session:created', (e) => {
      const data = JSON.parse(e.data);
      this.sessions.set(data.id, data);
      this.renderSessionTabs();
      this.updateCost();
    });

    this.eventSource.addEventListener('session:updated', (e) => {
      const data = JSON.parse(e.data);
      const session = data.session || data;
      this.sessions.set(session.id, session);
      this.renderSessionTabs();
      this.updateCost();
      // Update tokens display if this is the active session
      if (session.id === this.activeSessionId && session.tokens) {
        this.updateRespawnTokens(session.tokens.total);
      }
    });

    this.eventSource.addEventListener('session:deleted', (e) => {
      const data = JSON.parse(e.data);
      this.sessions.delete(data.id);
      this.terminalBuffers.delete(data.id);
      if (this.activeSessionId === data.id) {
        this.activeSessionId = null;
        this.terminal.clear();
        this.showWelcome();
      }
      this.renderSessionTabs();
    });

    this.eventSource.addEventListener('session:terminal', (e) => {
      const data = JSON.parse(e.data);
      if (data.id === this.activeSessionId) {
        this.batchTerminalWrite(data.data);
      }
    });

    this.eventSource.addEventListener('session:clearTerminal', (e) => {
      const data = JSON.parse(e.data);
      if (data.id === this.activeSessionId) {
        // Clear terminal after screen attach to remove initialization blank space
        this.terminal.clear();
        this.terminal.reset();
      }
    });

    this.eventSource.addEventListener('session:completion', (e) => {
      const data = JSON.parse(e.data);
      this.totalCost += data.cost || 0;
      this.updateCost();
      if (data.id === this.activeSessionId) {
        this.terminal.writeln('');
        this.terminal.writeln(`\x1b[1;32m Done (Cost: $${(data.cost || 0).toFixed(4)})\x1b[0m`);
      }
    });

    this.eventSource.addEventListener('session:error', (e) => {
      const data = JSON.parse(e.data);
      if (data.id === this.activeSessionId) {
        this.terminal.writeln(`\x1b[1;31m Error: ${data.error}\x1b[0m`);
      }
    });

    this.eventSource.addEventListener('session:exit', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'stopped';
        this.renderSessionTabs();
      }
    });

    this.eventSource.addEventListener('session:idle', (e) => {
      const data = JSON.parse(e.data);
      console.log('[DEBUG] session:idle event for:', data.id);
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'idle';
        this.renderSessionTabs();
        this.sendPendingCtrlL(data.id);
      }
    });

    this.eventSource.addEventListener('session:working', (e) => {
      const data = JSON.parse(e.data);
      console.log('[DEBUG] session:working event for:', data.id);
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'busy';
        this.renderSessionTabs();
        this.sendPendingCtrlL(data.id);
      }
    });

    // Scheduled run events
    this.eventSource.addEventListener('scheduled:created', (e) => {
      this.currentRun = JSON.parse(e.data);
      this.showTimer();
    });

    this.eventSource.addEventListener('scheduled:updated', (e) => {
      this.currentRun = JSON.parse(e.data);
      this.updateTimer();
    });

    this.eventSource.addEventListener('scheduled:completed', (e) => {
      this.currentRun = JSON.parse(e.data);
      this.hideTimer();
      this.showToast('Scheduled run completed!', 'success');
    });

    this.eventSource.addEventListener('scheduled:stopped', (e) => {
      this.currentRun = null;
      this.hideTimer();
    });

    // Respawn events
    this.eventSource.addEventListener('respawn:started', (e) => {
      const data = JSON.parse(e.data);
      this.respawnStatus[data.sessionId] = data.status;
      if (data.sessionId === this.activeSessionId) {
        this.showRespawnBanner();
      }
    });

    this.eventSource.addEventListener('respawn:stopped', (e) => {
      const data = JSON.parse(e.data);
      delete this.respawnStatus[data.sessionId];
      if (data.sessionId === this.activeSessionId) {
        this.hideRespawnBanner();
      }
    });

    this.eventSource.addEventListener('respawn:stateChanged', (e) => {
      const data = JSON.parse(e.data);
      if (this.respawnStatus[data.sessionId]) {
        this.respawnStatus[data.sessionId].state = data.state;
      }
      if (data.sessionId === this.activeSessionId) {
        this.updateRespawnBanner(data.state);
      }
    });

    this.eventSource.addEventListener('respawn:cycleStarted', (e) => {
      const data = JSON.parse(e.data);
      if (this.respawnStatus[data.sessionId]) {
        this.respawnStatus[data.sessionId].cycleCount = data.cycleNumber;
      }
      if (data.sessionId === this.activeSessionId) {
        document.getElementById('respawnCycleCount').textContent = data.cycleNumber;
      }
    });

    this.eventSource.addEventListener('respawn:stepSent', (e) => {
      const data = JSON.parse(e.data);
      if (data.sessionId === this.activeSessionId) {
        document.getElementById('respawnStep').textContent = data.input;
      }
    });

    // Respawn timer events
    this.eventSource.addEventListener('respawn:timerStarted', (e) => {
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

    // Auto-clear event
    this.eventSource.addEventListener('session:autoClear', (e) => {
      const data = JSON.parse(e.data);
      if (data.sessionId === this.activeSessionId) {
        this.showToast(`Auto-cleared at ${data.tokens.toLocaleString()} tokens`, 'info');
        this.updateRespawnTokens(0);
      }
    });

    // Background task events
    this.eventSource.addEventListener('task:created', (e) => {
      const data = JSON.parse(e.data);
      this.renderSessionTabs();
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    this.eventSource.addEventListener('task:completed', (e) => {
      const data = JSON.parse(e.data);
      this.renderSessionTabs();
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    this.eventSource.addEventListener('task:failed', (e) => {
      const data = JSON.parse(e.data);
      this.renderSessionTabs();
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    this.eventSource.addEventListener('task:updated', (e) => {
      const data = JSON.parse(e.data);
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    // Screen events
    this.eventSource.addEventListener('screen:created', (e) => {
      const screen = JSON.parse(e.data);
      this.screenSessions.push(screen);
      this.renderScreenSessions();
    });

    this.eventSource.addEventListener('screen:killed', (e) => {
      const data = JSON.parse(e.data);
      this.screenSessions = this.screenSessions.filter(s => s.sessionId !== data.sessionId);
      this.renderScreenSessions();
    });

    this.eventSource.addEventListener('screen:died', (e) => {
      const data = JSON.parse(e.data);
      this.screenSessions = this.screenSessions.filter(s => s.sessionId !== data.sessionId);
      this.renderScreenSessions();
      this.showToast('Screen session died: ' + data.sessionId.slice(0, 8), 'warning');
    });

    this.eventSource.addEventListener('screen:statsUpdated', (e) => {
      this.screenSessions = JSON.parse(e.data);
      if (document.getElementById('monitorPanel').classList.contains('open')) {
        this.renderScreenSessions();
      }
    });

    // Inner loop/todo events
    this.eventSource.addEventListener('session:innerLoopUpdate', (e) => {
      const data = JSON.parse(e.data);
      this.updateInnerState(data.sessionId, { loop: data.state });
    });

    this.eventSource.addEventListener('session:innerTodoUpdate', (e) => {
      const data = JSON.parse(e.data);
      this.updateInnerState(data.sessionId, { todos: data.todos });
    });

    this.eventSource.addEventListener('session:innerCompletionDetected', (e) => {
      const data = JSON.parse(e.data);
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

      this.showToast(`Loop completed: ${data.phrase}`, 'success');
      // Update inner state to mark loop as inactive
      const existing = this.innerStates.get(data.sessionId) || {};
      if (existing.loop) {
        existing.loop.active = false;
        this.updateInnerState(data.sessionId, existing);
      }
      // Show celebration animation if this is the active session
      if (data.sessionId === this.activeSessionId) {
        this.showRalphCelebration(data.phrase);
      }
    });
  }

  setConnectionStatus(status) {
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    dot.className = 'status-dot ' + status;
    text.textContent = status === 'connected' ? 'Connected' : 'Disconnected';
  }

  handleInit(data) {
    this.sessions.clear();
    this.innerStates.clear();
    data.sessions.forEach(s => {
      this.sessions.set(s.id, s);
      // Load inner state from session data
      if (s.innerLoop || s.innerTodos) {
        this.innerStates.set(s.id, {
          loop: s.innerLoop || null,
          todos: s.innerTodos || []
        });
      }
    });

    if (data.respawnStatus) {
      this.respawnStatus = data.respawnStatus;
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

    // Auto-select first session if any
    if (this.sessions.size > 0 && !this.activeSessionId) {
      const firstSession = this.sessions.values().next().value;
      this.selectSession(firstSession.id);
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

  _renderSessionTabsImmediate() {
    const container = this.$('sessionTabs');

    // Build tabs HTML using array for better string concatenation performance
    const parts = [];
    for (const [id, session] of this.sessions) {
      const isActive = id === this.activeSessionId;
      const status = session.status || 'idle';
      const name = this.getSessionName(session);
      const mode = session.mode || 'claude';
      const taskStats = session.taskStats || { running: 0, total: 0 };
      const hasRunningTasks = taskStats.running > 0;

      parts.push(`<div class="session-tab ${isActive ? 'active' : ''}" data-id="${id}" onclick="app.selectSession('${id}')" oncontextmenu="event.preventDefault(); app.startInlineRename('${id}')">
          <span class="tab-status ${status}"></span>
          ${mode === 'shell' ? '<span class="tab-mode shell">sh</span>' : ''}
          <span class="tab-name" data-session-id="${id}">${this.escapeHtml(name)}</span>
          ${hasRunningTasks ? `<span class="tab-badge" onclick="event.stopPropagation(); app.toggleTaskPanel()">${taskStats.running}</span>` : ''}
          <span class="tab-gear" onclick="event.stopPropagation(); app.openSessionOptions('${id}')" title="Session options">&#x2699;</span>
          <span class="tab-close" onclick="event.stopPropagation(); app.requestCloseSession('${id}')">&times;</span>
        </div>`);
    }

    container.innerHTML = parts.join('');
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

    this.activeSessionId = sessionId;
    this.renderSessionTabs();

    // Load terminal buffer for this session
    try {
      const res = await fetch(`/api/sessions/${sessionId}/terminal`);
      const data = await res.json();

      this.terminal.clear();
      this.terminal.reset();
      if (data.terminalBuffer) {
        this.terminal.write(data.terminalBuffer);
      }

      // Send resize and Ctrl+L to trigger Claude to redraw at correct size
      const dims = this.fitAddon.proposeDimensions();
      if (dims) {
        await fetch(`/api/sessions/${sessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: dims.cols, rows: dims.rows })
        });
        // Send Ctrl+L to fix squished display after tab switch
        const session = this.sessions.get(sessionId);
        if (session && session.mode !== 'shell') {
          fetch(`/api/sessions/${sessionId}/input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: '\x0c' })
          });
        }
      }

      // Update respawn banner
      if (this.respawnStatus[sessionId]) {
        this.showRespawnBanner();
        this.updateRespawnBanner(this.respawnStatus[sessionId].state);
        document.getElementById('respawnCycleCount').textContent = this.respawnStatus[sessionId].cycleCount || 0;
      } else {
        this.hideRespawnBanner();
      }

      // Update task panel if open
      const taskPanel = document.getElementById('taskPanel');
      if (taskPanel && taskPanel.classList.contains('open')) {
        this.renderTaskPanel();
      }

      // Update inner state panel for this session
      const session = this.sessions.get(sessionId);
      if (session && (session.innerLoop || session.innerTodos)) {
        this.updateInnerState(sessionId, {
          loop: session.innerLoop,
          todos: session.innerTodos
        });
      }
      this.renderInnerStatePanel();

      this.terminal.focus();
    } catch (err) {
      console.error('Failed to load session terminal:', err);
    }
  }

  async closeSession(sessionId, killScreen = true) {
    try {
      await fetch(`/api/sessions/${sessionId}?killScreen=${killScreen}`, { method: 'DELETE' });
      this.sessions.delete(sessionId);
      this.terminalBuffers.delete(sessionId);
      this.innerStates.delete(sessionId);

      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
        // Select another session or show welcome
        if (this.sessions.size > 0) {
          const nextSession = this.sessions.values().next().value;
          this.selectSession(nextSession.id);
        } else {
          this.terminal.clear();
          this.showWelcome();
        }
      }

      this.renderSessionTabs();

      if (killScreen) {
        this.showToast('Session closed and screen killed', 'success');
      } else {
        this.showToast('Tab hidden, screen still running', 'info');
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

    document.getElementById('closeConfirmModal').classList.add('active');
  }

  cancelCloseSession() {
    this.pendingCloseSessionId = null;
    document.getElementById('closeConfirmModal').classList.remove('active');
  }

  async confirmCloseSession(killScreen = true) {
    const sessionId = this.pendingCloseSessionId;
    this.cancelCloseSession();

    if (sessionId) {
      await this.closeSession(sessionId, killScreen);
    }
  }

  nextSession() {
    const ids = Array.from(this.sessions.keys());
    if (ids.length <= 1) return;

    const currentIndex = ids.indexOf(this.activeSessionId);
    const nextIndex = (currentIndex + 1) % ids.length;
    this.selectSession(ids[nextIndex]);
  }

  // ========== Quick Start ==========

  async loadQuickStartCases(selectCaseName = null) {
    try {
      // Add cache-busting to ensure fresh data
      const res = await fetch('/api/cases?_t=' + Date.now());
      const cases = await res.json();
      this.cases = cases;
      console.log('[loadQuickStartCases] Loaded cases:', cases.map(c => c.name));

      const select = document.getElementById('quickStartCase');

      // Build options - existing cases first, then testcase as fallback if not present
      let options = '';
      const hasTestcase = cases.some(c => c.name === 'testcase');

      cases.forEach(c => {
        options += `<option value="${c.name}">${c.name}</option>`;
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
      } else if (cases.length > 0) {
        // Auto-select first case
        const firstCase = cases.find(c => c.name === 'testcase') || cases[0];
        select.value = firstCase.name;
        this.updateDirDisplayForCase(firstCase.name);
      } else {
        // No cases exist yet - show the default case name as directory hint
        select.value = 'testcase';
        document.getElementById('dirDisplay').textContent = '~/claudeman-cases/testcase (will be created)';
      }

      // Only add event listener once (on first load)
      if (!select.dataset.listenerAdded) {
        select.addEventListener('change', () => {
          this.updateDirDisplayForCase(select.value);
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

  async quickStart() {
    // Alias for backward compatibility
    return this.runClaude();
  }

  // Tab count stepper functions
  incrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(10, current + 1);
  }

  decrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  }

  async runClaude() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const tabCount = Math.min(10, Math.max(1, parseInt(document.getElementById('tabCount').value) || 1));

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

      // Find the highest existing w-number for this case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^w(\d+)-/);
        if (match) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Get global Ralph tracker setting
      const ralphEnabled = this.isRalphTrackerEnabledByDefault();

      // Create multiple sessions with unique w-numbers
      for (let i = 0; i < tabCount; i++) {
        const sessionName = `w${startNumber + i}-${caseName}`;

        // Create session
        const createRes = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir, name: sessionName })
        });
        const createData = await createRes.json();
        if (!createData.success) throw new Error(createData.error);

        // Apply global Ralph tracker setting
        if (ralphEnabled) {
          await fetch(`/api/sessions/${createData.session.id}/inner-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true })
          });
        }

        // Start interactive mode
        await fetch(`/api/sessions/${createData.session.id}/interactive`, {
          method: 'POST'
        });

        // Track first session
        if (i === 0) {
          firstSessionId = createData.session.id;
        }

        this.terminal.writeln(`\x1b[90m Created session ${i}/${tabCount}: ${sessionName}\x1b[0m`);
      }

      // Auto-switch to the new session
      if (firstSessionId) {
        // IMPORTANT: Clear terminal BEFORE setting activeSessionId
        // This prevents SSE events from writing during the transition
        this.terminal.clear();
        this.terminal.reset();

        // Small delay to ensure terminal is fully reset before SSE events can write
        await new Promise(resolve => setTimeout(resolve, 50));

        // NOW set the active session so SSE events start populating
        this.activeSessionId = firstSessionId;
        this.renderSessionTabs();

        // Send resize to the new session
        const dims = this.fitAddon.proposeDimensions();
        if (dims) {
          await fetch(`/api/sessions/${firstSessionId}/resize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cols: dims.cols, rows: dims.rows })
          });
        }
        // Mark this session as needing Ctrl+L fix once Claude is running
        this.pendingCtrlL = this.pendingCtrlL || new Set();
        this.pendingCtrlL.add(firstSessionId);
        console.log('[DEBUG] Marked session for pending Ctrl+L:', firstSessionId);

        this.loadQuickStartCases();
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  }

  async runShell() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;33m Starting Shell in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Get the case path
      const caseRes = await fetch(`/api/cases/${caseName}`);
      const caseData = await caseRes.json();
      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');

      // Find the highest existing s-number for shells to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^s(\d+)-/);
        if (match) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }
      const sessionName = `s${startNumber}-${caseName}`;

      // Create session with shell mode
      const createRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir, mode: 'shell', name: sessionName })
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error);

      const sessionId = createData.session.id;

      // Start shell
      await fetch(`/api/sessions/${sessionId}/shell`, {
        method: 'POST'
      });

      this.activeSessionId = sessionId;

      // Send resize
      const dims = this.fitAddon.proposeDimensions();
      if (dims) {
        await fetch(`/api/sessions/${sessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: dims.cols, rows: dims.rows })
        });
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
      this.updateRespawnTokens(session.tokens.total);
    }
  }

  hideRespawnBanner() {
    this.$('respawnBanner').style.display = 'none';
    this.hideRespawnTimer();
  }

  updateRespawnBanner(state) {
    this.$('respawnState').textContent = state.replace(/_/g, ' ');
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

  updateRespawnTokens(totalTokens) {
    const tokensEl = this.$('respawnTokens');
    if (totalTokens > 0) {
      tokensEl.style.display = '';
      tokensEl.textContent = `${(totalTokens / 1000).toFixed(1)}k tokens`;
    } else {
      tokensEl.style.display = 'none';
    }
  }

  async stopRespawn() {
    if (!this.activeSessionId) return;
    try {
      await fetch(`/api/sessions/${this.activeSessionId}/respawn/stop`, { method: 'POST' });
      delete this.respawnTimers[this.activeSessionId];
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
      await fetch('/api/sessions', { method: 'DELETE' });
      this.sessions.clear();
      this.terminalBuffers.clear();
      this.activeSessionId = null;
      this.respawnStatus = {};
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

  // Send Ctrl+L to fix display for newly created sessions once Claude is running
  sendPendingCtrlL(sessionId) {
    console.log('[DEBUG] sendPendingCtrlL called for:', sessionId, 'pending:', this.pendingCtrlL ? [...this.pendingCtrlL] : 'none');
    if (!this.pendingCtrlL || !this.pendingCtrlL.has(sessionId)) {
      console.log('[DEBUG] No pending Ctrl+L for this session');
      return;
    }
    this.pendingCtrlL.delete(sessionId);

    // Only send if this is the active session
    if (sessionId !== this.activeSessionId) {
      console.log('[DEBUG] Not active session, skipping Ctrl+L');
      return;
    }

    console.log('[DEBUG] Sending resize + Ctrl+L for session:', sessionId);
    // Send resize + Ctrl+L to fix the display
    const dims = this.fitAddon.proposeDimensions();
    if (dims) {
      fetch(`/api/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: dims.cols, rows: dims.rows })
      }).then(() => {
        console.log('[DEBUG] Resize sent, now sending Ctrl+L');
        fetch(`/api/sessions/${sessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: '\x0c' })
        });
      });
    }
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
    localStorage.setItem('claudeman-font-size', size);
  }

  loadFontSize() {
    const saved = localStorage.getItem('claudeman-font-size');
    if (saved) {
      const size = parseInt(saved, 10);
      if (size >= 10 && size <= 24) {
        this.terminal.options.fontSize = size;
        document.getElementById('fontSizeDisplay').textContent = size;
      }
    }
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
    let total = 0;
    this.sessions.forEach(s => {
      if (s.tokens) {
        total += s.tokens.total || 0;
      }
    });
    this.totalTokens = total;
    const display = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total;
    this.$('headerTokens').textContent = `${display} tokens`;
  }

  // ========== Session Options Modal ==========

  openSessionOptions(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.editingSessionId = sessionId;

    // Reset to Respawn tab
    this.switchOptionsTab('respawn');

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

    // Reset duration presets to default (unlimited)
    this.selectDurationPreset('');

    // Populate Ralph Wiggum form with current session values
    const innerState = this.innerStates.get(sessionId);
    this.populateRalphForm({
      enabled: innerState?.loop?.enabled ?? session.innerConfig?.enabled ?? false,
      completionPhrase: innerState?.loop?.completionPhrase || session.innerLoop?.completionPhrase || '',
      maxIterations: innerState?.loop?.maxIterations || session.innerLoop?.maxIterations || 0,
      maxTodos: session.innerConfig?.maxTodos || 50,
      todoExpirationMinutes: session.innerConfig?.todoExpirationMinutes || 60
    });

    document.getElementById('sessionOptionsModal').classList.add('active');
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

  // Get respawn config from modal inputs
  getModalRespawnConfig() {
    const updatePrompt = document.getElementById('modalRespawnPrompt').value;
    const sendClear = document.getElementById('modalRespawnSendClear').checked;
    const sendInit = document.getElementById('modalRespawnSendInit').checked;
    const kickstartPrompt = document.getElementById('modalRespawnKickstart').value.trim() || undefined;
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
        updatePrompt,
        sendClear,
        sendInit,
        kickstartPrompt,
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
    document.getElementById('sessionOptionsModal').classList.remove('active');
  }

  saveSessionOptions() {
    // Session options are applied immediately via individual controls
    // This just closes the modal
    this.closeSessionOptions();
  }

  // ========== Session Options Modal Tabs ==========

  switchOptionsTab(tabName) {
    // Toggle active class on tab buttons
    document.querySelectorAll('.modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Toggle hidden class on tab content
    document.getElementById('respawn-tab').classList.toggle('hidden', tabName !== 'respawn');
    document.getElementById('ralph-tab').classList.toggle('hidden', tabName !== 'ralph');
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

    try {
      const res = await fetch(`/api/sessions/${this.editingSessionId}/inner-config`, {
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

  // ========== App Settings Modal ==========

  openAppSettings() {
    // Load current settings
    const settings = this.loadAppSettingsFromStorage();
    document.getElementById('appSettingsClaudeMdPath').value = settings.defaultClaudeMdPath || '';
    document.getElementById('appSettingsDefaultDir').value = settings.defaultWorkingDir || '';
    document.getElementById('appSettingsRalphEnabled').checked = settings.ralphTrackerEnabled ?? false;
    // Header visibility settings (default to true/enabled)
    document.getElementById('appSettingsShowFontControls').checked = settings.showFontControls ?? true;
    document.getElementById('appSettingsShowSystemStats').checked = settings.showSystemStats ?? true;
    document.getElementById('appSettingsShowTokenCount').checked = settings.showTokenCount ?? true;
    document.getElementById('appSettingsModal').classList.add('active');
  }

  closeAppSettings() {
    document.getElementById('appSettingsModal').classList.remove('active');
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
    };

    // Save to localStorage
    localStorage.setItem('claudeman-app-settings', JSON.stringify(settings));

    // Apply header visibility immediately
    this.applyHeaderVisibilitySettings();

    // Also save to server
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      this.showToast('Settings saved', 'success');
    } catch (err) {
      // Server save failed but localStorage succeeded
      this.showToast('Settings saved locally', 'warning');
    }

    this.closeAppSettings();
  }

  // Get the global Ralph tracker enabled setting
  isRalphTrackerEnabledByDefault() {
    const settings = this.loadAppSettingsFromStorage();
    return settings.ralphTrackerEnabled ?? false;
  }

  loadAppSettingsFromStorage() {
    try {
      const saved = localStorage.getItem('claudeman-app-settings');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (err) {
      console.error('Failed to load app settings:', err);
    }
    return {};
  }

  applyHeaderVisibilitySettings() {
    const settings = this.loadAppSettingsFromStorage();
    // Default all to true (enabled) if not set
    const showFontControls = settings.showFontControls ?? true;
    const showSystemStats = settings.showSystemStats ?? true;
    const showTokenCount = settings.showTokenCount ?? true;

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
  }

  async loadAppSettingsFromServer() {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const settings = await res.json();
        // Merge with localStorage (server takes precedence)
        const localSettings = this.loadAppSettingsFromStorage();
        const merged = { ...localSettings, ...settings };
        localStorage.setItem('claudeman-app-settings', JSON.stringify(merged));
        return merged;
      }
    } catch (err) {
      console.error('Failed to load settings from server:', err);
    }
    return this.loadAppSettingsFromStorage();
  }

  // ========== Help Modal ==========

  showHelp() {
    document.getElementById('helpModal').classList.add('active');
  }

  closeHelp() {
    document.getElementById('helpModal').classList.remove('active');
  }

  closeAllPanels() {
    this.closeSessionOptions();
    this.closeAppSettings();
    this.cancelCloseSession();
    document.getElementById('monitorPanel').classList.remove('open');
  }

  // ========== Monitor Panel (combined Screen Sessions + Background Tasks) ==========

  async toggleMonitorPanel() {
    const panel = document.getElementById('monitorPanel');
    const toggleBtn = document.getElementById('monitorToggleBtn');
    panel.classList.toggle('open');

    if (panel.classList.contains('open')) {
      // Load screens and start stats collection
      await this.loadScreens();
      await fetch('/api/screens/stats/start', { method: 'POST' });
      this.renderTaskPanel();
      if (toggleBtn) toggleBtn.innerHTML = '&#x25BC;'; // Down arrow when open
    } else {
      // Stop stats collection when panel is closed
      await fetch('/api/screens/stats/stop', { method: 'POST' });
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
        detachBtn.innerHTML = '&#x2197;'; // Detach icon
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x2199;'; // Attach icon
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

    const onMouseDown = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
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
    header.removeEventListener('mousedown', header._dragHandler);
    header._dragHandler = onMouseDown;
    header.addEventListener('mousedown', onMouseDown);
  }

  renderTaskPanel() {
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
            <div class="task-description">${this.escapeHtml(task.description)}</div>
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

  updateInnerState(sessionId, updates) {
    const existing = this.innerStates.get(sessionId) || { loop: null, todos: [] };
    const updated = { ...existing, ...updates };
    this.innerStates.set(sessionId, updated);

    // Re-render if this is the active session
    if (sessionId === this.activeSessionId) {
      this.renderInnerStatePanel();
    }
  }

  toggleInnerStatePanel() {
    this.innerStatePanelCollapsed = !this.innerStatePanelCollapsed;
    this.renderInnerStatePanel();
  }

  toggleRalphDetach() {
    const panel = this.$('innerStatePanel');
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
        detachBtn.innerHTML = '&#x2197;'; // Detach icon
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      // Expand when detaching for better visibility
      this.innerStatePanelCollapsed = false;
      panel.classList.remove('collapsed');
      if (detachBtn) {
        detachBtn.innerHTML = '&#x2199;'; // Attach icon
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupRalphDrag();
    }
    this.renderInnerStatePanel();
  }

  setupRalphDrag() {
    const panel = this.$('innerStatePanel');
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

  renderInnerStatePanel() {
    const panel = this.$('innerStatePanel');
    const toggle = this.$('ralphToggle');

    if (!panel) return;

    const state = this.innerStates.get(this.activeSessionId);

    // Check if there's anything to show
    // Only show panel if tracker is enabled OR there's active state to display
    const isEnabled = state?.loop?.enabled === true;
    const hasLoop = state?.loop?.active || state?.loop?.completionPhrase;
    const hasTodos = state?.todos?.length > 0;

    if (!isEnabled && !hasLoop && !hasTodos) {
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

    // Update status badge
    this.updateRalphStatus(state?.loop);

    // Update stats
    this.updateRalphStats(state?.loop, completed, total);

    // Update phrase preview
    const phrasePreview = this.$('ralphPhrasePreview');
    if (phrasePreview && state?.loop?.completionPhrase) {
      phrasePreview.innerHTML = `<code>${this.escapeHtml(state.loop.completionPhrase)}</code>`;
    } else if (phrasePreview) {
      phrasePreview.textContent = '';
    }

    // Handle collapsed/expanded state
    if (this.innerStatePanelCollapsed) {
      panel.classList.add('collapsed');
      if (toggle) toggle.innerHTML = '&#x25B6;';
    } else {
      panel.classList.remove('collapsed');
      if (toggle) toggle.innerHTML = '&#x25BC;';

      // Update expanded view content
      this.updateRalphExpandedView(state);
    }
  }

  updateRalphRing(percent) {
    // Mini ring (in summary)
    const miniProgress = this.$('ralphRingMiniProgress');
    const miniText = this.$('ralphRingMiniText');
    if (miniProgress) {
      // Circumference = 2 * PI * r = 2 * PI * 15.9 ≈ 100
      const offset = 100 - percent;
      miniProgress.style.strokeDashoffset = offset;
    }
    if (miniText) {
      miniText.textContent = `${percent}%`;
    }

    // Large ring (in expanded view)
    const largeProgress = this.$('ralphRingProgress');
    const largePercent = this.$('ralphRingPercent');
    if (largeProgress) {
      // Circumference = 2 * PI * r = 2 * PI * 42 ≈ 264
      const offset = 264 - (264 * percent / 100);
      largeProgress.style.strokeDashoffset = offset;
    }
    if (largePercent) {
      largePercent.textContent = `${percent}%`;
    }
  }

  updateRalphStatus(loop) {
    const badge = this.$('ralphStatusBadge');
    const statusText = badge?.querySelector('.ralph-status-text');
    if (!badge || !statusText) return;

    badge.classList.remove('active', 'completed', 'tracking');

    if (loop?.active) {
      badge.classList.add('active');
      statusText.textContent = 'Running';
    } else if (loop?.completionPhrase && !loop?.active) {
      badge.classList.add('completed');
      statusText.textContent = 'Complete';
    } else if (loop?.enabled) {
      badge.classList.add('tracking');
      statusText.textContent = 'Tracking';
    } else {
      statusText.textContent = 'Idle';
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

    // Render task cards
    this.renderRalphTasks(todos);
  }

  renderRalphTasks(todos) {
    const grid = this.$('ralphTasksGrid');
    if (!grid) return;

    if (todos.length === 0) {
      grid.innerHTML = '<div class="inner-state-empty">No tasks detected</div>';
      return;
    }

    // Sort: in_progress first, then pending, then completed
    const sorted = [...todos].sort((a, b) => {
      const order = { in_progress: 0, pending: 1, completed: 2 };
      return (order[a.status] || 1) - (order[b.status] || 1);
    });

    grid.innerHTML = sorted.map(todo => {
      const statusClass = `task-${todo.status.replace('_', '-')}`;
      const icon = this.getRalphTaskIcon(todo.status);
      return `
        <div class="ralph-task-card ${statusClass}">
          <span class="ralph-task-icon">${icon}</span>
          <span class="ralph-task-content">${this.escapeHtml(todo.content)}</span>
        </div>
      `;
    }).join('');
  }

  getRalphTaskIcon(status) {
    switch (status) {
      case 'completed': return '✓';
      case 'in_progress': return '◐';
      case 'pending':
      default: return '○';
    }
  }

  showRalphCelebration(phrase) {
    const celebration = this.$('ralphCelebration');
    const text = this.$('ralphCelebrationText');
    if (!celebration) return;

    if (text) {
      text.textContent = phrase ? `${phrase}` : 'Complete!';
    }

    celebration.classList.add('show');

    // Auto-hide after 3 seconds
    setTimeout(() => {
      celebration.classList.remove('show');
    }, 3000);
  }

  // Legacy method for backwards compatibility
  getTodoIcon(status) {
    return this.getRalphTaskIcon(status);
  }

  // ========== Screen Sessions (in Monitor Panel) ==========

  async loadScreens() {
    try {
      const res = await fetch('/api/screens');
      const data = await res.json();
      this.screenSessions = data.screens || [];
      this.renderScreenSessions();
    } catch (err) {
      console.error('Failed to load screens:', err);
    }
  }

  killAllSessions() {
    const count = this.screenSessions?.length || 0;
    if (count === 0) {
      alert('No sessions to kill');
      return;
    }

    // Show the kill all modal
    document.getElementById('killAllCount').textContent = count;
    document.getElementById('killAllModal').classList.add('active');
  }

  closeKillAllModal() {
    document.getElementById('killAllModal').classList.remove('active');
  }

  async confirmKillAll(killScreens) {
    this.closeKillAllModal();

    try {
      if (killScreens) {
        // Kill everything including screens
        const res = await fetch('/api/sessions', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          this.sessions.clear();
          this.screenSessions = [];
          this.activeSessionId = null;
          this.renderSessionTabs();
          this.renderScreenSessions();
          this.terminal.clear();
          this.terminal.reset();
          this.toast('All sessions and screens killed', 'success');
        }
      } else {
        // Just remove tabs, keep screens running
        this.sessions.clear();
        this.activeSessionId = null;
        this.renderSessionTabs();
        this.terminal.clear();
        this.terminal.reset();
        this.toast('All tabs removed, screens still running', 'info');
      }
    } catch (err) {
      console.error('Failed to kill sessions:', err);
      this.toast('Failed to kill sessions: ' + err.message, 'error');
    }
  }

  // ========== Create Case Modal ==========

  showCreateCaseModal() {
    document.getElementById('newCaseName').value = '';
    document.getElementById('newCaseDescription').value = '';
    document.getElementById('createCaseModal').classList.add('active');
    document.getElementById('newCaseName').focus();
  }

  closeCreateCaseModal() {
    document.getElementById('createCaseModal').classList.remove('active');
  }

  async createCase() {
    const name = document.getElementById('newCaseName').value.trim();
    const description = document.getElementById('newCaseDescription').value.trim();

    if (!name) {
      this.toast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.toast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
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
        this.toast(`Case "${name}" created`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
      } else {
        this.toast(data.error || 'Failed to create case', 'error');
      }
    } catch (err) {
      console.error('Failed to create case:', err);
      this.toast('Failed to create case: ' + err.message, 'error');
    }
  }

  renderScreenSessions() {
    const body = document.getElementById('screenSessionsBody');

    if (!this.screenSessions || this.screenSessions.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No screen sessions</div>';
      return;
    }

    let html = '';
    for (const screen of this.screenSessions) {
      const stats = screen.stats || { memoryMB: 0, cpuPercent: 0, childCount: 0 };
      const modeClass = screen.mode === 'shell' ? 'shell' : '';

      html += `
        <div class="process-item">
          <span class="process-mode ${modeClass}">${screen.mode}</span>
          <div class="process-info">
            <div class="process-name">${this.escapeHtml(screen.name || screen.screenName)}</div>
            <div class="process-meta">
              <span class="process-stat memory">${stats.memoryMB}MB</span>
              <span class="process-stat cpu">${stats.cpuPercent}%</span>
              <span class="process-stat children">${stats.childCount} children</span>
              <span>PID: ${screen.pid}</span>
            </div>
          </div>
          <div class="process-actions">
            <button class="btn-toolbar btn-sm btn-danger" onclick="app.killScreen('${screen.sessionId}')" title="Kill screen">Kill</button>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  async killScreen(sessionId) {
    if (!confirm('Kill this screen session?')) return;

    try {
      await fetch(`/api/screens/${sessionId}`, { method: 'DELETE' });
      this.screenSessions = this.screenSessions.filter(s => s.sessionId !== sessionId);
      this.renderScreenSessions();
      this.showToast('Screen killed', 'success');
    } catch (err) {
      this.showToast('Failed to kill screen', 'error');
    }
  }

  async reconcileScreens() {
    try {
      const res = await fetch('/api/screens/reconcile', { method: 'POST' });
      const data = await res.json();

      if (data.dead && data.dead.length > 0) {
        this.showToast(`Found ${data.dead.length} dead screen(s)`, 'warning');
        await this.loadScreens();
      } else {
        this.showToast('All screens are alive', 'success');
      }
    } catch (err) {
      this.showToast('Failed to reconcile screens', 'error');
    }
  }

  // ========== Toast ==========

  // Cached toast container for performance
  _toastContainer = null;

  // Alias for showToast
  toast(message, type = 'info') {
    return this.showToast(message, type);
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

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
    }, 3000);
  }

  // ========== System Stats ==========

  startSystemStatsPolling() {
    // Initial fetch
    this.fetchSystemStats();

    // Poll every 2 seconds
    this.systemStatsInterval = setInterval(() => {
      this.fetchSystemStats();
    }, 2000);
  }

  async fetchSystemStats() {
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

  // ========== Utility ==========

  // Pre-compiled HTML escape map for performance (avoids DOM element creation)
  static _htmlEscapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  static _htmlEscapePattern = /[&<>"']/g;

  escapeHtml(text) {
    if (!text) return '';
    return text.replace(ClaudemanApp._htmlEscapePattern, char => ClaudemanApp._htmlEscapeMap[char]);
  }
}

// Initialize
const app = new ClaudemanApp();
