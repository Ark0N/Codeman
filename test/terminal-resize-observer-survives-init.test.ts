// Port: none (static analysis of the shipped frontend source, no browser/server).
//
// The main terminal refits from a ResizeObserver on #terminalContainer, created
// in initTerminal() (terminal-ui.js), which runs ONCE per page. handleInit() runs
// _resetAllAppState() on EVERY SSE init, page load included, and that reset used
// to disconnect the observer and null it "to prevent a leak on reconnect". So
// from the first init on, the terminal had no observer at all: only a WINDOW
// resize refit it, and anything that resized just the terminal box (the header's
// state rows appearing when a session starts working, the lineage room, the tab
// strip wrapping) left xterm at its old row count, its bottom rows clipped behind
// the toolbar until a tab switch. Measured on the 1.36.0 beta: header 115 -> 170
// px, container 743 -> 688 px, xterm stayed at 35 rows (32 fit) indefinitely.
//
// initTerminal() already disconnects a previous observer before creating one,
// so the reset has nothing to clean up; it must leave the observer alone.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', f), 'utf8');

function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  // Methods in these files close with a two-space-indented brace at column 2.
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end);
}

describe('the terminal resize observer survives SSE init', () => {
  it('_resetAllAppState() does not disconnect or drop terminalResizeObserver', () => {
    const body = methodBody(read('app.js'), '  _resetAllAppState(preserveTerminal = false) {');
    expect(body).not.toMatch(/terminalResizeObserver\s*\.\s*disconnect\s*\(/);
    expect(body).not.toMatch(/terminalResizeObserver\s*=\s*null/);
  });

  it('initTerminal() owns the lifecycle: disconnects any previous observer, then observes the container', () => {
    const body = methodBody(read('terminal-ui.js'), '  initTerminal() {');
    const disconnect = body.indexOf('this.terminalResizeObserver.disconnect()');
    const create = body.indexOf('this.terminalResizeObserver = new ResizeObserver(');
    const observe = body.indexOf('this.terminalResizeObserver.observe(container)');
    expect(disconnect).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(disconnect);
    expect(observe).toBeGreaterThan(create);
  });
});
