import type { HostConfigurationPort } from './configuration';
import type { CapabilityArtifactStore } from '@pinpawo/pet-agent';
import type { RuntimeExecutionIdentity } from '@pinpawo/pet-agent';
import type { PendingInterruptProjection } from '@pinpawo/agent-session';
import type { PetInvocationScope } from '../host/petInvocationContext';
import type { TuiSessionRecord, TuiSessionSummaryInput } from '../session/tuiSessionRegistry';

/** Host business operations; backend paths and serialization are adapter concerns. */
export interface SessionRegistryPort {
  read(sessionId: string): TuiSessionRecord | null;
  active(petId: string): TuiSessionRecord | null;
  list(petId?: string): TuiSessionRecord[];
  ensureActive(petId: string): TuiSessionRecord;
  register(petId: string, sessionId: string, create: boolean): TuiSessionRecord;
  create(petId: string, threadId?: string): TuiSessionRecord;
  select(petId: string, sessionId: string): TuiSessionRecord;
  updateProfile(sessionId: string, profileId: string): TuiSessionRecord;
  updateSummary(sessionId: string, summary: TuiSessionSummaryInput): TuiSessionRecord;
  remove(sessionId: string): void;
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
  settlementId?: string;
};
export interface InvocationStorePort {
  admit(input: InvocationAdmission): { record: HostInvocation; created: boolean };
  read(dispatchId: string): HostInvocation | null;
  findAdmission(idempotencyKey: string): HostInvocation | null;
  list(petId: string): HostInvocation[];
  bindLegacyQueuedSession(dispatchId: string, revision: number, sessionId: string): HostInvocation;
  claimStart(dispatchId: string, revision: number, requestId: string): HostInvocation;
  attachRuntimeIdentity(dispatchId: string, revision: number, identity: RuntimeExecutionIdentity): HostInvocation;
  markWaiting(dispatchId: string, revision: number, pending: PendingInterruptProjection): HostInvocation;
  claimResume(dispatchId: string, revision: number, requestId: string, identity: RuntimeExecutionIdentity, interruptId: string): HostInvocation;
  settle(dispatchId: string, revision: number, result: { state: 'completed' | 'failed' | 'interrupted'; reply?: string; error?: string }): HostInvocation;
  block(dispatchId: string, revision: number, reason: string): HostInvocation;
}
export interface HostPersistence {
  readonly configuration: HostConfigurationPort;
  readonly artifacts?: CapabilityArtifactStore;
  readonly sessions: SessionRegistryPort;
  readonly invocations: InvocationStorePort;
}
