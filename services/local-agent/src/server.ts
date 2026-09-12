/**
 * Local HTTP/WebSocket server for TUI ↔ run process communication.
 */
import { ensureLocalServerAuthToken } from './wire/auth';
import {
  createLocalServerHandlers,
  type ServerHandlerOptions,
} from './serverHandlers';
import { createLocalServerRuntimeDepsStore, type ServerDeps } from './serverTypes';
import {
  startLocalServerTransport,
  type ServerTransport,
} from './wire/transport';

export type { ServerDeps };

export type ServerOptions = {
  authToken?: string;
  handlerOptions?: ServerHandlerOptions;
};

export { startLocalServerTransport } from './wire/transport';
export type {
  ServerTransport,
  ServerTransportOptions,
} from './wire/transport';

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
