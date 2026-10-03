import type { HostGraphThreadState } from '../agent/agentGraphService';
import type { AgentSessionTurnOptions, AgentSessionTurnResult } from '../agent/chatSessionAdapter';
import {
  copyPetInvocationScope,
  withPetInvocationContext,
  withoutPetInvocationContext,
  type PetInvocationContext,
} from './petInvocationContext';

type TurnRunner = (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>;
type ApprovalBinding = {
  invocation: PetInvocationContext;
  interruptId: string;
  checkpointId: string;
  review: string;
  consumed: Set<string>;
};

function approvalKey(interruptId: string, review: string): string {
  return JSON.stringify([interruptId, review]);
}

/** Host-owned approval associations. A thread is only a guard, never an identity source.
 * Kept outside graph/model state; closing this runtime revokes every association.
 */
export class PetInvocationApprovals {
  private readonly pending = new Map<string, ApprovalBinding>();

  clear(): void { this.pending.clear(); }

  private capture(threadId: string | undefined, state: HostGraphThreadState, invocation: PetInvocationContext, previous?: ApprovalBinding): void {
    if (!threadId || !invocation.scope || !state.checkpointId || !state.acceptsResume
      || state.pendingInterrupt?.payload.kind !== 'human_review') return;
    // Moving the checkpoint alone must not re-arm an already consumed approval.
    const review = JSON.stringify(state.pendingInterrupt.payload);
    const consumed = previous?.consumed ?? new Set<string>();
    if (consumed.has(approvalKey(state.pendingInterrupt.interruptId, review))) return;
    this.pending.set(threadId, {
      invocation: Object.freeze({ ...invocation, scope: copyPetInvocationScope(invocation.scope) }),
      interruptId: state.pendingInterrupt.interruptId,
      checkpointId: state.checkpointId,
      review,
      consumed,
    });
  }

  runDispatch(options: AgentSessionTurnOptions, invocation: PetInvocationContext, run: TurnRunner): Promise<AgentSessionTurnResult> {
    if (!invocation.scope) {
      if (options.setup.input.threadId) this.pending.delete(options.setup.input.threadId);
      return withPetInvocationContext(invocation, () => run(options));
    }
    return this.runScopedDispatch(options, invocation, run);
  }

  private async runScopedDispatch(options: AgentSessionTurnOptions, invocation: PetInvocationContext, run: TurnRunner): Promise<AgentSessionTurnResult> {
    const threadId = options.setup.input.threadId;
    if (invocation.scope) {
      const before = await options.graphService.readThreadState(options.setup);
      if (before.pendingInterrupt) throw new Error('Cannot bind a new dispatch to an existing interrupt.');
    }
    if (threadId) this.pending.delete(threadId);
    const result = await withPetInvocationContext(invocation, () => run(options));
    if (result.status === 'waiting') {
      this.capture(threadId, await options.graphService.readThreadState(options.setup), invocation);
    }
    return result;
  }

  /** Called only after ServerChatHandler validated the authoritative approval and value. */
  async runInteraction(options: AgentSessionTurnOptions, run: TurnRunner): Promise<AgentSessionTurnResult> {
    return withoutPetInvocationContext(async () => {
      const threadId = options.setup.input.threadId;
      const binding = threadId ? this.pending.get(threadId) : undefined;
      if (!binding) return run(options);
      const current = await options.graphService.readThreadState(options.setup);
      if (options.request.kind !== 'resume') {
        // A refused ordinary message must not steal a still-pending approval.
        if (!current.pendingInterrupt || current.pendingInterrupt.payload.kind !== 'human_review') this.pending.delete(threadId!);
        return run(options);
      }
      const pending = current.pendingInterrupt;
      const matches = current.acceptsResume && pending?.payload.kind === 'human_review'
        && pending.interruptId === options.request.resume.interruptId
        && pending.interruptId === binding.interruptId
        && current.checkpointId === binding.checkpointId
        && JSON.stringify(pending.payload) === binding.review;
      // Consume before execution, including failure/cancellation. A replay cannot reacquire it.
      this.pending.delete(threadId!);
      if (!matches) throw new Error('Dispatch approval association is stale or does not match the pending checkpoint.');
      binding.consumed.add(approvalKey(binding.interruptId, binding.review));
      const result = await withPetInvocationContext(binding.invocation, () => run(options));
      if (result.status === 'waiting') {
        this.capture(threadId, await options.graphService.readThreadState(options.setup), binding.invocation, binding);
      }
      return result;
    });
  }
}
