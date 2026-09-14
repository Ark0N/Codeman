/**
 * `statusLineTelemetryAction()` in settings-ui.js: the one place that decides
 * what a settings save tells the server about the plan-usage exporter.
 *
 * The chip is per-device (desktop default ON, phones OFF), while the exporter
 * it depends on lives in each repo's shared `.claude/settings.local.json`. So
 * the save may send `true` freely (every save while the chip is on re-injects,
 * which is how a second device catches up) but may send `false` ONLY on the
 * save that turned the chip off on this device. A phone with the chip off
 * saving its font size must not strip the exporter a desktop's chip depends on.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadSettingsUi() {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    CodemanApp,
    VoiceInput: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: () => null },
    console,
  });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'settings-ui.js' });
  return CodemanApp.prototype as { statusLineTelemetryAction: (prev: boolean, now: boolean) => boolean | undefined };
}

describe('statusLineTelemetryAction', () => {
  const ui = loadSettingsUi();

  it('sends true on every save while the chip is on', () => {
    expect(ui.statusLineTelemetryAction(true, true)).toBe(true);
    expect(ui.statusLineTelemetryAction(false, true)).toBe(true);
  });

  it('sends false only on the save that turned the chip off', () => {
    expect(ui.statusLineTelemetryAction(true, false)).toBe(false);
  });

  it('sends nothing from a device whose chip was already off', () => {
    expect(ui.statusLineTelemetryAction(false, false)).toBeUndefined();
  });
});
