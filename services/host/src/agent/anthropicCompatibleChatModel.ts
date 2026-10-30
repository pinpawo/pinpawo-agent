import { ChatAnthropic, type ChatAnthropicCallOptions } from '@langchain/anthropic';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseMessage } from '@langchain/core/messages';

/** Translate the runtime's common single-tool hint using LangChain's native options. */
export class AnthropicCompatibleChatModel extends ChatAnthropic {
  override async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): ReturnType<ChatAnthropic['_streamChatModelEvents']> {
    for await (const event of super._streamChatModelEvents(messages, options, runManager)) {
      if (event.event === 'message-finish') {
        // The pinned Anthropic integration emits provider metadata in
        // `metadata`, while the pinned Core version aggregates only
        // `responseMetadata`. Retain both so subsequent history round-trips
        // preserve provider-specific reasoning blocks.
        const metadata = (event as typeof event & { metadata?: Record<string, unknown> }).metadata;
        yield { ...event, responseMetadata: { ...metadata, ...event.responseMetadata } };
      } else {
        yield event;
      }
    }
  }

  override invocationParams(
    options?: ChatAnthropicCallOptions & { parallel_tool_calls?: boolean },
  ): ReturnType<ChatAnthropic['invocationParams']> {
    const params = super.invocationParams(options);
    if (options?.parallel_tool_calls === false && params.tools?.length) {
      const choice = params.tool_choice ?? { type: 'auto' as const };
      if (choice.type !== 'none') {
        params.tool_choice = { ...choice, disable_parallel_tool_use: true };
      }
    }
    return params;
  }
}
