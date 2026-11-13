// Port: none (pure static analysis — runs in CI, no browser/server).
//
// Regression guard for "a header button leaks onto the cramped mobile header".
// This exact class of bug shipped twice (the plan-usage chip, then the COD-39
// attachments-history button): a new control was added to the header, looked
// fine on desktop, and nobody noticed it cluttering the phone header. The mobile
// Playwright suite that *would* catch it (test/mobile/**) is EXCLUDED from CI, so
// it never gated. This test is intentionally a pure parser of index.html +
// mobile.css so it runs in the normal CI sweep with zero browser dependencies.
//
// Policy: every header button that is VISIBLE BY DEFAULT on desktop must have an
// explicit decision for phones — either it's hidden via an @media (max-width:
// 600px) display:none rule in mobile.css, or it's added to MOBILE_VISIBLE_ALLOWLIST
// below with a reason. A new default-visible header button with neither fails this
// test, forcing the author to decide its mobile behavior.
//
// The real-browser counterpart (actual computed visibility on an emulated phone)
// lives in test/mobile/header-buttons.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';
import postcss from 'postcss';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, '../src/web/public');

// Canonical phone width used to decide whether a media query applies on a phone.
// Matches the device the browser-based test emulates (iPhone 14 Pro = 393px CSS).
const PHONE_WIDTH = 393;

// Issue #759: the maintainer approved File Viewer on phones when explicitly enabled.
// Its per-device setting still defaults off on a handheld. With the blanket phone
// hide gone, that default and the startup hide are the whole lock, so both are
// pinned below ("File Viewer on a phone: off until it is switched on").
const MOBILE_VISIBLE_ALLOWLIST = new Set<string>(['btn-file-viewer']);

// Buttons we expect to STAY hidden on phones — an explicit lock so a future edit
// that removes a hide rule fails loudly (not silently). The attachments button is
// NOT here: it's opt-in (default-hidden everywhere via its own --hidden marker), so
// it's excluded from the default-visible enumeration rather than mobile-hidden.
// The edit history button is opt-in the same way, but it IS here: its panel is
// desktop-sized, so it stays off phones even when the setting is on.
const KNOWN_PHONE_HIDDEN = ['btn-settings', 'btn-lifecycle-log', 'btn-session-manager', 'btn-edit-history'];

function attrOf(openTag: string, name: string): string {
  const m = openTag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : '';
}

/** Does a media query's width range include a phone-width viewport? */
function appliesToPhone(params: string): boolean {
  const max = params.match(/max-width:\s*(\d+)px/);
  const min = params.match(/min-width:\s*(\d+)px/);
  if (max && PHONE_WIDTH > Number(max[1])) return false; // phone is wider than the cap
  if (min && PHONE_WIDTH < Number(min[1])) return false; // phone is narrower than the floor
  return Boolean(max || min); // must actually be a width-bounded query
}

function loadHeaderButtons(): { classes: string[]; id: string; distinguishing: string[] }[] {
  const html = readFileSync(join(PUBLIC, 'index.html'), 'utf-8');
  // The header controls live in <div class="header-right" id="headerRight"> … </header>.
  const region = html.match(/<div class="header-right"[^>]*>([\s\S]*?)<\/header>/);
  expect(region, '#headerRight region not found in index.html — update the selector in this test').toBeTruthy();
  const headerHtml = region![1];

  return [...headerHtml.matchAll(/<button\b([^>]*)>/g)]
    .map((m) => {
      const open = m[1];
      const classes = attrOf(open, 'class').split(/\s+/).filter(Boolean);
      return {
        classes,
        id: attrOf(open, 'id'),
        style: attrOf(open, 'style'),
        distinguishing: classes.filter(
          (c) => c.startsWith('btn-') && c !== 'btn-icon-header' && c !== 'btn-sm' && !c.endsWith('--hidden')
        ),
      };
    })
    .filter((b) => b.classes.includes('btn-icon-header'))
    .filter((b) => !b.classes.includes('btn-sm')) // font A-/A+ controls — separate sub-group
    .filter((b) => !/display:\s*none/i.test(b.style)) // JS-gated (solo-redock, retired bell)
    .filter((b) => !b.classes.some((c) => c.endsWith('--hidden'))); // opt-in, hidden by default
}

function loadPhoneHiddenClasses(): Set<string> {
  const css = readFileSync(join(PUBLIC, 'mobile.css'), 'utf-8');
  const hidden = new Set<string>();
  postcss.parse(css).walkAtRules('media', (atRule) => {
    if (!appliesToPhone(atRule.params)) return;
    atRule.walkRules((rule) => {
      let hides = false;
      rule.walkDecls('display', (decl) => {
        if (decl.value.replace(/!important/i, '').trim() === 'none') hides = true;
      });
      if (!hides) return;
      for (const token of rule.selector.match(/\.btn-[a-z0-9-]+/gi) || []) {
        hidden.add(token.slice(1).toLowerCase());
      }
    });
  });
  return hidden;
}

describe('Mobile header button policy (static guard)', () => {
  const buttons = loadHeaderButtons();
  const phoneHidden = loadPhoneHiddenClasses();

  it('finds the default-visible header buttons (sanity)', () => {
    // If this drops to 0 the parser/markup drifted — fix the parser, don't delete the test.
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('every default-visible header button has a mobile-visibility decision', () => {
    for (const btn of buttons) {
      expect(
        btn.distinguishing.length,
        `Header button (id=${btn.id || '?'}, class="${btn.classes.join(' ')}") has no distinguishing ` +
          `btn-* class to target on mobile. Give it one so its phone visibility can be controlled.`
      ).toBeGreaterThan(0);

      const hidden = btn.distinguishing.some((c) => phoneHidden.has(c.toLowerCase()));
      const allowed = btn.distinguishing.some((c) => MOBILE_VISIBLE_ALLOWLIST.has(c));

      expect(
        hidden || allowed,
        `Header button .${btn.distinguishing.join('.')} (id=${btn.id || '?'}) is VISIBLE BY DEFAULT but has ` +
          `no mobile-visibility decision.\n` +
          `  → To hide it on phones: add it to the @media (max-width: 599px) "display: none" block in ` +
          `src/web/public/mobile.css (next to .btn-settings / .btn-lifecycle-log).\n` +
          `  → To keep it visible on phones: add '${btn.distinguishing[0]}' to MOBILE_VISIBLE_ALLOWLIST in ` +
          `this test, with a reason.\n` +
          `This guard exists because the plan-usage chip and the attachments button both leaked onto the ` +
          `mobile header unnoticed.`
      ).toBe(true);
    }
  });

  it('locks the known phone-hidden header buttons', () => {
    for (const cls of KNOWN_PHONE_HIDDEN) {
      expect(
        phoneHidden.has(cls),
        `${cls} must stay hidden on phones — restore its rule in the @media (max-width: 599px) ` +
          `display:none block in src/web/public/mobile.css.`
      ).toBe(true);
    }
  });

  it('allows the explicitly enabled File Viewer button on phones (issue #759)', () => {
    // The setting removes the --hidden marker; a separate blanket phone hide
    // would override that choice. Default-off and live toggling are exercised
    // against the real page in test/mobile/file-browser.test.ts.
    expect(phoneHidden.has('btn-file-viewer')).toBe(false);
  });
});

// Until #759 the gate kept the File Viewer button off phones with a blanket
// display:none rule and its KNOWN_PHONE_HIDDEN entry. That rule is gone, so what
// keeps the button off a phone nobody switched it on for is now two things, and
// the real-page test that exercises them (test/mobile/file-browser.test.ts) is
// not part of `npm test`:
//   1. the handheld branch of getDefaultSettings() says false, and the header
//      reads the setting through that default (a bare `?? true` would show it);
//   2. `html.mobile-init` hides the button until the settings have been applied,
//      or it would flash on every phone page load (the template ships it visible).
describe('File Viewer on a phone: off until it is switched on (#759)', () => {
  const settingsUi = readFileSync(join(PUBLIC, 'settings-ui.js'), 'utf-8');

  /** The real getDefaultSettings() of settings-ui.js on one kind of device. */
  function defaultsOn(handheld: boolean): Record<string, unknown> {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const context = vm.createContext({
      CodemanApp,
      VoiceInput: {},
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      console,
      MobileDetection: {
        isHandheldDevice: () => handheld,
        isTouchDevice: () => handheld,
        getDeviceType: () => (handheld ? 'mobile' : 'desktop'),
      },
      window: { matchMedia: () => ({ matches: false }) },
    });
    vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });
    const app = Object.create(CodemanApp.prototype) as { getDefaultSettings(): Record<string, unknown> };
    return app.getDefaultSettings();
  }

  it('a handheld defaults the button off', () => {
    expect(defaultsOn(true).showFileViewerButton).toBe(false);
  });

  it('a desktop leaves the key unset, which every reader resolves to on', () => {
    expect(defaultsOn(false)).not.toHaveProperty('showFileViewerButton');
  });

  it('the header and the App Settings chip both read the setting through the device default', () => {
    const read = 'settings.showFileViewerButton ?? defaults.showFileViewerButton ?? true;';
    expect(settingsUi).toContain(`const showFileViewerButton = ${read}`);
    expect(settingsUi).toContain(`document.getElementById('appSettingsShowFileViewerButton').checked = ${read}`);
    // Every reader goes through it: one that skipped the device default would resolve to on.
    const reads = [...settingsUi.matchAll(/\bsettings\.showFileViewerButton\b(.{0,40})/g)];
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const [line, rest] of reads) {
      expect(rest.startsWith(' ?? defaults.showFileViewerButton'), `"${line}" skips the device default`).toBe(true);
    }
  });

  it('html.mobile-init hides the button until the settings have been applied', () => {
    const css = readFileSync(join(PUBLIC, 'mobile.css'), 'utf-8');
    let hidesAtStartup = false;
    postcss.parse(css).each((node) => {
      // Top level only: the rule must apply at every width mobile.css is loaded for.
      if (node.type !== 'rule') return;
      if (!node.selectors.includes('html.mobile-init .btn-file-viewer')) return;
      node.walkDecls('display', (decl) => {
        if (decl.value.trim() === 'none' && decl.important) hidesAtStartup = true;
      });
    });
    expect(hidesAtStartup, 'mobile.css must keep .btn-file-viewer in its html.mobile-init display:none rule').toBe(true);
  });
});

// The flip side of the policy above: the ONE header control phones do keep has
// to be pressable. The brand "C" is the way back to the home screen and was a
// 0.85rem inline span — roughly a 12x13px target, well under the 44px minimum.
describe('Phone home button tap target (static guard)', () => {
  const css = readFileSync(join(PUBLIC, 'mobile.css'), 'utf-8');

  /** Declarations applying to `.header-brand .logo` inside a phone media query. */
  function phoneLogoDecls(): Map<string, string> {
    const decls = new Map<string, string>();
    postcss.parse(css).walkAtRules('media', (atRule) => {
      if (!appliesToPhone(atRule.params)) return;
      atRule.walkRules((rule) => {
        if (!/\.header-brand\s+\.logo\s*$/.test(rule.selector)) return;
        rule.walkDecls((decl) => decls.set(decl.prop, decl.value));
      });
    });
    return decls;
  }

  it('gives the brand button a 44x44 hit area on phones', () => {
    const decls = phoneLogoDecls();
    expect(decls.get('min-width'), 'the "C" home button needs an explicit 44px min-width on phones').toBe('44px');
    // A bare inline span ignores width entirely — the box only exists once it
    // stops being inline.
    expect(decls.get('display')).toBe('inline-flex');
    // The other axis is the header's, so the two have to be read together: the
    // button is only 44 tall because the phone header is.
    expect(decls.get('height')).toBe('var(--header-height)');
  });

  it('keeps the phone header at 44px, the height that makes that target square', () => {
    // The bar was 36px. Shrinking it again silently takes 8px back off every
    // header touch target, the home button included.
    let phoneHeaderHeight: string | undefined;
    postcss.parse(css).walkAtRules('media', (atRule) => {
      if (!appliesToPhone(atRule.params)) return;
      atRule.walkRules((rule) => {
        if (rule.selector.trim() !== ':root') return;
        rule.walkDecls('--header-height', (decl) => (phoneHeaderHeight = decl.value.trim()));
      });
    });
    expect(phoneHeaderHeight, '--header-height must be redefined for phones in mobile.css').toBe('44px');
  });
});
