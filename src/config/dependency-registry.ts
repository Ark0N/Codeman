/**
 * @fileoverview Static registry of downstream tool dependencies probed by
 * `codeman doctor`. Each entry declares per-environment resolvers and the
 * skills that use it. EXTENSION POINT: skill-manifest-driven discovery
 * (COD follow-up) will merge dynamically-found entries into this list.
 *
 * @module config/dependency-registry
 */

import { enabledClis } from './cli-registry/registry.js';
import { compileVersionRegex } from './cli-registry/patterns.js';

export type ProbeEnvironment = 'linux' | 'darwin' | 'win32' | 'wsl';

/** The valid `--category` filter values; single source of truth for the type, the CLI
 *  help text, and CLI input validation. */
export const TOOL_CATEGORIES = ['core', 'office', 'other'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Resolve a binary on the PATH and read its version. */
export interface PathResolver {
  kind: 'path';
  bins: string[];
  versionArg?: string; // default '--version'
  versionRegex?: RegExp; // default matches first \d+.\d+(.\d+)?
  /**
   * Treat a binary whose version output does not match as NOT INSTALLED, instead of
   * reporting it with an unknown version. Only for tools with a short, generic binary
   * name (`pi`), where a `which` hit is not by itself evidence the right program is
   * there and a false "installed" contradicts the run mode's own resolver.
   */
  requireVersionMatch?: boolean;
}

/** Resolve a Windows-installed app reachable from win32 or WSL. */
export interface WindowsSideResolver {
  kind: 'windows-side';
  appDirs: string[]; // relative to a Program Files root
  exes: string[]; // candidate executables; first found wins
}

export interface ResolverSpec {
  match: ProbeEnvironment[];
  resolver: PathResolver | WindowsSideResolver;
}

export interface ToolDependency {
  id: string;
  label: string;
  category: ToolCategory;
  required: boolean;
  usedBy?: string[];
  minVersion?: string;
  resolvers: ResolverSpec[];
  installHint?: Partial<Record<ProbeEnvironment, string>>;
}

const ALL: ProbeEnvironment[] = ['linux', 'darwin', 'wsl', 'win32'];

/**
 * The doctor's ROW IDENTITY for a CLI, where it differs from the registry id.
 *
 * These are two separate contracts and they have never been the same thing: `codeman doctor`
 * prints a tool table whose ids predate the registry, and `dsh` names the BINARY while the
 * run mode is `deepseek`. Keeping the historical id here means the doctor's output does not
 * shift under a refactor that was supposed to change nothing a user can see.
 *
 * `usedBy` is likewise preserved verbatim rather than generated, because the strings are
 * shown to the user and claude's does not follow the pattern.
 */
const DOCTOR_ROW_OVERRIDES: Record<string, { id?: string; label?: string; usedBy: string[] }> = {
  // The label override keeps the doctor row's historical "Claude CLI" spelling now that
  // the registry label is the product name, "Claude Code".
  claude: { label: 'Claude CLI', usedBy: ['Claude Code sessions (default backend)'] },
  opencode: { usedBy: ['OpenCode sessions'] },
  codex: { usedBy: ['Codex sessions'] },
  gemini: { usedBy: ['Gemini sessions'] },
  antigravity: { usedBy: ['Antigravity sessions'] },
  pi: { usedBy: ['Pi sessions'] },
  grok: { usedBy: ['Grok sessions'] },
  // Both the id and the label are historical: `dsh` names the binary, and the doctor has
  // always spelled this row out in full rather than as `${label} CLI`.
  deepseek: { id: 'dsh', label: 'DeepSeek Harness CLI', usedBy: ['DeepSeek sessions'] },
};

/**
 * Build one `codeman doctor` row per enabled CLI, straight from its registry entry.
 *
 * This replaces eight hand-written rows that had to be kept in step with the run modes by
 * hand — and were not: an earlier draft of this refactor silently dropped the Grok and
 * DeepSeek rows, so `codeman doctor` stopped reporting two shipped CLIs at all. Deriving
 * the list makes that class of omission impossible.
 *
 * ⚠️ The version regex is compiled through `compileVersionRegex()`, NOT `new RegExp()`. It
 * is a config-supplied pattern, so it goes through the same length cap and
 * nested-quantifier rejection the argv engine applies; the doctor runs it over command
 * output exactly like the resolver does, and skipping the guard here would leave one
 * unguarded path into a user-supplied regex.
 *
 * ⚠️ Sharing the entry's regex with the resolver is what stops the doctor and the run mode
 * telling the user opposite things about the same binary — the Dependencies panel reporting
 * "Pi CLI ✓" on a box where Run Pi stays hidden.
 */
function cliDependencyEntries(): ToolDependency[] {
  const rows: ToolDependency[] = [];
  for (const cli of enabledClis()) {
    // `shell` has no binary of its own (the login shell is resolved at spawn time), so
    // there is nothing for the doctor to probe.
    const bin = cli.discovery.binaries[0];
    if (!bin) continue;

    const override = DOCTOR_ROW_OVERRIDES[cli.id as string];
    const version = cli.discovery.version;
    const versionRegex = version?.regex ? (compileVersionRegex(version.regex) ?? undefined) : undefined;

    rows.push({
      id: override?.id ?? (cli.id as string),
      label: override?.label ?? `${cli.label} CLI`,
      category: 'core',
      required: false,
      usedBy: override?.usedBy ?? [`${cli.label} sessions`],
      resolvers: [
        {
          match: ALL,
          resolver: {
            kind: 'path',
            bins: [bin],
            versionArg: version?.arg ?? '--version',
            versionRegex,
            // Only meaningful for a CLI whose binary name is short, generic or squatted
            // (pi, grok, dsh): a bare `which` hit there is not evidence of the right
            // program, so a version mismatch means MISSING rather than unknown-version.
            requireVersionMatch: version?.requireVersionMatch,
          },
        },
      ],
      installHint: cli.discovery.install.command,
    });
  }
  return rows;
}

/**
 * The tools `codeman doctor` probes, resolved AT CALL TIME.
 *
 * ⚠️ A FUNCTION, not a module-level const, and for the same reason `sessionModeSchema()` and
 * `allowedEnvPrefixes()` are functions: `cliDependencyEntries()` reads the CLI registry, and
 * a const would have frozen the doctor's rows at first import while every schema resolved
 * per parse. A CLI enabled while the server was running — or a `reloadCliRegistry()` — then
 * moved the run menu and the validation but never the doctor, which would keep reporting the
 * catalog as it stood when something first imported this module. Building the array per call
 * costs a handful of object literals on a command that shells out to probe binaries anyway.
 */
export function dependencyRegistry(): ToolDependency[] {
  return [
    {
      id: 'node',
      label: 'Node.js',
      category: 'core',
      required: true,
      minVersion: '22.0.0',
      resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['node'], versionArg: '--version' } }],
      installHint: { linux: 'https://nodejs.org', darwin: 'brew install node', wsl: 'https://nodejs.org' },
    },
    {
      id: 'tmux',
      label: 'tmux',
      category: 'core',
      required: true,
      resolvers: [{ match: ['linux', 'darwin', 'wsl'], resolver: { kind: 'path', bins: ['tmux'], versionArg: '-V' } }],
      installHint: { linux: 'sudo apt install tmux', darwin: 'brew install tmux', wsl: 'sudo apt install tmux' },
    },
    ...cliDependencyEntries(),
    {
      id: 'libreoffice',
      label: 'LibreOffice',
      category: 'office',
      required: false,
      usedBy: ['document preview', 'thumbnails'],
      resolvers: [
        {
          match: ['linux', 'darwin', 'wsl'],
          resolver: { kind: 'path', bins: ['libreoffice', 'soffice'], versionArg: '--version' },
        },
      ],
      installHint: { linux: 'sudo apt install libreoffice', darwin: 'brew install --cask libreoffice' },
    },
    {
      id: 'pdftoppm',
      label: 'pdftoppm',
      category: 'office',
      required: false,
      usedBy: ['document preview', 'PDF/Office first-page thumbnails'],
      // poppler's pdftoppm prints its version to stderr; presence is what matters here.
      resolvers: [
        { match: ['linux', 'darwin', 'wsl'], resolver: { kind: 'path', bins: ['pdftoppm'], versionArg: '-v' } },
      ],
      installHint: {
        linux: 'sudo apt install poppler-utils',
        darwin: 'brew install poppler',
        wsl: 'sudo apt install poppler-utils',
      },
    },
    {
      id: 'msoffice',
      label: 'MS Office',
      category: 'office',
      required: false,
      usedBy: ['document preview', 'thumbnails'],
      resolvers: [
        {
          match: ['wsl', 'win32'],
          resolver: {
            kind: 'windows-side',
            appDirs: ['Microsoft Office/root/Office16'],
            exes: ['WINWORD.EXE', 'POWERPNT.EXE', 'EXCEL.EXE'],
          },
        },
      ],
    },
  ];
}
