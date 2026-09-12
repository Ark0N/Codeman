/**
 * @fileoverview Quick start (case loading, session spawning for Claude/Shell/OpenCode/Codex/Gemini/Antigravity/Pi/Grok/DeepSeek),
 * session options modal (per-session settings, color picker, rename),
 * session options tabs (Ralph config tab), case settings (CRUD, links),
 * create case modal, and mobile case picker.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.sessions, this.cases, this.activeSessionId)
 * @dependency constants.js (escapeHtml)
 * @dependency mobile-handlers.js (MobileDetection)
 * @loadorder 12 of 15 — loaded after panels-ui.js, before ralph-wizard.js
 */

Object.assign(CodemanApp.prototype, {
  /**
   * Build envOverrides payload from case + global settings.
   * Single source of truth for the server-side tmux setenv values.
   * Keys omitted when value is default/falsy — backend treats unset as "no override".
   */
  buildEnvOverrides(caseSettings, globalSettings) {
    const env = {};
    if (caseSettings?.agentTeams || globalSettings?.agentTeamsEnabled) {
      env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    }
    // NOTE: thinkingEffort is intentionally NOT emitted as CLAUDE_CODE_EFFORT_LEVEL —
    // the env var hard-locks effort and blocks in-session /effort switching (e.g.,
    // ultracode). It flows as the dedicated `effort` payload field instead, which the
    // backend injects as a `--settings` soft default. See getEffortSetting().
    return env;
  },

  /**
   * Resolve the effort level for new sessions from global settings.
   * Returns a valid effort string or undefined (= no override, CLI default).
   * Sent as the `effort` payload field — backend turns it into `claude --settings ...`.
   */
  getEffortSetting(globalSettings) {
    const effort = globalSettings?.thinkingEffort;
    const valid = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
    return valid.includes(effort) ? effort : undefined;
  },

  // ═══════════════════════════════════════════════════════════════
  // Quick Start
  // ═══════════════════════════════════════════════════════════════

  formatCasePickerLabel(c) {
    if (c?.location === 'remote' && c.remote?.hostId) return `${c.name} @ ${c.remote.hostId}`;
    if (c?.location === 'docker') return `${c.name} (${this.dockerCaseTag(c.docker?.hostId)})`;
    return c?.name || '';
  },

  // Short parenthetical tag for a dockerized case: '(docker)' for the default /
  // auto-provisioned host (one-click "Run in Docker", the Docker-tab 'local'
  // default, or a per-case 'q-<name>' resource-override host), otherwise the custom
  // docker host id the user named (e.g. '(gpu-box)'). Keeps the case name short.
  dockerCaseTag(hostId) {
    if (!hostId || hostId === 'default' || hostId === 'local' || /^q-/.test(hostId)) return 'docker';
    return hostId;
  },

  buildCasePickerOptions(cases = []) {
    const normalized = [];
    const seen = new Set();
    for (const c of cases) {
      if (!c?.name || seen.has(c.name)) continue;
      seen.add(c.name);
      normalized.push(c);
    }
    if (!seen.has('testcase')) {
      normalized.push({ name: 'testcase' });
    }

    return normalized
      .map(c => {
        const label = this.formatCasePickerLabel(c);
        const searchText = [
          c.name,
          label,
          c.path,
          c.location,
          c.remote?.hostId,
          c.remote?.label,
          c.remote?.path,
          c.docker?.container,
          c.docker?.image,
          c.docker?.path
        ].filter(Boolean).join(' ').toLowerCase();
        return { name: c.name, label, case: c, searchText };
      })
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
  },

  filterCasePickerOptions(options, query) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return options;
    return options.filter(option => terms.every(term => option.searchText.includes(term)));
  },

  getCasePickerOptions() {
    return this.buildCasePickerOptions(this.cases || []);
  },

  updateCasePickerInput(caseName) {
    const input = document.getElementById('quickStartCaseSearch');
    if (!input) return;
    const option = this.getCasePickerOptions().find(item => item.name === caseName);
    input.value = option?.label || caseName || 'testcase';
    input.title = option?.label || input.value;
  },

  renderQuickStartCaseSelectOptions(select, options) {
    if (!select) return;
    select.innerHTML = options
      .map(option => `<option value="${escapeHtml(option.name)}">${escapeHtml(option.label)}</option>`)
      .join('');
  },

  openCasePicker(filter = '') {
    const input = document.getElementById('quickStartCaseSearch');
    const list = document.getElementById('quickStartCaseList');
    if (!input || !list) return;
    this._casePickerOpen = true;
    this._casePickerFilter = filter;
    this._casePickerActiveIndex = 0;
    input.setAttribute('aria-expanded', 'true');
    this.renderCasePickerList();
  },

  closeCasePicker() {
    const input = document.getElementById('quickStartCaseSearch');
    const list = document.getElementById('quickStartCaseList');
    this._casePickerOpen = false;
    this._casePickerFilter = '';
    input?.setAttribute('aria-expanded', 'false');
    input?.removeAttribute('aria-activedescendant');
    list?.classList.add('hidden');
  },

  renderCasePickerList() {
    const input = document.getElementById('quickStartCaseSearch');
    const list = document.getElementById('quickStartCaseList');
    const select = document.getElementById('quickStartCase');
    if (!input || !list || !select) return;

    const options = this.filterCasePickerOptions(this.getCasePickerOptions(), this._casePickerFilter || '');
    const selectedName = select.value || 'testcase';
    const maxIndex = Math.max(0, options.length - 1);
    this._casePickerActiveIndex = Math.min(Math.max(this._casePickerActiveIndex || 0, 0), maxIndex);

    if (options.length === 0) {
      list.innerHTML = '<div class="case-combobox-empty">No cases match</div>';
      list.classList.remove('hidden');
      input.removeAttribute('aria-activedescendant');
      return;
    }

    list.innerHTML = options
      .map((option, index) => {
        const active = index === this._casePickerActiveIndex;
        const selected = option.name === selectedName;
        const id = `quickStartCaseOption-${index}`;
        return `
          <button
            type="button"
            id="${id}"
            class="case-combobox-option ${active ? 'active' : ''} ${selected ? 'selected' : ''}"
            role="option"
            aria-selected="${selected ? 'true' : 'false'}"
            data-case="${escapeHtml(option.name)}"
            title="${escapeHtml(option.label)}">
            <span class="case-combobox-check">${selected ? '✓' : ''}</span>
            <span class="case-combobox-option-label">${escapeHtml(option.label)}</span>
          </button>
        `;
      })
      .join('');
    list.classList.remove('hidden');
    input.setAttribute('aria-activedescendant', `quickStartCaseOption-${this._casePickerActiveIndex}`);
  },

  selectQuickStartCase(caseName, { save = true } = {}) {
    const select = document.getElementById('quickStartCase');
    if (!select) return;
    select.value = caseName || 'testcase';
    this.updateCasePickerInput(select.value);
    this.closeCasePicker();
    this.updateDirDisplayForCase(select.value);
    this.updateMobileCaseLabel(select.value);
    // Warm the container's CLI list HERE rather than when the run menu opens.
    // The probe is a `docker exec` round trip, so gating it on the menu meant the
    // menu painted every mode first and only narrowed a moment later — which
    // reads as "it shows all of them" and lets a mode be picked that the
    // container does not have.
    const picked = (this.cases || []).find((c) => c.name === select.value);
    if (picked?.location === 'docker') void this._probeDockerCaseModes(picked, null);
    if (save) {
      this.saveLastUsedCase(select.value);
    }
  },

  setupQuickStartCasePicker() {
    const select = document.getElementById('quickStartCase');
    const input = document.getElementById('quickStartCaseSearch');
    const list = document.getElementById('quickStartCaseList');
    const picker = document.getElementById('quickStartCasePicker');
    if (!select || !input || !list || !picker || input.dataset.listenerAdded) return;

    input.addEventListener('focus', () => {
      input.select?.();
      this.openCasePicker('');
    });
    input.addEventListener('click', () => {
      input.select?.();
      this.openCasePicker('');
    });
    input.addEventListener('input', () => {
      this.openCasePicker(input.value);
    });
    input.addEventListener('keydown', event => {
      const options = this.filterCasePickerOptions(this.getCasePickerOptions(), this._casePickerFilter || input.value);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this._casePickerActiveIndex = Math.min((this._casePickerActiveIndex || 0) + 1, Math.max(0, options.length - 1));
        this._casePickerOpen ? this.renderCasePickerList() : this.openCasePicker(input.value);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this._casePickerActiveIndex = Math.max((this._casePickerActiveIndex || 0) - 1, 0);
        this._casePickerOpen ? this.renderCasePickerList() : this.openCasePicker(input.value);
      } else if (event.key === 'Enter') {
        const option = options[this._casePickerActiveIndex || 0];
        if (option) {
          event.preventDefault();
          this.selectQuickStartCase(option.name);
          this.run?.();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.updateCasePickerInput(select.value);
        this.closeCasePicker();
      } else if (event.key === 'Tab') {
        this.updateCasePickerInput(select.value);
        this.closeCasePicker();
      }
    });
    list.addEventListener('mousedown', event => event.preventDefault());
    list.addEventListener('click', event => {
      const option = event.target.closest?.('.case-combobox-option');
      if (option?.dataset?.case) {
        this.selectQuickStartCase(option.dataset.case);
      }
    });
    if (document.addEventListener && !this._casePickerDocumentListenerAdded) {
      document.addEventListener('pointerdown', event => {
        if (!picker.contains(event.target)) {
          this.updateCasePickerInput(select.value);
          this.closeCasePicker();
        }
      });
      this._casePickerDocumentListenerAdded = true;
    }
    input.dataset.listenerAdded = 'true';
  },

  async loadQuickStartCases(selectCaseName = null, settingsPromise = null) {
    try {
      // Load settings to get lastUsedCase (reuse shared promise if provided)
      let lastUsedCase = null;
      try {
        const settings = settingsPromise ? await settingsPromise : await fetch('/api/settings').then(r => r.ok ? r.json() : null).then(env => env?.data ?? null);
        if (settings) {
          lastUsedCase = settings.lastUsedCase || null;
        }
      } catch {
        // Ignore settings load errors
      }

      const res = await fetch('/api/cases');
      const cases = (await res.json()).data;
      this.cases = cases;
      console.log('[loadQuickStartCases] Loaded cases:', cases.map(c => c.name), 'lastUsedCase:', lastUsedCase);

      const select = document.getElementById('quickStartCase');

      const options = this.getCasePickerOptions();
      this.renderQuickStartCaseSelectOptions(select, options);
      console.log('[loadQuickStartCases] Set options:', select.innerHTML.substring(0, 200));

      // If a specific case was requested, select it
      if (selectCaseName) {
        select.value = selectCaseName;
        this.updateDirDisplayForCase(selectCaseName);
        this.updateMobileCaseLabel(selectCaseName);
      } else if (lastUsedCase && cases.some(c => c.name === lastUsedCase)) {
        // Use lastUsedCase if available and exists
        select.value = lastUsedCase;
        this.updateDirDisplayForCase(lastUsedCase);
        this.updateMobileCaseLabel(lastUsedCase);
      } else if (cases.length > 0) {
        // Fallback to testcase or first case
        const firstCase = cases.find(c => c.name === 'testcase') || cases[0];
        select.value = firstCase.name;
        this.updateDirDisplayForCase(firstCase.name);
        this.updateMobileCaseLabel(firstCase.name);
      } else {
        // No cases exist yet - show the default case name as directory
        select.value = 'testcase';
        document.getElementById('dirDisplay').textContent = '~/codeman-cases/testcase';
        this.updateMobileCaseLabel('testcase');
      }
      this.updateCasePickerInput(select.value);
      this.renderCasePickerList();
      this.closeCasePicker();

      // Only add event listener once (on first load)
      if (!select.dataset.listenerAdded) {
        select.addEventListener('change', () => {
          this.updateDirDisplayForCase(select.value);
          this.saveLastUsedCase(select.value);
          this.updateMobileCaseLabel(select.value);
          this.updateCasePickerInput(select.value);
        });
        select.dataset.listenerAdded = 'true';
      }
      this.setupQuickStartCasePicker();
      // The phone overview labels rows with their case name, and a case rename or
      // link does not go through the session-tab renderer.
      this._refreshMobileOverviewIfVisible?.();
    } catch (err) {
      console.error('Failed to load cases:', err);
    }
  },

  async updateDirDisplayForCase(caseName) {
    try {
      const res = await fetch(`/api/cases/${caseName}`);
      const data = (await res.json()).data;
      if (data.path) {
        document.getElementById('dirDisplay').textContent = data.path;
        document.getElementById('dirInput').value = data.path;
      }
    } catch (err) {
      document.getElementById('dirDisplay').textContent = caseName;
    }
  },

  async saveLastUsedCase(caseName) {
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastUsedCase: caseName })
      });
    } catch (err) {
      console.error('Failed to save last used case:', err);
    }
  },

  async quickStart() {
    return this.run();
  },

  /** Ensure a newly-created session is visible without waiting for the SSE event.
   *  The POST response and session:created can arrive in either order, so the
   *  normal idempotent SSE handler remains the single state-upsert path. */
  async _ensureCreatedSessionVisible(sessionId, sessionSnapshot) {
    if (!sessionId) return;

    let session = sessionSnapshot;
    if (!session && !this.sessions?.has(sessionId)) {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to load the new session');
      session = data.data?.session || data.data;
    }

    if (session?.id) this._onSessionCreated(session);
    // session:created normally uses the debounced renderer. The direct POST path
    // needs the tab in the DOM before selectSession() marks it active.
    this._renderSessionTabsImmediate?.();
  },

  /** Run using the selected mode (Claude Code, OpenCode, Codex, Gemini, or Antigravity) */
  async run() {
    if (this._runInFlight) return;

    const startedAt = Date.now();
    const minLockMs = Number.isFinite(this._runMinLockMs) ? this._runMinLockMs : 500;
    const runBtn = document.getElementById('runBtn');
    this._runInFlight = true;
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.setAttribute('aria-busy', 'true');
    }

    try {
      const mode = this._runMode || 'claude';
      if (mode === 'opencode') {
        return await this.runOpenCode();
      }
      if (mode === 'codex') {
        return await this.runCodex();
      }
      if (mode === 'gemini') {
        return await this.runGemini();
      }
      if (mode === 'antigravity') {
        return await this.runAntigravity();
      }
      if (mode === 'omp') {
        return await this.runOmp();
      }
      if (mode === 'pi') {
        return await this.runPi();
      }
      if (mode === 'grok') {
        return await this.runGrok();
      }
      if (mode === 'deepseek') {
        return await this.runDeepSeek();
      }
      if (mode === 'shell') {
        return await this.runShell();
      }
      return await this.runClaude();
    } finally {
      const remaining = minLockMs - (Date.now() - startedAt);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      this._runInFlight = false;
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.removeAttribute('aria-busy');
      }
    }
  },

  // Note: `runMode` is an accessor defined via Object.defineProperty at the bottom of
  // this file — an object-literal getter here would be flattened to a static value by
  // Object.assign (it copies values, not accessor descriptors).

  setRunMode(mode) {
    this._runMode = mode;
    try { localStorage.setItem('codeman_runMode', mode); } catch {}
    this._applyRunMode();
    // Sync to server for cross-device persistence
    this._apiPut('/api/settings', { runMode: mode }).catch(() => {});
    // Close menu
    document.getElementById('runModeMenu')?.classList.remove('active');
  },

  toggleRunModeMenu(e) {
    e?.stopPropagation();
    const menu = document.getElementById('runModeMenu');
    if (!menu) return;
    menu.classList.toggle('active');
    // Update selected state
    menu.querySelectorAll('.run-mode-option').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.mode === this.runMode);
    });
    // Load history sessions when menu opens
    if (menu.classList.contains('active')) {
      this._loadRunModeHistory();
      this._refreshRunModeAvailability(menu);
      const close = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.classList.remove('active');
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  },

  /**
   * #201: hides run-mode dropdown entries for CLIs that aren't installed, so
   * picking one doesn't spawn a session that immediately errors out.
   *
   * Shell has no external CLI dependency and is never gated, which is also what
   * guarantees the menu is never empty. Scoped to `menu` rather than the document:
   * `.run-mode-option` is also the class the saved-dashboard rows and the history
   * rows use, and a bare querySelector would find whichever came first in the DOM.
   *
   * Antigravity and Pi are in this list even though #201 predates them — they are
   * run modes like the rest, and neither `agy` nor `pi` is likely to be installed.
   */
  _refreshRunModeAvailability(menu) {
    // A DOCKER case runs its agents INSIDE the container, so host CLI
    // availability answers the wrong question: the host may have no claude at
    // all while the container ships one, and gating on the host hides a mode
    // that would have worked. Adoption records what the container really has
    // (`availableModes`); an owned container runs our base image, which ships
    // every CLI, so an absent list means "do not gate" rather than "nothing".
    // Same source every run* path reads the selected case from.
    const caseName = document.getElementById('quickStartCase')?.value;
    const activeCase = caseName ? (this.cases || []).find((c) => c.name === caseName) : null;
    const isDocker = activeCase?.location === 'docker';
    // Prefer a LIVE probe over the value stored at attach time: a container's
    // CLIs can be installed or removed long after the case was linked, and a
    // case linked before that field existed has none at all.
    const containerModes = isDocker
      ? this._dockerCaseModes?.[caseName] || activeCase.docker?.availableModes || null
      : null;
    if (isDocker && !this._dockerCaseModes?.[caseName]) void this._probeDockerCaseModes(activeCase, menu);
    // An unreachable container hides every agent mode and explains why, instead
    // of silently offering modes that cannot start.
    //
    // ⚠️ ADOPTED cases only. For an OWNED case a missing container is the normal
    // state before the first session — the launch chain creates and starts it — so
    // reporting it as a fault hid every agent mode on a freshly linked Docker case
    // behind "start it yourself first", for a container Codeman was about to create.
    const probeError = isDocker ? this._dockerCaseProbeError?.[caseName] : null;
    for (const mode of ['claude', 'opencode', 'codex', 'gemini', 'antigravity', 'pi', 'grok', 'deepseek', 'omp']) {
      const btn = menu.querySelector(`.run-mode-option[data-mode="${mode}"]`);
      if (!btn) continue;
      let available;
      if (isDocker) available = probeError ? false : containerModes ? containerModes.includes(mode) : true;
      else available = this.isCliAvailable(mode);
      btn.style.display = available ? 'flex' : 'none';
    }
    this._renderRunModeNotice(menu, probeError);
    // DeepSeek is the one mode whose availability has two halves: `dsh` can be
    // perfectly installed while no pane-capable profile exists, because DeepSeek
    // ships no terminal front door. In that state the honest offer is "add one",
    // not a hidden entry with no explanation anywhere.
    const avail = window.__codemanCliAvailable || {};
    const dsInstall = menu.querySelector('#runModeDeepSeekInstall');
    if (dsInstall) {
      dsInstall.style.display = !avail.deepseek && avail.deepseekBinary ? 'flex' : 'none';
    }
    // The web UI needs only the BINARY: it is the one interactive surface
    // DeepSeek ships itself, so it works on a box with no terminal profile at
    // all (and is the honest thing to offer there).
    const dsWeb = menu.querySelector('#runModeDeepSeekWeb');
    if (dsWeb) dsWeb.style.display = avail.deepseekBinary ? 'flex' : 'none';
  },

  /**
   * Start the DeepSeek Harness browser UI and open it as a Codeman web tab.
   *
   * The server is a background child process owned by
   * `deepseek-web-server.ts`, NOT a shell session. It was a shell session first,
   * on the reasoning that Codeman already supervises those, and that version
   * worked - it just put a terminal tab on screen beside the web tab the user
   * actually asked for, on every click. Opening a dashboard should open one tab.
   *
   * `--trusted-host` is the load-bearing flag: dsh fences its `/api` behind a
   * browser-trust check on the request authority, and a Codeman web tab reaches
   * it through Codeman's own origin via the webview proxy, not directly. Without
   * passing Codeman's authority the page renders and every API call fails.
   *
   * The tab is saved `trusted: true`, and that is REQUIRED rather than a
   * convenience: an untrusted webview is sandboxed without `allow-same-origin`,
   * which breaks this dashboard twice over. The dsh client-runtime reads
   * `localStorage` while loading its plugins and dies there ("the document is
   * sandboxed and lacks the 'allow-same-origin' flag"), and an opaque-origin
   * frame sends `Origin: null`, so dsh's own trust check 403s every `/api` call
   * no matter which authority `--trusted-host` names. Passing `location.host`
   * only means anything once the frame actually carries that origin.
   *
   * The trade this makes is real and worth stating: a trusted proxied frame is
   * same-origin with Codeman and can therefore reach Codeman's own API. It is
   * defensible only because of what this specific dashboard already is - an
   * agent harness Codeman just started itself, on loopback, which can run code
   * as the user regardless. It is not a precedent for trusting third-party
   * dashboards generally, which is why it is set here rather than defaulted.
   */
  async runDeepSeekWeb() {
    document.getElementById('runModeMenu')?.classList.remove('active');
    const ownsLaunchTerminal = this._beginSessionLaunchStatus('Starting the DeepSeek web UI...');

    try {
      // One request, and the server owns everything behind it: picking a free
      // port, spawning, waiting for the port to answer, and reusing an already
      // running server instead of racing it. This used to start the server in a
      // shell SESSION, which worked but put a terminal tab on screen next to the
      // web tab actually asked for, every single time.
      //
      // `authority` is what dsh fences its own `/api` behind (`--trusted-host`),
      // so it must be the origin this page is loaded from rather than anything
      // the server could guess: a Codeman reachable at both loopback and a
      // tailnet name has two, and only the browser knows which one is in play.
      const startRes = await fetch('/api/deepseek/web', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authority: location.host }),
      });
      const startData = await startRes.json();
      if (!startData.success) throw new Error(startData.error || 'Failed to start the DeepSeek web UI');
      const url = startData.data.url;

      // One managed record, repointed rather than duplicated: the port is chosen
      // per launch, so creating a fresh row each time would stack a dashboard
      // per restart, each pointing at a port nothing serves any more.
      let webview = [...(this.webviews?.values() || [])].find((w) => w.managed === 'deepseek-web');
      if (webview) {
        const patchRes = await fetch(`/api/webviews/${webview.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, trusted: true }),
        });
        const patchData = await patchRes.json();
        if (!patchData.success) throw new Error(patchData.error || 'Failed to update the web tab');
        webview = patchData.data.webview || patchData.data;
      } else {
        const wvRes = await fetch('/api/webviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'DeepSeek Harness',
            url,
            icon: '\u{1F433}',
            managed: 'deepseek-web',
            trusted: true,
          }),
        });
        const wvData = await wvRes.json();
        if (!wvData.success) throw new Error(wvData.error || 'Failed to save the web tab');
        webview = wvData.data.webview || wvData.data;
      }
      // refreshWebviews, not a hopeful optional-chain: openWebview() reads
      // this.webviews and silently no-ops on an id it has not loaded, so
      // skipping the refresh made the FIRST click create the record but open
      // nothing (the SSE round-trip had not landed yet).
      await this.refreshWebviews?.();

      this._appendSessionLaunchStatus(ownsLaunchTerminal, `Serving on ${url} - opening it as a tab.`);
      if (webview?.id) await this.openWebview(webview.id);
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  /**
   * Install a DeepSeek Harness terminal profile from the run menu.
   *
   * Held open for as long as the package manager takes (the endpoint bounds it),
   * so the button reports progress rather than appearing to do nothing. On
   * success the availability map is patched in place, which is what makes the
   * real DeepSeek entry appear without a reload.
   */
  async installDeepSeekProfile() {
    const label = 'Installing a DeepSeek terminal profile (this can take a minute)...';
    const ownsLaunchTerminal = this._beginSessionLaunchStatus(label);
    try {
      const res = await fetch('/api/deepseek/install-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to install the profile');
      window.__codemanCliAvailable = { ...(window.__codemanCliAvailable || {}), deepseek: !!data.data.runnable };
      this._appendSessionLaunchStatus(ownsLaunchTerminal, `Installed ${data.data.package} into profile "${data.data.profile}".`);
      this.showToast?.(`DeepSeek profile "${data.data.profile}" installed`, 'success');
      const menu = document.getElementById('runModeMenu');
      if (menu) this._refreshRunModeAvailability(menu);
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  /**
   * One-line explanation at the top of the run menu. Only a container that could
   * not be read produces one; everything else removes it, so a stale reason can
   * never outlive the condition that caused it.
   */
  _renderRunModeNotice(menu, message) {
    if (!menu) return;
    let el = menu.querySelector('.run-mode-notice');
    if (!message) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'run-mode-notice';
      menu.prepend(el);
    }
    // Server-supplied text: set it, never parse it as markup.
    el.textContent = message;
  },

  /**
   * Ask the container which CLIs it actually has, and re-gate the menu once the
   * answer lands. Cached per case for the page's lifetime: the menu re-opens
   * often and the probe is a `docker exec` round trip.
   *
   * Best-effort by design — an unreachable daemon or a stopped container leaves
   * the cache empty, which the caller reads as "unknown" and therefore does not
   * gate. Hiding every mode because a probe failed would be worse than showing
   * one that turns out to be missing, which the launch path already refuses with
   * a specific message.
   */
  async _probeDockerCaseModes(activeCase, menu) {
    const name = activeCase?.name;
    const container = activeCase?.docker?.container;
    const hostId = activeCase?.docker?.hostId;
    if (!name || !container || !hostId) return;
    this._dockerCaseModes = this._dockerCaseModes || {};
    if (this._dockerModeProbeInFlight?.[name]) return;
    this._dockerModeProbeInFlight = this._dockerModeProbeInFlight || {};
    this._dockerModeProbeInFlight[name] = true;
    try {
      // ⚠️ _api serializes `body` and sets Content-Type itself. Passing an
      // already-stringified body double-encodes it and the server rejects a
      // JSON string where it expects an object (400 INVALID_INPUT).
      const probe = await this._apiJson('/api/docker-cases/adopt-preflight', {
        method: 'POST',
        body: { hostId, container },
      });
      if (probe?.ok && Array.isArray(probe.availableModes)) {
        this._dockerCaseModes[name] = probe.availableModes;
        delete this._dockerCaseProbeError?.[name];
      } else {
        // An ADOPTED container that cannot be probed — recreated, stopped, engine
        // down — must NOT fall through to "show everything". Offering claude on a
        // container that is not running is a click that can only fail, with the
        // reason visible nowhere. Record the reason and say it in the menu.
        //
        // ⚠️ An OWNED container gets no error: it does not exist until the first
        // session launches it, so "not found" is the expected answer for every
        // newly linked Docker case, and gating on it made those cases unusable.
        // Leaving the cache empty reads as "unknown", which does not gate.
        if (activeCase?.docker?.owned === false) {
          this._dockerCaseProbeError = this._dockerCaseProbeError || {};
          this._dockerCaseProbeError[name] = probe?.error || `Could not read container "${container}".`;
        }
        delete this._dockerCaseModes[name];
      }
      // Only repaint while the menu the user opened is still on screen.
      if (menu?.classList.contains('active')) this._refreshRunModeAvailability(menu);
    } finally {
      delete this._dockerModeProbeInFlight[name];
    }
  },

  async _loadRunModeHistory() {
    const container = document.getElementById('runModeHistory');
    if (!container) return;
    container.innerHTML = '<div class="run-mode-hist-empty">Loading...</div>';

    try {
      const display = await this._fetchHistorySessions(10);
      if (display.length === 0) {
        container.innerHTML = '<div class="run-mode-hist-empty">No history</div>';
        return;
      }

      // Build items using DOM API for reliable mobile touch handling
      container.replaceChildren();
      for (const s of display) {
        const date = new Date(s.lastModified);
        const timeStr = date.toLocaleDateString('en', { month: 'short', day: 'numeric' })
          + ' ' + date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
        // Shared helper, not a local regex: the copy that used to live here
        // matched `/home/<user>/` only, so on macOS (`/Users/<user>/`) nothing was
        // stripped and every row spent its first ~19 characters on an identical
        // prefix — with the tail ellipsized, all rows rendered as
        // `/Users/jordanryan/co…` and became indistinguishable (#273).
        const shortDir = this._shortenHomePath(s.workingDir);
        // Lead with the folder that identifies the row; the parent path trails and
        // is what gets truncated. Truncation must never eat the identity.
        const lastSlash = shortDir.lastIndexOf('/');
        const leafName = lastSlash === -1 ? shortDir : shortDir.slice(lastSlash + 1);
        // `<repo>/.claude/worktrees` in the parent path is pure noise once the pill
        // says which worktree it is — drop it so the repo stays visible instead.
        const parentDir = (lastSlash === -1 ? '' : shortDir.slice(0, lastSlash)).replace(/\/\.claude\/worktrees$/, '');

        const btn = document.createElement('button');
        btn.className = 'run-mode-option run-mode-hist-row';
        btn.title = s.workingDir;
        btn.dataset.sessionId = s.sessionId;
        btn.dataset.workingDir = s.workingDir;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'hist-name';
        nameSpan.textContent = leafName;

        const parts = [nameSpan];

        // Worktree pill, same data the session rows use (#266). A worktree's
        // directory basename is often just the worktree name, so without this two
        // worktrees of one repo still read alike.
        const wt = this._worktreeLabel ? this._worktreeLabel(s) : '';
        if (wt) {
          const wtSpan = document.createElement('span');
          wtSpan.className = 'hist-wt';
          wtSpan.textContent = wt;
          parts.push(wtSpan);
        }

        if (parentDir) {
          const dirSpan = document.createElement('span');
          dirSpan.className = 'hist-dir';
          dirSpan.textContent = parentDir;
          parts.push(dirSpan);
        }

        const metaSpan = document.createElement('span');
        metaSpan.className = 'hist-meta';
        metaSpan.textContent = timeStr;
        parts.push(metaSpan);

        btn.append(...parts);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.resumeHistorySession(s.sessionId, s.workingDir, s.name, s.mode, s.resumeId);
        });
        container.appendChild(btn);
      }
    } catch (err) {
      container.innerHTML = '<div class="run-mode-hist-empty">Failed to load</div>';
    }
  },

  _applyRunMode() {
    const mode = this.runMode;
    const runBtn = document.getElementById('runBtn');
    const gearBtn = runBtn?.nextElementSibling;
    const label = document.getElementById('runBtnLabel');
    if (runBtn) {
      runBtn.className = `btn-toolbar btn-run mode-${mode}`;
    }
    if (gearBtn) {
      gearBtn.className = `btn-toolbar btn-run-gear mode-${mode}`;
    }
    if (label) {
      label.textContent = mode === 'opencode' ? 'Run OC' : mode === 'codex' ? 'Run CX' : mode === 'gemini' ? 'Run GM' : mode === 'antigravity' ? 'Run AG' : mode === 'pi' ? 'Run PI' : mode === 'grok' ? 'Run GK' : mode === 'deepseek' ? 'Run DS' : mode === 'omp' ? 'Run OMP' : mode === 'shell' ? 'Run SH' : 'Run';
    }
  },

  /** Send Enter to the active session (phone toolbar button).
   *
   *  MUST go through xterm's onData path, NOT straight to sendInput()/the API.
   *  With local echo on (the mobile default) the characters you typed are still
   *  buffered in the LocalEchoOverlay and have NEVER reached the PTY. The onData
   *  Enter branch (terminal-ui.js) is what flushes that pending text and only
   *  then sends \r. Send a bare \r instead and you submit an empty line while the
   *  typed text stays stranded on screen — which reads as "the button does
   *  nothing". triggerDataEvent replays it exactly as if the key were pressed,
   *  so overlay flush, flushed-offset cleanup and ordering are all reused. */
  sendEnterKey() {
    if (!this.activeSessionId) return;
    const coreService = this.terminal?._core?.coreService;
    if (coreService && typeof coreService.triggerDataEvent === 'function') {
      coreService.triggerDataEvent('\r', true);
      return;
    }
    // Fallback only if xterm's private core API moves: correct when local echo
    // is off, and still better than doing nothing.
    this.sendInput('\r');
  },

  _initRunMode() {
    try { this._runMode = localStorage.getItem('codeman_runMode') || 'claude'; } catch { this._runMode = 'claude'; }
    this._applyRunMode();
  },

  // Tab count stepper functions
  incrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(20, current + 1);
  },

  decrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  },

  // Shell count stepper functions
  incrementShellCount() {
    const input = document.getElementById('shellCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(20, current + 1);
  },

  decrementShellCount() {
    const input = document.getElementById('shellCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  },

  // Next free <prefix><n> index for a case's session tabs (e.g. w1-<case>,
  // w2-<case> for agents, s1-<case> for shells), shared by the local and
  // remote/docker launch paths so all tabs follow the same naming convention.
  _nextCaseSessionStartNumber(caseName, prefix = 'w') {
    const re = new RegExp(`^${prefix}(\\d+)-([a-zA-Z0-9_-]+)`);
    let startNumber = 1;
    for (const [, session] of this.sessions || []) {
      const match = session.name && session.name.match(re);
      if (match && match[2] === caseName) {
        const num = parseInt(match[1]);
        if (num >= startNumber) startNumber = num + 1;
      }
    }
    return startNumber;
  },

  /**
   * Launch progress may use the terminal only on the session-less home screen.
   * When another session is active, mutating the shared xterm would serialize
   * launch chrome into that session's snapshot during the subsequent switch.
   */
  _beginSessionLaunchStatus(message, ansiColor = '1;32') {
    const ownsTerminal = !this.activeSessionId;
    if (ownsTerminal) {
      this.terminal.clear();
      this.terminal.writeln(`\x1b[${ansiColor}m ${message}\x1b[0m`);
      this.terminal.writeln('');
    } else {
      this.showToast?.(message, 'info');
    }
    return ownsTerminal;
  },

  _appendSessionLaunchStatus(ownsTerminal, message, ansiColor = '90') {
    if (!ownsTerminal || this.activeSessionId) return;
    this.terminal.writeln(`\x1b[${ansiColor}m ${message}\x1b[0m`);
  },

  _reportSessionLaunchError(ownsTerminal, message) {
    if (ownsTerminal && !this.activeSessionId) {
      this.terminal.writeln(`\x1b[1;31m Error: ${message}\x1b[0m`);
    } else {
      this.showToast?.(message, 'error');
    }
  },

  async runClaude() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const tabCount = Math.min(20, Math.max(1, parseInt(document.getElementById('tabCount').value) || 1));

    const ownsLaunchTerminal = this._beginSessionLaunchStatus(
      `Starting ${tabCount} Claude session(s) in ${caseName}...`
    );
    // Focus terminal NOW, in the synchronous user-gesture context (button click).
    // iOS Safari ignores programmatic focus() after any await, so this must happen
    // before the first async call. The keyboard opens here and stays open through
    // the session creation flow; selectSession at the end inherits the focus state.
    this.terminal.focus();

    try {
      // Get case path first
      const caseRes = await fetch(`/api/cases/${caseName}`);
      let caseData = (await caseRes.json())?.data ?? {};

      // Create the case if it doesn't exist
      if (!caseData.path) {
        const createCaseRes = await fetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName, description: '' })
        });
        const createCaseData = await createCaseRes.json();
        if (!createCaseData.success) throw new Error(createCaseData.error || 'Failed to create case');
        // API returns { success, data: { case: { name, path } } }
        caseData = createCaseData.data.case;
      }

      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');

      // Remote cases run over ssh — POST /api/sessions stat-validates workingDir on
      // the LOCAL fs (a remote user@host:/path never exists locally), so route them
      // through /api/quick-start, which resolves the remote case + launches via ssh.
      if (caseData.location === 'remote' || caseData.location === 'docker') {
        // Name remote/docker tabs with the same w<n>-<case> convention as local
        // sessions (quick-start would otherwise auto-generate codeman-<id>).
        const startNumber = this._nextCaseSessionStartNumber(caseName);
        // Docker (NOT remote): the App Settings Claude Model choice applies — the
        // workspace is a real host dir, so quick-start writes it to the case's
        // .claude/settings.local.json and the in-container claude reads it.
        // Remote quick-starts REJECT modelOverride (the file would land on the
        // wrong machine), so never send it there.
        let dockerModelOverride;
        if (caseData.location === 'docker') {
          const dockerGlobalSettings = this.loadAppSettingsFromStorage();
          const dockerCaseSettings = this.getCaseSettings(caseName);
          const dockerUseOpus1m = dockerCaseSettings.opusContext1m || dockerGlobalSettings.opusContext1mEnabled;
          dockerModelOverride = dockerGlobalSettings.claudeModel || (dockerUseOpus1m ? 'opus[1m]' : '');
        }
        const remoteIds = [];
        let driftHandled = false;
        for (let i = 0; i < tabCount; i++) {
          const quickStartBody = JSON.stringify({
            caseName, mode: 'claude', sessionName: `w${startNumber + i}-${caseName}`,
            ...(dockerModelOverride !== undefined ? { modelOverride: dockerModelOverride } : {})
          });
          const doQuickStart = async () => {
            const res = await fetch('/api/quick-start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: quickStartBody
            });
            return res.json();
          };
          let data = await doQuickStart();
          // Docker config drift: the host config changed since the container was
          // created (CONFLICT from quick-start). Confirm once, recreate, retry.
          if (!data.success && data.errorCode === 'CONFLICT' && caseData.location === 'docker' && !driftHandled) {
            driftHandled = true;
            const recreate = confirm(
              `Container config for "${caseName}" changed since its container was created.\n\n` +
              'Recreate the container to apply the new config? Workspace files and the ' +
              'conversation survive (the conversation resumes on launch).'
            );
            if (recreate) {
              const recRes = await fetch(`/api/docker-cases/${encodeURIComponent(caseName)}/recreate`, { method: 'POST' });
              const recData = await recRes.json();
              if (!recData.success) throw new Error(recData.error || 'Failed to recreate container');
              data = await doQuickStart();
            }
          }
          if (!data.success) throw new Error(data.error || 'Failed to start remote Claude session');
          await this._ensureCreatedSessionVisible(data.data.sessionId, data.data.session);
          remoteIds.push(data.data.sessionId);
        }
        this._appendSessionLaunchStatus(ownsLaunchTerminal, `All ${tabCount} remote session(s) ready`);
        if (remoteIds[0]) {
          await this.selectSession(remoteIds[0]);
          this.loadQuickStartCases();
        }
        this.terminal.focus();
        return;
      }

      let firstSessionId = null;

      // Find the highest existing w-number for THIS case to avoid duplicates
      const startNumber = this._nextCaseSessionStartNumber(caseName);

      // Get global Ralph tracker setting
      const ralphEnabled = this.isRalphTrackerEnabledByDefault();

      // Create all sessions in parallel for speed
      const sessionNames = [];
      for (let i = 0; i < tabCount; i++) {
        sessionNames.push(`w${startNumber + i}-${caseName}`);
      }

      // Build env overrides from global + case settings (case overrides global)
      const caseSettings = this.getCaseSettings(caseName);
      const globalSettings = this.loadAppSettingsFromStorage();
      const envOverrides = this.buildEnvOverrides(caseSettings, globalSettings);
      const hasEnvOverrides = Object.keys(envOverrides).length > 0;
      const effort = this.getEffortSetting(globalSettings);
      // Explicit Claude Model choice (App Settings) wins over the legacy 1M Opus
      // toggles; both flow as `modelOverride` → the case's .claude/settings.local.json
      const useOpus1m = caseSettings.opusContext1m || globalSettings.opusContext1mEnabled;
      const modelOverride = globalSettings.claudeModel || (useOpus1m ? 'opus[1m]' : '');

      // Step 1: Create all sessions in parallel
      this._appendSessionLaunchStatus(ownsLaunchTerminal, `Creating ${tabCount} session(s)...`);
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workingDir, name,
            ...(hasEnvOverrides ? { envOverrides } : {}),
            ...(effort ? { effort } : {}),
            ...(modelOverride !== undefined ? { modelOverride } : {}),
          })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      // Collect created session IDs
      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        await this._ensureCreatedSessionVisible(result.data.session.id, result.data.session);
        sessionIds.push(result.data.session.id);
      }
      firstSessionId = sessionIds[0];

      // Step 2: Configure Ralph for all sessions in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/ralph-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: ralphEnabled, disableAutoEnable: !ralphEnabled })
        })
      ));

      // Step 3: Start all sessions in parallel (biggest speedup)
      this._appendSessionLaunchStatus(ownsLaunchTerminal, `Starting ${tabCount} session(s) in parallel...`);
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/interactive`, { method: 'POST' })
      ));

      this._appendSessionLaunchStatus(ownsLaunchTerminal, `All ${tabCount} sessions ready`);

      // Auto-switch to the new session using selectSession (does proper refresh)
      if (firstSessionId) {
        await this.selectSession(firstSessionId);
        this.loadQuickStartCases();
      }

      this.terminal.focus();
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  /** Send Ctrl+C to the active session to stop the current operation.
   *  Requires double-tap: first tap turns button amber, second tap within 2s sends Ctrl+C. */
  stopClaude() {
    if (!this.activeSessionId) return;
    const btn = document.querySelector('.btn-toolbar.btn-stop');
    if (!btn) return;

    if (this._stopConfirmTimer) {
      // Second tap — send Ctrl+C
      clearTimeout(this._stopConfirmTimer);
      this._stopConfirmTimer = null;
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
      btn.classList.remove('confirming');
      fetch(`/api/sessions/${this.activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x03' })
      });
    } else {
      // First tap — enter confirm state
      btn.dataset.origHtml = btn.innerHTML;
      btn.textContent = 'Tap again';
      btn.classList.add('confirming');
      this._stopConfirmTimer = setTimeout(() => {
        this._stopConfirmTimer = null;
        if (btn.dataset.origHtml) {
          btn.innerHTML = btn.dataset.origHtml;
          delete btn.dataset.origHtml;
        }
        btn.classList.remove('confirming');
      }, 2000);
    }
  },

  async runShell() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const shellCount = Math.min(20, Math.max(1, parseInt(document.getElementById('shellCount').value) || 1));

    const ownsLaunchTerminal = this._beginSessionLaunchStatus(
      `Starting ${shellCount} Shell session(s) in ${caseName}...`,
      '1;33'
    );

    try {
      // Get the case path
      const caseRes = await fetch(`/api/cases/${caseName}`);
      let caseData = (await caseRes.json())?.data ?? {};

      // Create the case if it doesn't exist
      if (!caseData.path) {
        const createCaseRes = await fetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName, description: '' })
        });
        const createCaseData = await createCaseRes.json();
        if (!createCaseData.success) throw new Error(createCaseData.error || 'Failed to create case');
        // API returns { success, data: { case: { name, path } } }
        caseData = createCaseData.data.case;
      }

      const selectedCase = (this.cases || []).find(c => c.name === caseName);
      const isRemoteCase =
        caseData.location === 'remote' ||
        caseData.location === 'docker' ||
        selectedCase?.location === 'remote' ||
        selectedCase?.location === 'docker';
      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');

      // Remote cases run over ssh — route through /api/quick-start (see runClaude).
      if (caseData.location === 'remote' || caseData.location === 'docker') {
        const startNumber = this._nextCaseSessionStartNumber(caseName, 's');
        const remoteIds = [];
        for (let i = 0; i < shellCount; i++) {
          const res = await fetch('/api/quick-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ caseName, mode: 'shell', sessionName: `s${startNumber + i}-${caseName}` })
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || 'Failed to start remote shell session');
          await this._ensureCreatedSessionVisible(data.data.sessionId, data.data.session);
          remoteIds.push(data.data.sessionId);
        }
        if (remoteIds[0]) {
          // Don't pre-set activeSessionId — selectSession early-returns when the
          // IDs match, skipping the buffer load, tab activation, and focus (see runCodex).
          await this.selectSession(remoteIds[0]);
        }
        this.terminal.focus();
        return;
      }

      // Find the highest existing s-number for THIS case to avoid duplicates
      const startNumber = this._nextCaseSessionStartNumber(caseName, 's');

      // Create all shell sessions in parallel
      const sessionNames = [];
      for (let i = 0; i < shellCount; i++) {
        sessionNames.push(`s${startNumber + i}-${caseName}`);
      }

      // Step 1: Create all sessions in parallel
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(isRemoteCase ? { caseName } : { workingDir }), mode: 'shell', name })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        await this._ensureCreatedSessionVisible(result.data.session.id, result.data.session);
        sessionIds.push(result.data.session.id);
      }

      // Step 2: Start all shells in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/shell`, { method: 'POST' })
      ));

      // Step 3: Resize all in parallel (with minimum dimension enforcement)
      const dims = this.getTerminalDimensions();
      if (dims) {
        await Promise.all(sessionIds.map(id =>
          fetch(`/api/sessions/${id}/resize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dims)
          })
        ));
      }

      // Switch to first session. Don't pre-set activeSessionId — selectSession
      // early-returns when the IDs match, skipping the buffer load, tab
      // activation, and focus (see runCodex), which left the new shell tab
      // created but not shown until the user manually clicked it.
      if (sessionIds.length > 0) {
        await this.selectSession(sessionIds[0]);
      }

      this.terminal.focus();
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  async runOpenCode() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    // Remote cases run the CLI on the REMOTE host — the local /api/opencode/status
    // probe and the local-only config/env below don't apply (quick-start rejects them).
    const _runLoc = (this.cases || []).find(c => c.name === caseName)?.location;
    const isRemote = _runLoc === 'remote' || _runLoc === 'docker';

    const ownsLaunchTerminal = this._beginSessionLaunchStatus(`Starting OpenCode session in ${caseName}...`);
    // Focus in sync gesture context (see runClaude comment)
    this.terminal.focus();

    try {
      // Check if OpenCode is available (local sessions only)
      if (!isRemote) {
        const statusRes = await fetch('/api/opencode/status');
        const status = (await statusRes.json()).data;
        if (!status.available) {
          this._reportSessionLaunchError(
            ownsLaunchTerminal,
            'OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash'
          );
          return;
        }
      }

      // Quick-start with opencode mode (auto-allow tools by default).
      // No `effort` field — it's Claude-specific (OpenCode has no /effort).
      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'opencode',
          sessionName: `w${this._nextCaseSessionStartNumber(caseName)}-${caseName}`,
          ...(isRemote ? {} : {
            openCodeConfig: { autoAllowTools: true },
            ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          }),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start OpenCode');
      await this._ensureCreatedSessionVisible(data.data.sessionId, data.data.session);

      // Switch to the new session (don't pre-set activeSessionId — selectSession
      // early-returns when IDs match, skipping buffer load and sendResize)
      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  async runCodex() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    // Remote cases run Codex on the REMOTE host — skip the local status probe and the
    // local-only config/env below (quick-start rejects them for remote cases).
    const _runLoc = (this.cases || []).find(c => c.name === caseName)?.location;
    const isRemote = _runLoc === 'remote' || _runLoc === 'docker';

    const ownsLaunchTerminal = this._beginSessionLaunchStatus(`Starting Codex session in ${caseName}...`);
    this.terminal.focus();

    try {
      if (!isRemote) {
        const statusRes = await fetch('/api/codex/status');
        const status = (await statusRes.json()).data;
        if (!status.available) {
          this._reportSessionLaunchError(
            ownsLaunchTerminal,
            'Codex CLI not found. Install with: npm install -g @openai/codex'
          );
          return;
        }
      }

      const globalSettings = this.loadAppSettingsFromStorage();
      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), globalSettings);
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'codex',
          sessionName: `w${this._nextCaseSessionStartNumber(caseName)}-${caseName}`,
          ...(isRemote ? {} : {
            codexConfig: {
              dangerouslyBypassApprovals: globalSettings.codexDangerouslyBypassApprovals ?? false,
              animations: globalSettings.codexAnimationsEnabled ?? false,
              renderMode: 'hybrid',
            },
            ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          }),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start Codex');
      await this._ensureCreatedSessionVisible(data.data.sessionId, data.data.session);

      // Switch to the new session (don't pre-set activeSessionId — selectSession
      // early-returns when IDs match, skipping buffer load and sendResize)
      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  async runGemini() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    // Remote cases run Gemini on the REMOTE host — skip the local status probe and the
    // local-only config/env below (quick-start rejects them for remote cases).
    const _runLoc = (this.cases || []).find(c => c.name === caseName)?.location;
    const isRemote = _runLoc === 'remote' || _runLoc === 'docker';

    const ownsLaunchTerminal = this._beginSessionLaunchStatus(`Starting Gemini session in ${caseName}...`);
    this.terminal.focus();

    try {
      if (!isRemote) {
        const statusRes = await fetch('/api/gemini/status');
        const status = (await statusRes.json()).data;
        if (!status.available) {
          this._reportSessionLaunchError(
            ownsLaunchTerminal,
            'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'
          );
          return;
        }
      }

      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'gemini',
          sessionName: `w${this._nextCaseSessionStartNumber(caseName)}-${caseName}`,
          ...(isRemote ? {} : {
            geminiConfig: { approvalMode: 'yolo' },
            ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          }),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start Gemini');
      await this._ensureCreatedSessionVisible(data.data.sessionId, data.data.session);

      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  async runAntigravity() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    // Remote/docker cases run agy on the OTHER side — skip the local status probe and the
    // local-only config/env below (quick-start rejects them for remote cases).
    const _runLoc = (this.cases || []).find(c => c.name === caseName)?.location;
    const isRemote = _runLoc === 'remote' || _runLoc === 'docker';

    const ownsLaunchTerminal = this._beginSessionLaunchStatus(`Starting Antigravity session in ${caseName}...`);
    this.terminal.focus();

    try {
      if (!isRemote) {
        const statusRes = await fetch('/api/antigravity/status');
        const status = (await statusRes.json()).data;
        if (!status.available) {
          this._reportSessionLaunchError(
            ownsLaunchTerminal,
            'Antigravity CLI not found. Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash'
          );
          return;
        }
      }

      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'antigravity',
          sessionName: `w${this._nextCaseSessionStartNumber(caseName)}-${caseName}`,
          ...(isRemote ? {} : {
            antigravityConfig: { dangerouslySkipPermissions: true },
            ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          }),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start Antigravity');
      await this._ensureCreatedSessionVisible(data.data.sessionId, data.data.session);

      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  /**
   * Launch a Pi (pi.dev) session.
   *
   * Deliberately sends NO piConfig: pi has no permission prompts, so there is no
   * bypass to opt into, and project trust is pi's own `defaultProjectTrust`
   * decision (an interactive prompt the user answers in the terminal). Sending
   * `approveProjectTrust: true` here would silently opt every browser-launched pi
   * session into executing repo-supplied TypeScript.
   */
  async runPi() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    // Remote/docker cases run pi on the OTHER side — skip the local status probe and the
    // local-only config/env below (quick-start rejects them for remote cases).
    const _runLoc = (this.cases || []).find(c => c.name === caseName)?.location;
    const isRemote = _runLoc === 'remote' || _runLoc === 'docker';

    const ownsLaunchTerminal = this._beginSessionLaunchStatus(`Starting Pi session in ${caseName}...`);
    this.terminal.focus();

    try {
      if (!isRemote) {
        const statusRes = await fetch('/api/pi/status');
        const status = (await statusRes.json()).data;
        if (!status.available) {
          this._reportSessionLaunchError(
            ownsLaunchTerminal,
            'Pi CLI not found. Install with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent'
          );
          return;
        }
      }

      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'pi',
          sessionName: `w${this._nextCaseSessionStartNumber(caseName)}-${caseName}`,
          ...(isRemote || Object.keys(envOverrides).length === 0 ? {} : { envOverrides }),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start Pi');
      await this._ensureCreatedSessionVisible(data.data.sessionId, data.data.session);

      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  async runOmp() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    // Remote/docker cases run omp on the OTHER side — skip the local status probe
    // and the local-only config below (quick-start rejects them for remote cases).
    const _runLoc = (this.cases || []).find(c => c.name === caseName)?.location;
    const isRemote = _runLoc === 'remote' || _runLoc === 'docker';

    const ownsLaunchTerminal = this._beginSessionLaunchStatus(`Starting OMP session in ${caseName}...`);
    this.terminal.focus();

    try {
      if (!isRemote) {
        const statusRes = await fetch('/api/omp/status');
        const status = (await statusRes.json()).data;
        if (!status.available) {
          this._reportSessionLaunchError(
            ownsLaunchTerminal,
            'OMP CLI not found. Install with: curl -fsSL https://omp.sh/install | sh'
          );
          return;
        }
      }

      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'omp',
          sessionName: `w${this._nextCaseSessionStartNumber(caseName)}-${caseName}`,
          ...(isRemote ? {} : {
            ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          }),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start OMP');
      await this._ensureCreatedSessionVisible(data.data.sessionId, data.data.session);

      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  /**
   * Launch a Grok Build (xAI `grok`) session.
   *
   * Sends `grokConfig: { alwaysApprove: true }` the way runAntigravity() sends
   * `dangerouslySkipPermissions: true`: Codeman sessions exist for autonomous
   * work, so the Run button opts into grok's bypassPermissions mode
   * (`--always-approve`; config-level deny rules still apply on top). The
   * multi-user clamp forces it back off for non-granted owners server-side.
   */
  async runGrok() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    // Remote/docker cases run grok on the OTHER side: skip the local status probe and the
    // local-only config/env below (quick-start rejects them for remote cases).
    const _runLoc = (this.cases || []).find(c => c.name === caseName)?.location;
    const isRemote = _runLoc === 'remote' || _runLoc === 'docker';

    const ownsLaunchTerminal = this._beginSessionLaunchStatus(`Starting Grok session in ${caseName}...`);
    this.terminal.focus();

    try {
      if (!isRemote) {
        const statusRes = await fetch('/api/grok/status');
        const status = (await statusRes.json()).data;
        if (!status.available) {
          this._reportSessionLaunchError(
            ownsLaunchTerminal,
            'Grok CLI not found. Install with: curl -fsSL https://x.ai/cli/install.sh | bash'
          );
          return;
        }
      }

      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'grok',
          sessionName: `w${this._nextCaseSessionStartNumber(caseName)}-${caseName}`,
          ...(isRemote ? {} : {
            grokConfig: { alwaysApprove: true },
            ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          }),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start Grok');
      await this._ensureCreatedSessionVisible(data.data.sessionId, data.data.session);

      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },

  /**
   * Launch a DeepSeek Harness (`dsh`) session.
   *
   * Sends `permissionMode: 'danger-full-access'` for the same reason every
   * sibling Run button sends its bypass switch: Codeman sessions exist for
   * autonomous work. The harness has no bypass FLAG, so this rides the
   * `DSH_PERMISSION_MODE` export instead, and the multi-user clamp forces it
   * back down to `workspace-write` for non-granted owners server-side.
   *
   * `statusReporting` is left unset, i.e. ON: it is what upgrades this mode from
   * output-stabilization guessing to definitive idle/blocked hook events.
   *
   * The two-part availability check is deliberate. `dsh` being installed is not
   * enough — DeepSeek ships no terminal front door, so a box can have a perfect
   * binary and nothing a pane can run. Reporting that precisely, with the exact
   * command that fixes it, is the difference between "the Run button is broken"
   * and a 30-second fix.
   */
  async runDeepSeek() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    // Remote/docker cases run dsh on the OTHER side: skip the local status probe and the
    // local-only config/env below (quick-start rejects them for remote cases).
    const _runLoc = (this.cases || []).find(c => c.name === caseName)?.location;
    const isRemote = _runLoc === 'remote' || _runLoc === 'docker';

    const ownsLaunchTerminal = this._beginSessionLaunchStatus(`Starting DeepSeek session in ${caseName}...`);
    this.terminal.focus();

    try {
      if (!isRemote) {
        const statusRes = await fetch('/api/deepseek/status');
        const status = (await statusRes.json()).data;
        if (!status.available) {
          this._reportSessionLaunchError(
            ownsLaunchTerminal,
            'DeepSeek Harness CLI (dsh) not found. Install with: npm install -g @deepseek-ai/dsh'
          );
          return;
        }
        if (!status.runnable) {
          this._reportSessionLaunchError(
            ownsLaunchTerminal,
            'No interactive DeepSeek Harness profile is installed. DeepSeek ships only web and headless ' +
            'profiles, so the terminal agent comes from a plugin. Install one from the Run menu, or run: ' +
            'dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui'
          );
          return;
        }
      }

      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'deepseek',
          sessionName: `w${this._nextCaseSessionStartNumber(caseName)}-${caseName}`,
          ...(isRemote ? {} : {
            deepSeekConfig: { permissionMode: 'danger-full-access' },
            ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          }),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start DeepSeek');
      await this._ensureCreatedSessionVisible(data.data.sessionId, data.data.session);

      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this._reportSessionLaunchError(ownsLaunchTerminal, err.message);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Session Options Modal
  // ═══════════════════════════════════════════════════════════════

  /**
   * Per-TAB pop-out button override (Session Options → Session → Identity). The
   * general `showTabDetachButton` App Setting stays the per-device default for ALL
   * tabs; this map whitelists single sessions on top of it, so one tab can carry
   * the ⧉ button while the general toggle stays off. Per-device on purpose, like
   * the general setting: it is a display choice, so it lives in localStorage and
   * never touches the server schema. Rendered as the `tab-show-detach` class on
   * the tab (see _fullRenderSessionTabs), which styles.css exempts from the
   * global `display: none` gate; the active-tab reveal rules stay shared, so an
   * overridden tab behaves exactly like a tab under the general toggle.
   */
  _tabDetachOverrides() {
    if (this._tabDetachOverrideMap === undefined) {
      try {
        this._tabDetachOverrideMap = JSON.parse(localStorage.getItem('codeman:tab-detach-overrides') || '{}') || {};
      } catch (_e) {
        this._tabDetachOverrideMap = {};
      }
    }
    return this._tabDetachOverrideMap;
  },

  hasTabDetachOverride(sessionId) {
    return !!this._tabDetachOverrides()[sessionId];
  },

  onSessionTabDetachToggle(on) {
    const id = this.editingSessionId;
    if (!id) return;
    const map = this._tabDetachOverrides();
    if (on) map[id] = 1;
    else delete map[id];
    // Prune ids whose sessions are gone, so closed sessions cannot grow the map.
    for (const key of Object.keys(map)) {
      if (key !== id && this.sessions && !this.sessions.has(key)) delete map[key];
    }
    try {
      localStorage.setItem('codeman:tab-detach-overrides', JSON.stringify(map));
    } catch (_e) {
      /* storage full/blocked: the in-memory map still applies this page load */
    }
    // Apply to the LIVE tab directly: the debounced render may take the
    // incremental path (same session set), which patches rather than rebuilds,
    // so the template's class would only land on the next full render. Future
    // full renders re-emit it from _fullRenderSessionTabs.
    const tab = document.querySelector(`.session-tab[data-id="${CSS.escape(id)}"]`);
    if (tab) tab.classList.toggle('tab-show-detach', !!on);
  },

  openSessionOptions(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.editingSessionId = sessionId;

    // Per-tab pop-out override state (see _tabDetachOverrides above).
    const detachToggle = document.getElementById('sessionOptShowTabDetach');
    if (detachToggle) detachToggle.checked = this.hasTabDetachOverride(sessionId);

    // Reset to an appropriate tab — Summary for external CLIs (Respawn/Ralph are Claude-only)
    const isAltMode = session.mode === 'opencode' || session.mode === 'codex' || session.mode === 'gemini' || session.mode === 'antigravity' || session.mode === 'pi' || session.mode === 'grok' || session.mode === 'deepseek' || session.mode === 'omp';
    this.switchOptionsTab(isAltMode ? 'summary' : 'respawn');

    // Update respawn status display and buttons
    const respawnStatus = document.getElementById('sessionRespawnStatus');
    const enableBtn = document.getElementById('modalEnableRespawnBtn');
    const stopBtn = document.getElementById('modalStopRespawnBtn');

    if (this.respawnStatus[sessionId]) {
      respawnStatus.classList.add('active');
      respawnStatus.querySelector('.respawn-status-text').textContent =
        this.respawnStatus[sessionId].state || 'Active';
      enableBtn.style.display = 'none';
      stopBtn.style.display = '';
    } else {
      respawnStatus.classList.remove('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'Not active';
      enableBtn.style.display = '';
      stopBtn.style.display = 'none';
    }

    // Only show respawn section for claude mode sessions with a running process
    const respawnSection = document.getElementById('sessionRespawnSection');
    if (session.mode === 'claude' && session.pid) {
      respawnSection.style.display = '';
    } else {
      respawnSection.style.display = 'none';
    }

    // Hide Claude-specific options for external CLI sessions
    const isExternalCli = session.mode === 'opencode' || session.mode === 'codex' || session.mode === 'gemini' || session.mode === 'antigravity' || session.mode === 'pi' || session.mode === 'grok' || session.mode === 'deepseek' || session.mode === 'omp';
    const claudeOnlyEls = document.querySelectorAll('[data-claude-only]');
    claudeOnlyEls.forEach(el => { el.style.display = isExternalCli ? 'none' : ''; });

    // Reset duration presets to default (unlimited)
    this.selectDurationPreset('');

    // Populate respawn config from saved state
    this.loadSavedRespawnConfig(sessionId);

    // Populate auto-compact/clear from session state
    document.getElementById('modalAutoCompactEnabled').checked = session.autoCompactEnabled ?? false;
    document.getElementById('modalAutoCompactThreshold').value = session.autoCompactThreshold ?? 110000;
    document.getElementById('modalAutoCompactPrompt').value = session.autoCompactPrompt ?? '';
    document.getElementById('modalAutoClearEnabled').checked = session.autoClearEnabled ?? false;
    document.getElementById('modalAutoClearThreshold').value = session.autoClearThreshold ?? 140000;

    // Populate auto-resume on usage limit (token pause control)
    document.getElementById('modalAutoResumeEnabled').checked = session.autoResumeEnabled ?? false;
    this.updateAutoResumeStatus(sessionId);
    document.getElementById('modalImageWatcherEnabled').checked = session.imageWatcherEnabled ?? true;
    document.getElementById('modalFlickerFilterEnabled').checked = session.flickerFilterEnabled ?? false;

    // Populate session name input with prefix/suffix split
    const _modalParsed = parseSessionPrefix(session.name);
    const _prefixEl = document.getElementById('modalSessionPrefix');
    if (_modalParsed) {
      _prefixEl.textContent = _modalParsed.prefix + ': ';
      _prefixEl.style.display = '';
      document.getElementById('modalSessionName').value = _modalParsed.suffix;
      document.getElementById('modalSessionName').placeholder = 'Add description...';
    } else {
      _prefixEl.style.display = 'none';
      _prefixEl.textContent = '';
      document.getElementById('modalSessionName').value = session.name || '';
      document.getElementById('modalSessionName').placeholder = 'Auto (directory name)';
    }

    // Initialize color picker with current session color
    const currentColor = session.color || 'default';
    const colorPicker = document.getElementById('sessionColorPicker');
    colorPicker?.querySelectorAll('.color-swatch').forEach(s => {
      s.classList.toggle('selected', s.dataset.color === currentColor);
    });

    // Initialize respawn preset dropdown
    this.renderPresetDropdown();
    document.getElementById('respawnPresetSelect').value = '';
    document.getElementById('presetDescriptionHint').textContent = '';

    // Hide Ralph/Todo tab and Respawn tab for external CLI sessions (not supported)
    const ralphTabBtn = document.querySelector('#sessionOptionsModal .set-rail-item[data-tab="ralph"]');
    const respawnTabBtn = document.querySelector('#sessionOptionsModal .set-rail-item[data-tab="respawn"]');
    if (isExternalCli) {
      if (ralphTabBtn) ralphTabBtn.style.display = 'none';
      if (respawnTabBtn) respawnTabBtn.style.display = 'none';
      // Default to Context tab for external CLI sessions since Respawn is hidden
      this.switchOptionsTab('context');
    } else {
      if (ralphTabBtn) ralphTabBtn.style.display = '';
      if (respawnTabBtn) respawnTabBtn.style.display = '';
    }

    // Populate Ralph Wiggum form with current session values (skip for external CLI sessions)
    if (!isExternalCli) {
      const ralphState = this.ralphStates.get(sessionId);
      this.populateRalphForm({
        enabled: ralphState?.loop?.enabled ?? session.ralphLoop?.enabled ?? false,
        completionPhrase: ralphState?.loop?.completionPhrase || session.ralphLoop?.completionPhrase || '',
        maxIterations: ralphState?.loop?.maxIterations || session.ralphLoop?.maxIterations || 0,
        maxTodos: ralphState?.loop?.maxTodos || session.ralphLoop?.maxTodos,
        todoExpirationMinutes: ralphState?.loop?.todoExpirationMinutes || session.ralphLoop?.todoExpirationMinutes,
      });
    }

    const modal = document.getElementById('sessionOptionsModal');

    // Chips mirror their checkbox onto the label, the same way App Settings does
    // (settings-ui.js: _syncSettingsChips). Registered once per page, never per
    // open, or a long-lived tab accumulates one listener per visit.
    if (modal.dataset.chipsReady !== '1') {
      modal.dataset.chipsReady = '1';
      modal.addEventListener('change', e => {
        if (e.target?.closest?.('.set-chip')) this._syncSettingsChips();
      });
    }
    this._syncSettingsChips();

    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  },

  /**
   * Write a name the server has just confirmed into the local session map.
   *
   * Both rename surfaces re-render the tab strip from `this.sessions` right
   * after their PUT, so without this they depended on the `session:updated` SSE
   * frame to carry their own write back. On a page whose SSE stream has gone
   * quiet without erroring (a proxy that idle-closed it, a laptop resumed from
   * sleep) that frame never lands: the PUT stores the new name, the re-render
   * repaints the stale one, and the rename looks like it did nothing until a
   * full page reload. The response body is authoritative, so apply it directly.
   * The SSE frame, when it does arrive, replaces the object with the same name.
   */
  _applyLocalSessionName(sessionId, name) {
    if (typeof name !== 'string') return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.name = name;
    this.sessions.set(sessionId, session);
    // Mirrors _onSessionUpdated: subagent windows cache their parent's name.
    this.updateSubagentParentNames?.(sessionId);
  },

  /**
   * PUT a session name and return the name the server stored, or null if the
   * request failed. `_apiPut` swallows network errors into a null Response and
   * an API-level failure arrives as a non-ok status or `{success:false}`, so a
   * rename that silently did nothing has to be detected here, not thrown.
   */
  async _putSessionName(sessionId, name) {
    const res = await this._apiPut(`/api/sessions/${sessionId}/name`, { name });
    if (!res || !res.ok) return null;
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      return null;
    }
    if (payload && payload.success === false) return null;
    const confirmed = payload?.data?.name;
    return typeof confirmed === 'string' ? confirmed : name;
  },

  async saveSessionName() {
    if (!this.editingSessionId) return;
    // Captured: the modal can be closed (or switched to another session) while
    // the PUT is in flight, and the name belongs to the session that was open.
    const sessionId = this.editingSessionId;
    const session = this.sessions.get(sessionId);
    const parsed = session ? parseSessionPrefix(session.name) : null;
    const inputVal = document.getElementById('modalSessionName').value.trim();
    let name;
    if (parsed) {
      name = parsed.prefix + (inputVal ? ': ' + inputVal : '');
    } else {
      name = inputVal;
    }
    const confirmed = await this._putSessionName(sessionId, name);
    if (confirmed === null) {
      this.showToast('Failed to save session name', 'error');
      return;
    }
    this._applyLocalSessionName(sessionId, confirmed);
    this.renderSessionTabs();
  },

  async autoSaveAutoCompact() {
    if (!this.editingSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-compact`, {
        enabled: document.getElementById('modalAutoCompactEnabled').checked,
        threshold: parseInt(document.getElementById('modalAutoCompactThreshold').value) || 110000,
        prompt: document.getElementById('modalAutoCompactPrompt').value.trim() || undefined
      });
    } catch { /* silent */ }
  },

  async autoSaveAutoClear() {
    if (!this.editingSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-clear`, {
        enabled: document.getElementById('modalAutoClearEnabled').checked,
        threshold: parseInt(document.getElementById('modalAutoClearThreshold').value) || 140000
      });
    } catch { /* silent */ }
  },

  async autoSaveAutoResume() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalAutoResumeEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-resume`, { enabled });
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.autoResumeEnabled = enabled;
        if (!enabled) session.autoResumeAt = undefined;
      }
      this.updateAutoResumeStatus(this.editingSessionId);
      this.showToast(`Auto-resume on usage limit ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle auto-resume: ' + err.message, 'error');
    }
  },

  // Show "resumes at HH:MM" in the session options modal while a usage-limit
  // pause is armed for the session being edited
  updateAutoResumeStatus(sessionId) {
    const el = document.getElementById('autoResumeStatus');
    if (!el || this.editingSessionId !== sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session?.autoResumeAt && session.autoResumeAt > Date.now()) {
      const at = new Date(session.autoResumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      el.textContent = `Usage limit pause active — resumes at ${at}`;
      el.classList.add('active');
    } else {
      el.textContent = '';
      el.classList.remove('active');
    }
  },

  async toggleSessionImageWatcher() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalImageWatcherEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/image-watcher`, { enabled });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.imageWatcherEnabled = enabled;
      }
      this.showToast(`Image watcher ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle image watcher', 'error');
    }
  },

  async toggleFlickerFilter() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalFlickerFilterEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/flicker-filter`, { enabled });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.flickerFilterEnabled = enabled;
      }
      this.showToast(`Flicker filter ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle flicker filter', 'error');
    }
  },

  async autoSaveRespawnConfig() {
    if (!this.editingSessionId) return;
    const config = {
      updatePrompt: document.getElementById('modalRespawnPrompt').value,
      sendClear: document.getElementById('modalRespawnSendClear').checked,
      sendInit: document.getElementById('modalRespawnSendInit').checked,
      kickstartPrompt: document.getElementById('modalRespawnKickstart').value.trim() || undefined,
      autoAcceptPrompts: document.getElementById('modalRespawnAutoAccept').checked,
    };
    try {
      await this._apiPut(`/api/sessions/${this.editingSessionId}/respawn/config`, config);
    } catch {
      // Silent save - don't interrupt user
    }
  },

  async loadSavedRespawnConfig(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/respawn/config`);
      const data = await res.json();
      if (data.success && data.data && data.data.config) {
        const c = data.data.config;
        document.getElementById('modalRespawnPrompt').value = c.updatePrompt || 'update all the docs and CLAUDE.md';
        document.getElementById('modalRespawnSendClear').checked = c.sendClear ?? true;
        document.getElementById('modalRespawnSendInit').checked = c.sendInit ?? true;
        document.getElementById('modalRespawnKickstart').value = c.kickstartPrompt || '';
        document.getElementById('modalRespawnAutoAccept').checked = c.autoAcceptPrompts ?? true;
        // Restore duration if set
        if (c.durationMinutes) {
          const presetBtn = document.querySelector(`.duration-preset-btn[data-minutes="${c.durationMinutes}"]`);
          if (presetBtn) {
            this.selectDurationPreset(String(c.durationMinutes));
          } else {
            this.selectDurationPreset('custom');
            document.getElementById('modalRespawnDuration').value = c.durationMinutes;
          }
        }
      }
    } catch {
      // Ignore - use defaults
    }
  },

  // Handle duration preset selection
  selectDurationPreset(value) {
    // Remove active from all buttons
    document.querySelectorAll('.duration-preset-btn').forEach(btn => btn.classList.remove('active'));

    // Find and activate the clicked button
    const btn = document.querySelector(`.duration-preset-btn[data-minutes="${value}"]`);
    if (btn) btn.classList.add('active');

    // Show/hide custom input
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (value === 'custom') {
      customInput.classList.add('visible');
      durationInput.focus();
    } else {
      customInput.classList.remove('visible');
      durationInput.value = ''; // Clear custom value when using preset
    }
  },

  // Get selected duration from preset buttons or custom input
  getSelectedDuration() {
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (customInput.classList.contains('visible')) {
      // Custom mode - use input value
      return durationInput.value ? parseInt(durationInput.value) : null;
    } else {
      // Preset mode - get from active button
      const activeBtn = document.querySelector('.duration-preset-btn.active');
      const minutes = activeBtn?.dataset.minutes;
      return minutes ? parseInt(minutes) : null;
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Session Options Modal Tabs
  // ═══════════════════════════════════════════════════════════════

  /**
   * Show one section of the Session Options modal.
   *
   * The chrome is the shared `set-*` settings surface, but unlike App Settings
   * (whose rail is a table of contents over one scrolling document) this rail
   * is a real switcher: exactly one `.set-section` is visible and the rest
   * carry `.hidden`. Summary owns its own scroller and Respawn is long, so
   * stacking them into a single document would bury both.
   */
  switchOptionsTab(tabName) {
    // Toggle active class on rail entries
    document.querySelectorAll('#sessionOptionsModal .set-rail-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Toggle hidden class on the sections
    document.getElementById('respawn-tab').classList.toggle('hidden', tabName !== 'respawn');
    document.getElementById('context-tab').classList.toggle('hidden', tabName !== 'context');
    document.getElementById('ralph-tab').classList.toggle('hidden', tabName !== 'ralph');
    document.getElementById('summary-tab').classList.toggle('hidden', tabName !== 'summary');

    // A switched-to section starts at its own top, not at the scroll offset the
    // previous one was left at.
    const doc = document.getElementById('sessionOptionsDoc');
    if (doc) doc.scrollTop = 0;

    // Load run summary data when switching to summary tab
    if (tabName === 'summary' && this.editingSessionId) {
      this.loadRunSummary(this.editingSessionId);
    }
  },

  getRalphConfig() {
    return {
      enabled: document.getElementById('modalRalphEnabled').checked,
      completionPhrase: document.getElementById('modalRalphPhrase').value.trim(),
      maxIterations: parseInt(document.getElementById('modalRalphMaxIterations').value) || 0,
      maxTodos: parseInt(document.getElementById('modalRalphMaxTodos').value) || 50,
      todoExpirationMinutes: parseInt(document.getElementById('modalRalphTodoExpiration').value) || 60
    };
  },

  populateRalphForm(config) {
    document.getElementById('modalRalphEnabled').checked = config?.enabled ?? false;
    document.getElementById('modalRalphPhrase').value = config?.completionPhrase || '';
    document.getElementById('modalRalphMaxIterations').value = config?.maxIterations || 0;
    document.getElementById('modalRalphMaxTodos').value = config?.maxTodos || 50;
    document.getElementById('modalRalphTodoExpiration').value = config?.todoExpirationMinutes || 60;
  },

  async saveRalphConfig() {
    if (!this.editingSessionId) {
      this.showToast('No session selected', 'warning');
      return;
    }

    const config = this.getRalphConfig();

    // If user is enabling Ralph, clear from closed set
    if (config.enabled) {
      this.ralphClosedSessions.delete(this.editingSessionId);
    }

    try {
      const res = await fetch(`/api/sessions/${this.editingSessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      this.showToast('Ralph config saved', 'success');
    } catch (err) {
      this.showToast('Failed to save Ralph config: ' + err.message, 'error');
    }
  },

  // Inline rename on right-click
  startInlineRename(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this._activeRename?.cancel();

    const tabName = document.querySelector(`.tab-name[data-session-id="${sessionId}"]`);
    if (!tabName) return;

    // Prevent tab re-renders from destroying the input while renaming
    this._inlineRenameActive = true;
    tabName.classList.add('tab-name-renaming');

    const currentName = this.getSessionName(session);
    const parsed = parseSessionPrefix(session.name);
    const originalContent = tabName.textContent;
    const originalChildren = [...tabName.childNodes].map((node) => node.cloneNode(true));
    const restoreOriginalChildren = () => {
      tabName.replaceChildren(...originalChildren.map((node) => node.cloneNode(true)));
    };
    // Clear existing content to make room for the input element
    tabName.textContent = '';
    while (tabName.firstChild) tabName.removeChild(tabName.firstChild);

    // If prefix detected, show it as non-editable label
    if (parsed) {
      const prefixLabel = document.createElement('span');
      prefixLabel.className = 'tab-rename-prefix';
      prefixLabel.textContent = parsed.prefix + ': ';
      prefixLabel.style.cssText = 'color: var(--text-muted); font-size: 0.75rem; white-space: nowrap;';
      tabName.appendChild(prefixLabel);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.value = parsed ? parsed.suffix : (session.name || '');
    input.placeholder = parsed ? 'Add description...' : currentName;
    input.className = 'tab-rename-input';
    // 80px is tuned for the narrow header tab; a full-width sidebar row can and
    // should give the whole line to the input.
    const renameWidth = tabName.closest('.tab-rail') ? 'auto' : this.isSessionSidebarActive?.() ? '100%' : '80px';
    input.style.cssText = `width: ${renameWidth}; min-width: 0; font-size: 0.75rem; padding: 2px 4px; background: var(--bg-input); border: 1px solid var(--accent); border-radius: 3px; color: var(--text); outline: none;`;

    tabName.appendChild(input);
    input.focus();
    input.select();

    let editSettled = false;
    let invalidated = false;
    let completed = false;

    const releaseRenderGuard = () => {
      if (this._activeRename !== renameHandle) return;
      this._inlineRenameActive = false;
    };

    const completeCurrentRename = () => {
      if (this._activeRename !== renameHandle) return;
      completed = true;
      releaseRenderGuard();
      this._activeRename = null;
      this.renderSessionTabs();
    };

    const cancelRename = () => {
      if (invalidated || completed) return;
      invalidated = true;
      editSettled = true;
      tabName.classList.remove('tab-name-renaming');
      restoreOriginalChildren();
      completeCurrentRename();
    };

    const finishRename = async ({ commit }) => {
      if (editSettled || invalidated) return;
      editSettled = true;
      tabName.classList.remove('tab-name-renaming');

      // Aborted (e.g. the session was deleted mid-rename, or Escape): re-render
      // so any ghost DOM is replaced with the canonical tab list, and skip the
      // API call — a cancel must not fire a stale rename PUT.
      if (!commit) {
        cancelRename();
        return;
      }

      if (this._activeRename !== renameHandle) return;
      releaseRenderGuard();

      const suffix = input.value.trim();
      const fullName = parsed ? parsed.prefix + (suffix ? ': ' + suffix : '') : suffix;
      if (fullName === session.name) restoreOriginalChildren();
      else tabName.textContent = fullName || originalContent;

      // Skip the API call if the session vanished between focus and blur.
      const stillExists = this.sessions.has(sessionId);
      if (stillExists && fullName !== session.name) {
        const confirmed = await this._putSessionName(sessionId, fullName);
        if (invalidated || this._activeRename !== renameHandle || !this.sessions.has(sessionId)) return;
        if (confirmed === null) {
          restoreOriginalChildren();
          this.showToast('Failed to rename', 'error');
        } else {
          // The re-render below repaints from this.sessions, so the new name has
          // to be in the map before it runs (see _applyLocalSessionName()).
          this._applyLocalSessionName(sessionId, confirmed);
        }
      }
      // Re-render tabs to restore full tab structure
      completeCurrentRename();
    };

    // Register only after the input is wired so a throw above can't strand state.
    const renameHandle = {
      sessionId,
      cancel: cancelRename,
    };
    this._activeRename = renameHandle;

    input.addEventListener('blur', () => finishRename({ commit: true }));
    input.addEventListener('keydown', (e) => {
      // Enter/Escape during IME composition belong to the IME (e.g. confirming
      // a Chinese pinyin candidate). keyCode 229 is the legacy signal for the
      // same condition on browsers that don't set isComposing reliably.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        // Cancel, never commit. This used to clear the field and blur, and the
        // blur handler commits — so Escape RENAMED the session to an empty
        // string (measured: the tab fell back to its folder name and the server
        // stored ""), in every layout. cancelRename() marks the edit
        // invalidated, so the blur that follows the input's removal is a no-op.
        e.preventDefault();
        cancelRename();
      }
    });
  },


  // ═══════════════════════════════════════════════════════════════
  // Case Settings
  // ═══════════════════════════════════════════════════════════════

  toggleCaseSettings() {
    const popover = document.getElementById('caseSettingsPopover');
    if (popover.classList.contains('hidden')) {
      // Load settings for current case
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeams').checked = settings.agentTeams;
      document.getElementById('caseOpusContext1m').checked = settings.opusContext1m;
      popover.classList.remove('hidden');

      // Close on outside click (one-shot listener)
      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      // Defer to avoid catching the current click
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  },

  getCaseSettings(caseName) {
    try {
      const stored = localStorage.getItem('caseSettings_' + caseName);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return { agentTeams: false, opusContext1m: true };
  },

  saveCaseSettings(caseName, settings) {
    localStorage.setItem('caseSettings_' + caseName, JSON.stringify(settings));
  },

  onCaseSettingChanged() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeams').checked;
    settings.opusContext1m = document.getElementById('caseOpusContext1m').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync mobile checkboxes
    const mobileCheckbox = document.getElementById('caseAgentTeamsMobile');
    if (mobileCheckbox) mobileCheckbox.checked = settings.agentTeams;
    const mobileOpusCheckbox = document.getElementById('caseOpusContext1mMobile');
    if (mobileOpusCheckbox) mobileOpusCheckbox.checked = settings.opusContext1m;
  },

  toggleCaseSettingsMobile() {
    const popover = document.getElementById('caseSettingsPopoverMobile');
    if (popover.classList.contains('hidden')) {
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeamsMobile').checked = settings.agentTeams;
      document.getElementById('caseOpusContext1mMobile').checked = settings.opusContext1m;
      popover.classList.remove('hidden');

      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings-mobile')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  },

  onCaseSettingChangedMobile() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeamsMobile').checked;
    settings.opusContext1m = document.getElementById('caseOpusContext1mMobile').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync desktop checkboxes
    const desktopCheckbox = document.getElementById('caseAgentTeams');
    if (desktopCheckbox) desktopCheckbox.checked = settings.agentTeams;
    const desktopOpusCheckbox = document.getElementById('caseOpusContext1m');
    if (desktopOpusCheckbox) desktopOpusCheckbox.checked = settings.opusContext1m;
  },

  // ═══════════════════════════════════════════════════════════════
  // Create Case Modal
  // ═══════════════════════════════════════════════════════════════

  showCreateCaseModal() {
    document.getElementById('newCaseName').value = '';
    document.getElementById('newCaseDescription').value = '';
    document.getElementById('linkCaseName').value = '';
    document.getElementById('linkCasePath').value = '';
    const remoteFields = [
      'remoteCaseName',
      'remoteCasePath',
      'remoteHostId',
      'remoteHostAddress',
      'remoteHostUsername',
      'remoteHostPort',
      'remoteHostCodexCommand',
      'remoteHostIdentityFile',
      'remoteHostSocksProxy',
      'remoteHostJumpHost',
      'remoteHostExtraSshOptions',
    ];
    remoteFields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    this._resetCloneForm();
    // Cloning needs git ON THE SERVER: hide the whole tab rather than let it fail
    // at submit. Unknown reads as available (isCliAvailable's rule).
    const cloneTabBtn = document.getElementById('caseCloneTabBtn');
    if (cloneTabBtn) cloneTabBtn.style.display = this.isCliAvailable('git') ? '' : 'none';
    // Reset to first tab
    this.caseModalTab = 'case-create';
    this.switchCaseModalTab('case-create');
    // Wire up tab buttons
    const modal = document.getElementById('createCaseModal');
    modal.querySelectorAll('.set-rail-item').forEach(btn => {
      btn.onclick = () => this.switchCaseModalTab(btn.dataset.tab);
    });
    // Adopt-an-existing-container toggle + its read-only preflight. Assigned (not
    // addEventListener) so reopening the modal cannot stack duplicate handlers,
    // matching the rail wiring right above.
    const adoptToggle = document.getElementById('dockerAdoptExisting');
    if (adoptToggle) adoptToggle.onchange = () => this._syncDockerAdoptMode();
    const adoptCheck = document.getElementById('dockerAdoptCheckBtn');
    if (adoptCheck) adoptCheck.onclick = () => this._dockerAdoptPreflight();
    const adoptJump = document.getElementById('dockerAdoptJumpBtn');
    if (adoptJump) adoptJump.onclick = () => this.jumpToDockerAdopt();
    // Containers come from the host profile, so switching Host ID invalidates the
    // suggestions. Dropping the marker (rather than refetching here) keeps the
    // fetch lazy — it happens when adopt mode is actually on.
    const hostIdInput = document.getElementById('dockerHostId');
    if (hostIdInput) {
      hostIdInput.onchange = () => {
        delete document.getElementById('dockerContainerList')?.dataset.loadedFor;
        if (document.getElementById('dockerAdoptExisting')?.checked) void this._loadDockerContainerOptions();
      };
    }
    // A fresh open re-reads the engine: containers start and stop between visits.
    delete document.getElementById('dockerContainerList')?.dataset.loadedFor;
    this._syncDockerAdoptMode();
    // Scroll-into-view on focus for mobile keyboard visibility
    modal.querySelectorAll('input[type="text"]').forEach(input => {
      if (!input._mobileScrollWired) {
        input._mobileScrollWired = true;
        input.addEventListener('focus', () => {
          if (window.innerWidth <= 430) {
            setTimeout(() => input.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
          }
        });
      }
    });
    modal.classList.add('active');
    document.getElementById('newCaseName').focus();
  },

  switchCaseModalTab(tabName) {
    this.caseModalTab = tabName;
    const modal = document.getElementById('createCaseModal');
    // Toggle active class on rail entries
    modal.querySelectorAll('.set-rail-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // Toggle hidden class on the panels
    modal.querySelectorAll('.set-section').forEach(content => {
      content.classList.toggle('hidden', content.id !== tabName);
    });
    // A switched-to panel starts at its own top.
    const doc = document.getElementById('createCaseDoc');
    if (doc) doc.scrollTop = 0;
    // Update submit buttons (hide for manage tab). Two of them: mobile.css hides
    // this modal's .set-foot, so phones submit through the header button instead.
    const submitBtns = ['caseModalSubmit', 'caseModalSubmitMobile']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (tabName === 'case-manage') {
      submitBtns.forEach((btn) => {
        btn.style.display = 'none';
      });
      this.renderCaseManageList();
      this.refreshDockerExports();
    } else {
      const label =
        tabName === 'case-create'
          ? 'Create'
          : tabName === 'case-clone'
            ? 'Clone'
            : tabName === 'case-remote'
              ? 'Link Remote'
              : tabName === 'case-docker'
                ? 'Link Docker'
                : 'Link';
      submitBtns.forEach((btn) => {
        btn.style.display = '';
        btn.textContent = label;
      });
    }
    // Focus appropriate input
    if (tabName === 'case-create') {
      document.getElementById('newCaseName').focus();
    } else if (tabName === 'case-clone') {
      document.getElementById('cloneRepoUrl').focus();
    } else if (tabName === 'case-link') {
      document.getElementById('linkCaseName').focus();
    } else if (tabName === 'case-remote') {
      document.getElementById('remoteCaseName').focus();
    } else if (tabName === 'case-docker') {
      document.getElementById('dockerCaseName').focus();
    }
  },

  closeCreateCaseModal() {
    document.getElementById('createCaseModal').classList.remove('active');
  },

  async submitCaseModal() {
    // Both submit buttons move together: whichever one the user pressed, the
    // other must show the same pending state and be equally unclickable.
    const btns = ['caseModalSubmit', 'caseModalSubmitMobile'].map((id) => document.getElementById(id)).filter(Boolean);
    const originalText = btns.map((btn) => btn.textContent);
    const pendingText =
      this.caseModalTab === 'case-create' ? 'Creating...' : this.caseModalTab === 'case-clone' ? 'Cloning...' : 'Linking...';
    // A clone holds this request open for minutes; without disabling the button a
    // second click fires a second clone (the loser then fails on ALREADY_EXISTS).
    btns.forEach((btn) => {
      btn.classList.add('loading');
      btn.textContent = pendingText;
      btn.disabled = true;
    });
    try {
      if (this.caseModalTab === 'case-create') {
        await this.createCase();
      } else if (this.caseModalTab === 'case-clone') {
        await this.cloneCase();
      } else if (this.caseModalTab === 'case-remote') {
        await this.linkRemoteCase();
      } else if (this.caseModalTab === 'case-docker') {
        await this.linkDockerCase();
      } else {
        await this.linkCase();
      }
    } finally {
      btns.forEach((btn, index) => {
        btn.classList.remove('loading');
        btn.disabled = false;
        btn.textContent = originalText[index];
      });
    }
  },

  async createCase() {
    const name = document.getElementById('newCaseName').value.trim();
    const description = document.getElementById('newCaseDescription').value.trim();

    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    // One-click "Run in Docker": create the case folder AND a container, then start
    // a session inside it. Optional expandable settings override the defaults.
    const inDocker = document.getElementById('newCaseDocker')?.checked;
    const endpoint = inDocker ? '/api/cases/docker-quickcreate' : '/api/cases';
    const payload = inDocker
      ? { name, description, ...this._collectDockerQuickSettings() }
      : { name, description };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
        if (inDocker) {
          const caps = data.data?.capsEnforced === false ? ' (resource caps advisory on this engine)' : '';
          this.showToast(`Docker case "${name}" created${caps} — starting session…`, 'success');
          // Start a session INSIDE the container (routes through quick-start).
          await this.runClaude();
        } else {
          this.showToast(`Case "${name}" created`, 'success');
        }
      } else {
        this.showToast(data.error || 'Failed to create case', 'error');
      }
    } catch (err) {
      console.error('Failed to create case:', err);
      this.showToast('Failed to create case: ' + err.message, 'error');
    }
  },

  // Fill the memory/cpu/gpu fields from a resource template. `medium` clears them so
  // the server uses its defaults (no per-case host); `custom` leaves them editable.
  applyDockerTemplate() {
    const t = document.getElementById('quickDockerTemplate')?.value;
    const presets = {
      small: { m: '2g', c: '1', g: '' },
      medium: { m: '', c: '', g: '' },
      large: { m: '8g', c: '4', g: '' },
      gpu: { m: '8g', c: '4', g: 'all' },
    };
    const p = presets[t];
    if (!p) return; // 'custom' — leave fields as-is
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v;
    };
    set('quickDockerMemory', p.m);
    set('quickDockerCpus', p.c);
    set('quickDockerGpus', p.g);
  },

  // Collect only the non-default docker overrides (empty fields fall back to defaults
  // server-side; sent as undefined, never null, per the Zod .optional() gotcha).
  _collectDockerQuickSettings() {
    const val = (id) => (document.getElementById(id)?.value || '').trim();
    const o = {};
    const mem = val('quickDockerMemory');
    if (mem) o.memory = mem;
    const cpus = val('quickDockerCpus');
    if (cpus) o.cpus = cpus;
    const gpus = val('quickDockerGpus');
    if (gpus && gpus.toLowerCase() !== 'none') o.gpus = gpus;
    const net = document.getElementById('quickDockerNetwork')?.value;
    if (net && net !== 'bridge') o.network = net;
    const img = val('quickDockerImage');
    if (img) o.image = img;
    const mc = document.getElementById('quickDockerMountCreds');
    if (mc && !mc.checked) o.mountCredentials = false;
    return o;
  },

  async linkCase() {
    const name = document.getElementById('linkCaseName').value.trim();
    const path = document.getElementById('linkCasePath').value.trim();

    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    if (!path) {
      this.showToast('Please enter a folder path', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Case "${name}" linked to ${path}`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to link case', 'error');
      }
    } catch (err) {
      console.error('Failed to link case:', err);
      this.showToast('Failed to link case: ' + err.message, 'error');
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Clone Repo tab (issue #236)
  // ═══════════════════════════════════════════════════════════════

  /** Clear the Clone tab and drop any preflight state. Called from showCreateCaseModal(). */
  _resetCloneForm() {
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };
    set('cloneRepoUrl', '');
    set('cloneCaseName', '');
    set('cloneRepoRef', '');
    const shallow = document.getElementById('cloneShallow');
    if (shallow) shallow.checked = false;
    const start = document.getElementById('cloneStartSession');
    if (start) start.checked = false;
    const refs = document.getElementById('cloneRepoRefOptions');
    if (refs) refs.replaceChildren();
    const refHint = document.getElementById('cloneRefHint');
    if (refHint) refHint.textContent = "Leave blank for the repository's default branch.";
    this._cloneNameEdited = false;
    this._clonePreflight = null;
    clearTimeout(this._clonePreflightTimer);
    this._clonePreflightAbort?.abort();
    this._clonePreflightAbort = null;
    this._setCloneStatus('Public repositories only: Codeman clones with no credentials.', '');
    // The brain picker mirrors the toolbar run menu: never offer a CLI this box
    // lacks (#201's rule), and preselect whatever Run is currently pointing at.
    const brain = document.getElementById('cloneCaseBrain');
    if (brain) {
      for (const option of brain.options) {
        const cli = option.dataset.cli;
        option.hidden = !!cli && !this.isCliAvailable(cli);
      }
      const current = this.runMode || 'claude';
      brain.value = [...brain.options].some((o) => o.value === current && !o.hidden) ? current : '';
    }
  },

  _setCloneStatus(message, kind) {
    const el = document.getElementById('cloneRepoStatus');
    if (!el) return;
    el.textContent = message;
    el.className = `form-hint clone-status${kind ? ' clone-status-' + kind : ''}`;
  },

  /**
   * Best-effort repo name out of a URL, for filling the case name as you type.
   *
   * Deliberately a THIN mirror of `suggestCaseNameFromRepo` (git-clone.ts) rather
   * than a second URL parser: it only ever suggests a name, and the server's parse
   * is the authority on whether the URL is cloneable at all. The preflight reply
   * overwrites whatever this guessed.
   */
  _repoNameFromUrl(url) {
    const trimmed = (url || '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    const segment = trimmed
      .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
      .replace(/^[^@/]*@/, '')
      .split(/[/:]/)
      .filter(Boolean)
      .pop() || '';
    return segment
      .replace(/\.git$/i, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 64);
  },

  onCloneNameEdited() {
    // Once the user types a name, autofill stops fighting them.
    this._cloneNameEdited = !!document.getElementById('cloneCaseName')?.value.trim();
  },

  onCloneUrlInput() {
    const url = document.getElementById('cloneRepoUrl')?.value.trim() || '';
    const nameInput = document.getElementById('cloneCaseName');
    if (nameInput && !this._cloneNameEdited) nameInput.value = this._repoNameFromUrl(url);
    clearTimeout(this._clonePreflightTimer);
    this._clonePreflightAbort?.abort();
    this._clonePreflightAbort = null;
    if (!url) {
      this._setCloneStatus('Public repositories only: Codeman clones with no credentials.', '');
      return;
    }
    if (this.isCliAvailable('git') === false) {
      this._setCloneStatus('git is not installed on the Codeman host, so cloning is unavailable.', 'err');
      return;
    }
    this._setCloneStatus('Checking the repository…', '');
    this._clonePreflightTimer = setTimeout(() => this._runClonePreflight(url), 450);
  },

  /**
   * Ask the server to parse the URL and (if it survives) query the remote, so the
   * user learns "private repo" / "typo" / "3 tags" BEFORE waiting on a clone.
   * Stale replies are dropped: only the response for the URL currently in the
   * field is allowed to paint.
   */
  async _runClonePreflight(url) {
    const controller = new AbortController();
    this._clonePreflightAbort = controller;
    try {
      const res = await fetch('/api/cases/clone-preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository: url }),
        signal: controller.signal,
      });
      const env = await res.json();
      if (document.getElementById('cloneRepoUrl')?.value.trim() !== url) return;
      if (!env.success) {
        this._setCloneStatus(env.error || 'Could not check that URL.', 'err');
        return;
      }
      this._applyClonePreflight(env.data, url);
    } catch (err) {
      if (err.name === 'AbortError') return;
      this._setCloneStatus('Could not reach Codeman to check that URL.', 'err');
    }
  },

  _applyClonePreflight(data, url) {
    this._clonePreflight = data;
    const parse = data?.parse;
    if (!parse?.cloneable) {
      this._setCloneStatus(parse?.message || 'That URL cannot be cloned.', 'err');
      return;
    }
    // The server's suggestion wins over the local guess (it is the same function
    // the case name is validated against), but never over a name the user typed.
    const nameInput = document.getElementById('cloneCaseName');
    if (nameInput && !this._cloneNameEdited && parse.suggestedName) nameInput.value = parse.suggestedName;

    const where = parse.owner ? `${parse.provider} ${parse.owner}/${parse.repo}` : `${parse.provider} ${parse.repo}`;
    if (data.gitAvailable === false) {
      this._setCloneStatus(`${where}: git is not installed on the Codeman host.`, 'err');
      return;
    }
    const remote = data.remote;
    if (remote && !remote.reachable) {
      this._setCloneStatus(`${where}: ${remote.failure?.message || 'the remote could not be read.'}`, 'err');
      return;
    }
    const refHint = document.getElementById('cloneRefHint');
    const options = document.getElementById('cloneRepoRefOptions');
    if (remote && options) {
      options.replaceChildren();
      for (const ref of [...(remote.branches || []), ...(remote.tags || [])]) {
        const option = document.createElement('option');
        option.value = ref;
        options.appendChild(option);
      }
      if (refHint) {
        const counts = `${remote.branches?.length || 0} branches, ${remote.tags?.length || 0} tags`;
        refHint.textContent = remote.defaultBranch
          ? `Blank clones the default branch (${remote.defaultBranch}). ${counts} available.`
          : `Blank clones the default branch. ${counts} available.`;
      }
    }
    const warning = parse.warnings?.[0];
    this._setCloneStatus(warning ? `${where}: ${warning}` : `${where}: ready to clone.`, warning ? 'warn' : 'ok');
  },

  async cloneCase() {
    const url = document.getElementById('cloneRepoUrl').value.trim();
    const name = document.getElementById('cloneCaseName').value.trim();
    const ref = document.getElementById('cloneRepoRef').value.trim();
    const shallow = !!document.getElementById('cloneShallow')?.checked;
    const brain = document.getElementById('cloneCaseBrain')?.value || '';
    const startSession = !!document.getElementById('cloneStartSession')?.checked;

    if (!url) {
      this.showToast('Please enter a repository URL', 'error');
      return;
    }
    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    this._setCloneStatus(`Cloning ${url}… this can take a while for a large repository.`, '');
    try {
      const res = await fetch('/api/cases/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Zod `.optional()` rejects an explicit null, and JSON.stringify keeps one
        // on the wire — omit the empty fields instead of sending null.
        body: JSON.stringify({ name, repository: url, ...(ref ? { ref } : {}), ...(shallow ? { shallow: true } : {}) }),
      });
      const data = await res.json();
      if (!data.success) {
        this._setCloneStatus(data.error || 'Clone failed.', 'err');
        this.showToast(data.error || 'Failed to clone repository', 'error');
        return;
      }

      // Setting the brain before the tab closes means the Run button is already
      // pointing at the chosen CLI, whether or not a session starts now.
      if (brain) this.setRunMode(brain);
      this.closeCreateCaseModal();
      await this.loadQuickStartCases(name);
      await this.saveLastUsedCase(name);
      this.showToast(`Cloned into case "${name}"`, 'success');
      for (const warning of data.data?.warnings || []) this.showToast(warning, 'warning');
      if (startSession) await this.run();
    } catch (err) {
      // A proxy/idle timeout can kill the request while git keeps going: the
      // case:created broadcast is what makes the case show up regardless.
      console.error('Failed to clone repository:', err);
      this._setCloneStatus(
        `Lost the connection while cloning: ${err.message}. If git finishes, the case still appears in the list.`,
        'warn'
      );
      this.showToast('Clone request interrupted — watch the case list', 'error');
    }
  },

  openLinkCasePathPicker() {
    const pathInput = document.getElementById('linkCasePath');
    PathPicker.open({
      title: 'Select Existing Project Folder',
      initialPath: pathInput.value.trim(),
      directoriesOnly: true,
      onSelect: (path) => {
        pathInput.value = path;
        const nameInput = document.getElementById('linkCaseName');
        if (!nameInput.value.trim()) {
          const folderName = path.split('/').filter(Boolean).pop() || '';
          if (/^[\p{L}\p{N}_-]+$/u.test(folderName)) nameInput.value = folderName;
        }
        pathInput.focus();
        pathInput.setSelectionRange(path.length, path.length);
      },
    });
  },

  /** HOST workspace directory — the same picker Link Existing uses. */
  openDockerWorkspacePathPicker() {
    const pathInput = document.getElementById('dockerWorkspacePath');
    PathPicker.open({
      title: 'Select Host Workspace Folder',
      initialPath: pathInput.value.trim(),
      directoriesOnly: true,
      onSelect: (path) => {
        pathInput.value = path;
        const nameInput = document.getElementById('dockerCaseName');
        if (nameInput && !nameInput.value.trim()) {
          const folder = path.split('/').filter(Boolean).pop() || '';
          if (/^[a-zA-Z0-9_-]+$/.test(folder)) nameInput.value = folder;
        }
      },
    });
  },

  /**
   * Container workdir. Browses INSIDE the container, because for an adopted
   * container nothing is mounted at a matching host path — the host picker would
   * be listing a different filesystem, and typing this field blind is exactly
   * what makes the launch fail with an OCI chdir error.
   */
  openDockerWorkdirPicker() {
    const pathInput = document.getElementById('dockerAdoptWorkdir');
    const container = document.getElementById('dockerContainerName')?.value.trim();
    const hostId = document.getElementById('dockerHostId')?.value.trim() || 'local';
    if (!container) {
      this.showToast('Enter the container name first', 'error');
      return;
    }
    PathPicker.open({
      title: `Select Folder Inside ${container}`,
      initialPath: pathInput.value.trim() || '/',
      directoriesOnly: true,
      fetchListing: async (path) => {
        const data = await this._apiJson('/api/docker-cases/browse', {
          method: 'POST',
          body: { hostId, container, path: path || '/' },
        });
        if (!data) return { success: false, error: `Could not read ${container}. Is it running?` };
        if (data.error) return { success: false, error: data.error };
        // Shape it like the host endpoint: one root, so Up/Location behave.
        return {
          success: true,
          data: { ...data, root: '/', roots: [{ label: container, path: '/' }], truncated: false },
        };
      },
      onSelect: (path) => {
        pathInput.value = path;
      },
    });
  },

  async linkRemoteCase() {
    const name = document.getElementById('remoteCaseName').value.trim();
    const remotePath = document.getElementById('remoteCasePath').value.trim();
    const hostId = document.getElementById('remoteHostId').value.trim();
    const host = document.getElementById('remoteHostAddress').value.trim();
    const username = document.getElementById('remoteHostUsername').value.trim();
    const codexCommand = document.getElementById('remoteHostCodexCommand').value.trim();
    // COD-107 — port + advanced SSH connection options.
    const portRaw = document.getElementById('remoteHostPort').value.trim();
    const identityFile = document.getElementById('remoteHostIdentityFile').value.trim();
    const socksProxy = document.getElementById('remoteHostSocksProxy').value.trim();
    const jumpHost = document.getElementById('remoteHostJumpHost').value.trim();
    const extraSshOptions = document.getElementById('remoteHostExtraSshOptions').value
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (!name || !remotePath || !hostId || !host || !username) {
      this.showToast('Please complete all required remote fields', 'error');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !/^[a-zA-Z0-9_-]+$/.test(hostId)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }
    if (!remotePath.startsWith('/')) {
      this.showToast('Remote path must be absolute', 'error');
      return;
    }
    let port;
    if (portRaw) {
      port = Number(portRaw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        this.showToast('SSH port must be a number between 1 and 65535', 'error');
        return;
      }
    }

    try {
      const hostPayload = {
        id: hostId,
        label: hostId,
        host,
        username,
        ...(port ? { port } : {}),
        ...(identityFile ? { identityFile } : {}),
        ...(socksProxy ? { socksProxy } : {}),
        ...(jumpHost ? { jumpHost } : {}),
        ...(extraSshOptions.length ? { extraSshOptions } : {}),
        ...(codexCommand ? { commands: { codex: codexCommand } } : {}),
      };
      const hostRes = await fetch('/api/remote-hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hostPayload)
      });
      const hostData = await hostRes.json();
      if (!hostData.success && hostData.errorCode !== 'ALREADY_EXISTS') {
        throw new Error(hostData.error || 'Failed to save remote host');
      }

      const caseRes = await fetch('/api/cases/remote-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, hostId, remotePath })
      });
      const caseData = await caseRes.json();
      if (caseData.success) {
        this.closeCreateCaseModal();
        this.showToast(`Remote case "${name}" linked`, 'success');
        await this.loadQuickStartCases(name);
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(caseData.error || 'Failed to link remote case', 'error');
      }
    } catch (err) {
      console.error('Failed to link remote case:', err);
      this.showToast('Failed to link remote case: ' + err.message, 'error');
    }
  },

  /**
   * Reflect the "attach to an existing container" checkbox onto the modal so CSS
   * can swap which half of the Docker panel applies. An attribute rather than
   * per-row inline styles: the panel is rebuilt by nothing, but the create-time
   * rows are a SET (image, network, advanced block) and one attribute keeps them
   * in lockstep with the container-name row.
   */
  _syncDockerAdoptMode() {
    const modal = document.getElementById('createCaseModal');
    if (!modal) return;
    const adopting = document.getElementById('dockerAdoptExisting')?.checked;
    if (adopting) modal.setAttribute('data-docker-adopt', '1');
    else modal.removeAttribute('data-docker-adopt');
    if (adopting) void this._loadDockerContainerOptions();
  },

  /**
   * Fill the container-name `<datalist>`. A native datalist is deliberate: the
   * field must accept a free-typed name (the engine may be remote, or the
   * container may not exist yet when the form is filled), and datalist gives
   * type-to-filter over the suggestions without a custom dropdown.
   *
   * Best-effort by design — the endpoint returns [] for an unreachable daemon,
   * and an empty list simply leaves the field as plain text input.
   */
  async _loadDockerContainerOptions() {
    const list = document.getElementById('dockerContainerList');
    if (!list) return;
    const hostId = document.getElementById('dockerHostId')?.value.trim() || 'local';
    if (list.dataset.loadedFor === hostId) return; // one fetch per host per open
    const data = await this._apiJson(`/api/docker-hosts/${encodeURIComponent(hostId)}/containers`);
    const containers = data?.containers || [];
    list.textContent = '';
    for (const c of containers) {
      const option = document.createElement('option');
      option.value = c.name;
      // Engine-supplied strings: set as text, never as markup.
      option.textContent = c.running ? `${c.image} · ${c.status}` : `${c.image} · ${c.status} (not running)`;
      list.appendChild(option);
    }
    list.dataset.loadedFor = hostId;
  },

  /**
   * Cross-link from the Create New tab's "Run in an isolated Docker container"
   * row. Adoption lives on the Docker tab, but the place users actually look for
   * anything container-shaped is that checkbox, so this jumps them there with the
   * toggle already on rather than leaving the feature undiscoverable.
   */
  jumpToDockerAdopt() {
    this.switchCaseModalTab('case-docker');
    const toggle = document.getElementById('dockerAdoptExisting');
    if (toggle) toggle.checked = true;
    this._syncDockerAdoptMode();
    document.getElementById('dockerContainerName')?.focus();
  },

  /**
   * Read-only preflight against an existing container. It links nothing, so the
   * user can find out "not running" / "no tmux" / "codex present, claude missing"
   * before committing to a case name — the same reason the server refuses at link
   * time rather than at session launch.
   */
  async _dockerAdoptPreflight() {
    const statusEl = document.getElementById('dockerLinkStatus');
    const container = document.getElementById('dockerContainerName')?.value.trim();
    const containerWorkdir = document.getElementById('dockerAdoptWorkdir')?.value.trim();
    const hostId = document.getElementById('dockerHostId').value.trim() || 'local';
    if (!container) {
      if (statusEl) statusEl.textContent = 'Enter a container name first.';
      return;
    }
    if (statusEl) statusEl.textContent = 'Inspecting container...';
    // _apiJson folds every failure to null, and a preflight's whole value is the
    // reason it failed, so the envelope is unwrapped by hand here.
    const probe = await this._apiJson('/api/docker-cases/adopt-preflight', {
      method: 'POST',
      body: { hostId, container, ...(containerWorkdir ? { containerWorkdir } : {}) },
    });
    if (!statusEl) return;
    if (!probe) {
      statusEl.textContent = 'Could not reach the docker host profile. Save a Host ID first.';
      return;
    }
    if (!probe.ok) {
      statusEl.textContent = probe.error || 'Container is not adoptable.';
      return;
    }
    const modes = (probe.availableModes || []).filter((m) => m !== 'shell');
    statusEl.textContent = modes.length
      ? `Running (${probe.image || 'unknown image'}). Available: ${modes.join(', ')}.`
      : `Running (${probe.image || 'unknown image'}), but no agent CLI found inside — only Shell will work.`;
  },

  async linkDockerCase() {
    const name = document.getElementById('dockerCaseName').value.trim();
    const hostWorkspacePath = document.getElementById('dockerWorkspacePath').value.trim();
    const hostId = document.getElementById('dockerHostId').value.trim() || 'local';
    const adopting = !!document.getElementById('dockerAdoptExisting')?.checked;
    const container = document.getElementById('dockerContainerName')?.value.trim() || '';
    const adoptWorkdir = document.getElementById('dockerAdoptWorkdir')?.value.trim() || '';
    const image = document.getElementById('dockerImage').value.trim() || 'codeman/agent:base';
    const network = document.getElementById('dockerNetwork').value;
    const memory = document.getElementById('dockerMemory').value.trim();
    const cpus = document.getElementById('dockerCpus').value.trim();
    const mountCredentials = document.getElementById('dockerMountCredentials').checked;
    const resumeOnStart = document.getElementById('dockerResumeOnStart').checked;
    const statusEl = document.getElementById('dockerLinkStatus');

    if (!name || !hostWorkspacePath) {
      this.showToast('Please enter a case name and workspace path', 'error');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !/^[a-zA-Z0-9_-]+$/.test(hostId)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }
    if (!hostWorkspacePath.startsWith('/')) {
      this.showToast('Workspace path must be absolute', 'error');
      return;
    }
    if (adopting && !container) {
      this.showToast('Enter the name of the running container to attach to', 'error');
      return;
    }

    try {
      if (statusEl) {
        statusEl.textContent = adopting ? 'Inspecting the existing container...' : 'Checking docker daemon + base image...';
      }
      // omitted optionals sent as UNDEFINED (never null — Zod .optional() rejects null)
      const resources = {};
      if (memory) resources.memory = memory;
      if (cpus) resources.cpus = cpus;
      const hostPayload = {
        id: hostId,
        label: hostId,
        image,
        network,
        mountCredentials,
        resumeOnStart,
        ...(Object.keys(resources).length ? { resources } : {}),
      };
      // PUT (update-or-create) so re-linking with the same host id refreshes its settings.
      let hostRes = await fetch('/api/docker-hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hostPayload),
      });
      let hostData = await hostRes.json();
      if (!hostData.success && hostData.errorCode === 'ALREADY_EXISTS') {
        hostRes = await fetch(`/api/docker-hosts/${encodeURIComponent(hostId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hostPayload),
        });
        hostData = await hostRes.json();
      }
      if (!hostData.success) throw new Error(hostData.error || 'Failed to save docker host');

      // Adoption reuses this whole flow and differs only in the final call: a
      // different endpoint (which never creates a container) plus the container
      // name. The host upsert above still applies — it is what resolves the
      // engine/context/daemon for the `docker exec`; its create-time fields are
      // simply never read for an adopted case.
      const caseRes = await fetch(adopting ? '/api/cases/docker-adopt' : '/api/cases/docker-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          adopting
            ? { name, hostId, hostWorkspacePath, container, ...(adoptWorkdir ? { containerWorkdir: adoptWorkdir } : {}) }
            : { name, hostId, hostWorkspacePath }
        ),
      });
      const caseData = await caseRes.json();
      if (caseData.success) {
        this.closeCreateCaseModal();
        const caps = caseData.data?.capsEnforced === false ? ' (resource caps are advisory on this engine)' : '';
        const modes = (caseData.data?.availableModes || []).filter((m) => m !== 'shell');
        const found = adopting && modes.length ? ` — found ${modes.join(', ')}` : '';
        this.showToast(`Docker case "${name}" ${adopting ? 'attached' : 'linked'}${caps}${found}`, 'success');
        await this.loadQuickStartCases(name);
        await this.saveLastUsedCase(name);
      } else {
        if (statusEl) statusEl.textContent = caseData.error || 'Failed to link docker case';
        this.showToast(caseData.error || 'Failed to link docker case', 'error');
      }
    } catch (err) {
      console.error('Failed to link docker case:', err);
      if (statusEl) statusEl.textContent = err.message;
      this.showToast('Failed to link docker case: ' + err.message, 'error');
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Docker export / import UI
  // ═══════════════════════════════════════════════════════════════

  async refreshDockerExports() {
    const listEl = document.getElementById('dockerExportsList');
    if (!listEl) return;
    try {
      const res = await fetch('/api/docker-exports');
      const data = await res.json();
      const exports = data?.data?.exports || [];
      if (exports.length === 0) {
        listEl.innerHTML = '<span class="form-hint">No exports yet. Export a docker case from its tab.</span>';
        return;
      }
      listEl.innerHTML = exports
        .map(e => {
          const mb = (e.sizeBytes / 1e6).toFixed(1);
          // escapeHtml is the free function from constants.js (never a method on `this`)
          const nm = escapeHtml(e.name);
          return `<div class="case-manage-item" style="display:flex; align-items:center; gap:8px; justify-content:space-between;">
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${nm}">${nm} <span class="form-hint">(${mb} MB)</span></span>
            <span style="flex-shrink:0;">
              <a class="btn-toolbar" href="${CodemanBase.url(`/api/docker-exports/${encodeURIComponent(e.name)}`)}" download>Download</a>
              <button class="btn-toolbar" onclick="app.importDockerBundle('${nm.replace(/'/g, "\\'")}')">Import</button>
              <button class="btn-toolbar" onclick="app.deleteDockerExport('${nm.replace(/'/g, "\\'")}')">Delete</button>
            </span>
          </div>`;
        })
        .join('');
    } catch (err) {
      listEl.innerHTML = `<span class="form-hint">Failed to load exports: ${err.message}</span>`;
    }
  },

  async exportDockerCaseBundle(caseName, mode = 'full') {
    try {
      const res = await fetch(`/api/docker-cases/${encodeURIComponent(caseName)}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (data.success) {
        this.showToast(`Exporting "${caseName}" (${mode})... you'll be notified when the bundle is ready`, 'info');
      } else {
        this.showToast(data.error || 'Export failed', 'error');
      }
    } catch (err) {
      this.showToast('Export failed: ' + err.message, 'error');
    }
  },

  async importDockerBundle(bundle) {
    const newCaseName = prompt('New case name for the imported bundle:', bundle.split('-')[0] + '-imported');
    if (!newCaseName) return;
    const destWorkspacePath = prompt('Absolute host directory to restore the workspace into:', '');
    if (!destWorkspacePath) return;
    try {
      const res = await fetch('/api/docker-cases/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle, newCaseName, destWorkspacePath }),
      });
      const data = await res.json();
      if (data.success) {
        this.showToast(`Imported as "${newCaseName}"`, 'success');
        await this.loadQuickStartCases(newCaseName);
      } else {
        this.showToast(data.error || 'Import failed', 'error');
      }
    } catch (err) {
      this.showToast('Import failed: ' + err.message, 'error');
    }
  },

  async deleteDockerExport(filename) {
    if (!confirm(`Delete export bundle "${filename}"?`)) return;
    try {
      const res = await fetch(`/api/docker-exports/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast('Export deleted', 'success');
        this.refreshDockerExports();
      } else {
        this.showToast(data.error || 'Delete failed', 'error');
      }
    } catch (err) {
      this.showToast('Delete failed: ' + err.message, 'error');
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // COD-105 — Discover + attach existing remote tmux sessions
  // ═══════════════════════════════════════════════════════════════

  /** Read the remote-host fields from the remote-case form into a host payload. */
  _readRemoteHostFromForm() {
    const hostId = document.getElementById('remoteHostId').value.trim();
    const host = document.getElementById('remoteHostAddress').value.trim();
    const username = document.getElementById('remoteHostUsername').value.trim();
    const portRaw = document.getElementById('remoteHostPort').value.trim();
    const identityFile = document.getElementById('remoteHostIdentityFile').value.trim();
    const socksProxy = document.getElementById('remoteHostSocksProxy').value.trim();
    const jumpHost = document.getElementById('remoteHostJumpHost').value.trim();
    const codexCommand = document.getElementById('remoteHostCodexCommand').value.trim();
    const extraSshOptions = document.getElementById('remoteHostExtraSshOptions').value
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    let port;
    if (portRaw) {
      const n = Number(portRaw);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n;
    }
    return {
      id: hostId,
      label: hostId,
      host,
      username,
      ...(port ? { port } : {}),
      ...(identityFile ? { identityFile } : {}),
      ...(socksProxy ? { socksProxy } : {}),
      ...(jumpHost ? { jumpHost } : {}),
      ...(extraSshOptions.length ? { extraSshOptions } : {}),
      ...(codexCommand ? { commands: { codex: codexCommand } } : {}),
    };
  },

  /**
   * Explicit Discover action (Decision A — never auto-runs on host select).
   * Saves the host config (idempotent), then queries the host for `codeman-*`
   * tmux sessions it didn't create and renders an Attach action per session.
   */
  async discoverRemoteSessions() {
    const results = document.getElementById('remoteDiscoverResults');
    const btn = document.getElementById('remoteDiscoverBtn');
    const hostPayload = this._readRemoteHostFromForm();
    if (!hostPayload.id || !hostPayload.host || !hostPayload.username) {
      this.showToast('Fill in Host ID, address, and username first', 'error');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(hostPayload.id)) {
      this.showToast('Invalid Host ID. Use letters, numbers, hyphens, underscores.', 'error');
      return;
    }
    if (btn) btn.disabled = true;
    if (results) results.innerHTML = '<div class="form-hint">Discovering…</div>';
    try {
      // Persist the host so the discovery endpoint can resolve it by id (idempotent).
      const hostRes = await fetch('/api/remote-hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hostPayload)
      });
      const hostData = await hostRes.json();
      if (!hostData.success && hostData.errorCode !== 'ALREADY_EXISTS') {
        throw new Error(hostData.error || 'Failed to save remote host');
      }
      const res = await fetch(`/api/remote-hosts/${encodeURIComponent(hostPayload.id)}/sessions`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Discovery failed');
      this._renderDiscoveredSessions(hostPayload.id, data.data.sessions || []);
    } catch (err) {
      console.error('Discover remote sessions failed:', err);
      if (results) results.innerHTML = `<div class="form-hint" style="color: var(--error, #e06c75);">${escapeHtml(err.message)}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  /** Render the discovered remote sessions with an Attach action each. */
  _renderDiscoveredSessions(hostId, sessions) {
    const results = document.getElementById('remoteDiscoverResults');
    if (!results) return;
    if (!sessions.length) {
      results.innerHTML = '<div class="form-hint">No <code>codeman-*</code> sessions running on this host (or it is unreachable).</div>';
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const rows = sessions.map(s => {
      const ageSecs = Math.max(0, now - (s.created || 0));
      const age = ageSecs < 3600 ? `${Math.floor(ageSecs / 60)}m` : ageSecs < 86400 ? `${Math.floor(ageSecs / 3600)}h` : `${Math.floor(ageSecs / 86400)}d`;
      // COD-106 — show "shared · N clients" when more than one client is attached
      // (genuinely collaborative), else a plain "attached" badge for a single client.
      const clients = s.attachedClients != null ? s.attachedClients : s.attached ? 1 : 0;
      const attachedBadge =
        clients > 1
          ? `<span class="case-location-badge" style="background: var(--warning, #e5c07b); color: #000;">shared · ${clients} clients</span>`
          : clients === 1
            ? '<span class="case-location-badge" style="background: var(--accent, #61afef);">attached</span>'
            : '';
      return `
        <div class="remote-discover-item">
          <div class="remote-discover-info">
            <span class="remote-discover-name">${escapeHtml(s.name)} ${attachedBadge}</span>
            <span class="form-hint">age ${age} · ${s.windows || 1} window(s)</span>
          </div>
          <button type="button" class="btn-toolbar" onclick="app.attachDiscoveredSession('${escapeHtml(hostId)}', '${escapeHtml(s.name)}')">Attach</button>
        </div>`;
    }).join('');
    results.innerHTML = rows;
  },

  /**
   * Create a NON-owned session that attaches to a discovered remote tmux session.
   * Closing this tab detaches — it never kills the remote session.
   */
  async attachDiscoveredSession(hostId, remoteSessionName) {
    try {
      const createRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'shell',
          name: remoteSessionName,
          attachRemoteSession: { hostId, remoteSessionName },
        })
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error || 'Failed to create session');
      const id = createData.data.session.id;
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      const dims = this.getTerminalDimensions();
      if (dims) {
        await fetch(`/api/sessions/${id}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dims)
        });
      }
      this.closeCreateCaseModal();
      this.showToast(`Attached to ${remoteSessionName} (detach on close)`, 'success');
      this.activeSessionId = id;
      await this.selectSession(id);
      if (this.terminal && typeof this.terminal.focus === 'function') this.terminal.focus();
    } catch (err) {
      console.error('Attach discovered session failed:', err);
      this.showToast('Failed to attach: ' + err.message, 'error');
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Case Management (reorder + delete)
  // ═══════════════════════════════════════════════════════════════

  renderCaseManageList() {
    const container = document.getElementById('caseManageList');
    const cases = this.cases || [];
    if (cases.length === 0) {
      container.innerHTML = '<div class="form-hint" style="text-align: center; padding: 2rem 0;">No cases yet</div>';
      return;
    }

    // Cases an agent worker created (server-side marker file, see agent-case-marker.ts).
    // A long orchestration leaves one scratch directory per worker behind, so they get
    // a badge and a bulk cleanup entry point rather than having to be recognised by name.
    const agentCases = cases.filter(c => c.agentCreated);
    let html = agentCases.length > 0
      ? `<div class="case-manage-agent-bar">
          <span class="case-manage-agent-count">${agentCases.length} case${agentCases.length === 1 ? '' : 's'} created by agent workers</span>
          <button class="case-manage-btn case-manage-btn-cleanup" onclick="app.cleanupAgentCases()"
                  title="Review and delete the scratch cases agent workers left behind">Clean up</button>
         </div>`
      : '';
    cases.forEach((c, idx) => {
      const isFirst = idx === 0;
      const isLast = idx === cases.length - 1;
      // Was `/Users/<user>` only, the mirror image of the Run menu's bug: every
      // case path on a Linux host rendered in full, unabbreviated.
      const pathDisplay = c.path ? this._shortenHomePath(c.path) : '';
      const agentTitle = c.agentCreated
        ? `Created by an agent worker${c.agentCreated.parentSessionName ? ` from ${c.agentCreated.parentSessionName}` : ''}` +
          ` (${c.agentCreated.createdBy})${c.agentCreated.createdAt ? ` on ${new Date(c.agentCreated.createdAt).toLocaleString()}` : ''}`
        : '';
      html += `
        <div class="case-manage-item" data-case="${escapeHtml(c.name)}">
          <div class="case-manage-info">
            <span class="case-manage-name">${escapeHtml(c.name)}${
              c.agentCreated ? `<span class="case-manage-tag-agent" title="${escapeHtml(agentTitle)}" data-i18n-skip>agent</span>` : ''
            }</span>
            <span class="case-manage-path">${escapeHtml(pathDisplay)}</span>
          </div>
          <div class="case-manage-actions">
            ${
              c.location === 'docker'
                ? `<button class="case-manage-btn" onclick="app.exportDockerCaseBundle(${escapeHtml(JSON.stringify(c.name))}, 'full')"
                    title="Export container (full image + workspace) to move to another machine">&#x1F4E6;</button>`
                : ''
            }
            <button class="case-manage-btn" onclick="app.moveCaseUp(${escapeHtml(JSON.stringify(c.name))})"
                    title="Move up" ${isFirst ? 'disabled' : ''}>&#x25B2;</button>
            <button class="case-manage-btn" onclick="app.moveCaseDown(${escapeHtml(JSON.stringify(c.name))})"
                    title="Move down" ${isLast ? 'disabled' : ''}>&#x25BC;</button>
            <button class="case-manage-btn case-manage-btn-delete" onclick="app.deleteCase(${escapeHtml(JSON.stringify(c.name))})"
                    title="Delete case">&#x2715;</button>
          </div>
        </div>
      `;
    });
    container.innerHTML = html;
  },

  async moveCaseUp(name) {
    const cases = this.cases || [];
    const idx = cases.findIndex(c => c.name === name);
    if (idx <= 0) return;
    // Swap positions (immutable)
    const reordered = [...cases];
    [reordered[idx - 1], reordered[idx]] = [reordered[idx], reordered[idx - 1]];
    this.cases = reordered;
    this.renderCaseManageList();
    await this.saveCaseOrder(reordered.map(c => c.name));
  },

  async moveCaseDown(name) {
    const cases = this.cases || [];
    const idx = cases.findIndex(c => c.name === name);
    if (idx < 0 || idx >= cases.length - 1) return;
    const reordered = [...cases];
    [reordered[idx], reordered[idx + 1]] = [reordered[idx + 1], reordered[idx]];
    this.cases = reordered;
    this.renderCaseManageList();
    await this.saveCaseOrder(reordered.map(c => c.name));
  },

  async deleteCase(name) {
    if (!confirm(`Delete case "${name}"? Linked cases will only be unlinked (folder preserved). Created cases will be permanently deleted.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast(`Case "${name}" ${data.data?.type === 'unlinked' ? 'unlinked' : 'deleted'}`, 'success');
        // Remove from current list and refresh
        this.cases = (this.cases || []).filter(c => c.name !== name);
        this.renderCaseManageList();
        // Refresh the dropdown
        const select = document.getElementById('quickStartCase');
        const currentCase = select.value;
        if (currentCase === name) {
          // Blur the native picker before reload so it doesn't show the stale value
          select.blur?.();
        }
        await this.loadQuickStartCases(currentCase === name ? null : currentCase);
        if (currentCase === name) {
          await this.saveLastUsedCase(document.getElementById('quickStartCase')?.value || 'testcase');
        }
      } else {
        this.showToast(data.error || 'Failed to delete case', 'error');
      }
    } catch (err) {
      this.showToast('Failed to delete case: ' + err.message, 'error');
    }
  },

  /**
   * Review-then-delete the scratch cases agent workers left behind.
   *
   * ⚠️ Never silently bulk-deletes: the confirm names every directory, and a case a
   * LIVE session is still working in is excluded outright rather than confirmed away
   * (`inUse` from the server, which knows every session's working directory). Removal
   * reuses `DELETE /api/cases/:name` one name at a time, so there is no second
   * recursive-delete path to keep in step with the first.
   */
  async cleanupAgentCases() {
    let agentCases;
    try {
      const res = await fetch('/api/cases/agent-created');
      const body = await res.json();
      if (!body.success) {
        this.showToast(body.error || 'Failed to list agent cases', 'error');
        return;
      }
      agentCases = body.data.cases || [];
    } catch (err) {
      this.showToast('Failed to list agent cases: ' + err.message, 'error');
      return;
    }

    const busy = agentCases.filter(c => c.inUse);
    const removable = agentCases.filter(c => !c.inUse);
    if (removable.length === 0) {
      this.showToast(
        busy.length > 0
          ? `All ${busy.length} agent case(s) are still in use by a running session`
          : 'No agent-created cases to clean up',
        'info'
      );
      return;
    }

    const names = removable.map(c => `  ${c.name}`).join('\n');
    const busyNote = busy.length > 0 ? `\n\nSkipping ${busy.length} case(s) still in use by a running session.` : '';
    if (!confirm(`Permanently delete ${removable.length} agent-created case folder(s) and everything in them?\n\n${names}${busyNote}`)) {
      return;
    }

    let deleted = 0;
    const failed = [];
    for (const item of removable) {
      try {
        const res = await fetch(`/api/cases/${encodeURIComponent(item.name)}`, { method: 'DELETE' });
        const body = await res.json();
        if (body.success) deleted++;
        else failed.push(item.name);
      } catch {
        failed.push(item.name);
      }
    }

    this.showToast(
      failed.length === 0
        ? `Deleted ${deleted} agent case(s)`
        : `Deleted ${deleted}, failed: ${failed.join(', ')}`,
      failed.length === 0 ? 'success' : 'error'
    );

    // Refresh the picker (its selected case may be one we just deleted) and the list.
    const select = document.getElementById('quickStartCase');
    const currentCase = select?.value;
    const currentDeleted = removable.some(c => c.name === currentCase);
    if (currentDeleted) select?.blur?.();
    await this.loadQuickStartCases(currentDeleted ? null : currentCase);
    if (currentDeleted) {
      await this.saveLastUsedCase(document.getElementById('quickStartCase')?.value || 'testcase');
    }
    this.renderCaseManageList();
  },

  async saveCaseOrder(order) {
    try {
      await fetch('/api/cases/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order })
      });
      // Refresh dropdown to reflect new order
      const select = document.getElementById('quickStartCase');
      const currentCase = select.value;
      await this.loadQuickStartCases(currentCase);
    } catch (err) {
      this.showToast('Failed to save case order: ' + err.message, 'error');
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Mobile Case Picker
  // ═══════════════════════════════════════════════════════════════

  showMobileCasePicker() {
    const modal = document.getElementById('mobileCasePickerModal');
    const listContainer = document.getElementById('mobileCaseList');
    const select = document.getElementById('quickStartCase');
    const currentCase = select.value;

    // Build case list HTML
    let html = '';
    const allCases = this.getCasePickerOptions();

    for (const c of allCases) {
      const isSelected = c.name === currentCase;
      html += `
        <button class="mobile-case-item ${isSelected ? 'selected' : ''}"
                onclick="app.selectMobileCase(${escapeHtml(JSON.stringify(c.name))})">
          <span class="mobile-case-item-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </span>
          <span class="mobile-case-item-name">${escapeHtml(c.label)}</span>
          <span class="mobile-case-item-delete" onclick="event.stopPropagation(); app.deleteCaseMobile(${escapeHtml(JSON.stringify(c.name))})" title="Delete">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </span>
          <span class="mobile-case-item-check">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </span>
        </button>
      `;
    }

    listContainer.innerHTML = html;
    modal.classList.add('active');
  },

  closeMobileCasePicker() {
    document.getElementById('mobileCasePickerModal').classList.remove('active');
  },

  selectMobileCase(caseName) {
    // Update the desktop select (source of truth)
    const select = document.getElementById('quickStartCase');
    select.value = caseName;

    // Update mobile button label
    this.updateMobileCaseLabel(caseName);

    // Update directory display
    this.updateDirDisplayForCase(caseName);

    // Save as last used
    this.saveLastUsedCase(caseName);

    // Close the picker
    this.closeMobileCasePicker();

    this.showToast(`Selected: ${caseName}`, 'success');
  },

  updateMobileCaseLabel(caseName) {
    const label = document.getElementById('mobileCaseName');
    if (label) {
      // Let CSS handle truncation via text-overflow: ellipsis
      label.textContent = caseName;
    }
  },

  async deleteCaseMobile(name) {
    if (!confirm(`Delete case "${name}"?`)) return;
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast(`Case "${name}" ${data.data?.type === 'unlinked' ? 'unlinked' : 'deleted'}`, 'success');
        this.cases = (this.cases || []).filter(c => c.name !== name);
        // Refresh mobile picker and dropdown
        this.closeMobileCasePicker();
        await this.loadQuickStartCases();
      } else {
        this.showToast(data.error || 'Failed to delete case', 'error');
      }
    } catch (err) {
      this.showToast('Failed to delete case: ' + err.message, 'error');
    }
  },

  showCreateCaseFromMobile() {
    // Close mobile picker first
    this.closeMobileCasePicker();
    // Open the create case modal with slide-up animation
    this.showCreateCaseModal();
    const modal = document.getElementById('createCaseModal');
    modal.classList.add('from-mobile');
    // Remove animation class after it plays
    setTimeout(() => modal.classList.remove('from-mobile'), 300);
  },
});

Object.defineProperty(CodemanApp.prototype, 'runMode', {
  configurable: true,
  enumerable: true,
  get() {
    return this._runMode || 'claude';
  },
  set(mode) {
    this._runMode =
      mode === 'opencode' || mode === 'codex' || mode === 'gemini' || mode === 'antigravity' || mode === 'pi' || mode === 'grok' || mode === 'deepseek' || mode === 'omp' || mode === 'claude'
        ? mode
        : 'claude';
  },
});
