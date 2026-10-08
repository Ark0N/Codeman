import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type ScrollInput = {
  scrollLeft?: number;
  clientWidth?: number;
  scrollWidth?: number;
  tabLeft?: number;
  tabWidth?: number;
  padding?: number;
};

function loadTabOverflowHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanTabOverflow: {
        shouldAutoWrapTabs: (input: unknown) => boolean;
        computeTabScrollLeft: (input: ScrollInput) => number;
        TAB_SCROLL_REVEAL_PX: number;
      };
    }
  ).CodemanTabOverflow;
}

describe('tab overflow layout policy', () => {
  it('auto-wraps desktop tabs when their rendered width exceeds available tab space', () => {
    const helper = loadTabOverflowHelper();

    expect(
      helper.shouldAutoWrapTabs({
        deviceType: 'desktop',
        manualTwoRows: false,
        tabCount: 18,
        scrollWidth: 1400,
        clientWidth: 760,
      })
    ).toBe(true);
  });

  it('does not auto-wrap when manual tall tabs are enabled or on mobile/tablet', () => {
    const helper = loadTabOverflowHelper();

    expect(
      helper.shouldAutoWrapTabs({
        deviceType: 'desktop',
        manualTwoRows: true,
        tabCount: 18,
        scrollWidth: 1400,
        clientWidth: 760,
      })
    ).toBe(false);
    expect(
      helper.shouldAutoWrapTabs({
        deviceType: 'mobile',
        manualTwoRows: false,
        tabCount: 18,
        scrollWidth: 1400,
        clientWidth: 320,
      })
    ).toBe(false);
  });

  it('respects the boundary conditions (exact fit, +1 tolerance, and tabCount < 2)', () => {
    const helper = loadTabOverflowHelper();
    const base = { deviceType: 'desktop' as const, manualTwoRows: false, tabCount: 6 };

    // Exact fit: no overflow, no wrap.
    expect(helper.shouldAutoWrapTabs({ ...base, scrollWidth: 800, clientWidth: 800 })).toBe(false);
    // Within the +1 sub-pixel tolerance: still no wrap.
    expect(helper.shouldAutoWrapTabs({ ...base, scrollWidth: 801, clientWidth: 800 })).toBe(false);
    // 2px over: wrap.
    expect(helper.shouldAutoWrapTabs({ ...base, scrollWidth: 802, clientWidth: 800 })).toBe(true);
    // A single overflowing tab must not wrap (need at least 2 to form a second row).
    expect(helper.shouldAutoWrapTabs({ ...base, tabCount: 1, scrollWidth: 1400, clientWidth: 760 })).toBe(false);
  });

  it('wraps a strip whose case cluster already wraps inside itself, though nothing overflows', () => {
    // A case wider than the whole strip is capped at its width and wraps in its
    // box, so the strip has rows that scrollWidth never shows. Without the wrap,
    // the lineage routing room (row gap, spine channel) is never reserved.
    const helper = loadTabOverflowHelper();
    const fits = { manualTwoRows: false, tabCount: 12, scrollWidth: 800, clientWidth: 800 };

    expect(helper.shouldAutoWrapTabs({ ...fits, deviceType: 'desktop', innerWrap: true })).toBe(true);
    expect(helper.shouldAutoWrapTabs({ ...fits, deviceType: 'desktop', innerWrap: false })).toBe(false);
    // The other guards still win.
    expect(helper.shouldAutoWrapTabs({ ...fits, deviceType: 'tablet', innerWrap: true })).toBe(false);
    expect(helper.shouldAutoWrapTabs({ ...fits, deviceType: 'desktop', manualTwoRows: true, innerWrap: true })).toBe(
      false
    );
  });
});

// Issue #257: the phone tab strip scrolls horizontally, so the active tab can
// sit entirely outside the visible slice. These pin the scroll target math that
// _scrollActiveTabIntoView() feeds with measured rects.
describe('mobile tab strip scroll-into-view policy', () => {
  // A 5-tab phone strip: 335px visible of 558px of tabs.
  const strip = { clientWidth: 335, scrollWidth: 558 };
  const pad = 16;

  it('scrolls right to reveal a tab past the right edge, leaving the reveal sliver', () => {
    const helper = loadTabOverflowHelper();
    // Last tab: 458..558, strip parked at 0.
    const target = helper.computeTabScrollLeft({ ...strip, scrollLeft: 0, tabLeft: 458, tabWidth: 100 });
    // 558 + 16 - 335 = 239, clamped to the 223px maximum.
    expect(target).toBe(223);
    // The revealed tab is now inside the window.
    expect(458).toBeGreaterThanOrEqual(target);
    expect(558).toBeLessThanOrEqual(target + strip.clientWidth);
  });

  it('scrolls left to reveal a tab before the left edge', () => {
    const helper = loadTabOverflowHelper();
    // First tab: 0..150, strip scrolled to the end.
    expect(helper.computeTabScrollLeft({ ...strip, scrollLeft: 223, tabLeft: 0, tabWidth: 150 })).toBe(0);
    // A middle tab partially cut off on the left: reveal it with the sliver.
    expect(helper.computeTabScrollLeft({ ...strip, scrollLeft: 223, tabLeft: 200, tabWidth: 100 })).toBe(200 - pad);
  });

  it('leaves an already-visible tab alone (callers skip the write)', () => {
    const helper = loadTabOverflowHelper();
    expect(helper.computeTabScrollLeft({ ...strip, scrollLeft: 100, tabLeft: 152, tabWidth: 100 })).toBe(100);
  });

  it('never scrolls a strip that fits, and never leaves the scrollable range', () => {
    const helper = loadTabOverflowHelper();
    // Everything fits: nothing to scroll, whatever the tab geometry says.
    expect(
      helper.computeTabScrollLeft({ clientWidth: 900, scrollWidth: 400, scrollLeft: 0, tabLeft: 300, tabWidth: 100 })
    ).toBe(0);
    // Clamped at both ends.
    const low = helper.computeTabScrollLeft({ ...strip, scrollLeft: 40, tabLeft: 4, tabWidth: 100 });
    expect(low).toBe(0);
    const high = helper.computeTabScrollLeft({ ...strip, scrollLeft: 0, tabLeft: 500, tabWidth: 58 });
    expect(high).toBeLessThanOrEqual(strip.scrollWidth - strip.clientWidth);
  });

  it('aligns the start of a tab too wide to fit the window', () => {
    const helper = loadTabOverflowHelper();
    // 330px tab in a 335px window: no position shows it plus padding.
    expect(
      helper.computeTabScrollLeft({ clientWidth: 335, scrollWidth: 900, scrollLeft: 0, tabLeft: 400, tabWidth: 330 })
    ).toBe(400);
  });

  it('tolerates missing measurements instead of producing NaN', () => {
    const helper = loadTabOverflowHelper();
    expect(helper.computeTabScrollLeft({})).toBe(0);
    expect(helper.computeTabScrollLeft(undefined as unknown as ScrollInput)).toBe(0);
    expect(helper.TAB_SCROLL_REVEAL_PX).toBe(pad);
  });
});
