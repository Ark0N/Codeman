// @vitest-environment node
// The contract GET /api/doctor's default runner relies on: the same entry script, given
// `doctor --json`, prints a parseable DependencyReportJson on stdout, even when it exits
// non-zero because something required is missing.

import { execFile } from 'node:child_process';
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
});
