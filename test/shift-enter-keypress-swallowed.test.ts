// @vitest-environment node
// Regression guard: xterm runs the custom key handler for keydown AND keypress.
// It discards a keypress carrying Ctrl/Alt but not one carrying only Shift, so
// a handler that returns false for keydown alone lets Shift+Enter's keypress
// through as a bare \r (submit). The Enter gate must therefore not be keyed on
// ev.type === 'keydown'; only the send-key fetch is. The main pane may add an
// iOS clause after the modifier test (#830), which must not test ev.type either.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC = join(new URL('.', import.meta.url).pathname, '../src/web/public');
const GATE = /if \(ev\.key === 'Enter' && \(ev\.shiftKey \|\| ev\.ctrlKey\)(.*)\) \{/;

describe.each(['terminal-ui.js', 'terminal-tile.js'])('%s Shift/Ctrl+Enter handler', (file) => {
  const src = readFileSync(join(PUBLIC, file), 'utf8');

  it('swallows every event type for Shift/Ctrl+Enter', () => {
    const gate = src.match(GATE);
    expect(gate, 'Shift/Ctrl+Enter gate not found').not.toBeNull();
    expect(gate![0]).not.toContain('ev.type');
  });
});
