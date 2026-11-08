/**
 * @fileoverview scripts/check-local-model-catalog.mjs, the weekly check of the local model
 * catalogue: which build a Mac pulls from a manifest list, the pull total, how a row's drift is
 * classified, the exit code, the report text, and that the IO side only ever asks for
 * manifests, child manifests and configs (never a layer). The network is never used: the IO
 * tests drive a fake registry and a fake GitHub API.
 *
 * The fixtures under test/fixtures/local-model-catalog/ are real bodies the registry served on
 * 2026-11-08 for `qwen3.6:35b-a3b`, byte for byte, so their digests are the real ones.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CheckFailure,
  MANIFEST_ACCEPT,
  MAX_MANIFEST_BYTES,
  MEDIA_TYPE_MANIFEST,
  MEDIA_TYPE_MANIFEST_LIST,
  SIZE_TOLERANCE_FRACTION,
  boundedGet,
  catalogueRunner,
  classifyModel,
  classifyRuntime,
  compareVersions,
  exitCodeFor,
  formatPercent,
  groupDigits,
  inspectModel,
  metadataForConfig,
  normalizeDigest,
  parseVersion,
  pullTotalBytes,
  renderReport,
  runCheck,
  selectMacChild,
  sha256Digest,
  splitModelId,
  withinTolerance,
} from '../scripts/check-local-model-catalog.mjs';

const fixtureDir = resolve(import.meta.dirname, 'fixtures/local-model-catalog');
const fixture = (name: string): Buffer => readFileSync(resolve(fixtureDir, name));

const REAL_LIST = fixture('qwen3.6-35b-a3b.list.json');
const REAL_GGUF_MANIFEST = fixture('qwen3.6-35b-a3b.gguf-manifest.json');
const REAL_MLX_CONFIG = fixture('qwen3.6-35b-a3b.mlx-config.json');

/** The digest of the MLX child the real list names, which a Mac pulled on 2026-11-06. */
const REAL_MLX_CHILD = 'sha256:0ce5ff81f9ffdf89dd8192ca7b5d34cefd8996a875b3aaaaafaf5c4813569eba';
const REAL_GGUF_CHILD = 'sha256:a7eb95c53bcf96b4bdd008d0fab4a5dac88047d9c1a7a9ab88ed453423fbd87c';
/** The pull total a Mac reported for `qwen3.6:35b-a3b`, which the catalogue row stores. */
const MAC_PULL_TOTAL_35B = 23_105_798_956;

const PIN = {
  version: '0.40.15',
  url: 'https://github.com/ollama/ollama/releases/download/v0.40.15/ollama-darwin.tgz',
  bytes: 185_971_671,
  sha256: '607c79d5d6315ef9d896db83adde736a4c0057196329843544e79b95afb260a8',
};

const hex = (char: string): string => `sha256:${char.repeat(64)}`;

describe('the real registry bodies', () => {
  it('carry the digests the registry and a Mac reported for them', () => {
    expect(sha256Digest(REAL_LIST)).toBe('sha256:86b2d171ce90bbb2dcb081933565ec867ce523cdd274bd24c8cf1ef9185feb4f');
    expect(sha256Digest(REAL_GGUF_MANIFEST)).toBe(REAL_GGUF_CHILD);
    expect(sha256Digest(REAL_MLX_CONFIG)).toBe(
      'sha256:577d7d4694896a245c8b00f62bf53a8f4720ded4eba83a8e2da30bb87583bd6b'
    );
  });

  it('a Mac selects the mlx child of the real list, the one whose digest /api/tags reported', () => {
    const list = JSON.parse(REAL_LIST.toString('utf8'));
    expect(list.mediaType).toBe(MEDIA_TYPE_MANIFEST_LIST);
    expect(selectMacChild(list.manifests).digest).toBe(REAL_MLX_CHILD);
  });

  it('the plain GGUF manifest totals its layers plus its config, 2% below what a Mac pulls', () => {
    const manifest = JSON.parse(REAL_GGUF_MANIFEST.toString('utf8'));
    expect(pullTotalBytes(manifest)).toBe(22_621_314_161 + 220);
    expect(classifyModel(
      { id: 'qwen3.6:35b-a3b', bytes: MAC_PULL_TOTAL_35B },
      { mac: { bytes: pullTotalBytes(manifest), digest: REAL_GGUF_CHILD } },
      '0.40.15'
    )).toEqual([expect.objectContaining({ kind: 'size' })]);
  });
});

describe('splitModelId', () => {
  it('splits name and tag', () => {
    expect(splitModelId('qwen3.6:35b-a3b')).toEqual({ name: 'qwen3.6', tag: '35b-a3b' });
  });

  it.each(['qwen3.6', ':35b', 'qwen3.6:', 'evil.example/x:y'])('refuses %s', (id) => {
    expect(() => splitModelId(id)).toThrow(CheckFailure);
  });
});

describe('pullTotalBytes', () => {
  const manifest = (layers: unknown, config: unknown = { size: 250 }) => ({ config, layers });

  it('adds every layer and the config', () => {
    expect(pullTotalBytes(manifest([{ size: 1000 }, { size: 24 }]))).toBe(1274);
  });

  it.each([
    ['no layers', manifest([])],
    ['layers that are not an array', manifest('x')],
    ['a layer without a size', manifest([{ digest: 'x' }])],
    ['a negative size', manifest([{ size: -1 }])],
    ['a size given as text', manifest([{ size: '1000' }])],
    ['a fractional size', manifest([{ size: 1.5 }])],
    ['no config size', manifest([{ size: 1 }], {})],
    ['a total past the safe integers', manifest([{ size: Number.MAX_SAFE_INTEGER }, { size: 10 }])],
  ])('refuses %s', (_label, value) => {
    expect(() => pullTotalBytes(value)).toThrow(CheckFailure);
  });
});

describe('selectMacChild', () => {
  const child = (runner: string, digest: string, mediaType?: string) => ({
    ...(mediaType === undefined ? { mediaType: MEDIA_TYPE_MANIFEST } : { mediaType }),
    digest,
    runner,
  });

  it('prefers mlx, then llamacpp, then ggml, whatever the list order', () => {
    expect(selectMacChild([child('ggml', 'g'), child('llamacpp', 'l'), child('mlx', 'm')]).digest).toBe('m');
    expect(selectMacChild([child('ggml', 'g'), child('llamacpp', 'l')]).digest).toBe('l');
    expect(selectMacChild([child('ggml', 'g')]).digest).toBe('g');
  });

  it('takes the first child of a runner and compares runners as Ollama does', () => {
    expect(selectMacChild([child(' MLX ', 'first'), child('mlx', 'second')]).digest).toBe('first');
  });

  it('skips a nested list and a runner a Mac does not run', () => {
    expect(selectMacChild([child('mlx', 'nested', MEDIA_TYPE_MANIFEST_LIST), child('llamacpp', 'l')]).digest).toBe('l');
    expect(selectMacChild([child('vllm', 'v')])).toBeUndefined();
    expect(selectMacChild('not a list')).toBeUndefined();
  });

  it('accepts a child without a mediaType', () => {
    expect(selectMacChild([{ digest: 'm', runner: 'mlx' }]).digest).toBe('m');
  });
});

describe('small helpers', () => {
  it('metadataForConfig mirrors Ollama: safetensors runs on mlx, gguf on ggml', () => {
    expect(metadataForConfig({ model_format: 'safetensors' })).toEqual({ runner: 'mlx', format: 'safetensors' });
    expect(metadataForConfig({ model_format: 'gguf' })).toEqual({ runner: 'ggml', format: 'gguf' });
    expect(metadataForConfig({})).toEqual({ runner: '', format: '' });
  });

  it('catalogueRunner names a build in the catalogue words: mlx, or llamacpp for any GGUF build', () => {
    expect(catalogueRunner('mlx')).toBe('mlx');
    expect(catalogueRunner(' MLX ')).toBe('mlx');
    expect(catalogueRunner('llamacpp')).toBe('llamacpp');
    // A GGUF manifest that names no runner is `ggml` to Ollama, and llama-server runs it all the same.
    expect(catalogueRunner('ggml')).toBe('llamacpp');
    expect(catalogueRunner(metadataForConfig({ model_format: 'gguf' }).runner)).toBe('llamacpp');
    for (const other of ['', 'vllm', '<img>', undefined, 3]) expect(catalogueRunner(other)).toBeUndefined();
  });

  it('normalizeDigest accepts the prefixed and the bare form and nothing else', () => {
    const bare = '0ce5ff81f9ffdf89dd8192ca7b5d34cefd8996a875b3aaaaafaf5c4813569eba';
    expect(normalizeDigest(bare)).toBe(REAL_MLX_CHILD);
    expect(normalizeDigest(REAL_MLX_CHILD.toUpperCase().replace('SHA256', 'sha256'))).toBe(REAL_MLX_CHILD);
    expect(normalizeDigest('sha256:abc')).toBeUndefined();
    expect(normalizeDigest('sha512:' + 'a'.repeat(64))).toBeUndefined();
    expect(normalizeDigest(42)).toBeUndefined();
  });

  it('parses and compares versions', () => {
    expect(parseVersion('v0.40.15')).toEqual([0, 40, 15]);
    expect(parseVersion('0.32.12')).toEqual([0, 32, 12]);
    expect(parseVersion('0.40.15-rc1')).toBeUndefined();
    expect(compareVersions('0.40.15', 'v0.40.15')).toBe(0);
    expect(compareVersions('0.41.0', '0.40.15')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.40.15')).toBeLessThan(0);
    expect(() => compareVersions('latest', '0.40.15')).toThrow(CheckFailure);
  });

  it('formats numbers without the locale', () => {
    expect(groupDigits(23_105_798_956)).toBe('23,105,798,956');
    expect(groupDigits(250)).toBe('250');
    expect(formatPercent(0.16614)).toBe('+16.61%');
    expect(formatPercent(-0.02097)).toBe('-2.10%');
  });

  it('the tolerance is a small fraction of the row', () => {
    expect(SIZE_TOLERANCE_FRACTION).toBeLessThanOrEqual(0.01);
    expect(withinTolerance(1_000_000, 1_001_000)).toBe(true);
    expect(withinTolerance(1_000_000, 1_001_001)).toBe(false);
  });
});

describe('classifyModel', () => {
  const observed = (bytes: number, extra: Record<string, unknown> = {}) => ({
    mac: { bytes, digest: REAL_MLX_CHILD, runner: 'mlx', format: 'safetensors', ...extra },
  });

  it('a row that holds the pull total itself is clean', () => {
    expect(classifyModel({ id: 'qwen3.6:35b-a3b', bytes: MAC_PULL_TOTAL_35B }, observed(MAC_PULL_TOTAL_35B), '0.40.15')).toEqual([]);
  });

  it('a row sized from its layers alone is clean: the config is a few hundred bytes', () => {
    expect(classifyModel({ id: 'gpt-oss:20b', bytes: 13_793_441_427 }, observed(13_793_441_566), '0.40.15')).toEqual([]);
  });

  it('flags the two real drifts of 2026-11-08: the Mac gets the mlx build', () => {
    const nine = classifyModel({ id: 'qwen3.5:9b', bytes: 6_550_825_373 }, observed(7_639_229_431), '0.40.15');
    expect(nine).toEqual([expect.objectContaining({ kind: 'size', expected: 6_550_825_373, actual: 7_639_229_431 })]);
    expect(nine[0].fraction).toBeCloseTo(0.1661, 3);
    const dense = classifyModel({ id: 'qwen3.8:27b', bytes: 17_741_871_939 }, observed(18_174_721_847), '0.40.15');
    expect(dense[0].kind).toBe('size');
    expect(dense[0].fraction).toBeCloseTo(0.0244, 3);
  });

  it('a tag that is gone is only that', () => {
    expect(classifyModel({ id: 'x:y', bytes: 1 }, { gone: true }, '0.40.15')).toEqual([{ kind: 'gone' }]);
  });

  it('compares a pinned digest in either form', () => {
    const bare = REAL_MLX_CHILD.slice('sha256:'.length);
    expect(classifyModel({ id: 'a:b', bytes: 100, digest: bare }, observed(100), '0.40.15')).toEqual([]);
    expect(classifyModel({ id: 'a:b', bytes: 100, digest: hex('1') }, observed(100), '0.40.15')).toEqual([
      { kind: 'digest', expected: hex('1'), actual: REAL_MLX_CHILD },
    ]);
    expect(classifyModel({ id: 'a:b', bytes: 100, digest: 'garbage' }, observed(100), '0.40.15')[0]).toMatchObject({
      kind: 'digest',
      expected: 'not a sha256 digest',
    });
  });

  it('holds a row that names its runner to the runner of the build a Mac pulls', () => {
    // The same size, another runner: the row's memory figures no longer describe what runs.
    expect(classifyModel({ id: 'a:b', bytes: 100, runner: 'llamacpp' }, observed(100), '0.40.15')).toEqual([
      { kind: 'runner', expected: 'llamacpp', actual: 'mlx' },
    ]);
    expect(classifyModel({ id: 'a:b', bytes: 100, runner: 'mlx' }, observed(100), '0.40.15')).toEqual([]);
    // A GGUF build is a llamacpp row's, whether its manifest says llamacpp or nothing (ggml).
    for (const runner of ['llamacpp', 'ggml']) {
      const gguf = observed(100, { runner, format: 'gguf' });
      expect(classifyModel({ id: 'a:b', bytes: 100, runner: 'llamacpp' }, gguf, '0.40.15'), runner).toEqual([]);
      expect(classifyModel({ id: 'a:b', bytes: 100, runner: 'mlx' }, gguf, '0.40.15'), runner).toEqual([
        { kind: 'runner', expected: 'mlx', actual: 'llamacpp' },
      ]);
    }
    // A runner Ollama would not run on a Mac is never taken for the row's.
    expect(classifyModel({ id: 'a:b', bytes: 100, runner: 'mlx' }, observed(100, { runner: '' }), '0.40.15')).toEqual([
      { kind: 'runner', expected: 'mlx', actual: 'unknown' },
    ]);
    // A catalogue without the field (before rows named their runner) is never held to one.
    expect(classifyModel({ id: 'a:b', bytes: 100 }, observed(100, { runner: 'llamacpp' }), '0.40.15')).toEqual([]);
  });

  it('flags a build that needs a newer runtime than the pin, and only that', () => {
    expect(classifyModel({ id: 'a:b', bytes: 100 }, observed(100, { requires: '0.41.0' }), '0.40.15')).toEqual([
      { kind: 'requires', requires: '0.41.0', pinned: '0.40.15' },
    ]);
    expect(classifyModel({ id: 'a:b', bytes: 100 }, observed(100, { requires: '0.40.15' }), '0.40.15')).toEqual([]);
    expect(classifyModel({ id: 'a:b', bytes: 100 }, observed(100), '0.40.15')).toEqual([]);
  });
});

describe('classifyRuntime', () => {
  const release = (version: string, asset?: { size: number; digest?: string }) => ({ version, publishedOn: '2026-11-03', asset });
  const matching = { size: PIN.bytes, digest: `sha256:${PIN.sha256}` };

  it('is clean when the pin is the newest release and its archive is unchanged', () => {
    expect(classifyRuntime(PIN, { latest: release('0.40.15', matching), pinned: release('0.40.15', matching) })).toEqual([]);
  });

  it('a size that matches and no digest in the API is not drift', () => {
    expect(
      classifyRuntime(PIN, { latest: release('0.40.15'), pinned: release('0.40.15', { size: PIN.bytes }) })
    ).toEqual([]);
  });

  it('reports a newer release', () => {
    expect(classifyRuntime(PIN, { latest: release('0.41.2'), pinned: release('0.40.15', matching) })).toEqual([
      { kind: 'behind', pinned: '0.40.15', latest: '0.41.2' },
    ]);
  });

  it('reports a pinned release or archive that is gone or changed', () => {
    const latest = release('0.40.15');
    expect(classifyRuntime(PIN, { latest, pinned: { gone: true } })).toEqual([{ kind: 'pinned-release-gone' }]);
    expect(classifyRuntime(PIN, { latest, pinned: release('0.40.15') })).toEqual([{ kind: 'pinned-asset-gone' }]);
    expect(
      classifyRuntime(PIN, { latest, pinned: release('0.40.15', { size: PIN.bytes + 1, digest: matching.digest }) })[0].kind
    ).toBe('pinned-asset-changed');
    expect(
      classifyRuntime(PIN, { latest, pinned: release('0.40.15', { size: PIN.bytes, digest: hex('2') }) })[0].kind
    ).toBe('pinned-asset-changed');
  });
});

// ---------- Exit code and report ----------

function baseResult(overrides: Record<string, unknown> = {}) {
  const mac = { bytes: 100, digest: hex('a'), runner: 'mlx', format: 'safetensors', requires: '0.32.4' };
  return {
    checkedAt: '2026-11-09 06:00 UTC',
    catalogue: { updated: '2026-11-06' },
    pin: { version: '0.40.15' },
    errors: [] as string[],
    models: [{ id: 'a:b', bytes: 100, findings: [] as unknown[], observed: { tagDigest: hex('b'), variants: [mac], mac } }],
    runtime: {
      assetName: 'ollama-darwin.tgz',
      findings: [] as unknown[],
      observed: {
        latest: { version: '0.40.15', publishedOn: '2026-11-03', asset: { size: PIN.bytes, digest: `sha256:${PIN.sha256}` } },
        pinned: { version: '0.40.15', publishedOn: '2026-11-03', asset: { size: PIN.bytes, digest: `sha256:${PIN.sha256}` } },
      },
    } as Record<string, unknown>,
    ...overrides,
  };
}

describe('exitCodeFor', () => {
  it('is 0 when nothing drifted', () => {
    expect(exitCodeFor(baseResult())).toBe(0);
  });

  it('is 1 for drift in a model or in the runtime', () => {
    const result = baseResult();
    result.models[0].findings = [{ kind: 'gone' }];
    expect(exitCodeFor(result)).toBe(1);
    const runtime = baseResult();
    (runtime.runtime.findings as unknown[]).push({ kind: 'behind', pinned: '0.40.15', latest: '0.41.0' });
    expect(exitCodeFor(runtime)).toBe(1);
  });

  it('is 2 when any part failed, even with drift elsewhere', () => {
    const result = baseResult();
    result.models[0].findings = [{ kind: 'gone' }];
    result.models.push({ id: 'c:d', bytes: 1, findings: [], error: 'timed out' } as never);
    expect(exitCodeFor(result)).toBe(2);
    expect(exitCodeFor(baseResult({ runtime: { error: 'GitHub answered 403', findings: [] } }))).toBe(2);
    expect(exitCodeFor(baseResult({ errors: ['the catalogue did not load'] }))).toBe(2);
  });
});

describe('renderReport', () => {
  it('says clean, and lists the digests to pin in full with the build a Mac pulls', () => {
    const report = renderReport(baseResult());
    expect(report).toMatch(/^# Local model catalogue: weekly check\n/);
    expect(report).toContain('**Clean**');
    expect(report).toContain(`| \`a:b\` | mlx, safetensors | \`${hex('b')}\` | \`${hex('a')}\` |`);
    expect(report).toContain('as the row field `digest`');
    expect(report).not.toContain('Pin first');
    expect(report).toContain('## Not checked');
  });

  it('asks to pin a row with measured figures first', () => {
    const result = baseResult();
    (result.models[0] as Record<string, unknown>).figures = 'measured';
    expect(renderReport(result)).toContain('Pin first: `a:b`.');
  });

  it('names a size drift with both figures and every build the tag offers', () => {
    const gguf = { bytes: 90, digest: hex('c'), runner: 'llamacpp', format: 'gguf' };
    const mac = { bytes: 7_639_229_431, digest: hex('a'), runner: 'mlx', format: 'safetensors' };
    const result = baseResult({
      models: [
        {
          id: 'qwen3.5:9b',
          bytes: 6_550_825_373,
          findings: classifyModel({ id: 'qwen3.5:9b', bytes: 6_550_825_373 }, { mac }, '0.40.15'),
          observed: { tagDigest: hex('b'), variants: [gguf, mac], mac },
        },
      ],
    });
    const report = renderReport(result);
    expect(report).toContain('**Drift found**: 1 of 1 models.');
    expect(report).toContain('| `qwen3.5:9b` | 6,550,825,373 | 7,639,229,431 | +16.61% | mlx, safetensors |');
    expect(report).toContain('mlx, safetensors 7,639,229,431 (a Mac takes this one)');
    expect(report).toContain('llamacpp, gguf 90');
  });

  it('names a runner change, what it means for the figures, and every build the tag offers', () => {
    const gguf = { bytes: 100, digest: hex('c'), runner: 'llamacpp', format: 'gguf' };
    const mac = { bytes: 100, digest: hex('a'), runner: 'mlx', format: 'safetensors' };
    const result = baseResult({
      models: [
        {
          id: 'qwen3.6:35b-a3b-mtp-q4_k_m',
          bytes: 100,
          findings: classifyModel({ id: 'x:y', bytes: 100, runner: 'llamacpp' }, { mac }, '0.40.15'),
          observed: { tagDigest: hex('b'), variants: [gguf, mac], mac },
        },
      ],
    });
    const report = renderReport(result);
    expect(report).toContain('**Drift found**: 1 of 1 models.');
    expect(report).toContain('| runner changed |');
    expect(report).toContain(
      "`qwen3.6:35b-a3b-mtp-q4_k_m`: a Mac now pulls the mlx, safetensors build, which runs on `mlx`, while the row's `runner` says `llamacpp`."
    );
    expect(report).toContain('recompute them for the new runner');
    expect(report).toContain('mlx, safetensors 100 (a Mac takes this one)');
  });

  it('says the check failed and prints no verdict of clean', () => {
    const result = baseResult({ runtime: { error: 'GitHub answered 403 for the newest release', findings: [] } });
    const report = renderReport(result);
    expect(report).toContain('**The check failed**');
    expect(report).not.toContain('**Clean**');
    expect(report).toContain('GitHub answered 403');
  });

  it('never prints a runner or format outside the known names', () => {
    const mac = { bytes: 100, digest: hex('a'), runner: '<img src=x>', format: '@someone' };
    const report = renderReport(baseResult({ models: [{ id: 'a:b', bytes: 100, findings: [], observed: { tagDigest: hex('b'), variants: [mac], mac } }] }));
    expect(report).toContain('unknown, unknown');
    expect(report).not.toContain('<img');
    expect(report).not.toContain('@someone');
  });

  it('keeps an error on one line and without backticks', () => {
    const result = baseResult({ errors: ['line one\nline `two`\u0007'] });
    expect(renderReport(result)).toContain("- Check failed: line one line 'two'\n");
  });

  it('contains no em-dash', () => {
    expect(renderReport(baseResult())).not.toContain(String.fromCharCode(0x2014));
  });
});

// ---------- IO against a fake registry ----------

interface Seen {
  url: string;
  headers: Record<string, string>;
  signal: unknown;
}

/**
 * A fake registry and GitHub API. `routes` maps a URL to a body (string or Buffer) or a status
 * number. Every request is recorded.
 */
function fakeFetch(routes: Record<string, string | Buffer | number | (() => Response)>) {
  const seen: Seen[] = [];
  const fetchFn = async (url: string, init: { headers: Record<string, string>; signal: unknown }) => {
    seen.push({ url, headers: init.headers, signal: init.signal });
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404 });
    if (typeof route === 'number') return new Response('', { status: route });
    if (typeof route === 'function') return route();
    return new Response(route, { status: 200 });
  };
  return { fetchFn, seen };
}

const REG = 'https://registry.ollama.ai/v2/library';
const GH = 'https://api.github.com/repos/ollama/ollama/releases';

/** A small registry: one tag that is a list (mlx + llamacpp), one plain tag. Digests computed. */
function buildRegistry() {
  const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
  const mlxConfig = json({ model_format: 'safetensors', requires: '0.32.4' });
  const ggufConfig = json({ model_format: 'gguf', requires: '0.30.0' });
  const layers = (sizes: number[], tag: string) =>
    sizes.map((size, i) => ({ mediaType: 'application/vnd.ollama.image.tensor', digest: hex(String((i + tag.length) % 10)), size }));
  const mlxChild = json({
    schemaVersion: 2,
    mediaType: MEDIA_TYPE_MANIFEST,
    config: { digest: sha256Digest(mlxConfig), size: mlxConfig.length },
    layers: layers([700, 300], 'mlx'),
  });
  const ggufChild = json({
    schemaVersion: 2,
    mediaType: MEDIA_TYPE_MANIFEST,
    config: { digest: sha256Digest(ggufConfig), size: ggufConfig.length },
    layers: layers([600], 'gguf'),
    runner: 'llamacpp',
    format: 'gguf',
  });
  const list = json({
    schemaVersion: 2,
    mediaType: MEDIA_TYPE_MANIFEST_LIST,
    manifests: [
      { mediaType: MEDIA_TYPE_MANIFEST, digest: sha256Digest(mlxChild), runner: 'mlx', format: 'safetensors' },
      { mediaType: MEDIA_TYPE_MANIFEST, digest: sha256Digest(ggufChild), runner: 'llamacpp', format: 'gguf' },
    ],
  });
  const plain = json({
    schemaVersion: 2,
    mediaType: MEDIA_TYPE_MANIFEST,
    config: { digest: sha256Digest(ggufConfig), size: ggufConfig.length },
    layers: layers([500], 'plain'),
  });
  const release = (tag: string) =>
    json({
      tag_name: tag,
      published_at: '2026-11-03T22:52:31Z',
      assets: [{ name: 'ollama-darwin.tgz', size: PIN.bytes, digest: `sha256:${PIN.sha256}` }],
    });
  const routes: Record<string, string | Buffer | number | (() => Response)> = {
    [`${REG}/listed/manifests/1b`]: list,
    [`${REG}/listed/blobs/${sha256Digest(mlxChild)}`]: mlxChild,
    [`${REG}/listed/blobs/${sha256Digest(ggufChild)}`]: ggufChild,
    [`${REG}/listed/blobs/${sha256Digest(mlxConfig)}`]: mlxConfig,
    [`${REG}/plain/manifests/2b`]: plain,
    [`${REG}/plain/blobs/${sha256Digest(ggufConfig)}`]: ggufConfig,
    [`${GH}/latest`]: release('v0.40.15'),
    [`${GH}/tags/v0.40.15`]: release('v0.40.15'),
  };
  const layerDigests = new Set(
    [mlxChild, ggufChild, plain].flatMap((body) => JSON.parse(body.toString()).layers.map((l: { digest: string }) => l.digest))
  );
  return {
    routes,
    layerDigests,
    sizes: { mlx: 1000 + mlxConfig.length, gguf: 600 + ggufConfig.length, plain: 500 + ggufConfig.length },
    digests: { list: sha256Digest(list), mlxChild: sha256Digest(mlxChild), plain: sha256Digest(plain) },
  };
}

const catalogOf = (models: { id: string; bytes: number; digest?: string; figures?: string; runner?: string }[]) => ({
  updated: '2026-11-06',
  models,
});
const NOW = new Date('2026-11-09T06:00:00Z');

describe('inspectModel', () => {
  it('reads a list the way a Mac does: the mlx child, its total, its requires', async () => {
    const registry = buildRegistry();
    const { fetchFn, seen } = fakeFetch(registry.routes);
    const observed = await inspectModel(fetchFn, 'listed:1b');
    expect(observed.tagDigest).toBe(registry.digests.list);
    expect(observed.mac).toMatchObject({
      runner: 'mlx',
      format: 'safetensors',
      digest: registry.digests.mlxChild,
      bytes: registry.sizes.mlx,
      requires: '0.32.4',
    });
    expect(observed.variants.map((variant: { runner: string }) => variant.runner)).toEqual(['mlx', 'llamacpp']);
    expect(seen[0].headers.Accept).toBe(MANIFEST_ACCEPT);
    expect(seen[0].headers.Accept).toContain(MEDIA_TYPE_MANIFEST_LIST);
    expect(seen.every((request) => request.signal instanceof AbortSignal)).toBe(true);
  });

  it('fills a plain manifest without runner metadata from its config', async () => {
    const registry = buildRegistry();
    const { fetchFn } = fakeFetch(registry.routes);
    const observed = await inspectModel(fetchFn, 'plain:2b');
    expect(observed.mac).toMatchObject({ runner: 'ggml', format: 'gguf', digest: registry.digests.plain, bytes: registry.sizes.plain });
    expect(observed.tagDigest).toBe(observed.mac.digest);
  });

  it('a 404 for the manifest is a tag that is gone', async () => {
    const { fetchFn } = fakeFetch({});
    expect(await inspectModel(fetchFn, 'missing:tag')).toEqual({ gone: true });
  });

  it('refuses a blob whose body does not match its digest', async () => {
    const registry = buildRegistry();
    const mlxUrl = `${REG}/listed/blobs/${registry.digests.mlxChild}`;
    const { fetchFn } = fakeFetch({ ...registry.routes, [mlxUrl]: '{"tampered":true}' });
    await expect(inspectModel(fetchFn, 'listed:1b')).rejects.toThrow(/does not match its digest/);
  });

  it('refuses a list with no build a Mac runs', async () => {
    const list = JSON.stringify({ mediaType: MEDIA_TYPE_MANIFEST_LIST, manifests: [{ digest: hex('1'), runner: 'vllm' }] });
    const { fetchFn } = fakeFetch({ [`${REG}/odd/manifests/x`]: list });
    await expect(inspectModel(fetchFn, 'odd:x')).rejects.toThrow(/no build a Mac runs/);
  });

  it('a server error is a failed check, not a tag that is gone', async () => {
    const { fetchFn } = fakeFetch({ [`${REG}/flaky/manifests/x`]: 503 });
    await expect(inspectModel(fetchFn, 'flaky:x')).rejects.toThrow(/answered 503/);
  });
});

describe('boundedGet', () => {
  it('refuses a declared body over the cap before reading it', async () => {
    const { fetchFn } = fakeFetch({
      'https://x.test/big': () => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_MANIFEST_BYTES + 1) } }),
    });
    await expect(boundedGet(fetchFn, 'https://x.test/big', { maxBytes: MAX_MANIFEST_BYTES })).rejects.toThrow(/over the cap/);
  });

  it('refuses a streamed body that grows past the cap', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    const { fetchFn } = fakeFetch({ 'https://x.test/stream': () => new Response(stream, { status: 200 }) });
    await expect(boundedGet(fetchFn, 'https://x.test/stream', { maxBytes: 1000 })).rejects.toThrow(/over the cap/);
  });

  it('turns a network error into a CheckFailure', async () => {
    const fetchFn = async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND registry.ollama.ai') });
    };
    await expect(boundedGet(fetchFn, 'https://registry.ollama.ai/v2/', { maxBytes: 10 })).rejects.toThrow(/ENOTFOUND/);
  });
});

describe('runCheck', () => {
  it('reports drift, and fetches only manifests, child manifests, configs and the two releases', async () => {
    const registry = buildRegistry();
    const { fetchFn, seen } = fakeFetch(registry.routes);
    const result = await runCheck({
      catalog: catalogOf([
        // Sized from the llamacpp child: a Mac pulls the mlx one, so this is drift.
        { id: 'listed:1b', bytes: registry.sizes.gguf },
        { id: 'plain:2b', bytes: registry.sizes.plain },
        { id: 'missing:tag', bytes: 1000 },
      ]),
      pin: PIN,
      fetchFn,
      now: NOW,
      githubToken: 'token-value',
    });

    expect(result.models.map((model: { findings: { kind: string }[] }) => model.findings.map((f) => f.kind))).toEqual([
      ['size'],
      [],
      ['gone'],
    ]);
    expect(result.runtime.findings).toEqual([]);
    expect(exitCodeFor(result)).toBe(1);

    for (const request of seen) {
      const blob = /\/blobs\/(sha256:[0-9a-f]{64})$/.exec(request.url);
      if (blob) expect(registry.layerDigests.has(blob[1])).toBe(false);
      const isGitHub = request.url.startsWith('https://api.github.com/');
      expect(request.headers.Authorization === 'Bearer token-value').toBe(isGitHub);
    }
    expect(seen.some((request) => request.url === `${GH}/latest`)).toBe(true);
    expect(seen.some((request) => request.url === `${GH}/tags/v0.40.15`)).toBe(true);

    const report = renderReport(result);
    expect(report).toContain('**Drift found**: 2 of 3 models.');
    expect(report).toContain('`missing:tag`: the registry no longer has this tag');
  });

  it('holds rows that name their runner to the build a Mac pulls, a plain GGUF manifest included', async () => {
    const registry = buildRegistry();
    const { fetchFn } = fakeFetch(registry.routes);
    const result = await runCheck({
      catalog: catalogOf([
        // The right size, the wrong runner: a Mac pulls the mlx child of this list.
        { id: 'listed:1b', bytes: registry.sizes.mlx, runner: 'llamacpp' },
        // A manifest that names no runner is a GGUF build: a llamacpp row, clean.
        { id: 'plain:2b', bytes: registry.sizes.plain, runner: 'llamacpp' },
      ]),
      pin: PIN,
      fetchFn,
      now: NOW,
    });
    expect(result.models.map((model: { findings: unknown[] }) => model.findings)).toEqual([
      [{ kind: 'runner', expected: 'llamacpp', actual: 'mlx' }],
      [],
    ]);
    expect(exitCodeFor(result)).toBe(1);
    expect(renderReport(result)).toContain('| runner changed |');
  });

  it('sends no Authorization header at all without a token', async () => {
    const registry = buildRegistry();
    const { fetchFn, seen } = fakeFetch(registry.routes);
    await runCheck({ catalog: catalogOf([{ id: 'plain:2b', bytes: registry.sizes.plain }]), pin: PIN, fetchFn, now: NOW });
    expect(seen.some((request) => 'Authorization' in request.headers)).toBe(false);
  });

  it('is clean when every row matches what a Mac pulls', async () => {
    const registry = buildRegistry();
    const { fetchFn } = fakeFetch(registry.routes);
    const result = await runCheck({
      catalog: catalogOf([
        { id: 'listed:1b', bytes: registry.sizes.mlx, digest: registry.digests.mlxChild, figures: 'measured' },
        { id: 'plain:2b', bytes: registry.sizes.plain, figures: 'measured' },
      ]),
      pin: PIN,
      fetchFn,
      now: NOW,
    });
    expect(exitCodeFor(result)).toBe(0);
    const report = renderReport(result);
    expect(report).toContain('**Clean**');
    // The pinned row is not offered for pinning again; the unpinned one is.
    expect(report).not.toContain('| `listed:1b` | mlx');
    expect(report).toContain(`| \`plain:2b\` | ggml, gguf | \`${registry.digests.plain}\``);
    // Only the measured row that has no digest yet is asked for first.
    expect(report).toContain('Pin first: `plain:2b`.');
  });

  it('a newer runtime release is drift', async () => {
    const registry = buildRegistry();
    registry.routes[`${GH}/latest`] = JSON.stringify({ tag_name: 'v0.41.0', published_at: '2026-11-10T00:00:00Z', assets: [] });
    const { fetchFn } = fakeFetch(registry.routes);
    const result = await runCheck({ catalog: catalogOf([{ id: 'plain:2b', bytes: registry.sizes.plain }]), pin: PIN, fetchFn, now: NOW });
    expect(result.runtime.findings).toEqual([{ kind: 'behind', pinned: '0.40.15', latest: '0.41.0' }]);
    expect(exitCodeFor(result)).toBe(1);
    expect(renderReport(result)).toContain('Ollama 0.41.0 is out; the pin is 0.40.15.');
  });

  it('a rate-limited GitHub API fails the check (2) and keeps what the models showed', async () => {
    const registry = buildRegistry();
    registry.routes[`${GH}/latest`] = 403;
    const { fetchFn } = fakeFetch(registry.routes);
    const result = await runCheck({
      catalog: catalogOf([{ id: 'listed:1b', bytes: registry.sizes.gguf }]),
      pin: PIN,
      fetchFn,
      now: NOW,
    });
    expect(exitCodeFor(result)).toBe(2);
    expect(result.models[0].findings[0].kind).toBe('size');
    expect(renderReport(result)).toContain('**The check failed**');
  });

  it('a release tag that is not vX.Y.Z fails the check instead of reaching the report', async () => {
    const registry = buildRegistry();
    registry.routes[`${GH}/latest`] = JSON.stringify({ tag_name: 'v1.0.0 @everyone', assets: [] });
    const { fetchFn } = fakeFetch(registry.routes);
    const result = await runCheck({ catalog: catalogOf([]), pin: PIN, fetchFn, now: NOW });
    expect(exitCodeFor(result)).toBe(2);
    expect(renderReport(result)).not.toContain('@everyone');
  });

  it('a network failure for one row fails the whole check', async () => {
    const registry = buildRegistry();
    const fetchFn = async (url: string, init: { headers: Record<string, string>; signal: unknown }) => {
      if (url.includes('/plain/')) throw new TypeError('fetch failed');
      return fakeFetch(registry.routes).fetchFn(url, init);
    };
    const result = await runCheck({
      catalog: catalogOf([
        { id: 'listed:1b', bytes: registry.sizes.mlx },
        { id: 'plain:2b', bytes: registry.sizes.plain },
      ]),
      pin: PIN,
      fetchFn,
      now: NOW,
    });
    expect(result.models[1].error).toMatch(/fetch failed/);
    expect(exitCodeFor(result)).toBe(2);
  });
});
