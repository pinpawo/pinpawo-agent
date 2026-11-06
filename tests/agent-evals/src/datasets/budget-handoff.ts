import type { PromptGoalAcceptanceCriterion } from '../prompt-goal-evaluator.ts';
import type { AgentEvalDataset } from './types.ts';

export type BudgetHandoffInput = {
  userMessage: string;
  scenario?: 'context-overflow' | 'model-call-exhausted';
  contextWindowTokens: number;
  generationReserveTokens: number;
  reportChars: number;
};

export type BudgetHandoffExpected = {
  objective: string;
  acceptanceCriteria: PromptGoalAcceptanceCriterion[];
  expectedDelegations: number;
  contextHandoff: boolean;
  contextOverflow?: boolean;
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
      id: `${SUITE}.context-already-exceeded`,
      name: 'context-already-exceeded',
      suite: SUITE,
      tags: ['delegation_control', 'interruption_recovery', 'supervisor_boundary'],
      input: {
        userMessage,
        scenario: 'context-overflow',
        contextWindowTokens: 16_000,
        generationReserveTokens: 0,
        reportChars: 70_000,
      },
      expected: {
        objective: '工具结果一次越过上下文硬上限后，如实保留首次无交付状态；Supervisor 在同一任务下重新委派，重新获取可用证据并完成实际验证。',
        acceptanceCriteria: [
          ...completedCriteria,
          {
            id: 'recovers_without_fabricated_handoff',
            statement: 'After the first attempt returns missing_deliverable with no delivery, the Supervisor treats the work as incomplete and retries the same task. The fresh attempt rereads evidence and actually verifies it; neither the Supervisor nor the final reply presents the failed attempt as a successful handoff or invents private findings from it.',
          },
        ],
        expectedDelegations: 2,
        contextHandoff: false,
        contextOverflow: true,
      },
      metadata: {
        difficulty: 'hard',
        reason: 'The first synthetic report exceeds the logical input capacity in one step. The native hard guard must block the next provider request; a fresh delegation can reread a bounded report and finish.',
        source: SOURCE_FILE,
      },
    },
    {
      id: `${SUITE}.model-call-budget-exhausted`,
      name: 'model-call-budget-exhausted',
      suite: SUITE,
      tags: ['delegation_control', 'interruption_recovery'],
      input: {
        userMessage,
        scenario: 'model-call-exhausted',
        contextWindowTokens: 16_000,
        generationReserveTokens: 0,
        reportChars: 1_600,
      },
      expected: {
        objective: '真实子代理在两次模型调用预算内读取证据并交接；受控重入尝试第三次调用时被原生硬限制拦截，保留有效交接，再由手工驱动的新 invocation 依据交接完成真实验证。',
        acceptanceCriteria: [
          ...completedCriteria.map(criterion => criterion.id === 'delivers_grounded_facts' ? {
            ...criterion,
            statement: 'The final continuation output communicates both report fact EVIDENCE-6429 and successful verification fact VERIFY-3817, grounded in the observed tool results.',
          } : criterion),
          {
            id: 'call_budget_handoff_preserves_progress',
            statement: 'The first real subagent delivery preserves EVIDENCE-6429 and the exact opaque ticket, explicitly leaves verification unfinished, and supplies enough information for the fresh invocation to actually verify without rereading the report or inventing success.',
          },
        ],
        expectedDelegations: 2,
        contextHandoff: false,
      },
      metadata: {
        difficulty: 'hard',
        reason: 'Real createSubagent calls with a scaled two-call budget and eval-only afterModel re-entry exercise the native already-exhausted guard. Continuation is manually driven; this case does not evaluate Supervisor scheduling or the default 100-call budget.',
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
