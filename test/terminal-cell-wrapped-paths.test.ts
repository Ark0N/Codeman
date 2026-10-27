// Port: none (pure functions + the link provider in a vm context: no browser, no server).
//
// Absolute file paths codex word-wrapped inside a markdown table cell were not
// clickable: the first fragment has no extension and the continuation has no
// absolute root, so FILE_PATH_LINK_PATTERN matched neither. In a two-column
// table both continuations sit on the same next row, so each path has to be
// followed down its OWN cell (terminalCellWrappedPaths in constants.js).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const CONSTANTS = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
const TERMINAL_UI = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

type Row = { text: string; isWrapped?: boolean };
type Hit = { path: string; segments: Array<{ row: number; startCol: number; endCol: number }> };
type Link = {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate: (event: unknown, text: string) => void;
};

const COLS = 200;

function fakeBuffer(rows: Row[], cols: number) {
  const lines = rows.map((row) => ({
    isWrapped: row.isWrapped ?? false,
    translateToString(trimRight?: boolean) {
      const padded = row.text.padEnd(cols, ' ');
      return trimRight ? padded.trimEnd() : padded;
    },
    getCell(index: number) {
      const padded = row.text.padEnd(cols, ' ');
      if (index >= padded.length) return undefined;
      return { getChars: () => (padded[index] === ' ' ? '' : padded[index]), getWidth: () => 1 };
    },
  }));
  return { length: lines.length, getLine: (i: number) => lines[i] };
}

function loadPure() {
  const context = vm.createContext({ console, window: undefined });
  vm.runInContext(`${CONSTANTS}\nglobalThis.__cell = terminalCellWrappedPaths;`, context, {
    filename: 'constants.js',
  });
  return (context as unknown as { __cell: (buffer: unknown, row: number, maxRows?: number) => Hit[] }).__cell;
}

// Shape copied from a real codex pane (synthetic paths).
const ROW1 =
  '   Before screenshot (/tmp/demo-check/docs/review/           After screenshot (/tmp/demo-check/docs/review/BLDMESH-';
const ROW2 = '   BLDMESH-243/before-overview.png)                          243/after-overview.png)';
const TABLE: Row[] = [
  { text: '   No Vision selected                                        Reprocessed' },
  { text: ROW1 },
  { text: ROW2 },
  { text: '' },
];
const LISTINGS = [
  ['/tmp/x', '/tmp/x/dir', '/tmp/x/dir/a.png'],
  ['  ⎿  /home/u/proj/src', '     /home/u/proj/src/a.ts'],
  ['4.0K    /tmp/foo/bar/', '8.0K    /tmp/foo/baz.png'],
  ['/home/u/proj/docs:', 'guide.md  notes.md'],
  ['Created /tmp/out', 'report.md written next to it'],
];

// A directory that is the whole value of its cell, over the next record's file
// name in the same column. A wrapper breaks a path after `/` or `-`, never inside
// a name, so none of these is one path: each cell keeps its own link.
const WHOLE_VALUE_SHAPES: Array<{ rows: string[]; dir: string; file: string }> = [
  { rows: ['  Repo        /home/u/proj', '  Config      config.yaml'], dir: '/home/u/proj', file: 'config.yaml' },
  {
    rows: ['  Workspace    /home/u/proj/app', '  Entry        main.py'],
    dir: '/home/u/proj/app',
    file: 'main.py',
  },
  {
    rows: ['│ Workspace │ /home/u/proj/app │', '│ Entry     │ main.py          │'],
    dir: '/home/u/proj/app',
    file: 'main.py',
  },
  { rows: ['  Output dir   /tmp/build/out', '  Log          build.log'], dir: '/tmp/build/out', file: 'build.log' },
  {
    rows: ['  Path                 Purpose', '  /home/u/proj/src     sources', '  index.ts             entry'],
    dir: '/home/u/proj/src',
    file: 'index.ts',
  },
];
// The same records where the directory DOES end on a break character: the label
// on the next row (`Entry`, `│ Helper │`) says it is a new record, since a wrapper
// wraps every column of one table row together and leaves the label cell blank.
const LABELLED_RECORD_SHAPES: Array<{ rows: string[]; dir: string; file: string }> = [
  {
    rows: ['  Workspace    /home/u/proj/app/', '  Entry        main.py'],
    dir: '/home/u/proj/app/',
    file: 'main.py',
  },
  {
    rows: ['│ Source │ /home/u/proj/src/ │', '│ Helper │ lib/util.ts       │'],
    dir: '/home/u/proj/src/',
    file: 'lib/util.ts',
  },
  { rows: ['  Prefix    /tmp/run-', '  Suffix    log.txt'], dir: '/tmp/run-', file: 'log.txt' },
];
const SEPARATE_RECORD_SHAPES = [...WHOLE_VALUE_SHAPES, ...LABELLED_RECORD_SHAPES];
// Known trade-off: with no label to tell them apart, a directory written WITH its
// trailing slash over a relative path in the same column reads exactly like a
// wrap at `/`, so it still joins.
const TRAILING_SLASH_TRADE_OFF = ['  /home/u/proj/src/     sources', '  lib/util.ts           helpers'];

const BEFORE = '/tmp/demo-check/docs/review/BLDMESH-243/before-overview.png';
const AFTER = '/tmp/demo-check/docs/review/BLDMESH-243/after-overview.png';

describe('terminalCellWrappedPaths', () => {
  const find = loadPure();

  it('joins each column’s path with its own continuation, from either row', () => {
    for (const row of [1, 2]) {
      const hits = find(fakeBuffer(TABLE, COLS), row);
      expect(hits.map((h) => h.path).sort()).toEqual([AFTER, BEFORE]);
    }
  });

  it.each(LISTINGS.map((lines) => [lines]))('does not join independent listing rows: %j', (lines) => {
    const rows = lines.map((text) => ({ text }));
    for (let row = 0; row < rows.length; row++) expect(find(fakeBuffer(rows, COLS), row)).toEqual([]);
  });

  it.each(SEPARATE_RECORD_SHAPES.map((shape) => [shape.rows, shape]))(
    'does not join a directory cell onto the next record: %j',
    (_rows, shape) => {
      const rows = shape.rows.map((text) => ({ text }));
      for (let row = 0; row < rows.length; row++) expect(find(fakeBuffer(rows, COLS), row)).toEqual([]);
    }
  );

  it('does not join a fragment that ends on `_` (codex wraps cells only after `/` or `-`)', () => {
    const rows = [{ text: '   shot (/tmp/demo/docs/review_' }, { text: '   before.png)' }];
    expect(find(fakeBuffer(rows, COLS), 0)).toEqual([]);
    expect(find(fakeBuffer(rows, COLS), 1)).toEqual([]);
  });

  it('still joins an unlabelled trailing-slash directory over a relative path in its column (known trade-off)', () => {
    const rows = TRAILING_SLASH_TRADE_OFF.map((text) => ({ text }));
    expect(find(fakeBuffer(rows, COLS), 1).map((h) => h.path)).toEqual(['/home/u/proj/src/lib/util.ts']);
  });

  it('places the segments on the path cells only', () => {
    const hits = find(fakeBuffer(TABLE, COLS), 1);
    const before = hits.find((h) => h.path === BEFORE)!;
    expect(before.segments).toEqual([
      { row: 1, startCol: ROW1.indexOf('/tmp/'), endCol: ROW1.indexOf('/review/') + '/review/'.length },
      { row: 2, startCol: 3, endCol: 3 + 'BLDMESH-243/before-overview.png'.length },
    ]);
    const after = hits.find((h) => h.path === AFTER)!;
    const afterCell = ROW1.indexOf('After');
    expect(after.segments[0]).toEqual({ row: 1, startCol: ROW1.lastIndexOf('/tmp/'), endCol: ROW1.length });
    expect(after.segments[1]).toEqual({
      row: 2,
      startCol: afterCell,
      endCol: afterCell + '243/after-overview.png'.length,
    });
  });

  it('ignores a path already complete on its row', () => {
    const rows = [{ text: '   see /tmp/demo/report.md' }, { text: '   next.md' }];
    expect(find(fakeBuffer(rows, COLS), 0)).toEqual([]);
  });

  it('does not glue unrelated text onto a path that is not followed by a matching continuation', () => {
    const rows = [{ text: '   saved under /tmp/demo/docs/' }, { text: '   then run the build' }];
    expect(find(fakeBuffer(rows, COLS), 0)).toEqual([]);
    expect(find(fakeBuffer(rows, COLS), 1)).toEqual([]);
  });

  it('does not join a continuation that is not aligned to the cell', () => {
    const rows = [{ text: '   shot (/tmp/demo/docs/review/' }, { text: '      before.png)' }];
    expect(find(fakeBuffer(rows, COLS), 0)).toEqual([]);
  });

  it('does not join across a soft wrap (the logical line owns that)', () => {
    const rows = [{ text: '   shot (/tmp/demo/docs/review/' }, { text: '   before.png', isWrapped: true }];
    expect(find(fakeBuffer(rows, COLS), 0)).toEqual([]);
  });

  it('follows a path across three rows of one cell', () => {
    const rows = [{ text: '   a (/tmp/demo/very/' }, { text: '   long/nested/' }, { text: '   file.png)' }];
    const hits = find(fakeBuffer(rows, COLS), 1);
    expect(hits.map((h) => h.path)).toEqual(['/tmp/demo/very/long/nested/file.png']);
    expect(hits[0].segments.map((s) => s.row)).toEqual([0, 1, 2]);
  });

  it('follows a path down a box-drawn table cell (Claude Code renders tables with │ borders)', () => {
    const rows = [
      { text: '│ Before         │ /tmp/demo/docs/review/ │ After │ /tmp/demo/docs/review/BLD- │' },
      { text: '│                │ before-overview.png    │       │ 243/after-overview.png     │' },
    ];
    const hits = find(fakeBuffer(rows, COLS), 1);
    expect(hits.map((h) => h.path).sort()).toEqual([
      '/tmp/demo/docs/review/BLD-243/after-overview.png',
      '/tmp/demo/docs/review/before-overview.png',
    ]);
    const before = hits.find((h) => h.path.endsWith('before-overview.png'))!;
    expect(before.segments).toEqual([
      { row: 0, startCol: rows[0].text.indexOf('/tmp/'), endCol: rows[0].text.indexOf('/review/') + 8 },
      { row: 1, startCol: rows[1].text.indexOf('before'), endCol: rows[1].text.indexOf('.png') + 4 },
    ]);
  });

  it('does not take a box border or the next cell into a path', () => {
    const rows = [{ text: '│ /tmp/demo/docs/ │ x │' }, { text: '│ │ notes.md       │ y │' }];
    expect(find(fakeBuffer(rows, COLS), 0)).toEqual([]);
  });
});

describe('terminal link provider with cell-wrapped paths', () => {
  function harness(rows: Row[]) {
    const context = vm.createContext({
      console: { ...console, debug: vi.fn(), log: vi.fn() },
      CodemanApp: class CodemanApp {},
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      setTimeout,
      clearTimeout,
      requestAnimationFrame: vi.fn(),
      document: { addEventListener: vi.fn(), getElementById: vi.fn(), documentElement: { dataset: {} } },
      window: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        open: vi.fn(),
        document: { documentElement: { dataset: {} } },
      },
    });
    vm.runInContext(`${CONSTANTS}\n${TERMINAL_UI}\nglobalThis.__proto = CodemanApp.prototype;`, context);
    const proto = (context as unknown as { __proto: Record<string, (...args: unknown[]) => unknown> }).__proto;
    let provider: { provideLinks: (line: number, cb: (links?: Link[]) => void) => void } | undefined;
    const app = {
      terminal: {
        cols: COLS,
        rows: 24,
        registerLinkProvider(value: typeof provider) {
          provider = value;
        },
        buffer: { active: { viewportY: 0, ...fakeBuffer(rows, COLS) } },
      },
      activeSessionId: 's1',
      sessions: new Map([['s1', { workingDir: '/workspace/project' }]]),
      openFilePreview: vi.fn(),
      openLogViewerWindow: vi.fn(),
      _openTerminalUrl: proto._openTerminalUrl,
      _resolveLinkedFilePath: proto._resolveLinkedFilePath,
      _isExternalPreviewPath: () => false,
      registerFilePathLinkProvider: proto.registerFilePathLinkProvider,
    };
    app.registerFilePathLinkProvider.call(app);
    const provide = (line: number): Link[] => {
      let links: Link[] | undefined;
      provider!.provideLinks(line, (value) => {
        links = value;
      });
      return links ?? [];
    };
    return { provide, app };
  }

  it.each(LISTINGS.map((lines) => [lines]))('preserves ordinary listing links: %j', (lines) => {
    const { provide } = harness(lines.map((text) => ({ text })));
    const expected = [
      ['/tmp/x', '/tmp/x/dir', '/tmp/x/dir/a.png'],
      ['/home/u/proj/src', '/home/u/proj/src/a.ts'],
      ['/tmp/foo/bar/', '/tmp/foo/baz.png'],
      ['/home/u/proj/docs', 'guide.md'],
      ['/tmp/out', 'report.md'],
    ][LISTINGS.indexOf(lines)];
    for (let row = 0; row < lines.length; row++) {
      expect(provide(row + 1).map((link) => link.text)).toContain(expected[row]);
    }
  });

  it.each(SEPARATE_RECORD_SHAPES.map((shape) => [shape.rows, shape]))(
    'keeps the folder link and the file link of the next record: %j',
    (_rows, shape) => {
      const { provide, app } = harness(shape.rows.map((text) => ({ text })));
      const dirLine = shape.rows.findIndex((text) => text.includes(shape.dir)) + 1;
      const fileLine = shape.rows.findIndex((text) => text.includes(shape.file)) + 1;
      const all = [...provide(dirLine), ...provide(fileLine)].map((link) => link.text);
      expect(all.some((text) => text.includes(shape.dir + shape.file))).toBe(false);
      const dirLink = provide(dirLine).find((link) => link.text === shape.dir);
      expect(dirLink, `${shape.dir} on row ${dirLine}`).toBeDefined();
      expect(dirLink!.range.start.y).toBe(dirLine);
      const fileLink = provide(fileLine).find((link) => link.text === shape.file);
      expect(fileLink, `${shape.file} on row ${fileLine}`).toBeDefined();
      expect(fileLink!.range.start.y).toBe(fileLine);
      fileLink!.activate(null, fileLink!.text);
      expect(app.openFilePreview).not.toHaveBeenCalledWith(shape.dir + shape.file, 's1');
    }
  );

  it('makes both screenshot paths clickable from either row and opens the whole path', () => {
    const { provide, app } = harness(TABLE);
    for (const line of [2, 3]) {
      const links = provide(line);
      for (const target of [BEFORE, AFTER]) {
        const onRow = links.find((l) => l.text === target && l.range.start.y === line);
        expect(onRow, `${target} on row ${line}`).toBeDefined();
        onRow!.activate(null, onRow!.text);
        expect(app.openFilePreview).toHaveBeenLastCalledWith(target, 's1');
      }
    }
  });

  it('leaves no fragment link that would open a partial path', () => {
    const { provide } = harness(TABLE);
    for (const line of [2, 3]) {
      for (const link of provide(line)) expect([BEFORE, AFTER]).toContain(link.text);
    }
  });
});
