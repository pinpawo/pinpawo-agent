import { isDeepStrictEqual } from 'node:util';
import { hostConfiguration, type HostConfigurationPort } from './configuration';
import type { CapabilityArtifactStore, RuntimeExecutionIdentity } from '@pinpawo/pet-agent';
import { createEmptyTuiSessionState, createTuiSession, createTuiSessionForThread, ensureActiveTuiSession,
  ensureDispatchSession, resumeTuiSession, updateTuiSessionModelProfile, updateTuiSessionSummary,
  type TuiSessionState } from '../session/tuiSessionRegistry';
import type { HostInvocation, HostPersistence, InvocationStorePort, SessionRegistryPort, UsageStorePort } from './contracts';

export type HostPersistenceState = { sessions: TuiSessionState; invocations: Record<string, HostInvocation> };
export function sameRuntimeIdentity(a: RuntimeExecutionIdentity | undefined, b: RuntimeExecutionIdentity): boolean {
  return !!a && a.threadId === b.threadId && a.taskId === b.taskId && a.runId === b.runId;
}
const terminal = (record: HostInvocation) => ['completed', 'failed', 'interrupted'].includes(record.state);

/** Snapshot adapter, also used by the local file adapter. Not a generic backend factory. */
export function createMemoryHostPersistence(options: {
  configuration?: HostConfigurationPort; artifacts?: CapabilityArtifactStore; usage?: UsageStorePort;
  defaultModelProfileId: string; initial?: HostPersistenceState;
  commit?: (state: HostPersistenceState) => Promise<void>;
}): HostPersistence {
  let state = structuredClone(options.initial ?? { sessions: createEmptyTuiSessionState(), invocations: {} });
  let writes: Promise<void> = Promise.resolve();
  async function read<T>(fn: (state: HostPersistenceState) => T): Promise<T> {
    await writes;
    return structuredClone(fn(state));
  }
  function change<T>(fn: (draft: HostPersistenceState) => T): Promise<T> {
    const operation = writes.then(async () => {
      const draft = structuredClone(state);
      const result = fn(draft);
      if (!isDeepStrictEqual(draft, state)) {
        // The writer owns its snapshot; retained references cannot mutate our draft.
        await options.commit?.(structuredClone(draft));
        state = draft;
      }
      return structuredClone(result);
    });
    // Rejections remain observable to the caller, without poisoning later operations.
    writes = operation.then(() => {}, () => {});
    return operation;
  }
  const sessions: SessionRegistryPort = {
    read: id => read(s => s.sessions.sessions[id] ?? null),
    active: pet => read(s => s.sessions.sessions[s.sessions.activeSessionIds[pet] ?? ''] ?? null),
    list: pet => read(s => Object.values(s.sessions.sessions).filter(record => !pet || record.petId === pet)),
    ensureActive: pet => change(s => ensureActiveTuiSession(s.sessions, pet, options.defaultModelProfileId)),
    register: (pet, id, create) => change(s => ensureDispatchSession(s.sessions, pet, id, options.defaultModelProfileId, create)),
    create: (pet, thread) => change(s => thread
      ? createTuiSessionForThread(s.sessions, pet, options.defaultModelProfileId, thread)
      : createTuiSession(s.sessions, pet, options.defaultModelProfileId)),
    select: (pet, id) => change(s => {
      const record = resumeTuiSession(s.sessions, pet, id);
      if (!record) throw new Error('session not found');
      return record;
    }),
    updateProfile: (id, profile) => change(s => {
      const record = s.sessions.sessions[id];
      if (!record) throw new Error('session not found');
      return record.modelProfileId === profile ? record : updateTuiSessionModelProfile(s.sessions, id, profile)!;
    }),
    updateSummary: (id, value) => {
      const summary = structuredClone(value);
      return change(s => {
        if (!s.sessions.sessions[id]) throw new Error('session not found');
        return updateTuiSessionSummary(s.sessions, id, summary)!;
      });
    },
    remove: id => change(s => {
      if (Object.values(s.invocations).some(i => i.sessionId === id && !terminal(i))) {
        throw new Error('Cannot remove a session with an unresolved Host invocation.');
      }
      delete s.sessions.sessions[id];
      for (const [pet, active] of Object.entries(s.sessions.activeSessionIds)) if (active === id) delete s.sessions.activeSessionIds[pet];
    }),
  };
  function transition(id: string, revision: number, allowed: string[], fn: (record: HostInvocation, draft: HostPersistenceState) => void): Promise<HostInvocation> {
    return change(s => {
      const record = s.invocations[id];
      if (!record || record.revision !== revision || !allowed.includes(record.state)) throw new Error('Host invocation revision/state conflict.');
      fn(record, s);
      record.revision++;
      record.updatedAt = new Date().toISOString();
      return record;
    });
  }
  const invocations: InvocationStorePort = {
    read: id => read(s => s.invocations[id] ?? null),
    findAdmission: key => read(s => Object.values(s.invocations).find(i => i.idempotencyKey === key) ?? null),
    list: pet => read(s => Object.values(s.invocations).filter(i => i.petId === pet)),
    admit: value => {
      const input = structuredClone(value);
      return change(s => {
        const prior = s.invocations[input.dispatchId] ?? (input.idempotencyKey
          ? Object.values(s.invocations).find(i => i.idempotencyKey === input.idempotencyKey) : undefined);
        if (prior) {
          if (prior.fingerprint !== input.fingerprint || prior.request !== input.request
            || prior.scope?.namespace !== input.scope?.namespace || prior.scope?.id !== input.scope?.id
            || prior.petId !== input.petId || prior.sessionId !== input.sessionId || prior.threadId !== input.threadId) {
            throw new Error('Host invocation idempotency identity conflict.');
          }
          return { record: prior, created: false };
        }
        const session = s.sessions.sessions[input.sessionId];
        if (!session || session.petId !== input.petId || session.threadId !== input.threadId) throw new Error('Host invocation session identity conflict.');
        const now = new Date().toISOString();
        const record: HostInvocation = { ...input, state: 'queued', revision: 0, createdAt: now, updatedAt: now };
        s.invocations[input.dispatchId] = record;
        return { record, created: true };
      });
    },
    bindLegacyQueuedSession: (id, rev, sessionId) => transition(id, rev, ['queued'], (i, s) => {
      const session = s.sessions.sessions[sessionId];
      if (i.scope || i.runtime || !session || session.petId !== i.petId) throw new Error('Only an unstarted legacy invocation may select its active session.');
      i.sessionId = session.id; i.threadId = session.threadId;
    }),
    claimStart: (id, rev, requestId) => transition(id, rev, ['queued'], i => { i.state = 'running'; i.requestId = requestId; }),
    attachRuntimeIdentity: (id, rev, value) => {
      const identity = structuredClone(value);
      return transition(id, rev, ['running'], i => {
        if (i.threadId !== identity.threadId || (i.runtime && !sameRuntimeIdentity(i.runtime, identity))) throw new Error('Runtime execution identity conflict.');
        i.runtime = identity;
      });
    },
    markWaiting: (id, rev, value) => {
      const pending = structuredClone(value);
      return transition(id, rev, ['running'], i => { i.state = 'waiting'; i.pendingInterrupt = pending; });
    },
    claimResume: (id, rev, requestId, value, interruptId) => {
      const identity = structuredClone(value);
      return transition(id, rev, ['waiting'], i => {
        if (!sameRuntimeIdentity(i.runtime, identity) || i.pendingInterrupt?.interruptId !== interruptId) throw new Error('Host invocation resume identity conflict.');
        i.state = 'running'; i.requestId = requestId; delete i.pendingInterrupt;
      });
    },
    settle: (id, rev, value) => {
      const result = structuredClone(value);
      return change(s => {
        const record = s.invocations[id];
        if (record && terminal(record)) {
          if (record.state !== result.state || record.reply !== result.reply || record.error !== result.error) throw new Error('Host invocation settlement conflict.');
          return record;
        }
        if (!record || record.revision !== rev || !['running', 'waiting'].includes(record.state)) throw new Error('Host invocation revision/state conflict.');
        Object.assign(record, result); delete record.pendingInterrupt;
        record.revision++; record.updatedAt = new Date().toISOString();
        return record;
      });
    },
    block: (id, rev, error) => transition(id, rev, ['queued', 'running', 'waiting'], i => { i.state = 'blocked'; i.error = error; delete i.pendingInterrupt; }),
  };
  return { sessions, invocations, configuration: options.configuration ?? hostConfiguration, artifacts: options.artifacts, usage: options.usage };
}
