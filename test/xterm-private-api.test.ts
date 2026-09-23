// Port: none (dependency-range guard — no browser, no server).
//
// terminal-ui.js's `_kickRenderer` reaches into xterm internals to unwedge a
// frozen RenderDebouncer:
//
//   terminal._core._renderService._renderDebouncer._animationFrame
//   terminal._core._renderService.refreshRows(start, end)
//
// There is no public API for any of it — xterm exposes no way to ask "are you
// still producing frames" or "drop your stale animation handle" — and the bug
// it heals (iOS discarding a scheduled rAF, leaving that handle permanently set
// so every later refresh() early-returns) is otherwise unrecoverable without a
// page reload.
//
// That path CANNOT be asserted in this suite. `_renderService` is constructed
// by `Terminal.open()`, which needs a real DOM, and the CI gate runs in node —
// a headless Terminal reports `_renderService: undefined`, so a test here would
// pass whether or not the field still exists, which is worse than no test.
//
// So this guards the next best thing: the exact xterm version those field names
// were verified against, as resolved in the lockfile. ANY bump fails here,
// loudly, and sends someone to re-verify `_kickRenderer` by hand in a browser. The failure mode being
// defended against is silent — every access in `_kickRenderer` is
// optional-chained, so a renamed field degrades it to a permanent no-op with no
// error, no log, and a terminal that simply freezes again.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string }>;
};
const terminalUi = readFileSync(resolve(root, 'src/web/public/terminal-ui.js'), 'utf8');

// The exact version `_kickRenderer`'s field path was verified against.
//
// Read from the LOCKFILE, not package.json. The declared range is `^6.0.0`, so
// asserting on that string is the wrong test in both directions: a real upgrade
// to 6.4.0 — which can absolutely rename a private field — resolves inside the
// range and slips through, while an innocuous range edit that changes nothing
// about the installed code fails. The lockfile is what actually ships.
const VERIFIED_XTERM_VERSION = '6.0.0';

describe('xterm private-API dependency guard', () => {
  it('pins the resolved xterm version _kickRenderer was verified against', () => {
    expect(
      lock.packages['node_modules/@xterm/xterm']?.version,
      'xterm moved off the verified version — re-verify _kickRenderer in a real browser ' +
        '(terminal-ui.js: _core._renderService._renderDebouncer._animationFrame), then update ' +
        'VERIFIED_XTERM_VERSION here. The accessor is optional-chained, so a renamed field ' +
        'degrades to a silent no-op and the freeze it heals comes back unnoticed.'
    ).toBe(VERIFIED_XTERM_VERSION);
  });

  // If someone deletes the watchdog, this guard is pointless noise — keep the
  // two tied together so the range check cannot outlive what it protects.
  it('is guarding a watchdog that still exists', () => {
    expect(terminalUi).toContain('_kickRenderer()');
    expect(terminalUi).toContain('_renderDebouncer');
    expect(terminalUi).toContain('_animationFrame');
  });

  // Every private read must stay optional-chained. This is the property that
  // makes reaching into internals acceptable at all: upstream can rename
  // anything and the worst case is that healing stops, never that the terminal
  // throws on a timer every two seconds.
  it('reads every private field defensively', () => {
    expect(terminalUi).toContain('this.terminal?._core?._renderService');
    const body = terminalUi.slice(terminalUi.indexOf('_kickRenderer() {'));
    const fn = body.slice(0, body.indexOf('\n  },'));
    expect(fn).toContain('try {');
    expect(fn).toContain('catch');
  });
});
