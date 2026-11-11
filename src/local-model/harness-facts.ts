/**
 * @fileoverview What the server knows about each catalogue harness on this machine, for the
 * local model recommendation. Server side: this is the one module of src/local-model/ that
 * reads the CLI registry, so `recommend()` can stay pure and name no CLI.
 *
 * `buildHarnessFacts()` walks the catalogue's `harnesses` rows and, for every row:
 *  - resolves its `cli` in the CLI registry AT CALL TIME (never in a module-level constant),
 *    and leaves the row out when the CLI is unknown, disabled, or has no custom model
 *    mechanism (`capabilities.customModelInjection.kind` is `unsupported`);
 *  - reports `label` from the registry entry and `installed` from the same probe the page
 *    render and `GET /api/clis` use (`utils/cli-installed-probes.ts`), asked once per build;
 *  - reports `installable` only for a STOCK CLI that is not installed, whose install command
 *    for this platform needs no administrator rights (`installCommandNeedsAdmin()`) and which
 *    is not a launcher (`discovery.launcherProfile`: its install command leaves it with nothing
 *    to launch, and what it launches is third-party code with a consent of its own in the Run
 *    menu), and then carries that command as `installCommand`, so the consent screen can print the
 *    literal text. The command is the COMPILED stock one (`stockInstallCommand()`), never the
 *    one a `clis.json` override supplies: it is exactly what the install job would run, and
 *    an override file must not be able to change that;
 *  - supplies `acceptsModelId` (`cliAcceptsCustomModelId()`), the test a custom model launch
 *    applies to the model id before anything is written;
 *  - passes on the registry's `capabilities.composerReadyMark` as `readyMark` when it holds no
 *    white space (a script waits for it as one literal).
 *
 * Rules:
 *  - No CLI id is compared with a literal here or anywhere: the id comes from the catalogue
 *    row and everything else from the registry entry it resolves to.
 *  - Read-only: nothing is installed, written or spawned beyond the existing availability
 *    probe. An install command is only read as text, never run.
 *  - Never throws: a probe that fails reads as "not installed" (with a warning in the log),
 *    and the registry's install data still answers `installable`.
 *
 * `cliAcceptsCustomModelId()` composes the two pure pieces the launch path itself calls
 * (`buildCustomModelInjection()` and `matchesPattern()` on the entry's `model` launch param).
 * The launch path keeps that composition inline at two sites in
 * src/web/routes/session-routes.ts (the quick-start `customModel` branch and
 * `POST /api/sessions/:id/custom-model`). A change to the rule there must be made here too,
 * until the three share one helper.
 */

import type { CliEntry } from '../config/cli-registry/types.js';
import { matchesPattern } from '../config/cli-registry/patterns.js';
import { stockInstallCommand } from '../cli-install-runner.js';
import { getCli } from '../config/cli-registry/registry.js';
import { buildCustomModelInjection, type CustomModelEndpoint } from '../custom-model-injection.js';
import { isCliEntryInstalled, probeStockCliAvailability } from '../utils/cli-installed-probes.js';
import { getErrorMessage, type HarnessFact, type LocalModelCatalog } from '../types.js';

/** What `buildHarnessFacts()` reads. Each member defaults to the real module; a test overrides what it needs. */
export interface HarnessFactsDeps {
  /** One CLI of the registry, looked up when the facts are built. */
  getCli: (id: string) => CliEntry | undefined;
  /**
   * The availability probe, asked ONCE per build: it answers with a test for single entries.
   * Under vitest the real probe is inert (it finds no CLI), so a test that cares about
   * `installed` passes its own.
   */
  probeInstalled: () => Promise<(entry: CliEntry) => boolean>;
  /**
   * The install command the install job would run for this CLI on this platform: the compiled
   * stock command, `undefined` for a CLI that is not stock or has none here. Read as text,
   * never run.
   */
  installCommandFor: (entry: CliEntry) => string | undefined;
}

export const defaultHarnessFactsDeps: HarnessFactsDeps = {
  getCli,
  probeInstalled: async () => {
    const stockAvailability = await probeStockCliAvailability();
    return (entry) => isCliEntryInstalled(entry, stockAvailability);
  },
  installCommandFor: (entry) => stockInstallCommand(entry.id as string),
};

/**
 * A command segment that starts with `sudo` or `brew`: at the start of the text, or after a
 * pipe, `&&`, `||`, `;`, a line break or an opening parenthesis.
 */
const ADMIN_COMMAND = /(?:^|[;&|(\n])\s*(?:sudo|brew)(?=\s|$)/;

/**
 * Whether an install command needs administrator rights, read off its text.
 *  - `sudo ...` asks for an administrator password.
 *  - `brew ...` needs Homebrew, and installing Homebrew needs an administrator (the same rule
 *    the installer's no-admin route applies to the CLI menu).
 * `curl ... | bash` installers write into the home directory, and the install runner points an
 * `npm install -g` at a prefix the server user can write, so neither counts.
 */
export function installCommandNeedsAdmin(command: string): boolean {
  return ADMIN_COMMAND.test(command);
}

/** Stands in for a configured endpoint: the launch id a recipe forces depends on the model id alone. */
const PROBE_ENDPOINT: CustomModelEndpoint = {
  id: 'local-model-probe',
  label: 'local model probe',
  baseUrl: 'http://127.0.0.1',
};

/**
 * Whether a custom model launch of this CLI would accept `modelId`.
 *
 * A CLI whose config alone cannot select the model gets the id forced onto its `model` launch
 * param (the recipe's `launchModel` template). The argv engine DROPS a token that fails the
 * param's pattern, which would start the CLI on its own default provider, so the launch path
 * refuses such an id up front. This is that test: false when the forced value does not match
 * the pattern, and false for a CLI with no custom model mechanism at all.
 */
export function cliAcceptsCustomModelId(entry: Pick<CliEntry, 'capabilities' | 'launch'>, modelId: string): boolean {
  try {
    const injection = buildCustomModelInjection(entry, PROBE_ENDPOINT, modelId);
    if (injection.kind === 'unsupported') return false;
    const forcedLaunchModel = injection.launchModel;
    const modelSpec = entry.launch.params.model;
    return !(
      forcedLaunchModel !== undefined &&
      modelSpec?.type === 'token' &&
      !matchesPattern(modelSpec.pattern, forcedLaunchModel)
    );
  } catch {
    // A recipe that cannot be rendered cannot be launched either.
    return false;
  }
}

/** One fact per catalogue harness that resolves in the CLI registry, in catalogue order. */
export async function buildHarnessFacts(
  catalog: LocalModelCatalog,
  deps: Partial<HarnessFactsDeps> = {}
): Promise<HarnessFact[]> {
  const resolved: HarnessFactsDeps = { ...defaultHarnessFactsDeps, ...deps };

  let isInstalled: (entry: CliEntry) => boolean;
  try {
    isInstalled = await resolved.probeInstalled();
  } catch (err) {
    console.warn(
      `[local-model] The CLI availability probe failed, reading every harness as not installed: ${getErrorMessage(err)}`
    );
    isInstalled = () => false;
  }

  const facts: HarnessFact[] = [];
  const seen = new Set<string>();
  for (const row of catalog.harnesses) {
    // The catalogue lists a CLI once; a second row for it adds nothing a fact could carry.
    if (seen.has(row.cli)) continue;
    seen.add(row.cli);

    const entry = resolved.getCli(row.cli);
    if (!entry || !entry.enabled) continue;
    if (entry.capabilities.customModelInjection.kind === 'unsupported') continue;

    let installed = false;
    try {
      installed = isInstalled(entry);
    } catch (err) {
      console.warn(`[local-model] Probing ${entry.label} failed, reading it as not installed: ${getErrorMessage(err)}`);
    }

    let installCommand: string | undefined;
    // A launcher (`discovery.launcherProfile`) is not startable after its install command: it
    // still needs something to launch, which that command does not install.
    if (!installed && entry.stock && entry.discovery.launcherProfile === undefined) {
      const command = resolved.installCommandFor(entry);
      if (command !== undefined && command.trim() !== '' && !installCommandNeedsAdmin(command)) {
        installCommand = command;
      }
    }

    const registryMark = entry.capabilities.composerReadyMark;
    facts.push({
      cli: row.cli,
      label: entry.label,
      installed,
      installable: installCommand !== undefined,
      ...(installCommand !== undefined ? { installCommand } : {}),
      ...(registryMark !== undefined && !/\s/.test(registryMark) ? { readyMark: registryMark } : {}),
      acceptsModelId: (modelId: string) => cliAcceptsCustomModelId(entry, modelId),
    });
  }
  return facts;
}
