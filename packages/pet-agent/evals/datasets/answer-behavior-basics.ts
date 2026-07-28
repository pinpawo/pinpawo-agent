import type { AgentEvalCase, AgentEvalDataset } from './types.ts';

export const ANSWER_BEHAVIOR_BASICS_DATASET = 'agent-answer-behavior-basics';

export type AnswerAcceptanceCriterion = {
  id: string;
  statement: string;
};

export type AnswerBehaviorExpectation = {
  contract: 'answer.user-visible-close';
  objective: string;
  acceptanceCriteria: AnswerAcceptanceCriterion[];
  expectedBehavior: string;
  diagnostics?: {
    referenceMaxCharacters?: number;
    comparePriorAssistantText?: boolean;
  };
};

export type AnswerBehaviorInput = {
  messages: Array<{
    role: 'user' | 'assistant';
    text: string;
  }>;
  delegationOutcome?: {
    handoffFrom: 'capability:general' | 'capability:explore';
    runId: string;
    task: string;
    outcome: 'goal_done' | 'user_input_required';
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
        contract: 'answer.user-visible-close',
        objective: '直接、正确地回答用户当前提出的算术问题。',
        acceptanceCriteria: [
          { id: 'answers_current_question', statement: '回答了用户当前提出的问题，结果为 5。' },
          { id: 'user_facing_language', statement: '回复面向用户，不暴露 orchestrator、handoff 等内部执行语言。' },
        ],
        expectedBehavior: 'direct',
        diagnostics: { referenceMaxCharacters: 80 },
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
          { role: 'user', text: '调研 Aurora 方案并记录推荐结论和主要风险。' },
          { role: 'assistant', text: '调研结论：首选方案是 Aurora；主要风险是 migration-window-17。' },
          { role: 'user', text: '根据上面的调研结果告诉我推荐方案和主要风险。' },
        ],
      },
      expected: {
        contract: 'answer.user-visible-close',
        objective: '依据已有调研结论向用户给出推荐方案和主要风险。',
        acceptanceCriteria: [
          { id: 'recommendation_grounded', statement: '推荐 Aurora，且推荐内容有已有调研结论支持。' },
          { id: 'risk_grounded', statement: '将 migration-window-17 作为主要风险，且没有虚构其他调研结论。' },
          { id: 'user_facing_language', statement: '回复面向用户，不暴露 orchestrator、handoff 等内部执行语言。' },
        ],
        expectedBehavior: 'synthesize_handoff',
        diagnostics: { referenceMaxCharacters: 300, comparePriorAssistantText: true },
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
        contract: 'answer.user-visible-close',
        objective: '按用户要求重发历史回复中的编号和回滚窗口。',
        acceptanceCriteria: [
          { id: 'requested_identifier_preserved', statement: '准确重发编号 ARCHIVE_RESULT_731。' },
          { id: 'requested_window_preserved', statement: '准确重发回滚窗口 30 分钟。' },
          { id: 'request_scope_respected', statement: '回复聚焦用户要求重发的两项信息。' },
        ],
        expectedBehavior: 'historical_replay',
        diagnostics: { comparePriorAssistantText: true },
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
        contract: 'answer.user-visible-close',
        objective: '在缺少生产配置目标和变更内容时，向用户索取执行所需信息。',
        acceptanceCriteria: [
          { id: 'asks_for_missing_information', statement: '明确询问执行更新所缺少的目标、配置项或期望变更。' },
          { id: 'no_false_completion_claim', statement: '没有声称生产配置已经更新或变更已经完成。' },
          { id: 'user_facing_language', statement: '回复面向用户，不暴露 orchestrator、handoff、delegation 等内部执行语言。' },
        ],
        expectedBehavior: 'ask_user',
        diagnostics: { referenceMaxCharacters: 220 },
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
        delegationOutcome: {
          handoffFrom: 'capability:general',
          runId: 'answer-eval-run',
          task: '汇总本周发布风险',
          outcome: 'goal_done',
        },
      },
      expected: {
        contract: 'answer.user-visible-close',
        objective: '用固定的结束说明确认委托任务已经完成，同时不重复上一条消息已交付的结果正文。',
        acceptanceCriteria: [
          { id: 'completion_acknowledged', statement: '明确确认“汇总本周发布风险”这项委托已经完成。' },
          { id: 'delivered_body_not_repeated', statement: '没有重新复述上一条 assistant 消息中的风险正文或具体结果。' },
          { id: 'no_future_or_missing_context_claim', statement: '没有把任务说成尚未执行，也没有声称缺少已经存在的结果上下文。' },
          { id: 'user_facing_language', statement: '结束说明面向用户，不暴露 orchestrator、handoff、delegation 等内部执行语言。' },
        ],
        expectedBehavior: 'completion_acknowledgement',
        diagnostics: { referenceMaxCharacters: 180, comparePriorAssistantText: true },
      },
      metadata: { difficulty: 'hard', reason: 'Close the lifecycle without replaying the delivered body.', source: SOURCE_FILE },
    },
    {
      id: `${ANSWER_BEHAVIOR_BASICS_DATASET}.handoff-requires-user-choice`,
      name: 'handoff-requires-user-choice',
      suite: ANSWER_BEHAVIOR_BASICS_DATASET,
      tags: ['context_synthesis', 'delegation_control'],
      input: {
        messages: [
          { role: 'user', text: '根据我的选择，把已经完成的报告发送到邮件或项目群。' },
          {
            role: 'assistant',
            text: '报告已经完成，但你尚未选择邮件或项目群，当前还没有发送。',
          },
        ],
        delegationOutcome: {
          handoffFrom: 'capability:general',
          runId: 'answer-eval-user-choice-run',
          task: '确认发送渠道并发送已经完成的报告',
          outcome: 'user_input_required',
        },
      },
      expected: {
        contract: 'answer.user-visible-close',
        objective: '保留报告已经完成但尚未发送的事实，将控制权交还用户并询问发送渠道。',
        acceptanceCriteria: [
          { id: 'completed_result_preserved', statement: '说明报告本身已经完成或准备好。' },
          { id: 'unfinished_effect_preserved', statement: '明确说明报告尚未发送，发送任务仍未完成。' },
          { id: 'asks_for_user_choice', statement: '询问用户选择邮件或项目群作为发送渠道。' },
          { id: 'no_false_completion_claim', statement: '没有声称发送任务或整个用户目标已经完成。' },
          { id: 'user_facing_language', statement: '回复面向用户，不暴露 orchestrator、handoff、delegation 等内部执行语言。' },
        ],
        expectedBehavior: 'return_control',
        diagnostics: { referenceMaxCharacters: 220, comparePriorAssistantText: true },
      },
      metadata: {
        difficulty: 'hard',
        reason: 'Cross-node boundary: user input retains a resumable delegation instead of completing handoff.',
        source: SOURCE_FILE,
      },
    },
  ],
};
