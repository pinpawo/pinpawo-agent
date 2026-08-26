import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import {
  buildAgentEventEnvelope,
  parseAgentClientMessage,
  readAgentClientMessageEnvelope,
} from '@pinpawo/agent-session';
import { WebSocket, WebSocketServer } from 'ws';

import { ensureLocalServerAuthToken } from './localServerAuth';
import {
  isAllowedLocalServerOrigin,
  isAuthorizedLocalServerRequest,
} from './localServerAuth';
import type { LocalServerTransport } from './localServerTransport';
import type {
  AgentSessionPeer,
  ResidentPetInteraction,
} from './residentPetHost';

export const RESIDENT_PET_AGENT_SESSION_ROUTE_PREFIX = '/agent-session/pets/';

export function readResidentPetIdFromAgentSessionPath(url: string | undefined): string | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(RESIDENT_PET_AGENT_SESSION_ROUTE_PREFIX)) return null;
  const encoded = pathname.slice(RESIDENT_PET_AGENT_SESSION_ROUTE_PREFIX.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    const petId = decodeURIComponent(encoded);
    return petId.trim() && !petId.includes('/') ? petId : null;
  } catch {
    return null;
  }
}

function rejectUpgrade(
  socket: import('node:stream').Duplex,
  status: 401 | 403 | 404 | 503,
  reason: string,
) {
  socket.write(`HTTP/1.1 ${status.toString()} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function createPeer(ws: WebSocket): AgentSessionPeer {
  return {
    isConnected: () => ws.readyState === WebSocket.OPEN,
    send: (message) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(message));
      return true;
    },
  };
}

function attachConnection(
  wss: WebSocketServer,
  interactions: ReadonlyMap<string, ResidentPetInteraction>,
  logError: (message: string, error: unknown) => void,
) {
  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const petId = readResidentPetIdFromAgentSessionPath(request.url);
    const interaction = petId ? interactions.get(petId) : undefined;
    if (!interaction) {
      ws.close(1008, 'Unknown resident Pet');
      return;
    }
    const peer = createPeer(ws);
    const connected = Promise.resolve(interaction.connect(peer));
    ws.on('message', (data) => {
      void connected.then(async () => {
        const raw = data.toString();
        const message = parseAgentClientMessage(raw);
        if (!message) {
          const envelope = readAgentClientMessageEnvelope(raw);
          if (envelope?.requestId) {
            peer.send(buildAgentEventEnvelope({
              type: 'error',
              requestId: envelope.requestId,
              message: 'Agent Session client message is invalid or incompatible.',
            }));
          }
          return;
        }
        await interaction.handle(peer, message);
      }).catch((error) => {
        logError(`[agent-session] Pet "${petId}" message failed:`, error);
      });
    });
    ws.on('close', () => {
      void connected.then(() => interaction.disconnect(peer)).catch((error) => {
          logError(`[agent-session] Pet "${petId}" disconnect failed:`, error);
      });
    });
    void connected.catch((error) => {
      logError(`[agent-session] Pet "${petId}" connection failed:`, error);
      ws.close(1011, 'Resident Pet interaction failed');
    });
  });
}

export type ResidentPetAgentSessionTransportOptions = {
  authToken?: string;
  log?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
};

/** Start the local-agent Agent Session listener for a Host-owned Pet registry. */
export async function startResidentPetAgentSessionTransport(
  port: number,
  interactions: ReadonlyMap<string, ResidentPetInteraction>,
  options: ResidentPetAgentSessionTransportOptions = {},
): Promise<LocalServerTransport> {
  const authToken = options.authToken ?? ensureLocalServerAuthToken();
  const log = options.log ?? console.log;
  const logError = options.logError ?? ((message, error) => {
    console.error(message, error instanceof Error ? error.message : error);
  });
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  attachConnection(wss, interactions, logError);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Agent Session listener did not expose a TCP address.');
  }

  server.on('upgrade', (request, socket, head) => {
    const petId = readResidentPetIdFromAgentSessionPath(request.url);
    if (!petId || !interactions.has(petId)) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!isAllowedLocalServerOrigin(request, address.port)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (!isAuthorizedLocalServerRequest(request, authToken)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  log(`[agent-session] listening on ws://127.0.0.1:${address.port}${RESIDENT_PET_AGENT_SESSION_ROUTE_PREFIX}:petId`);
  let closeRequested = false;
  let requestClose!: () => void;
  const closeSignal = new Promise<void>((resolve) => {
    requestClose = resolve;
  });
  const closed = closeSignal.then(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => error ? reject(error) : resolve());
    });
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  return {
    port: address.port,
    close: () => {
      if (closeRequested) return;
      closeRequested = true;
      requestClose();
    },
    closed,
  };
}
