/**
 * @fileoverview Adopting an ALREADY-RUNNING container (`DockerCase.owned === false`).
 *
 * The whole point of adoption is a negative guarantee: Codeman execs into a
 * container the user built and runs, and never creates, starts, stops, restarts
 * or removes it. A negative guarantee cannot be observed by using the feature —
 * only by asserting that the mutating verbs are absent — so these tests read the
 * generated command strings and assert on what is NOT in them.
 *
 * Mirror of the `owned:false` remote-SSH contract (COD-105).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  defaultDockerCommandForMode,
  toSessionDocker,
  isAdoptedContainer,
  removeDockerContainer,
  checkDockerConfigDrift,
  dockerConfigHash,
  dockerAdoptProbeModes,
  classifyAdoptContainerConflict,
  dockerContainerName,
} from '../src/docker-hosts.js';
import { enabledCliIds, getCli } from '../src/config/cli-registry/index.js';
import {
  buildDockerLaunchCommand,
  buildDockerStopCommand,
  buildDockerRemoveCommand,
  buildDockerKillCommand,
} from '../src/tmux-manager.js';
import type { DockerCase, DockerHost, SessionDocker } from '../src/types.js';

const HOST: DockerHost = { id: 'h1', label: 'local', engine: 'docker', image: 'codeman/agent:base' };

function caseFor(owned: boolean | undefined): DockerCase {
  return {
    name: 'adopted',
    type: 'docker',
    hostId: 'h1',
    hostWorkspacePath: '/srv/work',
    container: 'my-own-container',
    ...(owned === undefined ? {} : { owned }),
  };
}

function launchFor(docker: SessionDocker): string {
  return buildDockerLaunchCommand({
    mode: 'codex',
    docker,
    sessionId: '11111111-2222-3333-4444-555555555555',
    createContext: {
      docker,
      sessionId: '11111111-2222-3333-4444-555555555555',
      instance: 'default',
      userArgs: ['--user', '1000:0'],
      credentialMounts: [],
      extraMounts: [],
      envCreate: { HOME: '/home/agent' },
      addHostGateway: true,
      gatewayAlias: 'host.docker.internal',
    },
    execEnv: { TERM: 'xterm-256color' },
    execEnvNames: [],
    seedCopies: [{ from: '/seed/creds.json', to: '/home/agent/.claude/.credentials.json' }],
  });
}

describe('adopted container: ownership plumbing', () => {
  it('carries owned:false from the case onto the live session metadata', () => {
    expect(toSessionDocker(HOST, caseFor(false)).owned).toBe(false);
    expect(isAdoptedContainer(toSessionDocker(HOST, caseFor(false)))).toBe(true);
  });

  it('treats an absent flag as owned, so existing cases are unchanged', () => {
    const docker = toSessionDocker(HOST, caseFor(undefined));
    expect(docker.owned).toBeUndefined();
    expect(isAdoptedContainer(docker)).toBe(false);
  });

  it('keeps ownership OUT of the config hash so adoption cannot mass-trip drift', () => {
    // A drift-hash that moved with `owned` would flag every pre-existing case the
    // moment this field shipped, and the remedy the UI offers is "recreate".
    const owned = toSessionDocker(HOST, caseFor(undefined));
    const adopted = toSessionDocker(HOST, caseFor(false));
    expect(adopted.configHash).toBe(owned.configHash);
    expect(dockerConfigHash({ ...owned, owned: false } as never)).toBe(owned.configHash);
  });
});

describe('adopted container: the launch chain never mutates lifecycle', () => {
  const adopted = launchFor(toSessionDocker(HOST, caseFor(false)));
  const owned = launchFor(toSessionDocker(HOST, caseFor(undefined)));

  it('never creates the container', () => {
    expect(owned).toContain('docker create');
    expect(adopted).not.toContain('docker create');
  });

  it('never starts the container', () => {
    expect(owned).toContain('docker start');
    expect(adopted).not.toContain('docker start');
  });

  it('never stops or removes the container', () => {
    for (const verb of ['docker stop', 'docker rm', 'docker restart', 'docker kill']) {
      expect(adopted).not.toContain(verb);
    }
  });

  it('fails closed when the container is missing instead of creating it', () => {
    expect(adopted).toContain('docker inspect');
    expect(adopted).toMatch(/not found.*start it yourself/i);
  });

  it('fails closed when the container is stopped instead of starting it', () => {
    expect(adopted).toMatch(/\{\{\.State\.Running\}\}/);
    expect(adopted).toMatch(/not running.*never starts a container it does not own/i);
  });

  it('uses no double quote and no command substitution in the launch chain', () => {
    // The whole chain is embedded in an outer `bash -c "…"`. An unescaped `"`
    // closes that string early, the remainder is re-tokenized, and tmux fails to
    // exec with a bare `execvp(3) failed: No such file or directory` — no hint
    // that the command was ever malformed. `$(…)` is banned with it because it
    // is then evaluated by the wrong shell at the wrong time.
    expect(adopted).not.toContain('"');
    expect(adopted).not.toContain('$(');
    // Every other line already quotes with the single-quote helper.
    expect(adopted).toContain('grep -qx true');
  });

  it('skips the base-image gate, which describes an image adoption never uses', () => {
    expect(owned).toContain('image inspect');
    expect(adopted).not.toContain('image inspect');
  });

  it('never seeds host credentials into a container it does not own', () => {
    expect(owned).toContain('.credentials.json');
    expect(adopted).not.toContain('.credentials.json');
  });

  it('still execs into the in-container tmux, which is the whole point', () => {
    expect(adopted).toContain('docker exec -it');
    expect(adopted).toContain('new-session -A');
  });
});

describe('adopted container: the probe request must reach the server', () => {
  const ui = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../src/web/public/api-client.js', import.meta.url), 'utf8');

  it('never hands _apiJson an already-stringified body', () => {
    // _api serializes `body` and sets Content-Type itself. Passing a string
    // double-encodes it, the server sees a JSON string where it expects an
    // object, and answers 400 INVALID_INPUT — which the caller reads as "the
    // container could not be probed", so the menu silently showed every mode.
    expect(api).toContain('fetchOpts.body = JSON.stringify(body)');
    const calls = [...ui.matchAll(/_apiJson\([^)]*\{[\s\S]{0,400}?\}\s*\)/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toContain('body: JSON.stringify');
  });

  it('hides every agent mode and says why when the container cannot be read', () => {
    // Offering claude on a container that is not running is a click that can
    // only fail, with the reason visible nowhere.
    // Brace-matched, not a character window: slicing between two call sites
    // silently yields '' when the second one appears ABOVE the first, and the
    // assertion then passes over nothing. That has bitten this file twice.
    const start = ui.indexOf('async _probeDockerCaseModes(activeCase, menu) {');
    expect(start).toBeGreaterThan(-1);
    const open = ui.indexOf('{', start);
    let depth = 0;
    let fn = '';
    for (let i = open; i < ui.length; i++) {
      if (ui[i] === '{') depth++;
      else if (ui[i] === '}' && --depth === 0) {
        fn = ui.slice(start, i + 1);
        break;
      }
    }
    expect(fn).toContain('_dockerCaseProbeError');
    expect(ui).toContain('_renderRunModeNotice');
  });
});

describe('adopted container: claude as root', () => {
  it('drops --dangerously-skip-permissions when the container runs as root', () => {
    // Claude Code refuses the flag as root ("cannot be used with root/sudo
    // privileges"), so keeping it kills the pane with a message only visible
    // inside the container. Our base image runs a non-root user, which is why an
    // owned container never hit this.
    expect(defaultDockerCommandForMode('claude', true)).toBe('exec claude');
    expect(defaultDockerCommandForMode('claude', false)).toContain('--dangerously-skip-permissions');
    expect(defaultDockerCommandForMode('claude')).toContain('--dangerously-skip-permissions');
  });

  it('leaves every other mode unchanged as root', () => {
    for (const mode of ['codex', 'shell', 'pi'] as const) {
      expect(defaultDockerCommandForMode(mode, true)).toBe(defaultDockerCommandForMode(mode, false));
    }
  });
});

describe('adopted container: the host is not required to have the CLI', () => {
  const src = readFileSync(new URL('../src/tmux-manager.ts', import.meta.url), 'utf8');

  it('skips the host CLI requirement for a docker session', () => {
    // A docker session runs its CLI inside the container. Demanding it on the
    // host threw, the catch fell back to a direct PTY, and that PTY tried to
    // exec the CLI on the HOST — surfacing as a bare `execvp(3) failed` with
    // nothing naming the real cause.
    //
    // The CLI registry collapsed the old per-mode `mode === 'claude' && !cliDir` chain
    // into ONE `missingCliMessage(mode)` gate, so the guarantee is now that the single
    // gate carries the docker exemption and that no per-mode arm has grown back.
    expect(src).toContain('if (!cliRunsInContainer && !cliDir) {');
    expect(src.match(/if \(mode === '[a-z]+' && !cliDir\)/g)).toBeNull();
  });

  it('derives the flag from the location metadata the session already carries', () => {
    // Adoption joined the condition for the same reason docker is in it: an
    // adopted session's CLI was started by a human in a process Codeman never
    // spawned, so the host binary is irrelevant there too — and demanding it
    // would reject adopting a claude that lives in a container, on an ssh host,
    // or simply outside the server process's PATH (the systemd/launchd case).
    // What the assertion still pins is that the flag comes from the session's
    // OWN metadata rather than from anything ambient.
    expect(src).toContain('const cliRunsInContainer = !!docker || !!adopt;');
  });
});

describe('adopted container: mutating verbs fail closed at the builder', () => {
  const docker = toSessionDocker(HOST, caseFor(false));

  it('refuses to build a stop command', () => {
    expect(() => buildDockerStopCommand(docker)).toThrow(/does not own its lifecycle/);
  });

  it('refuses to build a remove command', () => {
    expect(() => buildDockerRemoveCommand(docker)).toThrow(/does not own its lifecycle/);
  });

  it('refuses to remove the container', async () => {
    await expect(removeDockerContainer(docker)).rejects.toThrow(/does not own its lifecycle/);
  });

  it('still allows killing THIS session in-container tmux, never the container', () => {
    const kill = buildDockerKillCommand({ docker, sessionId: 'abcdef12-0000-0000-0000-000000000000' });
    expect(kill).toContain('tmux');
    expect(kill).toContain('kill-session');
    expect(kill).not.toContain('docker stop');
    expect(kill).not.toContain('docker rm');
  });

  it('still permits every verb for an owned container', () => {
    const ownedDocker = toSessionDocker(HOST, caseFor(undefined));
    expect(buildDockerStopCommand(ownedDocker)).toContain('stop -t 10');
    expect(buildDockerRemoveCommand(ownedDocker)).toContain('rm -f');
  });
});

describe('adopted container: the Add Case panel id contract', () => {
  // The modal's load/save contract is getElementById by fixed id, so a renamed or
  // dropped id stops the control working with no error anywhere. Static guard in
  // the style of app-settings-structure / session-options-structure.
  const html = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/web/public/styles.css', import.meta.url), 'utf8');

  it('ships every id session-ui.js reads back', () => {
    for (const id of ['dockerAdoptExisting', 'dockerContainerName', 'dockerAdoptCheckBtn']) {
      expect(html).toContain(`id="${id}"`);
      expect(ui).toContain(`'${id}'`);
    }
  });

  it('routes adoption to the endpoint that never creates a container', () => {
    expect(ui).toContain('/api/cases/docker-adopt');
    expect(ui).toContain('/api/docker-cases/adopt-preflight');
    // The create path must survive untouched beside it.
    expect(ui).toContain('/api/cases/docker-link');
  });

  it('hides the adopt-only row until the toggle is on, so the panel is unchanged by default', () => {
    expect(css).toContain('#createCaseModal .docker-adopt-only');
    expect(css).toMatch(/#createCaseModal \.docker-adopt-only \{\s*display: none/);
    expect(css).toContain("#createCaseModal[data-docker-adopt='1'] .docker-adopt-only");
  });

  it('marks the create-time rows so adoption hides the fields it never uses', () => {
    // image / network / advanced describe a `docker create` adoption never runs.
    expect(html.match(/docker-create-only/g)?.length).toBeGreaterThanOrEqual(3);
    expect(css).toContain("#createCaseModal[data-docker-adopt='1'] .docker-create-only");
  });
});

describe('adopted container: run modes come from the CONTAINER, not the host', () => {
  const ui = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf8');
  /** Slice the method BODY. Anchored on the definition, not a call site: the
   *  menu opener calls _loadRunModeHistory() ABOVE this definition, so slicing
   *  between call sites silently yields an empty string and passes nothing. */
  /**
   * The method BODY, delimited by brace depth rather than a character budget.
   * A fixed window silently truncates the moment the method grows — which is
   * exactly what happened twice: a comment added above the assertion pushed the
   * asserted line past the cutoff and CI failed on a test that was still true.
   */
  const refreshFn = (src) => {
    const start = src.indexOf('_refreshRunModeAvailability(menu) {');
    expect(start).toBeGreaterThan(-1);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('unbalanced braces in _refreshRunModeAvailability');
  };

  it('gates a docker case on availableModes instead of host CLI probes', () => {
    // The sandbox host had codex but no claude while the adopted container had
    // claude and no codex; gating on the host hid the only mode that worked.
    const fn = refreshFn(ui);
    expect(fn).toContain("location === 'docker'");
    expect(fn).toContain('availableModes');
    // Non-docker cases must keep the original host probe (#201).
    expect(fn).toContain('this.isCliAvailable(mode)');
  });

  it('leaves an owned container ungated when nothing was probed', () => {
    // Our base image ships every CLI, so an absent list means "unknown", and
    // treating unknown as "nothing available" would empty the menu.
    expect(refreshFn(ui)).toMatch(/containerModes \?[^:]*:\s*true/);
  });
});

describe('adopted container: both path fields get a folder picker', () => {
  const html = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf8');
  const picker = readFileSync(new URL('../src/web/public/keyboard-accessory.js', import.meta.url), 'utf8');

  it('wires a Browse button to each of the two paths', () => {
    expect(html).toContain('app.openDockerWorkspacePathPicker()');
    expect(html).toContain('app.openDockerWorkdirPicker()');
    // Same markup Link Existing uses, so the two look and behave alike.
    expect(html.match(/path-input-browse/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('browses the CONTAINER for the container workdir, not the host', () => {
    // For an adopted container nothing is mounted at a matching host path, so a
    // host listing would be a different filesystem — and typing this field blind
    // is what makes the launch fail with an OCI chdir error.
    const fn = ui.slice(ui.indexOf('openDockerWorkdirPicker()'), ui.indexOf('async linkRemoteCase()'));
    expect(fn).toContain('/api/docker-cases/browse');
    expect(fn).not.toContain('/api/filesystem/browse');
    expect(fn).toContain('fetchListing');
  });

  it('keeps the host picker for the host workspace path', () => {
    const fn = ui.slice(ui.indexOf('openDockerWorkspacePathPicker()'), ui.indexOf('openDockerWorkdirPicker()'));
    expect(fn).toContain('PathPicker.open');
    expect(fn).not.toContain('fetchListing');
  });

  it('reuses one PathPicker via an optional source rather than forking it', () => {
    expect(picker).toContain('this._options.fetchListing');
    expect(picker).toContain('/api/filesystem/browse');
  });
});

describe('adopted container: drift is not evaluated', () => {
  it('reports no drift rather than demanding a recreate we may not perform', async () => {
    // An adopted container carries no codeman.confighash label, so a real
    // comparison would always report drift and the launch gate would 409 forever.
    const status = await checkDockerConfigDrift(toSessionDocker(HOST, caseFor(false)));
    expect(status.drifted).toBe(false);
  });
});

describe('adopted container: probe modes come from the CLI registry', () => {
  it('probes every enabled CLI, so a newly-enabled one needs no second list', () => {
    // A hand-written list here silently froze: `omp` shipped in 1.24.0 and was
    // missing from it, which hid the omp run mode on EVERY docker case — owned
    // ones included, since the run menu gates on this same probe.
    const modes = dockerAdoptProbeModes();
    expect(modes).toEqual(enabledCliIds());
    expect(modes).toContain('omp');
    expect(modes).toContain('shell');
  });

  it('resolves the real binary name, not the mode name', () => {
    // `antigravity` ships as `agy` and `deepseek` as `dsh`, so a mode-name probe
    // would report both as missing on a container that has them.
    expect(getCli('antigravity')?.discovery.binaries[0]).toBe('agy');
    expect(getCli('deepseek')?.discovery.binaries[0]).toBe('dsh');
    expect(getCli('shell')?.discovery.binaries[0]).toBeUndefined();
  });
});

describe('adopted container: export never touches the container', () => {
  const routes = readFileSync(new URL('../src/web/routes/case-routes.ts', import.meta.url), 'utf8');
  const exporter = readFileSync(new URL('../src/docker-export.ts', import.meta.url), 'utf8');

  it('refuses a full-image export, which would commit a container we do not own', () => {
    expect(routes).toContain("if (mode === 'full' && dockerCase.owned === false)");
  });

  it('never pauses an adopted container for the workspace tar', () => {
    // `docker pause` freezes the owner's processes for as long as the tar takes.
    // It is the one export step that touches the container at all.
    expect(exporter).toContain('!isAdoptedContainer(docker) && (await isContainerRunning(');
  });
});

describe('adopted container: naming a foreign container is machine-level', () => {
  const routes = readFileSync(new URL('../src/web/routes/case-routes.ts', import.meta.url), 'utf8');
  const routeFor = (marker: string) => routes.slice(routes.indexOf(marker), routes.indexOf(marker) + 1400);

  it('admin-gates adoption in multi-user mode, unlike docker-link', () => {
    // docker-link only ever creates OUR container, whose sole bind mount is a
    // workspace isWorkingDirAllowed already confined. An adopted container's
    // mounts belong to its owner — one mounting `/` hands the adopter the host.
    expect(routeFor("'/api/cases/docker-adopt'")).toContain('adminOnly(req, reply)');
  });

  it('admin-gates enumerating and browsing containers', () => {
    expect(routeFor("'/api/docker-hosts/:hostId/containers'")).toContain('adminOnly(req, reply)');
    expect(routeFor("'/api/docker-cases/browse'")).toContain('adminOnly(req, reply)');
  });

  it('lets a non-admin preflight only a container linked to a case they own', () => {
    // NOT plain adminOnly: the run menu probes this for every docker case to learn
    // which CLIs the container has, so an admin-only gate would hide every agent
    // mode from a non-admin's own docker case.
    const route = routeFor("'/api/docker-cases/adopt-preflight'");
    expect(route).toContain('if (!isAdmin(req))');
    expect(route).toContain('canAccessOwned(getAuthUser(req), item.owner)');
    expect(route).not.toContain('adminOnly(req, reply)');
  });
});

describe('adopted container: a missing container means different things per ownership', () => {
  const ui = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf8');
  const routes = readFileSync(new URL('../src/web/routes/case-routes.ts', import.meta.url), 'utf8');

  it('records a probe failure only for an adopted case', () => {
    // An OWNED container does not exist until the first session launches it, so
    // "not found" is the expected answer for every freshly linked Docker case.
    // Treating it as a fault hid every agent mode behind an error telling the user
    // to start a container the launch chain was about to create itself.
    const probe = ui.slice(ui.indexOf('async _probeDockerCaseModes('), ui.indexOf('async _loadRunModeHistory('));
    expect(probe).toContain('if (activeCase?.docker?.owned === false) {');
    expect(probe.indexOf('if (activeCase?.docker?.owned === false) {')).toBeLessThan(
      probe.indexOf('this._dockerCaseProbeError[name] =')
    );
  });

  it('ships the ownership flag the UI reads that decision from', () => {
    expect(routes).toContain('...(dockerCase.owned === false ? { owned: false } : {}),');
  });
});

describe('adopted container: one container may back several cases', () => {
  const base = {
    type: 'docker' as const,
    hostId: 'h1',
    hostWorkspacePath: '/srv/work',
  };
  const mk = (over: Record<string, unknown>) => ({ ...base, ...over }) as never;
  const mine = () => true;

  it('allows a second adoption of the same container at a DIFFERENT directory', () => {
    // The whole point of the feature: one container, two folders, two cases.
    const conflict = classifyAdoptContainerConflict({
      container: 'devbox',
      containerWorkdir: '/app/api',
      existing: [mk({ name: 'web', container: 'devbox', containerWorkdir: '/app/web', owned: false })],
      canAccess: mine,
    });
    expect(conflict).toBeNull();
  });

  it('refuses an exact twin (same container AND same directory) and names the first case', () => {
    const conflict = classifyAdoptContainerConflict({
      container: 'devbox',
      containerWorkdir: '/app/web',
      existing: [mk({ name: 'web', container: 'devbox', containerWorkdir: '/app/web', owned: false })],
      canAccess: mine,
    });
    expect(conflict).toEqual({ kind: 'duplicate', caseName: 'web' });
  });

  it('falls back to hostWorkspacePath when containerWorkdir is absent on either side', () => {
    // containerWorkdir defaults to hostWorkspacePath, so an absent field on the
    // stored case must compare equal to an incoming adoption that omits it too —
    // otherwise the twin check silently stops firing for the default case.
    const conflict = classifyAdoptContainerConflict({
      container: 'devbox',
      containerWorkdir: '/srv/work',
      existing: [mk({ name: 'web', container: 'devbox', owned: false })],
      canAccess: mine,
    });
    expect(conflict).toEqual({ kind: 'duplicate', caseName: 'web' });
  });

  it('still refuses a container backing a case Codeman CREATED', () => {
    // Codeman owns that container's lifecycle: a recreate or case-delete there
    // would destroy the adopted case's container out from under it.
    const conflict = classifyAdoptContainerConflict({
      container: 'codeman-case-web',
      containerWorkdir: '/app/api',
      existing: [mk({ name: 'web', container: 'codeman-case-web', owned: true })],
      canAccess: mine,
    });
    expect(conflict).toEqual({ kind: 'owned-case', caseName: 'web' });
  });

  it('treats an ABSENT owned flag as owned, so legacy cases keep the old refusal', () => {
    const conflict = classifyAdoptContainerConflict({
      container: 'legacy',
      containerWorkdir: '/app/api',
      existing: [mk({ name: 'old', container: 'legacy' })],
      canAccess: mine,
    });
    expect(conflict).toEqual({ kind: 'owned-case', caseName: 'old' });
  });

  it('derives the container name from the case name when the field is absent', () => {
    const conflict = classifyAdoptContainerConflict({
      container: dockerContainerName('web'),
      containerWorkdir: '/app/api',
      existing: [mk({ name: 'web', owned: true })],
      canAccess: mine,
    });
    expect(conflict).toEqual({ kind: 'owned-case', caseName: 'web' });
  });

  it('refuses a container another user already adopted', () => {
    const conflict = classifyAdoptContainerConflict({
      container: 'devbox',
      containerWorkdir: '/app/api',
      existing: [mk({ name: 'theirs', container: 'devbox', owned: false, owner: 'bob' })],
      canAccess: (owner) => owner === 'alice',
    });
    expect(conflict).toEqual({ kind: 'other-owner', caseName: 'theirs' });
  });

  it('an owned case outranks a foreign adoption, so the message names the real blocker', () => {
    const conflict = classifyAdoptContainerConflict({
      container: 'devbox',
      containerWorkdir: '/app/api',
      existing: [
        mk({ name: 'theirs', container: 'devbox', owned: false, owner: 'bob' }),
        mk({ name: 'built', container: 'devbox', owned: true }),
      ],
      canAccess: (owner) => owner === 'alice',
    });
    expect(conflict).toEqual({ kind: 'owned-case', caseName: 'built' });
  });

  it('leaves an unrelated container alone', () => {
    expect(
      classifyAdoptContainerConflict({
        container: 'fresh',
        containerWorkdir: '/app',
        existing: [mk({ name: 'web', container: 'devbox', owned: false })],
        canAccess: mine,
      })
    ).toBeNull();
  });
});
