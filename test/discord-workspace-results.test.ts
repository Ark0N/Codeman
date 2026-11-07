import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discordWorkspaceResults, discordWorkspaceHasChanges } from '../src/discord-workspace-results.js';
const exec = promisify(execFile);
describe('Discord workspace result export', () => {
  it('labels a shared snapshot and filters secret, symlink and deleted paths before diff export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-diff-test-'));
    const git = (...args: string[]) => exec('git', args, { cwd: dir });
    try {
      await git('init', '-q');
      await writeFile(join(dir, 'example.ts'), 'export const value = 1;\n');
      await writeFile(join(dir, '.env'), 'DEMO_SECRET=fixture-before\n');
      await writeFile(join(dir, 'deleted.ts'), 'deleted\n');
      await git('add', 'example.ts', '.env', 'deleted.ts');
      await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
      expect(await discordWorkspaceHasChanges({ workingDir: dir })).toBe(false);
      await writeFile(join(dir, 'example.ts'), 'export const value = 2;\n');
      expect(await discordWorkspaceHasChanges({ workingDir: dir })).toBe(true);
      await writeFile(join(dir, '.env'), 'DEMO_SECRET=fixture-after\n');
      await rm(join(dir, 'deleted.ts'));
      await symlink('/etc/passwd', join(dir, 'outside.ts'));
      const result = await discordWorkspaceResults({ workingDir: dir });
      expect(result.summary).toContain('example.ts');
      expect(result.diff).toContain('+export const value = 2;');
      expect(result.diff).not.toContain('DEMO_SECRET');
      expect(result.diff).not.toContain('deleted');
      expect(result.summary).toContain('omitted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
