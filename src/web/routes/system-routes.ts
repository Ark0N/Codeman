/**
 * @fileoverview System, config, settings, subagent, and debug routes.
 * Covers status, stats, config CRUD, settings, subagent monitoring,
 * debug/memory, lifecycle logs, screenshots, and various persistence endpoints.
 */

import { FastifyInstance } from 'fastify';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { totalmem, freemem, loadavg, cpus } from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dataPath } from '../../config/instance.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type NiceConfig } from '../../types.js';
import { isUnauthenticatedNetworkAcknowledged } from '../network-auth-policy.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { findUser, canUsernameRunPrivilegedCommands } from '../../user-store.js';
import { getAuthUser, requireAdmin, canAccessOwned } from '../route-helpers.js';
import {
  ConfigUpdateSchema,
  SettingsUpdateSchema,
  ModelConfigUpdateSchema,
  CpuLimitSchema,
  SubagentWindowStatesSchema,
  SubagentParentMapSchema,
  RevokeSessionSchema,
  DeepSeekInstallProfileSchema,
  DeepSeekWebStartSchema,
} from '../schemas.js';
import { subagentWatcher } from '../../subagent-watcher.js';
import { imageWatcher } from '../../image-watcher.js';
import { workflowRunWatcher } from '../../workflow-run-watcher.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import {
  buildAwayDigest,
  resolveAwayDigestRange,
  type AwayDigestSession,
  type AwayDigestSubagent,
} from '../away-digest.js';
import {
  findSessionOrFail,
  formatUptime,
  parseBody,
  readJsonConfig,
  toggleService,
  SETTINGS_PATH,
} from '../route-helpers.js';
import { SseEvent } from '../sse-events.js';
import { getInstallInfo, checkForUpdate, startUpdate, getUpdateStatusForApi } from '../self-update.js';

import { getRepositoryStatus } from '../repo-status.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort, AuthPort, TabLayoutPort } from '../ports/index.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.js';
import { QR_AUTH_FAILURE_MAX } from '../../config/tunnel-config.js';
import { AUTH_SESSION_TTL_MS } from '../../config/auth-config.js';
import { resolveTerminalHistoryConfig } from '../../config/terminal-history.js';

/**
 * Defaults for `POST /api/deepseek/install-profile`.
 *
 * The package is the community terminal front door with by far the widest use
 * (~27.5k weekly downloads at time of writing, roughly 4x the next), MIT, and
 * the one whose supervisor-reporting contract Codeman's status bridge speaks.
 * It is a DEFAULT, not a hardcoding: the endpoint accepts any npm name, and the
 * resolver never assumes this profile exists.
 */
const DEEPSEEK_DEFAULT_TUI_PACKAGE = '@deepseek-harness-tui/dsh-tui';
const DEEPSEEK_DEFAULT_PROFILE = 'dsh-tui';

/** A plugin install compiles and links a dependency tree; npm-scale, not curl-scale. */
const DEEPSEEK_INSTALL_TIMEOUT_MS = 300_000;

// Maximum screenshot upload size (10MB)
const MAX_SCREENSHOT_SIZE = 10 * 1024 * 1024;
// Screenshots directory
const SCREENSHOTS_DIR = dataPath('screenshots');

/** Cached CPU count — doesn't change at runtime */
const CPU_COUNT = cpus().length;

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Get system CPU and memory usage */
function getSystemStats(): {
  cpu: number;
  memory: { usedMB: number; totalMB: number; percent: number };
} {
  try {
    const totalMem = totalmem();

    // macOS: os.freemem() only returns truly free pages, not cached/purgeable memory.
    // Use vm_stat to get accurate used memory (wired + active + compressed).
    let usedMem: number;
    if (process.platform === 'darwin') {
      try {
        const vmstat = execSync('vm_stat', { encoding: 'utf-8', timeout: 2000 });
        const pageSize = parseInt(vmstat.match(/page size of (\d+)/)?.[1] || '4096', 10);
        const wired = parseInt(vmstat.match(/Pages wired down:\s+(\d+)/)?.[1] || '0', 10);
        const active = parseInt(vmstat.match(/Pages active:\s+(\d+)/)?.[1] || '0', 10);
        const compressed = parseInt(vmstat.match(/Pages occupied by compressor:\s+(\d+)/)?.[1] || '0', 10);
        usedMem = (wired + active + compressed) * pageSize;
      } catch {
        usedMem = totalMem - freemem();
      }
    } else {
      usedMem = totalMem - freemem();
    }

    // CPU load average (1 min) as percentage (rough approximation)
    const load = loadavg()[0];
    const cpuPercent = Math.min(100, Math.round((load / CPU_COUNT) * 100));

    return {
      cpu: cpuPercent,
      memory: {
        usedMB: Math.round(usedMem / (1024 * 1024)),
        totalMB: Math.round(totalMem / (1024 * 1024)),
        percent: Math.round((usedMem / totalMem) * 100),
      },
    };
  } catch {
    return {
      cpu: 0,
      memory: { usedMB: 0, totalMB: 0, percent: 0 },
    };
  }
}

/**
 * Build the URL the spanning browser window should open, pinned to localhost.
 * Takes only a digits-only port from the (untrusted) Host header so nothing
 * attacker-controllable reaches the launched browser; falls back to the default
 * port when the header is absent/odd. Exported for unit testing.
 */
export function resolveSpanUrl(hostHeader: string | undefined, fallbackPort = '3000'): string {
  const hostPort = String(hostHeader ?? '').split(':')[1] ?? '';
  const port = /^\d+$/.test(hostPort) ? hostPort : fallbackPort;
  return `http://localhost:${port}`;
}

export function registerSystemRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort & InfraPort & AuthPort & TabLayoutPort
): void {
  const windowStatesPath = dataPath('subagent-window-states.json');
  const parentMapPath = dataPath('subagent-parents.json');

  // ═══════════════════════════════════════════════════════════════
  // System Status & Health
  // ═══════════════════════════════════════════════════════════════

  // ========== Status ==========

  app.get('/api/status', async (req) => ctx.getLightState(req.authUser));

  // ========== Tunnel ==========

  app.get('/api/tunnel/status', async () => ctx.tunnelManager.getStatus());

  app.get('/api/tunnel/info', async () => {
    const status = ctx.tunnelManager.getStatus();
    const sseClients = ctx.getSseClientCount();
    const sessions: Array<{ ip: string; ua: string; createdAt: number; method: string }> = [];
    if (ctx.authSessions) {
      for (const [, record] of ctx.authSessions) {
        sessions.push({ ip: record.ip, ua: record.ua, createdAt: record.createdAt, method: record.method });
      }
    }
    return {
      ...status,
      sseClients,
      authEnabled: !!process.env.CODEMAN_PASSWORD,
      authSessions: sessions,
    };
  });

  app.get('/api/tunnel/qr', async (req, reply) => {
    const url = ctx.tunnelManager.getUrl();
    if (!url) {
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Tunnel not running'));
    }
    try {
      if (isMultiUserMode()) {
        // A rotating global token cannot carry identity — mint a single-use token
        // bound to the requesting user so the scanned code logs THEM in.
        const shortCode = ctx.tunnelManager.mintUserToken(getAuthUser(req).username);
        const svg = await ctx.tunnelManager.getQrSvgForCode(url, shortCode);
        return { svg, authEnabled: true };
      }
      const authPassword = process.env.CODEMAN_PASSWORD;
      if (authPassword) {
        // Auth enabled — use cached SVG with embedded short code
        const svg = await ctx.tunnelManager.getQrSvg(url);
        return { svg, authEnabled: true };
      }
      // No auth — just encode the raw tunnel URL
      const QRCode = await import('qrcode');
      const svg: string = await QRCode.toString(url, { type: 'svg', margin: 2, width: 256 });
      return { svg, authEnabled: false };
    } catch (err) {
      return reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err)));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Authentication (QR auth, session revocation)
  // ═══════════════════════════════════════════════════════════════

  // ========== QR Auth Route ==========

  app.get('/q/:code', async (req, reply) => {
    const shortCode = (req.params as { code: string }).code;
    const multiUser = isMultiUserMode();
    const authPassword = process.env.CODEMAN_PASSWORD;

    // No point if auth isn't enabled — just redirect. Multi-user is always "enabled".
    if (!multiUser && !authPassword) {
      return reply.redirect('/');
    }

    const clientIp = req.ip;

    // Per-IP rate limit (separate counter from Basic Auth failures)
    const qrFailures = ctx.qrAuthFailures?.get(clientIp) ?? 0;
    if (qrFailures >= QR_AUTH_FAILURE_MAX) {
      return reply.code(429).send('Too Many Requests');
    }

    // Validate and atomically consume the token (with any bound identity).
    const consumed = shortCode ? ctx.tunnelManager.consumeTokenWithIdentity(shortCode) : { ok: false };
    // In multi-user mode a token MUST carry an identity (an identity-less rotating
    // token can't create a scoped session), so reject those too.
    if (!consumed.ok || (multiUser && !consumed.username)) {
      ctx.qrAuthFailures?.set(clientIp, qrFailures + 1);
      return reply.code(401).send('Invalid or expired QR code');
    }

    // Resolve the role for the bound user (disabled/deleted users fail closed).
    // Carry the bound user's real mustChangePassword flag out of this block so the
    // minted cookie enforces the lockbox instead of hardcoding false.
    let identity: { username: string; role: 'admin' | 'user'; mustChangePassword: boolean } | undefined;
    if (multiUser && consumed.username) {
      const user = await findUser(consumed.username);
      if (!user || user.disabled) {
        ctx.qrAuthFailures?.set(clientIp, qrFailures + 1);
        return reply.code(401).send('Invalid or expired QR code');
      }
      identity = { username: user.username, role: user.role, mustChangePassword: !!user.mustChangePassword };
    }

    // Issue session cookie (same pattern as Basic Auth success path)
    const sessionToken = randomBytes(32).toString('hex');
    const clientUA = req.headers['user-agent'] ?? '';
    ctx.authSessions?.set(sessionToken, {
      ip: clientIp,
      ua: clientUA,
      createdAt: Date.now(),
      method: 'qr',
      username: identity?.username,
      role: identity?.role,
      mustChangePassword: !!identity?.mustChangePassword,
    });
    ctx.qrAuthFailures?.delete(clientIp);

    // Audit log
    const lifecycleLog = getLifecycleLog();
    lifecycleLog.log({
      event: 'qr_auth',
      sessionId: 'system',
      extra: {
        ip: clientIp,
        ua: clientUA,
        shortCodePrefix: shortCode.slice(0, 3) + '***',
      },
    });

    reply.setCookie(AUTH_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: ctx.https,
      sameSite: 'lax',
      maxAge: AUTH_SESSION_TTL_MS / 1000,
      path: '/',
    });

    // Broadcast auth notification — desktop sees who authenticated
    ctx.broadcast(SseEvent.TunnelQrAuthUsed, {
      ip: clientIp,
      ua: clientUA,
      timestamp: Date.now(),
    });

    return reply.redirect('/');
  });

  // ========== QR Regeneration ==========

  app.post('/api/tunnel/qr/regenerate', async () => {
    ctx.tunnelManager.regenerateQrToken();
    return {};
  });

  // ========== Auth Session Revocation ==========

  app.post('/api/auth/revoke', async (req) => {
    const result = RevokeSessionSchema.safeParse(req.body);
    if (result.success && result.data.sessionToken) {
      ctx.authSessions?.delete(result.data.sessionToken);
    } else {
      // Revoke all sessions (nuclear option)
      ctx.authSessions?.clear();
    }
    return {};
  });

  // ═══════════════════════════════════════════════════════════════
  // Multi-monitor: span Codeman across all displays
  // ═══════════════════════════════════════════════════════════════

  // Spawn scripts/span-codeman.sh, which opens a fresh, maximized browser --app
  // window sized to the union of all displays — so in-page floating session
  // panels can be dragged across the physical monitor seam. macOS only; needs
  // the one-time "Displays have separate Spaces" OFF prerequisite (see script).
  app.post('/api/system/span-displays', async (req, reply) => {
    // macOS only: the launcher uses osascript + Finder desktop bounds and Chrome
    // --app geometry flags. Fail clearly elsewhere instead of spawning a bash
    // that errors out invisibly (the toast would otherwise lie "Opening…").
    if (process.platform !== 'darwin') {
      return reply
        .code(400)
        .send(
          createErrorResponse(
            ApiErrorCode.INVALID_INPUT,
            'Multi-monitor spanning runs on the Codeman server, which is not macOS. ' +
              'If your monitors are on a remote Mac, run scripts/span-codeman.sh locally on that Mac with this server URL — see the script header for details.'
          )
        );
    }
    // Resolve the bundled launcher relative to this module (works from src/ and dist/).
    const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/span-codeman.sh');
    if (!existsSync(scriptPath)) {
      return reply.code(500).send(createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'span-codeman.sh not found'));
    }
    // Point the spanning window at THIS server (localhost + sanitized port).
    const url = resolveSpanUrl(req.headers.host);
    try {
      const child = spawn('bash', [scriptPath, url], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => app.log.error({ err }, 'span-displays launch failed'));
      child.unref();
      return { url };
    } catch (err) {
      return reply.code(500).send(createErrorResponse(ApiErrorCode.INTERNAL_ERROR, getErrorMessage(err)));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Self-Update (App Settings → Updates)
  // ═══════════════════════════════════════════════════════════════

  // Install info + whether a newer release exists. Manual, user-triggered.
  app.get('/api/system/update/check', async () => {
    const check = await checkForUpdate();
    const info = getInstallInfo();
    return { ...info, ...check };
  });

  // Poll target for update progress — survives the restart the update triggers.
  app.get('/api/system/update/status', async () => getUpdateStatusForApi());

  // Informational companion to the release-tag updater above: what this CHECKOUT
  // looks like against its own remotes (ahead/behind, incoming commits), which a
  // release tag cannot answer for a git install tracking a branch.
  app.get('/api/system/repo-status', async () => getRepositoryStatus());

  // Kick off a detached update to the latest release. Returns immediately; the
  // browser then polls /api/system/update/status across the service restart.
  app.post('/api/system/update', async (_req, reply) => {
    const result = await startUpdate();
    if (result.ok) {
      return { updateId: result.updateId, toTag: result.toTag, toVersion: result.toVersion };
    }
    const map = {
      'in-flight': { http: 409, api: ApiErrorCode.ALREADY_EXISTS },
      'up-to-date': { http: 409, api: ApiErrorCode.ALREADY_EXISTS },
      'not-git': { http: 400, api: ApiErrorCode.INVALID_INPUT },
      disabled: { http: 403, api: ApiErrorCode.INVALID_INPUT },
      'bad-tag': { http: 400, api: ApiErrorCode.INVALID_INPUT },
      error: { http: 500, api: ApiErrorCode.INTERNAL_ERROR },
    } as const;
    const m = map[result.code];
    return reply.code(m.http).send(createErrorResponse(m.api, result.message));
  });

  // ═══════════════════════════════════════════════════════════════
  // CLI Integrations (Claude, OpenCode, Codex, Gemini, Antigravity, Pi, Grok)
  // ═══════════════════════════════════════════════════════════════

  // ========== Claude ==========

  app.get('/api/claude/status', async () => {
    const { isClaudeAvailable, findClaudeDir } = await import('../../utils/claude-cli-resolver.js');
    return {
      available: isClaudeAvailable(),
      path: findClaudeDir(),
    };
  });

  // ========== OpenCode ==========

  app.get('/api/opencode/status', async () => {
    const { isOpenCodeAvailable, resolveOpenCodeDir } = await import('../../utils/opencode-cli-resolver.js');
    return {
      available: isOpenCodeAvailable(),
      path: resolveOpenCodeDir(),
    };
  });

  app.get('/api/codex/status', async () => {
    const { isCodexAvailable, resolveCodexDir } = await import('../../utils/codex-cli-resolver.js');
    return {
      available: isCodexAvailable(),
      path: resolveCodexDir(),
    };
  });

  // ========== Gemini ==========

  app.get('/api/gemini/status', async () => {
    const { isGeminiAvailable, resolveGeminiDir } = await import('../../utils/gemini-cli-resolver.js');
    return {
      available: isGeminiAvailable(),
      path: resolveGeminiDir(),
    };
  });

  // ========== Antigravity ==========

  app.get('/api/antigravity/status', async () => {
    const { isAntigravityAvailable, resolveAntigravityDir } = await import('../../utils/antigravity-cli-resolver.js');
    return {
      available: isAntigravityAvailable(),
      path: resolveAntigravityDir(),
    };
  });

  // ========== Pi ==========

  // Carries `version` on top of the sibling shape: `pi` is a short, generic binary
  // name, so the resolver sanity-probes `pi --version` and rejects anything that
  // is not the coding agent. Surfacing path + version makes a misresolution
  // diagnosable from the UI instead of presenting as "the mode just doesn't work".
  app.get('/api/pi/status', async () => {
    const { isPiAvailable, resolvePiDir, getPiCliVersion } = await import('../../utils/pi-cli-resolver.js');
    return {
      available: isPiAvailable(),
      path: resolvePiDir(),
      version: getPiCliVersion(),
    };
  });

  // ========== Grok ==========

  // Carries `version` on top of the sibling shape, same reason as pi: `grok` is a
  // binary name with known squatters, so the resolver version-probes candidates and
  // this endpoint is where a misresolution shows up (path + version) instead of
  // presenting as "the mode just doesn't work".
  app.get('/api/grok/status', async () => {
    const { isGrokAvailable, resolveGrokDir, getGrokCliVersion } = await import('../../utils/grok-cli-resolver.js');
    return {
      available: isGrokAvailable(),
      path: resolveGrokDir(),
      version: getGrokCliVersion(),
    };
  });

  // ========== DeepSeek Harness ==========

  // The widest of the per-CLI status shapes, because this mode has the widest
  // failure surface. Three fields beyond the sibling `available`/`path`:
  //
  // - `version`, like pi/grok, so a misresolution is diagnosable — and here the
  //   stakes are higher, since `dsh` is also an existing Debian program
  //   (dancer's shell) rather than merely a squattable npm name.
  // - `profiles`, because `dsh` is a LAUNCHER: a perfectly installed binary with
  //   no pane-capable profile cannot start a session, and the UI has to be able
  //   to say which of the two halves is missing.
  // - `runnable` + `defaultProfile`, the answer the Run button actually needs,
  //   so no caller has to re-derive it from the parts and get it subtly wrong.
  app.get('/api/deepseek/status', async () => {
    const {
      isDeepSeekAvailable,
      isDeepSeekRunnable,
      resolveDeepSeekDir,
      getDeepSeekCliVersion,
      listDeepSeekProfiles,
      resolveDefaultDeepSeekProfile,
      resolveDshHome,
    } = await import('../../utils/deepseek-cli-resolver.js');
    return {
      available: isDeepSeekAvailable(),
      runnable: isDeepSeekRunnable(),
      path: resolveDeepSeekDir(),
      version: getDeepSeekCliVersion(),
      dshHome: resolveDshHome(),
      defaultProfile: resolveDefaultDeepSeekProfile(),
      profiles: listDeepSeekProfiles(),
    };
  });

  // Start (or reuse) the background `dsh web` behind the Run menu shortcut.
  //
  // This runs as a plain child process rather than a shell SESSION on purpose.
  // The session version worked, but it put a terminal tab on screen next to the
  // web tab the user actually asked for, every single time. Nothing about a
  // long-lived HTTP server needs to be a tab.
  //
  // Fenced at the same bar as the profile installer, and for the same reason:
  // booting a dsh profile executes the plugin code in it, so this is a
  // privileged action even though it reads as "open a page".
  app.post('/api/deepseek/web', async (req) => {
    const { authority } = parseBody(DeepSeekWebStartSchema, req.body);
    if (isMultiUserMode() && !(await canUsernameRunPrivilegedCommands(getAuthUser(req).username))) {
      return createErrorResponse(
        ApiErrorCode.FORBIDDEN,
        'Starting the DeepSeek web UI requires the can-bypass-permissions grant'
      );
    }

    const { resolveDeepSeekDir, getDeepSeekNotFoundMessage } = await import('../../utils/deepseek-cli-resolver.js');
    const dir = resolveDeepSeekDir();
    if (!dir) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getDeepSeekNotFoundMessage());

    const { startDeepSeekWeb } = await import('../../deepseek-web-server.js');
    const result = await startDeepSeekWeb(dir, authority);
    if (!result.ok) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, result.error);
    return { success: true, data: { port: result.port, url: result.url, reused: result.reused } };
  });

  app.get('/api/deepseek/web', async () => {
    const { getDeepSeekWebStatus } = await import('../../deepseek-web-server.js');
    return { success: true, data: getDeepSeekWebStatus() };
  });

  app.delete('/api/deepseek/web', async (req) => {
    // Same bar as POST: the server is a single shared instance, so in
    // multi-user mode stopping it out from under other users' tabs is a
    // privileged act (single-user and granted owners are unaffected).
    if (isMultiUserMode() && !(await canUsernameRunPrivilegedCommands(getAuthUser(req).username))) {
      return createErrorResponse(
        ApiErrorCode.FORBIDDEN,
        'Stopping the DeepSeek web UI requires the can-bypass-permissions grant'
      );
    }
    const { stopDeepSeekWeb } = await import('../../deepseek-web-server.js');
    await stopDeepSeekWeb();
    return { success: true, data: { stopped: true } };
  });

  // Bootstrap an interactive profile so the mode becomes usable.
  //
  // This exists because DeepSeek ships NO terminal front door: `dsh` on its own
  // can only serve a browser UI or answer one headless task, and the agent a
  // Codeman pane runs is always a plugin the user installed. Without this the
  // mode's first-run experience is a dead Run button and a paragraph of shell
  // instructions.
  //
  // It is the only endpoint in Codeman that installs third-party code, so it is
  // fenced accordingly:
  //   - the privileged grant is required in multi-user mode (same bar as a
  //     `shell` session, which can already do strictly more);
  //   - the specifier is regex-confined to an npm name at the schema boundary —
  //     no path, URL, git spec, or leading dash;
  //   - the spawn is an argv ARRAY through the resolved `dsh`, never a shell
  //     string, so even a specifier that slipped the regex could not become a
  //     second command;
  //   - the request is held open with a bounded timeout, mirroring the
  //     synchronous-clone precedent in `POST /api/cases/clone` rather than
  //     introducing a job store for a once-per-install action — and the bound is
  //     real, because the install runs in its own process GROUP and the timeout
  //     kills the whole tree (see the spawn below for why the built-in one is
  //     not enough).
  app.post('/api/deepseek/install-profile', async (req) => {
    const body = parseBody(DeepSeekInstallProfileSchema, req.body);
    if (isMultiUserMode() && !(await canUsernameRunPrivilegedCommands(getAuthUser(req).username))) {
      return createErrorResponse(
        ApiErrorCode.FORBIDDEN,
        'Installing a DeepSeek Harness profile requires the can-bypass-permissions grant'
      );
    }

    const { resolveDeepSeekDir, getDeepSeekNotFoundMessage } = await import('../../utils/deepseek-cli-resolver.js');
    const dir = resolveDeepSeekDir();
    if (!dir) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getDeepSeekNotFoundMessage());

    const profile = body.profile || DEEPSEEK_DEFAULT_PROFILE;
    const pkg = body.package || DEEPSEEK_DEFAULT_TUI_PACKAGE;
    const result = await new Promise<{ code: number | null; output: string; timedOut: boolean }>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(join(dir, 'dsh'), ['plugin', '--profile', profile, 'add', pkg], {
          stdio: ['ignore', 'pipe', 'pipe'],
          // Own process group, and the timeout enforced by hand rather than by
          // spawn's `timeout` option. A plugin install fans out into
          // package-manager resolver/build children, and spawn's own timeout
          // signals ONLY the direct child: the survivors keep the inherited stdio
          // pipes open, `close` never fires, and this request hangs forever with
          // no route-level deadline behind it. Same fan-out, same escalation and
          // same negative-pid signal as runGit() in git-clone.ts, which is the
          // synchronous-spawn precedent this endpoint is modelled on.
          detached: true,
          // dsh bundles its own package manager, so no system pnpm is required —
          // but it still needs a HOME to resolve $DSH_HOME against.
          env: process.env,
        });
      } catch (err) {
        resolve({ code: null, output: `spawn failed: ${getErrorMessage(err)}`, timedOut: false });
        return;
      }

      let output = '';
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let reapTimer: NodeJS.Timeout | undefined;

      const capture = (chunk: Buffer) => {
        // Bounded: a package manager can emit megabytes of progress.
        if (output.length < 16_384) output += chunk.toString('utf-8');
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);

      const killTree = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
        }
      };

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (reapTimer) clearTimeout(reapTimer);
        resolve({ code, output, timedOut });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGTERM');
        killTimer = setTimeout(() => killTree('SIGKILL'), 3_000);
        // Last resort: a grandchild that escaped the group (double-fork/setsid)
        // can hold the pipes open past SIGKILL, and `close` would still never
        // arrive. Answer the caller anyway rather than leaking the request.
        reapTimer = setTimeout(() => finish(null), 8_000);
      }, DEEPSEEK_INSTALL_TIMEOUT_MS);

      child.on('error', (err) => {
        output = `${output}\n${err.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });

    if (result.code !== 0) {
      const detail = result.timedOut
        ? `timed out after ${Math.round(DEEPSEEK_INSTALL_TIMEOUT_MS / 1000)}s`
        : result.output.slice(-1000).trim() || 'no output';
      return createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        `Installing ${pkg} into profile "${profile}" failed: ${detail}`
      );
    }
    const { listDeepSeekProfiles, resolveDefaultDeepSeekProfile, isDeepSeekRunnable } =
      await import('../../utils/deepseek-cli-resolver.js');
    return {
      profile,
      package: pkg,
      runnable: isDeepSeekRunnable(),
      defaultProfile: resolveDefaultDeepSeekProfile(),
      profiles: listDeepSeekProfiles(),
    };
  });

  // ========== OMP ==========

  app.get('/api/omp/status', async () => {
    const { isOmpAvailable, resolveOmpDir, getOmpCliVersion } = await import('../../utils/omp-cli-resolver.js');
    return {
      available: isOmpAvailable(),
      path: resolveOmpDir(),
      version: getOmpCliVersion(),
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // State & Lifecycle (cleanup, lifecycle log, stats)
  // ═══════════════════════════════════════════════════════════════

  // ========== State & Lifecycle ==========

  app.post('/api/cleanup-state', async () => {
    const activeSessionIds = new Set(ctx.sessions.keys());
    const result = await ctx.tabLayouts.runStaleSessionCleanup(activeSessionIds, (ids) =>
      ctx.store.cleanupSessionsByIds(ids)
    );
    const lifecycleLog = getLifecycleLog();
    for (const s of result.cleaned) {
      lifecycleLog.log({ event: 'stale_cleaned', sessionId: s.id, name: s.name });
    }
    return { cleanedSessions: result.count };
  });

  app.get('/api/session-lifecycle', async (req) => {
    const query = req.query as {
      sessionId?: string;
      event?: string;
      since?: string;
      limit?: string;
    };
    const lifecycleLog = getLifecycleLog();
    const entries = await lifecycleLog.query({
      sessionId: query.sessionId,
      event: query.event as import('../../types.js').LifecycleEventType,
      since: query.since ? Number(query.since) : undefined,
      limit: query.limit ? Math.min(Number(query.limit), 1000) : 200,
    });
    return { entries };
  });

  // ========== Stats ==========

  function collectActiveTokens(): Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }> {
    const tokens: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }> = {};
    for (const [sessionId, session] of ctx.sessions) {
      tokens[sessionId] = {
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        totalCost: session.totalCost,
      };
    }
    return tokens;
  }

  app.get('/api/stats', async () => {
    const activeSessionTokens = collectActiveTokens();
    return {
      stats: ctx.store.getAggregateStats(activeSessionTokens),
      raw: ctx.store.getGlobalStats(),
    };
  });

  app.get('/api/token-stats', async () => {
    const activeSessionTokens = collectActiveTokens();
    return {
      daily: ctx.store.getDailyStats(30),
      totals: ctx.store.getAggregateStats(activeSessionTokens),
    };
  });

  app.get('/api/away-digest', async (req, reply) => {
    const query = req.query as {
      range?: string;
      since?: string;
      until?: string;
      lastViewed?: string;
    };

    let range;
    try {
      range = resolveAwayDigestRange({
        range: query.range,
        since: parseOptionalNumber(query.since),
        until: parseOptionalNumber(query.until),
        lastViewed: parseOptionalNumber(query.lastViewed),
      });
    } catch (err) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }

    const lifecycleLog = getLifecycleLog();
    const lifecycleEntries = await lifecycleLog.query({
      since: range.since,
      limit: 1000,
    });

    // Multi-user: scope the digest's aggregated activity to sessions the caller
    // owns (canAccessOwned is a no-op allow-all for admins/single-user).
    const user = getAuthUser(req);
    const sessions: AwayDigestSession[] = Array.from(ctx.sessions.values())
      .filter((session) => canAccessOwned(user, session.owner))
      .map((session) => ({
        id: session.id,
        name: session.name,
        status: session.status,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        totalCost: session.totalCost,
      }));

    // Run-summary trackers are keyed by Codeman session id → filter by that session's owner.
    const runSummaries = Array.from(ctx.runSummaryTrackers.entries())
      .filter(([id]) => canAccessOwned(user, ctx.sessions.get(id)?.owner))
      .map(([, tracker]) => tracker.getSummary());

    // Map each subagent's Claude conversation id back to its owning session so the
    // recent-subagent lookback is owner-scoped too (fails closed when unattributable).
    const ownerByClaudeSessionId = new Map<string, string | undefined>();
    for (const s of ctx.sessions.values()) {
      if (s.claudeSessionId) ownerByClaudeSessionId.set(s.claudeSessionId, s.owner);
    }
    const subagents = subagentWatcher
      .getRecentSubagents(60)
      .filter((sa) => canAccessOwned(user, ownerByClaudeSessionId.get(sa.sessionId))) as AwayDigestSubagent[];

    // Multi-user: the lifecycle log and daily token stats carry no owner, so scope them
    // for a non-admin: keep only lifecycle entries attributable to an owned LIVE session
    // (fail closed — an ended session's owner can't be resolved, so it is dropped rather
    // than leaked), and withhold the machine-wide daily token totals entirely (they can't
    // be per-user attributed, same as globalStats in #29). Admins/single-user keep all
    // (canAccessOwned allow-all, role check false → byte-identical).
    const scopedLifecycle = lifecycleEntries.filter((e) =>
      canAccessOwned(user, ctx.sessions.get(e.sessionId ?? '')?.owner)
    );
    const nonAdminScoped = isMultiUserMode() && user.role !== 'admin';
    const digest = buildAwayDigest({
      range,
      lifecycleEntries: scopedLifecycle,
      runSummaries,
      sessions,
      dailyTokenStats: nonAdminScoped ? [] : ctx.store.getDailyStats(30),
      subagents,
      now: range.until,
    });

    return { success: true, digest };
  });

  // ═══════════════════════════════════════════════════════════════
  // Configuration & Settings (config, settings, model config, CPU priority)
  // ═══════════════════════════════════════════════════════════════

  // ========== Config ==========

  app.get('/api/config', async () => {
    return { config: ctx.store.getConfig() };
  });

  app.put('/api/config', async (req) => {
    const configData = parseBody(ConfigUpdateSchema, req.body, 'Invalid config');
    ctx.store.setConfig(configData as Partial<ReturnType<typeof ctx.store.getConfig>>);
    return { config: ctx.store.getConfig() };
  });

  // ========== Debug/Memory ==========

  app.get('/api/debug/memory', async () => {
    const mem = process.memoryUsage();
    const subagentStats = subagentWatcher.getStats();

    const serverMapSizes = {
      sessions: ctx.sessions.size,
      runSummaryTrackers: ctx.runSummaryTrackers.size,
      scheduledRuns: ctx.scheduledRuns.size,
      activePlanOrchestrators: ctx.activePlanOrchestrators.size,
    };

    const totalServerMapEntries = Object.values(serverMapSizes).reduce((a, b) => a + b, 0);
    const totalSubagentMapEntries = Object.values(subagentStats).reduce((a, b) => a + b, 0);

    return {
      memory: {
        rss: mem.rss,
        rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        heapUsed: mem.heapUsed,
        heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        heapTotal: mem.heapTotal,
        heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
        external: mem.external,
        externalMB: Math.round((mem.external / 1024 / 1024) * 10) / 10,
        arrayBuffers: mem.arrayBuffers,
        arrayBuffersMB: Math.round((mem.arrayBuffers / 1024 / 1024) * 10) / 10,
      },
      mapSizes: {
        server: serverMapSizes,
        subagentWatcher: subagentStats,
        totals: {
          serverEntries: totalServerMapEntries,
          subagentEntries: totalSubagentMapEntries,
          allEntries: totalServerMapEntries + totalSubagentMapEntries,
        },
      },
      watchers: {
        fileDebouncers: subagentStats.fileDebouncerCount,
        dirWatchers: subagentStats.dirWatcherCount,
        total: subagentStats.fileDebouncerCount + subagentStats.dirWatcherCount,
      },
      timers: {
        subagentIdleTimers: subagentStats.idleTimerCount,
        total: subagentStats.idleTimerCount,
      },
      uptime: {
        seconds: Math.round(process.uptime()),
        formatted: formatUptime(process.uptime()),
      },
      timestamp: Date.now(),
    };
  });

  // ========== System Stats ==========

  app.get('/api/system/stats', async () => {
    return getSystemStats();
  });

  // ========== Settings ==========

  app.get('/api/settings', async () => {
    return readJsonConfig(SETTINGS_PATH, 'settings', {});
  });

  app.put('/api/settings', async (req) => {
    const settings = parseBody(SettingsUpdateSchema, req.body, 'Invalid settings') as Record<string, unknown>;

    // COD-55: enabling the Cloudflare tunnel publishes the whole app (full terminal
    // control = effectively RCE) to a public *.trycloudflare.com URL. Because the
    // tunnel binds to loopback, server.ts's non-loopback bind guard never trips, and
    // with no CODEMAN_PASSWORD the auth middleware is inactive — so the tunnel URL is
    // unauthenticated. Refuse to start a tunnel unless auth is configured OR exposure
    // is acknowledged: either the CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK env var, or an
    // explicit per-request `acknowledgeUnauthTunnel:true` (the UI sends this after a
    // confirm dialog). This keeps curl/API/CLI callers protected by default while
    // letting an operator opt in from the browser without setting the env var.
    // Guard runs BEFORE persisting so a refused tunnelEnabled:true is not saved.
    if (settings.tunnelEnabled === true && !ctx.tunnelManager.isRunning()) {
      // Multi-user mode makes the tunnel authenticated (every person has their own
      // credential), so it satisfies the same requirement as CODEMAN_PASSWORD.
      const acknowledged =
        isMultiUserMode() || isUnauthenticatedNetworkAcknowledged() || settings.acknowledgeUnauthTunnel === true;
      if (!acknowledged) {
        const msg =
          'Refusing to start the Cloudflare tunnel without authentication: it would publish ' +
          'full terminal control to a public URL with no password. Set CODEMAN_PASSWORD to ' +
          'require login, set CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1, or resend with ' +
          'acknowledgeUnauthTunnel:true to acknowledge an unauthenticated public tunnel.';
        throw Object.assign(new Error(msg), {
          statusCode: 403,
          body: createErrorResponse(ApiErrorCode.OPERATION_FAILED, msg),
        });
      }
      // Loud warning whenever a public tunnel is started with no password — whether
      // acknowledged via env var or the per-request UI confirmation.
      if (!process.env.CODEMAN_PASSWORD) {
        console.warn(
          '⚠️  [tunnel] Starting an UNAUTHENTICATED public Cloudflare tunnel — no CODEMAN_PASSWORD set. ' +
            'Anyone with the tunnel URL gets full terminal control (effectively RCE). ' +
            'Set CODEMAN_PASSWORD to require login.'
        );
      }
    }

    try {
      const dir = dirname(SETTINGS_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf-8'));
      } catch {
        /* ignore */
      }
      // statusLineTelemetry and acknowledgeUnauthTunnel are ACTION fields (not stored
      // settings) — strip them before persisting so settings.json stays clean.
      // statusLineTelemetry is an action field only (see below); it must never
      // land in settingsToStore.
      const { statusLineTelemetry: _statusLineTelemetry, acknowledgeUnauthTunnel, ...settingsToStore } = settings;
      const merged = { ...existing, ...settingsToStore };
      await fs.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));

      // tmux 3.7+ resizes tracked panes; older versions apply this to new panes.
      // Already-evicted history cannot be recovered on either version.
      if (settings.tmuxHistoryLimit !== undefined) {
        await ctx.mux.setHistoryLimit(resolveTerminalHistoryConfig(merged).tmuxHistoryLimit);
      }

      // Service toggles resolve from `merged` (existing + incoming), NEVER from the
      // raw request body. A PARTIAL PUT omits keys it does not intend to change, and
      // reading the body directly turned every omission into "apply the default":
      // a body of just `{statusLineTelemetry:true}` would START the subagent watcher
      // (`?? true`) and STOP the workflow + image watchers (`?? false`), silently
      // undoing the user's persisted config. Reading `merged` makes any PUT reconcile
      // services to the effective stored settings instead, which also self-heals
      // drift. Same convention as the tmuxHistoryLimit block above.
      // Handle subagent tracking toggle dynamically
      toggleService((merged.subagentTrackingEnabled as boolean) ?? true, subagentWatcher, 'Subagent watcher');

      // Handle ultracode/workflow run watcher toggle dynamically (default OFF).
      // Either the docked panel OR the floating windows keep the watcher running.
      toggleService(
        ((merged.showUltracodeAgents as boolean) ?? false) || ((merged.ultracodeFloatingWindows as boolean) ?? false),
        workflowRunWatcher,
        'Workflow run watcher'
      );

      // Handle image watcher toggle dynamically
      toggleService((merged.imageWatcherEnabled as boolean) ?? false, imageWatcher, 'Image watcher', () => {
        // Re-watch all active sessions that have image watcher enabled
        for (const session of ctx.sessions.values()) {
          if (session.imageWatcherEnabled) {
            imageWatcher.watchSession(session.id, session.workingDir);
          }
        }
      });

      // Plan-usage chip: its DISPLAY is per-device (client-side, see settings-ui.js).
      // Telemetry COLLECTION was previously server-side and enable-sticky here —
      // toggling the chip ON re-injected a statusLine.command into every ACTIVE
      // Claude session's settings.local.json so live % started flowing without a
      // new session. That disk write is exactly the bug fixed 2026-08-31 (it took
      // precedence over the user's own statusline for ANY `claude` run in that
      // directory, including outside Codeman, with no way to undo it). Telemetry
      // is now requested per-session at CREATE time only (statusLineTelemetry on
      // POST /api/sessions), resolved into an ephemeral `--settings` CLI flag —
      // fixed at spawn, so there is nothing to (re)inject into an already-running
      // session here. The action field above is received and discarded.

      // Handle tunnel toggle dynamically
      if ('tunnelEnabled' in settings) {
        const tunnelEnabled = settings.tunnelEnabled as boolean;
        if (tunnelEnabled && !ctx.tunnelManager.isRunning()) {
          ctx.tunnelManager.start(ctx.port, ctx.https);
          console.log('Tunnel started via settings change');
        } else if (tunnelEnabled && ctx.tunnelManager.isRunning() && ctx.tunnelManager.getUrl()) {
          // Tunnel already running — re-emit so the client gets the URL
          ctx.broadcast(SseEvent.TunnelStarted, { url: ctx.tunnelManager.getUrl() });
          console.log('Tunnel already running, re-broadcast URL to client');
        } else if (!tunnelEnabled && ctx.tunnelManager.isRunning()) {
          ctx.tunnelManager.stop();
          console.log('Tunnel stopped via settings change');
        }
      }

      return {};
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Model Configuration ==========

  app.get('/api/execution/model-config', async () => {
    const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'model config', {});
    return { success: true, data: settings.modelConfig || {} };
  });

  app.put('/api/execution/model-config', async (req) => {
    const modelConfig = parseBody(ModelConfigUpdateSchema, req.body, 'Invalid model config') as Record<string, unknown>;

    try {
      let existingSettings: Record<string, unknown> = {};
      try {
        const content = await fs.readFile(SETTINGS_PATH, 'utf-8');
        existingSettings = JSON.parse(content);
      } catch {
        // File doesn't exist yet, start fresh
      }

      existingSettings.modelConfig = modelConfig;

      const dir = dirname(SETTINGS_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      await fs.writeFile(SETTINGS_PATH, JSON.stringify(existingSettings, null, 2));

      return {};
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== CPU Priority ==========

  app.get('/api/sessions/:id/cpu-limit', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    return {
      nice: session.niceConfig,
    };
  });

  app.post('/api/sessions/:id/cpu-limit', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    const body = parseBody(CpuLimitSchema, req.body, 'Invalid request body') as Partial<NiceConfig>;

    session.setNice(body);
    ctx.persistSessionState(session);
    ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });

    return {
      nice: session.niceConfig,
      note: 'Nice priority only affects newly created mux sessions, not currently running ones.',
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Subagent Management (window states, parents, monitoring, transcripts)
  // ═══════════════════════════════════════════════════════════════

  // ========== Subagent Window State Persistence ==========

  app.get('/api/subagent-window-states', async () => {
    return readJsonConfig(windowStatesPath, 'subagent window states', { minimized: {}, open: [] });
  });

  app.put('/api/subagent-window-states', async (req) => {
    const states = parseBody(SubagentWindowStatesSchema, req.body, 'Invalid window states') as Record<string, unknown>;
    try {
      const dir = dirname(windowStatesPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      await fs.writeFile(windowStatesPath, JSON.stringify(states, null, 2));
      return {};
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Subagent Parent Associations ==========

  app.get('/api/subagent-parents', async () => {
    return readJsonConfig(parentMapPath, 'subagent parent map', {});
  });

  app.put('/api/subagent-parents', async (req) => {
    const parentMap = parseBody(SubagentParentMapSchema, req.body, 'Invalid parent map');
    try {
      const dir = dirname(parentMapPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      await fs.writeFile(parentMapPath, JSON.stringify(parentMap, null, 2));
      return {};
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Workflow Run Monitoring (ultracode) ==========

  // LEFT-pane list: lightweight run summaries (no agents[]).
  app.get('/api/workflows', async (req, reply) => {
    // Multi-user stopgap: these aggregates are process-wide (no owner concept), so
    // restrict cross-user reads to admins (no-op allow-all in single-user mode).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const { minutes } = req.query as { minutes?: string };
    const runs = minutes
      ? workflowRunWatcher.getRecentRunSummaries(parseInt(minutes, 10))
      : workflowRunWatcher.getAllRunSummaries();
    return { success: true, data: runs };
  });

  // RIGHT-pane detail: full run incl. agents[] (tokens/toolCalls/state per agent).
  app.get('/api/workflows/:runId', async (req, reply) => {
    // Multi-user stopgap: cross-user run detail is admin-only (no-op in single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const { runId } = req.params as { runId: string };
    const run = workflowRunWatcher.getRun(runId);
    if (!run) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Workflow run ${runId} not found`);
    }
    return { success: true, data: run };
  });

  // ========== Subagent Monitoring ==========

  app.get('/api/subagents', async (req, reply) => {
    // Multi-user stopgap: the global subagent list spans all users → admin-only
    // (no-op allow-all in single-user mode). Per-session variant below stays scoped.
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const { minutes } = req.query as { minutes?: string };
    const subagents = minutes
      ? subagentWatcher.getRecentSubagents(parseInt(minutes, 10))
      : subagentWatcher.getSubagents();
    return { success: true, data: subagents };
  });

  app.get('/api/sessions/:id/subagents', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    const subagents = subagentWatcher.getSubagentsForSession(session.workingDir);
    return { success: true, data: subagents };
  });

  app.get('/api/subagents/:agentId', async (req, reply) => {
    // Multi-user stopgap: cross-user subagent metadata is admin-only (no-op single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const { agentId } = req.params as { agentId: string };
    const info = subagentWatcher.getSubagent(agentId);
    if (!info) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Subagent ${agentId} not found`);
    }
    return { success: true, data: info };
  });

  app.get('/api/subagents/:agentId/transcript', async (req, reply) => {
    // Multi-user stopgap: transcript CONTENT of any user's subagent is admin-only
    // (no-op allow-all in single-user mode).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const { agentId } = req.params as { agentId: string };
    const { limit, format } = req.query as { limit?: string; format?: 'raw' | 'formatted' };
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    const transcript = await subagentWatcher.getTranscript(agentId, limitNum);

    if (format === 'formatted') {
      const formatted = subagentWatcher.formatTranscript(transcript);
      return { success: true, data: { formatted, entryCount: transcript.length } };
    }

    return { success: true, data: transcript };
  });

  app.delete('/api/subagents/:agentId', async (req, reply) => {
    // Multi-user stopgap: killing any user's subagent is a cross-user write → admin-only
    // (no-op allow-all in single-user mode).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const { agentId } = req.params as { agentId: string };
    const info = subagentWatcher.getSubagent(agentId);
    if (!info) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subagent not found');
    }

    const killed = await subagentWatcher.killSubagent(agentId);
    if (killed) {
      return { success: true, data: { agentId, status: 'killed' } };
    }
    return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Subagent not found or already completed');
  });

  app.post('/api/subagents/cleanup', async (req, reply) => {
    // Multi-user stopgap: process-wide cleanup affects every user → admin-only (no-op single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const removed = subagentWatcher.cleanupNow();
    return { success: true, data: { removed, remaining: subagentWatcher.getSubagents().length } };
  });

  app.delete('/api/subagents', async (req, reply) => {
    // Multi-user stopgap: clearing ALL users' subagents is a cross-user write → admin-only (no-op single-user).
    if (isMultiUserMode() && !requireAdmin(req, reply)) return;
    const cleared = subagentWatcher.clearAll();
    return { success: true, data: { cleared } };
  });

  // ═══════════════════════════════════════════════════════════════
  // Screenshots (upload, list, serve)
  // ═══════════════════════════════════════════════════════════════

  // ========== Screenshots ==========

  app.post('/api/screenshots', async (req, reply) => {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected multipart/form-data');
    }

    // Parse multipart boundary
    const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
    if (!boundaryMatch) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing boundary');
    }

    // Collect raw body
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req.raw) {
      totalSize += chunk.length;
      if (totalSize > MAX_SCREENSHOT_SIZE) {
        reply.code(413);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'File too large (max 10MB)');
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    // Extract file from multipart body
    const boundary = '--' + boundaryMatch[1];
    const boundaryBuf = Buffer.from(boundary);
    const parts: { headers: string; data: Buffer }[] = [];
    let pos = 0;

    // Find each part between boundaries
    while (pos < body.length) {
      const start = body.indexOf(boundaryBuf, pos);
      if (start === -1) break;
      const afterBoundary = start + boundaryBuf.length;
      // Check for closing boundary (--)
      if (body[afterBoundary] === 0x2d && body[afterBoundary + 1] === 0x2d) break;
      // Skip \r\n after boundary
      const headerStart = afterBoundary + 2;
      const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
      if (headerEnd === -1) break;
      const headers = body.subarray(headerStart, headerEnd).toString();
      const dataStart = headerEnd + 4;
      const nextBoundary = body.indexOf(boundaryBuf, dataStart);
      // Data ends 2 bytes before next boundary (\r\n)
      const dataEnd = nextBoundary === -1 ? body.length : nextBoundary - 2;
      parts.push({ headers, data: body.subarray(dataStart, dataEnd) });
      pos = nextBoundary === -1 ? body.length : nextBoundary;
    }

    const filePart = parts.find((p) => p.headers.includes('name="file"'));
    if (!filePart || filePart.data.length === 0) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No file uploaded');
    }

    // Determine extension from Content-Type or filename
    let ext = '.png';
    const filenameMatch = filePart.headers.match(/filename="(.+?)"/);
    if (filenameMatch) {
      const origExt = filenameMatch[1].match(/\.(png|jpg|jpeg|webp|gif)$/i);
      if (origExt) ext = origExt[0].toLowerCase();
    }
    const ctMatch = filePart.headers.match(/Content-Type:\s*image\/(png|jpeg|webp|gif)/i);
    if (ctMatch) {
      const map: Record<string, string> = {
        png: '.png',
        jpeg: '.jpg',
        webp: '.webp',
        gif: '.gif',
      };
      ext = map[ctMatch[1].toLowerCase()] ?? ext;
    }

    // Save to ~/.codeman/screenshots/
    if (!existsSync(SCREENSHOTS_DIR)) {
      mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const filename = `screenshot_${timestamp}${ext}`;
    const filepath = join(SCREENSHOTS_DIR, filename);
    await fs.writeFile(filepath, filePart.data);

    return { path: filepath, filename };
  });

  app.get('/api/screenshots', async () => {
    if (!existsSync(SCREENSHOTS_DIR)) {
      return { files: [] };
    }
    const files = readdirSync(SCREENSHOTS_DIR)
      .filter((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
      .sort()
      .reverse()
      .slice(0, 50)
      .map((name) => ({ name, path: join(SCREENSHOTS_DIR, name) }));
    return { files };
  });

  app.get('/api/screenshots/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    // Prevent path traversal
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid filename');
    }
    const filepath = join(SCREENSHOTS_DIR, name);
    if (!existsSync(filepath)) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Screenshot not found');
    }
    const ext = name.match(/\.(png|jpg|jpeg|webp|gif)$/i)?.[1]?.toLowerCase() ?? 'png';
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
    };
    reply.type(mimeMap[ext] ?? 'image/png');
    return fs.readFile(filepath);
  });
}
