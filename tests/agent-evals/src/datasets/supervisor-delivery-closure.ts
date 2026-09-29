import type { AgentEvalDataset } from './types';

export type ClosureExample = {
  goal: string;
  task?: string;
  capability?: string;
  evidence?: string;
  remaining?: Array<{ capability: string; objective: string }>;
  staleCompletion?: boolean;
  disclosure?: 'manifest' | 'full';
};
export type ClosureExpected = { action: 'report' | 'reply' | 'review'; maxAdjustments?: number };
const goal = '独立复核任务 T-NEW 的三个配置文件，给出结论，并把完整审阅结果提交到看板。';
const evidence = '已独立读取三个配置文件。结论：通过；根 build 命中 web、不命中 app；根 test 命中 app、不命中 web。依据：根 scripts 使用递归同名命令，app 有 test 无 build，web 有 build 无 test。未运行构建测试。实际操作：task_list、task_start、read_file。当前任务 T-NEW 为 doing，以上是审阅交付文本。';
const examples: Array<[string, ClosureExample, ClosureExpected]> = [
  ['entry-split', { goal }, { action: 'review' }],
  ['review-text-is-not-submission', { goal, capability: 'studio_review', task: '独立核验三个配置文件，返回审阅结论，并将结果提交看板。', evidence }, { action: 'report', maxAdjustments: 1 }],
  ['accepted-work-missing-report-plan', { goal, capability: 'studio_review', task: '独立核验三个配置文件并返回审阅结论。', evidence }, { action: 'report', maxAdjustments: 1 }],
  ['pending-report', { goal, capability: 'studio_review', task: '独立核验三个配置文件并返回审阅结论。', evidence, remaining: [{ capability: 'studio_reporting', objective: '提交 T-NEW 的完整审阅结论。' }] }, { action: 'report', maxAdjustments: 0 }],
  ['briefing-reuses-delivery', { goal, capability: 'studio_review', task: '确认配置覆盖范围', evidence, remaining: [{ capability: 'studio_reporting', objective: '将审阅结论提交到 T-NEW' }] }, { action: 'report', maxAdjustments: 0 }],
  ['stale-completion', { goal, capability: 'studio_review', task: '独立核验三个配置文件并将结果提交到看板。', evidence, staleCompletion: true }, { action: 'report', maxAdjustments: 1 }],
  ['verbal-submission-claim', { goal, capability: 'studio_review', task: '独立核验三个配置文件并将结果提交到看板。', evidence: evidence.replace('当前任务 T-NEW 为 doing，以上是审阅交付文本。', '审阅结论已写入任务 T-NEW 的看板结果，本任务已完成，可交给 Wiki。') }, { action: 'report', maxAdjustments: 1 }],
  ['e2e-review-delivery', { goal, capability: 'studio_review', task: '独立读取三个配置文件并复核已有结论，给出通过或需修正判定，最后将审阅结论写入看板任务结果。', evidence: evidence.replace('当前任务 T-NEW 为 doing，以上是审阅交付文本。', '复核完成，判定通过，可交由 Wiki 根据本审阅结论更新知识。'), staleCompletion: true, disclosure: 'manifest' }, { action: 'report', maxAdjustments: 1 }],
  ['already-submitted', { goal, capability: 'studio_reporting', task: '提交 T-NEW 的完整审阅结论。', evidence: evidence + '\n前序独立复核已验收通过。task_complete 成功回执：taskId=T-NEW, status=done, result=通过，附三份配置脚本证据、四条覆盖结论以及未运行构建测试的边界。随后 task_list 确认同一任务已保存相同结果。' }, { action: 'reply', maxAdjustments: 0 }],
  ['review-only', { goal: '只独立复核三个配置文件并在聊天中给出结论，不提交看板。', capability: 'studio_review', task: '独立复核三个配置文件并返回结论。', evidence }, { action: 'reply', maxAdjustments: 0 }],
  ['minor-formatting-accept', { goal: '独立复核三个配置文件，给出结论和简短说明。', capability: 'studio_review', task: '独立复核三个配置文件，返回结论和简短说明。', evidence: '已读取并复核三个配置文件，结论通过。根 build 覆盖 web，根 test 覆盖 app，与各子项目提供的脚本一致。结果以段落给出，未整理成表格；未附逐次工具回执。' }, { action: 'reply', maxAdjustments: 0 }],
  ['major-missing-work-retry', { goal: '独立复核三个配置文件，给出结论和简短说明。', capability: 'studio_review', task: '独立复核三个配置文件，返回结论和简短说明。', evidence: '本次只读取了根配置，尚未读取 app 和 web 的两个配置文件，无法判断脚本覆盖关系。需要继续读取后再给出结论。' }, { action: 'review', maxAdjustments: 0 }],
];
export const supervisorDeliveryClosureDataset: AgentEvalDataset<ClosureExample, ClosureExpected> = {
  name: 'supervisor-delivery-closure',
  description: 'Issue #815: distinguish capability delivery, persisted effects and whole-goal completion. Synthetic examples; no private workspace data.',
  metadata: { owner: 'pet-agent', areas: ['supervisor_boundary', 'capability_planning'] },
  cases: examples.map(([name, input, expected]) => ({
    id: `supervisor-delivery-closure-${name}`, name, input, expected, suite: 'supervisor-delivery-closure',
    tags: ['supervisor_boundary', 'capability_planning'],
    metadata: { difficulty: 'hard', reason: 'Score actual delegated capability or natural completion, not wording or a prescribed control sequence.', source: 'issue-815-synthetic' },
  })),
};
