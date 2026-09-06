/**
 * @fileoverview Subagent panel (discovery, detail view, kill), subagent parent tracking,
 * agent teams (tasks panel, teammate badges, terminals), project insights (bash tool tracking),
 * file browser (directory tree, preview), log viewer (floating file streamers),
 * image popups (auto-popup for screenshots), mux sessions, monitor panel,
 * token statistics, toast notifications, and system stats.
 * Includes 19 SSE handlers for tasks, mux, bash tools, subagents, and images.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.subagents, this.subagentWindows, this.sessions)
 * @dependency constants.js (escapeHtml, ZINDEX_* constants)
 * @dependency subagent-windows.js (openSubagentWindow, closeSubagentWindow)
 * @loadorder 11 of 15 — loaded after settings-ui.js, before session-ui.js
 */

const AWAY_DIGEST_LAST_VIEWED_KEY = 'codeman-away-digest-last-viewed';
const FILE_BROWSER_SHOW_HIDDEN_KEY = 'codeman:fileBrowserShowHidden';
// Bounds for the by-id text preview, mirroring what the workspace text preview
// already does server-side (500 lines). The byte cap rides a Range request, so
// a huge log is a partial read rather than a download the viewer throws away.
const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
const TEXT_PREVIEW_MAX_LINES = 500;
const AWAY_DIGEST_SECTIONS = [
  ['needsAttention', 'Needs Attention'],
  ['completed', 'Completed'],
  ['stillRunning', 'Still Running'],
  ['idle', 'Idle'],
  ['informational', 'Informational'],
];

Object.assign(CodemanApp.prototype, {
  _addActivityEntry(agentId, entry, maxSize = 50) {
    const activity = this.subagentActivity.get(agentId) || [];
    activity.push(entry);
    if (activity.length > maxSize) activity.shift();
    this.subagentActivity.set(agentId, activity);
  },

  // Tasks
  _onTaskCreated(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  _onTaskCompleted(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  _onTaskFailed(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  _onTaskUpdated(data) {
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  // Mux (tmux)
  _onMuxCreated(data) {
    this.muxSessions.push(data);
    this.renderMuxSessions();
  },

  _onMuxKilled(data) {
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== data.sessionId);
    this.renderMuxSessions();
  },

  _onMuxDied(data) {
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== data.sessionId);
    this.renderMuxSessions();
    this.showToast('Mux session died: ' + this.getShortId(data.sessionId), 'warning');
  },

  _onMuxStatsUpdated(data) {
    this.muxSessions = data;
    if (document.getElementById('monitorPanel').classList.contains('open')) {
      this.renderMuxSessions();
    }
  },

  // Remote auto-reconnect (COD-108)
  _onRemoteSessionReconnected(data) {
    const id = this.getShortId(data.sessionId);
    this.showToast(`Remote session ${id} reconnected`, 'success');
  },

  _onRemoteReconnectExhausted(data) {
    const sessionId = data.sessionId;
    const id = this.getShortId(sessionId);
    // Auto-reconnect gave up after the bounded backoff. Surface a manual
    // "Reconnect" affordance that re-triggers the attach path (force-reload the
    // session, which re-runs the create/attach flow against the durable remote).
    this.showToast(`Remote session ${id} dropped — auto-reconnect gave up`, 'error', {
      duration: 15000,
      action: {
        label: 'Reconnect',
        onClick: () => {
          if (this.sessions && this.sessions.has(sessionId)) {
            this.selectSession(sessionId, { forceReload: true });
          } else {
            this.showToast('Session no longer available', 'warning');
          }
        },
      },
    });
  },


  // Bash tools
  _onBashToolStart(data) {
    this.handleBashToolStart(data.sessionId, data.tool);
  },

  _onBashToolEnd(data) {
    this.handleBashToolEnd(data.sessionId, data.tool);
  },

  _onBashToolsUpdate(data) {
    this.handleBashToolsUpdate(data.sessionId, data.tools);
  },


  // Subagents (Claude Code background agents)
  _onSubagentDiscovered(data) {
    // Clear all old data for this agentId (in case of ID reuse)
    this.subagents.set(data.agentId, data);
    this.subagentActivity.set(data.agentId, []);
    this.subagentToolResults.delete(data.agentId);
    // Close any existing window for this agentId (will be reopened fresh)
    if (this.subagentWindows.has(data.agentId)) {
      this.forceCloseSubagentWindow(data.agentId);
    }
    this.renderSubagentPanel();

    // Find which Codeman session owns this subagent (direct claudeSessionId match only)
    this.findParentSessionForSubagent(data.agentId);

    // Subagent windows are no longer auto-opened on discovery.
    // Users can open them manually from the monitor panel or via openAllActiveSubagentWindows().

    // Ensure connection lines are updated after window is created and DOM settles
    requestAnimationFrame(() => {
      this.updateConnectionLines();
    });

    // Notify about new subagent discovery
    const parentId = this.subagentParentMap.get(data.agentId);
    this._notifySession(parentId || data.sessionId, 'info', 'subagent-spawn', 'Subagent Spawned', data.description || 'New background agent started');
  },

  _onSubagentUpdated(data) {
    const existing = this.subagents.get(data.agentId);
    if (existing) {
      // Merge updated fields (especially description)
      Object.assign(existing, data);
      this.subagents.set(data.agentId, existing);
    } else {
      this.subagents.set(data.agentId, data);
    }
    this.renderSubagentPanel();
    // Update floating window if open (content + header/title)
    if (this.subagentWindows.has(data.agentId)) {
      this.renderSubagentWindowContent(data.agentId);
      this.updateSubagentWindowHeader(data.agentId);
    }
  },

  _onSubagentToolCall(data) {
    this._addActivityEntry(data.agentId, { type: 'tool', ...data });
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    this.renderSubagentPanel();
    // Update floating window (debounced — tool_call events fire rapidly)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  _onSubagentProgress(data) {
    this._addActivityEntry(data.agentId, { type: 'progress', ...data });
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  _onSubagentMessage(data) {
    this._addActivityEntry(data.agentId, { type: 'message', ...data });
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  _onSubagentToolResult(data) {
    // Store tool result by toolUseId for later lookup (cap at 50 per agent)
    if (!this.subagentToolResults.has(data.agentId)) {
      this.subagentToolResults.set(data.agentId, new Map());
    }
    const resultsMap = this.subagentToolResults.get(data.agentId);
    resultsMap.set(data.toolUseId, data);
    if (resultsMap.size > 50) {
      const oldest = resultsMap.keys().next().value;
      resultsMap.delete(oldest);
    }

    // Add to activity stream
    this._addActivityEntry(data.agentId, { type: 'tool_result', ...data });

    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  async _onSubagentCompleted(data) {
    const existing = this.subagents.get(data.agentId);
    if (existing) {
      existing.status = 'completed';
      this.subagents.set(data.agentId, existing);
    }
    this.renderSubagentPanel();
    this.updateSubagentWindows();

    // Auto-minimize completed subagent windows
    if (this.subagentWindows.has(data.agentId)) {
      const windowData = this.subagentWindows.get(data.agentId);
      if (windowData && !windowData.minimized) {
        await this.closeSubagentWindow(data.agentId); // This minimizes to tab
        this.saveSubagentWindowStates(); // Persist the minimized state
      }
    }

    // Notify about subagent completion
    const parentId = this.subagentParentMap.get(data.agentId);
    this._notifySession(parentId || existing?.sessionId || data.sessionId, 'info', 'subagent-complete', 'Subagent Completed', existing?.description || data.description || 'Background agent finished');

    // Clean up activity/tool data for completed agents after 5 minutes
    // This prevents memory leaks from long-running sessions with many subagents
    setTimeout(() => {
      const agent = this.subagents.get(data.agentId);
      // Only clean up if agent is still completed (not restarted)
      if (agent?.status === 'completed') {
        this.subagentActivity.delete(data.agentId);
        this.subagentToolResults.delete(data.agentId);
      }
    }, 5 * 60 * 1000); // 5 minutes

    // Prune stale completed agents from main maps after 30 minutes
    // Keeps subagents/subagentParentMap from growing unbounded in 24h sessions
    setTimeout(() => {
      const agent = this.subagents.get(data.agentId);
      if (agent?.status === 'completed' && !this.subagentWindows.has(data.agentId)) {
        this.subagents.delete(data.agentId);
        this.subagentParentMap.delete(data.agentId);
      }
    }, 30 * 60 * 1000); // 30 minutes
  },

  // Images
  _onImageDetected(data) {
    console.log('[Image Detected]', data);
    this.openImagePopup(data);
  },

  // ═══════════════════════════════════════════════════════════════
  // Command Palette (COD-153)
  // Fast Cmd/Ctrl+K switcher for currently open sessions, plus launch-new.
  // ═══════════════════════════════════════════════════════════════

  shouldOpenCommandPaletteFromShortcut(e) {
    if (!e) return false;
    // Every palette chord requires Ctrl/Cmd/Alt (capture enforces the same for
    // rebinds), so plain typing exits before any registry work — this runs on
    // the document AND xterm keydown hot paths.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) return false;

    // Registry-aware chord check (COD-157): honors a rebound or disabled
    // palette shortcut. Falls back to the default Ctrl/Cmd/Alt+K chord when the
    // registry isn't available (isolated test harnesses).
    const registryAvailable =
      typeof this.getShortcutRegistry === 'function' && typeof this.matchesShortcutEvent === 'function';
    const palette = registryAvailable
      ? this.getShortcutRegistry().find((s) => s.id === 'command-palette')
      : null;
    if (palette) {
      if (palette.disabled || !this.matchesShortcutEvent(e, palette)) return false;
    } else {
      const key = (e.key || '').toLowerCase();
      if (key !== 'k' && e.code !== 'KeyK') return false;
      // Don't hijack chords with extra modifiers (Ctrl+Shift+K is the Firefox
      // devtools console; matchesShortcutEvent applies the same rule above).
      if (e.shiftKey) return false;
    }

    const target = e.target;
    if (!target) return true;
    const tagName = (target.tagName || '').toUpperCase();
    const className = typeof target.className === 'string' ? target.className : '';
    const isXtermHelper =
      target.classList?.contains?.('xterm-helper-textarea') || className.includes('xterm-helper-textarea');
    if (isXtermHelper) return true;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return false;
    if (target.isContentEditable) return false;
    if (typeof target.closest === 'function' && target.closest('[contenteditable="true"]')) return false;
    return true;
  },

  openCommandPalette() {
    const modal = document.getElementById('commandPaletteModal');
    const search = document.getElementById('commandPaletteSearch');
    if (!modal || !search) return;

    this.commandPaletteActiveIndex = 0;
    search.value = '';
    modal.classList.add('active');

    this._wireCommandPalette();
    this.renderCommandPalette();

    search.focus();
    search.select?.();
  },

  closeCommandPalette() {
    const modal = document.getElementById('commandPaletteModal');
    if (modal) modal.classList.remove('active');
  },

  _wireCommandPalette() {
    if (this._commandPaletteWired) return;
    this._commandPaletteWired = true;

    const modal = document.getElementById('commandPaletteModal');
    const search = document.getElementById('commandPaletteSearch');
    const list = document.getElementById('commandPaletteList');

    search?.addEventListener('input', () => {
      this.commandPaletteActiveIndex = 0;
      this.renderCommandPalette();
    });

    search?.addEventListener('keydown', async (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveCommandPaletteSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveCommandPaletteSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        await this.activateCommandPaletteItem();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeCommandPalette();
      }
    });

    modal?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeCommandPalette();
      }
    });

    list?.addEventListener?.('click', (e) => {
      const row = e.target?.closest?.('[data-command-index]');
      if (!row) return;
      this.commandPaletteActiveIndex = Number(row.dataset.commandIndex) || 0;
      void this.activateCommandPaletteItem();
    });
  },

  buildCommandPaletteItems(query = '') {
    const needle = query.trim().toLowerCase();
    const orderedIds = [
      ...(Array.isArray(this.sessionOrder) ? this.sessionOrder : []),
      ...Array.from(this.sessions?.keys?.() || []).filter((id) => !this.sessionOrder?.includes?.(id)),
    ];
    const seen = new Set();
    const sessionItems = [];

    for (const sessionId of orderedIds) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const session = this.sessions?.get?.(sessionId);
      if (!session) continue;
      const title = this.getSessionName?.(session) || session.name || session.title || sessionId.slice(0, 8);
      const subtitleParts = [session.workingDir, session.mode, session.status].filter(Boolean);
      const haystack = [title, session.workingDir, session.mode, session.status, sessionId].filter(Boolean).join(' ').toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      sessionItems.push({
        id: `session:${sessionId}`,
        type: 'session',
        sessionId,
        title,
        subtitle: subtitleParts.join(' · '),
      });
    }

    sessionItems.push(this._buildCommandPaletteNewSessionItem(query));
    sessionItems.push({ id: 'browse-sessions', type: 'browse-sessions', title: 'Browse all sessions…', subtitle: 'Open Session Manager' });
    return sessionItems;
  },

  _buildCommandPaletteNewSessionItem(query = '') {
    const mode = this.runMode || this._runMode || 'claude';
    const labels = { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', pi: 'Pi', grok: 'Grok', deepseek: 'DeepSeek', omp: 'OMP' };
    const caseName = this._findCommandPaletteCaseMatch(query) || document.getElementById('quickStartCase')?.value || 'testcase';
    return {
      id: 'new-session',
      type: 'new-session',
      caseName,
      title: 'New session',
      subtitle: `Run ${labels[mode] || mode} in ${caseName}`,
    };
  },

  _findCommandPaletteCaseMatch(query = '') {
    const needle = query.trim().toLowerCase();
    if (!needle || !Array.isArray(this.cases)) return null;

    const scoreCase = (caseItem) => {
      const name = String(caseItem?.name || '').trim();
      if (!name) return 0;
      const haystack = [
        name,
        caseItem?.path,
        caseItem?.casePath,
        caseItem?.workingDir,
        caseItem?.remote?.path,
        caseItem?.remote?.hostId,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const lowerName = name.toLowerCase();
      if (lowerName === needle) return 100;
      if (lowerName.startsWith(needle)) return 90;
      if (lowerName.includes(needle)) return 80;
      if (haystack.includes(needle)) return 60;
      return 0;
    };

    let best = null;
    let bestScore = 0;
    for (const caseItem of this.cases) {
      const score = scoreCase(caseItem);
      if (score > bestScore) {
        best = caseItem;
        bestScore = score;
      }
    }
    return best?.name || null;
  },

  renderCommandPalette() {
    const search = document.getElementById('commandPaletteSearch');
    const list = document.getElementById('commandPaletteList');
    if (!list) return;

    const query = search?.value || '';
    const items = this.buildCommandPaletteItems(query);
    this.commandPaletteItems = items;
    this.commandPaletteActiveIndex = Math.max(0, Math.min(this.commandPaletteActiveIndex || 0, items.length - 1));

    list.innerHTML = items
      .map((item, index) => {
        const active = index === this.commandPaletteActiveIndex ? ' active' : '';
        const icon = item.type === 'new-session' ? '+' : item.type === 'browse-sessions' ? '≡' : '›';
        const browse = item.type === 'browse-sessions' ? ' command-palette-item--browse' : '';
        return `
          <button class="command-palette-item${active}${browse}" type="button" data-command-index="${index}">
            <span class="command-palette-icon" aria-hidden="true">${icon}</span>
            <span class="command-palette-text">
              <span class="command-palette-title">${escapeHtml(item.title)}</span>
              <span class="command-palette-subtitle">${escapeHtml(item.subtitle || '')}</span>
            </span>
          </button>
        `;
      })
      .join('');
  },

  moveCommandPaletteSelection(delta) {
    const items = this.commandPaletteItems || this.buildCommandPaletteItems(document.getElementById('commandPaletteSearch')?.value || '');
    if (!items.length) return;
    this.commandPaletteActiveIndex = (this.commandPaletteActiveIndex + delta + items.length) % items.length;
    this.renderCommandPalette();
  },

  async activateCommandPaletteItem(index = this.commandPaletteActiveIndex || 0) {
    const item = (this.commandPaletteItems || [])[index];
    if (!item) return;

    this.closeCommandPalette();
    if (item.type === 'session' && item.sessionId) {
      await this.selectSession(item.sessionId);
      return;
    }
    if (item.type === 'browse-sessions') {
      this.openSessionManager();
      return;
    }
    if (item.type === 'new-session') {
      const caseSelect = document.getElementById('quickStartCase');
      if (caseSelect && item.caseName) {
        if (
          caseSelect.tagName === 'SELECT' &&
          typeof caseSelect.appendChild === 'function' &&
          !Array.from(caseSelect.options || []).some((option) => option.value === item.caseName)
        ) {
          const option = document.createElement('option');
          option.value = item.caseName;
          option.textContent = item.caseName;
          caseSelect.appendChild(option);
        }
        // selectQuickStartCase keeps the searchable combobox, dir display, and
        // persisted last-used case in sync with the palette's pick (COD-151);
        // fall back to a bare value set when the picker mixin isn't loaded.
        if (typeof this.selectQuickStartCase === 'function') {
          this.selectQuickStartCase(item.caseName);
        } else {
          caseSelect.value = item.caseName;
        }
      }
      await this.run();
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Session Manager Modal (COD-121)
  // Unified session list (GET /api/sessions/unified) reachable mid-session,
  // with a server-side search box. Reuses the history item renderer; clicking
  // a live row switches to it, a history row resumes the conversation.
  // ═══════════════════════════════════════════════════════════════

  async openSessionManager() {
    const modal = document.getElementById('sessionManagerModal');
    if (modal) {
      modal.classList.add('active');
      // Escape closes the modal even while focus is in the search input. A
      // modal-scoped listener is robust regardless of the global Escape chain
      // (which runs other close handlers first and can short-circuit). Wire once.
      if (!this._sessionManagerEscWired) {
        this._sessionManagerEscWired = true;
        modal.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.closeSessionManager();
          }
        });
      }
    }

    // Ensure cases are loaded so item subtitles can show "#caseName" labels.
    // Mirror loadHistorySessions(): prefer already-loaded this.cases.
    if (!Array.isArray(this.cases) || this.cases.length === 0) {
      try {
        const r = await fetch('/api/cases');
        const d = r.ok ? await r.json() : null;
        this.cases = d?.data || [];
      } catch {
        this.cases = this.cases || [];
      }
    }

    const search = document.getElementById('sessionManagerSearch');
    if (search) {
      // Wire the debounced search input once (lazy — the element exists by
      // the time the modal is first opened, and mixin methods are bound).
      if (!this._sessionManagerSearchWired) {
        this._sessionManagerSearchWired = true;
        search.addEventListener('input', () => {
          const value = search.value.trim();
          this._debouncedCall('sessionManagerSearch', () => this._loadSessionManagerList(value), 200);
        });
      }
      search.value = '';
      search.focus();
    }
    await this._loadSessionManagerList('');
  },

  closeSessionManager() {
    const modal = document.getElementById('sessionManagerModal');
    if (modal) modal.classList.remove('active');
  },

  /** Replace the Session Manager list body with a single status line. */
  _setSessionManagerMessage(list, message) {
    list.replaceChildren();
    const line = document.createElement('p');
    line.className = 'empty-message';
    line.textContent = message;
    list.appendChild(line);
  },

  async _loadSessionManagerList(q = '') {
    this._sessionManagerQuery = q;
    const list = document.getElementById('sessionManagerList');
    if (!list) return;
    try {
      const url = '/api/sessions/unified?limit=200' + (q ? '&q=' + encodeURIComponent(q) : '');
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      // ApiResponse envelope: { success: true, data: { sessions, total } }.
      // Surface failures instead of rendering them as an empty result set.
      if (!res.ok || !data || data.success === false || !data.data) {
        this._setSessionManagerMessage(list, data?.error || `Failed to load sessions (HTTP ${res.status})`);
        return;
      }
      const sessions = data.data.sessions || [];
      list.replaceChildren();
      if (sessions.length === 0) {
        this._setSessionManagerMessage(list, q ? 'No sessions match your search' : 'No sessions found');
        return;
      }
      for (const s of sessions) {
        // Adapt UnifiedSessionItem (lastActivityAt epoch-ms, optional fields) to
        // the history-record shape _buildHistoryItem renders (lastModified date
        // string, sizeBytes, firstPrompt).
        const record = {
          sessionId: s.sessionId,
          workingDir: s.workingDir || '',
          sizeBytes: s.sizeBytes ?? 0,
          lastModified: new Date(s.lastActivityAt ?? s.createdAt ?? Date.now()).toISOString(),
          firstPrompt: s.firstPrompt || s.name || '',
          // Must be carried explicitly: this record is a re-projection, so any
          // field omitted here silently vanishes from the Cmd+K list (#266).
          gitBranch: s.gitBranch,
          worktreeName: s.worktreeName,
          worktreeRepo: s.worktreeRepo,
        };
        const isLive = !!this.sessions?.has?.(s.sessionId);
        const item = this._buildHistoryItem(record, this.cases, {
          showViewAll: false,
          onActivate: () => {
            this.closeSessionManager();
            if (isLive) {
              void this.selectSession(s.sessionId);
            } else if (record.workingDir) {
              // History rows are keyed by the Claude conversation UUID; resumed
              // sessions carry theirs separately as claudeSessionId.
              void this.resumeHistorySession(
                s.claudeSessionId || s.sessionId,
                record.workingDir,
                undefined,
                s.mode,
                s.resumeId
              );
            }
          },
        });
        list.appendChild(item);
      }
    } catch (err) {
      console.error('[_loadSessionManagerList]', err);
      this._setSessionManagerMessage(list, 'Failed to load sessions');
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Away Digest Modal
  // ═══════════════════════════════════════════════════════════════

  async openAwayDigest(range = 'since-last-visit') {
    this.awayDigestRange = range;
    this._awayDigestLoadedSuccessfully = false;
    this._awayDigestSinceLastVisitGeneratedAt = undefined;
    const modal = document.getElementById('awayDigestModal');
    if (modal) modal.classList.add('active');
    this.updateAwayDigestRangeControls();
    await this.loadAwayDigest();
  },

  closeAwayDigest() {
    const modal = document.getElementById('awayDigestModal');
    const generatedAt = this._awayDigestSinceLastVisitGeneratedAt;
    if (Number.isFinite(generatedAt)) {
      try {
        localStorage.setItem(AWAY_DIGEST_LAST_VIEWED_KEY, String(generatedAt));
      } catch (err) {
        console.warn('Failed to save away digest last-viewed marker:', err);
      }
    }
    if (modal) modal.classList.remove('active');
  },

  /**
   * COD-121: live-refresh the unified session list when sessions change
   * (created/updated/deleted via SSE). Only touches surfaces that are currently
   * showing — the open Session Manager modal and/or the visible welcome list —
   * and is debounced so an event burst collapses into one re-fetch. The current
   * search query is preserved.
   */
  _onSessionListMaybeChanged() {
    const modal = document.getElementById('sessionManagerModal');
    if (modal && modal.classList.contains('active')) {
      this._debouncedCall(
        'sessionManagerRefresh',
        () => this._loadSessionManagerList(this._sessionManagerQuery || ''),
        400
      );
    }
    const welcome = document.getElementById('welcomeOverlay');
    if (welcome && welcome.classList.contains('visible')) {
      this._debouncedCall('welcomeHistoryRefresh', () => this.loadHistorySessions(), 600);
    }
  },

  setAwayDigestRange(range) {
    this.awayDigestRange = range;
    this._awayDigestLoadedSuccessfully = false;
    this.updateAwayDigestRangeControls();
    this.loadAwayDigest();
  },

  updateAwayDigestRangeControls() {
    const range = this.awayDigestRange || 'since-last-visit';
    document.querySelectorAll('[data-away-range]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.awayRange === range);
    });
    const customRange = document.getElementById('awayDigestCustomRange');
    if (customRange) customRange.classList.toggle('active', range === 'custom');
    if (range === 'custom') this.ensureAwayDigestCustomDefaults();
  },

  ensureAwayDigestCustomDefaults() {
    const sinceInput = document.getElementById('awayDigestCustomSince');
    const untilInput = document.getElementById('awayDigestCustomUntil');
    if (!sinceInput || !untilInput) return;

    const now = new Date();
    if (!untilInput.value) untilInput.value = this.formatAwayDigestDateTimeLocal(now);
    if (!sinceInput.value) {
      const since = new Date(now.getTime() - 60 * 60 * 1000);
      sinceInput.value = this.formatAwayDigestDateTimeLocal(since);
    }
  },

  formatAwayDigestDateTimeLocal(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  async loadAwayDigest() {
    const summaryEl = document.getElementById('awayDigestSummary');
    const freshnessEl = document.getElementById('awayDigestFreshness');
    const sectionsEl = document.getElementById('awayDigestSections');
    if (summaryEl) summaryEl.innerHTML = '<div class="away-digest-loading">Loading digest...</div>';
    if (freshnessEl) freshnessEl.textContent = '';
    if (sectionsEl) sectionsEl.innerHTML = '';

    try {
      const range = this.awayDigestRange || 'since-last-visit';
      const params = new URLSearchParams({ range });

      if (range === 'since-last-visit') {
        const lastViewed = this.readAwayDigestLastViewed();
        if (Number.isFinite(lastViewed)) params.set('lastViewed', String(lastViewed));
      }

      if (range === 'custom') {
        this.ensureAwayDigestCustomDefaults();
        const since = this.readAwayDigestDateTimeInput('awayDigestCustomSince');
        const until = this.readAwayDigestDateTimeInput('awayDigestCustomUntil');
        if (!Number.isFinite(since)) {
          throw new Error('Choose a custom start time');
        }
        params.set('since', String(since));
        if (Number.isFinite(until)) params.set('until', String(until));
      }

      const response = await fetch(`/api/away-digest?${params.toString()}`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to load away digest');
      }

      this._awayDigestLoadedSuccessfully = true;
      this._awayDigestGeneratedAt = data.digest.generatedAt;
      if (range === 'since-last-visit') {
        this._awayDigestSinceLastVisitGeneratedAt = data.digest.generatedAt;
      }
      this.renderAwayDigest(data.digest);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load away digest';
      console.error('Failed to fetch away digest:', err);
      if (summaryEl) summaryEl.innerHTML = '<div class="away-digest-load-error">Failed to load away digest</div>';
      if (sectionsEl) {
        sectionsEl.innerHTML = `<div class="empty-message">${escapeHtml(message)}</div>`;
      }
      this.showToast(message, 'error');
    }
  },

  readAwayDigestLastViewed() {
    try {
      const value = localStorage.getItem(AWAY_DIGEST_LAST_VIEWED_KEY);
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  },

  readAwayDigestDateTimeInput(id) {
    const input = document.getElementById(id);
    if (!input || !input.value) return undefined;
    const parsed = Date.parse(input.value);
    return Number.isFinite(parsed) ? parsed : undefined;
  },

  renderAwayDigest(digest) {
    const summaryEl = document.getElementById('awayDigestSummary');
    const freshnessEl = document.getElementById('awayDigestFreshness');
    const sectionsEl = document.getElementById('awayDigestSections');
    if (!summaryEl || !freshnessEl || !sectionsEl) return;

    const inputTokens = digest.totals.inputTokens || 0;
    const outputTokens = digest.totals.outputTokens || 0;
    const estimatedCost = digest.totals.estimatedCost || 0;
    summaryEl.innerHTML = `
      <div class="away-digest-card">
        <span class="away-digest-card-label">Needs Attention</span>
        <span class="away-digest-card-value">${digest.totals.needsAttention}</span>
      </div>
      <div class="away-digest-card">
        <span class="away-digest-card-label">Completed</span>
        <span class="away-digest-card-value">${digest.totals.completed}</span>
      </div>
      <div class="away-digest-card">
        <span class="away-digest-card-label">Active Sessions</span>
        <span class="away-digest-card-value">${digest.totals.activeSessions}</span>
      </div>
      <div class="away-digest-card">
        <span class="away-digest-card-label">Tokens</span>
        <span class="away-digest-card-value">${this.formatTokens(inputTokens + outputTokens)}</span>
        <span class="away-digest-card-cost">~$${estimatedCost.toFixed(2)}</span>
      </div>
    `;

    const freshnessNotes = [];
    if (digest.dataFreshness.runSummariesLiveOnly || digest.dataFreshness.subagentsLiveOnly) {
      freshnessNotes.push('Run summaries and subagent completions use recent live state; lifecycle and token stats are persisted.');
    }
    if (digest.totals.tokenWindowPrecision === 'day') {
      freshnessNotes.push('Token totals are aggregated at day precision.');
    }
    freshnessEl.textContent = freshnessNotes.join(' ');

    sectionsEl.innerHTML = AWAY_DIGEST_SECTIONS
      .map(([key, title]) => this.renderAwayDigestSection(title, digest.sections[key] || []))
      .join('');
    this.attachAwayDigestActions();
  },

  renderAwayDigestSection(title, items) {
    const count = items.length;
    const body = count
      ? items.map(item => this.renderAwayDigestItem(item)).join('')
      : '<div class="away-digest-empty">No items</div>';
    return `
      <section class="away-digest-section">
        <div class="away-digest-section-title">
          <h4>${escapeHtml(title)}</h4>
          <span>${count}</span>
        </div>
        ${body}
      </section>
    `;
  },

  renderAwayDigestItem(item) {
    const sourceLabel = this.formatAwayDigestSource(item.source);
    const sessionLabel = item.sessionName || item.sessionId || '';
    const detail = item.detail ? `<div class="away-digest-item-detail">${escapeHtml(item.detail)}</div>` : '';
    const action = item.link ? `
      <button class="away-digest-action"
              data-away-link-type="${escapeHtml(item.link.type)}"
              data-away-session-id="${escapeHtml(item.link.sessionId || '')}">
        Open
      </button>
    ` : '';
    return `
      <article class="away-digest-item away-digest-${escapeHtml(item.severity)}">
        <div class="away-digest-item-main">
          <div class="away-digest-item-meta">
            <span>${escapeHtml(this.formatAwayDigestTimestamp(item.timestamp))}</span>
            <span>${escapeHtml(sourceLabel)}</span>
            ${sessionLabel ? `<span>${escapeHtml(sessionLabel)}</span>` : ''}
          </div>
          <div class="away-digest-item-title">${escapeHtml(item.title)}</div>
          ${detail}
        </div>
        ${action}
      </article>
    `;
  },

  attachAwayDigestActions() {
    const sectionsEl = document.getElementById('awayDigestSections');
    if (!sectionsEl) return;
    sectionsEl.querySelectorAll('[data-away-link-type]').forEach(button => {
      button.addEventListener('click', () => {
        this.openAwayDigestItem(button.dataset.awayLinkType, button.dataset.awaySessionId || undefined);
      });
    });
  },

  async openAwayDigestItem(type, sessionId) {
    if (type === 'session' && sessionId) {
      await this.selectSession(sessionId);
      this.closeAwayDigest();
      return;
    }
    if (type === 'run_summary' && sessionId) {
      await this.openRunSummary(sessionId);
      this.closeAwayDigest();
      return;
    }
    if (type === 'lifecycle') {
      this.openLifecycleLog();
      this.closeAwayDigest();
    }
  },

  formatAwayDigestTimestamp(timestamp) {
    if (!Number.isFinite(timestamp)) return '';
    return new Date(timestamp).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  },

  formatAwayDigestSource(source) {
    const labels = {
      lifecycle: 'Lifecycle',
      run_summary: 'Run Summary',
      status: 'Status',
      token_stats: 'Token Stats',
      subagent: 'Subagent',
    };
    return labels[source] || source;
  },

  // ═══════════════════════════════════════════════════════════════
  // Token Statistics Modal
  // ═══════════════════════════════════════════════════════════════

  async openTokenStats() {
    try {
      const response = await fetch('/api/token-stats');
      const data = await response.json();
      if (data.success) {
        this.renderTokenStats(data.data);
        document.getElementById('tokenStatsModal').classList.add('active');
      } else {
        this.showToast('Failed to load token stats', 'error');
      }
    } catch (err) {
      console.error('Failed to fetch token stats:', err);
      this.showToast('Failed to load token stats', 'error');
    }
  },

  renderTokenStats(data) {
    const { daily, totals } = data;

    // Calculate period totals
    const today = new Date().toISOString().split('T')[0];
    const todayData = daily.find(d => d.date === today) || { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

    // Last 7 days totals (for summary card)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const last7Days = daily.filter(d => new Date(d.date) >= sevenDaysAgo);
    const weekInput = last7Days.reduce((sum, d) => sum + d.inputTokens, 0);
    const weekOutput = last7Days.reduce((sum, d) => sum + d.outputTokens, 0);
    const weekCost = this.estimateCost(weekInput, weekOutput);

    // Lifetime totals (from aggregate stats)
    const lifetimeInput = totals.totalInputTokens;
    const lifetimeOutput = totals.totalOutputTokens;
    const lifetimeCost = this.estimateCost(lifetimeInput, lifetimeOutput);

    // Render summary cards
    const summaryEl = document.getElementById('statsSummary');
    summaryEl.innerHTML = `
      <div class="stat-card">
        <span class="stat-card-label">Today</span>
        <span class="stat-card-value">${this.formatTokens(todayData.inputTokens + todayData.outputTokens)}</span>
        <span class="stat-card-cost">~$${todayData.estimatedCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">7 Days</span>
        <span class="stat-card-value">${this.formatTokens(weekInput + weekOutput)}</span>
        <span class="stat-card-cost">~$${weekCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">Lifetime</span>
        <span class="stat-card-value">${this.formatTokens(lifetimeInput + lifetimeOutput)}</span>
        <span class="stat-card-cost">~$${lifetimeCost.toFixed(2)}</span>
      </div>
    `;

    // Render bar chart (last 7 days)
    const chartEl = document.getElementById('statsChart');
    const daysEl = document.getElementById('statsChartDays');

    // Get last 7 days (fill gaps with empty data)
    const chartData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayData = daily.find(d => d.date === dateStr);
      chartData.push({
        date: dateStr,
        dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
        tokens: dayData ? dayData.inputTokens + dayData.outputTokens : 0,
        cost: dayData ? dayData.estimatedCost : 0,
      });
    }

    // Find max for scaling
    const maxTokens = Math.max(...chartData.map(d => d.tokens), 1);

    chartEl.innerHTML = chartData.map(d => {
      const height = Math.max((d.tokens / maxTokens) * 100, 3);
      const tooltip = `${d.dayName}: ${this.formatTokens(d.tokens)} (~$${d.cost.toFixed(2)})`;
      return `<div class="bar" style="height: ${height}%" data-tooltip="${tooltip}"></div>`;
    }).join('');

    daysEl.innerHTML = chartData.map(d => `<span>${d.dayName}</span>`).join('');

    // Render table (last 14 days with data)
    const tableEl = document.getElementById('statsTable');
    const tableData = daily.slice(0, 14);

    if (tableData.length === 0) {
      tableEl.innerHTML = '<div class="stats-no-data">No usage data recorded yet</div>';
    } else {
      tableEl.innerHTML = `
        <div class="stats-table-header">
          <span>Date</span>
          <span>Input</span>
          <span>Output</span>
          <span>Cost</span>
        </div>
        ${tableData.map(d => {
          const dateObj = new Date(d.date + 'T00:00:00');
          const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return `
            <div class="stats-table-row">
              <span class="cell cell-date">${dateStr}</span>
              <span class="cell">${this.formatTokens(d.inputTokens)}</span>
              <span class="cell">${this.formatTokens(d.outputTokens)}</span>
              <span class="cell cell-cost">$${d.estimatedCost.toFixed(2)}</span>
            </div>
          `;
        }).join('')}
      `;
    }
  },

  closeTokenStats() {
    const modal = document.getElementById('tokenStatsModal');
    if (modal) {
      modal.classList.remove('active');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Monitor Panel (combined Mux Sessions + Background Tasks)
  // ═══════════════════════════════════════════════════════════════

  async toggleMonitorPanel() {
    const panel = document.getElementById('monitorPanel');
    const toggleBtn = document.getElementById('monitorToggleBtn');
    panel.classList.toggle('open');

    if (panel.classList.contains('open')) {
      // applyMonitorVisibility() sets inline display:none when the "Show Monitor"
      // setting is off — clear it so transient opens (session-tab task badge) work
      panel.style.display = '';
      // Load screens and start stats collection
      await this.loadMuxSessions();
      await fetch('/api/mux-sessions/stats/start', { method: 'POST' });
      this.renderTaskPanel();
      if (toggleBtn) toggleBtn.innerHTML = '&#x25BC;'; // Down arrow when open
    } else {
      // Stop stats collection when panel is closed
      await fetch('/api/mux-sessions/stats/stop', { method: 'POST' });
      if (toggleBtn) toggleBtn.innerHTML = '&#x25B2;'; // Up arrow when closed
    }
  },

  // Legacy alias for task panel toggle (used by session tab badge)
  toggleTaskPanel() {
    this.toggleMonitorPanel();
  },

  // ═══════════════════════════════════════════════════════════════
  // Monitor Panel Detach & Drag
  // ═══════════════════════════════════════════════════════════════

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
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon (two overlapping squares)
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon (squared plus - dock back)
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupMonitorDrag();
    }
  },

  setupMonitorDrag() {
    const panel = document.getElementById('monitorPanel');
    const header = document.getElementById('monitorPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  },

  // ═══════════════════════════════════════════════════════════════
  // Subagents Panel Detach & Drag
  // ═══════════════════════════════════════════════════════════════

  toggleSubagentsDetach() {
    const panel = document.getElementById('subagentsPanel');
    const detachBtn = document.getElementById('subagentsDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupSubagentsDrag();
    }
  },

  setupSubagentsDrag() {
    const panel = document.getElementById('subagentsPanel');
    const header = document.getElementById('subagentsPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  },

  renderTaskPanel() {
    this._debouncedCall('taskPanel', this._renderTaskPanelImmediate);
  },

  _renderTaskPanelImmediate() {
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
            <div class="task-description">${escapeHtml(task.description)}</div>
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
  },

  flattenTaskTree(tasks, result = []) {
    for (const task of tasks) {
      result.push(task);
      // Children are stored as IDs, not nested objects in taskTree
      // The task tree from server already has the structure we need
    }
    return result;
  },


  // ═══════════════════════════════════════════════════════════════
  // Subagent Panel (Claude Code Background Agents)
  // ═══════════════════════════════════════════════════════════════

  // Legacy alias
  toggleSubagentPanel() {
    this.toggleSubagentsPanel();
  },

  updateSubagentBadge() {
    const badge = this.$('subagentCountBadge');
    const activeCount = Array.from(this.subagents.values()).filter(s => s.status === 'active' || s.status === 'idle').length;

    // Update badge with active count
    if (badge) {
      badge.textContent = activeCount > 0 ? activeCount : '';
    }
  },

  renderSubagentPanel() {
    // Debounce renders at 150ms to prevent excessive DOM updates from rapid subagent events
    if (this._subagentPanelRenderTimeout) {
      clearTimeout(this._subagentPanelRenderTimeout);
    }
    this._subagentPanelRenderTimeout = setTimeout(() => {
      scheduleBackground(() => this._renderSubagentPanelImmediate());
    }, 150);
  },

  _renderSubagentPanelImmediate() {
    const list = this.$('subagentList');
    if (!list) return;

    // Always update badge count
    this.updateSubagentBadge();

    // Always update monitor panel (even if subagent panel is hidden)
    this.renderMonitorSubagents();

    // If panel is not visible, don't render content
    if (!this.subagentPanelVisible) {
      return;
    }

    // Render subagent list
    if (this.subagents.size === 0) {
      list.innerHTML = '<div class="subagent-empty">No background agents detected</div>';
      return;
    }

    const html = [];
    const sorted = Array.from(this.subagents.values()).sort((a, b) => {
      // Active first, then by last activity
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return 1;
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });

    for (const agent of sorted) {
      const isActive = this.activeSubagentId === agent.agentId;
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const activity = this.subagentActivity.get(agent.agentId) || [];
      const lastActivity = activity[activity.length - 1];
      const lastTool = lastActivity?.type === 'tool' ? lastActivity.tool : null;
      const hasWindow = this.subagentWindows.has(agent.agentId);
      const canKill = agent.status === 'active' || agent.status === 'idle';
      const modelBadge = agent.modelShort
        ? `<span class="subagent-model-badge ${escapeHtml(agent.modelShort)}">${escapeHtml(agent.modelShort)}</span>`
        : '';

      const teammateInfo = this.getTeammateInfo(agent);
      const displayName = teammateInfo ? teammateInfo.name : (agent.description || agent.agentId.substring(0, 7));
      const teammateBadge = this.getTeammateBadgeHtml(agent);
      const agentIcon = teammateInfo ? `<span class="subagent-icon teammate-dot teammate-color-${teammateInfo.color}">●</span>` : '<span class="subagent-icon">🤖</span>';
      html.push(`
        <div class="subagent-item ${statusClass} ${isActive ? 'selected' : ''}${teammateInfo ? ' is-teammate' : ''}"
             onclick="app.selectSubagent(${escapeHtml(JSON.stringify(agent.agentId))})"
             ondblclick="app.openSubagentWindow(${escapeHtml(JSON.stringify(agent.agentId))})"
             title="Double-click to open tracking window">
          <div class="subagent-header">
            ${agentIcon}
            <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(displayName.length > 40 ? displayName.substring(0, 40) + '...' : displayName)}</span>
            ${teammateBadge}
            ${modelBadge}
            <span class="subagent-status ${statusClass}">${agent.status}</span>
            ${canKill ? `<button class="subagent-kill-btn" onclick="event.stopPropagation(); app.killSubagent(${escapeHtml(JSON.stringify(agent.agentId))})" title="Kill agent">&#x2715;</button>` : ''}
            <button class="subagent-window-btn" onclick="event.stopPropagation(); app.${hasWindow ? 'closeSubagentWindow' : 'openSubagentWindow'}(${escapeHtml(JSON.stringify(agent.agentId))})" title="${hasWindow ? 'Close window' : 'Open in window'}">
              ${hasWindow ? '✕' : '⧉'}
            </button>
          </div>
          <div class="subagent-meta">
            <span class="subagent-tools">${agent.toolCallCount} tools</span>
            ${lastTool ? `<span class="subagent-last-tool">${this.getToolIcon(lastTool)} ${lastTool}</span>` : ''}
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  },

  selectSubagent(agentId) {
    this.activeSubagentId = agentId;
    this.renderSubagentPanel();
    this.renderSubagentDetail();
  },

  renderSubagentDetail() {
    const detail = this.$('subagentDetail');
    if (!detail) return;

    if (!this.activeSubagentId) {
      detail.innerHTML = '<div class="subagent-empty">Select an agent to view details</div>';
      return;
    }

    const agent = this.subagents.get(this.activeSubagentId);
    const activity = this.subagentActivity.get(this.activeSubagentId) || [];

    if (!agent) {
      detail.innerHTML = '<div class="subagent-empty">Agent not found</div>';
      return;
    }

    const activityHtml = activity.slice(-30).map(a => {
      const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
      if (a.type === 'tool') {
        const toolDetail = this.getToolDetailExpanded(a.tool, a.input, a.fullInput, a.toolUseId);
        return `<div class="subagent-activity tool" data-tool-use-id="${escapeHtml(a.toolUseId || '')}">
          <span class="time">${time}</span>
          <span class="icon">${this.getToolIcon(a.tool)}</span>
          <span class="name">${escapeHtml(a.tool)}</span>
          <span class="detail">${escapeHtml(toolDetail.primary)}</span>
          ${toolDetail.hasMore ? `<button class="tool-expand-btn" onclick="app.toggleToolParams(${escapeHtml(JSON.stringify(a.toolUseId))})">▶</button>` : ''}
          ${toolDetail.hasMore ? `<div class="tool-params-expanded" id="tool-params-${escapeHtml(a.toolUseId)}" style="display:none;"><pre>${escapeHtml(JSON.stringify(a.fullInput || a.input, null, 2))}</pre></div>` : ''}
        </div>`;
      } else if (a.type === 'tool_result') {
        const icon = a.isError ? '❌' : '📄';
        const statusClass = a.isError ? 'error' : '';
        const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
        const preview = a.preview.length > 80 ? a.preview.substring(0, 80) + '...' : a.preview;
        return `<div class="subagent-activity tool-result ${statusClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="name">${escapeHtml(a.tool || 'result')}</span>
          <span class="detail">${escapeHtml(preview)}${sizeInfo}</span>
        </div>`;
      } else if (a.type === 'progress') {
        // Check for hook events
        const isHook = a.hookEvent || a.hookName;
        const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
        const hookClass = isHook ? ' hook' : '';
        const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
        return `<div class="subagent-activity progress${hookClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="detail">${escapeHtml(displayText)}</span>
        </div>`;
      } else if (a.type === 'message') {
        const preview = a.text.length > 100 ? a.text.substring(0, 100) + '...' : a.text;
        return `<div class="subagent-activity message">
          <span class="time">${time}</span>
          <span class="icon">💬</span>
          <span class="detail">${escapeHtml(preview)}</span>
        </div>`;
      }
      return '';
    }).join('');

    const detailTitle = agent.description || `Agent ${agent.agentId}`;
    const modelBadge = agent.modelShort
      ? `<span class="subagent-model-badge ${escapeHtml(agent.modelShort)}">${escapeHtml(agent.modelShort)}</span>`
      : '';
    const tokenStats = (agent.totalInputTokens || agent.totalOutputTokens)
      ? `<span>Tokens: ${this.formatTokenCount(agent.totalInputTokens || 0)}↓ ${this.formatTokenCount(agent.totalOutputTokens || 0)}↑</span>`
      : '';

    detail.innerHTML = `
      <div class="subagent-detail-header">
        <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(detailTitle.length > 60 ? detailTitle.substring(0, 60) + '...' : detailTitle)}</span>
        ${modelBadge}
        <span class="subagent-status ${agent.status}">${agent.status}</span>
        <button class="subagent-transcript-btn" onclick="app.viewSubagentTranscript(${escapeHtml(JSON.stringify(agent.agentId))})">
          View Full Transcript
        </button>
      </div>
      <div class="subagent-detail-stats">
        <span>Tools: ${agent.toolCallCount}</span>
        <span>Entries: ${agent.entryCount}</span>
        <span>Size: ${(agent.fileSize / 1024).toFixed(1)}KB</span>
        ${tokenStats}
      </div>
      <div class="subagent-activity-log">
        ${activityHtml || '<div class="subagent-empty">No activity yet</div>'}
      </div>
    `;
  },

  toggleToolParams(toolUseId) {
    const el = document.getElementById(`tool-params-${toolUseId}`);
    if (!el) return;
    const btn = el.previousElementSibling;
    if (el.style.display === 'none') {
      el.style.display = 'block';
      if (btn) btn.textContent = '▼';
    } else {
      el.style.display = 'none';
      if (btn) btn.textContent = '▶';
    }
  },

  formatTokenCount(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return count.toString();
  },

  formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return bytes + 'B';
  },

  getToolIcon(tool) {
    const icons = {
      WebSearch: '🔍',
      WebFetch: '🌐',
      Read: '📖',
      Write: '📝',
      Edit: '✏️',
      Bash: '💻',
      Glob: '📁',
      Grep: '🔎',
      Task: '🤖',
    };
    return icons[tool] || '🔧';
  },

  getToolDetail(tool, input) {
    if (!input) return '';
    if (tool === 'WebSearch' && input.query) return `"${input.query}"`;
    if (tool === 'WebFetch' && input.url) return input.url;
    if (tool === 'Read' && input.file_path) return input.file_path;
    if ((tool === 'Write' || tool === 'Edit') && input.file_path) return input.file_path;
    if (tool === 'Bash' && input.command) {
      const cmd = input.command;
      return cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd;
    }
    if (tool === 'Glob' && input.pattern) return input.pattern;
    if (tool === 'Grep' && input.pattern) return input.pattern;
    return '';
  },

  getToolDetailExpanded(tool, input, fullInput, toolUseId) {
    const primary = this.getToolDetail(tool, input);
    // Check if there are additional params beyond the primary one
    const primaryKeys = ['query', 'url', 'file_path', 'command', 'pattern'];
    const inputKeys = Object.keys(fullInput || input || {});
    const extraKeys = inputKeys.filter(k => !primaryKeys.includes(k));
    const hasMore = extraKeys.length > 0 || (fullInput && JSON.stringify(fullInput).length > 100);
    return { primary, hasMore, fullInput: fullInput || input };
  },

  async killSubagent(agentId) {
    try {
      const res = await this._apiDelete(`/api/subagents/${agentId}`);
      const data = await res?.json();
      if (data?.success) {
        // Update local state
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.status = 'completed';
          this.subagents.set(agentId, agent);
        }
        this.renderSubagentPanel();
        this.renderSubagentDetail();
        this.updateSubagentWindows();
        this.showToast(`Subagent ${agentId.substring(0, 7)} killed`, 'success');
      } else {
        this.showToast(data.error || 'Failed to kill subagent', 'error');
      }
    } catch (err) {
      console.error('Failed to kill subagent:', err);
      this.showToast('Failed to kill subagent: ' + err.message, 'error');
    }
  },

  async viewSubagentTranscript(agentId) {
    try {
      const res = await fetch(`/api/subagents/${agentId}/transcript?format=formatted`);
      const data = await res.json();

      if (!data.success) {
        alert('Failed to load transcript');
        return;
      }

      // Show in a modal or new window
      const content = data.data.formatted.join('\n');
      const win = window.open('', '_blank', 'width=800,height=600');
      win.document.write(`
        <html>
          <head>
            <title>Subagent ${escapeHtml(agentId)} Transcript</title>
            <style>
              body { background: #1a1a2e; color: #eee; font-family: monospace; padding: 20px; }
              pre { white-space: pre-wrap; word-wrap: break-word; }
            </style>
          </head>
          <body>
            <h2>Subagent ${escapeHtml(agentId)} Transcript (${data.data.entryCount} entries)</h2>
            <pre>${escapeHtml(content)}</pre>
          </body>
        </html>
      `);
    } catch (err) {
      console.error('Failed to load transcript:', err);
      alert('Failed to load transcript: ' + err.message);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Subagent Parent TAB Tracking
  // ═══════════════════════════════════════════════════════════════
  //
  // CRITICAL: This system tracks which TAB an agent window connects to.
  // The association is stored in `subagentParentMap` (agentId -> sessionId).
  // The sessionId IS the tab identifier (tabs have data-id="${sessionId}").
  // Once set, this association is PERMANENT and persisted across restarts.

  /**
   * Find and assign the parent TAB for a subagent.
   *
   * Matching strategy (in order):
   * 1. Use existing stored association from subagentParentMap (permanent)
   * 2. Match via claudeSessionId (agent.sessionId === session.claudeSessionId)
   * 3. FALLBACK: Use the currently active session (since that's where the user typed the command)
   *
   * Once found, the association is stored PERMANENTLY in subagentParentMap.
   */
  findParentSessionForSubagent(agentId) {
    // Check if we already have a permanent association
    if (this.subagentParentMap.has(agentId)) {
      // Already have a parent - update agent object from stored value
      const storedSessionId = this.subagentParentMap.get(agentId);
      // Verify the session still exists
      if (this.sessions.has(storedSessionId)) {
        const agent = this.subagents.get(agentId);
        if (agent && !agent.parentSessionId) {
          agent.parentSessionId = storedSessionId;
          const session = this.sessions.get(storedSessionId);
          if (session) {
            agent.parentSessionName = this.getSessionName(session);
          }
          this.subagents.set(agentId, agent);
          this.updateSubagentWindowParent(agentId);
        }
        return;
      }
      // Stored session no longer exists - clear and re-discover
      this.subagentParentMap.delete(agentId);
    }

    const agent = this.subagents.get(agentId);
    if (!agent) return;

    // Strategy 1: Match via claudeSessionId (most accurate)
    if (agent.sessionId) {
      for (const [sessionId, session] of this.sessions) {
        if (session.claudeSessionId === agent.sessionId) {
          // FOUND! Store this association PERMANENTLY
          this.setAgentParentSessionId(agentId, sessionId);
          this.updateSubagentWindowParent(agentId);
          this.updateSubagentWindowVisibility();
          this.updateConnectionLines();
          return;
        }
      }
    }

    // Strategy 2: FALLBACK - Use the currently active session
    // This works because agents spawn from where the user typed the command
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      this.setAgentParentSessionId(agentId, this.activeSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
      return;
    }

    // Strategy 3: If no active session, use the first session
    if (this.sessions.size > 0) {
      const firstSessionId = this.sessions.keys().next().value;
      this.setAgentParentSessionId(agentId, firstSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
    }
  },

  /**
   * Re-check all orphan subagents (those without a parent TAB) when a session updates.
   * Called when session:updated fires with claudeSessionId.
   *
   * Also re-validates existing associations when claudeSessionId becomes available,
   * in case the fallback association was wrong.
   */
  recheckOrphanSubagents() {
    let anyChanged = false;
    for (const [agentId, agent] of this.subagents) {
      // Check if this agent has no parent in the persistent map
      if (!this.subagentParentMap.has(agentId)) {
        this.findParentSessionForSubagent(agentId);
        if (this.subagentParentMap.has(agentId)) {
          anyChanged = true;
        }
      } else if (agent.sessionId) {
        // Agent has a stored parent, but check if we can now do a proper claudeSessionId match
        // This handles the case where fallback was used but now the real parent is known
        const storedParent = this.subagentParentMap.get(agentId);
        const storedSession = this.sessions.get(storedParent);

        // If the stored session doesn't have a matching claudeSessionId, try to find the real match
        if (storedSession && storedSession.claudeSessionId !== agent.sessionId) {
          for (const [sessionId, session] of this.sessions) {
            if (session.claudeSessionId === agent.sessionId) {
              // Found the real parent - update the association
              this.subagentParentMap.set(agentId, sessionId);
              agent.parentSessionId = sessionId;
              agent.parentSessionName = this.getSessionName(session);
              this.subagents.set(agentId, agent);
              this.updateSubagentWindowParent(agentId);
              anyChanged = true;
              break;
            }
          }
        }
      }
    }
    if (anyChanged) {
      this.saveSubagentParentMap();
      this.updateConnectionLines();
    }
  },

  /**
   * Update parentSessionName for all subagents belonging to a TAB.
   * Called when a session is renamed to keep cached names fresh.
   */
  updateSubagentParentNames(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const newName = this.getSessionName(session);

    // Skip iteration if name hasn't changed (avoids O(n) loop on every session:updated)
    const cachedName = this._parentNameCache?.get(sessionId);
    if (cachedName === newName) return;
    if (!this._parentNameCache) this._parentNameCache = new Map();
    this._parentNameCache.set(sessionId, newName);

    for (const [agentId, storedSessionId] of this.subagentParentMap) {
      if (storedSessionId === sessionId) {
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.parentSessionName = newName;
          this.subagents.set(agentId, agent);

          // Update the window header if open
          const windowData = this.subagentWindows.get(agentId);
          if (windowData) {
            const parentNameEl = windowData.element.querySelector('.subagent-window-parent .parent-name');
            if (parentNameEl) {
              parentNameEl.textContent = newName;
            }
          }
        }
      }
    }
  },

  /**
   * Add parent header to an agent window, showing which TAB it belongs to.
   */
  updateSubagentWindowParent(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (!windowData) return;

    // Get parent from persistent map (THE source of truth)
    const parentSessionId = this.subagentParentMap.get(agentId);
    if (!parentSessionId) return;

    const session = this.sessions.get(parentSessionId);
    const parentName = session ? this.getSessionName(session) : 'Unknown';

    // Check if parent header already exists
    const win = windowData.element;
    const existingParent = win.querySelector('.subagent-window-parent');
    if (existingParent) {
      // Update existing
      existingParent.dataset.parentSession = parentSessionId;
      const nameEl = existingParent.querySelector('.parent-name');
      if (nameEl) {
        nameEl.textContent = parentName;
        nameEl.onclick = () => this.selectSession(parentSessionId);
      }
      return;
    }

    // Insert new parent header after the main header
    const header = win.querySelector('.subagent-window-header');
    if (header) {
      const parentDiv = document.createElement('div');
      parentDiv.className = 'subagent-window-parent';
      parentDiv.dataset.parentSession = parentSessionId;
      parentDiv.innerHTML = `
        <span class="parent-label">from</span>
        <span class="parent-name" onclick="app.selectSession(${escapeHtml(JSON.stringify(parentSessionId))})">${escapeHtml(parentName)}</span>
      `;
      header.insertAdjacentElement('afterend', parentDiv);
    }
  },


  /**
   * Show/hide subagent windows based on active session.
   * Behavior controlled by "Subagents for Active Tab Only" setting.
   * Uses the PERSISTENT subagentParentMap for accurate tab-based visibility.
   */
  updateSubagentWindowVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;

    for (const [agentId, windowInfo] of this.subagentWindows) {
      // Get parent from PERSISTENT map (THE source of truth)
      const storedParent = this.subagentParentMap.get(agentId);
      const agent = this.subagents.get(agentId);
      const parentSessionId = storedParent || agent?.parentSessionId;

      // Determine visibility based on setting
      let shouldShow;
      if (activeTabOnly) {
        // Show if: no parent known yet, or parent matches active session
        const hasKnownParent = !!parentSessionId;
        shouldShow = !hasKnownParent || parentSessionId === this.activeSessionId;
      } else {
        // Show all windows (original behavior)
        shouldShow = true;
      }

      if (shouldShow) {
        // Show window (unless it was minimized by user)
        if (!windowInfo.minimized) {
          windowInfo.element.style.display = 'flex';
          // Lazily re-create teammate terminal if it was disposed when hidden
          if (windowInfo._lazyTerminal) {
            this._restoreTeammateTerminalFromLazy(agentId);
          }
        }
        windowInfo.hidden = false;
      } else {
        // Hide window (but don't close it)
        // Dispose teammate terminal to free memory while hidden on inactive tab
        this._disposeTeammateTerminalForMinimize(agentId);
        windowInfo.element.style.display = 'none';
        windowInfo.hidden = true;
      }
    }
    // Update connection lines after visibility changes
    this.updateConnectionLines();
    // Restack mobile windows after visibility changes
    this.relayoutMobileSubagentWindows();
  },


  // Close all subagent windows for a session (fully removes them, not minimize)
  // If cleanupData is true, also remove activity and toolResults data to prevent memory leaks
  closeSessionSubagentWindows(sessionId, cleanupData = false) {
    const toClose = [];
    for (const [agentId, _windowData] of this.subagentWindows) {
      const agent = this.subagents.get(agentId);
      // Check both subagent parentSessionId and subagentParentMap
      // (standalone pane windows use subagentParentMap, not subagents map)
      const parentFromMap = this.subagentParentMap.get(agentId);
      if (agent?.parentSessionId === sessionId || parentFromMap === sessionId) {
        toClose.push(agentId);
      }
    }
    for (const agentId of toClose) {
      this.forceCloseSubagentWindow(agentId);
      // Clean up activity and tool results data if requested (prevents memory leaks)
      if (cleanupData) {
        this.subagents.delete(agentId);
        this.subagentActivity.delete(agentId);
        this.subagentToolResults.delete(agentId);
        this.subagentParentMap.delete(agentId);
      }
    }
    // Also clean up minimized agents for this session
    this.minimizedSubagents.delete(sessionId);
    this.renderSessionTabs();
  },

  // Fully close a subagent window (removes from DOM, not minimize)
  forceCloseSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      // Clean up resize observer
      if (windowData.resizeObserver) {
        windowData.resizeObserver.disconnect();
      }
      // Clean up drag event listeners (both document-level and handle-level)
      if (windowData.dragListeners) {
        document.removeEventListener('mousemove', windowData.dragListeners.move);
        document.removeEventListener('mouseup', windowData.dragListeners.up);
        if (windowData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', windowData.dragListeners.touchMove);
          document.removeEventListener('touchend', windowData.dragListeners.up);
          document.removeEventListener('touchcancel', windowData.dragListeners.up);
        }
        // Remove handle-level listeners before DOM removal
        if (windowData.dragListeners.handle) {
          windowData.dragListeners.handle.removeEventListener('mousedown', windowData.dragListeners.handleMouseDown);
          windowData.dragListeners.handle.removeEventListener('touchstart', windowData.dragListeners.handleTouchStart);
        }
      }
      windowData.element.remove();
      this.subagentWindows.delete(agentId);
    }
    // Clean up teammate terminal if present
    const termData = this.teammateTerminals.get(agentId);
    if (termData) {
      if (termData.resizeObserver) {
        termData.resizeObserver.disconnect();
      }
      if (termData.terminal) {
        try { termData.terminal.dispose(); } catch {}
      }
      this.teammateTerminals.delete(agentId);
    }
  },


  minimizeSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      // Dispose teammate terminal on minimize to free DOM/memory (lazy re-creation on restore)
      this._disposeTeammateTerminalForMinimize(agentId);
      windowData.element.style.display = 'none';
      windowData.minimized = true;
      this.updateConnectionLines();
    }
  },


  // Debounced wrapper — coalesces rapid subagent events (tool_call, progress,
  // message) into a single DOM update per 100ms per agent window.
  scheduleSubagentWindowRender(agentId) {
    // Skip DOM updates for windows with lazy (disposed) terminals — they're minimized
    const windowData = this.subagentWindows.get(agentId);
    if (windowData?.minimized) return;

    if (!this._subagentWindowRenderTimeouts) this._subagentWindowRenderTimeouts = new Map();
    if (this._subagentWindowRenderTimeouts.has(agentId)) {
      clearTimeout(this._subagentWindowRenderTimeouts.get(agentId));
    }
    this._subagentWindowRenderTimeouts.set(agentId, setTimeout(() => {
      this._subagentWindowRenderTimeouts.delete(agentId);
      scheduleBackground(() => this.renderSubagentWindowContent(agentId));
    }, 100));
  },

  renderSubagentWindowContent(agentId) {
    // Skip if this window has a live terminal (don't overwrite xterm with activity HTML)
    if (this.teammateTerminals.has(agentId)) return;
    // Skip if this window has a lazy (disposed) terminal — it will be re-created on restore
    const windowData = this.subagentWindows.get(agentId);
    if (windowData?._lazyTerminal) return;

    const body = document.getElementById(`subagent-window-body-${agentId}`);
    if (!body) return;

    const activity = this.subagentActivity.get(agentId) || [];

    if (activity.length === 0) {
      body.innerHTML = '<div class="subagent-empty">No activity yet</div>';
      return;
    }

    // Incremental rendering: track how many items are already rendered
    const renderedCount = body.dataset.renderedCount ? parseInt(body.dataset.renderedCount, 10) : 0;
    const maxItems = 100;
    const visibleActivity = activity.slice(-maxItems);

    // If activity was trimmed or this is a fresh render, do full rebuild
    if (renderedCount === 0 || renderedCount > visibleActivity.length || body.children.length === 0 ||
        (body.children.length === 1 && body.querySelector('.subagent-empty'))) {
      // Full rebuild
      const html = visibleActivity.map(a => this._renderActivityItem(a)).join('');
      body.innerHTML = html;
      body.dataset.renderedCount = String(visibleActivity.length);
    } else {
      // Incremental: only append new items
      const newItems = visibleActivity.slice(renderedCount);
      if (newItems.length > 0) {
        const newHtml = newItems.map(a => this._renderActivityItem(a)).join('');
        body.insertAdjacentHTML('beforeend', newHtml);
        body.dataset.renderedCount = String(visibleActivity.length);

        // Trim excess children from the front if over maxItems
        while (body.children.length > maxItems) {
          body.removeChild(body.firstChild);
        }
      }
    }

    body.scrollTop = body.scrollHeight;
  },

  _renderActivityItem(a) {
    const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
    if (a.type === 'tool') {
      return `<div class="activity-line">
        <span class="time">${time}</span>
        <span class="tool-icon">${this.getToolIcon(a.tool)}</span>
        <span class="tool-name">${escapeHtml(a.tool)}</span>
        <span class="tool-detail">${escapeHtml(this.getToolDetail(a.tool, a.input))}</span>
      </div>`;
    } else if (a.type === 'tool_result') {
      const icon = a.isError ? '❌' : '📄';
      const statusClass = a.isError ? ' error' : '';
      const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
      const preview = a.preview.length > 60 ? a.preview.substring(0, 60) + '...' : a.preview;
      return `<div class="activity-line result-line${statusClass}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${escapeHtml(a.tool || '→')}</span>
        <span class="tool-detail">${escapeHtml(preview)}${sizeInfo}</span>
      </div>`;
    } else if (a.type === 'progress') {
      const isHook = a.hookEvent || a.hookName;
      const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
      const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
      return `<div class="activity-line progress-line${isHook ? ' hook-line' : ''}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-detail">${escapeHtml(displayText)}</span>
      </div>`;
    } else if (a.type === 'message') {
      const preview = a.text.length > 150 ? a.text.substring(0, 150) + '...' : a.text;
      return `<div class="message-line">
        <span class="time">${time}</span> 💬 ${escapeHtml(preview)}
      </div>`;
    }
    return '';
  },

  // Update all open subagent windows
  updateSubagentWindows() {
    for (const agentId of this.subagentWindows.keys()) {
      this.renderSubagentWindowContent(agentId);
      this.updateSubagentWindowHeader(agentId);
    }
  },

  // Update subagent window header (title and status)
  updateSubagentWindowHeader(agentId) {
    const agent = this.subagents.get(agentId);
    if (!agent) return;

    const win = document.getElementById(`subagent-window-${agentId}`);
    if (!win) return;

    // Update title/id element with description if available
    const idEl = win.querySelector('.subagent-window-title .id');
    if (idEl) {
      const teammateInfo = this.getTeammateInfo(agent);
      const windowTitle = teammateInfo ? teammateInfo.name : (agent.description || agentId.substring(0, 7));
      const truncatedTitle = windowTitle.length > 50 ? windowTitle.substring(0, 50) + '...' : windowTitle;
      idEl.textContent = truncatedTitle;
    }

    // Add or update teammate badge
    let tmBadge = win.querySelector('.teammate-badge');
    const teammateInfo = this.getTeammateInfo(agent);
    if (teammateInfo && !tmBadge) {
      const titleContainer = win.querySelector('.subagent-window-title');
      if (titleContainer) {
        const badge = document.createElement('span');
        badge.className = `teammate-badge teammate-color-${teammateInfo.color}`;
        badge.title = `Team: ${teammateInfo.teamName}`;
        badge.textContent = `@${teammateInfo.name}`;
        const statusEl = titleContainer.querySelector('.status');
        if (statusEl) statusEl.insertAdjacentElement('beforebegin', badge);
      }
    }

    // Update full tooltip
    const titleContainer = win.querySelector('.subagent-window-title');
    if (titleContainer) {
      titleContainer.title = agent.description || agentId;
    }

    // Update or add model badge
    let modelBadge = win.querySelector('.subagent-window-title .subagent-model-badge');
    if (agent.modelShort) {
      if (!modelBadge) {
        modelBadge = document.createElement('span');
        modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
        const statusEl = win.querySelector('.subagent-window-title .status');
        if (statusEl) {
          statusEl.insertAdjacentElement('beforebegin', modelBadge);
        }
      }
      modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
      modelBadge.textContent = agent.modelShort;
    }

    // Update status
    const statusEl = win.querySelector('.subagent-window-title .status');
    if (statusEl) {
      statusEl.className = `status ${agent.status}`;
      statusEl.textContent = agent.status;
    }
  },

  // Open windows for all active subagents
  openAllActiveSubagentWindows() {
    for (const [agentId, agent] of this.subagents) {
      if (agent.status === 'active' && !this.subagentWindows.has(agentId)) {
        this.openSubagentWindow(agentId);
      }
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Agent Teams
  // ═══════════════════════════════════════════════════════════════

  /** Initialize an xterm.js terminal for a teammate's tmux pane */
  initTeammateTerminal(agentId, paneInfo, windowElement) {
    const body = windowElement.querySelector('.subagent-window-body');
    if (!body) return;

    // Clear the activity log content
    body.innerHTML = '';
    body.classList.add('teammate-terminal-body');
    windowElement.classList.add('has-terminal');

    const sessionId = paneInfo.sessionId;

    // Buffer incoming terminal data until xterm is ready
    const pendingData = [];
    this.teammateTerminals.set(agentId, {
      terminal: null,
      fitAddon: null,
      paneTarget: paneInfo.paneTarget,
      sessionId,
      resizeObserver: null,
      pendingData,
    });

    // Defer terminal creation to next frame so the body element has computed dimensions
    requestAnimationFrame(() => {
      // Safety: if window was closed before we got here, bail out
      if (!document.contains(body)) {
        this.teammateTerminals.delete(agentId);
        return;
      }

      const terminal = new Terminal({
        theme: { ...window.codemanCurrentXtermTheme() },
        minimumContrastRatio: window.codemanCurrentSkinIsLight() ? 4.5 : 1,
        fontFamily: window.CodemanTerminalFont.resolve(this.loadAppSettingsFromStorage?.().terminalFontFamily),
        fontSize: 12,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: DEFAULT_SCROLLBACK,
        allowTransparency: true,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);

      if (typeof Unicode11Addon !== 'undefined') {
        try {
          const unicode11Addon = new Unicode11Addon.Unicode11Addon();
          terminal.loadAddon(unicode11Addon);
          terminal.unicode.activeVersion = '11';
        } catch (_e) { /* Unicode11 addon failed */ }
      }

      try {
        terminal.open(body);
      } catch (err) {
        console.warn('[TeammateTerminal] Failed to open terminal:', err);
        this.teammateTerminals.delete(agentId);
        return;
      }

      // Wait for terminal renderer to fully initialize before any writes.
      // xterm.js needs a few frames after open() before write() is safe.
      setTimeout(() => {
        try { fitAddon.fit(); } catch {}

        // Fetch initial pane buffer
        fetch(`/api/sessions/${sessionId}/teammate-pane-buffer/${encodeURIComponent(paneInfo.paneTarget)}`)
          .then(r => r.json())
          .then(resp => {
            if (resp.success && resp.data?.buffer) {
              try { terminal.write(resp.data.buffer); } catch {}
            }
          })
          .catch(err => console.error('[TeammateTerminal] Failed to fetch buffer:', err));

        // Flush any data that arrived while terminal was initializing
        for (const chunk of pendingData) {
          try { terminal.write(chunk); } catch {}
        }
        pendingData.length = 0;
      }, 100);

      // Forward keyboard input to the teammate's pane
      terminal.onData((data) => {
        fetch(`/api/sessions/${sessionId}/teammate-pane-input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paneTarget: paneInfo.paneTarget, input: data }),
        }).catch(err => console.error('[TeammateTerminal] Failed to send input:', err));
      });

      // Resize observer to refit terminal when window is resized
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });
      });
      resizeObserver.observe(body);

      // Update the stored entry with the real terminal
      const entry = this.teammateTerminals.get(agentId);
      if (entry) {
        entry.terminal = terminal;
        entry.fitAddon = fitAddon;
        entry.resizeObserver = resizeObserver;
      }
    });
  },

  /** Open a standalone terminal window for a tmux-pane teammate (no subagent entry needed) */
  openTeammateTerminalWindow(paneData) {
    // Only open if the session has a tab in Codeman
    if (!this.sessions.has(paneData.sessionId)) return;

    // Use pane target as the unique ID for this window
    const windowId = `pane-${paneData.paneTarget}`;

    // If window already exists, focus it
    if (this.subagentWindows.has(windowId)) {
      const existing = this.subagentWindows.get(windowId);
      if (existing.hidden) {
        existing.element.style.display = 'flex';
        existing.hidden = false;
      }
      existing.element.style.zIndex = ++this.subagentWindowZIndex;
      if (existing.minimized) {
        this.restoreSubagentWindow(windowId);
      }
      return;
    }

    // Calculate position
    const windowCount = this.subagentWindows.size;
    const windowWidth = 550;
    const windowHeight = 400;
    const gap = 20;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const startX = 50;
    const startY = 120;
    const maxCols = Math.floor((viewportWidth - startX - 50) / (windowWidth + gap)) || 1;
    const maxRows = Math.floor((viewportHeight - startY - 50) / (windowHeight + gap)) || 1;
    const col = windowCount % maxCols;
    const row = Math.floor(windowCount / maxCols) % maxRows;
    let finalX = startX + col * (windowWidth + gap);
    let finalY = startY + row * (windowHeight + gap);
    finalX = Math.max(10, Math.min(finalX, viewportWidth - windowWidth - 10));
    finalY = Math.max(10, Math.min(finalY, viewportHeight - windowHeight - 10));

    // Color badge
    const colorClass = paneData.color || 'blue';

    // Create window element
    const win = document.createElement('div');
    win.className = 'subagent-window has-terminal';
    win.id = `subagent-window-${windowId}`;
    win.style.zIndex = ++this.subagentWindowZIndex;
    win.style.left = `${finalX}px`;
    win.style.top = `${finalY}px`;
    win.style.width = `${windowWidth}px`;
    win.style.height = `${windowHeight}px`;
    win.innerHTML = `
      <div class="subagent-window-header">
        <div class="subagent-window-title" title="Teammate terminal: ${escapeHtml(paneData.teammateName)} (pane ${paneData.paneTarget})">
          <span class="icon" style="color: var(--team-color-${colorClass}, #339af0)">⬤</span>
          <span class="id">${escapeHtml(paneData.teammateName)}</span>
          <span class="status running">terminal</span>
        </div>
        <div class="subagent-window-actions">
          <button onclick="app.closeSubagentWindow(${escapeHtml(JSON.stringify(windowId))})" title="Minimize to tab">─</button>
        </div>
      </div>
      <div class="subagent-window-body teammate-terminal-body" id="subagent-window-body-${windowId}">
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.subagent-window-header'));

    // Make resizable if method exists
    if (typeof this.makeWindowResizable === 'function') {
      this.makeWindowResizable(win);
    }

    // Check visibility based on active session
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;
    const shouldHide = activeTabOnly && paneData.sessionId !== this.activeSessionId;

    // Store reference
    this.subagentWindows.set(windowId, {
      element: win,
      minimized: false,
      hidden: shouldHide,
      dragListeners,
      description: `Teammate: ${paneData.teammateName}`,
    });

    // Also add to subagentParentMap for tab-based visibility
    this.subagentParentMap.set(windowId, paneData.sessionId);

    if (shouldHide) {
      win.style.display = 'none';
    }

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.subagentWindowZIndex;
    });

    // Resize observer for connection lines
    const resizeObserver = new ResizeObserver(() => {
      this.updateConnectionLines();
    });
    resizeObserver.observe(win);
    this.subagentWindows.get(windowId).resizeObserver = resizeObserver;

    // Init the xterm.js terminal (lazy if hidden)
    if (shouldHide) {
      // Window starts hidden — defer terminal creation until visible (lazy init)
      const windowEntry = this.subagentWindows.get(windowId);
      if (windowEntry) {
        windowEntry._lazyTerminal = true;
        windowEntry._lazyPaneTarget = paneData.paneTarget;
        windowEntry._lazySessionId = paneData.sessionId;
      }
    } else {
      this.initTeammateTerminal(windowId, paneData, win);
    }

    // Animate in
    requestAnimationFrame(() => {
      win.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      win.style.transform = 'scale(1)';
      win.style.opacity = '1';
    });
  },

  /** Rebuild the teammate lookup map from all team configs */
  rebuildTeammateMap() {
    this.teammateMap.clear();
    for (const [teamName, team] of this.teams) {
      for (const member of team.members) {
        if (member.agentType !== 'team-lead') {
          // Use name as key prefix for matching subagent descriptions
          this.teammateMap.set(member.name, {
            name: member.name,
            color: member.color || 'blue',
            teamName,
            agentId: member.agentId,
          });
        }
      }
    }
  },

  /** Check if a subagent is a teammate and return its info */
  getTeammateInfo(agent) {
    if (!agent?.description) return null;
    // Teammate descriptions start with <teammate-message teammate_id=
    const match = agent.description.match(/<teammate-message\s+teammate_id="?([^">\s]+)/);
    if (!match) return null;
    const teammateId = match[1];
    // Extract name from teammate_id (format: name@teamName)
    const name = teammateId.split('@')[0];
    return this.teammateMap.get(name) || { name, color: 'blue', teamName: 'unknown' };
  },

  /** Get teammate badge HTML for a subagent */
  getTeammateBadgeHtml(agent) {
    const info = this.getTeammateInfo(agent);
    if (!info) return '';
    return `<span class="teammate-badge teammate-color-${info.color}" title="Team: ${escapeHtml(info.teamName)}">@${escapeHtml(info.name)}</span>`;
  },

  /** Render the team tasks panel */
  renderTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (!panel) return;

    // Find team for active session
    let activeTeam = null;
    let activeTeamName = null;
    if (this.activeSessionId) {
      for (const [name, team] of this.teams) {
        if (team.leadSessionId === this.activeSessionId) {
          activeTeam = team;
          activeTeamName = name;
          break;
        }
      }
    }

    if (!activeTeam) {
      panel.style.display = 'none';
      return;
    }

    // Set initial position and make draggable on first show
    const wasHidden = panel.style.display === 'none';
    panel.style.display = 'flex';

    if (wasHidden && !this.teamTasksDragListeners) {
      // Position bottom-right
      const panelWidth = 360;
      const panelHeight = 300;
      panel.style.left = `${Math.max(10, window.innerWidth - panelWidth - 20)}px`;
      panel.style.top = `${Math.max(10, window.innerHeight - panelHeight - 70)}px`;
      // Make draggable
      const header = panel.querySelector('.team-tasks-header');
      if (header) {
        this.teamTasksDragListeners = this.makeWindowDraggable(panel, header);
      }
    }

    const tasks = this.teamTasks.get(activeTeamName) || [];
    const completed = tasks.filter(t => t.status === 'completed').length;
    const total = tasks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const headerEl = panel.querySelector('.team-tasks-header-text');
    if (headerEl) {
      const teammateCount = activeTeam.members.filter(m => m.agentType !== 'team-lead').length;
      headerEl.textContent = `Team Tasks (${teammateCount} teammates)`;
    }

    const progressEl = panel.querySelector('.team-tasks-progress-fill');
    if (progressEl) {
      progressEl.style.width = `${pct}%`;
    }

    const progressText = panel.querySelector('.team-tasks-progress-text');
    if (progressText) {
      progressText.textContent = `${completed}/${total}`;
    }

    const listEl = panel.querySelector('.team-tasks-list');
    if (!listEl) return;

    if (tasks.length === 0) {
      listEl.innerHTML = '<div class="team-task-empty">No tasks yet</div>';
      return;
    }

    const html = tasks.map(task => {
      const statusIcon = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◉' : '○';
      const statusClass = task.status.replace('_', '-');
      const ownerBadge = task.owner
        ? `<span class="team-task-owner teammate-color-${this.getTeammateColor(task.owner)}">${escapeHtml(task.owner)}</span>`
        : '';
      return `<div class="team-task-item ${statusClass}">
        <span class="team-task-status">${statusIcon}</span>
        <span class="team-task-subject">${escapeHtml(task.subject)}</span>
        ${ownerBadge}
      </div>`;
    }).join('');

    listEl.innerHTML = html;
  },

  /** Hide team tasks panel and clean up drag listeners */
  hideTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (panel) panel.style.display = 'none';
    if (this.teamTasksDragListeners) {
      document.removeEventListener('mousemove', this.teamTasksDragListeners.move);
      document.removeEventListener('mouseup', this.teamTasksDragListeners.up);
      if (this.teamTasksDragListeners.touchMove) {
        document.removeEventListener('touchmove', this.teamTasksDragListeners.touchMove);
        document.removeEventListener('touchend', this.teamTasksDragListeners.up);
        document.removeEventListener('touchcancel', this.teamTasksDragListeners.up);
      }
      if (this.teamTasksDragListeners.handle) {
        this.teamTasksDragListeners.handle.removeEventListener('mousedown', this.teamTasksDragListeners.handleMouseDown);
        this.teamTasksDragListeners.handle.removeEventListener('touchstart', this.teamTasksDragListeners.handleTouchStart);
      }
      this.teamTasksDragListeners = null;
    }
  },

  /** Get teammate color by name */
  getTeammateColor(name) {
    const info = this.teammateMap.get(name);
    return info?.color || 'blue';
  },


  // ═══════════════════════════════════════════════════════════════
  // Project Insights Panel (Bash Tools with Clickable File Paths)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Normalize a file path to its canonical form for comparison.
   * - Expands ~ to home directory approximation
   * - Resolves relative paths against working directory (case folder)
   * - Normalizes . and .. components
   */
  normalizeFilePath(path, workingDir) {
    if (!path) return '';

    let normalized = path.trim();
    const homeDir = '/home/' + (window.USER || 'user'); // Approximation

    // Expand ~ to home directory
    if (normalized.startsWith('~/')) {
      normalized = homeDir + normalized.slice(1);
    } else if (normalized === '~') {
      normalized = homeDir;
    }

    // If not absolute, resolve against working directory (case folder)
    if (!normalized.startsWith('/') && workingDir) {
      normalized = workingDir + '/' + normalized;
    }

    // Normalize path components (resolve . and ..)
    const parts = normalized.split('/');
    const stack = [];

    for (const part of parts) {
      if (part === '' || part === '.') {
        continue;
      } else if (part === '..') {
        if (stack.length > 1) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }

    return '/' + stack.join('/');
  },

  /**
   * Extract just the filename from a path.
   */
  getFilename(path) {
    const parts = path.split('/');
    return parts[parts.length - 1] || '';
  },

  /**
   * Check if a path is a "shallow root path" - an absolute path with only one
   * component after root (e.g., /test.txt, /file.log).
   * These are often typos where the user meant a relative path in the case folder.
   */
  isShallowRootPath(path) {
    if (!path.startsWith('/')) return false;
    const parts = path.split('/').filter(p => p !== '');
    return parts.length === 1;
  },

  /**
   * Check if a path is inside (or is) the working directory (case folder).
   */
  isPathInWorkingDir(path, workingDir) {
    if (!workingDir) return false;
    const normalized = this.normalizeFilePath(path, workingDir);
    return normalized.startsWith(workingDir + '/') || normalized === workingDir;
  },

  /**
   * Smart path equivalence check.
   * Two paths are considered equivalent if:
   * 1. They normalize to the same path (standard case)
   * 2. One is a "shallow root path" (e.g., /test.txt) and the other is the
   *    same filename inside the case folder - the shallow root path
   *    is likely a typo and they probably meant the same file.
   */
  pathsAreEquivalent(path1, path2, workingDir) {
    const norm1 = this.normalizeFilePath(path1, workingDir);
    const norm2 = this.normalizeFilePath(path2, workingDir);

    // Standard check: exact normalized match
    if (norm1 === norm2) return true;

    // Smart check: shallow root path vs case folder path with same filename
    const file1 = this.getFilename(norm1);
    const file2 = this.getFilename(norm2);

    if (file1 !== file2) return false; // Different filenames, can't be equivalent

    const shallow1 = this.isShallowRootPath(path1);
    const shallow2 = this.isShallowRootPath(path2);
    const inWorkDir1 = this.isPathInWorkingDir(norm1, workingDir);
    const inWorkDir2 = this.isPathInWorkingDir(norm2, workingDir);

    // If one is shallow root (e.g., /test.txt) and other is in case folder
    // with same filename, treat as equivalent (user likely made a typo)
    if (shallow1 && inWorkDir2) return true;
    if (shallow2 && inWorkDir1) return true;

    return false;
  },

  /**
   * Pick the "better" of two paths that resolve to the same file.
   * Prefers paths inside the case folder, longer/more explicit paths, and absolute paths.
   */
  pickBetterPath(path1, path2, workingDir) {
    // Prefer paths inside the case folder (working directory)
    if (workingDir) {
      const inWorkDir1 = this.isPathInWorkingDir(path1, workingDir);
      const inWorkDir2 = this.isPathInWorkingDir(path2, workingDir);
      if (inWorkDir1 && !inWorkDir2) return path1;
      if (inWorkDir2 && !inWorkDir1) return path2;
    }

    // Prefer absolute paths
    const abs1 = path1.startsWith('/');
    const abs2 = path2.startsWith('/');
    if (abs1 && !abs2) return path1;
    if (abs2 && !abs1) return path2;

    // Both absolute or both relative - prefer longer (more explicit)
    if (path1.length !== path2.length) {
      return path1.length > path2.length ? path1 : path2;
    }

    // Prefer paths without ~
    if (!path1.includes('~') && path2.includes('~')) return path1;
    if (!path2.includes('~') && path1.includes('~')) return path2;

    return path1;
  },

  /**
   * Deduplicate file paths across all tools, keeping the "best" version.
   * Uses smart equivalence checking:
   * - Standard normalization for relative vs absolute paths
   * - Detects likely typos (e.g., /file.txt when caseFolder/file.txt exists)
   * - Prefers paths inside the case folder (working directory)
   * - Prefers longer, more explicit paths
   * Returns a Map of normalized path -> best raw path.
   */
  deduplicateProjectInsightPaths(tools, workingDir) {
    // Collect all paths with their tool IDs
    const allPaths = [];
    for (const tool of tools) {
      for (const rawPath of tool.filePaths) {
        allPaths.push({ rawPath, toolId: tool.id });
      }
    }

    if (allPaths.length <= 1) {
      const pathMap = new Map();
      for (const p of allPaths) {
        pathMap.set(this.normalizeFilePath(p.rawPath, workingDir), p);
      }
      return pathMap;
    }

    // Sort paths: prefer paths in case folder first, then by length (longer first)
    allPaths.sort((a, b) => {
      const aInWorkDir = this.isPathInWorkingDir(a.rawPath, workingDir);
      const bInWorkDir = this.isPathInWorkingDir(b.rawPath, workingDir);
      if (aInWorkDir && !bInWorkDir) return -1;
      if (bInWorkDir && !aInWorkDir) return 1;
      return b.rawPath.length - a.rawPath.length; // Longer paths first
    });

    const result = new Map(); // normalized -> { rawPath, toolId }
    const seenNormalized = new Set();

    for (const { rawPath, toolId } of allPaths) {
      const normalized = this.normalizeFilePath(rawPath, workingDir);

      // Check if we've already seen an equivalent path
      let isDuplicate = false;
      for (const [, existing] of result) {
        if (this.pathsAreEquivalent(rawPath, existing.rawPath, workingDir)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate && !seenNormalized.has(normalized)) {
        result.set(normalized, { rawPath, toolId });
        seenNormalized.add(normalized);
      }
    }

    return result;
  },

  handleBashToolStart(sessionId, tool) {
    let tools = this.projectInsights.get(sessionId) || [];
    // Add new tool
    tools = tools.filter(t => t.id !== tool.id);
    tools.push(tool);
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  },

  handleBashToolEnd(sessionId, tool) {
    const tools = this.projectInsights.get(sessionId) || [];
    const existing = tools.find(t => t.id === tool.id);
    if (existing) {
      existing.status = 'completed';
    }
    this.renderProjectInsightsPanel();
    // Remove after a short delay
    setTimeout(() => {
      const current = this.projectInsights.get(sessionId) || [];
      this.projectInsights.set(sessionId, current.filter(t => t.id !== tool.id));
      this.renderProjectInsightsPanel();
    }, 2000);
  },

  handleBashToolsUpdate(sessionId, tools) {
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  },

  renderProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    const list = this.$('projectInsightsList');
    if (!panel || !list) return;

    // Check if panel is enabled in settings
    const settings = this.loadAppSettingsFromStorage();
    const showProjectInsights = settings.showProjectInsights ?? false;
    if (!showProjectInsights) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    // Get tools for active session only
    const tools = this.projectInsights.get(this.activeSessionId) || [];
    const runningTools = tools.filter(t => t.status === 'running');

    if (runningTools.length === 0) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    panel.classList.add('visible');
    this.projectInsightsPanelVisible = true;

    // Get working directory for path normalization
    const session = this.sessions.get(this.activeSessionId);
    const workingDir = session?.workingDir || this.currentSessionWorkingDir;

    // Smart deduplication: collect all unique paths across all tools
    // Paths that resolve to the same file are deduplicated, keeping the most complete version
    const deduplicatedPaths = this.deduplicateProjectInsightPaths(runningTools, workingDir);

    // Build a set of paths to show (only the best version of each unique file)
    const pathsToShow = new Set(Array.from(deduplicatedPaths.values()).map(p => p.rawPath));

    const html = [];
    for (const tool of runningTools) {
      // Filter this tool's paths to only include those that weren't deduplicated away
      const filteredPaths = tool.filePaths.filter(p => pathsToShow.has(p));

      // Skip tools with no paths to show (all were duplicates of better paths elsewhere)
      if (filteredPaths.length === 0) continue;

      const cmdDisplay = tool.command.length > 50
        ? tool.command.substring(0, 50) + '...'
        : tool.command;

      html.push(`
        <div class="project-insight-item" data-tool-id="${tool.id}">
          <div class="project-insight-command">
            <span class="icon">💻</span>
            <span class="cmd" title="${escapeHtml(tool.command)}">${escapeHtml(cmdDisplay)}</span>
            <span class="project-insight-status ${tool.status}">${tool.status}</span>
            ${tool.timeout ? `<span class="project-insight-timeout">${escapeHtml(tool.timeout)}</span>` : ''}
          </div>
          <div class="project-insight-paths">
      `);

      for (const path of filteredPaths) {
        const fileName = path.split('/').pop();
        html.push(`
            <span class="project-insight-filepath"
                  onclick="app.openLogViewerWindow(${escapeHtml(JSON.stringify(path))}, ${escapeHtml(JSON.stringify(tool.sessionId))})"
                  title="${escapeHtml(path)}">${escapeHtml(fileName)}</span>
        `);
      }

      html.push(`
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  },

  closeProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    if (panel) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // File Browser Panel
  // ═══════════════════════════════════════════════════════════════

  // Hidden files/folders (dot-prefixed) are filtered SERVER-side by
  // GET /api/sessions/:id/files, so the toggle re-fetches rather than
  // re-rendering the cached tree (issue #221). The flag is per-device and lives
  // in its own localStorage key instead of the app-settings object: that object
  // is rebuilt from the settings-modal DOM on every save, so a key toggled from
  // outside the modal would be dropped the next time settings are saved.
  _loadFileBrowserShowHidden() {
    try {
      return localStorage.getItem(FILE_BROWSER_SHOW_HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  },

  _syncFileBrowserHiddenBtn() {
    const btn = this.$('fileBrowserHiddenBtn');
    if (!btn) return;
    const on = this.fileBrowserShowHidden === true;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    const label = on ? 'Hide hidden files and folders' : 'Show hidden files and folders';
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
  },

  _ensureFileBrowserState() {
    if (!this._fileBrowserState) {
      const ownerSessionId = this.activeSessionId || null;
      const showHidden = this.fileBrowserShowHidden === true;
      this._fileBrowserState = {
        treeEpoch: 0,
        searchEpoch: 0,
        ownerSessionId,
        view: 'normal',
        normalState: this.fileBrowserData
          ? { sessionId: ownerSessionId, showHidden, treeEpoch: 0, phase: 'ready', data: this.fileBrowserData }
          : null,
        treeInFlight: null,
        inFlight: null,
        matches: [],
        deferredDirectoryTarget: null,
        filter: typeof this.fileBrowserFilter === 'string' ? this.fileBrowserFilter : '',
      };
    }
    return this._fileBrowserState;
  },

  _activateFileBrowserSession(sessionId) {
    if (!sessionId) return;

    const state = this._ensureFileBrowserState();
    if (state.inFlight?.timer !== undefined && state.inFlight?.timer !== null) {
      clearTimeout(state.inFlight.timer);
    }
    state.searchEpoch++;
    state.treeEpoch++;
    state.ownerSessionId = sessionId;
    state.treeInFlight = null;
    state.inFlight = null;
    state.normalState = null;
    state.matches = [];
    state.deferredDirectoryTarget = null;
    state.filter = '';
    state.view = 'normal';
    this.fileBrowserData = null;
    this.fileBrowserFilter = '';
    this.fileBrowserExpandedDirs?.clear?.();
    this.fileBrowserAllExpanded = false;

    const searchInput = this.$?.('fileBrowserSearch');
    if (searchInput) searchInput.value = '';
    this._syncFileBrowserExpandBtn();
    const expandBtn = this.$?.('fileBrowserExpandBtn');
    if (expandBtn) expandBtn.innerHTML = '\u229E';

    const panel = this.$?.('fileBrowserPanel');
    const treeEl = this.$?.('fileBrowserTree');
    const statusEl = this.$?.('fileBrowserStatus');
    const visible = panel?.classList.contains('visible') === true;
    if (treeEl) {
      treeEl.innerHTML = visible
        ? `<div class="file-browser-loading">${escapeHtml('Loading files...')}</div>`
        : '';
    }
    if (statusEl) statusEl.textContent = visible ? 'Loading files...' : '';

    if (visible) {
      const load = this.loadFileBrowser?.(sessionId);
      load?.catch?.(() => {});
    }
  },

  _resetFileBrowserForHide() {
    const state = this._ensureFileBrowserState();
    if (state.inFlight?.timer !== undefined && state.inFlight?.timer !== null) {
      clearTimeout(state.inFlight.timer);
    }
    state.searchEpoch++;
    state.treeEpoch++;
    state.treeInFlight = null;
    state.inFlight = null;
    state.normalState = null;
    state.matches = [];
    state.deferredDirectoryTarget = null;
    state.filter = '';
    state.view = 'normal';
    this.fileBrowserData = null;
    this.fileBrowserFilter = '';
    this.fileBrowserExpandedDirs?.clear?.();
    this.fileBrowserAllExpanded = false;

    const searchInput = this.$?.('fileBrowserSearch');
    if (searchInput) searchInput.value = '';
    this._syncFileBrowserExpandBtn();
    const expandBtn = this.$?.('fileBrowserExpandBtn');
    if (expandBtn) expandBtn.innerHTML = '\u229E';
    const treeEl = this.$?.('fileBrowserTree');
    if (treeEl) treeEl.innerHTML = '';
    const statusEl = this.$?.('fileBrowserStatus');
    if (statusEl) statusEl.textContent = '';
  },

  _setFileBrowserExpandDisabled(disabled) {
    const btn = this.$('fileBrowserExpandBtn');
    if (btn) btn.disabled = disabled;
  },

  _hasFileBrowserQuery() {
    const state = this._ensureFileBrowserState();
    const input = this.$?.('fileBrowserSearch');
    const inputValue = typeof input?.value === 'string' ? input.value : '';
    const filterValue = typeof state.filter === 'string' ? state.filter : '';
    return inputValue.trim() !== '' || filterValue.trim() !== '';
  },

  _syncFileBrowserExpandBtn() {
    this._setFileBrowserExpandDisabled(this._hasFileBrowserQuery());
  },

  _renderFileBrowserNormalStatus(data, showHidden) {
    const statusEl = this.$('fileBrowserStatus');
    if (!statusEl || !data) return;
    const { totalFiles, totalDirectories, truncated } = data;
    statusEl.textContent = `${totalFiles} files, ${totalDirectories} dirs${truncated ? ' (truncated)' : ''}${showHidden ? ' · hidden shown' : ''}`;
  },

  _isFileBrowserNormalCompatible(candidate, sessionId, showHidden, treeEpoch) {
    return (
      candidate?.sessionId === sessionId &&
      candidate.showHidden === showHidden &&
      candidate.treeEpoch === treeEpoch
    );
  },

  _isFileBrowserTreeContextCurrent(request, requireCurrentRecord = false) {
    const state = this._ensureFileBrowserState();
    return (
      (!requireCurrentRecord || state.treeInFlight === request) &&
      state.ownerSessionId === request.sessionId &&
      state.treeEpoch === request.treeEpoch &&
      (this.fileBrowserShowHidden === true) === request.showHidden
    );
  },

  _canRenderFileBrowserNormal(normalState) {
    const state = this._ensureFileBrowserState();
    return (
      state.view === 'normal' &&
      this.activeSessionId === normalState?.sessionId &&
      this._isFileBrowserNormalCompatible(
        normalState,
        state.ownerSessionId,
        this.fileBrowserShowHidden === true,
        state.treeEpoch,
      ) &&
      this.$('fileBrowserPanel')?.classList.contains('visible') === true
    );
  },

  _renderFileBrowserNormalState(normalState) {
    if (!normalState || !this._canRenderFileBrowserNormal(normalState)) return;
    const treeEl = this.$('fileBrowserTree');
    const statusEl = this.$('fileBrowserStatus');
    if (!treeEl) return;

    if (normalState.phase === 'loading') {
      this.fileBrowserData = null;
      treeEl.innerHTML = `<div class="file-browser-loading">${escapeHtml('Loading files...')}</div>`;
      if (statusEl) statusEl.textContent = 'Loading files...';
      return;
    }

    if (normalState.phase === 'error') {
      this.fileBrowserData = null;
      const detail = normalState.error && normalState.error !== 'Failed to load files'
        ? `: ${normalState.error}`
        : '';
      const message = `Failed to load files${detail}`;
      treeEl.innerHTML = `<div class="file-browser-empty">${escapeHtml(message)}</div>`;
      if (statusEl) statusEl.textContent = message;
      return;
    }

    if (normalState.phase !== 'ready') return;
    this.fileBrowserData = normalState.data;
    this._syncFileBrowserExpandBtn();
    this.renderFileBrowserTree(normalState.sessionId);
    this._renderFileBrowserNormalStatus(normalState.data, normalState.showHidden);
  },

  _validateFileBrowserTreeEnvelope(result) {
    if (!result || typeof result !== 'object' || result.success !== true) return null;
    const data = result.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.tree)) return null;
    if (data.mode === 'search') return null;
    if (
      typeof data.totalFiles !== 'number' ||
      !Number.isFinite(data.totalFiles) ||
      data.totalFiles < 0 ||
      typeof data.totalDirectories !== 'number' ||
      !Number.isFinite(data.totalDirectories) ||
      data.totalDirectories < 0 ||
      typeof data.truncated !== 'boolean'
    ) {
      return null;
    }

    const validNodes = nodes => nodes.every(node => {
      if (!node || typeof node !== 'object') return false;
      if (typeof node.name !== 'string' || typeof node.path !== 'string') return false;
      if (node.type !== 'file' && node.type !== 'directory') return false;
      if (node.size !== undefined && (typeof node.size !== 'number' || !Number.isFinite(node.size))) return false;
      if (node.extension !== undefined && typeof node.extension !== 'string') return false;
      if (node.children !== undefined && (!Array.isArray(node.children) || !validNodes(node.children))) return false;
      return true;
    });

    return validNodes(data.tree) ? data : null;
  },

  _normalizeFileBrowserTreeError(error) {
    return typeof error?.message === 'string' && error.message ? error.message : 'Failed to load files';
  },

  _validateFileBrowserSearchEnvelope(result) {
    if (!result || typeof result !== 'object' || result.success !== true) return null;
    const data = result.data;
    if (!data || typeof data !== 'object' || data.mode !== 'search' || !Array.isArray(data.matches)) return null;
    if (typeof data.truncated !== 'boolean') return null;
    if (
      data.matchCount !== undefined &&
      (typeof data.matchCount !== 'number' || !Number.isFinite(data.matchCount) || data.matchCount < 0)
    ) {
      return null;
    }
    for (const match of data.matches) {
      if (!match || typeof match !== 'object') return null;
      if (typeof match.name !== 'string' || typeof match.path !== 'string') return null;
      if (match.type !== 'file' && match.type !== 'directory') return null;
      if (match.size !== undefined && (typeof match.size !== 'number' || !Number.isFinite(match.size))) return null;
      if (match.extension !== undefined && typeof match.extension !== 'string') return null;
    }
    return data;
  },

  _canRenderFileBrowserSearch(request) {
    const state = this._ensureFileBrowserState();
    const panel = this.$('fileBrowserPanel');
    return (
      state.searchEpoch === request.epoch &&
      state.ownerSessionId === request.ownerSessionId &&
      this.activeSessionId === request.ownerSessionId &&
      (this.fileBrowserShowHidden === true) === request.showHidden &&
      state.filter === request.rawInput &&
      panel?.classList.contains('visible') === true
    );
  },

  _renderFileBrowserSearchError() {
    const treeEl = this.$('fileBrowserTree');
    const statusEl = this.$('fileBrowserStatus');
    const message = 'Search failed';
    if (treeEl) treeEl.innerHTML = `<div class="file-browser-empty">${escapeHtml(message)}</div>`;
    if (statusEl) statusEl.textContent = message;
  },

  _canContinueFileBrowserHiddenReload(continuation, normalState) {
    const state = this._ensureFileBrowserState();
    const input = this.$?.('fileBrowserSearch');
    const currentInput = typeof input?.value === 'string' ? input.value : state.filter;
    return (
      state.view === 'normal' &&
      state.searchEpoch === continuation.searchEpoch &&
      state.treeEpoch === continuation.treeEpoch &&
      state.ownerSessionId === continuation.ownerSessionId &&
      this.activeSessionId === continuation.ownerSessionId &&
      (this.fileBrowserShowHidden === true) === continuation.showHidden &&
      state.filter === continuation.rawInput &&
      currentInput === continuation.rawInput &&
      currentInput.trim() === continuation.query &&
      this.$?.('fileBrowserPanel')?.classList.contains('visible') === true &&
      normalState?.phase === 'ready' &&
      this._isFileBrowserNormalCompatible(
        normalState,
        continuation.ownerSessionId,
        continuation.showHidden,
        continuation.treeEpoch,
      )
    );
  },

  async toggleFileBrowserHidden() {
    const state = this._ensureFileBrowserState();
    const rawInput = typeof state.filter === 'string' ? state.filter : '';
    const query = rawInput.trim();
    this.fileBrowserShowHidden = !this.fileBrowserShowHidden;
    try {
      localStorage.setItem(FILE_BROWSER_SHOW_HIDDEN_KEY, this.fileBrowserShowHidden ? '1' : '0');
    } catch {}
    this._syncFileBrowserHiddenBtn();

    if (state.inFlight?.timer !== undefined && state.inFlight?.timer !== null) {
      clearTimeout(state.inFlight.timer);
    }
    state.searchEpoch++;
    state.inFlight = null;
    state.matches = [];
    state.deferredDirectoryTarget = null;
    state.normalState = null;
    this.fileBrowserData = null;
    if (query.length <= 256) state.view = 'normal';
    this._syncFileBrowserExpandBtn();

    // Expanded-directory state is deliberately preserved so toggling does not
    // collapse the tree the user just navigated.
    const ownerSessionId = state.ownerSessionId || this.activeSessionId;
    if (!ownerSessionId || this.activeSessionId !== ownerSessionId) return;

    const searchEpoch = state.searchEpoch;
    const showHidden = this.fileBrowserShowHidden === true;
    const load = this.loadFileBrowser(ownerSessionId, { force: true });
    const treeEpoch = state.treeEpoch;
    if (!load?.then) return;
    await load;

    if (!query || query.length > 256) return;
    const continuation = { ownerSessionId, showHidden, treeEpoch, searchEpoch, rawInput, query };
    if (this._canContinueFileBrowserHiddenReload(continuation, state.normalState)) {
      this.filterFileBrowser(rawInput);
    }
  },

  loadFileBrowser(sessionId, { force = false } = {}) {
    if (!sessionId) return undefined;

    const state = this._ensureFileBrowserState();
    const treeEl = this.$('fileBrowserTree');
    this._syncFileBrowserHiddenBtn();
    if (!treeEl) return undefined;
    if (!state.ownerSessionId) state.ownerSessionId = sessionId;
    if (state.ownerSessionId !== sessionId) return undefined;

    if (force) state.treeEpoch++;
    const showHidden = this.fileBrowserShowHidden === true;
    const treeEpoch = state.treeEpoch;
    const inFlight = state.treeInFlight;
    if (
      !force &&
      this._isFileBrowserNormalCompatible(inFlight, sessionId, showHidden, treeEpoch)
    ) {
      return inFlight.promise;
    }

    const settled = state.normalState;
    if (
      !force &&
      this._isFileBrowserNormalCompatible(settled, sessionId, showHidden, treeEpoch) &&
      (settled.phase === 'ready' || settled.phase === 'error')
    ) {
      if (settled.phase === 'ready') this.fileBrowserData = settled.data;
      this._renderFileBrowserNormalState(settled);
      return Promise.resolve(settled);
    }

    const loadingState = { sessionId, showHidden, treeEpoch, phase: 'loading' };
    state.normalState = loadingState;
    this.fileBrowserData = null;
    this._renderFileBrowserNormalState(loadingState);

    const record = { sessionId, showHidden, treeEpoch, promise: null };
    const request = (async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/files?depth=5&showHidden=${showHidden}`,
        );
        if (!res.ok) throw new Error('Failed to load files');
        const result = await res.json();
        const data = this._validateFileBrowserTreeEnvelope(result);
        if (!data) {
          const detail = result && typeof result === 'object' && typeof result.error === 'string'
            ? result.error
            : 'Failed to load files';
          throw new Error(detail);
        }
        if (!this._isFileBrowserTreeContextCurrent(record, true)) return;

        const nextNormalState = { sessionId, showHidden, treeEpoch, phase: 'ready', data };
        state.normalState = nextNormalState;
        this.fileBrowserData = data;
        const deferredRendered = this._completeDeferredFileBrowserDirectory?.(nextNormalState) === true;
        if (!deferredRendered) this._renderFileBrowserNormalState(nextNormalState);
      } catch (error) {
        if (!this._isFileBrowserTreeContextCurrent(record, true)) return;
        const nextNormalState = {
          sessionId,
          showHidden,
          treeEpoch,
          phase: 'error',
          error: this._normalizeFileBrowserTreeError(error),
        };
        state.normalState = nextNormalState;
        this.fileBrowserData = null;
        this._completeDeferredFileBrowserDirectory?.(nextNormalState);
        console.error('Failed to load file browser:', error);
        this._renderFileBrowserNormalState(nextNormalState);
      }
    })();
    record.promise = request.finally(() => {
      if (state.treeInFlight === record) state.treeInFlight = null;
    });
    state.treeInFlight = record;
    return record.promise;
  },

  renderFileBrowserTree(ownerSessionId) {
    const treeEl = this.$('fileBrowserTree');
    if (!treeEl || !this.fileBrowserData) return;

    const state = this._ensureFileBrowserState();
    const owner = ownerSessionId || state.normalState?.sessionId || state.ownerSessionId || this.activeSessionId;
    if (!owner) return;

    const { tree } = this.fileBrowserData;
    if (!tree || tree.length === 0) {
      treeEl.innerHTML = '<div class="file-browser-empty">No files found</div>';
      return;
    }

    const html = [];

    const renderNode = (node, depth) => {
      const isDir = node.type === 'directory';
      const isExpanded = this.fileBrowserExpandedDirs.has(node.path);

      const icon = isDir
        ? (isExpanded ? '\uD83D\uDCC2' : '\uD83D\uDCC1')
        : this.getFileIcon(node.extension);

      const expandIcon = isDir
        ? `<span class="file-tree-expand${isExpanded ? ' expanded' : ''}">\u25B6</span>`
        : '<span class="file-tree-expand"></span>';

      const sizeStr = !isDir && node.size !== undefined
        ? `<span class="file-tree-size">${this.formatFileSize(node.size)}</span>`
        : '';

      const nameClass = isDir ? 'file-tree-name directory' : 'file-tree-name';

      const downloadBtn = !isDir
        ? `<a class="file-tree-download" href="${escapeHtml(`/api/sessions/${encodeURIComponent(owner)}/file-raw?path=${encodeURIComponent(node.path)}&download=true`)}" title="Download" onclick="event.stopPropagation()">&#x2B07;</a>`
        : '';

      html.push(`
        <div class="file-tree-item" data-path="${escapeHtml(node.path)}" data-type="${escapeHtml(node.type)}" data-depth="${depth}">
          ${expandIcon}
          <span class="file-tree-icon">${icon}</span>
          <span class="${nameClass}">${escapeHtml(node.name)}</span>
          ${sizeStr}
          ${downloadBtn}
        </div>
      `);

      // Render children if directory is expanded
      if (isDir && isExpanded && node.children) {
        for (const child of node.children) {
          renderNode(child, depth + 1);
        }
      }
    };

    for (const node of tree) {
      renderNode(node, 0);
    }

    treeEl.innerHTML = html.join('');

    // Add click handlers
    treeEl.querySelectorAll('.file-tree-item').forEach(item => {
      item.addEventListener('click', () => {
        const path = item.dataset.path;
        const type = item.dataset.type;

        if (type === 'directory') {
          this.toggleFileBrowserFolder(path);
        } else {
          this.openFilePreview(path, owner);
        }
      });
    });
  },

  toggleFileBrowserFolder(path) {
    if (this.fileBrowserExpandedDirs.has(path)) {
      this.fileBrowserExpandedDirs.delete(path);
    } else {
      this.fileBrowserExpandedDirs.add(path);
    }
    this.renderFileBrowserTree();
  },

  filterFileBrowser(value) {
    const state = this._ensureFileBrowserState();
    const rawInput = String(value ?? '');
    const query = rawInput.trim();
    state.searchEpoch++;
    state.filter = rawInput;
    state.deferredDirectoryTarget = null;
    this.fileBrowserFilter = rawInput;
    this._syncFileBrowserExpandBtn();

    if (state.inFlight?.timer !== undefined && state.inFlight?.timer !== null) {
      clearTimeout(state.inFlight.timer);
    }
    state.inFlight = null;

    if (!state.ownerSessionId && this.activeSessionId) state.ownerSessionId = this.activeSessionId;
    const ownerSessionId = state.ownerSessionId || null;
    if (!this.activeSessionId || !ownerSessionId || this.activeSessionId !== ownerSessionId) return;
    if (!query) {
      state.view = 'normal';
      state.matches = [];
      this._syncFileBrowserExpandBtn();
      const normal = state.normalState;
      if (
        ownerSessionId &&
        this._isFileBrowserNormalCompatible(
          normal,
          ownerSessionId,
          this.fileBrowserShowHidden === true,
          state.treeEpoch,
        )
      ) {
        this._renderFileBrowserNormalState(normal);
      }
      return;
    }

    if (query.length > 256) {
      const message = 'Search queries are limited to 256 characters';
      state.view = 'query-error';
      state.matches = [];
      this._syncFileBrowserExpandBtn();
      const treeEl = this.$('fileBrowserTree');
      const statusEl = this.$('fileBrowserStatus');
      if (treeEl) treeEl.innerHTML = `<div class="file-browser-empty">${escapeHtml(message)}</div>`;
      if (statusEl) statusEl.textContent = message;
      return;
    }

    const panel = this.$('fileBrowserPanel');
    const treeEl = this.$('fileBrowserTree');
    if (!ownerSessionId || !panel || !treeEl) return;

    const request = {
      epoch: state.searchEpoch,
      treeEpoch: state.treeEpoch,
      ownerSessionId,
      showHidden: this.fileBrowserShowHidden === true,
      rawInput,
      query,
      timer: null,
    };
    state.view = 'search-pending';
    state.matches = [];
    state.inFlight = request;
    this._syncFileBrowserExpandBtn();
    treeEl.innerHTML = `<div class="file-browser-loading">${escapeHtml('Searching...')}</div>`;
    const statusEl = this.$('fileBrowserStatus');
    if (statusEl) statusEl.textContent = 'Searching...';

    request.timer = setTimeout(async () => {
      request.timer = null;
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(ownerSessionId)}/files?depth=5&showHidden=${request.showHidden}&q=${encodeURIComponent(query)}`,
        );
        if (!res.ok) throw new Error('Search failed');
        const result = await res.json();
        const data = this._validateFileBrowserSearchEnvelope(result);
        if (!data) throw new Error('Search failed');
        const canRender = this._canRenderFileBrowserSearch(request);
        if (state.inFlight === request) state.inFlight = null;
        if (!canRender) return;
        state.view = 'search-results';
        state.matches = data.matches;
        this._renderFileBrowserSearchResults(data.matches, ownerSessionId, data);
      } catch (err) {
        const canRender = this._canRenderFileBrowserSearch(request);
        if (state.inFlight === request) state.inFlight = null;
        if (!canRender) return;
        console.error('Failed to search file browser:', err);
        state.view = 'search-error';
        state.matches = [];
        this._renderFileBrowserSearchError();
      }
    }, 250);
  },

  _renderFileBrowserSearchResults(matches, ownerSessionId, data) {
    const treeEl = this.$('fileBrowserTree');
    if (!treeEl || !ownerSessionId) return;
    const state = this._ensureFileBrowserState();
    const searchContext = {
      ownerSessionId,
      showHidden: this.fileBrowserShowHidden === true,
      treeEpoch: state.treeEpoch,
      searchEpoch: state.searchEpoch,
      rawInput: state.filter,
      query: state.filter.trim(),
      view: state.view,
    };
    if (matches.length === 0) {
      treeEl.innerHTML = `<div class="file-browser-empty">${escapeHtml('No matches')}</div>`;
    } else {
      const ownerPath = encodeURIComponent(ownerSessionId);
      treeEl.innerHTML = matches
        .map(match => {
          const isDir = match.type === 'directory';
          const icon = isDir ? '📁' : this.getFileIcon(match.extension || '');
          const sizeStr = !isDir && match.size !== undefined
            ? `<span class="file-tree-size">${this.formatFileSize(match.size)}</span>`
            : '';
          const nameClass = isDir ? 'file-tree-name directory' : 'file-tree-name';
          const downloadBtn = !isDir
            ? `<a class="file-tree-download" href="${escapeHtml(`/api/sessions/${ownerPath}/file-raw?path=${encodeURIComponent(match.path)}&download=true`)}" title="Download" onclick="event.stopPropagation()">&#x2B07;</a>`
            : '';
          return `
            <div class="file-tree-item" data-path="${escapeHtml(match.path)}" data-type="${escapeHtml(match.type)}" data-owner="${escapeHtml(ownerSessionId)}">
              <span class="file-tree-expand"></span>
              <span class="file-tree-icon">${icon}</span>
              <span class="${nameClass}">${escapeHtml(match.name)}</span>
              ${sizeStr}
              ${downloadBtn}
            </div>
          `;
        })
        .join('');
    }

    treeEl.querySelectorAll('.file-tree-item').forEach(item => {
      item.addEventListener('click', () => {
        const path = item.dataset.path;
        if (item.dataset.type === 'directory') {
          this._openFileBrowserSearchDirectory({ ...searchContext, path });
        } else {
          this.openFilePreview(path, ownerSessionId);
        }
      });
    });

    const statusEl = this.$('fileBrowserStatus');
    if (statusEl) {
      const count = data.matchCount === undefined ? matches.length : data.matchCount;
      statusEl.textContent = `${count} ${count === 1 ? 'match' : 'matches'}${data.truncated ? ' (truncated)' : ''}`;
    }
  },

  _findFileBrowserDirectory(nodes, targetPath, ancestors = []) {
    if (!Array.isArray(nodes)) return null;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'directory' && node.path === targetPath) {
        return { target: node, ancestors: [...ancestors] };
      }
      if (node.type !== 'directory' || !Array.isArray(node.children)) continue;
      const found = this._findFileBrowserDirectory(node.children, targetPath, [...ancestors, node.path]);
      if (found) return found;
    }
    return null;
  },

  _isFileBrowserDirectoryContextCurrent(target) {
    const state = this._ensureFileBrowserState();
    const input = this.$?.('fileBrowserSearch');
    const currentInput = typeof input?.value === 'string' ? input.value : state.filter;
    return (
      target &&
      state.ownerSessionId === target.ownerSessionId &&
      this.activeSessionId === target.ownerSessionId &&
      state.treeEpoch === target.treeEpoch &&
      state.searchEpoch === target.searchEpoch &&
      (this.fileBrowserShowHidden === true) === target.showHidden &&
      state.filter === target.rawInput &&
      currentInput === target.rawInput &&
      currentInput.trim() === target.query &&
      state.view === target.view &&
      this.$?.('fileBrowserPanel')?.classList.contains('visible') === true
    );
  },

  _promptFileBrowserDirectoryReload() {
    this.showToast?.('Reload files before opening this folder', 'info');
  },

  _openFileBrowserSearchDirectory(target) {
    if (!this._isFileBrowserDirectoryContextCurrent(target)) return;
    const state = this._ensureFileBrowserState();
    const normalState = state.normalState;
    if (
      !this._isFileBrowserNormalCompatible(
        normalState,
        target.ownerSessionId,
        target.showHidden,
        target.treeEpoch,
      )
    ) {
      state.deferredDirectoryTarget = null;
      this._promptFileBrowserDirectoryReload();
      return;
    }

    if (normalState.phase === 'loading') {
      state.deferredDirectoryTarget = { ...target };
      return;
    }

    state.deferredDirectoryTarget = null;
    if (normalState.phase !== 'ready') {
      this._promptFileBrowserDirectoryReload();
      return;
    }

    const found = this._findFileBrowserDirectory(normalState.data?.tree, target.path);
    if (!found) {
      this._promptFileBrowserDirectoryReload();
      return;
    }
    this._leaveFileBrowserSearchForDirectory([...found.ancestors, found.target.path], normalState);
  },

  _completeDeferredFileBrowserDirectory(normalState) {
    const state = this._ensureFileBrowserState();
    const target = state.deferredDirectoryTarget;
    if (!target) return false;
    if (!this._isFileBrowserDirectoryContextCurrent(target)) {
      if (state.deferredDirectoryTarget === target) state.deferredDirectoryTarget = null;
      return false;
    }
    if (
      !this._isFileBrowserNormalCompatible(
        normalState,
        target.ownerSessionId,
        target.showHidden,
        target.treeEpoch,
      ) ||
      (normalState.phase !== 'ready' && normalState.phase !== 'error')
    ) {
      return false;
    }

    state.deferredDirectoryTarget = null;
    if (normalState.phase === 'error') {
      this._promptFileBrowserDirectoryReload();
      return false;
    }

    const found = this._findFileBrowserDirectory(normalState.data?.tree, target.path);
    if (!found) {
      this._promptFileBrowserDirectoryReload();
      return false;
    }
    this._leaveFileBrowserSearchForDirectory([...found.ancestors, found.target.path], normalState);
    return true;
  },

  _leaveFileBrowserSearchForDirectory(paths, normalState) {
    const state = this._ensureFileBrowserState();
    if (state.inFlight?.timer !== undefined && state.inFlight?.timer !== null) {
      clearTimeout(state.inFlight.timer);
    }
    state.searchEpoch++;
    state.inFlight = null;
    state.filter = '';
    state.matches = [];
    state.deferredDirectoryTarget = null;
    state.view = 'normal';
    this.fileBrowserFilter = '';

    const input = this.$?.('fileBrowserSearch');
    if (input) input.value = '';
    this._syncFileBrowserExpandBtn();
    for (const path of paths) {
      if (typeof path === 'string') this.fileBrowserExpandedDirs?.add?.(path);
    }
    this.fileBrowserData = normalState.data;
    this._renderFileBrowserNormalState(normalState);
  },

  expandAllDirectories(nodes) {
    for (const node of nodes) {
      if (node.type === 'directory') {
        this.fileBrowserExpandedDirs.add(node.path);
        if (node.children) {
          this.expandAllDirectories(node.children);
        }
      }
    }
  },

  collapseAllDirectories() {
    this.fileBrowserExpandedDirs.clear();
  },

  toggleFileBrowserExpand() {
    if (this._hasFileBrowserQuery()) {
      this._syncFileBrowserExpandBtn();
      return;
    }
    this.fileBrowserAllExpanded = !this.fileBrowserAllExpanded;
    const btn = this.$('fileBrowserExpandBtn');

    if (this.fileBrowserAllExpanded) {
      this.expandAllDirectories(this.fileBrowserData?.tree || []);
      if (btn) btn.innerHTML = '\u229F'; // Collapse icon
    } else {
      this.collapseAllDirectories();
      if (btn) btn.innerHTML = '\u229E'; // Expand icon
    }
    this.renderFileBrowserTree();
  },

  refreshFileBrowser() {
    const state = this._ensureFileBrowserState();
    if (state.inFlight?.timer !== undefined && state.inFlight?.timer !== null) {
      clearTimeout(state.inFlight.timer);
    }
    state.inFlight = null;
    state.searchEpoch++;
    state.filter = '';
    state.matches = [];
    state.deferredDirectoryTarget = null;
    state.view = 'normal';
    this.fileBrowserFilter = '';
    this.fileBrowserExpandedDirs.clear();
    this.fileBrowserAllExpanded = false;
    const expandBtn = this.$('fileBrowserExpandBtn');
    if (expandBtn) expandBtn.innerHTML = '\u229E';
    const searchInput = this.$('fileBrowserSearch');
    if (searchInput) searchInput.value = '';
    this._syncFileBrowserExpandBtn();

    const ownerSessionId = state.ownerSessionId || this.activeSessionId;
    if (!ownerSessionId || this.activeSessionId !== ownerSessionId) return undefined;
    return this.loadFileBrowser(ownerSessionId, { force: true });
  },

  // Header "File Viewer" button (opt-in via App Settings → Header Displays →
  // File Viewer). Toggles the file browser panel open/closed without a trip
  // through settings. Persists via the same `showFileBrowser` flag the Panels
  // section + the panel's own close (X) use, so the three stay in sync.
  toggleFileBrowserButton() {
    const panel = this.$('fileBrowserPanel');
    const isOpen = panel?.classList.contains('visible');
    const btn = document.querySelector('.btn-file-viewer');
    if (isOpen) {
      this.closeFileBrowserPanel();
      if (btn) btn.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!this.activeSessionId) {
      this.showToast('Open a session to browse its files', 'info');
      return;
    }
    const settings = this.loadAppSettingsFromStorage();
    settings.showFileBrowser = true;
    this.saveAppSettingsToStorage(settings);
    const checkbox = document.getElementById('appSettingsShowFileBrowser');
    if (checkbox) checkbox.checked = true;
    this.applyMonitorVisibility();
    if (btn) btn.setAttribute('aria-expanded', 'true');
  },

  closeFileBrowserPanel() {
    const panel = this.$('fileBrowserPanel');
    this._resetFileBrowserForHide();
    if (panel) {
      panel.classList.remove('visible');
      // Reset position so it reopens at default location
      panel.style.left = '';
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.right = '';
    }
    // Clean up drag listeners
    if (this.fileBrowserDragListeners) {
      const dl = this.fileBrowserDragListeners;
      document.removeEventListener('mousemove', dl.move);
      document.removeEventListener('mouseup', dl.up);
      document.removeEventListener('touchmove', dl.touchMove);
      document.removeEventListener('touchend', dl.up);
      document.removeEventListener('touchcancel', dl.up);
      if (dl.handle) {
        dl.handle.removeEventListener('mousedown', dl.handleMouseDown);
        dl.handle.removeEventListener('touchstart', dl.handleTouchStart);
        if (dl._onFirstDrag) {
          dl.handle.removeEventListener('mousedown', dl._onFirstDrag);
          dl.handle.removeEventListener('touchstart', dl._onFirstDrag);
        }
      }
      this.fileBrowserDragListeners = null;
    }
    // Save setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showFileBrowser = false;
    this.saveAppSettingsToStorage(settings);
    const checkbox = document.getElementById('appSettingsShowFileBrowser');
    if (checkbox) checkbox.checked = false;
    const headerBtn = document.querySelector('.btn-file-viewer');
    if (headerBtn) headerBtn.setAttribute('aria-expanded', 'false');
  },

  /**
   * Whether a path is absolute and provably OUTSIDE this session's workspace.
   *
   * `file-content` / `file-raw` resolve every path against `workingDir` and
   * refuse anything that escapes it, so an absolute path elsewhere on the host
   * (an agent's `/tmp` scratchpad capture, a screenshot, another checkout) can
   * only ever 404 there — it has to go through the attachment routes instead.
   *
   * A string compare is enough for ROUTING; the real containment decision stays
   * server-side (realpath + guard) on whichever route the request lands on. An
   * unknown workingDir answers false, leaving the historical path untouched.
   */
  _isExternalPreviewPath(filePath, sessionId) {
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) return false;
    const workingDir = this.sessions.get(sessionId)?.workingDir;
    if (!workingDir) return false;
    const root = workingDir.endsWith('/') ? workingDir : `${workingDir}/`;
    return filePath !== workingDir && !filePath.startsWith(root);
  },

  /**
   * Register an out-of-workspace path as a live external attachment and return
   * its id, so the preview can render it through the by-id attachment routes.
   *
   * `notify: false` keeps this quiet: the caller is already opening the file in
   * the overlay, so the usual attachment card + unread badge would be noise on
   * top of the thing the user just asked to see. The server still enforces the
   * full attachment guard (blocked secret trees, extension allowlist, symlinks
   * resolved), so a refusal here is a policy answer worth showing verbatim.
   *
   * @returns {Promise<{attachmentId?: string, size?: number, error?: string}>}
   */
  async _registerExternalPreview(filePath, sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, notify: false }),
      });
      const result = await res.json().catch(() => null);
      if (res.ok && result?.success && result.data?.attachmentId) {
        return { attachmentId: result.data.attachmentId, size: result.data.size || 0 };
      }
      const reason = result?.error || `Cannot open this file (HTTP ${res.status})`;
      // The registry's type answer is a policy term, not an explanation, and the
      // user just clicked a file they can see on disk. Say what IS previewable
      // from outside the workspace instead.
      if (/unsupported/i.test(reason)) {
        const ext = (filePath.split('.').pop() || '').toLowerCase();
        return {
          error: `Cannot preview .${ext} from outside the session workspace (images, video, audio, PDF, Office documents and text files only).`,
        };
      }
      return { error: reason };
    } catch (err) {
      return { error: err.message || 'Cannot open this file' };
    }
  },

  async openFilePreview(filePath, sessionId = this.activeSessionId, attachmentId = null) {
    if (!sessionId || !filePath) return;

    const overlay = this.$('filePreviewOverlay');
    const titleEl = this.$('filePreviewTitle');
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');

    if (!overlay || !bodyEl) return;

    // Edit mode: reset any prior editor state whenever a preview (re)loads.
    this._resetFilePreviewEdit();
    // Stop whatever the previous preview was playing. Overwriting innerHTML
    // only DETACHES a <video>/<audio>; a detached media element keeps playing.
    this._stopFilePreviewMedia();
    // Disarm detach until this load has a URL of its own: an early error return
    // must not leave the button opening the PREVIOUS file in a new tab.
    this.filePreviewDetachUrl = '';
    const detachBtn = this.$('filePreviewDetachBtn');
    if (detachBtn) detachBtn.hidden = true;

    // Show overlay with loading state
    overlay.classList.add('visible');
    titleEl.textContent = filePath;
    bodyEl.innerHTML = '<div class="binary-message">Loading...</div>';
    footerEl.textContent = '';

    const ext = (filePath.split('.').pop() || '').toLowerCase();

    // Out-of-workspace path: mint an attachment id up front. Every branch below
    // talks to a workspace-confined route, so without this the image/PDF ones
    // render a broken frame and the text one reports a bare "File not found"
    // for a file that is sitting right there on disk.
    let externalError = '';
    let externalSize = 0;
    if (!attachmentId && this._isExternalPreviewPath(filePath, sessionId)) {
      const external = await this._registerExternalPreview(filePath, sessionId);
      attachmentId = external.attachmentId || null;
      externalError = external.error || '';
      externalSize = external.size || 0;
    }
    if (!attachmentId && externalError) {
      footerEl.textContent = '';
      bodyEl.innerHTML = `<div class="binary-message">${escapeHtml(externalError)}</div>`;
      return;
    }

    // Every branch below renders from one of these routes, so the detach button
    // can always offer the same bytes in a browser tab: docx/pptx through the
    // server-converted PDF preview, everything else through the raw route.
    // (html/htm arrive as a download there by design — file-raw serves them
    // attachment-only so widening READ never widens RUN.)
    const officeDoc = ext === 'docx' || ext === 'pptx';
    this.filePreviewDetachUrl = attachmentId
      ? `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}/${officeDoc ? 'preview' : 'raw'}`
      : officeDoc
        ? `/api/sessions/${sessionId}/file-preview?path=${encodeURIComponent(filePath)}`
        : `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(filePath)}`;
    if (detachBtn) detachBtn.hidden = false;

    // Registered attachment: render straight from its by-id routes — images and
    // PDFs inline, Office docs via the server-converted PDF preview, text fetched
    // raw. (Workspace-path previews fall through to the file-content endpoint.)
    if (attachmentId) {
      const base = `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}`;
      const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
      // VIDEO/AUDIO mirror VIDEO_ATTACHMENT_EXTENSIONS/AUDIO_ATTACHMENT_EXTENSIONS
      // (src/attachment-registry.ts, the single source); the frontend cannot import
      // it, so test/media-extension-parity.test.ts pins the copies equal.
      const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
      const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus']);
      // Size when we just registered the file ourselves, so a path opened from a
      // link reads like a workspace preview instead of a bare "PNG". History
      // cards arrive with an id and no size and keep the short form.
      footerEl.textContent = externalSize ? `${this.formatFileSize(externalSize)} • ${ext}` : ext.toUpperCase();
      if (IMAGE_EXTS.has(ext)) {
        bodyEl.innerHTML = `<img src="${escapeHtml(`${base}/raw`)}" alt="${escapeHtml(filePath)}">`;
      } else if (VIDEO_EXTS.has(ext)) {
        // Same markup as the workspace branch below, including playsinline: iOS
        // otherwise hijacks playback into its own fullscreen player, which
        // leaves this overlay behind it with no way back but its close button.
        // The attachment raw route is range-aware, so the scrub bar works.
        bodyEl.innerHTML = `<video src="${escapeHtml(`${base}/raw`)}" controls autoplay playsinline preload="metadata"></video>`;
      } else if (AUDIO_EXTS.has(ext)) {
        bodyEl.innerHTML = `<audio src="${escapeHtml(`${base}/raw`)}" controls autoplay preload="metadata"></audio>`;
      } else if (ext === 'pdf') {
        bodyEl.innerHTML = `<iframe src="${escapeHtml(`${base}/raw`)}" title="${escapeHtml(filePath)}"></iframe>`;
      } else if (ext === 'docx' || ext === 'pptx') {
        bodyEl.innerHTML = `<iframe src="${escapeHtml(`${base}/preview`)}" title="${escapeHtml(filePath)}"></iframe>`;
      } else {
        try {
          // Bounded like the workspace text preview: a Range for the first
          // chunk (the route is range-aware, so this is a real partial read,
          // not a 50MB download thrown away) and a line cap on top. An agent's
          // log can be enormous, and rendering all of it into one <pre> is how
          // you lock up the tab on the file you wanted to glance at.
          const res = await fetch(`${base}/raw`, { headers: { Range: `bytes=0-${TEXT_PREVIEW_MAX_BYTES - 1}` } });
          if (!res.ok) throw new Error('Failed to load attachment');
          const text = await res.text();
          const clippedByBytes = res.status === 206 && text.length >= TEXT_PREVIEW_MAX_BYTES;
          const lines = text.split('\n');
          const clippedByLines = lines.length > TEXT_PREVIEW_MAX_LINES;
          const shown = clippedByLines ? lines.slice(0, TEXT_PREVIEW_MAX_LINES).join('\n') : text;
          bodyEl.innerHTML = `<pre><code>${escapeHtml(shown)}</code></pre>`;
          this.filePreviewContent = shown;
          if (clippedByLines || clippedByBytes) {
            const note = clippedByLines ? `showing first ${TEXT_PREVIEW_MAX_LINES} lines` : 'showing the start of the file';
            footerEl.textContent = `${footerEl.textContent} (${note})`;
          }
        } catch (err) {
          bodyEl.innerHTML = `<div class="binary-message">Error: ${escapeHtml(err.message)}</div>`;
        }
      }
      return;
    }

    // Workspace-path (auto-detected, unregistered) attachments: Office docs are
    // converted to PDF server-side via the file-preview route; PDFs stream raw.
    // Both render inline in an iframe. Without this, docx/pptx/pdf fall through
    // to file-content below, which would dump the binary bytes as mojibake.
    if (ext === 'docx' || ext === 'pptx') {
      footerEl.textContent = ext.toUpperCase();
      const previewSrc = `/api/sessions/${sessionId}/file-preview?path=${encodeURIComponent(filePath)}`;
      bodyEl.innerHTML = `<iframe src="${escapeHtml(previewSrc)}" title="${escapeHtml(filePath)}"></iframe>`;
      return;
    }
    if (ext === 'pdf') {
      footerEl.textContent = 'PDF';
      const rawSrc = `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(filePath)}`;
      bodyEl.innerHTML = `<iframe src="${escapeHtml(rawSrc)}" title="${escapeHtml(filePath)}"></iframe>`;
      return;
    }
    // SVG renders as an image, but file-raw deliberately serves SVG as an
    // untrusted octet-stream attachment (XSS hardening), so a direct
    // <img src=file-raw> would break. Fetch the bytes and render via a
    // same-origin blob typed image/svg+xml — <img> never executes scripts in
    // the referenced SVG, so this is safe while still rendering the graphic.
    if (ext === 'svg') {
      footerEl.textContent = 'SVG';
      try {
        const res = await fetch(`/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) throw new Error('Failed to load image');
        const blobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'image/svg+xml' }));
        bodyEl.innerHTML = `<img src="${blobUrl}" alt="${escapeHtml(filePath)}">`;
        const img = bodyEl.querySelector('img');
        if (img) img.onload = () => URL.revokeObjectURL(blobUrl);
      } catch (err) {
        bodyEl.innerHTML = `<div class="binary-message">Error: ${escapeHtml(err.message)}</div>`;
      }
      return;
    }

    try {
      const res = await fetch(`/api/sessions/${sessionId}/file-content?path=${encodeURIComponent(filePath)}&lines=500`);
      if (!res.ok) throw new Error('Failed to load file');

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load file');

      const data = result.data;

      if (data.type === 'image') {
        bodyEl.innerHTML = `<img src="${data.url}" alt="${escapeHtml(filePath)}">`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'video') {
        // playsinline: iOS otherwise hijacks playback into its fullscreen
        // player, which leaves the overlay behind it and its own close button
        // as the only way back.
        bodyEl.innerHTML = `<video src="${escapeHtml(data.url)}" controls autoplay playsinline preload="metadata"></video>`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'audio') {
        bodyEl.innerHTML = `<audio src="${escapeHtml(data.url)}" controls autoplay preload="metadata"></audio>`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'binary') {
        const downloadHref = `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(filePath)}&download=true`;
        bodyEl.innerHTML = `<div class="binary-message">Binary file (${this.formatFileSize(data.size)})<br>Cannot preview<br><a href="${escapeHtml(downloadHref)}" download>Download</a></div>`;
        footerEl.textContent = data.extension || 'binary';
      } else {
        // Text content
        this.filePreviewContent = data.content;
        bodyEl.innerHTML = `<pre><code>${escapeHtml(data.content)}</code></pre>`;
        const truncNote = data.truncated ? ` (showing 500/${data.totalLines} lines)` : '';
        footerEl.textContent = `${data.totalLines} lines \u2022 ${this.formatFileSize(data.size)}${truncNote}`;
        // Edit affordance only when the server says an edit=1 re-fetch would
        // succeed (workspace text file inside the allowlist and size cap).
        if (data.editable) {
          this.filePreviewEditTarget = { sessionId, filePath };
          const editBtn = this.$('filePreviewEditBtn');
          if (editBtn) editBtn.hidden = false;
        }
      }
    } catch (err) {
      console.error('Failed to preview file:', err);
      bodyEl.innerHTML = `<div class="binary-message">Error: ${escapeHtml(err.message)}</div>`;
    }
  },

  closeFilePreview() {
    if (this.filePreviewEdit?.dirty && !confirm('Discard unsaved changes?')) return;
    this._resetFilePreviewEdit();
    const overlay = this.$('filePreviewOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
    // The overlay is hidden with display:none, which stops it being PAINTED and
    // nothing else: a <video>/<audio> inside it keeps playing, keeps its audio
    // audible and keeps streaming from the server. Closing has to stop it.
    this._stopFilePreviewMedia();
    this.filePreviewContent = '';
    this.filePreviewDetachUrl = '';
    const detachBtn = this.$('filePreviewDetachBtn');
    if (detachBtn) detachBtn.hidden = true;
  },

  /**
   * Open the previewed file in a browser tab and close the overlay.
   *
   * window.open is called WITHOUT the 'noopener' feature string: with it the
   * call returns null even on success, which would make a blocked pop-up
   * indistinguishable from a working one. The opener link is severed by hand
   * instead, and a null return then reliably means the browser blocked it, in
   * which case the overlay stays up so the user has not lost the file.
   */
  detachFilePreview() {
    if (!this.filePreviewDetachUrl) return;
    const win = window.open(this.filePreviewDetachUrl, '_blank');
    if (!win) {
      this.showToast('Pop-up blocked: allow pop-ups for this site to detach previews', 'error');
      return;
    }
    win.opener = null;
    this.closeFilePreview();
  },

  /**
   * Pause and unload every media element in the preview body, then empty it.
   *
   * Removing the element from the DOM is NOT enough — a detached HTMLMediaElement
   * plays on until it is garbage collected, which is why the X button used to
   * leave a video audible. pause() stops playback, dropping src + load() aborts
   * the in-flight network fetch and puts the element back in NETWORK_EMPTY.
   */
  _stopFilePreviewMedia() {
    const bodyEl = this.$('filePreviewBody');
    if (!bodyEl) return;
    for (const media of bodyEl.querySelectorAll('video, audio')) {
      try {
        media.pause();
        media.removeAttribute('src');
        media.load();
      } catch (err) {
        console.warn('Failed to stop preview media:', err);
      }
    }
    bodyEl.innerHTML = '';
  },

  // ═══════════════════════════════════════════════════════════════
  // File Viewer edit mode (issue #212 — docs/file-viewer-edit-plan.md)
  // ═══════════════════════════════════════════════════════════════

  _resetFilePreviewEdit() {
    this.filePreviewEdit = null;
    this.filePreviewEditTarget = null;
    const editBtn = this.$('filePreviewEditBtn');
    if (editBtn) editBtn.hidden = true;
    const editBar = this.$('filePreviewEditBar');
    if (editBar) editBar.hidden = true;
    const dirtyEl = this.$('filePreviewDirty');
    if (dirtyEl) dirtyEl.hidden = true;
    const saveBtn = this.$('filePreviewSaveBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Save';
    }
  },

  async enterFilePreviewEdit() {
    const target = this.filePreviewEditTarget;
    if (!target || this.filePreviewEdit) return;
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');
    if (!bodyEl) return;

    // Always re-fetch with edit=1: the preview buffer may be line-truncated and
    // a truncated buffer must never become an edit buffer. Parse the envelope
    // even on non-ok responses so the specific refusal ("too large to edit
    // here") reaches the toast instead of a generic failure.
    let data;
    try {
      const res = await fetch(
        `/api/sessions/${target.sessionId}/file-content?path=${encodeURIComponent(target.filePath)}&edit=1`
      );
      const result = await res.json().catch(() => null);
      if (!result || result.success !== true) {
        throw new Error(result?.error || `Failed to load file for editing (HTTP ${res.status})`);
      }
      data = result.data;
    } catch (err) {
      this.showToast(err.message, 'error');
      return;
    }

    this.filePreviewEdit = {
      sessionId: target.sessionId,
      filePath: target.filePath,
      baseHash: data.hash,
      eol: data.eol,
      original: data.content,
      dirty: false,
      saving: false,
    };

    const textarea = document.createElement('textarea');
    textarea.className = 'file-preview-editor';
    textarea.spellcheck = false;
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocomplete', 'off');
    textarea.wrap = 'off';
    textarea.value = data.content;
    textarea.addEventListener('input', () => this._onFilePreviewEditInput());
    bodyEl.innerHTML = '';
    bodyEl.appendChild(textarea);
    // Deliberately no autofocus: on phones that would pop the OS keyboard
    // before the user has scrolled to the line they want to change.

    const editBtn = this.$('filePreviewEditBtn');
    if (editBtn) editBtn.hidden = true;
    const editBar = this.$('filePreviewEditBar');
    if (editBar) editBar.hidden = false;
    if (footerEl) {
      const eolNote = data.eol === 'crlf' ? ' • CRLF' : '';
      footerEl.textContent = `Editing • ${data.totalLines} lines • ${this.formatFileSize(data.size)}${eolNote}`;
    }
  },

  _onFilePreviewEditInput() {
    const edit = this.filePreviewEdit;
    if (!edit) return;
    const textarea = this.$('filePreviewBody')?.querySelector('textarea.file-preview-editor');
    if (!textarea) return;
    edit.dirty = textarea.value !== edit.original;
    const dirtyEl = this.$('filePreviewDirty');
    if (dirtyEl) dirtyEl.hidden = !edit.dirty;
    const saveBtn = this.$('filePreviewSaveBtn');
    if (saveBtn) saveBtn.disabled = !edit.dirty || edit.saving;
  },

  cancelFilePreviewEdit() {
    const edit = this.filePreviewEdit;
    if (!edit) return;
    if (edit.dirty && !confirm('Discard unsaved changes?')) return;
    const { sessionId, filePath } = edit;
    this._resetFilePreviewEdit();
    this.openFilePreview(filePath, sessionId);
  },

  async saveFilePreviewEdit(force = false) {
    const edit = this.filePreviewEdit;
    if (!edit || edit.saving) return;
    const textarea = this.$('filePreviewBody')?.querySelector('textarea.file-preview-editor');
    if (!textarea) return;

    edit.saving = true;
    const saveBtn = this.$('filePreviewSaveBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
    }
    const restoreSaveState = () => {
      edit.saving = false;
      if (saveBtn) saveBtn.textContent = 'Save';
      this._onFilePreviewEditInput();
    };

    let result = null;
    let status = 0;
    try {
      const res = await fetch(`/api/sessions/${edit.sessionId}/file-content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: edit.filePath,
          content: textarea.value,
          baseHash: edit.baseHash,
          eol: edit.eol ?? undefined, // Zod .optional() rejects null
          force: force || undefined,
        }),
      });
      status = res.status;
      result = await res.json().catch(() => null);
    } catch (err) {
      restoreSaveState();
      this.showToast(`Save failed: ${err.message}`, 'error');
      return;
    }

    if (status === 409 || result?.errorCode === 'CONFLICT') {
      restoreSaveState();
      if (
        confirm(
          'File changed on disk since you loaded it.\nOK overwrites it with your version; Cancel keeps your draft open.'
        )
      ) {
        this.saveFilePreviewEdit(true);
      }
      return;
    }
    if (!result || result.success !== true) {
      restoreSaveState();
      this.showToast(`Save failed: ${result?.error || `HTTP ${status}`}`, 'error');
      return;
    }

    const { sessionId, filePath } = edit;
    this._resetFilePreviewEdit();
    this.showToast('Saved', 'success');
    // Re-open in read mode — re-fetching shows the truth on disk (including the
    // server-side EOL normalization) rather than trusting the local buffer.
    this.openFilePreview(filePath, sessionId);
  },

  // ═══════════════════════════════════════════════════════════════
  // Attachment Cards (detected documents/images)
  // ═══════════════════════════════════════════════════════════════

  // SSE `attachment:detected` consumer: surface a dismissible card for the file
  // and bump the per-session history unread count (refreshing the open drawer).
  _onAttachmentDetected(data) {
    console.log('[Attachment Detected]', data);
    this.addAttachmentCard(data);
    if (data.sessionId) {
      const current =
        this.attachmentHistoryCounts.get(data.sessionId) ??
        this.sessions.get(data.sessionId)?.attachmentHistory?.length ??
        0;
      this.attachmentHistoryCounts.set(data.sessionId, Math.min(current + 1, 100));
      if (data.sessionId === this.activeSessionId) {
        this.updateAttachmentHistoryBadge();
        if (this.attachmentHistoryDrawerOpen) {
          this._debouncedCall(
            'attachmentHistoryRefresh',
            () => {
              // The drawer may have closed or the active session changed during
              // the debounce window — don't refresh for a stale session.
              if (this.attachmentHistoryDrawerOpen && this.activeSessionId === data.sessionId) {
                this.loadAttachmentHistory(data.sessionId);
              }
            },
            250
          );
        }
      }
    }
  },

  // Lazily create the floating stack the cards live in (appended to <body>).
  ensureAttachmentCardStack() {
    let stack = this.attachmentCardStack || document.getElementById('attachmentCardStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'attachmentCardStack';
      stack.className = 'attachment-card-stack';
      document.body.appendChild(stack);
    }
    this.attachmentCardStack = stack;
    return stack;
  },

  openAttachmentInNewTab(sessionId, filePath, attachmentId = null) {
    const url = attachmentId
      ? `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}/raw`
      : `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(filePath)}`;
    window.open(url, '_blank');
  },

  addAttachmentCard(attachmentEvent) {
    const {
      sessionId,
      relativePath,
      fileName,
      timestamp,
      size,
      attachmentType,
      extension,
      attachmentId,
      rawUrl,
      previewUrl,
      thumbnailUrl,
    } = attachmentEvent;
    const filePath = relativePath || fileName;
    const cardId = attachmentId || `${sessionId}-${timestamp}-${fileName}`;

    if (this.attachmentCards.has(cardId)) {
      const existing = this.attachmentCards.get(cardId);
      existing.element.focus?.();
      return;
    }

    const MAX_ATTACHMENT_CARDS = 10;
    if (this.attachmentCards.size >= MAX_ATTACHMENT_CARDS) {
      const oldestId = this.attachmentCards.keys().next().value;
      if (oldestId) this.closeAttachmentCard(oldestId);
    }

    const stack = this.ensureAttachmentCardStack();
    const session = this.sessions.get(sessionId);
    const sessionName = session?.name || sessionId.substring(0, 8);
    const attachmentRawUrl =
      rawUrl ||
      (attachmentId
        ? `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}/raw`
        : `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(filePath)}`);
    const attachmentPreviewUrl =
      previewUrl ||
      (attachmentId ? `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}/preview` : null);
    const attachmentThumbnailUrl =
      thumbnailUrl ||
      (attachmentId
        ? `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}/thumbnail`
        : `/api/sessions/${sessionId}/file-thumbnail?path=${encodeURIComponent(filePath)}`);
    const downloadUrl = attachmentId ? `${attachmentRawUrl}?download=true` : `${attachmentRawUrl}&download=true`;
    const typeLabel = (extension || attachmentType || 'file').toUpperCase();

    const card = document.createElement('article');
    card.className = `attachment-card attachment-${escapeHtml(attachmentType || 'file')}`;
    card.tabIndex = 0;
    card.dataset.attachmentId = cardId;
    card.dataset.previewUrl = attachmentPreviewUrl || '';
    card.innerHTML = `
      <div class="attachment-thumbnail">
        ${attachmentThumbnailUrl ? `<img class="attachment-thumbnail-img" src="${escapeHtml(attachmentThumbnailUrl)}" alt="">` : ''}
        <div class="attachment-thumbnail-fallback ${attachmentThumbnailUrl ? '' : 'visible'}">${escapeHtml(typeLabel)}</div>
      </div>
      <div class="attachment-card-main">
        <div class="attachment-file-name" title="${escapeHtml(filePath)}">${escapeHtml(fileName)}</div>
        <div class="attachment-file-meta">
          <span>${escapeHtml(sessionName)}</span>
          <span>${this.formatFileSize(size || 0)}</span>
        </div>
        <div class="attachment-actions">
          <button type="button" class="attachment-preview-btn">Preview</button>
          <a href="${escapeHtml(downloadUrl)}">Download</a>
          <button type="button" class="attachment-open-btn">Open</button>
        </div>
      </div>
      <button type="button" class="attachment-close-btn" title="Dismiss">&times;</button>
    `;

    const attachmentThumbnailImg = card.querySelector('.attachment-thumbnail-img');
    if (attachmentThumbnailImg) {
      attachmentThumbnailImg.onerror = () => {
        attachmentThumbnailImg.remove();
        card.querySelector('.attachment-thumbnail-fallback')?.classList.add('visible');
      };
    }

    card.querySelector('.attachment-preview-btn')?.addEventListener('click', () => {
      this.openFilePreview(filePath, sessionId, attachmentId || null);
    });
    card.querySelector('.attachment-open-btn')?.addEventListener('click', () => {
      this.openAttachmentInNewTab(sessionId, filePath, attachmentId || null);
    });
    card.querySelector('.attachment-close-btn')?.addEventListener('click', () => {
      this.closeAttachmentCard(cardId);
    });

    stack.prepend(card);
    this.attachmentCards.set(cardId, { element: card, sessionId, filePath });
    this._refreshAttachmentClearAll();
  },

  // Centralized show/hide for the stack's "Clear all" control. Both addAttachmentCard and
  // closeAttachmentCard call this so the control appears on the 2nd card and hides at <=1.
  _refreshAttachmentClearAll() {
    const stack = this.attachmentCardStack;
    if (!stack) return;
    let control = stack.querySelector('.attachment-clear-all');
    if (this.attachmentCards.size < 2) {
      if (control) control.hidden = true;
      return;
    }
    if (!control) {
      control = document.createElement('button');
      control.type = 'button';
      control.className = 'attachment-clear-all';
      control.textContent = 'Clear all';
      control.title = 'Dismiss all attachment cards';
      control.addEventListener('click', () => this.closeAllAttachmentCards());
      stack.prepend(control);
    }
    control.hidden = false;
  },

  closeAttachmentCard(attachmentId) {
    const cardData = this.attachmentCards.get(attachmentId);
    if (!cardData) return;
    cardData.element.remove();
    this.attachmentCards.delete(attachmentId);
    if (this.attachmentCardStack && this.attachmentCards.size === 0) {
      this.attachmentCardStack.remove();
      this.attachmentCardStack = null;
    } else {
      this._refreshAttachmentClearAll();
    }
  },

  closeAllAttachmentCards() {
    for (const attachmentId of [...this.attachmentCards.keys()]) {
      this.closeAttachmentCard(attachmentId);
    }
  },

  closeSessionAttachmentCards(sessionId) {
    const toClose = [];
    for (const [attachmentId, data] of this.attachmentCards) {
      if (data.sessionId === sessionId) toClose.push(attachmentId);
    }
    for (const attachmentId of toClose) {
      this.closeAttachmentCard(attachmentId);
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Attachment History Drawer
  // ═══════════════════════════════════════════════════════════════

  updateAttachmentHistoryBadge(count = null) {
    const badge = document.getElementById('attachmentHistoryBadge');
    const button = document.getElementById('attachmentsHistoryBtn');
    const sessionId = this.activeSessionId;
    const nextCount = count ?? (sessionId ? this.attachmentHistoryCounts.get(sessionId) || 0 : 0);
    if (badge) {
      badge.textContent = nextCount > 99 ? '99+' : String(nextCount);
      badge.style.display = nextCount > 0 ? '' : 'none';
    }
    if (button) {
      button.classList.toggle('active', this.attachmentHistoryDrawerOpen);
      button.setAttribute('aria-expanded', this.attachmentHistoryDrawerOpen ? 'true' : 'false');
    }
  },

  ensureAttachmentHistoryDrawer() {
    let drawer = document.getElementById('attachmentHistoryDrawer');
    if (drawer) return drawer;

    drawer = document.createElement('aside');
    drawer.id = 'attachmentHistoryDrawer';
    drawer.className = 'attachment-history-drawer';
    drawer.setAttribute('aria-label', 'Attachment history');
    drawer.innerHTML = `
      <div class="attachment-history-header">
        <div>
          <div class="attachment-history-title">Attachments</div>
          <div class="attachment-history-subtitle" id="attachmentHistorySubtitle">0 files</div>
        </div>
        <div class="attachment-history-header-actions">
          <button type="button" class="btn-icon-sm" id="attachmentHistoryRefreshBtn" title="Refresh" aria-label="Refresh attachments">&#x21BB;</button>
          <button type="button" class="btn-icon-sm" id="attachmentHistoryCloseBtn" title="Close" aria-label="Close attachments">&times;</button>
        </div>
      </div>
      <div class="attachment-history-list" id="attachmentHistoryList"></div>
    `;
    document.body.appendChild(drawer);
    drawer.querySelector('#attachmentHistoryRefreshBtn')?.addEventListener('click', () => {
      this.loadAttachmentHistory(this.activeSessionId);
    });
    drawer.querySelector('#attachmentHistoryCloseBtn')?.addEventListener('click', () => {
      this.closeAttachmentHistory();
    });
    return drawer;
  },

  async toggleAttachmentHistory() {
    if (this.attachmentHistoryDrawerOpen) {
      this.closeAttachmentHistory();
      return;
    }
    await this.openAttachmentHistory();
  },

  async openAttachmentHistory() {
    const drawer = this.ensureAttachmentHistoryDrawer();
    this.attachmentHistoryDrawerOpen = true;
    drawer.classList.add('open');
    this.updateAttachmentHistoryBadge();
    await this.loadAttachmentHistory(this.activeSessionId);
  },

  closeAttachmentHistory() {
    const drawer = document.getElementById('attachmentHistoryDrawer');
    this.attachmentHistoryDrawerOpen = false;
    drawer?.classList.remove('open');
    // Cancel any pending debounced refresh so it can't fire against a closed drawer.
    if (this._debounceTimers?.attachmentHistoryRefresh) {
      clearTimeout(this._debounceTimers.attachmentHistoryRefresh);
      this._debounceTimers.attachmentHistoryRefresh = null;
    }
    this.updateAttachmentHistoryBadge();
  },

  async loadAttachmentHistory(sessionId = this.activeSessionId) {
    const drawer = this.ensureAttachmentHistoryDrawer();
    const list = drawer.querySelector('#attachmentHistoryList');
    const subtitle = drawer.querySelector('#attachmentHistorySubtitle');
    if (!list || !subtitle) return;

    if (!sessionId) {
      this.attachmentHistoryItems = [];
      subtitle.textContent = 'No session';
      list.innerHTML = '<div class="attachment-history-empty">No active session</div>';
      this.updateAttachmentHistoryBadge(0);
      return;
    }

    list.innerHTML = '<div class="attachment-history-empty">Loading...</div>';
    try {
      const res = await fetch(`/api/sessions/${sessionId}/attachments`);
      if (!res.ok) throw new Error('Failed to load attachments');
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load attachments');
      const items = result.data?.items || [];
      this.attachmentHistoryItems = items;
      this.attachmentHistoryCounts.set(sessionId, items.length);
      this.updateAttachmentHistoryBadge(items.length);
      this.renderAttachmentHistory(items);
    } catch (err) {
      console.error('Failed to load attachment history:', err);
      subtitle.textContent = 'Unavailable';
      list.innerHTML = `<div class="attachment-history-empty">Error: ${escapeHtml(err.message)}</div>`;
    }
  },

  renderAttachmentHistory(items = this.attachmentHistoryItems || []) {
    const drawer = this.ensureAttachmentHistoryDrawer();
    const list = drawer.querySelector('#attachmentHistoryList');
    const subtitle = drawer.querySelector('#attachmentHistorySubtitle');
    if (!list || !subtitle) return;

    subtitle.textContent = `${items.length} ${items.length === 1 ? 'file' : 'files'}`;
    if (items.length === 0) {
      list.innerHTML = `
        <div class="attachment-history-empty">
          <div class="attachment-history-empty-title">No attachments yet</div>
          <div>Show a file here by running:</div>
          <code>codeman attach /absolute/path/to/file.pptx</code>
          <div>Supports .pptx, .docx, .pdf, .png, .md, and .txt.</div>
        </div>
      `;
      return;
    }

    list.innerHTML = items.map((item) => this.renderAttachmentHistoryItem(item)).join('');
    list.querySelectorAll('.attachment-history-thumb-img').forEach((img) => {
      img.onerror = () => {
        img.remove();
        const fallback = img.closest('.attachment-history-thumb')?.querySelector('.attachment-history-thumb-fallback');
        fallback?.classList.add('visible');
      };
    });
    list.querySelectorAll('[data-attachment-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-history-id');
        const action = button.getAttribute('data-attachment-action');
        if (!id || !action) return;
        if (action === 'preview') this.previewAttachmentHistoryItem(id);
        if (action === 'download') this.downloadAttachmentHistoryItem(id);
        if (action === 'open') this.openAttachmentHistoryItem(id);
        if (action === 'reshow') this.reshowAttachmentCard(id);
      });
    });
  },

  renderAttachmentHistoryItem(item) {
    const typeLabel = (item.extension || item.attachmentType || 'file').toUpperCase();
    const meta = [
      item.source === 'external' ? 'published' : 'workspace',
      this.formatFileSize(item.size || 0),
      item.missing ? 'missing' : '',
    ]
      .filter(Boolean)
      .join(' • ');
    const thumb =
      item.thumbnailUrl && !item.missing
        ? `<img class="attachment-history-thumb-img" src="${escapeHtml(item.thumbnailUrl)}" alt="">`
        : '';
    const disabled = item.missing ? 'disabled aria-disabled="true"' : '';
    return `
      <div class="attachment-history-item ${item.missing ? 'missing' : ''}" data-history-item="${escapeHtml(item.id)}">
        <div class="attachment-history-thumb">
          ${thumb}
          <div class="attachment-history-thumb-fallback ${thumb ? '' : 'visible'}">${escapeHtml(typeLabel)}</div>
        </div>
        <div class="attachment-history-item-main">
          <div class="attachment-history-file-name" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</div>
          <div class="attachment-history-meta">${escapeHtml(meta)}</div>
          <div class="attachment-history-actions">
            <button type="button" data-attachment-action="preview" data-history-id="${escapeHtml(item.id)}" ${disabled}>Preview</button>
            <button type="button" data-attachment-action="download" data-history-id="${escapeHtml(item.id)}" ${disabled}>Download</button>
            <button type="button" data-attachment-action="open" data-history-id="${escapeHtml(item.id)}" ${disabled}>Open</button>
            <button type="button" data-attachment-action="reshow" data-history-id="${escapeHtml(item.id)}" ${disabled}>Card</button>
          </div>
        </div>
      </div>
    `;
  },

  getAttachmentHistoryItem(itemId) {
    return (this.attachmentHistoryItems || []).find((item) => item.id === itemId) || null;
  },

  previewAttachmentHistoryItem(itemId) {
    const item = this.getAttachmentHistoryItem(itemId);
    if (!item || item.missing) return;
    const path = item.relativePath || item.fileName;
    this.openFilePreview(path, item.sessionId, item.attachmentId || null);
    // Close the drawer so the preview window is unobstructed.
    this.closeAttachmentHistory();
  },

  openAttachmentHistoryItem(itemId) {
    const item = this.getAttachmentHistoryItem(itemId);
    if (!item || item.missing) return;
    if (item.rawUrl || item.url) {
      window.open(item.rawUrl || item.url, '_blank');
      return;
    }
    this.openAttachmentInNewTab(item.sessionId, item.relativePath || item.fileName, item.attachmentId || null);
  },

  downloadAttachmentHistoryItem(itemId) {
    const item = this.getAttachmentHistoryItem(itemId);
    if (!item || item.missing || !item.downloadUrl) return;
    window.open(item.downloadUrl, '_blank');
  },

  reshowAttachmentCard(itemId) {
    const item = this.getAttachmentHistoryItem(itemId);
    if (!item || item.missing) return;
    this.addAttachmentCard({
      sessionId: item.sessionId,
      relativePath: item.relativePath,
      fileName: item.fileName,
      // Use the item's own timestamp (not Date.now()) so the derived cardId is
      // stable across clicks — re-showing focuses the existing card instead of
      // stacking a duplicate.
      timestamp: item.timestamp ?? Date.now(),
      size: item.size,
      attachmentType: item.attachmentType,
      extension: item.extension,
      attachmentId: item.attachmentId,
      rawUrl: item.rawUrl,
      previewUrl: item.previewUrl,
      thumbnailUrl: item.thumbnailUrl,
    });
  },

  copyFilePreviewContent() {
    // While editing, copy the live editor buffer (not the stale preview text).
    const editTextarea = this.filePreviewEdit
      ? this.$('filePreviewBody')?.querySelector('textarea.file-preview-editor')
      : null;
    const content = editTextarea ? editTextarea.value : this.filePreviewContent;
    if (content) {
      navigator.clipboard.writeText(content).then(() => {
        this.showToast('Copied to clipboard', 'success');
      }).catch(() => {
        this.showToast('Failed to copy', 'error');
      });
    } else {
      // Media/PDF/binary previews have no text buffer. Saying so beats the
      // dead-button silence this used to be.
      this.showToast('Nothing to copy in this preview', 'info');
    }
  },

  getFileIcon(ext) {
    if (!ext) return '\uD83D\uDCC4'; // Default file

    const icons = {
      // TypeScript/JavaScript
      'ts': '\uD83D\uDCD8', 'tsx': '\uD83D\uDCD8', 'js': '\uD83D\uDCD2', 'jsx': '\uD83D\uDCD2',
      'mjs': '\uD83D\uDCD2', 'cjs': '\uD83D\uDCD2',
      // Python
      'py': '\uD83D\uDC0D', 'pyx': '\uD83D\uDC0D', 'pyw': '\uD83D\uDC0D',
      // Rust/Go/C
      'rs': '\uD83E\uDD80', 'go': '\uD83D\uDC39', 'c': '\u2699\uFE0F', 'cpp': '\u2699\uFE0F',
      'h': '\u2699\uFE0F', 'hpp': '\u2699\uFE0F',
      // Web
      'html': '\uD83C\uDF10', 'htm': '\uD83C\uDF10', 'css': '\uD83C\uDFA8', 'scss': '\uD83C\uDFA8',
      'sass': '\uD83C\uDFA8', 'less': '\uD83C\uDFA8',
      // Data
      'json': '\uD83D\uDCCB', 'yaml': '\uD83D\uDCCB', 'yml': '\uD83D\uDCCB', 'xml': '\uD83D\uDCCB',
      'toml': '\uD83D\uDCCB', 'csv': '\uD83D\uDCCB',
      // Docs
      'md': '\uD83D\uDCDD', 'markdown': '\uD83D\uDCDD', 'txt': '\uD83D\uDCDD', 'rst': '\uD83D\uDCDD',
      // Images
      'png': '\uD83D\uDDBC\uFE0F', 'jpg': '\uD83D\uDDBC\uFE0F', 'jpeg': '\uD83D\uDDBC\uFE0F',
      'gif': '\uD83D\uDDBC\uFE0F', 'svg': '\uD83D\uDDBC\uFE0F', 'webp': '\uD83D\uDDBC\uFE0F',
      'ico': '\uD83D\uDDBC\uFE0F', 'bmp': '\uD83D\uDDBC\uFE0F',
      // Video/Audio
      'mp4': '\uD83C\uDFAC', 'webm': '\uD83C\uDFAC', 'mov': '\uD83C\uDFAC',
      'mp3': '\uD83C\uDFB5', 'wav': '\uD83C\uDFB5', 'ogg': '\uD83C\uDFB5',
      // Config/Shell
      'sh': '\uD83D\uDCBB', 'bash': '\uD83D\uDCBB', 'zsh': '\uD83D\uDCBB',
      'env': '\uD83D\uDD10', 'gitignore': '\uD83D\uDEAB', 'dockerfile': '\uD83D\uDC33',
      // Lock files
      'lock': '\uD83D\uDD12',
    };

    return icons[ext.toLowerCase()] || '\uD83D\uDCC4';
  },

  formatFileSize(bytes) {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  },


  // ═══════════════════════════════════════════════════════════════
  // Log Viewer Windows (Floating File Streamers)
  // ═══════════════════════════════════════════════════════════════

  openLogViewerWindow(filePath, sessionId) {
    sessionId = sessionId || this.activeSessionId;
    if (!sessionId) return;

    // Create unique window ID
    const windowId = `${sessionId}-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    // If window already exists, focus it
    if (this.logViewerWindows.has(windowId)) {
      const existing = this.logViewerWindows.get(windowId);
      existing.element.style.zIndex = ++this.logViewerWindowZIndex;
      return;
    }

    // Calculate position (cascade from top-left)
    const windowCount = this.logViewerWindows.size;
    const offsetX = 100 + (windowCount % 5) * 30;
    const offsetY = 100 + (windowCount % 5) * 30;

    // Get filename for title
    const fileName = filePath.split('/').pop();

    // Create window element
    const win = document.createElement('div');
    win.className = 'log-viewer-window';
    win.id = `log-viewer-window-${windowId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.logViewerWindowZIndex;

    win.innerHTML = `
      <div class="log-viewer-window-header">
        <div class="log-viewer-window-title" title="${escapeHtml(filePath)}">
          <span class="icon">📄</span>
          <span class="filename">${escapeHtml(fileName)}</span>
          <span class="status streaming">streaming</span>
        </div>
        <div class="log-viewer-window-actions">
          <button onclick="app.closeLogViewerWindow(${escapeHtml(JSON.stringify(windowId))})" title="Close">×</button>
        </div>
      </div>
      <div class="log-viewer-window-body" id="log-viewer-body-${windowId}">
        <div class="log-info">Connecting to ${escapeHtml(filePath)}...</div>
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable (returns listener refs for cleanup)
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.log-viewer-window-header'));

    // Connect to SSE stream
    const eventSource = new EventSource(
      `/api/sessions/${sessionId}/tail-file?path=${encodeURIComponent(filePath)}&lines=50`
    );

    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const body = document.getElementById(`log-viewer-body-${windowId}`);
      if (!body) return;

      switch (data.type) {
        case 'connected':
          body.innerHTML = '';
          break;
        case 'data':
          // Append data, auto-scroll
          const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 10;
          const content = escapeHtml(data.content);
          body.innerHTML += content;
          if (wasAtBottom) {
            body.scrollTop = body.scrollHeight;
          }
          // Trim if too large
          if (body.innerHTML.length > 500000) {
            body.innerHTML = body.innerHTML.slice(-400000);
          }
          break;
        case 'end':
          this.updateLogViewerStatus(windowId, 'disconnected', 'ended');
          break;
        case 'error':
          body.innerHTML += `<div class="log-error">${escapeHtml(data.error)}</div>`;
          this.updateLogViewerStatus(windowId, 'error', 'error');
          break;
      }
    };

    eventSource.onerror = () => {
      this.updateLogViewerStatus(windowId, 'disconnected', 'connection error');
    };

    // Store reference (including drag listeners for cleanup)
    this.logViewerWindows.set(windowId, {
      element: win,
      eventSource,
      filePath,
      sessionId,
      dragListeners, // Store for cleanup to prevent memory leaks
    });
  },

  updateLogViewerStatus(windowId, statusClass, statusText) {
    const statusEl = document.querySelector(`#log-viewer-window-${windowId} .status`);
    if (statusEl) {
      statusEl.className = `status ${statusClass}`;
      statusEl.textContent = statusText;
    }
  },

  closeLogViewerWindow(windowId) {
    const windowData = this.logViewerWindows.get(windowId);
    if (!windowData) return;

    // Close SSE connection
    if (windowData.eventSource) {
      windowData.eventSource.close();
    }

    // Clean up drag event listeners (both document-level and handle-level)
    if (windowData.dragListeners) {
      document.removeEventListener('mousemove', windowData.dragListeners.move);
      document.removeEventListener('mouseup', windowData.dragListeners.up);
      if (windowData.dragListeners.handle) {
        windowData.dragListeners.handle.removeEventListener('mousedown', windowData.dragListeners.handleMouseDown);
        windowData.dragListeners.handle.removeEventListener('touchstart', windowData.dragListeners.handleTouchStart);
      }
    }

    // Remove element
    windowData.element.remove();

    // Remove from map
    this.logViewerWindows.delete(windowId);
  },

  // Close all log viewer windows for a session
  closeSessionLogViewerWindows(sessionId) {
    const toClose = [];
    for (const [windowId, data] of this.logViewerWindows) {
      if (data.sessionId === sessionId) {
        toClose.push(windowId);
      }
    }
    for (const windowId of toClose) {
      this.closeLogViewerWindow(windowId);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Image Popup Windows (Auto-popup for Screenshots)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Open a popup window to display a detected image.
   * Called automatically when image:detected SSE event is received.
   */
  openImagePopup(imageEvent) {
    const { sessionId, filePath, relativePath, fileName, timestamp, size } = imageEvent;

    // Create unique window ID
    const imageId = `${sessionId}-${timestamp}`;

    // If window already exists for this image, focus it
    if (this.imagePopups.has(imageId)) {
      const existing = this.imagePopups.get(imageId);
      existing.element.style.zIndex = ++this.imagePopupZIndex;
      return;
    }

    // Cap open popups at 20 — close oldest when at limit
    const MAX_IMAGE_POPUPS = 20;
    if (this.imagePopups.size >= MAX_IMAGE_POPUPS) {
      // Map iteration order is insertion order, so first key is oldest
      const oldestId = this.imagePopups.keys().next().value;
      if (oldestId) this.closeImagePopup(oldestId);
    }

    // Calculate position (cascade from center, with offset for multiple popups)
    const windowCount = this.imagePopups.size;
    const centerX = (window.innerWidth - 600) / 2;
    const centerY = (window.innerHeight - 500) / 2;
    const offsetX = centerX + (windowCount % 5) * 30;
    const offsetY = centerY + (windowCount % 5) * 30;

    // Get session name for display
    const session = this.sessions.get(sessionId);
    const sessionName = session?.name || sessionId.substring(0, 8);

    // Format file size
    const sizeKB = (size / 1024).toFixed(1);

    // Build image URL using the existing file-raw endpoint
    // Use relativePath (path from working dir) instead of fileName (basename) for subdirectory images
    const imageUrl = `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(relativePath || fileName)}`;

    // Create window element
    const win = document.createElement('div');
    win.className = 'image-popup-window';
    win.id = `image-popup-${imageId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.imagePopupZIndex;

    win.innerHTML = `
      <div class="image-popup-header">
        <div class="image-popup-title" title="${escapeHtml(filePath)}">
          <span class="icon">🖼️</span>
          <span class="filename">${escapeHtml(fileName)}</span>
          <span class="session-badge">${escapeHtml(sessionName)}</span>
          <span class="size-badge">${sizeKB} KB</span>
        </div>
        <div class="image-popup-actions">
          <button onclick="app.openImageInNewTab(${escapeHtml(JSON.stringify(imageUrl))})" title="Open in new tab">↗</button>
          <button onclick="app.closeImagePopup(${escapeHtml(JSON.stringify(imageId))})" title="Close">×</button>
        </div>
      </div>
      <div class="image-popup-body">
        <img src="${imageUrl}" alt="${escapeHtml(fileName)}"
             onerror="this.parentElement.innerHTML='<div class=\\'image-error\\'>Failed to load image</div>'"
             onclick="app.openImageInNewTab(${escapeHtml(JSON.stringify(imageUrl))})" />
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.image-popup-header'));

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.imagePopupZIndex;
    });

    // Store reference
    this.imagePopups.set(imageId, {
      element: win,
      sessionId,
      filePath,
      dragListeners,
    });
  },

  /**
   * Close an image popup window.
   */
  closeImagePopup(imageId) {
    const popupData = this.imagePopups.get(imageId);
    if (!popupData) return;

    // Clean up drag event listeners (both document-level and handle-level)
    if (popupData.dragListeners) {
      document.removeEventListener('mousemove', popupData.dragListeners.move);
      document.removeEventListener('mouseup', popupData.dragListeners.up);
      if (popupData.dragListeners.touchMove) {
        document.removeEventListener('touchmove', popupData.dragListeners.touchMove);
        document.removeEventListener('touchend', popupData.dragListeners.up);
        document.removeEventListener('touchcancel', popupData.dragListeners.up);
      }
      if (popupData.dragListeners.handle) {
        popupData.dragListeners.handle.removeEventListener('mousedown', popupData.dragListeners.handleMouseDown);
        popupData.dragListeners.handle.removeEventListener('touchstart', popupData.dragListeners.handleTouchStart);
      }
    }

    // Remove element
    popupData.element.remove();

    // Remove from map
    this.imagePopups.delete(imageId);
  },

  /**
   * Open image in a new browser tab.
   */
  openImageInNewTab(url) {
    window.open(url, '_blank');
  },

  /**
   * Close all image popups for a session.
   */
  closeSessionImagePopups(sessionId) {
    const toClose = [];
    for (const [imageId, data] of this.imagePopups) {
      if (data.sessionId === sessionId) {
        toClose.push(imageId);
      }
    }
    for (const imageId of toClose) {
      this.closeImagePopup(imageId);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Mux Sessions (in Monitor Panel)
  // ═══════════════════════════════════════════════════════════════

  async loadMuxSessions() {
    try {
      const res = await fetch('/api/mux-sessions');
      const data = await res.json();
      this.muxSessions = data.data?.sessions || [];
      this.renderMuxSessions();
    } catch (err) {
      console.error('Failed to load mux sessions:', err);
    }
  },

  killAllMuxSessions() {
    const count = this.muxSessions?.length || 0;
    if (count === 0) {
      alert('No sessions to kill');
      return;
    }

    // Show the kill all modal
    document.getElementById('killAllCount').textContent = count;
    const modal = document.getElementById('killAllModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  },

  closeKillAllModal() {
    document.getElementById('killAllModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  },

  async confirmKillAll(killMux) {
    this.closeKillAllModal();

    try {
      if (killMux) {
        // Kill everything including tmux sessions
        const res = await fetch('/api/sessions', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          this.sessions.clear();
          this.muxSessions = [];
          this.activeSessionId = null;
          try { localStorage.removeItem('codeman-active-session'); } catch {}
          this.renderSessionTabs();
          this.renderMuxSessions();
          this.terminal.clear();
          this.terminal.reset();
          this.toast('All sessions and tmux killed', 'success');
        }
      } else {
        // Just remove tabs, keep mux sessions running
        this.sessions.clear();
        this.activeSessionId = null;
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        this.renderSessionTabs();
        this.terminal.clear();
        this.terminal.reset();
        this.toast('All tabs removed, tmux still running', 'info');
      }
    } catch (err) {
      console.error('Failed to kill sessions:', err);
      this.toast('Failed to kill sessions: ' + err.message, 'error');
    }
  },


  renderMuxSessions() {
    this._debouncedCall('muxSessions', this._renderMuxSessionsImmediate);
  },

  _renderMuxSessionsImmediate() {
    const body = document.getElementById('muxSessionsBody');

    if (!this.muxSessions || this.muxSessions.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No mux sessions</div>';
      return;
    }

    let html = '';
    for (const muxSession of this.muxSessions) {
      const stats = muxSession.stats || { memoryMB: 0, cpuPercent: 0, childCount: 0 };

      // Look up rich session data by sessionId
      const session = this.sessions.get(muxSession.sessionId);
      const status = session ? session.status : 'unknown';
      const isWorking = session ? session.isWorking : false;

      // Status badge
      let statusLabel, statusClass;
      if (status === 'idle' && !isWorking) {
        statusLabel = 'IDLE';
        statusClass = 'status-idle';
      } else if (status === 'busy' || isWorking) {
        statusLabel = 'WORKING';
        statusClass = 'status-working';
      } else if (status === 'stopped') {
        statusLabel = 'STOPPED';
        statusClass = 'status-stopped';
      } else {
        statusLabel = status.toUpperCase();
        statusClass = '';
      }

      // Token and cost info
      const tokens = session && session.tokens ? session.tokens : null;
      const totalCost = session ? session.totalCost : 0;
      const model = session ? (session.cliModel || '') : '';
      const modelShort = model.includes('opus') ? 'opus' : model.includes('sonnet') ? 'sonnet' : model.includes('haiku') ? 'haiku' : '';

      // Ralph/Todo progress
      const todoStats = session ? session.ralphTodoStats : null;
      let todoHtml = '';
      if (todoStats && todoStats.total > 0) {
        const pct = Math.round((todoStats.completed / todoStats.total) * 100);
        todoHtml = `<span class="process-stat todo-progress">${todoStats.completed}/${todoStats.total} (${pct}%)</span>`;
      }

      // Format tokens
      let tokenHtml = '';
      if (tokens && tokens.total > 0) {
        const totalK = (tokens.total / 1000).toFixed(1);
        tokenHtml = `<span class="process-stat tokens">${totalK}k tok</span>`;
      }

      // Format cost
      let costHtml = '';
      if (totalCost > 0) {
        costHtml = `<span class="process-stat cost">$${totalCost.toFixed(2)}</span>`;
      }

      // Model badge
      let modelHtml = '';
      if (modelShort) {
        modelHtml = `<span class="monitor-model-badge ${modelShort}">${modelShort}</span>`;
      }

      const sid = escapeHtml(JSON.stringify(muxSession.sessionId));
      html += `
        <div class="process-item process-item-clickable" onclick="app.selectSession(${sid})" title="Switch to session">
          <span class="monitor-status-badge ${statusClass}">${statusLabel}</span>
          <div class="process-info">
            <div class="process-name">${modelHtml} ${escapeHtml(muxSession.name || muxSession.muxName)}</div>
            <div class="process-meta">
              ${tokenHtml}
              ${costHtml}
              ${todoHtml}
              <span class="process-stat memory">${stats.memoryMB}MB</span>
              <span class="process-stat cpu">${stats.cpuPercent}%</span>
            </div>
          </div>
          <div class="process-actions">
            <button class="btn-toolbar btn-sm btn-danger" onclick="event.stopPropagation(); app.killMuxSession(${sid})" title="Kill session">Kill</button>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  },

  renderMonitorSubagents() {
    const body = document.getElementById('monitorSubagentsBody');
    const stats = document.getElementById('monitorSubagentStats');
    if (!body) return;

    const subagents = Array.from(this.subagents.values());
    const activeCount = subagents.filter(s => s.status === 'active' || s.status === 'idle').length;

    if (stats) {
      stats.textContent = `${subagents.length} tracked` + (activeCount > 0 ? `, ${activeCount} active` : '');
    }

    if (subagents.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No background agents</div>';
      return;
    }

    let html = '';
    for (const agent of subagents) {
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const modelBadge = agent.modelShort ? `<span class="model-badge ${agent.modelShort}">${agent.modelShort}</span>` : '';
      const desc = agent.description ? escapeHtml(agent.description.substring(0, 40)) : agent.agentId;

      html += `
        <div class="process-item">
          <span class="process-mode ${statusClass}">${agent.status}</span>
          <div class="process-info">
            <div class="process-name">${modelBadge} ${desc}</div>
            <div class="process-meta">
              <span>ID: ${agent.agentId}</span>
              <span>${agent.toolCallCount || 0} tools</span>
            </div>
          </div>
          <div class="process-actions">
            ${agent.status !== 'completed' ? `<button class="btn-toolbar btn-sm btn-danger" onclick="app.killSubagent(${escapeHtml(JSON.stringify(agent.agentId))})" title="Kill agent">Kill</button>` : ''}
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  },

  async killMuxSession(sessionId) {
    if (!confirm('Kill this mux session?')) return;

    try {
      // Use closeSession to properly clean up both the session tab and tmux process
      // (closeSession handles its own toast messaging)
      await this.closeSession(sessionId, true);
    } catch (err) {
      // Fallback: kill mux directly if session cleanup fails
      try { await fetch(`/api/mux-sessions/${sessionId}`, { method: 'DELETE' }); } catch (_ignored) {}
      this.showToast('Tmux session killed', 'success');
    }
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== sessionId);
    this.renderMuxSessions();
  },

  async reconcileMuxSessions() {
    try {
      const res = await fetch('/api/mux-sessions/reconcile', { method: 'POST' });
      const data = await res.json();

      if (data.data?.dead && data.data.dead.length > 0) {
        this.showToast(`Found ${data.data.dead.length} dead mux session(s)`, 'warning');
        await this.loadMuxSessions();
      } else {
        this.showToast('All mux sessions are alive', 'success');
      }
    } catch (err) {
      this.showToast('Failed to reconcile mux sessions', 'error');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Toast
  // ═══════════════════════════════════════════════════════════════

  toggleNotifications() {
    this.notificationManager?.toggleDrawer();
  },

  // Open a Codeman window stretched across all displays (multi-monitor mode).
  // The server spawns scripts/span-codeman.sh, which launches a fresh, spanning
  // browser --app window so in-page floating panels can cross the monitor seam.
  async launchMultiMonitor() {
    try {
      const res = await fetch('/api/system/span-displays', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        this.showToast('Opening Codeman across all displays…', 'success');
      } else {
        this.showToast(data.error || 'Could not open spanning window', 'error');
      }
    } catch (err) {
      this.showToast('Could not open spanning window: ' + (err?.message || err), 'error');
    }
  },

  // Alias for showToast
  toast(message, type = 'info') {
    return this.showToast(message, type);
  },

  showToast(message, type = 'info', opts = {}) {
    const { duration = 3000, action } = opts;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.style.cssText = 'margin-left:12px;padding:2px 10px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:3px;color:inherit;cursor:pointer;font-size:12px';
      btn.onclick = (e) => { e.stopPropagation(); action.onClick(); toast.remove(); };
      toast.appendChild(btn);
    }

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
    }, duration);
  },


  // ═══════════════════════════════════════════════════════════════
  // System Stats
  // ═══════════════════════════════════════════════════════════════

  startSystemStatsPolling() {
    // Clear any existing interval to prevent duplicates
    this.stopSystemStatsPolling();

    // Initial fetch
    this.fetchSystemStats();

    // Poll every 2 seconds
    this.systemStatsInterval = setInterval(() => {
      this.fetchSystemStats();
    }, 2000);
  },

  stopSystemStatsPolling() {
    if (this.systemStatsInterval) {
      clearInterval(this.systemStatsInterval);
      this.systemStatsInterval = null;
    }
  },

  async fetchSystemStats() {
    // Skip polling when system stats display is hidden
    const statsEl = document.getElementById('headerSystemStats');
    if (!statsEl || statsEl.style.display === 'none') return;

    try {
      const res = await fetch('/api/system/stats');
      const stats = await res.json();
      this.updateSystemStatsDisplay(stats.data);
    } catch (err) {
      // Silently fail - system stats are not critical
    }
  },

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
  },

  // ─── Clipboard ──────────────────────────────────────────────────────────────

  async _onClipboardWrite(data) {
    const text = data?.text;
    if (typeof text !== 'string') return;
    try {
      await navigator.clipboard.writeText(text);
      this.showToast(`Copied to clipboard (${text.length} chars)`, 'success');
    } catch {
      this._showClipboardFallback(text);
    }
  },

  _showClipboardFallback(text) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:8px;padding:16px;max-width:600px;width:90%;max-height:60vh;display:flex;flex-direction:column;gap:12px';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
    const title = document.createElement('span');
    title.style.cssText = 'color:#cdd6f4;font-weight:600';
    title.textContent = 'Clipboard (browser blocked auto-copy)';
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:#cdd6f4;font-size:18px;cursor:pointer';
    closeBtn.textContent = '\u00d7';
    header.appendChild(title);
    header.appendChild(closeBtn);

    const textarea = document.createElement('textarea');
    textarea.readOnly = true;
    textarea.style.cssText = 'background:#181825;color:#cdd6f4;border:1px solid #555;border-radius:4px;padding:8px;font-family:monospace;font-size:13px;resize:none;height:200px;width:100%';
    textarea.value = text;

    const copyBtn = document.createElement('button');
    copyBtn.style.cssText = 'background:#89b4fa;color:#1e1e2e;border:none;border-radius:4px;padding:8px 16px;cursor:pointer;font-weight:600';
    copyBtn.textContent = 'Copy to Clipboard';

    modal.appendChild(header);
    modal.appendChild(textarea);
    modal.appendChild(copyBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        this.showToast('Copied to clipboard', 'success');
        overlay.remove();
      } catch {
        textarea.select();
        document.execCommand('copy');
        this.showToast('Copied (fallback)', 'success');
        overlay.remove();
      }
    };

    const close = () => overlay.remove();
    closeBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
  },
});
