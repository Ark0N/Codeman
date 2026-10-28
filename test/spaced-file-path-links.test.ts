// Port: none (a pure function in a vm context: no browser, no server).
//
// File paths with spaces in them (`OneDrive - Contoso/…`, `90 Sensitive/…`) were
// cut at the first space by every path pattern, so the terminal and the response
// viewer linked a fragment such as `/mnt/c/proj/My` plus a bogus relative tail
// `Docs/report.docx`, each opening the wrong target. findFilePathLinks() now takes
// a spaced path WHOLE where the line makes its extent unambiguous: the path is the
// whole absolute path, or a relative path after an explicit path label. A spaced line that
// is one path but not a linkable one (unknown root, `..`) links nothing at all,
// rather than a fragment.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');

function load(): (text: string) => Array<{ path: string; index: number; folder?: true }> {
  const context = vm.createContext({ console, window: undefined });
  vm.runInContext(`${SOURCE}\nglobalThis.__fn = findFilePathLinks;`, context, { filename: 'constants.js' });
  return (context as { __fn: never })['__fn'] as never;
}

const findFilePathLinks = load();
const paths = (text: string) => findFilePathLinks(text).map((f) => f.path);

const LONG =
  '/mnt/c/Users/someone/OneDrive - Contoso/01_Projects/Other/kb/out/deliverables/fy27-messaging-market-story.docx';

describe('spaced file paths', () => {
  it('links an own-line absolute path with spaces whole', () => {
    expect(paths(LONG)).toEqual([LONG]);
    expect(paths('/mnt/c/proj/My Big Docs/report.docx')).toEqual(['/mnt/c/proj/My Big Docs/report.docx']);
  });

  it('reports where the whole path starts', () => {
    const line = '  - Path: /mnt/c/proj/My Big Docs/report.docx';
    expect(findFilePathLinks(line)).toEqual([
      { path: '/mnt/c/proj/My Big Docs/report.docx', index: line.indexOf('/mnt') },
    ]);
  });

  it('leaves a single trailing sentence period out', () => {
    expect(paths('/mnt/c/proj/My Big Docs/report.docx.')).toEqual(['/mnt/c/proj/My Big Docs/report.docx']);
  });

  it.each(['Path:', 'File:', 'Saved to:'])('links an absolute spaced path after %s', (label) => {
    const p = '/mnt/sync/brain/90 Sensitive/team/training/attendees.xlsx';
    expect(paths(`${label} ${p}`)).toEqual([p]);
  });

  it.each([
    'Path:',
    'File:',
    'Files:',
    'Saved to:',
    'Saved as:',
    'Wrote:',
    'Written to:',
    'Output:',
    'Created:',
    'Location:',
    'Attachment:',
    'pAtH:',
  ])('links a relative spaced path after %s', (label) => {
    const p = '03 Attachments/Build SIPOC Design/Build-SIPOC.pptx';
    expect(paths(`${label} ${p}`)).toEqual([p]);
  });

  it.each(['- ', '* ', '• ', '1. ', '2) '])(
    'defers a relative spaced path after a bare list marker %j, links it after a path label',
    (marker) => {
      const rel = '03 Attachments/Build SIPOC Design/Build-SIPOC.pptx';
      expect(paths(`${marker}${rel}`)).toEqual(['Design/Build-SIPOC.pptx']);
      expect(paths(`${marker}Path: ${rel}`)).toEqual([rel]);
      expect(paths(`  ${marker}${LONG}`)).toEqual([LONG]);
    }
  );

  it('works line by line in code-block text, where list markers remain literal', () => {
    const text = `Wrote two files:\n- ${LONG}\n- Path: notes/a b/c.md\n`;
    expect(paths(text)).toEqual([LONG, 'notes/a b/c.md']);
  });

  it('links nothing for a spaced path outside the known roots (no partial tail)', () => {
    expect(paths('/etc/secret files/passwords.txt')).toEqual([]);
    expect(paths('/srvx/team share/notes/passwords.txt')).toEqual([]);
  });

  it('links nothing for a spaced path with a `..` or `.` segment', () => {
    expect(paths('/mnt/c/proj/../other place/docs/report.docx')).toEqual([]);
    expect(paths('File: 03 Attachments/../private/report.xlsx')).toEqual([]);
    expect(paths('- File: 03 Attachments/./private/report.xlsx')).toEqual([]);
  });

  it('never merges two space-separated paths into one link', () => {
    expect(paths('/mnt/c/proj/a.md /mnt/c/proj/b.pdf')).toEqual(['/mnt/c/proj/a.md', '/mnt/c/proj/b.pdf']);
    expect(paths('- docs/a.md docs/b.md')).toEqual(['docs/a.md', 'docs/b.md']);
    expect(paths('/mnt/c/proj/a b.md -> /mnt/c/proj/c.md')).not.toContain('/mnt/c/proj/a b.md -> /mnt/c/proj/c.md');
  });

  it('does not take prose into a path', () => {
    // No marker or label: a relative spaced candidate is prose, not a path.
    expect(paths('See docs/report.docx for details')).toEqual(['docs/report.docx']);
    expect(paths('see the docs/a b.md')).not.toContain('see the docs/a b.md');
    // A long description before a colon is a sentence, not a label: only the path links.
    const rel = '.worktrees/feature-x/docs/specs/2026-09-05-design.md';
    expect(paths(`• Design committed in the isolated worktree: ${rel}`)).toEqual([rel]);
  });

  it.each([
    ['- Updated src/foo.ts', 'src/foo.ts'],
    ['1. Added a test in test/foo.test.ts', 'test/foo.test.ts'],
    ['• Ran npm test -- test/foo.test.ts', 'test/foo.test.ts'],
    ['Error: cannot open src/foo.ts', 'src/foo.ts'],
    ['Note: see src/foo.ts', 'src/foo.ts'],
    ['- Moved ../a/b.ts', '../a/b.ts'],
  ])('defers ambiguous relative prose to ordinary detectors: %s', (line, path) => {
    expect(paths(line)).toEqual([path]);
  });

  it('requires a path label for relative candidates but retains own-line absolute ambiguity', () => {
    expect(paths('- Fixed bug in src/My Docs/a.md')).toEqual(['Docs/a.md']);
    // Documented trade-off: a labelled relative path whose only space is in its top
    // directory reads like prose after the label, so it splits as on master.
    expect(paths('Saved to: 03 Attachments/plan.pptx')).toEqual(['Attachments/plan.pptx']);
    expect(paths('Saved to: My Docs/plan.md')).toEqual(['Docs/plan.md']);
    // Documented residual: words after an own-line absolute path that hold no prose
    // word read like a spaced name (`/home/me/docs/Read Me.txt`), so they stay in.
    expect(paths('/home/me/proj/out report.pdf')).toEqual(['/home/me/proj/out report.pdf']);
    expect(paths('Saved to: ~/My Docs/plan.md')).toEqual(['~/My Docs/plan.md']);
  });

  it.each([
    ['1. Ran 45/45 tests in test/foo.test.ts', ['test/foo.test.ts']],
    ['- Fixed CI/CD pipeline in .github/workflows/ci.yml', ['.github/workflows/ci.yml']],
    ['- Added read/write support in config.ts', ['config.ts']],
    ['- Tests: 45/45 pass in test/foo.test.ts', ['test/foo.test.ts']],
    ['Error: I/O failure reading data.json', ['data.json']],
    ['- Moved src/ into lib/a.ts', ['src/', 'lib/a.ts']],
    ['- Copied files from ../shared into lib/a.ts', ['lib/a.ts']],
    ['- Ran 45/45 tests in ~/proj/foo.test.ts', ['~/proj/foo.test.ts']],
  ])('does not swallow slash-containing prose: %s', (line, expected) => {
    expect(paths(line)).toEqual(expected);
  });

  it.each(['~/', './', '../', '/tmp/'])('does not merge a later new path starting with %s', (prefix) => {
    const line = `Path: notes/a ${prefix}other/file.md`;
    expect(paths(line)).not.toContain(line.slice(6));
  });

  it('does not merge a folder token into a labelled spaced path', () => {
    expect(paths('Path: src/ into lib/a.ts')).toEqual(['src/', 'lib/a.ts']);
  });

  it.each([40000, 80000])('stays linear with %i interior spaces', (length) => {
    const line = '/home/a' + ' '.repeat(length) + 'x';
    const start = performance.now();
    findFilePathLinks(line);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('leaves unspaced paths to the ordinary detectors', () => {
    expect(paths('- /mnt/c/proj/docs/report.docx')).toEqual(['/mnt/c/proj/docs/report.docx']);
    expect(paths('• committed as /tmp/x/docs/specs/design.md:1 (e7ae1b4).')).toEqual(['/tmp/x/docs/specs/design.md']);
  });

  it('stays linear on a long spaced line', () => {
    const line = '- ' + 'a '.repeat(20000) + '/x.md';
    const t0 = performance.now();
    findFilePathLinks(line);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

/** The links master returned for `line`, in order: `[path, folder?]` pairs, each at its first occurrence. */
const masterLinks = (line: string, ...links: Array<[string, true?]>) =>
  links.map(([path, folder]) => ({ path, index: line.indexOf(path), ...(folder ? { folder } : {}) }));

describe('spaced file paths: shapes that keep master links', () => {
  // grep -n, rg -n and compiler output: a `:` plus a digit inside an earlier
  // word is a line suffix, so the path already ended there.
  it.each([
    ['/home/me/proj/README.md:12:See docs/setup.md', '/home/me/proj/README.md', 'docs/setup.md'],
    [
      '     /home/me/proj/CLAUDE.md:42:Deep detail lives in docs/architecture-invariants.md',
      '/home/me/proj/CLAUDE.md',
      'docs/architecture-invariants.md',
    ],
    ['/home/me/proj/src/a.ts:42:5 - error in b.ts', '/home/me/proj/src/a.ts', 'b.ts'],
    ['/home/me/proj/src/index.ts:10 updated config.json', '/home/me/proj/src/index.ts', 'config.json'],
  ])('ends the path at a line suffix: %s', (line, first, second) => {
    expect(findFilePathLinks(line)).toEqual(masterLinks(line, [first], [second]));
  });

  // A generic label introduces prose for an absolute path as much as a relative one.
  it.each([
    ['Error: /home/me/proj contains a.md', '/home/me/proj', 'a.md'],
    ['Warning: /home/me/proj is not tracked, see notes.md', '/home/me/proj', 'notes.md'],
    ['Working directory: /home/me/proj, see README.md', '/home/me/proj', 'README.md'],
    ['- Note: /tmp/out has the logs in run.log', '/tmp/out', 'run.log'],
  ])('defers an absolute path after a generic label: %s', (line, folder, file) => {
    expect(findFilePathLinks(line)).toEqual(masterLinks(line, [folder, true], [file]));
  });

  it('documented trade-off: an absolute spaced path after a non-path label splits as on master', () => {
    const line = 'Saved the report to: /mnt/c/My Docs/a.docx';
    expect(findFilePathLinks(line)).toEqual(masterLinks(line, ['/mnt/c/My', true], ['Docs/a.docx']));
  });

  it.each([
    ['/usr/bin/python3 script.py', 'script.py'],
    ['/usr/bin/env node build.js', 'build.js'],
    ['/review the changes in src/foo.ts', 'src/foo.ts'],
  ])('does not reserve a command line that only looks like one path: %s', (line, file) => {
    expect(findFilePathLinks(line)).toEqual(masterLinks(line, [file]));
  });

  // A path label vouches that a path follows, not for the prose before it.
  it.each([
    ['Wrote: 120 lines to src/foo.ts', 'src/foo.ts'],
    ['Created: new file src/components/Button.tsx', 'src/components/Button.tsx'],
    ['Output: written to logs/run.log', 'logs/run.log'],
    ['Files: 3 changed in src/foo.ts', 'src/foo.ts'],
    ['Location: line 42 in src/foo.ts', 'src/foo.ts'],
    ['Path: see src/foo.ts', 'src/foo.ts'],
    ['- Output: stored in dist/app.js', 'dist/app.js'],
    ['1. File: changes in src/a.ts', 'src/a.ts'],
    ['Created: 2026-10-24 build/x.json', 'build/x.json'],
  ])('keeps label prose out of the path: %s', (line, file) => {
    expect(findFilePathLinks(line)).toEqual(masterLinks(line, [file]));
  });

  it('keeps labelled spaced paths whole when a `/` word comes before the last', () => {
    for (const p of [
      '03 Attachments/Build SIPOC Design/Build-SIPOC.pptx',
      '~/My Docs/plan.md',
      './My Docs/plan.md',
      'notes/a b/c.md',
      '/mnt/c/My Docs/a.docx',
    ]) {
      expect(paths(`Saved to: ${p}`)).toEqual([p]);
    }
  });

  // A connective or verb before the last word puts the candidate in a sentence,
  // whatever the shape: own line, list marker or path label, absolute or relative.
  it.each([
    ['/home/me/proj contains a.md', ['/home/me/proj', true], ['a.md']],
    ['/home/me/proj in the README.md', ['/home/me/proj', true], ['README.md']],
    ['/home/me/proj/src is where the code lives, see README.md', ['/home/me/proj/src', true], ['README.md']],
    ['/tmp/a and b.md', ['/tmp/a', true], ['b.md']],
    ['/home/me/proj/out vs b.md', ['/home/me/proj/out', true], ['b.md']],
    ['- /tmp/out has the logs in run.log', ['/tmp/out', true], ['run.log']],
    ['* /home/me/proj/docs contains a.md', ['/home/me/proj/docs', true], ['a.md']],
    ['1. /home/me/proj/src then test/foo.test.ts', ['/home/me/proj/src', true], ['test/foo.test.ts']],
    ['- /home/me/proj is the root, see README.md', ['/home/me/proj', true], ['README.md']],
    ['Path: /home/me/proj/out contains a.md', ['/home/me/proj/out', true], ['a.md']],
    ['Saved to: /home/me/out as report.docx', ['/home/me/out', true], ['report.docx']],
    ['Files: src/components and utils/x.ts', ['utils/x.ts']],
    ['Wrote: 3 files to docs/design notes/overview.md', ['notes/overview.md']],
    ['Created: the file src/components/My Button/Button.tsx', ['Button/Button.tsx']],
    ['Output: 2 files in dist/my app/a.js', ['app/a.js']],
    ['Output: 12 KB written to dist/my app/a.js', ['app/a.js']],
    ['/home/me/proj/out = report.pdf', ['/home/me/proj/out', true], ['report.pdf']],
  ] as Array<[string, ...Array<[string, true?]>]>)('keeps a sentence out of the path: %s', (line, ...links) => {
    expect(findFilePathLinks(line)).toEqual(masterLinks(line, ...links));
  });

  it('ends the path at an earlier word that holds an extension', () => {
    expect(findFilePathLinks('/home/me/proj/src/foo.ts#L12 foo.ts')).toEqual([
      { path: '/home/me/proj/src/foo.ts', index: 0 },
      { path: 'foo.ts', index: 29 },
    ]);
  });

  it('documented trade-off: a name that uses a prose word splits as on master', () => {
    const line = '/home/me/docs/Pros and Cons.md';
    expect(findFilePathLinks(line)).toEqual(masterLinks(line, ['/home/me/docs/Pros', true], ['Cons.md']));
    // `at` and `of` are not prose words, so these names stay whole.
    for (const p of [
      '/Users/me/Desktop/Screenshot 2026-10-24 at 10.00.00.png',
      '/home/me/docs/Copy of report.docx',
      '/home/me/docs/Terms of Service.pdf',
    ]) {
      expect(paths(p)).toEqual([p]);
      expect(paths(`Saved to: ${p}`)).toEqual([p]);
    }
  });

  // A command whose executable lives under a known root, or one carrying a flag.
  it.each([
    ['/opt/homebrew/bin/node server.js', '/opt/homebrew/bin/node', 'server.js'],
    ['/home/me/.venv/bin/python run.py', '/home/me/.venv/bin/python', 'run.py'],
    [
      '/home/me/proj/node_modules/.bin/vitest run test/foo.test.ts',
      '/home/me/proj/node_modules/.bin/vitest',
      'test/foo.test.ts',
    ],
    ['/home/me/proj/node_modules/.bin/tsc -p tsconfig.json', '/home/me/proj/node_modules/.bin/tsc', 'tsconfig.json'],
    ['/home/me/proj/scripts/deploy prod.yml', '/home/me/proj/scripts/deploy', 'prod.yml'],
    ['/home/me/scripts/deploy config.yml', '/home/me/scripts/deploy', 'config.yml'],
    ['/home/me/proj/tools/lint src/a.ts', '/home/me/proj/tools/lint', 'src/a.ts'],
  ])('does not reserve a command under a known root: %s', (line, exe, file) => {
    expect(findFilePathLinks(line)).toEqual(masterLinks(line, [exe, true], [file]));
  });

  it.each([
    '/Users/me/Desktop/Screenshot 2026-10-24 at 10.15.32 AM.png',
    '/mnt/c/Users/me/Docs - Copy/a.docx',
    '- /mnt/c/Users/me/Docs - Copy/a.docx',
  ])('keeps a spaced path whole when a word only looks like a flag or a version: %s', (line) => {
    expect(paths(line)).toEqual([line.replace(/^- /, '')]);
  });

  it('still refuses an unlinkable spaced path that reads as one path to its end', () => {
    expect(paths('/etc/secret files/passwords.txt')).toEqual([]);
  });

  it('does not merge a column gap into one path', () => {
    const line = '/home/me/proj     modified     notes.md';
    expect(findFilePathLinks(line)).toEqual(masterLinks(line, ['/home/me/proj', true], ['notes.md']));
  });

  it('reads a leading ./ as the workspace, not a segment', () => {
    expect(paths('Saved to: ./My Docs/plan.md')).toEqual(['./My Docs/plan.md']);
    expect(paths('Saved to: ./notes.md')).toEqual(['./notes.md']);
  });

  it('reads a leading run of ../ as parent directories, not segments', () => {
    expect(paths('Saved to: ../My Docs/plan.md')).toEqual(['../My Docs/plan.md']);
    expect(paths('Saved to: ../../My Docs/plan.md')).toEqual(['../../My Docs/plan.md']);
    expect(paths('Saved to: ../notes.md')).toEqual(['../notes.md']);
    // An interior `..` is still a segment, so the span links nothing.
    expect(paths('Saved to: My Docs/../plan.md')).toEqual([]);
    expect(paths('Saved to: ../My Docs/../x/plan.md')).toEqual([]);
  });

  // A shell prompt that prints its working directory in full (WSL's `/mnt/c/...` is
  // outside `$HOME`): a word with no letter or digit, or any earlier word ending in `$`
  // (the first, or a later one when the directory has a space in it), is never part of
  // a file name, so every earlier command in the scrollback keeps master's links.
  it.each([
    ['/mnt/c/proj ❯ code notes.md', ['/mnt/c/proj', true], ['notes.md']],
    ['/home/me/proj $ cat notes.md', ['/home/me/proj', true], ['notes.md']],
    ['/home/me/proj$ cat notes.md', ['/home/me/proj', true], ['notes.md']],
    ['/mnt/c/Users/me/OneDrive - Contoso/proj$ code notes.md', ['/mnt/c/Users/me/OneDrive', true], ['notes.md']],
    ['/mnt/c/My Docs$ ls notes.md', ['/mnt/c/My', true], ['notes.md']],
    ['/home/me/proj ❯ git add src/a.ts', ['/home/me/proj', true], ['src/a.ts']],
    ['/mnt/c/Users/me/OneDrive - Contoso/proj ❯ code notes.md', ['/mnt/c/Users/me/OneDrive', true], ['notes.md']],
    ['/home/me/proj/out ✓ report.pdf', ['/home/me/proj/out', true], ['report.pdf']],
  ] as Array<[string, ...Array<[string, true?]>]>)('keeps a shell prompt out of the path: %s', (line, ...links) => {
    expect(findFilePathLinks(line)).toEqual(masterLinks(line, ...links));
  });

  it.each([LONG, '/mnt/c/Program Files (x86)/app/readme.txt', '/mnt/c/Users/me/Docs - Copy/a.docx'])(
    'keeps a name whose words hold a letter or digit, or a bare -, whole: %s',
    (line) => {
      expect(paths(line)).toEqual([line]);
    }
  );
});

describe('terminal link provider with spaced paths', () => {
  type Link = { text: string; activate: (event: unknown, text: string) => void };
  const TERMINAL_UI = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

  function linksFor(line: string) {
    const noop = () => {};
    const context = vm.createContext({
      console: { ...console, debug: noop, log: noop },
      CodemanApp: class CodemanApp {},
      document: { addEventListener: noop, getElementById: noop, documentElement: { dataset: {} } },
      window: { addEventListener: noop, removeEventListener: noop, document: { documentElement: { dataset: {} } } },
    });
    vm.runInContext(`${SOURCE}\n${TERMINAL_UI}\nglobalThis.__proto = CodemanApp.prototype;`, context);
    const proto = (context as unknown as { __proto: Record<string, (...args: unknown[]) => unknown> }).__proto;
    let provider: { provideLinks: (row: number, cb: (links?: Link[]) => void) => void } | undefined;
    const opened: string[] = [];
    const app = {
      terminal: {
        cols: 200,
        registerLinkProvider: (p: typeof provider) => (provider = p),
        buffer: {
          active: {
            length: 1,
            getLine: (r: number) =>
              r === 0
                ? {
                    isWrapped: false,
                    translateToString: (trim?: boolean) => (trim === false ? line.padEnd(200) : line),
                  }
                : undefined,
          },
        },
      },
      activeSessionId: 's1',
      sessions: new Map([['s1', { workingDir: '/workspace/project' }]]),
      openFilePreview: (p: string) => opened.push(p),
      openLogViewerWindow: (p: string) => opened.push(`log:${p}`),
      _isExternalPreviewPath: () => false,
      _resolveLinkedFilePath: proto._resolveLinkedFilePath,
      registerFilePathLinkProvider: proto.registerFilePathLinkProvider,
    };
    app.registerFilePathLinkProvider.call(app);
    let links: Link[] = [];
    provider!.provideLinks(1, (value) => (links = value ?? []));
    return { links, opened };
  }

  it('links the whole spaced path and opens it, resolved against the workspace', () => {
    const rel = '03 Attachments/Build SIPOC Design/Build-SIPOC.pptx';
    const { links, opened } = linksFor(`Saved to: ${rel}`);
    expect(links.map((l) => l.text)).toEqual([rel]);
    links[0].activate(null, links[0].text);
    expect(opened).toEqual([`/workspace/project/${rel}`]);
  });

  it('links a labelled spaced path under ../ and opens it outside the workspace', () => {
    const { links, opened } = linksFor('Saved to: ../My Docs/plan.md');
    expect(links.map((l) => l.text)).toEqual(['../My Docs/plan.md']);
    links[0].activate(null, links[0].text);
    expect(opened).toEqual(['/workspace/My Docs/plan.md']);
  });

  it('links nothing for an unlinkable spaced path', () => {
    expect(linksFor('/etc/secret files/passwords.txt').links).toEqual([]);
  });
});

describe('parenthesised paths with spaces (#733)', () => {
  const KOBO = '/mnt/data/Kobo/Kobo eReader.conf';

  it('links a parenthesised absolute path whole, not as a folder prefix plus a tail', () => {
    const line = `Prepared a corrected configuration (${KOBO}).`;
    expect(findFilePathLinks(line)).toEqual([{ path: KOBO, index: line.indexOf(KOBO) }]);
    expect(line.slice(line.indexOf(KOBO), line.indexOf(KOBO) + KOBO.length)).toBe(KOBO);
  });

  it('links a parenthesised relative path and a bare spaced filename whole', () => {
    expect(paths('wrote (docs/Kobo eReader.conf) today')).toEqual(['docs/Kobo eReader.conf']);
    expect(paths('edited (Kobo eReader.conf) in place')).toEqual(['Kobo eReader.conf']);
    expect(paths('kept (~/Kobo/Kobo eReader.conf) aside')).toEqual(['~/Kobo/Kobo eReader.conf']);
  });

  it('links .conf the way other text extensions are linked', () => {
    expect(paths('see /mnt/data/Kobo/reader.conf please')).toEqual(['/mnt/data/Kobo/reader.conf']);
    expect(paths('see config/reader.conf')).toEqual(['config/reader.conf']);
  });

  it('does not take prose or an /etc path inside parentheses', () => {
    expect(paths('(see the notes.conf)')).not.toContain('see the notes.conf');
    expect(paths('(/etc/secret files/passwords.txt)')).toEqual([]);
  });

  it('still links Program Files (x86) as one path', () => {
    const line = '/mnt/c/Program Files (x86)/app/readme.txt';
    expect(paths(line)).toEqual([line]);
    expect(paths(`(${line})`)).toEqual([line]);
  });
});
