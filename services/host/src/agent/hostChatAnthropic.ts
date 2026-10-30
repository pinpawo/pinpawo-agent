import { ChatAnthropic, type ChatAnthropicCallOptions } from '@langchain/anthropic';

/** Translate the runtime's common single-tool hint using LangChain's native options. */
export class HostChatAnthropic extends ChatAnthropic {
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
