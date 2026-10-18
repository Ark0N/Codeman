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
  /** Where Claude's head was last drawn (stage units): the speech balloon is placed over it. */
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
    // Claude is the cyan one; a helper in another colour never holds the balloon.
    if (body === C.cyan) speaker = { x, top: y + (hy - 36) * s };
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
  function terminal(ctx, x, y, w, h, lines, f) {
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
      const text = fitText(ctx, `› ${line}`, w - 18);
      const shown = Math.floor(interpolate(f, [8 + i * 12, 20 + i * 12], [0, text.length]));
      ctx.fillStyle = i === Math.min(rows, lines.length) - 1 ? C.yellow : C.balloon;
      ctx.fillText(text.slice(0, shown), x + 9, y + 30 + i * 14);
    });
    if (f % 30 < 15) {
      const n = Math.min(rows, lines.length);
      ctx.fillStyle = C.balloon;
      ctx.fillRect(x + 9, y + 22 + n * 14, 6, 10);
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
          terminal(
            ctx,
            14,
            92,
            Math.min(W * 0.58, 220),
            130,
            p.panel.notes?.length ? p.panel.notes : ['looking around'],
            f
          );
          hit('list', 14, 92, Math.min(W * 0.58, 220), 130, 'See what Claude looked at');
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
        if (p.panel.added)
          sfx(
            ctx,
            `+${p.panel.added}`,
            x0 + pw * 0.32,
            y0 + ph + 2,
            26,
            C.go,
            -0.18,
            spring(f - 44, { damping: 9, stiffness: 170 })
          );
        if (p.panel.removed)
          sfx(
            ctx,
            `−${p.panel.removed}`,
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
          b = board(ctx, 16, 106, `${total} tests`, dots, fail, fill);
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
        const jump = p.panel.ok && f > 30 ? Math.abs(Math.sin((f - 30) / 7)) * 12 : 0;
        agent(ctx, W - 40, 254 - jump, {
          frame: f,
          scale: 0.66,
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
            b = board(ctx, bx, 116, `${total} tests`, dots, fail, Math.min(dots, (f - 4) * 1.6));
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
        terminal(ctx, 14, 92, tw, 140, notes, f);
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
        rays(ctx, W, H, W > 420 ? W * 0.72 : W / 2, 200, 30, C.cyan, 0.32);
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
        if (p.page.noneWorked) {
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

  return { FPS, HERO, VH, C, readColors, spring, SCENES, takeSpeaker, editsOf, inBand };
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
    st.returnFocus = document.activeElement;
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
    const storyBtn = btn('story-seg-btn', 'Story');
    const dirBtn = btn('story-seg-btn', "Director's cut");
    seg.append(storyBtn, dirBtn);

    const live = el('span', 'story-live');
    live.append(el('i'), el('span', null, 'LIVE'));
    live.hidden = true;
    const saveBtn = btn('story-btn story-save', 'Save image', 'Save this page as an image');
    saveBtn.title = 'Save this page as a PNG to share';
    const closeBtn = btn('story-btn story-close', '×', 'Close Story Mode');
    bar.append(brand, nav, seg, live, saveBtn, closeBtn);
    // What a screen reader hears as the page changes: a new turn, a finished one.
    const announcer = el('p', 'story-sr');
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
    wire.append(wireHead, wireList);
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
      storyBtn,
      dirBtn,
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
      drawerEl: drawer,
      drawerKind,
      drawerLive,
      drawerTitle,
      drawerSub,
      drawerBody,
    };
    this._story = st;

    closeBtn.addEventListener('click', () => this.closeStoryMode());
    saveBtn.addEventListener('click', () => this.saveStoryImage());
    drawerClose.addEventListener('click', () => this._storyCloseDrawer());
    storyBtn.addEventListener('click', () => this._storySetDirector(false));
    dirBtn.addEventListener('click', () => this._storySetDirector(true));
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
    this._storySetDirector(false);
    return st;
  },

  _storyApplyTheme() {
    const st = this._story;
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    st.root.classList.toggle('story-paper', /light/.test(scheme) && !/dark/.test(scheme));
    StoryArt.readColors(st.root);
    for (const rt of st.panels) rt.bgKey = '';
  },

  _storySetDirector(on) {
    const st = this._story;
    st.director = on;
    st.root.classList.toggle('is-director', on);
    st.storyBtn.setAttribute('aria-pressed', String(!on));
    st.dirBtn.setAttribute('aria-pressed', String(on));
    st.wire.hidden = !on;
    if (on) this._storyRenderWire();
    for (const rt of st.panels) this._storyDrawPanel(rt);
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
    st.inFlight = true;
    const epoch = st.epoch;
    try {
      const qs = st.turnId ? `?turn=${encodeURIComponent(st.turnId)}` : '';
      const res = await this._api(`/api/sessions/${encodeURIComponent(st.sessionId)}/story${qs}`);
      if (epoch !== st.epoch || !st.open) return;
      // The route sends an ETag and no-cache, so the browser revalidates and an unchanged page comes
      // back from its cache with the same tag: nothing to parse, nothing to redraw.
      const etag = res?.ok ? res.headers?.get?.('etag') || null : null;
      if (etag && etag === st.etag && !st.error) return;
      let body = null;
      try {
        body = res ? await res.json() : null;
      } catch {
        body = null;
      }
      if (epoch !== st.epoch || !st.open) return;
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
      st.inFlight = false;
      if (st.again) {
        st.again = false;
        this._storyScheduleRefresh(250);
      }
    }
  },

  // ── Runtime: frame loop, observers, poll, Escape ──

  _storyStartRuntime() {
    const st = this._story;
    const bar = st.root.querySelector('.story-bar');
    st.ro = new ResizeObserver((entries) => {
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
      if (!st.turnId && (!page || !page.complete)) {
        this._storyRefresh();
        return;
      }
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
      for (const rt of st.panels) this._storyDrawPanel(rt);
    });
    st.skinObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'class'] });
    document.fonts?.ready?.then(() => {
      if (!st.open) return;
      for (const rt of st.panels) {
        rt.bgKey = '';
        this._storyDrawPanel(rt);
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
    const finished = `${done ? `Turn finished. ${last?.caption.story || ''}` : ''}`.trim();
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
    want.forEach((panel, i) => {
      const rt = st.panels[i];
      rt.panel = panel;
      if (rt.isNew) {
        // Sized now, not when the resize observer reports: a new panel never shows an empty frame.
        rt.isNew = false;
        this._storySizePanel(rt);
      }
      rt.el.style.setProperty('--story-span6', String(spans6[i]));
      rt.el.style.setProperty('--story-span2', String(spans2[i]));
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
    cap.append(capStory, capDir);
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
    const balloonText = p.kind === 'ask' && p.question?.text ? p.question.text : p.balloon?.text;
    rt.balloon.hidden = !balloonText;
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
            ? 'Turn over'
            : page.helpersRunning || page.events.some((e) => e.running && !e.helper)
              ? 'To be continued…'
              : 'Mission complete!';
      const chips = rt.splash.querySelector('.story-chips');
      const items = [];
      if (page.durationMs !== undefined) items.push({ text: this._storyDuration(page.durationMs) });
      if (page.filesChanged)
        items.push({
          text: `${page.filesChanged} file${page.filesChanged === 1 ? '' : 's'} changed`,
          open: 'diff:page',
        });
      items.push({ text: `${page.toolCalls} tool call${page.toolCalls === 1 ? '' : 's'}`, open: 'list:page' });
      if (page.helpers)
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
    const w = rt.el.clientWidth;
    const h = rt.el.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === rt.w && h === rt.h && dpr === rt.dpr) return;
    rt.w = w;
    rt.h = h;
    rt.dpr = dpr;
    rt.canvas.width = Math.max(1, Math.round(w * dpr));
    rt.canvas.height = Math.max(1, Math.round(h * dpr));
    rt.bgKey = '';
    this._storyQueueDraw(rt);
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
    const s = rt.h / StoryArt.VH;
    const W = rt.w / s;
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
        if (storyBgCache.size > STORY_BG_CACHE) storyBgCache.delete(storyBgCache.keys().next().value);
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
        const top = (StoryArt.VH / job.total) * job.next;
        const bottom = top + StoryArt.VH / job.total;
        b.save();
        b.setTransform(k, 0, 0, k, 0, 0);
        b.beginPath();
        b.rect(0, top, W, bottom - top);
        b.clip();
        StoryArt.inBand(top, bottom, () => scene.bg(b, W, StoryArt.VH));
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
    ctx.setTransform(k, 0, 0, k, ox * k, 0);
    const hits = [];
    const hit = (id, x, y, w, h, label) => hits.push({ id, x: x + ox, y, w, h, label });
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
    this._storyPlaceBalloon(rt, StoryArt.takeSpeaker(), ox, s);
  },

  /**
   * Claude's balloon goes in the band above its head, the tail pointing down at it, so it never
   * covers the art the scene draws below (a test board, a burst, the code page). It keeps clear of
   * the caption box: narrower beside it, or below it when there is no room. Recomputed only when
   * the panel's size, the text or the head's column changes.
   */
  _storyPlaceBalloon(rt, head, ox, s) {
    const b = rt.balloon;
    if (!b || b.hidden || rt.splash) return;
    const placed = !!head && rt.kind !== 'ask' && b.classList.contains('story-balloon--claude');
    const hx = placed ? (head.x + ox) * s : 0;
    const cap = rt.capStory.parentElement;
    const capW = cap?.offsetWidth || 0;
    const live = !rt.liveTag.hidden;
    const key = `${rt.w}x${rt.h}|${placed ? Math.round(hx / 6) : '-'}|${capW}|${live}|${b.className}|${b.textContent}`;
    if (key === rt.balloonKey) return;
    rt.balloonKey = key;
    if (placed) {
      const capRight = cap ? cap.offsetLeft + capW : 0;
      const capBottom = cap ? cap.offsetTop + cap.offsetHeight : 0;
      const right = Math.max(10, Math.min(rt.w - 160, rt.w - hx - 38));
      let maxW = Math.min(rt.w * 0.5, rt.w - right - 14);
      let top = 10;
      const besideCap = rt.w - right - capRight - 10;
      if (besideCap >= 150) maxW = Math.min(maxW, besideCap);
      else top = capBottom + 8;
      // The LIVE tag sits in the top-right corner: start below it when the balloon reaches that far.
      if (live && right < rt.w - rt.liveTag.offsetLeft)
        top = Math.max(top, rt.liveTag.offsetTop + rt.liveTag.offsetHeight + 6);
      b.style.left = 'auto';
      b.style.right = `${Math.round(right)}px`;
      b.style.top = `${Math.round(top)}px`;
      b.style.maxWidth = `${Math.round(Math.max(140, maxW))}px`;
    } else {
      for (const prop of ['left', 'right', 'top', 'max-width']) b.style.removeProperty(prop);
    }
    // Clamp a long text: inside the panel always, and off Claude's head when three lines allow.
    const text = b.firstElementChild;
    if (!text) return;
    text.style.removeProperty('--story-lines');
    const lh = parseFloat(getComputedStyle(text).lineHeight) || 19;
    const pad = b.offsetHeight - text.offsetHeight;
    const limit = placed ? Math.max(b.offsetTop + pad + 3 * lh, head.top * s - 22) : rt.h - 12;
    if (b.offsetHeight && b.offsetTop + b.offsetHeight > limit)
      text.style.setProperty('--story-lines', String(Math.max(2, Math.floor((limit - b.offsetTop - pad) / lh))));
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

  _storyRenderWire() {
    const st = this._story;
    const page = st.data?.supported ? st.data.page : null;
    const list = st.wireList;
    if (!page) {
      list.replaceChildren();
      st.wireCount.textContent = '';
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
    const rows = [];
    let lastPanel = -2;
    page.events.forEach((ev, i) => {
      const pi = panelOf.get(i);
      if (pi !== lastPanel && pi >= 0) {
        const g = document.createElement('li');
        g.className = 'story-wire-group';
        const h = document.createElement('h3');
        h.textContent = `Panel ${pi + 1} · ${STORY_KIND_NAMES[page.panels[pi].kind] || page.panels[pi].kind}`;
        g.append(h);
        rows.push(g);
        lastPanel = pi;
      }
      rows.push(this._storyEventRow(ev, i));
    });
    list.replaceChildren(...rows);
    st.wireCount.textContent = `${page.toolCalls} tool call${page.toolCalls === 1 ? '' : 's'}, ${page.events.length} events. Underlined parts open.`;
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
        (m && opens.find((n) => new RegExp(`^${m[1]}@[^:]*:${m[2]}$`).test(n.dataset.storyOpen)));
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
    const res = await this._api(
      `/api/sessions/${encodeURIComponent(st.sessionId)}/story/helpers/${encodeURIComponent(agentId)}`
    );
    if (!box.isConnected || !st.open) return;
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
      if (!cached) box.firstChild.textContent = 'Its steps could not be read.';
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
      if (!target.includes('/')) {
        const block =
          value
            .slice(0, link.index)
            .split(/\n\s*\n/)
            .pop() || '';
        const header = /(?:^|\n)([^\s:][^\n:]*):[ \t]*\n(?![\s\S]*\n[^\s:][^\n:]*:[ \t]*\n)/.exec(block);
        if (header) target = `${header[1].replace(/\/+$/, '')}/${target}`;
      }
      const resolved = typeof resolveLinkedFilePath === 'function' ? resolveLinkedFilePath(target, workingDir) : target;
      b.addEventListener('click', (e) => this._storyOpenFile(resolved, e.currentTarget));
      pre.append(b);
      last = link.index + link.path.length;
    }
    pre.append(document.createTextNode(this._storyShortPath(value.slice(last))));
    return pre;
  },
});
