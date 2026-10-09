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
  /**
   * Opt-in, set by a test BEFORE the tile connects: the buffer's rows follow
   * what is written, as in xterm. Every `\n` adds a line, `baseY` is the lines
   * beyond the screen, a clear or an in-stream reset (RIS, `\x1bc`) leaves one
   * line, and a resize recomputes it
   * (a row-shrinking fit pushes rows above the screen, a growing one pulls them
   * back). The viewport follows the bottom. Off, `baseY` stays where a test
   * puts it.
   */
  static emulateScroll = false;
  /**
   * Opt-in, set by a test BEFORE the tile connects (and reset after): extra
   * fields merged into `_core`, e.g. xterm's `_compositionHelper` for the
   * keyCode-229 controller, which reads it once when the tile creates it.
   */
  static coreFactory: ((term: FakeTerminal) => Record<string, unknown>) | null = null;
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  dataCb: ((data: string) => void) | null = null;
  buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 24 } };
  /** xterm's own mouse-tracking mode (DECSET 1000 and friends); 'none' while no app asked for the mouse. */
  modes = { mouseTrackingMode: 'none' };
  /** Lines in the buffer while emulating (the cursor line counts). */
  lineCount = 1;
  emulate = FakeTerminal.emulateScroll;
  /** Called after an emulated resize, so a test can stand in for a reflow. */
  afterResize: ((cols: number, rows: number) => void) | null = null;
  /** Where the screen sits and how big a cell renders, for the click-to-cell math. */
  screenRect = { left: 10, top: 20 };
  element = {
    querySelector: (sel: string) =>
      sel === '.xterm-screen' ? { getBoundingClientRect: () => ({ ...this.screenRect }) } : null,
  };
  _core: Record<string, unknown> = {
    _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } },
    ...(FakeTerminal.coreFactory?.(this) ?? {}),
  };
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    FakeTerminal.last = this;
  }
  /** Re-derives baseY (and a viewport following the bottom) from the emulated line count. */
  settleRows() {
    const active = this.buffer.active;
    active.baseY = Math.max(0, this.lineCount - this.rows);
    active.viewportY = active.baseY;
    active.length = Math.max(this.lineCount, this.rows);
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
  /** Every other textarea listener, with the capture flag it was added with (the keyCode-229 controller's). */
  textareaListeners: Array<{ type: string; fn: (ev: Record<string, unknown>) => void; capture: unknown }> = [];
  textarea = {
    /** The helper textarea's text, which xterm's keyCode-229 diff (and the controller's) reads. */
    value: '',
    addEventListener: (type: string, fn: (ev?: Record<string, unknown>) => void, capture?: unknown) => {
      if (type === 'focus') this.focusListeners.push(fn as () => void);
      else this.textareaListeners.push({ type, fn, capture });
    },
    removeEventListener: (type: string, fn: (ev?: Record<string, unknown>) => void, capture?: unknown) => {
      if (type === 'focus') this.focusListeners = this.focusListeners.filter((f) => f !== fn);
      else {
        this.textareaListeners = this.textareaListeners.filter(
          (l) => !(l.type === type && l.fn === fn && Boolean(l.capture) === Boolean(capture))
        );
      }
    },
    /** Delivers `ev` to the textarea's listeners of `type`, in registration order. */
    fire: (type: string, ev: Record<string, unknown> = {}) => {
      for (const l of this.textareaListeners.filter((x) => x.type === type)) l.fn({ type, ...ev });
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
  /**
   * Set by a test: write callbacks do not run, as while xterm is still parsing
   * (or never, on a disposed xterm). They wait in `heldParses` until `parse()`.
   */
  holdParse = false;
  heldParses: Array<() => void> = [];
  /** xterm catches up: runs every write callback held so far, in order. */
  parse() {
    for (const cb of this.heldParses.splice(0)) cb();
  }
  /** Set by a test: the next write of exactly this data throws, as xterm's WriteBuffer does past 50M. */
  throwOnWrite: string | null = null;
  write(data: string, cb?: () => void) {
    if (this.throwOnWrite !== null && data === this.throwOnWrite) {
      this.throwOnWrite = null;
      throw new Error('write data discarded, use flow control to avoid losing data');
    }
    // An empty write puts nothing on screen; the replay queues one only to hear
    // (its callback) that everything before it has been parsed.
    if (data) this.writes.push(data);
    if (data && this.emulate) {
      // A replay's reset (RIS) empties the buffer, as clear() does.
      const reset = data.lastIndexOf('\x1bc');
      if (reset !== -1) this.lineCount = 1;
      this.lineCount += data.slice(reset === -1 ? 0 : reset + 2).split('\n').length - 1;
      this.settleRows();
    }
    if (!cb) return;
    if (this.holdParse) this.heldParses.push(cb);
    else cb();
  }
  clear() {
    this.writes.push('<CLEAR>');
    if (this.emulate) {
      this.lineCount = 1;
      this.settleRows();
    }
  }
  resizes: Array<[number, number]> = [];
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
    this.cols = cols;
    this.rows = rows;
    if (this.emulate) {
      this.settleRows();
      this.afterResize?.(cols, rows);
    }
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
