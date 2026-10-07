/**
 * @fileoverview Fakes for driving a real TerminalTile (terminal-tile.js) in a
 * `vm` context: its WebSocket, its xterm and the fit addon. A test puts them in
 * the context as `WebSocket`, `Terminal` and `FitAddon.FitAddon`, and runs
 * `connect()` and the socket handlers for real.
 */
import { vi } from 'vitest';

export type Frame = { t: string; d?: string; seq?: number; cid?: string; c?: number; r?: number };

/** A WebSocket the test opens, feeds and closes by hand; `sent` holds every frame the tile sent. */
export class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Frame);
  }
  close = vi.fn(() => {
    this.readyState = 3;
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  inputFrames() {
    return this.sent.filter((f) => f.t === 'i');
  }
  /** The connection drops: closed, and the tile hears `code`. */
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** The fit addon: proposes `FakeFit.proposed` and, like the real one, resizes to it (NaN = hidden pane). */
export class FakeFit {
  static proposed = { cols: 80, rows: 24 };
  term: FakeTerminal | null = null;
  fit() {
    const { cols, rows } = FakeFit.proposed;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    this.term?.resize(cols, rows);
  }
  proposeDimensions() {
    return { ...FakeFit.proposed };
  }
}

/** An xterm that records writes, resizes and its handlers; `type()` feeds onData like a keystroke. */
export class FakeTerminal {
  static last: FakeTerminal | null = null;
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  dataCb: ((data: string) => void) | null = null;
  buffer = { active: { type: 'normal', viewportY: 0, length: 24 } };
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    FakeTerminal.last = this;
  }
  loadAddon(addon: FakeFit) {
    addon.term = this;
  }
  open() {}
  onData(cb: (data: string) => void) {
    this.dataCb = cb;
  }
  keyHandler: ((ev: Record<string, unknown>) => boolean) | null = null;
  focusListeners: Array<() => void> = [];
  textarea = {
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'focus') this.focusListeners.push(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type === 'focus') this.focusListeners = this.focusListeners.filter((f) => f !== fn);
    },
  };
  focusTextarea() {
    for (const fn of this.focusListeners) fn();
  }
  attachCustomKeyEventHandler(fn: (ev: Record<string, unknown>) => boolean) {
    this.keyHandler = fn;
  }
  registerLinkProvider() {}
  writes: string[] = [];
  /** Set by a test: write callbacks never run, as on a disposed xterm. */
  holdParse = false;
  write(data: string, cb?: () => void) {
    // An empty write puts nothing on screen; the replay queues one only to hear
    // (its callback) that everything before it has been parsed.
    if (data) this.writes.push(data);
    if (!this.holdParse) cb?.();
  }
  clear() {
    this.writes.push('<CLEAR>');
  }
  resizes: Array<[number, number]> = [];
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
    this.cols = cols;
    this.rows = rows;
  }
  scrollToLine() {}
  scrollToTop() {}
  dispose() {}
  type(data: string) {
    this.dataCb?.(data);
  }
  /** What a drag selected; '' is no selection. */
  selection = '';
  hasSelection() {
    return this.selection !== '';
  }
  getSelection() {
    return this.selection;
  }
  clearSelection = vi.fn(() => {
    this.selection = '';
  });
  focus = vi.fn();
}
