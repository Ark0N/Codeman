/**
 * @fileoverview PathPicker "New folder" (opt-in via `allowNewFolder`). Same jsdom harness as
 * path-picker-hidden.test.ts (see its header for why the environment is built by hand).
 *
 * What can silently go wrong: the button showing for a picker that never asked for it (the
 * container-workdir picker cannot create on the host), the folder made in the wrong place, the new
 * folder not selected afterwards, and Escape closing the whole picker instead of just the form.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const accessoryJs = readFileSync(resolve(PUBLIC, 'keyboard-accessory.js'), 'utf8');
const sessionUiJs = readFileSync(resolve(PUBLIC, 'session-ui.js'), 'utf8');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://localhost/' });
const jsdomWindow = dom.window as unknown as Window & typeof globalThis;
const doc = jsdomWindow.document;

type Call = { url: string; init?: { method?: string; body?: string } };

function loadPathPicker(fetchImpl: (url: string, init?: Call['init']) => Promise<unknown>): any {
  const factory = new Function(
    'window',
    'document',
    'localStorage',
    'fetch',
    'MobileDetection',
    `${accessoryJs}\nreturn PathPicker;`
  );
  return factory(jsdomWindow, doc, jsdomWindow.localStorage, fetchImpl, { isTouchDevice: () => false });
}

const listing = (path: string, names: string[]) => ({
  json: async () => ({
    success: true,
    data: {
      path,
      parent: null,
      root: '/home/dev',
      roots: [{ label: 'Home', path: '/home/dev' }],
      entries: names.map((name) => ({ name, type: 'directory', path: `${path}/${name}` })),
      truncated: false,
    },
  }),
});

describe('PathPicker New folder', () => {
  let PathPicker: any;
  let calls: Call[];
  let names: string[];
  let mkdirReply: () => unknown;

  beforeEach(() => {
    jsdomWindow.localStorage.clear();
    doc.body.replaceChildren();
    calls = [];
    names = ['src'];
    mkdirReply = () => {
      names.push('fresh');
      return { json: async () => ({ success: true, data: { path: '/home/dev/project/fresh' } }) };
    };
    PathPicker = loadPathPicker(async (url, init) => {
      calls.push({ url, init });
      return url.startsWith('/api/filesystem/mkdir') ? mkdirReply() : listing('/home/dev/project', names);
    });
  });
  afterEach(() => {
    PathPicker?.close?.(false);
    doc.body.replaceChildren();
  });

  const open = async (options: Record<string, unknown> = {}) => {
    PathPicker.open({ onSelect: () => {}, directoriesOnly: true, ...options });
    await vi.waitFor(() => expect(doc.querySelectorAll('.path-picker-item').length).toBeGreaterThan(0));
  };
  const button = () => doc.querySelector('.path-picker-newfolder') as HTMLButtonElement;
  const form = () => doc.querySelector('.path-picker-newfolder-form') as HTMLFormElement;
  const nameInput = () => doc.querySelector('.path-picker-newfolder-name') as HTMLInputElement;
  const submit = (name: string) => {
    button().click();
    nameInput().value = name;
    form().dispatchEvent(new jsdomWindow.Event('submit', { cancelable: true, bubbles: true }));
  };

  it('is hidden unless the caller opts in', async () => {
    await open();
    expect(button().hidden).toBe(true);
    expect(form().hidden).toBe(true);
  });

  it('shows the button, and opens the name form on click, when allowed', async () => {
    await open({ allowNewFolder: true });
    expect(button().hidden).toBe(false);
    expect(form().hidden).toBe(true);
    button().click();
    expect(form().hidden).toBe(false);
  });

  it('creates inside the folder being viewed, reloads it and selects the new folder', async () => {
    await open({ allowNewFolder: true, sessionId: 'abc123' });
    submit('fresh');
    await vi.waitFor(() =>
      expect(doc.querySelector('.path-picker-selection-value')?.textContent).toBe('/home/dev/project/fresh')
    );
    const post = calls.find((c) => c.url === '/api/filesystem/mkdir');
    expect(post?.init?.method).toBe('POST');
    expect(JSON.parse(post?.init?.body ?? '{}')).toEqual({
      path: '/home/dev/project',
      name: 'fresh',
      sessionId: 'abc123',
    });
    expect(Array.from(doc.querySelectorAll('.path-picker-item-name')).map((e) => e.textContent)).toContain('fresh');
    expect(form().hidden).toBe(true);
    expect((doc.querySelector('.path-picker-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the server reason and keeps the form open when the folder cannot be made', async () => {
    mkdirReply = () => ({ json: async () => ({ success: false, error: '"fresh" already exists in this folder' }) });
    await open({ allowNewFolder: true });
    submit('fresh');
    await vi.waitFor(() =>
      expect(doc.querySelector('.path-picker-status')?.textContent).toBe('"fresh" already exists in this folder')
    );
    expect(doc.querySelector('.path-picker-status')?.classList.contains('error')).toBe(true);
    expect(form().hidden).toBe(false);
  });

  it('forwards showHidden while the picker is showing hidden entries', async () => {
    jsdomWindow.localStorage.setItem('codeman:pathPickerShowHidden', '1');
    await open({ allowNewFolder: true });
    submit('fresh');
    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/filesystem/mkdir')).toBe(true));
    const post = calls.find((c) => c.url === '/api/filesystem/mkdir');
    expect(JSON.parse(post?.init?.body ?? '{}').showHidden).toBe('true');
  });

  it('disables Create while the request runs, so a double tap sends one', async () => {
    let finish: (v: unknown) => void = () => {};
    mkdirReply = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await open({ allowNewFolder: true });
    const create = doc.querySelector('.path-picker-newfolder-create') as HTMLButtonElement;
    submit('fresh');
    await vi.waitFor(() => expect(create.disabled).toBe(true));
    finish({ json: async () => ({ success: true, data: { path: '/home/dev/project/fresh' } }) });
    await vi.waitFor(() => expect(create.disabled).toBe(false));
  });

  it('sends nothing for a blank name', async () => {
    await open({ allowNewFolder: true });
    submit('   ');
    await Promise.resolve();
    expect(calls.some((c) => c.url === '/api/filesystem/mkdir')).toBe(false);
  });

  it('Escape in the name field closes the form, not the picker', async () => {
    await open({ allowNewFolder: true });
    button().click();
    nameInput().dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(form().hidden).toBe(true);
    expect(doc.querySelector('.path-picker-overlay')).not.toBeNull();
  });

  it("is on for Create New's custom folder picker too", () => {
    const start = sessionUiJs.indexOf('openNewCasePathPicker() {');
    expect(sessionUiJs.slice(start, sessionUiJs.indexOf('PathPicker.open', start) + 400)).toContain(
      'allowNewFolder: true'
    );
  });

  it('is on for Link Existing and off for the other session-ui pickers', () => {
    const block = (name: string) => {
      const start = sessionUiJs.indexOf(`${name}() {`);
      return sessionUiJs.slice(start, sessionUiJs.indexOf('PathPicker.open', start) + 400);
    };
    expect(block('openLinkCasePathPicker')).toContain('allowNewFolder: true');
    for (const other of ['openDockerWorkspacePathPicker', 'openDockerWorkdirPicker']) {
      expect(block(other), other).not.toContain('allowNewFolder');
    }
  });
});
