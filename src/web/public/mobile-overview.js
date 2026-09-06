/**
 * @fileoverview Phone home screen: a scrolling overview of what every session is
 * doing, shown instead of the welcome overlay when the "C" logo is tapped.
 *
 * The welcome screen answers "how do I start something"; on a phone the more
 * urgent question is "which of my sessions is blocked on me". This surface
 * answers that first: NEEDS YOU (pending permission/question/idle hooks and
 * errored sessions), then SPACES (cases, expandable to their sessions), then
 * WORKING and IDLE / DONE.
 *
 * Rows inside a section are ordered by `CodemanSessionOrder` (constants.js),
 * the SAME comparator the desktop rail uses: blocked longest-first, then
 * running longest-first, then quiet most-recently-quiet first.
 *
 * PHONE ONLY. The gate is `shouldUseMobileOverview()` (viewport < 430px, not a
 * popped-out solo window, per-device setting on). Tablet and desktop keep the
 * welcome overlay untouched. The container ships with the `hidden` attribute and
 * only this module removes it, so desktop (which never loads mobile.css) cannot
 * render an unstyled overview even if a class rule leaked.
 *
 * Each live row also carries when the session FIRST started and how long it has
 * been in the state it is in ("started 3d ago · idle 12m"). Both go stale on
 * their own (a sitting session emits no event), so a slow clock rewrites them
 * IN PLACE from the epoch ms parked on the elements, never by re-rendering,
 * which would restart every row's blink and pulse.
 *
 * Everything renders from state the page already holds (`this.sessions`,
 * `this.cases`, `this.pendingHooks`) — no endpoint, no SSE event, no schema.
 * `buildMobileOverviewModel()` is pure and unit-tested (test/mobile-overview.test.ts).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency constants.js (CodemanSessionOrder, the shared row comparator)
 * @dependency app.js (this.sessions, this.cases, this.pendingHooks, selectSession, run)
 * @dependency ralph-panel.js (formatRelativeTime, the app's one relative-time formatter)
 * @dependency mobile-handlers.js (MobileDetection)
 * @dependency session-ui.js (selectQuickStartCase for "New session here")
 * @loadorder 12.55 of 16, after webview-tabs.js, before entrance-animations.js
 */

/** Viewport width that counts as a phone. Matches the mobile.css phone block. */
const MOBILE_OVERVIEW_PHONE_QUERY = '(max-width: 430px)';

/** How many past conversations show before the "Show all" toggle. */
const MOBILE_OVERVIEW_PAST_LIMIT = 8;

/**
 * Backends offered by the Run picker, mirroring the toolbar's run-mode menu
 * (`#runModeMenu` in index.html). `short` is the badge on the Run button itself.
 */
const MOBILE_OVERVIEW_RUN_MODES = [
  { mode: 'claude', label: 'Claude Code', short: 'Claude' },
  { mode: 'opencode', label: 'OpenCode', short: 'OpenCode' },
  { mode: 'codex', label: 'Codex', short: 'Codex' },
  { mode: 'gemini', label: 'Gemini', short: 'Gemini' },
  { mode: 'antigravity', label: 'Antigravity', short: 'Antigravity' },
  { mode: 'pi', label: 'Pi', short: 'Pi' },
  { mode: 'grok', label: 'Grok', short: 'Grok' },
  { mode: 'deepseek', label: 'DeepSeek', short: 'DeepSeek' },
  { mode: 'omp', label: 'OMP', short: 'OMP' },
  { mode: 'shell', label: 'Terminal / Shell', short: 'Shell' },
];

/** Pill copy per state. Kept short: a phone row has ~90px for it. */
const MOBILE_OVERVIEW_PILL_LABEL = {
  needs: 'needs you',
  error: 'error',
  waiting: 'waiting',
  working: 'working',
  idle: 'idle',
  done: 'done',
};

/**
 * Label for the "how long has it been like this" stamp, per state. The pill
 * already names the state, so this word is there to say what the duration next
 * to it is measuring.
 */
const MOBILE_OVERVIEW_SINCE_LABEL = {
  needs: 'waiting',
  waiting: 'waiting',
  error: 'failed',
  working: 'working',
  idle: 'idle',
  done: 'ended',
};

/** How often the age stamps are rewritten in place while the home screen is up. */
const MOBILE_OVERVIEW_CLOCK_MS = 20000;

Object.assign(CodemanApp.prototype, {
  // ═══════════════════════════════════════════════════════════════
  // Model (pure)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Classify one session.
   * Order matters: an action hook outranks everything (it is literally blocking
   * the agent), and a pending idle_prompt outranks a stale 'busy' status because
   * the hook is the newer signal.
   * @param {object} session session state from this.sessions
   * @param {Set<string>|undefined} hooks pending hook types for that session
   * @returns {'needs'|'error'|'waiting'|'working'|'idle'|'done'}
   */
  _mobileOverviewState(session, hooks) {
    if (hooks && (hooks.has('permission_prompt') || hooks.has('elicitation_dialog'))) return 'needs';
    if (session.status === 'error') return 'error';
    if (hooks && hooks.has('idle_prompt')) return 'waiting';
    if (session.status === 'busy') return 'working';
    if (session.status === 'stopped') return 'done';
    return 'idle';
  },

  /**
   * Anchor + label for the row's second stamp: how long the session has been in
   * the state it is in.
   *
   * For everything that is NOT working that anchor is `lastActivityAt`, the last
   * byte the pane printed: a Claude pane sitting at its composer prints nothing,
   * so the end of the last turn is exactly when the session went quiet.
   *
   * A WORKING pane is the opposite: it repaints about once a second, so its
   * last-activity stamp is always "now" and would report every running turn as
   * 0m. The turn's own start is the pane's last Enter (`lastSubmitAt`), which is
   * persisted server-side and therefore survives a Codeman restart. A working
   * session with NO submit stamp falls back to `lastActivityAt`, because that is
   * exactly what `sessionActivityAnchor` (constants.js) sorts it by: a row must
   * never be ranked by a number it does not show.
   *
   * @returns {{key: string, at: number}|null}
   */
  _mobileOverviewSince(state, session) {
    const activeAt = Number(session.lastActivityAt) || 0;
    const at = state === 'working' ? Number(session.lastSubmitAt) || activeAt : activeAt;
    if (!at) return null;
    return { key: MOBILE_OVERVIEW_SINCE_LABEL[state] || state, at };
  },

  /**
   * Longest-prefix match of a workingDir against the case list, so a session
   * started in a subdirectory still belongs to its case. Mirrors the matching in
   * `_resolveCaseLabel()` (terminal-ui.js) but returns the case itself.
   * @returns {object|null} the matching case, or null when the dir is outside every case
   */
  _mobileOverviewCaseFor(workingDir, cases) {
    if (!workingDir) return null;
    let best = null;
    for (const c of cases || []) {
      if (!c || !c.path) continue;
      if (workingDir === c.path) return c;
      if (workingDir.startsWith(c.path + '/') && (!best || c.path.length > best.path.length)) {
        best = c;
      }
    }
    return best;
  },

  /**
   * Build the whole overview model. PURE: reads only its argument, touches no DOM
   * and no `this` state, so it can be unit-tested against plain objects.
   *
   * @param {object} input
   * @param {Map<string, object>|Array} input.sessions live sessions (this.sessions)
   * @param {Array} input.cases case list (this.cases)
   * @param {Array<string>} [input.sessionOrder] the user's tab order, used as the tiebreak
   * @param {Map<string, Set<string>>} [input.pendingHooks] this.pendingHooks
   * @param {Array} [input.history] unified session items (GET /api/sessions/unified)
   * @returns {{needsYou: Array, current: Array, past: Array, sessionCount: number}}
   */
  buildMobileOverviewModel(input) {
    const cases = Array.isArray(input && input.cases) ? input.cases : [];
    const order = Array.isArray(input && input.sessionOrder) ? input.sessionOrder : [];
    const pendingHooks = (input && input.pendingHooks) || new Map();
    const raw = (input && input.sessions) || [];
    const sessions = typeof raw.values === 'function' ? Array.from(raw.values()) : Array.from(raw);

    const rows = sessions.map((session) => {
      const matched = this._mobileOverviewCaseFor(session.workingDir, cases);
      const state = this._mobileOverviewState(session, pendingHooks.get && pendingHooks.get(session.id));
      const orderIndex = order.indexOf(session.id);
      return {
        id: session.id,
        name: this.getSessionName ? this.getSessionName(session) : session.name || session.id.slice(0, 8),
        mode: session.mode || 'claude',
        caseName: matched ? matched.name : '',
        dir: this._shortenHomePath ? this._shortenHomePath(session.workingDir) : session.workingDir || '',
        state,
        pill: MOBILE_OVERVIEW_PILL_LABEL[state] || state,
        // Epoch ms, straight off the session payload; formatting happens at
        // render time so the clock can redo it without a re-render.
        createdAt: Number(session.createdAt) || 0,
        // Raw stamps for the shared order comparator; `since` above is the same
        // pair resolved for DISPLAY, and the two must not drift apart.
        lastActivityAt: Number(session.lastActivityAt) || 0,
        lastSubmitAt: Number(session.lastSubmitAt) || 0,
        since: this._mobileOverviewSince(state, session),
        orderIndex: orderIndex === -1 ? Number.MAX_SAFE_INTEGER : orderIndex,
      };
    });

    // Order is `CodemanSessionOrder` (constants.js), shared with the desktop
    // rail: blocked first (longest-blocked at the top), then running
    // longest-first, then quiet most-recent-first.
    // Guarded: a stale cached constants.js (iOS Safari after a deploy) must
    // degrade to tab order, not TypeError the overview away.
    const inSection = (states) => {
      const filtered = rows.filter((r) => states.includes(r.state));
      return window.CodemanSessionOrder ? window.CodemanSessionOrder.sort(filtered) : filtered;
    };

    // Past = conversations from the unified list that are not currently live.
    // The endpoint already folds a transcript into its owning session (via the
    // claudeSessionId alias map), so a plain id check is enough to avoid listing
    // a running session twice.
    const liveIds = new Set(rows.map((r) => r.id));
    const past = (Array.isArray(input && input.history) ? input.history : [])
      .filter((item) => item && item.sessionId && !liveIds.has(item.sessionId))
      .map((item) => {
        const matched = this._mobileOverviewCaseFor(item.workingDir, cases);
        const dir = item.workingDir || '';
        // The transcript reader emits the literal "(no content)" for a
        // conversation it could not pull a prompt from; that is not a title.
        const prompt = (item.firstPrompt || '').trim();
        const title = prompt && prompt !== '(no content)' ? prompt : '';
        return {
          id: item.sessionId,
          claudeSessionId: item.claudeSessionId || '',
          workingDir: dir,
          name: item.name || '',
          title: title || item.name || dir.split('/').pop() || item.sessionId.slice(0, 8),
          mode: item.mode || 'claude',
          caseName: matched ? matched.name : '',
          dir: this._shortenHomePath ? this._shortenHomePath(dir) : dir,
          at: item.lastActivityAt || item.createdAt || 0,
        };
      })
      .sort((a, b) => b.at - a.at);

    return {
      needsYou: inSection(['needs', 'error', 'waiting']),
      current: inSection(['working', 'idle', 'done']),
      past,
      sessionCount: rows.length,
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // Gate + visibility
  // ═══════════════════════════════════════════════════════════════

  /**
   * Phone-only gate. Width-driven (not `isHandheldDevice()`): this is a LAYOUT
   * decision, and an unfolded foldable with a tablet-width viewport should get
   * the tablet welcome screen. Per-device settings identity is a separate
   * question and deliberately stays handheld-based.
   */
  shouldUseMobileOverview() {
    if (this.isSoloWindow) return false;
    const settings = this.loadAppSettingsFromStorage ? this.loadAppSettingsFromStorage() : {};
    if (settings.mobileOverviewEnabled === false) return false;
    if (typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType) {
      return MobileDetection.getDeviceType() === 'mobile';
    }
    return !!(window.matchMedia && window.matchMedia(MOBILE_OVERVIEW_PHONE_QUERY).matches);
  },

  /** True while the overview is the visible home surface. */
  isMobileOverviewVisible() {
    const el = document.getElementById('mobileOverview');
    return !!el && el.classList.contains('visible');
  },

  showMobileOverview() {
    const el = document.getElementById('mobileOverview');
    if (!el) return;
    el.hidden = false;
    el.classList.add('visible');
    this._wireMobileOverview(el);
    this.renderMobileOverview();
    void this.loadMobileOverviewHistory();
  },

  hideMobileOverview() {
    const el = document.getElementById('mobileOverview');
    if (!el) return;
    this._closeMobileOverviewRunMenu();
    this._stopMobileOverviewClock();
    el.classList.remove('visible');
    el.hidden = true;
  },

  /**
   * Past conversations, fetched once per home-screen visit. The unified list is
   * the same source the welcome screen resumes from, so a row resumed here and a
   * row resumed there behave identically. Failures leave the section out rather
   * than showing an error: the live sessions above it are the important part.
   */
  async loadMobileOverviewHistory() {
    if (this._mobileOverviewHistoryLoading) return;
    this._mobileOverviewHistoryLoading = true;
    try {
      this._mobileOverviewHistory = await this._fetchUnifiedSessions(60);
    } catch (err) {
      console.warn('[mobile-overview] history load failed:', err);
      this._mobileOverviewHistory = this._mobileOverviewHistory || [];
    } finally {
      this._mobileOverviewHistoryLoading = false;
      if (this.isMobileOverviewVisible()) this.renderMobileOverview();
    }
  },

  /** Re-render only when the surface is actually showing (called from the tab renderer). */
  _refreshMobileOverviewIfVisible() {
    if (!this.isMobileOverviewVisible()) return;
    this._debouncedCall('mobileOverview', () => this.renderMobileOverview(), 150);
  },

  /**
   * One delegated click listener for every row, plus a breakpoint listener so
   * rotating or unfolding while on the home screen swaps to the right surface
   * instead of stranding a phone layout on a tablet-width viewport.
   */
  _wireMobileOverview(el) {
    if (this._mobileOverviewWired) return;
    this._mobileOverviewWired = true;

    el.addEventListener('click', (event) => {
      const target = event.target && event.target.closest && event.target.closest('[data-mo-action]');
      if (!target) return;
      const action = target.dataset.moAction;
      if (action === 'session') {
        this._closeMobileOverviewRunMenu();
        void this.selectSession(target.dataset.moSession);
      } else if (action === 'resume') {
        this._closeMobileOverviewRunMenu();
        void this.resumeMobileOverviewSession(target.dataset.moSession);
      } else if (action === 'more-past') {
        this._mobileOverviewShowAllPast = !this._mobileOverviewShowAllPast;
        this.renderMobileOverview();
      } else if (action === 'run') {
        this._closeMobileOverviewRunMenu();
        void this.run();
      } else if (action === 'run-menu') {
        this._toggleMobileOverviewRunMenu();
      } else if (action === 'run-mode') {
        // Picking a backend both selects it (so the Run button keeps meaning what
        // you last chose, exactly like the toolbar) and launches it: on a phone
        // the pick IS the intent to start.
        this._closeMobileOverviewRunMenu();
        this.setRunMode(target.dataset.moMode);
        void this.run();
      } else if (action === 'run-webview') {
        this._closeMobileOverviewRunMenu();
        void this.openWebviewFromMenu(target.dataset.moWebview);
      } else if (action === 'run-add-url') {
        this._closeMobileOverviewRunMenu();
        this.showWebviewModal();
      }
    });

    if (window.matchMedia) {
      const mq = window.matchMedia(MOBILE_OVERVIEW_PHONE_QUERY);
      const onChange = () => {
        // Only relevant while a home surface is up; entering a session re-decides
        // through hideWelcome()/showWelcome() anyway.
        if (this.activeSessionId) return;
        if (typeof this.showWelcome === 'function') this.showWelcome();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  },

  _toggleMobileOverviewRunMenu() {
    this._mobileOverviewRunMenuOpen = !this._mobileOverviewRunMenuOpen;
    this.renderMobileOverview();
  },

  _closeMobileOverviewRunMenu() {
    if (!this._mobileOverviewRunMenuOpen) return;
    this._mobileOverviewRunMenuOpen = false;
    if (this.isMobileOverviewVisible()) this.renderMobileOverview();
  },

  /**
   * Resume a past conversation. Delegates to the same resumeHistorySession() the
   * welcome screen's Resume list uses, so name synthesis, envOverrides and the
   * resumeSessionId wiring stay in one place.
   */
  async resumeMobileOverviewSession(sessionId) {
    const row = (this._mobileOverviewPastRows || []).find((r) => r.id === sessionId);
    if (!row || !row.workingDir) return;
    await this.resumeHistorySession(
      row.claudeSessionId || row.id,
      row.workingDir,
      row.name || undefined,
      row.mode,
      row.resumeId
    );
  },

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════

  renderMobileOverview() {
    const el = document.getElementById('mobileOverview');
    if (!el) return;

    const model = this.buildMobileOverviewModel({
      sessions: this.sessions,
      cases: this.cases,
      sessionOrder: this.sessionOrder,
      pendingHooks: this.pendingHooks,
      history: this._mobileOverviewHistory,
    });
    // Resume needs the workingDir/claudeSessionId off the row the user tapped.
    this._mobileOverviewPastRows = model.past;

    el.replaceChildren();
    el.appendChild(this._buildMobileOverviewTop());

    if (model.needsYou.length) {
      el.appendChild(
        this._buildMobileOverviewSection(
          'Needs you',
          model.needsYou.length,
          model.needsYou.map((r) => this._buildMobileOverviewRow(r))
        )
      );
    }

    el.appendChild(
      this._buildMobileOverviewSection(
        'Current sessions',
        model.current.length,
        model.current.map((r) => this._buildMobileOverviewRow(r)),
        'Nothing running. Hit Run to start something.'
      )
    );

    el.appendChild(
      this._buildMobileOverviewSection(
        'Past sessions',
        model.past.length,
        this._buildMobileOverviewPast(model),
        this._mobileOverviewHistory ? 'No past conversations yet' : 'Loading…'
      )
    );

    this._startMobileOverviewClock();
  },

  /**
   * Past conversations, newest first and capped: the unified list can run to
   * dozens, and this section sits below the live ones on purpose.
   */
  _buildMobileOverviewPast(model) {
    const showAll = !!this._mobileOverviewShowAllPast;
    const visible = showAll ? model.past : model.past.slice(0, MOBILE_OVERVIEW_PAST_LIMIT);
    const children = visible.map((r) => this._buildMobileOverviewPastRow(r));
    const hiddenCount = model.past.length - visible.length;
    if (hiddenCount > 0 || showAll) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mobile-overview-more';
      toggle.dataset.moAction = 'more-past';
      const label = document.createElement('span');
      label.textContent = showAll ? 'Show fewer' : 'Show all past sessions';
      toggle.appendChild(label);
      if (!showAll) {
        const count = document.createElement('span');
        count.className = 'mobile-overview-more-count';
        count.setAttribute('data-i18n-skip', '');
        count.textContent = String(hiddenCount);
        toggle.appendChild(count);
      }
      children.push(toggle);
    }
    return children;
  },

  _buildMobileOverviewTop() {
    const wrap = document.createElement('div');
    wrap.className = 'mobile-overview-header';

    const top = document.createElement('div');
    top.className = 'mobile-overview-top';

    const brand = document.createElement('span');
    brand.className = 'mobile-overview-brand';
    brand.textContent = (window.CodemanI18n && window.CodemanI18n.displayName) || 'Codeman';
    brand.setAttribute('data-i18n-skip', '');
    top.appendChild(brand);

    // Split button carrying the TOOLBAR's own classes (`btn-toolbar btn-run
    // mode-<mode>` / `btn-run-gear`), so the per-backend gradient, border and
    // text color come from the same rules as the Run button in the toolbar and
    // stay in sync with it for free. mobile.css only sizes it.
    const group = document.createElement('div');
    group.className = 'mobile-overview-run-group';

    const mode = this.runMode || 'claude';
    const run = document.createElement('button');
    run.className = `btn-toolbar btn-run mode-${mode} mobile-overview-run`;
    run.type = 'button';
    run.dataset.moAction = 'run';
    const runLabel = document.createElement('span');
    runLabel.textContent = 'Run';
    run.appendChild(runLabel);
    const runMode = document.createElement('span');
    runMode.className = 'mobile-overview-run-mode';
    runMode.setAttribute('data-i18n-skip', '');
    runMode.textContent = MOBILE_OVERVIEW_RUN_MODES.find((m) => m.mode === mode)?.short || mode;
    run.appendChild(runMode);
    group.appendChild(run);

    const caret = document.createElement('button');
    caret.className = `btn-toolbar btn-run-gear mode-${mode} mobile-overview-run-caret`;
    caret.type = 'button';
    caret.dataset.moAction = 'run-menu';
    caret.setAttribute('aria-label', 'Choose what to run');
    caret.setAttribute('aria-expanded', String(!!this._mobileOverviewRunMenuOpen));
    // An SVG chevron, not a "⌄" glyph: the character carries its own baseline
    // offset, so it sits visibly low in a flex-centered box no matter what the
    // line-height says. A path is centered by geometry. Same shape the toolbar's
    // run-mode gear uses.
    caret.appendChild(this._buildMobileOverviewChevron());
    group.appendChild(caret);

    top.appendChild(group);
    wrap.appendChild(top);

    if (this._mobileOverviewRunMenuOpen) wrap.appendChild(this._buildMobileOverviewRunMenu());
    return wrap;
  },

  /** Down chevron as SVG (see the note at its call site). */
  _buildMobileOverviewChevron() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M6 9l6 6 6-6');
    svg.appendChild(path);
    return svg;
  },

  /**
   * The Run picker: the same backends as the toolbar's run-mode menu, plus saved
   * web tabs. Deliberately no "Recent Sessions" block, unlike the toolbar menu:
   * past conversations have their own section further down this screen.
   *
   * Gated the same way as the toolbar's #runModeMenu (isCliAvailable(), shell
   * exempt) — this list is a separate, hardcoded duplicate of the toolbar's menu
   * rather than a shared render, so it never picked up #201's gating and offered
   * every backend regardless of what's actually installed.
   */
  _buildMobileOverviewRunMenu() {
    const menu = document.createElement('div');
    menu.className = 'mobile-overview-run-menu';
    const current = this.runMode || 'claude';

    for (const entry of MOBILE_OVERVIEW_RUN_MODES) {
      if (entry.mode !== 'shell' && !this.isCliAvailable(entry.mode)) continue;
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'mobile-overview-run-option' + (entry.mode === current ? ' selected' : '');
      option.dataset.moAction = 'run-mode';
      option.dataset.moMode = entry.mode;
      const dot = document.createElement('span');
      dot.className = 'run-mode-dot ' + entry.mode;
      dot.setAttribute('aria-hidden', 'true');
      option.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = entry.label;
      option.appendChild(label);
      menu.appendChild(option);
    }

    const header = document.createElement('div');
    header.className = 'mobile-overview-run-header';
    header.textContent = 'Web / URL';
    menu.appendChild(header);

    for (const webview of this.webviews ? this.webviews.values() : []) {
      // Managed records are Codeman-owned shortcut state (the DeepSeek web UI
      // writes one), not saved dashboards: same filter as the desktop run menu,
      // or the phone picker lists a stale 127.0.0.1:<port> row that dies on the
      // next server restart with no affordance here to restart it.
      if (webview.managed) continue;
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'mobile-overview-run-option';
      option.dataset.moAction = 'run-webview';
      option.dataset.moWebview = webview.id;
      const dot = document.createElement('span');
      dot.className = 'run-mode-dot web';
      dot.setAttribute('aria-hidden', 'true');
      option.appendChild(dot);
      const label = document.createElement('span');
      // A dashboard name is user content.
      label.className = 'case-name';
      label.textContent = webview.name;
      option.appendChild(label);
      menu.appendChild(option);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mobile-overview-run-option mobile-overview-run-option--add';
    add.dataset.moAction = 'run-add-url';
    const addDot = document.createElement('span');
    addDot.className = 'run-mode-dot web';
    addDot.setAttribute('aria-hidden', 'true');
    add.appendChild(addDot);
    const addLabel = document.createElement('span');
    addLabel.textContent = 'Add URL…';
    add.appendChild(addLabel);
    menu.appendChild(add);

    return menu;
  },

  _buildMobileOverviewSection(title, count, children, emptyText) {
    const section = document.createElement('section');
    section.className = 'mobile-overview-section';

    const heading = document.createElement('h2');
    heading.className = 'mobile-overview-heading';
    const label = document.createElement('span');
    label.textContent = title;
    heading.appendChild(label);
    const badge = document.createElement('span');
    badge.className = 'mobile-overview-heading-count';
    badge.textContent = String(count);
    badge.setAttribute('data-i18n-skip', '');
    heading.appendChild(badge);
    section.appendChild(heading);

    if (!children.length && emptyText) {
      const empty = document.createElement('p');
      empty.className = 'mobile-overview-empty';
      empty.textContent = emptyText;
      section.appendChild(empty);
      return section;
    }
    for (const child of children) section.appendChild(child);
    return section;
  },

  /**
   * A session row. The state class drives the same visual language as the
   * session tabs: green dot when it is fine (pulsing while working), a yellow
   * blinking row when it wants input, a red blinking row when it asked a
   * question. Anything else here would mean two different meanings for the same
   * colors on one screen.
   */
  _buildMobileOverviewRow(row) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mobile-overview-row mobile-overview-row--' + row.state;
    item.dataset.moAction = 'session';
    item.dataset.moSession = row.id;

    const dot = document.createElement('span');
    dot.className = 'mobile-overview-dot mobile-overview-dot--' + row.state;
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    const body = document.createElement('span');
    body.className = 'mobile-overview-row-body';

    const line1 = document.createElement('span');
    line1.className = 'mobile-overview-row-title';
    const name = document.createElement('span');
    // .session-name is in the i18n skip list: a session name is user content.
    name.className = 'session-name';
    name.textContent = row.name;
    line1.appendChild(name);
    if (row.caseName) {
      const meta = document.createElement('span');
      meta.className = 'mobile-overview-row-case case-name';
      meta.textContent = ' · ' + row.caseName;
      line1.appendChild(meta);
    }
    body.appendChild(line1);

    const line2 = document.createElement('span');
    line2.className = 'mobile-overview-row-sub';
    line2.setAttribute('data-i18n-skip', '');
    line2.textContent = row.mode + (row.dir ? ' · ' + row.dir : '');
    body.appendChild(line2);

    body.appendChild(this._buildMobileOverviewMeta(row));

    item.appendChild(body);

    const pill = document.createElement('span');
    pill.className = 'mobile-overview-pill mobile-overview-pill--' + row.state;
    // Skipped by i18n on purpose: the labels are generic single words ("idle",
    // "done", "error") that collide with state strings on other surfaces.
    pill.setAttribute('data-i18n-skip', '');
    pill.textContent = row.pill;
    item.appendChild(pill);

    const chevron = document.createElement('span');
    chevron.className = 'mobile-overview-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    item.appendChild(chevron);

    // Approvals Inbox: a pending dialog for this session gets an answer strip
    // BELOW the row (the row itself is a <button>, so actions cannot nest
    // inside it). Tapping the row still opens the session, unchanged.
    const approval = this._pendingApprovalForSession(row.id);
    if (approval) {
      const wrap = document.createElement('div');
      wrap.className = 'mobile-overview-row-wrap';
      wrap.appendChild(item);
      wrap.appendChild(this._buildMobileOverviewApprovalStrip(approval));
      return wrap;
    }

    return item;
  },

  // ═══════════════════════════════════════════════════════════════
  // Age stamps: started / how long in this state
  // ═══════════════════════════════════════════════════════════════

  /**
   * The "started 3d ago · idle 12m" line under a session row. Both stamps keep
   * their raw epoch ms on the element (`data-mo-ts`) so `_tickMobileOverviewTimes()`
   * can rewrite the text without rebuilding the row (a re-render would restart
   * the blink on every waiting row and the pulse on every working one).
   */
  _buildMobileOverviewMeta(row) {
    const meta = document.createElement('span');
    meta.className = 'mobile-overview-row-meta';
    // Relative times are generated text, and "started"/"idle" here are the same
    // generic words that mean something else on other surfaces.
    meta.setAttribute('data-i18n-skip', '');

    meta.appendChild(this._buildMobileOverviewStamp('started', row.createdAt, 'ago', 'mobile-overview-meta-started'));

    if (row.since) {
      const sep = document.createElement('span');
      sep.className = 'mobile-overview-meta-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      meta.appendChild(sep);
      meta.appendChild(
        this._buildMobileOverviewStamp(row.since.key, row.since.at, 'for', 'mobile-overview-meta-since')
      );
    }

    return meta;
  },

  /** One labelled stamp: a dim key, the value, the full date in the title. */
  _buildMobileOverviewStamp(key, timestamp, format, className) {
    const wrap = document.createElement('span');
    wrap.className = 'mobile-overview-meta-item ' + className;

    const label = document.createElement('span');
    label.className = 'mobile-overview-meta-key';
    label.textContent = key;
    wrap.appendChild(label);

    const value = document.createElement('span');
    value.dataset.moTs = String(timestamp || 0);
    value.dataset.moFmt = format;
    value.textContent = this._mobileOverviewStampText(timestamp, format);
    wrap.appendChild(value);

    if (timestamp) wrap.title = `${key}: ${new Date(timestamp).toLocaleString()}`;
    return wrap;
  },

  /**
   * 'ago' points at a moment ("3d ago", the app's one relative formatter);
   * 'for' measures a span from it to now ("12m"), which is what a duration
   * beside a state word wants to read as.
   */
  _mobileOverviewStampText(timestamp, format) {
    if (!timestamp) return '—';
    if (format === 'ago') {
      return (this.formatRelativeTime && this.formatRelativeTime(timestamp)) || '—';
    }
    const ms = Date.now() - timestamp;
    if (ms < 60000) return '<1m';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
  },

  /**
   * Rewrites the stamps in place every `MOBILE_OVERVIEW_CLOCK_MS`. A sitting
   * session emits nothing, so without this its "idle 2m" would still read 2m an
   * hour later, the one number on the screen that has to move on its own.
   */
  _startMobileOverviewClock() {
    if (this._mobileOverviewClock) return;
    this._mobileOverviewClock = setInterval(() => {
      if (!this.isMobileOverviewVisible()) {
        this._stopMobileOverviewClock();
        return;
      }
      this._tickMobileOverviewTimes();
    }, MOBILE_OVERVIEW_CLOCK_MS);
  },

  _stopMobileOverviewClock() {
    if (!this._mobileOverviewClock) return;
    clearInterval(this._mobileOverviewClock);
    this._mobileOverviewClock = null;
  },

  _tickMobileOverviewTimes() {
    const el = document.getElementById('mobileOverview');
    if (!el) return;
    for (const node of el.querySelectorAll('[data-mo-ts]')) {
      const text = this._mobileOverviewStampText(Number(node.dataset.moTs) || 0, node.dataset.moFmt);
      if (node.textContent !== text) node.textContent = text;
    }
  },

  /** The session's pending approval, when the strip should render (dialogs only). */
  _pendingApprovalForSession(sessionId) {
    if (!this.approvals || !this.approvalsInboxEnabled || !this.approvalsInboxEnabled()) return null;
    for (const item of this.approvals.values()) {
      if (item.sessionId === sessionId && item.kind !== 'idle') return item;
    }
    return null;
  },

  /** Compact answer buttons for a NEEDS YOU row: parsed options, else Approve/Deny. */
  _buildMobileOverviewApprovalStrip(approval) {
    const strip = document.createElement('div');
    strip.className = 'mobile-overview-approval-strip';
    strip.setAttribute('data-i18n-skip', '');
    const addBtn = (label, cls, onTap) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mobile-overview-approval-btn' + (cls ? ' ' + cls : '');
      btn.textContent = label;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onTap();
      });
      strip.appendChild(btn);
    };
    if (approval.options && approval.options.length) {
      for (const o of approval.options) {
        const label = o.label.length > 24 ? o.label.slice(0, 24) + '…' : o.label;
        addBtn(`${o.n}. ${label}`, o.n === 1 ? 'primary' : '', () => this.answerApproval(approval.id, 'option', o.n));
      }
    } else {
      addBtn('Approve', 'primary', () => this.answerApproval(approval.id, 'approve'));
      addBtn('Deny', 'danger', () => this.answerApproval(approval.id, 'deny'));
    }
    return strip;
  },

  /** A past conversation. Tapping it resumes, which creates a fresh session. */
  _buildMobileOverviewPastRow(row) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mobile-overview-row mobile-overview-row--past';
    item.dataset.moAction = 'resume';
    item.dataset.moSession = row.id;

    const dot = document.createElement('span');
    dot.className = 'mobile-overview-dot mobile-overview-dot--past';
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    const body = document.createElement('span');
    body.className = 'mobile-overview-row-body';

    const title = document.createElement('span');
    // A first prompt is user content, never app copy.
    title.className = 'mobile-overview-row-title session-name';
    title.textContent = row.title;
    body.appendChild(title);

    const sub = document.createElement('span');
    sub.className = 'mobile-overview-row-sub';
    sub.setAttribute('data-i18n-skip', '');
    const when = row.at && this._formatTimeAgo ? this._formatTimeAgo(row.at) : '';
    sub.textContent = [row.caseName || row.dir, when].filter(Boolean).join(' · ');
    body.appendChild(sub);

    item.appendChild(body);

    const pill = document.createElement('span');
    pill.className = 'mobile-overview-pill mobile-overview-pill--past';
    pill.textContent = 'resume';
    pill.setAttribute('data-i18n-skip', '');
    item.appendChild(pill);

    const chevron = document.createElement('span');
    chevron.className = 'mobile-overview-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    item.appendChild(chevron);

    return item;
  },
});
