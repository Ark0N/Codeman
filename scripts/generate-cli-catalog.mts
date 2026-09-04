/**
 * Regenerates the two CLI-catalogue artifacts from `src/config/cli-registry/stock.ts`,
 * which stays the single source of truth.
 *
 *   npm run generate:cli-catalog          # rewrite both artifacts
 *   npm run generate:cli-catalog -- --check   # exit 1 on drift, write nothing
 *
 * The artifacts exist because two consumers cannot import TypeScript:
 *
 *   - `config/clis.stock.json` — read by `scripts/lib/cli-catalog.mjs` (a `.mjs` that feeds
 *     the Docker build args) and by the tests.
 *   - a generated block inside `install.sh` — the installer runs via `curl | bash` BEFORE any
 *     checkout exists, so it can read neither the registry nor the JSON. Its copy is embedded.
 *
 * ⚠️ The embedded copy is the FULL catalogue, deliberately. An earlier design fetched the
 * JSON at install time and fell back to a hardcoded two-CLI list, which degraded silently on
 * an empty response. There is no degraded mode to fall into now.
 *
 * ⚠️ Only fields the two consumers actually need are exported. `launch`, `env`, `capabilities`
 * and `overlays` are spawn-time concerns the server alone interprets, and exporting them would
 * invite a second implementation of the launch model outside the process that owns it.
 *
 * `test/cli-catalog-sync.test.ts` pins both artifacts against a fresh generation.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';

const JSON_PATH = fileURLToPath(new URL('../config/clis.stock.json', import.meta.url));
const INSTALL_SH_PATH = fileURLToPath(new URL('../install.sh', import.meta.url));

const BEGIN_MARKER = '# >>> BEGIN GENERATED CLI CATALOGUE';
const END_MARKER = '# <<< END GENERATED CLI CATALOGUE';

/** Platforms install.sh can be running on. `wsl`/`win32` resolve through the linux arm. */
type InstallPlatform = 'linux' | 'darwin';

// ---------------------------------------------------------------------------
// config/clis.stock.json
// ---------------------------------------------------------------------------

interface CatalogEntry {
  id: string;
  label: string;
  shortBadge: string;
  enabled: boolean;
  order: number;
  kind: string;
  discovery: {
    binaries: string[];
    searchDirs: string[];
    identity?: { arg: string; regex: string };
    install: { command: Record<string, string>; npmPackage?: string; docsUrl?: string };
  };
}

function toCatalogEntry(entry: CliEntry): CatalogEntry {
  const { binaries, searchDirs, identity, install } = entry.discovery;
  return {
    id: entry.id as string,
    label: entry.label,
    shortBadge: entry.shortBadge,
    // ⚠️ The field the previous attempt omitted, which is how a disabled CLI's npm package
    // still got baked into every agent image. Every consumer filters on it.
    enabled: entry.enabled,
    order: entry.order,
    kind: entry.kind,
    discovery: {
      binaries: [...binaries],
      searchDirs: [...searchDirs],
      ...(identity ? { identity: { arg: identity.arg, regex: identity.regex } } : {}),
      install: {
        command: { ...install.command } as Record<string, string>,
        ...(install.npmPackage ? { npmPackage: install.npmPackage } : {}),
        ...(install.docsUrl ? { docsUrl: install.docsUrl } : {}),
      },
    },
  };
}

export function renderCatalogJson(entries: CliEntry[] = STOCK_CLIS): string {
  return `${JSON.stringify(entries.map(toCatalogEntry), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The install.sh block
// ---------------------------------------------------------------------------

/** Single-quote a value for bash, escaping any embedded single quote. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A search dir as install.sh spells it. `~` becomes `$HOME` inside DOUBLE quotes so the shell
 * expands it at load time, exactly as the hand-written arrays did; everything else is
 * absolute and needs no expansion.
 */
function shPath(dir: string, binary: string): string {
  const expanded = dir.startsWith('~/') ? `$HOME/${dir.slice(2)}` : dir;
  return `"${expanded}/${binary}"`;
}

/**
 * The install command to run on `platform`, mirroring `resolveInstallCommandForPlatform()`:
 * the exact platform, else linux, else whatever is declared. Resolved HERE, at generation
 * time, so that fallback logic stays in tested TypeScript instead of being reimplemented in
 * bash against an array the script would have to index by platform anyway.
 */
function installCommandFor(entry: CliEntry, platform: InstallPlatform): string {
  const { command } = entry.discovery.install;
  return command[platform] ?? command.linux ?? Object.values(command)[0] ?? '';
}

export function renderInstallShBlock(entries: CliEntry[] = STOCK_CLIS): string {
  const ids: string[] = [];
  const labels: string[] = [];
  const enabled: string[] = [];
  const kinds: string[] = [];
  const npm: string[] = [];
  const docs: string[] = [];
  const cmdLinux: string[] = [];
  const cmdDarwin: string[] = [];
  const allBins: string[] = [];
  const binOff: number[] = [];
  const binLen: number[] = [];
  const allPaths: string[] = [];
  const pathOff: number[] = [];
  const pathLen: number[] = [];

  for (const entry of entries) {
    ids.push(shQuote(entry.id as string));
    labels.push(shQuote(entry.label));
    enabled.push(entry.enabled ? '1' : '0');
    kinds.push(shQuote(entry.kind));
    npm.push(shQuote(entry.discovery.install.npmPackage ?? ''));
    docs.push(shQuote(entry.discovery.install.docsUrl ?? ''));
    cmdLinux.push(shQuote(installCommandFor(entry, 'linux')));
    cmdDarwin.push(shQuote(installCommandFor(entry, 'darwin')));

    const { binaries, searchDirs } = entry.discovery;
    binOff.push(allBins.length);
    binLen.push(binaries.length);
    for (const bin of binaries) allBins.push(shQuote(bin));

    // Dir-major, matching the probe order the hand-written arrays used and
    // `test/install-sh-detection-parity.test.ts` pins.
    pathOff.push(allPaths.length);
    let count = 0;
    for (const dir of searchDirs) {
      for (const bin of binaries) {
        allPaths.push(shPath(dir, bin));
        count++;
      }
    }
    pathLen.push(count);
  }

  const arr = (name: string, values: Array<string | number>): string =>
    values.length === 0 ? `${name}=()` : `${name}=(${values.join(' ')})`;

  return [
    BEGIN_MARKER,
    '# Generated from src/config/cli-registry/stock.ts by scripts/generate-cli-catalog.mts.',
    '# Do not edit by hand: run `npm run generate:cli-catalog` and commit the result.',
    '#',
    '# Parallel indexed arrays, bash 3.2 safe (no associative arrays, no nameref, no mapfile).',
    '# The variable-length lists use OFFSET/LENGTH windows into one flat array rather than a',
    '# delimiter, so a $HOME containing a space needs no IFS handling and an entry with nothing',
    '# to contribute (shell has no binaries) gets length 0 and is simply never iterated.',
    '#',
    '# ⚠️ TRUST BOUNDARY: CLI_CMD_LINUX/CLI_CMD_DARWIN are the ONLY source of a command this',
    '# script will ever execute, and they arrive embedded in this file — same TLS fetch, same',
    '# commit as the script itself. Nothing fetched at install time may write them; the',
    '# refresh may only touch the *_DISPLAY copy. See cli_catalog_select_platform below.',
    arr('CLI_IDS', ids),
    arr('CLI_LABELS', labels),
    arr('CLI_ENABLED', enabled),
    arr('CLI_KIND', kinds),
    arr('CLI_NPM', npm),
    arr('CLI_DOCS', docs),
    arr('CLI_CMD_LINUX', cmdLinux),
    arr('CLI_CMD_DARWIN', cmdDarwin),
    arr('CLI_ALL_BINS', allBins),
    arr('CLI_BIN_OFF', binOff),
    arr('CLI_BIN_LEN', binLen),
    arr('CLI_ALL_PATHS', allPaths),
    arr('CLI_PATH_OFF', pathOff),
    arr('CLI_PATH_LEN', pathLen),
    END_MARKER,
  ].join('\n');
}

/** Replace the marked block in `source`, or throw if the markers are missing/malformed. */
export function spliceInstallShBlock(source: string, block: string): string {
  const begin = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);
  if (begin === -1 || end === -1) {
    throw new Error(
      `install.sh is missing the generated-catalogue markers (${BEGIN_MARKER} / ${END_MARKER}). ` +
        'Add them once by hand; the generator only rewrites between them.'
    );
  }
  if (end < begin) throw new Error('install.sh has the catalogue markers in the wrong order.');
  return source.slice(0, begin) + block + source.slice(end + END_MARKER.length);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * ⚠️ Guarded so the module can be IMPORTED for its pure renderers without running.
 * `test/cli-catalog-sync.test.ts` imports them, and an unguarded main would have that test
 * rewrite the very artifacts it is supposed to be checking — passing always, guarding never.
 */
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return fileURLToPath(import.meta.url) === resolve(invoked);
}

function main(): void {
  const check = process.argv.includes('--check');
  const wantJson = renderCatalogJson();
  const wantInstallSh = spliceInstallShBlock(readFileSync(INSTALL_SH_PATH, 'utf-8'), renderInstallShBlock());

  if (check) {
    const drift: string[] = [];
    if (readFileSync(JSON_PATH, 'utf-8') !== wantJson) drift.push('config/clis.stock.json');
    if (readFileSync(INSTALL_SH_PATH, 'utf-8') !== wantInstallSh) drift.push('install.sh');
    if (drift.length > 0) {
      console.error(`Out of date with stock.ts: ${drift.join(', ')}`);
      console.error('Run `npm run generate:cli-catalog` and commit the result.');
      process.exit(1);
    }
    console.log('CLI catalogue artifacts are in sync with stock.ts.');
  } else {
    writeFileSync(JSON_PATH, wantJson, 'utf-8');
    writeFileSync(INSTALL_SH_PATH, wantInstallSh, 'utf-8');
    console.log(`Wrote config/clis.stock.json and install.sh's catalogue block (${STOCK_CLIS.length} entries).`);
  }
}

if (isMainModule()) main();
