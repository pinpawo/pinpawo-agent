/**
 * The terminal client's transport-neutral contract with a local agent Host.
 *
 * The TUI session layer only knows this shape, so one Host conversation can be
 * carried by either transport:
 *
 * - `LocalHostConnection` dials the authenticated loopback WebSocket of a Host
 *   that may already be running;
 * - `EmbeddedHostConnection` starts the Host as a stdio child process of the
 *   terminal UI.
 *
 * Keep this file free of transport details: no socket ready states, close
 * codes, or process handles belong here.
 */
import type {
  AgentClientMessage,
  AgentServerMessage,
} from '@pinpawo/agent-session';

export type AgentHostConnectionHandlers = {
  onOpen: () => void;
  onMessage: (message: AgentServerMessage) => void;
  onClose: () => void;
  onError: (error: Error) => void;
};

export type AgentHostConnection = {
  connect: () => void;
  disconnect: () => void;
  send: (message: AgentClientMessage) => boolean;
  isConnected: () => boolean;
};

export type AgentHostConnectionFactory = (
  handlers: AgentHostConnectionHandlers,
) => AgentHostConnection;
