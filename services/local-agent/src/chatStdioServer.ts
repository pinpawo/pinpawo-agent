/** Chat handler composition for the shared local-agent stdio adapter. */
import { createLocalServerHandlers } from './localServerHandlers';
import {
  attachLocalServerStdioTransport,
  type LocalServerStdioTransportOptions,
} from './localServerStdioTransport';
import type { LocalServerDeps } from './localServerTypes';

export function startLocalStdioServer(
  deps: LocalServerDeps,
  options: LocalServerStdioTransportOptions = {},
) {
  const handlers = createLocalServerHandlers(deps);
  const transport = attachLocalServerStdioTransport(handlers.peerHandlers, options);
  return {
    ...transport,
    closed: transport.closed.finally(handlers.close),
  };
}
