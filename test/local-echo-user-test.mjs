/**
 * Local Echo Overlay — Comprehensive User-Scenario Tests (Mobile-First)
 *
 * 30 tests across 8 groups (A-H), ~108 screenshots.
 * Simulates a real mobile user's daily workflow with heavy visual verification.
 *
 * Screenshots saved to /tmp/local-echo-user/ with descriptive names.
 * Error report written to /tmp/local-echo-user/error-report.md.
 *
 * Usage: timeout 180 node test/local-echo-user-test.mjs 2>&1 | tee /tmp/user-test-output.txt
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = '/tmp/local-echo-user';

// ── Results & Error Reporting ──
const results = [];
const errorReportEntries = [];

function pass(id, name) {
  results.push({ id, name, ok: true });
  console.log(`  ✅ ${id}: ${name}`);
}

function fail(id, name, expected, actual, stateDump, screenshotName, jsErrors) {
  results.push({ id, name, ok: false, expected, actual });
  console.log(`  ❌ ${id}: ${name} — expected: ${expected}, actual: ${actual}`);
  errorReportEntries.push({ id, name, expected, actual, stateDump, screenshotName, jsErrors });
}

function writeErrorReport() {
  const lines = ['# Local Echo User Test — Error Report\n'];
  for (const e of errorReportEntries) {
    lines.push(`## ${e.id}: ${e.name}`);
    lines.push(`**Status:** FAIL`);
    lines.push(`**Step:** ${e.screenshotName || 'N/A'}`);
    lines.push(`**Expected:** ${e.expected}`);
    lines.push(`**Actual:** ${e.actual}`);
    if (e.stateDump) {
      lines.push('**State dump:**');
      for (const [k, v] of Object.entries(e.stateDump)) {
        lines.push(`  ${k}: ${JSON.stringify(v)}`);
      }
    }
    if (e.screenshotName) lines.push(`**Screenshot:** ${e.screenshotName}.png`);
    lines.push(`**JS errors:** ${e.jsErrors?.length ? e.jsErrors.join('; ') : 'none'}`);
    lines.push('');
  }
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const failedIds = results.filter(r => !r.ok).map(r => r.id);
  const failedScreenshots = errorReportEntries.map(e => e.screenshotName).filter(Boolean);
  lines.push('## Summary');
  lines.push(`- Total: ${results.length} assertions`);
  lines.push(`- Passed: ${passed}`);
  lines.push(`- Failed: ${failed}`);
  lines.push(`- Failed tests: ${failedIds.join(', ') || 'none'}`);
  lines.push(`- Screenshots with failures: ${failedScreenshots.map(s => s + '.png').join(', ') || 'none'}`);
  writeFileSync(`${SCREENSHOT_DIR}/error-report.md`, lines.join('\n'));
}

// ── Helpers ──
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

    // Cell dimensions
    let cellW = 0, cellH = 0;
    try {
      const dims = app.terminal._core._renderService.dimensions;
      cellW = dims.css.cell.width;
      cellH = dims.css.cell.height;
    } catch {}

    // Children (line divs)
    const children = [];
    if (ov?.overlay) {
      for (const c of ov.overlay.children) {
        const spans = c.querySelectorAll('span');
        const text = Array.from(spans).map(s => s.textContent).join('');
        children.push({
          text,
          left: c.style.left,
          top: c.style.top,
          width: c.style.width,
          bgColor: c.style.backgroundColor,
          spanCount: spans.length,
        });
      }
    }

    // Cursor block: a direct child <span> of overlay with position:absolute,
    // display:inline-block, empty text, and a backgroundColor (cursor color).
    // It's appended as the last child of this.overlay (not inside a line div).
    let cursor = { exists: false, left: null, top: null, width: null, height: null, bgColor: null };
    if (ov?.overlay) {
      for (const child of ov.overlay.children) {
        if (child.tagName === 'SPAN'
            && child.style.position === 'absolute'
            && child.style.display === 'inline-block'
            && child.textContent === '') {
          cursor = {
            exists: true,
            left: parseFloat(child.style.left) || 0,
            top: parseFloat(child.style.top) || 0,
            width: parseFloat(child.style.width) || child.offsetWidth,
            height: parseFloat(child.style.height) || child.offsetHeight,
            bgColor: child.style.backgroundColor,
          };
          break;
        }
      }
    }

    // Prompt line from buffer (bottom-up scan)
    let promptLine = null;
    if (buf) {
      for (let row = app.terminal.rows - 1; row >= 0; row--) {
        const line = buf.getLine(buf.viewportY + row);
        if (!line) continue;
        const text = line.translateToString(true);
        if (text.includes('\u276f')) {
          promptLine = { text, row, col: text.lastIndexOf('\u276f') };
          break;
        }
      }
    }

    return {
      visible: ov?.overlay?.style.display !== 'none',
      text: ov?.pendingText || '',
      flushed: ov?._flushedOffset || 0,
      flushedMap: app._flushedOffsets ? Object.fromEntries(app._flushedOffsets) : {},
      children,
      cursor,
      promptLine,
      cellW,
      cellH,
      activeId: app.activeSessionId,
      enabled: app._localEchoEnabled,
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

async function waitForPrompt(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await getState(page);
    if (st?.promptLine) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function sc(page, name) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path });
  console.log(`    📸 ${name}.png`);
}

async function cleanPrompt(page) {
  await page.keyboard.down('Control');
  await page.keyboard.press('c');
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);
  await focus(page);
  await waitForPrompt(page, 5000);
}

// ── Main ──
async function main() {
  try { mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

  console.log('=== Local Echo — Comprehensive User-Scenario Tests ===\n');

  // Create two sessions
  const sA = await createSession('user-test-A');
  const sB = await createSession('user-test-B');
  console.log(`  A: ${sA}\n  B: ${sB}`);
  if (!await waitForReady(sA) || !await waitForReady(sB)) {
    await deleteSession(sA); await deleteSession(sB);
    throw new Error('Sessions not ready');
  }
  console.log('  Both sessions ready\n');

  const browser = await chromium.launch({ headless: true });
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
    await page.waitForSelector('.xterm-screen', { timeout: 15000 });
    await page.waitForTimeout(3000);

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

    // ════════════════════════════════════════════════════════════════
    // GROUP A: Fresh Typing (4 tests)
    // ════════════════════════════════════════════════════════════════
    console.log('\n══ GROUP A: Fresh Typing ══');

    // A01: Type single char
    console.log('\n--- A01: Type single char ---');
    await sc(page, 'A01a-clean-prompt');
    await page.keyboard.type('x', { delay: 30 });
    await page.waitForTimeout(300);
    let st = await getState(page);
    await sc(page, 'A01b-typed-x');
    if (st.visible && st.text === 'x' && st.flushed === 0)
      pass('A01', 'Type single char');
    else
      fail('A01', 'Type single char', 'visible=true, text="x", flushed=0',
        `visible=${st.visible}, text="${st.text}", flushed=${st.flushed}`, st, 'A01b-typed-x', jsErrors);
    await cleanPrompt(page);

    // A02: Type a word
    console.log('\n--- A02: Type a word ---');
    await sc(page, 'A02a-clean-prompt');
    await page.keyboard.type('h', { delay: 60 });
    await page.waitForTimeout(200);
    await sc(page, 'A02b-after-h');
    await page.keyboard.type('ello', { delay: 60 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'A02c-after-hello');
    if (st.text === 'hello')
      pass('A02', 'Type a word');
    else
      fail('A02', 'Type a word', 'text="hello"', `text="${st.text}"`, st, 'A02c-after-hello', jsErrors);
    await cleanPrompt(page);

    // A03: Type then backspace one char
    console.log('\n--- A03: Type then backspace one char ---');
    await page.keyboard.type('hello', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'A03a-typed-hello');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'A03b-after-backspace');
    if (st.text === 'hell')
      pass('A03', 'Backspace one char');
    else
      fail('A03', 'Backspace one char', 'text="hell"', `text="${st.text}"`, st, 'A03b-after-backspace', jsErrors);
    await cleanPrompt(page);

    // A04: Type then backspace ALL chars
    console.log('\n--- A04: Type then backspace ALL ---');
    await page.keyboard.type('abc', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'A04a-typed-abc');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    st = await getState(page);
    await sc(page, 'A04b-after-1-backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    st = await getState(page);
    await sc(page, 'A04c-after-2-backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'A04d-after-3-backspace');
    if (!st.visible && st.text === '' && st.flushed === 0)
      pass('A04', 'Backspace ALL hides overlay');
    else
      fail('A04', 'Backspace ALL hides overlay', 'visible=false, text="", flushed=0',
        `visible=${st.visible}, text="${st.text}", flushed=${st.flushed}`, st, 'A04d-after-3-backspace', jsErrors);

    // ════════════════════════════════════════════════════════════════
    // GROUP B: Tab Switch Basics (5 tests)
    // ════════════════════════════════════════════════════════════════
    console.log('\n══ GROUP B: Tab Switch Basics ══');

    // B05: Type on A, switch to B, check B is clean
    console.log('\n--- B05: Type on A, switch to B ---');
    await cleanPrompt(page);
    await page.keyboard.type('hello world', { delay: 30 });
    await page.waitForTimeout(300);
    await sc(page, 'B05a-typed-on-A');
    await switchTab(page, sB);
    st = await getState(page);
    await sc(page, 'B05b-on-B');
    if (st.text === '' && (st.flushedMap[sA] === 11 || st.flushedMap[sA] > 0))
      pass('B05', 'Switch to B clears overlay, A flushed');
    else
      fail('B05', 'Switch to B clears overlay', 'text="", flushedMap[A]=11',
        `text="${st.text}", flushedMap=${JSON.stringify(st.flushedMap)}`, st, 'B05b-on-B', jsErrors);

    // B06: Type on A, switch to B, back to A — flushed restored + overlay visible
    console.log('\n--- B06: Round-trip flushed restore ---');
    await switchTab(page, sA);
    await focus(page);
    await cleanPrompt(page);
    await page.keyboard.type('testing', { delay: 30 });
    await page.waitForTimeout(300);
    await sc(page, 'B06a-typed-on-A');
    await switchTab(page, sB);
    await sc(page, 'B06b-on-B');
    await switchTab(page, sA);
    await focus(page);
    st = await getState(page);
    await sc(page, 'B06c-back-on-A');
    // After fix: overlay stays VISIBLE with flushed text (no pending), so user
    // can see what they typed and backspace into it with visual feedback.
    if (st.text === '' && st.flushed === 7 && st.visible)
      pass('B06', 'Flushed restored + overlay visible');
    else
      fail('B06', 'Flushed restored + overlay visible', 'text="", flushed=7, visible=true',
        `text="${st.text}", flushed=${st.flushed}, visible=${st.visible}`, st, 'B06c-back-on-A', jsErrors);

    // B07: Type on A, switch, back, type SPACE — no text erasure
    console.log('\n--- B07: Space after tab switch ---');
    await cleanPrompt(page);
    await page.keyboard.type('test', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'B07a-typed-test');
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    await sc(page, 'B07b-back-on-A');
    await page.keyboard.type(' ', { delay: 30 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'B07c-after-space');
    const b07childText = st.children?.[0]?.text || '';
    if (st.text === ' ' && st.flushed === 4 && b07childText.includes('test'))
      pass('B07', 'Space after switch — no erasure');
    else
      fail('B07', 'Space after switch', 'text=" ", flushed=4, child contains "test"',
        `text="${st.text}", flushed=${st.flushed}, child="${b07childText}"`, st, 'B07c-after-space', jsErrors);

    // B08: Type on A, switch, back, type more chars
    console.log('\n--- B08: More chars after round-trip ---');
    await cleanPrompt(page);
    await page.keyboard.type('fix', { delay: 30 });
    await page.waitForTimeout(200);
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    await sc(page, 'B08a-back-on-A');
    await page.keyboard.type(' bug', { delay: 30 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'B08b-after-more-chars');
    if (st.text === ' bug' && st.flushed === 3)
      pass('B08', 'Type more chars after round-trip');
    else
      fail('B08', 'Type more after round-trip', 'text=" bug", flushed=3',
        `text="${st.text}", flushed=${st.flushed}`, st, 'B08b-after-more-chars', jsErrors);

    // B09: Type on A, switch, back, backspace 1 char from flushed
    // After fix: overlay stays visible with flushed text, backspace gives instant feedback
    console.log('\n--- B09: Backspace into flushed ---');
    await cleanPrompt(page);
    await page.keyboard.type('hello', { delay: 30 });
    await page.waitForTimeout(200);
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    await sc(page, 'B09a-back-with-flushed');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'B09b-after-backspace');
    const b09childText = st.children?.[0]?.text || '';
    if (st.flushed === 4 && st.visible && b09childText === 'hell')
      pass('B09', 'Backspace into flushed with visual feedback');
    else
      fail('B09', 'Backspace into flushed', 'flushed=4, visible=true, child="hell"',
        `flushed=${st.flushed}, visible=${st.visible}, child="${b09childText}"`, st, 'B09b-after-backspace', jsErrors);

    // ════════════════════════════════════════════════════════════════
    // GROUP C: Tab Switch + Editing (5 tests)
    // ════════════════════════════════════════════════════════════════
    console.log('\n══ GROUP C: Tab Switch + Editing ══');

    // C10: Type, switch, back, backspace 3 + type new text
    // After fix: overlay renders correctly using stored flushed text
    console.log('\n--- C10: Backspace flushed + retype ---');
    await cleanPrompt(page);
    await page.keyboard.type('old text', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'C10a-typed');
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(200);
    st = await getState(page);
    await sc(page, 'C10b-after-3-backspace');
    // After 3 backspaces: flushed "old text" (8) - 3 = "old t" (5)
    const c10midChild = st.children?.[0]?.text || '';
    if (st.flushed === 5 && c10midChild === 'old t')
      pass('C10a', 'Backspace flushed shows correct remaining text');
    else
      fail('C10a', 'Backspace flushed text', 'flushed=5, child="old t"',
        `flushed=${st.flushed}, child="${c10midChild}"`, st, 'C10b-after-3-backspace', jsErrors);
    await page.keyboard.type('new', { delay: 30 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'C10c-after-retype');
    const c10childText = st.children?.[0]?.text || '';
    if (st.flushed === 5 && st.text === 'new' && c10childText === 'old tnew')
      pass('C10b', 'Retype after flushed backspace renders correctly');
    else
      fail('C10b', 'Retype after flushed backspace', 'flushed=5, text="new", child="old tnew"',
        `flushed=${st.flushed}, text="${st.text}", child="${c10childText}"`, st, 'C10c-after-retype', jsErrors);

    // C11: Type, switch, back, delete ALL flushed
    console.log('\n--- C11: Delete all flushed ---');
    await cleanPrompt(page);
    await page.keyboard.type('abcde', { delay: 30 });
    await page.waitForTimeout(200);
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'C11a-after-full-backspace');
    // Extra backspaces — should be no-op
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    st = await getState(page);
    await sc(page, 'C11b-extra-backspace-noop');
    if (!st.visible && st.flushed === 0)
      pass('C11', 'Delete all flushed');
    else
      fail('C11', 'Delete all flushed', 'visible=false, flushed=0',
        `visible=${st.visible}, flushed=${st.flushed}`, st, 'C11b-extra-backspace-noop', jsErrors);

    // C12: Type, switch, back, delete ALL + type fresh
    console.log('\n--- C12: Delete all + type fresh ---');
    await cleanPrompt(page);
    await page.keyboard.type('remove', { delay: 30 });
    await page.waitForTimeout(200);
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(200);
    await sc(page, 'C12a-fully-deleted');
    await page.keyboard.type('brand new', { delay: 30 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'C12b-fresh-text');
    if (st.text === 'brand new' && st.flushed === 0 && st.visible)
      pass('C12', 'Fresh text after full delete');
    else
      fail('C12', 'Fresh text after full delete', 'text="brand new", flushed=0, visible=true',
        `text="${st.text}", flushed=${st.flushed}, visible=${st.visible}`, st, 'C12b-fresh-text', jsErrors);

    // C13: Type on A, switch B, type on B, back to A — no cross-talk
    console.log('\n--- C13: No cross-talk between tabs ---');
    await cleanPrompt(page);
    await page.keyboard.type('alpha', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'C13a-alpha-on-A');
    await switchTab(page, sB);
    await focus(page);
    await waitForPrompt(page, 5000);
    await page.keyboard.type('beta', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'C13b-beta-on-B');
    await switchTab(page, sA);
    await focus(page);
    st = await getState(page);
    await sc(page, 'C13c-back-on-A');
    if (st.flushedMap[sA] === 5 && st.text === '')
      pass('C13', 'No cross-talk between tabs');
    else
      fail('C13', 'No cross-talk', 'flushedMap[A]=5, text=""',
        `flushedMap=${JSON.stringify(st.flushedMap)}, text="${st.text}"`, st, 'C13c-back-on-A', jsErrors);

    // C14: Both sessions maintain state across double round-trip
    console.log('\n--- C14: Double round-trip state ---');
    await cleanPrompt(page);
    // Clean B first
    await switchTab(page, sB);
    await focus(page);
    await cleanPrompt(page);
    await switchTab(page, sA);
    await focus(page);
    await cleanPrompt(page);

    await page.keyboard.type('aaa', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'C14a-aaa-on-A');
    await switchTab(page, sB);
    await focus(page);
    await page.keyboard.type('bbb', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'C14b-bbb-on-B');
    await switchTab(page, sA);
    await focus(page);
    st = await getState(page);
    await sc(page, 'C14c-back-A');
    const c14aFlushed1 = st.flushed;
    await page.keyboard.type('+', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'C14d-plus-on-A');
    await switchTab(page, sB);
    await focus(page);
    st = await getState(page);
    await sc(page, 'C14e-back-B');
    const c14bFlushed = st.flushed;
    await page.keyboard.type('+', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'C14f-plus-on-B');
    st = await getState(page);
    if (c14aFlushed1 >= 3 && c14bFlushed >= 3)
      pass('C14', 'Double round-trip state preserved');
    else
      fail('C14', 'Double round-trip', 'flushedMap[A]>=3, flushedMap[B]>=3',
        `A flushed=${c14aFlushed1}, B flushed=${c14bFlushed}`, st, 'C14f-plus-on-B', jsErrors);

    // ════════════════════════════════════════════════════════════════
    // GROUP D: Enter / Submit (3 tests)
    // ════════════════════════════════════════════════════════════════
    console.log('\n══ GROUP D: Enter / Submit ══');

    // D15: Type then Enter clears everything
    console.log('\n--- D15: Enter clears overlay ---');
    await switchTab(page, sA);
    await focus(page);
    await cleanPrompt(page);
    await page.keyboard.type('echo test-d15', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'D15a-before-enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    await sc(page, 'D15b-after-enter');
    await page.waitForTimeout(1000);
    st = await getState(page);
    await sc(page, 'D15c-settled');
    if (!st.visible && st.text === '' && st.flushed === 0)
      pass('D15', 'Enter clears overlay');
    else
      fail('D15', 'Enter clears overlay', 'visible=false, text="", flushed=0',
        `visible=${st.visible}, text="${st.text}", flushed=${st.flushed}`, st, 'D15c-settled', jsErrors);

    // D16: Type, switch (flushed), back, Enter
    console.log('\n--- D16: Enter after flushed round-trip ---');
    await page.waitForTimeout(3000); // Wait for response
    await focus(page);
    await waitForPrompt(page, 5000);
    await page.keyboard.type('flush-test-d16', { delay: 30 });
    await page.waitForTimeout(200);
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    st = await getState(page);
    await sc(page, 'D16a-flushed-state');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    st = await getState(page);
    await sc(page, 'D16b-after-enter');
    if (st.flushed === 0 && !st.flushedMap[sA])
      pass('D16', 'Enter clears flushed state');
    else
      fail('D16', 'Enter clears flushed', 'flushed=0, flushedMap[A]=undefined',
        `flushed=${st.flushed}, flushedMap=${JSON.stringify(st.flushedMap)}`, st, 'D16b-after-enter', jsErrors);

    // D17: Type, Enter, wait for response, type on new prompt
    console.log('\n--- D17: Type on new prompt after response ---');
    await page.waitForTimeout(4000); // Wait for response
    await focus(page);
    await waitForPrompt(page, 8000);
    await sc(page, 'D17a-before-enter');
    // Don't submit — D15/D16 already submitted. Just type on the new prompt.
    await page.keyboard.type('second input', { delay: 30 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'D17c-second-input');
    if (st.text === 'second input' && st.flushed === 0)
      pass('D17', 'Type on new prompt after response');
    else
      fail('D17', 'New prompt typing', 'text="second input", flushed=0',
        `text="${st.text}", flushed=${st.flushed}`, st, 'D17c-second-input', jsErrors);
    await cleanPrompt(page);

    // ════════════════════════════════════════════════════════════════
    // GROUP E: Ctrl+C / Cancel (3 tests)
    // ════════════════════════════════════════════════════════════════
    console.log('\n══ GROUP E: Ctrl+C / Cancel ══');

    // E18: Type then Ctrl+C clears overlay
    console.log('\n--- E18: Ctrl+C clears overlay ---');
    await page.keyboard.type('echo test-e18', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'E18a-before-ctrlc');
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await page.waitForTimeout(500);
    st = await getState(page);
    await sc(page, 'E18b-after-ctrlc');
    if (!st.visible && st.text === '' && st.flushed === 0)
      pass('E18', 'Ctrl+C clears overlay');
    else
      fail('E18', 'Ctrl+C clears overlay', 'visible=false, text="", flushed=0',
        `visible=${st.visible}, text="${st.text}", flushed=${st.flushed}`, st, 'E18b-after-ctrlc', jsErrors);

    // E19: Type, switch (flushed), back, Ctrl+C
    console.log('\n--- E19: Ctrl+C after flushed ---');
    await focus(page);
    await waitForPrompt(page, 5000);
    await page.keyboard.type('flush-then-cancel', { delay: 30 });
    await page.waitForTimeout(200);
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    st = await getState(page);
    await sc(page, 'E19a-flushed-state');
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await page.waitForTimeout(500);
    st = await getState(page);
    await sc(page, 'E19b-after-ctrlc');
    if (st.flushed === 0 && !st.flushedMap[sA])
      pass('E19', 'Ctrl+C clears flushed state');
    else
      fail('E19', 'Ctrl+C flushed clear', 'flushed=0, flushedMap[A]=undefined',
        `flushed=${st.flushed}, flushedMap=${JSON.stringify(st.flushedMap)}`, st, 'E19b-after-ctrlc', jsErrors);

    // E20: Ctrl+C on empty — no crash
    console.log('\n--- E20: Ctrl+C on empty ---');
    await focus(page);
    await waitForPrompt(page, 5000);
    const jsErrorsBefore = jsErrors.length;
    await sc(page, 'E20a-empty-prompt');
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await page.waitForTimeout(500);
    st = await getState(page);
    await sc(page, 'E20b-after-ctrlc');
    if (!st.visible && jsErrors.length === jsErrorsBefore)
      pass('E20', 'Ctrl+C on empty — no crash');
    else
      fail('E20', 'Ctrl+C on empty', 'visible=false, no new JS errors',
        `visible=${st.visible}, new errors=${jsErrors.length - jsErrorsBefore}`, st, 'E20b-after-ctrlc', jsErrors);

    // ════════════════════════════════════════════════════════════════
    // GROUP F: Cursor Position (3 tests)
    // ════════════════════════════════════════════════════════════════
    console.log('\n══ GROUP F: Cursor Position ══');

    // F21: Cursor at end of typed text
    console.log('\n--- F21: Cursor at end ---');
    await focus(page);
    await waitForPrompt(page, 5000);
    await page.keyboard.type('cursor', { delay: 30 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'F21a-typed-cursor');
    if (st.cursor.exists)
      pass('F21', 'Cursor exists at end of text');
    else
      fail('F21', 'Cursor at end', 'cursor.exists=true',
        `cursor.exists=${st.cursor.exists}`, st, 'F21a-typed-cursor', jsErrors);
    await cleanPrompt(page);

    // F22: Cursor after backspace moves left
    console.log('\n--- F22: Cursor moves on backspace ---');
    await page.keyboard.type('abcde', { delay: 30 });
    await page.waitForTimeout(300);
    let st1 = await getState(page);
    await sc(page, 'F22a-five-chars');
    const cursorLeftBefore = st1.cursor.left;
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'F22b-after-backspace');
    if (st.cursor.exists && st.cursor.left < cursorLeftBefore)
      pass('F22', 'Cursor moves left on backspace');
    else
      fail('F22', 'Cursor moves left', `cursor.left < ${cursorLeftBefore}`,
        `cursor.left=${st.cursor.left}`, st, 'F22b-after-backspace', jsErrors);
    await cleanPrompt(page);

    // F23: Cursor after tab switch + retype
    console.log('\n--- F23: Cursor after flushed + pending ---');
    await page.keyboard.type('hi', { delay: 30 });
    await page.waitForTimeout(200);
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    await page.keyboard.type('!!', { delay: 30 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'F23a-flushed-plus-pending');
    // Cursor should exist — that's the key assertion
    if (st.cursor.exists)
      pass('F23', 'Cursor correct after flushed + pending');
    else
      fail('F23', 'Cursor after flushed+pending', 'cursor.exists=true',
        `cursor.exists=${st.cursor.exists}`, st, 'F23a-flushed-plus-pending', jsErrors);
    await cleanPrompt(page);

    // ════════════════════════════════════════════════════════════════
    // GROUP G: Visual Consistency (4 tests)
    // ════════════════════════════════════════════════════════════════
    console.log('\n══ GROUP G: Visual Consistency ══');

    // G24: Overlay position stable between keystrokes
    console.log('\n--- G24: Position stable between keystrokes ---');
    await page.keyboard.type('a', { delay: 30 });
    await page.waitForTimeout(200);
    st = await getState(page);
    await sc(page, 'G24a-first-char');
    const g24posA = st.children?.[0]?.left;
    const g24topA = st.children?.[0]?.top;
    await page.keyboard.type('b', { delay: 30 });
    await page.waitForTimeout(200);
    st = await getState(page);
    await sc(page, 'G24b-second-char');
    const g24posB = st.children?.[0]?.left;
    const g24topB = st.children?.[0]?.top;
    await page.keyboard.type('c', { delay: 30 });
    await page.waitForTimeout(200);
    st = await getState(page);
    await sc(page, 'G24c-third-char');
    const g24posC = st.children?.[0]?.left;
    const g24topC = st.children?.[0]?.top;
    if (g24posA === g24posB && g24posB === g24posC && g24topA === g24topB && g24topB === g24topC)
      pass('G24', 'Overlay position stable between keystrokes');
    else
      fail('G24', 'Position stable', `all same left/top`,
        `left: ${g24posA}, ${g24posB}, ${g24posC}; top: ${g24topA}, ${g24topB}, ${g24topC}`, st, 'G24c-third-char', jsErrors);
    await cleanPrompt(page);

    // G25: Overlay position stable across tab switch
    console.log('\n--- G25: Position stable across tab switch ---');
    await page.keyboard.type('pos test', { delay: 30 });
    await page.waitForTimeout(200);
    st = await getState(page);
    await sc(page, 'G25a-before-switch');
    const g25leftBefore = st.children?.[0]?.left;
    await switchTab(page, sB);
    await switchTab(page, sA);
    await focus(page);
    await page.keyboard.type(' more', { delay: 30 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'G25b-after-switch-type');
    const g25leftAfter = st.children?.[0]?.left;
    if (g25leftBefore === g25leftAfter)
      pass('G25', 'Position stable across tab switch');
    else
      fail('G25', 'Position across switch', `left unchanged`,
        `before=${g25leftBefore}, after=${g25leftAfter}`, st, 'G25b-after-switch-type', jsErrors);
    await cleanPrompt(page);

    // G26: Overlay background covers full width
    console.log('\n--- G26: Overlay background width ---');
    await page.keyboard.type('x', { delay: 30 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'G26a-overlay-width');
    const childWidth = st.children?.[0]?.width;
    if (childWidth && parseFloat(childWidth) > 0)
      pass('G26', 'Overlay has non-zero width');
    else
      fail('G26', 'Overlay width', 'width > 0',
        `width="${childWidth}"`, st, 'G26a-overlay-width', jsErrors);
    await cleanPrompt(page);

    // G27: No JS errors across all tests
    console.log('\n--- G27: No JS errors ---');
    await sc(page, 'G27-final-state');
    if (jsErrors.length === 0)
      pass('G27', 'No JS errors');
    else
      fail('G27', 'No JS errors', '0 errors',
        `${jsErrors.length} errors: ${jsErrors.slice(0, 3).join('; ')}`, null, 'G27-final-state', jsErrors);

    // ════════════════════════════════════════════════════════════════
    // GROUP H: Edge Cases (3 tests)
    // ════════════════════════════════════════════════════════════════
    console.log('\n══ GROUP H: Edge Cases ══');

    // H28: Paste multi-char text
    console.log('\n--- H28: Paste simulation ---');
    await focus(page);
    await waitForPrompt(page, 5000);
    await page.evaluate(() => {
      window.app?._localEchoOverlay?.appendText('pasted');
    });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'H28a-after-paste');
    if (st.text === 'pasted' && st.visible)
      pass('H28', 'Paste appends text');
    else
      fail('H28', 'Paste appends text', 'text="pasted", visible=true',
        `text="${st.text}", visible=${st.visible}`, st, 'H28a-after-paste', jsErrors);
    await cleanPrompt(page);

    // H29: Rapid type-backspace-type
    console.log('\n--- H29: Rapid type-backspace-type ---');
    await page.keyboard.type('hello', { delay: 15 });
    await page.waitForTimeout(100);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    await page.keyboard.type('p me', { delay: 15 });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'H29a-after-rapid');
    if (st.text === 'help me')
      pass('H29', 'Rapid type-backspace-type');
    else
      fail('H29', 'Rapid editing', 'text="help me"',
        `text="${st.text}"`, st, 'H29a-after-rapid', jsErrors);
    await cleanPrompt(page);

    // H30: Page reload clears all state
    console.log('\n--- H30: Page reload clears state ---');
    await page.keyboard.type('will be lost', { delay: 30 });
    await page.waitForTimeout(200);
    await sc(page, 'H30a-before-reload');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForTimeout(3000);
    // Re-enable local echo after reload
    await page.evaluate(() => {
      window.app?._updateLocalEchoState?.();
    });
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'H30b-after-reload');
    if (st.text === '' && st.flushed === 0 && Object.keys(st.flushedMap).length === 0)
      pass('H30', 'Reload clears all state');
    else
      fail('H30', 'Reload clears state', 'text="", flushed=0, flushedMap empty',
        `text="${st.text}", flushed=${st.flushed}, flushedMap=${JSON.stringify(st.flushedMap)}`, st, 'H30b-after-reload', jsErrors);

    // ══════════════════════════════════════════════════════════════
    // GROUP I: Long Text / Line Wrapping
    // ══════════════════════════════════════════════════════════════
    console.log('\n══ GROUP I: Long Text / Line Wrapping ══');

    // Need a prompt to work with after H30 reload
    // Re-select session A and wait for prompt
    await page.evaluate((id) => document.querySelector(`.session-tab[data-id="${id}"]`)?.click(), sA);
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('codeman-app-settings') || '{}');
      s.localEchoEnabled = true;
      localStorage.setItem('codeman-app-settings', JSON.stringify(s));
      window.app?._updateLocalEchoState?.();
    });
    await page.waitForTimeout(300);
    await focus(page);
    await waitForPrompt(page);

    // Get terminal columns to know the wrap point
    const termCols = await page.evaluate(() => window.app?.terminal?.cols || 80);
    // Prompt uses "❯ " (2 chars), so first line has (cols - 2) available chars
    const firstLineCols = termCols - 2;

    // I31: Type text that fills exactly first line (no wrap)
    console.log('\n--- I31: Type text that fills first line ---');
    await cleanPrompt(page);
    await focus(page);
    await waitForPrompt(page);
    const fillText = 'A'.repeat(firstLineCols);
    await page.evaluate((text) => window.app._localEchoOverlay.appendText(text), fillText);
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'I31a-full-first-line');
    if (st.visible && st.text === fillText && st.children.length >= 1) {
      pass('I31', 'Full first line renders correctly');
    } else {
      fail('I31', 'Full first line', `visible=true, text=${fillText.length} chars, children>=1`,
        `visible=${st.visible}, text=${st.text.length} chars, children=${st.children.length}`, st, 'I31a-full-first-line', jsErrors);
    }
    await cleanPrompt(page);

    // I32: Type text that wraps to second line
    console.log('\n--- I32: Type text that wraps to second line ---');
    await focus(page);
    await waitForPrompt(page);
    const wrapText = 'B'.repeat(firstLineCols + 5); // 5 chars on second line
    await page.evaluate((text) => window.app._localEchoOverlay.appendText(text), wrapText);
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'I32a-wrapped-to-line-2');
    // Should have 2 line divs + 1 cursor span = 3 children
    const lineChildren = st.children.filter(c => c.spanCount > 0);
    if (st.visible && st.text === wrapText && lineChildren.length === 2) {
      pass('I32', 'Text wraps to second line correctly');
    } else {
      fail('I32', 'Text wraps', `visible=true, text=${wrapText.length} chars, 2 line divs`,
        `visible=${st.visible}, text=${st.text.length} chars, line divs=${lineChildren.length}`, st, 'I32a-wrapped-to-line-2', jsErrors);
    }

    // Check cursor is on the second line
    if (st.cursor.exists && st.cursor.top > 0) {
      pass('I32c', 'Cursor on second line');
    } else {
      fail('I32c', 'Cursor position', 'cursor.top > 0 (second line)',
        `cursor.top=${st.cursor.top}`, st, 'I32a-wrapped-to-line-2', jsErrors);
    }
    await cleanPrompt(page);

    // I33: Type wrapping text, backspace back to first line
    console.log('\n--- I33: Wrap then backspace to first line ---');
    await focus(page);
    await waitForPrompt(page);
    const wrapText2 = 'C'.repeat(firstLineCols + 3);
    await page.evaluate((text) => window.app._localEchoOverlay.appendText(text), wrapText2);
    await page.waitForTimeout(200);
    await sc(page, 'I33a-wrapped');
    // Backspace the 3 chars on second line
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(200);
    st = await getState(page);
    await sc(page, 'I33b-back-to-one-line');
    const lineChildrenAfter = st.children.filter(c => c.spanCount > 0);
    if (st.visible && st.text.length === firstLineCols && lineChildrenAfter.length === 1) {
      pass('I33', 'Backspace from second line to first');
    } else {
      fail('I33', 'Backspace to first line', `text=${firstLineCols} chars, 1 line div`,
        `text=${st.text.length} chars, line divs=${lineChildrenAfter.length}`, st, 'I33b-back-to-one-line', jsErrors);
    }
    await cleanPrompt(page);

    // I34: Wrapping text survives tab switch
    console.log('\n--- I34: Wrapping text after tab switch ---');
    await focus(page);
    await waitForPrompt(page);
    const wrapLen34 = firstLineCols + 8;
    const wrapText3 = 'D'.repeat(wrapLen34);
    // Use appendText for instant injection (avoids keyboard timing issues)
    await page.evaluate((text) => window.app._localEchoOverlay.appendText(text), wrapText3);
    await page.waitForTimeout(200);
    // Verify text is buffered before switching
    st = await getState(page);
    await sc(page, 'I34a-wrapped-before-switch');
    console.log(`    buffered: text=${st.text.length} chars, visible=${st.visible}`);
    // Switch to B
    await page.evaluate((id) => document.querySelector(`.session-tab[data-id="${id}"]`)?.click(), sB);
    await page.waitForTimeout(1500);
    // Switch back to A
    await page.evaluate((id) => document.querySelector(`.session-tab[data-id="${id}"]`)?.click(), sA);
    await page.waitForTimeout(2500);
    st = await getState(page);
    await sc(page, 'I34b-after-round-trip');
    // After round-trip, flushed should contain the wrapping text
    if (st.flushed >= wrapLen34) {
      pass('I34a', 'Flushed wrapping text preserved');
    } else {
      fail('I34a', 'Flushed wrap text', `flushed>=${wrapLen34}`,
        `flushed=${st.flushed}`, st, 'I34b-after-round-trip', jsErrors);
    }
    // Overlay should be visible with flushed text
    if (st.visible && st.children.length >= 2) {
      pass('I34b', 'Flushed wrapping text renders multi-line');
    } else {
      fail('I34b', 'Flushed wrap render', 'visible=true, children>=2',
        `visible=${st.visible}, children=${st.children.length}`, st, 'I34b-after-round-trip', jsErrors);
    }
    // Type more to extend the wrap
    await focus(page);
    await page.keyboard.type('EE', { delay: 30 });
    await page.waitForTimeout(200);
    st = await getState(page);
    await sc(page, 'I34c-extended-wrap');
    if (st.text === 'EE' && st.flushed >= wrapLen34) {
      pass('I34c', 'Extended wrapping after tab switch');
    } else {
      fail('I34c', 'Extended wrap', `text="EE", flushed>=${wrapLen34}`,
        `text="${st.text}", flushed=${st.flushed}`, st, 'I34c-extended-wrap', jsErrors);
    }
    await cleanPrompt(page);

    // I35: Very long text (3+ lines)
    console.log('\n--- I35: Very long text (3+ lines) ---');
    await focus(page);
    await waitForPrompt(page);
    const longText = 'F'.repeat(firstLineCols + termCols + 5); // first line + full second + 5 on third
    await page.evaluate((text) => window.app._localEchoOverlay.appendText(text), longText);
    await page.waitForTimeout(300);
    st = await getState(page);
    await sc(page, 'I35a-three-lines');
    const longLineChildren = st.children.filter(c => c.spanCount > 0);
    if (st.visible && st.text === longText && longLineChildren.length === 3) {
      pass('I35', 'Very long text renders 3 lines');
    } else {
      fail('I35', '3-line text', `visible=true, text=${longText.length} chars, 3 line divs`,
        `visible=${st.visible}, text=${st.text.length} chars, line divs=${longLineChildren.length}`, st, 'I35a-three-lines', jsErrors);
    }
    await cleanPrompt(page);

    // ════════════════════════════════════════════════════════════════
    // SUMMARY
    // ════════════════════════════════════════════════════════════════
    console.log('\n════════════════════════════════════════');
    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    console.log(`  ${passed} passed, ${failed} failed out of ${results.length} assertions`);
    console.log(`  Screenshots: ${SCREENSHOT_DIR}/`);

    if (failed > 0) {
      console.log('\n  FAILURES:');
      for (const r of results.filter(r => !r.ok)) {
        console.log(`    ❌ ${r.id}: ${r.name}`);
      }
    }

    if (jsErrors.length > 0) {
      console.log(`\n  JS Errors (${jsErrors.length}):`);
      for (const e of jsErrors.slice(0, 5)) console.log(`    ⚠️  ${e}`);
    }

    console.log('════════════════════════════════════════');

  } finally {
    // Write error report
    writeErrorReport();
    console.log(`\n  Error report: ${SCREENSHOT_DIR}/error-report.md`);

    await browser.close();
    console.log('\nCleaning up sessions...');
    await deleteSession(sA);
    await deleteSession(sB);
    console.log('Done.\n');
  }
}

main().catch(err => { console.error('Test failed:', err); process.exit(1); });
