/**
 * @fileoverview Each session in the split view names its harness and model.
 *
 * - Pane B's header is the tile header's strip: the harness logo (PR #532's
 *   `run-mode-dot <cliId>` slot), the name and the model, and the close button
 *   at a tile button's size.
 * - Pane A is the main terminal, which has no header of its own: while the
 *   split is open it gets the same strip (minus the close), as the FIRST child
 *   of `.terminal-wrap`, and loses it when the split closes. That strip takes
 *   height from the main terminal, so opening fits it through sendResize (its
 *   first step is syncTerminalGeometry, #464) with the strip already in place,
 *   and closing gives the height back the same way, never with a bare
 *   `fitAddon.fit()`.
 * - Every tab render refreshes both headers (a rename, a model switch, the
 *   active session changing under Pane A); an unchanged session writes nothing.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  bySelector,
  main,
  makeGridApp,
  resetGridHarness,
  windowStub,
  wrap,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];

beforeEach(() => {
  resetGridHarness();
  windowStub.__codemanCliCatalog = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'deepseek', label: 'DeepSeek' },
  ];
});

/** s-a (dsh on its route) in the main pane, s-b (claude) in Pane B. */
function openSplit(): GridApp {
  const app = makeGridApp(IDS);
  Object.assign(app.sessions.get('s-a'), {
    name: 'review-api',
    mode: 'deepseek',
    displayModel: { model: 'qwen3.8-27b', source: 'screen' },
  });
  Object.assign(app.sessions.get('s-b'), {
    name: 'docs-pass',
    displayModel: { model: 'Haiku 4.5', source: 'statusline' },
  });
  app.syncTerminalGeometry = vi.fn();
  app.fitAddon = { fit: vi.fn() };
  app.openSplitPane('s-b');
  // closeSplitPane finds its container by selector.
  const container = main.querySelector('.terminal-split-container');
  if (container) bySelector.set('.terminal-split-container', container);
  return app;
}

const headerB = () => main.querySelector('.terminal-pane-b')!.querySelector('.terminal-pane-b-header') as FakeEl;
const headerA = () => wrap.querySelector('.terminal-pane-a-header');
const part = (header: FakeEl, cls: string) => header.querySelector(`.${cls}`) as FakeEl;
const modelName = (header: FakeEl) => part(header, 'split-model').children[0];
/** A tab render, through the real wrapper chain (the original returns early mid-rename). */
function renderTabs(app: GridApp) {
  app._inlineRenameActive = true;
  app._renderSessionTabsImmediate();
}

describe('the split headers', () => {
  it("Pane B's header: logo, name, model, and the close button at a tile button's size", () => {
    openSplit();
    const b = headerB();
    expect(b.children.map((c) => c.className.split(' ')[0])).toEqual(['split-harness', 'split-title', 'tile-btn']);
    expect(part(b, 'split-harness').className).toBe('split-harness run-mode-dot claude');
    expect(part(b, 'session-name').textContent).toBe('docs-pass');
    expect(modelName(b).textContent).toBe('Haiku 4.5');
    expect(part(b, 'split-harness').title).toBe('Claude Code · Haiku 4.5');
    expect(part(b, 'split-harness').getAttribute('aria-label')).toBe('Claude Code · Haiku 4.5');
    const close = part(b, 'terminal-pane-b-close');
    expect(close.className).toBe('tile-btn tile-remove terminal-pane-b-close');
    expect(close.getAttribute('aria-label')).toBe('Close split');
    expect(close.textContent).toBe('×');
  });

  it("Pane A gets the same strip, first in the main terminal's wrap, without a close", () => {
    openSplit();
    const a = headerA()!;
    expect(wrap.children[0]).toBe(a);
    expect(a.className).toBe('terminal-pane-b-header terminal-pane-a-header');
    expect(part(a, 'split-harness').className).toBe('split-harness run-mode-dot deepseek');
    expect(part(a, 'session-name').textContent).toBe('review-api');
    expect(modelName(a).textContent).toBe('qwen3.8-27b');
    expect(part(a, 'split-harness').title).toBe('DeepSeek · qwen3.8-27b');
    expect(part(a, 'terminal-pane-b-close')).toBeNull();
  });

  it('names and models are text, and the model is never translated', () => {
    const app = makeGridApp(IDS);
    app.sessions.get('s-b').name = '<img src=x onerror=alert(1)>';
    app.sessions.get('s-b').displayModel = { model: '<b>m</b>', source: 'statusline' };
    app.syncTerminalGeometry = vi.fn();
    app.openSplitPane('s-b');
    expect(part(headerB(), 'session-name').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(part(headerB(), 'session-name').children).toHaveLength(0);
    expect(modelName(headerB()).textContent).toBe('<b>m</b>');
    expect(modelName(headerB()).getAttribute('data-i18n-skip')).toBe('');
  });

  it('an unknown model shows the logo alone', () => {
    const app = openSplit();
    delete app.sessions.get('s-b').displayModel;
    renderTabs(app);
    expect(part(headerB(), 'split-model').hidden).toBe(true);
    expect(modelName(headerB()).textContent).toBe('');
    expect(part(headerB(), 'split-harness').title).toBe('Claude Code');
  });

  it('a tab render carries a rename and a model switch into both headers', () => {
    const app = openSplit();
    app.sessions.set('s-b', {
      ...app.sessions.get('s-b'),
      name: 'docs-pass-2',
      displayModel: { model: 'Sonnet 4.6', source: 'statusline' },
    });
    app.sessions.get('s-a').displayModel = { model: 'deepseek-v4-flash', source: 'screen' };
    renderTabs(app);
    expect(part(headerB(), 'session-name').textContent).toBe('docs-pass-2');
    expect(modelName(headerB()).textContent).toBe('Sonnet 4.6');
    expect(modelName(headerA()!).textContent).toBe('deepseek-v4-flash');
  });

  it("Pane A's header follows the active session", () => {
    const app = openSplit();
    app.activeSessionId = 's-c';
    renderTabs(app);
    expect(part(headerA()!, 'session-name').textContent).toBe('s-c');
    expect(part(headerA()!, 'split-harness').className).toBe('split-harness run-mode-dot claude');
    expect(part(headerA()!, 'split-model').hidden).toBe(true);
  });

  it('an unchanged session writes nothing on a refresh', () => {
    const app = openSplit();
    const writes: string[] = [];
    for (const [which, header] of [
      ['a', headerA()!],
      ['b', headerB()],
    ] as Array<[string, FakeEl]>) {
      for (const [node, props] of [
        [part(header, 'split-harness'), ['className', 'title']],
        [part(header, 'session-name'), ['textContent']],
        [part(header, 'split-model'), ['title', 'hidden']],
        [modelName(header), ['textContent']],
      ] as Array<[FakeEl, string[]]>) {
        for (const prop of props) {
          let value = (node as unknown as Record<string, unknown>)[prop];
          Object.defineProperty(node, prop, {
            get: () => value,
            set: (v) => {
              writes.push(`${which} ${prop}`);
              value = v;
            },
          });
        }
        const setAttribute = node.setAttribute.bind(node);
        node.setAttribute = (k: string, v: string) => {
          writes.push(`${which} @${k}`);
          setAttribute(k, v);
        };
      }
    }
    renderTabs(app);
    renderTabs(app);
    expect(writes).toEqual([]);
  });
});

describe("the main terminal's height", () => {
  it('opening fits Pane A with its header strip already in place, through sendResize', () => {
    const app = makeGridApp(IDS);
    app.fitAddon = { fit: vi.fn() };
    let stripInPlace = false;
    app.sendResize = vi.fn(() => {
      stripInPlace = wrap.children[0]?.classList.contains('terminal-pane-a-header') ?? false;
      return Promise.resolve(true);
    });
    app.openSplitPane('s-b');
    expect(app.sendResize).toHaveBeenCalledWith('s-a', { force: true });
    expect(stripInPlace).toBe(true);
    expect(app.fitAddon.fit).not.toHaveBeenCalled();
  });

  it('closing takes the strip away and gives the height back through sendResize, never a bare fit', () => {
    const app = openSplit();
    app.sendResize.mockClear();
    let stripGone = false;
    app.sendResize = vi.fn(() => {
      stripGone = headerA() === null;
      return Promise.resolve(true);
    });
    app.closeSplitPane();
    expect(headerA()).toBeNull();
    expect(app.sendResize).toHaveBeenCalledWith('s-a', { force: true });
    expect(stripGone).toBe(true);
    expect(app.fitAddon.fit).not.toHaveBeenCalled();
    expect(app._splitHeaders).toBeNull();
  });

  it('a close that skips the resize (Pane A ended) still refits through syncTerminalGeometry', () => {
    const app = openSplit();
    app.sendResize.mockClear();
    app.closeSplitPane({ skipPrimaryResize: true });
    expect(headerA()).toBeNull();
    expect(app.sendResize).not.toHaveBeenCalled();
    expect(app.syncTerminalGeometry).toHaveBeenCalledTimes(1);
    expect(app.fitAddon.fit).not.toHaveBeenCalled();
  });

  it("Pane B's close button closes the split", () => {
    const app = openSplit();
    const tile = FakeTile.all.at(-1) as FakeTile;
    part(headerB(), 'terminal-pane-b-close').dispatch('click');
    expect(app._splitPane).toBeNull();
    expect(tile.destroy).toHaveBeenCalledTimes(1);
    expect(headerA()).toBeNull();
  });
});
