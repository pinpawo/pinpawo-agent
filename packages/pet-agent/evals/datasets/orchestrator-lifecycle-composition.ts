import type {
  AgentEvalCase,
  AgentEvalDataset,
} from './types.ts';
import type {
  PromptGoalAcceptanceCriterion,
} from '../prompt-goal-evaluator.ts';

export type LifecycleCompositionCapabilityProfile = 'standard' | 'unavailable';

export type LifecycleCompositionTurn = {
  userMessage: string;
  executorResults: string[];
};

export type LifecycleCompositionInput = {
  turns: LifecycleCompositionTurn[];
  capabilityProfile: LifecycleCompositionCapabilityProfile;
};

export type LifecycleCompositionExpected = {
  objective: string;
  acceptanceCriteria: PromptGoalAcceptanceCriterion[];
  executorCallRange: {
    min: number;
    max: number;
  };
  reason: string;
};

const SUITE = 'agent-orchestrator-lifecycle-composition';
const SOURCE_FILE =
  'packages/pet-agent/evals/datasets/orchestrator-lifecycle-composition.ts';

const cases: AgentEvalCase<
  LifecycleCompositionInput,
  LifecycleCompositionExpected
>[] = [
  {
    id: `${SUITE}.direct-answer`,
    name: 'direct-answer',
    suite: SUITE,
    tags: ['route_control', 'entry_decision', 'context_synthesis'],
    input: {
      capabilityProfile: 'standard',
      turns: [{
        userMessage: '只根据当前问题回答：19 加 23 等于多少？',
        executorResults: [],
      }],
    },
    expected: {
      objective: '直接回答用户的问题，不启动与该问题无关的执行。',
      acceptanceCriteria: [
        {
          id: 'answers_question',
          statement: 'The user-visible response correctly states that 19 plus 23 equals 42.',
        },
        {
          id: 'does_not_invent_execution',
          statement: 'The response does not claim that external work, tools, or delegated execution occurred.',
        },
      ],
      executorCallRange: { min: 0, max: 0 },
      reason: 'A goal already answerable from conversation context should close without execution.',
    },
    metadata: {
      difficulty: 'easy',
      reason: 'Direct-answer lifecycle baseline.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.single-task-completion`,
    name: 'single-task-completion',
    suite: SUITE,
    tags: [
      'route_control',
      'entry_decision',
      'capability_discovery',
      'outcome_decision',
      'context_synthesis',
    ],
    input: {
      capabilityProfile: 'standard',
      turns: [{
        userMessage: '检查项目的发布配置并汇总发现。',
        executorResults: [
          '检查完成：发布配置使用 Node.js 24；生产构建执行 npm run build；当前风险是没有锁定部署区域。',
        ],
      }],
    },
    expected: {
      objective: '完成发布配置检查，并把受控执行结果如实交付给用户。',
      acceptanceCriteria: [
        {
          id: 'preserves_findings',
          statement: 'The user-visible lifecycle communicates Node.js 24, npm run build, and the unlocked deployment-region risk.',
        },
        {
          id: 'closes_after_result',
          statement: 'The lifecycle presents the result before truthfully closing the completed goal.',
        },
      ],
      executorCallRange: { min: 1, max: 1 },
      reason: 'A single executable boundary should produce one result and then close.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Single delegation plus terminal answer composition.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.dynamic-multi-task`,
    name: 'dynamic-multi-task',
    suite: SUITE,
    tags: [
      'entry_decision',
      'capability_planning',
      'capability_discovery',
      'outcome_decision',
      'delegation_control',
      'multi_task_flow',
      'context_synthesis',
    ],
    input: {
      capabilityProfile: 'standard',
      turns: [{
        userMessage: '先调查 auth 模块的结构和风险，再根据调查结论完成重构。',
        executorResults: [
          '调查完成：auth/index.ts 存在循环依赖，建议提取 token validation 并保持公开接口。',
          '重构完成：已提取 token validation，移除循环依赖，公开接口保持不变，测试通过。',
        ],
      }],
    },
    expected: {
      objective: '先调查 auth 模块，再依据调查结论完成重构并交付最终结果。',
      acceptanceCriteria: [
        {
          id: 'uses_investigation',
          statement: 'The lifecycle performs investigation before implementation, and the implementation addresses the discovered circular dependency by extracting token validation.',
        },
        {
          id: 'completes_full_goal',
          statement: 'The user-visible result reports that the public interface was preserved and tests passed, so both requested stages are complete.',
        },
        {
          id: 'does_not_repeat_work',
          statement: 'The execution trajectory contains the two required task boundaries without repeating either completed task.',
        },
      ],
      executorCallRange: { min: 2, max: 2 },
      reason: 'The first handoff determines the concrete second task.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Real-model planning, handoff, replanning, and terminal composition.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.continues-incomplete-task`,
    name: 'continues-incomplete-task',
    suite: SUITE,
    tags: [
      'entry_decision',
      'capability_discovery',
      'outcome_decision',
      'delegation_control',
      'context_synthesis',
    ],
    input: {
      capabilityProfile: 'standard',
      turns: [{
        userMessage: '调查支付模块失败测试的根因、涉及代码和触发条件，确认调查完整后再结束。',
        executorResults: [
          '初步定位到金额舍入误差；尚未收集完整失败日志、测试文件、具体代码位置和触发条件。',
          '调查完成：失败断言为 expected 10.01, received 10.00；失败测试位于 payments/rounding.test.ts；根因代码位于 payments/rounding.ts；当金额包含三位小数时触发舍入误差；本次只做调查，未修改代码。',
        ],
      }],
    },
    expected: {
      objective: '在同一个调查任务中从定位根因继续到确认代码位置和触发条件，然后才结束。',
      acceptanceCriteria: [
        {
          id: 'does_not_stop_at_partial_diagnosis',
          statement: 'The lifecycle does not treat the first root-cause finding as completion while the code location and trigger condition are still unknown.',
        },
        {
          id: 'delivers_complete_investigation',
          statement: 'The final user-visible result identifies the failing assertion and test file, the rounding-error root cause in payments/rounding.ts, and the three-decimal-place trigger condition.',
        },
        {
          id: 'continues_same_task',
          statement: 'The execution trajectory continues the same analysis task and does not create or repeat a separate task boundary.',
        },
        {
          id: 'stays_within_investigation_scope',
          statement: 'The lifecycle stays within the requested investigation scope and does not add an implementation task or claim that code was modified.',
        },
      ],
      executorCallRange: { min: 2, max: 2 },
      reason: 'Outcome continuation must preserve one delegation boundary while the same executor closes a remaining investigation gap.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Same-task analysis continuation before terminal completion.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.user-input-required`,
    name: 'user-input-required',
    suite: SUITE,
    tags: [
      'entry_decision',
      'capability_discovery',
      'outcome_decision',
      'context_synthesis',
    ],
    input: {
      capabilityProfile: 'standard',
      turns: [{
        userMessage: '先检查项目中已有的 staging 公开配置，再确认实际部署状态；如果实际状态检查还缺必要信息，告诉我需要什么。',
        executorResults: [
          '已完成公开配置检查；要继续确认实际部署状态，需要用户提供 staging 地址和只读访问凭证。',
        ],
      }],
    },
    expected: {
      objective: '保留已有进展，明确说明目标尚未完成，并向用户索取继续所需的信息。',
      acceptanceCriteria: [
        {
          id: 'reports_progress',
          statement: 'The user-visible response preserves that the public configuration check was completed.',
        },
        {
          id: 'asks_for_required_input',
          statement: 'The response asks for the staging address and read-only access credential needed to continue.',
        },
        {
          id: 'does_not_claim_completion',
          statement: 'The response does not claim that the deployment-status goal is complete.',
        },
      ],
      executorCallRange: { min: 1, max: 1 },
      reason: 'Missing user-owned information is a truthful terminal return, not goal completion.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'User-input-required terminal semantics.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.resume-after-user-input`,
    name: 'resume-after-user-input',
    suite: SUITE,
    tags: [
      'entry_decision',
      'capability_discovery',
      'outcome_decision',
      'interruption_recovery',
      'delegation_control',
      'context_synthesis',
    ],
    input: {
      capabilityProfile: 'standard',
      turns: [
        {
          userMessage: '检查 staging 部署状态；如果还没有 staging 地址或只读凭证，就告诉我需要补充这两项。',
          executorResults: [
            '已完成公开配置检查；要继续确认实际部署状态，需要用户提供 staging 地址和只读访问凭证。',
          ],
        },
        {
          userMessage: 'staging 地址已配置在 STAGING_URL，凭证也已配置为只读，请继续。',
          executorResults: [
            '已使用补充信息完成检查：staging 服务健康，当前版本为 2026.07.26，最近一次部署成功。',
          ],
        },
      ],
    },
    expected: {
      objective: '第一轮如实请求缺失的地址和凭证；收到信息后继续并完成原目标，不重复已经完成的工作。',
      acceptanceCriteria: [
        {
          id: 'first_turn_requests_input',
          statement: 'The first turn requests the missing staging address and read-only credential and does not claim that the actual deployment status was checked.',
        },
        {
          id: 'second_turn_completes_goal',
          statement: 'After the user supplies the information, the lifecycle reports a healthy staging service, version 2026.07.26, and a successful latest deployment.',
        },
        {
          id: 'resume_does_not_repeat',
          statement: 'The second execution uses the newly supplied information and does not repeat work already completed in the first turn.',
        },
        {
          id: 'does_not_contradict_accepted_result',
          statement: 'After the controlled executor reports success, the user-visible lifecycle does not later deny or contradict that accepted result.',
        },
      ],
      executorCallRange: { min: 1, max: 2 },
      reason: 'A later user turn should resume the unfinished goal from main-conversation evidence.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Cross-run user-input recovery with checkpointed conversation context.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.capability-unavailable`,
    name: 'capability-unavailable',
    suite: SUITE,
    tags: [
      'route_control',
      'entry_decision',
      'capability_discovery',
      'context_synthesis',
    ],
    input: {
      capabilityProfile: 'unavailable',
      turns: [{
        userMessage: '读取工作区中的 release.json 并告诉我当前部署区域。',
        executorResults: [],
      }],
    },
    expected: {
      objective: '在没有任何可用执行能力时，如实说明无法读取文件以及仍未完成的目标。',
      acceptanceCriteria: [
        {
          id: 'states_unavailable',
          statement: 'The user-visible response clearly says the file-reading work could not be executed with the currently available capabilities.',
        },
        {
          id: 'does_not_invent_file_content',
          statement: 'The response does not invent a deployment region or claim that release.json was read.',
        },
        {
          id: 'keeps_goal_unfinished',
          statement: 'The response makes clear that determining the deployment region remains unfinished.',
        },
      ],
      executorCallRange: { min: 0, max: 0 },
      reason: 'Unavailable execution must close truthfully without fabricated evidence.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Capability-unavailable terminal path.',
      source: SOURCE_FILE,
    },
  },
];

export const orchestratorLifecycleCompositionDataset: AgentEvalDataset<
  LifecycleCompositionInput,
  LifecycleCompositionExpected
> = {
  name: SUITE,
  description: 'Real-model production-graph lifecycle composition with controlled executor evidence.',
  cases,
  metadata: {
    owner: 'pet-agent',
    areas: [
      'route_control',
      'entry_decision',
      'capability_planning',
      'capability_discovery',
      'outcome_decision',
      'delegation_control',
      'interruption_recovery',
      'context_synthesis',
      'multi_task_flow',
    ],
  },
};
