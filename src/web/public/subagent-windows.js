// Codeman — Subagent window management for CodemanApp
// Loaded after app.js (needs CodemanApp class defined)

Object.assign(CodemanApp.prototype, {
  // Render subagent badge with dropdown for minimized agents on a tab
  renderSubagentTabBadge(sessionId, minimizedAgents) {
    if (!minimizedAgents || minimizedAgents.size === 0) return '';

    const agentItems = [];
    for (const agentId of minimizedAgents) {
      const agent = this.subagents.get(agentId);
      const displayName = agent?.description || agentId.substring(0, 12);
      const truncatedName = displayName.length > 25 ? displayName.substring(0, 25) + '…' : displayName;
      const statusClass = agent?.status || 'idle';
      agentItems.push(`
        <div class="subagent-dropdown-item" onclick="event.stopPropagation(); app.restoreMinimizedSubagent('${escapeHtml(agentId)}', '${escapeHtml(sessionId)}')" title="Click to restore">
          <span class="subagent-dropdown-status ${statusClass}"></span>
          <span class="subagent-dropdown-name">${escapeHtml(truncatedName)}</span>
          <span class="subagent-dropdown-close" onclick="event.stopPropagation(); app.permanentlyCloseMinimizedSubagent('${escapeHtml(agentId)}', '${escapeHtml(sessionId)}')" title="Dismiss">&times;</span>
        </div>
      `);
    }

    // Compact badge - shows on hover, click to pin open
    const count = minimizedAgents.size;
    const label = count === 1 ? 'AGENT' : `AGENTS (${count})`;
    return `
      <span class="tab-subagent-badge"
            onmouseenter="app.showSubagentDropdown(this)"
            onmouseleave="app.scheduleHideSubagentDropdown(this)"
            onclick="event.stopPropagation(); app.pinSubagentDropdown(this);">
        <span class="subagent-label">${label}</span>
        <div class="subagent-dropdown" onmouseenter="app.cancelHideSubagentDropdown()" onmouseleave="app.scheduleHideSubagentDropdown(this.parentElement)">
          ${agentItems.join('')}
        </div>
      </span>
    `;
  },

  // Restore a minimized subagent window
  restoreMinimizedSubagent(agentId, sessionId) {
    // Remove from minimized set
    const minimizedAgents = this.minimizedSubagents.get(sessionId);
    if (minimizedAgents) {
      minimizedAgents.delete(agentId);
      if (minimizedAgents.size === 0) {
        this.minimizedSubagents.delete(sessionId);
      }
    }

    // Restore the window
    this.restoreSubagentWindow(agentId);

    // Re-render tabs to update badge
    this.renderSessionTabs();

    // Persist the state change
    this.saveSubagentWindowStates();
  },

  // Permanently close a minimized subagent (remove from DOM and minimized set)
  permanentlyCloseMinimizedSubagent(agentId, sessionId) {
    // Remove from minimized set
    const minimizedAgents = this.minimizedSubagents.get(sessionId);
    if (minimizedAgents) {
      minimizedAgents.delete(agentId);
      if (minimizedAgents.size === 0) {
        this.minimizedSubagents.delete(sessionId);
      }
    }

    // Force close the window (removes from DOM)
    this.forceCloseSubagentWindow(agentId);

    // Re-render tabs to update badge
    this.renderSessionTabs();
    this.updateConnectionLines();

    // Persist the state change
    this.saveSubagentWindowStates();
  },

  // ========== Subagent Window State Persistence ==========

  /**
   * Save subagent window states (minimized/open) to server for cross-browser persistence.
   * Called when a window is minimized, restored, or auto-minimized on completion.
   */
  async saveSubagentWindowStates() {
    // Build state object: which agents are minimized per session
    const minimizedState = {};
    for (const [sessionId, agentIds] of this.minimizedSubagents) {
      minimizedState[sessionId] = Array.from(agentIds);
    }

    // Also track which windows are open (not minimized)
    const openWindows = [];
    for (const [agentId, windowData] of this.subagentWindows) {
      if (!windowData.minimized) {
        openWindows.push({
          agentId,
          position: windowData.position || null
        });
      }
    }

    const windowStates = { minimized: minimizedState, open: openWindows };

    // Save to localStorage for quick restore
    localStorage.setItem('codeman-subagent-window-states', JSON.stringify(windowStates));

    // Save to server for cross-browser persistence
    try {
      await fetch('/api/subagent-window-states', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(windowStates)
      });
    } catch (err) {
      console.error('Failed to save subagent window states to server:', err);
    }
  },

  /**
   * Restore subagent window states after loading subagents.
   * Opens windows that were open before, keeps minimized ones minimized.
   * IMPORTANT: Parent associations are loaded from subagentParentMap BEFORE this is called.
   */
  async restoreSubagentWindowStates() {
    const states = await this.loadSubagentWindowStates();

    // Restore minimized state using the PERSISTENT parent map
    // Skip old agents from previous runs to avoid confusion
    const cutoffTime = Date.now() - 10 * 60 * 1000; // 10 minutes
    for (const [savedSessionId, agentIds] of Object.entries(states.minimized || {})) {
      if (Array.isArray(agentIds) && agentIds.length > 0) {
        for (const agentId of agentIds) {
          const agent = this.subagents.get(agentId);
          if (!agent) continue; // Agent no longer exists

          // Skip completed or old agents
          const agentStartTime = agent.startedAt || 0;
          if (agent.status === 'completed' || agentStartTime < cutoffTime) continue;

          // Use the PERSISTENT parent map (THE source of truth)
          // Fall back to saved sessionId only if it exists in current sessions
          const parentFromMap = this.subagentParentMap.get(agentId);
          const correctSessionId = parentFromMap ||
            (this.sessions.has(savedSessionId) ? savedSessionId : null);

          if (correctSessionId) {
            // Ensure the parent map has this association
            if (!parentFromMap && this.sessions.has(savedSessionId)) {
              this.setAgentParentSessionId(agentId, savedSessionId);
            }

            if (!this.minimizedSubagents.has(correctSessionId)) {
              this.minimizedSubagents.set(correctSessionId, new Set());
            }
            this.minimizedSubagents.get(correctSessionId).add(agentId);
          }
        }
      }
    }

    // Restore open windows (for recent, non-completed agents only)
    const now = Date.now();
    const maxAgeMs = 10 * 60 * 1000; // 10 minutes - don't restore windows for old agents
    for (const { agentId, position } of (states.open || [])) {
      const agent = this.subagents.get(agentId);
      // Only restore window if agent exists, is recent, and is still active/idle
      const agentAge = agent?.startedAt ? now - agent.startedAt : Infinity;
      if (agent && agent.status !== 'completed' && agentAge < maxAgeMs) {
        this.openSubagentWindow(agentId);
        // Restore position if saved (with viewport bounds check)
        if (position) {
          const windowData = this.subagentWindows.get(agentId);
          if (windowData && windowData.element) {
            // Parse position values and clamp to viewport
            let left = parseInt(position.left, 10) || 50;
            let top = parseInt(position.top, 10) || 120;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const windowWidth = 420;
            const windowHeight = 350;
            left = Math.max(10, Math.min(left, viewportWidth - windowWidth - 10));
            top = Math.max(10, Math.min(top, viewportHeight - windowHeight - 10));
            windowData.element.style.left = `${left}px`;
            windowData.element.style.top = `${top}px`;
            windowData.position = { left: `${left}px`, top: `${top}px` };
          }
        }
      }
    }

    this.renderSessionTabs(); // Update tab badges
    this.saveSubagentWindowStates(); // Persist corrected mappings

    // Update connection lines after all windows are restored (use rAF to ensure DOM is ready)
    requestAnimationFrame(() => {
      this.updateConnectionLines();
    });
  },

  // ========== Subagent Connection Lines ==========
  //
  // Connection lines are drawn from agent windows to their parent TABs.
  // The parent TAB is determined by the PERSISTENT subagentParentMap.
  // This map stores agentId -> sessionId, where sessionId is the tab's data-id.

  updateConnectionLines() {
    // Coalesce multiple calls — uses background scheduler priority to avoid
    // competing with terminal writes for main thread time
    if (!this._connectionLinesScheduled) {
      this._connectionLinesScheduled = true;
      scheduleBackground(() => {
        this._connectionLinesScheduled = false;
        this._updateConnectionLinesImmediate();
      });
    }
  },

  _updateConnectionLinesImmediate() {
    const svg = document.getElementById('connectionLines');
    if (!svg) return;

    // Check if Ralph wizard modal is open
    const wizardModal = document.getElementById('ralphWizardModal');
    const wizardOpen = wizardModal?.classList.contains('active');
    const wizardContent = wizardOpen ? wizardModal.querySelector('.modal-content') : null;

    // Collect visible regular subagent windows
    const visibleSubagentWindows = [];
    for (const [agentId, windowInfo] of this.subagentWindows) {
      if (windowInfo.minimized || windowInfo.hidden) continue;
      const win = windowInfo.element;
      if (!win) continue;
      visibleSubagentWindows.push({ agentId, windowInfo, win });
    }

    // Get plan subagent windows as array for distribution
    const planSubagentArray = Array.from(this.planSubagents.entries())
      .filter(([, data]) => data.element)
      .map(([id, data]) => ({ id, ...data }));

    // === PHASE 1: Batch all layout reads (getBoundingClientRect) ===
    // Reading layout properties forces the browser to calculate layout.
    // By batching all reads before any writes, we avoid repeated forced reflows.
    const rects = new Map();

    // Read all subagent window rects
    for (const { agentId, win } of visibleSubagentWindows) {
      rects.set('sub:' + agentId, win.getBoundingClientRect());
    }

    // Read all plan subagent rects
    for (const planAgent of planSubagentArray) {
      rects.set('plan:' + planAgent.id, planAgent.element.getBoundingClientRect());
    }

    // Read wizard rect (if open)
    let wizardRect = null;
    if (wizardOpen && wizardContent) {
      wizardRect = wizardContent.getBoundingClientRect();
    }

    // Read tab rects for normal mode (only tabs that are actually needed)
    if (!wizardOpen) {
      for (const { agentId } of visibleSubagentWindows) {
        const parentSessionId = this.subagentParentMap.get(agentId);
        if (!parentSessionId || rects.has('tab:' + parentSessionId)) continue;
        const tab = document.querySelector(`.session-tab[data-id="${parentSessionId}"]`);
        if (tab) rects.set('tab:' + parentSessionId, tab.getBoundingClientRect());
      }
    }

    // Read plan window rects for wizard-to-plan lines
    if (wizardOpen && wizardContent && this.planSubagents.size > 0 && !this.planAgentsMinimized) {
      for (const [agentId, windowData] of this.planSubagents) {
        if (!windowData.element) continue;
        const key = 'planwin:' + agentId;
        if (!rects.has(key)) rects.set(key, windowData.element.getBoundingClientRect());
      }
    }

    // === PHASE 2: DOM writes using cached rects (no more layout reads) ===
    svg.innerHTML = '';

    for (const { agentId } of visibleSubagentWindows) {
      const winRect = rects.get('sub:' + agentId);

      // If wizard is open with plan subagents, connect regular subagents to plan subagent windows
      if (wizardOpen && wizardContent && planSubagentArray.length > 0) {
        // Find the nearest plan subagent window to connect to
        let nearestPlanAgent = null;
        let nearestDistance = Infinity;

        for (const planAgent of planSubagentArray) {
          const planRect = rects.get('plan:' + planAgent.id);
          const planCenterX = planRect.left + planRect.width / 2;
          const planCenterY = planRect.top + planRect.height / 2;
          const winCenterX = winRect.left + winRect.width / 2;
          const winCenterY = winRect.top + winRect.height / 2;
          const distance = Math.hypot(planCenterX - winCenterX, planCenterY - winCenterY);

          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestPlanAgent = planAgent;
          }
        }

        if (nearestPlanAgent) {
          const planRect = rects.get('plan:' + nearestPlanAgent.id);

          // Draw line from plan subagent window to regular subagent window
          let x1, y1, x2, y2;
          const planCenterX = planRect.left + planRect.width / 2;
          const winCenterX = winRect.left + winRect.width / 2;

          if (winCenterX < planCenterX) {
            x1 = planRect.left;
            y1 = planRect.top + planRect.height / 2;
            x2 = winRect.right;
            y2 = winRect.top + winRect.height / 2;
          } else {
            x1 = planRect.right;
            y1 = planRect.top + planRect.height / 2;
            x2 = winRect.left;
            y2 = winRect.top + winRect.height / 2;
          }

          const midX = (x1 + x2) / 2;
          const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;

          const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          line.setAttribute('d', path);
          line.setAttribute('class', 'connection-line plan-to-subagent-line');
          line.setAttribute('data-agent-id', agentId);
          line.setAttribute('data-plan-agent-id', nearestPlanAgent.id);
          svg.appendChild(line);
        }
      } else if (wizardOpen && wizardContent) {
        // Wizard open but no plan subagents - connect directly to wizard
        const winCenterX = winRect.left + winRect.width / 2;
        const wizardCenterX = wizardRect.left + wizardRect.width / 2;

        let x1, y1, x2, y2;

        if (winCenterX < wizardCenterX) {
          x1 = wizardRect.left;
          y1 = wizardRect.top + wizardRect.height / 2;
          x2 = winRect.right;
          y2 = winRect.top + winRect.height / 2;
        } else {
          x1 = wizardRect.right;
          y1 = wizardRect.top + wizardRect.height / 2;
          x2 = winRect.left;
          y2 = winRect.top + winRect.height / 2;
        }

        const midX = (x1 + x2) / 2;
        const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', path);
        line.setAttribute('class', 'connection-line wizard-connection');
        line.setAttribute('data-agent-id', agentId);
        svg.appendChild(line);
      } else {
        // NORMAL MODE: Connect agent window to its parent TAB
        // Use the PERSISTENT subagentParentMap as the ONLY source of truth
        const parentSessionId = this.subagentParentMap.get(agentId);

        if (!parentSessionId) {
          // No parent known yet - skip this agent
          continue;
        }

        const tabRect = rects.get('tab:' + parentSessionId);
        if (!tabRect) {
          // Tab not in DOM (might be scrolled out or session closed)
          continue;
        }

        // Draw curved line from TAB bottom-center to window top-center
        const x1 = tabRect.left + tabRect.width / 2;
        const y1 = tabRect.bottom;
        const x2 = winRect.left + winRect.width / 2;
        const y2 = winRect.top;

        // Bezier curve control points for smooth curve
        const midY = (y1 + y2) / 2;
        const path = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', path);
        line.setAttribute('class', 'connection-line');
        line.setAttribute('data-agent-id', agentId);
        line.setAttribute('data-parent-tab', parentSessionId);
        svg.appendChild(line);
      }
    }

    // Draw lines from wizard to plan subagent windows (Opus agents during plan generation)
    // Skip if agents are minimized to tab
    if (wizardOpen && wizardContent && this.planSubagents.size > 0 && !this.planAgentsMinimized) {
      for (const [agentId] of this.planSubagents) {
        const winRect = rects.get('planwin:' + agentId);
        if (!winRect) continue;

        // Determine which side of wizard the window is on
        const winCenterX = winRect.left + winRect.width / 2;
        const wizardCenterX = wizardRect.left + wizardRect.width / 2;

        let x1, y1, x2, y2;

        if (winCenterX < wizardCenterX) {
          x1 = wizardRect.left;
          y1 = wizardRect.top + wizardRect.height / 3 + (this.planSubagents.size > 3 ? 0 : 50);
          x2 = winRect.right;
          y2 = winRect.top + winRect.height / 2;
        } else {
          x1 = wizardRect.right;
          y1 = wizardRect.top + wizardRect.height / 3 + (this.planSubagents.size > 3 ? 0 : 50);
          x2 = winRect.left;
          y2 = winRect.top + winRect.height / 2;
        }

        const midX = (x1 + x2) / 2;
        const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', path);
        line.setAttribute('class', 'connection-line wizard-connection plan-subagent-line');
        line.setAttribute('data-plan-agent-id', agentId);
        svg.appendChild(line);
      }
    }
  },

  // ========== Subagent Floating Windows ==========

  openSubagentWindow(agentId) {
    // If window already exists, focus it
    if (this.subagentWindows.has(agentId)) {
      const existing = this.subagentWindows.get(agentId);
      const agent = this.subagents.get(agentId);
      const settings = this.loadAppSettingsFromStorage();
      const activeTabOnly = settings.subagentActiveTabOnly ?? true;

      // If window is hidden (different tab) and activeTabOnly is enabled, switch to parent tab
      if (existing.hidden && agent?.parentSessionId && activeTabOnly) {
        this.selectSession(agent.parentSessionId);
        return;
      }

      // If not activeTabOnly mode, just show the window
      if (existing.hidden && !activeTabOnly) {
        existing.element.style.display = 'flex';
        existing.hidden = false;
      }

      existing.element.style.zIndex = ++this.subagentWindowZIndex;
      if (existing.minimized) {
        this.restoreSubagentWindow(agentId);
      }
      return;
    }

    const agent = this.subagents.get(agentId);
    if (!agent) return;

    // Only open windows for agents that belong to a Codeman-managed session tab.
    // Agents from external Claude sessions (not tracked by Codeman) should not pop up.
    if (agent.sessionId) {
      const hasMatchingTab = Array.from(this.sessions.values()).some(s => s.claudeSessionId === agent.sessionId);
      if (!hasMatchingTab) return;
    }

    // Calculate final position - grid layout to avoid overlaps
    const windowCount = this.subagentWindows.size;
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    const mobileCardHeight = 110;
    const mobileCardGap = 4;
    const windowWidth = isMobile ? window.innerWidth : 420;
    const windowHeight = isMobile ? mobileCardHeight : 350;
    const gap = 20;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let finalX = 0;
    let finalY = 0;

    if (isMobile) {
      // Mobile: stack compact cards. Count visible (non-minimized) windows.
      let visibleCount = 0;
      for (const [, data] of this.subagentWindows) {
        if (!data.minimized && !data.hidden) visibleCount++;
      }
      finalX = 4;
      const keyboardUp = typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible;
      if (keyboardUp) {
        // Keyboard visible: stack from bottom above toolbar
        const toolbarHeight = 40;
        const bottomOffset = toolbarHeight + visibleCount * (mobileCardHeight + mobileCardGap);
        finalY = viewportHeight - bottomOffset - mobileCardHeight;
      } else {
        // Keyboard hidden: stack from top below header with spacing
        const headerHeight = document.querySelector('.header')?.offsetHeight || 36;
        const topStart = headerHeight + 8;
        finalY = topStart + visibleCount * (mobileCardHeight + mobileCardGap);
      }
    } else {
      // Check if Ralph wizard modal is open - if so, position windows on the sides
      const wizardModal = document.getElementById('ralphWizardModal');
      const wizardOpen = wizardModal?.classList.contains('active');

      let startX, startY, maxCols;

      if (wizardOpen) {
        // Wizard is ~720px wide, centered. Position windows on left/right sides
        const wizardWidth = 720;
        const centerX = viewportWidth / 2;
        const wizardLeft = centerX - wizardWidth / 2;
        const wizardRight = centerX + wizardWidth / 2;

        // Alternate between left and right sides of the wizard
        const leftSideSpace = wizardLeft - 20;
        const rightSideSpace = viewportWidth - wizardRight - 20;

        if (windowCount % 2 === 0 && rightSideSpace >= windowWidth) {
          // Even windows go to the right
          startX = wizardRight + 20;
          maxCols = Math.floor(rightSideSpace / (windowWidth + gap)) || 1;
        } else if (leftSideSpace >= windowWidth) {
          // Odd windows go to the left
          startX = Math.max(10, wizardLeft - windowWidth - 20);
          maxCols = 1; // Usually only room for 1 column on left
        } else {
          // Not enough side space, use right side
          startX = wizardRight + 20;
          maxCols = 1;
        }
        startY = 80; // Start higher when wizard is open
      } else {
        // Normal positioning
        startX = 50;
        startY = 120;
        maxCols = Math.floor((viewportWidth - startX - 50) / (windowWidth + gap)) || 1;
      }

      const maxRows = Math.floor((viewportHeight - startY - 50) / (windowHeight + gap)) || 1;
      const col = windowCount % maxCols;
      const row = Math.floor(windowCount / maxCols) % maxRows; // Wrap rows to stay in viewport
      finalX = startX + col * (windowWidth + gap);
      finalY = startY + row * (windowHeight + gap);

      // Ensure window stays within viewport bounds
      finalX = Math.max(10, Math.min(finalX, viewportWidth - windowWidth - 10));
      finalY = Math.max(10, Math.min(finalY, viewportHeight - windowHeight - 10));
    }

    // Get parent session from PERSISTENT map (THE source of truth for tab connections)
    const parentSessionId = this.subagentParentMap.get(agentId) || agent.parentSessionId;
    let parentSessionName = null;

    if (parentSessionId) {
      const parentSession = this.sessions.get(parentSessionId);
      if (parentSession) {
        parentSessionName = this.getSessionName(parentSession);
        // Ensure the agent object is also updated for consistency
        if (!agent.parentSessionId) {
          agent.parentSessionId = parentSessionId;
          agent.parentSessionName = parentSessionName;
          this.subagents.set(agentId, agent);
        }
      }
    }

    // Get parent TAB element for spawn animation
    const parentTab = parentSessionId
      ? document.querySelector(`.session-tab[data-id="${parentSessionId}"]`)
      : null;

    // Create window element
    const win = document.createElement('div');
    win.className = 'subagent-window';
    win.id = `subagent-window-${agentId}`;
    win.style.zIndex = ++this.subagentWindowZIndex;

    // Build parent header if we have parent info
    const parentHeader = parentSessionId && parentSessionName
      ? `<div class="subagent-window-parent" data-parent-session="${parentSessionId}">
          <span class="parent-label">from</span>
          <span class="parent-name" onclick="app.selectSession('${escapeHtml(parentSessionId)}')">${escapeHtml(parentSessionName)}</span>
        </div>`
      : '';

    const teammateInfo = this.getTeammateInfo(agent);
    const windowTitle = teammateInfo ? teammateInfo.name : (agent.description || agentId.substring(0, 7));
    const maxTitleLen = isMobile ? 30 : 50;
    const truncatedTitle = windowTitle.length > maxTitleLen ? windowTitle.substring(0, maxTitleLen) + '...' : windowTitle;
    const modelBadge = agent.modelShort
      ? `<span class="subagent-model-badge ${agent.modelShort}">${agent.modelShort}</span>`
      : '';
    win.innerHTML = `
      <div class="subagent-window-header">
        <div class="subagent-window-title" title="${escapeHtml(agent.description || agentId)}">
          <span class="icon">🤖</span>
          <span class="id">${escapeHtml(truncatedTitle)}</span>
          ${modelBadge}
          <span class="status ${agent.status}">${agent.status}</span>
        </div>
        <div class="subagent-window-actions">
          <button onclick="app.closeSubagentWindow('${escapeHtml(agentId)}')" title="Minimize to tab">─</button>
        </div>
      </div>
      ${parentHeader}
      <div class="subagent-window-body" id="subagent-window-body-${agentId}">
        <div class="subagent-empty">Loading activity...</div>
      </div>
    `;

    // If we have a parent tab, start window at tab position for spawn animation
    if (isMobile) {
      // Mobile: position using top (keyboard-aware positioning calculated above)
      win.style.top = `${finalY}px`;
      win.style.bottom = 'auto';
    } else if (parentTab) {
      const tabRect = parentTab.getBoundingClientRect();
      win.style.left = `${tabRect.left}px`;
      win.style.top = `${tabRect.bottom}px`;
      win.style.transform = 'scale(0.3)';
      win.style.opacity = '0';
      win.classList.add('spawning');
    } else {
      // No parent tab, just position normally (desktop/tablet)
      win.style.left = `${finalX}px`;
      win.style.top = `${finalY}px`;
    }

    document.body.appendChild(win);

    // Make draggable (returns listener refs for cleanup)
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.subagent-window-header'));

    // Check if this window should be visible based on settings
    // Use the PERSISTENT parent map for accurate tab-based visibility
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;
    let shouldHide = false;
    if (activeTabOnly) {
      const storedParent = this.subagentParentMap.get(agentId);
      const hasKnownParent = storedParent || agent.parentSessionId;
      const parentId = storedParent || agent.parentSessionId;
      const isForActiveSession = !hasKnownParent || parentId === this.activeSessionId;
      shouldHide = !isForActiveSession;
    }

    // Store reference (including drag listeners for cleanup)
    this.subagentWindows.set(agentId, {
      element: win,
      minimized: false,
      hidden: shouldHide,
      dragListeners, // Store for cleanup to prevent memory leaks
    });

    // Hide window if not for active session
    if (shouldHide) {
      win.style.display = 'none';
    }

    // Render content — check if this teammate has a tmux pane
    const paneInfo = teammateInfo ? this.teammatePanesByName.get(teammateInfo.name) : null;
    if (paneInfo) {
      this.initTeammateTerminal(agentId, paneInfo, win);
    } else {
      this.renderSubagentWindowContent(agentId);
    }

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.subagentWindowZIndex;
    });

    // Update connection lines when window is resized
    const resizeObserver = new ResizeObserver(() => {
      this.updateConnectionLines();
    });
    resizeObserver.observe(win);

    // Store observer for cleanup
    this.subagentWindows.get(agentId).resizeObserver = resizeObserver;

    // Animate to final position if spawning from tab (desktop only)
    if (parentTab && !isMobile) {
      requestAnimationFrame(() => {
        win.style.transition = 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
        win.style.left = `${finalX}px`;
        win.style.top = `${finalY}px`;
        win.style.transform = 'scale(1)';
        win.style.opacity = '1';

        // Clean up after animation
        setTimeout(() => {
          win.style.transition = '';
          win.classList.remove('spawning');
          this.updateConnectionLines();
        }, 400);
      });
    } else {
      // No animation (mobile uses CSS positioning), just update connection lines
      this.updateConnectionLines();
    }

    // Persist the state change (new window opened)
    this.saveSubagentWindowStates();
  },

  closeSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (!windowData) return;

    const agent = this.subagents.get(agentId);

    // Get parent from PERSISTENT map (THE source of truth)
    // Fall back to agent's parentSessionId, then to active session
    const storedParent = this.subagentParentMap.get(agentId);
    let parentSessionId = storedParent || agent?.parentSessionId || this.activeSessionId;

    // If we don't have a stored parent yet, store it now
    if (!storedParent && parentSessionId && this.sessions.has(parentSessionId)) {
      this.setAgentParentSessionId(agentId, parentSessionId);
    }

    // Always minimize to tab
    windowData.element.style.display = 'none';
    windowData.minimized = true;

    // Track minimized agent for the session (use the TAB's session ID)
    if (parentSessionId) {
      if (!this.minimizedSubagents.has(parentSessionId)) {
        this.minimizedSubagents.set(parentSessionId, new Set());
      }
      this.minimizedSubagents.get(parentSessionId).add(agentId);

      // Update tab badge to show minimized agents
      this.renderSessionTabs();
    }

    // Persist the state change
    this.saveSubagentWindowStates();
    this.updateConnectionLines();
    // Restack remaining visible mobile windows to fill the gap
    this.relayoutMobileSubagentWindows();
  },

  /** Reposition all visible mobile subagent windows (called on keyboard show/hide). */
  relayoutMobileSubagentWindows() {
    if (MobileDetection.getDeviceType() !== 'mobile') return;
    const mobileCardHeight = 110;
    const mobileCardGap = 4;
    const keyboardUp = typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible;
    let idx = 0;
    for (const [, data] of this.subagentWindows) {
      if (data.minimized || data.hidden) continue;
      const el = data.element;
      // Reset left to proper position (drag may have set an arbitrary value)
      el.style.left = '4px';
      if (keyboardUp) {
        // Stack from bottom above toolbar
        const bottomPx = 40 + idx * (mobileCardHeight + mobileCardGap);
        el.style.bottom = `${bottomPx}px`;
        el.style.top = 'auto';
      } else {
        // Stack from top below header
        const headerHeight = document.querySelector('.header')?.offsetHeight || 36;
        const topPx = headerHeight + 8 + idx * (mobileCardHeight + mobileCardGap);
        el.style.top = `${topPx}px`;
        el.style.bottom = 'auto';
      }
      idx++;
    }
  },

  // Clean up ALL floating windows (called during handleInit to prevent memory leaks on reconnect)
  cleanupAllFloatingWindows() {
    // Clean up all subagent windows with their ResizeObservers and drag listeners
    for (const [agentId, windowData] of this.subagentWindows) {
      if (windowData.resizeObserver) {
        windowData.resizeObserver.disconnect();
      }
      if (windowData.dragListeners) {
        document.removeEventListener('mousemove', windowData.dragListeners.move);
        document.removeEventListener('mouseup', windowData.dragListeners.up);
        if (windowData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', windowData.dragListeners.touchMove);
          document.removeEventListener('touchend', windowData.dragListeners.up);
          document.removeEventListener('touchcancel', windowData.dragListeners.up);
        }
      }
      windowData.element.remove();
    }
    this.subagentWindows.clear();

    // Clean up all teammate terminals
    for (const [, termData] of this.teammateTerminals) {
      if (termData.resizeObserver) termData.resizeObserver.disconnect();
      if (termData.terminal) {
        try { termData.terminal.dispose(); } catch {}
      }
    }
    this.teammateTerminals.clear();
    this.teammatePanesByName.clear();

    // Clean up all log viewer windows with their EventSources and drag listeners
    for (const [windowId, data] of this.logViewerWindows) {
      if (data.eventSource) {
        data.eventSource.close();
      }
      if (data.dragListeners) {
        document.removeEventListener('mousemove', data.dragListeners.move);
        document.removeEventListener('mouseup', data.dragListeners.up);
        if (data.dragListeners.touchMove) {
          document.removeEventListener('touchmove', data.dragListeners.touchMove);
          document.removeEventListener('touchend', data.dragListeners.up);
          document.removeEventListener('touchcancel', data.dragListeners.up);
        }
      }
      data.element.remove();
    }
    this.logViewerWindows.clear();

    // Clean up plan subagent windows (wizard agents)
    if (this.planSubagents) {
      for (const [agentId, windowData] of this.planSubagents) {
        if (windowData.dragListeners) {
          document.removeEventListener('mousemove', windowData.dragListeners.move);
          document.removeEventListener('mouseup', windowData.dragListeners.up);
        }
        if (windowData.element) {
          windowData.element.remove();
        }
      }
      this.planSubagents.clear();
    }

    // Clean up all image popup windows with their drag listeners
    for (const [imageId, popupData] of this.imagePopups) {
      if (popupData.dragListeners) {
        document.removeEventListener('mousemove', popupData.dragListeners.move);
        document.removeEventListener('mouseup', popupData.dragListeners.up);
        if (popupData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', popupData.dragListeners.touchMove);
          document.removeEventListener('touchend', popupData.dragListeners.up);
          document.removeEventListener('touchcancel', popupData.dragListeners.up);
        }
      }
      popupData.element.remove();
    }
    this.imagePopups.clear();

    // Clear orphaned plan generation state
    this.activePlanOrchestratorId = null;
    this._planProgressHandler = null;
    this.planGenerationStopped = true;
    if (this.planGenerationAbortController) {
      this.planGenerationAbortController.abort();
      this.planGenerationAbortController = null;
    }

    // Clean up wizard-specific timers (leak fix: not cleared on SSE reconnect)
    if (this.wizardMinimizedTimer) {
      clearInterval(this.wizardMinimizedTimer);
      this.wizardMinimizedTimer = null;
    }

    // Clean up wizard drag listeners (leak fix: document-level handlers)
    this.cleanupWizardDragging();

    // Deactivate focus trap if wizard was open (leak fix: keydown listener)
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }

    // Clean up team tasks panel drag listeners
    if (this.teamTasksDragListeners) {
      document.removeEventListener('mousemove', this.teamTasksDragListeners.move);
      document.removeEventListener('mouseup', this.teamTasksDragListeners.up);
      if (this.teamTasksDragListeners.touchMove) {
        document.removeEventListener('touchmove', this.teamTasksDragListeners.touchMove);
        document.removeEventListener('touchend', this.teamTasksDragListeners.up);
        document.removeEventListener('touchcancel', this.teamTasksDragListeners.up);
      }
      this.teamTasksDragListeners = null;
    }

    // Clear minimized agents tracking
    this.minimizedSubagents.clear();

    // Update monitor panel
    this.renderMonitorPlanAgents();

    // Update connection lines (should be empty now)
    this.updateConnectionLines();
  },

  restoreSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    const agent = this.subagents.get(agentId);

    // If window doesn't exist but agent does, recreate it
    if (!windowData && agent) {
      this.openSubagentWindow(agentId);
      return;
    }

    if (windowData) {
      const settings = this.loadAppSettingsFromStorage();
      const activeTabOnly = settings.subagentActiveTabOnly ?? true;

      // Get parent from PERSISTENT map (THE source of truth)
      const storedParent = this.subagentParentMap.get(agentId);
      const parentSessionId = storedParent || agent?.parentSessionId;

      // Determine if we should show the window
      let shouldShow = true;
      if (activeTabOnly) {
        // Only restore if the window belongs to the active session (or has no parent)
        shouldShow = !parentSessionId || parentSessionId === this.activeSessionId;
      }

      if (shouldShow) {
        windowData.element.style.display = 'flex';
        windowData.element.style.zIndex = ++this.subagentWindowZIndex;
        windowData.hidden = false;
      }
      windowData.minimized = false;
      this.updateConnectionLines();
      // Restack all visible mobile windows so restored ones don't overlap
      this.relayoutMobileSubagentWindows();
    }
  },

  // Returns drag listener references for cleanup (prevents memory leaks)
  makeWindowDraggable(win, handle) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    let dragUpdateScheduled = false;

    const startDrag = (clientX, clientY) => {
      isDragging = true;
      startX = clientX;
      startY = clientY;
      startLeft = parseInt(win.style.left) || win.getBoundingClientRect().left;
      startTop = parseInt(win.style.top) || win.getBoundingClientRect().top;
      // On drag start, switch from bottom-positioned to top-positioned so left/top work
      win.style.bottom = 'auto';
    };

    const moveDrag = (clientX, clientY) => {
      if (!isDragging) return;
      const dx = clientX - startX;
      const dy = clientY - startY;
      // Constrain to viewport bounds
      const winWidth = win.offsetWidth || 420;
      const winHeight = win.offsetHeight || 350;
      const maxX = window.innerWidth - winWidth - 4;
      const maxY = window.innerHeight - winHeight - 4;
      const newLeft = Math.max(4, Math.min(startLeft + dx, maxX));
      const newTop = Math.max(4, Math.min(startTop + dy, maxY));
      win.style.left = `${newLeft}px`;
      win.style.top = `${newTop}px`;
      // Throttle connection line updates during drag
      if (!dragUpdateScheduled) {
        dragUpdateScheduled = true;
        requestAnimationFrame(() => {
          this.updateConnectionLines();
          dragUpdateScheduled = false;
        });
      }
    };

    const endDrag = () => {
      if (isDragging) {
        isDragging = false;
        // Save position after drag ends
        this.saveSubagentWindowStates();
      }
    };

    // Mouse events
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      startDrag(e.clientX, e.clientY);
      e.preventDefault();
    });

    // Touch events
    handle.addEventListener('touchstart', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const touch = e.touches[0];
      startDrag(touch.clientX, touch.clientY);
    }, { passive: true });

    // Store references to document-level listeners so they can be removed on window close
    const moveListener = (e) => {
      moveDrag(e.clientX, e.clientY);
    };

    const touchMoveListener = (e) => {
      if (!isDragging) return;
      e.preventDefault(); // Prevent page scroll while dragging
      const touch = e.touches[0];
      moveDrag(touch.clientX, touch.clientY);
    };

    const upListener = () => {
      endDrag();
    };

    document.addEventListener('mousemove', moveListener);
    document.addEventListener('mouseup', upListener);
    document.addEventListener('touchmove', touchMoveListener, { passive: false });
    document.addEventListener('touchend', upListener);
    document.addEventListener('touchcancel', upListener);

    // Return listener references for cleanup
    return { move: moveListener, up: upListener, touchMove: touchMoveListener };
  },

  // Show subagent dropdown on hover
  showSubagentDropdown(badgeEl) {
    this.cancelHideSubagentDropdown();
    const dropdown = badgeEl.querySelector('.subagent-dropdown');
    if (!dropdown || dropdown.classList.contains('open')) return;

    // Close other dropdowns first
    document.querySelectorAll('.subagent-dropdown.open').forEach(d => {
      d.classList.remove('open', 'pinned');
      if (d.parentElement === document.body && d._originalParent) {
        d._originalParent.appendChild(d);
      }
    });

    // Move to body to escape clipping
    dropdown._originalParent = badgeEl;
    document.body.appendChild(dropdown);

    // Position below badge
    const rect = badgeEl.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom + 2}px`;
    dropdown.style.left = `${rect.left + rect.width / 2}px`;
    dropdown.style.transform = 'translateX(-50%)';
    dropdown.classList.add('open');
  },

  // Schedule hide after delay (allows moving mouse to dropdown)
  scheduleHideSubagentDropdown(badgeEl) {
    this._subagentHideTimeout = setTimeout(() => {
      const dropdown = badgeEl?.querySelector?.('.subagent-dropdown') ||
                       document.querySelector('.subagent-dropdown.open');
      if (dropdown && !dropdown.classList.contains('pinned')) {
        dropdown.classList.remove('open');
        if (dropdown._originalParent) {
          dropdown._originalParent.appendChild(dropdown);
        }
      }
    }, 150);
  },

  // Cancel scheduled hide
  cancelHideSubagentDropdown() {
    if (this._subagentHideTimeout) {
      clearTimeout(this._subagentHideTimeout);
      this._subagentHideTimeout = null;
    }
  },

  // Pin dropdown open on click (stays until clicking outside)
  pinSubagentDropdown(badgeEl) {
    const dropdown = document.querySelector('.subagent-dropdown.open');
    if (!dropdown) {
      this.showSubagentDropdown(badgeEl);
      // On mobile/touch, pin immediately so onmouseleave doesn't close it
      const openedDropdown = document.querySelector('.subagent-dropdown.open');
      if (openedDropdown) {
        openedDropdown.classList.add('pinned');
        const closeHandler = (e) => {
          if (!badgeEl.contains(e.target) && !openedDropdown.contains(e.target)) {
            openedDropdown.classList.remove('open', 'pinned');
            if (openedDropdown._originalParent) {
              openedDropdown._originalParent.appendChild(openedDropdown);
            }
            document.removeEventListener('click', closeHandler);
          }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
      }
      return;
    }
    dropdown.classList.toggle('pinned');

    if (dropdown.classList.contains('pinned')) {
      // Close on outside click
      const closeHandler = (e) => {
        if (!badgeEl.contains(e.target) && !dropdown.contains(e.target)) {
          dropdown.classList.remove('open', 'pinned');
          if (dropdown._originalParent) {
            dropdown._originalParent.appendChild(dropdown);
          }
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }
  },
});
