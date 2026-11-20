import { AIMessage } from '@langchain/core/messages';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import type { StudioModelEndpoint } from '../studioContract';
import type { HeadDecision, HeadInput, HeadMessage } from './petHead';
import type { HeadProgressEvidence } from './petHeadProgress';
import { headDecisionMessages, headReplyMessages } from './petHeadPrompts';

export type HeadDecisionDiagnostic = {
  petId: string; channelId: string; messageId: string;
  outcome: 'selected' | 'ignore' | 'error'; action?: 'ignore' | 'dispatch'; attempts: number; code?: string;
};

const decisionName = 'pet_head_decision';
const decisionSchema = z.object({
  engage: z.boolean(),
  action: z.enum(['ignore', 'dispatch']),
  reply: z.string(),
  intent: z.string(),
  readProgress: z.boolean(),
}).strict();
const addressedSchema = decisionSchema.omit({ engage: true });

class DecisionFailure extends Error {
  constructor(readonly code: string) { super('Invalid Pet Head decision.'); }
}

function failedFinish(message: AIMessage): 'truncated' | 'refusal' | undefined {
  const { finish_reason, stop_reason } = message.response_metadata;
  const reason = finish_reason ?? stop_reason;
  if (reason === 'length' || reason === 'max_tokens') return 'truncated';
  if (reason === 'content_filter' || reason === 'refusal' || reason === 'safety') return 'refusal';
}

type HeadChatClient = ReturnType<NonNullable<StudioModelEndpoint['createChatModel']>>;

/** One lazy client for the active Head. Binding creates a decision view, not another client. */
export function createHeadModel(resolve: () => StudioModelEndpoint, options: { onDiagnostic?: (event: HeadDecisionDiagnostic) => void } = {}) {
  let cached: { method: NonNullable<StudioModelEndpoint['structuredOutputMethod']>; model: HeadChatClient } | undefined;
  function client() {
    if (cached) return cached;
    const endpoint = resolve();
    if (!endpoint.createChatModel) throw new Error('The configured model cannot create a Pet Head model.');
    const model = endpoint.createChatModel({ maxOutputTokens: 512, maxRetries: 0, preferDeterministic: true, streaming: false, purpose: 'pet-head' });
    const method = endpoint.structuredOutputMethod ?? 'jsonMode';
    return cached = { method, model };
  }

  async function decide(input: HeadInput, signal: AbortSignal): Promise<HeadDecision> {
    let attempts = 0;
    const report = (event: Pick<HeadDecisionDiagnostic, 'outcome' | 'action' | 'code'>) => {
      try { options.onDiagnostic?.({ petId: input.pet.petId, channelId: input.message.channelId, messageId: input.message.messageId, attempts, ...event }); } catch { /* Diagnostics cannot change routing. */ }
    };
    // The owning Head has already resolved the canonical participant mention.
    const schema = input.addressed ? addressedSchema : decisionSchema;
    try {
      signal.throwIfAborted();
      const { method, model } = client();
      const structured = model.withStructuredOutput(schema, { name: decisionName, method, includeRaw: true });
      // JSON mode carries no schema on the wire; only this mode needs a prompt copy.
      const format = method === 'jsonMode'
        ? 'Return only a JSON object matching this schema:\n' + JSON.stringify(toJsonSchema(schema), (key, value) => key === '$schema' ? undefined : value)
        : method === 'functionCalling' ? 'Declare the decision using the provided tool.' : '';
      const messages = headDecisionMessages(input, format);
      attempts = 1;
      const { raw, parsed } = await structured.invoke(messages, { signal });
      signal.throwIfAborted();
      if (!AIMessage.isInstance(raw)) throw new DecisionFailure('malformed');
      const failure = failedFinish(raw);
      if (failure) throw new DecisionFailure(failure);
      const tools = raw.tool_calls ?? [];
      if (raw.invalid_tool_calls?.length ||
        (method === 'functionCalling' ? tools.length !== 1 || tools[0]!.name !== decisionName : tools.length !== 0)) {
        throw new DecisionFailure('invalid_tool');
      }
      const validated = schema.safeParse(parsed);
      if (!validated.success) throw new DecisionFailure('malformed');
      const decision = validated.data;
      if ((decision.action === 'dispatch' ? !decision.intent.trim() : decision.intent !== '') ||
        (decision.readProgress && decision.reply !== '') ||
        ('engage' in decision && !decision.engage && (decision.action !== 'ignore' || decision.reply !== '' || decision.readProgress))) {
        throw new DecisionFailure('malformed');
      }
      report(decision.action === 'ignore' && !decision.reply.trim() && !decision.readProgress ? { outcome: 'ignore' } : { outcome: 'selected', action: decision.action });
      return decision;
    } catch (error) {
      report({ outcome: 'error', code: signal.aborted ? 'aborted' : error instanceof DecisionFailure ? error.code : 'provider_error' });
      // Provider errors can contain prompts and credentials. Keep them out of event logs.
      throw new Error(signal.aborted ? 'Pet Head decision aborted.' : 'Invalid Pet Head decision.');
    }
  }

  /** Write only public reply text. Never bind tools, request a decision, or retry. */
  async function composeReply({ message, evidence }: { message: HeadMessage; evidence: HeadProgressEvidence }, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const reply = await client().model.invoke(headReplyMessages(message, evidence), { signal });
    signal.throwIfAborted();
    if (failedFinish(reply)) throw new Error('Pet Head progress reply did not finish.');
    return reply.text.trim();
  }

  return { decide, composeReply };
}
