/**
 * @fileoverview Respawn banner (state display, countdown timers, action log, detection layers),
 * respawn presets (CRUD, built-in presets), and run summary modal (timeline, export).
 * Includes 12 SSE handlers for respawn events.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.respawnStatus, this.respawnTimers, this.respawnCountdownTimers)
 * @dependency constants.js (escapeHtml, SSE_EVENTS)
 * @loadorder 8 of 15 — loaded after terminal-ui.js, before ralph-panel.js
 */

Object.assign(CodemanApp.prototype, {
  // Respawn
  _onRespawnStarted(data) {
    this.respawnStatus[data.sessionId] = data.status;
    if (data.sessionId === this.activeSessionId) {
      this.showRespawnBanner();
    }
  },

  _onRespawnStopped(data) {
    delete this.respawnStatus[data.sessionId];
    if (data.sessionId === this.activeSessionId) {
      this.hideRespawnBanner();
    }
  },

  _onRespawnStateChanged(data) {
    if (this.respawnStatus[data.sessionId]) {
      this.respawnStatus[data.sessionId].state = data.state;
    }
    if (data.sessionId === this.activeSessionId) {
      this.updateRespawnBanner(data.state);
    }
  },

  _onRespawnCycleStarted(data) {
    if (this.respawnStatus[data.sessionId]) {
      this.respawnStatus[data.sessionId].cycleCount = data.cycleNumber;
    }
    if (data.sessionId === this.activeSessionId) {
      document.getElementById('respawnCycleCount').textContent = data.cycleNumber;
    }
  },

  _onRespawnBlocked(data) {
    const reasonMap = {
      circuit_breaker_open: 'Circuit Breaker Open',
      exit_signal: 'Exit Signal Detected',
      status_blocked: 'Claude Reported BLOCKED',
    };
    const title = reasonMap[data.reason] || 'Respawn Blocked';
    this._notifySession(data.sessionId, 'critical', 'respawn-blocked', title, data.details);
    // Update respawn panel to show blocked state
    if (data.sessionId === this.activeSessionId) {
      const stateEl = document.getElementById('respawnStateLabel');
      if (stateEl) {
        stateEl.textContent = title;
        stateEl.classList.add('respawn-blocked');
      }
    }
  },

  _onRespawnAutoAcceptSent(data) {
    const session = this.sessions.get(data.sessionId);
    this._notifySession(data.sessionId, 'info', 'auto-accept', 'Plan Accepted', `Accepted plan mode for ${session?.name || 'session'}`);
  },

  _onRespawnDetectionUpdate(data) {
    if (this.respawnStatus[data.sessionId]) {
      this.respawnStatus[data.sessionId].detection = data.detection;
    }
    if (data.sessionId === this.activeSessionId) {
      this.updateDetectionDisplay(data.detection);
    }
  },

  // Merged handler for respawn:timerStarted — handles both run timers (data.endAt)
  // and controller countdown timers (data.timer). Previously registered as two
  // separate addListener calls (duplicate event bug).
  _onRespawnTimerStarted(data) {
    // Run timer (timed respawn runs)
    if (data.endAt) {
      this.respawnTimers[data.sessionId] = {
        endAt: data.endAt,
        startedAt: data.startedAt,
        durationMinutes: data.durationMinutes
      };
      if (data.sessionId === this.activeSessionId) {
        this.showRespawnTimer();
      }
    }
    // Controller countdown timer (internal timers)
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
  },

  _onRespawnTimerCancelled(data) {
    const { sessionId, timerName } = data;
    if (this.respawnCountdownTimers[sessionId]) {
      delete this.respawnCountdownTimers[sessionId][timerName];
    }
    if (sessionId === this.activeSessionId) {
      this.updateCountdownTimerDisplay();
    }
  },

  _onRespawnTimerCompleted(data) {
    const { sessionId, timerName } = data;
    if (this.respawnCountdownTimers[sessionId]) {
      delete this.respawnCountdownTimers[sessionId][timerName];
    }
    if (sessionId === this.activeSessionId) {
      this.updateCountdownTimerDisplay();
    }
  },

  _onRespawnError(data) {
    this._notifySession(data.sessionId, 'critical', 'session-error', 'Respawn Error', data.error || data.message || 'Respawn encountered an error');
  },

  _onRespawnActionLog(data) {
    const { sessionId, action } = data;
    this.addActionLogEntry(sessionId, action);
    if (sessionId === this.activeSessionId) {
      this.updateCountdownTimerDisplay(); // Show row if hidden
      this.updateActionLogDisplay();
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Respawn Banner
  // ═══════════════════════════════════════════════════════════════

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
  },

  hideRespawnBanner() {
    this.$('respawnBanner').style.display = 'none';
    this.hideRespawnTimer();
  },

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
  },

  updateRespawnBanner(state) {
    const stateEl = this.$('respawnState');
    stateEl.textContent = this.getStateLabel(state);
    // Clear blocked state when state changes (resumed from blocked)
    stateEl.classList.remove('respawn-blocked');
  },

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
  },

  showRespawnTimer() {
    const timerEl = this.$('respawnTimer');
    timerEl.style.display = '';
    this.updateRespawnTimer();
    // Update every second
    if (this.respawnTimerInterval) clearInterval(this.respawnTimerInterval);
    this.respawnTimerInterval = setInterval(() => this.updateRespawnTimer(), 1000);
  },

  hideRespawnTimer() {
    this.$('respawnTimer').style.display = 'none';
    if (this.respawnTimerInterval) {
      clearInterval(this.respawnTimerInterval);
      this.respawnTimerInterval = null;
    }
  },

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
  },

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
  },

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
  },

  // ═══════════════════════════════════════════════════════════════
  // Countdown Timer Display Methods
  // ═══════════════════════════════════════════════════════════════

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
  },

  startCountdownInterval() {
    if (this.timerCountdownInterval) return;
    this.timerCountdownInterval = setInterval(() => {
      if (this.activeSessionId && this.respawnCountdownTimers[this.activeSessionId]) {
        this.updateCountdownTimerDisplay();
      }
    }, 100);
  },

  stopCountdownInterval() {
    if (this.timerCountdownInterval) {
      clearInterval(this.timerCountdownInterval);
      this.timerCountdownInterval = null;
    }
  },

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
  },

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
  },

  clearCountdownTimers(sessionId) {
    delete this.respawnCountdownTimers[sessionId];
    delete this.respawnActionLogs[sessionId];
    if (sessionId === this.activeSessionId) {
      this.updateCountdownTimerDisplay();
      this.updateActionLogDisplay();
    }
  },

  async stopRespawn() {
    if (!this.activeSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.activeSessionId}/respawn/stop`, {});
      delete this.respawnTimers[this.activeSessionId];
      this.clearCountdownTimers(this.activeSessionId);
    } catch (err) {
      this.showToast('Failed to stop respawn', 'error');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Respawn Presets
  // ═══════════════════════════════════════════════════════════════

  loadRespawnPresets() {
    // Custom presets: prefer server-synced cache, fall back to legacy localStorage key
    const serverCache = this._serverRespawnPresets;
    if (serverCache) return [...BUILTIN_RESPAWN_PRESETS, ...serverCache];
    const saved = localStorage.getItem('codeman-respawn-presets');
    const custom = saved ? JSON.parse(saved) : [];
    return [...BUILTIN_RESPAWN_PRESETS, ...custom];
  },

  saveRespawnPresets(presets) {
    // Only save custom presets (not built-in)
    const custom = presets.filter(p => !p.builtIn);
    // Update local cache + legacy localStorage
    this._serverRespawnPresets = custom;
    localStorage.setItem('codeman-respawn-presets', JSON.stringify(custom));
    // Persist to server (cross-device sync). Not for a non-admin in multi-user mode: the
    // presets are a key of the server-wide settings.json there, and its PUT is admin-only
    // (403), so they are kept as their own on this device and win over the server's on the
    // next load (_rememberOwnSetting, settings-ui.js). A PUT refused that way (sent before the
    // role was known) marks the page read-only for the writes after it.
    if (this._settingsReadOnly?.()) {
      this._rememberOwnSetting?.('respawnPresets', custom);
      return;
    }
    this._apiPut('/api/settings', { respawnPresets: custom })
      .then((res) => this._noteSettingsWriteRefusal?.(res))
      .catch(() => {});
  },

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
  },

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
  },

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
  },

  saveCurrentAsPreset() {
    document.getElementById('savePresetModal').classList.add('active');
    document.getElementById('presetNameInput').value = '';
    document.getElementById('presetDescriptionInput').value = '';
    document.getElementById('presetNameInput').focus();
  },

  closeSavePresetModal() {
    document.getElementById('savePresetModal').classList.remove('active');
  },

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
  },

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
  },

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
  },

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
        body: JSON.stringify({ config: respawnConfig, durationMinutes: durationMinutes ?? undefined })
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
  },

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
  },

  closeSessionOptions() {
    // Commit the field the user was still editing BEFORE editingSessionId is
    // cleared. The Session Name input saves on blur (and the auto-compact prompt
    // on change), and every autosave handler bails out on `!this.editingSessionId`.
    // Hiding the modal blurs the focused input on its own, but that happens after
    // the id is gone, so Escape / backdrop-click silently dropped what was typed.
    // (Clicking the X worked only because mousedown blurs the input first.)
    const modal = document.getElementById('sessionOptionsModal');
    const focused = document.activeElement;
    if (focused && modal && modal.contains(focused) && typeof focused.blur === 'function') {
      focused.blur();
    }

    this.editingSessionId = null;
    // Stop run summary auto-refresh if it was running
    this.stopRunSummaryAutoRefresh();
    document.getElementById('sessionOptionsModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  },

  setupColorPicker() {
    const picker = document.getElementById('sessionColorPicker');
    if (!picker) return;

    picker.addEventListener('click', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (!swatch || !this.editingSessionId) return;

      const color = swatch.dataset.color;
      this.setSessionColor(this.editingSessionId, color);
    });
  },

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
  },


  // ═══════════════════════════════════════════════════════════════
  // Run Summary Modal
  // ═══════════════════════════════════════════════════════════════

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
  },

  closeRunSummary() {
    this.runSummarySessionId = null;
    this.stopRunSummaryAutoRefresh();
    // Close session options modal (summary is now a tab in it)
    this.closeSessionOptions();
  },

  async refreshRunSummary() {
    const sessionId = this.runSummarySessionId || this.editingSessionId;
    if (!sessionId) return;
    await this.loadRunSummary(sessionId);
  },

  toggleRunSummaryAutoRefresh() {
    const checkbox = document.getElementById('runSummaryAutoRefresh');
    if (checkbox.checked) {
      this.startRunSummaryAutoRefresh();
    } else {
      this.stopRunSummaryAutoRefresh();
    }
  },

  startRunSummaryAutoRefresh() {
    if (this.runSummaryAutoRefreshTimer) return;
    this.runSummaryAutoRefreshTimer = setInterval(() => {
      if (this.runSummarySessionId) {
        this.loadRunSummary(this.runSummarySessionId);
      }
    }, 5000); // Refresh every 5 seconds
  },

  stopRunSummaryAutoRefresh() {
    if (this.runSummaryAutoRefreshTimer) {
      clearInterval(this.runSummaryAutoRefreshTimer);
      this.runSummaryAutoRefreshTimer = null;
    }
    const checkbox = document.getElementById('runSummaryAutoRefresh');
    if (checkbox) checkbox.checked = false;
  },

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
  },

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
  },

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

      this.runSummaryData = data.data.summary;
      this.renderRunSummary();
    } catch (err) {
      console.error('Failed to load run summary:', err);
      timeline.innerHTML = '<p class="empty-message">Failed to load summary</p>';
    }
  },

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
  },

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
  },

  filterRunSummary(filter) {
    this.runSummaryFilter = filter;

    // Update active state on buttons
    document.querySelectorAll('.run-summary-filters .filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });

    this.renderRunSummary();
  },

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
  },

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
  },


  formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  },

  saveSessionOptions() {
    // Session options are applied immediately via individual controls
    // This just closes the modal
    this.closeSessionOptions();
  },
});
