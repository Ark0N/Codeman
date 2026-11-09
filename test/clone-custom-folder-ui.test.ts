/**
 * @fileoverview Frontend test for Clone Repo's custom folder (session-ui.js `cloneCase()` /
 * `_cloneTargetPath()`): the chosen folder is the PARENT, so the clone request carries
 * `<folder>/<case name>` exactly as Create New does, and without the checkbox no `path` is sent
 * (the server then clones to `~/codeman-cases/<name>`). The "Will clone into" line has to name the
 * folder the request will really use, so it follows every way the name or the folder can change:
 * typing, the URL, the preflight's suggested name and the Browse picker. Runs against the real
 * index.html markup.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const INDEX_HTML = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
const CONSTANTS_JS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const SESSION_UI_JS = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');

function bootClone() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window as unknown as Window & typeof globalThis & { CodemanApp: new () => any };
  const run = (src: string) => (win as unknown as { eval: (s: string) => void }).eval(src);
  run('window.CodemanApp = function CodemanApp() {};');
  run(CONSTANTS_JS);
  run(SESSION_UI_JS);
  const app = new win.CodemanApp();
  app.showToast = () => {};
  app._setCloneStatus = () => {};
  app.closeCreateCaseModal = () => {};
  app.loadQuickStartCases = async () => {};
  app.saveLastUsedCase = async () => {};
  const fetchMock = vi.fn(async () => ({ json: async () => ({ success: true, data: {} }) }));
  (win as unknown as { fetch: unknown }).fetch = fetchMock;
  const doc = win.document;
  const set = (id: string, value: string) => ((doc.getElementById(id) as HTMLInputElement).value = value);
  set('cloneRepoUrl', 'https://github.com/opticon454/bifrost');
  set('cloneCaseName', 'bifrost');
  const preview = () => doc.getElementById('cloneCasePathPreview')?.textContent;
  return { app, win, doc, set, preview, fetchMock };
}

async function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
  return { url, body: JSON.parse(init.body) };
}

describe('Clone Repo custom folder', () => {
  it('sends <folder>/<case name> as the path and previews it', async () => {
    const { app, doc, set, fetchMock } = bootClone();
    (doc.getElementById('cloneCustomPathToggle') as HTMLInputElement).checked = true;
    set('cloneCasePath', '/mnt/user/Scripts/GitHub/opticon454/');
    app.updateCloneCasePathPreview();
    expect(doc.getElementById('cloneCasePathPreview')?.textContent).toBe(
      'Will clone into: /mnt/user/Scripts/GitHub/opticon454/bifrost'
    );
    await app.cloneCase();
    const { url, body } = await requestBody(fetchMock);
    expect(url).toBe('/api/cases/clone');
    expect(body.path).toBe('/mnt/user/Scripts/GitHub/opticon454/bifrost');
    expect(body.name).toBe('bifrost');
  });

  it('follows the case name when it is edited', () => {
    const { app, doc, set } = bootClone();
    set('cloneCasePath', '~/projects');
    set('cloneCaseName', 'other');
    app.onCloneNameEdited();
    expect(doc.getElementById('cloneCasePathPreview')?.textContent).toBe('Will clone into: ~/projects/other');
  });

  it('sends no path without the checkbox, even when the folder field still holds one', async () => {
    const { app, set, fetchMock } = bootClone();
    set('cloneCasePath', '/mnt/user/Scripts/GitHub/opticon454');
    await app.cloneCase();
    const { body } = await requestBody(fetchMock);
    expect(body.path).toBeUndefined();
  });

  it.each([
    ['/mnt/projects', '/mnt/projects/bifrost'],
    ['/mnt/projects///', '/mnt/projects/bifrost'],
    ['  /mnt/projects/  ', '/mnt/projects/bifrost'],
    ['/', '/bifrost'],
    ['~', '~/bifrost'],
    ['~/', '~/bifrost'],
  ])('joins the parent %j to the case name', (parent, target) => {
    const { app, set } = bootClone();
    set('cloneCasePath', parent);
    expect(app._cloneTargetPath()).toBe(target);
  });

  it('follows the name the preflight settles on, which is the one the request will carry', async () => {
    const { app, doc, set, preview, fetchMock } = bootClone();
    (doc.getElementById('cloneCustomPathToggle') as HTMLInputElement).checked = true;
    set('cloneCasePath', '/mnt/projects');
    // The page's own guess for a URL copied out of a browser tab; the server reads the repo as `repo`.
    set('cloneCaseName', 'repo-tab-readme');
    app.updateCloneCasePathPreview();
    expect(preview()).toBe('Will clone into: /mnt/projects/repo-tab-readme');
    app._applyClonePreflight(
      {
        parse: { cloneable: true, suggestedName: 'repo', provider: 'GitHub', owner: 'owner', repo: 'repo' },
        gitAvailable: true,
      },
      'https://github.com/owner/repo?tab=readme'
    );
    expect(preview()).toBe('Will clone into: /mnt/projects/repo');
    await app.cloneCase();
    const { body } = await requestBody(fetchMock);
    expect(body).toMatchObject({ name: 'repo', path: '/mnt/projects/repo' });
  });

  it('sends the folder Browse picked as the parent, and titles the picker as the parent', async () => {
    const { app, win, doc, preview, fetchMock } = bootClone();
    const open = vi.fn();
    (win as unknown as { PathPicker: { open: unknown } }).PathPicker = { open };
    (doc.getElementById('cloneCustomPathToggle') as HTMLInputElement).checked = true;
    app.openCloneCasePathPicker();
    const options = open.mock.calls[0]![0] as {
      title: string;
      directoriesOnly: boolean;
      allowNewFolder: boolean;
      onSelect(p: string): void;
    };
    expect(options.title).toBe('Choose the folder to clone inside');
    expect(options.directoriesOnly).toBe(true);
    // A parent that does not exist yet is refused, so the picker has to be able to make it.
    expect(options.allowNewFolder).toBe(true);
    options.onSelect('/mnt/projects');
    expect((doc.getElementById('cloneCasePath') as HTMLInputElement).value).toBe('/mnt/projects');
    expect(preview()).toBe('Will clone into: /mnt/projects/bifrost');
    await app.cloneCase();
    const { body } = await requestBody(fetchMock);
    expect(body.path).toBe('/mnt/projects/bifrost');
  });

  it('asks for the parent folder before cloning when the checkbox is on and the field is empty', async () => {
    const { app, doc, fetchMock } = bootClone();
    app.showToast = vi.fn();
    (doc.getElementById('cloneCustomPathToggle') as HTMLInputElement).checked = true;
    await app.cloneCase();
    expect(app.showToast).toHaveBeenCalledWith('Choose the folder to clone inside', 'error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds no target and sends nothing without a case name', async () => {
    const { app, doc, set, preview, fetchMock } = bootClone();
    app.showToast = vi.fn();
    (doc.getElementById('cloneCustomPathToggle') as HTMLInputElement).checked = true;
    set('cloneCasePath', '/mnt/projects');
    set('cloneCaseName', '');
    app.updateCloneCasePathPreview();
    expect(app._cloneTargetPath()).toBe('');
    expect(preview()).toBe(
      'Pick the folder the repository should be cloned inside. It goes into a subfolder named after the case.'
    );
    await app.cloneCase();
    expect(app.showToast).toHaveBeenCalledWith('Please enter a case name', 'error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes the preview when the preflight replaces the case name', () => {
    const { app, doc, set } = bootClone();
    set('cloneRepoUrl', 'https://github.com/opticon454/bifrost?tab=readme-ov-file');
    set('cloneCaseName', 'bifrost-tab-readme-ov-file');
    set('cloneCasePath', '/mnt/projects');
    app.updateCloneCasePathPreview();
    expect(doc.getElementById('cloneCasePathPreview')?.textContent).toBe(
      'Will clone into: /mnt/projects/bifrost-tab-readme-ov-file'
    );
    app._applyClonePreflight({ gitAvailable: true, parse: { cloneable: true, suggestedName: 'bifrost' } }, '');
    expect((doc.getElementById('cloneCaseName') as HTMLInputElement).value).toBe('bifrost');
    expect(doc.getElementById('cloneCasePathPreview')?.textContent).toBe('Will clone into: /mnt/projects/bifrost');
  });

  it('previews the name taken from the URL as it is typed', () => {
    const { app, doc, set, win } = bootClone();
    app.isCliAvailable = () => true; // lives in settings-ui.js, which this test does not load
    set('cloneCaseName', '');
    set('cloneCasePath', '/mnt/projects');
    set('cloneRepoUrl', 'https://github.com/opticon454/bifrost');
    app.onCloneUrlInput();
    win.clearTimeout(app._clonePreflightTimer);
    expect((doc.getElementById('cloneCaseName') as HTMLInputElement).value).toBe('bifrost');
    expect(doc.getElementById('cloneCasePathPreview')?.textContent).toBe('Will clone into: /mnt/projects/bifrost');
  });
});
