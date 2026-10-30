import { ChatAnthropic, type ChatAnthropicCallOptions, type ChatAnthropicInput } from '@langchain/anthropic';

/** Translate the runtime's common single-tool hint using LangChain's native options. */
export class HostChatAnthropic extends ChatAnthropic {
  private readonly thinkingExplicitlyConfigured: boolean;

  constructor(model: string, fields?: Omit<ChatAnthropicInput, 'model' | 'modelName'>);
  constructor(fields?: ChatAnthropicInput);
  constructor(modelOrFields?: string | ChatAnthropicInput, fields?: Omit<ChatAnthropicInput, 'model' | 'modelName'>) {
    const config = typeof modelOrFields === 'string' ? { ...fields, model: modelOrFields } : modelOrFields;
    super(config);
    this.thinkingExplicitlyConfigured = config?.thinking !== undefined;
  }

  override invocationParams(
    options?: ChatAnthropicCallOptions & { parallel_tool_calls?: boolean },
  ): ReturnType<ChatAnthropic['invocationParams']> {
    const params = super.invocationParams(options);
    // Version 1.4.1 defaults to "disabled", even when the caller left thinking
    // to the provider. Keep its internal default for SDK validation, but omit
    // it from the request unless it was explicitly configured.
    if (!this.thinkingExplicitlyConfigured && this.thinking.type === 'disabled'
      && this.invocationKwargs?.thinking === undefined) {
      delete params.thinking;
    }
    if (options?.parallel_tool_calls === false && params.tools?.length) {
      const choice = params.tool_choice ?? { type: 'auto' as const };
      if (choice.type !== 'none') {
        params.tool_choice = { ...choice, disable_parallel_tool_use: true };
      }
    }
    return params;
  }
}
