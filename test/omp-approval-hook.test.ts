/**
 * @fileoverview omp approval-hook wiring.
 *
 * Pins the three things that make an omp pane able to report a pending tool approval
 * at all: the registry says omp HAS hooks, Codeman installs the module that emits them,
 * and the module maps omp's events onto the names the server already routes on.
 *
 * Without these, `hooksAvailableForMode('omp')` is false, /api/approvals never receives
 * an item, and a dialog on screen raises no tab alert and no notification.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyApprovalHookFile,
  generateOmpApprovalHook,
  OMP_APPROVAL_HOOK_DIR,
  OMP_APPROVAL_HOOK_FILE,
} from '../src/hooks-config.js';
import { getCli } from '../src/config/cli-registry/registry.js';
import { hooksAvailableForMode } from '../src/web/session-wait-registry.js';

const MARKER = 'CODEMAN_OMP_APPROVAL_HOOK_V1';

describe('omp approval hook — registry', () => {
  it('declares hooks: always, which is what lets approval items be opened at all', () => {
    expect(getCli('omp')?.capabilities.hooks).toBe('always');
    expect(hooksAvailableForMode('omp')).toBe(true);
  });

  it('leaves every other hook-less CLI failing the ask', () => {
    // The rule that keeps this honest: 'always' is earned by a real signal, not by
    // wanting alerts. opencode/gemini/pi/grok/antigravity have no approval events.
    for (const mode of ['opencode', 'gemini', 'pi', 'grok', 'antigravity', 'shell'] as const) {
      expect(hooksAvailableForMode(mode), mode).toBe(false);
    }
  });

  it('names the hook module as registry data, so no call site branches on the id', () => {
    // The session-create path asks "does this CLI declare approvalHookFile?"; if the
    // field is absent the hook is never installed and the pane stays silent.
    expect(getCli('omp')?.capabilities.approvalHookFile).toBe(OMP_APPROVAL_HOOK_FILE);
    // claude installs a settings.local.json block instead and must NOT be given a file.
    expect(getCli('claude')?.capabilities.approvalHookFile).toBeUndefined();
  });
});

describe('omp approval hook — generated module', () => {
  const src = generateOmpApprovalHook();

  it('carries the ownership marker on its first line', () => {
    expect(src.split('\n')[0]).toContain(MARKER);
  });

  it('maps omp approval events onto the names the server routes on', () => {
    // APPROVAL_KIND_BY_EVENT opens an item for permission_prompt and resolves it on
    // elicitation_complete; using any other name makes the hook a silent no-op.
    expect(src).toContain('"tool_approval_requested"');
    expect(src).toContain('"tool_approval_resolved"');
    expect(src).toContain('"permission_prompt"');
    expect(src).toContain('"elicitation_complete"');
  });

  it('posts to the hook-event route with the secret header', () => {
    expect(src).toContain('/api/hook-event');
    expect(src).toContain('X-Codeman-Hook-Secret');
    expect(src).toContain('CODEMAN_SESSION_ID');
    expect(src).toContain('CODEMAN_API_URL');
  });

  it('fails open: both handlers catch and nothing is awaited unbounded', () => {
    expect(src).toContain('catch');
    expect(src).toContain('AbortSignal.timeout');
    // `void report(...)` — a rejected report must never surface to the dialog.
    expect(src).toMatch(/void report\(/);
  });

  it('uses a static import, so the module parses without a dynamic loader', () => {
    expect(src).toContain('import { readFile } from "node:fs/promises";');
    expect(src).not.toContain('await import(');
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

  it('refuses to write through a symlinked hooks directory', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'codeman-omp-hook-target-'));
    try {
      mkdirSync(join(workspace, '.claude', 'hooks'), { recursive: true });
      symlinkSync(elsewhere, join(workspace, OMP_APPROVAL_HOOK_DIR));
      expect(await applyApprovalHookFile(workspace, OMP_APPROVAL_HOOK_FILE)).toBe('symlink');
      expect(existsSync(join(elsewhere, OMP_APPROVAL_HOOK_FILE))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
