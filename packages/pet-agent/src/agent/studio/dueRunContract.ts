import { buildStudioRunIdentity, type StudioRunIdentity } from './types';

export type StudioDueRunStatus = 'pending' | 'claimed' | 'running' | 'success' | 'failed' | 'canceled';

export type StudioDueRunRecord = {
  runId: string;
  conversationId: string;
  workdir: string;
  identity: StudioRunIdentity;
  status: StudioDueRunStatus;
  attempt: number;
  ownerUserId: string | null;
  userRequest: string;
  errorCode?: string;
  errorDetail?: string;
  finalDispatchId?: string;
  reply?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
};

export type StudioDueRunEvent =
  | { type: 'claim' }
  | { type: 'start' }
  | { type: 'succeed'; finalDispatchId?: string; reply?: string }
  | { type: 'fail'; errorCode?: string; errorDetail?: string }
  | { type: 'retry' }
  | { type: 'cancel' };

const statusTransitions: Record<StudioDueRunStatus, StudioDueRunStatus[]> = {
  pending: ['claimed', 'canceled'],
  claimed: ['running', 'canceled'],
  running: ['success', 'failed', 'canceled'],
  success: [],
  failed: ['pending', 'canceled'],
  canceled: [],
};

function transitionTo(previous: StudioDueRunStatus, next: StudioDueRunStatus): void {
  if (!statusTransitions[previous].includes(next)) {
    throw new Error(`invalid due-run status transition ${previous} -> ${next}`);
  }
}

export function isTerminalStudioDueRunStatus(status: StudioDueRunStatus): boolean {
  return status === 'success' || status === 'canceled';
}

export function buildStudioDueRunRecord(input: {
  runId: string;
  conversationId?: string;
  workdir: string;
  ownerUserId?: string | null;
  userRequest: string;
  now?: string;
}): Omit<StudioDueRunRecord, 'status' | 'attempt' | 'createdAt' | 'updatedAt' | 'errorCode' | 'errorDetail' | 'finalDispatchId' | 'reply' | 'claimedAt' | 'completedAt'> &
  Pick<StudioDueRunRecord, 'status' | 'attempt' | 'createdAt' | 'updatedAt'> {
  const now = input.now ?? new Date().toISOString();
  const identity = buildStudioRunIdentity({
    runId: input.runId,
    conversationId: input.conversationId,
  });

  return {
    runId: identity.runId,
    conversationId: identity.conversationId,
    workdir: input.workdir,
    identity,
    ownerUserId: input.ownerUserId ?? null,
    userRequest: input.userRequest,
    status: 'pending',
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyStudioDueRunEvent(
  row: StudioDueRunRecord,
  event: StudioDueRunEvent,
  now?: string,
): StudioDueRunRecord {
  const timestamp = now ?? new Date().toISOString();
  const next = { ...row, updatedAt: timestamp };

  if (event.type === 'claim') {
    transitionTo(row.status, 'claimed');
    return {
      ...next,
      status: 'claimed',
      attempt: row.attempt + 1,
      claimedAt: timestamp,
      errorCode: undefined,
      errorDetail: undefined,
    };
  }
  if (event.type === 'start') {
    transitionTo(row.status, 'running');
    return {
      ...next,
      status: 'running',
    };
  }
  if (event.type === 'succeed') {
    transitionTo(row.status, 'success');
    return {
      ...next,
      status: 'success',
      finalDispatchId: event.finalDispatchId,
      reply: event.reply,
      completedAt: timestamp,
      errorCode: undefined,
      errorDetail: undefined,
    };
  }
  if (event.type === 'fail') {
    transitionTo(row.status, 'failed');
    return {
      ...next,
      status: 'failed',
      errorCode: event.errorCode,
      errorDetail: event.errorDetail,
    };
  }
  if (event.type === 'retry') {
    transitionTo(row.status, 'pending');
    return {
      ...next,
      status: 'pending',
      errorCode: undefined,
      errorDetail: undefined,
      finalDispatchId: undefined,
      reply: undefined,
    };
  }
  transitionTo(row.status, 'canceled');
  return {
    ...next,
    status: 'canceled',
    completedAt: timestamp,
  };
}

export function canRetry(row: StudioDueRunRecord): boolean {
  return row.status === 'failed';
}

