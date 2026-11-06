/**
 * @fileoverview The model a DeepSeek Harness (`dsh`) session's TUI is configured to
 * use, read from its route config, for a session header whose screen names no model
 * yet (the status bar's model field switched off, or not drawn yet). See
 * `SessionState.displayModel` (src/session-display-model.ts): the screen still wins
 * whenever it names a model, since it is what the running TUI actually uses.
 *
 * ## How dsh-TUI resolves its route (dsh 0.1.1-rc.2, dsh-TUI 0.10.0-beta.1)
 *
 * A profile is a stack of loader patch layers over an empty root, in this order
 * (`@deepseek-ai/dsh` profile-boot): every bundle's patch layer, the profile's own
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, the home-level
 * `$DSH_HOME/cordis.patch.yml` (it outranks the profile layer), then `--patch`
 * overlays (Codeman passes none). A patch targets a row by `id`; one whose `name`
 * does not match the row's is skipped; every other key REPLACES the row's field
 * whole (`applyEntryPatches`), so the last layer carrying `config` for the `dsh-tui`
 * row defines all of it.
 *
 * dsh-TUI then takes its model route from that config only when it names BOTH
 * `provider` and `model` (`lib/types/modelRoute.js`, issue #67). Anything less is
 * dropped whole and the TUI falls back to the persisted `/model` choice, then to its
 * own default: neither is in the config, so neither is answered here. The bundle's
 * own row pins `provider: deepseek-official` alone, by design, so only the two user
 * layers can pin a route; the bundle layers are not read (they resolve through the dsh
 * installation, outside the dsh home). `settings.yaml`'s `agent-default-model` is the
 * HEADLESS default, not the TUI's, and is never read.
 *
 * ## Answer nothing rather than a guess
 *
 * Every doubt answers null: a profile that does not compose dsh-TUI, a half-pinned
 * route, a layer that cannot be read (unreadable, a symlink out of the dsh home, too
 * big, a mount that does not answer), and a file this reader does not fully
 * understand. The YAML reader below is deliberately narrow (the repo carries no YAML
 * dependency): a top-level block sequence of patch items, plain keys, single-line
 * plain or quoted string scalars for the values it needs, and null for anything else
 * that could change the answer (an anchor, alias or tag such as `!!js` on such a value,
 * a merge key, a multi-line scalar, flow or block-scalar config, duplicate keys, a
 * scalar YAML would type as a number, boolean or null, a second document, a nested
 * row redefining dsh-TUI).
 *
 * ## Never block, never write, never leak
 *
 * Every path is probed with the bounded `probePathKind()` before it is touched, read
 * asynchronously with a size cap, and must resolve (realpath) inside the dsh home.
 * Nothing is written. Only the model id leaves this module: never the provider, a
 * base URL, a key or any other config value.
 *
 * Tests: `test/deepseek-route-config.test.ts`.
 *
 * @module deepseek-route-config
 */

import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { probePathKind } from './utils/bounded-path-probe.js';
import {
  deepSeekProfileFromManifest,
  isProfileDirName,
  resolveDefaultDeepSeekProfile,
  type DeepSeekProfile,
} from './utils/deepseek-cli-resolver.js';

/** The dsh-TUI bundle a profile must compose for its route to be read here. */
export const DSH_TUI_PACKAGE = '@deepseek-harness-tui/dsh-tui';
/** The loader row dsh-TUI's own config lives on. */
export const DSH_TUI_ROW_ID = 'dsh-tui';
/** Largest file read: a patch layer is a few dozen lines. */
export const MAX_ROUTE_FILE_BYTES = 64 * 1024;
/** A profile name as the launch accepts it (the `path-segment` token pattern). */
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** How many profile directories the default-profile inventory looks at. */
const MAX_PROFILES = 64;

/** What one patch item does to the dsh-TUI row. */
export interface DshTuiRowPatch {
  /** `name` on the patch; a mismatch makes dsh skip it. */
  name?: string;
  /** `disabled` on the patch, when present. */
  disabled?: boolean;
  /**
   * `config` on the patch, when present: the provider and model it names (absent when
   * it does not name one), or `{}` for a config that is empty or not a mapping.
   */
  config?: { provider?: string; model?: string };
}

/** Thrown inside the parser for anything it does not fully understand. */
class Ambiguous extends Error {}

/** A nested line naming the dsh-TUI row: a group's config can re-define the row through it. */
const ROW_ID_LINE = /^(?:-\s+)?id:\s*(['"]?)dsh-tui\1\s*$/;

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;

/**
 * Strip a line's comment (`#` at line start or after whitespace, outside quotes) and
 * trailing blanks. Throws on an unterminated quote: a multi-line flow scalar is
 * beyond this reader.
 */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") {
        if (line[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
    } else if (c === "'" || c === '"') {
      // A quote opens a scalar only at its start; inside a plain scalar it is a character.
      const prev = line.slice(0, i).trimEnd();
      if (prev === '' || /[:\-[{,]$/.test(prev)) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  if (quote) throw new Ambiguous('unterminated quote');
  return line.trimEnd();
}

/** Indentation of a line; a tab in it is refused (YAML forbids tabs there). */
function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line)![0];
  if (m.includes('\t')) throw new Ambiguous('tab indentation');
  return m.length;
}

/**
 * A single-line scalar as a string: plain, or single/double-quoted. Throws on anything
 * that is not plainly a string (a tag, an anchor, an alias, a flow collection, a
 * block scalar, or a plain scalar YAML would type as null, a boolean or a number).
 */
function stringScalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'$/.exec(v);
    if (!m) throw new Ambiguous('quoted scalar');
    return m[1].replace(/''/g, "'");
  }
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\["\\/])*)"$/.exec(v);
    if (!m) throw new Ambiguous('quoted scalar');
    return m[1].replace(/\\(["\\/])/g, '$1');
  }
  if (v === '' || /^[!&*[\]{}|>%@`,?:-]/.test(v)) throw new Ambiguous('not a plain string');
  if (/^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE)$/.test(v)) throw new Ambiguous('typed scalar');
  if (
    /^[-+]?(?:\.\d+|\d[\d_]*(?:\.\d*)?)(?:[eE][-+]?\d+)?$|^0[xob][0-9a-fA-F_]+$|^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/.test(
      v
    )
  ) {
    throw new Ambiguous('numeric scalar');
  }
  if (/\s#|:\s/.test(v)) throw new Ambiguous('plain scalar with an indicator');
  return v;
}

/** `true`/`false` as YAML spells them, or a throw. */
function boolScalar(raw: string): boolean {
  const v = raw.trim();
  if (/^(?:true|True|TRUE)$/.test(v)) return true;
  if (/^(?:false|False|FALSE)$/.test(v)) return false;
  throw new Ambiguous('not a boolean');
}

interface Line {
  indent: number;
  text: string;
}

/**
 * The direct keys of a block mapping whose lines all sit at `indent` or deeper, each
 * with its inline value and the lines nested under it. Throws on a line that is not a
 * key at the mapping's indent, and on a duplicate key (js-yaml refuses those, so dsh
 * would not boot).
 */
function mappingKeys(lines: Line[], indent: number): Map<string, { inline: string | undefined; nested: Line[] }> {
  const keys = new Map<string, { inline: string | undefined; nested: Line[] }>();
  let current: { inline: string | undefined; nested: Line[] } | null = null;
  for (const line of lines) {
    if (line.indent > indent) {
      if (!current) throw new Ambiguous('nested line with no key');
      current.nested.push(line);
      continue;
    }
    if (line.indent < indent) throw new Ambiguous('dedent inside a mapping');
    const m = KEY_LINE.exec(line.text);
    if (!m) throw new Ambiguous(`not a key: ${line.text.slice(0, 20)}`);
    if (keys.has(m[1])) throw new Ambiguous('duplicate key');
    current = { inline: m[2] === undefined || m[2] === '' ? undefined : m[2], nested: [] };
    keys.set(m[1], current);
  }
  return keys;
}

/**
 * Whether an item this reader cannot follow is certainly about another row: a plain
 * `id:` at the item's indent naming a row other than dsh-TUI, no `insert:` and no
 * mention of the dsh-TUI row anywhere in it.
 */
function isUnrelatedItem(item: Line[]): boolean {
  const indent = item[0].indent;
  const top = item.filter((l) => l.indent === indent);
  if (top.some((l) => /^insert\s*:/.test(l.text))) return false;
  const ids = top.map((l) => KEY_LINE.exec(l.text)).filter((m) => m?.[1] === 'id');
  if (ids.length !== 1 || ids[0]![2] === undefined) return false;
  try {
    return stringScalar(ids[0]![2]) !== DSH_TUI_ROW_ID;
  } catch {
    return false;
  }
}

/** The `config` of a dsh-TUI patch: its provider and model, if it names them. */
function configOf(entry: { inline: string | undefined; nested: Line[] }): { provider?: string; model?: string } {
  if (entry.inline !== undefined) {
    if (entry.nested.length) throw new Ambiguous('config with both an inline value and nested lines');
    const v = entry.inline.trim();
    // An empty flow mapping or a null names no route; anything else inline (a tag, a
    // non-empty flow mapping, a block scalar) is beyond this reader.
    if (v === '{}' || /^(?:~|null|Null|NULL)$/.test(v)) return {};
    throw new Ambiguous('inline config');
  }
  if (!entry.nested.length) return {};
  const keys = mappingKeys(entry.nested, entry.nested[0].indent);
  const out: { provider?: string; model?: string } = {};
  for (const field of ['provider', 'model'] as const) {
    const value = keys.get(field);
    if (!value) continue;
    if (value.nested.length || value.inline === undefined) throw new Ambiguous(`${field} is not a single-line scalar`);
    out[field] = stringScalar(value.inline);
  }
  return out;
}

/**
 * What a cordis patch-list file (a top-level YAML array of loader patches) does to the
 * dsh-TUI row, in order. An empty list when the file does not touch it. Null when the
 * file is beyond this reader's subset, or when it could re-insert the row.
 *
 * @param text the file's content
 */
export function parseDshTuiPatches(text: string): DshTuiRowPatch[] | null {
  try {
    const lines: Line[] = [];
    let sawContent = false;
    for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const stripped = stripComment(rawLine);
      if (stripped.trim() === '') continue;
      const indent = indentOf(stripped);
      const body = stripped.slice(indent);
      if (indent === 0 && body === '---') {
        if (sawContent) throw new Ambiguous('a second document');
        continue;
      }
      sawContent = true;
      lines.push({ indent, text: body });
    }
    if (lines.length === 0) return [];
    if (lines.length === 1 && lines[0].indent === 0 && lines[0].text === '[]') return [];

    // Split the top-level block sequence into items.
    const items: Line[][] = [];
    for (const line of lines) {
      if (line.indent === 0) {
        const m = /^-(?:(\s+)(.*))?$/.exec(line.text);
        if (!m) throw new Ambiguous('not a top-level sequence');
        const item: Line[] = [];
        // `- key: value`: the key sits at its real column, which its siblings below share.
        if (m[2] !== undefined && m[2] !== '') item.push({ indent: 1 + m[1].length, text: m[2] });
        items.push(item);
        continue;
      }
      if (items.length === 0) throw new Ambiguous('indented content before the first item');
      items[items.length - 1].push(line);
    }

    const patches: DshTuiRowPatch[] = [];
    for (const item of items) {
      if (item.length === 0) throw new Ambiguous('empty item');
      // The first key's column is the item's indent; every key shares it.
      let keys: ReturnType<typeof mappingKeys>;
      try {
        keys = mappingKeys(item, item[0].indent);
      } catch (err) {
        // An item this reader cannot follow is harmless only when it provably is about
        // another row: its own id names one, and no line in it names the dsh-TUI row.
        if (!(err instanceof Ambiguous) || !isUnrelatedItem(item)) throw err;
        if (item.slice(1).some((l) => ROW_ID_LINE.test(l.text))) throw new Ambiguous('a nested dsh-tui row');
        continue;
      }
      const id = keys.get('id');
      if (keys.has('insert')) {
        // An insert that could bring a second dsh-TUI row is beyond this reader.
        const body = item.map((l) => l.text).join('\n');
        if (body.includes(DSH_TUI_ROW_ID)) throw new Ambiguous('insert mentioning the dsh-tui row');
        continue;
      }
      if (!id) continue; // dsh warns and skips a non-insert patch without an id
      if (id.nested.length || id.inline === undefined) throw new Ambiguous('id is not a scalar');
      if (stringScalar(id.inline) !== DSH_TUI_ROW_ID) {
        // Another row; but a group row's config is a list of rows, and one of them could
        // be a second dsh-TUI row (dsh indexes nested group entries by id too).
        if (item.slice(1).some((l) => ROW_ID_LINE.test(l.text))) throw new Ambiguous('a nested dsh-tui row');
        continue;
      }
      const patch: DshTuiRowPatch = {};
      const name = keys.get('name');
      if (name) {
        if (name.nested.length || name.inline === undefined) throw new Ambiguous('name is not a scalar');
        patch.name = stringScalar(name.inline);
      }
      const disabled = keys.get('disabled');
      if (disabled) {
        if (disabled.nested.length || disabled.inline === undefined) throw new Ambiguous('disabled is not a scalar');
        patch.disabled = boolScalar(disabled.inline);
      }
      const config = keys.get('config');
      if (config) patch.config = configOf(config);
      patches.push(patch);
    }
    return patches;
  } catch (err) {
    if (err instanceof Ambiguous) return null;
    throw err;
  }
}

/**
 * The model dsh-TUI's route config pins, given what the user layers do to its row in
 * application order (profile layer first, then the home layer). Null unless the last
 * `config` that applies names both a provider and a model, and the row is not
 * disabled. Pure.
 *
 * @param layers each layer's patches for the row, or null for a layer that could not be read
 */
export function resolveDshTuiRouteModel(layers: Array<DshTuiRowPatch[] | null>): string | null {
  let config: { provider?: string; model?: string } | undefined;
  let disabled = false;
  for (const layer of layers) {
    if (layer === null) return null;
    for (const patch of layer) {
      if (patch.name !== undefined && patch.name !== DSH_TUI_PACKAGE) continue;
      if (patch.disabled !== undefined) disabled = patch.disabled;
      if (patch.config !== undefined) config = patch.config;
    }
  }
  if (disabled || !config?.provider || !config.model) return null;
  return config.model;
}

/** A file under the dsh home, read only if it provably is one; see {@link readHomeFile}. */
type FileRead = { state: 'absent' } | { state: 'read'; text: string } | { state: 'refused' };

/**
 * Read `path`, which must resolve inside `realHome`, bounded: probed first (a mount
 * that does not answer is refused, never waited on), its real path checked against
 * the dsh home (a symlink out of it is refused), size-capped.
 */
async function readHomeFile(path: string, realHome: string): Promise<FileRead> {
  const kind = await probePathKind(path);
  if (kind === 'absent') return { state: 'absent' };
  if (kind !== 'file') return { state: 'refused' };
  try {
    const real = await fs.realpath(path);
    if (!real.startsWith(realHome + sep)) return { state: 'refused' };
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > MAX_ROUTE_FILE_BYTES) return { state: 'refused' };
    return { state: 'read', text: await fs.readFile(real, 'utf8') };
  } catch {
    return { state: 'refused' };
  }
}

/**
 * The dsh home a session runs against: its own `DSH_HOME` (already clamped for a
 * non-granted owner), else the server's, else `~/.dsh`, as the `dsh` wrapper's
 * `${DSH_HOME:-...}` resolves it. Null for a relative value, which names no place.
 */
export function effectiveDshHome(env: (key: string) => string | undefined): string | null {
  const value = env('DSH_HOME')?.trim();
  if (!value) return join(homedir(), '.dsh');
  return isAbsolute(value) ? resolve(value) : null;
}

/**
 * The profiles under a dsh home, read with the same bounded rules as the route files.
 * Used to name the profile a session boots when it named none, the way the launch's
 * `launcherDefaultTarget` does (resolveDefaultDeepSeekProfile).
 */
async function listProfilesBounded(home: string): Promise<DeepSeekProfile[] | null> {
  const profilesDir = join(home, 'profiles');
  if ((await probePathKind(home)) !== 'directory' || (await probePathKind(profilesDir)) !== 'directory') return null;
  let realHome: string;
  let names: string[];
  try {
    realHome = await fs.realpath(home);
    names = (await fs.readdir(profilesDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && isProfileDirName(e.name) && PROFILE_NAME.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_PROFILES);
  } catch {
    return null;
  }
  const profiles: DeepSeekProfile[] = [];
  for (const name of names) {
    const manifest = await readHomeFile(join(profilesDir, name, 'package.json'), realHome);
    if (manifest.state !== 'read') continue;
    const profile = deepSeekProfileFromManifest(name, manifest.text);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

/** What the reader needs to know about one session. */
export interface DeepSeekRouteContext {
  /** The session's `deepSeekConfig.profile`, if any. */
  profile?: unknown;
  /** The session's dsh home (see {@link effectiveDshHome}). */
  home: string | null;
  /** The server's own dsh home, which names the default profile (as the launch does). */
  serverHome: string | null;
}

/**
 * The model the session's dsh-TUI route config pins, or null when it pins none or the
 * answer is in any doubt. Read-only and bounded; see the module comment.
 */
export async function readDeepSeekRouteModel(ctx: DeepSeekRouteContext): Promise<string | null> {
  const { home } = ctx;
  if (!home) return null;
  // An invalid name reads as unset at launch, so the default applies there too.
  let profile = typeof ctx.profile === 'string' && PROFILE_NAME.test(ctx.profile) ? ctx.profile : null;
  if (!profile) {
    if (!ctx.serverHome) return null;
    const listed = await listProfilesBounded(ctx.serverHome);
    profile = listed ? resolveDefaultDeepSeekProfile(listed) : null;
    if (!profile) return null;
  }
  if ((await probePathKind(home)) !== 'directory') return null;
  let realHome: string;
  try {
    realHome = await fs.realpath(home);
  } catch {
    return null;
  }
  const profileDir = join(home, 'profiles', profile);
  const manifest = await readHomeFile(join(profileDir, 'package.json'), realHome);
  if (manifest.state !== 'read') return null;
  if (!deepSeekProfileFromManifest(profile, manifest.text)?.bundles.includes(DSH_TUI_PACKAGE)) return null;

  const layers: Array<DshTuiRowPatch[] | null> = [];
  for (const file of [join(profileDir, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]) {
    const read = await readHomeFile(file, realHome);
    if (read.state === 'refused') return null;
    layers.push(read.state === 'absent' ? [] : parseDshTuiPatches(read.text));
  }
  return resolveDshTuiRouteModel(layers);
}
