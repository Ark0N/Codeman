/**
 * Edit history parser: claude transcript lines → edit records and Bash image candidates.
 * Fixture lines mirror real transcript records (Claude Code 2.1.300), trimmed to the
 * fields the parser reads plus the bulky ones it must ignore (`originalFile`, `content`).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyEditPath,
  extractImagePathCandidates,
  MAX_HUNK_BYTES,
  MAX_IMAGE_CANDIDATES,
  MAX_PENDING_BASH,
  MAX_PENDING_COMMAND_CHARS,
  MAX_PENDING_FIELD_CHARS,
  parseClaudeEditLines,
} from '../src/edit-history-parse.js';

const CWD = '/work/repo';

function toolResultLine(id: string, ts: string, toolUseResult: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    timestamp: ts,
    cwd: CWD,
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }] },
    toolUseResult,
    ...extra,
  });
}

function bashUseLine(id: string, ts: string, command: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: ts,
    cwd: CWD,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    ...extra,
  });
}

const hunk = (lines: string[]) => ({ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines });

const editLine = toolResultLine('toolu_edit', '2026-10-15T19:01:28.880Z', {
  filePath: '/work/repo/src/app.ts',
  oldString: 'a',
  newString: 'b',
  originalFile: 'x'.repeat(5000),
  structuredPatch: [hunk([' keep', '-old', '+new', '+added'])],
  userModified: false,
  replaceAll: false,
});

describe('parseClaudeEditLines: edits', () => {
  it('turns an Edit result into a record without the whole-file fields', () => {
    const { records } = parseClaudeEditLines(editLine + '\n');
    expect(records).toEqual([
      {
        id: 'toolu_edit',
        ts: Date.parse('2026-10-15T19:01:28.880Z'),
        path: '/work/repo/src/app.ts',
        kind: 'code',
        tool: 'Edit',
        created: false,
        added: 2,
        removed: 1,
        hunks: [hunk([' keep', '-old', '+new', '+added'])],
        truncated: false,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain('xxxxx');
  });

  it('reads replaceAll edits like any other Edit', () => {
    const line = toolResultLine('toolu_all', '2026-10-15T19:02:00.000Z', {
      filePath: '/work/repo/a.ts',
      oldString: 'x',
      newString: 'y',
      originalFile: '',
      structuredPatch: [hunk(['-x', '+y']), { ...hunk(['-x', '+y']), oldStart: 9, newStart: 9 }],
      userModified: false,
      replaceAll: true,
    });
    const [rec] = parseClaudeEditLines(line).records;
    expect(rec).toMatchObject({ tool: 'Edit', added: 2, removed: 2 });
    expect(rec.hunks).toHaveLength(2);
  });

  it('marks a Write that created the file, and one that replaced it', () => {
    const create = toolResultLine('toolu_c', '2026-10-15T19:03:00.000Z', {
      type: 'create',
      filePath: '/work/repo/new.md',
      content: 'hello\nworld',
      structuredPatch: [],
      originalFile: null,
    });
    const update = toolResultLine('toolu_u', '2026-10-15T19:04:00.000Z', {
      type: 'update',
      filePath: '/work/repo/new.md',
      content: 'hi',
      structuredPatch: [hunk(['-hello', '-world', '+hi'])],
      originalFile: 'hello\nworld',
    });
    const { records } = parseClaudeEditLines([create, update].join('\n'));
    expect(records.map((r) => [r.tool, r.created, r.added, r.removed])).toEqual([
      ['Write', true, 2, 0],
      ['Write', false, 1, 2],
    ]);
    expect(records[0].hunks).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+hello', '+world'] },
    ]);
  });

  it('a created file’s diff drops the trailing newline and is capped like any hunk', () => {
    const big = 'x'.repeat(1000) + '\n';
    const line = toolResultLine('toolu_big', '2026-10-15T19:03:30.000Z', {
      type: 'create',
      filePath: '/work/repo/big.txt',
      content: big.repeat(100),
      structuredPatch: [],
      originalFile: null,
    });
    const [rec] = parseClaudeEditLines(line).records;
    expect(rec.added).toBe(100);
    expect(rec.truncated).toBe(true);
    expect(rec.hunks[0].lines.length).toBeLessThan(100);
    expect(rec.hunks[0].lines.every((l) => l === '+' + 'x'.repeat(1000))).toBe(true);
  });

  it('classifies an image written by Write as an image', () => {
    const line = toolResultLine('toolu_svg', '2026-10-15T19:05:00.000Z', {
      type: 'create',
      filePath: '/work/repo/icon.SVG',
      content: '<svg/>',
      structuredPatch: [],
      originalFile: null,
    });
    expect(parseClaudeEditLines(line).records[0].kind).toBe('image');
  });

  it('keeps a result of an unknown edit tool that has a path and a patch', () => {
    const line = toolResultLine('toolu_nb', '2026-10-15T19:06:00.000Z', {
      filePath: '/work/repo/n.ipynb',
      structuredPatch: [hunk(['+cell'])],
    });
    expect(parseClaudeEditLines(line).records[0]).toMatchObject({ tool: 'edit', added: 1 });
  });

  it('skips failed tool results (a string), unrelated results and lines that do not parse', () => {
    const failed = toolResultLine('toolu_err', '2026-10-15T19:07:00.000Z', 'Error: String to replace not found');
    const read = toolResultLine('toolu_read', '2026-10-15T19:07:01.000Z', { type: 'text', file: { filePath: '/x' } });
    const text = [failed, read, '{"type":"user",broken', '', 'not json'].join('\n');
    expect(parseClaudeEditLines(text).records).toEqual([]);
  });

  it('skips a first line cut mid-record (a byte range starts inside it)', () => {
    const cut = editLine.slice(40);
    expect(parseClaudeEditLines(cut + '\n' + editLine).records).toHaveLength(1);
  });

  it('carries the subagent id of a sidechain line', () => {
    const line = toolResultLine('toolu_sub', '2026-10-15T19:08:00.000Z', JSON.parse(editLine).toolUseResult, {
      isSidechain: true,
      agentId: 'a0038561ea4d57a42',
    });
    expect(parseClaudeEditLines(line).records[0].agentId).toBe('a0038561ea4d57a42');
  });

  it('caps an oversized patch and says so, counting lines from the whole patch', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `+line ${i} ${'y'.repeat(40)}`);
    const line = toolResultLine('toolu_big', '2026-10-15T19:09:00.000Z', {
      type: 'create',
      filePath: '/work/repo/big.ts',
      content: '',
      structuredPatch: [hunk(big)],
      originalFile: null,
    });
    const [rec] = parseClaudeEditLines(line).records;
    expect(rec.truncated).toBe(true);
    expect(rec.added).toBe(4000);
    expect(JSON.stringify(rec.hunks).length).toBeLessThanOrEqual(MAX_HUNK_BYTES + 1024);
    expect(rec.hunks[0].lines.length).toBeLessThan(4000);
  });
});

describe('parseClaudeEditLines: Bash image candidates', () => {
  const start = '2026-10-15T20:00:00.000Z';
  const end = '2026-10-15T20:00:05.000Z';

  it('pairs a Bash call with its result and collects image paths from command and output', () => {
    const use = bashUseLine('toolu_b', start, 'python3 render.py --out out/frame.png');
    const res = toolResultLine('toolu_b', end, {
      stdout: 'Saved to: file:///tmp/gen/a b.png\nwrote /work/repo/out/thumb.webp.',
      stderr: '',
      interrupted: false,
      isImage: false,
    });
    const { candidates, pending } = parseClaudeEditLines([use, res].join('\n'));
    expect(pending).toEqual([]);
    expect(candidates).toEqual([
      {
        toolUseId: 'toolu_b',
        start: Date.parse(start),
        end: Date.parse(end),
        paths: ['/work/repo/out/frame.png', '/tmp/gen/a b.png', '/work/repo/out/thumb.webp'],
      },
    ]);
  });

  it('yields no candidate for a Bash call without image paths', () => {
    const use = bashUseLine('toolu_n', start, 'git status');
    const res = toolResultLine('toolu_n', end, { stdout: 'clean', stderr: '', interrupted: false, isImage: false });
    expect(parseClaudeEditLines([use, res].join('\n')).candidates).toEqual([]);
  });

  it('uses the tool_result text when the Bash call failed (toolUseResult is a string)', () => {
    const use = bashUseLine('toolu_f', start, 'make render');
    const res = JSON.stringify({
      type: 'user',
      timestamp: end,
      cwd: CWD,
      message: {
        role: 'user',
        content: [{ tool_use_id: 'toolu_f', type: 'tool_result', is_error: true, content: 'Exit 2\nwrote out/x.jpg' }],
      },
      toolUseResult: 'Error: Exit 2',
    });
    expect(parseClaudeEditLines([use, res].join('\n')).candidates[0].paths).toEqual(['/work/repo/out/x.jpg']);
  });

  it('hands an unanswered Bash call back as pending and resolves it in the next chunk', () => {
    const first = parseClaudeEditLines(bashUseLine('toolu_p', start, 'convert a.svg out.png') + '\n');
    expect(first.candidates).toEqual([]);
    expect(first.pending).toEqual([
      { id: 'toolu_p', ts: Date.parse(start), command: 'convert a.svg out.png', cwd: CWD },
    ]);
    const res = toolResultLine('toolu_p', end, { stdout: '', stderr: '', interrupted: false, isImage: false });
    const second = parseClaudeEditLines(res, first.pending);
    expect(second.pending).toEqual([]);
    expect(second.candidates[0].paths).toEqual(['/work/repo/a.svg', '/work/repo/out.png']);
  });

  it('carries the subagent id onto the candidate', () => {
    const use = bashUseLine('toolu_s', start, 'render > shot.png', { isSidechain: true, agentId: 'abc' });
    const res = toolResultLine('toolu_s', end, { stdout: '', stderr: '', interrupted: false, isImage: false });
    expect(parseClaudeEditLines([use, res].join('\n')).candidates[0].agentId).toBe('abc');
  });

  it('bounds the pending list, dropping the oldest', () => {
    const lines = Array.from({ length: MAX_PENDING_BASH + 5 }, (_, i) =>
      bashUseLine(`toolu_${i}`, start, 'sleep 1')
    ).join('\n');
    const { pending } = parseClaudeEditLines(lines);
    expect(pending).toHaveLength(MAX_PENDING_BASH);
    expect(pending[0].id).toBe('toolu_5');
  });

  it(`keeps no call with an id, cwd or agent id over ${MAX_PENDING_FIELD_CHARS} characters (the store would refuse it on load)`, () => {
    const long = 'x'.repeat(MAX_PENDING_FIELD_CHARS + 1);
    const lines = [
      bashUseLine(long, start, 'render > a.png'),
      bashUseLine('toolu_cwd', start, 'render > a.png', { cwd: '/' + long }),
      bashUseLine('toolu_agent', start, 'render > a.png', { agentId: long }),
      bashUseLine('toolu_ok', start, 'render > a.png', { cwd: '/' + 'x'.repeat(MAX_PENDING_FIELD_CHARS - 1) }),
    ];
    expect(parseClaudeEditLines(lines.join('\n')).pending.map((p) => p.id)).toEqual(['toolu_ok']);
  });

  it('keeps only the head of a long command (the pending list is persisted)', () => {
    const command = 'render > out.png && ' + 'x'.repeat(MAX_PENDING_COMMAND_CHARS * 2);
    const { pending } = parseClaudeEditLines(bashUseLine('toolu_long', start, command));
    expect(pending[0].command).toBe(command.slice(0, MAX_PENDING_COMMAND_CHARS));
  });
});

describe('parseClaudeEditLines: images sent to the user', () => {
  it('takes the image attachments of a SendUserFile result, absolute paths only, without a window', () => {
    const line = toolResultLine(
      'toolu_send',
      '2026-10-15T20:50:12.538Z',
      {
        caption: 'Vier Alternativen',
        attachments: [
          { path: '/tmp/s/icons/bremse_alt1_pedal.png', file_uuid: 'x' },
          { path: '/tmp/s/icons/bremse_alt1_pedal.png' },
          { path: '/tmp/s/report.pdf' },
          { path: 'relative.png' },
          { nope: 1 },
        ],
      },
      { agentId: 'a1' }
    );
    const { candidates, records } = parseClaudeEditLines(line);
    expect(records).toEqual([]);
    const at = Date.parse('2026-10-15T20:50:12.538Z');
    expect(candidates).toEqual([
      {
        toolUseId: 'toolu_send',
        start: at,
        end: at,
        paths: ['/tmp/s/icons/bremse_alt1_pedal.png'],
        sent: true,
        agentId: 'a1',
      },
    ]);
  });
});

describe('extractImagePathCandidates', () => {
  it('resolves relative paths against cwd and keeps ~/ paths literal', () => {
    expect(extractImagePathCandidates('cp a.png ../b.jpeg ~/shots/c.gif', '', '', CWD)).toEqual([
      '/work/repo/a.png',
      '/work/b.jpeg',
      '~/shots/c.gif',
    ]);
  });

  it('reads quoted paths with spaces', () => {
    expect(extractImagePathCandidates(`magick "in dir/x.png" 'out dir/y.avif'`, '', '', CWD)).toEqual([
      '/work/repo/in dir/x.png',
      '/work/repo/out dir/y.avif',
    ]);
  });

  it('ignores URLs, globs and names that only contain an image extension', () => {
    const cmd = 'curl https://x.org/a.png; ls *.png out/frame-?.png; mv a.png.bak b.pngx; echo c.png';
    expect(extractImagePathCandidates(cmd, '', '', CWD)).toEqual(['/work/repo/c.png']);
  });

  it('splits key=value and trailing punctuation off', () => {
    expect(extractImagePathCandidates('render --out=out/a.png', 'done (out/b.png), see out/c.png.', '', CWD)).toEqual([
      '/work/repo/out/a.png',
      '/work/repo/out/b.png',
      '/work/repo/out/c.png',
    ]);
  });

  it('deduplicates and caps the list', () => {
    const many = Array.from({ length: MAX_IMAGE_CANDIDATES + 10 }, (_, i) => `f${i}.png`).join(' ');
    const out = extractImagePathCandidates(`a.png a.png ${many}`, '', '', CWD);
    expect(out).toHaveLength(MAX_IMAGE_CANDIDATES);
    expect(out[0]).toBe('/work/repo/a.png');
    expect(out[1]).toBe('/work/repo/f0.png');
  });

  it('drops relative paths when cwd is unknown', () => {
    expect(extractImagePathCandidates('x.png /abs/y.png', '', '', '')).toEqual(['/abs/y.png']);
  });
});

describe('classifyEditPath', () => {
  it.each([
    ['/a/b.png', 'image'],
    ['/a/b.JPG', 'image'],
    ['/a/b.jpeg', 'image'],
    ['/a/b.webp', 'image'],
    ['/a/b.gif', 'image'],
    ['/a/b.avif', 'image'],
    ['/a/b.svg', 'image'],
    ['/a/b.ts', 'code'],
    ['/a/png', 'code'],
    ['/a/b.png.orig', 'code'],
  ])('%s → %s', (path, kind) => {
    expect(classifyEditPath(path)).toBe(kind);
  });
});
