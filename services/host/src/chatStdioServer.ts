/** Chat handler composition for the shared host stdio adapter. */
import { createChatHostHandlers } from './serverHandlers';
import {
  attachHostStdioTransport,
  type ServerStdioTransportOptions,
} from './wire/stdioTransport';
import { createChatHostDepsStore, type ServerDeps } from './serverTypes';

export function startLocalStdioServer(
  deps: ServerDeps,
  options: ServerStdioTransportOptions = {},
) {
  const handlers = createChatHostHandlers(createChatHostDepsStore(deps));
  const transport = attachHostStdioTransport(handlers.peerHandlers, options);
  return {
    ...transport,
    closed: transport.closed.finally(handlers.close),
  };
}
