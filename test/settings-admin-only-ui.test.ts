/**
 * @fileoverview Multi-user mode: a NON-ADMIN's browser and the admin-only settings writes.
 *
 * In multi-user mode PUT /api/settings (and PUT /api/execution/model-config,
 * PUT /api/cases/order) answer 403 FORBIDDEN for a non-admin (system-routes.ts,
 * case-routes.ts), because settings.json is one file for the whole server. The page
 * must not break on that:
 *  - App Settings Save/Apply keeps saving the per-device keys to localStorage exactly
 *    as before, sends no settings PUT and no model-config PUT, keeps every SYNCED key
 *    at the server's value, and shows ONE "only an admin" toast, only when the user
 *    really changed a synced setting (an untouched synced key that no admin ever
 *    stored must not read as a change: that is what the form baseline is for).
 *  - The background writes (run mode, respawn presets, last used case, case order,
 *    the respawn-preset migration on load, the tunnel toggles) are not sent, and the
 *    non-admin's own run mode and respawn presets stay theirs on this device across a
 *    reload (the server's would otherwise overwrite them on every load).
 *  - A save sent before the role was known (/api/me slow or failed) that the server
 *    refuses with 403 FORBIDDEN ends like a known non-admin's: synced keys back to the
 *    server's value, the one admin toast (never "Settings saved"), read-only from then.
 *  - The display-key split does not depend on GET /api/settings having loaded.
 *  - Admins and single-user mode send everything as before.
 *  - Both toasts read in Chinese under zh-CN.
 *
 * The real modules run inside a JSDOM window (runScripts: 'outside-only') with the
 * real index.html, so the form is the real App Settings form. Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
const INDEX = read('index.html');
const I18N = read('i18n.js');
const SETTINGS_UI = read('settings-ui.js');
const SESSION_UI = read('session-ui.js');
const RESPAWN_UI = read('respawn-ui.js');
const SCRIPTS = [read('constants.js'), read('app.js'), SETTINGS_UI];

const DESKTOP_KEY = 'codeman-app-settings';
const SAVE_TOAST = 'Saved on this device. Server-wide settings can only be changed by an admin.';
const ADMIN_TOAST = 'Server-wide settings can only be changed by an admin';

type Settings = Record<string, unknown>;
type Who = 'non-admin' | 'admin' | 'single-user' | 'unknown';
/** `unknown`: GET /api/me has not answered yet, so admin-ui.js has set no identity. */
const IDENTITY: Record<Who, Settings | undefined> = {
  'non-admin': { username: 'bob', role: 'user', multiUser: true },
  admin: { username: 'root', role: 'admin', multiUser: true },
  'single-user': { username: 'admin', role: 'admin', multiUser: false },
  unknown: undefined,
};

/** What PUT /api/settings answers a non-admin in multi-user mode (system-routes.ts). */
const forbiddenResponse = () => {
  const res = {
    ok: false,
    status: 403,
    json: async () => ({ success: false, error: 'You do not have permission', errorCode: 'FORBIDDEN' }),
    clone: () => res,
  };
  return res;
};

/**
 * Methods that run for real. Every other method is a no-op: openAppSettings() and
 * saveAppSettings() fan out into panels (voice, webhook, tunnel, push, header) this
 * file is not about.
 */
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
  '_applyOwnSettings',
  '_readOwnSettings',
  '_ownSettingsKey',
]);

/** Methods the load/save paths call that other modules add to the prototype. */
const ELSEWHERE = [
  '_updateLocalEchoState',
  'renderProjectInsightsPanel',
  'updateSubagentWindowVisibility',
  'showWelcome',
  '_applyRunMode',
];

const windows: { close(): void }[] = [];
afterEach(() => {
  for (const win of windows.splice(0)) win.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Boot index.html with constants.js, app.js and settings-ui.js, as `who`, with `stored` as
 * this device's blob and `server` as GET /api/settings (merged in by the real loader, which
 * is also what publishes the display-key list the non-admin save reads).
 */
async function boot(who: Who, stored: Settings, server: Settings | null) {
  const dom = new JSDOM(INDEX, { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window as unknown as Window &
    typeof globalThis & { eval(src: string): void; __App: any; __codemanUser: Settings; fetch: unknown };
  windows.push(win);
  if (win.document.readyState !== 'complete') await new Promise((resolve) => win.addEventListener('load', resolve));
  win.setInterval = (() => 0) as unknown as typeof win.setInterval;
  win.localStorage.setItem(DESKTOP_KEY, JSON.stringify(stored));
  const fetchCalls: { url: string; method: string; body?: string }[] = [];
  win.fetch = vi.fn(async (url: string, opts: { method?: string; body?: string } = {}) => {
    fetchCalls.push({ url, method: opts.method || 'GET', body: opts.body });
    const data = url === '/api/execution/model-config' ? { defaultModel: 'sonnet', showRecommendations: true } : {};
    return { ok: true, status: 200, json: async () => ({ success: true, data }) };
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
      ...SCRIPTS,
      'window.__App = CodemanApp;',
    ].join('\n')
  );
  win.__codemanUser = IDENTITY[who] as Settings;
  const target = Object.create(win.__App.prototype);
  target.sessions = new Map();
  target.sessionOrder = [];
  target._apiPut = vi.fn(async () => ({ ok: true }));
  target.showToast = vi.fn();
  target.closeAppSettings = vi.fn();
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
  await app.loadAppSettingsFromServer(Promise.resolve(server));
  const doc = win.document;
  const box = (id: string) => doc.getElementById(id) as HTMLInputElement;
  const storedBlob = () => JSON.parse(win.localStorage.getItem(DESKTOP_KEY) || '{}') as Settings;
  const toasts = () => (target.showToast.mock.calls as unknown[][]).map((c) => c[0]);
  const puts = () => fetchCalls.filter((c) => c.method === 'PUT');
  return { win, doc, app, target, box, storedBlob, toasts, puts };
}

// What the server already holds for this instance: an admin has saved App Settings before.
const SERVER: Settings = { autoNameSessions: false, workspaceHooksEnabled: true, claudeMode: 'auto' };

describe('a non-admin in multi-user mode saving App Settings', () => {
  it('keeps the per-device keys, sends no PUT, keeps the synced key at the server value, and toasts once', async () => {
    const { app, target, box, storedBlob, toasts, puts } = await boot('non-admin', { ...SERVER }, SERVER);
    await open_(app);
    box('appSettingsTabTwoRows').checked = true; // per-device (displayKeys)
    box('appSettingsAutoNameSessions').checked = true; // synced, server-wide
    await app.saveAppSettings();

    expect(target._apiPut).not.toHaveBeenCalled();
    expect(puts()).toEqual([]);
    expect(storedBlob().tabTwoRows).toBe(true);
    expect(storedBlob().autoNameSessions).toBe(false);
    expect(toasts()).toEqual([SAVE_TOAST]);
  });

  it('says "Settings saved" (no admin toast) when only per-device keys changed', async () => {
    const { app, target, box, storedBlob, toasts, puts } = await boot('non-admin', { ...SERVER }, SERVER);
    await open_(app);
    box('appSettingsTabTwoRows').checked = true;
    await app.saveAppSettings();

    expect(target._apiPut).not.toHaveBeenCalled();
    expect(puts()).toEqual([]);
    expect(storedBlob().tabTwoRows).toBe(true);
    expect(toasts()).toEqual(['Settings saved']);
  });

  it('does not read untouched synced keys no admin ever stored as a change', async () => {
    // A fresh instance: the server holds nothing, so the blob has no synced keys while the
    // form shows their defaults. Comparing against the blob would toast on every save.
    const { app, box, storedBlob, toasts, puts } = await boot('non-admin', {}, {});
    await open_(app);
    box('appSettingsTabTwoRows').checked = true;
    await app.saveAppSettings();
    expect(toasts()).toEqual(['Settings saved']);
    expect(puts()).toEqual([]);
    // The synced keys the form read stay absent (the server default), never the form's copy.
    expect('autoNameSessions' in storedBlob()).toBe(false);
    expect('claudeMode' in storedBlob()).toBe(false);
    expect(storedBlob().tabTwoRows).toBe(true);

    // And a real change there still gets the one admin toast.
    await open_(app);
    box('appSettingsAutoNameSessions').checked = true;
    await app.saveAppSettings();
    expect(toasts()).toEqual(['Settings saved', SAVE_TOAST]);
    expect('autoNameSessions' in storedBlob()).toBe(false);
  });

  it('does not send the model config either, and folds a change to it into the same one toast', async () => {
    const { app, doc, toasts, puts } = await boot('non-admin', { ...SERVER }, SERVER);
    await open_(app);
    (doc.getElementById('appSettingsDefaultModel') as HTMLSelectElement).value = 'opus';
    await app.saveAppSettings();
    expect(puts()).toEqual([]);
    expect(toasts()).toEqual([SAVE_TOAST]);
  });

  it('Apply behaves the same: nothing sent, the modal stays open', async () => {
    const { app, target, box, toasts, puts } = await boot('non-admin', { ...SERVER }, SERVER);
    await open_(app);
    box('appSettingsAutoNameSessions').checked = true;
    await app.applyAppSettings();
    expect(target._apiPut).not.toHaveBeenCalled();
    expect(puts()).toEqual([]);
    expect(target.closeAppSettings).not.toHaveBeenCalled();
    expect(toasts()).toEqual([SAVE_TOAST]);
  });
});

describe('a save sent before the role was known, refused as admin-only', () => {
  it('ends like a known non-admin save: synced key kept at the server value, one admin toast', async () => {
    const { app, target, box, storedBlob, toasts, puts } = await boot('unknown', { ...SERVER }, SERVER);
    target._apiPut = vi.fn(async () => forbiddenResponse());
    await open_(app);
    box('appSettingsTabTwoRows').checked = true; // per-device
    box('appSettingsAutoNameSessions').checked = true; // synced
    await app.saveAppSettings();

    // The one PUT that went out before anything knew better, and nothing after it: the model
    // config is not sent, and "Settings saved" (the old answer to a 403) is never shown.
    expect(target._apiPut).toHaveBeenCalledTimes(1);
    expect(puts()).toEqual([]);
    expect(toasts()).toEqual([SAVE_TOAST]);
    expect(storedBlob().tabTwoRows).toBe(true);
    expect(storedBlob().autoNameSessions).toBe(false);

    // Read-only from here on: the next save sends nothing.
    expect(app._settingsReadOnly()).toBe(true);
    await open_(app);
    box('appSettingsAutoNameSessions').checked = true;
    await app.saveAppSettings();
    expect(target._apiPut).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([SAVE_TOAST, SAVE_TOAST]);
  });

  it('the same for a page whose /api/me failed (admin-ui.js falls back to a single-user admin)', async () => {
    const { app, target, box, storedBlob, toasts } = await boot('single-user', { ...SERVER }, SERVER);
    target._apiPut = vi.fn(async () => forbiddenResponse());
    await open_(app);
    box('appSettingsAutoNameSessions').checked = true;
    await app.saveAppSettings();
    expect(toasts()).toEqual([SAVE_TOAST]);
    expect(storedBlob().autoNameSessions).toBe(false);
  });

  it('is not confused with the tunnel no-password 403 (another errorCode): that still prompts', async () => {
    const { app, target } = await boot('admin', { ...SERVER }, SERVER);
    const res = {
      ok: false,
      status: 403,
      json: async () => ({ success: false, error: 'no password', errorCode: 'OPERATION_FAILED' }),
    };
    expect(await app._noteSettingsWriteRefusal({ ...res, clone: () => res })).toBe(false);
    expect(app._settingsReadOnly()).toBe(false);
    expect(target._settingsWriteForbidden).toBeUndefined();
  });
});

describe('a non-admin save when GET /api/settings failed at page load', () => {
  it('still keeps the synced keys at the stored value and toasts once', async () => {
    const { app, box, storedBlob, toasts, puts } = await boot('non-admin', { ...SERVER }, null);
    await open_(app);
    box('appSettingsTabTwoRows').checked = true;
    box('appSettingsAutoNameSessions').checked = true;
    await app.saveAppSettings();
    expect(puts()).toEqual([]);
    expect(storedBlob().tabTwoRows).toBe(true);
    expect(storedBlob().autoNameSessions).toBe(false);
    expect(toasts()).toEqual([SAVE_TOAST]);
  });
});

describe('an admin, and single-user mode, saving App Settings', () => {
  for (const who of ['admin', 'single-user'] as const) {
    it(`${who}: sends the settings PUT and the model config as before`, async () => {
      const { app, target, box, storedBlob, toasts, puts } = await boot(who, { ...SERVER }, SERVER);
      await open_(app);
      box('appSettingsAutoNameSessions').checked = true;
      await app.saveAppSettings();

      expect(target._apiPut).toHaveBeenCalledTimes(1);
      const [path, body] = target._apiPut.mock.calls[0] as [string, Settings];
      expect(path).toBe('/api/settings');
      expect(body.autoNameSessions).toBe(true);
      expect(SettingsUpdateSchema.safeParse(body).error?.issues ?? []).toEqual([]);
      expect(puts().map((p) => p.url)).toEqual(['/api/execution/model-config']);
      expect(storedBlob().autoNameSessions).toBe(true);
      expect(toasts()).toEqual(['Settings saved']);
    });
  }
});

/** Open App Settings and let its async model-config read land, as a user would. */
async function open_(app: { openAppSettings(): void }) {
  app.openAppSettings();
  await tick();
  await tick();
}

// ─── Background writes (vm harness: settings-ui.js + session-ui.js + respawn-ui.js) ───

function loadBackground(who: Who, storage = new Map<string, string>()) {
  const elements: Record<string, any> = {
    quickStartCase: { value: 'mine' },
    welcomeTunnelBtn: { classList: { contains: () => false }, disabled: false },
    runModeMenu: { classList: { remove: () => {} } },
    runBtn: { className: '', nextElementSibling: { className: '' } },
    runBtnLabel: { textContent: '' },
  };
  const CodemanApp = function CodemanApp(this: any) {};
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }));
  const confirmMock = vi.fn(() => true);
  const listeners: Record<string, (() => void)[]> = {};
  const win: Record<string, unknown> = { __codemanUser: IDENTITY[who] };
  const context = vm.createContext({
    CodemanApp,
    VoiceInput: {},
    window: win,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      addEventListener: (type: string, fn: () => void) => (listeners[type] ||= []).push(fn),
    },
    fetch: fetchMock,
    confirm: confirmMock,
    console,
  });
  vm.runInContext(SETTINGS_UI, context, { filename: 'settings-ui.js' });
  vm.runInContext(SESSION_UI, context, { filename: 'session-ui.js' });
  vm.runInContext(RESPAWN_UI, context, { filename: 'respawn-ui.js' });
  const app = new (CodemanApp as any)();
  app.loadAppSettingsFromStorage = () => ({});
  app.saveAppSettingsToStorage = () => {};
  app._apiPut = vi.fn(() => Promise.resolve({ ok: true }));
  app.showToast = vi.fn();
  app.loadQuickStartCases = vi.fn(async () => {});
  app.renderCaseManageList = vi.fn();
  app.closeTunnelPanel = vi.fn();
  app._showTunnelConnecting = vi.fn();
  app._pollTunnelStatus = vi.fn();
  app._dismissTunnelConnecting = vi.fn();
  app._updateWelcomeTunnelBtn = vi.fn();
  app._updateTunnelIndicator = vi.fn();
  win.app = app;
  /** What admin-ui.js does once GET /api/me answers. */
  const resolveMe = (identity: Settings) => {
    win.__codemanUser = identity;
    for (const fn of listeners['codeman:me'] || []) fn();
  };
  return { app, fetchMock, confirmMock, storage, resolveMe };
}

const settingsPuts = (b: ReturnType<typeof loadBackground>) => [
  ...b.app._apiPut.mock.calls.filter((c: unknown[]) => c[0] === '/api/settings'),
  ...b.fetchMock.mock.calls.filter((c: unknown[]) => c[0] === '/api/settings' || c[0] === '/api/cases/order'),
];

describe('background writes', () => {
  it('a non-admin sends none of them, and the device keeps its own copy', async () => {
    const b = loadBackground('non-admin');
    b.app.setRunMode('codex');
    expect(b.storage.get('codeman_runMode')).toBe('codex');
    b.app.saveRespawnPresets([{ id: 'p', name: 'mine' }]);
    expect(JSON.parse(b.storage.get('codeman-respawn-presets')!)).toEqual([{ id: 'p', name: 'mine' }]);
    await b.app.saveLastUsedCase('mine');
    await b.app.toggleTunnelFromWelcome();
    await b.app._tunnelPanelToggle(true);
    expect(settingsPuts(b)).toEqual([]);
    expect(b.app.showToast.mock.calls.map((c: unknown[]) => c[0])).toEqual([ADMIN_TOAST, ADMIN_TOAST]);
  });

  it('a non-admin case reorder is not sent: one toast, and the list goes back to the server order', async () => {
    const b = loadBackground('non-admin');
    await b.app.saveCaseOrder(['b', 'a']);
    expect(settingsPuts(b)).toEqual([]);
    expect(b.app.showToast.mock.calls.map((c: unknown[]) => c[0])).toEqual([ADMIN_TOAST]);
    expect(b.app.loadQuickStartCases).toHaveBeenCalledWith('mine');
    expect(b.app.renderCaseManageList).toHaveBeenCalled();
  });

  it('a non-admin never runs the respawn-preset migration PUT on page load', async () => {
    const b = loadBackground('non-admin');
    b.storage.set('codeman-respawn-presets', JSON.stringify([{ id: 'p' }]));
    await b.app.loadAppSettingsFromServer(Promise.resolve({ autoNameSessions: false }));
    expect(settingsPuts(b)).toEqual([]);
  });

  it('a 403 FORBIDDEN on a tunnel enable is the admin-only answer, not the no-password prompt', async () => {
    const b = loadBackground('admin');
    const refused = await b.app._handleTunnelEnableRefusal({
      ok: false,
      status: 403,
      json: async () => ({ success: false, error: 'You do not have permission', errorCode: 'FORBIDDEN' }),
    });
    expect(refused).toBe(true);
    expect(b.confirmMock).not.toHaveBeenCalled();
    expect(b.fetchMock).not.toHaveBeenCalled();
    expect(b.app.showToast.mock.calls.map((c: unknown[]) => c[0])).toEqual([ADMIN_TOAST]);
  });

  it("a non-admin's own run mode and respawn presets survive a reload over the server's", async () => {
    const before = loadBackground('non-admin');
    before.app.setRunMode('codex');
    before.app.saveRespawnPresets([{ id: 'mine', name: 'mine' }]);
    expect(settingsPuts(before)).toEqual([]);

    // The next page load, on the same device: the server holds an admin's picks.
    const after = loadBackground('non-admin', before.storage);
    await after.app.loadAppSettingsFromServer(
      Promise.resolve({ runMode: 'shell', respawnPresets: [{ id: 'admin', name: 'admin' }] })
    );
    expect(after.app.runMode).toBe('codex');
    expect(after.storage.get('codeman_runMode')).toBe('codex');
    // What loadRespawnPresets() reads before anything else (respawn-ui.js).
    expect(after.app._serverRespawnPresets).toEqual([{ id: 'mine', name: 'mine' }]);
    expect(JSON.parse(after.storage.get('codeman-respawn-presets')!)).toEqual([{ id: 'mine', name: 'mine' }]);
    expect(settingsPuts(after)).toEqual([]);
  });

  it('they win too when the role resolves only after the settings load (codeman:me)', async () => {
    const before = loadBackground('non-admin');
    before.app.setRunMode('codex');
    const after = loadBackground('unknown', before.storage);
    await after.app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'shell' }));
    expect(after.app.runMode).toBe('shell');
    after.resolveMe(IDENTITY['non-admin'] as Settings);
    expect(after.app.runMode).toBe('codex');
    expect(after.storage.get('codeman_runMode')).toBe('codex');
  });

  it("they are the user's own: another user, or an admin, on the same device gets the server's", async () => {
    const before = loadBackground('non-admin');
    before.app.setRunMode('codex');
    const other = loadBackground('unknown', before.storage);
    await other.app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'shell' }));
    other.resolveMe({ username: 'carol', role: 'user', multiUser: true });
    expect(other.app.runMode).toBe('shell');
    const admin = loadBackground('admin', before.storage);
    await admin.app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'shell' }));
    expect(admin.app.runMode).toBe('shell');
  });

  it('a background PUT refused as admin-only (role not known yet) makes the page read-only', async () => {
    const b = loadBackground('unknown');
    b.app._apiPut = vi.fn(() => Promise.resolve(forbiddenResponse()));
    b.app.setRunMode('codex');
    await tick();
    await tick();
    expect(b.app._settingsReadOnly()).toBe(true);
    b.app.saveRespawnPresets([{ id: 'p' }]);
    expect(b.app._apiPut).toHaveBeenCalledTimes(1);
  });

  for (const who of ['admin', 'single-user'] as const) {
    it(`${who}: every background write is still sent`, async () => {
      const b = loadBackground(who);
      b.app.setRunMode('codex');
      b.app.saveRespawnPresets([{ id: 'p' }]);
      await b.app.saveLastUsedCase('mine');
      await b.app.saveCaseOrder(['b', 'a']);
      expect(b.app._apiPut.mock.calls.map((c: unknown[]) => c[0])).toEqual(['/api/settings', '/api/settings']);
      expect(b.fetchMock.mock.calls.map((c: unknown[]) => c[0])).toEqual(['/api/settings', '/api/cases/order']);
      b.storage.set('codeman-respawn-presets', JSON.stringify([{ id: 'p' }]));
      b.app._apiPut.mockClear();
      await b.app.loadAppSettingsFromServer(Promise.resolve({}));
      expect(b.app._apiPut).toHaveBeenCalledWith('/api/settings', { respawnPresets: [{ id: 'p' }] });
    });
  }
});

// ─── zh-CN ───

describe('the admin-only toasts in zh-CN', () => {
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

  it('finds both toasts in the code that shows them', () => {
    expect(SETTINGS_UI).toContain(`this.showToast('${SAVE_TOAST}', 'warning')`);
    expect(SETTINGS_UI).toContain(`this.showToast('${ADMIN_TOAST}', 'warning')`);
    expect(SESSION_UI).toContain(`this.showToast('${ADMIN_TOAST}', 'warning')`);
  });

  it('translates both, and leaves English as it is', () => {
    const zh = translator('zh-CN');
    const en = translator('en');
    for (const text of [SAVE_TOAST, ADMIN_TOAST]) {
      const t = zh.t(text);
      expect(t, text).not.toBe(text);
      expect(/[A-Za-z]/.test(t), t).toBe(false);
      expect(en.t(text)).toBe(text);
    }
  });
});
