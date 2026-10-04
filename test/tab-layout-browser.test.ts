/**
 * @fileoverview Browser projection of the owner tab layout (tab-layout-browser.js).
 *
 * Pins the pure half of the grouped vertical rail: which live rows land in which
 * group, what a collapsed group hides (and the one row it must keep showing),
 * the per-device collapse storage, the grouped markup, and newest-wins loading.
 *
 * Port: none (vm-loaded module + static wiring assertions).
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(new URL('../src/web/public/tab-layout-browser.js', import.meta.url), 'utf8');
const APP_SOURCE = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const INDEX_SOURCE = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const BUILD_SOURCE = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');

type Ref = { kind: 'session' | 'webview'; id: string };

function loadHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(SOURCE, context, { filename: 'tab-layout-browser.js' });
  return (context.window as any).CodemanTabLayout;
}

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const layout = (version = 4) => ({
  version,
  updatedAt: '2026-08-16T00:00:00.000Z',
  groups: [
    {
      id: 'g1',
      name: '<Core & Ops>',
      refs: [
        { kind: 'session', id: 's2' },
        { kind: 'webview', id: 'w1' },
        { kind: 'session', id: 's1' },
        { kind: 'webview', id: 'saved-closed' },
        { kind: 'session', id: 'gone' },
      ],
    },
    { id: 'g2', name: 'Later', refs: [{ kind: 'session', id: 's3' }] },
  ],
  ungrouped: [
    { kind: 'webview', id: 'w2' },
    { kind: 'session', id: 's4' },
    { kind: 'session', id: 's2' },
  ],
});

const ids = (refs: Ref[]) => refs.map((ref) => `${ref.kind}:${ref.id}`);

describe('projection', () => {
  it('returns null for a layout without groups, so the caller keeps the flat rail', () => {
    const h = loadHelper();
    expect(h.project({ version: 1, groups: [], ungrouped: [{ kind: 'session', id: 's1' }] }, {})).toBeNull();
    expect(h.project(null, {})).toBeNull();
    expect(h.hasGroups(h.normalizeLayout({ version: 1 }))).toBe(false);
  });

  it('places stored refs in their groups, skips gone/unopened refs, and deduplicates', () => {
    const h = loadHelper();
    const result = h.project(layout(), {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
    });
    expect(result.sections.map((s: any) => [s.id, ids(s.refs), s.count])).toEqual([
      ['g1', ['session:s2', 'webview:w1', 'session:s1'], 3],
      ['g2', ['session:s3'], 1],
      [null, ['webview:w2', 'session:s4'], 2],
    ]);
    expect(new Set(ids(result.visibleRefs)).size).toBe(result.visibleRefs.length);
  });

  it('appends live sessions and open web tabs the layout has not placed, in caller order', () => {
    const h = loadHelper();
    const result = h.project(layout(), {
      liveSessionIds: ['new-b', 's1', 'new-a'],
      openWebviewIds: ['w-local'],
    });
    expect(ids(result.sections.at(-1).refs)).toEqual(['session:new-b', 'session:new-a', 'webview:w-local']);
  });

  it('omits an empty ungrouped section', () => {
    const h = loadHelper();
    const result = h.project(layout(), { liveSessionIds: ['s1', 's3'], openWebviewIds: [] });
    expect(result.sections.map((s: any) => s.id)).toEqual(['g1', 'g2']);
  });

  it('hides a collapsed group but keeps its highlighted row, and records where hidden rows went', () => {
    const h = loadHelper();
    const common = {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
      collapsedGroupIds: ['g1'],
    };
    const collapsed = h.project(layout(), { ...common, activeSessionId: 's1' });
    expect(ids(collapsed.sections[0].refs)).toEqual(['session:s1']);
    expect(collapsed.sections[0].count).toBe(3);
    expect(collapsed.sections[0].collapsed).toBe(true);
    expect(collapsed.hiddenTabGroupByRef).toEqual({ 'session:s2': 'g1', 'webview:w1': 'g1' });
    expect(ids(collapsed.sections[0].hidden)).toEqual(['session:s2', 'webview:w1']);
    // Every placed row knows its section, shown or hidden (null = Ungrouped).
    expect(collapsed.sectionByRef).toEqual({
      'session:s2': 'g1',
      'webview:w1': 'g1',
      'session:s1': 'g1',
      'session:s3': 'g2',
      'webview:w2': null,
      'session:s4': null,
    });

    // An active web tab owns the highlight even while a session stays selected.
    const web = h.project(layout(), { ...common, activeSessionId: 's1', activeWebviewId: 'w1' });
    expect(ids(web.sections[0].refs)).toEqual(['webview:w1']);
  });
});

describe('structure key', () => {
  it('changes with every structural input and ignores everything else', () => {
    const h = loadHelper();
    const opts = { liveSessionIds: ['s1', 's2', 's3'], openWebviewIds: [] };
    const base = h.structureKey(layout(), h.project(layout(), opts), []);
    expect(h.structureKey(layout(), h.project(layout(), opts), [])).toBe(base);
    expect(h.structureKey(layout(), h.project(layout(), { ...opts, collapsedGroupIds: ['g1'] }), ['g1'])).not.toBe(
      base
    );
    expect(h.structureKey(layout(), h.project(layout(), { ...opts, liveSessionIds: ['s1', 's2'] }), [])).not.toBe(base);
    const renamed = { ...layout(), groups: [{ ...layout().groups[0], name: 'Renamed' }, layout().groups[1]] };
    expect(h.structureKey(renamed, h.project(renamed, opts), [])).not.toBe(base);
    expect(h.structureKey(layout(), null, [])).toBeNull();
  });

  it('ignores a version bump that moves nothing, so a lifecycle broadcast costs no rebuild', () => {
    const h = loadHelper();
    const opts = { liveSessionIds: ['s1', 's2', 's3'], openWebviewIds: [] };
    expect(h.structureKey(layout(5), h.project(layout(5), opts), [])).toBe(
      h.structureKey(layout(4), h.project(layout(4), opts), [])
    );
  });

  it('changes when a collapse hides a different row, even with equal counts and shown rows', () => {
    const h = loadHelper();
    const two = (refs: Ref[][]) => ({
      version: 1,
      groups: [
        { id: 'a', name: 'A', refs: refs[0] },
        { id: 'b', name: 'B', refs: refs[1] },
      ],
      ungrouped: [],
    });
    const s = (id: string): Ref => ({ kind: 'session', id });
    const opts = { liveSessionIds: ['x', 'y'], openWebviewIds: [], collapsedGroupIds: ['a', 'b'] };
    const before = two([[s('x')], [s('y')]]);
    const after = two([[s('y')], [s('x')]]);
    // Lineage anchors a hidden row to its header, so who hides where is structure.
    expect(h.structureKey(after, h.project(after, opts), ['a', 'b'])).not.toBe(
      h.structureKey(before, h.project(before, opts), ['a', 'b'])
    );
  });
});

describe('collapsed header alerts', () => {
  it('reports the most urgent alert among the session rows a collapse hides', () => {
    const h = loadHelper();
    const alerts = new Map([
      ['s2', 'idle'],
      ['s1', 'action'],
      ['s3', 'idle'],
      ['s4', 'action'],
    ]);
    const alertOf = (id: string) => alerts.get(id);
    const common = { liveSessionIds: ['s1', 's2', 's3', 's4'], openWebviewIds: ['w1', 'w2'] };
    // s1 is the kept selection, so it draws its own ring: only s2 (idle) is behind g1.
    const kept = h.project(layout(), { ...common, collapsedGroupIds: ['g1', 'g2'], activeSessionId: 's1' });
    expect(h.hiddenGroupAlerts(kept, alertOf)).toEqual({ g1: 'idle', g2: 'idle' });
    // With s1 hidden too, the red one wins over the yellow one.
    const hidden = h.project(layout(), { ...common, collapsedGroupIds: ['g1'], activeSessionId: 's4' });
    expect(h.hiddenGroupAlerts(hidden, alertOf)).toEqual({ g1: 'action' });
    // Expanded groups and the ungrouped section never report (their rows are on screen).
    expect(h.hiddenGroupAlerts(h.project(layout(), common), alertOf)).toEqual({});
    expect(h.hiddenGroupAlerts(null, alertOf)).toEqual({});
  });
});

describe('per-device collapse storage', () => {
  function storage(initial: string | null = null) {
    const values = new Map<string, string>();
    if (initial !== null) values.set('codeman:tab-groups-collapsed', initial);
    return {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, next: string) => {
        values.set(key, next);
      }),
    };
  }

  it('round-trips collapsed group ids', () => {
    const h = loadHelper();
    const local = storage();
    expect(h.saveCollapsedGroupIds(local, ['g2', 'g1', 'g2'])).toEqual({ ids: ['g2', 'g1'], ok: true });
    expect(h.loadCollapsedGroupIds(local, ['g1', 'g2'])).toEqual({ ids: ['g2', 'g1'], ok: true });
  });

  it('garbage-collects ids of groups that no longer exist', () => {
    const h = loadHelper();
    const local = storage('["gone","g1"]');
    expect(h.loadCollapsedGroupIds(local, ['g1', 'g2'])).toEqual({ ids: ['g1'], ok: true });
    expect(local.setItem).toHaveBeenLastCalledWith('codeman:tab-groups-collapsed', '["g1"]');
  });

  it('reports failure (all-expanded) on unreadable or unwritable storage', () => {
    const h = loadHelper();
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(h.loadCollapsedGroupIds(throwing, ['g1'])).toEqual({ ids: [], ok: false });
    expect(h.saveCollapsedGroupIds(throwing, ['g1'])).toEqual({ ids: [], ok: false });
  });

  it('reads a malformed stored value as nothing collapsed and repairs it, so collapse keeps working', () => {
    const h = loadHelper();
    for (const bad of ['{"g1":true}', 'not json', '"g1"', 'null']) {
      const local = storage(bad);
      expect(h.loadCollapsedGroupIds(local, ['g1']), bad).toEqual({ ids: [], ok: true });
      expect(local.setItem, bad).toHaveBeenLastCalledWith('codeman:tab-groups-collapsed', '[]');
      expect(h.saveCollapsedGroupIds(local, ['g1']), bad).toEqual({ ids: ['g1'], ok: true });
      expect(h.loadCollapsedGroupIds(local, ['g1']), bad).toEqual({ ids: ['g1'], ok: true });
    }
    // Without a group list to validate against, nothing is written.
    const untouched = storage('{"g1":true}');
    expect(h.loadCollapsedGroupIds(untouched)).toEqual({ ids: [], ok: true });
    expect(untouched.setItem).not.toHaveBeenCalled();
  });
});

describe('grouped markup', () => {
  it('renders escaped group sections as a tree skeleton around caller-rendered rows', () => {
    const h = loadHelper();
    const projection = h.project(layout(), {
      liveSessionIds: ['s1', 's2', 's3', 's4'],
      openWebviewIds: ['w1', 'w2'],
      collapsedGroupIds: ['g2'],
    });
    const html = h.renderProjection(
      projection,
      (ref: Ref) => `<div class="row" data-ref="${ref.kind}:${ref.id}"></div>`,
      escape
    );
    const doc = new JSDOM(`<main>${html}</main>`).window.document;
    expect([...doc.querySelectorAll('.tab-layout-group-name')].map((el) => el.textContent)).toEqual([
      '<Core & Ops>',
      'Later',
      'Ungrouped',
    ]);
    expect(doc.querySelectorAll('.tab-layout-group-name *')).toHaveLength(0);
    expect(doc.querySelector('.tab-layout-group-name')?.hasAttribute('data-i18n-skip')).toBe(true);
    // Sections are layout only; the caller's container is the tree.
    expect([...doc.querySelectorAll('section')].every((el) => el.getAttribute('role') === 'presentation')).toBe(true);

    // A named header is a level-1 treeitem that toggles and OWNS its rows' group.
    const g1 = doc.querySelector<HTMLElement>('[data-tab-group-header="g1"]')!;
    expect(g1.getAttribute('role')).toBe('treeitem');
    expect(g1.getAttribute('tabindex')).toBe('-1');
    expect(g1.getAttribute('aria-expanded')).toBe('true');
    expect(g1.getAttribute('onclick')).toBe('app.toggleTabGroupCollapsed(this.dataset.tabGroupHeader)');
    const owned = doc.getElementById(g1.getAttribute('aria-owns')!)!;
    expect(owned.getAttribute('role')).toBe('group');
    expect(doc.getElementById(owned.getAttribute('aria-labelledby')!)?.textContent).toBe('<Core & Ops>');
    expect(owned.querySelectorAll('.row')).toHaveLength(3);
    // No interactive element nested inside a treeitem.
    expect(g1.querySelectorAll('button, [tabindex]')).toHaveLength(0);

    // A collapsed header owns nothing, so its kept row cannot read as the child of a closed node.
    const g2 = doc.querySelector<HTMLElement>('[data-tab-group-header="g2"]')!;
    expect(g2.getAttribute('aria-expanded')).toBe('false');
    expect(g2.hasAttribute('aria-owns')).toBe(false);
    expect(g2.closest('section')!.querySelector('.tab-layout-group-refs')!.getAttribute('role')).toBe('presentation');

    // The ungrouped heading is a visual divider: nothing to collapse, nothing to announce.
    const ungrouped = doc.querySelector('.tab-layout-ungrouped-header')!;
    expect(ungrouped.getAttribute('aria-hidden')).toBe('true');
    expect(ungrouped.hasAttribute('role')).toBe(false);
    expect(ungrouped.closest('section')!.querySelector('.tab-layout-group-refs')!.getAttribute('role')).toBe(
      'presentation'
    );
    expect([...doc.querySelectorAll<HTMLElement>('.row')].map((el) => el.dataset.ref)).toEqual(
      ids(projection.visibleRefs)
    );
  });
});

describe('empty groups', () => {
  it('renders a group with no open rows as a tree leaf, expanded or collapsed', () => {
    const h = loadHelper();
    for (const collapsedGroupIds of [[], ['g2']]) {
      const projection = h.project(layout(), { liveSessionIds: ['s1', 's2'], openWebviewIds: [], collapsedGroupIds });
      expect(projection.sections[1]).toMatchObject({ id: 'g2', count: 0, refs: [] });
      const html = h.renderProjection(projection, () => '', escape);
      const doc = new JSDOM(`<main>${html}</main>`).window.document;
      const header = doc.querySelector('[data-tab-group-header="g2"]')!;
      expect(header.getAttribute('role')).toBe('treeitem');
      expect(header.hasAttribute('aria-expanded')).toBe(false);
      expect(header.hasAttribute('aria-owns')).toBe(false);
      expect(header.closest('section')!.querySelector('.tab-layout-group-refs')!.getAttribute('role')).toBe(
        'presentation'
      );
      // The populated group is unaffected.
      expect(doc.querySelector('[data-tab-group-header="g1"]')!.getAttribute('aria-expanded')).toBe('true');
    }
  });
});

describe('load coordination', () => {
  it('applies only the newest response when loads overlap', async () => {
    const h = loadHelper();
    const pending: Array<(value: unknown) => void> = [];
    const applied: number[] = [];
    const coordinator = h.createLoadCoordinator({
      fetchLayout: () => new Promise((resolve) => pending.push(resolve)),
      applyLayout: (value: any) => applied.push(value.version),
      applyFallback: vi.fn(),
      scheduleRetry: vi.fn(),
    });
    const first = coordinator.load();
    const second = coordinator.load();
    pending[1](layout(2));
    await second;
    pending[0](layout(1));
    await first;
    expect(applied).toEqual([2]);
  });

  it('falls back on failure, schedules one retry, and lets a successful retry replace the fallback', async () => {
    const h = loadHelper();
    const applyLayout = vi.fn();
    const applyFallback = vi.fn();
    let retry: (() => Promise<boolean>) | undefined;
    let attempt = 0;
    const coordinator = h.createLoadCoordinator({
      fetchLayout: async () => {
        attempt++;
        if (attempt === 1) throw new Error('offline');
        return layout(7);
      },
      applyLayout,
      applyFallback,
      scheduleRetry: (fn: () => Promise<boolean>) => {
        retry = fn;
        return 42;
      },
      cancelRetry: vi.fn(),
    });
    await coordinator.load();
    expect(applyFallback).toHaveBeenCalledTimes(1);
    expect(applyLayout).not.toHaveBeenCalled();
    await retry!();
    expect(applyLayout).toHaveBeenCalledWith(layout(7));
  });

  it('backs off failed retries, stops after the cap, and starts over after a success', async () => {
    const h = loadHelper();
    const delays: number[] = [];
    let pending: (() => Promise<boolean>) | null = null;
    let failing = true;
    const applyFallback = vi.fn();
    const coordinator = h.createLoadCoordinator({
      fetchLayout: async () => {
        if (failing) throw new Error('offline');
        return layout(1);
      },
      applyLayout: vi.fn(),
      applyFallback,
      retryDelayMs: 5000,
      maxRetryDelayMs: 30000,
      maxRetries: 4,
      scheduleRetry: (fn: () => Promise<boolean>, delay: number) => {
        delays.push(delay);
        pending = fn;
        return delays.length;
      },
      cancelRetry: vi.fn(),
    });
    await coordinator.load();
    // Bounded drain: an uncapped retry must fail here, not spin forever (the
    // loop only awaits microtasks, so vitest's own timeout could never fire).
    for (let drained = 0; pending && drained < 10; drained++) {
      const next: () => Promise<boolean> = pending;
      pending = null;
      await next();
    }
    // Four retries (5 s doubling, capped at 30 s), then nothing more is scheduled.
    expect(delays).toEqual([5000, 10000, 20000, 30000]);
    expect(applyFallback).toHaveBeenCalledTimes(5);

    // An outside load (SSE init, tab:layoutChanged) still tries, and a success
    // resets the count, so the next outage gets the full schedule again.
    failing = false;
    expect(await coordinator.load()).toBe(true);
    failing = true;
    await coordinator.load();
    expect(delays.at(-1)).toBe(5000);
    coordinator.dispose();
  });

  it('cancels a pending retry and ignores in-flight results after dispose', async () => {
    const h = loadHelper();
    let resolve!: (value: unknown) => void;
    const applyLayout = vi.fn();
    const cancelRetry = vi.fn();
    let calls = 0;
    const coordinator = h.createLoadCoordinator({
      fetchLayout: () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('offline'));
        return new Promise((r) => (resolve = r));
      },
      applyLayout,
      applyFallback: vi.fn(),
      scheduleRetry: () => 7,
      cancelRetry,
    });
    await coordinator.load();
    const second = coordinator.load();
    expect(cancelRetry).toHaveBeenCalledWith(7);
    coordinator.dispose();
    resolve(layout(3));
    await second;
    expect(applyLayout).not.toHaveBeenCalled();
  });
});

describe('browser wiring', () => {
  it('loads the helper before app.js, ships it through the build, and wires GET + SSE', () => {
    expect(INDEX_SOURCE.indexOf('<script defer src="tab-layout-browser.js"')).toBeGreaterThan(-1);
    expect(INDEX_SOURCE.indexOf('<script defer src="tab-layout-browser.js"')).toBeLessThan(
      INDEX_SOURCE.indexOf('<script defer src="app.js"')
    );
    expect(BUILD_SOURCE).toContain("'tab-layout-browser.js'");
    expect(APP_SOURCE).toContain("this._apiJson('/api/tab-layout')");
    expect(APP_SOURCE).toContain("[SSE_EVENTS.TAB_LAYOUT_CHANGED, '_onTabLayoutChanged']");
  });

  it('never writes the layout from the browser in this slice', () => {
    expect(APP_SOURCE).not.toMatch(/['"`]PUT['"`][^\n]*tab-layout|tab-layout[^\n]*['"`]PUT['"`]/);
    expect(SOURCE).not.toContain('fetch(');
  });
});
