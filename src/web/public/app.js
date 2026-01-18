// Claudeman App - Tab-based Terminal UI
class ClaudemanApp {
  constructor() {
    this.sessions = new Map();
    this.cases = [];
    this.currentRun = null;
    this.totalCost = 0;
    this.eventSource = null;
    this.terminal = null;
    this.fitAddon = null;
    this.activeSessionId = null;
    this.respawnStatus = {};
    this.respawnTimers = {}; // Track timed respawn timers
    this.terminalBuffers = new Map(); // Store terminal content per session

    // Terminal write batching
    this.pendingWrites = '';
    this.writeFrameScheduled = false;

    this.init();
  }

  init() {
    this.initTerminal();
    this.loadFontSize();
    this.connectSSE();
    this.loadState();
    this.loadQuickStartCases();
    this.setupEventListeners();
  }

  initTerminal() {
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
      scrollback: 10000,
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
    this.terminal.writeln('\x1b[90m  Click "Quick Start" or press Ctrl+Enter to begin\x1b[0m');
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

      // Ctrl/Cmd + N - new session
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        this.createNewSession();
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
    });
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
      this.sessions.set(data.id, data);
      this.renderSessionTabs();
      this.updateCost();
      // Update tokens display if this is the active session
      if (data.id === this.activeSessionId && data.tokens) {
        this.updateRespawnTokens(data.tokens.total);
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
    const container = document.getElementById('sessionTabs');

    // Build tabs HTML
    let html = '';
    for (const [id, session] of this.sessions) {
      const isActive = id === this.activeSessionId;
      const status = session.status || 'idle';
      const name = this.getSessionName(session);
      const taskStats = session.taskStats || { running: 0, total: 0 };
      const hasRunningTasks = taskStats.running > 0;

      html += `
        <div class="session-tab ${isActive ? 'active' : ''}" data-id="${id}" onclick="app.selectSession('${id}')">
          <span class="tab-status ${status}"></span>
          <span class="tab-name">${this.escapeHtml(name)}</span>
          ${hasRunningTasks ? `<span class="tab-badge" onclick="event.stopPropagation(); app.toggleTaskPanel()">${taskStats.running}</span>` : ''}
          <span class="tab-close" onclick="event.stopPropagation(); app.closeSession('${id}')">&times;</span>
        </div>
      `;
    }

    // Add the "+" button
    html += `
      <div class="session-tab new-tab" onclick="app.createNewSession()" title="New Session (Ctrl+N)">
        <span>+</span>
      </div>
    `;

    container.innerHTML = html;
  }

  getSessionName(session) {
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
      if (data.terminalBuffer) {
        this.terminal.write(data.terminalBuffer);
      }

      // Send resize
      const dims = this.fitAddon.proposeDimensions();
      if (dims) {
        fetch(`/api/sessions/${sessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: dims.cols, rows: dims.rows })
        });
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

  async closeSession(sessionId) {
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
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
    } catch (err) {
      this.showToast('Failed to close session', 'error');
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
      const newSessionSelect = document.getElementById('newSessionCase');

      // Build options
      let options = '<option value="testcase">testcase</option>';
      cases.forEach(c => {
        if (c.name !== 'testcase') {
          options += `<option value="${c.name}">${c.name}</option>`;
        }
      });

      select.innerHTML = options;
      newSessionSelect.innerHTML = options;
    } catch (err) {
      console.error('Failed to load cases:', err);
    }
  }

  async quickStart() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting session in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName })
      });
      const data = await res.json();

      if (!data.success) throw new Error(data.error);

      this.activeSessionId = data.sessionId;
      this.loadQuickStartCases();

      // Send resize
      const dims = this.fitAddon.proposeDimensions();
      if (dims) {
        await fetch(`/api/sessions/${data.sessionId}/resize`, {
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

  // ========== New Session ==========

  createNewSession() {
    document.getElementById('newSessionPanel').classList.add('open');
  }

  hideNewSessionPanel() {
    document.getElementById('newSessionPanel').classList.remove('open');
  }

  async createSessionFromPanel() {
    const caseName = document.getElementById('newSessionCase').value;
    const customDir = document.getElementById('newSessionDir').value.trim();

    this.hideNewSessionPanel();

    try {
      if (customDir) {
        // Create session with custom directory
        const createRes = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir: customDir })
        });
        const createData = await createRes.json();
        if (!createData.success) throw new Error(createData.error);

        // Start interactive
        await fetch(`/api/sessions/${createData.session.id}/interactive`, {
          method: 'POST'
        });

        this.selectSession(createData.session.id);
      } else {
        // Use quick-start with case
        const res = await fetch('/api/quick-start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caseName })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        this.selectSession(data.sessionId);
      }
    } catch (err) {
      this.showToast('Failed to create session: ' + err.message, 'error');
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

  // ========== Respawn Panel ==========

  toggleRespawnPanel() {
    const panel = document.getElementById('respawnPanel');
    panel.classList.toggle('open');

    // Show "Enable on Current" button if there's an active session
    const enableOnCurrentBtn = document.getElementById('enableOnCurrentBtn');
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      const session = this.sessions.get(this.activeSessionId);
      // Only show if session is running (has a PID)
      if (session.pid) {
        enableOnCurrentBtn.style.display = '';
      } else {
        enableOnCurrentBtn.style.display = 'none';
      }
    } else {
      enableOnCurrentBtn.style.display = 'none';
    }
  }

  getRespawnConfig() {
    const updatePrompt = document.getElementById('respawnPrompt').value;
    const idleTimeout = parseInt(document.getElementById('respawnIdleTimeout').value) || 5;
    const stepDelay = parseInt(document.getElementById('respawnStepDelay').value) || 1;
    const sendClear = document.getElementById('respawnSendClear').checked;
    const sendInit = document.getElementById('respawnSendInit').checked;
    const durationStr = document.getElementById('respawnDuration').value;
    const durationMinutes = durationStr ? parseInt(durationStr) : null;
    const autoClearEnabled = document.getElementById('autoClearEnabled').checked;
    const autoClearThreshold = parseInt(document.getElementById('autoClearThreshold').value) || 100000;

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

  async startInteractiveWithRespawn() {
    this.toggleRespawnPanel();

    const dir = document.getElementById('dirInput').value.trim();
    const { respawnConfig, durationMinutes, autoClearEnabled, autoClearThreshold } = this.getRespawnConfig();

    this.terminal.clear();
    this.terminal.writeln('\x1b[1;32m Starting session with respawn...\x1b[0m');
    if (durationMinutes) {
      this.terminal.writeln(`\x1b[90m Duration: ${durationMinutes} minutes\x1b[0m`);
    }
    this.terminal.writeln('');

    try {
      // Create session
      const createRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: dir || undefined })
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error);

      const sessionId = createData.session.id;
      this.activeSessionId = sessionId;

      // Start interactive with respawn
      await fetch(`/api/sessions/${sessionId}/interactive-respawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ respawnConfig, durationMinutes })
      });

      // Set auto-clear if enabled
      if (autoClearEnabled) {
        await fetch(`/api/sessions/${sessionId}/auto-clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, threshold: autoClearThreshold })
        });
      }

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

  async enableRespawnOnCurrent() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'warning');
      return;
    }

    this.toggleRespawnPanel();

    const { respawnConfig, durationMinutes, autoClearEnabled, autoClearThreshold } = this.getRespawnConfig();

    try {
      // Enable respawn on existing session
      const res = await fetch(`/api/sessions/${this.activeSessionId}/respawn/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: respawnConfig, durationMinutes })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Set auto-clear if enabled
      if (autoClearEnabled) {
        await fetch(`/api/sessions/${this.activeSessionId}/auto-clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, threshold: autoClearThreshold })
        });
      }

      this.showToast('Respawn enabled on current session', 'success');
      this.terminal.focus();
    } catch (err) {
      this.showToast('Failed to enable respawn: ' + err.message, 'error');
    }
  }

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

  // ========== Cost ==========

  updateCost() {
    let cost = this.totalCost;
    this.sessions.forEach(s => cost = Math.max(cost, s.totalCost || 0));
    document.getElementById('headerCost').textContent = `$${cost.toFixed(2)}`;
  }

  // ========== Help Modal ==========

  showHelp() {
    document.getElementById('helpModal').classList.add('active');
  }

  closeHelp() {
    document.getElementById('helpModal').classList.remove('active');
  }

  closeAllPanels() {
    document.getElementById('respawnPanel').classList.remove('open');
    document.getElementById('newSessionPanel').classList.remove('open');
    document.getElementById('taskPanel').classList.remove('open');
  }

  // ========== Task Panel ==========

  toggleTaskPanel() {
    const panel = document.getElementById('taskPanel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      this.renderTaskPanel();
    }
  }

  renderTaskPanel() {
    const session = this.sessions.get(this.activeSessionId);
    const body = document.getElementById('taskPanelBody');
    const stats = document.getElementById('taskPanelStats');

    if (!session || !session.taskTree || session.taskTree.length === 0) {
      body.innerHTML = '<div class="task-empty">No background tasks</div>';
      stats.textContent = '0 tasks';
      return;
    }

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
