import { WebServer } from '../../src/web/server.js';

let servers: Map<number, WebServer> = new Map();

export async function createTestServer(port: number): Promise<WebServer> {
  if (servers.has(port)) {
    return servers.get(port)!;
  }
  const server = new WebServer(port, false, true); // testMode = true
  await server.start();
  servers.set(port, server);
  return server;
}

export async function stopTestServer(server: WebServer): Promise<void> {
  await server.stop();
  for (const [port, s] of servers) {
    if (s === server) {
      servers.delete(port);
      break;
    }
  }
}

export async function stopAllTestServers(): Promise<void> {
  for (const server of servers.values()) {
    await server.stop();
  }
  servers.clear();
}
