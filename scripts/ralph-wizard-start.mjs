#!/usr/bin/env node
/**
 * Start Ralph Loop via wizard on production server, leave it running
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE_URL = 'https://localhost:3000';
const CASE_NAME = 'codeman-ios';

async function main() {
  console.log('Starting Ralph Loop via wizard on production server...\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  console.log('1. Opening Codeman web UI...');
  await page.goto(BASE_URL);
  await page.waitForLoadState('networkidle');

  console.log('2. Clicking Ralph Loop button...');
  await page.waitForSelector('.btn-ralph', { timeout: 10000 });
  await page.click('.btn-ralph');

  console.log('3. Waiting for wizard modal...');
  await page.waitForSelector('#ralphWizardModal.active', { timeout: 10000 });

  console.log(`4. Selecting case: ${CASE_NAME}`);
  await page.selectOption('#ralphCaseSelect', CASE_NAME);

  // Load initprompt.md
  const initPromptPath = join(homedir(), 'codeman-cases', CASE_NAME, 'initprompt.md');
  let taskDescription = 'Build an awesome iOS app for Codeman!';
  if (existsSync(initPromptPath)) {
    taskDescription = readFileSync(initPromptPath, 'utf-8').trim();
    console.log(`5. Loaded initprompt.md (${taskDescription.length} chars)`);
  } else {
    console.log('5. Using default task description');
  }

  await page.fill('#ralphTaskDescription', taskDescription);

  // Set completion phrase
  await page.evaluate(() => {
    const input = document.getElementById('ralphCompletionPhrase');
    if (input) input.value = 'IOS_APP_COMPLETE';
  });

  console.log('6. Clicking Next (Step 1 -> Step 2)...');
  await page.click('#ralphNextBtn');
  await page.waitForTimeout(1000);

  // Check for existing plan
  const existingPlan = await page.$('#existingPlanSection:not(.hidden)');
  if (existingPlan) {
    console.log('7. Existing plan detected, using it...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const useBtn = btns.find(b => b.textContent?.includes('Use Existing'));
      if (useBtn) useBtn.click();
    });
    await page.waitForTimeout(500);
  } else {
    console.log('7. No existing plan, proceeding...');
  }

  console.log('8. Clicking Next (Step 2 -> Step 3)...');
  await page.click('#ralphNextBtn');
  await page.waitForTimeout(1000);

  console.log('9. Clicking Start Loop...');
  await page.click('#ralphStartBtn');

  console.log('10. Waiting for session to be created...');
  await page.waitForSelector('.session-tab', { timeout: 30000 });

  // Get session info from the API
  const sessions = await page.evaluate(async () => {
    const res = await fetch('/api/sessions');
    return res.json();
  });

  const iosSession = sessions.find(s => s.workingDir?.includes('codeman-ios'));

  console.log('\n========================================');
  console.log('SUCCESS! Ralph Loop started.');
  console.log('========================================');
  console.log(`Session ID: ${iosSession?.id}`);
  console.log(`Screen: codeman-${iosSession?.id?.slice(0, 8)}`);
  console.log(`Working Dir: ${iosSession?.workingDir}`);
  console.log('\nThe session is now running on your production server.');
  console.log('View it at: https://localhost:3000');
  console.log('Kill it when done via the web UI or: curl -X DELETE https://localhost:3000/api/sessions/' + iosSession?.id);
  console.log('========================================\n');

  await browser.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
