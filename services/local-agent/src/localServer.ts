/**
 * Local HTTP/WebSocket server for TUI ↔ run process communication.
 */
import { ensureLocalServerAuthToken } from './localServerAuth';
import {
  createLocalServerHandlers,
  type LocalServerHandlerOptions,
} from './localServerHandlers';
import { createLocalServerRuntimeDepsStore, type LocalServerDeps } from './localServerTypes';
import {
  startLocalServerTransport,
  type LocalServerTransport,
} from './localServerTransport';

export type { LocalServerDeps };

export type LocalServerOptions = {
  authToken?: string;
  handlerOptions?: LocalServerHandlerOptions;
};

export { startLocalServerTransport } from './localServerTransport';
export type {
  LocalServerTransport,
  LocalServerTransportOptions,
} from './localServerTransport';

export async function startLocalServer(
  port: number,
  deps: LocalServerDeps,
  options: LocalServerOptions = {},
): Promise<LocalServerTransport> {
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
