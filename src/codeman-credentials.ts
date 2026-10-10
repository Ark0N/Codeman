/**
 * @fileoverview Credentials for a client of this Codeman instance's own API.
 *
 * Env first, the data dir's `.env` as the fallback — the hand-authored file
 * `codeman attach`, `codeman tui` and `codeman agent` all read. One reader, so the
 * three clients cannot drift on quoting, comments or the default username.
 *
 * @module codeman-credentials
 */
import { readFileSync } from 'node:fs';
import { dataPath } from './config/instance.js';

export interface CodemanCredentials {
  username: string;
  /** Absent when no password is configured (or only the server's environment has it). */
  password?: string;
}

/**
 * Parse a `KEY=value` env file: blank lines and `#` comments skipped, an `export `
 * prefix tolerated (the file is hand-authored, often sourced by a shell too), one
 * layer of matching quotes stripped, anything that is not an assignment ignored.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

/** The data dir's `.env`, parsed. Absent or unreadable means `{}`. */
export function readCodemanEnvFile(envFilePath: string = dataPath('.env')): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(envFilePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * The lookup order every client uses, per field: the environment, then the `.env`
 * file, then (username only) `admin`. Pure, so a caller with its own environment
 * object (`codeman agent`'s guard takes one for testability) gets the same answer.
 */
export function credentialsFrom(env: NodeJS.ProcessEnv, fileEnv: Record<string, string>): CodemanCredentials {
  const username = env.CODEMAN_USERNAME || fileEnv.CODEMAN_USERNAME || 'admin';
  const password = env.CODEMAN_PASSWORD || fileEnv.CODEMAN_PASSWORD;
  return password ? { username, password } : { username };
}

/**
 * Credentials for the API. No password means no auth is configured, or the user has
 * it only in the server's environment, in which case the API answers 401.
 */
export function readCodemanCredentials(
  envFilePath: string = dataPath('.env'),
  env: NodeJS.ProcessEnv = process.env
): CodemanCredentials {
  return credentialsFrom(env, readCodemanEnvFile(envFilePath));
}

/** `Authorization` header value, or undefined when there is no password to send. */
export function basicAuthHeader(credentials: CodemanCredentials): string | undefined {
  if (!credentials.password) return undefined;
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}
