/**
 * First coverage for `clampExternalCliBypassForOwner` (session-routes.ts), the
 * multi-user §6.3 gate that keeps a NON-GRANTED owner from launching an external
 * CLI with its safety switches off. It backs both `POST /api/sessions` and
 * `POST /api/quick-start` and, until pi was added, had no tests at all.
 *
 * The helper has two shapes and the difference is the whole point:
 *  - only-if-sent (codex, antigravity, grok): an ABSENT config already spawns safe, so
 *    only a sent config needs its flag forced off.
 *  - MATERIALIZE (gemini, pi): the absent-config default is itself unsafe for a
 *    non-granted owner (gemini's builder defaults to `yolo`; pi's default is an
 *    interactive trust prompt the session user could just answer "yes" to), so
 *    the clamp has to CREATE a config.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _clampExternalCliBypassForOwner } from '../../src/web/routes/session-routes.js';
import { createUser, invalidateUsersCache } from '../../src/user-store.js';

const PASSWORD = 'clamp-test-password';

describe('clampExternalCliBypassForOwner — single-user mode', () => {
  it('passes every config through untouched (the gate is a no-op)', async () => {
    const out = await _clampExternalCliBypassForOwner(
      undefined,
      { dangerouslyBypassApprovals: true },
      { approvalMode: 'yolo' },
      { dangerouslySkipPermissions: true },
      { approveProjectTrust: true },
      { alwaysApprove: true }
    );
    expect(out.codexConfig).toEqual({ dangerouslyBypassApprovals: true });
    expect(out.geminiConfig).toEqual({ approvalMode: 'yolo' });
    expect(out.antigravityConfig).toEqual({ dangerouslySkipPermissions: true });
    expect(out.piConfig).toEqual({ approveProjectTrust: true });
    expect(out.grokConfig).toEqual({ alwaysApprove: true });
  });

  it('leaves absent configs absent', async () => {
    const out = await _clampExternalCliBypassForOwner(undefined, undefined, undefined, undefined, undefined, undefined);
    expect(out.codexConfig).toBeUndefined();
    expect(out.geminiConfig).toBeUndefined();
    expect(out.antigravityConfig).toBeUndefined();
    expect(out.piConfig).toBeUndefined();
    expect(out.grokConfig).toBeUndefined();
  });
});

describe('clampExternalCliBypassForOwner — multi-user mode', () => {
  // The temp HOME from test/setup.ts is per-FILE, so users.json survives between
  // tests here — create the three accounts once.
  beforeAll(async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    invalidateUsersCache();
    await createUser({ username: 'boss', role: 'admin', password: PASSWORD });
    await createUser({ username: 'peon', role: 'user', password: PASSWORD });
    await createUser({ username: 'trusted', role: 'user', password: PASSWORD, canBypassPermissions: true });
  });

  afterAll(() => {
    delete process.env.CODEMAN_MULTIUSER;
    invalidateUsersCache();
  });

  it('passes through for an admin owner', async () => {
    const out = await _clampExternalCliBypassForOwner(
      'boss',
      { dangerouslyBypassApprovals: true },
      undefined,
      { dangerouslySkipPermissions: true },
      { approveProjectTrust: true },
      { alwaysApprove: true }
    );
    expect(out.codexConfig).toEqual({ dangerouslyBypassApprovals: true });
    expect(out.geminiConfig).toBeUndefined();
    expect(out.antigravityConfig).toEqual({ dangerouslySkipPermissions: true });
    expect(out.piConfig).toEqual({ approveProjectTrust: true });
    expect(out.grokConfig).toEqual({ alwaysApprove: true });
  });

  it('passes through for a user holding the bypass grant', async () => {
    const out = await _clampExternalCliBypassForOwner(
      'trusted',
      undefined,
      undefined,
      undefined,
      { approveProjectTrust: true },
      { alwaysApprove: true }
    );
    expect(out.piConfig).toEqual({ approveProjectTrust: true });
    expect(out.grokConfig).toEqual({ alwaysApprove: true });
  });

  it('forces codex/antigravity/grok bypass off for a non-granted owner (only-if-sent branch)', async () => {
    const out = await _clampExternalCliBypassForOwner(
      'peon',
      { dangerouslyBypassApprovals: true, model: 'gpt-5' },
      undefined,
      { dangerouslySkipPermissions: true, model: 'gemini-3-pro' },
      undefined,
      { alwaysApprove: true, model: 'grok-4.5' }
    );
    expect(out.codexConfig).toEqual({ dangerouslyBypassApprovals: false, model: 'gpt-5' });
    expect(out.antigravityConfig).toEqual({ dangerouslySkipPermissions: false, model: 'gemini-3-pro' });
    expect(out.grokConfig).toEqual({ alwaysApprove: false, model: 'grok-4.5' });
  });

  it("keeps a non-granted owner's codex reasoning effort while forcing bypass off", async () => {
    // The clamp rewrites one field and must carry the rest; a clamp rebuilt from named
    // fields would drop the effort here without a word.
    const out = await _clampExternalCliBypassForOwner(
      'peon',
      { dangerouslyBypassApprovals: true, reasoningEffort: 'xhigh' },
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(out.codexConfig).toEqual({ dangerouslyBypassApprovals: false, reasoningEffort: 'xhigh' });
  });

  it('leaves codex/antigravity/grok absent when nothing was sent (they already spawn safe)', async () => {
    const out = await _clampExternalCliBypassForOwner('peon', undefined, undefined, undefined, undefined, undefined);
    expect(out.codexConfig).toBeUndefined();
    expect(out.antigravityConfig).toBeUndefined();
    expect(out.grokConfig).toBeUndefined();
  });

  it('MATERIALIZES gemini to auto_edit even when no config was sent', async () => {
    const out = await _clampExternalCliBypassForOwner('peon', undefined, undefined, undefined, undefined, undefined);
    expect(out.geminiConfig).toEqual({ approvalMode: 'auto_edit' });
  });

  it('MATERIALIZES pi to --no-approve even when no config was sent', async () => {
    // The load-bearing case: omitting --approve is NOT a clamp for pi, because
    // pi's own default is to ASK, and the session user can answer that prompt.
    const out = await _clampExternalCliBypassForOwner('peon', undefined, undefined, undefined, undefined, undefined);
    expect(out.piConfig).toEqual({ approveProjectTrust: false });
  });

  it('forces a sent pi approveProjectTrust:true down to false, keeping other fields', async () => {
    const out = await _clampExternalCliBypassForOwner(
      'peon',
      undefined,
      undefined,
      undefined,
      {
        approveProjectTrust: true,
        model: 'sonnet:high',
        provider: 'anthropic',
      },
      undefined
    );
    expect(out.piConfig).toEqual({
      approveProjectTrust: false,
      model: 'sonnet:high',
      provider: 'anthropic',
    });
  });

  it('fails closed for an unknown/deleted owner', async () => {
    const out = await _clampExternalCliBypassForOwner(
      'ghost',
      undefined,
      undefined,
      undefined,
      { approveProjectTrust: true },
      { alwaysApprove: true }
    );
    expect(out.piConfig).toEqual({ approveProjectTrust: false });
    expect(out.geminiConfig).toEqual({ approvalMode: 'auto_edit' });
    expect(out.grokConfig).toEqual({ alwaysApprove: false });
  });
});
