#!/usr/bin/env node
/**
 * Take mobile screenshots of Codeman using Playwright
 * Emulates iPhone 15 Pro (closest to iPhone 17 Pro)
 * Includes keyboard simulation
 */

import { chromium, devices } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'http://localhost:3000';
const OUTPUT_DIR = join(__dirname, '..', 'docs', 'screenshots');

// Ensure output directory exists
try { mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}

// iPhone 15 Pro specs (closest to requested iPhone 17 Pro)
// Screen: 393 x 852 at 3x = 1179 x 2556 physical pixels
const VIEWPORT_WIDTH = 393;
const VIEWPORT_HEIGHT = 852;
const KEYBOARD_HEIGHT = 336; // Typical iOS keyboard height

const iPhone15Pro = {
  ...devices['iPhone 14 Pro'],
  viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  deviceScaleFactor: 3,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

async function takeScreenshots() {
  console.log('Launching browser with iPhone 15 Pro emulation...');
  console.log('Output directory:', OUTPUT_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...iPhone15Pro,
    hasTouch: true,
    isMobile: true,
  });

  const page = await context.newPage();

  try {
    // Screenshot 1: Main view (no keyboard)
    console.log('Loading main page...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: join(OUTPUT_DIR, 'mobile-no-keyboard.png'),
      fullPage: false
    });
    console.log('✓ Saved: mobile-no-keyboard.png');

    // Screenshot 2: Simulate keyboard appearing
    console.log('Simulating virtual keyboard...');

    // Trigger the keyboard handler manually - simulate what happens when keyboard shows
    await page.evaluate((keyboardHeight) => {
      // Add keyboard-visible class
      document.body.classList.add('keyboard-visible');

      // Move toolbar up by keyboard height
      const toolbar = document.querySelector('.toolbar');
      if (toolbar) {
        toolbar.style.transform = `translateY(${-keyboardHeight}px)`;
      }

      // Show and move accessory bar
      const accessoryBar = document.querySelector('.keyboard-accessory-bar');
      if (accessoryBar) {
        accessoryBar.classList.add('visible');
        accessoryBar.style.transform = `translateY(${-keyboardHeight}px)`;
      }

      // Shrink main content area so terminal doesn't extend behind keyboard
      // Account for toolbar (40px) + accessory bar (44px)
      const main = document.querySelector('.main');
      if (main) {
        main.style.paddingBottom = `${keyboardHeight + 94}px`;
      }
    }, KEYBOARD_HEIGHT);

    await page.waitForTimeout(300);

    // Take screenshot of the reduced viewport (simulating keyboard up)
    await page.screenshot({
      path: join(OUTPUT_DIR, 'mobile-keyboard-visible.png'),
      fullPage: false
    });
    console.log('✓ Saved: mobile-keyboard-visible.png');

    // Screenshot 3: Full view with keyboard overlay visualization
    // Reset viewport but keep toolbar position to show the effect
    await page.setViewportSize({
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT
    });

    // Add a visual keyboard overlay
    await page.evaluate((keyboardHeight) => {
      const overlay = document.createElement('div');
      overlay.id = 'keyboard-overlay';
      overlay.style.cssText = `
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        height: ${keyboardHeight}px;
        background: linear-gradient(to bottom, #2a2a2a 0%, #1a1a1a 100%);
        border-top: 1px solid #444;
        z-index: 9999;
        display: flex;
        flex-wrap: wrap;
        align-content: flex-start;
        padding: 8px 4px;
        gap: 4px;
      `;

      // Add fake keyboard keys
      const rows = [
        'Q W E R T Y U I O P',
        'A S D F G H J K L',
        '⇧ Z X C V B N M ⌫',
        '123 🌐 space return'
      ];

      rows.forEach((row, rowIndex) => {
        const rowDiv = document.createElement('div');
        rowDiv.style.cssText = 'display: flex; width: 100%; justify-content: center; gap: 4px;';

        row.split(' ').forEach(key => {
          const keyEl = document.createElement('div');
          const isSpecial = ['⇧', '⌫', '123', '🌐', 'space', 'return'].includes(key);
          const isSpace = key === 'space';
          const isReturn = key === 'return';

          keyEl.style.cssText = `
            background: ${isSpecial ? '#3a3a3a' : '#505050'};
            color: #fff;
            border-radius: 5px;
            padding: ${isSpace ? '10px 60px' : isReturn ? '10px 20px' : '10px 8px'};
            font-size: ${rowIndex === 3 ? '12px' : '14px'};
            min-width: ${isSpace ? '120px' : isReturn ? '60px' : '28px'};
            text-align: center;
            box-shadow: 0 1px 0 #222;
          `;
          keyEl.textContent = isSpace ? '' : key;
          rowDiv.appendChild(keyEl);
        });

        overlay.appendChild(rowDiv);
      });

      document.body.appendChild(overlay);
    }, KEYBOARD_HEIGHT);

    await page.waitForTimeout(200);

    await page.screenshot({
      path: join(OUTPUT_DIR, 'mobile-with-keyboard.png'),
      fullPage: false
    });
    console.log('✓ Saved: mobile-with-keyboard.png');

    // Screenshot 4: Toolbar close-up with keyboard
    const toolbar = page.locator('.toolbar');
    if (await toolbar.count() > 0) {
      await toolbar.screenshot({
        path: join(OUTPUT_DIR, 'mobile-toolbar-above-keyboard.png')
      });
      console.log('✓ Saved: mobile-toolbar-above-keyboard.png');
    }

    console.log('\n✅ All screenshots saved to:', OUTPUT_DIR);

  } catch (error) {
    console.error('Error taking screenshots:', error.message);
  } finally {
    await browser.close();
  }
}

takeScreenshots();
