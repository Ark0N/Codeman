/**
 * @fileoverview Editing the grouped vertical rail from the browser.
 *
 * Two halves:
 *  - the pure operation mirror + edit coordinator in tab-layout-browser.js
 *    (vm-loaded): each named operation, the PUT payload and version, ONE write
 *    in flight at a time, a 409 rebased onto the server's layout, and the
 *    drag-drop -> operation mapping;
 *  - the app.js wiring driven through the shipping CodemanApp inside JSDOM:
 *    row and group menus, inline group rename, menu dismissal, SSE deferral
 *    while a write is in flight, recovery of unsaved edits across a reload, and
 *    the flat rail staying byte-identical when no group exists.
 *
 * Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

type Ref = { kind: 'session' | 'webview'; id: string; placement?: 'manual' };
type Layout = {
  version: number;
  updatedAt: string;
  groups: Array<{ id: string; name: string; refs: Ref[] }>;
  ungrouped: Ref[];
};

function loadHelper() {
  const context = vm.createContext({ window: {}, globalThis: {}, setTimeout, clearTimeout });
  vm.runInContext(read('tab-layout-browser.js'), context, { filename: 'tab-layout-browser.js' });
  return (context.window as any).CodemanTabLayout;
}

const s = (id: string): Ref => ({ kind: 'session', id });
const w = (id: string): Ref => ({ kind: 'webview', id });
const base = (version = 5): Layout => ({
  version,
  updatedAt: '2026-10-01T00:00:00.000Z',
  groups: [
    { id: 'g1', name: 'Core', refs: [s('a'), s('b')] },
    { id: 'g2', name: 'Ops', refs: [w('web')] },
  ],
  ungrouped: [s('c'), s('d')],
});
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const keys = (refs: Ref[]) => refs.map((ref) => `${ref.kind}:${ref.id}`);

describe('operations', () => {
  const h = loadHelper();

  it('creates, renames, reorders and deletes groups without mutating the input', () => {
    const input = base();
    let next = h.applyOperation(input, { type: 'createGroup', id: 'g3', name: '  New  ', index: 1 });
    expect(next.groups.map((g: any) => [g.id, g.name])).toEqual([
      ['g1', 'Core'],
      ['g3', 'New'],
      ['g2', 'Ops'],
    ]);
    // Replaying a create (recovery after reload) is a no-op, not a duplicate.
    expect(plain(h.applyOperation(next, { type: 'createGroup', id: 'g3', name: 'New' }))).toEqual(plain(next));
    next = h.applyOperation(next, { type: 'renameGroup', groupId: 'g3', name: 'Renamed' });
    expect(next.groups[1].name).toBe('Renamed');
    next = h.applyOperation(next, { type: 'reorderGroup', groupId: 'g1', index: 2 });
    expect(next.groups.map((g: any) => g.id)).toEqual(['g3', 'g2', 'g1']);
    next = h.applyOperation(next, { type: 'deleteGroup', groupId: 'g1' });
    expect(next.groups.map((g: any) => g.id)).toEqual(['g3', 'g2']);
    // Its rows return to Ungrouped, in order, after what was already there.
    expect(keys(next.ungrouped)).toEqual(['session:c', 'session:d', 'session:a', 'session:b']);
    expect(plain(input)).toEqual(plain(base()));
  });

  it('rejects an operation the server would refuse, before any PUT', () => {
    expect(() => h.applyOperation(base(), { type: 'createGroup', id: 'x', name: '   ' })).toThrow();
    expect(() => h.applyOperation(base(), { type: 'createGroup', id: 'x', name: 'n'.repeat(61) })).toThrow();
    expect(() => h.applyOperation(base(), { type: 'renameGroup', groupId: 'nope', name: 'x' })).toThrow();
    expect(() => h.applyOperation(base(), { type: 'moveRef', ref: s('zz'), groupId: null, index: 0 })).toThrow();
    expect(() => h.applyOperation(base(), { type: 'moveRef', ref: s('a'), groupId: 'nope', index: 0 })).toThrow();
    const full = { ...base(), groups: Array.from({ length: 32 }, (_, i) => ({ id: `g${i}`, name: 'x', refs: [] })) };
    expect(() => h.applyOperation(full, { type: 'createGroup', id: 'one-more', name: 'x' })).toThrow(/limit/);
  });

  it('moves a row with the sessions that follow it, and marks a hand-moved child manual', () => {
    const layout = { ...base(), ungrouped: [s('c'), s('child'), s('d')] };
    const parents = { child: 'c' };
    const moved = h.applyOperation(layout, { type: 'moveRef', ref: s('c'), groupId: 'g1', index: 1, parents });
    expect(keys(moved.groups[0].refs)).toEqual(['session:a', 'session:c', 'session:child', 'session:b']);
    expect(keys(moved.ungrouped)).toEqual(['session:d']);
    const child = h.applyOperation(layout, { type: 'moveRef', ref: s('child'), groupId: 'g2', index: 0, parents });
    expect(child.groups[1].refs[0]).toEqual({ kind: 'session', id: 'child', placement: 'manual' });
    // ...and manual placement survives normalization (it is written back whole).
    expect(h.normalizeLayout(child).groups[1].refs[0].placement).toBe('manual');
  });
});

describe('child sessions: follow and hand placement', () => {
  const h = loadHelper();
  const lineage = (): Layout => ({
    version: 5,
    updatedAt: '',
    groups: [
      { id: 'g1', name: 'Core', refs: [s('p'), s('kid'), s('x')] },
      { id: 'g2', name: 'Ops', refs: [{ kind: 'session', id: 'moved', placement: 'manual' }, s('moved-kid')] },
    ],
    ungrouped: [s('u'), { kind: 'session', id: 'orphan', placement: 'manual' }],
  });
  const parents = { kid: 'p', moved: 'p', 'moved-kid': 'moved', orphan: 'gone' };

  it('describes each child: following, placed by hand, or with no parent to follow', () => {
    const state = (id: string, extra = {}) => plain(h.placementState(lineage(), s(id), { ...parents, ...extra }));
    expect(state('kid')).toEqual({ state: 'inherited', parentId: 'p', canFollow: false });
    expect(state('moved')).toEqual({ state: 'manual', parentId: 'p', canFollow: true });
    expect(state('orphan')).toEqual({ state: 'dangling', parentId: 'gone', canFollow: false });
    expect(state('p')).toBeNull();
    expect(state('x', { x: 'u', u: 'x' })).toMatchObject({ state: 'cycle', canFollow: false });
  });

  it('Follow parent again clears the hand placement and puts the child (and its followers) after its parent', () => {
    const next = h.applyOperation(lineage(), { type: 'followParent', ref: s('moved'), parents });
    expect(keys(next.groups[0].refs)).toEqual([
      'session:p',
      'session:kid',
      'session:moved',
      'session:moved-kid',
      'session:x',
    ]);
    expect(next.groups[0].refs.find((ref: Ref) => ref.id === 'moved').placement).toBeUndefined();
    expect(next.groups[1].refs).toEqual([]);
  });

  it('refuses to follow a parent that is gone or loops, and leaves a following child as it is', () => {
    expect(() => h.applyOperation(lineage(), { type: 'followParent', ref: s('orphan'), parents })).toThrow();
    expect(() =>
      h.applyOperation(lineage(), { type: 'followParent', ref: s('x'), parents: { x: 'u', u: 'x' } })
    ).toThrow();
    expect(plain(h.applyOperation(lineage(), { type: 'followParent', ref: s('kid'), parents }))).toEqual(
      plain(h.normalizeLayout(lineage()))
    );
  });
});

describe('drop -> operation', () => {
  const h = loadHelper();

  it('maps a row dropped before/after a row, onto a header, and onto Ungrouped', () => {
    expect(
      h.dropOperation(
        base(),
        { type: 'ref', ref: s('c') },
        { type: 'ref', ref: s('b'), groupId: 'g1', placement: 'before' },
        {}
      )
    ).toEqual({
      type: 'moveRef',
      ref: s('c'),
      groupId: 'g1',
      index: 1,
      parents: {},
    });
    expect(
      h.dropOperation(
        base(),
        { type: 'ref', ref: s('c') },
        { type: 'ref', ref: s('b'), groupId: 'g1', placement: 'after' },
        {}
      ).index
    ).toBe(2);
    // Within the same container the index counts AFTER the moved row is taken out.
    expect(
      h.dropOperation(
        base(),
        { type: 'ref', ref: s('a') },
        { type: 'ref', ref: s('b'), groupId: 'g1', placement: 'after' },
        {}
      )
    ).toMatchObject({
      groupId: 'g1',
      index: 1,
    });
    expect(h.dropOperation(base(), { type: 'ref', ref: w('web') }, { type: 'group', groupId: 'g1' }, {})).toMatchObject(
      {
        ref: w('web'),
        groupId: 'g1',
        index: 2,
      }
    );
    expect(h.dropOperation(base(), { type: 'ref', ref: s('a') }, { type: 'ungrouped' }, {})).toMatchObject({
      groupId: null,
      index: 2,
    });
  });

  it('maps a group dropped on another group (or a row in it) to a reorder', () => {
    expect(h.dropOperation(base(), { type: 'group', groupId: 'g2' }, { type: 'group', groupId: 'g1' }, {})).toEqual({
      type: 'reorderGroup',
      groupId: 'g2',
      index: 0,
    });
    expect(
      h.dropOperation(
        base(),
        { type: 'group', groupId: 'g1' },
        { type: 'ref', ref: w('web'), groupId: 'g2', placement: 'before' },
        {}
      )
    ).toEqual({
      type: 'reorderGroup',
      groupId: 'g1',
      index: 1,
    });
    expect(h.dropOperation(base(), { type: 'group', groupId: 'g1' }, { type: 'ungrouped' }, {})).toMatchObject({
      index: 1,
    });
  });

  it('returns null for a drop that changes nothing', () => {
    expect(
      h.dropOperation(
        base(),
        { type: 'ref', ref: s('a') },
        { type: 'ref', ref: s('a'), groupId: 'g1', placement: 'after' },
        {}
      )
    ).toBeNull();
    expect(
      h.dropOperation(
        base(),
        { type: 'ref', ref: s('a') },
        { type: 'ref', ref: s('b'), groupId: 'g1', placement: 'before' },
        {}
      )
    ).toBeNull();
    expect(h.dropOperation(base(), { type: 'ref', ref: s('a') }, { type: 'group', groupId: 'g1' }, {})).toBeNull();
    expect(h.dropOperation(base(), { type: 'ref', ref: s('c') }, { type: 'ungrouped' }, {})).toBeNull();
    expect(h.dropOperation(base(), { type: 'group', groupId: 'g1' }, { type: 'group', groupId: 'g1' }, {})).toBeNull();
    // Onto its own following child: the child moves with it, so there is no slot.
    const layout = { ...base(), ungrouped: [s('c'), s('child')] };
    expect(
      h.dropOperation(
        layout,
        { type: 'ref', ref: s('c') },
        { type: 'ref', ref: s('child'), groupId: null, placement: 'after' },
        { child: 'c' }
      )
    ).toBeNull();
  });
});

describe('edit coordinator', () => {
  const h = loadHelper();

  /** A put() whose responses the test resolves by hand, in order. */
  function controlledPut() {
    const calls: Array<{ request: any; resolve: (value: any) => void }> = [];
    const put = vi.fn(
      (request: any) =>
        new Promise((resolve) => {
          calls.push({ request: plain(request), resolve });
        })
    );
    return { put, calls };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  it('applies at once and PUTs exactly { baseVersion, layout } with the held version', async () => {
    const { put, calls } = controlledPut();
    const { editor, applied } = makeEditor(put);
    editor.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Front' });
    expect(applied.at(-1).layout.groups[0].name).toBe('Front');
    expect(applied.at(-1).meta).toEqual({ optimistic: true });
    await settle();
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].request).sort()).toEqual(['baseVersion', 'layout']);
    expect(calls[0].request.baseVersion).toBe(5);
    expect(calls[0].request.layout.groups[0].name).toBe('Front');
    calls[0].resolve({
      ok: true,
      status: 200,
      layout: { ...base(6), groups: [{ ...base().groups[0], name: 'Front' }, base().groups[1]] },
    });
    await settle();
    expect(editor.hasPending()).toBe(false);
    expect(editor.baseVersion()).toBe(6);
  });

  it('batches edits made in one turn into a single PUT', async () => {
    const { put, calls } = controlledPut();
    const { editor } = makeEditor(put);
    editor.enqueue({ type: 'createGroup', id: 'g3', name: 'Three' });
    editor.enqueue({ type: 'moveRef', ref: s('c'), groupId: 'g3', index: 0 });
    await settle();
    expect(calls).toHaveLength(1);
    expect(keys(calls[0].request.layout.groups[2].refs)).toEqual(['session:c']);
  });

  it('keeps ONE write in flight and sends later edits on the version it returns', async () => {
    const { put, calls } = controlledPut();
    const { editor } = makeEditor(put);
    editor.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'First' });
    await settle();
    editor.enqueue({ type: 'renameGroup', groupId: 'g2', name: 'Second' });
    await settle();
    await settle();
    // The second edit waits: no concurrent PUT racing the first.
    expect(calls).toHaveLength(1);
    const confirmed = plain(calls[0].request.layout);
    calls[0].resolve({ ok: true, status: 200, layout: { ...confirmed, version: 6 } });
    await settle();
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].request.baseVersion).toBe(6);
    expect(calls[1].request.layout.groups.map((g: any) => g.name)).toEqual(['First', 'Second']);
    calls[1].resolve({ ok: true, status: 200, layout: { ...plain(calls[1].request.layout), version: 7 } });
    await settle();
    expect(editor.hasPending()).toBe(false);
  });

  it('rebases a 409 onto the server layout, keeping the concurrent edit, and retries once', async () => {
    const { put, calls } = controlledPut();
    const { editor, applied } = makeEditor(put);
    editor.enqueue({ type: 'moveRef', ref: s('c'), groupId: 'g1', index: 2 });
    await settle();
    expect(calls[0].request.baseVersion).toBe(5);
    // Elsewhere, someone created a group and renamed Ops (version 9).
    const server: Layout = {
      ...base(9),
      groups: [
        ...base().groups.map((g) => (g.id === 'g2' ? { ...g, name: 'Ops!' } : g)),
        { id: 'gx', name: 'Theirs', refs: [] },
      ],
    };
    calls[0].resolve({ ok: false, status: 409, layout: server });
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].request.baseVersion).toBe(9);
    const retried = calls[1].request.layout;
    expect(retried.groups.map((g: any) => g.name)).toEqual(['Core', 'Ops!', 'Theirs']);
    expect(keys(retried.groups[0].refs)).toEqual(['session:a', 'session:b', 'session:c']);
    calls[1].resolve({ ok: true, status: 200, layout: { ...retried, version: 10 } });
    await settle();
    expect(applied.at(-1).meta).toEqual({ authoritative: true });
    expect(applied.at(-1).layout.version).toBe(10);
    expect(editor.hasPending()).toBe(false);
  });

  it('drops (and reports) an edit the conflicting layout no longer supports', async () => {
    const { put, calls } = controlledPut();
    const reportError = vi.fn();
    const { editor, applied } = makeEditor(put, { reportError });
    editor.enqueue({ type: 'renameGroup', groupId: 'g2', name: 'Mine' });
    await settle();
    const server: Layout = { ...base(9), groups: [base().groups[0]], ungrouped: [...base().ungrouped, w('web')] };
    calls[0].resolve({ ok: false, status: 409, layout: server });
    await settle();
    expect(calls).toHaveLength(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(applied.at(-1).layout.groups.map((g: any) => g.id)).toEqual(['g1']);
    expect(editor.hasPending()).toBe(false);
  });

  it('gives up after bounded conflicts and asks the caller to re-read', async () => {
    const { put, calls } = controlledPut();
    const onFailure = vi.fn();
    const reportError = vi.fn();
    const { editor } = makeEditor(put, { onFailure, reportError, maxAttempts: 2 });
    editor.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Mine' });
    await settle();
    calls[0].resolve({ ok: false, status: 409, layout: base(7) });
    await settle();
    calls[1].resolve({ ok: false, status: 409, layout: base(8) });
    await settle();
    expect(calls).toHaveLength(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(editor.getLayout().groups[0].name).toBe('Core');
  });

  it('re-reads and rebases on a 400, and reports a network failure', async () => {
    const { put, calls } = controlledPut();
    const fetchLayout = vi.fn(async () => base(11));
    const onFailure = vi.fn();
    const { editor } = makeEditor(put, { fetchLayout, onFailure, reportError: vi.fn() });
    editor.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Mine' });
    await settle();
    calls[0].resolve({ ok: false, status: 400, layout: null });
    await settle();
    await settle();
    expect(fetchLayout).toHaveBeenCalledTimes(1);
    expect(calls[1].request.baseVersion).toBe(11);
    calls[1].resolve({ ok: false, status: 0, layout: null });
    await settle();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('refuses an external layout while writing, rebases pending edits onto one otherwise', async () => {
    const { put, calls } = controlledPut();
    const { editor, applied } = makeEditor(put);
    editor.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Mine' });
    await settle();
    expect(editor.adoptExternal(base(20))).toBe(false);
    calls[0].resolve({ ok: true, status: 200, layout: { ...plain(calls[0].request.layout), version: 6 } });
    await settle();
    expect(editor.adoptExternal(base(4))).toBe(false); // older than what we hold
    const external = { ...base(21), groups: [...base().groups, { id: 'gx', name: 'X', refs: [] }] };
    expect(editor.adoptExternal(external)).toBe(true);
    expect(applied.at(-1).layout.groups.map((g: any) => g.id)).toEqual(['g1', 'g2', 'gx']);
  });

  it('restores recovered edits only when they still change something', async () => {
    const { put, calls } = controlledPut();
    const { editor } = makeEditor(put);
    expect(editor.restore([{ type: 'renameGroup', groupId: 'g1', name: 'Core' }])).toBe(false);
    expect(editor.restore([{ type: 'renameGroup', groupId: 'gone', name: 'x' }])).toBe(false);
    expect(editor.restore([{ type: 'renameGroup', groupId: 'g1', name: 'Again' }])).toBe(true);
    await settle();
    expect(calls).toHaveLength(1);
    expect(editor.pendingOperations()).toEqual([{ type: 'renameGroup', groupId: 'g1', name: 'Again' }]);
  });
});

// ─── app.js wiring ─────────────────────────────────────────────────────

let CodemanApp: { prototype: Record<string, any> };
let win: any;
let document: Document;

beforeAll(async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localhost/',
    runScripts: 'outside-only',
  });
  if (dom.window.document.readyState !== 'complete') {
    await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  }
  win = dom.window;
  document = win.document;
  win.setInterval = () => 0;
  win.requestAnimationFrame = () => 0;
  win.CSS = { escape: (value: string) => value };
  win.eval(
    'var MobileDetection = { isTouchDevice: () => false, getDeviceType: () => "desktop" }, KeyboardHandler = {}, ' +
      'SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
      read('constants.js') +
      '\n' +
      read('tab-layout-browser.js') +
      '\n' +
      read('app.js') +
      '\n' +
      read('tab-rail-resize.js') +
      '\n' +
      read('api-client.js') +
      '\n' +
      read('webview-tabs.js') +
      '\n;window.__EditCodemanApp = CodemanApp;'
  );
  CodemanApp = win.__EditCodemanApp;
});

const serverLayout = (version = 8): Layout => ({
  version,
  updatedAt: '2026-10-01T00:00:00.000Z',
  groups: [
    { id: 'gx', name: '<Core & Ops>', refs: [s('s2'), w('w1')] },
    { id: 'gy', name: 'Later', refs: [] },
  ],
  ungrouped: [s('s1'), s('s3')],
});

/** fetch stub: records PUT bodies, answers each with the next queued response. */
function installFetch(responses: Array<(body: any) => { status: number; body: unknown }> = []) {
  const puts: any[] = [];
  win.fetch = vi.fn(async (_url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (init?.method === 'PUT') puts.push(body);
    const next =
      responses.shift() ||
      ((b: any) => ({
        status: 200,
        body: { success: true, data: { layout: { ...b.layout, version: b.baseVersion + 1 } } },
      }));
    const { status, body: payload } = next(body);
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  });
  return puts;
}

function makeApp(layout: unknown = serverLayout()) {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  document.documentElement.setAttribute('data-tab-orientation', 'vertical');
  document.documentElement.dataset.tabRailSort = 'manual';
  document.body.innerHTML = '<div id="sessionTabs" role="tablist" aria-label="Session tabs"></div>';
  app.$ = (id: string) => document.getElementById(id);
  app.sessions = new Map([
    ['s1', { id: 's1', name: 'One', status: 'idle' }],
    ['s2', { id: 's2', name: 'Two', status: 'busy' }],
    ['s3', { id: 's3', name: 'Three', status: 'idle' }],
  ]);
  app.sessionOrder = ['s1', 's2', 's3'];
  app.webviews = new Map([['w1', { id: 'w1', name: 'Dashboard', url: 'https://example.test' }]]);
  app.webviewOrder = ['w1'];
  app.activeSessionId = 's2';
  app.activeWebviewId = null;
  app.tabLayout = null;
  app.collapsedTabGroupIds = new Set();
  app._hiddenTabGroupByRef = new Map();
  app._lastTabGroupStructureKey = null;
  app._tabCollapseStorageFailed = false;
  app._inlineRenameActive = false;
  app.tabAlerts = new Map();
  app.terminalLoadStates = new Map();
  app.minimizedSubagents = new Map();
  app.hasTabDetachOverride = () => false;
  app.renderSubagentTabBadge = () => '';
  app.cancelHideSubagentDropdown = () => {};
  app.updateTabOverflowMode = () => {};
  app.updateConnectionLines = () => {};
  app._applyTabEntrances = () => {};
  app._scrollActiveTabIntoView = () => {};
  app.applySidebarFilter = () => {};
  app.isSessionSidebarActive = () => false;
  app._startSidebarRichClock = () => {};
  app._stopSidebarRichClock = () => {};
  app.loadAppSettingsFromStorage = () => ({});
  app.openSessionOptions = vi.fn();
  app.requestCloseSession = vi.fn();
  app.selectSession = vi.fn();
  app.showWebviewModal = vi.fn();
  app.showToast = vi.fn();
  app.closeAllPanels = vi.fn();
  if (layout) app._applyTabLayout(layout);
  return app;
}

const tabs = () => document.getElementById('sessionTabs')!;
const header = (id: string) => document.querySelector<HTMLElement>(`[data-tab-group-header="${id}"]`)!;
const row = (id: string) => document.querySelector<HTMLElement>(`.session-tab[data-id="${id}"]`)!;
const menuLabels = () => [...document.querySelectorAll('.tab-rail-action-menu button')].map((b) => b.textContent);
const clickMenu = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.tab-rail-action-menu button')]
    .find((b) => b.textContent === label)!
    .click();
const key = (target: Element, k: string, init: Record<string, unknown> = {}) =>
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  win.localStorage.clear();
  win.sessionStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.querySelectorAll('.tab-rail-action-menu').forEach((menu) => menu.remove());
});

describe('row actions in the vertical rail', () => {
  it('offers group moves (and only "new group" before any group exists), never on the strip', () => {
    installFetch();
    const flat = makeApp({ ...serverLayout(), groups: [], ungrouped: [s('s1'), s('s2'), s('s3')] });
    flat.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s1') }, 's1');
    expect(menuLabels()).toEqual(['Session options', 'Move to new group', 'Close session']);
    flat.closeTabRailActionMenu();

    const app = makeApp();
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s2') }, 's2');
    expect(menuLabels()).toEqual([
      'Session options',
      'Move down',
      'Move to Later',
      'Move to Ungrouped',
      'Move to new group',
      'Close session',
    ]);
    app.closeTabRailActionMenu();

    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app._fullRenderSessionTabs();
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s2') }, 's2');
    expect(menuLabels()).toEqual(['Session options', 'Close session']);
  });

  it('moves a row into another group with one PUT carrying the held version', async () => {
    const puts = installFetch();
    const app = makeApp();
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s1') }, 's1');
    clickMenu('Move to Later');
    // Optimistic: the rail already shows it there.
    expect(row('s1').closest('.tab-layout-group')!.getAttribute('data-tab-group-id')).toBe('gy');
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].baseVersion).toBe(8);
    expect(puts[0].layout.groups[1].refs).toEqual([s('s1')]);
    expect(keys(puts[0].layout.ungrouped)).toEqual(['session:s3']);
    expect(typeof puts[0].layout.updatedAt).toBe('string');
    expect(app.tabLayout.version).toBe(9);
    // Focus lands on the moved row, so a keyboard user stays in the rail.
    expect(document.activeElement).toBe(row('s1'));
  });

  it('creates the first group from a flat rail and goes straight into renaming it', async () => {
    const puts = installFetch();
    const app = makeApp({ ...serverLayout(), groups: [], ungrouped: [s('s1'), s('s2'), s('s3')] });
    expect(tabs().getAttribute('role')).toBe('tablist');
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s3') }, 's3');
    clickMenu('Move to new group');
    // The rail is now grouped, with an editor in the new header.
    expect(tabs().getAttribute('role')).toBe('tree');
    const input = document.querySelector<HTMLInputElement>('.tab-layout-group-rename-input')!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('New group');
    input.value = '  Build <x>  ';
    key(input, 'Enter');
    await flush();
    // Create, move and the rename made in the same turn share ONE write.
    expect(puts).toHaveLength(1);
    expect(puts[0].baseVersion).toBe(8);
    expect(puts[0].layout.groups).toHaveLength(1);
    expect(puts[0].layout.groups[0].name).toBe('Build <x>');
    expect(puts[0].layout.groups[0].refs).toEqual([s('s3')]);
    // The name is text, never markup.
    const name = header(puts[0].layout.groups[0].id).querySelector('.tab-layout-group-name')!;
    expect(name.textContent).toBe('Build <x>');
    expect(name.children).toHaveLength(0);
    // A later rename goes out on the version that write returned.
    app.startTabGroupRename(puts[0].layout.groups[0].id);
    const again = document.querySelector<HTMLInputElement>('.tab-layout-group-rename-input')!;
    again.value = 'Build';
    key(again, 'Enter');
    await flush();
    expect(puts).toHaveLength(2);
    expect(puts[1].baseVersion).toBe(9);
    expect(puts[1].layout.groups[0].name).toBe('Build');
    expect(app._inlineRenameActive).toBe(false);
  });
});

describe('web tab rows', () => {
  it('Shift+F10 on a web tab offers its settings and the same group moves', async () => {
    const puts = installFetch();
    const app = makeApp();
    const web = document.querySelector<HTMLElement>('.session-tab[data-webview-id="w1"]')!;
    web.focus();
    key(web, 'F10', { shiftKey: true });
    expect(menuLabels()).toEqual([
      'Web tab settings',
      'Move up',
      'Move to Later',
      'Move to Ungrouped',
      'Move to new group',
    ]);
    clickMenu('Move to Ungrouped');
    await flush();
    expect(keys(puts[0].layout.ungrouped)).toEqual(['session:s1', 'session:s3', 'webview:w1']);
    expect(document.activeElement).toBe(document.querySelector('.session-tab[data-webview-id="w1"]'));
    expect(app.showWebviewModal).not.toHaveBeenCalled();
  });

  it('moves down past the sessions that follow the moved one', async () => {
    const puts = installFetch();
    const app = makeApp({
      ...serverLayout(),
      groups: [{ id: 'gx', name: 'G', refs: [s('s1'), s('s2'), s('s3')] }],
      ungrouped: [],
    });
    app.sessions.get('s2').parentSessionId = 's1';
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s1') }, 's1');
    clickMenu('Move down');
    await flush();
    expect(keys(puts[0].layout.groups[0].refs)).toEqual(['session:s3', 'session:s1', 'session:s2']);
  });
});

describe('group menu', () => {
  it('opens from Shift+F10 / ContextMenu on a header and runs each group operation', async () => {
    const puts = installFetch();
    const app = makeApp();
    win.confirm = vi.fn(() => true);
    header('gx').focus();
    key(header('gx'), 'F10', { shiftKey: true });
    expect(menuLabels()).toEqual(['New session', 'Rename group', 'New group', 'Move group down', 'Delete group']);
    expect(document.activeElement?.textContent).toBe('New session');
    clickMenu('Move group down');
    await flush();
    expect(puts.at(-1).layout.groups.map((g: any) => g.id)).toEqual(['gy', 'gx']);
    expect(document.activeElement).toBe(header('gx'));

    key(header('gx'), 'ContextMenu');
    expect(menuLabels()).toEqual(['New session', 'Rename group', 'New group', 'Move group up', 'Delete group']);
    clickMenu('Delete group');
    expect(win.confirm).toHaveBeenCalledWith('Delete group "<Core & Ops>"? Its tabs move to Ungrouped.');
    await flush();
    const last = puts.at(-1).layout;
    expect(last.groups.map((g: any) => g.id)).toEqual(['gy']);
    expect(keys(last.ungrouped)).toEqual(['session:s1', 'session:s3', 'session:s2', 'webview:w1']);
  });

  it('renames from F2 and cancels on Escape without a write', async () => {
    const puts = installFetch();
    const app = makeApp();
    header('gy').focus();
    key(header('gy'), 'F2');
    const input = document.querySelector<HTMLInputElement>('.tab-layout-group-rename-input')!;
    input.value = 'Changed';
    key(input, 'Escape');
    await flush();
    expect(puts).toHaveLength(0);
    expect(header('gy').querySelector('.tab-layout-group-name')!.textContent).toBe('Later');
    expect(document.activeElement).toBe(header('gy'));
    expect(app._inlineRenameActive).toBe(false);
  });

  it('ignores IME composition keys and blocks re-renders while editing', async () => {
    const puts = installFetch();
    const app = makeApp();
    app.startTabGroupRename('gy');
    const input = document.querySelector<HTMLInputElement>('.tab-layout-group-rename-input')!;
    input.value = '组';
    key(input, 'Enter', { isComposing: true });
    expect(document.querySelector('.tab-layout-group-rename-input')).toBe(input);
    app._fullRenderSessionTabs(); // a background render must not destroy the editor
    expect(input.isConnected).toBe(true);
    input.blur();
    await flush();
    expect(puts.at(-1).layout.groups[1].name).toBe('组');
  });

  it('a session rename takes the editor over and a stale group editor cannot release the guard', () => {
    installFetch();
    const app = makeApp();
    app.startTabGroupRename('gy');
    const handle = app._activeRename;
    expect(handle.groupId).toBe('gy');
    const other = { cancel: vi.fn() };
    app._activeRename = other; // someone newer owns the guard
    handle.cancel();
    expect(app._inlineRenameActive).toBe(true);
  });

  describe('dismissal', () => {
    const open = (app: Record<string, any>) => {
      header('gx').focus();
      key(header('gx'), 'F10', { shiftKey: true });
      expect(document.querySelector('.tab-layout-group-action-menu')).not.toBeNull();
    };
    const isOpen = () => document.querySelector('.tab-layout-group-action-menu') !== null;

    it('Escape closes only the menu and returns focus to its header', () => {
      installFetch();
      const app = makeApp();
      open(app);
      const escape = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(escape);
      expect(isOpen()).toBe(false);
      expect(document.activeElement).toBe(header('gx'));
      expect(app._tabGroupMenuKeydown).toBeNull();
    });

    it('a pointer outside, Tab, focus leaving, a resize, a second open and a re-render all close it', () => {
      installFetch();
      const app = makeApp();
      open(app);
      document.body.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
      expect(isOpen()).toBe(false);

      open(app);
      // A pointer INSIDE the menu does not close it.
      document
        .querySelector('.tab-layout-group-action-menu button')!
        .dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
      expect(isOpen()).toBe(true);
      key(document.activeElement!, 'Tab');
      expect(isOpen()).toBe(false);
      expect(document.activeElement).toBe(header('gx'));

      open(app);
      const buttons = document.querySelectorAll<HTMLElement>('.tab-layout-group-action-menu button');
      buttons[0].dispatchEvent(new win.FocusEvent('focusout', { bubbles: true, relatedTarget: buttons[1] }));
      expect(isOpen()).toBe(true);
      buttons[0].dispatchEvent(new win.FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
      expect(isOpen()).toBe(false);

      open(app);
      win.dispatchEvent(new win.Event('resize'));
      expect(isOpen()).toBe(false);

      open(app);
      app.openTabGroupMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: header('gx') }, 'gx');
      expect(isOpen()).toBe(false);

      open(app);
      app._fullRenderSessionTabs();
      expect(isOpen()).toBe(false);
      // No listener is left behind by any of the paths.
      expect(app._tabGroupMenuOutside).toBeNull();
    });
  });
});

describe('new session in a group', () => {
  it('expands a collapsed group and launches ONE session targeted at it', async () => {
    installFetch();
    const app = makeApp();
    app.toggleTabGroupCollapsed('gx', true);
    app.run = vi.fn(async () => {});
    header('gx').focus();
    key(header('gx'), 'F10', { shiftKey: true });
    clickMenu('New session');
    await flush();
    expect(app.run).toHaveBeenCalledTimes(1);
    expect(app.run).toHaveBeenCalledWith({ count: 1, tabGroupId: 'gx' });
    expect(app.collapsedTabGroupIds.has('gx')).toBe(false);
    expect(JSON.parse(win.localStorage.getItem('codeman:tab-groups-collapsed'))).toEqual([]);
    expect(document.querySelector('.tab-layout-group-action-menu')).toBeNull();
  });

  it('says so, and starts nothing, while another launch is in flight', async () => {
    installFetch();
    const app = makeApp();
    app.toggleTabGroupCollapsed('gx', true);
    app.run = vi.fn(async () => {});
    app._runInFlight = true;
    await app.createSessionInTabGroup('gx');
    expect(app.run).not.toHaveBeenCalled();
    expect(app.collapsedTabGroupIds.has('gx')).toBe(true);
    expect(app.showToast).toHaveBeenCalledWith('A session is already starting.', 'info');
    // A group that no longer exists starts nothing either.
    app._runInFlight = false;
    expect(await app.createSessionInTabGroup('deleted')).toBe(false);
    expect(app.run).not.toHaveBeenCalled();
  });
});

describe('child session placement in the row menu', () => {
  const lineageLayout = (): Layout => ({
    version: 8,
    updatedAt: '2026-10-01T00:00:00.000Z',
    groups: [
      { id: 'gx', name: 'Core', refs: [s('s1'), s('s2')] },
      { id: 'gy', name: 'Later', refs: [{ kind: 'session', id: 's3', placement: 'manual' }] },
    ],
    ungrouped: [],
  });
  const openMenu = (app: Record<string, any>, id: string) =>
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row(id) }, id);

  it('shows where a child sits and offers Follow parent again only to a hand-placed child', async () => {
    const puts = installFetch();
    const app = makeApp(lineageLayout());
    app.sessions.get('s2').parentSessionId = 's1';
    app.sessions.get('s3').parentSessionId = 's1';

    openMenu(app, 's2');
    expect(menuLabels()).toContain('Follows One');
    expect(menuLabels()).not.toContain('Follow parent again');
    const summary = [...document.querySelectorAll<HTMLElement>('.tab-rail-action-menu button')].find(
      (button) => button.textContent === 'Follows One'
    )!;
    expect(summary.getAttribute('aria-disabled')).toBe('true');
    summary.click(); // informational: does nothing, keeps the menu open
    expect(document.querySelector('.tab-rail-action-menu')).not.toBeNull();
    app.closeTabRailActionMenu();

    openMenu(app, 's3');
    expect(menuLabels()).toContain('Placed by hand (parent: One)');
    clickMenu('Follow parent again');
    // Optimistic: the child is back under its parent at once.
    expect(row('s3').closest('.tab-layout-group')!.getAttribute('data-tab-group-id')).toBe('gx');
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].layout.groups[0].refs).toEqual([s('s1'), s('s2'), s('s3')]);
    expect(puts[0].layout.groups[1].refs).toEqual([]);
  });

  it('a child whose parent is gone says so and cannot follow', () => {
    installFetch();
    const app = makeApp({
      ...lineageLayout(),
      groups: [{ id: 'gx', name: 'Core', refs: [{ kind: 'session', id: 's2', placement: 'manual' }] }],
      ungrouped: [s('s3')],
    });
    app.sessions.delete('s1');
    app.sessions.get('s2').parentSessionId = 's1';
    openMenu(app, 's2');
    expect(menuLabels()).toContain('Parent closed; placed on its own');
    expect(menuLabels()).not.toContain('Follow parent again');
  });

  it('a hand move makes a following child manual, so it stays when its parent moves', async () => {
    const puts = installFetch();
    const app = makeApp(lineageLayout());
    app.sessions.get('s2').parentSessionId = 's1';
    openMenu(app, 's2');
    clickMenu('Move to Later');
    await flush();
    expect(puts[0].layout.groups[1].refs).toEqual([
      { kind: 'session', id: 's3', placement: 'manual' },
      { kind: 'session', id: 's2', placement: 'manual' },
    ]);
    openMenu(app, 's1');
    clickMenu('Move to Ungrouped');
    await flush();
    expect(puts[1].layout.ungrouped).toEqual([s('s1')]);
    expect(keys(puts[1].layout.groups[1].refs)).toEqual(['session:s3', 'session:s2']);
  });

  it('adds nothing to the menu for a session without a parent, or outside a grouped rail', () => {
    installFetch();
    const app = makeApp(lineageLayout());
    openMenu(app, 's1');
    expect(menuLabels()).toEqual([
      'Session options',
      'Move down',
      'Move to Later',
      'Move to Ungrouped',
      'Move to new group',
      'Close session',
    ]);
  });
});

describe('the server places created and closed sessions while groups exist', () => {
  const orderPuts = () =>
    (win.fetch as any).mock.calls.filter(([url]: [string]) => url === '/api/session-order').length;
  const stub = (app: Record<string, any>) => {
    app._debounceTimers = {};
    app.markSessionTabEntering = () => {};
    app.markTerminalEntering = () => {};
    app.markConnectionLineEntering = () => {};
    app.renderSessionTabs = () => app._fullRenderSessionTabs();
    app.updateCost = () => {};
    app.startSystemStatsPolling = () => {};
  };

  it('a spawned child is drawn after its parent and NOT echoed back as a hand order (which would pin it)', async () => {
    installFetch();
    const app = makeApp();
    stub(app);
    // The server already broadcast its order with the child after its parent.
    win.localStorage.setItem('codeman-session-order', JSON.stringify(['s1', 's2', 'kid', 's3']));
    app._onSessionCreated({ id: 'kid', name: 'Kid', status: 'idle', parentSessionId: 's2' });
    expect(row('kid').closest('.tab-layout-group')!.getAttribute('data-tab-group-id')).toBe('gx');
    expect(app.sessionOrder).toEqual(['s1', 's2', 'kid', 's3']);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(orderPuts()).toBe(0);

    // The order bookkeeping runs first in _cleanupSessionData; the buffer and
    // timer maps it clears afterwards are not part of this harness.
    try {
      app._cleanupSessionData('kid');
    } catch {}
    expect(app.sessionOrder).toEqual(['s1', 's2', 's3']);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(orderPuts()).toBe(0);
  });

  it('keeps the flat rail exactly as before: a new session is appended and its order saved', async () => {
    installFetch();
    const app = makeApp({ ...serverLayout(), groups: [], ungrouped: [s('s1'), s('s2'), s('s3')] });
    stub(app);
    app._onSessionCreated({ id: 'kid', name: 'Kid', status: 'idle', parentSessionId: 's2' });
    expect(app.sessionOrder).toEqual(['s1', 's2', 's3', 'kid']);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(orderPuts()).toBe(1);
  });
});

describe('saved web tabs in groups (openness is per device)', () => {
  const webLayout = (): Layout => ({
    version: 8,
    updatedAt: '2026-10-01T00:00:00.000Z',
    groups: [{ id: 'gx', name: 'Dash', refs: [s('s1'), w('w1'), s('s2')] }],
    ungrouped: [s('s3'), w('w2')],
  });
  const webRows = () =>
    [...document.querySelectorAll<HTMLElement>('.session-tab[data-webview-id]')].map((el) => [
      el.closest('.tab-layout-group')!.getAttribute('data-tab-group-id'),
      el.dataset.webviewId,
      el.querySelector('.tab-number')?.textContent ?? null,
    ]);

  it('shows a grouped web tab only while it is open here, and reopens it where the layout keeps it', () => {
    installFetch();
    const app = makeApp(null);
    app.webviews = new Map([
      ['w1', { id: 'w1', name: 'One', url: 'https://one.test' }],
      ['w2', { id: 'w2', name: 'Two', url: 'https://two.test' }],
    ]);
    app.webviewOrder = ['w1'];
    app._applyTabLayout(webLayout());
    // w2 is saved and placed, but not open on this device: no row, no number.
    expect(webRows()).toEqual([['gx', 'w1', '4']]);
    expect(header('gx').querySelector('.tab-layout-group-count')!.textContent).toBe('3');

    app.webviewOrder = [];
    app._fullRenderSessionTabs();
    expect(webRows()).toEqual([]);
    // The group survives with its sessions; the layout still holds the web tab.
    expect(header('gx').querySelector('.tab-layout-group-count')!.textContent).toBe('2');
    expect(keys(app.tabLayout.groups[0].refs)).toEqual(['session:s1', 'webview:w1', 'session:s2']);

    app.webviewOrder = ['w2', 'w1'];
    app._fullRenderSessionTabs();
    const order = [...tabs().querySelectorAll<HTMLElement>('.session-tab')].map(
      (el) => el.dataset.webviewId || el.dataset.id
    );
    expect(order).toEqual(['s1', 'w1', 's2', 's3', 'w2']);
  });
});

describe('server echoes and reloads', () => {
  it('defers an SSE-triggered read while its own write is in flight, then re-reads once', async () => {
    let releasePut: (() => void) | null = null;
    const gets: number[] = [];
    const puts: any[] = [];
    win.fetch = vi.fn(async (_url: string, init: any) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body);
        puts.push(body);
        await new Promise<void>((resolve) => (releasePut = resolve));
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { layout: { ...body.layout, version: 9 } } }),
        };
      }
      gets.push(1);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { layout: { ...serverLayout(9), groups: puts[0].layout.groups } } }),
      };
    });
    const app = makeApp();
    app.editTabLayout({ type: 'renameGroup', groupId: 'gy', name: 'Mine' });
    await flush();
    expect(puts).toHaveLength(1);
    app._onTabLayoutChanged({ owner: '@single', version: 9 });
    await flush();
    expect(gets).toHaveLength(0);
    releasePut!();
    await flush();
    expect(app.tabLayout.groups[1].name).toBe('Mine');
    expect(gets).toHaveLength(1);
  });

  it('keeps unsaved edits across a reload: keepalive PUT now, rebased replay after', async () => {
    const puts = installFetch();
    const app = makeApp();
    app.editTabLayout({ type: 'renameGroup', groupId: 'gy', name: 'Unsaved' });
    // Page goes away before the flush ran (dispose stands in for the unload).
    app._persistPendingTabLayoutEdits();
    app._tabLayoutEditor.dispose();
    expect(win.fetch).toHaveBeenCalledWith(
      '/api/tab-layout',
      expect.objectContaining({ method: 'PUT', keepalive: true })
    );
    expect(puts.at(-1).baseVersion).toBe(8);
    expect(puts.at(-1).layout.groups[1].name).toBe('Unsaved');
    expect(JSON.parse(win.sessionStorage.getItem('codeman:tab-layout-pending')).operations).toEqual([
      { type: 'renameGroup', groupId: 'gy', name: 'Unsaved' },
    ]);

    // Next page: the keepalive lost a race; the layout moved on to version 12.
    const next = installFetch();
    const reloaded = makeApp({
      ...serverLayout(12),
      groups: [...serverLayout().groups, { id: 'gz', name: 'Z', refs: [] }],
    });
    expect(reloaded.tabLayout.groups[1].name).toBe('Unsaved');
    await flush();
    expect(next).toHaveLength(1);
    expect(next[0].baseVersion).toBe(12);
    expect(next[0].layout.groups.map((g: any) => g.name)).toEqual(['<Core & Ops>', 'Unsaved', 'Z']);
    expect(win.sessionStorage.getItem('codeman:tab-layout-pending')).toBeNull();

    // And when the keepalive DID land, nothing is re-sent.
    win.sessionStorage.setItem(
      'codeman:tab-layout-pending',
      JSON.stringify({ operations: [{ type: 'renameGroup', groupId: 'gy', name: 'Later' }] })
    );
    const none = installFetch();
    makeApp();
    await flush();
    expect(none).toHaveLength(0);
  });

  it('leaves the flat rail byte-identical when the layout has no groups, and never edits off the rail', () => {
    installFetch();
    const noLayout = makeApp(null);
    noLayout._fullRenderSessionTabs();
    const flat = tabs().innerHTML;
    makeApp({ ...serverLayout(), groups: [], ungrouped: [s('s1'), s('s2'), s('s3')] });
    expect(tabs().innerHTML).toBe(flat);
    expect(tabs().getAttribute('role')).toBe('tablist');
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    const strip = makeApp();
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    expect(strip.editTabLayout({ type: 'renameGroup', groupId: 'gy', name: 'x' })).toBe(false);
    expect(win.fetch).not.toHaveBeenCalled();
  });
});
