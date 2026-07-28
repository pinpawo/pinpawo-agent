import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
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
  buildDelegationOutcomeDecisionOutputInstruction,
  buildDelegationOutcomeDecisionSchema,
  buildOrchestrationDecisionStructuredOutputOptions,
  buildTaskDecisionOutputInstruction,
  buildTaskDecisionSchema,
} from '../src/agent/orchestrator/schemas.ts';
import type { AgentModels } from '../src/types/agent.ts';
import type { StructuredOutputMethod } from '../src/utils/structuredOutput.ts';
import {
  adaptTaskDecisionMode,
  scoreEntryDecision,
  scoreOutcomeDecision,
  type DecisionContractScore,
} from './decision-contract-scorers.ts';
import {
  entryDecisionBasicsDataset,
  outcomeDecisionBasicsDataset,
} from './datasets/index.ts';
import {
  evaluatePromptGoal,
  type PromptEvalJudge,
  type PromptGoalAcceptanceCriterion,
} from './prompt-goal-evaluator.ts';

export type DecisionEvalTarget = 'entry' | 'outcome';

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
    ...outcomeScenarios(),
  ];
  return target ? scenarios.filter((scenario) => scenario.target === target) : scenarios;
}
