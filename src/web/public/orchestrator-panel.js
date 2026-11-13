/**
 * @fileoverview Orchestrator loop panel — plan-based autonomous execution UI.
 * Shows orchestrator state, plan phases, task progress, and verification results.
 * Provides controls for start, approve, reject, pause, resume, stop, skip, retry.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.orchestratorState)
 * @dependency constants.js (SSE_EVENTS, escapeHtml)
 * @loadorder 9.5 of 16 — loaded after ralph-panel.js, before settings-ui.js
 */

// ═══════════════════════════════════════════════════════════════
// State color/label mappings
// ═══════════════════════════════════════════════════════════════

const ORCH_STATE_COLORS = {
  idle: '#6b7280',
  planning: '#f59e0b',
  approval: '#8b5cf6',
  executing: '#3b82f6',
  verifying: '#06b6d4',
  replanning: '#f97316',
  completed: '#22c55e',
  failed: '#ef4444',
  paused: '#9ca3af',
};

const ORCH_PHASE_STATUS_ICONS = {
  pending: '\u25cb',    // ○
  executing: '\u25d4',  // ◔
  passed: '\u2713',     // ✓
  failed: '\u2717',     // ✗
  skipped: '\u2192',    // →
};

Object.assign(CodemanApp.prototype, {

  // ═══════════════════════════════════════════════════════════════
  // SSE Event Handlers
  // ═══════════════════════════════════════════════════════════════

  _onOrchestratorStateChanged(data) {
    if (!this.orchestratorState) this.orchestratorState = {};
    this.orchestratorState.state = data.state;
    if (data.state === 'planning') {
      this.orchestratorState.planProgress = [];
      this.showOrchestratorPanel();
    }
    this.renderOrchestratorPanel();
  },

  _onOrchestratorPlanProgress(data) {
    if (!this.orchestratorState) this.orchestratorState = {};
    if (!this.orchestratorState.planProgress) this.orchestratorState.planProgress = [];
    this.orchestratorState.planProgress.push({ phase: data.phase, detail: data.detail, time: Date.now() });
    this.renderOrchestratorPanel();
  },

  _onOrchestratorPlanReady(data) {
    if (!this.orchestratorState) this.orchestratorState = {};
    this.orchestratorState.plan = data.plan;
    this.orchestratorState.state = 'approval';
    this.showOrchestratorPanel();
    this.renderOrchestratorPanel();
  },

  _onOrchestratorPhaseStarted(data) {
    if (!this.orchestratorState) return;
    this._updateOrchestratorPhase(data.phase);
    this.renderOrchestratorPanel();
  },

  _onOrchestratorPhaseCompleted(data) {
    if (!this.orchestratorState) return;
    this._updateOrchestratorPhase(data.phase);
    this.renderOrchestratorPanel();
  },

  _onOrchestratorPhaseFailed(data) {
    if (!this.orchestratorState) return;
    this._updateOrchestratorPhase(data.phase);
    this.renderOrchestratorPanel();
  },

  _onOrchestratorVerification(data) {
    if (!this.orchestratorState) return;
    // Store verification result on the phase
    if (this.orchestratorState.plan) {
      const phase = this.orchestratorState.plan.phases.find(p => p.id === data.phaseId);
      if (phase) phase._lastVerification = data.result;
    }
    this.renderOrchestratorPanel();
  },

  _onOrchestratorTaskAssigned(data) {
    if (!this.orchestratorState) return;
    this._updateOrchestratorTask(data.task);
    this.renderOrchestratorPanel();
  },

  _onOrchestratorTaskCompleted(data) {
    if (!this.orchestratorState) return;
    this._updateOrchestratorTask(data.task);
    this.renderOrchestratorPanel();
  },

  _onOrchestratorTaskFailed(data) {
    if (!this.orchestratorState) return;
    this._updateOrchestratorTask(data.task);
    this.renderOrchestratorPanel();
  },

  _onOrchestratorCompleted(data) {
    if (!this.orchestratorState) this.orchestratorState = {};
    this.orchestratorState.state = 'completed';
    this.orchestratorState.stats = data.stats;
    this.renderOrchestratorPanel();
  },

  _onOrchestratorError(data) {
    if (!this.orchestratorState) this.orchestratorState = {};
    this.orchestratorState.state = 'failed';
    this.orchestratorState.lastError = data.error;
    this.renderOrchestratorPanel();
  },

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════

  _updateOrchestratorPhase(updatedPhase) {
    if (!this.orchestratorState?.plan) return;
    const idx = this.orchestratorState.plan.phases.findIndex(p => p.id === updatedPhase.id);
    if (idx >= 0) this.orchestratorState.plan.phases[idx] = updatedPhase;
  },

  _updateOrchestratorTask(updatedTask) {
    if (!this.orchestratorState?.plan) return;
    for (const phase of this.orchestratorState.plan.phases) {
      const idx = phase.tasks.findIndex(t => t.id === updatedTask.id);
      if (idx >= 0) {
        phase.tasks[idx] = updatedTask;
        return;
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Panel visibility
  // ═══════════════════════════════════════════════════════════════

  showOrchestratorPanel() {
    this.orchestratorPanelVisible = true;
    const panel = document.getElementById('orchestratorPanel');
    if (panel) panel.style.display = '';
    this.renderOrchestratorPanel();
  },

  closeOrchestratorPanel() {
    this.orchestratorPanelVisible = false;
    const panel = document.getElementById('orchestratorPanel');
    if (panel) panel.style.display = 'none';
  },

  toggleOrchestratorPanel() {
    if (this.orchestratorPanelVisible) {
      this.closeOrchestratorPanel();
    } else {
      this.showOrchestratorPanel();
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // API calls
  // ═══════════════════════════════════════════════════════════════

  async orchestratorStart(goal, config) {
    try {
      const res = await fetch('/api/orchestrator/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, config }),
      });
      const data = await res.json();
      if (data.data?.ok) {
        this.orchestratorState = { state: 'planning', plan: null };
        this.showOrchestratorPanel();
        this.renderOrchestratorPanel();
      }
      return data;
    } catch (err) {
      console.error('[Orchestrator] Start failed:', err);
    }
  },

  async orchestratorApprove() {
    try {
      await fetch('/api/orchestrator/approve', { method: 'POST' });
    } catch (err) {
      console.error('[Orchestrator] Approve failed:', err);
    }
  },

  async orchestratorReject(feedback) {
    try {
      await fetch('/api/orchestrator/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      });
    } catch (err) {
      console.error('[Orchestrator] Reject failed:', err);
    }
  },

  async orchestratorPause() {
    try {
      await fetch('/api/orchestrator/pause', { method: 'POST' });
    } catch (err) {
      console.error('[Orchestrator] Pause failed:', err);
    }
  },

  async orchestratorResume() {
    try {
      await fetch('/api/orchestrator/resume', { method: 'POST' });
    } catch (err) {
      console.error('[Orchestrator] Resume failed:', err);
    }
  },

  async orchestratorStop() {
    try {
      await fetch('/api/orchestrator/stop', { method: 'POST' });
      this.orchestratorState = { state: 'idle' };
      this.renderOrchestratorPanel();
    } catch (err) {
      console.error('[Orchestrator] Stop failed:', err);
    }
  },

  async orchestratorSkipPhase(phaseId) {
    try {
      await fetch(`/api/orchestrator/phase/${phaseId}/skip`, { method: 'POST' });
    } catch (err) {
      console.error('[Orchestrator] Skip failed:', err);
    }
  },

  async orchestratorRetryPhase(phaseId) {
    try {
      await fetch(`/api/orchestrator/phase/${phaseId}/retry`, { method: 'POST' });
    } catch (err) {
      console.error('[Orchestrator] Retry failed:', err);
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Rendering
  // ═══════════════════════════════════════════════════════════════

  renderOrchestratorPanel() {
    const panel = document.getElementById('orchestratorPanel');
    if (!panel) return;

    const state = this.orchestratorState?.state || 'idle';
    const plan = this.orchestratorState?.plan;

    // Update badge
    const badge = document.getElementById('orchestratorStateBadge');
    if (badge) {
      badge.textContent = state;
      badge.style.background = ORCH_STATE_COLORS[state] || '#6b7280';
    }

    // Update action buttons
    const actions = document.getElementById('orchestratorActions');
    if (actions) {
      actions.innerHTML = this._renderOrchestratorActions(state);
    }

    // Update body
    const body = document.getElementById('orchestratorBody');
    if (body) {
      body.innerHTML = this._renderOrchestratorBody(state, plan);
    }
  },

  _renderOrchestratorActions(state) {
    const btn = (label, onclick, cls = '') =>
      `<button class="orch-btn ${cls}" onclick="${onclick}">${label}</button>`;

    switch (state) {
      case 'idle':
      case 'completed':
      case 'failed':
        return btn('New Goal', 'app.promptOrchestratorGoal()', 'orch-btn-primary');
      case 'planning':
        return btn('Cancel', 'app.orchestratorStop()', 'orch-btn-danger');
      case 'approval':
        return [
          btn('Approve', 'app.orchestratorApprove()', 'orch-btn-primary'),
          btn('Reject', 'app.promptOrchestratorReject()', 'orch-btn-warn'),
          btn('Cancel', 'app.orchestratorStop()', 'orch-btn-danger'),
        ].join('');
      case 'executing':
      case 'verifying':
      case 'replanning':
        return [
          btn('Pause', 'app.orchestratorPause()'),
          btn('Stop', 'app.orchestratorStop()', 'orch-btn-danger'),
        ].join('');
      case 'paused':
        return [
          btn('Resume', 'app.orchestratorResume()', 'orch-btn-primary'),
          btn('Stop', 'app.orchestratorStop()', 'orch-btn-danger'),
        ].join('');
      default:
        return '';
    }
  },

  _renderOrchestratorBody(state, plan) {
    if (state === 'idle' && !plan) {
      return '<div class="orch-empty">No orchestration active. Click "New Goal" to start.</div>';
    }

    if (state === 'planning') {
      const progress = this.orchestratorState?.planProgress || [];
      let progressHtml = '';
      if (progress.length > 0) {
        const items = progress.map(p =>
          `<div class="orch-progress-item"><span class="orch-progress-phase">${escapeHtml(p.phase)}</span> ${escapeHtml(p.detail)}</div>`
        ).join('');
        progressHtml = `<div class="orch-progress-log">${items}</div>`;
      }
      return `<div class="orch-planning"><div class="orch-spinner"></div>Generating plan...${progressHtml}</div>`;
    }

    if (!plan) return '';

    const parts = [];

    // Goal
    parts.push(`<div class="orch-goal"><strong>Goal:</strong> ${escapeHtml(plan.goal.slice(0, 200))}</div>`);

    // Progress summary
    const completed = plan.phases.filter(p => p.status === 'passed' || p.status === 'skipped').length;
    const total = plan.phases.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    parts.push(`<div class="orch-progress-bar"><div class="orch-progress-fill" style="width:${pct}%"></div><span>${completed}/${total} phases</span></div>`);

    // Phase list
    parts.push('<div class="orch-phases">');
    for (const phase of plan.phases) {
      parts.push(this._renderOrchestratorPhase(phase, state));
    }
    parts.push('</div>');

    // Stats (if completed/failed)
    if (state === 'completed' || state === 'failed') {
      const stats = this.orchestratorState?.stats;
      if (stats) {
        parts.push(this._renderOrchestratorStats(stats));
      }
      if (this.orchestratorState?.lastError) {
        parts.push(`<div class="orch-error">Error: ${escapeHtml(this.orchestratorState.lastError)}</div>`);
      }
    }

    return parts.join('');
  },

  _renderOrchestratorPhase(phase, orchState) {
    const icon = ORCH_PHASE_STATUS_ICONS[phase.status] || '\u25cb';
    const isActive = phase.status === 'executing';
    const cls = `orch-phase ${isActive ? 'orch-phase-active' : ''} orch-phase-${phase.status}`;

    let actions = '';
    if (orchState === 'executing' || orchState === 'failed') {
      if (phase.status === 'pending') {
        actions += `<button class="orch-phase-btn" onclick="app.orchestratorSkipPhase(${escapeHtml(JSON.stringify(phase.id))})" title="Skip">skip</button>`;
      }
      if (phase.status === 'failed') {
        actions += `<button class="orch-phase-btn" onclick="app.orchestratorRetryPhase(${escapeHtml(JSON.stringify(phase.id))})" title="Retry">retry</button>`;
      }
    }

    // Task summary
    const tasksDone = phase.tasks.filter(t => t.status === 'completed').length;
    const tasksFailed = phase.tasks.filter(t => t.status === 'failed').length;
    const tasksTotal = phase.tasks.length;
    const taskSummary = `${tasksDone}/${tasksTotal}${tasksFailed > 0 ? ` (${tasksFailed} failed)` : ''}`;

    // Duration
    let duration = '';
    if (phase.durationMs) {
      const secs = Math.round(phase.durationMs / 1000);
      duration = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    }

    let html = `<div class="${cls}">`;
    html += `<div class="orch-phase-header">`;
    html += `<span class="orch-phase-icon">${icon}</span>`;
    html += `<span class="orch-phase-name">${escapeHtml(phase.name)}</span>`;
    html += `<span class="orch-phase-tasks">${taskSummary}</span>`;
    if (duration) html += `<span class="orch-phase-duration">${duration}</span>`;
    if (actions) html += `<span class="orch-phase-actions">${actions}</span>`;
    html += `</div>`;

    // Expanded task list for active phase
    if (isActive || phase.status === 'failed') {
      html += '<div class="orch-phase-tasks-list">';
      for (const task of phase.tasks) {
        const taskIcon = ORCH_PHASE_STATUS_ICONS[task.status] || '\u25cb';
        const taskCls = `orch-task orch-task-${task.status}`;
        html += `<div class="${taskCls}"><span class="orch-task-icon">${taskIcon}</span>`;
        html += `<span class="orch-task-prompt">${escapeHtml(task.prompt.slice(0, 100))}</span>`;
        if (task.error) html += `<span class="orch-task-error">${escapeHtml(task.error.slice(0, 80))}</span>`;
        html += '</div>';
      }
      html += '</div>';
    }

    // Verification result
    if (phase._lastVerification) {
      const v = phase._lastVerification;
      const vCls = v.passed ? 'orch-verify-pass' : 'orch-verify-fail';
      html += `<div class="${vCls}">${v.passed ? 'Verified' : 'Failed'}: ${escapeHtml(v.summary || '')}</div>`;
    }

    html += '</div>';
    return html;
  },

  _renderOrchestratorStats(stats) {
    return `<div class="orch-stats">
      <span>Phases: ${stats.phasesCompleted} done, ${stats.phasesFailed} failed</span>
      <span>Tasks: ${stats.totalTasksCompleted} done, ${stats.totalTasksFailed} failed</span>
      ${stats.replanCount > 0 ? `<span>Replans: ${stats.replanCount}</span>` : ''}
      ${stats.totalDurationMs ? `<span>Duration: ${Math.round(stats.totalDurationMs / 60000)}m</span>` : ''}
    </div>`;
  },

  // ═══════════════════════════════════════════════════════════════
  // User prompts
  // ═══════════════════════════════════════════════════════════════

  promptOrchestratorGoal() {
    const goal = prompt('Enter your goal for the orchestrator:');
    if (goal && goal.trim()) {
      this.orchestratorStart(goal.trim());
    }
  },

  promptOrchestratorReject() {
    const feedback = prompt('Feedback on the plan (what should change?):');
    if (feedback && feedback.trim()) {
      this.orchestratorReject(feedback.trim());
    }
  },
});
