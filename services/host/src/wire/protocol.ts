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
  ModelListMessage,
  ModelSelectMessage,
  NewSessionMessage,
  InterruptResumeMessage,
  RunInterruptMessage,
  RuntimeConfigUpdateMessage,
  SessionListMessage,
  SessionCompactMessage,
  SessionNewMessage,
  SessionResumeMessage,
  SessionSnapshotGetMessage,
} from '@pinpawo/agent-session';
export type {
  AgentClientMessage as HostClientMessage,
  AgentClientMessageEnvelope as HostClientMessageEnvelope,
  AgentControlServerMessage as HostControlServerMessage,
  AgentRuntimeEventEnvelope as HostRuntimeEventEnvelope,
  AgentServerMessage as HostServerMessage,
  AgentSessionServerMessage as HostSessionServerMessage,
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

export function readHostClientMessageEnvelope(raw: unknown) {
  return readAgentClientMessageEnvelope(normalizeProtocolInput(raw));
}

export function parseHostClientMessage(raw: unknown) {
  return parseAgentClientMessage(normalizeProtocolInput(raw));
}

export function parseHostServerMessage(raw: unknown) {
  return parseAgentServerMessage(normalizeProtocolInput(raw));
}

export function buildHostEventEnvelope(
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
export function sendHostMessage(
  ws: WsLike,
  message: AgentServerMessage | AgentClientMessage,
) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  ws.send(JSON.stringify(message));
  return true;
}

export function sendHostEvent(ws: WsLike, event: AgentRuntimeEvent) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  ws.send(JSON.stringify(buildHostEventEnvelope(event)));
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
