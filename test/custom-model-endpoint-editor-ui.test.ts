/**
 * @fileoverview Frontend test for the Custom Model Endpoint editor's endpoint type
 * dropdown (settings-ui.js `openCustomModelHostEditor()` / `saveCustomModelHostFromEditor()`):
 * the saved `endpointType` reaches the request body, and a legacy host (no field) saves
 * as `openai`. Same JSDOM approach as custom-model-run-menu-ui.test.ts.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const CONSTANTS_JS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const SETTINGS_UI_JS = readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf-8');

function bootEditor(hosts: unknown[]) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <div id="customModelHostsList"></div>
      <div id="customModelHostEditor" style="display:none">
        <h4 id="customModelHostEditorTitle"></h4>
        <input id="customModelHostId">
        <input id="customModelHostLabel">
        <input id="customModelHostBaseUrl">
        <input id="customModelHostApiKey">
        <select id="customModelHostAuthStyle"><option value="bearer">bearer</option><option value="api-key">api-key</option></select>
        <input id="customModelHostDefaultContextLength">
        <select id="customModelHostEndpointType"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select>
        <select id="customModelHostDefaultModel"></select>
      </div>
    </body>`,
    { url: 'http://localhost/', runScripts: 'dangerously' }
  );
  const win = dom.window as unknown as Window & typeof globalThis & { CodemanApp: new () => any };
  const run = (src: string) => (win as unknown as { eval: (s: string) => void }).eval(src);
  run('window.CodemanApp = function CodemanApp() {};');
  run(CONSTANTS_JS);
  run(SETTINGS_UI_JS);
  const app = new win.CodemanApp();
  app._customModelHosts = hosts;
  app.showToast = () => {};
  app.loadCustomModelEndpointsForSettings = async () => {};
  const fetchMock = vi.fn(async () => ({ json: async () => ({ success: true }) }));
  (win as unknown as { fetch: unknown }).fetch = fetchMock;
  return { app, fetchMock, doc: win.document };
}

async function saveBody(hostId: string, hosts: unknown[]) {
  const { app, fetchMock } = bootEditor(hosts);
  app.openCustomModelHostEditor(hostId);
  await app.saveCustomModelHostFromEditor();
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
  return { url, method: init.method, body: JSON.parse(init.body) };
}

describe('custom model endpoint editor: endpoint type', () => {
  it('shows and saves an Anthropic-type host as anthropic', async () => {
    const hosts = [{ id: 'gw', label: 'Gateway', baseUrl: 'http://gw', endpointType: 'anthropic', models: ['m1'] }];
    const { app, doc } = bootEditor(hosts);
    app.openCustomModelHostEditor('gw');
    expect((doc.getElementById('customModelHostEndpointType') as HTMLSelectElement).value).toBe('anthropic');

    const saved = await saveBody('gw', hosts);
    expect(saved.method).toBe('PUT');
    expect(saved.url).toBe('/api/model-endpoints/gw');
    expect(saved.body.endpointType).toBe('anthropic');
  });

  it('opens a legacy host (no endpointType) as openai and saves it as openai', async () => {
    const hosts = [{ id: 'old', label: 'Old', baseUrl: 'http://old' }];
    const { app, doc } = bootEditor(hosts);
    app.openCustomModelHostEditor('old');
    expect((doc.getElementById('customModelHostEndpointType') as HTMLSelectElement).value).toBe('openai');

    const saved = await saveBody('old', hosts);
    expect(saved.body.endpointType).toBe('openai');
  });
});

describe('custom model endpoint list: endpoint type marker', () => {
  it('marks an Anthropic-type host and leaves a legacy host unmarked', () => {
    const hosts = [
      { id: 'gw', label: 'Gateway', baseUrl: 'http://gw', endpointType: 'anthropic' },
      { id: 'old', label: 'Old', baseUrl: 'http://old' },
    ];
    const { app, doc } = bootEditor(hosts);
    app.renderCustomModelHostsList();
    const desc = (id: string) => doc.querySelector(`[data-endpoint-id="${id}"] .set-row-desc`)?.textContent ?? '';
    expect(desc('gw')).toContain('Anthropic (Claude Code only)');
    expect(desc('old')).not.toContain('Anthropic');
  });
});

describe('real index.html endpoint type select', () => {
  it('has the id the editor reads, with both option values', () => {
    const html = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
    const doc = new JSDOM(html).window.document;
    const select = doc.getElementById('customModelHostEndpointType');
    expect(select?.tagName).toBe('SELECT');
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual(['openai', 'anthropic']);
  });
});
