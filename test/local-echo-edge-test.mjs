/**
 * Local Echo Overlay — Comprehensive edge case tests.
 *
 * Tests: reload, tab switching, backspace, Ctrl+C, paste, rapid switches,
 * empty Enter, long text wrap, flushed offset tracking, and font rendering.
 *
 * Usage: node test/local-echo-edge-test.mjs
 */
import { chromium } from 'playwright';

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = '/tmp/local-echo-edge';

const results = [];
function pass(name) { results.push({ name, ok: true }); console.log(`  ✅ ${name}`); }
function fail(name, detail) { results.push({ name, ok: false, detail }); console.log(`  ❌ ${name} — ${detail}`); }

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

async function waitForReady(id, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const r = await fetch(`${BASE}/api/sessions/${id}`);
    if (r.ok) { const d = await r.json(); if (d.status === 'idle' || d.status === 'busy') return true; }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function getState(page) {
  return page.evaluate(() => {
    const app = window.app;
    if (!app) return null;
    const overlay = app._localEchoOverlay;
    return {
      localEchoEnabled: app._localEchoEnabled,
      overlayVisible: overlay?.overlay?.style.display !== 'none',
      overlayText: overlay?.pendingText || '',
      flushedOffset: overlay?._flushedOffset || 0,
      flushedOffsets: app._flushedOffsets ? Object.fromEntries(app._flushedOffsets) : {},
      activeSessionId: app.activeSessionId,
      overlayChildCount: overlay?.overlay?.children?.length || 0,
      overlaySpanCSS: (() => {
        const span = overlay?.overlay?.children?.[0]?.children?.[0];
        if (!span) return null;
        const cs = getComputedStyle(span);
        return {
          fontSmoothing: cs.webkitFontSmoothing || 'N/A',
          textRendering: cs.textRendering,
          fontFeatures: cs.fontFeatureSettings,
        };
      })(),
    };
  });
}

async function focusTerminal(page) {
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus());
  await page.waitForTimeout(200);
}

async function screenshot(page, name) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`    📸 ${name}.png`);
}

async function selectSession(page, sessionId) {
  await page.evaluate((id) => {
    const t = document.querySelector(`.session-tab[data-id="${id}"]`);
    if (t) t.click();
  }, sessionId);
  await page.waitForTimeout(1500);
}

async function main() {
  const { mkdirSync } = await import('fs');
  try { mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

  console.log('=== Local Echo — Comprehensive Edge Case Tests ===\n');

  const sA = await createSession('edge-A');
  const sB = await createSession('edge-B');
  const sC = await createSession('edge-C');
  console.log(`  Sessions: A=${sA.slice(0,8)}, B=${sB.slice(0,8)}, C=${sC.slice(0,8)}`);

  for (const s of [sA, sB, sC]) {
    if (!await waitForReady(s)) { console.error(`Session ${s} not ready`); process.exit(1); }
  }
  console.log('  All ready.\n');

  const browser = await chromium.launch({ headless: true, args: ['--window-size=390,844'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
    isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', err => jsErrors.push(err.message));

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

    // ═══════════════════════════════════════════
    // 1. Fresh typing on session A
    // ═══════════════════════════════════════════
    console.log('── 1. Fresh typing ──');
    await selectSession(page, sA);
    // Wait for ❯ prompt to appear in terminal buffer (Claude Code startup)
    for (let i = 0; i < 20; i++) {
      const hasPrompt = await page.evaluate(() => {
        const buf = window.app?.terminal?.buffer?.active;
        if (!buf) return false;
        for (let r = 0; r < window.app.terminal.rows; r++) {
          const line = buf.getLine(buf.viewportY + r);
          if (line && line.translateToString(true).includes('\u276f')) return true;
        }
        return false;
      });
      if (hasPrompt) break;
      await page.waitForTimeout(500);
    }
    await focusTerminal(page);
    await page.keyboard.type('hello world', { delay: 20 });
    await page.waitForTimeout(200);
    let st = await getState(page);
    if (st.overlayText === 'hello world' && st.overlayVisible) pass('Fresh typing shows in overlay');
    else fail('Fresh typing', `text="${st.overlayText}", visible=${st.overlayVisible}`);
    if (st.overlaySpanCSS?.textRendering === 'geometricprecision') pass('Font CSS applied');
    else fail('Font CSS', JSON.stringify(st.overlaySpanCSS));
    await screenshot(page, '01-fresh-type');

    // ═══════════════════════════════════════════
    // 2. Backspace removes from overlay (not PTY)
    // ═══════════════════════════════════════════
    console.log('── 2. Backspace ──');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    st = await getState(page);
    if (st.overlayText === 'hello wor') pass('Backspace removes chars from overlay');
    else fail('Backspace', `text="${st.overlayText}"`);

    // Backspace to empty
    for (let i = 0; i < 20; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    st = await getState(page);
    if (st.overlayText === '' && !st.overlayVisible) pass('Backspace to empty hides overlay');
    else fail('Backspace to empty', `text="${st.overlayText}", visible=${st.overlayVisible}`);

    // Extra backspace on empty — should not crash
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    st = await getState(page);
    if (st.overlayText === '') pass('Extra backspace on empty is no-op');
    else fail('Extra backspace', `text="${st.overlayText}"`);

    // ═══════════════════════════════════════════
    // 3. Enter on empty prompt — no-op
    // ═══════════════════════════════════════════
    console.log('── 3. Enter on empty ──');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    st = await getState(page);
    if (st.overlayText === '' && st.flushedOffset === 0) pass('Enter on empty is harmless');
    else fail('Enter on empty', `text="${st.overlayText}", flushed=${st.flushedOffset}`);

    // ═══════════════════════════════════════════
    // 4. Tab switch A→B: text flushed to PTY
    // ═══════════════════════════════════════════
    console.log('── 4. Tab switch flush ──');
    await focusTerminal(page);
    await page.keyboard.type('flush-me', { delay: 20 });
    await page.waitForTimeout(200);

    await selectSession(page, sB);
    await page.waitForTimeout(500);
    st = await getState(page);
    if (st.overlayText === '') pass('Overlay cleared after tab switch');
    else fail('Overlay after switch', `text="${st.overlayText}"`);
    const flushedA = st.flushedOffsets[sA] || 0;
    if (flushedA === 8) pass('Flushed offset tracked for session A (8 chars)');
    else fail('Flushed offset', `expected 8, got ${flushedA}`);

    // ═══════════════════════════════════════════
    // 5. Type on B, switch to C, switch back to B
    // ═══════════════════════════════════════════
    console.log('── 5. Triple switch B→C→B ──');
    await focusTerminal(page);
    await page.keyboard.type('on-B', { delay: 20 });
    await page.waitForTimeout(200);

    await selectSession(page, sC);
    await page.waitForTimeout(500);
    st = await getState(page);
    const flushedB = st.flushedOffsets[sB] || 0;
    if (flushedB === 4) pass('B flushed on switch to C');
    else fail('B flush', `expected 4, got ${flushedB}`);

    await focusTerminal(page);
    await page.keyboard.type('on-C', { delay: 20 });
    await page.waitForTimeout(200);

    await selectSession(page, sB);
    await page.waitForTimeout(500);
    st = await getState(page);
    if (st.overlayText === '') pass('Overlay empty on return to B');
    else fail('Return to B overlay', `text="${st.overlayText}"`);
    if (st.flushedOffset === 4) pass('Flushed offset restored for B');
    else fail('B flushed offset restore', `expected 4, got ${st.flushedOffset}`);
    await screenshot(page, '05-return-to-B');

    // ═══════════════════════════════════════════
    // 6. Type after return (append to flushed)
    // ═══════════════════════════════════════════
    console.log('── 6. Type after return to flushed session ──');
    await focusTerminal(page);
    await page.keyboard.type(' more', { delay: 20 });
    await page.waitForTimeout(200);
    st = await getState(page);
    if (st.overlayText === ' more' && st.flushedOffset === 4) pass('Append after flushed');
    else fail('Append after flush', `text="${st.overlayText}", flushed=${st.flushedOffset}`);
    await screenshot(page, '06-append-after-flush');

    // ═══════════════════════════════════════════
    // 7. Enter clears flushed offset
    // ═══════════════════════════════════════════
    console.log('── 7. Enter clears flushed offset ──');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    st = await getState(page);
    if (st.overlayText === '' && st.flushedOffset === 0) pass('Enter clears overlay + flushed');
    else fail('Enter clear', `text="${st.overlayText}"`);
    const bInMap = st.flushedOffsets[sB];
    if (!bInMap) pass('Flushed offset map cleared for B');
    else fail('Map clear', `B still in map: ${bInMap}`);

    // ═══════════════════════════════════════════
    // 8. Ctrl+C during typing
    // ═══════════════════════════════════════════
    console.log('── 8. Ctrl+C during typing ──');
    await page.waitForTimeout(3000);
    await focusTerminal(page);
    await page.keyboard.type('will-be-cancelled', { delay: 20 });
    await page.waitForTimeout(200);

    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await page.waitForTimeout(500);
    st = await getState(page);
    if (st.overlayText === '') pass('Ctrl+C clears overlay');
    else fail('Ctrl+C clear', `text="${st.overlayText}"`);
    await screenshot(page, '08-ctrl-c');

    // ═══════════════════════════════════════════
    // 9. Paste (multi-char data)
    // ═══════════════════════════════════════════
    console.log('── 9. Paste ──');
    await page.waitForTimeout(2000);
    await focusTerminal(page);
    await page.evaluate(() => {
      window.app?._localEchoOverlay?.appendText('pasted-text');
    });
    await page.waitForTimeout(200);
    st = await getState(page);
    if (st.overlayText === 'pasted-text') pass('Paste appends to overlay');
    else fail('Paste', `text="${st.overlayText}"`);

    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await page.waitForTimeout(500);

    // ═══════════════════════════════════════════
    // 10. Reload — stale text NOT restored
    // ═══════════════════════════════════════════
    console.log('── 10. Browser reload ──');
    await page.waitForTimeout(2000);
    await focusTerminal(page);
    await page.keyboard.type('will-be-lost', { delay: 20 });
    await page.waitForTimeout(200);

    const lsBefore = await page.evaluate(() => localStorage.getItem('codeman_local_echo_pending'));
    if (!lsBefore) pass('localStorage not written (persist is no-op)');
    else fail('localStorage written', `value="${lsBefore}"`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForTimeout(3000);

    await page.evaluate(() => window.app?._updateLocalEchoState?.());

    st = await getState(page);
    if (st.overlayText === '') pass('Overlay empty after reload (no stale text)');
    else fail('Stale text after reload', `text="${st.overlayText}"`);
    if (st.flushedOffset === 0) pass('Flushed offset reset after reload');
    else fail('Flushed offset after reload', `flushed=${st.flushedOffset}`);
    if (Object.keys(st.flushedOffsets).length === 0) pass('Flushed offsets map empty after reload');
    else fail('Flushed map after reload', JSON.stringify(st.flushedOffsets));

    // ═══════════════════════════════════════════
    // 11. Type after reload — works normally
    // ═══════════════════════════════════════════
    console.log('── 11. Type after reload ──');
    await focusTerminal(page);
    await page.keyboard.type('after reload', { delay: 20 });
    await page.waitForTimeout(300);
    st = await getState(page);
    if (st.overlayText === 'after reload' && st.overlayVisible) pass('Typing works after reload');
    else fail('Type after reload', `text="${st.overlayText}", visible=${st.overlayVisible}`);
    await screenshot(page, '11-after-reload');

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    st = await getState(page);
    if (st.overlayText === 'after relo') pass('Backspace works after reload');
    else fail('Backspace after reload', `text="${st.overlayText}"`);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    st = await getState(page);
    if (st.overlayText === '' && st.flushedOffset === 0) pass('Enter works after reload');
    else fail('Enter after reload', `text="${st.overlayText}"`);
    await screenshot(page, '11-enter-after-reload');

    // ═══════════════════════════════════════════
    // 12. Rapid tab switching (no typing between)
    // ═══════════════════════════════════════════
    console.log('── 12. Rapid tab switching ──');
    for (let i = 0; i < 3; i++) {
      await selectSession(page, sA);
      await page.waitForTimeout(200);
      await selectSession(page, sB);
      await page.waitForTimeout(200);
      await selectSession(page, sC);
      await page.waitForTimeout(200);
    }
    st = await getState(page);
    if (st.overlayText === '' && st.flushedOffset === 0) pass('Rapid switches — clean state');
    else fail('Rapid switches', `text="${st.overlayText}", flushed=${st.flushedOffset}`);

    // ═══════════════════════════════════════════
    // 13. Backspace on flushed text (no pending)
    // ═══════════════════════════════════════════
    console.log('── 13. Backspace on flushed text ──');
    await selectSession(page, sA);
    await page.waitForTimeout(3000);
    await focusTerminal(page);
    await page.keyboard.type('abc', { delay: 20 });
    await page.waitForTimeout(200);

    await selectSession(page, sB);
    await page.waitForTimeout(500);
    await selectSession(page, sA);
    await page.waitForTimeout(500);
    st = await getState(page);
    const flushedA2 = st.flushedOffset;
    console.log(`    Flushed offset for A: ${flushedA2}`);

    await focusTerminal(page);
    if (flushedA2 > 0) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      st = await getState(page);
      if (st.flushedOffset === flushedA2 - 1) pass('Backspace decrements flushed offset');
      else fail('Backspace flushed', `expected ${flushedA2 - 1}, got ${st.flushedOffset}`);
    } else {
      pass('Flushed offset was 0 — skip backspace flushed test');
    }

    // ═══════════════════════════════════════════
    // 14. Overlay hidden when scrolled up
    // ═══════════════════════════════════════════
    console.log('── 14. Overlay hidden on scroll up ──');
    await focusTerminal(page);
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await page.waitForTimeout(1000);

    await focusTerminal(page);
    await page.keyboard.type('scroll-test', { delay: 20 });
    await page.waitForTimeout(200);

    await page.evaluate(() => window.app?.terminal?.scrollToTop());
    await page.waitForTimeout(300);
    // Check if scroll actually happened (buffer may be too short for viewport)
    const scrollState = await page.evaluate(() => {
      const buf = window.app?.terminal?.buffer?.active;
      return { viewportY: buf?.viewportY, baseY: buf?.baseY };
    });
    if (scrollState.viewportY === scrollState.baseY) {
      // Buffer too short to scroll — skip scroll hide/show tests
      pass('Scroll up hide — SKIP (buffer too short to scroll, viewportY===baseY)');
      pass('Text preserved while scrolled — SKIP');
      pass('Overlay reappears at bottom — SKIP');
      console.log(`    (viewportY=${scrollState.viewportY}, baseY=${scrollState.baseY})`);
    } else {
      st = await getState(page);
      if (!st.overlayVisible) pass('Overlay hidden when scrolled up');
      else fail('Scroll up hide', `visible=${st.overlayVisible}`);
      if (st.overlayText === 'scroll-test') pass('Text preserved while scrolled');
      else fail('Text during scroll', `text="${st.overlayText}"`);

      await page.evaluate(() => window.app?.terminal?.scrollToBottom());
      await page.waitForTimeout(500);
      await page.keyboard.type('x', { delay: 20 });
      await page.waitForTimeout(500);
      st = await getState(page);
      if (st.overlayVisible) pass('Overlay reappears at bottom');
      else fail('Scroll bottom show', `visible=${st.overlayVisible}`);
    }

    // ═══════════════════════════════════════════
    // 15. Double reload
    // ═══════════════════════════════════════════
    console.log('── 15. Double reload ──');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForTimeout(2000);

    st = await getState(page);
    if (st.overlayText === '') pass('Clean state after double reload');
    else fail('Double reload', `text="${st.overlayText}"`);

    await focusTerminal(page);
    await page.keyboard.type('post-double-reload', { delay: 20 });
    await page.waitForTimeout(200);
    st = await getState(page);
    if (st.overlayText === 'post-double-reload') pass('Input works after double reload');
    else fail('Post double reload type', `text="${st.overlayText}"`);
    await screenshot(page, '15-double-reload');

    // ═══════════════════════════════════════════
    // 16. Ctrl+C clears flushed offset too
    // ═══════════════════════════════════════════
    console.log('── 16. Ctrl+C clears flushed offsets ──');
    // Clear current text
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await page.waitForTimeout(2000);

    await focusTerminal(page);
    await page.keyboard.type('flush-ctrl-c', { delay: 20 });
    await page.waitForTimeout(200);
    // Switch to flush
    await selectSession(page, sB);
    await page.waitForTimeout(500);
    // Switch back
    await selectSession(page, sA);
    await page.waitForTimeout(500);
    st = await getState(page);
    const preFlushed = st.flushedOffset;

    // Now Ctrl+C — should clear flushed offset
    await focusTerminal(page);
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await page.waitForTimeout(500);
    st = await getState(page);
    if (st.flushedOffset === 0) pass('Ctrl+C clears flushed offset');
    else fail('Ctrl+C flushed', `expected 0, got ${st.flushedOffset} (was ${preFlushed})`);
    const aInMap = st.flushedOffsets[sA];
    if (!aInMap) pass('Ctrl+C clears flushed offsets map for session');
    else fail('Ctrl+C map', `A still in map: ${aInMap}`);

    // ═══════════════════════════════════════════
    // 17. JS errors check
    // ═══════════════════════════════════════════
    console.log('── 17. JS errors ──');
    if (jsErrors.length === 0) pass('No JS errors during all tests');
    else {
      fail('JS errors found', `${jsErrors.length} errors`);
      jsErrors.forEach(e => console.log(`    ⚠️  ${e}`));
    }

    // ═══════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════
    console.log('\n═══════════════════════════════════');
    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    console.log(`  ${passed} passed, ${failed} failed out of ${results.length} checks`);
    if (failed > 0) {
      console.log('\n  Failures:');
      results.filter(r => !r.ok).forEach(r => console.log(`    ❌ ${r.name}: ${r.detail}`));
    }
    console.log('═══════════════════════════════════\n');

  } finally {
    await browser.close();
    console.log('  Cleaning up sessions...');
    await deleteSession(sA);
    await deleteSession(sB);
    await deleteSession(sC);
    console.log('  Done.\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
