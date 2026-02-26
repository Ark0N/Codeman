#!/usr/bin/env node
/**
 * Browser Framework Comparison Script
 *
 * Compares Playwright, Puppeteer, and Agent-Browser for testing Codeman web UI.
 * Run: node scripts/browser-comparison.mjs
 */

import { chromium } from 'playwright';
import puppeteer from 'puppeteer';
import { execSync } from 'node:child_process';
import { WebServer } from '../src/web/server.js';

const PORTS = {
  playwright: 3180,
  puppeteer: 3181,
  agentBrowser: 3182,
};

const results = [];

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function runBenchmark(name, framework, fn) {
  const start = Date.now();
  let success = false;
  let error = null;
  try {
    await fn();
    success = true;
  } catch (e) {
    error = e.message;
  }
  const duration = Date.now() - start;
  results.push({ scenario: name, framework, duration, success, error });
  console.log(`  ${success ? '✅' : '❌'} ${name}: ${duration}ms ${error ? `(${error.slice(0, 50)})` : ''}`);
}

// Agent-browser helper
function agentBrowser(cmd) {
  return execSync(`npx agent-browser ${cmd}`, {
    timeout: 30000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function agentBrowserJson(cmd) {
  const result = agentBrowser(`${cmd} --json`);
  const parsed = JSON.parse(result);
  if (!parsed.success) throw new Error(parsed.error || 'unknown error');
  return parsed.data;
}

async function main() {
  console.log('🚀 Browser Framework Comparison Benchmark');
  console.log('Comparing: Playwright, Puppeteer, Agent-Browser\n');

  // Start servers
  const servers = [];
  for (const [name, port] of Object.entries(PORTS)) {
    console.log(`Starting server for ${name} on port ${port}...`);
    const server = new WebServer(port);
    await server.start();
    servers.push(server);
  }
  await new Promise(r => setTimeout(r, 2000));

  // ============================================
  // PLAYWRIGHT TESTS
  // ============================================
  logSection('PLAYWRIGHT TESTS');

  let playwrightBrowser;
  try {
    playwrightBrowser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    console.log('  Browser launched');

    // Test 1: Page load
    await runBenchmark('page-load', 'playwright', async () => {
      const page = await playwrightBrowser.newPage();
      await page.goto(`http://localhost:${PORTS.playwright}`);
      const title = await page.title();
      if (title !== 'Codeman') throw new Error(`Expected Codeman, got ${title}`);
      await page.close();
    });

    // Test 2: Element selection
    await runBenchmark('element-selection', 'playwright', async () => {
      const page = await playwrightBrowser.newPage();
      await page.goto(`http://localhost:${PORTS.playwright}`);
      const logo = await page.locator('.header-brand .logo').textContent();
      const version = await page.locator('#versionDisplay').textContent();
      if (logo !== 'Codeman') throw new Error('Logo mismatch');
      if (!version.match(/v\d+/)) throw new Error('Version mismatch');
      await page.close();
    });

    // Test 3: Modal interaction
    await runBenchmark('modal-interaction', 'playwright', async () => {
      const page = await playwrightBrowser.newPage();
      await page.goto(`http://localhost:${PORTS.playwright}`);
      await page.click('.help-btn');
      await page.waitForSelector('#helpModal .modal-content', { state: 'visible' });
      await page.click('#helpModal .modal-close');
      await page.waitForSelector('#helpModal .modal-content', { state: 'hidden' });
      await page.close();
    });

    // Test 4: Rapid operations (5 modal cycles)
    await runBenchmark('rapid-operations', 'playwright', async () => {
      const page = await playwrightBrowser.newPage();
      await page.goto(`http://localhost:${PORTS.playwright}`);
      for (let i = 0; i < 5; i++) {
        await page.click('.help-btn');
        await page.waitForSelector('#helpModal .modal-content', { state: 'visible' });
        await page.click('#helpModal .modal-close');
        await page.waitForSelector('#helpModal .modal-content', { state: 'hidden' });
      }
      await page.close();
    });

  } finally {
    if (playwrightBrowser) await playwrightBrowser.close();
  }

  // ============================================
  // PUPPETEER TESTS
  // ============================================
  logSection('PUPPETEER TESTS');

  let puppeteerBrowser;
  try {
    puppeteerBrowser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    console.log('  Browser launched');

    // Test 1: Page load
    await runBenchmark('page-load', 'puppeteer', async () => {
      const page = await puppeteerBrowser.newPage();
      await page.goto(`http://localhost:${PORTS.puppeteer}`);
      const title = await page.title();
      if (title !== 'Codeman') throw new Error(`Expected Codeman, got ${title}`);
      await page.close();
    });

    // Test 2: Element selection
    await runBenchmark('element-selection', 'puppeteer', async () => {
      const page = await puppeteerBrowser.newPage();
      await page.goto(`http://localhost:${PORTS.puppeteer}`);
      const logo = await page.$eval('.header-brand .logo', el => el.textContent);
      const version = await page.$eval('#versionDisplay', el => el.textContent);
      if (logo !== 'Codeman') throw new Error('Logo mismatch');
      if (!version.match(/v\d+/)) throw new Error('Version mismatch');
      await page.close();
    });

    // Test 3: Modal interaction
    await runBenchmark('modal-interaction', 'puppeteer', async () => {
      const page = await puppeteerBrowser.newPage();
      await page.goto(`http://localhost:${PORTS.puppeteer}`);
      await page.click('.help-btn');
      await page.waitForSelector('#helpModal .modal-content', { visible: true });
      await page.click('#helpModal .modal-close');
      await new Promise(r => setTimeout(r, 300));
      await page.close();
    });

    // Test 4: Rapid operations
    await runBenchmark('rapid-operations', 'puppeteer', async () => {
      const page = await puppeteerBrowser.newPage();
      await page.goto(`http://localhost:${PORTS.puppeteer}`);
      for (let i = 0; i < 5; i++) {
        await page.click('.help-btn');
        await page.waitForSelector('#helpModal .modal-content', { visible: true });
        await page.click('#helpModal .modal-close');
        await new Promise(r => setTimeout(r, 200));
      }
      await page.close();
    });

  } finally {
    if (puppeteerBrowser) await puppeteerBrowser.close();
  }

  // ============================================
  // AGENT-BROWSER TESTS
  // ============================================
  logSection('AGENT-BROWSER TESTS');

  let agentBrowserAvailable = false;
  try {
    agentBrowser(`open http://localhost:${PORTS.agentBrowser}`);
    await new Promise(r => setTimeout(r, 2000));
    const title = agentBrowserJson('get title');
    agentBrowserAvailable = title.title === 'Codeman';
    console.log('  Browser launched');

    // Test 1: Page load
    await runBenchmark('page-load', 'agent-browser', async () => {
      agentBrowser(`open http://localhost:${PORTS.agentBrowser}`);
      await new Promise(r => setTimeout(r, 1000));
      const title = agentBrowserJson('get title');
      if (title.title !== 'Codeman') throw new Error(`Expected Codeman, got ${title.title}`);
    });

    // Test 2: Element selection
    await runBenchmark('element-selection', 'agent-browser', async () => {
      const logo = agentBrowserJson('get text ".header-brand .logo"');
      const version = agentBrowserJson('get text "#versionDisplay"');
      if (logo.text !== 'Codeman') throw new Error('Logo mismatch');
      if (!version.text.match(/v\d+/)) throw new Error('Version mismatch');
    });

    // Test 3: Modal interaction
    await runBenchmark('modal-interaction', 'agent-browser', async () => {
      agentBrowser('click ".help-btn"');
      await new Promise(r => setTimeout(r, 500));
      const visible = agentBrowserJson('is visible "#helpModal .modal-content"');
      if (!visible.visible) throw new Error('Modal not visible');
      agentBrowser('click "#helpModal .modal-close"');
      await new Promise(r => setTimeout(r, 300));
    });

    // Test 4: Rapid operations
    await runBenchmark('rapid-operations', 'agent-browser', async () => {
      for (let i = 0; i < 5; i++) {
        agentBrowser('click ".help-btn"');
        await new Promise(r => setTimeout(r, 300));
        agentBrowser('click "#helpModal .modal-close"');
        await new Promise(r => setTimeout(r, 300));
      }
    });

  } catch (e) {
    console.log(`  ⚠️ Agent-browser not available: ${e.message}`);
  } finally {
    try { agentBrowser('close'); } catch {}
  }

  // ============================================
  // RESULTS
  // ============================================
  logSection('RESULTS SUMMARY');

  // Group by framework
  const frameworks = ['playwright', 'puppeteer', 'agent-browser'];
  for (const fw of frameworks) {
    const fwResults = results.filter(r => r.framework === fw);
    if (fwResults.length === 0) continue;

    const passed = fwResults.filter(r => r.success).length;
    const total = fwResults.length;
    const avgDuration = Math.round(fwResults.reduce((a, r) => a + r.duration, 0) / total);

    console.log(`\n  ${fw.toUpperCase()}`);
    console.log(`    Tests: ${passed}/${total} passed`);
    console.log(`    Avg Duration: ${avgDuration}ms`);
  }

  // Performance ranking
  console.log('\n🏆 PERFORMANCE RANKING (by avg duration)');
  const stats = frameworks.map(fw => {
    const fwResults = results.filter(r => r.framework === fw);
    if (fwResults.length === 0) return null;
    return {
      framework: fw,
      avg: Math.round(fwResults.reduce((a, r) => a + r.duration, 0) / fwResults.length),
      passed: fwResults.filter(r => r.success).length,
      total: fwResults.length,
    };
  }).filter(Boolean).sort((a, b) => a.avg - b.avg);

  stats.forEach((s, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
    console.log(`  ${medal} ${s.framework}: ${s.avg}ms avg (${s.passed}/${s.total} passed)`);
  });

  // Cleanup
  console.log('\n  Cleaning up...');
  for (const server of servers) {
    await server.stop();
  }

  console.log('\n✅ Benchmark complete!\n');

  // Detailed results table
  console.log('📋 DETAILED RESULTS');
  console.table(results.map(r => ({
    Scenario: r.scenario,
    Framework: r.framework,
    Duration: `${r.duration}ms`,
    Status: r.success ? '✅' : '❌',
  })));
}

main().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
