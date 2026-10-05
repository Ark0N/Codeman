/**
 * @fileoverview GET /api/doctor: the `codeman doctor` report for Settings → System → Diagnostics.
 * The route runs the probe out of process (the engine is synchronous), so every test injects the
 * runner; the default runner's parsing is covered against a faked `execFile`, and the CLI contract
 * it relies on is exercised for real in test/doctor-cli-json.test.ts.
 *
 * Port: N/A (app.inject()).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { defaultDoctorRunner, registerDoctorRoutes, type DoctorRunner } from '../../src/web/routes/doctor-routes.js';
import type { DependencyReportJson } from '../../src/utils/dependency-report.js';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

const REPORT: DependencyReportJson = {
  platform: { environment: 'linux' },
  summary: { ok: 1, requiredMissing: 1, optionalMissing: 0, exitCode: 1 },
  tools: [
    { id: 'node', label: 'Node.js', category: 'core', required: true, usedBy: [], status: 'ok', version: '22.1.0' },
    { id: 'tmux', label: 'tmux', category: 'core', required: true, usedBy: [], status: 'missing' },
  ],
};

afterEach(() => {
  delete process.env.CODEMAN_MULTIUSER;
  execFileMock.mockReset();
});

describe('GET /api/doctor', () => {
  it('returns the runner’s report in the success envelope', async () => {
    const runner = vi.fn<DoctorRunner>(async () => REPORT);
    const { app } = await createRouteTestHarness((a) => registerDoctorRoutes(a, runner));
    const res = await app.inject({ method: 'GET', url: '/api/doctor' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: REPORT });
    expect(runner).toHaveBeenCalledWith(undefined);
  });

  it('passes a valid category through and rejects an unknown one without running anything', async () => {
    const runner = vi.fn<DoctorRunner>(async () => REPORT);
    const { app } = await createRouteTestHarness((a) => registerDoctorRoutes(a, runner));
    expect((await app.inject({ method: 'GET', url: '/api/doctor?category=office' })).statusCode).toBe(200);
    expect(runner).toHaveBeenLastCalledWith('office');
    runner.mockClear();
    const bad = await app.inject({ method: 'GET', url: '/api/doctor?category=%3Brm%20-rf' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errorCode).toBe('INVALID_INPUT');
    expect(runner).not.toHaveBeenCalled();
  });

  it('answers 500 with a message when the runner fails', async () => {
    const runner: DoctorRunner = async () => {
      throw new Error('spawn blew up');
    };
    const { app } = await createRouteTestHarness((a) => registerDoctorRoutes(a, runner));
    const res = await app.inject({ method: 'GET', url: '/api/doctor' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('spawn blew up');
    expect(res.json().errorCode).toBe('INTERNAL_ERROR');
  });

  it('single-flights: concurrent requests for a category share one run, and a later one runs again', async () => {
    const releases: Array<(r: DependencyReportJson) => void> = [];
    const runner = vi.fn<DoctorRunner>(() => new Promise<DependencyReportJson>((res) => releases.push(res)));
    const { app } = await createRouteTestHarness((a) => registerDoctorRoutes(a, runner));
    const first = app.inject({ method: 'GET', url: '/api/doctor' });
    const second = app.inject({ method: 'GET', url: '/api/doctor' });
    const other = app.inject({ method: 'GET', url: '/api/doctor?category=office' });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    releases[0](REPORT);
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(runner).toHaveBeenCalledTimes(2); // unfiltered (shared) + office
    releases[1](REPORT);
    await other;
    runner.mockImplementation(async () => REPORT);
    await app.inject({ method: 'GET', url: '/api/doctor' });
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('multi-user: a non-admin is refused and nothing is probed', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const runner = vi.fn<DoctorRunner>(async () => REPORT);
    const { app } = await createRouteTestHarness((a) => registerDoctorRoutes(a, runner), {
      authUser: { username: 'bob', role: 'user' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/doctor' });
    expect(res.statusCode).toBe(403);
    expect(runner).not.toHaveBeenCalled();
  });

  it('multi-user: an admin is allowed', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness((a) => registerDoctorRoutes(a, async () => REPORT), {
      authUser: { username: 'root', role: 'admin' },
    });
    expect((await app.inject({ method: 'GET', url: '/api/doctor' })).statusCode).toBe(200);
  });
});

describe('defaultDoctorRunner', () => {
  type Done = (err: Error | null, stdout: string) => void;
  const respond = (err: Error | null, stdout: string) =>
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, done: Done) => done(err, stdout));

  it('runs `doctor --json` in a child of this same entry script, never in-process', async () => {
    respond(null, JSON.stringify(REPORT));
    await defaultDoctorRunner('core');
    const [bin, args, opts] = execFileMock.mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(args.slice(-4)).toEqual(['doctor', '--json', '--category', 'core']);
    expect(args).toContain(process.argv[1]);
    expect((opts as { timeout: number }).timeout).toBeGreaterThan(0);
  });

  it('treats a non-zero exit with a valid report as a normal result (a missing required tool exits 1)', async () => {
    respond(Object.assign(new Error('exit 1'), { code: 1 }), JSON.stringify(REPORT));
    await expect(defaultDoctorRunner()).resolves.toEqual(REPORT);
  });

  it.each([
    ['empty output', ''],
    ['non-JSON output', 'Segmentation fault'],
    ['JSON of the wrong shape', '{"hello":"world"}'],
  ])('rejects %s', async (_label, stdout) => {
    respond(null, stdout);
    await expect(defaultDoctorRunner()).rejects.toThrow();
  });

  it('reports a killed child (the 30 s timeout) as a timeout, not the raw command line', async () => {
    respond(Object.assign(new Error('Command failed: node doctor --json'), { killed: true, signal: 'SIGTERM' }), '');
    await expect(defaultDoctorRunner()).rejects.toThrow('timed out after 30 s');
  });

  it('passes the child’s own error through when there is no report at all', async () => {
    respond(new Error('ETIMEDOUT'), '');
    await expect(defaultDoctorRunner()).rejects.toThrow('ETIMEDOUT');
  });
});
