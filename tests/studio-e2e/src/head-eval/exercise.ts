import { createPetHead, isHeadAddressed } from '../../../../packages/studio/src/host/petHead';
import type { createHeadModel } from '../../../../packages/studio/src/host/petHeadModel';
import type { EvalCase } from './cases';
import type { Observation } from './scorer';

/** Production routing with fixed synthetic state and in-memory effect capture. */
export async function exercise(test: EvalCase, model: Pick<ReturnType<typeof createHeadModel>, 'assessRelevance' | 'decideNewWorkAndReply' | 'suggestDispatchForExistingWork'>, signal: AbortSignal): Promise<Observation> {
  const result: Observation = { relevant: isHeadAddressed(test.input), delivery: null, hasReply: false };
  const source = test.input.context.messages[0];
  const dispatch = { dispatchId: 'd-7c31', sessionId: 's-4f8a', ...(source ? { messageId: source.messageId } : {}) };
  const head = createPetHead({
    pet: test.input.pet, description: test.input.description,
    channel: { subscribe: () => () => {}, readContext: async () => test.input.context,
      readSession: async (_pet, id) => id ? { status: 'running', requestId: 'r-92a1' } : { status: 'ready' },
      reply: async (_pet, _source, body, _signal, options) => { options?.assertCurrent?.(); result.hasReply ||= !!body.trim(); },
      dispatch: async (_pet, _source, _signal, options) => { result.delivery = options?.kind ?? 'idle-only'; } },
    readWorkState: () => test.state === 'busy' ? { kind: 'active', dispatch } : { kind: test.state },
    assessRelevance: async (input, signal) => {
      const relevance = await model.assessRelevance(input, signal);
      result.relevant = isHeadAddressed(input) || relevance.relevant;
      return relevance;
    },
    decideNewWorkAndReply: model.decideNewWorkAndReply,
    execution: { readRun: () => ({ invocationId: dispatch.dispatchId, sessionId: dispatch.sessionId, requestId: 'r-92a1' }),
      suggestDispatch: model.suggestDispatchForExistingWork },
  });
  await head(test.input.message, signal);
  return result;
}
