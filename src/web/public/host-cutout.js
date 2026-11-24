/**
 * @fileoverview Keeps the header clear of a camera housing (the notch of a MacBook display).
 *
 * In a browser tab nothing is ever drawn behind the housing: macOS keeps windows, and its own full screen,
 * below it. Codeman Desktop can take the whole display (its View menu: "Full Screen Uses the Area Beside the
 * Camera"), and the page's top edge is then the display's, with the housing covering a piece of the header
 * row. A page has to keep its controls out from under it, so the app only puts a page there after the page
 * said it can: this module calls `CodemanHost.cutoutReady(true)`, and the app answers with
 * `CodemanHostCutout.apply({ left, width, height })`, the housing in CSS pixels from the viewport's top-left
 * corner, or `apply(null)` when there is none any more (full screen left, the window moved to another display).
 *
 * The layout itself is CSS (styles.css, `html.host-cutout`): the toolbar's box starts just left of the housing
 * and its content just right of it, so the tabs end before the housing and the toolbar begins after it. This
 * module only sets the three custom properties and the class, then has the tab strip measure the toolbar again.
 *
 * Not every layout gains from that. With the tabs grouped by state, by case or as a ledger in the header strip,
 * every row of tabs sits beside the toolbar, so ending them all at the housing costs more height than the strip
 * beside the housing gives (measured: 69 px more header for a 32 px strip). For those the page says
 * `cutoutReady(false)` and stays below the housing; it says so again whenever the layout changes.
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

  /** Whether the header gains from being drawn beside the housing in the layout the page is in. */
  function fits() {
    const data = document.documentElement.dataset;
    // A solo window (/session/:id, under any base path) has no tab strip. Its URL says so before the server's
    // own marker is parsed, which sits at the end of <head>.
    const solo =
      /\/session\/[^/]+\/?$/.test(location.pathname) ||
      (typeof window.__CODEMAN_SOLO__ === 'string' && window.__CODEMAN_SOLO__ !== '');
    const tabsInHeader = !solo && data.sessionList !== 'sidebar' && data.tabOrientation !== 'vertical';
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

  /** The tab strip measures the toolbar (wrap, the L-shaped corner), and the lineage lines follow the tabs. */
  function relayout() {
    window.app?.updateTabOverflowMode?.();
    window.app?.updateConnectionLines?.();
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
    relayout();
    return true;
  }

  window.CodemanHostCutout = {
    apply,
    normalize,
    fits,
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
})();
