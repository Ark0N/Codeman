/**
 * @fileoverview Static guard: every SSE dispatch entry must actually resolve.
 *
 * `app.js` dispatches server events through a table of `[SSE_EVENTS.X, '_onFoo']`
 * pairs. Both halves fail SILENTLY when they are wrong:
 *
 *  - a handler name that exists in no module (renamed method, typo) → the event is
 *    received and nothing happens, with no error anywhere;
 *  - an `SSE_EVENTS.X` key that `constants.js` does not define → the table key is
 *    `undefined`, so the entry can never match an incoming event.
 *
 * Both have happened in this codebase's feature areas (a new banner/toast that simply
 * never appears), and neither is visible to a test that only checks the modules compile.
 * Pure static analysis — no server, no browser.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PUBLIC_DIR = fileURLToPath(new URL('../src/web/public', import.meta.url));

const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');
const constantsJs = readFileSync(join(PUBLIC_DIR, 'constants.js'), 'utf-8');
const allModules = readdirSync(PUBLIC_DIR)
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(join(PUBLIC_DIR, name), 'utf-8'))
  .join('\n');

/** `[SSE_EVENTS.FOO, '_onFoo'],` entries of the dispatch table. */
function dispatchEntries(): { constant: string; handler: string }[] {
  const entries: { constant: string; handler: string }[] = [];
  const re = /\[SSE_EVENTS\.([A-Z0-9_]+),\s*'(_[A-Za-z0-9_]+)'\]/g;
  for (const match of appJs.matchAll(re)) {
    entries.push({ constant: match[1], handler: match[2] });
  }
  return entries;
}

describe('SSE dispatch table', () => {
  it('has entries to check (the table is what this guard exists for)', () => {
    expect(dispatchEntries().length).toBeGreaterThan(20);
  });

  it('names only events that constants.js defines', () => {
    const defined = new Set([...constantsJs.matchAll(/^\s{2}([A-Z0-9_]+):\s*'/gm)].map((m) => m[1]));
    const missing = dispatchEntries()
      .map((entry) => entry.constant)
      .filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it('names only handlers that some frontend module actually defines', () => {
    const missing = dispatchEntries()
      .map((entry) => entry.handler)
      .filter((handler) => !new RegExp(`(^|\\s)${handler}\\s*\\(`, 'm').test(allModules));
    expect(missing).toEqual([]);
  });

  it('defines every handler in exactly ONE module (a second copy is shadowed)', () => {
    // Modules mix into `CodemanApp.prototype` and run in script order, so two
    // definitions of the same handler name silently shadow each other: the later file
    // wins and the earlier one never runs. The existence check above cannot see that
    // (both names resolve), which is how a duplicate banner handler can leave a toast
    // dead with no error anywhere.
    const byModule = readdirSync(PUBLIC_DIR)
      .filter((name) => name.endsWith('.js'))
      .map((name) => ({ name, source: readFileSync(join(PUBLIC_DIR, name), 'utf-8') }));
    const shadowed = dispatchEntries()
      .map((entry) => entry.handler)
      .filter((handler) => {
        const re = new RegExp(`(^|\\s)${handler}\\s*\\(`, 'm');
        return byModule.filter((mod) => re.test(mod.source)).length > 1;
      });
    expect(shadowed).toEqual([]);
  });
});
