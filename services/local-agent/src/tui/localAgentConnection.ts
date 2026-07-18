import type {
  LocalAgentClientMessage,
  LocalAgentServerMessage,
} from '../localAgentProtocol';

export type LocalAgentConnectionHandlers = {
  onOpen: () => void;
  onMessage: (message: LocalAgentServerMessage) => void;
  onClose: () => void;
  onError: (error: Error) => void;
};

export type LocalAgentConnection = {
  connect: () => void;
  disconnect: () => void;
  isConnected: () => boolean;
  /** True while the transport owns either a connecting or connected handle. */
  hasConnection: () => boolean;
  /** True when the current transport accepted the message for sending. */
  send: (message: LocalAgentClientMessage) => boolean;
};

/** Creates a dormant connection; lifecycle events start after connect() is called. */
export type LocalAgentConnectionFactory = (
  handlers: LocalAgentConnectionHandlers,
) => LocalAgentConnection;
