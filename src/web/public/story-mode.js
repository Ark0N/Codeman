/**
 * @fileoverview Story Mode: the active Claude Code session's turns drawn as comic pages, live.
 *
 * Opt-in header button (`showStoryButton`, per-device, default OFF; hidden on phones by mobile.css).
 * The overlay asks `GET /api/sessions/:id/story` for one turn as a page of panels (server:
 * src/story-mode.ts + src/web/routes/story-routes.ts) and redraws when the session shows activity:
 * the transcript tool events and the stop / prompt-submitted hooks (app.js connectSSE registers
 * them and calls `_storyOnActivity`), plus a slow poll while the turn is still running, since a
 * transcript line can land without any of those events. One request in flight at a time, debounced.
 *
 * Every panel is a canvas drawn by a small frame engine in the style of Remotion: a scene is a pure
 * function of its frame number, with `interpolate` and `spring` helpers. New panels animate in from
 * frame 0; panels that were already there keep their clock, so a live refresh never restarts them.
 * Under `prefers-reduced-motion` every panel is drawn once, at its finished frame.
 *
 * ⚠️ Everything on the page comes from the agent's transcript and is untrusted: it is written with
 * `textContent` only, and the containers carry `data-i18n-skip`. A file path opens through the
 * existing `openFilePreview()` (workspace confinement, attachment routes for outside paths, remote
 * hosts), never a new file route; editing goes through the file viewer's own edit mode.
 * ⚠️ The overlay owns Escape while it is open (a window capture listener runs before app.js's
 * document listener), one layer per press: a file preview opened from a panel, then the drawer,
 * then the overlay. A folder grid on top and a preview in edit mode keep their own keys.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (this.activeSessionId, this.sessions, this.loadAppSettingsFromStorage, this.getDefaultSettings)
 * @dependency api-client.js (_api), panels-ui.js (openFilePreview), constants.js (findFilePathLinks, resolveLinkedFilePath)
 * @loadorder 12.58 of 16, after git-status-ui.js, before entrance-animations.js
 */

/** Activity bursts (one tool call fires start and end) collapse into one refresh. */
const STORY_REFRESH_DEBOUNCE_MS = 800;
/** While a turn runs, refresh this often even without events (text lines raise none). */
const STORY_POLL_MS = 4000;
/** How often a finished newest page is checked for a turn no hook announced. */
const STORY_IDLE_POLL_MS = 15000;
/** A /story request that has not settled by then counts as failed, so the view never wedges. */
const STORY_REQUEST_TIMEOUT_MS = 30000;
/**
 * Widest stage a scene is drawn on, in virtual units. A panel stretched across a whole row keeps its
 * art together in a centered stage instead of spreading it to both ends; the background still fills it.
 */
const STORY_STAGE_MAX = 680;
/**
 * Redraw rates (frames per second). The clocks run in real time whatever the rate; only how often a
 * panel is repainted changes. An entrance plays smoothly, the newest panel of a running turn stays
 * lively, and a settled panel keeps its blinks and bobs at a fraction of the cost (measured: every
 * panel at display rate cost ~80% of a core with five panels on a 2x screen).
 */
const STORY_FPS_INTRO = 30;
/** Panel backgrounds kept for reuse (kind × size × palette). */
const STORY_BG_CACHE = 32;
/**
 * And at most this many bytes of them: rows grow with the window, and 32 backgrounds of a 1440p
 * screen at 2x came to 342 MB (a panel still showing one keeps it; only reuse is lost).
 */
const STORY_BG_CACHE_BYTES = 160e6;
/** Horizontal bands a new background is built in, one per frame. */
const STORY_BG_BANDS = 4;
const storyBgCache = new Map();
/** Milliseconds of drawing per frame; panels past it wait for the next frame (no long tasks). */
const STORY_FRAME_BUDGET_MS = 10;
/** Panels drawn per frame at most: the raster cost lands at paint time, where the JS budget cannot see it. */
const STORY_DRAWS_PER_FRAME = 2;
const STORY_FPS_LIVE = 15;
const STORY_FPS_SETTLED = 6;
/** A settled panel animates this long, then holds still until the pointer wakes it again. */
const STORY_SETTLED_AWAKE_MS = 20000;

/**
 * The comic engine: drawing kit, the agent character and one scene per panel kind. Pure drawing;
 * no DOM beyond the canvas it is handed. `hit()` records clickable regions in virtual units.
 */
const StoryArt = (() => {
  const FPS = 30;
  const HERO = 72;
  const VH = 260;
  const TAU = Math.PI * 2;
  const DISPLAY = "'Codeman Story Display', Impact, 'Arial Black', sans-serif";
  const LETTER = "'Codeman Story Letter', 'Comic Sans MS', 'Chalkboard SE', cursive";
  const MONO = "'JetBrains Mono', ui-monospace, Menlo, monospace";
  const C = {};

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  function interpolate(x, [a, b], [c, d], ease) {
    let t = clamp((x - a) / (b - a), 0, 1);
    if (ease) t = ease(t);
    return c + (d - c) * t;
  }
  function spring(f, { damping = 10, stiffness = 100, mass = 1 } = {}) {
    if (f <= 0) return 0;
    const w0 = Math.sqrt(stiffness / mass);
    const z = damping / (2 * Math.sqrt(stiffness * mass));
    const t = f / FPS;
    if (z < 1) {
      const wd = w0 * Math.sqrt(1 - z * z);
      return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
    }
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  }
  const rnd = (i) => {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  const TOKENS = ['panel', 'ink', 'line', 'cyan', 'magenta', 'yellow', 'go', 'balloon', 'balloon-ink'];
  function readColors(root) {
    const cs = getComputedStyle(root);
    for (const t of TOKENS)
      C[t.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = cs.getPropertyValue(`--story-${t}`).trim();
    C.key = TOKENS.map((t) => cs.getPropertyValue(`--story-${t}`).trim()).join('|');
  }

  // ── Drawing kit ──
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function inked(ctx, fill, lw = 3) {
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.lineWidth = lw;
    ctx.strokeStyle = C.line;
    ctx.stroke();
  }
  function base(ctx, W, H) {
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, W, H);
  }
  /** While a background is built in bands (one per frame), the band being drawn: dots outside it are skipped. */
  let band = null;
  function inBand(top, bottom, fn) {
    band = { top, bottom };
    try {
      fn();
    } finally {
      band = null;
    }
  }
  function halftone(ctx, W, H, color, fx, fy, { cell = 9, rmax = 3.6, reach = 1, alpha = 1 } = {}) {
    const diag = Math.hypot(W, H) * reach;
    const R = Math.hypot(W, H) / 2 + cell;
    const k = Math.SQRT1_2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let gy = -R; gy <= R; gy += cell) {
      for (let gx = -R; gx <= R; gx += cell) {
        const ux = gx * k - gy * k + W / 2;
        const uy = gx * k + gy * k + H / 2;
        if (ux < -cell || uy < -cell || ux > W + cell || uy > H + cell) continue;
        if (band && (uy < band.top - cell || uy > band.bottom + cell)) continue;
        const r = rmax * (1 - Math.hypot(ux - fx, uy - fy) / diag);
        if (r < 0.4) continue;
        ctx.moveTo(ux + r, uy);
        ctx.arc(ux, uy, r, 0, TAU);
      }
    }
    ctx.fill();
    ctx.restore();
  }
  function rays(ctx, W, H, cx, cy, n, color, alpha = 1, rot = 0) {
    const R = Math.hypot(W, H) * 1.2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a0 = rot + (i / n) * TAU;
      const a1 = rot + ((i + 0.5) / n) * TAU;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * Math.cos(a0), cy + R * Math.sin(a0));
      ctx.lineTo(cx + R * Math.cos(a1), cy + R * Math.sin(a1));
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
  }
  function focusLines(ctx, W, H, cx, cy, n, color, alpha) {
    const R = Math.hypot(W, H);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rnd(i) * 0.05;
      const r0 = 104 + rnd(i + 50) * 70;
      ctx.lineWidth = 0.6 + rnd(i + 20) * 1.8;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
    }
    ctx.restore();
  }
  function burst(ctx, cx, cy, ro, ri, n, fill, rot = 0, seed = 1) {
    ctx.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const a = rot + (i / (n * 2)) * TAU;
      const r = i % 2 ? ri : ro * (0.82 + rnd(i + seed) * 0.3);
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    ctx.closePath();
    ctx.lineJoin = 'miter';
    inked(ctx, fill, 3.5);
    ctx.lineJoin = 'round';
  }
  function fitSize(ctx, text, maxW, maxSize) {
    ctx.font = `100px ${DISPLAY}`;
    return Math.min(maxSize, (maxW / Math.max(1, ctx.measureText(text).width)) * 100);
  }
  function sfx(ctx, text, x, y, size, fill, rot = 0, scale = 1) {
    if (scale <= 0.01) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.font = `${size}px ${DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.fillStyle = C.line;
    ctx.fillText(text, size * 0.08, size * 0.08);
    ctx.lineWidth = size * 0.14;
    ctx.strokeStyle = C.line;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = fill;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  /** Text cut to fit a width, with an ellipsis. Canvas only: the DOM never sees it. */
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return `${text.slice(0, lo)}…`;
  }
  function limb(ctx, a, b, color, w, bend = 0) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const cx = (a[0] + b[0]) / 2 - (dy / len) * bend;
    const cy = (a[1] + b[1]) / 2 + (dx / len) * bend;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.quadraticCurveTo(cx, cy, b[0], b[1]);
    ctx.lineCap = 'round';
    ctx.strokeStyle = C.line;
    ctx.lineWidth = w + 5;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke();
  }
  function hand(ctx, p, r = 6.5) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, TAU);
    inked(ctx, C.balloon, 2.5);
  }
  function face(ctx, hy, f, mood) {
    const ey = hy - 3;
    ctx.fillStyle = C.balloonInk;
    ctx.strokeStyle = C.balloonInk;
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    if (mood === 'happy') {
      for (const ex of [-12, 12]) {
        ctx.beginPath();
        ctx.arc(ex, ey + 4, 6, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
      }
    } else if (mood === 'shock') {
      for (const ex of [-12, 12]) {
        ctx.beginPath();
        ctx.arc(ex, ey, 6.5, 0, TAU);
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ex, ey, 2.4, 0, TAU);
        ctx.fill();
      }
    } else {
      const h = f % 117 > 112 ? 2 : mood === 'focus' ? 9 : 14;
      for (const ex of [-12, 12]) {
        rr(ctx, ex - 3, ey - h / 2, 6, h, 3);
        ctx.fill();
      }
    }
    if (mood !== 'happy' && mood !== 'neutral') {
      ctx.lineWidth = 2.6;
      const up = mood === 'shock' ? 4 : 0;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        if (mood === 'focus') {
          ctx.moveTo(s * 6, hy - 13);
          ctx.lineTo(s * 17, hy - 16);
        } else {
          ctx.moveTo(s * 7, hy - 16 - up);
          ctx.lineTo(s * 17, hy - 19 - up);
        }
        ctx.stroke();
      }
    }
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (mood === 'happy' || mood === 'eager') {
      ctx.moveTo(-9, hy + 11);
      ctx.quadraticCurveTo(0, hy + 23, 9, hy + 11);
      ctx.closePath();
      ctx.fill();
    } else if (mood === 'shock') {
      ctx.ellipse(0, hy + 15, 4.5, 5.5, 0, 0, TAU);
      ctx.fill();
    } else if (mood === 'focus') {
      ctx.moveTo(-6, hy + 15);
      ctx.lineTo(6, hy + 13);
      ctx.stroke();
    } else {
      ctx.arc(0, hy + 9, 6, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();
    }
  }
  /** The agent: a terminal-headed character. (x, y) is the point between its feet. */
  /** Every edit an event made: an Edit/Write call's one, or the files a Bash here-document wrote. */
  const editsOf = (e) => (e?.edit ? [e.edit] : e?.edits || []);
  /**
   * Where Claude's head was last drawn (stage units): the speech balloon is placed over it, and no
   * balloon covers `face`, the box of his head.
   */
  let speaker = null;
  /** A scene with no Claude in it names the spot its balloon should point at. */
  function aim(x, top) {
    speaker = { x, top };
  }
  function takeSpeaker() {
    const s = speaker;
    speaker = null;
    return s;
  }
  function agent(ctx, x, y, o = {}) {
    const s = o.scale ?? 1;
    const body = o.body ?? C.cyan;
    const L = o.l ?? [-32, -44];
    const R = o.r ?? [32, -44];
    const hy = -120 + (o.headBob ?? 0);
    // Claude is the one drawn in his own colour (no `body` given); a helper never holds the balloon,
    // not even the cyan fourth one. `rise`: how much higher a jump lifts him on other frames.
    if (!o.body) {
      const lift = o.rise ?? 0;
      const t = o.tilt ?? 0;
      // The head turns with the body about the feet: its centre moves sideways by the tilt.
      const cy = (hy + 1) * s;
      const fx = x - cy * Math.sin(t);
      const fy = y + cy * Math.cos(t) - lift;
      speaker = {
        x,
        top: y + (hy - 36) * s - lift,
        face: { x: fx - 33 * s, y: fy - 28 * s, w: 66 * s, h: 56 * s + lift },
      };
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(o.tilt ?? 0);
    ctx.scale(s, s);
    ctx.lineJoin = 'round';
    if (!o.noShadow) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = C.line;
      ctx.beginPath();
      ctx.ellipse(0, 2, 30, 6, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    limb(ctx, [-11, -38], [-14, -4], body, 10);
    limb(ctx, [11, -38], [14, -4], body, 10);
    for (const fx of [-16, 16]) {
      ctx.beginPath();
      ctx.ellipse(fx, -2, 9, 5, 0, 0, TAU);
      inked(ctx, body, 2.5);
    }
    rr(ctx, -24, -88, 48, 54, 15);
    inked(ctx, body, 3);
    rr(ctx, -13, -76, 26, 17, 4);
    inked(ctx, C.balloon, 2);
    ctx.fillStyle = C.balloonInk;
    ctx.font = `600 10px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('>_', 0, -67.5);
    limb(ctx, [-19, -78], L, body, 9, o.bendL ?? -10);
    limb(ctx, [19, -78], R, body, 9, o.bendR ?? 10);
    hand(ctx, L);
    hand(ctx, R);
    ctx.beginPath();
    ctx.moveTo(0, hy - 27);
    ctx.lineTo(0, hy - 41);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, hy - 45, 6, 0, TAU);
    inked(ctx, C.yellow, 2.5);
    rr(ctx, -33, hy - 27, 66, 56, 17);
    inked(ctx, C.balloon, 3.2);
    face(ctx, hy, o.frame ?? 0, o.mood ?? 'neutral');
    ctx.restore();
    const at = (p) => [x + p[0] * s, y + p[1] * s];
    return { l: at(L), r: at(R), head: at([0, hy]) };
  }
  function labelLines(name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    // Break after a separator or between camelCase words, keeping every character of the name.
    const words = stem
      .replace(/([a-z])([A-Z])/g, '$1\u0001$2')
      .split('\u0001')
      .flatMap((part) => part.match(/[^\s_.-]+[\s_.-]*|[\s_.-]+/g) || []);
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + w).trimEnd().length > 9 && cur) {
        lines.push(cur.trimEnd());
        cur = w;
      } else cur += w;
    }
    cur = cur.trimEnd();
    if ((cur + ext).length > 11) lines.push(cur, ext);
    else lines.push(cur + ext);
    return lines.filter(Boolean).slice(0, 3);
  }
  function card(ctx, x, y, w, h, rot, label, hi) {
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(rot);
    rr(ctx, -w / 2, -h / 2, w, h, 4);
    inked(ctx, C.balloon, 2.5);
    const lines = labelLines(label);
    ctx.fillStyle = C.balloonInk;
    ctx.font = `600 8px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(fitText(ctx, l, w - 9), -w / 2 + 5, -h / 2 + 6 + i * 9));
    ctx.globalAlpha = 0.28;
    for (let i = 0, yy = -h / 2 + 12 + lines.length * 9; yy < h / 2 - 7; i++, yy += 8) {
      ctx.fillRect(-w / 2 + 5 + (i % 3 === 1 ? 6 : 0), yy, (w - 14) * (0.4 + rnd(i + label.length) * 0.5), 3.2);
    }
    ctx.globalAlpha = 1;
    if (hi > 0) {
      ctx.globalAlpha = hi;
      rr(ctx, -w / 2 - 5, -h / 2 - 5, w + 10, h + 10, 8);
      ctx.strokeStyle = C.magenta;
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  function magnifier(ctx, cx, cy, r, h) {
    const dx = h[0] - cx;
    const dy = h[1] - cy;
    const d = Math.hypot(dx, dy) || 1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + (dx / d) * r, cy + (dy / d) * r);
    ctx.lineTo(h[0] + (dx / d) * 6, h[1] + (dy / d) * 6);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.strokeStyle = C.yellow;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = C.cyan;
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 5;
    ctx.strokeStyle = C.line;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.62, Math.PI * 1.1, Math.PI * 1.45);
    ctx.strokeStyle = C.balloon;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  function cloud(ctx, cx, cy, w, h) {
    const pts = [];
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * TAU;
      pts.push([cx + Math.cos(a) * w * 0.42, cy + Math.sin(a) * h * 0.4, (w + h) * 0.1 * (0.85 + rnd(i + 3) * 0.3)]);
    }
    for (const [fill, pad] of [
      [C.line, 3],
      [C.balloon, 0],
    ]) {
      ctx.fillStyle = fill;
      for (const [x, y, r] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, r + pad, 0, TAU);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.42 + pad, h * 0.4 + pad, 0, 0, TAU);
      ctx.fill();
    }
  }
  function tag(ctx, x, y, text, director, alpha) {
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.font = director ? `600 10px ${MONO}` : `16px ${LETTER}`;
    const shown = fitText(ctx, text, 110);
    const w = ctx.measureText(shown).width;
    rr(ctx, x - w / 2 - 7, y, w + 14, 19, 5);
    inked(ctx, C.balloon, 2);
    ctx.fillStyle = C.balloonInk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(shown, x, y + 10.5);
    ctx.restore();
  }
  function pencil(ctx, h, t) {
    const dx = t[0] - h[0];
    const dy = t[1] - h[1];
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const back = [h[0] - ux * 16, h[1] - uy * 16];
    const neck = [t[0] - ux * 12, t[1] - uy * 12];
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(back[0], back[1]);
    ctx.lineTo(neck[0], neck[1]);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 12;
    ctx.stroke();
    ctx.strokeStyle = C.yellow;
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(neck[0] - uy * 6, neck[1] + ux * 6);
    ctx.lineTo(t[0], t[1]);
    ctx.lineTo(neck[0] + uy * 6, neck[1] - ux * 6);
    ctx.closePath();
    inked(ctx, C.balloon, 2);
    ctx.beginPath();
    ctx.arc(t[0] - ux * 2, t[1] - uy * 2, 2.2, 0, TAU);
    ctx.fillStyle = C.line;
    ctx.fill();
  }
  /** A page of code showing real diff lines (`lines` keep their ' '/'+'/'-' prefix). */
  function codePage(ctx, x, y, w, h, f, title, lines, stack) {
    for (let k = Math.min(stack, 2); k > 0; k--) {
      rr(ctx, x + k * 6, y - k * 6, w, h, 5);
      inked(ctx, C.balloon, 2);
    }
    rr(ctx, x, y, w, h, 5);
    inked(ctx, C.balloon, 2.5);
    ctx.fillStyle = C.balloonInk;
    ctx.font = `600 9px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(fitText(ctx, title, w - 16), x + 8, y + 14);
    ctx.font = `500 8px ${MONO}`;
    const rows = Math.max(1, Math.floor((h - 26) / 11.5));
    if (!lines.length) {
      // The edit is still running: rough lines and a blinking caret.
      ctx.globalAlpha = 0.28;
      for (let i = 0; i < Math.min(rows, 6); i++) {
        ctx.fillRect(x + 10 + (i % 3 === 1 ? 10 : 0), y + 26 + i * 11.5, (w - 30) * (0.4 + rnd(i + 5) * 0.5), 4);
      }
      ctx.globalAlpha = 1;
      if (f % 30 < 15) {
        ctx.fillStyle = C.magenta;
        ctx.fillRect(x + 10, y + 26 + Math.min(rows, 6) * 11.5, 6, 10);
      }
      return;
    }
    let k = 0;
    lines.slice(0, rows).forEach((raw, i) => {
      const ly = y + 30 + i * 11.5;
      const mark = raw[0] === '+' ? '+ ' : raw[0] === '-' ? '− ' : '  ';
      const text = fitText(ctx, mark + raw.slice(1).trim(), w - 16);
      if (raw[0] !== '+' && raw[0] !== '-') {
        ctx.globalAlpha = 0.62;
        ctx.fillStyle = C.balloonInk;
        ctx.fillText(text, x + 8, ly);
        ctx.globalAlpha = 1;
        return;
      }
      const p = interpolate(f, [18 + k * 6, 28 + k * 6], [0, 1], easeOut);
      k++;
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = raw[0] === '+' ? C.go : C.magenta;
      ctx.fillRect(x + 3, ly - 8.5, (w - 6) * p, 11);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 3, ly - 9, (w - 6) * p, 12);
      ctx.clip();
      ctx.fillStyle = C.balloonInk;
      ctx.fillText(text, x + 8, ly);
      ctx.restore();
    });
  }
  /**
   * A check without counts (a build, a lint, a run whose summary was not recognised): one verdict
   * stamp instead of a board, so no number is drawn that the run never reported.
   */
  function verdict(ctx, x, y, label, ok, f) {
    const w = 127;
    const h = 92;
    rr(ctx, x, y, w, h, 8);
    inked(ctx, C.balloon, 2.5);
    ctx.fillStyle = C.balloonInk;
    ctx.font = `15px ${LETTER}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fitText(ctx, label, w - 12), x + w / 2, y + 14);
    const cx = x + w / 2;
    const cy = y + 56;
    const r = 22;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    inked(ctx, ok === undefined ? C.balloon : ok ? C.go : C.magenta, 3);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = ok === undefined ? C.line : C.balloon;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (ok === undefined) {
      // Running: a hand that sweeps round the dial.
      const a = (f / 9) % TAU;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * (r - 7), Math.sin(a) * (r - 7));
    } else if (ok) {
      ctx.moveTo(-10, 1);
      ctx.lineTo(-3, 8);
      ctx.lineTo(11, -8);
    } else {
      ctx.moveTo(-8, -8);
      ctx.lineTo(8, 8);
      ctx.moveTo(8, -8);
      ctx.lineTo(-8, 8);
    }
    ctx.stroke();
    ctx.restore();
    return { w, h };
  }
  /** A board of check dots. `fail` dots are drawn red with a crack; `fill` is how many are in yet. */
  function board(ctx, x, y, label, dots, fail, fill) {
    const cols = 7;
    const g = 16;
    const r = 5.5;
    const rows = Math.ceil(dots / cols);
    const w = 127;
    const h = 30 + rows * g;
    rr(ctx, x, y, w, h, 8);
    inked(ctx, C.balloon, 2.5);
    ctx.fillStyle = C.balloonInk;
    ctx.font = `15px ${LETTER}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fitText(ctx, label, w - 12), x + w / 2, y + 14);
    for (let k = 0; k < dots; k++) {
      const cx = x + 10 + (k % cols) * g + r;
      const cy = y + 26 + Math.floor(k / cols) * g + r;
      const on = k < fill;
      const bad = on && k >= dots - fail;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      inked(ctx, on ? (bad ? C.magenta : C.go) : C.balloon, 2);
      if (bad) {
        ctx.beginPath();
        ctx.moveTo(cx - r - 4, cy - r - 2);
        ctx.lineTo(cx - 2, cy - 1);
        ctx.lineTo(cx + 2, cy - 6);
        ctx.lineTo(cx + r + 5, cy + 3);
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    return { w, h };
  }
  /** A terminal card: the commands (`› …`), then, dimmer, the first lines one of them printed. */
  /** A test board's label: "1 test", "19 tests", or "1 error" when nothing even loaded. */
  function boardLabel(t, total) {
    if (t && !t.passed && !t.failed && t.errors) return `${t.errors} error${t.errors === 1 ? '' : 's'}`;
    return `${total} test${total === 1 ? '' : 's'}`;
  }
  /** `clear` ({ x, top, bottom }): a band something is held over (the magnifier); lines in it end left of `x`. */
  function terminal(ctx, x, y, w, h, lines, f, printed = [], clear = null) {
    const room = (base) =>
      clear && base + 2 > clear.top && base - 8 < clear.bottom ? Math.min(w - 18, clear.x - x - 13) : w - 18;
    rr(ctx, x, y, w, h, 7);
    inked(ctx, C.line, 2.5);
    ctx.fillStyle = C.balloonInk;
    for (const [i, color] of [C.magenta, C.yellow, C.go].entries()) {
      ctx.beginPath();
      ctx.arc(x + 11 + i * 10, y + 9, 3, 0, TAU);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.font = `500 9px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const rows = Math.max(1, Math.floor((h - 24) / 14));
    lines.slice(0, rows).forEach((line, i) => {
      const text = fitText(ctx, `› ${line}`, room(y + 30 + i * 14));
      const shown = Math.floor(interpolate(f, [8 + i * 12, 20 + i * 12], [0, text.length]));
      ctx.fillStyle = i === Math.min(rows, lines.length) - 1 ? C.yellow : C.balloon;
      ctx.fillText(text.slice(0, shown), x + 9, y + 30 + i * 14);
    });
    const n = Math.min(rows, lines.length);
    const out = printed.slice(0, Math.max(0, rows - n));
    out.forEach((line, i) => {
      const text = fitText(ctx, line, room(y + 30 + (n + i) * 14));
      const at = 8 + (n + i) * 12;
      const shown = Math.floor(interpolate(f, [at, at + 10], [0, text.length]));
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = C.balloon;
      ctx.fillText(text.slice(0, shown), x + 9, y + 30 + (n + i) * 14);
      ctx.restore();
    });
    if (f % 30 < 15) {
      ctx.fillStyle = C.balloon;
      ctx.fillRect(x + 9, y + 22 + (n + out.length) * 14, 6, 10);
    }
  }
  function globe(ctx, cx, cy, r, f) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    inked(ctx, C.cyan, 3);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.clip();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    for (let k = -2; k <= 2; k++) {
      ctx.beginPath();
      ctx.ellipse(cx, cy + k * r * 0.38, r, r * 0.12, 0, 0, TAU);
      ctx.stroke();
    }
    const spin = (f / 40) % 1;
    for (let k = 0; k < 3; k++) {
      const p = ((k / 3 + spin) % 1) * 2 - 1;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(p) * r, r, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }
  function star4(ctx, x, y, r, fill) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU - Math.PI / 2;
      const rad = i % 2 ? r * 0.32 : r;
      const px = x + Math.cos(a) * rad;
      const py = y + Math.sin(a) * rad;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    ctx.closePath();
    inked(ctx, fill, 2);
  }
  function baseName(path) {
    const s = String(path || '').replace(/\/+$/, '');
    return s.slice(s.lastIndexOf('/') + 1) || s;
  }

  // ── Scenes. `p` = { panel, page, director }, `hit(id, x, y, w, h, label)` registers a click target. ──
  const SCENES = {
    mission: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.cyan, W, H, { rmax: 4.4, reach: 0.9 });
      },
      draw(ctx, W, H, f, p, hit) {
        const ax = Math.max(W * 0.78, W - 104);
        const from = p.page?.events[p.panel.events[0]]?.origin;
        hit(
          'prompt',
          ax - 56,
          110,
          112,
          140,
          from === 'task' ? 'Read the report' : from === 'peer' ? 'Read the message' : 'Read the whole prompt'
        );
        const a = agent(ctx, ax, 244, {
          frame: f,
          mood: 'listen',
          headBob: Math.sin(f / 16) * 1.6,
          l: [-30, -42],
          r: [30, -42],
        });
        sfx(
          ctx,
          '!',
          a.head[0] + 46,
          a.head[1] - 34,
          46,
          C.yellow,
          0.2,
          spring(f - 16, { damping: 8, stiffness: 160 })
        );
      },
    },
    investigate: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.yellow, 0, H, { rmax: 4.6 });
      },
      draw(ctx, W, H, f, p, hit) {
        const files = p.panel.files || [];
        const ax = W - 58;
        if (!files.length) {
          const tw = Math.min(W * 0.58, 220);
          // On a narrow panel the magnifier is held over the terminal: the lines it passes end short of
          // it (its rim's reach over every frame of its sway), so it never hides their words.
          const lens = { x: ax - 122, top: 125, bottom: 187 };
          terminal(ctx, 14, 92, tw, 130, p.panel.notes?.length ? p.panel.notes : ['looking around'], f, [], lens);
          hit('list', 14, 92, tw, 130, 'See what Claude looked at');
        } else {
          const shown = files.length > 8 ? files.slice(0, 7) : files;
          const extra = files.length - shown.length;
          const labels = shown.map(baseName).concat(extra ? [`+${extra} more`] : []);
          const cw = 60;
          const ch = 78;
          const n = labels.length;
          const step = n > 1 ? Math.min(70, Math.max(8, (ax - 70 - 14 - cw) / (n - 1))) : 0;
          for (let i = 0; i < n; i++) {
            const pr = spring(f - 4 - i * 5, { damping: 11, stiffness: 150 });
            if (pr <= 0.001) continue;
            const cx = 14 + i * step;
            const cy = 128 + (i % 2) * 14 + Math.sin(i * 1.7) * 4 - (1 - pr) * 70;
            ctx.save();
            ctx.globalAlpha = clamp(pr * 1.5, 0, 1);
            card(ctx, cx, cy, cw, ch, (i - n / 2 + 0.5) * 0.06, labels[i], 0);
            ctx.restore();
            if (extra && i === n - 1) hit('list', cx, cy, cw, ch, `See all ${files.length} files`);
            else hit(`file:${i}`, cx, cy, cw, ch, `Open ${labels[i]}`);
          }
        }
        const a = agent(ctx, ax, 246, {
          frame: f,
          mood: 'focus',
          l: [-64 + Math.sin(f / 22) * 9, -74 + Math.cos(f / 17) * 6],
          r: [28, -40],
        });
        magnifier(ctx, a.l[0] - 24, a.l[1] - 16, 22, a.l);
      },
    },
    research: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.cyan, 0, 0, { rmax: 3.6 });
      },
      draw(ctx, W, H, f, p, hit) {
        const gx = Math.min(W * 0.32, 130);
        const pr = spring(f - 2, { damping: 12, stiffness: 140 });
        globe(ctx, gx, 160, 58 * pr + 0.1, f);
        hit('list', gx - 60, 100, 120, 120, 'See what Claude looked up');
        const notes = p.panel.notes || [];
        ctx.font = `600 8.5px ${MONO}`;
        notes.slice(0, 3).forEach((note, i) => {
          const tp = spring(f - 20 - i * 6, { damping: 12, stiffness: 140 });
          if (tp <= 0.01) return;
          const tx = gx + 60;
          const ty = 100 + i * 34;
          const tw = Math.max(40, Math.min(W - tx - 70, 190));
          ctx.save();
          ctx.globalAlpha = clamp(tp, 0, 1);
          rr(ctx, tx, ty, tw, 24, 5);
          inked(ctx, C.balloon, 2);
          ctx.fillStyle = C.balloonInk;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(fitText(ctx, note, tw - 12), tx + 6, ty + 12.5);
          ctx.restore();
        });
        agent(ctx, W - 44, 252, { frame: f, scale: 0.62, mood: 'focus', l: [-34, -70], r: [30, -44] });
      },
    },
    plan: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.magenta, W, 0, { rmax: 3.4, reach: 1.1, alpha: 0.9 });
      },
      draw(ctx, W, H, f, p, hit) {
        const cx = W * 0.44;
        const cy = 168;
        const cw = Math.min(W * 0.66, 300);
        const chh = 132;
        const pc = spring(f - 2, { damping: 12, stiffness: 140 });
        if (pc > 0.01) {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.scale(pc, pc);
          cloud(ctx, 0, 0, cw, chh);
          const items = p.panel.todos?.length
            ? p.panel.todos.map((t) => ({ text: t.text, done: t.done, box: true }))
            : (p.panel.notes || []).map((t) => ({ text: t, done: false, box: false }));
          ctx.font = `14px ${LETTER}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const shown = items.slice(0, 4);
          shown.forEach((item, i) => {
            const ly = -((shown.length - 1) * 19) / 2 + i * 19;
            const lx = -cw * 0.36;
            if (item.box) {
              ctx.strokeStyle = C.balloonInk;
              ctx.lineWidth = 1.8;
              ctx.strokeRect(lx, ly - 6, 12, 12);
              if (item.done) {
                ctx.beginPath();
                ctx.moveTo(lx + 2, ly);
                ctx.lineTo(lx + 5, ly + 4);
                ctx.lineTo(lx + 11, ly - 5);
                ctx.strokeStyle = C.go;
                ctx.lineWidth = 2.5;
                ctx.stroke();
              }
            }
            ctx.fillStyle = C.balloonInk;
            ctx.fillText(fitText(ctx, item.text, cw * 0.66), lx + (item.box ? 18 : 0), ly + 1);
          });
          if (items.length > shown.length) {
            ctx.fillText(`+${items.length - shown.length} more`, -cw * 0.36 + 18, ((shown.length + 1) * 19) / 2);
          }
          ctx.restore();
          hit('plan', cx - cw * 0.45 * pc, cy - chh * 0.45 * pc, cw * 0.9 * pc, chh * 0.9 * pc, 'See the plan');
        }
        const a = agent(ctx, W - 38, 256, { frame: f, scale: 0.52, mood: 'focus', l: [-26, -60], r: [30, -44] });
        const from = [a.head[0] - 22, a.head[1] - 18];
        const to = [cx + cw * 0.36, cy + chh * 0.38];
        [4, 6, 8].forEach((r, k) => {
          const t = (k + 1) / 4;
          const pp = clamp((pc - 0.6) / 0.4, 0, 1);
          if (pp <= 0) return;
          ctx.beginPath();
          ctx.arc(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, r * pp, 0, TAU);
          inked(ctx, C.balloon, 2);
        });
      },
    },
    backup: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        rays(ctx, W, H, W / 2, 190, 28, C.yellow, 0.55, 0.05);
        halftone(ctx, W, H, C.cyan, W / 2, H, { cell: 10, rmax: 3, reach: 0.8, alpha: 0.7 });
      },
      draw(ctx, W, H, f, p, hit) {
        const mx = W / 2;
        agent(ctx, mx, 248, {
          frame: f,
          mood: 'eager',
          l: [-44, -118 + Math.sin(f / 9) * 3],
          r: [44, -118 + Math.cos(f / 9) * 3],
          bendL: 12,
          bendR: -12,
        });
        const helpers = (p.panel.helpers || []).slice(0, 4);
        const spots = [0.16, 0.84, 0.31, 0.69];
        const colors = [C.magenta, C.yellow, C.go, C.cyan];
        if (!helpers.length) {
          // A message to another session: an envelope flies off.
          const pr = spring(f - 8, { damping: 13, stiffness: 80 });
          const x = mx + (W * 0.84 - mx) * pr;
          const y = 150 - Math.sin(clamp(pr, 0, 1) * Math.PI) * 50;
          rr(ctx, x - 22, y - 14, 44, 28, 3);
          inked(ctx, C.balloon, 2.5);
          ctx.beginPath();
          ctx.moveTo(x - 22, y - 14);
          ctx.lineTo(x, y + 2);
          ctx.lineTo(x + 22, y - 14);
          ctx.strokeStyle = C.line;
          ctx.lineWidth = 2;
          ctx.stroke();
          hit('list', x - 26, y - 18, 52, 36, 'See the message');
          return;
        }
        helpers.forEach((h, k) => {
          const delay = 8 + k * 6;
          const pr = spring(f - delay, { damping: 13, stiffness: 80 });
          if (pr <= 0.001) return;
          const tx = W * spots[k];
          const dir = Math.sign(tx - mx) || 1;
          const x = mx + (tx - mx) * pr;
          const y = 150 + (224 - 150) * pr - Math.sin(clamp(pr, 0, 1) * Math.PI) * 60;
          if (pr < 0.97) {
            ctx.save();
            ctx.globalAlpha = clamp(1 - pr, 0, 1);
            ctx.strokeStyle = C.ink;
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            for (let s = 0; s < 3; s++) {
              ctx.beginPath();
              ctx.moveTo(x - dir * (24 + s * 6), y - 64 + s * 14);
              ctx.lineTo(x - dir * (74 + s * 14), y - 70 + s * 14);
              ctx.stroke();
            }
            ctx.restore();
          }
          agent(ctx, x, y, {
            frame: f + delay * 7,
            scale: 0.62,
            body: colors[k],
            mood: 'happy',
            tilt: dir * 0.35 * (1 - clamp(pr, 0, 1)),
            l: [-30, -50],
            r: [30, -50],
          });
          if (pr > 0.85)
            tag(
              ctx,
              clamp(x, 64, W - 64),
              y + 9,
              p.director ? h.type : h.task || h.name,
              p.director,
              (pr - 0.85) / 0.15
            );
          hit(
            `helper:${h.event}`,
            x - 30,
            y - 112,
            60,
            142,
            h.type === 'advisor' ? 'See the second opinion' : `See what the helper did: ${h.task || h.name}`
          );
        });
      },
    },
    fix: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.cyan, 0, H, { rmax: 3.6 });
      },
      draw(ctx, W, H, f, p, hit) {
        const edits = p.panel.events.flatMap((i) => editsOf(p.page.events[i]));
        const first = edits[0];
        const lines = first?.hunks?.[0]?.lines || [];
        const pw = Math.min(W * 0.56, 196);
        const ph = 128;
        const x0 = 12 - (1 - spring(f, { damping: 14, stiffness: 120 })) * 70;
        const y0 = 104;
        const files = p.panel.files || [];
        codePage(ctx, x0, y0, pw, ph, f, baseName(first?.file || files[0] || 'file'), lines, files.length - 1);
        hit('diff', x0, y0, pw, ph, "See Claude's changes");
        const ax = Math.min(W - 50, x0 + pw + 200);
        const tip = [x0 + pw - 14, y0 + ph * 0.5];
        const hp = [tip[0] + 20 + Math.sin(f / 2.6) * 3, tip[1] - 28 + Math.cos(f / 3.1) * 2.5];
        const a = agent(ctx, ax, 248, { frame: f, mood: 'focus', l: [hp[0] - ax, hp[1] - 248], r: [30, -42] });
        pencil(ctx, a.l, [tip[0] + Math.sin(f / 2.6) * 3, tip[1] + Math.cos(f / 3.1) * 2.5]);
        // With several files the badge counts the card in front: a total beside one file's card read as
        // that file's own. The Director's cut has every file's count.
        const front = files.length > 1 && first ? edits.filter((d) => d.file === first.file) : null;
        // A file created here counts what it ends with, never lines it removed from its own draft.
        const fa = front ? front.reduce((n, d) => n + d.added, 0) : 0;
        const fr = front ? front.reduce((n, d) => n + d.removed, 0) : 0;
        const fresh = !!front?.some((d) => d.created);
        const added = front ? (fresh ? Math.max(0, fa - fr) : fa) : p.panel.added;
        const removed = front ? (fresh ? 0 : fr) : p.panel.removed;
        if (added)
          sfx(
            ctx,
            `+${added}`,
            x0 + pw * 0.32,
            y0 + ph + 2,
            26,
            C.go,
            -0.18,
            spring(f - 44, { damping: 9, stiffness: 170 })
          );
        if (removed)
          sfx(
            ctx,
            `−${removed}`,
            x0 + pw * 0.74,
            y0 + ph + 6,
            24,
            C.magenta,
            0.12,
            spring(f - 50, { damping: 9, stiffness: 170 })
          );
      },
    },
    check: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.yellow, W * 0.7, H * 0.5, { cell: 8, rmax: 4.2, reach: 0.9 });
      },
      draw(ctx, W, H, f, p, hit) {
        const t = p.panel.tests;
        const bad = t ? t.failed + (t.errors || 0) : 0;
        const total = t ? t.passed + bad : 0;
        const running = p.panel.ok === undefined;
        let b;
        if (total) {
          const dots = Math.min(42, total);
          const fail = bad ? Math.max(1, Math.round((bad / total) * dots)) : 0;
          const fill = running ? (f * 0.6) % (dots + 6) : Math.min(dots, (f - 4) * 1.6);
          b = board(ctx, 16, 106, boardLabel(t, total), dots, fail, fill);
        } else {
          b = verdict(ctx, 16, 106, 'checks', p.panel.ok, f);
        }
        hit('output', 16, 106, b.w, b.h, 'See the output');
        const cx = Math.min(W * 0.56, W - 120);
        const cy = 166;
        const bp = running ? 0 : spring(f - 30, { damping: 9, stiffness: 150 });
        if (bp > 0.01) {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.scale(bp, bp);
          burst(ctx, 0, 0, 60, 36, 13, p.panel.ok ? C.cyan : C.yellow, 0.1, p.panel.ok ? 9 : 3);
          ctx.restore();
          const word = p.panel.ok ? 'POW!' : 'KRAK!';
          sfx(ctx, word, cx, cy, fitSize(ctx, word, 96, 30), p.panel.ok ? C.yellow : C.magenta, -0.1, bp);
        }
        if (p.panel.ok && f > 34) {
          [
            [14, 100],
            [142, 112],
            [10, 230],
          ].forEach(([x, y], k) => star4(ctx, x, y, 7 + Math.sin(f / 5 + k * 1.7) * 3, C.yellow));
        }
        const mood = running ? 'focus' : p.panel.ok ? 'happy' : 'shock';
        const jumping = p.panel.ok && f > 30;
        const jump = jumping ? Math.abs(Math.sin((f - 30) / 7)) * 12 : 0;
        agent(ctx, W - 40, 254 - jump, {
          frame: f,
          scale: 0.66,
          rise: jumping ? 12 - jump : 0,
          mood,
          tilt: p.panel.ok === false ? interpolate(f, [28, 36], [0, 0.14]) : 0,
          l: p.panel.ok ? [-32, -58] : [-36, -98],
          r: p.panel.ok ? [22, -152] : [32, -102],
        });
      },
    },
    loop: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.magenta, W, 0, { cell: 8, rmax: 3.6 });
      },
      draw(ctx, W, H, f, p, hit) {
        const edits = p.panel.events.flatMap((i) => editsOf(p.page.events[i]));
        const last = edits[edits.length - 1];
        // No Claude here: the balloon points at the verdict, above the board and the rounds.
        aim(W - 60, 128);
        const pw = Math.min(W * 0.36, 150);
        codePage(ctx, 12, 108, pw, 112, f, baseName(last?.file || 'file'), last?.hunks?.[0]?.lines || [], 0);
        hit('diff', 12, 108, pw, 112, "See Claude's changes");
        const bx = 12 + pw + 34;
        if (bx + 127 < W - 10) {
          // The last run's real counts, or one verdict when it reported none.
          const t = p.panel.tests;
          const bad = t ? t.failed + (t.errors || 0) : 0;
          const total = t ? t.passed + bad : 0;
          let b;
          if (total) {
            const dots = Math.min(28, total);
            const fail = bad ? Math.max(1, Math.round((bad / total) * dots)) : 0;
            b = board(ctx, bx, 116, boardLabel(t, total), dots, fail, Math.min(dots, (f - 4) * 1.6));
          } else b = verdict(ctx, bx, 116, 'checks', p.panel.ok, f);
          hit('output', bx, 116, b.w, b.h, 'See the test output');
        }
        // The cycle arrow between the page and the board.
        const ax = 12 + pw + 17;
        // It turns while the rounds are still going; on a finished page it rests.
        const spin = p.panel.live || f < HERO ? (f / 20) % TAU : 0.4;
        ctx.save();
        ctx.translate(ax, 164);
        ctx.rotate(spin);
        ctx.beginPath();
        ctx.arc(0, 0, 14, 0.3, TAU - 0.6);
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.strokeStyle = C.yellow;
        ctx.lineWidth = 3;
        ctx.stroke();
        // The arrowhead at the arc's end.
        const end = TAU - 0.6;
        const hx = Math.cos(end) * 14;
        const hy = Math.sin(end) * 14;
        ctx.beginPath();
        ctx.moveTo(hx + 7, hy - 3);
        ctx.lineTo(hx - 1, hy + 7);
        ctx.lineTo(hx - 6, hy - 6);
        ctx.closePath();
        inked(ctx, C.yellow, 2);
        ctx.restore();
        // Every round's verdict, in order: a first run that failed (often the one you asked for) shows.
        const marks = p.panel.roundsOk || [];
        if (marks.length) {
          const shown = marks.slice(-6);
          const gap = 22;
          const x0 = W - 60 - ((shown.length - 1) * gap) / 2;
          shown.forEach((ok, k) => {
            const pr = spring(f - 20 - k * 6, { damping: 10, stiffness: 160 });
            if (pr <= 0.01) return;
            const cx = x0 + k * gap;
            ctx.save();
            ctx.translate(cx, 214);
            ctx.scale(pr, pr);
            ctx.beginPath();
            ctx.arc(0, 0, 9, 0, TAU);
            if (ok === null) {
              // Still running: an open circle, no verdict yet.
              ctx.setLineDash([3, 3]);
              ctx.lineWidth = 2.5;
              ctx.strokeStyle = C.balloon;
              ctx.stroke();
              ctx.restore();
              return;
            }
            inked(ctx, ok ? C.go : C.magenta, 2.5);
            ctx.strokeStyle = C.balloon;
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            ctx.beginPath();
            if (ok) {
              ctx.moveTo(-4, 0);
              ctx.lineTo(-1, 3.5);
              ctx.lineTo(4.5, -3.5);
            } else {
              ctx.moveTo(-3.5, -3.5);
              ctx.lineTo(3.5, 3.5);
              ctx.moveTo(3.5, -3.5);
              ctx.lineTo(-3.5, 3.5);
            }
            ctx.stroke();
            ctx.restore();
          });
        } else
          sfx(
            ctx,
            `×${p.panel.rounds || 1}`,
            W - 60,
            214,
            30,
            C.yellow,
            -0.1,
            spring(f - 20, { damping: 9, stiffness: 160 })
          );
        // The verdict stamp only where it clears the board (a narrow panel shows the board alone).
        if (p.panel.ok !== undefined && W - 108 > bx + 131) {
          const word = p.panel.ok ? 'POW!' : 'KRAK!';
          sfx(
            ctx,
            word,
            W - 60,
            150,
            fitSize(ctx, word, 90, 26),
            p.panel.ok ? C.yellow : C.magenta,
            0.08,
            spring(f - 40, { damping: 9, stiffness: 150 })
          );
        }
      },
    },
    run: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.cyan, 0, H, { rmax: 3.4 });
      },
      draw(ctx, W, H, f, p, hit) {
        const tw = Math.min(W * 0.62, 260);
        const notes = p.panel.notes?.length ? p.panel.notes : ['…'];
        terminal(ctx, 14, 92, tw, 140, notes.slice(0, p.panel.printed?.length ? 3 : 8), f, p.panel.printed || []);
        hit('output', 14, 92, tw, 140, 'See the commands and their output');
        agent(ctx, W - 48, 250, {
          frame: f,
          mood: 'focus',
          scale: 0.8,
          l: [-40, -60 + Math.sin(f / 2) * 3],
          r: [-20, -58 + Math.cos(f / 2) * 3],
        });
      },
    },
    save: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.go, W, H, { rmax: 3.6, alpha: 0.7 });
      },
      draw(ctx, W, H, f, p, hit) {
        const pr = spring(f - 4, { damping: 12, stiffness: 140 });
        const bx = 24;
        const by = 120 + (1 - pr) * 40;
        rr(ctx, bx, by, 120, 90, 6);
        inked(ctx, C.yellow, 3);
        rr(ctx, bx - 6, by - 14, 132, 22, 5);
        inked(ctx, C.yellow, 3);
        ctx.fillStyle = C.line;
        ctx.fillRect(bx + 44, by + 18, 32, 8);
        hit('output', bx - 6, by - 14, 132, 104, 'See what was saved');
        // The stamp says how it went: SAVED, or ERROR when the command failed; none while it runs.
        const failed = p.panel.ok === false;
        const stamp = failed ? 'ERROR' : 'SAVED';
        const sp = p.panel.ok === undefined ? 0 : spring(f - 28, { damping: 8, stiffness: 160 });
        if (sp > 0.01) {
          ctx.save();
          ctx.translate(bx + 60, by + 56);
          ctx.rotate(failed ? 0.14 : -0.18);
          ctx.scale(sp, sp);
          ctx.font = `20px ${DISPLAY}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const w = ctx.measureText(stamp).width + 18;
          rr(ctx, -w / 2, -15, w, 30, 4);
          ctx.strokeStyle = C.magenta;
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.fillStyle = C.magenta;
          ctx.fillText(stamp, 0, 1);
          ctx.restore();
        }
        agent(ctx, W - 50, 250, {
          frame: f,
          mood: failed ? 'shock' : p.panel.ok === undefined ? 'focus' : 'happy',
          scale: 0.8,
          l: [-30, -52],
          r: failed ? [30, -60] : [26, -128],
        });
      },
    },
    ask: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.yellow, 0, H, { cell: 10, rmax: 3, alpha: 0.8 });
        focusLines(ctx, W, H, W * 0.64, 136, 84, C.ink, 0.45);
      },
      draw(ctx, W, H, f, p, hit) {
        const ax = W * 0.64;
        const s = 1.7;
        const yb = 338;
        const hp = [ax - 46 + Math.sin(f / 7) * 1.5, 212];
        agent(ctx, ax, yb, {
          frame: f,
          scale: s,
          mood: 'eager',
          noShadow: true,
          l: [(hp[0] - ax) / s, (hp[1] - yb) / s],
          r: [28, -46],
        });
        ctx.beginPath();
        ctx.arc(hp[0], hp[1], 17, 0, TAU);
        inked(ctx, C.balloon, 3);
        ctx.beginPath();
        ctx.arc(hp[0] - 2, hp[1] - 1, 8, 0, TAU);
        inked(ctx, C.balloon, 2.5);
        hit('ask', ax - 60, 80, 120, 150, 'See the question');
      },
    },
    compact: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.magenta, 0, 0, { rmax: 3.2, alpha: 0.7 });
      },
      draw(ctx, W, H, f, p, hit) {
        const squeeze = interpolate(f, [10, 50], [1, 0.35], easeOut);
        hit('output', 24, 110, 140, 130, 'See what was packed up');
        for (let k = 0; k < 6; k++) {
          ctx.save();
          ctx.translate(40 + k * 4, 200 - k * 14 * squeeze);
          ctx.rotate((rnd(k) - 0.5) * 0.2);
          rr(ctx, 0, 0, 90, 12, 2);
          inked(ctx, C.balloon, 2);
          ctx.restore();
        }
        rr(ctx, 30, 206, 120, 30, 5);
        inked(ctx, C.yellow, 3);
        agent(ctx, W - 50, 250, { frame: f, mood: 'focus', scale: 0.8, l: [-60, -90 + squeeze * 20], r: [24, -50] });
      },
    },
    montage: {
      bg(ctx, W, H) {
        base(ctx, W, H);
        halftone(ctx, W, H, C.yellow, W / 2, H / 2, { rmax: 3.4 });
      },
      draw(ctx, W, H, f, p, hit) {
        // One cell per kind of step the montage folded, in this order, at most four.
        const evs = p.panel.events.map((i) => p.page.events[i]).filter(Boolean);
        const has = (...intents) => evs.some((e) => intents.includes(e.intent));
        const cells = [
          has('read', 'search', 'look', 'web') && { icon: 'look' },
          has('run', 'tool', 'message', 'helper', 'plan') && { icon: 'run' },
          has('edit') && { icon: 'edit' },
          has('test', 'build') && { icon: 'check' },
          has('save') && { icon: 'save' },
        ]
          .filter(Boolean)
          .slice(0, 4);
        const size = Math.min(70, (W - 120) / 2);
        const x0 = 16;
        const y0 = 92;
        cells.forEach((c, k) => {
          const pr = spring(f - k * 5, { damping: 12, stiffness: 150 });
          if (pr <= 0.01) return;
          const x = x0 + (k % 2) * (size + 10);
          const y = y0 + Math.floor(k / 2) * (size + 10);
          ctx.save();
          ctx.globalAlpha = clamp(pr, 0, 1);
          rr(ctx, x, y, size, size, 6);
          inked(ctx, C.panel, 2.5);
          const cx = x + size / 2;
          const cy = y + size / 2;
          if (c.icon === 'look') magnifier(ctx, cx - 4, cy - 4, size * 0.2, [cx + size * 0.28, cy + size * 0.28]);
          else if (c.icon === 'run') terminal(ctx, x + 8, y + 12, size - 16, size - 24, ['…'], HERO);
          else if (c.icon === 'edit')
            pencil(ctx, [cx + size * 0.3, cy - size * 0.3], [cx - size * 0.2, cy + size * 0.2]);
          else if (c.icon === 'save') {
            rr(ctx, cx - size * 0.3, cy - size * 0.12, size * 0.6, size * 0.38, 3);
            inked(ctx, C.yellow, 2.5);
            rr(ctx, cx - size * 0.34, cy - size * 0.26, size * 0.68, size * 0.14, 3);
            inked(ctx, C.yellow, 2.5);
          } else star4(ctx, cx, cy, size * 0.3, C.go);
          ctx.restore();
        });
        hit('list', x0, y0, size * 2 + 10, size * 2 + 10, 'See every step');
        agent(ctx, W - 46, 252, { frame: f, mood: 'eager', scale: 0.62, l: [-30, -60], r: [26, -120] });
      },
    },
    complete: {
      fullWidth: true,
      bg(ctx, W, H) {
        base(ctx, W, H);
        // Centred on Claude, who stands at the bottom of the stage (H - 60 is 200 on a normal panel).
        rays(ctx, W, H, W > 420 ? W * 0.72 : W / 2, H - 60, 30, C.cyan, 0.32);
        halftone(ctx, W, H, C.magenta, W, 0, { rmax: 3.4, reach: 0.85, alpha: 0.75 });
      },
      draw(ctx, W, H, f, p) {
        const wide = W > 420;
        const ax = wide ? W * 0.72 : W / 2;
        const sc = wide ? 0.9 : 0.55;
        if (p.page.interrupted) {
          agent(ctx, ax, 250, { frame: f, scale: sc, mood: 'shock', l: [-40, -60], r: [40, -60] });
          const sp = spring(f - 10, { damping: 9, stiffness: 150 });
          if (sp > 0.01) {
            ctx.save();
            ctx.translate(ax + 70 * sc + 30, 120);
            ctx.scale(sp, sp);
            ctx.beginPath();
            for (let i = 0; i < 8; i++) {
              const a = (i / 8) * TAU + Math.PI / 8;
              ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * 30, Math.sin(a) * 30);
            }
            ctx.closePath();
            inked(ctx, C.magenta, 3);
            ctx.fillStyle = C.balloon;
            ctx.font = `13px ${DISPLAY}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('STOP', 0, 1);
            ctx.restore();
          }
          return;
        }
        // Not a clean finish (nothing worked, work still out, or Claude named an open problem): no party.
        const calm =
          p.page.noneWorked ||
          p.page.helpersRunning ||
          p.page.finishedLater ||
          p.page.openNote ||
          p.page.events.some((e) => e.running && !e.helper);
        if (calm) {
          agent(ctx, ax, 250, { frame: f, scale: sc, mood: 'neutral', l: [-34, -48], r: [34, -48] });
          return;
        }
        const colors = [C.cyan, C.magenta, C.yellow, C.go];
        for (let i = 0; i < 42; i++) {
          const x = rnd(i) * W;
          const y = ((rnd(i + 99) * (H + 40) + f * (0.7 + rnd(i + 7) * 0.9)) % (H + 40)) - 20;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(i + f * 0.05 * (rnd(i + 3) - 0.5) * 4);
          ctx.fillStyle = colors[i % 4];
          ctx.fillRect(-4, -2.5, 8, 5);
          ctx.restore();
        }
        const j = Math.abs(Math.sin(f / 8)) * 8;
        if (p.page.helpers) {
          const spread = wide ? 108 : 74;
          const hs = wide ? 0.55 : 0.4;
          agent(ctx, ax - spread, 250, {
            frame: f + 30,
            scale: hs,
            body: C.magenta,
            mood: 'happy',
            l: [-30, -60],
            r: [30, -104 + Math.sin(f / 6) * 8],
          });
          if (p.page.helpers > 1)
            agent(ctx, ax + spread, 250, {
              frame: f + 60,
              scale: hs,
              body: C.yellow,
              mood: 'happy',
              l: [-30, -104 + Math.cos(f / 6) * 8],
              r: [30, -60],
            });
        }
        agent(ctx, ax, 250 - j, {
          frame: f,
          scale: sc,
          mood: 'happy',
          l: [-40, -122],
          r: [40, -122],
          bendL: 12,
          bendR: -12,
        });
      },
    },
  };

  /**
   * A scene's layout at its finished frame, drawn on a 1x1 scratch canvas: its click regions and where
   * Claude stands (stage units). Balloons are placed from this, never from the frame on screen, where
   * an entrance still has objects in flight and the panel would change height with them.
   */
  let scratch;
  function layout(kind, W, p) {
    const scene = SCENES[kind];
    if (scratch === undefined) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      scratch = c.getContext('2d');
    }
    if (!scene || !scratch) return null;
    const hits = [];
    takeSpeaker();
    scratch.save();
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    try {
      scene.draw(scratch, W, VH, HERO, p, (id, x, y, w, h) => hits.push({ id, x, y, w, h }));
    } finally {
      scratch.restore();
    }
    return { hits, speaker: takeSpeaker() };
  }

  return { FPS, HERO, VH, C, readColors, spring, SCENES, takeSpeaker, editsOf, inBand, layout };
})();

/** Panel kinds as the wire's group headings name them. */
const STORY_KIND_NAMES = {
  mission: 'The mission',
  investigate: 'Investigating',
  research: 'Looking it up',
  plan: 'The plan',
  backup: 'Calling backup',
  fix: 'The fix',
  check: 'The check',
  loop: 'Fix and test',
  run: 'In the terminal',
  save: 'Saving',
  ask: 'Your call',
  compact: 'Packing up',
  montage: 'Montage',
  complete: 'The end',
};

/** How wide a panel wants to be on the 6-column page. Rows are then filled exactly. */
function storyPreferredSpan(panel) {
  if (panel.kind === 'complete') return 6;
  if (panel.kind === 'mission' || panel.kind === 'fix' || panel.kind === 'loop' || panel.kind === 'plan') return 3;
  if (panel.kind === 'backup') return (panel.helpers?.length || 0) >= 2 ? 4 : 3;
  return 2;
}

/** Spans for a row width of `cols`: the last panel of a row stretches to fill it. */
function storyLayoutSpans(prefs, cols) {
  const spans = [];
  let left = cols;
  prefs.forEach((pref, i) => {
    const want = Math.min(cols, Math.max(1, pref));
    if (want > left && left < cols) {
      spans[i - 1] += left;
      left = cols;
    }
    spans.push(want);
    left -= want;
    if (left === 0) left = cols;
  });
  if (left !== cols && spans.length) spans[spans.length - 1] += left;
  return spans;
}

/**
 * Reading levels, in the order the bar shows them: Simple for someone who has never seen a terminal,
 * Advanced (the plain story), Director's cut (the wire and the tool captions).
 */
const STORY_LEVELS = ['simple', 'advanced', 'director'];
/** The level a reader gets until they pick one (owner: the Director's cut, for now). */
const STORY_LEVEL_DEFAULT = 'director';
/** Where the reader's pick is kept, per device. */
const STORY_LEVEL_KEY = 'codeman:story-level';

/** Shortest row a page draws, in CSS px: the height the scenes and the comic text were drawn for. */
const STORY_ROW_MIN = 270;
/**
 * Tallest row, in CSS px: twice the drawn size. A row past it holds mostly background (a turn that
 * just started is one row of two panels), and the comic text, which stops growing at
 * STORY_TEXT_MAX, would look lost in art drawn more than twice its size.
 */
const STORY_ROW_MAX = 540;
/**
 * The narrowest stage, in scene units, that keeps all of a scene's art on the panel: the mission's
 * exclamation mark beside Claude's head (at 0.78 of the width) runs off the right edge below about
 * 278. A row is never so tall that its narrowest panel's stage gets narrower, so a narrow panel
 * stays about as wide as it is tall, never a portrait.
 */
const STORY_STAGE_MIN = 280;
/**
 * The final panel's narrowest stage: under 420 units its scene centres Claude, behind the words on
 * its left. Its row may still be taller (it takes what the narrow rows cannot); the scene then
 * stands at the bottom, the words above it, as it does when the words make the panel taller.
 */
const STORY_FINAL_STAGE_MIN = 440;
/** The comic text grows with the rows up to this factor (`--story-k`); a caption in a narrow panel would wrap past its band beyond it. */
const STORY_TEXT_MAX = 1.45;

/** Each item's row, and the items in each row, for `spans` on a page `cols` wide. */
function storyLayoutRows(spans, cols) {
  const rowOf = [];
  const rows = [];
  let used = 0;
  spans.forEach((span, i) => {
    if (!used) rows.push([]);
    rows[rows.length - 1].push(i);
    rowOf.push(rows.length - 1);
    used += span;
    if (used >= cols) used = 0;
  });
  return { rowOf, rows };
}

/**
 * Row heights, in whole CSS px, that make a page that fits fill the visible height, and each item's
 * stage (the height its scene is drawn at, `--story-panel-min`). The height is shared evenly; a row
 * never goes under STORY_ROW_MIN (a longer page keeps its rows and scrolls) nor over its cap
 * (STORY_ROW_MAX, and the height at which a panel's stage would fall under STORY_STAGE_MIN wide),
 * and what a capped row cannot take goes to the rows that can (the final panel's full-width row,
 * mostly). Rounded down, so the rows never overflow by a fraction and raise a scrollbar.
 * `box` is the page's content box: `width` across, `height` the visible height the rows may take,
 * `gap` between rows and columns; `stageMin` each item's narrowest stage in scene units (default
 * STORY_STAGE_MIN; 0 for an item without art, the pencils); and `lastRow` the height the last row
 * takes once its words made it taller (the final panel's are in flow): the other rows give that up,
 * so the page still ends at the bottom. The text scale `k` (the shortest row over STORY_ROW_MIN) is
 * settled before that, so the words that set `lastRow` never change with it. One column (a phone)
 * gives null: its panels keep their natural heights.
 * @returns {{ heights: number[], stage: number[], rowOf: number[], k: number, fill: number, caps: number[] } | null}
 */
function storyRowHeights(spans, cols, { width, height, gap = 0, stageMin = [], lastRow = 0 }) {
  if (!(cols >= 2) || !spans?.length || !(width > 0) || !(height > 0)) return null;
  const { rowOf, rows } = storyLayoutRows(spans, cols);
  const col = (width - gap * (cols - 1)) / cols;
  // The tallest row an item allows: its stage, its width wide in scene units, no narrower than `min`.
  const tallest = (i, min) => {
    const n = Math.min(cols, spans[i]);
    return min > 0 ? ((n * col + (n - 1) * gap) * StoryArt.VH) / min : Infinity;
  };
  const own = (i) => stageMin[i] ?? STORY_STAGE_MIN;
  const caps = rows.map((items) =>
    Math.max(STORY_ROW_MIN, Math.min(STORY_ROW_MAX, ...items.map((i) => tallest(i, Math.min(own(i), STORY_STAGE_MIN)))))
  );
  /** `total` shared by the rows in `which`, evenly, up to each row's cap; the rest to the others. */
  const share = (which, total) => {
    const out = new Map();
    let open = which;
    let left = total;
    while (open.length) {
      const even = left / open.length;
      const full = open.filter((r) => caps[r] < even);
      if (!full.length) {
        for (const r of open) out.set(r, even);
        break;
      }
      for (const r of full) {
        out.set(r, caps[r]);
        left -= caps[r];
      }
      open = open.filter((r) => caps[r] >= even);
    }
    return which.map((r) => Math.max(STORY_ROW_MIN, Math.floor(out.get(r))));
  };
  const n = rows.length;
  const avail = height - gap * (n - 1);
  const all = rows.map((_, r) => r);
  let heights = share(all, avail);
  const k = Math.round(Math.min(STORY_TEXT_MAX, Math.min(...heights) / STORY_ROW_MIN) * 1000) / 1000;
  const others = heights.slice(0, -1).reduce((a, h) => a + h, 0);
  if (n > 1 && lastRow > heights[n - 1] && others + lastRow > avail)
    heights = [...share(all.slice(0, -1), avail - lastRow), heights[n - 1]].map((h, r) => Math.min(h, heights[r]));
  const stage = spans.map((_, i) =>
    Math.max(STORY_ROW_MIN, Math.min(heights[rowOf[i]], Math.floor(tallest(i, own(i)))))
  );
  return { heights, stage, rowOf, k, fill: avail / n, caps };
}

/**
 * How far down a speech balloon may reach, and how much taller its panel must grow for the balloon to
 * keep `keep` px (its padding and the lines it must show). Everything is in panel px at the panel's
 * usual height: `obstacles` ({ x0, x1, y }: the scene's objects and Claude's face) and `floor` (the
 * bottom edge, Claude's head) stand on the stage, so a panel grown by g moves each of them down by g
 * while the balloon keeps its `top`. The result therefore does not depend on the grown height: a
 * second pass over a grown panel asks for the same growth, never more.
 * An obstacle under the body (`x0`..`x1`) must start below it; one under the tail (`tail`: { x0, x1,
 * h }, the point below the body) must start below the tail's tip.
 */
function storyBalloonRoom({ top, x0, x1, tail = null, obstacles = [], floor, keep, gap = 4 }) {
  let limit = floor;
  for (const o of obstacles) {
    if (o.x1 > x0 - gap && o.x0 < x1 + gap) limit = Math.min(limit, o.y - gap);
    if (tail && o.x1 > tail.x0 - gap && o.x0 < tail.x1 + gap) limit = Math.min(limit, o.y - tail.h - gap);
  }
  return { limit, grow: Math.max(0, top + keep - limit) };
}

Object.assign(CodemanApp.prototype, {
  /** Per-device setting, default OFF. */
  isStoryButtonEnabled() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    return (settings.showStoryButton ?? defaults.showStoryButton ?? false) === true;
  },

  /** Called from applyHeaderVisibilitySettings() on boot and after every settings save. */
  applyStoryButtonVisibility() {
    const on = this.isStoryButtonEnabled();
    document.querySelector('.btn-story-header')?.classList.toggle('btn-story-header--hidden', !on);
    // Session Options carries a Story button too: the way in on phones, where the header has no room.
    const optionsBtn = document.getElementById('sessionOptionsStoryBtn');
    if (optionsBtn) optionsBtn.hidden = !on;
    if (!on) this.closeStoryMode();
  },

  /** Session Options → Story: this session's story, whichever tab is active. */
  openStoryFromOptions() {
    const id = this.editingSessionId;
    if (!id) return;
    this.closeSessionOptions?.();
    this.openStoryMode(id);
  },

  toggleStoryMode() {
    if (this._story?.open) this.closeStoryMode();
    else this.openStoryMode();
  },

  openStoryMode(sessionId = this.activeSessionId) {
    if (!sessionId) {
      this.showToast?.('Open a session first, then Story Mode draws what it does.', 'info');
      return;
    }
    const st = this._storyState();
    // Opened again while open (another session): one runtime, never two frame loops and polls.
    if (st.open) this._storyStopRuntime();
    else st.returnFocus = document.activeElement;
    st.open = true;
    st.sessionId = sessionId;
    st.turnId = null;
    st.data = null;
    st.error = null;
    st.etag = null;
    st.helperSteps = new Map();
    st.epoch++;
    st.first = true;
    st.drawer = null;
    st.drawerHolds = false;
    // What was said and shown belongs to the last session drawn, not this one.
    st.announced = undefined;
    st.knownTurns = undefined;
    st.shownPageId = undefined;
    st.picked = false;
    // A request still out from before is ignored (its epoch is old); it must not block this one.
    st.inFlight = 0;
    st.again = false;
    st.root.hidden = false;
    document.body.classList.add('story-open');
    this._storyApplyTheme();
    const session = this.sessions?.get(sessionId);
    st.sessionLabel.textContent = session
      ? this.getSessionName?.(session) || session.name || sessionId.slice(0, 8)
      : sessionId.slice(0, 8);
    st.root.setAttribute('aria-label', `Story Mode: ${st.sessionLabel.textContent}`);
    this._storyRender();
    this._storyStartRuntime();
    this._storyRefresh();
    st.closeBtn.focus({ preventScroll: true });
  },

  /** Hides the overlay and stops everything it runs. Safe to call when it is not open. */
  closeStoryMode() {
    const st = this._story;
    if (!st?.open) return;
    st.open = false;
    st.epoch++;
    st.root.hidden = true;
    document.body.classList.remove('story-open');
    this._storyStopRuntime();
    this._storyCloseDrawer({ refocus: false });
    for (const rt of st.panels) this._storyDropPanel(rt);
    // Full-size backing canvases (megabytes each at 2x): not kept once Story Mode is closed.
    storyBgCache.clear();
    st.panels = [];
    st.pageEl.replaceChildren();
    st.wireList.replaceChildren();
    st.data = null;
    st.etag = null;
    st.helperSteps = null;
    const back = st.returnFocus;
    st.returnFocus = null;
    if (back && document.contains(back)) back.focus({ preventScroll: true });
  },

  /** SSE activity (transcript tool events, stop and prompt hooks) for any session. */
  _storyOnActivity(e) {
    const st = this._story;
    if (!st?.open) return;
    let data = {};
    try {
      data = e?.data ? JSON.parse(e.data) : {};
    } catch {
      return;
    }
    if (data.sessionId !== st.sessionId || st.turnId) return;
    this._storyScheduleRefresh();
  },

  // ── State and DOM ──

  _storyState() {
    if (this._story) return this._story;
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const btn = (cls, text, label) => {
      const b = el('button', cls, text);
      b.type = 'button';
      if (label) b.setAttribute('aria-label', label);
      return b;
    };
    const root = el('div', 'story-overlay');
    root.id = 'storyOverlay';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Story Mode');
    // A file preview opened from a panel sits beside the overlay, not in it: while it is up the
    // overlay is no longer modal, or a screen reader that honours aria-modal would hide it.
    root.addEventListener('focusin', () => {
      if (!document.getElementById('filePreviewOverlay')?.classList.contains('visible'))
        root.setAttribute('aria-modal', 'true');
    });

    const bar = el('div', 'story-bar');
    const brand = el('div', 'story-brand');
    const title = el('span', 'story-title', 'Story');
    title.id = 'storyTitle';
    const sessionLabel = el('span', 'story-session');
    sessionLabel.dataset.i18nSkip = '';
    brand.append(title, sessionLabel);

    const nav = el('div', 'story-nav');
    const prev = btn('story-btn story-prev', '‹', 'Previous turn');
    const turnSelect = el('select', 'story-turns');
    turnSelect.setAttribute('aria-label', 'Turn');
    turnSelect.dataset.i18nSkip = '';
    const next = btn('story-btn story-next', '›', 'Next turn');
    nav.append(prev, turnSelect, next);

    const seg = el('div', 'story-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Reading level');
    const levelBtns = {
      simple: btn('story-seg-btn', 'Simple'),
      advanced: btn('story-seg-btn', 'Advanced'),
      director: btn('story-seg-btn', "Director's cut"),
    };
    levelBtns.simple.title = 'Plain words, for anyone';
    levelBtns.advanced.title = 'The story, with file names';
    levelBtns.director.title = 'Every step and tool, with the wire';
    seg.append(...STORY_LEVELS.map((lv) => levelBtns[lv]));

    const live = el('span', 'story-live');
    live.append(el('i'), el('span', null, 'LIVE'));
    live.hidden = true;
    const saveBtn = btn('story-btn story-save', 'Save image', 'Save this page as an image');
    saveBtn.title = 'Save this page as a PNG to share';
    const closeBtn = btn('story-btn story-close', '×', 'Close Story Mode');
    // The turn picker lives in the composer at the bottom (_storyComposeBuild): the prompts you sent and
    // the one you write next, in one bar.
    bar.append(brand, seg, live, saveBtn, closeBtn);
    // What a screen reader hears as the page changes: a new turn, a finished one.
    const announcer = el('p', 'story-sr');
    announcer.dataset.i18nSkip = ''; // it reads out the agent's prompts
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');

    const main = el('div', 'story-main');
    const note = el('p', 'story-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    note.dataset.i18nSkip = '';
    const stage = el('div', 'story-stage');
    const sheet = el('div', 'story-sheet');
    const pageEl = el('section', 'story-page');
    pageEl.dataset.i18nSkip = '';
    sheet.append(pageEl);
    const wire = el('aside', 'story-wire');
    wire.setAttribute('aria-label', 'Every event behind this page');
    const wireHead = el('header', 'story-wire-head');
    const wireCount = el('p', 'story-wire-sub');
    wireHead.append(el('p', 'story-wire-title', 'The wire'), wireCount);
    const wireList = el('ol', 'story-wire-list');
    wireList.dataset.i18nSkip = '';
    const { foot: wireFoot, pill: wirePill } = this._storyWireControls(wire, wireList);
    wire.append(wireHead, wireList, wireFoot);
    stage.append(sheet, wire);
    main.append(note, stage);

    const drawer = el('aside', 'story-drawer');
    drawer.hidden = true;
    drawer.setAttribute('role', 'dialog');
    const drawerHead = el('header', 'story-drawer-head');
    // A sheet comes down the way it went up: drag its head down to close it.
    let dragFrom = null;
    drawerHead.addEventListener('touchstart', (e) => (dragFrom = e.touches[0]?.clientY ?? null), { passive: true });
    drawerHead.addEventListener(
      'touchend',
      (e) => {
        const y = e.changedTouches[0]?.clientY;
        if (dragFrom !== null && y !== undefined && y - dragFrom > 70) this._storyCloseDrawer();
        dragFrom = null;
      },
      { passive: true }
    );
    const drawerKind = el('span', 'story-drawer-kind');
    const drawerLive = el('span', 'story-live story-drawer-live');
    drawerLive.append(el('i'), el('span', null, 'LIVE'));
    drawerLive.hidden = true;
    const drawerMeta = el('div', 'story-drawer-meta');
    drawerMeta.append(drawerKind, drawerLive);
    const drawerTitle = el('p', 'story-drawer-title');
    drawerTitle.id = 'storyDrawerTitle';
    drawerKind.id = 'storyDrawerKind';
    drawer.setAttribute('aria-labelledby', 'storyDrawerKind storyDrawerTitle');
    const drawerSub = el('p', 'story-drawer-sub');
    drawerTitle.dataset.i18nSkip = '';
    drawerSub.dataset.i18nSkip = '';
    const drawerClose = btn('story-btn story-drawer-close', '×', 'Close details');
    drawerHead.append(drawerMeta, drawerTitle, drawerSub, drawerClose);
    const drawerBody = el('div', 'story-drawer-body');
    drawerBody.dataset.i18nSkip = '';
    drawer.append(drawerHead, drawerBody);

    root.append(bar, main, drawer, announcer);
    document.body.appendChild(root);

    const st = {
      open: false,
      epoch: 0,
      sessionId: null,
      turnId: null,
      data: null,
      error: null,
      // The reading level; `director` stays a plain boolean for the wire and the scenes.
      level: STORY_LEVEL_DEFAULT,
      director: false,
      first: true,
      panels: [],
      drawer: null,
      drawerSeen: new Set(),
      inFlight: false,
      again: false,
      refreshTimer: null,
      pollTimer: null,
      raf: 0,
      returnFocus: null,
      root,
      bar,
      sessionLabel,
      turnSelect,
      prev,
      next,
      levelBtns,
      live,
      closeBtn,
      saveBtn,
      note,
      stage,
      mainEl: main,
      pageEl,
      wire,
      wireCount,
      wireList,
      wirePill,
      navEl: nav,
      drawerEl: drawer,
      drawerKind,
      drawerLive,
      drawerTitle,
      drawerSub,
      drawerBody,
    };
    this._story = st;
    this._storyComposeBuild(st);

    closeBtn.addEventListener('click', () => this.closeStoryMode());
    saveBtn.addEventListener('click', () => this.saveStoryImage());
    drawerClose.addEventListener('click', () => this._storyCloseDrawer());
    for (const lv of STORY_LEVELS)
      levelBtns[lv].addEventListener('click', () => this._storySetLevel(lv, { remember: true }));
    turnSelect.addEventListener('change', () => this._storyPickTurn(turnSelect.value));
    prev.addEventListener('click', () => this._storyStepTurn(-1));
    next.addEventListener('click', () => this._storyStepTurn(1));
    // One delegate for every clickable thing on the page and in the drawer.
    root.addEventListener('click', (e) => {
      const t = e.target.closest?.('[data-story-open]');
      if (t && root.contains(t)) {
        e.preventDefault();
        this._storyOpenTarget(t.dataset.storyOpen, t);
      }
    });
    this._storySetLevel(this._storyStoredLevel());
    return st;
  },

  _storyApplyTheme() {
    const st = this._story;
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    st.root.classList.toggle('story-paper', /light/.test(scheme) && !/dark/.test(scheme));
    StoryArt.readColors(st.root);
    for (const rt of st.panels) rt.bgKey = '';
  },

  /** The reading level this device last picked; an unknown or unreadable value is the default. */
  _storyStoredLevel() {
    try {
      const level = localStorage.getItem(STORY_LEVEL_KEY);
      if (STORY_LEVELS.includes(level)) return level;
    } catch {
      // Storage refused (a private window, blocked site data): the default level.
    }
    return STORY_LEVEL_DEFAULT;
  },

  /** Kept for callers of the two-level toggle: on is the Director's cut, off the Advanced story. */
  _storySetDirector(on) {
    this._storySetLevel(on ? 'director' : 'advanced');
  },

  /**
   * Switches the reading level. Only the reader's own pick (`remember`) is kept for the next visit:
   * opening Story Mode never writes the default back, so changing the default stays a one-line change.
   */
  _storySetLevel(level, { remember = false } = {}) {
    const st = this._story;
    if (!STORY_LEVELS.includes(level)) level = STORY_LEVEL_DEFAULT;
    const on = level === 'director';
    st.level = level;
    st.director = on;
    st.root.classList.toggle('is-simple', level === 'simple');
    st.root.classList.toggle('is-director', on);
    for (const lv of STORY_LEVELS) st.levelBtns[lv].setAttribute('aria-pressed', String(lv === level));
    if (remember) {
      try {
        localStorage.setItem(STORY_LEVEL_KEY, level);
      } catch {
        // Not kept: the level still applies to this visit.
      }
    }
    st.wire.hidden = !on;
    if (on) this._storyRenderWire();
    // Each level has its own words (and Simple hides Claude's balloons): the panels refill and refit
    // to them. Drawn within the frame budget, never every panel in one task.
    const page = st.data?.supported ? st.data.page : null;
    st.panels.forEach((rt, i) => {
      if (page && rt.panel) this._storyFillPanelText(rt, page, i);
      else this._storyFitCaption(rt);
      this._storyQueueDraw(rt);
    });
  },

  _storyPickTurn(id) {
    const st = this._story;
    st.picked = true; // a turn you chose is not news to announce
    st.drawerHolds = false; // your choice wins over a page held for a drawer
    const turns = st.data?.turns || [];
    st.turnId = id && id !== turns[turns.length - 1]?.id ? id : null;
    st.first = true;
    st.etag = null;
    st.epoch++;
    this._storyCloseDrawer({ refocus: false });
    this._storyRefresh();
  },

  _storyStepTurn(delta) {
    const st = this._story;
    const turns = st.data?.turns || [];
    const current = st.data?.page?.id;
    const idx = turns.findIndex((t) => t.id === current);
    const target = turns[idx + delta];
    if (target) this._storyPickTurn(target.id);
  },

  // ── Composer: a message to the session on the page ──

  /**
   * The bar under the page: a field and Send. It talks to the session the overlay shows
   * (`st.sessionId`), never the active tab, since Session Options opens Story for any session.
   * Drafts live in memory per session id for the life of the page (prompts carry secrets, so they
   * are never persisted). The bar is outside `.story-main`, so a drawer that makes the page inert
   * leaves it usable, and outside the page, so Save image never draws it.
   */
  _storyComposeBuild(st) {
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const box = el('div', 'story-compose');
    const inner = el('div', 'story-compose-inner');
    const row = el('div', 'story-compose-row');
    const field = el('textarea', 'story-compose-field');
    field.rows = 1;
    field.dataset.i18nSkip = ''; // what is typed is the user's, never translated
    field.setAttribute('autocapitalize', 'sentences');
    field.setAttribute('enterkeyhint', 'send');
    field.spellcheck = true;
    const hint = el('p', 'story-compose-hint');
    hint.id = 'storyComposeHint';
    field.setAttribute('aria-describedby', hint.id);
    const send = el('button', 'story-compose-send', 'Send');
    send.type = 'button';
    send.title = 'Send to Claude (Enter). Shift+Enter adds a line.';
    // i18n.js skips <textarea> subtrees, so its label and placeholder are translated here.
    const t = typeof window.CodemanI18n?.t === 'function' ? (s) => window.CodemanI18n.t(s) : (s) => s;
    field.setAttribute('aria-label', t('Message Claude'));
    field.placeholder = t('Tell Claude what to do next');
    // The turn picker on the left (the prompts already sent), then the next one: one prompt bar.
    row.append(st.navEl, field, send, hint);
    inner.append(row);
    box.append(inner);
    // Between the page and the drawer: Tab walks bar, page, composer, then an open drawer.
    st.root.insertBefore(box, st.drawerEl);
    st.drafts = new Map();
    st.compose = { el: box, field, send, hint, hintText: '', boundId: null, state: 'ready', blocked: false };

    field.addEventListener('input', () => {
      const id = st.compose.boundId;
      if (id) {
        if (field.value) st.drafts.set(id, field.value);
        else st.drafts.delete(id);
      }
      this._storyComposeFit();
      this._storyComposeSync();
    });
    field.addEventListener('focus', () => this._storyComposeSync());
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      // An IME commits what it composes with Enter: that Enter belongs to the IME, never a send.
      if (e.isComposing || e.keyCode === 229) return;
      // Plain Enter never inserts a line here, even when sending is blocked (a dialog waits, the
      // session is gone): the hint says why, and the draft stays as it was.
      e.preventDefault();
      this._storySendCompose();
    });
    send.addEventListener('click', () => this._storySendCompose());
    // The drawer ends above the composer and app toasts sit above it (story-mode.css reads the height).
    // A custom property on body reaches both: the overlay inherits it, and toasts live in body.
    if (typeof ResizeObserver === 'function') {
      let width = 0;
      new ResizeObserver(() => {
        if (!st.open) return;
        // A new width rewraps the text: the field takes its new height (the next callback then
        // reports the bar's settled height).
        if (box.offsetWidth !== width) {
          width = box.offsetWidth;
          this._storyComposeFit();
        }
        document.body.style.setProperty('--story-compose-h', `${box.offsetHeight}px`);
      }).observe(box);
    }
  },

  /**
   * Whether a message can go to the session now, and the hint that says so. Blocked states keep the
   * field (a draft can still be written) but never send.
   * @returns {{ state: 'gone'|'exited'|'unsupported'|'waiting'|'working'|'ready', hint: string }}
   */
  _storyComposeState() {
    const st = this._story;
    const session = this.sessions?.get(st.sessionId);
    if (!session || st.goneId === st.sessionId)
      return { state: 'gone', hint: 'This session is gone, so there is nothing to send to.' };
    if (typeof paneExitLabel === 'function' && paneExitLabel(session.paneExit))
      return { state: 'exited', hint: 'Claude has exited in this session, so nothing can be sent.' };
    // The server could not draw this session (a shell, another CLI, a remote host): text plus Enter
    // in a shell would run as a command, so the bar sends only to sessions Story Mode reads.
    if (st.data && st.data.supported === false)
      return { state: 'unsupported', hint: 'Story Mode sends only to the Claude Code sessions it can draw.' };
    // Claude waits on a question or a permission in the terminal. A message there would land in the
    // selection dialog, where its Enter picks whatever option is highlighted (often "Yes"), so
    // sending is off until it is answered; the field still takes a draft. The page shows a pending
    // question of the newest turn; a permission prompt never reaches the transcript, only the hook
    // (and a reader parked on an older turn sees only the hook).
    const page = st.data?.supported ? st.data.page : null;
    const asking =
      !st.turnId && !!page && !page.complete && !page.interrupted && page.events.some((e) => e.question && e.pending);
    const hooks = this.pendingHooks?.get(st.sessionId);
    if (asking || hooks?.has('permission_prompt') || hooks?.has('elicitation_dialog'))
      return {
        state: 'waiting',
        hint: 'Claude is waiting for your answer in the terminal. Answer it there; your message waits here.',
      };
    const turns = st.data?.supported ? st.data.turns || [] : [];
    const newest = turns[turns.length - 1];
    // Claude Code queues a message typed during a turn, so sending while it works is fine.
    if (newest && !newest.complete && !newest.interrupted)
      return { state: 'working', hint: 'Claude is working. What you send now waits in line for it.' };
    return { state: 'ready', hint: 'Enter sends. Shift+Enter adds a line.' };
  },

  /** Brings the bar in line with the session: its draft, whether it can send, the hint. */
  _storyComposeSync() {
    const st = this._story;
    const c = st?.compose;
    if (!c || !st.sessionId) return;
    if (c.boundId !== st.sessionId) {
      // Another session on the page: its own draft (the old one was saved on every keystroke).
      c.boundId = st.sessionId;
      c.field.value = st.drafts.get(st.sessionId) || '';
      this._storyComposeFit();
    }
    const { state, hint } = this._storyComposeState();
    c.state = state;
    c.blocked = state !== 'ready' && state !== 'working';
    c.el.dataset.state = state;
    // Gone for good: the draft stays readable (and copyable), not editable.
    c.field.readOnly = state === 'gone' || state === 'exited' || state === 'unsupported';
    const off = c.blocked || !c.field.value.trim();
    // A button that is about to be disabled under focus hands it to the field first.
    if (off && document.activeElement === c.send) c.field.focus({ preventScroll: true });
    c.send.disabled = off;
    // Compared with the last English text set, never the DOM (i18n.js may have translated it).
    if (c.hintText !== hint) {
      c.hintText = hint;
      c.hint.textContent = hint;
    }
  },

  /** The field grows with its text up to the CSS max-height (about five lines), then scrolls. */
  _storyComposeFit() {
    const f = this._story?.compose?.field;
    if (!f) return;
    f.style.height = 'auto';
    const h = f.scrollHeight;
    // No layout (a hidden overlay, a test DOM): leave the field at its natural one line.
    if (h > 0) f.style.height = `${h + f.offsetHeight - f.clientHeight}px`;
    else f.style.height = '';
  },

  /**
   * Sends the field to the session on the page through the mobile composer's tested path
   * (KeyboardAccessoryBar._sendComposedPrompt: one bracketed paste on the durable exactly-once
   * input queue, then Enter as a separate delayed write, plus the too-long toast). Never text and
   * `\r` in one write: Claude Code reads a long burst as a paste and its Enter as a newline.
   * @returns {boolean} whether it went out
   */
  _storySendCompose() {
    const st = this._story;
    const c = st?.compose;
    if (!st?.open || !c) return false;
    // Fresh: a dialog that opened since the last poll still blocks this Enter.
    this._storyComposeSync();
    const text = c.field.value;
    // Whitespace-only would submit blank lines; real text goes out untrimmed.
    if (c.blocked || !text.trim()) return false;
    const bar = typeof KeyboardAccessoryBar !== 'undefined' ? KeyboardAccessoryBar : null;
    if (typeof bar?._sendComposedPrompt !== 'function') {
      this.showToast?.('Sending is not available on this page. Use the terminal.', 'error');
      return false;
    }
    const sessionId = st.sessionId;
    if (!bar._sendComposedPrompt(sessionId, text)) return false;
    st.drafts.delete(sessionId);
    c.field.value = '';
    this._storyComposeFit();
    this._storyComposeSync();
    c.field.focus({ preventScroll: true });
    // The answer is a new turn. A reader parked on an older one (or held there by a drawer) would
    // never see it, since activity is ignored while parked: go to the newest, as the picker does.
    if (st.turnId || st.drawer) {
      const turns = st.data?.turns || [];
      this._storyPickTurn(turns[turns.length - 1]?.id ?? null);
    }
    // The prompt hook refreshes when Claude takes it; this one covers a workspace without hooks.
    this._storyScheduleRefresh(1500);
    return true;
  },

  /**
   * Escape in the field while it holds text steps out of the field first (focus to Close) instead
   * of closing a layer: an Escape mid-sentence is far more often a slip than a request to leave.
   * The draft would survive a close anyway (kept per session); this keeps the reader in place.
   * An empty field lets Escape close one layer, as everywhere else on the overlay.
   * @returns {boolean} whether this Escape was handled
   */
  _storyComposeEscape(e) {
    const st = this._story;
    const c = st?.compose;
    if (!c || document.activeElement !== c.field || !c.field.value.trim()) return false;
    e.preventDefault();
    e.stopPropagation();
    st.closeBtn.focus({ preventScroll: true });
    return true;
  },

  // ── Fetching ──

  _storyScheduleRefresh(delay = STORY_REFRESH_DEBOUNCE_MS) {
    const st = this._story;
    if (!st?.open) return;
    clearTimeout(st.refreshTimer);
    st.refreshTimer = setTimeout(() => this._storyRefresh(), delay);
  },

  async _storyRefresh() {
    const st = this._story;
    if (!st?.open) return;
    if (st.inFlight) {
      st.again = true;
      return;
    }
    const mine = (st.requestSeq = (st.requestSeq || 0) + 1);
    st.inFlight = mine;
    const epoch = st.epoch;
    try {
      const qs = st.turnId ? `?turn=${encodeURIComponent(st.turnId)}` : '';
      // A request that never settles must not wedge the view: after the timeout it counts as failed.
      let timer;
      const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(null), STORY_REQUEST_TIMEOUT_MS)));
      const res = await Promise.race([
        this._api(`/api/sessions/${encodeURIComponent(st.sessionId)}/story${qs}`),
        timeout,
      ]).finally(() => clearTimeout(timer));
      if (epoch !== st.epoch || !st.open) return;
      // The route sends an ETag and no-cache, so the browser revalidates and an unchanged page comes
      // back from its cache with the same tag: nothing to parse, nothing to redraw.
      const etag = res?.ok ? res.headers?.get?.('etag') || null : null;
      if (etag && etag === st.etag && !st.error) {
        // The page holds still, but a helper still working writes only to its own transcript (a
        // foreground helper adds nothing to this one until it returns): its open drawer refreshes.
        this._storyRefreshWorkingHelpers();
        return;
      }
      let body = null;
      try {
        body = res ? await res.json() : null;
      } catch {
        body = null;
      }
      if (epoch !== st.epoch || !st.open) return;
      // The route answers 404 only for a session that no longer exists: the composer stops sending.
      // Kept with its id, so opening Story for another session never inherits it.
      st.goneId = res?.status === 404 ? st.sessionId : null;
      if (!res || !res.ok || !body?.success) {
        st.error =
          body?.error || (res?.status === 404 ? 'This session is gone.' : 'Story Mode could not read this session.');
      } else {
        st.error = null;
        const held = st.drawer?.pageId;
        if (held && !st.turnId && body.data.page && body.data.page.id !== held && st.data?.page?.id === held) {
          // The newest turn moved on while a drawer reads this one: hold this turn (the picker
          // already lists the new one) until the drawer closes, and fetch this turn's last state.
          st.turnId = held;
          st.drawerHolds = true;
          st.data = { ...body.data, page: st.data.page };
          st.etag = null;
          st.again = true;
          const box = st.root.querySelector('.story-sr');
          if (box)
            box.textContent =
              'A new turn started. This page stays on the turn you are reading until you close the panel.';
        } else {
          st.data = body.data;
          st.etag = etag;
        }
      }
      this._storyRender();
    } finally {
      if (st.inFlight === mine) {
        st.inFlight = 0;
        if (st.again) {
          st.again = false;
          this._storyScheduleRefresh(250);
        }
      }
    }
  },

  /** An open drawer's helpers that are still working fetch their newest steps (each ETag'd). */
  _storyRefreshWorkingHelpers() {
    const st = this._story;
    if (!st?.drawer) return;
    for (const box of st.drawerBody.querySelectorAll('.story-helper-steps'))
      if (box.dataset.working === '1') this._storyFillHelperSteps(box, box.dataset.agent, true);
  },

  // ── Runtime: frame loop, observers, poll, Escape ──

  _storyStartRuntime() {
    const st = this._story;
    const bar = st.root.querySelector('.story-bar');
    const sheet = st.pageEl.parentElement;
    st.sheetW = undefined;
    st.pageH = undefined;
    cancelAnimationFrame(st.layoutRaf || 0);
    st.layoutRaf = 0;
    st.ro = new ResizeObserver((entries) => {
      // The main area's box (the window, the drawer's padding, a bar above or below it) or the
      // sheet's width (the Director's cut wire takes some) sets the row heights: once per delivery,
      // before the panels re-size to them. The page's height changes with its words too (another
      // reading level, a caption that grew, the fonts arriving), which the final panel's row
      // measures: that pass waits for the next frame, so a pass that moves the page's own height
      // is never reported back in the same one. Same boxes, same values, nothing written: no loop.
      let relayout = false;
      let later = false;
      for (const entry of entries) {
        if (entry.target === st.mainEl) relayout = true;
        else if (entry.target === sheet && Math.abs(entry.contentRect.width - (st.sheetW ?? -1)) > 0.5) {
          st.sheetW = entry.contentRect.width;
          relayout = true;
        } else if (entry.target === st.pageEl && Math.abs(entry.contentRect.height - (st.pageH ?? -1)) > 0.5) {
          st.pageH = entry.contentRect.height;
          later = true;
        }
      }
      if (relayout) this._storyLayoutPage();
      if (later && !st.layoutRaf)
        st.layoutRaf = requestAnimationFrame(() => {
          st.layoutRaf = 0;
          this._storyLayoutPage();
        });
      for (const entry of entries) {
        // The bar's height places the phone drawer below it, and changes when the phone turns.
        if (entry.target === bar) {
          st.root.style.setProperty('--story-bar-h', `${bar.offsetHeight}px`);
          this._storyDrawerCover();
        }
        const rt = st.panels.find((p) => p.el === entry.target);
        if (rt) this._storySizePanel(rt);
      }
    });
    if (bar) st.ro.observe(bar);
    st.ro.observe(st.mainEl);
    if (sheet) st.ro.observe(sheet);
    st.ro.observe(st.pageEl);
    st.io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const rt = st.panels.find((p) => p.el === entry.target);
        if (rt) rt.visible = entry.isIntersecting;
      }
    });
    for (const rt of st.panels) {
      st.ro.observe(rt.el);
      st.io.observe(rt.el);
    }
    let last = 0;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const loop = (t) => {
      if (!st.open) return;
      const dt = last ? Math.min(100, t - last) : 16;
      last = t;
      if (!document.hidden) {
        // Clocks run for every panel; drawing is rationed per frame, because a canvas rasterizes what
        // was drawn when the frame is painted (12 panels redrawn in one frame made 50-80 ms tasks that
        // the JS time alone never showed). The panel served first rotates, so none starves.
        if (!reduced.matches) for (const rt of st.panels) if (rt.visible) rt.clock += (dt / 1000) * StoryArt.FPS;
        const start = performance.now();
        const n = st.panels.length;
        let drawn = 0;
        for (let j = 0; j < n; j++) {
          if (drawn >= STORY_DRAWS_PER_FRAME || performance.now() - start > STORY_FRAME_BUDGET_MS) break;
          const rt = st.panels[((st.drawCursor || 0) + j) % n];
          if (!rt.visible) continue;
          if (rt.pending) {
            rt.pending = false;
            this._storyDrawPanel(rt);
            drawn++;
            continue;
          }
          if (reduced.matches) continue;
          const intro = rt.clock < StoryArt.HERO;
          const fps = intro ? STORY_FPS_INTRO : rt.panel?.live ? STORY_FPS_LIVE : STORY_FPS_SETTLED;
          if (!intro && !rt.panel?.live) {
            rt.awakeUntil ??= t + STORY_SETTLED_AWAKE_MS;
            if (t > rt.awakeUntil) continue; // holding still; the pointer wakes it
          }
          if (t < (rt.nextDrawAt || 0)) continue;
          rt.nextDrawAt = t + 1000 / fps - 4;
          this._storyDrawPanel(rt);
          drawn++;
        }
        st.drawCursor = n ? ((st.drawCursor || 0) + 1) % n : 0;
        // A quiet frame draws a panel out of view (one band of it), so its buttons exist for the
        // keyboard and a screen reader before anyone scrolls to it. Its clock waits, so the entrance
        // still plays when it comes into view.
        if (!drawn) {
          const off = st.panels.find((p) => !p.visible && p.pending);
          if (off) {
            off.pending = false;
            this._storyDrawPanel(off);
          }
        }
      }
      st.raf = requestAnimationFrame(loop);
    };
    st.raf = requestAnimationFrame(loop);
    st.pollTimer = setInterval(() => {
      const page = st.data?.page;
      if (!st.open || document.hidden) return;
      // A permission prompt or a closed session raises no Story event: the composer looks again.
      this._storyComposeSync();
      // A session Story Mode cannot draw does not change that by itself: nothing to poll.
      if (st.data && st.data.supported === false) return;
      if (!st.turnId && page && !page.complete && !page.interrupted) {
        this._storyRefresh();
        return;
      }
      // Nothing drawn yet (no transcript), a finished page or one parked on: now and then only.
      // A finished newest page: look again now and then (a local command like /compact raises no
      // hook). An unchanged page is a 304.
      // Parked on an older turn: the turn list still learns about new turns now and then.
      if (Date.now() - (st.lastIdlePoll || 0) > STORY_IDLE_POLL_MS) {
        st.lastIdlePoll = Date.now();
        this._storyRefresh();
      }
      if (st.drawer?.view === 'helper') {
        const ev = page?.events.find((e) => e.id === st.drawer.event);
        if (ev?.pending || ev?.helper?.running) this._storyRenderDrawer(false);
      }
    }, STORY_POLL_MS);
    st.keyHandler = (e) => {
      if (!st.open) return;
      if (e.key === 'Tab') {
        this._storyTrapTab(e);
        return;
      }
      if (e.key !== 'Escape') return;
      // An Escape that cancels an IME composition is the IME's, not a request to close anything.
      if (e.isComposing || e.keyCode === 229) return;
      if (this._storyComposeEscape(e)) return;
      // A folder grid on top steps back by itself (preview, then grid), and a preview in edit mode
      // keeps its keys. A plain file preview has no Escape of its own outside the grid, so Story
      // closes it: one Escape per layer, the preview first.
      if (document.getElementById('folderGridOverlay')?.classList.contains('visible')) return;
      const previewOpen = document.getElementById('filePreviewOverlay')?.classList.contains('visible');
      if (previewOpen && this.filePreviewEdit) return;
      e.preventDefault();
      e.stopPropagation();
      if (previewOpen) {
        this.closeFilePreview?.();
        const back = st.previewReturn;
        st.previewReturn = null;
        if (back && document.contains(back)) back.focus({ preventScroll: true });
      } else if (st.drawer) this._storyCloseDrawer();
      else this.closeStoryMode();
    };
    window.addEventListener('keydown', st.keyHandler, true);
    st.skinObserver = new MutationObserver(() => {
      this._storyApplyTheme();
      for (const rt of st.panels) this._storyQueueDraw(rt);
    });
    st.skinObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'class'] });
    document.fonts?.ready?.then(() => {
      if (!st.open) return;
      for (const rt of st.panels) {
        rt.bgKey = '';
        this._storyQueueDraw(rt);
      }
    });
  },

  /** The overlay is a modal dialog: Tab and Shift+Tab cycle inside it (not when a preview is on top). */
  _storyTrapTab(e) {
    const st = this._story;
    if (document.getElementById('folderGridOverlay')?.classList.contains('visible')) return;
    // A file preview opened from a panel sits on top: Tab cycles inside it until it closes.
    const preview = document.getElementById('filePreviewOverlay');
    const scope = preview?.classList.contains('visible') ? preview : st.root;
    const items = [
      ...scope.querySelectorAll('button, select, textarea, input, a[href], [tabindex]:not([tabindex="-1"])'),
    ].filter((n) => !n.disabled && n.offsetParent !== null && !n.closest('[inert]'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = scope.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  },

  /**
   * A drawer that covers the whole page (a narrow window, a phone) makes the page behind it inert:
   * Tab would otherwise walk the panels it hides. Beside the page (a wide window) it does not.
   */
  _storyDrawerCover() {
    const st = this._story;
    if (!st?.mainEl) return;
    const d = st.drawer ? st.drawerEl.getBoundingClientRect() : null;
    const m = st.mainEl.getBoundingClientRect();
    st.mainEl.inert = !!d && d.width > 0 && m.width > 0 && d.left <= m.left + 8;
  },

  _storyStopRuntime() {
    const st = this._story;
    cancelAnimationFrame(st.raf);
    st.raf = 0;
    clearTimeout(st.refreshTimer);
    clearInterval(st.pollTimer);
    st.refreshTimer = null;
    st.pollTimer = null;
    st.ro?.disconnect();
    st.io?.disconnect();
    st.skinObserver?.disconnect();
    st.ro = st.io = st.skinObserver = null;
    if (st.keyHandler) window.removeEventListener('keydown', st.keyHandler, true);
    st.keyHandler = null;
  },

  // ── Rendering ──

  _storyRender() {
    const st = this._story;
    if (!st?.open) return;
    const data = st.data;
    const page = data?.supported ? data.page : null;
    const turns = data?.supported ? data.turns : [];

    // Bar: turn picker, prev/next, LIVE.
    const sel = st.turnSelect;
    sel.replaceChildren(
      ...turns.map((t, i) => {
        const o = document.createElement('option');
        o.value = t.id;
        o.textContent = `${i + 1}. ${
          t.prompt ||
          (t.origin === 'task' ? 'Background task' : t.origin === 'system' ? 'Claude carries on' : 'Earlier work')
        }`;
        return o;
      })
    );
    if (data?.older) {
      const o = document.createElement('option');
      o.disabled = true;
      o.value = '';
      o.textContent = '… older turns are not loaded';
      sel.prepend(o);
    }
    if (page) sel.value = page.id;
    sel.disabled = turns.length < 2;
    const idx = page ? turns.findIndex((t) => t.id === page.id) : -1;
    sel.setAttribute('aria-label', idx >= 0 ? `Turn ${idx + 1} of ${turns.length}` : 'Turn');
    const noPrev = idx <= 0;
    const noNext = idx < 0 || idx >= turns.length - 1;
    // A button that is about to be disabled under focus hands it to the turn picker first.
    const a = document.activeElement;
    if ((a === st.prev && noPrev) || (a === st.next && noNext))
      (sel.disabled ? st.closeBtn : sel).focus({ preventScroll: true });
    st.prev.disabled = noPrev;
    st.next.disabled = noNext;
    // Parked on an older turn, a new one is news.
    if (st.turnId && st.knownTurns !== undefined && turns.length > st.knownTurns && !st.drawerHolds) {
      const box = st.root.querySelector('.story-sr');
      if (box)
        box.textContent = `A new turn started: ${(turns[turns.length - 1].prompt || '').slice(0, 100)}. You are on turn ${
          idx + 1
        } of ${turns.length}.`;
    }
    st.knownTurns = turns.length;
    st.live.hidden = !(page && !page.complete && !page.interrupted && !st.turnId);

    // Note line: errors, unsupported sessions, empty sessions, cut pages.
    let note = '';
    if (st.error) note = st.error;
    else if (!data) note = 'Reading the session…';
    else if (!data.supported) note = data.reason;
    else if (!page) note = 'Nothing to draw yet. The page fills in as soon as Claude starts working in this session.';
    else if (page.partial)
      note = 'This turn started before the part of the transcript Story Mode reads, so its first panels are missing.';
    else if (page.truncated) note = 'A long turn: the oldest outputs were left out to keep the page fast.';
    st.note.textContent = note;
    st.note.hidden = !note;

    st.saveBtn.disabled = !page || !page.panels.length;
    this._storyRenderPanels(page);
    if (st.director) this._storyRenderWire();
    this._storyAnnounce(page);
    if (st.drawer) this._storyRenderDrawer(false);
    // Panels on screen when a page first loads are drawn finished; only later arrivals animate in.
    if (data) st.first = false;
    this._storyComposeSync();
  },

  /** Says a new turn or a finished one out loud (the polite status region), once each. */
  _storyAnnounce(page) {
    const st = this._story;
    const box = st.root.querySelector('.story-sr');
    if (!box || !page) return;
    const done = page.complete || page.interrupted;
    const key = `${page.id}|${done}`;
    if (st.announced === key) return;
    const first = st.announced === undefined;
    const newTurn = !first && !st.announced.startsWith(`${page.id}|`);
    st.announced = key;
    const picked = st.picked;
    st.picked = false;
    if (first || (picked && newTurn)) return;
    const last = page.panels[page.panels.length - 1];
    const said = st.level === 'simple' ? last?.caption.simple || last?.caption.story : last?.caption.story;
    const finished = `${done ? `Turn finished. ${said || ''}` : ''}`.trim();
    box.textContent = newTurn ? `New turn: ${page.prompt.slice(0, 140)}${finished ? `. ${finished}` : ''}` : finished;
  },

  _storyRenderPanels(page) {
    const st = this._story;
    const want = page ? page.panels : [];
    const working = !!page && !page.complete && !page.interrupted;
    // While the turn runs, the pencils placeholder takes the next slot, so the newest panel keeps
    // its own width instead of stretching to the end of the row.
    const prefs = want.map(storyPreferredSpan).concat(working ? [2] : []);
    const spans6 = storyLayoutSpans(prefs, 6);
    const spans2 = storyLayoutSpans(
      prefs.map((p) => (p >= 4 ? 2 : 1)),
      2
    );
    const fresh = !st.first;
    // A panel that holds focus may be rebuilt (a new turn, a fold into a loop): keep the place.
    const focused = document.activeElement;
    const focusAt = st.panels.findIndex((rt) => rt.el.contains(focused));
    const focusHit = focusAt >= 0 ? [...st.panels[focusAt].hitEls].find(([, b]) => b === focused)?.[0] : null;
    if (st.shownPageId !== (page?.id ?? null)) {
      for (const rt of st.panels.splice(0)) this._storyDropPanel(rt);
      st.shownPageId = page?.id ?? null;
    }
    // A panel is the same panel while its kind and first event are: a fold into a montage near the
    // start shifts every later index, and those panels must keep their state (no second entrance).
    const identity = (panel) => `${panel.kind}|${page.events[panel.events[0]]?.id ?? ''}`;
    const old = new Map(st.panels.map((rt) => [rt.identity, rt]));
    const next = want.map((panel) => {
      const id = identity(panel);
      let rt = old.get(id);
      if (rt) old.delete(id);
      else {
        rt = this._storyCreatePanel(panel.kind, fresh);
        rt.isNew = true;
        st.ro?.observe(rt.el);
        st.io?.observe(rt.el);
      }
      rt.identity = id;
      return rt;
    });
    for (const rt of old.values()) this._storyDropPanel(rt);
    st.panels = next;
    // In page order, moving only what is out of place (moving a node would drop its focus).
    next.forEach((rt, i) => {
      const prev = next[i - 1]?.el;
      if (prev ? prev.nextElementSibling !== rt.el : st.pageEl.firstElementChild !== rt.el) {
        if (prev) prev.after(rt.el);
        else st.pageEl.prepend(rt.el);
      }
    });
    // Spans first, then the row height they make: a new panel is sized at its final width and height.
    next.forEach((rt, i) => {
      rt.el.style.setProperty('--story-span6', String(spans6[i]));
      rt.el.style.setProperty('--story-span2', String(spans2[i]));
    });
    st.spans6 = spans6;
    st.spans2 = spans2;
    this._storyLayoutPage();
    want.forEach((panel, i) => {
      const rt = st.panels[i];
      rt.panel = panel;
      if (rt.isNew) {
        // Sized now, not when the resize observer reports: a new panel never shows an empty frame.
        rt.isNew = false;
        this._storySizePanel(rt);
      }
      this._storyFillPanelText(rt, page, i);
      this._storyQueueDraw(rt);
    });

    // While the turn runs, a blue-pencil rough stands where the next panel will be inked.
    let pencils = st.pageEl.querySelector('.story-pencils');
    if (working && !pencils) {
      pencils = document.createElement('div');
      pencils.className = 'story-pencils';
      const word = document.createElement('span');
      word.textContent = 'Pencils';
      const small = document.createElement('small');
      pencils.append(word, small);
    }
    if (working) {
      // A question still open means Claude is waiting on you, not working.
      const waiting = page.events.some((e) => e.question && e.pending);
      pencils.querySelector('small').textContent = waiting ? 'Waiting for your answer…' : 'Claude is working…';
      pencils.classList.toggle('is-waiting', waiting);
      pencils.style.setProperty('--story-span6', String(spans6[want.length]));
      pencils.style.setProperty('--story-span2', String(spans2[want.length]));
      st.pageEl.append(pencils);
    } else pencils?.remove();
    // Again now that the words are in: the final panel's may take more of the height than its row.
    if (st.panels[st.panels.length - 1]?.splash) this._storyLayoutPage();
    if (focusAt >= 0 && !document.contains(focused)) {
      const rt = st.panels[Math.min(focusAt, st.panels.length - 1)];
      if (rt && !rt.w) this._storySizePanel(rt);
      if (rt) this._storyQueueDraw(rt, true); // its click regions must exist to take focus
      const target = rt && ((focusHit && rt.hitEls.get(focusHit)) || rt.hitEls.values().next().value);
      if (target) target.focus({ preventScroll: true });
      else {
        st.pageEl.tabIndex = -1;
        st.pageEl.focus({ preventScroll: true });
      }
    }
  },

  _storyCreatePanel(kind, fresh) {
    const fig = document.createElement('figure');
    fig.className = `story-panel${fresh ? ' story-fresh' : ''}`;
    fig.dataset.kind = kind;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    const cap = document.createElement('p');
    cap.className = 'story-cap';
    const capStory = document.createElement('span');
    capStory.className = 'story-cap-story';
    const capDir = document.createElement('span');
    capDir.className = 'story-cap-dir';
    // The Simple level's sentence: everyday words, shown instead of the story line at that level.
    const capSimple = document.createElement('span');
    capSimple.className = 'story-cap-simple';
    // A second opinion Claude asked for before this step: a line, not a panel of its own.
    const capNote = document.createElement('span');
    capNote.className = 'story-cap-note';
    capNote.hidden = true;
    cap.append(capStory, capDir, capSimple, capNote);
    const balloon = document.createElement('p');
    balloon.className = 'story-balloon';
    balloon.hidden = true;
    const liveTag = document.createElement('span');
    liveTag.className = 'story-live-tag';
    liveTag.textContent = 'LIVE';
    liveTag.hidden = true;
    fig.append(canvas, cap, balloon, liveTag);
    // A settled panel holds still after a while; pointing at it brings it back to life.
    fig.addEventListener('pointerenter', () => {
      const rt = this._story?.panels.find((p) => p.el === fig);
      if (rt) rt.awakeUntil = performance.now() + STORY_SETTLED_AWAKE_MS;
    });
    let splash = null;
    if (kind === 'complete') {
      splash = document.createElement('div');
      splash.className = 'story-splash';
      const titleEl = document.createElement('p');
      titleEl.className = 'story-splash-title';
      const chips = document.createElement('ul');
      chips.className = 'story-chips';
      splash.append(titleEl, cap, balloon, chips);
      fig.append(splash);
    }
    let answer = null;
    if (kind === 'ask') {
      answer = document.createElement('p');
      answer.className = 'story-answer';
      answer.hidden = true;
      fig.append(answer);
    }
    return {
      el: fig,
      canvas,
      ctx: canvas.getContext('2d'),
      kind,
      panel: null,
      capStory,
      capDir,
      capSimple,
      capNote,
      balloon,
      liveTag,
      splash,
      answer,
      clock: fresh && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : StoryArt.HERO,
      w: 0,
      h: 0,
      dpr: 1,
      bg: null,
      bgKey: '',
      hitEls: new Map(),
      visible: true,
    };
  },

  _storyDropPanel(rt) {
    this._story?.ro?.unobserve(rt.el);
    this._story?.io?.unobserve(rt.el);
    rt.el.remove();
    rt.bg = null;
  },

  _storyFillPanelText(rt, page, index) {
    const p = rt.panel;
    rt.capStory.textContent = p.caption.story;
    rt.capDir.textContent = p.caption.director || p.caption.story;
    rt.capSimple.textContent = p.caption.simple || p.caption.story;
    const simple = this._story?.level === 'simple';
    const balloonText = p.kind === 'ask' && p.question?.text ? p.question.text : p.balloon?.text;
    // Simple keeps your own words (the prompt) and hides Claude's: its narration is often technical,
    // and at the end the plain summary stands in for it, Claude's words one click away (a chip).
    const yours = p.kind === 'mission' && p.balloon?.who === 'you';
    rt.balloon.hidden = !balloonText || (simple && !yours);
    // The text sits in its own box so a long one can be clamped without clipping the tail.
    let balloonSpan = rt.balloon.querySelector('.story-balloon-text');
    if (!balloonSpan) {
      balloonSpan = document.createElement('span');
      balloonSpan.className = 'story-balloon-text';
      rt.balloon.append(balloonSpan);
    }
    balloonSpan.textContent = balloonText || '';
    // A prompt somebody else sent (a background job, another session) is a notice, not your speech.
    const origin = page.events[p.events[0]]?.origin ?? (index === 0 ? page.origin : 'human');
    const notice = p.kind === 'mission' && origin && origin !== 'human';
    // Who speaks, for a screen reader: the art shows it, the text alone does not.
    let who = rt.balloon.querySelector('.story-vh');
    if (!who) {
      who = document.createElement('span');
      who.className = 'story-vh';
      rt.balloon.prepend(who);
    }
    who.textContent = notice
      ? 'Notice: '
      : p.kind === 'mission' || p.balloon?.who === 'you'
        ? 'You say: '
        : p.kind === 'ask'
          ? 'Claude asks: '
          : 'Claude says: ';
    rt.balloon.onclick =
      p.kind === 'mission'
        ? () =>
            this._storyOpenDrawer(
              { view: 'prompt', panel: index, kind: 'mission', first: page.events[p.events[0]]?.id },
              null
            )
        : null;
    rt.balloon.className = `story-balloon ${
      notice
        ? 'story-balloon--note'
        : p.kind === 'mission' || p.balloon?.who === 'you'
          ? 'story-balloon--you'
          : 'story-balloon--claude'
    }`;
    rt.liveTag.hidden = !p.live;
    if (rt.capNote) {
      // Asked before this step, or after it when nothing followed.
      const work = p.events.filter((i) => page.events[i]?.tool !== 'Advisor');
      const asked = p.events.filter((i) => page.events[i]?.tool === 'Advisor');
      // Before the step's calls, after them, or in the middle of them.
      const before = asked.every((i) => i < Math.min(...work));
      const trailing = !before && asked.every((i) => i > Math.max(...work));
      // A call that came back with an error brought no opinion: say so, never that one was given.
      const unanswered = asked.length > 0 && asked.every((i) => page.events[i].ok === false);
      const ask = unanswered ? 'tries to ask' : 'asks';
      const notes = [
        p.unaskedSave === 'rule'
          ? "a save your prompt here did not ask for; your project's rules do"
          : p.unaskedSave
            ? 'a save your prompt here did not ask for'
            : '',
        p.secondOpinion
          ? `${
              before
                ? `after ${unanswered ? 'trying to ask' : 'asking'}`
                : trailing
                  ? `then ${ask}`
                  : `along the way, ${ask}`
            } a stronger AI model for a second opinion${unanswered ? ' (no answer came)' : ''}`
          : '',
      ].filter(Boolean);
      rt.capNote.hidden = !notes.length;
      rt.capNote.textContent = notes.join('; ');
    }
    this._storyFitCaption(rt);
    rt.el.classList.toggle('is-live', !!p.live);
    // Named by its place only: the caption inside is read as the panel's content, once.
    rt.el.setAttribute('aria-label', `Panel ${index + 1} of ${page.panels.length}`);
    if (rt.answer) {
      rt.answer.hidden = !p.question?.answer;
      const planned = page.events[p.events[0]]?.tool === 'ExitPlanMode';
      rt.answer.textContent = !p.question?.answer
        ? ''
        : planned
          ? p.question.answer === 'Approved'
            ? 'You approved it'
            : 'You sent it back'
          : `You chose: ${p.question.answer}`;
    }
    if (rt.splash) {
      rt.splash.querySelector('.story-splash-title').textContent = page.interrupted
        ? 'Stopped!'
        : page.superseded
          ? 'To be continued…'
          : page.noneWorked
            ? 'Not done'
            : page.openNote === 'catch'
              ? // A problem left beats work still out: it is what the reader must not miss.
                'Done, with a catch'
              : page.helpersRunning || page.finishedLater || page.events.some((e) => e.running && !e.helper)
                ? // Work was still out when the turn ended (and maybe still is): not a clean finish.
                  'Done for now'
                : page.openNote
                  ? 'Done, with a note'
                  : page.asks
                    ? 'Done, with a question'
                    : 'Mission complete!';
      const chips = rt.splash.querySelector('.story-chips');
      const items = [];
      if (page.durationMs !== undefined) items.push({ text: this._storyDuration(page.durationMs) });
      if (page.filesChanged)
        items.push({
          text: `${page.filesChanged} file${page.filesChanged === 1 ? '' : 's'} changed`,
          open: 'diff:page',
        });
      // Simple: the time, the files and Claude's own last words; no tool calls, commits or helpers.
      if (simple && p.balloon?.text) items.push({ text: "Read Claude's message", open: 'said:page' });
      if (!simple)
        items.push({ text: `${page.toolCalls} tool call${page.toolCalls === 1 ? '' : 's'}`, open: 'list:page' });
      // What was saved, wherever in the turn: commits inside a loop or a test one-liner count too.
      const commits = page.events.reduce((n, e) => n + (e.commits || 0), 0);
      // An upload that went through, even when a step after it in the same command failed.
      const shipped = page.events.some(
        (e) => e.ships === 'push' && (e.ok !== false || /\[new branch\]|\S+\.\.\S+\s+\S+\s+->/.test(e.output || ''))
      );
      // A push to a folder on this computer (`To ./origin.git`) is a copy: nothing left the machine.
      const target = /^To (\S+)/m.exec(
        page.events
          .filter((e) => e.ships === 'push')
          .map((e) => e.output || '')
          .join('\n')
      )?.[1];
      const copiedTo =
        target && (/^file:\/\//.test(target) || !target.includes(':')) ? target.split('/').filter(Boolean).pop() : '';
      if (!simple && (commits || shipped))
        items.push({
          text: [
            commits ? `${commits} commit${commits === 1 ? '' : 's'}` : '',
            shipped ? (copiedTo ? `copied to ${copiedTo}` : 'uploaded') : '',
          ]
            .filter(Boolean)
            .join(', '),
        });
      if (!simple && page.helpers)
        items.push({
          text: `${page.helpers} helper${page.helpers === 1 ? '' : 's'}${
            page.helpersRunning ? `, ${page.helpersRunning} still working` : ''
          }`,
        });
      // Rebuilt only when they change: a chip that opened the drawer must still be there to take focus back.
      const chipsKey = JSON.stringify(items);
      if (chips.dataset.key !== chipsKey) {
        chips.dataset.key = chipsKey;
        chips.replaceChildren(
          ...items.map((item) => {
            const li = document.createElement('li');
            const inner = document.createElement(item.open ? 'button' : 'span');
            if (item.open) {
              inner.type = 'button';
              inner.dataset.storyOpen = item.open;
              if (!item.open.startsWith('said'))
                inner.setAttribute(
                  'aria-label',
                  `${item.text}: ${item.open.startsWith('diff') ? 'see the changes' : 'list every step'}`
                );
            }
            inner.textContent = item.text;
            li.append(inner);
            return li;
          })
        );
      }
    }
  },

  _storyDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min ${s % 60} s`;
  },

  _storySizePanel(rt) {
    this._storyFitCaption(rt);
    const w = rt.el.clientWidth;
    const h = rt.el.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // A panel its words made taller (a long caption, the final panel's ending) keeps its scene at the
    // usual size, standing at the bottom: the stage is the panel's usual height inside its border.
    // That height is its row's (a plain px value _storyLayoutPage writes on the panel), so the art
    // grows with the rows; read before the early return, since a row can change height while this
    // panel's box, held by a taller neighbour, does not.
    const minH = parseFloat(getComputedStyle(rt.el).getPropertyValue('--story-panel-min')) || 0;
    const border = rt.el.offsetHeight - rt.el.clientHeight;
    const stageH = minH > border ? Math.min(h, minH - border) : h;
    if (w === rt.w && h === rt.h && dpr === rt.dpr && stageH === rt.stageH) return;
    rt.w = w;
    rt.h = h;
    rt.stageH = stageH;
    rt.dpr = dpr;
    rt.canvas.width = Math.max(1, Math.round(w * dpr));
    rt.canvas.height = Math.max(1, Math.round(h * dpr));
    rt.bgKey = '';
    this._storyQueueDraw(rt);
  },

  /**
   * Fits the page to the main area: the rows take the visible height (storyRowHeights), the comic
   * text grows with them (`--story-k`), and the sheet and the Director's cut wire span that height.
   * It reads the main area's box and the page's width, never the sheet's height, so nothing it
   * writes feeds back into it, and it writes a property only when its value changes. Called when the
   * page is rendered and by the resize observer (window, drawer, the wire's toggle).
   */
  _storyLayoutPage() {
    const st = this._story;
    if (!st?.open) return;
    const px = (v) => parseFloat(v) || 0;
    const main = st.mainEl;
    const mcs = getComputedStyle(main);
    const view = Math.max(0, main.clientHeight - px(mcs.paddingTop) - px(mcs.paddingBottom));
    const noteH = st.note.hidden ? 0 : st.note.offsetHeight + px(getComputedStyle(st.note).marginBottom);
    const pcs = getComputedStyle(st.pageEl);
    // The column count the container queries chose: the page's resolved tracks, else their thresholds.
    const tracks = pcs.gridTemplateColumns || '';
    const sheetW = st.pageEl.parentElement?.getBoundingClientRect().width || 0;
    const cols =
      (tracks && !tracks.includes('(') && tracks.trim().split(/\s+/).length) ||
      (sheetW > 1000 ? 6 : sheetW > 600 ? 2 : 1);
    const spans = cols === 6 ? st.spans6 : cols === 2 ? st.spans2 : null;
    const box = {
      width: st.pageEl.clientWidth - px(pcs.paddingLeft) - px(pcs.paddingRight),
      height: view - noteH - px(pcs.paddingTop) - px(pcs.paddingBottom),
      gap: px(pcs.rowGap),
    };
    const set = (el, name, value) => {
      if (value === null) el.style.removeProperty(name);
      else if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
    };
    set(st.stage, '--story-view-h', `${view}px`);
    set(st.stage, '--story-note-h', `${noteH}px`);
    // Plain px values, never calc() or clamp(): every panel reads its row back with parseFloat
    // (--story-panel-min), as its scene's stage. No fit (one column): the stylesheet's own heights.
    const apply = (f) => {
      set(st.pageEl, '--story-row-h', f ? `${Math.min(...f.heights)}px` : null);
      set(st.pageEl, '--story-k', f ? String(f.k) : null);
      set(st.pageEl, 'grid-template-rows', f ? f.heights.map((h) => `minmax(${h}px, auto)`).join(' ') : null);
      st.panels.forEach((rt, i) => set(rt.el, '--story-panel-min', f ? `${f.stage[i]}px` : null));
    };
    // The pencils (after the panels) draw no art; the final panel's scene needs a wide stage.
    box.stageMin = st.panels.map((rt) => (rt.splash ? STORY_FINAL_STAGE_MIN : STORY_STAGE_MIN)).concat([0]);
    let fit = storyRowHeights(spans, cols, box);
    apply(fit);
    // The final panel's words are in flow and may make its row taller at this text size (it sits
    // alone in the last row): measured now, the other rows give that height up. The words depend on
    // the text size and the width only, never on the row heights, so this settles in one step.
    const last = st.panels[st.panels.length - 1];
    if (fit && last?.splash && last.panel && fit.rowOf[st.panels.length - 1] === fit.heights.length - 1) {
      const lastRow = last.el.offsetHeight;
      if (lastRow > fit.heights[fit.heights.length - 1]) {
        fit = storyRowHeights(spans, cols, { ...box, lastRow });
        apply(fit);
      }
    }
    const sig = fit ? `${fit.heights.join(',')}|${fit.stage.join(',')}|${fit.k}` : '';
    const changed = sig !== st.layoutSig;
    st.layoutSig = sig;
    st.fit = fit;
    // A panel held at its size by a taller neighbour gets no resize report: its stage still follows
    // its row. Sizing only queues the draws (the frame loop rations them); a panel not sized yet is
    // sized when it is filled.
    if (changed) for (const rt of st.panels) if (rt.w) this._storySizePanel(rt);
  },

  /**
   * A caption taller than the band above the art makes its panel taller by the difference, and the
   * scene stands below it (`rt.stageH`): a long caption never covers a test board or a code page.
   * The speech balloon is placed here too (`_storyFitBalloon`), and when it has to sit below the
   * caption the panel grows for both, so the balloon covers no object and not Claude's face either.
   */
  _storyFitCaption(rt) {
    if (rt.splash) return;
    const cap = rt.capStory.parentElement;
    const base = parseFloat(getComputedStyle(rt.el).getPropertyValue('--story-panel-min')) || 0;
    if (!cap || !base) return;
    const border = rt.el.offsetHeight - rt.el.clientHeight;
    const s = (base - border) / StoryArt.VH;
    // The art starts about 88 scene units down (a terminal at 92, a code page at 104, a board at 106).
    const capBottom = cap.offsetTop + cap.offsetHeight;
    // Never more than one more usual height for the balloon: a guard, the room it asks for is smaller.
    const balloon = Math.min(base, this._storyFitBalloon(rt, base - border, s, cap));
    const need = Math.max(capBottom - 88 * s, balloon);
    const grow = need > 2 ? `${Math.ceil(base + need)}px` : '';
    if (rt.el.style.minHeight !== grow) rt.el.style.minHeight = grow;
    if (rt.balloonFit) this._storyClampBalloon(rt, rt.el.clientHeight);
  },

  /**
   * The scene's objects and Claude in panel px at the panel's usual height, from the scene's finished
   * frame (`StoryArt.layout`), kept until the panel's data, width or mode changes. A click region that
   * holds Claude's face is Claude himself (the mission's prompt, the ask panel's question): it is not
   * an object a balloon must avoid, only his face is.
   */
  _storySceneLayout(rt, w, s) {
    const st = this._story;
    const key = `${rt.kind}|${w}|${s}|${st.director}`;
    if (rt.layoutKey === key && rt.layoutFor === rt.panel) return rt.layout;
    const scene = StoryArt.SCENES[rt.kind];
    const W = w / s;
    const stageW = scene?.fullWidth ? W : Math.min(W, STORY_STAGE_MAX);
    const ox = (W - stageW) / 2;
    const raw =
      rt.panel && StoryArt.layout(rt.kind, stageW, { panel: rt.panel, page: st.data?.page, director: st.director });
    let lay = null;
    if (raw) {
      const box = (r) => ({ x0: (r.x + ox) * s, x1: (r.x + ox + r.w) * s, y: r.y * s, y1: (r.y + r.h) * s });
      const sp = raw.speaker;
      const face = sp?.face ? box(sp.face) : null;
      const cx = face && (face.x0 + face.x1) / 2;
      const cy = face && (face.y + face.y1) / 2;
      const objects = raw.hits.map(box).filter((o) => !(face && o.x0 <= cx && cx <= o.x1 && o.y <= cy && cy <= o.y1));
      lay = { objects, face, head: sp ? { x: (sp.x + ox) * s, top: sp.top * s } : null };
    }
    rt.layoutKey = key;
    rt.layoutFor = rt.panel;
    rt.layout = lay;
    return lay;
  },

  /**
   * Places the balloon (left or right, top, max-width; nothing of it reads the panel's height) and
   * returns how much taller the panel must be for the balloon to show two lines (or all of a shorter
   * one) above every object it would cover and above Claude's face. Claude's own balloon goes in the
   * band above his head, the tail pointing down at it: beside the caption when there is room, else
   * below it. The ask panel's stays left of his face; yours and a notice stand under the caption.
   * The room it may use is kept in `rt.balloonFit` for the clamp (`_storyClampBalloon`).
   */
  _storyFitBalloon(rt, stageH, s, cap) {
    const b = rt.balloon;
    const text = b?.querySelector('.story-balloon-text');
    rt.balloonFit = null;
    if (!b || b.hidden || !text) return 0;
    const w = rt.el.clientWidth;
    const lay = this._storySceneLayout(rt, w, s);
    if (!lay) {
      // No scene layout (a browser out of canvas memory): the stylesheet's places, clamped to the panel.
      for (const prop of ['left', 'right', 'top', 'max-width']) b.style.removeProperty(prop);
      return 0;
    }
    const capRight = cap.offsetLeft + cap.offsetWidth;
    const capBottom = cap.offsetTop + cap.offsetHeight;
    const face = lay.face;
    const claude = b.classList.contains('story-balloon--claude');
    const placed = claude && rt.kind !== 'ask' && !!lay.head;
    let floor = stageH - 12;
    let tail = null;
    if (placed) {
      const hx = lay.head.x;
      const right = Math.max(10, Math.min(w - 160, w - hx - 38));
      // The loop has no Claude to keep clear of on the left: its balloon may run wide, so it stays
      // short and ends above the board it points at.
      let maxW = Math.min(w * (rt.kind === 'loop' ? 0.9 : 0.5), w - right - 14);
      let top = 10;
      const besideCap = w - right - capRight - 10;
      if (besideCap >= 150) maxW = Math.min(maxW, besideCap);
      else top = capBottom + 8;
      // The LIVE tag sits in the top-right corner: start below it when the balloon reaches that far.
      if (!rt.liveTag.hidden && right < w - rt.liveTag.offsetLeft)
        top = Math.max(top, rt.liveTag.offsetTop + rt.liveTag.offsetHeight + 6);
      b.style.left = 'auto';
      b.style.right = `${Math.round(right)}px`;
      b.style.top = `${Math.round(top)}px`;
      b.style.maxWidth = `${Math.round(Math.max(140, maxW))}px`;
      // The tail's tip ends just above the head (it points at it).
      floor = Math.min(floor, lay.head.top - 22);
    } else {
      // The ask panel's balloon and yours stand at the left: under the caption, and left of his face.
      const left = claude ? 14 : 16;
      const top = Math.max(claude ? 0.3 * stageH : 74, capBottom + (claude ? 8 : 10));
      let maxW = w * (claude ? 0.46 : 0.54);
      if (face && face.x0 - 8 - left < maxW) maxW = Math.max(120, face.x0 - 8 - left);
      b.style.left = `${left}px`;
      b.style.right = 'auto';
      b.style.top = `${Math.round(top)}px`;
      b.style.maxWidth = `${Math.round(maxW)}px`;
    }
    text.style.removeProperty('--story-lines');
    const top = b.offsetTop;
    const x0 = b.offsetLeft;
    const x1 = x0 + b.offsetWidth;
    const lh = parseFloat(getComputedStyle(text).lineHeight) || 19;
    const pad = b.offsetHeight - text.offsetHeight;
    if (claude) {
      // The tail (the ink half, ::before) hangs below the body's right end, set inside its border.
      const bs = getComputedStyle(b);
      const tb = getComputedStyle(b, '::before');
      const inset = parseFloat(bs.borderRightWidth) || 0;
      const right = x1 - inset - (parseFloat(tb.right) || 0);
      const below = -(parseFloat(tb.bottom) || 0) - (parseFloat(bs.borderBottomWidth) || 0);
      if (below > 0 && tb.display !== 'none') tail = { x0: right - (parseFloat(tb.width) || 0), x1: right, h: below };
    }
    const obstacles = lay.objects.slice();
    if (face) obstacles.push(face);
    // The ask panel's answer stamp stands at the bottom, so it moves with a taller panel like the art.
    if (rt.answer && !rt.answer.hidden)
      obstacles.push({
        x0: rt.answer.offsetLeft,
        x1: rt.answer.offsetLeft + rt.answer.offsetWidth,
        y: stageH - (rt.el.clientHeight - rt.answer.offsetTop) - 6,
      });
    const lines = Math.max(1, Math.round(text.offsetHeight / lh));
    const keep = pad + Math.min(2, lines) * lh;
    const room = storyBalloonRoom({ top, x0, x1, tail, obstacles, floor, keep });
    rt.balloonSerial = (rt.balloonSerial || 0) + 1;
    rt.balloonFit = { top, limit: room.limit, stageH, serial: rt.balloonSerial };
    return room.grow;
  },

  /** Draws on the next frame, within its budget (now, when the frame loop is not running). */
  _storyQueueDraw(rt, now = false) {
    if (now || !this._story?.raf) this._storyDrawPanel(rt);
    else rt.pending = true;
  },

  _storyDrawPanel(rt, full = false) {
    const st = this._story;
    if (!rt.panel || !rt.w || !rt.h) return;
    const scene = StoryArt.SCENES[rt.kind];
    if (!scene) return;
    const s = (rt.stageH || rt.h) / StoryArt.VH;
    const W = rt.w / s;
    // Scene units down the whole panel: VH, or more on a final panel its words made taller, whose
    // stage then stands at the bottom (oy) with background above it.
    const H = rt.h / s;
    const oy = H - StoryArt.VH;
    const k = rt.dpr * s;
    const key = `${rt.kind}|${rt.canvas.width}x${rt.canvas.height}|${StoryArt.C.key}`;
    if (rt.bgKey !== key) {
      // A background depends only on the kind, the size and the palette: shared between panels and
      // turns, so stepping through turns draws no halftone twice. A new one is built in horizontal
      // bands, one per frame (a wide halftone at 2x is ~35 ms in one go, a long task that made the
      // app drop its WebGL terminal renderer); the panel shows it as it fills in.
      let job = storyBgCache.get(key);
      if (!job) {
        const canvas = document.createElement('canvas');
        canvas.width = rt.canvas.width;
        canvas.height = rt.canvas.height;
        job = { canvas, next: 0, total: STORY_BG_BANDS };
        storyBgCache.set(key, job);
        const bytes = () => [...storyBgCache.values()].reduce((n, j) => n + j.canvas.width * j.canvas.height * 4, 0);
        while (storyBgCache.size > 1 && (storyBgCache.size > STORY_BG_CACHE || bytes() > STORY_BG_CACHE_BYTES))
          storyBgCache.delete(storyBgCache.keys().next().value);
      }
      rt.bg = job;
      rt.bgKey = key;
    }
    const job = rt.bg;
    if (job.next < job.total) {
      const b = job.canvas.getContext('2d');
      // Without a frame loop (tests, a browser that never paints) the whole background at once.
      const steps = st?.raf && !full ? 1 : job.total - job.next;
      for (let i = 0; i < steps && b; i++, job.next++) {
        const top = (H / job.total) * job.next;
        const bottom = top + H / job.total;
        b.save();
        b.setTransform(k, 0, 0, k, 0, 0);
        b.beginPath();
        b.rect(0, top, W, bottom - top);
        b.clip();
        StoryArt.inBand(top, bottom, () => scene.bg(b, W, H));
        b.restore();
      }
      if (!b) job.next = job.total;
      if (job.next < job.total) rt.pending = true;
    }
    const ctx = rt.ctx;
    if (!ctx) return; // no 2D context (a browser out of canvas memory): the captions still read
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rt.canvas.width, rt.canvas.height);
    ctx.drawImage(job.canvas, 0, 0);
    const stageW = scene.fullWidth ? W : Math.min(W, STORY_STAGE_MAX);
    const ox = (W - stageW) / 2;
    ctx.setTransform(k, 0, 0, k, ox * k, oy * k);
    const hits = [];
    const hit = (id, x, y, w, h, label) => hits.push({ id, x: x + ox, y: y + oy, w, h, label });
    StoryArt.takeSpeaker();
    scene.draw(
      ctx,
      stageW,
      StoryArt.VH,
      rt.clock,
      { panel: rt.panel, page: st.data?.page, director: st.director },
      hit
    );
    this._storySyncHits(rt, hits, s);
    StoryArt.takeSpeaker(); // the balloon is placed from the scene's layout (_storyFitBalloon), not this frame
    this._storyPlaceBalloon(rt);
  },

  /**
   * Keeps the balloon's clamp right for the panel's height, which can change without a refit (a
   * taller neighbour stretches the row). Cheap when nothing changed: it runs on every draw.
   */
  _storyPlaceBalloon(rt) {
    const b = rt.balloon;
    if (!b || b.hidden || rt.splash) return;
    const key = `${rt.h}|${rt.balloonFit?.serial ?? '-'}|${b.className}|${b.textContent}`;
    if (key === rt.balloonKey) return;
    this._storyClampBalloon(rt, rt.h);
  },

  /**
   * Clamps a long balloon text (`--story-lines`) to the room its fit left it at panel height `h`: a
   * taller panel moves the scene's objects and Claude down, so the room grows with it. Without a fit
   * (no stylesheet, no scene layout) the text only stays inside the panel.
   */
  _storyClampBalloon(rt, h) {
    const b = rt.balloon;
    const text = b?.querySelector('.story-balloon-text');
    if (!text) return;
    const fit = rt.balloonFit;
    rt.balloonKey = `${h}|${fit?.serial ?? '-'}|${b.className}|${b.textContent}`;
    text.style.removeProperty('--story-lines');
    // A panel ignores a growth of 2 px or less (_storyFitCaption): the balloon may use that much of the
    // gap it keeps, or such a panel would show one line fewer than its fit made room for.
    const limit = (fit ? fit.limit + h - fit.stageH : h - 12) + 2;
    const lh = parseFloat(getComputedStyle(text).lineHeight) || 19;
    const pad = b.offsetHeight - text.offsetHeight;
    if (b.offsetHeight && b.offsetTop + b.offsetHeight > limit)
      text.style.setProperty(
        '--story-lines',
        String(Math.max(1, Math.floor((limit - b.offsetTop - pad) / lh + 0.001)))
      );
  },

  /** Canvas click regions become real buttons: focusable, labelled, keyboard-reachable. */
  _storySyncHits(rt, hits, s) {
    const seen = new Set();
    for (const h of hits) {
      seen.add(h.id);
      let b = rt.hitEls.get(h.id);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        b.className = 'story-hit';
        rt.el.appendChild(b);
        rt.hitEls.set(h.id, b);
      }
      if (b.title !== h.label) {
        b.setAttribute('aria-label', h.label);
        b.title = h.label;
      }
      b.dataset.storyOpen = `${h.id}@${rt.el.dataset.kind}:${this._story.panels.indexOf(rt)}`;
      const L = Math.round(h.x * s);
      const T = Math.round(h.y * s);
      const Wd = Math.round(h.w * s);
      const Ht = Math.round(h.h * s);
      const k = `${L},${T},${Wd},${Ht}`;
      if (b._k !== k) {
        b._k = k;
        b.style.cssText = `left:${L}px;top:${T}px;width:${Wd}px;height:${Ht}px`;
      }
    }
    for (const [id, b] of rt.hitEls) {
      if (!seen.has(id)) {
        b.remove();
        rt.hitEls.delete(id);
      }
    }
  },

  // ── Save as image ──

  /**
   * The page as one PNG to share: each panel's canvas, then its captions, balloons and chips redrawn
   * from their computed style and on-screen box (DOM text cannot be rasterized with self-hosted fonts
   * reliably). Text is the page's own, so the image says exactly what the screen says.
   */
  async saveStoryImage() {
    const st = this._story;
    const page = st?.data?.page;
    if (!page || !st.panels.length) return;
    await document.fonts?.ready;
    // Every panel finished, on screen or not: on a phone the frame loop draws only what was scrolled to.
    for (const rt of st.panels) {
      if (!rt.w) this._storySizePanel(rt);
      this._storyDrawPanel(rt, true);
      rt.pending = false;
    }
    const sheet = st.pageEl.getBoundingClientRect();
    const head = 64;
    const scale = Math.max(1, Math.min(2, 12000 / (sheet.height + head)));
    const out = document.createElement('canvas');
    out.width = Math.round(sheet.width * scale);
    out.height = Math.round((sheet.height + head) * scale);
    const g = out.getContext('2d');
    if (!g) return;
    g.scale(scale, scale);
    const tok = (n) => getComputedStyle(st.root).getPropertyValue(`--story-${n}`).trim();
    g.fillStyle = tok('sheet');
    g.fillRect(0, 0, sheet.width, sheet.height + head);

    // Title strip: the word STORY, the session and the prompt.
    g.textBaseline = 'middle';
    g.font = `30px 'Codeman Story Display', Impact, sans-serif`;
    g.lineWidth = 4;
    g.strokeStyle = tok('line');
    g.strokeText('STORY', 16, head / 2);
    g.fillStyle = tok('yellow');
    g.fillText('STORY', 16, head / 2);
    const titleW = g.measureText('STORY').width;
    g.font = `500 12px 'JetBrains Mono', monospace`;
    g.fillStyle = tok('muted');
    const when = new Date(page.at);
    const meta = `${st.sessionLabel.textContent} · ${Number.isNaN(when.getTime()) ? '' : when.toLocaleString()}`;
    g.fillText(this._storyFit(g, meta, sheet.width - titleW - 48), titleW + 32, head / 2 - 9);
    g.fillStyle = tok('ink');
    g.fillText(this._storyFit(g, page.prompt || 'Earlier work', sheet.width - titleW - 48), titleW + 32, head / 2 + 9);
    g.translate(0, head);

    for (const rt of st.panels) {
      const r = rt.el.getBoundingClientRect();
      const x = r.left - sheet.left;
      const y = r.top - sheet.top;
      const bw = parseFloat(getComputedStyle(rt.el).borderTopWidth) || 3;
      g.drawImage(rt.canvas, x + bw, y + bw, r.width - bw * 2, r.height - bw * 2);
      g.lineWidth = bw;
      g.strokeStyle = getComputedStyle(rt.el).borderTopColor;
      g.strokeRect(x + bw / 2, y + bw / 2, r.width - bw, r.height - bw);
      g.save();
      g.beginPath();
      g.rect(x, y, r.width, r.height);
      g.clip();
      const boxes = rt.el.querySelectorAll(
        '.story-splash-title, .story-cap, .story-balloon, .story-chips li > *, .story-answer, .story-live-tag'
      );
      for (const el of boxes) this._storyPaintBox(g, el, sheet);
      g.restore();
    }
    const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const a = document.createElement('a');
    const name = (st.sessionLabel.textContent || 'session').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40);
    a.href = URL.createObjectURL(blob);
    const turnNo = (st.data?.turns || []).findIndex((t) => t.id === page.id) + 1;
    a.download = `story-${name}-${turnNo ? `turn-${turnNo}-` : ''}${(page.at || '').slice(0, 10) || 'turn'}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  },

  _storyFit(g, text, maxW) {
    if (g.measureText(text).width <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (g.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return `${text.slice(0, lo)}…`;
  },

  /** One caption, balloon or chip, redrawn where and how the page shows it. */
  _storyPaintBox(g, el, sheet) {
    if (el.hidden || el.closest('[hidden]')) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const x = r.left - sheet.left;
    const y = r.top - sheet.top;
    const isTitle = el.classList.contains('story-splash-title');
    if (!isTitle) {
      const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.height / 2);
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, r.width, r.height, radius);
      else g.rect(x, y, r.width, r.height);
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        g.fillStyle = cs.backgroundColor;
        g.fill();
      }
      const bw = parseFloat(cs.borderTopWidth) || 0;
      if (bw) {
        g.lineWidth = bw;
        g.strokeStyle = cs.borderTopColor;
        g.setLineDash(cs.borderTopStyle === 'dashed' ? [6, 4] : []);
        g.stroke();
        g.setLineDash([]);
      }
    }
    // A balloon's tail is two CSS triangles (::before ink, ::after fill): draw them from their style.
    if (el.classList.contains('story-balloon')) {
      for (const which of ['::before', '::after']) {
        const ps = getComputedStyle(el, which);
        const poly = /polygon\(([^)]*)\)/.exec(ps.clipPath || '');
        if (ps.position !== 'absolute' || !poly) continue;
        const w = parseFloat(ps.width) || 0;
        const h = parseFloat(ps.height) || 0;
        const left = ps.left !== 'auto' ? parseFloat(ps.left) : r.width - parseFloat(ps.right) - w;
        const top = ps.top !== 'auto' ? parseFloat(ps.top) : r.height - parseFloat(ps.bottom) - h;
        const at = (v, size) => (v.endsWith('%') ? (parseFloat(v) / 100) * size : parseFloat(v) || 0);
        g.beginPath();
        poly[1].split(',').forEach((pt, k) => {
          const [px, py] = pt.trim().split(/\s+/);
          const X = x + left + at(px, w);
          const Y = y + top + at(py ?? '0', h);
          if (k) g.lineTo(X, Y);
          else g.moveTo(X, Y);
        });
        g.closePath();
        g.fillStyle = ps.backgroundColor;
        g.fill();
      }
    }
    // The text the reader sees (hidden spans, like the other reading level, are left out).
    let text = (el.innerText || el.textContent || '').trim();
    const spoken = el.querySelector?.('.story-vh');
    if (spoken) text = text.replace(spoken.textContent.trim(), '').trim();
    if (!text) return;
    const size = parseFloat(cs.fontSize) || 14;
    const lh = parseFloat(cs.lineHeight) || size * 1.15;
    g.font = `${cs.fontWeight} ${size}px ${cs.fontFamily}`;
    g.textBaseline = 'top';
    const padL = parseFloat(cs.paddingLeft) + (parseFloat(cs.borderLeftWidth) || 0);
    const padT = parseFloat(cs.paddingTop) + (parseFloat(cs.borderTopWidth) || 0);
    const maxW = r.width - padL - parseFloat(cs.paddingRight) - (parseFloat(cs.borderRightWidth) || 0) + 1;
    const lines = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (g.measureText(next).width > maxW && line) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
    }
    const padB = parseFloat(cs.paddingBottom) + (parseFloat(cs.borderBottomWidth) || 0);
    const fit = Math.max(1, Math.floor((r.height - padT - padB + 2) / lh));
    if (!isTitle && lines.length > fit) {
      lines.length = fit;
      lines[fit - 1] = this._storyFit(g, `${lines[fit - 1]}…`, maxW);
    }
    if (isTitle) {
      g.save();
      // Rotated about its bottom-left corner: draw from there, with the element's own height (the
      // bounding box of a rotated element is taller than the text block).
      const h0 = el.offsetHeight || r.height;
      g.translate(x, y + r.height);
      g.rotate((-3 * Math.PI) / 180);
      g.lineJoin = 'round';
      lines.forEach((l, i) => {
        const ly = -h0 + i * lh;
        g.fillStyle = getComputedStyle(this._story.root).getPropertyValue('--story-line').trim();
        g.fillText(l, 4, ly + 4);
        g.lineWidth = 5;
        g.strokeStyle = g.fillStyle;
        g.strokeText(l, 0, ly);
        g.fillStyle = cs.color;
        g.fillText(l, 0, ly);
      });
      g.restore();
      return;
    }
    g.fillStyle = cs.color;
    lines.forEach((l, i) => g.fillText(l, x + padL, y + padT + i * lh));
  },

  // ── The wire ──

  /**
   * The wire, updated in place: rows are keyed by event id and headings by the row they head, so a
   * refresh keeps every node it can (focus, hover and the reader's place survive), patches a row whose
   * state changed and adds new rows in order. A new turn replaces the whole list. While it follows,
   * the list glides to the newest row (`_storyWireGlide`).
   */
  _storyRenderWire() {
    const st = this._story;
    const page = st.data?.supported ? st.data.page : null;
    const list = st.wireList;
    const view = this._storyWireView();
    if (!page) {
      if (list.firstElementChild) list.replaceChildren();
      view.nodes.clear();
      view.pageId = null;
      view.unseen = 0;
      this._storyWireStop();
      this._storyWirePill();
      if (st.wireCount.textContent) st.wireCount.textContent = '';
      return;
    }
    const panelOf = new Map();
    page.panels.forEach((p, i) => p.events.forEach((e) => panelOf.set(e, i)));
    // A sentence Claude wrote belongs to the panel after it (that is where its balloon is drawn);
    // after the last tool call, to the final panel.
    const finalPanel = page.panels[page.panels.length - 1]?.kind === 'complete' ? page.panels.length - 1 : -1;
    let next = finalPanel >= 0 ? finalPanel : page.panels.length - 1;
    for (let i = page.events.length - 1; i >= 0; i--) {
      if (panelOf.has(i)) next = panelOf.get(i);
      else panelOf.set(i, next);
    }
    // What the list should hold, in order. A row's key is its event id (numbered if an id repeats); a
    // heading's is the row it heads, so a panel that changes kind or number as the turn grows (a fix
    // that becomes a loop, a fold into a montage) keeps its heading node and only its words change.
    const seen = new Map();
    const unique = (key) => {
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      return n ? `${key}#${n}` : key;
    };
    const want = [];
    let lastPanel = -2;
    page.events.forEach((ev, i) => {
      const pi = panelOf.get(i);
      const key = unique(`e:${ev.id}`);
      if (pi !== lastPanel && pi >= 0) {
        const panel = page.panels[pi];
        const text = `Panel ${pi + 1} · ${STORY_KIND_NAMES[panel.kind] || panel.kind}`;
        want.push({
          key: `g:${key}`,
          sig: text,
          make: () => {
            const g = document.createElement('li');
            g.className = 'story-wire-group';
            const h = document.createElement('h3');
            h.textContent = text;
            g.append(h);
            return g;
          },
        });
        lastPanel = pi;
      }
      want.push({
        key,
        // Everything _storyEventRow reads: the same signature draws the same row.
        sig: JSON.stringify([
          ev.actor,
          ev.at,
          ev.tool,
          ev.label,
          ev.intent,
          ev.ok,
          !!ev.pending,
          !!ev.running,
          this._storyEventTarget(ev, i),
        ]),
        event: true,
        make: () => this._storyEventRow(ev, i),
      });
    });

    const reset = view.pageId !== page.id || !list.firstElementChild;
    if (reset) {
      view.nodes.clear();
      view.pageId = page.id;
      view.unseen = 0;
    }
    // Geometry is read once, before any write, and only when the decision needs it: a list that
    // follows keeps following (its own glide may still be under way, so the gap says nothing).
    const gap = reset || view.parked || view.follow ? 0 : list.scrollHeight - list.scrollTop - list.clientHeight;
    const animate = !reset && !view.parked && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nodes = new Map();
    let added = 0;
    let entering = 0;
    let changed = false;
    for (const w of want) {
      let node = view.nodes.get(w.key);
      if (node && view.sigs.get(node) !== w.sig) {
        const fresh = w.make();
        // A row still entering keeps its entrance.
        if (node.classList.contains('is-new')) fresh.classList.add('is-new');
        fresh.dataset.wireKey = w.key;
        if (node.style.animationDelay) fresh.style.animationDelay = node.style.animationDelay;
        node = storyMorph(node, fresh);
        view.sigs.set(node, w.sig);
        changed = true;
      } else if (!node) {
        node = w.make();
        node.dataset.wireKey = w.key;
        view.sigs.set(node, w.sig);
        if (animate) {
          node.classList.add('is-new');
          // Rows that arrive together come in one after another, not as a block.
          const k = Math.min(entering++, 5);
          if (k > 0) node.style.animationDelay = `${k * 45}ms`;
        }
        if (w.event) added++;
        changed = true;
      }
      nodes.set(w.key, node);
    }
    if (reset) list.replaceChildren(...nodes.values());
    else {
      // Gone first, so the rows that stay never move (moving a node would drop its focus).
      for (const [key, node] of view.nodes) {
        if (!nodes.has(key)) {
          node.remove();
          changed = true;
        }
      }
      let prev = null;
      for (const node of nodes.values()) {
        if (prev ? prev.nextElementSibling !== node : list.firstElementChild !== node) {
          if (prev) prev.after(node);
          else list.prepend(node);
        }
        prev = node;
      }
    }
    view.nodes = nodes;
    const count = `${page.toolCalls} tool call${page.toolCalls === 1 ? '' : 's'}, ${page.events.length} events. Underlined parts open.`;
    if (st.wireCount.textContent !== count) st.wireCount.textContent = count;

    if (view.parked) return; // a hidden wire is placed when it shows again (_storyWireShown)
    if (reset) {
      this._storyWirePlace(page);
      return;
    }
    Object.assign(view, storyWireAfterUpdate(view, { gap, added }));
    if (view.follow && changed) this._storyWireGlide();
    this._storyWirePill();
  },

  /** The wire's follow and scroll state, made on first use. */
  _storyWireView() {
    const st = this._story;
    st.wireView ??= {
      pageId: null,
      nodes: new Map(),
      /** What each node was drawn from (kept off the DOM: it holds the transcript's words). */
      sigs: new WeakMap(),
      follow: true,
      unseen: 0,
      lastTop: 0,
      parked: !!st.wire?.hidden,
      userAt: -Infinity,
      held: false,
      raf: 0,
      v: 0,
      t: 0,
      pos: null,
      wrote: null,
    };
    return st.wireView;
  },

  /** Whether the wire shows the newest turn while it is still running (it then opens at the bottom). */
  _storyWireLive(page) {
    const st = this._story;
    return !!page && !st.turnId && !page.complete && !page.interrupted;
  },

  /**
   * Where the wire opens: a running newest turn at the bottom, following; any other turn at the top.
   * Instant, never a glide: this is a new list, not news arriving in one.
   */
  _storyWirePlace(page) {
    const st = this._story;
    const view = this._storyWireView();
    const list = st.wireList;
    this._storyWireStop();
    view.follow = this._storyWireLive(page);
    view.unseen = 0;
    list.scrollTop = view.follow ? list.scrollHeight : 0;
    view.lastTop = list.scrollTop;
    this._storyWirePill();
  },

  /**
   * The pill under the list ("↓ 3 new"), a list that stopped following, and the listeners that tell
   * the reader's own scrolling from the list's glide. Built once, with the overlay.
   */
  _storyWireControls(wire, list) {
    const foot = document.createElement('div');
    foot.className = 'story-wire-foot';
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'story-wire-pill';
    pill.hidden = true;
    foot.append(pill);
    pill.addEventListener('click', () => this._storyWireResume());
    // The reader's own hand: a wheel, a finger, a scroll key or the scrollbar. Each stops the glide (it
    // would fight them); only a move UP while they scroll stops following (_storyWireScrolled).
    const byHand = () => {
      if (!this._story) return;
      this._storyWireView().userAt = performance.now();
      this._storyWireStop();
    };
    list.addEventListener('wheel', byHand, { passive: true });
    list.addEventListener('touchstart', byHand, { passive: true });
    list.addEventListener('touchmove', byHand, { passive: true });
    list.addEventListener('keydown', (e) => {
      if (STORY_WIRE_SCROLL_KEYS.has(e.key)) byHand();
    });
    // A press on the list itself (not on a row) is its scrollbar; a drag there takes a while.
    list.addEventListener('pointerdown', (e) => {
      if (e.target !== list || !this._story) return;
      const view = this._storyWireView();
      view.held = true;
      byHand();
      const release = () => {
        view.held = false;
        view.userAt = performance.now();
        window.removeEventListener('pointerup', release, true);
        window.removeEventListener('pointercancel', release, true);
      };
      window.addEventListener('pointerup', release, true);
      window.addEventListener('pointercancel', release, true);
    });
    list.addEventListener('scroll', () => this._storyWireScrolled(), { passive: true });
    list.addEventListener('animationend', (e) => {
      if (e.animationName !== 'story-wire-in') return;
      e.target.classList.remove('is-new');
      e.target.style.animationDelay = '';
    });
    // The wire is hidden outside the Director's cut, and a hidden list has no scroll position: when it
    // shows again it is placed afresh, whoever showed it.
    new MutationObserver(() => this._storyWireShown()).observe(wire, { attributes: true, attributeFilter: ['hidden'] });
    // A wire that changes size while it follows (a resize, the drawer) stays at the bottom.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        const view = this._story?.wireView;
        if (!view || view.parked || !view.follow || view.raf || view.held) return;
        list.scrollTop = list.scrollHeight;
      }).observe(list);
    }
    return { foot, pill };
  },

  /** The wire was hidden or shown: hidden, it rests; shown, it opens where a new list opens. */
  _storyWireShown() {
    const st = this._story;
    if (!st) return;
    const view = this._storyWireView();
    if (st.wire.hidden) {
      view.parked = true;
      this._storyWireStop();
      this._storyWirePill();
      return;
    }
    if (!view.parked) return;
    view.parked = false;
    const page = st.data?.supported ? st.data.page : null;
    if (page && st.open) this._storyWirePlace(page);
  },

  /** A scroll of the list: the reader's, or the glide's (see storyWireAfterScroll). */
  _storyWireScrolled() {
    const st = this._story;
    if (!st?.open) return;
    const view = this._storyWireView();
    if (view.parked) return;
    const list = st.wireList;
    const top = list.scrollTop;
    const gap = list.scrollHeight - top - list.clientHeight;
    const user = view.held || performance.now() - view.userAt < STORY_WIRE_HAND_MS;
    const next = storyWireAfterScroll(view, { top, gap, user });
    const flip = next.follow !== view.follow || next.unseen !== view.unseen;
    Object.assign(view, next);
    if (flip) this._storyWirePill();
  },

  /** The pill: shown while the wire does not follow a running turn, or rows came in below. */
  _storyWirePill() {
    const st = this._story;
    const pill = st?.wirePill;
    if (!pill) return;
    const view = this._storyWireView();
    const page = st.data?.supported ? st.data.page : null;
    const show = !!page && !view.parked && !view.follow && (view.unseen > 0 || this._storyWireLive(page));
    const { text, label } = storyWirePillText(view.unseen);
    if (pill.textContent !== text) pill.textContent = text;
    if (pill.getAttribute('aria-label') !== label) pill.setAttribute('aria-label', label);
    if (pill.hidden === show) {
      // A pill that hides under keyboard focus hands it to the list it brought down.
      if (!show && document.activeElement === pill) {
        st.wireList.tabIndex = -1;
        st.wireList.focus({ preventScroll: true });
      }
      pill.hidden = !show;
    }
  },

  /** The pill, clicked: down to the newest row, following again. */
  _storyWireResume() {
    const view = this._storyWireView();
    view.follow = true;
    view.unseen = 0;
    view.userAt = -Infinity;
    this._storyWirePill();
    this._storyWireGlide();
  },

  /**
   * Glides the list to its bottom. One glide at a time: an update that lands while it runs moves the
   * target, and the glide carries its speed into the new target (a critically damped spring,
   * storyWireSpring), so a burst of rows reads as one smooth motion. Under prefers-reduced-motion
   * the list jumps.
   */
  _storyWireGlide() {
    const view = this._storyWireView();
    if (view.raf || view.parked || view.held) return;
    view.t = 0;
    view.raf = requestAnimationFrame((t) => this._storyWireStep(t));
  },

  /** One frame of the glide: read the list once, then write its position once. */
  _storyWireStep(t) {
    const st = this._story;
    const view = st?.wireView;
    if (!view) return;
    view.raf = 0;
    if (!st.open || view.parked || !view.follow || view.held) {
      this._storyWireStop();
      return;
    }
    const list = st.wireList;
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    const at = list.scrollTop;
    // Something else moved the list (a row above changed height, a resize): carry on from there.
    if (view.pos === null || Math.abs(at - view.wrote) > 1.5) view.pos = at;
    // A frame that came late (the page drew panels) moves at most two frames' worth: a short slowdown
    // reads as smooth, a leap does not.
    const dt = view.t ? Math.min(1 / 30, (t - view.t) / 1000) : 1 / 60;
    view.t = t;
    const s = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? { pos: max, v: 0, done: true }
      : storyWireSpring(view.pos, view.v, max, dt);
    list.scrollTop = s.pos;
    view.pos = s.pos;
    view.wrote = s.pos;
    view.lastTop = list.scrollTop; // "up" is measured from where the glide put it
    view.v = s.v;
    if (s.done) {
      view.pos = null;
      view.t = 0;
      return;
    }
    view.raf = requestAnimationFrame((t2) => this._storyWireStep(t2));
  },

  /** Stops a glide where it is. */
  _storyWireStop() {
    const view = this._story?.wireView;
    if (!view) return;
    if (view.raf) cancelAnimationFrame(view.raf);
    view.raf = 0;
    view.v = 0;
    view.t = 0;
    view.pos = null;
  },

  _storyEventRow(ev, index) {
    const li = document.createElement('li');
    li.className = 'story-ev';
    li.dataset.actor = ev.actor;
    const t = document.createElement('span');
    t.className = 'story-ev-time';
    const d = new Date(ev.at);
    t.textContent = Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const body = document.createElement('span');
    body.className = 'story-ev-body';
    const who = document.createElement('span');
    who.className = 'story-ev-who';
    who.textContent = ev.actor;
    const tool = document.createElement('b');
    tool.textContent = ev.tool;
    const target = this._storyEventTarget(ev, index);
    let label;
    if (target) {
      label = document.createElement('button');
      label.type = 'button';
      label.className = 'story-link';
      label.dataset.storyOpen = target;
    } else {
      label = document.createElement('span');
    }
    label.textContent = this._storyShortPath(ev.label);
    if (label.textContent !== ev.label) label.title = ev.label;
    const tag = document.createElement('i');
    const waiting = ev.pending || ev.running;
    tag.className = `story-tag story-tag--${ev.ok === false ? 'bad' : waiting ? 'pending' : ev.intent}`;
    tag.textContent = ev.ok === false ? 'error' : ev.running ? 'in the background' : waiting ? 'running' : ev.intent;
    body.append(who, ' ', tool, ' ', label, ' ', tag);
    li.append(t, body);
    return li;
  },

  /**
   * A label as the reader wants it: paths inside the session's folder lose that prefix. Display only;
   * clicks keep the full path.
   */
  _storyShortPath(text, { dot = false } = {}) {
    const dir = this.sessions?.get(this._story?.sessionId)?.workingDir;
    if (!dir || dir === '/' || !text) return text;
    const base = dir.replace(/\/+$/, '');
    const short = text.split(`${base}/`).join('');
    // In a command the folder itself reads as `.` (`ls .`); in prose that would say nothing.
    if (!dot) return short;
    return short.replace(new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s'"\`:;,)])`, 'g'), '.');
  },

  /** What a click on an event opens, as a `data-story-open` target, or null. */
  _storyEventTarget(ev, index) {
    if (ev.edit || ev.edits?.length) return `diff:event:${index}`;
    if (ev.helper) return `helper:event:${index}`;
    if (ev.output !== undefined || ev.outputTruncated) return `output:event:${index}`;
    if (ev.file) return `file:event:${index}`;
    if (ev.question) return `ask:event:${index}`;
    if (ev.todos) return `plan:event:${index}`;
    return null;
  },

  // ── Click targets and the drawer ──

  /**
   * Targets: `<what>@<kind>:<panel>` from a canvas hit, `<what>:event:<i>` from the wire or the
   * drawer, `<what>:page` from the final panel's chips.
   */
  _storyOpenTarget(target, trigger) {
    const st = this._story;
    const page = st.data?.page;
    if (!page) return;
    const at = target.indexOf('@');
    if (at >= 0) {
      const what = target.slice(0, at);
      const panelIndex = Number(target.slice(target.lastIndexOf(':') + 1));
      const panel = page.panels[panelIndex];
      if (!panel) return;
      if (what.startsWith('file:')) {
        const file = panel.files?.[Number(what.slice(5))];
        if (file) this._storyOpenFile(this._storyResolvePath(file), trigger);
        return;
      }
      const [view, arg] = what.split(':');
      if (view === 'helper') {
        this._storyOpenDrawer({ view: 'helper', event: page.events[Number(arg)]?.id }, trigger);
        return;
      }
      this._storyOpenDrawer(
        { view, panel: panelIndex, kind: panel.kind, first: page.events[panel.events[0]]?.id },
        trigger
      );
      return;
    }
    const [view, scope, arg] = target.split(':');
    if (scope === 'page') {
      this._storyOpenDrawer({ view, page: true }, trigger);
      return;
    }
    const ev = page.events[Number(arg)];
    if (!ev) return;
    if (view === 'file') {
      this._storyOpenFile(this._storyResolvePath(ev.file), trigger);
      return;
    }
    this._storyOpenDrawer({ view, event: ev.id }, trigger);
  },

  /**
   * Opens a file in the file preview on top of Story Mode, with keyboard focus on the preview's close
   * button; Escape gives it back to what opened it.
   */
  _storyOpenFile(path, trigger) {
    const st = this._story;
    if (!st || !path) return;
    st.previewReturn = trigger || document.activeElement;
    st.root.setAttribute('aria-modal', 'false');
    this.openFilePreview?.(path, st.sessionId);
    requestAnimationFrame(() =>
      document.querySelector('#filePreviewOverlay.visible button[title="Close"]')?.focus({ preventScroll: true })
    );
  },

  /** A path as a transcript named it, made absolute against the session's folder when relative. */
  _storyResolvePath(path) {
    const workingDir = this.sessions?.get(this._story?.sessionId)?.workingDir;
    return typeof resolveLinkedFilePath === 'function' ? resolveLinkedFilePath(path, workingDir) : path;
  },

  _storyOpenDrawer(source, trigger) {
    const st = this._story;
    if (!st.drawer) st.drawerReturn = trigger || null;
    // Bound to the turn it was opened on: if the newest turn moves on, the page holds this one.
    st.drawer = { ...source, pageId: st.data?.page?.id };
    st.drawerSeen = new Set();
    st.drawerSig = null;
    st.drawerEl.hidden = false;
    st.root.classList.add('has-drawer');
    this._storyDrawerCover();
    // On a phone the drawer is a sheet from the bottom: it starts below the bar, whatever its height.
    const bar = st.root.querySelector('.story-bar');
    if (bar) st.root.style.setProperty('--story-bar-h', `${bar.offsetHeight}px`);
    this._storyRenderDrawer(true);
    st.drawerEl.querySelector('.story-drawer-close')?.focus({ preventScroll: true });
  },

  _storyCloseDrawer({ refocus = true } = {}) {
    const st = this._story;
    if (!st?.drawer) return;
    st.drawer = null;
    st.drawerEl.hidden = true;
    st.root.classList.remove('has-drawer');
    this._storyDrawerCover();
    // A page held for this drawer follows the newest turn again.
    if (st.drawerHolds) {
      st.drawerHolds = false;
      st.turnId = null;
      st.etag = null;
      if (st.open) this._storyRefresh();
    }
    st.drawerBody.replaceChildren();
    let back = st.drawerReturn;
    st.drawerReturn = null;
    // A control rebuilt while the drawer was open: its replacement opens the same thing.
    const key = back && !document.contains(back) ? back.dataset?.storyOpen : undefined;
    if (key) {
      const opens = [...st.root.querySelectorAll('[data-story-open]')];
      // `diff@fix:1` opens the same view of the same panel as `diff@loop:1` once the fix became a loop.
      const m = /^([^@]*)@[^:]*:(\d+)$/.exec(key);
      back =
        opens.find((n) => n.dataset.storyOpen === key) ||
        (m &&
          opens.find((n) => n.dataset.storyOpen.startsWith(`${m[1]}@`) && n.dataset.storyOpen.endsWith(`:${m[2]}`)));
    }
    if (refocus && back && document.contains(back)) back.focus({ preventScroll: true });
  },

  /** The events a drawer shows, recomputed from the newest page so a live view keeps up. */
  _storyDrawerEvents(source, page) {
    if (source.event) {
      const i = page.events.findIndex((e) => e.id === source.event);
      return i >= 0 ? [{ ev: page.events[i], i }] : [];
    }
    let indices;
    if (source.page) indices = page.events.map((_, i) => i);
    else {
      // A refresh can regroup panels (a check folds into a loop): follow the panel that holds the
      // first event it showed, then fall back to the same index and kind.
      const firstIdx = source.first ? page.events.findIndex((e) => e.id === source.first) : -1;
      const panel = page.panels[source.panel];
      const match =
        (firstIdx >= 0 && page.panels.find((p) => p.events.includes(firstIdx))) ||
        (panel && panel.kind === source.kind ? panel : page.panels.find((p) => p.kind === source.kind));
      indices = match ? match.events : [];
    }
    return indices.map((i) => ({ ev: page.events[i], i })).filter((x) => x.ev);
  },

  _storyRenderDrawer(first) {
    const st = this._story;
    const source = st.drawer;
    const page = st.data?.page;
    if (!source || !page) return;
    const items = this._storyDrawerEvents(source, page);
    const body = st.drawerBody;
    const prevScroll = body.scrollTop;
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const live = !page.complete && !page.interrupted && !st.turnId;
    st.drawerLive.hidden = !live;
    let kind = '';
    let title = '';
    let sub = '';
    const out = [];
    // Helper boxes, filled once the drawer knows which nodes stay: [box, agentId, working].
    const fills = [];
    let firstNew = null;
    const isNew = (id) => !first && !st.drawerSeen.has(id);

    // Changes made from the terminal (`sed -i`, a redirect) have no diff to show: show what ran.
    const view =
      source.view === 'diff' && items.length && !items.some((x) => StoryArt.editsOf(x.ev).length || x.ev.pending)
        ? 'output'
        : source.view;
    if (view === 'prompt') {
      const prompts = items.filter((x) => x.ev.intent === 'prompt');
      const from = prompts[0]?.ev.origin ?? 'human';
      kind = from === 'task' ? 'Report' : from === 'peer' ? 'Message' : 'Mission';
      title =
        from === 'task'
          ? 'A background job reports back'
          : from === 'peer'
            ? 'A message from another session'
            : prompts.length > 1
              ? 'What you asked'
              : 'Your prompt';
      for (const { ev } of prompts) {
        out.push(el('pre', 'story-pre story-prompt', ev.label));
        if (ev.output !== undefined) {
          out.push(el('h4', 'story-h', 'What it reported'), this._storyLinkifiedPre(ev.output, { rooted: true }));
          if (ev.outputTruncated) out.push(el('p', 'story-empty', 'The report is cut here.'));
        }
        if (ev.helper?.agentId) {
          const box = el('div', 'story-helper-steps');
          out.push(el('h4', 'story-h', 'What the helper did'), box);
          fills.push([box, ev.helper.agentId, false]);
        }
      }
      if (prompts.some((x) => x.ev.label.length >= 3999))
        out.push(el('p', 'story-empty', 'A long prompt is cut here; the terminal has all of it.'));
    } else if (view === 'diff') {
      const edits = items.flatMap((x) =>
        StoryArt.editsOf(x.ev).map((d, k) => ({ ev: x.ev, edit: d, key: `${x.ev.id}#${k}` }))
      );
      kind = 'Diff';
      const added = edits.reduce((n, x) => n + x.edit.added, 0);
      const removed = edits.reduce((n, x) => n + x.edit.removed, 0);
      const files = new Set(edits.map((x) => x.edit.file)).size;
      title = files === 1 ? this._storyShortPath(edits[0].edit.file) : `${files} files`;
      const counts = [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ') || '±0';
      sub = `${edits.length} edit${edits.length === 1 ? '' : 's'} · ${counts}${live ? ' · new edits slide in as Claude makes them' : ''}`;
      if (!edits.length) out.push(el('p', 'story-empty', 'No changes in this part of the turn yet.'));
      for (const { ev, edit } of edits) {
        const section = this._storyDiffSection(edit, el);
        if (isNew(ev.id)) {
          section.classList.add('story-arrive');
          firstNew ??= section;
        }
        out.push(section);
      }
      // A command that changed files and also printed something (`cat a.py`): what it printed too.
      for (const { ev, i } of items)
        if (ev.tool === 'Bash' && StoryArt.editsOf(ev).length && (ev.files?.length || (ev.output || '').trim()))
          out.push(this._storyOutputSection(ev, i, el, { inDiff: true }));
    } else if (view === 'output' || view === 'list') {
      const withOutput = items.filter((x) => x.ev.tool !== 'Text' && x.ev.intent !== 'prompt');
      kind = view === 'list' ? 'Steps' : 'Output';
      title = source.page ? 'Every step of this turn' : STORY_KIND_NAMES[source.kind] || 'Steps';
      sub = `${withOutput.length} step${withOutput.length === 1 ? '' : 's'}`;
      if (!withOutput.length) out.push(el('p', 'story-empty', 'Nothing here yet.'));
      for (const { ev, i } of withOutput) {
        const section = this._storyOutputSection(ev, i, el);
        if (isNew(ev.id)) {
          section.classList.add('story-arrive');
          firstNew ??= section;
        }
        out.push(section);
      }
    } else if (view === 'helper') {
      const ev = items[0]?.ev;
      kind = ev?.helper?.type === 'advisor' ? 'Advisor' : 'Helper';
      title = ev?.helper ? ev.helper.task || ev.helper.name : 'Helper';
      const h = ev?.helper;
      const working = !!(ev?.pending || h?.running);
      sub = h
        ? [
            h.name && h.name !== h.type ? `${h.name}, ${h.type}` : h.type,
            h.background ? 'in the background' : '',
            h.toolUses !== undefined ? `${h.toolUses} tool call${h.toolUses === 1 ? '' : 's'}` : '',
            h.durationMs !== undefined ? this._storyDuration(h.durationMs) : '',
            working ? 'still working' : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
      if (h) {
        out.push(
          el('h4', 'story-h', 'Claude asked'),
          this._storyLinkifiedPre(h.prompt || '(no prompt)', { rooted: true })
        );
        out.push(
          el('h4', 'story-h', 'The helper answered'),
          h.result
            ? this._storyLinkifiedPre(h.result, { rooted: true })
            : el(
                'p',
                'story-empty',
                h.running
                  ? 'Still working in the background. Its answer comes back when it finishes.'
                  : working
                    ? 'Still working…'
                    : 'No answer came back.'
              )
        );
        if (h.agentId) {
          const box = el('div', 'story-helper-steps');
          out.push(el('h4', 'story-h', 'What the helper did'), box);
          fills.push([box, h.agentId, working]);
        }
      }
    } else if (view === 'plan') {
      const ev = [...items].reverse().find((x) => x.ev.todos)?.ev;
      kind = 'Plan';
      title = 'The plan';
      const ul = el('ul', 'story-todos');
      for (const t of ev?.todos || []) {
        const li = el('li', t.done ? 'is-done' : '', t.text);
        ul.append(li);
      }
      if (!ev) for (const x of items) ul.append(el('li', '', x.ev.label));
      out.push(ul);
    } else if (view === 'ask') {
      const ev = items.find((x) => x.ev.question)?.ev;
      const plan = ev?.tool === 'ExitPlanMode';
      kind = 'Your call';
      title = ev?.question?.text || 'Question';
      if (plan && ev.output)
        out.push(el('h4', 'story-h', 'The plan'), this._storyLinkifiedPre(ev.output, { rooted: true }));
      if (ev?.question?.options?.length) {
        const ul = el('ul', 'story-todos');
        for (const o of ev.question.options) ul.append(el('li', o === ev.question.answer ? 'is-chosen' : '', o));
        out.push(ul);
      }
      out.push(
        el(
          'p',
          'story-answer-line',
          ev?.question?.answer
            ? plan
              ? ev.question.answer === 'Approved'
                ? 'You approved the plan.'
                : 'You sent the plan back.'
              : `You chose: ${ev.question.answer}`
            : 'Waiting for your answer in the terminal.'
        )
      );
    } else if (view === 'said') {
      // Claude's own last words, which the Simple level's summary stands in for: what it wrote after
      // its last step (the final panel's balloon), each message as Claude wrote it.
      const lastStep = page.panels.reduce((n, p) => Math.max(n, ...p.events), -1);
      const words = items.filter((x) => x.i > lastStep && x.ev.intent === 'say');
      kind = 'Message';
      title = "Claude's last words";
      for (const { ev } of words) {
        out.push(this._storyLinkifiedPre(ev.label, { rooted: true }));
        // A long message is kept only in part: what it says further in (a problem, what is left) follows.
        if (ev.label.endsWith('…')) {
          const more = (ev.keyPoints || []).filter((k) => !ev.label.includes(k));
          if (more.length) {
            out.push(el('h4', 'story-h', 'Further in, Claude says'));
            const ul = el('ul', 'story-todos');
            for (const k of more) ul.append(el('li', '', k));
            out.push(ul);
          }
          out.push(el('p', 'story-empty', 'Only the start of the message is kept here.'));
        }
      }
      const fin = page.panels[page.panels.length - 1];
      if (!words.length && fin?.balloon?.text) out.push(this._storyLinkifiedPre(fin.balloon.text, { rooted: true }));
      if (!out.length) out.push(el('p', 'story-empty', 'Claude wrote nothing at the end of this turn.'));
    }

    st.drawerKind.textContent = kind;
    st.drawerTitle.textContent = title;
    st.drawerSub.textContent = sub;
    // A refresh that changes nothing keeps the nodes, so focus, a text selection and the scroll
    // stay put; only a helper still working refreshes its steps.
    const sig = [view, kind, title, sub, ...out.map((n) => n.outerHTML)].join('\u0000');
    if (!first && sig === st.drawerSig) {
      for (const box of body.querySelectorAll('.story-helper-steps'))
        if (box.dataset.working === '1') this._storyFillHelperSteps(box, box.dataset.agent, true);
      return;
    }
    st.drawerSig = sig;
    // A real change rebuilds: focus goes back to the control that does the same thing.
    const active = document.activeElement;
    const controls = (root) => [...root.querySelectorAll('button, a[href], [tabindex]')];
    const was =
      active && body.contains(active)
        ? { open: active.dataset?.storyOpen, text: active.textContent, at: controls(body).indexOf(active) }
        : null;
    body.replaceChildren(...out);
    for (const [box, agentId, working] of fills) this._storyFillHelperSteps(box, agentId, working);
    for (const { ev } of items) st.drawerSeen.add(ev.id);
    if (was) {
      const now = controls(body);
      const back =
        (was.open && now.find((n) => n.dataset?.storyOpen === was.open)) ||
        now.find((n) => n.textContent === was.text) ||
        now[Math.min(was.at, now.length - 1)];
      back?.focus({ preventScroll: true });
    }
    if (first) body.scrollTop = 0;
    else if (firstNew) body.scrollTop = Math.max(0, firstNew.offsetTop - 12);
    else body.scrollTop = prevScroll;
  },

  /** A helper's own steps (GET …/story/helpers/:agentId), cached per helper and revalidated by ETag. */
  async _storyFillHelperSteps(box, agentId, working = false) {
    const st = this._story;
    box.dataset.agent = agentId;
    box.dataset.working = working ? '1' : '';
    const cached = st.helperSteps?.get(agentId);
    if (cached) this._storyRenderHelperSteps(box, cached.data);
    else {
      const p = document.createElement('p');
      p.className = 'story-empty';
      p.textContent = 'Reading its steps…';
      box.replaceChildren(p);
    }
    // One request per helper at a time, and only the newest one's answer is drawn.
    st.helperSeq ??= new Map();
    const seq = (st.helperSeq.get(agentId) || 0) + 1;
    st.helperSeq.set(agentId, seq);
    const res = await this._api(
      `/api/sessions/${encodeURIComponent(st.sessionId)}/story/helpers/${encodeURIComponent(agentId)}`
    );
    if (!box.isConnected || !st.open || st.helperSeq.get(agentId) !== seq) return;
    const etag = res?.ok ? res.headers?.get?.('etag') || null : null;
    if (cached && etag && etag === cached.etag) return;
    let body = null;
    try {
      body = res?.ok ? await res.json() : null;
    } catch {
      body = null;
    }
    if (!box.isConnected || !st.open) return;
    if (!body?.success) {
      // Only over the placeholder: never over steps another answer already drew.
      const only = box.firstElementChild;
      if (box.childElementCount === 1 && only?.classList.contains('story-empty'))
        only.textContent = 'Its steps could not be read.';
      return;
    }
    st.helperSteps?.set(agentId, { etag, data: body.data });
    this._storyRenderHelperSteps(box, body.data);
  },

  _storyRenderHelperSteps(box, data) {
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const page = data?.page;
    if (!page) {
      box.replaceChildren(el('p', 'story-empty', 'No steps written yet.'));
      return;
    }
    const steps = page.events.filter((e) => e.intent !== 'prompt' && e.intent !== 'say');
    const summary = [
      `${steps.length} step${steps.length === 1 ? '' : 's'}`,
      page.filesChanged ? `${page.filesChanged} file${page.filesChanged === 1 ? '' : 's'} changed` : '',
      data.helper?.finished === false || (box.dataset.working === '1' && data.helper?.finished !== true)
        ? 'still working'
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const list = el('ol', 'story-helper-list');
    for (const ev of steps) {
      const li = el('li', 'story-ev');
      li.dataset.actor = 'helper';
      const body = el('span', 'story-ev-body');
      const shown = this._storyShortPath(ev.label, { dot: ev.tool === 'Bash' });
      const label = ev.file ? el('button', 'story-link', shown) : el('span', null, shown);
      if (shown !== ev.label) label.title = ev.label;
      if (ev.file) {
        label.type = 'button';
        label.addEventListener('click', (e) => this._storyOpenFile(ev.file, e.currentTarget));
      }
      const tag = el(
        'i',
        `story-tag story-tag--${ev.ok === false ? 'bad' : ev.pending ? 'pending' : ev.intent}`,
        ev.ok === false ? 'error' : ev.pending ? 'running' : ev.intent
      );
      body.append(el('b', null, ev.tool), ' ', label, ' ', tag);
      li.append(body);
      list.append(li);
    }
    box.replaceChildren(el('p', 'story-out-desc', summary), list);
  },

  _storyDiffSection(edit, el) {
    const section = el('section', 'story-df');
    const head = el('div', 'story-df-head');
    const name = el('span', 'story-df-path', this._storyShortPath(edit.file));
    if (name.textContent !== edit.file) name.title = edit.file;
    const cnt = el('span', 'story-cnt');
    cnt.append(
      el('span', 'story-cnt-a', edit.added ? `+${edit.added}` : ''),
      ' ',
      el('span', 'story-cnt-d', edit.removed ? `−${edit.removed}` : '')
    );
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'story-btn-s';
    open.textContent = 'Open file';
    open.setAttribute('aria-label', `Open ${this._storyShortPath(edit.file)}`);
    open.addEventListener('click', (e) => this._storyOpenFile(edit.file, e.currentTarget));
    head.append(name, cnt, open);
    section.append(head);
    const code = el('div', 'story-code');
    for (const h of edit.hunks || []) {
      code.append(
        el(
          'div',
          'story-ln story-ln--hunk',
          h.atEnd
            ? `Added at the end of the file (${h.newLines} ${h.newLines === 1 ? 'line' : 'lines'})`
            : `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`
        )
      );
      let o = h.oldStart;
      let n = h.newStart;
      for (const line of h.lines) {
        const mark = line[0];
        const row = el('div', `story-ln${mark === '+' ? ' story-ln--add' : mark === '-' ? ' story-ln--del' : ''}`);
        row.append(
          el('span', 'story-ln-no', mark === '+' || h.atEnd ? '' : String(o)),
          el('span', 'story-ln-no', mark === '-' || h.atEnd ? '' : String(n)),
          el('span', 'story-ln-mk', mark === '+' ? '+' : mark === '-' ? '−' : ''),
          el('span', 'story-ln-tx', line.slice(1) || ' ')
        );
        if (mark !== '+') o++;
        if (mark !== '-') n++;
        code.append(row);
      }
    }
    section.append(code);
    if (edit.truncated)
      section.append(
        el(
          'p',
          'story-empty',
          edit.hunks?.length
            ? 'Some lines of this edit were left out. Open the file to see all of it.'
            : edit.added || edit.removed
              ? 'The lines of this edit were left out to keep a long turn fast. Open the file to see it as it is now.'
              : 'What changed is not in the transcript: a script or another program wrote this file. Open it to see it as it is now.'
        )
      );
    return section;
  },

  _storyOutputSection(ev, index, el, { inDiff = false } = {}) {
    const section = el('section', 'story-out');
    const head = el('div', 'story-out-head');
    const shown = this._storyShortPath(ev.label, { dot: ev.tool === 'Bash' });
    const cmd = el('span', 'story-out-cmd', `${ev.tool === 'Bash' ? '$ ' : `${ev.tool} `}${shown}`);
    if (ev.label !== shown) cmd.title = ev.label;
    const waiting = ev.pending || ev.running;
    const status = el(
      'span',
      `story-tag story-tag--${ev.ok === false ? 'bad' : waiting ? 'pending' : 'ok'}`,
      ev.ok === false ? 'error' : ev.running ? 'in the background' : waiting ? 'running' : 'ok'
    );
    head.append(cmd, status);
    section.append(head);
    if (ev.description) section.append(el('p', 'story-out-desc', ev.description));
    const target = this._storyEventTarget(ev, index);
    if (ev.output !== undefined) {
      section.append(this._storyLinkifiedPre(ev.output));
      if (ev.outputTruncated) section.append(el('p', 'story-empty', 'Only the end of this output is kept.'));
      // A command that also wrote files (a here-document) offers the change, not only what it printed.
      if (ev.edits?.length && !inDiff) {
        const b = el(
          'button',
          'story-btn-s',
          `See the ${ev.edits.length === 1 ? 'file' : `${ev.edits.length} files`} it wrote`
        );
        b.type = 'button';
        b.dataset.storyOpen = `diff:event:${index}`;
        section.append(b);
      }
      // Files it printed (`cat a.py`): open them as they are now.
      if (ev.files?.length && ev.intent !== 'look') {
        const row = el('div', 'story-out-files');
        for (const f of ev.files.slice(0, 4)) {
          const b = el('button', 'story-btn-s', `Open ${f.split('/').pop()}`);
          b.type = 'button';
          b.title = f;
          b.addEventListener('click', (e) => this._storyOpenFile(this._storyResolvePath(f), e.currentTarget));
          row.append(b);
        }
        section.append(row);
      }
    } else if (ev.outputTruncated) {
      section.append(el('p', 'story-empty', 'This output was left out to keep a long turn fast.'));
    } else if (target && !target.startsWith('output:')) {
      const b = el(
        'button',
        'story-btn-s',
        ev.edit || ev.edits?.length ? 'See the change' : ev.file ? 'Open file' : 'Open'
      );
      b.type = 'button';
      b.dataset.storyOpen = target;
      section.append(b);
    }
    return section;
  },

  /**
   * Output text with every file path as a link into the file preview (the terminal's own matcher).
   * `rooted` keeps only absolute and `~/` paths: in prose (a prompt, a helper's answer) a bare name is
   * as often an example (`old.jpg`) as a file.
   */
  _storyLinkifiedPre(text, { rooted = false } = {}) {
    const pre = document.createElement('pre');
    pre.className = 'story-pre';
    const value = String(text || '');
    // A glob (`*.test.ts`) or a path a tool elided (`2...rted_0/a.txt`) names no one file.
    const links =
      typeof findFilePathLinks === 'function'
        ? findFilePathLinks(value).filter(
            (l) =>
              !l.folder &&
              (!rooted || /^(\/|~\/)/.test(l.path)) &&
              !/\.\.\.|…|[*?]/.test(l.path) &&
              !/[*?]$/.test(value.slice(0, l.index))
          )
        : [];
    const workingDir = this.sessions?.get(this._story.sessionId)?.workingDir;
    // The `ls` header (`some/dir:`) in force on each line: the newest one above it in its paragraph.
    // One pass over the lines (a search per link over the text before it was quadratic).
    const lineDirs = [];
    const lineEnds = [];
    {
      let dir = null;
      let at = 0;
      for (const line of value.split('\n')) {
        lineDirs.push(dir);
        at += line.length + 1;
        lineEnds.push(at);
        if (!line.trim()) dir = null;
        else {
          const m = /^([^\s:][^:]*):[ \t]*$/.exec(line);
          if (m) dir = m[1];
        }
      }
    }
    let lineNo = 0;
    let last = 0;
    for (const link of links) {
      pre.append(document.createTextNode(this._storyShortPath(value.slice(last, link.index))));
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'story-link';
      b.textContent = this._storyShortPath(link.path);
      if (b.textContent !== link.path) b.title = link.path;
      // A bare name listed under an `ls` header (`some/dir:`) lives in that directory.
      let target = link.path;
      while (lineNo < lineEnds.length - 1 && lineEnds[lineNo] <= link.index) lineNo++;
      const dir = lineDirs[lineNo];
      if (!target.includes('/') && dir) target = `${dir.replace(/\/+$/, '')}/${target}`;
      const resolved = typeof resolveLinkedFilePath === 'function' ? resolveLinkedFilePath(target, workingDir) : target;
      b.addEventListener('click', (e) => this._storyOpenFile(resolved, e.currentTarget));
      pre.append(b);
      last = link.index + link.path.length;
    }
    pre.append(document.createTextNode(this._storyShortPath(value.slice(last))));
    return pre;
  },
});

// ── The wire: follow and glide (pure) ──

/** Within this many pixels of the bottom, the wire counts as at the bottom: it follows. */
const STORY_WIRE_BOTTOM_PX = 40;
/** A scroll this soon after the reader's own input (wheel, finger, key, scrollbar) is theirs. */
const STORY_WIRE_HAND_MS = 400;
/** Keys that scroll a focused list. */
const STORY_WIRE_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/**
 * Stiffness of the glide (1/s): a critically damped spring settles in about 5.8 / ω, here ~0.48 s,
 * before the next refresh can land (0.8 s debounce). Stiffer made a tall row (a long command) arrive
 * at ~25 px a frame.
 */
const STORY_WIRE_OMEGA = 12;

/**
 * What a scroll of the wire means for following. Back at the bottom (by hand or by the glide) it
 * follows again; moving up by the reader's own hand stops it. Anything else changes nothing: the
 * glide only ever moves down, and a row above that changes height moves the list without anyone
 * scrolling it.
 */
function storyWireAfterScroll(view, { top, gap, user }) {
  const up = top < view.lastTop - 1;
  if (gap <= STORY_WIRE_BOTTOM_PX) return { follow: true, unseen: 0, lastTop: top };
  if (up && user) return { follow: false, unseen: view.unseen, lastTop: top };
  return { follow: view.follow, unseen: view.unseen, lastTop: top };
}

/**
 * New rows came in. A wire that follows keeps following, and one at the bottom starts; one the
 * reader scrolled up counts them for the pill. `gap` is the distance to the bottom before the rows
 * came in.
 */
function storyWireAfterUpdate(view, { gap, added }) {
  if (view.follow || gap <= STORY_WIRE_BOTTOM_PX) return { follow: true, unseen: 0 };
  return { follow: false, unseen: view.unseen + added };
}

/** The pill's words, and what a screen reader hears. */
function storyWirePillText(unseen) {
  if (!unseen) return { text: '↓ Newest', label: 'Scroll to the newest event' };
  return {
    text: `↓ ${unseen} new`,
    label: `${unseen} new event${unseen === 1 ? '' : 's'}. Scroll to the newest.`,
  };
}

/**
 * One step (`dt` seconds) of a critically damped spring from `pos` (moving at `v` px/s) toward
 * `target`. A new target keeps the speed, so a glide that is retargeted mid-way never stops and
 * restarts. Toward a target below, it only ever moves down and never past it.
 */
function storyWireSpring(pos, v, target, dt, omega = STORY_WIRE_OMEGA) {
  if (target < pos) return { pos: target, v: 0, done: true };
  const x = pos - target;
  const e = Math.exp(-omega * dt);
  const c = v + omega * x;
  let np = target + (x + c * dt) * e;
  let nv = (v - omega * c * dt) * e;
  if (np < pos) {
    np = pos;
    nv = Math.max(0, nv);
  }
  if (np > target) np = target;
  if (target - np < 0.5 && Math.abs(nv) < 30) return { pos: target, v: 0, done: true };
  return { pos: np, v: nv, done: false };
}

/**
 * Makes `node` match `fresh` (built the same way, from newer data) while keeping every node that can
 * stay: an element whose tag is unchanged is patched (attributes, text, children), so focus and hover
 * on it survive. Returns the node that ends up in the tree.
 */
function storyMorph(node, fresh) {
  if (node.nodeType !== fresh.nodeType || node.nodeName !== fresh.nodeName) {
    node.replaceWith(fresh);
    return fresh;
  }
  if (node.nodeType !== 1) {
    if (node.nodeValue !== fresh.nodeValue) node.nodeValue = fresh.nodeValue;
    return node;
  }
  for (const a of [...node.attributes]) if (!fresh.hasAttribute(a.name)) node.removeAttribute(a.name);
  for (const a of [...fresh.attributes]) if (node.getAttribute(a.name) !== a.value) node.setAttribute(a.name, a.value);
  const want = [...fresh.childNodes];
  want.forEach((child, i) => {
    const have = node.childNodes[i];
    if (have) storyMorph(have, child);
    else node.append(child);
  });
  while (node.childNodes.length > want.length) node.lastChild.remove();
  return node;
}
