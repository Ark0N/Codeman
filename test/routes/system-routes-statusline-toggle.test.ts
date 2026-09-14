/**
 * PUT /api/settings: the `statusLineTelemetry` ACTION field, both directions.
 *
 * `true` (sent on every save while the plan-usage chip is on) injects Codeman's
 * statusLine exporter into every live Claude session's workspace so the chip's
 * data starts flowing without a new session. `false` (sent only when the chip
 * was just turned OFF on a device) takes the exporter back out of those same
 * workspaces. Before this, nothing in `src/` ever called the disable path, so
 * turning the chip off left the line in every repo it had ever reached
 * (discussion #405).
 *
 * Both directions are `isOurs`-guarded in `applyStatusLineConfig`, so a
 * statusLine the user wrote themselves is never added to, replaced, or removed.
 * Remote-attach sessions are skipped in both: their `workingDir` is a
 * `user@host:session` pseudo-path that the enable path would otherwise create
 * as a junk local directory.
 *
 * Uses app.inject(), real temp workspaces under the test HOME. Port: N/A.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { createMockSession } from '../mocks/mock-session.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';
import { STATUSLINE_SHIM_TOKEN } from '../../src/statusline-shim.js';

// The three service toggles start/stop real watchers from this handler; stub
// them so a settings PUT in a test never starts a filesystem watcher.
const { subagentWatcher, imageWatcher, workflowRunWatcher } = vi.hoisted(() => {
  const makeWatcher = () => ({
    isRunning: vi.fn(() => false),
    start: vi.fn(),
    stop: vi.fn(),
    getStats: vi.fn(() => ({})),
    watchSession: vi.fn(),
    getRecentRunSummaries: vi.fn(() => []),
  });
  return { subagentWatcher: makeWatcher(), imageWatcher: makeWatcher(), workflowRunWatcher: makeWatcher() };
});
vi.mock('../../src/subagent-watcher.js', () => ({ subagentWatcher }));
vi.mock('../../src/image-watcher.js', () => ({ imageWatcher }));
vi.mock('../../src/workflow-run-watcher.js', () => ({ workflowRunWatcher }));

const settingsFile = (dir: string) => join(dir, '.claude', 'settings.local.json');
const readSettings = (dir: string) => JSON.parse(readFileSync(settingsFile(dir), 'utf-8'));
const writeSettings = (dir: string, value: object) => {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(settingsFile(dir), JSON.stringify(value, null, 2));
};

describe('PUT /api/settings statusLineTelemetry', () => {
  let h: RouteTestHarness;
  let root: string;
  let claudeDir: string;
  let shellDir: string;
  let remoteDir: string;

  const put = (body: unknown) => h.app.inject({ method: 'PUT', url: '/api/settings', payload: body });

  beforeEach(async () => {
    h = await createRouteTestHarness(registerSystemRoutes);
    root = mkdtempSync(join(tmpdir(), 'codeman-statusline-toggle-'));
    claudeDir = join(root, 'claude-repo');
    shellDir = join(root, 'shell-repo');
    remoteDir = join(root, 'remote-attach');
    for (const dir of [claudeDir, shellDir]) mkdirSync(dir, { recursive: true });

    const claude = createMockSession('claude-1');
    claude.workingDir = claudeDir;
    const shell = createMockSession('shell-1');
    shell.mode = 'shell';
    shell.workingDir = shellDir;
    const remote = createMockSession('remote-1');
    remote.workingDir = remoteDir;
    Object.assign(remote, { remote: { host: 'box', session: 'codeman-ssh-remote-1' } });
    h.ctx.sessions.clear();
    for (const s of [claude, shell, remote]) h.ctx.sessions.set(s.id, s);
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('true injects the exporter into live Claude workspaces only', async () => {
    const res = await put({ statusLineTelemetry: true });
    expect(res.statusCode).toBe(200);
    expect(readSettings(claudeDir).statusLine.command).toContain(STATUSLINE_SHIM_TOKEN);
    // A shell session has no statusline to export from.
    expect(existsSync(settingsFile(shellDir))).toBe(false);
    // A remote attach's workingDir is a pseudo-path: nothing must be created for it.
    expect(existsSync(remoteDir)).toBe(false);
  });

  it('false removes the exporter it injected', async () => {
    await put({ statusLineTelemetry: true });
    expect(readSettings(claudeDir).statusLine).toBeDefined();

    const res = await put({ statusLineTelemetry: false });
    expect(res.statusCode).toBe(200);
    expect(readSettings(claudeDir).statusLine).toBeUndefined();
  });

  it('false keeps every other key in the workspace settings file', async () => {
    writeSettings(claudeDir, { permissions: { allow: ['Read'] }, hooks: { Stop: [] } });
    await put({ statusLineTelemetry: true });
    await put({ statusLineTelemetry: false });
    expect(readSettings(claudeDir)).toEqual({ permissions: { allow: ['Read'] }, hooks: { Stop: [] } });
  });

  it('false never removes a statusLine the user wrote themselves', async () => {
    const mine = { type: 'command', command: 'bash ~/.claude/my-statusline.sh' };
    writeSettings(claudeDir, { statusLine: mine });
    await put({ statusLineTelemetry: false });
    expect(readSettings(claudeDir).statusLine).toEqual(mine);
  });

  it('false creates nothing in a workspace that never had the exporter', async () => {
    await put({ statusLineTelemetry: false });
    expect(existsSync(settingsFile(claudeDir))).toBe(false);
    expect(existsSync(remoteDir)).toBe(false);
  });

  it('is an action field, never persisted into settings.json', async () => {
    await put({ statusLineTelemetry: false, showTokenCount: true });
    const res = await h.app.inject({ method: 'GET', url: '/api/settings' });
    const stored = JSON.parse(res.body);
    const settings = stored.data ?? stored;
    expect(settings.showTokenCount).toBe(true);
    expect('statusLineTelemetry' in settings).toBe(false);
  });
});
