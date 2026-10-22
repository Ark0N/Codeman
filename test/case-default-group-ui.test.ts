/**
 * @fileoverview The Case settings "Default session group" selector (session-ui.js):
 * it lists Ungrouped plus every named group the server reports, saves through
 * PUT /api/cases/:name/default-group, reverts on a refused save, mirrors the
 * desktop and phone popovers, and refreshes its options when the tab layout
 * changes (groups created, renamed or deleted). Also pins the zh-CN strings.
 *
 * Port: none (vm sandbox, stubbed fetch and DOM).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

function fakeSelect() {
  const select: any = {
    value: '',
    disabled: false,
    options: [] as any[],
    replaceChildren(...nodes: any[]) {
      select.options = nodes;
    },
  };
  return select;
}

function harness(server: { groups: Array<{ id: string; name: string }>; groupId: string | null; putStatus?: number }) {
  const elements: Record<string, any> = {
    quickStartCase: { value: 'proj' },
    caseDefaultGroup: fakeSelect(),
    caseDefaultGroupMobile: fakeSelect(),
  };
  const requests: Array<{ url: string; method: string; body?: any }> = [];
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      createElement: () => {
        const attrs: Record<string, string> = {};
        return { value: '', textContent: '', attrs, setAttribute: (k: string, v: string) => (attrs[k] = v) };
      },
    },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, body });
      const ok = method !== 'PUT' || (server.putStatus ?? 200) === 200;
      if (method === 'PUT' && ok) server.groupId = body.groupId;
      const payload = ok
        ? { success: true, data: { caseName: 'proj', groupId: server.groupId, groups: server.groups } }
        : { success: false, error: 'nope', errorCode: 'INVALID_INPUT' };
      return { ok, status: ok ? 200 : (server.putStatus ?? 400), json: async () => payload };
    },
    console,
  });
  for (const file of ['api-client.js', 'session-ui.js']) {
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  }
  const app = new (CodemanApp as any)();
  app.showToast = vi.fn();
  return { app, elements, requests, server };
}

const optionView = (select: any) => select.options.map((o: any) => [o.value, o.textContent]);

describe('Case settings: Default session group selector', () => {
  it('lists Ungrouped plus every named group, selecting the stored one in both popovers', async () => {
    const h = harness({
      groups: [
        { id: 'g1', name: 'Core' },
        { id: 'g2', name: 'Ops' },
      ],
      groupId: 'g2',
    });
    await h.app._loadCaseDefaultGroup();
    expect(h.requests[0]).toMatchObject({ url: '/api/cases/proj/default-group', method: 'GET' });
    for (const id of ['caseDefaultGroup', 'caseDefaultGroupMobile']) {
      const select = h.elements[id];
      expect(optionView(select)).toEqual([
        ['', 'Ungrouped'],
        ['g1', 'Core'],
        ['g2', 'Ops'],
      ]);
      expect(select.value).toBe('g2');
      expect(select.disabled).toBe(false);
      // Group names are user text: never handed to the translator.
      expect(select.options[1].attrs['data-i18n-skip']).toBe('');
      expect(select.options[0].attrs['data-i18n-skip']).toBeUndefined();
    }
  });

  it('saves a choice (and Ungrouped as null) and mirrors it to the other popover', async () => {
    const h = harness({ groups: [{ id: 'g1', name: 'Core' }], groupId: null });
    await h.app._loadCaseDefaultGroup();
    h.elements.caseDefaultGroup.value = 'g1';
    await h.app.onCaseDefaultGroupChanged(h.elements.caseDefaultGroup);
    expect(h.requests.at(-1)).toEqual({ url: '/api/cases/proj/default-group', method: 'PUT', body: { groupId: 'g1' } });
    expect(h.elements.caseDefaultGroupMobile.value).toBe('g1');

    h.elements.caseDefaultGroupMobile.value = '';
    await h.app.onCaseDefaultGroupChanged(h.elements.caseDefaultGroupMobile);
    expect(h.requests.at(-1)?.body).toEqual({ groupId: null });
    expect(h.elements.caseDefaultGroup.value).toBe('');
  });

  it('reverts to the confirmed value and says so when the save is refused', async () => {
    const h = harness({ groups: [{ id: 'g1', name: 'Core' }], groupId: 'g1', putStatus: 400 });
    await h.app._loadCaseDefaultGroup();
    h.elements.caseDefaultGroup.value = '';
    await h.app.onCaseDefaultGroupChanged(h.elements.caseDefaultGroup);
    expect(h.elements.caseDefaultGroup.value).toBe('g1');
    expect(h.app.showToast).toHaveBeenCalledWith('Could not save the default session group.', 'error');
  });

  it('refreshes its options when the layout changes: created, renamed and deleted groups', async () => {
    const h = harness({ groups: [{ id: 'g1', name: 'Core' }], groupId: 'g1' });
    await h.app._loadCaseDefaultGroup();
    h.app._refreshCaseDefaultGroupOptions({
      groups: [
        { id: 'g1', name: 'Core team' },
        { id: 'g3', name: 'New' },
      ],
    });
    expect(optionView(h.elements.caseDefaultGroup)).toEqual([
      ['', 'Ungrouped'],
      ['g1', 'Core team'],
      ['g3', 'New'],
    ]);
    expect(h.elements.caseDefaultGroup.value).toBe('g1');
    // The selected group is deleted: the selector visibly falls back to Ungrouped.
    h.app._refreshCaseDefaultGroupOptions({ groups: [{ id: 'g3', name: 'New' }] });
    expect(h.elements.caseDefaultGroup.value).toBe('');
    expect(h.elements.caseDefaultGroupMobile.value).toBe('');
  });

  it('leaves the options alone when a layout broadcast does not change the groups', async () => {
    const h = harness({
      groups: [
        { id: 'g1', name: 'Core' },
        { id: 'g2', name: 'Ops' },
      ],
      groupId: 'g2',
    });
    await h.app._loadCaseDefaultGroup();
    const before = h.elements.caseDefaultGroup.options;
    // A session created or moved elsewhere: same groups, other refs.
    h.app._refreshCaseDefaultGroupOptions({
      groups: [
        { id: 'g1', name: 'Core', refs: [{ kind: 'session', id: 's9' }] },
        { id: 'g2', name: 'Ops', refs: [] },
      ],
    });
    expect(h.elements.caseDefaultGroup.options).toBe(before); // not rebuilt, so an open dropdown stays open
    expect(h.elements.caseDefaultGroup.value).toBe('g2');
  });

  it('the layout refresh is wired into _applyTabLayout', () => {
    const app = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
    const body = app.slice(app.indexOf('  _applyTabLayout(layout) {'));
    expect(body.slice(0, body.indexOf('\n  }\n'))).toMatch(/^\s*this\._refreshCaseDefaultGroupOptions\?\.\(next\);/m);
  });

  it('both popovers carry the selector, and every new string has a zh-CN entry', () => {
    const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
    expect(html).toContain('id="caseDefaultGroup"');
    expect(html).toContain('id="caseDefaultGroupMobile"');
    const i18n = readFileSync(resolve(PUBLIC, 'i18n.js'), 'utf8');
    for (const text of [
      'Default session group',
      'New sessions for this case land in this group',
      'Could not save the default session group.',
      'Ungrouped',
    ]) {
      expect(i18n, text).toMatch(new RegExp(`['"]?${text.replace(/[.]/g, '\\.')}['"]?: '`));
    }
  });
});
