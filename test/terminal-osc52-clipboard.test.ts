/**
 * OSC 52 clipboard writes (`ESC ] 52 ; <sel> ; <base64> BEL`).
 *
 * Programs inside the PTY (Claude Code's /copy, tmux yanks with set-clipboard
 * on, vim) set the clipboard this way. xterm.js registers no handler for 52,
 * and a headless host has no OS clipboard, so without this handler every such
 * copy was dropped. These tests pin the handler itself: decode, UTF-8, the
 * read-query refusal, the replay gate, and the blocked-write fallback.
 *
 * Strategy: run terminal-ui.js in a vm with a stub CodemanApp (the harness
 * shape test/terminal-copy-selection.test.ts uses) and a fake terminal whose
 * parser records the registered handler. No DOM, no xterm.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadHarness(copyResult = true) {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    CodemanApp,
    window: {},
    document: { getElementById: () => null, querySelector: () => null },
    console,
    MobileDetection: { isTouchDevice: () => false, getDeviceType: () => 'desktop' },
    Object,
    atob,
    TextDecoder,
    Uint8Array,
  });
  const terminalUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(terminalUi, context, { filename: 'terminal-ui.js' });

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

  const handlers = new Map<number, (data: string) => boolean>();
  const terminal = {
    parser: { registerOscHandler: (id: number, fn: (data: string) => boolean) => handlers.set(id, fn) },
  };
  return { app, terminal, handlers, copied, fallbacks, toasts };
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

  it('never copies during a buffer replay (main terminal flag)', async () => {
    const h = loadHarness();
    h.app._installOsc52Clipboard(h.terminal);
    h.app._isLoadingBuffer = true;
    h.handlers.get(52)!(`c;${b64('old')}`);
    h.app._isLoadingBuffer = false;
    h.handlers.get(52)!(`c;${b64('new')}`);
    await flush();
    expect(h.copied).toEqual(['new']);
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

  it('is wired into the main terminal and every TerminalTile', () => {
    const read = (f: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', f), 'utf8');
    expect(read('terminal-ui.js')).toContain('this._installOsc52Clipboard(this.terminal);');
    expect(read('terminal-tile.js')).toContain(
      'global.app?._installOsc52Clipboard?.(this.terminal, () => this._bufferLoading);'
    );
  });
});
