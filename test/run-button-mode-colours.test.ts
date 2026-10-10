import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');

// An agent CLI whose Run button has no `mode-<id>` rule falls back to the default button
// colours, so it reads as a different button from every other CLI's. The Run button, its
// gear, the phone toolbar and the light skins each carry their own rule.
const AGENT_IDS = STOCK_CLIS.filter((c) => c.kind === 'agent').map((c) => c.id as string);

describe('Run button colours for every stock agent CLI', () => {
  it('lists agent CLIs (anti-vacuity)', () => {
    expect(AGENT_IDS).toContain('copilot');
    expect(AGENT_IDS.length).toBeGreaterThan(5);
  });

  for (const id of AGENT_IDS) {
    it(`${id} has a Run button rule`, () => {
      expect(styles, `${id} has no .btn-run.mode-${id} rule in styles.css`).toContain(
        `.btn-toolbar.btn-run.mode-${id}`
      );
    });
  }
});
