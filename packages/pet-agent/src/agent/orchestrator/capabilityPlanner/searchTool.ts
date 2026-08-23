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
  currentPlannerInput,
  type CapabilitySearchObservation,
  type PlannerSearchToolState,
  plannerSearchStateSchema,
} from './plannerState';
import type { CapabilityPlannerInput } from './runner';

const MAX_CAPABILITY_DISCOVERY_HINTS = 50;

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

type CapabilitySearchState = {
  readonly emptyRoundsUsed: number;
  readonly maxEmptyRounds: number;
  readonly status: 'open' | 'closed';
};

function searchRoundId(messages: readonly BaseMessage[] | undefined, toolCallId: string) {
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
  return message.id ?? `tool-batch:${toolCalls
    .map((toolCall) => toolCall.id)
    .sort()
    .join(':')}`;
}

function emptySearchRounds(observations: readonly CapabilitySearchObservation[]) {
  const rounds = new Map<string, boolean>();
  for (const observation of observations) {
    rounds.set(
      observation.modelMessageId,
      Boolean(rounds.get(observation.modelMessageId)) || observation.matched,
    );
  }
  return [...rounds.values()].filter((hasMatch) => !hasMatch).length;
}

function capabilitySearchState(
  observations: readonly CapabilitySearchObservation[],
  maxEmptyRounds: number,
): CapabilitySearchState {
  const emptyRoundsUsed = emptySearchRounds(observations);
  return {
    emptyRoundsUsed,
    maxEmptyRounds,
    status: emptyRoundsUsed >= maxEmptyRounds ? 'closed' : 'open',
  };
}

function capabilitySearchLimitExceeded(
  state: CapabilitySearchState,
): CapabilitySearchLimitResult {
  return {
    ok: false,
    error: {
      code: 'capability_search_round_limit_exceeded',
      message: `Capability search is closed after ${state.maxEmptyRounds.toString()} empty search rounds. No search was executed and no new Capability documents were disclosed. Finish planning from the Capability documents and facts already available.`,
    },
  };
}

function capabilitySearchPlanningGuidance(params: {
  input: CapabilityPlannerInput;
  defaultCandidate: string | null;
  matchedCandidates: readonly string[];
  nextSearchCandidates: readonly string[];
  successfulSpecificMiss: boolean;
  limitExceeded: boolean;
}) {
  const {
    input,
    defaultCandidate,
    matchedCandidates,
    nextSearchCandidates,
    successfulSpecificMiss,
    limitExceeded,
  } = params;
  if (input.mode === 'boundary') {
    const activeCapability = input.activeDelegation.capability;
    return {
      objective: 'stably_advance_existing_plan' as const,
      activeCapability,
      activeCapabilityMatched: activeCapability !== null
        && matchedCandidates.includes(activeCapability),
      capabilityMatchMeaning: 'candidate_document_not_new_task_assignment' as const,
      continueCurrentWhen: 'current_task_still_has_executable_work' as const,
      changePlanWhen: 'latest_evidence_requires_a_minimal_change' as const,
      continueSearchCandidates: nextSearchCandidates,
      reportUnavailableWhen: 'unfinished_goal_has_no_executable_path' as const,
    };
  }
  if (!successfulSpecificMiss && !limitExceeded) return null;
  return {
    objective: 'select_most_specific_capability_for_current_request' as const,
    defaultCandidate,
    ...(defaultCandidate
      ? {
          useDefaultWhen: 'no_more_specific_candidate_can_better_deliver_current_request' as const,
        }
      : {}),
    continueSearchCandidates: nextSearchCandidates,
    reportUnavailableWhen: 'no_available_capability_can_deliver_remaining_work' as const,
  };
}

function formatCapabilitySearchResult(params: {
  payload: CapabilitySearchExecutionResult;
  state: PlannerSearchToolState;
  searchState: CapabilitySearchState;
  currentSearchMatched: boolean | null;
}) {
  const { payload, state, searchState, currentSearchMatched } = params;
  const input = currentPlannerInput(state);
  const matchedCandidates = [...new Set(
    (payload.ok ? payload.data.matches : []).flatMap((match) => {
      const [capabilityName] = match.path.split('/');
      return capabilityName ? [capabilityName] : [];
    }),
  )];
  const defaultCapabilityName = state.defaultCapability?.capabilityName ?? null;
  const availableSpecificCandidates = input.workspace.capabilityNames.filter(
    (capabilityName) => capabilityName !== defaultCapabilityName,
  );
  const discoverableSpecificCandidates = input.mode === 'boundary'
    ? availableSpecificCandidates.filter(
        (capabilityName) => capabilityName !== input.activeDelegation.capability,
      )
    : availableSpecificCandidates;
  const nextSearchCandidates = matchedCandidates.length === 0
    && searchState.status === 'open'
    ? discoverableSpecificCandidates.slice(0, MAX_CAPABILITY_DISCOVERY_HINTS)
    : [];
  const limitExceeded = !payload.ok
    && payload.error.code === 'capability_search_round_limit_exceeded';
  const planningGuidance = capabilitySearchPlanningGuidance({
    input,
    defaultCandidate: input.mode === 'entry' ? defaultCapabilityName : null,
    matchedCandidates,
    nextSearchCandidates,
    successfulSpecificMiss: payload.ok && matchedCandidates.length === 0,
    limitExceeded,
  });
  return JSON.stringify({
    ...payload,
    exploration: {
      status: searchState.status,
      emptyRoundsUsed: searchState.emptyRoundsUsed,
      maxEmptyRounds: searchState.maxEmptyRounds,
      remainingEmptyRounds: Math.max(
        0,
        searchState.maxEmptyRounds - searchState.emptyRoundsUsed,
      ),
      currentSearchMatched,
      specificCandidates: matchedCandidates,
      nextSearchCandidates,
      nextSearchCandidatesComplete: nextSearchCandidates.length
        === discoverableSpecificCandidates.length,
      defaultCandidate: input.mode === 'entry' ? defaultCapabilityName : null,
    },
    ...(planningGuidance ? { planningGuidance } : {}),
  });
}

/**
 * capability_search owns its discovery bookkeeping. It writes one immutable
 * observation through Command.update; the reducer makes parallel tool calls
 * safe and later model turns derive empty rounds from their shared AI message.
 */
export function createPlannerCapabilitySearchTool(params: {
  maxEmptySearchRounds: number;
  explorerForInput: (input: CapabilityPlannerInput) => CapabilityPlannerFileExplorer;
}) {
  return createCapabilityPlannerSearchTool<PlannerSearchToolState>(
    async (terms, runtime) => {
      const state = runtime.state;
      const observations = state.capabilitySearchObservations ?? [];
      const priorSearchState = capabilitySearchState(
        observations,
        params.maxEmptySearchRounds,
      );
      const payload = priorSearchState.status === 'closed'
        ? capabilitySearchLimitExceeded(priorSearchState)
        : await params.explorerForInput(currentPlannerInput(state))
          .search(terms, runtime.signal);
      const currentSearchMatched = payload.ok
        ? payload.data.matches.length > 0
        : null;
      const observation = payload.ok ? {
        modelMessageId: searchRoundId(state.messages, runtime.toolCallId),
        toolCallId: runtime.toolCallId,
        matched: currentSearchMatched === true,
      } : null;
      // Return the post-call state to the model. The graph reducer will merge
      // all observations from a parallel tool batch before the next model turn.
      const searchState = capabilitySearchState(
        observation ? [...observations, observation] : observations,
        params.maxEmptySearchRounds,
      );
      const content = formatCapabilitySearchResult({
        payload,
        state,
        searchState,
        currentSearchMatched,
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
