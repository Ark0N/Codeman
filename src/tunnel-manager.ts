/**
 * @fileoverview Cloudflare Tunnel Manager
 *
 * Manages a cloudflared child process for remote access to Codeman.
 * Spawns `cloudflared tunnel --url` as a child process and parses
 * the trycloudflare.com URL from its stderr output.
 *
 * Follows the same lifecycle pattern as ImageWatcher/SubagentWatcher:
 * extends EventEmitter, start()/stop(), emits typed events.
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ========== Types ==========

export interface TunnelStatus {
  running: boolean;
  url: string | null;
}

// ========== Constants ==========

/** Regex to extract the trycloudflare.com URL from cloudflared output */
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Max time to wait for URL before considering it a timeout (ms) */
const URL_TIMEOUT_MS = 30_000;

/** Restart delay after unexpected exit (ms) */
const RESTART_DELAY_MS = 5_000;

// ========== TunnelManager Class ==========

export class TunnelManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private url: string | null = null;
  private cloudflaredPath: string | null = null;
  private urlTimeoutTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private localPort = 3000;
  private useHttps = false;

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

  /**
   * Start the cloudflared tunnel process.
   */
  start(localPort: number, https: boolean): void {
    if (this.process) {
      return; // Already running
    }

    this.stopping = false;
    this.localPort = localPort;
    this.useHttps = https;

    const binary = this.resolveCloudflared();
    if (!binary) {
      this.emit('error', 'cloudflared not found. Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
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
        this.emit('started', { url: this.url });
      }
    };

    this.process.stdout?.on('data', handleOutput);
    this.process.stderr?.on('data', handleOutput);

    this.process.on('error', (err) => {
      console.error(`[TunnelManager] Process error:`, err.message);
      this.cleanup();
      this.emit('error', `cloudflared error: ${err.message}`);
    });

    this.process.on('exit', (code, signal) => {
      console.log(`[TunnelManager] Process exited (code=${code}, signal=${signal})`);
      const wasRunning = this.url !== null;
      this.cleanup();

      if (!this.stopping) {
        // Unexpected exit — attempt restart
        this.emit('error', `cloudflared exited unexpectedly (code=${code})`);
        if (wasRunning) {
          console.log(`[TunnelManager] Scheduling restart in ${RESTART_DELAY_MS}ms`);
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.stopping && !this.process) {
              this.start(this.localPort, this.useHttps);
            }
          }, RESTART_DELAY_MS);
        }
      } else {
        this.emit('stopped', {});
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
   * Stop the cloudflared tunnel process.
   */
  stop(): void {
    this.stopping = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.urlTimeoutTimer) {
      clearTimeout(this.urlTimeoutTimer);
      this.urlTimeoutTimer = null;
    }

    if (this.process) {
      console.log(`[TunnelManager] Stopping tunnel (PID ${this.process.pid})`);
      this.process.kill('SIGTERM');
      // Force kill after 5s if still alive
      const pid = this.process.pid;
      const forceTimer = setTimeout(() => {
        try {
          if (pid) process.kill(pid, 'SIGKILL');
        } catch {
          // Process already gone
        }
      }, 5000);
      this.process.once('exit', () => clearTimeout(forceTimer));
    } else {
      this.cleanup();
      this.emit('stopped', {});
    }
  }

  /**
   * Clean up internal state after process exit.
   */
  private cleanup(): void {
    this.process = null;
    this.url = null;
    if (this.urlTimeoutTimer) {
      clearTimeout(this.urlTimeoutTimer);
      this.urlTimeoutTimer = null;
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  getUrl(): string | null {
    return this.url;
  }

  getStatus(): TunnelStatus {
    return {
      running: this.process !== null,
      url: this.url,
    };
  }
}
