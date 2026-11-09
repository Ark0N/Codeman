/**
 * @fileoverview The Codeman Agent Skill switch (`agentSkillEnabled`) in App Settings,
 * on by default since 1.50.0.
 *
 * What is pinned, and why it matters:
 *  - The REAL openAppSettings() reads an ABSENT key as on, like the server's
 *    getAgentSkillEnabled() (`!== false`). The page and the server must agree: a
 *    page that showed an absent key as off would write `false` on the next Save of
 *    any other setting, and the default would be gone without the user touching it.
 *  - Only an explicit false shows the switch off, wherever it came from (this
 *    device's blob or the server's settings.json, merged as a synced key).
 *  - saveAppSettings() sends the switch in the settings PUT, and the body passes the
 *    .strict() SettingsUpdateSchema (an undeclared key 400s every save).
 *  - A device that saved on 1.49.0 or earlier keeps `false` in its own blob. After the
 *    server's one-time boot migration (stored true) its switch shows on and a Save keeps it
 *    on; on a server without the key the device's copy is dropped for the default; a later
 *    explicit off on the server stays off. The Save body never carries the migration marker.
 *  - The row says it is on by default, that the copy stays out of git, and how to
 *    remove copies already written (turning it off sweeps nothing).
 *
 * The real modules run INSIDE a JSDOM window (runScripts: 'outside-only'), with the
 * harness of test/tab-cli-logos-setting.test.ts.
 *
 * Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
const INDEX = read('index.html');
const SCRIPTS = ['constants.js', 'app.js', 'settings-ui.js'].map(read);

const DESKTOP_KEY = 'codeman-app-settings';

type Settings = Record<string, unknown>;
interface SettingsApp {
  openAppSettings(): void;
  saveAppSettings(): Promise<void>;
  loadAppSettingsFromServer(p: Promise<Settings>): Promise<Settings>;
  _apiPut: ReturnType<typeof vi.fn>;
}

/** Methods that run for real; every other method of the app is a no-op here. */
const REAL = new Set([
  'openAppSettings',
  'saveAppSettings',
  'loadAppSettingsFromServer',
  'loadAppSettingsFromStorage',
  'saveAppSettingsToStorage',
  'getSettingsStorageKey',
  'getDefaultSettings',
  'resolveTabArrangement',
  'resolveTabStateOrder',
  // Real so the save builds the body a browser would send (the schema check).
  'resolveHeaderStatsStyle',
  'resolveSessionSidebarFontSize',
  '_displaySettingKeySet',
]);

/** Methods the load/save paths call that other modules add to the prototype. */
const ELSEWHERE = [
  'showToast',
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

/** The whole index.html with constants.js, app.js and settings-ui.js loaded into it. */
async function boot(stored?: Settings) {
  const dom = new JSDOM(INDEX, { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window as unknown as Window & typeof globalThis & { eval(src: string): void; __App: any };
  windows.push(win);
  // After load, so app.js's DOMContentLoaded boot never runs; only the prototype is under test.
  if (win.document.readyState !== 'complete') await new Promise((resolve) => win.addEventListener('load', resolve));
  win.setInterval = (() => 0) as unknown as typeof win.setInterval;
  if (stored) win.localStorage.setItem(DESKTOP_KEY, JSON.stringify(stored));
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
       var VoiceInput = { SILENCE_TIMEOUT_SECONDS: [0, 3, 6, 15, 30], _getDeepgramConfig: () => ({}), _saveDeepgramConfig() {}, refreshClaudeStatus: () => Promise.resolve() };
       var FocusTrap = function () { this.activate = () => {}; this.deactivate = () => {}; };
       var DEFAULT_VOICE_KEYTERMS = '';`,
      ...SCRIPTS,
      'window.__App = CodemanApp;',
    ].join('\n')
  );
  const target = Object.create(win.__App.prototype);
  target.sessions = new Map();
  target.sessionOrder = [];
  target._apiPut = vi.fn(async () => ({ ok: true }));
  const noop = () => undefined;
  for (const name of ELSEWHERE) target[name] = noop;
  const app = new Proxy(target, {
    get(t, key, receiver) {
      const value = Reflect.get(t, key, receiver);
      const stubbed =
        typeof key === 'string' && typeof value === 'function' && !Object.hasOwn(t, key) && !REAL.has(key);
      return stubbed ? noop : value;
    },
  }) as SettingsApp;
  const checkbox = () => win.document.getElementById('appSettingsAgentSkill') as HTMLInputElement;
  const putBody = () => {
    const calls = app._apiPut.mock.calls as [string, Settings][];
    const call = calls.find(([path]) => path === '/api/settings');
    expect(call, 'a settings PUT').toBeDefined();
    return call![1];
  };
  return { app, checkbox, putBody };
}

describe('the switch loads on by default', () => {
  it('an absent key shows on, an explicit false off, an explicit true on', async () => {
    for (const [stored, expected] of [
      [{}, true],
      [{ agentSkillEnabled: false }, false],
      [{ agentSkillEnabled: true }, true],
    ] as const) {
      const { app, checkbox } = await boot(stored);
      checkbox().checked = !expected;
      app.openAppSettings();
      expect(checkbox().checked, JSON.stringify(stored)).toBe(expected);
    }
  });

  it('a fresh device on a server with no stored value shows on', async () => {
    const { app, checkbox } = await boot();
    await app.loadAppSettingsFromServer(Promise.resolve({ lastUsedCase: 'demo' }));
    checkbox().checked = false;
    app.openAppSettings();
    expect(checkbox().checked).toBe(true);
  });

  it("the server's explicit false wins over this device's blob (a synced key)", async () => {
    const { app, checkbox } = await boot({ agentSkillEnabled: true });
    await app.loadAppSettingsFromServer(Promise.resolve({ agentSkillEnabled: false }));
    app.openAppSettings();
    expect(checkbox().checked).toBe(false);
  });
});

describe('Save', () => {
  it('saving other settings on a never-touched install keeps it on, and the body passes the schema', async () => {
    const { app, putBody } = await boot({});
    app.openAppSettings();
    await app.saveAppSettings();
    const body = putBody();
    expect(body.agentSkillEnabled).toBe(true);
    // The whole body, not just this key: an undeclared key 400s every save.
    expect(SettingsUpdateSchema.safeParse(body).error?.issues ?? []).toEqual([]);
  });

  it('switching it off sends an explicit false', async () => {
    const { app, checkbox, putBody } = await boot({});
    app.openAppSettings();
    checkbox().checked = false;
    await app.saveAppSettings();
    expect(putBody().agentSkillEnabled).toBe(false);
  });
});

// Every device that saved App Settings on 1.49.0 or earlier holds `agentSkillEnabled: false` in
// its own blob (the switch loaded an absent key as off). The server's boot migration
// (src/web/agent-skill-default-migration.ts) switches a stored false on by storing TRUE, because
// the merge only overwrites a synced key the server has: a key it deleted would leave the
// device's false in place, and the next Save would write it back.
describe('a device that saved before 1.50.0', () => {
  const OLD_BLOB = { agentSkillEnabled: false, autoNameSessions: false };

  it("after the server's migration (stored true) the switch shows on, and a Save keeps it on and passes the schema", async () => {
    const { app, checkbox, putBody } = await boot(OLD_BLOB);
    await app.loadAppSettingsFromServer(Promise.resolve({ agentSkillEnabled: true, lastUsedCase: 'demo' }));
    app.openAppSettings();
    expect(checkbox().checked).toBe(true);
    await app.saveAppSettings();
    const body = putBody();
    expect(body.agentSkillEnabled).toBe(true);
    // The migration's marker is a file of its own, never a setting: the Save can neither send it
    // back nor be refused for it by the .strict() schema.
    expect(Object.keys(body).filter((key) => /migrat/i.test(key))).toEqual([]);
    expect(SettingsUpdateSchema.safeParse(body).error?.issues ?? []).toEqual([]);
  });

  it('on a server without the key (a save that never reached it) the switch shows the default, on', async () => {
    const { app, checkbox, putBody } = await boot(OLD_BLOB);
    await app.loadAppSettingsFromServer(Promise.resolve({ lastUsedCase: 'demo' }));
    app.openAppSettings();
    expect(checkbox().checked).toBe(true);
    await app.saveAppSettings();
    expect(putBody().agentSkillEnabled).toBe(true);
  });

  it('an off the user saved after the migration stays off on every device', async () => {
    const { app, checkbox, putBody } = await boot({ agentSkillEnabled: true });
    await app.loadAppSettingsFromServer(Promise.resolve({ agentSkillEnabled: false }));
    app.openAppSettings();
    expect(checkbox().checked).toBe(false);
    await app.saveAppSettings();
    expect(putBody().agentSkillEnabled).toBe(false);
  });

  it('without a server answer the device keeps what it has', async () => {
    const { app, checkbox } = await boot(OLD_BLOB);
    await app.loadAppSettingsFromServer(Promise.resolve(null as unknown as Settings));
    app.openAppSettings();
    expect(checkbox().checked).toBe(false);
  });
});

describe('the App Settings row', () => {
  const doc = new JSDOM(INDEX).window.document;
  const row = doc.getElementById('appSettingsAgentSkill')!.closest('.set-row') as HTMLElement;
  const desc = row.querySelector('.set-row-desc')!.textContent!;

  it('is a synced switch', () => {
    expect((doc.getElementById('appSettingsAgentSkill') as HTMLInputElement).type).toBe('checkbox');
    expect(row.closest('.set-group')!.querySelector('.set-scope')!.textContent).toBe('synced');
  });

  it('says it is on by default, that git does not list the copy, and how to remove copies', () => {
    expect(desc).toContain('On by default');
    expect(desc).toContain('ignores itself in git');
    expect(desc).toContain('codeman skill uninstall --case <name>');
  });
});
