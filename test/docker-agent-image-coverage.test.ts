/**
 * @fileoverview Every shipped CLI reaches the Docker agent image, and no unshipped one does.
 *
 * The image's npm layer is now a build arg fed from the generated catalogue, but four CLIs
 * still install through hand-written layers because the registry cannot describe what makes
 * them special — a flag, a companion package, or not being on npm at all. That mix is fine;
 * what is not fine is a CLI landing in `stock.ts` and reaching NEITHER, which is upstream
 * `b6d0f1fa` (omp shipped with no installer wiring) in the image instead of the installer.
 *
 * So this asserts total coverage rather than checking the arg alone, and requires every
 * special case to carry a written reason.
 *
 * Port: none (pure, over two Dockerfiles, the catalogue and the registry).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentImageNpmPackages } from '../scripts/lib/cli-catalog.mjs';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf-8');

const AGENT_DOCKERFILE = read('docker/agent.Dockerfile');
const SERVER_DOCKERFILE = read('docker/server.Dockerfile');
const INDEX_HTML = read('src/web/public/index.html');
const CATALOG = JSON.parse(read('config/clis.stock.json')) as Array<{
  id: string;
  enabled: boolean;
  discovery: {
    binaries: string[];
    install: { npmPackage?: string; agentImageLayer?: { kind: 'dedicated'; reason: string } };
  };
}>;

const enabledAgents = CATALOG.filter((e) => e.enabled && e.discovery.binaries.length > 0);

/**
 * A layer's PROOF it installed the right thing, not merely a substring anywhere in the file.
 * Every dedicated layer in agent.Dockerfile ends by running `<binary> --version`, so anchoring
 * on that (rather than `Dockerfile.includes(binary)`) survives a layer being deleted while its
 * COMMENT — which also names the binary — is left behind. That gap is why this replaced the
 * looser check.
 */
const hasVersionProof = (binary: string): boolean => AGENT_DOCKERFILE.includes(`${binary} --version`);

describe('docker agent image covers the catalogue', () => {
  it('installs every enabled npm CLI, via the build arg or a documented dedicated layer', () => {
    const inBuildArg = new Set(agentImageNpmPackages(CATALOG));
    const missing: string[] = [];
    for (const entry of enabledAgents) {
      const pkg = entry.discovery.install.npmPackage;
      if (!pkg) continue; // standalone installer, checked below
      if (inBuildArg.has(pkg)) continue;
      if (entry.discovery.install.agentImageLayer) continue;
      missing.push(`${entry.id} (${pkg})`);
    }
    expect(
      missing,
      `npm CLI reaches neither the build arg nor a dedicated layer:\n  ${missing.join('\n  ')}\n` +
        'Add it to the arg (it is automatic) or give it a Dockerfile layer AND an agentImageLayer.reason in stock.ts.'
    ).toEqual([]);
  });

  it('gives every dedicated-layer entry a reason and a real, provable layer', () => {
    for (const entry of CATALOG) {
      const layer = entry.discovery.install.agentImageLayer;
      if (!layer) continue;
      expect(layer.reason.length, `${entry.id} has an empty agentImageLayer.reason`).toBeGreaterThan(20);
      const binary = entry.discovery.binaries[0];
      // Excluded from the shared arg, so it MUST appear in a hand-written layer that actually
      // ran the binary, or it is simply not installed at all — an exclusion silently becoming
      // an omission.
      expect(
        hasVersionProof(binary),
        `${entry.id} is excluded from the arg but has no "${binary} --version" proof line in the Dockerfile`
      ).toBe(true);
    }
  });

  it('installs every enabled non-npm CLI in its own layer', () => {
    for (const entry of enabledAgents) {
      if (entry.discovery.install.npmPackage) continue;
      const binary = entry.discovery.binaries[0];
      expect(
        hasVersionProof(binary),
        `${entry.id} ships no npm package and no Dockerfile layer proves it ran "${binary} --version"`
      ).toBe(true);
    }
  });

  it('bakes in nothing from a DISABLED entry', () => {
    // The maintainer's finding: the earlier export carried no `enabled` field, so a CLI that
    // ships disabled still had its package installed into every image.
    for (const entry of CATALOG) {
      if (entry.enabled) continue;
      const pkg = entry.discovery.install.npmPackage;
      if (!pkg) continue;
      expect(AGENT_DOCKERFILE.includes(pkg), `disabled ${entry.id} is still baked into the image`).toBe(false);
    }
  });

  it('excludes a disabled entry from the build arg (unit, since none ships disabled today)', () => {
    // Every stock entry is enabled right now, so the assertion above passes vacuously. Feed
    // the pure helper a fabricated disabled entry so the fix is genuinely covered TODAY
    // rather than the first time someone ships one.
    const fabricated = [
      ...CATALOG,
      { id: 'ghost', enabled: false, discovery: { binaries: ['ghost'], install: { npmPackage: '@ghost/cli' } } },
    ];
    expect(agentImageNpmPackages(fabricated)).not.toContain('@ghost/cli');
    const enabledTwin = fabricated.map((e) => (e.id === 'ghost' ? { ...e, enabled: true } : e));
    expect(agentImageNpmPackages(enabledTwin)).toContain('@ghost/cli');
  });

  it('refuses an npm package name that would not survive unquoted expansion', () => {
    // The Dockerfile expands ${CLI_NPM_PACKAGES} unquoted so word splitting makes the list.
    // A token with a space or a metacharacter would therefore change what the RUN line means.
    const hostile = [
      { id: 'x', enabled: true, discovery: { binaries: ['x'], install: { npmPackage: 'a && rm -rf /' } } },
    ];
    expect(() => agentImageNpmPackages(hostile)).toThrow(/unsafe npm package name/i);
  });
});

describe('docker server image divergence is declared, not accidental', () => {
  // server.Dockerfile deliberately ships a NARROWER list than the agent image, and is left
  // untouched by this change because two other open PRs already modify it. Asserting the
  // omissions here makes the divergence reviewable without editing the file: if someone adds
  // a CLI there, or the intent changes, this fails and the list has to be restated.
  const SERVER_INTENTIONAL_OMISSIONS = new Set(['antigravity', 'pi', 'grok', 'deepseek', 'omp']);

  it('installs exactly the CLIs it declares, and no more', () => {
    for (const entry of enabledAgents) {
      const pkg = entry.discovery.install.npmPackage;
      if (!pkg) continue;
      const present = SERVER_DOCKERFILE.includes(pkg);
      if (SERVER_INTENTIONAL_OMISSIONS.has(entry.id)) {
        expect(present, `${entry.id} is listed as an intentional omission but IS in server.Dockerfile`).toBe(false);
      } else {
        expect(present, `${entry.id} is missing from server.Dockerfile and not declared as omitted`).toBe(true);
      }
    }
  });
});

describe('the in-app agent-image hint stays accurate', () => {
  it('names every enabled CLI binary the image contains', () => {
    // index.html tells the user what the image holds. It was stale (it omitted omp), which is
    // the same drift one layer out: prose describing a list nobody re-checks.
    const hint = INDEX_HTML.split('\n').find((l) => l.includes('build-agent-image.mjs'));
    expect(hint, 'the agent-image hint disappeared from index.html').toBeDefined();
    for (const entry of enabledAgents) {
      expect(hint, `the hint does not mention ${entry.discovery.binaries[0]}`).toContain(entry.discovery.binaries[0]);
    }
  });

  it('is checked against the registry, not a copy of itself (anti-vacuity)', () => {
    expect(STOCK_CLIS.filter((e) => e.enabled && e.discovery.binaries.length > 0).length).toBeGreaterThan(5);
  });
});
