import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command, Send } from '@langchain/langgraph';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import {
  buildEntryDecisionOutputInstruction,
} from '../../schemas';
import type { CapabilityPlannerDispatch } from '../../capabilityPlanner/runner';
import { readContextCompactionSummaries } from '../../contextCompaction';
import {
  buildCompactionSummaryXmlContext,
  buildEntryDecisionInput,
  buildEntryDecisionSystemPrompt,
  buildJsonEntryDecisionUserGoalInstruction,
  buildRunDelegationSummaryContext,
  buildRuntimeContext,
} from '../../prompts';
import { setPinpetMeta } from '../../messageLanes';
import {
  buildRouteFunctionEntryDecisionInstruction,
  buildRouteFunctionEntryDecisionUserGoalInstruction,
  invokeEntryDecisionOutcome,
  usesRouteFunctionEntryDecision,
  type EntryOutcome,
} from './entryDecisionProtocol';
import { mainMessagesWithoutCompaction } from './conversationContext';
import {
  getInvokeOptions,
  resolveActor,
} from '../config';

export function createEntryDecisionRunner(config: OrchestratorConfig) {
  return async function runEntryDecision(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const context = buildEntryDecisionContext({ config, state, runnableConfig });
    const decision = await invokeEntryDecision({ config, context, runnableConfig });
    const transition = buildEntryDecisionResult({ state, decision });
    return new Command({ update: transition.update, goto: transition.goto });
  };
}

function buildEntryDecisionContext(params: {
  config: OrchestratorConfig;
  state: OrchestratorStateType;
  runnableConfig?: RunnableConfig;
}) {
  const { config, state, runnableConfig } = params;
  const { workdir, runtimeEnvironment } = getInvokeOptions(runnableConfig);
  const actor = resolveActor(config, runnableConfig);
  const contextSummaries = readContextCompactionSummaries(state.messages);
  const compactionContext = buildCompactionSummaryXmlContext(contextSummaries);
  const conversationMessages = [
    ...(compactionContext ? [new AIMessage(compactionContext)] : []),
    ...mainMessagesWithoutCompaction(state.messages)
      .filter((message) => message._getType() === 'human' || message._getType() === 'ai'),
  ];
  const systemPrompt = buildEntryDecisionSystemPrompt({
    actor,
    userGoalInstruction: usesRouteFunctionEntryDecision(config)
      ? buildRouteFunctionEntryDecisionUserGoalInstruction()
      : buildJsonEntryDecisionUserGoalInstruction(),
    outputInstruction: usesRouteFunctionEntryDecision(config)
      ? buildRouteFunctionEntryDecisionInstruction()
      : buildEntryDecisionOutputInstruction(config.decisionStructuredOutput?.method),
  });
  const decisionContextMessage = new HumanMessage(buildEntryDecisionInput({
    runDelegationContext: buildRunDelegationSummaryContext(state.runDelegationSummaries),
    runtimeContext: buildRuntimeContext(workdir, runtimeEnvironment),
  }));
  setPinpetMeta(decisionContextMessage, {
    source: 'entry_decision_context',
    synthetic: true,
  });
  return { conversationMessages, decisionContextMessage, systemPrompt };
}

type EntryDecisionContext = ReturnType<typeof buildEntryDecisionContext>;

async function invokeEntryDecision(params: {
  config: OrchestratorConfig;
  context: EntryDecisionContext;
  runnableConfig?: RunnableConfig;
}) {
  const { config, context, runnableConfig } = params;
  try {
    return await invokeEntryDecisionOutcome({
      config,
      messages: [
        new SystemMessage(context.systemPrompt),
        context.decisionContextMessage,
        ...context.conversationMessages,
      ],
      runnableConfig,
    });
  } catch (error) {
    console.warn('[pet-agent] invalid entry decision structured output:', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function buildEntryDecisionResult(params: {
  state: OrchestratorStateType;
  decision: EntryOutcome;
}) {
  const { state, decision } = params;
  if (decision.kind === 'answer') {
    return {
      goto: 'answer' as const,
      update: {
        runNextDelegation: null,
        runCapabilityPlan: [],
        runUserGoal: null,
      },
    };
  }
  const dispatch: CapabilityPlannerDispatch = {
    mode: 'entry',
    plannerState: {
      runId: state.runId,
      traceId: state.traceId,
      runUserGoal: decision.userGoal,
      runDelegationSummaries: state.runDelegationSummaries,
      runCapabilityPlan: [],
    },
  };
  return {
    goto: new Send('capabilityPlanner', dispatch),
    update: {
      runNextDelegation: null,
      runCapabilityPlan: [],
      runUserGoal: decision.userGoal,
    },
  };
}
