import {
  buildAgentEventEnvelope,
  parseAgentClientMessage,
  parseAgentServerMessage,
  readAgentClientMessageEnvelope,
  type AgentClientMessage,
  type AgentRuntimeEvent,
  type AgentRuntimeEventEnvelope,
  type AgentServerMessage,
} from '@pinpawo/agent-session';

export type {
  ChatRequestMessage,
  HumanReviewResponseMessage,
  NewSessionMessage,
  ReviewCancelMessage,
  RunInterruptMessage,
  RuntimeConfigUpdateMessage,
  SessionListMessage,
  SessionNewMessage,
  SessionResumeMessage,
  SessionSnapshotGetMessage,
  StudioRequestMessage,
} from '@pinpawo/agent-session';
export type {
  AgentClientMessage as LocalAgentClientMessage,
  AgentClientMessageEnvelope as LocalAgentClientMessageEnvelope,
  AgentControlServerMessage as LocalAgentControlServerMessage,
  AgentRuntimeEventEnvelope as LocalAgentRuntimeEventEnvelope,
  AgentServerMessage as LocalAgentServerMessage,
  AgentSessionServerMessage as LocalAgentSessionServerMessage,
} from '@pinpawo/agent-session';

type WsLike = {
  readyState: number;
  send(data: string): unknown;
};

const WS_OPEN = 1;
const AGENT_SERVER_MESSAGE_TYPES = {
  pong: true,
  event: true,
  interrupting: true,
  interrupted: true,
  studio_response: true,
  studio_error: true,
  'session.snapshot.result': true,
  'session.list.result': true,
  'session.new.result': true,
  'session.resume.result': true,
  'session.error': true,
} as const satisfies Record<AgentServerMessage['type'], true>;

export type LocalAgentTransportAudience = 'trusted-local' | 'remote';

export type SendLocalAgentMessageOptions = {
  audience?: LocalAgentTransportAudience;
};

export type SendLocalAgentEventOptions = {
  audience?: LocalAgentTransportAudience;
};

export function readLocalAgentClientMessageEnvelope(raw: unknown) {
  return readAgentClientMessageEnvelope(normalizeProtocolInput(raw));
}

export function parseLocalAgentClientMessage(raw: unknown) {
  return parseAgentClientMessage(normalizeProtocolInput(raw));
}

export function parseLocalAgentServerMessage(raw: unknown) {
  return parseAgentServerMessage(normalizeProtocolInput(raw));
}

export function buildLocalAgentEventEnvelope(
  event: AgentRuntimeEvent,
): AgentRuntimeEventEnvelope {
  return buildAgentEventEnvelope(event);
}

export function redactRemoteCompletedMessagePaths(event: AgentRuntimeEvent) {
  if (event.type !== 'message.completed') {
    return event;
  }
  return {
    ...event,
    text: redactLocalPathFragments(event.text),
  };
}

export function sendLocalAgentMessage(
  ws: WsLike,
  message: AgentServerMessage | AgentClientMessage,
  options: SendLocalAgentMessageOptions = {},
) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  const isRemoteServerMessage = isAgentServerMessage(message)
    && (options.audience ?? 'remote') === 'remote';
  const protocolMessage = isRemoteServerMessage && message.type === 'event'
    ? {
        ...message,
        event: redactRemoteCompletedMessagePaths(message.event),
      }
    : message;
  ws.send(JSON.stringify(protocolMessage));
  return true;
}

export function sendLocalAgentEvent(
  ws: WsLike,
  event: AgentRuntimeEvent,
  options: SendLocalAgentEventOptions = {},
) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  const protocolEvent = options.audience === 'trusted-local'
    ? event
    : redactRemoteCompletedMessagePaths(event);
  const protocolEnvelope = buildLocalAgentEventEnvelope(protocolEvent);
  ws.send(JSON.stringify(protocolEnvelope));
  return true;
}

function normalizeProtocolInput(raw: unknown) {
  return raw instanceof Buffer ? raw.toString() : raw;
}

function redactLocalPathFragments(value: string) {
  return value.replace(
    /(^|[\s"'`([{=])(?:file:\/\/|~\/|\/(?:Users|home|root|private|tmp|var|Volumes|workspace|workspaces|app|opt|srv)\/|[A-Za-z]:[\\/])[^\s"'`<>{}\])]+/g,
    '$1[local-path]',
  );
}

function isAgentServerMessage(
  message: AgentServerMessage | AgentClientMessage,
): message is AgentServerMessage {
  return Object.prototype.hasOwnProperty.call(
    AGENT_SERVER_MESSAGE_TYPES,
    message.type,
  );
}
