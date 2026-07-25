import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { searchCapabilities } from '../src/agent/orchestrator/capabilitySearch.ts';
import {
  buildCapabilityDecisionInput,
  buildCapabilityDecisionSystemPrompt,
  buildCapabilityDecisionAvailableExecutorsContext,
  buildCapabilityPlanningDecisionInput,
  buildCapabilityPlanningDecisionSystemPrompt,
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildPreparedRequestContext,
  buildRunDelegationSummaryContext,
  buildRuntimeContext,
  buildSubagentAnnounceContext,
  buildTaskDecisionInput,
  buildTaskDecisionSystemPrompt,
} from '../src/agent/orchestrator/prompts.ts';
import {
  CAPABILITY_UNAVAILABLE_SELECTION,
  buildCapabilityDecisionOutputInstruction,
  buildCapabilityDecisionSchema,
  buildCapabilityPlanningDecisionOutputInstruction,
  buildCapabilityPlanningDecisionSchema,
  buildDelegationOutcomeDecisionOutputInstruction,
  buildDelegationOutcomeDecisionSchema,
  buildOrchestrationDecisionStructuredOutputOptions,
  buildTaskDecisionOutputInstruction,
  buildTaskDecisionSchema,
} from '../src/agent/orchestrator/schemas.ts';
import type { AgentModels } from '../src/types/agent.ts';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '../src/types/capability.ts';
import type { StructuredOutputMethod } from '../src/utils/structuredOutput.ts';
import {
  buildCapabilityPlanningGoalContract,
  evaluateCapabilityPlanningOutput,
} from './capability-planning-evaluation.ts';
import {
  adaptTaskDecisionMode,
  derivePlanningMetrics,
  scoreCapabilityDecision,
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
import {
  evaluatePromptGoal,
  type PromptEvalJudge,
  type PromptGoalAcceptanceCriterion,
} from './prompt-goal-evaluator.ts';

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
  diagnostics?: Record<string, unknown>;
};

export type DecisionEvalScenario = {
  target: DecisionEvalTarget;
  contract: 'entry.execution-shape'
    | 'planner.execution-boundary'
    | 'capability.executor-selection'
    | 'outcome.announce-verdict';
  objective: string;
  datasetName: string;
  caseId: string;
  caseName: string;
  expectedSummary: string;
  render(method?: StructuredOutputMethod): RenderedDecisionPrompt;
  run(
    model: AgentModels['act'],
    method?: StructuredOutputMethod,
    config?: RunnableConfig,
    judge?: PromptEvalJudge,
  ): Promise<DecisionEvalRunResult>;
};

const actor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'decision-eval',
  personality: null,
  stage: null,
  species: null,
};

function messages(prompt: RenderedDecisionPrompt) {
  return prompt.conversationMessages
    ? [
        new SystemMessage(prompt.system),
        new HumanMessage(prompt.input),
        ...prompt.conversationMessages,
      ]
    : [new SystemMessage(prompt.system), new HumanMessage(prompt.input)];
}

function entryScenarios(): DecisionEvalScenario[] {
  return entryDecisionBasicsDataset.cases.map((testCase) => {
    const objective = `Select ${testCase.expected.mode} for this request. ${testCase.expected.reason}`;
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
      contract: 'entry.execution-shape',
      objective,
      datasetName: entryDecisionBasicsDataset.name,
      caseId: testCase.id,
      caseName: testCase.name,
      expectedSummary: testCase.expected.mode,
      render,
      async run(model, method, config, judge) {
        const schema = buildTaskDecisionSchema();
        const raw = await model.withStructuredOutput(
          schema,
          buildOrchestrationDecisionStructuredOutputOptions({ method }),
        ).invoke(messages(render(method)), config);
        const decision = schema.parse(raw);
        const mode = adaptTaskDecisionMode(decision.action);
        const output = {
          action: decision.action,
          task: decision.task ?? null,
          contextSummary: decision.context_summary ?? null,
        };
        const semanticCriteria: PromptGoalAcceptanceCriterion[] = testCase.expected.expectedTaskTerms?.length
          ? [{
              id: 'direct_task_content_correct',
              statement: [
                'The direct task preserves all executable work required by the user request in one boundary.',
                `Required anchors: ${testCase.expected.expectedTaskTerms.join(', ')}.`,
              ].join(' '),
            }]
          : [];
        const semanticEvaluation = semanticCriteria.length > 0
          ? await evaluatePromptGoal({
              judge: judge ?? { model, method, config },
              contract: 'entry.execution-shape',
              objective,
              acceptanceCriteria: semanticCriteria,
              evidence: testCase.input,
              candidateOutput: output,
            })
          : null;
        return {
          output,
          scores: [
            ...scoreEntryDecision({ mode }, testCase.expected),
            ...(semanticEvaluation?.scores ?? []),
          ],
          verdict: decision.action,
          shape: decision.task ? 'task=1' : 'task=0',
          diagnostics: {
            expectedBoundaryCount: testCase.expected.expectedBoundaryCount,
            ...(semanticEvaluation ? { evaluationSummary: semanticEvaluation.summary } : {}),
          },
        };
      },
    };
  });
}

function plannerScenarios(): DecisionEvalScenario[] {
  return capabilityPlanningBasicsDataset.cases.map((testCase) => {
    const goalContract = buildCapabilityPlanningGoalContract(testCase.expected);
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
        completedTasks: testCase.input.completedTasks ?? [],
        remainingPlan: testCase.input.remainingPlan ?? [],
        latestHandoff: testCase.input.latestHandoff ?? null,
        capabilityRegistryContext: testCase.input.capabilityRegistry.join('\n'),
      }),
    });
    return {
      target: 'planner',
      contract: 'planner.execution-boundary',
      objective: goalContract.objective,
      datasetName: capabilityPlanningBasicsDataset.name,
      caseId: testCase.id,
      caseName: testCase.name,
      expectedSummary: `${testCase.input.mode}:${testCase.expected.result}`,
      render,
      async run(model, method, config, judge) {
        const schema = buildCapabilityPlanningDecisionSchema();
        const raw = await model.withStructuredOutput(
          schema,
          buildOrchestrationDecisionStructuredOutputOptions({ method }),
        ).invoke(messages(render(method)), config);
        const decision = schema.parse(raw);
        const remainingPlan = decision.remaining_plan.map((item) => ({
          objective: item.objective,
          capabilityIntent: item.capability_intent,
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
        };
        const evaluation = await evaluateCapabilityPlanningOutput({
          input: testCase.input,
          expected: testCase.expected,
          output,
          judge: judge ?? { model, method, config },
        });
        return {
          output,
          scores: evaluation.scores,
          verdict: decision.result,
          shape: `tasks=${(nextTask ? 1 : 0) + remainingPlan.length},tail=${remainingPlan.length},rubberStamp=${metrics.rubberStamp.toString()}`,
          diagnostics: {
            planEffect: metrics.planEffect,
            rubberStamp: metrics.rubberStamp,
            ...(evaluation.evaluationSummary
              ? { evaluationSummary: evaluation.evaluationSummary }
              : {}),
          },
        };
      },
    };
  });
}

function capabilities(input: CapabilityDecisionBasicsInput): AgentCapability[] {
  return [
    ...input.availableCapabilities.map((item) => ({
      name: item.name,
      description: `${item.description} Keywords: ${item.keywords.join('|')}`,
      uses: [],
      instructions: defineInstructionDocument({
        content: `Execute the ${item.name} capability.`,
      }),
    })),
    ...(input.generalCapabilityAvailable ? [{
      name: 'general',
      description: 'Handle general tasks that do not require a more specific Capability.',
      uses: [],
      instructions: defineInstructionDocument({
        content: 'Execute the general capability.',
      }),
    }] : []),
  ];
}

function capabilitySearchQuery(input: CapabilityDecisionBasicsInput): string {
  return [input.task, input.contextSummary]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .join(' | ');
}

function capabilityScenarios(): DecisionEvalScenario[] {
  return capabilityDecisionBasicsDataset.cases.map((testCase) => {
    const capabilityList = capabilities(testCase.input);
    const query = capabilitySearchQuery(testCase.input);
    const candidates = searchCapabilities(query, capabilityList);
    const generalCapability = capabilityList.find(({ name }) => name === 'general');
    const decisionCandidates = generalCapability
      && !candidates.some(({ name }) => name === generalCapability.name)
      ? [
          ...candidates,
          {
            name: generalCapability.name,
            description: generalCapability.description,
            score: 0,
            matchedTerms: ['planner-default'],
          },
        ]
      : candidates;
    const schemaParams = {
      capabilityCandidates: decisionCandidates.map(({ name }) => ({ name })),
    };
    const render = (method?: StructuredOutputMethod): RenderedDecisionPrompt => ({
      system: buildCapabilityDecisionSystemPrompt({
        actor,
        outputInstruction: buildCapabilityDecisionOutputInstruction(schemaParams, method),
      }),
      input: buildCapabilityDecisionInput({
        pendingTask: {
          task: testCase.input.task,
          contextSummary: testCase.input.contextSummary ?? null,
        },
        availableExecutorsContext: buildCapabilityDecisionAvailableExecutorsContext({
          capabilityCandidates: decisionCandidates,
        }),
      }),
    });
    return {
      target: 'capability',
      contract: 'capability.executor-selection',
      objective: `Select ${testCase.expected.expectedSelection} for the immutable current task. ${testCase.expected.reason}`,
      datasetName: capabilityDecisionBasicsDataset.name,
      caseId: testCase.id,
      caseName: testCase.name,
      expectedSummary: testCase.expected.expectedSelection,
      render,
      async run(model, method, config) {
        let resolvedSelection: string | null = decisionCandidates.length === 0
          ? CAPABILITY_UNAVAILABLE_SELECTION
          : null;
        if (!resolvedSelection) {
          const schema = buildCapabilityDecisionSchema(schemaParams);
          const raw = await model.withStructuredOutput(
            schema,
            buildOrchestrationDecisionStructuredOutputOptions({ method }),
          ).invoke(messages(render(method)), config);
          resolvedSelection = schema.parse(raw).selection;
        }
        const candidateNames = candidates.map(({ name }) => name);
        const output = { selection: resolvedSelection };
        const candidateRecallCorrect = candidateNames.length === testCase.expected.expectedCandidateNames.length
          && candidateNames.every((name) => testCase.expected.expectedCandidateNames.includes(name));
        return {
          output,
          scores: scoreCapabilityDecision(
            { selection: resolvedSelection },
            testCase.expected,
          ),
          verdict: resolvedSelection,
          shape: `candidates=${candidateNames.length.toString()}`,
          diagnostics: {
            candidateNames,
            expectedCandidateNames: testCase.expected.expectedCandidateNames,
            candidateRecallCorrect,
          },
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
          lane: 'capability:general',
          task: testCase.input.currentTask,
          contextSummary: null,
        }),
        subagentAnnounceContext: buildSubagentAnnounceContext({
          lane: 'capability:general',
          delegationId,
          task: testCase.input.currentTask,
          text: testCase.input.announce,
        }, 'natural'),
        otherTasksContext: buildDelegationOutcomeOtherTasksContext(
          (testCase.input.completedHandoffs ?? []).map((resultPreview, index) => ({
            id: `completed-${index.toString()}`,
            lane: 'capability:general',
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
      contract: 'outcome.announce-verdict',
      objective: `Judge the current announce as ${testCase.expected.outcome}. ${testCase.expected.reason}`,
      datasetName: outcomeDecisionBasicsDataset.name,
      caseId: testCase.id,
      caseName: testCase.name,
      expectedSummary: testCase.expected.outcome,
      render,
      async run(model, method, config) {
        const schema = buildDelegationOutcomeDecisionSchema();
        const raw = await model.withStructuredOutput(
          schema,
          buildOrchestrationDecisionStructuredOutputOptions({ method }),
        ).invoke(messages(render(method)), config);
        const decision = schema.parse(raw);
        const output = { outcome: decision.outcome, gapNote: decision.gap_note ?? null };
        return {
          output,
          scores: scoreOutcomeDecision({ outcome: decision.outcome }, testCase.expected),
          verdict: decision.outcome,
          shape: decision.gap_note ? 'gapNote=1' : 'gapNote=0',
          diagnostics: {
            gapNotePresent: Boolean(decision.gap_note),
          },
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
