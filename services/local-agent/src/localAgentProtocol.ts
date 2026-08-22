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
  ModelListMessage,
  ModelSelectMessage,
  NewSessionMessage,
  ReviewCancelMessage,
  RunInterruptMessage,
  RuntimeConfigUpdateMessage,
  SessionListMessage,
  SessionCompactMessage,
  SessionNewMessage,
  SessionResumeMessage,
  SessionSnapshotGetMessage,
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
  'runtime_config.result': true,
  'runtime_config.error': true,
  interrupting: true,
  interrupted: true,
  'session.snapshot.result': true,
  'session.list.result': true,
  'session.new.result': true,
  'session.resume.result': true,
  'session.compact.result': true,
  'session.error': true,
  'model.list.result': true,
  'model.select.result': true,
  'model.select.error': true,
} as const satisfies Record<AgentServerMessage['type'], true>;

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

/**
 * Local path redaction lived here to keep filesystem fragments from crossing
 * to the hosted app. That egress is gone with the app relay: every peer now
 * reaches this host over 127.0.0.1 and is trusted with local paths, which the
 * one remaining caller already opted into. A `remote` audience whose default
 * still redacted would only mislead the next caller, so both are removed.
 * Any adapter that opens a genuinely remote surface owns its disclosure
 * policy at that boundary (#638).
 */
export function sendLocalAgentMessage(
  ws: WsLike,
  message: AgentServerMessage | AgentClientMessage,
) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  ws.send(JSON.stringify(message));
  return true;
}

export function sendLocalAgentEvent(ws: WsLike, event: AgentRuntimeEvent) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  ws.send(JSON.stringify(buildLocalAgentEventEnvelope(event)));
  return true;
}

function normalizeProtocolInput(raw: unknown) {
  return raw instanceof Buffer ? raw.toString() : raw;
}


function isAgentServerMessage(
  message: AgentServerMessage | AgentClientMessage,
): message is AgentServerMessage {
  return Object.prototype.hasOwnProperty.call(
    AGENT_SERVER_MESSAGE_TYPES,
    message.type,
  );
}
