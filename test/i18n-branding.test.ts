/**
 * Regression coverage for the browser i18n layer and custom display-name setting.
 * Port: N/A (JSDOM + direct schema/server render calls only).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { SettingsUpdateSchema } from '../src/web/schemas.js';
import { WebServer } from '../src/web/server.js';

const i18nSource = readFileSync(new URL('../src/web/public/i18n.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf8');

function makeDom(body = '<span class="logo">Codeman</span><button title="App Settings">App Settings</button>') {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>codeman:test-host</title></head><body>${body}</body></html>`,
    {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    }
  );
  vm.runInContext(i18nSource, dom.getInternalVMContext(), { filename: 'i18n.js' });
  return dom;
}

describe('custom display name and browser localization', () => {
  const previousDataDir = process.env.CODEMAN_DATA_DIR;

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = previousDataDir;
  });

  it('accepts bounded Chinese display names and rejects invalid values', () => {
    expect(SettingsUpdateSchema.safeParse({ displayName: '小码助手' }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ displayName: '  小码助手  ' }).data).toMatchObject({
      displayName: '小码助手',
    });
    expect(SettingsUpdateSchema.safeParse({ displayName: '' }).success).toBe(false);
    expect(SettingsUpdateSchema.safeParse({ displayName: '名'.repeat(41) }).success).toBe(false);
    expect(SettingsUpdateSchema.safeParse({ displayName: 'unsafe\nname' }).success).toBe(false);
  });

  it('translates static and dynamic UI, restores English, and leaves terminal/user content untouched', async () => {
    const dom = makeDom(`
      <span class="logo">Codeman</span>
      <button id="settings" title="App Settings">App Settings</button>
      <div id="user" class="session-tab-name">Home</div>
      <div class="xterm">Run</div>
      <div class="history-item" title="Run">
        <span class="history-item-title">Run</span>
        <span class="history-item-subtitle">Home</span>
        <span class="history-detail-prompt">Settings saved</span>
        <span class="history-detail-path">Home</span>
      </div>
      <div id="dynamic"></div>
    `);
    const { window } = dom;
    const api = window.CodemanI18n;
    api.start();
    api.configure({ language: 'zh-CN', displayName: '小码助手' });

    expect(window.document.querySelector('.logo')?.textContent).toBe('小码助手');
    expect(window.document.getElementById('settings')?.textContent).toBe('应用设置');
    expect(window.document.getElementById('settings')?.getAttribute('title')).toBe('应用设置');
    expect(window.document.getElementById('user')?.textContent).toBe('Home');
    expect(window.document.querySelector('.xterm')?.textContent).toBe('Run');
    expect(window.document.querySelector('.history-item-title')?.textContent).toBe('Run');
    expect(window.document.querySelector('.history-detail-prompt')?.textContent).toBe('Settings saved');
    expect(window.document.querySelector('.history-item')?.getAttribute('title')).toBe('Run');
    expect(window.document.title).toBe('小码助手:test-host');

    const dynamicButton = window.document.createElement('button');
    dynamicButton.textContent = 'Settings saved';
    dynamicButton.title = 'Open Codeman across all displays';
    window.document.getElementById('dynamic')?.appendChild(dynamicButton);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(dynamicButton.textContent).toBe('设置已保存');
    expect(dynamicButton.title).toBe('在所有显示器上打开 小码助手');

    api.configure({ language: 'en', displayName: 'Workbench' });
    expect(window.document.getElementById('settings')?.textContent).toBe('App Settings');
    expect(window.document.querySelector('.logo')?.textContent).toBe('Workbench');
    expect(dynamicButton.textContent).toBe('Settings saved');
    expect(window.document.title).toBe('Workbench:test-host');
    dom.window.close();
  });

  it('does not walk what a terminal renders: one check per mutation inside a skipped surface', async () => {
    const dom = makeDom('<div class="xterm"><div class="xterm-rows" id="rows"></div></div><div id="app"></div>');
    const { window } = dom;
    const api = window.CodemanI18n;
    api.start();
    api.configure({ language: 'zh-CN' });
    // i18n.js also starts itself on DOMContentLoaded (one walk of the body).
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    let walks = 0;
    const createTreeWalker = window.document.createTreeWalker.bind(window.document);
    window.document.createTreeWalker = (...args: Parameters<Document['createTreeWalker']>) => {
      walks++;
      return createTreeWalker(...args);
    };

    // What xterm's DOM renderer does every frame: replace the rows.
    const rows = window.document.getElementById('rows')!;
    for (let frame = 0; frame < 3; frame++) {
      const fresh = Array.from({ length: 20 }, () => {
        const row = window.document.createElement('div');
        row.innerHTML = '<span>Settings saved</span><span title="Run">Run</span>';
        return row;
      });
      rows.replaceChildren(...fresh);
    }
    rows.firstElementChild!.firstChild!.firstChild!.nodeValue = 'Settings saved';
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(walks).toBe(0);
    expect(rows.firstElementChild?.textContent).toBe('Settings savedRun');
    expect(rows.querySelector('[title]')?.getAttribute('title')).toBe('Run');

    // Application DOM next to it is still translated.
    const button = window.document.createElement('button');
    button.textContent = 'Settings saved';
    window.document.getElementById('app')!.appendChild(button);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(button.textContent).toBe('设置已保存');
    expect(walks).toBe(1);
    dom.window.close();
  });

  it('keeps a quoted group name apart from the fixed "Move to" entries in zh-CN', () => {
    const dom = makeDom('');
    const api = dom.window.CodemanI18n;
    api.configure({ language: 'zh-CN' });
    const labels = ['Move to "New group"', 'Move to new group', 'Move to "ungrouped"', 'Move to Ungrouped'].map((label) =>
      api.t(label)
    );
    expect(labels).toEqual(['移到“New group”', '移到新分组', '移到“ungrouped”', '移到未分组']);
    expect(new Set(labels).size).toBe(4);
    dom.window.close();
  });

  it('renders hostile-looking names as text rather than HTML', () => {
    const dom = makeDom('<span class="logo">Codeman</span>');
    const api = dom.window.CodemanI18n;
    api.start();
    api.configure({ displayName: '<img src=x onerror=alert(1)>', language: 'en' });
    const logo = dom.window.document.querySelector('.logo');
    expect(logo?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(logo?.querySelector('img')).toBeNull();
    dom.window.close();
  });

  it('wires the two settings with language kept per-device and display name synced', () => {
    expect(indexSource).toContain('id="appSettingsDisplayName"');
    expect(indexSource).toContain('id="appSettingsLanguage"');
    expect(indexSource).toContain('<option value="zh-CN">简体中文</option>');
    expect(settingsSource).toMatch(/language:\s*_language/);
    expect(settingsSource).toContain("'language',");
    expect(settingsSource).not.toMatch(/displayName:\s*_displayName/);
  });

  it('uses the escaped custom name in the server-rendered window title', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codeman-brand-title-'));
    process.env.CODEMAN_DATA_DIR = dataDir;
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ displayName: '小码<&助手' }));
    const server = new WebServer(0, false, true, '127.0.0.1', 'laptop');
    const html = await (server as unknown as { renderIndexHtml: () => Promise<string> }).renderIndexHtml();
    expect(html).toContain('<title>小码&lt;&amp;助手:laptop</title>');
    expect(html).not.toContain('<title>小码<&助手:laptop</title>');
  });
});
