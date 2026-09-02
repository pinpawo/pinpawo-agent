import { AgentEvalCase, AgentEvalDataset } from './types.ts';

type OrchestratorFlowMockSubagentInput = {
  user_message: string;
  capability_pack?: 'browser' | 'content_writer_only' | 'explore' | 'pet_content';
  allowed_capability_names?: string[];
  subagent_response?: string;
  subagent_responses?: string[];
  subagent_script?: 'tool_calls_until_carryover';
  subagent_final_response?: string;
  max_iterations?: number;
  auto_resume_iteration_limit?: boolean;
};

type OrchestratorFlowMockSubagentExpected = {
  expected_route: 'answer' | 'delegate';
  expected_mode: 'answer' | 'capability';
  expected_phase: 'initial_request' | 'after_subagent';
  expected_latest_announce_kind?: 'progress' | 'completed' | null;
  expected_latest_announce_lane?: string | null;
  expected_delegation_count?: number;
  expected_carryover_seen?: boolean;
  expected_iteration_limit_interrupt_count?: number;
  reason: string;
};

const SUITE = 'orchestrator-flow-mock-subagent';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/orchestrator-flow-mock-subagent.ts';

const cases: AgentEvalCase<
  OrchestratorFlowMockSubagentInput,
  OrchestratorFlowMockSubagentExpected
>[] = [
  {
    id: `${SUITE}.file-read-flow-finishes-after-general`,
    name: 'file-read-flow-finishes-after-general',
    suite: SUITE,
    tags: ['delegation_control', 'context_synthesis', 'route_control'],
    input: {
      user_message: '帮我看一下 src/index.ts 的内容',
      subagent_response: '已读取 src/index.ts，文件导出了 createApp 和 startServer 两个入口函数。',
    },
    expected: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_delegation_count: 1,
      reason: 'Route should delegate file reading once, consume the completed announce, then answer.',
    },
    metadata: {
      difficulty: 'easy',
      reason: 'Baseline route -> general subagent -> answer flow.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.browser-flow-finishes-after-browser-capability`,
    name: 'browser-flow-finishes-after-browser-capability',
    suite: SUITE,
    tags: ['capability_discovery', 'delegation_control', 'context_synthesis', 'route_control'],
    input: {
      user_message: '打开示例站点资料页查看最新更新',
      capability_pack: 'browser',
      subagent_response: '已打开示例站点资料页并提取到热门内容：技术资讯、产品更新、开发指南、案例分享。',
    },
    expected: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_latest_announce_lane: 'capability:browser',
      expected_delegation_count: 1,
      reason: 'A completed browser capability announce should be enough to answer, not re-delegate.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Capability-lane completion should finish through normal answer synthesis.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.multi-action-flow-finishes-when-subagent-completes-all`,
    name: 'multi-action-flow-finishes-when-subagent-completes-all',
    suite: SUITE,
    tags: ['delegation_control', 'context_synthesis', 'route_control'],
    input: {
      user_message: '帮我把当前项目里的所有 var 声明改成 const，并运行 lint 检查',
      subagent_response: '已将所有 var 声明改成 const，并运行 lint 检查；lint 通过，退出码 0。',
    },
    expected: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_delegation_count: 1,
      reason: 'When the subagent completed all requested actions, route should answer instead of inventing follow-up work.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Multi-action completion should not trigger repeat delegation.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.limit-reached-continuation-carries-private-messages`,
    name: 'limit-reached-continuation-carries-private-messages',
    suite: SUITE,
    tags: ['interruption_recovery', 'delegation_control', 'context_synthesis'],
    input: {
      user_message: '帮我把 data/items.csv 里的所有分片都处理完，全部处理完成后告诉我结果',
      subagent_script: 'tool_calls_until_carryover',
      subagent_final_response: '已处理完 data/items.csv 的全部分片，共 120 条记录，没有失败项。',
    },
    expected: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_delegation_count: 1,
      expected_carryover_seen: true,
      reason: 'A limit-reached continuation must reuse the delegation id, carry the prior private messages, then answer after natural completion.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Covers the interrupted subagent private messages carryover path.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.capability-limit-orchestrator-resume-stays-on-explore-lane`,
    name: 'capability-limit-orchestrator-resume-stays-on-explore-lane',
    suite: SUITE,
    tags: ['interruption_recovery', 'capability_discovery', 'delegation_control', 'context_synthesis'],
    input: {
      user_message: '帮我调查 pinpawo-agent 仓库里 local-agent 的 capability 注册链路，列出关键文件和证据。',
      capability_pack: 'explore',
      allowed_capability_names: ['explore'],
      subagent_script: 'tool_calls_until_carryover',
      subagent_final_response: '已完成 local-agent capability 注册链路调查：入口在 localAgentCapabilityRegistry，channel 装配后传入 pet-agent orchestrator。',
      max_iterations: 1,
      auto_resume_iteration_limit: true,
    },
    expected: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_latest_announce_lane: 'capability:explore',
      expected_delegation_count: 1,
      expected_carryover_seen: true,
      expected_iteration_limit_interrupt_count: 2,
      reason: 'Capability progress caused by subagent limit plus orchestrator iteration-limit resume should continue the same lane, then answer.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Covers capability-lane interruption recovery through final answer.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.capability-flow-finishes-after-capability`,
    name: 'capability-flow-finishes-after-capability',
    suite: SUITE,
    tags: ['capability_discovery', 'delegation_control', 'context_synthesis', 'route_control'],
    input: {
      user_message: '用内容写作能力生成这个版本的发布说明草稿',
      capability_pack: 'pet_content',
      allowed_capability_names: ['content_writer'],
      subagent_response: '已生成版本发布说明草稿，包含摘要、主要变更和升级提示。',
    },
    expected: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_delegation_count: 1,
      reason: 'The Supervisor should delegate to content_writer once, then answer from its completed announce.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Positive capability flow should finish cleanly after the capability returns a result.',
      source: SOURCE_FILE,
    },
  },
];

export const orchestratorFlowMockSubagentDataset: AgentEvalDataset<
  OrchestratorFlowMockSubagentInput,
  OrchestratorFlowMockSubagentExpected
> = {
  name: SUITE,
  description: 'End-to-end orchestrator flow cases with a mocked subagent and real route decisions.',
  cases,
  metadata: {
    owner: 'pet-agent',
    areas: [
      'route_control',
      'capability_discovery',
      'delegation_control',
      'interruption_recovery',
      'context_synthesis',
    ],
  },
};
