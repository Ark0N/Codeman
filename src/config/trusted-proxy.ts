/**
 * @fileoverview Trusted reverse-proxy identity (multi-user mode, opt-in, off by default).
 *
 * Lets an authenticating reverse proxy on the same host (oauth2-proxy behind Caddy or
 * nginx, Apache mod_auth_openidc, Authelia, ...) sign users in through an identity
 * provider such as Entra ID, Google or Keycloak, instead of the Basic-auth password
 * prompt. The proxy authenticates the person and forwards two headers:
 *
 *   X-Codeman-Proxy-Secret: <the shared secret>
 *   X-Codeman-User:         <codeman username>
 *
 * Codeman accepts the identity only when ALL of these hold:
 *  - multi-user mode is on (the username must name an existing, enabled account; there
 *    is no auto-provisioning, so an admin still decides who has an account);
 *  - a secret is configured: at least 32 printable ASCII characters, from
 *    `CODEMAN_TRUSTED_PROXY_SECRET_FILE` (preferred) or `CODEMAN_TRUSTED_PROXY_SECRET`;
 *  - the request arrives over a loopback socket (`req.ip`, which ignores
 *    X-Forwarded-For because Fastify runs with `trustProxy: false`);
 *  - the presented secret matches (timing-safe).
 *
 * What the secret does and does not separate: every process on the host reaches the
 * loopback port, so loopback alone proves nothing, and the secret is what a local process
 * lacks. It is not a boundary against code that can read the secret file or Codeman's
 * memory, i.e. anything running as Codeman's OS account (see the multi-user threat
 * model: sessions share that account). To keep it out of the obvious places, the value
 * is read ONCE and both `CODEMAN_TRUSTED_PROXY_SECRET` and
 * `CODEMAN_TRUSTED_PROXY_SECRET_FILE` are then deleted from `process.env`, because every
 * session Codeman spawns inherits that environment. The file's resolved path stays in
 * this module (`trustedProxySecretFilePath`) for the sensitive-path blocklist.
 *
 * A configured setup that can't be used stops the server from starting
 * (`trustedProxyConfigError`, thrown from `WebServer.start()`), so a typo never falls
 * back silently to password sign-in.
 *
 * The two headers are taken off every request before anything else sees them
 * (`takeTrustedProxyHeaders`, called from the first auth hook), so nothing downstream,
 * e.g. the web-tab relay, can forward or log them.
 */

import { readFileSync, statSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { resolve } from 'node:path';

/** Header carrying the shared secret that proves the request came through the proxy. */
export const TRUSTED_PROXY_SECRET_HEADER = 'x-codeman-proxy-secret';

/** Default header carrying the authenticated Codeman username. */
export const DEFAULT_TRUSTED_PROXY_USER_HEADER = 'x-codeman-user';

/** Minimum secret length; a shorter secret stops the server from starting. */
export const TRUSTED_PROXY_SECRET_MIN_LENGTH = 32;

/**
 * The username header is deleted from EVERY request (see takeTrustedProxyHeaders), so it
 * must never be a header anything else needs. Allowed by shape, not by a deny list of
 * standard headers: an `X-...` extension header (minus the reserved ones below) or the
 * conventional `Remote-User`.
 */
const USER_HEADER_RE = /^x-[a-z0-9][a-z0-9-]*$/;
/** Identity headers authenticating proxies commonly send; allowed despite the reserved prefix. */
const ALLOWED_FORWARDED_IDENTITY_HEADERS = new Set([
  'x-forwarded-user',
  'x-forwarded-email',
  'x-forwarded-preferred-username',
]);
const RESERVED_USER_HEADER_PREFIXES = ['x-forwarded-', 'x-codeman-'];
const RESERVED_USER_HEADERS = new Set([
  'x-real-ip',
  'x-requested-with',
  'x-http-method-override',
  'x-csrf-token',
  'x-xsrf-token',
]);

/** Resolved trusted-proxy configuration, or null when the feature is off. */
export interface TrustedProxyConfig {
  secret: string;
  /** Lower-cased header name the username is read from. */
  userHeader: string;
}

interface LoadedSecret {
  secret?: string;
  /** Why a configured secret can't be used (never contains the secret). */
  problem?: string;
  /** Absolute path of `CODEMAN_TRUSTED_PROXY_SECRET_FILE`, when it was set. */
  filePath?: string;
}

let loaded: LoadedSecret | null = null;

/**
 * Read the secret once, then delete `CODEMAN_TRUSTED_PROXY_SECRET` and
 * `CODEMAN_TRUSTED_PROXY_SECRET_FILE` from `process.env` so sessions spawned later don't
 * inherit either. Cached for the process lifetime.
 */
function loadSecret(): LoadedSecret {
  if (loaded) return loaded;
  const inline = process.env.CODEMAN_TRUSTED_PROXY_SECRET?.trim();
  const file = process.env.CODEMAN_TRUSTED_PROXY_SECRET_FILE?.trim();
  delete process.env.CODEMAN_TRUSTED_PROXY_SECRET;
  delete process.env.CODEMAN_TRUSTED_PROXY_SECRET_FILE;
  const filePath = file ? resolve(file) : undefined;

  let secret: string | undefined;
  let problem: string | undefined;
  if (inline && file) {
    problem = 'both CODEMAN_TRUSTED_PROXY_SECRET and CODEMAN_TRUSTED_PROXY_SECRET_FILE are set; set only one';
  } else if (file) {
    try {
      secret = readFileSync(file, 'utf-8').trim() || undefined;
      if (!secret) problem = `CODEMAN_TRUSTED_PROXY_SECRET_FILE (${file}) is empty`;
      // POSIX modes only; Windows reports synthetic ones.
      else if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
        problem = `CODEMAN_TRUSTED_PROXY_SECRET_FILE (${file}) is readable by other users; chmod 600 it`;
      }
    } catch (err) {
      problem = `cannot read CODEMAN_TRUSTED_PROXY_SECRET_FILE (${file}): ${(err as NodeJS.ErrnoException).code ?? 'error'}`;
    }
  } else if (inline) {
    secret = inline;
  }
  if (secret && !problem) {
    if (secret.length < TRUSTED_PROXY_SECRET_MIN_LENGTH) {
      problem = `the trusted-proxy secret is shorter than ${TRUSTED_PROXY_SECRET_MIN_LENGTH} characters (generate one with: openssl rand -hex 32)`;
    } else if (!/^[\x21-\x7e]+$/.test(secret)) {
      // Header bytes arrive as latin1 and the env/file value as UTF-8, so anything outside
      // printable ASCII could never match.
      problem =
        'the trusted-proxy secret must be printable ASCII without spaces (generate one with: openssl rand -hex 32)';
    }
  }
  loaded = { secret, problem, filePath };
  return loaded;
}

/**
 * Read the secret now and remove both variables from `process.env`. Called first in
 * `WebServer.start()` and again (a no-op then) at auth setup, before any session is
 * spawned or restored, in every mode.
 */
export function initTrustedProxySecret(): void {
  loadSecret();
}

/**
 * Absolute path of the configured secret file, or null. After the secret was read the
 * variable is gone from `process.env`, so this answers from the cached value; before
 * that, from the environment. Never reads the file.
 */
export function trustedProxySecretFilePath(): string | null {
  if (loaded) return loaded.filePath ?? null;
  const file = process.env.CODEMAN_TRUSTED_PROXY_SECRET_FILE?.trim();
  return file ? resolve(file) : null;
}

/** Test-only: forget the cached secret so the next call re-reads the environment. */
export function resetTrustedProxySecretForTests(): void {
  loaded = null;
}

/** The configured username header (lower-cased), or the default. Not validated. */
function rawUserHeader(): string {
  return process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER?.trim().toLowerCase() || DEFAULT_TRUSTED_PROXY_USER_HEADER;
}

/** Why the configured username header can't be used, or null when it is fine. */
function userHeaderProblem(name: string): string | null {
  if (name === DEFAULT_TRUSTED_PROXY_USER_HEADER || name === 'remote-user') return null;
  if (ALLOWED_FORWARDED_IDENTITY_HEADERS.has(name)) return null;
  if (!USER_HEADER_RE.test(name)) {
    return `CODEMAN_TRUSTED_PROXY_USER_HEADER (${name}) must be an X-... header or Remote-User`;
  }
  if (RESERVED_USER_HEADERS.has(name) || RESERVED_USER_HEADER_PREFIXES.some((p) => name.startsWith(p))) {
    return `CODEMAN_TRUSTED_PROXY_USER_HEADER may not be ${name} (reserved)`;
  }
  return null;
}

/**
 * The username header to strip and read: the configured one when it is usable, the default
 * otherwise. Resolve it once (at auth setup) and pass it to `takeTrustedProxyHeaders`. A
 * rejected name is never used, so a careless setting can't strip a header others need.
 */
export function resolveTrustedProxyUserHeader(): string {
  const name = rawUserHeader();
  return userHeaderProblem(name) ? DEFAULT_TRUSTED_PROXY_USER_HEADER : name;
}

/**
 * The active configuration, or null when the feature is off: no usable secret, an
 * unusable username header, or single-user mode (no named accounts to map onto). The
 * unusable cases also stop the start (`trustedProxyConfigError`); this is the second layer.
 */
export function getTrustedProxyConfig(multiUser: boolean): TrustedProxyConfig | null {
  const { secret, problem } = loadSecret();
  if (!multiUser || !secret || problem) return null;
  const userHeader = rawUserHeader();
  if (userHeaderProblem(userHeader)) return null;
  return { secret, userHeader };
}

/**
 * Why a configured trusted-proxy setup can't be used, as the message for the start-up
 * refusal, or null when it is fine (not configured, or valid). Never includes the secret.
 * Refused: both secret variables set; a secret file that can't be read, is empty or is
 * readable by group or others (not checked on Windows); a secret shorter than 32
 * characters or not printable ASCII; a secret with multi-user mode off; and a
 * `CODEMAN_TRUSTED_PROXY_USER_HEADER` the validation rejects (set at all, secret or not).
 */
export function trustedProxyConfigError(multiUser: boolean): string | null {
  const { secret, problem } = loadSecret();
  let reason: string | null = null;
  if (problem) reason = problem;
  else if (secret && !multiUser) reason = 'a trusted-proxy secret is set but multi-user mode is off';
  else if (process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER?.trim()) reason = userHeaderProblem(rawUserHeader());
  return reason
    ? `Trusted-proxy sign-in is misconfigured: ${reason}. Fix or remove the setting and start again.`
    : null;
}

/** What a request presented, after `takeTrustedProxyHeaders` removed the headers. */
export interface PresentedProxyHeaders {
  /** True when the secret header was present at all, even empty. */
  secretPresent: boolean;
  /** The presented secret (duplicates joined with ", ", so they never match). */
  secret: string;
  /**
   * The presented username exactly as sent ('' when absent). The auth hook normalizes and
   * validates it with the user store's own rule. A duplicated header arrives joined
   * ("alice, bob"), which that rule rejects, so it is refused with 403.
   */
  user: string;
}

/**
 * Read the trusted-proxy headers and DELETE them from `headers`, so nothing that later
 * copies request headers (the web-tab relay, logging) ever sees the secret. Removes the
 * secret header, the default username header and `userHeader` (from
 * `resolveTrustedProxyUserHeader`, so always a usable name), whether or not the feature is
 * on: a proxy may send them to an instance that has it off.
 */
export function takeTrustedProxyHeaders(
  headers: IncomingHttpHeaders,
  userHeader: string = DEFAULT_TRUSTED_PROXY_USER_HEADER
): PresentedProxyHeaders {
  const rawSecret = headers[TRUSTED_PROXY_SECRET_HEADER];
  const rawUser = headers[userHeader];
  delete headers[TRUSTED_PROXY_SECRET_HEADER];
  delete headers[DEFAULT_TRUSTED_PROXY_USER_HEADER];
  delete headers[userHeader];

  return {
    secretPresent: rawSecret !== undefined,
    secret: Array.isArray(rawSecret) ? rawSecret.join(', ') : (rawSecret ?? ''),
    user: Array.isArray(rawUser) ? rawUser.join(', ') : (rawUser ?? ''),
  };
}
