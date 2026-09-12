import type {
  AgentOperationEvent,
  AgentOperationPhase,
} from '@pinpawo/agent-session';

type ActiveOperationState = {
  kind: string;
  title?: string;
  target?: string;
  summary?: string;
  phase: AgentOperationPhase;
  updatedAt: number;
  eventId: number;
  expiresAt?: number;
};

type AgentRunPhase =
  | 'thinking'
  | 'using_tool'
  | 'streaming'
  | 'waiting_human'
  | 'interrupted'
  | 'error';

type AgentRunState = {
  phase: AgentRunPhase;
  requestId?: string;
  updatedAt: number;
  expiresAt?: number;
};

let activeOperationState: ActiveOperationState | null = null;
let agentRunState: AgentRunState | null = null;
let nextOperationEventId = 1;

function setActiveOperation(event: AgentOperationEvent, visibleForMs?: number) {
  const now = Date.now();
  activeOperationState = {
    kind: event.operation.kind,
    phase: event.phase,
    updatedAt: now,
    eventId: nextOperationEventId++,
    ...(event.operation.title !== undefined ? { title: event.operation.title } : {}),
    ...(event.operation.target !== undefined ? { target: event.operation.target } : {}),
    ...(event.operation.summary !== undefined ? { summary: event.operation.summary } : {}),
    ...(visibleForMs ? { expiresAt: now + visibleForMs } : {}),
  };
}

export function recordAgentRunActivity(phase: AgentRunPhase, requestId?: string, visibleForMs?: number) {
  const now = Date.now();
  agentRunState = {
    phase,
    updatedAt: now,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(visibleForMs ? { expiresAt: now + visibleForMs } : {}),
  };
}

export function clearAgentRunActivity(requestId?: string) {
  if (requestId && agentRunState?.requestId && agentRunState.requestId !== requestId) return;
  agentRunState = null;
  activeOperationState = null;
}

export function recordOperationActivity(event: AgentOperationEvent) {
  if (!event.operation.kind) return;

  if (event.phase === 'started' || event.phase === 'updated') {
    setActiveOperation(event);
    recordAgentRunActivity('using_tool', event.requestId);
    return;
  }

  if (event.phase === 'interrupted') {
    setActiveOperation(event, 10_000);
    recordAgentRunActivity('waiting_human', event.requestId);
    return;
  }

  if (event.phase === 'failed') {
    setActiveOperation(event, 5_000);
    recordAgentRunActivity('error', event.requestId, 5_000);
    return;
  }

  setActiveOperation(event, 2_500);
}

