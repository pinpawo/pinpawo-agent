import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { Command } from '@langchain/langgraph';
import { SupervisorDocumentError, type SupervisorDocumentReader } from './capabilityDocuments';

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
    let documents;
    try {
      documents = params.documents.readCapabilities(pending, runtime.signal);
    } catch (error) {
      if (!(error instanceof SupervisorDocumentError) || error.code !== 'supervisor_discovery_limit_reached') throw error;
      // A resource limit on a valid request, not a failed run: nothing is
      // disclosed and the model plans from what it already has.
      return new ToolMessage({
        name: RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME, tool_call_id: runtime.toolCallId, status: 'error',
        content: JSON.stringify({
          error: error.message,
          notDisclosed: pending,
          guidance: 'None of the requested documents were disclosed. Plan from the manifest and the details already in context, or request fewer capabilities.',
        }),
      });
    }
    const newNames = documents.map(({ capabilityName }) => capabilityName);
    const content = JSON.stringify({
      documents,
      alreadyDisclosed,
      unknownNames,
      guidance: 'documents contains new details; alreadyDisclosed lists names whose details are already in context; unknownNames lists names absent from the manifest.',
    });
    return new Command({ update: {
      messages: [new ToolMessage({ content, name: RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME, tool_call_id: runtime.toolCallId })],
      disclosedCapabilityNames: newNames,
    } });
  }, {
    name: RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME,
    description: '按 manifest 中的完整名称获取 Capability 详情，只做精确匹配，不搜索。返回新文档、已披露名称和未知名称；已披露的文档不重复返回。',
    schema: z.object({ names: z.array(z.string().trim().min(1).max(200)).min(1) }).strict(),
  });
}
