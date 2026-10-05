/**
 * @fileoverview End-to-end tests for POST /api/cases/clone and
 * /api/cases/clone-preflight (issue #236).
 *
 * Deliberately runs against a REAL filesystem and a REAL `git` cloning a REAL
 * local bare repo, unlike its sibling `case-routes.test.ts` which mocks `node:fs`
 * wholesale. Mocking here would only prove the handler calls functions in the
 * order the test expects; what actually needs proving is that a clone lands a
 * working tree in the case directory, that scaffolding does not overwrite the
 * repository's own files, and that a rejected URL never reaches git.
 *
 * `test/setup.ts` points HOME at a per-file temp dir, so CASES_DIR
 * (`join(homedir(), 'codeman-cases')`) resolves inside the fixture; cleanup
 * below still goes through `safeRmHomeTree`, which refuses to delete anything
 * outside the temp HOME, so a wrong anchor can never reach the real tree.
 *
 * Port: N/A (app.inject).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Unreachable-mount seam: `stat()` of a path under this root never settles (a hard
// network mount that went away), so the bounded path probe can be driven to its
// stall cap. Every other stat is the real one. The short timeout is read at import.
const deadMount = vi.hoisted(() => {
  process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS = '200';
  return { root: '/mnt/codeman-clone-test-dead', releases: [] as Array<() => void> };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const stat = ((path: string, ...rest: unknown[]) => {
    if (String(path).startsWith(deadMount.root + '/')) {
      return new Promise((resolve) => deadMount.releases.push(() => resolve({} as never)));
    }
    return (actual.stat as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.stat;
  return { ...actual, stat, default: { ...actual, stat } };
});
afterAll(() => {
  delete process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS;
});
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockRouteContext, safeRmHomeTree, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';
import { isGitAvailable } from '../../src/git-clone.js';
import { probePath } from '../../src/utils/index.js';
import { MAX_STALLED_PATH_PROBES } from '../../src/config/path-probe.js';

const CASES_DIR = join(homedir(), 'codeman-cases');
const gitPresent = isGitAvailable();

let app: FastifyInstance;
let ctx: MockRouteContext;

async function buildApp(): Promise<void> {
  app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  // Mirror the production preSerialization envelope hook so error codes map to
  // their conventional HTTP status (copied from server.ts, as in case-routes.test.ts).
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });
  ctx = createMockRouteContext();
  registerCaseRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  await app.ready();
}

const clone = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/cases/clone', payload });
const preflight = (repository: unknown) =>
  app.inject({ method: 'POST', url: '/api/cases/clone-preflight', payload: { repository } });

describe('POST /api/cases/clone-preflight', () => {
  beforeEach(buildApp);
  afterEach(async () => {
    await app.close();
  });

  it('answers 200 with the rejection reason for an ext:: URL (never probes it)', async () => {
    const res = await preflight('ext::sh -c "id > /tmp/pwned"');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.parse.cloneable).toBe(false);
    expect(body.data.parse.code).toBe('TRANSPORT_HELPER');
    expect(body.data.remote).toBeUndefined();
  });

  it('returns the parsed owner/repo and a case-name suggestion for a valid URL', async () => {
    const res = await preflight('https://github.com/owner/My.Repo.git');
    const body = JSON.parse(res.body);
    expect(body.data.parse.cloneable).toBe(true);
    expect(body.data.parse.owner).toBe('owner');
    expect(body.data.parse.repo).toBe('My.Repo');
    expect(body.data.parse.suggestedName).toBe('My-Repo');
  });

  it('validates the body', async () => {
    expect((await preflight('')).statusCode).toBe(400);
    expect((await preflight(undefined)).statusCode).toBe(400);
  });
});

describe('POST /api/cases/clone — input rejection', () => {
  beforeEach(buildApp);
  afterEach(async () => {
    await app.close();
  });

  it('refuses a transport helper before touching git', async () => {
    const res = await clone({ name: 'pwned', repository: 'ext::sh -c "touch /tmp/codeman-pwned"' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe(ApiErrorCode.INVALID_INPUT);
    expect(body.error).toMatch(/ext::/);
    expect(existsSync(join(CASES_DIR, 'pwned'))).toBe(false);
  });

  it('refuses an option-shaped repository', async () => {
    const res = await clone({ name: 'opt', repository: '--upload-pack=touch /tmp/x' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/may not start with/);
  });

  it('refuses a URL with embedded credentials', async () => {
    const res = await clone({ name: 'creds', repository: 'https://u:token@github.com/o/r.git' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/never accepts or stores/i);
  });

  it('refuses an unsafe ref', async () => {
    const res = await clone({ name: 'ref', repository: 'https://github.com/o/r.git', ref: '--upload-pack=x' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/branch or tag/i);
  });

  it('rejects an invalid case name via the schema', async () => {
    const res = await clone({ name: '../escape', repository: 'https://github.com/o/r.git' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a name that collides with an existing case before cloning', async () => {
    mkdirSync(join(CASES_DIR, 'taken'), { recursive: true });
    try {
      const res = await clone({ name: 'taken', repository: 'https://github.com/o/r.git' });
      expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.ALREADY_EXISTS));
      expect(JSON.parse(res.body).error).toMatch(/already exists/i);
    } finally {
      safeRmHomeTree(join(CASES_DIR, 'taken'));
    }
  });
});

describe.skipIf(!gitPresent)('POST /api/cases/clone — real clone', () => {
  let root: string;
  let origin: string;
  let hostileOrigin: string;
  let victimDir: string;
  let victimFile: string;
  const created: string[] = [];

  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-clone-route-'));
    origin = join(root, 'origin.git');
    mkdirSync(origin);
    git(['init', '--bare', '--quiet'], origin);

    const work = join(root, 'work');
    mkdirSync(work);
    git(['init', '--quiet'], work);
    git(['config', 'user.email', 'test@example.com'], work);
    git(['config', 'user.name', 'Codeman Test'], work);
    writeFileSync(join(work, 'README.md'), '# fixture\n');
    // The repo ships BOTH files the scaffolder would otherwise write.
    writeFileSync(join(work, 'CLAUDE.md'), '# repository-owned CLAUDE.md\n');
    mkdirSync(join(work, '.claude'));
    writeFileSync(join(work, '.claude', 'settings.json'), '{"permissions":{}}\n');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'initial'], work);
    git(['branch', '-M', 'main'], work);
    git(['tag', 'v1'], work);
    git(['remote', 'add', 'origin', origin], work);
    git(['push', '--quiet', 'origin', 'main', '--tags'], work);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], origin);

    // A HOSTILE repository: it ships the scaffold paths as symlinks aimed
    // outside the case, so a scaffolder that follows them writes onto this
    // machine's own files. victimFile deliberately does NOT exist, because a
    // BROKEN CLAUDE.md link is the case existsSync gets wrong (it follows the
    // link, reports "absent", and the scaffold write would then CREATE the
    // outside file).
    victimDir = join(root, 'victim-claude');
    mkdirSync(victimDir);
    victimFile = join(root, 'victim-file.md');
    hostileOrigin = join(root, 'hostile.git');
    mkdirSync(hostileOrigin);
    git(['init', '--bare', '--quiet'], hostileOrigin);
    const hostileWork = join(root, 'hostile-work');
    mkdirSync(hostileWork);
    git(['init', '--quiet'], hostileWork);
    git(['config', 'user.email', 'test@example.com'], hostileWork);
    git(['config', 'user.name', 'Codeman Test'], hostileWork);
    writeFileSync(join(hostileWork, 'README.md'), '# hostile fixture\n');
    symlinkSync(victimFile, join(hostileWork, 'CLAUDE.md'));
    symlinkSync(victimDir, join(hostileWork, '.claude'));
    git(['add', '.'], hostileWork);
    git(['commit', '--quiet', '-m', 'hostile'], hostileWork);
    git(['branch', '-M', 'main'], hostileWork);
    git(['remote', 'add', 'origin', hostileOrigin], hostileWork);
    git(['push', '--quiet', 'origin', 'main'], hostileWork);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], hostileOrigin);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    for (const name of created) safeRmHomeTree(join(CASES_DIR, name));
  });

  beforeEach(buildApp);
  afterEach(async () => {
    await app.close();
  });

  it('clones into the case directory and broadcasts case:created', async () => {
    created.push('cloned-case');
    const res = await clone({ name: 'cloned-case', repository: origin });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.case).toEqual({ name: 'cloned-case', path: join(CASES_DIR, 'cloned-case') });
    expect(existsSync(join(CASES_DIR, 'cloned-case', 'README.md'))).toBe(true);
    expect(existsSync(join(CASES_DIR, 'cloned-case', '.git'))).toBe(true);
    expect(ctx.broadcast).toHaveBeenCalledWith('case:created', {
      name: 'cloned-case',
      path: join(CASES_DIR, 'cloned-case'),
    });
  });

  it("keeps the repository's own CLAUDE.md and warns about repo-supplied .claude settings", async () => {
    created.push('keeps-files');
    const res = await clone({ name: 'keeps-files', repository: origin });
    const body = JSON.parse(res.body);
    expect(readFileSync(join(CASES_DIR, 'keeps-files', 'CLAUDE.md'), 'utf-8')).toBe('# repository-owned CLAUDE.md\n');
    expect(body.data.warnings.join(' ')).toMatch(/Kept the repository/);
    // Repo-shipped hooks run on this machine: the response has to say so.
    expect(body.data.warnings.join(' ')).toMatch(/ships its own \.claude/);
  });

  it('still warns about repo-supplied .claude settings while unrelated mounts are unreachable', async () => {
    const dead = Array.from({ length: MAX_STALLED_PATH_PROBES }, (_, i) => `${deadMount.root}/nas-${i}/project`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Engage the probe's stall cap: every new bounded probe is now refused.
      expect(await Promise.all(dead.map((p) => probePath(p)))).toEqual(dead.map(() => 'unknown'));

      created.push('warns-under-cap');
      const res = await clone({ name: 'warns-under-cap', repository: origin });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.warnings.join(' ')).toMatch(/ships its own \.claude/);
    } finally {
      deadMount.releases.splice(0).forEach((release) => release());
      await new Promise((r) => setTimeout(r, 0));
      warn.mockRestore();
    }
  });

  it('installs Codeman hooks alongside whatever the repo shipped', async () => {
    created.push('hooked');
    await clone({ name: 'hooked', repository: origin });
    const settingsPath = join(CASES_DIR, 'hooked', '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).hooks).toBeTruthy();
    // The repo's own settings.json is untouched.
    expect(readFileSync(join(CASES_DIR, 'hooked', '.claude', 'settings.json'), 'utf-8')).toBe('{"permissions":{}}\n');
  });

  it('honors a ref and reports it back', async () => {
    created.push('at-tag');
    const res = await clone({ name: 'at-tag', repository: origin, ref: 'v1', shallow: true });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.ref).toBe('v1');
    expect(existsSync(join(CASES_DIR, 'at-tag', 'README.md'))).toBe(true);
  });

  it('leaves no case directory behind when the clone fails', async () => {
    const res = await clone({ name: 'ghost-case', repository: join(root, 'no-such-repo.git') });
    expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.NOT_FOUND));
    expect(JSON.parse(res.body).error).toMatch(/not found/i);
    // A leftover empty directory would occupy the name forever.
    expect(existsSync(join(CASES_DIR, 'ghost-case'))).toBe(false);
  });

  it('reports a missing ref as invalid input, not a server error', async () => {
    const res = await clone({ name: 'bad-ref-case', repository: origin, ref: 'no-such-branch' });
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(CASES_DIR, 'bad-ref-case'))).toBe(false);
    // git's FIRST stderr line is "Cloning into '<dest>'..." — quoting that as the
    // reason told the user the destination path when the ref was the problem.
    const error = JSON.parse(res.body).error as string;
    expect(error).not.toMatch(/Cloning into/);
    expect(error).toMatch(/branch or tag/i);
  });

  it('refuses to scaffold through repository-shipped symlinks (keeps the clone, warns)', async () => {
    created.push('hostile');
    const res = await clone({ name: 'hostile', repository: hostileOrigin });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    const casePath = join(CASES_DIR, 'hostile');
    // The repo's symlinks are still symlinks: nothing wrote through them.
    expect(lstatSync(join(casePath, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(casePath, '.claude')).isSymbolicLink()).toBe(true);
    // The outside targets were neither created nor written.
    expect(existsSync(victimFile)).toBe(false);
    expect(existsSync(join(victimDir, 'settings.local.json'))).toBe(false);
    // And the response says the hooks scaffold was skipped, and why.
    expect(body.data.warnings.join(' ')).toMatch(/hooks were NOT installed/i);
    expect(body.data.warnings.join(' ')).toMatch(/symlink/i);
  });

  it('preflights the local fixture for its branches and tags', async () => {
    const res = await preflight(origin);
    const body = JSON.parse(res.body);
    expect(body.data.parse.transport).toBe('local');
    expect(body.data.remote.reachable).toBe(true);
    expect(body.data.remote.defaultBranch).toBe('main');
    expect(body.data.remote.tags).toEqual(['v1']);
  });
});
