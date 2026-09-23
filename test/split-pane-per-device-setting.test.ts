// test/split-pane-per-device-setting.test.ts
// Port: none (pure static analysis — runs in CI, no browser/server).
//
// Regression guard for the review finding that landed the blocker: moving
// showSplitButton into settings-ui.js's per-device `displayKeys` set is only
// HALF of making a setting per-device. The other half is stripping it out of
// the object `saveAppSettings()` PUTs to `/api/settings` — displayKeys is a
// client-side merge policy, not a wire filter. Without the strip, every save
// sent `showSplitButton` in the body, `SettingsUpdateSchema` (.strict()) does
// not declare it, the server answered 400 INVALID_INPUT, and because the
// call site never checked `res.ok` the UI still reported "Settings saved"
// while NOTHING persisted — workspaceHooksEnabled, agentSkillEnabled,
// tunnelEnabled, claudeModel, every toggle, on every save, on every device.
//
// Mirrors test/terminal-auto-copy.test.ts's "keeps the toggle per-device"
// guard for autoCopySelection — same three-way rule, same shape of test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, '../src/web/public');

function read(file: string): string {
  return readFileSync(join(PUBLIC, file), 'utf8');
}

describe('showSplitButton stays per-device: display key, stripped from the PUT, absent from the schema', () => {
  const settingsUi = read('settings-ui.js');
  const schemas = readFileSync(join(HERE, '../src/web/schemas.ts'), 'utf8');

  it('is in the client-side displayKeys merge policy', () => {
    const displayKeys = settingsUi.slice(
      settingsUi.indexOf('const displayKeys = new Set(['),
      settingsUi.indexOf('])', settingsUi.indexOf('const displayKeys = new Set(['))
    );
    expect(displayKeys).toContain("'showSplitButton'");
  });

  it('is stripped out of the object saveAppSettings() PUTs to the server', () => {
    // The strip is a destructure: `showSplitButton: _ssp,` pulls the key out
    // of `settings` so it never reaches `...serverSettings` in the PUT body.
    expect(settingsUi).toContain('showSplitButton: _ssp,');
  });

  it('is never declared in the .strict() SettingsUpdateSchema', () => {
    // Not even in a comment — a mention there reads as "this is a real
    // field" to the next person grepping schemas.ts for it.
    expect(schemas).not.toContain('showSplitButton');
  });
});
