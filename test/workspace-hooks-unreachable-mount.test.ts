/**
 * @fileoverview How the workspace hook and statusLine helpers in hooks-config.ts
 * read an "unknown" answer from the bounded path probe. A dead network mount
 * elsewhere on the machine (enough of them to engage the probe's stall cap) must
 * not stop Codeman's hooks from being installed in a healthy workspace, and must
 * not let the plan-usage exporter be injected over a user's own statusLine. A
 * workspace that IS on the dead mount is skipped without hanging the caller.
 *
 * Real temp directories; only `stat()` of the chosen dead paths is made to hang.
 * Port: none.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probe = vi.hoisted(() => {
  // Short probe timeout so the stalls below cost ~100 ms each, read at import.
  process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS = '100';
  return { dead: new Set<string>(), releases: [] as Array<() => void> };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  /** A call on a dead path never settles (a hard mount), until afterEach releases it. */
  const hangOnDead = <F extends (...a: never[]) => unknown>(real: F): F =>
    ((path: string, ...rest: unknown[]) => {
      for (const dead of probe.dead) {
        if (String(path) === dead || String(path).startsWith(dead + '/')) {
          return new Promise((resolve, reject) => {
            probe.releases.push(() => reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
            void resolve;
          });
        }
      }
      return (real as unknown as (...a: unknown[]) => unknown)(path, ...rest);
    }) as unknown as F;
  const hung = {
    stat: hangOnDead(actual.stat),
    lstat: hangOnDead(actual.lstat),
    readFile: hangOnDead(actual.readFile),
    realpath: hangOnDead(actual.realpath),
  };
  return { ...actual, ...hung, default: { ...actual, ...hung } };
});

import { applyWorkspaceHooks, resolveStatusLineCliCommand, stripCaseEnvKeys } from '../src/hooks-config.js';
import { probePath } from '../src/utils/index.js';
import { MAX_STALLED_PATH_PROBES } from '../src/config/path-probe.js';

const root = mkdtempSync(join(tmpdir(), 'codeman-unreachable-mount-'));

/** Stall `count` paths on unrelated "mounts" until afterEach releases them. */
async function stallUnrelatedMounts(count: number): Promise<void> {
  const paths = Array.from({ length: count }, (_, i) => `/mnt/dead-nas-${i}/project`);
  paths.forEach((p) => probe.dead.add(p));
  expect(await Promise.all(paths.map((p) => probePath(p)))).toEqual(paths.map(() => 'unknown'));
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  probe.dead.clear();
  probe.releases.splice(0).forEach((release) => release());
  await new Promise((r) => setTimeout(r, 0));
  warn.mockRestore();
});

afterAll(() => {
  delete process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS;
});

describe('workspace helpers while other mounts are unreachable', () => {
  it('installs hooks in a healthy workspace while the stall cap is engaged', async () => {
    await stallUnrelatedMounts(MAX_STALLED_PATH_PROBES);
    const workspace = join(root, 'healthy-a');
    mkdirSync(workspace);

    await applyWorkspaceHooks(workspace, true);

    const settings = join(workspace, '.claude', 'settings.local.json');
    expect(existsSync(settings)).toBe(true);
    expect(readFileSync(settings, 'utf-8')).toContain('/api/hook-event');
  });

  it('keeps a deleted workspace deleted while the stall cap is engaged', async () => {
    // The cap refuses the probe ("unknown" without a stat), which must not read as
    // "go ahead": installing would mkdir -p the deleted repo back into existence.
    await stallUnrelatedMounts(MAX_STALLED_PATH_PROBES);
    const workspace = join(root, 'deleted-repo');
    expect(await probePath(workspace)).toBe('unknown');

    await applyWorkspaceHooks(workspace, true);
    await applyWorkspaceHooks(workspace, false);

    expect(existsSync(workspace)).toBe(false);
  });

  it('installs hooks in a healthy workspace while fewer unrelated paths are stalled than the cap', async () => {
    await stallUnrelatedMounts(MAX_STALLED_PATH_PROBES - 1);
    const workspace = join(root, 'healthy-b');
    mkdirSync(workspace);

    await applyWorkspaceHooks(workspace, true);

    expect(existsSync(join(workspace, '.claude', 'settings.local.json'))).toBe(true);
  });

  it('skips, without hanging, a workspace that sits on the dead mount', async () => {
    const workspace = '/mnt/dead-nas-x/project';
    probe.dead.add('/mnt/dead-nas-x');
    expect(await probePath(workspace)).toBe('unknown');

    const started = Date.now();
    await applyWorkspaceHooks(join('/mnt/dead-nas-x', 'project'), true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(
      warn.mock.calls.some(
        (c: unknown[]) => /hooks/i.test(String(c[0])) && String(c[0]).includes('/mnt/dead-nas-x/project')
      )
    ).toBe(true);
  });

  it('removes a superseded env key from a healthy workspace while the stall cap is engaged', async () => {
    await stallUnrelatedMounts(MAX_STALLED_PATH_PROBES);
    const workspace = join(root, 'strip-env');
    mkdirSync(join(workspace, '.claude'), { recursive: true });
    const settings = join(workspace, '.claude', 'settings.local.json');
    writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_STALE: '1', USER_KEEP: '2' } }));

    await stripCaseEnvKeys(workspace, ['CLAUDE_CODE_STALE']);

    expect(JSON.parse(readFileSync(settings, 'utf-8')).env).toEqual({ USER_KEEP: '2' });
  });

  it("never injects the exporter over a user's own statusLine while the cap is engaged", async () => {
    await stallUnrelatedMounts(MAX_STALLED_PATH_PROBES);
    const workspace = join(root, 'own-statusline');
    mkdirSync(join(workspace, '.claude'), { recursive: true });
    writeFileSync(
      join(workspace, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'my-own-statusline' } })
    );

    expect(await resolveStatusLineCliCommand(workspace, true)).toBeUndefined();
  });

  it('still injects the exporter in a healthy workspace without one while the cap is engaged', async () => {
    await stallUnrelatedMounts(MAX_STALLED_PATH_PROBES);
    const workspace = join(root, 'no-statusline');
    mkdirSync(workspace);

    expect(await resolveStatusLineCliCommand(workspace, true)).toMatch(/statusline-exporter\.sh$/);
  });

  it('skips, within the probe timeout, dead workspaces whose probes the bulk cap refused', async () => {
    // Two unrelated stalls engage the bulk cap, so probes of these two paths are
    // refused without a stat. Their lstat and readFile hang too: a helper that
    // touched them directly would never return and would hold a threadpool worker.
    await stallUnrelatedMounts(MAX_STALLED_PATH_PROBES);
    probe.dead.add('/mnt/dead-nas-c');
    probe.dead.add('/mnt/dead-nas-d');
    const within = <T>(work: Promise<T>) =>
      Promise.race([work, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000))]);

    expect(await within(applyWorkspaceHooks('/mnt/dead-nas-c/project', true))).toBeUndefined();
    expect(await within(resolveStatusLineCliCommand('/mnt/dead-nas-d/project', true))).toBeUndefined();
    expect(existsSync('/mnt/dead-nas-c/project')).toBe(false);
  });

  it('does not inject the exporter into a workspace on the dead mount', async () => {
    probe.dead.add('/mnt/dead-nas-y');
    expect(await probePath('/mnt/dead-nas-y/project')).toBe('unknown');

    expect(await resolveStatusLineCliCommand('/mnt/dead-nas-y/project', true)).toBeUndefined();
  });
});
