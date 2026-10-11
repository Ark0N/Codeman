/**
 * @fileoverview GitHub Copilot's monthly premium-request quota, for the header plan-usage chip.
 *
 * The Copilot CLI has no scriptable usage command (`copilot billing` exists only inside the TUI), but
 * the same quota snapshot the editors show is `GET https://api.github.com/copilot_internal/user`,
 * readable with the CLI's own sign-in token. The endpoint is not part of GitHub's documented REST API,
 * so this is read-only, best-effort and silent: any failure (offline, 401, a changed shape) yields
 * `null` and the chip simply has no Copilot row.
 *
 * ⚠️ The token is never logged, never put in an error and only ever sent to api.github.com over HTTPS
 * (`redirect: 'error'`, so a redirect cannot carry it elsewhere).
 *
 * @module utils/copilot-plan-usage
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCopilotQuotaResponse, type StatusTelemetry } from '../usage-telemetry.js';

export const COPILOT_QUOTA_URL = 'https://api.github.com/copilot_internal/user';
const REQUEST_TIMEOUT_MS = 10_000;

/** Env names Copilot itself reads for a headless sign-in, in its own precedence order. */
const TOKEN_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/** The CLI writes `// ...` header comments above the JSON in config.json. */
function parseCommentedJson(raw: string): unknown {
  return JSON.parse(
    raw
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
  );
}

/**
 * The sign-in token Copilot would use: a token in the environment first, then the plain-text
 * `authTokens` entry the CLI keeps in `<COPILOT_HOME or ~/.copilot>/config.json` when no OS keychain
 * is available. Only github.com sign-ins are read from the file (the quota URL is github.com's).
 */
export function resolveCopilotToken(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string | null {
  for (const key of TOKEN_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  const dir = env.COPILOT_HOME?.trim() || join(home, '.copilot');
  try {
    const config = parseCommentedJson(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      lastLoggedInUser?: { host?: string; login?: string };
      authTokens?: Record<string, { token?: unknown } | undefined>;
    };
    const { host, login } = config.lastLoggedInUser ?? {};
    if (host !== 'https://github.com' || !login || !config.authTokens) return null;
    for (const key of [`${host}:${login}`, `${host}:${login}:github`]) {
      const token = config.authTokens[key]?.token;
      if (typeof token === 'string' && token.trim()) return token.trim();
    }
  } catch {
    /* no config, unreadable, or not JSON: no token */
  }
  return null;
}

export interface ReadCopilotPlanUsageOptions {
  /** Defaults to `resolveCopilotToken()`. */
  token?: string | null;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

/** The monthly premium-request window, or null when there is no token, no meter or any failure. */
export async function readCopilotPlanUsage(opts: ReadCopilotPlanUsageOptions = {}): Promise<StatusTelemetry | null> {
  const token = opts.token === undefined ? resolveCopilotToken() : opts.token;
  if (!token) return null;
  const doFetch = opts.fetchFn ?? fetch;
  try {
    const response = await doFetch(COPILOT_QUOTA_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'codeman',
        'X-GitHub-Api-Version': '2025-04-01',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseCopilotQuotaResponse(await response.json());
  } catch {
    return null;
  }
}
