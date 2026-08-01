import {
  createAgentSessionSnapshot,
  type AgentClientMessage,
  type AgentServerMessage,
} from '@pinpawo/agent-session';
import type {
  AgentHostConnection,
  LocalHostConnectionHandlers,
} from '../client/localHostConnection';
import type { TuiSessionController } from './sessionController';

export class FakeConnection implements AgentHostConnection {
  connected = false;
  connectCount = 0;
  failNextSend = false;
  sent: AgentClientMessage[] = [];

  constructor(readonly handlers: LocalHostConnectionHandlers) {}

  connect() {
    this.connectCount += 1;
  }

  disconnect() {
    this.connected = false;
  }

  send(message: AgentClientMessage) {
    if (!this.connected) return false;
    if (this.failNextSend) {
      this.failNextSend = false;
      return false;
    }
    this.sent.push(message);
    return true;
  }

  isConnected() {
    return this.connected;
  }

  open() {
    this.connected = true;
    this.handlers.onOpen();
  }

  receive(message: AgentServerMessage) {
    this.handlers.onMessage(message);
  }

  close() {
    this.connected = false;
    this.handlers.onClose();
  }
}

export function eventMessage(
  event: Extract<AgentServerMessage, { type: 'event' }>['event'],
): AgentServerMessage {
  return {
    type: 'event',
    requestId: event.requestId,
    event,
  };
}

export function sessionSummary(
  id: string,
  active: boolean,
) {
  return {
    id,
    kind: 'chat' as const,
    title: `Session ${id}`,
    messageCount: 2,
    createdAt: '2026-07-27T01:00:00.000Z',
    updatedAt: '2026-07-27T02:00:00.000Z',
    active,
  };
}

export function reviewSnapshotResult(
  requestId: string,
  reviews: NonNullable<
    Extract<
      ReturnType<TuiSessionController['getState']>['session']['activeRun'],
      { state: 'waiting_review' }
    >
  >['reviewAction']['reviews'],
): AgentServerMessage {
  return {
    type: 'session.snapshot.result',
    requestId,
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: {
        requestId: 'chat',
        state: 'waiting_review',
        reviewAction: {
          actionId: 'review-action',
          reviews,
        },
      },
    }),
  };
}

export function reviewSpec(
  id: string,
  options: NonNullable<
    Extract<
      ReturnType<TuiSessionController['getState']>['session']['activeRun'],
      { state: 'waiting_review' }
    >
  >['reviewAction']['reviews'][number]['options'],
) {
  return {
    id,
    schemaVersion: 1,
    view: {
      kind: 'plain' as const,
      body: `Review ${id}`,
    },
    options,
  };
}

export function snapshotResult(
  requestId: string,
  sessionId: string,
): AgentServerMessage {
  return {
    type: 'session.snapshot.result',
    requestId,
    snapshot: createAgentSessionSnapshot({
      sessionId,
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  };
}
