/**
 * @fileoverview `RUN_MODE_LAUNCH` (session-ui.js, PR B2) restates four things
 * `stock.ts` already owns: label, an install command, whether the CLI
 * supports a custom-model launch, and the external-mode key set itself.
 * They agree today, but nothing enforced it — the dangerous drift is
 * `supportsCustomModel`: the Run menu's "CLI (endpoint)" rows come from the
 * server-injected `window.__codemanCustomModelClis` (built from
 * `capabilities.customModelInjection.kind !== 'unsupported'`), so a CLI that
 * gains a real injection recipe later would be OFFERED in that menu while
 * `_runCliMode` still drops the `customModel` field for it — the session
 * launches on the vendor's cloud while the UI claims the local endpoint.
 *
 * Drives the REAL session-ui.js via JSDOM (`runScripts: 'dangerously'`, same
 * approach as test/custom-model-one-shot-launch.test.ts), extracting the
 * module-level `RUN_MODE_LAUNCH` const by appending one assignment line to
 * the SAME source string before the one `eval()` call — it is not attached
 * to `window` on its own (top-level `const` lives in the script's own
 * lexical scope, not the global object), and a SEPARATE later `eval()` call
 * cannot see an earlier call's top-level bindings either (measured: each
 * `window.eval()` invocation gets its own top-level lexical environment in
 * jsdom), so the assignment has to ride in the same evaluated string.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const SESSION_UI_JS = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');

interface RunModeLaunchEntry {
  label: string;
  installHint: string;
  supportsCustomModel: boolean;
  buildConfig: (globalSettings: Record<string, unknown>) => Record<string, unknown> | null;
}

function loadRunModeLaunch(): Record<string, RunModeLaunchEntry> {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'dangerously' });
  const win = dom.window as unknown as Window & typeof globalThis & { CodemanApp: new () => unknown };
  (win as unknown as { eval: (s: string) => void }).eval('window.CodemanApp = function CodemanApp() {};');
  // The assignment MUST be part of the same evaluated string as
  // SESSION_UI_JS — RUN_MODE_LAUNCH is a bare top-level `const`, so it only
  // exists in the lexical scope of THIS eval call.
  (win as unknown as { eval: (s: string) => void }).eval(
    `${SESSION_UI_JS}\nwindow.__TEST_RUN_MODE_LAUNCH = RUN_MODE_LAUNCH;`
  );
  return (win as unknown as { __TEST_RUN_MODE_LAUNCH: Record<string, RunModeLaunchEntry> }).__TEST_RUN_MODE_LAUNCH;
}

describe('RUN_MODE_LAUNCH (session-ui.js) stays in step with stock.ts', () => {
  const runModeLaunch = loadRunModeLaunch();
  const byId = new Map(STOCK_CLIS.map((e) => [e.id as string, e]));

  it('covers exactly the non-claude, non-shell stock CLIs — no more, no fewer', () => {
    const expectedIds = STOCK_CLIS.map((e) => e.id as string)
      .filter((id) => id !== 'claude' && id !== 'shell')
      .sort();
    expect(Object.keys(runModeLaunch).sort()).toEqual(expectedIds);
  });

  it('label matches CliEntry.label for every entry', () => {
    for (const [id, entry] of Object.entries(runModeLaunch)) {
      const stockEntry = byId.get(id);
      expect(stockEntry, `no stock entry for ${id}`).toBeTruthy();
      expect(entry.label, `${id} label drifted from stock.ts`).toBe(stockEntry!.label);
    }
  });

  it('installHint embeds the real linux install command', () => {
    for (const [id, entry] of Object.entries(runModeLaunch)) {
      const command = byId.get(id)!.discovery.install.command?.linux;
      if (!command) continue; // shell-less entries (none today) carry no command to check
      expect(entry.installHint, `${id} installHint no longer matches stock.ts's linux install command`).toContain(
        command
      );
    }
  });

  it('supportsCustomModel matches capabilities.customModelInjection.kind !== "unsupported"', () => {
    // This is the one that fails SILENTLY if it drifts (see file header):
    // window.__codemanCustomModelClis (server.ts) is built from this same
    // stock.ts field, so a mismatch here means the Run-menu picker and the
    // actual launch body disagree about which CLIs are custom-model-capable.
    for (const [id, entry] of Object.entries(runModeLaunch)) {
      const supported = byId.get(id)!.capabilities.customModelInjection.kind !== 'unsupported';
      expect(entry.supportsCustomModel, `${id}.supportsCustomModel drifted from stock.ts's capability`).toBe(supported);
    }
  });
});
