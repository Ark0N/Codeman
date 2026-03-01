/**
 * @fileoverview System, config, settings, subagent, and debug routes.
 * Covers status, stats, config CRUD, settings, subagent monitoring,
 * debug/memory, lifecycle logs, screenshots, and various persistence endpoints.
 */

import { FastifyInstance } from 'fastify';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir, totalmem, freemem, loadavg, cpus } from 'node:os';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type NiceConfig } from '../../types.js';
import {
  ConfigUpdateSchema,
  SettingsUpdateSchema,
  ModelConfigUpdateSchema,
  CpuLimitSchema,
  SubagentWindowStatesSchema,
  SubagentParentMapSchema,
} from '../schemas.js';
import { subagentWatcher } from '../../subagent-watcher.js';
import { imageWatcher } from '../../image-watcher.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import { findSessionOrFail, formatUptime, SETTINGS_PATH } from '../route-helpers.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort, AuthPort } from '../ports/index.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.js';

// Maximum screenshot upload size (10MB)
const MAX_SCREENSHOT_SIZE = 10 * 1024 * 1024;
// Screenshots directory
const SCREENSHOTS_DIR = join(homedir(), '.codeman', 'screenshots');

/** Cached CPU count — doesn't change at runtime */
const CPU_COUNT = cpus().length;

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

export function registerSystemRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort & InfraPort & AuthPort
): void {
  const windowStatesPath = join(homedir(), '.codeman', 'subagent-window-states.json');
  const parentMapPath = join(homedir(), '.codeman', 'subagent-parents.json');

  // ========== Status ==========

  app.get('/api/status', async () => ctx.getLightState());

  // ========== Tunnel ==========

  app.get('/api/tunnel/status', async () => ctx.tunnelManager.getStatus());

  app.get('/api/tunnel/qr', async (_req, reply) => {
    const url = ctx.tunnelManager.getUrl();
    if (!url) {
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Tunnel not running'));
    }
    try {
      const authPassword = process.env.CODEMAN_PASSWORD;
      if (authPassword) {
        // Auth enabled — use cached SVG with embedded short code
        const svg = await ctx.tunnelManager.getQrSvg(url);
        return { svg, authEnabled: true };
      }
      // No auth — just encode the raw tunnel URL
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic optional dependency
      const QRCode = require('qrcode');
      const svg: string = await QRCode.toString(url, { type: 'svg', margin: 2, width: 256 });
      return { svg, authEnabled: false };
    } catch (err) {
      return reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err)));
    }
  });

  // ========== QR Auth Route ==========

  app.get('/q/:code', async (req, reply) => {
    const shortCode = (req.params as { code: string }).code;
    const authPassword = process.env.CODEMAN_PASSWORD;

    // No point if auth isn't enabled — just redirect
    if (!authPassword) {
      return reply.redirect('/');
    }

    const clientIp = req.ip;

    // Per-IP rate limit (separate counter from Basic Auth failures)
    const qrFailures = ctx.qrAuthFailures?.get(clientIp) ?? 0;
    if (qrFailures >= 10) {
      return reply.code(429).send('Too Many Requests');
    }

    // Validate and atomically consume the token
    if (!shortCode || !ctx.tunnelManager.consumeToken(shortCode)) {
      ctx.qrAuthFailures?.set(clientIp, qrFailures + 1);
      return reply.code(401).send('Invalid or expired QR code');
    }

    // Issue session cookie (same pattern as Basic Auth success path)
    const sessionToken = randomBytes(32).toString('hex');
    const clientUA = req.headers['user-agent'] ?? '';
    ctx.authSessions?.set(sessionToken, {
      ip: clientIp,
      ua: clientUA,
      createdAt: Date.now(),
      method: 'qr',
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
      maxAge: 86400, // 24h
      path: '/',
    });

    // Broadcast auth notification — desktop sees who authenticated
    ctx.broadcast('tunnel:qrAuthUsed', {
      ip: clientIp,
      ua: clientUA,
      timestamp: Date.now(),
    });

    return reply.redirect('/');
  });

  // ========== QR Regeneration ==========

  app.post('/api/tunnel/qr/regenerate', async () => {
    ctx.tunnelManager.regenerateQrToken();
    return { success: true };
  });

  // ========== Auth Session Revocation ==========

  app.post('/api/auth/revoke', async (req) => {
    const body = req.body as { sessionToken?: string } | undefined;
    if (body?.sessionToken) {
      ctx.authSessions?.delete(body.sessionToken);
    } else {
      // Revoke all sessions (nuclear option)
      ctx.authSessions?.clear();
    }
    return { success: true };
  });

  // ========== OpenCode ==========

  app.get('/api/opencode/status', async () => {
    const { isOpenCodeAvailable, resolveOpenCodeDir } = await import('../../utils/opencode-cli-resolver.js');
    return {
      available: isOpenCodeAvailable(),
      path: resolveOpenCodeDir(),
    };
  });

  // ========== State & Lifecycle ==========

  app.post('/api/cleanup-state', async () => {
    const activeSessionIds = new Set(ctx.sessions.keys());
    const result = ctx.store.cleanupStaleSessions(activeSessionIds);
    const lifecycleLog = getLifecycleLog();
    for (const s of result.cleaned) {
      lifecycleLog.log({ event: 'stale_cleaned', sessionId: s.id, name: s.name });
    }
    return { success: true, cleanedSessions: result.count };
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
    return { success: true, entries };
  });

  // ========== Stats ==========

  app.get('/api/stats', async () => {
    const activeSessionTokens: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }> = {};
    for (const [sessionId, session] of ctx.sessions) {
      activeSessionTokens[sessionId] = {
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        totalCost: session.totalCost,
      };
    }
    return {
      success: true,
      stats: ctx.store.getAggregateStats(activeSessionTokens),
      raw: ctx.store.getGlobalStats(),
    };
  });

  app.get('/api/token-stats', async () => {
    const activeSessionTokens: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }> = {};
    for (const [sessionId, session] of ctx.sessions) {
      activeSessionTokens[sessionId] = {
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        totalCost: session.totalCost,
      };
    }
    return {
      success: true,
      daily: ctx.store.getDailyStats(30),
      totals: ctx.store.getAggregateStats(activeSessionTokens),
    };
  });

  // ========== Config ==========

  app.get('/api/config', async () => {
    return { success: true, config: ctx.store.getConfig() };
  });

  app.put('/api/config', async (req) => {
    const parseResult = ConfigUpdateSchema.safeParse(req.body);
    if (!parseResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Invalid config: ${parseResult.error.message}`);
    }
    ctx.store.setConfig(parseResult.data as Partial<ReturnType<typeof ctx.store.getConfig>>);
    return { success: true, config: ctx.store.getConfig() };
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
    try {
      const content = await fs.readFile(SETTINGS_PATH, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read settings:', err);
      }
    }
    return {};
  });

  app.put('/api/settings', async (req) => {
    const settingsResult = SettingsUpdateSchema.safeParse(req.body);
    if (!settingsResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid settings');
    }
    const settings = settingsResult.data as Record<string, unknown>;

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
      const merged = { ...existing, ...settings };
      await fs.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));

      // Handle subagent tracking toggle dynamically
      const subagentEnabled = settings.subagentTrackingEnabled ?? true;
      if (subagentEnabled && !subagentWatcher.isRunning()) {
        subagentWatcher.start();
        console.log('Subagent watcher started via settings change');
      } else if (!subagentEnabled && subagentWatcher.isRunning()) {
        subagentWatcher.stop();
        console.log('Subagent watcher stopped via settings change');
      }

      // Handle image watcher toggle dynamically
      const imageWatcherEnabled = settings.imageWatcherEnabled ?? false;
      if (imageWatcherEnabled && !imageWatcher.isRunning()) {
        imageWatcher.start();
        // Re-watch all active sessions that have image watcher enabled
        for (const session of ctx.sessions.values()) {
          if (session.imageWatcherEnabled) {
            imageWatcher.watchSession(session.id, session.workingDir);
          }
        }
        console.log('Image watcher started via settings change');
      } else if (!imageWatcherEnabled && imageWatcher.isRunning()) {
        imageWatcher.stop();
        console.log('Image watcher stopped via settings change');
      }

      // Handle tunnel toggle dynamically
      if ('tunnelEnabled' in settings) {
        const tunnelEnabled = settings.tunnelEnabled as boolean;
        if (tunnelEnabled && !ctx.tunnelManager.isRunning()) {
          ctx.tunnelManager.start(ctx.port, ctx.https);
          console.log('Tunnel started via settings change');
        } else if (tunnelEnabled && ctx.tunnelManager.isRunning() && ctx.tunnelManager.getUrl()) {
          // Tunnel already running — re-emit so the client gets the URL
          ctx.broadcast('tunnel:started', { url: ctx.tunnelManager.getUrl() });
          console.log('Tunnel already running, re-broadcast URL to client');
        } else if (!tunnelEnabled && ctx.tunnelManager.isRunning()) {
          ctx.tunnelManager.stop();
          console.log('Tunnel stopped via settings change');
        }
      }

      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Model Configuration ==========

  app.get('/api/execution/model-config', async () => {
    try {
      const content = await fs.readFile(SETTINGS_PATH, 'utf-8');
      const settings = JSON.parse(content);
      return { success: true, data: settings.modelConfig || {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read model config:', err);
      }
      return { success: true, data: {} };
    }
  });

  app.put('/api/execution/model-config', async (req) => {
    const mcResult = ModelConfigUpdateSchema.safeParse(req.body);
    if (!mcResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid model config');
    }
    const modelConfig = mcResult.data as Record<string, unknown>;

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

      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== CPU Priority ==========

  app.get('/api/sessions/:id/cpu-limit', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    return {
      success: true,
      nice: session.niceConfig,
    };
  });

  app.post('/api/sessions/:id/cpu-limit', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    const clResult = CpuLimitSchema.safeParse(req.body);
    if (!clResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const body = clResult.data as Partial<NiceConfig>;

    session.setNice(body);
    ctx.persistSessionState(session);
    ctx.broadcast('session:updated', { session: ctx.getSessionStateWithRespawn(session) });

    return {
      success: true,
      nice: session.niceConfig,
      note: 'Nice priority only affects newly created mux sessions, not currently running ones.',
    };
  });

  // ========== Subagent Window State Persistence ==========

  app.get('/api/subagent-window-states', async () => {
    try {
      const content = await fs.readFile(windowStatesPath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read subagent window states:', err);
      }
    }
    return { minimized: {}, open: [] };
  });

  app.put('/api/subagent-window-states', async (req) => {
    const swResult = SubagentWindowStatesSchema.safeParse(req.body);
    if (!swResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid window states');
    }
    const states = swResult.data as Record<string, unknown>;
    try {
      const dir = dirname(windowStatesPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      await fs.writeFile(windowStatesPath, JSON.stringify(states, null, 2));
      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Subagent Parent Associations ==========

  app.get('/api/subagent-parents', async () => {
    try {
      const content = await fs.readFile(parentMapPath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read subagent parent map:', err);
      }
    }
    return {};
  });

  app.put('/api/subagent-parents', async (req) => {
    const spResult = SubagentParentMapSchema.safeParse(req.body);
    if (!spResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid parent map');
    }
    const parentMap = spResult.data;
    try {
      const dir = dirname(parentMapPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      await fs.writeFile(parentMapPath, JSON.stringify(parentMap, null, 2));
      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Subagent Monitoring ==========

  app.get('/api/subagents', async (req) => {
    const { minutes } = req.query as { minutes?: string };
    const subagents = minutes
      ? subagentWatcher.getRecentSubagents(parseInt(minutes, 10))
      : subagentWatcher.getSubagents();
    return { success: true, data: subagents };
  });

  app.get('/api/sessions/:id/subagents', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    const subagents = subagentWatcher.getSubagentsForSession(session.workingDir);
    return { success: true, data: subagents };
  });

  app.get('/api/subagents/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const info = subagentWatcher.getSubagent(agentId);
    if (!info) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Subagent ${agentId} not found`);
    }
    return { success: true, data: info };
  });

  app.get('/api/subagents/:agentId/transcript', async (req) => {
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

  app.delete('/api/subagents/:agentId', async (req) => {
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

  app.post('/api/subagents/cleanup', async () => {
    const removed = subagentWatcher.cleanupNow();
    return { success: true, data: { removed, remaining: subagentWatcher.getSubagents().length } };
  });

  app.delete('/api/subagents', async () => {
    const cleared = subagentWatcher.clearAll();
    return { success: true, data: { cleared } };
  });

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
        reply.status(413);
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

    return { success: true, path: filepath, filename };
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
      reply.status(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid filename');
    }
    const filepath = join(SCREENSHOTS_DIR, name);
    if (!existsSync(filepath)) {
      reply.status(404);
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
