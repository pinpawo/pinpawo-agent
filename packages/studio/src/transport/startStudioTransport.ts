import {
  attachLocalServerWireStdioTransport,
  startLocalServerWireTransport,
  type LocalServerStdioTransportOptions,
  type LocalServerTransportOptions,
  type LocalServerWirePeer,
} from 'pinpawo/local-server-transport';
import type { Studio } from '../studioContract';
import {
  createStudioWireHandlers,
  StudioRequestHandler,
} from './StudioRequestHandler';
import type { StudioServerMessage } from './studioProtocol';

export type StudioTransportInput = {
  studio: Studio;
};

function composeStudioTransport(input: StudioTransportInput) {
  const handler = new StudioRequestHandler<LocalServerWirePeer<StudioServerMessage>>({
    studio: input.studio,
    outbound: {
      send: (peer, message) => peer.send(message),
    },
  });
  return {
    handler,
    peerHandlers: createStudioWireHandlers(handler),
  };
}

export async function startStudioWebSocketTransport(
  port: number,
  input: StudioTransportInput,
  options: Omit<LocalServerTransportOptions, 'closeHandlers'> = {},
) {
  const composed = composeStudioTransport(input);
  return startLocalServerWireTransport(port, composed.peerHandlers, {
    ...options,
    closeHandlers: () => composed.handler.close(),
  });
}

export function startStudioStdioTransport(
  input: StudioTransportInput,
  options: LocalServerStdioTransportOptions = {},
) {
  const composed = composeStudioTransport(input);
  const transport = attachLocalServerWireStdioTransport(composed.peerHandlers, options);
  return {
    ...transport,
    closed: transport.closed.finally(() => composed.handler.close()),
  };
}
