import type { RunnableConfig } from '@langchain/core/runnables';
import {
  ChatOpenAI,
  type ChatOpenAICallOptions,
  type ChatOpenAIFields,
} from '@langchain/openai';
import type { LlmToolChoiceSupport } from './llmModelPresets';

export type LocalChatModelOptions = {
  toolChoiceSupport?: LlmToolChoiceSupport;
};

/**
 * ChatOpenAI with one provider-compatibility rule: presets whose thinking mode
 * only accepts `tool_choice: auto` reject a forced tool selection, so a forced
 * choice is relaxed to `auto` rather than failing the request.
 *
 * Image handling deliberately lives outside this class. Tools that return
 * images write them into graph state as ordinary messages, so no provider
 * wrapper has to reinterpret message content on the way out.
 */
export class LocalChatOpenAI<
  CallOptions extends ChatOpenAICallOptions = ChatOpenAICallOptions,
> extends ChatOpenAI<CallOptions> {
  private readonly localModelOptions: LocalChatModelOptions;
  private readonly localModelFields: ChatOpenAIFields;

  constructor(fields: ChatOpenAIFields, localModelOptions: LocalChatModelOptions) {
    super(fields);
    this.localModelFields = fields;
    this.localModelOptions = localModelOptions;
  }

  /**
   * `ChatOpenAI.withConfig()` rebuilds a plain `ChatOpenAI`, which would drop
   * this subclass — and `bindTools()` routes through it, so the tool_choice
   * rule would vanish exactly when tools are bound.
   */
  override withConfig(config: RunnableConfig): ChatOpenAI<CallOptions> {
    const model = new LocalChatOpenAI<CallOptions>(
      this.localModelFields,
      this.localModelOptions,
    );
    model.defaultOptions = { ...this.defaultOptions, ...config };
    return model;
  }

  override bindTools(
    tools: Parameters<ChatOpenAI<CallOptions>['bindTools']>[0],
    kwargs?: Parameters<ChatOpenAI<CallOptions>['bindTools']>[1],
  ): ReturnType<ChatOpenAI<CallOptions>['bindTools']> {
    const toolChoice = kwargs?.tool_choice;
    const normalizedKwargs = this.localModelOptions.toolChoiceSupport === 'auto_only'
      && toolChoice !== undefined
      && toolChoice !== 'auto'
      && toolChoice !== 'none'
      ? { ...kwargs, tool_choice: 'auto' } as Partial<CallOptions>
      : kwargs;
    return super.bindTools(tools, normalizedKwargs);
  }
}
