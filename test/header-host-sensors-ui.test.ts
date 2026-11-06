/**
 * @fileoverview The opt-in header readings (GPU, VRAM, GPU MHz, CPU MHz): all off by default, requested from
 * the server only while their setting is on, and shown only when the host reported them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const read = (name: string) => readFileSync(join(process.cwd(), 'src/web/public', name), 'utf-8');

type El = {
  hidden: boolean;
  textContent: string;
  style: Record<string, string>;
  classList: ReturnType<typeof classList>;
};
const classList = () => {
  const set = new Set<string>();
  return {
    set,
    add: (c: string) => set.add(c),
    remove: (c: string) => set.delete(c),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !set.has(c);
      if (on) set.add(c);
      else set.delete(c);
      return on;
    },
  };
};

function harness(settings: Record<string, unknown>, options: { hold?: boolean } = {}) {
  const els = new Map<string, El>();
  const fetched: string[] = [];
  let release: () => void = () => undefined;
  const gate = options.hold ? new Promise<void>((resolve) => (release = resolve)) : null;
  class CodemanApp {}
  const context = vm.createContext({
    CodemanApp,
    window: {},
    document: { getElementById: () => ({ style: {} }) },
    fetch: async (url: string) => {
      fetched.push(url);
      if (gate) await gate;
      return { json: async () => ({ data: { cpu: 1, memory: { usedMB: 1, totalMB: 2, percent: 50 } } }) };
    },
    localStorage: { getItem: () => null },
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  });
  vm.runInContext(read('panels-ui.js'), context, { filename: 'panels-ui.js' });
  const app = new (context.CodemanApp as new () => Record<string, (...a: unknown[]) => unknown>)();
  Object.assign(app, {
    loadAppSettingsFromStorage: () => settings,
    $: (id: string) => {
      if (!els.has(id))
        els.set(id, {
          hidden: true,
          textContent: '',
          style: { setProperty: () => {} } as unknown as Record<string, string>,
          classList: classList(),
        });
      return els.get(id);
    },
  });
  return { app, els, fetched, release };
}

describe('header host sensors', () => {
  it('requests nothing extra from the server when every setting is off (the default)', async () => {
    const { app, fetched } = harness({});
    await app.fetchSystemStats.call(app);
    expect(fetched).toEqual(['/api/system/stats']);
  });

  it('asks for exactly the readings whose setting is on', async () => {
    const { app, fetched } = harness({ showGpuStats: true, showCpuMhz: true });
    await app.fetchSystemStats.call(app);
    expect(fetched).toEqual(['/api/system/stats?gpu=1&cpumhz=1']);
  });

  it('shows an item only when its setting is on and the host reported it', () => {
    const stats = {
      gpu: { percent: 42, memPercent: 50, memUsedMB: 4096, memTotalMB: 8192, mhz: 1800 },
      cpuMhz: 3400,
    };
    const on = harness({ showGpuStats: true, showCpuMhz: true });
    on.app._updateHostSensors(stats);
    for (const id of ['statGpuItem', 'statVramItem', 'statCpuMhzItem', 'statGpuMhzItem']) {
      expect(on.els.get(id)?.hidden, id).toBe(false);
    }
    expect(on.els.get('statGpu')?.textContent).toBe('42%');
    expect(on.els.get('statVram')?.textContent).toBe('4.0G');
    expect(on.els.get('statCpuMhz')?.textContent).toBe('3400 MHz');
    expect(on.els.get('statGpuMhz')?.textContent).toBe('1800 MHz');

    const off = harness({});
    off.app._updateHostSensors(stats);
    for (const id of ['statGpuItem', 'statVramItem', 'statCpuMhzItem', 'statGpuMhzItem']) {
      expect(off.els.get(id)?.hidden, id).toBe(true);
    }

    // the GPU clock belongs to GPU Stats; with only CPU MHz on it stays hidden
    const cpuOnly = harness({ showCpuMhz: true });
    cpuOnly.app._updateHostSensors(stats);
    expect(cpuOnly.els.get('statCpuMhzItem')?.hidden).toBe(false);
    expect(cpuOnly.els.get('statGpuMhzItem')?.hidden).toBe(true);
    const gpuOnly = harness({ showGpuStats: true });
    gpuOnly.app._updateHostSensors(stats);
    expect(gpuOnly.els.get('statGpuMhzItem')?.hidden).toBe(false);
    expect(gpuOnly.els.get('statCpuMhzItem')?.hidden).toBe(true);

    const noHardware = harness({ showGpuStats: true, showCpuMhz: true });
    noHardware.app._updateHostSensors({});
    expect(noHardware.els.get('statGpuItem')?.hidden).toBe(true);
  });

  it('shows graphics memory in use even when its total is unknown, with no ring', () => {
    const { app, els } = harness({ showGpuStats: true });
    app._updateHostSensors({ gpu: { percent: 5, memUsedMB: 1536 } });
    expect(els.get('statVramItem')?.hidden).toBe(false);
    expect(els.get('statVram')?.textContent).toBe('1.5G');
    expect(els.get('statVramRing')?.style.display).toBe('none');
    // marked ringless, so the Compact style's rings-only step hides the item rather than leave an empty one
    expect(els.get('statVramItem')?.classList.set.has('stat-item--ringless')).toBe(true);
    app._updateHostSensors({ gpu: { percent: 5, memUsedMB: 1536, memTotalMB: 8192, memPercent: 19 } });
    expect(els.get('statVramRing')?.style.display).toBe('');
    expect(els.get('statVramItem')?.classList.set.has('stat-item--ringless')).toBe(false);
  });

  it('keeps polling the header stats with no session open, so CPU, MEM and the readings are never stuck at --', () => {
    const appJs = read('app.js');
    expect(appJs).toContain('if (!this.systemStatsInterval) this.startSystemStatsPolling();');
    expect(appJs).not.toMatch(/sessions\.size === 0\) this\.stopSystemStatsPolling\(\)/);
    expect(appJs).not.toMatch(/\} else \{\s*this\.stopSystemStatsPolling\(\);/);
  });

  it('runs one stats request at a time, so a slow answer cannot pile requests up behind it', async () => {
    const { app, fetched, release } = harness({}, { hold: true });
    const polls = [app.fetchSystemStats.call(app), app.fetchSystemStats.call(app), app.fetchSystemStats.call(app)];
    expect(fetched).toHaveLength(1);
    release();
    await Promise.all(polls);
    // answered: the next poll goes out again
    await app.fetchSystemStats.call(app);
    expect(fetched).toHaveLength(2);
  });

  it('is opt-in in the settings page: unchecked chips, off in every default, stripped from the settings PUT', () => {
    const html = read('index.html');
    for (const id of ['appSettingsShowGpuStats', 'appSettingsShowCpuMhz']) {
      expect(html).toMatch(new RegExp(`<input type="checkbox" id="${id}">`));
    }
    const settingsUi = read('settings-ui.js');
    expect(settingsUi).toContain('showGpuStats ?? defaults.showGpuStats ?? false');
    expect(settingsUi).toContain('showCpuMhz ?? defaults.showCpuMhz ?? false');
    // per-device, so stripped from the PUT body like the other header toggles (the schema is .strict())
    expect(settingsUi).toContain('showGpuStats: _sgp,');
    expect(settingsUi).toContain('showCpuMhz: _scm,');
    const schemas = readFileSync(join(process.cwd(), 'src/web/schemas.ts'), 'utf-8');
    expect(schemas).not.toContain('showCpuMhz');
    expect(schemas).not.toContain('showGpuStats');
  });
});
