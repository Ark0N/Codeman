/**
 * Local Echo Overlay — Basic operation tests.
 *
 * Tests the most fundamental user scenarios:
 * 1. Type → switch tab → come back → backspace works
 * 2. Type → switch tab → come back → space doesn't erase text
 * 3. Type → switch tab → come back → backspace + new text works
 * 4. Overlay position stays consistent across renders
 * 5. Overlay doesn't shift left during Ink redraws
 * 6. Type → switch → back → rapid backspace+retype
 * 7. Overlay covers flushed canvas text properly
 *
 * Usage: node test/local-echo-basic-test.mjs
 */
import { chromium } from 'playwright';

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = '/tmp/local-echo-basic';

async function createSession(name) {
  const resp = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'claude', name })
  });
  if (!resp.ok) throw new Error(`Failed to create '${name}': ${resp.status}`);
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
    const ov = app._localEchoOverlay;
    const buf = app.terminal?.buffer?.active;
    return {
      visible: ov?.overlay?.style.display !== 'none',
      text: ov?.pendingText || '',
      flushed: ov?._flushedOffset || 0,
      flushedMap: app._flushedOffsets ? Object.fromEntries(app._flushedOffsets) : {},
      enabled: app._localEchoEnabled,
      activeId: app.activeSessionId,
      // Overlay position and content
      overlayLeft: ov?.overlay?.style.left,
      overlayTop: ov?.overlay?.style.top,
      children: (() => {
        if (!ov?.overlay) return [];
        return Array.from(ov.overlay.children).map(c => ({
          text: Array.from(c.querySelectorAll('span')).map(s => s.textContent).join(''),
          left: c.style.left,
          top: c.style.top,
          width: c.style.width,
          bgColor: c.style.backgroundColor,
          spanCount: c.querySelectorAll('span').length,
        }));
      })(),
      // Prompt line from buffer
      promptLine: (() => {
        if (!buf) return null;
        for (let row = app.terminal.rows - 1; row >= 0; row--) {
          const line = buf.getLine(buf.viewportY + row);
          if (!line) continue;
          const text = line.translateToString(true);
          if (text.includes('\u276f')) return { text, row, col: text.lastIndexOf('\u276f') };
        }
        return null;
      })(),
    };
  });
}

async function focus(page) {
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus());
  await page.waitForTimeout(200);
}

async function switchTab(page, id) {
  await page.evaluate((id) => document.querySelector(`.session-tab[data-id="${id}"]`)?.click(), id);
  await page.waitForTimeout(1500);
}

async function waitForPrompt(page, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getState(page);
    if (state?.promptLine) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function sc(page, name) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path });
  console.log(`  📸 ${path}`);
}

const R = [];
const pass = (n) => { R.push({n, s:'PASS'}); console.log(`  ✅ ${n}`); };
const fail = (n, d) => { R.push({n, s:'FAIL', d}); console.log(`  ❌ ${n} — ${d}`); };

async function main() {
  const { mkdirSync } = await import('fs');
  try { mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

  console.log('=== Local Echo — Basic Operation Tests ===\n');

  const sA = await createSession('basic-A');
  const sB = await createSession('basic-B');
  console.log(`  A: ${sA}\n  B: ${sB}`);
  if (!await waitForReady(sA) || !await waitForReady(sB)) {
    await deleteSession(sA); await deleteSession(sB);
    throw new Error('Sessions not ready');
  }
  console.log('  Ready\n');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
    isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();

  // Capture JS errors
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

    // Select tab A, wait for prompt
    await switchTab(page, sA);
    await focus(page);
    if (!await waitForPrompt(page)) throw new Error('No prompt on A');

    // ══════════════════════════════════════════════════════════════
    // TEST 1: Type → switch → back → IMMEDIATE backspace
    // ══════════════════════════════════════════════════════════════
    console.log('--- 1. Type → switch → back → immediate backspace ---');
    await page.keyboard.type('hello world', { delay: 30 });
    await page.waitForTimeout(300);

    let st = await getState(page);
    console.log(`  Typed: text="${st?.text}"`);
    if (st?.text === 'hello world') pass('1a: Text buffered');
    else fail('1a: Text buffered', `"${st?.text}"`);
    await sc(page, '01-typed');

    // Switch to B and back
    await switchTab(page, sB);
    st = await getState(page);
    console.log(`  On B: text="${st?.text}", flushedMap=${JSON.stringify(st?.flushedMap)}`);

    await switchTab(page, sA);
    await focus(page);

    // Check state BEFORE doing anything — flushed offset should be restored
    st = await getState(page);
    console.log(`  Back on A: text="${st?.text}", flushed=${st?.flushed}`);
    if (st?.flushed === 11) pass('1b: Flushed offset restored');
    else fail('1b: Flushed offset', `expected 11, got ${st?.flushed}`);

    // IMMEDIATELY backspace (don't wait for buffer load)
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);

    st = await getState(page);
    console.log(`  After 1 backspace: text="${st?.text}", flushed=${st?.flushed}`);
    if (st?.flushed === 10) pass('1c: Backspace decremented flushed');
    else fail('1c: Backspace', `expected flushed=10, got ${st?.flushed}`);
    await sc(page, '02-after-backspace');

    // Backspace 5 more times
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);

    st = await getState(page);
    console.log(`  After 6 total backspaces: flushed=${st?.flushed}`);
    if (st?.flushed === 5) pass('1d: Multiple backspaces work');
    else fail('1d: Multiple backspaces', `expected flushed=5, got ${st?.flushed}`);

    // Clean up
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════════════════════════
    // TEST 2: Type → switch → back → IMMEDIATE space (don't erase)
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- 2. Type → switch → back → immediate space ---');
    await focus(page);
    await waitForPrompt(page);
    await page.keyboard.type('test input', { delay: 30 });
    await page.waitForTimeout(300);

    // Switch and return
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);

    // Check flushed offset is restored
    st = await getState(page);
    console.log(`  Back on A: flushed=${st?.flushed}`);

    // Type a space immediately
    await page.keyboard.type(' ', { delay: 30 });
    await page.waitForTimeout(300);

    st = await getState(page);
    console.log(`  After space: text="${st?.text}", flushed=${st?.flushed}`);
    console.log(`  Children: ${JSON.stringify(st?.children?.map(c => c.text))}`);
    await sc(page, '03-after-space');

    // The overlay should show the flushed text + space
    if (st?.text === ' ' && st?.flushed > 0) pass('2a: Space typed with flushed offset');
    else fail('2a: Space', `text="${st?.text}", flushed=${st?.flushed}`);

    // The first child should contain the flushed text + space (not just space)
    const child = st?.children?.[0];
    if (child && child.text && child.text.length > 1) {
      pass('2b: Overlay shows flushed text + space (not just space)');
      console.log(`  Overlay text: "${child.text}"`);
    } else {
      fail('2b: Overlay content', `child text="${child?.text}"`);
    }

    // Clean up
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════════════════════════
    // TEST 3: Type → switch → back → backspace some + type new text
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- 3. Type → switch → back → backspace + retype ---');
    await focus(page);
    await waitForPrompt(page);
    await page.keyboard.type('old text here', { delay: 30 });
    await page.waitForTimeout(300);

    // Switch and return
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    await page.waitForTimeout(500); // Small wait for buffer

    // Backspace 4 chars ("here")
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);

    st = await getState(page);
    console.log(`  After 4 backspaces: flushed=${st?.flushed}, text="${st?.text}"`);
    if (st?.flushed === 9) pass('3a: Backspace 4 leaves flushed=9');
    else fail('3a: Backspace count', `expected flushed=9, got ${st?.flushed}`);

    // Now type new text
    await page.keyboard.type('new stuff', { delay: 30 });
    await page.waitForTimeout(300);

    st = await getState(page);
    console.log(`  After retype: text="${st?.text}", flushed=${st?.flushed}`);
    console.log(`  Overlay: ${JSON.stringify(st?.children?.map(c => c.text))}`);
    await sc(page, '04-backspace-retype');

    if (st?.text === 'new stuff') pass('3b: New text after backspace correct');
    else fail('3b: New text', `"${st?.text}"`);

    // Overlay should show flushed chars + new text
    const overlayText3 = st?.children?.[0]?.text || '';
    console.log(`  Full overlay text: "${overlayText3}"`);
    if (overlayText3.endsWith('new stuff') && overlayText3.length > 'new stuff'.length) {
      pass('3c: Overlay combines flushed + new text');
    } else {
      fail('3c: Combined overlay', `"${overlayText3}"`);
    }

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════════════════════════
    // TEST 4: Overlay position consistency
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- 4. Overlay position consistency ---');
    await focus(page);
    await waitForPrompt(page);

    // Type and record position
    await page.keyboard.type('position test', { delay: 30 });
    await page.waitForTimeout(300);

    st = await getState(page);
    const pos1 = {
      overlayLeft: st?.overlayLeft,
      overlayTop: st?.overlayTop,
      childLeft: st?.children?.[0]?.left,
      promptCol: st?.promptLine?.col,
    };
    console.log(`  Initial position: overlay=(${pos1.overlayLeft}, ${pos1.overlayTop}), child left=${pos1.childLeft}, prompt col=${pos1.promptCol}`);
    await sc(page, '05-position-1');

    // Type more text — position should stay stable (left doesn't change)
    await page.keyboard.type('!', { delay: 30 });
    await page.waitForTimeout(300);

    st = await getState(page);
    const pos2 = {
      overlayLeft: st?.overlayLeft,
      overlayTop: st?.overlayTop,
      childLeft: st?.children?.[0]?.left,
      promptCol: st?.promptLine?.col,
    };
    console.log(`  After more text: overlay=(${pos2.overlayLeft}, ${pos2.overlayTop}), child left=${pos2.childLeft}, prompt col=${pos2.promptCol}`);

    if (pos1.overlayLeft === pos2.overlayLeft && pos1.overlayTop === pos2.overlayTop) {
      pass('4a: Overlay container position stable');
    } else {
      fail('4a: Overlay shifted', `${pos1.overlayLeft},${pos1.overlayTop} → ${pos2.overlayLeft},${pos2.overlayTop}`);
    }

    if (pos1.childLeft === pos2.childLeft) {
      pass('4b: Child left position stable');
    } else {
      fail('4b: Child left shifted', `${pos1.childLeft} → ${pos2.childLeft}`);
    }

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════════════════════════
    // TEST 5: Switch → return → type → position matches prompt
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- 5. Position after tab switch ---');
    await focus(page);
    await waitForPrompt(page);

    // Record prompt position
    st = await getState(page);
    const promptCol5 = st?.promptLine?.col;
    console.log(`  Prompt col before: ${promptCol5}`);

    await page.keyboard.type('before switch', { delay: 30 });
    await page.waitForTimeout(300);

    st = await getState(page);
    const beforeLeft = st?.children?.[0]?.left;
    console.log(`  Overlay left before switch: ${beforeLeft}`);
    await sc(page, '06-before-switch');

    // Switch and return
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    await page.waitForTimeout(500);

    // Type something
    await page.keyboard.type(' more', { delay: 30 });
    await page.waitForTimeout(300);

    st = await getState(page);
    const afterLeft = st?.children?.[0]?.left;
    const promptCol5After = st?.promptLine?.col;
    console.log(`  Prompt col after: ${promptCol5After}`);
    console.log(`  Overlay left after switch+type: ${afterLeft}`);
    await sc(page, '07-after-switch-type');

    if (beforeLeft === afterLeft) {
      pass('5a: Overlay position stable after tab switch');
    } else {
      fail('5a: Position shifted after switch', `${beforeLeft} → ${afterLeft}`);
    }

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════════════════════════
    // TEST 6: Rapid backspace-and-retype after return
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- 6. Rapid backspace-and-retype ---');
    await focus(page);
    await waitForPrompt(page);
    await page.keyboard.type('rapid test', { delay: 20 });
    await page.waitForTimeout(200);

    // Switch and return
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);

    // Rapidly: backspace 4, type "done"
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type('done', { delay: 10 });
    await page.waitForTimeout(300);

    st = await getState(page);
    console.log(`  After rapid edit: text="${st?.text}", flushed=${st?.flushed}`);
    await sc(page, '08-rapid-edit');

    if (st?.text === 'done') pass('6a: Rapid backspace+retype text correct');
    else fail('6a: Rapid edit text', `"${st?.text}"`);

    if (st?.flushed === 6) pass('6b: Flushed offset correct after rapid backspace');
    else fail('6b: Flushed offset', `expected 6, got ${st?.flushed}`);

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════════════════════════
    // TEST 7: Overlay background covers canvas text
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- 7. Overlay covers canvas text ---');
    await focus(page);
    await waitForPrompt(page);
    await page.keyboard.type('canvas cover', { delay: 30 });
    await page.waitForTimeout(200);

    // Flush by switching tabs
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    await page.waitForTimeout(500); // Wait for buffer

    // Type a space — overlay should render flushed text + space
    await page.keyboard.type('X', { delay: 30 });
    await page.waitForTimeout(300);

    st = await getState(page);
    const overlayChild = st?.children?.[0];
    console.log(`  Overlay: visible=${st?.visible}, text="${overlayChild?.text}", width=${overlayChild?.width}, bg=${overlayChild?.bgColor}`);
    await sc(page, '09-canvas-cover');

    if (st?.visible && overlayChild?.text?.includes('canvas cover')) {
      pass('7a: Overlay contains flushed text');
    } else {
      fail('7a: Flushed text in overlay', `"${overlayChild?.text}"`);
    }

    if (overlayChild?.bgColor) {
      pass('7b: Overlay has background color');
    } else {
      fail('7b: No background color', `bg="${overlayChild?.bgColor}"`);
    }

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════════════════════════
    // TEST 8: Backspace ALL flushed text back to zero
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- 8. Full backspace through flushed text ---');
    await focus(page);
    await waitForPrompt(page);
    await page.keyboard.type('abcde', { delay: 20 });
    await page.waitForTimeout(200);

    // Flush
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);

    st = await getState(page);
    console.log(`  Flushed: ${st?.flushed}`);

    // Backspace ALL 5 chars + 2 extra (should be no-ops)
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(300);

    st = await getState(page);
    console.log(`  After full backspace: flushed=${st?.flushed}, text="${st?.text}", visible=${st?.visible}`);
    await sc(page, '10-full-backspace');

    if (st?.flushed === 0) pass('8a: Flushed offset back to 0');
    else fail('8a: Flushed not zero', `${st?.flushed}`);

    if (!st?.text && !st?.visible) pass('8b: Overlay hidden after full backspace');
    else fail('8b: Overlay state', `text="${st?.text}", visible=${st?.visible}`);

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════════════════════════
    // TEST 9: Fresh type after full backspace
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- 9. Type fresh after full backspace ---');
    await focus(page);
    await waitForPrompt(page);
    await page.keyboard.type('delete me', { delay: 20 });
    await page.waitForTimeout(200);

    // Flush
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);

    // Delete all
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(200);

    // Now type fresh text
    await page.keyboard.type('brand new', { delay: 30 });
    await page.waitForTimeout(300);

    st = await getState(page);
    console.log(`  Fresh type: text="${st?.text}", flushed=${st?.flushed}, visible=${st?.visible}`);
    await sc(page, '11-fresh-type');

    if (st?.text === 'brand new' && st?.flushed === 0) {
      pass('9a: Clean fresh text after full delete');
    } else {
      fail('9a: Fresh text', `text="${st?.text}", flushed=${st?.flushed}`);
    }

    if (st?.visible) pass('9b: Overlay visible with fresh text');
    else fail('9b: Overlay not visible');

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════════════════════════
    // JS ERRORS
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- JS Errors ---');
    if (jsErrors.length === 0) {
      pass('No JS errors');
    } else {
      for (const err of jsErrors) {
        fail('JS Error', err.slice(0, 120));
      }
    }

    await sc(page, '12-final');

    // ══════════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════════
    console.log('\n=== SUMMARY ===');
    const passes = R.filter(r => r.s === 'PASS').length;
    const fails = R.filter(r => r.s === 'FAIL').length;
    console.log(`  ${passes} passed, ${fails} failed`);

    if (fails > 0) {
      console.log('\n  FAILURES:');
      R.filter(r => r.s === 'FAIL').forEach(r => console.log(`    ❌ ${r.n}: ${r.d}`));
    }

  } finally {
    await browser.close();
    console.log('\nCleaning up...');
    await deleteSession(sA);
    await deleteSession(sB);
  }
}

main().catch(err => { console.error('Test failed:', err); process.exit(1); });
