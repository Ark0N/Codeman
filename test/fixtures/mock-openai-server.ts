/**
 * @fileoverview In-process fake OpenAI/Anthropic-compatible HTTP server for the
 * Custom Model Endpoint Profiles contract tests (deployment_plan.md chunk 7).
 *
 * No external deps — plain `node:http`. Captures every request it receives
 * (method, path, headers, parsed JSON body) so a test can assert the injected
 * base URL / API key / model actually reached the right place, with the right
 * auth header, in the shape a real llama.cpp/Azure/etc. endpoint would see it.
 *
 * Serves the request shapes this feature's recipes produce: OpenAI-style
 * `POST /v1/chat/completions` (opencode/pi/grok/omp/gemini's compat
 * endpoint), Anthropic-style `POST /v1/messages` (claude's ANTHROPIC_BASE_URL
 * traffic), OpenAI's newer `POST /v1/responses` (codex's actual wire protocol
 * as of Feb 2026 — it dropped chat-completions support), plus `GET /v1/models`
 * for the discovery route's own tests.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MockOpenAiServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

/** Starts the mock server on a random free port and resolves once it's listening. */
export async function startMockOpenAiServer(): Promise<MockOpenAiServer> {
  const requests: CapturedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readJsonBody(req);
      const path = (req.url ?? '').split('?')[0];
      requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });

      res.setHeader('content-type', 'application/json');

      if (path === '/v1/models' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ data: [{ id: 'qwen3' }, { id: 'llama3' }] }));
        return;
      }

      if (path === '/v1/chat/completions' && req.method === 'POST') {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            id: 'mock-completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' } }],
          })
        );
        return;
      }

      if (path === '/v1/messages' && req.method === 'POST') {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            id: 'mock-message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello world' }],
          })
        );
        return;
      }

      // Codex's real wire protocol (verified against a live binary: it dropped
      // wire_api="chat" support in Feb 2026, so its config.toml always says
      // wire_api="responses") — a different shape from OpenAI's chat-completions.
      if (path === '/v1/responses' && req.method === 'POST') {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            id: 'mock-response',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello world' }] }],
          })
        );
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found in mock server', path }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
