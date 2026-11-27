import { createPetHead, isHeadAddressed } from '../../../../packages/studio/src/host/petHead';
import type { createHeadModel } from '../../../../packages/studio/src/host/petHeadModel';
import type { EvalCase } from './cases';
import type { Observation } from './scorer';

/** Production routing with fixed synthetic state and in-memory effect capture. */
export async function exercise(test: EvalCase, model: ReturnType<typeof createHeadModel>, signal: AbortSignal): Promise<Observation> {
  const result = { relevant: isHeadAddressed(test.input), dispatched: false, hasReply: false };
  const source = test.input.context.messages[0];
  const head = createPetHead({
    pet: test.input.pet, description: test.input.description,
    channel: { subscribe: () => () => {}, readContext: async () => test.input.context,
      reply: async (_pet, _source, body) => { result.hasReply ||= !!body.trim(); },
      readBoundSessionId: async () => 's-4f8a',
      dispatch: async () => { result.dispatched = true; } },
    readExecution: async () => ({
      ...(test.state === 'busy' && source ? { active: {
        dispatchId: 'active-work', enqueuedAt: source.occurredAt, origin: { namespace: 'channel', id: source.messageId },
      } } : {}),
      queued: [], recent: [],
    }),

    assessRelevance: async (input, signal) => {
      const relevance = await model.assessRelevance(input, signal);
      result.relevant = isHeadAddressed(input) || relevance.relevant;
      return relevance;
    },
    decideDispatch: model.decideDispatch,
  });
  await head(test.input.message, signal);
  return result;
}
