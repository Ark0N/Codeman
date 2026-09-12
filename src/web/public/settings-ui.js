/**
 * @fileoverview App settings modal, visibility settings (header/panel/device-specific defaults),
 * web push notifications, session lifecycle log (JSONL viewer), tunnel/QR management,
 * persistent parent associations, and help modal.
 * Includes 13 SSE handlers for hooks and tunnel events.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.notificationManager, this._tunnelUrl)
 * @dependency constants.js (escapeHtml)
 * @dependency keyboard-accessory.js (FocusTrap)
 * @loadorder 10 of 15 — loaded after ralph-panel.js, before panels-ui.js
 */

Object.assign(CodemanApp.prototype, {
  // Hooks (Claude Code hook events)
  _onHookIdlePrompt(data) {
    // Always track pending hook - alert will show when switching away from session
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'idle_prompt');
    }
    this._notifySession(data.sessionId, 'warning', 'hook-idle', 'Waiting for Input', data.message || 'Claude is idle and waiting for a prompt');
  },

  _onHookPermissionPrompt(data) {
    // Always track pending hook - action alerts need user interaction to clear
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'permission_prompt');
    }
    const toolInfo = data.tool ? `${data.tool}${data.command ? ': ' + data.command : data.file ? ': ' + data.file : ''}` : '';
    this._notifySession(data.sessionId, 'critical', 'hook-permission', 'Permission Required', toolInfo || 'Claude needs tool approval to continue');
  },

  _onHookElicitationDialog(data) {
    // Always track pending hook - action alerts need user interaction to clear
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'elicitation_dialog');
    }
    this._notifySession(data.sessionId, 'critical', 'hook-elicitation', 'Question Asked', data.question || 'Claude is asking a question and waiting for your answer');
  },

  _onHookElicitationComplete(data) {
    // Question answered in the terminal: clear the action alert without
    // waiting for `stop` (the turn may keep running for a long time).
    // ⚠️ BOTH action kinds, matching the server's APPROVAL_RESOLVING_EVENTS,
    // which resolves a session's pending item whatever its kind. An
    // AskUserQuestion dialog arrives as `permission_prompt` (only MCP
    // elicitation is `elicitation_dialog`), so clearing just the elicitation
    // entry left the red alert armed on exactly the dialog these events are
    // most often about. Normally the server's `approval:resolved` broadcast
    // clears it too; this is the path that still works when the store holds no
    // item for the session (restart, superseded).
    if (data.sessionId) {
      this.clearPendingHooks(data.sessionId, 'elicitation_dialog');
      this.clearPendingHooks(data.sessionId, 'permission_prompt');
    }
  },

  _onHookElicitationResponse(data) {
    this._onHookElicitationComplete(data);
  },

  _onHookStop(data) {
    // Clear all pending hooks when Claude finishes responding
    if (data.sessionId) {
      this.clearPendingHooks(data.sessionId);
    }
    this._notifySession(data.sessionId, 'info', 'hook-stop', 'Response Complete', data.reason || 'Claude has finished responding');
  },

  _onHookAgentWorking(data) {
    // The agent started a turn, so whatever it was blocked on is gone. Reported
    // by the DeepSeek status bridge; a harness turn cannot run while one of its
    // own modal approvals is on screen, so this means the dialog was answered in
    // the terminal. Same clearing as _onHookElicitationComplete, and notably NOT
    // a notification: a turn STARTING is not news.
    if (data.sessionId) {
      this.clearPendingHooks(data.sessionId, 'elicitation_dialog');
      this.clearPendingHooks(data.sessionId, 'permission_prompt');
      this.clearPendingHooks(data.sessionId, 'idle_prompt');
    }
  },

  _onHookTeammateIdle(data) {
    const session = this.sessions.get(data.sessionId);
    this._notifySession(data.sessionId, 'warning', 'hook-teammate-idle', 'Teammate Idle', `A teammate is idle in ${session?.name || data.sessionId}`);
  },

  _onHookTaskCompleted(data) {
    const session = this.sessions.get(data.sessionId);
    this._notifySession(data.sessionId, 'info', 'hook-task-completed', 'Task Completed', `A team task completed in ${session?.name || data.sessionId}`);
  },


  // Tunnel
  _onTunnelStarted(data) {
    console.log('[Tunnel] Started:', data.url);
    this._tunnelUrl = data.url;
    this._dismissTunnelConnecting();
    this._updateTunnelUrlDisplay(data.url);
    this._updateTunnelIndicator(true);
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
  },

  _onTunnelStopped() {
    console.log('[Tunnel] Stopped');
    this._tunnelUrl = null;
    this._dismissTunnelConnecting();
    this._updateTunnelUrlDisplay(null);
    this._updateWelcomeTunnelBtn(false);
    this._updateTunnelIndicator(false);
    this.closeTunnelPanel();
    this.closeTunnelQR();
  },

  _onTunnelProgress(data) {
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
  },

  _onTunnelError(data) {
    console.warn('[Tunnel] Error:', data.message);
    this._dismissTunnelConnecting();
    this.showToast(`Tunnel error: ${data.message}`, 'error');
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) { btn.disabled = false; btn.classList.remove('connecting'); }
  },

  _onTunnelQrRotated(data) {
    if (data.svg) {
      const container = document.getElementById('tunnelQrContainer');
      if (container) container.innerHTML = data.svg;
      const welcomeInner = document.getElementById('welcomeQrInner');
      if (welcomeInner) welcomeInner.innerHTML = data.svg;
    } else {
      this._refreshTunnelQrFromApi();
    }
    this._resetQrCountdown();
  },

  _onTunnelQrRegenerated(data) {
    if (data.svg) {
      const container = document.getElementById('tunnelQrContainer');
      if (container) container.innerHTML = data.svg;
      const welcomeInner = document.getElementById('welcomeQrInner');
      if (welcomeInner) welcomeInner.innerHTML = data.svg;
    } else {
      this._refreshTunnelQrFromApi();
    }
    this._resetQrCountdown();
  },

  _onTunnelQrAuthUsed(data) {
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
  },


  // ═══════════════════════════════════════════════════════════════
  // Web Push
  // ═══════════════════════════════════════════════════════════════

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Behind a sub-path mount the worker is served at <base>/sw.js and controls
    // <base>/ (Service-Worker-Allowed is '/', so this narrower scope is permitted).
    const _swBase = window.CodemanBase?.base || '';
    navigator.serviceWorker.register(_swBase + '/sw.js', { scope: _swBase + '/' }).then((reg) => {
      this._swRegistration = reg;
      // Listen for messages from service worker (notification clicks)
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'notification-click') {
          const { sessionId, action, approvalId } = event.data;
          if (action) {
            // Approve/Deny action buttons on a push: answer via the
            // Approvals Inbox instead of just focusing the session.
            this.handleNotificationAction?.(action, approvalId, sessionId);
          } else if (sessionId && this.sessions.has(sessionId)) {
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
  },

  async subscribeToPush() {
    if (!this._swRegistration) {
      this.showToast('Service worker not available. HTTPS or localhost required.', 'error');
      return;
    }
    try {
      // Get VAPID public key from server
      const keyData = await this._apiJson('/api/push/vapid-key');
      if (!keyData) throw new Error('Failed to get VAPID key');

      const applicationServerKey = urlBase64ToUint8Array(keyData.publicKey);
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
      if (!data) throw new Error('Failed to register subscription');

      this._pushSubscription = subscription;
      this._pushSubscriptionId = data.id;
      localStorage.setItem('codeman-push-subscription-id', data.id);
      this._updatePushUI(true);
      this.showToast('Push notifications enabled', 'success');
    } catch (err) {
      this.showToast('Push subscription failed: ' + (err.message || err), 'error');
    }
  },

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
  },

  async togglePushSubscription() {
    if (this._pushSubscription) {
      await this.unsubscribeFromPush();
    } else {
      await this.subscribeToPush();
    }
  },

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
  },

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
  },

  _updatePushUI(subscribed) {
    const btn = document.getElementById('pushSubscribeBtn');
    const status = document.getElementById('pushSubscriptionStatus');
    if (btn) btn.textContent = subscribed ? 'Unsubscribe' : 'Subscribe';
    if (status) {
      status.textContent = subscribed ? 'active' : 'off';
      status.classList.remove('granted', 'denied');
      if (subscribed) status.classList.add('granted');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // App Settings Modal
  // ═══════════════════════════════════════════════════════════════

  openAppSettings() {
    // Load current settings
    const settings = this.loadAppSettingsFromStorage();
    document.getElementById('appSettingsDisplayName').value = settings.displayName || 'Codeman';
    document.getElementById('appSettingsLanguage').value = settings.language === 'zh-CN' ? 'zh-CN' : 'en';
    document.getElementById('appSettingsClaudeMdPath').value = settings.defaultClaudeMdPath || '';
    document.getElementById('appSettingsDefaultDir').value = settings.defaultWorkingDir || '';
    // Use device-aware defaults for display settings (mobile has different defaults)
    const defaults = this.getDefaultSettings();
    document.getElementById('appSettingsRalphEnabled').checked = settings.ralphTrackerEnabled ?? defaults.ralphTrackerEnabled ?? false;
    // Header visibility settings
    document.getElementById('appSettingsShowFontControls').checked = settings.showFontControls ?? defaults.showFontControls ?? false;
    document.getElementById('appSettingsShowSystemStats').checked = settings.showSystemStats ?? defaults.showSystemStats ?? true;
    document.getElementById('appSettingsShowLifecycleLog').checked = settings.showLifecycleLog ?? defaults.showLifecycleLog ?? false;
    document.getElementById('appSettingsShowResponseViewer').checked = settings.showResponseViewer ?? defaults.showResponseViewer ?? false;
    document.getElementById('appSettingsShowFileViewerButton').checked = settings.showFileViewerButton ?? defaults.showFileViewerButton ?? true;
    document.getElementById('appSettingsShowAttachmentsButton').checked = settings.showAttachmentsButton ?? defaults.showAttachmentsButton ?? false;
    document.getElementById('appSettingsSkin').value = settings.skin ?? defaults.skin ?? 'daylight-blue';
    // Entrance animations. Deliberately NOT part of the settings payload: the
    // styles persist to their own localStorage keys via setAnimTheme(), which
    // keeps them per-device without touching the .strict() SettingsUpdateSchema.
    this._syncEntranceAnimSetting?.();
    // WebGL renderer (desktop only — mobile always uses the DOM renderer, so hide
    // the toggle there so it can't promise something that won't apply).
    document.getElementById('appSettingsWebglRenderer').checked = settings.webglRendererEnabled ?? defaults.webglRendererEnabled ?? true;
    const webglItem = document.getElementById('appSettingsWebglRendererItem');
    if (webglItem) webglItem.style.display = MobileDetection.getDeviceType() === 'desktop' ? '' : 'none';
    document.getElementById('appSettingsShowMonitor').checked = settings.showMonitor ?? defaults.showMonitor ?? false;
    document.getElementById('appSettingsShowProjectInsights').checked = settings.showProjectInsights ?? defaults.showProjectInsights ?? false;
    document.getElementById('appSettingsShowFileBrowser').checked = settings.showFileBrowser ?? defaults.showFileBrowser ?? false;
    document.getElementById('appSettingsShowSubagents').checked = settings.showSubagents ?? defaults.showSubagents ?? false;
    document.getElementById('appSettingsShowUltracodeAgents').checked = settings.showUltracodeAgents ?? defaults.showUltracodeAgents ?? false;
    // Approvals Inbox: synced, default OFF (opt-in; only an explicit true enables).
    document.getElementById('appSettingsApprovalsInbox').checked = settings.approvalsInboxEnabled === true;
    // Read My Mind: synced, default OFF (opt-in; capture + prediction cost real tokens).
    document.getElementById('appSettingsReadMyMind').checked = settings.readMyMindEnabled === true;
    document.getElementById('appSettingsUltracodeFloatingWindows').checked =
      settings.ultracodeFloatingWindows ?? defaults.ultracodeFloatingWindows ?? false;
    document.getElementById('appSettingsShowMultiMonitorButton').checked = settings.showMultiMonitorButton ?? defaults.showMultiMonitorButton ?? false;
    document.getElementById('appSettingsShowPlanUsageLimits').checked = this.planUsageChipEnabled(settings);
    document.getElementById('appSettingsShowRedrawButton').checked = settings.showRedrawButton ?? defaults.showRedrawButton ?? false;
    // Phone overview home screen: only meaningful under 600px, so the row is
    // hidden elsewhere rather than offering a toggle that changes nothing.
    // Spawn lineage lines: desktop-only (the overlay sits UNDER the fixed mobile
    // header), so the row is hidden elsewhere rather than offering a toggle that
    // changes nothing. Default ON — only an explicit false turns it off.
    document.getElementById('appSettingsLineageLines').checked = settings.sessionLineageLines ?? defaults.sessionLineageLines ?? true;
    const lineageItem = document.getElementById('appSettingsLineageLinesItem');
    if (lineageItem) lineageItem.style.display = MobileDetection.getDeviceType() === 'desktop' ? '' : 'none';
    document.getElementById('appSettingsMobileOverview').checked = settings.mobileOverviewEnabled ?? defaults.mobileOverviewEnabled ?? false;
    const mobileOverviewItem = document.getElementById('appSettingsMobileOverviewItem');
    if (mobileOverviewItem) mobileOverviewItem.style.display = MobileDetection.getDeviceType() === 'mobile' ? '' : 'none';
    // Session Manager, Away Digest and Cron buttons all default OFF (opt-in under
    // Display → Header Displays; the Cron button also ships with btn-cron--hidden
    // in the template, so an unchecked box and a hidden button stay consistent).
    document.getElementById('appSettingsShowSessionButton').checked = settings.showSessionButton ?? defaults.showSessionButton ?? false;
    document.getElementById('appSettingsShowAwayDigestButton').checked = settings.showAwayDigestButton ?? defaults.showAwayDigestButton ?? false;
    document.getElementById('appSettingsShowCronButton').checked = settings.showCronButton ?? defaults.showCronButton ?? false;
    // Gesture control lives in the Input section (alongside Local Echo / CJK Input)
    // but is only available when the instance runs with CODEMAN_GESTURE=1 (server sets
    // window.__codemanGestureAvailable). Hide just this item otherwise so the toggle
    // can't promise something that won't work.
    const gestureItem = document.getElementById('appSettingsGestureControlItem');
    if (gestureItem) gestureItem.style.display = window.__codemanGestureAvailable ? '' : 'none';
    document.getElementById('appSettingsGestureControl').checked = settings.gestureControlEnabled ?? defaults.gestureControlEnabled ?? false;
    document.getElementById('appSettingsSubagentTracking').checked = settings.subagentTrackingEnabled ?? defaults.subagentTrackingEnabled ?? true;
    document.getElementById('appSettingsSubagentActiveTabOnly').checked = settings.subagentActiveTabOnly ?? defaults.subagentActiveTabOnly ?? true;
    document.getElementById('appSettingsImageWatcherEnabled').checked = settings.imageWatcherEnabled ?? defaults.imageWatcherEnabled ?? false;
    document.getElementById('appSettingsTunnelEnabled').checked = settings.tunnelEnabled ?? false;
    this.loadTunnelStatus();
    document.getElementById('appSettingsLocalEcho').checked = settings.localEchoEnabled ?? MobileDetection.isTouchDevice();
    // Auto Copy (copy-on-select): per-device, default OFF everywhere. It quietly
    // overwrites the system clipboard on a gesture the user may have meant only as
    // a way to read, so it is opt-in rather than a default anyone has to discover.
    document.getElementById('appSettingsAutoCopySelection').checked = settings.autoCopySelection === true;
    document.getElementById('appSettingsTerminalFont').value = settings.terminalFontFamily || '';
    document.getElementById('appSettingsTerminalWheelLocal').checked =
      settings.terminalWheelLocalScrollback ?? defaults.terminalWheelLocalScrollback ?? false;
    document.getElementById('appSettingsCjkInput').checked = settings.cjkInputEnabled ?? defaults.cjkInputEnabled ?? false;
    document.getElementById('appSettingsExtendedKeyboardBar').checked = settings.extendedKeyboardBar ?? false;
    document.getElementById('appSettingsTabTwoRows').checked = settings.tabTwoRows ?? defaults.tabTwoRows ?? false;
    document.getElementById('appSettingsTabOrientation').value =
      settings.tabOrientation ?? defaults.tabOrientation ?? 'horizontal';
    const tabRailWidth = window.CodemanTabRail?.resolveWidth({
      // Same default resolution as applyTabRailWidth(): a rail that has never
      // been sized shows the width it is actually rendering at, which for
      // detailed rows is the Wide preset rather than 256. The rich-aware
      // default must come BEFORE the per-device defaults blob: the handheld
      // blob carries tabRailWidth: 256, which applyTabRailWidth() never reads,
      // so consulting it first showed a tablet's unsized rich rail as 256 while
      // it rendered at 320 — and a routine Save then PERSISTED the 256.
      width: settings.tabRailWidth ?? this._defaultTabRailWidth?.() ?? defaults.tabRailWidth ?? 256,
    }) ?? 256;
    this.syncTabRailWidthSetting?.(tabRailWidth);
    document.getElementById('appSettingsTabRailDetail').value =
      settings.tabRailDetail ?? defaults.tabRailDetail ?? 'rich';
    document.getElementById('appSettingsShowTabDetachButton').checked = settings.showTabDetachButton ?? defaults.showTabDetachButton ?? false;
    document.getElementById('appSettingsSessionListLayout').value =
      settings.sessionListLayout ?? defaults.sessionListLayout ?? 'header';
    const sessionSidebarFontSize = this.resolveSessionSidebarFontSize(
      settings.sessionSidebarFontSize ?? defaults.sessionSidebarFontSize
    );
    document.getElementById('appSettingsSessionSidebarFontSize').value = String(sessionSidebarFontSize);
    document.getElementById('appSettingsSessionSidebarFontSizeValue').textContent = `${sessionSidebarFontSize} px`;
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
    // Codex CLI settings. The inputs are always populated (and always read back
    // by saveAppSettings), even when the tab is hidden below, so a user without
    // codex installed can never silently wipe the codex prefs of an instance
    // that does have it.
    document.getElementById('appSettingsCodexDangerouslyBypassApprovals').checked =
      settings.codexDangerouslyBypassApprovals ?? false;
    document.getElementById('appSettingsCodexAnimations').checked =
      settings.codexAnimationsEnabled ?? false;
    this._applyCodexSettingsVisibility();
    // Claude Permissions settings
    document.getElementById('appSettingsAgentTeams').checked = settings.agentTeamsEnabled ?? false;
    document.getElementById('appSettingsAgentSkill').checked = settings.agentSkillEnabled ?? false;
    // Default ON: an absent key is a user who has never seen this setting, and OFF
    // for them means no tab alerts in any workspace Codeman did not scaffold.
    document.getElementById('appSettingsWorkspaceHooks').checked = settings.workspaceHooksEnabled !== false;
    document.getElementById('appSettingsClaudeModel').value = settings.claudeModel ?? '';
    document.getElementById('appSettingsOpusContext1m').checked = settings.opusContext1mEnabled ?? false;
    document.getElementById('appSettingsRemoteAutoReconnect').checked = settings.remoteAutoReconnect ?? true;
    document.getElementById('appSettingsThinkingEffort').value = settings.thinkingEffort ?? '';
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
    document.getElementById('eventStopEnabled').checked = stopPref.enabled ?? false;
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
    document.getElementById('voiceKeyterms').value = voiceCfg.keyterms || DEFAULT_VOICE_KEYTERMS;
    document.getElementById('voiceInsertMode').value = voiceCfg.insertMode || 'direct';
    document.getElementById('voiceProvider').value = voiceCfg.provider || 'auto';
    document.getElementById('appSettingsClaudeVoice').checked = settings.claudeVoiceEnabled ?? false;
    // Reset key visibility to hidden
    const keyInput = document.getElementById('voiceDeepgramKey');
    keyInput.type = 'password';
    document.getElementById('voiceKeyToggleBtn').textContent = 'Show';
    // Update provider status. The Claude row needs a fresh server probe: the
    // setting is synced, so another device may have flipped it since page load.
    this._renderVoiceProviderStatus();
    VoiceInput.refreshClaudeStatus().then(() => this._renderVoiceProviderStatus());

    // Updates section — show current version, reset transient result/progress UI.
    this._initUpdatesSection();

    // Model cards + effort segment are views over the hidden <select>s above,
    // so they must be synced AFTER those have been given their stored values.
    this._initSettingsNav();
    this._syncSettingsChips();
    this._syncModelCards();
    this._syncEffortSegment();
    // Back to the top of the document (one scroll, not a tab reset). Updates is
    // first now: the version this install is running, and whether a newer one is
    // waiting, are the two things worth seeing before any preference. The rest of
    // the system settings (paths, automation, remote access) tail the document.
    this.switchSettingsTab('settings-updates');
    const modal = document.getElementById('appSettingsModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  },

  /**
   * Show the App Settings "Codex" group only on instances where the codex binary
   * actually resolves. Both settings in it (approval bypass, animated status
   * effects) are passed to `codex` at launch, so on a box without codex the
   * group is a promise nothing can keep.
   *
   * Availability comes from the injected `window.__codemanCliAvailable`, shared
   * with the welcome buttons and the run-mode dropdown, so the group never
   * flickers in and back out. The inputs stay in the DOM either way, so a user
   * without codex can never silently wipe the codex prefs of an instance that
   * has it (openAppSettings/saveAppSettings still read and write them).
   *
   * Note the inverted default versus the run buttons: an UNKNOWN flag hides this
   * group. Hiding it costs a user nothing, whereas hiding a run button would
   * leave a working install with nothing to click.
   */
  _applyCodexSettingsVisibility() {
    const group = document.getElementById('appSettingsCodexGroup');
    if (group) group.style.display = window.__codemanCliAvailable?.codex === true ? '' : 'none';
  },

  /**
   * Scroll the settings document to a section.
   *
   * Kept under the historical `switchSettingsTab` name because it is the shared
   * entry point: openAppSettings() calls it, and admin-ui.js's injected Users
   * entry routes through it too. Sections are never hidden any more — the rail
   * is a table of contents over ONE document, so "switching" is a scroll.
   */
  switchSettingsTab(sectionId) {
    // The Shortcuts list renders lazily so it reflects the CURRENT registry
    // (defaults + overrides) every time it is reached.
    if (sectionId === 'settings-shortcuts') this.renderShortcutSettingsList?.();
    const doc = document.getElementById('appSettingsDoc');
    const section = document.getElementById(sectionId);
    if (doc && section && typeof section.offsetTop === 'number') {
      // On phones the jump pill is sticky at the top of the document, so land
      // the section head below it instead of underneath it.
      const jump = document.getElementById('appSettingsJump');
      const inset = jump && jump.offsetParent ? jump.offsetHeight + 16 : 6;
      doc.scrollTop = Math.max(0, section.offsetTop - inset);
    }
    this._setActiveSettingsSection(sectionId);
  },

  /** Paint the rail + jump pill for the section currently in view. */
  _setActiveSettingsSection(sectionId) {
    const modal = document.getElementById('appSettingsModal');
    if (!modal || typeof modal.querySelectorAll !== 'function') return;
    let active = null;
    modal.querySelectorAll('.set-rail-item').forEach(item => {
      const on = item.dataset.section === sectionId;
      item.classList.toggle('active', on);
      if (on) active = item;
    });
    modal.querySelectorAll('.set-jump-row').forEach(row => {
      row.classList.toggle('active', row.dataset.section === sectionId);
    });
    const label = document.getElementById('appSettingsJump')?.querySelector('.set-jump-label');
    if (label && active) label.textContent = active.textContent.trim();
    const ico = document.getElementById('appSettingsJump')?.querySelector('.set-jump-ico');
    const src = active?.querySelector('svg');
    if (ico && src) ico.innerHTML = src.innerHTML;
  },

  /**
   * Wire the settings navigation once per page: rail clicks, the phone jump
   * menu, scroll-spy, live search, chip/card/segment views over the real inputs,
   * and the collapsible Advanced group. Idempotent — openAppSettings() calls it
   * on every open, and re-registering listeners on every open would multiply
   * them across a long-lived tab.
   */
  _initSettingsNav() {
    const modal = document.getElementById('appSettingsModal');
    const doc = document.getElementById('appSettingsDoc');
    if (!modal || !doc || typeof modal.querySelectorAll !== 'function') return;
    this._buildModelCards();
    this._buildEffortSegment();
    // Rebuilt on every open: admin-ui.js appends its Users entry to the rail
    // after the first open, and the menu must not drift from the rail.
    this._buildSettingsJumpMenu();
    if (modal.dataset.navReady === '1') return;
    modal.dataset.navReady = '1';

    // Delegated so rail entries injected later (Users) work without rewiring.
    modal.querySelector('.set-rail-items')?.addEventListener('click', e => {
      const item = e.target.closest?.('.set-rail-item');
      if (item?.dataset.section) this.switchSettingsTab(item.dataset.section);
    });
    document.getElementById('appSettingsJumpMenu')?.addEventListener('click', e => {
      const row = e.target.closest?.('.set-jump-row');
      if (!row?.dataset.section) return;
      this._toggleSettingsJump(false);
      this.switchSettingsTab(row.dataset.section);
    });
    document.getElementById('appSettingsJump')?.addEventListener('click', () => this._toggleSettingsJump());
    document.getElementById('appSettingsJumpVeil')?.addEventListener('click', () => this._toggleSettingsJump(false));

    // Scroll-spy: the rail follows the document rather than driving it.
    doc.addEventListener('scroll', () => {
      if (this._settingsSpyQueued) return;
      this._settingsSpyQueued = true;
      requestAnimationFrame(() => {
        this._settingsSpyQueued = false;
        const sections = [...doc.querySelectorAll('.set-section')].filter(s => s.offsetParent !== null);
        if (!sections.length) return;
        let current = sections[0].id;
        for (const s of sections) {
          if (s.offsetTop - doc.scrollTop <= 140) current = s.id;
        }
        this._setActiveSettingsSection(current);
      });
    });

    const search = document.getElementById('appSettingsSearch');
    search?.addEventListener('input', () => this._filterSettings(search.value));

    // Chips are labels wrapping the real checkbox; mirror the checked state onto
    // the label so the styling does not depend on :has() support.
    modal.querySelectorAll('.set-chip input').forEach(input => {
      input.addEventListener('change', () => this._syncSettingsChips());
    });

    const advHead = modal.querySelector('.set-group-head-toggle');
    const advGroup = advHead?.closest('.set-group-advanced');
    if (advHead && advGroup) {
      const toggle = () => {
        const open = advGroup.classList.toggle('open');
        advHead.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      advHead.addEventListener('click', toggle);
      advHead.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    }

    document.getElementById('appSettingsOpusContext1m')?.addEventListener('change', () => this._applyModelSelection());
  },

  /** Phone jump menu, mirrored from the rail so the two can never drift. */
  _buildSettingsJumpMenu() {
    const modal = document.getElementById('appSettingsModal');
    const menu = document.getElementById('appSettingsJumpMenu');
    if (!modal || !menu) return;
    menu.innerHTML = '';
    modal.querySelectorAll('.set-rail-item').forEach(item => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'set-jump-row';
      row.dataset.section = item.dataset.section;
      row.innerHTML = item.innerHTML;
      const section = document.getElementById(item.dataset.section);
      const count = section ? section.querySelectorAll('input, select').length : 0;
      if (count) {
        const n = document.createElement('span');
        n.className = 'set-jump-count';
        n.textContent = String(count);
        row.appendChild(n);
      }
      menu.appendChild(row);
    });
  },

  _toggleSettingsJump(force) {
    const modal = document.getElementById('appSettingsModal');
    if (!modal) return;
    const open = force === undefined ? !modal.classList.contains('jump-open') : force;
    modal.classList.toggle('jump-open', open);
    document.getElementById('appSettingsJump')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  },

  /**
   * Mirror checkbox state onto the chip labels (see _initSettingsNav).
   *
   * Covers Session Options too: it shares the `set-*` surface, and its cycle-step
   * chips would otherwise depend on `:has()` alone for their checked styling.
   */
  _syncSettingsChips() {
    document.querySelectorAll('#appSettingsModal .set-chip, #sessionOptionsModal .set-chip').forEach(chip => {
      chip.classList.toggle('is-on', !!chip.querySelector('input')?.checked);
    });
    this._syncLayoutPreview();
  },

  /**
   * Redraw the Header & Panels live preview from the chips above it.
   *
   * The preview is a scale model of the app, not a second list of settings, so
   * every icon is CLONED from the chip that owns it (`.set-chip-ico`): each icon
   * has exactly ONE copy in index.html and a chip can never drift from the button
   * it previews. A chip joins the preview purely by carrying `data-preview`
   * (which slot) and `data-preview-order` (where in that slot); nothing here
   * needs to know the setting's name.
   *
   * `data-preview-text` replaces the icon with a text token for the header
   * entries that are readouts rather than buttons (plan usage, CPU, font size).
   */
  _syncLayoutPreview() {
    const modal = document.getElementById('appSettingsModal');
    if (!modal || typeof modal.querySelectorAll !== 'function') return;
    const slots = {
      header: document.getElementById('appSettingsPreviewHeader'),
      panel: document.getElementById('appSettingsPreviewPanels'),
      toolbar: document.getElementById('appSettingsPreviewToolbar'),
      float: document.getElementById('appSettingsPreviewFloats'),
    };
    if (!slots.header) return;
    Object.values(slots).forEach(el => {
      if (el) el.innerHTML = '';
    });

    const chips = [...modal.querySelectorAll('.set-chip[data-preview]')]
      .filter(chip => chip.querySelector('input')?.checked)
      .sort((a, b) => (Number(a.dataset.previewOrder) || 0) - (Number(b.dataset.previewOrder) || 0));

    let shown = 0;
    for (const chip of chips) {
      const kind = chip.dataset.preview;
      const slot = slots[kind];
      if (!slot) continue;
      // The label is the chip's own text; the icon span (if any) is skipped by
      // taking the LAST span, which is always the label.
      const spans = chip.querySelectorAll('span');
      const label = (spans[spans.length - 1]?.textContent || '').trim();
      const el = document.createElement('span');
      el.title = label;
      if (kind === 'header') {
        const text = chip.dataset.previewText;
        el.className = text ? 'set-preview-chip' : 'set-preview-btn';
        if (text) el.textContent = text;
        else this._appendPreviewIcon(el, chip);
      } else {
        el.className = `set-preview-${kind}`;
        this._appendPreviewIcon(el, chip);
        const name = document.createElement('span');
        name.textContent = label;
        el.appendChild(name);
      }
      slot.appendChild(el);
      shown++;
    }

    const empty = document.getElementById('appSettingsPreviewEmpty');
    if (empty) empty.hidden = shown > 0;
  },

  /** Clone a chip's icon into a preview element (see _syncLayoutPreview). */
  _appendPreviewIcon(target, chip) {
    const icon = chip.querySelector('.set-chip-ico');
    if (!icon) return;
    const clone = icon.cloneNode(true);
    clone.classList.remove('set-chip-ico');
    clone.classList.add('set-preview-ico');
    target.appendChild(clone);
  },

  /**
   * Build the model picker cards from the hidden <select>'s own options, so the
   * select stays the single source of truth that openAppSettings/saveAppSettings
   * read and write by id. The `[1m]` variants are folded away: context width is a
   * property of the chosen model (the "1M context window" switch), not a rival
   * setting that silently loses to it.
   */
  _buildModelCards() {
    const select = document.getElementById('appSettingsClaudeModel');
    const grid = document.getElementById('appSettingsModelCards');
    if (!select || !grid || grid.dataset.built === '1' || !select.options) return;
    grid.innerHTML = '';
    [...select.options]
      .filter(opt => opt.dataset.variant !== '1m')
      .forEach(opt => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'set-modelcard';
        card.setAttribute('role', 'radio');
        card.dataset.value = opt.value;
        if (opt.dataset.ctx === '1') card.dataset.ctx = '1';
        const top = document.createElement('span');
        top.className = 'set-mc-top';
        const name = document.createElement('span');
        name.className = 'set-mc-name';
        name.textContent = opt.textContent;
        top.appendChild(name);
        const dot = document.createElement('span');
        dot.className = 'set-mc-dot';
        top.appendChild(dot);
        card.appendChild(top);
        const meta = document.createElement('span');
        meta.className = 'set-mc-meta';
        meta.textContent = opt.dataset.meta || '';
        card.appendChild(meta);
        if (opt.dataset.ctx === '1') {
          const ctx = document.createElement('span');
          ctx.className = 'set-mc-ctx';
          ctx.textContent = '1M capable';
          card.appendChild(ctx);
        }
        card.addEventListener('click', () => {
          this._settingsModelBase = opt.value;
          this._applyModelSelection();
        });
        grid.appendChild(card);
      });
    grid.dataset.built = '1';
  },

  /** Derive card + context-switch state from the select's stored value. */
  _syncModelCards() {
    const select = document.getElementById('appSettingsClaudeModel');
    if (!select) return;
    const value = select.value || '';
    this._settingsModelBase = value.endsWith('[1m]') ? value.slice(0, -4) : value;
    if (value.endsWith('[1m]')) {
      const ctx = document.getElementById('appSettingsOpusContext1m');
      if (ctx) ctx.checked = true;
    }
    this._applyModelSelection();
  },

  /** Compose card + context switch back into the select's value. */
  _applyModelSelection() {
    const select = document.getElementById('appSettingsClaudeModel');
    const grid = document.getElementById('appSettingsModelCards');
    if (!select || !grid) return;
    const base = this._settingsModelBase || '';
    let capable = false;
    grid.querySelectorAll('.set-modelcard').forEach(card => {
      const on = card.dataset.value === base;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-checked', on ? 'true' : 'false');
      if (on) capable = card.dataset.ctx === '1';
    });
    const ctxOn = !!document.getElementById('appSettingsOpusContext1m')?.checked;
    select.value = base && capable && ctxOn ? `${base}[1m]` : base;
    // A model with no 1M variant makes the switch inert; say so instead of
    // leaving a toggle that looks like it does something.
    const row = document.getElementById('appSettingsContextRow');
    const desc = document.getElementById('appSettingsContextDesc');
    const inert = !!base && !capable;
    row?.classList.toggle('set-row-disabled', inert);
    if (desc) {
      desc.textContent = inert
        ? 'The selected model has no 1M variant.'
        : base
          ? 'Available for Fable 5.1, Fable 5, Opus and Opus 4.6.'
          : 'With no model pinned, this starts new sessions on Opus with a 1M window.';
    }
  },

  _buildEffortSegment() {
    const select = document.getElementById('appSettingsThinkingEffort');
    const seg = document.getElementById('appSettingsEffortSegment');
    if (!select || !seg || seg.dataset.built === '1' || !select.options) return;
    seg.innerHTML = '';
    [...select.options].forEach(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.dataset.value = opt.value;
      btn.textContent = opt.textContent;
      btn.addEventListener('click', () => {
        select.value = opt.value;
        this._syncEffortSegment();
      });
      seg.appendChild(btn);
    });
    seg.dataset.built = '1';
  },

  _syncEffortSegment() {
    const select = document.getElementById('appSettingsThinkingEffort');
    const seg = document.getElementById('appSettingsEffortSegment');
    if (!select || !seg) return;
    seg.querySelectorAll('button').forEach(btn => {
      const on = btn.dataset.value === (select.value || '');
      btn.classList.toggle('selected', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  },

  /**
   * Live filter across every section. Everything stays mounted (that is the
   * point of the single-document layout), so a search only hides units that do
   * not match, then collapses groups and sections left with nothing visible.
   */
  _filterSettings(query) {
    const doc = document.getElementById('appSettingsDoc');
    if (!doc) return;
    const q = (query || '').trim().toLowerCase();
    const UNIT = '.set-row, .set-chip, .set-modelgrid, .set-minigrid, .event-type-grid, #appSettingsShortcutsList';
    const units = [...doc.querySelectorAll(UNIT)];
    let anyVisible = false;

    units.forEach(unit => {
      if (!q) {
        unit.classList.remove('set-hit-hidden');
        return;
      }
      const hay = `${unit.dataset?.search || ''} ${unit.textContent || ''}`.toLowerCase();
      const hit = hay.includes(q);
      unit.classList.toggle('set-hit-hidden', !hit);
      if (hit) anyVisible = true;
    });

    // A chip wrapper is only empty when every chip inside it is hidden.
    doc.querySelectorAll('.set-chips').forEach(wrap => {
      const hasVisible = [...wrap.querySelectorAll('.set-chip')].some(c => !c.classList.contains('set-hit-hidden'));
      wrap.classList.toggle('set-hit-hidden', !!q && !hasVisible);
    });

    doc.querySelectorAll('.set-group').forEach(group => {
      const hasVisible = [...group.querySelectorAll(UNIT)].some(u => !u.classList.contains('set-hit-hidden'));
      group.classList.toggle('set-hit-hidden', !!q && !hasVisible);
      // An Advanced group that matches must open, or the hit stays invisible.
      if (q && hasVisible) group.classList.add('open');
    });

    doc.querySelectorAll('.set-section').forEach(section => {
      const hasVisible = [...section.querySelectorAll('.set-group')].some(g => !g.classList.contains('set-hit-hidden'));
      section.classList.toggle('set-hit-hidden', !!q && !hasVisible);
    });

    // The live preview sits outside any group, so it survives the sweep above;
    // a search is asking for one row, not for the scale model around it.
    doc.querySelectorAll('.set-preview').forEach(pv => pv.classList.toggle('set-hit-hidden', !!q));

    const empty = document.getElementById('appSettingsSearchEmpty');
    if (empty) empty.hidden = !q || anyVisible;
    if (!q) doc.querySelectorAll('.set-group-advanced').forEach(g => g.classList.remove('open'));
  },

  closeAppSettings() {
    this._toggleSettingsJump(false);
    document.getElementById('appSettingsModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  },

  // ───────────────────────────────────────────────────────────────
  // Self-Update (App Settings → Updates). Backend: src/web/self-update.ts.
  // ───────────────────────────────────────────────────────────────

  /** Friendly label for an in-flight update phase. */
  _updatePhaseText(phase) {
    return {
      queued: 'Queued…',
      preparing: 'Preparing…',
      stashing: 'Stashing local changes…',
      fetching: 'Fetching release…',
      checkout: 'Checking out release…',
      installing: 'Installing dependencies…',
      building: 'Building…',
      restarting: 'Restarting Codeman…',
    }[phase] || phase;
  },

  /** Populate the version row and clear transient UI when the modal opens. */
  _initUpdatesSection() {
    const verEl = this.$('updateCurrentVersion');
    if (verEl) verEl.textContent = (this.$('versionDisplay')?.textContent || '').trim() || '—';
    for (const id of ['updateResult', 'updateActionRow', 'updateNotes', 'updateProgress']) {
      const el = this.$(id);
      if (el) el.style.display = 'none';
    }
    this._updateCheck = null;
  },

  _setUpdateResult(html) {
    const el = this.$('updateResult');
    if (el) { el.style.display = 'block'; el.innerHTML = html; }
  },

  _setUpdateProgress(html) {
    const el = this.$('updateProgress');
    if (el) { el.style.display = 'block'; el.innerHTML = html; }
  },

  /** Manual "Check for updates" — asks the server to query GitHub. */
  async checkForUpdate() {
    const btn = this.$('updateCheckBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    const data = await this._apiJson('/api/system/update/check');
    if (btn) { btn.disabled = false; btn.textContent = 'Check now'; }

    const actionRow = this.$('updateActionRow');
    const notes = this.$('updateNotes');
    if (actionRow) actionRow.style.display = 'none';
    if (notes) notes.style.display = 'none';

    if (!data) {
      this._setUpdateResult('Could not check for updates. Try again later.');
      return;
    }
    this._updateCheck = data;
    const verEl = this.$('updateCurrentVersion');
    if (verEl && data.currentVersion) verEl.textContent = `v${data.currentVersion}`;

    // `docker-compose` self-updates in place like `git` does — the container
    // restarts itself. Anything else cannot.
    if (data.installKind && data.installKind !== 'git' && data.installKind !== 'docker-compose') {
      const hint =
        data.supervisor === 'docker-compose'
          ? 'Update from the Docker host with <code>docker/Start-Codeman.sh</code>.'
          : 'Update with <code>npm i -g aicodeman@latest</code>.';
      this._setUpdateResult(`This install can't update itself (${escapeHtml(data.installKind)}). ${hint}`);
      return;
    }
    if (data.selfUpdateEnabled === false) {
      this._setUpdateResult('In-app updates are disabled on this server (CODEMAN_DISABLE_SELF_UPDATE=1).');
      return;
    }
    if (data.error && !data.updateAvailable) {
      this._setUpdateResult(escapeHtml(data.error));
      return;
    }
    // A container release that changes the ENVIRONMENT (Dockerfile, compose file
    // or new .env keys) cannot be applied by the container restarting itself, so
    // the update button is never offered — the host command is, instead. The
    // server re-checks this on POST, so hiding the button is UX, not the gate.
    const blockers = data.environment?.blockers || [];
    if (data.updateAvailable && blockers.length > 0) {
      const reasons = blockers
        .map((b) => {
          const details = b.details?.length ? `<br><code>${escapeHtml(b.details.join(' '))}</code>` : '';
          return `<li>${escapeHtml(b.message)}${details}</li>`;
        })
        .join('');
      this._setUpdateResult(
        `<strong>v${escapeHtml(data.latestVersion || '')}</strong> needs a rebuild on the Docker host` +
          ` (current v${escapeHtml(data.currentVersion || '')}):<ul>${reasons}</ul>` +
          `Run <code>${escapeHtml(data.environment?.hostCommand || 'docker/Start-Codeman.sh')}</code> there to apply it.`
      );
      if (notes && data.notes) {
        notes.style.display = 'block';
        notes.textContent = data.notes;
      }
      return;
    }

    if (data.updateAvailable && data.latestVersion) {
      this._setUpdateResult(
        `Update available: <strong>v${escapeHtml(data.latestVersion)}</strong> &nbsp;(current v${escapeHtml(data.currentVersion || '')})`
      );
      const label = this.$('updateActionLabel');
      if (label) label.textContent = `Update to v${data.latestVersion}`;
      if (actionRow) actionRow.style.display = 'flex';
      const nowBtn = this.$('updateNowBtn');
      if (nowBtn) { nowBtn.disabled = false; nowBtn.textContent = 'Update now'; }
      if (notes && data.notes) {
        notes.style.display = 'block';
        notes.textContent = data.notes;
      }
    } else {
      this._setUpdateResult(`You're up to date (v${escapeHtml(data.currentVersion || '')}).`);
    }
  },

  /** Start the update, then poll status across the service restart. */
  async startSelfUpdate() {
    const target = this._updateCheck?.latestVersion ? `v${this._updateCheck.latestVersion}` : 'the latest release';
    if (!confirm(`Update Codeman to ${target}? The server will restart and this page will reload.`)) return;

    const btn = this.$('updateNowBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    const res = await this._apiPost('/api/system/update', {});
    if (!res || !res.ok) {
      let msg = 'Failed to start the update.';
      try { const j = await res.json(); if (typeof j?.error === 'string' && j.error) msg = j.error; } catch {}
      this._setUpdateProgress(`<span style="color:var(--danger,#e5534b)">${escapeHtml(msg)}</span>`);
      if (btn) { btn.disabled = false; btn.textContent = 'Update now'; }
      return;
    }
    const actionRow = this.$('updateActionRow');
    if (actionRow) actionRow.style.display = 'none';
    const notes = this.$('updateNotes');
    if (notes) notes.style.display = 'none';
    this._setUpdateProgress('Starting update…');
    this._pollUpdateStatus();
  },

  _stopUpdatePolling() {
    if (this._updatePollTimer) { clearInterval(this._updatePollTimer); this._updatePollTimer = null; }
  },

  /**
   * Poll the status file every 1.5s. Survives the connection drop while the
   * server restarts (fetch throws → "restarting"), then reads the reconciled
   * terminal state from the freshly-booted server.
   */
  _pollUpdateStatus() {
    this._stopUpdatePolling();
    const terminal = new Set(['completed', 'completed-needs-manual-restart', 'failed', 'idle']);
    const poll = async () => {
      let data = null;
      try {
        const res = await fetch('/api/system/update/status');
        if (res.ok) {
          const env = await res.json();
          data = env && env.success === true ? env.data : env;
        }
      } catch { /* server restarting — keep polling */ }

      if (!data) {
        this._setUpdateProgress('↻ Restarting Codeman…');
        return;
      }
      if (!terminal.has(data.phase)) {
        // Prefer the live status message — the updater's heartbeat enriches it with
        // the latest npm/build output line so a slow step doesn't look frozen — and
        // fall back to the static phase label. Append total elapsed so the counter
        // keeps ticking between heartbeats: a clear "still working" signal.
        const label = (data.message && data.message.trim()) ? data.message.trim() : this._updatePhaseText(data.phase);
        let elapsed = '';
        if (data.startedAt) {
          const secs = Math.max(0, Math.round((Date.now() - data.startedAt) / 1000));
          elapsed = ` <span style="color:var(--text-secondary)">· ${secs}s</span>`;
        }
        this._setUpdateProgress(`<span class="tunnel-spinner"></span> ${escapeHtml(label)}${elapsed}`);
        return;
      }
      this._stopUpdatePolling();
      if (data.phase === 'completed') {
        let html = `<span style="color:var(--success,#3fb950)">✓ Updated to v${escapeHtml(data.toVersion || '')}. Reloading…</span>`;
        if (data.stashRef) {
          html += `<br><span style="color:var(--text-secondary)">Local changes stashed as <code>${escapeHtml(data.stashRef)}</code> — run <code>git stash pop</code> to restore.</span>`;
        }
        this._setUpdateProgress(html);
        setTimeout(() => location.reload(), 2500);
      } else if (data.phase === 'completed-needs-manual-restart') {
        this._setUpdateProgress(
          `Update staged. Restart Codeman to apply:<br><code>${escapeHtml(data.manualRestartCommand || 'restart codeman web')}</code>`
        );
      } else if (data.phase === 'failed') {
        let html = `<span style="color:var(--danger,#e5534b)">✗ ${escapeHtml(data.message || 'Update failed')}.</span>`;
        if (data.error) html += `<br><span style="color:var(--text-secondary)">${escapeHtml(data.error)}</span>`;
        html += `<br><span style="color:var(--text-secondary)">The previous version is still running.</span>`;
        if (data.stashRef) {
          html += `<br><span style="color:var(--text-secondary)">Local changes stashed as <code>${escapeHtml(data.stashRef)}</code>.</span>`;
        }
        this._setUpdateProgress(html);
        const nowBtn = this.$('updateNowBtn');
        const actionRow = this.$('updateActionRow');
        if (nowBtn) { nowBtn.disabled = false; nowBtn.textContent = 'Try again'; }
        if (actionRow) actionRow.style.display = 'flex';
      }
    };
    poll();
    this._updatePollTimer = setInterval(poll, 1500);
  },

  /**
   * Is `tool` installed on the server? Reads `window.__codemanCliAvailable`,
   * injected by renderIndexHtml (see the comment there for why this is injected
   * rather than fetched per surface).
   *
   * Unknown reads as AVAILABLE. A missing flag means the page was rendered by a
   * build that predates the injection, or by a solo popup: hiding every run
   * button on a doubt would leave nothing to click, and the pre-existing failure
   * mode for a genuinely missing CLI is just an error toast.
   */
  isCliAvailable(tool) {
    const flags = window.__codemanCliAvailable;
    if (!flags || typeof flags !== 'object') return true;
    return flags[tool] !== false;
  },

  /**
   * #200: show a welcome-screen button only where the thing it launches exists.
   * The markup ships them hidden, so an old cached page can never flash a button
   * for a tool this server does not have.
   */
  applyWelcomeCliVisibility() {
    const buttons = [
      ['welcomeClaudeBtn', 'claude'],
      ['welcomeOpencodeBtn', 'opencode'],
      ['welcomeAntigravityBtn', 'antigravity'],
      ['welcomeOmpBtn', 'omp'],
      ['welcomeGeminiBtn', 'gemini'],
      ['welcomePiBtn', 'pi'],
      ['welcomeGrokBtn', 'grok'],
      ['welcomeDeepSeekBtn', 'deepseek'],
      // Not a run mode, same reasoning: offering a Cloudflare Tunnel on a box
      // without cloudflared can only ever produce "cloudflared not found".
      ['welcomeTunnelBtn', 'cloudflared'],
    ];
    for (const [id, tool] of buttons) {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = this.isCliAvailable(tool) ? 'flex' : 'none';
    }
  },

  async loadTunnelStatus() {
    try {
      const res = await fetch('/api/tunnel/status');
      const env = await res.json();
      const status = env?.success === true ? env.data : env;
      const active = status.running && status.url;
      this._tunnelUrl = active ? status.url : null;
      this._updateTunnelUrlDisplay(this._tunnelUrl);
      this._updateWelcomeTunnelBtn(!!active, this._tunnelUrl);
      this._updateTunnelIndicator(!!active);
    } catch {
      this._tunnelUrl = null;
      this._updateTunnelUrlDisplay(null);
      this._updateWelcomeTunnelBtn(false);
      this._updateTunnelIndicator(false);
    }
  },

  _updateTunnelUrlRow(rowId, displayId, url, suffix = '') {
    const row = document.getElementById(rowId);
    const display = document.getElementById(displayId);
    if (!row || !display) return;
    if (url) {
      const fullUrl = url + suffix;
      row.style.display = '';
      display.textContent = fullUrl;
      display.onclick = () => {
        navigator.clipboard.writeText(fullUrl).then(() => {
          this.showToast(`${suffix ? 'Upload' : 'Tunnel'} URL copied`, 'success');
        });
      };
    } else {
      row.style.display = 'none';
      display.textContent = '';
      display.onclick = null;
    }
  },

  _updateTunnelUrlDisplay(url) {
    this._updateTunnelUrlRow('tunnelUrlRow', 'tunnelUrlDisplay', url);
    this._updateTunnelUrlRow('tunnelUploadUrlRow', 'tunnelUploadUrlDisplay', url, '/upload.html');
  },

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
      .then(env => {
        const data = env?.success === true ? env.data : env;
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
      .then(env => {
        const status = env?.success === true ? env.data : env;
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
  },

  closeTunnelQR() {
    const overlay = document.getElementById('tunnelQrOverlay');
    if (overlay) overlay.remove();
    if (this._tunnelQrEscHandler) {
      document.removeEventListener('keydown', this._tunnelQrEscHandler);
      this._tunnelQrEscHandler = null;
    }
    this._clearQrCountdown();
  },

  /** Fallback: fetch QR SVG from API when SSE payload lacks it */
  _refreshTunnelQrFromApi() {
    fetch('/api/tunnel/qr')
      .then(res => res.ok ? res.json() : null)
      .then(env => {
        const data = env?.success === true ? env.data : env;
        if (!data?.svg) return;
        const container = document.getElementById('tunnelQrContainer');
        if (container) container.innerHTML = data.svg;
        const welcomeInner = document.getElementById('welcomeQrInner');
        if (welcomeInner) welcomeInner.innerHTML = data.svg;
      })
      .catch(() => {});
  },

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
  },

  _updateQrCountdownText() {
    const badge = document.getElementById('tunnelQrBadge');
    if (badge) {
      badge.textContent = `Single-use auth \u00b7 expires in ${this._qrCountdownSec}s`;
    }
  },

  _clearQrCountdown() {
    if (this._qrCountdownTimer) {
      clearInterval(this._qrCountdownTimer);
      this._qrCountdownTimer = null;
    }
  },

  async toggleTunnelFromWelcome() {
    const btn = document.getElementById('welcomeTunnelBtn');
    if (!btn) return;
    const isActive = btn.classList.contains('active');
    btn.disabled = true;
    try {
      const newEnabled = !isActive;
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelEnabled: newEnabled }),
      });
      // COD-55: server refuses an unauthenticated public tunnel (403). Surface it.
      if (newEnabled && (await this._handleTunnelEnableRefusal(res))) {
        this._dismissTunnelConnecting();
        this._updateWelcomeTunnelBtn(false);
        btn.disabled = false;
        return;
      }
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
  },

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
  },

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
  },

  _pollTunnelStatus(attempt = 0) {
    if (attempt > 15) return; // give up after ~30s
    this._tunnelPollTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/tunnel/status');
        const env = await res.json();
        const status = env?.success === true ? env.data : env;
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
  },

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
        .then(env => { const data = env?.success === true ? env.data : env; if (data.svg) qrInner.innerHTML = data.svg; })
        .catch(() => { qrInner.innerHTML = '<div style="color:#999;font-size:11px;padding:20px">QR unavailable</div>'; });
    } else {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.remove('visible', 'expanded');
      qrInner.innerHTML = '';
      if (qrUrl) qrUrl.textContent = '';
    }
  },

  toggleWelcomeQrSize() {
    const qrWrap = document.getElementById('welcomeQr');
    if (qrWrap) {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.toggle('expanded');
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Tunnel Header Indicator & Panel (desktop only)
  // ═══════════════════════════════════════════════════════════════

  _updateTunnelIndicator(active) {
    if (MobileDetection.getDeviceType() === 'mobile') return;
    const indicator = document.getElementById('tunnelIndicator');
    if (!indicator) return;
    indicator.style.display = active ? 'flex' : 'none';
    indicator.classList.remove('connecting');
  },

  toggleTunnelPanel() {
    const existing = document.getElementById('tunnelPanel');
    if (existing) {
      this.closeTunnelPanel();
      return;
    }
    this._openTunnelPanel();
  },

  async _openTunnelPanel() {
    const panel = document.createElement('div');
    panel.className = 'tunnel-panel';
    panel.id = 'tunnelPanel';
    panel.innerHTML = `
      <div class="tunnel-panel-header">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Cloudflare Tunnel
          <span class="tunnel-panel-status" id="tunnelPanelStatus">Loading...</span>
        </h3>
      </div>
      <div class="tunnel-panel-body" id="tunnelPanelBody">
        <div style="font-size:12px;color:var(--text-muted);padding:8px 0">Loading...</div>
      </div>
    `;
    document.body.appendChild(panel);

    // Close on outside click
    this._tunnelPanelClickHandler = (e) => {
      if (!panel.contains(e.target) && e.target.id !== 'tunnelIndicator' && !e.target.closest('.tunnel-indicator')) {
        this.closeTunnelPanel();
      }
    };
    setTimeout(() => document.addEventListener('click', this._tunnelPanelClickHandler), 0);

    // Close on Escape
    this._tunnelPanelEscHandler = (e) => { if (e.key === 'Escape') this.closeTunnelPanel(); };
    document.addEventListener('keydown', this._tunnelPanelEscHandler);

    // Fetch tunnel info
    try {
      const res = await fetch('/api/tunnel/info');
      const env = await res.json();
      const info = env?.success === true ? env.data : env;
      this._renderTunnelPanel(info);
    } catch {
      const body = document.getElementById('tunnelPanelBody');
      if (body) body.innerHTML = '<div style="font-size:12px;color:var(--red);padding:8px 0">Failed to load tunnel info</div>';
    }
  },

  _renderTunnelPanel(info) {
    const statusEl = document.getElementById('tunnelPanelStatus');
    const body = document.getElementById('tunnelPanelBody');
    if (!statusEl || !body) return;

    statusEl.textContent = info.running ? 'Connected' : 'Offline';
    statusEl.className = 'tunnel-panel-status' + (info.running ? '' : ' offline');

    let html = '';

    // URL section
    if (info.url) {
      html += `
        <div class="tunnel-panel-section">
          <div class="tunnel-panel-label">URL</div>
          <div class="tunnel-panel-url" id="tunnelPanelUrl" title="Click to copy">${escapeHtml(info.url)}</div>
        </div>`;
    }

    // Clients section
    html += `
      <div class="tunnel-panel-section">
        <div class="tunnel-panel-label">Connections</div>
        <div class="tunnel-panel-stat">
          <span>Remote Clients</span>
          <span class="tunnel-panel-stat-value">${info.sseClients}</span>
        </div>`;

    if (info.authEnabled) {
      html += `
        <div class="tunnel-panel-stat">
          <span>Auth Sessions</span>
          <span class="tunnel-panel-stat-value">${info.authSessions.length}</span>
        </div>`;
    }
    html += '</div>';

    // Auth sessions detail
    if (info.authEnabled && info.authSessions.length > 0) {
      html += '<div class="tunnel-panel-section"><div class="tunnel-panel-label">Authenticated Devices</div>';
      for (const s of info.authSessions) {
        const ua = s.ua || 'Unknown';
        const browser = ua.match(/Chrome|Firefox|Safari|Edge|Mobile/)?.[0] || 'Browser';
        const ago = this._formatTimeAgo(s.createdAt);
        html += `
          <div class="tunnel-panel-session">
            <span class="tunnel-panel-session-dot"></span>
            <span class="tunnel-panel-session-info" title="${escapeHtml(ua)}">${escapeHtml(browser)} &middot; ${escapeHtml(s.ip)} &middot; ${ago}</span>
            <span class="tunnel-panel-session-method">${s.method}</span>
          </div>`;
      }
      html += '</div>';
    }

    // Actions
    html += '<div class="tunnel-panel-actions">';
    if (info.running) {
      html += `
        <button class="tunnel-panel-btn btn-qr" onclick="app.showTunnelQR();app.closeTunnelPanel()">QR Code</button>
        <button class="tunnel-panel-btn btn-stop" onclick="app._tunnelPanelToggle(false)">Stop Tunnel</button>`;
    } else {
      html += `<button class="tunnel-panel-btn btn-start" onclick="app._tunnelPanelToggle(true)">Start Tunnel</button>`;
    }
    html += '</div>';

    // Revoke all sessions button
    if (info.authEnabled && info.authSessions.length > 0) {
      html += `
        <div style="padding-top:8px">
          <button class="tunnel-panel-btn btn-revoke" style="width:100%" onclick="app._tunnelPanelRevokeAll()">Revoke All Sessions</button>
        </div>`;
    }

    body.innerHTML = html;

    // Bind URL copy handler
    const urlEl = document.getElementById('tunnelPanelUrl');
    if (urlEl) {
      urlEl.onclick = () => {
        navigator.clipboard.writeText(info.url).then(() => this.showToast('Tunnel URL copied', 'success'));
      };
    }
  },

  _formatTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  },

  /**
   * COD-55: detect the server's refusal to start an unauthenticated public tunnel.
   * The PUT /api/settings route returns a 4xx with { success:false, error } when no
   * CODEMAN_PASSWORD is set and the unauthenticated-network opt-in is not acknowledged.
   * Shows the server's (actionable) message as an error toast.
   * @param {Response|null} res - the fetch Response from the settings PUT
   * @returns {Promise<boolean>} true if the tunnel-enable was refused (caller should abort)
   */
  async _handleTunnelEnableRefusal(res) {
    if (!res || res.ok) return false;
    let message = 'Tunnel refused: set CODEMAN_PASSWORD before exposing Codeman publicly.';
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* non-JSON body — use the default message */
    }
    // 403 = the no-password safety refusal (COD-55). Warn loudly and let the
    // operator acknowledge the risk; on confirm, retry with explicit acknowledgment.
    if (res.status === 403) {
      const confirmed = confirm(
        '⚠️ SECURITY WARNING — no password set\n\n' +
          'Enabling the Cloudflare tunnel will publish THIS machine to a public URL with ' +
          'NO login. Anyone who gets the URL has full terminal control — effectively remote ' +
          'code execution on your computer.\n\n' +
          'Strongly recommended: set CODEMAN_PASSWORD instead.\n\n' +
          'Enable the unauthenticated public tunnel anyway?'
      );
      if (!confirmed) {
        this._dismissTunnelConnecting?.();
        this.showToast('Tunnel not enabled', 'info');
        return true;
      }
      try {
        const retry = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tunnelEnabled: true, acknowledgeUnauthTunnel: true }),
        });
        if (retry.ok) {
          this.showToast('Public tunnel enabling — no password set ⚠️', 'warning');
          return false; // proceed with the caller's success/connecting path
        }
        let m = 'Failed to enable tunnel.';
        try {
          const b = await retry.json();
          if (b && b.error) m = b.error;
        } catch {
          /* non-JSON */
        }
        this._dismissTunnelConnecting?.();
        this.showToast(m, 'error');
        return true;
      } catch {
        this._dismissTunnelConnecting?.();
        this.showToast('Failed to enable tunnel', 'error');
        return true;
      }
    }
    this._dismissTunnelConnecting?.();
    this.showToast(message, 'error');
    return true;
  },

  async _tunnelPanelToggle(enable) {
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelEnabled: enable }),
      });
      // COD-55: server refuses an unauthenticated public tunnel (403). Surface it.
      if (enable && (await this._handleTunnelEnableRefusal(res))) {
        this.closeTunnelPanel();
        return;
      }
      if (enable) {
        this._updateTunnelIndicator(false);
        const indicator = document.getElementById('tunnelIndicator');
        if (indicator) {
          indicator.style.display = 'flex';
          indicator.classList.add('connecting');
        }
        this.showToast('Tunnel starting...', 'info');
        this._showTunnelConnecting();
        this._pollTunnelStatus();
      } else {
        this.showToast('Tunnel stopped', 'info');
      }
      this.closeTunnelPanel();
    } catch {
      this.showToast('Failed to toggle tunnel', 'error');
    }
  },

  async _tunnelPanelRevokeAll() {
    try {
      await fetch('/api/auth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      this.showToast('All sessions revoked', 'success');
      // Refresh panel
      const res = await fetch('/api/tunnel/info');
      const env = await res.json();
      const info = env?.success === true ? env.data : env;
      this._renderTunnelPanel(info);
    } catch {
      this.showToast('Failed to revoke sessions', 'error');
    }
  },

  closeTunnelPanel() {
    const panel = document.getElementById('tunnelPanel');
    if (panel) panel.remove();
    if (this._tunnelPanelClickHandler) {
      document.removeEventListener('click', this._tunnelPanelClickHandler);
      this._tunnelPanelClickHandler = null;
    }
    if (this._tunnelPanelEscHandler) {
      document.removeEventListener('keydown', this._tunnelPanelEscHandler);
      this._tunnelPanelEscHandler = null;
    }
  },

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
  },


  // ═══════════════════════════════════════════════════════════════
  // Session Lifecycle Log
  // ═══════════════════════════════════════════════════════════════

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
  },

  closeLifecycleLog() {
    document.getElementById('lifecycleWindow').style.display = 'none';
  },

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
  },

  async loadLifecycleLog() {
    const eventFilter = document.getElementById('lifecycleFilterEvent').value;
    const sessionFilter = document.getElementById('lifecycleFilterSession').value.trim();
    const params = new URLSearchParams();
    if (eventFilter) params.set('event', eventFilter);
    if (sessionFilter) params.set('sessionId', sessionFilter);
    params.set('limit', '300');

    try {
      const res = await fetch(`/api/session-lifecycle?${params}`);
      const env = await res.json();
      const data = env?.success === true ? env.data : env;
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
        const name = e.name || (e.sessionId === '*' ? '—' : this.getShortId(e.sessionId));
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
  },

  /**
   * Paint both Voice status rows: which provider a mic press would use, and what
   * the server reports about its Claude login. Called on open and again once the
   * /api/voice/status probe resolves.
   */
  _renderVoiceProviderStatus() {
    const providerEl = document.getElementById('voiceProviderStatus');
    if (providerEl) {
      const providerName = VoiceInput.getActiveProviderName();
      providerEl.textContent = providerName;
      const live = providerName.startsWith('Deepgram Nova') || providerName.startsWith('Claude (this');
      providerEl.className = 'voice-provider-status' + (live ? ' active' : '');
    }
    const claudeEl = document.getElementById('voiceClaudeStatus');
    if (!claudeEl) return;
    const status = VoiceInput._claudeStatus;
    const text = !status
      ? 'Checking...'
      : status.available
        ? `Ready${status.subscriptionType ? ` (${status.subscriptionType})` : ''}`
        : status.reason === 'expired'
          ? 'Login expired - run a Claude session to refresh'
          : status.reason === 'no-credentials'
            ? 'No Claude Code login on the server'
            : status.reason === 'malformed'
              ? 'Claude credentials unreadable'
              : 'Off - enable it above';
    claudeEl.textContent = text;
    claudeEl.className = 'voice-provider-status' + (status?.available ? ' active' : '');
  },

  async saveAppSettings() {
    // Gesture overlay is injected at page render (server-side), so a change to it
    // only takes effect on reload — remember the prior value to decide below.
    const _prev = this.loadAppSettingsFromStorage();
    const _prevGestureEnabled = (_prev.gestureControlEnabled ?? false) === true;
    // WebGL toggle: default ON (desktop), so only an explicit stored false counts
    // as "previously off" — used below to detect a real OFF→ON flip.
    const _prevWebglEnabled = (_prev.webglRendererEnabled ?? true) === true;
    const settings = {
      displayName: window.CodemanI18n?.normalizeDisplayName(
        document.getElementById('appSettingsDisplayName').value
      ) || 'Codeman',
      language: window.CodemanI18n?.normalizeLanguage(
        document.getElementById('appSettingsLanguage').value
      ) || 'en',
      defaultClaudeMdPath: document.getElementById('appSettingsClaudeMdPath').value.trim(),
      defaultWorkingDir: document.getElementById('appSettingsDefaultDir').value.trim(),
      ralphTrackerEnabled: document.getElementById('appSettingsRalphEnabled').checked,
      // Header visibility settings
      showFontControls: document.getElementById('appSettingsShowFontControls').checked,
      showSystemStats: document.getElementById('appSettingsShowSystemStats').checked,
      showLifecycleLog: document.getElementById('appSettingsShowLifecycleLog').checked,
      showResponseViewer: document.getElementById('appSettingsShowResponseViewer').checked,
      showFileViewerButton: document.getElementById('appSettingsShowFileViewerButton').checked,
      showAttachmentsButton: document.getElementById('appSettingsShowAttachmentsButton').checked,
      showMonitor: document.getElementById('appSettingsShowMonitor').checked,
      showProjectInsights: document.getElementById('appSettingsShowProjectInsights').checked,
      showFileBrowser: document.getElementById('appSettingsShowFileBrowser').checked,
      showSubagents: document.getElementById('appSettingsShowSubagents').checked,
      showUltracodeAgents: document.getElementById('appSettingsShowUltracodeAgents').checked,
      approvalsInboxEnabled: document.getElementById('appSettingsApprovalsInbox').checked,
      readMyMindEnabled: document.getElementById('appSettingsReadMyMind').checked,
      ultracodeFloatingWindows: document.getElementById('appSettingsUltracodeFloatingWindows').checked,
      showMultiMonitorButton: document.getElementById('appSettingsShowMultiMonitorButton').checked,
      showPlanUsageLimits: document.getElementById('appSettingsShowPlanUsageLimits').checked,
      showRedrawButton: document.getElementById('appSettingsShowRedrawButton').checked,
      mobileOverviewEnabled: document.getElementById('appSettingsMobileOverview').checked,
      sessionLineageLines: document.getElementById('appSettingsLineageLines').checked,
      showSessionButton: document.getElementById('appSettingsShowSessionButton').checked,
      showAwayDigestButton: document.getElementById('appSettingsShowAwayDigestButton').checked,
      showCronButton: document.getElementById('appSettingsShowCronButton').checked,
      gestureControlEnabled: document.getElementById('appSettingsGestureControl').checked,
      subagentTrackingEnabled: document.getElementById('appSettingsSubagentTracking').checked,
      subagentActiveTabOnly: document.getElementById('appSettingsSubagentActiveTabOnly').checked,
      imageWatcherEnabled: document.getElementById('appSettingsImageWatcherEnabled').checked,
      tunnelEnabled: document.getElementById('appSettingsTunnelEnabled').checked,
      localEchoEnabled: document.getElementById('appSettingsLocalEcho').checked,
      autoCopySelection: document.getElementById('appSettingsAutoCopySelection').checked,
      terminalFontFamily: document.getElementById('appSettingsTerminalFont').value.trim(),
      terminalWheelLocalScrollback: document.getElementById('appSettingsTerminalWheelLocal').checked,
      cjkInputEnabled: document.getElementById('appSettingsCjkInput').checked,
      webglRendererEnabled: document.getElementById('appSettingsWebglRenderer').checked,
      extendedKeyboardBar: document.getElementById('appSettingsExtendedKeyboardBar').checked,
      tabTwoRows: document.getElementById('appSettingsTabTwoRows').checked,
      tabOrientation: document.getElementById('appSettingsTabOrientation').value,
      tabRailWidth: this.readTabRailWidthSetting?.() ?? 256,
      tabRailDetail: document.getElementById('appSettingsTabRailDetail').value,
      showTabDetachButton: document.getElementById('appSettingsShowTabDetachButton').checked,
      sessionListLayout: document.getElementById('appSettingsSessionListLayout').value,
      sessionSidebarFontSize: this.resolveSessionSidebarFontSize(
        document.getElementById('appSettingsSessionSidebarFontSize').value
      ),
      skin: document.getElementById('appSettingsSkin').value,
      // Claude CLI settings
      claudeMode: document.getElementById('appSettingsClaudeMode').value,
      allowedTools: document.getElementById('appSettingsAllowedTools').value.trim(),
      // Codex CLI settings
      codexDangerouslyBypassApprovals: document.getElementById('appSettingsCodexDangerouslyBypassApprovals').checked,
      codexAnimationsEnabled: document.getElementById('appSettingsCodexAnimations').checked,
      // Claude Permissions settings
      agentTeamsEnabled: document.getElementById('appSettingsAgentTeams').checked,
      agentSkillEnabled: document.getElementById('appSettingsAgentSkill').checked,
      workspaceHooksEnabled: document.getElementById('appSettingsWorkspaceHooks').checked,
      claudeVoiceEnabled: document.getElementById('appSettingsClaudeVoice').checked,
      claudeModel: document.getElementById('appSettingsClaudeModel').value,
      opusContext1mEnabled: document.getElementById('appSettingsOpusContext1m').checked,
      remoteAutoReconnect: document.getElementById('appSettingsRemoteAutoReconnect').checked,
      thinkingEffort: document.getElementById('appSettingsThinkingEffort').value,
      // CPU Priority settings
      nice: {
        enabled: document.getElementById('appSettingsNiceEnabled').checked,
        niceValue: parseInt(document.getElementById('appSettingsNiceValue').value) || 10,
      },
    };

    // The "Token Count" / "Show Cost ($)" header toggles were removed from the
    // UI, but their features still read settings.showTokenCount / settings.showCost
    // (applyHeaderVisibilitySettings, the header cost render). saveAppSettings
    // rebuilds `settings` fresh from the DOM (a full replacement, not a merge), so
    // without this these keys would be DROPPED on every save and fall back to their
    // defaults — silently re-enabling the token chip for anyone who'd turned it off,
    // with no UI left to turn it back off. Preserve the prior stored preference.
    if (_prev.showTokenCount !== undefined) settings.showTokenCount = _prev.showTokenCount;
    if (_prev.showCost !== undefined) settings.showCost = _prev.showCost;
    // Shortcut overrides are edited from the Shortcuts tab (not rebuilt from the
    // general-settings DOM), so the fresh rebuild would drop them on every save.
    if (_prev.shortcutOverrides !== undefined) settings.shortcutOverrides = _prev.shortcutOverrides;

    // Save to localStorage
    this.saveAppSettingsToStorage(settings);
    this._updateLocalEchoState();
    this.applyTerminalFontFamily?.(settings.terminalFontFamily);

    // A real OFF→ON flip of the WebGL toggle retires the GPU-stall auto-fallback
    // marker so the next reload actually re-tries WebGL. Only the transition
    // clears it — an incidental save with the checkbox default-checked must NOT
    // defeat the sticky safety net (shouldSkipWebGL treats stored true like the
    // untouched default at page load).
    if (!_prevWebglEnabled && settings.webglRendererEnabled) {
      try { localStorage.removeItem('codeman-webgl-disabled'); } catch {}
    }

    // Save voice settings to localStorage + include in server payload for cross-device sync
    const voiceSettings = {
      provider: document.getElementById('voiceProvider').value,
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
      _version: 5,
    };
    if (this.notificationManager) {
      this.notificationManager.preferences = notifPrefsToSave;
      this.notificationManager.savePreferences();
    }

    // Sync push preferences to server
    this._syncPushPreferences();

    // Apply header visibility immediately
    this.applyHeaderVisibilitySettings();
    this.applySkin();
    this.applyLocalization();
    // Re-parents #sessionTabs between header host and sidebar if the layout
    // changed, then calls applyTabWrapSettings() itself — do not call both.
    this.applySessionListLayout();
    this.applyTabOrientation({ settleRailWidth: true });
    this.applyLineageLineSettings?.();
    this._updateTokensImmediate();  // Re-render token display (picks up showCost change)
    this.applyMonitorVisibility();
    this.renderApprovals?.();  // Approvals Inbox toggle (hide/show bell + drawer)
    this.renderProjectInsightsPanel();  // Re-render to apply visibility setting
    this.updateSubagentWindowVisibility();  // Apply subagent window visibility setting

    // Apply CJK input visibility immediately
    this._updateCjkInputState();

    // The phone home surface (overview vs welcome) may have just been toggled.
    // Only re-decide while a home screen is actually up.
    if (!this.activeSessionId) this.showWelcome();

    // Apply keyboard bar mode
    KeyboardAccessoryBar.setMode(settings.extendedKeyboardBar ? 'extended' : 'simple');

    // Save to server (includes notification prefs for cross-browser persistence).
    // Strip device-specific DISPLAY keys so they never sync across devices —
    // localEcho/cjk/extendedKeyboard/skin are per-platform, and showPlanUsageLimits
    // is per-device too (desktop can show the usage chip while mobile stays hidden).
    // webglRendererEnabled is per-device as well (renderer choice is GPU-specific,
    // and syncing would leak mobile's hidden-checkbox false onto desktop); it's
    // also absent from SettingsUpdateSchema, which is .strict() — sending it
    // would 400 the whole settings PUT.
    // Telemetry COLLECTION is requested out-of-band via statusLineTelemetry (sent on
    // ENABLE only, so a device with the chip OFF never strips the exporter that
    // another device's chip depends on — see system-routes settings handler).
    const {
      localEchoEnabled: _leo,
      cjkInputEnabled: _cjk,
      extendedKeyboardBar: _ekb,
      skin: _skin,
      language: _language,
      showPlanUsageLimits: _pul,
      showAttachmentsButton: _ahb,
      showFileViewerButton: _fvb,
      webglRendererEnabled: _wgl,
      terminalWheelLocalScrollback: _twls,
      // Copy-on-select. Per-device (clipboard access differs by device and by
      // origin: the plain-HTTP LAN install has no navigator.clipboard at all)
      // and absent from SettingsUpdateSchema (.strict()), so sending it would
      // 400 the whole settings PUT.
      autoCopySelection: _acs,
      // Per-device by nature (the font must exist on the device) and absent
      // from SettingsUpdateSchema (.strict()) — sending it would 400 the PUT.
      terminalFontFamily: _tff,
      // Per-device header/toolbar button toggles — client-only, and absent from
      // SettingsUpdateSchema (.strict()), so sending them would 400 the PUT.
      showSessionButton: _ssb,
      showAwayDigestButton: _adb,
      showCronButton: _crb,
      showTabDetachButton: _tdb,
      // Phone-only home surface, and absent from SettingsUpdateSchema (.strict()).
      mobileOverviewEnabled: _mov,
      // Desktop-only tab decoration, per-device, and likewise absent from the
      // .strict() schema — syncing it would push a desktop-shaped choice onto
      // devices that cannot render it at all.
      sessionLineageLines: _sll,
      ...serverSettings
    } = settings;
    try {
      const res = await this._apiPut('/api/settings', {
        ...serverSettings,
        ...(settings.showPlanUsageLimits ? { statusLineTelemetry: true } : {}),
        notificationPreferences: notifPrefsToSave,
        voiceSettings,
      });

      // COD-55: the server refuses an unauthenticated public tunnel with a 403 — which
      // rejects the WHOLE settings PUT. Surface the message and revert the tunnel toggle
      // (in the UI + localStorage) so it doesn't look enabled. Other settings persisted
      // to localStorage above still apply locally.
      if (settings.tunnelEnabled && (await this._handleTunnelEnableRefusal(res))) {
        settings.tunnelEnabled = false;
        this.saveAppSettingsToStorage(settings);
        const cb = document.getElementById('appSettingsTunnelEnabled');
        if (cb) cb.checked = false;
        this.closeAppSettings();
        return;
      }

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

    // Voice availability is a server-side answer, so re-probe after a save:
    // otherwise the mic keeps using the pre-save provider until the next reload.
    VoiceInput.refreshClaudeStatus();

    // The gesture overlay is injected at page render (server reads
    // gestureControlEnabled from settings.json), so a change only takes effect on
    // reload. Reload when it actually changed — the server PUT above already
    // persisted the new value.
    if (settings.gestureControlEnabled !== _prevGestureEnabled) {
      this.showToast(
        settings.gestureControlEnabled ? 'Enabling gesture control — reloading…' : 'Disabling gesture control — reloading…',
        'info'
      );
      setTimeout(() => location.reload(), 400);
    }
  },

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
          defaultModelEl.value = config.defaultModel || '';
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
  },

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
      defaultModel: defaultModelEl?.value || '',
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
  },


  // ═══════════════════════════════════════════════════════════════
  // Visibility Settings & Device-Specific Defaults
  // ═══════════════════════════════════════════════════════════════

  // Get the global Ralph tracker enabled setting
  isRalphTrackerEnabledByDefault() {
    const settings = this.loadAppSettingsFromStorage();
    return settings.ralphTrackerEnabled ?? false;
  },

  // Keep the settings namespace stable across foldable posture changes. Layout
  // still follows viewport width, but an unfolded phone remains the same
  // handheld device and must not silently switch to desktop preferences.
  getSettingsStorageKey() {
    const isHandheld =
      MobileDetection.isHandheldDevice?.() ?? MobileDetection.getDeviceType() === 'mobile';
    return isHandheld ? 'codeman-app-settings-mobile' : 'codeman-app-settings';
  },

  // Get default settings based on device type
  // Note: Notification prefs are handled separately by NotificationManager
  getDefaultSettings() {
    const isHandheld =
      MobileDetection.isHandheldDevice?.() ?? MobileDetection.getDeviceType() === 'mobile';
    if (isHandheld) {
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
        showUltracodeAgents: false,
        ultracodeFloatingWindows: false,
        showMultiMonitorButton: false,
        // Desktop defaults this ON (see planUsageChipEnabled); handhelds keep it
        // OFF so the phone header stays minimal and the mobile-header-buttons
        // policy guard keeps passing.
        showPlanUsageLimits: false,
        showAttachmentsButton: false,
        showFileViewerButton: false,
        showRedrawButton: false,
        showSessionButton: false,
        showAwayDigestButton: false,
        showCronButton: false,
        // Phone home screen: the C logo opens the session overview instead of the
        // welcome screen. ON by default here, and the escape hatch if it ever
        // misbehaves on a device (the gate treats only an explicit false as off).
        mobileOverviewEnabled: true,
        // Remote auto-reconnect (COD-108) — on by default
        remoteAutoReconnect: true,
        // Input
        gestureControlEnabled: false,
        // Feature toggles - keep tracking on even on mobile
        subagentTrackingEnabled: true,
        subagentActiveTabOnly: true, // Only show subagents for active tab
        imageWatcherEnabled: false,
        ralphTrackerEnabled: false,
        tabTwoRows: false,
        tabOrientation: 'horizontal',
        tabRailWidth: 256,
        tabRailDetail: 'rich',
        sessionListLayout: 'header',
        sessionSidebarFontSize: 12,
        cjkInputEnabled: false,
        terminalWheelLocalScrollback: false, // mobile scrolls via touch, not wheel
        webglRendererEnabled: false, // mobile always uses the DOM renderer
        skin: 'daylight-blue',
      };
    }
    // Desktop defaults - rely on ?? operators in apply functions
    // This allows desktop to have different defaults without duplication
    return {};
  },

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
  },

  saveAppSettingsToStorage(settings) {
    // Invalidate cache on save
    this._cachedAppSettings = settings;
    try {
      const key = this.getSettingsStorageKey();
      localStorage.setItem(key, JSON.stringify(settings));
    } catch (err) {
      console.error('Failed to save app settings:', err);
    }
  },

  // Apply the chosen skin live: sets the html[data-skin] attribute, syncs BOTH
  // localStorage locations (the standalone 'codeman:skin' key the pre-paint head
  // script reads + the app-settings blob field written by saveAppSettingsToStorage),
  // updates window.__codemanSkin, and re-themes any live terminals.
  applySkin() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const skin = settings.skin ?? defaults.skin ?? 'daylight-blue';
    document.documentElement.setAttribute('data-skin', skin);
    window.__codemanSkin = skin;
    const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-dark').trim();
    if (themeColor) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
    try {
      localStorage.setItem('codeman:skin', skin);
    } catch (_e) {
      /* private mode */
    }
    if (typeof this.applyTerminalSkin === 'function') this.applyTerminalSkin(skin);
  },

  // Apply the per-device language and the synced user-facing product name.
  // The i18n layer updates both existing static nodes and future dynamic DOM.
  applyLocalization() {
    const settings = this.loadAppSettingsFromStorage();
    const result = window.CodemanI18n?.configure({
      language: settings.language,
      displayName: settings.displayName,
    });
    if (result && this.notificationManager) {
      this.notificationManager.originalTitle = document.title;
    }
  },

  // Resolved per-device state of the plan-usage chip. Desktop defaults ON,
  // handhelds default OFF (the mobile block in getDefaultSettings() sets false,
  // and the mobile-header-buttons-policy guard depends on that staying false).
  // Single source of truth for THREE call sites that must never disagree: the
  // App Settings checkbox, the chip's visibility, and the statusLineTelemetry
  // flag sent on session create. A chip shown without telemetry renders "—"
  // forever, which is exactly the drift this helper prevents.
  planUsageChipEnabled(settings = null) {
    const s = settings ?? this.loadAppSettingsFromStorage();
    return s.showPlanUsageLimits ?? this.getDefaultSettings().showPlanUsageLimits ?? true;
  },

  applyHeaderVisibilitySettings() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();

    // Tab pop-out (open-in-new-window) button: opt-in (App Settings → Tab Bar,
    // default OFF, per-device). Mirrored as a class on <html>: styles.css hides
    // .tab-detach without it (a tab that is already detached keeps its icon as
    // the re-focus affordance for the popped-out window).
    const showTabDetach = settings.showTabDetachButton ?? defaults.showTabDetachButton ?? false;
    document.documentElement.classList.toggle('tabs-show-detach', showTabDetach);
    const compactHeader = MobileDetection.getDeviceType() !== 'desktop';
    const showFontControls = compactHeader ? false : (settings.showFontControls ?? defaults.showFontControls ?? false);
    const showSystemStats = compactHeader ? false : (settings.showSystemStats ?? defaults.showSystemStats ?? true);
    // Default OFF: the header stays gear + usage chips + files button unless a
    // stored preference explicitly re-enables the token chip (no UI toggle exists).
    const showTokenCount = compactHeader ? false : (settings.showTokenCount ?? defaults.showTokenCount ?? false);

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
    // Default OFF: the lifecycle-log document icon is opt-in; the default header
    // keeps only WS/CPU/MEM, the file-viewer folder, usage chips, and the gear.
    const showLifecycleLog = settings.showLifecycleLog ?? defaults.showLifecycleLog ?? false;
    const lifecycleBtn = document.querySelector('.btn-lifecycle-log');
    if (lifecycleBtn) {
      lifecycleBtn.style.display = showLifecycleLog ? '' : 'none';
    }

    // Hide the response viewer (eye) button when setting is disabled.
    // Marker class, not inline style — the base rule is display:inline-flex !important.
    const showResponseViewer = settings.showResponseViewer ?? defaults.showResponseViewer ?? false;
    const responseViewerBtn = document.querySelector('.btn-response-viewer-header');
    if (responseViewerBtn) {
      responseViewerBtn.classList.toggle('btn-response-viewer-header--hidden', !showResponseViewer);
    }

    // Hide the attachments (history) button when disabled. Opt-in, default OFF —
    // marker class, base is display:inline-flex !important.
    const showAttachmentsButton = settings.showAttachmentsButton ?? defaults.showAttachmentsButton ?? false;
    const attachmentsBtn = document.getElementById('attachmentsHistoryBtn');
    if (attachmentsBtn) {
      attachmentsBtn.classList.toggle('btn-attachments-history--hidden', !showAttachmentsButton);
    }

    // File Viewer header button — opt-in, default OFF. Marker class (base is
    // display:inline-flex !important); clicking it toggles the file browser panel.
    // Default ON (desktop): the folder button is part of the standard header now;
    // phones still hide it via mobile.css (btn-file-viewer in the phone-hidden set).
    const showFileViewerButton = settings.showFileViewerButton ?? defaults.showFileViewerButton ?? true;
    const fileViewerBtn = document.querySelector('.btn-file-viewer');
    if (fileViewerBtn) {
      fileViewerBtn.classList.toggle('btn-file-viewer--hidden', !showFileViewerButton);
    }

    // Multi-monitor button — hidden by default (App Settings → Display → "Header
    // Displays"). The server renders the correct initial state on every reload;
    // this handles a live toggle from a settings save (no reload). Toggle the
    // marker class (matches the server-side reveal) rather than an inline style.
    const showMultiMonitorButton = settings.showMultiMonitorButton ?? defaults.showMultiMonitorButton ?? false;
    const multiMonitorBtn = document.querySelector('.btn-multimonitor');
    if (multiMonitorBtn) {
      multiMonitorBtn.classList.toggle('btn-multimonitor--hidden', !showMultiMonitorButton);
    }

    // Ultracode/Workflow agents launcher — hidden by default; reveal when enabled.
    // Marker class only (base is display:inline-flex !important) so it's auto-excluded
    // from the mobile-header-buttons-policy guard.
    const showUltracodeAgents = settings.showUltracodeAgents ?? defaults.showUltracodeAgents ?? false;
    const ultracodeBtn = document.querySelector('.btn-ultracode-agents');
    if (ultracodeBtn) {
      ultracodeBtn.classList.toggle('btn-ultracode-agents--hidden', !showUltracodeAgents);
    }

    // Read My Mind 🧠 — hidden unless the synced opt-in `readMyMindEnabled` is
    // ON (only an explicit true enables, mirroring the Approvals bell). Marker
    // class (base is display:inline-flex !important); phones hide it in
    // mobile.css regardless (their surface is the keyboard-accessory 🧠 key,
    // re-synced right below).
    const readMyMindBtn = document.querySelector('.btn-readmymind');
    if (readMyMindBtn) {
      readMyMindBtn.classList.toggle('btn-readmymind--hidden', settings.readMyMindEnabled !== true);
    }
    // The accessory-bar 🧠 key shares the setting; its marker class lives on
    // the bar element (keyboard-accessory.js), so a live toggle from a
    // settings save reveals/hides it without a reload.
    if (typeof KeyboardAccessoryBar !== 'undefined') KeyboardAccessoryBar.syncReadMyMind?.();

    // Plan-usage chip — shown by default on desktop, OFF on handhelds (App
    // Settings → Display → "Plan Usage Limits"). The template always ships it
    // hidden because display is per-device and the server cannot know a
    // localStorage value, so THIS is what reveals it on every load as well as
    // on a live toggle. Marker class (base is display:inline-flex !important),
    // matching the response-viewer/multimonitor pattern.
    const showPlanUsageLimits = this.planUsageChipEnabled(settings);
    const planUsageChip = document.getElementById('planUsageChip');
    if (planUsageChip) {
      planUsageChip.classList.toggle('header-plan-usage--hidden', !showPlanUsageLimits);
    }

    const showRedrawButton = settings.showRedrawButton ?? defaults.showRedrawButton ?? false;
    const redrawBtn = document.querySelector('.btn-redraw-terminal');
    if (redrawBtn) {
      redrawBtn.classList.toggle('btn-redraw-terminal--hidden', !showRedrawButton);
    }

    // Session Manager button — opt-in, hidden by default (App Settings → Display).
    // Marker class (base is display:inline-flex !important); phones keep it hidden
    // via mobile.css regardless. Sessions stay reachable via the Ctrl+K palette.
    const showSessionButton = settings.showSessionButton ?? defaults.showSessionButton ?? false;
    const sessionBtn = document.querySelector('.btn-session-manager');
    if (sessionBtn) {
      sessionBtn.classList.toggle('btn-session-manager--hidden', !showSessionButton);
    }

    // Away Digest button — opt-in, hidden by default. Same marker pattern.
    const showAwayDigestButton = settings.showAwayDigestButton ?? defaults.showAwayDigestButton ?? false;
    const awayDigestBtn = document.querySelector('.btn-away-digest');
    if (awayDigestBtn) {
      awayDigestBtn.classList.toggle('btn-away-digest--hidden', !showAwayDigestButton);
    }

    // Cron button (footer toolbar) — opt-in, hidden by default. Same marker pattern.
    const showCronButton = settings.showCronButton ?? defaults.showCronButton ?? false;
    const cronBtn = document.querySelector('.btn-cron');
    if (cronBtn) {
      cronBtn.classList.toggle('btn-cron--hidden', !showCronButton);
    }

    // Notification bell is retired (notifications live in Settings → Notifications
    // + the drawer); keep it hidden regardless of the notification-enabled state.
    const notifBtn = document.querySelector('.btn-notifications');
    if (notifBtn) {
      notifBtn.style.display = 'none';
    }
    // Close the drawer if notifications got disabled while it's open
    const notifEnabled = this.notificationManager?.preferences?.enabled ?? true;
    if (!notifEnabled) {
      const drawer = document.getElementById('notifDrawer');
      if (drawer) drawer.classList.remove('open');
    }
  },

  applyTabOrientation(options = {}) {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const sidebarOwnsTabs = this.isSessionSidebarActive?.() === true;
    const orientation =
      !this.isSoloWindow && !sidebarOwnsTabs && window.CodemanTabOverflow?.resolveTabOrientation
        ? window.CodemanTabOverflow.resolveTabOrientation({
            deviceType: MobileDetection.getDeviceType(),
            setting: settings.tabOrientation ?? defaults.tabOrientation ?? 'horizontal',
          })
        : 'horizontal';

    const root = document.documentElement;
    const previous = root.getAttribute('data-tab-orientation') || 'horizontal';
    root.setAttribute('data-tab-orientation', orientation);

    // Row detail rides on its OWN attribute, exactly like the sidebar's
    // data-sidebar-detail: every html[data-tab-orientation='vertical'] rule in
    // styles.css keeps matching both variants untouched, and the gate in app.js
    // reads one attribute instead of re-parsing localStorage per tab.
    const previousDetail = root.dataset.tabRailDetail || 'rich';
    const detail = (settings.tabRailDetail ?? defaults.tabRailDetail ?? 'rich') === 'simple' ? 'simple' : 'rich';
    root.dataset.tabRailDetail = detail;

    const tabsEl = document.getElementById('sessionTabs');
    const rail = document.getElementById('tabRail');
    const headerHost = document.getElementById('sessionTabsHost');
    if (!sidebarOwnsTabs && tabsEl && rail && headerHost) {
      if (orientation === 'vertical') {
        if (tabsEl.parentElement !== rail) rail.appendChild(tabsEl);
      } else if (tabsEl.parentElement !== headerHost) {
        headerHost.appendChild(tabsEl);
      }
    }
    if (tabsEl) {
      tabsEl.setAttribute('aria-orientation', sidebarOwnsTabs || orientation === 'vertical' ? 'vertical' : 'horizontal');
    }

    const settleRailWidth =
      options.settleRailWidth === true && (orientation === 'vertical' || previous !== orientation);
    this.applyTabRailWidth?.({ settle: settleRailWidth });
    const orientationChanged = previous !== orientation;
    // A detail flip counts as a change on its own: simple ⟷ detailed leaves the
    // orientation on 'vertical' both times, and the stamps line is emitted by
    // the row template, not toggled by CSS — same reasoning as the sidebar's
    // detail half in applySessionListLayout(). Taller rows also move every
    // connector anchored to a tab rect.
    const changed = orientationChanged || previousDetail !== detail;
    if (orientationChanged) {
      this.updateTabOverflowMode?.();
      if (!settleRailWidth) this.fitAddon?.fit();
    }
    // applyTabWrapSettings() is the ONE owner of tabs-show-folder and is
    // rail-aware, so it has to run AFTER the two attributes above — the
    // applySessionListLayout() call that precedes this one on the settings-save
    // path ran while data-tab-rail-detail still held the old value. It
    // re-renders by itself when the folder row appears or disappears, which is
    // why the render below is skipped in that case rather than doubled.
    const prevTall = this._tallTabsEnabled;
    if (changed) this.applyTabWrapSettings?.();
    if (changed) {
      // Mirror of applyTabWrapSettings()'s OWN render condition, which is
      // `prevTallTabs !== undefined && prevTallTabs !== showFolder`: its first
      // call ever only establishes the baseline and deliberately renders
      // nothing. Reading an undefined previous value as "it rendered" skips
      // BOTH renders and leaves the rows stale — reachable whenever this is the
      // first call, i.e. when the pre-paint script threw and left the
      // attributes on their fallbacks for applyTabOrientation() to correct.
      const wrapRendered = prevTall !== undefined && prevTall !== this._tallTabsEnabled;
      if (!wrapRendered) this._fullRenderSessionTabs?.();
      this._updateConnectionLinesImmediate?.();
      this._refreshHomeSessionsIfVisible?.();
    }
    // Only detailed rows carry stamps that go stale with no event behind them.
    // _fullRenderSessionTabs() settles this too, but applyTabOrientation() runs
    // on paths where nothing re-rendered (boot with the layout already applied).
    if (this.isRichTabRows?.()) this._startSidebarRichClock?.();
    else this._stopSidebarRichClock?.();
  },

  applyTabWrapSettings() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const deviceType = MobileDetection.getDeviceType();
    // The left sidebar is one vertical column with its own scroller: there is no
    // row to wrap into, and its rows are always tall (name + folder) because that
    // is the cheapest way to tell 25 sessions apart. Header strip keeps the old
    // rules unchanged. Kept here rather than only in applySessionListLayout() so
    // that a stray applyTabWrapSettings() call (this one is invoked from
    // saveAppSettings and from the resize path) cannot leave the sidebar wrapped.
    // Matches BOTH sidebar variants: isSessionSidebarActive() reads
    // data-session-list, which applySessionListLayout() sets to 'sidebar' for
    // 'sidebar' and 'sidebar-rich' alike. Row detail rides on a separate
    // attribute and has no bearing on wrapping.
    const sidebar = this.isSessionSidebarActive?.() === true;
    // Two-row tabs disabled on mobile/tablet — not enough screen space
    const twoRows = !sidebar && deviceType === 'desktop'
      ? (settings.tabTwoRows ?? defaults.tabTwoRows ?? false)
      : false;
    // The DETAILED vertical rail is the third tall-row surface, for the same
    // reason as the sidebar: it is a docked column with a row per session, and
    // the stamps line below the name says nothing about WHICH project the
    // session is in. Read from the applied attribute, which applyTabOrientation()
    // has already written (app.js calls it before this).
    const railRich = this.isTabRailRich?.() === true;
    const showFolder = sidebar || twoRows || railRich;
    const prevTallTabs = this._tallTabsEnabled;
    this._tallTabsEnabled = showFolder;
    const tabsEl = document.getElementById('sessionTabs');
    if (tabsEl) {
      tabsEl.classList.toggle('tabs-two-rows', twoRows);
      tabsEl.classList.toggle('tabs-show-folder', showFolder);
    }
    // Re-render tabs if folder visibility changed (folder spans are generated in JS)
    if (prevTallTabs !== undefined && prevTallTabs !== showFolder) {
      this._fullRenderSessionTabs();
    }
  },

  applyMonitorVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const showMonitor = settings.showMonitor ?? defaults.showMonitor ?? false;
    const showSubagents = settings.showSubagents ?? defaults.showSubagents ?? false;
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

    // Ultracode agents panel visibility (SYNCED setting — not in displayKeys)
    const showUltracodeAgents = settings.showUltracodeAgents ?? defaults.showUltracodeAgents ?? false;
    const ultracodePanel = document.getElementById('ultracodeAgentsPanel');
    if (ultracodePanel) {
      if (showUltracodeAgents) {
        ultracodePanel.classList.remove('hidden');
      } else {
        ultracodePanel.classList.remove('open');
        ultracodePanel.classList.add('hidden');
      }
    }
    // Floating ultracode run windows have their OWN opt-in (default OFF), independent of the
    // docked panel above: pop active runs when enabled, tear them all down when disabled
    // (additional layer — ultracode-windows.js).
    const ultracodeFloatingWindows = settings.ultracodeFloatingWindows ?? defaults.ultracodeFloatingWindows ?? false;
    if (ultracodeFloatingWindows) {
      if (typeof this.syncAllUltracodeFloatingWindows === 'function') this.syncAllUltracodeFloatingWindows();
    } else if (typeof this.removeAllUltracodeWindows === 'function') {
      this.removeAllUltracodeWindows();
    }

    // File browser panel visibility
    const fileBrowserPanel = document.getElementById('fileBrowserPanel');
    if (fileBrowserPanel) {
      if (showFileBrowser && this.activeSessionId) {
        fileBrowserPanel.classList.add('visible');
        this.loadFileBrowser(this.activeSessionId);
        // Attach drag listeners if not already attached
        if (!this.fileBrowserDragListeners) {
          const header = fileBrowserPanel.querySelector('.file-browser-header');
          if (header) {
            // Convert right-positioned to left/top before drag so makeWindowDraggable works
            const onFirstDrag = () => {
              if (!fileBrowserPanel.style.left) {
                const rect = fileBrowserPanel.getBoundingClientRect();
                fileBrowserPanel.style.left = `${rect.left}px`;
                fileBrowserPanel.style.top = `${rect.top}px`;
                fileBrowserPanel.style.right = 'auto';
              }
            };
            header.addEventListener('mousedown', onFirstDrag);
            header.addEventListener('touchstart', onFirstDrag, { passive: true });
            this.fileBrowserDragListeners = this.makeWindowDraggable(fileBrowserPanel, header);
            this.fileBrowserDragListeners._onFirstDrag = onFirstDrag;
          }
        }
      } else if (fileBrowserPanel.classList.contains('visible')) {
        this._resetFileBrowserForHide?.();
        fileBrowserPanel.classList.remove('visible');
      }
    }
  },

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
  },

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
  },

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
  },

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
  },

  async loadAppSettingsFromServer(settingsPromise = null) {
    // One-time migration: showPlanUsageLimits became a per-device display setting.
    // Before this, it synced from the server, so the (separate) mobile settings blob
    // may carry a stale `true` the user never enabled on this device. Clear it once
    // so mobile defaults to OFF; the desktop blob is untouched and keeps its value.
    try {
      if (
        (MobileDetection.isHandheldDevice?.() ?? MobileDetection.getDeviceType() === 'mobile') &&
        !localStorage.getItem('codeman:planUsagePerDeviceMigrated')
      ) {
        const s = this.loadAppSettingsFromStorage();
        if (s && s.showPlanUsageLimits) {
          s.showPlanUsageLimits = false;
          this.saveAppSettingsToStorage(s);
        }
        localStorage.setItem('codeman:planUsagePerDeviceMigrated', '1');
      }
    } catch {
      /* best-effort migration */
    }
    try {
      const settings = settingsPromise ? await settingsPromise : await fetch('/api/settings').then(r => r.ok ? r.json() : null).then(env => env?.success === true ? env.data : env);
      if (settings) {
        // Extract notification prefs before merging app settings
        const { notificationPreferences, voiceSettings, respawnPresets, runMode, ...appSettings } = settings;
        // Filter out display settings — these are device-specific (mobile vs desktop)
        // and should not be synced from the server to avoid overriding mobile defaults.
        // NOTE: Feature toggles (subagentTrackingEnabled, imageWatcherEnabled, ralphTrackerEnabled)
        // are NOT display keys — they control server-side behavior and must sync from server.
        const displayKeys = new Set([
          'showFontControls', 'showSystemStats', 'showTokenCount', 'showCost',
          'showLifecycleLog', 'showResponseViewer', 'showRedrawButton',
          'showMonitor', 'showProjectInsights', 'showFileBrowser', 'showSubagents',
          'subagentActiveTabOnly', 'tabTwoRows', 'tabOrientation', 'tabRailWidth', 'tabRailDetail', 'sessionListLayout', 'sessionSidebarFontSize', 'localEchoEnabled', 'cjkInputEnabled', 'extendedKeyboardBar',
          'skin', 'showPlanUsageLimits', 'showAttachmentsButton', 'showFileViewerButton', 'webglRendererEnabled',
          'terminalFontFamily',
          'language',
          'terminalWheelLocalScrollback',
          'autoCopySelection',
          'showSessionButton', 'showAwayDigestButton', 'showCronButton',
          'showTabDetachButton',
          'mobileOverviewEnabled',
          'sessionLineageLines',
        ]);
        // The plan-usage chip is a PER-DEVICE display setting (desktop default ON,
        // handheld default OFF): desktop can show it while mobile stays hidden. It
        // used to sync, so an older server.json may still carry a value — drop it
        // so the server value is NEVER
        // seeded into a device that didn't explicitly enable it (collection is handled
        // separately via the statusLineTelemetry action, not this display flag).
        delete appSettings.showPlanUsageLimits;
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
            this.notificationManager.preferences =
              this.notificationManager.normalizePreferences(notificationPreferences);
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

        // Sync respawn presets from server (server is source of truth)
        if (respawnPresets && Array.isArray(respawnPresets)) {
          this._serverRespawnPresets = respawnPresets;
          // Also update localStorage for offline access
          localStorage.setItem('codeman-respawn-presets', JSON.stringify(respawnPresets));
        } else {
          // Migration: push existing localStorage presets to server
          const localPresets = localStorage.getItem('codeman-respawn-presets');
          if (localPresets) {
            const parsed = JSON.parse(localPresets);
            if (parsed.length > 0) {
              this._serverRespawnPresets = parsed;
              this._apiPut('/api/settings', { respawnPresets: parsed }).catch(() => {});
            }
          }
        }

        // Sync run mode from server
        if (runMode) {
          this.runMode = runMode;
          try { localStorage.setItem('codeman_runMode', runMode); } catch {}
          this._applyRunMode();
        }

        return merged;
      }
    } catch (err) {
      console.error('Failed to load settings from server:', err);
    }
    return this.loadAppSettingsFromStorage();
  },


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
        const env = await res.json();
        states = env?.success === true ? env.data : env;
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
  },


  // ═══════════════════════════════════════════════════════════════
  // Persistent Parent Associations
  // ═══════════════════════════════════════════════════════════════
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
  },

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
        const env = await res.json();
        mapData = env?.success === true ? env.data : env;
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
  },

  /**
   * Get the parent session ID for an agent from the persistent map.
   * This is the ONLY source of truth for connection lines.
   */
  getAgentParentSessionId(agentId) {
    return this.subagentParentMap.get(agentId) || null;
  },

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
  },


  // ═══════════════════════════════════════════════════════════════
  // Help Modal
  // ═══════════════════════════════════════════════════════════════

  showHelp() {
    const modal = document.getElementById('helpModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  },

  closeHelp() {
    document.getElementById('helpModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  },

  // ─── Shortcut Settings (App Settings → Shortcuts tab) ────────────────────────
  // Renders the list of shortcuts with capture buttons for key rebinding,
  // and persists overrides under settings.shortcutOverrides (saved through
  // saveAppSettingsToStorage so the device key + settings cache stay coherent).

  renderShortcutSettingsList() {
    const list = document.getElementById('appSettingsShortcutsList');
    if (!list) return;
    const registry = this.getShortcutRegistry
      ? this.getShortcutRegistry()
      : typeof DEFAULT_SHORTCUTS !== 'undefined'
        ? DEFAULT_SHORTCUTS
        : [];
    const overrides = this.readShortcutOverridesFromSettings();
    list.innerHTML = registry
      .map((shortcut) => {
        const bindingLabel = shortcut.displayBindings
          ? shortcut.displayBindings.join(' / ')
          : (shortcut.bindings || []).map((b) => [...(b.modifiers || []), b.key || b.code || ''].join('+')).join(' / ');
        // Only registry entries dispatched through matchesShortcutEvent() are
        // configurable; fixed keys (Escape, tab arrows, …) render read-only.
        const configurable = !!shortcut.action && Array.isArray(shortcut.bindings);
        const overridden = !!overrides[shortcut.id];
        const controls = configurable
          ? `<button type="button" class="shortcut-capture-btn" data-shortcut-action="capture" title="Capture new binding">Edit</button>
        <button type="button" class="shortcut-reset-btn" data-shortcut-action="reset" title="Reset to default"${overridden ? '' : ' disabled'}>Reset</button>
        <input class="shortcut-enabled-checkbox" type="checkbox" ${shortcut.disabled ? '' : 'checked'} data-shortcut-action="toggle" title="Enable/disable">`
          : '';
        return `<div class="shortcut-setting-row${configurable ? '' : ' shortcut-setting-row--fixed'}" data-shortcut-id="${escapeHtml(shortcut.id)}">
        <label class="shortcut-setting-label">${escapeHtml(shortcut.label)}</label>
        <input class="shortcut-binding-input" type="text" readonly value="${escapeHtml(bindingLabel)}" placeholder="(none)" data-id="${escapeHtml(shortcut.id)}">
        ${controls}
      </div>`;
      })
      .join('');
    this._wireShortcutSettingsList(list);
  },

  // Delegated handlers (no inline onclick — registry ids never land inside a
  // JS string context, and the listeners survive re-renders).
  _wireShortcutSettingsList(list) {
    if (list.dataset.shortcutListenersAdded) return;
    list.dataset.shortcutListenersAdded = 'true';
    list.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('[data-shortcut-action]');
      if (!btn) return;
      const id = btn.closest?.('[data-shortcut-id]')?.dataset?.shortcutId;
      if (!id) return;
      if (btn.dataset.shortcutAction === 'capture') this.startShortcutCapture(id);
      else if (btn.dataset.shortcutAction === 'reset') this.resetShortcutOverride(id);
    });
    list.addEventListener('change', (e) => {
      const box = e.target;
      if (!box?.matches?.('[data-shortcut-action="toggle"]')) return;
      const id = box.closest?.('[data-shortcut-id]')?.dataset?.shortcutId;
      if (id) this.toggleShortcutEnabled(id, box.checked);
    });
  },

  readShortcutOverridesFromSettings() {
    const settings = this.loadAppSettingsFromStorage();
    return settings.shortcutOverrides || {};
  },

  startShortcutCapture(shortcutId) {
    const input = document.querySelector(`.shortcut-binding-input[data-id="${shortcutId}"]`);
    if (!input) return;
    input.value = 'Press keys…';
    input.focus();
    this._capturingShortcutId = shortcutId;
    // Persistent listener (NOT {once}) — the first keydown of a combo like
    // Ctrl+Shift+P is the modifier itself ('Control'), which must not end the
    // capture. The first non-modifier key completes it.
    const onCaptureKeydown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
      input.removeEventListener('keydown', onCaptureKeydown);
      this.onShortcutCaptureKeydown(e, shortcutId);
    };
    input.addEventListener('keydown', onCaptureKeydown);
  },

  onShortcutCaptureKeydown(e, shortcutId) {
    e.preventDefault();
    e.stopPropagation();
    this._capturingShortcutId = null;
    if (e.key === 'Escape') {
      this.renderShortcutSettingsList();
      return;
    }
    // Require a real chord: the dispatcher has no focus-target guard, so a
    // bare-key binding would fire while typing in any input.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      this.renderShortcutSettingsList();
      this.showToast?.('Shortcut must include Ctrl, Cmd, or Alt', 'error');
      return;
    }
    const modifiers = [];
    if (e.ctrlKey) modifiers.push('ctrl');
    if (e.metaKey) modifiers.push('meta');
    if (e.shiftKey) modifiers.push('shift');
    if (e.altKey) modifiers.push('alt');
    const settings = this.loadAppSettingsFromStorage();
    const shortcutOverrides = { ...(settings.shortcutOverrides || {}) };
    shortcutOverrides[shortcutId] = {
      ...(shortcutOverrides[shortcutId] || {}),
      bindings: [{ modifiers, key: e.key, code: e.code }],
    };
    settings.shortcutOverrides = shortcutOverrides;
    this.saveAppSettingsToStorage(settings);
    this.renderShortcutSettingsList();
  },

  resetShortcutOverride(shortcutId) {
    const settings = this.loadAppSettingsFromStorage();
    const shortcutOverrides = { ...(settings.shortcutOverrides || {}) };
    delete shortcutOverrides[shortcutId];
    settings.shortcutOverrides = shortcutOverrides;
    this.saveAppSettingsToStorage(settings);
    this.renderShortcutSettingsList();
  },

  toggleShortcutEnabled(shortcutId, enabled) {
    const settings = this.loadAppSettingsFromStorage();
    const shortcutOverrides = { ...(settings.shortcutOverrides || {}) };
    shortcutOverrides[shortcutId] = { ...(shortcutOverrides[shortcutId] || {}), disabled: !enabled };
    settings.shortcutOverrides = shortcutOverrides;
    this.saveAppSettingsToStorage(settings);
    this.renderShortcutSettingsList();
  },

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
  },
});
