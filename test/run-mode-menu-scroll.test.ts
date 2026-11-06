/**
 * The Run dropdown grows UPWARD from the toolbar (`bottom: 100%`). With every CLI, the custom
 * endpoint entries ("Claude Code (llama.cpp)" ...), Terminal and the saved URLs it can be taller
 * than the space above the toolbar, which put its top off-screen with nothing to scroll: on a
 * phone the entries up there were unreachable. This pins the rule that makes it scroll, in the CI
 * gate; the real touch scroll is test/run-mode-menu-scroll.browser.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Comments stripped: the rule's own comment names `overflow-y: auto` and `touch-action: pan-y`,
// which would otherwise satisfy the assertions below after the declarations were deleted.
const css = readFileSync(new URL('../src/web/public/styles.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

/** The declaration block of the FIRST rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const start = css.search(new RegExp(`(^|\\n)${selector.replace(/[.>*]/g, '\\$&')}\\s*\\{`));
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('Run dropdown scrolls when it is taller than the room above the toolbar', () => {
  const menu = rule('.run-mode-menu');

  it('scrolls vertically and keeps the scroll inside the menu', () => {
    expect(menu).toMatch(/overflow-y:\s*auto/);
    expect(menu).toMatch(/overscroll-behavior:\s*contain/);
    expect(menu).toMatch(/touch-action:\s*pan-y/);
  });

  it('is capped to the space between the header and the toolbar, following --app-height and the safe areas', () => {
    const caps = [...menu.matchAll(/max-height:\s*([^;]+);/g)].map((m) => m[1]);
    expect(caps).toHaveLength(2);
    expect(caps[0]).toContain('100vh');
    expect(caps[1]).toContain('100dvh');
    // dvh does not shrink for the on-screen keyboard; --app-height (the visual viewport) does.
    expect(caps[1]).toContain('var(--app-height');
    for (const cap of caps) {
      expect(cap).toContain('var(--header-height)');
      expect(cap).toContain('var(--toolbar-height)');
      // The phone header and toolbar grow by the safe areas in the iPhone home-screen app.
      expect(cap).toContain('var(--safe-area-top)');
      expect(cap).toContain('var(--safe-area-bottom)');
    }
  });

  it('never scrolls sideways (a long custom-endpoint label must not add a horizontal scrollbar)', () => {
    expect(menu).toMatch(/overflow-x:\s*hidden/);
  });

  it('raises the toolbar while the menu is open, so its last rows clear the keyboard bar and the CJK input', () => {
    // The menu is trapped in the toolbar's stacking context (backdrop-filter), so only the
    // toolbar's own z-index can lift it over the accessory bar (z 51) and #cjkInput (z 52).
    expect(css).toMatch(/\.toolbar:has\(\.run-mode-menu\.active\)[\s\S]*?\{\s*z-index:\s*100;/);
  });

  it('does not let scrolling children (history, saved URLs) be squashed to nothing', () => {
    expect(rule('.run-mode-menu > *')).toMatch(/flex-shrink:\s*0/);
  });
});
