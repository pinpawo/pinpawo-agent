import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type ToolReviewRejectRuntimeInput = {
  userMessage: string;
  delegatedTask: string;
  reviewedTool: 'run_shell';
  firstToolCall: {
    id: string;
    args: { command: string };
  };
  subagentFinalResponse: string;
  rejectOptionId: string;
};

export type ToolReviewRejectRuntimeExpected = {
  expectedInterrupted: boolean;
  expectedFinalInterrupt: boolean;
  expectedToolRunCount: number;
  expectedRejectedToolResultSeenBySubagent: boolean;
  expectedHandoffPresent: boolean;
  expectedAuthorizationCount: number;
  expectedFinalAnnounceIncludes: string[];
  reason: string;
};

const SUITE = 'agent-tool-review-reject-runtime';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/tool-review-reject-runtime.ts';

const cases: AgentEvalCase<ToolReviewRejectRuntimeInput, ToolReviewRejectRuntimeExpected>[] = [
  {
    id: `${SUITE}.human-reject-stops-subagent-tool-loop`,
    name: 'human-reject-stops-subagent-tool-loop',
    suite: SUITE,
    tags: ['permission_control', 'interruption_recovery', 'delegation_control', 'context_synthesis'],
    input: {
      userMessage: '运行 git status 看一下当前状态',
      delegatedTask: '运行 git status 看一下当前状态',
      reviewedTool: 'run_shell',
      firstToolCall: {
        id: 'call-rejected',
        args: { command: 'git status' },
      },
      subagentFinalResponse: '已按用户决定跳过被拒绝的工具，并完成无需该工具的结果。',
      rejectOptionId: 'reject',
    },
    expected: {
      expectedInterrupted: true,
      expectedFinalInterrupt: false,
      expectedToolRunCount: 0,
      expectedRejectedToolResultSeenBySubagent: true,
      expectedHandoffPresent: true,
      expectedAuthorizationCount: 0,
      expectedFinalAnnounceIncludes: ['按用户决定', '完成无需该工具的结果'],
      reason: 'Rejecting a reviewed tool call must resume the same subagent with a cancellation ToolMessage, then hand off only the subagent’s real final result.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Regression coverage for the authorization reject path that previously jumped back to the model and allowed another tool call.',
      source: SOURCE_FILE,
    },
  },
];

export const toolReviewRejectRuntimeDataset: AgentEvalDataset<
  ToolReviewRejectRuntimeInput,
  ToolReviewRejectRuntimeExpected
> = {
  name: SUITE,
  description: 'Runtime eval for reviewed tool-call rejection: reject must resume the same subagent invocation before normal handoff.',
  cases,
  metadata: {
    owner: 'pet-agent',
    areas: ['permission_control', 'interruption_recovery', 'delegation_control', 'context_synthesis'],
  },
};
