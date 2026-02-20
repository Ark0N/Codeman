#!/usr/bin/env node
/**
 * Capture a GIF of subagent spawning on the LIVE Claudeman server.
 *
 * Connects to the running server on port 3000, creates a test session,
 * sends a prompt that spawns 3 parallel agents, and captures a tight
 * 8-second GIF starting right before agents spawn.
 *
 * Usage:  node scripts/capture-subagent-gif.mjs
 * Output: docs/images/subagent-demo.gif
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, unlinkSync, mkdirSync, statSync, cpSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(PROJECT_ROOT, 'docs', 'images');
const BASE_URL = 'http://localhost:3000';
const CASE_NAME = 'acme-backend';
const VIEWPORT = { width: 1440, height: 810 };

// GIF settings
const GIF_DURATION = 25;  // record long, trim later
const GIF_FPS = 6;
const GIF_WIDTH = 960;
const GIF_COLORS = 128;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Prompt that triggers exactly 3 parallel Explore agents with real research work
const PROMPT = `Analyze this codebase using exactly 3 Explore agents in parallel. IMPORTANT: Launch exactly 3 agents, no more, no fewer. Each agent should do its own research without spawning sub-agents:

1. Agent 1: Find all REST API endpoints and their HTTP methods in server.ts
2. Agent 2: Analyze the respawn controller state machine in respawn-controller.ts
3. Agent 3: Find all SSE event types broadcast by the server

Run all three in parallel. After they complete, give me a brief summary.`;

try { mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res.json();
}

async function capture() {
  console.log('Subagent GIF Capture');
  console.log('====================');

  // Verify server is running
  try {
    await fetch(`${BASE_URL}/api/status`);
  } catch {
    console.error('Server not running on port 3000');
    process.exit(1);
  }
  console.log('✓ Server reachable');

  let sessionId = null;
  let browser = null;

  try {
    // Create case and seed with real source files
    console.log(`Creating case: ${CASE_NAME}`);
    const caseDir = join(process.env.HOME, 'claudeman-cases', CASE_NAME);
    const caseSrc = join(caseDir, 'src');
    const caseTest = join(caseDir, 'test');
    mkdirSync(caseSrc, { recursive: true });
    mkdirSync(caseTest, { recursive: true });

    // Copy real source files so agents have content to analyze
    const filesToCopy = [
      ['src/types.ts', 'src/types.ts'],
      ['src/session.ts', 'src/session.ts'],
      ['src/respawn-controller.ts', 'src/respawn-controller.ts'],
      ['src/web/server.ts', 'src/server.ts'],
      ['src/subagent-watcher.ts', 'src/subagent-watcher.ts'],
      ['src/ralph-tracker.ts', 'src/ralph-tracker.ts'],
      ['CLAUDE.md', 'CLAUDE.md'],
      ['tsconfig.json', 'tsconfig.json'],
      ['package.json', 'package.json'],
    ];
    for (const [from, to] of filesToCopy) {
      const src = join(PROJECT_ROOT, from);
      if (existsSync(src)) cpSync(src, join(caseDir, to));
    }
    console.log(`✓ Seeded ${filesToCopy.length} files`);

    await api('/api/cases/link', {
      method: 'POST',
      body: JSON.stringify({ name: CASE_NAME, path: caseDir }),
    });

    // Launch browser
    console.log('Launching browser...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--force-color-profile=srgb',
        '--disable-gpu-compositing',
      ],
    });

    // --- Phase 1: Setup (no recording) ---
    const setupContext = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: 'dark',
    });
    const setupPage = await setupContext.newPage();
    setupPage.setDefaultTimeout(60000);

    await setupPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1000);

    // Configure settings: enable subagents, disable Files pane
    await setupPage.evaluate(() => {
      const existing = JSON.parse(localStorage.getItem('claudeman-app-settings') || '{}');
      Object.assign(existing, {
        showSubagents: true,
        subagentTrackingEnabled: true,
        subagentActiveTabOnly: false,
        showMonitor: false,
        showProjectInsights: false,
        showFileBrowser: false,
      });
      localStorage.setItem('claudeman-app-settings', JSON.stringify(existing));
    });
    await setupPage.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1000);

    // Quick-start session
    console.log('Starting session...');
    const startResult = await api('/api/quick-start', {
      method: 'POST',
      body: JSON.stringify({ caseName: CASE_NAME, mode: 'claude' }),
    });
    if (!startResult.success) throw new Error(`Quick-start failed: ${startResult.error}`);
    sessionId = startResult.sessionId;
    console.log(`✓ Session: ${sessionId}`);

    // Wait for terminal and select our tab
    await setupPage.waitForSelector('.xterm', { timeout: 30000 });
    const ourTab = setupPage.locator(`.session-tab[data-id="${sessionId}"]`);
    if (await ourTab.count() > 0) await ourTab.click();
    console.log('✓ Terminal ready');

    // Wait for Claude CLI to initialize
    console.log('Waiting for Claude CLI...');
    await sleep(15000);

    // Send the prompt
    console.log('Sending prompt...');
    await api(`/api/sessions/${sessionId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: PROMPT, useMux: true }),
    });
    await sleep(200);
    await api(`/api/sessions/${sessionId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: '\r', useMux: true }),
    });
    console.log('✓ Prompt sent');

    // Wait for Claude to start thinking (first subagent imminent)
    console.log('Waiting for Claude to start processing...');
    const pollStart = Date.now();
    let firstAgentSeen = false;

    while (Date.now() - pollStart < 180000) {
      const res = await api(`/api/sessions/${sessionId}/subagents`);
      const agents = res.data || [];
      if (agents.length >= 1) {
        console.log(`  First agent detected! (${agents.length} total)`);
        firstAgentSeen = true;
        break;
      }
      await sleep(1000);
    }

    if (!firstAgentSeen) {
      console.log('⚠ No agents detected after 3 min, recording anyway...');
    }

    // Wait for all 3 agents to spawn and start working
    console.log('Waiting for all agents to spawn and start working...');
    const spawnWait = Date.now();
    while (Date.now() - spawnWait < 60000) {
      const res = await api(`/api/sessions/${sessionId}/subagents`);
      const agents = res.data || [];
      if (agents.length >= 3) {
        console.log(`  All ${agents.length} agents spawned`);
        break;
      }
      console.log(`  ${agents.length}/3 agents...`);
      await sleep(2000);
    }

    // Let agents work for a few seconds so there's content in the windows
    console.log('Letting agents work for 5s...');
    await sleep(5000);

    // Close setup context (we'll grab localStorage via the API/new context)
    await setupContext.close();
    console.log('✓ Setup phase complete');

    // --- Phase 2: Record (start video right before the action) ---
    console.log('Starting recording context...');
    const recordContext = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: 'dark',
      recordVideo: { dir: OUTPUT_DIR, size: VIEWPORT },
    });
    const recordPage = await recordContext.newPage();
    recordPage.setDefaultTimeout(30000);

    await recordPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(500);

    // Re-apply settings (new context = fresh localStorage)
    await recordPage.evaluate(() => {
      const existing = JSON.parse(localStorage.getItem('claudeman-app-settings') || '{}');
      Object.assign(existing, {
        showSubagents: true,
        subagentTrackingEnabled: true,
        subagentActiveTabOnly: false,
        showMonitor: false,
        showProjectInsights: false,
        showFileBrowser: false,
      });
      localStorage.setItem('claudeman-app-settings', JSON.stringify(existing));
    });
    await recordPage.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1000);

    // Select our session tab
    const recTab = recordPage.locator(`.session-tab[data-id="${sessionId}"]`);
    if (await recTab.count() > 0) await recTab.click();
    await sleep(500);

    // Force open any subagent windows that exist
    const agentRes = await api(`/api/sessions/${sessionId}/subagents`);
    for (const agent of (agentRes.data || [])) {
      await recordPage.evaluate((id) => {
        if (window.app?.openSubagentWindow) window.app.openSubagentWindow(id);
      }, agent.agentId);
      await sleep(300);
    }

    const recordStart = Date.now();
    console.log('🔴 Recording...');

    // Poll for more agents and open their windows as they appear
    let maxSeen = (agentRes.data || []).length;
    while (Date.now() - recordStart < 30000) {
      const res = await api(`/api/sessions/${sessionId}/subagents`);
      const agents = res.data || [];
      if (agents.length > maxSeen) {
        console.log(`  ${agents.length} agent(s) now`);
        for (const agent of agents) {
          await recordPage.evaluate((id) => {
            const existing = document.querySelector(`.subagent-window[data-agent-id="${id}"]`);
            if (!existing && window.app?.openSubagentWindow) window.app.openSubagentWindow(id);
          }, agent.agentId);
        }
        maxSeen = agents.length;
      }
      await sleep(1000);
    }
    console.log(`  Recorded ${((Date.now() - recordStart) / 1000).toFixed(0)}s total`);

    // Take a static screenshot too
    await recordPage.screenshot({
      path: join(OUTPUT_DIR, 'subagent-spawn.png'),
      fullPage: false,
    });
    console.log('✓ Saved: subagent-spawn.png');

    // Finalize video
    console.log('Finalizing video...');
    const videoPath = await recordPage.video()?.path();
    await recordContext.close();

    // --- Phase 3: Convert to optimized GIF ---
    if (videoPath && existsSync(videoPath)) {
      const gifPath = join(OUTPUT_DIR, 'subagent-demo.gif');
      const palettePath = join(OUTPUT_DIR, '_palette.png');

      // Probe video duration to calculate start offset
      const probeOut = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
        { encoding: 'utf8' }
      ).trim();
      const videoDuration = parseFloat(probeOut);
      // Skip the first ~2s (page load/reload) and take GIF_DURATION seconds
      const ssOffset = Math.max(0, Math.min(2, videoDuration - GIF_DURATION));
      console.log(`Video: ${videoDuration.toFixed(1)}s, extracting ${GIF_DURATION}s from ${ssOffset.toFixed(1)}s`);

      console.log('Converting to GIF...');
      // Boost contrast/saturation for vivid terminal colors, then encode
      // stats_mode=single = per-frame palette (best color accuracy for few accent colors on dark bg)
      const filters = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,eq=contrast=1.1:saturation=1.3:brightness=0.02`;
      execSync(
        `ffmpeg -y -ss ${ssOffset} -t ${GIF_DURATION} -i "${videoPath}" ` +
        `-vf "${filters},split[s0][s1];[s0]palettegen=max_colors=${GIF_COLORS}:stats_mode=single:reserve_transparent=0[p];[s1][p]paletteuse=dither=floyd_steinberg:diff_mode=rectangle:new=1" ` +
        `-loop 0 "${gifPath}"`,
        { stdio: 'pipe' }
      );

      try { unlinkSync(palettePath); } catch {}
      try { unlinkSync(videoPath); } catch {}

      const sizeMB = (existsSync(gifPath) ? statSync(gifPath).size / (1024 * 1024) : 0).toFixed(1);
      console.log(`✓ GIF saved: ${gifPath} (${sizeMB} MB)`);
    } else {
      console.log('⚠ No video recording found');
    }

    console.log('\nDone!');

  } catch (err) {
    console.error('Error:', err.message);
    process.exitCode = 1;
  } finally {
    // Cleanup: ONLY delete the session WE created
    if (sessionId) {
      console.log(`Cleaning up session: ${sessionId}`);
      await api(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
  }
}

process.on('SIGINT', () => {
  console.log('\nInterrupted');
  process.exit(1);
});

capture();
