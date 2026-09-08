/**
 * Local HTTP/WebSocket server for TUI ↔ run process communication.
 */
import { ensureLocalServerAuthToken } from './localServerAuth';
import {
  createLocalServerHandlers,
  type ServerHandlerOptions,
} from './serverHandlers';
import { createLocalServerRuntimeDepsStore, type ServerDeps } from './serverTypes';
import {
  startLocalServerTransport,
  type ServerTransport,
} from './localServerTransport';

export type { ServerDeps };

export type ServerOptions = {
  authToken?: string;
  handlerOptions?: ServerHandlerOptions;
};

export { startLocalServerTransport } from './localServerTransport';
export type {
  ServerTransport,
  ServerTransportOptions,
} from './localServerTransport';

export async function startLocalServer(
  port: number,
  deps: ServerDeps,
  options: ServerOptions = {},
): Promise<ServerTransport> {
  const authToken = options.authToken ?? ensureLocalServerAuthToken();
  const handlers = createLocalServerHandlers(createLocalServerRuntimeDepsStore(deps), options.handlerOptions ?? {});
  return startLocalServerTransport(port, handlers.peerHandlers, {
    authToken,
    handleHttpRequest: (req, res) => {
      if (handlers.handleHttpRequest(req, res, authToken)) return;
      res.writeHead(404);
      res.end();
    },
    closeHandlers: handlers.close,
  });
}
