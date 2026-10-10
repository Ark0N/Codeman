/**
 * @fileoverview Inventory tests for the real commander program in `src/cli.ts`.
 *
 * Everything here walks the actual `program` object. The previous version of
 * this file asserted against a hand-written fixture array (with its own arg
 * parser), so it could not see a command being renamed, losing an alias or
 * disappearing entirely, and it happily described a `tui` command that did not
 * exist. Assertions are deliberately "at least this exists", so adding a new
 * command does not fail the suite.
 */

import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { program } from '../src/cli.js';

/** Resolve a subcommand the way commander does, by name or alias. */
function find(parent: Command, name: string): Command | undefined {
  return parent.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

/** Every `-x` / `--long` flag a command registers. */
function flagsOf(cmd: Command): string[] {
  return cmd.options.flatMap((option) => [option.short, option.long].filter((f): f is string => Boolean(f)));
}

/** Depth-first walk over the whole command tree, including the root. */
function walk(cmd: Command, path: string[] = []): Array<{ path: string[]; cmd: Command }> {
  const here = [...path, cmd.name()];
  return [{ path: here, cmd }, ...cmd.commands.flatMap((child) => walk(child, here))];
}

/** Top-level commands and the aliases they must keep. */
const TOP_LEVEL: Record<string, string[]> = {
  attach: [],
  skill: [],
  agent: [],
  session: ['s'],
  task: ['t'],
  ralph: ['r'],
  status: [],
  reset: [],
  start: [],
  list: ['ls'],
  tui: [],
  web: [],
  service: [],
  users: [],
  doctor: ['check-deps'],
};

/** Subcommands per parent, with their aliases. */
const SUBCOMMANDS: Record<string, Record<string, string[]>> = {
  session: { start: [], stop: [], list: ['ls'], logs: [] },
  task: { add: [], list: ['ls'], status: [], remove: ['rm'], clear: [] },
  ralph: { start: [], stop: [], status: [] },
  skill: { install: [], uninstall: [] },
  agent: { ls: ['list'], spawn: [], send: [], wait: [], read: [], interrupt: [], rm: [] },
  service: { install: [], uninstall: [], status: [] },
  users: { add: [], passwd: [], list: ['ls'], rm: [] },
};

describe('registered commands', () => {
  it('is the codeman program', () => {
    expect(program.name()).toBe('codeman');
  });

  it.each(Object.entries(TOP_LEVEL))('registers `%s` with its aliases', (name, aliases) => {
    const cmd = find(program, name);
    expect(cmd, `top-level command "${name}" is missing`).toBeDefined();
    expect(cmd!.name()).toBe(name);
    expect(cmd!.aliases()).toEqual(expect.arrayContaining(aliases));
  });

  it.each(Object.entries(SUBCOMMANDS))('registers the `%s` subcommands', (parentName, children) => {
    const parent = find(program, parentName)!;
    for (const [name, aliases] of Object.entries(children)) {
      const child = find(parent, name);
      expect(child, `${parentName} ${name} is missing`).toBeDefined();
      expect(child!.name()).toBe(name);
      expect(child!.aliases()).toEqual(expect.arrayContaining(aliases));
    }
  });

  it('gives every command a description', () => {
    const missing = walk(program)
      .slice(1)
      .filter(({ cmd }) => !cmd.description())
      .map(({ path }) => path.join(' '));
    expect(missing).toEqual([]);
  });

  it('never registers the same name or alias twice at one level', () => {
    for (const { path, cmd } of walk(program)) {
      const taken = cmd.commands.flatMap((child) => [child.name(), ...child.aliases()]);
      expect(new Set(taken).size, `duplicate command name/alias under "${path.join(' ')}"`).toBe(taken.length);
    }
  });

  it('resolves commands by alias, not just by name', () => {
    expect(find(program, 's')?.name()).toBe('session');
    expect(find(program, 't')?.name()).toBe('task');
    expect(find(program, 'r')?.name()).toBe('ralph');
    expect(find(program, 'ls')?.name()).toBe('list');
    expect(find(program, 'check-deps')?.name()).toBe('doctor');
    expect(find(find(program, 'session')!, 'ls')?.name()).toBe('list');
  });

  it('has no command for an unknown name', () => {
    expect(find(program, 'unknown')).toBeUndefined();
  });
});

describe('registered options', () => {
  it('exposes the web launch flags', () => {
    const flags = flagsOf(find(program, 'web')!);
    expect(flags).toEqual(
      expect.arrayContaining([
        '-H',
        '--host',
        '-p',
        '--port',
        '--https',
        '--title-hostname',
        '--allow-unauthenticated-network',
        '--multiuser',
        '-d',
        '--daemon',
        '--stop',
        '--status',
      ])
    );
  });

  it('gives `service install` the same launch flags as `web`', () => {
    const install = flagsOf(find(find(program, 'service')!, 'install')!);
    expect(install).toEqual(expect.arrayContaining(['-H', '--host', '-p', '--port', '--https', '--multiuser']));
  });

  it('keeps `doctor --json` and `--category`', () => {
    expect(flagsOf(find(program, 'doctor')!)).toEqual(expect.arrayContaining(['--json', '--category']));
  });

  it('keeps the two `tui` fast paths that scripts call', () => {
    expect(flagsOf(find(program, 'tui')!)).toEqual(expect.arrayContaining(['-l', '--list']));
  });

  it('keeps the escape hatches that scripts depend on', () => {
    expect(flagsOf(find(program, 'reset')!)).toEqual(expect.arrayContaining(['-f', '--force']));
    expect(flagsOf(find(program, 'status')!)).toEqual(expect.arrayContaining(['--url']));
    expect(flagsOf(find(program, 'attach')!)).toEqual(expect.arrayContaining(['-s', '--session', '--url']));
    const users = find(program, 'users')!;
    expect(flagsOf(find(users, 'add')!)).toEqual(expect.arrayContaining(['--admin', '--password-stdin']));
    expect(flagsOf(find(users, 'passwd')!)).toEqual(expect.arrayContaining(['--password-stdin']));
    expect(flagsOf(find(users, 'rm')!)).toEqual(expect.arrayContaining(['--delete-space']));
  });

  it('takes a working directory for the session commands', () => {
    expect(flagsOf(find(find(program, 'session')!, 'start')!)).toEqual(expect.arrayContaining(['-d', '--dir']));
    expect(flagsOf(find(program, 'start')!)).toEqual(expect.arrayContaining(['-d', '--dir']));
  });

  it('scopes skill install/uninstall to a case', () => {
    const skill = find(program, 'skill')!;
    for (const name of ['install', 'uninstall']) {
      expect(flagsOf(find(skill, name)!)).toEqual(expect.arrayContaining(['-g', '--global', '-c', '--case']));
    }
  });
});

describe('registered arguments', () => {
  it.each([
    ['attach', ['path']],
    ['start', []],
    // Optional: bare `codeman tui` opens the dashboard.
    ['tui', ['n']],
  ])('declares the operands of `%s`', (name, expected) => {
    const args = find(program, name)!.registeredArguments.map((arg) => arg.name());
    expect(args).toEqual(expected);
  });

  it('requires an id for the commands that act on one session or task', () => {
    const session = find(program, 'session')!;
    expect(find(session, 'stop')!.registeredArguments.map((a) => a.name())).toEqual(['id']);
    expect(find(session, 'logs')!.registeredArguments.map((a) => a.name())).toEqual(['id']);
    const task = find(program, 'task')!;
    expect(find(task, 'status')!.registeredArguments.map((a) => a.name())).toEqual(['id']);
    expect(find(task, 'remove')!.registeredArguments.map((a) => a.name())).toEqual(['id']);
  });
});

describe('help text', () => {
  it('documents the unauthenticated network override in the real web command help', () => {
    const help = find(program, 'web')!.helpInformation();
    expect(help).toContain('--allow-unauthenticated-network');
    expect(help).toMatch(/without\s+CODEMAN_PASSWORD/);
  });

  it('describes `attach` as the attachment card command, not a hook context', () => {
    const help = find(program, 'attach')!.helpInformation();
    expect(help).toContain('attachment card');
    expect(help).not.toContain('hook context');
  });

  it('lists every top-level command in the root help', () => {
    const help = program.helpInformation();
    for (const name of Object.keys(TOP_LEVEL)) {
      expect(help).toContain(name);
    }
  });
});
