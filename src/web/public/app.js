// Claudeman App with xterm.js terminal
class ClaudemanApp {
  constructor() {
    this.sessions = new Map();
    this.cases = [];
    this.currentRun = null;
    this.totalCost = 0;
    this.totalTasks = 0;
    this.eventSource = null;
    this.sessionsCollapsed = true;
    this.settings = this.loadSettings();
    this.terminal = null;
    this.fitAddon = null;
    this.activeSessionId = null;  // Currently active interactive session
    this.respawnStatus = {};      // Respawn status per session
    this.respawnEnabled = true;   // Whether respawn is enabled for new sessions

    this.init();
  }

  init() {
    this.initTerminal();
    this.connectSSE();
    this.loadState();
    this.loadCases();
    this.startTimerUpdates();
    this.setupEventListeners();

    // Start with sessions collapsed
    document.getElementById('sessionsPanel').classList.add('collapsed');
  }

  initTerminal() {
    // Initialize xterm.js
    this.terminal = new Terminal({
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        cursorAccent: '#1a1a2e',
        selection: 'rgba(255, 255, 255, 0.3)',
        black: '#1a1a2e',
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
      fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, "Andale Mono", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.3,
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
    this.terminal.writeln('\x1b[1;36m╔═══════════════════════════════════════════════════════════╗');
    this.terminal.writeln('║           \x1b[1;33m⚡ Claudeman Terminal \x1b[1;36m                          ║');
    this.terminal.writeln('║           \x1b[0;90mRun prompts to see output here\x1b[1;36m                  ║');
    this.terminal.writeln('╚═══════════════════════════════════════════════════════════╝\x1b[0m');
    this.terminal.writeln('');

    // Handle resize
    window.addEventListener('resize', () => {
      if (this.fitAddon) {
        this.fitAddon.fit();
      }
    });

    // Resize observer for container changes
    const resizeObserver = new ResizeObserver(() => {
      if (this.fitAddon) {
        this.fitAddon.fit();
        // Notify server of resize
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

    // Handle keyboard input - send to active session
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

  setupEventListeners() {
    // Duration select
    document.getElementById('durationSelect').addEventListener('change', (e) => {
      const customGroup = document.getElementById('customDurationGroup');
      customGroup.style.display = e.target.value === 'custom' ? 'block' : 'none';
    });
  }

  // Settings
  loadSettings() {
    try {
      return JSON.parse(localStorage.getItem('claudeman-settings') || '{}');
    } catch {
      return {};
    }
  }

  saveSettings() {
    this.settings = {
      defaultDir: document.getElementById('defaultDirInput').value,
      autoScroll: document.getElementById('autoScrollOutput').checked,
      soundOnComplete: document.getElementById('soundOnComplete').checked,
    };
    localStorage.setItem('claudeman-settings', JSON.stringify(this.settings));
    alert('Settings saved!');
  }

  // Tabs
  switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'cases') {
      this.loadCases();
    }
  }

  // SSE Connection
  connectSSE() {
    this.eventSource = new EventSource('/api/events');

    this.eventSource.onopen = () => {
      this.setConnectionStatus('connected');
    };

    this.eventSource.onerror = () => {
      this.setConnectionStatus('disconnected');
      setTimeout(() => this.connectSSE(), 3000);
    };

    this.eventSource.addEventListener('init', (e) => {
      const data = JSON.parse(e.data);
      this.handleInit(data);
    });

    this.eventSource.addEventListener('session:created', (e) => {
      const data = JSON.parse(e.data);
      this.sessions.set(data.id, data);
      this.renderSessions();
      this.terminal.writeln(`\x1b[1;32m► Session created: ${data.id.slice(0, 8)}\x1b[0m`);
    });

    this.eventSource.addEventListener('session:updated', (e) => {
      const data = JSON.parse(e.data);
      this.sessions.set(data.id, data);
      this.updateStats();
      this.renderSessions();
    });

    // Handle raw terminal data from PTY
    this.eventSource.addEventListener('session:terminal', (e) => {
      const data = JSON.parse(e.data);
      this.terminal.write(data.data);
    });

    this.eventSource.addEventListener('session:output', (e) => {
      const data = JSON.parse(e.data);
      // Terminal data is handled by session:terminal, so skip duplicate writes
      this.updateSessionOutput(data.id, data.data);
    });

    this.eventSource.addEventListener('session:message', (e) => {
      // JSON messages - we can show these differently if needed
    });

    this.eventSource.addEventListener('session:completion', (e) => {
      const data = JSON.parse(e.data);
      this.totalCost += data.cost || 0;
      this.totalTasks++;
      this.terminal.writeln('');
      this.terminal.writeln(`\x1b[1;32m✓ Completed (Cost: $${(data.cost || 0).toFixed(4)})\x1b[0m`);
      this.updateStats();
      this.setRunning(false);

      if (this.settings.soundOnComplete) {
        this.playSound();
      }
    });

    this.eventSource.addEventListener('session:error', (e) => {
      const data = JSON.parse(e.data);
      this.terminal.writeln(`\x1b[1;31m❌ Error: ${data.error}\x1b[0m`);
    });

    this.eventSource.addEventListener('session:exit', (e) => {
      const data = JSON.parse(e.data);
      this.terminal.writeln('');
      this.terminal.writeln(`\x1b[90m[Session ${data.id.slice(0, 8)} exited with code ${data.code}]\x1b[0m`);
    });

    this.eventSource.addEventListener('scheduled:created', (e) => {
      const data = JSON.parse(e.data);
      this.currentRun = data;
      this.showTimer();
    });

    this.eventSource.addEventListener('scheduled:updated', (e) => {
      const data = JSON.parse(e.data);
      this.currentRun = data;
      this.updateTimer();
    });

    this.eventSource.addEventListener('scheduled:completed', (e) => {
      const data = JSON.parse(e.data);
      this.currentRun = data;
      this.hideTimer();
      this.terminal.writeln('');
      this.terminal.writeln(`\x1b[1;33m🎉 Scheduled run completed! Tasks: ${data.completedTasks}, Cost: $${data.totalCost.toFixed(4)}\x1b[0m`);
      this.setRunning(false);

      if (this.settings.soundOnComplete) {
        this.playSound();
      }
    });

    this.eventSource.addEventListener('scheduled:stopped', (e) => {
      const data = JSON.parse(e.data);
      this.currentRun = data;
      this.hideTimer();
      this.terminal.writeln('');
      this.terminal.writeln('\x1b[1;33m⏹ Scheduled run stopped.\x1b[0m');
      this.setRunning(false);
    });

    this.eventSource.addEventListener('scheduled:log', (e) => {
      const data = JSON.parse(e.data);
      this.terminal.writeln(`\x1b[90m${data.log}\x1b[0m`);
    });

    this.eventSource.addEventListener('case:created', (e) => {
      this.loadCases();
    });

    // Respawn events
    this.eventSource.addEventListener('respawn:started', (e) => {
      const data = JSON.parse(e.data);
      this.respawnStatus[data.sessionId] = data.status;
      this.showRespawnBanner();
      this.terminal.writeln(`\x1b[1;32m🔄 Respawn loop started for session ${data.sessionId.slice(0, 8)}\x1b[0m`);
    });

    this.eventSource.addEventListener('respawn:stopped', (e) => {
      const data = JSON.parse(e.data);
      delete this.respawnStatus[data.sessionId];
      this.hideRespawnBanner();
      this.terminal.writeln(`\x1b[1;33m⏹ Respawn loop stopped\x1b[0m`);
    });

    this.eventSource.addEventListener('respawn:stateChanged', (e) => {
      const data = JSON.parse(e.data);
      if (this.respawnStatus[data.sessionId]) {
        this.respawnStatus[data.sessionId].state = data.state;
      }
      this.updateRespawnBanner(data.state);
    });

    this.eventSource.addEventListener('respawn:cycleStarted', (e) => {
      const data = JSON.parse(e.data);
      if (this.respawnStatus[data.sessionId]) {
        this.respawnStatus[data.sessionId].cycleCount = data.cycleNumber;
      }
      document.getElementById('respawnCycleCount').textContent = data.cycleNumber;
      this.terminal.writeln(`\x1b[1;36m─── Respawn Cycle #${data.cycleNumber} Started ───\x1b[0m`);
    });

    this.eventSource.addEventListener('respawn:cycleCompleted', (e) => {
      const data = JSON.parse(e.data);
      this.terminal.writeln(`\x1b[1;32m✓ Respawn Cycle #${data.cycleNumber} Completed\x1b[0m`);
    });

    this.eventSource.addEventListener('respawn:stepSent', (e) => {
      const data = JSON.parse(e.data);
      document.getElementById('respawnStep').textContent = `Sending: ${data.input}`;
    });

    this.eventSource.addEventListener('respawn:stepCompleted', (e) => {
      const data = JSON.parse(e.data);
      document.getElementById('respawnStep').textContent = `Completed: ${data.step}`;
    });

    this.eventSource.addEventListener('respawn:log', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Respawn]', data.message);
    });

    this.eventSource.addEventListener('respawn:error', (e) => {
      const data = JSON.parse(e.data);
      this.terminal.writeln(`\x1b[1;31m❌ Respawn error: ${data.error}\x1b[0m`);
    });
  }

  playSound() {
    try {
      const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdH2JkJOQjIJ5cGlpcXuFjpWYl5KKgHZsZWdveYSNlZmYk4yBdmtlZmt1gIqSlpeUjoV7cWlnbHV/iZGWl5SSiYB2bGdqcHqEjJOWlZGMhHpwa2ducHmEjJOUk5CMhHpwa2dqb3eFjJOUk4+LgnhvamdscHqEjJKTko6KgXdtaGltdH6HjpKTkY2Jf3Zsa2twd4GIjpKSkI2Jf3ZsamttdH2GjZGSkI2Jf3VramttdX2GjJCRj4yIf3VramtudX6GjJCQjo2If3VraWttdn6FjI+Pjo2If3VraWptdn+FjI+PjoyHfnRqaWptdn6Fi4+PjoyHfnRqaGlsdn6Fi46OjYyHfnRpZ2lsdX2FjI6OjYuHfXNpZ2lrdX2EjI2OjYuGfXNpZmlrdX2EjI2NjIuGfXNoZmlrdXyEi42NjIqGfHNnZWhqdHyDi4yMi4qFfHJnZWhpdHyDioyMi4qFfHJnZGdpdHuDiouLioqEe3FmZGdocnuCiYuLioqEe3FmZGZocnuCiYqKiYmDenBmZGZncnqBiIqJiYiDenBmY2ZncnqBiImIiIiDenBlY2VncXqAh4iIiIiCeW9lY2VmcXmAh4eHh4eCeW9kYmVmcHl/hoaGhoeBd25kYmRlcHh+hYWFhYaBd21jYWRlb3d9hYSEhYWAdmxiYWNkbnd8hIODhISAdjxhYWNkbXZ7g4KCg4N/dWtgYGJja3V6goGBgoJ+dGpfX2FiaXR5gYCAf4F9c2leX2BhZ3N4gH9/f4B8cmhcXV9fZnJ3f318fX57cGdcXF5eZXF1fXt7e3x6b2ZbW11dZG9zent6eXp5bWRaW1xbY25yfHl4eXh4a2JZWltaYWxxeXd2d3Z2aF9XWVlYX2xvdXR0dHRzZVxVV1dWXmpsdHJxcnFwYllUVVRUW2dqdnBvcHBuXldSU1JSWmVodW5tbm1sWlNQUU9PV2Nlc2xramxpV1FOUFE=');
      audio.volume = 0.3;
      audio.play();
    } catch {}
  }

  setConnectionStatus(status) {
    const el = document.getElementById('connectionStatus');
    const dot = el.querySelector('.status-dot');
    const text = el.querySelector('span:last-child');

    dot.className = 'status-dot ' + status;
    text.textContent = status === 'connected' ? 'Connected' : 'Disconnected';
  }

  handleInit(data) {
    this.sessions.clear();
    data.sessions.forEach(s => this.sessions.set(s.id, s));

    const activeRun = data.scheduledRuns.find(r => r.status === 'running');
    if (activeRun) {
      this.currentRun = activeRun;
      this.showTimer();
    }

    // Load respawn status
    if (data.respawnStatus) {
      this.respawnStatus = data.respawnStatus;
      // Show respawn banner if any session has active respawn
      const hasActiveRespawn = Object.values(this.respawnStatus).some(s => s.state !== 'stopped');
      if (hasActiveRespawn) {
        this.showRespawnBanner();
        const activeStatus = Object.values(this.respawnStatus).find(s => s.state !== 'stopped');
        if (activeStatus) {
          this.updateRespawnBanner(activeStatus.state);
          document.getElementById('respawnCycleCount').textContent = activeStatus.cycleCount || 0;
        }
      }
    }

    this.totalCost = data.sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
    this.totalCost += data.scheduledRuns.reduce((sum, r) => sum + (r.totalCost || 0), 0);
    this.totalTasks = data.scheduledRuns.reduce((sum, r) => sum + (r.completedTasks || 0), 0);

    this.updateStats();
    this.renderSessions();
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

  // Cases
  async loadCases() {
    try {
      const res = await fetch('/api/cases');
      this.cases = await res.json();
      this.renderCases();
    } catch (err) {
      console.error('Failed to load cases:', err);
    }
  }

  renderCases() {
    const list = document.getElementById('casesList');

    if (this.cases.length === 0) {
      list.innerHTML = '<p class="empty-state">No cases yet. Create one to get started.</p>';
      return;
    }

    list.innerHTML = this.cases.map(c => `
      <div class="case-card" onclick="app.useCase('${c.path}')">
        <span class="case-icon">📁</span>
        <div class="case-info">
          <div class="case-name">${this.escapeHtml(c.name)}</div>
          <div class="case-path">${this.escapeHtml(c.path)}</div>
        </div>
      </div>
    `).join('');
  }

  useCase(path) {
    document.getElementById('dirInput').value = path;
    this.switchTab('run');
  }

  showCreateCase() {
    document.getElementById('createCaseForm').style.display = 'block';
    document.getElementById('caseNameInput').focus();
  }

  hideCreateCase() {
    document.getElementById('createCaseForm').style.display = 'none';
    document.getElementById('caseNameInput').value = '';
    document.getElementById('caseDescInput').value = '';
  }

  async createCase() {
    const name = document.getElementById('caseNameInput').value.trim();
    const description = document.getElementById('caseDescInput').value.trim();

    if (!name) {
      alert('Please enter a case name');
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
        this.hideCreateCase();
        this.loadCases();
        alert(`Case "${name}" created!`);
      } else {
        alert('Error: ' + data.error);
      }
    } catch (err) {
      alert('Error creating case: ' + err.message);
    }
  }

  selectCase() {
    this.loadCases().then(() => {
      const grid = document.getElementById('caseSelectorGrid');

      if (this.cases.length === 0) {
        grid.innerHTML = '<p class="empty-state">No cases. Create one in the Cases tab.</p>';
      } else {
        grid.innerHTML = this.cases.map(c => `
          <div class="case-card" onclick="app.selectCaseAndClose('${c.path}')">
            <span class="case-icon">📁</span>
            <div class="case-info">
              <div class="case-name">${this.escapeHtml(c.name)}</div>
            </div>
          </div>
        `).join('');
      }

      document.getElementById('caseSelectorModal').classList.add('active');
    });
  }

  selectCaseAndClose(path) {
    document.getElementById('dirInput').value = path;
    this.closeCaseSelector();
  }

  closeCaseSelector() {
    document.getElementById('caseSelectorModal').classList.remove('active');
  }

  // Actions
  async startRun() {
    const prompt = document.getElementById('promptInput').value.trim();
    const dir = document.getElementById('dirInput').value.trim();
    const durationSelect = document.getElementById('durationSelect').value;

    let duration = 0;
    if (durationSelect === 'custom') {
      duration = parseInt(document.getElementById('customDuration').value) || 0;
    } else {
      duration = parseInt(durationSelect) || 0;
    }

    if (!prompt) {
      alert('Please enter a prompt');
      return;
    }

    this.setRunning(true);
    this.terminal.writeln('');
    this.terminal.writeln(`\x1b[1;36m─── Starting: ${prompt.substring(0, 60)}${prompt.length > 60 ? '...' : ''} ───\x1b[0m`);
    this.terminal.writeln('');

    try {
      if (duration > 0) {
        const res = await fetch('/api/scheduled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            workingDir: dir || undefined,
            durationMinutes: duration
          })
        });
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error);
        }
      } else {
        const res = await fetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            workingDir: dir || undefined
          })
        });
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error);
        }
      }
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m❌ Error: ${err.message}\x1b[0m`);
      this.setRunning(false);
    }
  }

  // Start an interactive Claude Code session
  async startInteractive() {
    const dir = document.getElementById('dirInput').value.trim();
    const respawnEnabled = document.getElementById('respawnEnabled').checked;

    this.terminal.clear();
    this.terminal.writeln('\x1b[1;36m─── Starting Interactive Claude Code Session ───\x1b[0m');
    if (respawnEnabled) {
      this.terminal.writeln('\x1b[90mRespawn loop enabled. Claude will auto-restart when idle.\x1b[0m');
    } else {
      this.terminal.writeln('\x1b[90mType your prompts directly. Session persists even if you close the browser.\x1b[0m');
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
      if (!createData.success) {
        throw new Error(createData.error);
      }

      const sessionId = createData.session.id;
      this.activeSessionId = sessionId;

      // Get respawn config from UI
      const respawnConfig = respawnEnabled ? {
        enabled: true,
        updatePrompt: document.getElementById('respawnPrompt').value || 'update all the docs and CLAUDE.md',
        idleTimeoutMs: (parseInt(document.getElementById('respawnIdleTimeout').value) || 5) * 1000,
        interStepDelayMs: (parseInt(document.getElementById('respawnStepDelay').value) || 1) * 1000,
      } : null;

      // Start interactive mode with respawn
      let interactiveRes;
      if (respawnConfig) {
        interactiveRes = await fetch(`/api/sessions/${sessionId}/interactive-respawn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ respawnConfig })
        });
      } else {
        interactiveRes = await fetch(`/api/sessions/${sessionId}/interactive`, {
          method: 'POST'
        });
      }

      const interactiveData = await interactiveRes.json();
      if (!interactiveData.success) {
        throw new Error(interactiveData.error);
      }

      this.terminal.writeln(`\x1b[1;32m► Connected to session ${sessionId.slice(0, 8)}\x1b[0m`);
      if (respawnConfig) {
        this.terminal.writeln(`\x1b[90m  Respawn: ${respawnConfig.updatePrompt.substring(0, 40)}...\x1b[0m`);
      }
      this.terminal.writeln('');

      // Send initial resize
      const dims = this.fitAddon.proposeDimensions();
      if (dims) {
        await fetch(`/api/sessions/${sessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: dims.cols, rows: dims.rows })
        });
      }

      // Focus the terminal
      this.terminal.focus();

    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m❌ Error: ${err.message}\x1b[0m`);
      this.activeSessionId = null;
    }
  }

  // Respawn controls
  toggleRespawnDetails() {
    const details = document.getElementById('respawnDetails');
    details.style.display = details.style.display === 'none' ? 'block' : 'none';
  }

  showRespawnBanner() {
    document.getElementById('respawnBanner').style.display = 'flex';
  }

  hideRespawnBanner() {
    document.getElementById('respawnBanner').style.display = 'none';
  }

  updateRespawnBanner(state) {
    const stateEl = document.getElementById('respawnState');
    stateEl.textContent = state.replace(/_/g, ' ');

    // Update indicator animation based on state
    const indicator = document.querySelector('.respawn-indicator');
    if (state === 'watching') {
      indicator.style.animationPlayState = 'paused';
    } else {
      indicator.style.animationPlayState = 'running';
    }
  }

  async toggleRespawn() {
    if (!this.activeSessionId) return;

    const status = this.respawnStatus[this.activeSessionId];
    if (!status) return;

    // TODO: Add pause/resume endpoints if needed
    this.terminal.writeln('\x1b[90mRespawn toggle not yet implemented\x1b[0m');
  }

  async stopRespawn() {
    if (!this.activeSessionId) return;

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/respawn/stop`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to stop respawn');
      }
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m❌ Error stopping respawn: ${err.message}\x1b[0m`);
    }
  }

  async startRespawnForSession(sessionId) {
    const respawnConfig = {
      enabled: true,
      updatePrompt: document.getElementById('respawnPrompt').value || 'update all the docs and CLAUDE.md',
      idleTimeoutMs: (parseInt(document.getElementById('respawnIdleTimeout').value) || 5) * 1000,
      interStepDelayMs: (parseInt(document.getElementById('respawnStepDelay').value) || 1) * 1000,
    };

    try {
      const res = await fetch(`/api/sessions/${sessionId}/respawn/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(respawnConfig)
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to start respawn');
      }
      this.terminal.writeln(`\x1b[1;32m🔄 Respawn started for session ${sessionId.slice(0, 8)}\x1b[0m`);
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m❌ Error starting respawn: ${err.message}\x1b[0m`);
    }
  }

  async stopCurrentRun() {
    if (!this.currentRun) return;

    try {
      await fetch(`/api/scheduled/${this.currentRun.id}`, {
        method: 'DELETE'
      });
    } catch (err) {
      alert('Error stopping run: ' + err.message);
    }
  }

  setRunning(running) {
    const btn = document.getElementById('runBtn');
    if (running) {
      btn.disabled = true;
      btn.innerHTML = '<span class="loading"></span> Running...';
    } else {
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon">▶</span> Run';
    }
  }

  // Terminal
  clearTerminal() {
    this.terminal.clear();
    this.terminal.writeln('\x1b[90mTerminal cleared\x1b[0m');
  }

  // Timer
  showTimer() {
    document.getElementById('timerBanner').style.display = 'block';
    this.updateTimer();
  }

  hideTimer() {
    document.getElementById('timerBanner').style.display = 'none';
    this.currentRun = null;
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
    document.getElementById('timerTasks').textContent = `${this.currentRun.completedTasks} tasks completed`;
    document.getElementById('timerCost').textContent = `$${this.currentRun.totalCost.toFixed(4)}`;
  }

  startTimerUpdates() {
    setInterval(() => this.updateTimer(), 1000);
  }

  formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  // Stats
  updateStats() {
    document.getElementById('statCost').textContent = `$${this.totalCost.toFixed(2)}`;
    document.getElementById('statTasks').textContent = this.totalTasks;
  }

  // Sessions
  toggleSessions() {
    const panel = document.getElementById('sessionsPanel');
    panel.classList.toggle('collapsed');
    this.sessionsCollapsed = panel.classList.contains('collapsed');
  }

  renderSessions() {
    const count = this.sessions.size;
    document.getElementById('sessionCount').textContent = count;

    const list = document.getElementById('sessionsList');

    if (count === 0) {
      list.innerHTML = '<div style="padding: 1rem; color: var(--text-muted);">No active sessions</div>';
      return;
    }

    list.innerHTML = Array.from(this.sessions.values()).map(s => {
      const respawn = this.respawnStatus[s.id];
      const respawnHtml = respawn ? `
        <div class="session-respawn">
          <span class="session-respawn-dot ${respawn.state === 'stopped' ? 'stopped' : ''}"></span>
          <span class="session-respawn-state">${respawn.state.replace(/_/g, ' ')}</span>
          <span class="session-respawn-actions">
            <button class="btn btn-sm" onclick="app.stopRespawnForSession('${s.id}')">Stop</button>
          </span>
        </div>
      ` : `
        <div class="session-respawn">
          <span class="session-respawn-dot stopped"></span>
          <span class="session-respawn-state">No respawn</span>
          <span class="session-respawn-actions">
            <button class="btn btn-sm" onclick="app.startRespawnForSession('${s.id}')">Start</button>
          </span>
        </div>
      `;

      return `
        <div class="session-card" data-session="${s.id}">
          <div class="session-card-header">
            <div class="session-status">
              <span class="session-status-dot ${s.status}"></span>
              <span>${s.id.slice(0, 8)}</span>
            </div>
            <span class="session-cost">$${(s.totalCost || 0).toFixed(4)}</span>
          </div>
          ${respawnHtml}
        </div>
      `;
    }).join('');
  }

  async stopRespawnForSession(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/respawn/stop`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to stop respawn');
      }
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m❌ Error stopping respawn: ${err.message}\x1b[0m`);
    }
  }

  updateSessionOutput(sessionId, text) {
    // Sessions list shows brief info, main terminal shows full output
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize
const app = new ClaudemanApp();
