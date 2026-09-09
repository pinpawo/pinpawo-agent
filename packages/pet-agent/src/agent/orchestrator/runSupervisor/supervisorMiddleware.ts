import { AIMessage, SystemMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { buildRunSupervisorAgentSystemPrompt } from '../prompts/runSupervisorAgent';
import { parseSupervisorCommand } from './protocol';
import { currentSupervisorInput, supervisorCommandContext, supervisorInvocationStateSchema } from './supervisorState';
import { SUPERVISOR_COMMAND_TOOL_NAMES, supervisorCommandToolNamesForMode } from './commandTools';

const commandActions: Record<string, string> = {
  submit_plan: 'execute_plan',
  review_current: 'review_current',
  adjust_plan: 'adjust_plan',
};

/** Validate the whole response before any tool runs; control calls only propose effects. */
export function createSupervisorMiddleware() {
  return createMiddleware({
    name: 'RunSupervisor',
    stateSchema: supervisorInvocationStateSchema,
    wrapModelCall: async (request, handler) => {
      const input = currentSupervisorInput(request.state);
      const allowed = supervisorCommandToolNamesForMode(input.mode, input.inputId.startsWith('human:'));
      const discoveryAllowed = input.mode === 'entry' || input.inputId.startsWith('human:');
      const response = await handler({
        ...request,
        systemMessage: new SystemMessage(buildRunSupervisorAgentSystemPrompt(input.mode)),
        tools: request.tools.filter(({ name }) =>
          (name !== 'capability_details' || discoveryAllowed)
          && (typeof name !== 'string' || !SUPERVISOR_COMMAND_TOOL_NAMES.has(name) || allowed.has(name))),
      });
      if (!AIMessage.isInstance(response)) {
        throw new Error('Supervisor model must return an AIMessage.');
      }
      if (response.invalid_tool_calls?.length) {
        throw new Error('Supervisor response contains invalid tool calls.');
      }
      const calls = response.tool_calls ?? [];
      if (!discoveryAllowed && calls.some(({ name }) => name === 'capability_details')) {
        throw new Error('Capability disclosure is stable during execution; changes require fresh user input.');
      }
      const controls = calls.filter(({ name }) => SUPERVISOR_COMMAND_TOOL_NAMES.has(name));
      if (controls.length > 0) {
        if (calls.length !== 1) {
          throw new Error('Supervisor control proposal must be the only tool call in its response.');
        }
        const call = controls[0];
        if (!allowed.has(call.name)) throw new Error('Supervisor control is invalid in this mode.');
        parseSupervisorCommand({ ...call.args, action: commandActions[call.name] }, supervisorCommandContext(input));
      }
      return response;
    },
  });
}
