/**
 * The model a dsh session's TUI route config pins (src/deepseek-route-config.ts),
 * shown in a session header when the TUI's screen names none.
 *
 * Fixture dsh homes are built in a temp directory. The two user layers below are the
 * owner's real files on 2026-10-07, verbatim apart from the comment text: the
 * profile layer pins the dsh-tui row's route (provider AND model), the home layer
 * pins `agent-default-model`, which is the headless default and NOT the TUI's.
 *
 * Port: N/A.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DSH_TUI_PACKAGE,
  MAX_ROUTE_FILE_BYTES,
  effectiveDshHome,
  parseDshTuiPatches,
  readDeepSeekRouteModel,
  resolveDshTuiRouteModel,
} from '../src/deepseek-route-config.js';

const PROFILE_LAYER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
#
# Route the TUI at the 5090 box's live serve. A config route counts only
# when it names BOTH provider and model.
- id: dsh-tui
  config:
    provider: qwen5090
    model: qwen3.8-27b
    effort: medium
    preset: qwen5090
`;
const HOME_LAYER = `# Home-level patch layer. The default model is a composition entry,
# not a settings key.
- id: agent-default-model
  config:
    provider: qwen5090
    model: qwen3.8-27b
`;
const SETTINGS = `agent-default-model:
  provider: qwen5090
  model: qwen3.8-27b
`;
const TUI_BUNDLES = ['@deepseek-ai/dsh-base', DSH_TUI_PACKAGE];

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fixture dsh home: profiles (bundles + optional patch layer), a home layer, settings.yaml. */
function makeHome(spec: {
  profiles?: Record<string, { bundles?: string[]; patch?: string }>;
  homePatch?: string;
  settings?: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-route-'));
  homes.push(root);
  const home = join(root, 'dsh');
  mkdirSync(join(home, 'profiles'), { recursive: true });
  for (const [name, p] of Object.entries(spec.profiles ?? {})) {
    mkdirSync(join(home, 'profiles', name), { recursive: true });
    writeFileSync(
      join(home, 'profiles', name, 'package.json'),
      JSON.stringify({ name: `dsh-profile-${name}`, dsh: { profile: { bundles: p.bundles ?? TUI_BUNDLES } } })
    );
    if (p.patch !== undefined) writeFileSync(join(home, 'profiles', name, 'cordis.patch.yml'), p.patch);
  }
  if (spec.homePatch !== undefined) writeFileSync(join(home, 'cordis.patch.yml'), spec.homePatch);
  if (spec.settings !== undefined) writeFileSync(join(home, 'settings.yaml'), spec.settings);
  return home;
}

const read = (home: string, profile: string | undefined = 'dsh-tui', serverHome: string | null = home) =>
  readDeepSeekRouteModel({ profile, home, serverHome });

describe('readDeepSeekRouteModel', () => {
  it('a route pinned with both provider and model: the model', async () => {
    const home = makeHome({
      profiles: { 'dsh-tui': { patch: PROFILE_LAYER } },
      homePatch: HOME_LAYER,
      settings: SETTINGS,
    });
    expect(await read(home)).toBe('qwen3.8-27b');
  });

  it('a half-pinned route (provider alone): nothing, the TUI drops it whole', async () => {
    const half = '- id: dsh-tui\n  config:\n    provider: qwen5090\n    effort: medium\n';
    expect(await read(makeHome({ profiles: { 'dsh-tui': { patch: half } } }))).toBeNull();
    const modelOnly = '- id: dsh-tui\n  config:\n    model: qwen3.8-27b\n';
    expect(await read(makeHome({ profiles: { 'dsh-tui': { patch: modelOnly } } }))).toBeNull();
  });

  it('no profile layer: nothing (the bundle pins a provider alone, by design)', async () => {
    expect(await read(makeHome({ profiles: { 'dsh-tui': {} }, homePatch: HOME_LAYER, settings: SETTINGS }))).toBeNull();
  });

  it("settings.yaml and the home layer's agent-default-model are the headless default, never the TUI's", async () => {
    expect(await read(makeHome({ profiles: { 'dsh-tui': {} }, settings: SETTINGS }))).toBeNull();
    expect(await read(makeHome({ profiles: { 'dsh-tui': {} }, homePatch: HOME_LAYER }))).toBeNull();
  });

  it('a layer that does not parse: nothing', async () => {
    const broken = [
      '- id: dsh-tui\n  config:\n\tprovider: qwen5090\n\tmodel: x\n', // tab indentation
      '- id: dsh-tui\n  config:\n   \tprovider: qwen5090\n   \tmodel: x\n', // a tab inside the indentation
      "- id: dsh-tui\n  config:\n    provider: 'qwen5090\n    model: x\n", // unterminated quote
      '- id: dsh-tui\n  config:\n    provider: qwen5090\n    model: qwen3.8-27b\n    model: other\n', // duplicate key
      'dsh-tui:\n  provider: qwen5090\n', // not a sequence
    ];
    for (const patch of broken) {
      expect(await read(makeHome({ profiles: { 'dsh-tui': { patch } } })), patch).toBeNull();
    }
    // The home layer is read too: a broken one blanks a good profile layer.
    const home = makeHome({ profiles: { 'dsh-tui': { patch: PROFILE_LAYER } }, homePatch: '- id: [\n' });
    expect(await read(home)).toBeNull();
  });

  it('a layer that is a symlink out of the dsh home: nothing; one inside it is followed', async () => {
    const home = makeHome({ profiles: { 'dsh-tui': {} } });
    const outside = join(home, '..', 'outside.yml');
    writeFileSync(outside, PROFILE_LAYER);
    symlinkSync(outside, join(home, 'profiles', 'dsh-tui', 'cordis.patch.yml'));
    expect(await read(home)).toBeNull();

    const inside = makeHome({ profiles: { 'dsh-tui': {} } });
    writeFileSync(join(inside, 'shared-route.yml'), PROFILE_LAYER);
    symlinkSync(join(inside, 'shared-route.yml'), join(inside, 'profiles', 'dsh-tui', 'cordis.patch.yml'));
    expect(await read(inside)).toBe('qwen3.8-27b');
  });

  it("a session's own DSH_HOME is the one read", async () => {
    const server = makeHome({ profiles: { 'dsh-tui': { patch: PROFILE_LAYER } } });
    const own = makeHome({
      profiles: {
        'dsh-tui': { patch: '- id: dsh-tui\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-pro\n' },
      },
    });
    expect(await read(own, 'dsh-tui', server)).toBe('deepseek-v4-pro');
    expect(await read(server, 'dsh-tui', server)).toBe('qwen3.8-27b');
    // The status bar can be switched off in that home without touching the route.
    expect(effectiveDshHome((k) => (k === 'DSH_HOME' ? own : undefined))).toBe(own);
  });

  it('the home layer outranks the profile layer, and replaces its whole config', async () => {
    const pin = '- id: dsh-tui\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash\n';
    const homeWins = makeHome({ profiles: { 'dsh-tui': { patch: PROFILE_LAYER } }, homePatch: pin });
    expect(await read(homeWins)).toBe('deepseek-v4-flash');
    const half = '- id: dsh-tui\n  config:\n    effort: high\n';
    const halved = makeHome({ profiles: { 'dsh-tui': { patch: PROFILE_LAYER } }, homePatch: half });
    expect(await read(halved)).toBeNull();
  });

  it('no profile named: the one the launch would boot (the first terminal profile)', async () => {
    const home = makeHome({
      profiles: {
        web: { bundles: ['@deepseek-ai/dsh-web-app'] },
        'dsh-tui': { patch: PROFILE_LAYER },
      },
    });
    expect(await read(home, undefined)).toBe('qwen3.8-27b');
    // An invalid name reads as unset at launch, so the default applies here too.
    expect(await read(home, '../web')).toBe('qwen3.8-27b');
  });

  it('a profile that does not compose dsh-TUI: nothing (its route is not this reader’s to know)', async () => {
    const home = makeHome({ profiles: { other: { bundles: ['@someone/other-tui'], patch: PROFILE_LAYER } } });
    expect(await read(home, 'other')).toBeNull();
  });

  it('a disabled row, a name mismatch, a missing home or profile: nothing', async () => {
    const disabled = `${PROFILE_LAYER}- id: dsh-tui\n  disabled: true\n`;
    expect(await read(makeHome({ profiles: { 'dsh-tui': { patch: disabled } } }))).toBeNull();
    const mismatch = '- id: dsh-tui\n  name: "@someone/else"\n  config:\n    provider: a\n    model: b\n';
    expect(await read(makeHome({ profiles: { 'dsh-tui': { patch: mismatch } } }))).toBeNull();
    expect(await read(join(tmpdir(), 'no-such-dsh-home-xyz'))).toBeNull();
    expect(await read(makeHome({ profiles: { 'dsh-tui': { patch: PROFILE_LAYER } } }), 'missing')).toBeNull();
  });

  it('an oversized layer: nothing', async () => {
    const big = PROFILE_LAYER + `# ${'x'.repeat(MAX_ROUTE_FILE_BYTES)}\n`;
    expect(await read(makeHome({ profiles: { 'dsh-tui': { patch: big } } }))).toBeNull();
  });
});

describe('effectiveDshHome', () => {
  it("the session's, else ~/.dsh; a relative value names no place", () => {
    expect(effectiveDshHome(() => '/srv/dsh')).toBe('/srv/dsh');
    expect(effectiveDshHome(() => '  ')).toMatch(/\.dsh$/);
    expect(effectiveDshHome(() => undefined)).toMatch(/\.dsh$/);
    expect(effectiveDshHome(() => 'dsh-copy')).toBeNull();
    expect(effectiveDshHome(() => '~/dsh')).toBeNull();
  });
});

describe('parseDshTuiPatches (the narrow YAML subset)', () => {
  it("reads the owner's two layers", () => {
    expect(parseDshTuiPatches(PROFILE_LAYER)).toEqual([{ config: { provider: 'qwen5090', model: 'qwen3.8-27b' } }]);
    expect(parseDshTuiPatches(HOME_LAYER)).toEqual([]);
  });

  it('an empty list, comments only, and a leading document marker', () => {
    expect(parseDshTuiPatches('[]\n')).toEqual([]);
    expect(parseDshTuiPatches('# nothing yet\n')).toEqual([]);
    expect(parseDshTuiPatches(`---\n${PROFILE_LAYER}`)).toHaveLength(1);
  });

  it('quoted scalars, a key on its own line under `-`, a wider item indent', () => {
    expect(
      parseDshTuiPatches('- id: "dsh-tui"\n  config:\n    provider: "qwen5090"\n    model: \'qwen3.8-27b\'\n')
    ).toEqual([{ config: { provider: 'qwen5090', model: 'qwen3.8-27b' } }]);
    expect(parseDshTuiPatches('-\n  id: dsh-tui\n  config:\n    provider: p\n    model: m # trailing\n')).toEqual([
      { config: { provider: 'p', model: 'm' } },
    ]);
    expect(parseDshTuiPatches('-   id: dsh-tui\n    config:\n      provider: p\n      model: m\n')).toEqual([
      { config: { provider: 'p', model: 'm' } },
    ]);
  });

  it('anything that could change the answer and is beyond the subset: null', () => {
    const cases = [
      '- id: dsh-tui\n  config:\n    provider: !!js process.env.P\n    model: m\n', // a tag
      '- id: dsh-tui\n  config: &route\n    provider: p\n    model: m\n', // an anchor
      '- id: other\n  config: &r { provider: p, model: m }\n- id: dsh-tui\n  config: *r\n', // an alias
      '- id: dsh-tui\n  config:\n    <<: { provider: p, model: m }\n', // a merge key
      '- id: dsh-tui\n  config: { provider: p, model: m }\n', // a flow config
      '- id: dsh-tui\n  config:\n    provider: p\n    model: 12\n', // a number, not a string
      '- id: dsh-tui\n  config:\n    provider: p\n    model: |\n      m\n', // a block scalar
      '- insert:\n    - id: dsh-tui\n      name: x\n', // re-inserting the row
      `${PROFILE_LAYER}---\n- id: dsh-tui\n`, // a second document
      '%YAML 1.2\n---\n- id: dsh-tui\n', // a directive
      // A quoted scalar spanning lines swallows the next "key": YAML reads note as
      // "start model: m" and the route as half-pinned.
      '- id: dsh-tui\n  config:\n    note: "start\n    model: m"\n    provider: p\n',
      // A plain scalar continued on the next line is one value ("m continued").
      '- id: dsh-tui\n  config:\n    provider: p\n    model: m\n      continued\n',
      // A group row whose config re-defines a dsh-tui row inside it.
      '- id: tui-group\n  config:\n    - id: dsh-tui\n      config:\n        provider: p\n        model: m\n',
      '- id: tui-group\n  config:\n  - id: dsh-tui\n    config:\n      provider: p\n      model: m\n',
    ];
    for (const text of cases) expect(parseDshTuiPatches(text), text).toBeNull();
  });

  it('an unrelated item it cannot follow is skipped, one about dsh-tui is not', () => {
    // `rules`' sequence at its key's own indent is valid YAML but beyond the subset.
    const odd = '- id: approval\n  rules:\n  - a\n  config:\n    policy: |\n      line one\n';
    expect(parseDshTuiPatches(`${odd}${PROFILE_LAYER}`)).toEqual([
      { config: { provider: 'qwen5090', model: 'qwen3.8-27b' } },
    ]);
    expect(parseDshTuiPatches(`- id: dsh-tui\n  config:\n    rules:\n  - a\n`)).toBeNull();
  });

  it('a disabled flag, a name, and an empty config', () => {
    expect(parseDshTuiPatches('- id: dsh-tui\n  disabled: true\n  name: x\n  config: {}\n')).toEqual([
      { disabled: true, name: 'x', config: {} },
    ]);
  });
});

describe('resolveDshTuiRouteModel', () => {
  it('the last config wins whole; a layer that could not be read blanks the answer', () => {
    const full = { config: { provider: 'p', model: 'm' } };
    expect(resolveDshTuiRouteModel([[full], []])).toBe('m');
    expect(resolveDshTuiRouteModel([[full], [{ config: { provider: 'p' } }]])).toBeNull();
    expect(resolveDshTuiRouteModel([[full], null])).toBeNull();
    expect(resolveDshTuiRouteModel([[], []])).toBeNull();
    expect(resolveDshTuiRouteModel([[full, { disabled: true }]])).toBeNull();
    expect(resolveDshTuiRouteModel([[full, { name: '@someone/else', config: {} }]])).toBe('m');
  });
});
