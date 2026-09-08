import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import {
  RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME,
  createRunSupervisorDetailsTool,
  type RunSupervisorFileExplorer,
} from './fileExplorer';
import {
  applyCapabilitySearchObservations,
  type CapabilitySearchObservation,
} from './capabilityDisclosure';
import {
  currentSupervisorInput,
  type SupervisorSearchToolState,
  supervisorSearchStateSchema,
} from './supervisorState';
import type { RunSupervisorInput } from './runner';

function disclosureRound(messages: readonly BaseMessage[] | undefined, toolCallId: string) {
  const message = [...(messages ?? [])].reverse().find((candidate) =>
    AIMessage.isInstance(candidate)
    && candidate.tool_calls?.some((toolCall) => toolCall.id === toolCallId),
  );
  if (!message) {
    throw new Error('Capability details has no owning AI message.');
  }
  // Providers normally assign an AI message id. Scripted or legacy providers
  // may not; its complete tool-call batch is still a stable round identity.
  const toolCalls = (message as AIMessage).tool_calls ?? [];
  return {
    id: message.id ?? `tool-batch:${toolCalls
    .map((toolCall) => toolCall.id)
    .sort()
    .join(':')}`,
    detailCallCount: toolCalls.filter(({ name }) =>
      name === RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME,
    ).length,
  };
}

/** Exact-name disclosure; all state changes still use the existing parallel-safe reducer. */
export function createSupervisorCapabilityDetailsTool(params: {
  explorerForInput: (input: RunSupervisorInput) => RunSupervisorFileExplorer;
}) {
  return createRunSupervisorDetailsTool<SupervisorSearchToolState>(async (names, runtime) => {
    const input = currentSupervisorInput(runtime.state);
    const observations = runtime.state.capabilitySearchObservations ?? [];
    const prior = applyCapabilitySearchObservations(input.capabilityDisclosure, observations);
    const requested = [...new Set(names)];
    const alreadyDisclosed = requested.filter((name) => prior.disclosedCapabilityNames.includes(name));
    const unknownNames = requested.filter((name) => !input.workspace.capabilityNames.includes(name));
    const pending = requested.filter((name) => input.workspace.capabilityNames.includes(name)
      && !prior.disclosedCapabilityNames.includes(name));
    const closed = prior.status === 'closed';
    // Document corruption/read-budget failures are architecture errors, not a
    // suggestion to try a different name. Keep the original error path.
    const documents = closed ? [] : await params.explorerForInput(input).readCapabilities(pending, runtime.signal);
    const owningRound = disclosureRound(runtime.state.messages, runtime.toolCallId);
    const observation: CapabilitySearchObservation | null = closed ? null : {
      modelMessageId: owningRound.id, toolCallId: runtime.toolCallId,
      disclosedCapabilityNames: documents.map(({ capabilityName }) => capabilityName),
    };
    const next = applyCapabilitySearchObservations(input.capabilityDisclosure,
      observation ? [...observations, observation] : observations);
    const parallel = !closed && owningRound.detailCallCount > 1;
    const reported = parallel ? prior : next;
    const content = JSON.stringify({
      ok: !closed,
      ...(closed ? { error: { code: 'capability_details_round_limit_exceeded',
        message: 'Capability detail disclosure is closed after the empty-round limit. No documents were read. Use the manifest and information already provided to arrange work or explain the specific capability gap.' } } : {}),
      documents,
      alreadyDisclosed,
      unknownNames,
      capabilityDiscovery: {
        status: reported.status,
        emptySearchRounds: reported.emptySearchRounds,
        maxEmptySearchRounds: reported.maxEmptySearchRounds,
        remainingEmptyRounds: Math.max(0, reported.maxEmptySearchRounds - reported.emptySearchRounds),
        newlyDisclosedCapabilityNames: documents.map(({ capabilityName }) => capabilityName),
        disclosedCapabilityNames: [...new Set([...reported.disclosedCapabilityNames, ...documents.map(({ capabilityName }) => capabilityName)])],
        ...(parallel ? { roundAccounting: { status: 'pending_parallel_batch',
          emptySearchRoundsIfBatchEmpty: Math.min(reported.maxEmptySearchRounds, reported.emptySearchRounds + 1) } } : {}),
      },
      guidance: 'documents contains newly provided details. alreadyDisclosed names already have their details in context; no reread is needed. unknownNames are not in the manifest; use exact manifest names. Arrange the plan from the manifest and available information.',
    });
    return new Command({ update: {
      messages: [new ToolMessage({ content, name: RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME, tool_call_id: runtime.toolCallId })],
      ...(observation ? { capabilitySearchObservations: [observation] } : {}),
    } });
  });
}

/** Registers the reducer-backed state channel used by capability_details. */
export function createSupervisorSearchStateMiddleware() {
  return createMiddleware({
    name: 'RunSupervisorSearchState',
    stateSchema: supervisorSearchStateSchema,
  });
}
