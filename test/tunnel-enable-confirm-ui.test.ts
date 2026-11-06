/**
 * @fileoverview Issue #706 browser confirmation policy through the real welcome, tunnel panel and App Settings entry points. HTTP and browser prompts are stubbed; settings and acknowledgement logic run unchanged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
const INDEX = read('index.html');
const SCRIPTS = ['constants.js', 'app.js', 'settings-ui.js', 'api-client.js'].map(read);
const STORAGE_KEY = 'codeman-app-settings';
const NO_LOGIN = { running: false, url: null, loginConfigured: false };
type Status = { running: boolean; url: string | null; loginConfigured?: boolean };
type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
type Entry = 'welcome' | 'panel' | 'save';
const windows: JSDOM[] = [];

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});

async function boot(
  status: Status = NO_LOGIN,
  accept = true,
  statusFailure?: 'reject' | 'non-ok',
  refuseFirstPut = false
) {
  const dom = new JSDOM(INDEX, { url: 'http://localhost/', runScripts: 'outside-only' });
  windows.push(dom);
  const win = dom.window;
  if (win.document.readyState !== 'complete') await new Promise((resolve) => win.addEventListener('load', resolve));
  // Keep status polling and unrelated rendering timers outside this user action.
  win.setTimeout = (() => 0) as unknown as typeof win.setTimeout;
  win.setInterval = (() => 0) as unknown as typeof win.setInterval;
  win.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tunnelEnabled: false }));
  const calls: Call[] = [];
  const order: string[] = [];
  const confirm = vi.fn(() => {
    order.push('confirm');
    return accept;
  });
  win.confirm = confirm;
  let putCount = 0;
  const response = (body: unknown, statusCode = 200) => ({
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    json: async () => body,
    clone: () => response(body, statusCode),
  });
  const fetch = vi.fn(async (url: string, opts: { method?: string; body?: string } = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body === undefined ? undefined : JSON.parse(opts.body) });
    order.push(`${method} ${url}`);
    if (url === '/api/tunnel/status' && method === 'GET') {
      if (statusFailure === 'reject') throw new Error('Status unavailable');
      // A failed HTTP response must not be trusted, even if its JSON resembles a status.
      return response(status, statusFailure === 'non-ok' ? 503 : 200);
    }
    if (url === '/api/settings' && method === 'PUT') {
      putCount++;
      if (refuseFirstPut && putCount === 1) {
        return response(
          { success: false, error: 'Tunnel acknowledgement required', errorCode: 'OPERATION_FAILED' },
          403
        );
      }
      return response({ success: true, data: {} });
    }
    if (url === '/api/execution/model-config' && method === 'PUT') return response({ success: true, data: {} });
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  Object.assign(win, { fetch });
  win.eval(
    [
      `var MobileDetection = {
      getDeviceType: () => 'desktop', isHandheldDevice: () => false,
      isMobile: () => false, isTouchDevice: () => false,
    };
    var KeyboardHandler = {}, SwipeHandler = {}, DeepgramProvider = {}, NotificationManager = function () {};
    var KeyboardAccessoryBar = { setMode() {} };
    var VoiceInput = { _getDeepgramConfig: () => ({}), _saveDeepgramConfig() {}, refreshClaudeStatus: () => Promise.resolve() };
    var FocusTrap = function () { this.activate = () => {}; this.deactivate = () => {}; };
    var DEFAULT_VOICE_KEYTERMS = '';`,
      ...SCRIPTS,
      'window.__App = CodemanApp;',
    ].join('\n')
  );
  // Only peripheral rendering is stubbed. All tunnel logic, settings reads/writes and HTTP helpers run for real.
  const app = Object.create((win as unknown as { __App: { prototype: object } }).__App.prototype);
  app.sessions = new Map();
  app.sessionOrder = [];
  for (const name of [
    'showToast',
    'closeAppSettings',
    '_updateLocalEchoState',
    'applyTerminalFontFamily',
    'applyTerminalFontWeights',
    '_syncPushPreferences',
    'applyHeaderVisibilitySettings',
    'applySkin',
    'applyLocalization',
    'applySessionListLayout',
    'applyTabOrientation',
    'applyLineageLineSettings',
    '_updateTokensImmediate',
    'applyMonitorVisibility',
    'renderApprovals',
    'renderProjectInsightsPanel',
    'updateSubagentWindowVisibility',
    '_updateCjkInputState',
    'showWelcome',
  ])
    app[name] = vi.fn();
  const box = win.document.getElementById('appSettingsTunnelEnabled') as HTMLInputElement;
  const button = win.document.getElementById('welcomeTunnelBtn') as HTMLButtonElement;
  // The welcome screen has finished its status-dependent reveal before the user clicks.
  button.style.display = '';
  const puts = () => calls.filter((call) => call.method === 'PUT' && call.url === '/api/settings');
  const events = () =>
    order.filter(
      (event) => event === 'confirm' || event.endsWith('/api/settings') || event.endsWith('/api/tunnel/status')
    );
  const stored = () => JSON.parse(win.localStorage.getItem(STORAGE_KEY) || '{}');
  const act = async (entry: Entry, enable = true) => {
    if (entry === 'save') box.checked = enable;
    if (entry === 'welcome') button.classList.toggle('active', !enable);
    vi.clearAllMocks();
    calls.length = 0;
    order.length = 0;
    if (entry === 'welcome') await app.toggleTunnelFromWelcome();
    if (entry === 'panel') await app._tunnelPanelToggle(enable);
    if (entry === 'save') await app.saveAppSettings();
  };
  return { act, puts, events, confirm, box, button, stored };
}

function expectEnablePut(calls: Call[], entry: Entry, acknowledge: boolean) {
  expect(calls).toHaveLength(1);
  const expected = { tunnelEnabled: true, ...(acknowledge ? { acknowledgeUnauthTunnel: true } : {}) };
  if (entry === 'save') {
    // The spec leaves the other App Settings fields unchanged.
    expect(calls[0].body).toMatchObject(expected);
    if (!acknowledge) expect(calls[0].body).not.toHaveProperty('acknowledgeUnauthTunnel');
  } else {
    expect(calls).toEqual([{ method: 'PUT', url: '/api/settings', body: expected }]);
  }
}

describe.each(['welcome', 'panel', 'save'] as const)('%s tunnel enable', (entry) => {
  it('confirms before a successful PUT and sends the acknowledgement', async () => {
    const h = await boot();
    await h.act(entry);
    expect.soft(h.confirm).toHaveBeenCalledTimes(1);
    expect.soft(h.events()).toEqual(['GET /api/tunnel/status', 'confirm', 'PUT /api/settings']);
    expectEnablePut(h.puts(), entry, true);
  });

  it('asks again on every enable attempt', async () => {
    const h = await boot();
    for (let attempt = 0; attempt < 2; attempt++) {
      await h.act(entry);
      expect.soft(h.confirm).toHaveBeenCalledTimes(1);
      expect.soft(h.events()).toEqual(['GET /api/tunnel/status', 'confirm', 'PUT /api/settings']);
    }
  });

  it('cancels without a PUT and leaves the tunnel off', async () => {
    const h = await boot(NO_LOGIN, false);
    await h.act(entry);
    expect.soft(h.confirm).toHaveBeenCalledTimes(1);
    expect.soft(h.puts()).toEqual([]);
    expect.soft(h.events()).toEqual(['GET /api/tunnel/status', 'confirm']);
    expect.soft(h.button.classList.contains('active')).toBe(false);
    expect.soft(h.button.disabled).toBe(false);
    expect.soft(h.button.style.display).not.toBe('none');
    expect.soft(h.box.disabled).toBe(false);
    expect.soft(h.box.checked).toBe(false);
    if (entry === 'save') expect.soft(h.stored().tunnelEnabled).toBe(false);
  });

  it('does not confirm or acknowledge when login is configured', async () => {
    const h = await boot({ ...NO_LOGIN, loginConfigured: true });
    await h.act(entry);
    expect(h.confirm).not.toHaveBeenCalled();
    expectEnablePut(h.puts(), entry, false);
  });

  it('does not confirm or acknowledge when loginConfigured is absent', async () => {
    const h = await boot({ running: false, url: null });
    await h.act(entry);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.events()).toEqual(['GET /api/tunnel/status', 'PUT /api/settings']);
    expectEnablePut(h.puts(), entry, false);
  });

  it.each(['reject', 'non-ok'] as const)('sends no acknowledgement when the status read is %s', async (failure) => {
    const h = await boot(NO_LOGIN, true, failure);
    await h.act(entry);
    expect(h.confirm).not.toHaveBeenCalled();
    expect.soft(h.events()).toEqual(['GET /api/tunnel/status', 'PUT /api/settings']);
    expectEnablePut(h.puts(), entry, false);
  });
});

it('save does not confirm or acknowledge an already running tunnel', async () => {
  const h = await boot({ running: true, url: 'https://test.trycloudflare.com', loginConfigured: false });
  await h.act('save');
  expect(h.confirm).not.toHaveBeenCalled();
  expectEnablePut(h.puts(), 'save', false);
});

it.each(['reject', 'non-ok'] as const)('welcome keeps the 403 fallback when the status read is %s', async (failure) => {
  const h = await boot(NO_LOGIN, true, failure, true);
  await h.act('welcome');
  expect.soft(h.confirm).toHaveBeenCalledTimes(1);
  expect.soft(h.events()).toEqual(['GET /api/tunnel/status', 'PUT /api/settings', 'confirm', 'PUT /api/settings']);
  expect(h.puts()).toEqual([
    { method: 'PUT', url: '/api/settings', body: { tunnelEnabled: true } },
    { method: 'PUT', url: '/api/settings', body: { tunnelEnabled: true, acknowledgeUnauthTunnel: true } },
  ]);
});

it.each(['welcome', 'panel'] as const)('%s disables without confirmation', async (entry) => {
  const h = await boot();
  await h.act(entry, false);
  expect(h.confirm).not.toHaveBeenCalled();
  expect(h.puts()).toEqual([{ method: 'PUT', url: '/api/settings', body: { tunnelEnabled: false } }]);
});
