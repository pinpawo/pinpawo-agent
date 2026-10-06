import type { CapabilityArtifactStore } from '@pinpawo/pet-agent';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteHostFile } from './atomicFile';
import { parseTuiSessionState, createEmptyTuiSessionState } from '../session/tuiSessionRegistry';
import { createHostPersistence, type HostPersistenceState } from './hostPersistence';
import type { HostInvocation } from './contracts';

/** Single-writer local adapter. Never silently replace malformed or externally changed state. */
export function createFileHostPersistence(filePath: string, defaultModelProfileId: string, artifacts?: CapabilityArtifactStore) {
  let expected = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
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
        || (['completed', 'failed', 'interrupted'].includes(i.state) && i.settlementId !== `${id}:settled`)
        || (i.idempotencyKey && keys.has(i.idempotencyKey))) throw new Error('Invalid Host invocation identity/state.');
      if (i.idempotencyKey) keys.add(i.idempotencyKey);
    }
    initial = { sessions, invocations };
  }
  return createHostPersistence({ defaultModelProfileId, artifacts, initial, commit: state => {
    const actual = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
    if (actual !== expected) throw new Error('Host persistence changed outside its single writer.');
    const data = JSON.stringify({ ...state.sessions, hostPersistenceVersion: 1, invocations: state.invocations }, null, 2);
    atomicWriteHostFile(filePath, data);
    expected = data;
  } });
}

/** Legacy API compatibility is adapter-owned and never discards invocation data. */
export function loadSessionRegistryCompatibility(defaultModelProfileId: string, filePath: string) {
  try {
    return existsSync(filePath) ? parseTuiSessionState(JSON.parse(readFileSync(filePath, 'utf8')), defaultModelProfileId) : createEmptyTuiSessionState();
  } catch { return createEmptyTuiSessionState(); }
}
export function saveSessionRegistryCompatibility(state: import('../session/tuiSessionRegistry').TuiSessionState, filePath: string) {
  const existing = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : {};
  if (existing.hostPersistenceVersion !== undefined && existing.hostPersistenceVersion !== 1) throw new Error('Unsupported Host persistence version.');
  for (const record of Object.values(existing.invocations ?? {}) as HostInvocation[]) {
    const session = state.sessions[record.sessionId];
    if (!session || session.petId !== record.petId || session.threadId !== record.threadId) throw new Error('Legacy registry write would orphan a Host invocation.');
  }
  atomicWriteHostFile(filePath, JSON.stringify({ ...existing, ...state }, null, 2));
}
