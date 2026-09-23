/** @fileoverview Real Chromium + real WebSocket coverage for SplitTerminalPane (Task 4 of the split-pane-sessions plan). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3175;
const BASE_URL = `http://localhost:${PORT}`;

describe('SplitTerminalPane in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  it('connects, echoes real PTY output, and cleans up on destroy', async () => {
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
      });
      const id = (await res.json()).data.session.id;
      // Session creation alone leaves pid:null and no pane (per CLAUDE.md's
      // Testing section) — the shell PTY only spawns once this is called, and
      // without it the WS opens but no bytes ever flow, and the echo assertion
      // below would hang until its own timeout for reasons unrelated to
      // SplitTerminalPane.
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      return id;
    });

    const result = await page.evaluate(async (id) => {
      const mount = document.createElement('div');
      mount.style.width = '400px';
      mount.style.height = '300px';
      document.body.appendChild(mount);

      const pane = new (window as any).SplitTerminalPane(id, mount);
      pane.connect();

      // Wait for the WS to open, then send a real input frame — testMode's
      // echo PTY (TEST_PTY_SCRIPT) echoes each byte back exactly once, which
      // is what proves the WS round-trip actually reaches a real PTY and back,
      // not just that xterm can render locally-written text.
      await new Promise((resolve) => {
        const check = () => (pane._wsReady ? resolve(undefined) : setTimeout(check, 100));
        check();
      });
      pane.ws.send(JSON.stringify({ t: 'i', d: 'SPLITPANE_MARKER\r' }));

      const hasEcho = await new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          const buf = pane.terminal.buffer.active;
          for (let i = 0; i < buf.length; i++) {
            if (buf.getLine(i)?.translateToString(true).includes('SPLITPANE_MARKER')) {
              resolve(true);
              return;
            }
          }
          if (Date.now() > deadline) resolve(false);
          else setTimeout(poll, 100);
        };
        poll();
      });

      pane.destroy();
      const cleanedUp = mount.querySelector('.xterm') === null;
      document.body.removeChild(mount);

      return { hasEcho, cleanedUp };
    }, sessionId);

    expect(result.hasEcho).toBe(true);
    expect(result.cleanedUp).toBe(true);

    await page.evaluate(async (id) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('shows existing scrollback immediately on connect, before any new output', async () => {
    // Regression guard: connect() previously only opened the WS and waited for
    // live 'terminal' events (ws-routes.ts sends nothing on connect), so a pane
    // opened onto an already-quiet session stayed blank until either new output
    // arrived or a resize happened to trigger a tmux repaint. Writing a marker
    // and letting the echo settle BEFORE connect() proves the fetched buffer,
    // not a live echo, is what populates the pane.
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
      });
      const id = (await res.json()).data.session.id;
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      // Write directly to the session (not through SplitTerminalPane, which
      // does not exist yet). Poll the real ?full=1 capture (same endpoint
      // connect() below will use) rather than a fixed delay — the shell's
      // own startup can race an early write and, on this box, a startup
      // script issues a `clear` that erases scrollback (modern ncurses
      // `clear` emits \x1b[3J) if the input lands before the shell is ready.
      await fetch(`/api/sessions/${id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'PRE_EXISTING_MARKER\r' }),
      });
      const deadline = Date.now() + 5000;
      for (;;) {
        const res2 = await fetch(`/api/sessions/${id}/terminal?full=1`);
        const buffer = (await res2.json())?.data?.terminalBuffer ?? '';
        if (buffer.includes('PRE_EXISTING_MARKER')) break;
        if (Date.now() > deadline) throw new Error('marker never landed in ?full=1 capture: ' + JSON.stringify(buffer));
        await new Promise((r) => setTimeout(r, 200));
      }
      return id;
    });

    const hasMarker = await page.evaluate(async (id) => {
      const mount = document.createElement('div');
      mount.style.width = '400px';
      mount.style.height = '300px';
      document.body.appendChild(mount);

      const pane = new (window as any).SplitTerminalPane(id, mount);
      await pane.connect();

      // xterm's write() parses asynchronously (it queues data and processes it
      // on a later microtask/frame), so the fetched buffer connect() writes is
      // not necessarily in the rendered buffer the instant connect() resolves.
      // Poll rather than check once — no new input is sent here, so any pass
      // still comes from the ?full=1 fetch inside connect(), never a live echo.
      let found = false;
      const deadline = Date.now() + 3000;
      while (!found && Date.now() < deadline) {
        const buf = pane.terminal.buffer.active;
        for (let i = 0; i < buf.length; i++) {
          if (buf.getLine(i)?.translateToString(true).includes('PRE_EXISTING_MARKER')) {
            found = true;
            break;
          }
        }
        if (!found) await new Promise((r) => setTimeout(r, 50));
      }

      pane.destroy();
      document.body.removeChild(mount);
      return found;
    }, sessionId);

    expect(hasMarker).toBe(true);

    await page.evaluate(async (id) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('gates app-level chords out of Pane B instead of forwarding their raw bytes', async () => {
    // Regression guard for PR #453's Ctrl+K/Alt+1/Alt+B leak: Pane B had no
    // attachCustomKeyEventHandler of its own, so the document capture-phase
    // shortcut handler's preventDefault() (which does not stop xterm) left
    // every one of these chords ALSO writing its raw byte/escape sequence into
    // Pane B's live PTY on top of whatever the app action did to Pane A.
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
      });
      const id = (await res.json()).data.session.id;
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      return id;
    });

    const result = await page.evaluate(async (id) => {
      const mount = document.createElement('div');
      mount.style.width = '400px';
      mount.style.height = '300px';
      document.body.appendChild(mount);

      const pane = new (window as any).SplitTerminalPane(id, mount);
      await pane.connect();
      await new Promise((resolve) => {
        const check = () => (pane._wsReady ? resolve(undefined) : setTimeout(check, 100));
        check();
      });

      const sent: string[] = [];
      const realSend = pane.ws.send.bind(pane.ws);
      pane.ws.send = (payload: string) => {
        sent.push(payload);
        return realSend(payload);
      };

      pane.terminal.focus();
      // Dispatch straight at xterm's own textarea, matching how a real
      // keypress reaches attachCustomKeyEventHandler — page.keyboard.press()
      // goes through the OS/CDP input pipeline and would also trigger the
      // app's document-capture handler (opening a real command palette),
      // which is not what this test is isolating.
      const textarea = (pane.terminal as any)._core?.textarea || (pane.terminal as any).textarea;
      const fire = (init: KeyboardEventInit) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        textarea.dispatchEvent(event);
        return event.defaultPrevented;
      };
      // keyCode is what xterm's evaluateKeyboardEvent switches on to decide
      // whether to produce a data frame at all — at keyCode 0 (unset) it can
      // never emit bytes, so the assertion below held regardless of whether
      // the custom key handler's gate actually fired. Real values (K=75,
      // 1=49, B=66) are what a real keypress carries.
      const app = window.app as any;
      fire({ key: 'k', code: 'KeyK', keyCode: 75, ctrlKey: true }); // command palette
      fire({ key: '1', code: 'Digit1', keyCode: 49, altKey: true }); // Alt+1 tab switch

      // Ctrl+Z (SIGTSTP): this pane's own sessionMode is undefined (no `mode`
      // opt passed to the constructor above), so `this.sessionMode !== 'shell'`
      // holds and the gate must block it, mirroring a non-shell (agent) mode.
      fire({ key: 'z', code: 'KeyZ', keyCode: 90, ctrlKey: true });

      // Shift+Enter: must never reach the PTY as a bare \r (that would submit
      // an incomplete prompt instead of inserting a newline) — it goes out as
      // a POST to /api/sessions/:id/send-key instead.
      const sendKeyCalls: unknown[] = [];
      const realFetch = window.fetch.bind(window);
      window.fetch = ((...args: Parameters<typeof fetch>) => {
        const url = String(args[0]);
        if (url.includes('/send-key')) {
          sendKeyCalls.push(args[1] ? JSON.parse((args[1] as RequestInit).body as string) : null);
        }
        return realFetch(...args);
      }) as typeof fetch;
      fire({ key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true });
      window.fetch = realFetch;

      // Smart-copy Ctrl+C: with a real selection in THIS pane's own terminal,
      // Ctrl+C must copy it (never send 0x03) and must copy Pane B's
      // selection, not Pane A's. app._copyText is stubbed rather than relying
      // on a real clipboard, which headless Chromium may refuse permission
      // for.
      pane.terminal.write('SPLITPANE_COPY_MARKER');
      await new Promise((r) => setTimeout(r, 100));
      pane.terminal.selectAll();
      let copiedText: string | null = null;
      const realCopyText = app._copyText;
      app._copyText = async (text: string) => {
        copiedText = text;
        return true;
      };
      fire({ key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true });
      await new Promise((r) => setTimeout(r, 50));
      app._copyText = realCopyText;

      // Ctrl+Shift+C with NO selection: the blanket "no 'i' frames" check
      // below is NOT what proves this gate works — xterm's own
      // evaluateKeyboardEvent never emits data for a shifted ctrl-letter in
      // the first place (verified live: removing the gate entirely still
      // produces zero WS frames for this exact key), so an absent 'i' frame
      // is true whether or not the app-level shiftKey branch fires. What the
      // branch actually buys is `preventDefault()`, so the browser's own
      // handling of the chord (e.g. Chrome's Inspect-Element binding) is
      // pre-empted, mirroring Pane A's own "never falls through" contract —
      // asserted directly via the dispatched event's defaultPrevented.
      pane.terminal.clearSelection();
      const ctrlShiftCPrevented = fire({ key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true });

      // Alt+B only reaches shouldToggleSessionSidebarFromShortcut's gate when
      // the sidebar layout is actually active (app.js:4325) — under the
      // default header-strip layout the app doesn't treat Alt+B as its own
      // shortcut either, so Pane A forwards the same `ESC b` to its own PTY.
      // Assert the gate where it is meant to hold: sidebar layout active.
      //
      // Setting only the `data-session-list` attribute is not enough: this
      // event bubbles (matching how a real keypress reaches xterm), so it
      // also reaches app.js's OWN document-level capture-phase shortcut
      // dispatcher, which matches the same Alt+B binding and calls the real
      // toggleSessionSidebar() — that reads the persisted settings (still
      // 'header'), re-runs applySessionListLayout(), and resets the
      // attribute back to 'header' before xterm's own (later, non-capture)
      // key handler ever sees it. Persisting the setting through the app's
      // own settings cache keeps the attribute stable across that bubble.
      const prevSettings = { ...app.loadAppSettingsFromStorage() };
      app._cachedAppSettings = { ...prevSettings, sessionListLayout: 'sidebar' };
      app.applySessionListLayout();
      fire({ key: 'b', code: 'KeyB', keyCode: 66, altKey: true }); // Alt+B sidebar toggle
      app._cachedAppSettings = prevSettings;
      app.applySessionListLayout();

      pane.destroy();
      document.body.removeChild(mount);
      return { sent, sendKeyCalls, copiedText, ctrlShiftCPrevented };
    }, sessionId);

    expect(result.sent.every((f) => JSON.parse(f).t !== 'i')).toBe(true);
    expect(result.sendKeyCalls).toEqual([{ key: 'S-Enter' }]);
    expect(result.copiedText).toContain('SPLITPANE_COPY_MARKER');
    expect(result.ctrlShiftCPrevented).toBe(true);

    await page.evaluate(async (id) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    }, sessionId);
  });
});
