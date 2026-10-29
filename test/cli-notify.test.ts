// @vitest-environment node
/**
 * @fileoverview `codeman notify`: what it sends, what it prints and the exit code, driven with a
 * recording fake transport plus the real `postJson` against a local server. Port: ephemeral 127.0.0.1.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postJson, runNotify, type JsonPost } from '../src/cli-notify.js';

const ENV = { CODEMAN_SESSION_ID: 'abc12345-full-id', CODEMAN_API_URL: 'http://127.0.0.1:3000' };

function fake(status: number, error?: string, delivery?: { ok: boolean; error?: string }) {
  const post = vi.fn<JsonPost>(async () => ({ status, error, delivery }));
  return post;
}

describe('runNotify', () => {
  it('refuses outside a Codeman session, before any request', async () => {
    const post = fake(200);
    const r = await runNotify({ message: 'hi' }, {}, '/work', post);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/inside a Codeman session/);
    expect(post).not.toHaveBeenCalled();
  });

  it('posts the message to this session with the session id URL-encoded', async () => {
    const post = fake(200);
    const r = await runNotify({ message: 'press the reset button' }, ENV, '/work', post);
    expect(r).toEqual({ code: 0, out: 'Posted to Discord' });
    expect(post).toHaveBeenCalledWith('http://127.0.0.1:3000', '/api/sessions/abc12345-full-id/discord-notify', {
      message: 'press the reset button',
    });
  });

  it('adds urgent, and turns a relative --file into an absolute path under the working folder', async () => {
    const post = fake(200);
    await runNotify({ message: 'log', urgent: true, file: 'out/run.log' }, ENV, '/work', post);
    expect(post.mock.calls[0][2]).toEqual({ message: 'log', urgent: true, file: '/work/out/run.log' });
    await runNotify({ message: 'log', file: '/abs/run.log' }, ENV, '/work', post);
    expect(post.mock.calls[1][2]).toEqual({ message: 'log', file: '/abs/run.log' });
  });

  it('lets --session and --url override the environment', async () => {
    const post = fake(200);
    await runNotify({ message: 'x', session: 'other', url: 'http://h:1' }, ENV, '/work', post);
    expect(post.mock.calls[0].slice(0, 2)).toEqual(['http://h:1', '/api/sessions/other/discord-notify']);
  });

  it('exits 1 when Codeman answered 200 but Discord refused the post, so a blocked agent knows nobody was told', async () => {
    const r = await runNotify(
      { message: 'x' },
      ENV,
      '/w',
      fake(200, undefined, { ok: false, error: 'The bot token was refused' })
    );
    expect(r).toEqual({ code: 1, err: 'Could not post to Discord: The bot token was refused' });
    expect((await runNotify({ message: 'x' }, ENV, '/w', fake(200, undefined, { ok: true }))).code).toBe(0);
  });

  it('treats a disabled bridge (409) as success that says so', async () => {
    const r = await runNotify({ message: 'x' }, ENV, '/work', fake(409));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/bridge is off/);
  });

  it('fails with the server error, or the status, or a plain message when nothing answered', async () => {
    expect(
      (await runNotify({ message: 'x' }, ENV, '/w', fake(400, 'The file must be inside the session folder'))).err
    ).toBe('Could not post to Discord: The file must be inside the session folder');
    expect((await runNotify({ message: 'x' }, ENV, '/w', fake(429))).err).toMatch(/Too many messages/);
    expect((await runNotify({ message: 'x' }, ENV, '/w', fake(500))).err).toBe('Could not post to Discord (HTTP 500)');
    expect((await runNotify({ message: 'x' }, ENV, '/w', fake(0))).err).toBe('Could not post to Discord');
  });
});

describe('postJson (real transport)', () => {
  let server: Server;
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function serve(status: number, reply: unknown) {
    const seen: { method?: string; url?: string; body: string; type?: string } = { body: '' };
    server = createServer((req, res) => {
      req.on('data', (c) => (seen.body += c));
      req.on('end', () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.type = req.headers['content-type'];
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it('sends a JSON POST and reports the status and the server error text', async () => {
    const { seen, url } = await serve(400, { success: false, error: 'nope' });
    expect(await postJson(url, '/api/sessions/s1/discord-notify', { message: 'hi' })).toEqual({
      status: 400,
      error: 'nope',
    });
    expect(seen).toMatchObject({ method: 'POST', url: '/api/sessions/s1/discord-notify', type: 'application/json' });
    expect(JSON.parse(seen.body)).toEqual({ message: 'hi' });
  });

  it('answers status 0 when nothing is listening', async () => {
    const { url } = await serve(200, {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect((await postJson(url, '/x', {})).status).toBe(0);
    server = createServer().listen(0); // so afterEach has something to close
  });
});
