import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const root = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deepseekInstallCommand(platform: 'linux' | 'darwin'): string {
  const ds = STOCK_CLIS.find((c) => (c.id as string) === 'deepseek')!;
  return ds.discovery.install.command![platform]!;
}

/**
 * Run the stock install command through `/bin/sh -c` (what CLI management does, `shell: true`)
 * with a fake `npm` that records each call, on a PATH that holds only the fake bins. So this
 * exercises the real string, not a copy of it.
 */
function runInstall(opts: { pnpmOnPath: boolean; npmFails?: boolean }): { status: number | null; npmCalls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-install-'));
  dirs.push(dir);
  const npmBin = join(dir, 'npm-bin');
  const pnpmBin = join(dir, 'pnpm-bin');
  mkdirSync(npmBin);
  mkdirSync(pnpmBin);
  const log = join(dir, 'npm.log');
  writeFileSync(log, '');
  writeFileSync(join(npmBin, 'npm'), '#!/bin/sh\necho "$*" >> "$NPM_LOG"\nexit "${NPM_EXIT:-0}"\n');
  chmodSync(join(npmBin, 'npm'), 0o755);
  writeFileSync(join(pnpmBin, 'pnpm'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(pnpmBin, 'pnpm'), 0o755);
  const result = spawnSync('/bin/sh', ['-c', deepseekInstallCommand('linux')], {
    env: {
      PATH: opts.pnpmOnPath ? `${npmBin}:${pnpmBin}` : npmBin,
      NPM_LOG: log,
      NPM_EXIT: opts.npmFails ? '1' : '0',
    },
    encoding: 'utf-8',
  });
  const npmCalls = readFileSync(log, 'utf-8').split('\n').filter(Boolean);
  return { status: result.status, npmCalls };
}

describe('DeepSeek install', () => {
  it('is the same command on linux and darwin', () => {
    expect(deepseekInstallCommand('darwin')).toBe(deepseekInstallCommand('linux'));
  });

  it('installs pnpm with dsh when none is on PATH, since `dsh plugin` spawns a literal pnpm', () => {
    const { status, npmCalls } = runInstall({ pnpmOnPath: false });
    expect(status).toBe(0);
    expect(npmCalls).toEqual(['install -g @deepseek-ai/dsh', 'install -g pnpm']);
  });

  it('leaves an existing pnpm alone (a corepack shim makes `npm install -g pnpm` fail with EEXIST)', () => {
    const { status, npmCalls } = runInstall({ pnpmOnPath: true });
    expect(status).toBe(0);
    expect(npmCalls).toEqual(['install -g @deepseek-ai/dsh']);
  });

  it('reports a failed dsh install and does not go on to pnpm', () => {
    const { status, npmCalls } = runInstall({ pnpmOnPath: false, npmFails: true });
    expect(status).not.toBe(0);
    expect(npmCalls).toEqual(['install -g @deepseek-ai/dsh']);
  });

  it("puts dsh's own directory first on the profile install's PATH", () => {
    const src = readFileSync(resolve(root, 'src/web/routes/system-routes.ts'), 'utf8');
    expect(src).toMatch(/env: \{ \.\.\.process\.env, PATH: \[dir, process\.env\.PATH\]/);
  });
});
