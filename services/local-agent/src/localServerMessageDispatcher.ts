import {
  parseLocalAgentClientMessage,
  readLocalAgentClientMessageEnvelope,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type ModelListMessage,
  type ModelSelectMessage,
  type NewSessionMessage,
  type ReviewCancelMessage,
  type RunInterruptMessage,
  type RuntimeConfigUpdateMessage,
  type SessionListMessage,
  type SessionCompactMessage,
  type SessionNewMessage,
  type SessionResumeMessage,
  type SessionSnapshotGetMessage,
} from './localAgentProtocol';
import { sendLocalServerPeerEvent, type LocalServerPeer } from './localServerPeer';
import type { LocalServerWireHandlers } from './localServerWire';

type MaybePromise<T> = T | Promise<T>;
export type LocalServerLogError = (message: string, error: unknown) => void;
export type LocalServerLogWarn = (message: string) => void;

export type LocalServerPeerHandlers = {
  onChatRequest: (peer: LocalServerPeer, message: ChatRequestMessage) => MaybePromise<void>;
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
  onSessionSnapshotGet: (
    peer: LocalServerPeer,
    message: SessionSnapshotGetMessage,
  ) => MaybePromise<void>;
  onSessionList: (peer: LocalServerPeer, message: SessionListMessage) => MaybePromise<void>;
  /** Optional so pre-v2 host embeddings can retain their existing handlers. */
  onSessionCompact?: (peer: LocalServerPeer, message: SessionCompactMessage) => MaybePromise<void>;
  onSessionNew: (peer: LocalServerPeer, message: SessionNewMessage) => MaybePromise<void>;
  onSessionResume: (peer: LocalServerPeer, message: SessionResumeMessage) => MaybePromise<void>;
  onModelList: (peer: LocalServerPeer, message: ModelListMessage) => MaybePromise<void>;
  onModelSelect: (peer: LocalServerPeer, message: ModelSelectMessage) => MaybePromise<void>;
  onClose: (peer: LocalServerPeer) => MaybePromise<void>;
  log?: (message: string) => void;
  logError?: LocalServerLogError;
  logWarn?: LocalServerLogWarn;
};

export type LocalServerTransportHandlers = Partial<LocalServerPeerHandlers> & Pick<
  LocalServerPeerHandlers,
  'log' | 'logError' | 'logWarn'
>;

function rejectUnsupportedMessage(
  peer: LocalServerPeer,
  message: { type: string; requestId?: string },
  logWarn: LocalServerLogWarn,
) {
  if (!message.requestId) {
    logWarn(
      `[local-server] ignored unsupported client message type=${message.type} because it has no requestId`,
    );
    return Promise.resolve();
  }
  sendLocalServerPeerEvent(peer, {
    type: 'error',
    requestId: message.requestId,
    message: `Message type "${message.type}" is not supported by this Host transport.`,
  });
  return Promise.resolve();
}

function dispatchOptional<TMessage extends { type: string; requestId?: string }>(
  peer: LocalServerPeer,
  message: TMessage,
  handler: ((peer: LocalServerPeer, message: TMessage) => MaybePromise<void>) | undefined,
  handlerName: string,
  logError: LocalServerLogError,
  logWarn: LocalServerLogWarn,
) {
  return handler
    ? runLocalServerPeerHandler(handlerName, () => handler(peer, message), logError)
    : rejectUnsupportedMessage(peer, message, logWarn);
}

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
  const sessionOperation = envelope.type === 'session.snapshot.get'
    ? 'snapshot'
    : envelope.type === 'session.list'
      ? 'list'
      : envelope.type === 'session.new'
        ? 'new'
        : envelope.type === 'session.resume'
          ? 'resume'
          : envelope.type === 'session.compact'
            ? 'compact'
          : null;
  if (sessionOperation) {
    peer.send({
      type: 'session.error',
      requestId: envelope.requestId,
      operation: sessionOperation,
      message: '客户端 session 消息协议不兼容或格式无效，请升级客户端后重试。',
    });
    return;
  }
  if (envelope.type === 'runtime_config.update') {
    peer.send({
      type: 'runtime_config.error',
      requestId: envelope.requestId,
      message: '客户端 runtime config 消息协议不兼容或格式无效，请升级客户端后重试。',
    });
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
  return Promise.resolve()
    .then(handler)
    .catch((err) => {
      logError(`[local-server] ${name} error:`, err);
    });
}

export function dispatchLocalServerMessage(
  peer: LocalServerPeer,
  data: Buffer | string,
  handlers: LocalServerTransportHandlers,
  logError: LocalServerLogError = handlers.logError ?? defaultLocalServerLogError,
  logWarn: LocalServerLogWarn = handlers.logWarn ?? defaultLocalServerLogWarn,
) {
  try {
    const msg = parseLocalAgentClientMessage(data);
    if (!msg) {
      logWarn(formatMalformedClientMessage('[local-server]', data));
      sendMalformedClientMessageError(peer, data);
      return Promise.resolve();
    }

    if (msg.type === 'chat_request') {
      return dispatchOptional(peer, msg, handlers.onChatRequest, 'handleChatRequest', logError, logWarn);
    } else if (msg.type === 'human_review_response') {
      return dispatchOptional(peer, msg, handlers.onHumanReviewResponse, 'handleHumanReviewResponse', logError, logWarn);
    } else if (msg.type === 'review.cancel') {
      return dispatchOptional(peer, msg, handlers.onReviewCancel, 'handleReviewCancel', logError, logWarn);
    } else if (msg.type === 'run.interrupt') {
      return dispatchOptional(peer, msg, handlers.onRunInterrupt, 'handleRunInterrupt', logError, logWarn);
    } else if (msg.type === 'new_session') {
      return dispatchOptional(peer, msg, handlers.onNewSession, 'handleNewSession', logError, logWarn);
    } else if (msg.type === 'runtime_config.update') {
      return dispatchOptional(peer, msg, handlers.onRuntimeConfigUpdate, 'handleRuntimeConfigUpdate', logError, logWarn);
    } else if (msg.type === 'session.snapshot.get') {
      return dispatchOptional(peer, msg, handlers.onSessionSnapshotGet, 'handleSessionSnapshotGet', logError, logWarn);
    } else if (msg.type === 'session.list') {
      return dispatchOptional(peer, msg, handlers.onSessionList, 'handleSessionList', logError, logWarn);
    } else if (msg.type === 'session.new') {
      return dispatchOptional(peer, msg, handlers.onSessionNew, 'handleSessionNew', logError, logWarn);
    } else if (msg.type === 'session.resume') {
      return dispatchOptional(peer, msg, handlers.onSessionResume, 'handleSessionResume', logError, logWarn);
    } else if (msg.type === 'session.compact') {
      if (!handlers.onSessionCompact) {
        peer.send({
          type: 'session.error',
          requestId: msg.requestId,
          operation: 'compact',
          message: '当前 local-agent 不支持手动压缩，请升级 local-agent 后重试。',
        });
        return Promise.resolve();
      }
      return runLocalServerPeerHandler(
        'handleSessionCompact',
        () => handlers.onSessionCompact!(peer, msg),
        logError,
      );
    } else if (msg.type === 'model.list') {
      return dispatchOptional(peer, msg, handlers.onModelList, 'handleModelList', logError, logWarn);
    } else if (msg.type === 'model.select') {
      return dispatchOptional(peer, msg, handlers.onModelSelect, 'handleModelSelect', logError, logWarn);
    } else if (msg.type === 'ping') {
      peer.send({ type: 'pong' });
    }
  } catch (err) {
    logError('[local-server] failed to dispatch client message:', err);
  }
  return Promise.resolve();
}

export function createLocalAgentWireHandlers(
  handlers: LocalServerTransportHandlers,
  logError: LocalServerLogError = handlers.logError ?? defaultLocalServerLogError,
  logWarn: LocalServerLogWarn = handlers.logWarn ?? defaultLocalServerLogWarn,
): LocalServerWireHandlers<import('./localAgentProtocol').LocalAgentServerMessage> {
  return {
    onMessage: (peer, data) => dispatchLocalServerMessage(
      peer,
      data,
      handlers,
      logError,
      logWarn,
    ),
    onClose: handlers.onClose,
    log: handlers.log,
    logError,
    logWarn,
  };
}
