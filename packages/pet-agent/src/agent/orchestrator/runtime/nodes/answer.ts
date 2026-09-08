import { AIMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { setAgentMessageMetadata, stampAgentMessageCreatedAt } from '../../../messages';
import { snapshotRunTaskContinuation } from '../../runSupervisor/session';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { ORCHESTRATOR_MAX_ITERATIONS } from '../constants';

/** Project the supplied reply once; semantic decisions already belong to Supervisor. */
export function createAnswerNode(config: OrchestratorConfig) {
  return async (state: OrchestratorStateType, runnableConfig?: RunnableConfig) => {
    const incompatible = state.runRuntimeFailure === 'checkpoint_incompatible';
    const limit = ORCHESTRATOR_MAX_ITERATIONS;
    const reply = incompatible
      ? '这个任务由旧版本创建，当前版本无法继续。请重新发起或重述任务。'
      : state.runSupervisorReply
        ?? (state.runIterationCount >= limit
          ? '主流程循环已达到上限，任务尚未验收完成。你可以继续当前任务。'
          : null);
    if (!reply?.trim()) throw new Error('Terminal node requires a supplied reply or runtime stop.');
    return {
      messages: [setAgentMessageMetadata(stampAgentMessageCreatedAt(new AIMessage(reply)), { traceId: state.traceId })],
      ...(incompatible ? { taskActiveDelegation: null } : {}),
      runNextDelegation: null,
      runSupervisorSession: null,
      runSupervisorUserMessageId: null,
      taskRunContinuation: incompatible ? null : snapshotRunTaskContinuation({
        activeDelegation: state.taskActiveDelegation,
        supervisorSession: state.runSupervisorSession,
        userRequest: state.runUserRequest,
        traceId: state.traceId,
      }),
      runIterationCount: 0,
      runSupervisorReply: null,
      runRuntimeFailure: null,
      runTerminalError: null,
    };
  };
}
