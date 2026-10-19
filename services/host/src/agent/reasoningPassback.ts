import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import {
  ChatOpenAI,
  ChatOpenAICompletions,
  type ChatOpenAICompletionsCallOptions,
  type ChatOpenAIFields,
  convertMessagesToCompletionsMessageParams,
} from '@langchain/openai';

// Thinking-mode providers (DeepSeek V4, Kimi, ...) return `reasoning_content`
// and reject the next request when an assistant tool-call turn comes back
// without it. LangChain keeps the reasoning on the message (additional_kwargs
// on the legacy stream, a `reasoning` content block on the native event
// stream) but never serializes it back, so the source messages ride along on
// the call options and the request is rebuilt with the field restored.
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
): CompletionsMessageParam[] {
  return messages.flatMap(message => {
    const [first, ...rest] = convertMessagesToCompletionsMessageParams({ messages: [message], model });
    const reasoning = readReasoningContent(message);
    return first?.role === 'assistant' && reasoning
      ? [{ ...first, reasoning_content: reasoning }, ...rest]
      : [first, ...rest].filter(Boolean);
  });
}

/** DeepSeek's cache hit field is not retained by the OpenAI adapter. */
export function normalizeCompletionsCacheUsage<T>(response: T): T {
  if (!response || typeof response !== 'object') return response;
  const record = response as Record<string, unknown>;
  const usage = record.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage.prompt_cache_hit_tokens !== 'number' || !Number.isFinite(usage.prompt_cache_hit_tokens)) return response;
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
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
    return normalizeCompletionsResponse(super.completionWithRetry(
      { ...request, messages: buildCompletionsMessagesWithReasoning(source, this.model) },
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
