// Phase 5 — Codeman integration entry point.
//
// This is the *consumer* layer that replaces `demo/tabs.ts` for the real
// Codeman dashboard. It is bundled (esbuild, MediaPipe included) into a single
// ESM file and served by Codeman from `/gesture/gesture-codeman.js`, loaded into
// the dashboard page when Codeman is started with `CODEMAN_GESTURE=1`.
//
// The gesture *core* (`../gesture/*`) is unchanged and transport-agnostic — it
// emits coordinate-only `grab`/`drag`/`drop`. Here we map those onto Codeman's
// real session tabs (`.session-tab[data-id]`) and toolbar buttons.
//
// Three interactions, all off the same pinch:
//   • Tab "grab-to-float" — pinch a session tab, *pull it out* of the strip (a
//     ghost follows your hand), release past a threshold → the session opens as
//     an in-page floating panel at the drop point; a small twitch-and-release
//     cancels (snaps back).
//   • Panel "re-grab" — pinch an existing floating panel and move it anywhere;
//     release over the tab strip to re-dock it (panel goes away, the tab stays).
//     This is the capability the old OS-window detach lost.
//   • Agent-window "grab-to-move" — pinch any floating *subagent* or *ultracode*
//     run/transcript window (the dashboard's own `.subagent-window` /
//     `.ultracode-window` floats) and move it anywhere. These windows stay owned
//     by app.js — we only nudge their `style.left/top` and ask app.js to redraw
//     the glowing connector line back to their session tab (its redraw reads live
//     rects, so the line tracks without us touching app.js internals). This is the
//     multi-monitor verb that lets these windows cross the physical monitor seam.
//   • Button "tap" — pinch over a toolbar button (Run / Run Shell) and release
//     in place → fires the button's real click handler. Drift too far first and
//     it's treated as a stray move, not a tap.
//   • Tile "grab-to-move": with the tile grid open, pinch anywhere on a tile
//     and carry it onto another tile (the two trade places) or an empty cell
//     (it moves there). With Detach Tiles on (App Settings, per device, off by
//     default) a tile let go OUTSIDE the grid opens as a window of its own.
//     A session TAB carried onto a tile or an empty cell joins the grid there,
//     as a mouse-dragged tab does. Every move goes through app.js's own paths
//     (tile-grid.js tileDropTargetAt / dropOnTileTarget / detachTileAtPoint), so
//     the hand and the mouse can never disagree about what a drop does.
//
// Why in-page floats, not OS-window detach (decided 2026-06-08, see
// docs/MULTIMONITOR_DESIGN.md): the hand only exists in the one page that owns
// the camera. `window.open`/`detachSession` puts the session in a sealed OS
// window the page can't hand-track — a detached session can never be moved
// again, a one-way trip. A floating panel (an iframe of the session's solo
// route `/session/:id`) stays in this page's DOM, so the hand keeps control:
// re-grab, move across the (spanned) viewport, drop, re-dock. The OS-window
// detach is kept for later as a *separate, deliberate* verb — no longer the pinch.

import { GestureController } from '../gesture/GestureController.ts';
import type { HandState } from '../gesture/types.ts';

declare global {
  interface Window {
    __codemanGesture?: GestureBridge;
    /** The Codeman dashboard singleton (app.js, `window.app`). The gesture layer
     *  reaches into it to redraw the floating-window connector lines and bump a
     *  grabbed window's z-order while moving the subagent / ultracode windows.
     *  Loosely typed — only the few members we touch. */
    app?: {
      updateConnectionLines?: () => void;
      saveSubagentWindowStates?: () => void;
      subagentWindowZIndex?: number;
      ultracodeWindowZIndex?: number;
      // The tile grid (tile-grid.js). All optional: an older dashboard without
      // them simply has no tile verbs for the hand.
      tileAtPoint?: (x: number, y: number) => string | null;
      canGrabTile?: (id: string) => boolean;
      tileDropTargetAt?: (x: number, y: number, draggedId: string) => TileTarget | null;
      dropOnTileTarget?: (draggedId: string, target: TileTarget) => boolean;
      isOverTileGrid?: (x: number, y: number) => boolean;
      tileDetachEnabled?: () => boolean;
      detachTileAtPoint?: (id: string, x: number, y: number, at?: { offsetX: number; offsetY: number }) => boolean;
    };
  }
}

const TAB_SELECTOR = '.session-tab';
/** A tile of the open tile grid (tile-grid.js), keyed by `data-session-id`. */
const TILE_SELECTOR = '#tileGrid .tile';
/** An in-page floating session panel this layer spawned — re-grabbable to move. */
const PANEL_SELECTOR = '.cg-float';
/** The dashboard's own floating agent windows (subagent runs + ultracode run and
 *  transcript windows). All three carry one of these classes, position via
 *  `style.left/top`, and redraw their connector line from
 *  `window.app.updateConnectionLines()` — so the hand can pick one up and move it
 *  without app.js knowing. (`.ultracode-agent-window` also carries
 *  `.ultracode-window`, so this matches it too.) */
const WINDOW_SELECTOR = '.subagent-window, .ultracode-window';
/** The session-tab strip; dropping a moved panel over it re-docks the session. */
const DOCK_SELECTOR = '.session-tabs';
/** Toolbar buttons a pinch can "tap": Run (#runBtn → app.run()) and Run Shell
 *  (.btn-shell → app.runShell()). Pinch over one and release in place to fire
 *  it. Extend this list to expose more buttons to the gesture layer. */
const CLICK_SELECTOR = '#runBtn, .btn-shell';
const Z = 2147483000; // above the dashboard, below nothing that matters at the desk
/** Floating-panel size (px). Fixed for the MVP; resize is a later affordance. */
const FLOAT_W = 640;
const FLOAT_H = 420;
/** Minimum pull distance (px) from the grab point before a release floats the
 *  tab out. Below this it's an accidental pinch and the tab snaps back. */
const DETACH_PULL_PX = 70;
/** If a button-pinch drifts more than this, it's a stray move, not a tap. */
const TAP_CANCEL_PX = 45;
/** How far (px) a grabbed tile must travel before it targets anything: a pinch
 *  that barely moves is a stray one, and the tile stays where it is. */
const TILE_MOVE_PX = 40;
/** The width (px) of the small copy of a grabbed tile that follows the hand. */
const TILE_GHOST_W = 280;

/** First letter colours: cyan left, violet right; green while pinching. */
const handColor = (handedness: string, pinching: boolean): string =>
  pinching ? '#4ade80' : handedness === 'Right' ? '#a78bfa' : '#38bdf8';

/** Where a session carried by the hand would land in the tile grid: another
 *  tile, or an empty cell (tile-grid.js tileDropTargetAt). */
type TileTarget = { kind: 'tile'; id: string; el: HTMLElement } | { kind: 'cell'; cell: number; el: HTMLElement };

/** A floating in-page session panel (an iframe of `/session/:id`) the hand can
 *  place and re-grab. Stays in this page's DOM, so it never leaves hand reach. */
interface FloatingPanel {
  id: string;
  /** The `.cg-float` container element. */
  el: HTMLElement;
}

/** Live state for one hand's in-progress grab — either a session *tab* being
 *  pulled out into a new float, or an existing *panel* being moved/re-docked. */
type Grab =
  | {
      kind: 'tab';
      id: string;
      tab: HTMLElement;
      ghost: HTMLElement;
      /** Grab origin in viewport px, to measure pull distance. */
      ox: number;
      oy: number;
      /** Pulled past the float-out threshold at least once. */
      armed: boolean;
      /** With the tile grid open: the tile or empty cell it would join (highlighted). */
      target: TileTarget | null;
    }
  | {
      /** A tile of the open grid, carried to another cell or (Detach Tiles)
       *  out of the grid. The tile itself never moves until the drop: it dims
       *  (`tile--dragging`, the mouse drag's own class) and a small copy of
       *  it follows the hand. */
      kind: 'tile';
      id: string;
      el: HTMLElement;
      ghost: HTMLElement;
      /** Where in the tile the hand closed, so a pop-out window lands under it. */
      offsetX: number;
      offsetY: number;
      ox: number;
      oy: number;
      /** Travelled past TILE_MOVE_PX at least once. */
      armed: boolean;
      /** The tile or empty cell it would drop onto (highlighted). */
      target: TileTarget | null;
      /** Outside the grid with Detach Tiles on: letting go opens a window. */
      out: boolean;
    }
  | {
      kind: 'panel';
      id: string;
      panel: FloatingPanel;
      /** Cursor→panel-top-left offset at grab, so it doesn't snap when re-grabbed. */
      dx: number;
      dy: number;
      /** Cursor currently over the tab strip → releasing re-docks. */
      overDock: boolean;
    }
  | {
      /** A dashboard-owned floating agent window (subagent / ultracode) being
       *  moved. We never remove or re-parent it — just reposition + redraw its
       *  connector. The element ref can go stale mid-grab (SSE reconnect tears
       *  ultracode windows down), so every move guards on `el.isConnected`. */
      kind: 'window';
      el: HTMLElement;
      /** Cursor→window-top-left offset at grab, so it doesn't snap. */
      dx: number;
      dy: number;
    };

/** Live state for one hand pinching a toolbar button (Run / Run Shell). */
interface Tap {
  el: HTMLElement;
  label: string;
  ox: number;
  oy: number;
}

class GestureBridge {
  private readonly surface: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly video: HTMLVideoElement;
  private readonly button: HTMLButtonElement;
  private readonly camBtn: HTMLButtonElement;
  private readonly status: HTMLSpanElement;
  private readonly gc: GestureController;
  private running = false;
  /** Camera view: full-viewport dimmed background, or small corner preview. */
  private camMode: 'full' | 'pip' = 'full';

  /** Per-hand in-progress grab (a tab being pulled out, or a panel being moved). */
  private grabs = new Map<string, Grab>();
  /** Per-hand in-progress button pinch (fires on release if it didn't drift). */
  private taps = new Map<string, Tap>();
  /** Live floating panels, keyed by session id (idempotent per id). */
  private floats = new Map<string, FloatingPanel>();
  /** rAF coalescing for connector-line redraws while dragging an agent window. */
  private connectorRedrawScheduled = false;

  constructor() {
    injectStyles();

    // Full-viewport, click-through surface so coords map straight to viewport
    // pixels and elementFromPoint() sees the tabs beneath, not our overlay.
    this.surface = el('div', 'cg-surface') as HTMLDivElement;
    this.canvas = el('canvas', 'cg-canvas') as HTMLCanvasElement;
    this.video = el('video', 'cg-preview') as HTMLVideoElement;
    this.video.muted = true;
    this.video.playsInline = true;
    this.applyCamMode();

    const dock = el('div', 'cg-dock');
    this.button = el('button', 'cg-btn') as HTMLButtonElement;
    this.button.textContent = '🖐 Gesture';
    this.camBtn = el('button', 'cg-btn cg-btn-icon') as HTMLButtonElement;
    this.camBtn.textContent = '⛶';
    this.camBtn.title = 'Toggle camera size (fullscreen / corner)';
    this.status = el('span', 'cg-status') as HTMLSpanElement;
    this.status.textContent = 'off';
    dock.append(this.button, this.camBtn, this.status);

    document.body.append(this.surface, this.video, this.canvas, dock);
    this.ctx = this.canvas.getContext('2d')!;
    this.sizeCanvas();
    window.addEventListener('resize', () => this.sizeCanvas());

    this.gc = new GestureController({
      video: this.video,
      surface: this.surface,
      numHands: 1,
      // Self-host the MediaPipe runtime + model from Codeman (same-origin) instead
      // of the CDN, so an ad/content blocker, offline desk, or strict browser
      // can't break startup (the CDN failure surfaced as `failed: {isTrusted}` —
      // a resource load-error Event). Served from public/gesture/.
      wasmBase: '/gesture/wasm',
      modelUrl: '/gesture/gesture_recognizer.task',
    });

    this.gc.on('grab', (p) => this.onGrab(p.hand, p.x, p.y));
    this.gc.on('drag', (p) => this.onDrag(p.hand, p.x, p.y));
    this.gc.on('drop', (p) => this.onDrop(p.hand, p.x, p.y));
    this.gc.on('status', ({ fps, hands }) => this.onStatus(fps, hands));

    this.button.addEventListener('click', () => void this.toggle());
    this.camBtn.addEventListener('click', () => this.toggleCamMode());
  }

  private async toggle(): Promise<void> {
    if (this.running) {
      this.gc.stop();
      this.running = false;
      this.cancelAllGrabs();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.button.classList.remove('on');
      this.status.textContent = 'off';
      return;
    }
    this.button.disabled = true;
    this.status.textContent = 'starting…';
    try {
      await this.gc.start();
      this.running = true;
      this.button.classList.add('on');
      this.status.textContent = 'on: pinch a tab, tile, window, or button';
    } catch (err) {
      // Surface the *real* cause: MediaPipe/Emscripten can throw a non-Error
      // (number/string), so `(err as Error).message` was logging "undefined".
      const msg = describeError(err);
      this.status.textContent = `failed: ${msg}`;
      this.status.title = msg;
      console.error('[gesture] start failed', err);
    } finally {
      this.button.disabled = false;
    }
  }

  private toggleCamMode(): void {
    this.camMode = this.camMode === 'full' ? 'pip' : 'full';
    this.applyCamMode();
  }

  private applyCamMode(): void {
    this.video.classList.toggle('cg-full', this.camMode === 'full');
    this.video.classList.toggle('cg-pip', this.camMode === 'pip');
  }

  /** Top-most element matching `sel` at a viewport point (overlays are
   *  click-through, so elementFromPoint sees the dashboard beneath). */
  private hitClosest(x: number, y: number, sel: string): HTMLElement | null {
    const hit = document.elementFromPoint(x, y);
    return (hit?.closest(sel) as HTMLElement | null) ?? null;
  }

  private onGrab(hand: string, x: number, y: number): void {
    // An existing floating panel → re-grab to move it (priority over tabs).
    // Make it click-through while held so elementFromPoint sees the dock zone
    // (and other content) beneath it, and it can't re-grab itself.
    const panelEl = this.hitClosest(x, y, PANEL_SELECTOR);
    const panelId = panelEl?.dataset.id;
    if (panelEl && panelId) {
      const float = this.floats.get(panelId);
      if (float) {
        const rect = panelEl.getBoundingClientRect();
        panelEl.style.pointerEvents = 'none';
        panelEl.classList.add('cg-float-grabbed');
        this.grabs.set(hand, {
          kind: 'panel',
          id: panelId,
          panel: float,
          dx: x - rect.left,
          dy: y - rect.top,
          overDock: false,
        });
        this.status.textContent = 'moving — drop over tabs to re-dock';
        return;
      }
    }

    // A dashboard-owned floating agent window (subagent / ultracode run or
    // transcript) → pick it up and move it. Priority below cg-float panels
    // (which sit far above), above tabs/buttons. We grab anywhere on the window
    // (not just its titlebar) since the hand is choosing the whole window.
    const win = this.hitClosest(x, y, WINDOW_SELECTOR);
    if (win) {
      const rect = win.getBoundingClientRect();
      // Match app.js's own drag: drop any bottom-anchor so left/top take effect.
      win.style.bottom = 'auto';
      win.classList.add('cg-win-grabbed');
      this.bringWindowToFront(win);
      this.grabs.set(hand, { kind: 'window', el: win, dx: x - rect.left, dy: y - rect.top });
      this.status.textContent = 'moving window';
      return;
    }

    // A tile of the open tile grid → carry it to another cell, or (Detach
    // Tiles) out of the grid. Anywhere on the tile: the hand is choosing the
    // whole tile, as with the agent windows. A tile that can do neither (alone
    // or zoomed, Detach Tiles off) is left alone, so the pinch falls through.
    const tileId = window.app?.tileAtPoint?.(x, y) ?? null;
    const tileEl = tileId ? this.hitClosest(x, y, TILE_SELECTOR) : null;
    if (tileId && tileEl && window.app?.canGrabTile?.(tileId)) {
      const rect = tileEl.getBoundingClientRect();
      const ghost = this.tileGhost(tileEl, rect);
      document.body.append(ghost);
      tileEl.classList.add('tile--dragging');
      this.grabs.set(hand, {
        kind: 'tile',
        id: tileId,
        el: tileEl,
        ghost,
        offsetX: Math.max(0, Math.min(x - rect.left, rect.width)),
        offsetY: Math.max(0, Math.min(y - rect.top, rect.height)),
        ox: x,
        oy: y,
        armed: false,
        target: null,
        out: false,
      });
      this.positionGhost(ghost, x, y);
      this.status.textContent = 'moving tile';
      return;
    }

    // A session tab → grab-and-pull-out into a floating panel (ghost follows).
    const tab = this.hitClosest(x, y, TAB_SELECTOR);
    const id = tab?.dataset.id;
    if (tab && id) {
      const rect = tab.getBoundingClientRect();
      const ghost = tab.cloneNode(true) as HTMLElement;
      ghost.classList.add('cg-ghost');
      ghost.removeAttribute('id');
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      document.body.append(ghost);

      tab.classList.add('cg-grabbed');
      this.grabs.set(hand, { kind: 'tab', id, tab, ghost, ox: x, oy: y, armed: false, target: null });
      this.positionGhost(ghost, x, y);
      return;
    }

    // A toolbar button (Run / Run Shell) → tap-to-fire on release.
    const btn = this.hitClosest(x, y, CLICK_SELECTOR);
    if (btn) {
      const label = (btn.textContent || btn.getAttribute('title') || 'button').trim();
      btn.classList.add('cg-tap-armed');
      this.taps.set(hand, { el: btn, label, ox: x, oy: y });
      this.status.textContent = `release to ${label.toLowerCase()}`;
    }
  }

  private onDrag(hand: string, x: number, y: number): void {
    const grab = this.grabs.get(hand);
    if (grab?.kind === 'tile') {
      this.positionGhost(grab.ghost, x, y);
      if (!grab.armed && Math.hypot(x - grab.ox, y - grab.oy) >= TILE_MOVE_PX) grab.armed = true;
      if (!grab.armed) return;
      const app = window.app;
      const target = app?.tileDropTargetAt?.(x, y, grab.id) ?? null;
      this.setTileTarget(grab, target);
      const out = !target && !!app?.tileDetachEnabled?.() && !app?.isOverTileGrid?.(x, y);
      grab.out = out;
      grab.ghost.classList.toggle('cg-armed', !!target);
      grab.ghost.classList.toggle('cg-out', out);
      this.status.textContent = target
        ? target.kind === 'tile'
          ? 'release to swap tiles'
          : 'release to move the tile here'
        : out
          ? 'release to open in a new window'
          : 'moving tile';
      return;
    }
    if (grab?.kind === 'tab') {
      this.positionGhost(grab.ghost, x, y);
      const pulled = Math.hypot(x - grab.ox, y - grab.oy) >= DETACH_PULL_PX;
      // The tile grid open: a tile or an empty cell under the hand takes the
      // tab there, as a mouse-dragged tab does.
      const target = pulled ? (window.app?.tileDropTargetAt?.(x, y, grab.id) ?? null) : null;
      const targetChanged = (target?.el ?? null) !== (grab.target?.el ?? null);
      this.setTileTarget(grab, target);
      if (pulled !== grab.armed || targetChanged) {
        grab.armed = pulled;
        grab.ghost.classList.toggle('cg-armed', pulled);
        this.status.textContent = target
          ? 'release to tile it here'
          : pulled
            ? 'release to float out'
            : 'on — pinch a tab';
      }
      return;
    }
    if (grab?.kind === 'panel') {
      this.moveFloat(grab.panel, x - grab.dx, y - grab.dy);
      const overDock = !!this.hitClosest(x, y, DOCK_SELECTOR);
      if (overDock !== grab.overDock) {
        grab.overDock = overDock;
        grab.panel.el.classList.toggle('cg-redock', overDock);
        this.status.textContent = overDock ? 'release to re-dock' : 'moving panel';
      }
      return;
    }
    if (grab?.kind === 'window') {
      this.moveWindow(grab.el, x - grab.dx, y - grab.dy);
      return;
    }
    // A button pinch that drifts too far is a stray move, not a tap — cancel it.
    const tap = this.taps.get(hand);
    if (tap && Math.hypot(x - tap.ox, y - tap.oy) > TAP_CANCEL_PX) {
      tap.el.classList.remove('cg-tap-armed');
      this.taps.delete(hand);
      this.status.textContent = 'on: pinch a tab, tile, window, or button';
    }
  }

  private onDrop(hand: string, x: number, y: number): void {
    const grab = this.grabs.get(hand);
    if (grab?.kind === 'tile') {
      this.grabs.delete(hand);
      grab.ghost.remove();
      grab.el.classList.remove('tile--dragging');
      this.setTileTarget(grab, null);
      const app = window.app;
      if (!grab.armed) {
        this.flash('cancelled');
        return;
      }
      // Asked again at the drop: the grid may have changed since the last frame.
      const target = app?.tileDropTargetAt?.(x, y, grab.id) ?? null;
      if (target) {
        this.flash(app?.dropOnTileTarget?.(grab.id, target) ? 'moved tile' : 'cancelled');
      } else if (grab.out && !app?.isOverTileGrid?.(x, y)) {
        // A window opened with no click behind it is what popup blockers stop:
        // detachSession then says so in a toast and the tile stays.
        const opened = app?.detachTileAtPoint?.(grab.id, x, y, { offsetX: grab.offsetX, offsetY: grab.offsetY });
        this.flash(opened ? 'opened in a new window' : 'pop-out blocked: allow popups for this site');
      } else {
        this.flash('cancelled');
      }
      return;
    }
    if (grab?.kind === 'tab') {
      this.grabs.delete(hand);
      grab.ghost.remove();
      grab.tab.classList.remove('cg-grabbed');
      this.setTileTarget(grab, null);
      const target = grab.armed ? (window.app?.tileDropTargetAt?.(x, y, grab.id) ?? null) : null;
      if (target) this.flash(window.app?.dropOnTileTarget?.(grab.id, target) ? 'tiled' : 'cancelled');
      else if (grab.armed) this.floatPanel(grab.id, x, y);
      else this.flash('cancelled');
      return;
    }
    if (grab?.kind === 'panel') {
      this.grabs.delete(hand);
      grab.panel.el.style.pointerEvents = ''; // interactive again (type into it)
      grab.panel.el.classList.remove('cg-float-grabbed', 'cg-redock');
      if (grab.overDock) this.redock(grab.id);
      else this.flash('placed');
      return;
    }
    if (grab?.kind === 'window') {
      this.grabs.delete(hand);
      grab.el.classList.remove('cg-win-grabbed');
      // Clear the coalescer so the final placement always redraws, even if a
      // mid-drag rAF was throttled (tab briefly backgrounded) and left it latched.
      this.connectorRedrawScheduled = false;
      this.redrawWindowConnectors();
      // Persist subagent-window positions like app.js's own drag end does
      // (a no-op for ultracode windows, which aren't position-persisted).
      try {
        window.app?.saveSubagentWindowStates?.();
      } catch {
        /* best-effort */
      }
      this.flash('placed window');
      return;
    }
    // Release over the same button → fire its real click handler.
    const tap = this.taps.get(hand);
    if (tap) {
      this.taps.delete(hand);
      tap.el.classList.remove('cg-tap-armed');
      tap.el.click(); // runs the button's onclick (app.run() / app.runShell())
      this.flash(tap.label.toLowerCase());
    }
  }

  /** Pop a session into an in-page floating panel (an iframe of its solo route)
   *  centered on the drop point. Unlike OS-window detach, the panel lives in
   *  this page's DOM, so the hand can re-grab and move it. Idempotent per id:
   *  re-floating an existing id just repositions the panel it already has. */
  private floatPanel(id: string, x: number, y: number): void {
    let float = this.floats.get(id);
    if (!float) {
      const container = el('div', 'cg-float');
      container.dataset.id = id;
      const bar = el('div', 'cg-float-bar');
      bar.textContent = `session ${id}`;
      const frame = el('iframe', 'cg-float-frame') as HTMLIFrameElement;
      frame.src = `/session/${encodeURIComponent(id)}`;
      frame.title = `Session ${id}`;
      container.append(bar, frame);
      document.body.append(container);
      float = { id, el: container };
      this.floats.set(id, float);
      this.flash('floated out');
    } else {
      this.flash('re-floated');
    }
    this.moveFloat(float, x - FLOAT_W / 2, y - FLOAT_H / 2);
  }

  /** Re-dock a floated session: drop its in-page panel. The original
   *  `.session-tab` was never removed, so the session is simply back to plain
   *  tab form. Mirrors Codeman's own `.detached` → attach toggle. */
  private redock(id: string): void {
    const float = this.floats.get(id);
    if (!float) return;
    float.el.remove();
    this.floats.delete(id);
    this.flash('re-docked');
  }

  /** Position a float by its top-left corner, clamped to stay on-screen. */
  private moveFloat(float: FloatingPanel, left: number, top: number): void {
    const l = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - FLOAT_W));
    const t = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - FLOAT_H));
    float.el.style.left = `${l}px`;
    float.el.style.top = `${t}px`;
  }

  /** Move a dashboard-owned agent window by its top-left, clamped on-screen, then
   *  redraw its connector line. The window self-positions via `style.left/top` and
   *  app.js's connector redraw reads live rects, so this tracks without touching
   *  app.js internals. Guards on `isConnected`: ultracode windows can be torn down
   *  (SSE reconnect / auto-close) while still held. Clamps to `innerWidth/Height`,
   *  which equals the *spanned* viewport in a multi-monitor window — so the window
   *  can still travel across the physical monitor seam, just not off-screen. */
  private moveWindow(el: HTMLElement, left: number, top: number): void {
    if (!el.isConnected) return;
    const w = el.offsetWidth || 380;
    const h = el.offsetHeight || 320;
    const l = Math.min(Math.max(4, left), Math.max(4, window.innerWidth - w - 4));
    const t = Math.min(Math.max(4, top), Math.max(4, window.innerHeight - h - 4));
    el.style.left = `${l}px`;
    el.style.top = `${t}px`;
    this.redrawWindowConnectors();
  }

  /** Ask app.js to redraw all connector lines (subagent + ultracode), coalesced to
   *  one per frame so per-frame drags don't thrash. `updateConnectionLines()` is
   *  itself debounced in app.js, but we rAF-gate too in case an older dashboard
   *  build isn't, and to no-op cleanly when app.js isn't present (standalone). */
  private redrawWindowConnectors(): void {
    if (this.connectorRedrawScheduled) return;
    this.connectorRedrawScheduled = true;
    requestAnimationFrame(() => {
      this.connectorRedrawScheduled = false;
      try {
        window.app?.updateConnectionLines?.();
      } catch {
        /* app.js may not expose it (standalone playground) */
      }
    });
  }

  /** Pop a grabbed window above its siblings using app.js's own z-counter, so a
   *  picked-up window comes to the front like a real focus. Cosmetic + best-effort. */
  private bringWindowToFront(el: HTMLElement): void {
    const app = window.app;
    if (!app) return;
    try {
      if (el.classList.contains('ultracode-window')) {
        app.ultracodeWindowZIndex = (app.ultracodeWindowZIndex ?? 1000) + 1;
        el.style.zIndex = String(app.ultracodeWindowZIndex);
      } else {
        app.subagentWindowZIndex = (app.subagentWindowZIndex ?? 1000) + 1;
        el.style.zIndex = String(app.subagentWindowZIndex);
      }
    } catch {
      /* cosmetic only */
    }
  }

  private positionGhost(ghost: HTMLElement, x: number, y: number): void {
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
  }

  /** A small copy of a tile to follow the hand: its header (a copy: no
   *  listeners come along) over an empty body, in the tile's proportions. */
  private tileGhost(tileEl: HTMLElement, rect: DOMRect): HTMLElement {
    const ghost = el('div', 'cg-ghost cg-tile-ghost');
    const width = Math.min(TILE_GHOST_W, rect.width);
    ghost.style.width = `${width}px`;
    ghost.style.height = `${Math.max(48, Math.round((width * rect.height) / Math.max(1, rect.width)))}px`;
    const header = tileEl.querySelector('.tile-header');
    if (header) {
      const copy = header.cloneNode(true) as HTMLElement;
      copy.removeAttribute('draggable');
      ghost.append(copy);
    }
    ghost.append(el('div', 'cg-tile-ghost-body'));
    return ghost;
  }

  /** Highlights the tile or empty cell a carried session would drop onto
   *  (the mouse drag's own `tile--drop-target`), clearing the last one. */
  private setTileTarget(grab: { target: TileTarget | null }, target: TileTarget | null): void {
    if (grab.target?.el !== target?.el) {
      grab.target?.el.classList.remove('tile--drop-target');
      target?.el.classList.add('tile--drop-target');
    }
    grab.target = target;
  }

  private cancelAllGrabs(): void {
    // Floats themselves persist (they're placed windows) — only release any
    // in-progress grab cleanly, restoring a moved panel's interactivity.
    for (const grab of this.grabs.values()) {
      if (grab.kind === 'tab') {
        grab.ghost.remove();
        grab.tab.classList.remove('cg-grabbed');
        this.setTileTarget(grab, null);
      } else if (grab.kind === 'tile') {
        grab.ghost.remove();
        grab.el.classList.remove('tile--dragging');
        this.setTileTarget(grab, null);
      } else if (grab.kind === 'panel') {
        grab.panel.el.style.pointerEvents = '';
        grab.panel.el.classList.remove('cg-float-grabbed', 'cg-redock');
      } else {
        grab.el.classList.remove('cg-win-grabbed');
      }
    }
    this.grabs.clear();
    for (const tap of this.taps.values()) tap.el.classList.remove('cg-tap-armed');
    this.taps.clear();
    document
      .querySelectorAll(`${TAB_SELECTOR}.cg-grabbed, .cg-tap-armed, .cg-win-grabbed`)
      .forEach((t) => t.classList.remove('cg-grabbed', 'cg-tap-armed', 'cg-win-grabbed'));
    document.querySelectorAll(`${TILE_SELECTOR}.tile--dragging`).forEach((t) => t.classList.remove('tile--dragging'));
  }

  private onStatus(fps: number, hands: HandState[]): void {
    // Draw per-hand cursor dots (green while pinching) so the user can aim.
    const { width, height } = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    this.ctx.clearRect(0, 0, width, height);
    const rect = this.surface.getBoundingClientRect();
    for (const h of hands) {
      const x = (1 - h.cursor.x) * rect.width;
      const y = h.cursor.y * rect.height;
      this.ctx.beginPath();
      this.ctx.arc(x * dpr, y * dpr, (h.pinching ? 14 : 9) * dpr, 0, Math.PI * 2);
      this.ctx.fillStyle = handColor(h.handedness, h.pinching);
      this.ctx.globalAlpha = 0.85;
      this.ctx.fill();
      this.ctx.globalAlpha = 1;
    }
    if (this.running && this.grabs.size === 0 && this.taps.size === 0) {
      this.status.textContent = `on · ${fps}fps`;
    }
  }

  private flash(msg: string): void {
    this.status.textContent = msg;
  }

  private sizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
  }
}

// ---- tiny helpers ------------------------------------------------------

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** Best-effort human-readable message for any thrown value (Error or not). */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'string') return err;
  if (typeof err === 'number') return `code ${err}`;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

function injectStyles(): void {
  if (document.getElementById('cg-styles')) return;
  const css = `
  .cg-surface, .cg-canvas { position: fixed; inset: 0; pointer-events: none; }
  .cg-surface { z-index: ${Z}; }
  .cg-canvas  { z-index: ${Z + 1}; width: 100vw; height: 100vh; }
  .cg-preview { transform: scaleX(-1); pointer-events: none; background: #000; }
  .cg-preview.cg-pip {
    position: fixed; right: 12px; bottom: 12px; width: 240px; height: 135px;
    object-fit: cover; border-radius: 8px; z-index: ${Z + 2};
    box-shadow: 0 4px 16px rgba(0,0,0,.5); opacity: 1;
  }
  .cg-preview.cg-full {
    position: fixed; inset: 0; width: 100vw; height: 100vh;
    object-fit: cover; opacity: .28; z-index: ${Z};
  }
  .cg-ghost {
    position: fixed; left: 0; top: 0; transform: translate(-50%, -50%) scale(1.06);
    z-index: ${Z + 2}; pointer-events: none; opacity: .92;
    box-shadow: 0 8px 28px rgba(0,0,0,.55); border-radius: 8px;
    outline: 2px solid #38bdf8; outline-offset: -2px;
  }
  .cg-ghost.cg-armed { outline-color: #4ade80; box-shadow: 0 8px 28px rgba(74,222,128,.5); }
  .cg-ghost.cg-out { outline-color: #fbbf24; box-shadow: 0 8px 28px rgba(251,191,36,.5); }
  .cg-tile-ghost {
    display: flex; flex-direction: column; overflow: hidden; transform: translate(-50%, -20%) scale(1);
    background: var(--term-bg, #161b23); border: 1px solid var(--border-color, #333);
  }
  .cg-tile-ghost > .tile-header { flex: 0 0 auto; }
  .cg-tile-ghost-body { flex: 1 1 auto; opacity: .5; }
  .cg-dock {
    position: fixed; right: 12px; bottom: 156px; z-index: ${Z + 3};
    display: flex; align-items: center; gap: 8px; font: 12px/1 system-ui, sans-serif;
  }
  .cg-btn {
    padding: 6px 12px; border-radius: 6px; border: 1px solid #3a3a40;
    background: #1b1b1f; color: #e5e5e7; cursor: pointer;
  }
  .cg-btn-icon { padding: 6px 9px; }
  .cg-btn.on { background: #16331f; border-color: #2f6b41; color: #4ade80; }
  .cg-status { color: #9aa0a6; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-tab.cg-grabbed { opacity: .35; outline: 2px dashed #4ade80; outline-offset: -2px; }
  .cg-tap-armed { outline: 2px solid #4ade80 !important; outline-offset: 2px; box-shadow: 0 0 0 4px rgba(74,222,128,.25) !important; }
  .subagent-window.cg-win-grabbed, .ultracode-window.cg-win-grabbed {
    outline: 2px solid #4ade80 !important; outline-offset: -2px;
    box-shadow: 0 12px 48px rgba(74,222,128,.5) !important;
  }
  .cg-float {
    position: fixed; left: 0; top: 0; width: ${FLOAT_W}px; height: ${FLOAT_H}px;
    z-index: ${Z}; display: flex; flex-direction: column; overflow: hidden;
    background: #0c0c0f; border-radius: 10px; outline: 2px solid #38bdf8;
    outline-offset: -2px; box-shadow: 0 10px 40px rgba(0,0,0,.6);
  }
  .cg-float.cg-float-grabbed { outline-color: #4ade80; box-shadow: 0 12px 48px rgba(74,222,128,.45); }
  .cg-float.cg-redock { outline-color: #fbbf24; box-shadow: 0 12px 48px rgba(251,191,36,.5); }
  .cg-float-bar {
    flex: 0 0 auto; padding: 4px 10px; font: 11px/1.6 system-ui, sans-serif;
    color: #cbd5e1; background: #15151a; border-bottom: 1px solid #2a2a30;
    user-select: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .cg-float-frame { flex: 1 1 auto; width: 100%; border: 0; background: #000; }
  `;
  const style = document.createElement('style');
  style.id = 'cg-styles';
  style.textContent = css;
  document.head.append(style);
}

// Idempotent bootstrap — re-importing must not stack overlays.
if (!window.__codemanGesture) {
  window.__codemanGesture = new GestureBridge();
}
