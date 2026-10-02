// @vitest-environment node
// Regression guard: xterm runs the custom key handler for keydown AND keypress.
// It discards a keypress carrying Ctrl/Alt but not one carrying only Shift, so
// a handler that returns false for keydown alone lets Shift+Enter's keypress
// through as a bare \r (submit). The Enter gate must therefore not be keyed on
// ev.type === 'keydown'; only the send-key fetch is.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC = join(new URL('.', import.meta.url).pathname, '../src/web/public');

describe.each(['terminal-ui.js', 'terminal-split.js'])('%s Shift/Ctrl+Enter handler', (file) => {
  const src = readFileSync(join(PUBLIC, file), 'utf8');

  it('swallows every event type for Shift/Ctrl+Enter', () => {
    expect(src).toMatch(/ev\.key === 'Enter' && \(ev\.shiftKey \|\| ev\.ctrlKey\)\) \{/);
    expect(src).not.toMatch(/ev\.key === 'Enter' && \(ev\.shiftKey \|\| ev\.ctrlKey\) && ev\.type === 'keydown'/);
  });
});
