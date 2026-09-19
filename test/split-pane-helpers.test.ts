import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadSplitPaneHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanSplitPane: any }).CodemanSplitPane;
}

describe('CodemanSplitPane.clampDividerPercent', () => {
  it('passes through a value inside the clamp range', () => {
    const { clampDividerPercent } = loadSplitPaneHelper();
    expect(clampDividerPercent(50)).toBe(50);
    expect(clampDividerPercent(35.5)).toBe(35.5);
  });

  it('clamps below the floor to the floor', () => {
    const { clampDividerPercent } = loadSplitPaneHelper();
    expect(clampDividerPercent(5)).toBe(20);
  });

  it('clamps above the ceiling to the ceiling', () => {
    const { clampDividerPercent } = loadSplitPaneHelper();
    expect(clampDividerPercent(95)).toBe(80);
  });

  it('honors custom min/max', () => {
    const { clampDividerPercent } = loadSplitPaneHelper();
    expect(clampDividerPercent(10, 15, 85)).toBe(15);
    expect(clampDividerPercent(90, 15, 85)).toBe(85);
  });
});

describe('CodemanSplitPane.buildSplitPickerSessions', () => {
  it('excludes the active session and preserves tab order', () => {
    const { buildSplitPickerSessions } = loadSplitPaneHelper();
    const sessions = new Map([
      ['a', { name: 'w1-codeman' }],
      ['b', { name: 'w1-mcp-memory' }],
      ['c', { name: null }],
    ]);
    const sessionOrder = ['a', 'b', 'c'];
    const result = buildSplitPickerSessions(sessions, sessionOrder, 'a');
    expect(result).toEqual([
      { id: 'b', label: 'w1-mcp-memory' },
      { id: 'c', label: 'Session' },
    ]);
  });

  it('drops order entries with no matching session (stale ids)', () => {
    const { buildSplitPickerSessions } = loadSplitPaneHelper();
    const sessions = new Map([['a', { name: 'w1-codeman' }]]);
    const sessionOrder = ['a', 'ghost'];
    const result = buildSplitPickerSessions(sessions, sessionOrder, null);
    expect(result).toEqual([{ id: 'a', label: 'w1-codeman' }]);
  });

  it('returns an empty list when only the excluded session exists', () => {
    const { buildSplitPickerSessions } = loadSplitPaneHelper();
    const sessions = new Map([['a', { name: 'w1-codeman' }]]);
    const result = buildSplitPickerSessions(sessions, ['a'], 'a');
    expect(result).toEqual([]);
  });
});
