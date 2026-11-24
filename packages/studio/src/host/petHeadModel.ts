import { AIMessage } from '@langchain/core/messages';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import type { StudioModelEndpoint } from '../studioContract';
import type { HeadExecutionInput, HeadNewWorkResult, HeadInput, HeadRelevance, HeadReplyInput, HeadRunningInput, HeadRunningResult } from './petHead';
import { headNewWorkMessages, headRelevanceMessages, headReplyMessages, headRunningMessages } from './petHeadPrompts';

export type HeadRelevanceDiagnostic = {
  petId: string; channelId: string; messageId: string;
  outcome: 'related' | 'unrelated' | 'error'; attempts: number; code?: string;
};

const relevanceSchema = z.object({ relevant: z.boolean() }).strict();
const idleSchema = z.object({ shouldDispatch: z.boolean(), reply: z.union([z.string(), z.null()]) }).strict();
// JSON mode cannot enforce our schema on the provider. An omitted optional
// acknowledgement is equivalent to null, but the work decision is mandatory.
const idleJsonModeSchema = idleSchema.partial({ reply: true });
const runningSchema = z.object({ delivery: z.enum(['queue', 'interrupt']).nullable(), reply: z.string().nullable() }).strict();
const runningJsonModeSchema = runningSchema.partial({ reply: true });

class StructuredFailure extends Error {
  constructor(readonly code: string) { super('Invalid Pet Head model output.'); }
}

function failedFinish(message: AIMessage): 'truncated' | 'refusal' | undefined {
  const { finish_reason, stop_reason } = message.response_metadata;
  const reason = finish_reason ?? stop_reason;
  if (reason === 'length' || reason === 'max_tokens') return 'truncated';
  if (reason === 'content_filter' || reason === 'refusal' || reason === 'safety') return 'refusal';
}

type HeadChatClient = ReturnType<NonNullable<StudioModelEndpoint['createChatModel']>>;
type StructuredOutputMethod = NonNullable<StudioModelEndpoint['structuredOutputMethod']>;

/** One lazy client for the active Head. Each structured call binds only its own contract. */
export function createHeadModel(resolve: () => StudioModelEndpoint, options: { onDiagnostic?: (event: HeadRelevanceDiagnostic) => void } = {}) {
  let cached: { method: StructuredOutputMethod; model: HeadChatClient } | undefined;
  function client() {
    if (cached) return cached;
    const endpoint = resolve();
    if (!endpoint.createChatModel) throw new Error('The configured model cannot create a Pet Head model.');
    const model = endpoint.createChatModel({ maxOutputTokens: 512, maxRetries: 0, preferDeterministic: true, streaming: false, purpose: 'pet-head' });
    const method = endpoint.structuredOutputMethod ?? 'jsonMode';
    return cached = { method, model };
  }

  async function runStructured<Schema extends z.AnyZodObject>(
    name: string,
    schemaForMethod: (method: StructuredOutputMethod) => Schema,
    jsonExample: z.input<Schema>,
    messages: (format: string) => Array<[string, string]>,
    signal: AbortSignal,
    onInvoke?: () => void,
  ): Promise<z.infer<Schema>> {
    signal.throwIfAborted();
    const { method, model } = client();
    const schema = schemaForMethod(method);
    const structured = model.withStructuredOutput(schema, { name, method, includeRaw: true });
    // JSON mode carries no schema on the wire; show both the format and schema.
    const format = method === 'jsonMode'
      ? 'Return only a JSON object. Format example (not a decision):\n' + JSON.stringify(jsonExample)
        + '\nThe JSON object must match this schema:\n' + JSON.stringify(toJsonSchema(schema), (key, value) => key === '$schema' ? undefined : value)
      : method === 'functionCalling' ? 'Return the result using the provided tool.' : '';
    const prompt = messages(format);
    onInvoke?.();
    const { raw, parsed } = await structured.invoke(prompt, { signal });
    signal.throwIfAborted();
    if (!AIMessage.isInstance(raw)) throw new StructuredFailure('malformed');
    const failure = failedFinish(raw);
    if (failure) throw new StructuredFailure(failure);
    const tools = raw.tool_calls ?? [];
    if (raw.invalid_tool_calls?.length ||
      (method === 'functionCalling' ? tools.length !== 1 || tools[0]!.name !== name : tools.length !== 0)) {
      throw new StructuredFailure('invalid_tool');
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) throw new StructuredFailure('malformed');
    return validated.data as z.infer<Schema>;
  }

  async function assessRelevance(input: HeadInput, signal: AbortSignal): Promise<HeadRelevance> {
    let attempts = 0;
    const report = (event: Pick<HeadRelevanceDiagnostic, 'outcome' | 'code'>) => {
      try { options.onDiagnostic?.({ petId: input.pet.petId, channelId: input.message.channelId, messageId: input.message.messageId, attempts, ...event }); }
      catch { /* Diagnostics cannot change behavior. */ }
    };
    try {
      const result = await runStructured('pet_head_relevance', () => relevanceSchema, { relevant: true }, format => headRelevanceMessages(input, format), signal,
        () => { attempts = 1; });
      report({ outcome: result.relevant ? 'related' : 'unrelated' });
      return result;
    } catch (error) {
      report({ outcome: 'error', code: signal.aborted ? 'aborted' : error instanceof StructuredFailure ? error.code : 'provider_error' });
      // Provider errors can contain prompts and credentials. Keep them out of event logs.
      throw new Error(signal.aborted ? 'Pet Head relevance check aborted.' : 'Invalid Pet Head relevance result.');
    }
  }

  async function decideNewWorkAndReply(input: HeadInput, signal: AbortSignal): Promise<HeadNewWorkResult> {
    try {
      const result = await runStructured('pet_head_idle', method => method === 'jsonMode' ? idleJsonModeSchema : idleSchema,
        { shouldDispatch: false, reply: null }, format => headNewWorkMessages(input, format), signal);
      return { shouldDispatch: result.shouldDispatch, reply: result.reply ?? null };
    } catch {
      throw new Error(signal.aborted ? 'Pet Head idle handler aborted.' : 'Invalid Pet Head idle result.');
    }
  }

  async function decideRunning(input: HeadRunningInput, signal: AbortSignal): Promise<HeadRunningResult> {
    try {
      const result = await runStructured('pet_head_running', method => method === 'jsonMode' ? runningJsonModeSchema : runningSchema,
        { delivery: null, reply: null }, format => headRunningMessages(input, format), signal);
      return { delivery: result.delivery, reply: result.reply ?? null };
    } catch {
      throw new Error(signal.aborted ? 'Pet Head running decision aborted.' : 'Invalid Pet Head running decision.');
    }
  }

  /** Write only public reply text. Never bind tools, request another judgment, or retry. */
  async function composeReply(input: HeadReplyInput, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const reply = await client().model.invoke(headReplyMessages(input), { signal });
    signal.throwIfAborted();
    if (failedFinish(reply)) throw new Error('Pet Head progress reply did not finish.');
    return reply.text.trim();
  }

  async function decideExecutionHandling(input: HeadExecutionInput, signal: AbortSignal): Promise<HeadRunningResult> {
    const { evidence, source, message } = input;
    if (evidence.status === 'running' && source) return decideRunning({ ...input, evidence, source }, signal);
    return { delivery: null, reply: await composeReply({ message, evidence, source }, signal) };
  }

  return { assessRelevance, decideNewWorkAndReply, decideExecutionHandling, composeReply };
}
