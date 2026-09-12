/**
 * @fileoverview The brief ("Last Response") view renders the last ANSWERED turn.
 *
 * `data.text` is one row — the last assistant row — and a Claude turn is a
 * median of 3 rows, so the eye button used to show the tail of an answer
 * ("Done.") while the More view showed the whole thing. The brief view now asks
 * for `context=turn` and renders those rows the way the full view does: one
 * badge, then continuation segments. Pinned here:
 *
 *  1. `selectLastAnsweredTurn` picks the highest turn that HAS an assistant
 *     message, so a prompt queued after the answer (a new, unanswered turn)
 *     does not blank the view; and it yields nothing without numeric turns.
 *  2. The brief view falls back to `text` when the server sends no messages
 *     (Codex, the pane parser, an older server), so those keep their one card.
 *  3. The continuation gate is the numeric `turn`, as in loadFullContext.
 *
 * app.js is loaded via `vm` with a jsdom document, as in
 * response-viewer-turn-segments.test.ts.
 * Port: N/A
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectLastAnsweredTurn } from '../src/web/response-viewer-transcript.js';

describe('selectLastAnsweredTurn', () => {
  const user = (text: string, turn: number) => ({ role: 'user', text, turn });
  const assistant = (text: string, turn: number) => ({ role: 'assistant', text, turn });

  it('returns every assistant message of the highest answered turn', () => {
    const messages = [
      user('a', 1),
      assistant('a1', 1),
      user('b', 2),
      assistant('b1', 2),
      assistant('b2', 2),
      user('c', 3),
    ];
    expect(selectLastAnsweredTurn(messages).map((m) => m.text)).toEqual(['b1', 'b2']);
  });

  it('yields nothing for messages without numeric turns, so callers fall back to text', () => {
    const messages = [
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'a1' },
      { role: 'assistant', text: 'a2' },
    ];
    expect(selectLastAnsweredTurn(messages)).toEqual([]);
    expect(selectLastAnsweredTurn([])).toEqual([]);
  });

  it('keeps turn-0 output emitted before the first prompt', () => {
    expect(selectLastAnsweredTurn([assistant('hello', 0)]).map((m) => m.text)).toEqual(['hello']);
  });
});

describe('response viewer brief view (last answered turn)', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const { document, NodeFilter } = dom.window;

  function loadCodemanAppClass() {
    const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const context = vm.createContext({
      console,
      performance,
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      setTimeout,
      clearTimeout,
      requestAnimationFrame: vi.fn(),
      HTMLCanvasElement: class HTMLCanvasElement {},
      fetch: vi.fn(),
      document,
      NodeFilter,
      localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      MobileDetection: {},
    });
    vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
    return { CodemanApp: (context as { __CodemanApp: { prototype: object } }).__CodemanApp, context };
  }

  const { CodemanApp, context: appContext } = loadCodemanAppClass();

  interface ViewerApp {
    toggleResponseViewer(): Promise<void>;
    activeSessionId?: string;
    sessions?: Map<string, { mode: string }>;
  }

  function mountViewer() {
    const viewer = document.createElement('div');
    viewer.id = 'responseViewer';
    const backdrop = document.createElement('div');
    backdrop.id = 'responseViewerBackdrop';
    const body = document.createElement('div');
    body.id = 'responseViewerBody';
    const title = document.createElement('div');
    title.id = 'responseViewerTitle';
    const more = document.createElement('button');
    more.id = 'responseViewerMore';
    document.body.append(viewer, backdrop, body, title, more);
    return { viewer, body, title, more };
  }

  function makeApp(payload: unknown): { app: ViewerApp; fetchMock: ReturnType<typeof vi.fn> } {
    const app = Object.create(CodemanApp.prototype) as ViewerApp;
    app.activeSessionId = 's1';
    app.sessions = new Map([['s1', { mode: 'claude' }]]);
    const fetchMock = vi.fn(async () => ({ json: async () => ({ data: payload }) }));
    (appContext as { fetch: unknown }).fetch = fetchMock;
    return { app, fetchMock };
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('asks for context=turn and renders the whole turn as one badged card with segments', async () => {
    const { body, viewer } = mountViewer();
    const { app, fetchMock } = makeApp({
      text: 'Done.',
      timestamp: 't',
      messages: [
        { role: 'assistant', text: 'Looking at the file.', turn: 2 },
        { role: 'assistant', text: 'The bug is on line 3.', turn: 2 },
        { role: 'assistant', text: 'Done.', turn: 2 },
      ],
    });

    await app.toggleResponseViewer();

    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/sessions/s1/last-response?context=turn');
    const cards = body.querySelectorAll('.rv-message');
    expect(cards).toHaveLength(3);
    expect(body.querySelectorAll('.rv-role')).toHaveLength(1);
    expect(cards[0].classList.contains('rv-msg-cont')).toBe(false);
    expect(cards[1].classList.contains('rv-msg-cont')).toBe(true);
    expect(cards[2].classList.contains('rv-msg-cont')).toBe(true);
    expect(body.textContent).toContain('The bug is on line 3.');
    expect(viewer.classList.contains('visible')).toBe(true);
  });

  it('opens a multi-row turn at its NEWEST text, and a single card at the top', async () => {
    // `body.scrollTop = 0` was right when the brief view was one card holding
    // the last row. With the whole turn rendered, the top of the scroller is
    // the turn's FIRST narration line and the answer the eye button exists to
    // show can be several screens below it; loadFullContext already scrolls to
    // the bottom for the same turn, so the two views disagreed.
    // jsdom does no layout, so scrollHeight is stubbed and the write recorded.
    const spyScroll = (body: HTMLElement) => {
      const writes: number[] = [];
      Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 4200 });
      Object.defineProperty(body, 'scrollTop', {
        configurable: true,
        get: () => writes[writes.length - 1] ?? 0,
        set: (v: number) => void writes.push(v),
      });
      return writes;
    };

    const many = mountViewer();
    const manyWrites = spyScroll(many.body);
    await makeApp({
      text: 'Done.',
      timestamp: 't',
      messages: [
        { role: 'assistant', text: 'Looking at the file.', turn: 2 },
        { role: 'assistant', text: 'Done.', turn: 2 },
      ],
    }).app.toggleResponseViewer();
    expect(manyWrites.at(-1)).toBe(4200);

    document.body.innerHTML = '';
    const one = mountViewer();
    const oneWrites = spyScroll(one.body);
    await makeApp({
      text: 'Done.',
      timestamp: 't',
      messages: [{ role: 'assistant', text: 'Done.', turn: 2 }],
    }).app.toggleResponseViewer();
    expect(oneWrites.at(-1)).toBe(0);
  });

  it('falls back to text when the server sends no messages, keeping one badged card', async () => {
    const { body } = mountViewer();
    const { app } = makeApp({ text: 'Only the last row.', timestamp: 't' });

    await app.toggleResponseViewer();

    expect(body.querySelectorAll('.rv-message')).toHaveLength(1);
    expect(body.querySelectorAll('.rv-role')).toHaveLength(1);
    expect(body.textContent).toContain('Only the last row.');
  });

  it('ignores user rows and blank rows in a turn payload', async () => {
    const { body } = mountViewer();
    const { app } = makeApp({
      text: 'answer',
      timestamp: 't',
      messages: [
        { role: 'user', text: 'prompt', turn: 1 },
        { role: 'assistant', text: '   ', turn: 1 },
        { role: 'assistant', text: 'answer', turn: 1 },
      ],
    });

    await app.toggleResponseViewer();

    expect(body.querySelectorAll('.rv-message')).toHaveLength(1);
    expect(body.textContent).not.toContain('prompt');
    expect(body.textContent).toContain('answer');
  });
});
