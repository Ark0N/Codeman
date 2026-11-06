/**
 * OSC 52 clipboard writes (`ESC ] 52 ; <sel> ; <base64> BEL`).
 *
 * Programs inside the PTY (Claude Code's /copy, tmux yanks with set-clipboard
 * on, vim) set the clipboard this way. xterm.js registers no handler for 52,
 * and a headless host has no OS clipboard, so without this handler every such
 * copy was dropped. These tests pin the handler itself: decode, UTF-8, the
 * read-query refusal, the replay gates, and the blocked-write fallback.
 *
 * Strategy: run constants.js + terminal-ui.js in a vm with a stub CodemanApp
 * (the harness shape test/terminal-copy-selection.test.ts uses). The handler
 * tests use a fake terminal whose parser records the registered handler; the
 * replay tests drive the REAL chunkedTerminalWrite into a real
 * @xterm/headless terminal, because xterm parses write() data asynchronously
 * and a synchronous stub hides exactly the ordering the replay gate depends on.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless as unknown as {
  Terminal: new (opts: Record<string, unknown>) => { write(data: string, cb?: () => void): void };
};

const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

function loadHarness(copyResult = true, focused = true) {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const document: Record<string, unknown> = {
    getElementById: () => null,
    querySelector: () => null,
    hasFocus: () => focused,
    activeElement: null,
  };
  const context = vm.createContext({
    CodemanApp,
    window: {},
    globalThis: {},
    document,
    console,
    MobileDetection: { isTouchDevice: () => false, getDeviceType: () => 'desktop' },
    Object,
    atob,
    TextDecoder,
    Uint8Array,
    performance,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  });
  vm.runInContext(read('src/web/public/constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('src/web/public/terminal-ui.js'), context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  const copied: string[] = [];
  const fallbacks: string[] = [];
  const toasts: string[] = [];
  app._copyText = async (text: string) => {
    copied.push(text);
    return copyResult;
  };
  app._showClipboardFallback = (text: string) => fallbacks.push(text);
  app.showToast = (msg: string) => toasts.push(msg);
  app._chunkedWriteGen = 0;

  const handlers = new Map<number, (data: string) => boolean>();
  const terminal = {
    parser: { registerOscHandler: (id: number, fn: (data: string) => boolean) => handlers.set(id, fn) },
  };
  return { app, terminal, handlers, copied, fallbacks, toasts, document };
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('OSC 52 clipboard handler', () => {
  it('registers for OSC 52 and copies the decoded UTF-8 payload', async () => {
    const h = loadHarness();
    h.app._installOsc52Clipboard(h.terminal);
    const handler = h.handlers.get(52)!;
    expect(handler).toBeTypeOf('function');

    expect(handler(`c;${b64('héllo — 世界')}`)).toBe(true);
    await flush();
    expect(h.copied).toEqual(['héllo — 世界']);
    expect(h.toasts).toHaveLength(1);
  });

  it('accepts an empty selection field (tmux sends `;<base64>`)', async () => {
    const h = loadHarness();
    h.app._installOsc52Clipboard(h.terminal);
    h.handlers.get(52)!(`;${b64('x')}`);
    await flush();
    expect(h.copied).toEqual(['x']);
  });

  it('ignores clipboard read queries, empty payloads and invalid base64', async () => {
    const h = loadHarness();
    h.app._installOsc52Clipboard(h.terminal);
    const handler = h.handlers.get(52)!;
    for (const data of ['c;?', 'c;', 'c;***not base64***']) expect(handler(data)).toBe(true);
    await flush();
    expect(h.copied).toEqual([]);
  });

  it("uses the caller's replay check when one is given (TerminalTile)", async () => {
    const h = loadHarness();
    let tileLoading = true;
    h.app._installOsc52Clipboard(h.terminal, () => tileLoading);
    h.handlers.get(52)!(`c;${b64('old')}`);
    tileLoading = false;
    h.handlers.get(52)!(`c;${b64('new')}`);
    await flush();
    expect(h.copied).toEqual(['new']);
  });

  it('falls back to the manual-copy dialog when the browser blocks the write', async () => {
    const h = loadHarness(false);
    h.app._installOsc52Clipboard(h.terminal);
    h.handlers.get(52)!(`c;${b64('blocked')}`);
    await flush();
    expect(h.fallbacks).toEqual(['blocked']);
    expect(h.toasts).toEqual([]);
  });

  it('hands focus back when the copy fallback took it (plain HTTP, a refused write)', async () => {
    const h = loadHarness();
    let focusCalls = 0;
    const terminalTextarea = { isConnected: true, focus: () => focusCalls++ };
    h.document.activeElement = terminalTextarea;
    // _copyText's execCommand fallback selects a temporary textarea, then removes
    // it, which leaves focus on <body>.
    h.app._copyText = async () => {
      h.document.activeElement = { tagName: 'BODY' };
      return true;
    };
    h.app._installOsc52Clipboard(h.terminal);
    h.handlers.get(52)!(`c;${b64('copied')}`);
    await flush();
    expect(focusCalls).toBe(1);
  });

  it('copies one Claude Code copy once, though it arrives three times', async () => {
    // What a single /copy in a Codeman tmux session actually delivers: Claude's
    // own OSC 52 plus tmux forwarding it twice (captured from a live session).
    const h = loadHarness();
    h.app._installOsc52Clipboard(h.terminal);
    const handler = h.handlers.get(52)!;
    for (const data of [`;${b64('same')}`, `c;${b64('same')}`, `c;${b64('same')}`]) handler(data);
    handler(`c;${b64('different')}`);
    await flush();
    expect(h.copied).toEqual(['same', 'different']);
    expect(h.toasts).toHaveLength(2);
  });

  it('opens the manual-copy dialog only in the focused tab', async () => {
    // Every tab watching the session receives the OSC 52; a background tab (a
    // phone left on the session) must not pop a dialog for a copy made elsewhere.
    const h = loadHarness(false, false);
    h.app._installOsc52Clipboard(h.terminal);
    h.handlers.get(52)!(`c;${b64('elsewhere')}`);
    await flush();
    expect(h.fallbacks).toEqual([]);
  });

  it('is wired into the main terminal and every TerminalTile', () => {
    const read = (f: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', f), 'utf8');
    expect(read('terminal-ui.js')).toContain('this._installOsc52Clipboard(this.terminal);');
    expect(read('terminal-tile.js')).toContain(
      'global.app?._installOsc52Clipboard?.(this.terminal, () => this._bufferLoading);'
    );
  });
});

describe('main-terminal replay over a real xterm', () => {
  const osc52 = (text: string) => `\x1b]52;c;${b64(text)}\x07`;

  async function replay(buffer: string) {
    const h = loadHarness();
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 1000 });
    h.app.terminal = term;
    h.app._installOsc52Clipboard(term);
    await h.app.chunkedTerminalWrite(buffer);
    // Everything queued so far has been parsed once this callback fires.
    await new Promise<void>((done) => term.write('', () => done()));
    await flush();
    return h;
  }

  it('does not re-copy an OSC 52 in a small (single-write) replay', async () => {
    const h = await replay(`before\r\n${osc52('old copy')}after\r\n`);
    expect(h.copied).toEqual([]);
  });

  it('does not re-copy an OSC 52 in the last chunk of a large replay', async () => {
    const filler = 'x'.repeat(79) + '\r\n';
    const history = filler.repeat(Math.ceil((100 * 1024) / filler.length));
    const h = await replay(`${history}${osc52('recent copy')}tail\r\n`);
    expect(h.copied).toEqual([]);
  });

  it('strips both BEL- and ST-terminated sequences and leaves the rest intact', () => {
    const context = vm.createContext({ window: {}, globalThis: {} });
    vm.runInContext(`${read('src/web/public/constants.js')}\nglobalThis.__re = OSC52_STRIP_RE;`, context);
    const re = (context.globalThis as { __re: RegExp }).__re;
    const input = `a\x1b]52;c;${b64('x')}\x07b\x1b]52;;${b64('y')}\x1b\\c\x1b]0;title\x07d`;
    expect(input.replace(re, '')).toBe('abc\x1b]0;title\x07d');
    // The 8-bit C1 forms (OSC \x9d, ST \x9c), which xterm.js also parses.
    expect(`a\x9d52;c;${b64('x')}\x9cb\x1b]52;c;${b64('y')}\x9cc`.replace(re, '')).toBe('abc');
  });

  it('still copies a live OSC 52 written after the replay', async () => {
    const h = await replay('history\r\n');
    await new Promise<void>((done) => h.app.terminal.write(osc52('live'), () => done()));
    await flush();
    expect(h.copied).toEqual(['live']);
  });
});
