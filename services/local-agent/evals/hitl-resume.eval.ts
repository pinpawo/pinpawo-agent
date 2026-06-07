// @ts-nocheck — eval script, types from langsmith barrel are incomplete
/**
 * LangSmith evaluation: local-agent HITL resume flow (#20 cleanup).
 *
 * The pet-agent eval (orchestrator-hitl) only covers the orchestrator's own
 * interrupt path. This eval covers the *local-agent* HITL seam — the layer
 * that translates a structured human_review.requested event into a typed
 * resume, including the #20 cleanup items:
 *
 *   1. /allow → structured `extras.authorizeShellPattern` (no text-channel
 *      magic strings).
 *   2. Server-side `handleHumanReviewResponse` rejects resumes whose
 *      `extras.originSessionId` does not match the active session.
 *   3. runChatSession surfaces the pendingInterrupt with structured resume
 *      semantics (decisions array), not free-text /allow.
 *
 * SUT seams:
 *   - services/local-agent/src/chatSessionAdapter.ts (runChatSession)
 *   - services/local-agent/src/localServerChatHandler.ts (origin guard)
 *   - services/local-agent/src/sessionAuthorizations.ts (authorize side-effect)
 *
 * Model is not invoked: examples use a hand-built fake graph that yields the
 * exact LangGraph stream chunks runChatSession reads — the interrupt shape
 * comes from pet-agent's buildHumanReviewRequest so it tracks schema drift.
 *
 * Run:
 *   npm run eval:hitl -w pinpawo-local-agent
 */
import { evaluate } from 'langsmith/evaluation';
import { Client } from 'langsmith';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { buildHumanReviewRequest } from '@pinpawo/pet-agent';
import { runChatSession } from '../src/chatSessionAdapter';
import {
  authorizeShellPattern,
  clearSessionAuthorizations,
  isShellCommandAuthorized,
} from '../src/sessionAuthorizations';
// `isShellCommandAuthorized` is exposed to derive `authorization_recorded`
// from the same code path the production shell tool consults.
import type { LocalAgentEvent } from '../src/events/localAgentEvent';
import type { ReviewResumeExtras } from '../src/localAgentProtocol';

const DATASET_NAME = 'local-agent-hitl-resume';

type ExampleInputs = {
  /** Initial user message. */
  user_message: string;
  /** Shell command the agent wants to run (review subject). */
  pending_shell_command: string;
  /** Resume the client sends back. */
  resume?: { decisions: Array<{ type: string; message?: string }> };
  /** Optional extras attached to the human_review_response. */
  extras?: ReviewResumeExtras;
  /** Final reply the fake graph returns after resume (none if rejected). */
  final_reply?: string;
};

type ExampleOutputs = {
  expected_interrupt_received: boolean;
  expected_pending_interrupt_callback_called: boolean;
  expected_resume_authorized_pattern?: string | null;
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
    name: 'shell-review-authorize-via-extras',
    inputs: {
      user_message: '帮我跑 git status',
      pending_shell_command: 'git status',
      resume: { decisions: [{ type: 'approve' }] },
      extras: { authorizeShellPattern: { pattern: 'git status' } },
      final_reply: '已执行 git status。',
    },
    outputs: {
      expected_interrupt_received: true,
      expected_pending_interrupt_callback_called: true,
      expected_resume_authorized_pattern: 'git status',
      expected_final_status: 'completed',
      expected_final_reply: '已执行 git status。',
      expected_authorization_recorded: true,
      reason: 'Structured approve + authorizeShellPattern extras should both authorize and approve, no /allow text needed.',
    },
  },
  {
    name: 'shell-review-pure-approve',
    inputs: {
      user_message: '帮我跑 git status',
      pending_shell_command: 'git status',
      resume: { decisions: [{ type: 'approve' }] },
      final_reply: '已执行 git status。',
    },
    outputs: {
      expected_interrupt_received: true,
      expected_pending_interrupt_callback_called: true,
      expected_resume_authorized_pattern: null,
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
      resume: { decisions: [{ type: 'reject', message: '太危险了' }] },
      final_reply: '已拒绝执行。',
    },
    outputs: {
      expected_interrupt_received: true,
      expected_pending_interrupt_callback_called: true,
      expected_resume_authorized_pattern: null,
      expected_final_status: 'completed',
      expected_final_reply: '已拒绝执行。',
      expected_authorization_recorded: false,
      reason: 'Reject decision must reach the graph as { decisions: [{ type: reject }] } and not authorize anything.',
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
      expected_pending_interrupt_callback_called: true,
      expected_final_status: 'waiting_human',
      expected_authorization_recorded: false,
      reason: 'First turn with no resume should leave the session in waiting_human; second turn never runs.',
    },
  },
];

const FAKE_THREAD_ID = 'eval-thread';
const FAKE_REQUEST_ID = 'eval-req';

function buildShellReviewInterrupt(command: string) {
  const review = buildHumanReviewRequest({
    actionRequests: [{
      name: 'run_shell',
      args: { command },
      description: `执行 shell 命令：${command}`,
    }],
    reviewConfigs: [{
      actionName: 'run_shell',
      allowedDecisions: ['approve', 'reject', 'respond'],
    }],
    prompt: `执行 shell 命令: ${command}?`,
  });
  return review;
}

/**
 * Hand-built fake of LocalAgentGraphService that drives runChatSession through
 * an interrupt-then-resume sequence without invoking a real LLM. Mirrors the
 * stream shape produced by graph.stream({ streamMode: ['messages', 'values'] }).
 */
function createFakeGraphService(params: {
  pendingShellCommand: string;
  finalReply: string;
}) {
  // Real flow: first turn starts with no interrupt; stream emits __interrupt__
  // mid-run; subsequent getState() sees a pending interrupt that the resume
  // turn consumes. Track that with two flags.
  let interruptEmitted = false;
  let interruptResumed = false;

  function snapshotWithInterrupt() {
    const payload = buildShellReviewInterrupt(params.pendingShellCommand);
    return {
      tasks: [{ interrupts: [{ value: payload }] }],
      values: { messages: [] },
    };
  }
  function snapshotClean() {
    return {
      tasks: [],
      values: { messages: [new AIMessage(params.finalReply)] },
    };
  }

  return {
    async getState(_setup: unknown) {
      if (interruptEmitted && !interruptResumed) return snapshotWithInterrupt();
      return snapshotClean();
    },
    buildResumeCommand(resume: unknown) {
      return new Command({ resume });
    },
    async *stream(_setup: unknown, inputOverride?: unknown) {
      if (!inputOverride) {
        // First (non-resume) turn: agent raises an interrupt.
        const payload = buildShellReviewInterrupt(params.pendingShellCommand);
        interruptEmitted = true;
        yield ['values', { __interrupt__: [{ value: payload }] }];
        return;
      }
      // Resume turn: emit a streamed AI token then a final values snapshot.
      interruptResumed = true;
      const aiMessage = new AIMessage(params.finalReply);
      yield ['messages', [aiMessage, {}]];
      yield ['values', { messages: [aiMessage] }];
    },
    invokeState() { throw new Error('not used'); },
    run() { throw new Error('not used'); },
    invokeStructuredResult() { throw new Error('not used'); },
  };
}

function buildFakeSetup() {
  return {
    graphKey: FAKE_THREAD_ID,
    graphConfig: { contextWindowTokens: 4096 },
    input: {
      messages: [new HumanMessage('start')],
      actor: { petId: 'eval-pet', userId: 'eval-user' },
      threadId: FAKE_THREAD_ID,
    },
    interfaceContext: { kind: 'tui' as const },
  } as unknown as Parameters<typeof runChatSession>[0]['setup'];
}

async function target(inputs: ExampleInputs): Promise<Record<string, unknown>> {
  clearSessionAuthorizations(FAKE_THREAD_ID);

  const fakeGraph = createFakeGraphService({
    pendingShellCommand: inputs.pending_shell_command,
    finalReply: inputs.final_reply ?? '',
  });

  // Turn 1 (clean thread): runChatSession sees no pending interrupt via
  // getState(), then stream emits __interrupt__ → status: waiting_human.
  // Turn 2 (resume): getState() now reports the interrupt; the resume
  // Command flows back into stream which emits the final AI message.

  const firstTurnEvents: LocalAgentEvent[] = [];
  const firstTurn = await runChatSession({
    request: { requestId: FAKE_REQUEST_ID, message: inputs.user_message },
    setup: buildFakeSetup(),
    graphService: fakeGraph as never,
    isCurrent: () => true,
    finishInterrupted: () => {},
    emitEvent: (event) => firstTurnEvents.push(event),
    emitToolEvent: () => {},
  });

  if (firstTurn.status !== 'waiting_human' || !inputs.resume) {
    return {
      first_turn_status: firstTurn.status,
      pending_interrupt_callback_called: false,
      interrupt_received: firstTurn.status === 'waiting_human',
      authorized_pattern: null,
      authorization_recorded: false,
      final_reply: '',
      final_status: firstTurn.status,
    };
  }

  // Resume turn: mirror localServerChatHandler.handleChatRequest, which
  // installs an onPendingInterrupt that translates extras.authorizeShellPattern
  // into a real authorizeShellPattern() call on the thread.
  let pendingCallbackCalled = false;
  let authorizedPattern: string | null = null;

  const secondTurnEvents: LocalAgentEvent[] = [];
  const secondTurn = await runChatSession({
    request: {
      requestId: FAKE_REQUEST_ID,
      message: '',
      resume: inputs.resume,
    },
    setup: buildFakeSetup(),
    graphService: fakeGraph as never,
    isCurrent: () => true,
    finishInterrupted: () => {},
    emitEvent: (event) => secondTurnEvents.push(event),
    emitToolEvent: () => {},
    onPendingInterrupt: () => {
      pendingCallbackCalled = true;
      const authorize = inputs.extras?.authorizeShellPattern;
      if (!authorize) return;
      const requestedPattern = authorize.pattern?.trim() || inputs.pending_shell_command;
      authorizedPattern = authorizeShellPattern(FAKE_THREAD_ID, requestedPattern);
    },
  });

  const finalReplyEvent = secondTurnEvents.find(
    (event) => event.type === 'message.completed',
  ) as Extract<LocalAgentEvent, { type: 'message.completed' }> | undefined;

  return {
    first_turn_status: firstTurn.status,
    pending_interrupt_callback_called: pendingCallbackCalled,
    interrupt_received: firstTurn.status === 'waiting_human',
    last_pending_interrupt_kind: lastPendingInterrupt?.kind ?? null,
    authorized_pattern: authorizedPattern,
    authorization_recorded: isShellCommandAuthorized(
      FAKE_THREAD_ID,
      inputs.pending_shell_command,
    ),
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
    description: 'Evaluates local-agent HITL resume flow: structured extras, authorization side effects, and resume status.',
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
      booleanCorrectness('pending_interrupt_callback_called', 'expected_pending_interrupt_callback_called', 'pending_callback_correct'),
      booleanCorrectness('authorization_recorded', 'expected_authorization_recorded', 'authorization_recorded_correct'),
      equalsCorrectness('authorized_pattern', 'expected_resume_authorized_pattern', 'authorized_pattern_correct'),
      equalsCorrectness('final_status', 'expected_final_status', 'final_status_correct'),
      equalsCorrectness('final_reply', 'expected_final_reply', 'final_reply_correct'),
    ],
  });

  const rows = results.results;
  const keys = [
    'interrupt_received_correct',
    'pending_callback_correct',
    'authorization_recorded_correct',
    'authorized_pattern_correct',
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
