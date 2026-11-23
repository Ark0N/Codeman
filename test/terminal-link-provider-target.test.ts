/**
 * @fileoverview The file-path / URL link provider can serve a second terminal.
 *
 * `registerFilePathLinkProvider()` (terminal-ui.js) was hardwired to the
 * primary terminal and the ACTIVE session: a path clicked anywhere opened
 * against `activeSessionId`. It now takes an optional target `{ terminal,
 * getSessionId, setHovered }`, so the split pane's second terminal (and later a
 * grid tile) gets clickable paths that open against ITS session. With no target
 * it behaves exactly as before, and only the primary registration is kept on
 * `_terminalLinkProvider`, which the touch-tap path reads.
 *
 * Real code under test: constants.js + terminal-ui.js in a `vm` context.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Link = { text: string; activate: (ev: unknown, text: string) => void; hover: () => void; leave: () => void };
type Provider = { provideLinks: (line: number, cb: (links: Link[] | undefined) => void) => void };

function loadHarness(fetchResponse = vi.fn()) {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const windowRef: Record<string, unknown> = {};
  const context = vm.createContext({
    window: windowRef,
    AbortSignal,
    fetch: fetchResponse,
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
  const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('terminal-ui.js'), context, { filename: 'terminal-ui.js' });
  return new (CodemanApp as unknown as new () => Record<string, any>)();
}

/** A one-screen xterm stand-in holding `lines`, recording every provider registered on it. */
function fakeTerminal(lines: string[], cols = 80) {
  const providers: Provider[] = [];
  return {
    cols,
    providers,
    registerLinkProvider: (p: Provider) => providers.push(p),
    buffer: {
      active: {
        length: lines.length,
        viewportY: 0,
        getLine: (row: number) =>
          row >= 0 && row < lines.length
            ? {
                isWrapped: false,
                getCell: (col: number) => ({ getChars: () => lines[row][col] ?? ' ', getWidth: () => 1 }),
                translateToString: (trim?: boolean, start = 0, end = cols) => {
                  const text = lines[row].padEnd(cols).slice(start, end);
                  return trim ? text.trimEnd() : text;
                },
              }
            : undefined,
      },
    },
  };
}

function linksOn(provider: Provider, line: number): Link[] {
  let out: Link[] = [];
  provider.provideLinks(line, (links) => {
    out = links || [];
  });
  return out;
}

function makeApp() {
  const app = loadHarness();
  app.activeSessionId = 'primary-session';
  app.openFilePreview = vi.fn();
  app.openLogViewerWindow = vi.fn();
  app._isExternalPreviewPath = () => false;
  app._isOutsideWorktreePath = () => false;
  return app;
}

describe('registerFilePathLinkProvider with no target (the primary pane)', () => {
  it('registers on the primary terminal, keeps the provider for the tap path, opens against the active session', () => {
    const app = makeApp();
    app.terminal = fakeTerminal(['wrote /tmp/shot.png']);

    const provider = app.registerFilePathLinkProvider();

    expect(app.terminal.providers).toEqual([provider]);
    expect(app._terminalLinkProvider).toBe(provider);
    const [link] = linksOn(provider, 1);
    link.activate({}, link.text);
    expect(app.openFilePreview).toHaveBeenCalledWith('/tmp/shot.png', 'primary-session');
    link.hover();
    expect(app._linkHovered).toBe(true);
  });
});

describe('registerFilePathLinkProvider with a target (a second pane)', () => {
  it("registers on the target terminal and opens against the target's session, not the active one", () => {
    const app = makeApp();
    app.terminal = fakeTerminal([]);
    const primaryProvider = app.registerFilePathLinkProvider();
    const paneTerminal = fakeTerminal(['tail -f /var/log/app.log']);
    const setHovered = vi.fn();

    const provider = app.registerFilePathLinkProvider({
      terminal: paneTerminal,
      getSessionId: () => 'pane-session',
      setHovered,
    });

    expect(paneTerminal.providers).toEqual([provider]);
    expect(app.terminal.providers).toEqual([primaryProvider]);
    // The tap path's provider is still the primary one.
    expect(app._terminalLinkProvider).toBe(primaryProvider);

    const [link] = linksOn(provider, 1);
    link.activate({}, link.text);
    expect(app.openLogViewerWindow).toHaveBeenCalledWith('/var/log/app.log', 'pane-session');

    link.hover();
    link.leave();
    expect(setHovered.mock.calls).toEqual([[true], [false]]);
    expect(app._linkHovered).toBeUndefined();
  });

  it('reads the session at click time, so a pane rebound to another session follows it', () => {
    const app = makeApp();
    let sessionId = 'first';
    const paneTerminal = fakeTerminal(['see /tmp/a.pdf']);
    const provider = app.registerFilePathLinkProvider({ terminal: paneTerminal, getSessionId: () => sessionId });

    sessionId = 'second';
    const [link] = linksOn(provider, 1);
    link.activate({}, link.text);

    expect(app.openFilePreview).toHaveBeenCalledWith('/tmp/a.pdf', 'second');
  });
});

describe('native Codex sidebar files', () => {
  const left = 'wrote /tmp/keep.png'.padEnd(42);
  const tab = ' Brief…26943.docx × +';
  const picker = ' › · Word draft.docx  Project root';

  function setupSidebar() {
    const app = makeApp();
    app._supportsCodexResponseFiles = () => true;
    const terminal = fakeTerminal([
      left + '│' + tab,
      ' '.repeat(42) + '│ Open in sidebar',
      ' '.repeat(42) + '│ Files 1',
      ' '.repeat(42) + '│' + picker,
      ' '.repeat(42) + '│ body /tmp/normal.png',
    ]);
    app.terminal = terminal;
    app._clientPointToCell = (col: number, row: number) => ({ col, row });
    return { app, terminal };
  }

  it('finds a shortened tab and a picker entry without claiming the close button or directory suffix', () => {
    const { app, terminal } = setupSidebar();
    expect(app._codexTerminalLinkLabel(terminal, 47, 1)).toMatchObject({ label: 'Brief…26943.docx', sidebar: true });
    expect(app._codexTerminalLinkLabel(terminal, 44 + tab.indexOf('×'), 1)).toBeNull();
    expect(app._codexTerminalLinkLabel(terminal, 52, 4)).toMatchObject({ label: 'Word draft.docx', sidebar: true });
    expect(app._codexTerminalLinkLabel(terminal, 44 + picker.indexOf('Project'), 4)).toBeNull();
  });

  it('suppresses generic sidebar suffixes and preserves ordinary paths beside and below them', () => {
    const { app } = setupSidebar();
    const provider = app.registerFilePathLinkProvider();
    expect(linksOn(provider, 1).map(({ text }) => text)).toEqual(['/tmp/keep.png']);
    expect(linksOn(provider, 4)).toEqual([]);
    expect(linksOn(provider, 5).map(({ text }) => text)).toEqual(['/tmp/normal.png']);
    app._supportsCodexResponseFiles = () => false;
    expect(linksOn(provider, 4).map(({ text }) => text)).toContain('draft.docx');
  });
});

describe('Codex response click fallback', () => {
  const clicked = { label: 'Word draft.docx', row: 1, start: 42, end: 57, sidebar: true };
  const point = { clientX: 40, clientY: 10 };

  it.each(['failed load', 'no match', 'superseded click', 'moved cell', 'matched file'])(
    'handles %s',
    async (outcome) => {
      const fetchResponse = vi.fn();
      const app = loadHarness(fetchResponse);
      const forward = vi.fn();
      const terminal = fakeTerminal([]);
      const match = vi.fn(() => (outcome === 'no match' ? null : '/work/Word draft.docx'));
      app._findCodexResponseFile = match;
      app._codexTerminalLinkLabel = () => (outcome === 'moved cell' ? { ...clicked, row: 2 } : clicked);
      app._openResponseFile = vi.fn();
      if (outcome === 'failed load') fetchResponse.mockRejectedValue(new Error('offline'));
      else fetchResponse.mockResolvedValue({ ok: true, json: async () => ({ data: { messages: [] } }) });
      await app._openCodexTerminalResponseFile(
        terminal,
        'pane',
        point,
        clicked,
        () => outcome !== 'superseded click',
        forward
      );
      expect(forward).toHaveBeenCalledTimes(Number(outcome === 'failed load' || outcome === 'no match'));
      if (outcome === 'matched file') {
        expect(app._openResponseFile).toHaveBeenCalledWith('/work/Word draft.docx', 'pane');
      } else {
        expect(app._openResponseFile).not.toHaveBeenCalled();
      }
      if (outcome === 'superseded click') expect(match).not.toHaveBeenCalled();
    }
  );
});
