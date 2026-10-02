// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseServers, addServers, syncMcpServers, type McpSyncTarget } from '../src/mcp-sync.js';

const TARGETS: McpSyncTarget[] = [
  { id: 'claude', label: 'Claude', path: '.claude.json', format: 'claude-json' },
  { id: 'gemini', label: 'Gemini', path: '.gemini/settings.json', format: 'gemini-json' },
  { id: 'codex', label: 'Codex', path: '.codex/config.toml', format: 'codex-toml' },
  { id: 'antigravity', label: 'Antigravity', path: '.gemini/config/mcp_config.json', format: 'antigravity-json' },
  { id: 'opencode', label: 'OpenCode', path: '.config/opencode/opencode.json', format: 'opencode-json' },
];

let home: string;
const put = (rel: string, text: string) => {
  const file = join(home, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};
const get = (rel: string) => readFileSync(join(home, rel), 'utf8');

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

  it('reads gemini url (sse) vs httpUrl (http) and opencode local/remote', () => {
    const g = parseServers(
      'gemini-json',
      JSON.stringify({
        mcpServers: { a: { url: 'https://a' }, b: { httpUrl: 'https://b' }, c: { command: 'c', args: ['1'] } },
      })
    );
    expect(g.a.transport).toBe('sse');
    expect(g.b.transport).toBe('http');
    expect(g.c).toEqual({ transport: 'stdio', command: 'c', args: ['1'] });
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

  it('throws on unparseable JSON so the file is never written', () => {
    expect(() => parseServers('opencode-json', '{ // jsonc\n}')).toThrow();
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
  it('never lets a server name reach Object.prototype (toml and json)', () => {
    const toml = parseServers(
      'codex-toml',
      '[mcp_servers.__proto__]\ncommand = "x"\npolluted = "yes"\n[mcp_servers.ok]\ncommand = "y"\n'
    );
    expect(Object.keys(toml)).toEqual(['ok']);
    const json = parseServers(
      'claude-json',
      '{"mcpServers":{"__proto__":{"command":"x"},"constructor":{"command":"x"},"ok":{"command":"y"}}}'
    );
    expect(Object.keys(json)).toEqual(['ok']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });

  it('rejects a non-object server table instead of overwriting it', () => {
    expect(() => parseServers('claude-json', '{"mcpServers":[]}')).toThrow();
    expect(() => parseServers('claude-json', '[]')).toThrow();
  });
});

describe('addServers', () => {
  it('preserves other keys and existing servers, appends codex tables without touching the rest', () => {
    const out = JSON.parse(
      addServers('claude-json', JSON.stringify({ theme: 'dark', mcpServers: { keep: { command: 'k' } } }), {
        keep: { transport: 'stdio', command: 'OVERWRITE' },
        n: { transport: 'stdio', command: 'n' },
      })
    );
    expect(out.theme).toBe('dark');
    expect(out.mcpServers.keep).toEqual({ command: 'k' });
    expect(out.mcpServers.n.command).toBe('n');

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
});

describe('syncMcpServers', () => {
  const claudeFile = JSON.stringify({
    numStartups: 3,
    mcpServers: { fs: { type: 'stdio', command: 'npx', args: ['-y', 'fs'], env: { T: 's3cret' } } },
  });

  it('passes the unsupported list through to the result', async () => {
    const r = await syncMcpServers(TARGETS, { apply: false, home }, ['Pi']);
    expect(r.unsupported).toEqual(['Pi']);
  });

  it('previews without writing and never leaks env values', async () => {
    put('.claude.json', claudeFile);
    const r = await syncMcpServers(TARGETS, { apply: false, home });
    expect(r.applied).toBe(false);
    expect(r.targets.find((t) => t.id === 'gemini')!.added).toEqual(['fs']);
    expect(existsSync(join(home, '.gemini/settings.json'))).toBe(false);
    expect(JSON.stringify(r)).not.toContain('s3cret');
  });

  it('adds missing servers to every other CLI, keeps a backup, is idempotent', async () => {
    put('.claude.json', claudeFile);
    put('.codex/config.toml', 'model = "gpt-5"\n[mcp_servers.web]\nurl = "https://w"\n');
    const r = await syncMcpServers(TARGETS, { apply: true, home });
    expect(r.targets.find((t) => t.id === 'claude')!.added).toEqual(['web']);
    expect(r.targets.find((t) => t.id === 'codex')!.added).toEqual(['fs']);
    expect(JSON.parse(get('.claude.json')).numStartups).toBe(3);
    expect(Object.keys(JSON.parse(get('.gemini/settings.json')).mcpServers).sort()).toEqual(['fs', 'web']);
    expect(JSON.parse(get('.config/opencode/opencode.json')).mcp.fs.command).toEqual(['npx', '-y', 'fs']);
    expect(get('.codex/config.toml')).toContain('model = "gpt-5"');
    expect(existsSync(join(home, '.claude.json.codeman-bak'))).toBe(true);

    const again = await syncMcpServers(TARGETS, { apply: true, home });
    expect(again.targets.every((t) => t.added.length === 0)).toBe(true);
  });

  it('reports conflicts without overwriting, skips what a dialect cannot express, leaves unreadable files alone', async () => {
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
    expect(r.targets.find((t) => t.id === 'codex')!.skipped).toEqual(['sse']);
    expect(r.targets.find((t) => t.id === 'opencode')!.status).toBe('unreadable');
    expect(get('.config/opencode/opencode.json')).toBe(broken);
  });
});
