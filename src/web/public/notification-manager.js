// Codeman — Multi-layer notification system
// Loaded after mobile-handlers.js, before app.js

// Notification Manager - Multi-layer browser notification system
class NotificationManager {
  constructor(app) {
    this.app = app;
    this.notifications = [];
    this.unreadCount = 0;
    this.isTabVisible = !document.hidden;
    this.isDrawerOpen = false;
    this.originalTitle = document.title;
    this.titleFlashInterval = null;
    this.titleFlashState = false;
    this.lastBrowserNotifTime = 0;
    this.audioCtx = null;
    this.renderScheduled = false;

    // Debounce grouping: Map<key, {notification, timeout}>
    this.groupingMap = new Map();

    // Load preferences
    this.preferences = this.loadPreferences();

    // Visibility tracking
    document.addEventListener('visibilitychange', () => {
      this.isTabVisible = !document.hidden;
      if (this.isTabVisible) {
        this.onTabVisible();
      }
    });
    // iOS Safari: pageshow fires on back-forward cache restore (bfcache)
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) {
        this.isTabVisible = true;
        this.onTabVisible();
      }
    });
  }

  loadPreferences() {
    const defaultEventTypes = {
      permission_prompt: { enabled: true, browser: true, audio: true, push: false },
      elicitation_dialog: { enabled: true, browser: true, audio: true, push: false },
      idle_prompt: { enabled: true, browser: true, audio: false, push: false },
      stop: { enabled: true, browser: false, audio: false, push: false },
      session_error: { enabled: true, browser: true, audio: false, push: false },
      respawn_cycle: { enabled: true, browser: false, audio: false, push: false },
      token_milestone: { enabled: true, browser: false, audio: false, push: false },
      ralph_complete: { enabled: true, browser: true, audio: true, push: false },
      subagent_spawn: { enabled: false, browser: false, audio: false, push: false },
      subagent_complete: { enabled: false, browser: false, audio: false, push: false },
    };

    // Device-specific defaults: mobile has notifications disabled by default
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    const defaults = {
      enabled: !isMobile, // Disabled on mobile by default
      browserNotifications: !isMobile,
      audioAlerts: false,
      stuckThresholdMs: STUCK_THRESHOLD_DEFAULT_MS,
      // Legacy urgency muting (keep for backwards compat)
      muteCritical: false,
      muteWarning: false,
      muteInfo: false,
      // Per-event-type preferences
      eventTypes: defaultEventTypes,
      _version: 4,
    };
    try {
      const storageKey = this.getStorageKey();
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const prefs = JSON.parse(saved);
        // Migrate: v1 had browserNotifications defaulting to false
        if (!prefs._version || prefs._version < 2) {
          prefs.browserNotifications = true;
          prefs._version = 2;
        }
        // Migrate: v2 -> v3 adds eventTypes
        if (prefs._version < 3) {
          prefs.eventTypes = defaultEventTypes;
          prefs._version = 3;
          localStorage.setItem(storageKey, JSON.stringify(prefs));
        }
        // Migrate: v3 -> v4 adds push field to all eventTypes
        if (prefs._version < 4) {
          if (prefs.eventTypes) {
            for (const key of Object.keys(prefs.eventTypes)) {
              if (prefs.eventTypes[key] && prefs.eventTypes[key].push === undefined) {
                prefs.eventTypes[key].push = false;
              }
            }
          }
          prefs._version = 4;
          localStorage.setItem(storageKey, JSON.stringify(prefs));
        }
        // Merge with defaults to ensure all eventTypes exist
        return {
          ...defaults,
          ...prefs,
          eventTypes: { ...defaultEventTypes, ...prefs.eventTypes },
        };
      }
    } catch (_e) { /* ignore */ }
    return defaults;
  }

  // Get storage key for notification prefs (device-specific)
  getStorageKey() {
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    return isMobile ? 'codeman-notification-prefs-mobile' : 'codeman-notification-prefs';
  }

  savePreferences() {
    localStorage.setItem(this.getStorageKey(), JSON.stringify(this.preferences));
  }

  notify({ urgency, category, sessionId, sessionName, title, message }) {
    if (!this.preferences.enabled) return;

    // Map notification categories to eventType preference keys
    const categoryToEventType = {
      'hook-permission': 'permission_prompt',
      'hook-elicitation': 'elicitation_dialog',
      'hook-idle': 'idle_prompt',
      'hook-stop': 'stop',
      'session-error': 'session_error',
      'session-crash': 'session_error',
      'session-stuck': 'idle_prompt',
      'respawn-blocked': 'respawn_cycle',
      'auto-accept': 'respawn_cycle',
      'auto-clear': 'respawn_cycle',
      'ralph-complete': 'ralph_complete',
      'circuit-breaker': 'respawn_cycle',
      'exit-gate': 'ralph_complete',
      'subagent-spawn': 'subagent_spawn',
      'subagent-complete': 'subagent_complete',
      'hook-teammate-idle': 'idle_prompt',
      'hook-task-completed': 'stop',
    };
    const eventTypeKey = categoryToEventType[category] || category;

    // Check per-event-type preferences first
    const eventPref = this.preferences.eventTypes?.[eventTypeKey];
    let shouldBrowserNotify = false;
    let shouldAudioAlert = false;

    if (eventPref) {
      // Event type found - use its specific preferences
      if (!eventPref.enabled) return;
      shouldBrowserNotify = eventPref.browser && this.preferences.browserNotifications;
      shouldAudioAlert = eventPref.audio && this.preferences.audioAlerts;
    } else {
      // Fall back to urgency-based muting for unknown categories
      if (urgency === 'critical' && this.preferences.muteCritical) return;
      if (urgency === 'warning' && this.preferences.muteWarning) return;
      if (urgency === 'info' && this.preferences.muteInfo) return;
      // Default browser/audio behavior based on urgency
      shouldBrowserNotify = this.preferences.browserNotifications &&
        (urgency === 'critical' || urgency === 'warning' || !this.isTabVisible);
      shouldAudioAlert = urgency === 'critical' && this.preferences.audioAlerts;
    }

    // Grouping: same category+session within 5s updates count instead of new entry
    const groupKey = `${category}:${sessionId || 'global'}`;
    const existing = this.groupingMap.get(groupKey);
    if (existing) {
      existing.notification.count = (existing.notification.count || 1) + 1;
      existing.notification.message = message;
      existing.notification.timestamp = Date.now();
      clearTimeout(existing.timeout);
      existing.timeout = setTimeout(() => this.groupingMap.delete(groupKey), GROUPING_TIMEOUT_MS);
      this.scheduleRender();
      return;
    }

    const notification = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      urgency,
      category,
      sessionId,
      sessionName,
      title,
      message,
      timestamp: Date.now(),
      read: false,
      count: 1,
    };

    // Add to log (cap at 100)
    this.notifications.unshift(notification);
    if (this.notifications.length > 100) this.notifications.pop();

    // Track for grouping
    const timeout = setTimeout(() => this.groupingMap.delete(groupKey), GROUPING_TIMEOUT_MS);
    this.groupingMap.set(groupKey, { notification, timeout });

    // Update unread
    this.unreadCount++;
    this.updateBadge();
    this.scheduleRender();

    // Layer 2: Tab title (when tab unfocused)
    if (!this.isTabVisible) {
      this.updateTabTitle();
    }

    // Layer 3: Browser notification
    if (shouldBrowserNotify) {
      this.sendBrowserNotif(title, message, category, sessionId);
    }

    // Layer 4: Audio alert
    if (shouldAudioAlert) {
      this.playAudioAlert();
    }
  }

  // Layer 1: Drawer rendering
  scheduleRender() {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.renderDrawer();
    });
  }

  renderDrawer() {
    const list = document.getElementById('notifList');
    const empty = document.getElementById('notifEmpty');
    if (!list || !empty) return;

    if (this.notifications.length === 0) {
      list.style.display = 'none';
      empty.style.display = 'flex';
      return;
    }

    list.style.display = 'block';
    empty.style.display = 'none';

    list.innerHTML = this.notifications.map(n => {
      const urgencyClass = `notif-item-${n.urgency}`;
      const readClass = n.read ? '' : ' unread';
      const countLabel = n.count > 1 ? `<span class="notif-item-count">&times;${n.count}</span>` : '';
      const sessionChip = n.sessionName ? `<span class="notif-item-session">${escapeHtml(n.sessionName)}</span>` : '';
      return `<div class="notif-item ${urgencyClass}${readClass}" data-notif-id="${n.id}" data-session-id="${n.sessionId || ''}" onclick="app.notificationManager.clickNotification('${escapeHtml(n.id)}')">
        <div class="notif-item-header">
          <span class="notif-item-title">${escapeHtml(n.title)}${countLabel}</span>
          <span class="notif-item-time">${this.relativeTime(n.timestamp)}</span>
        </div>
        <div class="notif-item-message">${escapeHtml(n.message)}</div>
        ${sessionChip}
      </div>`;
    }).join('');
  }

  // Layer 2: Tab title with unread count
  updateTabTitle() {
    if (this.unreadCount > 0 && !this.isTabVisible) {
      if (!this.titleFlashInterval) {
        this.titleFlashInterval = setInterval(() => {
          this.titleFlashState = !this.titleFlashState;
          document.title = this.titleFlashState
            ? `\u26A0\uFE0F (${this.unreadCount}) Codeman`
            : this.originalTitle;
        }, TITLE_FLASH_INTERVAL_MS);
        // Set immediately
        document.title = `\u26A0\uFE0F (${this.unreadCount}) Codeman`;
      }
    }
  }

  stopTitleFlash() {
    if (this.titleFlashInterval) {
      clearInterval(this.titleFlashInterval);
      this.titleFlashInterval = null;
      this.titleFlashState = false;
      document.title = this.originalTitle;
    }
  }

  // Layer 3: Web Notification API
  sendBrowserNotif(title, body, tag, sessionId) {
    if (!this.preferences.browserNotifications) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      // Auto-request on first notification attempt
      Notification.requestPermission().then(result => {
        if (result === 'granted') {
          // Re-send this notification now that we have permission
          this.sendBrowserNotif(title, body, tag, sessionId);
        }
      });
      return;
    }
    if (Notification.permission !== 'granted') return;

    // Rate limit: max 1 per 3 seconds
    const now = Date.now();
    if (now - this.lastBrowserNotifTime < 3000) return;
    this.lastBrowserNotifTime = now;

    const notif = new Notification(`Codeman: ${title}`, {
      body,
      tag, // Groups same-tag notifications
      icon: '/favicon.ico',
      silent: true, // We handle audio ourselves
    });

    notif.onclick = () => {
      window.focus();
      if (sessionId && this.app.sessions.has(sessionId)) {
        this.app.selectSession(sessionId);
      }
      notif.close();
    };

    // Auto-close after 8s
    setTimeout(() => notif.close(), 8000);
  }

  async requestPermission() {
    if (typeof Notification === 'undefined') {
      this.app.showToast('Browser notifications not supported', 'warning');
      return;
    }
    const result = await Notification.requestPermission();
    const statusEl = document.getElementById('notifPermissionStatus');
    if (statusEl) statusEl.textContent = `Status: ${result}`;
    if (result === 'granted') {
      this.preferences.browserNotifications = true;
      this.savePreferences();
      this.app.showToast('Notifications enabled', 'success');
    } else {
      this.app.showToast(`Permission ${result}`, 'warning');
    }
  }

  // Layer 4: Audio alert via Web Audio API
  playAudioAlert() {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      const ctx = this.audioCtx;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(660, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.15);
    } catch (_e) { /* Audio not available */ }
  }

  // UI interactions
  toggleDrawer() {
    const drawer = document.getElementById('notifDrawer');
    if (!drawer) return;
    this.isDrawerOpen = !this.isDrawerOpen;
    drawer.classList.toggle('open', this.isDrawerOpen);
    if (this.isDrawerOpen) {
      this.renderDrawer();
    }
  }

  clickNotification(notifId) {
    const notif = this.notifications.find(n => n.id === notifId);
    if (!notif) return;

    // Mark as read
    if (!notif.read) {
      notif.read = true;
      this.unreadCount = Math.max(0, this.unreadCount - 1);
      this.updateBadge();
    }

    // Switch to session if available
    if (notif.sessionId && this.app.sessions.has(notif.sessionId)) {
      this.app.selectSession(notif.sessionId);
      this.toggleDrawer();
    }

    this.scheduleRender();
  }

  markAllRead() {
    this.notifications.forEach(n => { n.read = true; });
    this.unreadCount = 0;
    this.updateBadge();
    this.stopTitleFlash();
    this.scheduleRender();
  }

  clearAll() {
    this.notifications = [];
    this.unreadCount = 0;
    this.updateBadge();
    this.stopTitleFlash();
    this.scheduleRender();
  }

  updateBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (this.unreadCount > 0) {
      badge.style.display = 'flex';
      badge.textContent = this.unreadCount > 99 ? '99+' : String(this.unreadCount);
    } else {
      badge.style.display = 'none';
    }
  }

  onTabVisible() {
    this.stopTitleFlash();
    // If drawer is open, mark all as read
    if (this.isDrawerOpen) {
      this.markAllRead();
    }
    // Re-fit terminal and send resize to PTY so this client's dimensions win.
    // Fixes broken layout when switching between desktop and mobile on the same session.
    if (this.app?.fitAddon && this.app?.activeSessionId) {
      this.app.fitAddon.fit();
      this.app.sendResize(this.app.activeSessionId);
    }
  }

  // Utilities
  relativeTime(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }
}
