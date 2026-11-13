/**
 * @fileoverview Resolve the Codex (OpenAI) CLI binary across common install paths.
 *
 * Mirrors opencode-cli-resolver.ts pattern. Finds the `codex` binary
 * and provides an augmented PATH string for tmux sessions.
 *
 * @module utils/codex-cli-resolver
 */

import { spawn } from 'node:child_process';
import { getCli } from '../config/cli-registry/registry.js';
import { expandHome } from './cli-resolver.js';
import { createCliExecutableResolver } from './cli-executable-resolver.js';
import { parseCodexRateLimitsResponse, type StatusTelemetry } from '../usage-telemetry.js';

/**
 * Directories probed after `which`, read from this CLI's registry entry so the spawn
 * path, `codeman doctor` and this resolver cannot disagree about where to look.
 * `~` is expanded by `expandHome`; nothing else is interpreted.
 */
const CODEX_SEARCH_DIRS = (): string[] => (getCli('codex')?.discovery.searchDirs ?? []).map(expandHome);

const CODEX_BINARY = process.platform === 'win32' ? 'codex.exe' : 'codex';
const codexResolver = createCliExecutableResolver({ binary: CODEX_BINARY, searchDirs: CODEX_SEARCH_DIRS });

/**
 * Finds the directory containing the `codex` binary.
 * Checks `which codex` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function resolveCodexDir(): string | null {
  return codexResolver.resolve()?.directory ?? null;
}

/** Absolute Codex executable path, for direct app-server requests. */
export function resolveCodexBinaryPath(): string | null {
  return codexResolver.resolve()?.binaryPath ?? null;
}

/**
 * Check if Codex CLI is available on the system.
 */
export function isCodexAvailable(): boolean {
  return resolveCodexDir() !== null;
}

type CodexRateLimitsRequest = (binaryPath: string, clientVersion: string) => Promise<unknown>;

const APP_SERVER_TIMEOUT_MS = 10_000;
const APP_SERVER_MAX_OUTPUT_BYTES = 256 * 1024;

function requestCodexRateLimits(binaryPath: string, clientVersion: string): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    let initialized = false;
    let buffer = '';
    const child = spawn(binaryPath, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const timeout = setTimeout(() => finish(null), APP_SERVER_TIMEOUT_MS);

    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill();
      resolve(value);
    };
    const send = (message: unknown): void => {
      if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let message: { id?: number; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) return finish(null);
        if (!initialized) {
          initialized = true;
          send({ method: 'account/rateLimits/read', id: 2 });
        }
      } else if (message.id === 2) {
        finish(message.error ? null : message.result);
      }
    };

    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > APP_SERVER_MAX_OUTPUT_BYTES) return finish(null);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'codeman', title: 'Codeman', version: clientVersion },
        capabilities: null,
      },
    });
  });
}

/** Read the signed-in host account's main Codex limits without exposing credentials. */
export async function readCodexPlanUsage(
  binaryPath: string,
  clientVersion: string,
  request: CodexRateLimitsRequest = requestCodexRateLimits
): Promise<StatusTelemetry | null> {
  return parseCodexRateLimitsResponse(await request(binaryPath, clientVersion));
}
