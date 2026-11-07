import { describe, expect, it, vi } from 'vitest';
import {
  DiscordModelControls,
  nativeModelComposerReady,
  readCodexModelStatus,
  readNativeModelMenu,
  type DiscordModelTarget,
} from '../src/discord-model-controls.js';

const UUID = '019a1111-1111-7111-8111-111111111111';
function harness(mode: 'codex' | 'claude' = 'codex') {
  const models =
    mode === 'codex' ? ['GPT-6.1-Sol', 'GPT-6-Luna'] : ['Default (recommended)', 'Opus', 'Sonnet', 'Haiku'];
  const values = mode === 'codex' ? ['gpt-6.1-sol', 'gpt-6-luna'] : ['default', 'opus', 'sonnet', 'haiku'];
  let current = 0,
    selected = 0,
    effort = 'medium',
    draftEffort = effort,
    history = '',
    opened = false;
  let staleStatus = '',
    staleStatusReads = 0,
    delayStatus = false;
  let screen = '',
    generation = 'one',
    scope: string | undefined = 'scope';
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  const ready = () =>
    `${history}\n${mode === 'codex' ? '›' : '❯'} \x1b[2m${mode === 'codex' ? 'Ask Codex to do anything' : 'Try "write a test"'}\x1b[22m\n` +
    (mode === 'codex' ? `  ${models[current]} ${effort} · /tmp/test\n  ? for shortcuts` : '  ? for shortcuts');
  const menu = () =>
    '\n  ' +
    (mode === 'codex' ? 'Select Model and Effort' : 'Select model') +
    '\n\n' +
    models
      .map(
        (m, i) =>
          `${i === selected ? (mode === 'codex' ? '›' : '❯') : ' '} ${i + 1}. ${m}${i === current ? (mode === 'codex' ? ' (current)' : ' ✔') : ''}  Description`
      )
      .join('\n') +
    '\n\n' +
    (mode === 'codex'
      ? '  enter select · esc back'
      : `  ◐ ${draftEffort === 'xhigh' ? 'xHigh' : draftEffort[0].toUpperCase() + draftEffort.slice(1)} effort ←/→ to adjust\n  Enter to set as default · s to use this session only · Esc to cancel`);
  screen = ready();
  const write = vi.fn(async (input: string) => {
    if (input === '/status\r') {
      if (delayStatus && history.includes('/status')) {
        staleStatus = ready() + '\n';
        staleStatusReads = 2;
      }
      history += `\n/status\n  Model: ${models[current]} (reasoning ${effort})\n  Session: ${UUID}\n`;
      screen = ready();
    } else if (input === '/model\r') {
      opened = true;
      selected = current;
      draftEffort = effort;
      screen = menu();
    } else if (input === '\x1b') {
      opened = false;
      screen = ready();
    } else if (input === '\x1b[B' || input === '\x1b[A') {
      selected = Math.max(0, Math.min(models.length - 1, selected + (input.endsWith('B') ? 1 : -1)));
      screen = menu();
    } else if (input === '\x1b[C') {
      draftEffort = levels[(levels.indexOf(draftEffort) + 1) % levels.length];
      screen = menu();
    } else if (input === 's' && opened) {
      current = selected;
      effort = draftEffort;
      opened = false;
      history += `\n  ⎿  Set model to ${models[current]} for this session only with ${effort} effort\n`;
      screen = ready();
    } else if (mode === 'codex' && input.startsWith('/model ')) {
      const requested = input.slice(7, -1);
      const next = values.indexOf(requested);
      if (requested.startsWith('--reasoning=')) effort = requested.slice(12);
      else if (next >= 0) current = next;
      else {
        history += '\nUnknown model\n';
        screen = ready();
        return true;
      }
      history += `\n• Model changed to ${values[current]} ${effort} for this session only\n`;
      screen = ready();
    }
    return true;
  });
  const target: DiscordModelTarget = {
    mode,
    get generation() {
      return generation;
    },
    working: false,
    pending: false,
    exited: false,
    reportedModel: models[current],
    operate: vi.fn(async (operation, allowed) =>
      operation({
        current: () => !!allowed(),
        capture: vi.fn(async () => (staleStatusReads-- > 0 ? staleStatus : screen)),
        write,
        cancelMenu: async () => {
          await write('\x1b');
        },
      })
    ),
    catalog: async () =>
      values.map((id, i) => ({ id, label: models[i], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] })),
  };
  const controls = new DiscordModelControls({
    scope: () => scope,
    target: (id) => (id === 's1' ? target : undefined),
    sleep: async () => {},
  });
  return {
    controls,
    target,
    write,
    models,
    get screen() {
      return screen;
    },
    set screen(value) {
      screen = value;
    },
    get current() {
      return values[current];
    },
    get effort() {
      return effort;
    },
    get opened() {
      return opened;
    },
    change: () => {
      generation = 'two';
    },
    disable: () => {
      scope = undefined;
    },
    delayStatus: () => {
      delayStatus = true;
    },
  };
}

describe('Discord model settings', () => {
  it('reads native Codex model/effort, intersects the catalog with its picker and closes without changing anything', async () => {
    const h = harness();
    const reply = await h.controls.control('s1', 'model');
    expect(reply?.text).toContain('gpt-6-luna');
    expect(reply?.text).toContain('Current effort: medium');
    expect(reply?.actions).toHaveLength(2);
    expect(h.current).toBe('gpt-6.1-sol');
    expect(h.opened).toBe(false);
    expect(h.write.mock.calls.map((c) => c[0])).toEqual(['/status\r', '/model\r', '\x1b']);
  });
  it('applies a Codex model inline and verifies native status in the same conversation', async () => {
    const h = harness();
    const reply = await h.controls.control('s1', 'model gpt-6-luna');
    expect(reply?.text).toContain('Verified: model GPT-6-Luna');
    expect(h.write).toHaveBeenCalledWith('/model gpt-6-luna\r');
    expect(h.current).toBe('gpt-6-luna');
  });
  it('sets Codex reasoning through the session-only command, not config files or a restart', async () => {
    const h = harness();
    expect((await h.controls.control('s1', 'effort high'))?.text).toContain('effort high');
    expect(h.write).toHaveBeenCalledWith('/model --reasoning=high\r');
    expect(h.effort).toBe('high');
  });
  it('waits through a native redraw retaining the previous status before confirming the new effort', async () => {
    const h = harness();
    h.delayStatus();
    expect((await h.controls.control('s1', 'effort high'))?.text).toContain('Verified:');
    expect(h.effort).toBe('high');
  });
  it('refuses to confirm a different requested model when the CLI rejects it', async () => {
    const h = harness();
    expect((await h.controls.control('s1', 'model unknown-model'))?.text).not.toContain('Verified:');
    expect(h.current).toBe('gpt-6.1-sol');
  });
  it('verifies real Claude picker aliases and never sends inline commands which save defaults', async () => {
    const h = harness('claude');
    const reply = await h.controls.control('s1', 'model sonnet');
    expect(reply?.text).toContain('Verified: model Sonnet');
    expect(h.current).toBe('sonnet');
    expect(h.write).toHaveBeenCalledWith('s');
    expect(h.write.mock.calls.some(([c]) => c === '\r' || c.startsWith('/effort') || c.startsWith('/model '))).toBe(
      false
    );
    expect(h.opened).toBe(false);
  });
  it('enumerates Claude effort choices by cycling draft values, then cancels without applying them', async () => {
    const h = harness('claude');
    const reply = await h.controls.control('s1', 'effort');
    expect(reply?.text).toContain('medium, high, xhigh, max, low');
    expect(reply?.text).toContain('Current effort: medium');
    expect(h.effort).toBe('medium');
    expect(h.write).not.toHaveBeenCalledWith('s');
    expect(h.opened).toBe(false);
  });
  it('changes Claude effort using the current model and session-only key', async () => {
    const h = harness('claude');
    expect((await h.controls.control('s1', 'effort max'))?.text).toContain('effort max');
    expect(h.effort).toBe('max');
    expect(h.current).toBe('default');
    expect(h.write).toHaveBeenCalledWith('s');
  });
  it('refuses unsupported Claude model/effort choices and restores the composer', async () => {
    const h = harness('claude');
    expect((await h.controls.control('s1', 'model invented'))?.text).toContain('not offered');
    expect((await h.controls.control('s1', 'effort ultra'))?.text).toContain('not offered');
    expect(h.write).not.toHaveBeenCalledWith('s');
    expect(h.effort).toBe('medium');
    expect(h.opened).toBe(false);
  });
  it('does not apply a different Claude model if picker rows change while navigating', async () => {
    const h = harness('claude');
    const write = h.write.getMockImplementation()!;
    let changed = false;
    h.write.mockImplementation(async (input) => {
      const result = await write(input);
      if (input === '\x1b[B' && !changed) {
        h.models[2] = 'Haiku';
        changed = true;
      }
      return result;
    });
    expect((await h.controls.control('s1', 'model sonnet'))?.text).toContain('picker changed');
    expect(h.write).not.toHaveBeenCalledWith('s');
    expect(h.current).toBe('default');
    expect(h.opened).toBe(false);
  });
  it.each(['working', 'pending', 'exited'] as const)(
    'does not send settings keys to an agent which is %s',
    async (field) => {
      const h = harness();
      h.target[field] = true;
      expect((await h.controls.control('s1', 'model gpt-6-luna'))?.text).not.toContain('Verified:');
      expect(h.write).not.toHaveBeenCalled();
    }
  );
  it('does not overwrite a draft or invoke a native command in an unverified terminal', async () => {
    const h = harness();
    h.screen = '› my unfinished draft\n  GPT-6.1-Sol medium · /tmp/test\n  ? for shortcuts';
    expect((await h.controls.control('s1', 'model gpt-6-luna'))?.text).toContain('empty native composer');
    expect(h.write).not.toHaveBeenCalled();
  });
  it.each(['model foo\n/run', 'effort high; touch /tmp/x', 'model --danger', 'effort nonsense'])(
    'rejects invalid command %s',
    async (command) => {
      const h = harness();
      await h.controls.control('s1', command);
      expect(h.write).not.toHaveBeenCalled();
    }
  );
  it('binds choices to a session revision and consumes them once', async () => {
    const h = harness('claude');
    const choices = await h.controls.control('s1', 'model');
    const choice = choices!.actions!.find((a) => a.label === 'Sonnet')!;
    expect(h.controls.current('s1', choice.validity)).toBe(true);
    expect((await h.controls.control('s1', choice.command))?.text).toContain('Verified:');
    expect((await h.controls.control('s1', choice.command))?.text).toContain('expired');
  });
  it.each(['generation', 'disabled', 'pending'] as const)('rejects an old button after %s changes', async (change) => {
    const h = harness('claude');
    const reply = await h.controls.control('s1', 'model');
    const choice = reply!.actions![0];
    h.write.mockClear();
    if (change === 'generation') h.change();
    if (change === 'disabled') h.disable();
    if (change === 'pending') h.target.pending = true;
    expect(h.controls.current('s1', choice.validity)).toBe(false);
    await h.controls.control('s1', choice.command);
    expect(h.write).not.toHaveBeenCalled();
  });
  it('does not treat unverified menus or Claude default-saving variants as session-only controls', () => {
    const h = harness('claude');
    expect(readNativeModelMenu('claude', 'Select model\n❯ 1. Sonnet ✔\nEnter to set as default')).toBeUndefined();
    expect(nativeModelComposerReady('claude', h.screen)).toBe(true);
    expect(readCodexModelStatus('/status\n Model: GPT-6-Luna (reasoning high)\n Session: ' + UUID)).toEqual({
      model: 'GPT-6-Luna',
      effort: 'high',
      session: UUID,
    });
  });
  it('recognizes the owned Claude telemetry footer while continuing to refuse a real draft', () => {
    const footer =
      '\n────────────────\n  Opus 5.5  in:0 out:0\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
    expect(nativeModelComposerReady('claude', '❯ ' + footer)).toBe(true);
    expect(nativeModelComposerReady('claude', '❯ my draft' + footer)).toBe(false);
    expect(nativeModelComposerReady('claude', '❯ \n────────────────\n unknown custom footer')).toBe(false);
  });
  it('handles the exact extra tmux focus hint and authentication notice without masking a draft', () => {
    const footer =
      "\n────────────────\n  Opus 5.5  in:0 out:0   Not logged in · Run /login\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n  tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tracking";
    expect(nativeModelComposerReady('claude', '❯ \x1b[2mTry\x1b[0m \x1b[2m"fix lint errors"\x1b[0m' + footer)).toBe(
      true
    );
    expect(nativeModelComposerReady('claude', '❯ my real draft' + footer)).toBe(false);
    expect(nativeModelComposerReady('claude', '❯ ' + footer + '\n Unknown terminal state')).toBe(false);
  });
  it('separates current model and effort from the optional native reasoning-summary setting', () => {
    expect(
      readCodexModelStatus('/status\n Model: GPT-6.1-Sol (reasoning high, summaries auto)\n Session: ' + UUID)
    ).toEqual({ model: 'GPT-6.1-Sol', effort: 'high', session: UUID });
  });
});
