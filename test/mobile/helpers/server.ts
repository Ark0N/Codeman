import { WebServer } from '../../../src/web/server.js';

/** A test server on an ephemeral port; read the port from `server.boundPort` once this resolves. */
export async function createTestServer(): Promise<WebServer> {
  const server = new WebServer(0, false, true); // testMode = true
  await server.start();
  return server;
}

export async function stopTestServer(server: WebServer): Promise<void> {
  await server.stop();
}

