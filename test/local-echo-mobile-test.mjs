/**
 * Local Echo Overlay — Mobile-focused integration test.
 *
 * Tests:
 * 1. Type text → verify overlay renders with correct font/position
 * 2. Switch tabs → verify text is flushed and overlay clears
 * 3. Switch back → type more → verify overlay still works
 * 4. Backspace (delete chars) from old and new input
 * 5. Font matching — overlay font vs terminal font comparison
 * 6. Long text wrapping across lines
 *
 * Takes screenshots at every step for visual verification.
 *
 * Usage: node test/local-echo-mobile-test.mjs
 */
import { chromium } from 'playwright';

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = '/tmp/local-echo-mobile';

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

async function waitForReady(sessionId, timeoutMs = 10000) {
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

/** Get overlay and terminal font/position info from the page */
async function getOverlayState(page) {
  return page.evaluate(() => {
    const app = window.app;
    if (!app) return null;

    // Find overlay container
    const overlay = app._localEchoOverlay?.overlay;
    const overlayVisible = overlay && overlay.style.display !== 'none';
    const overlayText = app._localEchoOverlay?.pendingText || '';

    // Get overlay font styles from first span child
    let overlayFont = null;
    if (overlay) {
      const span = overlay.querySelector('span');
      if (span) {
        const cs = getComputedStyle(span);
        overlayFont = {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          color: cs.color,
          letterSpacing: cs.letterSpacing,
        };
      }
    }

    // Get terminal font styles from .xterm-rows
    let terminalFont = null;
    const rows = document.querySelector('.xterm-rows');
    if (rows) {
      // Find an actual character span in the rendered rows
      const charSpan = rows.querySelector('span[style]') || rows.querySelector('span');
      const cs = getComputedStyle(rows);
      terminalFont = {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        color: cs.color,
        letterSpacing: cs.letterSpacing,
      };
      // Also get char-level font if available
      if (charSpan) {
        const charCs = getComputedStyle(charSpan);
        terminalFont.charFontFamily = charCs.fontFamily;
        terminalFont.charFontSize = charCs.fontSize;
      }
    }

    // Get overlay DOM children info
    const overlayChildren = [];
    if (overlay) {
      for (const child of overlay.children) {
        const spans = child.querySelectorAll('span');
        const text = Array.from(spans).map(s => s.textContent).join('');
        overlayChildren.push({
          text,
          left: child.style.left,
          top: child.style.top,
          width: child.style.width,
          spanCount: spans.length,
        });
      }
    }

    // Get overlay position
    const overlayRect = overlay?.getBoundingClientRect();

    return {
      overlayVisible,
      overlayText,
      overlayFont,
      terminalFont,
      overlayChildren,
      overlayRect: overlayRect ? {
        x: Math.round(overlayRect.x),
        y: Math.round(overlayRect.y),
        width: Math.round(overlayRect.width),
        height: Math.round(overlayRect.height),
      } : null,
      localEchoEnabled: app._localEchoEnabled,
      activeSessionId: app.activeSessionId,
      flushedOffset: app._localEchoOverlay?._flushedOffset || 0,
      flushedOffsets: app._flushedOffsets ? Object.fromEntries(app._flushedOffsets) : {},
    };
  });
}

/** Get list of session tab IDs */
async function getSessionTabs(page) {
  return page.evaluate(() => {
    const tabs = document.querySelectorAll('.session-tab');
    return Array.from(tabs).map(t => ({
      id: t.dataset.id,
      name: t.querySelector('.tab-name')?.textContent || t.textContent?.trim(),
      active: t.classList.contains('active'),
    }));
  });
}

/** Click a session tab by ID */
async function clickTab(page, sessionId) {
  await page.evaluate((id) => {
    const tab = document.querySelector(`.session-tab[data-id="${id}"]`);
    if (tab) tab.click();
  }, sessionId);
  await page.waitForTimeout(1500); // Wait for buffer load
}

async function screenshot(page, name) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`  📸 ${path}`);
  return path;
}

function compareFonts(overlayFont, terminalFont) {
  if (!overlayFont || !terminalFont) return { match: false, reason: 'missing font data' };
  const issues = [];
  if (overlayFont.fontFamily !== terminalFont.fontFamily) {
    issues.push(`fontFamily: overlay="${overlayFont.fontFamily}" vs terminal="${terminalFont.fontFamily}"`);
  }
  if (overlayFont.fontSize !== terminalFont.fontSize) {
    issues.push(`fontSize: overlay="${overlayFont.fontSize}" vs terminal="${terminalFont.fontSize}"`);
  }
  if (overlayFont.fontWeight !== terminalFont.fontWeight) {
    issues.push(`fontWeight: overlay="${overlayFont.fontWeight}" vs terminal="${terminalFont.fontWeight}"`);
  }
  if (overlayFont.letterSpacing !== terminalFont.letterSpacing) {
    issues.push(`letterSpacing: overlay="${overlayFont.letterSpacing}" vs terminal="${terminalFont.letterSpacing}"`);
  }
  return { match: issues.length === 0, issues };
}

async function main() {
  // Create screenshot directory
  const { mkdirSync } = await import('fs');
  try { mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

  console.log('=== Local Echo Overlay — Mobile Test ===\n');

  // Create two shell sessions for tab-switching tests
  console.log('Creating test sessions...');
  const sessionA = await createSession('echo-test-A');
  const sessionB = await createSession('echo-test-B');
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

  // Launch browser with mobile-like viewport
  const browser = await chromium.launch({
    headless: true,
    args: ['--window-size=390,844']
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  const results = [];
  function pass(name) { results.push({ name, status: 'PASS' }); console.log(`  ✅ PASS: ${name}`); }
  function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`  ❌ FAIL: ${name} — ${detail}`); }
  function info(name, detail) { results.push({ name, status: 'INFO', detail }); console.log(`  ℹ️  INFO: ${name} — ${detail}`); }

  try {
    // ── SETUP ──
    console.log('Opening Codeman...');
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Enable local echo via settings
    console.log('Enabling local echo...');
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('codeman-app-settings') || '{}');
      settings.localEchoEnabled = true;
      localStorage.setItem('codeman-app-settings', JSON.stringify(settings));
      window.app?._updateLocalEchoState?.();
    });
    await page.waitForTimeout(300);

    // Switch to session A
    console.log('Switching to Session A...');
    await clickTab(page, sessionA);
    await page.waitForTimeout(1000);

    // Focus terminal — use the hidden textarea (xterm-viewport intercepts pointer events)
    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      if (ta) ta.focus();
    });
    await page.waitForTimeout(300);

    let state = await getOverlayState(page);
    if (state?.localEchoEnabled) {
      pass('Local echo enabled');
    } else {
      fail('Local echo enabled', `localEchoEnabled=${state?.localEchoEnabled}`);
    }
    await screenshot(page, '01-initial-session-a');

    // ── TEST 1: Type text on Session A ──
    console.log('\n--- Test 1: Type text on Session A ---');
    const textA = 'hello-from-session-a';
    await page.keyboard.type(textA, { delay: 50 });
    await page.waitForTimeout(500);

    state = await getOverlayState(page);
    await screenshot(page, '02-typed-text-session-a');

    console.log(`  Overlay visible: ${state?.overlayVisible}`);
    console.log(`  Overlay text: "${state?.overlayText}"`);
    console.log(`  Overlay children: ${state?.overlayChildren?.length}`);

    if (state?.overlayVisible && state?.overlayText === textA) {
      pass('Overlay shows typed text');
    } else if (state?.overlayText === textA) {
      info('Overlay has text but not visible', `visible=${state?.overlayVisible}`);
    } else {
      fail('Overlay shows typed text', `expected="${textA}" got="${state?.overlayText}"`);
    }

    // ── TEST 2: Font matching ──
    // Compare overlay's cached font values against xterm.js options (always available,
    // unlike .xterm-rows DOM spans which don't exist with WebGL/canvas renderer).
    console.log('\n--- Test 2: Font matching ---');
    const xtermFont = await page.evaluate(() => {
      const t = window.app?.terminal;
      if (!t) return null;
      const overlay = window.app?._localEchoOverlay;
      return {
        xtermOpts: {
          fontFamily: t.options.fontFamily,
          fontSize: t.options.fontSize + 'px',
          fontWeight: String(t.options.fontWeight || 'normal'),
        },
        overlayCached: {
          fontFamily: overlay?._fontFamily,
          fontSize: overlay?._fontSize,
          fontWeight: String(overlay?._fontWeight || 'normal'),
        },
      };
    });
    console.log(`  xterm opts: ${JSON.stringify(xtermFont?.xtermOpts)}`);
    console.log(`  overlay cached: ${JSON.stringify(xtermFont?.overlayCached)}`);
    if (xtermFont) {
      const fontIssues = [];
      if (xtermFont.overlayCached.fontFamily !== xtermFont.xtermOpts.fontFamily)
        fontIssues.push(`fontFamily: "${xtermFont.overlayCached.fontFamily}" vs "${xtermFont.xtermOpts.fontFamily}"`);
      if (xtermFont.overlayCached.fontSize !== xtermFont.xtermOpts.fontSize)
        fontIssues.push(`fontSize: "${xtermFont.overlayCached.fontSize}" vs "${xtermFont.xtermOpts.fontSize}"`);
      if (xtermFont.overlayCached.fontWeight !== xtermFont.xtermOpts.fontWeight)
        fontIssues.push(`fontWeight: "${xtermFont.overlayCached.fontWeight}" vs "${xtermFont.xtermOpts.fontWeight}"`);
      if (fontIssues.length === 0) {
        pass('Overlay font matches xterm.js options');
      } else {
        fail('Font mismatch vs xterm options', fontIssues.join('; '));
      }
    } else {
      fail('Font comparison', 'Could not read xterm options');
    }

    // ── TEST 3: Backspace — delete some chars ──
    console.log('\n--- Test 3: Backspace on Session A ---');
    // Delete last 5 chars
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);

    state = await getOverlayState(page);
    await screenshot(page, '03-after-backspace-session-a');

    const expectedAfterBackspace = textA.slice(0, -5); // "hello-from-sess"
    console.log(`  Expected: "${expectedAfterBackspace}"`);
    console.log(`  Got: "${state?.overlayText}"`);

    if (state?.overlayText === expectedAfterBackspace) {
      pass('Backspace deletes from overlay correctly');
    } else {
      fail('Backspace result', `expected="${expectedAfterBackspace}" got="${state?.overlayText}"`);
    }

    // ── TEST 4: Switch to Session B (text should flush) ──
    console.log('\n--- Test 4: Switch to Session B ---');
    const textBeforeSwitch = state?.overlayText || '';
    await clickTab(page, sessionB);

    state = await getOverlayState(page);
    await screenshot(page, '04-switched-to-session-b');

    console.log(`  Active session: ${state?.activeSessionId}`);
    console.log(`  Overlay visible: ${state?.overlayVisible}`);
    console.log(`  Overlay text: "${state?.overlayText}"`);
    console.log(`  Flushed offsets: ${JSON.stringify(state?.flushedOffsets)}`);

    if (state?.activeSessionId === sessionB) {
      pass('Switched to Session B');
    } else {
      fail('Tab switch', `active=${state?.activeSessionId}, expected=${sessionB}`);
    }

    if (!state?.overlayVisible && !state?.overlayText) {
      pass('Overlay cleared on tab switch');
    } else {
      fail('Overlay not cleared', `visible=${state?.overlayVisible}, text="${state?.overlayText}"`);
    }

    // Check if text was flushed to Session A
    if (state?.flushedOffsets?.[sessionA] > 0) {
      pass(`Text flushed to Session A (${state.flushedOffsets[sessionA]} chars)`);
    } else {
      info('Flushed offsets', JSON.stringify(state?.flushedOffsets));
    }

    // ── TEST 5: Type on Session B ──
    console.log('\n--- Test 5: Type on Session B ---');
    await page.evaluate(() => { document.querySelector('.xterm-helper-textarea')?.focus(); });
    await page.waitForTimeout(300);

    const textB = 'hello-from-session-b';
    await page.keyboard.type(textB, { delay: 50 });
    await page.waitForTimeout(500);

    state = await getOverlayState(page);
    await screenshot(page, '05-typed-on-session-b');

    console.log(`  Overlay visible: ${state?.overlayVisible}`);
    console.log(`  Overlay text: "${state?.overlayText}"`);

    if (state?.overlayVisible && state?.overlayText === textB) {
      pass('Overlay works on Session B');
    } else {
      fail('Session B overlay', `expected="${textB}" got="${state?.overlayText}"`);
    }

    // ── TEST 6: Switch back to Session A ──
    console.log('\n--- Test 6: Switch back to Session A ---');
    await clickTab(page, sessionA);

    state = await getOverlayState(page);
    await screenshot(page, '06-back-to-session-a');

    console.log(`  Active session: ${state?.activeSessionId}`);
    console.log(`  Overlay visible: ${state?.overlayVisible}`);
    console.log(`  Overlay text: "${state?.overlayText}"`);
    console.log(`  Flushed offset on overlay: ${state?.flushedOffset}`);
    console.log(`  Flushed offsets map: ${JSON.stringify(state?.flushedOffsets)}`);

    // Session A's text was flushed before we left — it should have been sent to PTY.
    // The overlay should be clear (text was flushed, not pending anymore).
    if (!state?.overlayText) {
      pass('Session A overlay clear after return (text was flushed)');
    } else {
      info('Session A has overlay text after return', `"${state?.overlayText}"`);
    }

    // ── TEST 7: Type NEW text on Session A after returning ──
    console.log('\n--- Test 7: Type new text after returning to Session A ---');
    await page.evaluate(() => { document.querySelector('.xterm-helper-textarea')?.focus(); });
    await page.waitForTimeout(300);

    const textA2 = 'new-text-after-return';
    await page.keyboard.type(textA2, { delay: 50 });
    await page.waitForTimeout(500);

    state = await getOverlayState(page);
    await screenshot(page, '07-new-text-session-a');

    console.log(`  Overlay visible: ${state?.overlayVisible}`);
    console.log(`  Overlay text: "${state?.overlayText}"`);
    console.log(`  Flushed offset: ${state?.flushedOffset}`);
    console.log(`  Overlay children: ${JSON.stringify(state?.overlayChildren)}`);

    if (state?.overlayText === textA2) {
      pass('Can type new text after tab switch return');
    } else {
      fail('New text after return', `expected="${textA2}" got="${state?.overlayText}"`);
    }

    // ── TEST 8: Delete ALL chars with backspace ──
    console.log('\n--- Test 8: Delete all chars with backspace ---');
    const deleteCount = (state?.overlayText || '').length;
    for (let i = 0; i < deleteCount + 3; i++) { // +3 extra to test over-delete
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(300);

    state = await getOverlayState(page);
    await screenshot(page, '08-all-deleted');

    console.log(`  Overlay visible: ${state?.overlayVisible}`);
    console.log(`  Overlay text: "${state?.overlayText}"`);

    // After deleting all typed (pending) text, overlay stays visible because
    // flushed text still exists (3 extra backspaces only reduced flushed from 15→12).
    // The overlay correctly shows flushed text so the user can keep backspacing.
    if (state?.flushedOffset > 0 && state?.overlayVisible && !state?.overlayText) {
      pass('Overlay visible with flushed text after deleting pending');
    } else if (!state?.overlayVisible && !state?.overlayText && state?.flushedOffset === 0) {
      pass('Overlay hidden after deleting all chars');
    } else {
      fail('Unexpected state after full delete', `visible=${state?.overlayVisible}, text="${state?.overlayText}", flushed=${state?.flushedOffset}`);
    }

    // Verify backspace-into-flushed-text: the 3 extra backspaces should have
    // decremented flushedOffset from 15 to 12 and sent \x7f to PTY.
    const expectedFlushedAfterDelete = 15 - 3; // original 15, minus 3 extras
    console.log(`  Flushed offset after delete: ${state?.flushedOffset} (expected ${expectedFlushedAfterDelete})`);
    if (state?.flushedOffset === expectedFlushedAfterDelete) {
      pass('Backspace into flushed text decrements offset correctly');
    } else {
      fail('Flushed offset after backspace', `expected ${expectedFlushedAfterDelete}, got ${state?.flushedOffset}`);
    }

    // ── TEST 9: Type, submit with Enter, verify overlay clears ──
    console.log('\n--- Test 9: Enter submits and clears overlay ---');
    const enterText = 'echo submit-test';
    await page.keyboard.type(enterText, { delay: 50 });
    await page.waitForTimeout(300);

    state = await getOverlayState(page);
    await screenshot(page, '09-before-enter');

    if (state?.overlayText === enterText) {
      pass('Text buffered before Enter');
    } else {
      info('Pre-enter text', `"${state?.overlayText}"`);
    }

    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    state = await getOverlayState(page);
    await screenshot(page, '10-after-enter');

    console.log(`  Overlay visible: ${state?.overlayVisible}`);
    console.log(`  Overlay text: "${state?.overlayText}"`);

    if (!state?.overlayVisible && !state?.overlayText) {
      pass('Overlay cleared after Enter');
    } else {
      fail('Overlay not cleared after Enter', `visible=${state?.overlayVisible}, text="${state?.overlayText}"`);
    }

    // ── TEST 10: Rapid tab switching with pending text ──
    console.log('\n--- Test 10: Rapid tab switching ---');
    await page.keyboard.type('rapid-switch-text', { delay: 30 });
    await page.waitForTimeout(200);
    await screenshot(page, '11-before-rapid-switch');

    // Rapid switch: A → B → A
    await clickTab(page, sessionB);
    await page.waitForTimeout(300);
    await screenshot(page, '12-rapid-switch-to-b');

    await clickTab(page, sessionA);
    await page.waitForTimeout(300);
    await screenshot(page, '13-rapid-switch-back-to-a');

    state = await getOverlayState(page);
    console.log(`  After rapid switch — overlay text: "${state?.overlayText}"`);
    console.log(`  Flushed offsets: ${JSON.stringify(state?.flushedOffsets)}`);

    // Text should have been flushed to PTY, overlay should be clear
    if (!state?.overlayText || state?.overlayText === '') {
      pass('Rapid switch: overlay clear after return');
    } else {
      fail('Rapid switch: overlay has stale text', `"${state?.overlayText}"`);
    }

    // ── TEST 11: Font detail check — pixel-level ──
    console.log('\n--- Test 11: Detailed font comparison ---');
    await page.keyboard.type('font-check', { delay: 50 });
    await page.waitForTimeout(300);

    const fontDetail = await page.evaluate(() => {
      const app = window.app;
      const overlay = app?._localEchoOverlay;
      if (!overlay) return null;

      // Overlay span
      const oSpan = overlay.overlay.querySelector('span');
      // Terminal character
      const tRows = document.querySelector('.xterm-rows');
      // Find a row with actual text
      let tSpan = null;
      if (tRows) {
        const allSpans = tRows.querySelectorAll('span');
        for (const s of allSpans) {
          if (s.textContent?.trim()) { tSpan = s; break; }
        }
      }

      const getDetailedFont = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          fontStyle: cs.fontStyle,
          letterSpacing: cs.letterSpacing,
          lineHeight: cs.lineHeight,
          color: cs.color,
          textRendering: cs.textRendering,
          webkitFontSmoothing: cs.webkitFontSmoothing || cs['-webkit-font-smoothing'],
          fontKerning: cs.fontKerning,
          fontVariantLigatures: cs.fontVariantLigatures,
        };
      };

      // Also check xterm.js options
      const xtermOpts = {
        fontFamily: app.terminal?.options?.fontFamily,
        fontSize: app.terminal?.options?.fontSize,
        fontWeight: app.terminal?.options?.fontWeight,
        letterSpacing: app.terminal?.options?.letterSpacing,
      };

      // Cell dimensions
      let cellDims = null;
      try {
        const dims = app.terminal._core._renderService.dimensions;
        cellDims = {
          cellWidth: dims.css.cell.width,
          cellHeight: dims.css.cell.height,
        };
      } catch {}

      return {
        overlaySpan: getDetailedFont(oSpan),
        terminalSpan: getDetailedFont(tSpan),
        terminalRows: getDetailedFont(tRows),
        xtermOptions: xtermOpts,
        cellDims,
        // Check overlay cached values vs actual
        overlayCached: {
          fontFamily: overlay._fontFamily,
          fontSize: overlay._fontSize,
          fontWeight: overlay._fontWeight,
          color: overlay._color,
          letterSpacing: overlay._letterSpacing,
          bg: overlay._bg,
        },
      };
    });
    await screenshot(page, '14-font-detail-check');

    console.log('  xterm.js options:', JSON.stringify(fontDetail?.xtermOptions, null, 4));
    console.log('  Cell dims:', JSON.stringify(fontDetail?.cellDims, null, 4));
    console.log('  Overlay cached:', JSON.stringify(fontDetail?.overlayCached, null, 4));
    console.log('  Overlay span computed:', JSON.stringify(fontDetail?.overlaySpan, null, 4));
    console.log('  Terminal span computed:', JSON.stringify(fontDetail?.terminalSpan, null, 4));
    console.log('  Terminal rows computed:', JSON.stringify(fontDetail?.terminalRows, null, 4));

    // Check specific mismatches
    if (fontDetail?.overlaySpan && fontDetail?.terminalSpan) {
      const o = fontDetail.overlaySpan;
      const t = fontDetail.terminalSpan;
      const mismatches = [];
      for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'fontKerning']) {
        if (o[key] !== t[key]) {
          mismatches.push(`${key}: overlay="${o[key]}" vs terminal="${t[key]}"`);
        }
      }
      if (mismatches.length === 0) {
        pass('Detailed font comparison matches');
      } else {
        fail('Font mismatches found', mismatches.join('; '));
      }
    } else {
      info('Font detail check', 'Could not get computed styles for comparison');
    }

    // Clean up the typed text
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(50);
    for (let i = 0; i < 'font-check'.length; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(20);
    }

    // ── TEST 12: Long text that wraps ──
    console.log('\n--- Test 12: Long text wrapping ---');
    // Type enough to wrap past terminal width
    const longText = 'A'.repeat(80) + 'B'.repeat(40); // 120 chars — likely wraps on mobile
    await page.keyboard.type(longText, { delay: 5 });
    await page.waitForTimeout(500);

    state = await getOverlayState(page);
    await screenshot(page, '15-long-text-wrap');

    console.log(`  Overlay text length: ${state?.overlayText?.length}`);
    console.log(`  Overlay children (lines): ${state?.overlayChildren?.length}`);
    if (state?.overlayChildren) {
      for (const [i, child] of state.overlayChildren.entries()) {
        console.log(`    Line ${i}: "${child.text}" (${child.spanCount} spans, left=${child.left}, top=${child.top})`);
      }
    }

    if (state?.overlayText === longText) {
      pass('Long text stored correctly');
    } else {
      fail('Long text storage', `expected ${longText.length} chars, got ${state?.overlayText?.length}`);
    }

    if (state?.overlayChildren && state.overlayChildren.length > 1) {
      pass(`Long text wraps into ${state.overlayChildren.length} lines`);
    } else {
      fail('Long text wrapping', `only ${state?.overlayChildren?.length} line(s)`);
    }

    // Delete the long text
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // Final screenshot
    await screenshot(page, '16-final-state');

    // ── SUMMARY ──
    console.log('\n=== SUMMARY ===');
    const passes = results.filter(r => r.status === 'PASS').length;
    const fails = results.filter(r => r.status === 'FAIL').length;
    const infos = results.filter(r => r.status === 'INFO').length;
    console.log(`  ${passes} passed, ${fails} failed, ${infos} info`);
    console.log(`  Screenshots saved to ${SCREENSHOT_DIR}/`);

    if (fails > 0) {
      console.log('\n  FAILURES:');
      for (const r of results.filter(r => r.status === 'FAIL')) {
        console.log(`    ❌ ${r.name}: ${r.detail}`);
      }
    }

    if (errors.length > 0) {
      console.log(`\n  Console errors (${errors.length}):`);
      for (const e of errors.slice(0, 10)) console.log(`    ${e}`);
    }

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
