/**
 * @fileoverview Entrance animations for the things that appear when work
 * starts: session TABS, the main TERMINAL pane a session's CLI runs in, floating
 * agent WINDOWS, the CONNECTION LINES tying a window back to its parent tab, and
 * the TILES of the tile grid (tile-grid.js). One picker per surface, plus themes
 * that set all five to a matching look.
 *
 * Everything is OFF by default (the `legacy` theme), so an untouched install
 * behaves exactly as it did before this module existed. Opt in via App Settings
 * → Appearance → Entrance Animations.
 *
 * Four constraints shape the design:
 *
 * 1. `_fullRenderSessionTabs()` replaces the tab strip's entire innerHTML, and
 *    `_updateConnectionLinesImmediate()` does `svg.innerHTML = ''` and rebuilds
 *    every path. Both run constantly while sessions and agents are spawning, so
 *    an animating tab or line element is DESTROYED mid-flight. Those two are
 *    therefore tracked by id in `_tabEnterActive` / `_lineEnterActive` and
 *    re-applied to the fresh element with a NEGATIVE animation-delay, resuming at
 *    the same offset instead of restarting or snapping to the end. Windows are
 *    stable DOM and need none of this.
 * 2. Connection-line geometry comes from `getBoundingClientRect()` on the window.
 *    A window entrance that starts with a transform would move that rect, so the
 *    `beam` style (which must hold still while its line draws toward it) animates
 *    opacity and filter only. Every other style refreshes the lines when it ends.
 * 3. The terminal pane is ONE shared element, so its entrance is marked at
 *    session creation but played at selection: a session created in the
 *    background must not animate the pane the user is currently looking at. Its
 *    styles are also restricted to transform/opacity/clip-path (see below), with
 *    `blur` the one documented exception - a filter is the only thing that
 *    actually blurs a live xterm; styles.css carries the measurement and the
 *    three alternatives that do not work.
 * 4. Nothing may animate on page load or reconnect replay. Only ids that pass
 *    through `markSessionTabEntering()` animate, and `_tabEnterSeen` makes that
 *    once-per-id even though the POST response and the SSE event both call
 *    `_onSessionCreated`.
 *
 * Tiles are off by default (`settle`, the grid's own quick fade, exactly as
 * before) and switched on in App Settings → Appearance → Tile Animations, or
 * preset by a theme. A styled tile plays in two beats that combine two
 * surfaces. The FRAME enters as it mounts, in its own style
 * (TILE_ANIM_STYLES); the SCREEN plays the terminal pane's style when its
 * first capture lands (`.tile-body.term-enter`, the same keyframes as the main
 * pane). The load queue serves one capture at a time, so
 * the screens light up one after another, the focused tile first. The frame
 * styles move transform and opacity only (six tiles animate at once; a blur
 * belongs to the serialized screen beat), and each has its own way out on the
 * closing grid's still copy. A reload restores with `settle` whatever the
 * setting.
 *
 * Styles are selected by `data-tab-anim` / `data-term-anim` / `data-win-anim` /
 * `data-line-anim` / `data-tile-anim` on <html>; the keyframes live in
 * styles.css. `?animlab=1` opens a floating picker that fakes tabs, a pane
 * replay, a window and a line, and replays the tile grid in place, so styles
 * can be compared without spawning real sessions or agents.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (tab render pipeline), subagent-windows.js (window + line hooks),
 *   tile-grid.js (tile mount, reveal and still-copy hooks)
 * @dependency constants.js (escapeHtml)
 * @loadorder 12.6 of 16, after webview-tabs.js, before ralph-wizard.js
 */

/** Tab entrance styles. `key` doubles as the `data-tab-anim` value. */
const TAB_ANIM_STYLES = [
  { key: 'slide', label: 'Slide', blurb: 'Drifts in from the right.', duration: 380 },
  { key: 'pop', label: 'Pop', blurb: 'Springs past full size, then settles.', duration: 460 },
  { key: 'crt', label: 'CRT', blurb: 'Snaps open as a hot line, then unfolds.', duration: 520 },
  { key: 'unroll', label: 'Unroll', blurb: 'The strip makes room and the tab widens in.', duration: 480 },
  { key: 'boot', label: 'Boot', blurb: 'Flickers on under a green scan sweep.', duration: 720 },
  { key: 'flip', label: 'Flip', blurb: 'Drops in as a card hinged on its top edge.', duration: 520 },
  { key: 'blur', label: 'Blur', blurb: 'Focus-pulls in as the blur fades off it.', duration: 440 },
  { key: 'off', label: 'Off', blurb: 'Tabs just appear.', duration: 0 },
];

/**
 * Window entrance styles. `fly` is the pre-existing behaviour (the window flies
 * out of its parent tab via a JS transition in subagent-windows.js); every other
 * style positions the window at its resting spot and runs a CSS animation there.
 */
const WIN_ANIM_STYLES = [
  { key: 'fly', label: 'Fly from tab', blurb: 'Current behaviour: flies out of the tab, scaling up.', duration: 400 },
  { key: 'crt', label: 'CRT', blurb: 'Bursts open as a hot line, then unfolds vertically.', duration: 560 },
  { key: 'materialize', label: 'Materialize', blurb: 'Resolves out of a blur with a short glitch.', duration: 620 },
  { key: 'unfold', label: 'Unfold', blurb: 'Hinges down from its top edge in 3D.', duration: 560 },
  { key: 'beam', label: 'Beam down', blurb: 'Waits for its line to reach it, then materializes.', duration: 620 },
  { key: 'pop', label: 'Pop', blurb: 'Springs open from its centre.', duration: 460 },
  { key: 'blur', label: 'Blur', blurb: 'Focus-pulls in as the blur fades off it.', duration: 560 },
  { key: 'off', label: 'Off', blurb: 'Windows just appear.', duration: 0 },
];

/** Connection-line entrance styles. `key` doubles as the `data-line-anim` value. */
const LINE_ANIM_STYLES = [
  { key: 'draw', label: 'Draw', blurb: 'Draws itself from the tab down to the window.', duration: 420 },
  { key: 'packet', label: 'Packet', blurb: 'Line fades in, then a bright packet runs down it.', duration: 700 },
  { key: 'fade', label: 'Fade', blurb: 'Simply fades in.', duration: 300 },
  { key: 'blur', label: 'Blur', blurb: 'Focus-pulls in as the blur fades off it.', duration: 380 },
  { key: 'off', label: 'Off', blurb: 'Lines just appear.', duration: 0 },
];

/**
 * Main-terminal entrance styles: the pane a session's CLI actually runs in.
 *
 * ⚠ These may only animate transform, opacity and clip-path. xterm's FitAddon
 * derives rows/cols from `getComputedStyle(parent).width/height`, which reports
 * the untransformed layout box, so transforms are safe, but animating width,
 * height or padding would feed wrong dimensions into `resize()` and through to
 * the PTY. Colour washes go on `.terminal-container::before`, never a `filter`
 * on the container: that would blur a full-screen WebGL canvas every frame.
 */
const TERM_ANIM_STYLES = [
  { key: 'crt', label: 'CRT', blurb: 'Power-on: a hot line that expands to full height.', duration: 560 },
  { key: 'wipe', label: 'Wipe', blurb: 'Reveals top-to-bottom behind a bright edge.', duration: 520 },
  { key: 'slide', label: 'Slide up', blurb: 'Rises into place from below.', duration: 420 },
  { key: 'fade', label: 'Fade', blurb: 'Quiet fade with a touch of scale.', duration: 340 },
  { key: 'blur', label: 'Blur', blurb: 'Focus-pulls in as the blur lifts off the pane.', duration: 520 },
  { key: 'off', label: 'Off', blurb: 'Current behaviour: the pane just appears.', duration: 0 },
];

/**
 * Tile grid entrance styles, for each tile's FRAME (its screen plays the
 * TERM_ANIM_STYLES style once content lands). Transform and opacity only, plus
 * a wash on ::before: FitAddon reads the untransformed layout box, so a tile
 * still fits once at its final size (#464). `stagger` is the default gap
 * between tiles and `order` the default cascade: `reading` (row by row),
 * `wave` (diagonals from the top left) or `ripple` (outward from the focused
 * tile). `from`: the tile is measured against a source after layout (its tab,
 * the Tiles button), so it is held one frame and timed by _runTileEntrances.
 */
// prettier-ignore
const TILE_ANIM_STYLES = [
  { key: 'settle', label: 'Off (default)', blurb: "The grid's own quick fade and settle.", duration: 180, stagger: 24, order: 'reading' },
  { key: 'fly', label: 'Fly from tab', blurb: 'Each tile flies out of its session tab, and back into it on close.', duration: 560, stagger: 55, order: 'reading', from: 'tab' },
  { key: 'deal', label: 'Deal', blurb: 'Dealt out of the Tiles button like cards, gathered back on close.', duration: 600, stagger: 75, order: 'reading', from: 'button' },
  { key: 'crt', label: 'CRT', blurb: 'Powers on as a hot line; switches off to a dot on close.', duration: 560, stagger: 70, order: 'wave' },
  { key: 'beam', label: 'Beam down', blurb: 'A beam draws down from its tab, then the tile materializes.', duration: 620, stagger: 90, order: 'reading', from: 'tab' },
  { key: 'cascade', label: 'Cascade', blurb: 'Swings down from its top edge in a diagonal wave.', duration: 600, stagger: 80, order: 'wave' },
  { key: 'pop', label: 'Pop', blurb: 'Springs open, rippling out from the focused tile.', duration: 480, stagger: 70, order: 'ripple' },
  { key: 'soft', label: 'Soft', blurb: 'Drifts in slowly, rippling out from the focused tile.', duration: 620, stagger: 60, order: 'ripple' },
  { key: 'off', label: 'None', blurb: 'Tiles just appear.', duration: 0, stagger: 0, order: 'reading' },
];

/** Cascade orders for the tile grid; `auto` is each style's own. */
const TILE_ANIM_ORDERS = [
  { key: 'auto', label: 'Style default' },
  { key: 'reading', label: 'Reading order' },
  { key: 'wave', label: 'Diagonal wave' },
  { key: 'ripple', label: 'Ripple from focus' },
];

/** How long a `beam` window waits before materializing. Just under the line draw. */
const BEAM_HOLD_MS = 360;

/** Gap between tiles leaving, in reading order, so the last copy ends last. */
const TILE_EXIT_STAGGER_MS = 35;

/** Tile exit durations per style (styles.css `tile-leave-*`); the rest use the default fade. */
const TILE_EXIT_MS = { fly: 460, deal: 520, crt: 520, beam: 480, cascade: 480, pop: 380, soft: 520 };

/** One-click combinations that read as a single look. */
const ANIM_THEMES = [
  { key: 'terminal', label: 'Terminal', tab: 'crt', win: 'crt', line: 'draw', term: 'crt', tile: 'crt' },
  { key: 'beamdown', label: 'Beam down', tab: 'crt', win: 'beam', line: 'draw', term: 'wipe', tile: 'beam' },
  { key: 'launch', label: 'Launch', tab: 'pop', win: 'fly', line: 'packet', term: 'fade', tile: 'fly' },
  { key: 'softfocus', label: 'Soft focus', tab: 'blur', win: 'blur', line: 'blur', term: 'blur', tile: 'soft' },
  { key: 'quiet', label: 'Quiet', tab: 'slide', win: 'materialize', line: 'fade', term: 'fade', tile: 'settle' },
  { key: 'playful', label: 'Playful', tab: 'pop', win: 'pop', line: 'packet', term: 'slide', tile: 'deal' },
  { key: 'legacy', label: 'Legacy', tab: 'off', win: 'fly', line: 'off', term: 'off', tile: 'settle' },
];

/**
 * The surfaces a theme is recognised by. A theme also PRESETS the tile style
 * when it is picked, but the tile style is its own setting (App Settings →
 * Appearance → Tile Animations, off by default), so changing it afterwards
 * does not turn the theme into "Custom".
 */
const ANIM_SURFACES = ['tab', 'win', 'line', 'term'];

/**
 * Defaults are the `legacy` theme: every entrance OFF, and agent windows on the
 * `fly` behaviour Codeman already had before this module existed. So a user who
 * never opens the picker sees exactly the pre-existing UI, and each mark/apply
 * hook short-circuits on its first line. Opt in via App Settings → Appearance →
 * Entrance Animations, which persists to the localStorage keys below.
 */
const TAB_ANIM_DEFAULT = 'off';
const WIN_ANIM_DEFAULT = 'fly';
const LINE_ANIM_DEFAULT = 'off';
const TERM_ANIM_DEFAULT = 'off';
/** The grid's own fade and settle, unchanged for anyone who never picks a theme. */
const TILE_ANIM_DEFAULT = 'settle';
const TILE_ANIM_ORDER_DEFAULT = 'auto';
const TAB_ANIM_STAGGER_DEFAULT = 90;
/** A new id joins the current cascade if it arrives within this of the last one. */
const TAB_ANIM_BATCH_WINDOW_MS = 600;

const ANIM_KEYS = {
  tab: 'codeman:tabAnim',
  win: 'codeman:winAnim',
  line: 'codeman:lineAnim',
  term: 'codeman:termAnim',
  tile: 'codeman:tileAnim',
  tileOrder: 'codeman:tileAnimOrder',
  termSwitch: 'codeman:termAnimOnSwitch',
  stagger: 'codeman:tabAnimStagger',
  speed: 'codeman:tabAnimSpeed',
};

Object.assign(CodemanApp.prototype, {
  // ── Setup ─────────────────────────────────────────────────────────────────

  /** Resolve every style/timing and stamp them on <html>. Called once at startup. */
  initEntranceAnimations() {
    this._tabEnterSeen = new Set();
    this._tabEnterActive = new Map();
    this._lineEnterActive = new Map();
    this._tabEnterBatchIndex = 0;
    this._tabEnterLastMarkTs = 0;

    const params = new URLSearchParams(location.search);
    // ?tabanim= / ?winanim= / ?lineanim= win for a single load, so a style can be
    // tried without persisting over whatever is saved.
    const pick = (param, styles, storeKey, fallback) => {
      const fromUrl = params.get(param);
      if (styles.some((s) => s.key === fromUrl)) return fromUrl;
      return this._animRead(storeKey, fallback);
    };

    this.setTabAnimStyle(pick('tabanim', TAB_ANIM_STYLES, ANIM_KEYS.tab, TAB_ANIM_DEFAULT), { persist: false });
    this.setWinAnimStyle(pick('winanim', WIN_ANIM_STYLES, ANIM_KEYS.win, WIN_ANIM_DEFAULT), { persist: false });
    this.setLineAnimStyle(pick('lineanim', LINE_ANIM_STYLES, ANIM_KEYS.line, LINE_ANIM_DEFAULT), { persist: false });
    this.setTermAnimStyle(pick('termanim', TERM_ANIM_STYLES, ANIM_KEYS.term, TERM_ANIM_DEFAULT), { persist: false });
    // Off (the grid's own `settle`) until chosen: a theme saved before tiles
    // were a surface gives them nothing new.
    this.setTileAnimStyle(pick('tileanim', TILE_ANIM_STYLES, ANIM_KEYS.tile, TILE_ANIM_DEFAULT), { persist: false });
    this.setTileAnimOrder(this._animRead(ANIM_KEYS.tileOrder, TILE_ANIM_ORDER_DEFAULT), { persist: false });
    this.setTermAnimOnSwitch(this._animRead(ANIM_KEYS.termSwitch, '0') === '1', { persist: false });

    this.setTabAnimStagger(Number(this._animRead(ANIM_KEYS.stagger, TAB_ANIM_STAGGER_DEFAULT)), { persist: false });
    this.setAnimSpeed(Number(this._animRead(ANIM_KEYS.speed, 1)), { persist: false });

    if (params.get('animlab') === '1' || params.get('tabanimlab') === '1') this.openAnimLab();
  },

  _animRead(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null || raw === '' ? fallback : raw;
    } catch {
      return fallback;
    }
  },

  _animWrite(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* private mode / quota, the in-memory value still applies for this load */
    }
  },

  _setAnimStyle(prop, key, styles, fallback, attr, storeKey, persist) {
    const style = styles.some((s) => s.key === key) ? key : fallback;
    this[prop] = style;
    document.documentElement.setAttribute(attr, style);
    if (persist) this._animWrite(storeKey, style);
    // Keep the lab's highlight honest when a style is set from anywhere other
    // than the lab's own buttons (a theme, a URL param, the console).
    this._syncAnimLab?.();
  },

  setTabAnimStyle(key, { persist = true } = {}) {
    // prettier-ignore
    this._setAnimStyle('_tabAnimStyle', key, TAB_ANIM_STYLES, TAB_ANIM_DEFAULT, 'data-tab-anim', ANIM_KEYS.tab, persist);
  },

  setWinAnimStyle(key, { persist = true } = {}) {
    // prettier-ignore
    this._setAnimStyle('_winAnimStyle', key, WIN_ANIM_STYLES, WIN_ANIM_DEFAULT, 'data-win-anim', ANIM_KEYS.win, persist);
  },

  setLineAnimStyle(key, { persist = true } = {}) {
    // prettier-ignore
    this._setAnimStyle('_lineAnimStyle', key, LINE_ANIM_STYLES, LINE_ANIM_DEFAULT, 'data-line-anim', ANIM_KEYS.line, persist);
  },

  setTermAnimStyle(key, { persist = true } = {}) {
    // prettier-ignore
    this._setAnimStyle('_termAnimStyle', key, TERM_ANIM_STYLES, TERM_ANIM_DEFAULT, 'data-term-anim', ANIM_KEYS.term, persist);
  },

  setTileAnimStyle(key, { persist = true } = {}) {
    // prettier-ignore
    this._setAnimStyle('_tileAnimStyle', key, TILE_ANIM_STYLES, TILE_ANIM_DEFAULT, 'data-tile-anim', ANIM_KEYS.tile, persist);
  },

  /** The tile cascade: `auto` (the style's own) or a TILE_ANIM_ORDERS key. */
  setTileAnimOrder(key, { persist = true } = {}) {
    this._tileAnimOrder = TILE_ANIM_ORDERS.some((o) => o.key === key) ? key : TILE_ANIM_ORDER_DEFAULT;
    if (persist) this._animWrite(ANIM_KEYS.tileOrder, this._tileAnimOrder);
    this._syncAnimLab?.();
  },

  /** Replay the terminal entrance on every tab switch, not just on a new session. */
  setTermAnimOnSwitch(on, { persist = true } = {}) {
    this._termAnimOnSwitch = !!on;
    if (persist) this._animWrite(ANIM_KEYS.termSwitch, on ? '1' : '0');
    this._syncAnimLab?.();
  },

  /** Apply a theme: one look across tabs, windows, lines and the terminal. */
  setAnimTheme(themeKey) {
    const theme = ANIM_THEMES.find((t) => t.key === themeKey);
    if (!theme) return;
    this.setTabAnimStyle(theme.tab);
    this.setWinAnimStyle(theme.win);
    this.setLineAnimStyle(theme.line);
    this.setTermAnimStyle(theme.term);
    this.setTileAnimStyle(theme.tile);
    this._syncEntranceAnimSetting?.();
  },

  /** The current style of each surface, keyed as ANIM_SURFACES. */
  _currentAnimStyles() {
    return {
      tab: this._tabAnimStyle,
      win: this._winAnimStyle,
      line: this._lineAnimStyle,
      term: this._termAnimStyle,
      tile: this._tileAnimStyle,
    };
  },

  /** The theme matching the current tab, window, line and pane styles, or 'custom' for a lab mix. */
  currentAnimTheme() {
    const current = this._currentAnimStyles();
    const match = ANIM_THEMES.find((t) => ANIM_SURFACES.every((k) => t[k] === current[k]));
    return match ? match.key : 'custom';
  },

  // ── App Settings picker ───────────────────────────────────────────────────
  //
  // Wired straight to setAnimTheme() rather than through saveAppSettings(): the
  // styles live in their own localStorage keys, so they stay per-device and never
  // reach `PUT /api/settings`, whose schema is .strict() and would reject them.

  _syncEntranceAnimSetting() {
    const sel = document.getElementById('appSettingsEntranceAnim');
    if (sel) {
      sel.value = this.currentAnimTheme();
      if (!sel.dataset.bound) {
        sel.dataset.bound = '1';
        sel.addEventListener('change', () => {
          // 'custom' is a readout of a lab mix, not something you can select into.
          if (sel.value === 'custom') sel.value = this.currentAnimTheme();
          else this.setAnimTheme(sel.value);
        });
      }
    }
    // Tile Animations: its own row, off (`settle`) by default. A theme picked
    // above presets it; picked here, it applies to tiles alone.
    const tileSel = document.getElementById('appSettingsTileAnim');
    if (tileSel) {
      tileSel.value = this._tileAnimStyle || TILE_ANIM_DEFAULT;
      if (!tileSel.dataset.bound) {
        tileSel.dataset.bound = '1';
        tileSel.addEventListener('change', () => {
          this.setTileAnimStyle(tileSel.value);
          this._syncEntranceAnimSetting();
        });
      }
    }
  },

  setTabAnimStagger(ms, { persist = true } = {}) {
    const value = Number.isFinite(ms) ? Math.max(0, Math.min(400, Math.round(ms))) : TAB_ANIM_STAGGER_DEFAULT;
    this._tabAnimStagger = value;
    if (persist) this._animWrite(ANIM_KEYS.stagger, value);
  },

  setAnimSpeed(multiplier, { persist = true } = {}) {
    const value = Number.isFinite(multiplier) ? Math.max(0.25, Math.min(3, multiplier)) : 1;
    this._animSpeed = value;
    // Every keyframe block reads this, so one variable retimes all of them.
    document.documentElement.style.setProperty('--anim-enter-scale', String(1 / value));
    if (persist) this._animWrite(ANIM_KEYS.speed, value);
  },

  _styleDuration(styles, key) {
    return (styles.find((s) => s.key === key)?.duration || 0) / (this._animSpeed || 1);
  },

  _tabAnimDuration() {
    return this._styleDuration(TAB_ANIM_STYLES, this._tabAnimStyle);
  },

  _winAnimDuration() {
    return this._styleDuration(WIN_ANIM_STYLES, this._winAnimStyle);
  },

  _lineAnimDuration() {
    return this._styleDuration(LINE_ANIM_STYLES, this._lineAnimStyle);
  },

  _termAnimDuration() {
    return this._styleDuration(TERM_ANIM_STYLES, this._termAnimStyle);
  },

  _tileAnimDuration() {
    return this._styleDuration(TILE_ANIM_STYLES, this._tileAnimStyle);
  },

  // ── Tabs ──────────────────────────────────────────────────────────────────

  /** Queue a session id to animate on its next render. Idempotent per id. */
  markSessionTabEntering(id) {
    if (!id || this._tabAnimStyle === 'off') return;
    if (!this._tabEnterSeen) return; // initEntranceAnimations() has not run yet
    if (this._tabEnterSeen.has(id)) return;
    this._tabEnterSeen.add(id);

    const now = performance.now();
    // A launch landing well after the previous one starts its own cascade rather
    // than inheriting a large stale offset.
    if (now - this._tabEnterLastMarkTs > TAB_ANIM_BATCH_WINDOW_MS) this._tabEnterBatchIndex = 0;
    this._tabEnterLastMarkTs = now;

    this._tabEnterActive.set(id, {
      startTs: now,
      staggerMs: this._tabEnterBatchIndex * this._tabAnimStagger,
    });
    this._tabEnterBatchIndex += 1;
  },

  /** Attach (or resume) the entrance animation on freshly rendered tabs. */
  _applyTabEntrances() {
    const active = this._tabEnterActive;
    if (!active || active.size === 0) return;
    if (this._tabAnimStyle === 'off') {
      active.clear();
      return;
    }

    const container = this.$('sessionTabs');
    if (!container) return;

    const now = performance.now();
    const duration = this._tabAnimDuration();

    for (const [id, state] of active) {
      const elapsed = now - state.startTs;
      // Ran to completion while the element was detached, nothing left to show.
      if (elapsed > state.staggerMs + duration + 50) {
        active.delete(id);
        continue;
      }

      const tab = container.querySelector(`.session-tab[data-id="${CSS.escape(id)}"]`);
      if (!tab) continue; // not rendered yet; a later render picks it up
      // Already running on this element. Re-stamping the delay would jump it, and
      // the incremental render path can reach here for the same element.
      if (tab.classList.contains('tab-enter')) continue;

      // Negative delay resumes mid-animation, so an unrelated re-render mid-cascade
      // does not restart the tab or make it snap.
      tab.style.setProperty('--tab-enter-delay', `${state.staggerMs - elapsed}ms`);
      tab.classList.add('tab-enter');
      const done = () => {
        tab.classList.remove('tab-enter');
        tab.style.removeProperty('--tab-enter-delay');
        this._tabEnterActive?.delete(id);
      };
      tab.addEventListener('animationend', done, { once: true });
      tab.addEventListener('animationcancel', done, { once: true });
    }
  },

  // ── Main terminal ─────────────────────────────────────────────────────────

  /**
   * Queue the terminal pane to animate the first time this session is shown.
   * Marked at creation but PLAYED at selection, because the pane is one shared
   * element: a session created in the background must not animate the pane the
   * user is currently looking at.
   */
  markTerminalEntering(id) {
    if (!id || this._termAnimStyle === 'off') return;
    if (!this._termEnterPending) this._termEnterPending = new Set();
    this._termEnterPending.add(id);
  },

  /** Play the terminal entrance for `sessionId`, if it is owed one. */
  playTerminalEntrance(sessionId) {
    const style = this._termAnimStyle || TERM_ANIM_DEFAULT;
    if (style === 'off') return;

    const owed = sessionId && this._termEnterPending?.delete(sessionId);
    if (!owed && !this._termAnimOnSwitch) return;

    const el = this.$('terminalContainer');
    if (!el) return;

    // Restart cleanly when switching tabs faster than the animation runs.
    el.classList.remove('term-enter');
    void el.offsetWidth;
    el.classList.add('term-enter');

    clearTimeout(this._termEnterTimer);
    const done = () => {
      el.classList.remove('term-enter');
      clearTimeout(this._termEnterTimer);
    };
    el.addEventListener('animationend', done, { once: true });
    el.addEventListener('animationcancel', done, { once: true });
    // Backstop: a backgrounded tab never fires animationend, which would leave
    // the pane stuck at its 0% keyframe (invisible) when you come back to it.
    this._termEnterTimer = setTimeout(done, this._termAnimDuration() + 900);
  },

  // ── Windows ───────────────────────────────────────────────────────────────

  /**
   * True when the window should be parked on its parent tab and flown to its
   * resting spot by subagent-windows.js. False for every CSS-animated style,
   * which needs the window to start at its final position.
   */
  windowEntranceFliesFromTab() {
    return (this._winAnimStyle || WIN_ANIM_DEFAULT) === 'fly';
  },

  /**
   * Run the window entrance on an already-positioned window.
   * @param {HTMLElement} win a .subagent-window or .ultracode-window
   */
  applyWindowEntrance(win) {
    if (!win) return;
    const style = this._winAnimStyle || WIN_ANIM_DEFAULT;
    if (style === 'off' || style === 'fly') return;

    // `beam` holds the window still (opacity/filter only) while its line draws
    // toward it, then materializes. Everything else starts immediately.
    if (style === 'beam') win.style.setProperty('--win-enter-delay', `${BEAM_HOLD_MS / (this._animSpeed || 1)}ms`);

    win.classList.add('win-enter');
    const done = () => {
      win.classList.remove('win-enter');
      win.style.removeProperty('--win-enter-delay');
      // A transformed window reports a transformed rect, so lines drawn while it
      // was animating are slightly off. Redraw once it has settled.
      this.updateConnectionLines?.();
    };
    win.addEventListener('animationend', done, { once: true });
    win.addEventListener('animationcancel', done, { once: true });
  },

  // ── Connection lines ──────────────────────────────────────────────────────

  /** Queue an agent's connection line to draw itself on the next line rebuild. */
  markConnectionLineEntering(agentId) {
    if (!agentId || this._lineAnimStyle === 'off') return;
    if (!this._lineEnterActive) return;
    if (this._lineEnterActive.has(agentId)) return;
    this._lineEnterActive.set(agentId, { startTs: performance.now() });
  },

  /**
   * Attach (or resume) the draw-in animation on freshly rebuilt paths. Called at
   * the end of `_updateConnectionLinesImmediate()`, which has just thrown away
   * and recreated every path element.
   */
  _applyLineEntrances(svg) {
    const active = this._lineEnterActive;
    if (!active || active.size === 0 || !svg) return;
    const style = this._lineAnimStyle || LINE_ANIM_DEFAULT;
    if (style === 'off') {
      active.clear();
      return;
    }

    const now = performance.now();
    const duration = this._lineAnimDuration();

    for (const [agentId, state] of active) {
      const elapsed = now - state.startTs;
      if (elapsed > duration + 50) {
        active.delete(agentId);
        continue;
      }

      const path = svg.querySelector(`path[data-agent-id="${CSS.escape(agentId)}"]`);
      if (!path) continue;

      const len = Math.max(1, Math.round(path.getTotalLength()));
      path.style.setProperty('--line-len', `${len}px`);
      path.style.setProperty('--line-enter-delay', `${-elapsed}ms`);
      path.classList.add('line-enter');

      // `packet` rides a bright dash ON TOP of the normal dashed line, so the base
      // line keeps its look instead of being taken over by the animation.
      if (style === 'packet') {
        const packet = path.cloneNode(false);
        packet.removeAttribute('data-agent-id');
        packet.setAttribute('class', 'connection-line-packet');
        packet.style.setProperty('--line-len', `${len}px`);
        packet.style.setProperty('--line-enter-delay', `${-elapsed}ms`);
        svg.appendChild(packet);
      }
    }
  },

  // ── Tile grid ─────────────────────────────────────────────────────────────

  /** The frame style a tile mounted now enters with (tile-grid.js _mountTile). */
  tileEntranceStyle() {
    return this._tileAnimStyle || TILE_ANIM_DEFAULT;
  },

  /**
   * Holds a just-mounted tile (`.tile--enter-hold`: invisible, not animating)
   * until the next frame, when its cell is final and _runTileEntrances can
   * order it and measure it against its source. `setBackstop(ms)` arms the
   * mount's own timer that ends the entrance should animationend never come
   * (a hidden browser tab, a zoomed grid hiding the tile); armed long at once,
   * so a frame that never comes cannot strand a tile invisible.
   */
  _stageTileEntrance(el, sessionId, setBackstop) {
    el.classList.add('tile--enter-themed', 'tile--enter-hold');
    (this._tileEnterQueue ||= []).push({ el, sessionId, setBackstop });
    setBackstop(4000);
    if (!this._tileEnterRaf) this._tileEnterRaf = requestAnimationFrame(() => this._runTileEntrances());
  },

  /**
   * One frame after the tiles mounted, every cell is final (openTileGrid packs,
   * then a stored grid moves its tiles back). Each held tile gets its delay
   * from the cascade order and, for `fly`/`deal`, the offset that starts it on
   * its tab or the Tiles button (FLIP: transform only, so the fit it already
   * did at its real size stands). `beam` draws its lines instead.
   */
  _runTileEntrances() {
    this._tileEnterRaf = 0;
    const queue = (this._tileEnterQueue || []).filter((q) => q.el.isConnected);
    this._tileEnterQueue = [];
    if (queue.length === 0) return;
    const def = TILE_ANIM_STYLES.find((s) => s.key === this._tileAnimStyle) || TILE_ANIM_STYLES[0];
    const speed = this._animSpeed || 1;
    const stagger = def.stagger / speed;
    const duration = this._tileAnimDuration();
    const hold = def.key === 'beam' ? BEAM_HOLD_MS / speed : 0;
    const order = this._tileAnimOrder && this._tileAnimOrder !== 'auto' ? this._tileAnimOrder : def.order;
    const ranks = this._tileEnterRanks(
      queue.map((q) => q.sessionId),
      order
    );
    const beams = [];
    queue.forEach((item, k) => {
      const { el, sessionId } = item;
      const delay = ranks[k] * stagger;
      el.style.setProperty('--tile-enter-delay', `${Math.round(delay + hold)}ms`);
      if (def.from) {
        const to = el.getBoundingClientRect();
        const from = this._tileSourceRect(def.from, sessionId);
        if (from && to.width > 0 && to.height > 0) {
          if (def.key === 'beam') beams.push({ from, to, delay });
          else this._setTileFlight(el, from, to, def.key, ranks[k], '--tile-from');
          if (def.from === 'tab') this._flashTileSourceTab(sessionId, delay);
        }
      }
      el.classList.remove('tile--enter-hold');
      // When the frame lands, for a screen whose content arrives earlier.
      el._tileEnterEndsAt = performance.now() + delay + hold + duration;
      item.setBackstop(delay + hold + duration + 900);
    });
    if (beams.length > 0) this._drawTileBeams(beams);
  },

  /**
   * Cascade steps for `ids` (tiles in this batch) by their cells: `reading`
   * row by row, `wave` by diagonal (row + column), `ripple` by distance from
   * the focused tile. Equal keys share a step, so a diagonal lands together.
   */
  _tileEnterRanks(ids, order) {
    const grid = this._tileGrid;
    const cols = Math.max(1, grid?.cols || 1);
    const cellOf = (id) => (Array.isArray(grid?.cells) ? grid.cells.indexOf(id) : -1);
    const pos = ids.map((id, k) => {
      const c = cellOf(id);
      return c < 0 ? { cell: k, row: 0, col: k } : { cell: c, row: Math.floor(c / cols), col: c % cols };
    });
    let keys;
    if (order === 'wave') {
      keys = pos.map((p) => p.row + p.col);
    } else if (order === 'ripple') {
      const f = cellOf(grid?.focusedId);
      const fr = f < 0 ? 0 : Math.floor(f / cols);
      const fc = f < 0 ? 0 : f % cols;
      keys = pos.map((p) => Math.abs(p.row - fr) + Math.abs(p.col - fc));
    } else {
      keys = pos.map((p) => p.cell);
    }
    const steps = [...new Set(keys)].sort((a, b) => a - b);
    return keys.map((v) => steps.indexOf(v));
  },

  /** On-screen rect of a tile's source: its session tab (`tab`), else the Tiles button. */
  _tileSourceRect(kind, sessionId) {
    const visible = (node) => {
      const r = node?.getBoundingClientRect?.();
      if (!r || !(r.width > 0 && r.height > 0)) return null;
      return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth ? r : null;
    };
    if (kind === 'tab') {
      const tab = document.querySelector(`.session-tab[data-id="${CSS.escape(sessionId)}"]`);
      const r = visible(tab);
      if (r) return r;
    }
    return visible(document.querySelector('.btn-tile-grid'));
  },

  /**
   * The transform that puts a tile laid out at `to` onto `from`, as custom
   * properties `<prefix>-x/-y/-sx/-sy/-rot` for the keyframes: the tab's own
   * size for `fly` (it grows out of it), a small card turned a little for
   * `deal`.
   */
  _setTileFlight(el, from, to, kind, rank, prefix) {
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let sx;
    let sy;
    let rot = 0;
    if (kind === 'deal') {
      sx = sy = clamp((from.width * 1.6) / to.width, 0.04, 0.3);
      rot = [-14, 10, -7, 13, -11, 8][rank % 6];
    } else {
      sx = clamp(from.width / to.width, 0.02, 1);
      sy = clamp(from.height / to.height, 0.02, 1);
    }
    el.style.setProperty(`${prefix}-x`, `${Math.round(dx)}px`);
    el.style.setProperty(`${prefix}-y`, `${Math.round(dy)}px`);
    el.style.setProperty(`${prefix}-sx`, sx.toFixed(4));
    el.style.setProperty(`${prefix}-sy`, sy.toFixed(4));
    el.style.setProperty(`${prefix}-rot`, `${rot}deg`);
  },

  /** The tab a tile leaves from glows as it goes (`fly`, `beam`). */
  _flashTileSourceTab(sessionId, delay) {
    const tab = document.querySelector(`.session-tab[data-id="${CSS.escape(sessionId)}"]`);
    if (!tab) return;
    tab.style.setProperty('--tab-launch-delay', `${Math.round(delay)}ms`);
    tab.classList.remove('tab-launch');
    void tab.offsetWidth;
    tab.classList.add('tab-launch');
    const onEnd = (e) => {
      if (e.target === tab && /^tab-launch/.test(e.animationName || '')) done();
    };
    const done = () => {
      clearTimeout(timer);
      tab.removeEventListener('animationend', onEnd);
      tab.classList.remove('tab-launch');
      tab.style.removeProperty('--tab-launch-delay');
    };
    const timer = setTimeout(done, delay + 900);
    tab.addEventListener('animationend', onEnd);
  },

  /**
   * `beam`: a line draws from each tile's tab (or the Tiles button) down into
   * the middle of its tile, in the connection-line look, with a packet riding it
   * when the line style is `packet`; the tile materializes as it lands. Its
   * own overlay: the agent lines' one is rebuilt from scratch on every redraw.
   * The overlay goes once every line has faded.
   */
  _drawTileBeams(beams) {
    const ns = 'http://www.w3.org/2000/svg';
    let svg = document.getElementById('tileBeamLines');
    if (!svg) {
      svg = document.createElementNS(ns, 'svg');
      svg.id = 'tileBeamLines';
      svg.setAttribute('class', 'connection-lines-svg tile-beam-lines');
      svg.setAttribute('aria-hidden', 'true');
      document.body.appendChild(svg);
    }
    const packet = this._lineAnimStyle === 'packet';
    let last = 0;
    for (const { from, to, delay } of beams) {
      const x1 = from.left + from.width / 2;
      const y1 = from.bottom;
      // Into the tile's middle: its top edge sits right under the tab strip,
      // so a beam aimed there ran sideways along the strip instead of down.
      const x2 = to.left + to.width / 2;
      const y2 = to.top + to.height / 2;
      const midY = (y1 + y2) / 2;
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
      path.setAttribute('class', 'connection-line tile-beam-line');
      svg.appendChild(path);
      const len = Math.max(1, Math.round(path.getTotalLength()));
      path.style.setProperty('--line-len', `${len}px`);
      path.style.setProperty('--line-enter-delay', `${Math.round(delay)}ms`);
      if (packet) {
        const dot = path.cloneNode(false);
        dot.setAttribute('class', 'connection-line-packet');
        svg.appendChild(dot);
      }
      last = Math.max(last, delay);
    }
    clearTimeout(this._tileBeamTimer);
    this._tileBeamTimer = setTimeout(() => svg.remove(), last + 1500 / (this._animSpeed || 1));
  },

  /**
   * A tile's screen lights up when its first capture lands (tile-grid.js load
   * queue), in the terminal pane's style: the same keyframes as the main pane,
   * on `.tile-body`. Transform, opacity and clip-path (and `blur`'s filter, one
   * tile at a time, since the queue serves one capture at a time), so the
   * xterm inside keeps its size and its fit.
   */
  playTileScreenEntrance(body) {
    if (!body || (this._termAnimStyle || TERM_ANIM_DEFAULT) === 'off') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    body._codemanScreenDone?.();
    // Content that lands while the frame is still flying in waits (held at
    // its first keyframe, so hidden) until the frame has nearly landed: two
    // beats, frame then screen, rather than both at once.
    const frame = body.closest?.('.tile');
    const endsAt = frame?.classList.contains('tile--entering') ? frame._tileEnterEndsAt || 0 : 0;
    const wait = Math.max(0, Math.round(endsAt - performance.now() - 120 / (this._animSpeed || 1)));
    body.style.setProperty('--tile-screen-delay', `${wait}ms`);
    body.classList.remove('term-enter');
    void body.offsetWidth;
    body.classList.add('term-enter');
    let timer = null;
    const done = (e) => {
      if (e && (e.target !== body || e.pseudoElement)) return;
      clearTimeout(timer);
      body.removeEventListener('animationend', done);
      body.removeEventListener('animationcancel', done);
      body.classList.remove('term-enter');
      body.style.removeProperty('--tile-screen-delay');
      if (body._codemanScreenDone === done) body._codemanScreenDone = null;
    };
    body._codemanScreenDone = done;
    body.addEventListener('animationend', done);
    body.addEventListener('animationcancel', done);
    // Backstop, as the main pane's: a backgrounded tab never fires animationend.
    timer = setTimeout(() => done(), wait + this._termAnimDuration() + 900);
  },

  /**
   * The closing grid's still copy (tile-grid.js _ghostTileGrid) leaves the
   * frame style's own way: `fly` back into each tab, `deal` gathered into the
   * Tiles button, `crt` switched off to a dot, and so on. Copies leave in
   * reading order, so the last one ends last (the layer goes on its
   * animationend). Re-forming the grid (`now`) keeps the plain fade: that copy
   * covers tiles that stay. Returns how long the slowest copy takes, for the
   * layer's fallback timer, or 0 for the default fade.
   */
  _stageTileExit(copies, { now = false } = {}) {
    const style = this._tileAnimStyle || TILE_ANIM_DEFAULT;
    const ms = TILE_EXIT_MS[style];
    if (now || !ms || copies.length === 0) return 0;
    const speed = this._animSpeed || 1;
    const def = TILE_ANIM_STYLES.find((s) => s.key === style);
    copies.forEach(({ ghost, el, sessionId }, k) => {
      ghost.style.setProperty('--tile-exit-delay', `${Math.round((k * TILE_EXIT_STAGGER_MS) / speed)}ms`);
      if (style !== 'fly' && style !== 'deal') return;
      const at = el.getBoundingClientRect();
      const target = this._tileSourceRect(def.from, sessionId);
      if (target && at.width > 0 && at.height > 0) this._setTileFlight(ghost, target, at, style, k, '--tile-to');
    });
    return (ms + copies.length * TILE_EXIT_STAGGER_MS) / speed + 250;
  },

  /**
   * Lab: replay the open grid's entrance IN PLACE (frames re-enter, screens
   * light up again in queue order): no remount, reconnect or resize. With the
   * grid closed it opens it, the real path.
   */
  _demoTiles() {
    const grid = this._tileGrid;
    if (!grid?.open) {
      if (this.canOpenTileGrid?.()) this.toggleTileGrid?.();
      else this.showToast?.('The tile grid needs a window at least 1180 px wide', 'info');
      return;
    }
    if (!this._tileMotionAllowed?.()) return;
    const ids = grid.ids.slice();
    ids.forEach((id, k) => {
      const entry = grid.tiles.get(id);
      if (entry) this._replayTileEntrance?.(entry.el, id, k);
    });
    // The screens, as the load queue would land them: focused first, then reading order.
    const speed = this._animSpeed || 1;
    const lead = Math.min(this._tileAnimDuration() * 0.55, 420);
    const order = [grid.focusedId, ...ids.filter((id) => id !== grid.focusedId)].filter(Boolean);
    clearTimeout(this._tileDemoTimer);
    const timers = order.map((id, k) =>
      setTimeout(() => this.playTileScreenEntrance(grid.tiles.get(id)?.body), lead + (k * 140) / speed)
    );
    this._tileDemoTimers?.forEach(clearTimeout);
    this._tileDemoTimers = timers;
  },

  /** Lab: close the grid with its exit, then open it again with its entrance (the real paths). */
  _demoTilesRoundTrip() {
    if (!this._tileGrid?.open) {
      this._demoTiles();
      return;
    }
    this.toggleTileGrid?.();
    clearTimeout(this._tileDemoTimer);
    this._tileDemoTimer = setTimeout(
      () => {
        if (!this._tileGrid?.open) this.toggleTileGrid?.();
      },
      1400 / (this._animSpeed || 1)
    );
  },

  // ── Lab (compare styles without spawning sessions or agents) ───────────────

  /** Floating picker: switch styles per surface and replay fake entrances. */
  openAnimLab() {
    if (document.getElementById('animLab')) return;

    const group = (title, styles, attr) => `
      <div class="anim-lab-group">
        <div class="anim-lab-group-title">${title}</div>
        ${styles
          .map(
            (s) => `<button type="button" class="anim-lab-style" data-attr="${attr}" data-style="${s.key}">
                 <strong>${escapeHtml(s.label)}</strong><em>${escapeHtml(s.blurb)}</em>
               </button>`
          )
          .join('')}
      </div>`;

    const panel = document.createElement('div');
    panel.id = 'animLab';
    panel.className = 'anim-lab';
    panel.innerHTML = `
      <div class="anim-lab-head">
        <span>Entrance lab</span>
        <button type="button" class="anim-lab-close" aria-label="Close">&times;</button>
      </div>
      <div class="anim-lab-themes">
        ${ANIM_THEMES.map((t) => `<button type="button" data-theme="${t.key}">${escapeHtml(t.label)}</button>`).join('')}
      </div>
      <div class="anim-lab-scroll">
        ${group('Tabs', TAB_ANIM_STYLES, 'tab')}
        ${group('Terminal pane', TERM_ANIM_STYLES, 'term')}
        <label class="anim-lab-check">
          <input type="checkbox" data-check="termSwitch"> Also on every tab switch
        </label>
        ${group('Agent windows', WIN_ANIM_STYLES, 'win')}
        ${group('Connection lines', LINE_ANIM_STYLES, 'line')}
        ${group('Tile grid (frames; screens use the pane style)', TILE_ANIM_STYLES, 'tile')}
        <label class="anim-lab-select">Tile order
          <select data-select="tileOrder">
            ${TILE_ANIM_ORDERS.map((o) => `<option value="${o.key}">${escapeHtml(o.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="anim-lab-range">Tab stagger <output data-out="stagger"></output>
        <input type="range" data-range="stagger" min="0" max="260" step="10">
      </label>
      <label class="anim-lab-range">Speed <output data-out="speed"></output>
        <input type="range" data-range="speed" min="0.5" max="2" step="0.1">
      </label>
      <div class="anim-lab-demo">
        <span>Replay</span>
        <button type="button" data-demo="tabs">Tabs</button>
        <button type="button" data-demo="term">Pane</button>
        <button type="button" data-demo="window">Window</button>
        <button type="button" data-demo="all">All</button>
      </div>
      <div class="anim-lab-demo">
        <span>Tiles</span>
        <button type="button" data-demo="tiles">Replay</button>
        <button type="button" data-demo="tiles-roundtrip">Close + reopen</button>
      </div>
      <p class="anim-lab-hint">Fake tabs, window and line, removed after the run. Real launches use the same timing.</p>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.anim-lab-close').addEventListener('click', () => this.closeAnimLab());
    panel.querySelectorAll('button[data-theme]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setAnimTheme(btn.dataset.theme);
        this._syncAnimLab();
        this.demoEntrance('all');
      });
    });
    panel.querySelectorAll('.anim-lab-style').forEach((btn) => {
      btn.addEventListener('click', () => {
        const { attr, style } = btn.dataset;
        if (attr === 'tab') this.setTabAnimStyle(style);
        else if (attr === 'win') this.setWinAnimStyle(style);
        else if (attr === 'term') this.setTermAnimStyle(style);
        else if (attr === 'tile') this.setTileAnimStyle(style);
        else this.setLineAnimStyle(style);
        this._syncAnimLab();
        this._syncEntranceAnimSetting?.();
        this.demoEntrance({ tab: 'tabs', term: 'term', tile: 'tiles' }[attr] || 'all');
      });
    });
    panel.querySelector('select[data-select="tileOrder"]').addEventListener('change', (e) => {
      this.setTileAnimOrder(e.target.value);
      this.demoEntrance('tiles');
    });
    panel.querySelector('input[data-check="termSwitch"]').addEventListener('change', (e) => {
      this.setTermAnimOnSwitch(e.target.checked);
    });
    panel.querySelectorAll('input[data-range]').forEach((input) => {
      input.addEventListener('input', () => {
        if (input.dataset.range === 'stagger') this.setTabAnimStagger(Number(input.value));
        else this.setAnimSpeed(Number(input.value));
        this._syncAnimLab();
      });
      input.addEventListener('change', () => this.demoEntrance('all'));
    });
    panel.querySelectorAll('button[data-demo]').forEach((btn) => {
      btn.addEventListener('click', () => this.demoEntrance(btn.dataset.demo));
    });

    this._syncAnimLab();
  },

  closeAnimLab() {
    document.getElementById('animLab')?.remove();
    this._clearEntranceDemo();
  },

  _syncAnimLab() {
    const panel = document.getElementById('animLab');
    if (!panel) return;
    const current = this._currentAnimStyles();
    panel.querySelectorAll('.anim-lab-style').forEach((btn) => {
      btn.classList.toggle('selected', current[btn.dataset.attr] === btn.dataset.style);
    });
    panel.querySelectorAll('button[data-theme]').forEach((btn) => {
      const t = ANIM_THEMES.find((x) => x.key === btn.dataset.theme);
      btn.classList.toggle('selected', !!t && ANIM_SURFACES.every((k) => t[k] === current[k]));
    });
    const order = panel.querySelector('select[data-select="tileOrder"]');
    if (order) order.value = this._tileAnimOrder || TILE_ANIM_ORDER_DEFAULT;
    const check = panel.querySelector('input[data-check="termSwitch"]');
    if (check) check.checked = !!this._termAnimOnSwitch;
    panel.querySelector('input[data-range="stagger"]').value = String(this._tabAnimStagger);
    panel.querySelector('output[data-out="stagger"]').textContent = `${this._tabAnimStagger}ms`;
    panel.querySelector('input[data-range="speed"]').value = String(this._animSpeed);
    panel.querySelector('output[data-out="speed"]').textContent = `${this._animSpeed.toFixed(1)}x`;
  },

  _clearEntranceDemo() {
    clearTimeout(this._animDemoTimer);
    clearTimeout(this._animDemoWindowTimer);
    document.querySelectorAll('.session-tab[data-demo]').forEach((el) => el.remove());
    document.querySelectorAll('.subagent-window[data-demo]').forEach((el) => el.remove());
    document.getElementById('animLabLines')?.remove();
  },

  /**
   * The demo line gets its OWN svg overlay rather than sharing #connectionLines.
   * That overlay is rebuilt from real windows via `svg.innerHTML = ''`, so a fake
   * path dropped into it is erased the moment anything triggers a redraw -
   * including the demo window's own entrance finishing.
   */
  _demoLineSvg() {
    let svg = document.getElementById('animLabLines');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'animLabLines';
      svg.setAttribute('class', 'connection-lines-svg');
      document.body.appendChild(svg);
    }
    return svg;
  },

  /** @param {'tabs'|'term'|'window'|'all'|'tiles'|'tiles-roundtrip'} what */
  demoEntrance(what = 'all') {
    this._clearEntranceDemo();

    if (what === 'tiles') return this._demoTiles();
    if (what === 'tiles-roundtrip') return this._demoTilesRoundTrip();
    // With the grid open, the "pane" is every tile's screen.
    if (what === 'term' && this._tileGrid?.open) return this._demoTiles();

    // The pane is a real, shared element rather than a throwaway, so replay it
    // through the same entry point a real launch uses (bypassing the owed-id
    // check, which only exists to keep background sessions from hijacking it).
    if (what === 'term' || what === 'all') {
      const wasOnSwitch = this._termAnimOnSwitch;
      this._termAnimOnSwitch = true;
      this.playTerminalEntrance(null);
      this._termAnimOnSwitch = wasOnSwitch;
    }
    if (what === 'term') return;

    const tabCount = what === 'window' ? 1 : 4;
    const tabs = this._demoTabs(tabCount);
    let total = Math.max(this._tabAnimDuration() + tabCount * this._tabAnimStagger, this._termAnimDuration());

    if (what !== 'tabs') {
      // Give the tab cascade a beat, so the window reads as coming out of it.
      const lead = what === 'all' ? Math.min(320, this._tabAnimStagger * 2) : 0;
      this._animDemoWindowTimer = setTimeout(() => this._demoWindow(tabs[0]), lead);
      total = Math.max(total, lead + this._winAnimDuration() + this._lineAnimDuration() + BEAM_HOLD_MS);
    }

    this._animDemoTimer = setTimeout(() => this._clearEntranceDemo(), total + 1800);
  },

  /** Append `count` throwaway tabs and run the tab entrance on them. */
  _demoTabs(count) {
    const container = this.$('sessionTabs');
    if (!container) return [];
    const made = [];
    const base = this.sessions?.size || 0;

    for (let i = 0; i < count; i++) {
      const tab = document.createElement('div');
      tab.className = 'session-tab';
      tab.dataset.demo = '1';
      tab.dataset.color = ['green', 'blue', 'purple', 'orange', 'pink', 'yellow', 'red'][i % 7];
      tab.innerHTML = `
        <span class="tab-number">${base + i + 1}</span>
        <span class="tab-status idle" aria-hidden="true"></span>
        <span class="tab-info"><span class="tab-name-row">
          <span class="tab-harness run-mode-dot claude" aria-hidden="true"></span>
          <span class="tab-name">w${base + i + 1}-demo</span>
        </span></span>`;
      container.appendChild(tab);
      made.push(tab);
      if (this._tabAnimStyle !== 'off') {
        tab.style.setProperty('--tab-enter-delay', `${i * this._tabAnimStagger}ms`);
        void tab.offsetWidth; // force layout so the class add starts a fresh run
        tab.classList.add('tab-enter');
      }
    }
    return made;
  },

  /** Append a throwaway agent window under `originTab`, plus its connection line. */
  _demoWindow(originTab) {
    const tabRect = originTab?.getBoundingClientRect();
    const win = document.createElement('div');
    win.className = 'subagent-window';
    win.dataset.demo = '1';
    win.style.width = '360px';
    win.style.height = '220px';
    win.style.left = `${Math.max(24, (tabRect?.left ?? 120) - 40)}px`;
    win.style.top = `${(tabRect?.bottom ?? 60) + 160}px`;
    win.style.zIndex = '1001';
    win.innerHTML = `
      <div class="subagent-window-header">
        <div class="subagent-window-title"><span class="icon">&#129302;</span><span class="id">demo-agent</span>
          <span class="status running">running</span></div>
      </div>
      <div class="subagent-window-body"><div class="subagent-empty">Preview window</div></div>`;
    document.body.appendChild(win);
    this.applyWindowEntrance(win);
    this._demoLine(tabRect, win);
  },

  /** Draw a fake tab→window line into the lab's own overlay and animate it. */
  _demoLine(tabRect, win) {
    if (!tabRect) return;
    const svg = this._demoLineSvg();
    const winRect = win.getBoundingClientRect();
    const x1 = tabRect.left + tabRect.width / 2;
    const y1 = tabRect.bottom;
    const x2 = winRect.left + winRect.width / 2;
    const y2 = winRect.top;
    const midY = (y1 + y2) / 2;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
    path.setAttribute('class', 'connection-line');
    path.dataset.demo = '1';
    svg.appendChild(path);

    if ((this._lineAnimStyle || LINE_ANIM_DEFAULT) === 'off') return;
    const len = Math.max(1, Math.round(path.getTotalLength()));
    path.style.setProperty('--line-len', `${len}px`);
    path.style.setProperty('--line-enter-delay', '0ms');
    path.classList.add('line-enter');

    if (this._lineAnimStyle === 'packet') {
      const packet = path.cloneNode(false);
      packet.setAttribute('class', 'connection-line-packet');
      packet.dataset.demo = '1';
      packet.style.setProperty('--line-len', `${len}px`);
      packet.style.setProperty('--line-enter-delay', '0ms');
      svg.appendChild(packet);
    }
  },
});
