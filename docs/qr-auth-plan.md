# QR Code Authentication Plan

> Ephemeral, single-use auth tokens embedded in the tunnel QR code — scan to auto-authenticate, while the bare tunnel URL stays password-protected.

## Problem

When the Cloudflare tunnel is active, anyone who discovers the `*.trycloudflare.com` URL can access Codeman (they just need the Basic Auth password, or if no password is set, full open access). The QR code currently encodes the raw tunnel URL — it provides no additional security. We want:

1. **Scanning the QR code** → seamless, instant access (no password prompt)
2. **Having only the URL** → blocked by Basic Auth (no access without credentials)

## Design

### Core Concept: Ephemeral Single-Use QR Tokens

The server maintains a rotating pool of short-lived, single-use tokens. The QR code encodes a short URL containing a lookup code that maps to the real token server-side. When scanned, the server validates the token, atomically consumes it, issues a session cookie, and redirects to `/`. The token is **not** the password — it's a separate, independent, ephemeral authentication pathway.

```
Desktop   → displays QR (auto-refreshes every 60s via SSE)
QR Code   → https://abc-xyz.trycloudflare.com/q/Xk9mQ3
Phone     → scans, GET /q/Xk9mQ3
Server    → looks up short code via Map (hash-based, timing-safe)
          → finds token record → validates TTL
          → atomically consumes token (single-use)
          → issues codeman_session cookie
          → 302 redirect to /
          → SSE push: new QR with embedded SVG for desktop display
          → desktop toast: "Device [IP] authenticated via QR"
          → audit log entry to session-lifecycle.jsonl
User      → lands on app, fully authenticated
```

Someone who only has `https://abc-xyz.trycloudflare.com/` gets the standard Basic Auth prompt.

### Token Properties

| Property | Value |
|----------|-------|
| Length | 32 bytes (256 bits entropy) |
| Generation | `crypto.randomBytes(32).toString('hex')` |
| Short code | 6 chars base62, rejection-sampled (no modulo bias) |
| Short code derivation | Independent random generation (not derived from token) |
| Storage | In-memory `Map<shortCode, QrTokenRecord>` (no disk persistence) |
| TTL | 60 seconds (auto-rotation via timer), 90s grace for previous token |
| Effective window | Up to 90 seconds for the previous token (documented, not hidden) |
| Usage | **Single-use** — atomically consumed on first valid scan |
| URL format | Short code in path (`/q/Xk9mQ3`), not query params |
| URL length | ~53-56 chars total — targets QR Version 4 (33x33) for fast scanning |
| Scope | Only valid when `CODEMAN_PASSWORD` is set (no point without auth) |
| Lookup | `Map.get()` — hash-based O(1), no timing side-channel |

### Why This Design?

**Why not embed the password directly?**
- Password would appear in browser history, Cloudflare edge logs, and URL bars
- Password can't be rotated independently from QR access

**Why not a long-lived multi-use token? (original design)**
- A static token is functionally a second password — if the QR image leaks (screenshot shared, shoulder surfing, Cloudflare logs), the attacker has permanent access
- The USENIX Security 2025 paper ["Demystifying the (In)Security of QR Code-based Login"](https://www.usenix.org/conference/usenixsecurity25/presentation/zhang-xin) found 47 of the top-100 websites vulnerable due to exactly this pattern — missing single-use enforcement and long-lived tokens were 2 of the 6 critical design flaws identified

**Why short codes in the URL path instead of query params?**
- Query params (`?t=TOKEN`) leak into browser history, address bar, `Referer` headers, and Cloudflare edge logs
- Path-based short codes (`/q/Xk9mQ3`) are opaque references — the real token never appears in URLs
- Short codes are 6-char base62 (62^6 = 56.8 billion combinations), sufficient for lookup since they're backed by the full 256-bit token for validation and rate-limited to 10 attempts/IP
- The short `/q/` path (vs `/qr-auth/`) saves 7 bytes, helping keep the QR at Version 4 (33x33 modules) instead of Version 5 (37x37) — faster scanning on budget phones

## Auth Flow Diagram

```
┌─────────────┐    scan QR     ┌──────────────────────────────────────┐
│  Mobile      │ ────────────→ │ GET /q/Xk9mQ3                        │
│  Device      │               │                                      │
└─────────────┘               │ 1. Auth middleware sees /q/            │
                               │    → skips Basic Auth check           │
                               │ 2. Route handler: Map.get(shortCode)  │
                               │    → hash-based lookup (timing-safe)  │
                               │ 3. Checks TTL (90s grace for prev)    │
                               │    → token not expired?               │
                               │ 4. Checks consumed flag               │
                               │    → not already used?                 │
                               │ 5. Atomically marks token consumed    │
                               │ 6. Issues codeman_session cookie      │
                               │ 7. 302 redirect to /                  │
                               │ 8. Audit log → session-lifecycle.jsonl│
                               │ 9. SSE push: tunnel:qrRegenerated     │
                               │    → desktop refreshes QR (SVG inline)│
                               │ 10. Desktop toast: "Device auth'd"    │
                               └──────────────────────────────────────┘

┌─────────────┐  replay URL   ┌──────────────────────────────────────┐
│  Attacker    │ ────────────→ │ GET /q/Xk9mQ3                        │
│ (stale code) │               │                                      │
└─────────────┘               │ 1. Map.get(shortCode) → not found     │
                               │    OR token consumed OR expired       │
                               │ 2. Increment QR rate limit counter    │
                               │    (separate from Basic Auth counter) │
                               │ 3. 401 Unauthorized                   │
                               └──────────────────────────────────────┘

┌─────────────┐   URL only    ┌──────────────────────────────────────┐
│  Attacker    │ ────────────→ │ GET /                                │
│  (no token)  │               │                                      │
└─────────────┘               │ 1. Auth middleware checks cookie      │
                               │    → no cookie                        │
                               │ 2. Checks Basic Auth header           │
                               │    → no header                        │
                               │ 3. Returns 401 + WWW-Authenticate    │
                               │    → Browser shows password popup     │
                               └──────────────────────────────────────┘
```

## Implementation

### 1. Token Manager — `src/tunnel-manager.ts`

Add a `QrTokenRecord` type and token rotation logic to `TunnelManager`. The token rotates every 60 seconds. A consumed token is immediately replaced. Up to 2 tokens can be valid simultaneously (current + previous, to handle the race where someone scans right as rotation happens). The previous token has a 90s grace period (not a full extra 60s — only enough to cover the scan-during-rotation race).

**Design decisions from security review:**
- **Map-based lookup** (not array scan) — `Map.get()` uses hash-based O(1) lookup, eliminating timing side-channels from string comparison
- **Rejection sampling** for short codes — avoids modulo bias (`256 % 62 != 0` gives 25% overrepresentation for first 6 charset chars)
- **SVG cache** — stores generated QR SVG per rotation cycle to avoid regenerating on every `/api/tunnel/qr` poll
- **Separate rate limit counter** — QR auth failures tracked independently from Basic Auth failures

```typescript
import { randomBytes } from 'node:crypto';

interface QrTokenRecord {
  token: string;       // 64 hex chars (256 bits)
  shortCode: string;   // 6 chars base62 (for URL path)
  createdAt: number;   // Date.now()
  consumed: boolean;   // single-use flag
}

const QR_TOKEN_TTL_MS = 60_000;        // 60 seconds
const QR_TOKEN_GRACE_MS = 90_000;      // 90s grace for previous token (scan-during-rotation)
const SHORT_CODE_LENGTH = 6;
const QR_RATE_LIMIT_MAX = 30;          // global rate limit across all IPs
const QR_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window

/** Rejection-sampled short code generation — no modulo bias */
function generateShortCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const maxUnbiased = 248; // largest multiple of 62 that fits in a byte (248 = 62 * 4)
  const result: string[] = [];
  while (result.length < SHORT_CODE_LENGTH) {
    const [byte] = randomBytes(1);
    if (byte < maxUnbiased) result.push(chars[byte % 62]);
    // else: discard and re-draw (rejection sampling)
  }
  return result.join('');
}

export class TunnelManager extends EventEmitter {
  // Map-based lookup: shortCode → QrTokenRecord (timing-safe, no string comparison)
  private qrTokensByCode = new Map<string, QrTokenRecord>();
  private currentShortCode: string | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  // SVG cache — regenerated only on token rotation, not per request
  private cachedQrSvg: { shortCode: string; svg: string } | null = null;

  // Global rate limit counter (separate from Basic Auth rate limiting)
  private qrAttemptCount = 0;
  private qrRateLimitResetTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.rotateToken();
    this.rotationTimer = setInterval(() => this.rotateToken(), QR_TOKEN_TTL_MS);
    this.qrRateLimitResetTimer = setInterval(() => { this.qrAttemptCount = 0; }, QR_RATE_LIMIT_WINDOW_MS);
  }

  private rotateToken(): void {
    const record: QrTokenRecord = {
      token: randomBytes(32).toString('hex'),
      shortCode: generateShortCode(),
      createdAt: Date.now(),
      consumed: false,
    };

    // Evict expired tokens from the Map
    const now = Date.now();
    for (const [code, rec] of this.qrTokensByCode) {
      if (now - rec.createdAt > QR_TOKEN_GRACE_MS || rec.consumed) {
        this.qrTokensByCode.delete(code);
      }
    }

    this.qrTokensByCode.set(record.shortCode, record);
    this.currentShortCode = record.shortCode;
    this.cachedQrSvg = null; // invalidate SVG cache
    this.emit('qrTokenRotated');
  }

  /** Get the current (newest) token's short code for QR URL */
  getCurrentShortCode(): string | undefined {
    return this.currentShortCode ?? undefined;
  }

  /** Get cached QR SVG, regenerating only if the short code changed */
  async getQrSvg(tunnelUrl: string): Promise<string> {
    const code = this.currentShortCode;
    if (!code) throw new Error('No QR token available');
    if (this.cachedQrSvg?.shortCode === code) return this.cachedQrSvg.svg;
    const QRCode = require('qrcode');
    const svg = await QRCode.toString(`${tunnelUrl}/q/${code}`, { type: 'svg', margin: 2, width: 256 });
    this.cachedQrSvg = { shortCode: code, svg };
    return svg;
  }

  /**
   * Validate and atomically consume a token by short code.
   * Returns { success, ip?, ua? } for audit logging on success.
   * Map.get() is hash-based — no timing side-channel from string comparison.
   */
  consumeToken(shortCode: string): boolean {
    // Global rate limit (across all IPs)
    if (this.qrAttemptCount >= QR_RATE_LIMIT_MAX) return false;
    this.qrAttemptCount++;

    const record = this.qrTokensByCode.get(shortCode);
    if (!record) return false;
    if (record.consumed) return false;

    const now = Date.now();
    if (now - record.createdAt > QR_TOKEN_GRACE_MS) return false;

    // Atomic consume (single-threaded JS = no race)
    record.consumed = true;
    // Immediately rotate so desktop gets a fresh QR
    this.rotateToken();
    this.emit('qrTokenRegenerated');
    return true;
  }

  /** Force-regenerate (manual revocation via API) */
  regenerateQrToken(): void {
    // Invalidate all existing tokens
    this.qrTokensByCode.clear();
    this.currentShortCode = null;
    this.rotateToken();
    this.emit('qrTokenRegenerated');
  }

  stopRotation(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
    if (this.qrRateLimitResetTimer) {
      clearInterval(this.qrRateLimitResetTimer);
      this.qrRateLimitResetTimer = null;
    }
  }
}
```

### 2. Auth Middleware Bypass — `src/web/middleware/auth.ts`

Add `/q/` to the bypass list (same pattern as `/api/hook-event`). The route handler itself handles token validation and rate limiting.

```typescript
// In the onRequest hook, add before Basic Auth check:
if (req.url.startsWith('/q/')) {
  done();  // Let the route handler deal with token validation
  return;
}
```

**Important**: Unlike `/api/hook-event` (localhost-only), `/q/` must be reachable from any IP (remote devices scan the QR). Rate limiting is handled by two independent mechanisms:
1. **Per-IP rate limit** — reuses the `authFailures` StaleExpirationMap (10 attempts/IP/15min), but tracked via a **separate counter** from Basic Auth failures (so a user who fat-fingers their password doesn't burn their QR attempts)
2. **Global path rate limit** — `TunnelManager.qrAttemptCount` caps total QR attempts to 30/minute across all IPs, defending against distributed brute force

### 3. Auto-Auth Route — `src/web/routes/system-routes.ts`

Add `GET /q/:code` as a top-level route (not under `/api/`):

```typescript
app.get('/q/:code', async (req, reply) => {
  const shortCode = (req.params as { code: string }).code;
  const authPassword = process.env.CODEMAN_PASSWORD;

  // No point if auth isn't enabled
  if (!authPassword) {
    return reply.redirect('/');
  }

  // Per-IP rate limit (separate counter from Basic Auth failures)
  const clientIp = req.ip;
  const qrFailures = ctx.authState.qrAuthFailures?.get(clientIp) ?? 0;
  if (qrFailures >= 10) {
    return reply.code(429).send('Too Many Requests');
  }

  // Validate and atomically consume the token
  // consumeToken() also checks the global rate limit (30/min across all IPs)
  if (!shortCode || !ctx.tunnelManager.consumeToken(shortCode)) {
    ctx.authState.qrAuthFailures?.set(clientIp, qrFailures + 1);
    return reply.code(401).send('Invalid or expired QR code');
  }

  // Issue session cookie (same as Basic Auth success path)
  const sessionToken = randomBytes(32).toString('hex');
  const clientUA = req.headers['user-agent'] ?? '';
  ctx.authState.authSessions?.set(sessionToken, {
    ip: clientIp,
    ua: clientUA,
    createdAt: Date.now(),
  });
  ctx.authState.qrAuthFailures?.delete(clientIp);

  // Audit log — write to session-lifecycle.jsonl for forensic analysis
  ctx.lifecycleLog?.append({
    event: 'qr_auth',
    ip: clientIp,
    ua: clientUA,
    timestamp: Date.now(),
    shortCodePrefix: shortCode.slice(0, 3) + '***', // partial for privacy
  });

  reply.setCookie(AUTH_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: ctx.https,
    sameSite: 'lax',
    maxAge: 86400,  // 24h
    path: '/',
  });

  // Broadcast auth notification — desktop sees who authenticated (QRLjacking detection)
  broadcast('tunnel:qrAuthUsed', {
    ip: clientIp,
    ua: clientUA,
    timestamp: Date.now(),
  });

  return reply.redirect('/');
});
```

### 4. Update QR Code URL — `src/web/routes/system-routes.ts`

Modify `/api/tunnel/qr` to encode the short-code URL. Uses the `TunnelManager.getQrSvg()` cache — SVG is regenerated only when the token rotates, not on every request.

```typescript
app.get('/api/tunnel/qr', async (_req, reply) => {
  const url = ctx.tunnelManager.getUrl();
  if (!url) {
    return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Tunnel not running'));
  }

  const authPassword = process.env.CODEMAN_PASSWORD;

  // If auth is enabled, use the cached SVG with embedded short code
  if (authPassword) {
    const svg = await ctx.tunnelManager.getQrSvg(url);
    return { svg, authEnabled: true };
  }

  // No auth — just encode the raw tunnel URL
  const QRCode = require('qrcode');
  const svg = await QRCode.toString(url, { type: 'svg', margin: 2, width: 256 });
  return { svg, authEnabled: false };
});
```

### 5. Token Regeneration Endpoint — `src/web/routes/system-routes.ts`

Manual revocation — invalidates ALL existing tokens and creates a fresh one:

```typescript
app.post('/api/tunnel/qr/regenerate', async () => {
  ctx.tunnelManager.regenerateQrToken();
  return { success: true };
});
```

### 6. Frontend Updates — `src/web/public/app.js`

#### QR Overlay Changes

- **Auto-refresh via inline SVG**: Listen for `tunnel:qrRotated` SSE events which now include the SVG directly in the payload — no extra HTTP fetch needed, sub-50ms refresh on desktop.
- **Countdown indicator**: Small "expires in Xs" text under the QR that counts down from 60. Reassures the user the QR is live and not stale.
- **Regenerate button**: "Regenerate QR" button. Calls `POST /api/tunnel/qr/regenerate` — SSE event delivers the new SVG.
- **Auth badge**: Lock icon or "Single-use auth" label when auth is active.
- **URL display**: Show the raw tunnel URL (not the auth URL) for manual copy — users who copy the URL authenticate via Basic Auth. The QR is the fast path.
- **Auth notification toast**: When `tunnel:qrAuthUsed` fires, show a 10-second toast: "Device [IP] authenticated via QR (Safari). Not you? [Revoke]". This is the primary QRLjacking detection mechanism (USENIX Flaw-5).

```javascript
// Auto-refresh QR on rotation — SVG is inline in the event payload
addListener('tunnel:qrRotated', (data) => {
  if (data.svg) {
    updateQrDisplay(data.svg);  // direct DOM update, no fetch
  } else {
    refreshTunnelQR();          // fallback: fetch from API
  }
});

// Also refresh on manual regeneration
addListener('tunnel:qrRegenerated', (data) => {
  if (data.svg) {
    updateQrDisplay(data.svg);
  } else {
    refreshTunnelQR();
  }
});

// QRLjacking detection — notify desktop user when QR is consumed
addListener('tunnel:qrAuthUsed', (data) => {
  showNotificationToast(
    `Device authenticated via QR (${parseUAFamily(data.ua)}, ${data.ip}). Not you?`,
    {
      duration: 10000,
      action: { label: 'Revoke', onClick: () => revokeAllSessions() },
    }
  );
});

// In showTunnelQR(), after fetching /api/tunnel/qr:
if (data.authEnabled) {
  const badge = document.createElement('div');
  badge.textContent = 'Single-use auth \u00b7 refreshes every 60s';
  badge.style.cssText = 'margin-top:8px;font-size:11px;color:var(--text-secondary)';
  container.parentElement.appendChild(badge);
}
```

#### Welcome Screen QR

Same auto-refresh behavior applies to `_updateWelcomeTunnelBtn()` — the QR is fetched from `/api/tunnel/qr` so token embedding happens automatically.

### 7. SSE Events

Three events for the frontend. QR rotation events embed the SVG directly in the payload to eliminate an extra HTTP fetch — the desktop gets the new QR in a single SSE push (~2-5KB SVG, well within SSE limits).

```typescript
// In server.ts, listen for tunnelManager events:

// Auto-rotation every 60s — desktop refreshes QR silently (SVG inline)
tunnelManager.on('qrTokenRotated', async () => {
  const url = tunnelManager.getUrl();
  if (url && process.env.CODEMAN_PASSWORD) {
    const svg = await tunnelManager.getQrSvg(url);
    broadcast('tunnel:qrRotated', { svg });
  } else {
    broadcast('tunnel:qrRotated', {});
  }
});

// Manual regeneration or post-consumption — desktop refreshes QR (SVG inline)
tunnelManager.on('qrTokenRegenerated', async () => {
  const url = tunnelManager.getUrl();
  if (url && process.env.CODEMAN_PASSWORD) {
    const svg = await tunnelManager.getQrSvg(url);
    broadcast('tunnel:qrRegenerated', { svg });
  } else {
    broadcast('tunnel:qrRegenerated', {});
  }
});

// QR auth consumed — desktop shows notification toast (QRLjacking detection)
// Note: this is broadcast from the route handler, not tunnelManager
// Event: tunnel:qrAuthUsed { ip, ua, timestamp }
```

### 8. Session Cookie Binding & Revocation

Enhance session records to include device context for audit purposes. The UA is stored for **logging only** — not for blocking.

**Why no UA-family blocking (`majorUAChanged`)?** Security review found this is security theater:
- UA strings are trivially spoofable by any attacker who can steal a cookie
- Chrome UA reduction (2022+) makes family detection unreliable
- Mobile WebView → browser switches trigger false positives on the same device
- HttpOnly + Secure + SameSite=lax + 24h TTL already protect against cookie theft
- The attacker who can exfiltrate a cookie can also replay the exact UA

Instead, provide **manual session revocation** as the active defense:

```typescript
// Session record stores device context for audit logging (not blocking):
ctx.authState.authSessions?.set(sessionToken, {
  ip: clientIp,
  ua: req.headers['user-agent'] ?? '',
  createdAt: Date.now(),
  method: 'qr',  // 'qr' | 'basic' — tracks how session was created
});

// Manual revocation endpoint — kill specific session or all sessions
app.post('/api/auth/revoke', async (req, reply) => {
  const { sessionToken: target } = req.body as { sessionToken?: string };
  if (target) {
    ctx.authState.authSessions?.delete(target);
  } else {
    // Revoke all sessions (nuclear option)
    ctx.authState.authSessions?.clear();
  }
  return { success: true };
});
```

**Note**: This is a breaking type change. The `AuthState` interface must be updated from `StaleExpirationMap<string, string>` (token → clientIp) to `StaleExpirationMap<string, { ip, ua, createdAt, method }>`. All session validation code in `auth.ts` must be updated simultaneously.

### 9. Cleanup — `src/tunnel-manager.ts`

Stop the rotation timer in the `stop()` method:

```typescript
stop(): void {
  this.stopRotation();
  // ... existing cleanup
}
```

## Security Analysis

### Threat Model

| Threat | Attack Vector | Mitigation | Residual Risk |
|--------|--------------|------------|---------------|
| **QR screenshot shared** | Attacker gets image of QR code | Single-use: token consumed on first scan. 60s TTL: expired by the time attacker tries. Desktop toast notification alerts user if someone else scans. | If attacker scans faster than legitimate user (~seconds), they win the race. Low risk: requires physical proximity + speed. User sees notification and can revoke. |
| **Cloudflare edge logs** | Cloudflare logs the full URL path | Short code is opaque (6-char lookup key), not the real token. Single-use: replaying from logs always fails. 60s TTL (90s grace): expired before log review. `trycloudflare.com` quick tunnels have no customer-accessible logging controls — the privacy implications are inherent to using free quick tunnels. | Cloudflare has TLS termination access regardless. Ephemeral short codes are far less valuable than a permanent token. |
| **Brute force short code** | Attacker guesses `/q/XXXXXX` | Per-IP rate limiting (10/IP/15min) + global path rate limit (30/min across all IPs). 62^6 = 56.8 billion combinations. Only ~2 valid codes at any time. | Infeasible: expected guesses to hit = ~2.8×10^10, rate limits block well before. |
| **Replay attack** | Reuse a previously valid URL | Single-use consumption + 60s TTL (90s grace). Old codes always 401. | None — replay is impossible by design. |
| **QRLjacking** | Attacker displays your QR on phishing site | No companion app = limited mitigation. However: 60s rotation means attacker must relay in real-time. Desktop toast notification ("Device [IP] authenticated via QR. Not you? [Revoke]") provides real-time detection. Self-hosted single-user context makes phishing implausible. | Theoretical risk for multi-user deployments. Mitigated by notification toast for single-user. Note: Signal's linked-device QR flow was exploited by Russian state actors (UNC5792/Sandworm) via quishing in 2025 — but that targeted a multi-user messaging platform, not a self-hosted dev tool. |
| **Session cookie theft** | XSS or network sniffing steals cookie | HttpOnly + Secure flags. SameSite=lax prevents CSRF. 24h TTL limits exposure window. Manual revocation via `/api/auth/revoke`. | Standard web cookie risks apply. Mitigated by security headers (CSP, etc.). |
| **Token in server logs** | Access log captures URL path | Log `/q/*` with short code masked or omitted. Configure Fastify logger to redact `/q/` paths. | Path still appears in server access logs (mitigated by masking). |
| **Timing attack** | Measure response time to leak short code | Map-based lookup (`Map.get()`) — hash-based O(1), no character-by-character timing leak. No string comparison in the hot path. | None — timing side channel eliminated by design. |
| **Token not in query params** | N/A (this is a mitigation) | Short code in URL path avoids browser history, Referer headers, and address bar exposure. | Path still appears in server access logs (mitigated by masking). |
| **Distributed brute force** | Multiple IPs guess codes simultaneously | Global rate limit (30/min total across all IPs) in addition to per-IP limit. | Infeasible given keyspace. Global limit prevents botnet-scale attempts. |
| **CSRF on regenerate** | Cross-origin POST to `/api/tunnel/qr/regenerate` | SameSite=lax cookies are NOT sent with cross-origin POST requests, providing CSRF protection. Endpoint requires authenticated session. | Verify SameSite=lax behavior through cloudflared tunnel. |

### USENIX Security 2025 Flaw Coverage

The [Zhang et al. paper](https://www.usenix.org/conference/usenixsecurity25/presentation/zhang-xin) (USENIX Security 2025, 47 of top-100 websites vulnerable, 42 CVEs) identified 6 critical design flaws. Coverage:

| USENIX Flaw | Status | Implementation |
|-------------|--------|----------------|
| Flaw-1: Missing single-use enforcement | **Fixed** | Atomic `consumed` flag, Map-based lookup |
| Flaw-2: Long-lived tokens | **Fixed** | 60s TTL, 90s grace, auto-rotation |
| Flaw-3: Predictable QrId generation | **Fixed** | `crypto.randomBytes(32)` — 256-bit entropy, rejection-sampled short codes |
| Flaw-4: Client-side QrId generation | **Fixed** | Server-side generation only |
| Flaw-5: Missing status notification | **Fixed** | Desktop toast notification via `tunnel:qrAuthUsed` SSE event. Shows device IP/UA with [Revoke] button. |
| Flaw-6: Inadequate session binding | **Partial** | IP + UA stored for audit. No cryptographic channel binding (requires companion app / FIDO2 — overkill for single-user). Manual revocation as active defense. |

### Industry Comparison

| Platform | Model | How This Plan Compares |
|----------|-------|----------------------|
| **Discord** | Long-lived session token, no confirmation, repeatedly exploited via QRLjacking | **Better** — single-use + TTL + notification toast |
| **WhatsApp Web** | Pre-authenticated phone confirms "Link device?", ~60s rotation | **Comparable** rotation model; missing WhatsApp's explicit confirmation prompt (acceptable: single-user, no account selection) |
| **Signal** | Ephemeral public key in QR, E2E encrypted channel via Signal protocol | **Below** — no cryptographic channel binding. Note: Signal's QR flow was exploited by state actors in 2025 despite stronger crypto, showing that protocol strength alone doesn't prevent social engineering. |
| **1Password** | Noise framework E2E channel, post-quantum pre-shared keys, confirmation codes | **Below** — but 1Password is a credential manager with different threat model. Overkill for a dev tool. |
| **FIDO2 CTAP 2.2** | BLE proximity + cryptographic binding + biometric verification | **Below** — but requires BLE stack, FIDO server, and companion authenticator. Completely inappropriate here. |

### Comparison to Prior Design

| Property | Original Plan | Current Plan |
|----------|--------------|--------------|
| Token TTL | Infinite (until restart) | 60 seconds (90s grace for previous token) |
| Reuse | Multi-use (same QR works forever) | Single-use (consumed atomically on first scan) |
| Secret in URL | Query param (`?t=64-char-hex`) | Opaque short code in path (`/q/Xk9mQ3`) |
| Leak impact | Permanent access until manual revoke | Worthless after first use or 90s, whichever comes first |
| Desktop QR refresh | Manual only | Auto-refresh every 60s via SSE with inline SVG |
| Session binding | IP only | IP + UA stored for audit (not blocking). Manual revocation endpoint. |
| Auth notification | None | Desktop toast: "Device [IP] authenticated via QR. Not you? [Revoke]" |
| Audit logging | None | `session-lifecycle.jsonl` entry on every QR auth event |
| Rate limiting | Per-IP only, shared with Basic Auth | Per-IP (separate counter) + global path limit (30/min) |
| Short code generation | Modulo-biased | Rejection-sampled (no bias) |
| Short code lookup | Array scan (timing leak) | Map-based O(1) (timing-safe) |
| Connect latency | ~50ms (localhost only) | ~150-300ms through Cloudflare tunnel (honest estimate) |

### What This Does NOT Protect Against

- **FIDO2/passkey-level phishing resistance**: Would require BLE proximity verification and cryptographic channel binding. Overkill for a self-hosted single-user dev tool. The FIDO2 CTAP 2.2 hybrid transport is the gold standard but requires BLE hardware and a companion authenticator.
- **Compromised phone**: If the attacker has physical access to the phone that scans, no QR scheme helps.
- **Compromised Cloudflare tunnel**: Cloudflare terminates TLS and can inspect all traffic. This is inherent to using `trycloudflare.com` quick tunnels — use `--https` for end-to-end encryption if this matters.
- **State-sponsored quishing**: Sophisticated attackers could create convincing phishing pages that relay the QR in real-time. The 60s rotation and desktop notification toast mitigate this for the single-user case, but a dedicated attacker with social engineering could theoretically succeed within the TTL window.

### Standards Compliance Note

This design is **inspired by but does not conform to** [OASIS SQRAP v1.0](https://docs.oasis-open.org/esat/sqrap/v1.0/cs01/sqrap-v1.0-cs01.html). SQRAP's architecture requires a companion mobile app with stored identity keys, public key channel binding, back-channel authentication, and user presence verification (biometric/PIN). These are fundamentally incompatible with a browser-scan-to-authenticate flow. SQRAP is referenced for awareness of formal QR auth standards, not as a compliance target.

## Performance

The design prioritizes speed on connect. Latency depends on whether the request goes through a Cloudflare tunnel or is localhost:

### Localhost (no tunnel)

| Step | Latency |
|------|---------|
| QR scan (physical) | ~1-2s (user action) |
| `GET /q/:code` → Map.get() lookup + consume | <1ms |
| Cookie set + 302 redirect | <1ms |
| Browser follows redirect to `/` | <5ms |
| **Total (after scan)** | **<10ms** |

### Through Cloudflare Tunnel (typical mobile use case)

Each request traverses: phone → Cloudflare edge (TLS termination) → cloudflared → localhost. The 302 redirect means **two full round trips** through the tunnel.

| Step | Latency |
|------|---------|
| QR scan (physical) | ~1-2s (user action) |
| DNS resolution for `*.trycloudflare.com` | 20-80ms (first request, cached after) |
| TLS handshake to Cloudflare edge | 50-100ms (first request, 0 with TLS resumption) |
| `GET /q/:code` through tunnel (request + response) | 30-90ms |
| Browser follows 302 redirect: `GET /` through tunnel | 30-90ms |
| **Total first connection (cold)** | **~200-400ms** |
| **Total subsequent (TLS/DNS cached)** | **~100-200ms** |

This is still fast — **imperceptible after the 1-2s physical QR scan action**. For comparison, VS Code Remote Tunnels (through Azure) adds 20-100ms per hop.

### Why Not Eliminate the Redirect?

The 302 means two round trips. Alternatives considered:
- **200 + serve `index.html` directly**: URL bar shows `/q/Xk9mQ3`, relative paths break, couples auth to static serving. Not worth the complexity.
- **200 + `<meta http-equiv="refresh">`**: Still two requests, plus HTML parse delay. Actually slower.
- **200 + JavaScript redirect**: Same problem, plus fails if JS disabled.

The 302 is clean, universally supported, and the extra 30-90ms is invisible to users.

### QR Code Size Optimization

The URL `https://xxx-yyy.trycloudflare.com/q/Xk9mQ3` is ~53-56 characters. At QR Error Correction Level M:

| QR Version | Grid Size | Byte Capacity | Fits? |
|------------|-----------|---------------|-------|
| Version 3 | 29x29 | 42 bytes | No |
| Version 4 | 33x33 | 62 bytes | Yes (comfortably) |
| Version 5 | 37x37 | 84 bytes | Yes |

The shortened `/q/` path (vs `/qr-auth/`) and 6-char code (vs 8-char) save 9 bytes, targeting Version 4 (33x33) for faster scanning on budget Android phones. Modern phones scan Version 4 QR codes in 100-300ms — the user action of pointing the camera dominates.

### Desktop QR Refresh

Token rotation SSE events now embed the SVG directly in the payload (~2-5KB). The desktop gets the new QR in a single SSE push — no extra HTTP fetch needed. Refresh latency: **sub-50ms** (SSE adaptive batching at 16-50ms).

### SVG Caching

QR SVG is cached per rotation cycle on `TunnelManager.cachedQrSvg`. The SVG is regenerated only when the token rotates (every 60s), not on every `/api/tunnel/qr` request. SVG format is optimal: resolution-independent (retina-safe), inline-able (no extra HTTP request), ~2-5KB, renders in <1ms.

## Edge Cases

1. **Scan during rotation**: The server keeps 2 tokens (current + previous). If the user scans right as rotation happens, the previous token is still valid for up to 60s more. Seamless.

2. **Server restart**: All tokens cleared (in-memory). New token generated immediately. Tunnel URL also changes (trycloudflare gives a new subdomain), so old QR codes are doubly dead.

3. **Multiple devices**: Each scan consumes the token and triggers a fresh one. To auth a second device, wait for the QR to refresh (≤60s) or hit "Regenerate QR" on the desktop, then scan the new code.

4. **Token without tunnel**: `/qr-auth/:code` works even on localhost. If you have the code and it's valid, you get authenticated regardless of access method.

5. **Tunnel restart (same server)**: Tokens survive tunnel restarts (stored on `TunnelManager` instance). But new tunnel URL = new QR code generated. Short code stays valid until consumed or expired.

6. **Desktop browser closed during scan**: Token is consumed server-side. The scanning phone gets authenticated. When the desktop reopens, SSE reconnects and shows a fresh QR. No state corruption.

7. **Race condition: two phones scan same QR**: First scanner wins (atomic `consumed = true`). Second scanner gets 401. This is correct behavior — single-use by design.

## Files to Modify

| File | Changes |
|------|---------|
| `src/tunnel-manager.ts` | `QrTokenRecord` type, `Map<shortCode, record>` token pool, rejection-sampled `generateShortCode()`, rotation timer, `consumeToken()`, `getCurrentShortCode()`, `getQrSvg()` (cached), `regenerateQrToken()`, global rate limit counter, cleanup in `stop()` |
| `src/web/middleware/auth.ts` | Add `/q/` bypass in `onRequest` hook. Enhance session record type from `string` to `{ ip, ua, createdAt, method }` (**breaking type change** — all consumers must update). Add `qrAuthFailures` StaleExpirationMap (separate from Basic Auth `authFailures`). |
| `src/web/routes/system-routes.ts` | Modify `/api/tunnel/qr` to use `getQrSvg()` cache. Add `GET /q/:code` with atomic consume, audit log, and `tunnel:qrAuthUsed` broadcast. Add `POST /api/tunnel/qr/regenerate`. Add `POST /api/auth/revoke`. |
| `src/web/server.ts` | Pass `authState` + `lifecycleLog` to route context. Listen for `qrTokenRotated` and `qrTokenRegenerated` events → broadcast SSE with inline SVG. |
| `src/web/public/app.js` | Auto-refresh QR from inline SSE SVG payload (no extra fetch). Countdown timer. Regenerate button. Auth badge. Auth notification toast on `tunnel:qrAuthUsed` with [Revoke] action. |
| `src/session-lifecycle-log.ts` | Add `qr_auth` event type to lifecycle log schema |
| `src/types/api.ts` | Update `AuthState` interface: `authSessions` value type, add `qrAuthFailures` map |

## Complexity Estimate

Medium change. Core logic (Map-based token pool, rejection-sampled short codes, SVG cache, atomic consumption, cookie issuance, audit logging) is ~120 lines. Rate limiting (separate QR counter + global path limit) adds ~20 lines. SSE plumbing with inline SVG adds ~30 lines. Frontend (inline SVG refresh, auth notification toast with revoke, countdown) is ~40 lines. Auth type migration (session record type change) touches ~10 lines across middleware. No new dependencies — `crypto` and `qrcode` are already available.

## Testing

### Automated

```bash
# Unit test for token manager
npx vitest run test/qr-auth.test.ts
```

Test cases:
- Token rotation generates unique short codes (6-char, base62)
- Short codes have uniform character distribution (no modulo bias — verify with chi-squared test over 10K samples)
- `consumeToken()` returns true on first use, false on second
- Expired tokens (>90s old) return false
- Previous token still works during 90s grace period
- Token at exactly 60s still valid (within grace), token at 91s rejected
- `regenerateQrToken()` invalidates all existing tokens (Map cleared)
- Short code lookup is case-sensitive
- Per-IP rate limiting increments on invalid codes (separate from Basic Auth counter)
- Global rate limit (30/min) blocks attempts across all IPs
- SVG cache returns same string for same short code, regenerates on rotation
- Audit log entry written on successful QR auth
- `tunnel:qrAuthUsed` SSE event broadcast on successful QR auth
- `tunnel:qrRotated` SSE event includes inline SVG payload
- Map-based lookup does not leak timing information (no string comparison in hot path)

### Manual

1. Start server with `CODEMAN_PASSWORD=test`
2. Enable tunnel
3. Verify `/api/tunnel/qr` returns QR encoding `https://...trycloudflare.com/q/Xk9mQ3`
4. Open the QR URL in incognito → should auto-redirect to `/` with session cookie
5. Verify desktop shows notification toast: "Device [IP] authenticated via QR"
6. Open the **same** URL again → should get 401 (single-use consumed)
7. Wait 60s → verify QR display auto-updated (new short code, inline SVG via SSE)
8. Open just the tunnel URL → should get Basic Auth prompt
9. Call `POST /api/tunnel/qr/regenerate` → old QR URL returns 401, new QR appears
10. Verify per-IP rate limiting: 10+ failed `/q/badcode` → 429
11. Verify Basic Auth failures don't consume QR rate limit budget (and vice versa)
12. Check `~/.codeman/session-lifecycle.jsonl` for `qr_auth` entries after successful scan
13. Click [Revoke] on the notification toast → verify session is invalidated

## References

- [USENIX Security 2025: "Demystifying the (In)Security of QR Code-based Login in Real-world Deployments"](https://www.usenix.org/conference/usenixsecurity25/presentation/zhang-xin) — 6 design flaws, 5 attack types, 42 CVEs across 47 of top-100 websites. Primary design reference for this plan.
- [OWASP QRLJacking](https://owasp.org/www-community/attacks/Qrljacking) — canonical QR session hijacking reference
- [OASIS SQRAP v1.0 Standard](https://docs.oasis-open.org/esat/sqrap/v1.0/cs01/sqrap-v1.0-cs01.html) — formal standard for secure QR authentication. **Not a compliance target** for this plan (requires companion app + PKI). Referenced for awareness only.
- [FIDO2 CTAP 2.2 Hybrid Transport](https://fidoalliance.org/specs/fido-v2.2-rd-20230321/fido-client-to-authenticator-protocol-v2.2-rd-20230321.html) — gold standard for cross-device auth (overkill for this use case)
- [Google GTIG: Signal QR quishing by Russian state actors (2025)](https://cloud.google.com/blog/topics/threat-intelligence/russia-targeting-signal-messenger) — UNC5792/Sandworm exploited Signal's linked-device QR flow via phishing. Demonstrates that even cryptographically strong QR auth can be defeated by social engineering.
- [CVE-2026-2144: Magic Login QR Code Plugin race condition](https://www.cvedetails.com/cve/CVE-2026-2144/) — QR token stored as predictable static file, race window between creation and deletion. Validates this plan's in-memory-only approach.
