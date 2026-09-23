/**
 * @fileoverview Ralph state panel (progress ring, status, task cards, fix_plan.md integration),
 * plan versioning (checkpoint, rollback, diff), and plan wizard agents in monitor.
 * Includes 11 SSE handlers for Ralph and plan events.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.ralphStates, this.activeSessionId)
 * @dependency constants.js (escapeHtml)
 * @loadorder 9 of 15 — loaded after respawn-ui.js, before settings-ui.js
 */

Object.assign(CodemanApp.prototype, {
  // Ralph
  _onRalphLoopUpdate(data) {
    // Skip if user explicitly closed this session's Ralph panel
    if (this.ralphClosedSessions.has(data.sessionId)) return;
    this.updateRalphState(data.sessionId, { loop: data.state });
  },

  _onRalphTodoUpdate(data) {
    // Skip if user explicitly closed this session's Ralph panel
    if (this.ralphClosedSessions.has(data.sessionId)) return;
    this.updateRalphState(data.sessionId, { todos: data.todos });
  },

  _onRalphCompletionDetected(data) {
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

    this._notifySession(data.sessionId, 'warning', 'ralph-complete', 'Loop Complete', `Completion: ${data.phrase || 'unknown'}`);
  },

  _onRalphStatusUpdate(data) {
    // Skip if user explicitly closed this session's Ralph panel
    if (this.ralphClosedSessions.has(data.sessionId)) return;
    this.updateRalphState(data.sessionId, { statusBlock: data.block });
  },

  _onCircuitBreakerUpdate(data) {
    // Skip if user explicitly closed this session's Ralph panel
    if (this.ralphClosedSessions.has(data.sessionId)) return;
    this.updateRalphState(data.sessionId, { circuitBreaker: data.status });
    // Notify if circuit breaker opens
    if (data.status.state === 'OPEN') {
      this._notifySession(data.sessionId, 'critical', 'circuit-breaker', 'Circuit Breaker Open', data.status.reason || 'Loop stuck - no progress detected');
    }
  },

  _onExitGateMet(data) {
    this._notifySession(data.sessionId, 'warning', 'exit-gate', 'Exit Gate Met', `Loop ready to exit (indicators: ${data.completionIndicators})`);
  },

  // Bash tools

  // Plan orchestration
  _onPlanSubagent(data) {
    console.log('[Plan Subagent]', data);
    this.handlePlanSubagentEvent(data);
  },

  _onPlanProgress(data) {
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
  },

  _onPlanStarted(data) {
    console.log('[Plan Started]', data);
    this.activePlanOrchestratorId = data.orchestratorId;
    this.planGenerationStopped = false; // Reset flag for new generation
    this.renderMonitorPlanAgents();
  },

  _onPlanCancelled(data) {
    console.log('[Plan Cancelled]', data);
    if (this.activePlanOrchestratorId === data.orchestratorId) {
      this.activePlanOrchestratorId = null;
    }
    this.renderMonitorPlanAgents();
  },

  _onPlanCompleted(data) {
    console.log('[Plan Completed]', data);
    if (this.activePlanOrchestratorId === data.orchestratorId) {
      this.activePlanOrchestratorId = null;
    }
    this.renderMonitorPlanAgents();
  },


  // ═══════════════════════════════════════════════════════════════
  // Enhanced Ralph Wiggum Loop Panel
  // ═══════════════════════════════════════════════════════════════

  updateRalphState(sessionId, updates) {
    const existing = this.ralphStates.get(sessionId) || { loop: null, todos: [] };
    const updated = { ...existing, ...updates };
    this.ralphStates.set(sessionId, updated);

    // Re-render if this is the active session
    if (sessionId === this.activeSessionId) {
      this.renderRalphStatePanel();
    }
  },

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
      // Refit terminal to new container size. Through the one owner so the
      // floor that is reported to the PTY is also the one xterm holds (#464).
      this.syncTerminalGeometry?.();
    });
  },

  async closeRalphTracker() {
    if (!this.activeSessionId) return;

    // Mark this session as explicitly closed - will stay hidden until user re-enables
    this.ralphClosedSessions.add(this.activeSessionId);

    // Disable tracker via API
    await this._apiPost(`/api/sessions/${this.activeSessionId}/ralph-config`, { enabled: false });

    // Clear local state and hide panel
    this.ralphStates.delete(this.activeSessionId);
    this.renderRalphStatePanel();
  },

  // ═══════════════════════════════════════════════════════════════
  // @fix_plan.md Integration
  // ═══════════════════════════════════════════════════════════════

  toggleRalphMenu() {
    const dropdown = document.getElementById('ralphDropdown');
    if (dropdown) {
      dropdown.classList.toggle('show');
    }
  },

  closeRalphMenu() {
    const dropdown = document.getElementById('ralphDropdown');
    if (dropdown) {
      dropdown.classList.remove('show');
    }
  },

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
  },

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
  },

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
  },

  closeFixPlanModal() {
    const modal = document.getElementById('fixPlanModal');
    if (modal) {
      modal.classList.remove('show');
    }
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  renderRalphStatePanel() {
    this._debouncedCall('ralphStatePanel', this._renderRalphStatePanelImmediate, 50);
  },

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
  },

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
  },

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
  },

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
  },


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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  getRalphTaskIcon(status) {
    switch (status) {
      case 'completed': return '✓';
      case 'in_progress': return '◐';
      case 'pending':
      default: return '○';
    }
  },

  // Legacy method for backwards compatibility
  getTodoIcon(status) {
    return this.getRalphTaskIcon(status);
  },


  // ═══════════════════════════════════════════════════════════════
  // Plan Versioning
  // ═══════════════════════════════════════════════════════════════

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
  },

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

      const history = data.data.history || [];
      if (history.length === 0) {
        this.showToast('No plan history available', 'info');
        return;
      }

      // Show history dropdown modal
      this.showPlanHistoryModal(history, data.data.currentVersion);
    } catch (err) {
      this.showToast('Failed to load plan history: ' + err.message, 'error');
    }
  },

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
                  <span class="plan-history-tasks">${item.stats?.total ?? 0} tasks</span>
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
  },

  closePlanHistoryModal() {
    const modal = document.getElementById('planHistoryModal');
    if (modal) modal.remove();
  },

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
  },

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
  },


  // ═══════════════════════════════════════════════════════════════
  // Plan Wizard Agents in Monitor
  // ═══════════════════════════════════════════════════════════════

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
  },

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
  },
});
