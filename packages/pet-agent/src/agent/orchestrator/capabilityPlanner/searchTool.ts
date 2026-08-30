import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import {
  CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  createCapabilityPlannerSearchTool,
  type CapabilityPlannerFileExplorer,
  type CapabilityPlannerSearchResult,
} from './fileExplorer';
import {
  applyCapabilitySearchObservations,
  type CapabilityDisclosureState,
  type CapabilitySearchObservation,
} from './capabilityDisclosure';
import {
  currentPlannerInput,
  type PlannerSearchToolState,
  plannerSearchStateSchema,
} from './plannerState';
import type { CapabilityPlannerInput } from './runner';

type CapabilitySearchLimitResult = {
  readonly ok: false;
  readonly error: {
    readonly code: 'capability_search_round_limit_exceeded';
    readonly message: string;
  };
};

type CapabilitySearchExecutionResult =
  | CapabilityPlannerSearchResult
  | CapabilitySearchLimitResult;

function searchRound(messages: readonly BaseMessage[] | undefined, toolCallId: string) {
  const message = [...(messages ?? [])].reverse().find((candidate) =>
    AIMessage.isInstance(candidate)
    && candidate.tool_calls?.some((toolCall) => toolCall.id === toolCallId),
  );
  if (!message) {
    throw new Error('Capability search has no owning AI message.');
  }
  // Providers normally assign an AI message id. Scripted or legacy providers
  // may not; its complete tool-call batch is still a stable round identity.
  const toolCalls = (message as AIMessage).tool_calls ?? [];
  return {
    id: message.id ?? `tool-batch:${toolCalls
    .map((toolCall) => toolCall.id)
    .sort()
    .join(':')}`,
    searchCallCount: toolCalls.filter(({ name }) =>
      name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
    ).length,
  };
}

function capabilitySearchLimitExceeded(
  state: CapabilityDisclosureState,
): CapabilitySearchLimitResult {
  return {
    ok: false,
    error: {
      code: 'capability_search_round_limit_exceeded',
      message: `Capability search is closed after ${state.maxEmptySearchRounds.toString()} empty search rounds. No search was executed and no new Capability documents were disclosed. Finish planning from the Capability documents and facts already available.`,
    },
  };
}

function formatCapabilitySearchResult(params: {
  payload: CapabilitySearchExecutionResult;
  disclosure: CapabilityDisclosureState;
  priorDisclosure: CapabilityDisclosureState;
  newlyDisclosedCapabilityNames: readonly string[] | null;
  roundSearchCallCount: number;
}) {
  const {
    payload,
    disclosure,
    priorDisclosure,
    newlyDisclosedCapabilityNames,
    roundSearchCallCount,
  } = params;
  const pendingParallelBatch = priorDisclosure.status === 'open'
    && roundSearchCallCount > 1
    && newlyDisclosedCapabilityNames !== null;
  const reportedDisclosure = pendingParallelBatch ? priorDisclosure : disclosure;
  const disclosedCapabilityNames = [...new Set([
    ...reportedDisclosure.disclosedCapabilityNames,
    ...(newlyDisclosedCapabilityNames ?? []),
  ])];
  const planningObjective = pendingParallelBatch
    ? 'Evaluate the complete parallel search batch. If any result disclosed a Capability, this round consumes no empty-search allowance; otherwise it consumes one. Finish planning when a disclosed Capability can deliver the work.'
    : reportedDisclosure.status === 'closed'
      ? 'Discovery is finished. Submit a plan with an already disclosed Capability, or report unavailable when none can deliver the remaining goal.'
      : newlyDisclosedCapabilityNames && newlyDisclosedCapabilityNames.length > 0
        ? 'Evaluate the newly disclosed Capability documents and finish planning as soon as one can deliver the work.'
        : 'Use the routing manifest to make one precise search for the missing executor responsibility, or finish planning when an already disclosed Capability can deliver the work.';
  return JSON.stringify({
    ...payload,
    capabilityDiscovery: {
      status: reportedDisclosure.status,
      emptySearchRounds: reportedDisclosure.emptySearchRounds,
      maxEmptySearchRounds: reportedDisclosure.maxEmptySearchRounds,
      remainingEmptyRounds: Math.max(
        0,
        reportedDisclosure.maxEmptySearchRounds - reportedDisclosure.emptySearchRounds,
      ),
      newlyDisclosedCapabilityNames,
      disclosedCapabilityNames,
      ...(pendingParallelBatch ? {
        roundAccounting: {
          status: 'pending_parallel_batch',
          emptySearchRoundsIfBatchEmpty: Math.min(
            reportedDisclosure.maxEmptySearchRounds,
            reportedDisclosure.emptySearchRounds + 1,
          ),
        },
      } : {}),
    },
    planningObjective,
  });
}

function capabilityNameFromPath(path: string) {
  return path.split('/')[0] ?? '';
}

function expandCapabilityNameTerms(
  terms: readonly string[],
  capabilityNames: readonly string[],
) {
  const expandedTerms = [...terms];
  const normalizedTokens = new Set(terms.flatMap((term) =>
    term.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean),
  ));
  for (const capabilityName of capabilityNames) {
    if (normalizedTokens.has(capabilityName.toLowerCase())
      && !expandedTerms.includes(capabilityName)) {
      expandedTerms.push(capabilityName);
    }
  }
  return expandedTerms;
}

/**
 * capability_search owns its discovery bookkeeping. It writes one immutable
 * observation through Command.update; the reducer makes parallel tool calls
 * safe and later model turns derive empty rounds from their shared AI message.
 */
export function createPlannerCapabilitySearchTool(params: {
  explorerForInput: (input: CapabilityPlannerInput) => CapabilityPlannerFileExplorer;
}) {
  return createCapabilityPlannerSearchTool<PlannerSearchToolState>(
    async (terms, runtime) => {
      const state = runtime.state;
      const observations = state.capabilitySearchObservations ?? [];
      const input = currentPlannerInput(state);
      const priorDisclosure = applyCapabilitySearchObservations(
        input.capabilityDisclosure,
        observations,
      );
      const rawPayload = priorDisclosure.status === 'closed'
        ? capabilitySearchLimitExceeded(priorDisclosure)
        : await params.explorerForInput(input)
          .search(
            expandCapabilityNameTerms(terms, input.workspace.capabilityNames),
            runtime.signal,
          );
      const knownCapabilityNames = new Set(priorDisclosure.disclosedCapabilityNames);
      const payload: CapabilitySearchExecutionResult = rawPayload.ok ? {
        ok: true,
        data: {
          ...rawPayload.data,
          matches: rawPayload.data.matches.filter((match) =>
            !knownCapabilityNames.has(capabilityNameFromPath(match.path)),
          ),
        },
      } : rawPayload;
      const newlyDisclosedCapabilityNames = payload.ok
        ? [...new Set(payload.data.matches
          .map((match) => capabilityNameFromPath(match.path))
          .filter(Boolean))]
        : null;
      const owningRound = searchRound(state.messages, runtime.toolCallId);
      const observation: CapabilitySearchObservation | null = payload.ok ? {
        modelMessageId: owningRound.id,
        toolCallId: runtime.toolCallId,
        disclosedCapabilityNames: newlyDisclosedCapabilityNames ?? [],
      } : null;
      // Return the post-call state to the model. The graph reducer will merge
      // all observations from a parallel tool batch before the next model turn.
      const disclosure = applyCapabilitySearchObservations(
        input.capabilityDisclosure,
        observation ? [...observations, observation] : observations,
      );
      const content = formatCapabilitySearchResult({
        payload,
        disclosure,
        priorDisclosure,
        newlyDisclosedCapabilityNames,
        roundSearchCallCount: owningRound.searchCallCount,
      });
      const messages = [new ToolMessage({
        content,
        name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
        tool_call_id: runtime.toolCallId,
      })];
      if (!payload.ok && payload.error.code === 'capability_search_round_limit_exceeded') {
        return new Command({ update: { messages } });
      }
      return new Command({
        update: {
          messages,
          ...(observation
            ? { capabilitySearchObservations: [observation] }
            : {}),
        },
      });
    },
  );
}

/** Registers the reducer-backed state channel used by capability_search. */
export function createPlannerSearchStateMiddleware() {
  return createMiddleware({
    name: 'CapabilityPlannerSearchState',
    stateSchema: plannerSearchStateSchema,
  });
}
