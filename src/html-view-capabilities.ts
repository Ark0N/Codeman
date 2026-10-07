/**
 * @fileoverview Capability tokens for rendering a local HTML file.
 *
 * `file-raw` never serves HTML as HTML: a page rendered from Codeman's own origin
 * could read the Codeman document and drive the agent-spawning API. So an HTML
 * file is rendered from `/html-view/:cap/*` instead, with a `Content-Security-
 * Policy: sandbox` header that puts the document in an OPAQUE origin no matter how
 * it is opened (iframe or top-level tab). That opaque origin is also why the route
 * cannot authenticate on the session cookie: its subresource requests are
 * cross-site, so the `SameSite=lax` cookie is never attached (the same reason the
 * web-tab proxy uses capabilities, see webview-capabilities.ts).
 *
 * A capability is minted by an authenticated `POST /api/sessions/:id/html-view` and
 * grants exactly one thing: GET access to the files in ONE directory (the HTML
 * file's own), so a page's relative `style.css` / `chart.js` / images resolve.
 *
 * - 192 bits of `randomBytes` entropy, base64url.
 * - Held in memory only. A restart invalidates every outstanding capability.
 * - Rolling TTL, revoked on logout, admin logout and user deletion (`revokeOwner`).
 */

import { randomBytes } from 'node:crypto';
import { StaleExpirationMap } from './utils/index.js';
import { MAX_WEBVIEW_CAPABILITIES, WEBVIEW_CAPABILITY_TTL_MS } from './config/webview-limits.js';

/** URL prefix the rendered files are served under. */
export const HTML_VIEW_PREFIX = '/html-view';

export interface HtmlViewCapabilityRecord {
  /** Realpath of the directory the capability serves. */
  rootDir: string;
  /** Username that minted it (multi-user); undefined in single-user mode. */
  owner?: string;
  createdAt: number;
}

export class HtmlViewCapabilityStore {
  private readonly capabilities: StaleExpirationMap<string, HtmlViewCapabilityRecord>;
  /** Reverse index so re-opening a page reuses its capability instead of leaking one per click. */
  private readonly byRoot = new Map<string, string>();

  constructor(ttlMs: number = WEBVIEW_CAPABILITY_TTL_MS) {
    this.capabilities = new StaleExpirationMap<string, HtmlViewCapabilityRecord>({
      ttlMs,
      refreshOnGet: true,
      onExpire: (token, record) => {
        const key = rootKey(record.rootDir, record.owner);
        if (this.byRoot.get(key) === token) this.byRoot.delete(key);
      },
    });
  }

  /** Mint (or reuse) a capability for a directory. Returns the token. */
  mint(rootDir: string, owner?: string): string {
    const key = rootKey(rootDir, owner);
    const existing = this.byRoot.get(key);
    if (existing && this.capabilities.get(existing)) return existing;
    if (existing) this.byRoot.delete(key);

    if (this.capabilities.size >= MAX_WEBVIEW_CAPABILITIES) this.capabilities.cleanup();

    const token = randomBytes(24).toString('base64url');
    this.capabilities.set(token, { rootDir, owner, createdAt: Date.now() });
    this.byRoot.set(key, token);
    return token;
  }

  /** Resolve a capability, refreshing its TTL. Returns undefined when unknown or expired. */
  resolve(token: string): HtmlViewCapabilityRecord | undefined {
    if (!token) return undefined;
    return this.capabilities.get(token);
  }

  /** Revoke every capability bound to an identity (logout, admin logout, user deletion). */
  revokeOwner(owner: string | undefined): number {
    let revoked = 0;
    for (const [key, token] of [...this.byRoot]) {
      const record = this.capabilities.peek(token);
      if (!record || record.owner === owner) {
        this.capabilities.delete(token);
        this.byRoot.delete(key);
        if (record) revoked++;
      }
    }
    return revoked;
  }

  get size(): number {
    return this.capabilities.size;
  }

  dispose(): void {
    this.capabilities.dispose();
    this.byRoot.clear();
  }
}

function rootKey(rootDir: string, owner: string | undefined): string {
  return `${owner ?? ''}\0${rootDir}`;
}

/** The capability token in an `/html-view/<cap>/...` path, or null. */
export function capabilityFromHtmlViewPath(pathname: string): string | null {
  if (typeof pathname !== 'string') return null;
  const prefix = `${HTML_VIEW_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  const cap = slash === -1 ? rest : rest.slice(0, slash);
  return /^[A-Za-z0-9_-]{16,128}$/.test(cap) ? cap : null;
}

/** Process-wide store, shared by the routes and the auth middleware (see webviewCapabilities). */
export const htmlViewCapabilities = new HtmlViewCapabilityStore();
