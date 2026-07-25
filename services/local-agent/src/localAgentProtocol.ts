import {
  buildAgentEventEnvelope,
  parseAgentClientMessage,
  parseAgentServerMessage,
  readAgentClientMessageEnvelope,
  type AgentClientMessage,
  type AgentRuntimeEvent,
  type AgentRuntimeEventEnvelope,
  type AgentRuntimeView,
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
  'session.resume.result': true,
  'session.error': true,
} as const satisfies Record<AgentServerMessage['type'], true>;

const REMOTE_RUNTIME_FIELD_POLICY = {
  model: 'keep',
  cwd: 'omit',
  workspaceId: 'keep',
  workspaceName: 'keep',
  workspaceRoot: 'omit',
  stateRoot: 'omit',
  studioConfigPath: 'omit',
  studioDueRunsPath: 'omit',
  petsDir: 'omit',
  studioWikiBaseDir: 'omit',
  contextWindow: 'keep',
} as const satisfies Record<keyof AgentRuntimeView, 'keep' | 'omit'>;

const REMOTE_OMITTED_KEYS = new Set<string>([
  'raw',
  'workdir',
  ...Object.entries(REMOTE_RUNTIME_FIELD_POLICY)
    .filter(([, policy]) => policy === 'omit')
    .map(([field]) => field),
]);

export type LocalAgentTransportAudience = 'trusted-local' | 'remote';

export type SendLocalAgentMessageOptions = {
  audience?: LocalAgentTransportAudience;
};

export type SendLocalAgentEventOptions =
  | {
      audience?: 'remote';
      /**
       * The event already passed through sanitizeLocalAgentRemoteEvent.
       * This skips duplicate transformation, but remote delta suppression
       * still applies.
       */
      alreadySanitized?: boolean;
    }
  | {
      audience: 'trusted-local';
      alreadySanitized?: never;
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

export function sanitizeLocalAgentRemoteEvent(event: AgentRuntimeEvent) {
  return toRemoteProtocolValue(event);
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
  if (
    isRemoteServerMessage
    && message.type === 'event'
    && message.event.type === 'message.delta'
  ) {
    return true;
  }
  const protocolMessage = isRemoteServerMessage
    ? toRemoteProtocolValue(message)
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
  if (options.audience !== 'trusted-local' && event.type === 'message.delta') {
    return true;
  }
  const envelope = buildLocalAgentEventEnvelope(event);
  const protocolEnvelope = options.audience === 'trusted-local'
    || options.alreadySanitized
    ? envelope
    : toRemoteProtocolValue(envelope);
  ws.send(JSON.stringify(protocolEnvelope));
  return true;
}

function normalizeProtocolInput(raw: unknown) {
  return raw instanceof Buffer ? raw.toString() : raw;
}

function toRemoteProtocolValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (REMOTE_OMITTED_KEYS.has(key)) return undefined;
    return typeof item === 'string'
      ? redactLocalPathFragments(item)
      : item;
  })) as T;
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
