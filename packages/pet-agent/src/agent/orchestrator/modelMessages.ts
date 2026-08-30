import type { BaseMessage } from '@langchain/core/messages';
import { toolProtocolSafeMessages } from '../messages';
import { projectDelegationAnnouncesForModel } from './delegation';

/**
 * Build the ordered provider message list for an Orchestrator model call that
 * consumes canonical history. Callers own history selection and current-message
 * construction; this boundary owns projection, append order, and protocol repair.
 */
export function buildAgentModelMessages(params: {
  history: readonly BaseMessage[];
  current?: readonly BaseMessage[];
}): BaseMessage[] {
  return toolProtocolSafeMessages(projectDelegationAnnouncesForModel([
    ...params.history,
    ...(params.current ?? []),
  ]));
}
