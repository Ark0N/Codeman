/**
 * @fileoverview Desktop home screen session list: the open tabs as a rail docked
 * down the left edge of the welcome overlay.
 *
 * The welcome screen centers ~560px of content in a window that is usually
 * 1400px+, so the two gutters are dead space. The left one now carries the same
 * list a phone gets on its home screen (mobile-overview.js), turned vertical:
 * one row per live tab.
 *
 * Rows are ordered by `CodemanSessionOrder` (constants.js), the same comparator
 * the phone overview uses: blocked on you first, then running longest-first,
 * then quiet most-recently-quiet first. The number badge stays the tab-strip
 * index (Alt+1..9), so it is deliberately NOT sequential down a sorted rail:
 * it names a shortcut, not a row position.
 *
 * DESKTOP ONLY, and only in a wide enough window: the rail is absolutely
 * positioned so the centered welcome content never moves, which means it can
 * only exist where the gutter is genuinely wider than the rail. Below
 * `HOME_SESSIONS_MIN_WIDTH` nothing renders; on a phone the mobile overview owns
 * the home screen entirely and this surface stays out of its way. Width and type
 * both scale with the viewport (see the `.home-sessions` block in styles.css) —
 * a fixed 256px card looks abandoned on a 2560px display.
 *
 * Each row carries when the session was FIRST CREATED and how long it has been
 * in the state it is in ("created 3d ago · working 12m"), and that second stamp is
 * the value the order above is computed from, so the rail explains itself
 * rather than looking arbitrarily shuffled. Both stamps go stale on their own
 * (a sitting session emits no event), so a slow clock refreshes them IN PLACE
 * from the epoch-ms values parked on the elements, rather than re-rendering: a
 * re-render would restart every row's blink animation and its working ring.
 *
 * The working state is deliberately identical to the phone's: a pulsing green
 * dot ringed by the spinner a tab shows while it loads (`tab-load-spin`, reused
 * from styles.css), plus a green halo. Same signal, same motion, both surfaces.
 *
 * Everything renders from state the page already holds (`this.sessions`,
 * `this.cases`, `this.pendingHooks`, `this.webviews`) — no endpoint, no SSE
 * event, no schema. State classification and case matching are reused from
 * mobile-overview.js rather than re-derived, so the two home screens can never
 * disagree about what "working" means.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (this.sessions, this.cases, this.pendingHooks, selectSession)
 * @dependency constants.js (CodemanSessionOrder, the shared row comparator)
 * @dependency mobile-overview.js (_mobileOverviewState, _mobileOverviewCaseFor, shouldUseMobileOverview)
 * @dependency ralph-panel.js (formatRelativeTime — the app's one relative-time formatter)
 * @dependency webview-tabs.js (this.webviews, this.webviewOrder, openWebview)
 * @dependency mobile-handlers.js (MobileDetection)
 * @loadorder 12.56 of 16, after mobile-overview.js, before entrance-animations.js
 */

/**
 * Narrowest window that gets the rail. The welcome content is 560px wide and
 * centered, so at 1180px each gutter is 310px, enough for the rail at its
 * 250px floor and still a visible gap. Anything narrower would overlap the
 * search panel, which is why this is a width gate and not a device-type gate.
 */
const HOME_SESSIONS_MIN_WIDTH = 1180;

/** How often the relative stamps are rewritten while the home screen is up. */
const HOME_SESSIONS_CLOCK_MS = 20000;

/** Pill copy per state. Same words as the phone overview, same reasons. */
const HOME_SESSIONS_PILL_LABEL = {
  needs: 'needs you',
  error: 'error',
  waiting: 'waiting',
  working: 'working',
  idle: 'idle',
  done: 'done',
};

/** Short backend badge, mirroring `.tab-mode` in the tab strip. */
const HOME_SESSIONS_MODE_BADGE = {
  shell: 'sh',
  opencode: 'oc',
  codex: 'cx',
  gemini: 'gm',
  antigravity: 'ag',
  pi: 'pi',
  grok: 'gk',
  deepseek: 'ds',
  omp: 'om',
};

Object.assign(CodemanApp.prototype, {
  // ═══════════════════════════════════════════════════════════════
  // Gate + visibility
  // ═══════════════════════════════════════════════════════════════

  /**
   * Width-driven, like every other layout decision in the app. Explicitly yields
   * to the phone overview and persistent vertical tab rail: those surfaces already
   * list the same sessions, and two lists of the same thing on one screen is worse
   * than none.
   */
  shouldShowHomeSessions() {
    if (this.isSoloWindow) return false;
    if (this.shouldUseMobileOverview?.()) return false;
    if (document.documentElement.getAttribute('data-tab-orientation') === 'vertical') return false;
    // The sidebar layout already docks the full session list flush left at full
    // height — the rail would render the same list right next to it (and z-wise
    // UNDER it: sidebar 11, welcome overlay 10, rail inside the overlay).
    if (this.isSessionSidebarActive?.()) return false;
    return window.innerWidth >= HOME_SESSIONS_MIN_WIDTH;
  },

  /** True while the column is the visible home surface. */
  isHomeSessionsVisible() {
    const el = document.getElementById('homeSessions');
    return !!el && !el.hidden;
  },

  showHomeSessions() {
    const el = document.getElementById('homeSessions');
    if (!el) return;
    this._wireHomeSessions(el);
    if (!this.shouldShowHomeSessions()) {
      el.hidden = true;
      this._stopHomeSessionsClock();
      return;
    }
    el.hidden = false;
    this.renderHomeSessions();
  },

  hideHomeSessions() {
    const el = document.getElementById('homeSessions');
    if (el) el.hidden = true;
    this._stopHomeSessionsClock();
  },

  /** Re-render only when showing (called from the tab renderer's tail). */
  _refreshHomeSessionsIfVisible() {
    if (!this.isHomeSessionsVisible()) return;
    this._debouncedCall('homeSessions', () => this.renderHomeSessions(), 150);
  },

  /**
   * One delegated click listener for every row, plus a width listener so
   * resizing the window while on the home screen adds or drops the column
   * instead of leaving it overlapping the content it was sized to clear.
   */
  _wireHomeSessions(el) {
    if (this._homeSessionsWired) return;
    this._homeSessionsWired = true;

    el.addEventListener('click', (event) => {
      const target = event.target?.closest?.('[data-hs-action]');
      if (!target) return;
      if (target.dataset.hsAction === 'session') {
        void this.selectSession(target.dataset.hsSession);
      } else if (target.dataset.hsAction === 'webview') {
        void this.openWebview?.(target.dataset.hsWebview);
      }
    });

    if (window.matchMedia) {
      const mq = window.matchMedia(`(min-width: ${HOME_SESSIONS_MIN_WIDTH}px)`);
      const onChange = () => {
        // Only relevant while the welcome screen is up; entering a session
        // re-decides through hideWelcome()/showWelcome() anyway.
        if (this.activeSessionId) return;
        const overlay = document.getElementById('welcomeOverlay');
        if (!overlay || !overlay.classList.contains('visible')) return;
        this.showHomeSessions();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Model
  // ═══════════════════════════════════════════════════════════════

  /**
   * One row per live session, in overview order: whatever is blocked on you
   * first, then whatever is running (longest turn first), then the quiet ones
   * most-recently-quiet first. The comparator is `CodemanSessionOrder`
   * (constants.js), shared with the phone overview, and state classification is
   * `_mobileOverviewState()` (mobile-overview.js), so the two home screens can
   * neither disagree about what "working" means nor about what sorts first.
   *
   * `orderIndex` stays the position in the TAB STRIP, because that is what the
   * number badge means (Alt+1..9). Once the rows are sorted those badges no
   * longer run 1,2,3 down the rail: the badge answers "which key selects this",
   * not "how far down the list is it".
   *
   * @returns {Array<object>} row descriptors, ready to render
   */
  buildHomeSessionRows() {
    const cases = Array.isArray(this.cases) ? this.cases : [];
    const order = Array.isArray(this.sessionOrder) ? this.sessionOrder : [];
    const ids = order.filter((id) => this.sessions?.has(id));
    // A session created before the order list caught up would otherwise be
    // invisible here while its tab already exists.
    for (const id of this.sessions?.keys() || []) if (!ids.includes(id)) ids.push(id);

    const rows = ids.map((id, orderIndex) => {
      const session = this.sessions.get(id);
      const matched = this._mobileOverviewCaseFor(session.workingDir, cases);
      const state = this._mobileOverviewState(session, this.pendingHooks?.get(id));
      const mode = session.mode || 'claude';
      return {
        id,
        orderIndex,
        name: this.getSessionName ? this.getSessionName(session) : session.name || id.slice(0, 8),
        mode,
        modeBadge: HOME_SESSIONS_MODE_BADGE[mode] || '',
        caseName: matched ? matched.name : '',
        dir: this._shortenHomePath ? this._shortenHomePath(session.workingDir) : session.workingDir || '',
        state,
        pill: HOME_SESSIONS_PILL_LABEL[state] || state,
        // What the pane's footer says is still running in the background, straight off
        // the session payload. Same field, same meaning as on the phone overview.
        watching: typeof session.watching === 'string' ? session.watching : '',
        // Epoch ms, straight off the session payload; formatting happens at
        // render time so the clock below can redo it without a re-render.
        createdAt: Number(session.createdAt) || 0,
        lastActivityAt: Number(session.lastActivityAt) || 0,
        // The running group is ordered by the pane's last Enter, since a
        // working pane's last-activity stamp is always "now".
        lastSubmitAt: Number(session.lastSubmitAt) || 0,
        // "how long has it been like this", resolved by the phone overview's
        // helper so both home screens label the same stamp with the same word.
        since: this._mobileOverviewSince(state, session),
      };
    });

    // Guarded like every other constants.js consumer: a stale cached
    // constants.js (iOS Safari serves old JS after a deploy) must degrade to
    // tab order, not TypeError the whole home screen away.
    return window.CodemanSessionOrder ? window.CodemanSessionOrder.sort(rows) : rows;
  },

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════

  renderHomeSessions() {
    const el = document.getElementById('homeSessions');
    if (!el) return;

    const rows = this.buildHomeSessionRows();
    const webviews = (this.webviewOrder || []).map((id) => this.webviews?.get(id)).filter(Boolean);

    // Nothing open means nothing to list: an empty framed box next to a
    // first-run welcome screen is noise, not information.
    if (!rows.length && !webviews.length) {
      el.hidden = true;
      el.replaceChildren();
      this._stopHomeSessionsClock();
      return;
    }
    el.hidden = false;

    el.replaceChildren();
    el.appendChild(this._buildHomeSessionsHeader(rows.length + webviews.length));

    const list = document.createElement('div');
    list.className = 'home-sessions-list';
    for (const row of rows) list.appendChild(this._buildHomeSessionRow(row));
    for (const webview of webviews) list.appendChild(this._buildHomeSessionsWebviewRow(webview));
    el.appendChild(list);

    this._startHomeSessionsClock();
  },

  // ═══════════════════════════════════════════════════════════════
  // Age stamps: created / last active
  // ═══════════════════════════════════════════════════════════════

  /**
   * The "created 2h ago · working 12m" footer line. Both stamps keep their raw
   * epoch-ms on the element (`data-hs-ts`) so `_tickHomeSessionsTimes()` can
   * rewrite the text without rebuilding the row.
   *
   * The second stamp is the row's state duration, NOT a plain last-active
   * stamp: it is the number the rail is sorted by, and a working row that reads
   * "active just now" (every working pane repaints about once a second) hides
   * exactly the value that decided its position. `_mobileOverviewSince()` owns
   * both the word and the anchor, so the phone says the same thing.
   */
  _buildHomeSessionsMeta(row) {
    const meta = document.createElement('span');
    meta.className = 'home-sessions-row-meta';
    // Relative times are generated text, and "created"/"idle" here are the
    // same generic words that mean something else on other surfaces.
    meta.setAttribute('data-i18n-skip', '');

    meta.appendChild(this._buildHomeSessionsStamp('created', row.createdAt, 'ago', 'home-sessions-meta-created'));

    if (row.since) {
      const sep = document.createElement('span');
      sep.className = 'home-sessions-meta-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      meta.appendChild(sep);

      meta.appendChild(this._buildHomeSessionsStamp(row.since.key, row.since.at, 'for', 'home-sessions-meta-since'));
    }

    return meta;
  },

  /** One labelled stamp: a dim key, the value, full date in the title. */
  _buildHomeSessionsStamp(key, timestamp, format, className) {
    const wrap = document.createElement('span');
    wrap.className = `home-sessions-meta-item ${className}`;

    const label = document.createElement('span');
    label.className = 'home-sessions-meta-key';
    label.textContent = key;
    wrap.appendChild(label);

    const value = document.createElement('span');
    value.dataset.hsTs = String(timestamp || 0);
    value.dataset.hsFmt = format;
    value.textContent = this._homeSessionsStampText(timestamp, format);
    wrap.appendChild(value);

    if (timestamp) wrap.title = `${key === 'created' ? 'First created' : key}: ${new Date(timestamp).toLocaleString()}`;
    return wrap;
  },

  /**
   * 'ago' points at a moment ("3d ago"), 'for' measures a span to now ("12m").
   * Both come from the phone overview's formatter, so a duration is written the
   * same way on both home screens.
   */
  _homeSessionsStampText(timestamp, format) {
    return this._mobileOverviewStampText(timestamp, format);
  },

  /**
   * Rewrites the stamps in place every `HOME_SESSIONS_CLOCK_MS`. In place, not a
   * re-render: replacing the rows would restart the blink animation on every
   * waiting row and the ring on every working one, twice a minute, for nothing.
   */
  _startHomeSessionsClock() {
    if (this._homeSessionsClock) return;
    this._homeSessionsClock = setInterval(() => {
      if (!this.isHomeSessionsVisible()) {
        this._stopHomeSessionsClock();
        return;
      }
      this._tickHomeSessionsTimes();
    }, HOME_SESSIONS_CLOCK_MS);
  },

  _stopHomeSessionsClock() {
    if (!this._homeSessionsClock) return;
    clearInterval(this._homeSessionsClock);
    this._homeSessionsClock = null;
  },

  _tickHomeSessionsTimes() {
    const el = document.getElementById('homeSessions');
    if (!el) return;
    for (const node of el.querySelectorAll('[data-hs-ts]')) {
      const ts = Number(node.dataset.hsTs) || 0;
      const text = this._homeSessionsStampText(ts, node.dataset.hsFmt);
      if (node.textContent !== text) node.textContent = text;
    }
  },

  _buildHomeSessionsHeader(count) {
    const header = document.createElement('div');
    header.className = 'home-sessions-header';

    const label = document.createElement('span');
    label.className = 'home-sessions-title';
    label.textContent = 'Open tabs';
    header.appendChild(label);

    const badge = document.createElement('span');
    badge.className = 'home-sessions-count';
    badge.setAttribute('data-i18n-skip', '');
    badge.textContent = String(count);
    header.appendChild(badge);

    return header;
  },

  /**
   * A session row. The state class drives the same visual language as the
   * session tabs and the phone overview: green dot when it is fine (pulsing and
   * ringed by the load spinner while working), a yellow row when it wants input,
   * a red row when it asked a question.
   */
  _buildHomeSessionRow(row) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'home-sessions-row home-sessions-row--' + row.state;
    item.dataset.hsAction = 'session';
    item.dataset.hsSession = row.id;
    item.title = row.dir ? `${row.name} (${row.dir})` : row.name;

    // The badge is the Alt+N key for this tab, so it keeps the tab-strip index
    // even though the rows are sorted by activity: it will not read 1,2,3 down
    // the rail, and must not, or the shortcut it names would be wrong.
    if (row.orderIndex < 9) {
      const number = document.createElement('span');
      number.className = 'home-sessions-number';
      number.setAttribute('data-i18n-skip', '');
      number.textContent = String(row.orderIndex + 1);
      item.appendChild(number);
    }

    const dot = document.createElement('span');
    dot.className = 'home-sessions-dot home-sessions-dot--' + row.state;
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    const body = document.createElement('span');
    body.className = 'home-sessions-row-body';

    const line1 = document.createElement('span');
    line1.className = 'home-sessions-row-title';
    if (row.modeBadge) {
      const badge = document.createElement('span');
      badge.className = `home-sessions-mode ${row.mode}`;
      badge.setAttribute('data-i18n-skip', '');
      badge.textContent = row.modeBadge;
      line1.appendChild(badge);
    }
    const name = document.createElement('span');
    // .session-name is in the i18n skip list: a session name is user content.
    name.className = 'session-name';
    name.textContent = row.name;
    line1.appendChild(name);
    body.appendChild(line1);

    const line2 = document.createElement('span');
    line2.className = 'home-sessions-row-sub';
    line2.setAttribute('data-i18n-skip', '');
    line2.textContent = row.caseName || row.dir || row.mode;
    body.appendChild(line2);

    item.appendChild(body);

    const pill = document.createElement('span');
    pill.className = 'home-sessions-pill home-sessions-pill--' + row.state;
    // Skipped by i18n on purpose: generic single words ("idle", "done", "error")
    // that collide with state strings on other surfaces.
    pill.setAttribute('data-i18n-skip', '');
    pill.textContent = row.pill;

    // The stamps line wraps onto its own full-width line (the row is flex-wrap)
    // and the pill rides along at its right end, rather than sitting beside the
    // name: that hands the whole width of the rail to the session name, which is
    // what stops it ellipsizing.
    const meta = this._buildHomeSessionsMeta(row);
    meta.appendChild(pill);
    // Built by the phone overview so both home screens word the badge identically.
    // Guarded like every other cross-file call here: a stale cached mobile-overview.js
    // must cost the badge, not the rail.
    if (row.watching && typeof this._buildWatchingBadge === 'function') {
      meta.appendChild(this._buildWatchingBadge(row.watching, 'home-sessions-pill'));
    }
    item.appendChild(meta);

    return item;
  },

  /** A saved dashboard, listed after the sessions exactly as in the tab strip. */
  _buildHomeSessionsWebviewRow(webview) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'home-sessions-row home-sessions-row--web';
    item.dataset.hsAction = 'webview';
    item.dataset.hsWebview = webview.id;
    item.title = webview.url || webview.name;

    const dot = document.createElement('span');
    dot.className = 'home-sessions-dot home-sessions-dot--web';
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    const body = document.createElement('span');
    body.className = 'home-sessions-row-body';

    const title = document.createElement('span');
    title.className = 'home-sessions-row-title';
    const name = document.createElement('span');
    // A dashboard name is user content.
    name.className = 'case-name';
    name.textContent = webview.name;
    title.appendChild(name);
    body.appendChild(title);

    const sub = document.createElement('span');
    sub.className = 'home-sessions-row-sub';
    sub.setAttribute('data-i18n-skip', '');
    sub.textContent = webview.url || '';
    body.appendChild(sub);

    item.appendChild(body);

    const pill = document.createElement('span');
    pill.className = 'home-sessions-pill home-sessions-pill--web';
    pill.setAttribute('data-i18n-skip', '');
    pill.textContent = 'web';

    // Same bottom line as a session row (minus the stamps, a dashboard has
    // none), so the pill sits in the same place on every row in the rail.
    const foot = document.createElement('span');
    foot.className = 'home-sessions-row-meta';
    foot.setAttribute('data-i18n-skip', '');
    foot.appendChild(pill);
    item.appendChild(foot);

    return item;
  },
});
