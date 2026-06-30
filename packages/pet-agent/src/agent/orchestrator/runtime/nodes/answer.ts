import { AIMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { mainConversationMessages } from '../../messageLanes';
import { buildAnswerSystemPrompt } from '../../prompts';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { readMessageText } from '../../utils';
import {
  getInvokeOptions,
  resolveActor,
} from '../config';

export function createAnswerNode(config: OrchestratorConfig) {
  // Node: answer — the dedicated final-reply node. The decision nodes only route
  // here; this node synthesizes the user-facing reply from the FULL conversation
  // (not the clipped decision digest), so prior subagent results are reproduced
  // faithfully instead of being re-fabricated.
  return async function answerNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const { workdir, runtimeEnvironment } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    // The full main conversation queue. Subagent results already live here as
    // handoff copies (first-class, lane-free), so the answer node just reads main
    // — no need to dig announces out of lanes. Context-compaction summaries are
    // kept (mainConversationMessages only drops lane-tagged messages), since after
    // compaction a summary may be the only surviving record of older results.
    const history = mainConversationMessages(state.messages);
    const response = await config.models.act.invoke(
      [
        new SystemMessage(buildAnswerSystemPrompt({ actor, workdir, runtimeEnvironment })),
        ...history,
      ],
      runnableConfig,
    );
    if (!readMessageText(response).trim()) {
      return { messages: [new AIMessage('我这边暂时没有可展示的回复，麻烦你再说一下需要我做什么。')] };
    }
    return { messages: [response] };
  };
}
