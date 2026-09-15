import { ChatOpenAICompletions, type OpenAIClient } from '@langchain/openai';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';

const sourceMessages = Symbol('sourceMessages');
type RequestOptions = OpenAIClient.RequestOptions & { [sourceMessages]?: BaseMessage[] };

/** Preserve provider reasoning until @langchain/openai's request converter does so. */
export class ReasoningChatModel extends ChatOpenAICompletions {
  override _generate(...[messages, options, manager]: Parameters<ChatOpenAICompletions['_generate']>) {
    return super._generate(messages, {
      ...options,
      options: { ...options.options, [sourceMessages]: messages } as RequestOptions,
    }, manager);
  }

  override async *_streamResponseChunks(...[messages, options, manager]: Parameters<ChatOpenAICompletions['_streamResponseChunks']>) {
    yield* super._streamResponseChunks(messages, Object.assign({}, options, { [sourceMessages]: messages }), manager);
  }

  override async *_streamChatModelEvents(...[messages, options, manager]: Parameters<ChatOpenAICompletions['_streamChatModelEvents']>) {
    yield* super._streamChatModelEvents(messages, Object.assign({}, options, { [sourceMessages]: messages }), manager);
  }

  override completionWithRetry(request: OpenAIClient.Chat.ChatCompletionCreateParamsStreaming, options?: RequestOptions): Promise<AsyncIterable<OpenAIClient.Chat.Completions.ChatCompletionChunk>>;
  override completionWithRetry(request: OpenAIClient.Chat.ChatCompletionCreateParamsNonStreaming, options?: RequestOptions): Promise<OpenAIClient.Chat.Completions.ChatCompletion>;
  override completionWithRetry(request: OpenAIClient.Chat.ChatCompletionCreateParams, options: RequestOptions = {}) {
    const { [sourceMessages]: messages, ...requestOptions } = options;
    // Match tool calls by identity, not message position (content conversion can expand messages).
    const reasoning = new Map(messages?.flatMap(message => {
      const value = message.additional_kwargs.reasoning_content;
      return typeof value === 'string' && AIMessage.isInstance(message)
        ? (message.tool_calls ?? []).filter(call => call.id).map(call => [call.id!, value] as const)
        : [];
    }));
    const mapped = request.messages.map(message => {
      const value = message.role === 'assistant'
        ? message.tool_calls?.map(call => reasoning.get(call.id)).find(value => value !== undefined)
        : undefined;
      return value === undefined ? message : { ...message, reasoning_content: value };
    });
    if (request.stream) return super.completionWithRetry({ ...request, messages: mapped, stream: true }, requestOptions);
    return super.completionWithRetry({ ...request, messages: mapped, stream: false }, requestOptions);
  }
}
