/**
 * VM port of all 34 phone-prototype replay cases. Browser defaults are applied
 * explicitly, not attributed to xterm. Real xterm command/paste producers,
 * contextmenu selection, computed CSS/layout and trusted keyboard defaults are
 * browser integration gates; these tests cover the owner's side of each case.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Event = Record<string, unknown>;
interface Caret {
  visible: boolean;
  cellsFromEnd: number;
}
interface Transaction {
  inserted: string;
  deleted: number;
  composition: boolean;
}
interface NativeOwner {
  keyFilter(event: Event): boolean;
  reset(reason: string): void;
  settle(): void;
  destroy(): void;
  caret(): Caret;
  onCaret(callback: (caret: Caret) => void): () => void;
  state(): { synced: string; cursor: number; composing: boolean; invalidated: boolean; generation: number };
}
interface NativeOptions {
  terminal: FakeTerminal;
  sendTransaction(ops: string[]): void;
  onTransaction(transaction: Transaction): void;
  onCaret(caret: Caret): void;
  log(entry: Event): void;
  isScreenReaderMode(): boolean;
  blurPolicy: string;
}
interface NativeApi {
  create(options: Partial<NativeOptions>): NativeOwner | null;
  editBetween(previous: string, next: string): { inserted: string; deleted: number };
  classifyKey(event: Event, textarea: FakeTextarea): string;
  isSupported(): boolean;
  attachCaretMarker(
    terminal: FakeTerminal,
    owner: NativeOwner,
    options?: {
      anchor?: () => { col: number; row: number } | 'hide' | null | undefined;
      subscribe?: (callback: () => void) => () => void;
    }
  ): () => void;
}
interface NativeWindow {
  navigator: { userAgent: string; platform?: string; maxTouchPoints: number };
  setTimeout(callback: () => void): number;
  clearTimeout(id: number): boolean;
  CodemanIosNativeInput?: NativeApi;
  MobileImePreview?: { isIosWebKitTouch(nav: NativeWindow['navigator']): boolean };
}
interface FakeHelper {
  _handleAnyTextareaChanges(): void;
  _finalizeComposition(): void;
  _compositionView?: { classList: Set<string> & { remove(value: string): boolean } };
  _isComposing: boolean;
  _isSendingComposition: boolean;
}
interface FakeCore {
  _inputEvent(): unknown;
  _handleTextAreaBlur(): void;
  _compositionHelper: FakeHelper;
  coreService: { triggerDataEvent(): void; decPrivateModes?: { applicationCursorKeys: boolean } };
  unicodeService: { getStringCellWidth?: (text: string) => number };
  _renderService: { dimensions: { css: { cell: { width: number; height: number } } } | null };
}
interface FakeTerminal {
  textarea: FakeTextarea;
  element: FakeNode;
  _core: FakeCore;
  cols: number;
  rows: number;
  buffer: { active: { cursorX: number; cursorY: number; baseY: number; viewportY: number } };
  options: { theme: { cursor: string }; screenReaderMode: boolean };
  onRender(callback: () => void): { dispose(): void };
  onCursorMove(callback: () => void): { dispose(): void };
}
interface Harness {
  api: NativeApi;
  exposed: NativeWindow;
  terminal: FakeTerminal;
  textarea: FakeTextarea;
  document: FakeDocument;
  core: FakeCore;
  helper: FakeHelper;
  rawProducer: { (): void; mock: unknown };
  originals: Array<{
    target: FakeCore | FakeHelper;
    name: string;
    method: unknown;
    descriptor: PropertyDescriptor | undefined;
  }>;
  timers: Map<number, () => void>;
  transactions: string[][];
  notifications: Event[];
  records: Event[];
  caretChanges: Event[];
  sent: string[];
  commits: string[];
  screen: FakeNode;
  renders: Set<() => void>;
  moves: Set<() => void>;
  owner: NativeOwner;
  tick(): void;
  selection(start: number, end?: number, direction?: string): void;
  snapshot(): Array<string | number>;
  silent(type: string, fields?: Event): { defaultPrevented: boolean };
  edit(data: string | null, range?: number[], inputType?: string, composing?: boolean, audit?: boolean): void;
  key(key: string, keyCode: number, extra?: Event): boolean;
  type(text: string, audit?: boolean): void;
  backspace(): void;
  enter(): void;
  begin(): void;
  end(): void;
  blur(): void;
  focus(): void;
  consume(data: string): void;
  replaceOwner(extra?: Partial<NativeOptions>): void;
  setAfterTransaction(callback: (ops: string[]) => void): void;
  setTransactionHandler(callback: (ops: string[]) => void): void;
  onBlur(callback: () => void): void;
  value(): string;
  pending(): string;
  flush(): void;
  clearSent(): void;
  bytes(expected: string[]): void;
  invariant(): void;
}
class FakeStyle {
  cssText = '';
  left = '';
  top = '';
  height = '';
  display = '';
  backgroundColor = '';
  properties = new Map<string, { value: string; priority: string }>();
  getPropertyValue(key: string) {
    return this.properties.get(key)?.value ?? '';
  }
  getPropertyPriority(key: string) {
    return this.properties.get(key)?.priority ?? '';
  }
  setProperty(key: string, value: string, priority = '') {
    this.properties.set(key, { value, priority });
  }
  removeProperty(key: string) {
    this.properties.delete(key);
  }
}
type Listener = (event: Event) => void;
const DEL = '\x7f';
const dels = (count: number) => Array(count).fill(DEL);
const project = (value: string) => value.replace(/\r\n|[\r\n]/g, ' ');
// The destination (Claude Code, Codex, the local-echo overlay) deletes one grapheme cluster per DEL.
const trimGrapheme = (value: string) =>
  [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]
    .slice(0, -1)
    .map((part) => part.segment)
    .join('');

class FakeNode {
  listeners = new Map<string, Set<Listener>>();
  style = new FakeStyle();
  className = '';
  attributes: Record<string, string> = {};
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  ownerDocument!: FakeDocument;
  querySelector: (selector: string) => FakeNode | null = () => null;
  addEventListener(type: string, listener: Listener) {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string, fields: Event = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...fields,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  appendChild(child: FakeNode) {
    child.parent = this;
    this.children.push(child);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }
  count() {
    return [...this.listeners.values()].reduce((total, bucket) => total + bucket.size, 0);
  }
}

class FakeDocument extends FakeNode {
  activeElement: FakeNode | null = null;
  createElement() {
    const node = new FakeNode();
    node.ownerDocument = this;
    return node;
  }
}

class FakeTextarea extends FakeNode {
  private text = '';
  writes: string[] = [];
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = 'none';
  get properties() {
    return this.style.properties;
  }
  constructor(document: FakeDocument) {
    super();
    this.ownerDocument = document;
  }
  get value() {
    return this.text;
  }
  set value(value: string) {
    this.writes.push('value');
    if (this.text !== value) {
      this.selectionStart = this.selectionEnd = value.length;
      this.selectionDirection = 'none';
    }
    this.text = value;
  }
  setSelectionRange(start: number, end: number, direction = 'none') {
    this.writes.push('selection');
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
}

function harness(
  mode = 'direct',
  options: {
    initialValue?: string;
    whitespace?: string;
    priority?: string;
    screenReaderMode?: boolean;
    owner?: Partial<NativeOptions>;
  } = {}
): Harness {
  const document = new FakeDocument();
  const textarea = new FakeTextarea(document);
  textarea.value = options.initialValue ?? '';
  if (options.whitespace) textarea.style.setProperty('white-space', options.whitespace, options.priority ?? '');
  document.activeElement = textarea;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const exposed: NativeWindow = {
    navigator: { userAgent: 'iPhone AppleWebKit/605.1.15', maxTouchPoints: 5 },
    setTimeout: (callback: () => void) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  };
  const context = vm.createContext({ window: exposed, globalThis: exposed });
  for (const file of ['mobile-ime-preview.js', 'terminal-ios-native-input.js']) {
    vm.runInContext(readFileSync(new URL(`../src/web/public/${file}`, import.meta.url), 'utf8'), context, {
      filename: file,
    });
  }
  const rawProducer = vi.fn();
  const activeClasses = new Set<string>(['active']);
  const compositionView = {
    classList: Object.assign(activeClasses, {
      remove: (value: string) => activeClasses.delete(value),
    }),
  };
  const helper: FakeHelper = Object.assign(
    Object.create({
      _handleAnyTextareaChanges: rawProducer,
      _finalizeComposition: rawProducer,
    }),
    { _compositionView: compositionView, _isComposing: false, _isSendingComposition: false }
  );
  let blurCallback = () => {};
  const core: FakeCore = Object.assign(
    Object.create({
      _inputEvent: rawProducer,
      _handleTextAreaBlur() {
        textarea.value = '';
        textarea.setSelectionRange(0, 0);
        blurCallback();
      },
    }),
    {
      _compositionHelper: helper,
      coreService: { triggerDataEvent: rawProducer },
      unicodeService: {
        getStringCellWidth: (text: string) =>
          Array.from(text).reduce((width, point) => width + (/[你好吗]/.test(point) ? 2 : 1), 0),
      },
      _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } },
    }
  );
  const screen = new FakeNode();
  screen.ownerDocument = document;
  const element = new FakeNode();
  element.querySelector = (selector: string) => (selector === '.xterm-screen' ? screen : null);
  const renders = new Set<() => void>();
  const moves = new Set<() => void>();
  const subscribe = (set: Set<() => void>, callback: () => void) => {
    set.add(callback);
    return { dispose: () => set.delete(callback) };
  };
  const terminal: FakeTerminal = {
    textarea,
    element,
    _core: core,
    cols: 10,
    rows: 5,
    buffer: { active: { cursorX: 5, cursorY: 2, baseY: 0, viewportY: 0 } },
    options: { theme: { cursor: '#fff' }, screenReaderMode: !!options.screenReaderMode },
    onRender: (callback: () => void) => subscribe(renders, callback),
    onCursorMove: (callback: () => void) => subscribe(moves, callback),
  };
  const originals = [
    { target: core, name: '_inputEvent' },
    { target: core, name: '_handleTextAreaBlur' },
    { target: helper, name: '_handleAnyTextareaChanges' },
    { target: helper, name: '_finalizeComposition' },
  ].map(({ target, name }) => ({
    target,
    name,
    method: Reflect.get(target, name),
    descriptor: Object.getOwnPropertyDescriptor(target, name),
  }));
  const sent: string[] = [];
  const transactions: string[][] = [];
  const notifications: Event[] = [];
  const records: Event[] = [];
  const caretChanges: Event[] = [];
  let line = '';
  let pending = '';
  const commits: string[] = [];
  const consume = (data: string) => {
    sent.push(data);
    if (data === DEL) {
      if (pending) pending = trimGrapheme(pending);
      else line = trimGrapheme(line);
    } else if (data === '\r') {
      commits.push(line + pending);
      line = '';
      pending = '';
    } else if (data === '\x03') {
      line = '';
      pending = '';
    } else if (data.startsWith('\x1b')) {
      /* xterm command effect belongs to browser tests */
    } else if (mode === 'local-echo') pending += data;
    else line += data;
  };
  let afterTransaction = (_ops: string[]) => {};
  let transactionHandler = (ops: string[]) => {
    for (const op of ops) consume(op);
  };
  // The IIFE just installed this API into the VM's window.
  const api = exposed.CodemanIosNativeInput!;
  const create = (extra: Partial<NativeOptions> = {}) =>
    api.create({
      terminal,
      sendTransaction(ops: string[]) {
        transactions.push([...ops]);
        transactionHandler(ops);
        afterTransaction(ops);
      },
      onTransaction: (transaction: Transaction) => notifications.push({ ...transaction }),
      onCaret: (caret: Caret) => caretChanges.push({ ...caret }),
      log: (entry: Event) => records.push(entry),
      ...extra,
    });
  // Normal replay fixtures have complete internals; null is asserted explicitly
  // by the screen-reader/unsupported creation tests.
  let owner = create(options.owner)!;
  const tick = () => {
    for (const [id, callback] of [...timers]) {
      timers.delete(id);
      callback();
    }
  };
  const selection = (start: number, end = start, direction = 'none') => {
    textarea.setSelectionRange(start, end, direction);
    document.fire('selectionchange');
  };
  const snapshot = () => [textarea.value, textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection];
  const silent = (type: string, fields: Event = {}) => {
    const before = snapshot();
    const writes = textarea.writes.length;
    const event = textarea.fire(type, fields);
    expect(snapshot()).toEqual(before);
    expect(textarea.writes).toHaveLength(writes);
    return event;
  };
  const edit = (data: string | null, range?: number[], inputType = 'insertText', composing = false, audit = true) => {
    if (range) textarea.setSelectionRange(range[0], range[1]);
    const fields = { data, inputType, isComposing: composing };
    const before = silent('beforeinput', fields);
    if (before.defaultPrevented) return;
    let start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (inputType === 'deleteContentBackward') {
      if (start === end) {
        if (start === 0) return;
        // WebKit removes one whole grapheme cluster per Backspace.
        const clusters = [
          ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(textarea.value.slice(0, start)),
        ];
        start -= clusters.at(-1)!.segment.length;
      }
      textarea.value = textarea.value.slice(0, start) + textarea.value.slice(end);
      textarea.setSelectionRange(start, start);
    } else {
      const text = inputType === 'insertLineBreak' ? '\n' : (data ?? '');
      textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
      textarea.setSelectionRange(start + text.length, start + text.length);
    }
    if (audit) silent('input', fields);
    else textarea.fire('input', fields);
  };
  const key = (key: string, keyCode: number, extra: Event = {}) => {
    const event = { type: 'keydown', key, keyCode, ...extra };
    textarea.fire('keydown', event);
    return owner.keyFilter(event);
  };
  const type = (text: string, audit = true) => {
    key(text, text === ' ' ? 32 : text.toUpperCase().codePointAt(0)!);
    expect(owner.keyFilter({ type: 'keypress', key: text })).toBe(false);
    edit(text, undefined, 'insertText', false, audit);
  };
  const backspace = () => {
    if (key('Backspace', 8)) consume(DEL);
    else edit(null, undefined, 'deleteContentBackward');
  };
  const enter = () => {
    if (key('Enter', 13)) consume('\r');
  };
  const begin = () => {
    helper._isComposing = true;
    helper._isSendingComposition = true;
    compositionView.classList.add('active');
    textarea.fire('compositionstart');
  };
  const end = () => {
    helper._finalizeComposition();
    textarea.fire('compositionend');
  };
  const blur = () => {
    document.activeElement = null;
    core._handleTextAreaBlur();
    textarea.fire('blur');
  };
  const focus = () => {
    document.activeElement = textarea;
    textarea.fire('focus');
  };
  return {
    api,
    exposed,
    terminal,
    textarea,
    document,
    core,
    helper,
    rawProducer,
    originals,
    timers,
    tick,
    transactions,
    notifications,
    records,
    caretChanges,
    sent,
    commits,
    selection,
    snapshot,
    silent,
    edit,
    key,
    type,
    backspace,
    enter,
    begin,
    end,
    blur,
    focus,
    screen,
    renders,
    moves,
    consume,
    get owner() {
      return owner;
    },
    replaceOwner(extra: Partial<NativeOptions> = {}) {
      owner.destroy();
      owner = create(extra)!;
    },
    setAfterTransaction(callback: (ops: string[]) => void) {
      afterTransaction = callback;
    },
    setTransactionHandler(callback: (ops: string[]) => void) {
      transactionHandler = callback;
    },
    onBlur(callback: () => void) {
      blurCallback = callback;
    },
    value: () => line + pending,
    pending: () => pending,
    flush() {
      line += pending;
      pending = '';
    },
    clearSent() {
      sent.length = 0;
      transactions.length = 0;
    },
    bytes(expected: string[]) {
      expect(sent).toEqual(expected);
    },
    invariant() {
      expect(owner.state().synced).toBe(project(textarea.value));
      expect(owner.state().cursor).toBe(Array.from(project(textarea.value)).length);
      expect(records.filter((record) => record.type === 'error')).toEqual([]);
    },
  };
}

const replayCases: Array<[string, (h: Harness) => void]> = [
  [
    '1 suggestion insertText',
    (h) => {
      expect(Object.isFrozen(h.api)).toBe(true);
      expect(h.api.create({})).toBeNull();
      expect(h.api.create({ terminal: h.terminal, sendTransaction() {}, isScreenReaderMode: () => true })).toBeNull();
      expect(h.api.editBetween('a👍b', 'aX')).toEqual({ deleted: 2, inserted: 'X' });
      // One DEL per grapheme cluster: WebKit removes the whole cluster on one
      // Backspace, and Claude Code and Codex delete one grapheme per DEL.
      for (const emoji of [
        '\u2764\uFE0F',
        '\u{1F44D}\u{1F3FD}',
        '\u{1F1EB}\u{1F1F7}',
        '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}',
      ]) {
        expect(h.api.editBetween(`ok${emoji}`, 'ok')).toEqual({ deleted: 1, inserted: '' });
        expect(h.api.editBetween(`a${emoji}b`, 'aX')).toEqual({ deleted: 2, inserted: 'X' });
      }
      // A combining mark or tone typed onto the last letter is a plain append, as on master.
      expect(h.api.editBetween('\u0E01', '\u0E01\u0E34')).toEqual({ deleted: 0, inserted: '\u0E34' });
      expect(h.api.editBetween('\u0915\u094D', '\u0915\u094D\u0937')).toEqual({ deleted: 0, inserted: '\u0937' });
      for (const ch of 'hel') h.type(ch);
      h.type('lo');
      h.tick();
      h.bytes(['h', 'e', 'l', 'lo']);
      expect(h.value()).toBe('hello');
      h.invariant();
    },
  ],
  [
    '2 suggestion replacement',
    (h) => {
      for (const ch of 'hel') h.type(ch);
      h.edit('hello', [0, 3], 'insertReplacementText');
      h.bytes(['h', 'e', 'l', 'lo']);
      h.invariant();
    },
  ],
  [
    '3 space and suggestion',
    (h) => {
      for (const ch of 'hello') h.type(ch);
      h.type(' ');
      h.type('the');
      h.bytes([...Array.from('hello'), ' ', 'the']);
      h.invariant();
    },
  ],
  [
    '4 whole-line replacement after delete',
    (h) => {
      for (const ch of 'helloworld') h.type(ch);
      h.flush();
      h.backspace();
      h.edit('Hello World', [0, 9], 'insertReplacementText');
      h.bytes([...Array.from('helloworld'), ...dels(10), 'Hello World']);
      expect(h.value()).toBe('Hello World');
    },
  ],
  [
    '5 held Backspace bursts',
    (h) => {
      for (const ch of 'hello world again') {
        h.type(ch);
        h.invariant();
      }
      h.backspace();
      for (let burst = 0; burst < 2; burst++) {
        for (let index = 0; index < 7; index++) {
          h.backspace();
          h.invariant();
        }
        // The captured iOS burst has one final deletion without another keydown.
        h.edit(null, undefined, 'deleteContentBackward');
        h.invariant();
      }
      h.bytes([...Array.from('hello world again'), ...dels(17)]);
      expect(h.value()).toBe('');
    },
  ],
  [
    '6 empty-field terminal Backspace',
    (h) => {
      h.backspace();
      h.backspace();
      h.bytes([DEL, DEL]);
      expect(h.transactions).toEqual([]);
    },
  ],
  [
    '7 command-named suggestions and classification',
    (h) => {
      for (const text of ['Enter', 'Tab', 'Home']) h.type(text);
      h.bytes(['Enter', 'Tab', 'Home']);
      const commands: Record<string, number> = {
        Enter: 13,
        Tab: 9,
        Escape: 27,
        ArrowLeft: 37,
        ArrowUp: 38,
        ArrowRight: 39,
        ArrowDown: 40,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34,
        Insert: 45,
        Delete: 46,
      };
      for (let index = 1; index <= 12; index++) commands['F' + index] = 111 + index;
      for (const [key, keyCode] of Object.entries(commands)) {
        expect(h.api.classifyKey({ key, keyCode }, h.textarea)).toBe('command');
        expect(h.api.classifyKey({ key, keyCode: 0 }, h.textarea)).toBe('native');
      }
      for (const key of ['UpArrow', 'DownArrow', 'LeftArrow', 'RightArrow', 'Escape']) {
        expect(h.api.classifyKey({ key: 'UIKeyInput' + key }, h.textarea)).toBe('command');
      }
      for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
        expect(h.api.classifyKey({ key: 'x', keyCode: 88, [modifier]: true }, h.textarea)).toBe('command');
      }
      expect(h.api.classifyKey({ key: 'F13', keyCode: 112 }, h.textarea)).toBe('native');
      expect(h.api.classifyKey({ key: 'Process' }, h.textarea)).toBe('compose');
      expect(h.api.classifyKey({ key: 'x', keyCode: 229, ctrlKey: true }, h.textarea)).toBe('compose');
      expect(h.api.classifyKey({ key: 'x', isComposing: true }, h.textarea)).toBe('compose');
    },
  ],
  [
    '8 Enter command boundary',
    (h) => {
      h.type('ls');
      h.enter();
      expect(h.textarea.value).toBe('');
      h.type('pwd');
      h.bytes(['ls', '\r', 'pwd']);
      expect(h.commits).toEqual(['ls']);
      h.invariant();
    },
  ],
  [
    '9 keyless dictation',
    (h) => {
      h.edit('hello world');
      h.bytes(['hello world']);
      h.invariant();
    },
  ],
  [
    '10 captured dictation event order',
    (h) => {
      // Ten input events from round1/log-2026-11-18T09-09-26-578Z.json.
      // Preserve noncollapsed hypothesis ranges; ignore stale collapsed snapshots.
      for (const text of ['he', 'hello', 'hello World', 'hello World,\n']) h.edit(text, [0, h.textarea.value.length]);
      h.silent('input', { inputType: 'insertParagraph', data: null });
      h.edit('hello');
      h.edit(' ');
      h.edit('World');
      h.edit(null, undefined, 'insertLineBreak');
      h.edit('Test');
      h.bytes(['he', 'llo', ' World', ', ', 'hello', ' ', 'World', ' ', 'Test']);
      expect(h.records.filter((record) => record.type === 'drift')).toEqual([]);
      expect(h.sent.some((data) => /[\r\n]/.test(data))).toBe(false);
      h.invariant();
    },
  ],
  [
    '11 229 recovery and drift',
    (h) => {
      h.key('Process', 229);
      h.textarea.value = 'hello';
      h.textarea.setSelectionRange(5, 5);
      h.tick();
      h.bytes(['hello']);
      h.owner.reset('boundary');
      h.clearSent();
      h.textarea.value = 'external';
      h.selection(8);
      h.silent('beforeinput', { inputType: 'insertText', data: 'x' });
      expect(h.owner.state().invalidated).toBe(true);
      h.owner.settle();
      h.tick();
      h.bytes([]);
      expect(h.textarea.value).toBe('external');
      h.edit('x', undefined, 'insertText', false, false);
      h.bytes([]);
      expect(h.textarea.value).toBe('');
      h.type('z');
      h.bytes(['z']);
      for (const [value, inputType, data, range] of [
        ['abc', 'deleteContentBackward', null, [3, 3]],
        ['abc', 'insertReplacementText', 'Q', [0, 3]],
        ['', 'insertText', 'Q', [0, 0]],
      ] as const) {
        h.owner.reset('boundary');
        h.type('remote');
        const remote = h.value();
        h.clearSent();
        h.textarea.value = value;
        h.edit(data, [...range], inputType, false, false);
        h.tick();
        h.bytes([]);
        expect(h.value()).toBe(remote);
        expect(h.textarea.value).toBe('');
        h.type('x');
        h.bytes(['x']);
        expect(h.value()).toBe(remote + 'x');
      }
      h.owner.reset('boundary');
      h.clearSent();
      h.textarea.value = 'abc';
      h.selection(0);
      h.backspace();
      h.owner.settle();
      h.tick();
      h.bytes([]);
      expect(h.textarea.value).toBe('abc');
      expect(h.owner.state().invalidated).toBe(true);
      h.owner.reset('boundary');
      h.textarea.value = 'unowned';
      h.replaceOwner();
      expect(h.owner.state().synced).toBe('');
      h.edit('x', undefined, 'insertText', false, false);
      expect(h.textarea.value).toBe('');
      h.bytes([]);
      h.type('y');
      h.bytes(['y']);
      h.owner.reset('boundary');
      h.clearSent();
      h.key('Process', 229);
      h.textarea.value = 'stale';
      const generation = h.owner.state().generation;
      h.owner.reset('cancel');
      h.tick();
      h.bytes([]);
      expect(h.owner.state().generation).toBe(generation + 1);
    },
  ],
  [
    '12 composition and immediate Enter',
    (h) => {
      h.begin();
      h.edit('にほ', undefined, 'insertCompositionText', true);
      h.key('x', 88);
      h.tick();
      h.bytes([]);
      h.end();
      h.enter();
      h.tick();
      h.bytes(['にほ', '\r']);
      expect(h.commits).toEqual(['にほ']);
      expect(h.helper._isComposing).toBe(false);
      expect(h.helper._isSendingComposition).toBe(false);
      expect(h.helper._compositionView!.classList.has('active')).toBe(false);
    },
  ],
  [
    '13 xterm-owned paste',
    (h) => {
      h.type('hello');
      const paste = h.textarea.fire('paste');
      expect(paste.defaultPrevented).toBe(true);
      expect(h.textarea.value).toBe('');
      h.consume(' world');
      h.type('x');
      h.bytes(['hello', ' world', 'x']);
      expect(h.transactions).toEqual([['hello'], ['x']]);
    },
  ],
  [
    '14 blur preservation',
    (h) => {
      h.type('hel');
      h.selection(1, 2, 'backward');
      const generation = h.owner.state().generation;
      h.blur();
      expect(h.snapshot()).toEqual(['hel', 1, 2, 'backward']);
      expect(h.owner.state().generation).toBe(generation);
      h.focus();
      h.selection(3);
      h.type('lo');
      h.bytes(['hel', 'lo']);
      h.onBlur(() => h.owner.reset('blur callback'));
      h.blur();
      expect(h.textarea.value).toBe('');
      h.onBlur(() => {});
      h.replaceOwner({ blurPolicy: 'stock' });
      h.focus();
      h.type('stock');
      h.blur();
      expect(h.textarea.value).toBe('');
      expect(h.owner.state().synced).toBe('');
    },
  ],
  [
    '15 selection replacement',
    (h) => {
      h.type('hello');
      h.edit('X', [1, 3]);
      h.bytes(['hello', ...dels(4), 'Xlo']);
      expect(h.value()).toBe('hXlo');
      h.invariant();
    },
  ],
  [
    '16 one-shot Ctrl reset',
    (h) => {
      h.type('hello');
      h.setTransactionHandler((ops) => {
        if (ops.includes('c')) {
          h.owner.reset('one-shot Ctrl');
          h.consume('\x03');
        } else for (const op of ops) h.consume(op);
      });
      h.type('c', false);
      expect(h.textarea.value).toBe('');
      expect(h.owner.state().synced).toBe('');
      h.type('x');
      h.bytes(['hello', '\x03', 'x']);
      expect(h.value()).toBe('x');
      // The sink models integration's one-shot transformation before delivery.
    },
  ],
  [
    '17 ArrowLeft command boundary',
    (h) => {
      h.type('hello');
      expect(h.key('ArrowLeft', 37)).toBe(true);
      expect(h.textarea.value).toBe('');
      h.consume('\x1b[D');
      h.type('X');
      h.bytes(['hello', '\x1b[D', 'X']);
      expect(h.transactions).toEqual([['hello'], ['X']]);
    },
  ],
  [
    '18 reentrant reset and reconciliation',
    (h) => {
      h.type('helloworld');
      h.backspace();
      let resets = 0;
      h.setAfterTransaction((ops) => {
        if (ops[0] === DEL && resets++ === 0) h.owner.reset('reentrant');
      });
      h.edit('Hello World', [0, 9], 'insertReplacementText', false, false);
      expect(h.owner.state().synced).toBe('');
      h.type('x');
      h.bytes(['helloworld', ...dels(10), 'Hello World', 'x']);
      h.owner.reset('boundary');
      h.clearSent();
      h.setAfterTransaction((ops) => {
        if (ops[0] === 'a') {
          h.textarea.value = 'ab';
          h.textarea.setSelectionRange(2, 2);
          h.textarea.fire('input');
          h.owner.settle();
        }
      });
      h.edit('a', undefined, 'insertText', false, false);
      h.bytes(['a', 'b']);
      h.invariant();
    },
  ],
  [
    '19 keyup focus ownership',
    (h) => {
      h.type('hel');
      h.document.activeElement = new FakeNode();
      expect(h.owner.keyFilter({ type: 'keyup' })).toBe(false);
      expect(h.document.activeElement).not.toBe(h.textarea);
      h.focus();
      expect(h.owner.keyFilter({ type: 'keyup' })).toBe(true);
      h.bytes(['hel']);
    },
  ],
  [
    '20 code-point deletion',
    (h) => {
      h.type('👍');
      h.backspace();
      h.bytes(['👍', DEL]);
      h.type('hello');
      h.clearSent();
      h.selection(0);
      h.backspace();
      h.bytes([]);
      expect(h.textarea.value).toBe('hello');
    },
  ],
  [
    '20b grapheme-cluster deletion sends one DEL',
    (h) => {
      for (const emoji of [
        '\u2764\uFE0F',
        '\u{1F44D}\u{1F3FD}',
        '\u{1F1EB}\u{1F1F7}',
        '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}',
      ]) {
        h.type('ok');
        h.edit(emoji);
        h.clearSent();
        h.backspace();
        expect(h.textarea.value).toBe('ok');
        h.bytes([DEL]);
        // The destination keeps the draft: one DEL took the whole emoji, nothing before it.
        expect(h.value()).toBe('ok');
        h.invariant();
        h.backspace();
        h.backspace();
        expect(h.value()).toBe('');
        h.clearSent();
      }
    },
  ],
  [
    '20c combining marks typed one key at a time are plain appends',
    (h) => {
      // Thai กิ่ and Hindi क्ष: each keystroke extends the last grapheme cluster.
      // Re-typing that cluster would make a code-point line editor (zsh) double the base letter.
      for (const word of ['\u0E01\u0E34\u0E48', '\u0915\u094D\u0937']) {
        for (const ch of word) h.edit(ch);
        h.tick();
        h.bytes(Array.from(word));
        expect(h.value()).toBe(word);
        h.invariant();
        while (h.textarea.value) h.backspace();
        expect(h.value()).toBe('');
        h.tick();
        h.clearSent();
      }
    },
  ],
  [
    '21 destroy restoration and stock behavior',
    (h) => {
      h.key('Process', 229);
      h.textarea.value = 'unsent';
      h.owner.destroy();
      h.owner.destroy();
      h.tick();
      h.bytes([]);
      for (const { target, name, method, descriptor } of h.originals) {
        expect(Reflect.get(target, name)).toBe(method);
        expect(Object.getOwnPropertyDescriptor(target, name)).toEqual(descriptor);
      }
      expect(h.textarea.style.getPropertyValue('white-space')).toBe('');
      expect(h.textarea.count()).toBe(0);
      expect(h.document.count()).toBe(0);
      expect(h.terminal.element.count()).toBe(0);
      h.core._inputEvent();
      expect(h.rawProducer).toHaveBeenCalledOnce();
      h.core._handleTextAreaBlur();
      expect(h.textarea.value).toBe('');
    },
  ],
  [
    '22 intact dictation hypothesis replacement',
    (h) => {
      for (const text of ['he', 'hello', 'hello World', 'hello World,\n']) h.edit(text, [0, h.textarea.value.length]);
      h.silent('input', { inputType: 'insertParagraph', data: null });
      expect(h.textarea.value).toBe('hello World,\n');
      h.edit('hello', [0, h.textarea.value.length]);
      h.edit(' ');
      h.edit('World');
      h.edit(null, undefined, 'insertLineBreak');
      h.edit('Test');
      h.bytes(['he', 'llo', ' World', ', ', ...dels(8), ' ', 'World', ' ', 'Test']);
      expect(h.textarea.value).toBe('hello World\nTest');
      expect(h.value()).toBe('hello World Test');
      h.invariant();
      for (const text of ['a\nb', 'a\r\nb', 'a\rb', '\na\n\nb\r', 'a\u00a0']) {
        h.owner.reset('boundary');
        h.clearSent();
        h.edit(text);
        h.bytes([project(text)]);
        h.invariant();
      }
    },
  ],
  [
    '23 dictated line break then Enter',
    (h) => {
      h.edit('hello');
      h.edit(null, undefined, 'insertLineBreak');
      h.edit('World');
      expect(h.textarea.value).toBe('hello\nWorld');
      h.enter();
      h.tick();
      h.bytes(['hello', ' ', 'World', '\r']);
      expect(h.commits).toEqual(['hello World']);
      expect(h.textarea.value).toBe('');
    },
  ],
  [
    '24 trackpad visual caret and insertion',
    (h) => {
      h.type('hello');
      h.clearSent();
      h.selection(2);
      h.bytes([]);
      expect(h.owner.caret()).toEqual({ visible: true, cellsFromEnd: 3 });
      const dispose = h.api.attachCaretMarker(h.terminal, h.owner);
      const marker = h.screen.children[0];
      expect(marker.attributes['aria-hidden']).toBe('true');
      expect(marker.style.cssText).toContain('pointer-events:none');
      expect([marker.style.left, marker.style.top, marker.style.height, marker.style.display]).toEqual([
        '16px',
        '32px',
        '16px',
        'block',
      ]);
      h.edit('X');
      h.bytes([...dels(3), 'Xllo']);
      expect(h.value()).toBe('heXllo');
      expect(h.owner.caret()).toEqual({ visible: true, cellsFromEnd: 3 });
      h.clearSent();
      h.selection(6);
      expect(marker.style.display).toBe('none');
      h.bytes([]);
      h.selection(3);
      h.terminal.buffer.active.cursorX = 0;
      h.terminal.buffer.active.cursorY = 1;
      for (const callback of h.renders) callback();
      expect([marker.style.left, marker.style.top]).toEqual(['56px', '0px']);
      h.terminal.buffer.active.cursorY = 0;
      for (const callback of h.moves) callback();
      expect(marker.style.display).toBe('none');
      dispose();
      dispose();
      expect(h.screen.children).toHaveLength(0);
      expect(h.renders.size + h.moves.size).toBe(0);
    },
  ],
  [
    '25 mid-word native delete',
    (h) => {
      h.type('hello');
      h.clearSent();
      h.selection(2);
      h.backspace();
      h.bytes([...dels(4), 'llo']);
      expect(h.value()).toBe('hllo');
      h.invariant();
    },
  ],
  [
    '26 origin Backspace native no-op',
    (h) => {
      h.consume('z');
      h.type('hello');
      h.clearSent();
      h.selection(0);
      expect(h.api.classifyKey({ key: 'Backspace', keyCode: 8 }, h.textarea)).toBe('native');
      h.backspace();
      h.bytes([]);
      expect(h.value()).toBe('zhello');
      expect(h.textarea.value).toBe('hello');
      h.invariant();
    },
  ],
  [
    '27 middle-word native replacement',
    (h) => {
      h.type('one cat two');
      h.clearSent();
      h.edit('dog', [4, 7], 'insertReplacementText');
      h.bytes([...dels(7), 'dog two']);
      expect(h.value()).toBe('one dog two');
      h.invariant();
    },
  ],
  [
    '28 range selection hides caret',
    (h) => {
      h.type('hello');
      h.clearSent();
      h.selection(1, 3, 'backward');
      h.bytes([]);
      expect(h.owner.caret().visible).toBe(false);
      expect(h.owner.state().cursor).toBe(5);
      h.edit('X');
      h.bytes([...dels(4), 'Xlo']);
      h.invariant();
    },
  ],
  [
    '29 width table and cursor modes',
    (h) => {
      h.type('你好');
      h.clearSent();
      for (const applicationCursorKeys of [true, false]) {
        h.core.coreService.decPrivateModes = { applicationCursorKeys };
        h.selection(1);
        h.bytes([]);
        expect(h.owner.caret()).toEqual({ visible: true, cellsFromEnd: 2 });
      }
      h.core.unicodeService.getStringCellWidth = undefined;
      expect(h.owner.caret()).toEqual({ visible: true, cellsFromEnd: 1 });
      h.selection(2);
      expect(h.owner.caret().visible).toBe(false);
    },
  ],
  [
    '30 caret notifications and silent lifecycle',
    (h) => {
      h.type('hello');
      h.clearSent();
      const changes: Caret[] = [];
      const unsubscribe = h.owner.onCaret((caret: Caret) => changes.push(caret));
      h.selection(2);
      h.selection(2);
      expect(changes).toEqual([{ visible: true, cellsFromEnd: 3 }]);
      h.blur();
      const before = h.caretChanges.length;
      h.document.fire('selectionchange');
      expect(h.caretChanges).toHaveLength(before);
      h.focus();
      h.begin();
      expect(h.owner.caret().visible).toBe(false);
      h.end();
      expect(h.owner.caret().visible).toBe(true);
      h.owner.reset('silent');
      h.tick();
      h.bytes([]);
      expect(changes.map((value) => value.visible)).toEqual([true, false, true, false, true, false]);
      unsubscribe();
      h.selection(0);
      expect(changes).toHaveLength(6);
    },
  ],
  [
    '31 projected code-point caret',
    (h) => {
      h.edit('a👍\nb');
      h.clearSent();
      h.selection(4);
      expect(h.owner.caret().cellsFromEnd).toBe(1);
      h.selection(3);
      expect(h.owner.caret().cellsFromEnd).toBe(2);
      h.selection(1);
      expect(h.owner.caret().cellsFromEnd).toBe(h.core.unicodeService.getStringCellWidth!('👍 b'));
      h.selection(3);
      h.edit('X');
      h.bytes([DEL, DEL, 'X b']);
      expect(h.value()).toBe('a👍X b');
      h.invariant();
    },
  ],
  [
    '32 local-echo end-anchored edit and Enter',
    (h) => {
      h.type('hello');
      h.selection(2);
      h.type('X');
      expect(h.value()).toBe('heXllo');
      h.enter();
      h.type('next');
      h.bytes(['hello', ...dels(3), 'Xllo', '\r', 'next']);
      expect(h.commits).toEqual(['heXllo']);
      expect(h.value()).toBe('next');
      h.invariant();
    },
  ],
  [
    '33 end-anchored transaction reset and reentrancy',
    (h) => {
      h.type('hello');
      let resets = 0;
      h.setAfterTransaction((ops) => {
        if (ops[0] === DEL && resets++ === 0) h.owner.reset('DEL callback');
      });
      h.edit('X', [2, 2], 'insertText', false, false);
      h.bytes(['hello', ...dels(3), 'Xllo']);
      expect(h.transactions).toEqual([['hello'], [...dels(3), 'Xllo']]);
      expect([h.textarea.value, h.owner.state().synced, h.owner.state().cursor]).toEqual(['', '', 0]);
      h.clearSent();
      h.setAfterTransaction(() => {});
      h.type('hello');
      h.setAfterTransaction((ops) => {
        if (ops[0] === DEL) h.selection(4);
      });
      h.edit('X', [2, 2], 'insertText', false, false);
      h.bytes(['hello', ...dels(3), 'Xllo']);
      expect(h.owner.caret()).toEqual({ visible: true, cellsFromEnd: 2 });
      h.invariant();
    },
  ],
  [
    '34 known contextmenu clipboard writer',
    (h) => {
      for (const boundary of ['keydown', 'copy', 'keyless', 'blur']) {
        h.owner.reset('boundary');
        h.type('hello');
        h.selection(2);
        h.clearSent();
        h.terminal.element.fire('contextmenu');
        h.terminal.element.fire('contextmenu');
        // Simulate xterm's known bubble-phase writer after the owner's capture.
        h.textarea.value = 'clipboard';
        h.selection(0, 9);
        h.owner.settle();
        h.bytes([]);
        expect(h.owner.state().synced).toBe('hello');
        if (boundary === 'copy') {
          h.document.fire('copy');
          h.tick();
          expect(h.snapshot()).toEqual(['hello', 2, 2, 'none']);
        }
        if (boundary === 'blur') {
          h.blur();
          expect(h.snapshot()).toEqual(['hello', 2, 2, 'none']);
          h.focus();
        }
        if (boundary === 'keyless') {
          const remote = h.value();
          h.edit('X', undefined, 'insertText', false, false);
          h.tick();
          h.bytes([]);
          expect(h.textarea.value).toBe('');
          h.type('x');
          h.bytes(['x']);
          expect(h.value()).toBe(remote + 'x');
        } else {
          h.type('X');
          h.tick();
          h.bytes([...dels(3), 'Xllo']);
          expect(h.textarea.value).toBe('heXllo');
        }
        expect(h.sent.some((data) => data.includes('clipboard'))).toBe(false);
      }
    },
  ],
];

for (const mode of ['direct', 'local-echo']) {
  describe(`CodemanIosNativeInput prototype replays (${mode})`, () => {
    it.each(replayCases)('%s', (_name, run) => run(harness(mode)));
  });
}

describe('CodemanIosNativeInput integration contract', () => {
  it('requires a transaction sink and leaves unsupported xterm internals untouched', () => {
    const h = harness();
    h.owner.destroy();
    expect(h.api.create({ terminal: h.terminal })).toBeNull();
    expect(h.textarea.count()).toBe(0);
    delete h.helper._compositionView;
    expect(h.api.create({ terminal: h.terminal, sendTransaction() {} })).toBeNull();
    const screenReader = harness('direct', { screenReaderMode: true });
    expect(screenReader.owner).toBeNull();
  });

  it('stands down xterm text producers without canceling native input', () => {
    const h = harness();
    expect(h.core._inputEvent()).toBe(false);
    h.helper._handleAnyTextareaChanges();
    h.helper._finalizeComposition();
    expect(h.rawProducer).not.toHaveBeenCalled();
    h.tick();
    h.bytes([]);
    expect(h.silent('input').defaultPrevented).toBe(false);
  });

  it('notifies every settled edit, deletion-only/unchanged composition, and reset', () => {
    const h = harness();
    h.type('ab');
    expect(h.notifications.at(-1)).toEqual({ inserted: 'ab', deleted: 0, composition: false });
    h.begin();
    h.edit(null, undefined, 'deleteContentBackward', true);
    h.end();
    h.tick();
    expect(h.transactions.at(-1)).toEqual([DEL]);
    expect(h.notifications.at(-1)).toEqual({ inserted: '', deleted: 1, composition: true });
    h.begin();
    h.end();
    h.tick();
    expect(h.notifications.at(-1)).toEqual({ inserted: '', deleted: 0, composition: true });
    h.owner.reset('session');
    expect(h.notifications.at(-1)).toEqual({ inserted: '', deleted: 0, composition: false });
    expect(h.owner.state().composing).toBe(false);
  });

  it('settles a completed composition synchronously before Enter and cancels stale work on reset', () => {
    const h = harness();
    h.begin();
    h.edit('字', undefined, 'insertCompositionText', true);
    h.end();
    h.enter();
    h.bytes(['字', '\r']);
    expect(h.notifications).toContainEqual({ inserted: '字', deleted: 0, composition: true });
    h.begin();
    h.owner.reset('session');
    h.textarea.fire('compositionend');
    h.tick();
    h.bytes(['字', '\r']);
    expect(h.owner.state().synced).toBe('');
  });

  it('preserves the single transaction and baseline when hooks throw', () => {
    const h = harness('direct', {
      owner: {
        sendTransaction() {
          throw new Error('sink');
        },
        onTransaction() {
          throw new Error('preview');
        },
        onCaret() {
          throw new Error('marker');
        },
      },
    });
    expect(() => h.edit('hello')).not.toThrow();
    expect(h.owner.state().synced).toBe('hello');
    h.selection(2);
    expect(() => h.edit('X')).not.toThrow();
    expect(h.owner.state().synced).toBe('heXllo');
    expect(h.records.filter((entry) => entry.type === 'error').map((entry) => entry.hook)).toContain('sendTransaction');
    expect(h.records.filter((entry) => entry.type === 'error').map((entry) => entry.hook)).toContain('onTransaction');
  });

  it.each(['pre-wrap', 'nowrap'])('restores prior whitespace value and important priority (%s)', (value) => {
    const h = harness('direct', { whitespace: value, priority: 'important' });
    expect(h.textarea.style.getPropertyValue('white-space')).toBe('pre');
    h.owner.destroy();
    expect(h.textarea.properties.get('white-space')).toEqual({ value, priority: 'important' });
  });

  it('quarantines foreign input even if the copied text equals the owned baseline and has no beforeinput', () => {
    const h = harness();
    h.type('hello');
    h.clearSent();
    h.terminal.element.fire('contextmenu');
    h.textarea.fire('input', { data: 'hello' });
    h.bytes([]);
    expect(h.textarea.value).toBe('');
    h.type('x');
    h.bytes(['x']);
    expect(h.value()).toBe('hellox');
  });

  it('retires pending Copy restoration on reset and destroy', () => {
    const h = harness();
    h.type('hello');
    h.terminal.element.fire('contextmenu');
    h.textarea.value = 'clipboard';
    h.document.fire('copy');
    h.owner.reset('boundary');
    h.tick();
    expect(h.textarea.value).toBe('');
    h.type('x');
    h.terminal.element.fire('contextmenu');
    h.textarea.value = 'clipboard';
    h.document.fire('copy');
    h.owner.destroy();
    h.tick();
    expect(h.textarea.value).toBe('clipboard');
  });

  it('positions from an overlay anchor, hides explicitly or on anchor failure, and defaults only on null/undefined', () => {
    const h = harness();
    h.type('hello');
    h.selection(2);
    let anchor: { col: number; row: number } | 'hide' | null | undefined = { col: 8, row: 3 };
    let fail = false;
    let layout = () => {};
    const unsubscribe = vi.fn();
    const dispose = h.api.attachCaretMarker(h.terminal, h.owner, {
      anchor() {
        if (fail) throw new Error('layout');
        return anchor;
      },
      subscribe(callback: () => void) {
        layout = callback;
        return unsubscribe;
      },
    });
    const marker = h.screen.children[0];
    expect([marker.style.left, marker.style.top]).toEqual(['40px', '48px']);
    anchor = 'hide';
    layout();
    expect(marker.style.display).toBe('none');
    for (const fallback of [null, undefined]) {
      anchor = fallback;
      layout();
      expect(marker.style.display).toBe('block');
      expect(marker.style.left).toBe('16px');
    }
    fail = true;
    layout();
    expect(marker.style.display).toBe('none');
    dispose();
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(h.document.activeElement).toBe(h.textarea);
  });

  it('accounts for scrolling and hides when dimensions are absent or the owner is destroyed', () => {
    const h = harness();
    h.type('hello');
    h.selection(2);
    h.terminal.buffer.active.baseY = 3;
    h.terminal.buffer.active.viewportY = 2;
    const dispose = h.api.attachCaretMarker(h.terminal, h.owner);
    const marker = h.screen.children[0];
    expect(marker.style.top).toBe('48px');
    const dimensions = h.core._renderService.dimensions;
    h.core._renderService.dimensions = null;
    for (const callback of h.renders) callback();
    expect(marker.style.display).toBe('none');
    h.core._renderService.dimensions = dimensions;
    h.owner.destroy();
    expect(marker.style.display).toBe('none');
    dispose();
  });

  it('uses precisely the preview platform predicate and fails closed before that dependency loads', () => {
    const h = harness();
    expect(h.api.isSupported()).toBe(true);
    for (const navigator of [
      { userAgent: 'Android AppleWebKit', maxTouchPoints: 5 },
      { userAgent: 'iPhone AppleWebKit', maxTouchPoints: 0 },
      { userAgent: 'iPhone Gecko', maxTouchPoints: 5 },
    ]) {
      h.exposed.navigator = navigator;
      expect(h.api.isSupported()).toBe(false);
    }
    h.exposed.navigator = { userAgent: 'Macintosh AppleWebKit', platform: 'MacIntel', maxTouchPoints: 5 };
    expect(h.api.isSupported()).toBe(true);
    delete h.exposed.MobileImePreview;
    expect(h.api.isSupported()).toBe(false);
  });
});
