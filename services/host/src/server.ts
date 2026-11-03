/**
 * Local HTTP/WebSocket server for TUI ↔ run process communication.
 */
import { ensureWireAuthToken } from './wire/auth';
import {
  createChatHostHandlers,
  type ServerHandlerOptions,
} from './serverHandlers';
import { createChatHostDepsStore, type ServerDeps } from './serverTypes';
import { createHostArtifactStore } from './artifactStoreFactory';
import { handleAgentSessionHttp } from './wire/agentSessionHttp';
import {
  startHostTransport,
  type ServerTransport,
} from './wire/transport';

export type { ServerDeps };

export type ServerOptions = {
  authToken?: string;
  handlerOptions?: ServerHandlerOptions;
};

export { startHostTransport } from './wire/transport';
export type {
  ServerTransport,
  ServerTransportOptions,
} from './wire/transport';

export async function startHostServer(
  port: number,
  deps: ServerDeps,
  options: ServerOptions = {},
): Promise<ServerTransport> {
  const authToken = options.authToken ?? ensureWireAuthToken();
  const artifactStore = createHostArtifactStore(deps.runtimeConfig);
  const handlers = createChatHostHandlers(createChatHostDepsStore(deps), options.handlerOptions ?? {});
  return startHostTransport(port, handlers.peerHandlers, {
    authToken,
    handleHttpRequest: (req, res) => {
      if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/agent-session/artifacts') {
        void handleAgentSessionHttp(req, res, new Map(), authToken, uri => artifactStore.fetch(uri)).catch(() => {
          if (res.headersSent) { res.destroy(); return; }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Artifact request failed' }));
        });
        return;
      }
      if (handlers.handleHttpRequest(req, res, authToken)) return;
      res.writeHead(404);
      res.end();
    },
    closeHandlers: handlers.close,
  });
}
