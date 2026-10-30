import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import {
  ChatOpenAI,
  ChatOpenAICompletions,
  type ChatOpenAICompletionsCallOptions,
  type ChatOpenAIFields,
  convertMessagesToCompletionsMessageParams,
} from '@langchain/openai';

// DeepSeek's Chat Completions thinking mode requires previous reasoning_content
// when tools are supplied. LangChain currently drops it while serializing:
// https://api-docs.deepseek.com/guides/thinking_mode/
// https://github.com/langchain-ai/langchainjs/issues/10883
// Remove this workaround when the installed adapter round-trips reasoning in
// invoke, legacy streaming and native event streaming with the tests passing.
const SOURCE_MESSAGES = Symbol('pinpawo.reasoningPassback.sourceMessages');

type CompletionsMessageParam = ReturnType<typeof convertMessagesToCompletionsMessageParams>[number];
type ChatModelEvents = ReturnType<ChatOpenAICompletions['_streamChatModelEvents']>;

type CallOptions = ChatOpenAICompletionsCallOptions & {
  [SOURCE_MESSAGES]?: BaseMessage[];
};

function withSourceMessages(
  options: CallOptions,
  messages: BaseMessage[],
): CallOptions {
  return {
    ...options,
    [SOURCE_MESSAGES]: messages,
    // The non-streaming path forwards only `options.options` as request options.
    options: { ...options.options, [SOURCE_MESSAGES]: messages } as CallOptions['options'],
  };
}

export function readReasoningContent(message: BaseMessage): string | undefined {
  if (!AIMessage.isInstance(message)) return undefined;
  const fromKwargs = message.additional_kwargs?.reasoning_content;
  if (typeof fromKwargs === 'string' && fromKwargs.length > 0) return fromKwargs;
  if (!Array.isArray(message.content)) return undefined;
  const fromBlocks = message.content
    .map(block => (block as { type?: unknown; reasoning?: unknown }))
    .filter(block => block.type === 'reasoning' && typeof block.reasoning === 'string')
    .map(block => block.reasoning as string)
    .join('');
  return fromBlocks.length > 0 ? fromBlocks : undefined;
}

export function buildCompletionsMessagesWithReasoning(
  messages: BaseMessage[],
  model: string,
  options: { preserveSystemRole?: boolean; originalMessages?: CompletionsMessageParam[] } = {},
): CompletionsMessageParam[] {
  let offset = 0;
  return messages.flatMap(message => {
    const convertedMessages = convertMessagesToCompletionsMessageParams({ messages: [message], model });
    // Preserve the adapter's actual request, including any other transformations.
    const [converted, ...rest] = options.originalMessages
      ? options.originalMessages.slice(offset, offset + convertedMessages.length)
      : convertedMessages;
    offset += convertedMessages.length;
    // Some OpenAI reasoning models are converted to developer automatically.
    // Preserve the legacy Channel routing wire role only for actual SystemMessages.
    const first = options.preserveSystemRole && SystemMessage.isInstance(message) && converted?.role === 'developer'
      ? { ...converted, role: 'system' as const }
      : converted;
    const reasoning = readReasoningContent(message);
    return first?.role === 'assistant' && reasoning
      ? [{ ...first, reasoning_content: reasoning }, ...rest]
      : [first, ...rest].filter(Boolean);
  });
}

/**
 * Preserve the legacy DeepSeek cache field for LangChain's legacy stream path.
 * The installed SDK preserves it in non-streaming and native v3 responses,
 * but legacy streaming discards it before the application's usage reader.
 * Remove once that path also retains it and the request-level test passes.
 */
export function normalizeCompletionsCacheUsage<T>(response: T): T {
  if (!response || typeof response !== 'object') return response;
  const record = response as Record<string, unknown>;
  const usage = record.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage.prompt_cache_hit_tokens !== 'number'
    || !Number.isSafeInteger(usage.prompt_cache_hit_tokens) || usage.prompt_cache_hit_tokens < 0) return response;
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  if (details?.cached_tokens != null) return response;
  return { ...response, usage: { ...usage, prompt_tokens_details: {
    ...details, cached_tokens: details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
  } } };
}

async function normalizeCompletionsResponse(result: Promise<unknown>) {
  const response = await result;
  if (response && typeof response === 'object' && Symbol.asyncIterator in response) {
    return (async function* () {
      for await (const chunk of response as AsyncIterable<unknown>) yield normalizeCompletionsCacheUsage(chunk);
    })();
  }
  return normalizeCompletionsCacheUsage(response);
}

export class ReasoningPassbackCompletions extends ChatOpenAICompletions {
  constructor(fields: ChatOpenAIFields, private readonly passbackOptions: { legacyMaxTokens?: boolean; preserveSystemRole?: boolean } = {}) {
    super(fields);
  }

  override invocationParams(
    options?: this['ParsedCallOptions'],
    extra?: { streaming?: boolean },
  ): ReturnType<ChatOpenAICompletions['invocationParams']> {
    const params = super.invocationParams(options, extra);
    if (this.passbackOptions.legacyMaxTokens && params.max_completion_tokens !== undefined) {
      params.max_tokens = params.max_completion_tokens;
      delete params.max_completion_tokens;
    }
    return params;
  }

  override _generate(
    messages: BaseMessage[],
    options: CallOptions,
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return super._generate(messages, withSourceMessages(options, messages), runManager);
  }

  override _streamResponseChunks(
    messages: BaseMessage[],
    options: CallOptions,
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    return super._streamResponseChunks(messages, withSourceMessages(options, messages), runManager);
  }

  override _streamChatModelEvents(
    messages: BaseMessage[],
    options: CallOptions,
    runManager?: CallbackManagerForLLMRun,
  ): ChatModelEvents {
    return super._streamChatModelEvents(messages, withSourceMessages(options, messages), runManager);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override completionWithRetry(request: any, requestOptions?: any): any {
    const source: BaseMessage[] | undefined = requestOptions?.[SOURCE_MESSAGES];
    if (!source) return normalizeCompletionsResponse(super.completionWithRetry(request, requestOptions));
    const { [SOURCE_MESSAGES]: _source, ...rest } = requestOptions;
    const needsRewrite = source.some(message => readReasoningContent(message) !== undefined)
      || (this.passbackOptions.preserveSystemRole && source.some(message => SystemMessage.isInstance(message)));
    return normalizeCompletionsResponse(super.completionWithRetry(
      needsRewrite ? { ...request, messages: buildCompletionsMessagesWithReasoning(source, this.model, {
        preserveSystemRole: this.passbackOptions.preserveSystemRole, originalMessages: request.messages,
      }) } : request,
      rest,
    ));
  }
}

/** Every Chat Completions model in the repo, runtime and evals alike, is built here. */
export function createReasoningPassbackChatOpenAI(fields: ChatOpenAIFields): ChatOpenAI {
  return new ChatOpenAI({
    ...fields,
    completions: new ReasoningPassbackCompletions(fields),
  });
}
