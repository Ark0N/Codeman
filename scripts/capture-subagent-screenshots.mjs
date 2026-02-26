#!/usr/bin/env node
/**
 * Capture screenshots and GIFs of Codeman's subagent visualization
 *
 * Uses real Claude sessions that spawn actual subagents via the Task tool.
 *
 * Usage:
 *   node scripts/capture-subagent-screenshots.mjs
 *
 * Requires:
 *   - npx playwright install chromium
 *   - ffmpeg (for GIF conversion)
 *   - Claude CLI configured
 *   - Web server NOT running on port 3000 (script starts its own)
 */

import { chromium } from 'playwright';
import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, unlinkSync, rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(PROJECT_ROOT, 'docs', 'images');
const CASES_DIR = join(process.env.HOME, 'codeman-cases');

// Configuration
const PORT = 3198; // Unique port for capture script (avoid 3199 conflicts)
const BASE_URL = `http://localhost:${PORT}`;
const CASE_NAME = `screenshot-capture-${Date.now()}`;
const VIEWPORT = { width: 1280, height: 720 };

// Use linked case pointing to real codebase for actual code exploration
const USE_REAL_CODEBASE = true;
const REAL_CODEBASE_PATH = PROJECT_ROOT;

// Timeouts (generous for real Claude sessions)
const TIMEOUTS = {
  SERVER_STARTUP: 15000,
  SESSION_READY: 60000,
  AGENT_SPAWN: 120000,  // 2 minutes for agents to spawn
  AGENT_ACTIVITY: 30000, // 30s for activity after spawn
};

// Prompt designed to trigger multiple parallel Task agents
const SUBAGENT_PROMPT = `Explore this codebase in parallel:
1. Use an Explore agent to find all TypeScript interfaces
2. Use another Explore agent to understand the test structure
3. Use a third agent to check the API endpoints

Run all three agents in parallel and summarize findings.`;

// Ensure output directory exists
try { mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}

let serverProcess = null;
let browser = null;

/**
 * Start the Codeman web server
 */
async function startServer() {
  console.log(`Starting Codeman server on port ${PORT}...`);

  serverProcess = spawn('npx', ['tsx', 'src/index.ts', 'web', '--port', String(PORT)], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  serverProcess.stdout.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('error') || msg.includes('Error')) {
      console.log('Server:', msg.trim());
    }
  });

  serverProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    // Log errors but don't exit - let the startup check handle port conflicts
    if (!msg.includes('DeprecationWarning') && !msg.includes('[RalphTracker]') && !msg.includes('[Server] Restored')) {
      console.log('Server stderr:', msg.trim());
    }
  });

  // Wait for server to be ready
  const start = Date.now();
  while (Date.now() - start < TIMEOUTS.SERVER_STARTUP) {
    try {
      const response = await fetch(`${BASE_URL}/api/status`);
      if (response.ok) {
        console.log('✓ Server ready');
        return;
      }
    } catch {
      // Not ready yet
    }
    await sleep(200);
  }
  throw new Error('Server failed to start within timeout');
}

/**
 * Stop the server
 */
function stopServer() {
  if (serverProcess) {
    console.log('Stopping server...');
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll for subagents via API
 */
async function pollSubagents() {
  try {
    const response = await fetch(`${BASE_URL}/api/subagents`);
    if (response.ok) {
      const data = await response.json();
      return data.data || [];
    }
  } catch {
    // Ignore errors
  }
  return [];
}

/**
 * Create a case via API
 */
async function createCase(name) {
  const response = await fetch(`${BASE_URL}/api/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create case: ${await response.text()}`);
  }
  return response.json();
}

/**
 * Link an existing folder as a case via API
 */
async function linkCase(name, folderPath) {
  const response = await fetch(`${BASE_URL}/api/cases/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path: folderPath }),
  });
  if (!response.ok) {
    throw new Error(`Failed to link case: ${await response.text()}`);
  }
  return response.json();
}

/**
 * Quick-start a Claude session
 */
async function quickStart(caseName) {
  const response = await fetch(`${BASE_URL}/api/quick-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseName, mode: 'claude' }),
  });
  if (!response.ok) {
    throw new Error(`Failed to quick-start: ${await response.text()}`);
  }
  return response.json();
}

/**
 * Delete a session
 */
async function deleteSession(sessionId) {
  try {
    await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
  } catch {
    // Ignore errors
  }
}

/**
 * Delete a case directory (only for non-linked cases)
 */
function deleteCase(caseName, isLinked = false) {
  if (isLinked) {
    // For linked cases, just log - the link will be cleaned up when server stops
    console.log(`✓ Linked case ${caseName} will be unlinked`);
    return;
  }
  const casePath = join(CASES_DIR, caseName);
  if (existsSync(casePath)) {
    try {
      rmSync(casePath, { recursive: true, force: true });
      console.log(`✓ Cleaned up case: ${caseName}`);
    } catch (err) {
      console.log(`Warning: Could not delete case: ${err.message}`);
    }
  }
}

/**
 * Configure localStorage settings for subagent visibility
 */
async function configureSettings(page) {
  await page.evaluate(() => {
    const settings = {
      showSubagents: true,
      subagentTrackingEnabled: true,
      subagentActiveTabOnly: false, // Show all subagents regardless of active tab
      showMonitor: true,
    };
    localStorage.setItem('codeman-app-settings', JSON.stringify(settings));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(500);
}

/**
 * Send input to a session via API
 * Note: useScreen requires \r at end to submit
 */
async function sendInput(sessionId, text) {
  const response = await fetch(`${BASE_URL}/api/sessions/${sessionId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text + '\r', useScreen: true }),
  });
  return response.ok;
}

/**
 * Get subagents for a specific session
 */
async function getSessionSubagents(sessionId) {
  try {
    const response = await fetch(`${BASE_URL}/api/sessions/${sessionId}/subagents`);
    if (response.ok) {
      const data = await response.json();
      return data.data || [];
    }
  } catch {
    // Ignore errors
  }
  return [];
}

/**
 * Convert video to optimized GIF
 */
function convertToGif(inputPath, outputPath) {
  console.log('Converting video to GIF...');
  const palettePath = join(OUTPUT_DIR, 'palette.png');

  try {
    // Generate palette for better quality
    execSync(`ffmpeg -y -i "${inputPath}" -vf "fps=15,scale=1280:-1:flags=lanczos,palettegen" "${palettePath}"`, {
      stdio: 'pipe',
    });

    // Create GIF using palette
    execSync(`ffmpeg -y -i "${inputPath}" -i "${palettePath}" -lavfi "fps=15,scale=1280:-1:flags=lanczos[x];[x][1:v]paletteuse" "${outputPath}"`, {
      stdio: 'pipe',
    });

    // Clean up palette
    if (existsSync(palettePath)) {
      unlinkSync(palettePath);
    }

    console.log(`✓ GIF saved: ${outputPath}`);
  } catch (err) {
    console.error('Failed to convert to GIF:', err.message);
    throw err;
  }
}

/**
 * Main capture flow
 */
async function capture() {
  console.log('='.repeat(60));
  console.log('Codeman Subagent Screenshot Capture');
  console.log('='.repeat(60));
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(`Case name: ${CASE_NAME}`);
  console.log('');

  let sessionId = null;

  try {
    // Start server
    await startServer();

    // Launch browser
    console.log('Launching browser...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: OUTPUT_DIR, size: VIEWPORT },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    // Navigate to Codeman
    console.log('Loading Codeman...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1000);

    // Configure settings for subagent visibility
    console.log('Configuring settings...');
    await configureSettings(page);

    // Create or link case
    if (USE_REAL_CODEBASE) {
      console.log(`Linking case ${CASE_NAME} to ${REAL_CODEBASE_PATH}...`);
      await linkCase(CASE_NAME, REAL_CODEBASE_PATH);
    } else {
      console.log(`Creating case: ${CASE_NAME}...`);
      await createCase(CASE_NAME);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(500);

    // Select case in dropdown
    await page.selectOption('#quickStartCase', CASE_NAME);

    // Quick-start session
    console.log('Starting Claude session...');
    const startResult = await quickStart(CASE_NAME);
    if (!startResult.success) {
      throw new Error(`Quick-start failed: ${startResult.error}`);
    }
    sessionId = startResult.sessionId;
    console.log(`✓ Session started: ${sessionId}`);

    // Wait for session tab and terminal
    await page.waitForSelector('.session-tab', { timeout: TIMEOUTS.SESSION_READY });
    await page.waitForSelector('.xterm', { timeout: TIMEOUTS.SESSION_READY });
    console.log('✓ Terminal ready');

    // IMPORTANT: Click on OUR session tab to ensure it's selected
    // (other sessions from state.json may be present)
    console.log('Selecting our session tab...');
    const ourTab = page.locator(`.session-tab[data-id="${sessionId}"]`);
    if (await ourTab.count() > 0) {
      await ourTab.click();
      console.log('✓ Selected our session tab');
    } else {
      // Fallback: click the last tab (most recently created)
      const tabs = page.locator('.session-tab');
      const count = await tabs.count();
      if (count > 0) {
        await tabs.nth(count - 1).click();
        console.log('✓ Selected last session tab');
      }
    }
    await sleep(1000);

    // Wait for Claude to initialize (needs time to show prompt)
    console.log('Waiting for Claude to initialize...');
    await sleep(10000);

    // Screenshot 1: Initial state (before subagents)
    await page.screenshot({
      path: join(OUTPUT_DIR, 'subagent-before.png'),
      fullPage: false,
    });
    console.log('✓ Saved: subagent-before.png');

    // Send prompt via API (more reliable than keyboard simulation)
    console.log('Sending prompt to trigger subagents via API...');
    const sent = await sendInput(sessionId, SUBAGENT_PROMPT);
    if (!sent) {
      console.log('⚠ Failed to send input via API, trying keyboard...');
      await page.click('.xterm');
      await sleep(500);
      await page.keyboard.type(SUBAGENT_PROMPT, { delay: 5 });
      await page.keyboard.press('Enter');
    } else {
      console.log('✓ Prompt sent via API');
    }

    // Give Claude time to start processing before polling
    console.log('Waiting for Claude to start processing...');
    await sleep(15000);

    // Wait for subagents to spawn (filter to our session only)
    console.log('Waiting for subagents to spawn...');
    const spawnStart = Date.now();
    let subagents = [];
    let spawnedCount = 0;

    while (Date.now() - spawnStart < TIMEOUTS.AGENT_SPAWN) {
      // Use session-specific endpoint to only get our subagents
      subagents = await getSessionSubagents(sessionId);
      if (subagents.length >= 2) {
        console.log(`✓ Found ${subagents.length} subagents for our session!`);
        spawnedCount = subagents.length;
        break;
      }
      if (subagents.length > 0 && subagents.length !== spawnedCount) {
        console.log(`  Found ${subagents.length} subagent(s) for our session...`);
        spawnedCount = subagents.length;
      }
      await sleep(2000);
    }

    if (subagents.length === 0) {
      console.log('⚠ No subagents spawned within timeout');
      console.log('  This may happen if Claude chose not to use parallel agents');
      console.log('  Capturing current state anyway...');
    }

    // Wait a bit more for windows to open and activity to appear
    if (subagents.length > 0) {
      console.log('Waiting for agent activity...');
      await sleep(5000);

      // Check if subagent windows are visible
      const windowCount = await page.locator('.subagent-window').count();
      console.log(`  Subagent windows visible: ${windowCount}`);

      // If windows aren't auto-opening, try to open them manually
      if (windowCount < subagents.length) {
        console.log('  Opening subagent windows...');
        for (const agent of subagents) {
          await page.evaluate((agentId) => {
            if (window.app && window.app.openSubagentWindow) {
              window.app.openSubagentWindow(agentId);
            }
          }, agent.agentId);
          await sleep(500);
        }
      }
    }

    // Wait for activity in windows
    await sleep(3000);

    // Screenshot 2: Agents spawned (the main screenshot)
    await page.screenshot({
      path: join(OUTPUT_DIR, 'subagent-spawn.png'),
      fullPage: false,
    });
    console.log('✓ Saved: subagent-spawn.png');

    // If we have multiple agents, capture that state
    if (subagents.length >= 2) {
      await page.screenshot({
        path: join(OUTPUT_DIR, 'subagent-multiple.png'),
        fullPage: false,
      });
      console.log('✓ Saved: subagent-multiple.png');
    }

    // Wait for more activity and capture activity screenshot
    console.log('Waiting for tool activity...');
    await sleep(TIMEOUTS.AGENT_ACTIVITY);

    await page.screenshot({
      path: join(OUTPUT_DIR, 'subagent-activity.png'),
      fullPage: false,
    });
    console.log('✓ Saved: subagent-activity.png');

    // Close context to save video
    console.log('Saving video recording...');
    await context.close();

    // Find the recorded video
    const videoPath = await page.video()?.path();
    if (videoPath && existsSync(videoPath)) {
      const gifPath = join(OUTPUT_DIR, 'subagent-demo.gif');
      convertToGif(videoPath, gifPath);

      // Clean up video file
      try {
        unlinkSync(videoPath);
      } catch {
        // Ignore
      }
    } else {
      console.log('⚠ Video recording not found');
    }

    console.log('');
    console.log('='.repeat(60));
    console.log('Capture complete!');
    console.log('='.repeat(60));
    console.log('');
    console.log('Screenshots saved to:', OUTPUT_DIR);
    console.log('');
    console.log('Files:');
    console.log('  - subagent-before.png   (initial state)');
    console.log('  - subagent-spawn.png    (agents appearing)');
    if (subagents.length >= 2) {
      console.log('  - subagent-multiple.png (multiple agents)');
    }
    console.log('  - subagent-activity.png (tool activity)');
    console.log('  - subagent-demo.gif     (animated demo)');

  } catch (err) {
    console.error('');
    console.error('Error during capture:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    // Cleanup
    console.log('');
    console.log('Cleaning up...');

    if (browser) {
      await browser.close().catch(() => {});
    }

    if (sessionId) {
      await deleteSession(sessionId);
    }

    deleteCase(CASE_NAME, USE_REAL_CODEBASE);
    stopServer();

    console.log('Done.');
  }
}

// Handle interrupts
process.on('SIGINT', () => {
  console.log('\nInterrupted, cleaning up...');
  stopServer();
  if (browser) {
    browser.close().catch(() => {});
  }
  process.exit(1);
});

// Run
capture();
