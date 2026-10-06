import { hostConfiguration, type HostConfigurationPort } from './configuration';
import type { CapabilityArtifactStore } from '@pinpawo/pet-agent';
import { createEmptyTuiSessionState, createTuiSession, createTuiSessionForThread, ensureActiveTuiSession,
  ensureDispatchSession, resumeTuiSession, updateTuiSessionModelProfile, updateTuiSessionSummary,
  type TuiSessionState } from '../session/tuiSessionRegistry';
import type { HostInvocation, HostPersistence, InvocationStorePort, SessionRegistryPort, UsageStorePort } from './contracts';
import type { RuntimeExecutionIdentity } from '@pinpawo/pet-agent';

export type HostPersistenceState = { sessions: TuiSessionState; invocations: Record<string, HostInvocation> };
export function sameRuntimeIdentity(a: RuntimeExecutionIdentity | undefined, b: RuntimeExecutionIdentity): boolean {
  return !!a && a.threadId === b.threadId && a.taskId === b.taskId && a.runId === b.runId;
}
const terminal = (record: HostInvocation) => ['completed', 'failed', 'interrupted'].includes(record.state);

/** Commit-before-publish and rollback semantics shared by deterministic and file adapters. */
export function createHostPersistence(options: {
  configuration?: HostConfigurationPort; artifacts?: CapabilityArtifactStore;
  /** Inject a real domain adapter; usage is outside this session/invocation commit. */
  usage?: UsageStorePort;
  defaultModelProfileId: string; initial?: HostPersistenceState;
  commit?: (state: HostPersistenceState) => void;
}): HostPersistence {
  let state = structuredClone(options.initial ?? { sessions: createEmptyTuiSessionState(), invocations: {} });
  const read = <T>(value: T): T => structuredClone(value);
  function change<T>(fn: (draft: HostPersistenceState) => T): T {
    const draft = structuredClone(state);
    const result = fn(draft);
    options.commit?.(draft);
    state = draft;
    return read(result);
  }
  const sessions: SessionRegistryPort = {
    read: id => read(state.sessions.sessions[id] ?? null),
    active: pet => read(state.sessions.sessions[state.sessions.activeSessionIds[pet] ?? ''] ?? null),
    list: pet => read(Object.values(state.sessions.sessions).filter(s => !pet || s.petId === pet)),
    ensureActive: pet => sessions.active(pet) ?? change(s => ensureActiveTuiSession(s.sessions, pet, options.defaultModelProfileId)),
    register: (pet, id, create) => {
      const existing = sessions.read(id);
      if (existing) {
        if (existing.petId !== pet) throw new Error('Session belongs to another Pet.');
        return existing;
      }
      return change(s => ensureDispatchSession(s.sessions, pet, id, options.defaultModelProfileId, create));
    },
    create: (pet, thread) => change(s => thread
      ? createTuiSessionForThread(s.sessions, pet, options.defaultModelProfileId, thread)
      : createTuiSession(s.sessions, pet, options.defaultModelProfileId)),
    select: (pet, id) => change(s => {
      const record = resumeTuiSession(s.sessions, pet, id);
      if (!record) throw new Error('session not found');
      return record;
    }),
    updateProfile: (id, profile) => change(s => {
      const record = updateTuiSessionModelProfile(s.sessions, id, profile);
      if (!record) throw new Error('session not found');
      return record;
    }),
    updateSummary: (id, summary) => change(s => {
      const record = updateTuiSessionSummary(s.sessions, id, summary);
      if (!record) throw new Error('session not found');
      return record;
    }),
    remove: id => change(s => {
      if (Object.values(s.invocations).some(i => i.sessionId === id && !terminal(i))) {
        throw new Error('Cannot remove a session with an unresolved Host invocation.');
      }
      delete s.sessions.sessions[id];
      for (const [pet, active] of Object.entries(s.sessions.activeSessionIds)) if (active === id) delete s.sessions.activeSessionIds[pet];
    }),
  };
  function transition(id: string, revision: number, allowed: string[], fn: (record: HostInvocation) => void): HostInvocation {
    return change(s => {
      const record = s.invocations[id];
      if (!record || record.revision !== revision || !allowed.includes(record.state)) {
        throw new Error('Host invocation revision/state conflict.');
      }
      fn(record);
      record.revision++;
      record.updatedAt = new Date().toISOString();
      return record;
    });
  }
  const invocations: InvocationStorePort = {
    read: id => read(state.invocations[id] ?? null),
    findAdmission: key => read(Object.values(state.invocations).find(i => i.idempotencyKey === key) ?? null),
    list: pet => read(Object.values(state.invocations).filter(i => i.petId === pet)),
    admit: input => {
      const prior = state.invocations[input.dispatchId] ?? (input.idempotencyKey ? invocations.findAdmission(input.idempotencyKey) : null);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint || prior.request !== input.request
          || prior.scope?.namespace !== input.scope?.namespace || prior.scope?.id !== input.scope?.id || prior.petId !== input.petId || prior.sessionId !== input.sessionId || prior.threadId !== input.threadId) {
          throw new Error('Host invocation idempotency identity conflict.');
        }
        return { record: read(prior), created: false };
      }
      const session = sessions.read(input.sessionId);
      if (!session || session.petId !== input.petId || session.threadId !== input.threadId) throw new Error('Host invocation session identity conflict.');
      return change(s => {
        const now = new Date().toISOString();
        const record: HostInvocation = { ...input, state: 'queued', revision: 0, createdAt: now, updatedAt: now };
        s.invocations[input.dispatchId] = record;
        return { record, created: true };
      });
    },
    bindLegacyQueuedSession: (id, rev, sessionId) => transition(id, rev, ['queued'], i => {
      const session = sessions.read(sessionId);
      if (i.scope || i.runtime || !session || session.petId !== i.petId) throw new Error('Only an unstarted legacy invocation may select its active session.');
      i.sessionId = session.id; i.threadId = session.threadId;
    }),
    claimStart: (id, rev, requestId) => transition(id, rev, ['queued'], i => { i.state = 'running'; i.requestId = requestId; }),
    attachRuntimeIdentity: (id, rev, identity) => transition(id, rev, ['running'], i => {
      if (i.threadId !== identity.threadId || (i.runtime && !sameRuntimeIdentity(i.runtime, identity))) throw new Error('Runtime execution identity conflict.');
      i.runtime = identity;
    }),
    markWaiting: (id, rev, pending) => transition(id, rev, ['running'], i => { i.state = 'waiting'; i.pendingInterrupt = pending; }),
    claimResume: (id, rev, requestId, identity, interruptId) => transition(id, rev, ['waiting'], i => {
      if (!sameRuntimeIdentity(i.runtime, identity) || i.pendingInterrupt?.interruptId !== interruptId) throw new Error('Host invocation resume identity conflict.');
      i.state = 'running'; i.requestId = requestId; delete i.pendingInterrupt;
    }),
    settle: (id, rev, result) => {
      const prior = invocations.read(id);
      if (prior && terminal(prior)) {
        if (prior.state !== result.state || prior.reply !== result.reply || prior.error !== result.error) throw new Error('Host invocation settlement conflict.');
        return prior;
      }
      return transition(id, rev, ['running', 'waiting'], i => {
        Object.assign(i, result); i.settlementId = `${id}:settled`; delete i.pendingInterrupt;
      });
    },
    block: (id, rev, error) => transition(id, rev, ['queued', 'running', 'waiting'], i => { i.state = 'blocked'; i.error = error; delete i.pendingInterrupt; }),
  };
  return { sessions, invocations, configuration: options.configuration ?? hostConfiguration, artifacts: options.artifacts, usage: options.usage };
}
