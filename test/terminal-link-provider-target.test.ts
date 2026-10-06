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

function loadHarness() {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const windowRef: Record<string, unknown> = {};
  const context = vm.createContext({
    window: windowRef,
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
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });
  const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('terminal-ui.js'), context, { filename: 'terminal-ui.js' });
  return new (CodemanApp as unknown as new () => Record<string, any>)();
}

/** A one-screen xterm stand-in holding `lines`, recording every provider registered on it. */
function fakeTerminal(lines: string[]) {
  const providers: Provider[] = [];
  return {
    cols: 80,
    providers,
    registerLinkProvider: (p: Provider) => providers.push(p),
    buffer: {
      active: {
        length: lines.length,
        getLine: (row: number) =>
          row >= 0 && row < lines.length
            ? {
                isWrapped: false,
                translateToString: (trim?: boolean) => (trim === false ? lines[row].padEnd(80) : lines[row]),
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
