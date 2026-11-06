/**
 * @fileoverview Tests for src/config/local-model-catalog.ts: the compiled catalogue of models,
 * harnesses and chips, its schema, and the chip lookup.
 *
 * Three things are pinned:
 *
 * 1. The stock constant PARSES. `getLocalModelCatalog()` validates it on first use and throws on
 *    a bad row, so this test is what keeps a bad row from ever reaching the route.
 * 2. The schema refuses what must never get in: a model id that could name another registry
 *    (a slash, a host), an unknown key (a `runtime` block with a download URL), and rows that
 *    break a rule across rows (a repeated id, contexts in the wrong order, a chip row that
 *    hides a more specific one).
 * 3. The chip lookup never guesses: a chip that no row names has no bandwidth, including one
 *    whose name merely contains a known name ('Apple M10', 'Apple M6 Pro').
 *
 * Port: N/A (pure data and functions).
 */

import { describe, expect, it } from 'vitest';
import {
  chipBandwidthGbps,
  chipNameMatches,
  getLocalModelCatalog,
  LOCAL_MODEL_ID_PATTERN,
  LocalModelCatalogSchema,
  STOCK_LOCAL_MODEL_CATALOG,
} from '../src/config/local-model-catalog.js';
import type { LocalModelCatalog, LocalModelEntry } from '../src/types.js';

/** A deep copy of the stock catalogue that a test may break. */
function copy(): LocalModelCatalog {
  return structuredClone(STOCK_LOCAL_MODEL_CATALOG);
}

/** The message of every issue the schema raises for `catalog`, or an empty list when it parses. */
function issuesOf(catalog: unknown): string[] {
  const result = LocalModelCatalogSchema.safeParse(catalog);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

/** The stock catalogue with its first model changed. */
/** `url` is no field of a model row: one test passes it to prove the schema refuses an unknown key. */
function withFirstModel(change: Partial<Record<keyof LocalModelEntry | 'url', unknown>>): unknown {
  const catalog = copy();
  return { ...catalog, models: [{ ...catalog.models[0], ...change }, ...catalog.models.slice(1)] };
}

describe('the stock catalogue', () => {
  it('passes its own schema', () => {
    expect(issuesOf(STOCK_LOCAL_MODEL_CATALOG)).toEqual([]);
  });

  it('is what the getter returns, validated once', () => {
    const first = getLocalModelCatalog();
    expect(first).toEqual(STOCK_LOCAL_MODEL_CATALOG);
    // Parsed on first use, then reused: the same object, not a new parse per request.
    expect(getLocalModelCatalog()).toBe(first);
  });

  it('lists the seven models of the design, without flint:40b', () => {
    expect(STOCK_LOCAL_MODEL_CATALOG.models.map((m) => m.id)).toEqual([
      'qwen3.5:9b',
      'qwen3.5:9b-q8_0',
      'gpt-oss:20b',
      'qwen3.6:35b-a3b',
      'qwen3.8:27b',
      'qwen3.8:27b-q8_0',
      'qwen3.5:122b-a10b',
    ]);
    expect(STOCK_LOCAL_MODEL_CATALOG.models.some((m) => m.id.startsWith('flint'))).toBe(false);
  });

  it('carries the byte sizes of the registry manifests', () => {
    // The sum of the layer sizes of each tag's manifest, as fetched on 2026-11-06.
    expect(Object.fromEntries(STOCK_LOCAL_MODEL_CATALOG.models.map((m) => [m.id, m.bytes]))).toEqual({
      'qwen3.5:9b': 6_550_825_373,
      'qwen3.5:9b-q8_0': 10_449_217_949,
      'gpt-oss:20b': 13_793_441_427,
      'qwen3.6:35b-a3b': 22_621_314_161,
      'qwen3.8:27b': 17_741_871_939,
      'qwen3.8:27b-q8_0': 29_978_241_837,
      'qwen3.5:122b-a10b': 81_370_035_877,
    });
  });

  it('carries the KV cost per token of each model', () => {
    expect(Object.fromEntries(STOCK_LOCAL_MODEL_CATALOG.models.map((m) => [m.id, m.kvBytesPerToken]))).toEqual({
      'qwen3.5:9b': 32_768,
      'qwen3.5:9b-q8_0': 32_768,
      'gpt-oss:20b': 24_576,
      'qwen3.6:35b-a3b': 20_480,
      'qwen3.8:27b': 65_536,
      'qwen3.8:27b-q8_0': 65_536,
      'qwen3.5:122b-a10b': 24_576,
    });
  });

  it('gives every model a parameter count and an empty tested list', () => {
    for (const model of STOCK_LOCAL_MODEL_CATALOG.models) {
      expect(model.paramsB, model.id).toBeGreaterThan(0);
      // Nobody has run any of these with a harness on a Mac yet.
      expect(model.tested, model.id).toEqual([]);
      expect(model.id).toMatch(LOCAL_MODEL_ID_PATTERN);
      expect(model.license).toBe('Apache-2.0');
    }
    // The two 9B rows are the ones under the 12 billion line of the `limited` verdict.
    expect(STOCK_LOCAL_MODEL_CATALOG.models.filter((m) => m.paramsB < 12).map((m) => m.id)).toEqual([
      'qwen3.5:9b',
      'qwen3.5:9b-q8_0',
    ]);
  });

  it('has a speed figure only where one was measured or scaled from a measurement', () => {
    expect(Object.fromEntries(STOCK_LOCAL_MODEL_CATALOG.models.map((m) => [m.id, m.speedPer100Gbps ?? null]))).toEqual({
      'qwen3.5:9b': 9.3,
      'qwen3.5:9b-q8_0': 5.8,
      'gpt-oss:20b': null,
      'qwen3.6:35b-a3b': 13.6,
      'qwen3.8:27b': 2.95,
      'qwen3.8:27b-q8_0': 1.7,
      'qwen3.5:122b-a10b': null,
    });
  });

  it('lists its harnesses as data rows, one of them gated', () => {
    expect(STOCK_LOCAL_MODEL_CATALOG.harnesses).toEqual([
      { cli: 'opencode', minContext: 65536, rank: 3 },
      { cli: 'claude', minContext: 65536, rank: 2, slowFirstTurn: true },
      { cli: 'pi', minContext: 32768, rank: 1, gated: true },
    ]);
  });

  it('counts the prompt cache as 512 MiB below 32 GB and 2 GiB from 32 GB', () => {
    expect(STOCK_LOCAL_MODEL_CATALOG.promptCacheTiers).toEqual([
      { minMemGb: 0, bytes: 512 * 1024 ** 2 },
      { minMemGb: 32, bytes: 2 * 1024 ** 3 },
    ]);
    expect(STOCK_LOCAL_MODEL_CATALOG.minMacosMajor).toBe(14);
    expect(STOCK_LOCAL_MODEL_CATALOG.schema).toBe(1);
  });

  it('holds no download data: no URL, no digest, no runtime block', () => {
    const text = JSON.stringify(STOCK_LOCAL_MODEL_CATALOG);
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toMatch(/sha256/i);
    expect(Object.keys(STOCK_LOCAL_MODEL_CATALOG).sort()).toEqual(
      ['chips', 'harnesses', 'minMacosMajor', 'models', 'promptCacheTiers', 'schema', 'updated'].sort()
    );
  });
});

describe('the model id rule', () => {
  it('accepts name:tag in lowercase', () => {
    for (const id of ['qwen3.5:9b', 'gpt-oss:20b', 'qwen3.8:27b-q8_0', 'a:b', 'x_y.z-1:2.3_4']) {
      expect(LOCAL_MODEL_ID_PATTERN.test(id), id).toBe(true);
    }
  });

  it('refuses anything that could name another registry, namespace or no tag at all', () => {
    const bad = [
      'evil.example/x/y:z',
      'library/qwen3.5:9b',
      'registry.ollama.ai/library/qwen3.5:9b',
      'Qwen3.5:9b',
      'qwen3.5:9B',
      'qwen3.5',
      'qwen3.5:',
      ':9b',
      'qwen3.5:9b:extra',
      'qwen 3.5:9b',
      '-qwen:9b',
      'qwen:-9b',
      'qwen3.5:9b\n',
      '',
    ];
    for (const id of bad) expect(LOCAL_MODEL_ID_PATTERN.test(id), JSON.stringify(id)).toBe(false);
  });

  it('makes the schema reject a catalogue with such an id', () => {
    for (const id of ['evil.example/x/y:z', 'Qwen3.5:9b', 'qwen3.5', 'qwen3.5:9b ']) {
      const issues = issuesOf(withFirstModel({ id }));
      expect(issues, id).toHaveLength(1);
      expect(issues[0]).toContain('models.0.id');
    }
  });
});

describe('the schema, field by field', () => {
  it('refuses a key it does not know, at the top and inside a row', () => {
    // The whole point of having no `runtime` block: a data row can never carry a download URL.
    expect(issuesOf({ ...copy(), runtime: { url: 'https://example.com/x.tgz', sha256: 'abc' } })).not.toEqual([]);
    expect(issuesOf(withFirstModel({ url: 'https://example.com/model' }))).not.toEqual([]);
    const catalog = copy();
    expect(issuesOf({ ...catalog, harnesses: [{ ...catalog.harnesses[0], dialect: 'openai' }] })).not.toEqual([]);
    expect(issuesOf({ ...catalog, chips: [{ match: 'M4', gbps: 120, cores: 10 }] })).not.toEqual([]);
  });

  it('requires paramsB and tested on every model row', () => {
    for (const field of ['paramsB', 'tested'] as const) {
      const row: Record<string, unknown> = { ...copy().models[0] };
      delete row[field];
      const issues = issuesOf({ ...copy(), models: [row] });
      expect(issues, field).toHaveLength(1);
      expect(issues[0]).toContain(`models.0.${field}`);
    }
  });

  it('refuses sizes and counts that are not positive whole numbers', () => {
    expect(issuesOf(withFirstModel({ bytes: 0 }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ bytes: 1.5 }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ kvBytesPerToken: -1 }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ contexts: [] }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ paramsB: 0 }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ speedPer100Gbps: 0 }))).not.toEqual([]);
  });

  it('accepts a tested entry and checks its shape', () => {
    const good = { chip: 'Apple M4', memGb: 16, cli: 'opencode', date: '2026-11-06' };
    expect(issuesOf(withFirstModel({ tested: [good] }))).toEqual([]);
    expect(issuesOf(withFirstModel({ tested: [{ ...good, date: '6 November 2026' }] }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ tested: [{ ...good, memGb: 0 }] }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ tested: [{ ...good, result: 'pass' }] }))).not.toEqual([]);
  });

  it('refuses another schema version and a date that is not ISO', () => {
    expect(issuesOf({ ...copy(), schema: 2 })).not.toEqual([]);
    expect(issuesOf({ ...copy(), updated: 'today' })).not.toEqual([]);
  });
});

describe('the schema, across rows', () => {
  it('refuses a repeated model id', () => {
    const catalog = copy();
    catalog.models[1] = { ...catalog.models[1], id: catalog.models[0].id };
    expect(issuesOf(catalog)).toEqual(['models.1.id: model ids must be unique']);
  });

  it('refuses a repeated model rank, which would leave the order of two models to chance', () => {
    const catalog = copy();
    catalog.models[1] = { ...catalog.models[1], rank: catalog.models[0].rank };
    expect(issuesOf(catalog)).toEqual(['models.1.rank: model ranks must be unique']);
  });

  it('refuses a harness listed twice and a repeated harness rank', () => {
    const twice = copy();
    twice.harnesses.push({ cli: twice.harnesses[0].cli, minContext: 32768, rank: 9 });
    expect(issuesOf(twice)).toEqual(['harnesses.3.cli: a harness may be listed only once']);

    const sameRank = copy();
    sameRank.harnesses[1] = { ...sameRank.harnesses[1], rank: sameRank.harnesses[0].rank };
    expect(issuesOf(sameRank)).toEqual(['harnesses.1.rank: harness ranks must be unique']);
  });

  it('refuses contexts that are not listed largest first, or that repeat', () => {
    expect(issuesOf(withFirstModel({ contexts: [32768, 65536] }))).toEqual([
      'models.0.contexts.1: contexts must be listed largest first, without repeats',
    ]);
    expect(issuesOf(withFirstModel({ contexts: [65536, 65536] }))).toEqual([
      'models.0.contexts.1: contexts must be listed largest first, without repeats',
    ]);
  });

  it('refuses a tested entry for a harness the catalogue does not list', () => {
    const entry = { chip: 'Apple M4', memGb: 16, cli: 'not-a-harness', date: '2026-11-06' };
    expect(issuesOf(withFirstModel({ tested: [entry] }))).toEqual([
      'models.0.tested.0.cli: a tested entry must name a harness of this catalogue',
    ]);
  });

  it('refuses chips that are not listed most specific first', () => {
    const catalog = copy();
    catalog.chips = [
      { match: 'M4', gbps: 120 },
      { match: 'M4 Max', gbps: 410 },
    ];
    expect(issuesOf(catalog)).toEqual([
      "chips.1.match: chips must be listed most specific first: 'M4' comes before 'M4 Max'",
    ]);

    const repeated = copy();
    repeated.chips = [
      { match: 'M4', gbps: 120 },
      { match: 'm4', gbps: 130 },
    ];
    expect(issuesOf(repeated)).toHaveLength(1);
  });

  it('refuses prompt cache tiers that do not start at 0 or do not ascend', () => {
    const late = copy();
    late.promptCacheTiers = [{ minMemGb: 16, bytes: 1 }];
    expect(issuesOf(late)).toEqual(['promptCacheTiers.0.minMemGb: the first prompt cache tier must start at 0']);

    const unordered = copy();
    unordered.promptCacheTiers = [
      { minMemGb: 0, bytes: 1 },
      { minMemGb: 32, bytes: 2 },
      { minMemGb: 24, bytes: 3 },
    ];
    expect(issuesOf(unordered)).toEqual(['promptCacheTiers.2.minMemGb: prompt cache tiers must ascend by minMemGb']);
  });
});

describe('the chips table', () => {
  const chips = STOCK_LOCAL_MODEL_CATALOG.chips;

  it('holds every chip of the source table that shipped', () => {
    // Bandwidth column of https://github.com/ggml-org/llama.cpp/discussions/4167, read on
    // 2026-11-06. A name that covers two bandwidths has the lower one.
    expect(Object.fromEntries(chips.map((row) => [row.match, row.gbps]))).toEqual({
      'M5 Ultra': 1228,
      'M3 Ultra': 800,
      'M2 Ultra': 800,
      'M1 Ultra': 800,
      'M5 Max': 460,
      'M4 Max': 410,
      'M3 Max': 300,
      'M2 Max': 400,
      'M1 Max': 400,
      'M5 Pro': 307,
      'M4 Pro': 273,
      'M3 Pro': 150,
      'M2 Pro': 200,
      'M1 Pro': 200,
      M5: 154,
      M4: 120,
      M3: 100,
      M2: 100,
      M1: 68,
    });
  });

  it('finds each row under the name macOS reports for that chip', () => {
    // No row is hidden by an earlier one: 'Apple M4 Max' is 410, not the 120 of 'M4'.
    for (const row of chips) {
      expect(chipBandwidthGbps(chips, `Apple ${row.match}`), row.match).toBe(row.gbps);
    }
  });

  it('knows the chips of the two test Macs', () => {
    expect(chipBandwidthGbps(chips, 'Apple M4')).toBe(120);
    expect(chipBandwidthGbps(chips, 'Apple M5 Pro')).toBe(307);
  });

  it('never guesses: a chip that no row names has no bandwidth', () => {
    const unknown = [
      // A base chip that is not in the table.
      'Apple M6',
      // A variant the table has never heard of must not borrow the figure of its base chip.
      'Apple M6 Pro',
      'Apple M4 Ultra',
      'Apple M5 Extreme',
      // A name that merely contains a known name.
      'Apple M10',
      'Apple M12 Pro',
      'Apple M1 Max (Virtual)',
      'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz',
      'VirtualApple @ 2.50GHz processor',
      'Max',
      '',
    ];
    for (const chip of unknown) expect(chipBandwidthGbps(chips, chip), chip).toBeUndefined();
    expect(chipBandwidthGbps(chips, undefined)).toBeUndefined();
    expect(chipBandwidthGbps([], 'Apple M4')).toBeUndefined();
  });
});

describe('chipNameMatches', () => {
  it('matches the whole chip name at the end of the string, ignoring case and padding', () => {
    expect(chipNameMatches('Apple M4 Pro', 'M4 Pro')).toBe(true);
    expect(chipNameMatches('Apple M4', 'M4')).toBe(true);
    expect(chipNameMatches('M4', 'M4')).toBe(true);
    expect(chipNameMatches('  apple m4 pro ', 'M4 PRO')).toBe(true);
  });

  it('does not match a part of a longer name', () => {
    expect(chipNameMatches('Apple M4 Pro', 'M4')).toBe(false);
    expect(chipNameMatches('Apple M14', 'M4')).toBe(false);
    expect(chipNameMatches('Apple M10', 'M1')).toBe(false);
    expect(chipNameMatches('Apple XM4', 'M4')).toBe(false);
    expect(chipNameMatches('Apple M4', '')).toBe(false);
    expect(chipNameMatches('', 'M4')).toBe(false);
  });
});
