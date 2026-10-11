/**
 * @fileoverview GOLDEN spawn-command pins for the CLI registry's argv engine.
 *
 * Every expectation here is a LITERAL STRING, deliberately. An earlier version of this work
 * compared the engine against `buildSpawnCommand()` instead — which read as a strong parity
 * proof right up until `buildSpawnCommand` was itself switched over to call the engine, at
 * which point it was comparing the engine with itself and would have happily accepted any
 * regression the two shared. Literals cannot rot that way: they were captured from the
 * hand-written builders BEFORE those builders were removed, and they are now the only
 * surviving record of what those builders emitted.
 *
 * ⚠️ If a change here makes one of these fail, the question is never "what is the new string?"
 * It is "which real CLI invocation just changed, and is that intended?" A byte that moves in
 * this file is a byte that moves in a command line Codeman executes.
 *
 * Coverage note: every mode with a launch spec is pinned, `grok` and `deepseek` included.
 * Grok had no parity coverage at all in the first draft of the registry, and deepseek did not
 * exist in it — the two modes most likely to be transcribed wrong were the two nothing
 * checked.
 *
 * Port: none (pure function over registry data).
 */

import { describe, it, expect } from 'vitest';
import { getCli } from '../src/config/cli-registry/registry.js';
import { buildSpawnCommandFromRegistry, type SpawnBridgeOptions } from '../src/session-cli-registry-bridge.js';
import { CODEX_REASONING_EFFORTS } from '../src/types/session.js';

/** A fixed session id, so `--session-id` is stable across runs. */
const SID = '0f9c2b14-1111-2222-3333-444455556666';

function render(options: SpawnBridgeOptions): string | undefined {
  const entry = getCli(options.mode);
  if (!entry) throw new Error(`no registry entry for mode ${options.mode}`);
  return buildSpawnCommandFromRegistry(entry, options);
}

/** Every claude case pins an explicit `claudeCliVersion` so the --name gate is deterministic. */
function claude(extra: Partial<SpawnBridgeOptions> = {}): string | undefined {
  return render({ mode: 'claude', sessionId: SID, claudeCliVersion: null, ...extra });
}

describe('claude', () => {
  it('defaults to skip-permissions plus a new session id', () => {
    expect(claude()).toBe('claude --dangerously-skip-permissions --session-id "0f9c2b14-1111-2222-3333-444455556666"');
  });

  it('maps each permission mode', () => {
    expect(claude({ claudeMode: 'auto' })).toBe(
      'claude --permission-mode auto --session-id "0f9c2b14-1111-2222-3333-444455556666"'
    );
    expect(claude({ claudeMode: 'normal' })).toBe('claude --session-id "0f9c2b14-1111-2222-3333-444455556666"');
    expect(claude({ claudeMode: 'allowedTools', allowedTools: 'Bash(git:*), Read' })).toBe(
      'claude --allowedTools "Bash(git:*), Read" --session-id "0f9c2b14-1111-2222-3333-444455556666"'
    );
  });

  it('renders a model as the quoted value of --model, even one that opens with a dash', () => {
    // POST /api/sessions refuses a leading '-' in `model`, but the registry's `model-claude`
    // pattern still admits one, so the builder must stay safe on its own: the value lands
    // quoted, and Claude's option parser takes the word after `--model` as its value whatever
    // it starts with, so it can never become a flag of its own.
    expect(claude({ model: 'claude-fable-5-1' })).toBe(
      'claude --dangerously-skip-permissions --session-id "0f9c2b14-1111-2222-3333-444455556666" --model "claude-fable-5-1"'
    );
    expect(claude({ model: '--dangerously-skip-permissions' })).toBe(
      'claude --dangerously-skip-permissions --session-id "0f9c2b14-1111-2222-3333-444455556666" ' +
        '--model "--dangerously-skip-permissions"'
    );
  });

  it('resumes through a shell fallback to a fresh session', () => {
    // The ` || ` is emitted by the ENGINE, not by config — no registry field can hold shell
    // text. This pin is what proves the fallback chain still renders as one command line.
    expect(claude({ resumeSessionId: 'abc-123-def' })).toBe(
      'claude --dangerously-skip-permissions --resume "abc-123-def" || ' +
        'claude --dangerously-skip-permissions --session-id "0f9c2b14-1111-2222-3333-444455556666"'
    );
  });

  it('carries effort as a flag, and ultracode as a settings blob', () => {
    expect(claude({ effort: 'max' })).toBe(
      'claude --dangerously-skip-permissions --session-id "0f9c2b14-1111-2222-3333-444455556666" --effort \'max\''
    );
    expect(claude({ effort: 'ultracode' })).toBe(
      'claude --dangerously-skip-permissions --session-id "0f9c2b14-1111-2222-3333-444455556666" ' +
        '--settings \'{"ultracode":true}\''
    );
  });

  it('gates --name on the CLI version, failing closed when it is unknown', () => {
    const named = { sessionName: 'w1 alpha' };
    expect(claude({ ...named, claudeCliVersion: '2.1.226' })).toBe(
      'claude --dangerously-skip-permissions --session-id "0f9c2b14-1111-2222-3333-444455556666" --name "w1 alpha"'
    );
    expect(claude({ ...named, claudeCliVersion: '2.1.223' })).toBe(
      'claude --dangerously-skip-permissions --session-id "0f9c2b14-1111-2222-3333-444455556666"'
    );
    // Unknown version satisfies NO gate. A version probe that fails must not silently
    // upgrade behaviour.
    expect(claude({ ...named, claudeCliVersion: null })).toBe(
      'claude --dangerously-skip-permissions --session-id "0f9c2b14-1111-2222-3333-444455556666"'
    );
  });
});

describe('opencode', () => {
  const oc = (openCodeConfig?: SpawnBridgeOptions['openCodeConfig']) =>
    render({ mode: 'opencode', sessionId: SID, openCodeConfig });

  it('spawns bare by default', () => {
    expect(oc()).toBe('opencode');
  });

  it('reads its resume id through the legacy `continueSession` alias', () => {
    expect(oc({ model: 'anthropic/claude', continueSession: 'ses_9' })).toBe(
      'opencode --model anthropic/claude --session ses_9'
    );
  });

  it('only forks an existing session', () => {
    expect(oc({ continueSession: 'ses_9', forkSession: true })).toBe('opencode --session ses_9 --fork');
    // --fork with nothing to fork from would be meaningless, so it drops out entirely.
    expect(oc({ forkSession: true })).toBe('opencode');
  });
});

describe('codex', () => {
  const cx = (codexConfig?: SpawnBridgeOptions['codexConfig']) =>
    render({ mode: 'codex', sessionId: SID, codexConfig });

  it('spawns bare by default', () => {
    expect(cx()).toBe('codex');
  });

  it('emits the bypass flag only when asked', () => {
    expect(cx({ dangerouslyBypassApprovals: true })).toBe('codex --dangerously-bypass-approvals-and-sandbox');
    expect(cx({ dangerouslyBypassApprovals: false })).toBe('codex');
  });

  it('sends animations as an explicit true/false config pair', () => {
    expect(cx({ animations: true })).toBe('codex --config tui.animations=true');
    expect(cx({ animations: false })).toBe('codex --config tui.animations=false');
  });

  it('resumes with a POSITIONAL subcommand, not a flag', () => {
    expect(cx({ model: 'gpt-5', resumeSessionId: 'roll_42' })).toBe('codex --model gpt-5 resume roll_42');
  });

  it('sends reasoning effort as one model_reasoning_effort config value, for every level', () => {
    for (const level of CODEX_REASONING_EFFORTS) {
      expect(cx({ reasoningEffort: level })).toBe(`codex --config model_reasoning_effort=${level}`);
    }
  });

  it('keeps reasoning effort ahead of the resume subcommand', () => {
    expect(cx({ model: 'gpt-5', reasoningEffort: 'high', resumeSessionId: 'roll_42' })).toBe(
      'codex --model gpt-5 --config model_reasoning_effort=high resume roll_42'
    );
  });
});

describe('gemini', () => {
  const gm = (geminiConfig?: SpawnBridgeOptions['geminiConfig']) =>
    render({ mode: 'gemini', sessionId: SID, geminiConfig });

  it('defaults an absent approval mode to yolo', () => {
    // ⚠️ This is the DEFAULT-IS-UNSAFE case the multi-user clamp has to MATERIALIZE a config
    // for: sending no geminiConfig at all still yields yolo, so an only-if-sent clamp would
    // miss it entirely. See test/routes/external-cli-bypass-clamp.test.ts.
    expect(gm()).toBe('gemini --skip-trust --approval-mode yolo');
  });

  it('honours an explicit approval mode', () => {
    expect(gm({ approvalMode: 'auto_edit' })).toBe('gemini --skip-trust --approval-mode auto_edit');
  });

  it('reads its resume id through the legacy `resumeSession` alias', () => {
    expect(gm({ model: 'gemini-3-pro', resumeSession: 'conv.7' })).toBe(
      'gemini --skip-trust --approval-mode yolo --model gemini-3-pro --resume conv.7'
    );
  });
});

describe('antigravity', () => {
  const ag = (antigravityConfig?: SpawnBridgeOptions['antigravityConfig']) =>
    render({ mode: 'antigravity', sessionId: SID, antigravityConfig });

  it('runs `agy`, not `antigravity`', () => {
    // The mode name is not the binary name. Assuming it was is a bug this registry fixes.
    expect(ag()).toBe('agy');
  });

  it('emits its flags', () => {
    expect(ag({ dangerouslySkipPermissions: true, model: 'gemini-3-pro' })).toBe(
      'agy --dangerously-skip-permissions --model gemini-3-pro'
    );
    expect(ag({ resumeConversationId: 'conv-99' })).toBe('agy --conversation conv-99');
  });
});

describe('pi', () => {
  const pi = (piConfig?: SpawnBridgeOptions['piConfig']) => render({ mode: 'pi', sessionId: SID, piConfig });

  it('spawns bare by default', () => {
    expect(pi()).toBe('pi');
  });

  it('renders the full option set', () => {
    expect(pi({ model: 'sonnet:high', provider: 'anthropic', thinking: 'xhigh' })).toBe(
      'pi --model sonnet:high --provider anthropic --thinking xhigh'
    );
  });

  it('treats project trust as a TRI-state', () => {
    // Absent is a third state, not a synonym for false: it leaves pi to ask interactively.
    expect(pi({ approveProjectTrust: true })).toBe('pi --approve');
    expect(pi({ approveProjectTrust: false })).toBe('pi --no-approve');
    expect(pi()).toBe('pi');
  });

  it('prefers an explicit session id over -c', () => {
    expect(pi({ resumeSessionId: '0f9c2b14' })).toBe('pi --session 0f9c2b14');
    expect(pi({ continueSession: true })).toBe('pi -c');
    expect(pi({ continueSession: true, resumeSessionId: '0f9c2b14' })).toBe('pi --session 0f9c2b14');
  });
});

describe('grok', () => {
  const gk = (grokConfig?: SpawnBridgeOptions['grokConfig']) => render({ mode: 'grok', sessionId: SID, grokConfig });

  it('spawns bare by default', () => {
    expect(gk()).toBe('grok');
  });

  it('emits its bypass flag only when asked', () => {
    expect(gk({ alwaysApprove: true, model: 'grok-4.5' })).toBe('grok --always-approve --model grok-4.5');
    expect(gk({ alwaysApprove: false })).toBe('grok');
  });

  it('prefers an explicit resume id over --continue', () => {
    expect(gk({ resumeSessionId: '0198f2b4' })).toBe('grok --resume 0198f2b4');
    expect(gk({ continueSession: true })).toBe('grok --continue');
    expect(gk({ continueSession: true, resumeSessionId: '0198f2b4' })).toBe('grok --resume 0198f2b4');
  });

  it('never puts a credential on the command line', () => {
    // grok authenticates from XAI_API_KEY, pushed via `tmux setenv`. There is no --api-key
    // arg in its launch spec and there must never be one: the command line is visible to
    // every process on the box.
    const cmd = gk({ alwaysApprove: true, model: 'grok-4.5' }) ?? '';
    expect(cmd).not.toContain('key');
    expect(cmd).not.toContain('token');
  });
});

describe('deepseek', () => {
  const ds = (deepSeekConfig?: SpawnBridgeOptions['deepSeekConfig']) =>
    render({ mode: 'deepseek', sessionId: SID, deepSeekConfig });

  it('launches a named profile', () => {
    expect(ds({ profile: 'dsh-tui' })).toBe('dsh --profile dsh-tui');
  });

  it('prefers an explicit resume id over the bare --resume', () => {
    expect(ds({ profile: 'p', resumeSessionId: 'sess_42' })).toBe('dsh --profile p --resume sess_42');
    expect(ds({ profile: 'p', resumeSession: true })).toBe('dsh --profile p --resume');
  });

  it('never puts the permission mode on the command line', () => {
    // dsh has no permission FLAG — the switch is the DSH_PERMISSION_MODE env var, exported
    // via `tmux setenv`. If this ever renders as an argument, the multi-user clamp and the
    // env-key drop are both looking at the wrong surface.
    const cmd = ds({ profile: 'p', permissionMode: 'danger-full-access' }) ?? '';
    expect(cmd).toBe('dsh --profile p');
    expect(cmd).not.toContain('danger-full-access');
    expect(cmd).not.toContain('permission');
  });
});

describe('shell', () => {
  it('renders no command at all', () => {
    // `undefined` is the signal to fall back to local login-shell resolution, which varies
    // per user's /etc/passwd entry and so cannot be templated. An empty string would be a
    // command, and a wrong one.
    expect(render({ mode: 'shell', sessionId: SID })).toBeUndefined();
  });
});

describe('unsafe values are DROPPED, never escaped into the command', () => {
  // The hand-written builders silently omitted an argument whose value failed its allowlist,
  // rather than quoting it through. That is the behaviour being preserved: a rejected value
  // must not reach the CLI in ANY form, because "quoted but present" still lets a caller
  // steer the agent (a bogus --model, a traversal path as a session id).
  it.each([
    ['claude model', { mode: 'claude' as const, model: 'opus`whoami`' }, 'opus'],
    ['claude resume id', { mode: 'claude' as const, resumeSessionId: '../../etc/passwd' }, 'passwd'],
    [
      'claude allowedTools',
      { mode: 'claude' as const, claudeMode: 'allowedTools' as const, allowedTools: 'Bash(x); rm -rf /' },
      'rm',
    ],
  ])('%s', (_label, extra, forbidden) => {
    const cmd = claude(extra) ?? '';
    expect(cmd).not.toContain(forbidden);
    expect(cmd).not.toContain('`');
    expect(cmd).not.toContain(';');
  });

  it('drops an unsafe pi model without falling back to a different one', () => {
    expect(render({ mode: 'pi', sessionId: SID, piConfig: { model: 'a`b' } })).toBe('pi');
  });

  it('refuses a deepseek profile that is not a single path segment', () => {
    // A profile name is joined into a filesystem path as well as a shell line, so `../evil`
    // has to fail the token pattern rather than be quoted. With no valid name and no default
    // profile installed, the flag drops out entirely and dsh picks its own.
    const cmd = render({ mode: 'deepseek', sessionId: SID, deepSeekConfig: { profile: '../evil' } }) ?? '';
    expect(cmd).not.toContain('evil');
    expect(cmd).not.toContain('..');
  });
});

describe('copilot', () => {
  const cp = (copilotConfig?: SpawnBridgeOptions['copilotConfig']) =>
    render({ mode: 'copilot' as never, sessionId: SID, copilotConfig });

  it("spawns bare by default, in Copilot's own Manual Approval mode", () => {
    expect(cp()).toBe('copilot');
  });

  it('emits --yolo only when asked, with the model', () => {
    expect(cp({ allowAll: true, model: 'claude-sonnet-5.5' })).toBe('copilot --yolo --model claude-sonnet-5.5');
    expect(cp({ allowAll: false })).toBe('copilot');
  });

  it("pins the tab's name as --name", () => {
    expect(render({ mode: 'copilot' as never, sessionId: SID, sessionName: 'w4-Codeman' } as never)).toBe(
      'copilot --name "w4-Codeman"'
    );
  });

  it('drops --name next to --resume and --continue, which copilot refuses to combine', () => {
    const named = (copilotConfig: SpawnBridgeOptions['copilotConfig']) =>
      render({ mode: 'copilot' as never, sessionId: SID, sessionName: 'w4-Codeman', copilotConfig } as never);
    expect(named({ resumeSessionId: '0c02c30f' })).toBe('copilot --resume 0c02c30f');
    expect(named({ continueSession: true })).toBe('copilot --continue');
    expect(named({ allowAll: true, model: 'auto' })).toBe('copilot --yolo --name "w4-Codeman" --model auto');
  });

  it('prefers an explicit resume id over --continue', () => {
    expect(cp({ resumeSessionId: '0c02c30f-3383-4139-8b52-b28abad2ad43' })).toBe(
      'copilot --resume 0c02c30f-3383-4139-8b52-b28abad2ad43'
    );
    expect(cp({ continueSession: true })).toBe('copilot --continue');
    expect(cp({ continueSession: true, resumeSessionId: '0c02c30f' })).toBe('copilot --resume 0c02c30f');
  });

  it('drops unsafe values rather than escaping them', () => {
    expect(cp({ model: 'a`b' })).toBe('copilot');
    expect(cp({ resumeSessionId: 'my session; rm -rf /' })).toBe('copilot');
  });

  // `--resume`'s value is optional, so `--resume --yolo` would make `--yolo` its own flag and get
  // around the allowAll clamp. A resume value must start with an alphanumeric.
  it('drops a resume value that would be read as a flag', () => {
    for (const resumeSessionId of ['--yolo', '-n', '--allow-all-tools', '.', '..', '.hidden']) {
      expect(cp({ resumeSessionId })).toBe('copilot');
    }
    expect(cp({ allowAll: false, resumeSessionId: '--yolo' })).toBe('copilot');
    // A plain word is still passed through (a session NAME also resumes).
    expect(cp({ resumeSessionId: 'my-feature' })).toBe('copilot --resume my-feature');
  });

  it('never puts a credential on the command line', () => {
    const cmd = cp({ allowAll: true, model: 'auto' }) ?? '';
    expect(cmd).not.toContain('token');
    expect(cmd).not.toContain('key');
  });
});
