/**
 * @fileoverview A browser write to settings.json that did not land must not say it did.
 *
 * PUT /api/settings can fail for reasons other than the two refusals the page already handles
 * (the multi-user admin-only 403 FORBIDDEN and the tunnel's no-password 403): a 409 CONFLICT when
 * settings.json does not parse (settings-writer.ts refuses to overwrite it), a 400, a 500, or a
 * dropped connection, which `_apiPut` answers with null instead of throwing. Each of those used
 * to end the App Settings save with "Settings saved" and a closed modal, and the run mode and
 * respawn preset writes failed with no word at all. Now:
 *  - App Settings: a warning that carries the server's reason (else its HTTP status, else that the
 *    server could not be reached), the modal stays open, and nothing that assumes the server saved
 *    runs (Apply's refresh, the tunnel-starting toast, the gesture reload). A save with the tunnel
 *    switch on is no longer read as a tunnel refusal unless the server said 403.
 *  - Run mode and respawn presets: the same warning, naming what was not saved; they stay saved on
 *    this device as before.
 *  - The success path and both 403 paths are unchanged.
 *  - The new toasts read in Chinese under zh-CN.
 *
 * The real modules run inside a JSDOM window with the real index.html (the App Settings save) or a
 * vm context (the background writes); `_apiPut` is the real api-client.js, and only `fetch` is
 * mocked. Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
const INDEX = read('index.html');
const I18N = read('i18n.js');
const SETTINGS_UI = read('settings-ui.js');
const SESSION_UI = read('session-ui.js');
const RESPAWN_UI = read('respawn-ui.js');
const API_CLIENT = read('api-client.js');

const DESKTOP_KEY = 'codeman-app-settings';
type Settings = Record<string, unknown>;

/** What settings-writer.ts answers (409 CONFLICT) when settings.json does not parse. */
const TORN =
  '/home/u/.codeman/settings.json is not a valid JSON object, so this change was not saved (saving would have replaced every other setting in it). Fix or delete the file, or restore it from a config backup, then try again.';
const INVALID = 'Invalid settings: codexModel: Invalid string';

/** A fetch answer: a JSON envelope, or a body that is not JSON (`body: null`). */
type Answer = { status: number; body: Settings | null } | 'unreachable';
const envelope = (status: number, error: string, errorCode: string): Answer => ({
  status,
  body: { success: false, error, errorCode },
});
const OK: Answer = { status: 200, body: { success: true, data: {} } };
const CONFLICT = envelope(409, TORN, 'CONFLICT');
const BAD_REQUEST = envelope(400, INVALID, 'INVALID_INPUT');
const SERVER_ERROR: Answer = { status: 500, body: null };
const FORBIDDEN = envelope(403, 'You do not have permission', 'FORBIDDEN');

function respond(answer: Answer) {
  if (answer === 'unreachable') return Promise.reject(new TypeError('Failed to fetch'));
  const make = (): any => ({
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    json: async () => {
      if (answer.body === null) throw new SyntaxError('Unexpected token < in JSON');
      return answer.body;
    },
    clone: make,
  });
  return Promise.resolve(make());
}

const warning = (text: string) => [text, 'warning', { duration: 0 }];
const errorToast = (text: string) => [text, 'error', { duration: 0 }];

const windows: { close(): void }[] = [];
afterEach(() => {
  for (const win of windows.splice(0)) win.close();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Methods that run for real; every other prototype method is a no-op (panels this file is not about). */
const REAL = new Set([
  'openAppSettings',
  'saveAppSettings',
  'applyAppSettings',
  'loadAppSettingsFromServer',
  'loadAppSettingsFromStorage',
  'saveAppSettingsToStorage',
  'getSettingsStorageKey',
  'getDefaultSettings',
  'tabCliLogosEnabled',
  'resolveTabArrangement',
  'resolveTabStateOrder',
  'resolveHeaderStatsStyle',
  'resolveSessionSidebarFontSize',
  'planUsageChipEnabled',
  'planUsageCollectionFlip',
  'loadModelConfigForSettings',
  'saveModelConfigFromSettings',
  '_modelConfigFromSettingsForm',
  '_settingsReadOnly',
  '_captureSettingsFormBaseline',
  '_keepServerSyncedSettings',
  '_displaySettingKeySet',
  '_noteSettingsWriteRefusal',
  '_settingsWriteError',
  '_confirmTunnelEnable',
  '_handleTunnelEnableRefusal',
  '_abandonTunnelEnable',
  '_askUnauthTunnel',
  '_webhookPending',
  '_api',
  '_apiPut',
]);
const ELSEWHERE = [
  '_updateLocalEchoState',
  'renderProjectInsightsPanel',
  'updateSubagentWindowVisibility',
  'showWelcome',
];

/**
 * Boot index.html with the real modules, signed in as a single-user admin. `put` is what
 * PUT /api/settings answers; `tunnelStatus` what GET /api/tunnel/status answers.
 */
async function boot(
  put: Answer | Answer[],
  tunnelStatus: Answer = { status: 200, body: { success: true, data: {} } },
  confirmAnswer = false
) {
  const putAnswers = Array.isArray(put) ? [...put] : null;
  const dom = new JSDOM(INDEX, { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window as unknown as Window &
    typeof globalThis & { eval(src: string): void; __App: any; __codemanUser: Settings; fetch: unknown };
  windows.push(win);
  if (win.document.readyState !== 'complete') await new Promise((resolve) => win.addEventListener('load', resolve));
  win.setInterval = (() => 0) as unknown as typeof win.setInterval;
  win.confirm = vi.fn(() => confirmAnswer);
  win.localStorage.setItem(DESKTOP_KEY, JSON.stringify({}));
  const fetchCalls: { url: string; method: string; body?: string }[] = [];
  win.fetch = vi.fn((url: string, opts: { method?: string; body?: string } = {}) => {
    const method = opts.method || 'GET';
    fetchCalls.push({ url, method, body: opts.body });
    if (url === '/api/settings' && method === 'PUT') return respond(putAnswers ? putAnswers.shift()! : (put as Answer));
    if (url === '/api/tunnel/status') return respond(tunnelStatus);
    if (url === '/api/execution/model-config' && method === 'GET') {
      return respond({ status: 200, body: { success: true, data: { defaultModel: 'sonnet' } } });
    }
    return respond(OK);
  });
  win.eval(
    [
      `var MobileDetection = {
         getDeviceType: () => 'desktop',
         isHandheldDevice: () => false,
         isMobile: () => false,
         isTouchDevice: () => false,
       };
       var KeyboardHandler = {}, SwipeHandler = {}, DeepgramProvider = {}, NotificationManager = function () {};
       var KeyboardAccessoryBar = { setMode() {} };
       var VoiceInput = { _getDeepgramConfig: () => ({}), _saveDeepgramConfig() {}, refreshClaudeStatus: () => Promise.resolve() };
       var FocusTrap = function () { this.activate = () => {}; this.deactivate = () => {}; };
       var DEFAULT_VOICE_KEYTERMS = '';`,
      read('constants.js'),
      read('app.js'),
      SETTINGS_UI,
      API_CLIENT,
      'window.__App = CodemanApp;',
    ].join('\n')
  );
  win.__codemanUser = { username: 'admin', role: 'admin', multiUser: false };
  const target = Object.create(win.__App.prototype);
  target.sessions = new Map();
  target.sessionOrder = [];
  target.showToast = vi.fn();
  target.closeAppSettings = vi.fn();
  target._refreshSettingsAfterApply = vi.fn();
  const noop = () => undefined;
  for (const name of ELSEWHERE) target[name] = noop;
  const app = new Proxy(target, {
    get(t, key, receiver) {
      const value = Reflect.get(t, key, receiver);
      const stubbed =
        typeof key === 'string' && typeof value === 'function' && !Object.hasOwn(t, key) && !REAL.has(key);
      return stubbed ? noop : value;
    },
  }) as any;
  await app.loadAppSettingsFromServer(Promise.resolve({}));
  app.openAppSettings();
  await tick();
  await tick();
  const doc = win.document;
  const box = (id: string) => doc.getElementById(id) as HTMLInputElement;
  const storedBlob = () => JSON.parse(win.localStorage.getItem(DESKTOP_KEY) || '{}') as Settings;
  const settingsPuts = () => fetchCalls.filter((c) => c.url === '/api/settings' && c.method === 'PUT');
  return { app, target, box, storedBlob, settingsPuts };
}

describe('App Settings save whose settings PUT did not land', () => {
  const failures: [string, Answer, string][] = [
    ['409 CONFLICT (settings.json does not parse)', CONFLICT, TORN],
    ['400 INVALID_INPUT', BAD_REQUEST, INVALID],
    ['500 with a body that is not JSON', SERVER_ERROR, 'HTTP 500'],
    ['a dropped connection (_apiPut answers null)', 'unreachable', 'the server could not be reached'],
  ];

  for (const [name, put, reason] of failures) {
    it(`${name}: warns with the reason, keeps the modal open, keeps the change on this device`, async () => {
      const { app, target, box, storedBlob, settingsPuts } = await boot(put);
      box('appSettingsTabTwoRows').checked = true; // per-device
      box('appSettingsAutoNameSessions').checked = true; // synced
      target.showToast.mockClear();
      target.closeAppSettings.mockClear();

      await app.saveAppSettings();

      expect(settingsPuts()).toHaveLength(1);
      expect(target.showToast.mock.calls).toEqual([warning(`Saved on this device, not on the server: ${reason}`)]);
      expect(target.closeAppSettings).not.toHaveBeenCalled();
      expect(storedBlob().tabTwoRows).toBe(true);
      expect(storedBlob().autoNameSessions).toBe(true);
    });
  }

  it('Apply: the same warning, and the refresh that needs the saved flags does not run', async () => {
    const { app, target } = await boot(CONFLICT);
    target.showToast.mockClear();
    target._refreshSettingsAfterApply.mockClear();
    await app.applyAppSettings();
    expect(target.showToast.mock.calls).toEqual([warning(`Saved on this device, not on the server: ${TORN}`)]);
    expect(target._refreshSettingsAfterApply).not.toHaveBeenCalled();
    expect(target.closeAppSettings).not.toHaveBeenCalled();
  });

  it('with the tunnel switch on: not read as a tunnel refusal, no "Tunnel starting", the switch stays on', async () => {
    for (const put of [CONFLICT, 'unreachable'] as Answer[]) {
      const { app, target, box, storedBlob } = await boot(put, {
        status: 200,
        body: { success: true, data: { running: true, loginConfigured: true } },
      });
      box('appSettingsTunnelEnabled').checked = true;
      target.showToast.mockClear();
      target.closeAppSettings.mockClear();

      await app.saveAppSettings();

      const reason = put === 'unreachable' ? 'the server could not be reached' : TORN;
      expect(target.showToast.mock.calls, JSON.stringify(put)).toEqual([
        warning(`Saved on this device, not on the server: ${reason}`),
      ]);
      expect(target.closeAppSettings).not.toHaveBeenCalled();
      expect(box('appSettingsTunnelEnabled').checked).toBe(true);
      expect(storedBlob().tunnelEnabled).toBe(true);
    }
  });

  it('a gesture-control change does not reload the page as if the server had stored it', async () => {
    const { app, target, box } = await boot(CONFLICT);
    box('appSettingsGestureControl').checked = true;
    target.showToast.mockClear();
    await app.saveAppSettings();
    expect(target.showToast.mock.calls).toEqual([warning(`Saved on this device, not on the server: ${TORN}`)]);
  });

  it('a retried Save still sends the plan-usage flip and reloads for gesture control, once the server stores it', async () => {
    const { app, target, box, settingsPuts } = await boot([CONFLICT, OK]);
    box('appSettingsShowPlanUsageLimits').checked = false; // desktop default ON: a flip
    box('appSettingsGestureControl').checked = true;
    target.showToast.mockClear();
    await app.saveAppSettings();
    expect(target.showToast.mock.calls).toEqual([warning(`Saved on this device, not on the server: ${TORN}`)]);

    // The user fixes the file and presses Save again; the form still shows the same choices.
    target.showToast.mockClear();
    await app.saveAppSettings();
    const [first, second] = settingsPuts().map((p) => JSON.parse(p.body!));
    expect(first.showPlanUsageLimits).toBe(false);
    expect(second.showPlanUsageLimits).toBe(false);
    expect(target.showToast.mock.calls).toEqual([
      ['Settings saved', 'success'],
      ['Enabling gesture control — reloading…', 'info'],
    ]);
    expect(target.closeAppSettings).toHaveBeenCalledTimes(1);
  });
});

describe('App Settings save: the paths that already worked', () => {
  it('a saved PUT still says "Settings saved" and closes the modal', async () => {
    const { app, target, box } = await boot(OK);
    box('appSettingsAutoNameSessions').checked = true;
    target.showToast.mockClear();
    await app.saveAppSettings();
    expect(target.showToast.mock.calls).toEqual([['Settings saved', 'success']]);
    expect(target.closeAppSettings).toHaveBeenCalledTimes(1);
  });

  it('a 403 FORBIDDEN still ends with the one admin-only toast', async () => {
    const { app, target } = await boot(FORBIDDEN);
    target.showToast.mockClear();
    await app.saveAppSettings();
    expect(target.showToast.mock.calls).toEqual([
      ['Saved on this device. Server-wide settings can only be changed by an admin.', 'warning'],
    ]);
    expect(target.closeAppSettings).toHaveBeenCalledTimes(1);
    expect(app._settingsReadOnly()).toBe(true);
  });

  it("the tunnel's no-password 403 still goes to the tunnel prompt, and cancelling it turns the switch off", async () => {
    // GET /api/tunnel/status unreadable: the PUT goes out unacknowledged and the server refuses it.
    const { app, target, box, storedBlob } = await boot(
      envelope(403, 'Refusing to start a public tunnel with no login', 'OPERATION_FAILED'),
      'unreachable'
    );
    box('appSettingsTunnelEnabled').checked = true;
    target.showToast.mockClear();
    await app.saveAppSettings();
    expect(target.showToast.mock.calls).toEqual([['Tunnel not enabled', 'info']]);
    expect(target.closeAppSettings).toHaveBeenCalledTimes(1);
    expect(box('appSettingsTunnelEnabled').checked).toBe(false);
    expect(storedBlob().tunnelEnabled).toBe(false);
  });

  it('an accepted no-password retry sends the whole save again, so "Settings saved" is true', async () => {
    const { app, target, box, settingsPuts } = await boot(
      [envelope(403, 'Refusing to start a public tunnel with no login', 'OPERATION_FAILED'), OK],
      'unreachable',
      true
    );
    box('appSettingsTunnelEnabled').checked = true;
    box('appSettingsAutoNameSessions').checked = true;
    target.showToast.mockClear();
    await app.saveAppSettings();

    const [first, retry] = settingsPuts().map((p) => JSON.parse(p.body!));
    expect(settingsPuts()).toHaveLength(2);
    expect(first.autoNameSessions).toBe(true);
    expect(first.acknowledgeUnauthTunnel).toBeUndefined();
    expect(retry).toEqual({ ...first, acknowledgeUnauthTunnel: true });
    expect(target.showToast.mock.calls).toEqual([
      ['Public tunnel enabling — no password set ⚠️', 'warning'],
      ['Settings saved', 'success'],
      ['Tunnel starting — QR code will appear when ready...', 'info'],
    ]);
    expect(target.closeAppSettings).toHaveBeenCalledTimes(1);
  });

  it('Apply: an accepted retry refreshes the groups that read the saved flags', async () => {
    const { app, target, box } = await boot(
      [envelope(403, 'Refusing to start a public tunnel with no login', 'OPERATION_FAILED'), OK],
      'unreachable',
      true
    );
    box('appSettingsTunnelEnabled').checked = true;
    target.showToast.mockClear();
    await app.applyAppSettings();
    expect(target.showToast.mock.calls).toEqual([
      ['Public tunnel enabling — no password set ⚠️', 'warning'],
      ['Settings applied', 'success'],
      ['Tunnel starting — QR code will appear when ready...', 'info'],
    ]);
    expect(target._refreshSettingsAfterApply).toHaveBeenCalledTimes(1);
    expect(target.closeAppSettings).not.toHaveBeenCalled();
  });
});

// ─── Background writes (vm harness: settings-ui.js + session-ui.js + respawn-ui.js + api-client.js) ───

function loadBackground(put: Answer) {
  const storage = new Map<string, string>();
  const elements: Record<string, any> = {
    runModeMenu: { classList: { remove: () => {} } },
    runBtn: { className: '', nextElementSibling: { className: '' } },
    runBtnLabel: { textContent: '' },
    welcomeTunnelBtn: { classList: { contains: (c: string) => c === 'active' }, disabled: false },
  };
  const CodemanApp = function CodemanApp(this: any) {};
  const fetchMock = vi.fn((url: string, opts: { method?: string } = {}) =>
    url === '/api/settings' && opts.method === 'PUT' ? respond(put) : respond(OK)
  );
  const context = vm.createContext({
    CodemanApp,
    VoiceInput: {},
    window: { __codemanUser: { username: 'admin', role: 'admin', multiUser: false } },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    document: { getElementById: (id: string) => elements[id] ?? null, addEventListener: () => {} },
    fetch: fetchMock,
    console,
  });
  for (const [src, filename] of [
    [SETTINGS_UI, 'settings-ui.js'],
    [SESSION_UI, 'session-ui.js'],
    [RESPAWN_UI, 'respawn-ui.js'],
    [API_CLIENT, 'api-client.js'],
  ]) {
    vm.runInContext(src, context, { filename });
  }
  const app = new (CodemanApp as any)();
  app.showToast = vi.fn();
  app._dismissTunnelConnecting = vi.fn();
  app._updateWelcomeTunnelBtn = vi.fn();
  app.closeTunnelPanel = vi.fn();
  return { app, fetchMock, storage, elements };
}

/** Let the fire-and-forget PUT and its response handling settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

describe('the run mode and respawn preset writes', () => {
  const failures: [string, Answer, string][] = [
    ['409 CONFLICT', CONFLICT, TORN],
    ['500 with a body that is not JSON', SERVER_ERROR, 'HTTP 500'],
    ['a dropped connection', 'unreachable', 'the server could not be reached'],
  ];

  for (const [name, put, reason] of failures) {
    it(`${name}: run mode warns with the reason and stays on this device`, async () => {
      const b = loadBackground(put);
      b.app.setRunMode('codex');
      await settle();
      expect(b.fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT' }));
      expect(b.app.showToast.mock.calls).toEqual([
        warning(`Run mode saved on this device, not on the server: ${reason}`),
      ]);
      expect(b.storage.get('codeman_runMode')).toBe('codex');
    });

    it(`${name}: respawn presets warn with the reason and stay on this device`, async () => {
      const b = loadBackground(put);
      b.app.saveRespawnPresets([
        { id: 'builtin', builtIn: true },
        { id: 'mine', name: 'mine' },
      ]);
      await settle();
      expect(b.app.showToast.mock.calls).toEqual([
        warning(`Respawn presets saved on this device, not on the server: ${reason}`),
      ]);
      expect(JSON.parse(b.storage.get('codeman-respawn-presets')!)).toEqual([{ id: 'mine', name: 'mine' }]);
    });
  }

  it('a saved write says nothing', async () => {
    const b = loadBackground(OK);
    b.app.setRunMode('codex');
    b.app.saveRespawnPresets([{ id: 'mine' }]);
    await settle();
    expect(b.fetchMock).toHaveBeenCalledTimes(2);
    expect(b.app.showToast).not.toHaveBeenCalled();
  });

  it('a 403 FORBIDDEN stays the silent admin-only refusal that makes the page read-only', async () => {
    const b = loadBackground(FORBIDDEN);
    b.app.setRunMode('codex');
    await settle();
    expect(b.app.showToast).not.toHaveBeenCalled();
    expect(b.app._settingsReadOnly()).toBe(true);
  });
});

describe('stopping the tunnel (welcome screen and tunnel panel)', () => {
  it('a stop the server did not store says the tunnel was not stopped, and leaves it showing on', async () => {
    for (const put of [CONFLICT, SERVER_ERROR]) {
      const reason = put === CONFLICT ? TORN : 'HTTP 500';
      const welcome = loadBackground(put);
      await welcome.app.toggleTunnelFromWelcome();
      expect(welcome.app.showToast.mock.calls).toEqual([errorToast(`Tunnel not stopped: ${reason}`)]);
      expect(welcome.app._updateWelcomeTunnelBtn).not.toHaveBeenCalled();
      expect(welcome.app._dismissTunnelConnecting).not.toHaveBeenCalled();
      expect(welcome.elements.welcomeTunnelBtn.disabled).toBe(false);

      const panel = loadBackground(put);
      await panel.app._tunnelPanelToggle(false);
      expect(panel.app.showToast.mock.calls).toEqual([errorToast(`Tunnel not stopped: ${reason}`)]);
      expect(panel.app.closeTunnelPanel).toHaveBeenCalledTimes(1);
    }
  });

  it('a stored stop still says "Tunnel stopped"', async () => {
    const welcome = loadBackground(OK);
    await welcome.app.toggleTunnelFromWelcome();
    expect(welcome.app.showToast.mock.calls).toEqual([['Tunnel stopped', 'info']]);
    expect(welcome.app._updateWelcomeTunnelBtn).toHaveBeenCalledWith(false);

    const panel = loadBackground(OK);
    await panel.app._tunnelPanelToggle(false);
    expect(panel.app.showToast.mock.calls).toEqual([['Tunnel stopped', 'info']]);
    expect(panel.app.closeTunnelPanel).toHaveBeenCalledTimes(1);
  });
});

// ─── zh-CN ───

describe('the new toasts in zh-CN', () => {
  type Api = { t(s: string): string; configure(o: Record<string, string>): void };
  function translator(language: string) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    });
    windows.push(dom.window);
    vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
    const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
    api.configure({ language });
    return api;
  }

  it('translates each, keeps the reason as it came, and leaves English as it is', () => {
    const zh = translator('zh-CN');
    const en = translator('en');
    const cases: [string, string][] = [
      [`Saved on this device, not on the server: ${TORN}`, `已保存到本设备，但未保存到服务器：${TORN}`],
      [
        'Run mode saved on this device, not on the server: HTTP 500',
        '运行模式已保存到本设备，但未保存到服务器：HTTP 500',
      ],
      [
        'Respawn presets saved on this device, not on the server: the server could not be reached',
        '重生预设已保存到本设备，但未保存到服务器：无法连接到服务器',
      ],
      [
        'Saved on this device, not on the server: the server could not be reached',
        '已保存到本设备，但未保存到服务器：无法连接到服务器',
      ],
      [`Tunnel not stopped: ${TORN}`, `隧道未停止：${TORN}`],
    ];
    for (const [english, chinese] of cases) {
      expect(zh.t(english)).toBe(chinese);
      expect(en.t(english)).toBe(english);
    }
  });
});
