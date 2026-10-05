/**
 * @fileoverview Probe engine for `codeman doctor`. Resolves each registry tool
 * against an injectable ProbeHost (real impl uses child_process/fs; tests inject
 * fakes) and returns structured results. Pure given the host — no global I/O.
 *
 * @module utils/dependency-checker
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import type { ProbeEnvironment, ToolCategory, ToolDependency } from '../config/dependency-registry.js';

export interface EnvDetectionInputs {
  platform: NodeJS.Platform;
  procVersion: string;
  hasWindowsInterop: boolean;
}

export function detectEnvironment(inputs: EnvDetectionInputs): ProbeEnvironment {
  if (inputs.platform === 'win32') return 'win32';
  if (inputs.platform === 'darwin') return 'darwin';
  const isWsl = /microsoft|wsl/i.test(inputs.procVersion) && inputs.hasWindowsInterop;
  return isWsl ? 'wsl' : 'linux';
}

const DEFAULT_VERSION_RE = /(\d+\.\d+(?:\.\d+)?)/;

export function extractVersion(text: string, re?: RegExp): string | undefined {
  const m = (re ?? DEFAULT_VERSION_RE).exec(text);
  return m ? m[1] : undefined;
}

/** Returns -1 if a < b, 0 if equal, 1 if a > b (numeric, component-wise). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type ToolStatus = 'ok' | 'missing' | 'outdated' | 'skipped' | 'error';

export interface ToolResult {
  id: string;
  label: string;
  category: ToolCategory;
  required: boolean;
  usedBy: string[];
  status: ToolStatus;
  version?: string;
  path?: string;
  installHint?: string;
  reason?: string;
}

export interface ProbeHost {
  environment: ProbeEnvironment;
  which(bin: string): string | null;
  fileExists(path: string): boolean;
  runVersion(bin: string, args: string[]): string | null;
  windowsProgramRoots(): string[];
  windowsFileVersion(winPath: string): string | null;
}

function finalize(
  base: Pick<ToolResult, 'id' | 'label' | 'category' | 'required' | 'usedBy'>,
  tool: ToolDependency,
  path: string,
  version: string | undefined
): ToolResult {
  if (tool.minVersion) {
    if (!version) return { ...base, status: 'error', path, reason: 'version required but could not be parsed' };
    if (compareVersions(version, tool.minVersion) < 0) return { ...base, status: 'outdated', path, version };
  }
  return { ...base, status: 'ok', path, version };
}

export function checkTool(tool: ToolDependency, host: ProbeHost): ToolResult {
  const base = {
    id: tool.id,
    label: tool.label,
    category: tool.category,
    required: tool.required,
    usedBy: tool.usedBy ?? [],
  };
  const installHint = tool.installHint?.[host.environment];

  const spec = tool.resolvers.find((r) => r.match.includes(host.environment));
  if (!spec) return { ...base, status: 'skipped', reason: `not applicable on ${host.environment}` };

  if (spec.resolver.kind === 'path') {
    const { bins, versionArg, versionRegex, requireVersionMatch, searchDirs } = spec.resolver;
    for (const bin of bins) {
      // `which` first (the PATH), then the registry's search dirs: under a service the PATH is
      // minimal and the run mode finds the CLI through those dirs, so the doctor must too.
      let resolved = host.which(bin);
      if (!resolved && searchDirs) {
        for (const dir of searchDirs) {
          const candidate = `${dir.replace(/\/+$/, '')}/${bin}`;
          if (host.fileExists(candidate)) {
            resolved = candidate;
            break;
          }
        }
      }
      if (resolved) {
        // Run the RESOLVED path: a bare name would miss the same binary `which` just missed.
        const out = host.runVersion(resolved, [versionArg ?? '--version']);
        const version = out ? extractVersion(out, versionRegex) : undefined;
        // A generic binary name that prints the wrong thing is some OTHER program (see
        // PathResolver.requireVersionMatch). Keep looking, then report MISSING; the
        // alternative is claiming a tool is installed that the feature's own resolver
        // rejects, which reads as "the mode is broken" rather than "install it".
        if (requireVersionMatch && !version) continue;
        return finalize(base, tool, resolved, version);
      }
    }
    return { ...base, status: 'missing', installHint };
  }

  // windows-side
  const { appDirs, exes } = spec.resolver;
  for (const root of host.windowsProgramRoots()) {
    for (const dir of appDirs) {
      for (const exe of exes) {
        const winPath = `${root}/${dir}/${exe}`;
        if (host.fileExists(winPath)) {
          const raw = host.windowsFileVersion(winPath);
          const version = raw ? extractVersion(raw) : undefined;
          return finalize(base, tool, winPath, version);
        }
      }
    }
  }
  return { ...base, status: 'missing', installHint };
}

export function checkAll(registry: ToolDependency[], host: ProbeHost): ToolResult[] {
  return registry.map((tool) => checkTool(tool, host));
}

function safeWhich(bin: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

function safeRunVersion(bin: string, args: string[]): string | null {
  try {
    return execFileSync(bin, args, {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err: unknown) {
    // Some tools (e.g. ffmpeg) exit non-zero on -version but still print to stdout
    const stdout = (err as { stdout?: Buffer | string })?.stdout;
    return stdout ? stdout.toString() : null;
  }
}

function readProcVersion(): string {
  try {
    return readFileSync('/proc/version', 'utf-8');
  } catch {
    return '';
  }
}

function listWindowsProgramRoots(): string[] {
  const roots: string[] = [];
  try {
    for (const entry of readdirSync('/mnt')) {
      for (const pf of ['Program Files', 'Program Files (x86)']) {
        const root = `/mnt/${entry}/${pf}`;
        if (existsSync(root)) roots.push(root);
      }
    }
  } catch {
    // /mnt absent (not WSL) -> no roots
  }
  return roots;
}

function readWindowsFileVersion(winPath: string): string | null {
  try {
    const windowsPath = execFileSync('wslpath', ['-w', winPath], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Item '${windowsPath.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function createRealHost(): ProbeHost {
  const environment = detectEnvironment({
    platform: process.platform,
    procVersion: readProcVersion(),
    hasWindowsInterop: safeWhich('cmd.exe') !== null || safeWhich('powershell.exe') !== null,
  });
  return {
    environment,
    which: safeWhich,
    fileExists: existsSync,
    runVersion: safeRunVersion,
    windowsProgramRoots: listWindowsProgramRoots,
    windowsFileVersion: readWindowsFileVersion,
  };
}
