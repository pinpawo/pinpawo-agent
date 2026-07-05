import { AgentEvalCase, AgentEvalDataset } from './types.ts';

type InterruptionRecoveryInput = {
  userMessage: string;
  originalUserMessage?: string;
  interruptedLane?: string;
  interruptedTask?: string;
  interruptionReason?: 'limit_reached' | 'approval_required' | 'user_interrupted';
  progressResult?: string;
  newUserIntent?: string;
};

type InterruptionRecoveryExpected = {
  expectedMode: 'answer' | 'general' | 'capability' | 'ask_permission';
  expectedLane?: string | null;
  expectedTask?: string | null;
  expectedResume: boolean;
  reason: string;
};

const SUITE = 'agent-interruption-recovery-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/interruption-recovery-basics.ts';

const cases: AgentEvalCase<InterruptionRecoveryInput, InterruptionRecoveryExpected>[] = [
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
      interruptedLane: 'general',
      interruptedTask: '修复 typecheck，然后运行测试。',
      interruptionReason: 'limit_reached',
      progressResult: '已修复前两个 TypeScript error，还剩 local-agent 的一个导入错误。',
    },
    expected: {
      expectedMode: 'general',
      expectedLane: 'general',
      expectedTask: '修复 typecheck，然后运行测试。',
      expectedResume: true,
      reason: 'A general lane limit should continue the same unfinished engineering task.',
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
      interruptedLane: 'general',
      interruptedTask: '运行 npm test 并修失败项。',
      interruptionReason: 'approval_required',
      progressResult: '等待用户确认是否允许执行 npm test。',
    },
    expected: {
      expectedMode: 'general',
      expectedLane: 'general',
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
    areas: ['interruption_recovery', 'delegation_control', 'capability_search', 'permission_control'],
  },
};
