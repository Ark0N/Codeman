/**
 * @fileoverview Frontend test for Clone Repo's custom folder (session-ui.js `cloneCase()` /
 * `_cloneTargetPath()`): the chosen folder is the PARENT, so the clone request carries
 * `<folder>/<case name>` exactly as Create New does, and without the checkbox no `path` is sent
 * (the server then clones to `~/codeman-cases/<name>`). Runs against the real index.html markup.
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
  return { app, doc, set, fetchMock, win };
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
