/**
 * @fileoverview Mobile keyboard accessory bar and modal focus trap.
 *
 * Defines three exports:
 *
 * - KeyboardAccessoryBar (singleton object) — Quick action buttons shown above the virtual
 *   keyboard on mobile: arrow up/down, /init, Tab, paste, Esc, and dismiss (the extended
 *   bar adds /clear, /compact, Shift+Tab and more). Tab flushes any locally-buffered
 *   prompt text to the PTY before sending \t, so completion applies to what was typed.
 *   The paste button opens a dialog that handles both text paste and image attach
 *   (native picker + best-effort image paste, routed through app._uploadAndInsertImages).
 *   Destructive actions (/clear, /compact, extended bar only) require double-tap confirmation (2s amber state).
 *   Commands are sent as text + Enter separately for Ink compatibility.
 *   Only initializes on touch devices (MobileDetection.isTouchDevice guard).
 *   SHELL sessions get their own layout automatically (issue #262): Ctrl, Esc, Tab,
 *   four arrows, paste, dismiss. Ctrl is a ONE-SHOT modifier: arm it, type a
 *   character on the system keyboard, and terminal-ui.js's onData hook swaps the
 *   character for its control byte (ctrlByteFor) and disarms. That is what makes
 *   Ctrl+C/D/Z/R/L/A/E/W/U/K reachable without a button per chord. It resets on
 *   use, on a second tap, on any other accessory key, on a session switch
 *   (refreshForActiveSession) and when the keyboard is dismissed (hide).
 * - PathPicker (singleton object) — Lazy server-side file/folder browser shared
 *   by Link Existing and the extended mobile keyboard bar.
 *
 * - FocusTrap (class) — Traps Tab/Shift+Tab keyboard focus within a modal element.
 *   Saves and restores previously focused element on deactivate. Used by Ralph wizard
 *   and other modal dialogs.
 *
 * @globals {object} KeyboardAccessoryBar
 * @globals {object} PathPicker
 * @globals {class} FocusTrap
 *
 * @dependency mobile-handlers.js (MobileDetection.isTouchDevice)
 * @dependency app.js (uses global `app` for sendInput, activeSessionId, terminal)
 * @loadorder 5 of 15 — loaded after notification-manager.js, before app.js
 */

// Codeman — Keyboard accessory bar and focus trap for modals
// Loaded after mobile-handlers.js, before app.js

// ═══════════════════════════════════════════════════════════════
// Shared Filesystem Path Picker
// ═══════════════════════════════════════════════════════════════

// Per-device, and deliberately its own key rather than a shared "show hidden"
// preference with the File Viewer: that tree is confined to one workspace, while
// the picker browses Home and every configured root, so wanting dotfiles in a
// project does not imply wanting them in ~.
const PATH_PICKER_SHOW_HIDDEN_KEY = 'codeman:pathPickerShowHidden';
// Per-device like the hidden toggle: how you scan a folder is a habit of the
// hand, not of the workspace.
const PATH_PICKER_SORT_KEY = 'codeman:pathPickerSort';
const PATH_PICKER_SORT_MODES = [
  { value: 'name-asc', label: 'Name A→Z' },
  { value: 'name-desc', label: 'Name Z→A' },
  { value: 'mtime-desc', label: 'Newest first' },
  { value: 'mtime-asc', label: 'Oldest first' },
];
const PATH_PICKER_DEFAULT_SORT = 'name-asc';

const PathPicker = {
  overlay: null,
  _options: null,
  _selectedPath: '',
  _currentPath: '',
  _entries: [],
  _truncated: false,
  _previousFocus: null,
  _keydownHandler: null,
  _loadSequence: 0,
  _previewOverlay: null,
  _previewRequestSequence: 0,
  _previewPreviousFocus: null,
  _showHidden: false,
  _sortMode: PATH_PICKER_DEFAULT_SORT,

  /**
   * Open the lazy filesystem browser.
   * @param {{sessionId?: string, initialPath?: string, directoriesOnly?: boolean,
   *   title?: string, onSelect: (path: string) => void}} options
   */
  open(options) {
    this.close(false);
    this._options = options;
    this._selectedPath = '';
    this._currentPath = '';
    this._entries = [];
    this._showHidden = this._loadShowHidden();
    this._sortMode = this._loadSortMode();
    this._previousFocus = document.activeElement;
    this._previousFocus?.blur?.();

    const overlay = document.createElement('div');
    overlay.className = 'path-picker-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', options.title || 'Select a path');
    overlay.innerHTML = `
      <div class="path-picker-dialog">
        <div class="path-picker-header">
          <strong class="path-picker-title"></strong>
          <button type="button" class="path-picker-close" aria-label="Close">&times;</button>
        </div>
        <div class="path-picker-roots-row">
          <label for="pathPickerRoot">Location</label>
          <select id="pathPickerRoot" class="path-picker-roots"></select>
        </div>
        <div class="path-picker-nav">
          <button type="button" class="path-picker-up" title="Parent folder" aria-label="Parent folder">&#x2191;</button>
          <form class="path-picker-jump" title="Current folder — edit and press Enter to jump">
            <input type="text" class="path-picker-current" aria-label="Current folder path" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
            <button type="submit" class="path-picker-go" title="Go to this path" aria-label="Go to this path">Go</button>
          </form>
          <button type="button" class="path-picker-hidden" title="Show hidden files and folders" aria-label="Show hidden files and folders" aria-pressed="false">.*</button>
          <button type="button" class="path-picker-refresh" title="Refresh" aria-label="Refresh">&#x21BB;</button>
        </div>
        <div class="path-picker-toolbar">
          <div class="path-picker-status" aria-live="polite">Loading...</div>
          <label class="path-picker-sort-label">Sort
            <select class="path-picker-sort" aria-label="Sort entries"></select>
          </label>
        </div>
        <div class="path-picker-list" role="listbox"></div>
        <div class="path-picker-selection">
          <span class="path-picker-selection-label">Selected</span>
          <span class="path-picker-selection-value">None</span>
        </div>
        <div class="path-picker-actions">
          <button type="button" class="path-picker-current-select">Select Current Folder</button>
          <span class="path-picker-action-spacer"></span>
          <button type="button" class="path-picker-cancel">Cancel</button>
          <button type="button" class="path-picker-confirm" disabled>Select</button>
        </div>
      </div>`;

    this.overlay = overlay;
    overlay.querySelector('.path-picker-title').textContent = options.title || 'Select a Path';
    overlay.querySelector('.path-picker-close').addEventListener('click', () => this.close(true));
    overlay.querySelector('.path-picker-cancel').addEventListener('click', () => this.close(true));
    overlay.querySelector('.path-picker-confirm').addEventListener('click', () => this.confirm());
    overlay.querySelector('.path-picker-current-select').addEventListener('click', () => {
      if (this._currentPath) this.select(this._currentPath);
    });
    overlay.querySelector('.path-picker-refresh').addEventListener('click', () => this.load(this._currentPath));
    overlay.querySelector('.path-picker-hidden').addEventListener('click', () => this.toggleHidden());
    this._syncHiddenButton();
    // Typing a path is the fast way there. The listing is loaded ONLY on Enter/Go,
    // never on each keystroke: a half-typed path is a 404 the server has to
    // answer for nothing, and jumping mid-edit would yank the field around.
    overlay.querySelector('.path-picker-jump').addEventListener('submit', (event) => {
      event.preventDefault();
      this.jumpTo(overlay.querySelector('.path-picker-current').value);
    });
    const sortSelect = overlay.querySelector('.path-picker-sort');
    for (const mode of PATH_PICKER_SORT_MODES) {
      const option = document.createElement('option');
      option.value = mode.value;
      option.textContent = mode.label;
      sortSelect.appendChild(option);
    }
    sortSelect.value = this._sortMode;
    sortSelect.addEventListener('change', (event) => this.setSortMode(event.target.value));
    overlay.querySelector('.path-picker-up').addEventListener('click', () => {
      const parent = overlay.querySelector('.path-picker-up').dataset.parent;
      if (parent) this.load(parent);
    });
    overlay.querySelector('.path-picker-roots').addEventListener('change', (event) => this.load(event.target.value));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.close(true);
    });
    this._keydownHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (this._previewOverlay) this.closePreview(true);
        else this.close(true);
      }
    };
    document.addEventListener('keydown', this._keydownHandler);
    document.body.appendChild(overlay);
    this.load(options.initialPath || '');
  },

  _loadShowHidden() {
    try {
      return localStorage.getItem(PATH_PICKER_SHOW_HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  },

  _syncHiddenButton() {
    const btn = this.overlay?.querySelector('.path-picker-hidden');
    if (!btn) return;
    const label = this._showHidden ? 'Hide hidden files and folders' : 'Show hidden files and folders';
    btn.classList.toggle('active', this._showHidden);
    btn.setAttribute('aria-pressed', this._showHidden ? 'true' : 'false');
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
  },

  toggleHidden() {
    if (!this.overlay) return;
    this._showHidden = !this._showHidden;
    try {
      localStorage.setItem(PATH_PICKER_SHOW_HIDDEN_KEY, this._showHidden ? '1' : '0');
    } catch {}
    this._syncHiddenButton();
    // Reload where we are rather than resetting to the root. Turning the toggle
    // OFF inside a hidden folder makes the current path unbrowsable again; the
    // server answers 403 and load()'s catch falls back to the default root,
    // which is the only place left to stand.
    this.load(this._currentPath || '');
  },

  _loadSortMode() {
    try {
      const stored = localStorage.getItem(PATH_PICKER_SORT_KEY);
      return PATH_PICKER_SORT_MODES.some((mode) => mode.value === stored) ? stored : PATH_PICKER_DEFAULT_SORT;
    } catch {
      return PATH_PICKER_DEFAULT_SORT;
    }
  },

  setSortMode(mode) {
    if (!PATH_PICKER_SORT_MODES.some((candidate) => candidate.value === mode)) return;
    this._sortMode = mode;
    try {
      localStorage.setItem(PATH_PICKER_SORT_KEY, mode);
    } catch {}
    const select = this.overlay?.querySelector('.path-picker-sort');
    if (select && select.value !== mode) select.value = mode;
    // Re-order what is already on screen; no round trip, no lost selection.
    if (this.overlay) this.renderEntries();
  },

  /**
   * Order entries for display. Folders always come first, whatever the mode:
   * a date sort is for finding the file you just made, and the folders are the
   * way past it, not the thing being looked for. An entry without an mtime (an
   * older server, the in-container source) sorts after every dated one and then
   * by name, so a listing never degrades into an unstable order.
   */
  _sortEntries(entries) {
    const [key, direction] = this._sortMode.split('-');
    const sign = direction === 'desc' ? -1 : 1;
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return entries.slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      if (key === 'mtime') {
        const aTime = typeof a.mtimeMs === 'number' ? a.mtimeMs : null;
        const bTime = typeof b.mtimeMs === 'number' ? b.mtimeMs : null;
        if (aTime !== null && bTime !== null && aTime !== bTime) return sign * (aTime - bTime);
        if (aTime === null && bTime !== null) return 1;
        if (aTime !== null && bTime === null) return -1;
        return byName(a, b);
      }
      return sign * byName(a, b);
    });
  },

  /** Compact modified-time label: time of day today, month-day this year, else the date. */
  _formatModified(mtimeMs) {
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return '';
    const date = new Date(mtimeMs);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (date.getFullYear() === now.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  },

  /**
   * Go to a path the user typed. A file path lands in its folder with the
   * file selected, so pasting a full path from a log or a message is one Enter
   * away from Select. A path that does not resolve lands in its parent folder
   * when that exists (the closest place to stand) and otherwise keeps the
   * current listing, and says so either way — unlike a stale initialPath, a
   * typo is not a reason to throw the user back to the root.
   */
  jumpTo(rawPath) {
    const path = String(rawPath || '').trim();
    if (!path) return;
    this.load(path, { typed: true });
  },

  async load(path, options = {}) {
    if (!this.overlay || !this._options) return;
    const loadSequence = ++this._loadSequence;
    const list = this.overlay.querySelector('.path-picker-list');
    const status = this.overlay.querySelector('.path-picker-status');
    const typed = !!options.typed;
    if (!typed) list.replaceChildren();
    status.classList.remove('error');
    status.textContent = 'Loading...';

    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (this._options.sessionId) params.set('sessionId', this._options.sessionId);
    if (this._showHidden) params.set('showHidden', 'true');
    try {
      // A caller may supply its own source (the container-workdir picker browses
      // INSIDE a container, which the host filesystem endpoint cannot answer).
      // It returns the same shape, so everything below is unchanged.
      const result = this._options.fetchListing
        ? await this._options.fetchListing(path)
        : await (await fetch(`/api/filesystem/browse?${params.toString()}`)).json();
      if (!result?.success) throw new Error(result?.error || 'Failed to browse this folder');
      if (!this.overlay || loadSequence !== this._loadSequence) return;
      this.render(result.data);
      if (options.selectIfListed) {
        // Landed in the typed path's folder: select the entry if it is there
        // (a file path), otherwise say what the server said about the full
        // path — the listing is still the closest place to stand.
        if (this._entries.some((entry) => entry.path === options.selectIfListed)) {
          this.select(options.selectIfListed);
        } else {
          status.textContent = options.failMessage || 'Path not found';
          status.classList.add('error');
        }
      }
    } catch (error) {
      if (!this.overlay || loadSequence !== this._loadSequence) return;
      const message = error.message || 'Failed to browse this folder';
      if (typed) {
        // The browse endpoint answers a FILE path with "not found" (it resolves
        // folders only), so one retry lands in the parent folder and selects
        // the entry from the listing. Only one level: a typo two segments up
        // is an error, not a reason to climb to the root.
        const slash = path.lastIndexOf('/');
        if (slash > 0 && !options.selectIfListed) {
          this.load(path.slice(0, slash), { typed: true, selectIfListed: path, failMessage: message });
          return;
        }
        this.renderEntries();
        status.textContent = options.failMessage || message;
        status.classList.add('error');
        return;
      }
      if (path) {
        this.load('');
        return;
      }
      status.textContent = message;
      status.classList.add('error');
    }
  },

  render(data) {
    const rootSelect = this.overlay.querySelector('.path-picker-roots');
    rootSelect.replaceChildren();
    for (const root of data.roots) {
      const option = document.createElement('option');
      option.value = root.path;
      option.textContent = `${root.label} — ${root.path}`;
      option.selected = data.path === root.path || data.root === root.path;
      rootSelect.appendChild(option);
    }

    this._currentPath = data.path;
    this.overlay.querySelector('.path-picker-current').value = data.path;
    const up = this.overlay.querySelector('.path-picker-up');
    up.dataset.parent = data.parent || '';
    up.disabled = !data.parent;
    this._entries = Array.isArray(data.entries) ? data.entries : [];
    this._truncated = !!data.truncated;
    this.renderEntries();
  },

  /** (Re)build the list from the last listing in the current sort order. */
  renderEntries() {
    if (!this.overlay) return;
    const entries = this._sortEntries(this._entries);
    const status = this.overlay.querySelector('.path-picker-status');
    status.classList.remove('error');
    status.textContent = entries.length === 0
      ? 'This folder is empty'
      : `${entries.length} item${entries.length === 1 ? '' : 's'}${this._truncated ? ' (first 500)' : ''}`;

    const list = this.overlay.querySelector('.path-picker-list');
    list.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'path-picker-item';
      if (entry.type === 'file' && this._options.directoriesOnly && !entry.previewKind) {
        row.classList.add('not-selectable');
      }
      row.dataset.path = entry.path;
      row.dataset.type = entry.type;
      row.setAttribute('role', 'option');

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'path-picker-item-main';
      const icon = document.createElement('span');
      icon.className = 'path-picker-item-icon';
      icon.textContent = entry.type === 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
      const name = document.createElement('span');
      name.className = 'path-picker-item-name';
      name.textContent = entry.name;
      open.append(icon, name);
      const modified = this._formatModified(entry.mtimeMs);
      if (modified) {
        const meta = document.createElement('span');
        meta.className = 'path-picker-item-meta';
        meta.textContent = modified;
        meta.title = new Date(entry.mtimeMs).toLocaleString();
        open.appendChild(meta);
      }
      if (entry.symlink) {
        const link = document.createElement('span');
        link.className = 'path-picker-item-link';
        link.textContent = '\u2197';
        open.appendChild(link);
      }
      if (entry.type === 'directory') {
        const chevron = document.createElement('span');
        chevron.className = 'path-picker-item-chevron';
        chevron.textContent = '\u203A';
        open.appendChild(chevron);
        open.addEventListener('click', () => this.load(entry.path));
      } else if (entry.previewKind) {
        const preview = document.createElement('span');
        preview.className = 'path-picker-item-preview';
        preview.textContent = '\uD83D\uDC41';
        open.appendChild(preview);
        open.title = `Preview ${entry.name}`;
        open.setAttribute('aria-label', `Preview ${entry.name}`);
        open.addEventListener('click', () => this.openPreview(entry));
      } else if (!this._options.directoriesOnly) {
        open.addEventListener('click', () => this.select(entry.path));
      } else {
        open.disabled = true;
      }
      row.appendChild(open);

      if (entry.type === 'directory' || !this._options.directoriesOnly) {
        const choose = document.createElement('button');
        choose.type = 'button';
        choose.className = 'path-picker-item-select';
        choose.textContent = 'Choose';
        choose.addEventListener('click', () => this.select(entry.path));
        row.appendChild(choose);
      }
      list.appendChild(row);
    }
  },

  select(path) {
    if (!this.overlay) return;
    this._selectedPath = path;
    this.overlay.querySelector('.path-picker-selection-value').textContent = path;
    this.overlay.querySelector('.path-picker-confirm').disabled = false;
    this.overlay.querySelectorAll('.path-picker-item').forEach((row) => {
      const selected = row.dataset.path === path;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  },

  openPreview(entry) {
    this.closePreview(false);
    this._previewPreviousFocus = document.activeElement;
    const requestSequence = ++this._previewRequestSequence;
    const params = new URLSearchParams({ path: entry.path });
    if (this._options?.sessionId) params.set('sessionId', this._options.sessionId);
    // A hidden file is only reachable while the toggle is on, and the preview
    // endpoint re-resolves the path independently, so it needs the flag too.
    if (this._showHidden) params.set('showHidden', 'true');
    const previewUrl = (window.CodemanBase?.url || ((p) => p))(`/api/filesystem/preview?${params.toString()}`);

    const overlay = document.createElement('div');
    overlay.className = 'path-preview-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Preview ${entry.name}`);
    overlay.innerHTML = `
      <div class="path-preview-dialog">
        <div class="path-preview-header">
          <div class="path-preview-heading">
            <strong class="path-preview-title"></strong>
            <span class="path-preview-path"></span>
          </div>
          <a class="path-preview-open" target="_blank" rel="noopener noreferrer">Open</a>
          <button type="button" class="path-preview-close" aria-label="Close preview">&times;</button>
        </div>
        <div class="path-preview-body"><div class="path-preview-loading">Loading preview...</div></div>
      </div>`;
    overlay.querySelector('.path-preview-title').textContent = entry.name;
    overlay.querySelector('.path-preview-path').textContent = entry.path;
    overlay.querySelector('.path-preview-open').href = previewUrl;
    overlay.querySelector('.path-preview-close').addEventListener('click', () => this.closePreview(true));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.closePreview(true);
    });
    document.body.appendChild(overlay);
    this._previewOverlay = overlay;

    const body = overlay.querySelector('.path-preview-body');
    if (entry.previewKind === 'image') {
      const image = document.createElement('img');
      image.className = 'path-preview-image';
      image.alt = entry.name;
      image.addEventListener('load', () => body.querySelector('.path-preview-loading')?.remove());
      image.addEventListener('error', () => this.showPreviewError('Image preview failed to load'));
      image.src = previewUrl;
      body.appendChild(image);
    } else if (entry.previewKind === 'text') {
      fetch(previewUrl)
        .then(async (response) => {
          const content = await response.text();
          if (!response.ok) {
            let message = 'Text preview failed to load';
            try {
              message = JSON.parse(content).error || message;
            } catch {}
            throw new Error(message);
          }
          return content;
        })
        .then((content) => {
          if (!this._previewOverlay || requestSequence !== this._previewRequestSequence) return;
          const pre = document.createElement('pre');
          pre.className = 'path-preview-text';
          pre.textContent = content;
          body.replaceChildren(pre);
        })
        .catch((error) => {
          if (requestSequence === this._previewRequestSequence) this.showPreviewError(error.message);
        });
    } else {
      const frame = document.createElement('iframe');
      frame.className = 'path-preview-frame';
      frame.title = entry.name;
      frame.addEventListener('load', () => body.querySelector('.path-preview-loading')?.remove());
      frame.src = previewUrl;
      body.appendChild(frame);
    }
    overlay.querySelector('.path-preview-close').focus();
  },

  showPreviewError(message) {
    const body = this._previewOverlay?.querySelector('.path-preview-body');
    if (!body) return;
    const error = document.createElement('div');
    error.className = 'path-preview-error';
    error.textContent = message || 'Preview failed to load';
    body.replaceChildren(error);
  },

  closePreview(restoreFocus = true) {
    this._previewRequestSequence += 1;
    this._previewOverlay?.remove();
    this._previewOverlay = null;
    const previousFocus = this._previewPreviousFocus;
    this._previewPreviousFocus = null;
    if (restoreFocus) previousFocus?.focus?.();
  },

  confirm() {
    if (!this._selectedPath || !this._options) return;
    const selectedPath = this._selectedPath;
    const onSelect = this._options.onSelect;
    this.close(false);
    onSelect(selectedPath);
  },

  close(restoreFocus = true) {
    if (this._keydownHandler) document.removeEventListener('keydown', this._keydownHandler);
    this._keydownHandler = null;
    this._loadSequence += 1;
    this.closePreview(false);
    this.overlay?.remove();
    this.overlay = null;
    const previousFocus = this._previousFocus;
    this._previousFocus = null;
    this._options = null;
    this._selectedPath = '';
    this._currentPath = '';
    this._entries = [];
    if (restoreFocus) previousFocus?.focus?.();
  },
};

// ═══════════════════════════════════════════════════════════════
// Mobile Keyboard Accessory Bar
// ═══════════════════════════════════════════════════════════════

/**
 * Control byte a terminal sends for Ctrl+<char> (issue #262).
 *
 * Returns null for characters with no control equivalent (digits, most
 * punctuation): the caller then sends the character unchanged, matching a
 * hardware keyboard where Ctrl+7 just types "7".
 *
 * `code & 0x1f` covers both ranges a terminal maps: @A-Z[\]^_ (64-95 → 0-31)
 * and a-z (97-122 → 1-26). Space and ? are the two conventional extras
 * (Ctrl+Space = NUL, Ctrl+? = DEL) and can't come from the mask.
 */
function ctrlByteFor(char) {
  if (typeof char !== 'string' || char.length !== 1) return null;
  const code = char.charCodeAt(0);
  if (code === 32) return '\x00';
  if (code === 63) return '\x7f';
  if ((code >= 64 && code <= 95) || (code >= 97 && code <= 122)) {
    return String.fromCharCode(code & 0x1f);
  }
  return null;
}

/**
 * Apply an armed one-shot Ctrl to one chunk of terminal input.
 * Returns `{ data, consumed }`, where `consumed` tells the bar to disarm.
 *
 * Multi-character chunks (pastes, escape sequences, IME commits) have no
 * single key to modify, but they still spend the modifier: leaving it armed
 * would silently turn the NEXT innocent keystroke into a control byte.
 */
function applyOneShotCtrl(data) {
  if (typeof data !== 'string' || data.length === 0) return { data, consumed: false };
  if (data.length === 1) {
    const byte = ctrlByteFor(data);
    return { data: byte === null ? data : byte, consumed: true };
  }
  return { data, consumed: true };
}

/**
 * KeyboardAccessoryBar - Quick action buttons shown above keyboard when typing.
 */
const KeyboardAccessoryBar = {
  element: null,
  // Layout currently in the DOM: 'simple' | 'extended' | 'shell'.
  _mode: 'simple',
  // Layout the user picked for AGENT sessions ('simple' | 'extended', the
  // extendedKeyboardBar setting). Shell sessions override it with the shell
  // bar; this is what we come back to when they switch to an agent tab.
  _baseMode: 'simple',
  // One-shot Ctrl modifier (shell bar only). See handleAction('ctrl').
  _ctrlArmed: false,

  /** HTML for simple mode: arrows, commands, paste, Esc, dismiss */
  _simpleButtons: `
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-up" title="Arrow up">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M5 15l7-7 7 7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-down" title="Arrow down">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="init" title="/init">/init</button>
      <button class="accessory-btn" data-action="tab" title="Tab">Tab</button>
      <button class="accessory-btn" data-action="paste" title="Paste from clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-rmm" data-action="readmymind" title="Read My Mind: predict your next prompt">🧠</button>
      <button class="accessory-btn" data-action="esc" title="Escape">Esc</button>
      <button class="accessory-btn accessory-btn-dismiss" data-action="dismiss" title="Dismiss keyboard">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>`,

  /** HTML for shell mode (issue #262): terminal controls instead of agent
   *  commands. Ctrl is a one-shot modifier rather than one button per chord,
   *  which is what puts Ctrl+C/D/Z/R/L/A/E/W/U/K on a 9-button bar. */
  _shellButtons: `
      <button class="accessory-btn accessory-btn-ctrl" data-action="ctrl" title="Ctrl, then tap a key" aria-pressed="false">Ctrl</button>
      <button class="accessory-btn" data-action="esc" title="Escape">Esc</button>
      <button class="accessory-btn" data-action="tab" title="Tab">Tab</button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-up" title="Arrow up">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M5 15l7-7 7 7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-down" title="Arrow down">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="arrow-left" title="Arrow left">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M15 19l-7-7 7-7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="arrow-right" title="Arrow right">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M9 5l7 7-7 7"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="paste" title="Paste from clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-dismiss" data-action="dismiss" title="Dismiss keyboard">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>`,

  /** HTML for extended mode: all keys including arrows, Tab, Esc, etc. */
  _extendedButtons: `
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-up" title="Arrow up">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M5 15l7-7 7 7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-down" title="Arrow down">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="arrow-left" title="Arrow left">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M15 19l-7-7 7-7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="arrow-right" title="Arrow right">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M9 5l7 7-7 7"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="paste" title="Paste from clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="pick-path" title="Insert a file or folder path">&#x1F4C1; Path</button>
      <button class="accessory-btn" data-action="clear-input" title="Clear the current unsent input">&#x232B; All</button>
      <button class="accessory-btn accessory-btn-rmm" data-action="readmymind" title="Read My Mind: predict your next prompt">🧠</button>
      <button class="accessory-btn" data-action="tab" title="Tab">Tab</button>
      <button class="accessory-btn" data-action="shift-tab" title="Shift+Tab">⇧Tab</button>
      <button class="accessory-btn" data-action="effort-max" title="/effort max">Max</button>
      <button class="accessory-btn" data-action="ctrl-o" title="Ctrl+O">⌃O</button>
      <button class="accessory-btn" data-action="opt-enter" title="Option+Enter (newline)">⌥Enter</button>
      <button class="accessory-btn" data-action="esc" title="Escape">Esc</button>
      <button class="accessory-btn" data-action="init" title="/init">/init</button>
      <button class="accessory-btn" data-action="clear" title="/clear">/clear</button>
      <button class="accessory-btn" data-action="compact" title="/compact">/compact</button>
      <button class="accessory-btn accessory-btn-dismiss" data-action="dismiss" title="Dismiss keyboard">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>`,

  /** Create and inject the accessory bar */
  init() {
    // Only on mobile
    if (!MobileDetection.isTouchDevice()) return;

    // Create accessory bar element
    this.element = document.createElement('div');
    this.element.className = 'keyboard-accessory-bar';
    this.element.innerHTML = this._simpleButtons;
    // The 🧠 key is opt-in (`readMyMindEnabled`, synced): it ships in both
    // templates but stays display:none until the bar carries the marker class.
    this.syncReadMyMind();

    // Add click handlers — preventDefault stops event from reaching terminal
    this.element.addEventListener('click', (e) => {
      const btn = e.target.closest('.accessory-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const action = btn.dataset.action;
      this.handleAction(action, btn);

      // Refocus terminal so keyboard stays open (tap blurs terminal → keyboard dismisses → toolbar shifts)
      const refocusActions = new Set(['scroll-up', 'scroll-down', 'arrow-left', 'arrow-right', 'tab', 'shift-tab', 'ctrl', 'ctrl-o', 'opt-enter', 'esc', 'effort-max', 'clear-input']);
      if (refocusActions.has(action) ||
          ((action === 'clear' || action === 'compact') && this._confirmAction)) {
        if (typeof app !== 'undefined' && app.terminal) {
          app.terminal.focus();
        }
      }
    });

    // Insert before toolbar
    const toolbar = document.querySelector('.toolbar');
    if (toolbar && toolbar.parentNode) {
      toolbar.parentNode.insertBefore(this.element, toolbar);
    }
  },

  /** Pick the layout the user wants for AGENT sessions ('simple' | 'extended',
   *  the extendedKeyboardBar setting). A shell session keeps the shell bar;
   *  the preference is remembered and applied on the next agent tab. */
  setMode(mode) {
    this._baseMode = mode === 'extended' ? 'extended' : 'simple';
    this._applyLayout(this._resolveMode());
  },

  /** Re-resolve the layout after the active session changed (issue #262):
   *  shell sessions get the terminal bar, everything else the agent bar. Also
   *  disarms Ctrl, because a modifier armed on one session must never fire on
   *  the next one. */
  refreshForActiveSession() {
    this.clearCtrl();
    this._applyLayout(this._resolveMode());
  },

  /** Which layout the current state calls for. */
  _resolveMode() {
    return this._isShellSession() ? 'shell' : this._baseMode;
  },

  _isShellSession() {
    if (typeof app === 'undefined' || !app.activeSessionId) return false;
    return app.sessions?.get(app.activeSessionId)?.mode === 'shell';
  },

  /** Swap the button set in the DOM. */
  _applyLayout(mode) {
    if (!this.element || mode === this._mode) return;
    this._mode = mode;
    this.clearConfirm();
    // Reset before the rewrite: _setCtrl() styles the button it can find, and
    // the one holding the armed class is about to be replaced.
    this.clearCtrl();
    this.element.innerHTML =
      mode === 'shell' ? this._shellButtons : mode === 'extended' ? this._extendedButtons : this._simpleButtons;
  },

  // ── One-shot Ctrl modifier (shell bar) ──────────────────────────────────
  // Tap Ctrl, then type a character on the system keyboard: the character is
  // replaced by its control byte and Ctrl disarms. Tapping Ctrl again cancels.
  // The interception lives in the terminal onData handler (terminal-ui.js),
  // which is where system-keyboard input arrives on a phone. A keydown hook
  // would miss it, since virtual keyboards report no usable key events.

  /** Is the one-shot Ctrl waiting for a key? */
  isCtrlArmed() {
    return this._ctrlArmed === true;
  },

  /** Arm/cancel the one-shot Ctrl (the Ctrl button toggles). */
  toggleCtrl() {
    this._setCtrl(!this._ctrlArmed);
  },

  /** Disarm: used by session switch, keyboard dismissal and every other key. */
  clearCtrl() {
    if (this._ctrlArmed) this._setCtrl(false);
  },

  _setCtrl(on) {
    this._ctrlArmed = !!on;
    const btn = this.element?.querySelector('[data-action="ctrl"]');
    if (btn) {
      btn.classList.toggle('armed', this._ctrlArmed);
      btn.setAttribute('aria-pressed', this._ctrlArmed ? 'true' : 'false');
    }
  },

  /**
   * Apply an armed Ctrl to a chunk of typed input and disarm.
   * Returns the data unchanged (and leaves the modifier alone) when Ctrl is
   * not armed, so the caller can pipe every keystroke through it.
   */
  consumeCtrl(data) {
    if (!this._ctrlArmed) return data;
    const result = applyOneShotCtrl(data);
    if (result.consumed) this.clearCtrl();
    return result.data;
  },

  /** Exposed for tests: pure char to control byte mapping. */
  ctrlByteFor,

  _confirmTimer: null,
  _confirmAction: null,

  /** Handle accessory button actions */
  handleAction(action, btn) {
    if (typeof app === 'undefined' || !app.activeSessionId) return;

    // Any key other than Ctrl itself spends the modifier. It is a one-shot for
    // the next TYPED character, so an accessory key tapped in between (Esc, an
    // arrow, paste) must not leave it armed to bite the keystroke after that.
    if (action !== 'ctrl') this.clearCtrl();

    switch (action) {
      case 'ctrl':
        this.toggleCtrl();
        break;
      case 'scroll-up':
        this.sendNavKey('\x1b[A');
        break;
      case 'scroll-down':
        this.sendNavKey('\x1b[B');
        break;
      case 'arrow-left':
        this.sendNavKey('\x1b[D');
        break;
      case 'arrow-right':
        this.sendNavKey('\x1b[C');
        break;
      case 'esc':
        this.sendKey('\x1b');
        break;
      case 'opt-enter':
        this.sendKey('\x1b\r');
        break;
      case 'tab':
        // Tab means "complete what I just typed", but with local echo the typed
        // text is still buffered in the overlay and has never reached the PTY —
        // a bare \t would ask the CLI to complete an empty composer.
        this.flushPendingThen(() => this.sendKey('\t'));
        break;
      case 'shift-tab':
        this.sendKey('\x1b[Z');
        break;
      case 'ctrl-o':
        this.sendKey('\x0f');
        break;
      case 'effort-max':
        this.sendCommand('/effort max');
        break;
      case 'init':
        this.sendCommand('/init');
        break;
      case 'clear':
      case 'compact': {
        const cmd = action === 'clear' ? '/clear' : '/compact';
        if (this._confirmAction === action && this._confirmTimer) {
          this.clearConfirm();
          this.sendCommand(cmd);
        } else {
          this.setConfirm(action, btn);
        }
        break;
      }
      case 'readmymind':
        // Opens the shared Read My Mind modal (readmymind-ui.js); the modal
        // takes focus, so deliberately NOT in the terminal-refocus set.
        app.openReadMyMind?.();
        break;
      case 'paste':
        this.pasteFromClipboard();
        break;
      case 'pick-path':
        this.pickPath();
        break;
      case 'clear-input':
        app.clearTerminalInput?.();
        break;
      case 'dismiss':
        // Blur active element to dismiss keyboard
        document.activeElement?.blur();
        break;
    }
  },

  /** Enter confirm state: button turns amber for 2s waiting for second tap */
  setConfirm(action, btn) {
    this.clearConfirm();
    this._confirmAction = action;
    if (btn) {
      btn.classList.add('confirming');
      btn.dataset.origHtml = btn.innerHTML;
      btn.textContent = 'Tap again';
    }
    this._confirmTimer = setTimeout(() => this.clearConfirm(), 2000);
  },

  /** Reset confirm state */
  clearConfirm() {
    if (this._confirmTimer) {
      clearTimeout(this._confirmTimer);
      this._confirmTimer = null;
    }
    if (this._confirmAction && this.element) {
      const btn = this.element.querySelector(`[data-action="${this._confirmAction}"]`);
      if (btn && btn.dataset.origHtml) {
        btn.innerHTML = btn.dataset.origHtml;
        delete btn.dataset.origHtml;
      }
      if (btn) btn.classList.remove('confirming');
    }
    this._confirmAction = null;
  },

  /** Reveal/hide the 🧠 key from the synced `readMyMindEnabled` setting.
   *  The marker class lives on the BAR because setMode() rebuilds the buttons'
   *  innerHTML on every layout switch (per-key state would be wiped). Called at
   *  init and re-synced by applyHeaderVisibilitySettings() on every settings
   *  apply, so a live toggle needs no reload. */
  syncReadMyMind() {
    if (!this.element) return;
    const enabled = typeof app !== 'undefined' && typeof app.readMyMindEnabled === 'function' && app.readMyMindEnabled();
    this.element.classList.toggle('rmm-enabled', enabled === true);
  },

  /** Send a slash command to the active session.
   *  Sends text and Enter separately so Ink processes them as distinct events. */
  sendCommand(command) {
    if (!app.activeSessionId) return;
    // Send command text first (without Enter)
    app.sendInput(command);
    // Send Enter separately after a brief delay so Ink has time to process the text.
    setTimeout(() => app.sendInput('\r'), 120);
  },

  /**
   * Flush whatever the local-echo overlay is still holding, THEN run `after()`.
   *
   * On a phone the characters you type sit in the overlay and have never
   * reached the PTY, so any key that acts on "what I just typed" has to push
   * that text out first or the CLI acts on an empty composer. Mirrors the
   * flush the typed path performs in terminal-ui.js's onData; the 120ms is the
   * same settle delay sendCommand uses, so the text lands before the key.
   */
  flushPendingThen(after) {
    const overlay = app._localEchoOverlay;
    const pending = (app._localEchoEnabled && overlay?.pendingText) || '';
    if (!pending) {
      after();
      return;
    }
    overlay.clear();
    overlay.suppressBufferDetection?.();
    app._flushedOffsets?.delete(app.activeSessionId);
    app._flushedTexts?.delete(app.activeSessionId);
    app.sendInput(pending);
    setTimeout(after, 120);
  },

  /**
   * A composer nav key (the four arrows) from the bar, under the SAME contract
   * as pressing one on a hardware keyboard (the `isComposerNavKey` branch of
   * terminal-ui.js's onData): flush the unsent draft so the key edits the real
   * composer, then hand the session to plain PTY echo until Enter or Ctrl+C,
   * because after a nav key the cursor can sit mid-text where the overlay's
   * append-only buffering cannot track edits (issue #218).
   *
   * Without the flush the arrow reached a composer the CLI still saw as EMPTY:
   * Up recalled a history entry into it while the overlay went on painting the
   * draft over the same row and still believed it was pending. The draft was
   * then submitted on top of the recalled text, and history recall looked
   * broken because what came back was never what the row showed.
   */
  sendNavKey(sequence) {
    if (!app.activeSessionId) return;
    if (!app._echoPassthroughSessions) app._echoPassthroughSessions = new Set();
    app._echoPassthroughSessions.add(app.activeSessionId);
    this.flushPendingThen(() => this.sendKey(sequence));
  },

  /** Send a special key (arrow, escape, etc.) directly to the PTY.
   *  Bypasses tmux send-keys -l (literal mode) since escape sequences
   *  must be written raw to be interpreted as key presses by Ink. */
  sendKey(escapeSequence) {
    if (!app.activeSessionId) return;
    // Arrows/Esc move the server-side cursor and bypass onData: clear
    // predictions now instead of waiting out the ~150ms off-row grace.
    app._predictiveEcho?.clearPredictions();
    fetch(`/api/sessions/${app.activeSessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: escapeSequence })
    }).catch(() => {});
  },

  /** Browse the active session's workspace and insert a selected path without Enter. */
  pickPath() {
    if (!app.activeSessionId) return;
    const session = app.sessions?.get(app.activeSessionId);
    PathPicker.open({
      title: 'Insert File or Folder Path',
      sessionId: app.activeSessionId,
      initialPath: session?.workingDir || '',
      directoriesOnly: false,
      onSelect: (path) => {
        app.insertTerminalText?.(path);
        setTimeout(() => app.terminal?.focus(), 100);
      },
    });
  },

  /** Show a paste overlay for iOS compatibility.
   *  Handles three input paths from one dialog:
   *   - Text: long-press the textarea → Paste → Send (unchanged).
   *   - Image (picker): the "Image" button opens a native file picker
   *     (accept=image/* → camera / photo library / files), the most reliable
   *     way to attach a photo on mobile.
   *   - Image (paste): if the browser exposes image blobs on the textarea's
   *     paste event, we intercept them and upload directly. Support is spotty
   *     on mobile, so it is a best-effort enhancement layered on the picker.
   *  All image paths reuse app._uploadAndInsertImages() (image-input.js), which
   *  uploads to /api/sessions/:id/paste-image and inserts the saved path. */
  pasteFromClipboard() {
    if (typeof app === 'undefined' || !app.activeSessionId) return;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'paste-overlay';
    overlay.innerHTML = `
      <div class="paste-dialog">
        <textarea class="paste-textarea" placeholder="Long-press to paste text — or tap 🖼 to attach an image"></textarea>
        <div class="paste-actions">
          <button class="paste-image">🖼 Image</button>
          <button class="paste-cancel">Cancel</button>
          <button class="paste-send">Send</button>
        </div>
        <input type="file" class="paste-file-input" accept="image/*" multiple hidden>
      </div>
    `;

    const textarea = overlay.querySelector('.paste-textarea');
    const fileInput = overlay.querySelector('.paste-file-input');

    const close = () => overlay.remove();

    const sendText = () => {
      const text = textarea.value;
      close();
      if (text) {
        app.sendInput(text);
        setTimeout(() => app.sendInput('\r'), 80);
      }
    };

    // Filter to images, close the dialog, and hand off to the shared
    // upload+insert pipeline. Returns true if any image was handled.
    const handleImages = (files) => {
      const images = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) return false;
      close();
      if (typeof app._uploadAndInsertImages === 'function') app._uploadAndInsertImages(images);
      return true;
    };

    // Image picker (camera / photo library) — the reliable mobile path.
    overlay.querySelector('.paste-image').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => handleImages(fileInput.files));

    // Best-effort: capture images pasted straight into the textarea.
    textarea.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const imageFiles = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const blob = items[i].getAsFile();
          if (blob) imageFiles.push(blob);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleImages(imageFiles);
      }
    });

    overlay.querySelector('.paste-cancel').addEventListener('click', close);
    overlay.querySelector('.paste-send').addEventListener('click', sendText);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    document.body.appendChild(overlay);
    textarea.focus();
  },

  /** Show the accessory bar */
  show() {
    if (this.element) {
      this.element.classList.add('visible');
    }
  },

  /** Hide the accessory bar */
  hide() {
    // The bar goes away with the keyboard, so an armed Ctrl has nothing left
    // to modify, and a modifier the user can no longer see must not survive
    // to the next time they open the keyboard.
    this.clearCtrl();
    if (this.element) {
      this.element.classList.remove('visible');
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// Accessibility: Focus Trap for Modals
// ═══════════════════════════════════════════════════════════════

/**
 * FocusTrap - Traps keyboard focus within an element (typically a modal).
 * Saves the previously focused element and restores focus when deactivated.
 */
class FocusTrap {
  constructor(element) {
    this.element = element;
    this.previouslyFocused = null;
    this.boundHandleKeydown = this.handleKeydown.bind(this);
  }

  activate() {
    this.previouslyFocused = document.activeElement;
    this.element.addEventListener('keydown', this.boundHandleKeydown);

    // Focus first focusable element after a brief delay (for CSS transitions)
    requestAnimationFrame(() => {
      const focusable = this.getFocusableElements();
      if (focusable.length) {
        focusable[0].focus();
      }
    });
  }

  deactivate() {
    this.element.removeEventListener('keydown', this.boundHandleKeydown);
    if (this.previouslyFocused && typeof this.previouslyFocused.focus === 'function') {
      this.previouslyFocused.focus();
    }
  }

  getFocusableElements() {
    const selector = [
      'button:not([disabled]):not([tabindex="-1"])',
      'input:not([disabled]):not([tabindex="-1"])',
      'select:not([disabled]):not([tabindex="-1"])',
      'textarea:not([disabled]):not([tabindex="-1"])',
      'a[href]:not([tabindex="-1"])',
      '[tabindex]:not([tabindex="-1"]):not([disabled])'
    ].join(', ');

    return [...this.element.querySelectorAll(selector)].filter(
      el => el.offsetParent !== null // Exclude hidden elements
    );
  }

  handleKeydown(e) {
    if (e.key !== 'Tab') return;

    const focusable = this.getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
