// Port: none (pure functions + the link provider in a vm context: no browser, no server).
//
// Terminal URL links that stopped short.
//
// 1. `)` ended every URL, so a path like `…/Team-Space(QA)Archive/…` linked only as
//    far as `(QA`. The grammar now keeps a `)` that closes a `(` inside the URL and
//    still leaves out the closing paren of `(https://…)` / `[text](https://…)`.
// 2. A CLI that word-wraps inside a table cell (codex) breaks a long URL at `/`, `?`,
//    `-` well short of the right edge and indents the rest to the cell's column.
//    Nothing is `isWrapped` and no row is full width, so each row linked a fragment.
//
// All URLs here are synthetic (example.com); none come from real output.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const CONSTANTS = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
const TERMINAL_UI = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

type UrlRef = { url: string; startIndex: number; endIndex: number; rawEnd: number };
type Extent = { startRow: number; endRow: number } | null;
type Row = { text: string; isWrapped?: boolean };
type Link = {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate: (event: unknown, text: string) => void;
};

function loadPure() {
  const context = vm.createContext({ console, window: undefined });
  vm.runInContext(
    `${CONSTANTS}\nglobalThis.__urls = findTerminalUrls; globalThis.__extent = terminalUrlContinuationExtent; globalThis.__logical = terminalLogicalLine; globalThis.__linkLine = terminalLinkLine;`,
    context,
    { filename: 'constants.js' }
  );
  const ctx = context as unknown as {
    __urls: (text: string) => UrlRef[];
    __extent: (buffer: unknown, row: number, cols: number, maxRows?: number) => Extent;
    __logical: (buffer: unknown, row: number, cols: number, maxRows?: number) => Extent;
    __linkLine: (buffer: unknown, row: number, cols: number, maxRows?: number) => LinkLine | null;
  };
  return {
    findTerminalUrls: ctx.__urls,
    terminalUrlContinuationExtent: ctx.__extent,
    terminalLogicalLine: ctx.__logical,
    terminalLinkLine: ctx.__linkLine,
  };
}

type LinkLine = {
  startRow: number;
  endRow: number;
  text: string;
  offsetToCell: (offset: number) => { row: number; col: number };
  cellToOffset: (row: number, col: number) => number;
};

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

// A codex-style markdown table row: number, reason, then a `name (url)` cell whose
// URL the CLI wrapped across three rows, each continuation indented to the cell.
const URL =
  'https://docs.example.com/sites/Team-Space(QA)Archive/_layouts/15/Doc.aspx?' +
  'sourcedoc=%7B11111111-2222-3333-4444-555555555555%7D&file=Quarterly%20Plan%20(Draft).xlsx&action=default&' +
  'mobileredirect=true';
const CELL = 26;
const TABLE: Row[] = [
  { text: '  11   Unrelated row         plain text only' },
  {
    text: '  12   New to trending       Quarterly Plan.xlsx (https://docs.example.com/sites/Team-Space(QA)Archive/_layouts/15/Doc.aspx?',
  },
  {
    text:
      ' '.repeat(CELL) +
      'sourcedoc=%7B11111111-2222-3333-4444-555555555555%7D&file=Quarterly%20Plan%20(Draft).xlsx&action=default&',
  },
  { text: ' '.repeat(CELL) + 'mobileredirect=true)' },
  { text: '  13   Next row              another cell' },
];
const COLS = 160;
const TABLE_CELL_START = TABLE[1].text.indexOf('Quarterly');
const TABLE_WITH_TRAILING_COLUMNS: Row[] = [
  TABLE[0],
  {
    text: TABLE[1].text + '           2026-09-16 18:00:54    Document Owner',
  },
  { text: ' '.repeat(TABLE_CELL_START) + TABLE[2].text.slice(CELL) },
  { text: ' '.repeat(TABLE_CELL_START) + TABLE[3].text.slice(CELL) },
  TABLE[4],
];
const TABLE_COLS = 220;
// A wrapped URL with another column to its right. The URL's first row is cut at
// its cell to stitch the URL, and the column after it must still link on that
// row (a release-review regression: only the URL's pieces were offered there).
const WIKI_URL = 'https://wiki.example.com/spaces/ENG/pages/12345/Design-Spec-v2';
const URL_THEN_PATH_COLS = 140;
const URL_THEN_PATH_ROWS: Row[] = [
  { text: '  1   Design spec     https://wiki.example.com/spaces/ENG/pages/12345/      /home/me/proj/docs/design.md' },
  { text: '                      Design-Spec-v2' },
  { text: '  2   Notes           n/a                                                     /home/me/proj/notes.md' },
];
// The same shape with a relative and a home path in the columns after the URL.
const URL_THEN_PATHS_ROWS: Row[] = [
  {
    text: '  1   Design spec     https://wiki.example.com/spaces/ENG/pages/12345/      docs/design.md    ~/notes/todo.txt',
  },
  { text: '                      Design-Spec-v2' },
];
// A URL in the column after the wrapped one is the row's LAST URL, and only the
// last URL on a row is continued, so this row is never stitched or cut: both URLs
// link on row 1 as single-row links, as before the wrap joining existed.
const URL_THEN_URL_ROWS: Row[] = [
  {
    text: '  1   Design spec     https://wiki.example.com/spaces/ENG/pages/12345/      https://other.example.com/notes.md',
  },
  { text: '                      Design-Spec-v2' },
];
const PROSE_ROWS = [
  [
    '⏺ The guide lives at https://example.com/guide/',
    '  self-hosted runners need a token first.',
    'https://example.com/guide/',
  ],
  ['Docs: https://example.com/guide/', 'Self-hosting is covered in chapter 3.', 'https://example.com/guide/'],
  ['Open http://localhost:3000/', 'e.g. to check the dashboard', 'http://localhost:3000/'],
  ['Endpoint https://api.example.com/v1/', 'user_id is required', 'https://api.example.com/v1/'],
  ['Repo: https://github.com/org/repo/', 'well-known issues are tracked', 'https://github.com/org/repo/'],
  ['Callback https://example.com/cb?code=', 'Re-run the login', 'https://example.com/cb?code='],
  ['Branch https://github.com/o/r/tree/feat-', 'x.y happened', 'https://github.com/o/r/tree/feat-'],
];
// Rows that carry URL punctuation but are never the rest of the URL above them:
// a shell prompt, an HTTP status line, a home path, and column-0 prose. Each
// third element is the URL, the fourth the path link expected on the second row.
const NOT_CONTINUATION_ROWS: [string, string, string, string | null][] = [
  ['https://registry.npmjs.org/', 'arkon@box:~/proj$', 'https://registry.npmjs.org/', '~/proj'],
  ['https://pypi.org/simple/', 'dev@laptop:/srv/app$', 'https://pypi.org/simple/', '/srv/app'],
  ['$ curl -sI https://example.com/', 'HTTP/2 200', 'https://example.com/', null],
  ['$ curl -i http://localhost:3000/api/', 'HTTP/1.1 200 OK', 'http://localhost:3000/api/', null],
  ['Docs: https://example.com/guide/', '~/notes.md has more', 'https://example.com/guide/', '~/notes.md'],
  ['fetch https://api.example.com/items/', 'status=200 took=12ms', 'https://api.example.com/items/', null],
  ['Status page: https://status.example.com/', '24/7 monitoring is on.', 'https://status.example.com/', null],
  ['Did you mean https://example.com/search?q=', 'really? no.', 'https://example.com/search?q=', null],
];
// The last column of a space-aligned table: the next row opens the next record
// in an earlier column, so its first cell is never the rest of the URL. Each
// row is indented two spaces. The URL on each row, then any path link expected
// on the second row.
const TABLE_LAST_COLUMN_ROWS: [string, string, string, string, string | null][] = [
  [
    '  auth-api        https://auth.example.com/',
    '  billing-api     https://billing.example.com/',
    'https://auth.example.com/',
    'https://billing.example.com/',
    null,
  ],
  [
    '  docs.example.com     https://docs.example.com/',
    '  api.example.com      https://api.example.com/',
    'https://docs.example.com/',
    'https://api.example.com/',
    null,
  ],
  [
    '  Homepage:      https://example.com/',
    '  Bug-reports:   https://github.com/org/repo/issues/',
    'https://example.com/',
    'https://github.com/org/repo/issues/',
    null,
  ],
  [
    '  user_service    https://users.example.com/v1/',
    '  order_service   https://orders.example.com/v1/',
    'https://users.example.com/v1/',
    'https://orders.example.com/v1/',
    null,
  ],
  [
    '  README.md       https://example.com/docs/',
    '  CHANGELOG.md    https://example.com/changes/',
    'https://example.com/docs/',
    'https://example.com/changes/',
    'CHANGELOG.md',
  ],
  [
    '  my-service-   https://svc.example.com/api/',
    '  long-name     https://svc2.example.com/',
    'https://svc.example.com/api/',
    'https://svc2.example.com/',
    null,
  ],
];
// Known trade-offs: a row end counts as a cell end, so a short indented word
// with URL punctuation still continues the URL. Pinned so a change is deliberate.
const TRADE_OFF_ROWS: [string, string, string][] = [
  ['⏺ Docs live at https://example.com/guide/', '  self-hosted', 'https://example.com/guide/self-hosted'],
  [
    '⏺ The docs are at https://example.com/guide/',
    '  and/or the API reference covers it.',
    'https://example.com/guide/and/or',
  ],
];

// Indented rows under a URL ending in `/` that carry URL punctuation but are
// code, a label, a `name=value` field, a measurement or a clock time, or a word
// ending a sentence. Each third element is the URL on the first row.
const FIELD_AND_CODE_ROWS: [string, string, string][] = [
  ['  └ Listening on http://127.0.0.1:8080/', '    ready.', 'http://127.0.0.1:8080/'],
  ['⏺ Deployed to https://app.example.com/', '  Done.', 'https://app.example.com/'],
  ['⏺ Docs live at https://example.com/guide/', '  self-hosted.', 'https://example.com/guide/'],
  ['  Fetching https://example.com/files/', '  done...', 'https://example.com/files/'],
  [
    '  ● fetch › handles https://api.example.com/v1/',
    '    expect(received).toBe(expected)',
    'https://api.example.com/v1/',
  ],
  ['  See https://example.com/api/', '  client.get()', 'https://example.com/api/'],
  [
    '/home/u/.venv/lib/urllib3/__init__.py:35: Warning: see https://github.com/urllib3/urllib3/issues/',
    '  warnings.warn(',
    'https://github.com/urllib3/urllib3/issues/',
  ],
  [
    '  1) Client fetches https://api.example.com/v1/',
    '     Failure/Error: expect(res.code).to eq(200)',
    'https://api.example.com/v1/',
  ],
  [
    'Annotations:  link.argocd.argoproj.io/external-link: https://grafana.example.com/d/',
    '              prometheus.io/scrape: true',
    'https://grafana.example.com/d/',
  ],
  ['  BASE_URL=https://api.example.com/', '  API_KEY=your-key-here', 'https://api.example.com/'],
  ['  AUTH_URL=https://auth.example.com/', '  LOG_LEVEL=debug', 'https://auth.example.com/'],
  [
    '     level=info msg="request" url=https://api.example.com/v1/',
    '     level=info msg="done" status=200',
    'https://api.example.com/v1/',
  ],
  ['     url=https://api.example.com/v1/', '     request_id=abc-123', 'https://api.example.com/v1/'],
  [
    '  Callback: https://example.com/oauth/callback/',
    '  state=abc123 must match',
    'https://example.com/oauth/callback/',
  ],
  [
    '  Downloading https://huggingface.co/org/model/resolve/main/',
    '  45%|████▌     | 450M/1.00G [00:10<00:12, 45.0MB/s]',
    'https://huggingface.co/org/model/resolve/main/',
  ],
  ['  Downloading https://example.com/files/', '  12.3MB/45.0MB', 'https://example.com/files/'],
  ['  GET https://example.com/api/', '  12.3ms', 'https://example.com/api/'],
  ['  https://example.com/blog/', '  10:00:00.123', 'https://example.com/blog/'],
];
// Continuations at the edge of those rules that are still the rest of the URL:
// a wiki title with parens, a file name before a sentence period, a query
// parameter after `?`, `&` or `_`, and percent-encoding that starts with digits.
const STILL_CONTINUES_ROWS: [string, string, string][] = [
  ['  https://en.wikipedia.org/wiki/', '  Mercury_(planet)', 'https://en.wikipedia.org/wiki/Mercury_(planet)'],
  ['⏺ The guide is at https://example.com/docs/', '  install.html.', 'https://example.com/docs/install.html'],
  ['  https://example.com/oauth?client_', '  id=abc&scope=read', 'https://example.com/oauth?client_id=abc&scope=read'],
  ['  https://example.com/cb?code=abc&', '  state=xyz', 'https://example.com/cb?code=abc&state=xyz'],
  ['  Docs: https://example.com/guide?', '  x=1&y=2 more text', 'https://example.com/guide?x=1&y=2'],
  ['  https://example.com/files/', '  2026%20Plan.xlsx', 'https://example.com/files/2026%20Plan.xlsx'],
];
// A URL row that soft-wraps at 41 columns with a table column on its wrapped
// part, over an indented row: the column and that row are separate links, never
// one glued `/tmp/report.txtccc/x.html`.
const SOFT_WRAP_COLS = 41;
const SOFT_WRAPPED_URL_ROWS: Row[] = [
  { text: '  Doc  https://example.com/aaaaaaaaaaaaaa' },
  { text: 'bbb/    /tmp/report.txt', isWrapped: true },
  { text: '       ccc/x.html' },
];

describe('findTerminalUrls (grammar)', () => {
  const { findTerminalUrls } = loadPure();
  const urls = (text: string) => findTerminalUrls(text).map((u) => u.url);

  it('keeps a paren pair that is part of the URL', () => {
    expect(urls('see https://example.com/wiki/Widget_(tool) now')).toEqual(['https://example.com/wiki/Widget_(tool)']);
    expect(urls('https://example.com/Team-Space(QA)Archive/x')).toEqual([
      'https://example.com/Team-Space(QA)Archive/x',
    ]);
  });

  it('leaves out the paren that wraps the URL', () => {
    expect(urls('(https://example.com/a(b)c)')).toEqual(['https://example.com/a(b)c']);
    expect(urls('file (https://example.com/doc?x=1).')).toEqual(['https://example.com/doc?x=1']);
  });

  it('leaves out the closing paren of a markdown link', () => {
    expect(urls('[the docs](https://example.com/docs?a=1&b=2) for details')).toEqual([
      'https://example.com/docs?a=1&b=2',
    ]);
  });

  it('still keeps query ampersands and stops at the shell &&', () => {
    expect(urls('open https://example.com/p?post=1&action=edit&& echo done')).toEqual([
      'https://example.com/p?post=1&action=edit',
    ]);
  });

  it('trims trailing sentence punctuation', () => {
    expect(urls('Go to https://example.com/path.')).toEqual(['https://example.com/path']);
    expect(urls('Is it https://example.com/q?')).toEqual(['https://example.com/q']);
  });

  it('reports where the raw match ended before trimming', () => {
    const [ref] = findTerminalUrls('x https://example.com/a) y');
    expect(ref.url).toBe('https://example.com/a');
    expect(ref.rawEnd).toBe('x https://example.com/a)'.length);
  });
});

describe('terminalUrlContinuationExtent (wrap joining)', () => {
  const { terminalUrlContinuationExtent, terminalLogicalLine } = loadPure();

  it('spans all three rows of a URL wrapped inside a table cell, from any of them', () => {
    const buffer = fakeBuffer(TABLE, COLS);
    for (const row of [1, 2, 3]) {
      expect(terminalUrlContinuationExtent(buffer, row, COLS, 12)).toEqual({ startRow: 1, endRow: 3 });
    }
  });

  it('spans a table URL even when date and owner columns follow its first fragment', () => {
    const buffer = fakeBuffer(TABLE_WITH_TRAILING_COLUMNS, TABLE_COLS);
    for (const row of [1, 2, 3]) {
      expect(terminalUrlContinuationExtent(buffer, row, TABLE_COLS, 12)).toMatchObject({ startRow: 1, endRow: 3 });
    }
  });

  it('starts at the URL row when a full-width table divider precedes it', () => {
    const rows = [{ text: '─'.repeat(TABLE_COLS) }, ...TABLE_WITH_TRAILING_COLUMNS.slice(1, 4)];
    const buffer = fakeBuffer(rows, TABLE_COLS);
    for (const row of [1, 2, 3]) {
      expect(terminalUrlContinuationExtent(buffer, row, TABLE_COLS, 12)).toMatchObject({ startRow: 1, endRow: 3 });
    }
  });

  it('does not treat the next numbered table row as a URL continuation', () => {
    const rows = [TABLE_WITH_TRAILING_COLUMNS[1], { text: '  13   New to trending       Another document' }];
    const buffer = fakeBuffer(rows, TABLE_COLS);
    expect(terminalUrlContinuationExtent(buffer, 0, TABLE_COLS, 12)).toBeNull();
    expect(terminalUrlContinuationExtent(buffer, 1, TABLE_COLS, 12)).toBeNull();
  });

  it('leaves the neighbouring table rows alone', () => {
    const buffer = fakeBuffer(TABLE, COLS);
    expect(terminalUrlContinuationExtent(buffer, 0, COLS, 12)).toBeNull();
    expect(terminalUrlContinuationExtent(buffer, 4, COLS, 12)).toBeNull();
  });

  it.each([
    ['1. https://example.com/one/', '2. https://example.com/two/'],
    ['Docs: https://docs.example.com/guide/', '1. Install the package'],
    ['Fetching https://registry.example.com/pkg/', 'v1.2.3 is the latest'],
    ['GET http://localhost:3000/api/', '200 OK in 12ms'],
  ])('keeps list, version and status rows separate after %s', (first, next) => {
    const buffer = fakeBuffer([{ text: first }, { text: next }], 100);
    for (const row of [0, 1]) expect(terminalUrlContinuationExtent(buffer, row, 100, 12)).toBeNull();
  });

  it.each(PROSE_ROWS)('does not join prose after %s', (first, next) => {
    const buffer = fakeBuffer([{ text: first }, { text: next }], 100);
    for (const row of [0, 1]) expect(terminalUrlContinuationExtent(buffer, row, 100, 12)).toBeNull();
  });

  it.each(NOT_CONTINUATION_ROWS)('does not join a prompt, status line, home path or prose after %s', (first, next) => {
    const buffer = fakeBuffer([{ text: first }, { text: next }], 100);
    for (const row of [0, 1]) expect(terminalUrlContinuationExtent(buffer, row, 100, 12)).toBeNull();
  });

  // Indented, so only the prompt / home path / status-line rule can refuse them.
  it.each(['arkon@box:~/proj$', 'dev@laptop:/srv/app$', '~/notes.md', 'HTTP/2 200', 'HTTP/1.1 200 OK'])(
    'does not join an indented %s either',
    (next) => {
      const buffer = fakeBuffer([{ text: 'Docs: https://example.com/guide/' }, { text: '  ' + next }], 100);
      for (const row of [0, 1]) expect(terminalUrlContinuationExtent(buffer, row, 100, 12)).toBeNull();
    }
  );

  it.each(TABLE_LAST_COLUMN_ROWS)('does not join the next table record after %s', (first, next) => {
    const buffer = fakeBuffer([{ text: first }, { text: next }], 100);
    for (const row of [0, 1]) expect(terminalUrlContinuationExtent(buffer, row, 100, 12)).toBeNull();
  });

  it.each(FIELD_AND_CODE_ROWS)(
    'does not join code, a field, a measurement or a sentence end after %s',
    (first, next) => {
      const buffer = fakeBuffer([{ text: first }, { text: next }], 100);
      for (const row of [0, 1]) expect(terminalUrlContinuationExtent(buffer, row, 100, 12)).toBeNull();
    }
  );

  it.each(STILL_CONTINUES_ROWS)('still joins the continuation after %s', (first, next) => {
    const buffer = fakeBuffer([{ text: first }, { text: next }], 100);
    for (const row of [0, 1])
      expect(terminalUrlContinuationExtent(buffer, row, 100, 12)).toMatchObject({ startRow: 0, endRow: 1 });
  });

  it('does not join an indented email address', () => {
    const buffer = fakeBuffer([{ text: '  https://example.com/' }, { text: '  user@example.com' }], 100);
    for (const row of [0, 1]) expect(terminalUrlContinuationExtent(buffer, row, 100, 12)).toBeNull();
  });

  it.each(TRADE_OFF_ROWS)('still joins the known trade-off after %s', (first, next) => {
    const buffer = fakeBuffer([{ text: first }, { text: next }], 100);
    for (const row of [0, 1])
      expect(terminalUrlContinuationExtent(buffer, row, 100, 12)).toMatchObject({ startRow: 0, endRow: 1 });
  });

  it('does not let a URL at the right edge absorb a full-width divider row below it', () => {
    const cols = 40;
    const url = 'https://example.com/' + 'a'.repeat(cols - 'https://example.com/'.length);
    for (const divider of ['─'.repeat(cols), '-'.repeat(cols)]) {
      const buffer = fakeBuffer([{ text: url }, { text: divider }, { text: 'next' }], cols);
      expect(terminalLogicalLine(buffer, 0, cols, 12)).toMatchObject({ startRow: 0, endRow: 0 });
      expect(terminalLogicalLine(buffer, 1, cols, 12)).toMatchObject({ startRow: 1 });
    }
  });

  // Real continuations are indented (codex cells, Claude's two-space paragraph
  // indent); a column-0 row is refused, so these fixtures are indented.
  it.each(['my-post-title', 'user_id', 'x.html', 'my-post-title   ', 'my-post-title  Other column'])(
    'keeps a weak-punctuation continuation that ends its cell: %s',
    (next) => {
      const buffer = fakeBuffer([{ text: 'Docs: https://example.com/guide/' }, { text: '  ' + next }], 100);
      for (const row of [0, 1])
        expect(terminalUrlContinuationExtent(buffer, row, 100, 12)).toMatchObject({ startRow: 0, endRow: 1 });
    }
  );

  it.each(['part%20two', 'path/slug', 'query?x=1'])('keeps stronger URL punctuation followed by prose: %s', (token) => {
    const buffer = fakeBuffer(
      [{ text: 'Docs: https://example.com/guide/' }, { text: '  ' + token + ' more text' }],
      100
    );
    expect(terminalUrlContinuationExtent(buffer, 0, 100, 12)).toMatchObject({ startRow: 0, endRow: 1 });
  });

  it('does not glue a following prose line onto a URL that ends a line', () => {
    const buffer = fakeBuffer(
      [{ text: 'Download from https://example.com/files/' }, { text: 'then run the installer' }],
      80
    );
    expect(terminalUrlContinuationExtent(buffer, 0, 80, 12)).toBeNull();
    expect(terminalUrlContinuationExtent(buffer, 1, 80, 12)).toBeNull();
  });

  it('does not join a second URL on the next row', () => {
    const buffer = fakeBuffer([{ text: '- https://example.com/one/' }, { text: '  https://example.com/two' }], 80);
    expect(terminalUrlContinuationExtent(buffer, 0, 80, 12)).toBeNull();
  });

  it('does not join a row indented to the right of where the URL started', () => {
    const buffer = fakeBuffer([{ text: 'x https://example.com/a/b?' }, { text: '          q=1&r=2' }], 80);
    expect(terminalUrlContinuationExtent(buffer, 0, 80, 12)).toBeNull();
  });

  it('does not join when the URL line ends on a character a wrapper would not break after', () => {
    const buffer = fakeBuffer([{ text: 'see https://example.com/page' }, { text: 'v2-notes.txt follows' }], 80);
    expect(terminalUrlContinuationExtent(buffer, 0, 80, 12)).toBeNull();
  });

  it('stays within the row bound', () => {
    const rows: Row[] = [{ text: 'u https://example.com/' }];
    for (let i = 0; i < 20; i++) rows.push({ text: `  seg${i}-` });
    const extent = terminalUrlContinuationExtent(fakeBuffer(rows, 80), 0, 80, 5);
    expect(extent).not.toBeNull();
    expect(extent!.endRow - extent!.startRow + 1).toBeLessThanOrEqual(5);
  });

  it('does not continue a URL whose row soft-wraps with a column on the wrapped part', () => {
    const buffer = fakeBuffer(SOFT_WRAPPED_URL_ROWS, SOFT_WRAP_COLS);
    for (const row of [0, 1, 2]) {
      expect(terminalUrlContinuationExtent(buffer, row, SOFT_WRAP_COLS, 12)).toBeNull();
    }
  });
});

describe('terminalLinkLine (the text the provider scans)', () => {
  const { terminalLinkLine } = loadPure();

  it('keeps the columns after a wrapped URL, mapped back to their own cells', () => {
    const buffer = fakeBuffer(URL_THEN_PATH_ROWS, URL_THEN_PATH_COLS);
    const row = URL_THEN_PATH_ROWS[0].text;
    const pathCol = row.indexOf('/home/');
    const urlCol = row.indexOf('https://');
    for (const hovered of [0, 1]) {
      const line = terminalLinkLine(buffer, hovered, URL_THEN_PATH_COLS, 12)!;
      expect(line).toMatchObject({ startRow: 0, endRow: 1 });
      // The URL reads whole, and the path column follows it.
      expect(line.text).toContain(WIKI_URL);
      const pathOffset = line.text.indexOf('/home/me/proj/docs/design.md');
      expect(pathOffset).toBeGreaterThan(line.text.indexOf(WIKI_URL));
      expect(line.offsetToCell(pathOffset)).toEqual({ row: 0, col: pathCol });
      expect(line.cellToOffset(0, pathCol)).toBe(pathOffset);
      expect(line.cellToOffset(0, urlCol)).toBe(line.text.indexOf(WIKI_URL));
      // The end of the URL's last row still maps onto that row, never onto the
      // first cell of the column moved after it.
      const urlEnd = line.text.indexOf(WIKI_URL) + WIKI_URL.length;
      expect(line.offsetToCell(urlEnd)).toEqual({ row: 1, col: URL_THEN_PATH_ROWS[1].text.length });
    }
  });
});

describe('native OSC 8 terminal URLs', () => {
  it('opens complete HTTP links through the terminal opener and rejects unsafe schemes', () => {
    const open = vi.fn();
    const confirm = vi.fn(() => true);
    const context = vm.createContext({
      console,
      CodemanApp: class CodemanApp {},
      document: { addEventListener: vi.fn() },
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm },
    });
    vm.runInContext(`${CONSTANTS}\n${TERMINAL_UI}\nglobalThis.__proto = CodemanApp.prototype;`, context);
    const proto = (
      context as unknown as {
        __proto: { _terminalOsc8LinkHandler: () => { activate: (event: unknown, url: string) => void } };
      }
    ).__proto;
    const handler = proto._terminalOsc8LinkHandler.call({ _openTerminalUrl: open });
    const url = 'https://docs.example.com/Doc.aspx?file=Q3%20Plan&action=default&mobileredirect=true';
    handler.activate(null, url);
    expect(open).toHaveBeenCalledExactlyOnceWith(url);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(`Open this link?\n\n${url}`);
    confirm.mockReturnValue(false);
    handler.activate(null, 'http://localhost:3000/private');
    expect(confirm).toHaveBeenLastCalledWith('Open this link?\n\nhttp://localhost:3000/private');
    expect(open).toHaveBeenCalledTimes(1);
    for (const unsafe of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd']) {
      handler.activate(null, unsafe);
    }
    expect(open).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe('terminal link provider with wrapped table URLs', () => {
  function harness(rows: Row[], cols: number) {
    const openSpy = vi.fn();
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
        open: openSpy,
        document: { documentElement: { dataset: {} } },
      },
    });
    vm.runInContext(`${CONSTANTS}\n${TERMINAL_UI}\nglobalThis.__proto = CodemanApp.prototype;`, context);
    const proto = (context as unknown as { __proto: Record<string, (...args: unknown[]) => unknown> }).__proto;
    let provider: { provideLinks: (line: number, cb: (links?: Link[]) => void) => void } | undefined;
    const app = {
      terminal: {
        cols,
        rows: 24,
        registerLinkProvider(value: typeof provider) {
          provider = value;
        },
        buffer: { active: { viewportY: 0, ...fakeBuffer(rows, cols) } },
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
    return { provide, openSpy, app };
  }

  it.each(PROSE_ROWS)('preserves the original clickable URL before prose: %s', (first, next, url) => {
    const { provide, openSpy } = harness([{ text: first }, { text: next }], 100);
    const links = provide(1).filter((link) => /^https?:/.test(link.text));
    expect(links.map((link) => link.text)).toEqual([url]);
    links[0].activate(null, links[0].text);
    expect(openSpy).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer');
    expect(provide(2).filter((link) => /^https?:/.test(link.text))).toEqual([]);
  });

  it.each(NOT_CONTINUATION_ROWS)('keeps the URL and the second row separate: %s', (first, next, url, pathOnNext) => {
    const { provide, openSpy } = harness([{ text: first }, { text: next }], 100);
    const links = provide(1).filter((link) => /^https?:/.test(link.text));
    expect(links.map((link) => link.text)).toEqual([url]);
    links[0].activate(null, links[0].text);
    expect(openSpy).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer');
    const second = provide(2);
    expect(second.filter((link) => /^https?:/.test(link.text))).toEqual([]);
    if (pathOnNext) expect(second.map((link) => link.text)).toContain(pathOnNext);
  });

  it.each(TABLE_LAST_COLUMN_ROWS)(
    'keeps each last-column URL on its own row: %s',
    (first, next, url, nextUrl, pathOnNext) => {
      const { provide, openSpy } = harness([{ text: first }, { text: next }], 100);
      const links = provide(1).filter((link) => /^https?:/.test(link.text));
      expect(links.map((link) => link.text)).toEqual([url]);
      links[0].activate(null, links[0].text);
      expect(openSpy).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer');
      const second = provide(2);
      expect(second.filter((link) => /^https?:/.test(link.text)).map((link) => link.text)).toEqual([nextUrl]);
      if (pathOnNext) expect(second.map((link) => link.text)).toContain(pathOnNext);
    }
  );

  it.each(FIELD_AND_CODE_ROWS)(
    'keeps code, a field, a measurement or a sentence end separate: %s',
    (first, next, url) => {
      const { provide, openSpy } = harness([{ text: first }, { text: next }], 100);
      const links = provide(1).filter((link) => /^https?:/.test(link.text));
      expect(links.map((link) => link.text)).toEqual([url]);
      links[0].activate(null, links[0].text);
      expect(openSpy).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer');
      expect(provide(2).filter((link) => /^https?:/.test(link.text))).toEqual([]);
    }
  );

  it.each(STILL_CONTINUES_ROWS)('links the whole URL from both rows after %s', (first, next, joined) => {
    const { provide, openSpy } = harness([{ text: first }, { text: next }], 100);
    for (const line of [1, 2]) {
      // One link per row the URL covers, each opening the whole URL.
      const links = provide(line).filter((link) => /^https?:/.test(link.text));
      expect(new Set(links.map((link) => link.text))).toEqual(new Set([joined]));
    }
    const [link] = provide(2).filter((l) => /^https?:/.test(l.text));
    link.activate(null, link.text);
    expect(openSpy).toHaveBeenCalledExactlyOnceWith(joined, '_blank', 'noopener,noreferrer');
  });

  it('keeps an indented email address out of the URL above it', () => {
    const { provide } = harness([{ text: '  https://example.com/' }, { text: '  user@example.com' }], 100);
    expect(
      provide(1)
        .filter((link) => /^https?:/.test(link.text))
        .map((link) => link.text)
    ).toEqual(['https://example.com/']);
    expect(provide(2).filter((link) => /^https?:/.test(link.text))).toEqual([]);
  });

  it.each(TRADE_OFF_ROWS)('pins the known trade-off link after %s', (first, next, joined) => {
    const { provide } = harness([{ text: first }, { text: next }], 100);
    for (const line of [1, 2]) {
      const links = provide(line).filter((link) => /^https?:/.test(link.text));
      expect(links.map((link) => link.text)).toContain(joined);
    }
  });

  it('keeps a full-width divider row out of a URL that reaches the right edge', () => {
    const cols = 40;
    const url = 'https://example.com/' + 'a'.repeat(cols - 'https://example.com/'.length);
    for (const divider of ['─'.repeat(cols), '-'.repeat(cols)]) {
      const { provide } = harness([{ text: url }, { text: divider }], cols);
      expect(
        provide(1)
          .filter((link) => /^https?:/.test(link.text))
          .map((link) => link.text)
      ).toEqual([url]);
      expect(provide(2).filter((link) => /^https?:/.test(link.text))).toEqual([]);
    }
  });

  it('opens the whole URL from any of its rows', () => {
    const { provide, openSpy } = harness(TABLE, COLS);
    for (const line of [2, 3, 4]) {
      const urlLinks = provide(line).filter((link) => link.text.startsWith('https://'));
      expect(urlLinks.length).toBeGreaterThan(0);
      for (const link of urlLinks) expect(link.text).toBe(URL);
      const onRow = urlLinks.find((link) => link.range.start.y === line);
      expect(onRow).toBeDefined();
      onRow!.activate(null, onRow!.text);
      expect(openSpy).toHaveBeenLastCalledWith(URL, '_blank', 'noopener,noreferrer');
    }
  });

  it('opens the whole table URL without including the adjacent date and owner columns', () => {
    const { provide, openSpy } = harness(TABLE_WITH_TRAILING_COLUMNS, TABLE_COLS);
    for (const line of [2, 3, 4]) {
      const links = provide(line).filter((link) => link.text.startsWith('https://'));
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(link.text).toBe(URL);
      links[0].activate(null, links[0].text);
      expect(openSpy).toHaveBeenLastCalledWith(URL, '_blank', 'noopener,noreferrer');
    }
    const firstRowLink = provide(2).find((link) => link.text === URL && link.range.start.y === 2);
    expect(firstRowLink?.range.end.x).toBe(TABLE[1].text.length);
  });

  it('opens every segment after a full-width table divider', () => {
    const rows = [{ text: '─'.repeat(TABLE_COLS) }, ...TABLE_WITH_TRAILING_COLUMNS.slice(1, 4)];
    const { provide, openSpy } = harness(rows, TABLE_COLS);
    for (const line of [2, 3, 4]) {
      const link = provide(line).find((item) => item.text === URL && item.range.start.y === line);
      expect(link).toBeDefined();
      link!.activate(null, link!.text);
      expect(openSpy).toHaveBeenLastCalledWith(URL, '_blank', 'noopener,noreferrer');
    }
  });

  it('links the path in the column right of a wrapped URL on the URL first row', () => {
    const { provide, app } = harness(URL_THEN_PATH_ROWS, URL_THEN_PATH_COLS);
    const pathStart = URL_THEN_PATH_ROWS[0].text.indexOf('/home/');
    const links = provide(1);
    const path = links.find((link) => link.text === '/home/me/proj/docs/design.md');
    expect(path).toBeDefined();
    expect(path!.range.start).toEqual({ x: pathStart + 1, y: 1 });
    expect(path!.range.end.y).toBe(1);
    // The stitched URL keeps one link per row, and its first-row piece ends
    // before the path's column.
    const urlPieces = links.filter((link) => /^https?:/.test(link.text));
    expect(new Set(urlPieces.map((link) => link.text))).toEqual(new Set([WIKI_URL]));
    expect(urlPieces.map((link) => link.range.start.y)).toEqual([1, 2]);
    expect(urlPieces[0].range.end.x).toBeLessThan(pathStart + 1);
    // Nothing else is linked, so nothing glues the column onto the URL.
    expect(links.map((link) => link.text).sort()).toEqual([WIKI_URL, WIKI_URL, '/home/me/proj/docs/design.md'].sort());
    path!.activate(null, path!.text);
    expect(app.openFilePreview).toHaveBeenCalledExactlyOnceWith('/home/me/proj/docs/design.md', 's1');
    // The URL's second row still opens the whole URL, and the next record keeps its path.
    expect(
      new Set(
        provide(2)
          .filter((link) => /^https?:/.test(link.text))
          .map((link) => link.text)
      )
    ).toEqual(new Set([WIKI_URL]));
    expect(provide(3).map((link) => link.text)).toContain('/home/me/proj/notes.md');
  });

  it('links a relative and a home path in the columns right of a wrapped URL', () => {
    const { provide } = harness(URL_THEN_PATHS_ROWS, URL_THEN_PATH_COLS);
    const row = URL_THEN_PATHS_ROWS[0].text;
    const links = provide(1);
    const startOf = (text: string) => links.find((link) => link.text === text)?.range.start;
    expect(startOf('docs/design.md')).toEqual({ x: row.indexOf('docs/design.md') + 1, y: 1 });
    expect(startOf('~/notes/todo.txt')).toEqual({ x: row.indexOf('~/notes/todo.txt') + 1, y: 1 });
    expect(new Set(links.filter((link) => /^https?:/.test(link.text)).map((link) => link.text))).toEqual(
      new Set([WIKI_URL])
    );
  });

  it('links a URL in the column right of another URL whole, without stitching either', () => {
    const { provide } = harness(URL_THEN_URL_ROWS, URL_THEN_PATH_COLS);
    const row = URL_THEN_URL_ROWS[0].text;
    const links = provide(1).filter((link) => /^https?:/.test(link.text));
    expect(links.map((link) => [link.text, link.range.start.x, link.range.start.y])).toEqual([
      ['https://wiki.example.com/spaces/ENG/pages/12345/', row.indexOf('https://wiki') + 1, 1],
      ['https://other.example.com/notes.md', row.indexOf('https://other') + 1, 1],
    ]);
    expect(provide(2).filter((link) => /^https?:/.test(link.text))).toEqual([]);
  });

  it('underlines only the URL cells on each row, never the indent between pieces', () => {
    const { provide } = harness(TABLE, COLS);
    const segments = provide(3).filter((link) => link.text === URL);
    expect(segments.map((link) => link.range.start.y)).toEqual([2, 3, 4]);
    for (const link of segments) expect(link.range.start.y).toBe(link.range.end.y);
    expect(segments[0].range.start.x).toBe(TABLE[1].text.indexOf('https://') + 1);
    expect(segments[0].range.end.x).toBe(TABLE[1].text.length);
    expect(segments[1].range.start.x).toBe(CELL + 1);
    expect(segments[2].range.start.x).toBe(CELL + 1);
    // Ends on `true`, not on the closing paren after it.
    expect(segments[2].range.end.x).toBe(TABLE[3].text.length - 1);
  });

  it('links the column on a soft-wrapped URL row and the row below it separately', () => {
    const { provide } = harness(SOFT_WRAPPED_URL_ROWS, SOFT_WRAP_COLS);
    const texts = [1, 2, 3].flatMap((line) => provide(line).map((link) => link.text));
    expect(texts.filter((text) => text.includes('report.txtccc'))).toEqual([]);
    expect(provide(2).map((link) => link.text)).toContain('/tmp/report.txt');
    expect(provide(3).map((link) => link.text)).toContain('ccc/x.html');
  });

  it('keeps a single-row URL with a paren pair whole', () => {
    const line = 'Open https://example.com/wiki/Widget_(tool) please';
    const { provide } = harness([{ text: line }], 80);
    const [link] = provide(1).filter((l) => l.text.startsWith('https://'));
    expect(link.text).toBe('https://example.com/wiki/Widget_(tool)');
  });
});
