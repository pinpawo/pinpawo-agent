import { dispatchCustomEvent } from '@langchain/core/callbacks/dispatch';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentMessageViewManifest } from './manager';

export const AGENT_MESSAGE_VIEW_EVENT = 'agent_message_view';

export function observeAgentMessageView(
  manifest: AgentMessageViewManifest,
  runnableConfig?: RunnableConfig,
) {
  if (!runnableConfig) return;
  void dispatchCustomEvent(
    AGENT_MESSAGE_VIEW_EVENT,
    manifest,
    runnableConfig,
  ).catch(() => {});
}
