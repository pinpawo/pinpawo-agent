/**
 * Local HTTP/WebSocket server for TUI ↔ run process communication.
 */
import { createServer } from 'node:http';
import { ensureLocalServerAuthToken } from './localServerAuth';
import { createLocalServerHandlers } from './localServerHandlers';
import type { LocalServerDeps } from './localServerTypes';
import { attachLocalServerWebSocketTransport } from './localServerWsTransport';

export type { LocalServerDeps };

export function startLocalServer(port: number, deps: LocalServerDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const handlers = createLocalServerHandlers(deps);
    const authToken = ensureLocalServerAuthToken();
    const server = createServer((req, res) => {
      if (handlers.handleHttpRequest(req, res, authToken)) {
        return;
      }
      res.writeHead(404);
      res.end();
    });

    attachLocalServerWebSocketTransport(server, handlers.peerHandlers, {
      authToken,
      port,
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[local-server] listening on ws://127.0.0.1:${port}`);
      console.log('[local-server] local HTTP/WS auth enabled');
      resolve();
    });

    server.on('error', reject);
  });
}
