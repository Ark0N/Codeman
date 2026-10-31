/** Real browser DOM/focus regression; uses exact methods, no live sessions or native keyboard claims. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
function method(file: string, name: string): string {
  const source = readFileSync(resolve(publicDir, file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let result = '';
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === name) result = node.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}
const methods = ['handleSessionTabClick', '_shouldFocusTerminalForTabSwitch', 'selectSession']
  .map((name) => method('app.js', name))
  .join(',');
async function harness(browser: Browser, touch = true): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: touch ? 393 : 1280, height: 852 },
    hasTouch: touch,
    isMobile: touch,
  });
  await page.setContent(
    '<button id="same">Same tab</button><button id="other">Other tab</button><textarea id="terminal"></textarea>'
  );
  await page.addScriptTag({
    content: `
    window.KeyboardHandler={keyboardVisible:false};window.MobileDetection={isTouchDevice:()=>${touch}};
    window._crashDiag={log(){}};window.focusCalls=0;
    window.app={${methods},activeSessionId:'a',isSoloWindow:true,detachedSessions:new Set(),
      sessions:new Map([['b',{name:'b'}]]),_selectGeneration:0,
      terminal:{focus(){focusCalls++;document.getElementById('terminal').focus()}},
      _clearTimer(){},_flushLocalEchoTo(){},_setTerminalLoadState(){},_cleanupPreviousSession(){throw Error('STOP_BEFORE_SESSION_IO')},markIdleAlertSeen(){}};
    const select=app.selectSession;app.selectSession=(...args)=>select.apply(app,args).catch(e=>{
      if(e.message!=='STOP_BEFORE_SESSION_IO')throw e;
    });
    document.getElementById('same').onclick=e=>app.handleSessionTabClick(e,'a');
    document.getElementById('other').onclick=e=>app.handleSessionTabClick(e,'b');
  `,
  });
  return page;
}
describe('explicit mobile tab keyboard focus', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });
  for (const target of ['same', 'other']) {
    it(`focuses the terminal synchronously for a closed-keyboard ${target} tab tap`, async () => {
      const page = await harness(browser);
      try {
        await page.locator('#terminal').focus(); // stale textarea focus with keyboard gone
        await page.locator(`#${target}`).tap();
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
        expect(await page.evaluate('focusCalls')).toBe(1);
      } finally {
        await page.close();
      }
    });
  }
  it('direct same-session selection also restores terminal focus', async () => {
    const page = await harness(browser);
    try {
      await page.evaluate('app.selectSession("a")');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });
  it('keeps keyboard-hidden automatic selection passive, and preserves an existing keyboard', async () => {
    const page = await harness(browser);
    try {
      await page.evaluate('app.selectSession("b",{auto:true})');
      expect(await page.evaluate('focusCalls')).toBe(0);
      await page.evaluate('KeyboardHandler.keyboardVisible=true;app.selectSession("b",{auto:true})');
      expect(await page.evaluate('focusCalls')).toBe(1);
    } finally {
      await page.close();
    }
  });
  it('preserves desktop selection focus', async () => {
    const page = await harness(browser, false);
    try {
      await page.locator('#other').click();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });
});
