/**
 * @fileoverview Tests for the two custom-model IO-layer fixes on top of the pure builder
 * (docs/custom-model-endpoints-plan.md):
 *
 * 1. `contextLengthVar` — a discovered per-model context length reaches the actual
 *    session env (CLAUDE_CODE_MAX_CONTEXT_TOKENS), so a CLI stops assuming a large
 *    default window for an unrecognized custom model id and overflowing a much
 *    smaller real one.
 * 2. `configDirVar` — an isolated, empty config directory is created and pointed at
 *    (CLAUDE_CONFIG_DIR), so an injected API key never shares a directory with a
 *    stored claude.ai OAuth session; `projects` is symlinked back into the real
 *    config dir so the response viewer/subagent windows/Read My Mind keep working.
 *
 * Port: N/A (no server; filesystem-only, under a temp CODEMAN data dir from test/setup.ts).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCli } from '../src/config/cli-registry/index.js';
import { applyCustomModelInjection, customModelConfigDir } from '../src/custom-model-injection-apply.js';
import type { CustomModelEndpoint } from '../src/custom-model-injection.js';

const endpoint: CustomModelEndpoint = {
  id: 'ep1',
  label: 'llama.cpp box',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'my-key',
};

function entryOrThrow(id: string) {
  const entry = getCli(id);
  if (!entry) throw new Error(`missing CLI registry entry: ${id}`);
  return entry;
}

const sessionsToClean: string[] = [];
afterEach(() => {
  for (const id of sessionsToClean.splice(0)) rmSync(customModelConfigDir(id), { recursive: true, force: true });
});

describe('applyCustomModelInjection: context length', () => {
  it('claude: passes a known context length through to CLAUDE_CODE_MAX_CONTEXT_TOKENS', () => {
    sessionsToClean.push('sess-ctx-1');
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', 'sess-ctx-1', 16384);
    expect(applied?.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('16384');
    expect(applied?.envKeys).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
  });

  it('claude: omits the var entirely when the context length is unknown', () => {
    sessionsToClean.push('sess-ctx-2');
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', 'sess-ctx-2');
    expect(applied?.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('deepseek: has no contextLengthVar declared, so a passed-in length is a no-op', () => {
    const applied = applyCustomModelInjection(entryOrThrow('deepseek'), endpoint, 'qwen3', 'sess-ctx-3', 16384);
    expect(Object.keys(applied?.envOverrides ?? {}).sort()).toEqual(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']);
  });
});

describe('applyCustomModelInjection: CLAUDE_CONFIG_DIR isolation', () => {
  it('claude: creates an isolated config dir (no real credential/config files) and points CLAUDE_CONFIG_DIR at it', () => {
    const sessionId = 'sess-cfgdir-1';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    const expectedDir = customModelConfigDir(sessionId);
    expect(applied?.envOverrides.CLAUDE_CONFIG_DIR).toBe(expectedDir);
    expect(applied?.configDir).toBe(expectedDir);
    expect(existsSync(expectedDir)).toBe(true);
    // The trust-seed file, the skipFirstRunPrompts settings.json, and the projects link —
    // no real OAuth credential/config.
    const entries = readdirSync(expectedDir).filter((name) => name !== 'projects');
    expect(entries.sort()).toEqual(['.claude.json', 'settings.json']);
  });

  it('claude: symlinks (or junctions) projects back to the real config dir so the response viewer keeps working', () => {
    const sessionId = 'sess-cfgdir-2';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    const link = join(applied!.configDir!, 'projects');
    // Best-effort: only assert the link exists if it was actually created (the real
    // ~/.claude/projects may not exist on a bare CI box, in which case linking is skipped).
    if (existsSync(join(homedir(), '.claude', 'projects'))) {
      expect(existsSync(link)).toBe(true);
      expect(lstatSync(link).isSymbolicLink() || lstatSync(link).isDirectory()).toBe(true);
    }
  });

  it('claude: re-applying to the same session is idempotent (boot-recovery re-apply)', () => {
    const sessionId = 'sess-cfgdir-3';
    sessionsToClean.push(sessionId);
    const first = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    const second = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    expect(second?.configDir).toBe(first?.configDir);
    expect(existsSync(first!.configDir!)).toBe(true);
  });

  it('pi: configDir-kind CLIs are unaffected — no configDirVar concept for them', () => {
    const sessionId = 'sess-cfgdir-pi';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(entryOrThrow('pi'), endpoint, 'qwen3', sessionId);
    expect(applied?.envOverrides.HOME).toBe(customModelConfigDir(sessionId));
  });

  it('deepseek: no configDirVar declared, so no config dir is created at all', () => {
    const sessionId = 'sess-cfgdir-deepseek';
    const applied = applyCustomModelInjection(entryOrThrow('deepseek'), endpoint, 'qwen3', sessionId);
    expect(applied?.configDir).toBeUndefined();
    expect(existsSync(customModelConfigDir(sessionId))).toBe(false);
  });
});

describe('applyCustomModelInjection: apiKeyTrustFile (pre-approves the injected key)', () => {
  it('claude: seeds .claude.json so the "Detected a custom API key" prompt never fires', () => {
    const sessionId = 'sess-trust-1';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    const written = JSON.parse(readFileSync(join(applied!.configDir!, '.claude.json'), 'utf8')) as {
      customApiKeyResponses: { approved: string[]; rejected: string[] };
    };
    expect(written.customApiKeyResponses.approved).toEqual(['my-key']);
    expect(written.customApiKeyResponses.rejected).toEqual([]);
  });

  // ⚠ Claude Code stores and looks up only the LAST 20 CHARACTERS of a key
  // (`key.trim().slice(-20)`, applied on both write and read), so seeding the whole key
  // never matches for a REAL one and the launch stops at the interactive "Detected a
  // custom API key" prompt whose default is "No (recommended)". Every other test here
  // uses a key shorter than 20 characters, where slice(-20) is the whole string and the
  // bug is invisible, which is exactly how it survived review.
  it('claude: seeds a REAL-length key in the truncated form the CLI actually matches on', () => {
    const sessionId = 'sess-trust-long';
    sessionsToClean.push(sessionId);
    const longKey = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef';
    expect(longKey.length).toBeGreaterThan(20);

    const applied = applyCustomModelInjection(
      entryOrThrow('claude'),
      { ...endpoint, apiKey: longKey },
      'qwen3',
      sessionId
    );
    const written = JSON.parse(readFileSync(join(applied!.configDir!, '.claude.json'), 'utf8')) as {
      customApiKeyResponses: { approved: string[] };
    };

    expect(written.customApiKeyResponses.approved).toEqual(['cdef0123456789abcdef']);
    expect(written.customApiKeyResponses.approved[0]).toHaveLength(20);
    // and the full credential is not written into this second file at all
    expect(readFileSync(join(applied!.configDir!, '.claude.json'), 'utf8')).not.toContain(longKey);
  });

  it('claude: falls back to the dummy key when the endpoint has none, and still seeds it', () => {
    const sessionId = 'sess-trust-2';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(
      entryOrThrow('claude'),
      { ...endpoint, apiKey: undefined },
      'qwen3',
      sessionId
    );
    const written = JSON.parse(readFileSync(join(applied!.configDir!, '.claude.json'), 'utf8')) as {
      customApiKeyResponses: { approved: string[] };
    };
    expect(written.customApiKeyResponses.approved).toEqual(['local-dummy-key']);
  });

  it('claude: merges onto fields the CLI itself already wrote into the same isolated dir, never overwrites them', () => {
    const sessionId = 'sess-trust-3';
    sessionsToClean.push(sessionId);
    const configDir = customModelConfigDir(sessionId);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ userID: 'abc123', numStartups: 3 }));

    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);

    const written = JSON.parse(readFileSync(join(applied!.configDir!, '.claude.json'), 'utf8')) as {
      userID: string;
      numStartups: number;
      customApiKeyResponses: { approved: string[] };
    };
    expect(written.userID).toBe('abc123');
    expect(written.numStartups).toBe(3);
    expect(written.customApiKeyResponses.approved).toEqual(['my-key']);
  });

  it('claude: a corrupt existing file is treated as absent rather than failing the apply', () => {
    const sessionId = 'sess-trust-4';
    sessionsToClean.push(sessionId);
    const configDir = customModelConfigDir(sessionId);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.claude.json'), '{ not valid json');

    expect(() => applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId)).not.toThrow();
    const written = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as {
      customApiKeyResponses: { approved: string[] };
    };
    expect(written.customApiKeyResponses.approved).toEqual(['my-key']);
  });

  it('claude: re-approving the same key does not duplicate it in the approved list', () => {
    const sessionId = 'sess-trust-5';
    sessionsToClean.push(sessionId);
    applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    const second = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'llama3', sessionId);
    const written = JSON.parse(readFileSync(join(second!.configDir!, '.claude.json'), 'utf8')) as {
      customApiKeyResponses: { approved: string[] };
    };
    expect(written.customApiKeyResponses.approved).toEqual(['my-key']);
  });

  it('opencode: has no apiKeyTrustFile declared (no configDirVar at all), nothing is seeded', () => {
    const sessionId = 'sess-trust-opencode';
    const applied = applyCustomModelInjection(entryOrThrow('opencode'), endpoint, 'qwen3', sessionId);
    expect(applied?.configDir).toBeUndefined();
    expect(existsSync(customModelConfigDir(sessionId))).toBe(false);
  });
});

describe("applyCustomModelInjection: skipFirstRunPrompts (an isolated dir replays claude's whole first-run sequence)", () => {
  it("claude: seeds hasCompletedOnboarding and this session's own project trust into .claude.json", () => {
    const sessionId = 'sess-firstrun-1';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(
      entryOrThrow('claude'),
      endpoint,
      'qwen3',
      sessionId,
      undefined,
      '/home/user/myproject'
    );
    const written = JSON.parse(readFileSync(join(applied!.configDir!, '.claude.json'), 'utf8')) as {
      hasCompletedOnboarding: boolean;
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(written.hasCompletedOnboarding).toBe(true);
    expect(written.projects['/home/user/myproject'].hasTrustDialogAccepted).toBe(true);
  });

  it('claude: seeds skipDangerousModePermissionPrompt into settings.json', () => {
    const sessionId = 'sess-firstrun-2';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    const written = JSON.parse(readFileSync(join(applied!.configDir!, 'settings.json'), 'utf8')) as {
      skipDangerousModePermissionPrompt: boolean;
    };
    expect(written.skipDangerousModePermissionPrompt).toBe(true);
  });

  it('claude: with no workingDir given (boot recovery), hasCompletedOnboarding/settings still seed, but no project entry is added', () => {
    const sessionId = 'sess-firstrun-3';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    const written = JSON.parse(readFileSync(join(applied!.configDir!, '.claude.json'), 'utf8')) as {
      hasCompletedOnboarding: boolean;
      projects?: Record<string, unknown>;
    };
    expect(written.hasCompletedOnboarding).toBeUndefined();
    expect(written.projects).toBeUndefined();
  });

  it("claude: merges onto an existing project entry's other fields rather than overwriting them", () => {
    const sessionId = 'sess-firstrun-4';
    sessionsToClean.push(sessionId);
    const configDir = customModelConfigDir(sessionId);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, '.claude.json'),
      JSON.stringify({ projects: { '/home/user/myproject': { allowedTools: ['Bash'] } } })
    );

    const applied = applyCustomModelInjection(
      entryOrThrow('claude'),
      endpoint,
      'qwen3',
      sessionId,
      undefined,
      '/home/user/myproject'
    );

    const written = JSON.parse(readFileSync(join(applied!.configDir!, '.claude.json'), 'utf8')) as {
      projects: Record<string, { allowedTools: string[]; hasTrustDialogAccepted: boolean }>;
    };
    expect(written.projects['/home/user/myproject'].allowedTools).toEqual(['Bash']);
    expect(written.projects['/home/user/myproject'].hasTrustDialogAccepted).toBe(true);
  });

  it('claude: a corrupt existing settings.json is treated as absent rather than failing the apply', () => {
    const sessionId = 'sess-firstrun-5';
    sessionsToClean.push(sessionId);
    const configDir = customModelConfigDir(sessionId);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.json'), '{ not valid json');

    expect(() => applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId)).not.toThrow();
    const written = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      skipDangerousModePermissionPrompt: boolean;
    };
    expect(written.skipDangerousModePermissionPrompt).toBe(true);
  });

  it('pi: has no skipFirstRunPrompts concept (no apiKeyTrustFile either) — nothing beyond its own config file', () => {
    const sessionId = 'sess-firstrun-pi';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(
      entryOrThrow('pi'),
      endpoint,
      'qwen3',
      sessionId,
      undefined,
      '/home/user/myproject'
    );
    const entries = readdirSync(applied!.configDir!);
    expect(entries).not.toContain('settings.json');
  });
});

describe('applyCustomModelInjection: pre-existing behavior unaffected', () => {
  it('opencode: still returns a plain env-kind result with no configDir', () => {
    const sessionId = 'sess-opencode-1';
    const applied = applyCustomModelInjection(entryOrThrow('opencode'), endpoint, 'qwen3', sessionId);
    expect(applied?.configDir).toBeUndefined();
    expect(applied?.envOverrides.OPENCODE_CONFIG_CONTENT).toBeTruthy();
  });

  it('antigravity: still undefined (unsupported)', () => {
    const applied = applyCustomModelInjection(entryOrThrow('antigravity'), endpoint, 'qwen3', 'sess-agy-1');
    expect(applied).toBeUndefined();
  });
});
