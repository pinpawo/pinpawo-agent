import type { Studio, StudioDispatchRequest } from '../studioContract';
import type { StudioPetRegistration } from '../types';

const phases = {
  'dispatch.queued': 'queued',
  'dispatch.running': 'running',
  'dispatch.waiting': 'waiting',
  'dispatch.completed': 'completed',
  'dispatch.interrupted': 'interrupted',
  'dispatch.failed': 'failed',
} as const;
export type HeadDispatchPhase = typeof phases[keyof typeof phases];
const terminalPhases = new Set<HeadDispatchPhase>(['completed', 'interrupted', 'failed']);
const activeLimit = 32;
const terminalLimit = 32;
const earlyLimit = 16;
const recentLimit = 32;
const outputLimit = 8;

export type HeadDispatchObservation = { invocationId: string; sourceMessageId: string } & (
  | { kind: 'lifecycle'; phase: HeadDispatchPhase }
  // An Agent message reference is not evidence of a committed Channel message.
  | { kind: 'agent-message'; agentMessageId: string }
);

type Evidence = {
  eventId: string;
  occurredAt: string;
  sessionId?: string;
  requestId?: string;
} & (
  | { kind: 'lifecycle'; phase: HeadDispatchPhase; humanReview: boolean; interruptId?: string }
  | { kind: 'agent-message'; agentMessageId: string }
);

export type HeadDispatchRecord = {
  invocationId: string;
  sourceMessageId: string;
  sessionId?: string;
  requestId?: string;
  phase?: HeadDispatchPhase;
  humanReview?: boolean;
  interruptId?: string;
  observedAt?: string;
  agentMessageIds: readonly string[];
  incomplete: boolean;
};

type TrackedDispatch = {
  record: HeadDispatchRecord;
  admitted: boolean;
  early: Evidence[];
  eventIds: string[];
  previousRequests: string[];
};
type InvocationIdentity = Parameters<NonNullable<StudioDispatchRequest['observeInvocation']>>[0];

function newest<T>(items: readonly T[], value: T, limit: number): T[] {
  return [...items.slice(1 - limit), value];
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** One instance's activation-local ownership and evidence; no execution or Timeline writes. */
export function observePetHeadDispatches(
  pet: StudioPetRegistration,
  subscribe: Studio['subscribe'],
  signal: AbortSignal,
  onObservation?: (observation: HeadDispatchObservation) => void,
) {
  const { petId, channelId } = pet;
  const live = new Map<string, TrackedDispatch>();
  const terminal = new Map<string, HeadDispatchRecord>();
  let incomplete = false;
  let pendingOverflow = 0;
  let closed = false;
  const isActive = () => !closed && !signal.aborted;

  function apply(dispatch: TrackedDispatch, evidence: Evidence, fromBuffer: boolean) {
    if (!isActive() || dispatch.eventIds.includes(evidence.eventId)) return;
    let record = dispatch.record;
    const { invocationId, sourceMessageId, sessionId, requestId, phase } = record;
    if (phase && terminalPhases.has(phase)) return;
    if (sessionId && evidence.sessionId && sessionId !== evidence.sessionId) return;

    const incoming = evidence.requestId;
    if (incoming && dispatch.previousRequests.includes(incoming)) return;
    const resumed = !!(requestId && incoming && requestId !== incoming);
    if (resumed && !(phase === 'waiting' && evidence.kind === 'lifecycle' && evidence.phase === 'running')) return;
    if (evidence.kind === 'agent-message' && (!incoming || (requestId && incoming !== requestId))) return;
    if (evidence.kind === 'lifecycle' && (
      (evidence.phase === 'queued' && phase && phase !== 'queued')
      || (evidence.phase !== 'queued' && !incoming)
      || (phase === 'waiting' && evidence.phase === 'running' && !resumed)
      || (phase === 'waiting' && evidence.phase === 'waiting'
        && ((record.humanReview && !evidence.humanReview) || (record.interruptId && !evidence.interruptId)))
    )) return;
    dispatch.eventIds = newest(dispatch.eventIds, evidence.eventId, recentLimit);

    const fillsIdentity = (!sessionId && !!evidence.sessionId) || (!requestId && !!incoming);
    record = {
      ...record,
      ...(evidence.sessionId ? { sessionId: evidence.sessionId } : {}),
      ...(incoming ? { requestId: incoming } : {}),
    };

    let observation: HeadDispatchObservation;
    const ref = { invocationId, sourceMessageId };
    if (evidence.kind === 'agent-message') {
      if (record.agentMessageIds.includes(evidence.agentMessageId)) return;
      record.agentMessageIds = newest(record.agentMessageIds, evidence.agentMessageId, outputLimit);
      observation = { ...ref, kind: 'agent-message', agentMessageId: evidence.agentMessageId };
    } else {
      if (evidence.phase === phase && !fillsIdentity
        && !!record.humanReview === evidence.humanReview
        && record.interruptId === evidence.interruptId
        && !(record.incomplete && !fromBuffer)) return;
      if (resumed) {
        dispatch.previousRequests = newest(dispatch.previousRequests, requestId!, recentLimit);
        record.agentMessageIds = [];
      }
      record.phase = evidence.phase;
      record.humanReview = evidence.humanReview;
      if (evidence.interruptId) record.interruptId = evidence.interruptId;
      else delete record.interruptId;
      record.observedAt = evidence.occurredAt;
      if (!fromBuffer || terminalPhases.has(evidence.phase)) record.incomplete = false;
      observation = { ...ref, kind: 'lifecycle', phase: evidence.phase };
    }
    dispatch.record = record;
    if (record.phase && terminalPhases.has(record.phase)) {
      live.delete(invocationId);
      terminal.set(invocationId, record);
      if (terminal.size > terminalLimit) terminal.delete(terminal.keys().next().value!);
    }
    try { onObservation?.(observation); } catch { /* Observation cannot affect execution. */ }
  }

  const unsubscribe = subscribe(event => {
    if (!isActive() || event.source !== 'resident-pet' || event.topic !== petId) return;
    const payload = event.payload as {
      invocationId?: unknown; petId?: unknown; scope?: { namespace?: unknown; id?: unknown };
      requestId?: unknown; sessionId?: unknown;
      pendingInterrupt?: { interruptId?: unknown; payload?: { kind?: unknown } };
      message?: { type?: unknown; role?: unknown; messageId?: unknown };
    } | undefined;
    if (typeof payload?.invocationId !== 'string' || payload.petId !== petId
      || payload.scope?.namespace !== 'channel' || payload.scope.id !== channelId) return;
    const dispatch = live.get(payload.invocationId);
    if (!dispatch) return;

    const occurredAt = Number.isFinite(Date.parse(event.occurredAt)) ? event.occurredAt : new Date().toISOString();
    const requestId = nonempty(payload.requestId);
    const sessionId = nonempty(payload.sessionId);
    const base = { eventId: event.eventId, occurredAt, ...(requestId ? { requestId } : {}), ...(sessionId ? { sessionId } : {}) };
    let evidence: Evidence;
    if (Object.hasOwn(phases, event.type)) {
      const phase = phases[event.type as keyof typeof phases];
      const humanReview = phase === 'waiting' && payload.pendingInterrupt?.payload?.kind === 'human_review';
      const interruptId = phase === 'waiting' ? nonempty(payload.pendingInterrupt?.interruptId) : undefined;
      evidence = { ...base, kind: 'lifecycle', phase, humanReview, ...(interruptId ? { interruptId } : {}) };
    } else if (event.type === 'dispatch.message' && payload.message?.type === 'message.completed'
      && payload.message.role === 'assistant' && typeof payload.message.messageId === 'string'
      && payload.message.messageId && !payload.message.messageId.startsWith('head-reply:')) {
      evidence = { ...base, kind: 'agent-message', agentMessageId: payload.message.messageId };
    } else return;

    if (dispatch.admitted) apply(dispatch, evidence, false);
    else if (!dispatch.early.some(item => item.eventId === evidence.eventId)) {
      if (dispatch.early.length >= earlyLimit) dispatch.record.incomplete = true;
      dispatch.early = newest(dispatch.early, evidence, earlyLimit);
    }
  }, { source: 'resident-pet', topic: petId });

  return {
    track(sourceMessageId: string, { invocationId, receipt }: InvocationIdentity) {
      if (!isActive() || live.has(invocationId) || terminal.has(invocationId)) return;
      const matches = (value: Awaited<InvocationIdentity['receipt']>) =>
        isActive() && value.invocationId === invocationId && value.petId === petId;
      if (live.size >= activeLimit) {
        pendingOverflow++;
        void receipt.then(result => {
          if (matches(result)) incomplete = true;
        }, () => undefined).finally(() => { pendingOverflow--; });
        return;
      }
      const dispatch: TrackedDispatch = {
        record: { invocationId, sourceMessageId, agentMessageIds: [], incomplete: false },
        admitted: false, early: [], eventIds: [], previousRequests: [],
      };
      live.set(invocationId, dispatch);
      void receipt.then(result => {
        if (!matches(result)) { live.delete(invocationId); return; }
        dispatch.admitted = true;
        for (const evidence of dispatch.early.splice(0)) apply(dispatch, evidence, true);
      }, () => { live.delete(invocationId); });
    },
    byId(invocationId: string): HeadDispatchRecord | undefined {
      if (!isActive()) return;
      const dispatch = live.get(invocationId);
      return dispatch?.admitted ? dispatch.record : terminal.get(invocationId);
    },
    source(sourceMessageId: string): HeadDispatchRecord[] {
      if (!isActive()) return [];
      return [...this.ongoing().records, ...terminal.values()].filter(record => record.sourceMessageId === sourceMessageId);
    },
    ongoing(): { records: HeadDispatchRecord[]; incomplete: boolean } {
      if (!isActive()) return { records: [], incomplete: true };
      const records = [...live.values()].filter(dispatch => dispatch.admitted).map(dispatch => dispatch.record);
      return { records, incomplete: incomplete || pendingOverflow > 0 || live.size !== records.length };
    },
    unsubscribe() {
      if (closed) return;
      closed = true;
      live.clear();
      terminal.clear();
      unsubscribe();
    },
  };
}

export type HeadDispatchKnowledge = ReturnType<typeof observePetHeadDispatches>;
