import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { stampMessageCreatedAtUtc } from '@pinpawo/pet-agent';
import test from 'node:test';
import { createEmptyTuiSessionState } from './tuiSessionRegistry';
import {
  LocalServerTuiSessionService,
  readTuiHistoryMessages,
  summarizeTuiHistoryMessages,
  type TuiSessionCheckpointer,
} from './localServerTuiSessions';

test('readTuiHistoryMessages keeps visible user/assistant messages only', () => {
  const userMessage = stampMessageCreatedAtUtc(
    new HumanMessage(' hello '),
    '2026-06-01T01:00:00.000Z',
  );
  const assistantMessage = stampMessageCreatedAtUtc(
    new AIMessage('assistant reply'),
    '2026-06-01T01:00:01.000Z',
  );
  const messages = readTuiHistoryMessages([
    new SystemMessage('system'),
    userMessage,
    new AIMessage({
      content: 'subagent hidden',
      additional_kwargs: { pinpawo: { lane: 'subagent' } },
    }),
    assistantMessage,
  ]);

  assert.deepEqual(messages, [
    { role: 'user', text: 'hello', createdAt: '2026-06-01T01:00:00.000Z' },
    { role: 'assistant', text: 'assistant reply', createdAt: '2026-06-01T01:00:01.000Z' },
  ]);
});

test('summarizeTuiHistoryMessages derives title from first user message', () => {
  const summary = summarizeTuiHistoryMessages([
    { role: 'assistant', text: '先回答' },
    { role: 'user', text: '  标题   带   空格  ' },
  ], '2026-06-02T00:00:00.000Z');

  assert.deepEqual(summary, {
    title: '标题 带 空格',
    messageCount: 2,
    updatedAt: '2026-06-02T00:00:00.000Z',
  });
  assert.equal(summarizeTuiHistoryMessages([], '2026-06-02T00:00:00.000Z').title, '空会话');
});

test('LocalServerTuiSessionService creates and resets active sessions', async () => {
  const state = createEmptyTuiSessionState();
  const saved: number[] = [];
  const deletedThreads: string[] = [];
  const checkpointer = {
    deleteThread: async (threadId: string) => {
      deletedThreads.push(threadId);
    },
  } as TuiSessionCheckpointer;
  const service = new LocalServerTuiSessionService({
    state,
    saveState: () => {
      saved.push(1);
    },
    checkpointer,
  });

  const first = service.getActiveSession('pet-a');
  const second = service.createNewSession('pet-a');
  const third = await service.resetSession('pet-a', {
    deletePrevious: true,
  });

  assert.equal(service.getChatThreadId('pet-a'), third.threadId);
  assert.equal(state.sessions[first.id] !== undefined, true);
  assert.equal(state.sessions[second.id], undefined);
  assert.deepEqual(deletedThreads, [second.threadId]);
  assert.equal(saved.length >= 4, true);
});

test('LocalServerTuiSessionService injects active session createdAt into runtime environment', () => {
  const state = createEmptyTuiSessionState();
  const service = new LocalServerTuiSessionService({
    state,
    saveState: () => {},
  });
  const session = service.getActiveSession('pet-a');
  const setup = service.buildChatSetup({
    actorId: 'pet-a',
    llmConfig: {
      apiKey: 'test',
      baseUrl: 'http://localhost',
      model: 'test-model',
    },
    workdir: '/tmp/pinpawo-tui-workdir',
  } as never, {
    pet: {
      id: 'pet-a',
      name: 'Paw',
      personality: null,
      species: null,
      stage: null,
      growth_value: null,
      stage_asset_id: null,
    },
    context: {
      petMemoryText: '',
      recentChatTurns: [],
      recentDaily: [],
      trendItems: [],
      today: '2026-06-11',
    },
  });

  assert.match(setup.input.runtimeEnvironment ?? '', new RegExp(`会话开始时间：${session.createdAt}`));
  assert.match(setup.input.runtimeEnvironment ?? '', /时区：/);
  assert.match(setup.input.runtimeEnvironment ?? '', /工作目录：\/tmp\/pinpawo-tui-workdir/);
  assert.doesNotMatch(setup.input.runtimeEnvironment ?? '', /进程 cwd/);
});

test('LocalServerTuiSessionService reads active pending review from checkpoint interrupt', async () => {
  const state = createEmptyTuiSessionState();
  const review = {
    id: 'review-current',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  let capturedThreadId: string | undefined;
  const checkpointer = {
    deleteThread: async () => {},
  } as unknown as TuiSessionCheckpointer;
  const service = new LocalServerTuiSessionService({
    state,
    saveState: () => {},
    checkpointer,
    graphService: {
      readThreadState: async (setup: { input: { threadId?: string } }) => {
        capturedThreadId = setup.input.threadId;
        return {
          messages: [],
          pendingHumanReview: { review },
          hasPendingContinuation: true,
        };
      },
    } as never,
    loadContext: async () => ({
      pet: {
        id: 'pet-a',
        name: 'Paw',
        personality: null,
        species: null,
        stage: null,
        growth_value: null,
        stage_asset_id: null,
      },
      context: {
        petMemoryText: '',
        recentChatTurns: [],
        recentDaily: [],
        trendItems: [],
        today: '2026-06-11',
      },
    }),
  });

  const session = service.getActiveSession('pet-a');
  const pendingReview = await service.readActivePendingReview({
    actorId: 'pet-a',
    llmConfig: {
      apiKey: 'test',
      baseUrl: 'http://localhost',
      model: 'test-model',
    },
  } as never);

  assert.deepEqual(pendingReview, {
    sessionId: session.id,
    review,
  });
  assert.equal(capturedThreadId, session.threadId);
});
