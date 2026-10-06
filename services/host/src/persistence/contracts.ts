import type { HostConfigurationPort } from './configuration';
import type { CapabilityArtifactStore } from '@pinpawo/pet-agent';
import type { RuntimeExecutionIdentity } from '@pinpawo/pet-agent';
import type { PendingInterruptProjection } from '@pinpawo/agent-session';
import type { PetInvocationScope } from '../host/petInvocationContext';
import type { TuiSessionRecord, TuiSessionSummaryInput } from '../session/tuiSessionRegistry';

/** Host business operations; backend paths and serialization are adapter concerns. */
export interface SessionRegistryPort {
  read(sessionId: string): Promise<TuiSessionRecord | null>;
  active(petId: string): Promise<TuiSessionRecord | null>;
  list(petId?: string): Promise<TuiSessionRecord[]>;
  ensureActive(petId: string): Promise<TuiSessionRecord>;
  register(petId: string, sessionId: string, create: boolean): Promise<TuiSessionRecord>;
  create(petId: string, threadId?: string): Promise<TuiSessionRecord>;
  select(petId: string, sessionId: string): Promise<TuiSessionRecord>;
  updateProfile(sessionId: string, profileId: string): Promise<TuiSessionRecord>;
  updateSummary(sessionId: string, summary: TuiSessionSummaryInput): Promise<TuiSessionRecord>;
  remove(sessionId: string): Promise<void>;
}
export type InvocationState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'blocked';
export type InvocationAdmission = {
  dispatchId: string; petId: string; sessionId: string; threadId: string;
  request: string; scope?: PetInvocationScope; idempotencyKey?: string;
  /** Canonical producer request including metadata, excluding session creation hints. */
  fingerprint: string;
};
export type HostInvocation = InvocationAdmission & {
  state: InvocationState; revision: number; createdAt: string; updatedAt: string;
  requestId?: string; runtime?: RuntimeExecutionIdentity;
  pendingInterrupt?: PendingInterruptProjection; reply?: string; error?: string;
};
export interface InvocationStorePort {
  admit(input: InvocationAdmission): Promise<{ record: HostInvocation; created: boolean }>;
  read(dispatchId: string): Promise<HostInvocation | null>;
  findAdmission(idempotencyKey: string): Promise<HostInvocation | null>;
  list(petId: string): Promise<HostInvocation[]>;
  bindLegacyQueuedSession(dispatchId: string, revision: number, sessionId: string): Promise<HostInvocation>;
  claimStart(dispatchId: string, revision: number, requestId: string): Promise<HostInvocation>;
  attachRuntimeIdentity(dispatchId: string, revision: number, identity: RuntimeExecutionIdentity): Promise<HostInvocation>;
  markWaiting(dispatchId: string, revision: number, pending: PendingInterruptProjection): Promise<HostInvocation>;
  claimResume(dispatchId: string, revision: number, requestId: string, identity: RuntimeExecutionIdentity, interruptId: string): Promise<HostInvocation>;
  settle(dispatchId: string, revision: number, result: { state: 'completed' | 'failed' | 'interrupted'; reply?: string; error?: string }): Promise<HostInvocation>;
  block(dispatchId: string, revision: number, reason: string): Promise<HostInvocation>;
}

/** null is unknown; a provider-reported zero is known consumption. */
export type UsageQuantity = number | null;
/** One physical provider request; later revisions update that attempt, not its count. */
export type UsageObservation = {
  sourceId: string;
  eventId: string;
  revision: number;
  attemptId: string;
  runtime: RuntimeExecutionIdentity;
  /** Existing start/resume operation identity, retained on each fact. */
  requestId: string;
  planItemId?: string;
  delegationId?: string;
  usage: {
    input: UsageQuantity;
    output: UsageQuantity;
    total: UsageQuantity;
  };
};
export type UsageFilter = {
  runtime?: Partial<RuntimeExecutionIdentity>;
  requestId?: string;
  planItemId?: string;
  delegationId?: string;
};
/** Current per-attempt facts; the next cursor is opaque, not a replay checkpoint. */
export type UsagePage = { records: UsageObservation[]; nextCursor?: string };
export interface UsageStorePort {
  /** Key by (sourceId, attemptId); conflicting content at the same revision must reject. */
  record(value: UsageObservation): Promise<'recorded' | 'duplicate' | 'stale'>;
  /** Empty results establish no matching records, not complete historical zero. */
  list(filter: UsageFilter, cursor?: string): Promise<UsagePage>;
}
export interface HostPersistence {
  readonly configuration: HostConfigurationPort;
  readonly artifacts?: CapabilityArtifactStore;
  readonly sessions: SessionRegistryPort;
  readonly invocations: InvocationStorePort;
  /** Absent means unsupported/unavailable, never zero consumed. */
  readonly usage?: UsageStorePort;
}
