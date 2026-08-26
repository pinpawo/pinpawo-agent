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
} from './localServerTransport';
export type {
  LocalServerTransport,
  LocalServerTransportOptions,
} from './localServerTransport';
export {
  attachLocalServerStdioTransport,
  attachLocalServerWireStdioTransport,
  redirectConsoleToStdioDiagnostics,
} from './localServerStdioTransport';
export type {
  LocalServerStdioTransport,
  LocalServerWireStdioTransport,
  LocalServerStdioTransportOptions,
} from './localServerStdioTransport';
export type {
  LocalServerWireHandlers,
  LocalServerWireLogError,
  LocalServerWireLogWarn,
  LocalServerWirePeer,
} from './localServerWire';
export type {
  LocalServerLogError,
  LocalServerLogWarn,
  LocalServerPeerHandlers,
  LocalServerTransportHandlers,
} from './localServerMessageDispatcher';
export type { LocalServerPeer } from './localServerPeer';
export { sendLocalServerPeerEvent } from './localServerPeer';
export type { LocalAgentServerMessage } from './localAgentProtocol';
export {
  ensureLocalServerAuthToken,
  readLocalServerAuthToken,
} from './localServerAuth';
export {
  readResidentPetIdFromAgentSessionPath,
  RESIDENT_PET_AGENT_SESSION_ROUTE_PREFIX,
  startResidentPetAgentSessionTransport,
} from './residentPetAgentSessionTransport';
export type {
  ResidentPetAgentSessionTransportOptions,
} from './residentPetAgentSessionTransport';
