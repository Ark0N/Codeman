/**
 * @fileoverview The two producers of the agent-image `docker build` command line must agree.
 *
 * There are two, and there have to be: `scripts/build-agent-image.mjs` is what a human runs
 * and is a `.mjs`, so it cannot import the TypeScript registry and reads the generated
 * `config/clis.stock.json` instead; `src/docker-hosts.ts` builds the same command for the
 * in-app auto-build on the first Docker case, from `STOCK_CLIS` directly.
 *
 * Two independent producers of one command line is exactly the shape that drifts, and the
 * failure would be quiet and confusing: an image built by hand and an image built by the app
 * would hold different CLIs under the SAME `codeman/agent:base` tag, so which CLIs a container
 * has would depend on who built it.
 *
 * Port: none (pure).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  agentImageBuildArgPairs as mjsPairs,
  agentImageNpmPackages as mjsPackages,
} from '../scripts/lib/cli-catalog.mjs';
import {
  agentImageBuildArgPairs as tsPairs,
  agentImageBuildArgs,
  agentImageNpmPackages as tsPackages,
} from '../src/docker-hosts.js';

const CATALOG = JSON.parse(readFileSync(fileURLToPath(new URL('../config/clis.stock.json', import.meta.url)), 'utf-8'));

describe('agent-image build args: the .mjs and the TS mirror agree', () => {
  it('resolve the same npm package list, in the same order', () => {
    // Order matters as well as membership: a different order is a different RUN string, hence
    // a different layer hash, hence a cache miss between the two build paths.
    expect(tsPackages()).toEqual(mjsPackages(CATALOG));
  });

  it('produce the same --build-arg pairs', () => {
    expect(tsPairs()).toEqual(mjsPairs(CATALOG));
  });

  it('render the same argv', () => {
    // What the .mjs assembles by hand around its pairs, spelled out here so a change to
    // either side's argv SHAPE (not just its values) fails too.
    const pairs = tsPairs();
    const expected = [
      'build',
      '-f',
      '/repo/docker/agent.Dockerfile',
      '-t',
      'codeman/agent:base',
      '--no-cache',
      ...pairs.flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]),
      '/repo',
    ];
    expect(agentImageBuildArgs('/repo/docker/agent.Dockerfile', 'codeman/agent:base', '/repo', true, pairs)).toEqual(
      expected
    );
  });

  it('keeps --build-arg out of the argv when nothing is passed', () => {
    // The parameter defaults to empty, so an existing caller that has not been updated still
    // produces exactly the command it produced before.
    expect(agentImageBuildArgs('/d', 'i', '/c')).toEqual(['build', '-f', '/d', '-t', 'i', '/c']);
  });

  it('resolves a non-empty list (anti-vacuity)', () => {
    // Two empty lists compare equal very happily.
    expect(tsPackages().length).toBeGreaterThan(3);
    expect(tsPairs()[0][1].length).toBeGreaterThan(20);
  });

  it('matches the Dockerfile ARG default, so a bare `docker build` is cache-identical', () => {
    const dockerfile = readFileSync(fileURLToPath(new URL('../docker/agent.Dockerfile', import.meta.url)), 'utf-8');
    const declared = /^ARG CLI_NPM_PACKAGES="([^"]*)"$/m.exec(dockerfile)?.[1];
    expect(declared, 'the Dockerfile no longer declares CLI_NPM_PACKAGES').toBeDefined();
    expect(declared).toBe(tsPackages().join(' '));
  });

  it('validates an unsafe package name with the SAME regex on both sides', () => {
    // Equal OUTPUT on today's catalogue (asserted above) does not prove equal VALIDATION — a
    // looser regex on one side would only show up the day someone ships a hostile package name.
    // The regex is duplicated rather than shared (the .mjs side cannot import the .ts side, the
    // whole reason this file exists), so pin the literal PATTERN text is identical between the
    // two source files rather than trusting the comment that says so.
    const tsSource = readFileSync(fileURLToPath(new URL('../src/docker-hosts.ts', import.meta.url)), 'utf-8');
    const mjsSource = readFileSync(fileURLToPath(new URL('../scripts/lib/cli-catalog.mjs', import.meta.url)), 'utf-8');
    const extract = (source: string, file: string): string => {
      // Non-greedy to `/;` deliberately: the pattern itself contains a `/` (inside the
      // character class), so a naive `[^/]+` stops at the wrong slash.
      const m = /const SAFE_PACKAGE = (\/.+?\/);/.exec(source);
      expect(m, `could not find the SAFE_PACKAGE regex literal in ${file}`).toBeDefined();
      return m![1];
    };
    expect(extract(tsSource, 'docker-hosts.ts')).toBe(extract(mjsSource, 'cli-catalog.mjs'));
  });
});
