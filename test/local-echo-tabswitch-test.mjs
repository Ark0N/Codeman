/**
 * Local Echo Overlay — Tab Switch Bug Reproduction Test
 *
 * Reproduces the specific bug: switch tabs, switch back, type a space →
 * previous input disappears, cursor moves to start.
 *
 * Port: 3000 (runs against live dev server)
 *
 * Usage: node test/local-echo-tabswitch-test.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = '/tmp/local-echo-tabswitch';
const results = [];
const jsErrors = [];

function pass(name) { results.push({ name, ok: true }); console.log(`  ✓ PASS: ${name}`); }
function fail(name, detail) { results.push({ name, ok: false, detail }); console.log(`  ✗ FAIL: ${name} — ${detail}`); }

async function createSession(name) {
  const resp = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'shell', name })
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
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function getOverlayState(page) {
  return page.evaluate(() => {
    const app = window.app;
    if (!app) return null;
    const overlay = app._localEchoOverlay;
    const overlayEl = overlay?.overlay;

    // Get displayed text from overlay DOM children
    let displayedText = '';
    if (overlayEl) {
      for (const child of overlayEl.children) {
        // Skip cursor element (no inner spans with text or single span with no text)
        const spans = child.querySelectorAll('span');
        const text = Array.from(spans).map(s => s.textContent).join('');
        displayedText += text;
      }
    }

    return {
      overlayVisible: overlayEl ? overlayEl.style.display !== 'none' : false,
      pendingText: overlay?.pendingText || '',
      flushedOffset: overlay?._flushedOffset || 0,
      flushedText: overlay?._flushedText || '',
      displayedText: displayedText.replace(/\u00a0/g, ' '), // normalize nbsp
      localEchoEnabled: app._localEchoEnabled,
      activeSessionId: app.activeSessionId,
      flushedOffsetsMap: app._flushedOffsets ? Object.fromEntries(app._flushedOffsets) : {},
      flushedTextsMap: app._flushedTexts ? Object.fromEntries(app._flushedTexts) : {},
      lastPromptPos: overlay?._lastPromptPos || null,
      overlayChildCount: overlayEl?.children?.length || 0,
    };
  });
}

async function screenshot(page, name) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`    📸 ${path}`);
}

async function clickTab(page, sessionId) {
  await page.evaluate((id) => {
    const tab = document.querySelector(`.session-tab[data-id="${id}"]`);
    if (tab) tab.click();
  }, sessionId);
}

async function focusTerminal(page) {
  await page.evaluate(() => {
    document.querySelector('.xterm-helper-textarea')?.focus();
  });
  await page.waitForTimeout(200);
}

async function main() {
  try { mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

  console.log('=== Local Echo Tab Switch Bug Test ===\n');

  // Create two shell sessions
  console.log('Creating test sessions...');
  const sessionA = await createSession('ts-test-A');
  const sessionB = await createSession('ts-test-B');
  console.log(`  Session A: ${sessionA}`);
  console.log(`  Session B: ${sessionB}`);

  const readyA = await waitForReady(sessionA);
  const readyB = await waitForReady(sessionB);
  if (!readyA || !readyB) {
    console.error('Sessions failed to become ready');
    await deleteSession(sessionA);
    await deleteSession(sessionB);
    process.exit(1);
  }
  console.log('  Both sessions ready\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--window-size=390,844']
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('console', msg => { if (msg.type() === 'error') jsErrors.push(msg.text()); });

  // Install instrumentation to trace flushed state clearing
  await page.exposeFunction('__traceFlushedClear', (source, data) => {
    console.log(`    🔍 TRACE: flushed state cleared from "${source}" — data=${data}`);
  });

  try {
    // ── SETUP ──
    console.log('Opening Codeman...');
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForTimeout(2500);

    // Enable local echo
    console.log('Enabling local echo...');
    await page.evaluate(() => {
      const key = window.app?.getSettingsStorageKey?.() || 'codeman-app-settings';
      const settings = JSON.parse(localStorage.getItem(key) || '{}');
      settings.localEchoEnabled = true;
      localStorage.setItem(key, JSON.stringify(settings));
      if (window.app?._cachedAppSettings) window.app._cachedAppSettings.localEchoEnabled = true;
      window.app?._updateLocalEchoState?.();
    });
    await page.waitForTimeout(300);

    // Install tracing hooks inside the page to catch when flushed state is cleared
    await page.evaluate(() => {
      const app = window.app;
      if (!app) return;

      // Patch the onData handler to trace control char clearing
      // We can't directly patch the inner function, but we can watch the Maps
      const origDelete = Map.prototype.delete;
      const flushedOffsets = app._flushedOffsets;
      const flushedTexts = app._flushedTexts;

      // Trace overlay.clear()
      if (app._localEchoOverlay) {
        const origClear = app._localEchoOverlay.clear.bind(app._localEchoOverlay);
        app._localEchoOverlay.clear = function() {
          const stack = new Error().stack;
          // Extract caller info
          const callerLine = stack.split('\n')[2]?.trim() || 'unknown';
          console.warn(`[TRACE] overlay.clear() called from: ${callerLine}`);
          window.__localEchoClearLog = window.__localEchoClearLog || [];
          window.__localEchoClearLog.push({
            time: Date.now(),
            source: 'overlay.clear()',
            caller: callerLine,
            hadFlushed: this._flushedOffset > 0,
            hadPending: this.pendingText.length > 0,
          });
          return origClear();
        };
      }
    });

    // Switch to session A
    console.log('Switching to Session A...');
    await clickTab(page, sessionA);
    await page.waitForTimeout(2000);
    await focusTerminal(page);

    let state = await getOverlayState(page);
    console.log(`  Local echo enabled: ${state?.localEchoEnabled}`);
    if (!state?.localEchoEnabled) {
      fail('Local echo not enabled', `localEchoEnabled=${state?.localEchoEnabled}`);
      return;
    }
    pass('Local echo enabled');

    // ── STEP 1: Type text in Session A ──
    console.log('\n--- Step 1: Type "hello world" in Session A ---');
    await page.keyboard.type('hello world', { delay: 50 });
    await page.waitForTimeout(500);

    state = await getOverlayState(page);
    await screenshot(page, '01-typed-in-A');
    console.log(`  pendingText: "${state?.pendingText}"`);
    console.log(`  flushedOffset: ${state?.flushedOffset}`);
    console.log(`  overlayVisible: ${state?.overlayVisible}`);
    console.log(`  displayedText: "${state?.displayedText}"`);

    if (state?.pendingText === 'hello world') {
      pass('Text typed in Session A');
    } else {
      fail('Text in Session A', `expected "hello world", got "${state?.pendingText}"`);
    }

    // ── STEP 2: Switch to Session B ──
    console.log('\n--- Step 2: Switch to Session B ---');
    // Clear trace log
    await page.evaluate(() => { window.__localEchoClearLog = []; });

    await clickTab(page, sessionB);
    await page.waitForTimeout(2500);
    await focusTerminal(page);

    state = await getOverlayState(page);
    await screenshot(page, '02-switched-to-B');
    console.log(`  activeSession: ${state?.activeSessionId}`);
    console.log(`  pendingText: "${state?.pendingText}"`);
    console.log(`  flushedOffset: ${state?.flushedOffset}`);
    console.log(`  flushedOffsetsMap: ${JSON.stringify(state?.flushedOffsetsMap)}`);
    console.log(`  flushedTextsMap: ${JSON.stringify(state?.flushedTextsMap)}`);

    if (state?.activeSessionId === sessionB) {
      pass('Switched to Session B');
    } else {
      fail('Tab switch to B', `activeSession=${state?.activeSessionId}`);
    }

    // Check that A's text was stored in flushed maps
    const flushedForA = state?.flushedOffsetsMap?.[sessionA];
    if (flushedForA === 11) { // "hello world" = 11 chars
      pass(`Session A text flushed (${flushedForA} chars)`);
    } else {
      fail('Flushed offset for A', `expected 11, got ${flushedForA}`);
    }

    // ── STEP 3: Type in Session B ──
    console.log('\n--- Step 3: Type "typing in B" in Session B ---');
    await page.keyboard.type('typing in B', { delay: 50 });
    await page.waitForTimeout(500);

    state = await getOverlayState(page);
    await screenshot(page, '03-typed-in-B');
    console.log(`  pendingText: "${state?.pendingText}"`);
    console.log(`  flushedOffsetsMap: ${JSON.stringify(state?.flushedOffsetsMap)}`);

    if (state?.pendingText === 'typing in B') {
      pass('Text typed in Session B');
    } else {
      fail('Text in Session B', `expected "typing in B", got "${state?.pendingText}"`);
    }

    // Verify A's flushed state is still in the Maps
    if (state?.flushedOffsetsMap?.[sessionA] === 11) {
      pass('Session A flushed state preserved while on B');
    } else {
      fail('A flushed state while on B', `expected 11, got ${state?.flushedOffsetsMap?.[sessionA]}`);
    }

    // ── STEP 4: Switch back to Session A ──
    console.log('\n--- Step 4: Switch back to Session A ---');
    await page.evaluate(() => { window.__localEchoClearLog = []; });

    await clickTab(page, sessionA);
    await page.waitForTimeout(3000); // Wait for full buffer load

    state = await getOverlayState(page);
    await screenshot(page, '04-back-to-A-before-typing');
    console.log(`  activeSession: ${state?.activeSessionId}`);
    console.log(`  pendingText: "${state?.pendingText}"`);
    console.log(`  flushedOffset: ${state?.flushedOffset}`);
    console.log(`  flushedText: "${state?.flushedText}"`);
    console.log(`  flushedOffsetsMap: ${JSON.stringify(state?.flushedOffsetsMap)}`);
    console.log(`  overlayVisible: ${state?.overlayVisible}`);
    console.log(`  lastPromptPos: ${JSON.stringify(state?.lastPromptPos)}`);
    console.log(`  displayedText: "${state?.displayedText}"`);

    // Check trace log
    const clearLog = await page.evaluate(() => window.__localEchoClearLog || []);
    console.log(`  Clear log entries: ${clearLog.length}`);
    for (const entry of clearLog) {
      console.log(`    - ${entry.source} @ ${entry.caller} (hadFlushed=${entry.hadFlushed}, hadPending=${entry.hadPending})`);
    }

    if (state?.activeSessionId === sessionA) {
      pass('Switched back to Session A');
    } else {
      fail('Tab switch back to A', `activeSession=${state?.activeSessionId}`);
    }

    // KEY CHECK: flushed state should be restored
    if (state?.flushedOffset === 11) {
      pass('Flushed offset restored on overlay');
    } else {
      fail('Flushed offset on overlay', `expected 11, got ${state?.flushedOffset}`);
    }

    if (state?.flushedText === 'hello world') {
      pass('Flushed text restored on overlay');
    } else {
      fail('Flushed text on overlay', `expected "hello world", got "${state?.flushedText}"`);
    }

    // ── STEP 5: THE BUG — Type a space after switching back ──
    console.log('\n--- Step 5: Type a SPACE after returning to Session A ---');
    await focusTerminal(page);

    // Record state RIGHT BEFORE typing
    const preTypeState = await getOverlayState(page);
    console.log(`  PRE-TYPE state:`);
    console.log(`    pendingText: "${preTypeState?.pendingText}"`);
    console.log(`    flushedOffset: ${preTypeState?.flushedOffset}`);
    console.log(`    flushedText: "${preTypeState?.flushedText}"`);
    console.log(`    overlayVisible: ${preTypeState?.overlayVisible}`);
    console.log(`    localEchoEnabled: ${preTypeState?.localEchoEnabled}`);

    await page.keyboard.type(' ', { delay: 0 }); // Type single space
    await page.waitForTimeout(500);

    state = await getOverlayState(page);
    await screenshot(page, '05-typed-space-after-return');
    console.log(`  POST-TYPE state:`);
    console.log(`    pendingText: "${state?.pendingText}"`);
    console.log(`    flushedOffset: ${state?.flushedOffset}`);
    console.log(`    flushedText: "${state?.flushedText}"`);
    console.log(`    overlayVisible: ${state?.overlayVisible}`);
    console.log(`    displayedText: "${state?.displayedText}"`);
    console.log(`    overlayChildCount: ${state?.overlayChildCount}`);

    // THE CRITICAL ASSERTION: flushed text should still be tracked
    if (state?.flushedOffset === 11) {
      pass('Flushed offset preserved after typing space');
    } else {
      fail('Flushed offset after space', `expected 11, got ${state?.flushedOffset}`);
    }

    // The displayed text should include BOTH flushed text AND new space
    const expectedDisplay = 'hello world ';
    if (state?.displayedText?.startsWith('hello world')) {
      pass('Displayed text includes flushed + new text');
    } else {
      fail('Displayed text', `expected starts with "hello world", got "${state?.displayedText}"`);
    }

    if (state?.overlayVisible) {
      pass('Overlay visible after typing');
    } else {
      fail('Overlay visibility', 'overlay is hidden after typing');
    }

    // ── STEP 6: Type more characters ──
    console.log('\n--- Step 6: Type "more" after the space ---');
    await page.keyboard.type('more', { delay: 50 });
    await page.waitForTimeout(500);

    state = await getOverlayState(page);
    await screenshot(page, '06-typed-more-after-space');
    console.log(`  pendingText: "${state?.pendingText}"`);
    console.log(`  flushedOffset: ${state?.flushedOffset}`);
    console.log(`  displayedText: "${state?.displayedText}"`);

    if (state?.pendingText === ' more') {
      pass('Pending text is " more"');
    } else {
      fail('Pending text after more typing', `expected " more", got "${state?.pendingText}"`);
    }

    const expectedFullDisplay = 'hello world more';
    if (state?.displayedText?.includes('hello world') && state?.displayedText?.includes('more')) {
      pass('Full displayed text includes flushed + all new text');
    } else {
      fail('Full display', `expected "${expectedFullDisplay}", got "${state?.displayedText}"`);
    }

    // ── STEP 7: Backspace through new text into flushed text ──
    console.log('\n--- Step 7: Backspace through new and into flushed text ---');
    // Delete " more" (5 chars) + 3 from flushed
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);

    state = await getOverlayState(page);
    await screenshot(page, '07-after-backspace-into-flushed');
    console.log(`  pendingText: "${state?.pendingText}"`);
    console.log(`  flushedOffset: ${state?.flushedOffset}`);
    console.log(`  flushedText: "${state?.flushedText}"`);
    console.log(`  displayedText: "${state?.displayedText}"`);

    // Should have deleted 5 pending + 3 flushed = flushedOffset 8
    if (state?.pendingText === '') {
      pass('Pending text empty after backspace');
    } else {
      fail('Pending text after backspace', `expected "", got "${state?.pendingText}"`);
    }

    if (state?.flushedOffset === 8) {
      pass('Flushed offset correctly decremented (11 - 3 = 8)');
    } else {
      fail('Flushed offset after backspace', `expected 8, got ${state?.flushedOffset}`);
    }

    // ── STEP 8: Submit with Enter ──
    console.log('\n--- Step 8: Press Enter to submit ---');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    state = await getOverlayState(page);
    await screenshot(page, '08-after-enter');
    console.log(`  pendingText: "${state?.pendingText}"`);
    console.log(`  flushedOffset: ${state?.flushedOffset}`);
    console.log(`  overlayVisible: ${state?.overlayVisible}`);
    console.log(`  flushedOffsetsMap: ${JSON.stringify(state?.flushedOffsetsMap)}`);

    if (!state?.overlayVisible && state?.pendingText === '' && state?.flushedOffset === 0) {
      pass('Overlay fully cleared after Enter');
    } else {
      fail('State after Enter', `visible=${state?.overlayVisible}, pending="${state?.pendingText}", flushed=${state?.flushedOffset}`);
    }

    if (!state?.flushedOffsetsMap?.[sessionA]) {
      pass('Flushed map cleared for session A after Enter');
    } else {
      fail('Flushed map after Enter', `still has A: ${state?.flushedOffsetsMap?.[sessionA]}`);
    }

    // ── STEP 9: Repeat the cycle — ensure it works multiple times ──
    console.log('\n--- Step 9: Second cycle — type, switch, switch back, type ---');
    await page.keyboard.type('second-round', { delay: 40 });
    await page.waitForTimeout(300);

    // Switch to B
    await clickTab(page, sessionB);
    await page.waitForTimeout(2000);

    // Switch back to A
    await clickTab(page, sessionA);
    await page.waitForTimeout(3000);
    await focusTerminal(page);

    state = await getOverlayState(page);
    console.log(`  After 2nd cycle — flushedOffset: ${state?.flushedOffset}, flushedText: "${state?.flushedText}"`);

    // Type space + more text
    await page.keyboard.type(' again', { delay: 40 });
    await page.waitForTimeout(500);

    state = await getOverlayState(page);
    await screenshot(page, '09-second-cycle');
    console.log(`  pendingText: "${state?.pendingText}"`);
    console.log(`  flushedOffset: ${state?.flushedOffset}`);
    console.log(`  displayedText: "${state?.displayedText}"`);

    if (state?.displayedText?.includes('second-round') && state?.displayedText?.includes('again')) {
      pass('Second cycle: flushed + new text displayed correctly');
    } else {
      fail('Second cycle display', `expected "second-round again", got "${state?.displayedText}"`);
    }

    // ── SUMMARY ──
    console.log('\n=== SUMMARY ===');
    const passes = results.filter(r => r.ok).length;
    const fails = results.filter(r => !r.ok).length;
    console.log(`  ${passes} passed, ${fails} failed`);
    console.log(`  Screenshots: ${SCREENSHOT_DIR}/`);

    if (fails > 0) {
      console.log('\n  FAILURES:');
      for (const r of results.filter(r => !r.ok)) {
        console.log(`    ✗ ${r.name}: ${r.detail}`);
      }
    }

    if (jsErrors.length > 0) {
      console.log(`\n  JS errors (${jsErrors.length}):`);
      for (const e of jsErrors.slice(0, 10)) console.log(`    ${e}`);
    }

    console.log(`\n  Exit code: ${fails > 0 ? 1 : 0}`);
    process.exitCode = fails > 0 ? 1 : 0;

  } finally {
    await browser.close();
    console.log('\nCleaning up sessions...');
    await deleteSession(sessionA);
    await deleteSession(sessionB);
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
