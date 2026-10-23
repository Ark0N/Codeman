// Port: none (a pure function in a vm context — no browser, no server).
//
// File paths with spaces in them (`OneDrive - Contoso/…`, `90 Sensitive/…`) were
// cut at the first space by every path pattern, so the terminal and the response
// viewer linked a fragment such as `/mnt/c/proj/My` plus a bogus relative tail
// `Docs/report.docx`, each opening the wrong target. findFilePathLinks() now takes
// a spaced path WHOLE where the line makes its extent unambiguous: the path is the
// whole line, or follows a list marker and/or a short `Label:`. A spaced line that
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

  it.each(['Path:', 'File:', 'Saved to:'])('links a relative spaced path after %s', (label) => {
    const p = '03 Attachments/Build SIPOC Design/Build-SIPOC.pptx';
    expect(paths(`${label} ${p}`)).toEqual([p]);
  });

  it.each(['- ', '* ', '• ', '1. ', '2) '])('links a spaced path after the list marker %j', (marker) => {
    const rel = '03 Attachments/Build SIPOC Design/Build-SIPOC.pptx';
    expect(paths(`${marker}${rel}`)).toEqual([rel]);
    expect(paths(`  ${marker}${LONG}`)).toEqual([LONG]);
  });

  it('works line by line inside multi-line text (the response viewer hands over text nodes)', () => {
    const text = `Wrote two files:\n- ${LONG}\n- notes/a b/c.md\n`;
    expect(paths(text)).toEqual([LONG, 'notes/a b/c.md']);
  });

  it('links nothing for a spaced path outside the known roots (no partial tail)', () => {
    expect(paths('/etc/secret files/passwords.txt')).toEqual([]);
    expect(paths('/srvx/team share/notes/passwords.txt')).toEqual([]);
  });

  it('links nothing for a spaced path with a `..` or `.` segment', () => {
    expect(paths('/mnt/c/proj/../other place/docs/report.docx')).toEqual([]);
    expect(paths('File: 03 Attachments/../private/report.xlsx')).toEqual([]);
    expect(paths('- 03 Attachments/./private/report.xlsx')).toEqual([]);
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
    ['Saved to: 03 Attachments/plan.pptx', 'Attachments/plan.pptx'],
  ])('defers ambiguous relative prose to ordinary detectors: %s', (line, path) => {
    expect(paths(line)).toEqual([path]);
  });

  it('pins residual ambiguity when spaces occur below the first directory', () => {
    // Without filesystem knowledge these still have the shape of spaced paths.
    expect(paths('- Fixed bug in src/My Docs/a.md')).toEqual(['Fixed bug in src/My Docs/a.md']);
    expect(paths('/home/me/proj contains a.md')).toEqual(['/home/me/proj contains a.md']);
    expect(paths('Saved to: ~/My Docs/plan.md')).toEqual(['~/My Docs/plan.md']);
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

  it('links nothing for an unlinkable spaced path', () => {
    expect(linksFor('/etc/secret files/passwords.txt').links).toEqual([]);
  });
});
