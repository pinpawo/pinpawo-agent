import type { PromptGoalAcceptanceCriterion } from '../prompt-goal-evaluator.ts';
import type { AgentEvalDataset } from './types.ts';

export type BudgetHandoffInput = {
  userMessage: string;
  contextWindowTokens: number;
  generationReserveTokens: number;
  reportChars: number;
};

export type BudgetHandoffExpected = {
  objective: string;
  acceptanceCriteria: PromptGoalAcceptanceCriterion[];
  expectedDelegations: number;
  contextHandoff: boolean;
};

const SUITE = 'agent-budget-handoff';
const SOURCE_FILE = 'tests/agent-evals/src/datasets/budget-handoff.ts';
const userMessage = [
  '请把证据读取和验证作为同一个完整任务完成，不修改外部资源。',
  '先用 read_evidence 获取报告中的关键事实和验证 ticket，再用 verify_evidence(ticket) 实际验证。',
  '最终用中文合并报告事实与验证结果；验证结果必须以工具的实际回执为依据，不能仅凭读到报告就宣称已验证。',
].join('\n');
const completedCriteria: PromptGoalAcceptanceCriterion[] = [
  {
    id: 'delivers_grounded_facts',
    statement: 'The final user-visible result communicates both the report fact EVIDENCE-6429 and the successful verification fact VERIFY-3817, grounded in the observed tool results.',
  },
  {
    id: 'does_not_invent_effects',
    statement: 'The result stays within the requested read-and-verify scope and does not claim that files, external resources, or the evidence source were modified.',
  },
];

export const budgetHandoffDataset: AgentEvalDataset<BudgetHandoffInput, BudgetHandoffExpected> = {
  name: SUITE,
  description: 'Real-model Capability budget handoff and Supervisor continuation through the production graph, with deterministic synthetic evidence tools.',
  metadata: { owner: 'pet-agent', areas: ['delegation_control', 'supervisor_boundary', 'context_synthesis'] },
  cases: [
    {
      id: `${SUITE}.context-window-handoff`,
      name: 'context-window-handoff',
      suite: SUITE,
      tags: ['delegation_control', 'interruption_recovery', 'supervisor_boundary', 'context_synthesis'],
      input: {
        userMessage,
        contextWindowTokens: 16_000,
        generationReserveTokens: 0,
        reportChars: 52_000,
      },
      expected: {
        objective: '先读取真实工具证据，在上下文预算交接后继续同一个任务，完成实际验证并向用户交付两项有依据的事实。',
        acceptanceCriteria: [
          ...completedCriteria,
          {
            id: 'handoff_preserves_unfinished_work',
            statement: 'The first Capability delivery accurately preserves the report fact and the opaque verification ticket, clearly states that verification is unfinished, and gives the next invocation enough information to perform verification without inventing its result.',
          },
          {
            id: 'continues_from_actual_progress',
            statement: 'The continuation uses the prior delivery to complete the missing verification, and the final reply synthesizes the completed evidence rather than merely reporting that a handoff occurred.',
          },
        ],
        expectedDelegations: 2,
        contextHandoff: true,
      },
      metadata: {
        difficulty: 'hard',
        reason: 'A large synthetic tool result reaches the configured context watermark; real executor and Supervisor models must preserve unfinished work and finish it in a fresh delegation of the same plan item.',
        source: SOURCE_FILE,
      },
    },
    {
      id: `${SUITE}.below-watermark-control`,
      name: 'below-watermark-control',
      suite: SUITE,
      tags: ['delegation_control', 'supervisor_boundary', 'context_synthesis'],
      input: {
        userMessage,
        contextWindowTokens: 16_000,
        generationReserveTokens: 0,
        reportChars: 1_600,
      },
      expected: {
        objective: '在上下文预算充足时，同一次 Capability 执行完成读取与实际验证，向用户交付两项有依据的事实。',
        acceptanceCriteria: [...completedCriteria],
        expectedDelegations: 1,
        contextHandoff: false,
      },
      metadata: {
        difficulty: 'medium',
        reason: 'A short synthetic report is a negative control: ordinary execution should complete without an unnecessary handoff or redelegation.',
        source: SOURCE_FILE,
      },
    },
  ],
};
