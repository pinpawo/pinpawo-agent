import { AgentEvalCase, AgentEvalDataset } from './types.ts';

type InterruptionRecoveryInput = {
  userMessage: string;
  originalUserMessage?: string;
  interruptedLane?: string;
  interruptedTask?: string;
  interruptionReason?: 'limit_reached' | 'approval_required' | 'user_interrupted';
  progressResult?: string;
  resumeCompletion?: {
    lane: string;
    task: string;
    completionReason: 'natural' | 'limit_reached';
    result: string;
  };
  newUserIntent?: string;
};

type InterruptionRecoveryExpected = {
  expectedMode: 'answer' | 'capability' | 'ask_permission';
  expectedLane?: string | null;
  expectedTask?: string | null;
  expectedResume: boolean;
  expectedCompletionReason?: 'natural' | 'limit_reached';
  expectedShouldDelegateAgain?: boolean;
  expectedAnswerShouldInclude?: string[];
  reason: string;
};

const SUITE = 'agent-interruption-recovery-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/interruption-recovery-basics.ts';

const cases: AgentEvalCase<InterruptionRecoveryInput, InterruptionRecoveryExpected>[] = [
  {
    id: `${SUITE}.general-limit-resume-natural-completion-answers`,
    name: 'general-limit-resume-natural-completion-answers',
    suite: SUITE,
    tags: ['interruption_recovery', 'delegation_control', 'context_synthesis'],
    input: {
      userMessage: '继续，把剩下的也处理完',
      originalUserMessage: '帮我把 data/items.csv 的所有分片处理完，完成后告诉我总数。',
      interruptedLane: 'capability:general',
      interruptedTask: '处理 data/items.csv 的所有分片并汇总结果。',
      interruptionReason: 'limit_reached',
      progressResult: '已处理前 80 条记录，还剩 40 条记录未处理。',
      resumeCompletion: {
        lane: 'capability:general',
        task: '处理 data/items.csv 的所有分片并汇总结果。',
        completionReason: 'natural',
        result: '已处理完 data/items.csv 的全部分片，共 120 条记录，没有失败项。',
      },
    },
    expected: {
      expectedMode: 'answer',
      expectedLane: null,
      expectedTask: null,
      expectedResume: true,
      expectedCompletionReason: 'natural',
      expectedShouldDelegateAgain: false,
      expectedAnswerShouldInclude: ['120', '没有失败项'],
      reason: 'After a limit-reached continuation completes naturally, the orchestrator should answer from the completed result instead of delegating again.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Covers the full interruption -> resume -> natural completion -> answer loop.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.capability-limit-resume-natural-completion-answers`,
    name: 'capability-limit-resume-natural-completion-answers',
    suite: SUITE,
    tags: ['interruption_recovery', 'capability_search', 'delegation_control', 'context_synthesis'],
    input: {
      userMessage: '继续刚才那个调查',
      originalUserMessage: '帮我调查 local-agent 的 capability 注册链路，列出关键文件和证据。',
      interruptedLane: 'capability:explore',
      interruptedTask: '调查 local-agent 的 capability 注册链路，列出关键文件和证据。',
      interruptionReason: 'limit_reached',
      progressResult: '已定位到 capability registry，但 orchestration 装配链路还没有完整读完。',
      resumeCompletion: {
        lane: 'capability:explore',
        task: '调查 local-agent 的 capability 注册链路，列出关键文件和证据。',
        completionReason: 'natural',
        result: '已完成 local-agent capability 注册链路调查：入口在 localAgentCapabilityRegistry，channel 装配后传入 pet-agent orchestrator。',
      },
    },
    expected: {
      expectedMode: 'answer',
      expectedLane: null,
      expectedTask: null,
      expectedResume: true,
      expectedCompletionReason: 'natural',
      expectedShouldDelegateAgain: false,
      expectedAnswerShouldInclude: ['localAgentCapabilityRegistry', 'orchestrator'],
      reason: 'A capability lane that finishes naturally after resume should be handed off and summarized, not resumed again.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Capability-lane interruption recovery needs both lane reuse and final answer synthesis.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.approval-resume-natural-completion-answers`,
    name: 'approval-resume-natural-completion-answers',
    suite: SUITE,
    tags: ['interruption_recovery', 'permission_control', 'delegation_control', 'context_synthesis'],
    input: {
      userMessage: '我同意，继续跑测试',
      originalUserMessage: '帮我运行 npm test 并修失败项。',
      interruptedLane: 'capability:general',
      interruptedTask: '运行 npm test 并修失败项。',
      interruptionReason: 'approval_required',
      progressResult: '等待用户确认是否允许执行 npm test。',
      resumeCompletion: {
        lane: 'capability:general',
        task: '运行 npm test 并修失败项。',
        completionReason: 'natural',
        result: '已运行 npm test，全部 556 个测试通过，退出码 0。',
      },
    },
    expected: {
      expectedMode: 'answer',
      expectedLane: null,
      expectedTask: null,
      expectedResume: true,
      expectedCompletionReason: 'natural',
      expectedShouldDelegateAgain: false,
      expectedAnswerShouldInclude: ['556', '通过'],
      reason: 'After an approval interrupt resumes and the tool work completes naturally, the agent should report completion.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Connects HITL resume with final orchestration finish behavior.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.stale-limit-marker-ignored-after-natural-completion`,
    name: 'stale-limit-marker-ignored-after-natural-completion',
    suite: SUITE,
    tags: ['interruption_recovery', 'context_synthesis', 'route_control'],
    input: {
      userMessage: '总结一下最终结果',
      originalUserMessage: '帮我处理 data/items.csv 的所有分片。',
      interruptedLane: 'capability:general',
      interruptedTask: '处理 data/items.csv 的所有分片。',
      interruptionReason: 'limit_reached',
      progressResult: '上一轮曾经触达过 limit_reached。',
      resumeCompletion: {
        lane: 'capability:general',
        task: '处理 data/items.csv 的所有分片。',
        completionReason: 'natural',
        result: '后续继续执行已经自然完成：全部分片处理完毕，共 120 条记录。',
      },
      newUserIntent: 'summarize_final_result',
    },
    expected: {
      expectedMode: 'answer',
      expectedLane: null,
      expectedTask: null,
      expectedResume: false,
      expectedCompletionReason: 'natural',
      expectedShouldDelegateAgain: false,
      expectedAnswerShouldInclude: ['120', '全部分片'],
      reason: 'A stale limit marker in older context must not override a newer natural completion result.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Regression coverage for stale interruption markers after successful completion.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.resume-capability-after-limit`,
    name: 'resume-capability-after-limit',
    suite: SUITE,
    tags: ['interruption_recovery', 'capability_search', 'delegation_control'],
    input: {
      userMessage: '继续',
      originalUserMessage: '帮我调查 local-agent 的 capability 注册链路，列出关键文件和证据。',
      interruptedLane: 'capability:explore',
      interruptedTask: '调查 local-agent 的 capability 注册链路，列出关键文件和证据。',
      interruptionReason: 'limit_reached',
      progressResult: '已定位到部分 registry 文件，但调用链路还没有完整读完。',
    },
    expected: {
      expectedMode: 'capability',
      expectedLane: 'capability:explore',
      expectedTask: '调查 local-agent 的 capability 注册链路，列出关键文件和证据。',
      expectedResume: true,
      reason: 'A plain continue after a limit-reached capability lane should resume the same lane.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'The agent must recover both task and lane from prior progress.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.resume-general-after-limit`,
    name: 'resume-general-after-limit',
    suite: SUITE,
    tags: ['interruption_recovery', 'delegation_control'],
    input: {
      userMessage: '继续跑完',
      originalUserMessage: '帮我修复 typecheck，然后运行测试。',
      interruptedLane: 'capability:general',
      interruptedTask: '修复 typecheck，然后运行测试。',
      interruptionReason: 'limit_reached',
      progressResult: '已修复前两个 TypeScript error，还剩 local-agent 的一个导入错误。',
    },
    expected: {
      expectedMode: 'capability',
      expectedLane: 'capability:general',
      expectedTask: '修复 typecheck，然后运行测试。',
      expectedResume: true,
      reason: 'A capability:general limit should continue the same unfinished engineering task.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'General-lane recovery should not require capability search.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.changed-user-intent-does-not-resume`,
    name: 'changed-user-intent-does-not-resume',
    suite: SUITE,
    tags: ['interruption_recovery', 'route_control'],
    input: {
      userMessage: '先别继续了，告诉我刚才已经找到哪些文件',
      originalUserMessage: '帮我调查 local-agent 的 capability 注册链路，列出关键文件和证据。',
      interruptedLane: 'capability:explore',
      interruptedTask: '调查 local-agent 的 capability 注册链路，列出关键文件和证据。',
      interruptionReason: 'limit_reached',
      progressResult: '已定位到 capability registry 和 orchestration route 相关文件。',
      newUserIntent: 'summarize_progress',
    },
    expected: {
      expectedMode: 'answer',
      expectedLane: null,
      expectedTask: null,
      expectedResume: false,
      reason: 'The latest user message asks for a progress summary, not task continuation.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Recovery must honor the newest user intent over stale continuation state.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.approval-interrupt-resumes-review`,
    name: 'approval-interrupt-resumes-review',
    suite: SUITE,
    tags: ['interruption_recovery', 'permission_control'],
    input: {
      userMessage: '我同意，继续',
      originalUserMessage: '帮我运行 npm test 并修失败项。',
      interruptedLane: 'capability:general',
      interruptedTask: '运行 npm test 并修失败项。',
      interruptionReason: 'approval_required',
      progressResult: '等待用户确认是否允许执行 npm test。',
    },
    expected: {
      expectedMode: 'capability',
      expectedLane: 'capability:general',
      expectedTask: '运行 npm test 并修失败项。',
      expectedResume: true,
      reason: 'An approval response should resume the paused task with the granted operation.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'HITL approval resume is both interruption and permission behavior.',
      source: SOURCE_FILE,
    },
  },
];

export const interruptionRecoveryBasicsDataset: AgentEvalDataset<
  InterruptionRecoveryInput,
  InterruptionRecoveryExpected
> = {
  name: SUITE,
  description: 'Basic agent cases for resuming or not resuming interrupted work.',
  cases,
  metadata: {
    owner: 'pet-agent',
    areas: [
      'interruption_recovery',
      'delegation_control',
      'capability_search',
      'permission_control',
      'context_synthesis',
      'route_control',
    ],
  },
};
