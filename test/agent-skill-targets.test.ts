/**
 * @fileoverview Agent skill per CLI: which workspace directory each CLI's sessions get
 * the one packaged skill in (`capabilities.agentSkillDir`), and the
 * `codeman skill install|uninstall` resolution that follows the registry.
 *
 * The skill is read from the REAL packaged source (`skills/codeman/`), so this also
 * guards that it meets the Agent Skills format every CLI (and the `npx skills`
 * installer) parses: a `name` equal to its directory, lowercase with hyphens, and a
 * description of at most 1024 characters.
 *
 * Pure filesystem and registry tests in a per-test temp dir. Port: N/A.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentSkillDir, agentSkillDirFor, applyAgentSkill, CLAUDE_AGENT_SKILL_DIR } from '../src/hooks-config.js';
import { getCli, listClis } from '../src/config/cli-registry/registry.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { registryAgentSkillDirs, resolveSkillInstallDir } from '../src/cli.js';

const MARKER_PREFIX = '<!-- codeman-managed-agent-skill';
const AGENTS_DIR = '.agents/skills' as const;

/** The frontmatter fields the Agent Skills format defines, with a `>-` folded description joined. */
function frontmatter(skillMd: string): { name?: string; description?: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skillMd);
  if (!match) return {};
  const lines = match[1].split('\n');
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const name = /^name:\s*(.+)$/.exec(lines[i]);
    if (name) out.name = name[1].trim();
    const desc = /^description:\s*(.*)$/.exec(lines[i]);
    if (desc) {
      if (desc[1].trim() === '>-' || desc[1].trim() === '>') {
        const folded: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) folded.push(lines[++i].trim());
        out.description = folded.join(' ');
      } else {
        out.description = desc[1].trim();
      }
    }
  }
  return out;
}

let casePath: string;

beforeEach(async () => {
  casePath = await mkdtemp(join(tmpdir(), 'codeman-agent-skill-dirs-'));
});

afterEach(async () => {
  await rm(casePath, { recursive: true, force: true });
});

describe('the packaged skill meets the Agent Skills format', () => {
  it('skills/codeman/SKILL.md: name equals the directory, description within limits', () => {
    const fm = frontmatter(readFileSync(join(process.cwd(), 'skills', 'codeman', 'SKILL.md'), 'utf-8'));
    expect(fm.name).toBe('codeman');
    expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fm.description, 'description').toBeTruthy();
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
    // It refuses outside Codeman, and says so where every CLI reads first.
    expect(fm.description).toContain('CODEMAN_MUX=1');
  });

  it('is the only packaged skill (one skill for every CLI)', async () => {
    expect(await readdir(join(process.cwd(), 'skills'))).toEqual(['codeman']);
  });
});

describe('applyAgentSkill with a directory', () => {
  it('installs into <case>/.agents/skills/codeman, marker appended, and nothing under .claude', async () => {
    expect(await applyAgentSkill(casePath, true, AGENTS_DIR)).toBe('installed');
    const skillDir = join(casePath, '.agents', 'skills', 'codeman');
    const skillMd = await readFile(join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd.startsWith('---\nname: codeman')).toBe(true);
    expect(skillMd).toContain(MARKER_PREFIX);
    expect(existsSync(join(skillDir, 'reference', 'endpoints.md'))).toBe(true);
    expect(existsSync(join(casePath, '.claude'))).toBe(false);
    expect(await applyAgentSkill(casePath, true, AGENTS_DIR)).toBe('unchanged');
  });

  it('removes it again and prunes the emptied skills dir, never the CLI dir above it', async () => {
    await applyAgentSkill(casePath, true, AGENTS_DIR);
    expect(await applyAgentSkill(casePath, false, AGENTS_DIR)).toBe('removed');
    expect(existsSync(join(casePath, '.agents', 'skills'))).toBe(false);
    expect(existsSync(join(casePath, '.agents'))).toBe(true);
  });

  it('two CLIs sharing one workspace each get an identical copy where they look', async () => {
    await applyAgentSkill(casePath, true, CLAUDE_AGENT_SKILL_DIR);
    await applyAgentSkill(casePath, true, AGENTS_DIR);
    const claudeCopy = await readFile(join(casePath, '.claude', 'skills', 'codeman', 'SKILL.md'), 'utf-8');
    const agentsCopy = await readFile(join(casePath, '.agents', 'skills', 'codeman', 'SKILL.md'), 'utf-8');
    expect(agentsCopy).toBe(claudeCopy);
  });

  it("the default directory is still Claude Code's", async () => {
    expect(await applyAgentSkill(casePath, true)).toBe('installed');
    expect(existsSync(agentSkillDirFor(casePath, CLAUDE_AGENT_SKILL_DIR))).toBe(true);
  });

  it('writes nothing outside the target directory', async () => {
    await mkdir(join(casePath, 'keep'), { recursive: true });
    await applyAgentSkill(casePath, true, AGENTS_DIR);
    expect((await readdir(casePath)).sort()).toEqual(['.agents', 'keep']);
  });
});

describe('agentSkillDir', () => {
  it('is null when the CLI takes no skill', () => {
    expect(agentSkillDir({ agentSkillInjection: false, agentSkillDir: AGENTS_DIR })).toBeNull();
    expect(agentSkillDir(undefined)).toBeNull();
  });

  it("falls back to Claude Code's directory when only the old boolean is set (pre-field clis.json)", () => {
    expect(agentSkillDir({ agentSkillInjection: true })).toBe(CLAUDE_AGENT_SKILL_DIR);
  });

  it('uses the declared directory otherwise', () => {
    expect(agentSkillDir({ agentSkillInjection: true, agentSkillDir: AGENTS_DIR })).toBe(AGENTS_DIR);
  });
});

describe('the stock registry', () => {
  it('pins the per-CLI table (measured 2026-10-11, see AGENTS_DIR_SKILL in stock.ts)', () => {
    const table = Object.fromEntries(
      ['claude', 'codex', 'gemini', 'opencode', 'antigravity', 'pi', 'grok', 'deepseek', 'omp', 'shell'].map((id) => [
        id,
        agentSkillDir(getCli(id)?.capabilities),
      ])
    );
    expect(table).toEqual({
      claude: '.claude/skills',
      codex: AGENTS_DIR,
      gemini: AGENTS_DIR,
      opencode: AGENTS_DIR,
      antigravity: AGENTS_DIR,
      // A project-level skill makes pi ask "Trust project folder?" at startup.
      pi: null,
      grok: AGENTS_DIR,
      deepseek: AGENTS_DIR,
      omp: AGENTS_DIR,
      shell: null,
    });
  });
});

describe('capabilities.agentSkillDir validation (clis.json is user-editable)', () => {
  const withDir = (dir: unknown) => {
    const claude = getCli('claude')!;
    return CliEntrySchema.safeParse({ ...claude, capabilities: { ...claude.capabilities, agentSkillDir: dir } });
  };

  it('accepts a listed directory', () => {
    expect(withDir('.agents/skills').success).toBe(true);
  });

  it('refuses a free path, traversal included', () => {
    expect(withDir('../../.ssh').success).toBe(false);
    expect(withDir('/etc').success).toBe(false);
    expect(withDir('.pi/skills').success).toBe(false);
  });
});

describe('codeman skill install|uninstall follow the registry', () => {
  it('--mode claude (the default) installs into .claude/skills, user-level or per case', () => {
    expect(resolveSkillInstallDir({})).toEqual({ skillDir: CLAUDE_AGENT_SKILL_DIR });
    expect(resolveSkillInstallDir({ mode: 'claude', case: 'x' })).toEqual({ skillDir: CLAUDE_AGENT_SKILL_DIR });
  });

  it('--mode codex installs per case into .agents/skills, and points a user-level install at npx skills', () => {
    expect(resolveSkillInstallDir({ mode: 'codex', case: 'x' })).toEqual({ skillDir: AGENTS_DIR });
    expect(resolveSkillInstallDir({ mode: 'codex' }).error).toContain('npx skills add Ark0N/Codeman --skill codeman -g');
  });

  it('refuses a mode without a skill and an unknown mode', () => {
    expect(resolveSkillInstallDir({ mode: 'shell', case: 'x' }).error).toContain('takes no Codeman agent skill');
    expect(resolveSkillInstallDir({ mode: 'nope', case: 'x' }).error).toContain('Unknown mode');
  });

  it('uninstall --case covers every distinct directory the registry can write, once each', () => {
    const dirs = registryAgentSkillDirs();
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs).toContain(CLAUDE_AGENT_SKILL_DIR);
    for (const cli of listClis()) {
      const dir = agentSkillDir(cli.capabilities);
      if (dir) expect(dirs, cli.id).toContain(dir);
    }
  });
});
