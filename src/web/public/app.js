// Claudeman App
class ClaudemanApp {
  constructor() {
    this.sessions = new Map();
    this.currentRun = null;
    this.totalCost = 0;
    this.totalTasks = 0;
    this.eventSource = null;
    this.sessionsCollapsed = true;

    this.init();
  }

  init() {
    this.connectSSE();
    this.loadState();
    this.startTimerUpdates();

    // Start with sessions collapsed
    document.getElementById('sessionsPanel').classList.add('collapsed');
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
    });

    this.eventSource.addEventListener('session:updated', (e) => {
      const data = JSON.parse(e.data);
      this.sessions.set(data.id, data);
      this.updateStats();
      this.renderSessions();
    });

    this.eventSource.addEventListener('session:output', (e) => {
      const data = JSON.parse(e.data);
      this.appendOutput(data.data);
      this.updateSessionOutput(data.id, data.data);
    });

    this.eventSource.addEventListener('session:message', (e) => {
      const data = JSON.parse(e.data);
      const msg = data.message;

      if (msg.type === 'assistant' && msg.message?.content) {
        const text = msg.message.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('');
        if (text) {
          this.appendOutput(text);
        }
      }
    });

    this.eventSource.addEventListener('session:completion', (e) => {
      const data = JSON.parse(e.data);
      this.totalCost += data.cost || 0;
      this.totalTasks++;
      this.appendOutput(`\n\n✓ Completed (Cost: $${(data.cost || 0).toFixed(4)})\n`);
      this.updateStats();
      this.setRunning(false);
    });

    this.eventSource.addEventListener('session:error', (e) => {
      const data = JSON.parse(e.data);
      this.appendOutput(`\n❌ Error: ${data.error}\n`, 'error');
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
      this.appendOutput(`\n\n🎉 Scheduled run completed! Tasks: ${data.completedTasks}, Cost: $${data.totalCost.toFixed(4)}\n`);
    });

    this.eventSource.addEventListener('scheduled:stopped', (e) => {
      const data = JSON.parse(e.data);
      this.currentRun = data;
      this.hideTimer();
      this.appendOutput(`\n\n⏹ Scheduled run stopped.\n`);
    });

    this.eventSource.addEventListener('scheduled:log', (e) => {
      const data = JSON.parse(e.data);
      this.appendOutput(`\n${data.log}`);
    });
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

    // Check for active scheduled run
    const activeRun = data.scheduledRuns.find(r => r.status === 'running');
    if (activeRun) {
      this.currentRun = activeRun;
      this.showTimer();
    }

    // Calculate totals
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

  // Actions
  async startRun() {
    const prompt = document.getElementById('promptInput').value.trim();
    const dir = document.getElementById('dirInput').value.trim();
    const duration = parseInt(document.getElementById('durationInput').value) || 0;

    if (!prompt) {
      alert('Please enter a prompt');
      return;
    }

    this.setRunning(true);
    this.clearOutput();
    this.appendOutput('Starting...\n\n');

    try {
      if (duration > 0) {
        // Scheduled run with timer
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
        // Single run
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
      this.appendOutput(`❌ Error: ${err.message}\n`, 'error');
      this.setRunning(false);
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

  // Output
  appendOutput(text, type = '') {
    const container = document.getElementById('outputContainer');

    // Remove placeholder if present
    const placeholder = container.querySelector('.output-placeholder');
    if (placeholder) {
      container.innerHTML = '';
    }

    const span = document.createElement('span');
    span.className = type ? `msg-${type}` : '';
    span.textContent = text;
    container.appendChild(span);
    container.scrollTop = container.scrollHeight;
  }

  clearOutput() {
    const container = document.getElementById('outputContainer');
    container.innerHTML = `
      <div class="output-placeholder">
        <div class="placeholder-icon">💬</div>
        <div class="placeholder-text">Run a prompt to see Claude's output here</div>
      </div>
    `;
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

    list.innerHTML = Array.from(this.sessions.values()).map(s => `
      <div class="session-card" data-session="${s.id}">
        <div class="session-card-header">
          <div class="session-status">
            <span class="session-status-dot ${s.status}"></span>
            <span>${s.id.slice(0, 8)}</span>
          </div>
          <span class="session-cost">$${(s.totalCost || 0).toFixed(4)}</span>
        </div>
        <div class="session-output" id="session-output-${s.id}">${this.escapeHtml(s.textOutput || '')}</div>
      </div>
    `).join('');
  }

  updateSessionOutput(sessionId, text) {
    const el = document.getElementById(`session-output-${sessionId}`);
    if (el) {
      el.textContent += text;
      el.scrollTop = el.scrollHeight;
    }
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
