#!/usr/bin/env node
/**
 * Start Ralph Loop on PRODUCTION server (port 3000) using E2E fixtures
 * Uses initprompt.md and @fix_plan.md from the case directory
 * Does NOT clean up - leaves session running for user verification
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE_URL = 'https://localhost:3000';
const CASE_NAME = 'codeman-ios';
const CASE_PATH = join(homedir(), 'codeman-cases', CASE_NAME);

async function main() {
  // Read initprompt.md
  const initPromptPath = join(CASE_PATH, 'initprompt.md');
  const fixPlanPath = join(CASE_PATH, '@fix_plan.md');

  if (!existsSync(initPromptPath)) {
    console.error(`Missing: ${initPromptPath}`);
    process.exit(1);
  }

  const taskDescription = readFileSync(initPromptPath, 'utf-8').trim();
  const hasFixPlan = existsSync(fixPlanPath);

  console.log('=== Ralph Loop Wizard E2E (Production) ===');
  console.log(`Case: ${CASE_NAME}`);
  console.log(`initprompt.md: ${taskDescription.length} chars`);
  console.log(`@fix_plan.md exists: ${hasFixPlan}`);
  console.log('');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Capture browser console logs
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.text().includes('RalphWizard')) {
      console.log(`[Browser ${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', err => console.log(`[Browser Error] ${err.message}`));

  try {
    console.log('[1/10] Navigating to Codeman...');
    await page.goto(BASE_URL, { timeout: 10000 });

    console.log('[2/10] Clicking Ralph Loop button (.btn-ralph)...');
    await page.waitForSelector('.btn-ralph', { timeout: 5000 });
    await page.click('.btn-ralph');

    console.log('[3/10] Waiting for wizard modal (#ralphWizardModal.active)...');
    await page.waitForSelector('#ralphWizardModal.active', { timeout: 5000 });

    console.log(`[4/10] Selecting case: ${CASE_NAME}...`);
    await page.selectOption('#ralphCaseSelect', CASE_NAME);

    console.log('[5/10] Filling task description from initprompt.md...');
    await page.fill('#ralphTaskDescription', taskDescription);

    console.log('[6/10] Setting completion phrase: IOS_APP_COMPLETE...');
    await page.evaluate(() => {
      const input = document.getElementById('ralphCompletionPhrase');
      if (input) input.value = 'IOS_APP_COMPLETE';
    });

    console.log('[7/10] Clicking Next -> Step 2...');
    await page.evaluate(() => {
      document.getElementById('ralphNextBtn')?.click();
    });
    await page.waitForTimeout(1000);

    // Check for existing @fix_plan.md detection
    const existingPlanSection = await page.$('#existingPlanSection:not(.hidden)');
    if (existingPlanSection) {
      console.log('[8/10] Existing @fix_plan.md detected, clicking "Use Existing"...');
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const useBtn = btns.find(b => b.textContent?.includes('Use Existing'));
        if (useBtn) useBtn.click();
      });
      await page.waitForTimeout(500);
    } else {
      console.log('[8/10] No existing plan section visible...');
    }

    console.log('[9/10] Clicking Next -> Step 3 (Launch)...');
    await page.evaluate(() => {
      document.getElementById('ralphNextBtn')?.click();
    });
    await page.waitForTimeout(1000);

    console.log('[10/10] Clicking Start Loop...');
    await page.evaluate(() => {
      document.getElementById('ralphStartBtn')?.click();
    });

    console.log('Waiting for session tab to appear...');
    await page.waitForSelector('.session-tab', { timeout: 30000 });

    // IMPORTANT: Wait for the wizard's async startRalphLoop() to complete
    // The wizard needs time to: wait for session ready, then send the prompt
    console.log('Waiting for wizard to send prompt (checking for busy status)...');

    let session = null;
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max

    while (attempts < maxAttempts) {
      await page.waitForTimeout(1000);

      const sessions = await page.evaluate(async () => {
        const res = await fetch('/api/sessions');
        return res.json();
      });

      session = sessions
        .filter(s => s.workingDir?.includes('codeman-ios'))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

      if (session) {
        // Check if session is working (prompt was sent)
        const detail = await page.evaluate(async (id) => {
          const res = await fetch(`/api/sessions/${id}`);
          return res.json();
        }, session.id);

        if (detail.isWorking || detail.tokens?.total > 0) {
          console.log(`Session is working! Tokens: ${detail.tokens?.total}`);
          break;
        }
        console.log(`  Attempt ${attempts + 1}: status=${detail.status}, tokens=${detail.tokens?.total || 0}`);
      }

      attempts++;
    }

    if (!session || attempts >= maxAttempts) {
      console.error('WARNING: Session may not have received the prompt!');
    }

    console.log('');
    console.log('========================================');
    console.log('SUCCESS! Ralph Loop started.');
    console.log('========================================');
    console.log(`Session ID: ${session?.id}`);
    console.log(`Screen: codeman-${session?.id?.slice(0, 8)}`);
    console.log(`Status: ${session?.status}`);
    console.log('');
    console.log('Session is now running. View at: https://localhost:3000');
    console.log('');
    console.log('To delete when done:');
    console.log(`  curl -sk -X DELETE "https://localhost:3000/api/sessions/${session?.id}"`);
    console.log('========================================');

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
