/**
 * Live flushes at the scrollback cap must preserve the row being read, not its
 * absolute buffer index. Use real asynchronous xterm parsing so markers track
 * circular-buffer trimming before the mixin restores the viewport (#814).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import xtermHeadless, { type Terminal as HeadlessTerminal } from '@xterm/headless';

const { Terminal } = xtermHeadless as unknown as {
  Terminal: new (opts: Record<string, unknown>) => HeadlessTerminal;
};

const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');
const write = (terminal: HeadlessTerminal, data: string) => new Promise<void>((done) => terminal.write(data, done));
const topRow = (terminal: HeadlessTerminal) => {
  const buffer = terminal.buffer.active;
  return buffer.getLine(buffer.viewportY)?.translateToString(true);
};

function loadHarness(terminal: HeadlessTerminal) {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    CodemanApp,
    window: {},
    globalThis: {},
    document: { getElementById: () => null, querySelector: () => null },
    console,
    MobileDetection: { isTouchDevice: () => false, getDeviceType: () => 'desktop' },
    Object,
    performance,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(read('src/web/public/constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('src/web/public/terminal-ui.js'), context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  Object.assign(app, {
    terminal,
    pendingWrites: [],
    sessions: new Map([['reading', { mode: 'claude' }]]),
    activeSessionId: 'reading',
    _isLoadingBuffer: false,
    _wasAtBottomBeforeWrite: false,
    _localEchoOverlay: null,
    isTerminalAtBottom: () => terminal.buffer.active.viewportY === terminal.buffer.active.baseY,
    _scheduleTerminalWriteFlush: () => {},
    _noteMobileImeAuthoritativeOutput: () => {},
    _hasRecentUserScrollUp: () => false,
    _syncHistoryReloadAction: () => {},
  });
  return app;
}

async function flushAtScrollbackCap(markersEnabled: boolean) {
  const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 100, allowProposedApi: true });
  try {
    // Hide only the marker API for the negative control; writes, buffer trims,
    // scrolling, and _restoreTerminalViewport remain the real implementations.
    if (!markersEnabled) Object.defineProperty(terminal, 'registerMarker', { value: undefined });
    const app = loadHarness(terminal);
    await write(terminal, Array.from({ length: 200 }, (_, i) => `line ${i}\r\n`).join(''));
    expect(terminal.buffer.active.baseY).toBe(100);

    const buffer = terminal.buffer.active;
    let readingRow = -1;
    for (let row = 0; row < buffer.length; row++) {
      if (buffer.getLine(row)?.translateToString(true) === 'line 140') {
        readingRow = row;
        break;
      }
    }
    expect(readingRow).toBeGreaterThanOrEqual(0);
    terminal.scrollToLine(readingRow);
    expect(topRow(terminal)).toBe('line 140');
    expect(app.isTerminalAtBottom()).toBe(false);

    for (let flush = 0; flush < 5; flush++) {
      app.pendingWrites.push(Array.from({ length: 4 }, (_, i) => `line ${200 + flush * 4 + i}\r\n`).join(''));
      app.flushPendingWrites();
      // This barrier runs after the flush's write callback, including its
      // viewport restoration. No wall-clock delay stands in for parsing.
      await write(terminal, '');
      expect(app._terminalWriteInFlight).toBe(false);
    }
    return topRow(terminal);
  } finally {
    terminal.dispose();
  }
}

describe('live terminal viewport at the scrollback cap', () => {
  it('keeps line 140 visible across five flushes using xterm markers', async () => {
    expect(await flushAtScrollbackCap(true)).toBe('line 140');
  });

  it('discriminates against absolute-index restoration without markers', async () => {
    const row = await flushAtScrollbackCap(false);
    expect(row).not.toBe('line 140');
    expect(row).toBe('line 160');
  });

  // ESC[3J (kept by the narrow and middle strips) erases scrollback and disposes
  // the marker the same way a trim does; the reader must keep their row, not
  // land on row 0.
  it.each([true, false])(
    'keeps the reader on their row when one flush clears scrollback and reprints it (markers: %s)',
    async (markersEnabled) => {
      const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 1000, allowProposedApi: true });
      try {
        if (!markersEnabled) Object.defineProperty(terminal, 'registerMarker', { value: undefined });
        const app = loadHarness(terminal);
        const history = Array.from({ length: 200 }, (_, i) => `line ${i}\r\n`).join('');
        await write(terminal, history);
        terminal.scrollToLine(100);
        expect(topRow(terminal)).toBe('line 100');
        expect(app.isTerminalAtBottom()).toBe(false);
        app.pendingWrites.push(`\x1b[H\x1b[2J\x1b[3J${history}`);
        app.flushPendingWrites();
        await write(terminal, '');
        expect(app._terminalWriteInFlight).toBe(false);
        expect(topRow(terminal)).toBe('line 100');
      } finally {
        terminal.dispose();
      }
    }
  );
});
