/** @fileoverview Agent inspect/stage/submit transport, refusal and file boundaries. */
import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentInspect,
  agentStage,
  agentSubmit,
  registerAgentCommands,
  type AgentDeps,
  type RequestOptions,
} from '../src/cli-agent.js';
import { Command } from 'commander';
const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
function deps() {
  const calls: RequestOptions[] = [],
    output: string[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://localhost:1', selfId: SELF },
    json: true,
    now: () => 1,
    io: { out: (line) => output.push(line), err: () => {} },
    request: async (_ctx, options) => {
      calls.push(options);
      return {
        status: 200,
        text: '',
        json: { success: true, data: { evidence: 'hello', stageId: OTHER, sha256: 'a'.repeat(64) } },
      };
    },
  };
  return { deps, calls, output };
}
it('inspect uses the ownership-checked versioned endpoint with exact bounds and cursor', async () => {
  const d = deps();
  expect(await agentInspect(d.deps, { id: OTHER, maxBytes: 42, since: 'cursor' })).toBe(0);
  expect(d.calls[0]).toMatchObject({
    method: 'GET',
    path: `/api/v1/sessions/${OTHER}/inspect`,
    query: { maxBytes: 42, since: 'cursor' },
  });
  expect(JSON.parse(d.output[0]).evidence).toBe('hello');
  expect(await agentInspect(d.deps, { id: OTHER, maxBytes: 65537 })).toBe(4);
  expect(d.calls).toHaveLength(1);
});
it('stage reads a bounded UTF8 file and never adds Enter; submit sends only receipt and hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-stage-cli-'));
  try {
    const path = join(dir, 'message');
    await writeFile(path, 'hello');
    const d = deps();
    expect(await agentStage(d.deps, { id: OTHER, messageFile: path })).toBe(0);
    expect(d.calls[0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/sessions/${OTHER}/stage`,
      body: { message: 'hello' },
    });
    expect(await agentSubmit(d.deps, { id: OTHER, stageId: OTHER, confirmSha: 'a'.repeat(64) })).toBe(0);
    expect(d.calls[1].body).toEqual({ stageId: OTHER, confirmSha: 'a'.repeat(64) });
    await writeFile(path, 'hello\n');
    expect(await agentStage(d.deps, { id: OTHER, messageFile: path })).toBe(4);
    await writeFile(path, Buffer.from([0xff]));
    expect(await agentStage(d.deps, { id: OTHER, messageFile: path })).toBe(4);
    await writeFile(path, 'x'.repeat(8193));
    expect(await agentStage(d.deps, { id: OTHER, messageFile: path })).toBe(4);
    expect(d.calls).toHaveLength(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('refuses self-target and malformed submission before transport', async () => {
  const d = deps();
  expect(await agentStage(d.deps, { id: SELF, messageFile: '/nonexistent' })).toBe(4);
  expect(await agentSubmit(d.deps, { id: SELF, stageId: OTHER, confirmSha: 'a'.repeat(64) })).toBe(4);
  expect(await agentSubmit(d.deps, { id: OTHER, stageId: OTHER, confirmSha: 'bad' })).toBe(4);
  expect(d.calls).toHaveLength(0);
});
it('registers required file and confirmation options and bounded inspect flags', () => {
  const program = new Command();
  registerAgentCommands(program);
  const commands = program.commands.find((command) => command.name() === 'agent')!.commands;
  for (const name of ['inspect', 'stage', 'submit'])
    expect(commands.some((command) => command.name() === name)).toBe(true);
  expect(
    commands.find((command) => command.name() === 'stage')!.options.find((option) => option.long === '--message-file')
      ?.mandatory
  ).toBe(true);
  expect(
    commands.find((command) => command.name() === 'submit')!.options.find((option) => option.long === '--confirm-sha')
      ?.mandatory
  ).toBe(true);
});
