/**
 * @fileoverview Authentication and security middleware.
 *
 * Extracted from server.ts setupRoutes() — handles:
 * - HTTP Basic Auth with session cookies
 * - Rate limiting (per-IP failure tracking)
 * - Security headers (CSP, X-Frame-Options, HSTS)
 * - CORS (localhost only)
 */

import { FastifyInstance } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StaleExpirationMap } from '../../utils/index.js';

// Auth session cookie TTL (24h — matches autonomous run length)
const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
// Auth session cookie name
const AUTH_COOKIE_NAME = 'codeman_session';
// Max concurrent auth sessions
const MAX_AUTH_SESSIONS = 100;
// Max failed auth attempts per IP before rate-limiting
const AUTH_FAILURE_MAX = 10;
// Failed auth attempt tracking window (15 minutes)
const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** State returned from registerAuthMiddleware for cleanup in server stop() */
export interface AuthState {
  authSessions: StaleExpirationMap<string, string> | null;
  authFailures: StaleExpirationMap<string, number> | null;
}

/**
 * Register HTTP Basic Auth middleware with session cookies and rate limiting.
 * Only active when CODEMAN_PASSWORD is set.
 *
 * @returns AuthState for lifecycle management (dispose on server stop)
 */
export function registerAuthMiddleware(app: FastifyInstance, https: boolean): AuthState {
  const state: AuthState = {
    authSessions: null,
    authFailures: null,
  };

  const authPassword = process.env.CODEMAN_PASSWORD;
  if (!authPassword) return state;

  const authUsername = process.env.CODEMAN_USERNAME || 'admin';
  const expectedHeader = 'Basic ' + Buffer.from(`${authUsername}:${authPassword}`).toString('base64');

  // Session token store — active sessions extend TTL on access
  state.authSessions = new StaleExpirationMap<string, string>({
    ttlMs: AUTH_SESSION_TTL_MS,
    refreshOnGet: true,
  });

  // Failure counter per IP — decay naturally after 15 minutes
  state.authFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  const authSessions = state.authSessions;
  const authFailures = state.authFailures;

  app.addHook('onRequest', (req, reply, done) => {
    // Hook events come from local Claude Code hooks (curl from localhost) — no auth headers available.
    // Safe: validated by HookEventSchema, only triggers broadcasts.
    // Security: restrict bypass to localhost only — prevents forged hook events via tunnel/LAN.
    if (req.url === '/api/hook-event' && req.method === 'POST') {
      const ip = req.ip;
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
        done();
        return;
      }
      // Non-localhost hook requests fall through to normal auth
    }

    const clientIp = req.ip;

    // Rate limit: reject if too many failed attempts from this IP
    const failures = authFailures.get(clientIp) ?? 0;
    if (failures >= AUTH_FAILURE_MAX) {
      reply.code(429).send('Too Many Requests — try again later');
      return;
    }

    // Check session cookie first (avoids re-sending credentials on every request)
    // Use get() instead of has() so refreshOnGet extends the TTL on active sessions
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken && authSessions.get(sessionToken) !== undefined) {
      done();
      return;
    }

    // Check Basic Auth header (timing-safe comparison to prevent side-channel attacks)
    const auth = req.headers.authorization;
    const authBuf = Buffer.from(auth ?? '');
    const expectedBuf = Buffer.from(expectedHeader);
    if (authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf)) {
      // Issue session token cookie so browser doesn't need to re-send credentials
      const token = randomBytes(32).toString('hex');

      // Evict oldest if at capacity (prevent unbounded growth)
      if (authSessions.size >= MAX_AUTH_SESSIONS) {
        const oldestKey = authSessions.keys().next().value;
        if (oldestKey !== undefined) authSessions.delete(oldestKey);
      }

      authSessions.set(token, clientIp);

      // Reset failure count on successful auth
      authFailures.delete(clientIp);

      reply.setCookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: https,
        sameSite: 'lax',
        maxAge: AUTH_SESSION_TTL_MS / 1000, // seconds
        path: '/',
      });
      done();
      return;
    }

    // Auth failed — track failure count
    authFailures.set(clientIp, failures + 1);

    reply.header('WWW-Authenticate', 'Basic realm="Codeman"');
    reply.code(401).send('Unauthorized');
  });

  return state;
}

/**
 * Register security headers and CORS middleware on every response.
 */
export function registerSecurityHeaders(app: FastifyInstance, https: boolean): void {
  app.addHook('onRequest', (req, reply, done) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self' wss://api.deepgram.com; font-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'self'"
    );
    if (https) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // CORS: restrict to same-origin (localhost) only
    const origin = req.headers.origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
          reply.header('Access-Control-Allow-Origin', origin);
          reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
          reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          reply.header('Access-Control-Max-Age', '86400');
        }
      } catch {
        // Invalid origin header — do not set CORS headers
      }
    }

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
      done();
      return;
    }

    done();
  });
}
