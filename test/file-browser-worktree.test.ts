/**
 * @fileoverview Files panel following the agent into a git worktree (#765).
 *
 * The server does the walking, so what can go wrong here is the client: asking for the wrong root,
 * showing a strip that does not describe the tree on screen, or reloading forever. The last one is
 * why the follow compares with what the listing reported rather than with the previous update.
 *
 * Loaded via `vm` with a stubbed context, like file-browser-hidden.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const panelsJs = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');
const appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
const indexHtml = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const stylesCss = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');

const WORKTREE = { name: 'probe', path: '/repo/.claude/worktrees/probe' };

function element() {
  const classes = new Set<string>();
  return {
    innerHTML: '',
    textContent: '',
    title: '',
    hidden: true,
    value: '',
    classList: {
      toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name: string) => classes.has(name),
    },
    setAttribute: () => {},
    querySelectorAll: () => [],
  };
}

function loadPanel() {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, any>;
  const context = vm.createContext({
    CodemanApp,
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    escapeHtml: (s: string) => String(s),
    document: { getElementById: () => null, addEventListener: vi.fn() },
    window: { addEventListener: vi.fn() },
    setTimeout,
    clearTimeout,
    fetch: undefined as unknown,
    CodemanBase: { url: (p: string) => p },
  });
  vm.runInContext(panelsJs, context, { filename: 'panels-ui.js' });

  const ids = [
    'fileBrowserPanel',
    'fileBrowserTree',
    'fileBrowserStatus',
    'fileBrowserHiddenBtn',
    'fileBrowserSearch',
    'fileBrowserRoot',
    'fileBrowserRootLabel',
    'fileBrowserRootName',
    'fileBrowserRootSwitch',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  elements.fileBrowserPanel.classList.toggle('visible', true);

  const app = new CodemanApp();
  app.$ = (id: string) => elements[id] ?? null;
  app.activeSessionId = 'sess-1';
  app.fileBrowserData = null;
  app.fileBrowserExpandedDirs = new Set<string>();
  app.fileBrowserFilter = '';
  app.fileBrowserShowHidden = false;
  app.getFileIcon = () => '';
  app.formatFileSize = () => '';

  // A stand-in for the route: the session's worktree, listed when the request asks for it.
  const server = { worktree: null as typeof WORKTREE | null, requests: [] as string[] };
  context.fetch = async (url: string) => {
    server.requests.push(url);
    const live = url.includes('root=live') && server.worktree;
    const data = {
      root: live ? server.worktree!.path : '/repo',
      ...(server.worktree && { worktree: server.worktree }),
      tree: [],
      totalFiles: 0,
      totalDirectories: 0,
      truncated: false,
      ...(url.includes('q=') && { mode: 'search', matches: [], matchCount: 0 }),
    };
    return { ok: true, json: async () => ({ success: true, data }) };
  };
  return { app, elements, server };
}

const strip = (elements: Record<string, ReturnType<typeof element>>) => ({
  hidden: elements.fileBrowserRoot.hidden,
  label: elements.fileBrowserRootLabel.textContent,
  name: elements.fileBrowserRootName.textContent,
  button: elements.fileBrowserRootSwitch.textContent,
  title: elements.fileBrowserRoot.title,
});

describe('Files panel in a git worktree', () => {
  it('asks for the live root by default', async () => {
    const { app, server } = loadPanel();
    await app.loadFileBrowser('sess-1');
    expect(server.requests[0]).toContain('root=live');
  });

  it('shows no strip for a session in no worktree', async () => {
    const { app, elements } = loadPanel();
    await app.loadFileBrowser('sess-1');
    expect(elements.fileBrowserRoot.hidden).toBe(true);
  });

  it('says which worktree is listed, and offers the session folder', async () => {
    const { app, elements, server } = loadPanel();
    server.worktree = WORKTREE;
    await app.loadFileBrowser('sess-1');
    expect(strip(elements)).toEqual({
      hidden: false,
      label: 'Worktree',
      name: 'probe',
      button: 'Session folder',
      title: WORKTREE.path,
    });
  });

  it('switches to the session folder and back', async () => {
    const { app, elements, server } = loadPanel();
    server.worktree = WORKTREE;
    await app.loadFileBrowser('sess-1');

    await app.toggleFileBrowserRoot();
    expect(server.requests[1]).not.toContain('root=live');
    expect(strip(elements)).toEqual({
      hidden: false,
      label: 'Session folder',
      name: '',
      button: 'Back to worktree',
      title: '/repo',
    });

    await app.toggleFileBrowserRoot();
    expect(server.requests[2]).toContain('root=live');
    expect(elements.fileBrowserRootName.textContent).toBe('probe');
  });

  it('keeps the query in the box across the switch, and searches the new root', async () => {
    const { app, elements, server } = loadPanel();
    server.worktree = WORKTREE;
    await app.loadFileBrowser('sess-1');
    app._fileBrowserState.filter = 'main';
    elements.fileBrowserSearch.value = 'main';

    await app.toggleFileBrowserRoot();
    await vi.waitFor(() => expect(server.requests.some((url) => url.includes('q=main'))).toBe(true));

    const search = server.requests.find((url) => url.includes('q=main'))!;
    expect(search).not.toContain('root=live');
  });

  it('follows the agent into a worktree while the panel is open', async () => {
    const { app, elements, server } = loadPanel();
    await app.loadFileBrowser('sess-1');
    expect(server.requests).toHaveLength(1);

    server.worktree = WORKTREE;
    app._followFileBrowserWorktree({ id: 'sess-1', liveWorktree: WORKTREE });
    await vi.waitFor(() => expect(server.requests).toHaveLength(2));
    await vi.waitFor(() => expect(elements.fileBrowserRoot.hidden).toBe(false));
    expect(elements.fileBrowserRootName.textContent).toBe('probe');
  });

  it('follows the agent back out, and a pin on the old worktree does not outlive it', async () => {
    const { app, elements, server } = loadPanel();
    server.worktree = WORKTREE;
    await app.loadFileBrowser('sess-1');
    await app.toggleFileBrowserRoot();

    server.worktree = null;
    app._followFileBrowserWorktree({ id: 'sess-1' });
    await vi.waitFor(() => expect(elements.fileBrowserRoot.hidden).toBe(true));
    expect(app._fileBrowserState.sessionRootPinned).toBe(false);
  });

  it('settles: updates that agree with the listing reload nothing', async () => {
    const { app, server } = loadPanel();
    server.worktree = WORKTREE;
    await app.loadFileBrowser('sess-1');
    app._followFileBrowserWorktree({ id: 'sess-1', liveWorktree: WORKTREE });
    app._followFileBrowserWorktree({ id: 'sess-1', liveWorktree: WORKTREE });
    expect(server.requests).toHaveLength(1);
  });

  it('leaves another session and a closed panel alone', async () => {
    const { app, elements, server } = loadPanel();
    await app.loadFileBrowser('sess-1');
    app._followFileBrowserWorktree({ id: 'other', liveWorktree: WORKTREE });
    elements.fileBrowserPanel.classList.toggle('visible', false);
    app._followFileBrowserWorktree({ id: 'sess-1', liveWorktree: WORKTREE });
    expect(server.requests).toHaveLength(1);
  });

  it('drops the pin and the strip on a session switch', async () => {
    const { app, elements, server } = loadPanel();
    server.worktree = WORKTREE;
    await app.loadFileBrowser('sess-1');
    await app.toggleFileBrowserRoot();

    app._activateFileBrowserSession('sess-2');
    expect(app._fileBrowserState.sessionRootPinned).toBe(false);
    expect(elements.fileBrowserRoot.hidden).toBe(true);
  });

  it('gives the switch button a name before the first listing fills it in', () => {
    expect(indexHtml).toMatch(/id="fileBrowserRootSwitch"[^>]*>Session folder<\/button>/);
  });

  it('is wired up in the page', () => {
    expect(appJs).toContain('this._followFileBrowserWorktree?.(session)');
    expect(indexHtml).toContain('id="fileBrowserRoot" hidden');
    expect(indexHtml).toContain('onclick="app.toggleFileBrowserRoot()"');
    // The strip sets `display`, so `hidden` needs its own rule or it never hides.
    expect(stylesCss).toMatch(/\.file-browser-root\[hidden\]\s*\{\s*display: none;/);
  });
});
