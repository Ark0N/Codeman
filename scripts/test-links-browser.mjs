#!/usr/bin/env node
/**
 * Browser test for clickable file links in Codeman terminal
 * Uses Playwright directly to ignore HTTPS errors
 */

import { chromium } from 'playwright';

const BASE_URL = 'https://localhost:3000';
const TEST_LOG_FILE = '/tmp/test-link-click.log';

async function main() {
  console.log('Starting browser test for clickable links...\n');

  // Create test log file
  const { writeFileSync, appendFileSync } = await import('fs');
  writeFileSync(TEST_LOG_FILE, `=== Test started at ${new Date().toISOString()} ===\n`);
  for (let i = 1; i <= 10; i++) {
    appendFileSync(TEST_LOG_FILE, `Entry #${i} - ${Date.now()}\n`);
  }
  console.log(`Created test file: ${TEST_LOG_FILE}\n`);

  // Launch browser ignoring HTTPS errors
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--ignore-ssl-errors']
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true
  });

  const page = await context.newPage();

  try {
    // Navigate to Codeman
    console.log('Navigating to Codeman...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('Page loaded: ' + await page.title());

    // Wait for terminal to be ready
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    console.log('Terminal found\n');

    // Get list of sessions
    const sessions = await page.evaluate(async () => {
      const res = await fetch('/api/sessions');
      return res.json();
    });
    console.log(`Found ${sessions.length} session(s)`);

    if (sessions.length === 0) {
      console.log('No sessions found. Creating a shell session...');
      const newSession = await page.evaluate(async () => {
        const res = await fetch('/api/quick-start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caseName: 'link-test', mode: 'shell' })
        });
        return res.json();
      });
      console.log('Created session:', newSession.session?.id);
      await page.waitForTimeout(2000);
    }

    // Get active session (use codeman session if exists)
    const codemanSession = sessions.find(s => s.workingDir?.includes('codeman'));
    const sessionId = codemanSession?.id || sessions[0]?.id;
    console.log(`Using session: ${sessionId}\n`);

    // Send a command that outputs file paths
    console.log('Sending command with file path...');
    await page.evaluate(async (sid, logFile) => {
      await fetch(`/api/sessions/${sid}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: `echo "Monitor: tail -f ${logFile}"\r` })
      });
    }, sessionId, TEST_LOG_FILE);

    await page.waitForTimeout(2000);

    // Take screenshot
    await page.screenshot({ path: '/tmp/codeman-link-test-1.png' });
    console.log('Screenshot saved: /tmp/codeman-link-test-1.png\n');

    // Check if terminal contains our file path
    const terminalContent = await page.evaluate(() => {
      const screen = document.querySelector('.xterm-screen');
      return screen?.textContent || '';
    });

    if (terminalContent.includes(TEST_LOG_FILE)) {
      console.log('File path appears in terminal output');
    } else {
      console.log('WARNING: File path not found in terminal. Content preview:');
      console.log(terminalContent.substring(0, 500));
    }

    // Try to find clickable links in xterm
    const linkCount = await page.evaluate(() => {
      // xterm link detection happens on mouse move, so we need to trigger it
      const links = document.querySelectorAll('.xterm-link');
      return links.length;
    });
    console.log(`\nClickable links found: ${linkCount}`);

    // Try hovering over the terminal to trigger link detection
    console.log('\nHovering over terminal to trigger link detection...');
    const termRect = await page.locator('.xterm-screen').boundingBox();
    if (termRect) {
      // Move mouse across the terminal
      for (let y = termRect.y + 50; y < termRect.y + termRect.height - 50; y += 20) {
        for (let x = termRect.x + 50; x < termRect.x + termRect.width - 50; x += 50) {
          await page.mouse.move(x, y);
          await page.waitForTimeout(50);
        }
      }
    }

    // Check for tooltip (shows when hovering over link)
    const tooltipVisible = await page.evaluate(() => {
      const tooltip = document.getElementById('file-link-tooltip');
      return tooltip?.style.display !== 'none' && tooltip?.style.display !== '';
    });
    console.log('Tooltip visible:', tooltipVisible);

    // Check for log viewer windows
    const logViewerCount = await page.evaluate(() => {
      return document.querySelectorAll('.log-viewer-window').length;
    });
    console.log('Log viewer windows:', logViewerCount);

    // Take final screenshot
    await page.screenshot({ path: '/tmp/codeman-link-test-2.png' });
    console.log('\nFinal screenshot: /tmp/codeman-link-test-2.png');

    // Test the link provider registration
    console.log('\n--- Link Provider Debug ---');
    const debugInfo = await page.evaluate(() => {
      // Check if app has link provider registered
      const app = window.app;
      if (!app) return { error: 'No app object found' };

      const terminal = app.terminals?.get(app.activeSessionId);
      if (!terminal) return { error: 'No active terminal', activeSessionId: app.activeSessionId };

      return {
        hasTerminal: true,
        activeSessionId: app.activeSessionId,
        terminalBuffer: terminal.buffer?.active?.length || 0
      };
    });
    console.log('Debug info:', debugInfo);

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: '/tmp/codeman-link-test-error.png' });
    console.log('Error screenshot saved to /tmp/codeman-link-test-error.png');
  } finally {
    await browser.close();
    console.log('\nBrowser closed');
  }
}

main().catch(console.error);
