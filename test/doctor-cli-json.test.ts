// @vitest-environment node
// The contract GET /api/doctor's default runner relies on: the same entry script, given
// `doctor --json`, prints a parseable DependencyReportJson on stdout, even when it exits
// non-zero because something required is missing.
//
// Hermetic: the doctor runs `--version` on every CLI it finds, and a suite must never execute
// whatever happens to be installed on the machine running it (cli-executable-resolver.ts
// @fileoverview). Each run gets a temp HOME and a PATH holding only `which` and `node`, and a
// clis.json in that HOME's data dir drops the registry's absolute search dirs
// (`/usr/local/bin`), so the only CLI the doctor can find is a fixture this file wrote.

import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const ROOT = join(import.meta.dirname, '..');

interface DoctorRun {
  report: { tools: Array<{ id: string; status: string; path?: string; category: string }> } & Record<string, any>;
  stderr: string;
}

function hermeticDoctorEnv(): { home: string; bare: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'doctor-home-'));
  const bare = mkdtempSync(join(tmpdir(), 'doctor-path-'));
  symlinkSync(execFileSync('sh', ['-c', 'command -v which'], { encoding: 'utf-8' }).trim(), join(bare, 'which'));
  symlinkSync(process.execPath, join(bare, 'node'));
  // Overrides deep-merge by id and arrays replace wholesale, so this keeps every stock entry
  // and only narrows its search dirs to the `~` ones, which resolve inside the temp HOME.
  const clis = Object.fromEntries(
    STOCK_CLIS.map((e) => [e.id, { discovery: { searchDirs: e.discovery.searchDirs.filter((d) => !isAbsolute(d)) } }])
  );
  mkdirSync(join(home, '.codeman'), { recursive: true });
  // 0600 or the registry ignores the file (isUnsafePermissions).
  writeFileSync(join(home, '.codeman', 'clis.json'), JSON.stringify({ schemaVersion: 1, clis }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: bare };
  delete env.CODEMAN_DATA_DIR;
  delete env.CODEMAN_INSTANCE;
  return {
    home,
    bare,
    env,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    },
  };
}

function runDoctor(env: NodeJS.ProcessEnv): Promise<DoctorRun> {
  return new Promise((resolve, reject) => {
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
      { timeout: 60_000, cwd: ROOT, env },
      (err, out, stderr) => (out ? resolve({ report: JSON.parse(out), stderr }) : reject(err ?? new Error('no output')))
    );
  });
}

describe('codeman doctor --json', () => {
  it('prints a report that includes Node and a summary, whatever the exit code', async () => {
    const h = hermeticDoctorEnv();
    try {
      const { report, stderr } = await runDoctor(h.env);
      expect(report.platform.environment).toMatch(/linux|darwin|win32|wsl/);
      expect(report.summary).toEqual(expect.objectContaining({ ok: expect.any(Number), exitCode: expect.any(Number) }));
      const node = report.tools.find((t) => t.id === 'node');
      expect(node?.status).toBe('ok');
      expect(report.tools.every((t) => t.category === 'core')).toBe(true);
      // The override was accepted (an ignored or invalid clis.json warns on stderr), and nothing
      // the doctor found, and so ran, lives outside this test's own temp dirs.
      expect(stderr).not.toContain('[cli-registry]');
      for (const t of report.tools.filter((t) => t.path)) {
        expect(t.path!.startsWith(h.bare) || t.path!.startsWith(h.home)).toBe(true);
      }
    } finally {
      h.cleanup();
    }
  }, 90_000);

  // The report an operator got wrong in production: under systemd the PATH is minimal, so a CLI
  // installed in ~/.local/bin read `missing` while the Run menu (which also searches the registry's
  // searchDirs) found it.
  it('finds a CLI that lives only in a registry searchDirs entry when the PATH is minimal', async () => {
    const h = hermeticDoctorEnv();
    try {
      mkdirSync(join(h.home, '.local/bin'), { recursive: true });
      const fake = join(h.home, '.local/bin/claude');
      writeFileSync(fake, '#!/bin/sh\necho "2.1.0 (Claude Code)"\n');
      chmodSync(fake, 0o755);
      const { report } = await runDoctor(h.env);
      const claude = report.tools.find((t) => t.id === 'claude');
      expect(claude).toMatchObject({ status: 'ok', path: fake });
    } finally {
      h.cleanup();
    }
  }, 90_000);
});
