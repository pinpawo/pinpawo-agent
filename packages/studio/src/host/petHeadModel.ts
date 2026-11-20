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
  engage: z.boolean().describe('Whether this Pet should participate. If false, leave reply and intent empty, choose ignore and do not read progress.'),
  action: z.enum(['ignore', 'dispatch']).describe('Execution only: ignore starts no run; dispatch submits a real, independently executable intent.'),
  reply: z.string().describe('Immediate public text or empty. Leave empty when requesting progress evidence.'),
  intent: z.string().describe('Real execution request only. Exclude progress questions and changes to work already in flight. Nonempty for dispatch; empty for ignore.'),
  readProgress: z.boolean().describe('Request one read of the exact currently running work when asked about it, not for direct reply or dispatch alone.'),
}).strict();
const addressedSchema = decisionSchema.omit({ engage: true });

function decisionFormat(method: NonNullable<StudioModelEndpoint['structuredOutputMethod']>, schema: typeof decisionSchema | typeof addressedSchema): string {
  if (method === 'functionCalling') return 'Return the decision using the declared tool. It is not executed.';
  if (method === 'jsonSchema') return 'Return only the decision matching the output schema.';
  const shape = JSON.stringify(toJsonSchema(schema), (key, value) => key === '$schema' ? undefined : value);
  return 'Return only a JSON object matching this schema, without prose or Markdown:\n' + shape;
}

class DecisionFailure extends Error {
  constructor(readonly code: string) { super('Invalid Pet Head decision.'); }
}

function inspectMessage(raw: unknown): AIMessage {
  if (!AIMessage.isInstance(raw)) throw new DecisionFailure('malformed');
  const { finish_reason, stop_reason } = raw.response_metadata ?? {};
  const finish = finish_reason ?? stop_reason;
  const isRefusal = (block: { type?: unknown } | undefined) => block?.type === 'refusal';
  if (raw.additional_kwargs.refusal || ('refusal' in raw && raw.refusal) ||
    (Array.isArray(raw.content) && raw.content.some(isRefusal)) || raw.contentBlocks.some(isRefusal) ||
    finish === 'content_filter' || finish === 'safety' || finish === 'refusal') throw new DecisionFailure('refusal');
  if (finish === 'length' || finish === 'max_tokens') throw new DecisionFailure('truncated');
  return raw;
}

function responseText(message: AIMessage): string {
  // Translators may drop a provider block or coerce its text before
  // LangChain projects .text. Neither view may hide unsupported output.
  const unsupported = (block: { type?: string; text?: unknown; value?: unknown } | undefined) => {
    if (block?.type === 'text') return typeof block.text !== 'string';
    if (!block?.type) return true;
    if (['reasoning', 'thinking', 'redacted_thinking'].includes(block.type)) return false;
    // The Anthropic translator wraps opaque redacted thinking in non_standard.
    const value = block.value;
    return block.type !== 'non_standard' || !value || typeof value !== 'object' ||
      !('type' in value) || value.type !== 'redacted_thinking';
  };
  if ((Array.isArray(message.content) && message.content.some(unsupported)) || message.contentBlocks.some(unsupported)) {
    throw new DecisionFailure('malformed');
  }
  return message.text;
}

const toolBlocks = new Set(['tool_call', 'tool_call_chunk', 'tool_use', 'server_tool_call', 'server_tool_use',
  'server_tool_call_chunk', 'server_tool_call_result', 'tool_result', 'invalid_tool_call']);
function rejectToolCalls(message: AIMessage): void {
  const isTool = (block: { type?: string } | undefined) => !!block?.type && toolBlocks.has(block.type);
  if (message.tool_calls?.length || message.invalid_tool_calls?.length || message.additional_kwargs.tool_calls?.length ||
    message.additional_kwargs.function_call || (Array.isArray(message.content) && message.content.some(isTool)) || message.contentBlocks.some(isTool)) {
    throw new DecisionFailure('unexpected_tool');
  }
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
    const addressed = input.addressed === true;
    const schema = addressed ? addressedSchema : decisionSchema;
    try {
      signal.throwIfAborted();
      const { method, model } = client();
      const structured = model.withStructuredOutput(schema, { name: decisionName, method, includeRaw: true });
      attempts = 1;
      const { raw, parsed } = await structured.invoke(headDecisionMessages(input, addressed, decisionFormat(method, schema)), { signal });
      signal.throwIfAborted();
      const message = inspectMessage(raw);
      if (method === 'functionCalling') {
        if (message.tool_calls?.length !== 1 || message.tool_calls[0]!.name !== decisionName || message.invalid_tool_calls?.length ||
          message.additional_kwargs.function_call || (message.additional_kwargs.tool_calls?.length ?? 0) > 1) {
          throw new DecisionFailure('invalid_tool');
        }
      } else {
        rejectToolCalls(message);
      }

      // Use the same schema locally, including when the SDK returns a provider-parsed object.
      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        throw new DecisionFailure(method === 'functionCalling' ? 'invalid_tool' : message.text.trim() ? 'malformed' : 'empty_output');
      }
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
    try {
      signal.throwIfAborted();
      const result = await client().model.invoke(headReplyMessages(message, evidence), { signal });
      signal.throwIfAborted();
      const raw = inspectMessage(result);
      rejectToolCalls(raw);
      const text = responseText(raw).trim();
      if (text.startsWith('{') || text.startsWith('```') || /^\[\s*(?:\{|\[)/.test(text)) throw new DecisionFailure('malformed');
      return text;
    } catch {
      throw new Error(signal.aborted ? 'Pet Head progress reply aborted.' : 'Invalid Pet Head progress reply.');
    }
  }

  return { decide, composeReply };
}
