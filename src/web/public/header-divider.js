/**
 * @fileoverview A draggable divider on the left edge of the header's right-hand toolbar.
 *
 * Dragging it left gives the toolbar (stats, plan usage, buttons) more room; dragging it right narrows the
 * toolbar, which then wraps onto a second line instead of squeezing the session tabs out. The width is a
 * device-local convenience kept in localStorage; double-click or Home resets it. The handle is absolutely
 * positioned inside #headerRight, so it takes no layout room and is simply hidden where the tabs are not in
 * the header (sidebar, vertical rail, phones).
 *
 * @loadorder after app.js; self-contained, no CodemanApp dependency.
 */
(function () {
  const STORAGE_KEY = 'codeman-header-right-width';
  const MIN_WIDTH = 160;
  const MIN_TABS_ROOM = 240;
  const KEY_STEP = 16;

  /** Keep a requested toolbar width between the minimum and what leaves the tabs some room. */
  function clampWidth(width, headerWidth, brandWidth) {
    const max = Math.max(MIN_WIDTH, headerWidth - brandWidth - MIN_TABS_ROOM);
    return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
  }

  /**
   * How much of the usage readings to show for a toolbar this wide. The narrower the toolbar, the more of
   * the labels go: window labels first, then provider names (shortened), then, in the Compact style, the
   * percentages (the rings stay, and the chip's tooltip keeps the numbers).
   */
  function densityFor(width) {
    if (width >= 560) return '';
    if (width >= 400) return 'tight';
    if (width >= 280) return 'dense';
    return 'tiny';
  }

  function readStored() {
    try {
      const value = Number(localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  function writeStored(width) {
    try {
      if (width === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      /* storage blocked: the width lasts until the page reloads */
    }
  }

  function init() {
    const header = document.querySelector('.header');
    const right = document.getElementById('headerRight');
    if (!header || !right || right.querySelector('.header-divider')) return;
    const brand = header.querySelector('.header-brand');
    const root = document.documentElement;

    const handle = document.createElement('div');
    handle.className = 'header-divider';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Resize the toolbar (double-click to reset)');
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    handle.tabIndex = 0;
    right.insertBefore(handle, right.firstChild);

    // The width the user asked for. The applied width can be smaller (a narrow window) or larger (a reading
    // that needs more room), and the request is what comes back when the window grows again.
    let wanted = readStored();

    const bounds = () => ({ header: header.clientWidth, brand: brand ? brand.offsetWidth : 0 });
    const current = () => right.getBoundingClientRect().width;

    /** The narrowest the toolbar can be without a reading poking out past its left edge (the divider). */
    function contentMinimum() {
      const style = getComputedStyle(right);
      const frame = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth);
      let widest = 0;
      for (const child of right.children) {
        if (child === handle || child.offsetParent === null) continue;
        widest = Math.max(widest, child.getBoundingClientRect().width, child.scrollWidth);
      }
      return Math.ceil(widest + frame);
    }

    function setDensity(width) {
      const density = densityFor(width);
      if (density) root.setAttribute('data-header-density', density);
      else root.removeAttribute('data-header-density');
    }

    /** Apply `wanted`, settled on a width no reading overflows at the density that width gets. */
    function settle() {
      if (wanted === null) {
        root.style.removeProperty('--header-right-width');
        root.removeAttribute('data-header-right-width');
        root.removeAttribute('data-header-density');
        handle.removeAttribute('aria-valuenow');
        handle.removeAttribute('aria-valuemax');
        return;
      }
      const { header: h, brand: b } = bounds();
      let clamped = clampWidth(wanted, h, b);
      root.setAttribute('data-header-right-width', 'set');
      // A narrower toolbar sheds labels, which shrinks the readings, which lowers the minimum.
      for (let i = 0; i < 3; i++) {
        root.style.setProperty('--header-right-width', clamped + 'px');
        setDensity(clamped);
        const floor = contentMinimum();
        if (clamped >= floor) break;
        clamped = floor;
      }
      handle.setAttribute('aria-valuenow', String(clamped));
      handle.setAttribute('aria-valuemax', String(clampWidth(Infinity, h, b)));
    }

    /** Several changes in one frame (a chip refill, a resize) settle once. */
    let settleFrame = 0;
    function scheduleSettle() {
      if (wanted === null || settleFrame) return;
      settleFrame = requestAnimationFrame(() => {
        settleFrame = 0;
        settle();
      });
    }

    /** The tab strip and the subagent lines measure the header, so they re-measure after a user resize. */
    function relayout() {
      window.app?.updateTabOverflowMode?.();
      window.app?.updateConnectionLines?.();
    }

    function apply(width) {
      wanted = width === null ? null : Math.max(MIN_WIDTH, Math.round(width));
      writeStored(wanted);
      settle();
      relayout();
    }

    // Readings arrive after init (the plan-usage chip is filled in asynchronously, a Codex or Copilot row
    // can start reporting later, a header button can be switched on): re-settle when any child changes size.
    const resizeObserver = new ResizeObserver(scheduleSettle);
    const watch = () => {
      for (const child of right.children) if (child !== handle) resizeObserver.observe(child);
    };
    watch();
    new MutationObserver(() => {
      watch();
      scheduleSettle();
    }).observe(right, { childList: true });

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      document.body.classList.add('header-divider-dragging');
      const padRight = parseFloat(getComputedStyle(header).paddingRight) || 0;
      let moveFrame = 0;
      let lastX = event.clientX;
      const onMove = (e) => {
        lastX = e.clientX;
        if (moveFrame) return;
        moveFrame = requestAnimationFrame(() => {
          moveFrame = 0;
          wanted = Math.round(header.getBoundingClientRect().right - lastX - padRight);
          settle();
        });
      };
      const finish = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        handle.removeEventListener('lostpointercapture', finish);
        if (moveFrame) cancelAnimationFrame(moveFrame);
        moveFrame = 0;
        document.body.classList.remove('header-divider-dragging');
        if (wanted !== null) apply(wanted);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', finish);
    });

    handle.addEventListener('dblclick', () => apply(null));

    handle.addEventListener('keydown', (event) => {
      if (event.key === 'Home') {
        apply(null);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // Step from the width on screen, not the request, so a key held past the floor never leaves a dead zone.
        apply(current() + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP));
      } else {
        return;
      }
      event.preventDefault();
    });

    window.addEventListener('resize', scheduleSettle);
    settle();
  }

  window.CodemanHeaderDivider = { clampWidth, densityFor, MIN_WIDTH, MIN_TABS_ROOM };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
