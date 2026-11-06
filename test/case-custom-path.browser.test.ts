/** @fileoverview Add Case → Create New → "Create in a custom folder", end to end: real server, real Chromium, real folders. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

declare const PathPicker: any; // evaluated inside the page, where it is a global

describe('Create a case in a custom folder', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let parent: string;

  beforeAll(async () => {
    parent = mkdtempSync(join(homedir(), 'custom-case-'));
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    rmSync(parent, { recursive: true, force: true });
  }, 60000);

  const open = async () => {
    await page.evaluate(() => {
      (window as any).app.showCreateCaseModal();
      (window as any).app.switchCaseModalTab('case-create');
    });
  };
  const toastText = () =>
    page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'));

  it('hides the parent-folder field until the box is ticked, and shows what it will create', async () => {
    await open();
    expect(await page.isVisible('#newCaseCustomPathRow')).toBe(false);
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    expect(await page.isVisible('#newCaseCustomPathRow')).toBe(true);
    await page.fill('#newCaseName', 'my-app');
    await page.fill('#newCasePath', '~/projects/');
    expect(await page.textContent('#newCasePathPreview')).toBe('Will create: ~/projects/my-app');
  });

  it('is exclusive with the Docker option, in both directions', async () => {
    await open();
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    expect(await page.isDisabled('#newCaseDocker')).toBe(true);
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    expect(await page.isDisabled('#newCaseDocker')).toBe(false);
    await page.click('label.checkbox-row:has(#newCaseDocker)');
    expect(await page.isDisabled('#newCaseCustomPathToggle')).toBe(true);
    await page.click('label.checkbox-row:has(#newCaseDocker)');
  });

  it('Browse opens the folder picker for directories only and fills the field with the choice', async () => {
    await open();
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    await page.fill('#newCaseName', 'picked');
    const opts = await page.evaluate(() => {
      // A top-level `const` in a classic script: a global binding, not a window property.
      const picker = PathPicker;
      let captured: any = null;
      const original = picker.open;
      picker.open = (o: any) => (captured = o);
      (document.querySelector('#newCaseCustomPathRow .path-input-browse') as HTMLElement).click();
      picker.open = original;
      captured.onSelect('/srv/work');
      return { directoriesOnly: captured.directoriesOnly };
    });
    expect(opts.directoriesOnly).toBe(true);
    expect(await page.inputValue('#newCasePath')).toBe('/srv/work');
    expect(await page.textContent('#newCasePathPreview')).toBe('Will create: /srv/work/picked');
  });

  it('asks for a folder when the box is ticked and the field is empty, and creates nothing', async () => {
    await open();
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    await page.fill('#newCaseName', 'no-folder');
    await page.evaluate(() => (window as any).app.createCase());
    expect(await toastText()).toMatch(/Choose the folder/);
  });

  it('creates the case in the chosen folder, scaffolds it, and lists it at that path', async () => {
    await open();
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    await page.fill('#newCaseName', 'in-custom');
    await page.fill('#newCasePath', parent);
    await page.evaluate(() => (window as any).app.submitCaseModal());
    await page.waitForFunction(() =>
      /created in/.test([...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'))
    );
    const target = join(parent, 'in-custom');
    expect(readFileSync(join(target, 'CLAUDE.md'), 'utf8')).toContain('in-custom');
    expect(existsSync(join(target, 'src'))).toBe(true);
    const cases = await page.evaluate(async () => {
      const body = await (await fetch('/api/cases')).json();
      return Array.isArray(body) ? body : body.data;
    });
    expect(cases.find((c: { name: string }) => c.name === 'in-custom')).toMatchObject({ path: target });
    expect(existsSync(join(homedir(), 'codeman-cases', 'in-custom'))).toBe(false);
    expect(await page.isVisible('#createCaseModal.active')).toBe(false);
  });

  it('shows the server’s reason for a folder that already has files, and leaves it untouched', async () => {
    const busy = join(parent, 'busy');
    mkdirSync(busy);
    writeFileSync(join(busy, 'keep.txt'), 'mine');
    await open();
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    await page.fill('#newCaseName', 'busy');
    await page.fill('#newCasePath', parent);
    await page.evaluate(() => (window as any).app.createCase());
    await page.waitForFunction(() =>
      /Link Existing/.test([...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'))
    );
    expect(readFileSync(join(busy, 'keep.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(busy, 'CLAUDE.md'))).toBe(false);
  });

  it('rewords the "under ~/codeman-cases" hints while a custom folder is picked', async () => {
    await open();
    expect(await page.textContent('#newCaseNameHint')).toMatch(/Created in ~\/codeman-cases/);
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    expect(await page.textContent('#newCaseNameHint')).toMatch(/parent folder below/);
    expect(await page.textContent('#newCaseBlurb')).toMatch(/a folder you choose/);
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    expect(await page.textContent('#newCaseNameHint')).toMatch(/Created in ~\/codeman-cases/);
    expect(await page.textContent('#newCaseBlurb')).toMatch(/under ~\/codeman-cases/);
  });

  it('keeps / as the root parent instead of sending an empty path', async () => {
    await open();
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    await page.fill('#newCaseName', 'at-root');
    await page.fill('#newCasePath', '/');
    expect(await page.textContent('#newCasePathPreview')).toBe('Will create: /at-root');
    expect(await page.evaluate(() => (window as any).app._newCaseTargetPath())).toBe('/at-root');
  });

  it('names the folder the server created in the success toast (~ expanded)', async () => {
    await open();
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    await page.fill('#newCaseName', 'via-tilde');
    await page.fill('#newCasePath', `~/${basename(parent)}`);
    await page.evaluate(() => (window as any).app.submitCaseModal());
    const target = join(realpathSync(parent), 'via-tilde');
    await page.waitForFunction(
      (t) => [...document.querySelectorAll('.toast')].some((el) => el.textContent?.includes(t)),
      target
    );
    expect(await toastText()).not.toMatch(/created in ~\//);
  });

  it('starts unticked every time the modal opens', async () => {
    await open();
    await page.click('label.checkbox-row:has(#newCaseCustomPathToggle)');
    await page.fill('#newCasePath', '/tmp');
    await open();
    expect(await page.isChecked('#newCaseCustomPathToggle')).toBe(false);
    expect(await page.inputValue('#newCasePath')).toBe('');
    expect(await page.isVisible('#newCaseCustomPathRow')).toBe(false);
  });
});
