import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { Command } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { SupervisorDocumentReader } from './capabilityDocuments';
import {
  mergeCapabilityDisclosure,
} from './capabilityDisclosure';
import {
  currentSupervisorInput,
  type SupervisorInvocationState,
  supervisorDisclosureStateSchema,
} from './supervisorState';

export const RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME = 'capability_details';

/** Exact-name disclosure; all state changes still use the existing parallel-safe reducer. */
export function createSupervisorCapabilityDetailsTool(params: {
  documents: SupervisorDocumentReader;
}) {
  return tool(async ({ names }, runtime: ToolRuntime<SupervisorInvocationState>) => {
    const input = currentSupervisorInput(runtime.state);
    const disclosedNames = runtime.state.disclosedCapabilityNames ?? [];
    const prior = mergeCapabilityDisclosure(input.capabilityDisclosure, disclosedNames);
    const requested = [...new Set(names)];
    const alreadyDisclosed = requested.filter((name) => prior.disclosedCapabilityNames.includes(name));
    const unknownNames = requested.filter((name) => !input.catalog.capabilityNames.includes(name));
    const pending = requested.filter((name) => input.catalog.capabilityNames.includes(name)
      && !prior.disclosedCapabilityNames.includes(name));
    const documents = params.documents.readCapabilities(pending, runtime.signal);
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
  }, {
    name: RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME,
    description: '按 manifest 中的完整名称获取 Capability 详情。只做精确名称匹配，不搜索；已披露的名称不重复返回文档。仅在需要进一步了解能力职责时调用。',
    schema: z.object({ names: z.array(z.string().trim().min(1).max(200)).min(1) }).strict(),
  });
}

/** Registers the reducer-backed state channel used by capability_details. */
export function createSupervisorDisclosureStateMiddleware() {
  return createMiddleware({
    name: 'RunSupervisorDisclosureState',
    stateSchema: supervisorDisclosureStateSchema,
  });
}
