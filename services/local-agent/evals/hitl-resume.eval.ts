// @ts-nocheck — eval script, types from langsmith barrel are incomplete
/**
 * LangSmith evaluation: local-agent HITL resume flow (#20 cleanup).
 *
 * This eval covers the *local-agent* HITL seam — the layer that translates a
 * structured human_review.requested event into a typed resume. The old
 * pet-agent orchestrator HITL eval was removed because orchestrator iteration
 * limits are now handled as guard state patches, not LangGraph interrupts.
 * This local-agent eval still covers the #20 cleanup items:
 *
 *   1. ReviewSpec option effect → runtime authorization state (no text-channel
 *      magic strings, no client-submitted authorization extras).
 *   2. Server-side `handleHumanReviewResponse` validates stale review ids and
 *      session routing from server-held pending review metadata.
 *   3. runChatSession surfaces the pendingInterrupt with canonical ReviewSpec
 *      options and structured resume semantics.
 *
 * SUT seams:
 *   - services/local-agent/src/chatSessionAdapter.ts (runChatSession)
 *   - services/local-agent/src/localServerChatHandler.ts (review route guard)
 *   - packages/pet-agent/src/agent/orchestrator/review/reviewAuthorizations.ts
 *
 * Model is not invoked: examples use a hand-built fake graph that yields the
 * exact v3 protocol events runChatSession reads — the interrupt shape
 * is the canonical HumanReviewInterruptPayload emitted by pet-agent.
 *
 * Run:
 *   npm run eval:hitl -w pinpawo
 */
import { evaluate } from 'langsmith/evaluation';
import { Client } from 'langsmith';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import {
  applyReviewEffects,
  buildReviewSpec,
  exactAuthorization,
  isToolActionAuthorized,
  type ToolAuthorizationRecord,
} from '@pinpawo/pet-agent';
import { runChatSession } from '../src/chatSessionAdapter';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';

const DATASET_NAME = 'local-agent-hitl-resume';

type ExampleInputs = {
  /** Initial user message. */
  user_message: string;
  /** Shell command the agent wants to run (review subject). */
  pending_shell_command: string;
  /** Canonical review response the client sends back. */
  resume?: { reviewId: string; selectedOptionId: string; input?: Record<string, unknown> };
  /** Final reply the fake graph returns after resume (none if rejected). */
  final_reply?: string;
};

type ExampleOutputs = {
  expected_interrupt_received: boolean;
  expected_authorization_option_present: boolean;
  expected_resume_authorized_matcher_type?: 'exact' | null;
  expected_final_status: 'completed' | 'waiting_human' | 'interrupted';
  expected_final_reply?: string;
  expected_authorization_recorded?: boolean;
  reason: string;
};

const examples: Array<{
  name: string;
  inputs: ExampleInputs;
  outputs: ExampleOutputs;
}> = [
  {
    name: 'shell-review-authorize-via-effect-option',
    inputs: {
      user_message: '帮我跑 git status',
      pending_shell_command: 'git status',
      resume: { reviewId: 'review-shell-action', selectedOptionId: 'approve-and-authorize-thread' },
      final_reply: '已执行 git status。',
    },
    outputs: {
      expected_interrupt_received: true,
      expected_authorization_option_present: true,
      expected_resume_authorized_matcher_type: 'exact',
      expected_final_status: 'completed',
      expected_final_reply: '已执行 git status。',
      expected_authorization_recorded: true,
      reason: 'Structured approve + declared ReviewSpec effect should both authorize and approve, no slash-command or client extras needed.',
    },
  },
  {
    name: 'shell-review-pure-approve',
    inputs: {
      user_message: '帮我跑 git status',
      pending_shell_command: 'git status',
      resume: { reviewId: 'review-shell-action', selectedOptionId: 'approve' },
      final_reply: '已执行 git status。',
    },
    outputs: {
      expected_interrupt_received: true,
      expected_authorization_option_present: true,
      expected_resume_authorized_matcher_type: null,
      expected_final_status: 'completed',
      expected_final_reply: '已执行 git status。',
      expected_authorization_recorded: false,
      reason: 'Approve without extras should not register a session-wide shell authorization.',
    },
  },
  {
    name: 'shell-review-reject',
    inputs: {
      user_message: '帮我跑 rm -rf /',
      pending_shell_command: 'rm -rf /',
      resume: { reviewId: 'review-shell-action', selectedOptionId: 'reject' },
      final_reply: '已拒绝执行。',
    },
    outputs: {
      expected_interrupt_received: true,
      expected_authorization_option_present: true,
      expected_resume_authorized_matcher_type: null,
      expected_final_status: 'completed',
      expected_final_reply: '已拒绝执行。',
      expected_authorization_recorded: false,
      reason: 'Reject response must reach the graph as canonical { reviewId, selectedOptionId } and not authorize anything.',
    },
  },
  {
    name: 'no-resume-stops-at-waiting-human',
    inputs: {
      user_message: '帮我跑 git status',
      pending_shell_command: 'git status',
    },
    outputs: {
      expected_interrupt_received: true,
      expected_authorization_option_present: true,
      expected_final_status: 'waiting_human',
      expected_authorization_recorded: false,
      reason: 'First turn with no resume should leave the session in waiting_human; second turn never runs.',
    },
  },
];

const FAKE_THREAD_ID = 'eval-thread';
const FAKE_REQUEST_ID = 'eval-req';
const FAKE_REVIEW_ID = 'review-shell-action';
function buildShellReviewInterrupt(command: string) {
  return {
    kind: 'review',
    review: buildReviewSpec({
      id: FAKE_REVIEW_ID,
      view: {
        kind: 'plain',
        title: 'Shell command approval',
        body: `执行 shell 命令: ${command}?`,
      },
      options: [
        {
          id: 'approve',
          label: 'Approve',
          variant: 'primary',
          decision: { type: 'approve' },
        },
        {
          id: 'approve-and-authorize-thread',
          label: 'Approve and authorize',
          decision: { type: 'approve' },
          effects: [{
            type: 'graph.authorize_tool_action',
            scope: 'thread',
          }],
        },
        {
          id: 'reject',
          label: 'Reject',
          variant: 'danger',
          decision: { type: 'reject' },
        },
        {
          id: 'respond',
          label: 'Respond',
          input: {
            kind: 'text',
            key: 'message',
            required: true,
            multiline: true,
          },
          decision: { type: 'respond', messageInputKey: 'message' },
        },
      ],
    }),
    pendingAction: {
      actionId: 'pending_action',
      toolName: 'run_shell',
      args: { command },
      description: `执行 shell 命令：${command}`,
    },
  };
}

/**
 * Hand-built fake of LocalAgentGraphService that drives runChatSession through
 * an interrupt-then-resume sequence without invoking a real LLM. Mirrors the
 * raw protocol events produced by graph.streamEvents({ version: 'v3' }).
 */
function createFakeGraphService(params: {
  pendingShellCommand: string;
  finalReply: string;
}) {
  // Real flow: first turn starts with no interrupt; stream emits __interrupt__
  // mid-run; subsequent readThreadState() sees a pending interrupt that the resume
  // turn consumes. Track that with two flags.
  let interruptEmitted = false;
  let interruptResumed = false;

  function threadStateWithInterrupt() {
    const payload = buildShellReviewInterrupt(params.pendingShellCommand);
    return {
      messages: [],
      pendingHumanReview: { review: payload.review },
      hasPendingContinuation: true,
    };
  }
  function threadStateClean() {
    return {
      messages: interruptResumed ? [new AIMessage(params.finalReply)] : [],
      pendingHumanReview: null,
      hasPendingContinuation: false,
    };
  }

  return {
    async readThreadState(_setup: unknown) {
      if (interruptEmitted && !interruptResumed) return threadStateWithInterrupt();
      return threadStateClean();
    },
    async readThreadMessages(_setup: unknown) {
      const state = interruptEmitted && !interruptResumed
        ? threadStateWithInterrupt()
        : threadStateClean();
      return state.messages;
    },
    buildResumeCommand(resume: unknown) {
      return new Command({ resume });
    },
    async *streamEvents(_setup: unknown, inputOverride?: unknown) {
      if (!inputOverride) {
        // First (non-resume) turn: agent raises an interrupt.
        const payload = buildShellReviewInterrupt(params.pendingShellCommand);
        interruptEmitted = true;
        yield {
          type: 'event' as const,
          seq: 0,
          method: 'values',
          params: { namespace: [], data: { __interrupt__: [{ value: payload }] } },
        };
        return;
      }
      // Resume turn: emit a streamed model lifecycle then a final values snapshot.
      interruptResumed = true;
      const aiMessage = new AIMessage(params.finalReply);
      yield {
        type: 'event' as const,
        seq: 0,
        method: 'messages',
        params: { namespace: [], data: { event: 'message-start', id: 'final-1' } },
      };
      yield {
        type: 'event' as const,
        seq: 1,
        method: 'messages',
        params: {
          namespace: [],
          data: {
            event: 'content-block-delta',
            delta: { type: 'text-delta', text: params.finalReply },
          },
        },
      };
      yield {
        type: 'event' as const,
        seq: 2,
        method: 'values',
        params: { namespace: [], data: { messages: [aiMessage] } },
      };
    },
    invokeState() { throw new Error('not used'); },
    run() { throw new Error('not used'); },
    invokeStructuredResult() { throw new Error('not used'); },
  };
}

function buildFakeSetup() {
  return {
    graphConfig: { contextWindowTokens: 4096 },
    input: {
      messages: [new HumanMessage('start')],
      actor: { userId: 'eval-user' },
      threadId: FAKE_THREAD_ID,
    },
    interfaceContext: { kind: 'tui' as const },
  } as unknown as Parameters<typeof runChatSession>[0]['setup'];
}

async function target(inputs: ExampleInputs): Promise<Record<string, unknown>> {
  const fakeGraph = createFakeGraphService({
    pendingShellCommand: inputs.pending_shell_command,
    finalReply: inputs.final_reply ?? '',
  });

  // Turn 1 (clean thread): runChatSession sees no pending interrupt via
  // readThreadState(), then stream emits __interrupt__ → status: waiting_human.
  // Turn 2 (resume): readThreadState() now reports the interrupt; the resume
  // Command flows back into stream which emits the final AI message.

  const firstTurnEvents: AgentRuntimeEvent[] = [];
  const firstTurn = await runChatSession({
    request: { kind: 'user_message', requestId: FAKE_REQUEST_ID, message: inputs.user_message },
    setup: buildFakeSetup(),
    graphService: fakeGraph as never,
    isCurrent: () => true,
    finishInterrupted: () => {},
    emitEvent: (event) => firstTurnEvents.push(event),
    emitToolEvent: () => {},
  });

  if (firstTurn.status !== 'waiting_human' || !inputs.resume) {
    const reviewEvent = firstTurnEvents.find(
      (event) => event.type === 'human_review.requested',
    ) as Extract<AgentRuntimeEvent, { type: 'human_review.requested' }> | undefined;
    return {
      first_turn_status: firstTurn.status,
      authorization_option_present: Boolean(
        reviewEvent?.review?.options.some((option) =>
          option.effects?.some((effect) => effect.type === 'graph.authorize_tool_action'),
        ),
      ),
      interrupt_received: firstTurn.status === 'waiting_human',
      authorized_matcher_type: null,
      authorization_recorded: false,
      final_reply: '',
      final_status: firstTurn.status,
    };
  }

  const reviewEvent = firstTurnEvents.find(
    (event) => event.type === 'human_review.requested',
  ) as Extract<AgentRuntimeEvent, { type: 'human_review.requested' }> | undefined;
  const selectedOption = reviewEvent?.review?.options.find((option) =>
    option.id === inputs.resume?.selectedOptionId,
  );
  const authorizationOptionPresent = Boolean(
    reviewEvent?.review?.options.some((option) =>
      option.effects?.some((effect) => effect.type === 'graph.authorize_tool_action'),
    ),
  );
  let authorizedMatcherType: 'exact' | null = null;
  let appliedAuthorizations: ToolAuthorizationRecord[] = [];
  if (selectedOption?.effects?.length) {
    const matcher = exactAuthorization({
      command: inputs.pending_shell_command,
    });
    appliedAuthorizations = await applyReviewEffects({
      toolName: 'run_shell',
      matcher,
      effects: selectedOption.effects,
    });
    authorizedMatcherType = appliedAuthorizations[0]?.matcher.type ?? null;
  }

  const secondTurnEvents: AgentRuntimeEvent[] = [];
  const secondTurn = await runChatSession({
    request: {
      kind: 'resume',
      requestId: FAKE_REQUEST_ID,
      resume: inputs.resume,
    },
    setup: buildFakeSetup(),
    graphService: fakeGraph as never,
    isCurrent: () => true,
    finishInterrupted: () => {},
    emitEvent: (event) => secondTurnEvents.push(event),
    emitToolEvent: () => {},
  });

  const finalReplyEvent = secondTurnEvents.find(
    (event) => event.type === 'message.completed',
  ) as Extract<AgentRuntimeEvent, { type: 'message.completed' }> | undefined;

  return {
    first_turn_status: firstTurn.status,
    interrupt_received: firstTurn.status === 'waiting_human',
    authorization_option_present: authorizationOptionPresent,
    authorized_matcher_type: authorizedMatcherType,
    authorization_recorded: isToolActionAuthorized({
      authorizations: appliedAuthorizations,
      toolName: 'run_shell',
      candidateMatcher: exactAuthorization({
        command: inputs.pending_shell_command,
      }),
    }),
    final_reply: finalReplyEvent?.text ?? '',
    final_status: secondTurn.status,
  };
}

function booleanCorrectness(field: string, expectedField: string, key: string) {
  return ({ outputs, referenceOutputs }) => {
    const expected = referenceOutputs?.[expectedField];
    if (typeof expected !== 'boolean') return { key, score: 1 };
    const actual = outputs?.[field];
    return {
      key,
      score: actual === expected ? 1 : 0,
      comment: actual === expected ? `Correct: ${actual}` : `Expected ${expected}, got ${actual}`,
    };
  };
}

function equalsCorrectness(field: string, expectedField: string, key: string) {
  return ({ outputs, referenceOutputs }) => {
    const expected = referenceOutputs?.[expectedField];
    if (expected === undefined) return { key, score: 1 };
    const actual = outputs?.[field];
    return {
      key,
      score: actual === expected ? 1 : 0,
      comment: actual === expected ? `Correct: ${actual}` : `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    };
  };
}

async function recreateDataset(client: Client) {
  try {
    const existing = await client.readDataset({ datasetName: DATASET_NAME });
    if (existing?.id) {
      await client.deleteDataset({ datasetId: existing.id });
    }
  } catch {
    // dataset does not exist
  }

  const dataset = await client.createDataset(DATASET_NAME, {
    description: 'Evaluates local-agent HITL resume flow: ReviewSpec effects, authorization state, and resume status.',
  });
  for (const example of examples) {
    await client.createExample({
      dataset_id: dataset.id,
      inputs: example.inputs,
      outputs: example.outputs,
      metadata: { name: example.name },
    });
  }
}

async function main() {
  const client = new Client();
  await recreateDataset(client);
  console.log(`Running local-agent HITL evaluation against "${DATASET_NAME}"...`);
  const results = await evaluate(target, {
    data: DATASET_NAME,
    experimentPrefix: 'local-agent-hitl',
    evaluators: [
      booleanCorrectness('interrupt_received', 'expected_interrupt_received', 'interrupt_received_correct'),
      booleanCorrectness('authorization_option_present', 'expected_authorization_option_present', 'authorization_option_correct'),
      booleanCorrectness('authorization_recorded', 'expected_authorization_recorded', 'authorization_recorded_correct'),
      equalsCorrectness(
        'authorized_matcher_type',
        'expected_resume_authorized_matcher_type',
        'authorized_matcher_type_correct',
      ),
      equalsCorrectness('final_status', 'expected_final_status', 'final_status_correct'),
      equalsCorrectness('final_reply', 'expected_final_reply', 'final_reply_correct'),
    ],
  });

  const rows = results.results;
  const keys = [
    'interrupt_received_correct',
    'authorization_option_correct',
    'authorization_recorded_correct',
    'authorized_matcher_type_correct',
    'final_status_correct',
    'final_reply_correct',
  ];
  const summarizeScore = (key: string) => {
    const scores = rows.flatMap((row) =>
      row.evaluationResults.results.filter((item) => item.key === key),
    );
    const passed = scores.filter((item) => item.score === 1).length;
    return { passed, total: scores.length, failed: scores.length - passed };
  };

  console.log('\n=== local-agent HITL evaluation complete ===');
  for (const key of keys) {
    const score = summarizeScore(key);
    console.log(`${key}: ${score.passed}/${score.total} passed, ${score.failed} failed.`);
  }
  for (const row of rows) {
    const failedScores = row.evaluationResults.results.filter((item) =>
      keys.includes(item.key) && item.score !== 1,
    );
    if (failedScores.length === 0) continue;
    const name = row.example.metadata?.name ?? row.example.id;
    console.log(`  - ${name}: ${failedScores.map((item) => item.comment).join(' | ')}`);
  }
  console.log('View results in LangSmith dashboard.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
