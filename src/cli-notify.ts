/**
 * @fileoverview `codeman notify`: post to this tab's Discord thread (POST /api/sessions/:id/discord-notify).
 *
 * A CLI that is blocked on something only the user can do (a physical step, a blocker, a timed-out
 * wait) runs this. It reads CODEMAN_SESSION_ID and CODEMAN_API_URL, which Codeman sets in every
 * session, and the shared credentials, so the caller handles no auth. `runNotify` returns what to
 * print and the exit code instead of exiting, so a test can drive it.
 *
 * @module cli-notify
 */

import http from 'node:http';
import https from 'node:https';
import { isAbsolute, join } from 'node:path';
import { readCodemanCredentials } from './codeman-credentials.js';

const REQUEST_TIMEOUT_MS = 30_000;

export interface NotifyOptions {
  message: string;
  urgent?: boolean;
  file?: string;
  session?: string;
  url?: string;
}

export interface NotifyResult {
  code: number;
  out?: string;
  err?: string;
}

export type JsonPost = (
  apiUrl: string,
  apiPath: string,
  payload: unknown,
  timeoutMs?: number
) => Promise<{ status: number; error?: string; delivery?: { ok: boolean; error?: string } }>;

/** POST JSON to the Codeman API with the same credentials `codeman attach` uses. Status 0 means no answer. */
export const postJson: JsonPost = (apiUrl, apiPath, payload, timeoutMs = REQUEST_TIMEOUT_MS) => {
  const { username, password } = readCodemanCredentials();
  const url = new URL(apiPath, apiUrl);
  const body = JSON.stringify(payload);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolveOnce) => {
    // Settle once: a response that stalls after its headers ends in 'close' without 'end'.
    let settled = false;
    const resolve: typeof resolveOnce = (v) => {
      if (settled) return;
      settled = true;
      resolveOnce(v);
    };
    const headers: Record<string, string | number> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized: false,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('error', () => resolve({ status: 0 }));
        res.on('close', () => resolve({ status: 0 }));
        res.on('end', () => {
          let error: string | undefined;
          let delivery: { ok: boolean; error?: string } | undefined;
          try {
            const body = JSON.parse(text) as { error?: string; data?: { ok?: unknown; error?: string } };
            error = body.error;
            // A 200 only says Codeman took the request; `data.ok` says whether Discord took the post.
            if (typeof body.data?.ok === 'boolean') delivery = { ok: body.data.ok, error: body.data.error };
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, error, delivery });
        });
      }
    );
    // A server that takes the connection and never answers must not hang the agent: status 0 is "no answer".
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0 }));
    req.write(body);
    req.end();
  });
};

export async function runNotify(
  opts: NotifyOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
  post: JsonPost = postJson
): Promise<NotifyResult> {
  const sessionId = opts.session || env.CODEMAN_SESSION_ID;
  const apiUrl = opts.url || env.CODEMAN_API_URL;
  if (!sessionId || !apiUrl) {
    return { code: 1, err: 'notify must run inside a Codeman session (CODEMAN_SESSION_ID and CODEMAN_API_URL)' };
  }
  const payload: { message: string; urgent?: boolean; file?: string } = { message: opts.message };
  if (opts.urgent) payload.urgent = true;
  if (opts.file) payload.file = isAbsolute(opts.file) ? opts.file : join(cwd, opts.file);
  const { status, error, delivery } = await post(
    apiUrl,
    `/api/sessions/${encodeURIComponent(sessionId)}/discord-notify`,
    payload
  );
  if (status >= 200 && status < 300) {
    if (delivery?.ok === false) {
      return { code: 1, err: `Could not post to Discord${delivery.error ? `: ${delivery.error}` : ''}` };
    }
    return { code: 0, out: 'Posted to Discord' };
  }
  // The bridge being off is not a failure: the caller just says it in the terminal.
  if (status === 409) return { code: 0, out: 'The Discord bridge is off. Say it in the terminal instead.' };
  if (status === 429)
    return { code: 1, err: 'Too many messages to Discord from this tab. Wait a minute, then send one.' };
  return { code: 1, err: `Could not post to Discord${error ? `: ${error}` : status ? ` (HTTP ${status})` : ''}` };
}
