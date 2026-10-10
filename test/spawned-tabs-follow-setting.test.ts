/**
 * The "Spawned tabs follow their parent" setting (`spawnedTabsFollowParent`).
 *
 * SYNCED and OFF by default: the server does the placement, so the value must
 * reach it (in SettingsUpdateSchema, never a per-device display key), and the
 * layout service reads it at every session creation. These tests read the real
 * schema, settings-ui.js, index.html, i18n.js, server.ts and the wiki.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const html = read('src/web/public/index.html');
const settingsUi = read('src/web/public/settings-ui.js');
const i18n = read('src/web/public/i18n.js');
const server = read('src/web/server.ts');
const wiki = read('docs/wiki/Settings-Reference.md');

const LABEL = 'Spawned Tabs Follow Their Parent';

describe('spawnedTabsFollowParent setting', () => {
  it('is a synced boolean in the settings schema', () => {
    expect(SettingsUpdateSchema.safeParse({ spawnedTabsFollowParent: true }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ spawnedTabsFollowParent: 'yes' }).success).toBe(false);
  });

  it('is not a per-device display key', () => {
    const start = settingsUi.indexOf('const displayKeys = new Set([');
    const block = settingsUi.slice(start, settingsUi.indexOf(']);', start));
    expect(start).toBeGreaterThan(-1);
    expect(block).not.toContain('spawnedTabsFollowParent');
  });

  it('has an unchecked switch in App Settings > Appearance > Tabs, marked synced', () => {
    const tabs = html.slice(html.indexOf('<h4>Tabs</h4><span class="set-scope">device</span>'));
    const group = tabs.slice(0, tabs.indexOf('</section>'));
    const row = group.match(
      /<div class="set-row"[^>]*id="appSettingsSpawnedTabsFollowParentItem"[\s\S]*?<\/label>/
    )?.[0];
    expect(row).toBeTruthy();
    expect(row).toContain(LABEL);
    expect(row).toContain('<span class="set-tag">synced</span>');
    expect(row).toMatch(/<input type="checkbox" id="appSettingsSpawnedTabsFollowParent">/);
  });

  it('loads as off unless explicitly true, and saves from the switch', () => {
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsSpawnedTabsFollowParent').checked = settings.spawnedTabsFollowParent === true;"
    );
    expect(settingsUi).toContain(
      "spawnedTabsFollowParent: document.getElementById('appSettingsSpawnedTabsFollowParent').checked,"
    );
  });

  it('is read fresh by the layout service at creation time', () => {
    expect(server).toMatch(
      /childrenFollowParent: async \(\) => \(await this\.readSettings\(true\)\)\.spawnedTabsFollowParent === true/
    );
  });

  it('has a zh-CN label and a wiki row', () => {
    expect(i18n).toMatch(new RegExp(`'${LABEL}': '[^']+'`));
    expect(wiki).toMatch(new RegExp(`\\| ${LABEL}\\s+\\|[^\\n]*Synced, off by default`));
  });
});
