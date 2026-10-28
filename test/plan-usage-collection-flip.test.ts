/**
 * `planUsageCollectionFlip()` in settings-ui.js: the one place that decides
 * whether a settings save carries `showPlanUsageLimits` to the server.
 *
 * The chip is per-device for DISPLAY (desktop default ON, handhelds OFF) but
 * the same persisted key is the server-side telemetry COLLECTION switch, read
 * at every claude spawn. Sending it on every save let a phone saving its font
 * size persist `false` and turn collection off for every desktop. So the save
 * sends the key ONLY when it flips the chip relative to what the device had,
 * and the server reads an absent key as ON.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');

function loadSettingsUi(defaultChip: boolean) {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    CodemanApp,
    VoiceInput: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: () => null },
    console,
  });
  vm.runInContext(SOURCE, context, { filename: 'settings-ui.js' });
  const app = Object.create(CodemanApp.prototype) as {
    getDefaultSettings: () => { showPlanUsageLimits: boolean };
    planUsageCollectionFlip: (prev: Record<string, unknown> | null, now: boolean) => boolean | undefined;
  };
  app.getDefaultSettings = () => ({ showPlanUsageLimits: defaultChip });
  return app;
}

describe('planUsageCollectionFlip', () => {
  it('says nothing when a desktop that never touched the chip saves with it still on', () => {
    const desktop = loadSettingsUi(true);
    expect(desktop.planUsageCollectionFlip({}, true)).toBeUndefined();
    expect(desktop.planUsageCollectionFlip(null, true)).toBeUndefined();
  });

  it('says nothing when a handheld (chip default OFF) saves an unrelated setting', () => {
    const phone = loadSettingsUi(false);
    expect(phone.planUsageCollectionFlip({ terminalFontSize: 14 }, false)).toBeUndefined();
    expect(phone.planUsageCollectionFlip({ showPlanUsageLimits: false }, false)).toBeUndefined();
  });

  it('sends false only on the save that turned the chip off', () => {
    const desktop = loadSettingsUi(true);
    expect(desktop.planUsageCollectionFlip({}, false)).toBe(false);
    expect(desktop.planUsageCollectionFlip({ showPlanUsageLimits: true }, false)).toBe(false);
    expect(desktop.planUsageCollectionFlip({ showPlanUsageLimits: false }, false)).toBeUndefined();
  });

  it('sends true when any device, a handheld included, turns the chip on', () => {
    const phone = loadSettingsUi(false);
    expect(phone.planUsageCollectionFlip({}, true)).toBe(true);
    expect(phone.planUsageCollectionFlip({ showPlanUsageLimits: false }, true)).toBe(true);
    expect(phone.planUsageCollectionFlip({ showPlanUsageLimits: true }, true)).toBeUndefined();
  });
});

describe('saveAppSettings wiring', () => {
  it('strips showPlanUsageLimits from the synced payload and re-adds it only through the flip', () => {
    const save = SOURCE.slice(
      SOURCE.indexOf('async saveAppSettings()'),
      SOURCE.indexOf('closeAppSettings()', SOURCE.indexOf('async saveAppSettings()'))
    );
    // Stripped from serverSettings like the other per-device display keys.
    expect(save).toMatch(/showPlanUsageLimits: _pul,/);
    // Decided once against the device's prior settings, before they are overwritten (or, after a
    // save the server did not store, against the settings that save started from).
    expect(save).toMatch(
      /const _chipFlip = this\.planUsageCollectionFlip\(_prevServer, settings\.showPlanUsageLimits\);/
    );
    // And only a real flip reaches the PUT body.
    expect(save).toMatch(/\.\.\.\(_chipFlip !== undefined \? \{ showPlanUsageLimits: _chipFlip \} : \{\}\),/);
  });
});
