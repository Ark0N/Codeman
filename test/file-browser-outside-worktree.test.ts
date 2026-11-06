/**
 * @fileoverview The browser side of a worktree OUTSIDE the session folder (#765 follow-up).
 *
 * The server lists such a worktree with absolute paths and serves them as a second root. The
 * browser has to route those paths to the workspace file routes (preview and edit), not to the
 * attachment routes that serve an outside file read-only; the terminal has to open them in the
 * preview, since the log viewer's `tail-file` stays confined to `workingDir`; and a root-relative
 * markdown ref has to resolve from the top of the worktree. Real frontend code in a `vm` context.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const read = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');

const WORKING_DIR = '/base/myapp';
const SIBLING = '/base/myapp-feature';
const outsideSession = () => ({
  workingDir: WORKING_DIR,
  outsideWorktree: { name: 'myapp-feature', path: SIBLING, outside: true },
});

type Proto = {
  _isExternalPreviewPath: (p: string, id: string) => boolean;
  _isOutsideWorktreePath: (p: string, id: string) => boolean;
};

const loadRouting = (session: Record<string, unknown>) => {
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    document: { addEventListener: vi.fn(), getElementById: () => null },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  vm.runInContext(
    `${read('constants.js')}\n${read('terminal-ui.js')}\n${read('panels-ui.js')}\nglobalThis.__proto = CodemanApp.prototype;`,
    context
  );
  const proto = (context as unknown as { __proto: Proto }).__proto;
  const app = Object.assign(Object.create(proto), { sessions: new Map([['s1', session]]) }) as Proto;
  return {
    external: (p: string) => app._isExternalPreviewPath(p, 's1'),
    outside: (p: string) => app._isOutsideWorktreePath(p, 's1'),
  };
};

describe('preview routing for a worktree outside the session folder', () => {
  it('keeps a path inside the outside worktree on the workspace routes', () => {
    const app = loadRouting(outsideSession());
    expect(app.external(`${SIBLING}/src/a.ts`)).toBe(false);
    expect(app.external(SIBLING)).toBe(false);
    expect(app.outside(`${SIBLING}/src/a.ts`)).toBe(true);
  });

  it('still sends every other outside path through the attachment routes', () => {
    const app = loadRouting(outsideSession());
    expect(app.external('/base/myapp-feature-2/src/a.ts')).toBe(true);
    expect(app.external('/tmp/shot.png')).toBe(true);
    expect(app.outside('/base/myapp-feature-2/src/a.ts')).toBe(false);
    expect(app.outside('relative/a.ts')).toBe(false);
  });

  it('leaves workspace paths and an inside worktree as they were', () => {
    const app = loadRouting({
      workingDir: WORKING_DIR,
      liveWorktree: { name: 'probe', path: `${WORKING_DIR}/.claude/worktrees/probe` },
    });
    expect(app.external(`${WORKING_DIR}/src/a.ts`)).toBe(false);
    expect(app.outside(`${WORKING_DIR}/.claude/worktrees/probe/a.ts`)).toBe(false);
    expect(app.external(`${SIBLING}/src/a.ts`)).toBe(true);
  });

  it('treats a sibling path as external once the agent has left the worktree', () => {
    const app = loadRouting({ workingDir: WORKING_DIR });
    expect(app.external(`${SIBLING}/src/a.ts`)).toBe(true);
    expect(app.outside(`${SIBLING}/src/a.ts`)).toBe(false);
  });
});

describe('terminal links into a worktree outside the session folder', () => {
  type Link = { text: string; activate: (ev: unknown, text: string) => void };
  type Provider = { provideLinks: (line: number, cb: (links: Link[] | undefined) => void) => void };

  const makeApp = (line: string) => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const context = vm.createContext({
      window: {},
      document: {
        body: { classList: { contains: () => false } },
        activeElement: null,
        addEventListener: vi.fn(),
        getElementById: () => null,
      },
      CodemanApp,
      console: { warn: vi.fn(), log: vi.fn(), debug: vi.fn() },
      _crashDiag: { log: vi.fn() },
      performance: { now: () => 0 },
      requestAnimationFrame: () => 1,
      setTimeout: () => 1,
      MobileDetection: { isTouchDevice: () => false },
      DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
      OSC52_STRIP_RE: /\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)/g,
      TERMINAL_CHUNK_SIZE: 32 * 1024,
    });
    vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
    vm.runInContext(read('terminal-ui.js'), context, { filename: 'terminal-ui.js' });
    vm.runInContext(read('panels-ui.js'), context, { filename: 'panels-ui.js' });
    const app = new (CodemanApp as unknown as new () => Record<string, any>)();
    app.activeSessionId = 's1';
    app.sessions = new Map([['s1', outsideSession()]]);
    app.openFilePreview = vi.fn();
    app.openLogViewerWindow = vi.fn();
    const providers: Provider[] = [];
    app.terminal = {
      cols: 80,
      registerLinkProvider: (p: Provider) => providers.push(p),
      buffer: {
        active: {
          length: 1,
          getLine: (row: number) =>
            row === 0
              ? { isWrapped: false, translateToString: (trim?: boolean) => (trim === false ? line.padEnd(80) : line) }
              : undefined,
        },
      },
    };
    app.registerFilePathLinkProvider();
    let links: Link[] = [];
    providers[0].provideLinks(1, (found) => {
      links = found || [];
    });
    return { app, link: links[0] };
  };

  it('opens a log in the outside worktree in the preview, since tail-file stays in the session folder', () => {
    const { app, link } = makeApp(`tail -f ${SIBLING}/logs/server.log`);
    link.activate({}, link.text);
    expect(app.openFilePreview).toHaveBeenCalledWith(`${SIBLING}/logs/server.log`, 's1');
    expect(app.openLogViewerWindow).not.toHaveBeenCalled();
  });

  it('keeps a log in the session folder in the log viewer', () => {
    const { app, link } = makeApp(`tail -f ${WORKING_DIR}/logs/server.log`);
    link.activate({}, link.text);
    expect(app.openLogViewerWindow).toHaveBeenCalledWith(`${WORKING_DIR}/logs/server.log`, 's1');
  });
});

describe('markdown in a worktree outside the session folder', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
  const { document } = dom.window;

  it('resolves root-relative and relative refs from the worktree, not the session folder', () => {
    const context = vm.createContext({
      console,
      CodemanApp: class CodemanApp {},
      document,
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    vm.runInContext(
      `${read('constants.js')}\n${read('panels-ui.js')}\nglobalThis.__proto = CodemanApp.prototype;`,
      context
    );
    const proto = (context as unknown as { __proto: Record<string, any> }).__proto;
    const app = Object.assign(Object.create(proto), { sessions: new Map([['s1', outsideSession()]]) });
    const root = document.createElement('div');
    root.innerHTML = '<img src="/assets/root.png" alt="root"><img src="img/a.png" alt="rel">';

    app._rebaseFilePreviewMarkdownRefs(root, { sessionId: 's1', filePath: `${SIBLING}/docs/README.md` });

    const raw = (path: string) => `/api/sessions/s1/file-raw?path=${encodeURIComponent(path)}`;
    const src = (alt: string) => root.querySelector(`img[alt="${alt}"]`)!.getAttribute('src');
    expect(src('root')).toBe(raw(`${SIBLING}/assets/root.png`));
    expect(src('rel')).toBe(raw(`${SIBLING}/docs/img/a.png`));
  });
});

describe('the Files panel following an agent in a worktree outside the session folder', () => {
  const OUTSIDE = { name: 'myapp-feature', path: SIBLING };
  const update = (extra: Record<string, unknown>) => ({ id: 'sess-1', ...extra });

  const panelElement = () => {
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
  };

  const loadPanel = () => {
    const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, any>;
    const context = vm.createContext({
      CodemanApp,
      console,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      escapeHtml: (x: string) => String(x),
      document: { getElementById: () => null, addEventListener: vi.fn() },
      window: { addEventListener: vi.fn() },
      setTimeout,
      clearTimeout,
      fetch: undefined as unknown,
      CodemanBase: { url: (path: string) => path },
    });
    vm.runInContext(read('panels-ui.js'), context, { filename: 'panels-ui.js' });
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
    const elements = Object.fromEntries(ids.map((id) => [id, panelElement()]));
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

    // A stand-in for the route. The agent is in the outside worktree when `outside` is set, and
    // a listing then reports it only when the request asks for root=live-any.
    const server = { outside: null as typeof OUTSIDE | null, requests: [] as string[] };
    context.fetch = async (url: string) => {
      server.requests.push(url);
      const live = url.includes('root=live') && server.outside;
      const data = {
        root: live ? server.outside!.path : WORKING_DIR,
        ...(live && { worktree: server.outside }),
        tree: [],
        totalFiles: 0,
        totalDirectories: 0,
        truncated: false,
      };
      return { ok: true, json: async () => ({ success: true, data }) };
    };
    return { app, elements, server };
  };

  it('reloads when an update carries only outsideWorktree and the listing reports none', async () => {
    const { app, server } = loadPanel();
    await app.loadFileBrowser('sess-1');
    expect(server.requests).toHaveLength(1);
    const reload = vi.spyOn(app, '_reloadFileBrowserKeepingQuery');

    server.outside = OUTSIDE;
    app._followFileBrowserWorktree(update({ outsideWorktree: { ...OUTSIDE, outside: true } }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the listing already reports that outside worktree', async () => {
    const { app, server } = loadPanel();
    server.outside = OUTSIDE;
    await app.loadFileBrowser('sess-1');
    const reload = vi.spyOn(app, '_reloadFileBrowserKeepingQuery');

    app._followFileBrowserWorktree(update({ outsideWorktree: { ...OUTSIDE, outside: true } }));
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the session folder pinned while the agent stays in the outside worktree', async () => {
    const { app, elements, server } = loadPanel();
    server.outside = OUTSIDE;
    await app.loadFileBrowser('sess-1');
    await app.toggleFileBrowserRoot();
    await vi.waitFor(() => expect(app._fileBrowserState.normalState?.phase).toBe('ready'));
    expect(app._fileBrowserState.normalState.data.worktree).toBeUndefined();
    const reload = vi.spyOn(app, '_reloadFileBrowserKeepingQuery');

    app._followFileBrowserWorktree(update({ outsideWorktree: { ...OUTSIDE, outside: true } }));
    expect(reload).not.toHaveBeenCalled();
    expect(app._fileBrowserState.sessionRootPinned).toBe(true);
    expect(elements.fileBrowserRoot.hidden).toBe(false);
    expect(elements.fileBrowserRootLabel.textContent).toBe('Session folder');
    expect(elements.fileBrowserRootSwitch.textContent).toBe('Back to worktree');
  });

  it('drops the pin and reloads once the agent leaves the outside worktree', async () => {
    const { app, server } = loadPanel();
    server.outside = OUTSIDE;
    await app.loadFileBrowser('sess-1');
    await app.toggleFileBrowserRoot();
    await vi.waitFor(() => expect(app._fileBrowserState.normalState?.phase).toBe('ready'));
    const reload = vi.spyOn(app, '_reloadFileBrowserKeepingQuery');

    server.outside = null;
    app._followFileBrowserWorktree(update({}));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(app._fileBrowserState.sessionRootPinned).toBe(false);
    expect(app._fileBrowserState.pinnedWorktree).toBeNull();
  });
});
