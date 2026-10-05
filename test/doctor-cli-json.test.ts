// @vitest-environment node
// The contract GET /api/doctor's default runner relies on: the same entry script, given
// `doctor --json`, prints a parseable DependencyReportJson on stdout, even when it exits
// non-zero because something required is missing.

import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('codeman doctor --json', () => {
  it('prints a report that includes Node and a summary, whatever the exit code', async () => {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          join(ROOT, 'node_modules/tsx/dist/cli.mjs'),
          join(ROOT, 'src/index.ts'),
          'doctor',
          '--json',
          '--category',
          'core',
        ],
        { timeout: 60_000, cwd: ROOT },
        (err, out) => (out ? resolve(out) : reject(err ?? new Error('no output')))
      );
    });
    const report = JSON.parse(stdout);
    expect(report.platform.environment).toMatch(/linux|darwin|win32|wsl/);
    expect(report.summary).toEqual(expect.objectContaining({ ok: expect.any(Number), exitCode: expect.any(Number) }));
    const node = report.tools.find((t: { id: string }) => t.id === 'node');
    expect(node?.status).toBe('ok');
    expect(report.tools.every((t: { category: string }) => t.category === 'core')).toBe(true);
  }, 90_000);

  // The report an operator got wrong in production: under systemd the PATH is minimal, so a CLI
  // installed in ~/.local/bin read `missing` while the Run menu (which also searches the registry's
  // searchDirs) found it. The PATH here holds nothing but `which`.
  it('finds a CLI that lives only in a registry searchDirs entry when the PATH is minimal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-home-'));
    const bare = mkdtempSync(join(tmpdir(), 'doctor-path-'));
    try {
      mkdirSync(join(home, '.local/bin'), { recursive: true });
      const fake = join(home, '.local/bin/claude');
      writeFileSync(fake, '#!/bin/sh\necho "2.1.0 (Claude Code)"\n');
      chmodSync(fake, 0o755);
      symlinkSync(execFileSyncWhich(), join(bare, 'which'));
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          [
            join(ROOT, 'node_modules/tsx/dist/cli.mjs'),
            join(ROOT, 'src/index.ts'),
            'doctor',
            '--json',
            '--category',
            'core',
          ],
          { timeout: 60_000, cwd: ROOT, env: { ...process.env, HOME: home, PATH: bare } },
          (err, out) => (out ? resolve(out) : reject(err ?? new Error('no output')))
        );
      });
      const claude = JSON.parse(stdout).tools.find((t: { id: string }) => t.id === 'claude');
      expect(claude).toMatchObject({ status: 'ok', path: fake });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  }, 90_000);
});

function execFileSyncWhich(): string {
  return execFileSync('sh', ['-c', 'command -v which'], { encoding: 'utf-8' }).trim();
}
