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
  GIT_HOST_CLI_BUILD_ARGS as mjsGitHostArgs,
  gitHostCliBuildArgPairs as mjsGitHostPairs,
  GIT_IDENTITY_BUILD_ARGS as mjsGitIdentityArgs,
  gitIdentityBuildArgPairs as mjsGitIdentityPairs,
} from '../scripts/lib/cli-catalog.mjs';
import {
  agentImageBuildArgPairs as tsPairs,
  agentImageBuildArgs,
  agentImageNpmPackages as tsPackages,
  GIT_HOST_CLI_BUILD_ARGS as tsGitHostArgs,
  gitHostCliBuildArgPairs as tsGitHostPairs,
  GIT_IDENTITY_BUILD_ARGS as tsGitIdentityArgs,
  gitIdentityBuildArgPairs as tsGitIdentityPairs,
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

describe('optional gh / az in the agent image: both producers pass the same switches', () => {
  const ENV_GH = 'CODEMAN_AGENT_IMAGE_INSTALL_GH';
  const ENV_AZ = 'CODEMAN_AGENT_IMAGE_INSTALL_AZ';

  it('map the same environment variables to the same Dockerfile ARGs', () => {
    expect(tsGitHostArgs).toEqual(mjsGitHostArgs);
    expect(tsGitHostArgs.map(([, arg]) => arg)).toEqual(['CODEMAN_INSTALL_GH', 'CODEMAN_INSTALL_AZ']);
  });

  it('agree for every combination, and an unset or empty variable adds nothing', () => {
    for (const gh of [undefined, '', '0', '1']) {
      for (const az of [undefined, '', '0', '1']) {
        const env: NodeJS.ProcessEnv = {};
        if (gh !== undefined) env[ENV_GH] = gh;
        if (az !== undefined) env[ENV_AZ] = az;
        const expected: Array<[string, string]> = [];
        if (gh) expected.push(['CODEMAN_INSTALL_GH', gh]);
        if (az) expected.push(['CODEMAN_INSTALL_AZ', az]);
        expect(tsGitHostPairs(env)).toEqual(expected);
        expect(mjsGitHostPairs(env)).toEqual(expected);
        expect(tsPairs(env)).toEqual(mjsPairs(CATALOG, env));
      }
    }
  });

  it('keeps the default argv unchanged when neither variable is set', () => {
    expect(tsPairs({})).toEqual([['CLI_NPM_PACKAGES', tsPackages().join(' ')]]);
  });

  it('refuses anything but 0 or 1 on both sides, naming the variable', () => {
    for (const bad of ['yes', 'true', '2', ' 1', '0 && echo']) {
      expect(() => tsGitHostPairs({ [ENV_AZ]: bad })).toThrow(new RegExp(ENV_AZ));
      expect(() => mjsGitHostPairs({ [ENV_AZ]: bad })).toThrow(new RegExp(ENV_AZ));
    }
  });

  it('both Dockerfiles declare the switches, defaulting to OFF (opt-in)', () => {
    for (const file of ['../docker/agent.Dockerfile', '../docker/server.Dockerfile']) {
      const dockerfile = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8');
      expect(dockerfile, file).toMatch(/^ARG CODEMAN_INSTALL_GH=0$/m);
      expect(dockerfile, file).toMatch(/^ARG CODEMAN_INSTALL_AZ=0$/m);
    }
  });
});

describe('Git identity in the agent image: both producers pass the same settings', () => {
  it('maps the Git environment variables to matching Dockerfile ARGs', () => {
    expect(tsGitIdentityArgs).toEqual(mjsGitIdentityArgs);
    expect(tsGitIdentityArgs).toEqual([
      ['GIT_USER_NAME', 'GIT_USER_NAME'],
      ['GIT_USER_EMAIL', 'GIT_USER_EMAIL'],
    ]);
  });

  it('passes a complete identity and omits an absent identity', () => {
    const identity = { GIT_USER_NAME: 'Ada Lovelace', GIT_USER_EMAIL: 'ada@example.com' };
    const expected: Array<[string, string]> = [
      ['GIT_USER_NAME', 'Ada Lovelace'],
      ['GIT_USER_EMAIL', 'ada@example.com'],
    ];
    expect(tsGitIdentityPairs(identity)).toEqual(expected);
    expect(mjsGitIdentityPairs(identity)).toEqual(expected);
    expect(tsGitIdentityPairs({})).toEqual([]);
    expect(mjsGitIdentityPairs({})).toEqual([]);
  });

  it('refuses a partial identity in both build paths', () => {
    for (const identity of [{ GIT_USER_NAME: 'Ada Lovelace' }, { GIT_USER_EMAIL: 'ada@example.com' }]) {
      expect(() => tsGitIdentityPairs(identity)).toThrow(/GIT_USER_NAME and GIT_USER_EMAIL/);
      expect(() => mjsGitIdentityPairs(identity)).toThrow(/GIT_USER_NAME and GIT_USER_EMAIL/);
    }
  });

  it('both Dockerfiles configure system Git identity from the build arguments', () => {
    for (const file of ['../docker/agent.Dockerfile', '../docker/server.Dockerfile']) {
      const dockerfile = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8');
      expect(dockerfile, file).toMatch(/^ARG GIT_USER_NAME=$/m);
      expect(dockerfile, file).toMatch(/^ARG GIT_USER_EMAIL=$/m);
      expect(dockerfile, file).toContain('git config --system user.name "${GIT_USER_NAME}"');
      expect(dockerfile, file).toContain('git config --system user.email "${GIT_USER_EMAIL}"');
    }
  });
});
