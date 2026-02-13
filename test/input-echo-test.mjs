/**
 * Input echo test: Verifies that typing in the web UI doesn't produce
 * "visible below" artifacts (text mirrored onto Ink's status bar rows).
 *
 * Test approach:
 * 1. Creates a SHELL session (bash, not Claude) to avoid Ink complexity
 * 2. Types various input patterns and captures terminal state
 * 3. Verifies echo appears at correct cursor position, not duplicated
 *
 * Usage: node test/input-echo-test.mjs [--live]
 *   --live  Use existing sessions instead of creating new ones
 */
import { chromium } from 'playwright';

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;

async function createShellSession() {
  const resp = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'shell', name: 'input-test' })
  });
  if (!resp.ok) throw new Error(`Failed to create session: ${resp.status}`);
  const data = await resp.json();
  return data.session?.id || data.id;
}

async function deleteSession(id) {
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
}

async function waitForSessionReady(sessionId, timeoutMs = 10000) {
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

async function getTerminalContent(page) {
  return page.evaluate(() => {
    const app = window.app;
    if (!app?.terminal) return null;
    const buf = app.terminal.buffer.active;
    const lines = [];
    for (let i = 0; i <= buf.baseY + buf.viewportY + app.terminal.rows; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return {
      lines,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      rows: app.terminal.rows,
      cols: app.terminal.cols,
    };
  });
}

async function main() {
  const isLive = process.argv.includes('--live');
  let sessionId = null;

  console.log('=== Input Echo Test ===\n');

  // Create a shell session for testing
  if (!isLive) {
    console.log('Creating shell session...');
    sessionId = await createShellSession();
    console.log(`Session created: ${sessionId}`);

    const ready = await waitForSessionReady(sessionId);
    if (!ready) {
      console.error('Session failed to become ready');
      await deleteSession(sessionId);
      process.exit(1);
    }
    console.log('Session ready\n');
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--window-size=1280,800']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Collect console output for debugging
  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

  try {
    console.log('Opening Claudeman...');
    await page.goto(BASE);
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Switch to our test session if not live
    if (sessionId) {
      // Click the test session tab
      const tabClicked = await page.evaluate((id) => {
        const tabs = document.querySelectorAll('.session-tab');
        for (const tab of tabs) {
          if (tab.dataset.sessionId === id) {
            tab.click();
            return true;
          }
        }
        return false;
      }, sessionId);
      if (tabClicked) {
        await page.waitForTimeout(1000);
        console.log('Switched to test session');
      }
    }

    // Focus the terminal
    await page.click('.xterm-screen');
    await page.waitForTimeout(500);

    // Take before screenshot
    await page.screenshot({ path: '/tmp/input-test-before.png' });
    console.log('Screenshot: /tmp/input-test-before.png (before typing)');

    // Get terminal state before typing
    const beforeState = await getTerminalContent(page);
    const beforeCursorY = beforeState?.cursorY ?? -1;
    console.log(`Before: cursor at row ${beforeCursorY}, col ${beforeState?.cursorX}`);

    // TEST 1: Type a short string
    console.log('\n--- Test 1: Short string ---');
    const testStr = 'echo hello-world-test-123';
    await page.keyboard.type(testStr, { delay: 30 });
    await page.waitForTimeout(600);  // Wait for PTY echo round-trip

    const afterShort = await getTerminalContent(page);
    await page.screenshot({ path: '/tmp/input-test-short.png' });
    console.log('Screenshot: /tmp/input-test-short.png');

    // Check: cursor should still be on same row (or +1 for wrap)
    // and text should appear at/near the cursor position
    const cursorRowAfter = afterShort?.cursorY ?? -1;
    console.log(`After: cursor at row ${cursorRowAfter}, col ${afterShort?.cursorX}`);

    // The echo should be on the cursor's row, not below
    const echoLine = afterShort?.lines?.[afterShort.cursorY + (afterShort.lines.length - afterShort.rows)] ?? '';
    console.log(`Echo line: "${echoLine.trim()}"`);
    if (echoLine.includes(testStr)) {
      console.log('PASS: Echo found at cursor row');
    } else {
      console.log('INFO: Echo may be on a different row (check screenshots)');
    }

    // TEST 2: Press Enter and check response
    console.log('\n--- Test 2: Enter key ---');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    const afterEnter = await getTerminalContent(page);
    await page.screenshot({ path: '/tmp/input-test-enter.png' });
    console.log('Screenshot: /tmp/input-test-enter.png');

    // Check for "hello-world-test-123" in the output
    const allText = afterEnter?.lines?.join('\n') ?? '';
    if (allText.includes('hello-world-test-123')) {
      console.log('PASS: Command output visible');
    } else {
      console.log('WARN: Command output not found');
    }

    // TEST 3: Type a LONG string that approaches right edge
    console.log('\n--- Test 3: Long string (near right edge) ---');
    const longStr = 'echo ' + 'A'.repeat(afterShort?.cols ? afterShort.cols - 10 : 150);
    await page.keyboard.type(longStr, { delay: 10 });
    await page.waitForTimeout(800);

    const afterLong = await getTerminalContent(page);
    await page.screenshot({ path: '/tmp/input-test-long.png' });
    console.log('Screenshot: /tmp/input-test-long.png');
    console.log(`After long: cursor at row ${afterLong?.cursorY}, col ${afterLong?.cursorX}`);

    // Check that no text leaked below the cursor row
    const cursorAbsRow = (afterLong?.lines?.length ?? 0) - (afterLong?.rows ?? 0) + (afterLong?.cursorY ?? 0);
    const rowsBelow = afterLong?.lines?.slice(cursorAbsRow + 1) ?? [];
    const leakedText = rowsBelow.filter(l => l.trim().length > 0 && l.includes('AAA'));
    if (leakedText.length === 0) {
      console.log('PASS: No text leaked below cursor row');
    } else {
      console.log(`FAIL: Text leaked below cursor: ${leakedText.map(l => `"${l.trim()}"`).join(', ')}`);
    }

    // TEST 4: Rapid typing (paste-like)
    console.log('\n--- Test 4: Rapid input (paste simulation) ---');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    // Type rapidly (no delay between chars)
    await page.keyboard.type('echo rapid-test-no-delay-abcdefghij', { delay: 0 });
    await page.waitForTimeout(800);

    await page.screenshot({ path: '/tmp/input-test-rapid.png' });
    console.log('Screenshot: /tmp/input-test-rapid.png');

    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    const afterRapid = await getTerminalContent(page);
    const rapidText = afterRapid?.lines?.join('\n') ?? '';
    if (rapidText.includes('rapid-test-no-delay-abcdefghij')) {
      console.log('PASS: Rapid input command output visible');
    } else {
      console.log('WARN: Rapid input output not found (check screenshots)');
    }

    // Final screenshot
    await page.screenshot({ path: '/tmp/input-test-final.png' });
    console.log('\nScreenshot: /tmp/input-test-final.png (final state)');

    // Summary
    console.log('\n=== Test Complete ===');
    console.log('Check screenshots in /tmp/input-test-*.png');
    console.log('Key check: no text should appear below the active cursor row');

  } finally {
    await browser.close();
    if (sessionId && !isLive) {
      console.log(`\nCleaning up session ${sessionId}...`);
      await deleteSession(sessionId);
    }
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
