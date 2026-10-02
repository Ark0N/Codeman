// @vitest-environment node
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addServers, McpSyncBusyError, parseServers, syncMcpServers, type McpSyncTarget } from '../src/mcp-sync.js';

const TARGETS: McpSyncTarget[] = [
  { id: 'claude', label: 'Claude', path: '.claude.json', format: 'claude-json', installed: true },
  { id: 'gemini', label: 'Gemini', path: '.gemini/settings.json', format: 'gemini-json', installed: true },
  { id: 'codex', label: 'Codex', path: '.codex/config.toml', format: 'codex-toml', installed: true },
  {
    id: 'antigravity',
    label: 'Antigravity',
    path: '.gemini/config/mcp_config.json',
    format: 'antigravity-json',
    installed: true,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    path: '.config/opencode/opencode.json',
    format: 'opencode-json',
    installed: true,
  },
];

let home: string;
const put = (rel: string, text: string) => {
  const file = join(home, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};
const get = (rel: string) => readFileSync(join(home, rel), 'utf8');
const target = (id: string, patch: Partial<McpSyncTarget> = {}) => ({
  ...TARGETS.find((t) => t.id === id)!,
  ...patch,
});
const only = (...ids: string[]) => TARGETS.filter((t) => ids.includes(t.id));
const result = (r: Awaited<ReturnType<typeof syncMcpServers>>, id: string) => r.targets.find((t) => t.id === id)!;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mcp-sync-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('dialect parsing', () => {
  it('reads codex TOML tables, inline tables and multi-line arrays', () => {
    const servers = parseServers(
      'codex-toml',
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.fs]',
        'command = "npx"',
        'args = [',
        '  "-y", # comment',
        '  "@mcp/fs",',
        ']',
        'env = { TOKEN = "abc" }',
        '',
        '[mcp_servers."a.b".env]',
        'K = "v"',
        '',
        '[mcp_servers."a.b"]',
        'command = "x"',
        '',
        '[mcp_servers.web]',
        'url = "https://x.test/mcp"',
        '[mcp_servers.web.http_headers]',
        'Authorization = "Bearer t"',
      ].join('\n')
    );
    expect(servers.fs).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', '@mcp/fs'], env: { TOKEN: 'abc' } });
    expect(servers['a.b']).toEqual({ transport: 'stdio', command: 'x', env: { K: 'v' } });
    expect(servers.web).toEqual({
      transport: 'http',
      url: 'https://x.test/mcp',
      headers: { Authorization: 'Bearer t' },
    });
  });

  it('reads CRLF codex files (the old offset math saw no servers at all)', () => {
    const servers = parseServers('codex-toml', '[mcp_servers.fs]\r\ncommand = "npx"\r\nargs = ["-y"]\r\n');
    expect(servers.fs).toEqual({ transport: 'stdio', command: 'npx', args: ['-y'] });
  });

  it('reads gemini url (sse) vs httpUrl / type http, and opencode local/remote', () => {
    const g = parseServers(
      'gemini-json',
      JSON.stringify({
        mcpServers: {
          a: { url: 'https://a' },
          b: { httpUrl: 'https://b' },
          c: { command: 'c', args: ['1'] },
          d: { url: 'https://d', type: 'http' },
        },
      })
    );
    expect(g.a.transport).toBe('sse');
    expect(g.b.transport).toBe('http');
    expect(g.c).toEqual({ transport: 'stdio', command: 'c', args: ['1'] });
    expect(g.d.transport).toBe('http');
    const o = parseServers(
      'opencode-json',
      JSON.stringify({
        mcp: {
          l: { type: 'local', command: ['npx', '-y', 'x'], environment: { A: '1' } },
          r: { type: 'remote', url: 'https://r' },
        },
      })
    );
    expect(o.l).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } });
    expect(o.r).toEqual({ transport: 'http', url: 'https://r' });
  });

  it('throws on unparseable files so they are never written', () => {
    expect(() => parseServers('opencode-json', '{ // jsonc\n}')).toThrow();
    expect(() => parseServers('codex-toml', '[mcp_servers.a]\ncommand="x"\n[mcp_servers.a]\ncommand="y"\n')).toThrow();
  });
});

describe('real CLI output (captured from `agy`/`gemini`/`codex mcp add`)', () => {
  it('reads and writes the antigravity dialect', () => {
    const real = JSON.stringify({
      mcpServers: {
        fs: { args: ['-y', '@mcp/fs'], command: 'npx', disabled: false, env: { K: 'v' } },
        web: { disabled: false, headers: { Authorization: 'Bearer T' }, serverUrl: 'https://x.test/mcp' },
      },
    });
    const servers = parseServers('antigravity-json', real);
    expect(servers.fs).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', '@mcp/fs'], env: { K: 'v' } });
    expect(servers.web).toEqual({
      transport: 'http',
      url: 'https://x.test/mcp',
      headers: { Authorization: 'Bearer T' },
    });
    const out = JSON.parse(
      addServers('antigravity-json', null, { ...servers, s: { transport: 'sse', url: 'https://s' } })
    );
    expect(out.mcpServers.web.serverUrl).toBe('https://x.test/mcp');
    expect(out.mcpServers.fs.disabled).toBe(false);
    expect(out.mcpServers.s).toBeUndefined();
  });

  it('writes gemini http/sse as url + type, as `gemini mcp add` does', () => {
    const out = JSON.parse(
      addServers('gemini-json', null, {
        web: { transport: 'http', url: 'https://x.test/mcp', headers: { A: 'b' } },
        s: { transport: 'sse', url: 'https://x.test/sse' },
      })
    );
    expect(out.mcpServers.web).toEqual({ url: 'https://x.test/mcp', type: 'http', headers: { A: 'b' } });
    expect(out.mcpServers.s).toEqual({ url: 'https://x.test/sse', type: 'sse' });
    expect(parseServers('gemini-json', JSON.stringify(out)).web.transport).toBe('http');
  });

  it('reads codex output as written by `codex mcp add`', () => {
    const real =
      '[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "@mcp/fs"]\n\n[mcp_servers.fs.env]\nK = "v"\n\n[mcp_servers.web]\nurl = "https://x.test/mcp"\n';
    const servers = parseServers('codex-toml', real);
    expect(servers.fs).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', '@mcp/fs'], env: { K: 'v' } });
    expect(servers.web).toEqual({ transport: 'http', url: 'https://x.test/mcp' });
  });
});

describe('hostile config files', () => {
  it('never lets a server name or a sub-table key reach Object.prototype', () => {
    const toml = parseServers(
      'codex-toml',
      [
        '[mcp_servers.__proto__]',
        'command = "x"',
        'polluted = "yes"',
        '[mcp_servers.fs.__proto__]',
        'polluted = "yes"',
        '[mcp_servers.fs]',
        'command = "y"',
        '[mcp_servers.toString]',
        'command = "t"',
        'call = "x"',
      ].join('\n')
    );
    expect(Object.keys(toml).sort()).toEqual(['fs', 'toString']);
    const json = parseServers(
      'claude-json',
      '{"mcpServers":{"__proto__":{"command":"x"},"constructor":{"command":"x"},"hasOwnProperty":{"command":"h"},"ok":{"command":"y"}}}'
    );
    expect(Object.keys(json).sort()).toEqual(['hasOwnProperty', 'ok']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).command).toBeUndefined();
    expect(typeof Object.prototype.toString.call).toBe('function');
  });

  it('treats servers named like Object.prototype members as ordinary names across CLIs', async () => {
    put(
      '.claude.json',
      JSON.stringify({ mcpServers: { toString: { command: 'a' }, hasOwnProperty: { command: 'b' } } })
    );
    put('.gemini/settings.json', JSON.stringify({ mcpServers: {} }));
    const r = await syncMcpServers(only('claude', 'gemini'), { apply: true, home });
    expect(r.conflicts).toEqual([]);
    expect(result(r, 'gemini').added.sort()).toEqual(['hasOwnProperty', 'toString']);
    expect(Object.keys(JSON.parse(get('.gemini/settings.json')).mcpServers).sort()).toEqual([
      'hasOwnProperty',
      'toString',
    ]);
  });

  it('rejects a non-object server table instead of overwriting it', () => {
    expect(() => parseServers('claude-json', '{"mcpServers":[]}')).toThrow();
    expect(() => parseServers('claude-json', '[]')).toThrow();
  });
});

describe('addServers', () => {
  it('preserves other keys and existing servers', () => {
    const out = JSON.parse(
      addServers('claude-json', JSON.stringify({ theme: 'dark', mcpServers: { keep: { command: 'k' } } }), {
        keep: { transport: 'stdio', command: 'OVERWRITE' },
        n: { transport: 'stdio', command: 'n' },
      })
    );
    expect(out.theme).toBe('dark');
    expect(out.mcpServers.keep).toEqual({ command: 'k' });
    expect(out.mcpServers.n.command).toBe('n');
  });

  it('appends codex tables without touching the rest, and quotes odd names', () => {
    const toml = addServers('codex-toml', 'model = "x"\n', {
      'we ird': { transport: 'stdio', command: 'c', args: ['a"b'], env: { K: 'v' } },
    });
    expect(toml.startsWith('model = "x"\n')).toBe(true);
    expect(parseServers('codex-toml', toml)['we ird']).toEqual({
      transport: 'stdio',
      command: 'c',
      args: ['a"b'],
      env: { K: 'v' },
    });
  });

  it.each([
    ['CRLF line endings', '[mcp_servers.fs]\r\ncommand = "npx"\r\n'],
    ['an [mcp_servers] table with inline tables', '[mcp_servers]\nfs = { command = "npx" }\n'],
    ['a table with neither command nor url', '[mcp_servers.fs]\nstartup_timeout_sec = 30\n'],
  ])('never appends a second [mcp_servers.fs] to a codex file with %s', (_label, existing) => {
    const out = addServers('codex-toml', existing, {
      fs: { transport: 'stdio', command: 'other' },
      extra: { transport: 'stdio', command: 'e' },
    });
    // Still valid TOML (a duplicate header would throw), fs untouched, extra added.
    const doc = parseToml(out) as { mcp_servers: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.mcp_servers).sort()).toEqual(['extra', 'fs']);
    expect(doc.mcp_servers.fs.command === 'other').toBe(false);
    expect(out.startsWith(existing)).toBe(true);
    if (existing.includes('\r\n')) expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('refuses to write when the result would not read back as intended', () => {
    // A name TOML cannot carry as a bare key still round-trips (quoted); a duplicate cannot.
    expect(() => addServers('codex-toml', '[mcp_servers.a]\ncommand="x"\n[mcp_servers.a]\n', {})).toThrow();
  });
});

describe('disabled servers are not propagated', () => {
  it('codex enabled=false, opencode enabled:false and antigravity disabled:true stay where they are', async () => {
    put('.codex/config.toml', '[mcp_servers.off_codex]\ncommand = "a"\nenabled = false\n');
    put(
      '.config/opencode/opencode.json',
      JSON.stringify({ mcp: { off_oc: { type: 'local', command: ['b'], enabled: false } } })
    );
    put(
      '.gemini/config/mcp_config.json',
      JSON.stringify({ mcpServers: { off_agy: { command: 'c', disabled: true } } })
    );
    put('.claude.json', JSON.stringify({ mcpServers: { live: { type: 'stdio', command: 'l' } } }));
    mkdirSync(join(home, '.gemini'), { recursive: true });
    put('.gemini/settings.json', '{}');
    const r = await syncMcpServers(TARGETS, { apply: true, home });
    expect(r.disabled).toEqual(['off_agy', 'off_codex', 'off_oc']);
    expect(Object.keys(JSON.parse(get('.claude.json')).mcpServers)).toEqual(['live']);
    expect(Object.keys(JSON.parse(get('.gemini/settings.json')).mcpServers)).toEqual(['live']);
    // ...and each CLI still gets the live one.
    expect(get('.codex/config.toml')).toContain('[mcp_servers.live]');
    expect(get('.codex/config.toml')).not.toContain('off_oc');
    // The switched-off entry itself is left as it was (still disabled).
    expect(get('.codex/config.toml')).toContain('enabled = false');
    expect(JSON.parse(get('.config/opencode/opencode.json')).mcp.off_oc.enabled).toBe(false);
    expect(JSON.parse(get('.gemini/config/mcp_config.json')).mcpServers.off_agy.disabled).toBe(true);
  });

  it('a name switched off in one CLI and live in another is still synced from the live one', async () => {
    put('.codex/config.toml', '[mcp_servers.fs]\ncommand = "a"\nenabled = false\n');
    put('.claude.json', JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'a' } } }));
    put('.gemini/settings.json', '{}');
    const r = await syncMcpServers(only('claude', 'codex', 'gemini'), { apply: true, home });
    expect(r.disabled).toEqual([]);
    expect(result(r, 'gemini').added).toEqual(['fs']);
  });
});

describe('syncMcpServers', () => {
  const claudeFile = JSON.stringify({
    numStartups: 3,
    mcpServers: { fs: { type: 'stdio', command: 'npx', args: ['-y', 'fs'], env: { T: 's3cret' } } },
  });
  const setUpAll = () => {
    for (const d of ['.gemini/config', '.codex', '.config/opencode']) mkdirSync(join(home, d), { recursive: true });
    put('.gemini/settings.json', '{}');
    put('.codex/config.toml', '');
    put('.config/opencode/opencode.json', '{}');
    put('.gemini/config/mcp_config.json', '{}');
  };

  it('previews without writing and never leaks env values', async () => {
    setUpAll();
    put('.claude.json', claudeFile);
    const before = get('.gemini/settings.json');
    const r = await syncMcpServers(TARGETS, { apply: false, home });
    expect(r.applied).toBe(false);
    expect(result(r, 'gemini').added).toEqual(['fs']);
    expect(get('.gemini/settings.json')).toBe(before);
    expect(JSON.stringify(r)).not.toContain('s3cret');
  });

  it('adds missing servers to every other CLI, keeps a backup, is idempotent', async () => {
    setUpAll();
    put('.claude.json', claudeFile);
    put('.codex/config.toml', 'model = "gpt-5"\n[mcp_servers.web]\nurl = "https://w"\n');
    const r = await syncMcpServers(TARGETS, { apply: true, home });
    expect(result(r, 'claude').added).toEqual(['web']);
    expect(result(r, 'codex').added).toEqual(['fs']);
    expect(JSON.parse(get('.claude.json')).numStartups).toBe(3);
    expect(Object.keys(JSON.parse(get('.gemini/settings.json')).mcpServers).sort()).toEqual(['fs', 'web']);
    expect(JSON.parse(get('.config/opencode/opencode.json')).mcp.fs.command).toEqual(['npx', '-y', 'fs']);
    expect(get('.codex/config.toml')).toContain('model = "gpt-5"');
    expect(existsSync(join(home, '.claude.json.codeman-bak'))).toBe(true);

    const again = await syncMcpServers(TARGETS, { apply: true, home });
    expect(again.targets.every((t) => t.added.length === 0)).toBe(true);
  });

  it('reports conflicts without overwriting, skips what a dialect cannot express, leaves unreadable files alone', async () => {
    setUpAll();
    put(
      '.claude.json',
      JSON.stringify({ mcpServers: { x: { command: 'one' }, sse: { type: 'sse', url: 'https://s' } } })
    );
    put('.gemini/settings.json', JSON.stringify({ mcpServers: { x: { command: 'two' } } }));
    const broken = '{ // jsonc\n "mcp": {} }';
    put('.config/opencode/opencode.json', broken);
    const r = await syncMcpServers(TARGETS, { apply: true, home });
    expect(r.conflicts).toEqual(['x']);
    expect(JSON.parse(get('.gemini/settings.json')).mcpServers.x.command).toBe('two');
    expect(result(r, 'codex').skipped).toEqual(['sse']);
    expect(result(r, 'opencode').status).toBe('unreadable');
    expect(get('.config/opencode/opencode.json')).toBe(broken);
  });

  it('passes the unsupported list through to the result', async () => {
    const r = await syncMcpServers(TARGETS, { apply: false, home }, ['Pi']);
    expect(r.unsupported).toEqual(['Pi']);
  });

  describe('only CLIs that are installed or already have a config file take part', () => {
    it('never creates config for a CLI that is neither installed nor configured', async () => {
      put('.claude.json', claudeFile);
      const notInstalled = TARGETS.map((t) => (t.id === 'claude' ? t : { ...t, installed: false }));
      const r = await syncMcpServers(notInstalled, { apply: true, home });
      for (const id of ['gemini', 'codex', 'antigravity', 'opencode']) expect(result(r, id).status).toBe('absent');
      expect(existsSync(join(home, '.codex'))).toBe(false);
      expect(existsSync(join(home, '.gemini'))).toBe(false);
      expect(existsSync(join(home, '.config'))).toBe(false);
    });

    it('a CLI that is not detected as installed still takes part if its config file exists', async () => {
      put('.claude.json', claudeFile);
      put('.gemini/settings.json', '{}');
      const r = await syncMcpServers([target('claude'), target('gemini', { installed: false })], { apply: true, home });
      expect(result(r, 'gemini').added).toEqual(['fs']);
    });

    it('an installed CLI with no config yet gets one created', async () => {
      put('.claude.json', claudeFile);
      const r = await syncMcpServers([target('claude'), target('codex')], { apply: true, home });
      expect(result(r, 'codex').added).toEqual(['fs']);
      expect(get('.codex/config.toml')).toContain('[mcp_servers.fs]');
    });
  });

  describe('file safety', () => {
    it('leaves a file that receives env values or headers readable by its owner only', async () => {
      put('.claude.json', claudeFile);
      put('.gemini/settings.json', '{}');
      chmodSync(join(home, '.gemini/settings.json'), 0o664);
      await syncMcpServers(only('claude', 'gemini'), { apply: true, home });
      expect(statSync(join(home, '.gemini/settings.json')).mode & 0o777).toBe(0o600);
    });

    it('keeps the existing mode when nothing secret is copied', async () => {
      put('.claude.json', JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'npx' } } }));
      put('.gemini/settings.json', '{}');
      chmodSync(join(home, '.gemini/settings.json'), 0o664);
      await syncMcpServers(only('claude', 'gemini'), { apply: true, home });
      expect(statSync(join(home, '.gemini/settings.json')).mode & 0o777).toBe(0o664);
    });

    it('writes through a symlinked config instead of replacing the link', async () => {
      put('.claude.json', claudeFile);
      mkdirSync(join(home, 'dotfiles'), { recursive: true });
      writeFileSync(join(home, 'dotfiles/gemini-settings.json'), '{}');
      mkdirSync(join(home, '.gemini'), { recursive: true });
      symlinkSync(join(home, 'dotfiles/gemini-settings.json'), join(home, '.gemini/settings.json'));
      await syncMcpServers(only('claude', 'gemini'), { apply: true, home });
      expect(lstatSync(join(home, '.gemini/settings.json')).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(join(home, 'dotfiles/gemini-settings.json'), 'utf8')).mcpServers.fs.command).toBe(
        'npx'
      );
      expect(existsSync(join(home, 'dotfiles/gemini-settings.json.codeman-bak'))).toBe(true);
    });

    it('reports a dangling symlink as failed and writes nothing', async () => {
      put('.claude.json', claudeFile);
      mkdirSync(join(home, '.gemini'), { recursive: true });
      symlinkSync(join(home, 'nowhere.json'), join(home, '.gemini/settings.json'));
      const r = await syncMcpServers(only('claude', 'gemini'), { apply: true, home });
      expect(result(r, 'gemini').status).toBe('failed');
      expect(existsSync(join(home, 'nowhere.json'))).toBe(false);
    });

    it('refuses a second apply while one is running, and leaves no temp files behind', async () => {
      put('.claude.json', claudeFile);
      put('.gemini/settings.json', '{}');
      const first = syncMcpServers(only('claude', 'gemini'), { apply: true, home });
      await expect(syncMcpServers(only('claude', 'gemini'), { apply: true, home })).rejects.toBeInstanceOf(
        McpSyncBusyError
      );
      await first;
      // A preview is read-only and is never refused.
      await expect(syncMcpServers(only('claude', 'gemini'), { apply: false, home })).resolves.toBeDefined();
      // ...and the lock is released afterwards.
      await expect(syncMcpServers(only('claude', 'gemini'), { apply: true, home })).resolves.toBeDefined();
      const leftovers = readdirSync(join(home, '.gemini')).filter((f) => f.includes('codeman-tmp'));
      expect(leftovers).toEqual([]);
    });
  });
});
