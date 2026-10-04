/**
 * @fileoverview Tests for Claude Code's advisor tool (code.claude.com/docs/en/advisor)
 * carried as a per-session `advisorModel`.
 *
 * The advisor rides the launch's ONE `--settings` JSON object as the `advisorModel` key,
 * never the `--advisor` flag: the flag exits at launch on a pairing the CLI refuses
 * (`claude --advisor haiku` prints "cannot be used as an advisor" and exits 1), while the
 * settings key degrades to "no advisor". Verified against Claude Code 2.1.289 with
 * `claude -p --settings '{"advisorModel":"opus"}' /advisor` → "Advisor: Opus 5.5".
 *
 * `--settings` is extracted through a REAL shell, as in statusline-cli-flag.test.ts, so the
 * assertions see exactly what a spawned pane would.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildAdvisorSettings, buildInteractiveArgs } from '../src/session-cli-builder.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { isAdvisorModel, ADVISOR_MODEL_ALIASES } from '../src/types.js';
import { Session } from '../src/session.js';
import {
  CreateSessionSchema,
  QuickStartSchema,
  RalphLoopStartSchema,
  SettingsUpdateSchema,
} from '../src/web/schemas.js';

const EXPORTER_CMD = 'curl -sfk -X POST "$CODEMAN_API_URL/api/status-telemetry" --data @- 2>/dev/null || true';

function extractSettingsJson(cmd: string): unknown {
  const idx = cmd.indexOf('--settings ');
  expect(idx).toBeGreaterThan(-1);
  const out = execFileSync('bash', ['-c', `set -- ${cmd.slice(idx)}; printf '%s' "$2"`]).toString();
  return JSON.parse(out);
}

describe('isAdvisorModel', () => {
  it('accepts the documented aliases', () => {
    for (const alias of ADVISOR_MODEL_ALIASES) expect(isAdvisorModel(alias)).toBe(true);
  });

  it('accepts full model ids in the advisor-capable families', () => {
    expect(isAdvisorModel('claude-opus-5-5')).toBe(true);
    expect(isAdvisorModel('claude-fable-5-1')).toBe(true);
    expect(isAdvisorModel('claude-sonnet-5-5')).toBe(true);
  });

  it('rejects haiku, which can call an advisor but never act as one', () => {
    expect(isAdvisorModel('haiku')).toBe(false);
    expect(isAdvisorModel('claude-haiku-4-5-20251001')).toBe(false);
  });

  it('rejects anything that could break out of the quoted --settings argument', () => {
    for (const bad of [
      '',
      'OPUS',
      'opus[1m]',
      "opus'; rm -rf /; '",
      'opus"}',
      'claude-opus-5-5 --dangerously-skip-permissions',
      `claude-opus-${'5-'.repeat(40)}5`,
      undefined,
      null,
      42,
    ]) {
      expect(isAdvisorModel(bad)).toBe(false);
    }
  });
});

describe('buildAdvisorSettings', () => {
  it('returns the settings key for a valid model and nothing otherwise', () => {
    expect(buildAdvisorSettings('opus')).toEqual({ advisorModel: 'opus' });
    expect(buildAdvisorSettings(undefined)).toEqual({});
    expect(buildAdvisorSettings('haiku')).toEqual({});
  });
});

describe('buildSpawnCommand advisorModel (tmux launch, claude mode)', () => {
  it('rides --settings as the advisorModel key, never the --advisor flag', () => {
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: 'sid-1', advisorModel: 'opus' });
    expect(cmd).not.toContain('--advisor');
    expect(cmd.match(/--settings/g)).toHaveLength(1);
    expect(extractSettingsJson(cmd)).toEqual({ advisorModel: 'opus' });
  });

  it('merges ultracode, advisor and the statusLine exporter into ONE --settings object', () => {
    const cmd = buildSpawnCommand({
      mode: 'claude',
      sessionId: 'sid-1',
      effort: 'ultracode',
      advisorModel: 'fable',
      statusLineCommand: EXPORTER_CMD,
    });
    expect(cmd.match(/--settings/g)).toHaveLength(1);
    expect(extractSettingsJson(cmd)).toEqual({
      ultracode: true,
      advisorModel: 'fable',
      statusLine: { type: 'command', command: EXPORTER_CMD },
    });
  });

  it('keeps a regular --effort flag beside the advisor settings', () => {
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: 'sid-1', effort: 'high', advisorModel: 'sonnet' });
    expect(cmd).toContain("--effort 'high'");
    expect(extractSettingsJson(cmd)).toEqual({ advisorModel: 'sonnet' });
  });

  it('carries the advisor on the resume variant too', () => {
    const cmd = buildSpawnCommand({
      mode: 'claude',
      sessionId: 'sid-1',
      resumeSessionId: '11111111-2222-3333-4444-555555555555',
      advisorModel: 'opus',
    });
    expect(cmd).toContain('--resume');
    expect(extractSettingsJson(cmd)).toEqual({ advisorModel: 'opus' });
  });

  it('leaves the command byte-identical when no advisor (or an invalid one) is set', () => {
    for (const base of [
      { mode: 'claude', sessionId: 'sid-1' },
      { mode: 'claude', sessionId: 'sid-1', effort: 'ultracode' as const, statusLineCommand: EXPORTER_CMD },
    ]) {
      const without = buildSpawnCommand(base);
      expect(buildSpawnCommand({ ...base, advisorModel: undefined })).toBe(without);
      expect(buildSpawnCommand({ ...base, advisorModel: 'haiku' })).toBe(without);
    }
  });

  it('is inert for a CLI that has no --settings carrier', () => {
    const cmd = buildSpawnCommand({ mode: 'codex', sessionId: 'sid-1', advisorModel: 'opus' });
    expect(cmd).not.toContain('advisorModel');
  });
});

describe('buildInteractiveArgs advisorModel (direct-PTY fallback)', () => {
  const settingsOf = (args: string[]) => {
    expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    return JSON.parse(args[args.indexOf('--settings') + 1]);
  };

  it('adds a --settings object holding only the advisor', () => {
    const args = buildInteractiveArgs('sid', 'normal', undefined, undefined, undefined, undefined, null, 'opus');
    expect(args).not.toContain('--advisor');
    expect(settingsOf(args)).toEqual({ advisorModel: 'opus' });
  });

  it("folds the advisor into ultracode's --settings object", () => {
    const args = buildInteractiveArgs('sid', 'normal', undefined, undefined, 'ultracode', undefined, null, 'fable');
    expect(settingsOf(args)).toEqual({ ultracode: true, advisorModel: 'fable' });
  });

  it('keeps --effort beside it for a regular level', () => {
    const args = buildInteractiveArgs('sid', 'normal', undefined, undefined, 'max', undefined, null, 'sonnet');
    expect(args).toEqual(expect.arrayContaining(['--effort', 'max']));
    expect(settingsOf(args)).toEqual({ advisorModel: 'sonnet' });
  });

  it('is unchanged without an advisor', () => {
    expect(buildInteractiveArgs('sid', 'normal', undefined, undefined, 'high', undefined, null, undefined)).toEqual(
      buildInteractiveArgs('sid', 'normal', undefined, undefined, 'high', undefined, null)
    );
  });
});

describe('Session advisorModel', () => {
  it('stores a valid advisor and persists it through toState()', () => {
    const session = new Session({ workingDir: '/tmp', advisorModel: 'opus' });
    expect(session.toState().advisorModel).toBe('opus');
  });

  it('drops an invalid value instead of forwarding it to the launch', () => {
    expect(new Session({ workingDir: '/tmp', advisorModel: 'haiku' }).toState().advisorModel).toBeUndefined();
    expect(new Session({ workingDir: '/tmp' }).toState().advisorModel).toBeUndefined();
  });
});

describe('advisorModel request validation', () => {
  it.each([
    ['CreateSessionSchema', CreateSessionSchema, { workingDir: '/tmp' }],
    ['QuickStartSchema', QuickStartSchema, {}],
    ['RalphLoopStartSchema', RalphLoopStartSchema, { taskDescription: 'x' }],
  ] as const)('%s accepts advisor models and rejects the rest', (_name, schema, base) => {
    expect(schema.safeParse({ ...base, advisorModel: 'opus' }).success).toBe(true);
    expect(schema.safeParse({ ...base, advisorModel: 'claude-fable-5-1' }).success).toBe(true);
    expect(schema.safeParse({ ...base }).success).toBe(true);
    expect(schema.safeParse({ ...base, advisorModel: 'haiku' }).success).toBe(false);
    expect(schema.safeParse({ ...base, advisorModel: "opus'" }).success).toBe(false);
  });

  it('SettingsUpdateSchema takes claudeAdvisorModel, with "" meaning the CLI default', () => {
    expect(SettingsUpdateSchema.safeParse({ claudeAdvisorModel: '' }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ claudeAdvisorModel: 'fable' }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ claudeAdvisorModel: 'haiku' }).success).toBe(false);
  });
});
