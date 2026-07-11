import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type CapabilityPlanningInput = {
  mode: 'entry' | 'boundary';
  userGoal: string;
  capabilityRegistry: string[];
  remainingPlan?: Array<{ objective: string; capabilityIntent: string; status: 'concrete' | 'deferred' }>;
  latestHandoff?: string;
};

export type CapabilityPlanningExpected = {
  result: 'next_task' | 'answer';
  nextTaskTerms?: string[];
  capabilityIntent?: string;
  planEffect: 'created' | 'revised' | 'cancelled' | 'unchanged' | 'empty';
  rubberStamp: boolean;
  reason: string;
};

const SUITE = 'agent-capability-planning-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/capability-planning-basics.ts';

const cases: AgentEvalCase<CapabilityPlanningInput, CapabilityPlanningExpected>[] = [
  {
    id: `${SUITE}.entry-explore-then-deferred-implementation`,
    name: 'entry-explore-then-deferred-implementation',
    suite: SUITE,
    tags: ['capability_planning', 'entry_decision'],
    input: {
      mode: 'entry',
      userGoal: '调查 auth 模块后，根据调查结论完成重构。',
      capabilityRegistry: ['codebase_exploration', 'code_modification', 'general'],
    },
    expected: {
      result: 'next_task',
      nextTaskTerms: ['auth', '调查'],
      capabilityIntent: 'codebase_exploration',
      planEffect: 'created',
      rubberStamp: false,
      reason: 'Entry planning creates exploration first and leaves implementation deferred.',
    },
    metadata: { difficulty: 'hard', reason: 'planner@entry dynamic plan.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-materializes-from-explore-handoff`,
    name: 'boundary-materializes-from-explore-handoff',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'boundary',
      userGoal: '调查 auth 模块后，根据调查结论完成重构。',
      capabilityRegistry: ['codebase_exploration', 'code_modification', 'general'],
      remainingPlan: [{ objective: '根据调查结论重构 auth 模块', capabilityIntent: 'code_modification', status: 'deferred' }],
      latestHandoff: 'auth/index.ts 存在循环依赖；应提取 token validation 并保持现有公开接口。',
    },
    expected: {
      result: 'next_task',
      nextTaskTerms: ['循环依赖', 'token', '接口'],
      capabilityIntent: 'code_modification',
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
      capabilityRegistry: ['codebase_exploration', 'code_modification', 'general'],
      remainingPlan: [{ objective: '修复错误配置', capabilityIntent: 'code_modification', status: 'deferred' }],
      latestHandoff: '配置与文档完全一致，验证通过，不需要修改。',
    },
    expected: {
      result: 'answer',
      planEffect: 'cancelled',
      rubberStamp: false,
      reason: 'The handoff makes the deferred repair unnecessary.',
    },
    metadata: { difficulty: 'medium', reason: 'Boundary cancellation.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-keeps-valid-concrete-task`,
    name: 'boundary-keeps-valid-concrete-task',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'boundary',
      userGoal: '生成报告并发送给项目负责人。',
      capabilityRegistry: ['document_generation', 'message_delivery', 'general'],
      remainingPlan: [{ objective: '把完成的报告发送给项目负责人', capabilityIntent: 'message_delivery', status: 'concrete' }],
      latestHandoff: '报告已生成，路径为 /tmp/report.pdf，内容检查通过。',
    },
    expected: {
      result: 'next_task',
      nextTaskTerms: ['报告', '发送', '负责人'],
      capabilityIntent: 'message_delivery',
      planEffect: 'unchanged',
      rubberStamp: true,
      reason: 'The concrete next task remains valid after the handoff.',
    },
    metadata: { difficulty: 'medium', reason: 'Rubber-stamp measurement case.', source: SOURCE_FILE },
  },
];

export const capabilityPlanningBasicsDataset: AgentEvalDataset<CapabilityPlanningInput, CapabilityPlanningExpected> = {
  name: SUITE,
  description: 'Eval-only contracts for planner@entry and planner@boundary before production graph implementation.',
  cases,
  metadata: { owner: 'pet-agent', areas: ['capability_planning', 'entry_decision', 'delegation_control'] },
};
