/**
 * @fileoverview The "sessions someone opened by hand" block on the home screen.
 *
 * A tmux session a human started (`tmux new -s work`, then `claude`, or just a
 * shell) is invisible to Codeman: it lives on the DEFAULT socket, not the
 * instance-scoped one Codeman owns. `GET /api/mux/foreign` finds those, and one
 * click wraps one in a Codeman tab (`POST /api/sessions/adopt`).
 *
 * ## One renderer, two containers
 *
 * The welcome screen and the phone overview both show this list. They call the
 * SAME `renderForeignSessions(container)` rather than each building rows, because
 * two renderers are how one surface ends up calling a session "shell" while the
 * other calls it "bash". Same reason `CodemanSessionOrder` is shared.
 *
 * ## Polling only while the home screen is up
 *
 * The list is a poll, not an SSE stream: the server caches a local scan on a TTL,
 * so N tabs polling costs one scan per TTL no matter how many are open. But an
 * open tab that has LEFT the home screen must stop — otherwise every background
 * tab keeps sweeping tmux sockets forever. `startForeignPolling` /
 * `stopForeignPolling` are called from `showWelcome`/`hideWelcome`.
 *
 * ⚠️ Docker and remote locations are NOT polled. Each costs a `docker exec` or a
 * full ssh handshake per target, and doing that on every home-screen load is the
 * one cost the server-side design explicitly refuses. They are fetched only when
 * the user asks, via the "scan containers & hosts" toggle, which then rides along
 * with the same poll.
 *
 * ⚠️ Adoption creates a REAL session, so the button locks while in flight and the
 * result goes through the app's normal idempotent create path
 * (`_onSessionCreated` then `selectSession`) — never by inserting a tab here.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (this.sessions, _onSessionCreated, selectSession, _apiJson)
 * @dependency api-client.js (_apiJson / _apiPost envelope unwrapping)
 * @dependency ralph-panel.js (formatRelativeTime)
 * @loadorder 12.57 of 16, after home-sessions.js, before entrance-animations.js
 */

/** Fallback poll cadence; the server sends its own in `pollIntervalMs`. */
const FOREIGN_POLL_FALLBACK_MS = 8000;

/** Mode label shown on a row. Deliberately the same words the tab strip uses. */
const FOREIGN_MODE_LABEL = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  pi: 'Pi',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  shell: 'Shell',
};

const FOREIGN_LOCATION_LABEL = {
  local: 'this machine',
  docker: 'container',
  remote: 'remote',
};

Object.assign(CodemanApp.prototype, {
  // ═══════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════

  /**
   * Begin polling. Idempotent: the home screen re-shows on several paths
   * (boot, closing the last tab, a breakpoint change) and each would otherwise
   * stack another interval on top of the last.
   */
  startForeignPolling() {
    if (this._foreignPollTimer) return;
    void this.loadForeignSessions();
    this._foreignPollTimer = setInterval(() => {
      void this.loadForeignSessions();
    }, this._foreignPollMs || FOREIGN_POLL_FALLBACK_MS);
  },

  /** Stop polling. MUST run on leaving the home screen — see @fileoverview. */
  stopForeignPolling() {
    if (!this._foreignPollTimer) return;
    clearInterval(this._foreignPollTimer);
    this._foreignPollTimer = null;
  },

  /** Whether the user asked for the expensive docker/remote scan too. */
  foreignScanRemote() {
    return this._foreignScanRemote === true;
  },

  toggleForeignScanRemote() {
    this._foreignScanRemote = !this._foreignScanRemote;
    void this.loadForeignSessions();
  },

  // ═══════════════════════════════════════════════════════════════
  // Data
  // ═══════════════════════════════════════════════════════════════

  async loadForeignSessions() {
    const wide = this.foreignScanRemote();
    const qs = wide ? '?docker=1&remote=1' : '';
    const data = await this._apiJson(`/api/mux/foreign${qs}`);
    if (!data) {
      // A failed poll must not blank a list the user is looking at: keep the
      // last good result and let the next tick recover.
      this._foreignError = true;
      this.renderAllForeignSessions();
      return;
    }
    this._foreignError = false;
    this._foreignSessions = Array.isArray(data.sessions) ? data.sessions : [];
    this._foreignNotes = Array.isArray(data.notes) ? data.notes : [];
    this._foreignCanScanWide = data.canScanWide === true;
    if (Number.isFinite(data.pollIntervalMs)) this._foreignPollMs = data.pollIntervalMs;
    this.renderAllForeignSessions();
  },

  /**
   * Adopt one candidate.
   *
   * The in-flight lock is per BUTTON, not global: two different foreign sessions
   * can legitimately be adopted back to back. The server holds the real
   * one-wrapper-per-target guarantee; this only stops a double-click.
   */
  async adoptForeignSession(id, buttonEl) {
    if (this._foreignAdoptInFlight) return;
    this._foreignAdoptInFlight = true;
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = codemanT ? codemanT('Opening…') : 'Opening…';
    }
    try {
      const body = { id };
      if (this.foreignScanRemote()) {
        body.docker = true;
        body.remote = true;
      }
      const data = await this._apiJson('/api/sessions/adopt', { method: 'POST', body });
      if (!data || !data.session) {
        this.showToast?.(
          codemanT
            ? codemanT('That session is gone. Refreshing the list.')
            : 'That session is gone. Refreshing the list.',
          'error'
        );
        await this.loadForeignSessions();
        return;
      }
      // Go through the app's normal create path so tab order, lineage lines and
      // SSE-vs-POST ordering behave exactly as they do for a Run.
      this._onSessionCreated?.(data.session);
      await this.selectSession(data.session.id);
      await this.loadForeignSessions();
    } finally {
      this._foreignAdoptInFlight = false;
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.textContent = codemanT ? codemanT('Open') : 'Open';
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════

  /** Paint every mounted container (welcome + phone overview). */
  renderAllForeignSessions() {
    for (const id of ['foreignSessions', 'mobileForeignSessions']) {
      const el = document.getElementById(id);
      if (el) this.renderForeignSessions(el);
    }
  },

  /**
   * Render into one container. The ONLY row builder — see @fileoverview.
   *
   * Everything is built with DOM APIs and `textContent`: a session name and a
   * command line come from another user's process, so they are never allowed
   * near `innerHTML`.
   */
  renderForeignSessions(container) {
    const rows = Array.isArray(this._foreignSessions) ? this._foreignSessions : [];
    container.innerHTML = '';

    if (!rows.length) {
      // Hidden rather than shown-empty: on a first run there is usually nothing,
      // and an empty block on the welcome screen reads as a broken feature.
      // A note is a REASON the list is empty, so a block carrying one must stay
      // visible — hiding it is exactly how "where did my session go" becomes
      // unanswerable.
      const hasNotes = Array.isArray(this._foreignNotes) && this._foreignNotes.length > 0;
      // ⚠️ `canScanWide` must keep the block visible even with nothing to show.
      // The scan toggle lives in the header, so hiding an empty block also hides
      // the only control that could fill it — on a host with containers but no
      // local tmux sessions that made the whole feature unreachable.
      container.hidden = !this.foreignScanRemote() && !this._foreignError && !hasNotes && !this._foreignCanScanWide;
      if (!container.hidden) {
        container.appendChild(this._foreignHeader(0));
        const empty = document.createElement('div');
        empty.className = 'foreign-empty';
        this._appendForeignNotes(container);
        empty.textContent = this._foreignError
          ? codemanT
            ? codemanT('Could not reach the server.')
            : 'Could not reach the server.'
          : codemanT
            ? codemanT('No sessions found outside Codeman.')
            : 'No sessions found outside Codeman.';
        container.appendChild(empty);
      }
      return;
    }

    container.hidden = false;
    container.appendChild(this._foreignHeader(rows.length));

    this._appendForeignNotes(container);

    const list = document.createElement('div');
    list.className = 'foreign-list';
    // Adoptable first: an already-open one is not an action, it is a reminder.
    const sorted = rows.slice().sort((a, b) => {
      const aOpen = a.adoptedBy ? 1 : 0;
      const bOpen = b.adoptedBy ? 1 : 0;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    for (const row of sorted) list.appendChild(this._foreignRow(row));
    container.appendChild(list);
  },

  /**
   * Why a scan produced less than the user expected.
   *
   * Without this, a session skipped for an unsafe name or a host that could not
   * be reached is simply ABSENT, and "my tmux session does not show up" has no
   * answer anywhere in the product. Notes are server-authored strings, rendered
   * as text.
   */
  _appendForeignNotes(container) {
    const notes = Array.isArray(this._foreignNotes) ? this._foreignNotes : [];
    if (!notes.length) return;
    const box = document.createElement('div');
    box.className = 'foreign-notes';
    box.setAttribute('data-i18n-skip', '');
    for (const n of notes) {
      const line = document.createElement('div');
      line.className = 'foreign-note';
      line.textContent = n;
      box.appendChild(line);
    }
    container.appendChild(box);
  },

  _foreignHeader(count) {
    const header = document.createElement('div');
    header.className = 'foreign-header';

    const title = document.createElement('h3');
    title.className = 'foreign-title';
    title.textContent = codemanT ? codemanT('Opened outside Codeman') : 'Opened outside Codeman';
    header.appendChild(title);

    if (count) {
      const badge = document.createElement('span');
      badge.className = 'foreign-count';
      badge.setAttribute('data-i18n-skip', '');
      badge.textContent = String(count);
      header.appendChild(badge);
    }

    const scan = document.createElement('button');
    scan.type = 'button';
    scan.className = 'foreign-scan-toggle';
    scan.dataset.foreignAction = 'toggle-scan';
    scan.setAttribute('aria-pressed', String(this.foreignScanRemote()));
    scan.title = codemanT
      ? codemanT('Also scan containers and remote hosts (slower)')
      : 'Also scan containers and remote hosts (slower)';
    scan.textContent = this.foreignScanRemote() ? '⟳ all' : '⟳ local';
    header.appendChild(scan);

    return header;
  },

  _foreignRow(row) {
    const item = document.createElement('div');
    item.className = 'foreign-row';
    if (row.adoptedBy) item.classList.add('foreign-row--open');

    const dot = document.createElement('span');
    dot.className = `foreign-dot foreign-dot--${row.mode || 'shell'}`;
    item.appendChild(dot);

    const body = document.createElement('span');
    body.className = 'foreign-row-body';

    const line1 = document.createElement('span');
    line1.className = 'foreign-row-name';
    line1.setAttribute('data-i18n-skip', '');
    line1.textContent = row.sessionName || '(unnamed)';
    body.appendChild(line1);

    const line2 = document.createElement('span');
    line2.className = 'foreign-row-sub';
    line2.setAttribute('data-i18n-skip', '');
    const bits = [FOREIGN_MODE_LABEL[row.mode] || row.mode];
    const where = row.hostLabel || FOREIGN_LOCATION_LABEL[row.location] || row.location;
    if (where) bits.push(where);
    if (row.workingDir) bits.push(row.workingDir);
    line2.textContent = bits.join(' · ');
    line2.title = row.command || '';
    body.appendChild(line2);

    item.appendChild(body);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'foreign-open-btn';
    if (row.adoptedBy) {
      action.dataset.foreignAction = 'select';
      action.dataset.foreignSession = row.adoptedBy;
      action.textContent = codemanT ? codemanT('Go to tab') : 'Go to tab';
    } else {
      action.dataset.foreignAction = 'adopt';
      action.dataset.foreignId = row.id;
      action.textContent = codemanT ? codemanT('Open') : 'Open';
    }
    item.appendChild(action);

    return item;
  },

  /**
   * One delegated listener per container, wired once. Delegation matters here
   * because the list is fully rebuilt on every poll — per-button listeners would
   * leak one set per tick.
   */
  wireForeignSessions() {
    if (this._foreignWired) return;
    this._foreignWired = true;
    document.addEventListener('click', (event) => {
      const el = event.target?.closest?.('[data-foreign-action]');
      if (!el) return;
      const action = el.dataset.foreignAction;
      if (action === 'adopt') {
        void this.adoptForeignSession(el.dataset.foreignId, el);
      } else if (action === 'select') {
        void this.selectSession(el.dataset.foreignSession);
      } else if (action === 'toggle-scan') {
        this.toggleForeignScanRemote();
      }
    });
  },
});
