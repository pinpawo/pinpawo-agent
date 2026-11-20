import type { StudioModelEndpoint } from '../studioContract';
import { isHeadAddressed, type HeadDecision, type HeadInput, type HeadMessage } from './petHead';
import type { HeadProgressEvidence } from './petHeadProgress';
import { headDecisionMessages, headReplyMessages } from './petHeadPrompts';

export type HeadDecisionDiagnostic = {
  petId: string; channelId: string; messageId: string;
  outcome: 'selected' | 'ignore' | 'error'; action?: 'ignore' | 'dispatch'; attempts: number; code?: string;
};

class DecisionFailure extends Error {
  constructor(readonly code: string, readonly retryable = false) { super('Invalid Pet Head decision.'); }
}
function decisionSchema(addressed: boolean) {
  const properties = {
    ...(addressed ? {} : { engage: { type: 'boolean', description: 'Whether this Pet should participate. If false, leave reply and intent empty, choose ignore and do not read progress.' } }),
    action: { type: 'string', enum: ['ignore', 'dispatch'], description: 'Execution only: ignore starts no run; dispatch submits a real, independently executable intent.' },
    reply: { type: 'string', description: 'Immediate public text or empty. Leave empty when requesting progress evidence.' },
    intent: { type: 'string', description: 'Real execution request only. Exclude progress questions and changes to work already in flight. Nonempty for dispatch; empty for ignore.' },
    readProgress: { type: 'boolean', description: 'Request one read of the exact currently running work when that is what this message asks about. Never needed for a direct reply or dispatch alone.' },
  };
  return { title: 'pet_head_decision', type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function validateDecision(value: unknown, addressed: boolean): HeadDecision {
  const record = fields(value, decisionSchema(addressed).required);
  if ((!addressed && typeof record.engage !== 'boolean') || typeof record.reply !== 'string' ||
    typeof record.intent !== 'string' || typeof record.readProgress !== 'boolean' ||
    (record.action !== 'ignore' && record.action !== 'dispatch') ||
    (record.action === 'dispatch' ? !record.intent.trim() : record.intent !== '') ||
    (record.readProgress && record.reply !== '') ||
    (!addressed && record.engage === false && (record.action !== 'ignore' || record.reply !== '' || record.readProgress))) {
    throw new DecisionFailure('malformed', true);
  }
  return { action: record.action, reply: record.reply, intent: record.intent, readProgress: record.readProgress,
    ...(addressed ? {} : { engage: record.engage as boolean }) };
}

function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.hasOwn(value, key))) throw new DecisionFailure('malformed', true);
  return value as Record<string, unknown>;
}
function inspectMessage(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') throw new DecisionFailure('malformed', true);
  const message = raw as Record<string, any>;
  const finish = message.response_metadata?.finish_reason ?? message.response_metadata?.stop_reason;
  if (message.additional_kwargs?.refusal || message.refusal || (Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'refusal'))) throw new DecisionFailure('refusal');
  if (finish === 'length' || finish === 'max_tokens') throw new DecisionFailure('truncated');
  if (finish === 'content_filter' || finish === 'safety' || finish === 'refusal') throw new DecisionFailure('refusal');
  return message;
}
function rejectEmptyContent(content: unknown): void {
  if ((typeof content === 'string' && !content.trim()) || (Array.isArray(content)
    && content.every(block => block?.type === 'text' && typeof block.text === 'string' && !block.text.trim()))) {
    throw new DecisionFailure('empty_output', true);
  }
}
function parseMessage<T>(raw: unknown, validate: (value: unknown) => T, declaration?: string): T {
  const message = inspectMessage(raw);
  const calls = message.tool_calls as Array<{ name?: string; args?: unknown }> | undefined;
  const invalid = message.invalid_tool_calls as unknown[] | undefined;
  if (invalid?.length) throw new DecisionFailure('invalid_tool');
  if (calls?.length) {
    if (!declaration || calls.length !== 1 || calls[0]!.name !== declaration) throw new DecisionFailure('unexpected_tool');
    try { return validate(calls[0]!.args); }
    catch (error) {
      // A tool declaration that arrived but failed local validation is not
      // missing/old JSON text. Never ask another route to reinterpret it.
      if (error instanceof DecisionFailure) throw new DecisionFailure('invalid_tool');
      throw error;
    }
  }
  // Never execute provider tools or salvage prose/fences into a decision.
  if ((message.additional_kwargs as any)?.tool_calls?.length) throw new DecisionFailure('invalid_tool');
  rejectEmptyContent(message.content);
  let content = message.content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'text') content = content[0].text;
  if (typeof content !== 'string') throw new DecisionFailure('malformed', true);
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new DecisionFailure('malformed', true); }
  return validate(parsed);
}
function rejectToolCalls(raw: Record<string, unknown>): void {
  if ((raw.tool_calls as unknown[])?.length || (raw.invalid_tool_calls as unknown[])?.length || (raw.additional_kwargs as any)?.tool_calls?.length) {
    throw new DecisionFailure('unexpected_tool');
  }
}
function unsupported(error: unknown, params = ['tools', 'response_format', 'response_format.type']): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: number; code?: string; param?: string; error?: { code?: string; param?: string } };
  const code = value.code ?? value.error?.code;
  const param = value.param ?? value.error?.param;
  return (value.status === 400 || value.status === 422) && code === 'unsupported_parameter' &&
    params.includes(param ?? '');
}

type HeadChatClient = ReturnType<NonNullable<StudioModelEndpoint['createChatModel']>>;

/** One lazy client for the active Head. Binding creates a decision view, not another client. */
export function createHeadModel(resolve: () => StudioModelEndpoint, options: { onDiagnostic?: (event: HeadDecisionDiagnostic) => void } = {}) {
  let cached: { jsonMethod: StudioModelEndpoint['structuredOutputMethod']; model: HeadChatClient } | undefined;
  function client() {
    if (cached) return cached;
    const endpoint = resolve();
    if (!endpoint.createChatModel) throw new Error('The configured model cannot create a Pet Head model.');
    const model = endpoint.createChatModel({ maxOutputTokens: 512, maxRetries: 0, preferDeterministic: true, streaming: false, purpose: 'pet-head' });
    return cached = { jsonMethod: endpoint.structuredOutputMethod, model };
  }

  async function decide(input: HeadInput, signal: AbortSignal): Promise<HeadDecision> {
    let attempts = 0;
    const report = (event: Pick<HeadDecisionDiagnostic, 'outcome' | 'action' | 'code'>) => {
      try { options.onDiagnostic?.({ petId: input.pet.petId, channelId: input.message.channelId, messageId: input.message.messageId, attempts, ...event }); } catch { /* Diagnostics cannot change routing. */ }
    };
    const addressed = isHeadAddressed(input);
    const schema = decisionSchema(addressed);
    const validate = (value: unknown) => validateDecision(value, addressed);
    const messages = headDecisionMessages(input, addressed, schema);
    try {
      signal.throwIfAborted();
      const { jsonMethod, model } = client();
      let decision: HeadDecision;
      const invokeJson = async (useProfileFormat: boolean) => {
        signal.throwIfAborted();
        const jsonMessages: Array<[string, string]> = [
          ['system', messages[0]![1] + ' Return only the exact JSON object, without tools, prose, or Markdown.'],
          messages[1]!,
        ];
        if (useProfileFormat && (jsonMethod === 'jsonSchema' || jsonMethod === 'jsonMode') && model.withStructuredOutput) {
          const structured = model.withStructuredOutput(schema, { name: 'pet_head_decision', method: jsonMethod, includeRaw: true });
          attempts++;
          const result = await structured.invoke(jsonMessages, { signal }) as { raw: unknown; parsed?: unknown };
          signal.throwIfAborted();
          const raw = inspectMessage(result.raw);
          rejectToolCalls(raw);
          rejectEmptyContent(raw.content);
          return validate(result.parsed);
        }
        attempts++;
        const result = await model.invoke(jsonMessages, { signal });
        signal.throwIfAborted();
        return parseMessage(result, validate);
      };
      try {
        if (model.bindTools) {
          // One schema declaration. No handler, forced side effect, or tool loop.
          const bound = model.bindTools([{ type: 'function', function: { name: 'pet_head_decision', description: 'Declare the routing decision; this tool is never executed.', parameters: schema } }]);
          attempts++;
          const result = await bound.invoke(messages, { signal });
          signal.throwIfAborted();
          decision = parseMessage(result, validate, 'pet_head_decision');
        } else {
          decision = await invokeJson(true);
        }
      } catch (error) {
        signal.throwIfAborted();
        // One bounded compatibility call. Use the configured JSON format only
        // if the provider explicitly rejects tools; never bypass refusals,
        // truncation, unexpected tool calls, auth, or transient provider errors.
        if (!((error instanceof DecisionFailure && error.retryable) || unsupported(error))) throw error;
        decision = await invokeJson(!!model.bindTools && unsupported(error, ['tools']));
      }
      report(decision.action === 'ignore' && !decision.reply.trim() && !decision.readProgress ? { outcome: 'ignore' } : { outcome: 'selected', action: decision.action });
      return decision;
    } catch (error) {
      report({ outcome: 'error', code: signal.aborted ? 'aborted' : error instanceof DecisionFailure ? error.code : unsupported(error) ? 'unsupported' : 'provider_error' });
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
      const content = raw.content;
      let reply = '';
      if (typeof content === 'string') reply = content;
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') reply += block.text;
          else if (!['reasoning', 'thinking', 'redacted_thinking'].includes(block?.type)) throw new DecisionFailure('malformed');
        }
      } else throw new DecisionFailure('malformed');
      const text = reply.trim();
      if (text.startsWith('{') || text.startsWith('```') || /^\[\s*(?:\{|\[)/.test(text)) throw new DecisionFailure('malformed');
      return text;
    } catch {
      throw new Error(signal.aborted ? 'Pet Head progress reply aborted.' : 'Invalid Pet Head progress reply.');
    }
  }

  return { decide, composeReply };
}
