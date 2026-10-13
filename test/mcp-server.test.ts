/**
 * @fileoverview `codeman mcp` (src/mcp-server.ts): the dual-era MCP protocol core, the
 * seven tools against a recording fake transport, and one end-to-end run of the real
 * CLI over stdio against a local fake Codeman.
 *
 * Pinned invariants: no guessed URL (unconfigured = tools answer how to configure, list
 * still works); prompting/interrupting/deleting only sessions this server started (or
 * the calling session's own children, or with --allow-any-session), never itself;
 * control bytes refused before any request; tool failures are `isError` results;
 * cancellation aborts the HTTP call and sends nothing for that id.
 *
 * The protocol and tool tests need no port. The stdio test binds a raw http server on
 * port 0 and reads `address().port`.
 */

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildToolDefinitions,
  createMcpServer,
  createToolRunner,
  DEFAULT_WAIT_MS,
  MAX_OUTPUT_CHARS,
  resolveMcpConfig,
  RPC_ERROR,
  type McpConfig,
} from '../src/mcp-server.js';
import type { ApiRequest, ApiResponse, RequestOptions } from '../src/cli-agent.js';

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

const SELF = 'aaaaaaaa-0000-0000-0000-000000000000';
const MINE = 'bbbbbbbb-1111-1111-1111-111111111111';
const USERS = 'cccccccc-2222-2222-2222-222222222222';
const CHILD = 'dddddddd-3333-3333-3333-333333333333';

function config(overrides: Partial<McpConfig> = {}): McpConfig {
  return { apiUrl: 'http://127.0.0.1:9', allowAnySession: false, version: '0.0.0-test', ...overrides };
}

function ok(data: unknown): ApiResponse {
  return { status: 200, json: { success: true, data }, text: JSON.stringify({ success: true, data }) };
}

interface FakeCall extends RequestOptions {
  url: string;
}

/** A fake Codeman: a session list plus per-route answers; records every call. */
function fakeCodeman(
  rows: Array<Record<string, unknown>> = [
    { id: SELF, name: 'lead', mode: 'claude', status: 'busy' },
    { id: USERS, name: 'w1-myapp', mode: 'claude', status: 'idle' },
    { id: CHILD, name: 'child', mode: 'codex', status: 'idle', parentSessionId: SELF },
  ],
  answers: Record<string, (call: FakeCall) => ApiResponse | Promise<ApiResponse>> = {}
): { request: ApiRequest; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const request: ApiRequest = async (ctx, options) => {
    const call = { ...options, url: ctx.apiUrl };
    calls.push(call);
    const key = `${options.method} ${options.path}`;
    for (const [pattern, answer] of Object.entries(answers)) {
      if (key === pattern || (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1)))) return answer(call);
    }
    if (key === 'GET /api/v1/sessions') return ok(rows);
    if (key === 'POST /api/v1/quick-start') {
      rows.push({ id: MINE, name: 'worker', mode: String(options.body?.mode ?? 'claude'), status: 'idle' });
      return ok({
        sessionId: MINE,
        caseName: options.body?.caseName,
        casePath: `/cases/${String(options.body?.caseName)}`,
      });
    }
    if (key.endsWith('/wait-output')) return ok({ wait: { matched: true, match: options.query?.match } });
    if (key.endsWith('/input'))
      return ok({ delivered: true, wait: { signal: 'stop', until: ['stop', 'idle', 'exit'] } });
    if (options.method === 'DELETE') return ok({});
    return { status: 404, json: { success: false, error: 'not found', errorCode: 'NOT_FOUND' }, text: '' };
  };
  return { request, calls };
}

function runner(cfg: McpConfig, fake = fakeCodeman()) {
  return {
    ...fake,
    tools: createToolRunner({ config: cfg, request: fake.request, started: new Set(), clientId: 'c', now: () => 1 }),
  };
}

/** Drive the protocol core; returns every message it wrote. */
function server(cfg: McpConfig = config(), fake = fakeCodeman()) {
  const out: Array<Record<string, unknown>> = [];
  const srv = createMcpServer({
    config: cfg,
    write: (m) => out.push(m),
    request: fake.request,
    modes: ['claude', 'codex', 'shell'],
  });
  const send = async (message: unknown) => srv.handleLine(JSON.stringify(message));
  return { srv, out, send, ...fake };
}

describe('protocol: both eras', () => {
  it('answers a legacy initialize with the requested revision, or its newest legacy one', async () => {
    const { out, send } = server();
    await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    await send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2030-01-01' } });
    const [first, second] = out as Array<{ result: Record<string, unknown> }>;
    expect(first.result.protocolVersion).toBe('2025-06-18');
    expect(first.result.serverInfo).toMatchObject({ name: 'codeman' });
    expect(first.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(first.result.resultType).toBeUndefined();
    expect(second.result.protocolVersion).toBe('2025-11-25');
  });

  it('serves server/discover with resultType, supported versions and serverInfo in _meta', async () => {
    const { out, send } = server();
    await send({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: MODERN_META } });
    const result = (out[0] as { result: Record<string, unknown> }).result;
    expect(result.resultType).toBe('complete');
    expect(result.supportedVersions).toEqual(['2026-07-28']);
    expect((result._meta as Record<string, unknown>)['io.modelcontextprotocol/serverInfo']).toMatchObject({
      name: 'codeman',
    });
  });

  it('rejects an unsupported modern version with -32022 listing what it supports', async () => {
    const { out, send } = server();
    await send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: { _meta: { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } },
    });
    expect(out[0]).toMatchObject({
      id: 3,
      error: {
        code: RPC_ERROR.unsupportedProtocolVersion,
        data: { supported: ['2026-07-28'], requested: '1999-01-01' },
      },
    });
  });

  it('rejects a modern request without clientCapabilities as invalid params', async () => {
    const { out, send } = server();
    await send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    });
    expect(out[0]).toMatchObject({ id: 4, error: { code: RPC_ERROR.invalidParams } });
  });

  it('lists the same seven tools in a fixed order, decorated for the era', async () => {
    const { out, send } = server();
    await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: MODERN_META } });
    const legacy = (out[0] as { result: { tools: Array<{ name: string }>; resultType?: string } }).result;
    const modern = (out[1] as { result: { tools: Array<{ name: string }>; resultType?: string } }).result;
    const names = [
      'list_sessions',
      'start_session',
      'send_prompt',
      'wait_for_session',
      'read_output',
      'interrupt_session',
      'delete_session',
    ];
    expect(legacy.tools.map((t) => t.name)).toEqual(names);
    expect(modern.tools.map((t) => t.name)).toEqual(names);
    expect(legacy.resultType).toBeUndefined();
    expect(modern.resultType).toBe('complete');
  });

  it('puts the caching hints the modern revision requires on tools/list and server/discover', async () => {
    // Claude Code 2.1.296 validates these and drops every tool when they are missing.
    const { out, send } = server();
    await send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: MODERN_META } });
    await send({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: MODERN_META } });
    for (const message of out as Array<{ result: { ttlMs?: unknown; cacheScope?: unknown } }>) {
      expect(typeof message.result.ttlMs).toBe('number');
      expect(message.result.ttlMs as number).toBeGreaterThanOrEqual(0);
      expect(['public', 'private']).toContain(message.result.cacheScope);
    }
  });

  it('answers protocol faults with JSON-RPC errors and notifications with nothing', async () => {
    const { out, srv, send } = server();
    await srv.handleLine('{not json');
    await send([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    await send({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } });
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    expect(out.map((m) => (m as { error?: { code: number } }).error?.code ?? 'ok')).toEqual([
      RPC_ERROR.parse,
      RPC_ERROR.invalidRequest,
      RPC_ERROR.methodNotFound,
      RPC_ERROR.invalidParams,
      'ok',
    ]);
    expect(out[0]).toMatchObject({ id: null });
  });

  it('a cancelled call aborts its HTTP request and is never answered', async () => {
    let seen: AbortSignal | undefined;
    const fake = fakeCodeman(undefined, {
      'GET /api/v1/sessions/*': (call) =>
        new Promise((_resolve, reject) => {
          seen = call.signal;
          call.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const { srv, out, send } = server(config(), fake);
    const pending = send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'wait_for_session', arguments: { session_id: USERS, until: ['stop'] } },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(srv.inflightCount()).toBe(1);
    await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    await pending;
    expect(seen?.aborted).toBe(true);
    expect(out).toEqual([]);
    expect(srv.inflightCount()).toBe(0);
  });

  it('a tool failure is an isError result, not a protocol error', async () => {
    const { out, send } = server(config({ apiUrl: undefined }));
    await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } });
    const result = (out[0] as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CODEMAN_API_URL');
  });
});

describe('tool definitions', () => {
  it('every tool has an object input schema and honest annotations', () => {
    for (const tool of buildToolDefinitions(['claude'])) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.description.length, tool.name).toBeGreaterThan(80);
      expect(tool.annotations.openWorldHint).toBe(false);
    }
    const byName = Object.fromEntries(buildToolDefinitions(['claude']).map((t) => [t.name, t]));
    for (const readOnly of ['list_sessions', 'wait_for_session', 'read_output']) {
      expect(byName[readOnly].annotations.readOnlyHint, readOnly).toBe(true);
    }
    expect(byName.delete_session.annotations.destructiveHint).toBe(true);
  });

  it('start_session offers the run modes it is given, defaulting to claude', () => {
    const start = buildToolDefinitions(['claude', 'codex']).find((t) => t.name === 'start_session')!;
    const mode = (start.inputSchema.properties as Record<string, { enum?: string[]; default?: string }>).mode;
    expect(mode.enum).toEqual(['claude', 'codex']);
    expect(mode.default).toBe('claude');
  });
});

describe('configuration never guesses a server', () => {
  it('takes --url over CODEMAN_API_URL, and neither means unconfigured', () => {
    const env = { CODEMAN_API_URL: 'https://127.0.0.1:3000/' };
    expect(resolveMcpConfig({ version: 'x' }, env, () => ({})).apiUrl).toBe('https://127.0.0.1:3000');
    expect(resolveMcpConfig({ url: 'http://10.0.0.2:5000', version: 'x' }, env, () => ({})).apiUrl).toBe(
      'http://10.0.0.2:5000'
    );
    expect(resolveMcpConfig({ version: 'x' }, {}, () => ({})).apiUrl).toBeUndefined();
  });

  it('refuses a URL that is not http(s)', () => {
    const cfg = resolveMcpConfig({ url: 'file:///etc/passwd', version: 'x' }, {}, () => ({}));
    expect(cfg.apiUrl).toBeUndefined();
    expect(cfg.urlError).toContain('not an http(s) URL');
  });

  it('knows its own session only inside a Codeman pane', () => {
    expect(resolveMcpConfig({ version: 'x' }, { CODEMAN_MUX: '1', CODEMAN_SESSION_ID: SELF }, () => ({})).selfId).toBe(
      SELF
    );
    expect(resolveMcpConfig({ version: 'x' }, { CODEMAN_SESSION_ID: SELF }, () => ({})).selfId).toBeUndefined();
  });

  it('an unconfigured tool call makes no request at all', async () => {
    const { tools, calls } = runner(config({ apiUrl: undefined }));
    const result = await tools.run('start_session', { case: 'x' });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('who may be prompted, interrupted and deleted', () => {
  it('refuses a session this server did not start, with how to allow it, and sends nothing', async () => {
    const { tools, calls } = runner(config());
    for (const [tool, args] of [
      ['send_prompt', { session_id: USERS, text: 'hi' }],
      ['interrupt_session', { session_id: USERS }],
      ['delete_session', { session_id: USERS }],
    ] as const) {
      const result = await tools.run(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.text).toContain('--allow-any-session');
    }
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('a session it started is fair game, and leaves the allowlist once deleted', async () => {
    const { tools, calls } = runner(config());
    const started = await tools.run('start_session', { case: 'review-1', mode: 'codex' });
    expect(started.structured?.session_id).toBe(MINE);
    expect((await tools.run('send_prompt', { session_id: MINE, text: 'go', wait: false })).isError).toBe(false);
    expect((await tools.run('delete_session', { session_id: MINE.slice(0, 8) })).isError).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/v1/sessions/${MINE}`)).toBe(true);
    expect((await tools.run('send_prompt', { session_id: MINE, text: 'again' })).isError).toBe(true);
  });

  it('inside Codeman, the calling session can drive its own children', async () => {
    const { tools } = runner(config({ selfId: SELF }));
    expect((await tools.run('send_prompt', { session_id: CHILD, text: 'go', wait: false })).isError).toBe(false);
    expect((await tools.run('send_prompt', { session_id: USERS, text: 'go', wait: false })).isError).toBe(true);
  });

  it('--allow-any-session opens every session except its own', async () => {
    const { tools } = runner(config({ selfId: SELF, allowAnySession: true }));
    expect((await tools.run('send_prompt', { session_id: USERS, text: 'go', wait: false })).isError).toBe(false);
    const self = await tools.run('delete_session', { session_id: SELF });
    expect(self.isError).toBe(true);
    expect(self.text).toContain('the session this server runs in');
  });

  it('list_sessions marks the caller and what it may control', async () => {
    const { tools } = runner(config({ selfId: SELF }));
    const sessions = (await tools.run('list_sessions', {})).structured?.sessions as Array<Record<string, unknown>>;
    expect(sessions.map((s) => [s.short_id, s.you, s.controllable])).toEqual([
      ['aaaaaaaa', true, false],
      ['cccccccc', false, false],
      ['dddddddd', false, true],
    ]);
  });
});

describe('the tools', () => {
  it('start_session posts quick-start with lineage and the scratch label, then waits for the ready mark', async () => {
    const { tools, calls } = runner(config({ selfId: SELF }));
    const result = await tools.run('start_session', { case: 'review-1', mode: 'claude', name: 'rev' });
    const post = calls.find((c) => c.path === '/api/v1/quick-start')!;
    expect(post.body).toEqual({ caseName: 'review-1', mode: 'claude', parentSessionId: SELF, sessionName: 'rev' });
    expect(post.headers).toEqual({ 'X-Codeman-Agent-Origin': 'codeman-mcp' });
    const ready = calls.find((c) => c.path.endsWith('/wait-output'))!;
    expect(ready.query?.timeout).toBe(DEFAULT_WAIT_MS);
    expect(result.structured).toMatchObject({ session_id: MINE, ready: true });
  });

  it('start_session still returns the session id when only the readiness call fails', async () => {
    const busy = fakeCodeman(undefined, {
      'GET /api/v1/sessions/*': () => ({
        status: 429,
        json: { success: false, error: 'too many waiters', errorCode: 'WAIT_CAPACITY' },
        text: '',
      }),
    });
    const result = await runner(config(), busy).tools.run('start_session', { case: 'review-2', mode: 'claude' });
    expect(result.isError).toBeFalsy();
    expect(result.structured).toMatchObject({ session_id: MINE, ready: null });
    expect(String(result.structured?.note)).toContain('readiness check failed');
  });

  it('send_prompt refuses a newline or control byte before any request', async () => {
    const { tools, calls } = runner(config());
    for (const text of ['line one\nline two', 'esc \u001b[A', 'tab\there']) {
      expect((await tools.run('send_prompt', { session_id: USERS, text })).isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('send_prompt says when "finished" is definite and when it is a quiet-screen guess', async () => {
    const quiet = fakeCodeman(undefined, {
      'POST /api/v1/sessions/*': () => ok({ delivered: true, wait: { signal: 'idle', until: ['idle', 'exit'] } }),
    });
    const { tools } = runner(config({ allowAnySession: true }), quiet);
    const guessed = await tools.run('send_prompt', { session_id: USERS, text: 'go' });
    expect(guessed.structured).toMatchObject({ outcome: 'finished', signal: 'idle' });
    expect(String(guessed.structured?.note)).toContain('not definite');

    const definite = runner(config({ allowAnySession: true }));
    const finished = await definite.tools.run('send_prompt', { session_id: USERS, text: 'go' });
    expect(String(finished.structured?.note)).toContain('finished its turn');
    const input = definite.calls.find((c) => c.path.endsWith('/input'))!;
    expect(input.body).toMatchObject({ input: 'go\r', useMux: true, wait: true, waitTimeout: DEFAULT_WAIT_MS });
  });

  it('send_prompt reports a still-working timeout and a dead pane distinctly', async () => {
    const slow = fakeCodeman(undefined, {
      'POST /api/v1/sessions/*': () => ok({ delivered: true, wait: { signal: null, timedOut: true } }),
    });
    expect(
      (
        await runner(config({ allowAnySession: true }), slow).tools.run('send_prompt', {
          session_id: USERS,
          text: 'go',
        })
      ).structured
    ).toMatchObject({ outcome: 'still_working' });
    const dead = fakeCodeman(undefined, { 'POST /api/v1/sessions/*': () => ok({ delivered: false }) });
    const result = await runner(config({ allowAnySession: true }), dead).tools.run('send_prompt', {
      session_id: USERS,
      text: 'go',
    });
    expect(result.isError).toBe(true);
    expect(result.structured).toMatchObject({ outcome: 'not_delivered' });
  });

  it('input seq stays strictly increasing within one millisecond, across send_prompt and interrupt_session', async () => {
    // The runner's clock is frozen at 1: the server drops a repeated seq while still answering 200.
    const { tools, calls } = runner(config({ allowAnySession: true }));
    await tools.run('send_prompt', { session_id: USERS, text: 'one', wait: false });
    await tools.run('send_prompt', { session_id: USERS, text: 'two', wait: false });
    await tools.run('interrupt_session', { session_id: USERS });
    const seqs = calls.filter((c) => c.path.endsWith('/input')).map((c) => c.body?.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('wait_for_session needs exactly one of until and match, and passes a marker literally', async () => {
    const { tools, calls } = runner(config());
    expect((await tools.run('wait_for_session', { session_id: USERS })).isError).toBe(true);
    expect((await tools.run('wait_for_session', { session_id: USERS, until: ['stop'], match: 'X' })).isError).toBe(
      true
    );
    const matched = await tools.run('wait_for_session', { session_id: USERS, match: 'DONE_7f3a' });
    expect(matched.structured).toMatchObject({ outcome: 'matched' });
    expect(calls.at(-1)?.query).toMatchObject({ match: 'DONE_7f3a', from: 'buffer', timeout: DEFAULT_WAIT_MS });
  });

  it('read_output strips the terminal of escape codes and keeps its tail under the cap, as text only', async () => {
    const huge = `\u001b[31mred\u001b[0m${'x'.repeat(MAX_OUTPUT_CHARS + 500)}END`;
    const fake = fakeCodeman(undefined, { 'GET /api/v1/sessions/*': () => ok({ terminalBuffer: huge }) });
    const result = await runner(config(), fake).tools.run('read_output', { session_id: USERS, source: 'terminal' });
    const [note, body] = [
      result.text.slice(0, result.text.indexOf('\n')),
      result.text.slice(result.text.indexOf('\n') + 1),
    ];
    expect(note).toBe(`[showing the last ${MAX_OUTPUT_CHARS} of ${MAX_OUTPUT_CHARS + 506} characters]`);
    expect(body.length).toBe(MAX_OUTPUT_CHARS);
    expect(body.endsWith('END')).toBe(true);
    expect(result.text).not.toContain('\u001b');
    // No structuredContent: a client that prefers it would show the model metadata, not
    // the output (measured with Claude Code, a terminal read came back "empty").
    expect(result.structured).toBeUndefined();
  });

  it('read_output tidies a pane capture: LF line ends, blank runs collapsed, no trailing blanks', async () => {
    const pane = 'one\r\ntwo   \r\n\r\n\r\n\r\nthree\r\n\r\n\r\n';
    const fake = fakeCodeman(undefined, { 'GET /api/v1/sessions/*': () => ok({ terminalBuffer: pane }) });
    const result = await runner(config(), fake).tools.run('read_output', { session_id: USERS, source: 'terminal' });
    expect(result.text).toBe('one\ntwo\n\nthree');
  });

  it('read_output says what to try when there is no answer yet', async () => {
    const fake = fakeCodeman(undefined, { 'GET /api/v1/sessions/*': () => ok({ text: '' }) });
    const result = await runner(config(), fake).tools.run('read_output', { session_id: USERS });
    expect(result.text).toContain('source terminal');
  });

  it('refuses a session id shorter than 8 characters and an ambiguous prefix', async () => {
    const twins = [{ id: 'eeeeeeee-1111-1111-1111-111111111111' }, { id: 'eeeeeeee-2222-2222-2222-222222222222' }];
    const { tools } = runner(config(), fakeCodeman(twins));
    expect((await tools.run('read_output', { session_id: 'eeee' })).text).toContain('shorter than 8');
    expect((await tools.run('read_output', { session_id: 'eeeeeeee' })).text).toContain('ambiguous');
  });
});

describe('codeman mcp over real stdio', () => {
  it('handshakes and lists sessions from a live (fake) Codeman', async () => {
    const api = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/sessions') {
        res.end(JSON.stringify({ success: true, data: [{ id: USERS, name: 'w1', mode: 'claude', status: 'idle' }] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: 'nope' }));
      }
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const port = (api.address() as AddressInfo).port;
    try {
      const env = { ...process.env, CODEMAN_API_URL: `http://127.0.0.1:${port}` };
      delete env.CODEMAN_MUX;
      delete env.CODEMAN_SESSION_ID;
      const child = spawn('npx', ['tsx', 'src/index.ts', 'mcp'], { cwd: process.cwd(), env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const lines = () => stdout.split('\n').filter(Boolean);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } })}\n`
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } })}\n`
      );
      const deadline = Date.now() + 25_000;
      while (lines().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      child.stdin.end();
      const exitCode = await new Promise<number | null>((resolve) => child.on('exit', resolve));

      const messages = lines().map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(messages.map((m) => m.id)).toEqual([1, 2]);
      const listed = (messages[1].result as { structuredContent: { sessions: Array<{ id: string }> } })
        .structuredContent;
      expect(listed.sessions.map((s) => s.id)).toEqual([USERS]);
      expect(stderr).toContain(`driving http://127.0.0.1:${port}`);
      expect(exitCode).toBe(0);
    } finally {
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  }, 40_000);
});

describe('the MCP registry manifest (config/mcp-registry/server.json)', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'config', 'mcp-registry', 'server.json'), 'utf-8'));
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));

  it("carries the name package.json's mcpName declares (the registry's ownership check)", () => {
    expect(manifest.name).toBe(pkg.mcpName);
    expect(manifest.description.length).toBeLessThanOrEqual(100);
  });

  it('runs this npm package as `<bin> mcp` over stdio, at the package version (sync-plugin.mjs keeps it)', () => {
    expect(manifest.version).toBe(pkg.version);
    const [npm] = manifest.packages;
    expect(npm).toMatchObject({
      registryType: 'npm',
      identifier: pkg.name,
      version: pkg.version,
      transport: { type: 'stdio' },
      packageArguments: [{ type: 'positional', value: 'mcp' }],
    });
    const env = Object.fromEntries(npm.environmentVariables.map((v: { name: string }) => [v.name, v]));
    expect(env.CODEMAN_API_URL.isRequired).toBe(true);
    expect(env.CODEMAN_PASSWORD.isSecret).toBe(true);
  });
});
