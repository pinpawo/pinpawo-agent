import type { StudioDispatchQueue, StudioPluginContext } from '@pinpawo/studio-core';
import type { ChannelService, ChannelSessionBinding } from './channelService';

/** Observation only: admission remains the Host's responsibility. */
export type RoutePetRuntime = {
  /** Start of the bounded sampling window; queue and session reads are not atomic. */
  sampledAt: string;
  sessionState: 'unbound' | 'idle' | 'running' | 'waiting' | 'unknown';
  admissionState: 'open' | 'busy' | 'waiting' | 'blocked' | 'unknown';
  activeScope: 'current-channel' | 'other-channel' | 'other-scope' | 'unscoped' | 'none' | 'unknown';
  /** Pending dispatches for this exact Channel scope and bound session, or unknown. */
  queuedInSession: number | null;
  waitingKind?: string;
};

type Sources = {
  host: Pick<StudioPluginContext, 'listDispatchQueues'> & {
    petSessions: Pick<StudioPluginContext['petSessions'], 'snapshot'>;
  };
  channels: Pick<ChannelService, 'getSession'>;
};

type QueueEntry = NonNullable<StudioDispatchQueue['entries']>[number];
type QueueView = Pick<StudioDispatchQueue, 'state' | 'activeOperation' | 'queuedDispatches'> & {
  entries?: Array<Pick<QueueEntry, 'sessionId' | 'scope'>>;
  activeDispatch?: Pick<QueueEntry, 'sessionId' | 'scope'>;
};

function queueView(queue: StudioDispatchQueue): QueueView {
  const entry = (value: QueueEntry) => ({
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.scope ? { scope: { namespace: value.scope.namespace, id: value.scope.id } } : {}),
  });
  return {
    state: queue.state, activeOperation: queue.activeOperation, queuedDispatches: queue.queuedDispatches,
    ...(queue.entries ? { entries: queue.entries.map(entry) } : {}),
    ...(queue.activeDispatch ? { activeDispatch: entry(queue.activeDispatch) } : {}),
  };
}

function activeScope(queue: QueueView | undefined, channelId: string, binding?: ChannelSessionBinding): RoutePetRuntime['activeScope'] {
  if (!queue) return 'unknown';
  if (queue.activeOperation === null && !queue.activeDispatch) return queue.state === 'busy' ? 'unknown' : 'none';
  if (!queue.activeDispatch) return 'unknown';
  const { scope, sessionId } = queue.activeDispatch;
  if (!scope) return 'unscoped';
  if (scope.namespace !== 'channel') return 'other-scope';
  if (scope.id !== channelId) return 'other-channel';
  return binding && sessionId === binding.sessionId ? 'current-channel' : 'unknown';
}

function queuedInSession(queue: QueueView | undefined, channelId: string, binding?: ChannelSessionBinding): number | null {
  if (!queue || !Number.isSafeInteger(queue.queuedDispatches) || queue.queuedDispatches < 0) return null;
  if (queue.queuedDispatches === 0) return queue.entries?.length ? null : 0;
  if (!binding || !queue.entries || queue.entries.length !== queue.queuedDispatches) return null;
  let count = 0;
  for (const entry of queue.entries) {
    // Old Hosts may expose only some entries, or entries without their target.
    if (!entry.sessionId) return null;
    if (entry.sessionId !== binding.sessionId) continue;
    if (!entry.scope) return null;
    if (entry.scope.namespace === 'channel' && entry.scope.id === channelId) count++;
  }
  return count;
}

/**
 * Read every candidate concurrently, with one deadline for the entire batch.
 * The Host snapshot API has no cancellation parameter: a timed-out read may
 * settle later, but cannot modify returned values or start another read.
 */
export async function collectChannelRoutingState(
  channelId: string,
  petIds: readonly string[],
  sources: Sources,
  options: { timeoutMs?: number; now?: () => Date } = {},
): Promise<Record<string, RoutePetRuntime>> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('Routing state timeout must be positive.');
  const ids = [...new Set(petIds)];
  if (!ids.length) return {};
  const sampledAt = (options.now?.() ?? new Date()).toISOString();
  const queues = new Map<string, QueueView>();
  try {
    for (const queue of sources.host.listDispatchQueues()) queues.set(queue.petId, queueView(queue));
  } catch {
    // An unavailable global queue does not prevent reading a known exact session.
    queues.clear();
  }
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<undefined>(resolve => {
    timer = setTimeout(() => { expired = true; resolve(undefined); }, timeoutMs);
  });
  const read = <T>(operation: () => Promise<T>): Promise<{ value: T } | undefined> => Promise.race([
    Promise.resolve().then(async () => expired ? undefined : { value: await operation() }).catch(() => undefined),
    deadline,
  ]);
  try {
    return Object.fromEntries(await Promise.all(ids.map(async petId => {
      const queue = queues.get(petId);
      const project = (binding?: ChannelSessionBinding): RoutePetRuntime => ({
        sampledAt, sessionState: 'unknown', admissionState: queue?.state ?? 'unknown',
        activeScope: activeScope(queue, channelId, binding), queuedInSession: queuedInSession(queue, channelId, binding),
      });
      const bound = await read(() => sources.channels.getSession(channelId, petId));
      if (!bound) return [petId, project()] as const;
      const binding = bound.value;
      if (!binding) return [petId, { ...project(), sessionState: 'unbound' as const }] as const;
      if (binding.channelId !== channelId || binding.petId !== petId) return [petId, project()] as const;
      const result = project(binding);
      if (!binding.registered) return [petId, result] as const;
      const observed = await read(() => sources.host.petSessions.snapshot(petId, binding.sessionId, { timelineLimit: 1 }));
      if (!observed || observed.value.session.sessionId !== binding.sessionId) return [petId, result] as const;
      const session = observed.value.session;
      result.sessionState = session.activeRun ? 'running' : session.pendingInterrupt ? 'waiting' : 'idle';
      if (result.sessionState === 'waiting') result.waitingKind = session.pendingInterrupt!.payload.kind;
      return [petId, result] as const;
    })));
  } finally {
    expired = true;
    clearTimeout(timer!);
  }
}
