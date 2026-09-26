// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = resolve(import.meta.dirname, '../src/web/public/app.js');

describe('Claude Code tab prefix', () => {
  it('includes CC in the main tab-strip markup', () => {
    const app = readFileSync(APP, 'utf8');

    expect(app).toContain(
      "mode === 'claude' ? '<span class=\"tab-mode claude\" aria-hidden=\"true\">cc</span>'"
    );
  });
});
