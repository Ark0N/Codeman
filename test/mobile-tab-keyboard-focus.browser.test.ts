/** Real browser DOM/focus regression; uses exact methods, no live sessions or native keyboard claims. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
function method(file: string, name: string, owner?: string): string {
  const source = readFileSync(resolve(publicDir, file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let result = '';
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === name) {
      const declaration = ts.isObjectLiteralExpression(node.parent) ? node.parent.parent : null;
      if (
        !owner ||
        (declaration && ts.isVariableDeclaration(declaration) && declaration.name.getText(tree) === owner)
      ) {
        result = node.getText(tree);
      }
    }
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
      terminal:{options:{},focus(){focusCalls++;document.getElementById('terminal').focus()}},
      _clearTimer(){},_flushLocalEchoTo(){},_setTerminalLoadState(){},_cleanupPreviousSession(){},_userScrollback(){return 100000},_renderHistoryTruncationBanner(){},_updateSseSubscription(){},_queueTransportActivationReconcile(){},_connectWs(){},hideWelcome(){},playTerminalEntrance(){throw Error('STOP_BEFORE_SESSION_IO')},markIdleAlertSeen(){}};
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
      await page.evaluate(
        'KeyboardHandler.keyboardVisible=true;app.activeSessionId="a";app.selectSession("b",{auto:true})'
      );
      expect(await page.evaluate('focusCalls')).toBe(1);
    } finally {
      await page.close();
    }
  });
  it('reveals a webview-hidden terminal before spending the synchronous focus', async () => {
    const page = await harness(browser);
    try {
      await page.evaluate(() => {
        const input = document.getElementById('terminal')!;
        const wrap = document.createElement('div');
        wrap.id = 'hidden-terminal';
        input.before(wrap);
        wrap.append(input);
        wrap.style.display = 'none';
        (window as any).app._hideWebviewLayer = () => {
          wrap.style.display = '';
        };
      });
      await page.locator('#other').tap();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });
  it('retires the previous text selection guard on an explicit tab tap', async () => {
    const page = await harness(browser);
    try {
      await page.evaluate(() => {
        const app = (window as any).app;
        app._touchSelecting = true;
        app._clearTouchSelection = () => {
          app._touchSelecting = false;
        };
        document.getElementById('terminal')!.addEventListener('focus', (e) => {
          if (app._touchSelecting) (e.target as HTMLElement).blur();
        });
      });
      await page.locator('#other').tap();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });
  it('uses the mobile input target after mode setup, including CJK input', async () => {
    const page = await harness(browser);
    try {
      await page.evaluate(() => {
        const field = document.createElement('textarea');
        field.id = 'cjkInput';
        document.body.append(field);
        (window as any).app._focusMobileTerminalInput = () => field.focus();
      });
      await page.locator('#other').tap();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cjkInput');
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

describe('keyboard lifecycle and stale visibility', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });
  async function keyboardPage() {
    const page = await browser.newPage({ viewport: { width: 440, height: 852 }, hasTouch: true, isMobile: true });
    await page.setContent(
      '<meta name="viewport" content="width=device-width,initial-scale=1"><div class="app"><header class="header"><button id="menu" class="mobile-header-utility-toggle">Menu</button></header><textarea id="terminal" class="xterm-helper-textarea"></textarea></div>'
    );
    await page.addScriptTag({
      content: `
      window.MobileDetection={isTouchDevice:()=>true,updateAppHeight(){}};
      window.hideEvents=0;window.focusEvents=0;
      window.KeyboardHandler={${['init', 'cleanup', 'handleViewportResize', 'onKeyboardHide', 'onKeyboardShow', 'forceKeyboardHidden', '_isTerminalInput', '_editableHasFocus', 'isInputElement'].map((n) => method('mobile-handlers.js', n, 'KeyboardHandler')).join(',')},
        keyboardVisible:true,initialViewportHeight:visualViewport.height,
        _keyboardMinHeight:visualViewport.height-300,lastViewportWidth:visualViewport.width,
        KEYBOARD_GONE_GROWTH_PX:150,KEYBOARD_FOCUS_SETTLE_MS:350,_releaseHeldRows(){return false},resetLayout(){hideEvents++},_scheduleViewportSettle(){},
        _traceKeyboardState(){},updateLayoutForKeyboard(){},_deferViewportSettle(){},_scheduleViewportSettle(){}};
      window.app={${['_mobileKeyboardIsUp', '_prepareMobileTerminalFocusGesture', '_installMobileTapMouseGuard', '_suppressTrustedTapMouseEvents', '_focusMobileTerminalInput', '_isMobileTerminalInputFocused', '_blurMobileTerminalInput'].map((n) => method('terminal-ui.js', n)).join(',')},
        _syncMobileHelperTextareaToCursor(){},relayoutMobileSubagentWindows(){},
        terminal:{textarea:document.getElementById('terminal'),focus(){this.textarea.focus()}}};
      document.getElementById('menu').onclick=()=>app._focusMobileTerminalInput();
      app.terminal.focus();
      document.getElementById('terminal').addEventListener('focus',()=>focusEvents++);
    `,
    });
    return page;
  }
  it('creates a fresh focus when a hide resize was missed', async () => {
    const page = await keyboardPage();
    try {
      await page.evaluate('app._focusMobileTerminalInput()');
      expect(await page.evaluate('focusEvents')).toBe(1);
      expect(await page.evaluate('KeyboardHandler.keyboardVisible')).toBe(false);
      expect(await page.evaluate('hideEvents')).toBe(1);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
      await page.locator('#menu').tap();
      await page.evaluate('focusEvents=0;KeyboardHandler.keyboardVisible=false;app._focusMobileTerminalInput()');
      expect(await page.evaluate('focusEvents')).toBe(1);
    } finally {
      await page.close();
    }
  });
  it('releases stale input at touchstart and focuses only at touchend', async () => {
    const page = await keyboardPage();
    try {
      await page.evaluate(`
        const surface=document.createElement('div');surface.id='surface';
        surface.style.cssText='height:80px;background:#ddd';document.body.append(surface);
        app.terminal.element=surface;app._installMobileTapMouseGuard();
        window.phases=[];
        surface.addEventListener('touchstart',()=>{
          app._prepareMobileTerminalFocusGesture();
          phases.push(['touchstart',app._isMobileTerminalInputFocused()]);
        });
        surface.addEventListener('touchend',()=>{
          app._suppressTrustedTapMouseEvents();
          app._focusMobileTerminalInput();
          phases.push(['touchend',app._isMobileTerminalInputFocused()]);
        });
        KeyboardHandler.keyboardVisible=false;
        app.terminal.focus();
      `);
      await page.locator('#surface').tap();
      expect(await page.evaluate('phases')).toEqual([
        ['touchstart', false],
        ['touchend', true],
      ]);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });

  it('retains dismiss ownership after prompt taps while the keyboard is open', async () => {
    const page = await keyboardPage();
    try {
      await page.evaluate(`
        window.cycleHeight=visualViewport.height;window.fullHeight=cycleHeight;
        Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>cycleHeight});
        KeyboardHandler.keyboardVisible=false;KeyboardHandler.init();
        document.getElementById('menu').onclick=()=>app._focusMobileTerminalInput();
        const surface=document.createElement('div');surface.id='prompt-surface';
        surface.style.cssText='height:60px;background:#ddd';document.body.append(surface);
        app.terminal.element=surface;app._installMobileTapMouseGuard();
        surface.addEventListener('touchstart',()=>app._prepareMobileTerminalFocusGesture());
        surface.addEventListener('touchend',()=>{
          app._suppressTrustedTapMouseEvents();app._focusMobileTerminalInput();
        });
      `);
      for (let cycle = 0; cycle < 20; cycle++) {
        await page.locator('#menu').tap();
        await page.evaluate('cycleHeight=fullHeight-300;KeyboardHandler.handleViewportResize()');
        for (let tap = 0; tap < cycle % 3; tap++) await page.locator('#prompt-surface').tap();
        expect(await page.evaluate('KeyboardHandler._keyboardFocusOwner===app._mobileKeyboardFocusGeneration')).toBe(
          true
        );
        await page.evaluate('cycleHeight=fullHeight;KeyboardHandler.handleViewportResize()');
        expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('terminal');
        expect(await page.evaluate('KeyboardHandler.initialViewportHeight===fullHeight')).toBe(true);
      }
    } finally {
      await page.close();
    }
  });

  it('transfers dismiss ownership after a settled tab choice with the keyboard open', async () => {
    const page = await keyboardPage();
    try {
      await page.evaluate(`
        window.cycleHeight=visualViewport.height;window.fullHeight=cycleHeight;
        Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>cycleHeight});
        KeyboardHandler.keyboardVisible=false;KeyboardHandler.init();
        document.getElementById('menu').onclick=()=>app._focusMobileTerminalInput('session-tab');
      `);
      for (let cycle = 0; cycle < 6; cycle++) {
        await page.locator('#menu').tap();
        await page.evaluate('cycleHeight=fullHeight-300;KeyboardHandler.handleViewportResize()');
        // A tab/search choice moves focus temporarily, while the OS keyboard stays up.
        await page.locator('#menu').tap();
        await page.waitForTimeout(420);
        expect(await page.evaluate('KeyboardHandler._keyboardFocusOwner===app._mobileKeyboardFocusGeneration')).toBe(
          true
        );
        await page.evaluate('cycleHeight=fullHeight;KeyboardHandler.handleViewportResize()');
        expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('terminal');
      }
    } finally {
      await page.close();
    }
  });

  for (const interruption of ['other-editor', 'new-request', 'closing-geometry']) {
    it(`does not adopt a settled tab request after ${interruption}`, async () => {
      const page = await keyboardPage();
      try {
        await page.evaluate(`
          window.cycleHeight=visualViewport.height;window.fullHeight=cycleHeight;
          Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>cycleHeight});
          KeyboardHandler.keyboardVisible=false;KeyboardHandler.init();
          app._focusMobileTerminalInput();
          cycleHeight=fullHeight-300;KeyboardHandler.handleViewportResize();
          window.oldOwner=KeyboardHandler._keyboardFocusOwner;
          app.terminal.textarea.blur();app._focusMobileTerminalInput('session-tab');
        `);
        await page.evaluate((kind) => {
          const w = window as any;
          if (kind === 'other-editor') {
            const other = document.createElement('textarea');
            other.id = 'other-editor';
            document.body.append(other);
            other.focus();
          } else if (kind === 'new-request') {
            w.app.terminal.textarea.blur();
            w.app._focusMobileTerminalInput();
          } else {
            w.cycleHeight += 50;
            w.KeyboardHandler.handleViewportResize();
          }
        }, interruption);
        await page.waitForTimeout(420);
        expect(await page.evaluate('KeyboardHandler._keyboardFocusOwner===oldOwner')).toBe(true);
        expect(await page.evaluate(() => document.activeElement?.id)).toBe(
          interruption === 'other-editor' ? 'other-editor' : 'terminal'
        );
      } finally {
        await page.close();
      }
    });
  }

  for (const delay of [0, 80, 200, 349]) {
    it(`protects a tab opening from the previous keyboard close at ${delay}ms`, async () => {
      const page = await keyboardPage();
      try {
        await page.evaluate(`
          window.cycleHeight=visualViewport.height;window.fullHeight=cycleHeight;
          Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>cycleHeight});
          KeyboardHandler.keyboardVisible=false;KeyboardHandler.init();
          app._focusMobileTerminalInput();
          cycleHeight=fullHeight-300;KeyboardHandler.handleViewportResize();
          app.terminal.textarea.blur();
          app._focusMobileTerminalInput('session-tab');
          setTimeout(()=>{cycleHeight=fullHeight;KeyboardHandler.handleViewportResize()},${delay});
        `);
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
        expect(await page.evaluate('KeyboardHandler.keyboardVisible')).toBe(false);
        expect(await page.evaluate('KeyboardHandler._keyboardFocusOwner')).toBeUndefined();
      } finally {
        await page.close();
      }
    });
  }

  it('survives listener reconnect with the keyboard open, then dismisses and reopens', async () => {
    const page = await keyboardPage();
    try {
      await page.evaluate(`
        window.cycleHeight=visualViewport.height;window.fullHeight=cycleHeight;
        Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>cycleHeight});
        KeyboardHandler.keyboardVisible=false;KeyboardHandler.init();
        app._focusMobileTerminalInput();
        cycleHeight=fullHeight-300;KeyboardHandler.handleViewportResize();
        KeyboardHandler.cleanup();KeyboardHandler.init();KeyboardHandler.handleViewportResize();
      `);
      expect(await page.evaluate('KeyboardHandler.initialViewportHeight===fullHeight')).toBe(true);
      expect(await page.evaluate('KeyboardHandler.keyboardVisible')).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
      await page.evaluate('cycleHeight=fullHeight;KeyboardHandler.handleViewportResize()');
      expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('terminal');
      await page.evaluate(`document.getElementById('menu').onclick=()=>app._focusMobileTerminalInput()`);
      await page.locator('#menu').tap();
      await page.evaluate('cycleHeight=fullHeight-300;KeyboardHandler.handleViewportResize()');
      expect(await page.evaluate('KeyboardHandler.keyboardVisible')).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });

  it('preserves a new focus through each of 25 delayed closing viewport transitions', async () => {
    const page = await keyboardPage();
    try {
      await page.evaluate(`
        window.cycleHeight=visualViewport.height;
        window.fullHeight=cycleHeight;
        Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>cycleHeight});
        KeyboardHandler.keyboardVisible=false;KeyboardHandler.init();
        document.getElementById('menu').onclick=()=>app._focusMobileTerminalInput();
      `);
      for (let cycle = 0; cycle < 25; cycle++) {
        await page.locator('#menu').tap();
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
        await page.evaluate(`
          cycleHeight=fullHeight-300;KeyboardHandler.handleViewportResize();
          if (!KeyboardHandler.keyboardVisible) throw Error('show not detected');
          app.terminal.textarea.blur();
        `);
        // Reopen before the preceding close has restored the visual viewport.
        await page.waitForTimeout([0, 16, 80, 200][cycle % 4]);
        await page.locator('#menu').tap();
        await page.evaluate('cycleHeight=fullHeight;KeyboardHandler.handleViewportResize()');
        expect(await page.evaluate('KeyboardHandler.keyboardVisible')).toBe(false);
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
      }
      // A hide notification must not take focus from a different editor.
      await page.evaluate(`
        const other=document.createElement('textarea');other.id='other-editor';
        document.body.append(other);other.focus();KeyboardHandler.onKeyboardHide();
      `);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('other-editor');
    } finally {
      await page.close();
    }
  });
  it('retains calibration when returning before the close animation completes', async () => {
    const page = await keyboardPage();
    try {
      await page.evaluate(`
        window.cycleHeight=visualViewport.height;window.fullHeight=cycleHeight;
        Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>cycleHeight});
        KeyboardHandler.keyboardVisible=false;KeyboardHandler.init();
        cycleHeight=fullHeight-300;KeyboardHandler.handleViewportResize();
        window.fakeVisibility='hidden';
        Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>fakeVisibility});
        document.dispatchEvent(new Event('visibilitychange'));
        fakeVisibility='visible';document.dispatchEvent(new Event('visibilitychange'));
      `);
      expect(await page.evaluate('KeyboardHandler.initialViewportHeight===fullHeight')).toBe(true);
      // A real resize may already have reconciled the still-obscured viewport.
      expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('terminal');
      await page.evaluate(`
        document.getElementById('menu').onclick=()=>app._focusMobileTerminalInput();
      `);
      await page.locator('#menu').tap();
      await page.evaluate('KeyboardHandler.handleViewportResize()');
      expect(await page.evaluate('KeyboardHandler.keyboardVisible')).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });
  it('observes a focus request without stealing a different editor after the tap', async () => {
    const page = await keyboardPage();
    try {
      await page.evaluate(`
        window._crashDiag={log(){}};window.observations=[];
        KeyboardHandler._traceKeyboardState=reason=>observations.push(reason);
        app._focusMobileTerminalInput('session-tab');
        const editor=document.createElement('textarea');editor.id='other-editor';
        document.body.append(editor);editor.focus();
      `);
      await page.waitForTimeout(1150);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('other-editor');
      expect(await page.evaluate('observations')).toEqual([
        'viewport-hide',
        'request-1-session-tab',
        'request-1-after-350ms',
        'request-1-after-1000ms',
      ]);
    } finally {
      await page.close();
    }
  });
  it('records clipped input geometry without recording text or changing focus', async () => {
    const page = await browser.newPage({ viewport: { width: 440, height: 852 } });
    try {
      await page.setContent(`<div style="position:absolute;left:20px;top:100px;width:200px;height:100px;overflow:hidden">
        <textarea id="terminal" class="xterm-helper-textarea" style="position:absolute;left:5px;top:170px;width:1px;height:1px;padding:0;border:0"></textarea>
        </div><textarea id="editor"></textarea>`);
      await page.addScriptTag({
        content: `
        window.logs=[];window._crashDiag={log:message=>logs.push(message)};
        window.KeyboardHandler={${['_traceKeyboardInputBox', '_isTerminalInput'].map((n) => method('mobile-handlers.js', n, 'KeyboardHandler')).join(',')}};
        window.app={terminal:{textarea:document.getElementById('terminal')}};
        document.getElementById('terminal').value='PRIVATE_TYPED_CONTENT';
        document.getElementById('editor').focus();
        KeyboardHandler._traceKeyboardInputBox('before-menu');
        document.getElementById('terminal').style.top='20px';
        KeyboardHandler._traceKeyboardInputBox('after-menu');
      `,
      });
      const logs = (await page.evaluate('logs')) as string[];
      expect(logs[0]).toContain('"intersects":false');
      expect(logs[1]).toContain('"intersects":true');
      expect(logs.join('')).not.toContain('PRIVATE_TYPED_CONTENT');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('editor');
    } finally {
      await page.close();
    }
  });
  it('permits native page activation on a lost-focus tap without duplicating CLI mouse actions', async () => {
    const page = await keyboardPage();
    try {
      await page.evaluate(`
        MobileDetection.isIOS=()=>true;KeyboardHandler.keyboardVisible=false;
        window.pageFocused=false;window.cliMouseEvents=0;window.nativeDefaults=[];
        Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>pageFocused});
        window.focus=()=>{}; // Reproduce the phone declining script window.focus().
        const surface=document.createElement('div');surface.id='native-surface';
        surface.style.cssText='height:80px;background:#ddd';document.body.append(surface);
        app.terminal.element=surface;app._installMobileTapMouseGuard();
        surface.addEventListener('touchend',()=>{
          app._suppressTrustedTapMouseEvents();app._focusMobileTerminalInput();
        });
        // Model only the native activation default: the cancelled v10 mousedown
        // must not activate the page. This does not simulate an OS keyboard.
        window.lastNativeMouseDown=null;
        document.addEventListener('mousedown',event=>lastNativeMouseDown=event,true);
        document.addEventListener('mouseup',()=>{
          nativeDefaults.push(lastNativeMouseDown.defaultPrevented);
          if(!lastNativeMouseDown.defaultPrevented)pageFocused=true;
        },true);
        for(const kind of ['mousedown','mouseup','click'])
          surface.addEventListener(kind,()=>cliMouseEvents++);
      `);
      await page.locator('#native-surface').tap();
      expect(await page.evaluate('nativeDefaults')).toEqual([false]);
      expect(await page.evaluate('document.hasFocus()')).toBe(true);
      expect(await page.evaluate('cliMouseEvents')).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });

  for (const interruption of [
    'page-focused',
    'newer-request',
    'other-editor',
    'expired',
    'session-change',
    'selection',
  ]) {
    it(`cancels native-click recovery safely for ${interruption}`, async () => {
      const page = await keyboardPage();
      try {
        await page.evaluate((kind) => {
          const w = window as any;
          w.MobileDetection.isIOS = () => true;
          w.KeyboardHandler.keyboardVisible = false;
          w.pageFocused = kind === 'page-focused';
          w.cliMouseEvents = 0;
          w.nativeDefaults = [];
          Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => w.pageFocused });
          const surface = document.createElement('div');
          surface.id = 'native-surface';
          surface.style.cssText = 'height:80px;background:#ddd';
          document.body.append(surface);
          w.app.terminal.element = surface;
          w.app._installMobileTapMouseGuard();
          surface.addEventListener('touchend', () => {
            w.app._suppressTrustedTapMouseEvents();
            w.app._focusMobileTerminalInput();
          });
          let down: MouseEvent;
          document.addEventListener(
            'mousedown',
            (event) => {
              down = event;
              if (kind === 'newer-request') w.app._mobileKeyboardFocusGeneration++;
              if (kind === 'expired' && w.app._mobileNativeClickFocusRequest)
                w.app._mobileNativeClickFocusRequest.expires = 0;
              if (kind === 'session-change') w.app.activeSessionId = 'another-session';
              if (kind === 'selection') w.app._touchSelectionActive = true;
              if (kind === 'other-editor') {
                const editor = document.createElement('textarea');
                editor.id = 'editor';
                document.body.append(editor);
                editor.focus();
              }
            },
            true
          );
          document.addEventListener('mouseup', () => w.nativeDefaults.push(down.defaultPrevented), true);
          for (const type of ['mousedown', 'mouseup', 'click'])
            surface.addEventListener(type, () => w.cliMouseEvents++);
        }, interruption);
        await page.locator('#native-surface').tap();
        expect(await page.evaluate('nativeDefaults')).toEqual([true]);
        expect(await page.evaluate('cliMouseEvents')).toBe(0);
        expect(await page.evaluate('app._mobileNativeClickFocusRequest')).toBeNull();
        if (interruption === 'other-editor')
          expect(await page.evaluate(() => document.activeElement?.id)).toBe('editor');
      } finally {
        await page.close();
      }
    });
  }

  it('does not blur/refocus an actually shrunken keyboard viewport', async () => {
    const page = await keyboardPage();
    try {
      await page.setViewportSize({ width: 440, height: 552 });
      await page.evaluate(
        'KeyboardHandler._keyboardMinHeight=visualViewport.height;focusEvents=0;app._prepareMobileTerminalFocusGesture();app._focusMobileTerminalInput()'
      );
      expect(await page.evaluate('focusEvents')).toBe(0);
      expect(await page.evaluate('hideEvents')).toBe(0);
      expect(await page.evaluate('KeyboardHandler.keyboardVisible')).toBe(true);
    } finally {
      await page.close();
    }
  });
});
