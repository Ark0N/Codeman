/**
 * @fileoverview Edit history: a header button (next to Attachments) and the floating panel it opens
 * right below, listing every file edit the ACTIVE session's agent (and its subagents) made, newest
 * first.
 *
 * OPTIONAL and per-device: `showEditHistory` (App Settings → Header & Panels → Header), default
 * OFF. While it is off the button never shows and nothing is requested. The panel DRIVES the
 * server's reading, which never runs in the background: it reads
 * `GET /api/sessions/:id/edits?sync=1` when it opens and when the active session changes, and,
 * only while it is open, re-reads (debounced) on the active session's `transcript:tool_end` for a
 * tool that can change files (the existing transcript watcher's event) and on its `session:idle`
 * (the end of a turn). No poll, and nothing at all while the panel is closed. A remote session has
 * no transcript watcher (no hooks reach back from its host), so it follows turn ends only.
 *
 * - A code entry opens its diff inline (`GET /api/sessions/:id/edits/:entryId`), drawn with the Git
 *   panel's diff classes (`git-diff`, `git-diff-line--hunk|add|del`).
 * - An image entry opens the shared file preview (panels-ui.js `openFilePreview`), as does a click
 *   on any path; inside a local session's workspace it also shows a thumbnail (a remote one would
 *   stream every listed image over ssh). Both go through the existing file
 *   routes only: the thumbnail is the confined `file-raw`, and the preview of a file outside the
 *   workspace registers it on click with `notify: false` (`_registerExternalPreview`, which
 *   enforces the attachment guard and its extension allowlist). A path from the transcript is
 *   never served by a route of its own.
 * - `backfillTruncated` offers "Load older" (`POST /api/sessions/:id/edits/older`).
 *
 * Paths, agent descriptions and diffs are untrusted text: they are only ever written with
 * `textContent`, never `innerHTML`.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (this.activeSessionId, this.sessions, this.loadAppSettingsFromStorage, this.getDefaultSettings, this.$)
 * @dependency api-client.js (this._api, this._apiJson; resolved at call time)
 * @dependency panels-ui.js (openFilePreview, _isExternalPreviewPath)
 * @dependency i18n.js (window.codemanT)
 * @loadorder 12.58 of 16, after git-status-ui.js, before entrance-animations.js
 */

/** SSE bursts (one event per tool call) collapse into one read. */
const EDIT_HISTORY_SSE_DEBOUNCE_MS = 600;
/** Tools whose end can mean changed files (Agent/Task: a subagent's edits; SendUserFile: an image). */
const EDIT_HISTORY_FOLLOW_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'Agent',
  'Task',
  'SendUserFile',
]);
/** Per-device view toggles (a viewer convenience, so plain localStorage). */
const EDIT_HISTORY_GROUP_KEY = 'codeman-edit-history-group';
const EDIT_HISTORY_MAIN_ONLY_KEY = 'codeman-edit-history-main-only';

Object.assign(CodemanApp.prototype, {
  /** Per-device setting, default OFF. */
  isEditHistoryEnabled() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    return (settings.showEditHistory ?? defaults.showEditHistory ?? false) === true;
  },

  /** Translate an English source string (i18n.js), with `{var}` interpolation. */
  _eht(source, vars) {
    if (typeof window.codemanT === 'function') return window.codemanT(source, vars);
    return vars ? source.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : source;
  },

  /** A row badge ("new"/"edit") through its scoped i18n key; English shows the bare word. */
  _ehBadge(word) {
    const key = `Edit history badge: ${word}`;
    const out = this._eht(key);
    return out === key ? word : out;
  },

  /** Called from applyHeaderVisibilitySettings() (boot and every settings save). */
  applyEditHistoryVisibility() {
    const on = this.isEditHistoryEnabled();
    // Marker class, not [hidden]: the base rule is display:inline-flex !important (src/web/CLAUDE.md).
    this.$('editHistoryBtn')?.classList.toggle('btn-edit-history--hidden', !on);
    if (!on) {
      this.closeEditHistoryPanel();
      this._editHistory = null;
      this._editHistoryEpoch = (this._editHistoryEpoch || 0) + 1; // an in-flight read must not repaint
      clearTimeout(this._editHistoryDebounce);
      this._editHistoryDebounce = null;
    }
  },

  // ── Per-device view toggles ─────────────────────────────────────────────

  _editHistoryPref(key) {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  },

  _setEditHistoryPref(key, on) {
    try {
      localStorage.setItem(key, on ? '1' : '0');
    } catch {
      /* private window / blocked storage: the toggle still works for this page */
    }
  },

  isEditHistoryGrouped() {
    return this._editHistoryGroupOn ?? (this._editHistoryGroupOn = this._editHistoryPref(EDIT_HISTORY_GROUP_KEY));
  },

  isEditHistoryMainOnly() {
    return this._editHistoryMainOnly ?? (this._editHistoryMainOnly = this._editHistoryPref(EDIT_HISTORY_MAIN_ONLY_KEY));
  },

  setEditHistoryGrouped(on) {
    this._editHistoryGroupOn = !!on;
    this._setEditHistoryPref(EDIT_HISTORY_GROUP_KEY, !!on);
    this._renderEditHistoryPanel();
  },

  setEditHistoryMainOnly(on) {
    this._editHistoryMainOnly = !!on;
    this._setEditHistoryPref(EDIT_HISTORY_MAIN_ONLY_KEY, !!on);
    this._renderEditHistoryPanel();
  },

  // ── Data ────────────────────────────────────────────────────────────────

  /** The data for the session on screen, or null. */
  _currentEditHistory() {
    const h = this._editHistory;
    return h && h.sessionId === this.activeSessionId ? h : null;
  },

  _editHistoryBase(sid) {
    return `/api/sessions/${encodeURIComponent(sid)}/edits`;
  },

  /**
   * Read the active session's history and repaint. `older` asks the server for entries before the
   * backfill window (POST), otherwise the normal read. Answers for another session are dropped.
   */
  async refreshEditHistory({ older = false } = {}) {
    if (!this.isEditHistoryEnabled()) return;
    const sid = this.activeSessionId || null;
    if (!sid) {
      this._editHistory = null;
      this._renderEditHistoryPanel();
      return;
    }
    const epoch = (this._editHistoryEpoch = (this._editHistoryEpoch || 0) + 1);
    const prev = this._currentEditHistory();
    if (!prev) {
      // Another session's list must not stay on screen while this one loads.
      this._editHistory = { sessionId: sid, state: 'loading', data: null, diffs: new Map(), open: new Set() };
      this._renderEditHistoryPanel();
    } else if (older) {
      prev.loadingOlder = true;
      this._renderEditHistoryPanel();
    }
    const base = this._editHistoryBase(sid);
    const data = older
      ? await this._apiJson(`${base}/older`, { method: 'POST', body: {} })
      : await this._apiJson(`${base}?sync=1`);
    if (epoch !== this._editHistoryEpoch || sid !== this.activeSessionId || !this.isEditHistoryEnabled()) return;
    const cur = this._currentEditHistory() || {
      sessionId: sid,
      diffs: new Map(),
      open: new Set(),
    };
    cur.loadingOlder = false;
    if (data && typeof data === 'object') {
      cur.state = 'ok';
      cur.data = data;
    } else if (!cur.data) {
      cur.state = 'error';
    }
    this._editHistory = cur;
    this._renderEditHistoryPanel();
  },

  loadOlderEditHistory() {
    return this.refreshEditHistory({ older: true });
  },

  /**
   * SSE `transcript:tool_end` ({ sessionId, toolName }), and the end of a turn through
   * `onEditHistorySessionIdle`: while the panel is open on that session, re-read after a tool that
   * can change files, and when the turn ends (a parallel tool call reports only one tool end; a
   * background subagent writes after the tool end that started it). Closed: nothing.
   */
  _onEditHistoryTranscriptEvent(data) {
    if (!data || data.sessionId !== this.activeSessionId || !this._isEditHistoryPanelOpen()) return;
    if (data.toolName !== undefined && !EDIT_HISTORY_FOLLOW_TOOLS.has(data.toolName)) return;
    if (!this.isEditHistoryEnabled()) return;
    clearTimeout(this._editHistoryDebounce);
    this._editHistoryDebounce = setTimeout(() => {
      this._editHistoryDebounce = null;
      if (this._isEditHistoryPanelOpen()) this.refreshEditHistory();
    }, EDIT_HISTORY_SSE_DEBOUNCE_MS);
  },

  /**
   * Called by app.js's `session:idle` handler ({ id }): the end of a turn. Claude's interactive
   * transcript has no `result` line, so the transcript watcher's `transcript:complete` never fires
   * for these sessions.
   */
  onEditHistorySessionIdle(sessionId) {
    this._onEditHistoryTranscriptEvent({ sessionId });
  },

  /** Called by selectSession(): the open panel follows the active session. */
  onEditHistoryActiveSession(sessionId) {
    if (!this.isEditHistoryEnabled() || !this._isEditHistoryPanelOpen()) return;
    if (this._editHistory?.sessionId === sessionId) return;
    this.refreshEditHistory();
  },

  // ── Panel ───────────────────────────────────────────────────────────────

  _isEditHistoryPanelOpen() {
    return !!this.$('editHistoryPanel')?.classList.contains('visible');
  },

  toggleEditHistoryPanel() {
    if (this._isEditHistoryPanelOpen()) {
      this.closeEditHistoryPanel();
      return;
    }
    const panel = this.$('editHistoryPanel');
    if (!panel) return;
    panel.classList.add('visible');
    this.$('editHistoryBtn')?.setAttribute('aria-expanded', 'true');
    const group = this.$('editHistoryGroupToggle');
    if (group) group.checked = this.isEditHistoryGrouped();
    const main = this.$('editHistoryMainOnlyToggle');
    if (main) main.checked = this.isEditHistoryMainOnly();
    this._ensureEditHistoryPanelDrag();
    this._renderEditHistoryPanel();
    this.refreshEditHistory();
  },

  closeEditHistoryPanel() {
    const panel = this.$('editHistoryPanel');
    if (panel) {
      panel.classList.remove('visible');
      // Reset a dragged position so it reopens at the default spot (a resized size is kept).
      panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = '';
    }
    this.$('editHistoryBtn')?.setAttribute('aria-expanded', 'false');
    clearTimeout(this._editHistoryDebounce);
    this._editHistoryDebounce = null;
  },

  /** Drag by the header (pointer events: mouse, pen and touch). One set of listeners per page. */
  _ensureEditHistoryPanelDrag() {
    const panel = this.$('editHistoryPanel');
    const handle = panel?.querySelector('.edit-history-header');
    if (!panel || !handle || handle._dragReady) return;
    handle._dragReady = true;
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      // Switch from right/bottom anchoring to explicit left/top so the drag has one coordinate system.
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      // Pin the size too: the phone layout stretches between left and right, which a drag gives up.
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      handle.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const maxX = window.innerWidth - panel.offsetWidth - 4;
      const maxY = window.innerHeight - panel.offsetHeight - 4;
      panel.style.left = `${Math.max(4, Math.min(e.clientX - drag.dx, maxX))}px`;
      panel.style.top = `${Math.max(4, Math.min(e.clientY - drag.dy, maxY))}px`;
    });
    const end = (e) => {
      drag = null;
      handle.releasePointerCapture?.(e.pointerId);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  },

  _ehEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  },

  /** "14:03:22", with the date in front when it is not today. */
  _editHistoryTime(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
  },

  /** Open `path` in the shared file preview overlay (panels-ui.js). */
  _openEditHistoryPreview(path) {
    const sid = this.activeSessionId;
    if (sid && path) this.openFilePreview?.(path, sid);
  },

  _editHistoryUrl(url) {
    return typeof CodemanBase !== 'undefined' && CodemanBase.url ? CodemanBase.url(url) : url;
  },

  /**
   * Thumbnail URL for an image entry inside the workspace: the confined `file-raw` route the file
   * preview uses. An image outside the workspace gets none: showing it needs an attachment id
   * (`POST …/attachments`, `notify: false`), and minting one per rendered row would push the
   * session's real attachments out of its capped registry. Clicking it opens the file preview,
   * which registers it like any other external file. SVGs get none either (`file-raw` serves
   * them as a download), nor does a remote session's image: its `file-raw` streams over ssh, and
   * a list of generated images would open one ssh read per row; a click still previews it.
   */
  _editHistoryThumbSrc(path, sid) {
    if (!path || /\.svg$/i.test(path) || this.sessions?.get?.(sid)?.remote) return null;
    if (this._isExternalPreviewPath?.(path, sid) !== false) return null;
    return this._editHistoryUrl(`/api/sessions/${encodeURIComponent(sid)}/file-raw?path=${encodeURIComponent(path)}`);
  },

  _renderEditHistoryPanel() {
    const body = this.$('editHistoryBody');
    const count = this.$('editHistoryCount');
    if (!body || !this._isEditHistoryPanelOpen()) return;
    const el = (tag, cls, text) => this._ehEl(tag, cls, text);
    const t = (s, v) => this._eht(s, v);
    const focusKey = body.contains(document.activeElement)
      ? document.activeElement.closest?.('[data-edit-key]')?.dataset.editKey
      : null;
    const scroll = body.scrollTop;
    body.replaceChildren();
    if (count) count.textContent = '';

    if (!this.activeSessionId) {
      body.append(el('div', 'edit-history-empty', t('Open a session to see its edits.')));
      return;
    }
    const h = this._currentEditHistory();
    if (!h || h.state === 'loading') {
      body.append(el('div', 'edit-history-empty', t('Reading the edit history…')));
      return;
    }
    if (h.state === 'error' || !h.data) {
      body.append(el('div', 'edit-history-empty', t('Could not read the edit history.')));
      return;
    }
    const data = h.data;
    if (data.state === 'unsupported') {
      body.append(
        el('div', 'edit-history-empty', t('Edit history is only available for Claude sessions outside Docker.'))
      );
      return;
    }
    if (data.state === 'unavailable') {
      body.append(
        el(
          'div',
          'edit-history-note edit-history-note--warn',
          data.reason === 'no-transcript'
            ? t(
                'No transcript found for this session yet. It is picked up with the next prompt; until then a CLAUDE_CONFIG_DIR set outside Codeman cannot be found.'
              )
            : t('Showing saved entries only: {reason}', { reason: data.reason || '' })
        )
      );
    }

    const all = Array.isArray(data.entries) ? data.entries : [];
    const entries = this.isEditHistoryMainOnly() ? all.filter((e) => !e.agentId) : all;
    if (count) count.textContent = all.length ? String(entries.length) : '';
    if (!all.length) {
      body.append(el('div', 'edit-history-empty', t('No edits yet.')));
    } else if (!entries.length) {
      body.append(el('div', 'edit-history-empty', t('No edits by the main agent.')));
    } else if (this.isEditHistoryGrouped()) {
      const groups = new Map();
      for (const e of entries) {
        const key = e.path || e.relPath;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
      for (const items of groups.values()) body.append(this._editHistoryGroup(items, data, h));
    } else {
      const list = el('div', 'edit-history-list');
      for (const e of entries) list.append(...this._editHistoryEntry(e, data, h, true));
      body.append(list);
    }

    if (data.backfillTruncated) {
      const more = el(
        'button',
        'btn-toolbar btn-sm edit-history-older',
        h.loadingOlder ? t('Loading older edits…') : t('Load older')
      );
      more.type = 'button';
      more.disabled = !!h.loadingOlder;
      more.addEventListener('click', () => this.loadOlderEditHistory());
      body.append(more);
    }

    body.scrollTop = scroll;
    if (focusKey) {
      const again = [...body.querySelectorAll('[data-edit-key]')].find((n) => n.dataset.editKey === focusKey);
      again?.focus({ preventScroll: true });
    }
  },

  /** One file with all its edits (newest first), for the "group by file" view. */
  _editHistoryGroup(items, data, h) {
    const el = (tag, cls, text) => this._ehEl(tag, cls, text);
    const first = items[0];
    const group = el('section', 'edit-history-group');
    const head = el('div', 'edit-history-group-head');
    head.append(this._editHistoryPathButton(first));
    const code = items.filter((e) => e.kind !== 'image');
    if (code.length) {
      const added = code.reduce((s, e) => s + (Number(e.added) || 0), 0);
      const removed = code.reduce((s, e) => s + (Number(e.removed) || 0), 0);
      head.append(this._editHistoryStats(added, removed));
    }
    head.append(el('span', 'edit-history-group-count', String(items.length)));
    group.append(head);
    for (const e of items) group.append(...this._editHistoryEntry(e, data, h, false));
    return group;
  },

  /**
   * The path as folder + file name: the folder is cut from its start when the row is narrow, so a
   * long absolute path (an image in claude's scratchpad) still shows which file it is.
   */
  _editHistoryPathButton(e) {
    const shown = e.relPath || e.path || '';
    const btn = this._ehEl('button', 'edit-history-path');
    const cut = shown.lastIndexOf('/') + 1;
    if (cut > 0) {
      const dir = this._ehEl('span', 'edit-history-path-dir');
      const bdi = this._ehEl('bdi', null, shown.slice(0, cut));
      bdi.dir = 'ltr';
      dir.append(bdi);
      btn.append(dir);
    }
    btn.append(this._ehEl('span', 'edit-history-path-name', shown.slice(cut)));
    btn.type = 'button';
    btn.title = e.path || e.relPath || '';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._openEditHistoryPreview(e.path);
    });
    return btn;
  },

  _editHistoryStats(added, removed) {
    const stats = this._ehEl('span', 'edit-history-stats');
    stats.append(this._ehEl('span', 'edit-history-add', `+${added}`));
    stats.append(this._ehEl('span', 'edit-history-del', `−${removed}`));
    return stats;
  },

  /** A row, followed by its diff when the row is open. `withPath` false inside a file group. */
  _editHistoryEntry(e, data, h, withPath) {
    const el = (tag, cls, text) => this._ehEl(tag, cls, text);
    const t = (s, v) => this._eht(s, v);
    const isImage = e.kind === 'image';
    const row = el('div', `edit-history-entry edit-history-entry--${isImage ? 'image' : 'code'}`);
    row.dataset.editKey = e.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.append(el('span', 'edit-history-time', this._editHistoryTime(e.ts)));

    let badge;
    if (isImage) {
      badge = el('span', 'edit-history-badge edit-history-badge--image');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '12');
      svg.setAttribute('height', '12');
      svg.setAttribute('aria-hidden', 'true');
      for (const [tag, attrs] of [
        ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
        ['circle', { cx: '9', cy: '10', r: '2' }],
        ['path', { d: 'M21 17l-5-5-9 8' }],
      ]) {
        const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        svg.append(n);
      }
      badge.append(svg);
      badge.title = t('Image');
    } else if (e.created) {
      badge = el('span', 'edit-history-badge edit-history-badge--new', this._ehBadge('new'));
      badge.title = t('File created');
    } else {
      badge = el('span', 'edit-history-badge edit-history-badge--edit', this._ehBadge('edit'));
      badge.title = t('File edited ({tool})', { tool: e.tool || '' });
    }
    row.append(badge);

    if (withPath) row.append(this._editHistoryPathButton(e));
    row.append(el('span', 'edit-history-spacer'));
    if (!isImage) row.append(this._editHistoryStats(Number(e.added) || 0, Number(e.removed) || 0));

    if (e.agentId) {
      const agent = data.agents?.[e.agentId];
      const chip = el('span', 'edit-history-agent', agent?.description || e.agentId);
      const bits = [agent?.agentType, agent?.worktreeBranch].filter(Boolean);
      chip.title = bits.join(' · ') || t('Subagent');
      row.append(chip);
    }

    const out = [row];
    if (isImage) {
      row.title = t('Open in the file preview');
      const open = () => this._openEditHistoryPreview(e.path);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open();
        }
      });
      const src = this._editHistoryThumbSrc(e.path, h.sessionId);
      if (src) {
        const img = el('img', 'edit-history-thumb');
        img.loading = 'lazy';
        img.alt = e.relPath || '';
        img.addEventListener('click', (ev) => {
          ev.stopPropagation();
          open();
        });
        img.addEventListener('error', () => img.remove());
        img.src = src;
        out.push(img);
      }
      return out;
    }

    const isOpen = h.open.has(e.id);
    row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    row.title = isOpen ? t('Hide the diff') : t('Show what changed');
    const toggle = () => this.toggleEditHistoryDiff(e.id);
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggle();
      }
    });
    if (isOpen) {
      row.classList.add('edit-history-entry--open');
      out.push(this._editHistoryDiffView(h.diffs.get(e.id)));
    }
    return out;
  },

  /** Open or close one entry's diff; the first open loads it, later ones reuse it. */
  async toggleEditHistoryDiff(entryId) {
    const h = this._currentEditHistory();
    if (!h) return;
    if (h.open.has(entryId)) {
      h.open.delete(entryId);
      this._renderEditHistoryPanel();
      return;
    }
    h.open.add(entryId);
    const cached = h.diffs.get(entryId);
    if (cached && cached.state !== 'error') {
      this._renderEditHistoryPanel();
      return;
    }
    const view = { state: 'loading' };
    h.diffs.set(entryId, view);
    this._renderEditHistoryPanel();
    const res = await this._api(`${this._editHistoryBase(h.sessionId)}/${encodeURIComponent(entryId)}`);
    let body = null;
    try {
      body = res ? await res.json() : null;
    } catch {
      /* fall through */
    }
    if (h.diffs.get(entryId) !== view) return;
    if (res && res.ok && body?.success && typeof body.data?.diff === 'string') {
      view.state = 'ok';
      view.diff = body.data.diff;
      view.truncated = !!body.data.truncated;
    } else {
      view.state = 'error';
      view.error = body?.error || this._eht('Could not read the diff.');
    }
    if (this._editHistory === h) this._renderEditHistoryPanel();
  },

  /** The diff block under an open row, drawn with the Git panel's classes. */
  _editHistoryDiffView(view) {
    const el = (tag, cls, text) => this._ehEl(tag, cls, text);
    const t = (s, v) => this._eht(s, v);
    const wrap = el('div', 'edit-history-diff');
    if (!view || view.state === 'loading') {
      wrap.append(el('div', 'edit-history-empty', t('Reading the diff…')));
      return wrap;
    }
    if (view.state === 'error') {
      wrap.append(el('div', 'edit-history-empty', view.error));
      return wrap;
    }
    if (!view.diff.trim()) {
      wrap.append(el('div', 'edit-history-empty', t('No textual changes.')));
    } else {
      const pre = el('pre', 'git-diff');
      const frag = document.createDocumentFragment();
      for (const line of view.diff.replace(/\n$/, '').split('\n')) {
        let cls = 'git-diff-line';
        // The API sends hunks only (no `---`/`+++` headers), so a `---` line is a removed `--` line.
        if (line.startsWith('@@')) cls += ' git-diff-line--hunk';
        else if (line.startsWith('+')) cls += ' git-diff-line--add';
        else if (line.startsWith('-')) cls += ' git-diff-line--del';
        frag.append(el('span', cls, line + '\n'));
      }
      pre.append(frag);
      wrap.append(pre);
    }
    if (view.truncated)
      wrap.append(el('div', 'edit-history-more', t('Diff cut short: it is larger than the viewer shows.')));
    return wrap;
  },
});
