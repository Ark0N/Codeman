/** @fileoverview Header plan-usage chip provider rows (Claude above Codex). */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadCodemanAppClass() {
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const chip = { innerHTML: '', title: '' };
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
    document: {
      addEventListener: vi.fn(),
      getElementById: (id: string) => (id === 'planUsageChip' ? chip : null),
    },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return {
    CodemanApp: (context as { __CodemanApp: new () => unknown }).__CodemanApp,
    chip,
  };
}

type UsageApp = { updatePlanUsageChip: (data: unknown) => void };

describe('header plan usage chip', () => {
  it('renders Claude first and the main Codex limits underneath', () => {
    const { CodemanApp, chip } = loadCodemanAppClass();
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as UsageApp;

    app.updatePlanUsageChip({
      fiveHour: { usedPercentage: 97, resetAt: 1000 },
      sevenDay: { usedPercentage: 44, resetAt: 2000 },
      codex: { sevenDay: { usedPercentage: 40, resetAt: 3000 } },
    });

    expect(chip.innerHTML).toContain('class="pu-row"');
    expect(chip.innerHTML).toContain('class="pu-provider">Claude</span>');
    expect(chip.innerHTML).toContain('class="pu-provider">Codex</span>');
    expect(chip.innerHTML.indexOf('Claude')).toBeLessThan(chip.innerHTML.indexOf('Codex'));
    expect(chip.innerHTML).toContain('97%');
    expect(chip.innerHTML).toContain('44%');
    expect(chip.innerHTML).toContain('40%');
    expect(chip.title).toContain('Claude plan usage');
    expect(chip.title).toContain('Codex plan usage');
  });

  it('omits unavailable Codex windows instead of inventing zero usage', () => {
    const { CodemanApp, chip } = loadCodemanAppClass();
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as UsageApp;

    app.updatePlanUsageChip({
      fiveHour: { usedPercentage: 10, resetAt: 1000 },
      sevenDay: { usedPercentage: 20, resetAt: 2000 },
      codex: { sevenDay: { usedPercentage: 40, resetAt: 3000 } },
    });

    const codexRow = chip.innerHTML.slice(chip.innerHTML.indexOf('Codex'));
    expect(codexRow).not.toContain('5h');
    expect(codexRow).toContain('7d');
  });

  it("keeps Claude's 5h slot as a dash when no session window is open", () => {
    // Claude Code ships `five_hour` "only while the API reports it and its
    // resets_at has not passed", so between session windows the key is simply
    // absent. The chip used to shrink to a lone 7d segment, which reads as a
    // broken feature rather than an idle window (reported 2026-09-01).
    const { CodemanApp, chip } = loadCodemanAppClass();
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as UsageApp;

    app.updatePlanUsageChip({ sevenDay: { usedPercentage: 52, resetAt: 2000 } });

    expect(chip.innerHTML).toContain('pu-win-idle');
    expect(chip.innerHTML).toContain('5h');
    expect(chip.innerHTML).toContain('52%');
    expect(chip.title).toContain('no active session window');
  });

  it('renders no row at all for a provider reporting nothing', () => {
    // The placeholder must never stand alone: a row of em dashes would claim a
    // provider is idle when it is really absent.
    const { CodemanApp, chip } = loadCodemanAppClass();
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as UsageApp;

    app.updatePlanUsageChip({ codex: { sevenDay: { usedPercentage: 40, resetAt: 3000 } } });

    expect(chip.innerHTML).not.toContain('pu-win-idle');
    expect(chip.innerHTML).toContain('40%');
  });

  it('drops the provider label when Claude is the only provider with limits', () => {
    const { CodemanApp, chip } = loadCodemanAppClass();
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as UsageApp;

    app.updatePlanUsageChip({
      fiveHour: { usedPercentage: 60, resetAt: 1000 },
      sevenDay: { usedPercentage: 23, resetAt: 2000 },
    });

    expect(chip.innerHTML).toContain('class="pu-row"');
    expect(chip.innerHTML).not.toContain('pu-provider');
    expect(chip.innerHTML).not.toContain('Claude');
    expect(chip.innerHTML).toContain('60%');
    expect(chip.innerHTML).toContain('23%');
    // The tooltip still names the provider — it has room, and the chip no longer does.
    expect(chip.title).toContain('Claude plan usage');
  });

  it('drops the provider label when Codex is the only provider with limits', () => {
    const { CodemanApp, chip } = loadCodemanAppClass();
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as UsageApp;

    app.updatePlanUsageChip({
      codex: { fiveHour: { usedPercentage: 12, resetAt: 3000 } },
    });

    expect(chip.innerHTML).toContain('class="pu-row"');
    expect(chip.innerHTML).not.toContain('pu-provider');
    expect(chip.innerHTML).toContain('12%');
    expect(chip.title).toContain('Codex plan usage');
  });

  it('shows Copilot as a monthly window with request counts in the tooltip', () => {
    const { CodemanApp, chip } = loadCodemanAppClass();
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as UsageApp;

    app.updatePlanUsageChip({
      fiveHour: { usedPercentage: 10, resetAt: 1000 },
      sevenDay: { usedPercentage: 20, resetAt: 2000 },
      copilot: { monthly: { usedPercentage: 24.3, resetAt: 3000, used: 1215, limit: 5000 } },
    });

    expect(chip.innerHTML).toContain('class="pu-provider">Copilot</span>');
    expect(chip.innerHTML).toContain('mo');
    expect(chip.innerHTML).toContain('24%');
    expect(chip.title).toContain('Copilot plan usage');
    expect(chip.title).toContain('1215 of 5000 requests');
    // Only Copilot's own row carries a monthly window.
    const claudeRow = chip.innerHTML.slice(0, chip.innerHTML.indexOf('Copilot'));
    expect(claudeRow).not.toContain('>mo<');
  });

  it('shows a lone Copilot row without a provider label or a Claude placeholder', () => {
    const { CodemanApp, chip } = loadCodemanAppClass();
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as UsageApp;

    app.updatePlanUsageChip({ copilot: { monthly: { usedPercentage: 80, resetAt: 3000 } } });

    expect(chip.innerHTML).toContain('80%');
    expect(chip.innerHTML).not.toContain('pu-provider');
    expect(chip.innerHTML).not.toContain('pu-win-idle');
  });

  it('renders no Copilot row when the provider reports nothing', () => {
    const { CodemanApp, chip } = loadCodemanAppClass();
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as UsageApp;

    app.updatePlanUsageChip({ sevenDay: { usedPercentage: 30, resetAt: 2000 }, copilot: null });

    expect(chip.innerHTML).not.toContain('Copilot');
  });
});
