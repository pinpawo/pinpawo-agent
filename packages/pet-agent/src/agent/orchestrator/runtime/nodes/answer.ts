import { AIMessage } from '@langchain/core/messages';
import { setAgentMessageMetadata, stampAgentMessageCreatedAt } from '../../../messages';
import type { OrchestratorStateType } from '../../state';
import { readSupervisorReply } from '../../runSupervisor/reply';
import { ORCHESTRATOR_MAX_ITERATIONS } from '../constants';

/** Project the supplied reply once; semantic decisions already belong to Supervisor. */
export function createAnswerNode() {
  return async (state: OrchestratorStateType) => {
    const incompatible = state.runRuntimeFailure === 'checkpoint_incompatible';
    const limit = ORCHESTRATOR_MAX_ITERATIONS;
    const reply = incompatible
      ? '这个任务由旧版本创建，当前版本无法继续。请重新发起或重述任务。'
      : readSupervisorReply(state)
        ?? (state.runIterationCount >= limit
          ? '主流程循环已达到上限，任务尚未验收完成。你可以继续当前任务。'
          : null);
    if (!reply?.trim()) throw new Error('Terminal node requires a supplied reply or runtime stop.');
    return {
      messages: [setAgentMessageMetadata(stampAgentMessageCreatedAt(new AIMessage(reply)), { traceId: state.traceId, runId: state.runId })],
      runRuntimeFailure: null,
      runTerminalError: null,
    };
  };
}
