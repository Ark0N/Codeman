import { isIP } from 'node:net';

const EXPLICIT_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isExplicitlyEnabled(value: string | undefined): boolean {
  return value !== undefined && EXPLICIT_TRUE_VALUES.has(value.trim().toLowerCase());
}

/**
 * True when an unauthenticated non-loopback BIND is acceptable: either a password is
 * set (auth active) or the operator explicitly acknowledged it. Quiets the startup
 * warning only; it does not cover the Cloudflare tunnel (#706), which has its own
 * acknowledgement below.
 */
export function isUnauthenticatedNetworkAcknowledged(allowFlag = false): boolean {
  if (process.env.CODEMAN_PASSWORD) return true;
  return allowFlag || isExplicitlyEnabled(process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK);
}

/**
 * True when the operator opted in to an unauthenticated public Cloudflare tunnel:
 * `--allow-unauthenticated-tunnel` (passed in as `allowFlag`) or
 * CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL. Used by the tunnel-enable guard (COD-55) in
 * place of a login. Kept apart from the network acknowledgement on purpose (#706):
 * install.sh writes that one for every passwordless LAN install, and it must never
 * also publish the machine to the internet. install.sh never writes this one.
 */
export function isUnauthenticatedTunnelAcknowledged(allowFlag = false): boolean {
  return allowFlag || isExplicitlyEnabled(process.env.CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL);
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (isIP(normalized) === 4 && normalized.startsWith('127.')) {
    return true;
  }
  return normalized.startsWith('::ffff:127.');
}

/**
 * Hostname suffixes that are always accepted by the Host/Origin allowlist. These
 * are namespaces an external attacker cannot register DNS-rebinding records under
 * (tailscale MagicDNS, Cloudflare quick/named tunnels), so accepting them keeps
 * the project's documented tunnel access paths working without reopening the
 * rebinding hole. Extend per-deployment via CODEMAN_ALLOWED_HOSTS.
 */
export const DEFAULT_TRUSTED_HOST_SUFFIXES = ['.ts.net', '.trycloudflare.com', '.cfargotunnel.com'];

/**
 * Container-to-host gateway aliases (Docker / Podman). A hook `curl` from INSIDE a
 * docker case carries `Host: host.docker.internal:<port>` (the derived
 * CODEMAN_API_URL), so the always-on host guard must allow it or every in-container
 * hook is blocked 403. These names only resolve to the host from within a
 * container's network namespace, so they are not a DNS-rebinding surface for a
 * normal browser. Both engines' aliases are allowed so a mixed fleet keeps working.
 */
export const DOCKER_HOST_GATEWAY_ALIASES = ['host.docker.internal', 'host.containers.internal'];

/** Policy inputs for the anti-DNS-rebinding Host allowlist + cross-site Origin guard. */
export interface HostPolicy {
  /** The host the server is bound to (e.g. '127.0.0.1', '0.0.0.0', or a hostname). */
  bindHost: string;
  /** Extra allowed hosts: exact lowercased names, or a leading-dot '.suffix' for suffix matches. */
  allowedHosts: string[];
  /** Hostname of the currently-active Codeman-managed tunnel, if any. */
  tunnelHost?: string | null;
}

/**
 * Extract the lowercased hostname from a Host/authority value, stripping the port
 * and IPv6 brackets. Returns null for empty/garbage input.
 */
export function parseAuthorityHostname(authority: string | undefined): string | null {
  if (!authority) return null;
  let h = authority.trim();
  if (!h) return null;
  if (h.startsWith('[')) {
    // [::1] or [::1]:3000
    const end = h.indexOf(']');
    if (end === -1) return null;
    return h.slice(1, end).toLowerCase() || null;
  }
  // host:port — only treat a single trailing colon as a port separator so a
  // bracketless IPv6 literal (multiple colons) is left intact.
  const first = h.indexOf(':');
  if (first !== -1 && first === h.lastIndexOf(':')) {
    h = h.slice(0, first);
  }
  return h.toLowerCase() || null;
}

/** Build a HostPolicy from the bind host, CODEMAN_ALLOWED_HOSTS, and an active tunnel URL. */
export function buildHostPolicy(bindHost: string, tunnelUrl?: string | null): HostPolicy {
  const allowedHosts = (process.env.CODEMAN_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  let tunnelHost: string | null = null;
  if (tunnelUrl) {
    try {
      tunnelHost = new URL(tunnelUrl).hostname.toLowerCase();
    } catch {
      tunnelHost = null;
    }
  }
  return { bindHost, allowedHosts, tunnelHost };
}

function matchesHost(hostname: string, policy: HostPolicy): boolean {
  // localhost is reserved (always resolves to loopback, not rebindable).
  if (hostname === 'localhost') return true;
  // Any IP literal: a literal address cannot be the target of DNS rebinding — the
  // browser connected straight to it, there is no name to re-point.
  if (isIP(hostname) !== 0) return true;
  const bind = parseAuthorityHostname(policy.bindHost);
  if (bind && hostname === bind) return true;
  if (policy.tunnelHost && hostname === policy.tunnelHost) return true;
  // Docker/Podman container-to-host gateway aliases (for in-container hook curls).
  if (DOCKER_HOST_GATEWAY_ALIASES.includes(hostname)) return true;
  for (const suffix of DEFAULT_TRUSTED_HOST_SUFFIXES) {
    if (hostname === suffix.slice(1) || hostname.endsWith(suffix)) return true;
  }
  for (const entry of policy.allowedHosts) {
    if (entry.startsWith('.')) {
      if (hostname === entry.slice(1) || hostname.endsWith(entry)) return true;
    } else if (hostname === entry) {
      return true;
    }
  }
  return false;
}

/**
 * True if a request's Host header is allowed. Blocks DNS-rebinding: a custom
 * domain rebound to a loopback/LAN address still carries its own name in Host,
 * which will not be in the allowlist.
 */
export function isAllowedRequestHost(hostHeader: string | undefined, policy: HostPolicy): boolean {
  const hostname = parseAuthorityHostname(hostHeader);
  if (!hostname) return false;
  return matchesHost(hostname, policy);
}

/**
 * True if a request's Origin is allowed for a state-changing / WebSocket request.
 * A MISSING Origin is allowed: non-browser clients (curl, Claude Code hooks) omit
 * it, while browsers always attach it on cross-origin state-changing/WS requests —
 * so a forged cross-site request is caught while local automation keeps working.
 * The opaque origin 'null' (sandboxed iframe, data: URL) is rejected.
 */
export function isAllowedRequestOrigin(originHeader: string | undefined, policy: HostPolicy): boolean {
  if (originHeader === undefined || originHeader === '') return true;
  if (originHeader === 'null') return false;
  try {
    return matchesHost(new URL(originHeader).hostname.toLowerCase(), policy);
  } catch {
    return false;
  }
}
