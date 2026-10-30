import assert from 'node:assert/strict';
import test from 'node:test';
import type { PetDispatchPort } from 'pinpawo/host-runtime';

import { prepareStudio } from './createStudio';
import type { StudioPlugin, StudioPluginContext } from './studioContract';

test('a failed Plugin start rolls back its context provider and a new Studio can register it', async () => {
  let failedContext: StudioPluginContext | undefined;
  let stopped = 0;
  const failing: StudioPlugin = {
    name: 'channel',
    contextNamespaces: ['channel'],
    toolkits: [],
    start(context) {
      failedContext = context;
      context.registerContextProvider('channel', () => [{ id: 'channel:test', content: 'first' }]);
      throw new Error('startup failed');
    },
    stop() { stopped++; },
  };
  const failed = prepareStudio({ studioId: 'failed', definitions: [], assemblePet: async () => { throw new Error('unused'); }, plugins: [failing] });
  await assert.rejects(failed.activatePlugins(), /startup failed/);
  assert.equal(stopped, 1);
  assert.throws(() => failedContext!.registerContextProvider('channel', () => []), /shut down/);
  await assert.rejects(failedContext!.dispatch({ petId: 'worker', request: 'work' }), /shut down/);
  await failed.studio.shutdown();

  const received: Parameters<PetDispatchPort['dispatch']>[0][] = [];
  const dispatch: PetDispatchPort = {
    getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    onQueueChange: () => () => undefined,
    onDispatchLifecycle: () => () => undefined,
    dispatch: async request => { received.push(request); },
  };
  const fresh = prepareStudio({
    studioId: 'fresh',
    definitions: [{ definitionId: 'worker', name: 'Worker' }],
    assemblePet: async () => ({ dispatch, close: async () => undefined }),
    plugins: [{ name: 'channel', contextNamespaces: ['channel'], toolkits: [], start(context) {
      context.registerContextProvider('channel', () => [{ id: 'channel:test', content: 'second' }]);
    } }],
  });
  try {
    await fresh.restorePets();
    await fresh.studio.pets.create({ petId: 'worker', definitionId: 'worker', name: 'Worker' });
    await fresh.activatePlugins();
    await fresh.studio.dispatch({ petId: 'worker', request: 'work', scope: { namespace: 'channel', id: 'one' } });
    assert.deepEqual(received[0]?.systemPromptSections, [{ id: 'channel:test', content: 'second' }]);
  } finally {
    await fresh.studio.shutdown();
  }
});

test('a declared context namespace fails closed until its provider is active', async () => {
  let received = 0;
  const dispatch: PetDispatchPort = {
    getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    onQueueChange: () => () => undefined,
    onDispatchLifecycle: () => () => undefined,
    dispatch: async () => { received++; },
  };
  const prepared = prepareStudio({
    studioId: 'not-yet-active',
    definitions: [{ definitionId: 'worker', name: 'Worker' }],
    assemblePet: async () => ({ dispatch, close: async () => undefined }),
    plugins: [{ name: 'channel', contextNamespaces: ['channel'], toolkits: [], start(context) {
      context.registerContextProvider('channel', () => []);
    } }],
  });
  try {
    await prepared.restorePets();
    await prepared.studio.pets.create({ petId: 'worker', definitionId: 'worker', name: 'Worker' });
    const request = { petId: 'worker', request: 'work', scope: { namespace: 'channel', id: 'one' } };
    await assert.rejects(prepared.studio.dispatch(request), /provider.*unavailable/i);
    assert.equal(received, 0);
    await prepared.activatePlugins();
    await prepared.studio.dispatch(request);
    assert.equal(received, 1);
  } finally {
    await prepared.studio.shutdown();
  }
});

test('activation rejects a Plugin that omits its declared provider', async () => {
  let stopped = 0;
  const prepared = prepareStudio({
    studioId: 'missing-provider',
    definitions: [],
    assemblePet: async () => { throw new Error('unused'); },
    plugins: [{ name: 'channel', contextNamespaces: ['channel'], toolkits: [], start() {}, stop() { stopped++; } }],
  });
  await assert.rejects(prepared.activatePlugins(), /did not register context provider/i);
  assert.equal(stopped, 1);
  await prepared.studio.shutdown();
});

for (const action of ['unregister', 'shutdown'] as const) {
  test(`a pending provider cannot dispatch after ${action}`, async () => {
    let release!: () => void;
    let markStarted!: () => void;
    let remove!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let received = 0;
    const dispatch: PetDispatchPort = {
      getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
      onQueueChange: () => () => undefined,
      onDispatchLifecycle: () => () => undefined,
      dispatch: async () => { received++; },
    };
    const prepared = prepareStudio({
      studioId: `provider-${action}`,
      definitions: [{ definitionId: 'worker', name: 'Worker' }],
      assemblePet: async () => ({ dispatch, close: async () => undefined }),
      plugins: [{ name: 'channel', contextNamespaces: ['channel'], toolkits: [], start(context) {
        remove = context.registerContextProvider('channel', async () => {
          markStarted();
          await wait;
          return [{ id: 'channel:test', content: 'original' }];
        });
      } }],
    });
    try {
      await prepared.restorePets();
      await prepared.studio.pets.create({ petId: 'worker', definitionId: 'worker', name: 'Worker' });
      await prepared.activatePlugins();
      const pending = prepared.studio.dispatch({ petId: 'worker', request: 'work', scope: { namespace: 'channel', id: 'one' } });
      await started;
      if (action === 'shutdown') await prepared.studio.shutdown();
      else remove();
      release();
      await assert.rejects(pending, /shut down|unavailable/i);
      assert.equal(received, 0);
    } finally {
      release();
      await prepared.studio.shutdown();
    }
  });
}
