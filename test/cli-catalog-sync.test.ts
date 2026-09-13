/**
 * @fileoverview Pins the two generated CLI-catalogue artifacts against a fresh generation.
 *
 * `config/clis.stock.json` and the marked block inside `install.sh` are both derived from
 * `src/config/cli-registry/stock.ts`. Generated files that are committed rot the moment
 * someone edits the source and forgets the generator, and the failure is silent in the worst
 * possible way: the installer keeps detecting the OLD set of CLIs while the server offers the
 * new one. Same class as the drift this whole change exists to remove, just moved one level
 * out.
 *
 * ⚠️ The renderers are imported from the generator, which means the generator's `main()` must
 * stay behind its `isMainModule()` guard. Without it, importing this module would rewrite the
 * artifacts as a side effect of checking them — the test would pass unconditionally and
 * guard nothing.
 *
 * Port: none (pure, over two files and the registry).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderCatalogJson, renderInstallShBlock, spliceInstallShBlock } from '../scripts/generate-cli-catalog.mts';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const REGENERATE = 'Run `npm run generate:cli-catalog` and commit the result.';

const jsonPath = fileURLToPath(new URL('../config/clis.stock.json', import.meta.url));
const installShPath = fileURLToPath(new URL('../install.sh', import.meta.url));

describe('generated CLI catalogue artifacts', () => {
  it('config/clis.stock.json matches a fresh generation', () => {
    expect(readFileSync(jsonPath, 'utf-8'), `config/clis.stock.json is stale. ${REGENERATE}`).toBe(renderCatalogJson());
  });

  it("install.sh's generated block matches a fresh generation", () => {
    const current = readFileSync(installShPath, 'utf-8');
    expect(current, `install.sh's catalogue block is stale. ${REGENERATE}`).toBe(
      spliceInstallShBlock(current, renderInstallShBlock())
    );
  });

  it('exports every stock CLI, carrying the enabled flag', () => {
    const exported = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Array<{ id: string; enabled: boolean }>;
    expect(exported.map((e) => e.id)).toEqual(STOCK_CLIS.map((e) => e.id as string));
    // The field the previous attempt omitted, which let a disabled CLI's npm package be baked
    // into every agent image. Its PRESENCE is the contract; its value is whatever stock says.
    for (const entry of exported) {
      expect(typeof entry.enabled, `${entry.id} has no enabled flag`).toBe('boolean');
    }
  });

  it('exports no spawn-time fields', () => {
    // launch/env/capabilities/overlays are the server's alone. Exporting them would invite a
    // second reading of the launch model in a consumer that cannot be tested against a spawn.
    const raw = readFileSync(jsonPath, 'utf-8');
    for (const forbidden of ['"launch"', '"env"', '"capabilities"', '"overlays"']) {
      expect(raw.includes(forbidden), `${forbidden} leaked into the exported catalogue`).toBe(false);
    }
  });

  it('splices only between the markers (anti-clobber)', () => {
    // The generator rewrites a window, not the file. If the splice ever widened, it would eat
    // hand-written installer code on the next run and nothing else here would notice.
    const current = readFileSync(installShPath, 'utf-8');
    const spliced = spliceInstallShBlock(
      current,
      '# >>> BEGIN GENERATED CLI CATALOGUE\n# <<< END GENERATED CLI CATALOGUE'
    );
    expect(spliced.startsWith(current.slice(0, current.indexOf('# >>> BEGIN GENERATED CLI CATALOGUE')))).toBe(true);
    expect(
      spliced.endsWith(
        current.slice(current.indexOf('# <<< END GENERATED CLI CATALOGUE') + '# <<< END GENERATED CLI CATALOGUE'.length)
      )
    ).toBe(true);
  });

  it('refuses a file with no markers rather than appending', () => {
    expect(() => spliceInstallShBlock('#!/usr/bin/env bash\necho hi\n', 'block')).toThrow(/markers/);
  });
});
