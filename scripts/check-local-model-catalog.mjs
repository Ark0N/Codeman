#!/usr/bin/env -S npx tsx
/**
 * The weekly check of the local model catalogue (src/config/local-model-catalog.ts) and of the
 * pinned model runtime (OLLAMA_RUNTIME_PIN in src/local-model/runtime.ts) against what the
 * registry and Ollama's releases serve today.
 *
 *   npx tsx scripts/check-local-model-catalog.mjs      # markdown report on stdout
 *   npm run check:local-model-catalog                  # the same
 *
 * Exit code: 0 nothing drifted, 1 drift found, 2 the check itself failed (network, an answer
 * that does not parse, a catalogue that does not validate). On 2 the report is still printed
 * with everything that was found, but it is incomplete, so nothing should act on it.
 * `.github/workflows/local-model-catalog.yml` runs it every Monday and keeps one issue current.
 *
 * Runs under tsx because it imports the TypeScript catalogue and pin, and imports them only in
 * main(), so the test imports the pure parts without them.
 *
 * WHAT A MAC DOWNLOADS. A tag is not one build. Asked with the Accept header Ollama 0.40.15
 * sends (`pullModelManifest` in server/images.go), the registry answers a manifest LIST for
 * some tags, one child per runner, and Ollama on Apple silicon takes the first child whose
 * runner is `mlx`, else `llamacpp`, else `ggml` (`runnerPreferences()` in manifest/manifest.go).
 * Asked with the plain Docker Accept header the registry answers the llamacpp child instead,
 * which is NOT what a Mac pulls: that is how `qwen3.6:35b-a3b` came to be "2% above its
 * manifest" in the catalogue header. So this check asks the way Ollama asks, picks the child
 * the way a Mac picks it, and compares the row's `bytes` with that child's pull total (every
 * layer plus the config, which is exactly the `total` a real pull reported on a Mac). A row
 * that names its `runner` is also held to that child's runner (`catalogueRunner()`), because
 * the memory figures of a row follow its runner and a change of runner can come with almost
 * the same size.
 *
 * WHAT IS FETCHED, and nothing else:
 *  - `GET /v2/library/<name>/manifests/<tag>`, the tag's manifest or manifest list.
 *  - For a list: `GET /v2/library/<name>/blobs/<digest>` for each child the list names. A child
 *    manifest is stored as a blob (Ollama fetches it the same way, `pullSelectedManifest`). It
 *    is metadata: about 220 KB for an MLX build of 1,055 tensors.
 *  - `GET .../blobs/<digest>` for the config of the child a Mac selects, a few hundred bytes,
 *    for its `requires` (the oldest Ollama that may pull it).
 *  - The GitHub API: the newest release of ollama/ollama, and the release of the pinned version.
 * A digest from a `layers` entry is never requested: no model weights are ever downloaded.
 * Every request has its own timeout and a byte cap, nothing is retried, every blob is checked
 * against its digest, and `GITHUB_TOKEN` is sent to api.github.com only, when it is set.
 *
 * THE DIGEST CONTRACT. A row may pin the build it describes as `digest`: the digest of the
 * manifest a Mac pulls, which is the value `/api/tags` reports after the pull (`sha256:<hex>` or
 * the bare hex). The catalogue schema does not have that field yet: `LocalModelEntrySchema` is
 * strict, so it must gain an optional `digest` before a row can carry one, under exactly that
 * name, or this check never compares it. The catalogue keeps no digest today on purpose
 * (test/local-model-catalog.test.ts, "holds no download data", refuses a `sha256` in it), so
 * pinning digests changes that rule too: a decision for the catalogue, not for this script.
 * Until then the report lists the digests to pin, and a rebuild of about the same size goes
 * unnoticed (a change of build, mlx against gguf, never does: every pair seen so far differs
 * by 2% or more, far past the size tolerance, and a row that names its runner is held to it).
 *
 * Everything that reaches the report from the network is validated first (digests, sizes,
 * runner and format names, version tags), because the workflow puts the report in an issue.
 *
 * NOT CHECKED: the memory figures, the speeds and whether a coding agent works with a model.
 * No manifest says anything about those; they change only when somebody measures on a Mac.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- Constants ----------

export const REGISTRY_BASE = 'https://registry.ollama.ai';
export const GITHUB_API_BASE = 'https://api.github.com';
/** The repository whose releases the runtime pin follows. */
export const RUNTIME_REPO = 'ollama/ollama';

export const MEDIA_TYPE_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
export const MEDIA_TYPE_MANIFEST_LIST = 'application/vnd.ollama.manifest.list.v2+json';
/** The Accept header of Ollama 0.40.15's own manifest request: the list first. */
export const MANIFEST_ACCEPT = `${MEDIA_TYPE_MANIFEST_LIST}, ${MEDIA_TYPE_MANIFEST}`;

/** The runner order of Ollama 0.40.15 on darwin/arm64 (`runnerPreferences()`). */
export const MAC_RUNNER_PREFERENCE = Object.freeze(['mlx', 'llamacpp', 'ggml']);
/** Format names the report prints as they are. Anything else is printed as `unknown`. */
export const KNOWN_FORMATS = Object.freeze(['safetensors', 'gguf']);

/**
 * How far the size a Mac downloads may sit from the row's `bytes` before it is drift: 0.1%.
 * The rows that were sized from layers alone sit a few hundred bytes (the config) below the
 * pull total; any rebuilt model moves by far more than this.
 */
export const SIZE_TOLERANCE_FRACTION = 0.001;

/** One request may take this long, connection and body together. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** A manifest or child manifest larger than this is refused. The MLX build of the 35B is 220 KB. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** A config blob larger than this is refused. They are a few hundred bytes. */
export const MAX_CONFIG_BYTES = 64 * 1024;
/** A GitHub release answer larger than this is refused. */
export const MAX_GITHUB_BYTES = 4 * 1024 * 1024;
/** A manifest list with more children than this is refused. */
export const MAX_LIST_CHILDREN = 8;
/** A manifest with more layers than this is refused. */
export const MAX_LAYERS = 20_000;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const VERSION_PATTERN = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const RELEASE_TAG_PATTERN = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const ISO_DAY_PATTERN = /^(\d{4}-\d{2}-\d{2})T/;
const USER_AGENT = 'codeman-local-model-catalog-check';

/** The check could not finish: the run ends with exit code 2. */
export class CheckFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckFailure';
  }
}

// ---------- Pure helpers ----------

/** `name:tag` into its two parts. The catalogue's pattern already rules out a slash. */
export function splitModelId(id) {
  const colon = id.indexOf(':');
  if (colon <= 0 || colon === id.length - 1 || id.includes('/')) throw new CheckFailure(`not a name:tag model id: ${id}`);
  return { name: id.slice(0, colon), tag: id.slice(colon + 1) };
}

/** `sha256:<hex>` of a body, the way the registry names it. */
export function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A digest as `sha256:<64 hex>`, accepting the bare hex `/api/tags` prints. Anything else: undefined. */
export function normalizeDigest(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  const full = text.startsWith('sha256:') ? text : `sha256:${text}`;
  return DIGEST_PATTERN.test(full) ? full : undefined;
}

/** A runner name as Ollama compares it (lowercase, trimmed). */
export function canonicalRunner(runner) {
  return typeof runner === 'string' ? runner.trim().toLowerCase() : '';
}

/** A runner or format name for the report: one of the known names, else `unknown`. */
export function displayName(value, known) {
  const name = canonicalRunner(value);
  return known.includes(name) ? name : 'unknown';
}

function isSize(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * What a pull of this manifest downloads, in bytes: every layer plus the config. Throws on a
 * manifest that is not shaped like one, so a malformed answer never reads as a size.
 */
export function pullTotalBytes(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new CheckFailure('the manifest is not an object');
  const { config, layers } = manifest;
  if (!Array.isArray(layers) || layers.length === 0) throw new CheckFailure('the manifest has no layers');
  if (layers.length > MAX_LAYERS) throw new CheckFailure(`the manifest has more than ${MAX_LAYERS} layers`);
  if (!config || !isSize(config.size)) throw new CheckFailure('the manifest has no config size');
  let total = config.size;
  for (const layer of layers) {
    if (!layer || !isSize(layer.size)) throw new CheckFailure('a layer of the manifest has no size');
    total += layer.size;
  }
  if (!Number.isSafeInteger(total)) throw new CheckFailure('the manifest total is not a safe integer');
  return total;
}

/**
 * The child of a manifest list that Ollama 0.40.15 on Apple silicon pulls: for each runner in
 * `MAC_RUNNER_PREFERENCE`, the first child (in list order) with that runner. A child whose
 * mediaType is set to anything but a plain manifest is skipped, as Ollama skips it. Undefined
 * when no child has a runner a Mac runs.
 */
export function selectMacChild(children) {
  if (!Array.isArray(children)) return undefined;
  for (const runner of MAC_RUNNER_PREFERENCE) {
    const child = children.find(
      (entry) =>
        entry &&
        (entry.mediaType === undefined || entry.mediaType === '' || entry.mediaType === MEDIA_TYPE_MANIFEST) &&
        canonicalRunner(entry.runner) === runner
    );
    if (child) return child;
  }
  return undefined;
}

/**
 * The runner and format Ollama assumes for a manifest that names neither, from its config's
 * `model_format` (`MetadataForConfig()` in manifest/manifest.go): safetensors runs on mlx,
 * gguf on ggml.
 */
export function metadataForConfig(config) {
  const format = canonicalRunner(config?.model_format);
  if (format === 'safetensors') return { runner: 'mlx', format: 'safetensors' };
  if (format === 'gguf' || format === 'ggml') return { runner: 'ggml', format: 'gguf' };
  return { runner: '', format };
}

/**
 * A runner name in the catalogue's words (`LocalModelEntry.runner`): `mlx`, or `llamacpp` for a
 * GGUF build, which Ollama 0.40.15 serves through llama-server whether the manifest names it
 * `llamacpp` or names nothing (`ggml`, see `metadataForConfig()`). Undefined for anything else.
 */
export function catalogueRunner(runner) {
  const name = canonicalRunner(runner);
  if (name === 'mlx') return 'mlx';
  if (name === 'llamacpp' || name === 'ggml') return 'llamacpp';
  return undefined;
}

/** `[major, minor, patch]` of a version or `v`-tag, or undefined when it is not one. */
export function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION_PATTERN.exec(text.trim()) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. Both must parse. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new CheckFailure(`cannot compare versions ${a} and ${b}`);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

/** The signed difference of `actual` from `expected`, as a fraction of `expected`. */
export function sizeDifference(expected, actual) {
  return (actual - expected) / expected;
}

/** Whether `actual` lies within `SIZE_TOLERANCE_FRACTION` of `expected`. */
export function withinTolerance(expected, actual, tolerance = SIZE_TOLERANCE_FRACTION) {
  return Math.abs(actual - expected) <= expected * tolerance;
}

/**
 * The findings for one catalogue row. `row` is `{ id, bytes, runner?, digest? }` (`runner` once
 * the catalogue names it, `digest` only once the catalogue stores one); `observed` is what
 * `inspectModel()` returned for it. A row may have several findings; none means it is clean.
 *
 *  - `gone`: the tag is not in the registry, so a pull fails.
 *  - `runner`: a Mac now pulls a build of another runner than the row names (a tag that became
 *    a list with an mlx child, or the other way round). The two runners spend memory
 *    differently, so the row's memory figures no longer describe what runs, whatever the size.
 *  - `size`: what a Mac downloads is outside the tolerance of the row's `bytes`.
 *  - `digest`: the row pins a digest and a Mac would now pull another one.
 *  - `requires`: the build a Mac pulls declares a newer Ollama than the pinned runtime, so the
 *    pinned runtime refuses the pull.
 */
export function classifyModel(row, observed, pinnedVersion) {
  if (observed.gone) return [{ kind: 'gone' }];
  const findings = [];
  const mac = observed.mac;
  if (row.runner !== undefined) {
    const actual = catalogueRunner(mac.runner) ?? 'unknown';
    if (actual !== row.runner) findings.push({ kind: 'runner', expected: String(row.runner), actual });
  }
  if (!withinTolerance(row.bytes, mac.bytes)) {
    findings.push({ kind: 'size', expected: row.bytes, actual: mac.bytes, fraction: sizeDifference(row.bytes, mac.bytes) });
  }
  const pinned = normalizeDigest(row.digest);
  if (row.digest !== undefined && pinned !== mac.digest) {
    findings.push({ kind: 'digest', expected: pinned ?? 'not a sha256 digest', actual: mac.digest });
  }
  if (mac.requires && compareVersions(mac.requires, pinnedVersion) > 0) {
    findings.push({ kind: 'requires', requires: mac.requires, pinned: pinnedVersion });
  }
  return findings;
}

/**
 * The findings for the runtime pin. `observed` is what `inspectRuntime()` returned.
 *
 *  - `behind`: a newer Ollama release exists than the pinned one.
 *  - `pinned-release-gone`, `pinned-asset-gone`: the pinned download no longer exists, so every
 *    new install fails at the runtime step.
 *  - `pinned-asset-changed`: the pinned asset's size or sha256 no longer matches the pin. Every
 *    install already refuses it at the hash compare; this is also what a replaced release
 *    asset looks like, so read it as a security signal first.
 */
export function classifyRuntime(pin, observed) {
  const findings = [];
  if (compareVersions(observed.latest.version, pin.version) > 0) {
    findings.push({ kind: 'behind', pinned: pin.version, latest: observed.latest.version });
  }
  if (observed.pinned.gone) findings.push({ kind: 'pinned-release-gone' });
  else if (!observed.pinned.asset) findings.push({ kind: 'pinned-asset-gone' });
  else {
    const { size, digest } = observed.pinned.asset;
    if (size !== pin.bytes || (digest !== undefined && digest !== `sha256:${pin.sha256}`)) {
      findings.push({ kind: 'pinned-asset-changed', size, digest });
    }
  }
  return findings;
}

/** 0 clean, 1 drift, 2 the check failed. A failure anywhere wins over drift anywhere. */
export function exitCodeFor(result) {
  const failed =
    result.errors.length > 0 || result.models.some((model) => model.error) || Boolean(result.runtime?.error);
  if (failed) return 2;
  const drift =
    result.models.some((model) => model.findings.length > 0) || (result.runtime?.findings.length ?? 0) > 0;
  return drift ? 1 : 0;
}

// ---------- Report ----------

/** 1234567 as `1,234,567`, independent of the locale. */
export function groupDigits(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A fraction as a signed percentage with two decimals: `+16.61%`. */
export function formatPercent(fraction) {
  const text = (fraction * 100).toFixed(2);
  return fraction > 0 ? `+${text}%` : `${text}%`;
}

/** Error text for the report: one line, backticks made quotes, at most 200 characters. */
function oneLine(text) {
  const flat = String(text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/`/g, "'")
    .replace(/ {2,}/g, ' ')
    .trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

function buildName(variant) {
  return `${displayName(variant.runner, MAC_RUNNER_PREFERENCE)}, ${displayName(variant.format, KNOWN_FORMATS)}`;
}

function modelResult(model) {
  if (model.error) return 'check failed';
  if (model.findings.length === 0) return 'ok';
  const names = {
    gone: 'tag gone',
    runner: 'runner changed',
    size: 'size drift',
    digest: 'digest changed',
    requires: 'needs a newer runtime',
  };
  return model.findings.map((finding) => names[finding.kind]).join(', ');
}

function describeModelFinding(model, finding) {
  const id = `\`${model.id}\``;
  switch (finding.kind) {
    case 'gone':
      return `${id}: the registry no longer has this tag, so the download fails. Replace or remove the row.`;
    case 'runner':
      return (
        `${id}: a Mac now pulls the ${buildName(model.observed.mac)} build, which runs on ` +
        `\`${finding.actual}\`, while the row's \`runner\` says \`${displayName(finding.expected, ['mlx', 'llamacpp'])}\`. ` +
        'The two runners spend memory differently, so the row\'s memory figures no longer describe what runs: ' +
        'recompute them for the new runner, or pin the row to a single-build tag.'
      );
    case 'size':
      return (
        `${id}: a Mac downloads the ${buildName(model.observed.mac)} build, ${groupDigits(finding.actual)} bytes, ` +
        `${formatPercent(finding.fraction)} against the row's \`bytes\` of ${groupDigits(finding.expected)}. ` +
        'The memory fit reads `bytes`, so correct it (and re-measure if the build changed).'
      );
    case 'digest':
      return `${id}: the row pins \`${finding.expected}\`, a Mac now pulls \`${finding.actual}\`. The tag was pushed again.`;
    case 'requires':
      return (
        `${id}: the build a Mac pulls declares \`requires: ${finding.requires}\`, newer than the pinned runtime ` +
        `${finding.pinned}, which refuses to pull it.`
      );
    default:
      return `${id}: ${finding.kind}`;
  }
}

function describeRuntimeFinding(finding) {
  switch (finding.kind) {
    case 'behind':
      return (
        `Ollama ${finding.latest} is out; the pin is ${finding.pinned}. Read its release notes, then move ` +
        '`OLLAMA_RUNTIME_PIN` (version, URL, size, sha256) and test an install on a Mac.'
      );
    case 'pinned-release-gone':
      return 'The release of the pinned version is gone from GitHub: every new install fails at the runtime step.';
    case 'pinned-asset-gone':
      return 'The pinned release no longer carries the pinned archive: every new install fails at the runtime step.';
    case 'pinned-asset-changed':
      return (
        `The pinned archive changed on GitHub (now ${finding.size === undefined ? 'no size' : `${groupDigits(finding.size)} bytes`}` +
        `${finding.digest ? `, \`${finding.digest}\`` : ''}). Installs refuse it at the hash compare. Find out why before moving the pin.`
      );
    default:
      return finding.kind;
  }
}

function assetCell(asset) {
  if (!asset) return 'none';
  return `${groupDigits(asset.size)} bytes${asset.digest ? `, \`${asset.digest}\`` : ', no digest in the API'}`;
}

/** The markdown report of one run. Pure: everything in it was validated by the IO side. */
export function renderReport(result) {
  const lines = [];
  const code = exitCodeFor(result);
  const driftModels = result.models.filter((model) => !model.error && model.findings.length > 0).length;
  const runtimeDrift = result.runtime && !result.runtime.error ? result.runtime.findings.length > 0 : false;

  lines.push('# Local model catalogue: weekly check', '');
  lines.push(
    `Run ${result.checkedAt}. Catalogue of ${result.catalogue.updated} (${result.models.length} models), ` +
      `runtime pin Ollama ${result.pin.version}.`,
    ''
  );
  if (code === 2) {
    lines.push('**The check failed**: the results below are incomplete. Nothing should act on them.', '');
  } else if (code === 1) {
    const parts = [];
    if (driftModels > 0) parts.push(`${driftModels} of ${result.models.length} models`);
    if (runtimeDrift) parts.push('the runtime pin');
    lines.push(`**Drift found**: ${parts.join(' and ')}.`, '');
  } else {
    lines.push('**Clean**: every row matches what a Mac downloads today, and the runtime pin is current.', '');
  }

  for (const error of result.errors) lines.push(`- Check failed: ${oneLine(error)}`);
  if (result.errors.length > 0) lines.push('');

  lines.push('## Models', '');
  lines.push(
    'What a Mac downloads is the build Ollama on Apple silicon selects: the `mlx` build when the tag offers ' +
      'one, else `llamacpp`, else `ggml`. Its size is the pull total, every layer plus the config. ' +
      `Tolerance: ${(SIZE_TOLERANCE_FRACTION * 100).toFixed(1)}% of the row's \`bytes\`.`,
    ''
  );
  lines.push('| Model | Row `bytes` | A Mac downloads | Difference | Build on a Mac | Requires | Result |');
  lines.push('| --- | ---: | ---: | ---: | --- | --- | --- |');
  for (const model of result.models) {
    const mac = model.observed?.mac;
    const cells = [
      `\`${model.id}\``,
      groupDigits(model.bytes),
      mac ? groupDigits(mac.bytes) : '',
      mac ? formatPercent(sizeDifference(model.bytes, mac.bytes)) : '',
      mac ? buildName(mac) : model.observed?.gone ? 'tag gone' : '',
      mac?.requires ? `Ollama ${mac.requires}` : '',
      modelResult(model),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');

  const details = [];
  for (const model of result.models) {
    if (model.error) details.push(`- \`${model.id}\`: check failed: ${oneLine(model.error)}`);
    for (const finding of model.findings) details.push(`- ${describeModelFinding(model, finding)}`);
    const variants = model.observed?.variants ?? [];
    if (model.findings.some((finding) => finding.kind === 'size' || finding.kind === 'runner') && variants.length > 1) {
      const offered = variants
        .map((variant) => `${buildName(variant)} ${groupDigits(variant.bytes)}${variant === model.observed.mac ? ' (a Mac takes this one)' : ''}`)
        .join('; ');
      details.push(`  The tag offers: ${offered}.`);
    }
  }
  if (details.length > 0) lines.push('### What changed', '', ...details, '');

  lines.push('## Runtime', '');
  if (!result.runtime || result.runtime.error) {
    lines.push(`Check failed: ${oneLine(result.runtime?.error ?? 'not run')}`, '');
  } else {
    const { latest, pinned } = result.runtime.observed;
    const archive = result.runtime.assetName;
    lines.push(`| | Version | Published | \`${archive}\` |`);
    lines.push('| --- | --- | --- | --- |');
    lines.push(
      `| Pinned | ${result.pin.version} | ${pinned.publishedOn ?? ''} | ` +
        `${pinned.gone ? 'release gone' : assetCell(pinned.asset)} |`
    );
    lines.push(`| Newest release | ${latest.version} | ${latest.publishedOn ?? ''} | ${assetCell(latest.asset)} |`);
    lines.push('');
    if (result.runtime.findings.length === 0) {
      lines.push('The pin is the newest release, and its archive still matches the pin.', '');
    } else {
      for (const finding of result.runtime.findings) lines.push(`- ${describeRuntimeFinding(finding)}`);
      lines.push('');
    }
    lines.push(
      `Release notes: https://github.com/${RUNTIME_REPO}/releases/tag/v${latest.version}. ` +
        'A digest from the API is a lead, not a pin: check it against the release\'s `sha256sum.txt` first.',
      ''
    );
  }

  const unpinned = result.models.filter((model) => model.digest === undefined && model.observed?.mac);
  if (unpinned.length > 0) {
    lines.push('## Digests to pin', '');
    lines.push(
      'The catalogue pins no digest for these rows, so a build pushed again at about the same size goes unnoticed. ' +
        'Today\'s values: the tag\'s own manifest, and the manifest a Mac pulls. The one to pin is the second, the ' +
        'digest `/api/tags` reports after the pull, as the row field `digest` (which the catalogue schema must ' +
        'gain first).',
      ''
    );
    const measured = unpinned.filter((model) => model.figures === 'measured');
    if (measured.length > 0) {
      const ids = measured.map((model) => `\`${model.id}\``).join(', ');
      lines.push(
        `Pin first: ${ids}. Its memory figures were measured on one build, and without a digest nothing here ` +
          'tells that build from a rebuild of about the same size.',
        ''
      );
    }
    lines.push('| Model | Build a Mac pulls | Tag manifest | Manifest a Mac pulls |');
    lines.push('| --- | --- | --- | --- |');
    for (const model of unpinned) {
      lines.push(
        `| \`${model.id}\` | ${buildName(model.observed.mac)} | \`${model.observed.tagDigest}\` | ` +
          `\`${model.observed.mac.digest}\` |`
      );
    }
    lines.push('');
  }

  lines.push('## Not checked', '');
  lines.push(
    'The memory figures, the speeds and whether a coding agent works with a model: no manifest says anything ' +
      'about those. They change only when somebody measures on a Mac.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

// ---------- IO, with an injected fetch ----------

/**
 * One GET, bounded: `REQUEST_TIMEOUT_MS` for the whole exchange and `maxBytes` for the body.
 * Answers `{ status, body }` (body only for a 2xx). Never retries.
 */
export async function boundedGet(fetchFn, url, { headers = {}, maxBytes }) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'follow', signal });
  } catch (err) {
    throw new CheckFailure(`GET ${url} failed: ${describeError(err)}`);
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status };
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new CheckFailure(`GET ${url}: ${declared} bytes is over the cap of ${maxBytes}`);
  }
  const chunks = [];
  let total = 0;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new CheckFailure(`GET ${url}: the body is over the cap of ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    if (err instanceof CheckFailure) throw err;
    throw new CheckFailure(`GET ${url}: reading the body failed: ${describeError(err)}`);
  }
  return { status: res.status, body: Buffer.concat(chunks) };
}

function describeError(err) {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error && err.cause.message ? `: ${err.cause.message}` : '';
    return `${err.name === 'TimeoutError' ? 'timed out' : err.message}${cause}`;
  }
  return String(err);
}

function parseJson(body, what) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new CheckFailure(`${what} is not JSON`);
  }
}

/** A blob of the repository, checked against its digest. */
async function getBlob(fetchFn, name, digest, maxBytes, what) {
  const url = `${REGISTRY_BASE}/v2/library/${encodeURIComponent(name)}/blobs/${digest}`;
  const answer = await boundedGet(fetchFn, url, { maxBytes });
  if (!answer.body) throw new CheckFailure(`${what} ${digest}: the registry answered ${answer.status}`);
  if (sha256Digest(answer.body) !== digest) throw new CheckFailure(`${what} ${digest}: the body does not match its digest`);
  return answer.body;
}

/** One build of a tag: its runner, format, digest and pull total, all validated. */
function variantOf(manifest, digest, fallback = {}) {
  return {
    runner: canonicalRunner(manifest.runner) || canonicalRunner(fallback.runner),
    format: canonicalRunner(manifest.format) || canonicalRunner(fallback.format),
    digest,
    bytes: pullTotalBytes(manifest),
    configDigest: normalizeDigest(manifest.config?.digest),
  };
}

/**
 * What the registry serves for `id` today, read the way Ollama on a Mac reads it:
 * `{ gone: true }`, or `{ tagDigest, variants, mac }` where `mac` is the variant a Mac pulls
 * (with its config's `requires`). Throws `CheckFailure` when the answer is not usable.
 */
export async function inspectModel(fetchFn, id) {
  const { name, tag } = splitModelId(id);
  const url = `${REGISTRY_BASE}/v2/library/${encodeURIComponent(name)}/manifests/${encodeURIComponent(tag)}`;
  const answer = await boundedGet(fetchFn, url, { headers: { Accept: MANIFEST_ACCEPT }, maxBytes: MAX_MANIFEST_BYTES });
  if (answer.status === 404) return { gone: true };
  if (!answer.body) throw new CheckFailure(`the registry answered ${answer.status} for the manifest`);
  const tagDigest = sha256Digest(answer.body);
  const manifest = parseJson(answer.body, 'the manifest');

  let variants;
  let mac;
  if (manifest.mediaType === MEDIA_TYPE_MANIFEST_LIST) {
    const children = Array.isArray(manifest.manifests) ? manifest.manifests : [];
    if (children.length === 0 || children.length > MAX_LIST_CHILDREN) {
      throw new CheckFailure(`the manifest list has ${children.length} children`);
    }
    const selected = selectMacChild(children);
    if (!selected) throw new CheckFailure('the manifest list has no build a Mac runs (mlx, llamacpp or ggml)');
    variants = [];
    for (const child of children) {
      const digest = normalizeDigest(child?.digest);
      if (!digest || !child.digest.startsWith('sha256:')) throw new CheckFailure('a child of the manifest list has no sha256 digest');
      const body = await getBlob(fetchFn, name, digest, MAX_MANIFEST_BYTES, 'child manifest');
      const variant = variantOf(parseJson(body, `child manifest ${digest}`), digest, child);
      variants.push(variant);
      if (child === selected) mac = variant;
    }
  } else if (manifest.mediaType === MEDIA_TYPE_MANIFEST || manifest.mediaType === undefined) {
    mac = variantOf(manifest, tagDigest);
    variants = [mac];
  } else {
    throw new CheckFailure('the manifest has a media type this check does not know');
  }

  if (!mac.configDigest) throw new CheckFailure('the build a Mac pulls has no config digest');
  const config = parseJson(await getBlob(fetchFn, name, mac.configDigest, MAX_CONFIG_BYTES, 'config'), 'the config');
  // A manifest that names no runner or format gets them from its config, as Ollama fills them.
  const assumed = metadataForConfig(config);
  mac.runner ||= assumed.runner;
  mac.format ||= assumed.format;
  // A malformed `requires` is ignored, as Ollama ignores it (`checkPullRequires`).
  const requires = parseVersion(config?.requires);
  mac.requires = requires ? requires.join('.') : undefined;
  return { tagDigest, variants, mac };
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** The validated parts of a GitHub release: version, day it was published, the named asset. */
function releaseFacts(release, assetName) {
  if (!release || typeof release.tag_name !== 'string' || !RELEASE_TAG_PATTERN.test(release.tag_name)) {
    throw new CheckFailure('the release has no vX.Y.Z tag');
  }
  const day = typeof release.published_at === 'string' ? ISO_DAY_PATTERN.exec(release.published_at) : null;
  const raw = Array.isArray(release.assets) ? release.assets.find((asset) => asset?.name === assetName) : undefined;
  let asset;
  if (raw) {
    if (!isSize(raw.size)) throw new CheckFailure(`the release asset ${assetName} has no size`);
    asset = { size: raw.size, digest: normalizeDigest(raw.digest) };
  }
  return { version: release.tag_name.slice(1), publishedOn: day ? day[1] : undefined, asset };
}

/** The newest release and the pinned one, from the GitHub API. Throws `CheckFailure`. */
export async function inspectRuntime(fetchFn, pin, token) {
  const assetName = new URL(pin.url).pathname.split('/').pop();
  const headers = githubHeaders(token);
  const latestAnswer = await boundedGet(fetchFn, `${GITHUB_API_BASE}/repos/${RUNTIME_REPO}/releases/latest`, {
    headers,
    maxBytes: MAX_GITHUB_BYTES,
  });
  if (!latestAnswer.body) throw new CheckFailure(`GitHub answered ${latestAnswer.status} for the newest release`);
  const latest = releaseFacts(parseJson(latestAnswer.body, 'the newest release'), assetName);

  const pinnedAnswer = await boundedGet(
    fetchFn,
    `${GITHUB_API_BASE}/repos/${RUNTIME_REPO}/releases/tags/v${encodeURIComponent(pin.version)}`,
    { headers, maxBytes: MAX_GITHUB_BYTES }
  );
  let pinned;
  if (pinnedAnswer.status === 404) pinned = { gone: true };
  else if (!pinnedAnswer.body) throw new CheckFailure(`GitHub answered ${pinnedAnswer.status} for the pinned release`);
  else pinned = releaseFacts(parseJson(pinnedAnswer.body, 'the pinned release'), assetName);
  return { assetName, observed: { latest, pinned } };
}

/**
 * The whole check. `catalog` is the validated catalogue, `pin` the runtime pin, `fetchFn` the
 * fetch to use. Never throws for a network problem: each failure lands in the result, and
 * `exitCodeFor()` turns it into 2.
 */
export async function runCheck({ catalog, pin, fetchFn, now, githubToken }) {
  const result = {
    checkedAt: `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    catalogue: { updated: catalog.updated },
    pin: { version: pin.version },
    models: [],
    runtime: undefined,
    errors: [],
  };

  // Rows in parallel, each row's requests one after another: a handful of rows, a few requests each.
  result.models = await Promise.all(
    catalog.models.map(async (row) => {
      // `digest` is not in the catalogue schema yet: see the file header. `runner` is in the
      // schema from the catalogue that names each row's runner on; before that it is absent.
      const digest = /** @type {{ digest?: unknown }} */ (row).digest;
      const runner = /** @type {{ runner?: unknown }} */ (row).runner;
      const entry = { id: row.id, bytes: row.bytes, figures: row.figures, digest, findings: [] };
      try {
        entry.observed = await inspectModel(fetchFn, row.id);
        entry.findings = classifyModel({ id: row.id, bytes: row.bytes, runner, digest }, entry.observed, pin.version);
      } catch (err) {
        entry.error = err instanceof CheckFailure ? err.message : describeError(err);
      }
      return entry;
    })
  );

  try {
    const runtime = await inspectRuntime(fetchFn, pin, githubToken);
    result.runtime = { ...runtime, findings: classifyRuntime(pin, runtime.observed) };
  } catch (err) {
    result.runtime = { error: err instanceof CheckFailure ? err.message : describeError(err), findings: [] };
  }
  return result;
}

// ---------- Main ----------

async function main() {
  let catalog;
  let pin;
  try {
    const { getLocalModelCatalog } = await import('../src/config/local-model-catalog.js');
    const { OLLAMA_RUNTIME_PIN } = await import('../src/local-model/runtime.js');
    catalog = getLocalModelCatalog();
    pin = OLLAMA_RUNTIME_PIN;
  } catch (err) {
    console.error(`The catalogue or the runtime pin could not be loaded: ${describeError(err)}`);
    process.exitCode = 2;
    return;
  }
  const result = await runCheck({
    catalog,
    pin,
    fetchFn: globalThis.fetch,
    now: new Date(),
    githubToken: process.env.GITHUB_TOKEN || undefined,
  });
  process.stdout.write(renderReport(result));
  process.exitCode = exitCodeFor(result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`The check failed: ${describeError(err)}`);
    process.exitCode = 2;
  });
}
