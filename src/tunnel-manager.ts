/**
 * @fileoverview Cloudflare Tunnel Manager
 *
 * Manages a cloudflared child process for remote access to Codeman.
 * Spawns `cloudflared tunnel --url` as a child process and parses
 * the trycloudflare.com URL from its stderr output.
 *
 * Follows the same lifecycle pattern as ImageWatcher/SubagentWatcher:
 * extends EventEmitter, start()/stop(), emits typed events.
 *
 * Lifecycle states:
 *   IDLE → STARTING → RUNNING → (crash) → RESTARTING → STARTING → ...
 *   Any state → stop() → IDLE
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ========== Types ==========

export interface TunnelStatus {
  running: boolean;
  url: string | null;
}

interface QrTokenRecord {
  token: string; // 64 hex chars (256 bits)
  shortCode: string; // 6 chars base62 (for URL path)
  createdAt: number; // Date.now()
  consumed: boolean; // single-use flag
}

// ========== Constants ==========

/** QR token auto-rotation interval */
const QR_TOKEN_TTL_MS = 60_000;
/** Grace period for previous token (scan-during-rotation race) */
const QR_TOKEN_GRACE_MS = 90_000;
/** Length of short code in QR URL path */
const SHORT_CODE_LENGTH = 6;
/** Global rate limit for QR attempts across all IPs */
const QR_RATE_LIMIT_MAX = 30;
/** Global rate limit reset window */
const QR_RATE_LIMIT_WINDOW_MS = 60_000;

/** Rejection-sampled base62 short code — no modulo bias */
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

// ========== Constants (Tunnel) ==========

/** Regex to extract the trycloudflare.com URL from cloudflared output */
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Max time to wait for URL before considering it a timeout (ms) */
const URL_TIMEOUT_MS = 30_000;

/** Restart delay after unexpected exit (ms) */
const RESTART_DELAY_MS = 5_000;

/** Force-kill timeout after SIGTERM (ms) */
const FORCE_KILL_MS = 5_000;

// ========== TunnelManager Class ==========

export class TunnelManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private url: string | null = null;
  private cloudflaredPath: string | null = null;
  private urlTimeoutTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private forceKillTimer: NodeJS.Timeout | null = null;
  /** True when the user explicitly requested stop — suppresses auto-restart */
  private stopped = true;
  private localPort = 3000;
  private useHttps = false;

  // ========== QR Token State ==========
  /** Map-based lookup: shortCode → QrTokenRecord (hash-based, timing-safe) */
  private qrTokensByCode = new Map<string, QrTokenRecord>();
  private currentShortCode: string | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  /** SVG cache — regenerated only on token rotation, not per request */
  private cachedQrSvg: { shortCode: string; svg: string } | null = null;
  /** Global rate limit counter (separate from Basic Auth rate limiting) */
  private qrAttemptCount = 0;
  private qrRateLimitResetTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Resolve cloudflared binary path.
   * Checks ~/.local/bin first, then falls back to PATH.
   */
  private resolveCloudflared(): string | null {
    if (this.cloudflaredPath) return this.cloudflaredPath;

    // Check ~/.local/bin first (common user install location)
    const localBin = join(homedir(), '.local', 'bin', 'cloudflared');
    if (existsSync(localBin)) {
      this.cloudflaredPath = localBin;
      return localBin;
    }

    // Check /usr/local/bin
    const usrLocalBin = '/usr/local/bin/cloudflared';
    if (existsSync(usrLocalBin)) {
      this.cloudflaredPath = usrLocalBin;
      return usrLocalBin;
    }

    // Fall back to PATH
    this.cloudflaredPath = 'cloudflared';
    return 'cloudflared';
  }

  /** Clear all pending timers */
  private clearTimers(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.urlTimeoutTimer) {
      clearTimeout(this.urlTimeoutTimer);
      this.urlTimeoutTimer = null;
    }
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = null;
    }
  }

  /**
   * Start the cloudflared tunnel process.
   */
  start(localPort: number, https: boolean): void {
    if (this.process) {
      return; // Already running
    }

    // Cancel any pending restart — we're starting fresh
    this.clearTimers();
    this.stopped = false;
    this.localPort = localPort;
    this.useHttps = https;

    const binary = this.resolveCloudflared();
    if (!binary) {
      this.emit(
        'error',
        'cloudflared not found. Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
      );
      return;
    }

    const protocol = https ? 'https' : 'http';
    const args = ['tunnel', '--url', `${protocol}://localhost:${localPort}`];
    if (https) {
      args.push('--no-tls-verify');
    }

    console.log(`[TunnelManager] Starting: ${binary} ${args.join(' ')}`);

    try {
      this.process = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (err) {
      this.emit('error', `Failed to spawn cloudflared: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.emit('progress', { message: 'Spawning cloudflared process...' });

    // Parse stdout/stderr for the URL, then detach once found
    const handleOutput = (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;

      // Emit progress for interesting cloudflared log lines
      if (!this.url) {
        if (/connector.*registered/i.test(line)) {
          this.emit('progress', { message: 'Tunnel connector registered' });
        } else if (/connection.*registered/i.test(line)) {
          this.emit('progress', { message: 'Connection registered with Cloudflare edge' });
        } else if (/route.*propagating/i.test(line) || /ingress/i.test(line)) {
          this.emit('progress', { message: 'Propagating route to Cloudflare edge...' });
        } else if (/Starting tunnel/i.test(line) || /initial.*connection/i.test(line)) {
          this.emit('progress', { message: 'Establishing tunnel connection...' });
        } else if (/Registered tunnel connection/i.test(line)) {
          this.emit('progress', { message: 'Tunnel connection registered' });
        }
      }

      const match = line.match(TUNNEL_URL_REGEX);
      if (match && !this.url) {
        this.url = match[0];
        console.log(`[TunnelManager] Tunnel URL: ${this.url}`);
        if (this.urlTimeoutTimer) {
          clearTimeout(this.urlTimeoutTimer);
          this.urlTimeoutTimer = null;
        }
        // Detach listeners — no need to parse further output
        this.process?.stdout?.off('data', handleOutput);
        this.process?.stderr?.off('data', handleOutput);
        // Start QR token rotation when tunnel URL is acquired (only if auth enabled)
        if (process.env.CODEMAN_PASSWORD) {
          this.startTokenRotation();
        }
        this.emit('started', { url: this.url });
      }
    };

    this.process.stdout?.on('data', handleOutput);
    this.process.stderr?.on('data', handleOutput);

    // Guard: both 'error' and 'exit' can fire — only handle once
    let exited = false;

    this.process.on('error', (err) => {
      if (exited) return;
      exited = true;
      console.error(`[TunnelManager] Process error:`, err.message);
      this.process = null;
      this.url = null;
      this.emit('error', `cloudflared error: ${err.message}`);
      this.maybeScheduleRestart();
    });

    this.process.on('exit', (code, signal) => {
      if (exited) return;
      exited = true;
      console.log(`[TunnelManager] Process exited (code=${code}, signal=${signal})`);
      const wasRunning = this.url !== null;
      this.process = null;
      this.url = null;
      if (this.forceKillTimer) {
        clearTimeout(this.forceKillTimer);
        this.forceKillTimer = null;
      }

      if (this.stopped) {
        // User requested stop — clean exit
        this.emit('stopped', {});
      } else {
        // Unexpected exit — attempt restart if the tunnel had been working
        this.emit('error', `cloudflared exited unexpectedly (code=${code})`);
        if (wasRunning) {
          this.maybeScheduleRestart();
        }
      }
    });

    // Set URL timeout
    this.urlTimeoutTimer = setTimeout(() => {
      this.urlTimeoutTimer = null;
      if (!this.url && this.process) {
        this.emit('error', 'Timed out waiting for tunnel URL');
      }
    }, URL_TIMEOUT_MS);
  }

  /**
   * Schedule an auto-restart if the user hasn't requested stop.
   */
  private maybeScheduleRestart(): void {
    if (this.stopped || this.restartTimer || this.process) return;
    console.log(`[TunnelManager] Scheduling restart in ${RESTART_DELAY_MS}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.process) {
        this.start(this.localPort, this.useHttps);
      }
    }, RESTART_DELAY_MS);
  }

  /**
   * Stop the cloudflared tunnel process. Safe to call from any state.
   */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.stopTokenRotation();

    if (this.process) {
      const pid = this.process.pid;
      console.log(`[TunnelManager] Stopping tunnel (PID ${pid})`);
      this.process.kill('SIGTERM');
      // Force kill after timeout if still alive
      this.forceKillTimer = setTimeout(() => {
        this.forceKillTimer = null;
        try {
          if (pid) process.kill(pid, 'SIGKILL');
        } catch {
          // Process already gone
        }
      }, FORCE_KILL_MS);
    } else {
      // No process running (maybe in restart delay) — just emit stopped
      this.url = null;
      this.emit('stopped', {});
    }
  }

  // ========== QR Token Management ==========

  /** Start token rotation — called after tunnel URL is acquired */
  startTokenRotation(): void {
    this.stopTokenRotation();
    this.rotateToken();
    this.rotationTimer = setInterval(() => this.rotateToken(), QR_TOKEN_TTL_MS);
    this.qrRateLimitResetTimer = setInterval(() => {
      this.qrAttemptCount = 0;
    }, QR_RATE_LIMIT_WINDOW_MS);
  }

  /** Stop token rotation and clear all tokens */
  stopTokenRotation(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
    if (this.qrRateLimitResetTimer) {
      clearInterval(this.qrRateLimitResetTimer);
      this.qrRateLimitResetTimer = null;
    }
    this.qrTokensByCode.clear();
    this.currentShortCode = null;
    this.cachedQrSvg = null;
    this.qrAttemptCount = 0;
  }

  /** Create a new token, evict expired/consumed ones, emit rotation event */
  private rotateToken(): void {
    const record: QrTokenRecord = {
      token: randomBytes(32).toString('hex'),
      shortCode: generateShortCode(),
      createdAt: Date.now(),
      consumed: false,
    };

    // Evict expired or consumed tokens
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

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic optional dependency
    const QRCode = require('qrcode');
    const svg: string = await QRCode.toString(`${tunnelUrl}/q/${code}`, {
      type: 'svg',
      margin: 2,
      width: 256,
    });
    this.cachedQrSvg = { shortCode: code, svg };
    return svg;
  }

  /**
   * Validate and atomically consume a token by short code.
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
    this.qrTokensByCode.clear();
    this.currentShortCode = null;
    this.rotateToken();
    this.emit('qrTokenRegenerated');
  }

  isRunning(): boolean {
    return this.process !== null || this.restartTimer !== null;
  }

  getUrl(): string | null {
    return this.url;
  }

  getStatus(): TunnelStatus {
    return {
      running: this.process !== null || this.restartTimer !== null,
      url: this.url,
    };
  }
}
