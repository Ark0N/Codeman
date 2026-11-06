import { beforeAll, describe, expect, it } from 'vitest';
import { createStyledPaneCapture, styledCapture } from './fixtures/styled-pane-capture.js';

let capture: Awaited<ReturnType<typeof createStyledPaneCapture>>;
beforeAll(async () => {
  capture = await createStyledPaneCapture();
});

describe('capturePaneBuffer style handoff (#629)', () => {
  it('resets the captured style before restoring the cursor', () => {
    expect(capture(true)).toBe(`${styledCapture.trimEnd().replace(/\n/g, '\r\n')}\x1b[0m\x1b[1A\r`);
  });

  it.each([true, false])('resets the raw fallback (fullHistory=%s)', (fullHistory) => {
    expect(capture(fullHistory, false)).toBe(`${styledCapture.trimEnd().replace(/\n/g, '\r\n')}\x1b[0m`);
  });

  it.each([true, false])('keeps an empty raw fallback empty (fullHistory=%s)', (fullHistory) => {
    expect(capture(fullHistory, false, '\n\n')).toBe('');
    expect(capture(fullHistory, false, '')).toBe('');
  });

  it('keeps an all-blank full-history capture empty', () => {
    expect(capture(true, true, '\n\n')).toBe('');
  });
});
