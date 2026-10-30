import { ChatAnthropic } from '@langchain/anthropic';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseMessage } from '@langchain/core/messages';

/** Bridge the upstream v3 event metadata mismatch until LangChain fixes it. */
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
        // preserve provider-specific reasoning blocks. Remove this bridge when
        // upstream emits responseMetadata and the two-round regression passes.
        const metadata = (event as typeof event & { metadata?: Record<string, unknown> }).metadata;
        yield { ...event, responseMetadata: { ...metadata, ...event.responseMetadata } };
      } else {
        yield event;
      }
    }
  }

}
