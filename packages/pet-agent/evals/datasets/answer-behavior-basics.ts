import type { AgentEvalCase, AgentEvalDataset } from './types.ts';

export const ANSWER_BEHAVIOR_BASICS_DATASET = 'agent-answer-behavior-basics';

export type AnswerBehaviorExpectation = {
  requiredAll?: string[];
  requiredAny?: string[];
  forbidden?: string[];
  maxCharacters?: number;
  minPriorAssistantVerbatimSpan?: number;
  maxPriorAssistantVerbatimSpan?: number;
  expectedBehavior: string;
};

export type AnswerBehaviorInput = {
  messages: Array<{
    role: 'user' | 'assistant';
    text: string;
  }>;
  completionContext?: {
    handoffFrom: 'general' | 'capability:explore';
    runId: string;
    task: string;
  };
};

export type AnswerBehaviorCase = AgentEvalCase<AnswerBehaviorInput, AnswerBehaviorExpectation>;

const SOURCE_FILE = 'packages/pet-agent/evals/datasets/answer-behavior-basics.ts';

export const answerBehaviorBasicsDataset: AgentEvalDataset<
  AnswerBehaviorInput,
  AnswerBehaviorExpectation
> = {
  name: ANSWER_BEHAVIOR_BASICS_DATASET,
  description: 'Answer-node behavior across direct replies, handoffs, replay, clarification, and completion acknowledgement.',
  metadata: {
    owner: 'pet-agent',
    areas: ['context_synthesis', 'delegation_control'],
  },
  cases: [
    {
      id: `${ANSWER_BEHAVIOR_BASICS_DATASET}.direct-answer`,
      name: 'direct-answer',
      suite: ANSWER_BEHAVIOR_BASICS_DATASET,
      tags: ['context_synthesis'],
      input: {
        messages: [{ role: 'user', text: '只回答这个问题：2 + 3 等于多少？' }],
      },
      expected: {
        requiredAny: ['5', '五'],
        forbidden: ['handoff', 'orchestrator'],
        maxCharacters: 80,
        expectedBehavior: 'direct',
      },
      metadata: { difficulty: 'easy', reason: 'Direct reply without internal language.', source: SOURCE_FILE },
    },
    {
      id: `${ANSWER_BEHAVIOR_BASICS_DATASET}.handoff-synthesis`,
      name: 'handoff-synthesis',
      suite: ANSWER_BEHAVIOR_BASICS_DATASET,
      tags: ['context_synthesis'],
      input: {
        messages: [
          { role: 'user', text: '根据调研结果告诉我推荐方案和主要风险。' },
          { role: 'assistant', text: '调研结论：首选方案是 Aurora；主要风险是 migration-window-17。' },
        ],
      },
      expected: {
        requiredAll: ['Aurora', 'migration-window-17'],
        forbidden: ['handoff', 'orchestrator'],
        maxCharacters: 300,
        expectedBehavior: 'synthesize_handoff',
      },
      metadata: { difficulty: 'medium', reason: 'Synthesize accepted result facts.', source: SOURCE_FILE },
    },
    {
      id: `${ANSWER_BEHAVIOR_BASICS_DATASET}.historical-replay`,
      name: 'historical-replay',
      suite: ANSWER_BEHAVIOR_BASICS_DATASET,
      tags: ['context_synthesis'],
      input: {
        messages: [
          { role: 'user', text: '保存这条发布结论。' },
          { role: 'assistant', text: 'ARCHIVE_RESULT_731：周四发布，回滚窗口为 30 分钟。' },
          { role: 'user', text: '请把上面的编号和回滚窗口原样再发一次。' },
        ],
      },
      expected: {
        requiredAll: ['ARCHIVE_RESULT_731', '30 分钟'],
        forbidden: ['handoff', 'orchestrator'],
        minPriorAssistantVerbatimSpan: 10,
        expectedBehavior: 'historical_replay',
      },
      metadata: { difficulty: 'medium', reason: 'Explicit replay should preserve requested facts.', source: SOURCE_FILE },
    },
    {
      id: `${ANSWER_BEHAVIOR_BASICS_DATASET}.clarification-question`,
      name: 'clarification-question',
      suite: ANSWER_BEHAVIOR_BASICS_DATASET,
      tags: ['route_control'],
      input: {
        messages: [{ role: 'user', text: '帮我更新生产配置。' }],
      },
      expected: {
        requiredAny: ['？', '?', '请提供', '请说明', '需要确认'],
        forbidden: ['已经更新', '已完成更新'],
        maxCharacters: 220,
        expectedBehavior: 'ask_user',
      },
      metadata: { difficulty: 'medium', reason: 'Missing target must produce a question, not a false claim.', source: SOURCE_FILE },
    },
    {
      id: `${ANSWER_BEHAVIOR_BASICS_DATASET}.delegation-completion-acknowledgement`,
      name: 'delegation-completion-acknowledgement',
      suite: ANSWER_BEHAVIOR_BASICS_DATASET,
      tags: ['context_synthesis', 'delegation_control'],
      input: {
        messages: [
          { role: 'user', text: '汇总本周发布风险。' },
          {
            role: 'assistant',
            text: [
              'RESULT_BODY_START',
              '完整风险正文：database-freeze-42；queue-drain-88；建议分三阶段切流。',
              'RESULT_BODY_END',
            ].join('\n'),
          },
        ],
        completionContext: {
          handoffFrom: 'general',
          runId: 'answer-eval-run',
          task: '汇总本周发布风险',
        },
      },
      expected: {
        requiredAny: ['完成', '已处理', '已汇总'],
        forbidden: ['RESULT_BODY_START', 'RESULT_BODY_END', 'database-freeze-42', 'queue-drain-88'],
        maxCharacters: 180,
        maxPriorAssistantVerbatimSpan: 24,
        expectedBehavior: 'completion_acknowledgement',
      },
      metadata: { difficulty: 'hard', reason: 'Close the lifecycle without replaying the delivered body.', source: SOURCE_FILE },
    },
  ],
};
