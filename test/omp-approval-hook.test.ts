/**
 * @fileoverview omp approval-hook wiring.
 *
 * Pins what makes an omp pane able to report a pending tool approval, and what it must
 * NOT earn by doing so: the registry declares the narrow `approvalHookFile` capability
 * while `hooks` stays 'none' (so `stop` is still a 400), Codeman installs the module
 * that emits the events, and the module maps omp's events onto the names the server
 * already routes on. The route side (both create paths, alert-only inbox items) lives in
 * test/routes/omp-approval-hook-routes.test.ts and test/routes/approval-routes.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyApprovalHookFile,
  generateOmpApprovalHook,
  OMP_APPROVAL_HOOK_DIR,
  OMP_APPROVAL_HOOK_FILE,
} from '../src/hooks-config.js';
import { getCli } from '../src/config/cli-registry/registry.js';
import {
  hooksAvailableForMode,
  approvalHookAvailableForMode,
  blockedSignalAvailable,
  resolveWaitSignals,
} from '../src/web/session-wait-registry.js';

const MARKER = 'CODEMAN_OMP_APPROVAL_HOOK_V1';

describe('omp approval hook — registry', () => {
  it('keeps hooks: none, because every consumer reads "always" as Claude\'s full hook set', () => {
    expect(getCli('omp')?.capabilities.hooks).toBe('none');
    expect(hooksAvailableForMode('omp')).toBe(false);
  });

  it('reports approvals through the separate approval-hook capability', () => {
    expect(approvalHookAvailableForMode('omp')).toBe(true);
    expect(blockedSignalAvailable('omp')).toBe(true);
    expect(approvalHookAvailableForMode('claude')).toBe(false);
  });

  it('answers no where Codeman never installed the module (adopted, remote, Docker)', () => {
    // sessionHookOptions() sets deepSeekBridgeUnreachable for remote and Docker sessions.
    expect(approvalHookAvailableForMode('omp', { adopted: true })).toBe(false);
    expect(approvalHookAvailableForMode('omp', { deepSeekBridgeUnreachable: true })).toBe(false);
    expect(blockedSignalAvailable('omp', { deepSeekBridgeUnreachable: true })).toBe(false);
  });

  it('refuses an explicit stop wait for omp (the 400), and accepts blocked', () => {
    const stop = resolveWaitSignals('stop', { mode: 'omp' });
    expect(stop.error).toMatch(/stop/);
    expect(stop.until).toEqual([]);
    const blocked = resolveWaitSignals('blocked', { mode: 'omp' });
    expect(blocked.error).toBeNull();
    expect(blocked.until).toEqual(['blocked']);
    // The default set must never hold stop for omp, or a bare wait sits out its timeout.
    expect(resolveWaitSignals(undefined, { mode: 'omp' }).until).not.toContain('stop');
  });

  it('refuses blocked for a remote omp session, where no module reports', () => {
    expect(resolveWaitSignals('blocked', { mode: 'omp', deepSeekBridgeUnreachable: true }).error).toMatch(/blocked/);
  });

  it('leaves every other hook-less CLI failing the ask', () => {
    // opencode/gemini/pi/grok/antigravity have no approval events.
    for (const mode of ['opencode', 'gemini', 'pi', 'grok', 'antigravity', 'shell'] as const) {
      expect(hooksAvailableForMode(mode), mode).toBe(false);
      expect(approvalHookAvailableForMode(mode), mode).toBe(false);
    }
  });

  it('names the hook module as registry data, so no call site branches on the id', () => {
    // Both create paths ask "does this CLI declare approvalHookFile?"; if the field is
    // absent the hook is never installed and the pane stays silent.
    expect(getCli('omp')?.capabilities.approvalHookFile).toBe(OMP_APPROVAL_HOOK_FILE);
    // claude installs a settings.local.json block instead and must NOT be given a file.
    expect(getCli('claude')?.capabilities.approvalHookFile).toBeUndefined();
  });
});

describe('omp approval hook — generated module (source)', () => {
  const src = generateOmpApprovalHook();

  it('carries the ownership marker on its first line', () => {
    expect(src.split('\n')[0]).toContain(MARKER);
  });

  it('imports HookAPI from the subpath omp exports it from, type-only', () => {
    // omp's package root does not re-export it; erased at runtime either way.
    expect(src).toContain('import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";');
  });

  it('uses a static import, so the module parses without a dynamic loader', () => {
    expect(src).toContain('import { readFile } from "node:fs/promises";');
    expect(src).not.toContain('await import(');
  });
});

/** A fake omp HookAPI: records the handlers the module registers. */
function fakeHookApi() {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  return {
    api: { on: (name: string, fn: (event: Record<string, unknown>) => void) => handlers.set(name, fn) },
    emit: (name: string, event: Record<string, unknown>) => handlers.get(name)?.(event),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('omp approval hook — generated module (runtime)', () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let counter = 0;
  const savedEnv = { ...process.env };

  /** Write the module to disk and import a FRESH copy (env is read at load time). */
  async function loadModule(env: Record<string, string>) {
    Object.assign(process.env, env);
    const file = join(dir, `codeman-approval-${counter++}.ts`);
    writeFileSync(file, generateOmpApprovalHook());
    const mod = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
    const pi = fakeHookApi();
    mod.default(pi.api);
    return pi;
  }

  /** The `{ event, sessionId, data }` bodies posted, in order. */
  const posted = () =>
    fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as { body: string }).body) as { event: string; data: Record<string, unknown> }
    );

  /**
   * Wait until the module's report chain has made exactly `calls` POSTs, then a little
   * longer so a surplus report would show up here instead of leaking into the next test.
   */
  async function settle(calls: number) {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
    await sleep(50);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-omp-hook-mod-'));
    writeFileSync(join(dir, 'secret'), 's3cret\n');
    fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  const baseEnv = () => ({
    CODEMAN_API_URL: 'http://127.0.0.1:3000',
    CODEMAN_SESSION_ID: 'sess-1',
    CODEMAN_HOOK_SECRET_FILE: join(dir, 'secret'),
  });

  it('maps a request to permission_prompt and a resolve to elicitation_complete, with the secret', async () => {
    const pi = await loadModule(baseEnv());
    pi.emit('tool_approval_requested', { toolCallId: 'a', toolName: 'bash' });
    pi.emit('tool_approval_resolved', { toolCallId: 'a', toolName: 'bash', approved: false });
    await settle(2);

    expect(posted().map((b) => b.event)).toEqual(['permission_prompt', 'elicitation_complete']);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://127.0.0.1:3000/api/hook-event');
    expect(init.headers['X-Codeman-Hook-Secret']).toBe('s3cret');
    expect(init).not.toHaveProperty('tls');
  });

  it('clears the alert only when the LAST pending approval in a batch resolves', async () => {
    const pi = await loadModule(baseEnv());
    pi.emit('tool_approval_requested', { toolCallId: 'a', toolName: 'bash' });
    pi.emit('tool_approval_requested', { toolCallId: 'b', toolName: 'write' });
    pi.emit('tool_approval_resolved', { toolCallId: 'a', toolName: 'bash', approved: true });
    await settle(2);
    expect(posted().map((b) => b.event)).toEqual(['permission_prompt', 'permission_prompt']);

    pi.emit('tool_approval_resolved', { toolCallId: 'b', toolName: 'write', approved: true });
    await settle(3);
    expect(posted().map((b) => b.event)).toEqual(['permission_prompt', 'permission_prompt', 'elicitation_complete']);
  });

  it('keeps request-then-resolve order when the first POST is slow', async () => {
    // Without the chain, the resolve's POST would start while the prompt's is still in
    // flight and could land first, leaving the server's alert up.
    const started: string[] = [];
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { event } = JSON.parse(init.body) as { event: string };
      started.push(event);
      if (event === 'permission_prompt') await sleep(150);
      return new Response('{}');
    });
    const pi = await loadModule(baseEnv());
    pi.emit('tool_approval_requested', { toolCallId: 'a', toolName: 'bash' });
    pi.emit('tool_approval_resolved', { toolCallId: 'a', toolName: 'bash', approved: true });
    await sleep(60);
    // The resolve has not even started while the prompt is still in flight.
    expect(started).toEqual(['permission_prompt']);
    await settle(2);
    expect(started).toEqual(['permission_prompt', 'elicitation_complete']);
  });

  it("sends omp's policy reason as message, and nothing summary-shaped without one", async () => {
    const pi = await loadModule(baseEnv());
    pi.emit('tool_approval_requested', { toolCallId: 'a', toolName: 'bash', reason: 'restricted folder' });
    pi.emit('tool_approval_requested', { toolCallId: 'b', toolName: 'bash' });
    await settle(2);
    const [withReason, without] = posted();
    expect(withReason.data).toEqual({ tool_name: 'bash', message: 'restricted folder' });
    expect(without.data).toEqual({ tool_name: 'bash' });
  });

  it('skips certificate verification for an https URL (self-signed loopback)', async () => {
    const pi = await loadModule({ ...baseEnv(), CODEMAN_API_URL: 'https://127.0.0.1:3000' });
    pi.emit('tool_approval_requested', { toolCallId: 'a', toolName: 'bash' });
    await settle(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ tls: { rejectUnauthorized: false } });
  });

  it('fails open: a rejected fetch never throws out of a handler, and later reports still go', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const pi = await loadModule(baseEnv());
    expect(() => pi.emit('tool_approval_requested', { toolCallId: 'a', toolName: 'bash' })).not.toThrow();
    pi.emit('tool_approval_resolved', { toolCallId: 'a', toolName: 'bash', approved: true });
    await settle(2);
  });

  it('posts nothing outside a Codeman session', async () => {
    delete process.env.CODEMAN_API_URL;
    delete process.env.CODEMAN_SESSION_ID;
    const pi = await loadModule({});
    pi.emit('tool_approval_requested', { toolCallId: 'a', toolName: 'bash' });
    await sleep(100);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('omp approval hook — install', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'codeman-omp-hook-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('installs into .claude/hooks/pre, where omp scans for project hooks', async () => {
    expect(await applyApprovalHookFile(workspace, OMP_APPROVAL_HOOK_FILE)).toBe('installed');
    expect(existsSync(join(workspace, OMP_APPROVAL_HOOK_DIR, OMP_APPROVAL_HOOK_FILE))).toBe(true);
    expect(readFileSync(join(workspace, OMP_APPROVAL_HOOK_DIR, OMP_APPROVAL_HOOK_FILE), 'utf-8')).toBe(
      generateOmpApprovalHook()
    );
  });

  it('is idempotent — a second call rewrites nothing', async () => {
    await applyApprovalHookFile(workspace, OMP_APPROVAL_HOOK_FILE);
    expect(await applyApprovalHookFile(workspace, OMP_APPROVAL_HOOK_FILE)).toBe('unchanged');
  });

  it('refreshes a stale Codeman copy', async () => {
    await applyApprovalHookFile(workspace, OMP_APPROVAL_HOOK_FILE);
    writeFileSync(join(workspace, OMP_APPROVAL_HOOK_DIR, OMP_APPROVAL_HOOK_FILE), `// ${MARKER}\n// stale old shape\n`);
    expect(await applyApprovalHookFile(workspace, OMP_APPROVAL_HOOK_FILE)).toBe('refreshed');
    expect(readFileSync(join(workspace, OMP_APPROVAL_HOOK_DIR, OMP_APPROVAL_HOOK_FILE), 'utf-8')).toBe(
      generateOmpApprovalHook()
    );
  });

  it("never overwrites another project's hook of the same name", async () => {
    mkdirSync(join(workspace, OMP_APPROVAL_HOOK_DIR), { recursive: true });
    const foreign = 'export default function mine() {}\n';
    writeFileSync(join(workspace, OMP_APPROVAL_HOOK_DIR, OMP_APPROVAL_HOOK_FILE), foreign);
    expect(await applyApprovalHookFile(workspace, OMP_APPROVAL_HOOK_FILE)).toBe('foreign');
    expect(readFileSync(join(workspace, OMP_APPROVAL_HOOK_DIR, OMP_APPROVAL_HOOK_FILE), 'utf-8')).toBe(foreign);
  });

  // Every component below the workspace, and the file itself: a link at any level
  // would put the module wherever it points.
  it.each([
    ['.claude', '.claude'],
    ['.claude/hooks', join('.claude', 'hooks')],
    ['.claude/hooks/pre', OMP_APPROVAL_HOOK_DIR],
  ])('refuses to write through a symlinked %s', async (_label, linkRel) => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'codeman-omp-hook-target-'));
    try {
      const link = join(workspace, linkRel);
      mkdirSync(join(link, '..'), { recursive: true });
      symlinkSync(elsewhere, link);
      expect(await applyApprovalHookFile(workspace, OMP_APPROVAL_HOOK_FILE)).toBe('symlink');
      // Nothing written anywhere under the link target.
      expect(existsSync(join(elsewhere, 'pre'))).toBe(false);
      expect(existsSync(join(elsewhere, 'hooks'))).toBe(false);
      expect(existsSync(join(elsewhere, OMP_APPROVAL_HOOK_FILE))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked target file', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'codeman-omp-hook-target-'));
    try {
      const outside = join(elsewhere, 'victim.ts');
      writeFileSync(outside, `// ${MARKER}\n`);
      mkdirSync(join(workspace, OMP_APPROVAL_HOOK_DIR), { recursive: true });
      symlinkSync(outside, join(workspace, OMP_APPROVAL_HOOK_DIR, OMP_APPROVAL_HOOK_FILE));
      expect(await applyApprovalHookFile(workspace, OMP_APPROVAL_HOOK_FILE)).toBe('symlink');
      expect(readFileSync(outside, 'utf-8')).toBe(`// ${MARKER}\n`);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
