import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { Command, ReducedValue, StateSchema } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { SupervisorDocumentReader } from './capabilityDocuments';

export const RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME = 'capability_details';

/** Exact-name disclosure; all state changes still use the existing parallel-safe reducer. */
export function createSupervisorCapabilityDetailsTool(params: {
  documents: SupervisorDocumentReader;
  capabilityNames: readonly string[];
}) {
  return tool(async ({ names }, runtime: ToolRuntime<{ disclosedCapabilityNames: string[] }>) => {
    const disclosedNames = runtime.state.disclosedCapabilityNames ?? [];
    const requested = [...new Set(names)];
    const alreadyDisclosed = requested.filter((name) => disclosedNames.includes(name));
    const unknownNames = requested.filter((name) => !params.capabilityNames.includes(name));
    const pending = requested.filter((name) => params.capabilityNames.includes(name)
      && !disclosedNames.includes(name));
    const documents = params.documents.readCapabilities(pending, runtime.signal);
    const newNames = documents.map(({ capabilityName }) => capabilityName);
    const content = JSON.stringify({
      documents,
      alreadyDisclosed,
      unknownNames,
      guidance: 'documents contains newly read instructions; alreadyDisclosed lists names read earlier; unknownNames lists names absent from the available list.',
    });
    return new Command({ update: {
      messages: [new ToolMessage({ content, name: RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME, tool_call_id: runtime.toolCallId })],
      disclosedCapabilityNames: newNames,
    } });
  }, {
    name: RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME,
    description: '按能力列表中的完整名称读取使用说明，只做精确匹配。返回新读到的说明、已经读过的名称和未找到的名称；已读说明可在上下文中查看。',
    schema: z.object({ names: z.array(z.string().trim().min(1).max(200)).min(1) }).strict(),
  });
}

/** Only mutable detail-read state lives in createAgent; parallel reads merge names. */
export function createSupervisorDisclosureStateMiddleware() {
  return createMiddleware({
    name: 'RunSupervisorDisclosureState',
    stateSchema: new StateSchema({
      disclosedCapabilityNames: new ReducedValue(z4.array(z4.string()).default([]) as never, {
        inputSchema: z4.array(z4.string()).default([]) as never,
        reducer: (current: string[], next: string[]) => [...new Set([...current, ...next])],
      }),
    }),
  });
}
