import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentSpawn,
  isHomeDirectory,
  registerAgentCommands,
  EXIT,
  type AgentDeps,
  type ApiResponse,
  type RequestOptions,
} from '../src/cli-agent.js';

const SELF = '058ee7b5-b2aa-4c33-8cc1-e900eb0b28af';
const OTHER = '94990c6d-e461-4a29-aa83-89275327732c';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const ok = (data: unknown): ApiResponse => ({ status: 200, json: { success: true, data }, text: '' });
function deps(responses: ApiResponse[]) {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: AgentDeps = {
    ctx: { selfId: SELF, apiUrl: 'http://127.0.0.1:1' },
    json: true,
    now: Date.now,
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    request: async (_ctx, options) => {
      calls.push(options);
      return responses.shift() ?? ok({});
    },
  };
  return { d, calls, out, err };
}
const base = { mode: 'codex', ready: false, timeoutMs: 1000 };
describe('project-preserving agent spawn', () => {
  it('uses existing session create and interactive endpoints with exact directory and lineage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cod549-project-'));
    dirs.push(directory);
    const t = deps([ok({ session: { id: OTHER } }), ok({})]);
    expect(await agentSpawn(t.d, { ...base, workingDir: directory, name: 'review' })).toBe(EXIT.ok);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/sessions',
      body: { workingDir: directory, mode: 'codex', name: 'review', parentSessionId: SELF },
    });
    expect(t.calls[0].headers ?? {}).not.toHaveProperty('X-Codeman-Agent-Origin');
    expect(t.calls[1]).toMatchObject({ method: 'POST', path: `/api/v1/sessions/${OTHER}/interactive` });
    expect(JSON.parse(t.out[0])).toMatchObject({ sessionId: OTHER, workingDir: directory });
  });
  it('defaults to the current directory when no case is supplied', async () => {
    const t = deps([ok({ session: { id: OTHER } }), ok({})]);
    expect(await agentSpawn(t.d, base)).toBe(EXIT.ok);
    expect(t.calls[0].body).toMatchObject({ workingDir: process.cwd() });
  });
  it('keeps explicit case quick-start behavior', async () => {
    const t = deps([ok({ sessionId: OTHER })]);
    expect(await agentSpawn(t.d, { ...base, caseName: 'scratch' })).toBe(EXIT.ok);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].path).toBe('/api/v1/quick-start');
  });
  it('refuses case and working directory together before network IO', async () => {
    const t = deps([]);
    expect(await agentSpawn(t.d, { ...base, caseName: 'scratch', workingDir: process.cwd() })).toBe(EXIT.refused);
    expect(t.calls).toEqual([]);
  });
  it('refuses missing directories, regular files and unknown modes before creating a session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cod549-project-'));
    dirs.push(directory);
    const file = join(directory, 'file');
    await writeFile(file, 'x');
    for (const options of [{ workingDir: join(directory, 'absent') }, { workingDir: file }, { mode: 'not-a-cli' }]) {
      const t = deps([]);
      expect(await agentSpawn(t.d, { ...base, ...options })).toBe(EXIT.refused);
      expect(t.calls).toEqual([]);
    }
  });
  it('reports the created session ID when startup fails instead of retrying or silently leaking it', async () => {
    const t = deps([
      ok({ session: { id: OTHER } }),
      { status: 400, text: '', json: { success: false, error: 'cannot start', errorCode: 'OPERATION_FAILED' } },
    ]);
    expect(await agentSpawn(t.d, base)).toBe(EXIT.error);
    expect(t.out).toHaveLength(1);
    expect(JSON.parse(t.out.join('\n'))).toMatchObject({ sessionId: OTHER, created: true, ready: false });
    expect(t.calls).toHaveLength(2);
  });
  it('does not request startup when creation is refused', async () => {
    const t = deps([{ status: 403, text: 'Forbidden' }]);
    expect(await agentSpawn(t.d, base)).toBe(EXIT.error);
    expect(t.calls).toHaveLength(1);
  });
  it('retains the exact created ID on an ambiguous startup transport failure without retrying', async () => {
    const t = deps([ok({ session: { id: OTHER } })]);
    const request = t.d.request;
    t.d.request = async (context, options) => {
      if (options.path.endsWith('/interactive')) {
        t.calls.push(options);
        throw new Error('connection lost');
      }
      return request(context, options);
    };
    expect(await agentSpawn(t.d, base)).toBe(EXIT.error);
    expect(t.out).toHaveLength(1);
    expect(JSON.parse(t.out.join('\n'))).toMatchObject({
      sessionId: OTHER,
      created: true,
      startupError: 'connection lost',
    });
    expect(t.calls).toHaveLength(2);
  });
  it('treats an empty startup exception as a failure and keeps the created ID', async () => {
    const t = deps([ok({ session: { id: OTHER } })]);
    const request = t.d.request;
    t.d.request = async (context, options) => {
      if (options.path.endsWith('/interactive')) throw new Error('');
      return request(context, options);
    };
    expect(await agentSpawn(t.d, base)).toBe(EXIT.error);
    expect(t.out).toHaveLength(1);
    expect(JSON.parse(t.out[0])).toMatchObject({
      sessionId: OTHER,
      ready: false,
      startupError: 'Startup request failed',
    });
  });
  it('exposes an optional case and working directory in the CLI', () => {
    const spawn = registerAgentCommands(new Command()).commands.find((command) => command.name() === 'spawn')!;
    expect(spawn.registeredArguments[0].required).toBe(false);
    expect(spawn.options.some((option) => option.long === '--working-dir')).toBe(true);
  });
  it('starts a shell through its registered startMode endpoint', async () => {
    const t = deps([ok({ session: { id: OTHER } }), ok({})]);
    expect(await agentSpawn(t.d, { ...base, mode: 'shell' })).toBe(EXIT.ok);
    expect(t.calls[1].path).toBe(`/api/v1/sessions/${OTHER}/shell`);
  });
  it('a create answer without session.id is a failure, and nothing is started', async () => {
    // `POST /api/sessions` answers `{ session: { id } }`; a bare `{ id }` is not that route.
    const t = deps([ok({ id: OTHER })]);
    expect(await agentSpawn(t.d, base)).toBe(EXIT.error);
    expect(t.calls).toHaveLength(1);
  });
  it('an empty case name goes to quick-start (which refuses it), never to the caller cwd', async () => {
    const t = deps([
      {
        status: 400,
        text: '',
        json: { success: false, error: 'Invalid case name format', errorCode: 'INVALID_INPUT' },
      },
    ]);
    expect(await agentSpawn(t.d, { ...base, caseName: '' })).toBe(EXIT.error);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/quick-start', body: { caseName: '' } });
    expect(t.calls[0].body).not.toHaveProperty('workingDir');
  });
  it('an empty case name with --working-dir is refused like any case plus --working-dir', async () => {
    const t = deps([]);
    expect(await agentSpawn(t.d, { ...base, caseName: '', workingDir: process.cwd() })).toBe(EXIT.refused);
    expect(t.calls).toEqual([]);
  });
  it('an empty or whitespace-only --working-dir is refused before any request, never the caller cwd', async () => {
    for (const workingDir of ['', '   ', '\t']) {
      const t = deps([]);
      expect(await agentSpawn(t.d, { ...base, workingDir })).toBe(EXIT.refused);
      expect(t.calls).toEqual([]);
      expect(t.out.join('\n')).toContain('--working-dir is empty');
    }
  });
  it('with ready on claude: create, then /interactive, then wait-output on the created id', async () => {
    const t = deps([ok({ session: { id: OTHER } }), ok({}), ok({ wait: { matched: true } })]);
    expect(await agentSpawn(t.d, { ...base, mode: 'claude', ready: true })).toBe(EXIT.ok);
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/sessions',
      `POST /api/v1/sessions/${OTHER}/interactive`,
      `GET /api/v1/sessions/${OTHER}/wait-output`,
    ]);
    expect(t.calls[2].query).toMatchObject({ match: 'shift+tab', from: 'buffer' });
    expect(JSON.parse(t.out[0])).toMatchObject({ sessionId: OTHER, created: true, ready: true });
  });
  it('without --json a failed start prints the id alone on stdout, the reason on stderr, and exits 1', async () => {
    const t = deps([
      ok({ session: { id: OTHER } }),
      { status: 400, text: '', json: { success: false, error: 'cannot start', errorCode: 'OPERATION_FAILED' } },
    ]);
    t.d.json = false;
    expect(await agentSpawn(t.d, { ...base, ready: true })).toBe(EXIT.error);
    expect(t.out).toEqual([OTHER]);
    expect(t.err).toHaveLength(1);
    expect(t.err[0]).toContain(`Session ${OTHER} was created but startup failed`);
    expect(t.err[0]).toContain('cannot start');
    expect(t.calls).toHaveLength(2); // no readiness wait after a failed start
  });
});

describe('agent spawn through the real argument parser and transport', () => {
  async function runSpawn(args: string[]) {
    const seen: Array<{ method?: string; url?: string; body: unknown }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
        res
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ success: false, error: 'refused', errorCode: 'INVALID_INPUT' }));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    const saved = { ...process.env };
    const savedExit = process.exitCode;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      Object.assign(process.env, {
        CODEMAN_MUX: '1',
        CODEMAN_API_URL: `http://127.0.0.1:${port}`,
        CODEMAN_SESSION_ID: SELF,
      });
      delete process.env.CODEMAN_PASSWORD;
      const program = new Command();
      program.exitOverride();
      registerAgentCommands(program);
      await program.parseAsync(['node', 'codeman', 'agent', 'spawn', ...args, '--no-ready', '--json']);
      return { seen, exitCode: process.exitCode };
    } finally {
      process.exitCode = savedExit;
      for (const key of ['CODEMAN_MUX', 'CODEMAN_API_URL', 'CODEMAN_SESSION_ID', 'CODEMAN_PASSWORD']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      log.mockRestore();
      error.mockRestore();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  it('`spawn ""` (as `spawn "$CASE"` with CASE unset) reaches quick-start with caseName "" and exits 1', async () => {
    const { seen, exitCode } = await runSpawn(['']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/v1/quick-start', body: { caseName: '' } });
    expect(exitCode).toBe(EXIT.error);
  });
  it('`spawn --working-dir ""` (as `--working-dir "$WT"` with WT unset) sends nothing and exits 4', async () => {
    for (const value of ['', '   ']) {
      const { seen, exitCode } = await runSpawn(['--working-dir', value]);
      expect(seen).toEqual([]);
      expect(exitCode).toBe(EXIT.refused);
    }
  });
  it('`spawn` with no case argument creates in the caller cwd', async () => {
    const { seen, exitCode } = await runSpawn([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/v1/sessions', body: { workingDir: process.cwd() } });
    expect(exitCode).toBe(EXIT.error);
  });
  it('bare `spawn` from a HOME cwd sends nothing and exits 4; `--working-dir <HOME>` is sent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cod549-home-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(home);
    try {
      const bare = await runSpawn([]);
      expect(bare.seen).toEqual([]);
      expect(bare.exitCode).toBe(EXIT.refused);
      const explicit = await runSpawn(['--working-dir', home]);
      expect(explicit.seen).toHaveLength(1);
      expect(explicit.seen[0]).toMatchObject({ url: '/api/v1/sessions', body: { workingDir: home } });
    } finally {
      cwd.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe('agent spawn never treats an implicit HOME cwd as a project', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  async function homeDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'cod549-home-'));
    dirs.push(directory);
    return directory;
  }

  it('refuses a cwd that is HOME with exit 4 before any request and names the explicit flag', async () => {
    const home = await homeDir();
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'cwd').mockReturnValue(home);
    const t = deps([]);
    expect(await agentSpawn(t.d, { ...base, mode: 'claude' })).toBe(EXIT.refused);
    expect(t.calls).toEqual([]);
    expect(JSON.parse(t.out[0]).error).toContain('pass --working-dir ~');
  });
  it('compares realpaths, so a symlinked HOME still matches the cwd it points at', async () => {
    const real = await homeDir();
    const link = join(await homeDir(), 'home-link');
    await symlink(real, link);
    vi.stubEnv('HOME', link);
    vi.spyOn(process, 'cwd').mockReturnValue(real);
    const t = deps([]);
    expect(await agentSpawn(t.d, base)).toBe(EXIT.refused);
    expect(t.calls).toEqual([]);
  });
  it('allows an explicit --working-dir that is HOME, as POST /api/sessions does', async () => {
    const home = await homeDir();
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'cwd').mockReturnValue(home);
    const t = deps([ok({ session: { id: OTHER } }), ok({})]);
    expect(await agentSpawn(t.d, { ...base, workingDir: home })).toBe(EXIT.ok);
    expect(t.calls[0].body).toMatchObject({ workingDir: home });
  });
  it('allows a cwd below HOME', async () => {
    const home = await homeDir();
    const project = join(home, 'src', 'app');
    await mkdir(project, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const t = deps([ok({ session: { id: OTHER } }), ok({})]);
    expect(await agentSpawn(t.d, base)).toBe(EXIT.ok);
    expect(t.calls[0].body).toMatchObject({ workingDir: project });
  });
  it('never throws when HOME cannot be resolved, and compares the resolved paths instead', async () => {
    const missing = join(await homeDir(), 'absent');
    vi.stubEnv('HOME', missing);
    await expect(isHomeDirectory(process.cwd())).resolves.toBe(false);
    await expect(isHomeDirectory(missing)).resolves.toBe(true);
    vi.stubEnv('HOME', '');
    await expect(isHomeDirectory(process.cwd())).resolves.toBe(false);
  });
});

describe('the directory-spawn --json shape is documented the same way everywhere', () => {
  // The wiki wraps lines, so whitespace is normalized before comparing.
  const clause =
    '`{ sessionId, workingDir, created: true }`, plus `ready` when a readiness wait ran, `readinessError` when that call failed, and `startupError` when the start failed';
  for (const file of ['README.md', 'docs/api-reference.md', 'docs/wiki/Driving-Codeman-From-An-Agent.md']) {
    it(file, () => {
      expect(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\s+/g, ' ')).toContain(clause);
    });
  }
});
