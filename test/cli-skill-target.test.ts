/**
 * @fileoverview Tests for `codeman skill install|uninstall` target resolution
 * (`resolveCliCasePath` / `resolveSkillTargetPath` in src/cli.ts).
 *
 * The linked-cases lookup shipped in 1.14.2 with no guard: before it, `--case`
 * rejected every case linked in from outside `~/codeman-cases` with "Case not
 * found" even though the server resolved the same name fine. These tests pin both
 * halves of that resolution (registry first, cases dir as fallback) and the
 * tolerance rules around a missing or malformed registry.
 *
 * `test/setup.ts` gives this file its own temporary HOME, so `homedir()` and
 * `dataPath()` already point into a per-file fixture: no os mocking needed.
 * Port: N/A (pure path resolution, no server).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataPath } from '../src/config/instance.js';
import { safeRmHomeTree } from './mocks/index.js';
import { program, resolveCliCasePath, resolveSkillTargetPath } from '../src/cli.js';
import { getCasesDir } from '../src/config/cases-dir.js';

const LINKED_CASES_FILE = dataPath('linked-cases.json');
const CASES_DIR = join(homedir(), 'codeman-cases');
const LINKED_ROOT = join(homedir(), 'elsewhere');

/** Where the packaged skill lands under a case. Mirrors `applyAgentSkill()`. */
function skillDirIn(casePath: string): string {
  return join(casePath, '.claude', 'skills', 'codeman');
}

function writeLinkedCases(content: string): void {
  mkdirSync(dataPath(), { recursive: true });
  writeFileSync(LINKED_CASES_FILE, content, 'utf-8');
}

beforeEach(() => {
  rmSync(LINKED_CASES_FILE, { force: true });
  safeRmHomeTree(CASES_DIR);
  safeRmHomeTree(LINKED_ROOT);
});

afterEach(() => {
  // LINKED_CASES_FILE is dataPath('linked-cases.json'), which test/setup.ts
  // sandboxes (temp HOME, and an inherited CODEMAN_DATA_DIR is stripped), so a
  // plain delete is safe here. The case trees still go through the containment
  // gate as defense in depth.
  rmSync(LINKED_CASES_FILE, { force: true });
  safeRmHomeTree(CASES_DIR);
  safeRmHomeTree(LINKED_ROOT);
});

describe('resolveSkillTargetPath (global)', () => {
  it('targets the user-scope skill dir when no --case is given', () => {
    expect(resolveSkillTargetPath({})).toEqual({
      target: join(homedir(), '.claude', 'skills', 'codeman'),
    });
  });

  it('never consults the linked-cases registry for the global target', () => {
    // A registry entry named after nothing in particular must not divert the
    // global install, which is not case-scoped at all.
    writeLinkedCases(JSON.stringify({ anything: join(LINKED_ROOT, 'anything') }));
    expect(resolveSkillTargetPath({}).target).toBe(join(homedir(), '.claude', 'skills', 'codeman'));
  });
});

describe('resolveCliCasePath / resolveSkillTargetPath (--case)', () => {
  it('resolves a LINKED case through linked-cases.json, not the cases dir', () => {
    // The 1.14.2 regression: a case linked in from outside ~/codeman-cases was
    // resolved to a cases-dir path that does not exist, so install refused it.
    const linkedPath = join(LINKED_ROOT, 'my-repo');
    mkdirSync(linkedPath, { recursive: true });
    writeLinkedCases(JSON.stringify({ 'my-repo': linkedPath }));

    expect(resolveCliCasePath('my-repo')).toBe(linkedPath);
    expect(resolveSkillTargetPath({ case: 'my-repo' })).toEqual({ target: skillDirIn(linkedPath) });
    expect(existsSync(join(CASES_DIR, 'my-repo'))).toBe(false);
  });

  it('falls back to the cases dir for a name the registry does not list', () => {
    const casePath = join(CASES_DIR, 'plain-case');
    mkdirSync(casePath, { recursive: true });
    writeLinkedCases(JSON.stringify({ 'other-case': join(LINKED_ROOT, 'other-case') }));

    expect(resolveCliCasePath('plain-case')).toBe(casePath);
    expect(resolveSkillTargetPath({ case: 'plain-case' })).toEqual({ target: skillDirIn(casePath) });
  });

  it('reports the resolved path instead of exiting when the case does not exist', () => {
    // process.exit(1) lives in the CLI wrapper on purpose: calling it here would
    // kill the test runner.
    expect(resolveSkillTargetPath({ case: 'nope' })).toEqual({ missingCase: join(CASES_DIR, 'nope') });
  });

  it('reports the LINKED path when the registry points at a directory that is gone', () => {
    const linkedPath = join(LINKED_ROOT, 'moved-away');
    writeLinkedCases(JSON.stringify({ 'moved-away': linkedPath }));

    expect(resolveSkillTargetPath({ case: 'moved-away' })).toEqual({ missingCase: linkedPath });
  });
});

describe('linked-cases.json tolerance', () => {
  const casePath = () => join(CASES_DIR, 'tolerant');

  beforeEach(() => {
    mkdirSync(casePath(), { recursive: true });
  });

  it('degrades to the cases dir when the registry file is absent', () => {
    expect(existsSync(LINKED_CASES_FILE)).toBe(false);
    expect(resolveSkillTargetPath({ case: 'tolerant' })).toEqual({ target: skillDirIn(casePath()) });
  });

  it('degrades to the cases dir on malformed JSON rather than throwing', () => {
    writeLinkedCases('{ not json at all');
    expect(() => resolveCliCasePath('tolerant')).not.toThrow();
    expect(resolveSkillTargetPath({ case: 'tolerant' })).toEqual({ target: skillDirIn(casePath()) });
  });

  it('degrades to the cases dir when the registry is valid JSON of the wrong shape', () => {
    // A null / array / non-string-valued entry must read as "no linked case",
    // never as a target path.
    for (const body of ['null', '[]', JSON.stringify({ tolerant: 42 }), JSON.stringify({ tolerant: '' })]) {
      writeLinkedCases(body);
      expect(resolveCliCasePath('tolerant')).toBe(casePath());
    }
  });
});

describe('skill command wiring', () => {
  it('registers install and uninstall, both accepting --case and --global, install also --mode', () => {
    const skill = program.commands.find((cmd) => cmd.name() === 'skill');
    expect(skill).toBeDefined();

    const subcommands = skill!.commands.map((cmd) => cmd.name());
    expect(subcommands).toEqual(expect.arrayContaining(['install', 'uninstall']));

    const flagsOf = (name: string) =>
      skill!.commands
        .find((cmd) => cmd.name() === name)!
        .options.map((opt) => opt.long)
        .sort();
    // --mode picks the skill and directory that run mode reads (capabilities.agentSkill);
    // uninstall needs none, since --case removes every Codeman-managed copy.
    expect(flagsOf('install')).toEqual(['--case', '--global', '--mode']);
    expect(flagsOf('uninstall')).toEqual(['--case', '--global']);
  });
});

describe('cases dir override (CODEMAN_CASES_PATH)', () => {
  // The Docker Compose deployment points Codeman at a host-absolute bind mount
  // so a Docker case resolves to the same path inside the container and on the
  // host daemon. The override shipped on the server's CASES_DIR only, which left
  // the CLI looking in the home default: `codeman skill install --case <name>`
  // then reported "Case not found" on exactly the deployment it exists for.
  const saved = process.env.CODEMAN_CASES_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEMAN_CASES_PATH;
    else process.env.CODEMAN_CASES_PATH = saved;
  });

  it('moves the CLI and the server together', () => {
    process.env.CODEMAN_CASES_PATH = '/srv/codeman-cases';
    expect(getCasesDir()).toBe('/srv/codeman-cases');
    expect(resolveCliCasePath('demo')).toBe(join('/srv/codeman-cases', 'demo'));
  });

  it('falls back to the home default when unset', () => {
    delete process.env.CODEMAN_CASES_PATH;
    expect(getCasesDir()).toBe(CASES_DIR);
    expect(resolveCliCasePath('demo')).toBe(join(CASES_DIR, 'demo'));
  });

  it('still lets a linked case win over the override', () => {
    // The registry lookup runs first, so a case linked in from outside the cases
    // dir keeps resolving to its real location under Compose too.
    process.env.CODEMAN_CASES_PATH = '/srv/codeman-cases';
    writeLinkedCases(JSON.stringify({ linked: join(LINKED_ROOT, 'linked') }));
    expect(resolveCliCasePath('linked')).toBe(join(LINKED_ROOT, 'linked'));
  });
});
