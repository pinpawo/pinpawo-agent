import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import {
  RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME,
  createRunSupervisorDetailsTool,
  type RunSupervisorFileExplorer,
} from './fileExplorer';
import {
  mergeCapabilityDisclosure,
} from './capabilityDisclosure';
import {
  currentSupervisorInput,
  type SupervisorInvocationState,
  supervisorDisclosureStateSchema,
} from './supervisorState';
import type { RunSupervisorInput } from './runner';

/** Exact-name disclosure; all state changes still use the existing parallel-safe reducer. */
export function createSupervisorCapabilityDetailsTool(params: {
  explorerForInput: (input: RunSupervisorInput) => RunSupervisorFileExplorer;
}) {
  return createRunSupervisorDetailsTool<SupervisorInvocationState>(async (names, runtime) => {
    const input = currentSupervisorInput(runtime.state);
    const disclosedNames = runtime.state.disclosedCapabilityNames ?? [];
    const prior = mergeCapabilityDisclosure(input.capabilityDisclosure, disclosedNames);
    const requested = [...new Set(names)];
    const alreadyDisclosed = requested.filter((name) => prior.disclosedCapabilityNames.includes(name));
    const unknownNames = requested.filter((name) => !input.workspace.capabilityNames.includes(name));
    const pending = requested.filter((name) => input.workspace.capabilityNames.includes(name)
      && !prior.disclosedCapabilityNames.includes(name));
    const documents = await params.explorerForInput(input).readCapabilities(pending, runtime.signal);
    const newNames = documents.map(({ capabilityName }) => capabilityName);
    const content = JSON.stringify({
      documents,
      alreadyDisclosed,
      unknownNames,
      guidance: 'documents contains newly provided details. alreadyDisclosed names already have their details in context; no reread is needed. unknownNames are not in the manifest; use exact manifest names. Arrange the plan from the manifest and available information.',
    });
    return new Command({ update: {
      messages: [new ToolMessage({ content, name: RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME, tool_call_id: runtime.toolCallId })],
      disclosedCapabilityNames: newNames,
    } });
  });
}

/** Registers the reducer-backed state channel used by capability_details. */
export function createSupervisorDisclosureStateMiddleware() {
  return createMiddleware({
    name: 'RunSupervisorDisclosureState',
    stateSchema: supervisorDisclosureStateSchema,
  });
}
