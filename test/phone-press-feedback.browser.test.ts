/**
 * @fileoverview Real-browser coverage for the press feedback on the phone toolbar
 * and keyboard accessory keys (mobile.css, the `:active` transform + filter rules).
 *
 * The feedback is transform + filter because a background `:active` on the
 * toolbar buttons lost to the skin block on every skin but og. What this pins is
 * the cascade itself, on every skin: a later rule that sets transform or filter
 * on these buttons at a higher specificity would silently take the press away
 * again, and only a browser computing the cascade can see that.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const mobileStyles = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');
const accessorySource = readFileSync(resolve(publicDir, 'keyboard-accessory.js'), 'utf8');

const DARK_SKINS = ['og', 'daylight-blue', 'daylight-green'] as const;
const LIGHT_SKINS = ['paper-gray', 'solarized-light', 'catppuccin-latte', 'rose-pine-dawn'] as const;

/** Every phone bar control the rules cover, pressed where a finger would land. */
const TARGETS = [
  ['Run', '.toolbar .btn-toolbar.btn-run'],
  ['Run gear', '.toolbar .btn-toolbar.btn-run-gear'],
  ['Stop', '.toolbar .btn-toolbar.btn-stop'],
  ['Enter', '.toolbar .btn-toolbar.btn-enter'],
  ['Case', '.toolbar .btn-toolbar.btn-case-mobile'],
  ['Voice', '.btn-voice-mobile'],
  // The pick is a transparent file input laid over this button, so the press
  // lands on the input and only the wrap is :active.
  ['Attach', '.btn-attach-mobile'],
  ['Settings', '.btn-settings-mobile'],
  ['Accessory Tab', '.accessory-btn[data-action="tab"]'],
  ['Accessory arrow', '.accessory-btn-arrow[data-action="scroll-up"]'],
  ['Accessory Compose', '.accessory-btn-compose'],
  ['Accessory dismiss', '.accessory-btn-dismiss'],
] as const;

const PRESSED_SCALE = 'matrix(0.94, 0, 0, 0.94, 0, 0)';

/** The press transition, read at rest: the 250ms hold below would also pass a slower one. */
const PRESS_TRANSITION = {
  property: 'transform, filter, background-color, border-color',
  duration: '0.08s, 0.08s, 0.08s, 0.08s',
};

function toolbarMarkup(): string {
  const start = html.indexOf('<footer class="toolbar">');
  const end = html.indexOf('</footer>', start);
  if (start < 0 || end < 0) throw new Error('Toolbar markup not found');
  return html.slice(start, end + '</footer>'.length);
}

function accessoryMarkup(): string {
  const match = accessorySource.match(/_simpleButtons: `([\s\S]*?)`,/);
  if (!match) throw new Error('Accessory bar template not found');
  return `<div class="keyboard-accessory-bar visible">${match[1]}</div>`;
}

describe('phone toolbar and accessory press feedback in Chromium', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => browser.close());

  async function openBars(skin: string, reducedMotion: 'reduce' | 'no-preference'): Promise<[BrowserContext, Page]> {
    // hasTouch makes Chromium match (hover: none) and (pointer: coarse), the gate the rules sit behind.
    const context = await browser.newContext({
      viewport: { width: 440, height: 956 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
      reducedMotion,
    });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html data-skin="${skin}"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style>
      <style>@media (max-width: 1023px) { ${mobileStyles} }</style></head>
      <body>${toolbarMarkup()}${accessoryMarkup()}</body></html>`);
    // Without the viewport meta a mobile context lays out at 980px and never reaches the phone layout.
    expect(
      await page.evaluate(() => ({
        touch: matchMedia('(hover: none) and (pointer: coarse)').matches,
        phone: matchMedia('(max-width: 599px)').matches,
      }))
    ).toEqual({ touch: true, phone: true });
    return [context, page];
  }

  /** Hold a press on the control and read its transform and filter once the transition has settled. */
  async function pressed(page: Page, selector: string) {
    const target = page.locator(selector).first();
    const box = await target.boundingBox();
    if (!box) throw new Error(`${selector} is not rendered in the phone layout`);
    const read = () =>
      target.evaluate((el) => ({ transform: getComputedStyle(el).transform, filter: getComputedStyle(el).filter }));
    const rest = await read();
    const transition = await target.evaluate((el) => ({
      property: getComputedStyle(el).transitionProperty,
      duration: getComputedStyle(el).transitionDuration,
    }));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(250);
    const held = await read();
    // Release off the control so its click handler never runs.
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.waitForTimeout(250);
    return { rest, held, transition };
  }

  for (const [skins, brightness] of [
    [DARK_SKINS, 'brightness(1.25)'],
    [LIGHT_SKINS, 'brightness(0.9)'],
  ] as const) {
    for (const skin of skins) {
      it(`scales every control and applies ${brightness} on the ${skin} skin`, async () => {
        const [context, page] = await openBars(skin, 'no-preference');
        try {
          for (const [name, selector] of TARGETS) {
            expect({ name, ...(await pressed(page, selector)) }).toEqual({
              name,
              rest: { transform: 'none', filter: 'none' },
              held: { transform: PRESSED_SCALE, filter: brightness },
              transition: PRESS_TRANSITION,
            });
          }
        } finally {
          await context.close();
        }
      });
    }
  }

  it.each([
    ['daylight-blue', 'brightness(1.25)'],
    ['paper-gray', 'brightness(0.9)'],
  ])('drops the scale but keeps the tint under prefers-reduced-motion on %s', async (skin, brightness) => {
    const [context, page] = await openBars(skin, 'reduce');
    try {
      for (const [name, selector] of TARGETS) {
        expect({ name, ...(await pressed(page, selector)) }).toEqual({
          name,
          rest: { transform: 'none', filter: 'none' },
          held: { transform: 'none', filter: brightness },
          transition: PRESS_TRANSITION,
        });
      }
    } finally {
      await context.close();
    }
  });
});
