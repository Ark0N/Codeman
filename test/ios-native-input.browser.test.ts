import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';
import { resolve } from 'node:path';
// Browser globals are installed by classic scripts, outside TypeScript's module graph.
type SentInput = { id: string; input: string; time: number };
type CellAnchor = { col: number; row: number };
interface TestTerminal {
  textarea: HTMLTextAreaElement;
  element: HTMLElement;
  write(text: string, callback: () => void): void;
  buffer: { active: { cursorX: number; cursorY: number } };
  _core: {
    _renderService: { dimensions: { css: { cell: { width: number } } } };
    _customKeyEventHandler(event: KeyboardEvent): boolean;
  };
}
interface NativeOwner {
  reset(reason: string): void;
}
interface TestApp {
  terminal: TestTerminal;
  activeSessionId: string;
  sessions: Map<string, { id: string; mode: string; status?: string }>;
  _localEchoEnabled: boolean;
  _isLoadingBuffer: boolean;
  _echoPassthroughSessions?: Set<string>;
  _localEchoOverlay: { clear(): void; pendingText: string; getInputEndAnchor(): CellAnchor | null };
  _iosNativeInput: NativeOwner;
  _keyCode229Recovery: unknown;
  _enqueueReliableInput(id: string, input: string): unknown;
}
interface TestWindow extends Window {
  app: TestApp;
  __sent: SentInput[];
  CodemanIosNativeInput: { isSupported(): boolean };
  IosReplay: {
    typeKey(ta: HTMLTextAreaElement, text: string): void;
    kev(type: string, key: string, keyCode: number, extra?: { shiftKey?: boolean; ctrlKey?: boolean }): KeyboardEvent;
    edit(ta: HTMLTextAreaElement, inputType: string, data: string): boolean;
  };
  TerminalTile: new (
    id: string,
    mount: HTMLElement,
    options: { mode: string }
  ) => {
    connect(): Promise<void>;
    destroy(): void;
    terminal: TestTerminal;
    _iosNativeInput: NativeOwner;
    _keyCode229Recovery: unknown;
  };
}
// Real platform timers intentionally cover native reconciliation and the FIFO's 80ms gap.

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1';
const SESSION = 'ios830-browser';

describe('iOS native input served-app wiring (#830)', () => {
  let server: WebServer;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: IOS_UA,
      hasTouch: true,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
      const native = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const result = native(query);
        if (query === '(pointer: coarse)') Object.defineProperty(result, 'matches', { value: true });
        return result;
      };
    });
  }, 90000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60000);

  async function setup(echo: boolean) {
    if (page) await page.close();
    page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as unknown as TestWindow).app?._iosNativeInput, null, { timeout: 30000 });
    await page.evaluate(
      async ({ echo, session }) => {
        const w = window as unknown as TestWindow;
        const app = w.app;
        app.activeSessionId = session;
        app.sessions.set(session, { id: session, mode: 'shell', status: 'idle' });
        app._localEchoEnabled = echo;
        app._isLoadingBuffer = false;
        app._echoPassthroughSessions?.delete(session);
        app._localEchoOverlay.clear();
        app._iosNativeInput.reset('test');
        w.__sent = [];
        // Observe the real FIFO/handleTerminalData boundary, not _sendInputAsync.
        app._enqueueReliableInput = (id: string, input: string) =>
          w.__sent.push({ id, input, time: performance.now() });
        await new Promise<void>((resolve) => app.terminal.write('\x1bc❯ ', resolve));
        app.terminal.textarea.focus();
      },
      { echo, session: SESSION }
    );
    expect(
      await page.evaluate(() => ({
        supported: (window as unknown as TestWindow).CodemanIosNativeInput.isSupported(),
        recovery: (window as unknown as TestWindow).app._keyCode229Recovery,
      }))
    ).toEqual({ supported: true, recovery: null });
    await page.addScriptTag({ path: resolve(import.meta.dirname, 'fixtures/ios-native-replay.js') });
  }

  async function run(action: string) {
    return page.evaluate(async (action) => {
      const w = window as unknown as TestWindow;
      const app = w.app;
      const ta = app.terminal.textarea;
      const r = w.IosReplay;
      const type = async (text: string) => {
        for (const ch of text) {
          r.typeKey(ta, ch);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      await new Function('app', 'ta', 'r', 'type', `return (async () => { ${action} })()`)(app, ta, r, type);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { sent: w.__sent, pending: app._localEchoOverlay.pendingText, value: ta.value };
    }, action);
  }

  for (const echo of [false, true]) {
    it(`suggestion commits hello once, and Enter preserves the 80ms gap (echo ${echo})`, async () => {
      await setup(echo);
      const before = await run("await type('hel'); r.typeKey(ta, 'lo');");
      expect(before.sent.map((x) => x.input)).toEqual(echo ? [] : ['h', 'e', 'l', 'lo']);
      const result = await run('r.enter(ta); await new Promise(resolve => setTimeout(resolve, 110));');
      expect(result.sent.map((x) => x.input)).toEqual(echo ? ['hello', '\r'] : ['h', 'e', 'l', 'lo', '\r']);
      if (echo) expect(result.sent[1].time - result.sent[0].time).toBeGreaterThanOrEqual(75);
    });

    it(`phrase replacement has no stale prefix (echo ${echo})`, async () => {
      await setup(echo);
      let result = await run("await type('helloworl'); r.replaceSuggestion(ta, 0, 9, 'Hello World');");
      if (echo) result = await run('r.enter(ta); await new Promise(resolve => setTimeout(resolve, 110));');
      expect(terminalLine(result.sent.map((x) => x.input).join('')).replace(/\r$/, '')).toBe('Hello World');
    });

    it(`keyless hold-delete bursts empty the line (echo ${echo})`, async () => {
      await setup(echo);
      const result = await run("await type('hello'); r.holdDeleteRepeat(ta, 8);");
      expect(result.value).toBe('');
      expect(terminalLine(result.sent.map((x) => x.input).join(''))).toBe('');
      if (echo) {
        expect(result.sent).toEqual([]);
        expect(result.pending).toBe('');
      }
    });

    it(`dictation replacement and line break never submit (echo ${echo})`, async () => {
      await setup(echo);
      const result = await run(
        "r.edit(ta, 'insertText', 'hello'); r.edit(ta, 'insertText', 'Hello World', [0, 5]); r.edit(ta, 'insertLineBreak', null);"
      );
      // The native field retains dictated newlines; only the shell projection excludes them.
      expect(result.value).toBe('Hello World\n');
      expect(result.sent.some((x) => /[\r\n]/.test(x.input))).toBe(false);
    });

    it(`toolbar Enter resets the next suggestion baseline (echo ${echo})`, async () => {
      await setup(echo);
      await run("await type('hel'); r.typeKey(ta, 'lo');");
      await page
        .locator('button[onclick="app.sendEnterKey()"]')
        .evaluate((button: HTMLButtonElement) => button.click());
      const result = await run("r.typeKey(ta, 'lo'); await new Promise(resolve => setTimeout(resolve, 110));");
      expect(result.value).toBe('lo');
      expect(result.sent.some((x) => x.input.includes('\x7f'))).toBe(false);
      expect(result.sent.map((x) => x.input).join('')).toBe(echo ? 'hello\r' : 'hello\rlo');
      if (echo) expect(result.pending).toBe('lo');
    });

    it(`trackpad caret marker sits after he in hello (echo ${echo})`, async () => {
      await setup(echo);
      await run(
        "await type('hello'); if (!app._localEchoEnabled) await new Promise(resolve => app.terminal.write('hello', resolve)); r.caret(ta, 2);"
      );
      const geometry = await page.evaluate(() => {
        const app = (window as unknown as TestWindow).app;
        const marker = app.terminal.element.querySelector<HTMLElement>('.ios-native-caret')!;
        const cell = app.terminal._core._renderService.dimensions.css.cell;
        const end = app._localEchoEnabled
          ? app._localEchoOverlay.getInputEndAnchor()
          : { col: app.terminal.buffer.active.cursorX, row: app.terminal.buffer.active.cursorY };
        return {
          display: marker.style.display,
          col: parseFloat(marker.style.left) / cell.width,
          expected: end!.col - 3,
        };
      });
      expect(geometry.display).not.toBe('none');
      expect(geometry.col).toBeCloseTo(geometry.expected, 1);
    });
  }

  for (const target of ['main', 'tile'] as const) {
    for (const modifier of ['shiftKey', 'ctrlKey'] as const) {
      it(`${target} ${modifier} Enter submits only on keydown and swallows keypress/keyup`, async () => {
        await setup(false);
        const result = await page.evaluate(
          async ({ target, modifier, session }) => {
            const w = window as unknown as TestWindow;
            const mount = document.createElement('div');
            document.body.appendChild(mount);
            const tile = target === 'tile' ? new w.TerminalTile(session, mount, { mode: 'shell' }) : null;
            const originalFetch = window.fetch;
            const submitted: unknown[] = [];
            window.fetch = async (input, init) => {
              if (String(input).endsWith(`/api/sessions/${session}/send-key`)) {
                submitted.push(JSON.parse(String(init?.body)));
                return new Response('{}', { status: 200 });
              }
              return originalFetch(input, init);
            };
            try {
              if (tile) await tile.connect();
              const terminal = tile ? tile.terminal : w.app.terminal;
              // Invoke the installed xterm handler for every phase. xterm can deliver
              // keypress even after keydown returns false (the original Shift+Enter bug).
              const phases = [];
              for (const type of ['keydown', 'keypress', 'keyup']) {
                const accepted = terminal._core._customKeyEventHandler(
                  w.IosReplay.kev(type, 'Enter', 13, { [modifier]: true })
                );
                await new Promise((resolve) => setTimeout(resolve, 30));
                phases.push({ accepted, submitted: [...submitted], sent: [...w.__sent] });
              }
              return phases;
            } finally {
              window.fetch = originalFetch;
              tile?.destroy();
              mount.remove();
            }
          },
          { target, modifier, session: SESSION }
        );
        const submission = { key: modifier === 'ctrlKey' ? 'C-Enter' : 'S-Enter' };
        expect(result).toEqual([
          { accepted: false, submitted: [submission], sent: [] },
          { accepted: false, submitted: [submission], sent: [] },
          { accepted: false, submitted: [submission], sent: [] },
        ]);
      });
    }
  }

  for (const modifier of ['shiftKey', 'ctrlKey'] as const) {
    it(`main iOS suggestion word Enter with ${modifier} and non-13 keyCode stays text`, async () => {
      await setup(false);
      const result = await page.evaluate(async (modifier) => {
        const w = window as unknown as TestWindow;
        const app = w.app;
        const submitted: string[] = [];
        const originalFetch = window.fetch;
        window.fetch = async (input, init) => {
          if (String(input).endsWith('/send-key')) {
            submitted.push(String(init?.body));
            return new Response('{}', { status: 200 });
          }
          return originalFetch(input, init);
        };
        try {
          const ta = app.terminal.textarea;
          app.terminal._core._customKeyEventHandler(w.IosReplay.kev('keydown', 'Enter', 69, { [modifier]: true }));
          app.terminal._core._customKeyEventHandler(w.IosReplay.kev('keypress', 'Enter', 69, { [modifier]: true }));
          w.IosReplay.edit(ta, 'insertText', 'Enter');
          app.terminal._core._customKeyEventHandler(w.IosReplay.kev('keyup', 'Enter', 69, { [modifier]: true }));
          await new Promise((resolve) => setTimeout(resolve, 110));
          return { submitted, sent: w.__sent.map((x) => x.input), value: ta.value };
        } finally {
          window.fetch = originalFetch;
        }
      }, modifier);
      expect(result).toEqual({ submitted: [], sent: ['Enter'], value: 'Enter' });
    });
  }

  it('retains the old session for Enter during its 80ms window', async () => {
    await setup(true);
    const result = await run(
      "await type('hello'); r.enter(ta); app.sessions.set('ios830-second', { id: 'ios830-second', mode: 'shell' }); app._cleanupPreviousSession(app.activeSessionId); app.activeSessionId = 'ios830-second'; await new Promise(resolve => setTimeout(resolve, 110));"
    );
    expect(result.sent.map((x) => [x.id, x.input])).toEqual([
      [SESSION, 'hello'],
      [SESSION, '\r'],
    ]);
  });

  it('trusted Chromium paste arrives once', async () => {
    await setup(false);
    await page.evaluate(() => navigator.clipboard.writeText('trusted paste'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Unidentified',
      code: '',
      windowsVirtualKeyCode: 0,
      commands: ['paste'],
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Unidentified',
      code: '',
      windowsVirtualKeyCode: 0,
    });
    const result = await run('');
    expect(result.sent.map((x) => x.input)).toEqual(['trusted paste']);
    await cdp.detach();
  });

  it('emoji deletion leaves no lone surrogate in pending echo', async () => {
    await setup(true);
    const result = await run("await type('a😀'); r.backspace(ta);");
    expect(result.pending).toBe('a');
    expect(result.sent).toEqual([]);
  });

  it('a Pane B/grid TerminalTile owns suggestions for its session without 229 recovery', async () => {
    await setup(false);
    const result = await page.evaluate(async () => {
      const w = window as unknown as TestWindow;
      const mount = document.createElement('div');
      mount.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:320px;z-index:9999';
      document.body.appendChild(mount);
      w.app.sessions.set('ios830-tile', { id: 'ios830-tile', mode: 'shell', status: 'idle' });
      const tile = new w.TerminalTile('ios830-tile', mount, { mode: 'shell' });
      try {
        await tile.connect();
        const ta = tile.terminal.textarea;
        ta.focus();
        for (const ch of 'hel') w.IosReplay.typeKey(ta, ch);
        w.IosReplay.typeKey(ta, 'lo');
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { owner: !!tile._iosNativeInput, recovery: tile._keyCode229Recovery, sent: w.__sent };
      } finally {
        tile.destroy();
        mount.remove();
      }
    });
    expect(result.owner).toBe(true);
    expect(result.recovery).toBeNull();
    expect(result.sent.map((x) => [x.id, x.input])).toEqual(
      ['h', 'e', 'l', 'lo'].map((input) => ['ios830-tile', input])
    );
  });

  it('non-iOS coarse-pointer pages retain 229 recovery', async () => {
    const other = await browser.newContext({ hasTouch: true });
    const desktop = await other.newPage();
    try {
      await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await desktop.waitForFunction(() => (window as unknown as TestWindow).app?._keyCode229Recovery, null, {
        timeout: 30000,
      });
      expect(await desktop.evaluate(() => (window as unknown as TestWindow).app._iosNativeInput ?? null)).toBeNull();
    } finally {
      await other.close();
    }
  });
});

function terminalLine(raw: string) {
  const line: string[] = [];
  for (const ch of raw) {
    if (ch === '\x7f') line.pop();
    else line.push(ch);
  }
  return line.join('');
}
