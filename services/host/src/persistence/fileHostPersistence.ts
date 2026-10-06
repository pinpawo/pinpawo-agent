import type { HostConfigurationPort } from './configuration';
import type { CapabilityArtifactStore } from '@pinpawo/pet-agent';
import { atomicWriteHostFile, readOptionalHostFile } from './atomicFile';
import { parseTuiSessionState, createEmptyTuiSessionState } from '../session/tuiSessionRegistry';
import { createMemoryHostPersistence, type HostPersistenceState } from './memoryHostPersistence';
import type { HostInvocation } from './contracts';

/** Single-writer local adapter. Never silently replace malformed or externally changed state. */
export async function createFileHostPersistence(filePath: string, defaultModelProfileId: string, artifacts?: CapabilityArtifactStore, configuration?: HostConfigurationPort) {
  let expected = await readOptionalHostFile(filePath);
  let initial: HostPersistenceState = { sessions: createEmptyTuiSessionState(), invocations: {} };
  if (expected !== null) {
    const value = JSON.parse(expected);
    if (!value || ![2, 3, 4].includes(value.version) || !value.sessions || !value.activeSessionIds
      || (value.hostPersistenceVersion !== undefined && value.hostPersistenceVersion !== 1)) throw new Error('Invalid Host persistence registry.');
    const sessions = parseTuiSessionState(value, defaultModelProfileId);
    if (Object.keys(sessions.sessions).length !== Object.keys(value.sessions).length
      || Object.keys(sessions.activeSessionIds).length !== Object.keys(value.activeSessionIds).length) throw new Error('Invalid Host session registry identity.');
    const invocations = value.invocations ?? {};
    if (typeof invocations !== 'object' || Array.isArray(invocations) || invocations === null) throw new Error('Invalid Host invocation registry.');
    const keys = new Set<string>();
    for (const [id, raw] of Object.entries(invocations)) {
      const i = raw as HostInvocation;
      if (!i || typeof i !== 'object' || i.dispatchId !== id || !i.petId || !i.sessionId || !i.threadId
        || typeof i.request !== 'string' || typeof i.fingerprint !== 'string' || !Number.isSafeInteger(i.revision) || i.revision < 0
        || !['queued', 'running', 'waiting', 'completed', 'failed', 'interrupted', 'blocked'].includes(i.state)
        || typeof i.createdAt !== 'string' || typeof i.updatedAt !== 'string'
        || (i.runtime && (i.runtime.threadId !== i.threadId || !i.runtime.taskId || !i.runtime.runId))
        || (i.scope && (typeof i.scope.namespace !== 'string' || typeof i.scope.id !== 'string'))
        || (i.pendingInterrupt && typeof i.pendingInterrupt.interruptId !== 'string')
        || (i.state === 'waiting' && !i.pendingInterrupt)
        || (i.idempotencyKey && keys.has(i.idempotencyKey))) throw new Error('Invalid Host invocation identity/state.');
      if (i.idempotencyKey) keys.add(i.idempotencyKey);
      // Older records stored this derivable field; it is no longer part of state.
      delete (i as HostInvocation & { settlementId?: string }).settlementId;
    }
    initial = { sessions, invocations };
  }
  return createMemoryHostPersistence({ defaultModelProfileId, artifacts, configuration, initial, commit: async state => {
    const actual = await readOptionalHostFile(filePath);
    if (actual !== expected) throw new Error('Host persistence changed outside its single writer.');
    const data = JSON.stringify({ ...state.sessions, hostPersistenceVersion: 1, invocations: state.invocations }, null, 2);
    await atomicWriteHostFile(filePath, data);
    expected = data;
  } });
}

/** Legacy API compatibility is adapter-owned and never discards invocation data. */
export async function loadSessionRegistryCompatibility(defaultModelProfileId: string, filePath: string) {
  const value = await readOptionalHostFile(filePath);
  return value === null ? createEmptyTuiSessionState() : parseTuiSessionState(JSON.parse(value), defaultModelProfileId);
}
export async function saveSessionRegistryCompatibility(state: import('../session/tuiSessionRegistry').TuiSessionState, filePath: string) {
  const value = await readOptionalHostFile(filePath);
  const existing = value === null ? {} : JSON.parse(value);
  if (existing.hostPersistenceVersion !== undefined && existing.hostPersistenceVersion !== 1) throw new Error('Unsupported Host persistence version.');
  for (const record of Object.values(existing.invocations ?? {}) as HostInvocation[]) {
    const session = state.sessions[record.sessionId];
    if (!session || session.petId !== record.petId || session.threadId !== record.threadId) throw new Error('Legacy registry write would orphan a Host invocation.');
  }
  await atomicWriteHostFile(filePath, JSON.stringify({ ...existing, ...state }, null, 2));
}
