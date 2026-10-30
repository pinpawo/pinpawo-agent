import { ChatAnthropic } from '@langchain/anthropic';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseMessage } from '@langchain/core/messages';

/** Bridge @langchain/anthropic 1.5.1's v3 metadata for @langchain/core 1.2.13. */
export class AnthropicCompatibleChatModel extends ChatAnthropic {
  override async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): ReturnType<ChatAnthropic['_streamChatModelEvents']> {
    for await (const event of super._streamChatModelEvents(messages, options, runManager)) {
      if (event.event === 'message-finish') {
        // Anthropic emits `metadata.model_provider`; Core aggregates only
        // `responseMetadata`. Without it, the next Messages request drops signed
        // thinking and redacted_thinking from v1 history. Keep the SDK serializer.
        // Remove this bridge when the official-adapter negative controls in
        // anthropic-history.test.ts retain both blocks on the second request.
        const metadata = (event as typeof event & { metadata?: Record<string, unknown> }).metadata;
        yield { ...event, responseMetadata: { ...metadata, ...event.responseMetadata } };
      } else {
        yield event;
      }
    }
  }
}
