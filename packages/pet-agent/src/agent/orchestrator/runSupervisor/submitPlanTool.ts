import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { supervisorControlSchemas, type SupervisorControl } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorHandoffContext } from './controlContext';
import { currentSupervisorTask } from './state';
import { Command } from '@langchain/langgraph';
import type { RunSupervisorState, SupervisorAgentState } from './state';

export function createSubmitPlanTool(context: SupervisorHandoffContext) {
  return tool((args, runtime: ToolRuntime<SupervisorAgentState>) => {
    const state = submitPlan({ ...context, state: runtime.state.runSupervisorState }, args, runtime.toolCallId);
    return new Command({ update: {
      runSupervisorState: state,
      reviewFeedback: null,
      messages: [new ToolMessage({ name: 'submit_plan', tool_call_id: runtime.toolCallId,
        content: JSON.stringify({ plan: state }),
      })],
    } });
  }, {
    name: 'submit_plan',
    schema: supervisorControlSchemas.submit_plan,
    verboseParsingErrors: true,
    description: '建立计划并返回计划事实，由你继续决定下一步。',
  });
}

type SubmitPlanArgs = Extract<SupervisorControl, { name: 'submit_plan' }>['args'];

export function submitPlan(
  context: SupervisorHandoffContext,
  args: SubmitPlanArgs,
  callId: string,
): RunSupervisorState {
  if (args.tasks.some(task => !context.allowedCapabilityNames.includes(task.capability))) {
    throw new SupervisorDecisionError('Plan selects a capability outside the current catalog.');
  }
  if (currentSupervisorTask(context.state) && !context.hasNewUserInput) {
    throw new SupervisorDecisionError('Replacing unfinished work requires fresh user input.');
  }
  return { goal: context.userRequest, plan: args.tasks.map((task, index) => ({
    ...task, id: identity('task', context.runId, callId, String(index)), status: 'pending',
  })) };
}
