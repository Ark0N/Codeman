/**
 * @fileoverview What the client remembers about a pane's tmux scrollback.
 *
 * `selectSession` serves a tab switch from the small `full=1` capture when the
 * session's last terminal response reported `paneHistoryLines: 0` (a fullscreen
 * CLI in the alternate screen), instead of the 1 MiB byte tail. The memory that
 * decides it must treat ONLY a reported 0 as empty: a missing field (an older
 * server, a byte-history fallback) has to forget, so the tab switch goes back to
 * the bounded tail rather than trusting a stale answer.
 *
 * Runs the real `_notePaneHistory` / `_clearHistoryTruncation` from app.js in a
 * `vm`. The switch itself is driven end to end in
 * fullscreen-tab-switch-capture.browser.test.ts (browser suite).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const APP = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

function methodSource(source: string, method: string): string {
  const start = source.search(new RegExp(`^ {2}(?:async )?${method}\\(`, 'm'));
  expect(start, `${method} not found`).toBeGreaterThan(-1);
  const next = /^ {2}(?:async )?[A-Za-z_$][\w$]*\(/m.exec(source.slice(start + 1));
  return next ? source.slice(start, start + 1 + next.index) : source.slice(start);
}

function makeApp() {
  const methods = vm.runInContext(
    `({ ${methodSource(APP, '_notePaneHistory')}, ${methodSource(APP, '_clearHistoryTruncation')} })`,
    vm.createContext({})
  ) as Record<string, (...args: unknown[]) => void>;
  return {
    activeSessionId: null,
    _paneHistoryLines: new Map<string, number>(),
    _renderHistoryTruncationBanner() {},
    ...methods,
  } as Record<string, any>;
}

describe('_notePaneHistory', () => {
  it('records the count a capture reported, 0 included', () => {
    const app = makeApp();
    app._notePaneHistory('s1', { paneHistoryLines: 0 });
    app._notePaneHistory('s2', { paneHistoryLines: 40000 });
    expect(app._paneHistoryLines.get('s1')).toBe(0);
    expect(app._paneHistoryLines.get('s2')).toBe(40000);
  });

  it('forgets on a response without a usable count, so unknown never reads as empty', () => {
    const app = makeApp();
    for (const payload of [{}, { paneHistoryLines: null }, { paneHistoryLines: NaN }, { paneHistoryLines: -1 }, null]) {
      app._notePaneHistory('s1', { paneHistoryLines: 0 });
      app._notePaneHistory('s1', payload);
      expect(app._paneHistoryLines.has('s1')).toBe(false);
    }
  });

  it('ignores a call without a session', () => {
    const app = makeApp();
    app._notePaneHistory(null, { paneHistoryLines: 0 });
    expect(app._paneHistoryLines.size).toBe(0);
  });

  it('is dropped with the session', () => {
    const app = makeApp();
    app._notePaneHistory('s1', { paneHistoryLines: 0 });
    app._clearHistoryTruncation('s1');
    expect(app._paneHistoryLines.has('s1')).toBe(false);
  });
});

describe('every terminal response feeds it (static guard)', () => {
  it('the tab switch, the refresh and the history re-pull all record the pane', () => {
    expect(methodSource(APP, 'selectSession')).toContain('this._notePaneHistory?.(sessionId, data);');
    expect(methodSource(APP, '_onSessionNeedsRefresh')).toContain('this._notePaneHistory?.(sessionId, data);');
    expect(methodSource(APP, '_maybeRefetchFullHistory')).toContain('this._notePaneHistory?.(sessionId, payload);');
  });
});
