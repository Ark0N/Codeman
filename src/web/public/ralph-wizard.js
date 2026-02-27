/**
 * Ralph Loop Wizard — extracted from app.js for maintainability.
 * Extends CodemanApp.prototype with wizard methods.
 * Loaded after app.js in index.html.
 */

// ========== Ralph Loop Wizard ==========

Object.assign(CodemanApp.prototype, {

  showRalphWizard() {
    // Reset wizard state
    this.ralphWizardStep = 1;
    this.ralphWizardConfig = {
      taskDescription: '',
      completionPhrase: 'COMPLETE',
      maxIterations: 10,
      caseName: document.getElementById('quickStartCase')?.value || 'testcase',
      enableRespawn: false,
      generatedPlan: null,
      planGenerated: false,
      skipPlanGeneration: false,
      planDetailLevel: 'detailed',
      existingPlan: null,
      useExistingPlan: false,
    };

    // Reset UI
    document.getElementById('ralphTaskDescription').value = '';
    document.getElementById('ralphCompletionPhrase').value = 'COMPLETE';
    this.selectIterationPreset(10);
    const autoStartStep2El = document.getElementById('ralphAutoStartStep2');
    if (autoStartStep2El) autoStartStep2El.checked = false;

    // Populate case selector
    this.populateRalphCaseSelector();

    // Reset plan generation UI
    this.resetPlanGenerationUI();

    // Check for existing @fix_plan.md in selected case
    this.checkExistingFixPlan();

    // Show wizard modal
    this.updateRalphWizardUI();
    const modal = document.getElementById('ralphWizardModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.previouslyFocused = document.activeElement;
    modal.addEventListener('keydown', this.activeFocusTrap.boundHandleKeydown);

    document.getElementById('ralphTaskDescription').focus();
  },

  closeRalphWizard() {
    const modal = document.getElementById('ralphWizardModal');
    modal?.classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }

    // Cancel any in-flight plan generation
    if (this.activePlanOrchestratorId) {
      fetch('/api/cancel-plan-generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orchestratorId: this.activePlanOrchestratorId }),
      }).catch(err => console.error('[Wizard Close] Failed to cancel plan:', err));
      this.activePlanOrchestratorId = null;
    }

    // Abort any in-flight fetch request
    if (this.planGenerationAbortController) {
      this.planGenerationAbortController.abort();
      this.planGenerationAbortController = null;
    }

    this._planProgressHandler = null;

    // Clear plan loading timers
    if (this.planLoadingTimer) {
      clearInterval(this.planLoadingTimer);
      this.planLoadingTimer = null;
    }
    if (this.planPhaseTimer) {
      clearTimeout(this.planPhaseTimer);
      this.planPhaseTimer = null;
    }

    this.planGenerationStopped = true;

    // Close all plan subagent windows
    this.closePlanSubagentWindows();

    // Update monitor panel
    this.renderMonitorPlanAgents();
    this.updateConnectionLines();
  },

  populateRalphCaseSelector() {
    const select = document.getElementById('ralphCaseSelect');
    const quickStartSelect = document.getElementById('quickStartCase');

    if (quickStartSelect && select) {
      select.innerHTML = quickStartSelect.innerHTML;
      select.value = this.ralphWizardConfig.caseName;
    }
  },

  selectIterationPreset(iterations) {
    this.ralphWizardConfig.maxIterations = iterations;

    // Update button states
    document.querySelectorAll('.iteration-preset-btn').forEach(btn => {
      const btnIterations = parseInt(btn.dataset.iterations);
      btn.classList.toggle('active', btnIterations === iterations);
    });
  },

  // Check for existing @fix_plan.md in the selected case
  async checkExistingFixPlan() {
    const caseName = this.ralphWizardConfig.caseName;
    if (!caseName) return;

    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}/fix-plan`);
      const data = await res.json();

      if (data.success && data.exists && data.todos?.length > 0) {
        this.ralphWizardConfig.existingPlan = {
          todos: data.todos,
          stats: data.stats,
          content: data.content,
        };
        this.updateExistingPlanUI();
      } else {
        this.ralphWizardConfig.existingPlan = null;
        this.updateExistingPlanUI();
      }
    } catch (err) {
      console.error('Failed to check for existing plan:', err);
      this.ralphWizardConfig.existingPlan = null;
    }
  },

  // Called when case selector changes
  onRalphCaseChange() {
    const caseName = document.getElementById('ralphCaseSelect')?.value;
    if (caseName) {
      this.ralphWizardConfig.caseName = caseName;
      this.ralphWizardConfig.existingPlan = null;
      this.ralphWizardConfig.useExistingPlan = false;
      this.checkExistingFixPlan();
    }
  },

  // Update UI to show existing plan indicator
  updateExistingPlanUI() {
    const existingPlanBadge = document.getElementById('existingPlanBadge');
    const existingPlanSection = document.getElementById('existingPlanSection');
    const plan = this.ralphWizardConfig.existingPlan;

    if (existingPlanBadge) {
      if (plan) {
        const pending = plan.stats?.pending || 0;
        const total = plan.stats?.total || 0;
        existingPlanBadge.textContent = `${pending}/${total} tasks remaining`;
        existingPlanBadge.style.display = '';
      } else {
        existingPlanBadge.style.display = 'none';
      }
    }

    if (existingPlanSection) {
      if (plan) {
        const pending = plan.stats?.pending || 0;
        const completed = plan.stats?.completed || 0;
        const total = plan.stats?.total || 0;
        existingPlanSection.innerHTML = `
          <div class="existing-plan-card">
            <div class="existing-plan-header">
              <span class="existing-plan-icon">📋</span>
              <span>Existing @fix_plan.md found</span>
            </div>
            <div class="existing-plan-stats">
              <span class="stat pending">${pending} pending</span>
              <span class="stat completed">${completed} completed</span>
              <span class="stat total">${total} total</span>
            </div>
            <div class="existing-plan-actions">
              <button class="btn-toolbar btn-primary btn-sm" onclick="app.useExistingPlan()">
                Use Existing Plan
              </button>
              <button class="btn-toolbar btn-sm" onclick="app.generateNewPlan()">
                Generate New
              </button>
            </div>
          </div>
        `;
        existingPlanSection.classList.remove('hidden');
      } else {
        existingPlanSection.classList.add('hidden');
      }
    }
  },

  // Use the existing @fix_plan.md
  useExistingPlan() {
    const plan = this.ralphWizardConfig.existingPlan;
    if (!plan) return;

    // Stop any ongoing plan generation
    this.stopPlanGeneration();

    // Convert existing todos to generatedPlan format (only pending items)
    const pendingTodos = plan.todos.filter(t => t.status === 'pending' || t.status === 'in_progress');
    this.ralphWizardConfig.generatedPlan = pendingTodos.map((todo, idx) => ({
      content: todo.content,
      priority: todo.priority,
      enabled: true,
      id: `existing-${Date.now()}-${idx}`,
    }));
    this.ralphWizardConfig.planGenerated = true;
    this.ralphWizardConfig.useExistingPlan = true;
    this.ralphWizardConfig.planCost = 0; // No cost for existing plan

    this.renderPlanChecklist();
    this.updateDetailLevelButtons();
  },

  // Stop any ongoing plan generation (abort fetch, clear timers, hide spinner)
  stopPlanGeneration() {
    // Abort ongoing fetch
    if (this.planGenerationAbortController) {
      this.planGenerationAbortController.abort();
      this.planGenerationAbortController = null;
    }

    // Clear timers
    if (this.planLoadingTimer) {
      clearInterval(this.planLoadingTimer);
      this.planLoadingTimer = null;
    }
    if (this.planPhaseTimer) {
      clearInterval(this.planPhaseTimer);
      this.planPhaseTimer = null;
    }

    // Hide loading spinner
    document.getElementById('planGenerationLoading')?.classList.add('hidden');
  },

  // Generate a new plan (ignore existing)
  generateNewPlan() {
    this.ralphWizardConfig.useExistingPlan = false;
    document.getElementById('existingPlanSection')?.classList.add('hidden');
    this.generatePlan();
  },

  ralphWizardNext() {
    if (this.ralphWizardStep === 1) {
      // Validate step 1
      const taskDescription = document.getElementById('ralphTaskDescription').value.trim();
      const completionPhrase = document.getElementById('ralphCompletionPhrase').value.trim() || 'COMPLETE';
      const caseName = document.getElementById('ralphCaseSelect').value;

      if (!taskDescription) {
        this.showToast('Please enter a task description', 'error');
        document.getElementById('ralphTaskDescription').focus();
        return;
      }

      // Save config
      this.ralphWizardConfig.taskDescription = taskDescription;
      this.ralphWizardConfig.completionPhrase = completionPhrase.toUpperCase();
      this.ralphWizardConfig.caseName = caseName;

      // Move to step 2 (plan generation)
      this.ralphWizardStep = 2;
      this.updateRalphWizardUI();

      // If there's an existing plan, show option to use it; otherwise auto-start generation
      if (this.ralphWizardConfig.existingPlan) {
        this.updateExistingPlanUI();
      } else {
        this.generatePlan();
      }
    } else if (this.ralphWizardStep === 2) {
      // Must have generated or skipped plan
      if (!this.ralphWizardConfig.planGenerated && !this.ralphWizardConfig.skipPlanGeneration) {
        this.showToast('Wait for plan generation or skip', 'warning');
        return;
      }

      // Generate preview
      this.updateRalphPromptPreview();

      // Move to step 3 (launch)
      this.ralphWizardStep = 3;
      this.updateRalphWizardUI();
    }
  },

  ralphWizardBack() {
    if (this.ralphWizardStep === 3) {
      this.ralphWizardStep = 2;
      this.updateRalphWizardUI();
    } else if (this.ralphWizardStep === 2) {
      this.ralphWizardStep = 1;
      this.updateRalphWizardUI();
    }
  },

  updateRalphWizardUI() {
    const step = this.ralphWizardStep;

    // Update progress indicators
    document.querySelectorAll('.wizard-step').forEach(el => {
      const stepNum = parseInt(el.dataset.step);
      el.classList.toggle('active', stepNum === step);
      el.classList.toggle('completed', stepNum < step);
    });

    // Show/hide pages (now 3 pages)
    document.getElementById('ralphWizardStep1').classList.toggle('hidden', step !== 1);
    document.getElementById('ralphWizardStep2').classList.toggle('hidden', step !== 2);
    document.getElementById('ralphWizardStep3').classList.toggle('hidden', step !== 3);

    // Show/hide buttons
    document.getElementById('ralphBackBtn').style.display = step === 1 ? 'none' : 'block';
    document.getElementById('ralphNextBtn').style.display = step === 3 ? 'none' : 'block';
    document.getElementById('ralphStartBtn').style.display = step === 3 ? 'block' : 'none';
  },

  updateRalphPromptPreview() {
    const config = this.ralphWizardConfig;
    const preview = document.getElementById('ralphPromptPreview');
    const hasPlan = config.generatedPlan && config.generatedPlan.filter(i => i.enabled).length > 0;

    // Build the formatted prompt (abbreviated for preview)
    let prompt = config.taskDescription;
    prompt += '\n\n---\n\n';

    if (hasPlan) {
      prompt += '## Task Plan\n';
      prompt += '📋 @fix_plan.md will be created with your task items\n\n';
    }

    prompt += '## Iteration Protocol\n';
    prompt += '• Check previous work • Make progress • Commit changes\n\n';

    prompt += '## Completion Criteria\n';
    prompt += `Output \`<promise>${config.completionPhrase}</promise>\` when done\n\n`;

    prompt += '## If Stuck\n';
    prompt += 'Output `<promise>BLOCKED</promise>` with explanation';

    // Show preview with highlighting (escape first, then apply formatting)
    const escapedPrompt = this.escapeHtml(prompt);
    const highlightedPrompt = escapedPrompt
      .replace(/&lt;promise&gt;/g, '<span class="preview-highlight">&lt;promise&gt;')
      .replace(/&lt;\/promise&gt;/g, '&lt;/promise&gt;</span>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

    preview.innerHTML = highlightedPrompt;

    // Update summary
    document.getElementById('summaryPhrase').textContent = config.completionPhrase;
    document.getElementById('summaryIterations').textContent =
      config.maxIterations === 0 ? 'Unlimited' : config.maxIterations;
    document.getElementById('summaryCase').textContent = config.caseName;

    // Show plan status in summary if plan was generated
    const planSummary = document.getElementById('summaryPlan');
    if (planSummary) {
      if (config.generatedPlan && config.generatedPlan.length > 0) {
        const enabledCount = config.generatedPlan.filter(i => i.enabled).length;
        planSummary.textContent = `${enabledCount} item${enabledCount !== 1 ? 's' : ''}`;
        planSummary.parentElement.style.display = '';
      } else {
        planSummary.parentElement.style.display = 'none';
      }
    }
  },

  // ========== Plan Generation ==========

  resetPlanGenerationUI() {
    // Hide all plan generation states
    document.getElementById('existingPlanSection')?.classList.add('hidden');
    document.getElementById('planGenerationLoading')?.classList.add('hidden');
    document.getElementById('planGenerationError')?.classList.add('hidden');
    document.getElementById('planEditor')?.classList.add('hidden');

    // Reset spinner visibility (in case it was hidden after "Done!")
    const spinnerEl = document.querySelector('.plan-spinner');
    if (spinnerEl) spinnerEl.style.display = '';

    // Reset stopped indicator
    const stoppedIndicator = document.getElementById('planStoppedIndicator');
    if (stoppedIndicator) stoppedIndicator.style.display = 'none';

    // Reset existing plan badge
    const badge = document.getElementById('existingPlanBadge');
    if (badge) badge.style.display = 'none';
  },

  async generatePlan() {
    const config = this.ralphWizardConfig;
    const isDetailed = config.planDetailLevel === 'detailed';

    // Stop any existing generation first
    this.stopPlanGeneration();

    // Close old plan subagent windows and clear their state
    this.closePlanSubagentWindows();

    // Reset stopped flag to allow new SSE events
    this.planGenerationStopped = false;

    // Create abort controller for this generation
    this.planGenerationAbortController = new AbortController();

    // Show loading state, hide other sections
    document.getElementById('existingPlanSection')?.classList.add('hidden');
    document.getElementById('planGenerationError')?.classList.add('hidden');
    document.getElementById('planEditor')?.classList.add('hidden');
    document.getElementById('planGenerationLoading')?.classList.remove('hidden');

    // Different phases for detailed vs standard generation
    const standardPhases = [
      { time: 0, title: 'Starting Opus 4.5...', hint: 'Initializing deep reasoning model' },
      { time: 3, title: 'Analyzing task requirements...', hint: 'Understanding the scope and complexity' },
      { time: 8, title: 'Identifying components...', hint: 'Breaking down into modules and features' },
      { time: 15, title: 'Planning TDD approach...', hint: 'Designing test-first implementation strategy' },
      { time: 25, title: 'Generating implementation steps...', hint: 'Creating detailed action items with tests' },
      { time: 40, title: 'Adding verification checkpoints...', hint: 'Ensuring each phase has validation' },
      { time: 55, title: 'Reviewing for completeness...', hint: 'Checking all requirements are covered' },
      { time: 70, title: 'Finalizing plan...', hint: 'Organizing and prioritizing steps' },
      { time: 90, title: 'Still working...', hint: 'Complex tasks take longer - hang tight!' },
    ];

    const detailedPhases = [
      { time: 0, title: 'Starting research agent...', hint: 'Gathering external resources and codebase context' },
      { time: 30, title: 'Research agent working...', hint: 'Searching docs, GitHub repos, and analyzing codebase' },
      { time: 60, title: 'Research continuing...', hint: 'Web search and codebase exploration in progress' },
      { time: 120, title: 'Research agent deep diving...', hint: 'Complex tasks require thorough research' },
      { time: 180, title: 'Research almost complete...', hint: 'Compiling findings and recommendations' },
      { time: 300, title: 'Spawning analysis subagents...', hint: 'Starting 4 specialist agents in parallel' },
      { time: 330, title: 'Subagents analyzing...', hint: 'Requirements, Architecture, Testing, Risk analysts working' },
      { time: 400, title: 'Subagents completing...', hint: 'Collecting analysis results' },
      { time: 450, title: 'Synthesizing results...', hint: 'Merging and deduplicating items' },
      { time: 500, title: 'Running verification...', hint: 'Quality assurance and priority assignment' },
      { time: 550, title: 'Optimizing execution...', hint: 'Planning parallelization for Claude Code' },
      { time: 600, title: 'Final review...', hint: 'Holistic validation and gap detection' },
      { time: 660, title: 'Still working...', hint: 'Complex tasks take longer - hang tight!' },
    ];

    const phases = isDetailed ? detailedPhases : standardPhases;

    // Start elapsed time and phase display
    this.planLoadingStartTime = Date.now();
    const timeEl = document.getElementById('planLoadingTime');
    const titleEl = document.getElementById('planLoadingTitle');
    const hintEl = document.getElementById('planLoadingHint');

    if (timeEl) timeEl.textContent = '0s';
    if (titleEl) titleEl.textContent = phases[0].title;
    if (hintEl) hintEl.textContent = phases[0].hint;

    let currentPhaseIndex = 0;
    this.planLoadingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.planLoadingStartTime) / 1000);
      if (timeEl) timeEl.textContent = `${elapsed}s`;

      // Update phase based on elapsed time
      for (let i = phases.length - 1; i >= 0; i--) {
        if (elapsed >= phases[i].time && i > currentPhaseIndex) {
          currentPhaseIndex = i;
          if (titleEl) titleEl.textContent = phases[i].title;
          if (hintEl) hintEl.textContent = phases[i].hint;
          break;
        }
      }
    }, 1000);

    // Listen for real-time progress updates from detailed generation
    const handlePlanProgress = (event) => {
      if (event.type === 'plan:progress' && event.data) {
        const titleEl = document.getElementById('planLoadingTitle');
        const hintEl = document.getElementById('planLoadingHint');
        if (titleEl && event.data.phase) {
          const phaseLabels = {
            'research': 'Research agent working...',
            'parallel-analysis': 'Spawning analysis subagents...',
            'subagent': event.data.detail || 'Subagent working...',
            'synthesis': 'Synthesizing results...',
            'verification': 'Running verification...',
            'review-injection': 'Adding review tasks...',
            'execution-optimization': 'Optimizing for Claude Code...',
            'final-review': 'Running final review...',
          };
          titleEl.textContent = phaseLabels[event.data.phase] || event.data.phase;
        }
        if (hintEl && event.data.detail) {
          hintEl.textContent = event.data.detail;
        }
      }
    };

    // Add SSE listener for detailed mode progress
    if (isDetailed) {
      this._planProgressHandler = handlePlanProgress;
    }

    try {
      // Use different endpoint for detailed mode
      const endpoint = isDetailed ? '/api/generate-plan-detailed' : '/api/generate-plan';
      const body = isDetailed
        ? { taskDescription: config.taskDescription, caseName: config.caseName }
        : { taskDescription: config.taskDescription, detailLevel: config.planDetailLevel };

      // Retry logic for network errors
      const maxRetries = 3;
      let lastError = null;
      let data = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: this.planGenerationAbortController?.signal,
          });
          data = await res.json();
          break; // Success, exit retry loop
        } catch (fetchErr) {
          lastError = fetchErr;
          // Don't retry if aborted
          if (fetchErr.name === 'AbortError') throw fetchErr;
          // Network error - retry with exponential backoff
          console.warn(`[Plan] Fetch attempt ${attempt + 1} failed:`, fetchErr.message);
          if (attempt < maxRetries - 1) {
            const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
            const titleEl = document.getElementById('planLoadingTitle');
            const hintEl = document.getElementById('planLoadingHint');
            if (titleEl) titleEl.textContent = 'Connection lost, retrying...';
            if (hintEl) hintEl.textContent = `Attempt ${attempt + 2} of ${maxRetries} in ${delay / 1000}s`;
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }

      if (!data) {
        throw lastError || new Error('Failed to fetch after retries');
      }

      // Stop timer
      if (this.planLoadingTimer) {
        clearInterval(this.planLoadingTimer);
        this.planLoadingTimer = null;
      }

      // Remove progress handler
      this._planProgressHandler = null;

      if (!data.success) {
        this.showPlanError(data.error || 'Failed to generate plan');
        return;
      }

      if (!data.data?.items || data.data.items.length === 0) {
        this.showPlanError('No plan items generated. Try adding more detail to your task.');
        return;
      }

      // Show "Done!" with quality info for detailed mode
      const doneTitle = document.getElementById('planLoadingTitle');
      const doneHint = document.getElementById('planLoadingHint');
      const spinnerEl = document.querySelector('.plan-spinner');

      if (doneTitle) doneTitle.textContent = 'Done!';
      if (doneHint) {
        if (isDetailed && data.data.metadata?.qualityScore) {
          const quality = Math.round(data.data.metadata.qualityScore * 100);
          doneHint.textContent = `Generated ${data.data.items.length} steps (Quality: ${quality}%)`;
        } else {
          doneHint.textContent = `Generated ${data.data.items.length} steps`;
        }
      }
      if (spinnerEl) spinnerEl.style.display = 'none';

      // Brief pause to show "Done!" before showing editor
      await new Promise(r => setTimeout(r, 500));

      // Store plan with enabled state and IDs
      config.generatedPlan = data.data.items.map((item, idx) => ({
        ...item,
        enabled: true,
        id: `plan-${Date.now()}-${idx}`,
      }));
      config.planGenerated = true;
      config.skipPlanGeneration = false;
      config.planCost = data.data.costUsd || 0;

      // Store metadata for detailed mode
      if (isDetailed && data.data.metadata) {
        config.planMetadata = data.data.metadata;
      }

      // Show editor and update detail buttons
      this.renderPlanChecklist();
      this.updateDetailLevelButtons();

      // Check for auto-start
      if (this.ralphWizardConfig.autoStart) {
        console.log('[RalphWizard] Auto-start enabled, starting loop automatically...');
        this.showToast('Plan complete! Auto-starting Ralph Loop...', 'success');
        // Small delay to let user see the plan briefly
        await new Promise(r => setTimeout(r, 1500));
        this.startRalphLoop();
      }

    } catch (err) {
      // Stop timer
      if (this.planLoadingTimer) {
        clearInterval(this.planLoadingTimer);
        this.planLoadingTimer = null;
      }

      // Remove progress handler
      this._planProgressHandler = null;

      // Ignore abort errors (user cancelled, e.g., clicked "Use Existing Plan")
      if (err.name === 'AbortError') {
        console.log('Plan generation aborted by user');
        return;
      }

      console.error('Plan generation failed:', err);
      this.showPlanError('Network error: ' + err.message);
    }
  },

  setPlanDetail(level) {
    const previousLevel = this.ralphWizardConfig.planDetailLevel;
    this.ralphWizardConfig.planDetailLevel = level;
    this.updateDetailLevelButtons();

    // If plan was already generated and level changed, automatically regenerate
    if (this.ralphWizardConfig.planGenerated && previousLevel !== level) {
      const modeLabel = level === 'detailed' ? 'Enhanced (Multi-Agent)' : 'Standard';
      console.log(`[Ralph Wizard] Plan mode changed to ${modeLabel}, regenerating...`);

      // Clear current plan and regenerate
      this.ralphWizardConfig.generatedPlan = null;
      this.ralphWizardConfig.planGenerated = false;
      this.ralphWizardConfig.planMetadata = null;

      // Trigger regeneration with visual feedback
      this.generatePlan();
    }
  },

  updateDetailLevelButtons() {
    const level = this.ralphWizardConfig.planDetailLevel;
    document.querySelectorAll('.plan-detail-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.detail === level);
    });
  },

  showPlanError(message) {
    document.getElementById('planGenerationLoading')?.classList.add('hidden');
    document.getElementById('planEditor')?.classList.add('hidden');

    const errorEl = document.getElementById('planGenerationError');
    const msgEl = document.getElementById('planErrorMsg');
    const stoppedIndicator = document.getElementById('planStoppedIndicator');

    // Hide the stopped indicator for real errors, show error message
    if (stoppedIndicator) stoppedIndicator.style.display = 'none';
    if (msgEl) msgEl.textContent = message;
    errorEl?.classList.remove('hidden');
  },

  renderPlanChecklist() {
    document.getElementById('planGenerationLoading')?.classList.add('hidden');
    document.getElementById('planGenerationError')?.classList.add('hidden');
    document.getElementById('planEditor')?.classList.remove('hidden');

    // Close plan subagent windows since generation is complete
    this.closePlanSubagentWindows();

    const list = document.getElementById('planItemsList');
    if (!list) return;

    list.innerHTML = '';
    const items = this.ralphWizardConfig.generatedPlan || [];
    const cost = this.ralphWizardConfig.planCost || 0;

    // Update stats
    const statsEl = document.getElementById('planStats');
    if (statsEl) {
      const enabledCount = items.filter(i => i.enabled).length;
      statsEl.textContent = `${enabledCount}/${items.length} steps · $${cost.toFixed(3)}`;
    }

    // Render read-only checklist with DocumentFragment
    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      const row = document.createElement('div');
      let className = 'plan-item';
      if (item.priority) className += ` priority-${item.priority.toLowerCase()}`;
      if (!item.enabled) className += ' disabled';
      row.className = className;

      row.innerHTML = `
        <input type="checkbox" class="plan-item-checkbox" ${item.enabled ? 'checked' : ''}
          onchange="app.togglePlanItem(${index})">
        ${item.priority ? `<span class="plan-item-priority-badge">${item.priority}</span>` : ''}
        <span class="plan-item-text">${this.escapeHtml(item.content)}</span>
      `;
      fragment.appendChild(row);
    });
    list.appendChild(fragment);
  },

  togglePlanItem(index) {
    const plan = this.ralphWizardConfig.generatedPlan;
    if (plan && plan[index]) {
      plan[index].enabled = !plan[index].enabled;
      this.renderPlanChecklist();
    }
  },

  async cancelPlanGeneration() {
    this.stopPlanGeneration();
    this.planGenerationStopped = true; // Ignore future SSE events

    // Call the cancel API to stop server-side processing
    if (this.activePlanOrchestratorId) {
      try {
        console.log('[Cancel] Sending cancel request for', this.activePlanOrchestratorId);
        await fetch('/api/cancel-plan-generation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orchestratorId: this.activePlanOrchestratorId }),
        });
        this.activePlanOrchestratorId = null;
      } catch (err) {
        console.error('[Cancel] Failed to cancel plan generation:', err);
      }
    }

    this.showToast('Plan generation stopped', 'info');

    // Allow user to proceed without a plan by clicking Next
    this.ralphWizardConfig.skipPlanGeneration = true;

    // Show stopped state with clear visual indicator
    const errorEl = document.getElementById('planGenerationError');
    const msgEl = document.getElementById('planErrorMsg');
    const stoppedIndicator = document.getElementById('planStoppedIndicator');

    // Show the stopped indicator, hide error message since this was intentional
    if (stoppedIndicator) stoppedIndicator.style.display = 'flex';
    if (msgEl) msgEl.textContent = '';

    // Hide spinner immediately and show stopped state
    document.getElementById('planGenerationLoading')?.classList.add('hidden');
    errorEl?.classList.remove('hidden');

    // Close all plan subagent windows
    this.closePlanSubagentWindows();
  },

  // ========== Plan Subagent Windows ==========

  handlePlanSubagentEvent(event) {
    if (this.planGenerationStopped) return;

    const { type, agentId, agentType, model, status, detail, itemCount, durationMs, error } = event;

    if (type === 'started') {
      this.createPlanSubagentWindow(agentId, agentType, model, detail);
    } else if (type === 'completed' || type === 'failed') {
      this.updatePlanSubagentWindow(agentId, status, itemCount, durationMs, error);
    } else if (type === 'progress') {
      const windowData = this.planSubagents.get(agentId);
      if (windowData?.element) {
        const detailEl = windowData.element.querySelector('.plan-subagent-detail');
        if (detailEl) detailEl.textContent = detail || '';
      }
    }

    this.renderMonitorPlanAgents();
  },

  /**
   * Position a plan subagent window to the left or right of the wizard.
   * Research goes left, planner goes right.
   */
  _positionPlanSubagentWindow(agentType) {
    const wizardModal = document.getElementById('ralphWizardModal');
    const wizardContent = wizardModal?.querySelector('.modal-content');
    const wizardRect = wizardContent?.getBoundingClientRect();
    const gap = 20;
    const windowWidth = 280;

    if (!wizardRect) {
      const offset = this.planSubagents.size * 30;
      return { x: window.innerWidth - windowWidth - 50 + offset, y: 120 + offset };
    }

    const side = agentType === 'research' ? 'left' : 'right';
    let x = side === 'left'
      ? wizardRect.left - windowWidth - gap
      : wizardRect.right + gap;
    x = Math.max(10, Math.min(x, window.innerWidth - windowWidth - 10));
    const y = Math.max(60, Math.min(wizardRect.top, window.innerHeight - 120));

    return { x, y };
  },

  createPlanSubagentWindow(agentId, agentType, model, detail) {
    if (this.planSubagents.has(agentId)) return;

    const { x, y } = this._positionPlanSubagentWindow(agentType);

    const win = document.createElement('div');
    win.className = 'plan-subagent-window';
    win.id = `plan-subagent-${agentId}`;
    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
    win.style.zIndex = ++this.planSubagentWindowZIndex;

    const typeLabels = { research: 'Research Agent', planner: 'Planner' };
    const typeIcons = { research: '🔬', planner: '📋' };

    win.innerHTML = `
      <div class="plan-subagent-header">
        <span>
          <span class="plan-subagent-icon">${typeIcons[agentType] || '🤖'}</span>
          <span class="plan-subagent-title">${typeLabels[agentType] || this.escapeHtml(agentType)}</span>
        </span>
        <span class="plan-subagent-model">${model}</span>
      </div>
      <div class="plan-subagent-body">
        <div class="plan-subagent-status running">
          <span class="plan-subagent-spinner"></span>
          <span class="plan-subagent-status-text">Running...</span>
        </div>
        <div class="plan-subagent-detail">${detail || ''}</div>
      </div>
    `;

    document.body.appendChild(win);

    const header = win.querySelector('.plan-subagent-header');
    const dragListeners = this.makePlanSubagentDraggable(win, header);

    this.planSubagents.set(agentId, {
      agentId,
      type: agentType,
      model,
      status: 'running',
      startTime: Date.now(),
      element: win,
      dragListeners,
    });
  },

  makePlanSubagentDraggable(win, handle) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const mousedownHandler = (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(win.style.left) || 0;
      startTop = parseInt(win.style.top) || 0;
      win.style.zIndex = ++this.planSubagentWindowZIndex;
      e.preventDefault();
    };

    const moveHandler = (e) => {
      if (!isDragging) return;
      const newLeft = Math.max(10, Math.min(startLeft + (e.clientX - startX), window.innerWidth - 290));
      const newTop = Math.max(10, Math.min(startTop + (e.clientY - startY), window.innerHeight - 110));
      win.style.left = `${newLeft}px`;
      win.style.top = `${newTop}px`;
    };

    const upHandler = () => { isDragging = false; };

    handle.addEventListener('mousedown', mousedownHandler);
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);

    return { mousedown: mousedownHandler, move: moveHandler, up: upHandler };
  },

  updatePlanSubagentWindow(agentId, status, itemCount, durationMs, error) {
    const windowData = this.planSubagents.get(agentId);
    if (!windowData?.element) return;

    const win = windowData.element;
    const statusEl = win.querySelector('.plan-subagent-status');
    const statusTextEl = win.querySelector('.plan-subagent-status-text');
    const spinnerEl = win.querySelector('.plan-subagent-spinner');
    const detailEl = win.querySelector('.plan-subagent-detail');

    windowData.status = status;
    windowData.itemCount = itemCount;

    if (status === 'completed') {
      statusEl?.classList.remove('running');
      statusEl?.classList.add('completed');
      if (spinnerEl) spinnerEl.style.display = 'none';
      if (statusTextEl) statusTextEl.textContent = `Done (${itemCount || 0} items)`;
      if (detailEl && durationMs) detailEl.textContent = `${(durationMs / 1000).toFixed(1)}s`;
    } else if (status === 'failed' || status === 'cancelled') {
      statusEl?.classList.remove('running');
      statusEl?.classList.add('failed');
      if (spinnerEl) spinnerEl.style.display = 'none';
      if (statusTextEl) statusTextEl.textContent = status === 'cancelled' ? 'Cancelled' : 'Failed';
      if (detailEl) detailEl.textContent = error || '';
    }
  },

  closePlanSubagentWindows() {
    for (const [, windowData] of this.planSubagents) {
      if (windowData.dragListeners) {
        document.removeEventListener('mousemove', windowData.dragListeners.move);
        document.removeEventListener('mouseup', windowData.dragListeners.up);
      }
      if (windowData.element) {
        windowData.element.remove();
      }
    }
    this.planSubagents.clear();
    this.renderMonitorPlanAgents();
  },

  regeneratePlan() {
    this.ralphWizardConfig.generatedPlan = null;
    this.ralphWizardConfig.planGenerated = false;
    this.generatePlan();
  },

  generateFixPlanContent(items) {
    // Group items by priority
    const p0Items = items.filter(i => i.priority === 'P0');
    const p1Items = items.filter(i => i.priority === 'P1');
    const p2Items = items.filter(i => i.priority === 'P2');
    const noPriorityItems = items.filter(i => !i.priority);

    let content = '# Implementation Plan\n\n';
    content += `Generated: ${new Date().toISOString().slice(0, 10)}\n\n`;

    if (p0Items.length > 0) {
      content += '## Critical Path (P0)\n\n';
      p0Items.forEach(item => {
        content += `- [ ] ${item.content}\n`;
      });
      content += '\n';
    }

    if (p1Items.length > 0) {
      content += '## Standard (P1)\n\n';
      p1Items.forEach(item => {
        content += `- [ ] ${item.content}\n`;
      });
      content += '\n';
    }

    if (p2Items.length > 0) {
      content += '## Nice-to-Have (P2)\n\n';
      p2Items.forEach(item => {
        content += `- [ ] ${item.content}\n`;
      });
      content += '\n';
    }

    if (noPriorityItems.length > 0) {
      content += '## Tasks\n\n';
      noPriorityItems.forEach(item => {
        content += `- [ ] ${item.content}\n`;
      });
      content += '\n';
    }

    return content;
  },

  async startRalphLoop() {
    const config = this.ralphWizardConfig;
    config.enableRespawn = document.getElementById('ralphEnableRespawn')?.checked ?? false;
    this.closeRalphWizard();

    const enabledItems = config.generatedPlan?.filter(i => i.enabled);

    try {
      const res = await fetch('/api/ralph-loop/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName: config.caseName,
          taskDescription: config.taskDescription,
          completionPhrase: config.completionPhrase,
          maxIterations: config.maxIterations || null,
          enableRespawn: config.enableRespawn,
          planItems: enabledItems?.length ? enabledItems : undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        this.showToast(data.error || 'Failed to start', 'error');
        return;
      }
      this.ralphClosedSessions.delete(data.sessionId);
      await this.selectSession(data.sessionId);
      this.showToast(`Ralph Loop started in ${config.caseName}`, 'success');
    } catch (err) {
      console.error('Failed to start Ralph loop:', err);
      this.showToast('Failed to start Ralph loop: ' + err.message, 'error');
    }
  },

});
