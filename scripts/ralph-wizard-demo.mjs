#!/usr/bin/env node
/**
 * Ralph Loop Wizard Demo - runs through browser, leaves session running
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE_URL = 'https://localhost:3000';
const CASE_NAME = 'codeman-ios';

async function main() {
  console.log('🎬 Starting Ralph Loop Wizard demo...\n');

  // Launch browser (visible)
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
    slowMo: 500, // Slow down so you can see what's happening
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  console.log('📱 Opening Codeman web UI...');
  await page.goto(BASE_URL);
  await page.waitForLoadState('networkidle');

  console.log('🔄 Clicking Ralph Loop button...');
  await page.waitForSelector('.btn-ralph', { timeout: 10000 });
  await page.click('.btn-ralph');

  console.log('📋 Waiting for wizard modal...');
  await page.waitForSelector('#ralphWizardModal.active', { timeout: 10000 });

  // Select case
  console.log(`📁 Selecting case: ${CASE_NAME}`);
  await page.selectOption('#ralphCaseSelect', CASE_NAME);

  // Load initprompt.md if it exists
  const initPromptPath = join(homedir(), 'codeman-cases', CASE_NAME, 'initprompt.md');
  let taskDescription = 'Build an awesome iOS app for Codeman!';
  if (existsSync(initPromptPath)) {
    taskDescription = readFileSync(initPromptPath, 'utf-8').trim();
    console.log(`📝 Loaded initprompt.md (${taskDescription.length} chars)`);
  }

  // Enter task description
  await page.fill('#ralphTaskDescription', taskDescription);

  // Set completion phrase
  await page.evaluate(() => {
    const input = document.getElementById('ralphCompletionPhrase');
    if (input) input.value = 'IOS_APP_COMPLETE';
  });

  console.log('➡️ Clicking Next (Step 1 → Step 2)...');
  await page.click('#ralphNextBtn');
  await page.waitForTimeout(1000);

  // Check for existing plan
  const existingPlan = await page.$('#existingPlanSection:not(.hidden)');
  if (existingPlan) {
    console.log('📋 Existing plan detected, using it...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const useBtn = btns.find(b => b.textContent?.includes('Use Existing'));
      if (useBtn) useBtn.click();
    });
    await page.waitForTimeout(500);
  }

  console.log('➡️ Clicking Next (Step 2 → Step 3)...');
  await page.click('#ralphNextBtn');
  await page.waitForTimeout(1000);

  console.log('🚀 Clicking Start Loop...');
  await page.click('#ralphStartBtn');

  // Wait for session to be created
  console.log('⏳ Waiting for session to start...');
  await page.waitForSelector('.session-tab', { timeout: 30000 });

  console.log('\n✅ Ralph Loop started! Session is running.');
  console.log('👀 Browser will stay open so you can observe.');
  console.log('   Press Ctrl+C in terminal when done.\n');

  // Keep the script running
  await new Promise(() => {});
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
