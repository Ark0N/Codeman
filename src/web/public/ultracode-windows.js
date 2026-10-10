/**
 * @fileoverview Ultracode floating run windows — auto-popping draggable windows
 * with a connector line to the originating session tab.
 *
 * This is the "floating thing" companion to the docked master-detail panel in
 * `ultracode-panel.js` (the dock panel stays — these windows are ADDITIONAL).
 * When the `ultracodeFloatingWindows` setting is on (a DEDICATED toggle, separate
 * from the dock panel's `showUltracodeAgents` — see `_ultracodeFloatingEnabled`),
 * a small floating window pops up
 * for each ACTIVE ultracode/Workflow run (status not completed/killed/failed),
 * mirroring the live agent grid, and is connected by a glowing line to the
 * Codeman tab whose `claudeSessionId` matches the run's `sessionUuid` — the same
 * line idiom subagent windows use. The window auto-closes a few seconds after
 * its run finishes; an explicitly-closed run is remembered and never re-pops.
 *
 * Reuses, rather than duplicates:
 *  - `makeWindowDraggable` + the shared `#connectionLines` SVG (subagent-windows.js)
 *  - `_workflowAgentCardHtml`, `_fmtNum`, `_workflowStatusClass`, `_fetchWorkflowRunDetail`,
 *    and the `workflowRuns` / `workflowRunDetails` maps (ultracode-panel.js)
 *
 * The connector-line draw is appended to the shared SVG from inside
 * `_updateConnectionLinesImmediate` (subagent-windows.js calls
 * `_appendUltracodeConnectionLines` at the end of its render pass), so both the
 * subagent and ultracode lines live in one batched read→write reflow pass.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency subagent-windows.js (makeWindowDraggable, updateConnectionLines, #connectionLines)
 * @dependency ultracode-panel.js (workflowRuns/workflowRunDetails, _workflowAgentCardHtml, _fmtNum)
 * @loadorder 15.5 (after subagent-windows.js — needs makeWindowDraggable at runtime)
 */
/* global CodemanApp, escapeHtml */

Object.assign(CodemanApp.prototype, {
  /** Lazily seed the floating-window state maps (constructor also seeds them). */
  _ensureUltracodeWindowState() {
    if (!this.ultracodeWindows) this.ultracodeWindows = new Map(); // runId -> { element, parentSessionId, dragListeners }
    if (!this.ultracodeWindowsClosed) this.ultracodeWindowsClosed = new Set(); // runIds the user dismissed
    if (!this.ultracodeWindowCloseTimers) this.ultracodeWindowCloseTimers = new Map(); // runId -> setTimeout id
    if (!this.ultracodeAgentWindows) this.ultracodeAgentWindows = new Map(); // agentId -> { element, runId, dragListeners }
    if (!this.minimizedUltracodeRuns) this.minimizedUltracodeRuns = new Map(); // sessionId -> Set<runId> minimized to a tab
    if (!this.minimizedUltracodeAgents) this.minimizedUltracodeAgents = new Map(); // sessionId -> Map<agentId,{runId,label}>
    if (this.ultracodeWindowZIndex === undefined) this.ultracodeWindowZIndex = 1000;
  },

  /** Floating windows have their own opt-in (default OFF), independent of the dock panel. */
  _ultracodeFloatingEnabled() {
    const settings = this.loadAppSettingsFromStorage ? this.loadAppSettingsFromStorage() : {};
    return !!(settings && settings.ultracodeFloatingWindows);
  },

  /** A run is "working" until it reaches a terminal status. Mid-run status is absent. */
  _isWorkflowRunActive(run) {
    const s = String((run && run.status) || '');
    return !(s === 'completed' || s === 'killed' || s === 'failed');
  },

  /**
   * Resolve which Codeman tab a run belongs to: the session whose
   * `claudeSessionId` equals the run's `sessionUuid` (the path segment the watcher
   * captured). Falls back to the active session so the line still lands somewhere.
   */
  _resolveUltracodeParentSession(run) {
    const uuid = run && run.sessionUuid;
    if (uuid && this.sessions) {
      for (const [sessionId, session] of this.sessions) {
        if (session && session.claudeSessionId === uuid) return sessionId;
      }
    }
    if (this.activeSessionId && this.sessions && this.sessions.has(this.activeSessionId)) {
      return this.activeSessionId;
    }
    return null;
  },

  /**
   * Auto-pop driver — called for every run discovered/updated and on reconnect seed.
   * Creates a floating window for active runs, refreshes existing ones, and schedules
   * an auto-close once a run finishes.
   */
  _syncUltracodeFloatingWindow(run, opts) {
    this._ensureUltracodeWindowState();
    if (!run || !run.runId) return;
    const runId = run.runId;
    const existing = this.ultracodeWindows.get(runId);
    // Auto-pop is gated on the floating-windows toggle, but an ALREADY-open window
    // (e.g. one opened by clicking the run in the dock) keeps refreshing regardless.
    if (!existing && !this._ultracodeFloatingEnabled()) return;
    if (this.ultracodeWindowsClosed.has(runId)) return; // respect explicit dismissal

    const active = this._isWorkflowRunActive(run);

    // Minimized to a tab — keep it there (don't re-pop a window). Clear the tab badge a
    // short while after the run finishes, mirroring the floating window's finish grace.
    if (this._isUltracodeRunMinimized(runId)) {
      if (!active && !this.ultracodeWindowCloseTimers.has(runId)) {
        const timer = setTimeout(() => {
          this.ultracodeWindowCloseTimers.delete(runId);
          this._removeMinimizedUltracodeRun(runId);
          this.renderSessionTabs();
          this.updateConnectionLines();
        }, 8000);
        this.ultracodeWindowCloseTimers.set(runId, timer);
      }
      return;
    }

    if (active) {
      // Run is alive — cancel any pending auto-close.
      const pending = this.ultracodeWindowCloseTimers.get(runId);
      if (pending) {
        clearTimeout(pending);
        this.ultracodeWindowCloseTimers.delete(runId);
      }
      if (existing) {
        this.renderUltracodeWindowContent(runId);
        this._fetchWorkflowRunDetail(runId); // refresh agents[]; re-renders window on land
      } else {
        // On a reconnect snapshot, only restore windows for genuinely recent runs so
        // a backlog of stale undefined-status runs doesn't carpet the screen.
        if (opts && opts.fromSeed) {
          const FLOAT_SEED_MAX_AGE_MS = 5 * 60 * 1000;
          const age = Date.now() - (run.lastActivityAt || 0);
          if (!(run.lastActivityAt && age < FLOAT_SEED_MAX_AGE_MS)) return;
        }
        this.createUltracodeWindow(run);
      }
    } else if (existing) {
      // Finished — refresh to the final state (status + final agent states), show it
      // briefly, then retire the floating window.
      this._fetchWorkflowRunDetail(runId);
      this.renderUltracodeWindowContent(runId);
      if (!this.ultracodeWindowCloseTimers.has(runId)) {
        const FLOAT_FINISH_GRACE_MS = 8000;
        const timer = setTimeout(() => {
          this.ultracodeWindowCloseTimers.delete(runId);
          this.closeUltracodeWindow(runId, false);
        }, FLOAT_FINISH_GRACE_MS);
        this.ultracodeWindowCloseTimers.set(runId, timer);
      }
    }
  },

  /**
   * Explicitly open (or focus) the floating window for a run — the click-through
   * from the dock panel's run list. Unlike auto-pop this ignores the floating-windows
   * toggle and clears any prior dismissal (it's a direct user action), then draws the
   * connector line from the run's session tab.
   */
  openUltracodeWindowForRun(runId) {
    this._ensureUltracodeWindowState();
    if (!runId) return;
    const run = this.workflowRuns && this.workflowRuns.get(runId);
    if (!run) return;
    this.ultracodeWindowsClosed.delete(runId); // an explicit open overrides a past dismissal
    this._removeMinimizedUltracodeRun(runId); // …and a past minimize-to-tab
    const existing = this.ultracodeWindows.get(runId);
    if (existing) {
      // Already open — bring to front and refresh.
      existing.element.style.zIndex = ++this.ultracodeWindowZIndex;
      this.renderUltracodeWindowContent(runId);
      this._fetchWorkflowRunDetail(runId);
      this.updateConnectionLines();
    } else {
      this.createUltracodeWindow(run);
    }
  },

  /** Build and mount a floating window for a run, positioned near its parent tab. */
  createUltracodeWindow(run) {
    this._ensureUltracodeWindowState();
    const runId = run.runId;
    if (this.ultracodeWindows.has(runId)) return;
    const parentSessionId = this._resolveUltracodeParentSession(run);
    const titleText = run.workflowName || run.summary || runId;

    const win = document.createElement('div');
    win.className = 'ultracode-window spawning';
    win.id = `ultracode-window-${runId}`;
    win.style.zIndex = ++this.ultracodeWindowZIndex;
    win.innerHTML = `
      <div class="ultracode-window-header">
        <div class="ultracode-window-title" title="${escapeHtml(titleText)}">
          <span class="icon">🧬</span>
          <span class="uw-name">${escapeHtml(titleText)}</span>
          <span class="uw-status"></span>
        </div>
        <div class="ultracode-window-actions">
          <button class="uw-min" type="button" title="Minimize to tab">─</button>
          <button class="uw-close" type="button" title="Close">&times;</button>
        </div>
      </div>
      <div class="ultracode-window-body" id="ultracode-window-body-${runId}">
        <div class="subagent-empty">Loading agents…</div>
      </div>
    `;

    // Position: spawn from the parent tab if it is painted, else cascade.
    const parentTab = this._paintedSessionTab(parentSessionId);
    if (parentTab) {
      // _tabAnchor() puts the spawn point below the tab in header layout and to
      // the RIGHT of it in sidebar layout, so the window never lands on the
      // sidebar. The viewport clamp is unchanged.
      const anchor = this._tabAnchor(parentTab.getBoundingClientRect());
      const left = Math.max(8, Math.min(anchor.spawnLeft, window.innerWidth - 392));
      win.style.left = `${left}px`;
      win.style.top = `${anchor.spawnTop + (anchor.vertical ? 14 : 0)}px`;
    } else {
      const n = this.ultracodeWindows.size;
      win.style.left = `${24 + n * 26}px`;
      win.style.top = `${96 + n * 26}px`;
    }

    document.body.appendChild(win);
    // Drop the spawn class on the next frame so the transition runs.
    requestAnimationFrame(() => win.classList.remove('spawning'));
    // Then hand over to the chosen entrance style (no-op for `fly`/`off`, which
    // leave the small scale-in transition above as the whole animation).
    this.applyWindowEntrance?.(win);

    const header = win.querySelector('.ultracode-window-header');
    const dragListeners = this.makeWindowDraggable(win, header);

    win.querySelector('.uw-min').addEventListener('click', (e) => {
      e.stopPropagation();
      this.minimizeUltracodeWindowToTab(runId);
    });
    win.querySelector('.uw-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeUltracodeWindow(runId, true);
    });
    const nameEl = win.querySelector('.uw-name');
    if (parentSessionId) {
      nameEl.style.cursor = 'pointer';
      nameEl.title = 'Go to session';
      nameEl.addEventListener('click', () => this.selectSession(parentSessionId));
    }

    this.ultracodeWindows.set(runId, { element: win, parentSessionId, dragListeners });

    this.renderUltracodeWindowContent(runId);
    this._fetchWorkflowRunDetail(runId); // pull agents[] for the body
    this.updateConnectionLines();
  },

  // ── Minimize a run window into its originating tab (same idiom as subagent windows) ──

  /** Is this run currently minimized to a tab (so auto-pop should leave it alone)? */
  _isUltracodeRunMinimized(runId) {
    if (!this.minimizedUltracodeRuns) return false;
    for (const set of this.minimizedUltracodeRuns.values()) {
      if (set.has(runId)) return true;
    }
    return false;
  },

  /** Drop a run from the minimized-to-tab tracking (all sessions, or a specific one). */
  _removeMinimizedUltracodeRun(runId, sessionId) {
    if (!this.minimizedUltracodeRuns) return;
    if (sessionId) {
      const set = this.minimizedUltracodeRuns.get(sessionId);
      if (set) {
        set.delete(runId);
        if (!set.size) this.minimizedUltracodeRuns.delete(sessionId);
      }
      return;
    }
    for (const [sid, set] of this.minimizedUltracodeRuns) {
      if (set.delete(runId) && !set.size) this.minimizedUltracodeRuns.delete(sid);
    }
  },

  /**
   * Minimize the floating run window into its originating session tab: record it as
   * minimized (so a badge renders on the tab), genie-animate the window toward that
   * tab, then remove the floating element. Restorable from the tab badge dropdown.
   */
  minimizeUltracodeWindowToTab(runId) {
    this._ensureUltracodeWindowState();
    const data = this.ultracodeWindows.get(runId);
    if (!data) return;

    let parentSessionId = data.parentSessionId;
    if (!parentSessionId) {
      const summary = this.workflowRuns && this.workflowRuns.get(runId);
      parentSessionId = summary ? this._resolveUltracodeParentSession(summary) : null;
    }
    // No tab to fly into → fall back to a plain close so the window isn't orphaned.
    if (!parentSessionId) {
      this.closeUltracodeWindow(runId, true);
      return;
    }

    // Cancel any pending finish auto-close — the badge owns the run's lifecycle now.
    const pending = this.ultracodeWindowCloseTimers.get(runId);
    if (pending) {
      clearTimeout(pending);
      this.ultracodeWindowCloseTimers.delete(runId);
    }

    if (!this.minimizedUltracodeRuns.has(parentSessionId)) this.minimizedUltracodeRuns.set(parentSessionId, new Set());
    this.minimizedUltracodeRuns.get(parentSessionId).add(runId);

    const element = data.element;
    const dragListeners = data.dragListeners;
    this._animateUltracodeWindowToTab(element, parentSessionId, () => {
      this._teardownUltracodeDrag(dragListeners);
      if (element) element.remove();
      this.ultracodeWindows.delete(runId);
      // Full rebuild so the tab badge renders (the incremental path only knows subagent badges).
      this._fullRenderSessionTabs();
      this.updateConnectionLines();
    });
  },

  /**
   * Genie the window toward the center of its tab, then invoke `done` to tear it
   * down. A tab that is not painted (hidden by a search) tears down at once.
   */
  _animateUltracodeWindowToTab(element, sessionId, done) {
    const tab = this._paintedSessionTab(sessionId);
    if (!tab || !element) {
      done();
      return;
    }
    const w = element.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    const dx = t.left + t.width / 2 - (w.left + w.width / 2);
    const dy = t.top + t.height / 2 - (w.top + w.height / 2);
    element.style.transformOrigin = 'center center';
    element.style.transition = 'transform 0.26s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.26s ease';
    element.style.pointerEvents = 'none';
    requestAnimationFrame(() => {
      element.style.transform = `translate(${dx}px, ${dy}px) scale(0.06)`;
      element.style.opacity = '0';
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      done();
    };
    element.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 320); // fallback in case transitionend doesn't fire
  },

  /** Tab badge (with restore/dismiss dropdown) for runs minimized to this session's tab. */
  renderUltracodeTabBadge(sessionId) {
    this._ensureUltracodeWindowState();
    const runSet = this.minimizedUltracodeRuns.get(sessionId);
    const agentMap = this.minimizedUltracodeAgents.get(sessionId);
    const total = (runSet ? runSet.size : 0) + (agentMap ? agentMap.size : 0);
    if (total === 0) return '';

    const trunc = (s) => (s.length > 25 ? s.slice(0, 25) + '…' : s);
    const items = [];
    // Minimized run windows (🧬) first…
    if (runSet) {
      for (const runId of runSet) {
        const run = this.workflowRuns && this.workflowRuns.get(runId);
        const name = run ? run.workflowName || run.summary || runId : runId;
        const statusCls = this._workflowStatusClass(run ? String(run.status || '') : '');
        items.push(
          `<div class="subagent-dropdown-item" onclick="event.stopPropagation(); app.restoreUltracodeRunFromTab(${escapeHtml(JSON.stringify(runId))},${escapeHtml(JSON.stringify(sessionId))})" title="Click to restore run">` +
            `<span class="subagent-dropdown-status ${statusCls}"></span>` +
            `<span class="ultracode-dd-icon">🧬</span>` +
            `<span class="subagent-dropdown-name">${escapeHtml(trunc(name))}</span>` +
            `<span class="subagent-dropdown-close" onclick="event.stopPropagation(); app.dismissMinimizedUltracodeRun(${escapeHtml(JSON.stringify(runId))},${escapeHtml(JSON.stringify(sessionId))})" title="Dismiss">&times;</span>` +
            `</div>`
        );
      }
    }
    // …then minimized agent transcripts (📄).
    if (agentMap) {
      for (const [agentId, entry] of agentMap) {
        const name = (entry && entry.label) || agentId;
        items.push(
          `<div class="subagent-dropdown-item" onclick="event.stopPropagation(); app.restoreUltracodeAgentFromTab(${escapeHtml(JSON.stringify(agentId))},${escapeHtml(JSON.stringify(sessionId))})" title="Click to restore transcript">` +
            `<span class="subagent-dropdown-status"></span>` +
            `<span class="ultracode-dd-icon">📄</span>` +
            `<span class="subagent-dropdown-name">${escapeHtml(trunc(name))}</span>` +
            `<span class="subagent-dropdown-close" onclick="event.stopPropagation(); app.dismissMinimizedUltracodeAgent(${escapeHtml(JSON.stringify(agentId))},${escapeHtml(JSON.stringify(sessionId))})" title="Dismiss">&times;</span>` +
            `</div>`
        );
      }
    }
    const label = total === 1 ? 'ULTRA' : `ULTRA (${total})`;
    return (
      `<span class="tab-ultracode-badge" onmouseenter="app.showSubagentDropdown(this)" onmouseleave="app.scheduleHideSubagentDropdown(this)" onclick="event.stopPropagation(); app.pinSubagentDropdown(this);">` +
      `<span class="subagent-label">${label}</span>` +
      `<div class="subagent-dropdown" onmouseenter="app.cancelHideSubagentDropdown()" onmouseleave="app.scheduleHideSubagentDropdown(this.parentElement)">${items.join('')}</div>` +
      `</span>`
    );
  },

  /** Restore a minimized run from its tab badge: re-open the floating window. */
  restoreUltracodeRunFromTab(runId, sessionId) {
    this._ensureUltracodeWindowState();
    this._removeMinimizedUltracodeRun(runId, sessionId);
    this._fullRenderSessionTabs();
    this.openUltracodeWindowForRun(runId);
  },

  /** Dismiss a minimized run from its tab badge (don't re-pop it). */
  dismissMinimizedUltracodeRun(runId, sessionId) {
    this._ensureUltracodeWindowState();
    this._removeMinimizedUltracodeRun(runId, sessionId);
    this.ultracodeWindowsClosed.add(runId);
    this._fullRenderSessionTabs();
    this.updateConnectionLines();
  },

  // ── Minimize an agent transcript window into its tab (same idiom as run windows) ──

  /** Is this agent transcript currently minimized to a tab? */
  _isUltracodeAgentMinimized(agentId) {
    if (!this.minimizedUltracodeAgents) return false;
    for (const map of this.minimizedUltracodeAgents.values()) {
      if (map.has(agentId)) return true;
    }
    return false;
  },

  /** Look up a minimized agent's {runId,label} entry (across sessions). */
  _getMinimizedUltracodeAgent(agentId) {
    if (!this.minimizedUltracodeAgents) return null;
    for (const map of this.minimizedUltracodeAgents.values()) {
      if (map.has(agentId)) return map.get(agentId);
    }
    return null;
  },

  /** Drop an agent from minimized tracking (all sessions, or a specific one). */
  _removeMinimizedUltracodeAgent(agentId, sessionId) {
    if (!this.minimizedUltracodeAgents) return;
    if (sessionId) {
      const map = this.minimizedUltracodeAgents.get(sessionId);
      if (map) {
        map.delete(agentId);
        if (!map.size) this.minimizedUltracodeAgents.delete(sessionId);
      }
      return;
    }
    for (const [sid, map] of this.minimizedUltracodeAgents) {
      if (map.delete(agentId) && !map.size) this.minimizedUltracodeAgents.delete(sid);
    }
  },

  /** Minimize an agent transcript window into the run's originating session tab. */
  minimizeUltracodeAgentWindowToTab(agentId) {
    this._ensureUltracodeWindowState();
    const info = this.ultracodeAgentWindows.get(agentId);
    if (!info) return;
    const runId = info.runId;
    const summary = runId && this.workflowRuns ? this.workflowRuns.get(runId) : null;
    let parentSessionId = summary ? this._resolveUltracodeParentSession(summary) : null;
    if (!parentSessionId && this.activeSessionId && this.sessions && this.sessions.has(this.activeSessionId)) {
      parentSessionId = this.activeSessionId;
    }
    // No tab to fly into → plain close rather than orphan it.
    if (!parentSessionId) {
      this.closeUltracodeAgentWindow(agentId);
      return;
    }
    const labelEl = info.element.querySelector('.uw-name');
    const label = labelEl ? labelEl.textContent : agentId;
    if (!this.minimizedUltracodeAgents.has(parentSessionId))
      this.minimizedUltracodeAgents.set(parentSessionId, new Map());
    this.minimizedUltracodeAgents.get(parentSessionId).set(agentId, { runId, label });

    const element = info.element;
    const dragListeners = info.dragListeners;
    this._animateUltracodeWindowToTab(element, parentSessionId, () => {
      this._teardownUltracodeDrag(dragListeners);
      if (element) element.remove();
      this.ultracodeAgentWindows.delete(agentId);
      this._fullRenderSessionTabs();
      this.updateConnectionLines();
    });
  },

  /** Restore a minimized agent transcript from its tab badge: re-open its window. */
  restoreUltracodeAgentFromTab(agentId, sessionId) {
    this._ensureUltracodeWindowState();
    const entry = this._getMinimizedUltracodeAgent(agentId);
    const runId = entry ? entry.runId : null;
    this._removeMinimizedUltracodeAgent(agentId, sessionId);
    this._fullRenderSessionTabs();
    this.openUltracodeAgentWindow(agentId, runId);
  },

  /** Dismiss a minimized agent transcript from its tab badge. */
  dismissMinimizedUltracodeAgent(agentId, sessionId) {
    this._ensureUltracodeWindowState();
    this._removeMinimizedUltracodeAgent(agentId, sessionId);
    this._fullRenderSessionTabs();
    this.updateConnectionLines();
  },

  /** Remove a floating window. `userInitiated` records a dismissal so it won't re-pop. */
  closeUltracodeWindow(runId, userInitiated) {
    this._ensureUltracodeWindowState();
    const pending = this.ultracodeWindowCloseTimers.get(runId);
    if (pending) {
      clearTimeout(pending);
      this.ultracodeWindowCloseTimers.delete(runId);
    }
    const data = this.ultracodeWindows.get(runId);
    if (userInitiated) this.ultracodeWindowsClosed.add(runId);
    if (!data) return;
    this._teardownUltracodeDrag(data.dragListeners);
    data.element.remove();
    this.ultracodeWindows.delete(runId);
    this.updateConnectionLines();
  },

  /** Detach the document-level drag listeners returned by makeWindowDraggable. */
  _teardownUltracodeDrag(dl) {
    if (!dl) return;
    document.removeEventListener('mousemove', dl.move);
    document.removeEventListener('mouseup', dl.up);
    if (dl.touchMove) {
      document.removeEventListener('touchmove', dl.touchMove);
      document.removeEventListener('touchend', dl.up);
      document.removeEventListener('touchcancel', dl.up);
    }
    if (dl.handle) {
      dl.handle.removeEventListener('mousedown', dl.handleMouseDown);
      dl.handle.removeEventListener('touchstart', dl.handleTouchStart);
    }
  },

  // ── Agent-transcript windows ────────────────────────────────────────────────
  // Clicking an agent card (in a run window OR the dock panel) opens the agent's
  // live transcript as its OWN in-page floating window, line-tied to its parent run
  // window (or the run's session tab when that window is closed). Replaces the old
  // detached `window.open` browser popup so the transcript stays inside the same
  // draggable, connector-line floating-window system as the run windows.

  /** Open (or focus) the floating transcript window for a workflow agent. */
  async openUltracodeAgentWindow(agentId, runId) {
    this._ensureUltracodeWindowState();
    if (!agentId) return;
    this._removeMinimizedUltracodeAgent(agentId); // an explicit open overrides a past minimize
    const existing = this.ultracodeAgentWindows.get(agentId);
    if (existing && existing.element) {
      // Already open — bring to front and refresh transcript.
      existing.element.style.zIndex = ++this.ultracodeWindowZIndex;
      this.updateConnectionLines();
    } else if (!this.createUltracodeAgentWindow(agentId, runId)) {
      return;
    }
    // Body shows a loading state until the fetch lands (re-fetch on focus too, so a
    // still-running agent's transcript grows as you re-click).
    const data = this._fetchWorkflowAgentTranscript ? await this._fetchWorkflowAgentTranscript(agentId) : null;
    this.renderUltracodeAgentWindowContent(agentId, data);
  },

  /** Build and mount the floating agent-transcript window shell near its parent. */
  createUltracodeAgentWindow(agentId, runId) {
    this._ensureUltracodeWindowState();
    if (this.ultracodeAgentWindows.has(agentId)) return this.ultracodeAgentWindows.get(agentId).element;

    const label = this._ultracodeAgentLabel(agentId, runId) || agentId;
    const win = document.createElement('div');
    win.className = 'ultracode-window ultracode-agent-window spawning';
    win.id = `ultracode-agent-window-${agentId}`;
    win.style.zIndex = ++this.ultracodeWindowZIndex;
    win.innerHTML = `
      <div class="ultracode-window-header">
        <div class="ultracode-window-title" title="${escapeHtml(label)} — transcript">
          <span class="icon">📄</span>
          <span class="uw-name">${escapeHtml(label)}</span>
        </div>
        <div class="ultracode-window-actions">
          <button class="uw-min" type="button" title="Minimize to tab">─</button>
          <button class="uw-close" type="button" title="Close">&times;</button>
        </div>
      </div>
      <div class="ultracode-window-body">
        <div class="subagent-empty">Loading transcript…</div>
      </div>
    `;

    // Position: offset from the parent run window if it's open, else cascade.
    const parentWin = runId ? this.ultracodeWindows.get(runId) : null;
    if (parentWin && parentWin.element) {
      const r = parentWin.element.getBoundingClientRect();
      win.style.left = `${Math.max(8, Math.min(r.left + 40, window.innerWidth - 472))}px`;
      win.style.top = `${Math.max(8, Math.min(r.top + 40, window.innerHeight - 160))}px`;
    } else {
      const n = this.ultracodeAgentWindows.size;
      win.style.left = `${Math.min(140 + n * 28, Math.max(8, window.innerWidth - 472))}px`;
      win.style.top = `${110 + n * 28}px`;
    }

    document.body.appendChild(win);
    requestAnimationFrame(() => win.classList.remove('spawning'));
    this.applyWindowEntrance?.(win);

    const header = win.querySelector('.ultracode-window-header');
    const dragListeners = this.makeWindowDraggable(win, header);
    win.querySelector('.uw-min').addEventListener('click', (e) => {
      e.stopPropagation();
      this.minimizeUltracodeAgentWindowToTab(agentId);
    });
    win.querySelector('.uw-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeUltracodeAgentWindow(agentId);
    });

    this.ultracodeAgentWindows.set(agentId, { element: win, runId, dragListeners });
    this.updateConnectionLines();
    return win;
  },

  /** Resolve a human label for an agent from the run's fetched detail.agents[]. */
  _ultracodeAgentLabel(agentId, runId) {
    const detail = this.workflowRunDetails && runId ? this.workflowRunDetails.get(runId) : null;
    const agents = detail && Array.isArray(detail.agents) ? detail.agents : null;
    if (agents) {
      const found = agents.find((a) => a.agentId === agentId);
      if (found && found.label) return found.label;
    }
    return null;
  },

  /** Fill an agent window's body with the fetched transcript (or a friendly empty state). */
  renderUltracodeAgentWindowContent(agentId, data) {
    const info = this.ultracodeAgentWindows.get(agentId);
    if (!info || !info.element) return;
    const body = info.element.querySelector('.ultracode-window-body');
    if (!body) return;
    if (!data || !data.formatted || !data.entryCount) {
      body.innerHTML =
        '<div class="subagent-empty">No transcript available yet — the agent may be queued, aged out of tracking, or subagent tracking is disabled.</div>';
      return;
    }
    const text = escapeHtml(data.formatted.join('\n'));
    body.innerHTML = `<div class="uw-summary">${data.entryCount} entries</div><pre class="uw-transcript">${text}</pre>`;
  },

  /** Close one floating agent-transcript window. */
  closeUltracodeAgentWindow(agentId) {
    this._ensureUltracodeWindowState();
    const info = this.ultracodeAgentWindows.get(agentId);
    if (!info) return;
    this._teardownUltracodeDrag(info.dragListeners);
    if (info.element) info.element.remove();
    this.ultracodeAgentWindows.delete(agentId);
    this.updateConnectionLines();
  },

  /** Tear down every floating window (called on SSE reconnect; keeps user dismissals). */
  removeAllUltracodeWindows() {
    this._ensureUltracodeWindowState();
    const hadMinimized = this.minimizedUltracodeRuns.size > 0 || this.minimizedUltracodeAgents.size > 0;
    const had = this.ultracodeWindows.size > 0 || this.ultracodeAgentWindows.size > 0;
    for (const [, data] of this.ultracodeWindows) {
      this._teardownUltracodeDrag(data.dragListeners);
      if (data.element) data.element.remove();
    }
    this.ultracodeWindows.clear();
    for (const [, info] of this.ultracodeAgentWindows) {
      this._teardownUltracodeDrag(info.dragListeners);
      if (info.element) info.element.remove();
    }
    this.ultracodeAgentWindows.clear();
    for (const t of this.ultracodeWindowCloseTimers.values()) clearTimeout(t);
    this.ultracodeWindowCloseTimers.clear();
    this.minimizedUltracodeRuns.clear();
    this.minimizedUltracodeAgents.clear();
    // Redraw so the now-orphaned connector lines are cleared from the shared SVG.
    if (had) this.updateConnectionLines();
    // Drop any now-stale tab badges.
    if (hadMinimized) this.renderSessionTabs();
  },

  /** When the feature is toggled on, pop windows for any currently-active runs. */
  syncAllUltracodeFloatingWindows() {
    this._ensureUltracodeWindowState();
    if (!this._ultracodeFloatingEnabled()) {
      this.removeAllUltracodeWindows();
      return;
    }
    if (!this.workflowRuns) return;
    for (const run of this.workflowRuns.values()) {
      this._syncUltracodeFloatingWindow(run, { fromSeed: true });
    }
  },

  /** Refresh a floating window's header + body from the latest summary/detail. */
  renderUltracodeWindowContent(runId) {
    const data = this.ultracodeWindows.get(runId);
    if (!data) return;
    const summary = this.workflowRuns && this.workflowRuns.get(runId);
    const detail = this.workflowRunDetails && this.workflowRunDetails.get(runId);
    // Summary is the freshest run-level info (every SSE tick); detail supplies agents[]
    // but is fetched less often. Merge so a completed summary isn't masked by stale detail.
    const run = summary && detail ? { ...detail, ...summary, agents: detail.agents } : detail || summary;
    if (!run) return;

    const nameEl = data.element.querySelector('.uw-name');
    if (nameEl) nameEl.textContent = run.workflowName || run.summary || runId;

    const statusEl = data.element.querySelector('.uw-status');
    if (statusEl) {
      const finished = !this._isWorkflowRunActive(run);
      const label = run.status ? String(run.status) : finished ? '—' : 'running';
      const clsKey = run.status ? run.status : finished ? '' : 'running';
      statusEl.textContent = label;
      statusEl.className = 'uw-status ultracode-status ' + this._workflowStatusClass(clsKey);
    }

    const body = data.element.querySelector('.ultracode-window-body');
    if (body) body.innerHTML = this._ultracodeWindowBodyHtml(run);
  },

  /** Compact body: a stats line + agent cards grouped by phase (reuses panel helpers). */
  _ultracodeWindowBodyHtml(run) {
    const phases = Array.isArray(run.phases) ? run.phases : [];
    const agents = Array.isArray(run.agents) ? run.agents : null;
    const agentCount = run.agentCount ?? (agents ? agents.length : 0);
    const head = `<div class="uw-summary">${this._fmtNum(run.totalTokens)} tok · ${run.totalToolCalls ?? 0} tools · ${agentCount} agents</div>`;

    if (!agents) {
      // Summary-only (detail not fetched yet): show phase chips as a teaser.
      if (phases.length) {
        const chips = phases
          .map(
            (p) =>
              `<span class="ultracode-phase-chip" title="${escapeHtml(p.detail || '')}">${escapeHtml(p.title || '')}</span>`
          )
          .join('');
        return (
          head + `<div class="ultracode-phase-list">${chips}</div><div class="subagent-empty">Loading agents…</div>`
        );
      }
      return head + '<div class="subagent-empty">Loading agents…</div>';
    }
    if (!agents.length) return head + '<div class="subagent-empty">No agents yet</div>';

    const groups = new Map();
    agents.forEach((a) => {
      const key = a.phaseIndex || 0;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    });
    const orderedKeys = Array.from(groups.keys()).sort((a, b) => a - b);
    const grid = orderedKeys
      .map((key) => {
        const group = groups.get(key);
        const title = (phases[key - 1] && phases[key - 1].title) || `Phase ${key}`;
        const tok = group.reduce((s, a) => s + (a.tokens || 0), 0);
        const tools = group.reduce((s, a) => s + (a.toolCalls || 0), 0);
        const header =
          `<div class="ultracode-phase-header"><span>${escapeHtml(title)}</span>` +
          `<span class="ultracode-phase-sub">${this._fmtNum(tok)} tok · ${tools} tools</span></div>`;
        return header + group.map((a) => this._workflowAgentCardHtml(a, run.runId)).join('');
      })
      .join('');
    return head + grid;
  },

  /**
   * Append ultracode-window → parent-tab connector lines into the shared SVG.
   * Invoked at the tail of `_updateConnectionLinesImmediate` (subagent-windows.js),
   * so it shares that pass's batched read/write discipline. `rects` is the tab-rect
   * cache already populated for subagent lines — reuse it, fill any gaps.
   */
  _appendUltracodeConnectionLines(svg, rects) {
    this._ensureUltracodeWindowState();
    if (!svg || !this.ultracodeWindows.size) return;
    if (!rects) rects = new Map();

    // PHASE 1: layout reads (resolve parents, batch getBoundingClientRect).
    const winList = [];
    for (const [runId, data] of this.ultracodeWindows) {
      if (!data.element) continue;
      if (!data.parentSessionId) {
        const summary = this.workflowRuns && this.workflowRuns.get(runId);
        if (summary) data.parentSessionId = this._resolveUltracodeParentSession(summary);
      }
      const parentSessionId = data.parentSessionId;
      if (!parentSessionId) continue;
      const tabKey = 'tab:' + parentSessionId;
      if (!rects.has(tabKey)) {
        const tab = this._paintedSessionTab(parentSessionId);
        if (tab) rects.set(tabKey, tab.getBoundingClientRect());
      }
      winList.push({ runId, parentSessionId, winRect: data.element.getBoundingClientRect() });
    }

    // PHASE 2: writes (curve from the tab anchor to the window — bottom-center to
    // top-center in header layout, right-edge to left-edge in sidebar layout).
    for (const { runId, parentSessionId, winRect } of winList) {
      const tabRect = rects.get('tab:' + parentSessionId);
      if (!tabRect) continue;
      const path = this._tabConnectorPath(this._tabAnchor(tabRect), winRect);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', path);
      line.setAttribute('class', 'connection-line ultracode-connection');
      line.setAttribute('data-run-id', runId);
      line.setAttribute('data-parent-tab', parentSessionId);
      svg.appendChild(line);
    }
  },

  /**
   * Append agent-window → parent connector lines into the shared SVG. Parent is the
   * agent's run floating window when open, else the run's session tab. Called right
   * after `_appendUltracodeConnectionLines` so it shares the same batched pass + the
   * tab-rect cache.
   */
  _appendUltracodeAgentConnectionLines(svg, rects) {
    this._ensureUltracodeWindowState();
    if (!svg || !this.ultracodeAgentWindows.size) return;
    if (!rects) rects = new Map();

    for (const [agentId, info] of this.ultracodeAgentWindows) {
      if (!info.element) continue;
      const winRect = info.element.getBoundingClientRect();
      // Anchor: parent run window bottom-center if open, else the run's tab.
      // A window anchor is always vertical; a tab anchor follows the session-list
      // layout (_tabAnchor), so the curve leaves a sidebar row sideways.
      let anchor;
      const runWin = info.runId ? this.ultracodeWindows.get(info.runId) : null;
      if (runWin && runWin.element) {
        const pr = runWin.element.getBoundingClientRect();
        anchor = { x: pr.left + pr.width / 2, y: pr.bottom, vertical: true };
      } else {
        const summary = info.runId && this.workflowRuns ? this.workflowRuns.get(info.runId) : null;
        const parentSessionId = summary ? this._resolveUltracodeParentSession(summary) : null;
        if (!parentSessionId) continue;
        const tabKey = 'tab:' + parentSessionId;
        if (!rects.has(tabKey)) {
          const tab = this._paintedSessionTab(parentSessionId);
          if (tab) rects.set(tabKey, tab.getBoundingClientRect());
        }
        const tabRect = rects.get(tabKey);
        if (!tabRect) continue;
        anchor = this._tabAnchor(tabRect);
      }
      const path = this._tabConnectorPath(anchor, winRect);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', path);
      line.setAttribute('class', 'connection-line ultracode-connection ultracode-agent-connection');
      line.setAttribute('data-agent-id', agentId);
      svg.appendChild(line);
    }
  },
});
