#!/usr/bin/env node

/**
 * capture-video-screenshots.mjs
 *
 * Captures real Codeman UI screenshots for the Remotion demo video.
 * Uses Playwright + page.route() mock injection (same pattern as capture-readme-screenshots.mjs).
 * No real Claude CLI or server needed — all API responses are mocked.
 *
 * Usage:  node scripts/capture-video-screenshots.mjs
 * Port:   3198 (static file server)
 * Output: remotion/public/ (6 PNGs)
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const PUBLIC_DIR = join(PROJECT_ROOT, 'src', 'web', 'public');
const OUTPUT_DIR = join(PROJECT_ROOT, 'remotion', 'public');
const PORT = 3198;

const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── MIME Types ──────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

// ─── Static File Server ──────────────────────────────────────────────────────

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/') urlPath = '/index.html';

      const filePath = join(PUBLIC_DIR, urlPath);

      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      try {
        const data = readFileSync(filePath);
        const ext = extname(filePath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      } catch {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });

    server.listen(PORT, () => {
      console.log(`Static server on http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

// ─── Mock Data ───────────────────────────────────────────────────────────────

function makeSession(id, name, mode, status, extra = {}) {
  return {
    id,
    pid: status === 'idle' ? null : 12345 + Math.floor(Math.random() * 10000),
    status,
    workingDir: '/home/user/my-project',
    currentTaskId: null,
    createdAt: Date.now() - 3600000,
    lastActivityAt: Date.now() - (status === 'idle' ? 60000 : 5000),
    name,
    mode,
    autoClearEnabled: false,
    autoClearThreshold: 140000,
    autoCompactEnabled: false,
    autoCompactThreshold: 110000,
    autoCompactPrompt: '',
    imageWatcherEnabled: false,
    totalCost: mode === 'claude' ? 0.12 : 0,
    inputTokens: mode === 'claude' ? 18000 : 0,
    outputTokens: mode === 'claude' ? 11500 : 0,
    ralphEnabled: false,
    niceEnabled: false,
    niceValue: 10,
    color: 'default',
    flickerFilterEnabled: false,
    cliVersion: '2.1.61',
    cliModel: mode === 'claude' ? 'Opus 4.6' : 'GPT-4o',
    cliAccountType: mode === 'claude' ? 'Claude Max' : 'API Key',
    cliLatestVersion: '2.1.61',
    messageCount: 15,
    isWorking: status === 'busy',
    lastPromptTime: Date.now() - 30000,
    bufferStats: {
      terminalBufferSize: 4096,
      textOutputSize: 2048,
      messageCount: 15,
      maxTerminalBuffer: 2097152,
      maxTextOutput: 1048576,
      maxMessages: 1000,
    },
    taskStats: { total: 0, running: 0, completed: 0, failed: 0 },
    taskTree: [],
    tokens: {
      input: mode === 'claude' ? 18000 : 0,
      output: mode === 'claude' ? 11500 : 0,
      total: mode === 'claude' ? 29500 : 0,
    },
    autoClear: { enabled: false, threshold: 140000 },
    nice: { enabled: false, niceValue: 10 },
    ralphLoop: null,
    ralphTodos: [],
    ralphTodoStats: { total: 0, completed: 0, percentComplete: 0 },
    respawnEnabled: false,
    respawnConfig: null,
    respawn: null,
    claudeSessionId: `claude-${id}`,
    ...extra,
  };
}

function buildInitPayload(sessions) {
  const respawnStatus = {};
  for (const s of sessions) {
    respawnStatus[s.id] = {
      state: 'idle',
      cycleCount: 0,
      lastActivityTime: Date.now(),
      timeSinceActivity: 0,
      promptDetected: false,
      workingDetected: false,
      detection: {},
      config: null,
    };
  }

  return {
    version: '0.1651',
    sessions,
    scheduledRuns: [],
    respawnStatus,
    globalStats: {
      totalInputTokens: 145000,
      totalOutputTokens: 87000,
      totalCost: 1.82,
      totalSessionsCreated: 12,
      firstRecordedAt: Date.now() - 86400000,
      lastUpdatedAt: Date.now(),
    },
    subagents: [],
    timestamp: Date.now(),
  };
}

// ─── Terminal Content (ANSI) ─────────────────────────────────────────────────

const RST = '\x1b[0m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const MAG = '\x1b[35m';
const GRY = '\x1b[90m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// Claude Code init banner
const TERMINAL_CLAUDE = [
  '',
  `  ${RED}████${RST}    ${BOLD}Claude Code${RST} v2.1.61`,
  `  ${RED}████${RST}    ${GRY}Opus 4.6${RST} ${DIM}·${RST} ${GRY}Claude Max${RST}`,
  `  ${RED}██${RST} ${RED}██${RST}    ${GRY}~/my-project${RST}`,
  '',
  '',
  `${GRY}❯ Try "how do I log an error?"${RST}`,
  '',
  '',
  `${YEL}»»${RST} ${BOLD}bypass permissions on${RST} ${GRY}(shift+tab to cycle)${RST}`,
  `                                                                                                           ${BOLD}0 tokens${RST}`,
  `                                                                                   ${GRY}current: 2.1.61${RST} ${DIM}·${RST} ${GRY}latest: 2.1.61${RST}`,
].join('\r\n');

// OpenCode init banner
const TERMINAL_OPENCODE = [
  '',
  `  ${GRN}████${RST}    ${BOLD}OpenCode${RST} v0.3.12`,
  `  ${GRN}████${RST}    ${GRY}GPT-4o${RST} ${DIM}·${RST} ${GRY}API Key${RST}`,
  `  ${GRN}██${RST} ${GRN}██${RST}    ${GRY}~/my-project${RST}`,
  '',
  '',
  `${GRY}❯ Try "explain this codebase"${RST}`,
  '',
  '',
  `${YEL}»»${RST} ${BOLD}bypass permissions on${RST}`,
  `                                                                                                           ${BOLD}0 tokens${RST}`,
].join('\r\n');

// ─── Route Interceptors ──────────────────────────────────────────────────────

async function setupRoutes(page, initPayload, terminalContent) {
  // Block SSE to prevent reconnection loops
  await page.route('**/api/events', async (route) => {
    await route.abort();
  });

  // Terminal buffer endpoint
  await page.route('**/api/sessions/*/terminal**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        terminalBuffer: terminalContent,
        status: 'busy',
        fullSize: terminalContent.length,
        truncated: false,
      }),
    });
  });

  // Mux sessions
  await page.route('**/api/mux-sessions/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  await page.route('**/api/mux-sessions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [], muxAvailable: true }),
    });
  });

  // Settings
  await page.route('**/api/settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        showSubagents: false,
        subagentTrackingEnabled: false,
        subagentActiveTabOnly: false,
        showMonitor: false,
      }),
    });
  });

  // Subagent window states
  await page.route('**/api/subagent-window-states', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  // Subagent parents
  await page.route('**/api/subagent-parents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  // Session-specific subagents
  await page.route('**/api/sessions/*/subagents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  // Interactive attach
  await page.route('**/api/sessions/*/interactive', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  // Resize
  await page.route('**/api/sessions/*/resize', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  // Catch-all API
  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });
}

/**
 * Inject mock state and render the app.
 */
async function injectState(page, initPayload, terminalContent, activeSessionId) {
  await page.waitForFunction(() => window.app && window.app.terminal, { timeout: 15000 });
  await sleep(2000);

  // Cancel SSE fallback timer and inject state
  await page.evaluate((payload) => {
    const app = window.app;
    if (app._initFallbackTimer) {
      clearTimeout(app._initFallbackTimer);
      app._initFallbackTimer = null;
    }
    app.handleInit(payload);
  }, initPayload);

  await sleep(3000);

  // Select the target session
  if (activeSessionId) {
    await page.evaluate((sid) => {
      window.app.activeSessionId = null;
      window.app.selectSession(sid);
    }, activeSessionId);
    await sleep(4000);
  }

  // Write terminal content directly as backup
  if (terminalContent && activeSessionId) {
    await page.evaluate((content) => {
      const app = window.app;
      if (app.terminal) {
        const buf = app.terminal.buffer?.active;
        const hasContent = buf && buf.length > 2 && buf.getLine(1)?.translateToString().trim();
        if (!hasContent) {
          app.terminal.clear();
          app.terminal.reset();
          app.terminal.write(content);
          app.terminal.scrollToBottom();
        }
      }
    }, terminalContent);
    await sleep(3000);
  }

  // Clean up UI artifacts
  await page.evaluate(() => {
    const app = window.app;
    if (app) {
      if (app.sseReconnectTimeout) clearTimeout(app.sseReconnectTimeout);
      if (app.eventSource) { app.eventSource.close(); app.eventSource = null; }
      app._connectionStatus = 'connected';
      app._updateConnectionIndicator = () => {};
      app.connectSSE = () => {};
      app.setConnectionStatus = () => {};
    }

    // Remove connection indicator
    const indicator = document.getElementById('connectionIndicator');
    if (indicator) indicator.remove();

    // Hide respawn banner
    const respawnBanner = document.getElementById('respawnBanner');
    if (respawnBanner) respawnBanner.style.display = 'none';

    // Mock CPU/MEM stats
    const statsEl = document.getElementById('headerSystemStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <span class="stat-label">CPU</span>
        <div class="stat-bar"><div class="stat-bar-fill cpu-bar" style="width: 18%"></div></div>
        <span class="stat-value">18%</span>
        <span class="stat-label">MEM</span>
        <div class="stat-bar"><div class="stat-bar-fill mem-bar" style="width: 42%"></div></div>
        <span class="stat-value">13.7G</span>
      `;
    }

    // Hide subagents panel entirely
    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) subagentsPanel.style.display = 'none';

    // Close and hide monitor panel
    const monitorPanel = document.getElementById('monitorPanel');
    if (monitorPanel) {
      monitorPanel.classList.remove('open');
      monitorPanel.style.display = 'none';
    }

    // Hide monitor toggle button in toolbar
    const monitorBtn = document.getElementById('monitorToggle');
    if (monitorBtn) monitorBtn.style.display = 'none';

    // Update token display
    if (app && app.activeSessionId) {
      const session = app.sessions.get(app.activeSessionId);
      if (session) {
        const tokens = (session.tokens?.total || 0);
        const tokenEl = document.getElementById('headerTokens');
        if (tokenEl) {
          const formatted = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
          tokenEl.innerHTML = `<span class="token-icon">⊙</span> <span class="token-count">${formatted} tokens</span>`;
        }
      }
    }
  });

  // Final settle — let xterm.js WebGL renderer, fonts, and layout fully stabilize
  await sleep(4000);
}

// ─── Screenshot Scenarios ────────────────────────────────────────────────────

// 1. Desktop welcome — no sessions, welcome overlay visible
async function captureDesktopWelcome(browser) {
  console.log('\n1/6 Capturing desktop-welcome.png...');

  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    const initPayload = buildInitPayload([]);
    await setupRoutes(page, initPayload, '');

    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && window.app.terminal, { timeout: 15000 });
    await sleep(2000);

    // Inject empty state — welcome overlay should show automatically
    await page.evaluate((payload) => {
      const app = window.app;
      if (app._initFallbackTimer) {
        clearTimeout(app._initFallbackTimer);
        app._initFallbackTimer = null;
      }
      app.handleInit(payload);
    }, initPayload);
    await sleep(3000);

    // Clean up UI
    await page.evaluate(() => {
      const app = window.app;
      if (app) {
        if (app.sseReconnectTimeout) clearTimeout(app.sseReconnectTimeout);
        if (app.eventSource) { app.eventSource.close(); app.eventSource = null; }
        app._connectionStatus = 'connected';
        app._updateConnectionIndicator = () => {};
        app.connectSSE = () => {};
        app.setConnectionStatus = () => {};
      }
      const indicator = document.getElementById('connectionIndicator');
      if (indicator) indicator.remove();
      const respawnBanner = document.getElementById('respawnBanner');
      if (respawnBanner) respawnBanner.style.display = 'none';

      // Mock stats
      const statsEl = document.getElementById('headerSystemStats');
      if (statsEl) {
        statsEl.innerHTML = `
          <span class="stat-label">CPU</span>
          <div class="stat-bar"><div class="stat-bar-fill cpu-bar" style="width: 18%"></div></div>
          <span class="stat-value">18%</span>
          <span class="stat-label">MEM</span>
          <div class="stat-bar"><div class="stat-bar-fill mem-bar" style="width: 42%"></div></div>
          <span class="stat-value">13.7G</span>
        `;
      }

      // Hide monitor and subagent panels
      const subagentsPanel = document.getElementById('subagentsPanel');
      if (subagentsPanel) subagentsPanel.style.display = 'none';
      const monitorPanel = document.getElementById('monitorPanel');
      if (monitorPanel) {
        monitorPanel.classList.remove('open');
        monitorPanel.style.display = 'none';
      }
      const monitorBtn = document.getElementById('monitorToggle');
      if (monitorBtn) monitorBtn.style.display = 'none';
    });
    await sleep(3000);

    await page.screenshot({
      path: join(OUTPUT_DIR, 'desktop-welcome.png'),
      fullPage: false,
    });
    console.log('  Saved: remotion/public/desktop-welcome.png');
  } finally {
    await context.close();
  }
}

// 2. Desktop with single Claude tab active
async function captureDesktopClaude(browser) {
  console.log('\n2/6 Capturing desktop-claude.png...');

  const claudeSession = makeSession('sess-claude-1', 'w1-my-project', 'claude', 'busy');
  const initPayload = buildInitPayload([claudeSession]);

  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await setupRoutes(page, initPayload, TERMINAL_CLAUDE);
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await injectState(page, initPayload, TERMINAL_CLAUDE, 'sess-claude-1');

    await page.screenshot({
      path: join(OUTPUT_DIR, 'desktop-claude.png'),
      fullPage: false,
    });
    console.log('  Saved: remotion/public/desktop-claude.png');
  } finally {
    await context.close();
  }
}

// 3. Desktop with 2 tabs (Claude + OpenCode), Claude active
async function captureDesktopBothClaude(browser) {
  console.log('\n3/6 Capturing desktop-both-claude.png...');

  const claudeSession = makeSession('sess-claude-2', 'w1-my-project', 'claude', 'busy');
  const opencodeSession = makeSession('sess-opencode-2', 'w2-my-project', 'opencode', 'busy');
  const initPayload = buildInitPayload([claudeSession, opencodeSession]);

  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await setupRoutes(page, initPayload, TERMINAL_CLAUDE);
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await injectState(page, initPayload, TERMINAL_CLAUDE, 'sess-claude-2');

    await page.screenshot({
      path: join(OUTPUT_DIR, 'desktop-both-claude.png'),
      fullPage: false,
    });
    console.log('  Saved: remotion/public/desktop-both-claude.png');
  } finally {
    await context.close();
  }
}

// 4. Desktop with 2 tabs (Claude + OpenCode), OpenCode active
async function captureDesktopBothOpencode(browser) {
  console.log('\n4/6 Capturing desktop-both-opencode.png...');

  const claudeSession = makeSession('sess-claude-3', 'w1-my-project', 'claude', 'busy');
  const opencodeSession = makeSession('sess-opencode-3', 'w2-my-project', 'opencode', 'busy');
  const initPayload = buildInitPayload([claudeSession, opencodeSession]);

  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await setupRoutes(page, initPayload, TERMINAL_OPENCODE);
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await injectState(page, initPayload, TERMINAL_OPENCODE, 'sess-opencode-3');

    await page.screenshot({
      path: join(OUTPUT_DIR, 'desktop-both-opencode.png'),
      fullPage: false,
    });
    console.log('  Saved: remotion/public/desktop-both-opencode.png');
  } finally {
    await context.close();
  }
}

// 5. Mobile with Claude tab
async function captureMobileClaude(browser) {
  console.log('\n5/6 Capturing mobile-claude.png...');

  const claudeSession = makeSession('sess-claude-m1', 'w1-my-project', 'claude', 'busy');
  const initPayload = buildInitPayload([claudeSession]);

  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await setupRoutes(page, initPayload, TERMINAL_CLAUDE);
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await injectState(page, initPayload, TERMINAL_CLAUDE, 'sess-claude-m1');

    await page.screenshot({
      path: join(OUTPUT_DIR, 'mobile-claude.png'),
      fullPage: false,
    });
    console.log('  Saved: remotion/public/mobile-claude.png');
  } finally {
    await context.close();
  }
}

// 6. Mobile with OpenCode tab
async function captureMobileOpencode(browser) {
  console.log('\n6/6 Capturing mobile-opencode.png...');

  const opencodeSession = makeSession('sess-opencode-m1', 'w1-my-project', 'opencode', 'busy');
  const initPayload = buildInitPayload([opencodeSession]);

  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await setupRoutes(page, initPayload, TERMINAL_OPENCODE);
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await injectState(page, initPayload, TERMINAL_OPENCODE, 'sess-opencode-m1');

    await page.screenshot({
      path: join(OUTPUT_DIR, 'mobile-opencode.png'),
      fullPage: false,
    });
    console.log('  Saved: remotion/public/mobile-opencode.png');
  } finally {
    await context.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('Codeman Video Screenshot Capture');
  console.log('='.repeat(60));
  console.log(`Port: ${PORT}`);
  console.log(`Desktop: ${DESKTOP_VIEWPORT.width}x${DESKTOP_VIEWPORT.height}`);
  console.log(`Mobile:  ${MOBILE_VIEWPORT.width}x${MOBILE_VIEWPORT.height} @2x`);
  console.log(`Output:  ${OUTPUT_DIR}`);
  console.log('');

  const server = await startStaticServer();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    await captureDesktopWelcome(browser);
    await captureDesktopClaude(browser);
    await captureDesktopBothClaude(browser);
    await captureDesktopBothOpencode(browser);
    await captureMobileClaude(browser);
    await captureMobileOpencode(browser);

    console.log('\n' + '='.repeat(60));
    console.log('All 6 screenshots captured!');
    console.log('='.repeat(60));
    console.log('\nOutput files:');
    console.log('  remotion/public/desktop-welcome.png');
    console.log('  remotion/public/desktop-claude.png');
    console.log('  remotion/public/desktop-both-claude.png');
    console.log('  remotion/public/desktop-both-opencode.png');
    console.log('  remotion/public/mobile-claude.png');
    console.log('  remotion/public/mobile-opencode.png');
  } catch (err) {
    console.error('\nFatal error:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
    console.log('\nDone.');
  }
}

process.on('SIGINT', () => {
  console.log('\nInterrupted.');
  process.exit(1);
});

main();
