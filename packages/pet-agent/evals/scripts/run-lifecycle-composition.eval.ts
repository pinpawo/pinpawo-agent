import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import {
  buildOrchestratorTurnInput,
  compileAgentRegistry,
  createOrchestratorGraph,
} from '../../src/agent/createAgentRuntime.ts';
import {
  getMessageLane,
  mainConversationMessages,
  readLatestHumanRequest,
} from '../../src/agent/orchestrator/messageLanes.ts';
import type { OrchestratorStateType } from '../../src/agent/orchestrator/state.ts';
import { readMessageText } from '../../src/agent/orchestrator/utils.ts';
import { readMessageToolCalls } from '../../src/utils/messages.ts';
import type { AgentModels } from '../../src/types/agent.ts';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '../../src/types/capability.ts';
import { defineToolkit } from '../../src/types/toolkit.ts';
import type { ProviderTokenUsage } from '../../src/agent/tokenUsage.ts';
import type { StructuredOutputMethod } from '../../src/utils/structuredOutput.ts';
import {
  orchestratorLifecycleCompositionDataset,
  type LifecycleCompositionCapabilityProfile,
  type LifecycleCompositionTurn,
} from '../datasets/orchestrator-lifecycle-composition.ts';
import {
  evaluateLifecycleCompositionInvariants,
  lifecycleCompositionGoalAchieved,
  resolveControlledExecutorResult,
  type LifecycleCompositionInvariant,
} from '../lifecycle-composition-evaluation.ts';
import { readRunDelegationSummaries } from '../orchestratorStateReaders.ts';
import type { DecisionContractScore } from '../decision-contract-scorers.ts';
import {
  evaluatePromptGoal,
  PromptEvalJudgeError,
} from '../prompt-goal-evaluator.ts';
import {
  createPromptEvalUsageCollector,
  estimatePromptEvalCost,
} from '../prompt-eval-usage.ts';
import type {
  PromptEvalModelMetadata,
  PromptEvalRevision,
} from '../prompt-eval-report.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';

const DEFAULT_REPEATS = 3;
const EVALUATOR_VERSION = 'prompt-goal-v1';
export const LIFECYCLE_COMPOSITION_REPORT_VERSION = 2 as const;

const actor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'lifecycle-composition-eval',
  personality: null,
  stage: null,
  species: null,
};

type DecisionKind = 'entry_answer' | 'planner' | 'unknown';

type DecisionRecord = {
  kind: DecisionKind;
  output: Record<string, unknown>;
};

type AnswerRecord = {
  text: string;
};

type ExecutorCall = {
  turnUserMessage: string | null;
  inputMessages: string[];
  controlledResult: string | null;
  unexpected: boolean;
  laneMessageCount: number;
};

type LifecycleTurnOutput = {
  userMessage: string;
  assistantMessages: string[];
  decisions: DecisionRecord[];
  answers: AnswerRecord[];
  executorCalls: ExecutorCall[];
  delegationSummaries: ReturnType<typeof readRunDelegationSummaries>;
};

type LifecycleRunResult = {
  caseId: string;
  caseName: string;
  repeat: number;
  objective: string;
  goalAchieved: boolean | null;
  status: 'achieved'
    | 'not_achieved'
    | 'not_evaluable'
    | 'invoke_error'
    | 'controlled_executor_exhausted';
  scores: DecisionContractScore[];
  invariants: LifecycleCompositionInvariant[];
  turns: LifecycleTurnOutput[];
  diagnostics: {
    decisionCounts: Record<DecisionKind | 'answer', number>;
    executorCallCount: number;
    expectedExecutorCallRange: {
      min: number;
      max: number;
    };
    executorCallCountWithinExpectedRange: boolean;
    assistantMessageCount: number;
    evaluationSummary?: string;
  };
  durationMs: number;
  usage: {
    subject: ProviderTokenUsage | null;
    evaluator: ProviderTokenUsage | null;
  };
  error: {
    kind: 'invoke' | 'evaluation' | 'controlled_executor_exhausted';
    message: string;
  } | null;
};

export type LifecycleCompositionReport = {
  reportVersion: typeof LIFECYCLE_COMPOSITION_REPORT_VERSION;
  kind: 'orchestrator-lifecycle-composition';
  createdAt: string;
  revision: PromptEvalRevision;
  model: PromptEvalModelMetadata;
  structuredOutputMethod: 'not-applicable';
  evaluator: {
    version: typeof EVALUATOR_VERSION;
    model: PromptEvalModelMetadata;
    structuredOutputMethod: StructuredOutputMethod | 'provider-default';
  };
  selection: {
    dataset: string;
    cases: string[];
    repeats: number;
  };
  results: LifecycleRunResult[];
  summaries: Array<{
    caseId: string;
    caseName: string;
    achieved: number;
    runs: number;
    notEvaluable: number;
    invokeErrors: number;
    controlledExecutorExhausted: number;
  }>;
  usage: {
    subject: ProviderTokenUsage | null;
    evaluator: ProviderTokenUsage | null;
    estimatedCostUsd: number | null;
  };
};

export function createLifecycleCompositionReport(input: Omit<
  LifecycleCompositionReport,
  'reportVersion' | 'kind' | 'createdAt'
>): LifecycleCompositionReport {
  return {
    reportVersion: LIFECYCLE_COMPOSITION_REPORT_VERSION,
    kind: 'orchestrator-lifecycle-composition',
    createdAt: new Date().toISOString(),
    ...input,
  };
}

const generalToolkit = defineToolkit({
  name: 'lifecycle_composition_general',
  description: 'General execution capability available to the lifecycle composition eval.',
  tools: [{
    tool: tool(async () => 'ok', {
      name: 'lifecycle_eval_noop',
      description: 'A generic execution marker. It does not provide domain-specific workspace expertise.',
      schema: z.object({}),
    }),
  }],
});

const standardCapabilities: AgentCapability[] = [
  {
    name: 'general',
    description: 'Default executor for ordinary tasks that do not require a more specialized Capability.',
    uses: [generalToolkit.name],
    instructions: defineInstructionDocument({
      content: 'Complete the requested task using the available tools and conversation evidence.',
    }),
  },
  {
    name: 'workspace_analysis',
    description: [
      'Inspect and analyze repositories, workspace files, configuration, dependencies, risks, and deployment state.',
      'Keywords: 检查|调查|读取|项目|工作区|配置|发布|部署|staging|auth|结构|风险|状态',
    ].join(' '),
    uses: [generalToolkit.name],
    instructions: defineInstructionDocument({
      content: 'Inspect the requested workspace state and report grounded findings.',
    }),
  },
  {
    name: 'code_change',
    description: [
      'Modify or refactor code and verify the change with relevant tests.',
      'Keywords: 修改|重构|修复|测试|验证|auth|支付|舍入|代码',
    ].join(' '),
    uses: [generalToolkit.name],
    instructions: defineInstructionDocument({
      content: 'Implement the requested code change and verify it before reporting completion.',
    }),
  },
];

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function splitNullList(value: string): string[] {
  return value.split('\0').map((item) => item.trim()).filter(Boolean);
}

function hashWorkingTreeDiff(changedPaths: string[]): string {
  const hash = createHash('sha256');
  hash.update(execFileSync('git', ['diff', '--binary', 'HEAD']));
  const untracked = new Set(splitNullList(execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )));
  for (const path of changedPaths) {
    if (!untracked.has(path)) continue;
    hash.update(`\0${path}\0`);
    hash.update(readFileSync(resolve(path)));
  }
  return hash.digest('hex');
}

function readRevision(): PromptEvalRevision {
  const commit = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
  const changedPaths = [
    ...splitNullList(execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], { encoding: 'utf8' })),
    ...splitNullList(execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8' },
    )),
  ].filter((value, index, values) => values.indexOf(value) === index).sort();
  const dirty = changedPaths.length > 0;
  if (dirty && process.env.PROMPT_EVAL_ALLOW_DIRTY !== '1') {
    throw new Error(
      'Lifecycle composition eval requires a clean working tree. Commit the candidate or set PROMPT_EVAL_ALLOW_DIRTY=1.',
    );
  }
  return {
    commit,
    harnessCommit: process.env.PROMPT_EVAL_HARNESS_REVISION ?? (dirty ? 'working-tree' : commit),
    dirty,
    workingTreeDiffSha256: dirty ? hashWorkingTreeDiff(changedPaths) : null,
    changedPaths,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createRecordingModels(model: AgentModels['act']) {
  const decisions: DecisionRecord[] = [];
  const answers: AnswerRecord[] = [];
  const recordEntryAnswer = new RunnableLambda<BaseMessage, BaseMessage>({
    func: async (response: BaseMessage) => {
      const toolCalls = readMessageToolCalls(response);
      decisions.push({
        kind: 'entry_answer',
        output: {
          route: toolCalls.some(({ name }) => name === 'plan_request')
            ? 'plan_request'
            : 'answer',
          text: readMessageText(response).trim(),
          toolCalls: toolCalls.map(({ name, args }) => ({ name, args })),
        },
      });
      return response;
    },
  });
  const act = model.pipe(new RunnableLambda<BaseMessage, BaseMessage>({
    func: async (response: BaseMessage) => {
      for (const toolCall of readMessageToolCalls(response)) {
        const output = isRecord(toolCall.args)
          ? toolCall.args
          : { value: toolCall.args };
        if (![
          'continue_current',
          'submit_plan',
          'advance_plan',
          'complete_goal',
          'request_user_input',
          'report_unavailable',
        ].includes(toolCall.name)) {
          continue;
        }
        decisions.push({
          kind: 'planner',
          output: { ...output, action: toolCall.name },
        });
      }
      return response;
    },
  })) as unknown as AgentModels['act'];
  const bindTools = (model as unknown as {
    bindTools?: (...args: unknown[]) => { pipe: (next: unknown) => unknown };
  }).bindTools?.bind(model);
  const answer = new Proxy(model, {
    get(target, property) {
      if (property === 'bindTools') {
        return (...args: unknown[]) => {
          if (!bindTools) {
            throw new Error('Lifecycle Entry Answer model must support tool binding.');
          }
          return bindTools(...args).pipe(recordEntryAnswer);
        };
      }
      if (property === 'invoke') {
        return async (...args: Parameters<typeof target.invoke>) => {
          const response = await target.invoke(...args);
          answers.push({ text: readMessageText(response).trim() });
          return response;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    act,
    answer,
    decisions,
    answers,
  };
}

class ControlledExecutorExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlledExecutorExhaustedError';
  }
}

function createControlledExecutor(turns: LifecycleCompositionTurn[]) {
  const model = new FakeListChatModel({
    responses: ['controlled executor placeholder'],
    sleep: 0,
  });
  const calls: ExecutorCall[] = [];
  const callCountsByTurn = new Map<number, number>();
  const bindTools = model.bindTools.bind(model);
  model.bindTools = ((tools) => {
    const runnable = bindTools(tools);
    runnable.invoke = async (input) => {
      const messages = Array.isArray(input) ? input as BaseMessage[] : [];
      const latestUserMessage = readLatestHumanRequest(messages);
      const matchedTurnIndex = [...turns].reverse().findIndex(
        ({ userMessage }) => userMessage === latestUserMessage,
      );
      const resolvedTurnIndex = matchedTurnIndex < 0
        ? -1
        : turns.length - matchedTurnIndex - 1;
      const resultIndex = resolvedTurnIndex < 0
        ? 0
        : callCountsByTurn.get(resolvedTurnIndex) ?? 0;
      const controlled = resolveControlledExecutorResult({
        turns,
        latestUserMessage,
        resultIndex,
      });
      const controlledResult = controlled.result;
      if (resolvedTurnIndex >= 0) {
        callCountsByTurn.set(resolvedTurnIndex, resultIndex + 1);
      }
      calls.push({
        turnUserMessage: latestUserMessage,
        inputMessages: messages.map((message) => readMessageText(message)),
        controlledResult,
        unexpected: controlledResult === null,
        laneMessageCount: messages.filter((message) => getMessageLane(message) !== null).length,
      });
      if (controlledResult === null) {
        throw new ControlledExecutorExhaustedError(
          `Controlled executor received unexpected call ${calls.length.toString()} for turn ${JSON.stringify(latestUserMessage)}.`,
        );
      }
      return new AIMessageChunk({ content: controlledResult });
    };
    return runnable;
  }) as typeof model.bindTools;
  return { model, calls };
}

function capabilityRuntime(profile: LifecycleCompositionCapabilityProfile) {
  if (profile === 'unavailable') {
    return {
      capabilities: [] as AgentCapability[],
      toolkits: [],
      allowedCapabilityNames: [] as string[],
    };
  }
  return {
    capabilities: standardCapabilities,
    toolkits: [generalToolkit],
    allowedCapabilityNames: standardCapabilities.map(({ name }) => name),
  };
}

function addUsage(
  current: ProviderTokenUsage | null,
  next: ProviderTokenUsage | null,
): ProviderTokenUsage | null {
  if (!next) return current;
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
  };
}

function sumKnownCosts(
  subjectCost: number | null,
  evaluatorCost: number | null,
): number | null {
  if (subjectCost === null || evaluatorCost === null) return null;
  return Number((subjectCost + evaluatorCost).toFixed(8));
}

function countDecisions(
  turns: LifecycleTurnOutput[],
): Record<DecisionKind | 'answer', number> {
  const counts: Record<DecisionKind | 'answer', number> = {
    entry_answer: 0,
    planner: 0,
    unknown: 0,
    answer: 0,
  };
  for (const turn of turns) {
    for (const decision of turn.decisions) counts[decision.kind] += 1;
    counts.answer += turn.answers.length;
  }
  return counts;
}

async function runCase(params: {
  testCase: typeof orchestratorLifecycleCompositionDataset.cases[number];
  repeat: number;
  subjectModel: AgentModels['act'];
  judgeModel: AgentModels['act'];
  judgeStructuredOutputMethod?: StructuredOutputMethod;
  subjectProfileId: string;
  subjectProfileFingerprint: string;
  judgeProfileId: string;
  judgeProfileFingerprint: string;
}): Promise<LifecycleRunResult> {
  const {
    testCase,
    repeat,
    subjectModel,
    judgeModel,
    judgeStructuredOutputMethod,
  } = params;
  const started = performance.now();
  const subjectUsage = createPromptEvalUsageCollector();
  const evaluatorUsage = createPromptEvalUsageCollector();
  const recorder = createRecordingModels(subjectModel);
  const controlledResults = testCase.input.turns.flatMap(({ executorResults }) => executorResults);
  const executor = createControlledExecutor(testCase.input.turns);
  const checkpoint = new MemorySaver();
  const graph = createOrchestratorGraph({
    models: {
      act: recorder.act,
      answer: recorder.answer,
      observe: recorder.act,
      subagent: executor.model,
    },
    actor,
    checkpoint,
  });
  const runtime = capabilityRuntime(testCase.input.capabilityProfile);
  const registry = compileAgentRegistry({
    capabilities: runtime.capabilities,
    toolkits: runtime.toolkits,
  });
  const threadId = `lifecycle-composition-${testCase.name}-${repeat.toString()}-${Date.now().toString()}`;
  const turns: LifecycleTurnOutput[] = [];
  let finalState: OrchestratorStateType | null = null;
  let previousAssistantCount = 0;
  let previousDecisionCount = 0;
  let previousAnswerCount = 0;
  let previousExecutorCallCount = 0;
  let activeTurn: LifecycleCompositionTurn | null = null;

  function appendTurnSnapshot(state: OrchestratorStateType, turn: LifecycleCompositionTurn) {
    const mainAssistantMessages = mainConversationMessages(state.messages)
      .filter((message): message is AIMessage => message._getType() === 'ai')
      .map((message) => readMessageText(message).trim())
      .filter(Boolean);
    turns.push({
      userMessage: turn.userMessage,
      assistantMessages: mainAssistantMessages.slice(previousAssistantCount),
      decisions: recorder.decisions.slice(previousDecisionCount),
      answers: recorder.answers.slice(previousAnswerCount),
      executorCalls: executor.calls.slice(previousExecutorCallCount),
      delegationSummaries: readRunDelegationSummaries(state),
    });
    previousAssistantCount = mainAssistantMessages.length;
    previousDecisionCount = recorder.decisions.length;
    previousAnswerCount = recorder.answers.length;
    previousExecutorCallCount = executor.calls.length;
  }

  try {
    for (const turn of testCase.input.turns) {
      activeTurn = turn;
      finalState = await graph.invoke(
        buildOrchestratorTurnInput([new HumanMessage(turn.userMessage)]),
        {
          configurable: {
            thread_id: threadId,
            actor,
            registry,
            allowedCapabilityNames: runtime.allowedCapabilityNames,
            maxRunIterations: 12,
            workdir: '/eval/workspace',
            runtimeEnvironment: 'Controlled lifecycle composition evaluation.',
          },
          callbacks: [subjectUsage.callback],
          metadata: {
            modelProfileId: params.subjectProfileId,
            modelProfileFingerprint: params.subjectProfileFingerprint,
            promptEvalModelRole: 'subject',
          },
          recursionLimit: 80,
        },
      ) as OrchestratorStateType;
      appendTurnSnapshot(finalState, turn);
      activeTurn = null;
    }

    if (!finalState) throw new Error('Lifecycle case produced no final graph state.');
    const assistantMessageCount = turns.reduce(
      (sum, turn) => sum + turn.assistantMessages.length,
      0,
    );
    const invariants = evaluateLifecycleCompositionInvariants({
      finalState,
      assistantMessageCount,
    });
    const evaluation = await evaluatePromptGoal({
      judge: {
        model: judgeModel,
        method: judgeStructuredOutputMethod,
        config: {
          callbacks: [evaluatorUsage.callback],
          metadata: {
            modelProfileId: params.judgeProfileId,
            modelProfileFingerprint: params.judgeProfileFingerprint,
            promptEvalModelRole: 'judge',
          },
        },
      },
      contract: 'orchestrator.lifecycle-composition',
      objective: testCase.expected.objective,
      acceptanceCriteria: testCase.expected.acceptanceCriteria,
      evidence: {
        userTurns: testCase.input.turns.map(({ userMessage }) => userMessage),
        controlledExecutorResults: controlledResults,
      },
      candidateOutput: { turns },
    });
    const goalAchieved = lifecycleCompositionGoalAchieved(
      evaluation.scores,
      invariants,
    );
    return {
      caseId: testCase.id,
      caseName: testCase.name,
      repeat,
      objective: testCase.expected.objective,
      goalAchieved,
      status: goalAchieved ? 'achieved' : 'not_achieved',
      scores: evaluation.scores,
      invariants,
      turns,
      diagnostics: {
        decisionCounts: countDecisions(turns),
        executorCallCount: executor.calls.length,
        expectedExecutorCallRange: testCase.expected.executorCallRange,
        executorCallCountWithinExpectedRange:
          executor.calls.length >= testCase.expected.executorCallRange.min
          && executor.calls.length <= testCase.expected.executorCallRange.max,
        assistantMessageCount,
        evaluationSummary: evaluation.summary,
      },
      durationMs: Math.round(performance.now() - started),
      usage: {
        subject: subjectUsage.read(),
        evaluator: evaluatorUsage.read(),
      },
      error: null,
    };
  } catch (error) {
    const evaluationError = error instanceof PromptEvalJudgeError;
    const controlledExecutorExhausted = error instanceof ControlledExecutorExhaustedError
      || (
        error instanceof Error
        && (
          error.name === 'ControlledExecutorExhaustedError'
          || error.message.startsWith('ControlledExecutorExhaustedError:')
        )
      );
    if (activeTurn) {
      try {
        const snapshot = await graph.getState({
          configurable: { thread_id: threadId },
        });
        const checkpointState = snapshot.values as OrchestratorStateType;
        finalState = checkpointState;
        appendTurnSnapshot(checkpointState, activeTurn);
      } catch {
        turns.push({
          userMessage: activeTurn.userMessage,
          assistantMessages: [],
          decisions: recorder.decisions.slice(previousDecisionCount),
          answers: recorder.answers.slice(previousAnswerCount),
          executorCalls: executor.calls.slice(previousExecutorCallCount),
          delegationSummaries: finalState ? readRunDelegationSummaries(finalState) : [],
        });
      }
    }
    return {
      caseId: testCase.id,
      caseName: testCase.name,
      repeat,
      objective: testCase.expected.objective,
      goalAchieved: null,
      status: evaluationError
        ? 'not_evaluable'
        : controlledExecutorExhausted
          ? 'controlled_executor_exhausted'
          : 'invoke_error',
      scores: [],
      invariants: [],
      turns,
      diagnostics: {
        decisionCounts: countDecisions(turns),
        executorCallCount: executor.calls.length,
        expectedExecutorCallRange: testCase.expected.executorCallRange,
        executorCallCountWithinExpectedRange:
          executor.calls.length >= testCase.expected.executorCallRange.min
          && executor.calls.length <= testCase.expected.executorCallRange.max,
        assistantMessageCount: turns.reduce(
          (sum, turn) => sum + turn.assistantMessages.length,
          0,
        ),
      },
      durationMs: Math.round(performance.now() - started),
      usage: {
        subject: subjectUsage.read(),
        evaluator: evaluatorUsage.read(),
      },
      error: {
        kind: evaluationError
          ? 'evaluation'
          : controlledExecutorExhausted
            ? 'controlled_executor_exhausted'
            : 'invoke',
        message: `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(0, 1000),
      },
    };
  }
}

function summarize(results: LifecycleRunResult[]) {
  return orchestratorLifecycleCompositionDataset.cases
    .filter((testCase) => results.some(({ caseId }) => caseId === testCase.id))
    .map((testCase) => {
      const caseResults = results.filter(({ caseId }) => caseId === testCase.id);
      return {
        caseId: testCase.id,
        caseName: testCase.name,
        achieved: caseResults.filter(({ goalAchieved }) => goalAchieved === true).length,
        runs: caseResults.length,
        notEvaluable: caseResults.filter(({ status }) => status === 'not_evaluable').length,
        invokeErrors: caseResults.filter(({ status }) => status === 'invoke_error').length,
        controlledExecutorExhausted: caseResults.filter(
          ({ status }) => status === 'controlled_executor_exhausted',
        ).length,
      };
    });
}

async function main() {
  const repeats = Number(process.env.LIFECYCLE_EVAL_REPEATS ?? DEFAULT_REPEATS);
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error(`Invalid LIFECYCLE_EVAL_REPEATS: ${process.env.LIFECYCLE_EVAL_REPEATS ?? ''}`);
  }
  const requestedCases = splitList(process.env.LIFECYCLE_EVAL_CASES);
  const selectedCases = orchestratorLifecycleCompositionDataset.cases.filter(
    (testCase) => requestedCases.length === 0
      || requestedCases.includes(testCase.id)
      || requestedCases.includes(testCase.name),
  );
  if (selectedCases.length === 0) {
    throw new Error('No lifecycle composition cases matched LIFECYCLE_EVAL_CASES.');
  }
  const revision = readRevision();
  const subjectProfileId = (
    process.env.LIFECYCLE_EVAL_MODEL_PROFILE_ID
    ?? process.env.PROMPT_EVAL_MODEL_PROFILE_ID
  )?.trim();
  const judgeProfileId = (
    process.env.LIFECYCLE_EVAL_JUDGE_PROFILE_ID
    ?? process.env.PROMPT_EVAL_JUDGE_PROFILE_ID
  )?.trim();
  if (!subjectProfileId) {
    throw new Error(
      'LIFECYCLE_EVAL_MODEL_PROFILE_ID or PROMPT_EVAL_MODEL_PROFILE_ID is required.',
    );
  }
  if (!judgeProfileId) {
    throw new Error(
      'LIFECYCLE_EVAL_JUDGE_PROFILE_ID or PROMPT_EVAL_JUDGE_PROFILE_ID is required.',
    );
  }
  const modelConfig = createDecisionEvalModel({
    profileId: subjectProfileId,
    role: 'subject',
  });
  const judgeConfig = createDecisionEvalModel({
    profileId: judgeProfileId,
    role: 'judge',
  });
  if (modelConfig.metadata.fingerprint === judgeConfig.metadata.fingerprint) {
    throw new Error(
      'The lifecycle eval judge must have a different resolved profile fingerprint '
      + 'from the subject model.',
    );
  }
  const structuredOutputMethod = 'not-applicable' as const;
  console.log('Orchestrator lifecycle composition eval');
  console.log(`Revision: ${revision.commit}`);
  console.log(`Harness revision: ${revision.harnessCommit}`);
  console.log(`Model: ${modelConfig.label}`);
  console.log(`Judge: ${judgeConfig.label}`);
  console.log(`Subject structured output method: ${structuredOutputMethod}`);
  console.log(`Cases: ${selectedCases.length.toString()}`);
  console.log(`Repeats: ${repeats.toString()}`);

  const results: LifecycleRunResult[] = [];
  for (const testCase of selectedCases) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const result = await runCase({
        testCase,
        repeat,
        subjectModel: modelConfig.model,
        judgeModel: judgeConfig.model,
        judgeStructuredOutputMethod: judgeConfig.method,
        subjectProfileId: modelConfig.metadata.profileId,
        subjectProfileFingerprint: modelConfig.metadata.fingerprint,
        judgeProfileId: judgeConfig.metadata.profileId,
        judgeProfileFingerprint: judgeConfig.metadata.fingerprint,
      });
      results.push(result);
      const failedScores = result.scores.filter(({ score }) => score !== 1)
        .map(({ key }) => key);
      const failedInvariants = result.invariants.filter(({ passed }) => !passed)
        .map(({ id }) => id);
      console.log(
        `[${result.status.toUpperCase()}] ${testCase.name} repeat=${repeat.toString()}`
        + ` decisions=${JSON.stringify(result.diagnostics.decisionCounts)}`
        + ` executorCalls=${result.diagnostics.executorCallCount.toString()}`
        + (failedScores.length > 0 ? ` failedGoals=${failedScores.join(',')}` : '')
        + (failedInvariants.length > 0 ? ` failedInvariants=${failedInvariants.join(',')}` : ''),
      );
      if (result.error) console.log(`  error=${result.error.message}`);
      if (result.goalAchieved === false) {
        console.log(`  turns=${JSON.stringify(result.turns)}`);
        console.log(`  scores=${JSON.stringify(result.scores)}`);
        console.log(`  invariants=${JSON.stringify(result.invariants)}`);
      }
    }
  }

  let subjectUsage: ProviderTokenUsage | null = null;
  let evaluatorUsage: ProviderTokenUsage | null = null;
  for (const result of results) {
    subjectUsage = addUsage(subjectUsage, result.usage.subject);
    evaluatorUsage = addUsage(evaluatorUsage, result.usage.evaluator);
  }
  const report = createLifecycleCompositionReport({
    revision,
    model: modelConfig.metadata,
    structuredOutputMethod,
    evaluator: {
      version: EVALUATOR_VERSION,
      model: judgeConfig.metadata,
      structuredOutputMethod: judgeConfig.method ?? 'provider-default',
    },
    selection: {
      dataset: orchestratorLifecycleCompositionDataset.name,
      cases: selectedCases.map(({ id }) => id),
      repeats,
    },
    results,
    summaries: summarize(results),
    usage: {
      subject: subjectUsage,
      evaluator: evaluatorUsage,
      estimatedCostUsd: sumKnownCosts(
        estimatePromptEvalCost(subjectUsage, modelConfig.pricing),
        estimatePromptEvalCost(evaluatorUsage, judgeConfig.pricing),
      ),
    },
  });
  const defaultPath = resolve(
    '.eval-results',
    `lifecycle-composition-${revision.commit.slice(0, 12)}-${Date.now().toString()}.json`,
  );
  const reportPath = resolve(process.env.LIFECYCLE_EVAL_REPORT_PATH ?? defaultPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('\nLifecycle summary:');
  for (const summary of report.summaries) {
    console.log(
      `- ${summary.caseName}: ${summary.achieved.toString()}/${summary.runs.toString()} achieved`
      + `; notEvaluable=${summary.notEvaluable.toString()}`
      + `; invokeErrors=${summary.invokeErrors.toString()}`
      + `; controlledExecutorExhausted=${summary.controlledExecutorExhausted.toString()}`,
    );
  }
  const achieved = results.filter(({ goalAchieved }) => goalAchieved === true).length;
  const notEvaluable = results.filter(({ status }) => status === 'not_evaluable').length;
  const invokeErrors = results.filter(({ status }) => status === 'invoke_error').length;
  const controlledExecutorExhausted = results.filter(
    ({ status }) => status === 'controlled_executor_exhausted',
  ).length;
  console.log(`\nOverall: ${achieved.toString()}/${results.length.toString()} achieved.`);
  if (notEvaluable > 0) console.log(`Not evaluable: ${notEvaluable.toString()}.`);
  if (invokeErrors > 0) console.log(`Invoke errors: ${invokeErrors.toString()}.`);
  if (controlledExecutorExhausted > 0) {
    console.log(`Controlled executor exhausted: ${controlledExecutorExhausted.toString()}.`);
  }
  console.log(`Report: ${reportPath}`);
  if (achieved !== results.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  });
}
