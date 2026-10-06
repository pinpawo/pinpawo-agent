import type { RuntimeExecutionIdentity } from '@pinpawo/pet-agent';
import type { PendingInterruptProjection } from '@pinpawo/agent-session';
import type { AgentSessionTurnOptions, AgentSessionTurnResult } from '../agent/chatSessionAdapter';
import type { HostGraphService } from '../agent/agentGraphService';
import type { ServerTuiSessionService } from '../session/serverTuiSessions';
import type { PetDispatchLifecycleEvent } from '../host/contracts';
import { readPetInvocationContext, withPetInvocationContext, withoutPetInvocationContext } from '../host/petInvocationContext';
import { projectPendingInterrupt } from '../conversation/pendingInterruptProjection';
import { sameRuntimeIdentity } from './memoryHostPersistence';
import type { HostInvocation, InvocationStorePort } from './contracts';

/** Joins Host admission to public runtime execution boundaries, never checkpoint layout. */
export class HostInvocationService {
  constructor(private readonly store: InvocationStorePort,
    private readonly publish: (event: PetDispatchLifecycleEvent) => void) {}

  private event(record: HostInvocation): PetDispatchLifecycleEvent {
    return { revision: record.revision, dispatchId: record.dispatchId, request: record.request, sessionId: record.sessionId,
      state: record.state === 'blocked' ? 'failed' : record.state,
      ...(record.requestId ? { requestId: record.requestId } : {}), ...(record.scope ? { scope: record.scope } : {}),
      ...(record.pendingInterrupt ? { pendingInterrupt: record.pendingInterrupt } : {}),
      ...(record.reply !== undefined ? { reply: record.reply } : {}), ...(record.error ? { error: record.error } : {}) };
  }
  async replay(petId: string): Promise<void> {
    for (const record of await this.store.list(petId)) this.publish(this.event(record));
  }
  async observe(event: PetDispatchLifecycleEvent): Promise<void> {
    let record = await this.store.read(event.dispatchId);
    if (!record) throw new Error('Dispatch has no durable Host admission.');
    if (record.requestId && event.state !== 'running' && event.requestId && record.requestId !== event.requestId) {
      throw new Error('Late dispatch chunk cannot settle a different request.');
    }
    if (event.state === 'running') {
      if (record.state === 'queued') record = await this.store.claimStart(record.dispatchId, record.revision, event.requestId!);
      else if (record.state !== 'running' || record.requestId !== event.requestId) throw new Error('Dispatch chunk identity/state conflict.');
    } else if (event.state === 'waiting') {
      if (!event.pendingInterrupt) throw new Error('Waiting dispatch has no runtime interrupt.');
      record = await this.store.markWaiting(record.dispatchId, record.revision, event.pendingInterrupt);
    } else if (['completed', 'failed', 'interrupted'].includes(event.state)) {
      record = await this.store.settle(record.dispatchId, record.revision, {
        state: event.state as 'completed' | 'failed' | 'interrupted',
        ...(event.reply !== undefined ? { reply: event.reply } : {}), ...(event.error ? { error: event.error } : {}),
      });
    } else if (record.state !== 'queued') return;
    this.publish(this.event(record));
  }
  private async attach(dispatchId: string, identity: RuntimeExecutionIdentity): Promise<void> {
    const record = (await this.store.read(dispatchId))!;
    if (record.runtime && sameRuntimeIdentity(record.runtime, identity)) return;
    await this.store.attachRuntimeIdentity(dispatchId, record.revision, identity);
  }

  async runTurn(options: AgentSessionTurnOptions, petId: string,
    run: (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>): Promise<AgentSessionTurnResult> {
    const admitted = readPetInvocationContext();
    if (admitted) {
      const record = await this.store.read(admitted.dispatchId);
      if (!record || record.petId !== petId || record.sessionId !== options.sessionId || record.threadId !== options.setup.input.threadId) throw new Error('Admitted Host turn identity mismatch.');
      return run({ ...options, onExecutionIdentity: async identity => {
        await this.attach(admitted.dispatchId, identity); await options.onExecutionIdentity?.(identity);
      } });
    }
    if (options.request.kind !== 'resume') return withoutPetInvocationContext(() => run(options));
    const request = options.request;
    const threadId = options.setup.input.threadId;
    const candidates = (await this.store.list(petId)).filter(i => i.threadId === threadId && ['waiting', 'running', 'blocked'].includes(i.state));
    const matching = candidates.filter(i => i.pendingInterrupt?.interruptId === request.resume.interruptId);
    if (!matching.length && !candidates.length) return withoutPetInvocationContext(() => run(options));
    if (matching.length !== 1 || matching[0]!.state !== 'waiting') throw new Error('Host invocation resume association is missing, ambiguous or already claimed.');
    let record = matching[0]!;
    if (record.sessionId !== options.sessionId) throw new Error('Host invocation resume session identity mismatch.');
    const descriptor = await options.graphService.readExecutionDescriptor(options.setup);
    if (!descriptor.identity || !sameRuntimeIdentity(record.runtime, descriptor.identity)
      || descriptor.state !== 'waiting' || descriptor.pendingInterrupt?.interruptId !== request.resume.interruptId) {
      record = await this.store.block(record.dispatchId, record.revision, 'Runtime recovery identity does not match Host invocation.');
      this.publish(this.event(record));
      throw new Error(record.error);
    }
    record = await this.store.claimResume(record.dispatchId, record.revision, request.requestId, descriptor.identity, request.resume.interruptId);
    this.publish(this.event(record));
    let pending: PendingInterruptProjection | undefined;
    let executionFinished = false;
    try {
      const result = await withPetInvocationContext({ petId, dispatchId: record.dispatchId, sessionId: record.sessionId, scope: record.scope },
        () => run({ ...options, onExecutionIdentity: async identity => {
          await this.attach(record.dispatchId, identity); await options.onExecutionIdentity?.(identity);
        }, emitEvent: event => {
          if (event.type === 'interrupt.requested') pending = event.pendingInterrupt;
          options.emitEvent(event);
        } }));
      executionFinished = true;
      if (result.status === 'interrupted') {
        const settled = await options.graphService.settleAbortedRun(options.setup);
        if (settled) pending = projectPendingInterrupt(settled);
      }
      await this.observe({ ...this.event(record), requestId: request.requestId,
        state: result.status === 'waiting' || pending ? 'waiting' : result.status,
        ...(pending ? { pendingInterrupt: pending } : {}),
        ...(result.status === 'completed' ? { reply: result.reply } : {}) });
      return result;
    } catch (error) {
      if (executionFinished) throw error;
      await this.observe({ ...this.event(record), requestId: request.requestId, state: 'failed',
        error: error instanceof Error ? error.message : 'Runtime failed.' });
      throw error;
    }
  }

  async reconcile(petId: string, sessions: ServerTuiSessionService, graph: HostGraphService,
    setup: (sessionId: string) => Promise<AgentSessionTurnOptions['setup']>): Promise<void> {
    for (const record of await this.store.list(petId)) {
      if (!['queued', 'running', 'waiting'].includes(record.state)) continue;
      // I/O failures are retryable startup failures, not evidence of a bad association.
      // Only confirmed mismatches/unknown outcomes transition the invocation to blocked.
      const session = await sessions.getSession(petId, record.sessionId);
      if (!session || session.threadId !== record.threadId || !record.runtime) {
        await this.store.block(record.dispatchId, record.revision, 'Host restart has no confirmed runtime association; explicit repair required.');
        continue;
      }
      const descriptor = await graph.readExecutionDescriptor(await setup(record.sessionId));
      if (!descriptor.identity || !sameRuntimeIdentity(record.runtime, descriptor.identity)) {
        await this.store.block(record.dispatchId, record.revision, 'Host restart runtime identity mismatch; explicit repair required.');
        continue;
      }
      if (descriptor.state === 'waiting' && descriptor.pendingInterrupt) {
        const pending = projectPendingInterrupt(descriptor.pendingInterrupt);
        if (record.state === 'running') await this.store.markWaiting(record.dispatchId, record.revision, pending);
        else if (record.state !== 'waiting' || record.pendingInterrupt?.interruptId !== pending.interruptId) {
          await this.store.block(record.dispatchId, record.revision, 'Host restart pending interrupt mismatch.');
        }
      } else if (descriptor.state === 'completed' || descriptor.state === 'failed') {
        await this.store.settle(record.dispatchId, record.revision, { state: descriptor.state,
          ...(descriptor.reply !== undefined ? { reply: descriptor.reply } : {}), ...(descriptor.error ? { error: descriptor.error } : {}) });
      } else {
        await this.store.block(record.dispatchId, record.revision, 'Host restart execution outcome unknown; external actions will not be replayed.');
      }
    }
  }
}
