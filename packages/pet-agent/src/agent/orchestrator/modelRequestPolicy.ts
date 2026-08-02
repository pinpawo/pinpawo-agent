import type { BaseMessage } from '@langchain/core/messages';
import { createMiddleware, type AnyAgentMiddleware } from 'langchain';
import type { AgentModelRequestPolicy } from '../../types/agent';

export async function prepareModelRequestMessages(
  policy: AgentModelRequestPolicy | undefined,
  messages: readonly BaseMessage[],
): Promise<BaseMessage[]> {
  if (!policy?.prepareMessages) return [...messages];
  return [...await policy.prepareMessages(messages)];
}

export function createModelRequestPolicyMiddleware(
  policy: AgentModelRequestPolicy | undefined,
): AnyAgentMiddleware | null {
  if (!policy?.prepareMessages && !policy?.normalizeToolChoice) return null;

  return createMiddleware({
    name: 'ModelRequestPolicy',
    wrapModelCall: async (request, handler) => {
      const messages = policy.prepareMessages
        ? [...await policy.prepareMessages(request.messages)]
        : request.messages;
      const toolChoice = policy.normalizeToolChoice
        ? policy.normalizeToolChoice(request.toolChoice)
        : request.toolChoice;
      return handler({
        ...request,
        messages,
        toolChoice: toolChoice as typeof request.toolChoice,
      });
    },
  });
}
