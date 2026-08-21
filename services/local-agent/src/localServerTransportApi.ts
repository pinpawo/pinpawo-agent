/**
 * Public adapter for the local-agent wire protocol and its loopback/stdio
 * transports.
 *
 * This is deliberately separate from `host-runtime`: it is one concrete local
 * transport adapter, not part of Host capability assembly and not a
 * transport-independent Studio contract.
 */
export { startLocalServerTransport } from './localServerTransport';
export type {
  LocalServerTransport,
  LocalServerTransportOptions,
} from './localServerTransport';
export {
  attachLocalServerStdioTransport,
  redirectConsoleToStdioDiagnostics,
} from './localServerStdioTransport';
export type {
  LocalServerStdioTransport,
  LocalServerStdioTransportOptions,
} from './localServerStdioTransport';
export type {
  LocalServerLogError,
  LocalServerLogWarn,
  LocalServerPeerHandlers,
  LocalServerTransportHandlers,
} from './localServerMessageDispatcher';
export type { LocalServerPeer } from './localServerPeer';
export { sendLocalServerPeerEvent } from './localServerPeer';
export type {
  LocalAgentServerMessage,
  StudioRequestMessage,
} from './localAgentProtocol';
