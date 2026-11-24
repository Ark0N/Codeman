/**
 * @fileoverview Keeps the header clear of a camera housing (the notch of a MacBook display).
 *
 * In a browser tab nothing is ever drawn behind the housing: macOS keeps windows, and its own full screen,
 * below it. Codeman Desktop can take the whole display (its View menu, and the switch in App Settings: "Full
 * Screen Uses the Area Beside the Camera"), and the page's top edge is then the display's, with the housing
 * covering a piece of the header row. A page has to keep its controls out from under it, so the app only puts
 * a page there after the page said it can: this module calls `CodemanHost.cutoutReady(true)`, and the app
 * answers with `CodemanHostCutout.apply({ left, width, height })`, the housing in CSS pixels from the
 * viewport's top-left corner, or `apply(null)` when there is none any more (full screen left, the window
 * moved to another display).
 *
 * Two things in the header's first row can reach the housing, and each is kept clear in its own way:
 *
 * - The tabs go AROUND it (`fitTabs`): the tab that would sit under the housing starts just right of it, by
 *   way of a margin on the tab before it, so the row carries on to the toolbar. Nothing is added to the strip
 *   and no tab changes place in it, so every reader of the strip (order, drag, keys) sees what it always saw.
 * - The toolbar normally ends well right of the housing and stays as it is. One that would reach it (many
 *   readings, a width the user dragged, a solo window whose title shares the row) takes the box of styles.css
 *   instead (`html.host-cutout-toolbar`): from just left of the housing to the header's right edge, its
 *   content padded past the housing, so whatever is left of it ends before the housing (`fitToolbar`).
 *
 * Not every layout gains from that. With the tabs grouped by state, by case or as a ledger in the header
 * strip, the rows are laid out by rules of their own that a margin cannot open a gap in. For those the page
 * says `cutoutReady(false)` and stays below the housing; it says so again whenever the layout changes.
 *
 * The app also says what the option's switch shows, `CodemanHostCutout.option({ available, enabled })`, on
 * every page load and whenever it changes; App Settings reads it through `wholeScreen()` and turns it on or
 * off with `setWholeScreen(on)`. The setting is the app's own (its `desktop.json`), never the server's.
 *
 * A page without this module (an older Codeman server) never calls `cutoutReady`, and the app keeps it below
 * the housing with a black strip above it, the way macOS's full screen looks.
 *
 * @loadorder in <head>, before first paint and before every other module, so the app hears early and the page
 *   is never painted in both places. Self-contained: `window.app` is used only if it already exists.
 */
(function () {
  'use strict';

  /** No housing is larger than this; a larger value is a mistake and must not empty the header. */
  const MAX_HEIGHT = 200;
  /** Room kept free on each side of the housing, in px. styles.css uses the same value (--host-cutout-gap). */
  const GAP = 8;
  /** A row of tabs is cleared in one pass; more than a few rows beside a housing is not a real header. */
  const MAX_PASSES = 8;

  /** `cutout` as three finite numbers, or null when it is not a usable rectangle. */
  function normalize(cutout) {
    if (!cutout || typeof cutout !== 'object') return null;
    const left = Number(cutout.left);
    const width = Number(cutout.width);
    const height = Number(cutout.height);
    if (![left, width, height].every(Number.isFinite)) return null;
    if (left < 0 || width <= 0 || height <= 0 || height > MAX_HEIGHT) return null;
    return { left, width, height };
  }

  /** The tab arrangements that lay out every row of the header strip themselves (app.js, Tab layouts). */
  const GROUPED = ['state', 'case', 'ledger'];

  /**
   * A solo window (/session/:id, under any base path) has no tab strip. Its URL says so before the server's
   * own marker is parsed, which sits at the end of <head>.
   */
  function isSolo() {
    return (
      /\/session\/[^/]+\/?$/.test(location.pathname) ||
      (typeof window.__CODEMAN_SOLO__ === 'string' && window.__CODEMAN_SOLO__ !== '')
    );
  }

  /** Whether the header can be drawn beside the housing in the layout the page is in. */
  function fits() {
    const data = document.documentElement.dataset;
    const tabsInHeader = !isSolo() && data.sessionList !== 'sidebar' && data.tabOrientation !== 'vertical';
    return !(tabsInHeader && GROUPED.includes(data.tabArrangement));
  }

  let current = null;
  /** What the app was told last, so it only hears of a change. */
  let announced = null;

  /** Only a native wrapper has `cutoutReady`; a browser tab stays as it is. */
  function announce() {
    const ready = fits();
    if (ready === announced) return;
    announced = ready;
    // The app answers a yes with the housing; a no takes effect here at once.
    if (!ready) apply(null);
    try {
      if (typeof window.CodemanHost?.cutoutReady === 'function') window.CodemanHost.cutoutReady(ready);
    } catch {
      /* the wrapper went away: nothing to tell */
    }
  }

  // ---------------------------------------------------------------- the tabs

  /** The tabs whose margin `fitTabs` widened. Nothing else sets a margin on a tab's own style. */
  const moved = new Set();
  /** What the last pass did, so a caller can tell whether a tab moved. */
  let movedKey = '';

  function clearGaps() {
    for (const tab of moved) {
      tab.style.removeProperty('margin-left');
      tab.style.removeProperty('margin-right');
    }
    moved.clear();
  }

  /**
   * Moves every tab out from under the housing. A tab that would overlap it (with `GAP` px of air on each
   * side) starts right of it instead. The room is given to the tab BEFORE it in the row, as its right margin:
   * a tab that no longer fits in the row after that wraps to the next one flush left, where a margin of its
   * own would indent it. Only the first tab of a row has no such neighbour and takes the room itself.
   *
   * Purely geometric (it reads rectangles, never the strip's mode), so it holds in the single row, the
   * wrapped strip and the L-shaped one, and does nothing where the tabs are nowhere near the housing (the
   * sidebar, the rail). Returns true when a tab moved since the last pass.
   */
  function fitTabs(strip) {
    const host = strip || document.getElementById('sessionTabs');
    clearGaps();
    let key = '';
    if (current && host) {
      const left = current.left - GAP;
      const right = current.left + current.width + GAP;
      const tabs = host.querySelectorAll('.session-tab');
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        // The rows that sit beside the housing, and the first tab in them that overlaps it.
        const beside = [];
        let hit = null;
        for (let i = 0; i < tabs.length; i++) {
          const rect = tabs[i].getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (rect.top >= current.height || rect.bottom <= 0) continue;
          const entry = { tab: tabs[i], rect, index: i };
          beside.push(entry);
          if (rect.right <= left || rect.left >= right) continue;
          if (!hit || rect.top < hit.rect.top - 1 || (rect.top <= hit.rect.top + 1 && rect.left < hit.rect.left)) {
            hit = entry;
          }
        }
        if (!hit) break;
        let before = null;
        for (const entry of beside) {
          if (entry === hit || entry.rect.right > hit.rect.left + 1) continue;
          if (entry.rect.bottom <= hit.rect.top + 2 || entry.rect.top >= hit.rect.bottom - 2) continue;
          if (!before || entry.rect.right > before.rect.right) before = entry;
        }
        const target = before || hit;
        const side = before ? 'margin-right' : 'margin-left';
        const base = parseFloat(getComputedStyle(target.tab).getPropertyValue(side)) || 0;
        const margin = Math.ceil(base + right - hit.rect.left);
        target.tab.style.setProperty(side, margin + 'px');
        moved.add(target.tab);
        key += target.index + side + margin + ';';
      }
    }
    const changed = key !== movedKey;
    movedKey = key;
    return changed;
  }

  // ---------------------------------------------------------------- the toolbar

  /** What the toolbar's box was decided on, so a pass with nothing new costs one string. */
  let toolbarKey = null;

  /**
   * Decides whether the toolbar needs the box that covers the housing (`html.host-cutout-toolbar`,
   * styles.css). It is measured as it lies without that box, so the answer never depends on the answer before.
   * Returns true when it changed.
   */
  function fitToolbar() {
    const root = document.documentElement;
    const had = root.classList.contains('host-cutout-toolbar');
    if (!current) {
      toolbarKey = null;
      root.classList.remove('host-cutout-toolbar');
      return had;
    }
    const toolbar = document.getElementById('headerRight');
    if (!toolbar) {
      // The header is not parsed yet: cover the housing until it can be measured.
      root.classList.add('host-cutout-toolbar');
      return !had;
    }
    let key = `${window.innerWidth}|${current.left}|${current.width}|${root.dataset.headerRightWidth ?? ''}|${isSolo()}`;
    for (const child of toolbar.children) key += '|' + child.offsetWidth;
    if (key === toolbarKey) return false;
    toolbarKey = key;
    root.classList.remove('host-cutout-toolbar');
    const box = toolbar.getBoundingClientRect();
    // A solo window's title shares the row and has nothing else to stop it at the housing.
    const needs = isSolo() || (box.width > 0 && box.left < current.left + current.width + GAP);
    root.classList.toggle('host-cutout-toolbar', needs);
    return needs !== had;
  }

  /** The tab strip measures the toolbar (wrap, the L-shaped corner), and the lineage lines follow the tabs. */
  function relayout() {
    if (typeof window.app?.updateTabOverflowMode === 'function') window.app.updateTabOverflowMode();
    else fitTabs();
    window.app?.updateConnectionLines?.();
  }

  // ---------------------------------------------------------------- keeping it current

  let sizes = null;
  let children = null;
  let frame = 0;

  /** A size changed with no render behind it (a tab selected, renamed or hovered, a reading arriving). */
  function schedule() {
    if (frame || !current) return;
    // Not in the observer's own callback: a tab that wraps makes the strip taller, and a size changed there
    // is reported as a ResizeObserver loop.
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!current) return;
      if (fitToolbar()) relayout();
      else if (fitTabs()) window.app?.updateConnectionLines?.();
    });
  }

  function watch() {
    sizes?.disconnect();
    children?.disconnect();
    if (!current || typeof ResizeObserver !== 'function') return;
    const strip = document.getElementById('sessionTabs');
    const toolbar = document.getElementById('headerRight');
    if (!strip) return;
    sizes ??= new ResizeObserver(schedule);
    // Tabs come and go, and so do the toolbar's readings: watch the new ones too.
    children ??= new MutationObserver(() => {
      watch();
      schedule();
    });
    // The border box: a tab that only gains padding moves its neighbours just the same.
    const box = { box: 'border-box' };
    sizes.observe(strip, box);
    for (const tab of strip.querySelectorAll('.session-tab')) sizes.observe(tab, box);
    children.observe(strip, { childList: true });
    if (toolbar) {
      sizes.observe(toolbar, box);
      for (const child of toolbar.children) sizes.observe(child, box);
      children.observe(toolbar, { childList: true });
    }
    if (!strip.dataset.hostCutoutScroll) {
      // A strip past its max-height scrolls its rows up beside the housing.
      strip.dataset.hostCutoutScroll = '1';
      strip.addEventListener('scroll', schedule, { passive: true });
    }
  }

  /**
   * Lay the header out around `cutout`, or (null, or anything that is not a rectangle) as if there were none.
   * Returns true, so a caller can tell that the page took it.
   */
  function apply(cutout) {
    // An answer that crossed a layout change: the page already said no.
    const next = fits() ? normalize(cutout) : null;
    const same =
      (!next && !current) ||
      (!!next &&
        !!current &&
        next.left === current.left &&
        next.width === current.width &&
        next.height === current.height);
    if (same) return true;
    current = next;
    const root = document.documentElement;
    if (next) {
      root.style.setProperty('--host-cutout-left', next.left + 'px');
      root.style.setProperty('--host-cutout-width', next.width + 'px');
      root.style.setProperty('--host-cutout-height', next.height + 'px');
      root.classList.add('host-cutout');
    } else {
      root.classList.remove('host-cutout');
      root.style.removeProperty('--host-cutout-left');
      root.style.removeProperty('--host-cutout-width');
      root.style.removeProperty('--host-cutout-height');
    }
    toolbarKey = null;
    fitToolbar();
    watch();
    relayout();
    return true;
  }

  // ---------------------------------------------------------------- the option's switch

  /** What the app said its option is: `{ available, enabled }`, or null outside the app. */
  let option = null;

  /** Called by the app on every page load and whenever the option changes, from its menu or from a page. */
  function setOption(state) {
    option =
      state && typeof state === 'object'
        ? { available: state.available === true, enabled: state.enabled === true }
        : null;
    window.app?.syncHostWholeScreenSetting?.();
    return true;
  }

  /** Turns the option on or off in the app. False when there is no app to tell. */
  function setWholeScreen(on) {
    try {
      if (typeof window.CodemanHost?.setWholeScreen !== 'function') return false;
      return window.CodemanHost.setWholeScreen(on === true) !== false;
    } catch {
      return false;
    }
  }

  window.CodemanHostCutout = {
    apply,
    normalize,
    fits,
    fitTabs,
    option: setOption,
    /** The app's option as it stands (`{ available, enabled }`), or null where there is none. */
    wholeScreen: () => option,
    setWholeScreen,
    /** The housing the header is laid out around right now, or null. */
    current: () => current,
  };

  announce();
  // The layout is three attributes on <html>, written before first paint (index.html) and again whenever a
  // setting changes (app.js, settings-ui.js).
  if (typeof MutationObserver === 'function') {
    new MutationObserver(announce).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-tab-arrangement', 'data-session-list', 'data-tab-orientation'],
    });
  }
  // The app can answer before the header exists: measure it once it does.
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!current) return;
      toolbarKey = null;
      fitToolbar();
      watch();
      relayout();
    });
  }
})();
