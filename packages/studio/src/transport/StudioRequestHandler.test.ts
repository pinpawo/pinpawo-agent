import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StudioRequestHandler } from './StudioRequestHandler';
import type {
  Studio,
  StudioDispatchGateHandler,
  StudioEventHandler,
} from '../studioContract';

type Peer = { send: (message: unknown) => boolean };

function createPeer(sent: unknown[]): Peer {
  return { send: (message) => { sent.push(message); return true; } };
}

type TestStudio = Studio & {
  lastCorrelationId: () => string | undefined;
};

function fakeStudio(overrides: Partial<Studio> = {}): TestStudio {
  const handlers = new Set<StudioEventHandler>();
  const gateHandlers = new Set<StudioDispatchGateHandler>();
  let correlationId: string | undefined;
  return {
    entryPetId: 'pet-a',
    dispatch: async (input) => {
      correlationId = input.correlationId;
      return { threadId: 'thread-1' };
    },
    onDispatchGate: (handler) => {
      gateHandlers.add(handler);
      return () => gateHandlers.delete(handler);
    },
    notify: (event) => { for (const handler of handlers) void handler(event); },
    subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
    listPets: () => [],
    shutdown: async () => {},
    ...overrides,
    lastCorrelationId: () => correlationId,
  };
}

function handlerWith(studio: Studio) {
  const sent: unknown[] = [];
  const events: unknown[] = [];
  const handler = new StudioRequestHandler<Peer>({
    studio,
    workdir: '/tmp/pinpawo-studio-test',
    outbound: {
      sendMessage: (peer, message) => peer.send(message),
      sendEvent: (_peer, event) => { events.push(event); return true; },
    },
  });
  return { handler, sent, events };
}

test('a studio request returns as soon as it is submitted', async () => {
  // 提交即返回:推模型下没有人在等 pet。若它退化成等结果,这里会挂住。
  let released!: () => void;
  const gate = new Promise<void>((resolve) => { released = resolve; });
  const studio = fakeStudio({
    dispatch: async () => {
      void gate; // 模拟 pet 长时间执行:dispatch 本身不应等它
      return { threadId: 'thread-slow' };
    },
  });

  const { handler, sent } = handlerWith(studio);
  const peer = createPeer(sent);

  await handler.handleStudioRequest(peer, {
    type: 'studio_request',
    requestId: 'studio-1',
    userRequest: 'plan this',
  });

  const response = sent.at(-1) as { type: string; outcome: string; reply: string };
  assert.equal(response.type, 'studio_response');
  assert.equal(response.outcome, 'done');
  // reply 为空是刻意的:提交时还没有结果,产出经 event 流出。
  assert.equal(response.reply, '');
  released();
});

test('multiple requests dispatch to the same resident studio', async () => {
  // #643 常驻 Host 模型:Studio 在 Host init 时构建一次,
  // 多个 request 只 dispatch,不再 build。
  let dispatchCount = 0;
  const studio = fakeStudio({
    dispatch: async () => { dispatchCount += 1; return { threadId: `thread-${dispatchCount}` }; },
  });
  const { handler, sent } = handlerWith(studio);
  const peer = createPeer(sent);

  for (const requestId of ['studio-1', 'studio-2', 'studio-3']) {
    await handler.handleStudioRequest(peer, {
      type: 'studio_request',
      requestId,
      userRequest: 'go',
    });
  }

  assert.equal(dispatchCount, 3);
  // All three responses should be studio_response
  const responses = sent.filter((m) => (m as { type: string }).type === 'studio_response');
  assert.equal(responses.length, 3);
});

test('plugin events reach the peer as studio progress', async () => {
  const studio = fakeStudio();
  const { handler, sent, events } = handlerWith(studio);
  const peer = createPeer(sent);

  await handler.handleStudioRequest(peer, {
    type: 'studio_request',
    requestId: 'studio-1',
    userRequest: 'go',
  });

  studio.notify({
    type: 'task.done',
    source: 'kanban',
    correlationId: studio.lastCorrelationId(),
    occurredAt: new Date().toISOString(),
  });

  const progress = events.at(-1) as { type: string; event: { type: string } };
  assert.equal(progress.type, 'studio.progress');
  assert.equal(progress.event.type, 'task.done');
});

test('events are attributed by correlation instead of the peer latest request', async () => {
  const studio = fakeStudio();
  const { handler, sent, events } = handlerWith(studio);
  const peer = createPeer(sent);

  await handler.handleStudioRequest(peer, {
    type: 'studio_request', requestId: 'studio-1', userRequest: 'first',
  });
  const firstCorrelationId = studio.lastCorrelationId();
  await handler.handleStudioRequest(peer, {
    type: 'studio_request', requestId: 'studio-2', userRequest: 'second',
  });

  studio.notify({
    type: 'task.done',
    source: 'kanban',
    correlationId: firstCorrelationId,
    occurredAt: new Date().toISOString(),
  });

  const progress = events.at(-1) as { requestId: string };
  assert.equal(progress.requestId, 'studio-1');
});

test('uncorrelated events are not broadcast across peers', async () => {
  const studio = fakeStudio();
  const { handler, events } = handlerWith(studio);
  await handler.handleStudioRequest(createPeer([]), {
    type: 'studio_request', requestId: 'peer-a', userRequest: 'a',
  });
  await handler.handleStudioRequest(createPeer([]), {
    type: 'studio_request', requestId: 'peer-b', userRequest: 'b',
  });

  studio.notify({
    type: 'global.tick',
    source: 'scheduler',
    occurredAt: new Date().toISOString(),
  });

  assert.deepEqual(events, []);
});

test('a dispatch error is reported as studio_error', async () => {
  // Studio 由 Host 构建并注入;handler 层面的错误来自 dispatch,
  // 不再有 buildStudio 路径。
  const studio = fakeStudio({
    dispatch: async () => { throw new Error('dispatch boom'); },
  });
  const sent: unknown[] = [];
  const handler = new StudioRequestHandler<Peer>({
    studio,
    workdir: '/tmp/pinpawo-studio-test',
    outbound: {
      sendMessage: (peer, message) => peer.send(message),
      sendEvent: () => true,
    },
  });

  await handler.handleStudioRequest(createPeer(sent), {
    type: 'studio_request',
    requestId: 'studio-1',
    userRequest: 'go',
  });

  const error = sent.at(-1) as { type: string; message: string };
  assert.equal(error.type, 'studio_error');
  assert.match(error.message, /dispatch boom/);
});
