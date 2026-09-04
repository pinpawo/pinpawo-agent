import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createMiddleware } from 'langchain';
import { toolProtocolSafeMessages } from '../messages';
import { projectDelegationAnnouncesForModel } from './delegation';
import type { SystemPromptSection } from '../../types/systemPrompt';
import { composeSystemPrompt } from './prompts/shared';

type InvokableMessageModel<TOutput extends BaseMessage> = {
  invoke(
    messages: BaseMessage[],
    runnableConfig?: RunnableConfig,
  ): Promise<TOutput>;
};

function providerMessages(messages: readonly BaseMessage[]): BaseMessage[] {
  return toolProtocolSafeMessages(
    projectDelegationAnnouncesForModel(messages),
  );
}

function withSystemPromptSections(
  systemMessage: SystemMessage | undefined,
  sections: readonly SystemPromptSection[],
): SystemMessage | undefined {
  if (!systemMessage || !sections.length) return systemMessage;
  return new SystemMessage(composeSystemPrompt(systemMessage.text, sections));
}

/** Internal LangChain wiring shared by Agent model calls. */
export function createOrchestratorModelInvocationMiddleware(
  systemPromptSections: readonly SystemPromptSection[] = [],
) {
  return createMiddleware({
    name: 'OrchestratorModelInvocation',
    wrapModelCall: (request, handler) => handler({
      ...request,
      messages: providerMessages(request.messages),
      systemMessage: withSystemPromptSections(
        request.systemMessage,
        systemPromptSections,
      ),
    }),
  });
}

export const orchestratorModelInvocationMiddleware =
  createOrchestratorModelInvocationMiddleware();

/** Invoke a direct model with independently owned system and Agent messages. */
export function invokeOrchestratorModel<TOutput extends BaseMessage>(
  model: InvokableMessageModel<TOutput>,
  input: {
    systemMessage: SystemMessage;
    systemPromptSections?: readonly SystemPromptSection[];
    messages: readonly BaseMessage[];
  },
  runnableConfig?: RunnableConfig,
) {
  return model.invoke([
    withSystemPromptSections(
      input.systemMessage,
      input.systemPromptSections ?? [],
    ) ?? input.systemMessage,
    ...providerMessages(input.messages),
  ], runnableConfig);
}
