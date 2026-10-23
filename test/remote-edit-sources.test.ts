/**
 * @fileoverview Tests for the remote edit-history reads in `src/remote-files.ts`: the transcript
 * lookup and the transcript read a remote claude session's edit history uses.
 *
 * Both scripts are executed by a real `/bin/sh` against a temp `$HOME`: the script IS the
 * remote command, so `sh -c <script>` reproduces what sshd runs on the other end. The read is
 * checked byte for byte against the local reader (`readClaudeEditSources`) on seeded random
 * transcripts, so the edit history sync sees the same thing from a remote host as from a
 * local one.
 *
 * Port: N/A (no HTTP server).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  RemoteFileAccessError,
  buildRemoteClaudeEditSourcesCommand,
  buildRemoteClaudeTranscriptLocateCommand,
  isRemoteClaudeTranscriptPath,
  parseRemoteClaudeEditSources,
  parseRemoteClaudeTranscriptLocate,
  remoteEditSourcesTimeoutMs,
  remoteLocateClaudeTranscript,
  remoteReadClaudeEditSources,
} from '../src/remote-files.js';
import { readClaudeEditSources, type EditSourceRequest } from '../src/edit-history-local-source.js';
import type { SessionRemote } from '../src/types/session.js';

let home: string;
beforeAll(() => {
  // A throwaway HOME: the scripts only ever see this directory as $HOME.
  home = mkdtempSync(join(tmpdir(), 'codeman-remote-edit-'));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Run a built command (`sh -c '…'` or `exit 3`) the way sshd would; status and raw stdout. */
function runSh(command: string, env: Record<string, string> = {}): { code: number; stdout: Buffer } {
  expect(home.startsWith(tmpdir())).toBe(true);
  try {
    return {
      code: 0,
      stdout: execFileSync('sh', ['-c', command], { env: { ...process.env, HOME: home, ...env }, cwd: home }),
    };
  } catch (err) {
    const e = err as { status: number; stdout: Buffer };
    return { code: e.status, stdout: e.stdout };
  }
}

/** One edit-source record in the script's wire format. */
function editRecord(relPath: string, size: number, start: number, body: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([Buffer.from(`${relPath}\0${size}\0${start}\0${bytes.length}\0`), bytes]);
}

const REMOTE: SessionRemote = { hostId: 'h', label: 'h', host: '192.0.2.1', username: 'j', remotePath: '/' };

describe('isRemoteClaudeTranscriptPath', () => {
  it('takes an absolute <id>.jsonl path and nothing else', () => {
    expect(isRemoteClaudeTranscriptPath('/home/u/.claude/projects/-w/conv-1.jsonl')).toBe(true);
    expect(isRemoteClaudeTranscriptPath('rel/conv-1.jsonl')).toBe(false);
    expect(isRemoteClaudeTranscriptPath('/p/conv-1.json')).toBe(false);
    expect(isRemoteClaudeTranscriptPath('/p/bad id.jsonl')).toBe(false);
    expect(isRemoteClaudeTranscriptPath('/p/$(x).jsonl')).toBe(false);
    expect(isRemoteClaudeTranscriptPath('/p\n/conv-1.jsonl')).toBe(false);
    expect(isRemoteClaudeTranscriptPath('/.jsonl')).toBe(false);
  });
});

describe('the transcript lookup on a real shell', () => {
  const projects = () => join(home, '.claude', 'projects');

  beforeAll(() => {
    mkdirSync(join(projects(), 'old'), { recursive: true });
    mkdirSync(join(projects(), 'new'), { recursive: true });
    writeFileSync(join(projects(), 'old', 'conv-1.jsonl'), 'x\n');
    writeFileSync(join(projects(), 'new', 'conv-1.jsonl'), 'y\n');
    writeFileSync(join(projects(), 'old', 'solo.jsonl'), 'z\n');
    utimesSync(join(projects(), 'old', 'conv-1.jsonl'), 1_000, 1_000);
    utimesSync(join(projects(), 'new', 'conv-1.jsonl'), 2_000, 2_000);
  });

  const locate = (ids: string[], pane?: Parameters<typeof buildRemoteClaudeTranscriptLocateCommand>[1], env = {}) => {
    const { code, stdout } = runSh(buildRemoteClaudeTranscriptLocateCommand(ids, pane), env);
    return code === 0 ? parseRemoteClaudeTranscriptLocate(stdout) : code;
  };

  it('runs under an explicit sh and never calls ls', () => {
    const command = buildRemoteClaudeTranscriptLocateCommand(['conv-1']);
    expect(command).toMatch(/^sh -c '/);
    expect(command).not.toMatch(/(^|[\s;|(])ls\s/m);
  });

  it('finds the newest <id>.jsonl of the first id that has one', () => {
    expect(locate(['conv-1', 'solo'])).toBe(join(projects(), 'new', 'conv-1.jsonl'));
    expect(locate(['missing', 'solo'])).toBe(join(projects(), 'old', 'solo.jsonl'));
  });

  it('exits 3 when no id has a transcript, and drops ids that are not plain tokens', () => {
    expect(locate(['nope'])).toBe(3);
    expect(buildRemoteClaudeTranscriptLocateCommand(['$(touch pwned)', "a'b", '../../x'])).toBe('exit 3');
    const command = buildRemoteClaudeTranscriptLocateCommand(['$(touch pwned)', 'conv-1']);
    expect(command).toContain('conv-1');
    expect(command).not.toContain('pwned');
  });

  it('looks in an absolute CLAUDE_CONFIG_DIR instead of ~/.claude, as claude does; a relative one is ignored', () => {
    const cfg = join(home, 'alt-config');
    mkdirSync(join(cfg, 'projects', 'w'), { recursive: true });
    writeFileSync(join(cfg, 'projects', 'w', 'alt-1.jsonl'), 'a\n');
    expect(locate(['alt-1', 'conv-1'], undefined, { CLAUDE_CONFIG_DIR: cfg })).toBe(
      join(cfg, 'projects', 'w', 'alt-1.jsonl')
    );
    expect(locate(['conv-1'], undefined, { CLAUDE_CONFIG_DIR: cfg })).toBe(3);
    expect(locate(['alt-1', 'conv-1'], undefined, { CLAUDE_CONFIG_DIR: 'alt-config' })).toBe(
      join(projects(), 'new', 'conv-1.jsonl')
    );
  });

  it('parses only an absolute transcript path after the first NUL (a login banner comes before it)', () => {
    expect(parseRemoteClaudeTranscriptLocate(Buffer.from('motd\n\0/p/conv-1.jsonl\0'))).toBe('/p/conv-1.jsonl');
    expect(parseRemoteClaudeTranscriptLocate(Buffer.from('no nul'))).toBeNull();
    expect(parseRemoteClaudeTranscriptLocate(Buffer.from('\0/p/conv-1.jsonl'))).toBeNull();
    expect(parseRemoteClaudeTranscriptLocate(Buffer.from('\0p/conv-1.jsonl\0'))).toBeNull();
    expect(parseRemoteClaudeTranscriptLocate(Buffer.from('\0/p/notes.txt\0'))).toBeNull();
  });

  describe('after a /clear: the conversation the pane’s claude writes now', () => {
    // Fake tmux (pane pid 100) and ps (100 → 200 wrapper → 300 claude); claude's own
    // ~/.claude/sessions/<pid>.json names the current conversation.
    let bin: string;
    const pane = { socket: 'codeman-remote', sessionName: 'codeman-ssh-conv1abc' };
    beforeAll(() => {
      bin = mkdtempSync(join(tmpdir(), 'codeman-fake-tmux-'));
      writeFileSync(
        join(bin, 'tmux'),
        '#!/bin/sh\ncase "$*" in *"=codeman-ssh-conv1abc"*) echo 100 ;; *) echo "no such session" >&2; exit 1 ;; esac\n'
      );
      writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf "  1     0\\n100     1\\n200   100\\n300   200\\n"\n');
      chmodSync(join(bin, 'tmux'), 0o755);
      chmodSync(join(bin, 'ps'), 0o755);
      mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    });
    afterAll(() => rmSync(bin, { recursive: true, force: true }));
    const locateIn = (p: typeof pane | undefined) => locate(['conv-1'], p, { PATH: `${bin}:${process.env.PATH}` });
    const session = (body: string) => writeFileSync(join(home, '.claude', 'sessions', '300.json'), body);

    it('finds the live conversation of a grandchild claude before the stored ids', () => {
      session('{"pid":300,"sessionId":"solo","cwd":"/w","kind":"interactive"}');
      expect(locateIn(pane)).toBe(join(projects(), 'old', 'solo.jsonl'));
    });

    it('falls back to the stored ids without a pane, for an unknown session, or a live id with no transcript', () => {
      session('{"pid":300,"sessionId":"solo"}');
      expect(locateIn(undefined)).toBe(join(projects(), 'new', 'conv-1.jsonl'));
      expect(locateIn({ ...pane, sessionName: 'codeman-ssh-other' })).toBe(join(projects(), 'new', 'conv-1.jsonl'));
      session('{"pid":300,"sessionId":"gone"}');
      expect(locateIn(pane)).toBe(join(projects(), 'new', 'conv-1.jsonl'));
    });

    it('reads the live id from the sessions dir under CLAUDE_CONFIG_DIR', () => {
      const cfg = join(home, 'alt-config');
      mkdirSync(join(cfg, 'sessions'), { recursive: true });
      mkdirSync(join(cfg, 'projects', 'w'), { recursive: true });
      writeFileSync(join(cfg, 'projects', 'w', 'alt-1.jsonl'), 'a\n');
      writeFileSync(join(cfg, 'projects', 'w', 'conv-1.jsonl'), 'c\n');
      writeFileSync(join(cfg, 'sessions', '300.json'), '{"pid":300,"sessionId":"alt-1"}');
      session('{"pid":300,"sessionId":"solo"}'); // ~/.claude's file is not claude's here
      expect(locate(['conv-1'], pane, { PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: cfg })).toBe(
        join(cfg, 'projects', 'w', 'alt-1.jsonl')
      );
    });

    it('takes only an id-shaped value from the sessions file, and only plain socket/session names', () => {
      session('{"pid":300,"sessionId":"x$(touch pwned)"}');
      expect(locateIn(pane)).toBe(join(projects(), 'new', 'conv-1.jsonl'));
      expect(existsSync(join(home, 'pwned'))).toBe(false);
      expect(buildRemoteClaudeTranscriptLocateCommand(['conv-1'], { socket: "a';x", sessionName: 's' })).not.toContain(
        'list-panes'
      );
    });
  });
});

describe('buildRemoteClaudeEditSourcesCommand', () => {
  it('runs under an explicit sh and never calls ls', () => {
    const command = buildRemoteClaudeEditSourcesCommand('/p/conv-1.jsonl', [], 1024);
    expect(command).toMatch(/^sh -c '/);
    expect(command).not.toMatch(/(^|[\s;|(])ls\s/m);
  });

  it('exits 3 for a path that is not an absolute <id>.jsonl, without putting it in a script', () => {
    for (const path of ['rel/conv-1.jsonl', "/p/a';touch x;'.jsonl", '/p/conv-1.txt', '/p\n/conv-1.jsonl']) {
      expect(buildRemoteClaudeEditSourcesCommand(path, [], 10)).toBe('exit 3');
    }
  });

  it('ignores invalid relPaths, offsets and lengths; the first request per relPath wins', () => {
    const command = buildRemoteClaudeEditSourcesCommand(
      '/p/conv-1.jsonl',
      [
        { relPath: '../../etc/passwd', offset: 0 },
        { relPath: "subagents/agent-a';touch x;'.jsonl", offset: 0 },
        { relPath: 'subagents/agent-neg.jsonl', offset: -1 },
        { relPath: 'subagents/agent-frac.jsonl', offset: 1.5 },
        { relPath: 'subagents/agent-nan.jsonl', offset: Number.NaN },
        { relPath: 'subagents/agent-badlen.jsonl', offset: 0, len: -5 },
        { relPath: 'subagents/agent-ok.jsonl', offset: 7, len: 3 },
        { relPath: 'subagents/agent-ok.jsonl', offset: 99 },
      ],
      100
    );
    expect(command).not.toMatch(/passwd|touch|agent-neg|agent-frac|agent-nan|agent-badlen/);
    expect(command).toContain('agent-ok.jsonl');
    expect(command).toContain('r 7 3');
    expect(command).not.toContain('r 99');
  });
});

describe('parseRemoteClaudeEditSources', () => {
  it('splits several records byte-exactly and keeps a UTF-8 sequence cut at a chunk edge intact as bytes', () => {
    const euro = Buffer.from('a€', 'utf8'); // 61 e2 82 ac
    const stdout = Buffer.concat([
      Buffer.from('banner from .zshrc\n\0conv-1\0'),
      editRecord('main', 10, 6, euro.subarray(0, 3)), // ends mid-€
      editRecord('subagents/agent-x1.jsonl', 4, 0, '{}\n\0'),
      editRecord('subagents/agent-x1.meta.json', 23, 0, '{"agentType":"Explore"}'),
    ]);
    const parsed = parseRemoteClaudeEditSources(stdout);
    expect(parsed?.transcriptId).toBe('conv-1');
    expect(parsed?.files).toHaveLength(2);
    expect(parsed?.files[0]).toMatchObject({ relPath: 'main', size: 10, startOffset: 6 });
    expect(parsed?.files[0].chunk.equals(euro.subarray(0, 3))).toBe(true);
    expect(parsed?.files[1].chunk.equals(Buffer.from('{}\n\0'))).toBe(true);
    expect(parsed?.metas).toEqual({ x1: '{"agentType":"Explore"}' });
  });

  it('accepts a zero-length record (budget used up) and a header with no records', () => {
    const parsed = parseRemoteClaudeEditSources(
      Buffer.concat([Buffer.from('\0conv-1\0'), editRecord('main', 500, 500, '')])
    );
    expect(parsed?.files).toEqual([{ relPath: 'main', size: 500, startOffset: 500, chunk: Buffer.alloc(0) }]);
    expect(parseRemoteClaudeEditSources(Buffer.from('\0conv-1\0'))).toEqual({
      transcriptId: 'conv-1',
      files: [],
      metas: {},
    });
  });

  it('is null when the protocol is broken', () => {
    expect(parseRemoteClaudeEditSources(Buffer.from('no nul at all'))).toBeNull();
    expect(parseRemoteClaudeEditSources(Buffer.from('\0conv-1'))).toBeNull();
    expect(parseRemoteClaudeEditSources(Buffer.from('\0bad id\0'))).toBeNull();
    // Body shorter than declared.
    expect(parseRemoteClaudeEditSources(Buffer.from('\0conv-1\0main\x0010\x000\x005\x00abc'))).toBeNull();
    // Truncated header.
    expect(parseRemoteClaudeEditSources(Buffer.from('\0conv-1\0main\x0010\x00'))).toBeNull();
    // Non-numeric size, unknown relPath, slice outside the file.
    expect(parseRemoteClaudeEditSources(Buffer.from('\0conv-1\0main\0x\x000\x000\0'))).toBeNull();
    expect(
      parseRemoteClaudeEditSources(Buffer.concat([Buffer.from('\0conv-1\0'), editRecord('../x', 1, 0, 'a')]))
    ).toBeNull();
    expect(
      parseRemoteClaudeEditSources(Buffer.concat([Buffer.from('\0conv-1\0'), editRecord('main', 2, 1, 'ab')]))
    ).toBeNull();
  });
});

describe('remoteEditSourcesTimeoutMs', () => {
  it('gives a read of megabytes its transfer time at 256 KiB/s on top of the flat 30 s', () => {
    expect(remoteEditSourcesTimeoutMs(0)).toBe(30_000);
    expect(remoteEditSourcesTimeoutMs(-5)).toBe(30_000);
    expect(remoteEditSourcesTimeoutMs(256 * 1024)).toBe(31_000);
    // a forward pass: 8 MiB budget + 4 MiB metas + 1 MiB header slack
    expect(remoteEditSourcesTimeoutMs(13 * 1024 * 1024)).toBe(82_000);
  });
});

describe('the transcript read on a real shell', () => {
  const project = () => join(home, '.claude', 'projects', 'read');
  const main = () => join(project(), 'conv-r.jsonl');
  const read = (requests: EditSourceRequest[], budget: number, onlyRequested = false) => {
    const { code, stdout } = runSh(buildRemoteClaudeEditSourcesCommand(main(), requests, budget, { onlyRequested }));
    return code === 0 ? parseRemoteClaudeEditSources(stdout) : code;
  };

  beforeAll(() => {
    const sub = join(project(), 'conv-r', 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(main(), 'main-0123456789\n');
    writeFileSync(join(sub, 'agent-a1.jsonl'), 'AAAAAAAAAA');
    writeFileSync(join(sub, 'agent-a1.meta.json'), '{"agentType":"Explore"}');
    writeFileSync(join(sub, 'agent-b2.jsonl'), 'BBBBB');
    writeFileSync(join(sub, 'agent-bad name.jsonl'), 'never read');
  });

  it('exits 3 when the transcript is gone', () => {
    const { code } = runSh(buildRemoteClaudeEditSourcesCommand(join(project(), 'gone.jsonl'), [], 100));
    expect(code).toBe(3);
  });

  it('continues from the offsets, reads a new subagent’s end with its meta, and an older block to its end', () => {
    const parsed = read(
      [
        { relPath: 'main', offset: 5 },
        { relPath: 'subagents/agent-b2.jsonl', offset: 1, len: 3 },
      ],
      1000
    );
    expect(parsed).not.toBe(3);
    if (typeof parsed !== 'object' || !parsed) return;
    expect(parsed.files.map((f) => [f.relPath, f.size, f.startOffset, f.chunk.toString()])).toEqual([
      ['main', 16, 5, '0123456789\n'],
      ['subagents/agent-a1.jsonl', 10, 0, 'AAAAAAAAAA'],
      ['subagents/agent-b2.jsonl', 5, 1, 'BBB'],
    ]);
    expect(parsed.metas).toEqual({ a1: '{"agentType":"Explore"}' });
  });

  it('with onlyRequested lists only the requested files and sends no meta', () => {
    const parsed = read([{ relPath: 'subagents/agent-a1.jsonl', offset: 2, len: 4 }], 1000, true);
    if (typeof parsed !== 'object' || !parsed) throw new Error('no read');
    expect(parsed.files.map((f) => [f.relPath, f.startOffset, f.chunk.toString()])).toEqual([
      ['subagents/agent-a1.jsonl', 2, 'AAAA'],
    ]);
    expect(parsed.metas).toEqual({});
  });

  it('treats a hostile request as data: it never reaches the shell', () => {
    const marker = join(home, 'pwned-read');
    const parsed = read([{ relPath: `subagents/agent-x.jsonl'; touch ${marker}; '`, offset: 0 }], 1000);
    expect(existsSync(marker)).toBe(false);
    if (typeof parsed !== 'object' || !parsed) throw new Error('no read');
    expect(parsed.files.map((f) => f.relPath)).toEqual([
      'main',
      'subagents/agent-a1.jsonl',
      'subagents/agent-b2.jsonl',
    ]);
  });

  it('reads exactly what the local reader reads (seeded random transcripts, requests and budgets)', async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      let state = seed;
      const rnd = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
      const dir = join(home, '.claude', 'projects', `fuzz-${seed}`);
      const path = join(dir, `conv-${seed}.jsonl`);
      const sub = join(dir, `conv-${seed}`, 'subagents');
      mkdirSync(sub, { recursive: true });
      const text = (n: number) => Array.from({ length: n }, () => ['a', 'ä', '€', '\n', '{', 'z'][ri(0, 5)]).join('');
      writeFileSync(path, text(ri(0, 300)));
      const names: string[] = [];
      for (let i = ri(0, 5); i > 0; i--) {
        const name = `agent-${['A', 'b', '0', '_', '-'][ri(0, 4)]}${ri(0, 99)}`;
        names.push(name);
        writeFileSync(join(sub, `${name}.jsonl`), text(ri(0, 200)));
        if (rnd() < 0.6)
          writeFileSync(join(sub, `${name}.meta.json`), JSON.stringify({ description: text(ri(0, 40)) }));
      }
      const relPaths = ['main', ...names.map((n) => `subagents/${n}.jsonl`), 'subagents/agent-missing.jsonl'];
      const requests: EditSourceRequest[] = [];
      for (const relPath of relPaths) {
        if (rnd() < 0.5) continue;
        const r: EditSourceRequest = { relPath, offset: ri(0, 350) };
        if (rnd() < 0.4) r.len = ri(0, 250);
        requests.push(r);
      }
      const budget = ri(0, 700);
      const onlyRequested = rnd() < 0.3;
      const local = await readClaudeEditSources(path, requests, budget, { onlyRequested });
      const { code, stdout } = runSh(buildRemoteClaudeEditSourcesCommand(path, requests, budget, { onlyRequested }));
      const remote = code === 0 ? parseRemoteClaudeEditSources(stdout) : null;
      const shape = (r: typeof local) =>
        r && {
          transcriptId: r.transcriptId,
          metas: r.metas,
          files: r.files.map((f) => [f.relPath, f.size, f.startOffset, f.chunk.toString('hex')]),
        };
      try {
        expect(shape(remote)).toEqual(shape(local));
      } catch {
        failures.push(`seed ${seed}: ${JSON.stringify({ requests, budget, onlyRequested })}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('under vitest', () => {
  it('never opens a connection: the lookup and the read reject with a clear error', async () => {
    await expect(remoteLocateClaudeTranscript(REMOTE, ['a'])).rejects.toBeInstanceOf(RemoteFileAccessError);
    await expect(remoteReadClaudeEditSources(REMOTE, '/p/a.jsonl', [], 10)).rejects.toBeInstanceOf(
      RemoteFileAccessError
    );
  });
});

describe('never wakes a host', () => {
  // Invariant: only real user input or an explicit wake request may wake a host. The edit
  // history reads a remote transcript whenever the panel is open, so nothing it can reach may
  // hold the wake registry: a sleeping host must stay asleep and the read ends `unavailable`.
  // `test/remote-wake.test.ts` pins who imports remote-wake; this pins that the edit-history
  // read path reaches neither it nor the route module that owns the registry, transitively.
  const SRC = fileURLToPath(new URL('../src', import.meta.url));
  const ROOTS = [
    'edit-history-local-source.ts',
    'edit-history-parse.ts',
    'edit-history-store.ts',
    'remote-files.ts',
    join('web', 'edit-history-sync.ts'),
    join('web', 'routes', 'edit-history-routes.ts'),
  ];

  function resolveImport(from: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null;
    const base = join(dirname(from), spec).replace(/\.js$/, '');
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        /* next candidate */
      }
    }
    throw new Error(`unresolved import ${spec} in ${relative(SRC, from)}`);
  }

  it('the read path never imports remote-wake or session-routes, even transitively', () => {
    const seen = new Set<string>();
    const queue = ROOTS.map((r) => join(SRC, r));
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf-8');
      // Static imports/re-exports start a line; a dynamic import() counts outside comment lines.
      const specs = [
        ...text.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gms),
        ...text.matchAll(/^(?!\s*(?:\*|\/\/)).*\bimport\(\s*['"]([^'"]+)['"]/gm),
      ].map((m) => m[1]);
      for (const spec of specs) {
        const next = resolveImport(file, spec);
        if (next) queue.push(next);
      }
    }
    const reached = [...seen].map((f) => relative(SRC, f));
    expect(reached).toContain(join('web', 'edit-history-sync.ts'));
    // `config/remote-wake-limits.ts` (the MAC-count constant of the host schema) may be reached; it wakes nothing.
    expect(reached).not.toContain('remote-wake.ts');
    expect(reached).not.toContain(join('web', 'routes', 'session-routes.ts'));
  });
});
