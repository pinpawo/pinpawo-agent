import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { searchCapabilities } from '../src/agent/orchestrator/capabilitySearch.ts';
import {
  buildCapabilityPlanningDecisionInput,
  buildCapabilityPlanningDecisionSystemPrompt,
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildPreparedRequestContext,
  buildRouteDecisionInput,
  buildRouteDecisionSystemPrompt,
  buildRouteTargetsContext,
  buildRunDelegationSummaryContext,
  buildRuntimeContext,
  buildSubagentAnnounceContext,
  buildTaskDecisionInput,
  buildTaskDecisionSystemPrompt,
} from '../src/agent/orchestrator/prompts.ts';
import {
  buildCapabilityPlanningDecisionOutputInstruction,
  buildCapabilityPlanningDecisionSchema,
  buildDelegationOutcomeDecisionOutputInstruction,
  buildDelegationOutcomeDecisionSchema,
  buildOrchestrationDecisionStructuredOutputOptions,
  buildRouteDecisionOutputInstruction,
  buildRouteDecisionSchema,
  buildTaskDecisionOutputInstruction,
  buildTaskDecisionSchema,
} from '../src/agent/orchestrator/schemas.ts';
import type { AgentModels } from '../src/types/agent.ts';
import type { AgentCapability } from '../src/types/capability.ts';
import type { StructuredOutputMethod } from '../src/utils/structuredOutput.ts';
import {
  adaptTaskDecisionMode,
  derivePlanningMetrics,
  scoreCapabilityDecision,
  scoreCapabilityPlanning,
  scoreEntryDecision,
  scoreOutcomeDecision,
  type DecisionContractScore,
} from './decision-contract-scorers.ts';
import {
  capabilityDecisionBasicsDataset,
  capabilityPlanningBasicsDataset,
  entryDecisionBasicsDataset,
  outcomeDecisionBasicsDataset,
} from './datasets/index.ts';
import type { CapabilityDecisionBasicsInput } from './datasets/capability-decision-basics.ts';

export type DecisionEvalTarget = 'entry' | 'planner' | 'capability' | 'outcome';

export type RenderedDecisionPrompt = {
  system: string;
  input: string;
  conversationMessages?: BaseMessage[];
};

export type DecisionEvalRunResult = {
  output: Record<string, unknown>;
  scores: DecisionContractScore[];
  verdict: string;
  shape: string;
};

export type DecisionEvalScenario = {
  target: DecisionEvalTarget;
  datasetName: string;
  caseId: string;
  caseName: string;
  expectedSummary: string;
  render(method?: StructuredOutputMethod): RenderedDecisionPrompt;
  run(model: AgentModels['act'], method?: StructuredOutputMethod): Promise<DecisionEvalRunResult>;
};

const actor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'decision-eval',
  personality: null,
  stage: null,
  species: null,
};

function messages(target: DecisionEvalTarget, prompt: RenderedDecisionPrompt) {
  return prompt.conversationMessages
    ? [
        new SystemMessage(prompt.system),
        target === 'entry' ? new AIMessage(prompt.input) : new HumanMessage(prompt.input),
        ...prompt.conversationMessages,
      ]
    : [new SystemMessage(prompt.system), new HumanMessage(prompt.input)];
}

function entryScenarios(): DecisionEvalScenario[] {
  return entryDecisionBasicsDataset.cases.map((testCase) => {
    const render = (method?: StructuredOutputMethod): RenderedDecisionPrompt => {
      const conversationMessages = [
        ...(testCase.input.conversationContext?.map((text) => new AIMessage(text)) ?? []),
        new HumanMessage(testCase.input.userRequest),
      ];
      return {
        system: buildTaskDecisionSystemPrompt({
          actor,
          outputInstruction: buildTaskDecisionOutputInstruction(method),
        }),
        input: buildTaskDecisionInput({
          runDelegationContext: buildRunDelegationSummaryContext([]),
          runtimeContext: buildRuntimeContext('/workspace', 'Node.js decision eval'),
        }),
        conversationMessages,
      };
    };
    return {
      target: 'entry',
      datasetName: entryDecisionBasicsDataset.name,
      caseId: testCase.id,
      caseName: testCase.name,
      expectedSummary: testCase.expected.mode,
      render,
      async run(model, method) {
        const schema = buildTaskDecisionSchema();
        const raw = await model.withStructuredOutput(
          schema,
          buildOrchestrationDecisionStructuredOutputOptions({ method }),
        ).invoke(messages('entry', render(method)));
        const decision = schema.parse(raw);
        const mode = adaptTaskDecisionMode(decision.action);
        const boundaryCount = mode === 'direct_task' ? 1 : 0;
        const output = {
          action: decision.action,
          task: decision.task ?? null,
          contextSummary: decision.context_summary ?? null,
        };
        return {
          output,
          scores: scoreEntryDecision({ mode, task: decision.task, boundaryCount }, testCase.expected)
            .filter(({ key }) => key !== 'task_boundary_count_correct'),
          verdict: decision.action,
          shape: decision.task ? 'task=1' : 'task=0',
        };
      },
    };
  });
}

function plannerScenarios(): DecisionEvalScenario[] {
  return capabilityPlanningBasicsDataset.cases.map((testCase) => {
    const render = (method?: StructuredOutputMethod): RenderedDecisionPrompt => ({
      system: buildCapabilityPlanningDecisionSystemPrompt({
        actor,
        outputInstruction: buildCapabilityPlanningDecisionOutputInstruction(method),
      }),
      input: buildCapabilityPlanningDecisionInput({
        mode: testCase.input.mode,
        userIntentContext: buildPreparedRequestContext({
          latestUserRequest: testCase.input.userGoal,
          recentMessages: [new HumanMessage(testCase.input.userGoal)],
        }),
        remainingPlan: testCase.input.remainingPlan ?? [],
        latestHandoff: testCase.input.latestHandoff ?? null,
        capabilityRegistryContext: testCase.input.capabilityRegistry.join('\n'),
      }),
    });
    return {
      target: 'planner',
      datasetName: capabilityPlanningBasicsDataset.name,
      caseId: testCase.id,
      caseName: testCase.name,
      expectedSummary: `${testCase.input.mode}:${testCase.expected.result}`,
      render,
      async run(model, method) {
        const schema = buildCapabilityPlanningDecisionSchema();
        const raw = await model.withStructuredOutput(
          schema,
          buildOrchestrationDecisionStructuredOutputOptions({ method }),
        ).invoke(messages('planner', render(method)));
        const decision = schema.parse(raw);
        const remainingPlan = decision.remaining_plan.map((item) => ({
          objective: item.objective,
          capabilityIntent: item.capability_intent,
          status: item.status,
        }));
        const nextTask = decision.next_task?.objective ?? null;
        const capabilityIntent = decision.next_task?.capability_intent ?? null;
        const metrics = derivePlanningMetrics(
          testCase.input,
          remainingPlan,
          nextTask && capabilityIntent ? { objective: nextTask, capabilityIntent } : null,
        );
        const output = {
          result: decision.result,
          nextTask,
          capabilityIntent,
          remainingPlan,
          ...metrics,
        };
        return {
          output,
          scores: scoreCapabilityPlanning(output, testCase.expected, testCase.input),
          verdict: decision.result,
          shape: `tasks=${(nextTask ? 1 : 0) + remainingPlan.length},tail=${remainingPlan.length},rubberStamp=${metrics.rubberStamp.toString()}`,
        };
      },
    };
  });
}

function capabilities(input: CapabilityDecisionBasicsInput): AgentCapability[] {
  return input.availableCapabilities.map((item) => ({
    name: item.name,
    description: `${item.description} Keywords: ${item.keywords.join('|')}`,
    createRuntime: () => ({ instructions: [], tools: [] }),
  }));
}

function capabilityScenarios(): DecisionEvalScenario[] {
  return capabilityDecisionBasicsDataset.cases.map((testCase) => {
    const capabilityList = capabilities(testCase.input);
    const candidates = searchCapabilities(testCase.input.baselineSearchQuery, capabilityList);
    const schemaParams = { capabilityCandidates: candidates.map(({ name }) => ({ name })) };
    const render = (method?: StructuredOutputMethod): RenderedDecisionPrompt => ({
      system: buildRouteDecisionSystemPrompt({
        actor,
        outputInstruction: buildRouteDecisionOutputInstruction(schemaParams, method),
      }),
      input: buildRouteDecisionInput({
        pendingTask: {
          task: testCase.input.task,
          contextSummary: testCase.input.contextSummary ?? null,
          searchKeywords: testCase.input.baselineSearchQuery,
        },
        targetsContext: buildRouteTargetsContext({
          generalTools: (testCase.input.generalToolsAvailable ?? []).map((name) => ({
            name,
            description: `General tool ${name}`,
          })) as never,
          capabilityCandidates: candidates,
          capabilitySearchAttempted: true,
          capabilitySearchQuery: testCase.input.baselineSearchQuery,
          capabilityRegistryAvailable: capabilityList.length > 0,
        }),
      }),
    });
    return {
      target: 'capability',
      datasetName: capabilityDecisionBasicsDataset.name,
      caseId: testCase.id,
      caseName: testCase.name,
      expectedSummary: testCase.expected.expectedLane,
      render,
      async run(model, method) {
        const schema = buildRouteDecisionSchema(schemaParams);
        const raw = await model.withStructuredOutput(
          schema,
          buildOrchestrationDecisionStructuredOutputOptions({ method }),
        ).invoke(messages('capability', render(method)));
        const decision = schema.parse(raw);
        const candidateNames = candidates.map(({ name }) => name);
        const output = { lane: decision.lane, candidateNames };
        return {
          output,
          scores: scoreCapabilityDecision(
            { selectedLane: decision.lane, candidateNames },
            testCase.expected,
            capabilityList.map(({ name }) => name),
          ),
          verdict: decision.lane,
          shape: `candidates=${candidateNames.length.toString()}`,
        };
      },
    };
  });
}

function outcomeScenarios(): DecisionEvalScenario[] {
  return outcomeDecisionBasicsDataset.cases.map((testCase) => {
    const delegationId = 'eval-delegation';
    const render = (method?: StructuredOutputMethod): RenderedDecisionPrompt => ({
      system: buildDelegationOutcomeDecisionSystemPrompt({
        actor,
        outputInstruction: buildDelegationOutcomeDecisionOutputInstruction(method),
      }),
      input: buildDelegationOutcomeDecisionInput({
        userIntentContext: buildPreparedRequestContext({
          latestUserRequest: testCase.input.userGoal,
          recentMessages: [new HumanMessage(testCase.input.userGoal)],
        }),
        currentTaskContext: buildDelegationOutcomeCurrentTaskContext({
          id: delegationId,
          lane: 'general',
          task: testCase.input.currentTask,
          contextSummary: null,
        }),
        subagentAnnounceContext: buildSubagentAnnounceContext({
          lane: 'general',
          delegationId,
          task: testCase.input.currentTask,
          text: testCase.input.announce,
        }, 'natural'),
        otherTasksContext: buildDelegationOutcomeOtherTasksContext(
          (testCase.input.completedHandoffs ?? []).map((resultPreview, index) => ({
            id: `completed-${index.toString()}`,
            lane: 'general',
            task: `Completed task ${(index + 1).toString()}`,
            status: 'completed',
            resultPreview,
          })),
          delegationId,
        ),
      }),
    });
    return {
      target: 'outcome',
      datasetName: outcomeDecisionBasicsDataset.name,
      caseId: testCase.id,
      caseName: testCase.name,
      expectedSummary: testCase.expected.outcome,
      render,
      async run(model, method) {
        const schema = buildDelegationOutcomeDecisionSchema();
        const raw = await model.withStructuredOutput(
          schema,
          buildOrchestrationDecisionStructuredOutputOptions({ method }),
        ).invoke(messages('outcome', render(method)));
        const decision = schema.parse(raw);
        const output = { outcome: decision.outcome, gapNote: decision.gap_note ?? null };
        return {
          output,
          scores: scoreOutcomeDecision({ outcome: decision.outcome }, testCase.expected),
          verdict: decision.outcome,
          shape: decision.gap_note ? 'gapNote=1' : 'gapNote=0',
        };
      },
    };
  });
}

export function getDecisionEvalScenarios(target?: DecisionEvalTarget): DecisionEvalScenario[] {
  const scenarios = [
    ...entryScenarios(),
    ...plannerScenarios(),
    ...capabilityScenarios(),
    ...outcomeScenarios(),
  ];
  return target ? scenarios.filter((scenario) => scenario.target === target) : scenarios;
}
