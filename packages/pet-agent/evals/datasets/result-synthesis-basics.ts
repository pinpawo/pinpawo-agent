import type { AgentEvalCase, AgentEvalDataset } from './types.ts';

export const RESULT_SYNTHESIS_BASICS_DATASET = 'agent-result-synthesis-basics';

export type ResultSynthesisExpectation = {
  contract: 'result_synthesis.user-visible-close';
  objective: string;
  acceptanceCriteria: Array<{ id: string; statement: string }>;
  expectedBehavior: string;
  diagnostics?: {
    referenceMaxCharacters?: number;
    comparePriorAssistantText?: boolean;
    referenceMaxPriorAssistantRatio?: number;
  };
};

export type ResultSynthesisInput = {
  userRequest: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  acceptedResults: Array<{ task: string; result: string }>;
};

export type ResultSynthesisCase = AgentEvalCase<
  ResultSynthesisInput,
  ResultSynthesisExpectation
>;

const SOURCE_FILE = 'packages/pet-agent/evals/datasets/result-synthesis-basics.ts';

export const resultSynthesisBasicsDataset: AgentEvalDataset<
  ResultSynthesisInput,
  ResultSynthesisExpectation
> = {
  name: RESULT_SYNTHESIS_BASICS_DATASET,
  description: 'Goal-level composition of multiple accepted execution results.',
  metadata: {
    owner: 'pet-agent',
    areas: ['context_synthesis', 'delegation_control', 'multi_task_flow'],
  },
  cases: [{
    id: `${RESULT_SYNTHESIS_BASICS_DATASET}.multi-handoff-compression`,
    name: 'multi-handoff-compression',
    suite: RESULT_SYNTHESIS_BASICS_DATASET,
    tags: ['context_synthesis', 'delegation_control', 'multi_task_flow'],
    input: {
      userRequest: '完成发布准备：审查风险、修复阻塞问题并提交 PR。',
      messages: [
        { role: 'user', text: '完成发布准备：审查风险、修复阻塞问题并提交 PR。' },
        { role: 'assistant', text: '风险审查完成：发现阻塞项 cache-key-17，建议统一 transcriptRunId。' },
        { role: 'assistant', text: '阻塞问题修复完成：已统一 transcriptRunId，并为 resume 场景补充测试。' },
        { role: 'assistant', text: 'PR #643 已创建，当前没有剩余阻塞项。' },
      ],
      acceptedResults: [
        {
          task: '审查风险',
          result: '风险审查已完成：发现阻塞项 cache-key-17；建议统一 transcriptRunId 的使用。',
        },
        {
          task: '修复阻塞问题',
          result: '已统一 transcriptRunId，并为 resume 场景补充测试；测试通过。',
        },
        {
          task: '提交 PR',
          result: 'PR #643 已创建，包含上述修复和测试；当前没有剩余阻塞项。',
        },
      ],
    },
    expected: {
      contract: 'result_synthesis.user-visible-close',
      objective: '把多个已接受结果合并成围绕用户目标的闭合摘要，而不是逐条重播执行阶段。',
      acceptanceCriteria: [
        { id: 'task_level_completion', statement: '从整个发布准备目标说明任务已经完成。' },
        { id: 'key_cross_handoff_facts_preserved', statement: '保留 cache-key-17 已通过统一 transcriptRunId 修复、resume 测试通过、PR #643 已创建且没有剩余阻塞项。' },
        { id: 'handoffs_synthesized_once', statement: '围绕最终目标合并多个结果，没有逐项重述三个执行阶段。' },
        { id: 'self_contained_summary', statement: '回复自身包含用户理解最终交付所需的关键信息。' },
      ],
      expectedBehavior: 'compressed_task_summary',
      diagnostics: {
        referenceMaxCharacters: 240,
        comparePriorAssistantText: true,
        referenceMaxPriorAssistantRatio: 0.7,
      },
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Multiple accepted results need one goal-level summary.',
      source: SOURCE_FILE,
    },
  }],
};
