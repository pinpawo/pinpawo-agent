import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type CapabilityPlanningInput = {
  mode: 'entry' | 'boundary';
  /** Exact current user request available to every Planner invocation in the run. */
  userRequest: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  capabilityRegistry: string[];
  activeCapability?: string;
  activeTask?: string;
  latestAnnounce?: string;
  remainingPlan?: Array<{ capability: string; task: string }>;
};

export type CapabilityPlanningExpected = {
  result: 'continue_current'
    | 'execute_plan'
    | 'advance_plan'
    | 'goal_done'
    | 'user_input_required'
    | 'unavailable';
  nextTaskTerms?: string[];
  capabilityName?: string;
  remainingPlan: Array<{ taskTerms: string[]; capability: string }>;
  /**
   * Whether future work must be materialized in this Planner invocation.
   * `optional` accepts a self-contained current handoff task that leaves the
   * Boundary Planner to materialize the next task from its result.
   */
  remainingPlanPolicy?: 'required' | 'optional';
  exactRemainingPlanLength?: number;
  planEffect: 'created' | 'revised' | 'unchanged' | 'empty';
  rubberStamp: boolean;
  reason: string;
};

const SUITE = 'agent-capability-planning-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/capability-planning-basics.ts';

type CapabilityPlanningTranscriptInput = Omit<CapabilityPlanningInput, 'userRequest'> & {
  /**
   * Current user request that production stores for every Planner invocation.
   * The transcript messages are projected into Planner as complete canonical
   * conversation context; contextual cases may provide a more precise
   * normalized request explicitly.
   */
  userRequest?: CapabilityPlanningInput['userRequest'];
};

function buildEvalUserRequest(messages: CapabilityPlanningTranscriptInput['messages']) {
  const latestUserRequest = [...messages]
    .reverse()
    .find((message) => message.role === 'user');
  const objective = latestUserRequest?.content.trim()
    || messages.at(-1)?.content.trim()
    || 'Complete the current user request.';
  return objective;
}

/**
 * Production stores the exact user request in run state, so entry and
 * boundary cases receive the same request representation.
 */
function withUserRequest(
  testCase: AgentEvalCase<CapabilityPlanningTranscriptInput, CapabilityPlanningExpected>,
): AgentEvalCase<CapabilityPlanningInput, CapabilityPlanningExpected> {
  return {
    ...testCase,
    input: {
      ...testCase.input,
      userRequest: testCase.input.userRequest ?? buildEvalUserRequest(testCase.input.messages),
    },
  };
}

const transcriptCases: AgentEvalCase<CapabilityPlanningTranscriptInput, CapabilityPlanningExpected>[] = [
  {
    id: `${SUITE}.entry-explore-then-implementation`,
    name: 'entry-explore-then-implementation',
    suite: SUITE,
    tags: ['capability_planning', 'entry_answer'],
    input: {
      mode: 'entry',
      messages: [{
        role: 'user',
        content: '在当前仓库中完成 auth 模块重构。具体改动必须以模块现有结构和风险为依据。',
      }],
      capabilityRegistry: [
        'explore: inspect code structure and risks',
        'general: use workspace tools to edit and verify code',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['auth', '结构', '风险'],
      capabilityName: 'explore',
      remainingPlan: [
        { taskTerms: ['auth', '重构'], capability: 'general' },
      ],
      remainingPlanPolicy: 'optional',
      planEffect: 'created',
      rubberStamp: false,
      reason: 'Entry planning creates an auth investigation boundary and either preserves refactoring as future work or gives Boundary enough direction to materialize it from the investigation result.',
    },
    metadata: { difficulty: 'hard', reason: 'planner@entry dynamic plan.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-focuses-on-latest-goal-despite-unrelated-history`,
    name: 'entry-focuses-on-latest-goal-despite-unrelated-history',
    suite: SUITE,
    tags: ['capability_planning', 'entry_answer', 'context_synthesis'],
    input: {
      mode: 'entry',
      messages: [{
        role: 'user',
        content: '上周的浏览器扩展报错先不用处理。我只是想知道扩展和 native host 的连接状态分别由谁维护。',
      }, {
        role: 'assistant',
        content: '扩展维护浏览器侧状态，native host 只负责扩展与本机进程的消息通道；这个问题尚未形成待执行任务。',
      }, {
        role: 'user',
        content: '明白了。上面的说明到这里即可，不要检查扩展、不创建 issue，也不要修改浏览器相关代码。',
      }, {
        role: 'assistant',
        content: '已停止该话题，当前没有浏览器相关工作在执行。',
      }, {
        role: 'user',
        content: '现在请在当前仓库中完成 auth 模块重构。先调查模块现有结构、依赖和风险，再根据调查结论实施改动并验证。',
      }],
      capabilityRegistry: [
        'browser: inspect browser extension, tabs, and native host integration',
        'explore: inspect code structure, dependencies, and risks',
        'general: use workspace tools to edit and verify code',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['auth', '结构', '依赖', '风险'],
      capabilityName: 'explore',
      remainingPlan: [
        { taskTerms: ['auth', '重构'], capability: 'general' },
      ],
      remainingPlanPolicy: 'optional',
      planEffect: 'created',
      rubberStamp: false,
      reason: 'Older unrelated browser discussion is closed; entry planning follows the latest auth goal and either preserves implementation after investigation or defers materializing it to Boundary.',
    },
    metadata: { difficulty: 'hard', reason: 'Long conversational history with an irrelevant Capability-shaped distractor.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-keeps-investigation-scope`,
    name: 'entry-keeps-investigation-scope',
    suite: SUITE,
    tags: ['capability_planning', 'entry_answer'],
    input: {
      mode: 'entry',
      messages: [{
        role: 'user',
        content: '调查支付模块失败测试的根因、涉及代码和触发条件，确认调查完整后再结束。',
      }],
      capabilityRegistry: [
        'workspace_analysis: inspect tests, source code, and failure conditions',
        'code_change: modify code and verify tests',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['支付', '失败测试', '根因', '代码', '触发条件', '完整'],
      capabilityName: 'workspace_analysis',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'created',
      rubberStamp: false,
      reason: 'One investigation result stays within the requested scope and does not create an unrequested implementation task.',
    },
    metadata: { difficulty: 'hard', reason: 'Goal scope and same-capability task grouping.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-forms-one-current-state-task`,
    name: 'entry-forms-one-current-state-task',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'entry',
      messages: [{
        role: 'user',
        content: '确认当前仓库是否还有未提交改动，并把实际状态告诉我。',
      }],
      capabilityRegistry: [
        'general: inspect the current workspace and report repository state',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['仓库', '未提交', '状态'],
      capabilityName: 'general',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'created',
      rubberStamp: false,
      reason: 'A simple request is materialized as one complete task without an artificial future tail.',
    },
    metadata: { difficulty: 'medium', reason: 'Planner-owned one-task boundary.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-verifies-latest-main-instead-of-requesting-user-input`,
    name: 'entry-verifies-latest-main-instead-of-requesting-user-input',
    suite: SUITE,
    tags: ['capability_planning', 'entry_answer', 'context_synthesis'],
    input: {
      mode: 'entry',
      userRequest: '确认刚才对 studio 结构和 local-agent 层 studio 概念侵入的评估是基于最新 main 分支的版本。',
      messages: [{
        role: 'user',
        content: '看下最新的 studio 结构，然后评估目前还有哪些 studio 概念侵入到了 local-agent 这一层。',
      }, {
        role: 'assistant',
        content: '已根据当前工作区源码完成 studio 结构和 local-agent 概念侵入评估，但尚未核对当前 HEAD 是否与远程最新 main 一致。',
      }, {
        role: 'user',
        content: '你看的是最新的 main 的版本么？',
      }],
      capabilityRegistry: [
        'general: inspect the current workspace and Git state, compare the checked-out revision with the latest main branch, and report verified evidence',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['main', '版本', '核对'],
      capabilityName: 'general',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'created',
      rubberStamp: false,
      reason: 'The latest-main status is an executable repository fact that General can verify. Model uncertainty or an unchecked fact is not missing user input, so the Planner must delegate verification instead of asking the user for a commit or timestamp.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Trace-derived regression from trace 01a02b00-9cb1-7044-827d-38f43795b2f8, where Planner incorrectly returned user_input_required for a Git-verifiable fact.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.entry-splits-independent-deliverables`,
    name: 'entry-splits-independent-deliverables',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'entry',
      messages: [{
        role: 'user',
        content: '审查 PR #450 的代码风险，并独立确认部署文档中的公开配置与实际页面一致。',
      }],
      capabilityRegistry: [
        'explore: inspect pull requests and code risks',
        'browser: inspect deployed pages and compare public configuration',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['PR', '450', '风险'],
      capabilityName: 'explore',
      remainingPlan: [{
        taskTerms: ['部署', '配置', '页面'],
        capability: 'browser',
      }],
      exactRemainingPlanLength: 1,
      planEffect: 'created',
      rubberStamp: false,
      reason: 'Independent deliverables owned by different capabilities remain separate task boundaries.',
    },
    metadata: { difficulty: 'hard', reason: 'Planner-owned multi-task boundary.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-asks-for-user-owned-deployment-target`,
    name: 'entry-asks-for-user-owned-deployment-target',
    suite: SUITE,
    tags: ['capability_planning', 'entry_answer', 'delegation_control'],
    input: {
      mode: 'entry',
      messages: [{
        role: 'user',
        content: '把服务部署到生产或预发布环境；目标由我决定，但我还没有选。',
      }],
      capabilityRegistry: [
        'general: deploy and verify the service after the target environment is selected',
      ],
    },
    expected: {
      result: 'user_input_required',
      remainingPlan: [],
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'The target environment is an explicit user-owned choice, so no autonomous deployment can begin until the user selects it.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Keeps legitimate Entry user-input routing while distinguishing it from Capability-verifiable facts.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.boundary-materializes-from-explore-handoff`,
    name: 'boundary-materializes-from-explore-handoff',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'boundary',
      messages: [{
        role: 'user',
        content: '在当前仓库中完成 auth 模块重构。具体改动必须以模块现有结构和风险为依据。',
      }, {
        role: 'assistant',
        content: '开始执行计划任务：调查 auth 模块的现有结构和风险',
      }, {
        role: 'assistant',
        content: 'auth/index.ts 存在循环依赖；应提取 token validation 并保持现有公开接口。',
      }],
      capabilityRegistry: [
        'explore: inspect code structure and risks',
        'general: use workspace tools to edit and verify code',
      ],
      activeCapability: 'explore',
      activeTask: '调查 auth 模块的现有结构和风险',
      latestAnnounce: 'auth/index.ts 存在循环依赖；应提取 token validation 并保持现有公开接口。',
      remainingPlan: [{ capability: 'general', task: '根据调查结论重构 auth 模块' }],
    },
    expected: {
      result: 'advance_plan',
      nextTaskTerms: ['auth', '重构'],
      capabilityName: 'general',
      remainingPlan: [],
      planEffect: 'unchanged',
      rubberStamp: true,
      reason: 'The accepted handoff already supplies implementation details to the next executor, so the valid planned task remains unchanged.',
    },
    metadata: { difficulty: 'hard', reason: 'planner@boundary materialization.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-ignores-closed-unrelated-history`,
    name: 'boundary-ignores-closed-unrelated-history',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'context_synthesis'],
    input: {
      mode: 'boundary',
      messages: [{
        role: 'user',
        content: '请先不要处理 release 文档。我只是在记录：下个版本可能需要补一份发布说明。',
      }, {
        role: 'assistant',
        content: '已记录为未来想法，没有开始 release 相关任务。',
      }, {
        role: 'user',
        content: '现在在当前仓库中完成 auth 模块重构。具体改动必须以模块现有结构和风险为依据。',
      }, {
        role: 'assistant',
        content: '开始执行计划任务：调查 auth 模块的现有结构、依赖和风险。',
      }, {
        role: 'assistant',
        content: 'auth/index.ts 存在循环依赖；token validation 需要提取，同时必须保持现有公开接口。',
      }],
      capabilityRegistry: [
        'explore: inspect code structure, dependencies, and risks',
        'general: use workspace tools to edit and verify code',
        'release_check: inspect release documentation and verify release readiness',
      ],
      activeCapability: 'explore',
      activeTask: '调查 auth 模块的现有结构、依赖和风险。',
      latestAnnounce: 'auth/index.ts 存在循环依赖；token validation 需要提取，同时必须保持现有公开接口。',
      remainingPlan: [{ capability: 'general', task: '根据调查结论重构 auth 模块并验证。' }],
    },
    expected: {
      result: 'advance_plan',
      nextTaskTerms: ['auth', '重构', '验证'],
      capabilityName: 'general',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'unchanged',
      rubberStamp: true,
      reason: 'The existing auth task remains valid and receives the accepted handoff directly; unrelated closed history does not justify rewriting it.',
    },
    metadata: { difficulty: 'hard', reason: 'Boundary handoff must win over unrelated earlier conversation.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-uses-general-for-unmatched-work`,
    name: 'entry-uses-general-for-unmatched-work',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'entry',
      userRequest: '读取当前仓库根目录 package.json 中的 name 和 version，并报告这两个值。',
      messages: [{
        role: 'user',
        content: '读取当前仓库根目录 package.json 中的 name 和 version，并报告这两个值。',
      }],
      capabilityRegistry: [
        'general: execute ordinary workspace tasks when no specialized Capability matches',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['package.json', 'name', 'version'],
      capabilityName: 'general',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'created',
      rubberStamp: false,
      reason: 'When no specialized Capability matches, the Planner materializes a concrete workspace task with general.',
    },
    metadata: { difficulty: 'medium', reason: 'Mandatory General default candidate.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-keeps-valid-next-task`,
    name: 'boundary-keeps-valid-next-task',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'boundary',
      messages: [{
        role: 'user',
        content: '生成报告并发送给项目负责人。',
      }, {
        role: 'assistant',
        content: '开始执行计划任务：生成项目报告',
      }, {
        role: 'assistant',
        content: '报告已生成，路径为 /tmp/report.pdf，内容检查通过。',
      }],
      capabilityRegistry: [
        'document_writer: create report documents',
        'messaging: deliver messages and attachments',
        'general: perform other available work',
      ],
      activeCapability: 'document_writer',
      activeTask: '生成项目报告',
      latestAnnounce: '报告已生成，路径为 /tmp/report.pdf，内容检查通过。',
      remainingPlan: [{ capability: 'messaging', task: '把完成的报告发送给项目负责人' }],
    },
    expected: {
      result: 'advance_plan',
      nextTaskTerms: ['报告', '发送', '负责人'],
      capabilityName: 'messaging',
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
      messages: [{
        role: 'user',
        content: '根据调查修复 auth 风险，然后独立运行 release verification。',
      }, {
        role: 'assistant',
        content: '开始执行计划任务：调查 auth 风险',
      }, {
        role: 'assistant',
        content: '调查确认 token validation 存在循环依赖，需要保持公开接口。',
      }],
      capabilityRegistry: [
        'general: modify source code',
        'release_check: run release verification',
      ],
      activeCapability: 'general',
      activeTask: '调查 auth 风险',
      latestAnnounce: '调查确认 token validation 存在循环依赖，需要保持公开接口。',
      remainingPlan: [
        { capability: 'general', task: '根据调查结论修复 auth 风险' },
        { capability: 'release_check', task: '独立运行 release verification' },
      ],
    },
    expected: {
      result: 'advance_plan',
      nextTaskTerms: ['auth', '风险', '修复'],
      capabilityName: 'general',
      remainingPlan: [{
        taskTerms: ['release', 'verification'],
        capability: 'release_check',
      }],
      planEffect: 'unchanged',
      rubberStamp: true,
      reason: 'The accepted handoff is execution context, so both the valid plan head and its unaffected tail remain unchanged.',
    },
    metadata: { difficulty: 'hard', reason: 'Preserves a valid multi-task plan after handoff.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-removes-completed-work-before-materializing-next-task`,
    name: 'boundary-removes-completed-work-before-materializing-next-task',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'boundary',
      messages: [{
        role: 'user',
        content: '读取 issue #345 的架构演进内容，再检查当前仓库实现是否已经覆盖。',
      }, {
        role: 'assistant',
        content: '开始执行计划任务：读取 issue #345 并整理架构演进内容',
      }, {
        role: 'assistant',
        content: 'issue 正文和评论中的架构演进提案已经完整整理；下一步只需对照当前仓库实现。',
      }],
      capabilityRegistry: [
        'explore: inspect issues, repositories, and implementation history',
        'general: perform ordinary workspace tasks',
      ],
      activeCapability: 'explore',
      activeTask: '读取 issue #345 并整理架构演进内容',
      latestAnnounce: 'issue 正文和评论中的架构演进提案已经完整整理；下一步只需对照当前仓库实现。',
      remainingPlan: [
        {
          capability: 'explore',
          task: '读取 issue #345 并整理架构演进内容',
        },
        {
          capability: 'explore',
          task: '检查当前仓库实现是否覆盖 issue 中的架构演进提案',
        },
      ],
    },
    expected: {
      result: 'advance_plan',
      nextTaskTerms: ['当前仓库', '实现', 'issue', '架构演进'],
      capabilityName: 'explore',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'revised',
      rubberStamp: false,
      reason: 'Boundary planning removes already completed work before materializing the next still-useful task.',
    },
    metadata: { difficulty: 'hard', reason: 'Completed work must not re-enter the execution loop.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-preserves-result-dependent-followup`,
    name: 'entry-preserves-result-dependent-followup',
    suite: SUITE,
    tags: ['capability_planning', 'entry_answer'],
    input: {
      mode: 'entry',
      messages: [{
        role: 'user',
        content: '确认当前仓库测试是否通过，并把最终结论更新到 issue #417。',
      }],
      capabilityRegistry: [
        'general: inspect the workspace and run project tests',
        'github: read and update repository issues',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['仓库', '测试', '结果'],
      capabilityName: 'general',
      remainingPlan: [{
        taskTerms: ['issue', '417', '结论'],
        capability: 'github',
      }],
      planEffect: 'created',
      rubberStamp: false,
      reason: 'The current verification remains one task while the issue update waits for its result.',
    },
    metadata: { difficulty: 'hard', reason: 'Current result boundary plus dependent follow-up.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-does-not-reuse-pseudo-tool-syntax-from-history`,
    name: 'entry-does-not-reuse-pseudo-tool-syntax-from-history',
    suite: SUITE,
    tags: ['capability_planning', 'context_synthesis', 'structured_output'],
    input: {
      mode: 'entry',
      userRequest: '重新只读检查本周工作清单中此前尚未确认创建的事项是否已经实际创建，并报告当前状态。\n\n此前仅确认一项事项已创建，其余待创建事项需要再次核验。历史中的 Bash 片段只是对话内容，不能作为本次检查的结果。',
      messages: [{
        role: 'user',
        content: '检查本周工作清单中标注为“待创建”的事项是否已经实际创建；这次只检查，不要创建或更新任何事项。',
      }, {
        role: 'assistant',
        content: '当前仅有一项已确认创建，其余待创建项需要再次核实。',
      }, {
        role: 'assistant',
        content: [
          '此前曾提出用命令检查当前状态，但以下只是对话内容：',
          '<tool_call>Bash tool_code_call() {',
          "  'command': 'gh issue list --state all'",
          '}',
        ].join('\n'),
      }, {
        role: 'user',
        content: '再次检查，你说的这些未创建的。',
      }],
      capabilityRegistry: [
        'general: inspect the current state of project issues and report evidence without changing them',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['检查', '待创建', '事项', '当前状态'],
      capabilityName: 'general',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'created',
      rubberStamp: false,
      reason: 'A stale pseudo-tool snippet is conversation content, not an available tool; the planner must submit the read-only verification task through its declared tool protocol.',
    },
    metadata: { difficulty: 'hard', reason: 'Trace-derived regression: historic pseudo-tool syntax must not become a planner tool call.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-submits-pr-review-fix-plan-once`,
    name: 'entry-submits-pr-review-fix-plan-once',
    suite: SUITE,
    tags: ['capability_planning', 'structured_output', 'delegation_control'],
    input: {
      mode: 'entry',
      messages: [{
        role: 'user',
        content: [
          '在仓库 /workspace/qban-ai-agents 的 feature/doubao-realtime-v3-json-head 分支修复 PR #433 的 review：',
          'P1-1：response.output_audio.done 不再发送空 AUDIO_DELTA；改为明确的 audio-done 控制事件，正确收尾音频会话。',
          'P1-2：DOUBAO_REALTIME_V3_TTS_SAMPLE_RATE 默认值从 16000 改为 24000；输入仍为 16kHz，并移除相关硬编码。',
          'P1-3：移除 V3 Function Calling 已完整闭环的声明；保留方法但标注 TODO/未实现。',
          'P2：create_asr_task_config() 只接受 DOUBAO_REALTIME_PROTOCOL 的 v2/v3，其他值抛出清晰的 ValueError。',
          '完成后提交并推送该分支。',
        ].join('\n'),
      }],
      capabilityRegistry: [
        'general: modify repository code, run verification, commit, and push the requested branch',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['P1-1', 'P1-2', 'P1-3', 'P2'],
      capabilityName: 'general',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'created',
      rubberStamp: false,
      reason: 'Regression distilled from run-019fd602-745c-778f-a68a-4fd73fc8c0bc: one general Capability owns the complete review-fix task, and the Planner must submit that plan once then finish instead of re-planning after submit_plan succeeds.',
    },
    metadata: { difficulty: 'hard', reason: 'Trace-derived regression for submit_plan completion after a schema-repaired multi-task plan.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.entry-returns-to-answer-before-execution`,
    name: 'entry-recommends-before-requesting-confirmation',
    suite: SUITE,
    tags: ['capability_planning', 'structured_output', 'context_synthesis'],
    input: {
      mode: 'entry',
      messages: [{
        role: 'assistant',
        content: '之前尝试通过浏览器发送钉钉消息失败；目前只确认钉钉由本地 CLI 控制。',
      }, {
        role: 'user',
        content: '看看钉钉 CLI 的使用方式应该直接记录到 wiki，还是创建一个 Capability 来记录。先给我建议并确认方向，不要开始创建。',
      }],
      capabilityRegistry: [
        'capability_creator: create and validate a user-defined Capability',
        'wiki: read and maintain project knowledge in the wiki',
        'general: inspect the current workspace context and recommend whether operational knowledge belongs in the wiki or a reusable Capability without creating either',
      ],
    },
    expected: {
      result: 'execute_plan',
      nextTaskTerms: ['钉钉', 'wiki', 'Capability', '建议'],
      capabilityName: 'general',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'created',
      rubberStamp: false,
      reason: 'The user asks for an evidence-based recommendation before confirming implementation. Recommendation work is still autonomous and executable, so the Planner delegates that analysis now and waits for confirmation only after its result.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Do not request confirmation before the requested recommendation exists.',
      source: SOURCE_FILE,
      legacyName: 'entry-returns-to-answer-before-execution',
    },
  },
  {
    id: `${SUITE}.boundary-returns-to-answer-when-no-capability-can-proceed`,
    name: 'boundary-returns-to-answer-when-no-capability-can-proceed',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'structured_output'],
    input: {
      mode: 'boundary',
      messages: [{
        role: 'user',
        content: '检查发布条件，满足后发布 npm 包。',
      }, {
        role: 'assistant',
        content: '版本、测试和工作区状态均满足发布条件；下一步需要发布 npm 包。',
      }],
      capabilityRegistry: [
        'explore: inspect repository and release readiness without publishing packages',
      ],
      activeCapability: 'explore',
      activeTask: '检查 npm 包的发布条件',
      latestAnnounce: '版本、测试和工作区状态均满足发布条件；下一步需要发布 npm 包。',
      remainingPlan: [],
    },
    expected: {
      result: 'unavailable',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'Follow-up work remains, but the Planner finds no executable Capability and returns a typed unavailable outcome for finalization.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Covers the valid boundary return path without letting Planner reinterpret an exhausted plan as goal completion.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.boundary-adds-followup-required-by-latest-result`,
    name: 'boundary-adds-followup-required-by-latest-result',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control'],
    input: {
      mode: 'boundary',
      messages: [{
        role: 'user',
        content: '检查 issue #587 状态，并把 README 里对应的章节同步成最新状态。',
      }, {
        role: 'assistant',
        content: '开始执行计划任务：读取 issue #587 的当前状态',
      }, {
        role: 'assistant',
        content: 'issue #587 当前为 open；README 的“已知问题”章节仍写着它已关闭，与实际状态不符。',
      }],
      capabilityRegistry: [
        'explore: investigate repositories and report evidence',
        'document_writer: create and update project documents',
        'general: perform other available work',
      ],
      activeCapability: 'explore',
      activeTask: '读取 issue #587 的当前状态',
      latestAnnounce: 'issue #587 当前为 open；README 的“已知问题”章节仍写着它已关闭，与实际状态不符。',
      remainingPlan: [],
    },
    expected: {
      result: 'advance_plan',
      nextTaskTerms: ['README', '#587'],
      capabilityName: 'document_writer',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'created',
      rubberStamp: false,
      reason: 'Outcome has already established that autonomous work remains; the latest result names that work, so the Planner materializes it even when the previous future tail is empty.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'A task_done boundary may have no pre-existing future tail when the completed result reveals the concrete next task.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.boundary-continues-incomplete-current-task`,
    name: 'boundary-continues-incomplete-current-task',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'planner_boundary'],
    input: {
      mode: 'boundary',
      messages: [{ role: 'user', content: '检查仓库并完成测试验证。' }],
      capabilityRegistry: [
        'general: inspect, modify, and verify the workspace',
      ],
      activeCapability: 'general',
      activeTask: '检查仓库并完成测试验证',
      latestAnnounce: '已完成仓库检查，但测试尚未运行。',
      remainingPlan: [],
    },
    expected: {
      result: 'continue_current',
      remainingPlan: [],
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'The current task is incomplete and the same Capability can finish it.',
    },
    metadata: { difficulty: 'medium', reason: 'Unified acceptance and continuation action.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-resume-without-execution-evidence-continues-current`,
    name: 'boundary-resume-without-execution-evidence-continues-current',
    suite: SUITE,
    tags: [
      'capability_planning',
      'delegation_control',
      'planner_boundary',
      'interruption_recovery',
    ],
    input: {
      mode: 'boundary',
      messages: [{
        role: 'user',
        content: '继续检查仓库并完成测试验证。',
      }],
      capabilityRegistry: [
        'general: inspect, modify, and verify the workspace',
      ],
      activeCapability: 'general',
      activeTask: '检查仓库并完成测试验证',
      remainingPlan: [],
    },
    expected: {
      result: 'continue_current',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'An explicit resume has no canonical execution evidence to accept, while the active Capability can still execute the task. Continue the same delegation instead of assuming completion.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Resume regression for an active delegation whose checkpoint contains no canonical announce evidence.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.boundary-corrects-context-summary-output`,
    name: 'boundary-corrects-context-summary-output',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'planner_boundary', 'context_synthesis'],
    input: {
      mode: 'boundary',
      userRequest: '用与菜单文本语义对应的白色线性 SVG 图标替换 70 个旧四宫格占位图，刷新预览页并验证生成结果。',
      messages: [{
        role: 'user',
        content: '根据菜单文本生成对应的 SVG 图标，替换现有占位图。',
      }],
      capabilityRegistry: [
        'general: inspect, modify, execute, and verify workspace files',
      ],
      activeCapability: 'general',
      activeTask: '重写 quality-safety-icons/generate.js，生成 70 个语义 SVG 图标并验证输出。',
      latestAnnounce: `<essential_context role="task_boundary" source="prior_summary" trust="read_only">
  <![CDATA[
1. 主要目标：用与菜单文本语义对应的白色线性 SVG 图标替换 ~/Downloads/quality-safety-icons/svg/ 下 70 个旧四宫格占位图，保留 6 类配色渐变圆角方底（48×48 viewBox、44×44 圆角底）和文件名序号，刷新 index.html 预览页。
2. 关键事实：磁盘从未真正改动——generate.js 是旧版 155 行占位脚本（mtime 11:37），svg/ 70 文件仍是四宫格占位图，index.html 旧版。之前多次声称重构实际未执行工具调用。
3. 已定设计：白色 stroke 图标（stroke-width≈2，圆角线帽），角标规则——查询类右上放大镜、关联类右上链环、配置类右上齿轮、统计类柱状图基底。
4. 70 项语义映射表已在会话中完整列出（监督工程综合查询→放大镜+文档；在建工程→塔吊/建筑；监督记录→清单/循环/报告；工程统计→柱状图+变体；工程类别→标签；重点工程→星标；创优等级→奖杯；安全生产目标→盾牌+靶心；登记类型→表单；投资类型→钱币；道路等级→道路；结构类型→框架；基础形式→地基；桩基类别→柱桩；管道材料类型→管道；人员岗位→人像团队；工程进度→甘特条；监督类别→眼睛；配置类→齿轮；意见种类→对话泡；级别→层级；整改书→循环+文档；区域→地图；科室→部门；起重机械→吊机；危险源→警告三角；企业注册地→楼宇+定位针 等）。
5. 执行步骤：write_file 重写 generate.js → run_shell 执行 node generate.js → run_shell ls -l 与 XML 校验 → grep 抽查确认含 stroke 路径而非四宫格 rect。
  ]]>
</essential_context>`,
      remainingPlan: [],
    },
    expected: {
      result: 'continue_current',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'The latest announce is an internal-context-shaped summary that explicitly says no workspace work occurred. Continue the same delegation because its full transcript already preserves the task and evidence.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Regression from a production trace where repeated context-summary-shaped announces obscured whether execution had actually progressed.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.boundary-corrects-planning-only-output`,
    name: 'boundary-corrects-planning-only-output',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'planner_boundary'],
    input: {
      mode: 'boundary',
      userRequest: '用与菜单文本语义对应的白色线性 SVG 图标替换 70 个旧四宫格占位图，刷新预览页并验证生成结果。',
      messages: [{
        role: 'user',
        content: '根据菜单文本生成对应的 SVG 图标，替换现有占位图。',
      }],
      capabilityRegistry: [
        'general: inspect, modify, execute, and verify workspace files',
      ],
      activeCapability: 'general',
      activeTask: '重写 quality-safety-icons/generate.js，生成 70 个语义 SVG 图标并验证输出。',
      latestAnnounce: '我现在来写完整的生成脚本并执行。首先建立 SVG 字形库和 70 项语义映射，然后运行 node generate.js，最后检查文件数量和 XML。',
      remainingPlan: [],
    },
    expected: {
      result: 'continue_current',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'The latest announce only restates a future plan and contains no completed work. Continue the same delegation using its existing task and transcript.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Catches a natural subagent stop that announces intended work instead of performing it.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.boundary-corrects-placeholder-output`,
    name: 'boundary-corrects-placeholder-output',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'planner_boundary'],
    input: {
      mode: 'boundary',
      userRequest: '根据每个菜单文本的含义绘制不同的白色线性 SVG 图标，不得继续使用四宫格占位符。',
      messages: [{
        role: 'user',
        content: '原图标只是占位，请按菜单语义重新设计并生成 70 个 SVG。',
      }],
      capabilityRegistry: [
        'general: inspect, modify, execute, and verify workspace files',
      ],
      activeCapability: 'general',
      activeTask: '生成 70 个与菜单语义对应的 SVG 图标并刷新预览页。',
      latestAnnounce: '已生成全部 70 个 SVG。每个图标使用彩色圆角方形底，内部统一绘制 2×2 四枚白色圆角小方块，并已刷新 index.html。',
      remainingPlan: [],
    },
    expected: {
      result: 'continue_current',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'The subagent produced the explicitly rejected placeholder design. Continue the same delegation because the original task and full transcript preserve the unmet acceptance criteria.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Tests course correction when files were generated but the delivered design contradicts the user goal.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.boundary-continues-after-script-only-progress`,
    name: 'boundary-continues-after-script-only-progress',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'planner_boundary'],
    input: {
      mode: 'boundary',
      userRequest: '重写图标生成脚本并实际生成、验证全部 70 个语义 SVG 图标。',
      messages: [{
        role: 'user',
        content: '完成脚本修改、图标生成和结果验证。',
      }],
      capabilityRegistry: [
        'general: inspect, modify, execute, and verify workspace files',
      ],
      activeCapability: 'general',
      activeTask: '重写 generate.js，执行生成并验证 70 个 SVG 文件。',
      latestAnnounce: 'generate.js 已经重写并加入语义字形映射，但尚未运行 node generate.js；svg/ 目录仍是旧时间戳，index.html 也尚未刷新。',
      remainingPlan: [],
    },
    expected: {
      result: 'continue_current',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'Useful progress exists, but the same Capability must execute the generator and verify its outputs before the task can be accepted.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Distinguishes a valid partial implementation from a completed end-to-end task.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.boundary-requests-missing-verification`,
    name: 'boundary-requests-missing-verification',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'planner_boundary'],
    input: {
      mode: 'boundary',
      userRequest: '生成 70 个语义 SVG 图标，并确认文件数量、XML 有效性和图标内容均符合要求。',
      messages: [{
        role: 'user',
        content: '生成图标后必须校验数量、XML 和实际 SVG 内容。',
      }],
      capabilityRegistry: [
        'general: inspect, modify, execute, and verify workspace files',
      ],
      activeCapability: 'general',
      activeTask: '生成并完整验证 70 个语义 SVG 文件。',
      latestAnnounce: '生成脚本已经运行，并报告写出了 70 个 SVG 文件；但本轮没有执行 XML 校验，也没有抽查 SVG 是否仍包含四宫格占位 rect。',
      remainingPlan: [],
    },
    expected: {
      result: 'continue_current',
      remainingPlan: [],
      exactRemainingPlanLength: 0,
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'Generation may have succeeded, but the explicit verification contract remains incomplete. Continue the same delegation with the full execution transcript intact.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Ensures the Planner asks for missing acceptance evidence instead of rerunning or accepting prematurely.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.boundary-completes-user-goal`,
    name: 'boundary-completes-user-goal',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'planner_boundary'],
    input: {
      mode: 'boundary',
      messages: [{ role: 'user', content: '运行测试并报告结果。' }],
      capabilityRegistry: ['general: run and verify workspace tests'],
      activeCapability: 'general',
      activeTask: '运行测试并报告结果',
      latestAnnounce: '测试全部通过，结果已经整理完成。',
      remainingPlan: [],
    },
    expected: {
      result: 'goal_done',
      remainingPlan: [],
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'The accepted execution evidence completes the full user goal.',
    },
    metadata: { difficulty: 'easy', reason: 'Unified goal completion action.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.boundary-asks-before-substituting-missing-target`,
    name: 'boundary-asks-before-substituting-missing-target',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'planner_boundary', 'context_synthesis'],
    input: {
      mode: 'boundary',
      userRequest: '帮我 review PR #662。',
      messages: [{ role: 'user', content: '帮我 review PR #662。' }],
      capabilityRegistry: [
        'project_review: review a requested pull request from repository evidence',
        'general: perform other available work',
      ],
      activeCapability: 'project_review',
      activeTask: 'Review PR #662 and report actionable findings.',
      latestAnnounce: 'GitHub 上未找到 PR #662；Issue #662 存在，关联实现是 PR #663，但尚未得到用户确认是否改为 review PR #663。',
      remainingPlan: [],
    },
    expected: {
      result: 'user_input_required',
      remainingPlan: [],
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'The requested PR does not exist and replacing it with a related PR would change the target, so the Planner must ask instead of rewriting and continuing the delegation.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Regression from a trace where continue_current replaced the active task and injected an unsupported gap note.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.boundary-waits-for-user-input`,
    name: 'boundary-waits-for-user-input',
    suite: SUITE,
    tags: ['capability_planning', 'delegation_control', 'planner_boundary'],
    input: {
      mode: 'boundary',
      messages: [{ role: 'user', content: '发布包；如果需要凭据就先停下来。' }],
      capabilityRegistry: ['general: prepare and publish packages when credentials are available'],
      activeCapability: 'general',
      activeTask: '发布 npm 包',
      latestAnnounce: '发布前检查已通过，但 registry token 尚未提供。',
      remainingPlan: [],
    },
    expected: {
      result: 'user_input_required',
      remainingPlan: [],
      planEffect: 'empty',
      rubberStamp: false,
      reason: 'Autonomous progress must stop until the user supplies the required credential.',
    },
    metadata: { difficulty: 'medium', reason: 'Unified user-input boundary.', source: SOURCE_FILE },
  },
];

const cases = transcriptCases.map(withUserRequest);

export const capabilityPlanningBasicsDataset: AgentEvalDataset<CapabilityPlanningInput, CapabilityPlanningExpected> = {
  name: SUITE,
  description: 'Production contracts for capabilityPlanner at entry and task boundaries.',
  cases,
  metadata: { owner: 'pet-agent', areas: ['capability_planning', 'entry_answer', 'delegation_control'] },
};
