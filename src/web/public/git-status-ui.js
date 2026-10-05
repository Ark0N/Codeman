/**
 * @fileoverview Git status indicator in the bottom bar, and the panel it opens.
 *
 * Agents leave work uncommitted and unpushed. This puts a small indicator at the right of the bottom
 * toolbar for the ACTIVE session's repository, or repositories when the session's folder holds several (`●3` uncommitted files, `↑2` commits not pushed,
 * `✓` when everything is committed and pushed) and, on click, a draggable panel in the style of the
 * Files window listing exactly which files are uncommitted and which commits are not pushed.
 *
 * OPTIONAL and per-device: `showGitStatus` (App Settings → Header & Panels → Bottom bar), default
 * OFF. While it is off nothing polls and the button never shows. While it is on, the page asks
 * `GET /api/sessions/:id/git-status` for the active session on a slow poll (and at once when the
 * session changes or the window regains focus). The route is read-only and offline: it never fetches
 * or changes the repository, so the "behind" number reflects the last `git fetch`, which the panel
 * footer says. Remote (SSH) and Docker sessions answer `unsupported` and show no indicator.
 *
 * Everything that comes from git (file names, commit subjects, author names) is untrusted text: it is
 * only ever written with `textContent`, never `innerHTML`.
 *
 * The bottom toolbar's right group is hidden on phones (mobile.css), so this surface is desktop and
 * tablet only by construction.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (this.activeSessionId, this.loadAppSettingsFromStorage, this.getDefaultSettings, this.$)
 * @dependency panels-ui.js (openFilePreview)
 * @loadorder 12.57 of 16, after home-sessions.js, before entrance-animations.js
 */

/** How often the active session's repository is re-read while the indicator is on. */
const GIT_STATUS_POLL_MS = 15000;
/** The timer only decides whether a poll is due; it is cheap and runs while the indicator is on. */
const GIT_STATUS_TICK_MS = 2000;
/** A focus or visibility change refreshes at once unless the last read is younger than this. */
const GIT_STATUS_MIN_REFRESH_MS = 3000;

const GIT_STATUS_BADGE_TITLE = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Unmerged',
  '?': 'Untracked',
};

Object.assign(CodemanApp.prototype, {
  /** Per-device setting, default OFF. */
  isGitStatusEnabled() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    return (settings.showGitStatus ?? defaults.showGitStatus ?? false) === true;
  },

  /**
   * Starts or stops the poll to match the setting. Called from applyHeaderVisibilitySettings(), which
   * runs on boot and after every settings save, so a live toggle needs no reload.
   */
  applyGitStatusVisibility() {
    const on = this.isGitStatusEnabled();
    if (on && !this._gitStatusTimer) {
      this._gitStatusTimer = setInterval(() => this._gitStatusTick(), GIT_STATUS_TICK_MS);
      this._gitStatusOnVisible = () => {
        if (!document.hidden) this.refreshGitStatus({ minAgeMs: GIT_STATUS_MIN_REFRESH_MS });
      };
      document.addEventListener('visibilitychange', this._gitStatusOnVisible);
      window.addEventListener('focus', this._gitStatusOnVisible);
      this.refreshGitStatus();
    } else if (!on && this._gitStatusTimer) {
      clearInterval(this._gitStatusTimer);
      this._gitStatusTimer = null;
      document.removeEventListener('visibilitychange', this._gitStatusOnVisible);
      window.removeEventListener('focus', this._gitStatusOnVisible);
      this._gitStatusOnVisible = null;
    }
    if (!on) {
      this._gitStatus = null;
      this._gitStatusEpoch = (this._gitStatusEpoch || 0) + 1; // an in-flight read must not repaint
      this.closeGitStatusPanel();
    }
    this._renderGitStatusButton();
  },

  _gitStatusTick() {
    if (document.hidden) return;
    const sid = this.activeSessionId || null;
    if (sid !== this._gitStatusSessionId) {
      // The active session changed (or the first one opened): show nothing stale, read now.
      this._gitStatus = null;
      this._renderGitStatusButton();
      if (this._isGitStatusPanelOpen()) this._renderGitStatusPanel(); // not the previous repo's files
      this.refreshGitStatus();
      return;
    }
    if (sid && Date.now() - (this._gitStatusFetchedAt || 0) >= GIT_STATUS_POLL_MS) this.refreshGitStatus();
  },

  /** Reads the active session's git status and repaints. Stale answers (another session, setting off) are dropped. */
  async refreshGitStatus({ minAgeMs = 0, fresh = false } = {}) {
    if (!this.isGitStatusEnabled()) return;
    const sid = this.activeSessionId || null;
    this._gitStatusSessionId = sid;
    if (!sid) {
      this._gitStatus = null;
      this._renderGitStatusButton();
      if (this._isGitStatusPanelOpen()) this._renderGitStatusPanel();
      return;
    }
    if (minAgeMs && Date.now() - (this._gitStatusFetchedAt || 0) < minAgeMs) return;
    // A read for THIS session is already running: let it finish. One for another session is not worth
    // waiting for (its answer is dropped below), so a session switch is never left blank.
    if (this._gitStatusInFlight && this._gitStatusInFlightSid === sid) return;
    this._gitStatusInFlight = true;
    this._gitStatusInFlightSid = sid;
    const epoch = (this._gitStatusEpoch = (this._gitStatusEpoch || 0) + 1);
    this._gitStatusFetchedAt = Date.now();
    try {
      const data = await this._apiJson(`/api/sessions/${encodeURIComponent(sid)}/git-status${fresh ? '?fresh=1' : ''}`);
      if (epoch !== this._gitStatusEpoch || sid !== this.activeSessionId || !this.isGitStatusEnabled()) return;
      this._gitStatus = data ? { sessionId: sid, data } : null;
    } catch {
      if (epoch === this._gitStatusEpoch) this._gitStatus = null;
    } finally {
      // Only the newest request owns the flag: an older one finishing late must not clear it.
      if (epoch === this._gitStatusEpoch) this._gitStatusInFlight = false;
    }
    if (epoch !== this._gitStatusEpoch) return;
    this._renderGitStatusButton();
    if (this._isGitStatusPanelOpen()) this._renderGitStatusPanel();
  },

  /** Whether the Git window groups changed files under collapsible folders (default on). */
  isGitStatusTree() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    return (settings.gitStatusTree ?? defaults.gitStatusTree ?? true) === true;
  },

  /** The data for the session on screen, or null (not enabled, no session, not a repo, remote/docker, error). */
  _currentGitStatus() {
    const s = this._gitStatus;
    return s && s.sessionId === this.activeSessionId && s.data ? s.data : null;
  },

  /** `{ uncommitted, unpushed, conflicted, repos, tone }` summed over every repository, or null when there is nothing to show. */
  _gitStatusSummary(overview) {
    if (!overview || overview.state !== 'ok' || !overview.repos?.length) return null;
    let uncommitted = 0;
    let unpushed = 0;
    let conflicted = 0;
    for (const r of overview.repos) {
      uncommitted += r.status.counts.uncommitted;
      unpushed += r.status.unpushedCount;
      conflicted += r.status.counts.conflicted;
    }
    const tone = conflicted > 0 ? 'conflict' : uncommitted > 0 || unpushed > 0 ? 'dirty' : 'clean';
    return { uncommitted, unpushed, conflicted, repos: overview.repos.length, tone };
  },

  /** One sentence for the tooltip and the screen-reader label. */
  _gitStatusSentence(overview) {
    const sum = this._gitStatusSummary(overview);
    if (!sum) return '';
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const bits = [];
    if (sum.conflicted) bits.push(plural(sum.conflicted, 'file with a merge conflict', 'files with merge conflicts'));
    if (sum.uncommitted) bits.push(plural(sum.uncommitted, 'uncommitted file', 'uncommitted files'));
    if (sum.unpushed) bits.push(plural(sum.unpushed, 'commit not pushed', 'commits not pushed'));
    if (!bits.length) bits.push('everything is committed and pushed');
    let where;
    if (sum.repos > 1) where = `${sum.repos} repositories`;
    else {
      const d = overview.repos[0].status;
      where = d.detached ? 'detached HEAD' : d.branch || 'no branch';
    }
    return `Git (${where}): ${bits.join(', ')}. Click for details.`;
  },

  _renderGitStatusButton() {
    const btn = this.$('gitStatusBtn');
    if (!btn) return;
    const data = this.isGitStatusEnabled() ? this._currentGitStatus() : null;
    const sum = this._gitStatusSummary(data);
    btn.hidden = !sum;
    btn.classList.toggle('git-status--clean', sum?.tone === 'clean');
    btn.classList.toggle('git-status--dirty', sum?.tone === 'dirty');
    btn.classList.toggle('git-status--conflict', sum?.tone === 'conflict');
    const label = btn.querySelector('.git-status-label');
    if (!sum) {
      if (label) label.textContent = '';
      return;
    }
    const parts = [];
    if (sum.conflicted) parts.push(`⚠ ${sum.conflicted}`);
    if (sum.uncommitted) parts.push(`● ${sum.uncommitted}`);
    if (sum.unpushed) parts.push(`↑ ${sum.unpushed}`);
    if (!parts.length) parts.push('✓');
    if (label) label.textContent = parts.join('  ');
    const sentence = this._gitStatusSentence(data);
    btn.title = sentence;
    btn.setAttribute('aria-label', sentence);
  },

  // ── Panel ───────────────────────────────────────────────────────────────

  _isGitStatusPanelOpen() {
    return !!this.$('gitStatusPanel')?.classList.contains('visible');
  },

  toggleGitStatusPanel() {
    if (this._isGitStatusPanelOpen()) {
      this.closeGitStatusPanel();
      return;
    }
    const panel = this.$('gitStatusPanel');
    if (!panel) return;
    panel.classList.add('visible');
    this.$('gitStatusBtn')?.setAttribute('aria-expanded', 'true');
    this._ensureGitStatusPanelDrag();
    this._renderGitStatusPanel();
    this.refreshGitStatus({ fresh: true }); // the click should show what is true now, not what was true 14s ago
  },

  closeGitStatusPanel() {
    this._gitDiffView = null;
    const panel = this.$('gitStatusPanel');
    if (panel) {
      panel.classList.remove('visible');
      // Reset a dragged position so it reopens at the default spot.
      panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = '';
    }
    this.$('gitStatusBtn')?.setAttribute('aria-expanded', 'false');
  },

  refreshGitStatusNow() {
    this._gitStatusFetchedAt = 0;
    this._gitStatusInFlight = false;
    return this.refreshGitStatus({ fresh: true });
  },

  /** Drag by the header. Pointer events cover mouse, pen and touch; one set of listeners lives as long as the page. */
  _ensureGitStatusPanelDrag() {
    const panel = this.$('gitStatusPanel');
    const handle = panel?.querySelector('.git-status-header');
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

  _gitEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  },

  _renderGitStatusPanel() {
    const body = this.$('gitStatusBody');
    const head = this.$('gitStatusBranch');
    const foot = this.$('gitStatusFooter');
    if (!body) return;
    const overview = this._currentGitStatus();
    const el = (tag, cls, text) => this._gitEl(tag, cls, text);
    const view = this._gitDiffView;
    if (view && view.sessionId === this.activeSessionId) {
      // A file's diff is on screen: the 15 s poll re-renders the panel, and must not throw it away.
      this._renderGitDiffView(body, view);
      if (head) head.textContent = '';
      if (foot) foot.textContent = '';
      return;
    }
    this._gitDiffView = null;
    body.replaceChildren();
    const clearChrome = () => {
      if (head) head.textContent = '';
      if (foot) foot.textContent = '';
    };

    if (!this.activeSessionId) {
      body.append(el('div', 'git-status-empty', 'Open a session to see its repository.'));
      clearChrome();
      return;
    }
    if (!overview) {
      body.append(
        el('div', 'git-status-empty', this._gitStatus === null ? 'Reading the repository…' : 'No status available.')
      );
      return;
    }
    if (overview.state !== 'ok') {
      const why =
        overview.state === 'not-a-repo'
          ? 'No git repository here: this session’s folder is not one, and none was found inside it (up to two levels down).'
          : overview.state === 'unsupported'
            ? `Git status is not available for ${overview.reason === 'docker' ? 'Docker' : 'remote (SSH)'} sessions.`
            : `Could not read the repository: ${overview.error || 'git failed'}`;
      body.append(el('div', 'git-status-empty', why));
      clearChrome();
      return;
    }

    const repos = overview.repos;
    if (repos.length === 1) {
      // One repository: the panel is that repository, as it always was.
      const d = repos[0].status;
      if (head) head.textContent = d.detached ? 'detached HEAD' : d.branch || '';
      this._renderGitRepoInto(body, d);
    } else {
      if (head) head.textContent = `${repos.length} repositories`;
      for (const r of repos) body.append(this._gitRepoSection(r));
      if (overview.reposTruncated) {
        body.append(
          el('div', 'git-status-more', `Showing the first ${repos.length} repositories found under this folder.`)
        );
      }
    }

    if (foot) {
      foot.textContent = `Checked ${new Date(overview.checkedAt).toLocaleTimeString()}. Read-only: Codeman never fetches or changes the repository, so “behind” is as of your last fetch.`;
    }
  },

  /** One repository of several: a collapsible section, open when it has something outstanding. */
  _gitRepoSection(r) {
    const el = (tag, cls, text) => this._gitEl(tag, cls, text);
    const d = r.status;
    const section = el('details', 'git-status-repo');
    const outstanding = d.counts.uncommitted > 0 || d.unpushedCount > 0;
    section.open = outstanding;
    const summary = el('summary', 'git-status-repo-summary');
    summary.append(el('span', 'git-status-repo-name', r.name));
    if (r.path !== r.name) summary.append(el('span', 'git-status-repo-path', r.path));
    summary.append(el('span', 'git-status-repo-branch', d.detached ? 'detached HEAD' : d.branch || ''));
    const bits = [];
    if (d.counts.conflicted) bits.push(`⚠ ${d.counts.conflicted}`);
    if (d.counts.uncommitted) bits.push(`● ${d.counts.uncommitted}`);
    if (d.unpushedCount) bits.push(`↑ ${d.unpushedCount}`);
    const state = el(
      'span',
      `git-status-repo-state${outstanding ? ' git-status-repo-state--dirty' : ''}`,
      bits.join('  ') || '✓'
    );
    summary.append(state);
    section.append(summary);
    const inner = el('div', 'git-status-repo-body');
    this._renderGitRepoInto(inner, d);
    section.append(inner);
    return section;
  },

  /** The branch line, uncommitted files and unpushed commits of ONE repository into `body`. */
  _renderGitRepoInto(body, data) {
    const el = (tag, cls, text) => this._gitEl(tag, cls, text);

    // Branch / upstream line.
    const line = el('div', 'git-status-branchline');
    if (data.upstream) {
      line.append(el('span', 'git-status-chip', `${data.branch || 'HEAD'} → ${data.upstream}`));
      if (data.ahead) line.append(el('span', 'git-status-chip git-status-chip--warn', `↑ ${data.ahead} ahead`));
      if (data.behind) {
        const behind = el('span', 'git-status-chip', `↓ ${data.behind} behind`);
        behind.title = 'As of the last git fetch: Codeman never fetches.';
        line.append(behind);
      }
    } else if (data.hasRemote) {
      line.append(el('span', 'git-status-chip git-status-chip--warn', 'No upstream branch'));
    } else {
      line.append(el('span', 'git-status-chip', 'No remote configured'));
    }
    if (data.counts.stashes) {
      line.append(
        el('span', 'git-status-chip', `${data.counts.stashes} stash${data.counts.stashes === 1 ? '' : 'es'}`)
      );
    }
    body.append(line);

    // Uncommitted changes.
    const filesSection = el('section', 'git-status-section');
    filesSection.append(el('h4', 'git-status-section-title', `Uncommitted changes (${data.counts.uncommitted})`));
    if (!data.files.length) {
      filesSection.append(el('div', 'git-status-ok', 'Nothing uncommitted.'));
    } else {
      const groups = [
        ['conflicted', 'Merge conflicts'],
        ['staged', 'Staged'],
        ['unstaged', 'Not staged'],
        ['untracked', 'Untracked'],
      ];
      for (const [kind, label] of groups) {
        const rows = data.files.filter((f) => f.kind === kind);
        if (!rows.length) continue;
        const group = el('div', `git-status-group git-status-group--${kind}`);
        group.append(el('div', 'git-status-group-title', `${label} (${data.counts[kind]})`));
        if (this.isGitStatusTree()) group.append(...this._gitFileTree(rows, data, kind));
        else for (const f of rows) group.append(this._gitFileRow(f, data));
        filesSection.append(group);
      }
      if (data.filesTruncated) {
        filesSection.append(
          el(
            'div',
            'git-status-more',
            `Showing the first ${data.files.length} entries; the counts above include every file.`
          )
        );
      }
    }
    body.append(filesSection);

    // Commits not pushed.
    const pushSection = el('section', 'git-status-section');
    pushSection.append(el('h4', 'git-status-section-title', `Not pushed (${data.unpushedCount})`));
    if (!data.unpushedCount) {
      pushSection.append(
        el(
          'div',
          'git-status-ok',
          data.hasRemote ? 'Every commit on this branch is on a remote.' : 'There is no remote to push to.'
        )
      );
    } else {
      if (!data.upstream) {
        pushSection.append(
          el('div', 'git-status-note', 'This branch has no upstream, so these commits are on no remote yet.')
        );
      }
      for (const c of data.unpushed) pushSection.append(this._gitCommitRow(c));
      if (data.unpushedCount > data.unpushed.length) {
        pushSection.append(
          el('div', 'git-status-more', `…and ${data.unpushedCount - data.unpushed.length} older commits.`)
        );
      }
    }
    body.append(pushSection);
  },

  /**
   * `rows` as folders (collapsed until clicked) holding their files. A folder with one child folder and
   * nothing else is merged into it (`src/web/public` as one row) so a deep path is one click, not five.
   * Which folders are open survives the 15 s re-render (`_gitTreeOpen`, keyed by repo, group and folder).
   */
  _gitFileTree(rows, data, kind) {
    const root = { dirs: new Map(), files: [] };
    for (const f of rows) {
      const trailing = f.path.endsWith('/');
      const parts = f.path.replace(/\/$/, '').split('/');
      const leaf = parts.pop() + (trailing ? '/' : '');
      let node = root;
      for (const part of parts) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ f, leaf });
    }
    const open = (this._gitTreeOpen = this._gitTreeOpen || new Set());
    const count = (n) => n.files.length + [...n.dirs.values()].reduce((sum, d) => sum + count(d), 0);
    const build = (node, prefix) => {
      const out = [];
      for (const [name0, child0] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        let name = name0;
        let child = child0;
        while (child.files.length === 0 && child.dirs.size === 1) {
          const [n, c] = [...child.dirs][0];
          name += `/${n}`;
          child = c;
        }
        const key = `${data.repoRoot}|${kind}|${prefix}${name}`;
        const dir = this._gitEl('details', 'git-tree-dir');
        dir.open = open.has(key);
        dir.addEventListener('toggle', () => (dir.open ? open.add(key) : open.delete(key)));
        const summary = this._gitEl('summary', 'git-tree-summary');
        summary.append(this._gitEl('span', 'git-tree-name', `${name}/`));
        summary.append(this._gitEl('span', 'git-tree-count', String(count(child))));
        dir.append(summary);
        const inner = this._gitEl('div', 'git-tree-children');
        inner.append(...build(child, `${prefix}${name}/`));
        dir.append(inner);
        out.push(dir);
      }
      for (const { f, leaf } of node.files.sort((a, b) => a.leaf.localeCompare(b.leaf))) {
        out.push(this._gitFileRow(f, data, leaf));
      }
      return out;
    };
    return build(root, '');
  },

  _gitFileRow(f, data, displayName) {
    const el = (tag, cls, text) => this._gitEl(tag, cls, text);
    const row = el('div', 'git-status-file');
    // Untracked entries have `?`; staged ones show the index letter, the rest the working-tree letter.
    const letter =
      f.kind === 'untracked' ? '?' : f.kind === 'conflicted' ? 'U' : f.kind === 'staged' ? f.index : f.worktree;
    const badge = el('span', `git-status-badge git-status-badge--${letter === '?' ? 'new' : letter}`, letter);
    badge.title = GIT_STATUS_BADGE_TITLE[letter] || letter;
    row.append(badge);
    const name = el('span', 'git-status-path', displayName ?? f.path);
    if (displayName) name.title = f.path;
    row.append(name);
    if (f.origPath) row.append(el('span', 'git-status-orig', `← ${f.origPath}`));

    // An untracked folder has no single diff; every other row opens its changes.
    if (!f.path.endsWith('/') && data.repoRoot) {
      row.classList.add('git-status-file--clickable');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = 'Show what changed';
      const open = () => this.openGitDiff(data.repoRoot, f, letter);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    }
    return row;
  },

  // ── Diff view ───────────────────────────────────────────────────────────

  /** Show `file`'s changes in the panel (a Back button returns to the list). */
  async openGitDiff(repoRoot, file, letter) {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const view = { sessionId, repoRoot, file, letter, state: 'loading' };
    this._gitDiffView = view;
    this._renderGitStatusPanel();
    const qs = new URLSearchParams({ repo: repoRoot, path: file.path, kind: file.kind });
    const res = await this._api(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff?${qs}`);
    // Back, another file or another session while this was in flight: drop the answer.
    if (this._gitDiffView !== view) return;
    let body = null;
    try {
      body = res ? await res.json() : null;
    } catch {
      /* fall through */
    }
    if (this._gitDiffView !== view) return;
    if (res && res.ok && body?.success) {
      view.state = 'ok';
      view.result = body.data;
    } else {
      view.state = 'error';
      view.error = body?.error || 'Could not read the diff.';
    }
    this._renderGitStatusPanel();
  },

  closeGitDiff() {
    this._gitDiffView = null;
    this._renderGitStatusPanel();
  },

  _renderGitDiffView(body, view) {
    const el = (tag, cls, text) => this._gitEl(tag, cls, text);
    body.replaceChildren();
    const bar = el('div', 'git-diff-bar');
    const back = el('button', 'btn-toolbar btn-sm', '← Back');
    back.type = 'button';
    back.addEventListener('click', () => this.closeGitDiff());
    bar.append(back);
    bar.append(el('span', 'git-diff-path', view.file.path));
    const kindLabel = { staged: 'staged', unstaged: 'not staged', untracked: 'new file', conflicted: 'conflict' };
    bar.append(el('span', 'git-diff-kind', kindLabel[view.file.kind] || ''));
    if (view.letter !== 'D') {
      const open = el('button', 'btn-toolbar btn-sm', 'Open file');
      open.type = 'button';
      open.addEventListener('click', () =>
        this.openFilePreview?.(`${view.repoRoot}/${view.file.path}`, this.activeSessionId)
      );
      bar.append(open);
    }
    body.append(bar);

    if (view.state === 'loading') {
      body.append(el('div', 'git-status-empty', 'Reading the diff…'));
      return;
    }
    if (view.state === 'error') {
      body.append(el('div', 'git-status-empty', view.error));
      return;
    }
    const { diff, truncated, binary } = view.result;
    if (binary) body.append(el('div', 'git-status-note', 'This is a binary file; there is no text diff to show.'));
    if (!diff.trim()) {
      if (!binary) body.append(el('div', 'git-status-empty', 'No textual changes (the file may differ only in mode).'));
      return;
    }
    const pre = el('pre', 'git-diff');
    const frag = document.createDocumentFragment();
    for (const line of diff.split('\n')) {
      let cls = 'git-diff-line';
      if (line.startsWith('@@')) cls += ' git-diff-line--hunk';
      else if (
        /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)
      )
        cls += ' git-diff-line--meta';
      else if (line.startsWith('+')) cls += ' git-diff-line--add';
      else if (line.startsWith('-')) cls += ' git-diff-line--del';
      frag.append(el('span', cls, line + '\n'));
    }
    pre.append(frag);
    body.append(pre);
    if (truncated) body.append(el('div', 'git-status-more', 'Diff cut short: it is larger than the viewer shows.'));
  },

  _gitCommitRow(c) {
    const el = (tag, cls, text) => this._gitEl(tag, cls, text);
    const row = el('div', 'git-status-commit');
    row.append(el('span', 'git-status-hash', c.hash));
    row.append(el('span', 'git-status-subject', c.subject));
    const meta = c.time ? `${c.author} · ${this.formatRelativeTime?.(c.time * 1000) ?? ''}` : c.author;
    row.append(el('span', 'git-status-commit-meta', meta));
    return row;
  },
});
