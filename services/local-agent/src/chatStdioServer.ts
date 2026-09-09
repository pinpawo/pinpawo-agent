/** Chat handler composition for the shared local-agent stdio adapter. */
import { createLocalServerHandlers } from './serverHandlers';
import {
  attachLocalServerStdioTransport,
  type ServerStdioTransportOptions,
} from './wire/localServerStdioTransport';
import { createLocalServerRuntimeDepsStore, type ServerDeps } from './serverTypes';

export function startLocalStdioServer(
  deps: ServerDeps,
  options: ServerStdioTransportOptions = {},
) {
  const handlers = createLocalServerHandlers(createLocalServerRuntimeDepsStore(deps));
  const transport = attachLocalServerStdioTransport(handlers.peerHandlers, options);
  return {
    ...transport,
    closed: transport.closed.finally(handlers.close),
  };
}
