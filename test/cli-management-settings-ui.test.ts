// Port: none (drives the real settings-ui.js in a vm context — no browser, no server).
//
// The CLI-management rows in App Settings (docs/cli-enable-disable-plan.md, Phase 6).
// Installing runs a command on the server, so it must never happen on a single click:
// the #343 review asked for auto-install to sit "behind an explicit confirm, or off".
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

function loadSettingsUi(confirmAnswer: boolean) {
  const CodemanApp = function CodemanApp(this: any) {};
  const rows = { innerHTML: '' };
  const confirm = vi.fn(() => confirmAnswer);
  const context = vm.createContext({
    CodemanApp,
    console,
    confirm,
    window: {},
    MobileDetection: { getDeviceType: () => 'desktop', isTouchDevice: () => false, isHandheldDevice: () => false },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      getElementById: (id: string) => (id === 'cliListRows' ? rows : null),
      createElement: () => ({ style: {}, dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
      createElementNS: () => ({ style: {}, dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
      querySelector: () => null,
    },
  });
  for (const file of ['constants.js', 'settings-ui.js']) {
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  }
  const app = new (CodemanApp as any)();
  app._api = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
  app.showToast = vi.fn();
  app.loadCliListForSettings = vi.fn(async () => {});
  return { app, confirm, rows };
}

const GROK = {
  id: 'grok',
  label: 'Grok',
  shortBadge: 'GK',
  stock: true,
  installed: false,
  enabled: true,
  installCommand: 'curl -fsSL https://x.ai/cli/install.sh | bash',
};

describe('CLI management: install confirmation', () => {
  it('runs nothing when the confirm is declined', async () => {
    const { app, confirm } = loadSettingsUi(false);
    app._cliList = [GROK];
    await app.installCliEntry('grok');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(app._api).not.toHaveBeenCalled();
  });

  it('names the exact command in the confirm, then installs on accept', async () => {
    const { app, confirm } = loadSettingsUi(true);
    app._cliList = [GROK];
    await app.installCliEntry('grok');
    expect(confirm.mock.calls[0][0]).toContain(GROK.installCommand);
    expect(app._api).toHaveBeenCalledWith('/api/clis/grok/install', { method: 'POST' });
  });
});

describe('CLI management: list rendering', () => {
  it('lists installed CLIs first, each group alphabetical, and gives shell no switch', () => {
    const { app, rows } = loadSettingsUi(true);
    app._cliList = [
      { id: 'pi', label: 'Pi', shortBadge: 'PI', stock: true, installed: false, enabled: true },
      { id: 'shell', label: 'Shell', shortBadge: 'SH', stock: true, installed: true, enabled: true },
      { id: 'codex', label: 'Codex', shortBadge: 'CX', stock: true, installed: true, enabled: true },
      { id: 'grok', label: 'Grok', shortBadge: 'GK', stock: true, installed: false, enabled: true },
    ];
    app.renderCliList();
    const order = [...rows.innerHTML.matchAll(/data-cli-id="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['codex', 'shell', 'grok', 'pi']);

    const shellRow = rows.innerHTML.split('data-cli-id="shell"')[1].split('data-cli-id=')[0];
    expect(shellRow).toContain('Always available');
    expect(shellRow).not.toContain('type="checkbox"');
    const codexRow = rows.innerHTML.split('data-cli-id="codex"')[1].split('data-cli-id=')[0];
    expect(codexRow).toContain('type="checkbox"');
  });
});
