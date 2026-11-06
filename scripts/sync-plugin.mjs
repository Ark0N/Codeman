#!/usr/bin/env node
/**
 * @fileoverview Keep the Claude Code plugin in `plugins/codeman/` in step with its sources.
 *
 * The repo is its own plugin marketplace: `/plugin marketplace add Ark0N/Codeman` reads
 * `.claude-plugin/marketplace.json` from the repo root, and the one plugin it lists is
 * `plugins/codeman/`, a small directory holding a plugin manifest, a README and a MIRROR of
 * `skills/codeman/`. Two facts make it a mirror rather than the source or a symlink:
 * `claude plugin install` copies the plugin directory into its cache, so a symlink pointing
 * outside it would dangle; and a plugin root that carries a `package.json` gets an npm
 * install at install time (measured: the repo root as plugin root cost every installer
 * 832 MB, 511 packages and this repo's postinstall), so the plugin root must be a directory
 * without one. `skills/codeman/` stays the single source; edit it, then run this.
 *
 * Claude Code's `plugin update` only sees a new release when the manifest version changes,
 * so both manifests carry `package.json`'s version. This runs inside `npm run
 * version-packages`, right after `changeset version` bumps it, and
 * `test/plugin-manifest.test.ts` pins version equality and byte-identity of the mirror so
 * drift fails the gate.
 *
 *   node scripts/sync-plugin.mjs          mirror the skill + rewrite both manifests
 *   node scripts/sync-plugin.mjs --check  exit 1 on any drift, change nothing
 */
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const PLUGIN_NAME = 'codeman';
const SOURCE = 'skills/codeman';
const PLUGIN_DIR = `plugins/${PLUGIN_NAME}`;
const MIRROR = `${PLUGIN_DIR}/skills/codeman`;
const MANIFESTS = [`${PLUGIN_DIR}/.claude-plugin/plugin.json`, '.claude-plugin/marketplace.json'];
// The MCP registry manifest for `codeman mcp` (published with `mcp-publisher` from its
// directory): the server and its npm package both carry the release version.
const MCP_REGISTRY_MANIFEST = 'config/mcp-registry/server.json';

const check = process.argv.includes('--check');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const drift = [];

/** Every file under `dir`, as repo-relative paths sorted for comparison. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// 1. The mirror.
const src = walk(SOURCE).map((p) => relative(SOURCE, p));
const dst = existsSync(MIRROR) ? walk(MIRROR).map((p) => relative(MIRROR, p)) : [];
const same =
  src.length === dst.length &&
  src.every((rel, i) => rel === dst[i] && readFileSync(join(SOURCE, rel)).equals(readFileSync(join(MIRROR, rel))));
if (!same) {
  drift.push(`${MIRROR} differs from ${SOURCE}`);
  if (!check) {
    rmSync(MIRROR, { recursive: true, force: true });
    cpSync(SOURCE, MIRROR, { recursive: true });
  }
}

// 2. The versions.
for (const file of MANIFESTS) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const targets = file.endsWith('marketplace.json') ? json.plugins.filter((p) => p.name === PLUGIN_NAME) : [json];
  if (targets.length === 0) {
    console.error(`${file}: no plugin entry named "${PLUGIN_NAME}"`);
    process.exit(1);
  }
  let changed = false;
  for (const target of targets) {
    if (target.version !== version) {
      drift.push(`${file}: ${target.version} -> ${version}`);
      target.version = version;
      changed = true;
    }
  }
  if (changed && !check) writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

// 3. The MCP registry manifest.
{
  const json = JSON.parse(readFileSync(MCP_REGISTRY_MANIFEST, 'utf8'));
  const targets = [json, ...(json.packages ?? []).filter((p) => p.registryType === 'npm')];
  let changed = false;
  for (const target of targets) {
    if (target.version !== version) {
      drift.push(`${MCP_REGISTRY_MANIFEST}: ${target.version} -> ${version}`);
      target.version = version;
      changed = true;
    }
  }
  if (changed && !check) writeFileSync(MCP_REGISTRY_MANIFEST, JSON.stringify(json, null, 2) + '\n');
}

if (drift.length === 0) {
  console.log(`plugin in step: mirror identical, manifests at ${version}`);
} else if (check) {
  console.error(`plugin drift (run: node scripts/sync-plugin.mjs):\n  ${drift.join('\n  ')}`);
  process.exit(1);
} else {
  console.log(`plugin synced:\n  ${drift.join('\n  ')}`);
}
