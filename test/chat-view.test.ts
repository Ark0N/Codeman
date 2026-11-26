/**
 * @fileoverview The chat view (chat-view.js): a session's conversation as its main view.
 *
 * What is pinned, and why:
 * - The pure helpers (`CodemanChatView` in constants.js): keep-warm turns are never drawn, a
 *   growing thread appends instead of redrawing, and long prompts fold.
 * - Which sessions can show it comes from `window.__codemanChatViewModes` (the transcript
 *   capability), and remote and adopted sessions never do.
 * - The chat view covers the terminal without removing it, and a session remembers its view.
 *   A focus that lands on the hidden terminal moves to the conversation.
 * - A dialog in the pane shows the "waiting in the terminal" notice.
 * - Codeman's own keep-alive turn shows no status line.
 * - The toggle chord is swallowed by the xterm key handler, so it never types into the session.
 *
 * The real constants.js and chat-view.js run inside a JSDOM window.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const read = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');

type Msg = { role: string; text: string; turn?: number; keepAlive?: boolean; queued?: boolean };

interface ChatHelpers {
  visibleMessages: (m: unknown) => Msg[];
  messageKey: (m: Msg) => string;
  renderPlan: (a: string[], b: string[]) => { mode: string; from?: number };
  promptFold: (t: string) => { folded: boolean; head: string; totalLines: number };
  promptText: (t: string) => string;
  elapsed: (ms: number) => string;
}

function loadHelpers(): ChatHelpers {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  return (context.window as { CodemanChatView: ChatHelpers }).CodemanChatView;
}

describe('CodemanChatView helpers', () => {
  const h = loadHelpers();

  it('leaves out keep-warm turns and messages without text', () => {
    const shown = h.visibleMessages([
      { role: 'user', text: 'Fix it', turn: 1 },
      { role: 'assistant', text: 'Done.', turn: 1 },
      { role: 'user', text: 'nudge', turn: 2, keepAlive: true },
      { role: 'assistant', text: 'ok', turn: 2, keepAlive: true },
      { role: 'assistant', text: '   ', turn: 3 },
      null,
    ]);
    expect(shown.map((m) => m.text)).toEqual(['Fix it', 'Done.']);
    expect(h.visibleMessages(undefined)).toEqual([]);
  });

  it('appends when the thread only grew, and redraws when it changed', () => {
    expect(h.renderPlan(['a', 'b'], ['a', 'b'])).toEqual({ mode: 'none' });
    expect(h.renderPlan(['a', 'b'], ['a', 'b', 'c'])).toEqual({ mode: 'append', from: 2 });
    expect(h.renderPlan([], ['a'])).toEqual({ mode: 'append', from: 0 });
    expect(h.renderPlan(['a', 'b'], ['a', 'x', 'c'])).toEqual({ mode: 'replace' });
    expect(h.renderPlan(['a', 'b'], ['a'])).toEqual({ mode: 'replace' });
  });

  it('keys a message by role, turn and text', () => {
    const a = h.messageKey({ role: 'user', text: 'hi', turn: 1 });
    expect(h.messageKey({ role: 'user', text: 'hi', turn: 1 })).toBe(a);
    expect(h.messageKey({ role: 'user', text: 'hi', turn: 2 })).not.toBe(a);
    expect(h.messageKey({ role: 'assistant', text: 'hi', turn: 1 })).not.toBe(a);
  });

  it('folds a prompt over 12 lines to its first 6, and one enormous line too', () => {
    const short = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    expect(h.promptFold(short).folded).toBe(false);
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const fold = h.promptFold(long);
    expect(fold.folded).toBe(true);
    expect(fold.totalLines).toBe(30);
    expect(fold.head.split('\n')).toHaveLength(6);
    const wide = h.promptFold('x'.repeat(5000));
    expect(wide.folded).toBe(true);
    expect(wide.head.length).toBeLessThanOrEqual(801);
  });

  it("unwraps Claude Code's pasted_content tag so a pasted prompt keeps its lines", () => {
    expect(h.promptText('<pasted_content id="a9da">\nline 1\nline 2\n</pasted_content>')).toBe('line 1\nline 2');
    expect(h.promptText('before <pasted_content>x</pasted_content> after')).toBe('before x after');
    // Claude Code 2.1.331 repeats the id on the closing tag.
    expect(h.promptText('<pasted_content id="a9da">\nA\nB\n</pasted_content id="a9da">')).toBe('A\nB');
    expect(h.promptText('a <pasted_content id="1"> left open')).toBe('a <pasted_content id="1"> left open');
    expect(h.promptText('plain')).toBe('plain');
  });

  it('formats the running time like the CLI', () => {
    expect(h.elapsed(0)).toBe('0s');
    expect(h.elapsed(14_900)).toBe('14s');
    expect(h.elapsed(125_000)).toBe('2m 05s');
    expect(h.elapsed(3_780_000)).toBe('1h 03m');
    expect(h.elapsed(-5)).toBe('0s');
  });
});

// ─── The module in a DOM ──────────────────────────────────────────────────────

type Api = ReturnType<typeof vi.fn>;

interface ChatApp {
  activeSessionId: string | null;
  sessions: Map<string, Record<string, unknown>>;
  pendingHooks: Map<string, Set<string>>;
  _api: Api;
  _apiJson: Api;
  showToast: Api;
  _sendInputAsync: Api;
  loadAppSettingsFromStorage: () => Record<string, unknown>;
  _chatViewReload: () => void;
  onChatViewTurnEvent: (id: string, idle: boolean, keepAlive?: boolean) => void;
  chatViewEligible: (id: string) => boolean;
  chatViewModeFor: (id: string) => string;
  setChatViewMode: (id: string, mode: string) => void;
  onChatViewActiveSession: (id: string) => void;
  onChatViewHooksChanged: (id: string) => void;
  _onChatViewTranscriptUpdate: (d: { sessionId: string }) => void;
  _chatViewFetch: () => Promise<void>;
  _chatViewForget: (id: string) => void;
  _chatViewPruneModes: (ids: Set<string>) => void;
  _chatViewHide: () => void;
  _chatViewRenderStatus: () => void;
  shouldToggleChatViewFromShortcut: (e: Partial<KeyboardEvent>) => boolean;
  _chatView: {
    root: HTMLElement;
    toggle: HTMLElement;
    thread: HTMLElement;
    dialog: HTMLElement;
    scroller: HTMLElement;
    status: HTMLElement;
    statusText: HTMLElement;
    statusTimer: unknown;
  };
}

function loadModule(opts: { messages?: Msg[][] } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body><input type="file" id="attachFileInput" accept="image/*,.pdf">
     <div class="terminal-wrap"><div id="terminalContainer"></div><textarea id="cjkInput"></textarea></div></body>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' }
  );
  const win = dom.window as unknown as Window & { eval: (s: string) => unknown; [k: string]: unknown };
  win.__codemanChatViewModes = ['claude'];
  // The window has a Date of its own. Tie it to the test's clock, so vi.setSystemTime reaches
  // the module's elapsed times.
  (win.Date as DateConstructor).now = () => Date.now();
  win.eval('class CodemanApp {}; window.CodemanApp = CodemanApp;');
  win.eval(read('constants.js'));
  win.eval(read('chat-view.js'));
  const proto = (win.CodemanApp as { prototype: object }).prototype;

  const pages = [...(opts.messages ?? [[]])];
  const app = Object.assign(Object.create(proto), {
    activeSessionId: 's1',
    sessions: new Map<string, Record<string, unknown>>([
      ['s1', { id: 's1', mode: 'claude', status: 'idle' }],
      ['s2', { id: 's2', mode: 'claude', status: 'idle', remote: { hostId: 'h' } }],
      ['s3', { id: 's3', mode: 'claude', status: 'idle', adopt: { target: 'x' } }],
      ['s4', { id: 's4', mode: 'codex', status: 'idle' }],
      ['s5', { id: 's5', mode: 'claude', status: 'idle', docker: { caseName: 'box' } }],
    ]),
    pendingHooks: new Map<string, Set<string>>(),
    loadAppSettingsFromStorage: () => ({}),
    _getResponseViewerAgentLabel: () => 'Claude',
    _buildResponseViewerMessage: (text: string, role: string, _label: string, meta?: { continuation?: boolean }) => {
      const div = win.document.createElement('div');
      div.className = `rv-message rv-msg-${role}`;
      if (meta?.continuation) div.classList.add('rv-msg-cont');
      const body = win.document.createElement('div');
      body.className = 'rv-text';
      body.textContent = text;
      div.appendChild(body);
      return div;
    },
    _bindResponseViewerInteractions: () => {},
    _api: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })),
    _apiJson: vi.fn(async () => ({ messages: pages.length > 1 ? pages.shift() : pages[0] })),
    showToast: vi.fn(),
    _sendInputAsync: vi.fn(),
    terminal: { focus: vi.fn() },
  }) as ChatApp;
  return { dom, win, app };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('chat view module', () => {
  it('is offered only for sessions whose run mode has a Claude transcript, local or Docker', () => {
    const { app } = loadModule();
    expect(app.chatViewEligible('s1')).toBe(true);
    expect(app.chatViewEligible('s5')).toBe(true); // Docker
    expect(app.chatViewEligible('s2')).toBe(false); // remote
    expect(app.chatViewEligible('s3')).toBe(false); // adopted
    expect(app.chatViewEligible('s4')).toBe(false); // not in __codemanChatViewModes
    expect(app.chatViewEligible('missing')).toBe(false);
  });

  it('is not offered on a phone, even one turned to landscape', () => {
    const { win, app } = loadModule();
    // A phone in landscape is wider than the phone breakpoint, so its width says "desktop".
    win.MobileDetection = { isHandheldDevice: () => true, getDeviceType: () => 'desktop' };
    expect(app.chatViewEligible('s1')).toBe(false);
    win.MobileDetection = { isHandheldDevice: () => false, getDeviceType: () => 'desktop' };
    expect(app.chatViewEligible('s1')).toBe(true);
  });

  it('opens in Chat when the device setting says so, unless the session remembers Terminal', () => {
    const { win, app } = loadModule();
    app.loadAppSettingsFromStorage = () => ({ chatViewDefault: true });
    expect(app.chatViewModeFor('s1')).toBe('chat');
    win.localStorage.setItem('codeman:chatViewModes', JSON.stringify({ s1: 'terminal' }));
    expect(app.chatViewModeFor('s1')).toBe('terminal');
  });

  it('marks the body while Chat shows, so the keyboard accessory bar stays hidden', () => {
    const { win, app } = loadModule();
    app.onChatViewActiveSession('s1');
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(false);
    app.setChatViewMode('s1', 'chat');
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(true);
    app.setChatViewMode('s1', 'terminal');
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(false);
  });

  it('moves a focus that lands in the hidden terminal to the conversation', () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const inner = win.document.createElement('textarea');
    win.document.getElementById('terminalContainer')!.appendChild(inner);
    inner.focus();
    expect(win.document.activeElement).toBe(app._chatView.scroller);
  });

  it('moves a focus that lands on the CJK input field to the conversation', () => {
    // With CJK input on, terminal.focus() lands on #cjkInput, outside #terminalContainer.
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    (win.document.getElementById('cjkInput') as HTMLTextAreaElement).focus();
    expect(win.document.activeElement).toBe(app._chatView.scroller);
  });

  it('keeps a dropped file from opening in the browser while Chat shows', () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    // The Chat / Terminal switch is a sibling of the chat view root, so it needs the guard too.
    for (const target of [app._chatView.root, app._chatView.toggle]) {
      for (const type of ['dragover', 'drop']) {
        const ev = new win.Event(type, { bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
      }
    }
  });

  it('hides the chat view, its switch and the body mark when the home screen shows', () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    expect(app._chatView.root.hidden).toBe(false);
    app._chatViewHide();
    expect(app._chatView.root.hidden).toBe(true);
    expect(app._chatView.toggle.hidden).toBe(true);
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(false);
  });

  it('starts in Terminal, covers the terminal once Chat is picked, and remembers the choice', async () => {
    const { win, app } = loadModule({ messages: [[{ role: 'user', text: 'Hi', turn: 1 }]] });
    app.onChatViewActiveSession('s1');
    expect(app.chatViewModeFor('s1')).toBe('terminal');
    expect(app._chatView.toggle.hidden).toBe(false);
    expect(app._chatView.root.hidden).toBe(true);

    app.setChatViewMode('s1', 'chat');
    await settle();
    expect(app._chatView.root.hidden).toBe(false);
    // The terminal stays in the DOM underneath: nothing is removed or resized.
    expect(win.document.getElementById('terminalContainer')).not.toBeNull();
    expect(win.document.querySelector('.terminal-wrap')!.classList.contains('chat-view-active')).toBe(true);
    expect(app._apiJson).toHaveBeenCalledWith('/api/sessions/s1/last-response?context=full');
    expect(JSON.parse(win.localStorage.getItem('codeman:chatViewModes')!)).toEqual({ s1: 'chat' });

    // The per-session turn state goes with the session too.
    const state = app as unknown as Record<string, Map<string, unknown> | Set<string>>;
    state._chatViewTurnStarts = new Map([['s1', 1]]);
    state._chatViewIdleSeen = new Set(['s1']);
    state._chatViewKeepAliveTurns = new Set(['s1']);

    // A detach sends the same event as a delete, so the view choice outlives it.
    app._chatViewForget('s1');
    expect(JSON.parse(win.localStorage.getItem('codeman:chatViewModes')!)).toEqual({ s1: 'chat' });
    for (const key of ['_chatViewTurnStarts', '_chatViewIdleSeen', '_chatViewKeepAliveTurns']) {
      expect(state[key].has('s1')).toBe(false);
    }
  });

  it("drops the view choices of sessions that are not in the init's session list", () => {
    const { app, win } = loadModule();
    win.localStorage.setItem('codeman:chatViewModes', JSON.stringify({ s1: 'chat', gone: 'terminal' }));
    app.setChatViewMode('s1', 'chat');
    app.setChatViewMode('gone', 'terminal');
    app._chatViewPruneModes(new Set(['s1', 's2']));
    expect(JSON.parse(win.localStorage.getItem('codeman:chatViewModes')!)).toEqual({ s1: 'chat' });
    win.localStorage.clear();
    expect(app.chatViewModeFor('gone')).toBe('terminal');
    expect(app.chatViewModeFor('s1')).toBe('chat');
  });

  it('prunes the view choices from handleInit in app.js', () => {
    const appJs = read('app.js');
    const start = appJs.indexOf('  handleInit(data) {');
    const init = appJs.slice(start, appJs.indexOf('\n  }\n', start));
    expect(init).toContain('this._chatViewPruneModes?.(new Set(data.sessions.map((s) => s.id)));');
  });

  it('shows the Chat / Terminal switch when the device has no showChatViewSwitch setting', () => {
    const { app } = loadModule();
    app.loadAppSettingsFromStorage = () => ({});
    app.onChatViewActiveSession('s1');
    expect(app._chatView.toggle.hidden).toBe(false);
    app.loadAppSettingsFromStorage = () => ({ showChatViewSwitch: true });
    app._chatViewSync();
    expect(app._chatView.toggle.hidden).toBe(false);
  });

  it('hides the switch when the setting is off, while Alt+Shift+C still switches views', async () => {
    const { win, app } = loadModule({ messages: [[{ role: 'user', text: 'Hi', turn: 1 }]] });
    app.loadAppSettingsFromStorage = () => ({ showChatViewSwitch: false });
    app.onChatViewActiveSession('s1');
    expect(app._chatView.toggle.hidden).toBe(true);

    app.toggleChatView();
    await settle();
    expect(app.chatViewModeFor('s1')).toBe('chat');
    expect(app._chatView.root.hidden).toBe(false);
    expect(app._chatView.toggle.hidden).toBe(true);
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(true);

    app.toggleChatView();
    expect(app.chatViewModeFor('s1')).toBe('terminal');
    expect(app._chatView.root.hidden).toBe(true);

    // A settings save re-syncs: turning the setting back on shows the switch again.
    app.loadAppSettingsFromStorage = () => ({ showChatViewSwitch: true });
    app._chatViewSync();
    expect(app._chatView.toggle.hidden).toBe(false);
  });

  it('hides the toggle for a session that cannot show the chat view', () => {
    const { app } = loadModule();
    app.onChatViewActiveSession('s1');
    app.activeSessionId = 's4';
    app.onChatViewActiveSession('s4');
    expect(app._chatView.toggle.hidden).toBe(true);
    expect(app._chatView.root.hidden).toBe(true);
  });

  it('draws the conversation without keep-warm turns, folds long prompts and appends new messages', async () => {
    const long = Array.from({ length: 20 }, (_, i) => `log ${i}`).join('\n');
    const first: Msg[] = [
      { role: 'user', text: long, turn: 1 },
      { role: 'assistant', text: 'Looked at it.', turn: 1 },
      { role: 'assistant', text: 'Checked the tests too.', turn: 1 },
      { role: 'user', text: 'keep-warm nudge', turn: 2, keepAlive: true },
      { role: 'assistant', text: 'keep-warm reply', turn: 2, keepAlive: true },
    ];
    const second: Msg[] = [...first, { role: 'user', text: 'Next', turn: 3 }];
    const { app } = loadModule({ messages: [first, second] });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();

    const nodes = Array.from(app._chatView.thread.children) as HTMLElement[];
    expect(nodes).toHaveLength(3);
    expect(nodes[0].querySelector('.chat-view-show-all')!.textContent).toBe('Show all (20 lines)');
    expect(nodes[0].textContent).not.toContain('log 10');
    expect(app._chatView.thread.textContent).not.toContain('keep-warm');
    // One badge per speaker per turn: Claude's second message in the turn continues the first.
    expect(nodes[1].classList.contains('rv-msg-cont')).toBe(false);
    expect(nodes[2].classList.contains('rv-msg-cont')).toBe(true);

    await app._chatViewFetch();
    const after = Array.from(app._chatView.thread.children);
    expect(after).toHaveLength(4);
    expect(after[0]).toBe(nodes[0]); // appended, not redrawn

    (nodes[0].querySelector('.chat-view-show-all') as HTMLButtonElement).click();
    expect(app._chatView.thread.children[0].textContent).toContain('log 19');
  });

  it('puts the Working line right under the last message, inside the scrolling list', () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const view = app._chatView as unknown as { status: HTMLElement; thread: HTMLElement; scroller: HTMLElement };
    expect(view.status.parentElement).toBe(view.scroller);
    expect(view.thread.nextElementSibling).toBe(view.status);
  });

  it('counts a turn already running when the page loaded from the last Enter, not from the page load', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    const { app } = loadModule();
    app.sessions.set('s1', {
      id: 's1',
      mode: 'claude',
      status: 'busy',
      workingDir: '/work',
      lastSubmitAt: Date.now() - 73_000,
    });
    app.setChatViewMode('s1', 'chat');
    const a = app as unknown as {
      onChatViewTurnEvent: (id: string, idle: boolean) => void;
      _chatView: { statusText: HTMLElement };
    };
    // A working event for a session this page never saw idle says nothing about the turn's start.
    a.onChatViewTurnEvent('s1', false);
    app.onChatViewActiveSession('s1');
    expect(a._chatView.statusText.textContent).toBe('Working · 1m 13s');
    // Stop the status line's ticking before the real clock comes back.
    app.setChatViewMode('s1', 'terminal');
    vi.useRealTimers();
  });

  it('counts a turn this page saw start from its session:working event', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    try {
      const { app } = loadModule();
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      app.onChatViewTurnEvent('s1', true);
      vi.setSystemTime(Date.now() + 30_000);
      const session = app.sessions.get('s1')!;
      session.status = 'busy';
      // An older Enter, which must not be the start of the turn the page saw begin.
      session.lastSubmitAt = Date.now() - 60_000;
      app.onChatViewTurnEvent('s1', false);
      vi.setSystemTime(Date.now() + 5_000);
      app._chatViewRenderStatus();
      expect(app._chatView.statusText.textContent).toBe('Working · 5s');
      app.setChatViewMode('s1', 'terminal');
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows no status line during Codeman's keep-alive turn", () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const session = app.sessions.get('s1')!;
    session.status = 'busy';
    app.onChatViewTurnEvent('s1', false, true);
    expect(app._chatView.status.hidden).toBe(true);

    session.status = 'idle';
    app.onChatViewTurnEvent('s1', true, true);
    // A real turn shows it again.
    session.status = 'busy';
    app.onChatViewTurnEvent('s1', false);
    expect(app._chatView.status.hidden).toBe(false);
    session.status = 'idle';
    app.onChatViewTurnEvent('s1', true);
  });

  /** A Chat session that is busy, on a device that is touch or not, with app.js's focus rule. */
  function loadForFocus(touch: boolean) {
    const loaded = loadModule();
    const { win, app } = loaded;
    // The rule the app applies to a tab switch (app.js), run as written.
    const appJs = read('app.js');
    const method = appJs.match(/\n {2}_shouldFocusTerminalForTabSwitch\(\) \{[\s\S]*?\n {2}\}\n/)![0];
    Object.assign(app, win.eval(`({${method}})`) as object);
    win.MobileDetection = {
      isHandheldDevice: () => false,
      getDeviceType: () => (touch ? 'tablet' : 'desktop'),
      isTouchDevice: () => touch,
    };
    win.KeyboardHandler = { keyboardVisible: false };
    app.sessions.get('s1')!.status = 'busy';
    app.setChatViewMode('s1', 'terminal');
    return loaded;
  }
  const nextFrame = (win: Window) => new Promise<void>((r) => win.requestAnimationFrame(() => r()));

  it('follows the tab-switch focus rule on a touch device: no focus on a switch to Chat', async () => {
    const { win, app } = loadForFocus(true);
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await nextFrame(win);
    expect(win.document.activeElement).not.toBe(app._chatView.scroller);
  });

  it('moves a focus left in the terminal to the conversation on a switch to Chat, on a touch device', async () => {
    const { win, app } = loadForFocus(true);
    const inner = win.document.createElement('textarea');
    win.document.getElementById('terminalContainer')!.appendChild(inner);
    inner.focus();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await nextFrame(win);
    expect(win.document.activeElement).toBe(app._chatView.scroller);
  });

  it('moves a focus left on the CJK input field to the conversation on a switch to Chat, on a touch device', async () => {
    const { win, app } = loadForFocus(true);
    (win.document.getElementById('cjkInput') as HTMLTextAreaElement).focus();
    expect(win.document.activeElement?.id).toBe('cjkInput');
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await nextFrame(win);
    expect(win.document.activeElement).toBe(app._chatView.scroller);
  });

  it('focuses the conversation on a desktop, on a switch to Chat', async () => {
    const { win, app } = loadForFocus(false);
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await nextFrame(win);
    expect(win.document.activeElement).toBe(app._chatView.scroller);
  });

  it('unfolds a long prompt in place, with the badge it was drawn with', () => {
    const { win, app } = loadModule();
    const a = app as unknown as {
      _buildResponseViewerMessage: (t: string, r: string, l: string, m?: { continuation?: boolean }) => HTMLElement;
      _chatViewBuildMessage: (m: Msg, label: string, continuation: boolean) => HTMLElement;
    };
    // As the real builder does: a prompt that is not a continuation carries its "You" badge.
    const build = a._buildResponseViewerMessage;
    a._buildResponseViewerMessage = (text, role, label, meta) => {
      const el = build(text, role, label, meta);
      if (!meta?.continuation) {
        const badge = win.document.createElement('div');
        badge.className = 'rv-role rv-role-user';
        el.prepend(badge);
      }
      return el;
    };
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const el = a._chatViewBuildMessage({ role: 'user', text: long, turn: 1 }, 'Claude', true);
    expect(el.classList.contains('rv-msg-cont')).toBe(true);
    (el.querySelector('.chat-view-show-all') as HTMLButtonElement).click();
    expect(el.querySelector(':scope > .rv-role')).toBeNull();
    expect(el.classList.contains('rv-msg-cont')).toBe(true);
    expect(el.querySelector('.chat-view-show-all')).toBeNull();
    expect(el.textContent).toContain('line 29');
  });

  it('shows the waiting notice while a permission prompt or question is pending', () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    expect(app._chatView.dialog.hidden).toBe(true);
    app.pendingHooks.set('s1', new Set(['elicitation_dialog']));
    app.onChatViewHooksChanged('s1');
    expect(app._chatView.dialog.hidden).toBe(false);
    app.pendingHooks.set('s1', new Set(['idle_prompt']));
    app.onChatViewHooksChanged('s1');
    expect(app._chatView.dialog.hidden).toBe(true);
    // Claude's AskUserQuestion, plan approval and permission dialogs arrive as permission_prompt.
    app.pendingHooks.set('s1', new Set(['permission_prompt']));
    app.onChatViewHooksChanged('s1');
    expect(app._chatView.dialog.hidden).toBe(false);
  });

  it('re-reads on transcript:update only for its own session and only while showing', () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const reload = vi.spyOn(app, '_chatViewReload').mockImplementation(() => {});
    app._onChatViewTranscriptUpdate({ sessionId: 's1' });
    expect(reload).toHaveBeenCalledTimes(1);
    app._onChatViewTranscriptUpdate({ sessionId: 's2' });
    expect(reload).toHaveBeenCalledTimes(1);
    app.setChatViewMode('s1', 'terminal');
    app._onChatViewTranscriptUpdate({ sessionId: 's1' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reads nothing once hidden, even for a re-read armed while Chat showed', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      await vi.advanceTimersByTimeAsync(0);
      const reads = app._apiJson.mock.calls.length;
      app._onChatViewTranscriptUpdate({ sessionId: 's1' });
      app.setChatViewMode('s1', 'terminal');
      await vi.advanceTimersByTimeAsync(300);
      expect(app._apiJson.mock.calls.length).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A read of the conversation that stays pending until the test resolves it. */
  function deferredRead() {
    let resolve!: (v: { messages: Msg[] }) => void;
    const promise = new Promise<{ messages: Msg[] }>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('reads once more when an update arrived while a read was in flight', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      const first = deferredRead();
      app._apiJson.mockImplementationOnce(() => first.promise);
      app.setChatViewMode('s1', 'chat');
      expect(app._apiJson).toHaveBeenCalledTimes(1);

      // The update's debounced read finds the first one still in flight.
      app._onChatViewTranscriptUpdate({ sessionId: 's1' });
      await vi.advanceTimersByTimeAsync(300);
      expect(app._apiJson).toHaveBeenCalledTimes(1);

      first.resolve({ messages: [{ role: 'user', text: 'Hi', turn: 1 }] });
      await vi.advanceTimersByTimeAsync(300);
      expect(app._apiJson).toHaveBeenCalledTimes(2);
      app.setChatViewMode('s1', 'terminal');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a read that finishes after the user switched to another session', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      const s1Read = deferredRead();
      app._apiJson.mockImplementationOnce(() => s1Read.promise);
      app.setChatViewMode('s1', 'chat');
      app.setChatViewMode('s5', 'chat');
      app.activeSessionId = 's5';
      app.onChatViewActiveSession('s5');

      s1Read.resolve({ messages: [{ role: 'assistant', text: 'Answer for s1 only', turn: 1 }] });
      // Checked before the debounced read for s5 runs, which would redraw the thread anyway.
      await vi.advanceTimersByTimeAsync(0);
      expect(app._chatView.thread.textContent).not.toContain('Answer for s1 only');
      await vi.advanceTimersByTimeAsync(300);
      expect(app._chatView.thread.textContent).not.toContain('Answer for s1 only');
      app.setChatViewMode('s5', 'terminal');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('the Alt+Shift+C chord', () => {
    const chord = { altKey: true, shiftKey: true, key: 'C', code: 'KeyC' };

    /** The module with app.js's shortcut matcher, run as written, and a registry holding the chord. */
    function loadForChord(disabled = false) {
      const loaded = loadModule();
      const { win, app } = loaded;
      const method = read('app.js').match(/\n {2}matchesShortcutEvent\(e, shortcut\) \{[\s\S]*?\n {2}\}\n/)![0];
      Object.assign(app, win.eval(`({${method}})`) as object, {
        getShortcutRegistry: () => [
          { id: 'toggle-chat-view', bindings: [{ modifiers: ['alt', 'shift'], key: 'C', code: 'KeyC' }], disabled },
        ],
      });
      return loaded;
    }

    it('applies to an active session that can show the chat view', () => {
      const { app } = loadForChord();
      expect(app.shouldToggleChatViewFromShortcut(chord)).toBe(true);
    });

    it('reaches the terminal in a session that cannot show the chat view', () => {
      const { app } = loadForChord();
      app.sessions.set('s6', { id: 's6', mode: 'shell', status: 'idle' });
      app.activeSessionId = 's6';
      expect(app.shouldToggleChatViewFromShortcut(chord)).toBe(false);
    });

    it('reaches the tiles while the tile grid owns the terminal', () => {
      const { app } = loadForChord();
      (app as unknown as { _tilesOwnTerminal: () => boolean })._tilesOwnTerminal = () => true;
      expect(app.shouldToggleChatViewFromShortcut(chord)).toBe(false);
    });

    it('needs a modifier', () => {
      const { app } = loadForChord();
      expect(app.shouldToggleChatViewFromShortcut({ key: 'C', code: 'KeyC' })).toBe(false);
    });

    it('does nothing when the user disabled the shortcut', () => {
      const { app } = loadForChord(true);
      expect(app.shouldToggleChatViewFromShortcut(chord)).toBe(false);
    });
  });

  it('stays hidden while the tile grid owns the terminal, so the keyboard bar shows for the tiles', () => {
    const { win, app } = loadModule();
    const a = app as unknown as {
      _tileGrid?: { open: boolean };
      _tilesOwnTerminal: () => boolean;
      _chatViewSync: () => void;
    };
    a._tilesOwnTerminal = () => !!a._tileGrid?.open;
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(true);

    a._tileGrid = { open: true };
    a._chatViewSync();
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(false);
    expect(app._chatView.root.hidden).toBe(true);

    a._tileGrid = { open: false };
    a._chatViewSync();
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(true);
    expect(app._chatView.root.hidden).toBe(false);
  });
});

describe('chat view wiring', () => {
  it("swallows the toggle chord in the xterm key handler and in Pane B's", () => {
    const terminalUi = read('terminal-ui.js');
    expect(terminalUi).toMatch(/shouldToggleChatViewFromShortcut\?\.\(ev\)\)\s*\{\s*return false;/);
    const tile = read('terminal-tile.js');
    expect(tile).toContain(
      "if (ev.type === 'keydown' && global.app?.shouldToggleChatViewFromShortcut?.(ev)) return false;"
    );
  });

  it('re-reads the conversation after an SSE reconnect onto the session on screen', () => {
    const app = read('app.js');
    expect(app).toMatch(
      /void this\._onSessionNeedsRefresh\(\{ id: restoreId \}\);[\s\S]{0,300}?this\._chatViewReload\?\.\(\{ immediate: true \}\);/
    );
  });

  it('hides the chat view when the home screen shows', () => {
    const terminalUi = read('terminal-ui.js');
    expect(terminalUi).toMatch(/\n {2}showWelcome\(\) \{\n {4}this\._chatViewHide\?\.\(\);/);
  });

  it('keeps the chat view layers under the narrow-width sidebar drawer', () => {
    // The drawer (z-index 12, mobile.css) is a sibling of .terminal-wrap: the chat view's 20 and 21
    // must stay inside the terminal area's own stacking context.
    const css = read('styles.css');
    expect(css).toMatch(/\n\.terminal-wrap \{[^}]*isolation: isolate;[^}]*\}/);
  });

  it('binds Alt+Shift+C to the toggle in the shortcut registry', () => {
    const app = read('app.js');
    expect(app).toMatch(
      /id: 'toggle-chat-view',[\s\S]*?modifiers: \['alt', 'shift'\], key: 'C', code: 'KeyC'[\s\S]*?action: 'toggleChatView'/
    );
    expect(app).toContain('toggleChatView: () => this.toggleChatView?.()');
  });

  it('keeps chatViewDefault per device and out of the server PUT', () => {
    const settings = read('settings-ui.js');
    expect(settings).toMatch(/'showEditHistory', 'chatViewDefault',/);
    expect(settings).toContain('chatViewDefault: _cvd,');
    const schemas = readFileSync(resolve(import.meta.dirname, '../src/web/schemas.ts'), 'utf8');
    expect(schemas).not.toContain('chatViewDefault');
  });

  it('keeps showChatViewSwitch per device, out of the server PUT, and on when absent', () => {
    const settings = read('settings-ui.js');
    expect(settings).toMatch(/'showEditHistory', 'chatViewDefault', 'showChatViewSwitch',/);
    expect(settings).toContain('showChatViewSwitch: _scvs,');
    expect(settings).toContain(
      "document.getElementById('appSettingsShowChatViewSwitch').checked = settings.showChatViewSwitch !== false;"
    );
    const schemas = readFileSync(resolve(import.meta.dirname, '../src/web/schemas.ts'), 'utf8');
    expect(schemas).not.toContain('showChatViewSwitch');
    // A settings save re-syncs the chat view, so the switch follows the new value at once.
    expect(settings).toMatch(/this\._chatViewSync\?\.\(\);/);
    const html = read('index.html');
    expect(html).toContain('id="appSettingsShowChatViewSwitch"');
  });

  it('passes the keep-alive flag of session:working and session:idle to the chat view', () => {
    const app = read('app.js');
    expect(app).toContain('this.onChatViewTurnEvent?.(data.id, true, data.keepAlive);');
    expect(app).toContain('this.onChatViewTurnEvent?.(data.id, false, data.keepAlive);');
  });

  it('hides the CJK input field on a touch device while Chat shows', () => {
    // The field is fixed over the bottom of the chat view there, and its text goes into the pane.
    const css = read('styles.css');
    expect(css).toMatch(
      /\nbody\.chat-view-showing\.touch-device #cjkInput\.cjk-input-visible \{\s*display: none !important;\s*\}/
    );
  });

  it("starts the chat layer and its switch below Pane A's split header", () => {
    const css = read('styles.css');
    expect(css).toMatch(/\.terminal-pane-a-header ~ \.chat-view \{\s*top: 28px;\s*\}/);
    expect(css).toMatch(/\.terminal-pane-a-header ~ \.chat-view-toggle \{\s*top: 36px;\s*\}/);
  });

  it('centres the empty notice over the Response Viewer paragraph margin', () => {
    // The notice is a <p> directly inside .response-viewer-body, whose `> p` margin rule
    // outranks `.chat-view-empty` alone and left it against the window's left edge.
    const css = read('styles.css');
    expect(css).toMatch(/\.chat-view-scroll > \.chat-view-empty \{\s*margin-left: auto;\s*margin-right: auto;\s*\}/);
  });

  it('loads chat-view.js after local-model-ui.js', () => {
    const html = read('index.html');
    expect(html.indexOf('src="chat-view.js"')).toBeGreaterThan(html.indexOf('src="local-model-ui.js"'));
  });
});
