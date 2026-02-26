/**
 * Local Echo Overlay — Daily use scenarios test.
 *
 * Simulates real mobile usage:
 * 1. Type text → switch tabs → switch back → verify state
 * 2. Type → change mind → delete all → type something else
 * 3. Type → reload page → verify recovery
 * 4. Rapidly type-delete-type (simulate editing)
 * 5. Type on Tab A → switch B → type on B → switch A → verify both
 * 6. Type → Enter → wait for response → type again
 * 7. Partial delete then add more text
 *
 * Usage: node test/local-echo-daily-test.mjs
 */
import { chromium } from 'playwright';

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = '/tmp/local-echo-daily';

async function createSession(name) {
  const resp = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'claude', name })
  });
  if (!resp.ok) throw new Error(`Failed: ${resp.status}`);
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
    return {
      visible: ov?.overlay?.style.display !== 'none',
      text: ov?.pendingText || '',
      flushed: ov?._flushedOffset || 0,
      flushedMap: app._flushedOffsets ? Object.fromEntries(app._flushedOffsets) : {},
      enabled: app._localEchoEnabled,
      activeId: app.activeSessionId,
      children: (() => {
        if (!ov?.overlay) return [];
        return Array.from(ov.overlay.children).map(c => ({
          text: Array.from(c.querySelectorAll('span')).map(s => s.textContent).join(''),
          left: c.style.left, top: c.style.top,
        }));
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

async function sc(page, name) {
  const p = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path: p });
  console.log(`  📸 ${p}`);
}

const R = [];
const pass = (n) => { R.push({n, s:'PASS'}); console.log(`  ✅ ${n}`); };
const fail = (n, d) => { R.push({n, s:'FAIL', d}); console.log(`  ❌ ${n} — ${d}`); };
const info = (n, d) => { R.push({n, s:'INFO', d}); console.log(`  ℹ️  ${n} — ${d}`); };

async function main() {
  const { mkdirSync } = await import('fs');
  try { mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

  console.log('=== Local Echo — Daily Use Tests ===\n');

  const sA = await createSession('daily-A');
  const sB = await createSession('daily-B');
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

    await switchTab(page, sA);
    await focus(page);

    // ══════════════════════════════════════════
    // 1. Type → switch tab → switch back
    // ══════════════════════════════════════════
    console.log('--- 1. Type → Tab switch → Return ---');
    await page.keyboard.type('fix the login bug', { delay: 40 });
    await page.waitForTimeout(300);
    let st = await getState(page);
    await sc(page, '01-typed');
    console.log(`  Typed: "${st?.text}"`);

    if (st?.text === 'fix the login bug') pass('Text buffered');
    else fail('Buffer', `"${st?.text}"`);

    // Switch to B
    await switchTab(page, sB);
    st = await getState(page);
    console.log(`  After switch to B: text="${st?.text}", flushed A=${st?.flushedMap?.[sA]}`);
    await sc(page, '02-on-tab-b');

    if (!st?.text) pass('Overlay cleared on switch');
    else fail('Clear on switch', `"${st?.text}"`);

    // Switch back to A
    await switchTab(page, sA);
    await focus(page);
    st = await getState(page);
    await sc(page, '03-back-on-a');
    console.log(`  Back on A: text="${st?.text}", flushed=${st?.flushed}`);

    if (!st?.text && st?.flushed > 0) pass('Flushed text preserved on return');
    else info('Return state', `text="${st?.text}", flushed=${st?.flushed}`);

    // Type more
    await page.keyboard.type(' please', { delay: 40 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, '04-type-more-on-a');
    console.log(`  After adding: text="${st?.text}", flushed=${st?.flushed}`);

    if (st?.text === ' please' && st?.flushed > 0) pass('Can type after return with flushed offset');
    else fail('Type after return', `text="${st?.text}", flushed=${st?.flushed}`);

    // Submit
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // ══════════════════════════════════════════
    // 2. Type → delete all → retype
    // ══════════════════════════════════════════
    console.log('\n--- 2. Type → delete all → retype ---');
    await focus(page);
    await page.keyboard.type('wrong command oops', { delay: 30 });
    await page.waitForTimeout(200);
    st = await getState(page);
    console.log(`  Typed wrong: "${st?.text}"`);

    // Delete all
    for (let i = 0; i < 'wrong command oops'.length + 2; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(200);

    st = await getState(page);
    console.log(`  After delete: text="${st?.text}", visible=${st?.visible}`);
    if (!st?.text && !st?.visible) pass('Fully deleted');
    else fail('Full delete', `"${st?.text}"`);

    // Retype correct command
    await page.keyboard.type('say hello', { delay: 40 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, '05-retyped');
    console.log(`  Retyped: "${st?.text}"`);

    if (st?.text === 'say hello' && st?.visible) pass('Retype after delete works');
    else fail('Retype', `"${st?.text}", visible=${st?.visible}`);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // ══════════════════════════════════════════
    // 3. Type → reload page → check recovery
    // ══════════════════════════════════════════
    console.log('\n--- 3. Type → reload page → recovery ---');
    await focus(page);
    await page.keyboard.type('unsent text before reload', { delay: 30 });
    await page.waitForTimeout(300);
    st = await getState(page);
    console.log(`  Before reload: "${st?.text}"`);
    await sc(page, '06-before-reload');

    // Reload the page
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForTimeout(3000); // Wait for SSE reconnect + buffer load

    st = await getState(page);
    await sc(page, '07-after-reload');
    console.log(`  After reload: text="${st?.text}", enabled=${st?.enabled}`);

    // localStorage persistence was removed — stale text from previous page
    // loads caused ghost-merging with new input, breaking editing.
    // After reload, overlay should be clean (no stale text).
    if (st?.text === '') {
      pass('Overlay clean after reload (no stale text)');
    } else {
      fail('Stale text after reload', `text="${st?.text}"`);
    }

    // ══════════════════════════════════════════
    // 4. Rapid type-delete-type (simulate editing)
    // ══════════════════════════════════════════
    console.log('\n--- 4. Rapid type-delete-type editing ---');
    await focus(page);

    // Type "hello", delete "lo", type "p me"
    await page.keyboard.type('hello', { delay: 20 });
    await page.waitForTimeout(100);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    await page.keyboard.type('p me', { delay: 20 });
    await page.waitForTimeout(300);

    st = await getState(page);
    await sc(page, '08-rapid-edit');
    console.log(`  After rapid edit: "${st?.text}"`);

    if (st?.text === 'help me') pass('Rapid edit produces correct text');
    else fail('Rapid edit', `expected "help me", got "${st?.text}"`);

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════
    // 5. Interleaved typing on two tabs
    // ══════════════════════════════════════════
    console.log('\n--- 5. Interleaved typing on two tabs ---');
    await focus(page);
    await page.keyboard.type('tab A input', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, '09-tab-a-input');

    st = await getState(page);
    console.log(`  Tab A: "${st?.text}"`);
    if (st?.text === 'tab A input') pass('Tab A text correct');
    else fail('Tab A text', `"${st?.text}"`);

    // Switch to B and type
    await switchTab(page, sB);
    await focus(page);
    await page.keyboard.type('tab B input', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, '10-tab-b-input');

    st = await getState(page);
    console.log(`  Tab B: "${st?.text}"`);
    if (st?.text === 'tab B input') pass('Tab B text correct');
    else fail('Tab B text', `"${st?.text}"`);

    // Switch back to A — A's text was flushed
    await switchTab(page, sA);
    await focus(page);
    st = await getState(page);
    await sc(page, '11-back-to-a');
    console.log(`  Back to A: text="${st?.text}", flushed=${st?.flushed}, flushedMap A=${st?.flushedMap?.[sA]}, B=${st?.flushedMap?.[sB]}`);

    // A's input was flushed (11 chars), B's was flushed (11 chars)
    if (st?.flushed > 0) pass('Tab A flushed offset restored');
    else info('Tab A flushed', `offset=${st?.flushed}`);

    // Switch to B — B's input was flushed
    await switchTab(page, sB);
    await focus(page);
    st = await getState(page);
    await sc(page, '12-back-to-b');
    console.log(`  Back to B: text="${st?.text}", flushed=${st?.flushed}`);

    if (st?.flushed > 0) pass('Tab B flushed offset restored');
    else info('Tab B flushed', `offset=${st?.flushed}`);

    // Submit both with Enter
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    await switchTab(page, sA);
    await focus(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    // ══════════════════════════════════════════
    // 6. Type → Enter → response → type again
    // ══════════════════════════════════════════
    console.log('\n--- 6. Type → Enter → wait → type again ---');
    await focus(page);
    await page.keyboard.type('just say ok', { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000); // Wait for response

    await focus(page);
    await page.keyboard.type('now say goodbye', { delay: 30 });
    await page.waitForTimeout(300);

    st = await getState(page);
    await sc(page, '13-second-prompt');
    console.log(`  Second prompt: "${st?.text}", flushed=${st?.flushed}`);

    if (st?.text === 'now say goodbye' && st?.flushed === 0) {
      pass('Clean typing on new prompt after response');
    } else {
      fail('Second prompt', `text="${st?.text}", flushed=${st?.flushed}`);
    }

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // ══════════════════════════════════════════
    // 7. Partial delete then add text
    // ══════════════════════════════════════════
    console.log('\n--- 7. Partial delete + add ---');
    await focus(page);
    await page.keyboard.type('fixing the bug', { delay: 30 });
    await page.waitForTimeout(200);

    // Delete "bug" (3 chars), keeping the space
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);

    // Add "typo"
    await page.keyboard.type('typo', { delay: 30 });
    await page.waitForTimeout(300);

    st = await getState(page);
    await sc(page, '14-partial-edit');
    console.log(`  After partial edit: "${st?.text}"`);

    if (st?.text === 'fixing the typo') pass('Partial delete + add correct');
    else fail('Partial edit', `expected "fixing the typo", got "${st?.text}"`);

    // Final
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(300);
    await sc(page, '15-final');

    // ══════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════
    console.log('\n=== SUMMARY ===');
    const p = R.filter(r => r.s === 'PASS').length;
    const f = R.filter(r => r.s === 'FAIL').length;
    const i = R.filter(r => r.s === 'INFO').length;
    console.log(`  ${p} passed, ${f} failed, ${i} info`);

    if (f > 0) {
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
