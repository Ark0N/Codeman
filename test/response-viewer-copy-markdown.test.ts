/**
 * @fileoverview The response viewer's Copy Markdown button.
 *
 * The button copies the raw Markdown of the answer the viewer is showing, so a
 * heading stays `##` and a code fence stays a fence, which rendered text selected
 * with the mouse cannot do. Pinned here:
 *
 *  1. The copied source follows what the viewer rendered: the whole last answered
 *     turn in the brief view, the same selection in the full view, and nothing
 *     left over from an earlier open.
 *  2. Tool and status blocks (DeepSeek, the external-CLI pane parser) are not the
 *     answer and are never copied, and neither is a prompt.
 *  3. An empty viewer and a refused clipboard both say so; neither reports success.
 *  4. The markup, phone layout and zh-CN strings the button depends on.
 *
 * app.js is loaded via `vm` with a jsdom document, as in
 * response-viewer-last-turn.test.ts.
 * Port: N/A
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (file: string) => readFileSync(resolve(PUBLIC, file), 'utf8');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const { document, NodeFilter } = dom.window;

const appContext = vm.createContext({
  console,
  performance,
  setInterval: vi.fn(),
  clearInterval: vi.fn(),
  setTimeout,
  clearTimeout,
  requestAnimationFrame: vi.fn(),
  HTMLCanvasElement: class HTMLCanvasElement {},
  fetch: vi.fn(),
  navigator: {},
  document,
  NodeFilter,
  localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
  window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  MobileDetection: {},
}) as { fetch: unknown; navigator: unknown; __CodemanApp: { prototype: object } };
vm.runInContext(`${read('constants.js')}\n${read('app.js')}\nglobalThis.__CodemanApp = CodemanApp;`, appContext);

interface ViewerApp {
  toggleResponseViewer(): Promise<void>;
  loadFullContext(): Promise<void>;
  copyResponseViewerMarkdown(): Promise<void>;
  _bindResponseViewerInteractions(body: HTMLElement): void;
  _copyText: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  activeSessionId?: string;
  sessions?: Map<string, { mode: string }>;
}

function mountViewer() {
  const ids = ['responseViewer', 'responseViewerBackdrop', 'responseViewerBody', 'responseViewerTitle'];
  const [, , body] = ids.map((id) => {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
    return el;
  });
  const more = document.createElement('button');
  more.id = 'responseViewerMore';
  const button = document.createElement('button');
  button.id = 'responseViewerCopyMarkdown';
  document.body.append(more, button);
  return { body, button };
}

/** `responses` are served in order, one per fetch, inside the real route envelope. */
function makeApp(...responses: unknown[]): ViewerApp {
  const app = Object.create(appContext.__CodemanApp.prototype) as ViewerApp;
  app.activeSessionId = 's1';
  app.sessions = new Map([['s1', { mode: 'codex' }]]);
  app._copyText = vi.fn(async () => true);
  app.showToast = vi.fn();
  appContext.fetch = vi.fn(async () => ({ json: async () => ({ success: true, data: responses.shift() }) }));
  return app;
}

const MARKDOWN = '## Update\n\n- **Keep** the syntax\n- [docs](https://example.com)\n\n```ts\nconst a = 1;\n```';

afterEach(() => {
  document.body.innerHTML = '';
  appContext.navigator = {};
});
afterAll(() => dom.window.close());

describe('what Copy Markdown copies', () => {
  it('copies the raw source of a single-text response', async () => {
    mountViewer();
    const app = makeApp({ text: MARKDOWN });
    await app.toggleResponseViewer();
    await app.copyResponseViewerMarkdown();
    expect(app._copyText).toHaveBeenCalledWith(MARKDOWN);
  });

  it('copies every row of the turn the brief view rendered, not only the final one', async () => {
    mountViewer();
    const app = makeApp({
      text: 'Done.',
      messages: [
        { role: 'assistant', text: '## Finding', turn: 2 },
        { role: 'assistant', text: 'The bug is on line 3.', turn: 2 },
        { role: 'assistant', text: 'Done.', turn: 2 },
      ],
    });
    await app.toggleResponseViewer();
    await app.copyResponseViewerMarkdown();
    expect(app._copyText).toHaveBeenCalledWith('## Finding\n\nThe bug is on line 3.\n\nDone.');
  });

  it('follows a fresh open instead of keeping the previous answer', async () => {
    mountViewer();
    const app = makeApp({ text: 'old answer' }, { text: 'new answer' });
    await app.toggleResponseViewer();
    await app.toggleResponseViewer(); // close
    await app.toggleResponseViewer();
    await app.copyResponseViewerMarkdown();
    expect(app._copyText).toHaveBeenCalledWith('new answer');
  });

  it('copies the last answered turn from the full view, ignoring earlier turns and a queued prompt', async () => {
    mountViewer();
    const app = makeApp(
      { text: 'stale brief answer' },
      {
        messages: [
          { role: 'user', text: 'first', turn: 1 },
          { role: 'assistant', text: 'first answer', turn: 1 },
          { role: 'user', text: 'second', turn: 2 },
          { role: 'assistant', text: 'part one', turn: 2 },
          { role: 'assistant', text: 'part two', turn: 2 },
          { role: 'user', text: 'queued', turn: 3, queued: true },
        ],
      }
    );
    await app.toggleResponseViewer();
    await app.loadFullContext();
    await app.copyResponseViewerMarkdown();
    expect(app._copyText).toHaveBeenCalledWith('part one\n\npart two');
  });

  it('copies only the last response block when blocks have no turns, never a tool or status block', async () => {
    mountViewer();
    const app = makeApp(
      { text: 'brief' },
      {
        messages: [
          { kind: 'prompt', role: 'user', text: 'ask' },
          { kind: 'response', role: 'assistant', text: 'earlier response' },
          { kind: 'response', role: 'assistant', text: 'latest response' },
          { kind: 'tool', role: 'assistant', text: 'ran a tool' },
          { kind: 'status', role: 'assistant', text: 'max-tokens' },
        ],
      }
    );
    await app.toggleResponseViewer();
    await app.loadFullContext();
    await app.copyResponseViewerMarkdown();
    expect(app._copyText).toHaveBeenCalledWith('latest response');
  });

  it('keeps the brief answer when the full view finds no history and leaves it on screen', async () => {
    mountViewer();
    const app = makeApp({ text: 'the answer on screen' }, { messages: [] });
    await app.toggleResponseViewer();
    await app.loadFullContext();
    await app.copyResponseViewerMarkdown();
    expect(app._copyText).toHaveBeenCalledWith('the answer on screen');
  });

  it('keeps the brief answer when the full view holds a prompt and no answer of its own', async () => {
    mountViewer();
    const app = makeApp(
      { text: 'the brief answer' },
      { messages: [{ kind: 'prompt', role: 'user', text: 'a question', turn: 1 }] }
    );
    await app.toggleResponseViewer();
    await app.loadFullContext();
    await app.copyResponseViewerMarkdown();
    expect(app._copyText).toHaveBeenCalledWith('the brief answer');
  });
});

describe('what Copy Markdown reports', () => {
  it('confirms a successful copy on the button and in a toast', async () => {
    const { button } = mountViewer();
    const app = makeApp({ text: MARKDOWN });
    await app.toggleResponseViewer();
    await app.copyResponseViewerMarkdown();
    expect(button.classList.contains('rv-copied')).toBe(true);
    expect(app.showToast).toHaveBeenCalledWith('Copied response as Markdown', 'success');
  });

  it('warns and copies nothing when the viewer has no response, even after an earlier one', async () => {
    const { button } = mountViewer();
    const app = makeApp({ text: 'old answer' }, { text: '' });
    await app.toggleResponseViewer();
    await app.toggleResponseViewer(); // close
    await app.toggleResponseViewer();
    await app.copyResponseViewerMarkdown();
    expect(app._copyText).not.toHaveBeenCalled();
    expect(button.classList.contains('rv-copy-failed')).toBe(true);
    expect(app.showToast).toHaveBeenCalledWith('No response content to copy', 'warning');
  });

  it('reports failure when the Clipboard API rejects and the execCommand fallback also fails', async () => {
    const { button } = mountViewer();
    const app = makeApp({ text: MARKDOWN });
    delete (app as Partial<ViewerApp>)._copyText; // own stub off: the real prototype method runs
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    appContext.navigator = { clipboard: { writeText } };
    const execCommand = vi.fn(() => false);
    (document as unknown as { execCommand: unknown }).execCommand = execCommand;

    await app.toggleResponseViewer();
    await app.copyResponseViewerMarkdown();

    expect(writeText).toHaveBeenCalledWith(MARKDOWN);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(button.classList.contains('rv-copied')).toBe(false);
    expect(button.classList.contains('rv-copy-failed')).toBe(true);
    expect(app.showToast).toHaveBeenCalledWith('Failed to copy response as Markdown', 'error');
  });

  it('a later success clears the failure state', async () => {
    const { button } = mountViewer();
    const app = makeApp({ text: MARKDOWN });
    app._copyText.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await app.toggleResponseViewer();
    await app.copyResponseViewerMarkdown();
    await app.copyResponseViewerMarkdown();
    expect(button.classList.contains('rv-copy-failed')).toBe(false);
    expect(button.classList.contains('rv-copied')).toBe(true);
  });
});

describe('the per-code-block copy button still works through the shared state helper', () => {
  it('copies the block and marks the button', async () => {
    const { body } = mountViewer();
    body.innerHTML =
      '<div class="rv-code-wrap"><button class="rv-copy-btn"></button><pre><code>npm test</code></pre></div>';
    const app = makeApp();
    app._bindResponseViewerInteractions(body);
    const button = body.querySelector('.rv-copy-btn') as HTMLElement;
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(button.classList.contains('rv-copied')).toBe(true));
    expect(app._copyText).toHaveBeenCalledWith('npm test');
  });
});

describe('Copy Markdown markup, layout and strings', () => {
  it('sits in the viewer actions as a real button wired to the copy method', () => {
    const actions = read('index.html').match(/<div class="response-viewer-actions">[\s\S]*?<\/div>/)?.[0] ?? '';
    const tag = actions.match(/<button[^>]*id="responseViewerCopyMarkdown"[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('type="button"');
    expect(tag).toContain('onclick="app.copyResponseViewerMarkdown()"');
    expect(tag).toContain('title="Copy response as Markdown"');
    // The words on the button are its accessible name (WCAG 2.5.3, Label in
    // Name): an aria-label would replace them with a name that does not
    // contain "Copy Markdown", so a voice-control user could not say what
    // they see. The longer sentence stays as the title.
    expect(tag).not.toContain('aria-label');
    expect(actions).toContain('>Copy Markdown</button>');
  });

  it('colors copy feedback from skin tokens, like the code-block button', () => {
    const css = read('styles.css');
    const rule = (selector: string) => css.split(`${selector} {`)[1]?.split('}')[0] ?? '';
    expect(rule('.response-viewer-copy-markdown.rv-copied')).toContain('var(--green)');
    expect(rule('.response-viewer-copy-markdown.rv-copy-failed')).toContain('var(--red)');
  });

  it('lets a long title shrink on phones so the actions stay on screen', () => {
    const css = read('mobile.css');
    const rule = (selector: string) => css.split(`${selector} {`)[1]?.split('}')[0] ?? '';
    expect(rule('.response-viewer-header > span')).toContain('min-width: 0');
    expect(rule('.response-viewer-header > span')).toContain('text-overflow: ellipsis');
    expect(rule('.response-viewer-actions')).toContain('flex-shrink: 0');
  });

  it('translates the button and every toast into zh-CN', () => {
    const i18nDom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    });
    vm.runInContext(read('i18n.js'), i18nDom.getInternalVMContext(), { filename: 'i18n.js' });
    const api = (i18nDom.window as unknown as { CodemanI18n: { t(s: string): string; configure(o: object): void } })
      .CodemanI18n;
    api.configure({ language: 'zh-CN' });

    const method = read('app.js').match(/\n {2}async copyResponseViewerMarkdown\(\) \{[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    const toasts = [...method.matchAll(/'((?:No|Copied|Failed)[^']+)'/g)].map((m) => m[1]);
    expect(new Set(toasts)).toEqual(
      new Set(['No response content to copy', 'Copied response as Markdown', 'Failed to copy response as Markdown'])
    );
    // Exact strings: a generic rule turns any "Failed to ..." into half-translated text.
    expect(api.t('No response content to copy')).toBe('没有可复制的回复内容');
    expect(api.t('Copied response as Markdown')).toBe('已将回复复制为 Markdown');
    expect(api.t('Failed to copy response as Markdown')).toBe('无法将回复复制为 Markdown');
    expect(api.t('Copy Markdown')).toBe('复制 Markdown');
    expect(api.t('Copy response as Markdown')).toBe('将回复复制为 Markdown');
    i18nDom.window.close();
  });
});
