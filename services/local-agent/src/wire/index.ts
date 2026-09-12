/**
 * Public loopback/stdio framing primitives plus the Chat Host adapter.
 *
 * This is deliberately separate from `host-runtime`: it is one concrete local
 * transport adapter, not part of Host capability assembly and not a
 * transport-independent Studio contract.
 */
export {
  startLocalServerTransport,
  startLocalServerWireTransport,
} from './transport';
export type {
  ServerTransport,
  ServerTransportOptions,
} from './transport';
export {
  attachLocalServerStdioTransport,
  attachLocalServerWireStdioTransport,
  redirectConsoleToStdioDiagnostics,
} from './stdioTransport';
export type {
  ServerStdioTransport,
  ServerWireStdioTransport,
  ServerStdioTransportOptions,
} from './stdioTransport';
export type {
  ServerWireHandlers,
  ServerWireLogError,
  ServerWireLogWarn,
  ServerWirePeer,
} from './framing';
export type {
  ServerLogError,
  ServerLogWarn,
  LocalServerPeerHandlers,
  ServerTransportHandlers,
} from './messageDispatcher';
export type { ServerPeer } from './peer';
export { sendLocalServerPeerEvent } from './peer';
export type { LocalAgentServerMessage } from './protocol';
export {
  ensureLocalServerAuthToken,
  readLocalServerAuthToken,
} from './auth';
export {
  readResidentPetIdFromAgentSessionPath,
  RESIDENT_PET_AGENT_SESSION_ROUTE_PREFIX,
  startResidentPetAgentSessionTransport,
} from './agentSessionRoute';
export type {
  ResidentPetAgentSessionTransportOptions,
} from './agentSessionRoute';
