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
  payload: unknown
) => Promise<{ status: number; error?: string }>;

/** POST JSON to the Codeman API with the same credentials `codeman attach` uses. Status 0 means no answer. */
export const postJson: JsonPost = (apiUrl, apiPath, payload) => {
  const { username, password } = readCodemanCredentials();
  const url = new URL(apiPath, apiUrl);
  const body = JSON.stringify(payload);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
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
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let error: string | undefined;
          try {
            error = (JSON.parse(text) as { error?: string }).error;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, error });
        });
      }
    );
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
  const { status, error } = await post(
    apiUrl,
    `/api/sessions/${encodeURIComponent(sessionId)}/discord-notify`,
    payload
  );
  if (status >= 200 && status < 300) return { code: 0, out: 'Posted to Discord' };
  // The bridge being off is not a failure: the caller just says it in the terminal.
  if (status === 409) return { code: 0, out: 'The Discord bridge is off. Say it in the terminal instead.' };
  if (status === 429)
    return { code: 1, err: 'Too many messages to Discord from this tab. Wait a minute, then send one.' };
  return { code: 1, err: `Could not post to Discord${error ? `: ${error}` : status ? ` (HTTP ${status})` : ''}` };
}
