import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentSpawn,
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
    const t = deps([ok({ id: OTHER }), ok({})]);
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
      ok({ id: OTHER }),
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
    const t = deps([ok({ id: OTHER }), ok({})]);
    expect(await agentSpawn(t.d, { ...base, mode: 'shell' })).toBe(EXIT.ok);
    expect(t.calls[1].path).toBe(`/api/v1/sessions/${OTHER}/shell`);
  });
});
