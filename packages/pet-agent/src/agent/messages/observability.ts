import { dispatchCustomEvent } from '@langchain/core/callbacks/dispatch';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentMessageSelectionDiagnostics } from './query';

export const AGENT_MESSAGE_SELECTION_EVENT = 'agent_message_selection';

export function observeAgentMessageSelection(
  location: string,
  diagnostics: AgentMessageSelectionDiagnostics,
  runnableConfig?: RunnableConfig,
) {
  if (!runnableConfig) return;
  void dispatchCustomEvent(
    AGENT_MESSAGE_SELECTION_EVENT,
    { location, ...diagnostics },
    runnableConfig,
  ).catch(() => {});
}
