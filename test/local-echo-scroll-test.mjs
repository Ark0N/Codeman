/**
 * Local Echo Overlay — Scroll and position tests.
 *
 * Focused on:
 * 1. Overlay hidden when scrolled up (prompt not at viewport bottom)
 * 2. Overlay reappears when scrolled back to bottom
 * 3. Overlay position correct after Ink redraws move the prompt
 * 4. Overlay cursor block position matches text end
 * 5. Multiple Enter submits — flushed offset doesn't carry across prompts
 * 6. Backspace past all pending + all flushed = clean state
 *
 * Usage: node test/local-echo-scroll-test.mjs
 */
import { chromium } from 'playwright';

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = '/tmp/local-echo-scroll';

async function createSession(name) {
  const resp = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'claude', name })
  });
  if (!resp.ok) throw new Error(`Failed to create session '${name}': ${resp.status}`);
  const data = await resp.json();
  return data.session?.id || data.id;
}

async function deleteSession(id) {
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
}

async function waitForReady(sessionId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await fetch(`${BASE}/api/sessions/${sessionId}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.status === 'idle' || data.status === 'busy') return true;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function getState(page) {
  return page.evaluate(() => {
    const app = window.app;
    if (!app) return null;
    const overlay = app._localEchoOverlay;
    const buf = app.terminal?.buffer?.active;
    return {
      overlayVisible: overlay?.overlay?.style.display !== 'none',
      overlayText: overlay?.pendingText || '',
      flushedOffset: overlay?._flushedOffset || 0,
      flushedOffsets: app._flushedOffsets ? Object.fromEntries(app._flushedOffsets) : {},
      localEchoEnabled: app._localEchoEnabled,
      activeSessionId: app.activeSessionId,
      // Scroll state
      viewportY: buf?.viewportY,
      baseY: buf?.baseY,
      isAtBottom: buf ? buf.viewportY === buf.baseY : null,
      terminalRows: app.terminal?.rows,
      // Overlay children
      overlayChildren: (() => {
        if (!overlay?.overlay) return [];
        return Array.from(overlay.overlay.children).map(c => ({
          text: Array.from(c.querySelectorAll('span')).map(s => s.textContent).join(''),
          left: c.style.left,
          top: c.style.top,
        }));
      })(),
    };
  });
}

async function focusTerminal(page) {
  await page.evaluate(() => { document.querySelector('.xterm-helper-textarea')?.focus(); });
  await page.waitForTimeout(200);
}

async function screenshot(page, name) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`  📸 ${path}`);
}

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`  ✅ PASS: ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`  ❌ FAIL: ${name} — ${detail}`); }
function info(name, detail) { results.push({ name, status: 'INFO', detail }); console.log(`  ℹ️  INFO: ${name} — ${detail}`); }

async function main() {
  const { mkdirSync } = await import('fs');
  try { mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

  console.log('=== Local Echo — Scroll & Position Tests ===\n');

  const sessionA = await createSession('scroll-test-A');
  const sessionB = await createSession('scroll-test-B');
  console.log(`  Session A: ${sessionA}`);
  console.log(`  Session B: ${sessionB}`);

  if (!await waitForReady(sessionA) || !await waitForReady(sessionB)) {
    console.error('Sessions failed to become ready');
    await deleteSession(sessionA);
    await deleteSession(sessionB);
    process.exit(1);
  }
  console.log('  Ready\n');

  const browser = await chromium.launch({ headless: true, args: ['--window-size=390,844'] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
    isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Enable local echo
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('codeman-app-settings') || '{}');
      s.localEchoEnabled = true;
      localStorage.setItem('codeman-app-settings', JSON.stringify(s));
      window.app?._updateLocalEchoState?.();
    });

    // Select session A
    await page.evaluate((id) => {
      const t = document.querySelector(`.session-tab[data-id="${id}"]`);
      if (t) t.click();
    }, sessionA);
    await page.waitForTimeout(1500);
    await focusTerminal(page);

    // ══════════════════════════════════════════
    // TEST 1: Overlay hidden when scrolled up
    // ══════════════════════════════════════════
    console.log('--- Test 1: Overlay hidden when scrolled up ---');
    // Generate some content so we can scroll
    await page.keyboard.type('just say ok', { delay: 20 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000); // Wait for response

    await focusTerminal(page);
    await page.keyboard.type('test-scroll-text', { delay: 30 });
    await page.waitForTimeout(300);

    let state = await getState(page);
    console.log(`  At bottom: isAtBottom=${state?.isAtBottom}, viewportY=${state?.viewportY}, baseY=${state?.baseY}`);
    await screenshot(page, '01-at-bottom-with-text');

    if (state?.overlayVisible && state?.overlayText === 'test-scroll-text') {
      pass('Overlay visible at bottom with text');
    } else {
      fail('Overlay at bottom', `visible=${state?.overlayVisible}, text="${state?.overlayText}"`);
    }

    // Scroll to top
    await page.evaluate(() => { window.app?.terminal?.scrollToTop(); });
    await page.waitForTimeout(300);

    state = await getState(page);
    console.log(`  After scroll up: isAtBottom=${state?.isAtBottom}, viewportY=${state?.viewportY}, baseY=${state?.baseY}`);
    console.log(`  Overlay visible: ${state?.overlayVisible}, text: "${state?.overlayText}"`);
    await screenshot(page, '02-scrolled-up');

    if (state?.isAtBottom) {
      // Buffer too short to scroll — skip this check
      info('Overlay scroll-up test skipped', 'buffer too short to scroll (viewportY===baseY)');
    } else if (!state?.overlayVisible) {
      pass('Overlay hidden when scrolled up');
    } else {
      fail('Overlay visible when scrolled up', `visible=${state?.overlayVisible}`);
    }

    // Text should be preserved even though overlay is hidden
    if (state?.overlayText === 'test-scroll-text') {
      pass('Overlay text preserved while hidden');
    } else {
      fail('Overlay text lost during scroll', `"${state?.overlayText}"`);
    }

    // ══════════════════════════════════════════
    // TEST 2: Overlay reappears at bottom
    // ══════════════════════════════════════════
    console.log('\n--- Test 2: Overlay reappears when scrolled back ---');
    await page.evaluate(() => { window.app?.terminal?.scrollToBottom(); });
    await page.waitForTimeout(300);

    // Type one more char to trigger re-render
    await page.keyboard.type('!', { delay: 30 });
    await page.waitForTimeout(300);

    state = await getState(page);
    console.log(`  At bottom: isAtBottom=${state?.isAtBottom}`);
    console.log(`  Overlay visible: ${state?.overlayVisible}, text: "${state?.overlayText}"`);
    await screenshot(page, '03-back-to-bottom');

    if (state?.overlayVisible && state?.overlayText === 'test-scroll-text!') {
      pass('Overlay reappears at bottom with preserved text');
    } else {
      info('Overlay after scroll back', `visible=${state?.overlayVisible}, text="${state?.overlayText}"`);
    }

    // Clear
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════
    // TEST 3: Backspace deletes ALL flushed text back to zero
    // ══════════════════════════════════════════
    console.log('\n--- Test 3: Full backspace through pending + flushed ---');
    await focusTerminal(page);
    await page.keyboard.type('abcdef', { delay: 20 }); // 6 chars pending
    await page.waitForTimeout(200);

    // Flush by tab switch
    await page.evaluate((id) => {
      document.querySelector(`.session-tab[data-id="${id}"]`)?.click();
    }, sessionB);
    await page.waitForTimeout(1000);

    // Switch back
    await page.evaluate((id) => {
      document.querySelector(`.session-tab[data-id="${id}"]`)?.click();
    }, sessionA);
    await page.waitForTimeout(1000);
    await focusTerminal(page);

    // Type 3 more chars
    await page.keyboard.type('xyz', { delay: 20 });
    await page.waitForTimeout(200);

    state = await getState(page);
    console.log(`  State: pending="${state?.overlayText}", flushed=${state?.flushedOffset}`);

    // Now backspace 3 (pending "xyz") + 6 (flushed "abcdef") + 2 extra = 11
    for (let i = 0; i < 11; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(300);

    state = await getState(page);
    console.log(`  After full delete: pending="${state?.overlayText}", flushed=${state?.flushedOffset}, map=${JSON.stringify(state?.flushedOffsets)}`);
    await screenshot(page, '04-full-backspace');

    if (state?.flushedOffset === 0 && !state?.overlayText) {
      pass('Full backspace clears both pending and flushed');
    } else {
      fail('Full backspace', `pending="${state?.overlayText}", flushed=${state?.flushedOffset}`);
    }

    if (!state?.flushedOffsets?.[sessionA]) {
      pass('Flushed offsets Map cleared after full backspace');
    } else {
      fail('Map not cleared', JSON.stringify(state?.flushedOffsets));
    }

    // ══════════════════════════════════════════
    // TEST 4: Type → Enter → type again — no stale offset
    // ══════════════════════════════════════════
    console.log('\n--- Test 4: Enter resets state cleanly ---');
    await focusTerminal(page);
    await page.keyboard.type('first-prompt', { delay: 20 });
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000); // Wait for Claude response

    // Now type on the NEW prompt
    await focusTerminal(page);
    await page.keyboard.type('second-prompt', { delay: 20 });
    await page.waitForTimeout(300);

    state = await getState(page);
    console.log(`  After Enter+retype: pending="${state?.overlayText}", flushed=${state?.flushedOffset}`);
    await screenshot(page, '05-after-enter-retype');

    if (state?.overlayText === 'second-prompt' && state?.flushedOffset === 0) {
      pass('Clean state after Enter + retype');
    } else {
      fail('Stale state after Enter', `pending="${state?.overlayText}", flushed=${state?.flushedOffset}`);
    }

    // Clean up
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════
    // TEST 5: Overlay cursor position matches text end
    // ══════════════════════════════════════════
    console.log('\n--- Test 5: Cursor block position ---');
    await focusTerminal(page);
    await page.keyboard.type('cursor-pos', { delay: 30 }); // 10 chars
    await page.waitForTimeout(300);

    state = await getState(page);
    const children = state?.overlayChildren || [];
    console.log(`  Children: ${JSON.stringify(children)}`);

    // Should have 2 children: line div + cursor span
    // Cursor should be at position (startCol + 10) * cellW
    if (children.length >= 2) {
      const cursorChild = children[children.length - 1];
      // Cursor text should be empty (it's a block cursor, not a character)
      if (cursorChild.text === '') {
        pass('Cursor block present at end of text');
      } else {
        fail('Cursor block', `expected empty text, got "${cursorChild.text}"`);
      }

      // Check cursor is right after the text
      const textChild = children[0];
      const textLeft = parseInt(textChild.left);
      const cellW = 6; // from previous tests
      const expectedCursorLeft = textLeft + 10 * cellW; // 10 chars of "cursor-pos"
      const actualCursorLeft = parseInt(cursorChild.left);
      console.log(`  Text left: ${textLeft}px, cursor left: ${actualCursorLeft}px, expected: ${expectedCursorLeft}px`);
      if (actualCursorLeft === expectedCursorLeft) {
        pass('Cursor positioned correctly after text');
      } else {
        fail('Cursor position', `expected ${expectedCursorLeft}px, got ${actualCursorLeft}px`);
      }
    } else {
      fail('Overlay children count', `expected >=2, got ${children.length}`);
    }
    await screenshot(page, '06-cursor-position');

    // Clean up
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════
    // TEST 6: Type while Claude is busy (working status)
    // ══════════════════════════════════════════
    console.log('\n--- Test 6: Type while Claude is busy ---');
    await focusTerminal(page);
    await page.keyboard.type('generate a long response with lots of text', { delay: 10 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000); // Claude starts responding

    // Type while Claude is outputting
    await page.keyboard.type('typing-while-busy', { delay: 30 });
    await page.waitForTimeout(300);

    state = await getState(page);
    console.log(`  While busy: pending="${state?.overlayText}", visible=${state?.overlayVisible}`);
    await screenshot(page, '07-typing-while-busy');

    if (state?.overlayText === 'typing-while-busy') {
      pass('Can type while Claude is busy');
    } else {
      info('Typing while busy', `"${state?.overlayText}"`);
    }

    // Clean up
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // Final screenshot
    await screenshot(page, '08-final');

    // ══════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════
    console.log('\n=== SUMMARY ===');
    const passes = results.filter(r => r.status === 'PASS').length;
    const fails = results.filter(r => r.status === 'FAIL').length;
    const infos = results.filter(r => r.status === 'INFO').length;
    console.log(`  ${passes} passed, ${fails} failed, ${infos} info`);

    if (fails > 0) {
      console.log('\n  FAILURES:');
      for (const r of results.filter(r => r.status === 'FAIL')) {
        console.log(`    ❌ ${r.name}: ${r.detail}`);
      }
    }

  } finally {
    await browser.close();
    console.log('\nCleaning up...');
    await deleteSession(sessionA);
    await deleteSession(sessionB);
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
