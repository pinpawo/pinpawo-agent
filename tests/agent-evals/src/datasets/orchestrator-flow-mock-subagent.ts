import { AgentEvalCase, AgentEvalDataset } from './types.ts';
import { ORCHESTRATOR_MAX_ITERATIONS } from '../../../../packages/pet-agent/src/agent/orchestrator/runtime/constants';

type OrchestratorFlowMockSubagentInput = {
  user_message: string;
  capability_pack?: 'browser' | 'content_writer_only' | 'explore' | 'pet_content';
  allowed_capability_names?: string[];
  subagent_response?: string;
  subagent_responses?: string[];
  follow_up_message?: string;
};

type OrchestratorFlowMockSubagentExpected = {
  expected_route: 'answer' | 'delegate';
  expected_mode: 'answer' | 'capability';
  expected_phase: 'initial_request' | 'after_subagent';
  expected_latest_announce_kind?: 'progress' | 'completed' | null;
  expected_latest_announce_lane?: string | null;
  expected_delegation_count?: number;
  expected_carryover_seen?: boolean;
  expected_follow_up_run_count?: number;
  expected_follow_up_previous_iterations?: number;
  expected_follow_up_fresh_run?: boolean;
  expected_follow_up_plan_preserved?: boolean;
  expected_follow_up_prior_delivery_seen?: boolean;
  reason: string;
};

const SUITE = 'orchestrator-flow-mock-subagent';
const SOURCE_FILE = 'tests/agent-evals/src/datasets/orchestrator-flow-mock-subagent.ts';

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
    id: `${SUITE}.partial-result-starts-independent-invocation`,
    name: 'partial-result-starts-independent-invocation',
    suite: SUITE,
    tags: ['interruption_recovery', 'delegation_control', 'context_synthesis'],
    input: {
      user_message: '帮我把 data/items.csv 里的所有分片都处理完，全部处理完成后告诉我结果',
      subagent_responses: [
        '已处理前 60 条，结果已保存。第 61 至 120 条仍需处理。',
        '已处理完 data/items.csv 的全部分片，共 120 条记录，没有失败项。',
      ],
    },
    expected: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_delegation_count: 2,
      expected_carryover_seen: false,
      reason: 'Supervisor reads the first ToolMessage and prepares a new invocation for remaining work, without replaying private child messages.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Covers remaining work through independent Capability invocations.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.capability-budget-stop-explicit-input-continues-plan`,
    name: 'capability-budget-stop-explicit-input-continues-plan',
    suite: SUITE,
    tags: ['interruption_recovery', 'capability_discovery', 'delegation_control', 'context_synthesis'],
    input: {
      user_message: '帮我调查 pinpawo-agent 仓库里 host 的 capability 注册链路，列出关键文件和证据。',
      capability_pack: 'explore',
      allowed_capability_names: ['explore'],
      subagent_responses: [
        ...Array.from({ length: ORCHESTRATOR_MAX_ITERATIONS }, () => '已记录一部分注册链路证据，调查尚未完成，仍需补齐。'),
        '已完成 host capability 注册链路调查，关键文件与调用证据均已核验。',
      ],
      follow_up_message: '继续原计划，复用已有证据并完成调查。',
    },
    expected: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_latest_announce_lane: 'capability:explore',
      expected_delegation_count: ORCHESTRATOR_MAX_ITERATIONS + 1,
      expected_carryover_seen: false,
      expected_follow_up_run_count: 1,
      expected_follow_up_previous_iterations: ORCHESTRATOR_MAX_ITERATIONS,
      expected_follow_up_fresh_run: true,
      expected_follow_up_plan_preserved: true,
      expected_follow_up_prior_delivery_seen: true,
      reason: 'Root budget stops normally; an explicit new chat enters Entry, continues the plan and reuses prior ToolMessage evidence in a fresh invocation.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Covers real budget termination and explicit new-run continuation without a pause interrupt.',
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
