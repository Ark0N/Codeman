/**
 * @fileoverview Unit tests for the agent-skill injection helpers in hooks-config.ts
 * (`applyAgentSkill`, `installAgentSkillInto`, `removeAgentSkillFrom`).
 *
 * These run against the REAL packaged source (`skills/codeman/` at the repo root),
 * so they double as a guard that the skill files exist and are readable: an npm
 * publish without them would be caught here before the `files` entry silently
 * ignores the missing directory.
 *
 * Pure filesystem tests in a per-test temp dir. Port: N/A.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, readdir, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  applyAgentSkill,
  installAgentSkillInto,
  removeAgentSkillFrom,
  refreshUserAgentSkill,
  seedAgentSessionPreamble,
  removeAgentSessionPreamble,
  pruneAgentSessionPreambles,
} from '../src/hooks-config.js';

const MARKER_PREFIX = '<!-- codeman-managed-agent-skill';

/** Run `fn` against a throwaway XDG cache dir, restoring the env afterwards. */
async function withCacheDir(fn: (cacheDir: string) => Promise<void>): Promise<void> {
  const prevXdg = process.env.XDG_CACHE_HOME;
  const cacheDir = join(casePath, 'xdg-cache');
  process.env.XDG_CACHE_HOME = cacheDir;
  try {
    await fn(cacheDir);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prevXdg;
  }
}

let casePath: string;
const skillDir = () => join(casePath, '.claude', 'skills', 'codeman');

beforeEach(async () => {
  casePath = await mkdtemp(join(tmpdir(), 'codeman-agent-skill-'));
});

afterEach(async () => {
  await rm(casePath, { recursive: true, force: true });
});

describe('installAgentSkillInto / applyAgentSkill(enabled)', () => {
  it('installs SKILL.md (marker appended) and the reference files from the packaged source', async () => {
    const result = await applyAgentSkill(casePath, true);
    expect(result).toBe('installed');

    const skillMd = await readFile(join(skillDir(), 'SKILL.md'), 'utf-8');
    expect(skillMd.startsWith('---\nname: codeman')).toBe(true);
    expect(skillMd).toContain(MARKER_PREFIX);

    // Reference files ride along byte-for-byte (no marker there).
    const sourceEndpoints = await readFile(
      join(process.cwd(), 'skills', 'codeman', 'reference', 'endpoints.md'),
      'utf-8'
    );
    const injectedEndpoints = await readFile(join(skillDir(), 'reference', 'endpoints.md'), 'utf-8');
    expect(injectedEndpoints).toBe(sourceEndpoints);
    expect(existsSync(join(skillDir(), 'reference', 'recipes.md'))).toBe(true);
  });

  it('is idempotent: a second run reports unchanged', async () => {
    await applyAgentSkill(casePath, true);
    expect(await applyAgentSkill(casePath, true)).toBe('unchanged');
  });

  it('refreshes a stale Codeman-managed copy back to the packaged content', async () => {
    await applyAgentSkill(casePath, true);
    const original = await readFile(join(skillDir(), 'SKILL.md'), 'utf-8');
    // Simulate an older injected version: content differs but the marker is intact.
    await writeFile(join(skillDir(), 'SKILL.md'), `stale content\n${MARKER_PREFIX}: old -->\n`);

    expect(await applyAgentSkill(casePath, true)).toBe('refreshed');
    expect(await readFile(join(skillDir(), 'SKILL.md'), 'utf-8')).toBe(original);
  });

  it('never clobbers a user-authored skills/codeman (no marker)', async () => {
    await mkdir(skillDir(), { recursive: true });
    await writeFile(join(skillDir(), 'SKILL.md'), '---\nname: codeman\n---\nmy own skill\n');

    expect(await applyAgentSkill(casePath, true)).toBe('foreign');
    expect(await readFile(join(skillDir(), 'SKILL.md'), 'utf-8')).toContain('my own skill');
    expect(existsSync(join(skillDir(), 'reference'))).toBe(false);
  });

  it('refuses to write through a symlinked skill dir (dogfooding layout)', async () => {
    await mkdir(join(casePath, '.claude', 'skills'), { recursive: true });
    await symlink(join(casePath, 'elsewhere'), skillDir());
    expect(await installAgentSkillInto(skillDir())).toBe('symlink');
  });

  it('refuses to write through a symlinked skills/ parent', async () => {
    await mkdir(join(casePath, 'real-skills'), { recursive: true });
    await mkdir(join(casePath, '.claude'), { recursive: true });
    await symlink(join(casePath, 'real-skills'), join(casePath, '.claude', 'skills'));
    expect(await installAgentSkillInto(skillDir())).toBe('symlink');
    expect(await readdir(join(casePath, 'real-skills'))).toEqual([]);
  });
});

describe('removeAgentSkillFrom / applyAgentSkill(disabled)', () => {
  it('removes our copy and prunes the emptied directories', async () => {
    await applyAgentSkill(casePath, true);
    expect(await applyAgentSkill(casePath, false)).toBe('removed');
    expect(existsSync(skillDir())).toBe(false);
    expect(existsSync(join(casePath, '.claude', 'skills'))).toBe(false);
    // `.claude` itself is not ours to prune.
    expect(existsSync(join(casePath, '.claude'))).toBe(true);
  });

  it('reports absent when there is nothing to remove', async () => {
    expect(await applyAgentSkill(casePath, false)).toBe('absent');
  });

  it('leaves a user-authored copy untouched', async () => {
    await mkdir(skillDir(), { recursive: true });
    await writeFile(join(skillDir(), 'SKILL.md'), 'my own skill\n');
    expect(await applyAgentSkill(casePath, false)).toBe('foreign');
    expect(existsSync(join(skillDir(), 'SKILL.md'))).toBe(true);
  });

  it("preserves a user's extra files in the directory (no rm -rf)", async () => {
    await applyAgentSkill(casePath, true);
    await writeFile(join(skillDir(), 'reference', 'my-notes.md'), 'mine\n');

    expect(await applyAgentSkill(casePath, false)).toBe('removed');
    expect(existsSync(join(skillDir(), 'SKILL.md'))).toBe(false);
    expect(existsSync(join(skillDir(), 'reference', 'endpoints.md'))).toBe(false);
    // The user's file and the directories holding it survive.
    expect(await readFile(join(skillDir(), 'reference', 'my-notes.md'), 'utf-8')).toBe('mine\n');
  });
});

describe('preamble single-source (seed + §0 heredoc parity)', () => {
  const packagedDir = join(process.cwd(), 'skills', 'codeman');

  it("SKILL.md's §0 heredoc is byte-identical to the packaged preamble.sh", async () => {
    const skillMd = await readFile(join(packagedDir, 'SKILL.md'), 'utf-8');
    const openTag = "<<'PREAMBLE'\n";
    const open = skillMd.indexOf(openTag);
    expect(open).toBeGreaterThan(-1);
    const start = open + openTag.length;
    const end = skillMd.indexOf('\nPREAMBLE\n', start);
    expect(end).toBeGreaterThan(start);
    // slice(.., end + 1) keeps the final line's own newline.
    const heredoc = skillMd.slice(start, end + 1);

    // The server seeds preamble.sh while agents that paste §0 write the heredoc; any
    // byte of drift between the two would make the §0 grep rewrite a seeded file (or
    // worse, ship different behavior depending on which path wrote it).
    const preamble = await readFile(join(packagedDir, 'preamble.sh'), 'utf-8');
    expect(preamble).toBe(heredoc);
  });

  it("SKILL.md's shell survives Claude Code's skill-argument substitution unchanged", async () => {
    // When Claude Code loads a skill WITH arguments (the Skill tool passes the user's request words),
    // it rewrites the skill body before the model sees it. Measured on 2.1.300: every `$ARGUMENTS[N]`,
    // `$ARGUMENTS` and bare `$N` (digits, then no word character) becomes the matching argument, 0-based,
    // and a backslash before `$` is consumed as an escape. A bare `$1` in §0 arrived as
    // `sessions/5/terminal` and `timeout=claude` for "start 5 claude workers", so an agent pasting §0
    // wrote a broken preamble. `${1}` is the same bash and is never touched; keep it that way.
    const skillMd = await readFile(join(packagedDir, 'SKILL.md'), 'utf-8');
    const substitute = (body: string, args: string[]): string =>
      body
        .replace(/(?<!\\)\\\$(?=\d|ARGUMENTS)/g, '$')
        .replace(/\$ARGUMENTS\[(\d+)\]/g, (m, i: string) => args[Number(i)] ?? m)
        .replace(/\$(\d+)(?!\w)/g, (m, i: string) => args[Number(i)] ?? m)
        .replaceAll('$ARGUMENTS', args.join(' '));
    const args = 'start 5 claude workers, one per TODO item'.split(/\s+/);
    expect(substitute(skillMd, args)).toBe(skillMd);

    // And the heredoc an agent pastes from the substituted body is still the seeded preamble.
    const rendered = substitute(skillMd, args);
    const start = rendered.indexOf("<<'PREAMBLE'\n") + "<<'PREAMBLE'\n".length;
    const preamble = await readFile(join(packagedDir, 'preamble.sh'), 'utf-8');
    expect(rendered.slice(start, rendered.indexOf('\nPREAMBLE\n', start) + 1)).toBe(preamble);
  });

  it('seedAgentSessionPreamble writes the stamped preamble to the XDG cache path, 0600', async () => {
    const prevXdg = process.env.XDG_CACHE_HOME;
    const cacheDir = join(casePath, 'xdg-cache');
    process.env.XDG_CACHE_HOME = cacheDir;
    try {
      await seedAgentSessionPreamble('seed-test-session');
      const target = join(cacheDir, 'codeman-agent-seed-test-session.sh');
      const content = await readFile(target, 'utf-8');
      expect(content.startsWith('# ---- Codeman agent preamble')).toBe(true);
      expect(content).toMatch(/\nCODEMAN_PREAMBLE=\d+\.\d+\.\d+\n$/);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevXdg;
    }
  });

  it('removeAgentSessionPreamble drops one session cache and shrugs at a missing one', async () => {
    // Seeding writes one file per claude session and nothing used to remove them
    // (236 leftovers measured on a working machine); session teardown calls this.
    await withCacheDir(async (cacheDir) => {
      await seedAgentSessionPreamble('gone-session');
      expect(existsSync(join(cacheDir, 'codeman-agent-gone-session.sh'))).toBe(true);

      await removeAgentSessionPreamble('gone-session');
      expect(existsSync(join(cacheDir, 'codeman-agent-gone-session.sh'))).toBe(false);

      await expect(removeAgentSessionPreamble('never-existed')).resolves.toBeUndefined();
    });
  });

  it('pruneAgentSessionPreambles takes only aged caches with no live session behind them', async () => {
    await withCacheDir(async (cacheDir) => {
      const aged = (name: string) => join(cacheDir, name);
      for (const id of ['live-old', 'dead-old', 'dead-fresh']) {
        await seedAgentSessionPreamble(id);
      }
      // Age two of them past the cutoff; `dead-fresh` stays new.
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await utimes(aged('codeman-agent-live-old.sh'), old, old);
      await utimes(aged('codeman-agent-dead-old.sh'), old, old);
      // An unrelated file in the same cache dir must be invisible to the sweep.
      await writeFile(aged('someone-elses-file.sh'), 'not ours\n');

      const removed = await pruneAgentSessionPreambles(['live-old']);

      expect(removed).toBe(1);
      expect(existsSync(aged('codeman-agent-dead-old.sh'))).toBe(false);
      // A live session's cache is load-bearing: the skill's two-line loader reads it
      // mid-run, so age alone must never take it.
      expect(existsSync(aged('codeman-agent-live-old.sh'))).toBe(true);
      // And a recently-seeded one belongs to a session this process may not know about.
      expect(existsSync(aged('codeman-agent-dead-fresh.sh'))).toBe(true);
      expect(existsSync(aged('someone-elses-file.sh'))).toBe(true);
    });
  });

  it('pruneAgentSessionPreambles reports 0 rather than throwing when there is no cache dir', async () => {
    const prevXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(casePath, 'no-such-cache');
    try {
      expect(await pruneAgentSessionPreambles([])).toBe(0);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevXdg;
    }
  });

  it('seedAgentSessionPreamble falls back to ~/.cache when XDG_CACHE_HOME is unset', async () => {
    const prevXdg = process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CACHE_HOME;
    try {
      await seedAgentSessionPreamble('seed-home-session');
      // setup.ts points HOME at a per-file fixture, so this never touches the real ~.
      const target = join(homedir(), '.cache', 'codeman-agent-seed-home-session.sh');
      expect(existsSync(target)).toBe(true);
    } finally {
      if (prevXdg !== undefined) process.env.XDG_CACHE_HOME = prevXdg;
    }
  });
});

describe('refreshUserAgentSkill (the user-level copy must not rot)', () => {
  const userSkillDir = () => join(homedir(), '.claude', 'skills', 'codeman');

  it('reports absent and installs nothing when there is no user-level copy', async () => {
    expect(await refreshUserAgentSkill()).toBe('absent');
    expect(existsSync(userSkillDir())).toBe(false);
  });

  it('refreshes a stale Codeman-managed user copy back to the packaged content', async () => {
    await mkdir(userSkillDir(), { recursive: true });
    // An old injected version: different content, marker intact. This is the exact
    // shape that shadowed every fresh per-case injection on 2026-08-14.
    await writeFile(join(userSkillDir(), 'SKILL.md'), `old skill body\n\n${MARKER_PREFIX}: installed by Codeman -->\n`);

    expect(await refreshUserAgentSkill()).toBe('refreshed');
    const refreshed = await readFile(join(userSkillDir(), 'SKILL.md'), 'utf-8');
    expect(refreshed.startsWith('---\nname: codeman')).toBe(true);
    expect(existsSync(join(userSkillDir(), 'reference', 'endpoints.md'))).toBe(true);

    // And a second run settles to unchanged.
    expect(await refreshUserAgentSkill()).toBe('unchanged');
  });

  it("leaves a user's own (unmarked) skill alone", async () => {
    await mkdir(userSkillDir(), { recursive: true });
    await writeFile(join(userSkillDir(), 'SKILL.md'), 'my own codeman skill\n');
    expect(await refreshUserAgentSkill()).toBe('foreign');
    expect(await readFile(join(userSkillDir(), 'SKILL.md'), 'utf-8')).toBe('my own codeman skill\n');
  });
});
