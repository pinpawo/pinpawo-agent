import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type CapabilityPlanningInput = {
  mode: 'entry' | 'boundary';
  userGoal: string;
  capabilityRegistry: string[];
  completedTasks?: Array<{ objective: string; result: string | null }>;
  remainingPlan?: Array<{ objective: string; capabilityIntent: string }>;
  latestHandoff?: string;
};

export type CapabilityPlanningExpected = {
  result: 'next_task' | 'answer';
  nextTaskTerms?: string[];
  capabilityIntent?: string;
  remainingPlan: Array<{ objectiveTerms: string[]; capabilityIntent: string }>;
  exactRemainingPlanLength?: number;
  planEffect: 'created' | 'revised' | 'cancelled' | 'unchanged' | 'empty';
  rubberStamp: boolean;
  reason: string;
};

const SUITE = 'agent-capability-planning-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/capability-planning-basics.ts';

const cases: AgentEvalCase<CapabilityPlanningInput, CapabilityPlanningExpected>[] = [
  {
    id: `${SUITE}.entry-explore-then-implementation`,
    name: 'entry-explore-then-implementation',
    suite: SUITE,
    tags: ['capability_planning', 'entry_decision'],
    input: {
      mode: 'entry',
      userGoal: '在当前仓库中完成 auth 模块重构。具体改动必须以模块现有结构和风险为依据。',
      capabilityRegistry: [
        'explore: inspect code structure and risks',
        'general: use workspace tools to edit and verify code',
      ],
    },
    expected: {
      result: 'next_task',
      nextTaskTerms: ['auth', '结构', '风险'],
      capabilityIntent: '代码库分析',
      remainingPlan: [
        { objectiveTerms: ['auth', '重构'], capabilityIntent: '代码修改' },
      ],
      planEffect: 'created',
      rubberStamp: false,
      reason: 'Entry planning creates exploration first and preserves implementation as future work.',
    },
    metadata: { difficulty: 'hard', reason: 'planner@entry dynamic plan.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-keeps-investigation-scope`,
    name: 'entry-keeps-investigation-scope',
    suite: SUITE,
    tags: ['capability_planning', 'entry_decision'],
    input: {
      mode: 'entry',
      userGoal: '调查支付模块失败测试的根因、涉及代码和触发条件，确认调查完整后再结束。',
      capabilityRegistry: [
        'workspace_analysis: inspect tests, source code, and failure conditions',
        'code_change: modify code and verify tests',
      ],
    },
    expected: {
      result: 'next_task',
      nextTaskTerms: ['支付', '失败测试', '根因', '代码', '触发条件', '完整'],
      capabilityIntent: '代码库调查',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'created',
      rubberStamp: false,
      reason: 'One investigation result stays within the requested scope and does not create an unrequested implementation task.',
    },
    metadata: { difficulty: 'hard', reason: 'Goal scope and same-capability task grouping.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-materializes-from-explore-handoff`,
    name: 'boundary-materializes-from-explore-handoff',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'boundary',
      userGoal: '在当前仓库中完成 auth 模块重构。具体改动必须以模块现有结构和风险为依据。',
      capabilityRegistry: [
        'explore: inspect code structure and risks',
        'general: use workspace tools to edit and verify code',
      ],
      completedTasks: [{
        objective: '调查 auth 模块的现有结构和风险',
        result: 'auth/index.ts 存在循环依赖；应提取 token validation 并保持现有公开接口。',
      }],
      remainingPlan: [{ objective: '根据调查结论重构 auth 模块', capabilityIntent: '代码修改' }],
      latestHandoff: 'auth/index.ts 存在循环依赖；应提取 token validation 并保持现有公开接口。',
    },
    expected: {
      result: 'next_task',
      nextTaskTerms: ['循环依赖', 'token', '接口'],
      capabilityIntent: '代码修改',
      remainingPlan: [],
      planEffect: 'revised',
      rubberStamp: false,
      reason: 'Boundary planning materializes implementation details from the handoff.',
    },
    metadata: { difficulty: 'hard', reason: 'planner@boundary materialization.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-cancels-obsolete-task`,
    name: 'boundary-cancels-obsolete-task',
    suite: SUITE,
    tags: ['capability_planning', 'context_synthesis'],
    input: {
      mode: 'boundary',
      userGoal: '确认配置是否正确，必要时修复。',
      capabilityRegistry: [
        'explore: inspect project configuration',
        'general: modify and verify workspace files',
      ],
      completedTasks: [{
        objective: '检查项目配置是否与文档一致',
        result: '配置与文档完全一致，验证通过，不需要修改。',
      }],
      remainingPlan: [{ objective: '修复错误配置', capabilityIntent: '配置修改' }],
      latestHandoff: '配置与文档完全一致，验证通过，不需要修改。',
    },
    expected: {
      result: 'answer',
      remainingPlan: [],
      planEffect: 'cancelled',
      rubberStamp: false,
      reason: 'The completed result makes the planned repair unnecessary.',
    },
    metadata: { difficulty: 'medium', reason: 'Boundary cancellation.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-keeps-valid-next-task`,
    name: 'boundary-keeps-valid-next-task',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'boundary',
      userGoal: '生成报告并发送给项目负责人。',
      capabilityRegistry: [
        'document_writer: create report documents',
        'messaging: deliver messages and attachments',
        'general: perform other available work',
      ],
      completedTasks: [{
        objective: '生成项目报告',
        result: '报告已生成，路径为 /tmp/report.pdf，内容检查通过。',
      }],
      remainingPlan: [{ objective: '把完成的报告发送给项目负责人', capabilityIntent: '文档发送' }],
      latestHandoff: '报告已生成，路径为 /tmp/report.pdf，内容检查通过。',
    },
    expected: {
      result: 'next_task',
      nextTaskTerms: ['报告', '发送', '负责人'],
      capabilityIntent: '文档发送',
      remainingPlan: [],
      planEffect: 'unchanged',
      rubberStamp: true,
      reason: 'The planned next task remains valid after the handoff.',
    },
    metadata: { difficulty: 'medium', reason: 'Rubber-stamp measurement case.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-materializes-head-and-preserves-tail`,
    name: 'boundary-materializes-head-and-preserves-tail',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'boundary',
      userGoal: '根据调查修复 auth 风险，然后独立运行 release verification。',
      capabilityRegistry: [
        'general: modify source code',
        'release_check: run release verification',
      ],
      completedTasks: [{
        objective: '调查 auth 风险',
        result: '调查确认 token validation 存在循环依赖，需要保持公开接口。',
      }],
      remainingPlan: [
        { objective: '根据调查结论修复 auth 风险', capabilityIntent: '代码修改' },
        { objective: '独立运行 release verification', capabilityIntent: '发布质量验证' },
      ],
      latestHandoff: '调查确认 token validation 存在循环依赖，需要保持公开接口。',
    },
    expected: {
      result: 'next_task',
      nextTaskTerms: ['token', '循环依赖', '公开接口'],
      capabilityIntent: '代码修改',
      remainingPlan: [{
        objectiveTerms: ['release', 'verification'],
        capabilityIntent: '发布质量验证',
      }],
      planEffect: 'revised',
      rubberStamp: false,
      reason: 'Boundary planning materializes only the next task and preserves later future work as tail.',
    },
    metadata: { difficulty: 'hard', reason: 'Separated next_task and future tail.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-preserves-result-dependent-followup`,
    name: 'entry-preserves-result-dependent-followup',
    suite: SUITE,
    tags: ['capability_planning', 'entry_decision'],
    input: {
      mode: 'entry',
      userGoal: '确认当前仓库测试是否通过，并把最终结论更新到 issue #417。',
      capabilityRegistry: [
        'general: inspect the workspace and run project tests',
        'github: read and update repository issues',
      ],
    },
    expected: {
      result: 'next_task',
      nextTaskTerms: ['仓库', '测试', '结果'],
      capabilityIntent: '项目测试与结果确认',
      remainingPlan: [{
        objectiveTerms: ['issue', '417', '结论'],
        capabilityIntent: 'GitHub issue 更新',
      }],
      planEffect: 'created',
      rubberStamp: false,
      reason: 'The current verification remains one task while the issue update waits for its result.',
    },
    metadata: { difficulty: 'hard', reason: 'Current result boundary plus dependent follow-up.', source: SOURCE_FILE },
  },
];

export const capabilityPlanningBasicsDataset: AgentEvalDataset<CapabilityPlanningInput, CapabilityPlanningExpected> = {
  name: SUITE,
  description: 'Production contracts for capabilityPlanner at entry and task boundaries.',
  cases,
  metadata: { owner: 'pet-agent', areas: ['capability_planning', 'entry_decision', 'delegation_control'] },
};
