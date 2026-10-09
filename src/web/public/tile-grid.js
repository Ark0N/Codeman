// src/web/public/tile-grid.js

/**
 * @fileoverview The tile grid: 1 to TILE_GRID_MAX (6) live sessions side by
 * side in one window, each in its own TerminalTile (terminal-tile.js), laid
 * out by count (window.CodemanTileGrid, constants.js). Desktop only; see
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
// `{ v: 1, open, ids, focused, zoomed, colFr, rowFr }`, `ids` being the cells
// in reading order with `null` for an empty one. `open: false` keeps it
// remembered for one-click return; restored on reload inside handleInit.
const TILE_GRID_STORAGE_KEY = 'codeman:tile-grid';
// How many tiles a click on Tiles opens: the count last picked in its
// right-click menu (2, 4 or 6; owner decision 10), per device. Its own key, so
// the stored grid above stays ids only.
const TILE_GRID_COUNT_KEY = 'codeman:tile-count';
// The leaving tiles' fade (styles.css .tile--leaving) plus slack: the still
// copy of a closing grid goes even if animationend never comes (a hidden tab,
// a cancelled animation).
const TILE_GHOST_FALLBACK_MS = 450;
// The longest a closing grid's still copy waits for the single view's replay
// before it fades anyway, so a slow load never leaves a stale picture up.
const TILE_GHOST_HOLD_MAX_MS = 700;
// A tile's terminal shows once its first capture has landed (the load queue
// says so); this is the backstop should that never be reported.
const TILE_REVEAL_FALLBACK_MS = 15000;
// How long the pointer (or a keyboard focus) rests on the Tiles button before
// its hover card shows (owner feedback 1).
const TILE_HINT_DELAY_MS = 300;
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
// needs the grid open. The toggle applies wherever a grid could open. The arrow
// chords (`direction`, `move`) leave a text field its keys (tileShortcutFor).
const TILE_SHORTCUTS = {
  'toggle-tile-grid': { needsOpen: false },
  'focus-tile-left': { needsOpen: true, direction: 'left' },
  'focus-tile-right': { needsOpen: true, direction: 'right' },
  'focus-tile-up': { needsOpen: true, direction: 'up' },
  'focus-tile-down': { needsOpen: true, direction: 'down' },
  'move-tile-left': { needsOpen: true, move: 'left' },
  'move-tile-right': { needsOpen: true, move: 'right' },
  'move-tile-up': { needsOpen: true, move: 'up' },
  'move-tile-down': { needsOpen: true, move: 'down' },
  'remove-tile': { needsOpen: true },
  'zoom-tile': { needsOpen: true },
};

/**
 * A text field other than a terminal's own input (xterm's helper textarea):
 * the rename input, the file editor, a settings field. Shifted arrows select
 * there (Ctrl+Shift by word; Option+Shift by word on macOS), so the arrow
 * chords, focus and move, leave it alone (owner: best practice).
 */
function isTextFieldTarget(target) {
  if (!target || target.classList?.contains?.('xterm-helper-textarea')) return false;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

/**
 * The count menu's picture of `n` tiles: the grid's own layout for that count
 * (2x1, 2x2, 3x2) as small rounded cells.
 */
function tileCountGlyph(n) {
  const { cols, rows } = window.CodemanTileGrid.computeTileLayout({ count: n });
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'tile-count-glyph');
  svg.setAttribute('viewBox', '0 0 30 20');
  svg.setAttribute('aria-hidden', 'true');
  const gap = 3;
  const w = (30 - gap * (cols - 1)) / cols;
  const h = (20 - gap * (rows - 1)) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(c * (w + gap)));
      rect.setAttribute('y', String(r * (h + gap)));
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', String(h));
      rect.setAttribute('rx', '1.5');
      svg.appendChild(rect);
    }
  }
  return svg;
}

/**
 * The hover card's mouse: a rounded body with its left or right button filled.
 */
function tileHintMouseGlyph(button) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `tile-hint-glyph tile-hint-glyph--${button}`);
  svg.setAttribute('viewBox', '0 0 10 14');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS(NS, 'rect');
  for (const [k, v] of Object.entries({ x: '0.75', y: '0.75', width: '8.5', height: '12.5', rx: '4.25' })) {
    body.setAttribute(k, v);
  }
  const press = document.createElementNS(NS, 'path');
  press.setAttribute('class', 'tile-hint-press');
  press.setAttribute(
    'd',
    button === 'left'
      ? 'M4.6 1.3 V6 H1.3 V5.2 A3.6 3.6 0 0 1 4.6 1.3 Z'
      : 'M5.4 1.3 V6 H8.7 V5.2 A3.6 3.6 0 0 0 5.4 1.3 Z'
  );
  svg.append(body, press);
  return svg;
}

/** The grid's state. `has(id)` answers only while it is open. */
class TileGridModel {
  constructor() {
    this.open = false;
    // The grid's cells in reading order (row-major), cols x rows of them: a
    // session id, or null for an empty cell. THE source of truth for where
    // each tile is (owner: an empty cell can be any cell); `ids` derives from it.
    this.cells = [];
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

  /** The tiled sessions in reading order, holes skipped (a fresh array: change `cells`, never this). */
  get ids() {
    return this.cells.filter(Boolean);
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
          if (entry?.tile !== tile) return;
          entry.el.classList.toggle('tile--loading', state !== 'idle');
          // The first capture has landed (or failed): the terminal fades in,
          // whole, instead of showing its replay scroll by.
          if (state === 'idle') entry.el.classList.remove('tile--revealing');
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
    // Once per section (index.html ships it, so not only on create).
    if (this._tileFileDropSection !== section) {
      this._tileFileDropSection = section;
      this._installTileFileDrop(section);
    }
    return section;
  },

  /**
   * A file dragged over the grid. The single view's file drop (image-input.js)
   * listens on #terminalContainer, hidden while tiles are open, so nothing
   * cancelled a file drag here and the browser opened the file in place of
   * Codeman. Anywhere over the grid (a tile, an empty cell, a divider, the
   * padding) the drag is cancelled, so the page never navigates; dropped on a
   * tile, its images upload to THAT tile's session and their paths are typed
   * there, as the single view does for the active one. Bubble phase, files
   * only: a tab or tile drag carries none, and its target stops it in the
   * capture phase anyway (_acceptTabDrops).
   */
  _installTileFileDrop(section) {
    const isFileDrag = (e) => {
      const types = e.dataTransfer?.types;
      return !!types && Array.from(types).includes('Files');
    };
    // The open grid's tile under `target`, or null (an empty cell, a divider, the padding).
    const tileAt = (target) => {
      const grid = this._tileGrid;
      if (!grid?.open || !target) return null;
      for (const [id, entry] of grid.tiles) if (entry.el.contains?.(target)) return id;
      return null;
    };
    section.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer && tileAt(e.target)) e.dataTransfer.dropEffect = 'copy';
    });
    section.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const sessionId = tileAt(e.target);
      const files = Array.from(e.dataTransfer?.files || []);
      if (!sessionId || files.length === 0) return;
      const images = files.filter((f) => String(f?.type || '').startsWith('image/'));
      if (images.length === 0) {
        this.showToast?.('Only image files are supported', 'error');
        return;
      }
      this._uploadAndInsertImages?.(images, { sessionId });
    });
  },

  /**
   * Opens the grid on `ids` (unknown, detached and duplicate ids are skipped;
   * at most TILE_GRID_MAX), focusing `focusedId` or the first. Already open, it
   * adds what is missing and moves focus. `auto: false` makes the focus a human
   * selection (it acknowledges that session's idle alert). An open split
   * closes (the two are never open together); `mergeSplit` (default) makes its
   * two sessions the first tiles, false opens exactly `ids` (a stored grid, a
   * group, a Ctrl/Cmd+click: callers that size their own set).
   *
   * Parks the main terminal first: `_cleanupPreviousSession()` runs ONCE, while
   * its snapshot of the session it shows is still right, and closes its socket.
   *
   * @returns {boolean} whether the grid is open afterwards
   */
  openTileGrid(ids, { focusedId = null, auto = true, mergeSplit = true } = {}) {
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
      if (mergeSplit) {
        requested = [...seed, ...requested];
        if (!requested.includes(focusedId)) focusedId = seed[0] ?? null;
      }
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

    // No snapshot of a session that becomes a tile: closing the grid drops the
    // main terminal's snapshot of every tiled id (stale by then), so taking one
    // here (a 1000-line serialize and up to 256 KB of localStorage for a
    // non-shell session) only ever produced a copy that was thrown away.
    this._cleanupPreviousSession(focus, { skipSnapshot: wanted.includes(this.activeSessionId) });
    // A grid closed a moment ago may still be fading out over the stage.
    this._purgeTileGhosts();
    grid.open = true;
    grid.cells = [];
    grid.cols = 0;
    grid.rows = 0;
    grid.focusedId = focus;
    document.querySelector('.main')?.classList.add('tiles-active');
    const section = this._tileGridSection();
    this.hideWelcome();
    // Mount every tile and lay the grid out BEFORE any tile connects, so each
    // first fit measures its real cell. Each tile enters in
    // reading order (opacity and transform only: the fit measures the final
    // cell, so the animation adds no resize).
    wanted.forEach((id, k) => this._mountTile(id, { enterIndex: k }));
    // Packed from the first cell (_applyTileLayout pads the shape with empty cells).
    grid.cells = wanted.filter((id) => grid.tiles.has(id));
    this._applyTileLayout();
    // The tiles' frames paint first; their terminals are built one per frame
    // after it, the focused tile's first, so its capture is the one the queue
    // starts with (_connectTilesPaced).
    this._connectTilesPaced([focus, ...wanted.filter((id) => id !== focus)]);
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
   * reload; pass false when the caller selects something itself. `animate`
   * (the Tiles toggle only, owner answer 4) leaves a still copy of the tiles
   * over the stage until the single view has its content (_ghostTileGrid).
   *
   * The main terminal's cached content for EVERY tiled id is invalidated: it was
   * written before the grid opened, possibly hours ago, and selectSession paints
   * a snapshot as its first frame.
   */
  closeTileGrid({ keepStored = true, reselect = true, animate = false } = {}) {
    const grid = this._tileGrid;
    if (!grid?.open) return;
    const focusedId = grid.focusedId;
    const ids = grid.ids.slice();
    // The close itself stays synchronous (every caller relies on the grid
    // being gone on return); what the user sees leave is a still copy of the
    // tiles, dimmed at once, held until the single view has replayed its
    // session (no empty flash), then faded out over it.
    const releaseGhosts = animate ? this._ghostTileGrid({ hold: reselect }) : null;
    // Remembered (closed) for one-click return, or forgotten.
    if (keepStored) this._persistTileGrid({ open: false });
    else this._forgetStoredTileGrid();
    // A divider drag or a header drag in progress ends with the grid.
    this._tileDividerDragTeardown?.();
    this._endTileMoveDrag();
    // Closed BEFORE the tiles go: each destroy() updates the header's connection
    // state, which must read the main terminal again, not half-destroyed tiles.
    grid.open = false;
    clearTimeout(grid.refitTimer);
    grid.refitTimer = null;
    grid.resizeObserver?.disconnect();
    grid.resizeObserver = null;
    for (const { tile, el } of grid.tiles.values()) {
      this._destroyTerminalTile(tile);
      el.remove();
    }
    grid.tiles.clear();
    for (const el of grid.dividers.values()) el.remove();
    grid.dividers.clear();
    for (const slot of grid.slots || []) slot.remove();
    grid.slots = [];
    grid.colFr = [];
    grid.rowFr = [];
    grid.cells = [];
    grid.cols = 0;
    grid.rows = 0;
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
    // The tabs drop their .in-tiles marker.
    this.renderSessionTabs?.();
    if (reselect) {
      const shown = this._selectAfterTileGrid(focusedId);
      if (releaseGhosts) Promise.resolve(shown).finally(releaseGhosts);
    } else {
      releaseGhosts?.();
    }
  },

  /** False under prefers-reduced-motion: the grid then opens and closes at once. */
  _tileMotionAllowed() {
    return !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  },

  /**
   * A still copy of the open grid over the stage, so the tiles leave calmly
   * while closeTileGrid (or a re-form) tears the real ones down at once.
   * Clones only: no xterm, socket or listener comes along (the DOM renderer's
   * rows and their style elements do, so the copy shows the text), and the
   * layer is inert, hidden from assistive tech and takes no pointer. With
   * `hold` it dims at once and waits for the returned release() (the single
   * view has its content), at most TILE_GHOST_HOLD_MAX_MS; without, it fades
   * out straight away. It removes itself when the fade ends (or after
   * TILE_GHOST_FALLBACK_MS). Nothing under reduced motion (release is then a
   * no-op).
   *
   * @returns {() => void} release
   */
  _ghostTileGrid({ hold = false } = {}) {
    const grid = this._tileGrid;
    const section = document.getElementById('tileGrid');
    const main = section?.parentElement;
    const none = () => {};
    if (!grid?.open || !section || !main || !this._tileMotionAllowed()) return none;
    this._purgeTileGhosts();
    const s = section.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    if (!(s.width > 0 && s.height > 0)) return none;
    const layer = document.createElement('div');
    layer.className = hold ? 'tile-grid-ghosts' : 'tile-grid-ghosts tile-grid-ghosts--now';
    layer.setAttribute('aria-hidden', 'true');
    layer.inert = true;
    layer.style.left = `${s.left - m.left}px`;
    layer.style.top = `${s.top - m.top}px`;
    layer.style.width = `${s.width}px`;
    layer.style.height = `${s.height}px`;
    layer.style.gridTemplateColumns = section.style.gridTemplateColumns;
    layer.style.gridTemplateRows = section.style.gridTemplateRows;
    // Zoomed, only the zoomed tile is on screen (the others are display: none
    // under .tile-grid--zoomed, a rule the ghost layer does not carry).
    const zoomed = section.classList.contains('tile-grid--zoomed');
    for (const id of grid.ids) {
      const el = grid.tiles.get(id)?.el;
      if (!el || (zoomed && !el.classList.contains('tile--zoomed'))) continue;
      const ghost = el.cloneNode(true);
      ghost.classList.remove('tile--entering', 'tile--needs', 'tile--loading', 'tile--drop-target', 'tile--dragging');
      ghost.classList.add('tile--leaving');
      layer.appendChild(ghost);
    }
    main.appendChild(layer);
    let fallback = null;
    let holdCap = null;
    const done = () => {
      clearTimeout(fallback);
      clearTimeout(holdCap);
      layer.remove();
      if (this._tileGhostLayer === layer) this._tileGhostLayer = null;
    };
    const release = () => {
      if (fallback !== null || !layer.isConnected) return;
      clearTimeout(holdCap);
      layer.classList.add('tile-grid-ghosts--release');
      fallback = setTimeout(done, TILE_GHOST_FALLBACK_MS);
    };
    layer.addEventListener('animationend', (e) => {
      if (/^tile-leave/.test(e.animationName) && e.target === layer.lastElementChild) done();
    });
    if (hold) holdCap = setTimeout(release, TILE_GHOST_HOLD_MAX_MS);
    else release();
    this._tileGhostLayer = layer;
    return release;
  },

  /** Drops a still copy still showing (the grid reopened, or another close came). */
  _purgeTileGhosts() {
    this._tileGhostLayer?.remove();
    this._tileGhostLayer = null;
  },

  /**
   * The header Tiles button: shown when its per-device setting is on AND the
   * window is desktop-wide (a JS check plus a live media listener, the same
   * pair as the Split button; the CSS `@media (max-width: 1179px)` rule is the
   * backstop that hides it even if this never runs).
   */
  _applyTileGridButtonVisibility(enabled) {
    this._installTileGridHint();
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
    // No native title: the hover card says it (two tooltips never stack), and
    // aria-describedby gives screen readers the same text.
    btn.setAttribute(
      'aria-label',
      open
        ? 'Tiles: back to a single session (right-click for how many tiles)'
        : 'Tiles: show several sessions side by side (right-click for how many)'
    );
    this._renderTileHint();
  },

  /**
   * The Tiles button's hover card (owner feedback 1: "give me the hover info
   * to right click over the tile button to adjust it"): the title with the
   * remembered count, what a click does (open or close the grid), that a
   * right-click chooses 2, 4 or 6, what opens when the count does not fit the
   * window, and, shown from the keyboard, Shift+F10. It replaces the button's
   * native title. The card always exists (hidden) and is kept current, since
   * the button's aria-describedby reads it for screen readers without a
   * hover. Installed once, from the button's visibility setter; never in a
   * solo window.
   */
  _installTileGridHint() {
    if (this._tileHint || this.isSoloWindow) return;
    const btn = document.querySelector('.btn-tile-grid');
    if (!btn) return;
    const card = document.createElement('div');
    card.id = 'tileGridHint';
    card.className = 'tile-hint';
    card.setAttribute('role', 'tooltip');
    card.hidden = true;
    const title = document.createElement('div');
    title.className = 'tile-hint-title';
    const line = (glyph) => {
      const row = document.createElement('div');
      row.className = 'tile-hint-line';
      const text = document.createElement('span');
      if (glyph) row.appendChild(glyph);
      row.appendChild(text);
      return { row, text };
    };
    const click = line(tileHintMouseGlyph('left'));
    const right = line(tileHintMouseGlyph('right'));
    right.text.textContent = 'Right-click: choose 2, 4 or 6 tiles';
    const fits = line(null);
    fits.row.classList.add('tile-hint-note');
    const keys = line(null);
    keys.row.classList.add('tile-hint-keys');
    keys.text.textContent = 'Shift+F10: the same menu from the keyboard';
    card.append(title, click.row, right.row, fits.row, keys.row);
    document.body.appendChild(card);
    btn.removeAttribute('title');
    btn.setAttribute('aria-describedby', card.id);
    const hint = (this._tileHint = { btn, card, title, click: click.text, fits, keys, timer: null, suppressed: false });
    const canHover = () => window.matchMedia?.('(hover: hover)')?.matches !== false;
    btn.addEventListener('pointerenter', (e) => {
      if (e?.pointerType === 'touch' || !canHover()) return;
      this._scheduleTileHint({ keyboard: false });
    });
    btn.addEventListener('pointerleave', () => {
      hint.suppressed = false;
      this._hideTileHint();
    });
    btn.addEventListener('focus', () => {
      // Focus put back by the count menu's Escape: the user was just there.
      if (hint.skipFocus) {
        hint.skipFocus = false;
        return;
      }
      if (btn.matches?.(':focus-visible')) this._scheduleTileHint({ keyboard: true });
    });
    // Leaving the button ends a click's suppression too: a keyboard focus that
    // comes back later is a new arrival, even with the pointer still on it.
    btn.addEventListener('blur', () => {
      hint.suppressed = false;
      this._hideTileHint();
    });
    // Capture: these run before the button's own handlers, so the card is gone
    // before a right-click opens the count menu or a click opens the grid; and
    // it stays gone while the pointer rests there.
    const dismiss = () => {
      hint.suppressed = true;
      this._hideTileHint();
    };
    for (const type of ['pointerdown', 'click', 'contextmenu']) btn.addEventListener(type, dismiss, true);
    // While shown: Escape, a scroll anywhere, a resize.
    hint.onKey = (e) => {
      if (e.key === 'Escape') this._hideTileHint();
    };
    hint.onAway = () => this._hideTileHint();
    this._renderTileHint();
  },

  /**
   * The card's text, from the remembered count, the grid's state and what the
   * window fits. Compared with the last English text set, never the DOM (in
   * zh-CN the DOM holds the translation; see _renderTileOverlay).
   */
  _renderTileHint() {
    const hint = this._tileHint;
    if (!hint) return;
    const count = this._tileGridCount();
    const open = this._tilesOwnTerminal();
    const capacity = this._tileGridLimit().capacity;
    const set = (el, key, text) => {
      if (hint[key] === text) return;
      hint[key] = text;
      el.textContent = text;
    };
    set(hint.title, 'titleText', `Tiles \u00B7 ${count}`);
    set(hint.click, 'clickText', open ? 'Click: close the grid' : 'Click: open the grid');
    const plural = capacity === 1 ? '' : 's';
    const fitsText =
      count <= capacity
        ? ''
        : open
          ? `This window fits ${capacity} tile${plural}`
          : `This window fits ${capacity} tile${plural}: a click opens ${capacity}`;
    set(hint.fits.text, 'fitsText', fitsText);
    hint.fits.row.hidden = !fitsText;
  },

  _scheduleTileHint({ keyboard }) {
    const hint = this._tileHint;
    if (!hint || hint.suppressed) return;
    clearTimeout(hint.timer);
    hint.timer = setTimeout(() => this._showTileHint({ keyboard }), TILE_HINT_DELAY_MS);
  },

  /** Under the button, right-aligned as the count menu; never with the menu open or the button hidden. */
  _showTileHint({ keyboard }) {
    const hint = this._tileHint;
    hint.timer = null;
    if (hint.suppressed || this._tileCountMenu || hint.btn.classList.contains('btn-tile-grid--hidden')) return;
    this._renderTileHint();
    hint.keys.row.hidden = !keyboard;
    const rect = hint.btn.getBoundingClientRect?.();
    if (rect) {
      hint.card.style.top = `${rect.bottom + 6}px`;
      hint.card.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    }
    if (!hint.card.hidden) return;
    hint.card.hidden = false;
    document.addEventListener('keydown', hint.onKey, true);
    window.addEventListener('scroll', hint.onAway, true);
    window.addEventListener('resize', hint.onAway);
  },

  /** Idempotent: cancels a pending show and hides the card. */
  _hideTileHint() {
    const hint = this._tileHint;
    if (!hint) return;
    clearTimeout(hint.timer);
    hint.timer = null;
    if (hint.card.hidden) return;
    hint.card.hidden = true;
    // Hidden, the card is the button's description in full: a hidden line
    // inside it would be left out of what a screen reader hears.
    hint.keys.row.hidden = false;
    document.removeEventListener('keydown', hint.onKey, true);
    window.removeEventListener('scroll', hint.onAway, true);
    window.removeEventListener('resize', hint.onAway);
  },

  /**
   * How many tiles the grid takes here and now: what the terminal area fits
   * (the grid section, or the single view it would replace), at most the cap
   * (TILE_GRID_MAX), never less than one. `full` says which of the two binds,
   * so a large monitor never reads "this window fits 6".
   */
  _tileGridLimit() {
    const T = window.CodemanTileGrid;
    const max = T.TILE_GRID_MAX;
    const el = this._tilesOwnTerminal() ? this._tileGridSection() : document.querySelector('.terminal-wrap');
    const rect = el?.getBoundingClientRect?.() || { width: 0, height: 0 };
    const fits = T.tileGridCapacity({
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
    });
    const capacity = Math.max(1, Math.min(fits, max));
    const byCap = fits >= max;
    return {
      capacity,
      full: byCap
        ? `The grid holds at most ${max} tiles`
        : `The grid already holds what this window fits (${capacity})`,
    };
  },

  /** The tile count a click on Tiles opens (the menu's last pick, per device), default 6. */
  _tileGridCount() {
    let raw = null;
    try {
      raw = localStorage.getItem(TILE_GRID_COUNT_KEY);
    } catch {
      /* Storage unavailable: the default. */
    }
    return window.CodemanTileGrid.sanitizeTileCount(raw);
  },

  _rememberTileGridCount(count) {
    try {
      localStorage.setItem(TILE_GRID_COUNT_KEY, String(window.CodemanTileGrid.sanitizeTileCount(count)));
    } catch {
      /* Per-device convenience only. */
    }
    // The hover card names the count.
    this._renderTileHint();
  },

  /**
   * Right-click on the Tiles button (or Shift+F10 / the Menu key on it, which
   * fire the same contextmenu event; its click opens the grid at once, see
   * toggleTileGrid): how many tiles, 2, 4 or 6 (owner decision 10), each with
   * its shape, the remembered count checked. A count the window cannot fit is
   * greyed out, and the menu says why; the keyboard then starts on the largest
   * that fits (the count a click opens here). Picking one opens the grid with
   * that many tiles, or re-forms the open grid to it, and remembers it for the
   * click. Arrows move, Enter or Space picks, Escape closes and gives the
   * keyboard back to the Tiles button, Tab closes.
   */
  openTileCountMenu(event) {
    // The right-click: the browser's own context menu stays away.
    event?.preventDefault?.();
    // Never beside a hover card still showing (its own capture listener has
    // usually hidden it already).
    this._hideTileHint();
    if (this._tileCountMenu) {
      this.closeTileCountMenu();
      return;
    }
    if (!this.canOpenTileGrid()) return;
    const T = window.CodemanTileGrid;
    const capacity = this._tileGridLimit().capacity;
    const fitsText = `This window fits ${capacity} tile${capacity === 1 ? '' : 's'}`;
    const current = this._tileGridCount();
    const menu = document.createElement('div');
    menu.id = 'tileCountMenu';
    menu.className = 'tile-count-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'How many tiles');
    const heading = document.createElement('div');
    heading.className = 'tile-count-heading';
    heading.setAttribute('aria-hidden', 'true');
    heading.textContent = 'Tiles';
    menu.appendChild(heading);
    const items = [];
    for (const n of T.TILE_GRID_COUNTS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tile-count-item';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', n === current ? 'true' : 'false');
      item.tabIndex = -1;
      item.dataset.count = String(n);
      if (n > capacity) {
        item.disabled = true;
        item.setAttribute('aria-disabled', 'true');
        item.title = fitsText;
      }
      const label = document.createElement('span');
      label.className = 'tile-count-label';
      label.textContent = `${n} tiles`;
      const check = document.createElement('span');
      check.className = 'tile-count-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = n === current ? '\u2713' : '';
      item.append(tileCountGlyph(n), label, check);
      item.addEventListener('click', (e) => {
        e.stopPropagation?.();
        if (!item.disabled) this._pickTileCount(n);
      });
      item.addEventListener('pointerenter', () => {
        if (!item.disabled) item.focus?.();
      });
      menu.appendChild(item);
      items.push(item);
    }
    if (capacity < T.TILE_GRID_MAX) {
      const hint = document.createElement('div');
      hint.className = 'tile-count-hint';
      hint.textContent = fitsText;
      menu.appendChild(hint);
    }

    document.body.appendChild(menu);
    const btn = document.querySelector('.btn-tile-grid');
    if (btn?.getBoundingClientRect) {
      // Under the Tiles button (.tile-count-menu is position: fixed).
      const rect = btn.getBoundingClientRect();
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    }
    const enabled = () => items.filter((i) => !i.disabled);
    const move = (delta) => {
      const list = enabled();
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement);
      const next = at === -1 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length;
      list[next].focus?.();
    };
    // A click elsewhere closes it. A click on the Tiles button needs no
    // exception: its own handler (toggleTileGrid) closes the menu first.
    const onOutside = (e) => {
      if (menu.contains?.(e.target)) return;
      this.closeTileCountMenu();
    };
    // The menu's keys, in the capture phase while it is open. Escape normally
    // reaches the app's global handler first, which closes the menu alone and
    // gives the keyboard back (app.js); this one covers the rest.
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        this.closeTileCountMenu({ refocus: true });
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault?.();
        move(1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault?.();
        move(-1);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault?.();
        const list = enabled();
        list[e.key === 'Home' ? 0 : list.length - 1]?.focus?.();
      } else if (e.key === 'Enter' || e.key === ' ') {
        const item = items.find((i) => i === document.activeElement);
        if (!item) return;
        // Not the button's own activation too.
        e.preventDefault?.();
        if (!item.disabled) this._pickTileCount(Number(item.dataset.count));
      } else if (e.key === 'Tab') {
        this.closeTileCountMenu();
      }
    };
    // The keyboard leaving the menu for something else closes it, as any menu:
    // closing the grid starts a selection that focuses the single view's
    // terminal when its replay lands, and a menu left open behind that would
    // send the keys meant for it (arrows, Enter, Escape) into the terminal. A
    // focus going nowhere (a click on a button in Safari, which does not focus
    // it) does not count.
    menu.addEventListener('focusout', (e) => {
      const to = e.relatedTarget;
      if (to && !menu.contains?.(to)) this.closeTileCountMenu({ refocus: false });
    });
    this._tileCountMenu = { menu, onOutside, onKey };
    document.addEventListener('click', onOutside);
    document.addEventListener('keydown', onKey, true);
    // The checked count, or when the window cannot fit it, the largest that fits.
    const start = items.find((i) => !i.disabled && i.getAttribute('aria-checked') === 'true') || enabled().at(-1);
    (start || menu).focus?.();
  },

  /**
   * Idempotent: the global Escape handler may call it whether or not the menu
   * is open. The keyboard goes back to the Tiles button when it was in the
   * menu (`refocus` unset), or when asked (Escape); a click elsewhere has
   * already moved it, and a pick passes `refocus: false`.
   */
  closeTileCountMenu({ refocus } = {}) {
    const menu = this._tileCountMenu;
    if (!menu) return;
    if (refocus === undefined) refocus = !!menu.menu.contains?.(document.activeElement);
    this._tileCountMenu = null;
    document.removeEventListener('click', menu.onOutside);
    document.removeEventListener('keydown', menu.onKey, true);
    menu.menu.remove();
    if (refocus) {
      // The user was just in the menu: no hover card for this focus.
      if (this._tileHint) this._tileHint.skipFocus = true;
      document.querySelector('.btn-tile-grid')?.focus?.();
      if (this._tileHint) this._tileHint.skipFocus = false;
    }
  },

  /**
   * A count picked in the menu: remembered for the click, then the grid opens
   * with that many tiles (what the click opens), or the open grid is re-formed
   * to it (_reformTileGrid). Never more than the window fits; fewer open
   * sessions than the count give fewer tiles.
   */
  _pickTileCount(count) {
    this.closeTileCountMenu({ refocus: false });
    this._rememberTileGridCount(count);
    const grid = this._tileGrid;
    if (!grid?.open) {
      this.toggleTileGrid();
      return;
    }
    const T = window.CodemanTileGrid;
    const n = Math.min(T.sanitizeTileCount(count), this._tileGridLimit().capacity);
    const all = T.buildTilePickerSessions(this.sessions, this.sessionOrder, this.detachedSessions).map((c) => c.id);
    this._reformTileGrid(T.tileGridSetForCount(grid.ids, all, n, grid.focusedId));
  },

  /**
   * The open grid re-formed to the tiles `target` (a count picked in the
   * menu): a count change is a shape change, so the cell model's rule applies
   * (reformTileCells: the tiles that stay keep their row and column when all
   * fit, else they pack in reading order), and the tiles that join fill the
   * empty cells in reading order, holes first. The focused tile is always
   * among those that stay (tileGridSetForCount). Every tile that joins is
   * mounted and the grid laid out ONCE before any of them connects (as in
   * openTileGrid): a tile connected into an intermediate layout would fit that
   * cell first and resize its PTY twice. A zoom the user chose ends: the grid
   * they asked for is meant to be seen.
   */
  _reformTileGrid(target) {
    const grid = this._tileGrid;
    if (!grid?.open) return;
    const T = window.CodemanTileGrid;
    const leaving = grid.ids.filter((id) => !target.includes(id));
    const joining = target.filter((id) => !grid.tiles.has(id));
    if (leaving.length === 0 && joining.length === 0) return;
    // The old grid fades out over the new one as it forms.
    this._ghostTileGrid();
    // A divider or header drag in progress measured the old grid.
    this._tileDividerDragTeardown?.();
    this._endTileMoveDrag();
    for (const id of leaving) {
      const entry = grid.tiles.get(id);
      this._destroyTerminalTile(entry.tile);
      entry.el.remove();
      grid.tiles.delete(id);
    }
    if (grid.zoomedId && !grid.autoZoom) grid.zoomedId = null;
    const staying = grid.ids.filter((id) => grid.tiles.has(id));
    const mounted = joining.filter((id, k) => this._mountTile(id, { enterIndex: k }));
    const { cols, rows } = this._tileShapeFor(grid.tiles.size);
    grid.cells = T.reformTileCells(grid.cells, grid.cols, staying, mounted, cols, rows);
    grid.cols = cols;
    grid.rows = rows;
    this._applyTileLayout();
    for (const id of mounted) this._connectTile(id);
    this._scheduleTileGridRefit();
    this.renderSessionTabs?.();
  },

  /**
   * A session THIS tab's Run just created (session-ui.js
   * _ensureCreatedSessionVisible, reached only from the Run paths): with the
   * grid open it joins the next free slot, and Run's own selectSession then
   * focuses it through the tile branch. Sessions created elsewhere (agents,
   * other devices, cron) arrive only by session:created and never join. A grid
   * already holding what the window fits does not take it; Run's selection
   * then shows it in the single view (decision 1), and a hint says why.
   */
  _joinTileGridFromRun(sessionId) {
    const grid = this._tileGrid;
    if (!grid?.open || grid.tiles.has(sessionId) || !this.sessions.has(sessionId)) return false;
    const limit = this._tileGridLimit();
    if (grid.ids.length >= limit.capacity) {
      this.showToast?.(`${limit.full}: the new session opens on its own`, 'info');
      return false;
    }
    // Run starts the session right after creating it: no Attach overlay
    // meanwhile for a pane that is about to exist.
    (this._tileAttachPending ||= new Map()).set(sessionId, Date.now());
    return this.addTile(sessionId);
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
   * per-device `showTileGridButton` setting is on (the desktop default; OFF on
   * handhelds and touch-primary tablets): with it off the chord is inert and
   * reaches the terminal like any unbound key (owner decision 6 in
   * docs/tile-grid-plan.md). An absent key
   * resolves through the device defaults exactly as the header button does
   * (settings-ui.js), so the chord and the button can never disagree. The focus, move,
   * zoom and remove chords apply only while the grid is open, however it was
   * opened (a move chord also while a tile is zoomed, as a no-op, so its keys
   * never reach the CLI). The arrow chords never apply in a text field, whose
   * keys they are.
   * Registry-aware (rebinds and disables in App Settings, Shortcuts).
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
      if ((spec.direction || spec.move) && isTextFieldTarget(e.target)) continue;
      if (spec.needsOpen) return open ? shortcut.id : null;
      const stored = this.loadAppSettingsFromStorage?.()?.showTileGridButton;
      const enabled = (stored ?? this.getDefaultSettings?.()?.showTileGridButton ?? true) === true;
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
    else if (spec.move) this.moveTileInDirection(spec.move);
  },

  /**
   * The Tiles button's click and Ctrl+Shift+G, one function so the two never
   * drift (owner decision 8): opens the grid at once, no menu in the way, or
   * closes it to the single view of the focused session. What opens is the
   * remembered count of tiles (the right-click menu's last pick, default 6,
   * at most what the window fits; owner decision 10), chosen by
   * `tileGridOpenSet` (constants.js): the grid this tab last had, else an open
   * split's two sessions, else the open sessions in tab order, the active one
   * focused; then trimmed or filled to the count (the focused one kept). A
   * remembered grid comes back with its tiles in their cells, the ones the
   * count adds filling its empty cells first (_openStoredTileGrid).
   */
  toggleTileGrid() {
    this.closeTileCountMenu();
    if (this._tilesOwnTerminal()) {
      this.closeTileGrid({ keepStored: true, reselect: true, animate: true });
      return;
    }
    if (!this.canOpenTileGrid()) return;
    const stored = this._readStoredTileGrid();
    const set = this._tileGridOpenSet(stored);
    if (!set) {
      this.showToast?.('No sessions to show as tiles', 'info');
      return;
    }
    if (set.source === 'stored') this._openStoredTileGrid(stored, set.ids);
    else this.openTileGrid(set.ids, { focusedId: set.focusedId });
  },

  /**
   * What the toggle would open now (see toggleTileGrid): `count` tiles (the
   * remembered count), or as many as the window fits; `stored` saves a
   * second read.
   */
  _tileGridOpenSet(stored = this._readStoredTileGrid(), count = this._tileGridCount()) {
    const T = window.CodemanTileGrid;
    const n = Math.max(1, Math.min(count, this._tileGridLimit().capacity));
    const set = T.tileGridOpenSet({
      stored,
      split: this._splitPane ? [this.activeSessionId, this._splitSessionId] : null,
      sessions: this.sessions,
      sessionOrder: this.sessionOrder,
      detachedIds: this.detachedSessions,
      activeId: this.activeSessionId,
      limit: n,
    });
    if (!set) return null;
    const all = T.buildTilePickerSessions(this.sessions, this.sessionOrder, this.detachedSessions).map((c) => c.id);
    return { ...set, ids: T.tileGridSetForCount(set.ids, all, n, set.focusedId) };
  },

  /** Alt+Shift+Arrows: a human selection of the tile in that direction. */
  focusTileInDirection(direction) {
    const grid = this._tileGrid;
    if (!grid?.open) return;
    // Over the cells: focus skips an empty one, never lands on it.
    const id = window.CodemanTileGrid.tileInDirection(grid.cells, grid.focusedId, direction, grid.cols);
    if (id) this.selectSession(id);
  },

  /**
   * Ctrl+Tab / Alt+] (delta 1) and Alt+[ (delta -1) while the grid is open: a
   * human selection of the next tile in reading order, wrapping. Returns
   * whether the grid took the chord (it is open), so the tab walk is skipped.
   */
  _cycleTileFocus(delta) {
    const grid = this._tileGrid;
    if (!grid?.open) return false;
    const id = window.CodemanTileGrid.cycleTile(grid.ids, this.activeSessionId, delta);
    if (id) this.selectSession(id);
    return true;
  },

  /** Removes the focused tile (the session keeps running); a neighbour takes focus. */
  removeFocusedTile() {
    const grid = this._tileGrid;
    if (!grid?.open || !grid.focusedId) return;
    this.removeTile(grid.focusedId);
  },

  // The single view after the grid closes: the session the grid was focused on,
  // replayed fresh (forceReload drops the stale snapshot and nulls
  // activeSessionId BEFORE _cleanupPreviousSession, so nothing wrong is saved),
  // or, if that session is gone, the same fallback as closing the active tab.
  // A popped-out session counts as gone in both: selectSession would only
  // raise its window and return, leaving the parked terminal's pre-grid
  // content on screen under its tab (and saved as its snapshot on the next
  // switch). Returns the selection's promise (it settles once the replay is
  // written), or undefined for the welcome screen.
  _selectAfterTileGrid(sessionId) {
    const usable = (id) => this.sessions.has(id) && !this.detachedSessions?.has(id);
    if (sessionId && usable(sessionId)) {
      return this.selectSession(sessionId, { forceReload: true, auto: true });
    }
    this.activeSessionId = null;
    try {
      localStorage.removeItem('codeman-active-session');
    } catch {
      /* Nothing stored. */
    }
    const next = this.sessionOrder.find(usable);
    if (next) return this.selectSession(next, { auto: true });
    this.terminal?.clear();
    this.showWelcome();
    return undefined;
  },

  /**
   * Adds one session as a tile (open grid only), into `cell` when that cell is
   * empty (a tab dropped on it), else the first empty cell in reading order
   * (_placeTile). It enters as the `enterIndex`-th of a staggered group
   * (_mountTile). Returns whether it was added.
   */
  addTile(sessionId, { cell = -1, enterIndex = 0 } = {}) {
    const grid = this._tileGrid;
    if (!grid?.open || grid.tiles.has(sessionId)) return false;
    if (grid.ids.length >= window.CodemanTileGrid.TILE_GRID_MAX) return false;
    if (!this._mountTile(sessionId, { enterIndex })) return false;
    this._placeTile(sessionId, cell);
    // A tile added while one is zoomed by hand is meant to be seen.
    if (grid.zoomedId && !grid.autoZoom) grid.zoomedId = null;
    this._applyTileLayout();
    this._connectTile(sessionId);
    this._scheduleTileGridRefit();
    this.renderSessionTabs?.();
    return true;
  },

  /**
   * Puts a tile just mounted into a cell. The shape for one more tile comes
   * first (fitTileCells: the same shape keeps every cell; 2x2 growing to 3x2
   * keeps each tile where it is), then `cell` if it is empty there, else the
   * first empty cell in reading order.
   */
  _placeTile(sessionId, cell = -1) {
    const grid = this._tileGrid;
    const { cols, rows } = this._tileShapeFor(grid.ids.length + 1);
    grid.cells = window.CodemanTileGrid.fitTileCells(grid.cells, grid.cols, cols, rows);
    grid.cols = cols;
    grid.rows = rows;
    const k = Number.isInteger(cell) && grid.cells[cell] === null ? cell : grid.cells.indexOf(null);
    // (No empty cell cannot happen: the shape for n tiles has at least n cells.
    // Appended, the next layout packs it in.)
    if (k === -1) grid.cells.push(sessionId);
    else grid.cells[k] = sessionId;
  },

  /** Columns x rows (and whether they fit) for `count` tiles in the grid area as it is now. */
  _tileShapeFor(count) {
    const rect = this._tileGridSection().getBoundingClientRect?.() || { width: 0, height: 0 };
    return window.CodemanTileGrid.computeTileLayout({
      count,
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
    });
  },

  /**
   * Removes one tile; the session keeps running. Its cell becomes empty where
   * it was, unless the shape changes with the count (then fitTileCells). When it held focus, `refocus`
   * moves focus to the neighbouring tile (next in grid order, else previous),
   * as the app's choice (`auto`: no idle alert is spent); `focus: false` keeps
   * DOM focus where it is (an app-driven removal: a socket the server closed),
   * so keystrokes never land in the neighbour's PTY unasked. The last tile
   * leaving closes the grid: with `refocus` the single view then shows that
   * session (or, popped out, the next one: _selectAfterTileGrid), without it
   * the caller decides what comes next.
   */
  removeTile(sessionId, { refocus = true, focus = true } = {}) {
    const grid = this._tileGrid;
    const entry = grid?.open ? grid.tiles.get(sessionId) : null;
    if (!entry) return false;
    if (grid.ids.length === 1) {
      this.closeTileGrid({ keepStored: false, reselect: refocus });
      return true;
    }
    const wasFocused = grid.focusedId === sessionId;
    const neighbor = window.CodemanTileGrid.tileNeighbor(grid.ids, sessionId);
    // A divider drag in progress was measured against this tile; a header
    // drag of this tile has nothing left to drop.
    this._tileDividerDragTeardown?.();
    if (this._draggedTileId === sessionId) this._endTileMoveDrag();
    // The zoomed tile leaving restores the grid (an automatic zoom moves to
    // the neighbour with focus, below).
    if (grid.zoomedId === sessionId) grid.zoomedId = grid.autoZoom && refocus ? neighbor : null;
    this._destroyTerminalTile(entry.tile);
    entry.el.remove();
    grid.tiles.delete(sessionId);
    grid.cells[grid.cells.indexOf(sessionId)] = null;
    // Before the layout, which may zoom the focused tile on a small window.
    if (wasFocused) grid.focusedId = null;
    this._applyTileLayout();
    this._scheduleTileGridRefit();
    this.renderSessionTabs?.();
    if (wasFocused && refocus && neighbor) this._selectTiledSession(neighbor, { auto: true, focus });
    return true;
  },

  /**
   * Builds one tile (header, body, TerminalTile); where it goes is the
   * caller's (grid.cells). It enters with a short fade and settle
   * (styles.css .tile--entering, the `enterIndex`-th of a staggered group),
   * and its terminal stays transparent until its first capture lands
   * (.tile--revealing, cleared by the load queue, with a backstop timer).
   * Opacity and transform only, never anything its fit reads.
   */
  _mountTile(sessionId, { enterIndex = 0 } = {}) {
    const grid = this._tileGrid;
    const session = this.sessions.get(sessionId);
    if (!session || this.detachedSessions?.has(sessionId)) return false;
    const el = document.createElement('div');
    el.className = 'tile tile--revealing';
    setTimeout(() => el.classList.remove('tile--revealing'), TILE_REVEAL_FALLBACK_MS);
    if (this._tileMotionAllowed()) {
      el.classList.add('tile--entering');
      el.style.setProperty('--tile-enter-index', String(enterIndex));
      const onEnd = (e) => {
        if (e.target !== el || e.animationName !== 'tile-enter') return;
        el.removeEventListener('animationend', onEnd);
        el.classList.remove('tile--entering');
      };
      el.addEventListener('animationend', onEnd);
    }
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
    // selectSession's early return, which acknowledges too). In the body on
    // pointerdown, not click, so focus moves before the press reaches xterm,
    // and never preventDefault: xterm's own mousedown focuses its textarea and
    // starts selections. In the header on click instead (below): a press there
    // may become a drag, and a drag that is cancelled changes nothing, focus
    // included (owner: best practice). A drag never ends in a click.
    el.addEventListener('pointerdown', (e) => {
      if (header.el.contains?.(e?.target)) return;
      if (this._tileGrid?.has(sessionId)) this.selectSession(sessionId);
    });
    header.el.addEventListener('click', () => {
      if (this._tileGrid?.has(sessionId)) this.selectSession(sessionId);
    });
    // A tile takes any session but its own (_acceptTabDrops).
    this._acceptTabDrops(el, (draggedId) => this.dropSessionOnTile(draggedId, sessionId), {
      accepts: (id) => id !== sessionId,
    });
    this._tileGridSection().appendChild(el);
    const tile = this._newTerminalTile(sessionId, body);
    grid.tiles.set(sessionId, {
      tile,
      el,
      body,
      overlay: null,
      header: header.el,
      dot: header.dot,
      harness: header.harness,
      name: header.name,
      model: header.model,
      modelName: header.modelName,
      zoomBtn: header.zoomBtn,
      renaming: false,
      // The pid this tile last saw, so a pane that starts later is noticed.
      pid: this.sessions.get(sessionId)?.pid ?? null,
    });
    // Where it goes is the caller's (grid.cells).
    this._renderTileHeader(sessionId);
    return true;
  },

  /**
   * Makes `el` a drop target for a session tab dragged from the strip (the
   * strip's own drag sets `draggedTabId`) and for a tile dragged by its header
   * (`_draggedTileId`, _installTileMoveDrag). Capture phase, with the event
   * stopped: a tab drag carries the session id as text, and xterm's helper
   * textarea would otherwise accept that drop and type the id into a PTY.
   * `accepts(id)` is the target's own rule (a tile takes any session but its
   * own; an empty cell takes any). A session it does not accept
   * is held there too, but refused (`dropEffect: 'none'`, no highlight, so no
   * drop follows). Any other drag (a file) is left to the grid section's own
   * guard (_installTileFileDrop).
   */
  _acceptTabDrops(el, onDrop, { accepts = () => true } = {}) {
    const dragged = () => (this._tileGrid?.open ? this.draggedTabId || this._draggedTileId || null : null);
    el.addEventListener(
      'dragover',
      (e) => {
        const id = dragged();
        if (!id) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        const ok = accepts(id);
        if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'move' : 'none';
        if (ok) el.classList.add('tile--drop-target');
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
        const id = dragged();
        if (!id) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        if (accepts(id)) onDrop(id);
      },
      true
    );
  },

  /** Whether tiles can be moved now: more than one, and none zoomed (moving is off while one is). */
  _tilesMovable() {
    const grid = this._tileGrid;
    return !!grid?.open && !grid.zoomedId && grid.ids.length > 1;
  },

  /**
   * Puts the tiles in new cells (the same sessions, the same shape): the one
   * path every move takes, a header drag, the tab of a tiled session dropped
   * on a tile or an empty cell, and the Move Tile chords. Nothing is
   * remounted, reconnected or reloaded, and no session joins or leaves.
   * Divider sizes belong to the cells, so a moved tile takes its new cell's
   * size: each tile whose cell size changed fits once (its xterm and one PTY
   * resize together, #464), every other tile is left alone. Refused while a
   * tile is zoomed (moving is off then).
   *
   * @param {(string|null)[]} cells - the new cells
   * @returns {boolean} false when refused, true otherwise (also when nothing moved)
   */
  _reorderTiles(cells) {
    const grid = this._tileGrid;
    if (!grid?.open || grid.zoomedId || cells.length !== grid.cells.length) return false;
    const tiles = cells.filter(Boolean);
    if (tiles.length !== grid.tiles.size || new Set(tiles).size !== tiles.length) return false;
    if (tiles.some((id) => !grid.tiles.has(id))) return false;
    if (cells.every((id, k) => (id || null) === grid.cells[k])) return true;
    // A divider drag in progress measured the tiles at their old places.
    this._tileDividerDragTeardown?.();
    const cell = (k) => `${grid.colFr[k % grid.cols]}x${grid.rowFr[Math.floor(k / grid.cols)]}`;
    const before = new Map();
    grid.cells.forEach((id, k) => id && before.set(id, cell(k)));
    grid.cells = cells.map((id) => id || null);
    this._applyTileLayout();
    // Synchronous: the fit's measurement forces the new placement's layout.
    grid.cells.forEach((id, k) => {
      if (id && before.get(id) !== cell(k)) grid.tiles.get(id).tile.fit();
    });
    return true;
  },

  /** Two tiles trade cells (_reorderTiles). */
  _swapTiles(a, b) {
    const cells = this._tileGrid.cells.slice();
    const i = cells.indexOf(a);
    const j = cells.indexOf(b);
    if (i === -1 || j === -1) return false;
    cells[i] = b;
    cells[j] = a;
    return this._reorderTiles(cells);
  },

  /**
   * A tile moves into empty cell `k`, leaving its own cell empty: nothing else
   * moves (_reorderTiles). False when `k` is not an empty cell, or moving is off.
   */
  _moveTileToCell(sessionId, k) {
    const cells = this._tileGrid.cells.slice();
    const from = cells.indexOf(sessionId);
    if (from === -1 || !Number.isInteger(k) || cells[k] !== null) return false;
    cells[from] = null;
    cells[k] = sessionId;
    return this._reorderTiles(cells);
  },

  /**
   * Move Tile Left/Right/Up/Down: the focused tile goes to the cell next to it
   * in that direction (tileCellInDirection, never jumping a cell): into it
   * when it is empty, trading places when a tile is there. Focus stays on the
   * moved tile. Nothing while a tile is zoomed, or at an edge.
   */
  moveTileInDirection(direction) {
    const grid = this._tileGrid;
    if (!grid?.open || grid.zoomedId || !grid.focusedId) return;
    const from = grid.cells.indexOf(grid.focusedId);
    const to = window.CodemanTileGrid.tileCellInDirection(from, direction, grid.cols, grid.cells.length);
    if (to === -1) return;
    if (grid.cells[to]) this._swapTiles(grid.focusedId, grid.cells[to]);
    else this._moveTileToCell(grid.focusedId, to);
  },

  /**
   * A tab dropped on a tile, or a tile dragged there by its header: a session
   * not yet tiled REPLACES that tile (same place; the replaced session keeps
   * running); one already tiled swaps places with it (_swapTiles, refused while
   * a tile is zoomed). Either way the dropped session takes focus (a human
   * selection).
   */
  dropSessionOnTile(draggedId, targetId) {
    const grid = this._tileGrid;
    if (!grid?.open || draggedId === targetId || !grid.tiles.has(targetId)) return;
    if (!this.sessions.has(draggedId) || this.detachedSessions?.has(draggedId)) return;
    if (grid.tiles.has(draggedId)) {
      if (!this._swapTiles(draggedId, targetId)) return;
    } else {
      this._tileDividerDragTeardown?.();
      if (!this._mountTile(draggedId)) return;
      // It takes the replaced tile's cell.
      grid.cells[grid.cells.indexOf(targetId)] = draggedId;
      const old = grid.tiles.get(targetId);
      this._destroyTerminalTile(old.tile);
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

  /**
   * Something dropped on empty cell `cell`: a tab of a session not tiled yet
   * joins the grid in that cell; a tiled session (its tab, or the tile dragged
   * by its header) moves into it, leaving its own cell empty
   * (_moveTileToCell, refused while a tile is zoomed). Either way the dropped
   * session takes focus (a human selection).
   */
  dropSessionOnSlot(draggedId, cell) {
    const grid = this._tileGrid;
    if (!grid?.open || !this.sessions.has(draggedId) || this.detachedSessions?.has(draggedId)) return;
    if (grid.tiles.has(draggedId)) {
      if (!this._moveTileToCell(draggedId, cell)) return;
    } else if (!this.addTile(draggedId, { cell })) {
      return;
    }
    this.selectSession(draggedId);
  },

  /**
   * Ctrl/Cmd+click on a tab: that session joins the grid and takes focus (a
   * human selection: the user clicked its tab). With the grid closed it opens
   * what the Tiles toggle would, with this session among the tiles and
   * focused: the remembered count in total (owner answer to decision 10's
   * questions), never one more. Returns false
   * when the grid cannot open here (narrow or solo window), so the click is an
   * ordinary one.
   */
  addSessionToTiles(sessionId) {
    if (!this.canOpenTileGrid() || !this.sessions.has(sessionId) || this.detachedSessions?.has(sessionId)) {
      return false;
    }
    const limit = this._tileGridLimit();
    const capacity = limit.capacity;
    const grid = this._tileGrid;
    if (grid?.open) {
      if (!grid.tiles.has(sessionId)) {
        if (grid.ids.length >= capacity) {
          this.showToast?.(limit.full, 'info');
          return true;
        }
        this.addTile(sessionId);
      }
      this.selectSession(sessionId);
      return true;
    }
    const n = Math.max(1, Math.min(this._tileGridCount(), capacity));
    const base = this._tileGridOpenSet()?.ids || [];
    const ids = [...base.filter((id) => id !== sessionId).slice(0, n - 1), sessionId];
    // Exactly these: an open split is already in `base` (tileGridOpenSet seeds
    // it), and merging it again went past the count (N+1) and the window.
    this.openTileGrid(ids, { focusedId: sessionId, auto: false, mergeSplit: false });
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
    const capacity = this._tileGridLimit().capacity;
    const ids = (group.refs || [])
      .filter((ref) => ref.kind === 'session')
      .map((ref) => ref.id)
      .filter((id) => this.sessions.has(id) && !this.detachedSessions?.has(id))
      .slice(0, capacity);
    if (ids.length === 0) {
      this.showToast?.('This group has no session to show as tiles', 'info');
      return false;
    }
    return this._replaceTileGrid(ids);
  },

  /**
   * Opens the grid on `ids` in place of whatever it shows ("Open group as
   * tiles"): the session in focus keeps focus when `ids` holds
   * it, otherwise the first one takes it. Chosen BEFORE an open grid closes,
   * because the close drops activeSessionId: as in selectSession's tile
   * branch, the parked terminal still holds what it showed before the grid,
   * and re-parking must not snapshot it.
   *
   * @returns {boolean} whether the grid is open afterwards
   */
  _replaceTileGrid(ids) {
    const focus = ids.includes(this.activeSessionId) ? this.activeSessionId : ids[0];
    if (this._tilesOwnTerminal()) {
      this.closeTileGrid({ keepStored: false, reselect: false });
      this.activeSessionId = null;
    }
    // Exactly the group: an open split closes without joining it (merged, its
    // two pushed group members out and the grid past the window's capacity).
    return this.openTileGrid(ids, { focusedId: focus, mergeSplit: false });
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
   * A grid tile's TerminalTile goes for good: its loads still waiting in the
   * grid's queue are dropped first (resolved, never run, its loading state
   * cleared), then the tile itself (socket, xterm, listeners). Its element is
   * the caller's.
   */
  _destroyTerminalTile(tile) {
    this._tileGrid.queue?.drop(tile);
    tile.destroy();
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
    this._destroyTerminalTile(entry.tile);
    entry.tile = this._newTerminalTile(sessionId, entry.body);
    entry.connected = false;
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
    // Compared with the last English text set, never the DOM: with the zh-CN
    // translator on, the DOM holds the translation and would never match, so
    // every refresh would rewrite English for it to translate again.
    if (entry.overlayLabel !== text) {
      entry.overlayLabel = text;
      entry.overlayText.textContent = text;
    }
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
   * `● [logo] name · model ..... ⋯ ⤢ ×`: the status dot (the six-state
   * classifier the tab rows and both home screens share), the harness logo, the
   * session name (double-click renames), the model it runs when known, the
   * session menu (the tab rail's own), zoom and remove-tile. Its
   * buttons stop pointerdown, so acting on a tile that is not focused does not
   * also focus it (and spend its idle alert). The rest of it is the handle that
   * moves the tile (_installTileMoveDrag).
   */
  _buildTileHeader(sessionId) {
    const el = document.createElement('div');
    el.className = 'tile-header';
    const dot = document.createElement('span');
    dot.className = 'tile-dot home-sessions-dot home-sessions-dot--idle';
    dot.setAttribute('aria-hidden', 'true');
    // The harness's logo: PR #532's `run-mode-dot <cliId>` slot, so the logos,
    // the skins and the plain dot for an id without one stay in styles.css. Its
    // tooltip and accessible name carry the harness and the model in full
    // (_paintSessionHarness).
    const harness = document.createElement('span');
    harness.className = 'tile-harness run-mode-dot';
    harness.setAttribute('role', 'img');
    const title = document.createElement('span');
    title.className = 'tile-title';
    const name = document.createElement('span');
    name.className = 'tile-name';
    // A session literally named like a UI string ("Sessions") must not be translated.
    name.setAttribute('data-i18n-skip', '');
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startTileRename(sessionId);
    });
    // The model the session runs, when the server knows it: the name itself is
    // never translated (data-i18n-skip on the inner span), the tooltip on the
    // outer one may be. Hidden from screen readers: the logo's accessible name
    // already says it.
    const model = document.createElement('span');
    model.className = 'tile-model';
    model.setAttribute('aria-hidden', 'true');
    model.hidden = true;
    const modelName = document.createElement('span');
    modelName.setAttribute('data-i18n-skip', '');
    model.appendChild(modelName);
    title.append(name, model);
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
      // (No + here, owner decision 9: tiles are added from the Tiles button
      // and its count menu, Ctrl/Cmd+click, a dragged tab, a tab group or Run.)
      // Removes the tile ONLY: the session keeps running. Killing it stays
      // behind the menu's Close session and its confirm.
      button('tile-remove', 'Remove tile (the session keeps running)', '\u00D7', () => this.removeTile(sessionId))
    );
    el.append(dot, harness, title, actions);
    this._installTileMoveDrag(sessionId, el, actions);
    return { el, dot, harness, name, model, modelName, zoomBtn };
  },

  /**
   * The header moves its tile: dragged onto another tile the two trade places,
   * onto an empty cell it moves there and leaves its own cell empty
   * (dropSessionOnTile / dropSessionOnSlot, the path a dragged tab takes,
   * through the same capture-phase drop targets, _acceptTabDrops). A native drag, so Escape and a drop anywhere else are the
   * browser's own cancel: nothing moves, and dragend clears what the drag
   * painted. The drag carries a type of its own and never text, so no text
   * field or terminal, in this page or another application, can take it as
   * typing; and it is not `draggedTabId`, so the tab strip ignores it.
   *
   * The handle is the header's free area: a press on a button or the rename
   * input starts no drag. dragstart's target is the header whatever was
   * pressed, so where the press landed is noted in the capture phase, ahead of
   * the buttons' own stopPropagation. `draggable` is off while moving is
   * (_paintTileHandle: a zoomed grid, a single tile, a rename in progress).
   */
  _installTileMoveDrag(sessionId, header, actions) {
    let pressedOnControl = false;
    header.addEventListener(
      'pointerdown',
      (e) => {
        const target = e.target;
        pressedOnControl = !!actions.contains?.(target) || /^(INPUT|BUTTON)$/i.test(target?.tagName || '');
      },
      true
    );
    header.addEventListener('dragstart', (e) => {
      const entry = this._tileGrid?.open ? this._tileGrid.tiles.get(sessionId) : null;
      if (!entry || pressedOnControl || entry.renaming || !this._tilesMovable()) {
        e.preventDefault?.();
        return;
      }
      this._draggedTileId = sessionId;
      entry.el.classList.add('tile--dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        // Firefox starts no drag without data.
        e.dataTransfer.setData('application/x-codeman-tile', sessionId);
      }
    });
    header.addEventListener('dragend', () => this._endTileMoveDrag());
  },

  /**
   * A header drag is over (dropped, cancelled with Escape, dropped outside),
   * or its tile or the grid went mid-drag: forget it and clear what it
   * painted. The drop targets' highlight too: a cancelled drag does not
   * reliably send dragleave.
   */
  _endTileMoveDrag() {
    this._draggedTileId = null;
    const grid = this._tileGrid;
    for (const { el } of grid?.tiles.values() || []) el.classList.remove('tile--dragging', 'tile--drop-target');
    for (const slot of grid?.slots || []) slot.classList.remove('tile--drop-target');
  },

  /**
   * The header as a handle: `draggable` while the tile can move (not while a
   * tile is zoomed, alone, or being renamed), and its tooltip, the state and
   * how long ("working 3m") plus, while it can move, that it drags. Diffs on
   * the last English text, never the DOM (translated in zh-CN; see
   * _renderTileOverlay).
   */
  _paintTileHandle(entry) {
    const movable = this._tilesMovable();
    const title = [entry.stateLabel, movable ? 'Drag to move the tile' : ''].filter(Boolean).join('\n');
    if (entry.headerLabel !== title) {
      entry.headerLabel = title;
      entry.header.title = title;
    }
    const draggable = movable && !entry.renaming ? 'true' : 'false';
    if (entry.header.getAttribute('draggable') !== draggable) entry.header.setAttribute('draggable', draggable);
  },

  /**
   * Refreshes one tile's header from the session: dot state, harness logo,
   * name, model, the hover label ("working 3m") and the `needs` border. Diffs on existing nodes only,
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
    entry.stateLabel = row ? [row.pill, since].filter(Boolean).join(' ') : '';
    this._paintTileHandle(entry);
    // The input of a rename in progress has taken the name's place in the
    // header, so updating the detached name never touches what is being typed.
    // A rename still in flight shows as already done, as on the tab.
    const name =
      this._inlineRenamePending?.get(sessionId) || this.getSessionName?.(session) || session.name || 'Session';
    if (entry.name.textContent !== name) entry.name.textContent = name;
    this._paintSessionHarness(entry, session, 'tile-harness');
    // A permission prompt is visible across the room.
    entry.el.classList.toggle('tile--needs', state === 'needs');
    this._renderTileOverlay(sessionId);
  },

  /** Every tile's header (after a tab render, i.e. any session change). */
  _renderTileChrome() {
    const grid = this._tileGrid;
    if (!grid?.open) return;
    for (const [id, entry] of grid.tiles) {
      this._renderTileHeader(id);
      // A pane that started after the tile connected (a session Run made
      // while the grid is open, an Attach from elsewhere) was spawned at the
      // server's default size: the tile's own resize went out before there
      // was a PTY to take it, and Run's resize measures the parked main
      // terminal (nothing). Keyed on the sessions map, so a handleInit after
      // an SSE drop is seen too; a render skipped during an inline tab rename
      // is caught up by the rename's own render.
      const pid = this.sessions.get(id)?.pid ?? null;
      if (pid !== null && pid !== entry.pid) entry.tile.paneStarted?.();
      entry.pid = pid;
    }
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
    // No drag from the header while its input is in it (_paintTileHandle).
    this._paintTileHandle(entry);
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
    // A click in the input is not the header's click, which would focus the
    // terminal away from it.
    input.addEventListener('click', (e) => e.stopPropagation());
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

  /**
   * Starts a tile's terminal and socket (TerminalTile.connect builds the xterm
   * synchronously, then loads through the grid's queue). Once per tile. A
   * focus that selected this tile before its terminal existed lands now.
   */
  _connectTile(sessionId) {
    const grid = this._tileGrid;
    const entry = grid?.tiles.get(sessionId);
    if (!entry || entry.connected) return;
    entry.connected = true;
    entry.tile.connect().catch(() => {
      /* Best-effort, as the split's Pane B: live output arrives once the socket opens. */
    });
    if (grid.focusOnConnect === sessionId) {
      grid.focusOnConnect = null;
      entry.tile.terminal?.focus();
    }
  },

  /**
   * Opening the grid: the tiles' terminals are built one per animation frame,
   * in `order` (the focused tile first), instead of all of them inside the
   * click. Building six xterms took about 100 ms of the click's 140 ms before
   * the first frame; paced, the click paints its empty frames in about 20 ms
   * and the entrance plays while the terminals are built. Nothing waits for
   * it: the load queue serves one capture at a time anyway, so only the
   * focused tile's connect is on its critical path, one frame later. Each
   * tile still fits once, at its final size (laid out before any connect),
   * and sends one PTY resize. A tile removed, replaced or already connected
   * meanwhile is skipped; a grid closed (or opened again) meanwhile stops it.
   */
  _connectTilesPaced(order) {
    const grid = this._tileGrid;
    const run = (grid.paceRun = (grid.paceRun || 0) + 1);
    const step = (k) => {
      if (!grid.open || grid.paceRun !== run || k >= order.length) return;
      this._connectTile(order[k]);
      requestAnimationFrame(() => step(k + 1));
    };
    requestAnimationFrame(() => step(0));
  },

  /**
   * A tile's socket stopped for good. 4009 (the session exited) keeps the tile
   * with its "session ended" marker; 4003 (refused), 4004 (session gone) and
   * 4010 (another socket took over) remove it. Nobody here asked for that, so
   * the neighbour takes focus without the keyboard (`focus: false`): what the
   * user is typing never lands in another session's PTY.
   */
  _onTileExit(sessionId, tile, code) {
    if (this._tileGrid?.tiles.get(sessionId)?.tile !== tile) return;
    // The session exited: the tile stays, with the Attach overlay over it.
    if (code === 4009) {
      this._renderTileOverlay(sessionId);
      return;
    }
    this.removeTile(sessionId, { focus: false });
  },

  /**
   * Columns x rows for the current tile count, applied to the grid section.
   * The shape comes from the count alone; within it each tile sits in its
   * cell (grid.cells) and any cell may be empty. When the shape changes, the
   * cells follow fitTileCells (each tile keeps its row and column if all fit,
   * else the tiles pack in reading order).
   */
  _applyTileLayout() {
    const grid = this._tileGrid;
    const section = this._tileGridSection();
    const { cols, rows, fits } = this._tileShapeFor(grid.ids.length);
    grid.cells = window.CodemanTileGrid.fitTileCells(grid.cells, grid.cols, cols, rows);
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
    this._syncTileZoom(zoomed);
    // Moving is off while a tile is zoomed or alone: the headers say so.
    for (const entry of grid.tiles.values()) this._paintTileHandle(entry);
    // Zoomed: one cell; the other tiles stay connected but hidden (CSS), so
    // they measure nothing and send no resize. Otherwise every tile is placed
    // explicitly in its cell, with a divider track between columns and between
    // rows, and every empty cell holds a drop slot.
    section.style.gridTemplateColumns = zoomed ? 'minmax(0, 1fr)' : tileGridTracks(grid.colFr);
    section.style.gridTemplateRows = zoomed ? 'minmax(0, 1fr)' : tileGridTracks(grid.rowFr);
    const holes = [];
    grid.cells.forEach((id, k) => {
      if (!id) {
        holes.push(k);
        return;
      }
      const el = grid.tiles.get(id)?.el;
      if (!el) return;
      el.style.gridColumn = id === zoomed ? '1' : String(2 * (k % cols) + 1);
      el.style.gridRow = id === zoomed ? '1' : String(2 * Math.floor(k / cols) + 1);
    });
    this._syncTileDividers(zoomed ? 0 : cols, zoomed ? 0 : rows);
    this._syncTileSlots(zoomed ? [] : holes, cols);
    this._persistTileGrid();
  },

  // Each tile's zoom state: the zoomed one is shown alone (CSS), and every ⤢
  // button says what pressing it does next.
  _syncTileZoom(zoomed) {
    for (const [id, entry] of this._tileGrid.tiles) {
      const on = id === zoomed;
      entry.el.classList.toggle('tile--zoomed', on);
      const zoomBtn = entry.zoomBtn;
      if (!zoomBtn) continue;
      zoomBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const label = on ? 'Restore the grid' : 'Zoom this tile';
      // Against the last English label, never the DOM (translated in zh-CN).
      if (entry.zoomLabel !== label) {
        entry.zoomLabel = label;
        zoomBtn.title = label;
        zoomBtn.setAttribute('aria-label', label);
      }
    }
  },

  // The empty cells of a layout that is not full (3 tiles in a 2x2, 5 in a
  // 3x2), wherever they are: drop targets for a tab (it joins there) and for a
  // tile (it moves there). Each slot knows its cell (`data-cell`).
  _syncTileSlots(holes, cols) {
    const grid = this._tileGrid;
    grid.slots ||= [];
    while (grid.slots.length > holes.length) grid.slots.pop().remove();
    while (grid.slots.length < holes.length) {
      const slot = document.createElement('div');
      slot.className = 'tile-slot';
      slot.textContent = 'Drop a tab or a tile here';
      this._acceptTabDrops(slot, (draggedId) => this.dropSessionOnSlot(draggedId, Number(slot.dataset.cell)));
      this._tileGridSection().appendChild(slot);
      grid.slots.push(slot);
    }
    grid.slots.forEach((slot, i) => {
      const k = holes[i];
      slot.dataset.cell = String(k);
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
    grid.cells.forEach((id, k) => {
      if (!id) return;
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
    // Not while it still glows: on every skin but OG the glow is `animation:
    // none`, so animationend never comes and each tile focus used to leave
    // another listener behind on the tab (49 after 50 focus changes).
    if (activeTab && !activeTab.classList.contains('tab-glow')) {
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
    // A tile whose terminal is not built yet (the grid just opened, paced)
    // takes it as soon as it is (_connectTile).
    this._noteFocusedTile(entry.tile);
    grid.focusOnConnect = null;
    if (options.focus !== false) {
      if (entry.connected) entry.tile.terminal?.focus();
      else grid.focusOnConnect = sessionId;
    }
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
      // The cells, null for an empty one, so a hole comes back where it was
      // (sanitizeTileGridState; a build before cells drops the nulls and reads
      // the tiles packed, as it always did).
      ids: grid.cells.slice(),
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
   * is putting it back, so no idle alert is spent. `ids` is the set to open,
   * the stored one by default (a reload); the Tiles button passes it trimmed
   * or filled to the remembered count, a shape change the cell model's rule
   * handles (reformTileCells).
   */
  _openStoredTileGrid(stored, ids = stored.ids) {
    const focus = stored.zoomed || stored.focused;
    // The stored set (an open split closes without joining it, decision 8,
    // case a), trimmed or filled to the count by the caller.
    if (!this.openTileGrid(ids, { focusedId: focus, auto: true, mergeSplit: false })) return false;
    const grid = this._tileGrid;
    const T = window.CodemanTileGrid;
    // openTileGrid packed the tiles from the first cell. The stored tiles go
    // back to their cells (a session gone since leaves its cell empty): as
    // they were when this is the stored set in the shape it was stored with,
    // otherwise by the cell model's rule, the tiles the count adds filling the
    // empty cells in reading order, holes first.
    const storedCells = (stored.cells || []).map((id) => (id && grid.tiles.has(id) ? id : null));
    const kept = storedCells.filter(Boolean);
    const sameSet = ids.length === stored.ids.length && ids.every((id) => stored.ids.includes(id));
    const cells = sameSet
      ? storedCells
      : T.reformTileCells(
          storedCells,
          T.tileCellCols(storedCells.length),
          kept,
          grid.ids.filter((id) => !kept.includes(id)),
          grid.cols,
          grid.rows
        );
    if (cells.length === grid.cols * grid.rows && cells.filter(Boolean).length === grid.tiles.size) {
      grid.cells = cells;
    }
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
    // Stored as it was read, holes included (`ids` carries the cells).
    const { cells, ...rest } = stored;
    try {
      localStorage.setItem(TILE_GRID_STORAGE_KEY, JSON.stringify({ ...rest, ids: cells, open: false }));
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
    // which the single view's reconnect never does. The app's choice, so DOM
    // focus stays put (an open modal or text field keeps the keyboard).
    if (!grid.has(grid.focusedId)) this._selectTiledSession(grid.ids[0], { auto: true, focus: false });
    for (const { tile } of grid.tiles.values()) tile.reconnectNow();
    return true;
  },
});

// A tiled session deleted (here or elsewhere) loses its tile; if it held focus,
// the neighbouring tile takes it (`auto`: the app chose, so no idle alert is
// spent; `focus: false`: the keyboard stays put, so what the user was typing
// never goes on into the neighbour's PTY, as the single view sends it
// nowhere). Done BEFORE the original handler, so activeSessionId no longer names
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
      this._selectTiledSession(neighbor, { auto: true, focus: false });
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
