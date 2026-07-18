import {
  parseLocalAgentClientMessage,
  readLocalAgentClientMessageEnvelope,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type NewSessionMessage,
  type ReviewCancelMessage,
  type RunInterruptMessage,
  type RuntimeConfigUpdateMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';
import { sendLocalServerPeerEvent, type LocalServerPeer } from './localServerPeer';

type MaybePromise<T> = T | Promise<T>;
export type LocalServerLogError = (message: string, error: unknown) => void;
export type LocalServerLogWarn = (message: string) => void;

export type LocalServerPeerHandlers = {
  onChatRequest: (peer: LocalServerPeer, message: ChatRequestMessage) => MaybePromise<void>;
  onStudioRequest: (peer: LocalServerPeer, message: StudioRequestMessage) => MaybePromise<void>;
  onHumanReviewResponse: (
    peer: LocalServerPeer,
    message: HumanReviewResponseMessage,
  ) => MaybePromise<void>;
  onReviewCancel: (peer: LocalServerPeer, message: ReviewCancelMessage) => MaybePromise<void>;
  onRunInterrupt: (peer: LocalServerPeer, message: RunInterruptMessage) => MaybePromise<void>;
  onNewSession: (peer: LocalServerPeer, message: NewSessionMessage) => MaybePromise<void>;
  onRuntimeConfigUpdate: (
    peer: LocalServerPeer,
    message: RuntimeConfigUpdateMessage,
  ) => MaybePromise<void>;
  onClose: (peer: LocalServerPeer) => MaybePromise<void>;
  log?: (message: string) => void;
  logError?: LocalServerLogError;
  logWarn?: LocalServerLogWarn;
};

export function defaultLocalServerLogError(message: string, error: unknown) {
  console.error(message, error instanceof Error ? error.message : error);
}

export function defaultLocalServerLogWarn(message: string) {
  console.warn(message);
}

function formatMalformedClientMessage(prefix: string, data: Buffer | string) {
  const envelope = readLocalAgentClientMessageEnvelope(data);
  return `${prefix} ignored malformed client message `
    + `type=${envelope?.type ?? 'unknown'} requestId=${envelope?.requestId ?? 'unknown'}`;
}

function sendMalformedClientMessageError(peer: LocalServerPeer, data: Buffer | string) {
  const envelope = readLocalAgentClientMessageEnvelope(data);
  if (!envelope?.requestId) {
    return;
  }
  sendLocalServerPeerEvent(peer, {
    type: 'error',
    requestId: envelope.requestId,
    message: '客户端消息协议不兼容或格式无效，请升级客户端后重试。',
  });
}

export function runLocalServerPeerHandler(
  name: string,
  handler: () => MaybePromise<void>,
  logError: LocalServerLogError,
) {
  Promise.resolve()
    .then(handler)
    .catch((err) => {
      logError(`[local-server] ${name} error:`, err);
    });
}

export function dispatchLocalServerMessage(
  peer: LocalServerPeer,
  data: Buffer | string,
  handlers: LocalServerPeerHandlers,
  logError: LocalServerLogError = handlers.logError ?? defaultLocalServerLogError,
  logWarn: LocalServerLogWarn = handlers.logWarn ?? defaultLocalServerLogWarn,
) {
  try {
    const msg = parseLocalAgentClientMessage(data);
    if (!msg) {
      logWarn(formatMalformedClientMessage('[local-server]', data));
      sendMalformedClientMessageError(peer, data);
      return;
    }

    if (msg.type === 'chat_request') {
      runLocalServerPeerHandler('handleChatRequest', () => handlers.onChatRequest(peer, msg), logError);
    } else if (msg.type === 'studio_request') {
      runLocalServerPeerHandler('handleStudioRequest', () => handlers.onStudioRequest(peer, msg), logError);
    } else if (msg.type === 'human_review_response') {
      runLocalServerPeerHandler(
        'handleHumanReviewResponse',
        () => handlers.onHumanReviewResponse(peer, msg),
        logError,
      );
    } else if (msg.type === 'review.cancel') {
      runLocalServerPeerHandler('handleReviewCancel', () => handlers.onReviewCancel(peer, msg), logError);
    } else if (msg.type === 'run.interrupt') {
      runLocalServerPeerHandler('handleRunInterrupt', () => handlers.onRunInterrupt(peer, msg), logError);
    } else if (msg.type === 'new_session') {
      runLocalServerPeerHandler('handleNewSession', () => handlers.onNewSession(peer, msg), logError);
    } else if (msg.type === 'runtime_config.update') {
      runLocalServerPeerHandler(
        'handleRuntimeConfigUpdate',
        () => handlers.onRuntimeConfigUpdate(peer, msg),
        logError,
      );
    } else if (msg.type === 'ping') {
      peer.send({ type: 'pong' });
    }
  } catch (err) {
    logError('[local-server] failed to dispatch client message:', err);
  }
}
