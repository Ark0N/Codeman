/**
 * @fileoverview Static guard for the Run menus' per-CLI logos (styles.css).
 *
 * Every launch surface (toolbar Run menu, phone overview picker, Custom Endpoint
 * rows, model picker) renders `<span class="run-mode-dot <id>">`, and styles.css
 * turns that slot into the CLI's logo through a `--run-mode-logo` data URI plus
 * one of two paint groups: brand-coloured marks paint as a background image,
 * monochrome marks as a mask over the row's text colour. Three ways that breaks
 * silently, each pinned here:
 *   - a new stock CLI lands with no logo rule (its row shows a bare grey dot);
 *   - a logo rule exists but the id is in neither paint group (the variable is
 *     set and never painted, so the slot is a blank 15px gap);
 *   - a later `background:` shorthand on `.run-mode-dot.<id>` (e.g. a skin
 *     override like the ones the non-og block used to carry) resets
 *     background-image and wipes the logo.
 *
 * Port: none (pure static analysis).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

// Comments stripped: they sit between rules and carry commas, which would bleed
// into the selector lists split below.
const styles = readFileSync(resolve('src/web/public/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every id a Run menu renders as `.run-mode-dot <id>`: the stock agents, Shell, and web tabs. */
const RUN_MENU_IDS = [
  ...STOCK_CLIS.filter((cli) => cli.kind === 'agent').map((cli) => cli.id as string),
  'shell',
  'web',
];

/** The selector list of the one rule whose body contains `marker`. */
function groupIds(marker: string): string[] {
  const rule = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[2].includes(marker));
  expect(rule, `exactly one rule paints via "${marker}"`).toHaveLength(1);
  return rule[0][1]
    .split(',')
    .map((s) => s.trim().match(/^\.run-mode-dot\.([a-z0-9-]+)$/)?.[1])
    .filter((id): id is string => Boolean(id));
}

function logoSvg(id: string): string {
  const m = styles.match(
    new RegExp(`\\.run-mode-dot\\.${id} \\{ --run-mode-logo: url\\("data:image/svg\\+xml,([^"]+)"\\); \\}`)
  );
  expect(m, `.run-mode-dot.${id} has a --run-mode-logo rule`).not.toBeNull();
  return decodeURIComponent(m![1]);
}

describe('Run menu CLI logos', () => {
  const colourIds = groupIds('background: var(--run-mode-logo)');
  const maskIds = groupIds('mask: var(--run-mode-logo)');

  it.each(RUN_MENU_IDS)('%s has a logo that one paint group draws', (id) => {
    const svg = logoSvg(id);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/viewBox='[\d. ]+'/);
    expect(colourIds.includes(id) !== maskIds.includes(id), `${id} is in exactly one paint group`).toBe(true);
  });

  it('defines no logo that no surface renders, and no group member without a logo', () => {
    expect([...colourIds, ...maskIds].sort()).toEqual([...RUN_MENU_IDS].sort());
  });

  it('carries no script or event handler inside a data URI', () => {
    for (const id of RUN_MENU_IDS) {
      const svg = logoSvg(id);
      expect(svg).not.toMatch(/<script|\son[a-z]+=|javascript:|href=/i);
    }
  });

  it('never resets a logo slot with a background shorthand outside the colour group', () => {
    const offenders = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, selector, body]) =>
        /\.run-mode-dot\.[a-z]/.test(selector) &&
        /(^|[;\s])background\s*:/.test(body) &&
        !body.includes('var(--run-mode-logo)')
    );
    expect(offenders.map((m) => m[1].trim())).toEqual([]);
  });
});
