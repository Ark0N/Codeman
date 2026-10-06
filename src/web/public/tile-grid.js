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
// Trailing debounce for refitting tiles after the grid area changes size, so a
// window drag sends each tile's PTY one resize, not one per frame.
const TILE_GRID_REFIT_MS = 150;
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
    this._tileGridRemembered = keepStored ? { ids, focusedId } : null;
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
    // The tabs drop their .in-tiles marker.
    this.renderSessionTabs?.();
    if (reselect) this._selectAfterTileGrid(focusedId);
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
   * The tile chord `e` asks for, if it applies right now, else null: the toggle
   * wherever a grid could open (or is open), the focus and remove chords only
   * while it is open, so outside the grid they reach the terminal untouched.
   * Registry-aware (rebinds and disables in App Settings, Shortcuts). The
   * capture handler (app.js) dispatches it; every xterm key handler returns
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
      if (spec.needsOpen ? open : open || this.canOpenTileGrid()) return shortcut.id;
      return null;
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
    const remembered = this._tileGridRemembered;
    const ids = (remembered?.ids || []).filter((id) => this.sessions.has(id) && !this.detachedSessions?.has(id));
    if (ids.length > 0) {
      this.openTileGrid(ids, { focusedId: remembered.focusedId, auto: true });
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
   * What the tile's body should say instead of a terminal, or '' for none: a
   * session with no PTY attached (pid null), an agent that exited in a live
   * pane (paneExit), or a socket the server closed because the session exited
   * (4009). Attach was just pressed: nothing, while the server catches up.
   */
  _tileAttachReason(sessionId, tile) {
    const session = this.sessions.get(sessionId);
    if (!session) return '';
    const pending = this._tileAttachPending?.get(sessionId);
    if (pending && Date.now() - pending < 15000) return '';
    const exited = typeof paneExitLabel === 'function' ? paneExitLabel(session.paneExit) : '';
    if (exited) return `The agent ${exited}`;
    if (session.pid === null) return 'Not attached';
    if (tile?._stoppedCode === 4009) return 'The session ended';
    return '';
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
      overlay.append(text, btn);
      entry.body.appendChild(overlay);
      entry.overlay = overlay;
      entry.overlayText = text;
      entry.overlayBtn = btn;
    }
    entry.overlay.hidden = false;
    const text = busy ? 'Attaching\u2026' : reason;
    if (entry.overlayText.textContent !== text) entry.overlayText.textContent = text;
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
      ok = !!res?.ok;
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
    // they measure nothing and send no resize.
    section.style.gridTemplateColumns = zoomed ? 'minmax(0, 1fr)' : `repeat(${cols}, minmax(0, 1fr))`;
    section.style.gridTemplateRows = zoomed ? 'minmax(0, 1fr)' : `repeat(${rows}, minmax(0, 1fr))`;
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
