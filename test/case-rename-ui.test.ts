/**
 * @fileoverview The Rename dialog's flow in session-ui.js (renameCase / submitRenameCase): it is the app's
 * own modal, not a browser prompt; a linked case offers the folder checkbox; live sessions are listed inside
 * the dialog and only stopped after a second press; server errors stay in the dialog. Evaluates the real file
 * against a stub DOM.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');
const HTML = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');

type El = {
  value: string;
  textContent: string;
  checked: boolean;
  disabled: boolean;
  classes: Set<string>;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, on?: boolean): void;
    contains(c: string): boolean;
  };
  focus(): void;
  select(): void;
};
const el = (hidden = false): El => {
  const classes = new Set<string>(hidden ? ['hidden'] : []);
  return {
    value: '',
    textContent: '',
    checked: false,
    disabled: false,
    classes,
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      toggle: (c, on) => void ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    focus() {},
    select() {},
  };
};

function makeApp(opts: { responses: unknown[]; cases: unknown[]; current?: string }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const store = new Map<string, string>([['caseSettings_alpha', '{"agentTeams":true}']]);
  const queue = [...opts.responses];
  const ids = [
    'renameCaseModal',
    'renameCaseInput',
    'renameCaseLabel',
    'renameCaseFolderRow',
    'renameCaseFolder',
    'renameCaseFolderHint',
    'renameCaseNote',
    'renameCaseError',
    'renameCaseSubmit',
    'quickStartCase',
  ];
  const els: Record<string, El> = Object.fromEntries(ids.map((id) => [id, el()]));
  els.quickStartCase.value = opts.current ?? 'alpha';
  function CodemanApp(this: unknown) {}
  const ctx = vm.createContext({
    CodemanApp,
    window: {},
    document: { getElementById: (id: string) => els[id] ?? null },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    fetch: async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => queue.shift() };
    },
    escapeHtml: (s: string) => s,
  });
  vm.runInContext(SRC, ctx);
  const app = Object.create((CodemanApp as unknown as { prototype: object }).prototype) as Record<string, any>;
  const refreshed: unknown[] = [];
  Object.assign(app, {
    cases: opts.cases,
    showToast: (m: string) => void toasts.push(m),
    loadQuickStartCases: async (n: unknown) => void refreshed.push(n),
    renderCaseManageList: () => void refreshed.push('render'),
  });
  return { app, els, calls, toasts, store, refreshed };
}

const ok = { success: true, data: {} };

describe('the Rename dialog is part of the page, not a browser prompt', () => {
  it('has its modal in index.html, with the name, folder and error elements the code drives', () => {
    for (const id of [
      'renameCaseModal',
      'renameCaseInput',
      'renameCaseFolder',
      'renameCaseError',
      'renameCaseSubmit',
    ]) {
      expect(HTML).toContain(`id="${id}"`);
    }
    const fn = SRC.slice(SRC.indexOf('renameCase(name)'), SRC.indexOf('async deleteCase(name)'));
    expect(fn).not.toMatch(/\b(prompt|confirm|alert)\(/);
  });
});

describe('renameCase / submitRenameCase', () => {
  it('opens pre-filled, renames a local case, moves its run options and reselects it under the new name', async () => {
    const t = makeApp({ responses: [ok], cases: [{ name: 'alpha', location: 'local' }] });
    t.app.renameCase('alpha');
    expect(t.els.renameCaseModal.classes.has('active')).toBe(true);
    expect(t.els.renameCaseInput.value).toBe('alpha');
    expect(t.els.renameCaseFolderRow.classes.has('hidden')).toBe(true);

    t.els.renameCaseInput.value = ' beta ';
    await t.app.submitRenameCase();

    expect(t.calls).toEqual([{ url: '/api/cases/alpha/rename', body: { newName: 'beta' } }]);
    expect(t.els.renameCaseModal.classes.has('active')).toBe(false);
    expect(t.store.get('caseSettings_beta')).toBe('{"agentTeams":true}');
    expect(t.store.has('caseSettings_alpha')).toBe(false);
    expect(t.refreshed).toEqual(['beta', 'render']);
  });

  it('keeps the dialog open with a message for the same name or a name that is not allowed, and sends nothing', async () => {
    for (const entered of ['', 'alpha', 'a b', '../x']) {
      const t = makeApp({ responses: [], cases: [{ name: 'alpha' }] });
      t.app.renameCase('alpha');
      t.els.renameCaseInput.value = entered;
      await t.app.submitRenameCase();
      expect(t.calls, entered).toEqual([]);
      expect(t.els.renameCaseError.classes.has('hidden'), entered).toBe(false);
      expect(t.els.renameCaseModal.classes.has('active'), entered).toBe(true);
    }
  });

  it('shows the folder checkbox for a linked case and sends its state', async () => {
    const t = makeApp({ responses: [ok], cases: [{ name: 'alpha', linked: true, path: '/srv/app' }] });
    t.app.renameCase('alpha');
    expect(t.els.renameCaseFolderRow.classes.has('hidden')).toBe(false);
    expect(t.els.renameCaseFolderHint.textContent).toContain('/srv/app');
    t.els.renameCaseInput.value = 'beta';
    t.els.renameCaseFolder.checked = true;
    await t.app.submitRenameCase();
    expect(t.calls[0].body).toEqual({ newName: 'beta', renameFolder: true });

    const alias = makeApp({ responses: [ok], cases: [{ name: 'alpha', linked: true, path: '/srv/app' }] });
    alias.app.renameCase('alpha');
    alias.els.renameCaseInput.value = 'beta';
    await alias.app.submitRenameCase();
    expect(alias.calls[0].body).toEqual({ newName: 'beta', renameFolder: false });
  });

  it('lists the live sessions in the dialog and stops them only on the second press', async () => {
    const refusal = {
      success: false,
      error: '1 live session has this folder open.',
      requiresStop: true,
      sessions: [{ id: 's', name: 'w1-alpha' }],
    };
    const t = makeApp({ responses: [refusal, ok], cases: [{ name: 'alpha' }] });
    t.app.renameCase('alpha');
    t.els.renameCaseInput.value = 'beta';

    await t.app.submitRenameCase();
    expect(t.els.renameCaseError.textContent).toContain('w1-alpha');
    // "stop" closes them through the server's session cleanup: say that their tabs go away
    expect(t.els.renameCaseError.textContent).toContain('They will be closed (their tabs go away');
    expect(t.els.renameCaseSubmit.textContent).toBe('Stop sessions and rename');
    expect(t.els.renameCaseModal.classes.has('active')).toBe(true);
    expect(t.calls).toHaveLength(1);

    await t.app.submitRenameCase();
    expect(t.calls.map((c) => c.body)).toEqual([{ newName: 'beta' }, { newName: 'beta', stopSessions: true }]);
    expect(t.els.renameCaseModal.classes.has('active')).toBe(false);
  });

  it('says how many sessions were already closed when the rename fails after closing them', async () => {
    const refusal = { success: false, error: 'busy', requiresStop: true, sessions: [{ id: 's', name: 'w1-alpha' }] };
    const failed = { success: false, error: 'The registry could not be written.', stoppedSessions: 2 };
    const t = makeApp({ responses: [refusal, failed], cases: [{ name: 'alpha' }] });
    t.app.renameCase('alpha');
    t.els.renameCaseInput.value = 'beta';
    await t.app.submitRenameCase();
    await t.app.submitRenameCase();
    expect(t.els.renameCaseError.textContent).toBe(
      'The registry could not be written. (2 sessions were already closed.)'
    );
    expect(t.els.renameCaseModal.classes.has('active')).toBe(true);
  });

  it('cancelling the dialog stops nothing and renames nothing', async () => {
    const t = makeApp({ responses: [], cases: [{ name: 'alpha' }] });
    t.app.renameCase('alpha');
    t.app.closeRenameCase();
    expect(t.els.renameCaseModal.classes.has('active')).toBe(false);
    await t.app.submitRenameCase(); // nothing open: ignored
    expect(t.calls).toEqual([]);
  });

  it('shows the server’s message inside the dialog when the folder is locked, and leaves the lists alone', async () => {
    const locked = { success: false, error: 'The folder is in use by another program (EBUSY).' };
    const t = makeApp({ responses: [locked], cases: [{ name: 'alpha' }] });
    t.app.renameCase('alpha');
    t.els.renameCaseInput.value = 'beta';
    await t.app.submitRenameCase();
    expect(t.els.renameCaseError.textContent).toBe('The folder is in use by another program (EBUSY).');
    expect(t.els.renameCaseModal.classes.has('active')).toBe(true);
    expect(t.els.renameCaseSubmit.disabled).toBe(false); // the name can be fixed and tried again
    expect(t.toasts).toEqual([]);
    expect(t.refreshed).toEqual([]);
    expect(t.store.has('caseSettings_alpha')).toBe(true);
  });
});
