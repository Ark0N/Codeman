// src/web/public/tile-grid.js

/**
 * @fileoverview The tile grid: 1 to 9 live sessions side by side in one
 * window, each in its own TerminalTile (terminal-tile.js), laid out by count
 * (window.CodemanTileGrid, constants.js). Desktop only; see
 * docs/tile-grid-plan.md.
 *
 * While the grid is open the main terminal (terminal-ui.js) is PARKED: hidden,
 * its socket closed, and every path that would write to it, fetch for it or
 * reconnect it stands aside (`_tilesOwnTerminal()`). `activeSessionId` always
 * names the FOCUSED tile's session, so everything keyed on it (files panel,
 * respawn and Ralph panels, subagent windows, voice, image paste, the tab
 * highlight) follows focus without knowing tiles exist.
 *
 * Every capture a tile fetches goes through the grid's one TileLoadQueue,
 * because each is a synchronous tmux call on the server.
 *
 * @dependency terminal-tile.js (window.TerminalTile, window.TileLoadQueue)
 * @dependency constants.js (window.CodemanTileGrid, SPLIT_PANE_MIN_WIDTH)
 * @loadorder 7.6 of 16, loaded after terminal-split.js and before respawn-ui.js
 */

// Per-device tile font size (a tile is a fraction of the screen).
const TILE_GRID_FONT_KEY = 'codeman-tile-font-size';
// The grid this device last had, ids only (sanitizeTileGridState, constants.js):
// `{ v: 1, open, ids, focused, zoomed, colFr, rowFr }`. `open: false` keeps it
// remembered for one-click return; restored on reload inside handleInit.
const TILE_GRID_STORAGE_KEY = 'codeman:tile-grid';
// Trailing debounce for refitting tiles after the grid area changes size, so a
// window drag sends each tile's PTY one resize, not one per frame.
const TILE_GRID_REFIT_MS = 150;
// Width of the draggable column and row dividers (their own grid tracks), and
// the grid section's padding (styles.css .tile-grid), for the drag math.
const TILE_DIVIDER_PX = 6;
const TILE_GRID_PADDING_PX = 4;

/** `minmax(0, 1fr) 6px minmax(0, 2fr) ...`: tracks with a divider track between each. */
function tileGridTracks(fr) {
  return fr.map((f) => `minmax(0, ${Math.round(f * 1000) / 1000}fr)`).join(` ${TILE_DIVIDER_PX}px `);
}
// Registry ids of the tile chords (DEFAULT_SHORTCUTS, app.js), and whether each
// needs the grid open. The toggle applies wherever a grid could open.
const TILE_SHORTCUTS = {
  'toggle-tile-grid': { needsOpen: false },
  'focus-tile-left': { needsOpen: true, direction: 'left' },
  'focus-tile-right': { needsOpen: true, direction: 'right' },
  'focus-tile-up': { needsOpen: true, direction: 'up' },
  'focus-tile-down': { needsOpen: true, direction: 'down' },
  'remove-tile': { needsOpen: true },
  'zoom-tile': { needsOpen: true },
};

/** The grid's state. `has(id)` answers only while it is open. */
class TileGridModel {
  constructor() {
    this.open = false;
    // Session ids in reading order (row-major).
    this.ids = [];
    // id -> { tile: TerminalTile, el: HTMLElement }
    this.tiles = new Map();
    this.focusedId = null;
    // The tile filling the grid (tmux zoom), or null. `autoZoom`: zoomed by the
    // grid itself because the window cannot fit the tiles; it follows focus and
    // lifts once the window fits again.
    this.zoomedId = null;
    this.autoZoom = false;
    // Track fractions (grid-template fr values) set by the dividers; equal
    // again whenever the column or row count changes.
    this.colFr = [];
    this.rowFr = [];
    // 'col-<i>' / 'row-<i>' -> the divider element between track i and i+1.
    this.dividers = new Map();
    this.cols = 0;
    this.rows = 0;
    this.queue = null;
    this.resizeObserver = null;
    this.refitTimer = null;
  }

  has(id) {
    return this.open && this.tiles.has(id);
  }
}

Object.assign(CodemanApp.prototype, {
  /**
   * True while the grid owns the terminal area and the main terminal is parked.
   * Every main-terminal path that would write, fetch, resize or reconnect checks
   * this and stands aside.
   */
  _tilesOwnTerminal() {
    return !!this._tileGrid?.open;
  },

  /** The open grid's TerminalTile for a session, or null. */
  _tileFor(sessionId) {
    return this._tileGrid?.open ? (this._tileGrid.tiles.get(sessionId)?.tile ?? null) : null;
  },

  /** Desktop only, never in a solo (popped-out) window; same gate as the split. */
  canOpenTileGrid() {
    return !this.isSoloWindow && window.innerWidth >= SPLIT_PANE_MIN_WIDTH;
  },

  _tileGridFontSize() {
    let saved = NaN;
    try {
      saved = parseInt(localStorage.getItem(TILE_GRID_FONT_KEY), 10);
    } catch {
      /* Storage unavailable: the default below. */
    }
    return saved >= 10 && saved <= 24 ? saved : window.CodemanTileGrid.TILE_FONT_SIZE_DEFAULT;
  },

  /** Ctrl +/- while the grid is open: every tile, then each tile's PTY (a font change is a size change, #464). */
  setTileFontSize(size) {
    try {
      localStorage.setItem(TILE_GRID_FONT_KEY, String(size));
    } catch {
      /* Per-device convenience only. */
    }
    for (const { tile } of this._tileGrid?.tiles.values() || []) {
      tile.fontSize = size;
      if (!tile.terminal) continue;
      tile.terminal.options.fontSize = size;
      tile.fit();
    }
  },

  _tileLoadQueue() {
    const grid = this._tileGrid;
    if (!grid.queue) {
      grid.queue = new window.TileLoadQueue({
        // The focused tile first, then reading order.
        rank: (tile) => (tile.sessionId === grid.focusedId ? -1 : grid.ids.indexOf(tile.sessionId)),
        // A quiet "loading" state on a tile until its capture has landed.
        onChange: (tile, state) => {
          const entry = grid.tiles.get(tile.sessionId);
          if (entry?.tile === tile) entry.el.classList.toggle('tile--loading', state !== 'idle');
        },
      });
    }
    return grid.queue;
  },

  _tileGridSection() {
    let section = document.getElementById('tileGrid');
    if (!section) {
      section = document.createElement('section');
      section.id = 'tileGrid';
      section.className = 'tile-grid';
      section.setAttribute('aria-label', 'Tiled sessions');
      const wrap = document.querySelector('.terminal-wrap');
      wrap?.parentElement?.insertBefore(section, wrap.nextSibling);
    }
    return section;
  },

  /**
   * Opens the grid on `ids` (unknown, detached and duplicate ids are skipped;
   * at most TILE_GRID_MAX), focusing `focusedId` or the first. Already open, it
   * adds what is missing and moves focus. `auto: false` makes the focus a human
   * selection (it acknowledges that session's idle alert).
   *
   * Parks the main terminal first: `_cleanupPreviousSession()` runs ONCE, while
   * its snapshot of the session it shows is still right, and closes its socket.
   *
   * @returns {boolean} whether the grid is open afterwards
   */
  openTileGrid(ids, { focusedId = null, auto = true } = {}) {
    if (!this.canOpenTileGrid()) return false;
    const grid = (this._tileGrid ||= new TileGridModel());
    const max = window.CodemanTileGrid.TILE_GRID_MAX;
    // The grid and the split are never open together. An open split becomes the
    // grid's first two tiles (Pane A focused, Pane B beside it), so "split, then
    // want more" is one step. No closing resize for Pane A: it is about to park.
    let requested = ids || [];
    if (this._splitPane) {
      const seed = [this.activeSessionId, this._splitSessionId].filter(Boolean);
      this.closeSplitPane({ skipPrimaryResize: true });
      requested = [...seed, ...requested];
      if (!requested.includes(focusedId)) focusedId = seed[0] ?? null;
    }
    const wanted = [];
    for (const id of requested) {
      if (typeof id !== 'string' || wanted.includes(id)) continue;
      if (!this.sessions.has(id) || this.detachedSessions?.has(id)) continue;
      wanted.push(id);
      if (wanted.length === max) break;
    }
    if (wanted.length === 0) return grid.open;
    const focus = wanted.includes(focusedId) ? focusedId : wanted[0];

    if (grid.open) {
      for (const id of wanted) this.addTile(id);
      if (grid.has(focus)) this._selectTiledSession(focus, { auto });
      return true;
    }

    this._cleanupPreviousSession(focus);
    grid.open = true;
    grid.ids = [];
    grid.focusedId = focus;
    document.querySelector('.main')?.classList.add('tiles-active');
    const section = this._tileGridSection();
    this.hideWelcome();
    // Mount every tile and lay the grid out BEFORE any tile connects, so each
    // first fit measures its real cell; the focused tile connects first, so
    // its capture is the one the queue starts with.
    for (const id of wanted) this._mountTile(id);
    this._applyTileLayout();
    for (const id of [focus, ...wanted.filter((id) => id !== focus)]) this._connectTile(id);
    if (!grid.resizeObserver && typeof ResizeObserver !== 'undefined') {
      // The main terminal's observer watches a node that is now hidden; this one
      // catches window resizes, sidebar toggles and rail drags for the grid.
      grid.resizeObserver = new ResizeObserver(() => this._scheduleTileGridRefit());
      grid.resizeObserver.observe(section);
    }
    this._installTileGridWidthGate();
    this._selectTiledSession(focus, { auto });
    this._updateConnectionIndicator?.();
    this._updateSplitButtonForTiles();
    this._updateTileGridButtonState();
    return true;
  },

  /**
   * Leaves the grid: every tile destroyed (sockets closed, xterms disposed,
   * queued loads dropped), the main terminal unparked.
   *
   * `keepStored` remembers the grid for one-click return (toggleTileGrid).
   * `reselect` shows the focused session in the single view through a forced
   * reload; pass false when the caller selects something itself.
   *
   * The main terminal's cached content for EVERY tiled id is invalidated: it was
   * written before the grid opened, possibly hours ago, and selectSession paints
   * a snapshot as its first frame.
   */
  closeTileGrid({ keepStored = true, reselect = true } = {}) {
    const grid = this._tileGrid;
    if (!grid?.open) return;
    const focusedId = grid.focusedId;
    const ids = grid.ids.slice();
    // Remembered (closed) for one-click return, or forgotten.
    if (keepStored) this._persistTileGrid({ open: false });
    else this._forgetStoredTileGrid();
    // A divider drag in progress ends with the grid.
    this._tileDividerDragTeardown?.();
    // Closed BEFORE the tiles go: each destroy() updates the header's connection
    // state, which must read the main terminal again, not half-destroyed tiles.
    grid.open = false;
    clearTimeout(grid.refitTimer);
    grid.refitTimer = null;
    grid.resizeObserver?.disconnect();
    grid.resizeObserver = null;
    for (const { tile, el } of grid.tiles.values()) {
      grid.queue?.drop(tile);
      tile.destroy();
      el.remove();
    }
    grid.tiles.clear();
    for (const el of grid.dividers.values()) el.remove();
    grid.dividers.clear();
    for (const slot of grid.slots || []) slot.remove();
    grid.slots = [];
    grid.colFr = [];
    grid.rowFr = [];
    grid.ids = [];
    grid.focusedId = null;
    grid.zoomedId = null;
    grid.autoZoom = false;
    document.querySelector('.main')?.classList.remove('tiles-active');
    const section = document.getElementById('tileGrid');
    if (section) {
      section.style.gridTemplateColumns = '';
      section.style.gridTemplateRows = '';
      section.classList.remove('tile-grid--zoomed');
    }
    // As _redock does: the tiles sized these PTYs, so the main terminal's
    // record of the last size it sent no longer describes them.
    this._lastResizeDims = null;
    for (const id of ids) {
      this._xtermSnapshots?.delete(id);
      try {
        localStorage.removeItem(`codeman-xs-${id}`);
      } catch {
        /* Nothing stored. */
      }
      this.terminalBufferCache?.delete(id);
    }
    this._updateConnectionIndicator?.();
    this._updateSplitButtonForTiles();
    this._updateTileGridButtonState();
    this.closeTileAddMenu();
    // The tabs drop their .in-tiles marker.
    this.renderSessionTabs?.();
    if (reselect) this._selectAfterTileGrid(focusedId);
  },

  /**
   * The header Tiles button: shown when its per-device setting is on AND the
   * window is desktop-wide (a JS check plus a live media listener, the same
   * pair as the Split button; the CSS `@media (max-width: 1179px)` rule is the
   * backstop that hides it even if this never runs).
   */
  _applyTileGridButtonVisibility(enabled) {
    this._tileGridButtonSettingEnabled = !!enabled;
    const btn = document.querySelector('.btn-tile-grid');
    const wide = window.innerWidth >= SPLIT_PANE_MIN_WIDTH;
    btn?.classList.toggle('btn-tile-grid--hidden', !enabled || !wide || !!this.isSoloWindow);
    if (!this._tileGridButtonWidthListener && window.matchMedia) {
      this._tileGridButtonWidthListener = true;
      const mq = window.matchMedia(`(min-width: ${SPLIT_PANE_MIN_WIDTH}px)`);
      mq.addEventListener('change', () => this._applyTileGridButtonVisibility(this._tileGridButtonSettingEnabled));
    }
  },

  // Open grid: the button's click closes it, and says so.
  _updateTileGridButtonState() {
    const btn = document.querySelector('.btn-tile-grid');
    if (!btn) return;
    const open = this._tilesOwnTerminal();
    btn.classList.toggle('tiles-open', open);
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    const title = open ? 'Tiles: back to a single session' : 'Tiles: show several sessions side by side';
    btn.title = title;
    btn.setAttribute('aria-label', title);
  },

  /** How many tiles the terminal area can hold right now (the grid section, or the single view it would replace). */
  _tileGridCapacityNow() {
    const el = this._tilesOwnTerminal() ? this._tileGridSection() : document.querySelector('.terminal-wrap');
    const rect = el?.getBoundingClientRect?.() || { width: 0, height: 0 };
    return window.CodemanTileGrid.tileGridCapacity({
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
    });
  },

  /**
   * The Tiles button: with the grid open it closes it (back to the single view
   * of the focused session); otherwise it opens a picker with a checkbox per
   * open session, in tab order, preselected with the grid this tab last left
   * (else the active session and an open split's two), and an Open button.
   * Boxes past what the window can fit are disabled.
   */
  openTilePicker(event) {
    // As the split picker: the opening click must not reach the outside-click
    // listener this call installs.
    event?.stopPropagation?.();
    if (this._tilesOwnTerminal()) {
      this.closeTileGrid({ keepStored: true, reselect: true });
      return;
    }
    if (this._tilePicker) {
      this.closeTilePicker();
      return;
    }
    if (!this.canOpenTileGrid()) return;
    const T = window.CodemanTileGrid;
    const capacity = Math.max(1, Math.min(this._tileGridCapacityNow(), T.TILE_GRID_MAX));
    const candidates = T.buildTilePickerSessions(this.sessions, this.sessionOrder, this.detachedSessions);
    const remembered = (this._readStoredTileGrid()?.ids || []).filter((id) => candidates.some((c) => c.id === id));
    const seed = remembered.length
      ? remembered
      : [this.activeSessionId, this._splitPane ? this._splitSessionId : null].filter(Boolean);
    const checked = new Set(seed.slice(0, capacity));

    const menu = document.createElement('div');
    menu.id = 'tilePickerMenu';
    menu.className = 'tile-picker-menu';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Show sessions as tiles');
    const list = document.createElement('div');
    list.className = 'tile-picker-list';
    const boxes = [];
    for (const c of candidates) {
      const row = document.createElement('label');
      row.className = 'tile-picker-item';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = c.id;
      box.checked = checked.has(c.id);
      const name = document.createElement('span');
      // A session literally named like a UI string must not be translated.
      name.setAttribute('data-i18n-skip', '');
      name.textContent = c.label;
      row.append(box, name);
      list.appendChild(row);
      boxes.push(box);
    }
    const footer = document.createElement('div');
    footer.className = 'tile-picker-footer';
    const hint = document.createElement('span');
    hint.className = 'tile-picker-hint';
    hint.textContent = `This window fits ${capacity} tile${capacity === 1 ? '' : 's'}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'tile-picker-open';
    open.textContent = 'Open tiles';
    footer.append(hint, open);
    if (candidates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tile-picker-empty';
      empty.textContent = 'No sessions to show as tiles';
      menu.appendChild(empty);
    } else {
      menu.append(list, footer);
    }

    const sync = () => {
      const count = boxes.filter((b) => b.checked).length;
      for (const b of boxes) {
        b.disabled = !b.checked && count >= capacity;
        b.title = b.disabled ? `This window fits ${capacity} tiles` : '';
      }
      open.disabled = count === 0;
    };
    for (const b of boxes) b.addEventListener('change', sync);
    sync();
    open.addEventListener('click', () => {
      const ids = boxes.filter((b) => b.checked).map((b) => b.value);
      this.closeTilePicker();
      if (ids.length === 0) return;
      this.openTileGrid(ids, { focusedId: ids.includes(this.activeSessionId) ? this.activeSessionId : ids[0] });
    });

    document.body.appendChild(menu);
    const btn = document.querySelector('.btn-tile-grid');
    if (btn?.getBoundingClientRect) {
      const rect = btn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.right = `${window.innerWidth - rect.right}px`;
    }
    const onOutside = (e) => {
      if (menu.contains?.(e.target) || e.target?.closest?.('.btn-tile-grid')) return;
      this.closeTilePicker();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') this.closeTilePicker();
    };
    this._tilePicker = { menu, onOutside, onKey };
    // Deferred a tick so the opening click (still bubbling) does not close it.
    setTimeout(() => {
      if (this._tilePicker?.menu === menu) document.addEventListener('click', onOutside);
    }, 0);
    document.addEventListener('keydown', onKey);
    (boxes.find((b) => !b.disabled) || open).focus?.();
  },

  /** Idempotent: the global Escape handler calls it whether or not the picker is open. */
  closeTilePicker() {
    const picker = this._tilePicker;
    if (!picker) return;
    this._tilePicker = null;
    document.removeEventListener('click', picker.onOutside);
    document.removeEventListener('keydown', picker.onKey);
    picker.menu.remove();
  },

  /**
   * A tile's +: the open sessions not yet tiled, in tab order; picking one
   * adds it to the grid and focuses it (a human selection). Disabled once the
   * grid holds what the window can fit.
   */
  openTileAddMenu(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const grid = this._tileGrid;
    if (!grid?.open) return;
    const trigger = event?.currentTarget || null;
    if (this._tileAddMenu && this._tileAddMenu.trigger === trigger) {
      this.closeTileAddMenu();
      return;
    }
    this.closeTileAddMenu();
    const T = window.CodemanTileGrid;
    const capacity = Math.min(this._tileGridCapacityNow(), T.TILE_GRID_MAX);
    const full = grid.ids.length >= Math.max(capacity, 1);
    const candidates = T.buildTilePickerSessions(this.sessions, this.sessionOrder, this.detachedSessions, grid.tiles);
    const menu = document.createElement('div');
    menu.className = 'tab-rail-action-menu tile-add-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Add a session to the grid');
    if (candidates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tile-add-empty';
      empty.textContent = 'Every open session is already tiled';
      menu.appendChild(empty);
    }
    for (const c of candidates) {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('data-i18n-skip', '');
      item.textContent = c.label;
      item.disabled = full;
      if (full) item.title = `The grid already holds what this window fits (${capacity})`;
      item.addEventListener('click', () => {
        this.closeTileAddMenu();
        if (this.addTile(c.id)) this.selectSession(c.id);
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    if (trigger?.getBoundingClientRect) {
      const rect = trigger.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    }
    const onOutside = (e) => {
      if (menu.contains?.(e.target) || (trigger && trigger.contains?.(e.target))) return;
      this.closeTileAddMenu();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') this.closeTileAddMenu();
    };
    this._tileAddMenu = { menu, trigger, onOutside, onKey };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
    menu.querySelector?.('button:not([disabled])')?.focus?.();
  },

  /** Idempotent, like closeTilePicker. */
  closeTileAddMenu() {
    const m = this._tileAddMenu;
    if (!m) return;
    this._tileAddMenu = null;
    document.removeEventListener('pointerdown', m.onOutside, true);
    document.removeEventListener('keydown', m.onKey);
    m.menu.remove();
  },

  // The Split button cannot act while the grid is open (openSplitPicker and
  // openSplitPane refuse), so it says so: aria-disabled plus a title, the same
  // refusal the split already gives for web tabs and the welcome screen.
  _updateSplitButtonForTiles() {
    const btn = document.querySelector('.btn-split');
    if (!btn) return;
    const blocked = this._tilesOwnTerminal();
    btn.classList.toggle('btn-split--blocked', blocked);
    btn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    if (blocked) {
      btn.title = 'Split: unavailable while tiles are open';
      btn.setAttribute('aria-label', btn.title);
    } else {
      this._updateSplitButtonState?.(!!this._splitPane);
    }
  },

  /**
   * The tile chord `e` asks for, if it applies right now, else null. The
   * toggle applies while the grid is open, or where one could open AND the
   * per-device `showTileGridButton` setting is on: with it off (the default)
   * the chord is inert and reaches the terminal like any unbound key. (The
   * applied default pending the owner's answer; one line to change.) The focus,
   * zoom and remove chords apply only while the grid is open, however it was
   * opened. Registry-aware (rebinds and disables in App Settings, Shortcuts).
   * The capture handler (app.js) dispatches it; every xterm key handler returns
   * false for it, so a chord that applies never reaches a PTY.
   *
   * @returns {string|null} the registry id
   */
  tileShortcutFor(e) {
    if (!e || (!e.ctrlKey && !e.metaKey && !e.altKey)) return null;
    if (typeof this.getShortcutRegistry !== 'function' || typeof this.matchesShortcutEvent !== 'function') return null;
    const open = this._tilesOwnTerminal();
    for (const shortcut of this.getShortcutRegistry()) {
      const spec = TILE_SHORTCUTS[shortcut.id];
      if (!spec || shortcut.disabled || !this.matchesShortcutEvent(e, shortcut)) continue;
      if (spec.needsOpen) return open ? shortcut.id : null;
      const enabled = this.loadAppSettingsFromStorage?.()?.showTileGridButton === true;
      return open || (enabled && this.canOpenTileGrid()) ? shortcut.id : null;
    }
    return null;
  },

  /** Runs a chord tileShortcutFor() matched. */
  runTileShortcut(id) {
    const spec = TILE_SHORTCUTS[id];
    if (!spec) return;
    if (id === 'toggle-tile-grid') this.toggleTileGrid();
    else if (id === 'remove-tile') this.removeFocusedTile();
    else if (id === 'zoom-tile') this.zoomTile(this._tileGrid?.focusedId);
    else if (spec.direction) this.focusTileInDirection(spec.direction);
  },

  /**
   * Opens the grid, or closes it to the single view of the focused session.
   * Opening brings back the grid this tab last left (decision 1: one step back
   * after a selection outside it), else an open split as two tiles, else the
   * active session as one tile.
   */
  toggleTileGrid() {
    if (this._tilesOwnTerminal()) {
      this.closeTileGrid({ keepStored: true, reselect: true });
      return;
    }
    if (!this.canOpenTileGrid()) return;
    const remembered = this._readStoredTileGrid();
    if (remembered?.ids.length) {
      this._openStoredTileGrid(remembered);
      return;
    }
    if (this.activeSessionId) this.openTileGrid([this.activeSessionId], { focusedId: this.activeSessionId });
  },

  /** Alt+Shift+Arrows: a human selection of the tile in that direction. */
  focusTileInDirection(direction) {
    const grid = this._tileGrid;
    if (!grid?.open) return;
    const id = window.CodemanTileGrid.tileInDirection(grid.ids, grid.focusedId, direction, grid.cols);
    if (id) this.selectSession(id);
  },

  /** Removes the focused tile (the session keeps running); a neighbour takes focus. */
  removeFocusedTile() {
    const grid = this._tileGrid;
    if (!grid?.open || !grid.focusedId) return;
    this.removeTile(grid.focusedId, { refocus: true, auto: true });
  },

  // The single view after the grid closes: the session the grid was focused on,
  // replayed fresh (forceReload drops the stale snapshot and nulls
  // activeSessionId BEFORE _cleanupPreviousSession, so nothing wrong is saved),
  // or, if that session is gone, the same fallback as closing the active tab.
  _selectAfterTileGrid(sessionId) {
    if (sessionId && this.sessions.has(sessionId)) {
      this.selectSession(sessionId, { forceReload: true, auto: true });
      return;
    }
    this.activeSessionId = null;
    try {
      localStorage.removeItem('codeman-active-session');
    } catch {
      /* Nothing stored. */
    }
    const next = this.sessionOrder.find((id) => this.sessions.has(id));
    if (next) {
      this.selectSession(next, { auto: true });
    } else {
      this.terminal?.clear();
      this.showWelcome();
    }
  },

  /** Adds one session as a tile (open grid only). Returns whether it was added. */
  addTile(sessionId) {
    const grid = this._tileGrid;
    if (!grid?.open || grid.tiles.has(sessionId)) return false;
    if (grid.ids.length >= window.CodemanTileGrid.TILE_GRID_MAX) return false;
    if (!this._mountTile(sessionId)) return false;
    // A tile added while one is zoomed by hand is meant to be seen.
    if (grid.zoomedId && !grid.autoZoom) grid.zoomedId = null;
    this._applyTileLayout();
    this._connectTile(sessionId);
    this._scheduleTileGridRefit();
    this.renderSessionTabs?.();
    return true;
  },

  /**
   * Removes one tile; the session keeps running. When it held focus, `refocus`
   * moves focus to the neighbouring tile (next in grid order, else previous).
   * The last tile leaving closes the grid: with `refocus` the single view then
   * shows that session, without it the caller decides what comes next.
   */
  removeTile(sessionId, { refocus = true, auto = true } = {}) {
    const grid = this._tileGrid;
    const entry = grid?.open ? grid.tiles.get(sessionId) : null;
    if (!entry) return false;
    if (grid.ids.length === 1) {
      this.closeTileGrid({ keepStored: false, reselect: refocus });
      return true;
    }
    const wasFocused = grid.focusedId === sessionId;
    const neighbor = window.CodemanTileGrid.tileNeighbor(grid.ids, sessionId);
    // A divider drag in progress was measured against this tile.
    this._tileDividerDragTeardown?.();
    // The zoomed tile leaving restores the grid (an automatic zoom moves to
    // the neighbour with focus, below).
    if (grid.zoomedId === sessionId) grid.zoomedId = grid.autoZoom && refocus ? neighbor : null;
    grid.queue?.drop(entry.tile);
    entry.tile.destroy();
    entry.el.remove();
    grid.tiles.delete(sessionId);
    grid.ids.splice(grid.ids.indexOf(sessionId), 1);
    // Before the layout, which may zoom the focused tile on a small window.
    if (wasFocused) grid.focusedId = null;
    this._applyTileLayout();
    this._scheduleTileGridRefit();
    this.renderSessionTabs?.();
    if (wasFocused && refocus && neighbor) this._selectTiledSession(neighbor, { auto });
    return true;
  },

  _mountTile(sessionId) {
    const grid = this._tileGrid;
    const session = this.sessions.get(sessionId);
    if (!session || this.detachedSessions?.has(sessionId)) return false;
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.sessionId = sessionId;
    // Header and body are siblings: the chrome is refreshed in place
    // (_renderTileHeader), never by rewriting the tile, which would take the
    // xterm in the body with it.
    const header = this._buildTileHeader(sessionId);
    const body = document.createElement('div');
    body.className = 'tile-body';
    el.append(header.el, body);
    // Pressing a tile is a human selection: it focuses the tile and
    // acknowledges its idle alert (the already-focused tile hits
    // selectSession's early return, which acknowledges too). pointerdown, not
    // click, so focus moves before the press reaches xterm, and never
    // preventDefault: xterm's own mousedown focuses its textarea and starts
    // selections.
    el.addEventListener('pointerdown', () => {
      if (this._tileGrid?.has(sessionId)) this.selectSession(sessionId);
    });
    this._acceptTabDrops(el, (draggedId) => this.dropSessionOnTile(draggedId, sessionId));
    this._tileGridSection().appendChild(el);
    const tile = this._newTerminalTile(sessionId, body);
    grid.tiles.set(sessionId, {
      tile,
      el,
      body,
      overlay: null,
      header: header.el,
      dot: header.dot,
      name: header.name,
      zoomBtn: header.zoomBtn,
      renaming: false,
    });
    grid.ids.push(sessionId);
    this._renderTileHeader(sessionId);
    return true;
  },

  /**
   * Makes `el` a drop target for a session tab dragged from the strip (the
   * strip's own drag sets `draggedTabId`). Capture phase, with the event
   * stopped: the drag carries the session id as text, and xterm's helper
   * textarea would otherwise accept that drop and type the id into a PTY. Any
   * other drag (a file) is left alone.
   */
  _acceptTabDrops(el, onDrop) {
    el.addEventListener(
      'dragover',
      (e) => {
        if (!this.draggedTabId || !this._tileGrid?.open) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        el.classList.add('tile--drop-target');
      },
      true
    );
    el.addEventListener('dragleave', (e) => {
      if (!el.contains?.(e.relatedTarget)) el.classList.remove('tile--drop-target');
    });
    el.addEventListener(
      'drop',
      (e) => {
        el.classList.remove('tile--drop-target');
        if (!this.draggedTabId || !this._tileGrid?.open) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        onDrop(this.draggedTabId);
      },
      true
    );
  },

  /**
   * A tab dropped on a tile: a session not yet tiled REPLACES that tile (same
   * place; the replaced session keeps running); one already tiled swaps places
   * with it. Either way the dropped session takes focus (a human selection).
   */
  dropSessionOnTile(draggedId, targetId) {
    const grid = this._tileGrid;
    if (!grid?.open || draggedId === targetId || !grid.tiles.has(targetId)) return;
    if (!this.sessions.has(draggedId) || this.detachedSessions?.has(draggedId)) return;
    if (grid.tiles.has(draggedId)) {
      const a = grid.ids.indexOf(draggedId);
      const b = grid.ids.indexOf(targetId);
      grid.ids[a] = targetId;
      grid.ids[b] = draggedId;
      this._applyTileLayout();
      this._scheduleTileGridRefit();
    } else {
      this._tileDividerDragTeardown?.();
      const index = grid.ids.indexOf(targetId);
      if (!this._mountTile(draggedId)) return;
      // _mountTile appended it; it takes the replaced tile's place instead.
      grid.ids.pop();
      grid.ids.splice(index, 1, draggedId);
      const old = grid.tiles.get(targetId);
      grid.queue?.drop(old.tile);
      old.tile.destroy();
      old.el.remove();
      grid.tiles.delete(targetId);
      if (grid.zoomedId === targetId) grid.zoomedId = grid.autoZoom ? draggedId : null;
      if (grid.focusedId === targetId) grid.focusedId = null;
      this._applyTileLayout();
      this._connectTile(draggedId);
      this._scheduleTileGridRefit();
      this.renderSessionTabs?.();
    }
    this.selectSession(draggedId);
  },

  /** A tab dropped on an empty slot joins the grid there (an already tiled one moves there). */
  dropSessionOnSlot(draggedId) {
    const grid = this._tileGrid;
    if (!grid?.open || !this.sessions.has(draggedId) || this.detachedSessions?.has(draggedId)) return;
    if (grid.tiles.has(draggedId)) {
      // Empty slots are always the last cells in reading order.
      grid.ids.splice(grid.ids.indexOf(draggedId), 1);
      grid.ids.push(draggedId);
      this._applyTileLayout();
      this._scheduleTileGridRefit();
    } else if (!this.addTile(draggedId)) {
      return;
    }
    this.selectSession(draggedId);
  },

  /**
   * Ctrl/Cmd+click on a tab: that session joins the grid and takes focus (a
   * human selection: the user clicked its tab). With the grid closed it opens
   * on what the Tiles toggle would bring back, plus this session. Returns false
   * when the grid cannot open here (narrow or solo window), so the click is an
   * ordinary one.
   */
  addSessionToTiles(sessionId) {
    if (!this.canOpenTileGrid() || !this.sessions.has(sessionId) || this.detachedSessions?.has(sessionId)) {
      return false;
    }
    const T = window.CodemanTileGrid;
    const capacity = Math.max(1, Math.min(this._tileGridCapacityNow(), T.TILE_GRID_MAX));
    const grid = this._tileGrid;
    if (grid?.open) {
      if (!grid.tiles.has(sessionId)) {
        if (grid.ids.length >= capacity) {
          this.showToast?.(`The grid already holds what this window fits (${capacity})`, 'info');
          return true;
        }
        this.addTile(sessionId);
      }
      this.selectSession(sessionId);
      return true;
    }
    const remembered = this._readStoredTileGrid()?.ids || [];
    const base = remembered.length ? remembered : [this.activeSessionId].filter(Boolean);
    const ids = [...base.filter((id) => id !== sessionId).slice(0, capacity - 1), sessionId];
    this.openTileGrid(ids, { focusedId: sessionId, auto: false });
    return true;
  },

  /**
   * "Open group as tiles" (the tab-group menu of the grouped rail): the
   * group's live sessions, as many as the window fits, become the grid,
   * replacing whatever it showed. Opening the grid is the app's choice of
   * focus, so no idle alert is spent.
   */
  openGroupAsTiles(groupId) {
    const group = (this.tabLayout?.groups || []).find((g) => g.id === groupId);
    if (!group || !this.canOpenTileGrid()) return false;
    const T = window.CodemanTileGrid;
    const capacity = Math.max(1, Math.min(this._tileGridCapacityNow(), T.TILE_GRID_MAX));
    const ids = (group.refs || [])
      .filter((ref) => ref.kind === 'session')
      .map((ref) => ref.id)
      .filter((id) => this.sessions.has(id) && !this.detachedSessions?.has(id))
      .slice(0, capacity);
    if (ids.length === 0) {
      this.showToast?.('This group has no session to show as tiles', 'info');
      return false;
    }
    if (this._tilesOwnTerminal()) {
      this.closeTileGrid({ keepStored: false, reselect: false });
      // As selectSession's tile branch: the parked terminal still holds what it
      // showed before the grid, and re-parking must not snapshot it.
      this.activeSessionId = null;
    }
    const focus = ids.includes(this.activeSessionId) ? this.activeSessionId : ids[0];
    return this.openTileGrid(ids, { focusedId: focus });
  },

  /** A grid tile's TerminalTile: the grid's one load queue, the tile scrollback, font and bounded load. */
  _newTerminalTile(sessionId, body) {
    const session = this.sessions.get(sessionId);
    const tile = new window.TerminalTile(sessionId, body, {
      mode: session?.mode,
      fontSettings: this.loadAppSettingsFromStorage?.() || {},
      detachedSessions: this.detachedSessions,
      scheduleLoad: (t, kind, run) => this._tileLoadQueue().schedule(t, kind, run),
      scrollback: window.CodemanTileGrid.TILE_SCROLLBACK,
      fontSize: this._tileGridFontSize(),
      boundedLoad: true,
      onExit: (code) => this._onTileExit(sessionId, tile, code),
    });
    return tile;
  },

  /**
   * Replaces a tile's TerminalTile with a fresh one in the same place (after
   * Attach: a tile whose socket stopped for good cannot reconnect, and a fresh
   * one loads the new pane from scratch). Keeps the keyboard if it had it.
   */
  _remountTile(sessionId) {
    const entry = this._tileGrid?.open ? this._tileGrid.tiles.get(sessionId) : null;
    if (!entry) return;
    const hadKeyboard = this._focusedTile === entry.tile;
    this._tileGrid.queue?.drop(entry.tile);
    entry.tile.destroy();
    entry.tile = this._newTerminalTile(sessionId, entry.body);
    this._connectTile(sessionId);
    if (hadKeyboard) this._noteFocusedTile(entry.tile);
  },

  /**
   * What the tile's body should say instead of a terminal, or null for none: a
   * session with no PTY attached (pid null) or a socket the server closed
   * because the session exited (4009), both of which Attach can start again;
   * or an agent that exited in a live pane (paneExit), which it cannot: the
   * attach and shell routes refuse while the pane's tmux client still runs
   * ("already has a running process"), and the single view has no restart for
   * it either, so the tile says so and points at Close session instead. Attach
   * was just pressed: nothing, while the server catches up.
   *
   * @returns {{text: string, attachable: boolean}|null}
   */
  _tileAttachReason(sessionId, tile) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const pending = this._tileAttachPending?.get(sessionId);
    if (pending && Date.now() - pending < 15000) return null;
    const exited = typeof paneExitLabel === 'function' ? paneExitLabel(session.paneExit) : '';
    if (exited) return { text: `The agent ${exited}`, attachable: false };
    if (session.pid === null) return { text: 'Not attached', attachable: true };
    if (tile?._stoppedCode === 4009) return { text: 'The session ended', attachable: true };
    return null;
  },

  /**
   * The Attach overlay over a tile's body (absolute, so the body and its xterm
   * keep their size): why there is no terminal, and an Attach button.
   */
  _renderTileOverlay(sessionId) {
    const entry = this._tileGrid?.tiles.get(sessionId);
    if (!entry?.body) return;
    const session = this.sessions.get(sessionId);
    if (session && session.pid !== null && !session.paneExit) this._tileAttachPending?.delete(sessionId);
    const reason = this._tileAttachReason(sessionId, entry.tile);
    const busy = !!this._tileAttachInFlight?.has(sessionId);
    if (!reason && !busy) {
      if (entry.overlay) entry.overlay.hidden = true;
      return;
    }
    if (!entry.overlay) {
      const overlay = document.createElement('div');
      overlay.className = 'tile-attach';
      const text = document.createElement('span');
      text.className = 'tile-attach-text';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tile-attach-btn';
      btn.textContent = 'Attach';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.attachTileSession(sessionId);
      });
      const hint = document.createElement('span');
      hint.className = 'tile-attach-hint';
      hint.textContent = 'It cannot be restarted in place: close it from \u22EF (Close session).';
      overlay.append(text, btn, hint);
      entry.body.appendChild(overlay);
      entry.overlay = overlay;
      entry.overlayText = text;
      entry.overlayBtn = btn;
      entry.overlayHint = hint;
    }
    entry.overlay.hidden = false;
    const text = busy ? 'Attaching\u2026' : reason.text;
    if (entry.overlayText.textContent !== text) entry.overlayText.textContent = text;
    const attachable = busy || reason.attachable;
    entry.overlayBtn.hidden = !attachable;
    entry.overlayHint.hidden = attachable;
    entry.overlayBtn.disabled = busy;
  },

  /**
   * Attach: starts the session's CLI in its pane, exactly as the single view's
   * automatic re-attach does: `POST /interactive` (or `/shell` for a shell)
   * with NO body, at most one in flight per session (the route has no guard of
   * its own). A session whose PTY-exit breaker tripped goes through the same
   * confirm the single view asks before `clearBreaker: true`; nothing automatic
   * ever sends that. On success the tile is remounted onto the new pane.
   */
  async attachTileSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    // An agent that exited in a live pane cannot be started again in place.
    if (this._tileAttachReason(sessionId, this._tileFor(sessionId))?.attachable === false) return false;
    this._tileAttachInFlight ||= new Set();
    if (this._tileAttachInFlight.has(sessionId)) return false;
    let url = `/api/sessions/${sessionId}/${session.mode === 'shell' ? 'shell' : 'interactive'}`;
    let init = { method: 'POST' };
    if (session.respawnBlocked) {
      const label = session.name || 'Session';
      if (!window.confirm(`${label} was stopped after crashing repeatedly. Restart it?`)) return false;
      url = `/api/sessions/${sessionId}/interactive`;
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearBreaker: true }),
      };
    }
    this._tileAttachInFlight.add(sessionId);
    this._renderTileOverlay(sessionId);
    let ok = false;
    try {
      const res = await fetch(url, init);
      // The routes report a refusal in the envelope of a 200.
      const body = await res?.json?.().catch(() => null);
      ok = !!res?.ok && body?.success !== false;
    } catch {
      ok = false;
    } finally {
      this._tileAttachInFlight.delete(sessionId);
    }
    if (ok) {
      if (init.body) session.respawnBlocked = false;
      session.status = 'busy';
      (this._tileAttachPending ||= new Map()).set(sessionId, Date.now());
      this._remountTile(sessionId);
    } else {
      this.showToast?.('Could not attach the session', 'error');
    }
    this._renderTileOverlay(sessionId);
    return ok;
  },

  /**
   * `● name ......... ⋯ ×`: the status dot (the six-state classifier the tab
   * rows and both home screens share), the session name (double-click
   * renames), the session menu (the tab rail's own) and remove-tile. Its
   * buttons stop pointerdown, so acting on a tile that is not focused does not
   * also focus it (and spend its idle alert).
   */
  _buildTileHeader(sessionId) {
    const el = document.createElement('div');
    el.className = 'tile-header';
    const dot = document.createElement('span');
    dot.className = 'tile-dot home-sessions-dot home-sessions-dot--idle';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'tile-name';
    // A session literally named like a UI string ("Sessions") must not be translated.
    name.setAttribute('data-i18n-skip', '');
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startTileRename(sessionId);
    });
    const actions = document.createElement('span');
    actions.className = 'tile-actions';
    const button = (cls, label, glyph, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tile-btn ${cls}`;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.textContent = glyph;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(e);
      });
      return b;
    };
    const zoomBtn = button('tile-zoom', 'Zoom this tile', '\u2922', () => this.zoomTile(sessionId));
    zoomBtn.setAttribute('aria-pressed', 'false');
    actions.append(
      button('tile-menu', 'Session actions', '\u22EF', (e) => this.openTabRailActionMenu?.(e, sessionId)),
      zoomBtn,
      button('tile-add', 'Add a session to the grid', '+', (e) => this.openTileAddMenu(e)),
      // Removes the tile ONLY: the session keeps running. Killing it stays
      // behind the menu's Close session and its confirm.
      button('tile-remove', 'Remove tile (the session keeps running)', '\u00D7', () =>
        this.removeTile(sessionId, { refocus: true, auto: true })
      )
    );
    el.append(dot, name, actions);
    return { el, dot, name, zoomBtn };
  },

  /**
   * Refreshes one tile's header from the session: dot state, name, the hover
   * label ("working 3m") and the `needs` border. Diffs on existing nodes only,
   * and cheap: it runs on every tab render (every status change).
   */
  _renderTileHeader(sessionId) {
    const entry = this._tileGrid?.tiles.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!entry?.header || !session) return;
    const row = this._sidebarRichRow?.(sessionId, session) || null;
    const state = row?.state || 'idle';
    const dotClass = `tile-dot home-sessions-dot home-sessions-dot--${row?.exited ? 'done' : state}`;
    if (entry.dot.className !== dotClass) entry.dot.className = dotClass;
    const since = row?.since?.at ? this._mobileOverviewStampText?.(row.since.at, 'for') : '';
    const label = row ? [row.pill, since].filter(Boolean).join(' ') : '';
    if (entry.header.title !== label) entry.header.title = label;
    // The input of a rename in progress has taken the name's place in the
    // header, so updating the detached name never touches what is being typed.
    // A rename still in flight shows as already done, as on the tab.
    const name =
      this._inlineRenamePending?.get(sessionId) || this.getSessionName?.(session) || session.name || 'Session';
    if (entry.name.textContent !== name) entry.name.textContent = name;
    // A permission prompt is visible across the room.
    entry.el.classList.toggle('tile--needs', state === 'needs');
    this._renderTileOverlay(sessionId);
  },

  /** Every tile's header (after a tab render, i.e. any session change). */
  _renderTileChrome() {
    const grid = this._tileGrid;
    if (!grid?.open) return;
    for (const id of grid.tiles.keys()) this._renderTileHeader(id);
  },

  /**
   * Double-click on a tile's name: an input in its place, Enter or leaving it
   * renames through the tab rename's own write queue, Escape cancels. The
   * header refresh leaves the name alone meanwhile.
   */
  startTileRename(sessionId) {
    const entry = this._tileGrid?.tiles.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!entry || !session || entry.renaming) return;
    entry.renaming = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tile-rename-input';
    input.setAttribute('aria-label', 'Session name');
    // A rename still in flight is the user's last word.
    input.value = this._inlineRenamePending?.get(sessionId) ?? session.name ?? '';
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      input.replaceWith(entry.name);
      entry.renaming = false;
      const value = input.value.trim();
      if (commit && value && value !== session.name && this.sessions.has(sessionId)) {
        entry.name.textContent = value;
        void this._queueInlineSessionName?.(sessionId, value);
      }
      this._renderTileHeader(sessionId);
    };
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      // Enter and Escape during an IME composition belong to the IME.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    entry.name.replaceWith(input);
    input.focus();
    input.select?.();
  },

  _connectTile(sessionId) {
    this._tileGrid?.tiles
      .get(sessionId)
      ?.tile.connect()
      .catch(() => {
        /* Best-effort, as the split's Pane B: live output arrives once the socket opens. */
      });
  },

  /**
   * A tile's socket stopped for good. 4009 (the session exited) keeps the tile
   * with its "session ended" marker; 4003 (refused), 4004 (session gone) and
   * 4010 (another socket took over) remove it.
   */
  _onTileExit(sessionId, tile, code) {
    if (this._tileGrid?.tiles.get(sessionId)?.tile !== tile) return;
    // The session exited: the tile stays, with the Attach overlay over it.
    if (code === 4009) {
      this._renderTileOverlay(sessionId);
      return;
    }
    this.removeTile(sessionId, { refocus: true, auto: true });
  },

  /** Columns x rows for the current tile count, applied to the grid section. */
  _applyTileLayout() {
    const grid = this._tileGrid;
    const section = this._tileGridSection();
    const rect = section.getBoundingClientRect?.() || { width: 0, height: 0 };
    const { cols, rows, fits } = window.CodemanTileGrid.computeTileLayout({
      count: grid.ids.length,
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
    });
    if (grid.colFr.length !== cols) grid.colFr = new Array(cols).fill(1);
    if (grid.rowFr.length !== rows) grid.rowFr = new Array(rows).fill(1);
    grid.cols = cols;
    grid.rows = rows;
    // A window too small for the tiles' minimum size shows the focused tile
    // alone, with a hint; once it fits again the grid comes back. A zoom the
    // user chose is theirs: it stays until they lift it.
    if (!fits && !grid.zoomedId && grid.focusedId) {
      grid.zoomedId = grid.focusedId;
      grid.autoZoom = true;
      this.showToast?.(`The window is too small for ${grid.ids.length} tiles: showing the focused one`, 'info');
    } else if (fits && grid.autoZoom) {
      grid.zoomedId = null;
      grid.autoZoom = false;
    }
    const zoomed = grid.zoomedId && grid.tiles.has(grid.zoomedId) ? grid.zoomedId : null;
    section.classList.toggle('tile-grid--zoomed', !!zoomed);
    for (const [id, entry] of grid.tiles) {
      entry.el.classList.toggle('tile--zoomed', id === zoomed);
      const zoomBtn = entry.zoomBtn;
      if (zoomBtn) {
        const on = id === zoomed;
        const label = on ? 'Restore the grid' : 'Zoom this tile';
        zoomBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (zoomBtn.title !== label) {
          zoomBtn.title = label;
          zoomBtn.setAttribute('aria-label', label);
        }
      }
    }
    // Zoomed: one cell; the other tiles stay connected but hidden (CSS), so
    // they measure nothing and send no resize. Otherwise every tile is placed
    // explicitly in reading order, with a divider track between columns and
    // between rows.
    section.style.gridTemplateColumns = zoomed ? 'minmax(0, 1fr)' : tileGridTracks(grid.colFr);
    section.style.gridTemplateRows = zoomed ? 'minmax(0, 1fr)' : tileGridTracks(grid.rowFr);
    grid.ids.forEach((id, k) => {
      const el = grid.tiles.get(id)?.el;
      if (!el) return;
      el.style.gridColumn = id === zoomed ? '1' : String(2 * (k % cols) + 1);
      el.style.gridRow = id === zoomed ? '1' : String(2 * Math.floor(k / cols) + 1);
    });
    this._syncTileDividers(zoomed ? 0 : cols, zoomed ? 0 : rows);
    this._syncTileSlots(zoomed ? 0 : cols * rows - grid.ids.length, cols);
    this._persistTileGrid();
  },

  // The empty cells of a layout that is not full (3 tiles in a 2x2, 5 in a
  // 3x2): drop targets for a tab, after the tiles in reading order.
  _syncTileSlots(count, cols) {
    const grid = this._tileGrid;
    grid.slots ||= [];
    while (grid.slots.length > count) grid.slots.pop().remove();
    while (grid.slots.length < count) {
      const slot = document.createElement('div');
      slot.className = 'tile-slot';
      slot.textContent = 'Drop a tab here';
      this._acceptTabDrops(slot, (draggedId) => this.dropSessionOnSlot(draggedId));
      this._tileGridSection().appendChild(slot);
      grid.slots.push(slot);
    }
    grid.slots.forEach((slot, i) => {
      const k = grid.ids.length + i;
      slot.style.gridColumn = String(2 * (k % cols) + 1);
      slot.style.gridRow = String(2 * Math.floor(k / cols) + 1);
    });
  },

  // One divider per gap between columns and between rows, created and dropped
  // as the counts change (never rebuilt while they stay, so a drag in progress
  // keeps its element).
  _syncTileDividers(cols, rows) {
    const grid = this._tileGrid;
    const section = this._tileGridSection();
    const wanted = new Set();
    for (let i = 0; i < cols - 1; i++) wanted.add(`col-${i}`);
    for (let i = 0; i < rows - 1; i++) wanted.add(`row-${i}`);
    for (const [key, el] of grid.dividers) {
      if (wanted.has(key)) continue;
      if (this._tileDividerDrag?.key === key) this._tileDividerDragTeardown?.();
      el.remove();
      grid.dividers.delete(key);
    }
    for (const key of wanted) {
      let el = grid.dividers.get(key);
      const [axis, n] = key.split('-');
      const index = Number(n);
      if (!el) {
        el = document.createElement('div');
        el.className = `tile-divider tile-divider--${axis}`;
        el.setAttribute('role', 'separator');
        el.setAttribute('aria-orientation', axis === 'col' ? 'vertical' : 'horizontal');
        el.setAttribute('aria-label', axis === 'col' ? 'Resize tile columns' : 'Resize tile rows');
        el.addEventListener('pointerdown', (e) => this._startTileDividerDrag(e, axis, index, el, key));
        section.appendChild(el);
        grid.dividers.set(key, el);
      }
      el.style.gridColumn = axis === 'col' ? String(2 * index + 2) : '1 / -1';
      el.style.gridRow = axis === 'col' ? '1 / -1' : String(2 * index + 2);
    }
  },

  /**
   * Drags a column or row divider: the two tracks either side trade size, each
   * kept at the minimum tile size (dragTrackFractions, constants.js). The
   * affected tiles reflow locally once per animation frame; their PTYs hear
   * ONE resize each, at pointer-up, never per move (each one is a tmux resize
   * and a SIGWINCH). Pointer capture keeps the drag on the divider whatever is
   * under the pointer; closing the grid or removing a tile mid-drag tears it
   * down through _tileDividerDragTeardown.
   */
  _startTileDividerDrag(e, axis, index, divider, key) {
    if (e.button !== undefined && e.button !== 0) return;
    const grid = this._tileGrid;
    if (!grid?.open) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    this._tileDividerDragTeardown?.();
    const T = window.CodemanTileGrid;
    const section = this._tileGridSection();
    const rect = section.getBoundingClientRect();
    const isCol = axis === 'col';
    const count = isCol ? grid.cols : grid.rows;
    const total = (isCol ? rect.width : rect.height) - 2 * TILE_GRID_PADDING_PX - TILE_DIVIDER_PX * (count - 1);
    const startFr = (isCol ? grid.colFr : grid.rowFr).slice();
    const start = isCol ? e.clientX : e.clientY;
    const minPx = isCol ? T.TILE_MIN_W : T.TILE_MIN_H;
    const affected = [];
    grid.ids.forEach((id, k) => {
      const track = isCol ? k % grid.cols : Math.floor(k / grid.cols);
      if (track === index || track === index + 1) affected.push(grid.tiles.get(id).tile);
    });
    let raf = null;
    let pending = start;
    let capturedPointerId = null;
    const apply = (pos) => {
      if (!grid.open) return;
      const fr = T.dragTrackFractions(startFr, index, pos - start, total, minPx);
      if (isCol) grid.colFr = fr;
      else grid.rowFr = fr;
      section.style[isCol ? 'gridTemplateColumns' : 'gridTemplateRows'] = tileGridTracks(fr);
      for (const tile of affected) tile.localFit();
    };
    const onMove = (ev) => {
      pending = isCol ? ev.clientX : ev.clientY;
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        apply(pending);
      });
    };
    const endDrag = () => {
      divider.classList.remove('dragging');
      document.body.classList.remove('tile-grid-resizing', `tile-grid-resizing--${axis}`);
      if (capturedPointerId !== null) {
        try {
          divider.releasePointerCapture?.(capturedPointerId);
        } catch {
          /* Already released. */
        }
        capturedPointerId = null;
      }
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
      divider.removeEventListener('pointercancel', onUp);
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      if (this._tileDividerDragTeardown === endDrag) {
        this._tileDividerDragTeardown = null;
        this._tileDividerDrag = null;
      }
    };
    const onUp = () => {
      // The last queued frame carries the final pointer position.
      const queued = raf !== null;
      endDrag();
      if (queued) apply(pending);
      for (const tile of affected) {
        if (!tile._destroyed) tile.fit();
      }
      this._persistTileGrid();
    };
    divider.classList.add('dragging');
    document.body.classList.add('tile-grid-resizing', `tile-grid-resizing--${axis}`);
    try {
      divider.setPointerCapture?.(e.pointerId);
      capturedPointerId = e.pointerId ?? null;
    } catch {
      /* The drag still works through the listeners below. */
    }
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp);
    divider.addEventListener('pointercancel', onUp);
    this._tileDividerDragTeardown = endDrag;
    this._tileDividerDrag = { key };
  },

  /**
   * Zooms a tile to fill the grid, like tmux zoom, or restores the grid when it
   * is the one zoomed. A tile that is not focused is focused first (a human
   * selection: the user asked to look at it). Every tile is refitted after, the
   * shown ones to their new size and the zoomed one to the whole grid.
   */
  zoomTile(sessionId) {
    const grid = this._tileGrid;
    if (!grid?.open || !grid.tiles.has(sessionId)) return;
    if (grid.zoomedId === sessionId) {
      grid.zoomedId = null;
      grid.autoZoom = false;
    } else {
      if (grid.focusedId !== sessionId) this.selectSession(sessionId);
      grid.zoomedId = sessionId;
      grid.autoZoom = false;
    }
    this._applyTileLayout();
    this._scheduleTileGridRefit();
  },

  // Refits every tile once the grid area has settled: one xterm resize and one
  // PTY resize together per tile (#464), on the trailing edge.
  _scheduleTileGridRefit() {
    const grid = this._tileGrid;
    if (!grid?.open) return;
    clearTimeout(grid.refitTimer);
    grid.refitTimer = setTimeout(() => {
      grid.refitTimer = null;
      if (!grid.open) return;
      // The 3-tile layout depends on the width (3x1 or 2x2).
      this._applyTileLayout();
      for (const { tile } of grid.tiles.values()) tile.fit();
    }, TILE_GRID_REFIT_MS);
  },

  // Narrowing the window past the desktop gate returns to the single view of the
  // focused session; the grid is remembered.
  _installTileGridWidthGate() {
    if (this._tileGridWidthGateInstalled || !window.matchMedia) return;
    this._tileGridWidthGateInstalled = true;
    const mq = window.matchMedia(`(min-width: ${SPLIT_PANE_MIN_WIDTH}px)`);
    mq.addEventListener('change', (e) => {
      if (!e.matches && this._tileGrid?.open) this.closeTileGrid({ keepStored: true, reselect: true });
    });
  },

  _paintTileFocus() {
    const grid = this._tileGrid;
    for (const [id, { el }] of grid?.tiles || []) el.classList.toggle('focused', id === grid.focusedId);
  },

  /**
   * Focuses a tiled session: the tile branch of selectSession. Moving focus is
   * an `activeSessionId` change plus `xterm.focus()`: no fetch, no replay. It
   * runs the panel refresh a normal switch runs and skips everything bound to
   * the main terminal (cleanup, replay, resize, its socket, local echo). Only a
   * USER-initiated selection (`auto` not true) acknowledges the idle alert.
   *
   * @param {string} sessionId
   * @param {{auto?: boolean, focus?: boolean}} [options] - `focus: false` leaves
   *   DOM focus where it is (an app-driven reconcile must not steal it)
   */
  _selectTiledSession(sessionId, options = {}) {
    const grid = this._tileGrid;
    const entry = grid?.open ? grid.tiles.get(sessionId) : null;
    if (!entry) return;
    const userInitiated = options.auto !== true;
    // Aborts any in-flight normal select at its next _isStaleSelect check.
    const selectGen = ++this._selectGeneration;
    this._hideWebviewLayer?.();
    this.activeSessionId = sessionId;
    grid.focusedId = sessionId;
    // Moving focus off a zoomed tile restores the grid, as selecting another
    // pane does in tmux. An automatic zoom (the window cannot fit the tiles)
    // follows focus instead: there is no grid to restore.
    if (grid.zoomedId && grid.zoomedId !== sessionId) {
      grid.zoomedId = grid.autoZoom ? sessionId : null;
      this._applyTileLayout();
      this._scheduleTileGridRefit();
    }
    this._activateFileBrowserSession?.(sessionId);
    try {
      localStorage.setItem('codeman-active-session', sessionId);
    } catch {
      /* Per-device convenience only. */
    }
    // The SSE subscription follows the focused session as in the single view;
    // its terminal frames are dropped by the parking guards.
    this._updateSseSubscription?.(sessionId);
    this.hideWelcome();
    if (userInitiated) this.markIdleAlertSeen(sessionId);
    this._paintTileFocus();
    this._updateActiveTabImmediate?.(sessionId);
    this.closeSessionSidebarOnHandheld?.();
    this.renderSessionTabs?.();
    const activeTab = document.querySelector(`.session-tab.active[data-id="${sessionId}"]`);
    if (activeTab) {
      activeTab.classList.add('tab-glow');
      activeTab.addEventListener('animationend', () => activeTab.classList.remove('tab-glow'), { once: true });
    }
    this.updateAttachmentHistoryBadge?.();
    if (this.attachmentHistoryDrawerOpen) this.loadAttachmentHistory?.(sessionId);
    if (typeof KeyboardAccessoryBar !== 'undefined') KeyboardAccessoryBar.refreshForActiveSession();
    this.refreshHostWakeBanner?.(sessionId);
    this.currentSessionWorkingDir = this.sessions.get(sessionId)?.workingDir || null;
    const idleCb = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb) => setTimeout(cb, 16);
    idleCb(() => this._refreshSessionPanels(sessionId, selectGen));
    // The keyboard follows focus: shortcuts, voice and paste act on this tile.
    this._noteFocusedTile(entry.tile);
    if (options.focus !== false) entry.tile.terminal?.focus();
    this._persistTileGrid();
  },

  // ── Persistence (codeman:tile-grid, per device, ids only) ────────────────

  /**
   * Writes the open grid: ids, focus, a zoom the user chose (an automatic one
   * is worked out again from the window) and the divider fractions. Never
   * content. `open: false` is the closed-but-remembered state. Never in a solo
   * window; a storage failure only costs the convenience.
   */
  _persistTileGrid({ open = true } = {}) {
    const grid = this._tileGrid;
    if (this.isSoloWindow || !grid || grid.ids.length === 0) return;
    if (open && !grid.open) return;
    const state = {
      v: 1,
      open,
      ids: grid.ids.slice(),
      focused: grid.focusedId,
      zoomed: grid.autoZoom ? null : grid.zoomedId,
      colFr: grid.colFr.slice(),
      rowFr: grid.rowFr.slice(),
    };
    try {
      localStorage.setItem(TILE_GRID_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* Per-device convenience only. */
    }
  },

  _forgetStoredTileGrid() {
    try {
      localStorage.removeItem(TILE_GRID_STORAGE_KEY);
    } catch {
      /* Nothing stored. */
    }
  },

  /** The stored grid, sanitized against the sessions this page knows now, or null. */
  _readStoredTileGrid() {
    if (this.isSoloWindow) return null;
    let raw = null;
    try {
      raw = localStorage.getItem(TILE_GRID_STORAGE_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    return window.CodemanTileGrid.sanitizeTileGridState(raw, this.sessions, this.detachedSessions);
  },

  /**
   * Opens a stored grid: its tiles and focus, then the fractions it had (only
   * if they still match the layout) and a zoom the user chose. `auto`: the app
   * is putting it back, so no idle alert is spent.
   */
  _openStoredTileGrid(stored) {
    const focus = stored.zoomed || stored.focused;
    if (!this.openTileGrid(stored.ids, { focusedId: focus, auto: true })) return false;
    const grid = this._tileGrid;
    // openTileGrid laid the grid out with equal tracks. The stored ones go back
    // on; _applyTileLayout drops them again if they do not match the column or
    // row count (the window may have changed the layout since).
    if (stored.colFr) grid.colFr = stored.colFr.slice();
    if (stored.rowFr) grid.rowFr = stored.rowFr.slice();
    if (stored.zoomed && grid.tiles.has(stored.zoomed)) {
      grid.zoomedId = stored.zoomed;
      grid.autoZoom = false;
    }
    this._applyTileLayout();
    this._scheduleTileGridRefit();
    return true;
  },

  /**
   * Page load (handleInit, in place of selecting the session to restore): a
   * grid stored OPEN on this device comes back, ids sanitized against the
   * session list (deleted, detached and duplicate ids dropped). The main
   * terminal then never loads on this page load, so no `full=1` capture is
   * paid for a terminal about to be parked. Not in a solo window (nothing is
   * read there), nor on a window too narrow for the grid (openTileGrid
   * refuses; the stored grid waits for a wide one).
   *
   * @returns {boolean} whether the grid was restored
   */
  _restoreTileGrid() {
    if (this._tilesOwnTerminal()) return false;
    const stored = this._readStoredTileGrid();
    if (!stored?.open || stored.ids.length === 0) return false;
    return this._openStoredTileGrid(stored);
  },

  /** A followed `#session=` link took the screen on load: the stored grid stays remembered, closed. */
  _closeStoredTileGrid() {
    const stored = this._readStoredTileGrid();
    if (!stored?.open) return;
    try {
      localStorage.setItem(TILE_GRID_STORAGE_KEY, JSON.stringify({ ...stored, open: false }));
    } catch {
      /* Per-device convenience only. */
    }
  },

  /** Header connection state while tiles own the terminal: every live tile socket open, or not. */
  _tileGridSocketState() {
    for (const { tile } of this._tileGrid?.tiles.values() || []) {
      // A tile stopped for good (its session exited) has nothing to reconnect.
      if (tile._stoppedCode !== null && tile._stoppedCode !== undefined) continue;
      if (!tile._wsReady) return 'reconnecting';
    }
    return 'connected';
  },

  /**
   * handleInit (page state reloaded, or SSE back after a server restart) with
   * the grid open: tiles whose sessions are gone or popped out are removed, the
   * rest are KEPT (never rebuilt) and told to reconnect now instead of waiting
   * out their backoff, and focus stays on a live tile.
   *
   * @returns {boolean} whether the grid is still open (handleInit then skips
   *   restoring the main terminal)
   */
  _reconcileTileGrid() {
    const grid = this._tileGrid;
    if (!grid?.open) return false;
    for (const id of grid.ids.slice()) {
      if (!this.sessions.has(id) || this.detachedSessions?.has(id)) this.removeTile(id, { refocus: false });
    }
    if (!grid.open) return false;
    // Only a focus that is gone moves: re-selecting the same tile would hide an
    // active web tab on every SSE blip (_selectTiledSession hides the web layer),
    // which the single view's reconnect never does.
    if (!grid.has(grid.focusedId)) this._selectTiledSession(grid.ids[0], { auto: true });
    for (const { tile } of grid.tiles.values()) tile.reconnectNow();
    return true;
  },
});

// A tiled session deleted (here or elsewhere) loses its tile; if it held focus,
// the neighbouring tile takes it (`auto`: the app chose, so no idle alert is
// spent). Done BEFORE the original handler, so activeSessionId no longer names
// the deleted id and its welcome-screen handoff stays out of it. The last tile
// closes the grid without a reselect, and the original handler then shows the
// welcome screen as in the single view. A close started from this tab
// (closeSession, in _closingSessions) owns its own follow-up: only the tile goes.
const _tileGridOriginalOnSessionDeleted = CodemanApp.prototype._onSessionDeleted;
CodemanApp.prototype._onSessionDeleted = function (data) {
  const grid = this._tileGrid;
  if (grid?.has(data.id)) {
    const wasFocused = grid.focusedId === data.id;
    const neighbor = window.CodemanTileGrid.tileNeighbor(grid.ids, data.id);
    this.removeTile(data.id, { refocus: false });
    if (wasFocused && grid.open && neighbor && !this._closingSessions?.has(data.id)) {
      this._selectTiledSession(neighbor, { auto: true });
    }
  }
  return _tileGridOriginalOnSessionDeleted.call(this, data);
};

// Every tab render (any session change: status, hooks, name) refreshes the
// tile headers too, so a tile's dot, name and needs border follow the same
// state the tab shows.
const _tileGridOriginalRenderSessionTabsImmediate = CodemanApp.prototype._renderSessionTabsImmediate;
CodemanApp.prototype._renderSessionTabsImmediate = function (...args) {
  const result = _tileGridOriginalRenderSessionTabsImmediate.apply(this, args);
  this._renderTileChrome?.();
  return result;
};
