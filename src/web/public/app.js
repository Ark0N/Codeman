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

    // Terminal write batching
    this.pendingWrites = '';
    this.writeFrameScheduled = false;

    // Render debouncing
    this.renderSessionTabsTimeout = null;

    // System stats polling
    this.systemStatsInterval = null;

    this.init();
  }

  init() {
    this.initTerminal();
    this.loadFontSize();
    this.connectSSE();
    this.loadState();
    this.loadQuickStartCases();
    this.setupEventListeners();
    // Show monitor panel by default
    this.toggleMonitorPanel();
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

    // Handle resize
    window.addEventListener('resize', () => this.fitAddon && this.fitAddon.fit());

    const resizeObserver = new ResizeObserver(() => {
      if (this.fitAddon) {
        this.fitAddon.fit();
        if (this.activeSessionId) {
          const dims = this.fitAddon.proposeDimensions();
          if (dims) {
            fetch(`/api/sessions/${this.activeSessionId}/resize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cols: dims.cols, rows: dims.rows })
            });
          }
        }
      }
    });
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
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'idle';
        this.renderSessionTabs();
      }
    });

    this.eventSource.addEventListener('session:working', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'busy';
        this.renderSessionTabs();
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
  }

  setConnectionStatus(status) {
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    dot.className = 'status-dot ' + status;
    text.textContent = status === 'connected' ? 'Connected' : 'Disconnected';
  }

  handleInit(data) {
    this.sessions.clear();
    data.sessions.forEach(s => this.sessions.set(s.id, s));

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
    const container = document.getElementById('sessionTabs');

    // Build tabs HTML
    let html = '';
    for (const [id, session] of this.sessions) {
      const isActive = id === this.activeSessionId;
      const status = session.status || 'idle';
      const name = this.getSessionName(session);
      const mode = session.mode || 'claude';
      const taskStats = session.taskStats || { running: 0, total: 0 };
      const hasRunningTasks = taskStats.running > 0;

      html += `
        <div class="session-tab ${isActive ? 'active' : ''}" data-id="${id}" onclick="app.selectSession('${id}')" oncontextmenu="event.preventDefault(); app.startInlineRename('${id}')">
          <span class="tab-status ${status}"></span>
          ${mode === 'shell' ? '<span class="tab-mode shell">sh</span>' : ''}
          <span class="tab-name" data-session-id="${id}">${this.escapeHtml(name)}</span>
          ${hasRunningTasks ? `<span class="tab-badge" onclick="event.stopPropagation(); app.toggleTaskPanel()">${taskStats.running}</span>` : ''}
          <span class="tab-gear" onclick="event.stopPropagation(); app.openSessionOptions('${id}')" title="Session options">&#x2699;</span>
          <span class="tab-close" onclick="event.stopPropagation(); app.requestCloseSession('${id}')">&times;</span>
        </div>
      `;
    }

    container.innerHTML = html;
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
      if (document.getElementById('taskPanel').classList.contains('open')) {
        this.renderTaskPanel();
      }

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

  async loadQuickStartCases() {
    try {
      const res = await fetch('/api/cases');
      const cases = await res.json();
      this.cases = cases;

      const select = document.getElementById('quickStartCase');

      // Build options
      let options = '<option value="testcase">testcase</option>';
      cases.forEach(c => {
        if (c.name !== 'testcase') {
          options += `<option value="${c.name}">${c.name}</option>`;
        }
      });

      select.innerHTML = options;

      // Auto-select first case and update directory display
      if (cases.length > 0) {
        const firstCase = cases.find(c => c.name === 'testcase') || cases[0];
        select.value = firstCase.name;
        this.updateDirDisplayForCase(firstCase.name);
      }

      // Update directory when case selection changes
      select.addEventListener('change', () => {
        this.updateDirDisplayForCase(select.value);
      });
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
      const caseData = await caseRes.json();

      // Create the case if it doesn't exist
      if (!caseData.path) {
        const createCaseRes = await fetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName, description: '' })
        });
        const createCaseData = await createCaseRes.json();
        if (!createCaseData.success) throw new Error(createCaseData.error || 'Failed to create case');
      }

      const workingDir = caseData.path || `${process.env.HOME}/claudeman-cases/${caseName}`;
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
          fetch(`/api/sessions/${firstSessionId}/resize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cols: dims.cols, rows: dims.rows })
          });
        }

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
      const workingDir = caseData.path || process.cwd();

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
    document.getElementById('respawnBanner').style.display = 'flex';
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
    document.getElementById('respawnBanner').style.display = 'none';
    this.hideRespawnTimer();
  }

  updateRespawnBanner(state) {
    document.getElementById('respawnState').textContent = state.replace(/_/g, ' ');
  }

  showRespawnTimer() {
    const timerEl = document.getElementById('respawnTimer');
    timerEl.style.display = '';
    this.updateRespawnTimer();
    // Update every second
    if (this.respawnTimerInterval) clearInterval(this.respawnTimerInterval);
    this.respawnTimerInterval = setInterval(() => this.updateRespawnTimer(), 1000);
  }

  hideRespawnTimer() {
    document.getElementById('respawnTimer').style.display = 'none';
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
      document.getElementById('respawnTimer').textContent = 'Time up';
      delete this.respawnTimers[this.activeSessionId];
      this.hideRespawnTimer();
      return;
    }

    document.getElementById('respawnTimer').textContent = this.formatTime(remaining);
  }

  updateRespawnTokens(totalTokens) {
    const tokensEl = document.getElementById('respawnTokens');
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
    document.getElementById('headerTokens').textContent = `${display} tokens`;
  }

  // ========== Session Options Modal ==========

  openSessionOptions(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.editingSessionId = sessionId;

    document.getElementById('sessionNameInput').value = session.name || '';
    document.getElementById('sessionDirDisplay').textContent = session.workingDir || 'Unknown';

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

    document.getElementById('sessionOptionsModal').classList.add('active');

    // Focus the name input
    setTimeout(() => document.getElementById('sessionNameInput').focus(), 100);
  }

  // Get respawn config from modal inputs
  getModalRespawnConfig() {
    const updatePrompt = document.getElementById('modalRespawnPrompt').value;
    const idleTimeout = parseInt(document.getElementById('modalRespawnIdleTimeout').value) || 5;
    const stepDelay = parseInt(document.getElementById('modalRespawnStepDelay').value) || 1;
    const sendClear = document.getElementById('modalRespawnSendClear').checked;
    const sendInit = document.getElementById('modalRespawnSendInit').checked;
    const durationStr = document.getElementById('modalRespawnDuration').value;
    const durationMinutes = durationStr ? parseInt(durationStr) : null;
    const autoClearEnabled = document.getElementById('modalAutoClearEnabled').checked;
    const autoClearThreshold = parseInt(document.getElementById('modalAutoClearThreshold').value) || 100000;

    return {
      respawnConfig: {
        updatePrompt,
        idleTimeoutMs: idleTimeout * 1000,
        interStepDelayMs: stepDelay * 1000,
        sendClear,
        sendInit,
      },
      durationMinutes,
      autoClearEnabled,
      autoClearThreshold
    };
  }

  async enableRespawnFromModal() {
    if (!this.editingSessionId) {
      this.showToast('No session selected', 'warning');
      return;
    }

    const { respawnConfig, durationMinutes, autoClearEnabled, autoClearThreshold } = this.getModalRespawnConfig();

    try {
      // Enable respawn on the session
      const res = await fetch(`/api/sessions/${this.editingSessionId}/respawn/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: respawnConfig, durationMinutes })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

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

  async saveSessionOptions() {
    if (!this.editingSessionId) return;

    const name = document.getElementById('sessionNameInput').value.trim();

    try {
      const res = await fetch(`/api/sessions/${this.editingSessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      this.showToast('Session renamed', 'success');
      this.closeSessionOptions();
    } catch (err) {
      this.showToast('Failed to rename: ' + err.message, 'error');
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
    document.getElementById('appSettingsModal').classList.add('active');
  }

  closeAppSettings() {
    document.getElementById('appSettingsModal').classList.remove('active');
  }

  async saveAppSettings() {
    const settings = {
      defaultClaudeMdPath: document.getElementById('appSettingsClaudeMdPath').value.trim(),
      defaultWorkingDir: document.getElementById('appSettingsDefaultDir').value.trim(),
    };

    // Save to localStorage
    localStorage.setItem('claudeman-app-settings', JSON.stringify(settings));

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

  async killAllSessions() {
    const count = this.screenSessions?.length || 0;
    if (count === 0) {
      alert('No sessions to kill');
      return;
    }

    const confirmed = confirm(`Kill all ${count} session(s)? This cannot be undone.`);
    if (!confirmed) return;

    try {
      const res = await fetch('/api/sessions', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        // Clear local state
        this.sessions.clear();
        this.screenSessions = [];
        this.activeSessionId = null;
        this.renderSessionTabs();
        this.renderScreenSessions();
        this.terminal.clear();
        this.terminal.reset();
      }
    } catch (err) {
      console.error('Failed to kill all sessions:', err);
      alert('Failed to kill sessions: ' + err.message);
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

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    container.appendChild(toast);

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
    const cpuEl = document.getElementById('statCpu');
    const memEl = document.getElementById('statMem');

    if (cpuEl) {
      cpuEl.textContent = `CPU: ${stats.cpu}%`;
      // Color based on usage
      if (stats.cpu > 80) {
        cpuEl.classList.add('high');
      } else {
        cpuEl.classList.remove('high');
      }
    }

    if (memEl) {
      const memGB = (stats.memory.usedMB / 1024).toFixed(1);
      memEl.textContent = `Mem: ${memGB}GB`;
      // Color based on usage
      if (stats.memory.percent > 80) {
        memEl.classList.add('high');
      } else {
        memEl.classList.remove('high');
      }
    }
  }

  // ========== Utility ==========

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize
const app = new ClaudemanApp();
