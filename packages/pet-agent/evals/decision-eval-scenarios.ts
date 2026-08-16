import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  buildGoalCreationSystemPrompt,
} from '../src/agent/orchestrator/prompts.ts';
import { USER_GOAL_MAX_CHARS } from '../src/agent/orchestrator/capabilityPlanner/runner.ts';
import { readMessageText } from '../src/agent/orchestrator/utils.ts';
import type { AgentModels } from '../src/types/agent.ts';
import type { StructuredOutputMethod } from '../src/utils/structuredOutput.ts';
import type { DecisionContractScore } from './decision-contract-scorers.ts';
import type { PromptEvalJudge } from './prompt-goal-evaluator.ts';

export type DecisionEvalTarget = 'goal_creation';

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
  contract: 'goal_creation.text';
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

const DATASET_NAME = 'agent-goal-creation-basics';
type GoalCreationEvalCase = {
  name: string;
  messages: readonly {
    role: 'user' | 'assistant';
    text: string;
  }[];
  requiredTerms: readonly string[];
  forbiddenTerms?: readonly string[];
  maxChars?: number;
};

const GOAL_CASES: readonly GoalCreationEvalCase[] = [
  {
    name: 'direct-answer-goal',
    messages: [{ role: 'user', text: '只回答这个问题：2 + 3 等于多少？' }],
    requiredTerms: ['2 + 3'],
  },
  {
    name: 'preserves-path-and-scope',
    messages: [{ role: 'user', text: '只检查 /tmp/project 的 README，不要修改文件。' }],
    requiredTerms: ['/tmp/project', 'README', '不要修改'],
  },
  {
    name: 'resolves-current-coreference',
    messages: [
      { role: 'user', text: '把 #619 和 #621 的 review 问题整理好了。' },
      { role: 'assistant', text: '两个问题都已整理为草案。' },
      { role: 'user', text: '把这些发到 GitHub issue。' },
    ],
    requiredTerms: ['#619', '#621', 'GitHub issue'],
  },
  {
    name: 'keeps-latest-confirmed-scope',
    messages: [
      { role: 'user', text: '重构 Entry、Planner 和 Answer。' },
      { role: 'assistant', text: '最后确认本轮只改 Entry，不动 Planner 和 Answer。' },
      { role: 'user', text: '按最后确认的范围继续。' },
    ],
    requiredTerms: ['Entry', '不动 Planner', 'Answer'],
  },
  {
    name: 'contextual-follow-up-does-not-restore-completed-goal',
    messages: [
      {
        role: 'user',
        text: '帮我看下。https://github.com/pinpawo/pinpawo-agent/issues/645 这个issue，然后你分析代码看看，如何拆分才是最合理的。',
      },
      {
        role: 'assistant',
        text: '分析完成：issue #645 的核心是统一 Host 的 Capability、Toolkit 与 Runtime 装配。当前 local tools 同时维护扁平 coreLocalTools 和 bash/git Toolkit，形成重复 inventory。相关代码位于 localAgentCapabilityRegistry.ts、toolkits/local/index.ts、types/toolkit.ts 和 toolkitRuntime.ts。建议分步删除双 inventory、统一 execution scope、移除 Browser Host 特殊化并整理 CLI Toolkit 边界。',
      },
      {
        role: 'assistant',
        text: '已完成 issue #645 的代码分析与任务拆分，关键结论是先清理重复 inventory，再统一 Runtime 装配。',
      },
      {
        role: 'user',
        text: '这个 inventory我不是很理解。你解释下 他在这个系统中的作用。',
      },
    ],
    requiredTerms: ['inventory', '作用'],
    forbiddenTerms: ['分析 GitHub issue #645', '给出最合理的任务拆分方案'],
    maxChars: 300,
  },
  {
    name: 'canonical-compaction-context-anchors-follow-up',
    messages: [
      {
        role: 'assistant',
        text: '<context_summary role="context" source="compaction">已确认 issue #651 的目标：把 compaction summary 改为 canonical context message，并让 Goal Creation 与 Answer 读取同一条主对话。</context_summary>',
      },
      {
        role: 'assistant',
        text: '<delegation_started><task>更新 issue #651，核对 compaction、Goal Creation 与 Answer 的边界。</task></delegation_started>',
      },
      {
        role: 'assistant',
        text: 'Issue #651 已更新，代码尚未实现。',
      },
      {
        role: 'user',
        text: 'OK，帮我推进代码的改动吧。',
      },
    ],
    requiredTerms: ['#651', 'compaction', '代码'],
    maxChars: 300,
  },
];

function renderMessages(prompt: RenderedDecisionPrompt) {
  return [
    new SystemMessage(prompt.system),
    ...(prompt.input ? [new HumanMessage(prompt.input)] : []),
    ...(prompt.conversationMessages ?? []),
  ];
}

function goalScenarios(): DecisionEvalScenario[] {
  return GOAL_CASES.map((testCase) => {
    const render = (): RenderedDecisionPrompt => {
      const conversationMessages = testCase.messages.map((message) => message.role === 'user'
        ? new HumanMessage(message.text)
        : new AIMessage(message.text));
      const currentRequest = conversationMessages.at(-1);
      if (!currentRequest || currentRequest._getType() !== 'human') {
        throw new Error('Goal Creation eval case must end with a user message.');
      }
      return {
        system: buildGoalCreationSystemPrompt(),
        input: '',
        conversationMessages,
      };
    };
    return {
      target: 'goal_creation',
      contract: 'goal_creation.text',
      objective: 'Create a stable text goal that preserves the current request and required context.',
      datasetName: DATASET_NAME,
      caseId: `${DATASET_NAME}.${testCase.name}`,
      caseName: testCase.name,
      expectedSummary: testCase.requiredTerms.join(', '),
      render,
      async run(model, _method, config) {
        const goal = readMessageText(await model.invoke(renderMessages(render()), config)).trim();
        if (!goal || goal.length > USER_GOAL_MAX_CHARS) {
          throw new Error('Goal Creation returned invalid text.');
        }
        const scores: DecisionContractScore[] = testCase.requiredTerms.map((term) => ({
          key: `preserves_${term}`,
          statement: `Preserve the current-goal term: ${term}`,
          evaluator: 'deterministic',
          score: goal.includes(term) ? 1 : 0,
          comment: goal.includes(term) ? 'present' : 'missing',
        }));
        for (const term of testCase.forbiddenTerms ?? []) {
          scores.push({
            key: `excludes_${term}`,
            statement: `Do not restore the completed-goal term: ${term}`,
            evaluator: 'deterministic',
            score: goal.includes(term) ? 0 : 1,
            comment: goal.includes(term) ? 'present' : 'absent',
          });
        }
        if (testCase.maxChars !== undefined) {
          scores.push({
            key: 'keeps_goal_concise',
            statement: `Keep the User Goal within ${testCase.maxChars.toString()} characters.`,
            evaluator: 'deterministic',
            score: goal.length <= testCase.maxChars ? 1 : 0,
            comment: `chars=${goal.length.toString()}`,
          });
        }
        return {
          output: { goal },
          scores,
          verdict: scores.every(({ score }) => score === 1) ? 'valid_goal' : 'missing_context',
          shape: `text=${goal.length.toString()}`,
        };
      },
    };
  });
}

export function getDecisionEvalScenarios(target?: DecisionEvalTarget): DecisionEvalScenario[] {
  const scenarios = goalScenarios();
  return target ? scenarios.filter((scenario) => scenario.target === target) : scenarios;
}
