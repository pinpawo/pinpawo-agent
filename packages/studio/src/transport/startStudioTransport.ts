import {
  attachLocalServerStdioTransport,
  sendLocalServerPeerEvent,
  startLocalServerTransport,
  type LocalServerPeer,
  type LocalServerStdioTransportOptions,
  type LocalServerTransportOptions,
} from 'pinpawo/local-server-transport';
import type { Studio } from '../studioContract';
import {
  createStudioPeerHandlers,
  StudioRequestHandler,
} from './StudioRequestHandler';

export type StudioTransportInput = {
  studio: Studio;
  workdir: string;
};

function composeStudioTransport(input: StudioTransportInput) {
  const handler = new StudioRequestHandler<LocalServerPeer>({
    studio: input.studio,
    workdir: input.workdir,
    outbound: {
      sendMessage: (peer, message) => peer.send(message),
      sendEvent: (peer, event) => sendLocalServerPeerEvent(peer, event),
    },
  });
  return {
    handler,
    peerHandlers: createStudioPeerHandlers(handler),
  };
}

export async function startStudioWebSocketTransport(
  port: number,
  input: StudioTransportInput,
  options: Omit<LocalServerTransportOptions, 'closeHandlers'> = {},
) {
  const composed = composeStudioTransport(input);
  return startLocalServerTransport(port, composed.peerHandlers, {
    ...options,
    closeHandlers: () => composed.handler.close(),
  });
}

export function startStudioStdioTransport(
  input: StudioTransportInput,
  options: LocalServerStdioTransportOptions = {},
) {
  const composed = composeStudioTransport(input);
  const transport = attachLocalServerStdioTransport(composed.peerHandlers, options);
  return {
    ...transport,
    closed: transport.closed.finally(() => composed.handler.close()),
  };
}
