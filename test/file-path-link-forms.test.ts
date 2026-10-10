/**
 * @fileoverview Clickable file paths beyond the rooted absolute form: `~/…`,
 * relative paths, and paths a program broke over lines itself.
 *
 * - `findFilePathLinks` / `resolveLinkedFilePath` / `terminalPathLine`
 *   (constants.js) on the shapes real agent output has: Claude Code echoes an
 *   attached image as `› [image] ~/…/garage.png`, scripts print
 *   `builds/captures/…png`, and Claude Code wraps tool output a few columns
 *   short of the edge, so a long path arrives as `…/captures/2` + `026-10-10/x.png`.
 * - The terminal link provider turns those into ONE link and opens the resolved
 *   path (relative against the session's working directory, `~/` as is).
 * - The server expands `~/` (local: this host's home; remote: the probe on the
 *   remote host), so the attachment route can serve it.
 *
 * Real code under test: constants.js + terminal-ui.js in a `vm` context, and
 * the shipped attachment registry / probe script.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { registerExternalAttachment } from '../src/attachment-registry.js';
import { buildRemoteProbeCommand, parseRemoteProbeOutput } from '../src/remote-files.js';

type Line = {
  startRow: number;
  endRow: number;
  text: string;
  offsetToCell: (o: number) => { row: number; col: number };
};
type Helpers = {
  findFilePathLinks: (text: string) => Array<{ path: string; index: number }>;
  resolveLinkedFilePath: (path: string, workingDir?: string) => string;
  terminalPathLine: (buffer: unknown, row: number, cols: number, maxRows?: number) => Line | null;
};

const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');

function loadHelpers(): Helpers {
  const context = vm.createContext({});
  vm.runInContext(
    `${read('constants.js')}\nglobalThis.__h = { findFilePathLinks, resolveLinkedFilePath, terminalPathLine };`,
    context,
    { filename: 'constants.js' }
  );
  return (context as { __h: Helpers }).__h;
}

const { findFilePathLinks, resolveLinkedFilePath, terminalPathLine } = loadHelpers();
const paths = (text: string) => findFilePathLinks(text).map((f) => f.path);

/** An xterm buffer stand-in: hard-broken rows (no `isWrapped`), as Claude Code emits them. */
function buffer(lines: string[], cols = 80) {
  return {
    length: lines.length,
    getLine: (row: number) =>
      row >= 0 && row < lines.length
        ? {
            isWrapped: false,
            translateToString: (trim?: boolean) => (trim ? lines[row].replace(/\s+$/, '') : lines[row].padEnd(cols)),
          }
        : undefined,
  };
}

// Verbatim from a live pane (2026-10-10): the tool output wrapped at ~64 columns.
const BROKEN = [
  '  ⎿  BILD /mnt/build/neon_getaway-mgr-hebel/builds/captures/2',
  '     026-10-10/ghost1b_gameplay.png err=0 kamera=(1108,13,811',
  '     ) blick=',
];
const BROKEN_PATH = '/mnt/build/neon_getaway-mgr-hebel/builds/captures/2026-10-10/ghost1b_gameplay.png';

describe('findFilePathLinks', () => {
  it('links home-relative and relative paths', () => {
    expect(paths('  › [image] ~/repos/neon-menu/assets/ui/backgrounds/garage_plate.png (1.1MB)')).toEqual([
      '~/repos/neon-menu/assets/ui/backgrounds/garage_plate.png',
    ]);
    expect(paths('2 Bericht: refs/shaderpatch_pixel_1010/BERICHT.md. Alle 12')).toEqual([
      'refs/shaderpatch_pixel_1010/BERICHT.md',
    ]);
    expect(paths('./a.md ../b.json look_montage.png')).toEqual(['./a.md', '../b.json', 'look_montage.png']);
  });

  it('keeps brackets, `=` and trailing punctuation out of a relative path', () => {
    expect(paths('1. Garage-BG (garage_plate.png) — Bühne')).toEqual(['garage_plate.png']);
    expect(paths('OUT=builds/captures/x.png, "shots/b.webp"')).toEqual(['builds/captures/x.png', 'shots/b.webp']);
    expect(paths('see src/a.ts:120.')).toEqual(['src/a.ts']);
  });

  it('still finds rooted absolute paths, and never a relative path inside one', () => {
    expect(paths('sign-off from /mnt/raid1/x/refs/look_montage.png.')).toEqual(['/mnt/raid1/x/refs/look_montage.png']);
    // Unknown root: not linked at all (no `nix/store/…` cut out of it).
    expect(paths('/nix/store/abc-x/share/icon.png')).toEqual([]);
    // `/etc` stays out on purpose (the server refuses that tree).
    expect(paths('/etc/app/config.json')).toEqual([]);
  });

  it('never cuts a path out of a web URL, but keeps file:// paths', () => {
    expect(paths('https://x.io/a/home/b.png?img=c.png')).toEqual([]);
    expect(paths('file:///home/joe/x.png')).toEqual(['/home/joe/x.png']);
  });

  it('reports where each path starts', () => {
    const text = 'a ~/x.png b /tmp/y.pdf c z.md';
    for (const { path, index } of findFilePathLinks(text)) expect(text.slice(index, index + path.length)).toBe(path);
  });
});

describe('resolveLinkedFilePath', () => {
  it('resolves relative paths against the working directory, collapsing . and ..', () => {
    expect(resolveLinkedFilePath('builds/x.png', '/mnt/ws')).toBe('/mnt/ws/builds/x.png');
    expect(resolveLinkedFilePath('./a/./b.md', '/mnt/ws/')).toBe('/mnt/ws/a/b.md');
    expect(resolveLinkedFilePath('../other/x.png', '/mnt/ws')).toBe('/mnt/other/x.png');
  });

  it('leaves absolute and ~/ paths alone, and relative ones without a working directory', () => {
    expect(resolveLinkedFilePath('/tmp/a.png', '/mnt/ws')).toBe('/tmp/a.png');
    expect(resolveLinkedFilePath('~/a.png', '/mnt/ws')).toBe('~/a.png');
    expect(resolveLinkedFilePath('a.png', undefined)).toBe('a.png');
  });
});

describe('terminalPathLine', () => {
  it('glues a path broken short of the edge back together, from either row', () => {
    for (const row of [0, 1]) {
      const line = terminalPathLine(buffer(BROKEN), row, 80)!;
      expect([line.startRow, line.endRow]).toEqual([0, 1]);
      const [found] = findFilePathLinks(line.text);
      expect(found.path).toBe(BROKEN_PATH);
      // The cells are exact on both rows: after `  ⎿  BILD ` and after the 5-column indent.
      expect(line.offsetToCell(found.index)).toEqual({ row: 0, col: 10 });
      expect(line.offsetToCell(found.index + found.path.length - 1)).toEqual({ row: 1, col: 34 });
    }
    expect(terminalPathLine(buffer(BROKEN), 2, 80)).toMatchObject({ startRow: 2, endRow: 2 });
  });

  it('follows a path over three rows', () => {
    const rows = ['x /tmp/claude-1001/-home-joe-cases', '  -neon/de4576ce-aaaaaaaaaaaaa', '  -56b4/shot.png'];
    const line = terminalPathLine(buffer(rows), 1, 80)!;
    expect(paths(line.text)).toEqual(['/tmp/claude-1001/-home-joe-cases-neon/de4576ce-aaaaaaaaaaaaa-56b4/shot.png']);
  });

  it('does not glue lines that are not a broken path', () => {
    // A shorter line ending on a directory, then a longer one: not a wrap.
    expect(terminalPathLine(buffer(['cd /mnt/raid1/foo', '  file.png erstellt']), 0, 80)).toMatchObject({ endRow: 0 });
    // A chain that never reaches a file is dropped.
    const listing = terminalPathLine(buffer(['cd ~/repos/neon', 'ls', 'a.png']), 2, 80)!;
    expect(paths(listing.text)).toEqual(['a.png']);
    // A path that already ended, and a next line opening a new rooted path.
    expect(terminalPathLine(buffer(['see /tmp/a/b.png', 'c/d.png']), 0, 80)).toMatchObject({ endRow: 0 });
    expect(terminalPathLine(buffer(['/home/joe/dir/', '/home/x.png']), 0, 80)).toMatchObject({ endRow: 0 });
  });
});

type Link = {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate: (ev: unknown, text: string) => void;
};
type Provider = { provideLinks: (line: number, cb: (links: Link[] | undefined) => void) => void };

function loadApp() {
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
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('terminal-ui.js'), context, { filename: 'terminal-ui.js' });
  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  app.activeSessionId = 's1';
  app.sessions = new Map([['s1', { workingDir: '/mnt/build/neon_getaway-mgr-hebel' }]]);
  app.openFilePreview = vi.fn();
  app.openLogViewerWindow = vi.fn();
  app._isExternalPreviewPath = (p: string) => p.startsWith('~/');
  return app;
}

function linksOn(lines: string[], row: number) {
  const app = loadApp();
  app.terminal = { cols: 80, registerLinkProvider: vi.fn(), buffer: { active: buffer(lines) } };
  const provider = app.registerFilePathLinkProvider() as Provider;
  let out: Link[] = [];
  provider.provideLinks(row, (links) => {
    out = links || [];
  });
  return { app, links: out };
}

describe('terminal link provider', () => {
  it('links a broken path once, across both rows, and opens the whole path', () => {
    const { app, links } = linksOn(BROKEN, 2);
    expect(links.map((l) => l.text)).toEqual([BROKEN_PATH]);
    expect(links[0].range.start).toEqual({ x: 11, y: 1 });
    expect(links[0].range.end.y).toBe(2);
    links[0].activate({}, links[0].text);
    expect(app.openFilePreview).toHaveBeenCalledWith(BROKEN_PATH, 's1');
  });

  it('opens a relative path resolved against the working directory', () => {
    const { app, links } = linksOn(['  ⎿  wrote builds/captures/2026-10-10/a.png'], 1);
    links[0].activate({}, links[0].text);
    expect(app.openFilePreview).toHaveBeenCalledWith(
      '/mnt/build/neon_getaway-mgr-hebel/builds/captures/2026-10-10/a.png',
      's1'
    );
  });

  it('opens a ~/ path as is, in the preview (the server expands it), even for text', () => {
    const { app, links } = linksOn(['  › [image] ~/repos/x/garage.png', 'notes ~/logs/run.log'], 2);
    links[0].activate({}, links[0].text);
    expect(app.openFilePreview).toHaveBeenCalledWith('~/logs/run.log', 's1');
    expect(app.openLogViewerWindow).not.toHaveBeenCalled();
  });

  it('opens a relative text file in the log viewer by its resolved path', () => {
    const { app, links } = linksOn(['tail logs/run.log'], 1);
    links[0].activate({}, links[0].text);
    expect(app.openLogViewerWindow).toHaveBeenCalledWith('/mnt/build/neon_getaway-mgr-hebel/logs/run.log', 's1');
  });

  it('never adds a path link overlapping a URL link', () => {
    const { links } = linksOn(['see https://x.io/view?img=shots/a.png now'], 1);
    expect(links.map((l) => l.text)).toEqual(['https://x.io/view?img=shots/a.png']);
  });
});

describe('server: ~/ expands on the session host', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeman-tilde-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a local session registers ~/… against this host home', async () => {
    // test/setup.ts points HOME at a temp dir, so this never touches the real home.
    const dir = join(homedir(), 'tilde-link-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shot.png'), 'PNG');
    try {
      const event = await registerExternalAttachment('tilde-session', '~/tilde-link-test/shot.png', {});
      expect(event.attachmentId).toMatch(/^att_/);
      expect(event.size).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a relative path is still refused', async () => {
    await expect(registerExternalAttachment('tilde-session', 'shots/a.png', {})).rejects.toThrow(/absolute/);
  });

  it('the remote probe expands ~/ to the remote $HOME, and reports the absolute path', () => {
    writeFileSync(join(root, 'remote.png'), 'PNGPNG');
    const requested = ['~/remote.png', '~/missing.png'];
    const stdout = execFileSync('sh', ['-c', buildRemoteProbeCommand(requested)], {
      env: { ...process.env, HOME: root },
    }).toString();
    const [found, missing] = parseRemoteProbeOutput(stdout, requested);
    expect(found).toMatchObject({ kind: 'file', size: 6 });
    expect(found?.realPath.endsWith('/remote.png')).toBe(true);
    expect(found?.realPath.startsWith('/')).toBe(true);
    expect(missing).toBeNull();
  });
});
