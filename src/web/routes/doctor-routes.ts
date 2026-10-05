/**
 * @fileoverview `GET /api/doctor` — the `codeman doctor` dependency report (Node, the agent CLIs,
 * tmux, LibreOffice, MS Office) for Settings → System → Diagnostics.
 *
 * The probe engine is synchronous (`which` + `<bin> --version` per tool, each up to its own
 * timeout), so it must never run on the server's event loop: a handful of slow probes would
 * freeze every request and every SSE client, with the process still alive. The default runner
 * therefore runs `codeman doctor --json` in a CHILD PROCESS of this same entry script and
 * parses its output; the runner is injected so tests never spawn anything.
 *
 * Read-only, but the report names install paths and versions on the host, so in multi-user
 * mode it is admin only (the same bar as the other host-introspection routes).
 */

import { execFile } from 'node:child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { isAdmin } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { TOOL_CATEGORIES } from '../../config/dependency-registry.js';
import type { DependencyReportJson } from '../../utils/dependency-report.js';

export type DoctorRunner = (category?: string) => Promise<DependencyReportJson>;

const DOCTOR_TIMEOUT_MS = 30_000;

function isReport(v: unknown): v is DependencyReportJson {
  const r = v as Partial<DependencyReportJson> | null;
  return !!r && Array.isArray(r.tools) && typeof r.summary === 'object' && r.summary !== null;
}

/**
 * Run `doctor --json` out of process. The CLI exits non-zero when a required tool is missing,
 * and still prints the report, so a non-zero exit with parseable stdout is a normal result.
 */
export const defaultDoctorRunner: DoctorRunner = (category) =>
  new Promise((resolve, reject) => {
    const args = [
      ...process.execArgv,
      process.argv[1],
      'doctor',
      '--json',
      ...(category ? ['--category', category] : []),
    ];
    execFile(
      process.execPath,
      args,
      { timeout: DOCTOR_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err && (err as { killed?: boolean }).killed) {
          return reject(new Error(`timed out after ${DOCTOR_TIMEOUT_MS / 1000} s`));
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (isReport(parsed)) return resolve(parsed);
        } catch {
          /* fall through to the error below */
        }
        reject(err ?? new Error('doctor produced no report'));
      }
    );
  });

export function registerDoctorRoutes(app: FastifyInstance, runner: DoctorRunner = defaultDoctorRunner): void {
  // Each run forks a full Node process, so two tabs or a script must not stack them: callers
  // asking for the same category while one is in flight share its promise.
  const inFlight = new Map<string, Promise<DependencyReportJson>>();
  const runShared = (category?: string): Promise<DependencyReportJson> => {
    const key = category ?? '';
    let running = inFlight.get(key);
    if (!running) {
      running = runner(category).finally(() => inFlight.delete(key));
      inFlight.set(key, running);
    }
    return running;
  };
  app.get(
    '/api/doctor',
    async (req: FastifyRequest, reply: FastifyReply): Promise<ApiResponse<DependencyReportJson>> => {
      if (isMultiUserMode() && !isAdmin(req)) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
      }
      const { category } = req.query as { category?: string };
      if (category !== undefined && !(TOOL_CATEGORIES as readonly string[]).includes(category)) {
        reply.code(400);
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          `Unknown category "${category}". Valid categories: ${TOOL_CATEGORIES.join(', ')}`
        );
      }
      try {
        return { success: true, data: await runShared(category) };
      } catch (err) {
        reply.code(500);
        return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, `doctor failed: ${getErrorMessage(err)}`);
      }
    }
  );
}
