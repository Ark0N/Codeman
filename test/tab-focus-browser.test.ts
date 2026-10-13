/**
 * @fileoverview The Focus flag in the browser's tab-layout mirror (tab-layout-browser.js).
 *
 * The browser writes WHOLE layouts back (`PUT /api/tab-layout`), so any field
 * its defensive copy drops is erased on the next save, whoever made it. These
 * tests pin that `focus: true` is carried like `placement`, that `setFocus` is a
 * named operation that replays (and drops cleanly) through the edit coordinator,
 * that a 409 rebase keeps both our flag and one set elsewhere, that the focused
 * refs are exposed for rendering (with or without named groups), and the
 * per-device collapse storage.
 *
 * Port: none (vm-loaded module).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(join(process.cwd(), 'src/web/public/tab-layout-browser.js'), 'utf8');

type Ref = { kind: 'session' | 'webview'; id: string; placement?: 'manual'; focus?: true };
type Layout = {
  version: number;
  updatedAt: string;
  groups: Array<{ id: string; name: string; refs: Ref[] }>;
  ungrouped: Ref[];
};

function loadHelper() {
  const context = vm.createContext({ window: {}, globalThis: {}, setTimeout, clearTimeout });
  vm.runInContext(SOURCE, context, { filename: 'tab-layout-browser.js' });
  return (context.window as any).CodemanTabLayout;
}

const s = (id: string, extra: Partial<Ref> = {}): Ref => ({ kind: 'session', id, ...extra });
const w = (id: string, extra: Partial<Ref> = {}): Ref => ({ kind: 'webview', id, ...extra });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const base = (version = 5): Layout => ({
  version,
  updatedAt: '2026-10-09T00:00:00.000Z',
  groups: [
    { id: 'g1', name: 'Core', refs: [s('a', { focus: true }), s('b')] },
    { id: 'g2', name: 'Ops', refs: [w('web', { focus: true })] },
  ],
  ungrouped: [s('c', { placement: 'manual', focus: true }), s('d')],
});
const focused = (layout: Layout) =>
  [...layout.groups.flatMap((g) => g.refs), ...layout.ungrouped]
    .filter((ref) => ref.focus === true)
    .map((ref) => `${ref.kind}:${ref.id}`);

describe('the defensive copy keeps focus', () => {
  const h = loadHelper();

  it('normalizeLayout keeps focus: true on session and web refs, next to placement', () => {
    const copy = plain(h.normalizeLayout(base()));
    expect(copy.groups[0].refs[0]).toEqual({ kind: 'session', id: 'a', focus: true });
    expect(copy.groups[1].refs[0]).toEqual({ kind: 'webview', id: 'web', focus: true });
    expect(copy.ungrouped[0]).toEqual({ kind: 'session', id: 'c', placement: 'manual', focus: true });
    expect(copy.ungrouped[1]).toEqual({ kind: 'session', id: 'd' });
  });

  it('drops anything but a literal true (the server only stores true)', () => {
    const copy = plain(
      h.normalizeLayout({
        ...base(),
        ungrouped: [s('c', { focus: 'yes' as never }), s('d', { focus: false as never })],
      })
    );
    expect(copy.ungrouped).toEqual([
      { kind: 'session', id: 'c' },
      { kind: 'session', id: 'd' },
    ]);
  });

  it('every existing operation keeps the flag on the refs it touches', () => {
    let layout = base();
    layout = h.applyOperation(layout, { type: 'renameGroup', groupId: 'g1', name: 'Front' });
    layout = h.applyOperation(layout, { type: 'reorderGroup', groupId: 'g2', index: 0 });
    layout = h.applyOperation(layout, { type: 'moveRef', ref: s('a'), groupId: 'g2', index: 1, parents: {} });
    expect(plain(layout).groups[0].refs).toEqual([w('web', { focus: true }), s('a', { focus: true })]);
    layout = h.applyOperation(layout, { type: 'deleteGroup', groupId: 'g2' });
    expect(focused(plain(layout))).toEqual(['session:c', 'webview:web', 'session:a']);
  });

  it('a moved lineage block keeps each member flag, and the head turns manual', () => {
    const layout: Layout = {
      ...base(),
      groups: [{ id: 'g1', name: 'Core', refs: [s('p', { focus: true }), s('kid', { focus: true })] }],
      ungrouped: [],
    };
    const moved = plain(
      h.applyOperation(layout, { type: 'moveRef', ref: s('p'), groupId: null, parents: { kid: 'p', p: 'gp' } })
    );
    expect(moved.ungrouped).toEqual([s('p', { focus: true, placement: 'manual' }), s('kid', { focus: true })]);
  });
});

describe('setFocus operation', () => {
  const h = loadHelper();

  it('adds and removes the flag on one ref and moves nothing', () => {
    const added = plain(h.applyOperation(base(), { type: 'setFocus', ref: s('d'), focused: true }));
    expect(focused(added)).toEqual(['session:a', 'webview:web', 'session:c', 'session:d']);
    const removed = plain(h.applyOperation(added, { type: 'setFocus', ref: s('c'), focused: false }));
    expect(removed.ungrouped[0]).toEqual({ kind: 'session', id: 'c', placement: 'manual' });
    expect(removed.groups.map((g: any) => g.refs.map((r: Ref) => r.id))).toEqual([['a', 'b'], ['web']]);
    expect(h.contentKey(h.applyOperation(added, { type: 'setFocus', ref: s('d'), focused: true }))).toBe(
      h.contentKey(added)
    );
  });

  it('refuses an unknown ref, a bad ref and a non-boolean state (so a replay drops it)', () => {
    expect(() => h.applyOperation(base(), { type: 'setFocus', ref: s('gone'), focused: true })).toThrow(/unknown row/);
    expect(() => h.applyOperation(base(), { type: 'setFocus', ref: { kind: 'x', id: 'a' }, focused: true })).toThrow();
    expect(() => h.applyOperation(base(), { type: 'setFocus', ref: s('a'), focused: 'yes' })).toThrow(/Focus/);
  });
});

describe('edit coordinator with focus', () => {
  const h = loadHelper();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  function controlledPut() {
    const calls: Array<{ request: any; resolve: (value: any) => void }> = [];
    const put = vi.fn((request: any) => new Promise((resolve) => calls.push({ request: plain(request), resolve })));
    return { put, calls };
  }
  function makeEditor(put: any, extra: Record<string, unknown> = {}) {
    const applied: any[] = [];
    const editor = h.createEditCoordinator({
      initialLayout: base(),
      put,
      applyLayout: (layout: any, meta: any) => applied.push({ layout: plain(layout), meta }),
      schedule: (fn: () => void) => setTimeout(fn, 0),
      cancel: (handle: any) => clearTimeout(handle),
      ...extra,
    });
    return { editor, applied };
  }

  it('sends setFocus in the whole-layout PUT, and an unrelated edit keeps every other flag', async () => {
    const { put, calls } = controlledPut();
    const { editor } = makeEditor(put);
    editor.enqueue({ type: 'setFocus', ref: s('b'), focused: true });
    editor.enqueue({ type: 'renameGroup', groupId: 'g2', name: 'Web' });
    await settle();
    expect(calls).toHaveLength(1);
    expect(focused(calls[0].request.layout)).toEqual(['session:a', 'session:b', 'webview:web', 'session:c']);
  });

  it('replays setFocus onto the 409 layout and keeps a flag set elsewhere', async () => {
    const { put, calls } = controlledPut();
    const { editor, applied } = makeEditor(put);
    editor.enqueue({ type: 'setFocus', ref: s('d'), focused: true });
    await settle();
    // Elsewhere: someone unpinned `a`, pinned `b` and renamed Core (version 9).
    const server: Layout = {
      ...base(9),
      groups: [
        { id: 'g1', name: 'Front', refs: [s('a'), s('b', { focus: true })] },
        { id: 'g2', name: 'Ops', refs: [w('web', { focus: true })] },
      ],
    };
    calls[0].resolve({ ok: false, status: 409, layout: server });
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].request.baseVersion).toBe(9);
    expect(calls[1].request.layout.groups[0].name).toBe('Front');
    expect(focused(calls[1].request.layout)).toEqual(['session:b', 'webview:web', 'session:c', 'session:d']);
    calls[1].resolve({ ok: true, status: 200, layout: { ...calls[1].request.layout, version: 10 } });
    await settle();
    expect(focused(applied.at(-1).layout)).toEqual(['session:b', 'webview:web', 'session:c', 'session:d']);
    expect(editor.hasPending()).toBe(false);
  });

  it('drops a setFocus whose ref vanished in the conflict, and reports it once', async () => {
    const { put, calls } = controlledPut();
    const reportError = vi.fn();
    const { editor, applied } = makeEditor(put, { reportError });
    editor.enqueue({ type: 'setFocus', ref: s('d'), focused: true });
    await settle();
    calls[0].resolve({
      ok: false,
      status: 409,
      layout: { ...base(9), ungrouped: [s('c', { placement: 'manual', focus: true })] },
    });
    await settle();
    expect(calls).toHaveLength(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(focused(applied.at(-1).layout)).toEqual(['session:a', 'webview:web', 'session:c']);
  });

  it('adopting an external layout keeps its flags under a pending setFocus', () => {
    const { editor } = makeEditor(() => new Promise(() => undefined), { schedule: () => 1, cancel: () => undefined });
    editor.enqueue({ type: 'setFocus', ref: s('d'), focused: true });
    const external = { ...base(7), ungrouped: [s('c', { placement: 'manual' }), s('d')] };
    expect(editor.adoptExternal(external)).toBe(true);
    expect(focused(plain(editor.getLayout()))).toEqual(['session:a', 'webview:web', 'session:d']);
  });
});

describe('focused refs for the rail', () => {
  const h = loadHelper();
  const options = { liveSessionIds: ['a', 'b', 'c', 'd'], openWebviewIds: ['web'] };

  it('focusRefs lists renderable focused refs in stored order, with or without groups', () => {
    expect(plain(h.focusRefs(base(), options))).toEqual([s('a'), w('web'), s('c')]);
    const flat = { ...base(), groups: [], ungrouped: [s('d', { focus: true }), s('c'), w('web', { focus: true })] };
    expect(plain(h.focusRefs(flat, options))).toEqual([s('d'), w('web')]);
    // The flat layout still projects to null: the rail itself stays the flat list.
    expect(h.project(flat, options)).toBeNull();
  });

  it('a gone session or a closed web tab drops out of Focus harmlessly', () => {
    expect(plain(h.focusRefs(base(), { liveSessionIds: ['b', 'c'], openWebviewIds: [] }))).toEqual([s('c')]);
    expect(plain(h.focusRefs(null, options))).toEqual([]);
    expect(
      plain(
        h.focusRefs({ ...base(), ungrouped: [s('c', { focus: true }), s('c', { focus: true })], groups: [] }, options)
      )
    ).toEqual([s('c')]);
  });

  it('project() exposes the same focusRefs on a grouped layout', () => {
    const projection = h.project(base(), options);
    expect(plain(projection.focusRefs)).toEqual([s('a'), w('web'), s('c')]);
    // Shortcuts are not rows: the grouped rows are exactly what they were.
    expect(plain(projection.visibleRefs)).toEqual([s('a'), s('b'), w('web'), s('c'), s('d')]);
  });
});

describe('Focus collapse is per-device storage', () => {
  const h = loadHelper();
  const memory = () => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
      setItem: (key: string, value: string) => void data.set(key, value),
    };
  };

  it('round-trips under its own key and never touches the group collapse list', () => {
    const storage = memory();
    expect(h.loadFocusCollapsed(storage)).toEqual({ collapsed: false, ok: true });
    expect(h.saveFocusCollapsed(storage, true)).toEqual({ collapsed: true, ok: true });
    expect(storage.data.get('codeman:tab-focus-collapsed')).toBe('true');
    expect(h.loadFocusCollapsed(storage)).toEqual({ collapsed: true, ok: true });
    expect(storage.data.has('codeman:tab-groups-collapsed')).toBe(false);
    // Group collapse GC (ids of groups that no longer exist) leaves it alone.
    h.loadCollapsedGroupIds(storage, []);
    expect(h.loadFocusCollapsed(storage).collapsed).toBe(true);
  });

  it('a junk value reads as expanded, and a throwing store reports failure', () => {
    const storage = memory();
    storage.setItem('codeman:tab-focus-collapsed', '{nope');
    expect(h.loadFocusCollapsed(storage)).toEqual({ collapsed: false, ok: true });
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(h.loadFocusCollapsed(broken)).toEqual({ collapsed: false, ok: false });
    expect(h.saveFocusCollapsed(broken, true)).toEqual({ collapsed: false, ok: false });
  });
});
