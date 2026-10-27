/** Accept empty, untyped API POSTs even when a reverse proxy frames them as chunked. */
import { errorCodes, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';

export function installEmptyApiPostParser(app: FastifyInstance): void {
  // Existing JSON, text and multipart parsers take precedence. The webview
  // proxy installs its own parser in an encapsulated scope.
  app.addContentTypeParser('*', async (req: FastifyRequest, payload: Readable) => {
    // Fastify normally skips an unsupported parser on its 404 path. Preserve
    // that behavior, including the unread stream used by referer fallbacks.
    if (req.is404) return undefined;

    if (
      req.method !== 'POST' ||
      !req.routeOptions.url?.startsWith('/api/') ||
      req.headers['content-type'] !== undefined ||
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
    ) {
      throw new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE();
    }

    // Wait for the terminating chunk to prove the body is empty. Reject on the
    // first byte instead of buffering an unsupported body. Leave the socket
    // alive so Fastify can send its 415 and close the connection on parser errors.
    try {
      for await (const chunk of payload.iterator({ destroyOnReturn: false })) {
        if (Buffer.byteLength(chunk) > 0) throw new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE();
      }
    } catch (error) {
      // Match Fastify's body reader: an interrupted request is a client error.
      const err = error as Error & { statusCode?: number };
      if (typeof err.statusCode !== 'number' || err.statusCode < 400) err.statusCode = 400;
      throw err;
    }

    // No synthetic JSON or header rewriting: required-body validation still
    // sees the same undefined value as a direct Content-Length: 0 request.
    return undefined;
  });
}
